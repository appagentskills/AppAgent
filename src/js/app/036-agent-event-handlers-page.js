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

// UNREAD-MISS counterpart: returning to a visible+focused panel while the chat
// view is on screen counts as SEEING the focused chat — stamp lastViewedAt so
// activity that landed while the user was away (marked unread now that
// _isChatViewFocused checks document.hidden/hasFocus) is consumed the moment
// they actually look at it, instead of leaving the jobs row bold forever.
function _consumeFocusedChatUnread() {
    try {
        if (document.hidden) return;
        if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
        if (typeof currentView !== 'undefined' && currentView !== 'chat') return;
        if (typeof currentChatId === 'undefined' || !currentChatId) return;
        var c = (typeof chats !== 'undefined') ? chats[currentChatId] : null;
        if (!c) return;
        var last = Math.max(c.lastResponseAt || 0, c.lastActivityAt || 0);
        if (!last || last <= (c.lastViewedAt || 0)) return; // nothing unread
        c.lastViewedAt = Date.now();
        if (typeof clearUnseenFinishedChat === 'function') { try { clearUnseenFinishedChat(currentChatId); } catch (e) {} }
        if (typeof saveChatsToStorage === 'function') { try { saveChatsToStorage(); } catch (e) {} }
        if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
        if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') {
            var _jd = _getOpenJobsDropdown();
            if (_jd) renderJobsDropdown(_jd);
        }
    } catch (e) {}
}
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', _consumeFocusedChatUnread);
}
if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) _consumeFocusedChatUnread();
    });
}

// =============================================================
// Page-side handlers. Each handler MIRRORS the UI calls the loop
// used to make inline. Order of side effects within a handler
// matches the original code's order; read the matching block in
// 030-agent-loop.js for the source.
// =============================================================

// Unread-email semantics for the jobs lists: ANY user-visible action landing
// on a chat the user is not viewing (assistant message, tool call, error,
// parked approval, injected message, run start/crash) marks it unread — bold
// title until the user opens it. Thin guard wrapper around markChatActivity
// (tools/120-actions.js), safe to call from every handler.
function _stampChatActivity(chatId) {
    if (!chatId) return;
    if (typeof markChatActivity === 'function') { try { markChatActivity(chatId); } catch (e) {} }
}

// runStarted — initial hidden snapshot, chat-list refresh, foreground UI flags.
AgentEvents.on('runStarted', function(e) {
    var chatId = e.chatId;
    _stampChatActivity(chatId);
    _agentEventsHiddenDuringRun[chatId] = !!document.hidden ||
        (typeof document.hasFocus === 'function' && !document.hasFocus());
    if (typeof renderChatList === 'function') renderChatList();
    if (typeof renderJobsBadge === 'function') renderJobsBadge();
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') { var _jdStart = _getOpenJobsDropdown(); if (_jdStart) renderJobsDropdown(_jdStart); }
    if (chatId === currentChatId) {
        isRunning = true;
        lastApiError = null;
        hideRetryButton();
        hideContinueButton();
        // Silent-hook runs (auto title/tldr/links) are invisible work: the
        // user-facing answer already landed, so don't re-show the Pause
        // button or re-add .is-streaming for them — the chat would look
        // "running" for a couple of seconds after it visibly finished.
        // silentHookState{active:true} is emitted BEFORE the hook's
        // runAgent (worker/020-page-stubs.js), so the per-chat map is
        // already set when this runStarted arrives (port preserves order).
        var _rsHook = (typeof _isChatInSilentHook === 'function') && _isChatInSilentHook(chatId);
        if (!_rsHook) {
            showPauseButton();
            var messagesEl = document.getElementById('messages');
            if (messagesEl) messagesEl.classList.add('is-streaming');
        }
        activeStreamingChatId = chatId;
        var _rsFocused = (typeof chats !== 'undefined') ? chats[chatId] : null;
        if (_rsFocused) _rsFocused._lastApiError = null; // focused chat starting fresh
    } else {
        // R-1 (B11): an UNFOCUSED chat starting a run must NOT mutate the GLOBAL
        // lastApiError (it belongs to the focused chat — the toolbar Retry reads it).
        // A sub-agent/background chat starting previously nulled the global and left
        // the focused chat's Retry button visible-but-dead. Clear only THIS chat's
        // own persisted error as it starts fresh.
        var _rsChat = (typeof chats !== 'undefined') ? chats[chatId] : null;
        if (_rsChat) _rsChat._lastApiError = null;
    }
});

