// ── Chat auto-scroll: the single stick-to-bottom mechanism ──────────────────
//
// One per-chat boolean drives ALL chat auto-scrolling:
//
//   • stickToBottom (per-chat, default true). While true, every content-growth
//     path (new messages, streaming tokens, tool rows, spinner, widgets)
//     funnels through scrollToBottomIfAllowed(), which pins BOTH chat scroll
//     containers (#messages and the inner #streaming-text) to their bottom in
//     a single rAF-batched pass that runs after layout.
//   • The flag is flipped ONLY by handleChatScroll(), attached to the scroll
//     events of both containers. Classification is by position + direction —
//     no gesture heuristics, no programmatic-scroll windows, no debounce:
//       - event lands AT the bottom WITHOUT having moved up → stick (covers
//         our own instant pin echoes and the user deliberately reaching the
//         bottom via wheel / scrollbar / keyboard / touch). A DOWNWARD gate:
//         clamp events (content or maxHeight shrink forces scrollTop DOWN to
//         the new max, landing "at the bottom") must NOT re-stick a user who
//         had scrolled away — before this gate, the streaming el's maxHeight
//         recalc while a released user scrolled the outer container clamped
//         the inner el to its bottom and spuriously re-stuck, yanking the
//         user back down on the next chunk.
//       - scrollTop DECREASED and the position is above the bottom → the user
//         scrolled up (wheel, scrollbar drag, middle-click autoscroll,
//         selection drag, PageUp — all of them) → release.
//       - scrollTop INCREASED and landed NEAR the bottom (isNearBottom's
//         threshold, the same one chat-open uses to derive the flag in
//         120-init.js) → re-stick. RESTICK-RACE: requiring the EXACT bottom
//         (≤2px) here made re-engaging follow nearly impossible mid-stream —
//         every rAF paint grows scrollHeight between the user's last downward
//         wheel tick and the coalesced scroll event, so the event is
//         classified 10-100px above the freshly-grown bottom and the ≤2px
//         gate never passes: the user chases a moving bottom and auto-scroll
//         appears permanently broken until the next send re-sticks. Only
//         UPWARD movement can release, and only user gestures produce
//         top > last (pins/restores seed _agLastScrollTop to their landing
//         position, clamps only ever move top DOWN), so a downward gesture
//         near the bottom is unambiguous "resume following" intent.
//     Programmatic pins are always instant scrollTop writes to the exact
//     bottom, and programmatic RESTORES seed _agLastScrollTop (see
//     restoreChatScrollTop), so neither can be misread as a user scroll.
//     INVARIANT (clamp-escape): any same-task DOM mutation that can
//     transiently SHRINK a chat scroll container (innerHTML rebuilds with
//     widgets parked off-DOM, row swaps) MUST be followed, in the SAME task,
//     by a seeding write — pinToBottom for sticking users,
//     restoreChatScrollTop for released ones. Scroll events are dispatched
//     in the rendering steps BEFORE rAF callbacks, so a bare
//     scrollToBottomIfAllowed() after such a mutation loses the race: the
//     clamp's scroll event fires first at the clamped-low position, is
//     classified as a user scroll-up, releases the stick, and the rAF pin
//     then refuses to run — stranding the chat at the TOP (this was the
//     historical scroll-to-top bug in renderMessages' stick branch).
//   • Growth that happens with NO explicit call site — widget iframes
//     resizing via widgetResize postMessage, images finishing to load,
//     smart-document re-renders, font swaps — is caught by a ResizeObserver
//     on the container's direct children (see ensureChatGrowthObservers):
//     any child border-box change while following re-pins through the same
//     choke point. Before this observer the view silently drifted off-bottom
//     whenever content grew after the last explicit pin.
//   • The chat scroll containers opt out of BROWSER scroll anchoring
//     (overflow-anchor: none in 04-header.css): anchoring adjusts scrollTop
//     on its own when content above the anchor grows/shrinks, and a shrink
//     adjustment (scrollTop decreased, above bottom) is indistinguishable
//     from a user scroll-up — it silently released the follow flag.
//   • Sending a message re-sticks explicitly (040-send-message.js), and
//     opening a chat derives the flag from the restored position (120-init.js).
var stickToBottomByChatId = {};
Object.defineProperty(window, 'stickToBottom', {
    configurable: true,
    get: function() {
        var k = currentChatId || '_';
        // Default to true on first read (new/unseen chats follow the bottom).
        if (!(k in stickToBottomByChatId)) stickToBottomByChatId[k] = true;
        return stickToBottomByChatId[k];
    },
    set: function(v) {
        stickToBottomByChatId[currentChatId || '_'] = !!v;
    }
});

