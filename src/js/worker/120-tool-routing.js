// =============================================================
// AppAgent offscreen runtime — tool routing.
//
// Loaded AFTER the shared bundle so `executeTool` (from
// tools/020-tool-execution.js) and `isHeadlessTool` (from
// core/080-tools.js) are defined.
//
// What this module does:
//
//   1. Wraps the global `executeTool` so the dispatcher decides at
//      call time whether to run the tool locally (headless) or
//      route it to a connected panel (UI-required).
//
//   2. Provides worker-side stubs for the approval-prompt functions
//      that the shared dispatcher references (originally in
//      src/js/ui/160-notifications.js, page-only). Offscreen routes
//      the prompt to a panel; if no panel is connected, the prompt
//      is parked alongside the tool call.
//
//   3. Implements parking: a UI tool that cannot be run right now
//      because no panel is connected gets persisted to IDB and the
//      promise stays unresolved. When a panel connects, parked
//      tools replay in order. Max lifetime: bounded (see
//      PARKED_TOOL_MAX_LIFETIME_MS) — not 24h.
//
// The page bundle never loads this file (it lives in src/js/worker/
// which is excluded from the page tier list). Panels run UI tools
// directly via the unwrapped executeTool.
// =============================================================

// PARK-LIFETIME (empty-chat-list root fix): a UI tool call parked with no panel
// used to live for 24h. That kept the SW warm (heartbeat) for a full day
// holding an IDB connection that an abrupt kill / OS sleep could abandon and
// wedge (the empty-chat-list bug), and let a run hang for a day. Bounded to a
// short max lifetime: on expiry we checkpoint the errored state, fail the call
// so the run surfaces an error instead of hanging, then release the SW DB
// connection. A genuine panel reconnect within the window still replays
// normally.
var PARKED_TOOL_MAX_LIFETIME_MS = 12 * 60 * 1000; // 12 min
var PARKED_TOOL_TTL_MS = PARKED_TOOL_MAX_LIFETIME_MS; // back-compat alias

// Pending tool-call requests sent over port to a panel executor.
// Key: toolCallId → { resolve, reject, startedAt, executorPortId }
var _pendingUIToolCalls = {};

// SW-restart reconciliation. When a panel reconnects after the SW
// died mid-tool, it sends panel-hello with the toolCallIds it's still
// executing. The SW marks those as ADOPTED — the executeTool wrapper
// must NOT redispatch them (would cause double execution). Instead it
// just registers resolvers and waits for the panel's exec-tool-result.
// If the result arrives before executeTool has wired up its resolvers
// (panel finished the tool right as it reconnected), it lands in the
// buffer below and is consumed when executeTool eventually runs.
var _panelAdoptedTools = {};  // toolCallId -> { chatId, name }
var _adoptedResults = {};      // toolCallId -> { result, error }

// B2: the adopted-reconcile maps above are seeded on panel-hello (SW-restart) and
// consumed by the executeTool adoption arm. If the resumed loop never re-dispatches
// that toolCallId (injectInterruptedToolResults back-fills a placeholder instead),
// the entry would leak until SW teardown. Evict after a TTL so the maps stay bounded.
// 60s matches the page's completed-tool-results window — the only interval in which
// adoption is relevant.
var ADOPTED_RESULT_TTL_MS = 60 * 1000;
// B1: backstop for a re-parked (already-dispatched) tool whose result never arrives
// after a panel reconnect — reject rather than hang the loop forever. Generous so a
// legitimately still-running tool finishing post-reconnect settles first.
var REDISPATCH_RECONCILE_TTL_MS = 30 * 1000;
var _adoptedEvictTimers = {};
function scheduleAdoptedEviction(toolCallId) {
    // SWM3-N1(a): re-stamping on every panel-hello must EXTEND the TTL, not stack
    // timers — an OLD timer firing later would clobber a freshly re-stamped live
    // marker (downgrading a still-running tool to a tombstone). Clear any pending
    // timer for this id first so a tool that keeps re-declaring inflight never
    // expires, and so exactly one eviction is ever in flight per id.
    if (_adoptedEvictTimers[toolCallId]) clearTimeout(_adoptedEvictTimers[toolCallId]);
    _adoptedEvictTimers[toolCallId] = setTimeout(function() {
        delete _adoptedEvictTimers[toolCallId];
        var m = _panelAdoptedTools[toolCallId];
        // SWM3-T3 fix: the buffered-result drop is deferred to AFTER the live-port
        // re-arm guard below. Dropping it here (top of TTL) stripped the buffer on
        // every re-arm of a STILL-LIVE marker, so a tool that finished post-reconnect
        // lost its buffered result. Its only consumer is the executeTool adoption arm;
        // for the !m / pending-entry / dead-port tombstone paths we still drop it here
        // (identical behavior) — only the live-port re-arm path now retains it.
        if (!m) { delete _adoptedResults[toolCallId]; return; }
        // Orphaned re-stamp: executeTool ALREADY ran for this id (a pending entry
        // exists, which owns reconciliation). The marker is stray — delete it (the
        // original always deleted; keeping it would leak). No tombstone needed.
        if (_pendingUIToolCalls[toolCallId]) { delete _adoptedResults[toolCallId]; delete _panelAdoptedTools[toolCallId]; return; }
        // SWM3-T3: don't downgrade a marker whose adopting panel is STILL connected.
        // The first-level TTL bounds a marker the resumed loop never consumed, but a
        // live adopting port means the tool may still be executing (or about to be
        // adopted) — downgrading to a port-less tombstone here strips the live port, so
        // a later panel disconnect's _unregisterPanel scan (filters on entry.port)
        // can't match it and the awaited promise hangs. Re-arm the TTL and bail; the
        // pending-entry check above already handled the loop-already-ran case.
        if (m.port && typeof _swPanelPorts !== 'undefined' && _swPanelPorts.has(m.port)) {
            // F3: bound the live-port re-arm with an ABSOLUTE deadline. Without it, a
            // never-consumed live marker + buffer re-arms forever while the adopting
            // panel stays connected, leaking for the entire connection lifetime. Stamp
            // the first time eviction was scheduled for this marker; while we're within
            // a generous cap (10x the TTL) keep re-arming (a genuinely slow tool still
            // settles), but once the cap is exceeded STOP re-arming and fall through to
            // the dead-port terminal cleanup path below so the buffer + marker are
            // reclaimed instead of leaking.
            if (!m.firstScheduledAt) m.firstScheduledAt = Date.now();
            if ((Date.now() - m.firstScheduledAt) <= (10 * ADOPTED_RESULT_TTL_MS)) {
                scheduleAdoptedEviction(toolCallId);
                return;
            }
            // Past the absolute deadline — fall through to the dead-port terminal path.
        }
        // Dead-port terminal path: drop the buffered result (identical to the original
        // top-of-TTL delete; deferred here only so the live-port re-arm above keeps it).
        delete _adoptedResults[toolCallId];
        // SWM3-N1(b): the loop has NOT reached executeTool(toolCallId) yet. Do NOT
        // fully delete the marker — a late executeTool would then find nothing and
        // BLIND RE-DISPATCH a tool the panel already ran (double side effect).
        // Downgrade to a port-less tombstone so the adoption arm reconciles instead
        // (registers a waiting pending entry, never re-dispatches).
        _panelAdoptedTools[toolCallId] = { dispatched: true, chatId: m.chatId };
        // Bound growth: if the loop never reaches executeTool(toolCallId) to consume
        // the tombstone, drop it after a second TTL (unless a pending entry adopted
        // it in the meantime).
        _adoptedEvictTimers[toolCallId] = setTimeout(function() {
            delete _adoptedEvictTimers[toolCallId];
            var t = _panelAdoptedTools[toolCallId];
            if (t && t.dispatched && !t.port && !_pendingUIToolCalls[toolCallId]) delete _panelAdoptedTools[toolCallId];
            if (!_pendingUIToolCalls[toolCallId]) delete _adoptedResults[toolCallId]; // SWM3-L1: don't orphan a late-written buffer
        }, ADOPTED_RESULT_TTL_MS);
    }, ADOPTED_RESULT_TTL_MS);
}