AgentEvents.on('turnStarted', function(e) {
    showSpinner('Waiting for response...', e.chatId);
});

AgentEvents.on('assistantMessageStarted', function(e) {
    // Stream is producing output again — drop any lingering inline
    // transport-backoff status ("Rate-limited — retrying now…").
    if (e && e.chatId) _clearTransportInlineStatus(e.chatId);
    if (e.chatId === currentChatId) renderMessages();
    hideSpinner(e.chatId);
});

AgentEvents.on('streamDelta', function(e) {
    try {
        // Real stream progress — clear the inline transport-backoff status.
        if (e && e.chatId) _clearTransportInlineStatus(e.chatId);
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

// FLUSH-TAIL: streamed assistant text is painted into #streaming-text at a
// PACED reveal rate — getDisplayContent (core/040-hooks-history.js) exposes
// only ~40-120 chars per updateStreamingText call, and those calls only
// happen while streamDelta events keep arriving. When the model finishes the
// text and the turn moves into tool execution, the deltas stop, the reveal
// freezes mid-message, and renderMessages deliberately skips the last
// block's content while isRunning (ui/250-message-render.js — "content for
// the current block goes to #streaming-text"). SYMPTOM: only part of the
// final answer was visible for the whole duration of a long-blocking tool
// call (e.g. await_handle); the full text only appeared at run end /
// interrupt, when isRunning flipped false and the full render finally
// included msg.content. Repaint the streaming container ONCE with the final
// content as soon as the message finalizes (and again, defensively, when a
// tool call starts): the message has isStreaming=false by then, so
// getDisplayContent returns the FULL text and drops its pacing buffer.
// Mid-stream throttling is untouched — this only guarantees the final flush.
function _flushFinalizedStreamingText(chatId) {
    if (chatId !== currentChatId) return;
    if (typeof updateStreamingText !== 'function') return;
    // Only repaint an EXISTING streaming container — renderMessages owns the
    // container lifecycle; never create one from here.
    if (!document.getElementById('streaming-text')) return;
    var chat = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!chat || !chat.messages) return;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (!m) continue;
        // SC-2: stop at the turn boundary — updateStreamingText only paints
        // entries AFTER the last user message, so anything before it is
        // already rendered as a normal (non-streaming) message.
        if (m.role === 'user') return;
        if (m.role !== 'assistant') continue;
        // Mid-stream tail: the streamDelta path (and REG-F4 on full renders)
        // owns the paced reveal — every delta repaints the whole turn's
        // entries, so nothing to flush here.
        if (m.isStreaming === true) return;
        if (m.content) {
            updateStreamingText(m, i, chatId);
            // SF-3: the full-text repaint can grow the streaming el (and the
            // outer scrollHeight) AFTER renderMessages' scroll restore ran
            // (the 'assistantMessage' handler renders first, then flushes) —
            // route through the SF-2 choke point so a following user is
            // re-pinned instead of stranded off-bottom until the next event.
            if (typeof scrollToBottomIfAllowed === 'function') scrollToBottomIfAllowed();
            return;
        }
        // SC-2: finalized TOOL-ONLY assistant row (tool_calls, no text) — the
        // common shape while a tool executes. The turn's streamed text lives
        // on an EARLIER assistant message; the old `return` here left the
        // freshly-created (empty) #streaming-text blank after a chat switch,
        // hiding the between-tool-call text for the rest of the run. Keep
        // walking back within the turn.
    }
}

AgentEvents.on('assistantMessage', function(e) {
    _stampChatActivity(e.chatId);
    if (e.chatId === currentChatId) renderMessages();
    // FLUSH-TAIL: after the render (the full-rebuild path may recreate an
    // EMPTY #streaming-text whose REG-F4 repopulation skips finalized tails).
    _flushFinalizedStreamingText(e.chatId);
    renderChatList();
    updateContextIndicator();
});

AgentEvents.on('toolCallStarted', function(e) {
    // FLUSH-TAIL: belt-and-braces for resume paths that start tools without a
    // fresh assistantMessage event in this panel's lifetime (SW restart /
    // pending-tool resume in 030-agent-loop.js).
    _flushFinalizedStreamingText(e.chatId);
    showSpinner('Executing ' + e.displayName + '...', e.chatId);
});

AgentEvents.on('toolCallResult', function(e) {
    _stampChatActivity(e.chatId);
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
    // renderQueuedUserBubble stops re-painting the optimistic bubble over the real msg.
    // The bubble is still doing its optimistic-UI job for the brief window between
    // the user pressing Enter and offscreen broadcasting userInjected — we just
    // need to retire it once the real message lands.
    if (e.chatId && typeof pendingInjectionsByChatId !== 'undefined') {
        delete pendingInjectionsByChatId[e.chatId];
    }
    _stampChatActivity(e.chatId);
    if (e.chatId === currentChatId) renderMessages();
    // INT-B1: the render above PRESERVES #streaming-text (same chat, still
    // running), so entries painted for the pre-interrupt turn are still inside
    // it — now sitting BELOW the freshly-injected user message. Prune them
    // immediately instead of waiting for the next turn's first streamDelta to
    // reach updateStreamingText's own prune. Same turn boundary as the paint
    // loop (data-msg-idx must be > last user row index).
    if (e.chatId === currentChatId) {
        var _uiEl = document.getElementById('streaming-text');
        var _uiChat = (typeof chats !== 'undefined') ? chats[e.chatId] : null;
        if (_uiEl && _uiChat && _uiChat.messages) {
            var _uiLastUser = -1;
            for (var _ui = _uiChat.messages.length - 1; _ui >= 0; _ui--) {
                if (_uiChat.messages[_ui].role === 'user') { _uiLastUser = _ui; break; }
            }
            var _uiStale = _uiEl.querySelectorAll('.streaming-entry');
            for (var _uk = 0; _uk < _uiStale.length; _uk++) {
                var _uidx = parseInt(_uiStale[_uk].getAttribute('data-msg-idx'), 10);
                if (!(_uidx > _uiLastUser)) _uiStale[_uk].remove();
            }
        }
    }
});

AgentEvents.on('messagesAppended', function(e) {
    _stampChatActivity(e.chatId);
    // Honor e.force like the toolCallResult handler above — _repaintParent
    // (097-sub-agent-registry.js) emits force:true so the page repaints even
    // when the event originated for another chat id; renderMessages always
    // renders the CURRENT chat, so a forced call is safe regardless of which
    // chat the event names.
    if (e.force || e.chatId === currentChatId) renderMessages();
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
        // (Scroll-follow intent is tracked continuously by handleChatScroll —
        // see 050-streaming.js — nothing to derive here.)
    }
});

