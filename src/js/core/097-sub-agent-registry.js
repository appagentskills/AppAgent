// =============================================================
// Sub-Agent Registry — Phase 2 of the Sub-Agent Architecture spec.
//
// A sub-agent is a background chat (chat.isSubAgent = true) running its own
// agent loop in service of a parent chat. The parent spawns it with
// `spawn_sub_agent`, gets a handle back, and either awaits the result
// (`await_handle`) or fires-and-forgets. The sub does its work in isolation
// (its own context window) and pushes a distilled summary back via
// `report_to_parent`, which resolves the spawn handle.
//
// What lives in this file:
//   • SubAgents.spawn / get / list / stop / sleep / wake / message
//   • report_to_parent dispatch (sub → parent inbox + handle resolution)
//   • Worker pool — a shared 2-slot scheduler that caps concurrent sub
//     `runAgent` invocations. Excess spawns are queued.
//   • Inbox semantics — pending messages drain into the sub's next user
//     turn when it wakes.
//   • IndexedDB persistence — every state mutation re-puts the record so
//     crash/reload recovery is possible.
//
// What lives elsewhere:
//   • The 7 sub-agent tool definitions: src/js/core/080-tools.js
//   • Tool dispatch arms (server-side): src/js/tools/020-tool-execution.js
//   • System-prompt preamble appending: src/js/core/110-system-prompt.js
//     (preamble lives here as SUB_AGENT_PREAMBLE; the prompt module reads it.)
//   • Spawn-handle settlement on natural runAgent end: src/js/app/030-agent-loop.js
//   • Sidebar breadcrumb / Workers strip: src/js/ui/170-chat-management.js
//
// Pool behavior:
//   • Pool size = 2 concurrent running sub-agents (SUBAGENT_POOL_SIZE).
//     Conservatively low: Anthropic enforces an account-level concurrent-
//     request cap above us, and 4 parallel sub loops reliably trips 429 on
//     fresh tiers. Two is the empirical safe default.
//   • spawn_sub_agent always creates the record + chat immediately. If
//     there is a free slot, it kicks runAgent(chatId) now; otherwise the
//     sub stays in `running` state but its loop has not been started — it
//     is in the pool's pending queue, waiting for a slot.
//   • When a slot frees (sub goes sleeping/stopped/errored), the next
//     queued sub's runAgent fires.
//   • The pool is shared across all parent chats (round-robin parent
//     selection) so one chatty parent can't monopolize.
//
// Inbox semantics:
//   • Messages sent to a *running* sub are appended to chat.messages as a
//     synthetic user message immediately — the live runAgent loop picks
//     them up on its next turn.
//   • Messages sent to a *sleeping* sub queue in `inbox` and are drained
//     into a single combined user message on wake.
//   • Reports sent to a parent are NOT queued — they land directly in the
//     parent chat's messages as a `sub_report` row (a new message role,
//     rendered as a styled callout). Parent reads them as transcript
//     history; the spawn handle carries the structured payload.
// =============================================================

// ---------- Constants ----------

var SUBAGENT_POOL_SIZE          = 2;
var SUBAGENT_DEFAULT_MAX_TOOLS  = 300;
// Soft-cap warning threshold: once a sub has used this fraction of its
// tool budget, every subsequent tool result carries a budget warning so
// the model wraps up and reports instead of being hard-killed mid-task.
var SUBAGENT_BUDGET_WARN_RATIO  = 0.9;
// Absolute force-stop ceiling, as a multiple of max_tool_calls. The band
// between the cap and the ceiling is soft (escalating warnings only), but
// a runaway sub that ignores every warning must not hold a pool slot and
// burn tokens forever — past cap*MULT the old hard termination path runs
// (cascade-stop, error-settle the spawn handle, pause, release the slot).
var SUBAGENT_BUDGET_HARD_MULT   = 2;
var SUBAGENT_DEFAULT_SUMMARY_KB = 4;
var SUBAGENT_MAX_ARTIFACTS      = 32;
// Soft cap on the inbox queue (sleeping sub). Older messages are dropped
// with a synthetic marker so a noisy parent/sibling can't grow the inbox
// without bound (every push persists to IDB).
var SUBAGENT_INBOX_CAP          = 50;
// Sweep frequency for the tombstone-GC pass (stopped/errored subs are
// kept SUBAGENT_TOMBSTONE_TTL_MS so the UI can show last_report, then
// deleted).
var SUBAGENT_IDLE_SWEEP_MS      = 60 * 1000;        // sweep frequency
// Settled-sub records GC: stopped/errored subs are kept around for this
// long so the UI can show "last_report" and the user can inspect the
// chat. After the grace period the record is deleted from IDB.
var SUBAGENT_TOMBSTONE_TTL_MS   = 60 * 60 * 1000; // 1h
// Sleeping (parked) subs that reported a result and were never woken again are
// abandoned: every sub that completes parks as state='sleeping' (so the parent
// CAN re-wake it), but the tombstone sweep above only reclaims stopped/errored
// records — so without an idle window the happy-path 'done' sub leaks its record
// + background chat row forever. Reclaim sleeping subs idle longer than this.
// Re-waking resets last_activity_at, so an actively-managed sub is never hit.
var SUBAGENT_SLEEP_TTL_MS       = 60 * 60 * 1000; // 1h idle

// Default-denied nested-delegation tools. Sub-agents cannot spawn /
// stop / wake other subs unless the caller passes `allow_nested:true`
// at spawn time. Spec §8.4 "fork-bomb prevention" + Phase 5 ACL hardening.
var SUBAGENT_NESTED_DELEGATION_TOOLS = ['spawn_sub_agent', 'stop_sub_agent', 'wake_sub_agent'];
// Maximum allowed nesting depth. Hard ceiling on tree depth, independent of
// per-sub `max_tool_calls` budgets. Default 5 levels (root → 5 descendants).
var SUBAGENT_MAX_DEPTH = 5;

// ---------- Sub-agent preamble (appended to parent system prompt) ----------
// Used by src/js/core/110-system-prompt.js when the active chat is a sub-agent.
// Keep this short — every sub spends tokens on it.
var SUB_AGENT_PREAMBLE = [
    '',
    '------',
    '',
    'YOU ARE A SUB-AGENT.',
    '',
    'You were spawned by a parent agent to do focused, context-heavy work without polluting the parent\'s context window. Your task is in the first user message.',
    '',
    'CRITICAL RULES for sub-agents:',
    '  • DO NOT echo raw tool outputs back to the parent. Summarize.',
    '  • When the work is complete, call `report_to_parent` with a concise distilled result (≤ 4 KB summary). This is what the parent sees — it never reads your transcript. Write the summary in markdown — it is rendered as markdown to the user in the parent chat.',
    '  • If you need parent input mid-task, call `report_to_parent({status:"need_input", ...})`. That settles the parent\'s handle and parks you — the parent will wake you with new instructions.',
    '  • If you are idle and waiting, call `sleep_self` to free the worker pool slot.',
    '  • Use `artifacts: [doc_id, file_id, ...]` in your report for larger payloads — never inline a long list/dump into `summary`.',
    '  • SCRATCHPAD: stage a long result in a smart doc (`document` tool) and return its doc_id in `artifacts` instead of inlining it — `shared` scope lets the parent read it, `chat` keeps it private to you.',
    '  • Maintain a progress card with `update_action_state` (state + `tasks` todo list) — it is mirrored LIVE onto your card in the parent chat and exposed to the parent via `agent_status`, so the parent can watch your progress without reading your transcript.',
    '  • Do NOT spawn nested sub-agents unless explicitly authorized — `spawn_sub_agent`, `stop_sub_agent`, and `wake_sub_agent` are denied by default. The parent must pass `allow_nested:true` at spawn time to grant nested delegation.',
    '  • You may only `stop`/`wake`/`message` sub-agents that are your own descendants (the ACL is enforced server-side; calls against siblings or ancestors fail).',
    '',
    'The parent agent is awaiting your `report_to_parent` call to unblock its own work. Be focused, be brief, and return early with `status:done` once the task is genuinely complete.'
].join('\n');

// ---------- Module state ----------

// In-memory mirror of the IDB store. Keyed by agent_id. Single source of
// truth during a session; persisted to IDB on every mutation.
var _subAgents = Object.create(null);

// SAGF-1: the chat id the user is currently viewing, threaded page→SW via a
// `focus-chat` envelope (SubAgents.setFocusedChat). In the SW `currentChatId`
// is permanently null, so the GC paths consult THIS instead to avoid deleting
// a tombstone / abandoned-sleep transcript the user is actively reading.
var _focusedChatId = null;
// SWM2-F2: focus keyed by panel/port. Multiple panels can each view a different
// chat; a single scalar is last-writer-wins, so a 2nd panel's focus would clobber
// the 1st's and the 1st's viewed transcript would be GC'd. Track per-port focus so
// the GC guards skip a chat focused by ANY live panel. _focusedChatId remains the
// backward-compatible single/default focus (used when setFocusedChat is called
// without a portKey) so single-panel behavior is unchanged.
var _focusedChatByPort = Object.create(null);
var _focusSignalReceived = false; // SWM2-T2: true once ANY focus-chat (set OR clear) arrives from a live panel — distinguishes boot/restart-unknown (defer GC) from deliberately-cleared focus on a non-chat view (GC may run). Resets on SW restart (module re-eval).
// SWM2-F1(A): true when ANY focus signal is known (default scalar set, or some port
// reported a focused chat). When NOTHING is known — at SW boot / right after a
// restart, before the page re-posts focus-chat — the GC paths DEFER rather than risk
// reclaiming the transcript the user is actually viewing (the SW's currentChatId is
// permanently null, so it is no signal). Mirrors loadAllSubAgents' B7 deferral.
function _isFocusEstablished() {
    if (_focusedChatId) return true;
    for (var _pk in _focusedChatByPort) { if (_focusedChatByPort[_pk]) return true; }
    return _focusSignalReceived; // SWM2-T2: once a panel has reported focus (even a clear), trust it instead of forever deferring GC
}
// SWM2-F2: true when chatId is the focused chat of the default scalar OR of any live
// panel. The GC guards use this so no panel's viewed transcript is reclaimed.
function _isChatFocusedByAnyPanel(chatId) {
    if (!chatId) return false;
    if (_focusedChatId && _focusedChatId === chatId) return true;
    for (var _pk2 in _focusedChatByPort) { if (_focusedChatByPort[_pk2] === chatId) return true; }
    return false;
}
// F2: number of connected panels (i.e. live transcript viewers). The SW port
// bridge (src/js/worker/130-port-bridge.js) tracks every connected panel port in
// the shared-scope global _swPanelPorts (a Set); other worker-bundle files such as
// src/js/worker/120-tool-routing.js already reference it the same bare, typeof-
// guarded way, confirming it is reachable from here at runtime in the SW bundle.
// Returns -1 when NOT reachable (e.g. the page bundle, where the GC paths are
// gated off anyway) so callers fall back to the pre-F2 focus-only behavior.
// Why this matters: #309's clearFocusedChatForPort latch reset makes
// _isFocusEstablished() return false once the last panel disconnects, which froze
// ALL tombstone / abandoned-sleep GC during headless background runs (panel
// closed). GC is in fact SAFE when zero panels are connected — no transcript is
// being viewed — so the gates below only DEFER when a panel IS connected but its
// focus is still unknown (a transient reconnect gap).
function _connectedPanelCount() {
    try {
        if (typeof _swPanelPorts !== 'undefined' && _swPanelPorts && typeof _swPanelPorts.size === 'number') {
            return _swPanelPorts.size;
        }
    } catch (e) { /* not reachable from this bundle */ }
    return -1;
}

// Worker pool: { running: Set<agent_id>, queue: agent_id[] }. running tracks
// which subs currently have an active runAgent loop. queue holds subs whose
// records were created but who haven't been started yet because the pool was
// full at spawn time.
var _subPool = { running: Object.create(null), queue: [] };

// Listeners notified on any sub-agent state change. UI components register
// here to re-render the Workers strip / sidebar breadcrumb.
var _subAgentListeners = [];

// True once loadAllSubAgents has successfully drained the IDB store into
// the in-memory map. SYMPTOM this fixes: an MV3 SW restart re-evaluates the
// bundle with an EMPTY `_subAgents`; the port bridge's hello envelope then
// shipped `SubAgents.listAll()` (= []) as the "authoritative" snapshot and
// the page's full-replace applySubAgentSnapshot WIPED its own correctly
// IDB-loaded mirror. The bridge (src/js/worker/130-port-bridge.js) now
// consults SubAgents.isLoaded() and sends null until hydration completes.
var _subAgentsLoaded = false;

// ---------- Persistence ----------

function _subAgentsPersist(record) {
    if (typeof openDatabase !== 'function') return Promise.resolve();
    return openDatabase().then(function(database) {
        try {
            var tx = database.transaction(['sub_agents'], 'readwrite');
            tx.objectStore('sub_agents').put(record);
        } catch (e) { /* non-fatal */ }
    }).catch(function() { /* non-fatal */ });
}

function _subAgentsDeleteFromDB(agentId) {
    if (typeof openDatabase !== 'function') return Promise.resolve();
    return openDatabase().then(function(database) {
        try {
            var tx = database.transaction(['sub_agents'], 'readwrite');
            tx.objectStore('sub_agents').delete(agentId);
        } catch (e) { /* non-fatal */ }
    }).catch(function() { /* non-fatal */ });
}

async function loadAllSubAgents() {
    // Called at boot from src/js/core/120-init.js. Drains the IDB store
    // into the in-memory map AND restarts the pool for any sub that was
    // `running` at crash time.
    if (typeof openDatabase !== 'function') return;
    try {
        var database = await openDatabase();
        var tx = database.transaction(['sub_agents'], 'readonly');
        var req = tx.objectStore('sub_agents').getAll();
        await new Promise(function(resolve) {
            req.onsuccess = function() {
                var list = req.result || [];
                var now = Date.now();
                list.forEach(function(rec) {
                    // GC tombstoned records past TTL.
                    if ((rec.state === 'stopped' || rec.state === 'errored')
                        && rec.settled_at && (now - rec.settled_at) > SUBAGENT_TOMBSTONE_TTL_MS) {
                        // Only the authoritative (SW/headless) context may reclaim
                        // tombstones from IDB. The page bundle ALSO runs
                        // loadAllSubAgents() at boot; letting it delete the sub_agents
                        // record + background chat row races the SW's own persistence —
                        // the exact bug the runtime _idleSweepTick gating fixed but never
                        // applied here. The page just skips mirroring the expired
                        // tombstone (the SW GCs it and rebroadcasts the snapshot).
                        if (typeof Platform !== 'undefined' && Platform.isWorker !== true) return;
                        // SAGF-1: never GC a tombstone whose transcript the user is
                        // actively viewing. In the SW currentChatId is always null, so
                        // consult the page→SW-threaded _focusedChatId instead; defer
                        // reclamation to a later sweep once the user navigates away.
                        // SAGF-1 + B7: never GC a tombstone whose transcript the user
                        // is actively viewing. In the SW currentChatId is always null,
                        // so consult the page→SW-threaded _focusedChatId. At SW BOOT it
                        // may not be threaded yet (the page's focus-chat races this
                        // synchronous load), so only reclaim when focus is KNOWN and
                        // points at a DIFFERENT chat. When focus is unknown (null) or
                        // matches this record, do NOT delete — fall through to load the
                        // record so a later _idleSweepTick (after focus is established)
                        // reclaims it. Early-returning here instead would skip the load
                        // below, hide the tombstone from the sweep, and leak the IDB
                        // record + chat row forever.
                        // SWM2-F2: reclaim only when focus is ESTABLISHED and no live
                        // panel is viewing THIS record's transcript. (Pre-F2 this was a
                        // single-scalar check; the port-keyed map generalises it so a
                        // 2nd panel's focus can't be clobbered.) When focus is unknown
                        // (boot race) it falls through to load the record and defer to
                        // a later _idleSweepTick — same B7 deferral as before.
                        // F2: GC is also SAFE when ZERO panels are connected (no
                        // transcript is being viewed), even if focus is "unknown" —
                        // #309's latch reset on the last disconnect made focus look
                        // unknown forever during headless runs and froze this boot GC.
                        // Allow GC when (no panel connected) OR (focus established);
                        // _connectedPanelCount() returns -1 when unreachable, so the
                        // === 0 branch is false there and behavior matches pre-F2.
                        if ((_connectedPanelCount() === 0 || _isFocusEstablished()) && !_isChatFocusedByAnyPanel(rec.chat_id)) {
                            // Permanent-spinner guard: if the parent card is
                            // somehow still non-terminal, finalize it BEFORE the
                            // record vanishes — after GC the UI can no longer
                            // resolve a live state and would spin forever.
                            _finalizeSubAgentCard(rec, rec.last_report || { status: 'error', summary: '(sub-agent record expired before completing)', from: rec.agent_id, from_name: rec.name, at: now });
                            _subAgentsDeleteFromDB(rec.agent_id);
                            // Also reclaim the sub's background chat row, mirroring the
                            // idle sweep's cleanup (best-effort, guarded).
                            try {
                                if (typeof chats !== 'undefined' && rec.chat_id && chats[rec.chat_id]) {
                                    delete chats[rec.chat_id];
                                    // Persist the deletion via a full save — saveChatsToStorage
                                    // does a clear+rewrite of the chats store, so the removed
                                    // row actually leaves IDB. (deleteChatFromDB never existed.)
                                    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
                                }
                            } catch (e) { /* non-fatal */ }
                            return;
                        }
                        // else: focus unknown (boot race) or user is viewing this
                        // transcript — defer reclamation to the idle sweep.
                    }
                    // Backfill Phase-5 fields for records persisted before this
                    // upgrade. A legacy record has no `depth` / `root_chat_id`.
                    // Conservatively assume depth=1 (top-level) and root = parent
                    // chat — there were no nested subs in pre-Phase-5 builds, so
                    // this is correct for every legacy record.
                    if (rec.depth == null)         rec.depth = 1;
                    if (rec.root_chat_id == null)  rec.root_chat_id = rec.parent_chat_id;
                    // PR383-R2: _pending_approvals is persisted verbatim, but
                    // its only decrements are the live approval callbacks in
                    // worker/120-tool-routing.js. A SW kill mid-approval
                    // strands the counter >= 1 forever, permanently muting
                    // onSubApprovalEvent's `=== 1` park-notice gate. No
                    // approval modal survives a reboot — zero it at load.
                    rec._pending_approvals = 0;
                    // PR383-R5: a persisted retry-delay stamp can't survive a
                    // reboot either (its setTimeout died with the SW) — clear.
                    delete rec._retry_delayed_until;
                    _subAgents[rec.agent_id] = rec;
                });
                resolve();
            };
            req.onerror = function() { resolve(); };
        });
        // Pre-offscreen architecture: any sub with state:'running' at reload was
        // orphaned because the handle map was in-memory and wiped. We marked them
        // errored so the parent's await_handle didn't hang on a vanished handle.
        //
        // Offscreen-host architecture (current): the agent loop runs in the SW
        // (sw-bundle.js, imported by background.js), which survives page reload.
        // Subs marked 'running' in IDB really ARE still running there, and their
        // spawn handles are still pending. The PAGE bundle running loadAll() must
        // NOT rewrite them — that lies about sub state in the workers strip and
        // races IDB writes with the SW's own persistence. Only the worker-runtime
        // copy of loadAll() is authorized to perform the orphan-rewrite (and only
        // on a true cold start, which it can detect via its own pool state).
        //
        // Gate: Platform.isWorker is set to true exclusively in
        // src/js/worker/000-runtime-globals.js (the first file of sw-bundle.js)
        // and is never defined in the page bundle. Same flag used by
        // 010-llm-streaming.js / 020-tool-execution.js / 140-skills-engine.js.
        var _isWorkerCtx = (typeof Platform !== 'undefined' && Platform.isWorker === true);
        if (_isWorkerCtx) {
            var _bootDecisions = [];
            for (var aid in _subAgents) {
                var r = _subAgents[aid];
                // Liveness guard: loadAll runs ASYNC at SW boot, so a sub spawned
                // in THIS session (panel reconnected fast, parent spawned before
                // the IDB drain finished) is also state:'running' in the freshly
                // read records — but it has a live spawn deferred / pool presence
                // and must NOT be rewritten as orphaned.
                var _isLiveThisSession = !!(_spawnDeferreds[r.spawn_handle_id]
                    || _subPool.running[aid] || _subPool.queue.indexOf(aid) >= 0);
                if (r.state === 'running' && !_isLiveThisSession) {
                    _bootDecisions.push(_resumeOrOrphanSubAtBoot(r));
                }
            }
            // ZR-1: the resume-or-orphan decisions are async (they consult
            // the agent_runs checkpoint store) but MUST settle before the
            // handle rehydration below (_rehydrateSpawnHandle branches on
            // rec.state: 'running' → pending handle, terminal → pre-settled)
            // and before loadAll's promise resolves — 190-entry.js fires
            // resumeRunningCheckpoints only after the boot Promise.all that
            // includes loadAll, so awaiting here preserves the strict
            // decide-before-resume ordering the port bridge relies on.
            await Promise.all(_bootDecisions);
        }
        // Handle rehydration (runs AFTER the resume-or-orphan decisions, so
        // every record is terminal/parked — pre-settled snapshot from
        // last_report — or live in THIS session (skipped by the
        // deferred/Handles guards inside _rehydrateSpawnHandle), or ZR-1
        // checkpoint-resumable ('running', pool slot claimed above): those
        // get a PENDING handle re-armed with a fresh deferred, settled by the
        // normal push paths once the resumed loop reports. SYMPTOM: handles are in-memory by
        // design (095-handle-registry.js), so after an MV3 SW restart the
        // parent's await_handle/poll_handle on a persisted spawn_handle_id
        // returned `unknown handle` and an already-produced report became
        // unreachable. spawn_handle_id + last_report ARE persisted — enough
        // to rebuild the handle under the SAME id. Gated to the
        // authoritative (SW/headless) context like the sweep above: the page
        // mirror must keep its _spawnDeferreds empty (see _idleSweepTick).
        if (_isWorkerCtx || typeof Platform === 'undefined') {
            for (var raid in _subAgents) {
                _rehydrateSpawnHandle(_subAgents[raid]);
            }
        }
        // Hydration succeeded — the hello snapshot gate may open (see
        // _subAgentsLoaded above), and panels connected during the drain
        // need a fresh snapshot broadcast (105-subagent-broadcast.js
        // listens on _notifyListeners).
        _subAgentsLoaded = true;
        _notifyListeners();
    } catch (e) { /* non-fatal — _subAgentsLoaded stays false, hello sends null */ }
    // Kick off the idle/tombstone sweeper now that the registry is loaded.
    _startIdleSweep();
}