// SWM3-N3: arm the 30s redispatch backstop for an already-dispatched/adopted tool
// whose live panel is gone (a port-less tombstone, or a _unregisterPanel re-park).
// Stores the timer id ON the pending entry so a later panel-hello that re-declares
// the id still-inflight can CANCEL it — otherwise the backstop kills a tool the
// panel is legitimately still executing (slow iframe wait_for / take_screenshot).
// prompt_user is exempt ENTIRELY: it can wait on the user far longer than 30s and a
// reconnecting panel keeps re-declaring it inflight.
function armRedispatchBackstop(toolCallId, name) {
    if (name === 'prompt_user') return;
    var pe = _pendingUIToolCalls[toolCallId];
    if (!pe) return;
    // Clear any prior backstop on this entry before overwriting so a stale timer
    // can't survive and later fire against a re-armed entry.
    if (pe._backstopTimer) clearTimeout(pe._backstopTimer);
    var _bt = setTimeout(function() {
        var p = _pendingUIToolCalls[toolCallId];
        // Identity guard: only fire if THIS timer is still the entry's active
        // backstop. A settle (resolvePendingUIToolCall) or a re-arm that replaced/
        // cleared the timer leaves _bt orphaned — it must NOT reject the (possibly
        // freshly re-registered) entry it no longer owns.
        if (p && p._backstopTimer === _bt) {
            delete _pendingUIToolCalls[toolCallId];
            try { p.reject(new Error('panel closed mid-tool; result unrecoverable — not re-executed to avoid duplicate side effects')); } catch (e) {}
        }
    }, REDISPATCH_RECONCILE_TTL_MS);
    pe._backstopTimer = _bt;
}

// SWM3-N3: a reconnecting panel re-declared this tool still-inflight, so it's alive
// and executing — cancel any pending backstop so it doesn't kill a legitimately-slow
// tool. (The caller also refreshes the pending entry's port for clean-reject on the
// new panel's disconnect.)
function clearRedispatchBackstop(toolCallId) {
    var pe = _pendingUIToolCalls[toolCallId];
    if (pe && pe._backstopTimer) {
        clearTimeout(pe._backstopTimer);
        pe._backstopTimer = null;
    }
}

// Resolve when the SW has heard from at least one panel (so the resume
// path can see _panelAdoptedTools) or after a 1.5s fallback (no panel
// is open — proceed with redispatch).
var _swResumeGateResolve = null;
self._swResumeGate = new Promise(function(resolve) { _swResumeGateResolve = resolve; });
self._swOpenResumeGate = function() {
    if (_swResumeGateResolve) {
        var r = _swResumeGateResolve;
        _swResumeGateResolve = null;
        r();
    }
};
setTimeout(self._swOpenResumeGate, 1500);

// Called by 130-port-bridge.js on panel-hello.
self._swAdoptPanelInflight = function(payload, port) {
    payload = payload || {};
    var inflight = payload.inflightToolCalls;
    var completed = payload.completedToolResults;
    if (inflight && inflight.length) {
        inflight.forEach(function(it) {
            if (it && it.toolCallId) {
                // SWM3-N3: if the loop ALREADY reached executeTool(id) and is awaiting
                // (a pending entry exists), the marker below won't be re-consumed —
                // instead the panel re-declaring this tool still-inflight proves it's
                // alive and executing, so refresh the pending entry's port (for
                // clean-reject on the NEW panel's disconnect) and CANCEL any pending
                // redispatch backstop, which would otherwise kill a legitimately-slow
                // tool (prompt_user on the user, iframe wait_for / take_screenshot).
                var _pe = _pendingUIToolCalls[it.toolCallId];
                if (_pe) {
                    _pe.port = port;
                    clearRedispatchBackstop(it.toolCallId);
                }
                // SWM3F-1: carry the adopting panel's port so the executeTool
                // adoption arm can stamp it onto the pending entry. Otherwise
                // _unregisterPanel's disconnect scan (filters on entry.port)
                // skips the adopted entry and the awaited promise hangs forever.
                // SWM3-N1(a): re-stamping on every hello (with a fresh eviction)
                // keeps a still-running tool's marker alive across reconnects.
                _panelAdoptedTools[it.toolCallId] = { chatId: it.chatId, name: it.name, port: port };
                scheduleAdoptedEviction(it.toolCallId); // B2: bound the map if never adopted
            }
        });
    }
    if (completed && completed.length) {
        // Tools the panel finished but whose results may not have been
        // persisted by the previous SW (it could have died between
        // receiving exec-tool-result and saving). Pre-seed both the
        // adoption marker AND the buffered result so the agent loop's
        // executeTool wrapper short-circuits without re-dispatching.
        //
        // BUG FIX (live-SW reconnect): if THIS SW (no restart, just a
        // transient port disconnect on the panel side) is still holding
        // a `_pendingUIToolCalls[toolCallId]` entry from the original
        // dispatch, the result coming back via panel-hello needs to
        // resolve that promise. Without this, the agent loop's await on
        // executeTool hangs forever — the result sits in _adoptedResults
        // but nothing ever consumes it (executeTool already returned the
        // promise to the loop and would only consult _adoptedResults on
        // a fresh dispatch). Symptom matches the user-reported "tool
        // output appears 2 seconds late after a worker-restart-looking
        // status" — the result IS there, it just never settled the
        // existing promise. resolvePendingUIToolCall is the same path
        // exec-tool-result takes, so the dispatch already-pending arm
        // and the panel-hello arm now end up in the same state.
        completed.forEach(function(c) {
            if (!c || !c.toolCallId) return;
            if (_pendingUIToolCalls[c.toolCallId]) {
                // Live promise exists — settle it. Do NOT also stash in
                // _adoptedResults OR _panelAdoptedTools; the executeTool
                // wrapper has already returned (resolve/reject below is
                // consumed by the awaiter), so a buffered entry would just
                // leak. The only consumer of _panelAdoptedTools is the
                // SW-restart reconcile arm — which a live-pending case
                // never reaches.
                resolvePendingUIToolCall(c.toolCallId, c.result, c.error || null);
            } else {
                // No live awaiter — this is the SW-restart case. Buffer so
                // the agent loop's re-dispatch finds the result via the
                // adoption short-circuit in the executeTool wrapper.
                // Stamp the adopting port so scheduleAdoptedEviction's live-panel
                // re-arm protects this buffered result while the panel stays connected
                // (matches the inflight arm above). Without it the marker is port-less
                // and the 60s eviction drops a still-valid completed result. (bug #2)
                _panelAdoptedTools[c.toolCallId] = { chatId: c.chatId, name: c.name, port: port };
                _adoptedResults[c.toolCallId] = { result: c.result, error: c.error || null };
                scheduleAdoptedEviction(c.toolCallId); // B2: bound the map if never adopted
            }
        });
    }
    self._swOpenResumeGate();
};

