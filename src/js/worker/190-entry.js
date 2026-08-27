// =============================================================
// AppAgent SW runtime — entry point.
//
// This file is the LAST entry in sw-bundle.js. By the time it
// executes, everything else has been declared: globals, Platform
// stub, page stubs, the entire shared agent bundle (loop, streaming,
// tools, IDB, etc.), bus/broadcast bridge, checkpoint, tool routing,
// and the port handler. Now we do the actual boot:
//
//   1. Open IDB + load chats / api providers / session token.
//   2. Scan the agent_runs store for any chats whose status is
//      'running' (i.e. dropped mid-run by a previous SW kill) and
//      resume them.
//
// All async work below is fire-and-forget — bundle load is sync, the
// SW is now reachable via chrome.runtime.onConnect for 'agent-bus'
// (registered in 130-port-bridge.js, already executed before this
// file).
// =============================================================

// Exposed on `self` so resumeRunningCheckpoints (called from both this
// file AND background.js's onStartup / heartbeat-alarm path) can await
// it before touching `chats`. Without this, the background.js path
// races loadChatsFromStorage and runs runAgent with an empty `chats`
// global — `chats[streamingChatId]` is undefined and the loop crashes.
var _swBootReadyResolve = null;
self._swBootReady = new Promise(function(resolve) { _swBootReadyResolve = resolve; });