// ZR-1: boot-time resume-or-orphan decision for a sub that was state
// 'running' when the SW died. PREVIOUS BEHAVIOR: unconditionally orphan-error
// the record — yet the sub's agent_runs checkpoint (written at every tool
// boundary by src/js/worker/110-agent-checkpoint.js, sub chats included) was
// still 'running', so the boot resume scan (resumeRunningCheckpoints,
// src/js/worker/130-port-bridge.js) restarted the loop anyway as a ZOMBIE:
// it burned tokens outside the _subPool cap and its eventual
// report_to_parent was rejected against the already-terminal record +
// pre-settled (errored) spawn handle. NEW BEHAVIOR: when a live
// ('running'/'parked') checkpoint exists, keep the record 'running' and
// claim a soft pool slot (mirrors resurrectSubAgent's over-cap-on-resume —
// by design) so the resume scan restarts the loop LEGITIMATELY:
// _rehydrateSpawnHandle then re-arms the parent's spawn handle as PENDING
// and the sub's eventual report settles it through the normal push paths.
// Only when no live checkpoint exists (sub was still QUEUED — never started,
// so runStarted never wrote one — or the checkpoint was already reaped) do we
// fall back to the orphan-error.
// readAgentCheckpoint is declared in the worker tier — present in the SW
// bundle (the only context that reaches this code; see the _isWorkerCtx
// gate at the call site) but guarded anyway for safety.
function _resumeOrOrphanSubAtBoot(rec) {
    var canRead = (typeof readAgentCheckpoint === 'function');
    var read = canRead
        ? Promise.resolve().then(function() { return readAgentCheckpoint(rec.chat_id); }).catch(function() { return null; })
        : Promise.resolve(null);
    return read.then(function(cp) {
        // NOTE: deliberately NO chats[rec.chat_id] check here — loadAll runs
        // inside the boot Promise.all CONCURRENTLY with loadChatsFromStorage,
        // so the chats map may not be hydrated yet and a presence check would
        // racily orphan a perfectly resumable sub. The chat-row check happens
        // in resumeRunningCheckpoints (130-port-bridge.js), which only runs
        // AFTER the whole boot Promise.all settles; its fallback for a
        // running record with a vanished chat row is SubAgents.markOrphaned.
        // ZR1-R2: rec.state was sampled in the loadAll loop BEFORE the async
        // checkpoint read. If a concurrent path settled the record during the
        // read (user stop via a fast panel reconnect, _markErrored), claiming
        // a slot now would leak it permanently (every release path already
        // ran) — and a record that went terminal must not be orphan-rewritten
        // either. A slot already claimed (e.g. a wake started the loop) means
        // the new owner manages it — stand down in both branches.
        if (rec.state !== 'running' || _subPool.running[rec.agent_id]) return;
        var resumable = !!(cp && (cp.status === 'running' || cp.status === 'parked'));
        if (resumable) {
            _subPool.running[rec.agent_id] = true; // soft over-cap on resume — by design
            rec.last_activity_at = Date.now();
            _subAgentsPersist(rec);
            return;
        }
        _orphanErrorSubAtBoot(rec);
    });
}

function _orphanErrorSubAtBoot(rec) {
    rec.state = 'errored';
    rec.settled_at = Date.now();
    rec.last_report = rec.last_report || {
        status: 'error',
        summary: 'sub-agent orphaned by offscreen restart before completion',
        from: rec.agent_id,
        from_name: rec.name,
        at: rec.settled_at,
        _orphaned: true
    };
    _subAgentsPersist(rec);
    // Also finalize the parent-chat card (if the chats map is
    // already hydrated) so the orphaned sub doesn't keep a
    // spinner alive forever in the parent transcript.
    _finalizeSubAgentCard(rec, rec.last_report);
}

// Rebuild the Handles-registry entry for a persisted sub-agent record after
// an MV3 SW restart wiped the in-memory handle map. See the loadAllSubAgents
// call site for the symptom. Mapping (mirrors _resolveSpawnHandle's live
// settlement semantics):
//   stopped                     → status 'cancelled' (stop_sub_agent settle)
//   errored / last_report error → status 'error' (error = headline summary,
//                                  result = full payload, like Handles.errorWith)
//   sleeping (done/need_input)  → status 'done', result = payload (the
//                                  report's own status field disambiguates)
//   running                     → PENDING entry re-armed with a fresh deferred;
//                                  settled later by the registry's normal push
//                                  paths (in the worker ctx the boot orphan-
//                                  rewrite has already errored true orphans
//                                  before this runs, so a still-'running'
//                                  record here belongs to a live loop).
function _rehydrateSpawnHandle(rec) {
    if (!rec || !rec.spawn_handle_id) return;
    if (typeof Handles === 'undefined' || !Handles.restore) return;
    // Live in this session — never clobber.
    if (_spawnDeferreds[rec.spawn_handle_id]) return;
    if (Handles.get && Handles.get(rec.parent_chat_id, rec.spawn_handle_id)) return;
    var displayName = 'spawn_sub_agent: ' + (rec.name || rec.agent_id) + ' (rehydrated)';
    if (rec.state === 'running') {
        var d = _makeDeferred();
        Handles.restore(rec.parent_chat_id, rec.spawn_handle_id, {
            name: 'spawn_sub_agent',
            displayName: displayName,
            args: rec.spawn_args || null,
            createdAt: rec.created_at,
            status: 'pending',
            runFn: function() { return d.promise; }
        });
        _spawnDeferreds[rec.spawn_handle_id] = d;
        return;
    }
    // Terminal / parked: pre-settle from last_report so the parent can still
    // collect an undelivered report (report_collected tracks delivery).
    var report = rec.last_report || {
        status: (rec.state === 'errored') ? 'error' : 'need_input',
        summary: '(no report was recorded before the service-worker restart)',
        from: rec.agent_id,
        from_name: rec.name,
        at: rec.settled_at || rec.last_activity_at || Date.now(),
        _synthesized: true
    };
    var payload = {
        status: report.status,
        summary: report.summary,
        data: (report.data != null) ? report.data : null,
        artifacts: report.artifacts || [],
        from: rec.agent_id,
        _rehydrated: true
    };
    var settledAt = rec.settled_at || report.at || Date.now();
    var opts;
    if (rec.state === 'stopped') {
        opts = { status: 'cancelled', error: report.summary || 'sub-agent stopped', result: payload };
    } else if (rec.state === 'errored' || report.status === 'error') {
        opts = { status: 'error', error: report.summary || 'sub-agent reported error', result: payload };
    } else {
        opts = { status: 'done', result: payload };
    }
    opts.name = 'spawn_sub_agent';
    opts.displayName = displayName;
    opts.args = rec.spawn_args || null;
    opts.createdAt = rec.created_at;
    opts.settledAt = settledAt;
    Handles.restore(rec.parent_chat_id, rec.spawn_handle_id, opts);
    // The handle is settled — keep pending_handles consistent with
    // _resolveSpawnHandle's pruning so agent_status doesn't report a
    // phantom pending handle on a settled sub after the restart.
    if (Array.isArray(rec.pending_handles)) {
        var _rpIdx = rec.pending_handles.indexOf(rec.spawn_handle_id);
        if (_rpIdx >= 0) { rec.pending_handles.splice(_rpIdx, 1); _subAgentsPersist(rec); }
    }
}

// ---------- Pool ----------

function _poolSlotsFree() {
    var n = 0;
    for (var _k in _subPool.running) n++;
    return SUBAGENT_POOL_SIZE - n;
}

function _drainPool() {
    // Pull subs off the queue until either the queue is empty or no slots
    // remain. Each started sub kicks runAgent on its chat. runAgent is
    // expected to be a globally-available function from the agent-loop
    // module — guard the call so this file can be loaded in a context
    // where runAgent hasn't been defined yet (e.g. early boot, tests).
    //
    // Iterate with an index (not shift()) so we can SKIP subs whose
    // runAgent loop is still in flight on the same chat (wake-during-finish
    // race) without losing them. Without this, _drainPool claims a pool
    // slot, calls runAgent, runAgent early-returns because runningChatIds
    // is set, and the slot is leaked until the OLD loop finally yields.
    var i = 0;
    while (i < _subPool.queue.length && _poolSlotsFree() > 0) {
        var aid = _subPool.queue[i];
        var rec = _subAgents[aid];
        if (!rec) { _subPool.queue.splice(i, 1); continue; }
        if (rec.state !== 'running') { _subPool.queue.splice(i, 1); continue; }
        // A previous runAgent for this chat is still wrapping up (e.g.
        // sleep_self just yielded but the loop hasn't reached its finish
        // hook yet). Leave the sub in the queue — when the old loop calls
        // onSubAgentRunFinished → _releasePoolSlot → _drainPool, we'll
        // retry.
        if (typeof runningChatIds !== 'undefined' && runningChatIds[rec.chat_id]) {
            i++;
            continue;
        }
        _subPool.queue.splice(i, 1);
        _subPool.running[aid] = true;
        try {
            if (typeof runAgent === 'function') {
                // Fire-and-forget. The agent loop is its own driver; we just
                // need to make sure it starts. Slot release happens when
                // the sub goes sleeping/stopped/errored (see _releasePoolSlot).
                // CRITICAL: runAgent is async — wrap in Promise.resolve so an
                // async rejection also marks the sub errored and frees the slot.
                // Without this, an async throw inside the loop leaks the pool
                // slot AND leaves the spawn handle pending forever.
                // IIFE captures aid + chat_id PER ITERATION (same pattern as
                // _awaitAny in 095-handle-registry.js): `var` is function-scoped,
                // so when one drain call starts two subs the deferred .then/.catch
                // callbacks would otherwise read the LAST iterated rec/aid —
                // starting the wrong chat twice, leaking the first sub's slot and
                // mis-attributing crash errors.
                (function(capturedAid, capturedChatId) {
                    Promise.resolve()
                        .then(function() { return runAgent(capturedChatId); })
                        .catch(function(err) {
                            _markErrored(capturedAid, 'agent loop crashed: ' + (err && err.message || err));
                        });
                })(aid, rec.chat_id);
            } else {
                // F3: runAgent unavailable (early boot / headless / missing
                // bundle). We already claimed the pool slot above — release it
                // and settle the sub as errored, otherwise the slot leaks and
                // the parent's spawn handle hangs forever.
                delete _subPool.running[aid];
                _markErrored(aid, 'pool-start failed: runAgent unavailable in this context');
            }
        } catch (e) {
            // Loop failed to start synchronously — release the slot and mark errored.
            delete _subPool.running[aid];
            _markErrored(aid, 'pool-start failed: ' + (e && e.message || e));
        }
        // Note: do NOT increment `i` after a successful claim — splice(i, 1)
        // already shifted the next item into position i.
    }
    _notifyListeners();
}

function _releasePoolSlot(agentId) {
    if (_subPool.running[agentId]) {
        delete _subPool.running[agentId];
        _drainPool();
    }
}

// ---------- Tombstone GC sweep ----------
// Runs every SUBAGENT_IDLE_SWEEP_MS while the registry is loaded. Tombstoned
// (stopped/errored) subs past SUBAGENT_TOMBSTONE_TTL_MS are deleted (record
// + background chat row). Previously this only ran at boot, so a long-lived
// tab leaked records indefinitely.

var _idleSweepInterval = null;

function _idleSweepTick() {
    var now = Date.now();
    for (var aid in _subAgents) {
        var r = _subAgents[aid];
        if (!r) continue;
        // Two reclamation cases:
        //  • Terminal (stopped/errored) past the tombstone TTL — kept briefly so
        //    the UI can show last_report, then collected.
        //  • Sleeping past the sleep-idle TTL — a sub that reported done/need_input
        //    (or was auto-reported) and was never woken again is abandoned. Without
        //    this, every completed sub parks as 'sleeping' forever and its record +
        //    background chat row leak indefinitely (the very slowdown this sweep
        //    exists to prevent). Gated to the authoritative context AND a settled
        //    spawn handle: the page mirror has an empty _spawnDeferreds map and must
        //    NOT judge "handle settled" (it would treat every sleeping sub as
        //    collectable and race the SW); a still-pending handle means a parent is
        //    mid-await and must never be collected.
        var _authoritativeCtx = (typeof Platform === 'undefined') || (Platform.isWorker === true);
        // Gate BOTH reclamation paths to the authoritative (SW/headless) context.
        // The page is a read-only mirror (empty _spawnDeferreds); letting it delete
        // the sub_agents IDB record + background chat row races the SW's persistence
        // and breaks the sub_report "open transcript" link. _isAbandonedSleep was
        // already gated; _isTombstone was not.
        var _isTombstone = _authoritativeCtx
            && (r.state === 'stopped' || r.state === 'errored')
            && r.settled_at && (now - r.settled_at) > SUBAGENT_TOMBSTONE_TTL_MS;
        var _isAbandonedSleep = _authoritativeCtx
            && r.state === 'sleeping'
            && r.last_activity_at && (now - r.last_activity_at) > SUBAGENT_SLEEP_TTL_MS
            && !_spawnDeferreds[r.spawn_handle_id];
        if (_isTombstone || _isAbandonedSleep) {
            // SWM2-F1(A): if focus is COMPLETELY unknown (SW boot / just after a
            // restart, before the page re-posts focus-chat) DEFER reclamation to a
            // later sweep — reclaiming now could rip out the transcript the user is
            // actively viewing (the SW's currentChatId is permanently null, so it is
            // no signal). Mirrors loadAllSubAgents' B7 deferral.
            // F2: only DEFER when a panel IS connected but its focus is still
            // unknown (transient reconnect gap). When ZERO panels are connected
            // (_connectedPanelCount() === 0) no transcript is being viewed, so GC
            // is safe — don't defer. _connectedPanelCount() returns -1 when the
            // signal is unreachable, so the !== 0 branch is true there and the
            // pre-F2 focus-only deferral is preserved.
            if (_connectedPanelCount() !== 0 && !_isFocusEstablished()) continue;
            // Skip GC if the user is currently viewing this sub's transcript —
            // otherwise the chat row gets ripped out from under them and the
            // message list goes blank. Defer to the next sweep.
            // B8: the `currentChatId === r.chat_id` clause is effectively dead here —
            // _isTombstone/_isAbandonedSleep both require _authoritativeCtx (the SW),
            // where currentChatId is permanently null. The live guard is the page→SW-
            // threaded focus; the currentChatId clause is kept only as a harmless
            // defensive fallback should this sweep ever run page-side.
            // SWM2-F2: skip if ANY live panel is viewing this transcript (focus is now
            // keyed per panel — a single scalar would let a 2nd panel clobber the 1st).
            if ((typeof currentChatId !== 'undefined' && currentChatId === r.chat_id)
                || _isChatFocusedByAnyPanel(r.chat_id)) {
                continue;
            }
            // Also delete the sub's chat record. Previously only the sub-agent
            // record was GC'd, leaving the background chat row in `chats` and
            // IDB. On long-lived tabs / restored profiles these accumulated
            // indefinitely (hidden because isBackground=true) and slowed every
            // chat-list enumeration.
            try {
                if (typeof chats !== 'undefined' && r.chat_id && chats[r.chat_id]) {
                    delete chats[r.chat_id];
                    // Persist the deletion via a full save — saveChatsToStorage does a
                    // clear+rewrite of the chats store, so the removed row actually
                    // leaves IDB. (deleteChatFromDB never existed.)
                    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
                }
            } catch (e) { console.warn('subAgent GC: failed to delete chat row', r.chat_id, e); }
            // A reclaimed ABANDONED-SLEEP parent may still own live descendants:
            // 'sleeping' is non-terminal, so no cascade ran when it parked. If we
            // delete its record + chat row now without cascading, a still-running
            // descendant orphans — it holds its pool slot until it finishes on its
            // own and its report/handle targets a deleted parent chat. Tombstones
            // (stopped/errored) were already cascaded at termination, so gate the
            // cascade on the abandoned-sleep case only. _cascadeStopDescendants
            // merely MARKS descendants terminal (no _subAgents key deletion), so
            // the enclosing for..in over _subAgents stays valid.
            if (_isAbandonedSleep) {
                try { _cascadeStopDescendants(r, 'parent sub-agent reclaimed (abandoned sleep): ' + (r.name || aid)); }
                catch (e) { console.warn('subAgent GC: cascade-stop on reclaim failed', aid, e); }
            }
            delete _subAgents[aid];
            try { _subAgentsDeleteFromDB(aid); } catch (e) { console.warn('subAgent GC: failed to delete record', aid, e); }
        }
    }
    _notifyListeners();
}

function _startIdleSweep() {
    if (_idleSweepInterval) return;
    if (typeof setInterval !== 'function') return; // headless / build context
    _idleSweepInterval = setInterval(function() {
        try { _idleSweepTick(); } catch (_) { /* never crash the sweep */ }
    }, SUBAGENT_IDLE_SWEEP_MS);
}

// ---------- Listeners (UI hookpoint) ----------

function _notifyListeners() {
    for (var i = 0; i < _subAgentListeners.length; i++) {
        try { _subAgentListeners[i](); } catch (_) { /* ignore */ }
    }
}

function addSubAgentListener(fn) {
    if (typeof fn !== 'function') return;
    _subAgentListeners.push(fn);
    // Late-binding safety: if the UI module loaded after a sub-agent had
    // already been spawned (file-ordering accident, or the registry was
    // restored from IDB before the UI rendered), `_notifyListeners` will
    // have fired into an empty listener set and the new listener would
    // miss every existing record. Fire once on attach so the freshly
    // attached listener gets to do its initial paint against current
    // state. Wrap in try so a buggy listener can't poison the rest of
    // the registry boot.
    try { fn(); } catch (_) { /* listener handles its own errors */ }
}

function removeSubAgentListener(fn) {
    _subAgentListeners = _subAgentListeners.filter(function(f) { return f !== fn; });
}

