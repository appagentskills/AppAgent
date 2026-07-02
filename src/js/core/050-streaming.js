// Track whether user has scrolled up inside the streaming text container.
// B5: per-chat. The global getter/setter below preserves the legacy reads while
// scoping mutation to currentChatId. Switching chats no longer resets the
// scroll-follow intent of the chat you came from.
var isFollowingStreamingScrollByChatId = {};
Object.defineProperty(window, 'isFollowingStreamingScroll', {
    configurable: true,
    get: function() {
        var k = currentChatId || '_';
        // Default to true on first read (matches legacy default).
        if (!(k in isFollowingStreamingScrollByChatId)) isFollowingStreamingScrollByChatId[k] = true;
        return isFollowingStreamingScrollByChatId[k];
    },
    set: function(v) {
        var k = currentChatId || '_';
        isFollowingStreamingScrollByChatId[k] = !!v;
    }
});
// R2: programmatic scrolls (smooth scrollTo / scrollTop writes from the render
// and streaming helpers) fire the same document-level scroll events as real user
// scrolls, so the capture-phase listener in 010-skills-ui.js would record them as
// user activity and randomly disengage auto-follow mid-run. Every programmatic
// scroll site calls markProgrammaticScroll() first; the listener early-returns
// while the window is open. A real user gesture (wheel / touchmove / keydown)
// clears the window immediately so deliberate scrolls still disengage.
window._programmaticScrollUntil = 0;
function markProgrammaticScroll(ms) {
    window._programmaticScrollUntil = Date.now() + (ms || 600);
}
(function() {
    function clearProgrammaticScrollFlag() {
        window._programmaticScrollUntil = 0;
    }
    document.addEventListener('wheel', clearProgrammaticScrollFlag, { capture: true, passive: true });
    document.addEventListener('touchmove', clearProgrammaticScrollFlag, { capture: true, passive: true });
    document.addEventListener('keydown', clearProgrammaticScrollFlag, true);
    // REG-F3 (revised): scrollbar drags and middle-click autoscroll produce
    // NO wheel/touchmove/keydown — only scroll events — so those gestures
    // were swallowed by the continuously re-armed window and could never
    // disengage auto-follow. But the first cut (clear on ANY pointer-down)
    // reintroduced the original R2 bug for plain clicks: the smooth glide
    // (scrollToBottomIfAllowed emits trailing scroll events for ~600ms) was
    // mid-flight when the user clicked a copy/expand button anywhere on the
    // page, the cleared window let the glide's own events register as user
    // scrolls at a not-near-bottom position, and auto-follow disengaged.
    // Clear ONLY for gestures that can actually begin a manual scroll:
    //   • middle button (autoscroll) — anywhere;
    //   • a press on a scrollable container ITSELF — a scrollbar/track hit
    //     targets the element, while content clicks target a descendant, so
    //     button/text clicks no longer kill the window.
    function _scrollGestureDown(e) {
        if (e.button === 1) { clearProgrammaticScrollFlag(); return; }
        var t = e.target;
        // REG-AUDIT-3: 'messages' only — the flag is only consulted by the
        // #messages scroll listener (ui/010-skills-ui.js); #streaming-text's
        // own handler applies hysteresis directly and never reads it.
        if (t && t.nodeType === 1 &&
            t.id === 'messages' &&
            t.scrollHeight > t.clientHeight) {
            clearProgrammaticScrollFlag();
        }
    }
    document.addEventListener('mousedown', _scrollGestureDown, { capture: true, passive: true });
    document.addEventListener('pointerdown', _scrollGestureDown, { capture: true, passive: true });
    // SF-3: selection-drag autoscroll (primary-button press on message CONTENT,
    // then drag past the container edge) emits ONLY scroll events — no wheel/
    // touchmove/keydown, and _scrollGestureDown above deliberately ignores
    // content-targeted presses (REG-AUDIT-3). With the SF-2 streaming pin
    // re-arming the programmatic window every chunk, those drag scrolls were
    // swallowed by the #messages listener (010-skills-ui.js), isFollowingScroll
    // never disengaged, and every chunk yanked the selection back to the
    // bottom. Clear the window while a primary-button DRAG is in flight; the
    // 4px slop keeps plain clicks (the original R2 false positive — click
    // during the smooth glide) from clearing it. A drag that never scrolls
    // may let a concurrent glide's trailing events register as user activity,
    // which is acceptable: the user IS gesturing, and the listener only
    // disengages follow when they are genuinely away from the bottom.
    var _sfDragStart = null;
    document.addEventListener('mousedown', function(e) {
        if (e.button === 0) _sfDragStart = { x: e.clientX, y: e.clientY };
    }, { capture: true, passive: true });
    document.addEventListener('mousemove', function(e) {
        if (!_sfDragStart || !(e.buttons & 1)) return;
        if (Math.abs(e.clientX - _sfDragStart.x) > 4 || Math.abs(e.clientY - _sfDragStart.y) > 4) {
            clearProgrammaticScrollFlag();
        }
    }, { capture: true, passive: true });
    document.addEventListener('mouseup', function() { _sfDragStart = null; }, { capture: true, passive: true });
})();

