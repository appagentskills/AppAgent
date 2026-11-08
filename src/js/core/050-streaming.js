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
    // Native scroll-bar drags may not fire pointermove: a scroll while the
    // pointer is held keeps the hold alive (re-arms the safety timeout).
    if (_agPointerHeld) _agArmPointerHeldTimer();
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
        // SCROLL-INTENT: release only on a REAL user scroll-up. Programmatic
        // upward shifts nobody asked for — focus() scrolling a rebuilt
        // prompt field / tool panel into view, scrollIntoView from sticky
        // headers, layout shifts — used to take this arm too, silently
        // dropping the follow flag mid-run (auto-scroll "randomly" stopped
        // until the next send). A user scroll is always preceded by an input
        // gesture (wheel / touch / pointer on the scrollbar / key); a big
        // jump (> one viewport, e.g. search / sidebar navigation) is
        // deliberate navigation and also releases.
        if (_agHasUserScrollIntent() || distFromBottom > el.clientHeight) {
            stickToBottom = false;  // user moved up, away from the bottom → release
        }
    }
    // Sub-pixel jitter (top within 1px of last, above the bottom) keeps the
    // current state.
    updateScrollToBottomButton();
}

// ── User scroll intent ───────────────────────────────────────────────────────
// Timestamp of the last input gesture that can scroll the chat. Scroll events
// within SCROLL_INTENT_MS of it (or while a pointer is held — scrollbar drag,
// selection drag, middle-click autoscroll) count as user scrolls.
var SCROLL_INTENT_MS = 1000;
var _agUserScrollIntentAt = 0;
var _agPointerHeld = false;
var SCROLL_INTENT_KEYS = { ArrowUp: 1, ArrowDown: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1, ' ': 1 };
// A held pointer whose pointerup never arrives (released outside the window,
// capture lost, tab hidden) must not pin "user intent" forever: auto-clear
// after this long without a pointermove.
var POINTER_HELD_MAX_MS = 10000;
var _agPointerHeldTimer = null;
// Input types that do NOT consume Space/Arrow/Home/End as text editing —
// keys on these still count as scroll intent.
var _AG_NON_TEXT_INPUTS = { checkbox: 1, radio: 1, button: 1, submit: 1, reset: 1, color: 1, file: 1, image: 1 };
function _agMarkUserScrollIntent() { _agUserScrollIntentAt = Date.now(); }
function _agHasUserScrollIntent() {
    return _agPointerHeld || (Date.now() - _agUserScrollIntentAt) < SCROLL_INTENT_MS;
}
// S1: Space / arrows / Home / End typed into an editable field (composer,
// inputs, contenteditable docs) edit text — they don't scroll the chat.
function _agIsEditableTarget(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    var tag = String(t.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !_AG_NON_TEXT_INPUTS[String(t.type || 'text').toLowerCase()];
    return false;
}
// Keys scroll the focused element's scroller or the document: only targets
// that are the document/body or inside #messages (and not editable) can
// scroll the chat — PageUp on a sidebar button must not open the window.
function _agIsChatKeyTarget(t) {
    if (_agIsEditableTarget(t)) return false;
    if (!t || (typeof document !== 'undefined' && (t === document || t === document.body || t === document.documentElement))) return true;
    var tag = String(t.tagName || '').toUpperCase();
    return tag === 'BODY' || tag === 'HTML' || _agIsInChatScroller(t);
}
// S2: only gestures on/inside #messages (incl. its scroll bar, whose
// pointerdown targets #messages itself) can scroll the chat.
function _agIsInChatScroller(t) {
    if (!t || typeof document === 'undefined') return false;
    var c = document.getElementById('messages');
    if (!c) return false;
    return t === c || (typeof c.contains === 'function' && c.contains(t));
}
function _agClearPointerHeld() {
    _agPointerHeld = false;
    if (_agPointerHeldTimer) { clearTimeout(_agPointerHeldTimer); _agPointerHeldTimer = null; }
}
function _agArmPointerHeldTimer() {
    if (_agPointerHeldTimer) clearTimeout(_agPointerHeldTimer);
    _agPointerHeldTimer = setTimeout(function() { _agPointerHeldTimer = null; _agPointerHeld = false; }, POINTER_HELD_MAX_MS);
}
if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    ['wheel', 'touchmove'].forEach(function(t) {
        document.addEventListener(t, function(e) {
            if (e && _agIsInChatScroller(e.target)) _agMarkUserScrollIntent();
        }, { capture: true, passive: true });
    });
    // Only keys that can scroll — ordinary typing in the composer must not
    // open the release window (a layout shift while typing would drop follow).
    document.addEventListener('keydown', function(e) {
        if (e && SCROLL_INTENT_KEYS[e.key] && _agIsChatKeyTarget(e.target)) _agMarkUserScrollIntent();
    }, { capture: true, passive: true });
    document.addEventListener('pointerdown', function(e) {
        if (!e || !_agIsInChatScroller(e.target)) return;
        _agPointerHeld = true;
        _agMarkUserScrollIntent();
        _agArmPointerHeldTimer();
    }, { capture: true, passive: true });
    document.addEventListener('pointermove', function() {
        if (_agPointerHeld) _agArmPointerHeldTimer();
    }, { capture: true, passive: true });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function(t) {
        document.addEventListener(t, function() {
            if (!_agPointerHeld) return;
            _agClearPointerHeld();
            _agMarkUserScrollIntent();
        }, { capture: true, passive: true });
    });
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') _agClearPointerHeld();
    });
}
if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    // Pointer released outside the window never delivers pointerup.
    window.addEventListener('blur', _agClearPointerHeld);
    // S5: a viewport resize changes the distance to the bottom.
    window.addEventListener('resize', function() { updateScrollToBottomButton(); });
}