// Classify a scroll event on a chat scroll container and update stickToBottom.
// Direction is tracked per-element (multiple scrollTop changes within one
// task coalesce into one event at the final position, so a rebuild's
// clamp + same-task seeding write — pinToBottom or restoreChatScrollTop,
// see the clamp-escape INVARIANT above — never produces a phantom
// scroll-up).
function handleChatScroll(el) {
    var top = el.scrollTop;
    var last = (el._agLastScrollTop !== undefined) ? el._agLastScrollTop : top;
    el._agLastScrollTop = top;
    var distFromBottom = el.scrollHeight - top - el.clientHeight;
    if (distFromBottom <= 2) {
        // At the bottom — but only re-stick when the position did NOT move up.
        // top >= last covers pin echoes (pinToBottom pre-seeds last = top) and
        // real downward scrolls that reach the bottom. top < last here is a
        // CLAMP (scrollHeight shrank, browser forced scrollTop down to the new
        // max) — keep the current state: a following user stays following, a
        // released user is NOT yanked back by a shrink they never asked for.
        if (top >= last) stickToBottom = true;
    } else if (top > last) {
        // RESTICK-RACE (see header): a deliberate DOWNWARD scroll that lands
        // near the bottom re-engages follow even when streaming growth moved
        // the exact bottom out from under the gesture. Programmatic writes
        // can't take this arm: pinToBottom / restoreChatScrollTop seed
        // _agLastScrollTop to their landing position (echo has top === last)
        // and clamps only ever DECREASE top. Threshold mirrors the chat-open
        // derivation (stickToBottom = isNearBottom(...) in 120-init.js);
        // typeof-guarded like other cross-file calls, with the same 150px
        // fallback isNearBottom uses (core/040-hooks-history.js).
        var _nearBottom = (typeof isNearBottom === 'function') ? isNearBottom(el) : (distFromBottom < 150);
        if (_nearBottom) stickToBottom = true;
        // Downward scrolls that stop farther above the bottom keep the
        // current state.
    } else if (top < last - 1) {
        stickToBottom = false;  // user moved up, away from the bottom → release
    }
    // Sub-pixel jitter (top within 1px of last, above the bottom) keeps the
    // current state.
}

// Pin an element to its bottom with an instant write (no smooth glide — rapid
// per-chunk calls must not race an animation, and the echo event must land
// exactly at the bottom so handleChatScroll classifies it as "following").
function pinToBottom(el) {
    el.scrollTop = el.scrollHeight;
    el._agLastScrollTop = el.scrollTop;
}

// Programmatic absolute scroll restore (chat open, post-rebuild position keep
// for released users). Seeds _agLastScrollTop so the coalesced scroll event
// that follows compares against the RESTORED position — not a stale value
// from the previous chat / pre-rebuild DOM — and can't misclassify the
// restore as a user scroll (which would clobber the follow flag).
function restoreChatScrollTop(el, top) {
    el.scrollTop = top;
    el._agLastScrollTop = el.scrollTop;
}