// Create and configure the #streaming-text container element
function createStreamingTextEl() {
    var el = document.createElement('div');
    el.id = 'streaming-text';
    el.className = 'streaming-answer';
    // SC-1: stamp the owning chat. renderMessages' preserve branch keeps
    // #streaming-text alive across full rebuilds (protects its scroll
    // position) — but on a chat switch between two RUNNING chats the element
    // found in the DOM belongs to the PREVIOUSLY viewed chat. The stamp lets
    // the render distinguish "same chat, keep it" from "another chat's
    // leftovers, wipe it": .streaming-entry rows inside are keyed by
    // data-msg-idx only (no chat identity), so a foreign chat's finalized
    // entries would otherwise survive under the new chat's tools panel
    // indefinitely. Both callers (renderMessages' fresh-element branch and
    // updateStreamingText's lazy create, which is guarded on
    // streamingChatId === currentChatId) create the element FOR the
    // currently-viewed chat, so currentChatId is the owner at creation time.
    el.dataset.chatId = currentChatId || '';
    // Reset only the foreground chat's flag (B5). Other chats keep their intent.
    isFollowingStreamingScroll = true;
    el.addEventListener('scroll', function() {
        var distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // Hysteresis: only disengage when user deliberately scrolls far up,
        // re-engage when near bottom. Prevents layout-induced scroll jitter from disabling auto-scroll.
        if (distFromBottom < 30) {
            isFollowingStreamingScroll = true;
        } else if (distFromBottom > 150) {
            isFollowingStreamingScroll = false;
        }
        el.classList.toggle('has-top-shadow', el.scrollTop > 10);
    });
    return el;
}

