// =============================================================
// Page-side agent-bus port + runAgent shim.
//
// Loaded ONLY in the page bundle (not WORKER_SHARED_FILES). This
// file does three things:
//
//   1. Opens a long-lived 'agent-bus' port DIRECTLY to the service
//      worker (which now hosts the agent loop). No relay layer.
//
//   2. Receives 'agent-event' envelopes from the SW and re-emits
//      them on the local AgentEvents bus so the page-side handlers
//      (app/036-agent-event-handlers-page.js) fire exactly like
//      they used to when the loop ran in the panel itself.
//
//   3. OVERRIDES the runAgent function declared in
//      src/js/app/030-agent-loop.js. Because function declarations
//      are hoisted and the LAST one in source order wins, this
//      file's `function runAgent` replaces the in-page loop entry
//      point. The original loop body (~815 LOC of helpers +
//      streaming + tool dispatch) remains in 030-agent-loop.js
//      because the SW bundle imports the same file for the agent
//      runtime. The page bundle just doesn't call it directly
//      anymore — runAgent posts a message and waits for runFinished.
//
// File load order rationale:
//   • app/035-agent-events.js (bus) loads first
//   • app/030-agent-loop.js (real runAgent + helpers) loads next
//   • app/036-agent-event-handlers-page.js loads (registers UI handlers)
//   • app/040-send-message.js loads (calls runAgent — sees the shim
//     by virtue of function-decl hoisting picking the LAST decl)
//   • app/045 (THIS file) loads (final runAgent override + port wiring)
//
// AGENT_PORT_BRIDGE_PAGE_SENTINEL — used by build-verify grep.
// =============================================================

// One port per page lifetime. Re-opened automatically on SW restart
// because chrome.runtime.connect throws synchronously if SW is dead,
// and the page would have to react — see _openAgentBus.
var _agentBusPort = null;

// Pending runAgent calls keyed by chatId so we can resolve them on
// runFinished. Value: { resolve, reject, chatId }.
var _pendingRunAgents = {};

// Tool calls the panel is currently executing on behalf of the SW. Used
// to tell a fresh SW (after restart) which tools to ADOPT rather than
// re-dispatch — otherwise the panel would run the same tool twice
// (e.g. type the text twice into a form). Keyed by toolCallId.
var _inflightToolCalls = {};   // toolCallId -> { chatId, name, startedAt }
// Completed-but-not-yet-acked results. The panel posts exec-tool-result
// over the port best-effort, but if the SW died between receiving the
// result and persisting it (chat saved with placeholder, not real
// result), the next SW would re-dispatch without this buffer. On every
// reconnect we re-declare these alongside in-flight tools. Entries
// older than COMPLETED_RESULT_TTL_MS are dropped to bound memory.
//
// Why 60s: an MV3 SW is evicted after ~30s of idle. A tool that completed,
// got persisted to IDB, and was acked by the SW won't ever be replayed —
// so the only window we need to cover is "tool completed → SW died before
// persisting → SW restart → reconnect." That round-trip is bounded by the
// MV3 eviction timer plus a small reconnect grace, so 60s is comfortably
// over. A result that lingers beyond 60s without a SW reconnect almost
// certainly means the panel itself was closed/reopened (not relevant — the
// reopened panel won't have the result in memory anyway).
var _completedToolResults = {};  // toolCallId -> { chatId, name, result, error, completedAt }
var COMPLETED_RESULT_TTL_MS = 60 * 1000;

function _pruneCompletedResults() {
    var now = Date.now();
    Object.keys(_completedToolResults).forEach(function(tcid) {
        if (now - _completedToolResults[tcid].completedAt > COMPLETED_RESULT_TTL_MS) {
            delete _completedToolResults[tcid];
        }
    });
}

function _sendPanelHello() {
    if (!_agentBusPort) return;
    _pruneCompletedResults();
    var inflight = [];
    Object.keys(_inflightToolCalls).forEach(function(tcid) {
        var it = _inflightToolCalls[tcid];
        inflight.push({ chatId: it.chatId, toolCallId: tcid, name: it.name });
    });
    var completed = [];
    Object.keys(_completedToolResults).forEach(function(tcid) {
        var c = _completedToolResults[tcid];
        completed.push({ chatId: c.chatId, toolCallId: tcid, name: c.name, result: c.result, error: c.error });
    });
    try {
        _agentBusPort.postMessage({
            type: 'panel-hello',
            inflightToolCalls: inflight,
            completedToolResults: completed
        });
    } catch (e) {
        console.error('[agent-bus] panel-hello post failed', e);
    }
}

