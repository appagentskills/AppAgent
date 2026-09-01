// =============================================================
// AppAgent SW runtime — direct panel ↔ SW port bridge.
//
// In the SW-hosted architecture there is NO relay: panels open a
// long-lived 'agent-bus' port directly to the SW. The SW IS the
// runtime, so it acts on incoming messages immediately and broadcasts
// AgentEvents to every subscribed panel without an extra hop.
//
// Outbound (SW → panel) message types:
//   • { type: 'agent-event', eventType, detail }  — bus broadcast
//   • { type: 'hello', chatsSnapshot, runningChatIds } — on connect
//   • { type: 'chat-snapshot', chatId, chat }     — pull response
//   • { type: 'exec-tool', toolCallId, ... }      — UI tool routing
//   • { type: 'exec-approval-prompt', ... }       — approval request
//
// Inbound (panel → SW) message types:
//   • 'run-agent'           — start a chat run
//   • 'send-message'        — queue user injection mid-run + interrupt
//   • 'interrupt'           — user interrupt without a new message
//   • 'toggle-pause'        — pause / resume
//   • 'pull-chat'           — request a fresh chat snapshot
//   • 'update-chat'         — panel-side delete tombstone (sole page sender:
//                             _notifyWorkerChatDeleted, ui/170 — title renames
//                             travel the 'chat-meta-update' lane instead)
//   • 'exec-tool-result'    — UI tool result coming back from panel
//   • 'exec-approval-prompt-result' — approval decision from panel
// =============================================================

// Set of currently-connected panel ports. Each entry serves as both
// an event subscriber (via _agentSubscribers) and a UI-tool executor.
// We keep them deduplicated against _agentSubscribers so a single
// panel = one subscription = one executor candidate.
var _swPanelPorts = new Set();

// REG-AUDIT-2: resume-scan settle signal. The page's hello-grace reconcile
// (app/045-agent-port-bridge-page.js) settles orphaned pending runAgents after
// a fixed grace window, but resumeRunningCheckpoints' gate chain
// (_swBootReady → _swResumeGate → Platform.ready → loadApiProviders) is
// unbounded — on a slow cold boot the page timer could win and finalize a
// still-resuming run. Once the SW knows the resume scan is decided (no
// checkpoints, or all checkpoints re-armed, or the gate chain failed), it
// flips this flag and notifies every connected panel so the page can stop
// extending its grace window.
var _swResumeScanSettled = false;
function _settleResumeScan() {
    if (_swResumeScanSettled) return;
    _swResumeScanSettled = true;
    _swPanelPorts.forEach(function(p) { try { p.postMessage({ type: 'resume-scan-done' }); } catch (e) {} });
}
self._settleResumeScan = _settleResumeScan;

// ZR1-R1 (follow-up): registry-side orphan sweep for boot-claimed,
// never-resumed subs. The boot decision in 097 claims a pool slot for every
// checkpoint-resumable sub BEFORE the resume scan runs; any settle path that
// fires without runAgent having started those loops (gate-chain failure,
// listRunningAgentCheckpoints rejecting or returning a PARTIAL list in
// 190-entry.js) must orphan them, or the records stay fake-'running' with a
// claimed slot + pending rehydrated handle for the whole SW session (no
// sweeper covers 'running'; two leaks block the 2-slot pool). Registry-side
// (not checkpoint-side) so it also works when the checkpoint list itself is
// what failed. Selection: state 'running' + pool slot CLAIMED + loop not in
// runningChatIds — exactly the boot-claimed-unresumed shape. Subs started
// this session are excluded by the runningChatIds guard (a drain's
// claim→runAgent pair is atomic w.r.t. other tasks' microtasks, so the
// claimed-but-not-yet-running window cannot interleave with this sweep);
// queued subs and throttle-backoff retries hold no slot and are skipped.
// Failure path — guard every step.
function _orphanUnresumedSubs(reason) {
    try {
        if (typeof SubAgents === 'undefined' || !SubAgents.listAll || !SubAgents.markOrphaned) return;
        if (typeof _subPool === 'undefined' || !_subPool.running) return;
        SubAgents.listAll().forEach(function(rec) {
            try {
                if (!rec || rec.state !== 'running') return;
                if (!_subPool.running[rec.agent_id]) return;
                if (typeof runningChatIds !== 'undefined' && runningChatIds[rec.chat_id]) return;
                SubAgents.markOrphaned(rec.agent_id, reason);
            } catch (e2) { /* per-record best-effort */ }
        });
    } catch (e3) { /* never block the caller's settle */ }
}
self._orphanUnresumedSubs = _orphanUnresumedSubs;

// Lazy id stamping for routing UI-tool replies back to the right
// panel.
var _swPanelIds = new WeakMap();
var _swPanelIdSeq = 0;
function _panelId(port) {
    if (_swPanelIds.has(port)) return _swPanelIds.get(port);
    var id = 'panel_' + (++_swPanelIdSeq);
    _swPanelIds.set(port, id);
    return id;
}

function _serializeChatsSnapshot() {
    var out = {};
    Object.keys(chats).forEach(function(cid) {
        // TOMBSTONE: never ship a `_deleted` entry to the panel — the page
        // merges snapshot chats into its list (app/045-agent-port-bridge-page.js)
        // and would re-add the just-deleted chat as an empty ghost row.
        if (chats[cid] && chats[cid]._deleted) return;
        if (runningChatIds[cid] || (parkedToolCallsByChatId[cid] && parkedToolCallsByChatId[cid].length)) {
            out[cid] = chats[cid];
        }
    });
    return out;
}

// ── FLUX-4C (narrow pull-forward): SW-owned chat-meta lane ──────────────
// The seven chat-meta fields (CHAT_META_TS_FIELDS / CHAT_META_FLAG_FIELDS,
// worker/115-storage.js) are SW-canonical: panels dispatch 'chat-meta-update'
// (app/045 dispatchChatMeta) instead of writing chats[id].<field> + page-
// saving. Apply rules: timestamps are MONOTONIC max-wins (any-panel-latest
// semantics — RFC open Q2 resolved: viewed in ANY panel wins); flags (incl.
// defined-null / explicit-false clears) are last-dispatch-wins.
function _swApplyChatMetaFields(target, fields) {
    if (!target || !fields) return;
    // FLUX-T1 (title lane): `title` is a VALUE+stamp PAIR — adopt the
    // dispatched title only when its paired titleUpdatedAt is STRICTLY newer
    // than the target's (arrival order at this single arbiter breaks ties
    // deterministically: first dispatch wins, the canonical rebroadcast
    // below converges every panel). `titleProvisional` rides the winning
    // pair: true → set, absent → cleared (renames / model titles clear it;
    // only the provisional first-message snippet sends true). Runs BEFORE
    // the TS loop so the compare reads the pre-merge stamp.
    if (typeof fields.titleUpdatedAt === 'number' && isFinite(fields.titleUpdatedAt)
        && typeof fields.title === 'string' && fields.title
        && fields.titleUpdatedAt > (target.titleUpdatedAt || 0)) {
        target.title = fields.title;
        if (fields.titleProvisional === true) target.titleProvisional = true;
        else delete target.titleProvisional;
    }
    CHAT_META_TS_FIELDS.forEach(function(f) {
        // FLUX-6 (#799 review, defensive): pair atomicity — reject a bare
        // titleUpdatedAt stamp arriving WITHOUT its title value (it would
        // advance the stamp and make every later legit rename with an older
        // stamp lose the pair compare forever). Legit dispatches and pending-
        // bag folds only ever carry the stamp WITH the title.
        if (f === 'titleUpdatedAt' && !(typeof fields.title === 'string' && fields.title)) return;
        if (typeof fields[f] === 'number' && isFinite(fields[f]) && fields[f] > (target[f] || 0)) target[f] = fields[f];
    });
    CHAT_META_FLAG_FIELDS.forEach(function(f) {
        if (fields[f] !== undefined) target[f] = fields[f];
    });
}
// FLUX-4C review fix A: overlay the SW-canonical chat-meta fields from the
// SW's OWN pre-existing state (`prev`) onto a PANEL SNAPSHOT (`incoming`)
// that is about to become canonical state. EVERY path where a page-side
// snapshot replaces chats[id] must run this, or a replica carrying a stale
// DEFINED flag (e.g. pinned:false from before another panel's pin) is
// laundered into SW memory — and since worker/115-storage.js flips the flags
// to record-defined-wins, that laundered value now beats disk (F3).
// Rules, identical to the lane's own apply (_swApplyChatMetaFields):
//   • timestamps: max-wins, with the isFinite guard its siblings already had
//     (an Infinity from a corrupted replica would otherwise become the
//     canonical stamp and freeze every later max-wins compare);
//   • flags: the SW copy wins whenever it has an opinion (defined-wins,
//     including deliberate defined-null / explicit-false clears);
//   • a tombstoned `prev` is skipped entirely — the delete lanes own that
//     record and its meta must never travel onto a resurrected row.
// `prev` may be a full chat record OR a bag of pending lane fields
// (_swChatMetaPendingByChatId) — both are read field-wise only. Mutates and
// returns `incoming`; never throws on null input.
function _swOverlayChatMeta(prev, incoming) {
    if (!prev || !incoming || prev._deleted) return incoming;
    // FLUX-T1 (title lane): the SW's title pair wins on >= (ties included) —
    // an equal-stamp different-title snapshot is a panel's LOSING concurrent
    // rename being laundered back; the arbiter's pick must survive the adopt.
    // A prev with no pair (legacy state) expresses no title opinion and the
    // snapshot's title passes through untouched. Sets the stamp explicitly
    // (the TS loop's strict > would skip the equal case).
    if (typeof prev.titleUpdatedAt === 'number' && isFinite(prev.titleUpdatedAt)
        && typeof prev.title === 'string' && prev.title
        && prev.titleUpdatedAt >= (incoming.titleUpdatedAt || 0)) {
        incoming.title = prev.title;
        incoming.titleUpdatedAt = prev.titleUpdatedAt;
        if (prev.titleProvisional === true) incoming.titleProvisional = true;
        else delete incoming.titleProvisional;
    }
    CHAT_META_TS_FIELDS.forEach(function(f) {
        // FLUX-6: same bare-stamp pair-atomicity guard as _swApplyChatMetaFields.
        if (f === 'titleUpdatedAt' && !(typeof prev.title === 'string' && prev.title)) return;
        if (typeof prev[f] === 'number' && isFinite(prev[f]) && prev[f] > (incoming[f] || 0)) incoming[f] = prev[f];
    });
    CHAT_META_FLAG_FIELDS.forEach(function(f) {
        if (prev[f] !== undefined) incoming[f] = prev[f];
    });
    return incoming;
}
// Lane state for chats this SW does NOT hold in memory (created page-side
// after SW boot, never run): dispatched fields accumulate here (they overlay
// a later run-agent adopt) and are read-merge-written onto the stored record,
// serialized on one promise chain so a burst of dispatches can't interleave.
var _swChatMetaPendingByChatId = {};
var _swChatMetaOpChain = Promise.resolve();
function _swChatMetaRMW(chatId) {
    var fields = _swChatMetaPendingByChatId[chatId];
    if (!fields || typeof withStore !== 'function') return Promise.resolve();
    return withStore([chatStoreName], 'readwrite', function(tx) {
        return new Promise(function(resolve) {
            var st = tx.objectStore(chatStoreName);
            var g = st.get(chatId);
            g.onsuccess = function() {
                var stored = g.result;
                // No stored row (never persisted / 0-message chat) or a
                // tombstone: drop the disk write — never create or resurrect
                // a record here. The pending map keeps the fields for a later
                // run-agent adopt overlay.
                if (!stored || stored._deleted) { resolve(); return; }
                _swApplyChatMetaFields(stored, fields);
                // TRANSIENT-FLAG STRIP (core/130-indexeddb.js): the base here
                // is the stored row, so no NEW in-memory transient can leak —
                // but rows written before the strip existed may still carry
                // legacy '_'-prefixed working flags; shed them on this RMW so
                // the schema converges. Allowlisted fields (incl. the lane's
                // own _jobsHidden/_lastApiError) pass through untouched.
                var p = st.put(stripTransientChatFieldsForPut(stored));
                p.onsuccess = function() { resolve(); };
                p.onerror = function() { resolve(); };
            };
            g.onerror = function() { resolve(); };
        });
    });
}
// Buffer one lane dispatch: accumulate into the pending map (lane merge —
// ts max-wins, flags last-wins) and chain a serialized read-merge-write of
// the STORED row. Used by the not-held path AND by the held path during the
// boot window (FLUX-H2/H3): pre-hydration the record save is wipe-guarded
// (_chatsHydrated false) and the boot getAll overlays disk meta onto the
// held record, so the dispatch must ALSO live in the pending map (re-folded
// after hydration) and on disk (RMW survives SW death mid-boot).
function _swBufferChatMetaDispatch(chatId, fields) {
    var pend = _swChatMetaPendingByChatId[chatId] || (_swChatMetaPendingByChatId[chatId] = {});
    _swApplyChatMetaFields(pend, fields);
    _swChatMetaOpChain = _swChatMetaOpChain
        .then(function() { return _swChatMetaRMW(chatId); })
        .catch(function(e) { console.warn('[sw-runtime] chat-meta RMW failed', chatId, e); });
}
// FLUX-H4 (reconnect anti-entropy): compact authoritative chat-meta map —
// per held chat the 7 lane fields (ts only when finite; flags ALWAYS, with
// null standing in for "no opinion recorded" so a phantom page flag the
// store never accepted converges back instead of surviving forever), plus
// the buffered pending bags for chats this SW never held (defined fields
// only — padding those with nulls would clear legit optimistic values on
// chats the SW simply hasn't adopted yet). Tombstones are skipped: the
// delete lanes own them.
function _serializeChatMetaSnapshot() {
    var out = {};
    try {
        Object.keys(chats).forEach(function(cid) {
            var c = chats[cid];
            if (!c || c._deleted) return;
            var bag = {};
            CHAT_META_TS_FIELDS.forEach(function(f) {
                if (typeof c[f] === 'number' && isFinite(c[f])) bag[f] = c[f];
            });
            CHAT_META_FLAG_FIELDS.forEach(function(f) {
                bag[f] = (c[f] === undefined) ? null : c[f];
            });
            // FLUX-T1: the title pair travels ONLY when the SW holds a lane
            // opinion (finite stamp + string title). Unlike flags there is NO
            // null=no-opinion encoding — title is a VALUE and a null would
            // clobber a panel's legitimate optimistic rename; a phantom
            // panel-side pair the SW never persisted is instead repaired by
            // the page's retransmit (app/045 'chat-meta-snapshot' handler).
            if (typeof c.titleUpdatedAt === 'number' && isFinite(c.titleUpdatedAt)
                && typeof c.title === 'string' && c.title) {
                bag.title = c.title;
                if (c.titleProvisional === true) bag.titleProvisional = true;
            } else if (bag.titleUpdatedAt !== undefined) {
                // Pair atomicity: never ship a bare stamp without its value.
                delete bag.titleUpdatedAt;
            }
            out[cid] = bag;
        });
        Object.keys(_swChatMetaPendingByChatId).forEach(function(cid) {
            if (chats[cid]) return; // held: folded at hydration / consumed at adopt
            var pf = _swChatMetaPendingByChatId[cid];
            var bag = null;
            // FLUX-T1: pending bags carry the title pair too (defined-only —
            // the fold in _swApplyChatMetaFields only ever writes it as a pair).
            CHAT_META_TS_FIELDS.concat(CHAT_META_FLAG_FIELDS, ['title', 'titleProvisional']).forEach(function(f) {
                if (pf && pf[f] !== undefined) (bag = bag || {})[f] = pf[f];
            });
            if (bag) out[cid] = bag;
        });
    } catch (e) { /* snapshot is best-effort */ }
    return out;
}

