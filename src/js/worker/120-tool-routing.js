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
//      tools replay in order. TTL: 24h.
//
// The page bundle never loads this file (it lives in src/js/worker/
// which is excluded from the page tier list). Panels run UI tools
// directly via the unwrapped executeTool.
// =============================================================

var PARKED_TOOL_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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
        // Drop the buffered result payload — its only consumer is the executeTool
        // adoption arm within this window; past it nobody wants it.
        delete _adoptedResults[toolCallId];
        if (!m) return;
        // Orphaned re-stamp: executeTool ALREADY ran for this id (a pending entry
        // exists, which owns reconciliation). The marker is stray — delete it (the
        // original always deleted; keeping it would leak). No tombstone needed.
        if (_pendingUIToolCalls[toolCallId]) { delete _panelAdoptedTools[toolCallId]; return; }
        // SWM3-T3: don't downgrade a marker whose adopting panel is STILL connected.
        // The first-level TTL bounds a marker the resumed loop never consumed, but a
        // live adopting port means the tool may still be executing (or about to be
        // adopted) — downgrading to a port-less tombstone here strips the live port, so
        // a later panel disconnect's _unregisterPanel scan (filters on entry.port)
        // can't match it and the awaited promise hangs. Re-arm the TTL and bail; the
        // pending-entry check above already handled the loop-already-ran case.
        if (m.port && typeof _swPanelPorts !== 'undefined' && _swPanelPorts.has(m.port)) {
            scheduleAdoptedEviction(toolCallId);
            return;
        }
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
    pe._backstopTimer = setTimeout(function() {
        var p = _pendingUIToolCalls[toolCallId];
        if (p && p._backstopTimer) {
            delete _pendingUIToolCalls[toolCallId];
            try { p.reject(new Error('panel closed mid-tool; result unrecoverable — not re-executed to avoid duplicate side effects')); } catch (e) {}
        }
    }, REDISPATCH_RECONCILE_TTL_MS);
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
                _panelAdoptedTools[c.toolCallId] = { chatId: c.chatId, name: c.name };
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
    parkedToolCallsByChatId[chatId].push(entry);
    AgentEvents.emit('toolParked', { chatId: chatId, toolCallId: toolCallId, name: name, input: input });
    // Schedule TTL cancellation.
    setTimeout(function() {
        cancelParkedToolCall(chatId, toolCallId, 'TTL expired (24h with no panel)');
    }, PARKED_TOOL_TTL_MS);
}

function cancelParkedToolCall(chatId, toolCallId, reason) {
    var arr = parkedToolCallsByChatId[chatId];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
        if (arr[i].toolCallId === toolCallId) {
            var entry = arr[i];
            arr.splice(i, 1);
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
                    _pendingUIToolCalls[entry.toolCallId] = {
                        resolve: entry.resolve,
                        reject: entry.reject,
                        startedAt: Date.now(),
                        port: port,
                        chatId: chatId
                    };
                    port.postMessage({
                        type: 'exec-approval-prompt',
                        chatId: chatId,
                        toolCallId: _ap.toolCallId,
                        approvalRequestId: entry.toolCallId,
                        displayName: _ap.displayName,
                        args: _ap.args,
                        permissionKey: _ap.permissionKey,
                        toolName: _ap.toolName
                    });
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
    }
    port.postMessage(msg);
}