AgentEvents.on('streamAborted', function(e) {
    if (e && e.chatId) _clearTransportInlineStatus(e.chatId);
    hideSpinner(e.chatId);
    // INT-B5: drop the paced-reveal buffer entries for this chat. After a
    // user abort the partial assistant message may be popped from the
    // transcript (worker loop), so getDisplayContent is never re-called for
    // its index and the streamingDisplayLen key leaks — and if a LATER
    // assistant message lands on the same index, its reveal inherits the
    // stale offset and skips the pacing animation for the prefix. No live
    // stream exists for this chat at abort time, so mid-stream throttling
    // (FLUSH-TAIL contract) is unaffected.
    if (e && e.chatId && typeof streamingDisplayLen !== 'undefined') {
        for (var _sk in streamingDisplayLen) {
            if (_sk.indexOf(e.chatId + ':') === 0) delete streamingDisplayLen[_sk];
        }
    }
});

// Transport-level rate-limit status from the SW streamer (429/529 backoff,
// concurrents slot park — see runClaudeOAuthStream in background.js). Without
// this the user sees a silent spinner for up to ~30s while the transport
// waits. Transient by design: shown as a warning snackbar (shared element, so
// repeated updates replace in place) and auto-hidden shortly after the wait
// window ends — but ONLY if our snackbar is still the one showing (tracked
// via a data-transport-token attribute on the message element, since a timed
// countdown mutates textContent), so a newer snackbar is never clobbered.
// Timed 429/529 backoffs ("retrying in Ns") get a live per-second countdown;
// concurrents parks are event-driven (cleared when a sibling stream ends),
// so they show a static message instead — "waiting for another agent" when a
// local sibling stream holds the slot, "AI endpoint saturated" when none does.
var _transportSnackbarSeq = 0;
var _transportCountdownTimers = {}; // per-chat countdown intervals (one global timer let a second chat's backoff kill the first chat's ticker)