// FLUX-4/3 (late-hydration resync): when the 20s boot deadline
// (worker/190-entry.js safe()) resolves _swBootReady BEFORE the chats getAll
// lands, panels that connected in that window received an adopts-only
// 'chat-meta-snapshot' (the map reflected only pre-boot adopts + pending
// bags). When the late hydration finally completes, push a FRESH snapshot to
// every connected panel — same payload, same idempotent page-side apply
// (app/045 'chat-meta-snapshot'), per-port targeted, fired ONCE per late
// hydration (a single .then armed in 190-entry), so there is no storm.
// Panels that connect AFTER the late hydration already get the correct map
// from _registerPanel's own _swBootReady.then sender above.
function _swLateHydrationResync() {
    var n = 0;
    var snap = _serializeChatMetaSnapshot();
    _swPanelPorts.forEach(function(p) {
        try { p.postMessage({ type: 'chat-meta-snapshot', chatMeta: snap }); n++; }
        catch (e) { /* dead port — disconnect handler cleans up */ }
    });
    console.log('[sw-runtime] late hydration: re-synced chat-meta snapshot to ' + n + ' panel(s)');
}
self._swLateHydrationResync = _swLateHydrationResync;

// FLUX-T1 (title lane): SW-REALM lane entry for internal title writers —
// set_chat_title executing in the SW (tools/020-tool-execution.js) and the
// auto-title hook's retry-cap finalize (worker/020-page-stubs.js). Reuses the
// REAL 'chat-meta-update' case in _handlePanelMessage (apply/buffer with the
// lane merge, rehydrate-first persist, canonical rebroadcast) so an in-SW
// writer cannot fork the lane semantics. The case reads only msg.* and
// globals — never the port — so a null port is safe.
function _swHandleChatMetaUpdate(chatId, fields) {
    try { _handlePanelMessage(null, { type: 'chat-meta-update', chatId: chatId, fields: fields }); }
    catch (e) { console.warn('[sw-runtime] internal chat-meta dispatch failed', chatId, e); }
}

function _registerPanel(port) {
    if (_swPanelPorts.has(port)) return;
    _swPanelPorts.add(port);
    // Decorate the port so the routing code in 120-tool-routing.js can
    // identify it. _agentSubscribers stores port-like handles; the real
    // port works directly because it already has .postMessage.
    port._panelId = _panelId(port);
    _agentSubscribers.add(port);
    // FLUX-H4 (reconnect anti-entropy): push the authoritative chat-meta
    // snapshot AFTER the boot hydration gate. A port connect is what wakes a
    // dead SW, so the sync hello below races hydration and would ship an
    // empty map — the .then here always runs after the sync hello post (FIFO
    // per sender), and after _swBootReady the map reflects hydrated + pending-
    // folded truth. The page applies it through the same idempotent
    // 'chat-meta-changed' apply (max-wins ts / overwrite flags) and never
    // re-dispatches, so there is no echo loop; a phantom optimistic value
    // whose SW died pre-persist converges back to store truth here.
    if (self._swBootReady && typeof self._swBootReady.then === 'function') {
        self._swBootReady.then(function() {
            try { port.postMessage({ type: 'chat-meta-snapshot', chatMeta: _serializeChatMetaSnapshot() }); }
            catch (e) { /* port died before boot settled — disconnect handler cleans up */ }
        });
    }
    // Greet with running-chats snapshot + replay parked tool calls.
    try {
        port.postMessage({
            type: 'hello',
            chatsSnapshot: _serializeChatsSnapshot(),
            runningChatIds: Object.keys(runningChatIds).filter(function(c) { return runningChatIds[c]; }),
            // REG-AUDIT-2: tell the panel whether the boot resume scan has
            // already settled, so the hello-grace reconcile doesn't wait for a
            // 'resume-scan-done' that was posted before this panel connected.
            resumeScanSettled: _swResumeScanSettled,
            // F6: ship the SW's authoritative in-memory session permission
            // map so a connecting panel converges — a new panel learns
            // existing "Allow for session" grants; a panel reconnecting
            // after SW eviction sees the legitimate reset. Replaces the
            // panels' old hello-time UPWARD mirror push (the QW9 boot-wipe
            // bug: a fresh panel pushed `{}` and revoked grants everywhere).
            sessionPermissions: (sessionPermissions && typeof sessionPermissions === 'object') ? sessionPermissions : {},
            // Initial sub-agent snapshot. The page's own loadAllSubAgents
            // (which skips the orphan-rewrite per PR #244) populated the
            // page mirror from IDB at panel boot — the SW is authoritative
            // and overwrites that view here via SubAgents.applySnapshot in
            // the page-side hello handler. After this, live updates flow
            // via the `subagent-snapshot` envelope from
            // src/js/worker/105-subagent-broadcast.js.
            // GATED on SubAgents.isLoaded(): right after an MV3 SW restart
            // this hello can fire BEFORE the boot's async SubAgents.loadAll
            // (190-entry.js) has drained IDB — the registry is empty, and
            // shipping [] here made the page's full-replace
            // applySubAgentSnapshot WIPE its correctly IDB-loaded mirror.
            // Send null instead (the page handler skips falsy); once loadAll
            // completes it fires _notifyListeners and the broadcast bridge
            // (105) pushes the real snapshot to every connected panel.
            subAgentRecords: (typeof SubAgents !== 'undefined' && SubAgents.listAll
                && (typeof SubAgents.isLoaded !== 'function' || SubAgents.isLoaded()))
                ? SubAgents.listAll() : null
        });
        replayParkedToolCalls(port);
        // AB: re-deliver still-pending approval prompts to this late-connecting
        // panel (card-only copy — primary:false keeps OS-notify and give-up
        // duties on the original executor). Parked approvals were replayed
        // above (this port became their primary); this covers LIVE entries
        // already dispatched to panels that connected before this one.
        Object.keys(_pendingUIToolCalls).forEach(function(id) {
            var e2 = _pendingUIToolCalls[id];
            if (!e2 || !e2.isApproval || !e2.envelope || e2.port === port) return;
            try { port.postMessage(Object.assign({}, e2.envelope, { primary: false, osNotify: false })); } catch (e3) {}
        });
    } catch (e) {
        console.error('[port-bridge] hello/replay failed', e);
    }
}

function _unregisterPanel(port) {
    if (!_swPanelPorts.has(port)) return;
    _swPanelPorts.delete(port);
    _agentSubscribers.delete(port);
    // SWM-3: if the executing panel disconnects before posting its
    // exec-tool-result, the SW loop's awaited promise would hang forever.
    // Re-park any in-flight UI tool calls that were dispatched to THIS port so
    // a freshly-connected panel replays them (replayParkedToolCalls). Both
    // _pendingUIToolCalls and parkUIToolCall are globals in the worker bundle
    // (worker/120-tool-routing.js). The key of _pendingUIToolCalls is the
    // toolCallId; PART A stored .port/.chatId/.name/.input/.sandboxCtx on each.
    try {
        Object.keys(_pendingUIToolCalls).forEach(function(id) {
            var entry = _pendingUIToolCalls[id];
            if (!entry || entry.port !== port) return;
            // Defensive: clear any redispatch backstop on the entry being torn down so
            // its timer can't later fire against a re-registered entry for the same id.
            // (Backstop entries are normally port-less and not matched here, but this
            // keeps the invariant safe if that ever changes.) (bug #3)
            if (entry._backstopTimer) { clearTimeout(entry._backstopTimer); entry._backstopTimer = null; }
            // Re-park only entries that carry enough metadata to be REPLAYED to a
            // fresh panel (a real UI tool call: name + input). Approval-prompt
            // entries record .port for disconnect-visibility but intentionally
            // omit .name: replayParkedToolCalls re-dispatches via
            // dispatchUIToolToPort as an `exec-tool`, so a parked approval would
            // be sent as a bogus exec-tool '__approval_prompt__' the panel can't
            // run. For those, honour the documented "clean rejection if re-park
            // is not possible" contract so `await approvalPromise` settles
            // instead of hanging.
            if (entry.isApproval) {
                // AB: approval prompts are broadcast to EVERY panel — losing
                // the PRIMARY port must not abort the prompt while other panels
                // still show a live card. Rebind the entry to a surviving
                // subscriber and re-post the envelope primary:true so exactly
                // one panel keeps the give-up-deny duty (panel-side dedup makes
                // the re-post idempotent; osNotify:false — the original OS
                // notification already fired, never duplicate it). With NO
                // survivors, re-park as '__approval_prompt__' (the SWM3F-3
                // shape) so the next panel connect replays it — the old
                // clean-reject aborted a tool the user never even saw.
                var _survivor = null;
                try { _survivor = pickExecutorPort(); } catch (eS) {}
                if (_survivor && entry.envelope) {
                    entry.port = _survivor;
                    try {
                        _survivor.postMessage(Object.assign({}, entry.envelope, { primary: true, osNotify: false }));
                        return; // rebound — keep the pending entry alive
                    } catch (eP) { /* survivor died too — fall through to park */ }
                }
                var _apIn = entry.envelope || {};
                try {
                    parkUIToolCall(entry.chatId, id, '__approval_prompt__', {
                        displayName: _apIn.displayName,
                        args: _apIn.args,
                        permissionKey: _apIn.permissionKey,
                        toolCallId: _apIn.toolCallId || entry.toolCallId,
                        toolName: _apIn.toolName,
                        widgetName: _apIn.widgetName || null
                    }, entry.resolve, entry.reject);
                } catch (eK) {
                    // Fallback: never leave the loop hanging.
                    try { entry.reject(new Error('panel disconnected before returning tool result')); } catch (e2) {}
                }
            } else if (entry._remoteResult) {
                // Sweep 753-773 (F772-1 void-post race): another panel's submission
                // was already FORWARDED to this now-dead executor (the
                // prompt-user-remote-result post succeeded silently before the
                // disconnect fired). The result is known — settle the loop's
                // promise directly instead of re-parking, which would re-ask the
                // user and discard the first submission's values.
                try { entry.resolve(entry._remoteResult); } catch (e2) {}
            } else if (entry.name) {
                try {
                    // B1: pass alreadyDispatched=true — this tool was already sent to
                    // the now-disconnected panel and may have executed, so replay must
                    // reconcile rather than blindly re-dispatch (double side effect).
                    parkUIToolCall(entry.chatId, id, entry.name, entry.input, entry.resolve, entry.reject, entry.sandboxCtx, true);
                } catch (e) {
                    // Fallback: never leave the loop hanging.
                    try { entry.reject(new Error('panel disconnected before returning tool result')); } catch (e2) {}
                }
            } else {
                try { entry.reject(new Error('panel disconnected before returning tool result')); } catch (e2) {}
            }
            delete _pendingUIToolCalls[id];
        });
    } catch (e) {}
    // SWM3-F-HANG: re-parked already-dispatched entries only reconcile on a NEW connect; if the
    // executor panel dies while another panel is still connected (multi-panel) the SW loop's awaited
    // promise stalls until the 24h TTL. Drive an immediate reconcile against a surviving port.
    try { if (_swPanelPorts.size > 0) { var _altPort = pickExecutorPort(); if (_altPort) replayParkedToolCalls(_altPort); } } catch (e) {}
    // B3: also purge any post-SW-restart ADOPTION marker stamped with this dead
    // port. panel-hello sets _panelAdoptedTools[id].port BEFORE the resumed loop's
    // executeTool creates the matching _pendingUIToolCalls entry; if the adopting
    // panel disconnects in that window the pending scan above finds nothing, the
    // dead-port marker lingers, and executeTool later registers a pending entry on
    // that dead port that no future disconnect re-scans — hanging the await forever.
    try {
        Object.keys(_panelAdoptedTools).forEach(function(id) {
            if (_panelAdoptedTools[id] && _panelAdoptedTools[id].port === port) {
                // SWM3-N2: do NOT fully delete the marker. If the resumed loop later
                // reaches executeTool(id) it would otherwise find no marker and BLIND
                // RE-DISPATCH a tool this now-dead panel already ran (double side
                // effect). Downgrade to a port-less tombstone so the adoption arm
                // reconciles (registers a waiting pending entry + backstop, never
                // re-dispatches). scheduleAdoptedEviction bounds the tombstone's
                // lifetime so it can't grow unbounded.
                // F1: do NOT destroy a genuine buffered exec-tool-result. The earlier
                // version unconditionally `delete _adoptedResults[id]`; when the adopting
                // panel disconnected holding a real buffered result this wiped it, so the
                // resumed loop found no buffer, the 30s redispatch backstop REJECTED a
                // tool that already succeeded, and the model retried -> duplicate side
                // effect. Preserve a present buffer (mirroring the SWM3-T3 live-port path
                // in 120-tool-routing.js which deliberately keeps it) and rely on the
                // bounded ADOPTED_RESULT_TTL eviction below to reclaim it if it is never
                // consumed. Only drop when there's nothing valuable to keep.
                var _prevAdopt = _panelAdoptedTools[id];
                _panelAdoptedTools[id] = { dispatched: true, chatId: _prevAdopt && _prevAdopt.chatId };
                if (typeof scheduleAdoptedEviction === 'function') scheduleAdoptedEviction(id);
            }
        });
    } catch (e) {}
    // SWM2-F2: drop this panel's focus entry so a disconnected panel stops pinning
    // the chat it was viewing. The sub-agent GC guard skips a chat focused by ANY
    // LIVE panel; a dead panel's entry must be cleared or it would pin forever.
    try {
        if (typeof SubAgents !== 'undefined' && SubAgents.clearFocusedChatForPort) {
            SubAgents.clearFocusedChatForPort(_panelId(port));
        }
    } catch (e) {}
}