// Full-replace mirror update for the page bundle. The SW is the authority
// for sub-agent state; the page is a pure read-only mirror used by the
// workers strip + chat list. The SW broadcasts a `subagent-snapshot`
// envelope (see src/js/worker/105-subagent-broadcast.js) on every notify,
// and the page bridge (src/js/app/045-agent-port-bridge-page.js) routes it
// here. Full-replace is correct because no page-side mutation paths exist.
function applySubAgentSnapshot(records) {
    var next = Object.create(null);
    if (records && records.length) {
        for (var i = 0; i < records.length; i++) {
            var rec = records[i];
            if (rec && rec.agent_id) next[rec.agent_id] = rec;
        }
    }
    _subAgents = next;
    _notifyListeners();
}

// ---------- ID helpers ----------

function _newAgentId() {
    return 'sub_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
}

function _newSubChatId() {
    return 'chat_sub_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
}

// ---------- Tool roster computation ----------
// Apply allow/deny on top of the parent's allowed tools. Sub-only tools
// (`report_to_parent`, `sleep_self`, `agent_message`) are always injected.

var SUB_ONLY_TOOLS = ['report_to_parent', 'sleep_self', 'agent_message'];

function _computeToolRoster(allowNested) {
    // Subs inherit the parent's full tool roster. The only filter is the
    // nested-delegation gate: spawn/stop/wake_sub_agent are denied unless
    // the caller passed `allow_nested:true` at spawn time. This keeps the
    // sub's tools-cache slot byte-identical across every default spawn in
    // a session (no per-sub whitelist churn), so Anthropic's prompt cache
    // reuses it.
    var allNames = [];
    if (typeof TOOLS !== 'undefined' && Array.isArray(TOOLS)) {
        for (var i = 0; i < TOOLS.length; i++) {
            if (TOOLS[i] && TOOLS[i].function && TOOLS[i].function.name) {
                allNames.push(TOOLS[i].function.name);
            }
        }
    }
    // Include any active-skill tools so a sub spawned from a chat that has
    // a skill loaded can still use those tools. Defensive guard if the
    // skill subsystem hasn't loaded.
    try {
        if (typeof getActiveSkillTools === 'function') {
            var skillTools = getActiveSkillTools() || [];
            for (var si = 0; si < skillTools.length; si++) {
                var sName = skillTools[si] && skillTools[si].function && skillTools[si].function.name;
                if (sName && allNames.indexOf(sName) === -1) allNames.push(sName);
            }
        }
    } catch (_) { /* skill subsystem unavailable — fall through */ }

    var denySet = Object.create(null);
    if (!allowNested) {
        for (var di = 0; di < SUBAGENT_NESTED_DELEGATION_TOOLS.length; di++) {
            denySet[SUBAGENT_NESTED_DELEGATION_TOOLS[di]] = true;
        }
    }

    var out = [];
    for (var j = 0; j < allNames.length; j++) {
        var n = allNames[j];
        if (denySet[n]) continue;
        out.push(n);
    }
    // Always inject sub-only tools (how the sub talks back to the parent
    // and parks itself). Position-stable: append at end — they're not in
    // the parent's TOOLS list so adding them here doesn't perturb order.
    for (var k = 0; k < SUB_ONLY_TOOLS.length; k++) {
        if (out.indexOf(SUB_ONLY_TOOLS[k]) === -1) out.push(SUB_ONLY_TOOLS[k]);
    }
    return out;
}

// ---------- Core API: spawn ----------

