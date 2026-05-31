// =============================================================
// Page-side agent-event handlers. Loaded only in the page bundle.
//
// The bus (AgentEvents) is defined in app/035-agent-events.js and
// is shared between the page bundle and the worker bundle. This
// file mirrors the UI side effects the agent loop used to make
// inline (PR1 split).
//
// File-order rationale: lives in app/ so it loads AFTER ui/ tier
// (its handlers reference renderMessages, showSpinner, etc. which
// are declared in ui/) AND AFTER 035 in the same tier (the bus
// must exist before handlers register). The worker build script
// (build/build.js WORKER_SHARED_FILES) explicitly INCLUDES 035
// but EXCLUDES this 036 — so the offscreen bundle gets the bus
// without the page-only handlers.
//
// In the offscreen-host architecture (PR2):
//   • The agent loop runs in the offscreen document and emits to
//     its LOCAL AgentEvents bus.
//   • worker/100-agent-event-broadcast.js (offscreen-only) forwards
//     every emit over chrome.runtime ports to every panel.
//   • worker/110-agent-event-bridge.js (page-only — name kept in
//     worker/ for symmetry but excluded from the worker bundle by
//     the build's WORKER_SHARED_FILES list) receives those port
//     messages and RE-EMITS them on this file's AgentEvents bus,
//     so the handlers below fire exactly like they did when the
//     loop ran in the same page.
//
// Behavior here MUST stay identical to PR1 — this is the single
// source of truth for "what should the UI do when X event fires?".
//
// AGENT_EVENT_HANDLERS_SENTINEL — used by build-verify grep.
// =============================================================

// document.hidden / window-focus tracking for the "Agent finished"
// browser notification. Semantics: any chat that was running while
// the document went hidden gets a notification at run-finish;
// "away right now" (window blurred OR document hidden) also fires it.
//
// In the offscreen-host architecture, the offscreen doc is always
// "hidden" (no UI), so this tracking MUST run on the page side.
// The notification heuristic asks "was the USER away from this
// panel while the run was happening?", not "was the offscreen doc
// hidden?".

var _agentEventsHiddenDuringRun = {};
function _agentEventsMarkAllRunningHidden() {
    if (typeof runningChatIds !== 'object' || !runningChatIds) return;
    for (var cid in runningChatIds) {
        if (runningChatIds[cid]) _agentEventsHiddenDuringRun[cid] = true;
    }
}
if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) _agentEventsMarkAllRunningHidden();
    });
}
// Chrome side panels stay document-visible when the user switches
// windows, so also treat "window lost focus" as away.
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('blur', _agentEventsMarkAllRunningHidden);
}

// =============================================================
// Page-side handlers. Each handler MIRRORS the UI calls the loop
// used to make inline. Order of side effects within a handler
// matches the original code's order; read the matching block in
// 030-agent-loop.js for the source.
// =============================================================

// runStarted — initial hidden snapshot, chat-list refresh, foreground UI flags.
AgentEvents.on('runStarted', function(e) {
    var chatId = e.chatId;
    _agentEventsHiddenDuringRun[chatId] = !!document.hidden ||
        (typeof document.hasFocus === 'function' && !document.hasFocus());
    if (typeof renderChatList === 'function') renderChatList();
    if (typeof renderJobsBadge === 'function') renderJobsBadge();
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') { var _jdStart = _getOpenJobsDropdown(); if (_jdStart) renderJobsDropdown(_jdStart); }
    if (chatId === currentChatId) {
        isRunning = true;
        isFollowingStreamingScroll = true;
        lastApiError = null;
        hideRetryButton();
        hideContinueButton();
        showPauseButton();
        var messagesEl = document.getElementById('messages');
        if (messagesEl) messagesEl.classList.add('is-streaming');
        activeStreamingChatId = chatId;
    } else {
        lastApiError = null;
    }
});

AgentEvents.on('turnStarted', function(e) {
    showSpinner('Waiting for response...', e.chatId);
});

AgentEvents.on('assistantMessageStarted', function(e) {
    if (e.chatId === currentChatId) renderMessages();
    hideSpinner(e.chatId);
});