chrome.runtime.onConnect.addListener(function(port) {
    if (port.name !== 'agent-bus') return;
    // Ensure the offscreen helper is available — agent runs may need
    // js_eval / image processing. Best-effort: don't block on it.
    if (typeof ensureOffscreenDocument === 'function') {
        try { ensureOffscreenDocument(); } catch (e) {}
    }
    _registerPanel(port);
    port.onMessage.addListener(function(msg) {
        try { _handlePanelMessage(port, msg); }
        catch (e) { console.error('[port-bridge] handler error', msg && msg.type, e); }
    });
    port.onDisconnect.addListener(function() {
        _unregisterPanel(port);
    });
});

function _handlePanelMessage(port, msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
        case 'run-agent':
            // Panel sent a fresh chat snapshot + currentProvider. Adopt
            // them, refresh providers from IDB so a key change made in
            // the panel takes effect, and kick off the loop.
            //
            // CRITICAL: never replace chats[chatId] while a run is in flight
            // for that chat. The SW is the authoritative writer during a run
            // (it pushes the assistantMsg, seeds placeholder tool_results,
            // updates them as tools complete). The panel's snapshot lags
            // behind every save inside the loop. The replace race is the
            // root cause of orphan `tool_use` blocks: a hook re-fires the
            // next iteration synchronously on the SW (clearing/re-setting
            // runningChatIds in a tight window), but the panel briefly
            // observes the chat as "not running" between its runFinished
            // and runStarted notifications, posts run-agent with a stale
            // chat that's missing every in-flight tool_result placeholder,
            // and the SW used to clobber its in-memory chat with that copy.
            // The next save then persisted the stale shape to IDB.
            if (msg.chatId) {
                // Treat the brief finish→hook-rerun cleanup window as "running"
                // too. During it runningChatIds is transiently cleared, but the
                // SW is still the authoritative writer (about to push the hook's
                // assistant + tool_result). A panel run-agent that lands here
                // carries a stale snapshot — honoring _runCleanupGuard stops it
                // from clobbering chats[id] AND from starting a parallel loop.
                var isRunning = !!runningChatIds[msg.chatId]
                    || !!(typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard[msg.chatId]);
                // PR383-R4 (loss window 2): _notifySubLifecycle's idle branch
                // pushes injected user rows (lifecycle notices) straight into
                // the SW's chats copy. A panel's run-agent for an idle chat
                // adopts the incoming snapshot wholesale below — a stale panel
                // snapshot taken BEFORE the notice broadcast would silently
                // clobber those rows. Carry over injected:true user rows that
                // exist in the SW copy but not in the incoming snapshot
                // (append at the end when their original index is gone — the
                // run starts on a user turn either way). Content-equality
                // dedup keeps rows the panel already has from duplicating.
                if (msg.chat && !isRunning) {
                    try {
                        var _swPrev = chats[msg.chatId];
                        if (_swPrev && Array.isArray(_swPrev.messages) && Array.isArray(msg.chat.messages)) {
                            var _incomingMsgs = msg.chat.messages;
                            // PR384-FIX-7: COUNT-BASED dedup. The old matcher treated
                            // ONE content match as full presence, so a second
                            // byte-identical lifecycle notice (e.g. the same sub
                            // crashing twice with the same headline) was silently
                            // dropped. Consume each incoming copy at most once so
                            // surplus SW copies are carried over instead of collapsed.
                            var _consumed = {};
                            for (var _ci = 0; _ci < _swPrev.messages.length; _ci++) {
                                var _cm = _swPrev.messages[_ci];
                                if (!_cm || _cm.role !== 'user' || !_cm.injected || typeof _cm.content !== 'string') continue;
                                var _present = false;
                                for (var _cj = 0; _cj < _incomingMsgs.length; _cj++) {
                                    if (_consumed[_cj]) continue; // already matched by an earlier SW row
                                    var _im = _incomingMsgs[_cj];
                                    if (_im && _im.role === 'user' && _im.injected && _im.content === _cm.content) { _consumed[_cj] = true; _present = true; break; }
                                }
                                if (!_present) _incomingMsgs.push(_cm);
                            }
                        }
                    } catch (e) { console.warn('[port-bridge] injected-row carry-over failed', msg.chatId, e); }
                    // FLUX-4C (F3 close): the SW is canonical for the chat-meta
                    // lane fields — overlay them from the SW's own pre-adopt
                    // copy (boot-hydrated or prior adopt), falling back to lane
                    // dispatches buffered for a chat this SW never held
                    // (_swChatMetaPendingByChatId). Without this, a panel whose
                    // replica carried a stale DEFINED flag (e.g. pinned:false
                    // from before another panel's pin) laundered it wholesale
                    // into SW memory here; inline snapshots then re-poisoned
                    // every panel and the next page save persisted it.
                    // Timestamps max-win (any-panel-latest); flags: the SW copy
                    // wins whenever it has an opinion. A brand-new chat (no SW
                    // copy, no pending dispatches) keeps the panel's values —
                    // the page is the creator-writer exactly once.
                    try {
                        _swOverlayChatMeta(chats[msg.chatId] || _swChatMetaPendingByChatId[msg.chatId], msg.chat);
                        delete _swChatMetaPendingByChatId[msg.chatId];
                    } catch (e) { console.warn('[port-bridge] chat-meta adopt overlay failed', msg.chatId, e); }
                    chats[msg.chatId] = msg.chat;
                }
                // SWM-S1 (flap message loss): a run-agent for a chat the SW is STILL
                // running means the page took its IDLE send path during a port-flap
                // window (the bus onDisconnect cleared the page's runningChatIds), so
                // the user's freshly-typed message lives ONLY in this discarded
                // snapshot — the guard below skips the run and the next agent-event
                // broadcast overwrites the page mirror, silently dropping it. Recover:
                // extract trailing user-role messages (and their attachment rows)
                // present in msg.chat but absent from the SW's own copy, and route
                // them through the existing mid-run injection path exactly as if the
                // page had posted send-message to a running chat.
                if (msg.chat && isRunning) {
                    try {
                        // REG376-1: also dedup against the un-flushed pending
                        // injection queue (third arg) — a second flap arriving
                        // BEFORE the loop's flushPendingInjection consumed a
                        // previous flap's recovery re-extracted the same block
                        // (it is absent from the SW chat rows) and the merge
                        // below / in _handlePanelSendMessage concatenated a
                        // duplicate of the user's text.
                        var _unseen = _extractUnseenTrailingUserInput(msg.chat, chats[msg.chatId], pendingInjectionsByChatId[msg.chatId]);
                        if (_unseen) {
                            console.warn('[port-bridge] run-agent arrived for running chat', msg.chatId,
                                '— recovering', _unseen.count, 'unseen trailing user message(s) via mid-run injection');
                            if (runningChatIds[msg.chatId]) {
                                // Running branch of _handlePanelSendMessage: merge into
                                // pendingInjectionsByChatId + interrupt/abort — the loop's
                                // flushPendingInjection pushes it next iteration.
                                _handlePanelSendMessage({ chatId: msg.chatId, text: _unseen.text, images: _unseen.images });
                            } else {
                                // _runCleanupGuard window (finish→hook-rerun): the loop is
                                // between iterations — queue the injection WITHOUT firing an
                                // interrupt (same merge semantics as _handlePanelSendMessage's
                                // running branch); the re-run's flushPendingInjection flushes it.
                                var _exInj = pendingInjectionsByChatId[msg.chatId];
                                if (_exInj) {
                                    var _mTxt;
                                    if (_exInj.text && _unseen.text) _mTxt = _exInj.text + '\n\n' + _unseen.text;
                                    else _mTxt = _exInj.text || _unseen.text || null;
                                    var _mImgs;
                                    if (_exInj.images && _unseen.images) _mImgs = _exInj.images.concat(_unseen.images);
                                    else _mImgs = _exInj.images || _unseen.images || null;
                                    pendingInjectionsByChatId[msg.chatId] = { text: _mTxt, images: _mImgs };
                                } else {
                                    pendingInjectionsByChatId[msg.chatId] = { text: _unseen.text, images: _unseen.images };
                                }
                            }
                        }
                    } catch (e) { console.error('[port-bridge] flap-recovery injection failed', msg.chatId, e); }
                }
                if (msg.currentProvider) currentProvider = msg.currentProvider;
                // SWM1F-1: a run-agent means the user intends this chat to run
                // now, so clear any stale SW-side pause flag. Post-SW-move the
                // loop's `while (!isChatPaused)` gate reads the SW's pausedChats
                // copy; the page only clears its OWN pausedChats copy on send, so
                // without this a chat that was paused then re-run trips the gate
                // immediately and the just-sent run is silently dropped
                // (runFinished{reason:'paused'}). SWM1F-2 resolved by FLUX-P1:
                // pausedChatIds is now a DERIVED cache — the facade routes this
                // clear through the lane ingress, which syncs both caches (and
                // its no-op guard keeps never-paused sends off the lane).
                if (!isRunning) setChatPausedPersistent(msg.chatId, false);
                // Same gate order as resumeRunningCheckpoints: chats/providers
                // loaded, Platform session/instance ready, providers refreshed.
                // The panel inlines the chat snapshot above so chats[chatId]
                // is populated even pre-_swBootReady, but Platform.instanceUrl
                // and the session token aren't — without these gates a panel
                // posting run-agent during a cold-boot race could fire the
                // loop before ServiceNow tools have an authenticated session.
                (self._swBootReady || Promise.resolve())
                    .then(function() { return Platform.ready; })
                    .then(function() { return loadApiProviders(); })
                    // Orchestrator §1: refresh the sub-agent tier-alias map
                    // (small|medium|large → provider name) so a spawn_sub_agent
                    // with `tier` during this run resolves against the user's
                    // latest settings. Non-fatal — resolveTierAlias falls back
                    // to DEFAULT_TIER_ALIASES until hydrated.
                    .then(function() { return (typeof loadTierAliases === 'function') ? loadTierAliases() : null; })
                    // Refresh the assumed-context-window setting the same way,
                    // so a Settings change reaches an already-booted SW before
                    // the next run's context warnings / saturation gauges.
                    .then(function() { return (typeof loadAssumedContextTokens === 'function') ? loadAssumedContextTokens() : null; })
                    // MEMFIX: the SW loader evicts inline base64 payloads from
                    // every chat (worker/115-storage.js) and a panel snapshot
                    // adopted above may itself be payload-evicted (the page
                    // strips non-recent chats too). Rehydrate BEFORE runAgent so
                    // (a) buildApiMessages can inline vision blocks and (b) the
                    // loop's saves aren't skipped by the evicted-put guard — a
                    // skipped put here would lose the run's new messages on SW
                    // death. ensureChatPayloads never rejects.
                    .then(function() { return (typeof ensureChatPayloads === 'function') ? ensureChatPayloads(msg.chatId) : null; })
                    .then(function() {
                        if (!runningChatIds[msg.chatId]) {
                            // Not returned into the gate chain (the panel's
                            // _pendingRunAgents settles on events, not on this
                            // promise) — but the rejection must be handled
                            // here: runAgent is async, so the old sync
                            // try/catch let a loop crash surface as an
                            // uncaught promise rejection.
                            runAgent(msg.chatId).catch(function(e) {
                                console.error('[port-bridge] runAgent failed', msg.chatId, e);
                            });
                        }
                    })
                    .catch(function(e) {
                        // A gate failure (IDB/provider load) must surface — without
                        // this the user's run is silently dropped with no diagnostic.
                        console.error('[port-bridge] run-agent gate chain failed', msg.chatId, e);
                        // Emit the terminal event too: the panel showed a spinner and
                        // parked an _pendingRunAgents promise the moment it posted
                        // run-agent. A console line alone leaves that spinner live and
                        // every `await runAgent()` caller hanging until the 15s
                        // no-hello fallback (or forever on a healthy port) — the exact
                        // hang class the runCrashed settle in 045 closes. runCrashed
                        // is safe for a run that never started: the 036 handler's
                        // cleanup is no-op-tolerant and 045's settle just resolves.
                        // RES-2: this gate chain ALSO runs for run-agent posts on
                        // chats that are already live (port-flap re-post, SWM-S1
                        // above) — the .then deliberately skips runAgent for them.
                        // A transient gate rejection must not crash that healthy
                        // run: only emit runCrashed when the chat is NOT live
                        // (same liveness check as `isRunning` above).
                        try {
                            if (msg.chatId && typeof AgentEvents !== 'undefined' && AgentEvents.emit
                                && !runningChatIds[msg.chatId]
                                && !(typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard && _runCleanupGuard[msg.chatId])) {
                                AgentEvents.emit('runCrashed', { chatId: msg.chatId });
                            }
                        } catch (e2) {}
                    });
            }
            return;

        case 'provider-change':
            // Foreground-only control transition. Update the worker selection first,
            // then abort the named active run/backoff/tool without setting
            // userInterruptedChats. Pinned sub-agents still resolve chat.provider.
            if (msg.providerId) currentProvider = msg.providerId;
            var pcid = msg.chatId;
            if (pcid && runningChatIds[pcid]) {
                providerChangedChats[pcid] = msg.providerId || true;
                if (providerChangeBackoffResolversByChatId[pcid]) {
                    try { providerChangeBackoffResolversByChatId[pcid](); } catch (e) {}
                    delete providerChangeBackoffResolversByChatId[pcid];
                }
                if (interruptResolversByChatId[pcid]) {
                    try { interruptResolversByChatId[pcid](); } catch (e) {}
                }
                if (currentStreamAbortControllers[pcid]) {
                    try { currentStreamAbortControllers[pcid].abort(); } catch (e) {}
                }
            }
            return;

        case 'send-message':
            // SWM14-T7: gate the send-message dispatch on the SW boot (and the same
            // Platform.ready + providers chain run-agent uses @:218). Without the boot
            // gate, a send arriving during the SW cold-boot window runs
            // _handlePanelSendMessage while `chats` is still {} — its idle branch then
            // pushes the user message onto a skeleton chat and saveChatsToStorage()'s
            // store.clear()+rewrite WIPES every other chat from IDB. Gating until
            // _swBootReady guarantees `chats` is hydrated first (the page now also
            // inlines a chat snapshot — app/040-send-message.js — so a brand-new chat
            // not yet persisted to IDB still seeds correctly without clobbering siblings).
            // QUEUE-SYNC-FIX: a send to a RUNNING chat must be handled SYNCHRONOUSLY.
            // The running branch only touches in-memory maps (pendingInjectionsByChatId /
            // userInterruptedChats / interrupt resolver / stream abort) — it needs neither
            // chats hydration nor providers. Deferring it behind the async boot chain broke
            // the single-port FIFO ordering the interrupt path depends on (SWM-SW-NOGEN-NOTE):
            // the abort must land while the stream/tool it targets is still the current step,
            // otherwise the resolver/abort fire as no-ops in the between-steps gap and the
            // queued message only flushes at the end of the run. The SWM14-T7 wipe risk only
            // applies to the IDLE branch (which writes chats + IDB); during the cold-boot
            // window runningChatIds is empty, so this fast path can never take that branch.
            if (msg.chatId && runningChatIds[msg.chatId]) {
                try { _handlePanelSendMessage(msg); }
                catch (e) { console.error('[port-bridge] _handlePanelSendMessage threw', e); }
                return;
            }
            (self._swBootReady || Promise.resolve())
                .then(function() { return Platform.ready; })
                .then(function() { return loadApiProviders(); })
                .then(function() {
                    try { _handlePanelSendMessage(msg); }
                    catch (e) { console.error('[port-bridge] _handlePanelSendMessage threw', e); }
                })
                .catch(function(e) {
                    // A gate failure (IDB/provider load) must surface — without
                    // this the user's message is silently dropped with no diagnostic.
                    console.error('[port-bridge] send-message gate chain failed', msg.chatId, e);
                    // Same rationale as the run-agent catch above: unstick the
                    // panel's spinner/streaming UI and settle any pending runAgent
                    // promise for this chat instead of leaving them hanging.
                    try {
                        // PR384-FIX-3: guard the emit with the SAME liveness check
                        // as the run-agent gate catch above. FIX-1's handler now
                        // routes runCrashed into a terminal sub settle, so an
                        // unguarded emit here (this gate chain also runs for sends
                        // on chats that are already live) could error a HEALTHY sub.
                        if (msg.chatId && typeof AgentEvents !== 'undefined' && AgentEvents.emit
                            && !runningChatIds[msg.chatId]
                            && !(typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard && _runCleanupGuard[msg.chatId])) {
                            AgentEvents.emit('runCrashed', { chatId: msg.chatId });
                        }
                    } catch (e2) {}
                });
            return;

        // SWM-SW-NOGEN-NOTE: the 'interrupt' and 'toggle-pause' handlers below apply
        // msg.paused / msg.fromUserMessage with NO generation / run-id guard. This is
        // correct ONLY because of single-port FIFO message ordering plus page-side
        // latest-wins reconciliation: messages from a given panel arrive in send order,
        // and the page resolves any stale paused/interrupt state on the next snapshot.
        // If multi-port or out-of-order delivery is ever introduced, these handlers will
        // need an explicit generation guard. Documentation only -- no logic change.
        case 'interrupt':
            var icid = msg.chatId;
            if (icid) {
                if (msg.fromUserMessage) userInterruptedChats[icid] = true;
                // A bare interrupt (panel's stop button, not a send-message) means
                // the user is cancelling, not deferring. Drop any pending injection
                // queued by an earlier send-message — otherwise the next runAgent
                // would silently flush stale text the user thought they aborted.
                // send-message takes the running branch with its own assignment, so
                // this delete won't race with that path.
                //
                // SWM14-F4 (DELIBERATE — documented, not a bug): Pause, Stop and
                // Dismiss all push fromUserMessage=false (pushInterruptToOffscreen(
                // chatId, false) from togglePause / stopAction / dismissAction), so
                // they take THIS branch and discard any un-flushed queued injection.
                // This is intentional: a non-user-message interrupt drops the queued
                // message to keep interrupt semantics simple. For PAUSE specifically
                // it means a not-yet-sent queued message is discarded by design (the
                // user must re-send after Resume). If a future change wants Pause to
                // PRESERVE the queued injection, gate this delete on the interrupt
                // kind rather than the fromUserMessage flag.
                if (!msg.fromUserMessage && pendingInjectionsByChatId[icid]) {
                    delete pendingInjectionsByChatId[icid];
                }
                if (interruptResolversByChatId[icid]) {
                    try { interruptResolversByChatId[icid](); } catch (e) {}
                }
                if (currentStreamAbortControllers[icid]) {
                    try { currentStreamAbortControllers[icid].abort(); } catch (e) {}
                }
            }
            return;

        case 'toggle-pause':
            // Set the flag FIRST. Main never emitted 'paused' here — the snackbar
            // fires either from the loop's pending-tool early-return emit, or
            // from the runFinished handler's isPaused branch after the stream
            // aborts. Emitting here would double-fire the snackbar.
            // FLUX-P1: route the flag through the pause facade → the SW lane
            // ingress (_swHandleChatMetaUpdate → the 'chat-meta-update' case
            // above): ONE arbiter applies pausedByUser (last-dispatch-wins),
            // SYNCHRONOUSLY syncs the derived pausedChats/pausedChatIds caches
            // (the SW agent loop's isChatPaused() resolves to core/030-config.js's
            // pausedChats-reading implementation — hoisted over the
            // worker/020-page-stubs.js fallback — and the `while (!isChatPaused)`
            // gate must trip before the abort below fires, or the loop would
            // catch the AbortError and `continue` into a fresh LLM call),
            // rehydrate-first persists chat.pausedByUser, and rebroadcasts
            // 'chat-meta-changed' to every panel. When the page's own
            // dispatchChatMeta already landed this value (FIFO: togglePause
            // dispatches before posting toggle-pause), the facade's no-op
            // guard makes this a free idempotent re-send.
            setChatPausedPersistent(msg.chatId, !!msg.paused);
            // POST-SW-RELOCATION FIX: the in-flight LLM stream's AbortController and
            // the tool interrupt resolver live HERE in the SW now, not on the panel.
            // The panel-side togglePause still calls abort()/resolver() but its copies
            // of those maps are empty no-ops after the loop moved to the SW — so
            // without the lines below, Pause never aborts the current call. It would
            // only take effect at the next loop-iteration boundary (after the whole
            // streaming turn AND its tool batch finish), which reads to the user as
            // "Pause does nothing". Mirror the `interrupt` handler so Pause aborts the
            // in-flight stream / running tool immediately, as documented.
            //
            // We do this only when PAUSING (not on resume), and we must NOT set
            // userInterruptedChats: that flag makes the loop label abandoned tools as
            // "user sent a new message". Leaving it false makes the loop record the
            // correct "abandoned — paused by user" placeholder (030-agent-loop.js:879).
            // The stream catch sees an AbortError, drops the partial assistant msg,
            // and `continue`s — the while-gate then exits because the flag is set.
            if (msg.paused && msg.chatId) {
                // PR-PAUSE (R3): the in-loop throttle backoff
                // (app/030-agent-loop.js) parks on a timer that only the
                // provider-change resolver could cancel — a pause during a
                // 30s backoff sat out the whole sleep before standing down.
                if (providerChangeBackoffResolversByChatId[msg.chatId]) {
                    try { providerChangeBackoffResolversByChatId[msg.chatId](); } catch (e) {}
                    delete providerChangeBackoffResolversByChatId[msg.chatId];
                }
                if (interruptResolversByChatId[msg.chatId]) {
                    try { interruptResolversByChatId[msg.chatId](); } catch (e) {}
                }
                if (currentStreamAbortControllers[msg.chatId]) {
                    try { currentStreamAbortControllers[msg.chatId].abort(); } catch (e) {}
                }
                // PR-PAUSE (R1): propagate to the live sub-agent subtree. The
                // registry owns the walk (it holds _subAgents / the pool) and
                // applies the same pause lane + abort trio per sub, skipping
                // parked/sleeping/terminal subs.
                // B2: ONLY when the sender asked for it (msg.propagate === true,
                // set by every USER-initiated pause/resume: app/020 togglePause,
                // tools/120 pauseAction/resumeAction, app/040 send-message
                // unpause, ui/170 summary runs → pushPauseToggleToOffscreen). stopAction /
                // dismissAction (tools/120-actions.js) reuse toggle-pause as a
                // loop-halt signal and must NOT record the subs into
                // _pausedByParentChat (Stop would leave them paused with
                // pending handles forever; dismiss's deferred unpause would
                // restart the dismissed action's subs headless). Pre-#874
                // behaviour for those callers is preserved: subs untouched.
                if (msg.propagate === true && typeof SubAgents !== 'undefined' && SubAgents.pauseDescendantsOfChat) {
                    try { SubAgents.pauseDescendantsOfChat(msg.chatId); }
                    catch (e) { console.warn('[port-bridge] pauseDescendantsOfChat threw', e); }
                }
            } else if (!msg.paused && msg.chatId) {
                // PR-PAUSE (R4): resume propagates too — subs FIRST (their
                // runs are re-entered through the sub-agent pool, keeping
                // every stream event on the sub's own chatId), then the panel
                // kicks runAgent for the parent.
                if (msg.propagate === true && typeof SubAgents !== 'undefined' && SubAgents.resumeDescendantsOfChat) {
                    try { SubAgents.resumeDescendantsOfChat(msg.chatId); }
                    catch (e) { console.warn('[port-bridge] resumeDescendantsOfChat threw', e); }
                }
            }
            return;

        case 'pull-chat':
            // Sweep 753-773 (F1-pullchat-tombstone): never reply with a soft-
            // deleted chat — the page assigns the snapshot WHOLESALE (app/045
            // 'chat-snapshot') with no _deleted guard, resurrecting a ghost row.
            // Mirrors _serializeChatsSnapshot and broadcastAgentEvent filters.
            if (!msg.chatId) return;
            // Tombstone: never resurrect a soft-deleted chat, and never "heal"
            // it from a doomed disk row either — the delete lane owns it.
            if (chats[msg.chatId] && chats[msg.chatId]._deleted) return;
            if (chats[msg.chatId] && chats[msg.chatId].messages && chats[msg.chatId].messages.length > 0) {
                // MEMFIX: the SW's copy may be payload-evicted (worker loader
                // strips all chats). The page assigns this snapshot WHOLESALE
                // (app/045), which would clobber a hydrated page copy with an
                // evicted one — rehydrate before replying. ensureChatPayloads
                // never rejects and is a fast no-op for hydrated chats.
                var _pcSend = function() {
                    if (!chats[msg.chatId] || chats[msg.chatId]._deleted) return;
                    try {
                        port.postMessage({ type: 'chat-snapshot', chatId: msg.chatId, chat: chats[msg.chatId] });
                    } catch (e) {}
                };
                if (chats[msg.chatId]._payloadsEvicted && typeof ensureChatPayloads === 'function') {
                    ensureChatPayloads(msg.chatId).then(_pcSend);
                } else {
                    _pcSend();
                }
                return;
            }
            // STUB-HEAL (root cause A): the SW map lacks the chat entirely
            // (MV3 restart before/without a boot row for it, or a sub-agent
            // transcript reclaimed from memory) or only holds an EMPTY stub
            // (e.g. the spawn-time chats[chat_id] seed in core/097, or an
            // empty panel snapshot adopted via FLUX-H2). Previously this lane
            // went silent (map miss) or replied with the empty stub — the
            // panel could NEVER hydrate a transcript that is sitting whole in
            // IDB. Fall back to the disk row and reply with it when it is a
            // real transcript. Rare miss/empty path only — a populated SW
            // copy takes the fast path above with zero extra reads.
            if (typeof loadChatRowFromDB === 'function') {
                loadChatRowFromDB(msg.chatId).then(function(row) {
                    var live = chats[msg.chatId];
                    if (live && live._deleted) return; // deleted while reading
                    // The SW copy gained messages while the read was in
                    // flight (a run started / a snapshot was adopted) — the
                    // LIVE copy is now the authority, not the disk row.
                    if (live && live.messages && live.messages.length > 0) {
                        try {
                            port.postMessage({ type: 'chat-snapshot', chatId: msg.chatId, chat: live });
                        } catch (e) {}
                        return;
                    }
                    if (!row || row._deleted || !(row.messages && row.messages.length > 0)) return;
                    // v16 rows keep heavy payloads in the chat_payloads store
                    // — flag the reply so the page save put-loop skips this
                    // copy (identical to disk) and selectChat's
                    // ensureChatPayloads gate rehydrates images lazily.
                    row._payloadsEvicted = true;
                    // Reply WITHOUT adopting the row into the SW map: the
                    // sub-agent GC / boot loader own SW residency; this lane
                    // only exists to feed the asking panel.
                    try {
                        port.postMessage({ type: 'chat-snapshot', chatId: msg.chatId, chat: row });
                    } catch (e) {}
                });
            }
            return;

        case 'dev-mode':
            // runtime_inspect dev-mode flag. Pushed by the page's
            // _pushDevModeToSW (tools/140-runtime-inspect.js) on bus connect
            // and whenever updateReloadBtnVisibility recomputes the gate.
            // Consumed by getEnabledTools (worker/025-permissions-helpers.js)
            // and the devOnly skill gate (_devModeActiveSync).
            self._swDevModeActive = !!msg.active;
            return;

        case 'pull-debug-state':
            // runtime_inspect action:'sw_state' — reply with a summary of the
            // SW's live run/tool state. Every global is typeof-guarded: this
            // handler must never throw on a partially-initialized SW.
            try {
                var _dbgParked = {};
                if (typeof parkedToolCallsByChatId !== 'undefined') {
                    Object.keys(parkedToolCallsByChatId).forEach(function(cid) {
                        var _pArr = parkedToolCallsByChatId[cid];
                        if (_pArr && _pArr.length) _dbgParked[cid] = _pArr.length;
                    });
                }
                var _dbgPending = [];
                if (typeof _pendingUIToolCalls !== 'undefined') {
                    Object.keys(_pendingUIToolCalls).forEach(function(tcid) {
                        var _pe = _pendingUIToolCalls[tcid];
                        _dbgPending.push({ toolCallId: tcid, startedAt: (_pe && _pe.startedAt) || null });
                    });
                }
                port.postMessage({ type: 'debug-state', requestId: msg.requestId, state: {
                    runningChatIds: (typeof runningChatIds !== 'undefined') ? Object.keys(runningChatIds).filter(function(c) { return runningChatIds[c]; }) : [],
                    pendingUIToolCalls: _dbgPending,
                    parkedToolCalls: _dbgParked,
                    connectedPorts: (typeof _swPanelPorts !== 'undefined') ? _swPanelPorts.size : null,
                    resumeScanSettled: (typeof _swResumeScanSettled !== 'undefined') ? !!_swResumeScanSettled : null,
                    devMode: !!self._swDevModeActive
                } });
            } catch (e) { /* port died — the page side times out after 5s */ }
            return;

        case 'update-chat':
            // Panel-side mutations OUTSIDE a run (title rename, manual edit).
            // Same authoritative-writer rule as `run-agent`: never replace
            // chats[chatId] while a run is in flight for it, otherwise we
            // clobber the SW's in-flight tool_result placeholders / partial
            // assistant message and the next save persists an orphan shape.
            // EXPLICIT-DELETE (tombstone lane) — checked BEFORE the guard
            // below. A `_deleted` payload is not a stale panel snapshot, it is
            // the user's delete command: deleteChat (ui/170-chat-management.js)
            // posts { messages: [], _deleted: true } over this same
            // 'update-chat' type. Dropping it because the chat is still
            // registered as running is exactly how a deleted RUNNING chat
            // resurrected — the page aborts the run and posts the tombstone in
            // the same tick, this guard dropped it, and the next tool-boundary
            // save re-put the row. A tombstone must never be silently dropped,
            // so it is accepted unconditionally. That cannot clobber in-flight
            // state: the loop captured its OWN reference to the record at run
            // entry (`chat = chats[streamingChatId]`, app/030-agent-loop.js:538)
            // and never re-reads the map, so an aborting run keeps writing to
            // its detached object — which is never persisted again, because
            // only entries still IN this map are saved. The tombstone itself
            // can never be re-put (the save's desired filter keeps only
            // messages.length > 0, worker/115-storage.js). PR 3: saves are
            // upsert-only — the row is removed NOW by scheduleChatRowDelete
            // (worker/115-storage.js): a targeted deleteChatRow('user-delete')
            // with a bounded in-SW retry (_pendingDeletes, 3 tries + backoff).
            // The tombstone stays parked HERE until that lane verifies the row
            // gone, then it is dropped (RFC addendum §2.4/§4.1). It carries no
            // payload ids, so the delete touches the chat ROW only and never
            // chat_payloads blobs (the page-side delete owns those; it has the
            // full pre-delete record AND a hydration gate).
            if (msg.chatId && msg.chat && msg.chat._deleted === true) {
                chats[msg.chatId] = msg.chat;
                if (typeof scheduleChatRowDelete === 'function') {
                    try {
                        Promise.resolve(scheduleChatRowDelete(msg.chatId, msg.chat)).then(function(ok) {
                            if (!ok) console.warn('[port-bridge] tombstone: targeted delete of chat ' + msg.chatId + ' did not complete on the first attempt — the _pendingDeletes lane (worker/115-storage.js) is retrying it');
                        }, function(eD) {
                            console.error('[port-bridge] tombstone: targeted delete threw for chat ' + msg.chatId, eD);
                        });
                    } catch (eD2) { console.error('[port-bridge] tombstone: targeted delete threw for chat ' + msg.chatId, eD2); }
                } else if (typeof deleteChatFromDB === 'function') {
                    // Belt-and-braces fallback — same bundle, so this arm should
                    // be unreachable; a single unretried attempt is still better
                    // than parking the tombstone with no delete at all.
                    try { Promise.resolve(deleteChatFromDB(msg.chatId, msg.chat)).catch(function() {}); } catch (eD3) {}
                }
                return;
            }
            if (msg.chatId && msg.chat && !runningChatIds[msg.chatId]
                && !(typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard[msg.chatId])) {
                // FLUX-4C review fix A: this blind put is the OTHER path where a
                // panel snapshot becomes canonical SW state, so it needs the same
                // chat-meta overlay the run-agent adopt does. Without it a stale
                // DEFINED flag in the panel replica overwrote the SW's canonical
                // value here and then won over disk (record-defined-wins in
                // worker/115-storage.js) — worse than pre-lane behaviour.
                try {
                    _swOverlayChatMeta(chats[msg.chatId] || _swChatMetaPendingByChatId[msg.chatId], msg.chat);
                    delete _swChatMetaPendingByChatId[msg.chatId];
                } catch (e) { console.warn('[port-bridge] chat-meta update-chat overlay failed', msg.chatId, e); }
                chats[msg.chatId] = msg.chat;
            }
            return;

        case 'record-mutation':
            // A PAGE-TIER tool execution (widget executeTool in
            // ui/070-dashboard-ui.js runs servicenow_api / servicenow_diff_edit
            // in the panel) appended a versionHistory entry to the page's
            // NON-authoritative chats mirror only (trackRecordMutation in
            // tools/020-tool-execution.js). The SW owns chats[chatId], so
            // without this append the next chat-inlined snapshot broadcast /
            // SW saveChatsToStorage drops the entry and the record vanishes
            // from the sidebar Artifacts list. Append it to the authoritative
            // copy — deduped by entry.id, because the page may also round-trip
            // the same entry back inside a run-agent / update-chat snapshot —
            // and persist. Gated on the boot promise so a cold-boot arrival
            // doesn't touch an un-hydrated `chats` (same rationale as the
            // 'send-message' gate above; a missing chat after boot means the
            // SW never saw it — the page's own IDB save already carries the
            // entry in that case).
            (self._swBootReady || Promise.resolve()).then(function() {
                // Sweep 753-773 (771-2): the K=0 post-commit sweep leaves cold
                // chats _payloadsEvicted as steady state, and BOTH realms' put-
                // loops skip evicted chats (worker/115-storage.js) — so this
                // append was held only in SW memory and silently lost on the
                // next SW restart. Rehydrate first (same pattern as 'pull-chat'
                // above); ensureChatPayloads never rejects and is a fast no-op
                // for hydrated chats.
                var _rmAppend = function() {
                try {
                    var rmEntry = msg.entry;
                    var rmChat = msg.chatId ? chats[msg.chatId] : null;
                    if (!rmChat || !rmEntry || !rmEntry.id) return;
                    if (!Array.isArray(rmChat.versionHistory)) rmChat.versionHistory = [];
                    var rmDup = rmChat.versionHistory.some(function(v) { return v && v.id === rmEntry.id; });
                    if (rmDup) return;
                    rmChat.versionHistory.push(rmEntry);
                    // MEMFIX: same cap as the other append sites (VERSION_HISTORY_CAP
                    // in core/030-config.js, shared into this bundle) — this is the
                    // SW-authoritative append for widget-tier mutations, so without
                    // it those chats' histories grew unbounded and snapshot
                    // broadcasts overwrote the page's capped mirror.
                    if (typeof VERSION_HISTORY_CAP !== 'undefined' && rmChat.versionHistory.length > VERSION_HISTORY_CAP) {
                        rmChat.versionHistory.splice(0, rmChat.versionHistory.length - VERSION_HISTORY_CAP);
                    }
                    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
                } catch (e) { console.error('[port-bridge] record-mutation append failed', msg.chatId, e); }
                };
                var _rmChat0 = msg.chatId ? chats[msg.chatId] : null;
                if (_rmChat0 && _rmChat0._payloadsEvicted && typeof ensureChatPayloads === 'function') {
                    ensureChatPayloads(msg.chatId).then(_rmAppend);
                } else {
                    _rmAppend();
                }
            });
            return;

        case 'widget-persist':
            // Manual "edit widget code" save (saveWidgetCodeEdit in
            // tools/080-widget-tools.js). The page already wrote its own chats
            // mirror + IDB, but the SW is the authoritative writer: it keeps its
            // own copy of every adopted chat and its saveChatsToStorage re-puts
            // them all after every tool result (worker/115-storage.js), which
            // used to silently revert the manual edit. Upsert by widget id — the
            // SAME merge the agent path's result._widget_persist gets in
            // worker/120-tool-routing.js — then persist. Boot-gated like
            // 'record-mutation'; a missing chat after boot means the SW never
            // adopted it, so there is no stale SW snapshot to clobber the page's
            // own IDB save (skip loudly, mirroring the tool-routing warn).
            (self._swBootReady || Promise.resolve()).then(function() {
                // FLUX-4/2 (evicted no-op): the upsert below mutates the SW
                // record, but a cold chat is _payloadsEvicted in steady state
                // and BOTH realms' put-loops SKIP evicted chats
                // (worker/115-storage.js) — so the save was a silent no-op and
                // the manual widget edit reverted on the next SW restart /
                // snapshot broadcast. Rehydrate FIRST, then upsert + save —
                // the same rehydrate-first pattern as 'chat-meta-update' and
                // 'record-mutation'; ensureChatPayloads never rejects and is
                // a fast no-op for hydrated chats.
                var _wpApply = function() {
                try {
                    var wpW = msg.widget;
                    var wpChat = msg.chatId ? chats[msg.chatId] : null;
                    if (!wpW || !wpW.id) return;
                    if (!wpChat) {
                        console.warn('[port-bridge] widget-persist skipped: no SW record for chat '
                            + msg.chatId + ' (widget ' + wpW.id + ')');
                        return;
                    }
                    if (!Array.isArray(wpChat.widgets)) wpChat.widgets = [];
                    var wpIdx = wpChat.widgets.findIndex(function(w) { return w && w.id === wpW.id; });
                    if (wpIdx !== -1) wpChat.widgets[wpIdx] = wpW;
                    else wpChat.widgets.push(wpW);
                    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
                } catch (e) { console.error('[port-bridge] widget-persist upsert failed', msg.chatId, e); }
                };
                var _wpChat0 = msg.chatId ? chats[msg.chatId] : null;
                if (_wpChat0 && _wpChat0._payloadsEvicted && typeof ensureChatPayloads === 'function') {
                    ensureChatPayloads(msg.chatId).then(_wpApply);
                } else {
                    _wpApply();
                }
            });
            return;

        case 'exec-tool-result':
            resolvePendingUIToolCall(msg.toolCallId, msg.result, msg.error);
            return;

        case 'exec-approval-prompt-result':
            // AB-2: first-verdict-wins — the pending entry exists only until
            // the first result deletes it (resolvePendingUIToolCall), so a
            // late verdict from another panel resolves nothing AND skips the
            // settle broadcast below (clean no-op, like exec-tool dups).
            var _abEntry = _pendingUIToolCalls[msg.approvalRequestId];
            resolvePendingUIToolCall(msg.approvalRequestId,
                { allowed: !!msg.allowed }, msg.error || null);
            if (_abEntry && _abEntry.isApproval && typeof _swSettleApprovalRow === 'function') {
                _swSettleApprovalRow(
                    msg.chatId || _abEntry.chatId,
                    msg.toolCallId || _abEntry.toolCallId,
                    msg.status || null,
                    !!msg.allowed);
            }
            return;

        case 'prompt-user-pending':
            // MP-1: the executing panel just pushed a pending prompt_user row
            // into its page mirror. Seed it into the SW's authoritative copy
            // NOW (not after resolve) so every panel's snapshot renders the
            // live form. Implementation lives in worker/120-tool-routing.js.
            if (typeof _swSeedPromptRow === 'function') _swSeedPromptRow(msg.chatId, msg.row);
            return;

        case 'prompt-user-result':
            // MP-2: a panel WITHOUT the armed resolver collected submit/cancel
            // values. Reconcile the row (first-submit-wins) and route the
            // result to the executing panel's resolver — or settle the
            // pending/parked call directly when that panel is gone.
            if (typeof _swSettleRemotePrompt === 'function') _swSettleRemotePrompt(msg, port);
            return;

        case 'hooks-settings':
            // Panel toggled a hook (auto-title / showHookMessages). Mirror the
            // new value so the SW's executeAfterResponseHooks + getEnabledTools
            // observe it immediately, without waiting for SW restart.
            if (msg.hooksEnabled && typeof msg.hooksEnabled === 'object') {
                hooksEnabled = msg.hooksEnabled;
            }
            return;

        case 'deferred-tools-setting':
            // Panel toggled deferred tool loading (Settings). Mirror so the
            // SW's getEnabledTools / getToolCatalogForPrompt observe it
            // immediately, without waiting for SW restart — same pattern as
            // 'hooks-settings'. The global lives in core/030-config.js
            // (WORKER_SHARED_FILES); pushed by
            // pushDeferredToolsSettingToOffscreen (045-agent-port-bridge-page.js).
            deferredToolsEnabled = !!msg.enabled;
            return;

        case 'skills-refresh':
            // Panel finished importEmbeddedSkills() (or activated/deactivated a
            // skill). Re-run loadActiveSkills so the SW's `skillTools` registry
            // picks up skills that did not exist in IDB when the SW booted.
            // Without this, a freshly shipped embedded skill's tools stay
            // invisible to isSkillTool() / getActiveSkillTools() in the SW until
            // the next service-worker restart.
            if (typeof loadActiveSkills === 'function') {
                Promise.resolve(loadActiveSkills()).catch(function(e) {
                    console.warn('[sw-runtime] skills-refresh failed', e);
                });
            }
            return;

        case 'permissions-update':
            // Panel mutated a permission source. Three independent slots:
            //   • toolPermissions   — "Always allow" + settings-page edits
            //   • instancePermissions — per-host overrides
            //   • sessionPermissions — "Allow for session" (in-memory only)
            // Each is sent individually (null when unchanged) so the panel can
            // push just the slot that moved. Without this, the SW's
            // getToolPermission keeps returning 'ask' after the user picks
            // "Allow for session" / "Always allow", and the approval prompt
            // keeps firing on every tool call.
            var _permChanged = {};
            // FLUX-4/1 (per-key merge): panels with a synced baseline dispatch
            // DELTAS ({set:{k:v}, del:[k]}, app/045 pushPermissionsToOffscreen)
            // instead of whole maps, so two panels editing DIFFERENT keys
            // concurrently both survive — the whole-map replace below made the
            // later dispatch clobber the earlier edit. Explicit deletions ride
            // the delta (a pure per-key merge never deletes). Full maps are
            // still accepted below: initial sync from a panel with no baseline
            // yet. Delta application still flows into _permChanged, so the F6
            // persist + full-map rebroadcast below are unchanged.
            var _applyPermDelta = function(slot, cur) {
                var d = msg[slot + 'Delta'];
                if (!d || typeof d !== 'object') return cur;
                var map = (cur && typeof cur === 'object') ? cur : {};
                if (d.set && typeof d.set === 'object') {
                    Object.keys(d.set).forEach(function(k) { map[k] = d.set[k]; });
                }
                if (Array.isArray(d.del)) {
                    d.del.forEach(function(k) { delete map[k]; });
                }
                _permChanged[slot] = map;
                return map;
            };
            toolPermissions = _applyPermDelta('toolPermissions', toolPermissions);
            instancePermissions = _applyPermDelta('instancePermissions', instancePermissions);
            sessionPermissions = _applyPermDelta('sessionPermissions', sessionPermissions);
            if (msg.toolPermissions && typeof msg.toolPermissions === 'object') {
                toolPermissions = msg.toolPermissions;
                _permChanged.toolPermissions = toolPermissions;
            }
            if (msg.instancePermissions && typeof msg.instancePermissions === 'object') {
                instancePermissions = msg.instancePermissions;
                _permChanged.instancePermissions = instancePermissions;
            }
            if (msg.sessionPermissions && typeof msg.sessionPermissions === 'object') {
                sessionPermissions = msg.sessionPermissions;
                _permChanged.sessionPermissions = sessionPermissions;
            }
            // F6 (single IDB writer): the SW persists the durable slots
            // itself — panels no longer write permission maps to IDB at all
            // (ui/080-scope.js dispatches here instead of setSetting).
            // sessionPermissions is deliberately NOT persisted: session
            // grants live and die with the SW (RFC §4.5). The dirty flag
            // stops a boot-time loadToolPermissionsInWorker whose IDB read
            // resolves AFTER this dispatch from clobbering the fresher edit
            // (worker/020-page-stubs.js).
            if (_permChanged.toolPermissions) {
                _swPermsDirty.toolPermissions = true;
                if (typeof setSetting === 'function') {
                    try { Promise.resolve(setSetting('toolPermissions', toolPermissions)).catch(function(e) { console.warn('[sw-runtime] toolPermissions persist failed', e); }); } catch (e) { console.warn('[sw-runtime] toolPermissions persist threw', e); }
                }
            }
            if (_permChanged.instancePermissions) {
                _swPermsDirty.instancePermissions = true;
                if (typeof setSetting === 'function') {
                    try { Promise.resolve(setSetting('instancePermissions', instancePermissions)).catch(function(e) { console.warn('[sw-runtime] instancePermissions persist threw', e); }); } catch (e) { console.warn('[sw-runtime] instancePermissions persist threw (sync)', e); }
                }
            }
            // QW9 (flux single-writer, step 1): after applying, REBROADCAST
            // the changed slots to every connected panel as
            // 'permissions-changed'. Before this, a permission edited in
            // panel A never reached panel B's replicas until B reloaded —
            // and B's next push (settings save, session allow) could then
            // clobber the SW with stale maps (RFC F6). Echoing to the
            // sender too is intentional and safe: the page handler only
            // overwrites its replicas with the applied values and never
            // re-pushes or persists on receive, so no loop.
            if (typeof _swPanelPorts !== 'undefined' && (_permChanged.toolPermissions || _permChanged.instancePermissions || _permChanged.sessionPermissions)) {
                _permChanged.type = 'permissions-changed';
                _swPanelPorts.forEach(function(p) {
                    try { p.postMessage(_permChanged); } catch (e) { /* dead port — disconnect handler cleans up */ }
                });
            }
            return;

        case 'chat-meta-update':
            // FLUX-4C: a panel dispatched a chat-meta edit (pin, jobs-hide,
            // error set/clear, view/activity/finish stamps). The SW is the
            // single owner: whitelist-validate, apply (timestamps max-wins,
            // flags last-dispatch-wins), persist, and rebroadcast the applied
            // fields to EVERY panel ('chat-meta-changed', echo included —
            // the page apply is idempotent and never re-dispatches, so no
            // loop; mirrors the permissions-update lane above).
            if (!msg.chatId || !msg.fields || typeof msg.fields !== 'object') return;
            var _cmFields = null;
            CHAT_META_TS_FIELDS.forEach(function(f) {
                if (typeof msg.fields[f] === 'number' && isFinite(msg.fields[f])) { (_cmFields = _cmFields || {})[f] = msg.fields[f]; }
            });
            CHAT_META_FLAG_FIELDS.forEach(function(f) {
                if (msg.fields[f] !== undefined) { (_cmFields = _cmFields || {})[f] = msg.fields[f]; }
            });
            // FLUX-T1: the title VALUE (+ its titleProvisional rider) passes
            // the whitelist ONLY as a complete pair — the TS loop above
            // admitted titleUpdatedAt; attach the value or drop the bare
            // stamp (pair atomicity: a stamp without a value would advance
            // the compare and block the real pair forever).
            if (_cmFields && _cmFields.titleUpdatedAt !== undefined) {
                if (typeof msg.fields.title === 'string' && msg.fields.title) {
                    _cmFields.title = msg.fields.title;
                    if (msg.fields.titleProvisional === true) _cmFields.titleProvisional = true;
                } else {
                    delete _cmFields.titleUpdatedAt;
                    if (Object.keys(_cmFields).length === 0) _cmFields = null;
                }
            }
            if (!_cmFields) return;
            var _cmChat = chats[msg.chatId];
            // Tombstoned chat: drop — the meta lane must never resurrect a
            // deleted chat (matches the update-chat delete lane semantics).
            if (_cmChat && _cmChat._deleted) return;
            // FLUX-P1: pausedChats / pausedChatIds are DERIVED caches of the
            // lane's pausedByUser flag — this ingress is their single SW-realm
            // writer (plus the boot fold in worker/115-storage.js). Synced
            // BEFORE the held/buffer branches so the agent loop's
            // `while (!isChatPaused)` gate sees a pause the same tick it
            // arrives, even in the pre-hydration boot window.
            if (_cmFields.pausedByUser !== undefined) {
                var _cmPv = _cmFields.pausedByUser === true;
                pausedChatIds[msg.chatId] = _cmPv;
                if (typeof pausedChats !== 'undefined') pausedChats[msg.chatId] = _cmPv;
            }
            if (_cmChat) {
                _swApplyChatMetaFields(_cmChat, _cmFields);
                if (typeof _chatsHydrated !== 'undefined' && !_chatsHydrated) {
                    // FLUX-H2/H3 (boot window): the record was adopted pre-
                    // hydration — saveChatsToStorage is wipe-guarded right now,
                    // and the boot getAll will overlay DISK meta over this
                    // record (loadChatsFromStorage). Route the dispatch through
                    // the buffer lane too: the pending entry is re-folded after
                    // the disk overlay (last-dispatch-wins preserved) and the
                    // chained RMW makes it durable even if the SW dies mid-boot.
                    _swBufferChatMetaDispatch(msg.chatId, _cmFields);
                } else {
                    // FLUX-H1: a held chat is _payloadsEvicted in steady state
                    // (the SW boot marks EVERY hydrated chat evicted and the
                    // K=0 sweep re-evicts cold ones) and BOTH realms' put-loops
                    // SKIP evicted chats — so the old bare save was a silent
                    // no-op for idle chats: pin / jobs-hide / stamps reverted on
                    // the next SW restart. Rehydrate FIRST, then save — the
                    // same pattern as the 'record-mutation' handler below and
                    // 'pull-chat' above; ensureChatPayloads never rejects and
                    // is a fast no-op for hydrated chats.
                    var _cmHydrate = (_cmChat._payloadsEvicted && typeof ensureChatPayloads === 'function')
                        ? ensureChatPayloads(msg.chatId)
                        : Promise.resolve();
                    if (typeof saveChatsToStorage === 'function') {
                        try { _cmHydrate.then(function() { return saveChatsToStorage(); }).catch(function(e) { console.warn('[sw-runtime] chat-meta persist failed', e); }); } catch (e) { console.warn('[sw-runtime] chat-meta persist threw', e); }
                    }
                }
            } else {
                _swBufferChatMetaDispatch(msg.chatId, _cmFields);
            }
            // FLUX-T1 (canonical rebroadcast): for the title pair the
            // rebroadcast must carry the ARBITER'S decision, not the raw
            // dispatch — a losing rename (older/tied stamp) rebroadcast
            // verbatim would fan a stale pair out to panels that never saw
            // the winner. Read the merged pair back off the applied target
            // (held record, or the pending bag for a not-held chat).
            if (_cmFields.titleUpdatedAt !== undefined) {
                var _cmCanon = _cmChat || _swChatMetaPendingByChatId[msg.chatId];
                if (_cmCanon && typeof _cmCanon.titleUpdatedAt === 'number' && isFinite(_cmCanon.titleUpdatedAt)
                    && typeof _cmCanon.title === 'string' && _cmCanon.title) {
                    _cmFields.title = _cmCanon.title;
                    _cmFields.titleUpdatedAt = _cmCanon.titleUpdatedAt;
                    if (_cmCanon.titleProvisional === true) _cmFields.titleProvisional = true;
                    else delete _cmFields.titleProvisional;
                }
            }
            if (typeof _swPanelPorts !== 'undefined') {
                var _cmBcast = { type: 'chat-meta-changed', chatId: msg.chatId, fields: _cmFields };
                _swPanelPorts.forEach(function(p) {
                    try { p.postMessage(_cmBcast); } catch (e) { /* dead port — disconnect handler cleans up */ }
                });
            }
            return;

        case 'focus-chat':
            // SAGF-1: the page tells us which chat the user is now viewing so
            // the sub-agent GC paths (_idleSweepTick / loadAllSubAgents) don't
            // reclaim a tombstone/abandoned-sleep transcript mid-read. In the SW
            // currentChatId is permanently null, so this is the only focus signal.
            if (typeof SubAgents !== 'undefined' && SubAgents.setFocusedChat) {
                // SWM2-F2: pass a stable per-panel key so multiple panels each viewing
                // a different chat don't clobber each other's focus (last-writer-wins
                // would GC the other panel's viewed transcript). One panel → one key →
                // identical to the pre-F2 single-focus behavior. A null msg.chatId
                // (user left the chat view) clears just THIS port's entry.
                SubAgents.setFocusedChat(msg.chatId, _panelId(port));
            }
            return;

        case 'panel-hello':
            // Panel declares which tool executions it's still running AND
            // which it finished but whose result may not have been
            // persisted (in case the previous SW died right after the
            // dispatch). tool-routing.js marks both as adopted so the
            // executeTool wrapper short-circuits to the buffered result
            // instead of dispatching a duplicate exec-tool.
            if (typeof self._swAdoptPanelInflight === 'function') {
                // SWM3F-1: pass the connecting port so adopted in-flight tools
                // record the adopting panel's port — lets _unregisterPanel see
                // (and clean-reject) them if that panel later disconnects.
                self._swAdoptPanelInflight({
                    inflightToolCalls: msg.inflightToolCalls || [],
                    completedToolResults: msg.completedToolResults || []
                }, port);
            }
            // Belt-and-braces skill-tool re-hydration: the explicit
            // 'skills-refresh' push from core/120-init.js is skipped when the
            // agent bus port isn't open yet at import time, so also refresh
            // whenever a panel (re)connects — but ONLY when the SW's registry
            // is actually empty.
            //   WHY THE GATE: loadActiveSkills() (core/140-skills-engine.js)
            //   reassigns the global `activeSkills` and then does an IDB
            //   getSkillAssets read + TOOL_DEFINITION regex parse for EVERY
            //   active skill (~20+). Running that on every panel open/close
            //   and every SW wake is pure waste, and swapping `activeSkills`
            //   out mid-flight can race an agent run that is reading it.
            //   When `skillTools` already has entries the SW is hydrated (the
            //   boot path in worker/190-entry.js did it), so there is nothing
            //   to re-read. A genuine activate/deactivate still arrives via
            //   the explicit 'skills-refresh' message handled above, and a
            //   fresh install (empty registry) still self-heals here.
            var _swSkillsHydrated = false;
            try {
                _swSkillsHydrated = (typeof skillTools !== 'undefined' && skillTools
                    && Object.keys(skillTools).length > 0);
            } catch (e) { _swSkillsHydrated = false; }
            if (!_swSkillsHydrated && typeof loadActiveSkills === 'function') {
                Promise.resolve(loadActiveSkills()).catch(function(e) {
                    console.warn('[sw-runtime] panel-hello skills refresh failed', e);
                });
            }
            return;

        case 'relay-agent-event':
            // WSM-RELAY: a panel relays a PAGE-LOCAL emit here so it reaches
            // the other panels — re-emitting on the SW bus hands it to the
            // worker/100 broadcast patch, which forwards it to every connected
            // panel (including the origin; its handlers are idempotent
            // renders). The _relayed stamp stops the origin's relay hook from
            // bouncing it back. Whitelisted event types only — this is a
            // broadcast amplifier, keep it to workspace-level events.
            if (msg.eventType === 'workspaceMutated' && msg.detail &&
                typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
                try {
                    AgentEvents.emit('workspaceMutated', Object.assign({}, msg.detail, { _relayed: true }));
                } catch (e) {}
            }
            return;

        case 'prepare-reload':
            // RELOAD-DB: the panel is about to call chrome.runtime.reload(). Close
            // THIS service worker's cached IDB connection cleanly before the abrupt
            // context teardown -- an abandoned open connection can make Chrome
            // force-close the origin's IndexedDB backing store, wedging the DB
            // (open() hangs / UnknownError) until a full browser restart. Also close
            // the offscreen doc (best-effort) so it isn't torn down mid-flight.
            try { if (typeof closeDatabase === 'function') closeDatabase(); } catch (e) {}
            try {
                if (typeof chrome !== 'undefined' && chrome.offscreen && chrome.offscreen.closeDocument) {
                    Promise.resolve(
                        chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : true
                    ).then(function(has) {
                        if (has) { try { chrome.offscreen.closeDocument(); } catch (e) {} }
                    }).catch(function() {});
                }
            } catch (e) {}
            return;
    }
}