// INLINE transport status (stuck-"Thinking…" fix): the snackbar above is
// transient and easy to miss — during a long 429/529 backoff (or a doomed
// credit-exhausted retry loop) the chat itself showed only a bare "Thinking…"
// bar with no hint of what was happening. Mirror the live transport message
// into the running block's status row: the compact-mode summary line
// (.compact-tools-status) and the classic loading spinner text. Keyed by
// chatId (the SW emit now includes it); entries self-expire via holdUntil and
// are cleared eagerly on stream progress so the status reverts the moment
// the transport recovers. 250-message-render.js consults _transportStatusText
// when computing the status line so re-renders during backoff keep the
// message instead of resetting it to "Thinking…".
var _transportInlineStatus = {};
function _transportStatusText(chatId) {
    var ent = chatId && _transportInlineStatus[chatId];
    if (!ent) return null;
    if (Date.now() > ent.holdUntil) { delete _transportInlineStatus[chatId]; return null; }
    return ent.text;
}
function _clearTransportInlineStatus(chatId) {
    if (chatId && _transportInlineStatus[chatId]) delete _transportInlineStatus[chatId];
}
function _paintTransportInlineStatus(chatId) {
    if (chatId && chatId !== currentChatId) return;
    var text = _transportStatusText(chatId);
    if (!text) return;
    try {
        // Compact mode: the streaming block's summary status line.
        var el = document.querySelector('.compact-tools-area.streaming .compact-tools-status');
        if (el) el.textContent = text;
        // Non-compact mode: the "Thinking…" loading spinner.
        var sp = document.querySelector('#loading-spinner .spinner-text');
        if (sp) sp.textContent = text;
    } catch (err) {}
}