function resolvePendingUIToolCall(toolCallId, result, error) {
    var pending = _pendingUIToolCalls[toolCallId];
    if (pending) {
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
//
// ASYNC HANDLE INTERCEPT (await: false) — see the matching block in
// tools/020-tool-execution.js for the headless-tool wrap. UI-routed
// tools have to be intercepted HERE instead, because the SW wrapper
// short-circuits the call BEFORE _executeToolLocal runs — meaning
// the in-dispatcher wrap path never fires for non-headless tools.
// Symptom of the missing intercept: caller gets a handle back from
// the page's own dispatcher (which DID wrap), but the handle lives
// in the page-side Handles registry while await_handle/poll_handle
// run in the SW and look up the SW-side registry → "unknown handle".
// =============================================================
var _executeToolLocal = executeTool;
executeTool = async function(name, args, messageIndex, options) {
    // ASYNC WRAP for UI tools — must run BEFORE the headless short-circuit
    // so headless tools keep their existing in-dispatcher wrap (they go
    // through _executeToolLocal which handles `await:false` itself).
    var _isHeadless = (typeof isHeadlessTool === 'function') && isHeadlessTool(name);
    if (!_isHeadless
        && args && Object.prototype.hasOwnProperty.call(args, 'await')
        && args.await === false
        && !(options && options._asyncWrapping)
        && typeof Handles !== 'undefined'
        && !(Handles.ALWAYS_SYNC_TOOLS && Handles.ALWAYS_SYNC_TOOLS[name])) {
        // Strip the meta-key so the recursive call goes to the panel without it.
        var _strippedAsync = {};
        for (var _ak in args) { if (_ak !== 'await') _strippedAsync[_ak] = args[_ak]; }
        var _chatIdForHandle = (options && options.chatId)
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        var _displayName = (typeof getToolDisplayName === 'function')
            ? getToolDisplayName(name, _strippedAsync.method || _strippedAsync.action)
            : name;
        var _nextOptions = {};
        for (var _ok in (options || {})) _nextOptions[_ok] = options[_ok];
        _nextOptions._asyncWrapping = true;
        var _started = Handles.start(_chatIdForHandle, name, _strippedAsync, _displayName, function() {
            // Recurse through the wrapped executeTool so the call is routed
            // to the panel as a normal sync UI tool call (the recursive
            // invocation has `_asyncWrapping` set, so this block is skipped).
            return executeTool(name, _strippedAsync, messageIndex, _nextOptions);
        });
        _nextOptions._handleId = _started.handleId;
        _nextOptions._handleChatId = _chatIdForHandle;
        // Track on the owning sub-agent so stop_sub_agent can cancel — same
        // bookkeeping as the in-dispatcher wrap in tools/020-tool-execution.js.
        try {
            if (_chatIdForHandle && typeof chats !== 'undefined' && chats[_chatIdForHandle]
                && chats[_chatIdForHandle].isSubAgent
                && typeof SubAgents !== 'undefined' && SubAgents.getById) {
                var _ownerSub = SubAgents.getById(chats[_chatIdForHandle].subAgentId);
                if (_ownerSub) {
                    _ownerSub.pending_handles = _ownerSub.pending_handles || [];
                    if (_ownerSub.pending_handles.indexOf(_started.handleId) === -1) {
                        _ownerSub.pending_handles.push(_started.handleId);
                    }
                    if (Handles.await) {
                        Handles.await(_chatIdForHandle, _started.handleId, 0).then(function() {
                            var _idx = _ownerSub.pending_handles.indexOf(_started.handleId);
                            if (_idx >= 0) _ownerSub.pending_handles.splice(_idx, 1);
                        });
                    }
                }
            }
        } catch (_) { /* best-effort; never break async wrap */ }
        return {
            success: true,
            handle: _started.handleId,
            status: 'pending',
            tool: name,
            note: 'Async tool call — use await_handle("' + _started.handleId + '") to collect the result.'
        };
    }

    // Headless tools run in offscreen directly. The original
    // dispatcher already does its own permission check via
    // requestProgrammaticToolApproval (see worker stub below).
    if (_isHeadless) {
        return await _executeToolLocal(name, args, messageIndex, options);
    }

    // -------- Sub-agent tool-call budget (UI tools) --------
    // Headless tools count toward max_tool_calls inside _executeToolLocal's gate
    // (tools/020-tool-execution.js). Non-headless UI tools never reach
    // _executeToolLocal in the SW — they route straight to the panel below — so
    // without this the authoritative budget would silently ignore every
    // iframe_tool / take_screenshot / html_widget / display / prompt_user /
    // get_skill / manage_skill call a sub makes, and the cap would never fire.
    // The SW is the authoritative SubAgents context, so count here. (The page
    // also runs _executeToolLocal's gate when it executes the routed tool, but
    // that mutates its read-only mirror, which the next SW snapshot clobbers —
    // harmless, never the authoritative count.) All UI tools are productive work;
    // none are in the lifecycle/handle exempt set (those are all headless). Runs
    // only on the real execution: the await:false async-wrap above returns the
    // handle before reaching here, and the deferred recursive call (_asyncWrapping)
    // skips the wrap block and lands here exactly once.
    if (typeof SubAgents !== 'undefined' && SubAgents.onToolCallInSubAgent) {
        var _budgetChatId = (options && options.chatId)
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        if (_budgetChatId && typeof chats !== 'undefined' && chats[_budgetChatId]
            && chats[_budgetChatId].isSubAgent) {
            var _budgetOk = SubAgents.onToolCallInSubAgent(_budgetChatId);
            if (!_budgetOk) {
                return { success: false, error: 'Sub-agent exceeded max_tool_calls budget. The sub has been stopped.', _budget_exhausted: true };
            }
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
    if (result && chatId && chats[chatId]) {
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
            if (!chats[chatId].widgets) chats[chatId].widgets = [];
            // Upsert by id. html_widget creation sends a brand-new widget (id absent
            // -> append). edit_html now re-sends the SAME id with updated html/
            // contentVersion; pushing unconditionally would DUPLICATE the widget and
            // leave the stale copy first, so getWidgetById / the ?widget= deep-link
            // temp tab (take_screenshot) would still read the OLD html. Update in
            // place so the SW's authoritative chat — and its store.clear()+rewrite
            // save — carries the post-edit html.
            var _wp = result._widget_persist;
            var _wpIdx = chats[chatId].widgets.findIndex(function(w) { return w && w.id === _wp.id; });
            if (_wpIdx !== -1) chats[chatId].widgets[_wpIdx] = _wp;
            else chats[chatId].widgets.push(_wp);
            delete result._widget_persist;
        }
        // iframe_tool navigate sets chat.targetTabId page-side. Without this
        // mirror, the SW's chat snapshot wipes targetTabId in the panel and
        // the next take_screenshot / iframe_tool call targets the wrong tab.
        if (result._target_tab_persist != null) {
            chats[chatId].targetTabId = result._target_tab_persist;
            delete result._target_tab_persist;
        }
        // Page-side tools (prompt_user, show_action_button) that push a
        // custom-role message into chat.messages need it mirrored to the SW
        // so the SW's snapshot doesn't wipe it. Splice the message in just
        // before the tool_result slot (or placeholder) for this toolCallId.
        if (result._message_persist && chats[chatId].messages) {
            var msgs = chats[chatId].messages;
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
                    toolCallId: toolCallId, toolName: toolName
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
            _pendingUIToolCalls[approvalRequestId] = {
                resolve: function(v) { resolve(v); },
                reject: function(e) { reject(e); },
                startedAt: Date.now(),
                port: port,
                chatId: targetChatId
            };
            port.postMessage({
                type: 'exec-approval-prompt',
                chatId: targetChatId,
                toolCallId: toolCallId,
                approvalRequestId: approvalRequestId,
                displayName: displayName,
                args: args,
                permissionKey: permissionKey,
                toolName: toolName
            });
        });

        // If we're inside an async-wrapped handle, mark awaitingApproval so
        // the agent's poll_handle / await_handle can see that the tool is
        // blocked on user input rather than slow network work. Mirrors the
        // page-side wiring in ui/150-tool-approval.js.
        if (options._handleId && typeof Handles !== 'undefined' && Handles.markAwaitingApproval) {
            Handles.markAwaitingApproval(options._handleChatId, options._handleId, true);
        }
        try {
            var approved = await approvalPromise;
            if (approved && approved.allowed) {
                return Object.assign({ allowed: true }, baseResult);
            }
            return Object.assign({ allowed: false, error: displayName + ' was DENIED by user. STOP immediately — do NOT retry or work around this. Acknowledge the denial and ask the user how to proceed.' }, baseResult);
        } catch (e) {
            return Object.assign({ allowed: false, error: 'Approval prompt error: ' + (e && e.message ? e.message : String(e)) }, baseResult);
        } finally {
            if (options._handleId && typeof Handles !== 'undefined' && Handles.markAwaitingApproval) {
                Handles.markAwaitingApproval(options._handleChatId, options._handleId, false);
            }
        }
    };
}