AgentEvents.on('streamDelta', function(e) {
    try {
        updateStreamingMessage(e.msgIndex, e.message, e.chatId);
    } catch (err) {
        var label;
        switch (e.kind) {
            case 'interval':   label = 'Stream interval update error:'; break;
            case 'thinking':   label = 'Thinking update error:'; break;
            case 'text':       label = 'Content update error:'; break;
            case 'tool_input': label = 'Tool calls update error:'; break;
            default:           label = 'Stream update error:';
        }
        console.error(label, err);
    }
});

AgentEvents.on('assistantMessage', function(e) {
    if (e.chatId === currentChatId) renderMessages();
    renderChatList();
    updateContextIndicator();
});

AgentEvents.on('toolCallStarted', function(e) {
    showSpinner('Executing ' + e.displayName + '...', e.chatId);
});

AgentEvents.on('toolCallResult', function(e) {
    hideSpinner(e.chatId);
    if (e.force || e.chatId === currentChatId) renderMessages();
});

AgentEvents.on('toolCallCancelled', function(e) {
    hideSpinner(e.chatId);
    if (e.chatId === currentChatId) renderMessages();
});

AgentEvents.on('userInjected', function(e) {
    // Offscreen just flushed pendingInjectionsByChatId[e.chatId] into chat.messages
    // and broadcast the snapshot. Drop our PAGE-side mirror entry too so
    // renderQueuedUserBubble stops re-painting the "Queued" badge on the real msg.
    // The bubble is still doing its optimistic-UI job for the brief window between
    // the user pressing Enter and offscreen broadcasting userInjected — we just
    // need to retire it once the real message lands.
    if (e.chatId && typeof pendingInjectionsByChatId !== 'undefined') {
        delete pendingInjectionsByChatId[e.chatId];
    }
    if (e.chatId === currentChatId) renderMessages();
});

AgentEvents.on('messagesAppended', function(e) {
    if (e.chatId === currentChatId) renderMessages();
});

AgentEvents.on('paused', function(e) {
    hideSpinner(e.chatId);
    // Foreground gating: only mutate the foreground-streaming flag and only
    // show the snackbar if the paused chat is the one the user is looking at.
    // Sub-agents finish their natural lifecycle by setting pausedChats[chat]=true
    // (sleep_self / stop_sub_agent / _parkSubAgent on report_to_parent),
    // which makes runAgent emit 'paused' for the SUB chat. Without this gate the
    // sub's quiet exit was repainting the foreground as "paused" and showing the
    // snackbar even though the user never pressed Pause.
    var fg = (typeof currentChatId !== 'undefined') ? currentChatId : null;
    if (e.chatId === fg) {
        isRunning = false;
        // Sub-agent natural-park suppression: when a user sits inside a
        // sub-agent's chat and the sub finishes its turn (report_to_parent
        // / sleep_self / cascade-stop), the registry sets pausedChats[sub]=
        // true so the loop yields. That fires 'paused' here with chatId =
        // the sub the user is viewing, which used to pop "Agent paused.
        // Click Resume to continue." The user did NOT pause the sub, the
        // sub parked itself — the snackbar is wrong. Skip it for any chat
        // flagged isSubAgent; the sub_report row in the parent already
        // tells the user what happened.
        var _subChat = (typeof chats !== 'undefined') ? chats[e.chatId] : null;
        var _isSubAgentChat = !!(_subChat && _subChat.isSubAgent);
        if (!_isSubAgentChat) {
            showSnackbar('Agent paused. Click Resume to continue.');
        }
        isFollowingScroll = true;
    }
});

AgentEvents.on('streamAborted', function(e) {
    hideSpinner(e.chatId);
});

AgentEvents.on('error', function(e) {
    var msg = (e.error && e.error.message) ? e.error.message : String(e.error || '');
    // Console-log the full error envelope so the SW-side stack is reachable
    // from the panel devtools too (structured clone preserves it).
    console.error('[agent-events] error event:', e);
    // Sub-agent / background chat errors are surfaced to the parent via the
    // sub_report row (synthesized in SubAgents.onSubAgentRunFinished when the
    // run ends with lastApiError set). They must NOT pop a foreground snackbar
    // or show the Retry button — the human isn't looking at the sub's chat and
    // the retry would target the wrong context. Only foreground errors get UI.
    var chat = (typeof chats !== 'undefined') ? chats[e.chatId] : null;
    var isBackground = !!(chat && (chat.isSubAgent || chat.isBackground));
    if (!isBackground) {
        showSnackbar('API Error: ' + msg, 'error');
        showRetryButton();
    }
    if (e.chatId === currentChatId) renderMessages();
});