// SWM-S1: extract the trailing user-input block of an incoming chat snapshot
// that the SW's own copy does NOT have. Used by the run-agent handler's
// flap-recovery path above. Walks the snapshot tail collecting user-input
// rows (user text + screenshot/pdf/file attachment rows — the shapes the
// page's idle send path pushes), then drops any row already present in the
// SW copy's tail under a CONSERVATIVE identity check (exact role + content /
// base64 + name match) — preferring a skipped recovery over a double-inject.
// REG376-1: pendInj (optional) is the chat's un-flushed pendingInjectionsByChatId
// entry — candidates already queued there are 'seen' too, or a second flap
// inside the queue→flush window re-recovered and duplicated them.
// Returns { text, images, count } or null when nothing unseen remains.
function _extractUnseenTrailingUserInput(inChat, swChat, pendInj) {
    var inMsgs = (inChat && inChat.messages) || [];
    var swMsgs = (swChat && swChat.messages) || [];
    // REG-F4: include 'context' — the page's idle send path pushes a
    // role:'context' row AFTER the user row for Smart Document references
    // (app/040-send-message.js); without it the backward walk broke at the
    // context row and recovered NOTHING for a doc-referencing send.
    var TRAIL_ROLES = { user: 1, screenshot: 1, pdf: 1, file: 1, context: 1 };
    var block = [];
    for (var i = inMsgs.length - 1; i >= 0; i--) {
        var m = inMsgs[i];
        if (!m || !TRAIL_ROLES[m.role]) break;
        block.unshift(m);
    }
    if (!block.length) return null;
    // REG-F2 (revised): scan everything the SW added BEYOND the shared
    // prefix, not the entire SW copy. The page mirror is exactly
    // <shared prefix> + <trailing block>, so the prefix occupies SW indexes
    // 0..(inMsgs.length - block.length - 1) and anything the SW appended
    // while the port was down — including the tool-heavy 20+-row tails the
    // original bounded (+20) scan missed — sits at index >= that boundary.
    // Scanning from the boundary keeps REG-F2's guarantee (an already-
    // processed message arbitrarily deep in the SW tail is still found, no
    // double-inject + interrupt of a healthy stream) WITHOUT the full-scan
    // regression: with tailStart 0, a genuinely-new re-send whose text
    // equals ANY older row in the shared history ("yes", "ok", "continue")
    // dedup-matched the OLD occurrence and the recovery was silently
    // dropped.
    var tailStart = Math.max(0, inMsgs.length - block.length);
    function _seenInSwTail(cand) {
        // REG376-1: a cand already sitting in the un-flushed pending injection
        // (a previous flap's recovery the loop hasn't consumed yet) is seen —
        // it lives in NO chat row yet, so the SW-tail scan below cannot find
        // it. Text cands match whole or as a '\n\n'-boundary segment (pendInj
        // text is itself a '\n\n' join — same anchoring as the REG-AUDIT-1 row
        // check); attachment cands match on content/base64 + name.
        if (pendInj) {
            if ((cand.role === 'user' || cand.role === 'context') &&
                typeof cand.content === 'string' && cand.content &&
                typeof pendInj.text === 'string' && pendInj.text &&
                (pendInj.text === cand.content ||
                 ('\n\n' + pendInj.text + '\n\n').indexOf('\n\n' + cand.content + '\n\n') !== -1)) return true;
            if (cand.role !== 'user' && cand.role !== 'context' && pendInj.images && pendInj.images.length) {
                for (var k = 0; k < pendInj.images.length; k++) {
                    var pImg = pendInj.images[k];
                    if (cand.role === 'file') {
                        if (pImg.fileType === 'file' && pImg.content === cand.content && pImg.name === cand.name) return true;
                    } else if (pImg.base64 && pImg.base64 === cand.base64 && pImg.name === cand.name) return true;
                }
            }
        }
        for (var j = swMsgs.length - 1; j >= tailStart; j--) {
            var s = swMsgs[j];
            if (!s) continue;
            // REG-F4: a recovered context row is re-injected JOINED into a
            // single user row by flushPendingInjection (its content is appended
            // to the injected text), so dedup must also treat a user row
            // CONTAINING the context pointer as 'seen'. The bracketed pointer
            // carries a unique doc_id, so containment cannot false-positive
            // the way generic user text would.
            if (cand.role === 'context' && s.role === 'user' &&
                typeof s.content === 'string' && typeof cand.content === 'string' &&
                cand.content && s.content.indexOf(cand.content) !== -1) return true;
            if (s.role !== cand.role) continue;
            if (cand.role === 'user' || cand.role === 'context') {
                if (s.content === cand.content) return true;
                // REG-AUDIT-1: a recovered multi-row block (user text + context
                // rows) is re-injected by flushPendingInjection as ONE user row
                // whose content is texts.join('\n\n'). Exact equality alone
                // misses the original user cand inside that joined SW row
                // ("M2\n\nC" never === "M2") → a second port flap duplicated
                // the user's text. Treat the cand as seen when an SW user row
                // contains it as a '\n\n'-boundary-delimited segment; the
                // boundary anchoring (and multi-paragraph cands matching as a
                // whole) avoids generic substring false positives, and the
                // tailStart-bounded loop preserves #375's bounded-scan
                // guarantee.
                // REG376-2: containment applies ONLY to rows stamped
                // injected:true by flushPendingInjection (the only writer of
                // joined rows). Matching ANY user row dropped a genuinely-new
                // re-send whose text equaled a '\n\n'-paragraph of an earlier
                // organic multi-paragraph message. (Joined rows persisted
                // before the stamp existed lose containment dedup, but that
                // exposure is transient — only flap windows on already-running
                // chats are scanned.)
                if (s.role === 'user' && s.injected === true &&
                    typeof s.content === 'string' && typeof cand.content === 'string' && cand.content &&
                    s.content !== cand.content &&
                    ('\n\n' + s.content + '\n\n').indexOf('\n\n' + cand.content + '\n\n') !== -1) return true;
            } else if (cand.role === 'file') {
                if (s.content === cand.content && s.name === cand.name) return true;
            } else {
                if (s.base64 === cand.base64 && s.name === cand.name) return true;
            }
        }
        return false;
    }
    var texts = [];
    var images = [];
    // REG-F4: unseen context rows ride along inline in block order — their
    // content is already a self-describing bracketed pointer ("[User
    // referenced Smart Document ...]") so joining them into the injected text
    // preserves the doc_id for the model. They never count as recoverable user
    // input on their own: the page always pushes the user row first, so a
    // context-only unseen block means there is nothing genuinely new to
    // recover.
    var hasUserInput = false;
    block.forEach(function(m) {
        if (_seenInSwTail(m)) return;
        if (m.role === 'user') {
            if (typeof m.content === 'string' && m.content) { texts.push(m.content); hasUserInput = true; }
        } else if (m.role === 'context') {
            if (typeof m.content === 'string' && m.content) texts.push(m.content);
        } else if (m.role === 'pdf') {
            images.push({ fileType: 'pdf', base64: m.base64, name: m.name, file_id: m.file_id });
            hasUserInput = true;
        } else if (m.role === 'file') {
            images.push({ fileType: 'file', content: m.content, name: m.name, mimeType: m.mimeType, size: m.size, file_id: m.file_id });
            hasUserInput = true;
        } else {
            images.push({ fileType: 'image', base64: m.base64, name: m.name, width: m.width, height: m.height, file_id: m.file_id });
            hasUserInput = true;
        }
    });
    // REG-F4: context-only (or empty) recovery ⇒ nothing to recover.
    if (!hasUserInput) return null;
    return {
        text: texts.length ? texts.join('\n\n') : null,
        images: images.length ? images : null,
        count: texts.length + images.length
    };
}

