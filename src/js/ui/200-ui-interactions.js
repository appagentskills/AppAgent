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
        btn.title = t('Collapse');
    } else {
        pre.classList.add('collapsed');
        wrapper.classList.remove('expanded');
        btn.textContent = '⤢';
        btn.title = t('Expand');
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
    var quote = (btn.classList && typeof btn.classList.contains === 'function' && btn.classList.contains('quote-copy-btn')) ? btn.closest('.md-quote-wrapper') : null;
    var wrapper = quote || btn.closest('.code-block-wrapper') || btn.closest('.tool-args-wrapper') || btn.closest('.tool-result-wrapper');
    if (!wrapper) return;
    
    var text = '';
    var richHtml = null; // quotes only: text/html flavour of the copy
    // Check if wrapper has raw copy ID
    var copyId = quote ? null : wrapper.getAttribute('data-copy-id');
    if (quote) {
        var bq = quote.querySelector('blockquote');
        text = bq ? _quotePlainText(bq) : '';
        richHtml = bq ? _quoteRichHtml(bq) : null;
    } else if (copyId && Object.prototype.hasOwnProperty.call(window._rawCopyStore, copyId)) {
        text = window._rawCopyStore[copyId];
    } else {
        // Fallback: get text content
        var code = wrapper.querySelector('code') || wrapper.querySelector('pre');
        if (code) text = code.textContent || code.innerText;
    }
    
    // Chat code blocks (.code-copy-btn) confirm inline (check icon + "Copied"
    // for ~1.5s); the other copy buttons keep the snackbar confirmation.
    var inline = !!(btn && btn.classList && typeof btn.classList.contains === 'function' && btn.classList.contains('code-copy-btn'));
    function done() {
        if (inline) _markCodeCopied(btn);
        else showSnackbar(t('Copied to clipboard'), 'success', undefined, { transient: true });
    }
    function fail() {
        // Bug-sweep F3: clipboard write can reject (no focus / permission denied).
        // Try the legacy execCommand path before reporting failure.
        if (_copyTextFallback(text)) done();
        else showSnackbar(t('Copy failed'), 'error');
    }
    function writePlain() {
        if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            fail();
            return;
        }
        navigator.clipboard.writeText(text).then(done).catch(fail);
    }
    // Quotes: write text/html + text/plain in one ClipboardItem so rich
    // editors (Docs, Word, Gmail, Slack) keep the formatting; any missing API
    // or rejection degrades to writeText(plain), then to execCommand.
    if (richHtml !== null) {
        var win = typeof window !== 'undefined' ? window : null;
        var CI = win && win.ClipboardItem, B = win && win.Blob;
        if (typeof CI === 'function' && typeof B === 'function' && typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.write === 'function') {
            var p = null;
            try {
                p = navigator.clipboard.write([new CI({
                    'text/html': new B([richHtml], { type: 'text/html' }),
                    'text/plain': new B([text], { type: 'text/plain' })
                })]);
            } catch (e) { p = null; }
            if (p && typeof p.then === 'function') { p.then(done, writePlain); return; }
        }
    }
    writePlain();
}

// Raw text of a code block rendered inside a quote (the expand/copy
// buttons and highlight spans are not part of it).
function _quoteCodeText(wrapper) {
    var id = wrapper.getAttribute && wrapper.getAttribute('data-copy-id');
    var store = (typeof window !== 'undefined' && window._rawCopyStore) || {};
    if (id && Object.prototype.hasOwnProperty.call(store, id)) return String(store[id]);
    var code = wrapper.querySelector('pre') || wrapper.querySelector('code');
    return code ? code.textContent : '';
}

// Ordered-list number of an <li>: the <ol start> plus its index.
function _quoteListMarker(li) {
    var list = li.parentNode;
    if (!list || !list.tagName || list.tagName.toLowerCase() !== 'ol') return '- ';
    var n = parseInt(list.getAttribute('start'), 10);
    if (!isFinite(n)) n = 1;
    for (var s = li.previousSibling; s; s = s.previousSibling) if (s.nodeType === 1 && s.tagName.toLowerCase() === 'li') n++;
    return n + '. ';
}