AgentEvents.on('runFinished', function(e) {
    var chatId = e.chatId;
    hideSpinner(chatId);
    // Background Action chats: finalize the action button here — in the
    // pre-offscreen architecture the loop called finishActionIfDone inline
    // before emitting runFinished; in offscreen that call is a stub (the
    // actions engine lives in tools/120-actions.js, page-only), so the
    // panel has to do it on receipt of the event instead.
    var fchat = chats[chatId];
    if (fchat && fchat.isBackground && fchat.actionId && typeof finishActionIfDone === 'function') {
        try { finishActionIfDone(chatId); } catch (err) { console.error('finishActionIfDone failed', err); }
    }
    // Page-side foreground streaming singletons: main cleared these inline at the
    // loop's exit (030-agent-loop.js:738-740 on main). The loop now runs in SW,
    // so the panel has to clear them on runFinished/runCrashed instead.
    if (activeStreamingChatId === chatId) {
        isRunning = false;
        activeStreamingChatId = null;
    }
    // Keep a just-finished chat under "Active Chats" for a grace period instead
    // of dropping it the instant the run ends (the page bridge already deleted
    // runningChatIds[chatId] before this handler ran).
    if (typeof markChatRecentlyFinished === 'function') { try { markChatRecentlyFinished(chatId); } catch (e) {} }
    if (typeof renderChatList === 'function') renderChatList();
    if (typeof renderJobsBadge === 'function') renderJobsBadge();
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') { var _jdFin = _getOpenJobsDropdown(); if (_jdFin) renderJobsDropdown(_jdFin); }
    var messagesEl = document.getElementById('messages');
    if (messagesEl) messagesEl.classList.remove('is-streaming');
    if (chatId === currentChatId) renderMessages();
    updateContextIndicator();
    if (e.isPaused) {
        // Same gate as the 'paused' handler — sub-agent natural-finish flips
        // pausedChats for the sub's chat, which would otherwise leak a "paused"
        // snackbar into the foreground here too.
        var _fg = (typeof currentChatId !== 'undefined') ? currentChatId : null;
        if (chatId === _fg) {
            // Sub-agent natural-park suppression — see the matching block in
            // the 'paused' handler above for the full rationale. runFinished
            // with isPaused=true fires when a sub's loop exits via the
            // pausedChats gate (report_to_parent / sleep_self / stop / budget),
            // and if the user is viewing that sub's chat we used to flash
            // "Agent paused. Click Resume to continue." Same wrong message,
            // same fix — the sub parked itself, not the user. We also hide
            // the Pause/Resume button entirely on a parked sub chat: keeping
            // it visible as "Resume" tempts the user to click and re-enter
            // a loop they don't own (the parent does). The sub_report row
            // in the parent is the legitimate control surface.
            var _fchat = (typeof chats !== 'undefined') ? chats[chatId] : null;
            var _fIsSub = !!(_fchat && _fchat.isSubAgent);
            if (_fIsSub) {
                hidePauseButton();
            } else {
                if (typeof syncPauseButtonUI === 'function') syncPauseButtonUI(chatId);
                showSnackbar('Agent paused. Click Resume to continue.');
            }
        }
    } else {
        // Foreground gating: a background sub-agent / Action chat finishing
        // must NOT hide the foreground's pause button or reset its scroll
        // follow flag — the parent might still be streaming. Without this
        // gate, every background sub finishing wiped the pause button out
        // from under the user.
        var _fgElse = (typeof currentChatId !== 'undefined') ? currentChatId : null;
        if (chatId === _fgElse) {
            hidePauseButton();
            refreshContinueButtonForChat(chatId);
            isFollowingScroll = true;
        }
    }
});