// =============================================================
// Park a UI tool call when no executor is available. Stores the
// pending promise resolvers in parkedToolCallsByChatId AND emits
// a `toolParked` event so the panel (when it eventually connects)
// can show the placeholder message. The checkpoint module also
// hooks `toolParked` to persist to IDB.
// =============================================================
function parkUIToolCall(chatId, toolCallId, name, input, resolve, reject, sandboxCtx, alreadyDispatched) {
    if (!parkedToolCallsByChatId[chatId]) parkedToolCallsByChatId[chatId] = [];
    var entry = {
        toolCallId: toolCallId,
        name: name,
        input: input,
        resolve: resolve,
        reject: reject,
        // Carry eager-render hints across the park so replay to a fresh panel
        // still lets executeDisplay attach to the parent tool_result slot.
        sandboxCtx: sandboxCtx || null,
        // B1: true when this park is a _unregisterPanel RE-park of a tool that was
        // already dispatched to (and may have executed on) the now-disconnected
        // panel. replayParkedToolCalls must NOT blindly re-dispatch such an entry —
        // a side-effecting tool would run twice. It reconciles instead.
        alreadyDispatched: !!alreadyDispatched,
        parkedAt: Date.now()
    };
    // F4: if an entry for this toolCallId is already parked (re-park), clear its stale
    // park-lifetime TTL timer first so we don't stack a second never-cleared closure.
    try {
        parkedToolCallsByChatId[chatId].forEach(function(_e) {
            if (_e.toolCallId === toolCallId && _e._ttlTimer) { clearTimeout(_e._ttlTimer); _e._ttlTimer = null; }
        });
    } catch (e) {}
    parkedToolCallsByChatId[chatId].push(entry);
    AgentEvents.emit('toolParked', { chatId: chatId, toolCallId: toolCallId, name: name, input: input });
    // Schedule TTL cancellation. F4: store the timer id ON the entry so consume/replay/
    // cancel can clearTimeout it — otherwise the 24h closure outlives the parked entry
    // and a re-park stacks a second timer.
    entry._ttlTimer = setTimeout(function() {
        // PARK-LIFETIME expiry (see PARKED_TOOL_MAX_LIFETIME_MS): the parked call
        // outlived its bound with no panel to run it. Checkpoint the errored run
        // state (so a resume scan won't keep it 'parked' forever), fail the call
        // (cancelParkedToolCall resolves it with a failure result — the loop
        // surfaces an error instead of hanging), then release the SW DB
        // connection so it is not held while idle.
        var _cpDone = Promise.resolve();
        try {
            if (typeof _buildCheckpointSnapshotFor === 'function' && typeof writeAgentCheckpoint === 'function') {
                var _expSnap = _buildCheckpointSnapshotFor(chatId) || { chatId: chatId };
                _expSnap.status = 'errored';
                _cpDone = writeAgentCheckpoint(chatId, _expSnap) || Promise.resolve();
            }
        } catch (errCp) {}
        cancelParkedToolCall(chatId, toolCallId, 'parked tool call exceeded max lifetime (' + Math.round(PARKED_TOOL_MAX_LIFETIME_MS / 60000) + ' min) with no panel connected');
        // Release the SW DB connection only AFTER the errored checkpoint has
        // committed. Closing it synchronously here would abort the checkpoint's
        // transaction: when `db` is cached, openDatabase() resolves on a
        // microtask, so writeAgentCheckpoint's db.transaction() runs after this
        // sync block — on a connection we'd already have closed (InvalidStateError,
        // silently swallowed by writeAgentCheckpoint's .catch). Chaining defers
        // the close past commit.
        Promise.resolve(_cpDone).then(function() {
            try { if (typeof releaseIdleDbConnection === 'function') releaseIdleDbConnection(); } catch (errRel) {}
        });
    }, PARKED_TOOL_MAX_LIFETIME_MS);
}

function cancelParkedToolCall(chatId, toolCallId, reason) {
    var arr = parkedToolCallsByChatId[chatId];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
        if (arr[i].toolCallId === toolCallId) {
            var entry = arr[i];
            arr.splice(i, 1);
            // F4: clear the stored TTL timer so the 24h closure can't fire again on an
            // id that's now cancelled.
            try { if (entry._ttlTimer) { clearTimeout(entry._ttlTimer); entry._ttlTimer = null; } } catch (eT) {}
            try {
                entry.resolve({ success: false, error: 'Tool call cancelled: ' + (reason || 'unknown') });
            } catch (e) {}
            AgentEvents.emit('toolUnparked', { chatId: chatId, toolCallId: toolCallId, reason: reason });
            return;
        }
    }
}

// =============================================================
// Replay parked tool calls to a newly-connected panel. Called by
// 130-port-bridge.js when a panel subscribes.
// =============================================================
function replayParkedToolCalls(port) {
    Object.keys(parkedToolCallsByChatId).forEach(function(chatId) {
        var arr = parkedToolCallsByChatId[chatId];
        if (!arr || arr.length === 0) return;
        // Pop entries one at a time and dispatch to this panel. If the
        // panel disconnects mid-replay, remaining entries stay parked.
        var pending = arr.slice();
        parkedToolCallsByChatId[chatId] = []; // optimistic clear; we re-park if dispatch fails
        pending.forEach(function(entry) {
            try {
                if (entry.name === '__approval_prompt__') {
                    // SWM3F-2: a parked no-panel approval must be replayed through
                    // the REAL approval-prompt path, NOT dispatched as a generic
                    // exec-tool. The panel has no '__approval_prompt__' tool, so a
                    // dispatch returns "Unknown tool", which the approval stub maps
                    // to a fabricated "DENIED by user" — silently aborting an action
                    // the user never saw. Re-register a pending entry (port + chatId,
                    // name omitted so a disconnect clean-rejects) and post the same
                    // exec-approval-prompt message the port-exists path uses,
                    // populated from the parked entry.input.
                    var _ap = entry.input || {};
                    var _apEnv = {
                        type: 'exec-approval-prompt',
                        chatId: chatId,
                        toolCallId: _ap.toolCallId,
                        approvalRequestId: entry.toolCallId,
                        displayName: _ap.displayName,
                        args: _ap.args,
                        permissionKey: _ap.permissionKey,
                        toolName: _ap.toolName,
                        widgetName: _ap.widgetName || null
                    };
                    _pendingUIToolCalls[entry.toolCallId] = {
                        resolve: entry.resolve,
                        reject: entry.reject,
                        startedAt: Date.now(),
                        port: port,
                        chatId: chatId,
                        // AB: approval marker + envelope for rebind / re-park /
                        // late-panel re-delivery (worker/130-port-bridge.js).
                        isApproval: true,
                        toolCallId: _ap.toolCallId,
                        envelope: _apEnv
                    };
                    // AB-1: (re-)seed the authoritative row — idempotent by
                    // toolCallId: already-seeded rows are kept, and a park
                    // created BEFORE any panel existed gains its row now.
                    if (typeof _swSeedApprovalRow === 'function') {
                        _swSeedApprovalRow(chatId, {
                            role: 'approval',
                            toolName: _ap.displayName,
                            actualToolName: _ap.toolName || _ap.displayName,
                            args: _ap.args,
                            permissionKey: _ap.permissionKey,
                            toolCallId: _ap.toolCallId,
                            status: 'pending'
                        });
                    }
                    // AB-3: replayed approvals fan out too — the replay port
                    // becomes the new PRIMARY; other panels get card-only copies.
                    // NOTE: _broadcastApprovalPrompt swallows per-port post errors,
                    // so the surrounding catch's re-park arm is dead for approvals —
                    // a dead primary is cleaned up by the onDisconnect rebind/re-park.
                    _broadcastApprovalPrompt(_apEnv, port);
                    AgentEvents.emit('toolUnparked', { chatId: chatId, toolCallId: entry.toolCallId, reason: 'replayed-approval' });
                } else if (entry.alreadyDispatched) {
                    // B1: this tool was already dispatched to (and may have run on)
                    // the prior panel before it disconnected. Blindly re-dispatching
                    // would execute the side effect TWICE. Reconcile instead:
                    //  • If the reconnecting panel already delivered its buffered
                    //    result (via _swAdoptPanelInflight, which buffers into
                    //    _adoptedResults when no live pending entry exists), consume it
                    //    now and settle the ORIGINAL awaiter (the loop never stopped).
                    //  • Otherwise register a pending entry (name omitted) so the
                    //    panel's exec-tool-result / completedToolResults settles it, a
                    //    further disconnect clean-rejects it, and a backstop rejects if
                    //    the result is truly lost — trading one retryable error for zero
                    //    duplicate side effects (the deferred gap's intended direction).
                    var _buf = _adoptedResults[entry.toolCallId];
                    if (_buf) {
                        delete _adoptedResults[entry.toolCallId];
                        delete _panelAdoptedTools[entry.toolCallId];
                        try { if (_buf.error) entry.reject(_buf.error); else entry.resolve(_buf.result); } catch (e) {}
                        AgentEvents.emit('toolUnparked', { chatId: chatId, toolCallId: entry.toolCallId, reason: 'adopt-buffered' });
                    } else if (entry.name === 'prompt_user') {
                        // SWM3-G-HANG: prompt_user is backstop-exempt, so the generic adopt-await
                        // arm below registers a pending entry + arms a NO-OP backstop. A prompt_user
                        // whose executor died then gets reconciled to this surviving port but is never
                        // re-shown and never bounded — it hangs forever. Re-asking the user is correct
                        // (no side effect to double), so RE-DISPATCH it to the reconnecting port.
                        dispatchUIToolToPort(port, chatId, entry.toolCallId, entry.name, entry.input, entry.resolve, entry.reject, entry.sandboxCtx);
                        AgentEvents.emit('toolUnparked', { chatId: chatId, toolCallId: entry.toolCallId, reason: 'replayed-prompt-user' });
                    } else {
                        _pendingUIToolCalls[entry.toolCallId] = {
                            resolve: entry.resolve,
                            reject: entry.reject,
                            startedAt: Date.now(),
                            port: port,
                            chatId: chatId
                        };
                        // SWM3-N3: arm the backstop via the shared helper so the timer
                        // id is stored on the pending entry (a later panel-hello that
                        // re-declares this id still-inflight can cancel it) and so an
                        // interactive prompt_user is exempt from the 30s kill.
                        armRedispatchBackstop(entry.toolCallId, entry.name);
                        AgentEvents.emit('toolUnparked', { chatId: chatId, toolCallId: entry.toolCallId, reason: 'adopt-await' });
                    }
                } else {
                    dispatchUIToolToPort(port, chatId, entry.toolCallId, entry.name, entry.input, entry.resolve, entry.reject, entry.sandboxCtx);
                    AgentEvents.emit('toolUnparked', { chatId: chatId, toolCallId: entry.toolCallId, reason: 'replayed' });
                }
                // F4: this entry is leaving the parked set on a successful dispatch/
                // reconcile — clear its 24h TTL timer so a stale closure doesn't later
                // fire cancelParkedToolCall on an id that's now live (or already settled).
                try { if (entry._ttlTimer) { clearTimeout(entry._ttlTimer); entry._ttlTimer = null; } } catch (e3) {}
            } catch (e) {
                // Failed to dispatch — re-park. B4: also drop any pending entry the
                // approval branch registered (above) before its postMessage threw,
                // else a dead-port _pendingUIToolCalls entry leaks (invisible to
                // _unregisterPanel, whose disconnect for that port likely already
                // fired) until SW teardown.
                try { delete _pendingUIToolCalls[entry.toolCallId]; } catch (e2) {}
                if (!parkedToolCallsByChatId[chatId]) parkedToolCallsByChatId[chatId] = [];
                parkedToolCallsByChatId[chatId].push(entry);
            }
        });
    });
}

