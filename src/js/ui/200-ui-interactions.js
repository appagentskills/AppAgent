// Set up IntersectionObserver to add/remove stuck class
function setupStickyObserver(details) {
    var summary = details.querySelector('summary');
    if (!summary) return;
    
    var scrollContainer = details.closest('.messages');
    if (!scrollContainer) return;
    
    // Clean up existing observer
    if (details._stickyObserver) {
        details._stickyObserver.disconnect();
    }
    
    // Create sentinel element at the top of details
    var sentinel = details.querySelector('.sticky-sentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.className = 'sticky-sentinel';
        sentinel.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; height: 1px; pointer-events: none;';
        details.style.position = 'relative';
        details.insertBefore(sentinel, details.firstChild);
    }
    
    var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
            // When sentinel is not visible (scrolled past), header should be stuck
            if (!entry.isIntersecting) {
                details.classList.add('stuck');
            } else {
                details.classList.remove('stuck');
            }
        });
    }, {
        root: scrollContainer,
        threshold: 0,
        rootMargin: '0px 0px 0px 0px'
    });
    
    observer.observe(sentinel);
    details._stickyObserver = observer;
    _stickyObservers.push({ details: details, observer: observer });
}

// FIX6: registry of live sticky observers. Full renders (and the per-tick
// streaming row rebuild in _updateStreamingMessageNow) discard expanded tool
// panels via innerHTML WITHOUT disconnecting their IntersectionObservers —
// the per-node details._stickyObserver handle dies with the node, but the
// observer itself (and its closure over details + sentinel) stays registered
// with the browser, leaking one observer + sentinel per expanded panel per
// render. Every observer setupStickyObserver creates is registered above;
// sweepStickyObservers() — called from the render paths in
// 250-message-render.js — disconnects entries whose details node was
// discarded (no longer connected) or whose observer was replaced by a newer
// setupStickyObserver / toggleToolExpand collapse (handle mismatch).
var _stickyObservers = [];
function sweepStickyObservers() {
    var kept = [];
    for (var i = 0; i < _stickyObservers.length; i++) {
        var rec = _stickyObservers[i];
        if (rec.details.isConnected && rec.details._stickyObserver === rec.observer) {
            kept.push(rec);
        } else {
            rec.observer.disconnect();
        }
    }
    _stickyObservers = kept;
}

// Toggle code block expand/collapse
function toggleCodeBlockExpand(btn, event) {
    event.stopPropagation();
    var wrapper = btn.closest('.code-block-wrapper');
    var pre = wrapper.querySelector('.code-block');
    if (!pre) return;
    
    if (pre.classList.contains('collapsed')) {
        pre.classList.remove('collapsed');
        wrapper.classList.add('expanded');
        btn.textContent = '⤡';
        btn.title = 'Collapse';
    } else {
        pre.classList.add('collapsed');
        wrapper.classList.remove('expanded');
        btn.textContent = '⤢';
        btn.title = 'Expand';
    }
}

// Global store for raw content to copy
window._rawCopyStore = window._rawCopyStore || {};
var _rawCopyId = 0;
function storeRawCopy(content) {
    var id = 'rc-' + (++_rawCopyId);
    window._rawCopyStore[id] = content;
    return id;
}

// GC for the rc-N entries minted by storeRawCopy(). Every full renderMessages
// rebuild mints FRESH rc-N keys for every tool-args panel / tool result /
// code fence, and nothing ever deleted the previous render's entries — with
// live sub-agent cards repainting on every progress tick, the store grew
// without bound for the lifetime of the page. We cannot simply reset the
// store at the start of a render: formatContent() (which mints rc-N keys for
// code fences) is also used by surfaces whose DOM survives renderMessages —
// action-button outputs (120-actions.js), the skill asset viewer
// (010-skills-ui.js), the dashboard chat preview (070-dashboard-ui.js), the
// document body view (120-init.js) — and resetting would break their copy
// buttons. Instead, sweep: drop every rc-N entry whose data-copy-id consumer
// is no longer anywhere in the document. FIX5: sub-report cards use stable
// 'sub:'-prefixed keys (175-sub-agent-ui.js) — stable means a LIVE card
// re-mints the SAME key on every repaint (no per-repaint growth), but keys
// whose card left the DOM for good (chat switched away, chat/message
// deleted) were never deleted and accumulated across chats for the page
// lifetime. Sweep them by the same DOM-liveness rule as rc-N: a swept key is
// harmless because re-rendering the card re-mints it (_storeSubRawCopy runs
// on every renderSubReport). Worst case (a temporarily detached node
// re-attached later) copyCodeBlock() falls back to the wrapper's
// textContent, so copy still works.
function gcRawCopyStore() {
    var store = window._rawCopyStore;
    if (!store) return;
    var live = Object.create(null);
    var nodes = document.querySelectorAll('[data-copy-id]');
    for (var i = 0; i < nodes.length; i++) {
        live[nodes[i].getAttribute('data-copy-id')] = true;
    }
    var keys = Object.keys(store);
    for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if ((key.indexOf('rc-') === 0 || key.indexOf('sub:') === 0) && !live[key]) delete store[key];
    }
}

// FIX1: throttled variant for STREAMING repaints. updateStreamingText
// (core/050-streaming.js) re-runs formatContent() on every rAF tick — each
// call mints fresh rc-N entries for every code fence while the innerHTML
// swap orphans the previous tick's — and _updateStreamingMessageNow's row
// rebuild does the same for tool-args panels. gcRawCopyStore only ran at the
// end of full renderMessages, so on long code-heavy streams the store grew
// quadratically between renders. Sweeping on a throttle bounds the orphan
// window to ~1.5s of ticks without paying the document-wide query per tick.
var _rcGcLastSweep = 0;
function gcRawCopyStoreThrottled() {
    var now = Date.now();
    if (now - _rcGcLastSweep < 1500) return;
    _rcGcLastSweep = now;
    gcRawCopyStore();
}

// Copy code block content - get raw text without formatting
function copyCodeBlock(btn, event) {
    event.stopPropagation();
    var wrapper = btn.closest('.code-block-wrapper') || btn.closest('.tool-args-wrapper') || btn.closest('.tool-result-wrapper');
    if (!wrapper) return;
    
    var text = '';
    // Check if wrapper has raw copy ID
    var copyId = wrapper.getAttribute('data-copy-id');
    if (copyId && window._rawCopyStore[copyId]) {
        text = window._rawCopyStore[copyId];
    } else {
        // Fallback: get text content
        var code = wrapper.querySelector('code') || wrapper.querySelector('pre');
        if (code) text = code.textContent || code.innerText;
    }
    
    navigator.clipboard.writeText(text).then(function() {
        showSnackbar('Copied to clipboard', 'success');
    });
}
