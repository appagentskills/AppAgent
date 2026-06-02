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
        // RETRY-F2: an SW eviction disconnects the bus WITHOUT emitting a terminal
        // runFinished/runCrashed for in-flight chats, so the page-side runningChatIds
        // (and their _pendingRunAgents promises) are left stuck "running". The runAgent
        // guard @:378 then treats Retry/Continue/Send as a no-op ("already running") and
        // silently drops the user's action. Any chat still in runningChatIds here had NO
        // terminal event by construction (runFinished/runCrashed delete it @:178), so
        // clear it and settle its pending promise; the SW's 'hello' on reconnect
        // re-populates runningChatIds for runs it actually resumed (@:206-209), and the
        // SW-side run-agent handler is idempotent (guards on its own runningChatIds @:222)
        // so a Retry that re-posts during the gap can't double-run a still-live SW loop.
        try {
            Object.keys(runningChatIds).forEach(function(cid) { delete runningChatIds[cid]; });
            Object.keys(_pendingRunAgents).forEach(function(cid) {
                var pr = _pendingRunAgents[cid];
                delete _pendingRunAgents[cid];
                if (pr && pr.resolve) { try { pr.resolve(); } catch (e) {} }
            });
        } catch (e) {}
        // SW restart — re-open. Slight delay to avoid tight loops.
        setTimeout(_openAgentBus, 250);
    });
    // Declare any tools the panel is still executing so a fresh SW
    // adopts them instead of re-dispatching. Must run synchronously
    // after connect — the SW resume gate waits ~1.5s for this.
    _sendPanelHello();
    // SWM2-F1(B): re-post the focused chat on every bus (re)connect. After an SW
    // restart the SW's _focusedChatId / _focusedChatByPort reset (in-memory only), so
    // without this the sub-agent GC has no focus signal until the user next switches
    // chats — and a sweep firing in that window could reclaim the very transcript the
    // user is viewing. (SWM2-F1 part A defers GC when focus is unknown; this
    // re-establishes it promptly.) Mirrors the permissions + hello re-push below.
    if (typeof pushFocusChatToOffscreen === 'function') {
        // SWM2-T1: derive focus from currentView (F3's source of truth) not currentChatId —
        // view-leave sets currentView but never clears currentChatId, so keying off currentChatId
        // re-pins a stale last-viewed chat after an SW restart, protecting it from GC. Always post
        // (incl. null) so focus is treated as reported (pairs with SWM2-T2).
        var _focusNow = (typeof currentView !== 'undefined' && currentView === 'chat'
            && typeof currentChatId !== 'undefined' && currentChatId) ? currentChatId : null;
        pushFocusChatToOffscreen(_focusNow);
    }
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
                // Reopening the panel while a background chat runs must also
                // surface it in the jobs badge/dropdown. renderChatList alone
                // refreshes the sidebar but not the badge (whose Active Chats
                // group reads getActiveChatsList()).
                if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
                // ...and re-render an already-open jobs dropdown so a newly
                // discovered background run shows without needing a reopen.
                if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') {
                    try { var _jdHello = _getOpenJobsDropdown(); if (_jdHello) renderJobsDropdown(_jdHello); } catch (e) {}
                }
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
// SWM14-F5: per-chat latest-wins tokens for pause toggles. A rapid Pause→Resume
// during a port-down window spawns two independent retry chains (paused=true then
// paused=false); without these they can post out of order and leave the SW in the
// WRONG final pause state. Each fresh (non-retry) call bumps the chat's generation
// and records the latest desired value; a retry carries its generation and no-ops if
// a newer toggle superseded it, and always posts the CURRENT latest desired value.
var _pauseToggleGen = Object.create(null);
var _pauseToggleDesired = Object.create(null);

