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
// Create and configure the #streaming-text container element
function createStreamingTextEl() {
    var el = document.createElement('div');
    el.id = 'streaming-text';
    el.className = 'streaming-answer';
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
    var el = document.getElementById('streaming-text');
    if (!el) {
        var container = document.getElementById('messages');
        if (!container) return;
        el = createStreamingTextEl();
        container.appendChild(el);
    }
    var chat = chats[currentChatId];
    if (!chat) return;
    // Find last user message to scope to current response
    var lastUserIdx = -1;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        if (chat.messages[i].role === 'user') { lastUserIdx = i; break; }
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
        updateStreamingContainerHeight();
        if (isFollowingStreamingScroll) {
            streamingEl.scrollTop = streamingEl.scrollHeight;
        }
        return;
    }

    // For non-streaming: only scroll if user is following and hasn't scrolled recently
    if (!isFollowingScroll) return;
    if (Date.now() - lastUserScrollTime < SCROLL_DEBOUNCE_MS) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}