// Update the streaming text container (#streaming-text) at the bottom of messages.
// Each assistant message gets its own div - only the streaming message is updated per tick.
// B3: optional streamingChatId param so future callers can be explicit. Current
// caller (updateStreamingMessage) already gates on the match, but the defensive
// guard here ensures any future caller invoking us for a non-foreground chat
// silently no-ops instead of corrupting the foreground DOM.
function updateStreamingText(msg, index, streamingChatId) {
    if (streamingChatId && streamingChatId !== currentChatId) return;
    var chat = chats[currentChatId];
    if (!chat) return;
    // Find last user message to scope to current response
    var lastUserIdx = -1;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        if (chat.messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    var el = document.getElementById('streaming-text');
    // INT-B3 (checked BEFORE lazy-create): a hidden hook turn must never
    // CREATE an empty streaming container — see the full comment below. When
    // the container already exists we still prune + resize it, matching the
    // pre-existing order (prune, then gate).
    var _hiddenHookTurn = lastUserIdx >= 0 && chat.messages[lastUserIdx].isHookMessage &&
        !(typeof hooksEnabled !== 'undefined' && hooksEnabled && hooksEnabled.showHookMessages);
    if (_hiddenHookTurn && !el) return;
    if (!el) {
        var container = document.getElementById('messages');
        if (!container) return;
        el = createStreamingTextEl();
        container.appendChild(el);
    }
    // INT-B1: prune stale entries from a PREVIOUS turn. When the user
    // interrupts mid-stream by sending a message, renderMessages preserves
    // #streaming-text across the userInjected re-render (same chat), but the
    // paint loop below only touches entries with data-msg-idx > lastUserIdx —
    // entries from the pre-interrupt turn were never overwritten NOR removed,
    // so the old (possibly popped-from-transcript) text sat frozen BELOW the
    // new user bubble for the rest of the run. The prune boundary is the SAME
    // turn boundary the paint loop uses (SC-2/FLUSH-TAIL contract: only
    // entries AFTER the last user message are painted), so nothing that can
    // still be painted is ever removed.
    var _staleEntries = el.querySelectorAll('.streaming-entry');
    for (var _k = 0; _k < _staleEntries.length; _k++) {
        var _si = parseInt(_staleEntries[_k].getAttribute('data-msg-idx'), 10);
        if (!(_si > lastUserIdx)) _staleEntries[_k].remove();
    }
    // INT-B3: hidden after-response hook turn (set_chat_title / set_tldr with
    // showHookMessages off) — never paint the hook's streamed chatter into
    // #streaming-text. Matters after SILENT-HOOK-QUEUE-FIX (040-send-message.js)
    // clears this chat's _silentHookChats entry on an interrupting send: that
    // flag was the only gate keeping hook output invisible here. The spinner /
    // queued-bubble behavior that fix wanted is untouched — only the hook
    // TEXT stays hidden, consistent with renderMessages' own hook filtering.
    if (_hiddenHookTurn) {
        updateStreamingContainerHeight();
        return;
    }
    // For each assistant message, find or create its div - only update the streaming one
    var prevMsgDiv = null;
    for (var j = lastUserIdx + 1; j < chat.messages.length; j++) {
        var m = chat.messages[j];
        if (m.role === 'assistant' && m.content) {
            var msgDiv = el.querySelector('[data-msg-idx="' + j + '"]');
            if (!msgDiv) {
                msgDiv = document.createElement('div');
                msgDiv.className = 'streaming-entry';
                msgDiv.setAttribute('data-msg-idx', j);
                el.appendChild(msgDiv);
            }
            if (j === index) {
                // Only update the streaming message's content
                msgDiv.innerHTML = formatContent(getDisplayContent(m, j));
            } else if (!msgDiv.dataset.finalized) {
                // Update completed messages once, then mark as finalized
                msgDiv.innerHTML = formatContent(m.content);
                msgDiv.dataset.finalized = '1';
            }
            prevMsgDiv = msgDiv;
        }
    }
    updateStreamingContainerHeight();
    if (isFollowingStreamingScroll) {
        el.scrollTop = el.scrollHeight;
    }
}

// Calculate and set the streaming container height to fill remaining viewport space
function updateStreamingContainerHeight() {
    var streamingEl = document.querySelector('.streaming-answer');
    if (!streamingEl) return;
    var savedScroll = streamingEl.scrollTop;
    var rect = streamingEl.getBoundingClientRect();
    var viewportHeight = window.innerHeight;
    var availableHeight = viewportHeight - rect.top - 16;
    streamingEl.style.maxHeight = Math.max(availableHeight, 100) + 'px';
    // After maxHeight change: if following, go to the new bottom; otherwise restore position
    if (isFollowingStreamingScroll) {
        streamingEl.scrollTop = streamingEl.scrollHeight;
    } else {
        streamingEl.scrollTop = savedScroll;
    }
}

function scrollToBottomIfAllowed(container) {
    container = container || document.getElementById('messages');
    if (!container) return;

    // During streaming, scroll the inner container independently of outer scroll state
    var streamingEl = container.querySelector('.streaming-answer');
    if (streamingEl) {
        // SF-2: in-place streaming growth (tool-args textContent, appended
        // tool-call/thinking details, spinner) raises the OUTER scrollHeight
        // without ever passing through renderMessages, so SF-1's render-time
        // growth delta never saw it and the streaming container slid below the
        // fold for an at-bottom user. This function is the single choke point
        // every incremental path already calls — keep the outer container
        // pinned to the bottom here while the user is following. Direct
        // scrollTop write (no smooth glide) so rapid per-chunk calls can't
        // race a 600ms animation; markProgrammaticScroll so the #messages
        // listener (010-skills-ui.js) doesn't count it as user activity;
        // gated on isFollowingScroll + the user-scroll debounce so a user who
        // deliberately scrolled up is never fought (the listener re-arms the
        // flag when they return near the bottom).
        //
        // SF-3 ordering: height BEFORE pin. updateStreamingContainerHeight can
        // raise the streaming el's maxHeight (its input, rect.top, depends on
        // the current scrollTop) and thereby grow the outer scrollHeight —
        // pinning first left the pin short by that growth until the next
        // chunk. Computing the height at the pre-pin position only makes the
        // cap momentarily conservative, which the next call corrects.
        updateStreamingContainerHeight();
        if (isFollowingScroll && Date.now() - lastUserScrollTime >= SCROLL_DEBOUNCE_MS) {
            markProgrammaticScroll();
            container.scrollTop = container.scrollHeight;
        }
        if (isFollowingStreamingScroll) {
            streamingEl.scrollTop = streamingEl.scrollHeight;
        }
        return;
    }

    // For non-streaming: only scroll if user is following and hasn't scrolled recently
    if (!isFollowingScroll) return;
    if (Date.now() - lastUserScrollTime < SCROLL_DEBOUNCE_MS) return;
    markProgrammaticScroll(); // R2: smooth scroll emits many scroll events over ~600ms
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}