AgentEvents.on('llmTransportStatus', function(e) {
    if (!e || !e.message) return;
    try {
        var token = String(++_transportSnackbarSeq);
        var _tChat = e.chatId || currentChatId;
        // Clear only THIS chat's ticker — a concurrent backoff in another
        // chat keeps its own countdown alive.
        if (_tChat && _transportCountdownTimers[_tChat]) { clearInterval(_transportCountdownTimers[_tChat]); delete _transportCountdownTimers[_tChat]; }
        // Inline mirror of the snackbar text. holdMs keeps the entry alive a
        // little past the wait window so "retrying now…" stays visible until
        // real stream progress clears it (or it self-expires).
        var setInline = function(text, holdMs) {
            if (!_tChat) return;
            _transportInlineStatus[_tChat] = { text: text, holdUntil: Date.now() + (holdMs || 20000) };
            _paintTransportInlineStatus(_tChat);
        };
        var show = function(text) {
            showSnackbar(text, 'warning');
            var sb = document.getElementById('snackbar');
            var msgEl = sb && sb.querySelector('.snackbar-message');
            if (msgEl) msgEl.setAttribute('data-transport-token', token);
        };
        // Returns our message element while our snackbar is still the one
        // showing (not dismissed, not replaced by a newer snackbar), else null.
        var ours = function() {
            var sb = document.getElementById('snackbar');
            var msgEl = sb && sb.querySelector('.snackbar-message');
            return (msgEl && sb.classList.contains('show') && msgEl.getAttribute('data-transport-token') === token) ? msgEl : null;
        };
        var canCount = e.waitMs && e.reason !== 'concurrents' && /in \d+s/.test(e.message);
        if (canCount) {
            var until = Date.now() + e.waitMs;
            var withRemaining = function() {
                var remain = Math.max(0, Math.ceil((until - Date.now()) / 1000));
                return e.message.replace(/in \d+s/, 'in ' + remain + 's');
            };
            show(withRemaining());
            setInline(withRemaining(), e.waitMs + 15000);
            // The countdown keeps ticking for the INLINE status even when the
            // snackbar has been dismissed/replaced (previously it stopped with
            // the snackbar, which would freeze the inline text mid-count).
            var _tTimer = setInterval(function() {
                if (Date.now() >= until) {
                    clearInterval(_tTimer);
                    if (_tChat && _transportCountdownTimers[_tChat] === _tTimer) delete _transportCountdownTimers[_tChat];
                    var doneText = e.message.replace(/retrying in \d+s/, 'retrying now');
                    var msgEl = ours();
                    if (msgEl) msgEl.textContent = doneText;
                    setInline(doneText, 15000);
                    return;
                }
                var t = withRemaining();
                var msgEl2 = ours();
                if (msgEl2) msgEl2.textContent = t;
                setInline(t, e.waitMs + 15000);
            }, 1000);
            if (_tChat) _transportCountdownTimers[_tChat] = _tTimer;
        } else {
            show(e.message);
            setInline(e.message, Math.min((e.waitMs || 8000) + 4000, 44000));
        }
        var ttl = Math.min((e.waitMs || 8000) + 2000, 40000);
        setTimeout(function() {
            if (ours()) hideSnackbar();
        }, ttl);
    } catch (err) {}
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
        // POST-OFFSCREEN-MOVE FIX: the agent loop runs in offscreen now, so its
        // `lastApiError = {...}` assignment (030-agent-loop.js) lands in the
        // OFFSCREEN copy of this global — the page copy stays null. retryLastCall()
        // guards on `if (!lastApiError) return;`, so without re-hydrating it here
        // Retry is a silent no-op for every API error (Continue works because
        // continueAgent never reads lastApiError). Mirror the loop's shape so
        // retryLastCall can read lastApiError.chatId for the correct target chat.
        //
        // R-1: but ONLY the FOCUSED chat may update the GLOBAL lastApiError (the
        // toolbar Retry button reads it). Previously an unfocused FOREGROUND chat
        // erroring overwrote the global UNCONDITIONALLY while the focused chat's
        // Retry was still showing — so clicking Retry ran the WRONG chat. Store an
        // unfocused chat's error per-chat (chat._lastApiError) instead; selectChat
        // / openChatFromHistory re-derive the global from it when the user
        // navigates to that chat (R-2). `chat` is the already null-safe
        // chats[e.chatId] computed above.
        if (e.chatId === currentChatId) {
            lastApiError = { message: msg, chatId: e.chatId, timestamp: Date.now() };
            // R-2 (B12): persist on the chat too so re-derive (selectChat /
            // openChatFromHistory) restores Retry if the user switches away from this
            // focused-but-errored chat and back. Without this a focused-origin error
            // has no persistent home and the re-derive reads undefined.
            if (chat) chat._lastApiError = lastApiError;
            showSnackbar('API Error: ' + msg, 'error');
            showRetryButton();
        } else if (chat) {
            chat._lastApiError = { message: msg, chatId: e.chatId, timestamp: Date.now() };
        }
    }
    // An error while the user is away is activity too — bold the jobs row.
    _stampChatActivity(e.chatId);
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
    // SWM14-T2: gate finalize on the SW's authoritative paused signal carried on the event.
    // A paused run emits runFinished too; trusting the racy tab-local flags here would finalize
    // (and dismiss) the action button on a mere pause. Trust e.isPaused / e.reason from the SW.
    // SWM-PAUSE-FINALIZE: !e.isPaused && e.reason!=='paused' alone can finalize the
    // action to 'Complete' even when a pause issued during the port-down window
    // hasn't LANDED at the SW yet (pause lost + button wrongly shows Complete).
    // Also require that no desired-but-unlanded pause is in-flight for this chat:
    // _pauseToggleDesired[chatId] (set in 045's pushPauseToggleToOffscreen and
    // pruned on a non-paused terminal event) === true means a pause was requested
    // but not yet confirmed by the SW — suppress finalize until it lands or clears.
    // Read the map bare with a typeof guard (it's a shared page-bundle global,
    // same access pattern tools/120-actions.js uses for _pauseToggleGen).
    var _pausePending = (typeof _pauseToggleDesired !== 'undefined' && _pauseToggleDesired && _pauseToggleDesired[chatId] === true);
    if (fchat && fchat.isBackground && fchat.actionId && !e.isPaused && e.reason !== 'paused' && !_pausePending && typeof finishActionIfDone === 'function') {
        try { finishActionIfDone(chatId); } catch (err) { console.error('finishActionIfDone failed', err); }
    } else if (fchat && fchat.isBackground && fchat.actionId && !e.isPaused && e.reason !== 'paused' && _pausePending) {
        // PR383-F4: dead-end closer for the pause-vs-natural-finish race. A Pause
        // issued just as the run finishes naturally sets _pauseToggleDesired=true,
        // the gate above suppresses finalize, and 045's post-emit prune (RES-3)
        // then deletes the token — no later runFinished ever comes, so nothing
        // finalizes and the Action button spins forever. Arm a deferred re-check:
        // if the chat is still not running once the dust settles, the pause
        // definitively lost the race and the natural finish must be finalized.
        var _f4ActionId = fchat.actionId;
        // PR384-FIX-5: bound re-arm counter. The old code returned PERMANENTLY when
        // a newer pause was desired at fire time — if that pause then cleared
        // without ever landing, nothing finalized and the button span forever.
        // Re-arm the same deferred re-check (max 3 retries) so the finalize
        // survives a pause that lands-then-clears within the window.
        var _f4Attempts = 0;
        function _f4Finalize() {
            try {
                // Run resumed/restarted — its own terminal event finalizes.
                if (typeof runningChatIds !== 'undefined' && runningChatIds[chatId]) return;
                // A newer pause is in flight for this chat. PR384-FIX-5: instead of
                // returning permanently, RE-ARM (bounded) so a pause that lands
                // then clears still finalizes once the dust settles.
                if (typeof _pauseToggleDesired !== 'undefined' && _pauseToggleDesired && _pauseToggleDesired[chatId] === true) {
                    if (_f4Attempts++ < 3) setTimeout(_f4Finalize, 2500);
                    return;
                }
                var _f4Act = (typeof activeActions !== 'undefined') ? activeActions[_f4ActionId] : null;
                // No double-finalize: only a still-'running', not explicitly paused
                // action qualifies (same guard finishActionIfDone applies; the
                // agent's own update_action_state verdict and pauseAction's
                // _isPaused both win).
                if (!_f4Act || _f4Act.state !== 'running' || _f4Act._isPaused) return;
                // The pause lost: the run already ended non-paused and nothing is
                // running. A togglePause from the chat view set only the page's
                // pausedChats flag — clear that stale flag, or finishActionIfDone's
                // isChatPaused guard refuses and the button spins forever anyway.
                if (typeof pausedChats !== 'undefined' && pausedChats[chatId] === true) pausedChats[chatId] = false;
                if (typeof finishActionIfDone === 'function') finishActionIfDone(chatId);
            } catch (err) { console.error('PR383-F4 deferred action finalize failed', err); }
        }
        setTimeout(_f4Finalize, 2500);
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
    // Self-heal the per-chat silent-hook flag at every run boundary: the hook
    // run's own silentHookState{active:false} normally clears it, but if that
    // event was lost (SW reconnect flap) a stale entry would make a future
    // real run render as finished. Any runFinished for this chat means no
    // silent hook is streaming for it anymore.
    if (typeof _silentHookChats !== 'undefined' && _silentHookChats[chatId]) delete _silentHookChats[chatId];
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
        }
    }
});