// =============================================================
// Dispatch a UI tool call to a specific panel port. Returns
// nothing — the result arrives via the port's message handler in
// 130-port-bridge.js, which calls resolvePendingUIToolCall.
// =============================================================
function dispatchUIToolToPort(port, chatId, toolCallId, name, input, resolve, reject, sandboxCtx) {
    _pendingUIToolCalls[toolCallId] = {
        resolve: resolve,
        reject: reject,
        startedAt: Date.now(),
        // Re-park metadata: post-SW-move the loop survives panel close, so if THIS
        // executing panel disconnects before posting exec-tool-result the awaited
        // promise hangs forever. _unregisterPanel(port) scans _pendingUIToolCalls
        // for entries with this .port and re-parks them so a fresh panel replays.
        port: port,
        chatId: chatId,
        name: name,
        input: input,
        sandboxCtx: sandboxCtx || null
    };
    var msg = {
        type: 'exec-tool',
        chatId: chatId,
        toolCallId: toolCallId,
        name: name,
        input: input
    };
    // Forward sandbox-context flags so display's eager-render path can attach
    // to the parent tool_result slot when called from inside a js_eval / skill.
    if (sandboxCtx) {
        if (sandboxCtx.fromSandbox) msg.fromSandbox = true;
        if (sandboxCtx.parentToolCallId) msg.parentToolCallId = sandboxCtx.parentToolCallId;
        if (typeof sandboxCtx.messageIndex === 'number') msg.messageIndex = sandboxCtx.messageIndex;
    }
    port.postMessage(msg);
}

function resolvePendingUIToolCall(toolCallId, result, error) {
    var pending = _pendingUIToolCalls[toolCallId];
    if (pending) {
        // Settling — clear any redispatch backstop so its timer can't later fire
        // against a re-registered entry for the same (stable) toolCallId.
        if (pending._backstopTimer) { clearTimeout(pending._backstopTimer); pending._backstopTimer = null; }
        delete _pendingUIToolCalls[toolCallId];
        if (error) {
            try { pending.reject(error); } catch (e) {}
        } else {
            try { pending.resolve(result); } catch (e) {}
        }
        return;
    }
    // No pending entry. If this toolCallId was declared in-flight by a
    // panel-hello, buffer the result for executeTool to consume when it
    // sets up its resolvers. Otherwise drop on the floor (stale port
    // from before SW restart for a tool the SW never re-attempted).
    if (_panelAdoptedTools[toolCallId]) {
        _adoptedResults[toolCallId] = { result: result, error: error };
        if (typeof scheduleAdoptedEviction === 'function') scheduleAdoptedEviction(toolCallId); // SWM3-L1: bound a buffer created after the tombstone downgrade
    }
}

// =============================================================
// MP (multi-panel prompt_user) helpers. See tools/100-prompt-user.js
// MP-1/MP-2 and app/045-agent-port-bridge-page.js MP-4.
// =============================================================

// MP-1: seed the pending prompt_user row into the SW's authoritative chat
// copy at DISPATCH time, splicing it before the tool placeholder — the same
// slot the resolve-time _message_persist mirror uses. Idempotent by promptId
// (panel reloads re-invoke executePromptUser with the same toolCallId, and
// the adopted-row path never re-posts anyway). Broadcasts 'messagesAppended'
// (chat-inlined — see worker/100-agent-event-broadcast.js) so every panel
// viewing the chat renders the live form immediately.
function _swSeedPromptRow(chatId, row) {
    var chat = chatId && chats[chatId];
    if (!chat || chat._deleted || !row || !row.promptId) return;
    if (!Array.isArray(chat.messages)) chat.messages = [];
    for (var i = 0; i < chat.messages.length; i++) {
        var m = chat.messages[i];
        if (m && m.role === 'prompt_user' && m.promptId === row.promptId) return;
    }
    var idx = -1;
    if (row.toolCallId) {
        for (var j = chat.messages.length - 1; j >= 0; j--) {
            if (chat.messages[j].role === 'tool' && chat.messages[j].tool_call_id === row.toolCallId) { idx = j; break; }
        }
    }
    if (idx >= 0) chat.messages.splice(idx, 0, row);
    else chat.messages.push(row);
    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    AgentEvents.emit('messagesAppended', { chatId: chatId, reason: 'prompt-user-pending' });
}

// MP-2: a panel WITHOUT the armed resolver submitted/cancelled the form.
// First-submit-wins on the authoritative row, then route the result:
//   • executor panel still connected → forward so ITS resolver settles and
//     executePromptUser returns through the normal _message_persist path;
//   • executor gone but entry pending (dead port not yet unregistered, or
//     the submitting panel itself) → settle the SW promise directly;
//   • executor closed and the call RE-PARKED (_unregisterPanel) → consume
//     the parked entry with the submitted values instead of hanging.
function _swSettleRemotePrompt(msg, fromPort) {
    if (!msg || !msg.promptId) return;
    var chatId = msg.chatId;
    var result = msg.result || { success: false, cancelled: true, message: 'Prompt settled remotely' };
    var chat = chatId && chats[chatId];
    var row = null;
    if (chat && Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var m = chat.messages[i];
            if (m && m.role === 'prompt_user' && m.promptId === msg.promptId) { row = m; break; }
        }
    }
    if (row && row.status !== 'pending') return; // first-submit-wins: a second panel's race loses
    if (row) {
        row.status = result.success ? 'submitted' : 'cancelled';
        if (result.values) row.values = result.values;
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    }
    var toolCallId = msg.toolCallId || (row && row.toolCallId) || null;
    var forwarded = false;
    if (toolCallId) {
        var pending = _pendingUIToolCalls[toolCallId];
        if (pending && pending.port && pending.port !== fromPort) {
            try {
                // Sweep 753-773 (F772-1): stash the result on the entry BEFORE the
                // forward — if the executor port is dead-but-not-yet-disconnected
                // the post is a silent void; _unregisterPanel then settles the
                // entry from _remoteResult instead of re-parking it (a re-park
                // replays the prompt and discards this first submission).
                pending._remoteResult = result;
                pending.port.postMessage({ type: 'prompt-user-remote-result', chatId: chatId, promptId: msg.promptId, result: result });
                forwarded = true;
            } catch (e) { /* dead port — fall through to direct settle */ }
        }
        if (!forwarded && pending) {
            resolvePendingUIToolCall(toolCallId, result);
        } else if (!forwarded) {
            var arr = parkedToolCallsByChatId[chatId];
            if (arr) {
                for (var pi = 0; pi < arr.length; pi++) {
                    if (arr[pi].toolCallId === toolCallId) {
                        var entry = arr[pi];
                        arr.splice(pi, 1);
                        try { if (entry._ttlTimer) { clearTimeout(entry._ttlTimer); entry._ttlTimer = null; } } catch (eT) {}
                        try { entry.resolve(result); } catch (e2) {}
                        AgentEvents.emit('toolUnparked', { chatId: chatId, toolCallId: toolCallId, reason: 'remote-prompt-result' });
                        break;
                    }
                }
            }
        }
    }
    // Broadcast the resolved row so every panel reconciles (submitted →
    // read-only values; cancelled → dismissed). The MP-4 merge rule lets a
    // non-pending snapshot copy win over a page's pending one.
    AgentEvents.emit('messagesAppended', { chatId: chatId, reason: 'prompt-user-result' });
}