// Handle a send-message from a panel.
//
// Two modes:
//   • Running chat — stash the text/images in pendingInjectionsByChatId
//     and fire the interrupt + stream abort. The loop's flushPendingInjection
//     (called from inside its catch/continue paths) pushes the user message
//     into chat.messages on the next iteration. We do NOT push here, or the
//     loop would push a duplicate.
//   • Idle chat — push the user message + attachments now, save to IDB,
//     and start a fresh run.
async function _handlePanelSendMessage(msg) {
    var chatId = msg.chatId;
    if (!chatId) return;
    // TOMBSTONE: `chats[chatId]` may be the {messages: [], _deleted: true}
    // tombstone parked by the 'update-chat' explicit-delete lane above. It is
    // TRUTHY, so the `if (!chats[chatId])` below leaves it in place and the
    // idle branch pushes the user message straight onto it — giving it
    // messages.length > 0, which re-admits it to `desired`
    // (worker/115-storage.js:116), drops it out of the unbudgeted
    // explicit-delete lane (:155) and RE-PUTS the deleted row at the
    // `await saveChatsToStorage()` below. That save runs BEFORE the runAgent
    // at the tail, so the tombstone guard in app/030-agent-loop.js does not
    // cover this path — it has to be stopped here. A send addressed to a chat
    // the user just deleted (stale panel mirror, or a queued send racing the
    // delete in the same tick) is not a chat the user wants resurrected.
    if (chats[chatId] && chats[chatId]._deleted) {
        console.warn('[port-bridge] send-message dropped: chat ' + chatId + ' is deleted (tombstone)');
        return;
    }
    if (!chats[chatId]) {
        // FLUX-4C review fix A: third path where a panel snapshot (or a bare
        // stub) becomes canonical state. Lane dispatches buffered for a chat
        // this SW never held (_swChatMetaPendingByChatId) are the only
        // canonical meta opinion that exists for it, so overlay them here too
        // and clear the entry — otherwise the snapshot's own stale values
        // become canonical and the buffered edit is applied a second time by a
        // later adopt.
        var _smChat = msg.chat || { id: chatId, messages: [] };
        try {
            _swOverlayChatMeta(_swChatMetaPendingByChatId[chatId], _smChat);
            delete _swChatMetaPendingByChatId[chatId];
        } catch (e) { console.warn('[port-bridge] chat-meta send-message overlay failed', chatId, e); }
        chats[chatId] = _smChat;
    }

    // MEMFIX: rehydrate a payload-evicted chat BEFORE the idle branch pushes
    // the user's message and awaits saveChatsToStorage — the save put-loop
    // skips evicted chats, so without this the just-typed message would never
    // persist (lost on SW death). Also needed so the run that follows can
    // inline vision blocks. ensureChatPayloads never rejects.
    if (typeof ensureChatPayloads === 'function') {
        try { await ensureChatPayloads(chatId); } catch (e) {}
    }

    // B10: the user sending a message means they intend this chat to run now —
    // clear any stale SW-side pause flag (mirrors the run-agent handler @:172).
    // Without this, sending to a chat the SW still considers paused trips the
    // loop's `while (!isChatPaused)` gate immediately and silently drops the run
    // (runFinished{reason:'paused'}). Covers both the idle restart below and the
    // running-branch case where the loop is about to exit on a stale pause.
    setChatPausedPersistent(chatId, false); // FLUX-P1 lane facade — also syncs the derived pausedChatIds cache

    // RES-6: a user send into a SUB-AGENT chat is an unsolicited lifecycle
    // event — stamp user_interactions.last_user_message_at on the record and
    // push a lifecycle notice to the parent (the sub may go off-script under
    // user direction). Covers both branches below (live injection AND idle
    // restart). Best-effort: a hook failure must never block the send.
    if (chats[chatId] && chats[chatId].isSubAgent
        && typeof SubAgents !== 'undefined' && SubAgents.onUserMessageToSubChat) {
        try { SubAgents.onUserMessageToSubChat(chatId); }
        catch (e) { console.warn('[port-bridge] onUserMessageToSubChat threw', e); }
    }

    if (runningChatIds[chatId]) {
        // SWM-INJ-DROP: concatenate rather than flat-replace. Two rapid sends inside one
        // abort/restart window previously dropped the first message at the model level,
        // because the second assignment clobbered the first un-flushed injection. Merge
        // text (separator between non-empty parts) and concat image arrays, mirroring the
        // page-side merge in app/040-send-message.js:39-51.
        var _existingInj = pendingInjectionsByChatId[chatId];
        if (_existingInj) {
            var _mergedText;
            if (_existingInj.text && msg.text) _mergedText = _existingInj.text + '\n\n' + msg.text;
            else _mergedText = _existingInj.text || msg.text || null;
            var _mergedImages;
            if (_existingInj.images && msg.images) _mergedImages = _existingInj.images.concat(msg.images);
            else _mergedImages = _existingInj.images || msg.images || null;
            pendingInjectionsByChatId[chatId] = { text: _mergedText, images: _mergedImages };
        } else {
            pendingInjectionsByChatId[chatId] = {
                text: msg.text || null,
                images: msg.images || null
            };
        }
        userInterruptedChats[chatId] = true;
        if (interruptResolversByChatId[chatId]) {
            try { interruptResolversByChatId[chatId](); } catch (e) {}
        }
        if (currentStreamAbortControllers[chatId]) {
            try { currentStreamAbortControllers[chatId].abort(); } catch (e) {}
        }
        return;
    }

    // Idle — push immediately and start the loop.
    if (msg.text || (msg.images && msg.images.length)) {
        if (msg.text) chats[chatId].messages.push({ role: 'user', content: msg.text });
        if (msg.images && msg.images.length) {
            msg.images.forEach(function(img) {
                if (img.fileType === 'pdf') {
                    chats[chatId].messages.push({ role: 'pdf', base64: img.base64, name: img.name, description: 'User attached PDF', timestamp: Date.now(), file_id: img.file_id });
                } else if (img.fileType === 'file') {
                    chats[chatId].messages.push({ role: 'file', content: img.content, name: img.name, mimeType: img.mimeType, size: img.size, description: 'User attached file', timestamp: Date.now(), file_id: img.file_id });
                } else {
                    chats[chatId].messages.push({ role: 'screenshot', base64: img.base64, name: img.name, description: 'User attached image', timestamp: Date.now(), width: img.width, height: img.height, file_id: img.file_id });
                }
            });
        }
        try { await saveChatsToStorage(); } catch (e) {}
    }

    // MEMFIX-FU (M2): same hydration gate as the run-agent lane above (:463) —
    // this send-message lane also starts the loop, and the chat row may be
    // payload-evicted (the SW loader strips ALL chats — worker/115-storage.js):
    // buildAPIMessages would emit empty image payloads (provider 400) and the
    // loop's saves would be skipped by the evicted-put guard.
    // ensureChatPayloads never rejects by contract; try/catch is defensive.
    if (chats[chatId] && chats[chatId]._payloadsEvicted && typeof ensureChatPayloads === 'function') {
        try { await ensureChatPayloads(chatId); } catch (e) {}
    }
    // Deliberately not awaited (fire-and-forget run start), but the rejection
    // must be handled — an unhandled async crash here surfaced as a raw
    // uncaught TypeError in the SW console.
    runAgent(chatId).catch(function(e) {
        console.error('[port-bridge] runAgent failed after send', chatId, e);
    });
}