AgentEvents.on('runCrashed', function(e) {
    if (e && e.chatId && activeStreamingChatId === e.chatId) {
        isRunning = false;
        activeStreamingChatId = null;
    }
    // A crashed run never emits runFinished, so the runFinished handler's UI
    // cleanup never fires for it. Without this block the foreground chat keeps
    // a spinning "Executing…" row, the is-streaming class, and a live Pause
    // button forever after an uncaught loop throw.
    if (e && e.chatId) {
        hideSpinner(e.chatId);
        if (e.chatId === currentChatId) {
            var _crMsgsEl = document.getElementById('messages');
            if (_crMsgsEl) _crMsgsEl.classList.remove('is-streaming');
            hidePauseButton();
            if (typeof refreshContinueButtonForChat === 'function') { try { refreshContinueButtonForChat(e.chatId); } catch (err) {} }
            renderMessages();
        }
    }
    // Background Action crash finalize: finishActionIfDone only runs on
    // runFinished (page handler above + the SW loop's finish cleanup), so a
    // crashed Action chat's button stayed state 'running' forever — spinning,
    // no verdict, not dismissable as failed. Finalize it as 'error' here.
    // Page-side on purpose: tools/120-actions.js (activeActions /
    // persistActionState / notifyActionStateChanged) is NOT in
    // WORKER_SHARED_FILES, so the SW cannot finalize — the page owns action
    // state, exactly like the runFinished path. Same guard as
    // finishActionIfDone: only auto-finalize a still-'running' action that
    // isn't paused (the agent's own update_action_state verdict wins).
    if (e && e.chatId && typeof chats !== 'undefined' && chats[e.chatId]
        && chats[e.chatId].isBackground && chats[e.chatId].actionId
        && typeof activeActions !== 'undefined' && activeActions[chats[e.chatId].actionId]) {
        var _crAct = activeActions[chats[e.chatId].actionId];
        var _crPaused = _crAct._isPaused || (typeof isChatPaused === 'function' && isChatPaused(e.chatId));
        if (_crAct.state === 'running' && !_crPaused) {
            _crAct.state = 'error';
            _crAct.icon = 'alert';
            if (!_crAct.label || _crAct.label === 'Starting…') _crAct.label = 'Crashed';
            if (!_crAct.output) _crAct.output = 'The run crashed with an uncaught error before reporting a result. Open the chat for details.';
            _crAct.updatedAt = Date.now();
            if (typeof persistActionState === 'function') { try { persistActionState(chats[e.chatId].actionId); } catch (err) {} }
            if (typeof notifyActionStateChanged === 'function') { try { notifyActionStateChanged(chats[e.chatId].actionId); } catch (err) {} }
        }
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
    if (e && e.chatId) _stampChatActivity(e.chatId);
    if (e && e.chatId && typeof markChatRecentlyFinished === 'function') { try { markChatRecentlyFinished(e.chatId); } catch (err) {} }
    // A crashed hook run never emits silentHookState{active:false} — clear the
    // per-chat flag here too (same self-heal as the runFinished handler).
    if (e && e.chatId && typeof _silentHookChats !== 'undefined' && _silentHookChats[e.chatId]) delete _silentHookChats[e.chatId];
    // A crash is a finish the user must see: notifyFinish (which stamps the
    // finished-chat bell on natural finishes) is skipped when the loop throws,
    // so stamp the bell here. noteChatFinishedUnseen itself skips the focused
    // chat and sub-agent/background chats.
    if (e && e.chatId && typeof noteChatFinishedUnseen === 'function') { try { noteChatFinishedUnseen(e.chatId, true); } catch (err) {} }
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
    // In-app counterpart: when the user is ON the extension page but viewing
    // a DIFFERENT chat, no browser notification fires — light up the small
    // finished-chat badge in the top-right header bar instead. Also stamped
    // when away (harmless): the badge greets the user when they come back.
    // noteChatFinishedUnseen() itself skips currentChatId / sub-agent /
    // background chats. (ui/165-finished-chat-badge.js)
    if (!e.isPaused && !e.wasSilentHook && typeof noteChatFinishedUnseen === 'function') {
        try { noteChatFinishedUnseen(chatId, !!e.hasError); } catch (err) {}
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
    // A tool parked on approval needs the user — that's unseen activity.
    _stampChatActivity(e.chatId);
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
    // Merge-lifecycle auto-delete: the engine already synced+pulled the base
    // workspace — clear any stale "behind" cached for it (the summaries path
    // deliberately carries the previous syncStatus forward, so without this
    // the base keeps a stale behind badge until the next full remote sync).
    if (e && e.action === 'auto_delete_merged' && typeof _resetBaseCacheAfterAutoDelete === 'function') {
        try { _resetBaseCacheAfterAutoDelete({ base_workspace: e.base_workspace, base_synced: e.synced }); } catch (err) {}
    }
    if (typeof updateWorkspaceHeaderStatus === 'function') updateWorkspaceHeaderStatus();
});

// actionStateChanged: foreground update_action_state call needs the version
// sidebar to refresh (it surfaces in-flight action progress alongside
// recordMutated entries). The action button itself is driven by
// notifyActionStateChanged listeners in tools/120-actions.js — independent.
AgentEvents.on('actionStateChanged', function(e) {
    // PR-MERGED relay: wsNotifyPrMerged (tools/020-tool-execution.js) ran in
    // the SERVICE WORKER (the workspace tool is headless), where it wrote the
    // authoritative chats[chatId].progressStateOverride and persisted — but
    // this page's chats mirror is stale (actionStateChanged does NOT inline
    // the chat snapshot). Hydrate the mirror from the event payload, run the
    // full page-side flip via markChatPrMerged (background action card +
    // title pill + popover — idempotent, so a page-originated emit settles on
    // the second pass), then repaint the badge surfaces that read
    // getChatProgressStateFor (home cards / jobs dropdown / chat list rows).
    if (e && e.chatId && e.status === 'pr_merged') {
        if (e.progressStateOverride && typeof chats !== 'undefined' && chats[e.chatId] &&
            !chats[e.chatId].progressStateOverride) {
            chats[e.chatId].progressStateOverride = e.progressStateOverride;
        }
        if (typeof markChatPrMerged === 'function') {
            try { markChatPrMerged(e.chatId, { number: e.pr_number || null, url: e.pr_url || null }); } catch (err) {}
        }
        try { if (typeof renderChatList === 'function') renderChatList(); } catch (err) {}
        try { if (typeof _refreshWaitingBadges === 'function') _refreshWaitingBadges(e.chatId); } catch (err) {}
    }
    if (typeof renderVersionSidebar === 'function') {
        try { renderVersionSidebar(); } catch (err) {}
    }
});

// chatTitleChanged: set_chat_title (a headless tool) updated chat.title in the
// SW. The page's chats mirror is stale and the header/list were never
// refreshed. Hydrate the local title then re-run the UI side effects the tool
// used to perform inline. Without this, a freshly-set title doesn't appear
// until some later unrelated render (the "title not visible right away" bug).
AgentEvents.on('chatTitleChanged', function(e) {
    if (!e || !e.chatId) return;
    if (chats[e.chatId]) {
        chats[e.chatId].title = e.title;
        // Mirror the SW-side flag clear (executeSetChatTitle). Without this the
        // page's stale titleProvisional=true gets re-inlined to the SW on the
        // next send and the auto-title hook needlessly re-fires.
        delete chats[e.chatId].titleProvisional;
    }
    if (typeof renderChatList === 'function') {
        try { renderChatList(); } catch (err) {}
    }
    if (e.chatId === currentChatId && typeof updateChatTitleHeader === 'function') {
        try { updateChatTitleHeader(); } catch (err) {}
    }
});

// tldrChanged / linksChanged: set_tldr / set_links (headless tools) attached a
// value to the final-answer assistant message in the SW. The page's chats
// mirror is stale — hydrate it via attachAnswerCard (the SAME shared helper
// the tools use in tools/020-tool-execution.js, so target search + same-turn
// dedupe stay identical) then re-render so the card appears immediately in
// the currently viewed chat.
AgentEvents.on('tldrChanged', function(e) {
    if (!e || !e.chatId || !e.tldr) return;
    var chat = chats[e.chatId];
    if (chat && chat.messages) attachAnswerCard(chat, 'tldr', e.tldr);
    if (e.chatId === currentChatId && typeof renderMessages === 'function') {
        try { renderMessages(); } catch (err) {}
    }
});

AgentEvents.on('linksChanged', function(e) {
    if (!e || !e.chatId || !Array.isArray(e.links)) return;
    var chat = chats[e.chatId];
    if (chat && chat.messages) attachAnswerCard(chat, 'links', e.links);
    if (e.chatId === currentChatId && typeof renderMessages === 'function') {
        try { renderMessages(); } catch (err) {}
    }
});

// caveatChanged: set_caveat (headless tool) attached a must-read warning to the
// final-answer assistant message in the SW. Hydrate the page's stale chats
// mirror via the SAME shared attachAnswerCard helper, then re-render so the
// amber caveat card appears immediately in the currently viewed chat.
AgentEvents.on('caveatChanged', function(e) {
    if (!e || !e.chatId || !e.caveat) return;
    var chat = chats[e.chatId];
    if (chat && chat.messages) attachAnswerCard(chat, 'caveat', e.caveat);
    if (e.chatId === currentChatId && typeof renderMessages === 'function') {
        try { renderMessages(); } catch (err) {}
    }
});

// silentHookState: a silent (hidden) after-response hook — e.g. auto-title —
// runs its OWN agent loop in the SW and flags the chat THERE
// (_silentHookRunningByChat). Mirror it onto the page's per-chat
// _silentHookChats map (tools/120-actions.js) so the render gates
// (renderMessages / _updateStreamingMessageNow / showSpinner) suppress the
// hook's output while it streams — scoped to the hook's OWN chat, so a
// background chat's hook never freezes the foreground chat's spinner or
// streaming render (the old global boolean did exactly that).
AgentEvents.on('silentHookState', function(e) {
    // While a chat's silent hooks run,
    // its jobs rows must NOT show "Running…" — the user-visible answer already
    // landed, so the unseen bell should light up on the row immediately instead
    // of waiting a couple of seconds for the hook run to finish. Re-render the
    // jobs surfaces on both edges so the row flips right away.
    if (e && e.chatId && typeof _silentHookChats !== 'undefined') {
        if (e.active) _silentHookChats[e.chatId] = true;
        else delete _silentHookChats[e.chatId];
        try { if (typeof renderJobsBadge === 'function') renderJobsBadge(); } catch (err) {}
        try {
            var _jdSh = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
            if (_jdSh && typeof renderJobsDropdown === 'function') renderJobsDropdown(_jdSh);
        } catch (err) {}
    }
});

// recordMutated: servicenow_api or servicenow_diff_edit modified a record.
// The event carries everything the version-history entry needs; the panel
// owns the versionHistory array + sidebar + inline-changes rendering.
// Route to the chat that owns the mutation (may not be the active chat
// when a background chat ran the tool).
// The executing tier already appended the entry to chats[chatId].versionHistory
// via trackRecordMutation (tools/020-tool-execution.js, shared with the SW).
// When the SW ran the tool, that entry reaches the page via the next
// chat-inlined broadcast — but THIS event may arrive first, so append-if-
// missing (deduped by entryId in addVersionHistoryEntryForChat) covers both
// orderings without double entries.
AgentEvents.on('recordMutated', function(e) {
    if (typeof addVersionHistoryEntryForChat !== 'function') return;
    addVersionHistoryEntryForChat(e.chatId, {
        id: e.entryId || ('vh_' + Date.now()),
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