function _openAgentBus() {
    try {
        _agentBusPort = chrome.runtime.connect({ name: 'agent-bus' });
    } catch (e) {
        console.error('[agent-bus] connect failed, retrying in 500ms', e);
        setTimeout(_openAgentBus, 500);
        return;
    }
    _agentBusPort.onMessage.addListener(_handleAgentBusMessage);
    _agentBusPort.onDisconnect.addListener(function() {
        _agentBusPort = null;
        // SW restart — re-open. Slight delay to avoid tight loops.
        setTimeout(_openAgentBus, 250);
    });
    // Declare any tools the panel is still executing so a fresh SW
    // adopts them instead of re-dispatching. Must run synchronously
    // after connect — the SW resume gate waits ~1.5s for this.
    _sendPanelHello();
    // Re-mirror in-memory session permissions: the SW loses these on
    // restart (in-memory only, not in IDB), so without this push the user
    // would get prompted again after a SW eviction even though they
    // already chose "Allow for session" earlier.
    //
    // tool/instancePermissions: only push if THIS PAGE has already hydrated
    // them from IDB (non-empty). _openAgentBus runs at file-load time, well
    // BEFORE loadToolPermissions() in core/120-init.js completes — pushing
    // the empty defaults on cold load would CLOBBER the SW's own IDB-loaded
    // state and strand Auto-tier instances back on 'ask' for every tool.
    // loadToolPermissions re-pushes both sources once IDB read completes,
    // covering the belt-and-suspenders case.
    if (typeof pushPermissionsToOffscreen === 'function') {
        var _hasTool = toolPermissions && typeof toolPermissions === 'object' && Object.keys(toolPermissions).length > 0;
        var _hasInst = instancePermissions && typeof instancePermissions === 'object' && Object.keys(instancePermissions).length > 0;
        pushPermissionsToOffscreen({
            sessionPermissions: typeof sessionPermissions === 'object' ? sessionPermissions : null,
            toolPermissions: _hasTool ? toolPermissions : null,
            instancePermissions: _hasInst ? instancePermissions : null
        });
    }
}

function _handleAgentBusMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
        case 'agent-event':
            // Mutating events inline the chat snapshot so the page mirror
            // stays in sync without async pull-chat round-trips. Assign
            // BEFORE re-emitting so the handlers (which read chats[chatId])
            // see the updated state.
            if (msg.detail && msg.detail.chat && msg.detail.chatId) {
                chats[msg.detail.chatId] = msg.detail.chat;
            }
            // Track running state locally so the chat list pill / pause button
            // sync with offscreen without each handler having to deal with it.
            // The worker loop deletes its OWN runningChatIds[chatId] BEFORE
            // emitting runFinished (see agent-loop.js); the page mirror has
            // to do the same so renderChatList sees the cleared state.
            if (msg.eventType === 'runStarted' && msg.detail && msg.detail.chatId) {
                runningChatIds[msg.detail.chatId] = true;
            }
            if ((msg.eventType === 'runFinished' || msg.eventType === 'runCrashed') &&
                msg.detail && msg.detail.chatId) {
                delete runningChatIds[msg.detail.chatId];
            }
            // Re-emit on the local bus so app/036 handlers fire as if
            // the loop ran in this page.
            try {
                AgentEvents.emit(msg.eventType, msg.detail || {});
            } catch (e) {
                console.error('[agent-bus] re-emit failed', msg.eventType, e);
            }
            // Resolve any pending runAgent promises waiting on runFinished.
            if (msg.eventType === 'runFinished' && msg.detail && msg.detail.chatId) {
                var pr = _pendingRunAgents[msg.detail.chatId];
                if (pr) {
                    delete _pendingRunAgents[msg.detail.chatId];
                    try { pr.resolve(); } catch (e) {}
                }
            }
            return;

        case 'hello':
            // Offscreen sent us the running-chats snapshot + the list of
            // running chat ids. Merge into local state so the panel UI
            // reflects ongoing background runs immediately on connect.
            if (msg.chatsSnapshot) {
                Object.keys(msg.chatsSnapshot).forEach(function(cid) {
                    chats[cid] = msg.chatsSnapshot[cid];
                });
            }
            if (msg.runningChatIds) {
                msg.runningChatIds.forEach(function(cid) {
                    runningChatIds[cid] = true;
                });
                if (typeof renderChatList === 'function') renderChatList();
            }
            // Install initial sub-agent snapshot. The page's own
            // loadAllSubAgents at boot rehydrates from IDB so the strip
            // can paint before the SW connects, but the SW is the
            // authority during a session — overwrite the page mirror
            // with the SW's view as soon as we hear from it. After this,
            // live updates flow via the `subagent-snapshot` case below.
            if (msg.subAgentRecords && typeof SubAgents !== 'undefined' && SubAgents.applySnapshot) {
                SubAgents.applySnapshot(msg.subAgentRecords);
            }
            return;

        case 'subagent-snapshot':
            // SW pushed a registry snapshot. Full-replace via the
            // registry helper, which fires the page's _notifyListeners
            // so the workers strip + chat list re-render.
            if (typeof SubAgents !== 'undefined' && SubAgents.applySnapshot) {
                SubAgents.applySnapshot(msg.records || []);
            }
            return;

        case 'chat-snapshot':
            if (msg.chatId && msg.chat) {
                chats[msg.chatId] = msg.chat;
                if (msg.chatId === currentChatId && typeof renderMessages === 'function') {
                    renderMessages();
                }
            }
            return;

        case 'exec-tool':
            // Offscreen wants this panel to run a UI-required tool.
            // Use the existing executeTool (which is defined in
            // tools/020-tool-execution.js and dispatches every tool).
            _handleExecToolFromOffscreen(msg);
            return;

        case 'exec-approval-prompt':
            // Offscreen needs an approval for an 'ask' permission.
            _handleApprovalPromptFromOffscreen(msg);
            return;
    }
}