// =============================================================
// Re-entry point for the alarm-driven resume scan in background.js.
// Called when the SW alarm finds running checkpoints AND the SW
// runtime is back up. Idempotent — already-running chats are
// skipped by the runningChatIds guard inside runAgent.
// =============================================================
function resumeRunningCheckpoints(checkpoints) {
    // REG-AUDIT-2: nothing to resume — the scan is decided; settle so the
    // page's hello-grace reconcile doesn't keep extending its grace window.
    if (!checkpoints || !checkpoints.length) { _settleResumeScan(); return; }
    // Three gates, in order:
    //   1. _swBootReady — `chats` and providers are loaded. background.js's
    //      onStartup/heartbeat path calls this function independently of
    //      entry.js's boot, and would otherwise see an empty `chats` global
    //      and crash on `chats[streamingChatId].messages`.
    //   2. _swResumeGate — at least one panel-hello has arrived (or 1.5s
    //      fallback). Required so the agent loop's executeTool wrapper can
    //      see panel-declared in-flight tools and adopt them instead of
    //      redispatching (would cause double execution — typing text twice).
    //   3. Platform.ready + loadApiProviders — same as before.
    (self._swBootReady || Promise.resolve())
        .then(function() { return self._swResumeGate || Promise.resolve(); })
        .then(function() { return Platform.ready; })
        .then(function() { return loadApiProviders(); })
        // MEMFIX: the SW loader evicts inline base64 payloads from every chat
        // (worker/115-storage.js). Rehydrate each checkpoint's chat BEFORE
        // runAgent so the resumed loop can inline vision blocks and its saves
        // aren't skipped by the evicted-put guard. ensureChatPayloads never
        // rejects, so this can't fail the gate chain.
        .then(function() {
            if (typeof ensureChatPayloads !== 'function') return;
            return Promise.all(checkpoints.map(function(cp) {
                return ensureChatPayloads(cp.chatId);
            }));
        })
        .then(function() {
            checkpoints.forEach(function(cp) {
                // Do NOT repopulate parkedToolCallsByChatId here. The persisted
                // entries' resolve/reject are gone (the original agent loop died
                // with the SW). If we restored them with no-op stubs, the next
                // panel connect would dispatchUIToolToPort and execute the parked
                // tool a second time — meanwhile injectInterruptedToolResults has
                // already filled the orphan tool_use with a placeholder result, so
                // the model on resume will either accept the placeholder or issue
                // a fresh tool_use (which the panel would also execute). Either
                // way the replayed call's result is discarded. Cleaner to skip.
                // ZR-1: SUB-AGENT chats resume only when the registry still
                // says 'running' — loadAllSubAgents (awaited by 190-entry's
                // boot Promise.all BEFORE this scan runs) keeps checkpoint-
                // resumable subs 'running' and claims their pool slot, and
                // orphan-errors the rest. Resuming a terminal/missing record
                // would restart the loop as a ZOMBIE: tokens burned outside
                // the pool cap, report_to_parent rejected against an already-
                // settled record + handle. Reap the stale checkpoint so the
                // alarm-driven path (background.js → this function) can't
                // revive it later either.
                // TOMBSTONE: a `_deleted` entry is the user's delete command
                // parked in the map (see the 'update-chat' explicit-delete
                // lane above), NOT a live chat row. Left truthy it defeats
                // BOTH missing-chat reapers below (:1206 sub / :1233
                // CKPT-POISON), so a crashed run — whose checkpoint stays
                // {status:'running'} because 110-agent-checkpoint.js has no
                // runCrashed handler while app/030-agent-loop.js:1605 clears
                // runningChatIds — would reach runAgent() and start an
                // empty-transcript run on a deleted chat, re-putting the row.
                // Treat it as missing.
                var _chatRowRaw = (typeof chats !== 'undefined') ? chats[cp.chatId] : null;
                var _chatRow = (_chatRowRaw && _chatRowRaw._deleted === true) ? null : _chatRowRaw;
                var _looksSub = ((cp.chatId || '').indexOf('chat_sub_') === 0)
                    || !!(_chatRow && _chatRow.isSubAgent);
                if (_looksSub) {
                    var _subRec = (typeof SubAgents !== 'undefined' && SubAgents.getByChatId)
                        ? SubAgents.getByChatId(cp.chatId) : null;
                    if (!_subRec) {
                        // ZR1 follow-up: a missing record means EITHER the
                        // record was GC'd (stale checkpoint — reap) OR the
                        // registry never hydrated this boot (loadAll failed;
                        // 097 swallows the drain error and isLoaded() stays
                        // false). Reaping on a failed hydration irreversibly
                        // loses a resumable sub — skip (no resume, no reap)
                        // and let the alarm-driven path retry after a
                        // successful hydration.
                        if (typeof SubAgents !== 'undefined' && SubAgents.isLoaded && SubAgents.isLoaded()) {
                            try { deleteAgentCheckpoint(cp.chatId); } catch (e) {}
                        }
                        return;
                    }
                    if (_subRec.state !== 'running') {
                        // Record already terminal/sleeping — stale checkpoint,
                        // never restart. (The record EXISTS and is
                        // authoritative, so the reap is correct regardless of
                        // hydration state.)
                        try { deleteAgentCheckpoint(cp.chatId); } catch (e) {}
                        return;
                    }
                    if (!_chatRow) {
                        // Running record but the chat transcript vanished from
                        // the chats store (runAgent would crash; the boot
                        // decision in 097 deliberately skipped this check — it
                        // races loadChatsFromStorage there, but here the boot
                        // Promise.all has settled so absence is real). Settle
                        // everything (record + rehydrated pending handle +
                        // pool slot + parent notice) via markOrphaned.
                        try {
                            if (SubAgents.markOrphaned) SubAgents.markOrphaned(_subRec.agent_id);
                        } catch (e) {}
                        try { deleteAgentCheckpoint(cp.chatId); } catch (e) {}
                        return;
                    }
                }
                // CKPT-POISON reaper: a NON-sub checkpoint whose chat row is
                // gone. The sub branch above already handles its own missing-
                // chat case (markOrphaned + reap); this one previously fell
                // straight through to runAgent, which crashed on the missing
                // chat — and because the crash's runStarted emit re-wrote the
                // 'running' checkpoint, the record resurrected itself on every
                // 30s heartbeat tick forever. Reap it — but ONLY when the
                // chats store actually hydrated this boot (_chatsHydrated,
                // worker/115-storage.js). On a failed hydration absence is
                // not evidence: skip (no resume, no reap) and let a later
                // tick retry after a successful load, mirroring the ZR1
                // follow-up rule the sub branch uses.
                if (!_chatRow && !_looksSub) {
                    if (typeof _chatsHydrated !== 'undefined' && _chatsHydrated) {
                        console.warn('[port-bridge] reaping checkpoint for missing chat', cp.chatId);
                        try { deleteAgentCheckpoint(cp.chatId); } catch (e) {}
                    }
                    return;
                }
                if (!runningChatIds[cp.chatId]) {
                    // RESUME-BUDGET (runaway-spawn incident, fix 2a): cap
                    // unattended auto-resumes of the SAME checkpoint. Counted
                    // ONLY here — when we actually attempt a resume of an idle
                    // chat (an already-running chat skips this block, so a
                    // healthy long run ticking past every 30s never burns
                    // budget). The counter is persisted on the agent_runs row
                    // (carried across snapshot rewrites by writeAgentCheckpoint,
                    // worker/110-agent-checkpoint.js) so it survives SW death
                    // AND extension reloads; assistantMessage (real progress)
                    // resets it. On exhaustion the checkpoint is marked
                    // 'errored' — the scan only picks 'running'/'parked', so
                    // the zombie stays down; a user send still starts fresh.
                    var _resumeN = (cp.resume_count || 0) + 1;
                    if (_resumeN > CKPT_MAX_RESUMES) {
                        console.error('[port-bridge] checkpoint for ' + cp.chatId
                            + ' exhausted its resume budget (' + (_resumeN - 1) + '/' + CKPT_MAX_RESUMES
                            + ' resumes without progress) — marking errored, not resuming');
                        delete _ckptResumeCounts[cp.chatId];
                        try {
                            writeAgentCheckpoint(cp.chatId, {
                                chatId: cp.chatId, status: 'errored', turn: cp.turn,
                                callNumber: cp.callNumber, resume_count: _resumeN - 1,
                                lastError: 'resume budget exhausted (' + CKPT_MAX_RESUMES + ' auto-resumes without progress)',
                                parkedToolCalls: []
                            });
                        } catch (eBudget) {}
                        return;
                    }
                    _ckptResumeCounts[cp.chatId] = _resumeN;
                    if (_looksSub && _subRec) {
                        // ZR1-R1: the boot decision in 097 already claimed this
                        // sub's pool slot; a runAgent failure here (sync throw OR
                        // async rejection before the loop's runFinished/runCrashed
                        // events exist) would otherwise leave the record fake-
                        // 'running' with a claimed slot + pending handle forever
                        // (no sweeper covers 'running'). Same wrapper pattern as
                        // _drainPool: settle record/slot/handle via markOrphaned,
                        // then reap the checkpoint ONLY if the record went
                        // terminal (see the conditional reap in the catch — a
                        // transient crash keeps the sub alive via the retry latch).
                        // MEMFIX-FU (M2): checkpoint resume starts the loop on a
                        // chat the SW loader just re-read in evicted form —
                        // hydrate first or the resumed transcript's image rows
                        // 400 the first LLM call ("Only HTTPS URLs are supported").
                        Promise.resolve()
                            .then(function() {
                                var _cpChat = (typeof chats !== 'undefined') ? chats[cp.chatId] : null;
                                if (_cpChat && _cpChat._payloadsEvicted && typeof ensureChatPayloads === 'function') {
                                    return ensureChatPayloads(cp.chatId).catch(function(e) {
                                        console.warn('[port-bridge] resume hydration failed for', cp.chatId, e);
                                    });
                                }
                                return null;
                            })
                            .then(function() { return runAgent(cp.chatId); })
                            .catch(function(err) {
                                console.error('[port-bridge] resume runAgent failed for sub chat', cp.chatId, err);
                                try {
                                    if (typeof SubAgents !== 'undefined' && SubAgents.markOrphaned) {
                                        SubAgents.markOrphaned(_subRec.agent_id, 'resume failed: ' + (err && err.message || err));
                                    }
                                } catch (e2) {}
                                // ZR1-R1 (follow-up): markOrphaned routes a
                                // TRANSIENT-class failure with an unused retry
                                // latch into _queueTransientRetry — the sub is
                                // still ALIVE (state stays 'running', re-queued
                                // or in the ~8s throttle back-off) and its next
                                // runStarted re-writes the checkpoint. Reaping
                                // unconditionally here left the live retry with
                                // no durable checkpoint until then — an SW death
                                // in that window orphaned a sub that should have
                                // resumed. Only reap when the record actually
                                // went terminal (or is gone): a still-'running'
                                // record means the retry owns the checkpoint.
                                try {
                                    var _postRec = (typeof SubAgents !== 'undefined' && SubAgents.getByChatId)
                                        ? SubAgents.getByChatId(cp.chatId) : null;
                                    if (!_postRec || _postRec.state !== 'running') {
                                        try { deleteAgentCheckpoint(cp.chatId); } catch (e2) {}
                                    }
                                } catch (e2) {}
                            });
                    } else {
                        // Promise chain (not bare try/catch): runAgent is async,
                        // so a rejection here was an UNCAUGHT promise rejection —
                        // the sync catch never fired. With the loop's entry guard
                        // this now logs one descriptive line instead of spamming
                        // a raw TypeError on every heartbeat tick.
                        // MEMFIX-FU (M2): same resume-hydration gate as the sub
                        // branch above — evicted image rows 400 the first call.
                        Promise.resolve()
                            .then(function() {
                                var _cpChat2 = (typeof chats !== 'undefined') ? chats[cp.chatId] : null;
                                if (_cpChat2 && _cpChat2._payloadsEvicted && typeof ensureChatPayloads === 'function') {
                                    return ensureChatPayloads(cp.chatId).catch(function(e) {
                                        console.warn('[port-bridge] resume hydration failed for', cp.chatId, e);
                                    });
                                }
                                return null;
                            })
                            .then(function() { return runAgent(cp.chatId); })
                            .catch(function(e) { console.error('[port-bridge] resume runAgent failed', cp.chatId, e); });
                    }
                }
            });
            // REG-AUDIT-2: every checkpoint has been re-armed (runAgent fires
            // runStarted synchronously enough for the page's grace re-check) —
            // the resume scan is settled.
            _settleResumeScan();
        })
        .catch(function(e) {
            // REG-AUDIT-2: a gate failure must still settle, or the page would
            // burn its extended grace window for nothing.
            console.error('[port-bridge] resume gate chain failed', e);
            // ZR1-R1: nothing was resumed, but the boot decision in 097 already
            // claimed pool slots for checkpoint-resumable subs. Without runAgent
            // those records stay fake-'running' (claimed slot, pending handle)
            // for the whole SW session and block the 2-slot pool. Orphan them so
            // record + slot + handle + parent card all settle — shared registry-
            // side sweep (also used by 190-entry's outer boot .catch).
            _orphanUnresumedSubs('resume aborted: boot gate chain failed: ' + (e && e.message || e));
            _settleResumeScan();
        });
}
self.resumeRunningCheckpoints = resumeRunningCheckpoints;