function spawnSubAgent(args, ctx) {
    // ctx provides the parent chatId. Falls back to the streaming chat
    // (so a sub-agent calling spawn_sub_agent, if allowed, gets correct
    // parentage even when js_eval is the immediate caller).
    args = args || {};
    var parentChatId = (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    if (!parentChatId) {
        return { success: false, error: 'spawn_sub_agent: no parent chat context' };
    }
    var instructions = args.instructions;
    if (!instructions || typeof instructions !== 'string') {
        return { success: false, error: 'spawn_sub_agent: `instructions` is required (string).' };
    }

    var agent_id = _newAgentId();
    var chat_id  = _newSubChatId();

    // Determine if the *spawner* is itself a sub-agent — used for
    // breadcrumbing and to enforce the no-nested-spawn default.
    var parentAgentId = null;
    if (typeof chats !== 'undefined' && chats[parentChatId] && chats[parentChatId].isSubAgent) {
        parentAgentId = chats[parentChatId].subAgentId || null;
    }

    // Compute tree-position metadata (Phase 5). For a top-level sub spawned by
    // a regular chat: depth=1, root_chat_id = parent_chat_id. For a nested sub:
    // inherit depth+1 and root_chat_id from the spawning sub's record.
    var depth = 1;
    var rootChatId = parentChatId;
    if (parentAgentId) {
        var parentRec = _subAgents[parentAgentId];
        if (parentRec) {
            depth = (parentRec.depth || 1) + 1;
            rootChatId = parentRec.root_chat_id || parentRec.parent_chat_id;
        }
    }
    if (depth > SUBAGENT_MAX_DEPTH) {
        return { success: false, error: 'spawn_sub_agent: nesting depth ' + depth + ' exceeds SUBAGENT_MAX_DEPTH (' + SUBAGENT_MAX_DEPTH + '). Refusing to spawn — if you genuinely need deeper trees, raise the constant.' };
    }

    var toolRoster = _computeToolRoster(args.allow_nested === true);

    // Allocate the spawn handle now. The agent loop / report_to_parent will
    // settle it later. The handle is owned by the PARENT chat (so the
    // parent's await_handle finds it in its own bucket).
    if (typeof Handles === 'undefined') {
        return { success: false, error: 'spawn_sub_agent: Handle registry unavailable.' };
    }
    // Verify the chats map is available BEFORE allocating the spawn handle and
    // persisting the record below. This guard previously lived ~40 lines down
    // (after handle + record allocation); if it ever fired, the freshly-created
    // spawn deferred never resolved (the parent's await_handle hung forever)
    // and an orphan state:'running' record leaked into _subAgents. Fail fast
    // here, before anything has been allocated.
    if (typeof chats === 'undefined') {
        return { success: false, error: 'spawn_sub_agent: chats map unavailable.' };
    }
    var displayName = 'spawn_sub_agent: ' + (args.name || (instructions.slice(0, 40) + '…'));
    // We use Handles.start with a runFn that simply waits for a deferred
    // promise the registry exposes — i.e. the handle resolves out-of-band
    // from report_to_parent / stop_sub_agent. The "runFn" never throws on
    // its own; settlement is push-driven via _resolveSpawnHandle.
    var _spawnDeferred = _makeDeferred();
    var started = Handles.start(parentChatId, 'spawn_sub_agent', args, displayName, function() {
        return _spawnDeferred.promise;
    });
    var spawn_handle_id = started.handleId;

    var now = Date.now();
    var record = {
        agent_id: agent_id,
        chat_id: chat_id,
        parent_chat_id: parentChatId,
        parent_agent_id: parentAgentId,
        depth: depth,
        root_chat_id: rootChatId,
        name: args.name || ('sub_' + agent_id.slice(-6)),
        state: 'running',
        spawn_args: args,
        spawn_handle_id: spawn_handle_id,
        tool_roster: toolRoster,
        auto_report: (args.auto_report === false) ? false : true,
        // Wake the parent when this sub reports (default ON, opt-out via
        // wake_parent:false). SYMPTOM this fixes: a sub's report_to_parent
        // landed in the parent transcript but, when the parent chat was idle,
        // no run started — the report was invisible to the parent AGENT until
        // the user's next message. See _wakeParentOnReport.
        wake_parent: (args.wake_parent === false) ? false : true,
        // Flipped true when the parent actually collects the report via
        // await_handle / poll_handle / await_any / await_all (see
        // markReportCollected). Persisted, so an undelivered report can be
        // identified — and replayed/queried — after an MV3 SW restart.
        report_collected: false,
        max_tool_calls: (typeof args.max_tool_calls === 'number' && args.max_tool_calls > 0)
            ? Math.floor(args.max_tool_calls) : SUBAGENT_DEFAULT_MAX_TOOLS,
        summary_cap_bytes: SUBAGENT_DEFAULT_SUMMARY_KB * 1024,
        created_at: now,
        last_activity_at: now,
        tool_calls_used: 0,
        last_report: null,
        inbox: [],
        pending_handles: [spawn_handle_id],
        settled_at: null
    };
    _subAgents[agent_id] = record;
    // Store deferred outside the persisted record (functions aren't IDB-safe).
    _spawnDeferreds[spawn_handle_id] = _spawnDeferred;
    _subAgentsPersist(record);

    // Create the sub's chat. The agent loop reads `chats[chatId]` so this
    // must exist before runAgent fires. We mark it isBackground so it
    // doesn't pop into the foreground UI, AND isSubAgent so the system
    // prompt module appends the preamble. (chats availability was verified at
    // the top of spawnSubAgent, before any handle/record allocation.)
    chats[chat_id] = {
        id: chat_id,
        title: record.name,
        messages: [],
        createdAt: now,
        updatedAt: now,
        isBackground: true,
        isSubAgent: true,
        subAgentId: agent_id,
        parentChatId: parentChatId,
        // sub-agents don't inherit the parent's pause state; they manage
        // their own lifecycle via sleep_self / wake_sub_agent / stop_sub_agent.
    };

    // First user message = the task + optional context seed, as plain
    // markdown (no XML wrapper — the sub's transcript should read naturally).
    var firstMsg = '## Task\n\n' + instructions;
    if (args.context_seed != null) {
        var seedStr;
        try { seedStr = (typeof args.context_seed === 'string') ? args.context_seed : JSON.stringify(args.context_seed, null, 2); }
        catch (e) { seedStr = String(args.context_seed); }
        firstMsg += '\n\n## Context\n\n```json\n' + seedStr + '\n```';
    }
    // Optional output_schema: declare the exact shape the parent expects back.
    // The parent typically parses report.data programmatically (e.g. spawned +
    // awaited inside a single js_eval), so conformance matters.
    if (args.output_schema != null) {
        var schemaStr;
        try { schemaStr = (typeof args.output_schema === 'string') ? args.output_schema : JSON.stringify(args.output_schema, null, 2); }
        catch (e) { schemaStr = String(args.output_schema); }
        firstMsg += '\n\n## Expected output schema\n\n```json\n' + schemaStr + '\n```'
            + '\nWhen you call report_to_parent, the `data` field MUST be a JSON object that conforms EXACTLY to the schema above — same keys, same types, no extra keys, no prose inside data. Put any human-readable narration in `summary`; put the schema-conformant structured result in `data`. The parent parses `data` programmatically, so a mismatched shape will break it.';
    }
    chats[chat_id].messages.push({ role: 'user', content: firstMsg });
    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();

    // Push the live sub-agent card into the PARENT transcript right now, so the
    // delegation is visible inline from the moment it starts (spinner + live
    // status), its inputs are available (collapsed), and progress streams in
    // below. The SAME row is updated in place by agent_message(to:'parent') and
    // finalized by report_to_parent / onSubAgentRunFinished / stop_sub_agent.
    // sub_report rows are UI-only (stripped from the API payload in
    // 020-api-messages.js), so pushing one into a mid-turn parent chat is safe.
    if (chats[parentChatId] && Array.isArray(chats[parentChatId].messages)) {
        var _cardInstr = String(instructions || '');
        // Store the FULL instructions on the card: the input panel in
        // 175-sub-agent-ui.js already has collapse (−/+ preview) and expand (⤢)
        // affordances designed for long text, and the chats store is IndexedDB
        // (store.put of the whole chat object — no per-field limit), so a tiny
        // display cap only corrupted the record the user wants to read. Keep a
        // generous 64KB safety cap purely as a runaway-payload guard (a
        // megabyte instruction would bloat every saveChatsToStorage cycle).
        if (_cardInstr.length > 65536) _cardInstr = _cardInstr.slice(0, 65536) + '\n…[truncated]';
        chats[parentChatId].messages.push({
            role: 'sub_report',
            subAgentId: agent_id,
            subAgentName: record.name,
            subChatId: chat_id,
            maxToolCalls: record.max_tool_calls || 0,
            subDepth: record.depth || 1,
            spawnArgs: {
                instructions: _cardInstr,
                context_seed: (args.context_seed != null) ? args.context_seed : null,
                output_schema: (args.output_schema != null) ? args.output_schema : null
            },
            progress: [],
            report: { status: 'running', summary: '', from: agent_id, from_name: record.name, at: now },
            createdAt: now
        });
        _repaintParent(parentChatId);
    }

    // Queue for the pool. If there's a slot free, runAgent fires immediately.
    _subPool.queue.push(agent_id);
    _drainPool();

    return {
        success: true,
        agent_id: agent_id,
        chat_id: chat_id,
        handle: spawn_handle_id,
        note: 'Sub-agent spawned. Use `await_handle("' + spawn_handle_id + '")` to collect the result, or `agent_status` for live state.'
    };
}

// ---------- Spawn-handle settlement ----------
// The spawn handle resolves when the sub reports done/error, is stopped,
// or exhausts its tool budget. We use a per-handle deferred (in-memory
// only — handles themselves are in-memory per spec §8.3) so the resolution
// is push-driven.

var _spawnDeferreds = Object.create(null);

// ---------- Tree-walk helpers (Phase 5 — nested delegation) ----------

// Walk the parent_agent_id chain from `agentId` upward. Returns an array of
// agent_ids (oldest → self). Cycle-safe (max SUBAGENT_MAX_DEPTH iterations).
function _ancestorChain(agentId) {
    var out = [];
    var seen = Object.create(null);
    var cur = agentId;
    for (var i = 0; i < SUBAGENT_MAX_DEPTH + 2 && cur; i++) {
        if (seen[cur]) break; // cycle guard
        seen[cur] = true;
        out.unshift(cur);
        var rec = _subAgents[cur];
        cur = rec && rec.parent_agent_id;
    }
    return out;
}

// Direct children of `agentId`.
function _children(agentId) {
    var out = [];
    for (var aid in _subAgents) {
        if (_subAgents[aid].parent_agent_id === agentId) out.push(aid);
    }
    return out;
}

// All descendants of `agentId` (DFS, deepest first — useful for cascade-stop
// so we settle leaves before their parents). Cycle-safe via depth cap.
function _descendants(agentId) {
    var out = [];
    var stack = _children(agentId).slice();
    var seen = Object.create(null);
    while (stack.length) {
        var cur = stack.pop();
        if (seen[cur]) continue;
        seen[cur] = true;
        out.push(cur);
        var kids = _children(cur);
        for (var i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    // Deepest first (leaves before internal nodes). _children does breadth
    // order; we want depth ordering for cascade-stop. Sort by depth desc.
    out.sort(function(a, b) {
        var da = (_subAgents[a] && _subAgents[a].depth) || 0;
        var db = (_subAgents[b] && _subAgents[b].depth) || 0;
        return db - da;
    });
    return out;
}

// ACL: is `callerAgentId` an ancestor of `targetAgentId`? Used to gate
// stop / wake / message so a sub can only touch its own subtree.
// `callerAgentId = null` (i.e. caller is the human parent chat) is allowed
// iff target's root_chat_id === callerChatId.
function _callerOwnsTarget(callerChatId, callerAgentId, targetRec) {
    if (!targetRec) return false;
    if (callerAgentId) {
        // Sub caller: target must be a strict descendant of caller.
        var chain = _ancestorChain(targetRec.agent_id);
        // chain includes targetRec.agent_id at the end — caller must appear
        // strictly before it.
        for (var i = 0; i < chain.length - 1; i++) {
            if (chain[i] === callerAgentId) return true;
        }
        return false;
    }
    // Top-level (non-sub) caller: must own the root chat.
    return (targetRec.root_chat_id === callerChatId)
        || (targetRec.parent_chat_id === callerChatId);
}

function _makeDeferred() {
    var resolve, reject;
    var p = new Promise(function(res, rej) { resolve = res; reject = rej; });
    return { promise: p, resolve: resolve, reject: reject };
}

// True while at least one caller is genuinely blocked inside
// Handles.await on this sub's spawn handle. MUST be sampled BEFORE
// _resolveSpawnHandle: error/cancel settlements (_settleError/_cancel)
// drain the awaiters synchronously, so an after-the-fact check always
// sees an empty array. Used by _wakeParentOnReport to skip the wake when
// the parent is parked in await_handle — the settle itself already
// delivers the report into that turn (no double notification).
function _spawnHandleHasAwaiters(rec) {
    try {
        if (!rec || typeof Handles === 'undefined' || !Handles.get) return false;
        var e = Handles.get(rec.parent_chat_id, rec.spawn_handle_id);
        return !!(e && e.status === 'pending' && e.awaiters && e.awaiters.length > 0);
    } catch (_) { return false; }
}

// Mark a sub's report as collected by the parent. Called from the
// await_handle / poll_handle / await_any / await_all dispatch arms
// (src/js/tools/020-tool-execution.js) when a TERMINAL snapshot for a
// spawn handle is handed to the caller. Persisted so that, after an MV3
// SW restart, `report_collected:false` identifies reports the parent
// never saw (the rehydrated handle — see _rehydrateSpawnHandle — can then
// replay them on a fresh await/poll).
function markReportCollected(callerChatId, handleId) {
    if (!handleId) return false;
    for (var aid in _subAgents) {
        var r = _subAgents[aid];
        if (r && r.spawn_handle_id === handleId
            && (!callerChatId || r.parent_chat_id === callerChatId)) {
            if (!r.report_collected) {
                r.report_collected = true;
                _subAgentsPersist(r);
                _notifyListeners();
            }
            return true;
        }
    }
    return false;
}

// ---------- Wake-the-parent on report (P2) ----------
// SYMPTOM this fixes: when a sub reported (explicit report_to_parent,
// auto-report, crash, budget force-stop, bare sleep_self), the report row
// landed in the parent TRANSCRIPT but the parent AGENT only learned about
// it on the user's next message — an idle parent never started a run, so
// fire-and-forget delegation silently stalled.
//
// Delivery matrix (mirrors _notifySubLifecycle's live-vs-idle split and
// _handlePanelSendMessage's idle arm in src/js/worker/130-port-bridge.js):
//   • spawn handle has live awaiters AND parent loop is live → SKIP
//     entirely — the parent is blocked in await_handle and the settle
//     already delivers the report into that very turn.
//   • parent loop live (runningChatIds / pool) → coalesce the notice into
//     pendingInjectionsByChatId; flushPendingInjection (030-agent-loop.js)
//     consumes it at a safe alternation point mid-run. Multiple reporters
//     merge into one injection (text concat), same as agent_message.
//   • parent idle + parent is itself a SUB (nested) → wake through
//     _wakeSubAgentImpl(…, isInternalCascade=true) so pool-slot accounting
//     stays correct — never a raw runAgent for a sub chat.
//   • parent idle top-level chat → push a notice user row, persist, and
//     START a run (the _handlePanelSendMessage idle arm, minus the
//     user-attachment handling). REG391-1: if the USER explicitly paused
//     the chat, the notice row is still pushed (consumed on manual
//     resume) but the pause is respected — no flag clearing, no run.
//
// opts.hadAwaiters: sampled by the caller BEFORE _resolveSpawnHandle (see
// _spawnHandleHasAwaiters). opts.noticeDelivered: the caller already pushed
// a model-visible notice via _notifySubLifecycle (error paths) — only the
// run-start half is still needed; pushing a second row would duplicate.
function _wakeParentOnReport(rec, report, opts) {
    opts = opts || {};
    try {
        if (!rec) return false;
        if (rec.wake_parent === false) return false; // spawn-time opt-out
        var pcid = rec.parent_chat_id;
        if (!pcid || typeof chats === 'undefined' || !chats[pcid]) return false;
        // Live check — same shape as _notifySubLifecycle.
        var live = !!(typeof runningChatIds !== 'undefined' && runningChatIds[pcid]);
        var parentSubRec = null;
        if (chats[pcid].isSubAgent && chats[pcid].subAgentId) {
            parentSubRec = _subAgents[chats[pcid].subAgentId] || null;
            if (!live && parentSubRec) live = !!_subPool.running[parentSubRec.agent_id];
        }
        // (1) Parent blocked in await_handle — the settle delivers; skip.
        if (opts.hadAwaiters && live) return false;
        var oneLine = String((report && report.summary) || '').split('\n')[0].slice(0, 300);
        var notice = 'Sub-agent "' + (rec.name || rec.agent_id) + '" (' + rec.agent_id + ') reported ('
            + ((report && report.status) || 'done') + ')' + (oneLine ? ': ' + oneLine : '')
            + ' — full report via await_handle("' + rec.spawn_handle_id + '") or agent_status.';
        if (live) {
            // (3) Mid-run: queue for flushPendingInjection; coalesce with any
            // earlier reporter / lifecycle notice already waiting.
            if (opts.noticeDelivered) return false; // _notifySubLifecycle already queued one
            if (typeof pendingInjectionsByChatId !== 'undefined') {
                var ex = pendingInjectionsByChatId[pcid];
                pendingInjectionsByChatId[pcid] = {
                    text: ((ex && ex.text) ? ex.text + '\n\n' : '') + notice,
                    images: (ex && ex.images) ? ex.images : []
                };
                return true;
            }
            return false;
        }
        // Idle parent.
        if (parentSubRec) {
            // (2) Nested: the parent is itself a sub — wake via the cascade
            // entry point for pool-slot accounting. The instruction carries
            // the notice (skipped when _notifySubLifecycle already pushed a
            // user row into the sleeping parent's transcript — the bare wake
            // still resumes on that row, keeping safe alternation).
            var wargs = { agent_id: parentSubRec.agent_id };
            if (!opts.noticeDelivered) wargs.instruction = notice;
            // PR390-FU-2: a refused wake here is currently structurally
            // unreachable (this arm requires !live, the resurrect guard
            // requires runningChatIds) — but if _wakeSubAgentImpl ever gains a
            // new failure mode, a silently-lost parent wake is the worst
            // possible outcome. Log loudly instead of ignoring the result.
            var _npWakeRes = _wakeSubAgentImpl(wargs, null, true);
            if (_npWakeRes && _npWakeRes.success === false) {
                console.warn('[sub-agents] _wakeParentOnReport: nested parent wake refused for', parentSubRec.agent_id, _npWakeRes.error);
                return false;
            }
            return true;
        }
        // Top-level idle chat — mirror _handlePanelSendMessage's idle arm:
        // push the row, persist, start the loop.
        if (!opts.noticeDelivered && Array.isArray(chats[pcid].messages)) {
            chats[pcid].messages.push({ role: 'user', content: notice, injected: true });
        }
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        // REG391-1: respect an explicit user pause. The old arm cleared the
        // pause flags like _handlePanelSendMessage does — but THERE the actor
        // is the user (a genuine send implies resume); HERE the actor is an
        // autonomous sub report/crash/budget-stop (wake_parent defaults ON),
        // so clearing silently overrode explicit user intent and force-started
        // a paused chat. Leave the notice row parked in the transcript — the
        // model consumes it when the user resumes.
        var _wpPaused = false;
        try {
            if (typeof isChatPaused === 'function' && isChatPaused(pcid)) _wpPaused = true;
            if (typeof pausedChats !== 'undefined' && pausedChats[pcid] === true) _wpPaused = true;
            if (typeof pausedChatIds !== 'undefined' && pausedChatIds[pcid] === true) _wpPaused = true;
        } catch (_) { /* unreadable pause state — treat as not paused */ }
        if (_wpPaused) return false;
        if (typeof runAgent === 'function') {
            // Same async-rejection guard as _drainPool: runAgent is async and
            // its own driver; an early-return on runningChatIds (two subs
            // reporting in the same tick) is harmless.
            Promise.resolve()
                .then(function() { return runAgent(pcid); })
                .catch(function(err) {
                    console.warn('[sub-agents] wake-parent run failed for', pcid, err);
                });
        }
        return true;
    } catch (e) {
        console.warn('[sub-agents] _wakeParentOnReport failed for', rec && rec.agent_id, e);
        return false;
    }
}

function _resolveSpawnHandle(agentId, payload) {
    var rec = _subAgents[agentId];
    if (!rec) return;
    var hid = rec.spawn_handle_id;
    var d = _spawnDeferreds[hid];
    if (!d) return; // already resolved
    delete _spawnDeferreds[hid];
    // Prune the spawn handle from rec.pending_handles. Subs are initialized
    // with pending_handles:[spawn_handle_id] and that entry was never being
    // cleared on settlement — so agent_status() kept returning
    // pending_handles:1 forever on settled subs, which looked like a leak
    // ("sub is sleeping but still has 1 pending handle?"). The handle IS
    // settled at this point (we just resolved the deferred), so the rec
    // should reflect that.
    if (Array.isArray(rec.pending_handles)) {
        var _phIdx = rec.pending_handles.indexOf(hid);
        if (_phIdx >= 0) rec.pending_handles.splice(_phIdx, 1);
    }
    // Map the report's logical status onto the outer handle's lifecycle
    // status so the parent's `await_handle` snapshot is self-describing.
    // Without these branches the handle would always settle as `done`
    // (success) even when the embedded report was a crash, which was easy
    // for callers to miss — `if (snap.status==='done') useResult` would
    // happily consume an error report.
    //
    //   cancelled  → Handles.cancel — snapshot.status='cancelled', error=reason
    //   error      → Handles.errorWith — snapshot.status='error',
    //                  error=summary, result=full payload
    //   done/need_input → plain d.resolve — snapshot.status='done',
    //                  result=payload (status field carries done|need_input)
    //
    // The .then guard in Handles._startHandle (status !== 'pending' check)
    // preserves the pre-settled state when the deferred eventually resolves.
    if (payload && payload.status === 'cancelled') {
        if (typeof Handles !== 'undefined' && Handles.cancel) {
            try {
                Handles.cancel(rec.parent_chat_id, hid,
                    (payload.summary || payload.error || 'sub-agent stopped'));
            } catch (_) { /* ignore — best effort */ }
        }
    } else if (payload && payload.status === 'error') {
        if (typeof Handles !== 'undefined' && Handles.errorWith) {
            try {
                Handles.errorWith(rec.parent_chat_id, hid,
                    (payload.summary || payload.error || 'sub-agent reported error'),
                    payload);
            } catch (_) { /* ignore — best effort */ }
        }
    }
    d.resolve(payload);
}

// ---------- report_to_parent ----------

// ---------- Live sub-agent card (parent transcript) ----------
// A sub-agent is represented by ONE evolving `sub_report` row in the parent
// chat, pushed at spawn time (status:'running', spinner) and updated in place
// as the sub makes progress (agent_message -> parent), then finalized on
// report_to_parent / auto-report / stop. _findSubAgentCard locates that row;
// _repaintParent persists + repaints the parent (if in view) and notifies
// background subscribers / other tabs.
function _findSubAgentCard(parentChatId, agentId) {
    var pc = (typeof chats !== 'undefined') ? chats[parentChatId] : null;
    if (!pc || !pc.messages || !agentId) return null;
    for (var i = pc.messages.length - 1; i >= 0; i--) {
        var m = pc.messages[i];
        if (m && m.role === 'sub_report' && m.subAgentId === agentId) return m;
    }
    return null;
}
function _repaintParent(parentChatId) {
    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    try {
        if (typeof currentChatId !== 'undefined' && currentChatId === parentChatId
            && typeof renderMessages === 'function') renderMessages();
    } catch (_) { /* ignore */ }
    try {
        if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
            AgentEvents.emit('messagesAppended', { chatId: parentChatId, force: true });
        }
    } catch (_) { /* ignore */ }
}
// Finalize the live parent card for `rec` with `report` — but only if the
// card is still non-terminal (running/partial). Terminal cards are
// authoritative (an explicit report_to_parent already landed) and are left
// alone. Used by every "the sub is over" path that doesn't push its own
// report row: auto-report / crash (onSubAgentRunFinished), stop_sub_agent,
// _markErrored, the boot orphan-rewrite, and the tombstone GC (so a card
// can never outlive its record as a permanent spinner).
function _finalizeSubAgentCard(rec, report) {
    if (!rec || !report) return false;
    try {
        var card = _findSubAgentCard(rec.parent_chat_id, rec.agent_id);
        if (!card) return false;
        var st = card.report && card.report.status;
        if (st === 'done' || st === 'error' || st === 'need_input' || st === 'cancelled') return false;
        card.report = report;
        if (rec.chat_id) card.subChatId = rec.chat_id;
        if (rec.name) card.subAgentName = rec.name;
        _repaintParent(rec.parent_chat_id);
        return true;
    } catch (_) { return false; }
}

// ---------- RES-6: lifecycle resilience helpers ----------

// Transient-error classifier for the crash auto-retry path. No shared
// classification exists elsewhere (lastApiError carries an opaque message
// string), so match the common network / timeout / throttling shapes the
// streaming layer surfaces. Conservative on purpose: unknown errors are NOT
// transient (no retry) — a wrong 'transient' verdict would burn the single
// retry on a deterministic failure.
function _isTransientSubError(msg) {
    if (!msg) return false;
    return /failed to fetch|networkerror|network error|fetch failed|load failed|timeout|timed out|econnreset|econnrefused|enotfound|enetunreach|etimedout|socket hang up|connection[ ](reset|refused|closed|aborted)|temporarily unavailable|overloaded|rate.?limit|too many requests|\b(429|502|503|504|529)\b/i.test(String(msg));
}

// PR383-R5: throttle-class subset of the transient errors above. These mean
// the provider is actively shedding load — an IMMEDIATE synchronous replay is
// near-guaranteed to fail again and burns the single per-crash auto-retry.
// The auto-retry path in onSubAgentRunFinished delays this class ~8s before
// re-queueing; connection/fetch/timeout-class errors keep the immediate retry.
function _isThrottleSubError(msg) {
    if (!msg) return false;
    return /rate.?limit|too many requests|overloaded|temporarily unavailable|\b(429|529)\b/i.test(String(msg));
}

// RES-6: push a short structured lifecycle notice to the PARENT so it is
// never blind to unsolicited sub events (crash, stuck, approval park, user
// interference). Two delivery surfaces, both reusing existing mechanics:
//   1. The live sub_report card's progress stream (the same row that
//      agent_message(to:'parent') appends to) — the inline callout in the
//      parent transcript.
//   2. The parent MODEL's context: pendingInjectionsByChatId when a loop is
//      live for the parent (consumed at a safe alternation point by
//      flushPendingInjection, so an in-flight turn is never corrupted), or
//      a direct injected user row when the parent is idle — the exact
//      live-vs-idle split agent_message already uses for recipients.
// Parent-driven operations must NOT call this (no self-notification): every
// call site below fires only for events the parent did not itself initiate.
function _notifySubLifecycle(rec, headline) {
    if (!rec || !headline) return false;
    try {
        var pcid = rec.parent_chat_id;
        if (!pcid || typeof chats === 'undefined' || !chats[pcid]) return false;
        var text = '[sub-agent lifecycle] ' + (rec.name || rec.agent_id) + ' (' + rec.agent_id + '): ' + headline;
        // (1) inline callout on the live card (bounded like agentMessage's stream).
        var card = _findSubAgentCard(pcid, rec.agent_id);
        if (card) {
            if (!Array.isArray(card.progress)) card.progress = [];
            card.progress.push({ text: text, at: Date.now(), lifecycle: true });
            while (card.progress.length > 50) {
                card.progress.shift();
                card.progressDropped = (card.progressDropped || 0) + 1;
            }
        }
        // (2) model-visible delivery. 'Live' mirrors agentMessage's check:
        // runningChatIds for any chat, plus the pool flag when the parent is
        // itself a sub.
        var live = !!(typeof runningChatIds !== 'undefined' && runningChatIds[pcid]);
        if (!live && chats[pcid].isSubAgent && chats[pcid].subAgentId) {
            var prec = _subAgents[chats[pcid].subAgentId];
            live = !!(prec && _subPool.running[prec.agent_id]);
        }
        if (live && typeof pendingInjectionsByChatId !== 'undefined') {
            var ex = pendingInjectionsByChatId[pcid];
            pendingInjectionsByChatId[pcid] = {
                text: ((ex && ex.text) ? ex.text + '\n\n' : '') + text,
                images: (ex && ex.images) ? ex.images : []
            };
        } else if (Array.isArray(chats[pcid].messages)) {
            chats[pcid].messages.push({ role: 'user', content: text, injected: true });
        }
        _repaintParent(pcid); // persists (saveChatsToStorage) + repaints/broadcasts
        return true;
    } catch (e) {
        console.warn('[sub-agents] lifecycle notify failed for', rec && rec.agent_id, e);
        return false;
    }
}

// RES-6: the user typed directly into a sub's chat (detected by the SW port
// bridge's _handlePanelSendMessage). Stamp user_interactions and tell the
// parent — the sub may now go off-script under user direction. State is
// deliberately NOT mutated: the port bridge starts/feeds the loop directly
// (outside the pool), exactly as it did before this hook existed.
function onUserMessageToSubChat(subChatId) {
    try {
        if (typeof chats === 'undefined' || !chats[subChatId] || !chats[subChatId].isSubAgent) return false;
        var rec = _subAgents[chats[subChatId].subAgentId];
        if (!rec) return false;
        rec.user_interactions = rec.user_interactions || {};
        rec.user_interactions.last_user_message_at = Date.now();
        rec.last_activity_at = Date.now();
        _subAgentsPersist(rec);
        _notifySubLifecycle(rec, 'the user sent a message directly into this sub-agent\'s chat (state: ' + rec.state + ')');
        _notifyListeners();
        return true;
    } catch (e) { console.warn('[sub-agents] onUserMessageToSubChat failed', e); return false; }
}

// RES-6: approval lifecycle for a sub's tool call (driven by the SW approval
// stub in worker/120-tool-routing.js). phase: 'requested' | 'approved' |
// 'denied' | 'aborted'. The park notice fires once per episode (0→1 pending
// approvals — no spam when several asks stack); denials always notify (the
// sub was told to STOP an operation); plain approvals just unblock the sub —
// its own progress stream shows life — so they only stamp the interaction.
function onSubApprovalEvent(subChatId, phase, info) {
    try {
        if (typeof chats === 'undefined' || !chats[subChatId] || !chats[subChatId].isSubAgent) return false;
        var rec = _subAgents[chats[subChatId].subAgentId];
        if (!rec) return false;
        var tool = (info && info.displayName) || 'a tool call';
        if (phase === 'requested') {
            rec._pending_approvals = (rec._pending_approvals || 0) + 1;
            if (rec._pending_approvals === 1) {
                _notifySubLifecycle(rec, 'parked waiting for USER APPROVAL of "' + tool + '" — it cannot proceed until the user responds');
            }
        } else {
            rec._pending_approvals = Math.max(0, (rec._pending_approvals || 0) - 1);
            if (phase === 'approved' || phase === 'denied') {
                rec.user_interactions = rec.user_interactions || {};
                rec.user_interactions.last_user_approval_at = Date.now();
            }
            if (phase === 'denied') {
                _notifySubLifecycle(rec, 'the user DENIED "' + tool + '" — the sub was instructed to stop that operation');
            }
        }
        rec.last_activity_at = Date.now();
        _subAgentsPersist(rec);
        _notifyListeners();
        return true;
    } catch (e) { console.warn('[sub-agents] onSubApprovalEvent failed', e); return false; }
}

// ---------- sub progress card (update_action_state mirrored from the sub) ----------
// Called by the SW tool-routing layer (worker/120-tool-routing.js) when a
// SUB-AGENT chat calls update_action_state. The tool itself executes on the
// page (non-headless), where chats / SubAgents are read-only mirrors — so the
// page attaches the normalized snapshot to its RESULT and this function, run
// in the authoritative SW context, persists it twice over:
//   1. rec.action_state — exposed to the parent agent via agent_status
//      (the parent's "check progress / get the task list" path), and carried
//      to the page mirror for free by the subagent-snapshot broadcast.
//   2. The parent chat's live sub_report card (msg.actionState) — rendered
//      by renderSubReport (175-sub-agent-ui.js) as a state pill + label +
//      tasks checklist, right where the sub's input/output already show.
// Merge semantics mirror the Action-button branch of executeUpdateActionState:
// tasks only replace when provided; output sets on string, clears on
// clearOutput, otherwise keeps the previous value.
function recordSubActionState(subChatId, snap) {
    if (!subChatId || !snap) return false;
    var ch = (typeof chats !== 'undefined') ? chats[subChatId] : null;
    var rec = (ch && ch.subAgentId) ? _subAgents[ch.subAgentId] : null;
    if (!rec) return false;
    var prev = rec.action_state || {};
    var next = {
        state: snap.state || 'running',
        icon: snap.icon || 'spinner',
        label: snap.label || '',
        tasks: Array.isArray(snap.tasks) ? snap.tasks : (prev.tasks || null),
        output: (typeof snap.output === 'string') ? snap.output
              : (snap.clearOutput ? null : (prev.output != null ? prev.output : null)),
        at: snap.at || Date.now()
    };
    rec.action_state = next;
    rec.last_activity_at = Date.now();
    _subAgentsPersist(rec);
    // RES-6: a sub flipping its progress card to 'stuck' is blocked and needs
    // attention — notify the parent once per stuck episode (the prev-state
    // comparison is the latch; repeated stuck updates don't re-notify).
    if (next.state === 'stuck' && prev.state !== 'stuck') {
        _notifySubLifecycle(rec, 'reported STUCK — ' + (next.label || 'needs attention') + ' (wake_sub_agent or agent_message can unblock it)');
    }
    var card = _findSubAgentCard(rec.parent_chat_id, rec.agent_id);
    if (card) {
        card.actionState = next;
        _repaintParent(rec.parent_chat_id);
    }
    _notifyListeners();
    return true;
}

function reportToParent(args, ctx) {
    args = args || {};
    var subChatId = (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    if (!subChatId || typeof chats === 'undefined' || !chats[subChatId] || !chats[subChatId].isSubAgent) {
        return { success: false, error: 'report_to_parent can only be called from inside a sub-agent chat.' };
    }
    var rec = _subAgents[chats[subChatId].subAgentId];
    if (!rec) {
        return { success: false, error: 'report_to_parent: sub-agent record missing.' };
    }

    var status = args.status;
    // `status` is informational only — every call settles the handle and parks
    // the sub. We still validate the enum so the UI badge has a known value.
    // `partial` is no longer accepted (use agent_message(to:"parent") for
    // mid-flight updates that should NOT settle the handle).
    if (['done', 'error', 'need_input'].indexOf(status) === -1) {
        return { success: false, error: 'report_to_parent: `status` must be one of done|error|need_input. For mid-flight updates that should not settle the handle, use agent_message(to:"parent").' };
    }
    if (rec.state === 'stopped' || rec.state === 'errored') {
        return { success: false, error: 'report_to_parent: sub is already terminal (' + rec.state + '); cannot report again.', already_settled: true };
    }
    // FIX #6 (idempotency): the FIRST settling call in this turn parks the sub
    // (_parkSubAgent -> state='sleeping') and consumes the spawn deferred
    // (_resolveSpawnHandle deletes _spawnDeferreds[spawn_handle_id]). A SECOND
    // settling call in the same tool batch (two reports, or sleep_self+report)
    // would otherwise pass the terminal guard above ('sleeping' is not
    // stopped/errored) and re-run side effects: _wakeParentOnReport fires a
    // duplicate parent notice and rec.last_report is overwritten so it diverges
    // from the already-settled handle. Refuse once the handle is settled. A
    // legitimate re-report after wake_sub_agent is fine: _wakeSubAgentImpl sets
    // state back to 'running' and _mintNewSpawnHandle re-arms the deferred, so
    // neither condition holds on that path.
    if (rec.state === 'sleeping' || !_spawnDeferreds[rec.spawn_handle_id]) {
        return { success: false, already_settled: true, error: 'report_to_parent: this turn already settled the spawn handle (state=' + rec.state + '); the sub is parked. It can report again only after being woken.' };
    }
    var summary = String(args.summary || '');
    if (summary.length > rec.summary_cap_bytes) {
        // Soft-truncate with marker so the parent still sees a usable report.
        summary = summary.slice(0, rec.summary_cap_bytes - 100) + '\n…[truncated by registry: summary exceeded ' + rec.summary_cap_bytes + ' bytes]';
    }
    var artifacts = Array.isArray(args.artifacts) ? args.artifacts.slice(0, SUBAGENT_MAX_ARTIFACTS) : [];
    var data = (args.data && typeof args.data === 'object') ? args.data : null;

    var report = {
        status: status,
        summary: summary,
        data: data,
        artifacts: artifacts,
        from: rec.agent_id,
        from_name: rec.name,
        at: Date.now()
    };
    rec.last_report = report;
    rec.last_activity_at = Date.now();
    // Fresh report — not yet collected by the parent (see markReportCollected).
    rec.report_collected = false;
    // RES-6: a successful report completes the turn — reset the per-crash
    // auto-retry latch so a future transient crash gets its own retry.
    if (rec._retry_used) { delete rec._retry_used; rec.last_error = null; } // PR383-R3: drop the recovered error too
    _subAgentsPersist(rec);

    // Push a styled callout row into the parent chat so the human reading
    // the parent transcript can see the report inline.
    if (chats[rec.parent_chat_id]) {
        // subChatId is persisted on the message so the UI "open transcript →"
        // link keeps working even after the registry GCs the settled
        // sub-agent record (SUBAGENT_TOMBSTONE_TTL_MS, ~1h). Without it the
        // link silently disappears from every historical sub_report row.
        // Finalize the live card pushed at spawn (update in place). Fall back
        // to appending a fresh row for legacy spawns that predate the card.
        var _rcard = _findSubAgentCard(rec.parent_chat_id, rec.agent_id);
        if (_rcard) {
            _rcard.report = report;
            _rcard.subChatId = rec.chat_id;
            _rcard.subAgentName = rec.name;
            // Stamp the final metrics onto the persisted card so the sidebar
            // Workers panel can reconstruct an accurate card (tool counts,
            // depth) after the registry GCs this sub's live record (~1h).
            _rcard.toolCallsUsed = rec.tool_calls_used || 0;
            _rcard.maxToolCalls = rec.max_tool_calls || 0;
            _rcard.subDepth = rec.depth || 1;
        } else {
            chats[rec.parent_chat_id].messages.push({
                role: 'sub_report',
                subAgentId: rec.agent_id,
                subAgentName: rec.name,
                subChatId: rec.chat_id,
                report: report,
                toolCallsUsed: rec.tool_calls_used || 0,
                maxToolCalls: rec.max_tool_calls || 0,
                subDepth: rec.depth || 1,
                createdAt: report.at
            });
        }
        _repaintParent(rec.parent_chat_id);
    }

    // Every report settles the spawn handle (if still pending) and parks the
    // sub. _resolveSpawnHandle is a no-op on subsequent calls after a wake
    // (the deferred is consumed on first resolution). The status field is
    // carried in the payload so the parent's await_handle snapshot reflects
    // what the sub said.
    // P2: sample awaiter state BEFORE the settle drains them — see
    // _spawnHandleHasAwaiters.
    var _rtpHadAwaiters = _spawnHandleHasAwaiters(rec);
    _resolveSpawnHandle(rec.agent_id, {
        status: status,
        summary: summary,
        data: data,
        artifacts: artifacts,
        from: rec.agent_id
    });
    _parkSubAgent(rec);
    // P2: make the report actionable for an idle/mid-run parent agent — not
    // just visible in the transcript (see _wakeParentOnReport).
    _wakeParentOnReport(rec, report, { hadAwaiters: _rtpHadAwaiters });
    _notifyListeners();
    return { success: true, ok: true };
}

// After any report_to_parent (or a bare sleep_self), a sub becomes dormant:
// state=sleeping, pool slot released, loop paused. Terminating a sub is a
// separate operation (stop_sub_agent) — there is no "stop" idle policy.
// No-ops on already-terminal subs (stopped/errored) so we don't clobber a
// crashed sub's state with 'sleeping' on the auto_report tail.
function _parkSubAgent(rec) {
    if (rec.state === 'stopped' || rec.state === 'errored') {
        if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
        _releasePoolSlot(rec.agent_id);
        _subAgentsPersist(rec);
        return;
    }
    rec.state = 'sleeping';
    if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
    _releasePoolSlot(rec.agent_id);
    _subAgentsPersist(rec);
}

// ---------- sleep_self / wake_sub_agent ----------

function sleepSelf(args, ctx) {
    args = args || {};
    var subChatId = (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    if (!subChatId || typeof chats === 'undefined' || !chats[subChatId] || !chats[subChatId].isSubAgent) {
        return { success: false, error: 'sleep_self can only be called from inside a sub-agent chat.' };
    }
    var rec = _subAgents[chats[subChatId].subAgentId];
    if (!rec) return { success: false, error: 'sleep_self: record missing.' };
    if (rec.state === 'stopped' || rec.state === 'errored') {
        return { success: false, error: 'sleep_self: sub is already terminal (' + rec.state + ').' };
    }
    // FIX #6 (idempotency): mirror reportToParent. If a prior settling call in
    // this same tool batch already parked the sub (state='sleeping') or consumed
    // the spawn deferred, a second sleep_self must be a no-op -- otherwise it
    // re-fires the synthetic need_input settle / _wakeParentOnReport below. A
    // woken sub is 'running' again with a freshly minted deferred, so a legit
    // later sleep passes.
    if (rec.state === 'sleeping' || !_spawnDeferreds[rec.spawn_handle_id]) {
        return { success: false, already_settled: true, error: 'sleep_self: this turn already settled the spawn handle (state=' + rec.state + '); the sub is already parked.' };
    }
    rec.state = 'sleeping';
    rec.last_activity_at = Date.now();
    if (args.reason) rec.last_sleep_reason = String(args.reason).slice(0, 200);
    // Signal the in-flight agent loop to stop after the current turn by
    // mirroring the action-engine's pause pattern: set pausedChats so
    // the loop yields at its next pause check. Without this, the loop
    // would just keep running until naturally done.
    if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
    // If the spawn handle is still pending (sub called sleep_self WITHOUT
    // first calling report_to_parent), settle it now with a synthetic
    // need_input status. Without this, the parent's await_handle hangs
    // indefinitely while the sub sits dormant.
    if (_spawnDeferreds[rec.spawn_handle_id]) {
        var _reason = (args.reason ? String(args.reason).slice(0, 200) : 'sub-agent parked via sleep_self without report_to_parent');
        rec.last_report = rec.last_report || {
            status: 'need_input',
            summary: _reason,
            from: rec.agent_id,
            from_name: rec.name,
            at: Date.now(),
            _synthesized: true
        };
        // P2: this synthetic need_input settle IS a report from the parent's
        // perspective — deliver/wake like one. Sample awaiters pre-settle.
        rec.report_collected = false;
        var _ssHadAwaiters = _spawnHandleHasAwaiters(rec);
        _resolveSpawnHandle(rec.agent_id, {
            status: rec.last_report.status,
            summary: rec.last_report.summary,
            from: rec.agent_id,
            _synthesized: true
        });
        _wakeParentOnReport(rec, rec.last_report, { hadAwaiters: _ssHadAwaiters });
    }
    _subAgentsPersist(rec);
    _releasePoolSlot(rec.agent_id);
    _notifyListeners();
    return { success: true, ok: true, state: 'sleeping' };
}

function wakeSubAgent(args, ctx) {
    return _wakeSubAgentImpl(args, ctx, false);
}

// Internal cascade entry point — used by agentMessage's auto-wake. The third
// arg (`isInternalCascade`) is a positional flag the model cannot reach: it
// is NEVER read from the user-facing tool args. The previous design read a
// `_internal_cascade` flag off `args`, but `args` comes verbatim from the
// model's tool call — so a hostile sub could pass `_internal_cascade: true`
// and bypass the subtree-ownership ACL entirely. Routing the flag through a
// distinct positional parameter closes that escalation.
function _wakeSubAgentImpl(args, ctx, isInternalCascade) {
    args = args || {};
    var rec = _subAgents[args.agent_id];
    if (!rec) return { success: false, error: 'wake_sub_agent: unknown agent_id ' + args.agent_id };
    // RES-6 (resurrect): errored/stopped subs are now revivable — their chat
    // transcript (full prior context) survives until the tombstone GC reaps
    // the record, so a crashed sub can be woken and continue where it left
    // off instead of redoing everything from scratch. Refuse only when the
    // transcript itself is gone (nothing left to resume into).
    var _resurrectedFrom = (rec.state === 'stopped' || rec.state === 'errored') ? rec.state : null;
    if (_resurrectedFrom && (typeof chats === 'undefined' || !chats[rec.chat_id])) {
        return { success: false, error: 'wake_sub_agent: sub is ' + _resurrectedFrom + ' and its chat transcript is no longer available — cannot resurrect. Spawn a fresh sub instead.' };
    }
    // ACL gate (Phase 5). Non-internal callers must own the subtree. The
    // gate is unconditional unless the caller is the registry itself.
    if (!isInternalCascade) {
        // F1: resolve the caller chat-id via the same fallback chain as
        // agent_message, and enforce the ACL UNCONDITIONALLY (fail closed).
        // Previously this only checked when ctx.chatId was truthy and had no
        // fallback — a call with an unresolved chat-id bypassed the subtree
        // ownership check entirely (fail open). _callerOwnsTarget(null,…)
        // returns false, so an unresolvable caller is now correctly denied.
        var _wakeCallerChatId = (ctx && ctx.chatId)
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        var _wakeCallerAgentId = (_wakeCallerChatId && typeof chats !== 'undefined'
            && chats[_wakeCallerChatId] && chats[_wakeCallerChatId].isSubAgent)
            ? chats[_wakeCallerChatId].subAgentId : null;
        if (!_callerOwnsTarget(_wakeCallerChatId, _wakeCallerAgentId, rec)) {
            return { success: false, error: 'wake_sub_agent: ACL denied — caller does not own this sub-agent\'s subtree.', _acl_denied: true };
        }
    }
    // RES-6 (resurrect, post-ACL so unauthorized callers can't mutate): revive
    // bookkeeping for a terminal sub.
    //   • settled_at → null: un-tombstone, or the GC sweep would reap a live sub.
    //   • _stoppedByUser cleared: onSubAgentRunFinished's terminal guard would
    //     otherwise cancel-settle the revived run's natural finish.
    //   • _retry_used cleared: the revived run gets a fresh crash-retry budget.
    // last_error / crash_cause move to prev_error / prev_crash_cause (PR383-R3):
    // history stays readable via agent_status without corrupting the NEXT
    // terminal event's fresh diagnostics.
    if (_resurrectedFrom) {
        // PR384-FIX-2: stop_sub_agent halts a live loop only ASYNCHRONOUSLY — it
        // sets pausedChats[chat_id]=true and the loop only stands down at its
        // next pause check, so runningChatIds[chat_id] may still be true here.
        // If we clear pausedChats / re-queue now, we revoke the stop signal: the
        // OLD loop never halts, finishes naturally, and its finish hook re-drains
        // → a SECOND run replays the transcript (duplicate side-effectful tool
        // calls). Refuse the resurrect (retryable) until the old loop is gone;
        // do NOT mutate bookkeeping / pausedChats / the queue while it is live.
        if (typeof runningChatIds !== 'undefined' && runningChatIds[rec.chat_id]) {
            return { success: false, error: 'wake_sub_agent: sub still winding down after stop — retry in a moment.', retryable: true };
        }
        rec.settled_at = null;
        delete rec._stoppedByUser;
        delete rec._retry_used;
        // PR383-R1: a sub force-stopped for budget exhaustion carries
        // tool_calls_used past the hard ceiling (SUBAGENT_BUDGET_HARD_MULT ×
        // max_tool_calls). Without a rebase, its FIRST tool call after
        // revival re-trips the ceiling in onToolCallInSubAgent — force-stop,
        // error-settle the fresh handle, another 'force-stopped …
        // Resurrectable' notice: a wake→stop→notify churn loop. Rebase usage
        // to exactly max_tool_calls: every subsequent call is past the soft
        // cap (the ⛔ BUDGET EXCEEDED wrap-up warning fires immediately), but
        // the 2× ceiling leaves ~max_tool_calls calls of real headroom to
        // wrap up. Checked BEFORE the history move below so the pre-resurrect
        // crash_cause is still readable.
        if (rec.crash_cause === 'budget_exhausted'
            || (rec.tool_calls_used || 0) >= rec.max_tool_calls * SUBAGENT_BUDGET_HARD_MULT) {
            rec.tool_calls_used = rec.max_tool_calls;
        }
        // PR383-R3: archive, then clear, the previous run's terminal
        // diagnostics so a NEW crash after resurrection records its own
        // cause/error instead of inheriting the old ones.
        if (rec.last_error)  { rec.prev_error = rec.last_error; rec.last_error = null; }
        if (rec.crash_cause) { rec.prev_crash_cause = rec.crash_cause; rec.crash_cause = null; }
    }
    // Honor the documented no-op-if-already-running contract. Without this,
    // calling wake on a live sub would clear pausedChats (potentially fighting
    // a legitimate user-pause), re-queue the loop, and drain the inbox into
    // an extra user message even though the live loop is already consuming it.
    if (rec.state === 'running' && !args.instruction && !(rec.inbox && rec.inbox.length)) {
        // Even on a no-op, hand back an awaitable handle for the in-flight run
        // so the caller can await the sub's eventual report. The documented
        // contract is "always returns {handle}". _mintNewSpawnHandle reuses the
        // still-pending spawn handle (or mints a fresh one if it had settled).
        return { success: true, ok: true, state: 'running', note: 'already running', handle: _mintNewSpawnHandle(rec) };
    }

    // If the wake carries an instruction, deliver it. Otherwise drain the
    // inbox into a single combined message.
    var pendingMsgs = (rec.inbox || []).slice();
    // FIX #7: do NOT clear rec.inbox here. Clearing is deferred into the
    // delivery block below so the drained messages are discarded only once
    // delivery into chats[rec.chat_id] is guaranteed. Previously this cleared
    // unconditionally while delivery was gated on the chat row being present,
    // so a missing/GC'd chat transcript silently dropped the inbox forever.
    if (args.instruction) {
        pendingMsgs.push({ kind: 'instruction', from: 'parent', content: String(args.instruction), at: Date.now() });
    }
    // RES-6: a bare resurrection (no instruction, empty inbox) must still tell
    // the revived model WHY it is running again — and guarantees the resumed
    // transcript ends on a user turn (safe alternation after a mid-turn crash).
    if (_resurrectedFrom && pendingMsgs.length === 0) {
        pendingMsgs.push({
            kind: 'instruction', from: 'parent',
            content: '(resurrected via wake_sub_agent after state \'' + _resurrectedFrom + '\''
                + (rec.prev_error && rec.prev_error.message ? ' — previous run ended with: ' + rec.prev_error.message : '') // PR383-R3: last_error was archived to prev_error above
                + '. Continue the task from where you left off; do not redo completed work.)',
            at: Date.now()
        });
    }
    if (pendingMsgs.length > 0 && chats[rec.chat_id]) {
        // FIX #7: delivery is guaranteed here (chat row present), so it is now
        // safe to clear the inbox we snapshotted into pendingMsgs above. This
        // function runs synchronously, so no new inbox entries can have arrived
        // between the snapshot and this point. When the chat is missing this
        // block is skipped and rec.inbox is left intact for a later wake.
        rec.inbox = [];
        var combined = _formatInboxDrain(pendingMsgs);
        // F2: if a loop is already live for this sub (wake-with-instruction on
        // a still-running sub), a direct chat.messages push lands mid-turn and
        // breaks Anthropic's assistant→tool_result alternation (request 400s).
        // Mirror agent_message's live branch: stash into pendingInjectionsByChatId
        // (coalescing) so the running loop's flushPendingInjection consumes it
        // at a safe point. Only push directly when no loop is live.
        var _wakeLive = !!(_subPool.running[rec.agent_id]
            || (typeof runningChatIds !== 'undefined' && runningChatIds[rec.chat_id]));
        if (_wakeLive && typeof pendingInjectionsByChatId !== 'undefined') {
            var _wExisting = pendingInjectionsByChatId[rec.chat_id];
            var _wPrev = (_wExisting && _wExisting.text) ? _wExisting.text + '\n\n' : '';
            pendingInjectionsByChatId[rec.chat_id] = {
                text: _wPrev + combined,
                images: (_wExisting && _wExisting.images) ? _wExisting.images : []
            };
        } else {
            chats[rec.chat_id].messages.push({ role: 'user', content: combined });
        }
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    }

    // PR383-R2: a SW killed mid-approval strands the persisted
    // _pending_approvals counter >= 1 (its only decrements are the live
    // approved/denied/aborted callbacks in worker/120-tool-routing.js), which
    // permanently suppresses onSubApprovalEvent's `=== 1` park-notice gate.
    // A wake (normal or resurrect — this point is common to both) starts a
    // fresh run, so no approval episode can carry across it: reset.
    rec._pending_approvals = 0;
    rec.state = 'running';
    rec.last_activity_at = Date.now();
    if (typeof pausedChats !== 'undefined') delete pausedChats[rec.chat_id];
    _subAgentsPersist(rec);

    // Re-arm the live parent card: a woken sub is RUNNING again, but its card
    // was finalized terminal by the previous report. Without this the card
    // keeps saying "done" while the sub is visibly working again (the stored
    // terminal status is authoritative in _subReportLiveStatus). Archive the
    // completed phase as a clean input/report/progress triple on msg.phases
    // so the renderer (renderSubReport, 175-sub-agent-ui.js) can show per-
    // phase input→output pairs, then flip the card back to running (spinner
    // resumes) with the wake instruction as the new current input.
    try {
        var _wkCard = _findSubAgentCard(rec.parent_chat_id, rec.agent_id);
        if (_wkCard && _wkCard.report && _wkCard.report.status !== 'running') {
            // Input shown for the phase being closed: the previous wake's
            // instruction if there was one, else the original spawn
            // instructions (first phase).
            var _wkPrevInput = _wkCard.currentInput
                || (_wkCard.spawnArgs && _wkCard.spawnArgs.instructions) || '';
            _wkCard.phases = Array.isArray(_wkCard.phases) ? _wkCard.phases : [];
            // REG374-2: stable per-phase id so the renderer's expand/collapse
            // pref keys (175-sub-agent-ui.js) survive the 10-phase cap's
            // shift() — index-derived keys migrated to the wrong phase. Reuse
            // report.at when present; bump on collision (two wakes in one ms).
            var _wkPhId = (_wkCard.report && _wkCard.report.at) || Date.now();
            while (_wkCard.phases.some(function(p) { return p && p.id === _wkPhId; })) _wkPhId++;
            _wkCard.phases.push({
                id: _wkPhId,
                input: _wkPrevInput,
                // REG374-1: archive a SLIM report copy — the phase renderer
                // (175-sub-agent-ui.js) only reads status + summary (and `at`
                // feeds the REG374-2 phase id). Archiving the full report
                // object persisted uncapped data/artifacts payloads into
                // every card via saveChatsToStorage (up to 10 phases each).
                report: _wkCard.report ? { status: _wkCard.report.status, summary: _wkCard.report.summary, at: _wkCard.report.at } : null,
                progress: Array.isArray(_wkCard.progress) ? _wkCard.progress : [],
                // The 50-entry trim counter belongs to the phase whose
                // stream was trimmed — archive it and reset below so the
                // new phase doesn't show a phantom '[N truncated]' stub.
                progressDropped: _wkCard.progressDropped | 0,
                // The sub's last update_action_state card belongs to the
                // phase it was posted in — archive it and reset below so the
                // new phase doesn't open showing the previous run's stale
                // task list.
                actionState: _wkCard.actionState || null
            });
            // Bound storage like the 50-entry progress cap in agentMessage:
            // keep at most 10 archived phases, drop the oldest, and count
            // the trimmed ones so the renderer can show a stub line.
            while (_wkCard.phases.length > 10) {
                _wkCard.phases.shift();
                _wkCard.phasesDropped = (_wkCard.phasesDropped || 0) + 1;
            }
            // New current input: what the sub actually receives, else a
            // '(resumed)' marker (pure re-queue wake).
            // Same generous 64KB safety cap as the spawn-time card
            // instructions — full text is shown (the panel collapses/expands),
            // the cap only guards against runaway megabyte payloads.
            // REG374-3: when a wake carries an instruction AND the inbox had
            // pending messages, the sub receives the COMBINED drain text
            // (args.instruction was pushed into pendingMsgs above) — record
            // that, not just the bare instruction. The bare instruction is
            // shown only when it is the sole message.
            var _wkInput = pendingMsgs.length
                ? (pendingMsgs.length === 1 && args.instruction ? String(args.instruction) : _formatInboxDrain(pendingMsgs))
                : '(resumed)';
            if (_wkInput.length > 65536) _wkInput = _wkInput.slice(0, 65536) + '\n…[truncated]';
            _wkCard.currentInput = _wkInput;
            _wkCard.progress = [];
            _wkCard.progressDropped = 0;
            _wkCard.actionState = null;
            _wkCard.report = { status: 'running', summary: '', from: rec.agent_id, from_name: rec.name, at: Date.now() };
            _repaintParent(rec.parent_chat_id);
        }
    } catch (_) { /* ignore */ }
    // Registry-side counterpart of the card reset above: a woken sub starts a
    // fresh phase, so agent_status must not keep reporting the previous run's
    // progress card. Unconditional (the card may be missing/GC'd) and
    // persisted immediately so a reload can't resurrect the stale snapshot.
    if (rec.action_state) {
        rec.action_state = null;
        _subAgentsPersist(rec);
    }

    // Re-queue. The pool will start runAgent if there's a slot.
    // Dedupe against the queue too — without this, repeated wakes (e.g. on
    // every inbox auto-wake from agent_message) would stack duplicates and
    // the pool drain could fire two loops on the same chat.
    if (!_subPool.running[rec.agent_id] && _subPool.queue.indexOf(rec.agent_id) === -1) {
        _subPool.queue.push(rec.agent_id);
    }
    _drainPool();

    // Mint a fresh spawn handle if the previous one already settled, so the
    // caller can `await_handle` the next report. For internal cascades (the
    // agentMessage auto-wake path) we still mint — the sub→parent agent_message
    // arm reads the new handle off the record and returns it on the parent's
    // call. Either way the parent ends up with an awaitable handle for the
    // resumed run, fixing the "wake_sub_agent returns no handle, must poll"
    // limitation.
    var newHandleId = _mintNewSpawnHandle(rec);
    // RES-6: an UNSOLICITED wake — a caller other than the sub's own parent
    // chat (e.g. the root chat reviving a grandchild) — is invisible to the
    // direct parent without a notice. Parent-driven wakes (the common case)
    // and internal cascades are deliberately silent (no self-notification).
    if (!isInternalCascade && _wakeCallerChatId && _wakeCallerChatId !== rec.parent_chat_id) {
        _notifySubLifecycle(rec, (_resurrectedFrom ? 'resurrected from \'' + _resurrectedFrom + '\'' : 'woken') + ' by a caller outside its parent chat (' + _wakeCallerChatId + ')');
    }
    _notifyListeners();
    return { success: true, ok: true, state: 'running', handle: newHandleId, resurrected_from: _resurrectedFrom || undefined };
}

// Mint a fresh spawn handle for a sub that has already settled its previous
// handle (typical case: sub called report_to_parent, parent collected the
// result, parent now wakes the sub with a follow-up). Without this, the parent
// has no handle to `await_handle` on the next report — it would have to poll
// `agent_status` for `last_report` to change. Returns the new handle id, or
// the existing one if it's still pending (no need to mint a second one).
//
// Idempotent and side-effect-light: persists the updated record so a crash
// before the next report doesn't orphan the handle.
function _mintNewSpawnHandle(rec) {
    if (!rec) return null;
    // Existing handle still pending? Reuse it.
    if (_spawnDeferreds[rec.spawn_handle_id]) return rec.spawn_handle_id;
    if (typeof Handles === 'undefined' || !Handles.start) return rec.spawn_handle_id;
    var newDeferred = _makeDeferred();
    var displayName = 'spawn_sub_agent: ' + (rec.name || rec.agent_id) + ' (resumed)';
    var started = Handles.start(
        rec.parent_chat_id,
        'spawn_sub_agent',
        rec.spawn_args || {},
        displayName,
        function() { return newDeferred.promise; }
    );
    var newHid = started.handleId;
    _spawnDeferreds[newHid] = newDeferred;
    rec.spawn_handle_id = newHid;
    // F7: re-register the fresh handle as pending so agent_status reflects it.
    // _resolveSpawnHandle prunes the settled id from pending_handles, so a woken
    // sub would otherwise report pending_handles:0 despite having a live handle.
    if (!Array.isArray(rec.pending_handles)) rec.pending_handles = [];
    if (rec.pending_handles.indexOf(newHid) === -1) rec.pending_handles.push(newHid);
    _subAgentsPersist(rec);
    return newHid;
}

function _formatInboxDrain(items) {
    var lines = ['[' + items.length + ' message(s) from parent / inbox]'];
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var label = it.kind === 'instruction' ? 'instruction' : (it.kind || 'message');
        lines.push('- (' + label + ') ' + (it.content || ''));
    }
    return lines.join('\n');
}

// ---------- agent_message ----------

function agentMessage(args, ctx) {
    args = args || {};
    var to = args.to;
    var content = String(args.content || '');
    if (!to || !content) {
        return { success: false, error: 'agent_message: `to` and `content` are required.' };
    }
    var fromChatId = (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    var fromIsSub = !!(typeof chats !== 'undefined' && chats[fromChatId] && chats[fromChatId].isSubAgent);

    // Resolve recipient. 'parent' from a sub means push to that sub's parent chat
    // (as a sub_report-lite — kind=status update, not terminal). Otherwise `to`
    // is an agent_id.
    if (to === 'parent') {
        if (!fromIsSub) return { success: false, error: 'agent_message: only sub-agents can send to "parent".' };
        var rec = _subAgents[chats[fromChatId].subAgentId];
        if (!rec) return { success: false, error: 'agent_message: sub record missing.' };
        if (chats[rec.parent_chat_id]) {
            // See terminal-report path above: subChatId is persisted on the
            // row so the "open transcript" link survives registry GC.
            // Append to the live card's progress stream (created at spawn) so
            // mid-flight updates accumulate in ONE evolving row instead of
            // spawning a fresh callout per message. Legacy fallback: append a row.
            var _pcard = _findSubAgentCard(rec.parent_chat_id, rec.agent_id);
            // Bound the persisted progress stream: each entry is capped at 4KB
            // and the array at 50 entries. A chatty sub pushing huge updates
            // used to grow the parent chat's storage without bound AND make
            // every renderSubReport repaint re-render the full backlog. When
            // the cap trims old entries, progressDropped counts them so the
            // renderer (175-sub-agent-ui.js) can show a single
            // '[N earlier updates truncated]' stub instead.
            var _ptext = String(content);
            if (_ptext.length > 4096) _ptext = _ptext.slice(0, 4096) + '… [truncated]';
            var _entry = { text: _ptext, at: Date.now() };
            if (_pcard) {
                if (!Array.isArray(_pcard.progress)) _pcard.progress = [];
                _pcard.progress.push(_entry);
                while (_pcard.progress.length > 50) {
                    _pcard.progress.shift();
                    _pcard.progressDropped = (_pcard.progressDropped || 0) + 1;
                }
            } else {
                chats[rec.parent_chat_id].messages.push({
                    role: 'sub_report',
                    subAgentId: rec.agent_id,
                    subAgentName: rec.name,
                    subChatId: rec.chat_id,
                    progress: [_entry],
                    report: { status: 'running', summary: '', from: rec.agent_id, from_name: rec.name, at: Date.now() },
                    createdAt: Date.now()
                });
            }
            _repaintParent(rec.parent_chat_id);
        }
        rec.last_activity_at = Date.now();
        _subAgentsPersist(rec);
        _notifyListeners();
        return { success: true, ok: true };
    }

    // Recipient is a specific agent_id (parent → sub OR sibling → sibling
    // via the parent's authority).
    var dst = _subAgents[to];
    if (!dst) return { success: false, error: 'agent_message: unknown recipient agent_id ' + to };
    if (dst.state === 'stopped' || dst.state === 'errored') {
        // RES-6: point callers at the resurrection path instead of a dead end.
        return { success: false, error: 'agent_message: recipient is ' + dst.state + '. Use wake_sub_agent to resurrect it with its full prior context (optionally passing your message as `instruction`).' };
    }
    // ACL gate (Phase 5). Caller may only message subs in its own subtree.
    var _msgCallerAgentId = fromIsSub ? chats[fromChatId].subAgentId : null;
    if (!_callerOwnsTarget(fromChatId, _msgCallerAgentId, dst)) {
        return { success: false, error: 'agent_message: ACL denied — caller does not own recipient\'s subtree.', _acl_denied: true };
    }

    var wake = (args.wake === false) ? false : true;
    var item = { kind: 'message', from: fromIsSub ? chats[fromChatId].subAgentId : 'parent', content: content, at: Date.now() };

    // Cap the inbox so a runaway parent/sibling can't OOM the registry.
    // Applies on the sleeping-recipient branch below. (For 'running'
    // recipients we push directly to chat.messages and the model context
    // window is the natural backstop.)
    if (dst.state === 'running') {
        // Sub is in `running` state, but the agent loop may or may not be
        // alive: it could be (a) actively running mid-turn (in _subPool.running
        // or with runningChatIds set), or (b) queued waiting for a pool slot.
        //
        // BUG FIX (Anthropic 400s): a naive push to chat.messages mid-turn
        // (when the last assistant emitted `tool_calls` and tool_result
        // placeholders are mid-execution) breaks Anthropic’s strict
        // assistant→tool_result alternation — the request 400s before the
        // sub can finish. Route through pendingInjectionsByChatId so the
        // running loop’s flushPendingInjection picks it up at a SAFE point
        // (post tool_result batch, pre next API call). For the queued /
        // queued/idle cases the loop isn’t running yet, so a direct
        // chat.messages push is fine.
        var live = !!(_subPool.running[dst.agent_id]
            || (typeof runningChatIds !== 'undefined' && runningChatIds[dst.chat_id]));
        var combined = _formatInboxDrain([item]);
        if (live) {
            // Merge with existing pending text if any (multiple agent_messages
            // arriving back-to-back coalesce into a single user turn).
            try {
                if (typeof pendingInjectionsByChatId !== 'undefined') {
                    var existing = pendingInjectionsByChatId[dst.chat_id];
                    var prevText = (existing && existing.text) ? existing.text + '\n\n' : '';
                    pendingInjectionsByChatId[dst.chat_id] = {
                        text: prevText + combined,
                        images: (existing && existing.images) ? existing.images : []
                    };
                }
            } catch (_) { /* fall through to direct push */ }
        } else {
            // No live loop — queued or idle. Direct push is safe.
            if (chats[dst.chat_id]) {
                chats[dst.chat_id].messages.push({ role: 'user', content: combined });
                if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
            }
        }
        // Always queue (dedup) so the pool starts a loop if none is running.
        // BUG FIX (message-drop race): previously the alreadyLive branch did NOT
        // queue. If the live loop happened to exit naturally between the
        // push and our queue check, onSubAgentRunFinished would auto_report
        // the old assistant text and the parent’s message would silently
        // disappear. Queuing here is harmless when alreadyLive (_drainPool
        // skips subs whose runningChatIds is set); when the loop later
        // releases the slot, drain picks up our entry and a fresh runAgent
        // sees the pendingInjection / unconsumed user message.
        if (!_subPool.running[dst.agent_id] && _subPool.queue.indexOf(dst.agent_id) === -1) {
            _subPool.queue.push(dst.agent_id);
        }
    } else {
        // Sleeping — enqueue. wake_sub_agent (or auto-wake below) drains it.
        dst.inbox = dst.inbox || [];
        dst.inbox.push(item);
        // Cap with oldest-dropped marker so the wake-drain stays bounded.
        if (dst.inbox.length > SUBAGENT_INBOX_CAP) {
            var dropCount = dst.inbox.length - SUBAGENT_INBOX_CAP + 1;
            dst.inbox = dst.inbox.slice(dropCount);
            dst.inbox.unshift({
                kind: 'dropped',
                from: 'registry',
                content: '[' + dropCount + ' earlier message(s) dropped — inbox cap (' + SUBAGENT_INBOX_CAP + ') reached]',
                at: Date.now()
            });
        }
    }
    dst.last_activity_at = Date.now();
    _subAgentsPersist(dst);

    // RES-6: an UNSOLICITED message — a caller other than the recipient's own
    // parent chat (e.g. the root chat messaging a grandchild) — is invisible
    // to the direct parent without a notice. Parent-driven messages (the
    // common case) are deliberately silent.
    if (fromChatId && fromChatId !== dst.parent_chat_id) {
        _notifySubLifecycle(dst, 'received a message from a caller outside its parent chat (' + fromChatId + ')');
    }

    var _newHandle = null;
    if (dst.state === 'sleeping' && wake) {
        // Auto-wake. Drain the inbox into a combined user message and
        // re-queue. We reuse wakeSubAgent so the bookkeeping is identical.
        // Internal auto-wake on inbox push — bypass ACL since we already
        // verified the caller owns the target above.
        var _wakeRes = _wakeSubAgentImpl({ agent_id: dst.agent_id }, ctx, true);
        // PR390-FU-2: don't lie about a failed wake. The message IS queued in
        // the inbox either way (pushed above), but if the wake refused — e.g.
        // the FIX-2 winding-down guard, or any future failure mode — returning
        // success:true with a (possibly settled) handle hid the stall from the
        // caller. Surface the failure + retryable flag so the model retries
        // the wake; keep success:true because the queueing itself succeeded.
        if (_wakeRes && _wakeRes.success === false) {
            console.warn('[sub-agents] agent_message auto-wake refused for', dst.agent_id, _wakeRes.error);
            _notifyListeners();
            var _failOut = { success: true, ok: true, queued: true, wake_failed: _wakeRes.error || 'wake refused' };
            if (_wakeRes.retryable) _failOut.retryable = true;
            return _failOut;
        }
        // _wakeSubAgentImpl mints a fresh spawn handle if the previous one
        // had settled. Surface it so the parent's agent_message call returns
        // an awaitable handle for the resumed run — same convenience as
        // calling wake_sub_agent directly. If the previous handle is still
        // pending, we surface its id too so the caller has a single field
        // to await regardless of state.
        _newHandle = (_wakeRes && _wakeRes.handle) || dst.spawn_handle_id || null;
    } else if (dst.state === 'running') {
        _drainPool();
        // Surface an awaitable handle for the in-flight run, matching the
        // sleeping-recipient branch and the documented "response includes a
        // handle the parent can await_handle" contract. Reuses the pending
        // spawn handle (or mints a fresh one if the previous already settled).
        _newHandle = _mintNewSpawnHandle(dst);
    }
    _notifyListeners();
    var out = { success: true, ok: true };
    if (_newHandle) out.handle = _newHandle;
    return out;
}

// ---------- stop_sub_agent ----------

// Cascade-terminate every descendant of `rec` (deepest first, via
// _descendants ordering). Shared by stop_sub_agent, the budget-exhaustion
// path, and _markErrored so that a parent sub going terminal for ANY reason
// (explicit stop, budget exhausted, crash) never orphans its grandchildren.
// Orphaned descendants would otherwise keep burning pool slots, report into a
// now-dead chat, and leave their spawn handles hanging. Runs as an internal
// cascade (ACL bypassed; ctx is unused by the internal path).
function _cascadeStopDescendants(rec, reason) {
    if (!rec) return;
    var kids = _descendants(rec.agent_id);
    for (var i = 0; i < kids.length; i++) {
        var kidRec = _subAgents[kids[i]];
        if (!kidRec || kidRec.state === 'stopped' || kidRec.state === 'errored') continue;
        try {
            _stopSubAgentImpl({ agent_id: kids[i], reason: reason }, null, true);
        } catch (e) { console.warn('cascade-stop: failed for', kids[i], e); }
    }
}

function stopSubAgent(args, ctx) {
    return _stopSubAgentImpl(args, ctx, false);
}

// Internal cascade entry point — see _wakeSubAgentImpl above for the
// rationale. The positional `isInternalCascade` flag replaces the previous
// `args._internal_cascade` mechanism, which was reachable by the model.
function _stopSubAgentImpl(args, ctx, isInternalCascade) {
    args = args || {};
    var rec = _subAgents[args.agent_id];
    if (!rec) return { success: false, error: 'stop_sub_agent: unknown agent_id ' + args.agent_id };
    if (rec.state === 'stopped' || rec.state === 'errored') {
        return { success: true, ok: true, status: rec.state, note: 'already terminal' };
    }
    // ACL gate (Phase 5). A sub can only stop its own descendants; a regular
    // chat can only stop subs whose root_chat_id is itself.
    if (!isInternalCascade) {
        // F1: fail closed (see wake_sub_agent). Resolve caller chat-id via the
        // standard fallback chain and enforce the ACL unconditionally — an
        // unresolved caller no longer bypasses the subtree-ownership check.
        var _callerChatId = (ctx && ctx.chatId)
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        var _callerAgentId = (_callerChatId && typeof chats !== 'undefined'
            && chats[_callerChatId] && chats[_callerChatId].isSubAgent)
            ? chats[_callerChatId].subAgentId : null;
        if (!_callerOwnsTarget(_callerChatId, _callerAgentId, rec)) {
            return { success: false, error: 'stop_sub_agent: ACL denied — caller does not own this sub-agent\'s subtree.', _acl_denied: true };
        }
    }
    // Cascade-stop descendants first (leaves before internal nodes via
    // _descendants ordering). Without this, grandchildren orphan when their
    // parent sub is stopped: they keep burning pool slots, their reports go
    // to a dead chat, and their handles never settle.
    _cascadeStopDescendants(rec, 'parent sub-agent stopped: ' + (args.reason || rec.name));
    var reason = args.reason || 'stopped by parent';
    rec.state = 'stopped';
    // SA-STOP-CANCEL (BUGFIX): mark this as an intentional, user-initiated stop
    // BEFORE the abort/handle settlement below. The aborted run loop will still
    // reach onSubAgentRunFinished; without this flag its auto_report branch can
    // synthesize a 'done' report and overwrite the 'cancelled' settlement made
    // here (notably when a prior wake re-armed the spawn deferred, defeating the
    // !_spawnDeferreds guard). onSubAgentRunFinished early-returns on this flag.
    rec._stoppedByUser = true;
    rec.settled_at = Date.now();
    rec.last_activity_at = rec.settled_at;
    if (!rec.last_report) {
        rec.last_report = { status: 'error', summary: reason, from: rec.agent_id, from_name: rec.name, at: rec.settled_at };
    }
    _subAgentsPersist(rec);

    // Cancel every pending handle owned by the sub's chat. Previously this
    // iterated `rec.pending_handles`, which is initialized to [spawn_handle_id]
    // and never appended to — so the loop body's `continue` skipped the only
    // entry and no handle was ever cancelled. Background fetches / iframe
    // calls would survive stop_sub_agent and their results would still land
    // in the registry. The correct source of truth is the Handles registry
    // itself, scoped to the sub's chat id.
    if (typeof Handles !== 'undefined' && typeof Handles.list === 'function') {
        try {
            var live = Handles.list(rec.chat_id) || [];
            for (var i = 0; i < live.length; i++) {
                var h = live[i];
                if (!h || h.status !== 'pending') continue;
                if (h.handle === rec.spawn_handle_id) continue; // resolved separately, see below
                try { Handles.cancel(rec.chat_id, h.handle, reason); } catch (e) { console.warn('stop_sub_agent: cancel failed for', h.handle, e); }
            }
        } catch (e) { console.warn('stop_sub_agent: Handles.list failed', e); }
    }
    // Resolve the spawn handle with `cancelled`.
    _resolveSpawnHandle(rec.agent_id, { status: 'cancelled', summary: reason, from: rec.agent_id });

    // Finalize the live parent card so its spinner stops and it reads cancelled.
    _finalizeSubAgentCard(rec, { status: 'cancelled', summary: reason, from: rec.agent_id, from_name: rec.name, at: Date.now() });

    // Signal the live runAgent loop to halt at its next pause check.
    if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
    _releasePoolSlot(rec.agent_id);
    _notifyListeners();
    return { success: true, ok: true, status: 'stopped', reason: reason };
}

// ---------- Pool-deadlock prevention (Phase 5) ----------
//
// A sub-agent that calls `await_handle` on a spawn handle for one of its
// own descendants will block its own runAgent loop while still occupying a
// pool slot. With pool size = 2, two concurrent nested awaits = global
// deadlock (no slot free for the grandchildren to actually start).
//
// The dispatch arm in tools/020-tool-execution.js calls `parkForAwait`
// before `Handles.await` and `unparkAfterAwait` after. Park releases the
// pool slot (kicking the drain so a queued sub can start) without changing
// the sub's state — from the UI's perspective the sub is still 'running',
// just temporarily blocked on I/O. Unpark re-admits to the pool, even if
// at-cap (soft over-cap), so the awaiting sub can immediately resume
// processing its tool result.
function parkForAwait(agentId) {
    var rec = _subAgents[agentId];
    if (!rec) return false;
    if (!_subPool.running[agentId]) return false; // not in pool, nothing to park
    delete _subPool.running[agentId];
    rec._parked_for_await = (rec._parked_for_await || 0) + 1;
    // Drain so any queued sub can take our slot. _drainPool already calls
    // _notifyListeners on its own — but explicitly fire too so the
    // `in_pool_running` / `parked_for_await` snapshots flip in the UI
    // even if _drainPool finds nothing queued and short-circuits.
    _drainPool();
    _notifyListeners();
    return true;
}

function unparkAfterAwait(agentId) {
    var rec = _subAgents[agentId];
    if (!rec) return false;
    if (!rec._parked_for_await) return false;
    rec._parked_for_await -= 1;
    if (rec._parked_for_await <= 0) delete rec._parked_for_await;
    // Only re-admit if the sub is still in `running`. A 'sleeping' sub
    // shouldn't be parked in the first place (its loop is blocked on
    // Handles.await, which by definition keeps state='running') — but if
    // some future edge path lands here with state='sleeping' we must NOT
    // re-occupy a pool slot for it, because the loop isn't actually
    // executing. Terminal states (stopped/errored) are also ignored.
    if (rec.state === 'running') {
        _subPool.running[agentId] = true; // soft over-cap on resume — by design
    }
    _notifyListeners();
    return true;
}

// REG391-3 (shared single-retry arm): a TRANSIENT crash (network/fetch/
// timeout) gets ONE automatic retry before the sub is declared errored. The
// partial assistant turn was already popped by the loop's catch, so
// re-queueing simply replays the failed turn with the same context. The
// _retry_used latch caps it at one retry per crash; it resets on the next
// successful turn (onToolCallInSubAgent / clean finish / report_to_parent).
// The retry is logged visibly in the sub's transcript via an injected user
// row, which also guarantees the resumed run starts on a user turn.
// Extracted from onSubAgentRunFinished so _markErrored (the COMMON crash
// path: _drainPool → runAgent .catch) can take it too — previously it
// settled terminal unconditionally, making agent_status's promised
// auto-retry unreachable for pool-driven crashes.
function _queueTransientRetry(rec, errMsg) {
    rec._retry_used = true;
    rec.retries_used = (rec.retries_used || 0) + 1;
    rec.last_error = { message: errMsg || 'transient run error', at: Date.now(), transient: true, retried: true };
    try {
        if (chats[rec.chat_id] && Array.isArray(chats[rec.chat_id].messages)) {
            chats[rec.chat_id].messages.push({
                role: 'user', injected: true,
                content: '[sub-agent lifecycle] The previous turn crashed with a transient error ("' + (errMsg || 'network error') + '"). Automatic retry 1/1 — resume the task from where you left off; do not redo completed work.'
            });
            if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        }
    } catch (_) { /* best-effort log — the re-queue below still retries */ }
    rec.state = 'running';
    if (typeof pausedChats !== 'undefined') delete pausedChats[rec.chat_id];
    rec.last_activity_at = Date.now();
    _subAgentsPersist(rec);
    _releasePoolSlot(rec.agent_id);
    // PR383-R5: throttle-class errors (429/529/rate-limit/overloaded) get a
    // ~8s back-off before the re-queue — replaying immediately against a
    // provider that is shedding load burns the single retry for nothing.
    // KNOWN LIMITATION (accepted, low severity): an MV3 SW can be killed
    // before the timer fires, leaving state 'running' with nothing queued.
    // Recovery: (a) _retry_delayed_until is stamped on the record and
    // exposed via agent_status so the wait is observable; (b) the existing
    // cold-boot orphan-rewrite in loadAllSubAgents (worker ctx marks
    // 'running' records errored + resurrectable) reclaims exactly that
    // state on the next SW start.
    if (_isThrottleSubError(errMsg)) {
        rec._retry_delayed_until = Date.now() + 8000;
        _subAgentsPersist(rec);
        (function(capturedAid) {
            setTimeout(function() {
                var r2 = _subAgents[capturedAid];
                if (!r2) return;
                delete r2._retry_delayed_until;
                // Re-queue only if the sub is still waiting on this retry
                // (not stopped/restarted by a wake or user meanwhile).
                if (r2.state === 'running' && !_subPool.running[capturedAid]
                    && _subPool.queue.indexOf(capturedAid) === -1) {
                    _subPool.queue.push(capturedAid);
                    _drainPool();
                }
                _subAgentsPersist(r2);
                _notifyListeners();
            }, 8000);
        })(rec.agent_id);
    } else {
        if (_subPool.queue.indexOf(rec.agent_id) === -1) _subPool.queue.push(rec.agent_id);
        _drainPool();
    }
    _notifyListeners();
}

function _markErrored(agentId, errMsg) {
    var rec = _subAgents[agentId];
    if (!rec) return;
    if (rec.state === 'stopped' || rec.state === 'errored') return;
    // REG391-3: consult the transient single-retry latch BEFORE settling
    // terminal (and before cascade-stopping descendants — a retrying parent
    // keeps its children). _drainPool's .catch routes ALL pool-driven loop
    // crashes here, so without this arm the auto-retry in
    // onSubAgentRunFinished was unreachable for the common crash path.
    // state==='running' only: never restart a sleeping/parked record.
    if (rec.state === 'running' && _isTransientSubError(errMsg) && !rec._retry_used) {
        _queueTransientRetry(rec, errMsg);
        return;
    }
    // A crashing parent sub must cascade-stop its descendants, mirroring
    // stop_sub_agent and the budget path. Without this, grandchildren of a
    // crashed sub keep running, hold pool slots, and report into a dead chat.
    _cascadeStopDescendants(rec, 'parent sub-agent errored: ' + rec.name);
    rec.state = 'errored';
    rec.settled_at = Date.now();
    // RES-6: structured error diagnostics for agent_status / the parent.
    var _meTransient = _isTransientSubError(errMsg);
    // PR383-R3: unconditional — the old `crash_cause || 'run_error'` guard let
    // a stale pre-resurrect cause (e.g. 'budget_exhausted') survive a NEW
    // crash and corrupt diagnostics. Each terminal event owns these fields.
    rec.crash_cause = 'run_error';
    rec.last_error = { message: String(errMsg || 'sub-agent errored'), at: rec.settled_at, transient: _meTransient, retried: !!rec._retry_used };
    rec.last_report = rec.last_report || {
        status: 'error', summary: errMsg, from: rec.agent_id, from_name: rec.name, at: rec.settled_at,
        error: { message: rec.last_error.message, transient: _meTransient, retried: rec.last_error.retried, retryable: true, hint: 'resurrectable via wake_sub_agent (full prior context preserved)' }
    };
    _subAgentsPersist(rec);
    _finalizeSubAgentCard(rec, rec.last_report);
    var _meHadAwaiters = _spawnHandleHasAwaiters(rec); // P2: pre-settle sample
    _resolveSpawnHandle(agentId, { status: 'error', error: errMsg, summary: errMsg, from: rec.agent_id, error_info: { message: rec.last_error.message, transient: _meTransient, retried: rec.last_error.retried, retryable: true } });
    _releasePoolSlot(agentId);
    // RES-6: proactive parent notice — a crash is never parent-initiated.
    _notifySubLifecycle(rec, 'errored — ' + rec.last_error.message + ' (resurrectable via wake_sub_agent)');
    // P2: an idle parent must also be STARTED, not just notified — the notice
    // row above is invisible to the parent agent until a run consumes it.
    _wakeParentOnReport(rec, rec.last_report, { hadAwaiters: _meHadAwaiters, noticeDelivered: true });
    _notifyListeners();
}

// ---------- agent_status ----------

function agentStatus(args, ctx) {
    args = args || {};
    function snap(rec) {
        return {
            agent_id: rec.agent_id,
            chat_id: rec.chat_id,
            parent_chat_id: rec.parent_chat_id,
            parent_agent_id: rec.parent_agent_id,
            depth: rec.depth || 1,
            root_chat_id: rec.root_chat_id || rec.parent_chat_id,
            name: rec.name,
            state: rec.state,
            created_at: rec.created_at,
            last_activity_at: rec.last_activity_at,
            settled_at: rec.settled_at || null,
            tool_calls_used: rec.tool_calls_used || 0,
            max_tool_calls: rec.max_tool_calls,
            // P1d: whether the parent has collected the latest report via
            // await/poll — false after a restart means "undelivered report,
            // re-await the spawn handle (rehydrated) or read last_report here".
            report_collected: !!rec.report_collected,
            wake_parent: rec.wake_parent !== false,
            pending_handles: (rec.pending_handles || []).length,
            inbox_size: (rec.inbox || []).length,
            in_pool_running: !!_subPool.running[rec.agent_id],
            in_pool_queue: _subPool.queue.indexOf(rec.agent_id) >= 0,
            parked_for_await: !!rec._parked_for_await,
            last_report: rec.last_report || null,
            // The sub's live update_action_state progress card (state, label,
            // tasks checklist, output), mirrored by recordSubActionState.
            // Null until the sub posts its first update / after a wake reset.
            action_state: rec.action_state || null,
            // RES-6: lifecycle diagnostics. All fields tolerate legacy records
            // (missing → null/0/false) — backward-compatible with stored subs.
            last_error: rec.last_error || null,
            crash_cause: rec.crash_cause || null,
            // PR383-R3: pre-resurrect diagnostics history (archived by
            // _wakeSubAgentImpl when reviving a terminal sub).
            prev_error: rec.prev_error || null,
            prev_crash_cause: rec.prev_crash_cause || null,
            // PR383-R5: set while a throttle-class auto-retry is deliberately
            // delayed (~8s) before re-queueing; null once the timer fires.
            retry_delayed_until: rec._retry_delayed_until || null,
            retries_used: rec.retries_used || 0,
            // True when wake_sub_agent can REVIVE this sub with its full prior
            // chat context (terminal state + transcript still present).
            resurrectable: !!((rec.state === 'errored' || rec.state === 'stopped')
                && typeof chats !== 'undefined' && chats[rec.chat_id]),
            user_interactions: rec.user_interactions || null
        };
    }
    if (args.agent_id) {
        var rec = _subAgents[args.agent_id];
        if (!rec) return { success: false, error: 'unknown agent_id: ' + args.agent_id };
        return { success: true, agent: snap(rec) };
    }
    // List — optionally filter by parent_chat_id so the parent sees its own subs.
    // Explicit '*' returns every sub on the instance. Otherwise default to the
    // caller's own chat — if we can't resolve one and no explicit value was
    // given, return an empty list rather than leaking every sub.
    // Prefer the dispatcher-supplied ctx.chatId so worker / js_eval / nested
    // contexts (where activeStreamingChatId may diverge from the caller's
    // actual chat) get correctly scoped. Fall back to streaming / current.
    var parentChatId = args.parent_chat_id
        || (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    if (args.parent_chat_id !== '*' && !parentChatId) {
        return { success: true, agents: [], pool: { running: Object.keys(_subPool.running).length, queued: _subPool.queue.length, size: SUBAGENT_POOL_SIZE }, note: 'no parent chat context resolvable; pass parent_chat_id explicitly or "*" for all' };
    }
    var out = [];
    for (var aid in _subAgents) {
        var r = _subAgents[aid];
        // Phase 5 follow-up: return the FULL subtree (every descendant whose
        // root chat is the caller), not just direct children. Without this,
        // `agent_status({include_tree:true})` from a root chat hides every
        // grandchild — the documented "cross-level tree" the system prompt
        // advertises was empty in practice. Pass `parent_chat_id:'*'` for
        // the everything-on-the-instance escape hatch (unchanged).
        if (args.parent_chat_id !== '*') {
            var rRoot = r.root_chat_id || r.parent_chat_id;
            if (rRoot !== parentChatId && r.parent_chat_id !== parentChatId) continue;
        }
        out.push(snap(r));
    }
    // Sort: running first, then sleeping, then terminal; newest within group.
    var rank = { running: 0, sleeping: 1, stopped: 2, errored: 3 };
    out.sort(function(a, b) {
        var ra = rank[a.state] != null ? rank[a.state] : 4;
        var rb = rank[b.state] != null ? rank[b.state] : 4;
        if (ra !== rb) return ra - rb;
        return b.last_activity_at - a.last_activity_at;
    });
    var resp = { success: true, agents: out, pool: { running: Object.keys(_subPool.running).length, queued: _subPool.queue.length, size: SUBAGENT_POOL_SIZE } };
    // Optional tree assembly (Phase 5). When `include_tree:true`, attach a
    // parent_agent_id-keyed map of children agent_ids so callers can render
    // a hierarchy without re-walking the flat list. Top-level roots are
    // keyed under their `parent_chat_id` (no parent_agent_id).
    if (args.include_tree) {
        var tree = Object.create(null);
        for (var ti = 0; ti < out.length; ti++) {
            var key = out[ti].parent_agent_id || out[ti].parent_chat_id;
            if (!tree[key]) tree[key] = [];
            tree[key].push(out[ti].agent_id);
        }
        resp.tree = tree;
    }
    return resp;
}

// ---------- Hooks called by the agent loop ----------

// Called by 030-agent-loop.js whenever a tool call is dispatched inside a
// sub-agent chat. Increments the budget counter. The budget is a SOFT cap:
// once usage crosses SUBAGENT_BUDGET_WARN_RATIO (and on every call past
// the cap) a warning notice is staged on the record; the agent loop
// appends it to the next tool result via consumeBudgetNotice() so the
// model sees it inline and can wrap up + report_to_parent on its own.
// SAFETY BACKSTOP: past cap * SUBAGENT_BUDGET_HARD_MULT the sub is
// force-stopped (cascade-stop descendants, error-settle the parent's
// spawn handle, pause the chat, release the pool slot) and this returns
// false so the caller short-circuits — otherwise a model loop that
// ignores every warning would hold a pool slot and burn tokens forever.
// Returns true in every other case.
function onToolCallInSubAgent(chatId) {
    if (typeof chats === 'undefined' || !chats[chatId] || !chats[chatId].isSubAgent) return true;
    var rec = _subAgents[chats[chatId].subAgentId];
    if (!rec) return true;
    rec.tool_calls_used = (rec.tool_calls_used || 0) + 1;
    var now = Date.now();
    rec.last_activity_at = now;
    // RES-6: a dispatched tool call means the previous model turn completed
    // successfully — reset the per-crash auto-retry latch so a later
    // transient crash gets its own single retry (one retry max PER crash,
    // not per sub lifetime).
    // PR383-R3: also drop the recovered crash's last_error — leaving it set
    // let a later no_report / auto-report-disabled finish reuse the OLD
    // (already recovered) error in error_info and the parent notice.
    if (rec._retry_used) { delete rec._retry_used; rec.last_error = null; }
    var used = rec.tool_calls_used;
    var cap = rec.max_tool_calls;
    var ceiling = cap * SUBAGENT_BUDGET_HARD_MULT;
    if (used > ceiling) {
        var msg = 'Sub-agent ' + rec.name + ' ran to ' + used + ' tool calls — past the hard ceiling ('
            + ceiling + ' = ' + SUBAGENT_BUDGET_HARD_MULT + '\u00d7 max_tool_calls of ' + cap
            + ') — ignoring every budget warning. Force-stopped.';
        // Same termination path as the pre-soft-cap hard stop: cascade-stop
        // descendants so grandchildren are never orphaned, finalize the live
        // card, error-settle the spawn handle so the parent's await_handle
        // returns, pause the chat, and release the pool slot.
        _cascadeStopDescendants(rec, 'parent sub-agent exceeded hard tool-budget ceiling: ' + rec.name);
        rec.state = 'stopped';
        rec.settled_at = now;
        rec.last_report = rec.last_report || { status: 'error', summary: msg, from: rec.agent_id, from_name: rec.name, at: rec.settled_at };
        // RES-6: structured diagnostics + proactive parent notice (the parent
        // did not initiate this stop — the registry's backstop did).
        rec.crash_cause = 'budget_exhausted';
        rec.last_error = { message: msg, at: now, transient: false, retried: false };
        _subAgentsPersist(rec);
        _finalizeSubAgentCard(rec, rec.last_report);
        var _btHadAwaiters = _spawnHandleHasAwaiters(rec); // P2: pre-settle sample
        _resolveSpawnHandle(rec.agent_id, { status: 'error', error: 'budget_exhausted', summary: msg, from: rec.agent_id, error_info: { message: msg, transient: false, retried: false, retryable: true } });
        _notifySubLifecycle(rec, 'force-stopped — hard tool-budget ceiling exceeded (' + used + ' calls). Resurrectable via wake_sub_agent if you want it to wrap up.');
        if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
        _releasePoolSlot(rec.agent_id);
        // P2: error report — wake an idle parent (notice already delivered above).
        _wakeParentOnReport(rec, rec.last_report, { hadAwaiters: _btHadAwaiters, noticeDelivered: true });
        _notifyListeners();
        return false;
    }
    if (used > cap) {
        rec._budget_notice = '\u26d4 [BUDGET EXCEEDED] You have used ' + used
            + ' tool calls (budget: ' + cap + '). STOP exploratory work NOW. '
            + 'Finish the absolute minimum remaining steps (batch them in a single js_eval if possible) '
            + 'and call report_to_parent immediately with what you have, flagging anything left undone. '
            + 'You will be force-stopped at ' + ceiling + ' calls.';
    } else if (used >= Math.ceil(cap * SUBAGENT_BUDGET_WARN_RATIO)) {
        rec._budget_notice = '\u26a0\ufe0f [BUDGET WARNING] You have used ' + used + ' of ' + cap
            + ' tool calls (' + Math.round(used * 100 / cap) + '%). Wrap up soon: batch remaining work '
            + 'into js_eval calls and call report_to_parent before the budget runs out.';
    }
    _subAgentsPersist(rec);
    // Throttled UI heartbeat so the live used/cap counter in the sub-agent
    // panel ticks during a run (state transitions notify unconditionally
    // elsewhere; without this the counter only refreshed on transitions).
    if (!rec._lastHeartbeatNotifyAt || now - rec._lastHeartbeatNotifyAt > 1000) {
        rec._lastHeartbeatNotifyAt = now;
        _notifyListeners();
    }
    return true;
}

// Returns and clears any staged budget notice for the sub-agent owning
// `chatId`. Called by the agent loop right after a tool result is
// processed, so the notice rides along inside the tool-result content the
// model reads next turn. Returns null for non-sub chats / no notice.
function consumeBudgetNotice(chatId) {
    if (typeof chats === 'undefined' || !chats[chatId] || !chats[chatId].isSubAgent) return null;
    var rec = _subAgents[chats[chatId].subAgentId];
    if (!rec || !rec._budget_notice) return null;
    var n = rec._budget_notice;
    rec._budget_notice = null;
    return n;
}

// Called by 030-agent-loop.js when runAgent finishes naturally (the model
// produced a final assistant message with no further tool calls). If the
// sub never called report_to_parent + auto_report is on, synthesize a
// fallback report from the last assistant message so the parent's handle
// always settles.
function onSubAgentRunFinished(chatId, finishCtx) {
    if (typeof chats === 'undefined' || !chats[chatId] || !chats[chatId].isSubAgent) return;
    var rec = _subAgents[chats[chatId].subAgentId];
    if (!rec) return;
    // PR383-R2: run completion ends every approval episode for this run —
    // reset the gate counter so a stranded value (SW killed mid-approval,
    // decrement callbacks never fired) can't mute future park notices.
    // PR384-FIX-6: but a sub can park via report_to_parent while an await:false
    // tool call is STILL awaiting approval — that approval belongs to the HANDLE,
    // not the loop. Zeroing the counter here re-opens onSubApprovalEvent's
    // `=== 1` park-notice gate, so the next 'requested' event re-emits a park
    // notice while the old approval is still pending. Only reset when no handle
    // for this chat is genuinely awaiting approval.
    var _approvalParked = false;
    if (typeof Handles !== 'undefined' && typeof Handles.list === 'function') {
        try {
            var _hlist = Handles.list(chatId) || [];
            for (var _hi = 0; _hi < _hlist.length; _hi++) {
                if (_hlist[_hi] && _hlist[_hi].status === 'pending' && _hlist[_hi].awaitingApproval) {
                    _approvalParked = true; break;
                }
            }
        } catch (_e6) { /* unreachable Handles — fall back to resetting */ }
    }
    if (!_approvalParked) rec._pending_approvals = 0;
    // finishCtx (optional, supplied by agent-loop) signals whether the run
    // ended in an API/loop error. If so, the auto_report fallback below
    // synthesizes status:'error' instead of status:'done' to avoid lying
    // to the parent.
    var _runErrored = !!(finishCtx && finishCtx.reason === 'errored');
    var _runErrorMsg = (finishCtx && finishCtx.error && (finishCtx.error.message || String(finishCtx.error))) || '';
    // RES-6: classify the crash for the auto-retry path + structured report.
    var _runErrTransient = _runErrored ? _isTransientSubError(_runErrorMsg) : false;
    // A clean (non-errored) finish completes the turn — reset the per-crash
    // retry latch (belt-and-braces with the onToolCallInSubAgent reset).
    if (!_runErrored && rec._retry_used) { delete rec._retry_used; rec.last_error = null; } // PR383-R3: drop the recovered error too
    // CRITICAL: do NOT release the pool slot up-front. The wake-during-
    // finish race can install a NEW runAgent loop for the same agent_id
    // in the window between runningChatIds being cleared by the agent
    // loop (030-agent-loop.js:928) and this hook running (line 952).
    // In that case _subPool.running[aid] is true, owned by the new loop;
    // releasing it here would leak the slot (over-release decrements to
    // zero while the new loop is still running). Instead, gate every
    // exit branch on (a) deferred still present, (b) no replacement
    // loop already claimed, and release the slot only where appropriate.
    if (!_spawnDeferreds[rec.spawn_handle_id]) {
        // Already settled (report_to_parent done/error or stop). Release
        // our slot — a non-racy case because state is terminal.
        _releasePoolSlot(rec.agent_id);
        return;
    }
    if (_subPool.running[rec.agent_id] && (typeof runningChatIds !== 'undefined' && runningChatIds[chatId])) {
        // A replacement loop is actively running for this same sub. We
        // are the OLD loop's finish hook — stand down silently. Don't
        // touch the slot, don't synthesize a report.
        return;
    }
    // NOTE: Previously had a second guard here on `_subPool.running[aid]` alone
    // that bailed if the slot was claimed but runningChatIds was not yet set.
    // That guard was unreachable for a real race — drain claims the slot AND
    // schedules runAgent via Promise.resolve().then(), and microtasks cannot
    // run during this hook's synchronous execution. The only path that hit it
    // was the natural-finish path (slot still owned by us, the just-exited
    // loop), where it caused auto_report to never run and the parent's
    // spawn handle to hang forever. The line-1063 queue check below covers
    // the genuine wake-during-finish-pre-drain case.

    // sleep_self path: the sub explicitly paused itself. Don't synthesize
    // a `done` over a sleeping sub — the parent is expected to either
    // wake it (new instructions) or stop it. Without this guard the
    // parent's spawn handle resolves with a misleading auto-`done` even
    // though the sub never produced a terminal report.
    // SA-STOP-CANCEL (BUGFIX): a user-initiated stop_sub_agent already set
    // rec.state='stopped' / rec._stoppedByUser and settled the spawn handle as
    // 'cancelled'. The !_spawnDeferreds guard above covers the common case, but
    // if a prior wake re-armed the spawn deferred (re-await), it no longer
    // fires — so without this branch the auto_report path below would
    // synthesize a 'done' report and overwrite the 'cancelled' settlement.
    // Never auto-report over a sub that was stopped by the user or is terminal.
    if (rec.state === 'stopped' || rec.state === 'errored' || rec._stoppedByUser) {
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        // BUG1-NIT: narrow re-arm race — if a prior stop already resolved the
        // previous spawn deferred, then a wake re-armed a NEW deferred which is
        // STILL present here, returning now would leave it unsettled and a parent
        // await would hang. Settle it as 'cancelled' (mirrors the user-stop
        // settlement) before standing down.
        if (_spawnDeferreds[rec.spawn_handle_id]) {
            _resolveSpawnHandle(rec.agent_id, { status: 'cancelled', summary: rec.last_report && rec.last_report.summary, from: rec.agent_id });
        }
        _notifyListeners();
        return;
    }

    if (rec.state === 'sleeping') {
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        _notifyListeners();
        return;
    }

    // Wake-during-finish (queued, not yet claimed): a parent/sibling called
    // wake_sub_agent while the old loop was wrapping up, the wake re-
    // queued the sub with state='running', and _drainPool hasn't picked
    // it up yet (could be a microtask away). Stand down and re-drain so
    // the new loop actually fires.
    if (rec.state === 'running' && _subPool.queue.indexOf(rec.agent_id) >= 0) {
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        _drainPool();
        _notifyListeners();
        return;
    }

    // BUG FIX (message-drop race): an agent_message arriving while the
    // loop was on its final no-tool-call turn would push a user message
    // (or stash pendingInjection) AFTER the loop had already decided to
    // exit. Without this guard the auto_report below would synthesize a
    // `done` from the stale last assistant turn and the parent’s message
    // would never be consumed. Detect both cases (unconsumed trailing
    // user message OR a non-empty pendingInjection) and re-queue the
    // sub instead of settling, so the pool starts a fresh turn that
    // actually reads the new input.
    var _msgs = (chats[chatId] && chats[chatId].messages) || [];
    var _lastMsg = _msgs.length ? _msgs[_msgs.length - 1] : null;
    var _hasTrailingUser = !!(_lastMsg && _lastMsg.role === 'user');
    var _hasPendingInj = false;
    try {
        if (typeof pendingInjectionsByChatId !== 'undefined') {
            var _pi = pendingInjectionsByChatId[chatId];
            _hasPendingInj = !!(_pi && (_pi.text || (_pi.images && _pi.images.length)));
        }
    } catch (_) { /* ignore */ }
    if ((_hasTrailingUser || _hasPendingInj) && !_runErrored) {
        rec.state = 'running';
        if (typeof pausedChats !== 'undefined') delete pausedChats[rec.chat_id];
        rec.last_activity_at = Date.now();
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        if (_subPool.queue.indexOf(rec.agent_id) === -1) _subPool.queue.push(rec.agent_id);
        _drainPool();
        _notifyListeners();
        return;
    }

    // RES-6 (auto-retry): a TRANSIENT crash (network/fetch/timeout) gets ONE
    // automatic retry before the sub is declared errored — the partial
    // assistant turn was already popped by the loop's catch, so re-queueing
    // simply replays the failed turn with the same context. The _retry_used
    // latch caps it at one retry per crash; it resets on the next successful
    // turn (onToolCallInSubAgent / clean finish / report_to_parent). The
    // retry is logged visibly in the sub's transcript via an injected user
    // row, which also guarantees the resumed run starts on a user turn.
    if (_runErrored && _runErrTransient && !rec._retry_used) {
        // REG391-3: body extracted to _queueTransientRetry (shared with
        // _markErrored's pool-crash path). Behavior here is unchanged.
        _queueTransientRetry(rec, _runErrorMsg);
        return;
    }

    if (rec.auto_report) {
        // Pull the last assistant text as a fallback summary.
        var fallback = '';
        var msgs = chats[chatId].messages || [];
        for (var i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant' && msgs[i].content) {
                fallback = (typeof msgs[i].content === 'string')
                    ? msgs[i].content
                    : JSON.stringify(msgs[i].content);
                break;
            }
        }
        if (fallback.length > rec.summary_cap_bytes) {
            fallback = fallback.slice(0, rec.summary_cap_bytes - 100) + '\n…[truncated]';
        }
        // Synthesize error vs done based on the agent-loop's finish reason.
        // Without this, a crashed sub still reports back as success.
        var _synthStatus = _runErrored ? 'error' : 'done';
        var _synthSummary = fallback
            || (_runErrored
                ? ('(sub-agent crashed without an explicit report_to_parent call' + (_runErrorMsg ? ': ' + _runErrorMsg : '') + ')')
                : '(sub-agent finished without an explicit report_to_parent call)');
        // RES-6: the synthesized crash report carries the STRUCTURED error
        // (message + transient flag + retry hint), not just the last status
        // message — the parent can decide to wake_sub_agent programmatically.
        var _synthErrInfo = _runErrored ? {
            message: _runErrorMsg || 'sub-agent run errored',
            transient: _runErrTransient,
            retried: !!rec._retry_used,
            retryable: true,
            hint: 'resurrectable via wake_sub_agent (full prior context preserved)'
        } : undefined;
        rec.last_report = {
            status: _synthStatus,
            summary: _synthSummary,
            error: _synthErrInfo,
            from: rec.agent_id,
            from_name: rec.name,
            at: Date.now(),
            _synthesized: true
        };
        rec.report_collected = false; // P2/P1d: fresh, not yet collected
        if (_runErrored) {
            _cascadeStopDescendants(rec, 'parent sub-agent crashed: ' + rec.name);
            rec.state = 'errored';
            rec.settled_at = rec.settled_at || Date.now();
            // RES-6: diagnostics for agent_status (resurrectable, last_error…).
            rec.crash_cause = 'run_error';
            rec.last_error = { message: _synthErrInfo.message, at: Date.now(), transient: _runErrTransient, retried: !!rec._retry_used };
        }
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        var _arHadAwaiters = _spawnHandleHasAwaiters(rec); // P2: pre-settle sample
        _resolveSpawnHandle(rec.agent_id, {
            status: _synthStatus,
            summary: rec.last_report.summary,
            from: rec.agent_id,
            _synthesized: true,
            error: _runErrored ? (_runErrorMsg || 'sub-agent run errored') : undefined,
            error_info: _synthErrInfo
        });
        // RES-6: proactive parent notice on terminal crash (after the failed
        // retry, if it was transient) — a crash is never parent-initiated.
        if (_runErrored) {
            _notifySubLifecycle(rec, 'errored — ' + (_runErrorMsg || 'run crashed')
                + (_runErrTransient ? ' (transient' + (rec._retry_used ? '; one auto-retry already failed' : '') + ')' : '')
                + ' — resurrectable via wake_sub_agent');
        }
        // P2: auto-reports wake too — a fire-and-forget parent would otherwise
        // never act on the synthesized report until the user's next message.
        // The crash arm already delivered its notice via _notifySubLifecycle.
        _wakeParentOnReport(rec, rec.last_report, { hadAwaiters: _arHadAwaiters, noticeDelivered: _runErrored });
    } else {
        // auto_report:false means the caller opted into manual settlement.
        // The sub finished without calling report_to_parent — the parent's
        // await_handle would hang forever. Settle with an explicit `error`
        // so the parent unblocks with a clear diagnostic instead.
        var errMsg = 'sub-agent finished without calling report_to_parent (auto_report disabled).';
        rec.last_report = rec.last_report || {
            status: 'error',
            summary: errMsg,
            from: rec.agent_id,
            from_name: rec.name,
            at: Date.now(),
            _no_report: true
        };
        // F4: settle as terminal `errored` so the tombstone sweep can GC this
        // record + its background chat row. Without setting state here, the
        // trailing _parkSubAgent() downgrades the run to `sleeping`, which the
        // GC never collects → permanent record + chat-row leak. settled_at is
        // required for the tombstone TTL check to ever fire.
        // SA-CASCADE-GAP: this terminal-errored branch must also cascade-stop any
        // descendants the sub spawned, mirroring _stopSubAgentImpl's cascade —
        // otherwise a no-report crash orphans the whole sub-tree (leaked pool
        // slots + chat rows that never GC).
        _cascadeStopDescendants(rec, 'parent sub-agent errored: ' + rec.name);
        rec.state = 'errored';
        rec.settled_at = rec.settled_at || Date.now();
        // RES-6: diagnostics + structured error for the manual-settlement path.
        // PR383-R3: unconditional — the old || guards reused a stale recovered
        // last_error / old crash_cause for THIS new terminal event.
        rec.crash_cause = _runErrored ? 'run_error' : 'no_report';
        rec.last_error = { message: _runErrored ? (_runErrorMsg || 'sub-agent run errored') : errMsg, at: Date.now(), transient: _runErrTransient, retried: !!rec._retry_used };
        rec.report_collected = false; // P2/P1d: fresh, not yet collected
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        var _nrHadAwaiters = _spawnHandleHasAwaiters(rec); // P2: pre-settle sample
        _resolveSpawnHandle(rec.agent_id, {
            status: 'error',
            error: 'no_report',
            summary: errMsg,
            from: rec.agent_id,
            error_info: { message: rec.last_error.message, transient: rec.last_error.transient, retried: rec.last_error.retried, retryable: true }
        });
        // RES-6: proactive parent notice — never parent-initiated.
        _notifySubLifecycle(rec, 'errored — ' + rec.last_error.message + ' (auto_report disabled, no report produced) — resurrectable via wake_sub_agent');
        // P2: error report — wake an idle parent (notice already delivered above).
        _wakeParentOnReport(rec, rec.last_report, { hadAwaiters: _nrHadAwaiters, noticeDelivered: true });
    }
    // Finalize the live parent card if it's still showing a non-terminal status
    // (auto-report, crash, and no-report terminal paths don't push their own
    // row) so its spinner stops and the terminal status/summary is shown.
    _finalizeSubAgentCard(rec, rec.last_report);
    _parkSubAgent(rec);
    _notifyListeners();
}

// ---------- Exported API ----------

var SubAgents = {
    // Tool implementations (called from tools/020-tool-execution.js dispatch arms)
    spawn:   spawnSubAgent,
    report:  reportToParent,
    sleep:   sleepSelf,
    wake:    wakeSubAgent,
    stop:    stopSubAgent,
    message: agentMessage,
    status:  agentStatus,
    // SW tool-routing hook — persists a sub's update_action_state snapshot
    // (see recordSubActionState above; the page-side tool can't write it).
    recordActionState: recordSubActionState,
    // Agent-loop hooks
    onToolCallInSubAgent: onToolCallInSubAgent,
    consumeBudgetNotice: consumeBudgetNotice,
    onSubAgentRunFinished: onSubAgentRunFinished,
    // RES-6: unsolicited-event hooks — called by the SW port bridge when the
    // user sends a message into a sub's chat (worker/130-port-bridge.js) and
    // by the SW approval stub around a sub's permission prompts
    // (worker/120-tool-routing.js). Both push lifecycle notices to the parent.
    onUserMessageToSubChat: onUserMessageToSubChat,
    onSubApprovalEvent: onSubApprovalEvent,
    // UI hooks
    addListener:    addSubAgentListener,
    removeListener: removeSubAgentListener,
    // Boot
    loadAll: loadAllSubAgents,
    // True once loadAll drained IDB — the SW port bridge gates the hello
    // subAgentRecords snapshot on this so an unhydrated SW (MV3 restart,
    // hello racing the async boot load) never full-replace-wipes the
    // page's correctly IDB-loaded mirror.
    isLoaded: function() { return _subAgentsLoaded; },
    // P1d: await/poll dispatch arms stamp report delivery (see
    // markReportCollected).
    markCollected: markReportCollected,
    // Page-mirror sync — install a full snapshot from the authoritative
    // SW registry. Called by the page-side port bridge on `hello` and on
    // every `subagent-snapshot` envelope.
    applySnapshot: applySubAgentSnapshot,
    // SAGF-1: page→SW focus tracking. The page posts a `focus-chat` envelope
    // whenever the user selects/opens a chat; the SW port bridge calls this so
    // the GC paths (_idleSweepTick / loadAllSubAgents) can skip a transcript
    // the user is actively viewing (SW currentChatId is always null).
    setFocusedChat: function(id, portKey) {
        _focusSignalReceived = true; // SWM2-T2: a live panel has now reported its focus (set or clear)
        // RES-6: cheap user-interaction tracking — focusing a sub's chat means
        // the user opened/viewed its transcript. Stamp only; no notification
        // (viewing is passive, not interference).
        try {
            if (id && typeof chats !== 'undefined' && chats[id] && chats[id].isSubAgent && chats[id].subAgentId) {
                var _focRec = _subAgents[chats[id].subAgentId];
                if (_focRec) {
                    _focRec.user_interactions = _focRec.user_interactions || {};
                    _focRec.user_interactions.opened_by_user_at = Date.now();
                    _subAgentsPersist(_focRec);
                }
            }
        } catch (_) { /* ignore */ }
        // SWM2-F2: portKey-aware. With a portKey, focus is tracked per panel (so a
        // 2nd panel can't clobber the 1st's focus); a null/empty chatId clears just
        // that port's entry. Without a portKey, fall back to the single default
        // scalar — identical to the pre-F2 behavior, so single-panel is unchanged.
        if (portKey != null && portKey !== '') {
            if (id) _focusedChatByPort[portKey] = id;
            else delete _focusedChatByPort[portKey];
        } else {
            _focusedChatId = id || null;
        }
    },
    // SWM2-F2: drop a disconnected panel's focus entry (called by the SW port
    // bridge's _unregisterPanel) so a closed panel doesn't pin a transcript forever.
    clearFocusedChatForPort: function(portKey) {
        if (portKey != null && portKey !== '') delete _focusedChatByPort[portKey];
        // SWM2-T2 fix: the bare _focusSignalReceived latch stays true forever, so once
        // the LAST focus entry is cleared (only panel disconnected) _isFocusEstablished()
        // would still report "focus known" via the latch — letting GC reclaim the
        // transcript the user is viewing during the reconnect gap. Re-arm the
        // "defer GC when focus unknown" guard by resetting the latch when BOTH the
        // default scalar AND the per-port map are empty; the reconnecting panel
        // re-posts focus-chat and re-sets the latch.
        if (!_focusedChatId) {
            var _anyPortFocus = false;
            for (var _pk3 in _focusedChatByPort) { if (_focusedChatByPort[_pk3]) { _anyPortFocus = true; break; } }
            if (!_anyPortFocus) _focusSignalReceived = false;
        }
    },
    // Read-only access for UI components
    getById: function(agentId) { return _subAgents[agentId] || null; },
    // ZR-1: chat→record lookup that works even when the chats row is gone
    // (used by the SW resume scan to gate sub-chat checkpoints; the previous
    // route via chats[chatId].subAgentId fails exactly in the corruption
    // case the gate must handle). Linear scan — registry is small.
    getByChatId: function(chatId) {
        if (!chatId) return null;
        for (var aid in _subAgents) {
            if (_subAgents[aid].chat_id === chatId) return _subAgents[aid];
        }
        return null;
    },
    // ZR-1: full terminal settlement (record + spawn handle + pool slot +
    // parent notice) for a sub the resume scan cannot restart (its chat row
    // vanished from the chats store). Thin alias — _markErrored already does
    // everything atomically.
    markOrphaned: function(agentId, msg) { _markErrored(agentId, msg || 'sub-agent orphaned: chat transcript missing at resume'); },
    listAll: function() {
        var out = []; for (var aid in _subAgents) out.push(_subAgents[aid]); return out;
    },
    poolSnapshot: function() {
        return {
            running: Object.keys(_subPool.running).length,
            queued:  _subPool.queue.length,
            size:    SUBAGENT_POOL_SIZE
        };
    },
    // Pool-deadlock prevention hooks (Phase 5). Called by the await_handle
    // dispatch arm when a sub awaits one of its own descendants' spawn handles.
    parkForAwait:      parkForAwait,
    unparkAfterAwait:  unparkAfterAwait,
    // Tree-walk helpers exposed for UI / tools that need to render hierarchy
    // or enforce ACL outside this module.
    ancestorChain:     _ancestorChain,
    children:          _children,
    descendants:       _descendants,
    // Constants the system prompt module reads
    PREAMBLE: SUB_AGENT_PREAMBLE
};

// Expose for SW context (worker bundle runs as a module/script).
if (typeof self !== 'undefined') { self.SubAgents = SubAgents; }