AgentEvents.on('runCrashed', function(e) {
    if (e && e.chatId && activeStreamingChatId === e.chatId) {
        isRunning = false;
        activeStreamingChatId = null;
    }
    // Sub-agent crash recovery: if the loop threw uncaught, the normal finish
    // path never called SubAgents.onSubAgentRunFinished and the parent's spawn
    // handle would hang forever. Drive the same hook here so the parent's
    // await_handle unblocks with a synthesized error report. SubAgents is
    // resilient to being called on an already-settled sub (it checks the
    // deferred and returns), so this is safe even if the run crashed AFTER
    // emitting a terminal report.
    if (e && e.chatId && typeof chats !== 'undefined' && chats[e.chatId] && chats[e.chatId].isSubAgent
        && typeof SubAgents !== 'undefined' && SubAgents.onSubAgentRunFinished) {
        try {
            SubAgents.onSubAgentRunFinished(e.chatId, {
                reason: 'errored',
                error: { message: 'sub-agent loop crashed (uncaught throw, no terminal report)' }
            });
        } catch (err) { console.warn('runCrashed: onSubAgentRunFinished hook threw', err); }
    }
    if (e && e.chatId && typeof markChatRecentlyFinished === 'function') { try { markChatRecentlyFinished(e.chatId); } catch (err) {} }
    if (typeof renderChatList === 'function') renderChatList();
    if (typeof renderJobsBadge === 'function') renderJobsBadge();
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') { var _jdCr = _getOpenJobsDropdown(); if (_jdCr) renderJobsDropdown(_jdCr); }
});

AgentEvents.on('notifyFinish', function(e) {
    var chatId = e.chatId;
    var wasHidden = !!_agentEventsHiddenDuringRun[chatId];
    delete _agentEventsHiddenDuringRun[chatId];
    var awayNow = document.hidden ||
        (typeof document.hasFocus === 'function' && !document.hasFocus());
    // Sub-agent chats are invisible to the user — they finish constantly as
    // part of the parent's work. Pushing a browser notification for every
    // sub natural-finish would spam the user with "Agent finished" toasts
    // bearing meaningless "sub_xxxxxx" names. The parent's runFinished is
    // the right surface for the actual PM-visible work.
    var nc = chats[chatId];
    if (nc && nc.isSubAgent) return;
    if (!e.isPaused && !e.wasSilentHook && (awayNow || wasHidden)) {
        var title = nc && nc.title ? nc.title : 'Chat';
        Platform.sendNotification({
            title: e.hasError ? 'Agent stopped — error' : 'Agent finished',
            message: title,
            chatId: chatId
        });
    }
});

// =============================================================
// Layer C — parked UI-tool indicator.
//
// When the offscreen runtime needs to run a UI-required tool but
// no panel is connected, the call is "parked". A placeholder
// message is added to the chat so the user sees what's happening.
// When the user opens a panel, offscreen replays parked calls to it.
//
// FLICKER FIX: an MV3 service-worker eviction-then-restart cycle
// briefly disconnects the agent-bus port (~250ms while _openAgentBus
// re-runs). If the SW resumes the agent loop and dispatches a UI
// tool inside that gap, it parks (no panel attached yet), then
// unparks the moment the panel-hello arrives and replayParkedToolCalls
// runs. From the user's perspective the worker is "working fine" —
// but they used to see a "📌 Tool waiting for a panel…" row flash for
// the duration of the gap. Defer the visible push by 750ms; if the
// unpark arrives first (the common case during a healthy SW restart),
// we never push at all and the user sees nothing. Only a genuinely
// panel-less park (the panel was actually closed) ever surfaces.
// =============================================================

var PARKED_TOOL_VISIBLE_DELAY_MS = 750;
// toolCallId -> timeout handle for the deferred "show parked" push.
var _pendingParkedToolTimers = {};

function _showParkedToolMessage(chatId, toolCallId, name) {
    var chat = chats[chatId];
    if (!chat || !chat.messages) return;
    // Guard against the unpark already having fired (race between the
    // timer firing and a synchronous unpark emit). If the parked entry
    // is no longer in flight, skip the push.
    if (!_pendingParkedToolTimers[toolCallId]) return;
    delete _pendingParkedToolTimers[toolCallId];
    chat.messages.push({
        role: 'parked_tool',
        toolCallId: toolCallId,
        name: name,
        content: '📌 Tool waiting for a panel — auto-resumes when you open one.',
        timestamp: Date.now()
    });
    if (chatId === currentChatId) renderMessages();
}