// =============================================================
// AB (approval broadcast) helpers — clone of the MP prompt_user pattern
// above, for permission approvals. Consumed by the dispatch below, by
// worker/130-port-bridge.js (result / register / unregister lanes) and by
// ui/160-notifications.js + app/036-agent-event-handlers-page.js page-side.
// =============================================================

// AB-1: seed the pending approval row into the SW's authoritative chat copy
// at DISPATCH time (mirror of _swSeedPromptRow). Approval rows are appended
// at the end — the same slot the page-side showToolApprovalPrompt uses.
// Idempotent by toolCallId, so parked replays / rebind re-posts never
// duplicate it. Persisting here means the row survives SW restarts and
// late-connecting panels receive the pending approval in their hello /
// chat-inlined broadcast snapshots (the page merge keeps a non-pending
// snapshot copy over a pending page one, see _mergePagePendingRows).
function _swSeedApprovalRow(chatId, row) {
    var chat = chatId && chats[chatId];
    if (!chat || chat._deleted || !row || !row.toolCallId) return;
    if (!Array.isArray(chat.messages)) chat.messages = [];
    for (var i = 0; i < chat.messages.length; i++) {
        var m = chat.messages[i];
        if (m && m.role === 'approval' && m.toolCallId === row.toolCallId) return;
    }
    chat.messages.push(row);
    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    AgentEvents.emit('messagesAppended', { chatId: chatId, reason: 'approval-pending' });
}

// AB-2: the FIRST verdict arrived (see 'exec-approval-prompt-result' in
// worker/130-port-bridge.js — the pending entry existed, so this verdict
// won). Flip the authoritative row and broadcast 'approvalSettled'
// (chat-inlined, see EVENTS_WITH_CHAT_INLINE) so EVERY panel dismisses its
// card, drops its local resolver and repaints the row terminal. Late
// verdicts never reach here — their pending entry is already gone.
function _swSettleApprovalRow(chatId, toolCallId, status, allowed) {
    if (!chatId || !toolCallId) return;
    var chat = chats[chatId];
    var row = null;
    if (chat && Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var m = chat.messages[i];
            if (m && m.role === 'approval' && m.toolCallId === toolCallId) { row = m; break; }
        }
    }
    if (row && row.status === 'pending') {
        row.status = status || (allowed ? 'allowed' : 'denied');
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    }
    AgentEvents.emit('approvalSettled', {
        chatId: chatId,
        toolCallId: toolCallId,
        status: (row && row.status !== 'pending' && row.status) || status || (allowed ? 'allowed' : 'denied'),
        allowed: !!allowed
    });
}

// AB-3: broadcast an exec-approval-prompt envelope to EVERY connected panel.
// Approvals are pure UI — unlike exec-tool, multi-dispatch has no side
// effects: each panel shows its own card, the first verdict wins in the SW
// (resolvePendingUIToolCall's delete-on-first-resolve) and late verdicts
// drop. Exactly ONE port is PRIMARY (envelope.primary === true): it keeps
// today's single-panel duties — firing the OS notification (when ITS
// document is hidden) and the missing-chat give-up denial — so the fan-out
// can neither duplicate OS notifications (N hidden panels) nor race-deny
// for everyone (see _gaveUp in app/045-agent-port-bridge-page.js).
function _broadcastApprovalPrompt(envelope, primaryPort) {
    var n = 0;
    _agentSubscribers.forEach(function(p) {
        try {
            p.postMessage(Object.assign({}, envelope, {
                primary: p === primaryPort,
                osNotify: p === primaryPort
            }));
            n++;
        } catch (e) { /* dead port — the unregister scan will reap it */ }
    });
    return n;
}

// MP-3 (abandon cleanup): the agent loop abandoned in-flight tool calls
// (user sent a new message / paused). Settle + remove the SW pending entry
// and any parked twin so neither leaks, and for prompt_user flip the
// authoritative row to its abandoned state + disarm the executing panel's
// page resolver via the same remote-result lane. The loop has ALREADY
// recorded the '[Tool call abandoned …]' placeholder — the orphan promise
// resolution below is discarded by the loop's _interrupted branch.
function abandonPendingUIToolCall(chatId, toolCallId, reason) {
    var result = { success: false, cancelled: true, abandoned: true, message: 'Tool call abandoned — ' + (reason || 'interrupted') };
    // Locate the seeded row FIRST — the page-side resolver map is keyed by
    // promptId, so the forward below must carry the real promptId.
    var row = null;
    var chat = chatId && chats[chatId];
    if (chat && Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var m = chat.messages[i];
            if (m && m.role === 'prompt_user' && m.toolCallId === toolCallId && m.status === 'pending') { row = m; break; }
        }
    }
    var pending = _pendingUIToolCalls[toolCallId];
    if (pending) {
        if (pending._backstopTimer) { clearTimeout(pending._backstopTimer); pending._backstopTimer = null; }
        delete _pendingUIToolCalls[toolCallId];
        if (pending.name === 'prompt_user' && pending.port && row) {
            // Disarm the executing panel's pendingPromptResolvers entry and
            // dismiss its live form (page: _handleRemotePromptResult).
            try { pending.port.postMessage({ type: 'prompt-user-remote-result', chatId: chatId, promptId: row.promptId, result: result }); } catch (e) {}
        }
        try { pending.resolve(result); } catch (e2) {}
    }
    // Parked twin (no panel was connected, or the executor closed): resolve +
    // drop it so the 24h TTL closure isn't the only thing bounding it.
    cancelParkedToolCall(chatId, toolCallId, reason || 'abandoned');
    // Flip the authoritative row (seeded by MP-1) so every panel's form
    // dismisses and shows 'Abandoned' instead of a live Submit button.
    if (row) {
        row.status = 'cancelled';
        row.abandoned = true;
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        AgentEvents.emit('messagesAppended', { chatId: chatId, reason: 'prompt-user-abandoned' });
    }
}

// =============================================================
// Pick an executor port for a UI tool. Currently FIRST-WINS (the
// first connected panel handles the call). If you want round-robin
// or affinity-by-chat in future, change this function.
// =============================================================
function pickExecutorPort() {
    var it = _agentSubscribers.values();
    var first = it.next();
    return first.done ? null : first.value;
}