(function bootSwRuntime() {
    // Per-loader .catch so a transient IDB hiccup in any single loader
    // doesn't block the resume scan. We want resume to be best-effort:
    // a missing provider list, missing skills, etc. degrades gracefully,
    // but a stuck SW with running checkpoints sitting in IDB is far worse
    // than running with partial state for a few seconds.
    // BOOT-DEADLINE (SLEEP-WEDGE): .catch only covers loaders that REJECT.
    // After a suspend-wedged IDB backend, a loader can instead hang forever
    // (request callbacks never fire) — then the Promise.all below never
    // settles, _swBootReady never resolves, and every resume path awaiting it
    // wedges until Chrome restarts. Race each loader against a deadline so
    // boot ALWAYS completes, degraded if necessary. (The open watchdog and
    // transaction deadline in core/130-indexeddb.js bound each layer too —
    // this is the last-resort gate for the whole loader.)
    var SW_LOADER_DEADLINE_MS = 20000;
    var SW_LOADER_TIMEOUT = { _swLoaderTimeout: true };
    function safe(p, label) {
        var deadline = new Promise(function(resolve) {
            setTimeout(function() { resolve(SW_LOADER_TIMEOUT); }, SW_LOADER_DEADLINE_MS);
        });
        return Promise.race([Promise.resolve(p), deadline]).then(function(v) {
            if (v === SW_LOADER_TIMEOUT) {
                console.error('[sw-runtime] loader timed out after ' + SW_LOADER_DEADLINE_MS + 'ms: ' + label + ' — continuing boot degraded');
                return null;
            }
            return v;
        }).catch(function(e) {
            console.error('[sw-runtime] loader failed: ' + label, e);
            return null;
        });
    }
    // Skill DEFINITIONS (the `skills` global) must be hydrated in the SW too —
    // getSkillsSummaryForPrompt does Object.values(skills) to build the ACTIVE
    // SKILLS block. The page boot (120-init.js) loads these; without this the
    // SW-built system prompt has an empty skills list even though activeSkills
    // is populated, so active skills never reach the model.
    var loadSkillDefs = (typeof loadSkillsFromStorage === 'function') ? loadSkillsFromStorage() : Promise.resolve();
    var loadActive = (typeof loadActiveSkills === 'function') ? loadActiveSkills() : Promise.resolve();
    var loadCustom = (typeof loadCustomSystemPrompt === 'function') ? loadCustomSystemPrompt() : Promise.resolve();
    var loadHooks = (typeof loadHooksSettings === 'function') ? loadHooksSettings() : Promise.resolve();
    var loadPerms = (typeof loadToolPermissionsInWorker === 'function') ? loadToolPermissionsInWorker() : Promise.resolve();
    // Assumed-context-window setting (core/030-config.js). The SW agent loop's
    // appendContextNotice and the registry's saturation gauges read it via
    // getAssumedContextTokens; without hydration the SW would always use the
    // 200k default even after the user changed the setting.
    var loadCtxWindow = (typeof loadAssumedContextTokens === 'function') ? loadAssumedContextTokens() : Promise.resolve();
    // Smart documents tool runs in SW (HEADLESS_TOOLS.document = true), but its
    // in-memory smartDocuments cache is only hydrated by loadAllDocuments. The
    // page calls this from 120-init.js; the SW must do the same or the tool's
    // list/read/update/edit/delete actions all see an empty store and fail.
    var loadDocs = (typeof loadAllDocuments === 'function') ? loadAllDocuments() : Promise.resolve();
    // Sub-agent registry hydration. The SW is the AUTHORITATIVE sub-agent
    // context (every sub loop runs here), but only the page boot
    // (120-init.js) ever called SubAgents.loadAll — so after an MV3 SW
    // restart the SW registry was empty: agent_status returned "unknown
    // agent_id", spawn handles were gone (await_handle → "unknown handle"),
    // and the hello envelope full-replace-WIPED the page's correctly
    // IDB-loaded mirror. loadAll in the worker ctx also runs the orphan-
    // rewrite (errors pre-restart 'running' records) and rehydrates each
    // record's spawn handle under its persisted id (see
    // _rehydrateSpawnHandle in src/js/core/097-sub-agent-registry.js).
    var loadSubs = (typeof SubAgents !== 'undefined' && SubAgents.loadAll) ? SubAgents.loadAll() : Promise.resolve();
    // FLUX-4/3 (late-hydration resync): keep a handle on the REAL chats
    // loader promise. safe() races it against the 20s deadline — when the
    // deadline wins, _swBootReady resolves with _chatsHydrated still false
    // and any panel connected in that window received an adopts-only
    // chat-meta snapshot (worker/130-port-bridge.js _registerPanel). The
    // one-shot .then armed after the gate below fires when the getAll
    // finally lands and pushes a fresh snapshot to connected panels.
    var _chatsLoadP = loadChatsFromStorage();
    Promise.all([
        safe(_chatsLoadP, 'chats'),
        safe(loadApiProviders(), 'apiProviders'),
        safe(loadSkillDefs, 'skills'),
        safe(loadActive, 'activeSkills'),
        safe(loadCustom, 'customSystemPrompt'),
        safe(loadHooks, 'hooksEnabled'),
        safe(loadPerms, 'toolPermissions'),
        safe(loadCtxWindow, 'assumedContextTokens'),
        safe(loadDocs, 'smartDocuments'),
        safe(loadSubs, 'subAgents'),
        safe(Platform.ready, 'platform')
    ]).then(function() {
        // Signal that `chats` and providers are populated. Any concurrent
        // resume from background.js was waiting on this.
        if (_swBootReadyResolve) { _swBootReadyResolve(); _swBootReadyResolve = null; }
        // FLUX-4/3: boot gate resolved while the chats getAll is still in
        // flight (deadline path) — arm a ONE-SHOT resync for when it lands.
        // loadChatsFromStorage never rejects (own try/catch) and leaves
        // _chatsHydrated false on failure, so the guard inside the .then
        // makes a failed / never-landing load a no-op (no storm, no retry).
        if (typeof _chatsHydrated !== 'undefined' && !_chatsHydrated) {
            console.warn('[sw-runtime] boot gate resolved before chats hydration — arming late-hydration resync');
            Promise.resolve(_chatsLoadP).then(function() {
                if (typeof _chatsHydrated !== 'undefined' && _chatsHydrated
                    && typeof self._swLateHydrationResync === 'function') {
                    self._swLateHydrationResync();
                }
            }).catch(function() {});
        }
        // Boot sweep: reap finished/stale agent_runs checkpoints so the
        // store self-heals from pre-delete-on-finish bloat (each record
        // carries a full messagesSnapshot). Fire-and-forget, non-fatal;
        // live ('running'/'parked') records are never touched, so this
        // cannot race the resume scan below.
        try {
            if (typeof sweepFinishedAgentCheckpoints === 'function') {
                sweepFinishedAgentCheckpoints().then(function(n) {
                    if (n > 0) console.log('[sw-runtime] swept ' + n + ' finished/stale agent_runs checkpoint(s)');
                }).catch(function(e) {
                    console.warn('[sw-runtime] agent_runs sweep failed', e);
                });
            }
        } catch (eSweep) {
            console.warn('[sw-runtime] agent_runs sweep failed', eSweep);
        }
        // PAYLOAD-STORE GC: reap chat_payloads blobs no chat references any
        // more (deleted chats, truncated transcripts). Runs here because the
        // SW is the realm that hydrates ALL chats (the reference set must be
        // complete); internally gated on _chatsHydrated and a 24h age floor,
        // so a failed/partial chats load can never mass-delete live payloads.
        // Fire-and-forget, non-fatal.
        try {
            if (typeof sweepOrphanChatPayloads === 'function') {
                sweepOrphanChatPayloads().then(function(n) {
                    if (n > 0) console.log('[sw-runtime] swept ' + n + ' orphaned chat payload blob(s)');
                }).catch(function(e) {
                    console.warn('[sw-runtime] chat_payloads sweep failed', e);
                });
            }
        } catch (eSweep2) {
            console.warn('[sw-runtime] chat_payloads sweep failed', eSweep2);
        }
        // EMPTY-ROW GC (RFC addendum §2.5.2, PR 3): reap 0-message chat rows
        // older than 24h via the explicit 'empty-row' delete signal
        // (deleteChatRow, core/130-indexeddb.js). Before PR 3 the save's
        // absence-diff reaped them implicitly at the first save; saves are
        // upsert-only now, so this boot pass is the only reaper. Expect a
        // one-off count drop at the first boot after PR 3 (RFC addendum §5).
        // Fire-and-forget, non-fatal; capped at 200/boot inside.
        try {
            if (typeof gcEmptyChatRows === 'function') {
                gcEmptyChatRows().then(function(n) {
                    if (n > 0) console.log('[sw-runtime] empty-row GC reaped ' + n + ' empty chat row(s)');
                }).catch(function(e) {
                    console.warn('[sw-runtime] empty-row GC failed', e);
                });
            }
        } catch (eSweep3) {
            console.warn('[sw-runtime] empty-row GC failed', eSweep3);
        }
        return listRunningAgentCheckpoints();
    }).then(function(checkpoints) {
        if (!checkpoints || checkpoints.length === 0) {
            // ZR1-R1 (follow-up): an empty list can still follow boot decisions
            // that claimed pool slots — listRunningAgentCheckpoints resolves
            // PARTIAL output on cursor errors, so the per-record reads in
            // _resumeOrOrphanSubAtBoot may have seen live checkpoints the list
            // then dropped. Orphan any claimed, never-resumed sub before
            // settling (no-op on the normal empty-boot path: nothing claimed).
            if (typeof self._orphanUnresumedSubs === 'function') {
                try { self._orphanUnresumedSubs('resume aborted: checkpoint list empty at boot'); } catch (e2) {}
            }
            // REG-AUDIT-2: no interrupted runs — the resume scan is decided;
            // settle so panels stop extending the hello-grace window.
            if (typeof self._settleResumeScan === 'function') self._settleResumeScan();
            return;
        }
        console.log('[sw-runtime] resuming ' + checkpoints.length + ' interrupted run(s)');
        // 130-port-bridge.js exposes resumeRunningCheckpoints on self;
        // call it so the bookkeeping (parked-tool restore) is identical
        // to the alarm-driven resume path.
        if (typeof resumeRunningCheckpoints === 'function') {
            resumeRunningCheckpoints(checkpoints);
        } else {
            // ZR1-R1 (follow-up): no resume entry point means nothing will
            // re-arm these runs — boot-claimed sub slots would leak for the
            // whole SW session. Orphan them before settling.
            if (typeof self._orphanUnresumedSubs === 'function') {
                try { self._orphanUnresumedSubs('resume aborted: resume entry point unavailable at boot'); } catch (e2) {}
            }
            // REG-AUDIT-2: resume entry point missing — nothing will re-arm
            // these runs; settle rather than leave panels waiting.
            if (typeof self._settleResumeScan === 'function') self._settleResumeScan();
        }
    }).catch(function(e) {
        console.error('[sw-runtime] boot/resume error', e);
        // Failsafe: still open the boot gate so background.js's alarm
        // path can attempt resume even after a partial loader failure.
        if (_swBootReadyResolve) { _swBootReadyResolve(); _swBootReadyResolve = null; }
        // ZR1-R1 (follow-up): this catch also fires when
        // listRunningAgentCheckpoints rejects AFTER loadAllSubAgents already
        // claimed pool slots for checkpoint-resumable subs — without the
        // sweep those records stay fake-'running' (claimed slot, pending
        // rehydrated handle) for the whole SW session. Same registry-side
        // sweep as resumeRunningCheckpoints' gate-chain catch.
        if (typeof self._orphanUnresumedSubs === 'function') {
            try { self._orphanUnresumedSubs('resume aborted: boot/resume scan failed: ' + (e && e.message || e)); } catch (e3) {}
        }
        // REG-AUDIT-2: a failed boot scan is also a decided scan.
        if (typeof self._settleResumeScan === 'function') { try { self._settleResumeScan(); } catch (e2) {} }
    });
})();