AgentEvents.on('toolParked', function(e) {
    var chat = chats[e.chatId];
    if (!chat || !chat.messages) return;
    // Schedule, don't push immediately. The toolUnparked handler clears
    // the timer if the replay arrives within the grace window.
    if (_pendingParkedToolTimers[e.toolCallId]) {
        clearTimeout(_pendingParkedToolTimers[e.toolCallId]);
    }
    _pendingParkedToolTimers[e.toolCallId] = setTimeout(function() {
        _showParkedToolMessage(e.chatId, e.toolCallId, e.name);
    }, PARKED_TOOL_VISIBLE_DELAY_MS);
});

AgentEvents.on('toolUnparked', function(e) {
    // Cancel any pending "show parked" timer first — if we got here within
    // the grace window, the user never sees the flicker (nothing was ever
    // pushed) and we skip the render entirely.
    var hadPendingTimer = !!_pendingParkedToolTimers[e.toolCallId];
    if (hadPendingTimer) {
        clearTimeout(_pendingParkedToolTimers[e.toolCallId]);
        delete _pendingParkedToolTimers[e.toolCallId];
    }
    var chat = chats[e.chatId];
    if (!chat || !chat.messages) return;
    var removed = false;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m.role === 'parked_tool' && m.toolCallId === e.toolCallId) {
            chat.messages.splice(i, 1);
            removed = true;
            break;
        }
    }
    // Skip the render if nothing visible changed — unpark that catches a
    // still-pending grace-window timer touches no DOM, so an extra render
    // pass would just churn the UI for nothing.
    if (removed && e.chatId === currentChatId) renderMessages();
});

// =============================================================
// State-mutation events emitted by tools. Each handler re-runs the
// UI side effect the tool used to perform inline.
// =============================================================

// documentChanged: smart-documents tool created/updated/edited/deleted a doc.
// The tool runs headless in the SW, which means the page's in-memory
// smartDocuments cache is stale until we re-read from IDB. Without this
// hydration step, sdocReRenderAll has nothing to render and inline
// placeholders show "Document not found".
AgentEvents.on('documentChanged', function(e) {
    function finish() {
        if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
        if (e.docId && typeof sdocReRenderAll === 'function') sdocReRenderAll(e.docId);
        if (typeof renderDocumentsPage === 'function' && currentView === 'documents') {
            renderDocumentsPage();
        }
    }
    if (!e.docId) { finish(); return; }
    if (e.kind === 'deleted') {
        if (typeof smartDocuments !== 'undefined') delete smartDocuments[e.docId];
        finish();
        return;
    }
    if (typeof loadDocumentById === 'function') {
        loadDocumentById(e.docId).then(finish, finish);
    } else {
        finish();
    }
});

// workspaceMutated: workspace tool finished a mutating action (write/edit/
// copy/delete/push/clone). The header badge reads from local IDB state, so
// the panel just refreshes it.
AgentEvents.on('workspaceMutated', function(e) {
    if (typeof updateWorkspaceHeaderStatus === 'function') updateWorkspaceHeaderStatus();
});

// actionStateChanged: foreground update_action_state call needs the version
// sidebar to refresh (it surfaces in-flight action progress alongside
// recordMutated entries). The action button itself is driven by
// notifyActionStateChanged listeners in tools/120-actions.js — independent.
AgentEvents.on('actionStateChanged', function(e) {
    if (typeof renderVersionSidebar === 'function') {
        try { renderVersionSidebar(); } catch (err) {}
    }
});

// recordMutated: servicenow_api or servicenow_diff_edit modified a record.
// The event carries everything the version-history entry needs; the panel
// owns the versionHistory array + sidebar + inline-changes rendering.
// Route to the chat that owns the mutation (may not be the active chat
// when a background chat ran the tool).
AgentEvents.on('recordMutated', function(e) {
    if (typeof addVersionHistoryEntryForChat !== 'function') return;
    addVersionHistoryEntryForChat(e.chatId, {
        id: 'vh_' + Date.now(),
        chatId: e.chatId,
        timestamp: Date.now(),
        table: e.table,
        sysId: e.sysId,
        field: e.field || undefined,
        displayName: e.displayName,
        action: e.action,
        statusMessage: e.statusMessage || null,
        messageIndex: typeof e.messageIndex === 'number' ? e.messageIndex : -1,
        beforeVersion: e.beforeVersion || null,
        afterVersion: e.afterVersion || null
    });
});