// ── Scroll-to-bottom button (#scroll-to-bottom-btn, body.html) ──────────────
// Visible only while the viewed chat is NOT following and sits more than
// SCROLL_BTN_THRESHOLD px above its bottom; hidden at the bottom.
var SCROLL_BTN_THRESHOLD = 40;
function updateScrollToBottomButton() {
    if (typeof document === 'undefined') return;
    var btn = document.getElementById('scroll-to-bottom-btn');
    var c = document.getElementById('messages');
    if (!btn || !c) return;
    var dist = c.scrollHeight - c.scrollTop - c.clientHeight;
    // The live streaming box scrolls on its own: being scrolled up inside it
    // also counts as "away from the bottom".
    var s = c.querySelector ? c.querySelector('.streaming-answer') : null;
    if (s) dist = Math.max(dist, s.scrollHeight - s.scrollTop - s.clientHeight);
    _agSetScrollBtnVisible(btn, !stickToBottom && dist > SCROLL_BTN_THRESHOLD);
}
function _agSetScrollBtnVisible(btn, show) {
    btn.classList.toggle('visible', show);
    btn.setAttribute('aria-hidden', show ? 'false' : 'true');
    btn.tabIndex = show ? 0 : -1;
}

// S3: deliberate navigation to a spot in the chat (search hit, tool-call /
// version jump, scrollToWidget) — stop following so the next streaming pin
// doesn't yank the user back down. Pass the navigation target: targets
// outside #messages (overlay views) leave the chat's follow state alone.
function releaseChatFollow(target) {
    if (typeof document === 'undefined') return false;
    var c = document.getElementById('messages');
    if (target && c && typeof c.contains === 'function' && !c.contains(target)) return false;
    stickToBottom = false;
    updateScrollToBottomButton();
    return true;
}

// Button click: re-engage follow and glide to the bottom. The glide's scroll
// events only move DOWN (never release); a streaming tick mid-glide simply
// lands the instant pin at the same bottom.
function scrollChatToBottom() {
    var c = document.getElementById('messages');
    if (!c) return;
    stickToBottom = true;
    var s = c.querySelector('.streaming-answer');
    if (s) pinToBottom(s);
    if (typeof c.scrollTo === 'function') c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    else pinToBottom(c);
    updateScrollToBottomButton();
    // S8: the button just hid (tabIndex -1) — don't leave focus on it.
    var btn = document.getElementById('scroll-to-bottom-btn');
    if (btn && document.activeElement === btn) {
        var inp = document.getElementById('message-input');
        if (inp && typeof inp.focus === 'function') inp.focus({ preventScroll: true });
        else if (typeof btn.blur === 'function') btn.blur();
    }
}

// S7: debounced per-chat scroll-position save. The chat id and position are
// captured when the save is SCHEDULED (reading currentChatId when the timer
// fired filed the old chat's position under a chat opened in between); a
// pending save for another chat is flushed first, never dropped.
var CHAT_SCROLL_SAVE_MS = 200;
var _agScrollSave = null;
var _agScrollSaveTimer = null;
function flushChatScrollSave() {
    if (_agScrollSaveTimer) { clearTimeout(_agScrollSaveTimer); _agScrollSaveTimer = null; }
    var p = _agScrollSave;
    _agScrollSave = null;
    if (p && typeof appStorage !== 'undefined' && appStorage) appStorage.setItem('scrollPos_' + p.id, p.top);
}
function scheduleChatScrollSave(chatId, top) {
    if (!chatId) return;
    if (_agScrollSave && _agScrollSave.id !== chatId) flushChatScrollSave();
    _agScrollSave = { id: chatId, top: top };
    if (_agScrollSaveTimer) clearTimeout(_agScrollSaveTimer);
    _agScrollSaveTimer = setTimeout(flushChatScrollSave, CHAT_SCROLL_SAVE_MS);
}
// Chat deletion: drop a pending save so it can't recreate the removed key.
function cancelChatScrollSave(chatId) {
    if (_agScrollSave && _agScrollSave.id === chatId) {
        _agScrollSave = null;
        if (_agScrollSaveTimer) { clearTimeout(_agScrollSaveTimer); _agScrollSaveTimer = null; }
    }
}

// Chat switch: scroll state is per chat. The newly opened chat starts
// following (lands at its bottom once renderMessages pins), and the shared
// #messages element forgets the PREVIOUS chat's last scrollTop so the first
// scroll event of the new chat is never compared against it.
function resetChatScrollForSwitch(chatId) {
    flushChatScrollSave(); // S7: persist the previous chat's position now
    stickToBottomByChatId[chatId || '_'] = true;
    var c = (typeof document !== 'undefined') ? document.getElementById('messages') : null;
    if (c) c._agLastScrollTop = undefined;
    // S4: this runs BEFORE currentChatId switches, so updateScrollToBottomButton
    // would read the PREVIOUS chat's flag. The new chat starts following →
    // hide directly; renderMessages refreshes once the new chat is current.
    var btn = (typeof document !== 'undefined') ? document.getElementById('scroll-to-bottom-btn') : null;
    if (btn) _agSetScrollBtnVisible(btn, false);
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
        else updateScrollToBottomButton(); // S5: growth moves the bottom away
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
    // MSG-EVICT: a skeleton (messages dropped) has nothing to paint.
    if (!chat || !Array.isArray(chat.messages)) return;
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
        if (!stickToBottom) { updateScrollToBottomButton(); return; } // user scrolled up — never fight them
        pinToBottom(container);
        if (streamingEl) pinToBottom(streamingEl);
        updateScrollToBottomButton();
    });
}