// Best-effort post on the bus port. The port reference can flip to null
// between the existence check and the actual postMessage call (Chrome fires
// onDisconnect synchronously inside that very window if the SW dies
// mid-call), and postMessage on a stale port throws. Wrapping isolates
// that failure from the tool result path — the buffered
// _completedToolResults entry below still lets the next SW reconcile via
// panel-hello.
//
// BUG FIX (port throw clobbers result): previously this lived inline in
// the try arm of _handleExecToolFromOffscreen. A postMessage throw would
// fall into the surrounding catch arm, which would set capturedError to
// the postMessage error and DROP the successful capturedResult. The
// reconcile then handed the SW an "error" result for a tool that
// actually succeeded.
function _postExecToolResult(envelope) {
    if (!_agentBusPort) return false;
    try {
        _agentBusPort.postMessage(envelope);
        return true;
    } catch (_) {
        return false;
    }
}

async function _handleExecToolFromOffscreen(msg) {
    _inflightToolCalls[msg.toolCallId] = {
        chatId: msg.chatId,
        name: msg.name,
        startedAt: Date.now()
    };
    var capturedResult = null;
    var capturedError = null;
    try {
        capturedResult = await executeTool(msg.name, msg.input, undefined, {
            toolCallId: msg.toolCallId,
            chatId: msg.chatId,
            // Forwarded by the SW wrapper when this UI tool was dispatched from
            // inside a sandbox (js_eval / skill). Lets executeDisplay's
            // eager-render path attach to the parent tool_result slot.
            fromSandbox: !!msg.fromSandbox,
            parentToolCallId: msg.parentToolCallId || null
        });
    } catch (e) {
        capturedError = (e && e.message) ? e.message : String(e);
    }
    // Post AFTER the tool result is captured so a transient port-throw can
    // never clobber the result. If the post fails the buffered entry below
    // will replay via the next panel-hello.
    _postExecToolResult(capturedError
        ? { type: 'exec-tool-result', toolCallId: msg.toolCallId, error: capturedError }
        : { type: 'exec-tool-result', toolCallId: msg.toolCallId, result: capturedResult });
    delete _inflightToolCalls[msg.toolCallId];
    // Buffer the result so a reconnect after a SW restart can re-post
    // it. Without this buffer, if the SW died after dispatch but
    // before saving the result, the next SW would re-dispatch and the
    // tool (e.g. iframe_tool 'type') would execute twice.
    _completedToolResults[msg.toolCallId] = {
        chatId: msg.chatId,
        name: msg.name,
        result: capturedResult,
        error: capturedError,
        completedAt: Date.now()
    };
}

async function _handleApprovalPromptFromOffscreen(msg) {
    try {
        // The page-side approval prompt lives in ui/160-notifications.js
        // (showToolApprovalPrompt). It's bound to the chat's UI and pushes
        // an `approval` message that the user clicks. Returns true/false.
        var approved = false;
        if (typeof showToolApprovalPrompt === 'function') {
            approved = await showToolApprovalPrompt(
                msg.displayName,
                msg.args,
                msg.permissionKey,
                msg.toolCallId,
                msg.toolName,
                msg.chatId,
                {}
            );
        }
        if (_agentBusPort) {
            _agentBusPort.postMessage({
                type: 'exec-approval-prompt-result',
                approvalRequestId: msg.approvalRequestId,
                allowed: !!approved
            });
        }
    } catch (e) {
        if (_agentBusPort) {
            _agentBusPort.postMessage({
                type: 'exec-approval-prompt-result',
                approvalRequestId: msg.approvalRequestId,
                allowed: false,
                error: (e && e.message) ? e.message : String(e)
            });
        }
    }
}