// Plain text of a rendered blockquote, keeping its formatting structure:
// tabs / indentation / space runs, single line breaks (<br>), a blank line
// between paragraphs/blocks, list markers (`- ` / `1. `, nested items
// indented under their parent), `[x] ` task boxes, `> ` before nested
// quote lines, tab-separated table cells and code blocks verbatim. Controls
// (copy/expand buttons, icons) are skipped; the outer `>` never reaches the DOM.
function _quotePlainText(el) {
    var out = '';
    var prefix = ''; // written at the start of every non-empty line
    var listDepth = 0;
    var BLOCK = /^(p|div|pre|blockquote|ul|ol|table|h[1-6]|hr)$/;
    function atLineStart() { return !out || out.charAt(out.length - 1) === '\n'; }
    function nl(n) {
        if (!out) return;
        if (listDepth > 0 && n > 1) n = 1; // tight inside list items
        var have = /\n*$/.exec(out)[0].length;
        while (have < n) { out += '\n'; have++; }
    }
    function write(s) {
        var parts = String(s).split('\n');
        for (var i = 0; i < parts.length; i++) {
            if (i > 0) out += '\n';
            if (parts[i] && atLineStart()) out += prefix;
            out += parts[i];
        }
    }
    function kids(node) { for (var c = node.firstChild; c; c = c.nextSibling) walk(c); }
    function walk(node) {
        if (node.nodeType === 3) { write(node.nodeValue); return; }
        if (node.nodeType !== 1) return;
        var tag = node.tagName.toLowerCase();
        if (tag === 'button' || tag === 'svg' || tag === 'script' || tag === 'style') return;
        if (tag === 'input') { if (node.type === 'checkbox') write(node.checked ? '[x] ' : '[ ] '); return; }
        if (tag === 'br') { out += '\n'; return; }
        var cls = node.classList;
        if (cls && cls.contains('code-block-wrapper')) {
            nl(2); write(_quoteCodeText(node).replace(/\n+$/, '')); nl(2);
            return;
        }
        var saved = prefix;
        if (tag === 'li') {
            nl(1);
            var marker = _quoteListMarker(node);
            out += prefix + marker;
            prefix = prefix + new Array(marker.length + 1).join(' ');
            listDepth++;
            kids(node);
            listDepth--;
            prefix = saved;
            nl(1);
            return;
        }
        if (tag === 'ul' || tag === 'ol') {
            if (listDepth > 0) { nl(1); kids(node); nl(1); }
            else { nl(2); kids(node); nl(2); }
            return;
        }
        if (tag === 'blockquote') {
            nl(2); prefix = prefix + '> '; kids(node); prefix = saved; nl(2);
            return;
        }
        var block = BLOCK.test(tag) || (cls && cls.contains('md-paragraph'));
        var line = tag === 'tr';
        if ((tag === 'td' || tag === 'th') && !atLineStart()) out += '\t';
        if (block) nl(2); else if (line) nl(1);
        kids(node);
        if (block) nl(2); else if (line) nl(1);
    }
    kids(el);
    // Keep the first line's indentation: strip only leading newlines.
    return out.replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

// Rich (text/html) clipboard flavour of a rendered blockquote: a clean,
// self-contained fragment with only semantic tags (b/i/s/u, a with an
// absolute http(s)/mailto href, code/pre in monospace, p/br, ul/ol/li,
// headings, tables, nested blockquote) and minimal inline styles. No app
// classes, data attributes, buttons or icons. Tabs become two em spaces and
// runs of spaces become no-break spaces so indentation survives pasting into
// Google Docs, Word, Gmail and Slack (which ignore or strip white-space CSS).
function _quoteRichHtml(el) {
    var MONO = 'font-family:Consolas,Menlo,Monaco,\'Courier New\',monospace;';
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function txt(s) {
        return esc(s).replace(/\t/g, '&emsp;&emsp;')
            .replace(/ {2,}/g, function(r) { return new Array(r.length + 1).join('&nbsp;'); })
            .replace(/^ /, '&nbsp;');
    }
    function kids(node) { var s = ''; for (var c = node.firstChild; c; c = c.nextSibling) s += walk(c); return s; }
    function walk(node) {
        if (node.nodeType === 3) return txt(node.nodeValue);
        if (node.nodeType !== 1) return '';
        var tag = node.tagName.toLowerCase();
        if (/^(button|svg|script|style|img|template)$/.test(tag)) return '';
        if (tag === 'input') return node.type === 'checkbox' ? (node.checked ? '&#9745; ' : '&#9744; ') : '';
        var cls = node.classList;
        if (cls && cls.contains('code-block-wrapper')) {
            return '<pre style="' + MONO + 'white-space:pre-wrap;margin:0 0 1em">' + esc(_quoteCodeText(node).replace(/\n+$/, '')) + '</pre>';
        }
        if (cls && cls.contains('md-paragraph')) return '<p style="margin:0 0 1em">' + kids(node) + '</p>';
        switch (tag) {
            case 'br': return '<br>';
            case 'strong': case 'b': return '<b>' + kids(node) + '</b>';
            case 'em': case 'i': return '<i>' + kids(node) + '</i>';
            case 'del': case 's': case 'strike': return '<s>' + kids(node) + '</s>';
            case 'u': return '<u>' + kids(node) + '</u>';
            case 'code': return '<code style="' + MONO + '">' + txt(node.textContent) + '</code>';
            case 'pre': return '<pre style="' + MONO + 'white-space:pre-wrap;margin:0 0 1em">' + esc(node.textContent) + '</pre>';
            case 'a':
                var href = node.href || node.getAttribute('href') || '';
                return /^(https?:|mailto:)/i.test(href) ? '<a href="' + esc(href) + '">' + kids(node) + '</a>' : kids(node);
            case 'ul': return '<ul>' + kids(node) + '</ul>';
            case 'ol':
                var start = parseInt(node.getAttribute('start'), 10);
                return (isFinite(start) && start !== 1 ? '<ol start="' + start + '">' : '<ol>') + kids(node) + '</ol>';
            case 'li': return '<li>' + kids(node) + '</li>';
            case 'blockquote': return '<blockquote style="margin:0 0 1em 0;padding-left:12px;border-left:3px solid #ccc">' + kids(node) + '</blockquote>';
            case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
                return '<' + tag + '>' + kids(node) + '</' + tag + '>';
            case 'hr': return '<hr>';
            case 'table': return '<table style="border-collapse:collapse">' + kids(node) + '</table>';
            case 'thead': case 'tbody': case 'tr': return '<' + tag + '>' + kids(node) + '</' + tag + '>';
            case 'td': case 'th': return '<' + tag + ' style="border:1px solid #ccc;padding:2px 6px">' + kids(node) + '</' + tag + '>';
            default: return kids(node);
        }
    }
    return '<meta charset="utf-8"><div>' + kids(el) + '</div>';
}

// Swap the copy icon for a check + "Copied" label, then restore. Idempotent:
// a second click while already in the copied state just restarts the timer.
function _markCodeCopied(btn) {
    if (!btn._copyOrig) {
        btn._copyOrig = { html: btn.innerHTML, label: btn.getAttribute('aria-label'), title: btn.getAttribute('title') };
    }
    var orig = btn._copyOrig;
    btn.classList.add('copied');
    btn.innerHTML = UI_ICONS.check + '<span class="code-copy-label">' + escapeHtml(t('Copied')) + '</span>';
    btn.setAttribute('aria-label', t('Copied'));
    btn.setAttribute('title', t('Copied'));
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(function() {
        btn.classList.remove('copied');
        btn.innerHTML = orig.html;
        if (orig.label != null) btn.setAttribute('aria-label', orig.label); else btn.removeAttribute('aria-label');
        if (orig.title != null) btn.setAttribute('title', orig.title); else btn.removeAttribute('title');
        btn._copyOrig = null;
    }, 1500);
}

// Legacy clipboard path (no async Clipboard API / permission denied).
// Returns true only when the browser reports the copy succeeded.
function _copyTextFallback(text) {
    if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false;
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    var prevFocus = document.activeElement;
    document.body.appendChild(ta);
    var ok = false;
    try {
        ta.select();
        ok = document.execCommand('copy') === true;
    } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (prevFocus && typeof prevFocus.focus === 'function') { try { prevFocus.focus(); } catch (e2) {} }
    return ok;
}
