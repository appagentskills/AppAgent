// AppAgent Chrome Extension - Content Script
// Injected programmatically by background.js into confirmed ServiceNow tabs only
// Handles browser actions (click, fill, scroll, etc.) and console/network interceptors

(function() {
    'use strict';

    // Guard against double-injection (onTabReady + handleNavigate both inject on SN pages)
    if (window.__appagentContentScriptInjected) return;
    window.__appagentContentScriptInjected = true;

    // --- Console & network data ---
    var consoleLogs = [];
    var networkRequests = [];

    // --- Browser action handlers ---
    chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
        if (msg.type !== 'browser-action') return;

        var doc = document;

        // Handle gsft_main nesting (ServiceNow wraps main content in nested iframe)
        var gsftMain = doc.getElementById('gsft_main');
        if (gsftMain) {
            try { doc = gsftMain.contentDocument || doc; } catch(e) { /* cross-origin */ }
        }

        switch(msg.action) {
            case 'viewport_emulate':
                handleViewportEmulate(msg.args || {}, sendResponse);
                break;

            case 'get_visible_text':
                handleGetVisibleText(doc, msg.args || {}, sendResponse);
                break;

            case 'get_dom':
                var maxLen = (msg.args && msg.args.max_length) || 50000;
                var domSelector = msg.args && msg.args.selector;
                if (domSelector) {
                    var matchIdx = (msg.args && typeof msg.args.match_index === 'number') ? msg.args.match_index : -1;
                    var allDomMatches;
                    try { doc.querySelectorAll(domSelector); } catch(selectorErr) {
                        sendResponse({ success: false, error: 'Invalid CSS selector: ' + domSelector + ' (' + selectorErr.message + ')' });
                        break;
                    }
                    // Pierce shadow DOM + iframes so match_count / match_index reflect components
                    // inside Seismic / Now Experience shadow roots, not just the light DOM.
                    allDomMatches = queryAllDeep(doc, domSelector);
                    var domMatchCount = allDomMatches.length;
                    var domEl;
                    if (matchIdx >= 0) {
                        domEl = allDomMatches[matchIdx] || null;
                    } else {
                        // Default: check top-layer modals first, then fall back to first match
                        domEl = findElement(doc, domSelector);
                    }
                    if (!domEl) {
                        sendResponse({ success: false, error: 'Element not found: ' + domSelector + (matchIdx >= 0 ? ' (match_index=' + matchIdx + ', total matches: ' + domMatchCount + ')' : ''), match_count: domMatchCount });
                    } else {
                        var elHtml = domEl.outerHTML;
                        if (elHtml.length > maxLen) elHtml = elHtml.substring(0, maxLen) + '\n... [truncated]';
                        sendResponse({ success: true, html: elHtml, match_count: domMatchCount });
                    }
                } else {
                    sendResponse({ success: true, html: doc.documentElement.outerHTML.substring(0, maxLen) });
                }
                break;

            case 'click':
                handleClick(doc, msg.args, sendResponse);
                break;

            case 'fill':
                handleFill(doc, msg.args, sendResponse);
                return true;
            case 'type':
                handleType(doc, msg.args, sendResponse);
                return true;
            case 'wait_for':
                handleWaitFor(doc, msg.args, sendResponse);
                return true;

            case 'scroll':
                handleScroll(doc, msg.args, sendResponse);
                break;

            case 'dispatch_event':
                handleDispatchEvent(doc, msg.args, sendResponse);
                break;

            case 'select_option':
                handleSelectOption(doc, msg.args, sendResponse);
                break;

            case 'get_properties':
                handleGetProperties(doc, msg.args, sendResponse);
                break;

            case 'set_style':
                handleSetStyle(doc, msg.args, sendResponse);
                break;

            case 'go_back':
                window.history.back();
                sendResponse({ success: true });
                break;

            case 'go_forward':
                window.history.forward();
                sendResponse({ success: true });
                break;

            case 'reload':
                window.location.reload();
                sendResponse({ success: true });
                break;

            case 'get_page_info':
                var pageUrl = window.location.href;
                if (gsftMain) { try { pageUrl = gsftMain.contentWindow.location.href; } catch(e) {} }
                sendResponse({ success: true, url: pageUrl, title: document.title, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
                break;

            case 'get_console_logs':
                sendResponse({ success: true, logs: consoleLogs.splice(0) });
                break;

            case 'get_network_requests':
                sendResponse({ success: true, requests: networkRequests.splice(0) });
                break;

            default:
                sendResponse({ error: 'Unknown action: ' + msg.action });
        }

        return true; // Keep channel open for async
    });

    // --- Action handlers ---

    // Viewport emulation via CSS (for when window can't resize small enough)
    function handleViewportEmulate(args, sendResponse) {
        var styleId = '__appagent_viewport_emulate';
        var existing = document.getElementById(styleId);
        if (!args.enable) {
            // Remove emulation
            if (existing) existing.remove();
            sendResponse({ success: true, message: 'Viewport emulation removed' });
            return;
        }
        var w = args.width || 375;
        var css = 'html { max-width: ' + w + 'px !important; margin: 0 auto !important; overflow-x: hidden !important; } ' +
                  'body { max-width: ' + w + 'px !important; overflow-x: hidden !important; }';
        if (existing) {
            existing.textContent = css;
        } else {
            var style = document.createElement('style');
            style.id = styleId;
            style.textContent = css;
            document.head.appendChild(style);
        }
        // Also apply to gsft_main if present
        try {
            var gsft = document.getElementById('gsft_main');
            if (gsft && gsft.contentDocument) {
                var gDoc = gsft.contentDocument;
                var gExisting = gDoc.getElementById(styleId);
                if (gExisting) {
                    gExisting.textContent = css;
                } else {
                    var gStyle = gDoc.createElement('style');
                    gStyle.id = styleId;
                    gStyle.textContent = css;
                    gDoc.head.appendChild(gStyle);
                }
            }
        } catch(e) { /* cross-origin */ }
        sendResponse({ success: true, message: 'Viewport emulated at ' + w + 'px via CSS' });
    }

    // Find the topmost open modal/dialog/overlay and search inside it first.
    // This ensures click/fill/select actions target visible modal elements
    // instead of matching elements hidden behind the overlay.
    function findTopLayerMatch(doc, selector) {
        try {
            // Check for native <dialog> elements first (highest specificity)
            var dialogs = doc.querySelectorAll('dialog[open]');
            for (var i = dialogs.length - 1; i >= 0; i--) {
                var el = dialogs[i].querySelector(selector);
                if (el) return el;
            }
            // Check common modal/overlay patterns (last match = highest z-index)
            var modalSelectors = [
                '.modal.in', '.modal.show', '.modal.fade.in', '.modal.fade.show',  // Bootstrap
                '[role="dialog"]:not([aria-hidden="true"])',                        // ARIA dialogs
                '.modal-overlay', '.sn-modal-overlay', '.glide-modal',             // ServiceNow-specific
                '.overlay.active', '.popup.visible',                               // Generic
                '.cdk-overlay-container'                                            // Angular CDK
            ];
            for (var s = 0; s < modalSelectors.length; s++) {
                var modals = doc.querySelectorAll(modalSelectors[s]);
                for (var m = modals.length - 1; m >= 0; m--) {
                    var match = modals[m].querySelector(selector);
                    if (match) return match;
                }
            }
        } catch(e) {}
        return null;
    }

    function findElement(doc, selector) {
        // Check top-layer modals/dialogs first to prefer visible foreground elements
        var topLayer = findTopLayerMatch(doc, selector);
        if (topLayer) return topLayer;

        try {
            var el = doc.querySelector(selector);
            if (el) return el;
        } catch(e) {
            // Invalid CSS selector — return null (caller will report error)
            return null;
        }

        // Search iframes recursively
        var iframes = doc.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
            try {
                var iframeDoc = iframes[i].contentDocument;
                if (iframeDoc) {
                    el = findElement(iframeDoc, selector);
                    if (el) return el;
                }
            } catch(e) { /* cross-origin */ }
        }

        // Search shadow DOMs
        try {
            var allEls = doc.querySelectorAll('*');
            for (var j = 0; j < allEls.length; j++) {
                if (allEls[j].shadowRoot) {
                    var shadowEl = findElement(allEls[j].shadowRoot, selector);
                    if (shadowEl) return shadowEl;
                }
            }
        } catch(e) {}
        return null;
    }

    // Shadow- and iframe-piercing variant of querySelectorAll: collects EVERY match across the
    // light DOM, same-origin nested iframes, and OPEN shadow roots. Seismic / Now Experience
    // workspace forms render all controls inside nested open shadow roots, so plain
    // querySelectorAll (light DOM only) reports match_count 0 for real components. Mirrors
    // findElement's traversal but returns ALL matches, so get_dom / get_properties / set_style get
    // a truthful match_count and can address deep matches by match_index. Invalid selectors are
    // swallowed here; callers validate the selector once up front to still surface a syntax error.
    function queryAllDeep(root, selector) {
        var results = [];
        try {
            var direct = root.querySelectorAll(selector);
            for (var i = 0; i < direct.length; i++) results.push(direct[i]);
        } catch(e) { return results; }
        try {
            var iframes = root.querySelectorAll('iframe');
            for (var f = 0; f < iframes.length; f++) {
                try {
                    var idoc = iframes[f].contentDocument;
                    if (idoc) { var inner = queryAllDeep(idoc, selector); for (var k = 0; k < inner.length; k++) results.push(inner[k]); }
                } catch(e) { /* cross-origin */ }
            }
        } catch(e) {}
        try {
            var hosts = root.querySelectorAll('*');
            for (var h = 0; h < hosts.length; h++) {
                if (hosts[h].shadowRoot) { var sh = queryAllDeep(hosts[h].shadowRoot, selector); for (var s = 0; s < sh.length; s++) results.push(sh[s]); }
            }
        } catch(e) {}
        return results;
    }

    // Shadow- and iframe-piercing plain-text extraction for get_visible_text (simple mode) and
    // wait_for(text). element/body.innerText stop at shadow boundaries, so on a Seismic / Now
    // Experience page (content nested in open shadow roots) they return ''. Honors display:none,
    // descends open shadow roots + same-origin iframes, and includes form-control value/placeholder.
    // Slotted light-DOM text is captured once (the <slot> only projects it; the text node lives in
    // light DOM, so walking shadow roots + light children does not double-count it).
    function deepText(node, parts, depth) {
        if (!node || depth > 300) return;
        var type = node.nodeType;
        if (type === 3) {
            var t = node.nodeValue;
            if (t && /\S/.test(t)) parts.push(t.replace(/\s+/g, ' ').trim());
            return;
        }
        if (type !== 1 && type !== 9 && type !== 11) return;
        if (type === 1) {
            var tag = node.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
            try {
                var cs = (node.ownerDocument.defaultView || window).getComputedStyle(node);
                if (cs && cs.display === 'none') return;
            } catch(e) {}
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                var v = node.value;
                if (!v && tag !== 'SELECT') { try { v = node.getAttribute('placeholder'); } catch(e) {} }
                if (v && String(v).trim()) parts.push(String(v).trim());
            }
            if (node.shadowRoot) deepText(node.shadowRoot, parts, depth + 1);
            if (tag === 'IFRAME') {
                try { var fdoc = node.contentDocument; if (fdoc) deepText(fdoc.body || fdoc.documentElement, parts, depth + 1); } catch(e) {}
                return;
            }
        }
        var kids = node.childNodes;
        if (kids) for (var c = 0; c < kids.length; c++) deepText(kids[c], parts, depth + 1);
    }

    // For coordinate-based clicks, find the most specific interactive element at the point
    // Returns { el, snapped, dist } — snapped=true if we used proximity fallback
    function findInteractiveTarget(el, x, y) {
        var interactiveTags = {BUTTON:1, A:1, INPUT:1, SELECT:1, TEXTAREA:1, LABEL:1};
        if (interactiveTags[el.tagName]) return { el: el, snapped: false, dist: 0 };
        if (el.hasAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' ||
            el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'tab' ||
            el.hasAttribute('ng-click') || el.hasAttribute('onclick') || el.hasAttribute('data-action'))) return { el: el, snapped: false, dist: 0 };

        // Search interactive descendants that contain the click point
        var candidates = el.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [ng-click], [onclick]');
        var best = null;
        var bestArea = Infinity;
        for (var i = 0; i < candidates.length; i++) {
            var rect = candidates[i].getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                var area = rect.width * rect.height;
                if (area < bestArea) { bestArea = area; best = candidates[i]; }
            }
        }
        if (best) return { el: best, snapped: false, dist: 0 };

        // Proximity fallback: find closest interactive child within 50px
        var nearest = null;
        var nearestDist = Infinity;
        for (var j = 0; j < candidates.length; j++) {
            var r = candidates[j].getBoundingClientRect();
            // Distance from point to nearest edge of rect
            var dx = Math.max(r.left - x, 0, x - r.right);
            var dy = Math.max(r.top - y, 0, y - r.bottom);
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < nearestDist) { nearestDist = dist; nearest = candidates[j]; }
        }
        if (nearest && nearestDist <= 50) return { el: nearest, snapped: true, dist: Math.round(nearestDist) };
        return { el: el, snapped: false, dist: 0 };
    }

    // Find deepest element at viewport coordinates, drilling into iframes and shadow DOM
    function elementFromPointDeep(doc, x, y) {
        try {
            var el = doc.elementFromPoint(x, y);
            if (!el) return null;
            if (el.tagName === 'IFRAME') {
                try {
                    if (el.contentDocument) {
                        var rect = el.getBoundingClientRect();
                        var inner = elementFromPointDeep(el.contentDocument, x - rect.left, y - rect.top);
                        if (inner) return inner;
                    }
                } catch(e) {}
            }
            if (el.shadowRoot) {
                var inner = elementFromPointDeep(el.shadowRoot, x, y);
                if (inner) return inner;
            }
            return el;
        } catch(e) {}
        return null;
    }

    function handleClick(doc, args, sendResponse) {
        var hasCoords = args.x !== undefined && args.y !== undefined;
        var el = hasCoords ? elementFromPointDeep(document, args.x, args.y) : findElement(doc, args.selector);
        var label = hasCoords ? '(' + args.x + ', ' + args.y + ')' : args.selector;
        if (!el) { sendResponse({ error: 'Element not found: ' + label }); return; }
        // For coordinate-based clicks, prefer the most specific interactive element at the point
        var snappedInfo = null;
        if (hasCoords) {
            var target = findInteractiveTarget(el, args.x, args.y);
            el = target.el;
            if (target.snapped) snappedInfo = { dist: target.dist };
        }
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        var clickedTag = el.tagName.toLowerCase();
        var clickedId = el.id ? '#' + el.id : '';
        var clickedText = (el.textContent || '').trim().substring(0, 80);
        var clickedRect = el.getBoundingClientRect();
        var clickInfo = clickedTag + clickedId;
        if (clickedText) clickInfo += ' "' + clickedText + '"';
        var msg = 'Clicked ' + label + ' -> ' + clickInfo;
        if (snappedInfo) msg += ' (snapped ' + snappedInfo.dist + 'px)';
        sendResponse({
            success: true,
            message: msg,
            element: {
                tag: clickedTag,
                id: el.id || null,
                text: clickedText,
                className: (typeof el.className === 'string' ? el.className : '').trim().substring(0, 200),
                rect: { x: Math.round(clickedRect.x), y: Math.round(clickedRect.y), w: Math.round(clickedRect.width), h: Math.round(clickedRect.height) }
            }
        });
    }

    // Fire the full user-typing event chain so frameworks (React/Angular) and
    // ServiceNow client scripts that listen for keydown/keyup/input/change/blur
    // see the change as if a real user typed it.
    function fireUserInput(el, value) {
        var lastChar = (value && value.length) ? String(value).charAt(String(value).length - 1) : '';
        try { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: lastChar })); } catch(e) {}
        try { el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: lastChar })); } catch(e) {}
        // React-safe value setter: bypass framework property trackers
        try {
            var proto = (el.tagName === 'TEXTAREA') ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        } catch(e) { el.value = value; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: lastChar })); } catch(e) {}
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function handleFill(doc, args, sendResponse) {
        var hasCoords = args.x !== undefined && args.y !== undefined;
        var el = hasCoords ? elementFromPointDeep(document, args.x, args.y) : findElement(doc, args.selector);
        var label = hasCoords ? '(' + args.x + ', ' + args.y + ')' : args.selector;
        if (!el) { sendResponse({ error: 'Element not found: ' + label }); return; }
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        fireUserInput(el, args.value);
        sendResponse({ success: true, message: 'Filled ' + label + ' -> ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') });
    }

    // Per-character typing with realistic key events. Slower but reliably triggers
    // debounced/throttled handlers (autocomplete dropdowns, search-as-you-type).
    function handleType(doc, args, sendResponse) {
        var hasCoords = args.x !== undefined && args.y !== undefined;
        var el = hasCoords ? elementFromPointDeep(document, args.x, args.y) : findElement(doc, args.selector);
        var label = hasCoords ? '(' + args.x + ', ' + args.y + ')' : args.selector;
        if (!el) { sendResponse({ error: 'Element not found: ' + label }); return; }
        var value = String(args.value == null ? '' : args.value);
        var delay = (typeof args.delay === 'number' && args.delay >= 0) ? args.delay : 30;
        var append = !!args.append;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        var proto = (el.tagName === 'TEXTAREA') ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        var setter = (desc && desc.set) || null;
        var current = append ? (el.value || '') : '';
        if (!append) { try { setter ? setter.call(el, '') : (el.value = ''); } catch(e) { el.value = ''; } el.dispatchEvent(new Event('input', { bubbles: true })); }
        var i = 0;
        function typeNext() {
            if (i >= value.length) {
                el.dispatchEvent(new Event('change', { bubbles: true }));
                sendResponse({ success: true, message: 'Typed "' + value + '" into ' + label + ' -> ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') });
                return;
            }
            var ch = value.charAt(i);
            try { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch })); } catch(e) {}
            try { el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: ch })); } catch(e) {}
            current += ch;
            try { setter ? setter.call(el, current) : (el.value = current); } catch(e) { el.value = current; }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch })); } catch(e) {}
            i++;
            if (delay > 0) setTimeout(typeNext, delay); else typeNext();
        }
        typeNext();
    }

    // Wait for a condition to be met. Pure timing primitive — doesn't bypass anything.
    // Conditions: selector_visible, selector_gone, text, url_matches
    function handleWaitFor(doc, args, sendResponse) {
        var timeout = (typeof args.timeout === 'number') ? args.timeout : 10000;
        var pollMs = (typeof args.poll === 'number') ? args.poll : 100;
        var start = Date.now();
        function done(ok, detail) {
            if (ok) sendResponse({ success: true, waited_ms: Date.now() - start, condition: detail });
            else sendResponse({ success: false, error: 'Timed out after ' + timeout + 'ms waiting for: ' + detail, waited_ms: Date.now() - start });
        }
        function check() {
            try {
                if (args.selector_visible) {
                    var v = findElement(doc, args.selector_visible);
                    if (v) {
                        var rect = v.getBoundingClientRect();
                        var visible = rect.width > 0 && rect.height > 0;
                        if (visible) return done(true, 'selector_visible: ' + args.selector_visible);
                    }
                } else if (args.selector_gone) {
                    var g = findElement(doc, args.selector_gone);
                    if (!g) return done(true, 'selector_gone: ' + args.selector_gone);
                    var grect = g.getBoundingClientRect();
                    if (grect.width === 0 && grect.height === 0) return done(true, 'selector_gone: ' + args.selector_gone);
                } else if (args.text) {
                    var _wtParts = [];
                    deepText(doc.body || doc.documentElement || doc, _wtParts, 0);
                    if (_wtParts.join(' ').indexOf(args.text) !== -1) return done(true, 'text: ' + args.text);
                } else if (args.url_matches) {
                    if (location.href.indexOf(args.url_matches) !== -1) return done(true, 'url_matches: ' + args.url_matches);
                } else {
                    return done(false, 'no condition specified (selector_visible, selector_gone, text, or url_matches)');
                }
            } catch(e) {}
            if (Date.now() - start >= timeout) {
                return done(false, args.selector_visible || args.selector_gone || args.text || args.url_matches || 'unknown');
            }
            setTimeout(check, pollMs);
        }
        check();
    }

    // Find the best scrollable container in a document tree
    function findScrollContainer(root) {
        var best = null;
        try {
            var allEls = root.querySelectorAll('*');
            for (var i = 0; i < allEls.length; i++) {
                var el = allEls[i];
                var style = (root.defaultView || window).getComputedStyle(el);
                var ov = style.overflow + ' ' + style.overflowY;
                if ((ov.indexOf('auto') !== -1 || ov.indexOf('scroll') !== -1) && el.scrollHeight > el.clientHeight + 5) {
                    if (!best || el.scrollHeight > best.scrollHeight) best = el;
                }
            }
        } catch(e) {}
        return best;
    }

    // Search all iframes and shadow DOMs for the best scroll target
    function findBestScrollTarget(rootDoc) {
        var st = null;
        (function searchAll(d) {
            try {
                var c = findScrollContainer(d);
                if (c && (!st || c.scrollHeight > st.scrollHeight)) st = c;
                var iframes = d.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                    try { if (iframes[i].contentDocument) searchAll(iframes[i].contentDocument); } catch(e) {}
                }
                var allEls = d.querySelectorAll('*');
                for (var j = 0; j < allEls.length; j++) {
                    if (allEls[j].shadowRoot) searchAll(allEls[j].shadowRoot);
                }
            } catch(e) {}
        })(rootDoc);
        return st;
    }

    function handleScroll(doc, args, sendResponse) {
        var beh = args.behavior || 'instant';

        // Scroll to element by selector
        if (args.selector) {
            var el = findElement(doc, args.selector);
            if (el) {
                el.scrollIntoView({ behavior: beh, block: 'center' });
                // Read scrollTop after a brief delay so the browser has applied the scroll
                // Use findBestScrollTarget to get the actual scrollable container (not just document)
                // NOTE: use setTimeout instead of requestAnimationFrame — rAF doesn't fire in background tabs
                setTimeout(function() {
                    var scrollEl = findBestScrollTarget(doc) || doc.scrollingElement || doc.documentElement || doc.body;
                    sendResponse({ success: true, scrollTop: scrollEl ? scrollEl.scrollTop : 0, scrollHeight: scrollEl ? scrollEl.scrollHeight : 0, message: 'Scrolled to ' + args.selector });
                }, 16);
            } else {
                sendResponse({ error: 'Element not found: ' + args.selector });
            }
            return;
        }

        // Find the best scroll container (searches iframes + shadow DOMs)
        var st = findBestScrollTarget(doc);
        if (!st) st = doc.scrollingElement || doc.documentElement || doc.body;
        if (!st) { sendResponse({ success: false, error: 'No scrollable element found' }); return; }

        var targetTop = (args.position === 'top') ? 0 : (args.position === 'bottom') ? st.scrollHeight : (args.y != null ? args.y : undefined);
        if (targetTop !== undefined) {
            st.scrollTo({ top: targetTop, left: args.x || st.scrollLeft, behavior: beh });
        } else if (args.x != null) {
            st.scrollTo({ top: st.scrollTop, left: args.x, behavior: beh });
        }

        // Read scrollTop after a brief delay so the browser has applied the scroll
        // NOTE: use setTimeout instead of requestAnimationFrame — rAF doesn't fire in background tabs
        setTimeout(function() {
            sendResponse({ success: true, scrollTop: st.scrollTop, scrollHeight: st.scrollHeight, message: 'Scrolled' });
        }, 16);
    }

    function handleDispatchEvent(doc, args, sendResponse) {
        if (!args.event) {
            sendResponse({ error: 'event is required for dispatch_event action' });
            return;
        }
        // Allowlist parity with the in-page twin (010-iframe-tool.js) and the tool schema enum:
        // reject unknown event types up front instead of silently dispatching a generic Event.
        var ALLOWED_EVENTS = ['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'contextmenu', 'change', 'input', 'focus', 'blur', 'submit', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'keydown', 'keyup'];
        if (ALLOWED_EVENTS.indexOf(args.event) === -1) {
            sendResponse({ error: 'Event "' + args.event + '" not allowed. Allowed: ' + ALLOWED_EVENTS.join(', ') });
            return;
        }
        var el = findElement(doc, args.selector);
        if (!el) {
            sendResponse({ error: 'Element not found: ' + args.selector });
            return;
        }
        var evt;
        var MOUSE_EVENT_TYPES = ['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'contextmenu'];
        if (args.event === 'keydown' || args.event === 'keyup') {
            // Map common key names to keyCodes for AngularJS compatibility
            var keyCodeMap = { Enter: 13, Escape: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46, Space: 32, ' ': 32 };
            var kc = keyCodeMap[args.key] || 0;
            var codeMap = { Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space', ' ': 'Space' };
            var code = codeMap[args.key] || (args.key && args.key.length === 1 ? 'Key' + args.key.toUpperCase() : args.key || '');
            evt = new KeyboardEvent(args.event, { key: args.key || '', keyCode: kc, which: kc, code: code, bubbles: true, cancelable: true });
        } else if (MOUSE_EVENT_TYPES.indexOf(args.event) !== -1) {
            // Build a REAL MouseEvent (not a generic Event) so widgets that read
            // button/buttons/coordinates or check `instanceof MouseEvent` react like a real
            // pointer interaction. mouseenter/mouseleave are non-bubbling by spec.
            var _mrect = el.getBoundingClientRect();
            var _noBubble = (args.event === 'mouseenter' || args.event === 'mouseleave');
            evt = new MouseEvent(args.event, {
                bubbles: !_noBubble,
                cancelable: true,
                view: el.ownerDocument.defaultView || window,
                button: 0,
                buttons: (args.event === 'mousedown' ? 1 : 0),
                clientX: Math.round(_mrect.left + _mrect.width / 2),
                clientY: Math.round(_mrect.top + _mrect.height / 2)
            });
        } else {
            evt = new Event(args.event, { bubbles: true, cancelable: true });
        }
        el.dispatchEvent(evt);
        // For mouseenter/mouseleave, also dispatch mouseover/mouseout for framework compat
        // Many frameworks (GWT, jQuery) listen for the bubbling mouseover/mouseout events
        if (args.event === 'mouseenter') {
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        } else if (args.event === 'mouseleave') {
            el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true }));
        }
        // For Enter key: also try submitting the parent form (handles ng-submit)
        if ((args.event === 'keydown' || args.event === 'keyup') && args.key === 'Enter') {
            var form = el.closest ? el.closest('form') : null;
            if (form) {
                // Try native submit event first (Angular's ng-submit listens for this)
                var submitEvt = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvt);
            }
        }
        // For keyboard events, also dispatch on the document itself
        // (many event handlers are attached to document rather than specific elements)
        if (args.event === 'keydown' || args.event === 'keyup') {
            try {
                var docNode = el.ownerDocument;
                if (docNode && docNode !== el) {
                    docNode.dispatchEvent(new KeyboardEvent(args.event, { key: args.key || '', keyCode: kc, which: kc, code: code, bubbles: true, cancelable: true }));
                }
            } catch(e) {}
            // Also dispatch in main world via injected script to reach framework handlers
            // (Angular $document, jQuery .on() etc. that listen in the page's JS world)
            try {
                var _mwScript = document.createElement('script');
                // Sanitize strings to prevent script injection via crafted key/event names
                var _safeEvent = args.event.replace(/[\\"]/g, '');
                var _safeKey = (args.key || '').replace(/[\\"]/g, '');
                var _safeCode = code.replace(/[\\"]/g, '');
                _mwScript.textContent = '(function(){try{' +
                    'var e=new KeyboardEvent("' + _safeEvent + '",{key:"' + _safeKey + '",keyCode:' + kc + ',which:' + kc + ',code:"' + _safeCode + '",bubbles:true,cancelable:true});' +
                    'document.dispatchEvent(e);' +
                    '}catch(x){}})();';
                (document.head || document.documentElement).appendChild(_mwScript);
                _mwScript.remove();
            } catch(e) { /* CSP may block inline scripts */ }
        }
        var _dispMsg = 'Dispatched ' + args.event + ' on ' + (el.tagName ? el.tagName.toLowerCase() : args.selector);
        if (args.key) _dispMsg += ' (key=' + args.key + ')';
        sendResponse({ success: true, message: _dispMsg, event: args.event, selector: args.selector });
    }

    function handleSelectOption(doc, args, sendResponse) {
        var el = findElement(doc, args.selector);
        if (!el || el.tagName !== 'SELECT') {
            sendResponse({ error: 'Select element not found: ' + args.selector });
            return;
        }
        var matched = false;
        for (var i = 0; i < el.options.length; i++) {
            var opt = el.options[i];
            if ((args.value !== undefined && opt.value === args.value) || (args.text !== undefined && opt.text === args.text)) {
                el.selectedIndex = i;
                matched = true;
                break;
            }
        }
        if (!matched) {
            var available = Array.prototype.slice.call(el.options).map(function(o) { return { value: o.value, text: o.text }; });
            sendResponse({ error: 'Option not found', availableOptions: available });
            return;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        var _selText = el.options[el.selectedIndex].text;
        sendResponse({ success: true, message: 'Selected "' + _selText + '" (value=' + el.value + ')', selectedValue: el.value, selectedText: _selText });
    }

    // Compute an element's rect relative to the top-level viewport
    // by accumulating parent iframe offsets (for elements inside gsft_main, etc.)
    function getTopLevelRect(el) {
        var rect = el.getBoundingClientRect();
        var top = rect.top, left = rect.left;
        // Walk up through parent iframes to accumulate offsets
        var win = el.ownerDocument.defaultView;
        while (win && win !== window && win.frameElement) {
            try {
                var frameRect = win.frameElement.getBoundingClientRect();
                top += frameRect.top;
                left += frameRect.left;
            } catch(e) { break; }
            win = win.frameElement.ownerDocument.defaultView;
        }
        return { top: top, left: left, width: rect.width, height: rect.height };
    }

    function handleGetProperties(doc, args, sendResponse) {
        var matchIdx = (args && typeof args.match_index === 'number') ? args.match_index : -1;
        var allMatches;
        try {
            doc.querySelectorAll(args.selector);
        } catch(e) {
            sendResponse({ error: 'Invalid selector: ' + args.selector + ' (' + e.message + ')' }); return;
        }
        // Pierce shadow DOM + iframes so match_count / match_index see components inside
        // Seismic / Now Experience shadow roots (plain querySelectorAll stops at the light DOM).
        allMatches = queryAllDeep(doc, args.selector);
        var matchCount = allMatches.length;
        var el;
        if (matchIdx >= 0) {
            el = allMatches[matchIdx] || null;
        } else {
            el = findElement(doc, args.selector);
        }
        if (!el) {
            // An explicit match_index that is out of range is a real misuse -> keep it an error.
            if (matchIdx >= 0 && matchCount > 0) {
                sendResponse({ error: 'match_index ' + matchIdx + ' out of range (total matches: ' + matchCount + ')', match_count: matchCount });
            } else {
                // A valid selector that simply matches nothing is NOT an error: return a
                // consistent empty result so callers can branch on match_count === 0
                // without a defensive wrapper around success:false.
                sendResponse({ success: true, properties: null, match_count: 0 });
            }
            return;
        }
        var rect = getTopLevelRect(el);
        var computed = (el.ownerDocument.defaultView || window).getComputedStyle(el);
        // className is an SVGAnimatedString on SVG nodes; normalize to a plain string, and
        // expose a ready-to-use classList array so callers don't have to scrape get_dom + regex.
        var _classStr = (typeof el.className === 'string') ? el.className : ((el.getAttribute && el.getAttribute('class')) || '');
        var props = {
            tagName: el.tagName,
            id: el.id,
            className: _classStr,
            classList: _classStr ? _classStr.trim().split(/\s+/).filter(Boolean) : [],
            textContent: (el.textContent || '').substring(0, 500),
            value: el.value,
            checked: el.checked,
            disabled: el.disabled,
            visible: rect.width > 0 && rect.height > 0,
            rect: rect
        };
        if (args.properties) {
            props.computedStyle = {};
            args.properties.forEach(function(p) {
                props.computedStyle[p] = computed.getPropertyValue(p);
            });
        }
        var include = args.include || ['rect','styles','value','attributes'];
        if (include.indexOf('styles') !== -1) {
            props.styles = {
                display: computed.display,
                visibility: computed.visibility,
                color: computed.color,
                backgroundColor: computed.backgroundColor,
                fontSize: computed.fontSize,
                fontWeight: computed.fontWeight,
                overflow: computed.overflow,
                position: computed.position,
                opacity: computed.opacity
            };
        }
        sendResponse({ success: true, properties: props, match_count: matchCount });
    }

    function handleSetStyle(doc, args, sendResponse) {
        if (!args.selector) { sendResponse({ error: 'selector is required for set_style action' }); return; }
        var els;
        try {
            doc.querySelectorAll(args.selector);
        } catch(e) {
            sendResponse({ error: 'Invalid selector: ' + args.selector + ' (' + e.message + ')' }); return;
        }
        // Pierce shadow DOM + iframes so styling reaches Seismic / Now Experience components.
        els = queryAllDeep(doc, args.selector);
        if (!els.length) { sendResponse({ error: 'No elements found: ' + args.selector }); return; }
        for (var i = 0; i < els.length; i++) {
            if (args.styles && typeof args.styles === 'object') {
                for (var prop in args.styles) els[i].style[prop] = args.styles[prop];
            }
            if (args.className) {
                var parts = args.className.split(':');
                if (parts[0] === 'add') els[i].classList.add(parts[1]);
                else if (parts[0] === 'remove') els[i].classList.remove(parts[1]);
                else if (parts[0] === 'toggle') els[i].classList.toggle(parts[1]);
            }
        }
        sendResponse({ success: true, message: 'Styled ' + els.length + ' element(s)' });
    }

    // Generate a unique CSS selector for an element
    function getUniqueSelector(el, root) {
        if (!el || el.nodeType !== 1) return '';
        // 1) ID-based (best case)
        if (el.id && !/\s/.test(el.id)) {
            try {
                if ((root || document).querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
                    return '#' + CSS.escape(el.id);
                }
            } catch(e) {}
        }
        // 2) Try aria-label
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
            var sel = el.tagName.toLowerCase() + '[aria-label="' + ariaLabel.replace(/"/g, '\\"') + '"]';
            try { if ((root || document).querySelectorAll(sel).length === 1) return sel; } catch(e) {}
        }
        // 3) Try data-* attributes
        var attrs = el.attributes;
        for (var i = 0; i < attrs.length; i++) {
            if (attrs[i].name.indexOf('data-') === 0 && attrs[i].value) {
                var sel = el.tagName.toLowerCase() + '[' + attrs[i].name + '="' + attrs[i].value.replace(/"/g, '\\"') + '"]';
                try { if ((root || document).querySelectorAll(sel).length === 1) return sel; } catch(e) {}
            }
        }
        // 4) Try name attribute (for form elements)
        var name = el.getAttribute('name');
        if (name) {
            var sel = el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\"') + '"]';
            try { if ((root || document).querySelectorAll(sel).length === 1) return sel; } catch(e) {}
        }
        // 5) Build nth-child path from closest identifiable ancestor
        var parts = [];
        var current = el;
        var maxDepth = 4;
        while (current && current.nodeType === 1 && maxDepth-- > 0) {
            var tag = current.tagName.toLowerCase();
            if (tag === 'html' || tag === 'body') break;
            // Check if this ancestor has an ID
            if (current.id && !/\s/.test(current.id)) {
                parts.unshift('#' + CSS.escape(current.id));
                break;
            }
            // Use class + nth-child for specificity
            var parent = current.parentElement;
            if (parent) {
                var siblings = parent.children;
                var sameTag = [];
                for (var j = 0; j < siblings.length; j++) {
                    if (siblings[j].tagName === current.tagName) sameTag.push(siblings[j]);
                }
                if (sameTag.length === 1) {
                    // Unique among siblings with same tag — try tag + meaningful class
                    var cls = current.className && typeof current.className === 'string' ? current.className.trim().split(/\s+/).filter(function(c) {
                        return c.length > 1 && !/^ng-|^x-|^ui-/.test(c) && !/^active$|^focus$|^hover$/.test(c);
                    })[0] : '';
                    parts.unshift(cls ? tag + '.' + cls : tag);
                } else {
                    var idx = sameTag.indexOf(current) + 1;
                    parts.unshift(tag + ':nth-of-type(' + idx + ')');
                }
            } else {
                parts.unshift(tag);
            }
            current = parent;
        }
        var finalSel = parts.join(' > ');
        // Verify uniqueness
        try {
            if ((root || document).querySelectorAll(finalSel).length === 1) return finalSel;
        } catch(e) {}
        // Fallback: return the path anyway (still better than just tag name)
        return finalSel || el.tagName.toLowerCase();
    }

    // --- get_visible_text with deep mode support ---
    function handleGetVisibleText(doc, args, sendResponse) {
        try {
            if (!args.deep) {
                // Simple mode: shadow- and iframe-piercing plain text. doc.body.innerText stops at
                // shadow boundaries, so on Seismic / Now Experience pages (all content in nested
                // shadow roots) it returns ''. deepText descends open shadow roots + iframes.
                var _stParts = [];
                deepText(doc.body || doc.documentElement || doc, _stParts, 0);
                sendResponse({ success: true, text: _stParts.join(' ').replace(/\s+/g, ' ').trim() });
                return;
            }

            // Deep mode: walk the DOM tree collecting element data with rects/selectors
            var visible = [];
            var scanElements = function(root) {
                var walk = function(node) {
                    if (!node) return;
                    // Skip hidden, script, style, noscript
                    if (node.nodeType === 1) {
                        var tag = node.tagName.toLowerCase();
                        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') return;
                        var style = (root.defaultView || doc.defaultView || window).getComputedStyle(node);
                        // display:none subtrees are genuinely unrendered -> prune entirely. But
                        // visibility:hidden / opacity:0 / zero-box wrappers (custom elements with
                        // display:contents, ubiquitous in Seismic / Now Experience) can still hold
                        // VISIBLE descendants -> don't prune the subtree, just skip RECORDING this
                        // node's own text via the _recordable guard below.
                        if (style.display === 'none') return;
                        var rect = getTopLevelRect(node);
                        var _recordable = !(style.visibility === 'hidden' || style.opacity === '0' || (rect.width === 0 && rect.height === 0));

                        // Detect element type
                        var isInteractive = ['INPUT','TEXTAREA','SELECT','BUTTON','A'].indexOf(node.tagName) !== -1;
                        var isHeading = /^H[1-6]$/.test(node.tagName);
                        var role = node.getAttribute('role');
                        var ariaLabel = node.getAttribute('aria-label');

                        // Get direct text content (not from children)
                        var directText = '';
                        for (var i = 0; i < node.childNodes.length; i++) {
                            if (node.childNodes[i].nodeType === 3) {
                                directText += node.childNodes[i].textContent.trim();
                            }
                        }

                        if (_recordable && (directText.length > 0 || isInteractive || isHeading)) {
                            var textValue = '';
                            if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
                                textValue = node.value || node.placeholder || '';
                            } else if (node.tagName === 'SELECT') {
                                textValue = node.options[node.selectedIndex] ? node.options[node.selectedIndex].text : '';
                            } else if (node.tagName === 'IMG') {
                                textValue = node.alt || '';
                            } else {
                                textValue = directText;
                            }

                            if (textValue.length > 0 || isInteractive) {
                                var type = isHeading ? 'heading' : isInteractive ? 'interactive' : 'text';
                                visible.push({
                                    tag: tag,
                                    type: type,
                                    text: textValue.trim().substring(0, 500),
                                    id: node.id || null,
                                    ariaLabel: ariaLabel || null,
                                    role: role || null,
                                    inputType: node.type || null,
                                    selector: getUniqueSelector(node, root),
                                    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }
                                });
                            }
                        }
                    }

                    // Recurse into children
                    var children = node.children || [];
                    for (var j = 0; j < children.length; j++) {
                        walk(children[j]);
                    }
                    // Recurse into Shadow DOM
                    if (node.shadowRoot) walk(node.shadowRoot);
                    // Recurse into iframes
                    if (node.tagName === 'IFRAME') {
                        try { if (node.contentDocument) scanElements(node.contentDocument); } catch(e) {}
                    }
                };
                walk(root.body || root.documentElement || root);
            };

            scanElements(doc);
            sendResponse({ success: true, visibleElements: visible.slice(0, 1000) });
        } catch(e) {
            sendResponse({ success: false, error: 'get_visible_text failed: ' + e.message });
        }
    }

    // --- Console & network interceptors ---
    // Inject into page context to capture console output and fetch requests

    var interceptorScript = document.createElement('script');
    interceptorScript.textContent = '(' + function() {
        // Guard: skip if MAIN world injection from background.js already ran
        if (window.__appagentInterceptorsActive) return;
        window.__appagentInterceptorsActive = true;
        // Console interceptor
        var origLog = console.log, origWarn = console.warn, origError = console.error;
        function capture(level, args) {
            var msg = Array.prototype.slice.call(args).map(function(a) {
                try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
                catch(e) { return String(a); }
            }).join(' ');
            window.postMessage({ type: 'appagent-console', level: level, message: msg.substring(0, 1000) }, '*');
        }
        console.log = function() { capture('log', arguments); origLog.apply(console, arguments); };
        console.warn = function() { capture('warn', arguments); origWarn.apply(console, arguments); };
        console.error = function() { capture('error', arguments); origError.apply(console, arguments); };

        // Fetch interceptor
        var origFetch = window.fetch;
        window.fetch = function(url, opts) {
            var method = (opts && opts.method) || 'GET';
            var start = Date.now();
            return origFetch.apply(this, arguments).then(function(res) {
                window.postMessage({
                    type: 'appagent-network',
                    method: method,
                    url: String(url),
                    status: res.status,
                    duration: Date.now() - start
                }, '*');
                return res;
            }, function(err) {
                window.postMessage({
                    type: 'appagent-network',
                    method: method,
                    url: String(url),
                    status: 0,
                    duration: Date.now() - start
                }, '*');
                throw err;
            });
        };

        // XHR interceptor
        var OrigXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function() {
            var xhr = new OrigXHR();
            var xhrMethod = 'GET', xhrUrl = '', xhrStart = null;
            var origOpen = xhr.open;
            xhr.open = function(method, url) {
                xhrMethod = method;
                xhrUrl = url;
                xhrStart = Date.now();
                return origOpen.apply(xhr, arguments);
            };
            var origSend = xhr.send;
            xhr.send = function() {
                xhr.addEventListener('load', function() {
                    window.postMessage({
                        type: 'appagent-network',
                        method: xhrMethod,
                        url: String(xhrUrl),
                        status: xhr.status,
                        duration: Date.now() - xhrStart
                    }, '*');
                });
                return origSend.apply(xhr, arguments);
            };
            return xhr;
        };
        window.XMLHttpRequest.prototype = OrigXHR.prototype;
        try { Object.keys(OrigXHR).forEach(function(k) { window.XMLHttpRequest[k] = OrigXHR[k]; }); } catch(e) {}
    } + ')()';
    try { document.documentElement.appendChild(interceptorScript); interceptorScript.remove(); } catch(e) {}

    // Collect intercepted data from page context
    window.addEventListener('message', function(event) {
        if (event.source !== window || !event.data) return;
        if (event.data.type === 'appagent-console') {
            consoleLogs.push({ level: event.data.level, message: event.data.message, timestamp: Date.now() });
            if (consoleLogs.length > 100) consoleLogs.shift();
        }
        if (event.data.type === 'appagent-network') {
            networkRequests.push({
                method: event.data.method,
                url: event.data.url,
                status: event.data.status,
                duration: event.data.duration,
                timestamp: Date.now()
            });
            if (networkRequests.length > 100) networkRequests.shift();
        }
    });
})();
