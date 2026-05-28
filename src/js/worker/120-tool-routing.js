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
self._swAdoptPanelInflight = function(payload) {
    payload = payload || {};
    var inflight = payload.inflightToolCalls;
    var completed = payload.completedToolResults;
    if (inflight && inflight.length) {
        inflight.forEach(function(it) {
            if (it && it.toolCallId) {
                _panelAdoptedTools[it.toolCallId] = { chatId: it.chatId, name: it.name };
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
function parkUIToolCall(chatId, toolCallId, name, input, resolve, reject, sandboxCtx) {
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
                dispatchUIToolToPort(port, chatId, entry.toolCallId, entry.name, entry.input, entry.resolve, entry.reject, entry.sandboxCtx);
                AgentEvents.emit('toolUnparked', { chatId: chatId, toolCallId: entry.toolCallId, reason: 'replayed' });
            } catch (e) {
                // Failed to dispatch — re-park.
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
        startedAt: Date.now()
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
        if (_panelAdoptedTools[toolCallId]) {
            delete _panelAdoptedTools[toolCallId];
            var buffered = _adoptedResults[toolCallId];
            if (buffered) {
                delete _adoptedResults[toolCallId];
                if (buffered.error) reject(buffered.error);
                else resolve(buffered.result);
                return;
            }
            _pendingUIToolCalls[toolCallId] = { resolve: resolve, reject: reject, startedAt: Date.now() };
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
            chats[chatId].widgets.push(result._widget_persist);
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
            _pendingUIToolCalls[approvalRequestId] = {
                resolve: function(v) { resolve(v); },
                reject: function(e) { reject(e); },
                startedAt: Date.now()
            };
            if (!port) {
                parkUIToolCall(targetChatId, approvalRequestId, '__approval_prompt__', {
                    displayName: displayName, args: args, permissionKey: permissionKey,
                    toolCallId: toolCallId, toolName: toolName
                }, resolve, reject);
                return;
            }
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