// ── Growth observers ─────────────────────────────────────────────────────────
// Re-pin on content growth that has NO explicit scrollToBottomIfAllowed call
// site: widget iframes resized by their height reporter (080-widget-tools.js
// onWidgetResize → iframe.style.height), images/attachments finishing to
// load, smart-document card re-renders, details toggles, font swaps. A
// ResizeObserver on the container's DIRECT CHILDREN is exactly equivalent to
// "scrollHeight changed" in this block layout: any descendant growth
// propagates to a direct child's border-box. Children are re-registered via a
// childList MutationObserver whenever a rebuild replaces them (#messages is a
// static element — see body.html — so one-time setup lasts the app lifetime;
// inner.innerHTML swaps keep the observed #messages-inner node itself alive).
// The callback only acts while following — it never fights a released user —
// and routes through the rAF-batched choke point, so bursts coalesce and
// pinning (a scrollTop write, not a resize) can't retrigger the observer.
var _agGrowthRO = null;
var _agChildMO = null;
function _agObserveChildren(container) {
    if (!_agGrowthRO) return;
    _agGrowthRO.disconnect();
    for (var i = 0; i < container.children.length; i++) {
        _agGrowthRO.observe(container.children[i]);
    }
}
function ensureChatGrowthObservers() {
    var container = document.getElementById('messages');
    if (!container || container._agGrowthObserved) return;
    if (typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return;
    container._agGrowthObserved = true;
    _agGrowthRO = new ResizeObserver(function() {
        if (stickToBottom) scrollToBottomIfAllowed();
    });
    _agChildMO = new MutationObserver(function() { _agObserveChildren(container); });
    _agChildMO.observe(container, { childList: true });
    _agObserveChildren(container);
}

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
    el.addEventListener('scroll', function() {
        handleChatScroll(el);
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
    // FIX1: each streaming repaint above re-ran formatContent(), minting fresh
    // rc-N rawCopyStore entries (200-ui-interactions.js storeRawCopy) for
    // every code fence while the innerHTML swap orphaned the previous tick's
    // entries — nothing swept them until the NEXT full renderMessages, so
    // long code-heavy streams accumulated entries quadratically. Sweep on a
    // throttle during streaming (ui-tier helper; typeof-guarded like other
    // cross-file calls). Copy buttons keep working: the finalize path does a
    // full render that mints fresh keys for the final DOM.
    if (typeof gcRawCopyStoreThrottled === 'function') gcRawCopyStoreThrottled();
    scrollToBottomIfAllowed();
}

// Calculate and set the streaming container height to fill remaining viewport
// space. Pure layout — the pin (if any) is owned by scrollToBottomIfAllowed;
// a maxHeight shrink self-clamps scrollTop to the new max.
function updateStreamingContainerHeight() {
    var streamingEl = document.querySelector('.streaming-answer');
    if (!streamingEl) return;
    var rect = streamingEl.getBoundingClientRect();
    var viewportHeight = window.innerHeight;
    var availableHeight = viewportHeight - rect.top - 16;
    streamingEl.style.maxHeight = Math.max(availableHeight, 100) + 'px';
}

// THE single scroll code path. Every content-growth site (renders, streaming
// chunks, spinner, prompt widgets, notifications, widget loads) calls this;
// nothing else in the chat UI scrolls to the bottom. rAF-batched so bursts of
// per-chunk calls collapse into one pin that runs after layout (never before
// the DOM has its final height) and before the next paint (no flicker).
var _pinScheduled = false;
function scrollToBottomIfAllowed() {
    // Lazy one-time setup (guarded by a flag on the static #messages element) —
    // every pin call site funnels here, so the observers are installed the
    // first time the chat UI scrolls at all.
    ensureChatGrowthObservers();
    if (_pinScheduled) return;
    _pinScheduled = true;
    requestAnimationFrame(function() {
        _pinScheduled = false;
        var container = document.getElementById('messages');
        if (!container) return;
        // Height BEFORE pin: updateStreamingContainerHeight can raise the
        // streaming el's maxHeight and thereby grow the outer scrollHeight —
        // pinning first would leave the pin short by that growth.
        var streamingEl = container.querySelector('.streaming-answer');
        if (streamingEl) updateStreamingContainerHeight();
        if (!stickToBottom) return; // user scrolled up — never fight them
        pinToBottom(container);
        if (streamingEl) pinToBottom(streamingEl);
    });
}