function pushPauseToggleToOffscreen(chatId, paused, _retries, _gen) {
    if (!chatId) return;
    // SWM14-F5: allocate/refresh the generation on a fresh call; drop a superseded
    // stale chain; always act on the CURRENT latest desired value for this chat.
    if (_gen === undefined) {
        _gen = (_pauseToggleGen[chatId] || 0) + 1;
        _pauseToggleGen[chatId] = _gen;
        _pauseToggleDesired[chatId] = !!paused;
    } else if (_gen !== _pauseToggleGen[chatId]) {
        return; // a newer Pause/Resume for this chat superseded this chain — drop it
    }
    var _desired = _pauseToggleDesired[chatId];
    // Don't silently drop the toggle during the ~250ms+ window while
    // _openAgentBus re-connects after a SW eviction — a dropped pause means the
    // SW never aborts and the run keeps going. Retry briefly (mirrors runAgent's
    // attempt() loop) so the pause reliably reaches the SW.
    if (!_agentBusPort) {
        // SWM4F-1: don't give up after the bounded ~1s retry. On a slow SW
        // reconnect a bare return left the UI showing "paused" while the SW
        // kept streaming. On exhaustion force-reopen the bus and keep trying
        // with a reset counter so the toggle eventually lands.
        if ((_retries || 0) < 20) { setTimeout(function() { pushPauseToggleToOffscreen(chatId, _desired, (_retries || 0) + 1, _gen); }, 50); }
        else { try { _openAgentBus(); } catch (e) {} setTimeout(function() { pushPauseToggleToOffscreen(chatId, _desired, 0, _gen); }, 250); }
        return;
    }
    try {
        _agentBusPort.postMessage({
            type: 'toggle-pause',
            chatId: chatId,
            paused: !!_desired
        });
    } catch (e) {
        // SWM4F-1: same exhaustion fallback as the no-port guard above.
        if ((_retries || 0) < 20) { setTimeout(function() { pushPauseToggleToOffscreen(chatId, _desired, (_retries || 0) + 1, _gen); }, 50); }
        else { try { _openAgentBus(); } catch (e2) {} setTimeout(function() { pushPauseToggleToOffscreen(chatId, _desired, 0, _gen); }, 250); }
    }
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

// SAGF-1: tell the SW which chat the user is now viewing so the sub-agent GC
// paths (_idleSweepTick / loadAllSubAgents) don't reclaim a transcript the user
// is actively reading. Best-effort — the GC TTLs are minutes-to-hours so a
// transient miss during a bus reconnect can't realistically race a sweep, and
// the next selectChat / openChatFromHistory re-posts the focus anyway.
function pushFocusChatToOffscreen(chatId) {
    if (!_agentBusPort) return;
    try {
        _agentBusPort.postMessage({ type: 'focus-chat', chatId: chatId || null });
    } catch (e) {}
}

// Send an interrupt (user pressed send during a tool call).
// SWM14-F5: per-chat latest-wins tokens for the interrupt push — same rationale as
// the pause toggle above: rapid interrupts during a port-down window must not post
// out of order. Generation supersedes a stale retry chain; the desired
// fromUserMessage is always read fresh. (All current callers pass false, so this is
// belt-and-suspenders, but it keeps the two retry primitives symmetric.)
var _interruptGen = Object.create(null);
var _interruptDesired = Object.create(null);

function pushInterruptToOffscreen(chatId, fromUserMessage, _retries, _gen) {
    if (!chatId) return;
    if (_gen === undefined) {
        _gen = (_interruptGen[chatId] || 0) + 1;
        _interruptGen[chatId] = _gen;
        _interruptDesired[chatId] = !!fromUserMessage;
    } else if (_gen !== _interruptGen[chatId]) {
        return; // a newer interrupt for this chat superseded this chain — drop it
    }
    var _fum = _interruptDesired[chatId];
    // Don't silently drop the interrupt during the ~250ms+ window while
    // _openAgentBus re-connects after a SW eviction — a dropped interrupt means
    // the SW never aborts the in-flight tool/stream. Retry briefly (mirrors
    // runAgent's attempt() loop) so the interrupt reliably reaches the SW.
    if (!_agentBusPort) {
        // SWM4F-1: don't give up after the bounded ~1s retry. On a slow SW
        // reconnect a bare return left the UI showing the run as interrupted
        // while the SW kept streaming. On exhaustion force-reopen the bus and
        // keep trying with a reset counter so the interrupt eventually lands.
        if ((_retries || 0) < 20) { setTimeout(function() { pushInterruptToOffscreen(chatId, _fum, (_retries || 0) + 1, _gen); }, 50); }
        else { try { _openAgentBus(); } catch (e) {} setTimeout(function() { pushInterruptToOffscreen(chatId, _fum, 0, _gen); }, 250); }
        return;
    }
    try {
        _agentBusPort.postMessage({
            type: 'interrupt',
            chatId: chatId,
            fromUserMessage: !!_fum
        });
    } catch (e) {
        // SWM4F-1: same exhaustion fallback as the no-port guard above.
        if ((_retries || 0) < 20) { setTimeout(function() { pushInterruptToOffscreen(chatId, _fum, (_retries || 0) + 1, _gen); }, 50); }
        else { try { _openAgentBus(); } catch (e2) {} setTimeout(function() { pushInterruptToOffscreen(chatId, _fum, 0, _gen); }, 250); }
    }
}

// SWM14-T3: symmetric no-post supersede for the interrupt retry primitive. A stale
// interrupt(false) retry chain armed during a prior port-down window can survive a fresh
// send and, on reconnect, abort the new stream + delete the just-queued pendingInjection.
// Bumping the generation (without posting) invalidates any in-flight retry chain carrying
// an older _gen (it no-ops at the `_gen !== _interruptGen[chatId]` guard), mirroring the
// pause supersede done at the send sites (SWM14-T1).
function _supersedeInterruptToggle(chatId) {
    if (!chatId) return;
    _interruptGen[chatId] = (_interruptGen[chatId] || 0) + 1;
    _interruptDesired[chatId] = false;
}

// Open the port now. We don't wait for Platform.ready because the
// SW is independent of session token state.
_openAgentBus();

// AGENT_PORT_BRIDGE_PAGE_SENTINEL