// =============================================================
// Wrap executeTool. The original dispatcher (in tools/020-tool-
// execution.js) handles every tool via if-branches and is
// reassigned here. The wrapper:
//   • for headless tools → calls the original locally
//   • for UI tools → routes to a panel; parks if no panel
// =============================================================
var _executeToolLocal = executeTool;
executeTool = async function(name, args, messageIndex, options) {
    var _isHeadless = (typeof isHeadlessTool === 'function') && isHeadlessTool(name);

    // Headless tools run in offscreen directly. The original
    // dispatcher already does its own permission check via
    // requestProgrammaticToolApproval (see worker stub below).
    if (_isHeadless) {
        return await _executeToolLocal(name, args, messageIndex, options);
    }

    // -------- Sub-agent tool-call counter (UI tools) --------
    // DISPLAY ONLY — there is no cap and nothing here can refuse a call.
    // Headless tools are counted inside _executeToolLocal's gate
    // (tools/020-tool-execution.js). Non-headless UI tools never reach
    // _executeToolLocal in the SW — they route straight to the panel below — so
    // without this the authoritative counter would silently ignore every
    // iframe_tool / take_screenshot / html_widget / display / prompt_user /
    // get_skill / manage_skill call a sub makes, and the Workers card would
    // under-report. The SW is the authoritative SubAgents context, so count
    // here. (The page also runs _executeToolLocal's gate when it executes the
    // routed tool, but that mutates its read-only mirror, which the next SW
    // snapshot clobbers — harmless, never the authoritative count.) All UI
    // tools are productive work; none are in the lifecycle/handle exempt set
    // (those are all headless).
    if (typeof SubAgents !== 'undefined' && SubAgents.onToolCallInSubAgent) {
        var _subChatId = (options && options.chatId)
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        // NESTED-CALL EXEMPTION (mirrors _executeToolLocal's gate in
        // tools/020-tool-execution.js): a UI tool dispatched from INSIDE a
        // js_eval sandbox / skill-tool run arrives here via the offscreen
        // 'sw-exec-tool' relay with fromSandbox:true — it is part of ONE
        // already-counted top-level call, so it must not be counted twice.
        // fromWidget covers the html_widget postMessage bridge.
        var _nestedCall = !!(options && (options.fromSandbox || options.fromWidget));
        if (!_nestedCall && _subChatId && typeof chats !== 'undefined' && chats[_subChatId]
            && chats[_subChatId].isSubAgent) {
            // Bookkeeping only — onToolCallInSubAgent bumps the display counter
            // and returns nothing. Never gate dispatch on its result.
            SubAgents.onToolCallInSubAgent(_subChatId);
        }
    }

    // UI-required tool. Route to a panel; if none connected, park.
    var chatId = (options && options.chatId) || activeStreamingChatId;
    var toolCallId = (options && options.toolCallId)
        || ('ui_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
    var port = pickExecutorPort();

    var sandboxCtx = (options && (options.fromSandbox || options.parentToolCallId))
        ? { fromSandbox: !!options.fromSandbox, parentToolCallId: options.parentToolCallId || null }
        : null;
    // Carry the assistant-message index to the page executor. Without it the
    // page runs the tool with messageIndex undefined and any recordMutated it
    // emits is stamped -1 — which renderInlineChanges filters out, so the
    // record never shows in the chat's Artifacts block. Piggybacks on
    // sandboxCtx so it survives parkUIToolCall → replay re-dispatch too.
    if (typeof messageIndex === 'number' && messageIndex >= 0) {
        sandboxCtx = sandboxCtx || {};
        sandboxCtx.messageIndex = messageIndex;
    }

    var result = await new Promise(function(resolve, reject) {
        // Cross-restart reconciliation: the panel is already running this
        // tool from before the SW died. Adopt the in-flight execution
        // instead of dispatching a second one.
        var adopted = _panelAdoptedTools[toolCallId];
        if (adopted) {
            delete _panelAdoptedTools[toolCallId];
            var buffered = _adoptedResults[toolCallId];
            if (buffered) {
                delete _adoptedResults[toolCallId];
                if (buffered.error) reject(buffered.error);
                else resolve(buffered.result);
                return;
            }
            // SWM3F-1 / N1 / N2: register a pending entry that a late real result
            // settles, a disconnect clean-rejects, and (for a port-less tombstone)
            // a backstop eventually rejects. NEVER re-dispatch — the tool was already
            // sent to a (possibly now-gone) panel; a second dispatch would double a
            // side effect. `adopted` is either a LIVE marker (has .port — the adopting
            // panel is connected & executing) or a port-less TOMBSTONE ({dispatched:
            // true} left by B2 eviction / _unregisterPanel's dead-port branch).
            // DELIBERATELY omit `name` for side-effecting tools so _unregisterPanel's
            // disconnect scan clean-rejects rather than blind-redispatching a tool that
            // may have already run. EXCEPTION (SWM3-T2): prompt_user carries name+input
            // (+sandboxCtx) so a live-marker adoption whose panel later disconnects is
            // RE-PARKED (entry.name truthy -> parkUIToolCall alreadyDispatched) and
            // re-SHOWN on a survivor via replay — re-asking the user has no side effect
            // to double, whereas clean-rejecting silently drops an unanswered prompt.
            _pendingUIToolCalls[toolCallId] = { resolve: resolve, reject: reject, startedAt: Date.now(), port: adopted.port || null, chatId: adopted.chatId };
            if (name === 'prompt_user') {
                _pendingUIToolCalls[toolCallId].name = 'prompt_user';
                _pendingUIToolCalls[toolCallId].input = args;
                _pendingUIToolCalls[toolCallId].sandboxCtx = sandboxCtx;
            }
            // A live-port adoption relies on _unregisterPanel's disconnect scan to
            // clean-reject (no backstop — matches the prior SWM3F-1 behavior). A
            // port-less tombstone has NO live panel for that scan to match, so arm
            // the backstop here (prompt_user exempt — see armRedispatchBackstop).
            if (!adopted.port) {
                // SWM3-G-HANG: armRedispatchBackstop is a NO-OP for prompt_user, so a
                // port-less tombstone adoption of a prompt_user whose executor died is
                // never bounded and never re-shown. Re-asking the user is correct (no
                // side effect to double), so re-dispatch to a surviving port when one is
                // connected.
                if (name === 'prompt_user') {
                    var _survPort = pickExecutorPort();
                    if (_survPort) {
                        dispatchUIToolToPort(_survPort, chatId, toolCallId, name, args, resolve, reject, sandboxCtx);
                        return;
                    }
                    // SWM3-T1: NO panel is connected. The pending entry registered just
                    // above lives in _pendingUIToolCalls, which replayParkedToolCalls does
                    // NOT iterate, and armRedispatchBackstop below is a no-op for
                    // prompt_user — so it would hang forever (never re-shown, never bounded).
                    // Convert it into a real already-dispatched PARKED call so a future
                    // panel reconnect's replayParkedToolCalls re-dispatches it (replay's
                    // alreadyDispatched + name==='prompt_user' arm re-shows the prompt).
                    // Drop the orphaned pending entry first.
                    delete _pendingUIToolCalls[toolCallId];
                    parkUIToolCall(chatId, toolCallId, name, args, resolve, reject, sandboxCtx, true);
                    return;
                }
                armRedispatchBackstop(toolCallId, name);
            }
            return;
        }
        if (!port) {
            parkUIToolCall(chatId, toolCallId, name, args, resolve, reject, sandboxCtx);
            return;
        }
        dispatchUIToolToPort(port, chatId, toolCallId, name, args, resolve, reject, sandboxCtx);
    });

    // Mirror chat-level mutations made by the page-side tool back into the
    // SW's chat object. Page-side UI tools (display, html_widget, …) set
    // chat.displays / chat.widgets on the page's chat mirror; without
    // copying them here the SW's next save (after the agent loop's
    // recordToolResult) clobbers the page's saved chat with a version
    // missing these fields, and the user sees "Display not found" /
    // missing widgets on reload.
    // TOMBSTONE: `chats[chatId]` may be a DELETE tombstone ({messages: [],
    // _deleted: true}) installed by the 'update-chat' explicit-delete lane
    // (worker/130-port-bridge.js) while this UI tool was still blocked — the
    // classic case is prompt_user / show_action_button, which set
    // result._message_persist on BOTH submit and cancel
    // (tools/100-prompt-user.js, tools/120-actions.js) and can resolve long
    // AFTER the user deleted the chat. The `_message_persist` mirror below
    // would then push a message onto the tombstone, giving it
    // messages.length === 1 — which puts it into `desired`
    // (worker/115-storage.js:116), drops it out of the unbudgeted
    // explicit-delete lane (:153) and RE-PUTS the row: the deleted chat
    // resurrects on reload. A tombstone must never gain a message, so skip
    // the whole mirror block for it (the other arms — displays, widgets,
    // targetTabId — are equally pointless on a deleted chat).
    if (result && chatId && chats[chatId] && !chats[chatId]._deleted) {
        if (result._display_persist) {
            var dp = result._display_persist;
            if (!chats[chatId].displays) chats[chatId].displays = {};
            var dpEntry = { template: dp.template, args: dp.args };
            // Preserve eager-render attachment: when the display was created
            // from inside a sandbox via executeTool('display', ...), the
            // entry carries msgIndex + eager flag so the renderer emits it
            // alongside the parent tool's result (no placeholder-in-text needed).
            if (dp.eager) {
                dpEntry.msgIndex = dp.msgIndex;
                dpEntry.eager = true;
            }
            chats[chatId].displays[dp.displayId] = dpEntry;
            delete result._display_persist;
        }
        if (result._widget_persist) {
            var _wp = result._widget_persist;
            // CROSS-CHAT: mirror onto the widget's OWNING chat (_wp.chatId, stamped at
            // creation in tools/080-widget-tools.js), NOT the chat that ISSUED the tool
            // call. An agent running in chat A that edits a widget living in chat B (a
            // sub-agent editing its parent chat's widget, or edit_html against a
            // Home-pinned widget) used to upsert the post-edit widget into chat A, so
            // chat B's authoritative SW copy kept the PRE-edit html — and the SW, being
            // the authoritative writer, re-persisted/re-broadcast that stale copy and
            // clobbered the page-side save (observed: widgets[].html reverting
            // 13795 -> 11252 bytes on a chat that wasn't even running). Same owning-chat
            // rule the page-side writers already use (tools/010-iframe-tool.js edit_html,
            // tools/080-widget-tools.js saveWidgetCodeEdit "B-B3").
            var _wpChat = chats[_wp.chatId || chatId];
            // No SW record for the owning chat means the SW never saw that chat, so
            // there is no stale snapshot of it to clobber — skip the mirror, but
            // loudly (same call as the 'record-mutation' handler in
            // worker/130-port-bridge.js). Falling back to the ISSUING chat here would
            // inject a foreign widget — carrying chat B's msgIndex — into chat A.
            // NOTE: skipping the mirror is NOT proof the widget is durable. The
            // page-side saveChatsToStorage() commits it only when the owning chat is
            // not _payloadsEvicted — both realms' put-loops skip such a chat
            // (ui/070-dashboard-ui.js:2011, worker/115-storage.js:178) and the page
            // loader flags every chat outside the newest 8. That is what the MEMFIX
            // ensureChatPayloads guard in tools/010-iframe-tool.js edit_html is for;
            // without it the durable write is silently dropped for this exact case.
            // A DASHBOARD-ONLY widget (source chat deleted) also lands here by
            // design: its durable copy lives in the page-side dashboard store
            // (saveDashboardWidget in edit_html), which the SW chat rewrite never
            // touches — so the skip is correct, not a loss.
            if (!_wpChat) {
                console.warn('[tool-routing] widget mirror skipped: no SW record for owning chat '
                    + (_wp.chatId || chatId) + ' (widget ' + _wp.id + ')');
            } else {
                if (!_wpChat.widgets) _wpChat.widgets = [];
                // Upsert by id. html_widget creation sends a brand-new widget (id absent
                // -> append). edit_html now re-sends the SAME id with updated html/
                // contentVersion; pushing unconditionally would DUPLICATE the widget and
                // leave the stale copy first, so getWidgetById / the ?widget= deep-link
                // temp tab (take_screenshot) would still read the OLD html. Update in
                // place so the SW's authoritative chat — and its diff-save rewrite —
                // carries the post-edit html.
                var _wpIdx = _wpChat.widgets.findIndex(function(w) { return w && w.id === _wp.id; });
                if (_wpIdx !== -1) _wpChat.widgets[_wpIdx] = _wp;
                else _wpChat.widgets.push(_wp);
            }
            delete result._widget_persist;
        }
        // iframe_tool navigate sets chat.targetTabId page-side. Without this
        // mirror, the SW's chat snapshot wipes targetTabId in the panel and
        // the next take_screenshot / iframe_tool call targets the wrong tab.
        if (result._target_tab_persist != null) {
            chats[chatId].targetTabId = result._target_tab_persist;
            delete result._target_tab_persist;
        }
        // A SUB-AGENT's update_action_state progress card. The page-side tool
        // attached the normalized snapshot to its result (its chats/SubAgents
        // globals are read-only mirrors); persist it here in the SW — the
        // authoritative writer — onto the registry record (agent_status
        // exposes it to the parent) and the parent chat's sub_report card
        // (renderSubReport draws the live tasks checklist). Strip the marker
        // so it never reaches the model / the persisted tool result row.
        if (result._sub_action_state) {
            try {
                if (typeof SubAgents !== 'undefined' && SubAgents.recordActionState) {
                    SubAgents.recordActionState(chatId, result._sub_action_state);
                }
            } catch (_) { /* never fail the tool result over a progress mirror */ }
            delete result._sub_action_state;
        }
        // Page-side tools (prompt_user, show_action_button) that push a
        // custom-role message into chat.messages need it mirrored to the SW
        // so the SW's snapshot doesn't wipe it. Splice the message in just
        // before the tool_result slot (or placeholder) for this toolCallId.
        if (result._message_persist && chats[chatId].messages) {
            var msgs = chats[chatId].messages;
            var mp = result._message_persist;
            // MP-3: prompt_user rows are now ALSO seeded at dispatch time
            // (_swSeedPromptRow), so the resolve-time mirror must update the
            // existing row IN PLACE instead of splicing a duplicate. Never
            // downgrade an already-resolved row back to pending (a stale
            // pending object can arrive when a remote settle raced the
            // executor's own resolve).
            var existingIdx = -1;
            if (mp.role === 'prompt_user' && mp.promptId) {
                for (var xi = 0; xi < msgs.length; xi++) {
                    if (msgs[xi] && msgs[xi].role === 'prompt_user' && msgs[xi].promptId === mp.promptId) { existingIdx = xi; break; }
                }
            }
            if (existingIdx >= 0) {
                if (!(mp.status === 'pending' && msgs[existingIdx].status !== 'pending')) {
                    msgs[existingIdx] = mp;
                }
            } else {
                var insertIdx = -1;
                for (var mi = msgs.length - 1; mi >= 0; mi--) {
                    if (msgs[mi].role === 'tool' && msgs[mi].tool_call_id === toolCallId) {
                        insertIdx = mi;
                        break;
                    }
                }
                if (insertIdx >= 0) {
                    msgs.splice(insertIdx, 0, result._message_persist);
                } else {
                    msgs.push(result._message_persist);
                }
            }
            delete result._message_persist;
        }
    }
    return result;
};

// =============================================================
// Worker-side approval-prompt stub.
//
// The shared dispatcher calls requestProgrammaticToolApproval which
// lives in src/js/ui/150-tool-approval.js (page-only — DOM heavy).
// In offscreen we replicate just enough of that flow: check the
// permission, auto-approve 'allow'/'auto' (no confirm), and route
// 'ask' prompts to a panel via port (or park).
//
// This duplicates logic with ui/150-tool-approval.js — accepted for
// the offscreen case because that file is page-only and we can't
// share it. Keep them in sync if either evolves.
// =============================================================
if (typeof requestProgrammaticToolApproval !== 'function') {
    // The shared dispatcher loaded BEFORE this file references
    // requestProgrammaticToolApproval but doesn't call it at load
    // time — only at executeTool time. So a function declaration here
    // patches the binding before the first call.
    requestProgrammaticToolApproval = async function(toolName, args, options) {
        options = options || {};

        var methodOrAction = null;
        if (toolName === 'servicenow_api' && args && args.method) {
            methodOrAction = args.method.toUpperCase();
        } else if (toolName === 'manage_skill' && args && args.action) {
            methodOrAction = args.action;
        } else if (toolName === 'iframe_tool' && args && args.action) {
            methodOrAction = args.action;
        } else if (toolName === 'workspace' && args && args.action) {
            methodOrAction = args.action;
        } else if (toolName === 'document' && args && args.action) {
            methodOrAction = args.action;
        }

        var permissionKey = resolvePermissionKey(toolName, methodOrAction);
        var permission = getToolPermission(toolName, methodOrAction);
        var displayName = getToolDisplayName(toolName, methodOrAction);

        var baseResult = { permission: permission, displayName: displayName, permissionKey: permissionKey };

        if (permission === 'disabled') {
            return Object.assign({ allowed: false, error: displayName + ' is disabled by user settings' }, baseResult);
        }
        // web_fetch to the CONFIGURED GitHub REST base is agent-governed via
        // the `confirm` param (mirrors the page gate in ui/150-tool-approval.js).
        // Downgrade the DEFAULT 'ask' only; explicit user overrides aren't 'ask'.
        if (toolName === 'web_fetch' && permission === 'ask' && args && args.url
            && typeof isConfiguredGitHubApiUrl === 'function'
            && (await isConfiguredGitHubApiUrl(args.url))) {
            permission = 'auto';
            baseResult.permission = 'auto';
        }
        if (permission === 'allow') {
            return Object.assign({ allowed: true }, baseResult);
        }
        if (permission === 'auto' && !(args && args.confirm === true)) {
            return Object.assign({ allowed: true }, baseResult);
        }

        // 'ask' (or 'auto' + confirm:true): check pre-existing approval
        // recorded in the chat by an earlier panel-side run.
        var targetChatId = options.chatId || activeStreamingChatId;
        var toolCallId = options.toolCallId
            || ('prog_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
        var chat = chats[targetChatId];
        if (chat && chat.messages && toolCallId) {
            for (var i = 0; i < chat.messages.length; i++) {
                var msg = chat.messages[i];
                if (msg.role === 'approval' && msg.toolCallId === toolCallId) {
                    if (msg.status === 'allowed' || msg.status === 'session_allowed' || msg.status === 'always_allowed') {
                        return Object.assign({ allowed: true }, baseResult);
                    } else if (msg.status === 'denied') {
                        return Object.assign({ allowed: false, error: displayName + ' was DENIED by user. STOP immediately — do NOT retry or work around this. Acknowledge the denial and ask the user how to proceed.' }, baseResult);
                    }
                    break;
                }
            }
        }

        // Need a fresh approval. Route to a connected panel; park if none.
        // The panel's approval-prompt code pushes an `approval` message
        // into the chat with status 'pending', and a follow-up message
        // resolves it once the user clicks. We poll the chat message
        // list for that resolution (same pattern the page-side uses).
        var port = pickExecutorPort();
        var approvalRequestId = 'approval_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        var approvalPromise = new Promise(function(resolve, reject) {
            if (!port) {
                // SWM3F-3: no panel — PARK only. Do NOT register a
                // _pendingUIToolCalls entry here: a port:null entry is invisible
                // to every disconnect scan (they filter on entry.port) and would
                // leak until SW teardown. The parked entry carries resolve/reject;
                // replayParkedToolCalls re-registers a real pending entry (with a
                // live port) through the approval-prompt path once a panel connects
                // (see SWM3F-2).
                parkUIToolCall(targetChatId, approvalRequestId, '__approval_prompt__', {
                    displayName: displayName, args: args, permissionKey: permissionKey,
                    toolCallId: toolCallId, toolName: toolName,
                    widgetName: options.widgetName || null
                }, resolve, reject);
                return;
            }
            // Port exists — register the pending entry so exec-approval-prompt-result
            // resolves it, and so _unregisterPanel(port) can see it when THIS panel
            // disconnects before the user answers (without it the entry is invisible
            // to the disconnect scan and `await approvalPromise` hangs forever).
            // `name` is intentionally left UNSET so _unregisterPanel takes its
            // clean-reject branch — an approval cannot be faithfully replayed as an
            // exec-tool.
            var _abEnvelope = {
                type: 'exec-approval-prompt',
                chatId: targetChatId,
                toolCallId: toolCallId,
                approvalRequestId: approvalRequestId,
                displayName: displayName,
                args: args,
                permissionKey: permissionKey,
                toolName: toolName,
                // Forward the originating widget's name so the panel-side prompt
                // labels the notification correctly (mirrors the page-side path
                // where options flow into showToolApprovalPrompt directly).
                widgetName: options.widgetName || null
            };
            _pendingUIToolCalls[approvalRequestId] = {
                resolve: function(v) { resolve(v); },
                reject: function(e) { reject(e); },
                startedAt: Date.now(),
                port: port,
                chatId: targetChatId,
                // AB: approval marker + stashed envelope so 130-port-bridge can
                // rebind/re-park on primary disconnect and re-deliver to
                // late-connecting panels. `name` stays UNSET (see comment above).
                isApproval: true,
                toolCallId: toolCallId,
                envelope: _abEnvelope
            };
            // AB-1: seed the authoritative pending row BEFORE any port post —
            // per-port FIFO delivery means every panel merges the row (via the
            // chat-inlined messagesAppended) before its exec-approval-prompt
            // arrives, so showToolApprovalPrompt takes its REUSE path instead
            // of pushing a duplicate page-local row.
            _swSeedApprovalRow(targetChatId, {
                role: 'approval',
                toolName: displayName,
                actualToolName: toolName || displayName,
                args: args,
                permissionKey: permissionKey,
                toolCallId: toolCallId,
                status: 'pending'
            });
            // AB-3: fan out to ALL panels (approvals are pure UI, first verdict
            // wins); `port` stays PRIMARY for OS-notify + give-up-deny duties.
            _broadcastApprovalPrompt(_abEnvelope, port);
        });

        // If this call runs inside a background handle (options._handleId —
        // legacy plumbing), mark awaitingApproval so a handle snapshot shows the tool is
        // blocked on user input rather than slow network work. Mirrors the
        // page-side wiring in ui/150-tool-approval.js.
        if (options._handleId && typeof Handles !== 'undefined' && Handles.markAwaitingApproval) {
            Handles.markAwaitingApproval(options._handleChatId, options._handleId, true);
        }
        // RES-6: a SUB-AGENT parked on a permission prompt is invisible to its
        // parent — surface the park (once per episode) and the user's verdict
        // through the registry so the parent gets a lifecycle notice.
        var _subApprovalChat = !!(targetChatId && chats[targetChatId] && chats[targetChatId].isSubAgent
            && typeof SubAgents !== 'undefined' && SubAgents.onSubApprovalEvent);
        if (_subApprovalChat) {
            try { SubAgents.onSubApprovalEvent(targetChatId, 'requested', { displayName: displayName }); } catch (eN) {}
        }
        try {
            var approved = await approvalPromise;
            // RES-6: user verdict — stamps user_interactions.last_user_approval_at
            // and notifies the parent on denial.
            if (_subApprovalChat) {
                try { SubAgents.onSubApprovalEvent(targetChatId, (approved && approved.allowed) ? 'approved' : 'denied', { displayName: displayName }); } catch (eN2) {}
            }
            if (approved && approved.allowed) {
                return Object.assign({ allowed: true }, baseResult);
            }
            return Object.assign({ allowed: false, error: displayName + ' was DENIED by user. STOP immediately — do NOT retry or work around this. Acknowledge the denial and ask the user how to proceed.' }, baseResult);
        } catch (e) {
            // RES-6: prompt aborted (panel disconnect etc.) — not a user verdict;
            // just release the pending-approval episode counter.
            if (_subApprovalChat) {
                try { SubAgents.onSubApprovalEvent(targetChatId, 'aborted', { displayName: displayName }); } catch (eN3) {}
            }
            return Object.assign({ allowed: false, error: 'Approval prompt error: ' + (e && e.message ? e.message : String(e)) }, baseResult);
        } finally {
            if (options._handleId && typeof Handles !== 'undefined' && Handles.markAwaitingApproval) {
                Handles.markAwaitingApproval(options._handleChatId, options._handleId, false);
            }
        }
    };
}
