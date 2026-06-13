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
// is no longer anywhere in the document. Sub-report cards use stable
// 'sub:'-prefixed keys (175-sub-agent-ui.js) and are not touched. Worst case
// (a temporarily detached node re-attached later) copyCodeBlock() falls back
// to the wrapper's textContent, so copy still works.
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
        if (keys[k].indexOf('rc-') === 0 && !live[keys[k]]) delete store[keys[k]];
    }
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