// =============================================================
// runAgent shim — overrides the in-page implementation from
// app/030-agent-loop.js (last function declaration wins).
//
// Signature MUST match the original (async function runAgent(overrideChatId))
// because there are ~15 call sites across the page bundle that
// `await` it. The Promise resolves when the offscreen runtime emits
// `runFinished` for the requested chat.
// =============================================================
async function runAgent(overrideChatId) {
    var chatId = overrideChatId || currentChatId;
    if (!chatId) return;
    if (runningChatIds[chatId]) {
        // Match in-page semantics: don't start a second loop for a chat
        // that's already running. Caller's await still completes when
        // the existing run does.
        if (_pendingRunAgents[chatId]) return _pendingRunAgents[chatId].promise;
        return;
    }
    // Mark running locally so the UI (chat list pill, pause button) reflects
    // it immediately. Offscreen will emit runStarted soon, which will set
    // the foreground state via the page handlers.
    runningChatIds[chatId] = true;

    var resolveFn;
    var p = new Promise(function(resolve) { resolveFn = resolve; });
    _pendingRunAgents[chatId] = { resolve: resolveFn, promise: p };

    // Make sure the port is open. The async retry in _openAgentBus
    // means it may not be there yet at boot; queue and try shortly.
    var attempt = function() {
        if (!_agentBusPort) {
            setTimeout(attempt, 50);
            return;
        }
        try {
            _agentBusPort.postMessage({
                type: 'run-agent',
                chatId: chatId,
                chat: chats[chatId],
                // Offscreen has no UI / settings DOM — currentProvider on its
                // side is empty until we tell it which provider to use. Send
                // the active provider on every run-agent so offscreen picks
                // the same model the user has selected.
                currentProvider: (typeof currentProvider !== 'undefined') ? currentProvider : ''
            });
        } catch (e) {
            // Port died between check and post — retry.
            setTimeout(attempt, 50);
        }
    };
    attempt();
    return p;
}

// Push a chat update to offscreen (used by panel-side mutations
// outside an agent run, e.g. title rename, manual message edit).
function pushChatUpdateToOffscreen(chatId) {
    if (!_agentBusPort || !chatId || !chats[chatId]) return;
    try {
        _agentBusPort.postMessage({
            type: 'update-chat',
            chatId: chatId,
            chat: chats[chatId]
        });
    } catch (e) {}
}

// Toggle pause from the page side (the existing togglePause UI calls
// into this and pushes the new state to offscreen).
function pushPauseToggleToOffscreen(chatId, paused) {
    if (!_agentBusPort || !chatId) return;
    try {
        _agentBusPort.postMessage({
            type: 'toggle-pause',
            chatId: chatId,
            paused: !!paused
        });
    } catch (e) {}
}

// Push the new hooksEnabled to the SW after the user toggles a hook in
// settings. Without this the SW keeps the boot-time hooksEnabled until the
// next SW restart, so toggleHook from the panel wouldn't take effect on
// the agent loop (which now runs in the SW).
function pushHooksSettingsToOffscreen(hooks) {
    if (!_agentBusPort || !hooks) return;
    try {
        _agentBusPort.postMessage({
            type: 'hooks-settings',
            hooksEnabled: hooks
        });
    } catch (e) {}
}

// Push permission state changes to the SW. The page-side `getToolPermission`
// reads three sources: `toolPermissions` (IDB-persisted, "always allow"),
// `instancePermissions` (IDB-persisted per-host), and `sessionPermissions`
// (in-memory only, "allow until close"). With the agent loop relocated to
// the SW, the SW has its OWN copies of these globals — `toolPermissions` /
// `instancePermissions` are hydrated from IDB at SW boot, but session-only
// changes and any post-boot mutation must be mirrored or the SW's
// `getToolPermission` will return 'ask' and the approval prompt fires on
// every tool call even after the user picked "Allow for session" or
// "Always allow". The mirror is best-effort; if the port is down the next
// reconnect's hello flow plus the SW's IDB load will catch up the
// persisted ones (session-only choices ARE lost across SW restart, same
// as a page reload).
function pushPermissionsToOffscreen(patch) {
    if (!_agentBusPort || !patch) return;
    try {
        _agentBusPort.postMessage({
            type: 'permissions-update',
            toolPermissions: patch.toolPermissions || null,
            instancePermissions: patch.instancePermissions || null,
            sessionPermissions: patch.sessionPermissions || null
        });
    } catch (e) {}
}

// Send an interrupt (user pressed send during a tool call).
function pushInterruptToOffscreen(chatId, fromUserMessage) {
    if (!_agentBusPort || !chatId) return;
    try {
        _agentBusPort.postMessage({
            type: 'interrupt',
            chatId: chatId,
            fromUserMessage: !!fromUserMessage
        });
    } catch (e) {}
}

// Open the port now. We don't wait for Platform.ready because the
// SW is independent of session token state.
_openAgentBus();

// AGENT_PORT_BRIDGE_PAGE_SENTINEL
