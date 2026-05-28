// Format element as tag#id.class1.class2 for logging
function describeEl(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).join('.');
    return s;
}

// Send a DOM query to a cross-origin widget iframe via postMessage and wait for response
function queryWidgetViaPostMessage(iframe, action, args) {
    return new Promise(function(resolve) {
        var id = 'wq_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        var timeout = setTimeout(function() {
            window.removeEventListener('message', handler);
            resolve({ success: false, error: 'Widget query timed out (widget may not be loaded yet)' });
        }, 5000);
        function handler(e) {
            if (e.data && e.data.type === 'widgetQueryResult' && e.data.id === id) {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                resolve(e.data.result);
            }
        }
        window.addEventListener('message', handler);
        iframe.contentWindow.postMessage({ type: 'widgetQuery', id: id, action: action, args: args }, '*');
    });
}

async function executeIframeTool(args) {
    var action = args.action;
    var widgetId = args.widget_id;

    // Validate required action parameter
    if (!action) {
        return { success: false, error: 'Missing required parameter "action". Valid actions: navigate, get_visible_text, get_dom, click, fill, get_console_logs, get_network_requests, close' };
    }

    // Route browser actions through the real Chrome tab (not an embedded iframe)
    // Widget actions still use local iframes in the extension page
    if (!widgetId) {
        var extBrowserActions = ['navigate', 'get_visible_text', 'get_dom', 'click', 'fill', 'type', 'wait_for',
            'scroll', 'close', 'get_console_logs', 'get_network_requests',
            'dispatch_event', 'select_option', 'get_properties', 'set_style', 'get_page_info'];
        if (action === 'resize') {
            var presets = { mobile: {w:375,h:812}, tablet: {w:768,h:1024}, desktop: {w:1440,h:900}, fullhd: {w:1920,h:1080} };
            var rw, rh;
            if (args.preset && presets[args.preset]) { rw = presets[args.preset].w; rh = presets[args.preset].h; }
            else { rw = args.width; rh = args.height; }
            if (!rw && !rh) return { success: false, error: 'Provide width/height or a preset (mobile, tablet, desktop, fullhd)' };
            var extResize = await Platform.sendBrowserAction('resize', { width: rw, height: rh });
            if (extResize.error) return { success: false, error: extResize.error };
            var resizeMsg = 'Resized to ' + rw + 'x' + rh;
            if (extResize.emulated) {
                resizeMsg += ' (CSS viewport emulation applied — window minimum exceeded)';
                window._emulatedViewport = { width: rw, height: rh };
            } else {
                window._emulatedViewport = null;
            }
            return { success: true, message: resizeMsg };
        }
        if (extBrowserActions.indexOf(action) !== -1) {
            try {
                if (action === 'navigate') {
                    if (!args.url) return { success: false, error: 'URL is required for navigate action' };

                    // Resolve instance targeting
                    var _navInstanceUrl = null;
                    if (args.instance && Platform.resolveInstanceUrl) {
                        _navInstanceUrl = Platform.resolveInstanceUrl(args.instance);
                        if (!_navInstanceUrl) {
                            return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
                        }
                    }

                    // Full-tab mode: open target page in a background tab (app stays alive)
                    // Reuses existing target tab if valid, otherwise creates a new one
                    // Tab ID is saved to chat so all actions target the right tab
                    if (!document.body.classList.contains('sidepanel-mode')) {
                        var fullTabNavUrl = args.url;
                        if (fullTabNavUrl.startsWith('/')) {
                            var _baseUrl = _navInstanceUrl || Platform.instanceUrl;
                            if (_baseUrl) fullTabNavUrl = _baseUrl + fullTabNavUrl;
                        }
                        var _ftChat = chats[currentChatId];
                        var _existingTabId = _ftChat && _ftChat.targetTabId;
                        var _reuseTab = false;
                        // If targeting a different instance, try to find an existing tab on it first
                        if (_navInstanceUrl && Platform.getTabForInstance) {
                            var _instanceTabId = Platform.getTabForInstance(_navInstanceUrl);
                            if (_instanceTabId && _instanceTabId !== _existingTabId) {
                                _existingTabId = _instanceTabId;
                            }
                        }
                        if (_existingTabId) {
                            try { await chrome.tabs.get(_existingTabId); _reuseTab = true; } catch(e) {}
                        }
                        // Pre-register load listener BEFORE initiating navigation to avoid
                        // missing the 'complete' event for fast loads / cached pages.
                        var _waitMs = (typeof args.wait === 'number') ? args.wait : (args.wait ? 15000 : 0);
                        var _navTabIdEarly = _reuseTab ? _existingTabId : null;
                        var _earlyComplete = false;
                        var _earlyListener = null;
                        if (_waitMs > 0) {
                            _earlyListener = function(tabId, changeInfo) {
                                if (_navTabIdEarly && tabId === _navTabIdEarly && changeInfo.status === 'complete') {
                                    _earlyComplete = true;
                                }
                            };
                            chrome.tabs.onUpdated.addListener(_earlyListener);
                        }

                        var _targetTab;
                        if (_reuseTab) {
                            _targetTab = await chrome.tabs.update(_existingTabId, { url: fullTabNavUrl });
                        } else {
                            _targetTab = await chrome.tabs.create({ url: fullTabNavUrl, active: false });
                            if (_earlyListener) _navTabIdEarly = _targetTab.id;
                        }
                        if (_ftChat) {
                            _ftChat.targetTabId = _targetTab.id;
                            saveChatsToStorage();
                        }
                        // Mirror to SW: when the agent loop runs in the SW, its
                        // chat snapshot doesn't know about this page-side write,
                        // so the next agent-event would replace chats[chatId] in
                        // the panel and wipe targetTabId. tool-routing.js applies
                        // _target_tab_persist back onto the SW's chat object.
                        var _ftPersist = _targetTab.id;
                        // If wait requested, wait for the tab to finish loading then inject scripts
                        // Otherwise ask background to inject when page loads (non-blocking)
                        if (_waitMs > 0) {
                            await new Promise(function(resolve) {
                                var _resolved = false;
                                var _loadingSeen = false;
                                function _finish(reason) {
                                    if (_resolved) return;
                                    _resolved = true;
                                    chrome.tabs.onUpdated.removeListener(_navListener);
                                    chrome.tabs.onUpdated.removeListener(_earlyListener);
                                    chrome.tabs.onRemoved.removeListener(_navOnRemoved);
                                    clearTimeout(_navTimeout);
                                    clearTimeout(_sameUrlCheck);
                                    if (reason !== 'removed') {
                                        chrome.runtime.sendMessage({ type: 'setup-tab-injection', tabId: _targetTab.id });
                                    }
                                    // Brief settle delay for SPAs, skipped for fast paths
                                    var settle = (reason === 'complete') ? 1000 : 0;
                                    setTimeout(resolve, settle);
                                }
                                var _navTimeout = setTimeout(function() { _finish('timeout'); }, _waitMs);
                                function _navOnRemoved(tid) { if (tid === _targetTab.id) _finish('removed'); }
                                function _navListener(tabId, changeInfo) {
                                    if (tabId !== _targetTab.id) return;
                                    if (changeInfo.status === 'loading') _loadingSeen = true;
                                    if (changeInfo.status === 'complete') _finish('complete');
                                }
                                chrome.tabs.onUpdated.addListener(_navListener);
                                chrome.tabs.onRemoved.addListener(_navOnRemoved);
                                // If 'complete' fired between update() resolving and listener attach,
                                // _earlyComplete will be true — handle it.
                                if (_earlyComplete) { _finish('complete'); return; }
                                // Same-URL no-op detection: if after 1.5s we still haven't seen a
                                // 'loading' event AND the tab is 'complete' AND its URL matches the
                                // target, the navigation was a no-op — finish.
                                var _sameUrlCheck = setTimeout(function _check() {
                                    if (_resolved) return;
                                    chrome.tabs.get(_targetTab.id, function(t) {
                                        if (chrome.runtime.lastError || !t || _resolved) return;
                                        var urlMatches = t.url && t.url.split('#')[0].split('?')[0] === fullTabNavUrl.split('#')[0].split('?')[0];
                                        if (!_loadingSeen && t.status === 'complete' && urlMatches) {
                                            _finish('already-complete');
                                        }
                                    });
                                }, 1500);
                            });
                        } else {
                            if (_earlyListener) chrome.tabs.onUpdated.removeListener(_earlyListener);
                            chrome.runtime.sendMessage({ type: 'setup-tab-injection', tabId: _targetTab.id });
                        }

                        return { success: true, message: 'Opened ' + fullTabNavUrl + ' in background tab', _target_tab_persist: _ftPersist };
                    }

                    // For sidepanel mode with instance targeting, resolve URL before sending
                    if (_navInstanceUrl && args.url.startsWith('/')) {
                        args.url = _navInstanceUrl + args.url;
                    }

                    // Update URL display
                    var browserUrlInput = document.getElementById('browser-url-input');
                    if (browserUrlInput) browserUrlInput.value = args.url;
                    currentIframeUrl = args.url;
                }

                // Side panel mode close: expand back to full page after response completes
                if (action === 'close' && document.body.classList.contains('sidepanel-mode')) {
                    var _expandCheck = setInterval(function() {
                        if (!isLoading) {
                            clearInterval(_expandCheck);
                            saveChatsToStorage().then(function() {
                                expandSidePanel();
                            });
                        }
                    }, 500);
                    setTimeout(function() { clearInterval(_expandCheck); }, 60000);
                    return { success: true, message: 'Browser closed. Returning to full page view.' };
                }

                var extResult = await Platform.sendBrowserAction(action, args);
                if (extResult.error) {
                    return { success: false, error: extResult.error };
                }
                // Persist target tab ID on the chat so it survives restarts
                var _spPersist = null;
                if (action === 'navigate' && extResult.tabId) {
                    var _navChat = chats[currentChatId];
                    if (_navChat) {
                        _navChat.targetTabId = extResult.tabId;
                        saveChatsToStorage();
                    }
                    // See full-tab branch above for why we mirror to the SW.
                    _spPersist = extResult.tabId;
                }
                // Map content script response to tool result format
                if (action === 'get_visible_text') {
                    // Deep mode returns visibleElements array; simple mode returns text
                    if (extResult.visibleElements) {
                        return { success: true, visibleElements: extResult.visibleElements, note: extResult.note || '' };
                    }
                    return { success: true, text: extResult.text || '' };
                }
                if (action === 'scroll') {
                    return { success: true, scrollTop: extResult.scrollTop, scrollHeight: extResult.scrollHeight, message: extResult.message || 'Scrolled' };
                }
                if (action === 'get_dom') {
                    var _domRes = { success: true, html: extResult.html || '' };
                    if (extResult.match_count !== undefined) _domRes.match_count = extResult.match_count;
                    return _domRes;
                }
                if (action === 'get_console_logs') {
                    return { success: true, logs: extResult.logs || [] };
                }
                if (action === 'get_network_requests') {
                    return { success: true, requests: extResult.requests || [] };
                }
                if (action === 'get_properties') {
                    var _propRes = { success: true, properties: extResult.properties || {} };
                    if (extResult.match_count !== undefined) _propRes.match_count = extResult.match_count;
                    return _propRes;
                }
                if (action === 'get_page_info') {
                    if (extResult.url) currentIframeUrl = extResult.url;
                    return extResult;
                }
                if (action === 'select_option') {
                    return { success: true, message: 'Selected "' + (extResult.selectedText || '') + '" (value=' + (extResult.selectedValue || '') + ')' };
                }
                if (action === 'dispatch_event') {
                    // Use the content script's message which includes key info (e.g. "key=Escape")
                    var _dispMsg = extResult.message || ('Dispatched ' + (extResult.event || args.event || '') + ' on ' + (extResult.selector || args.selector || ''));
                    return { success: true, message: _dispMsg };
                }
                if (action === 'set_style') {
                    return { success: true, message: extResult.message || ('Styled ' + (extResult.count || '?') + ' element(s)') };
                }
                var _defaultRet = { success: true, message: extResult.message || 'Action completed' };
                if (_spPersist) _defaultRet._target_tab_persist = _spPersist;
                return _defaultRet;
            } catch (e) {
                return { success: false, error: 'Extension browser action failed: ' + e.message };
            }
        }
    }

    // Resolve the widget iframe for actions that target a widget.
    function getTargetIframe() {
        var _tgtWidget = getWidgetById(widgetId);
        if (!_tgtWidget && dashboardWidgets[widgetId]) _tgtWidget = dashboardWidgets[widgetId];
        if (_tgtWidget && _tgtWidget.deactivated) {
            return { error: 'Widget "' + (_tgtWidget.title || widgetId) + '" is deactivated. The user has deactivated this widget. Ask the user to activate it first, or proceed differently.' };
        }
        var widgetIframe = getWidgetIframe(widgetId);
        if (!widgetIframe) {
            return { error: 'Widget not found: ' + widgetId + '. Make sure the widget is visible in the chat or dashboard.' };
        }
        return { iframe: widgetIframe };
    }

    try {
        switch(action) {
            case 'navigate':
                return { success: false, error: 'Navigate action is not supported for widgets. Widgets are self-contained HTML - modify the widget HTML instead.' };

            case 'get_visible_text':
                try {
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var iframe = target.iframe;
                    var doc;
                    try { doc = iframe.contentDocument; } catch(e) { doc = null; }
                    // Cross-origin widget: delegate via postMessage bridge
                    if (!doc) return queryWidgetViaPostMessage(iframe, 'get_visible_text', { deep: args.deep });

                    var visible = [];
                    var scanElements = function(root) {
                        if (!root) return;
                        
                        var processed = new Set();
                        // Tags to skip entirely (like screen readers)
                        var hiddenTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD'];

                        var isVisibleToScreenReader = function(el) {
                            if (!el || el.nodeType !== 1) return true;
                            // Skip hidden tags
                            if (hiddenTags.indexOf(el.tagName) !== -1) return false;
                            // Check aria-hidden
                            if (el.getAttribute('aria-hidden') === 'true') return false;
                            // Check CSS visibility
                            var style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
                            if (style.display === 'none') return false;
                            if (style.visibility === 'hidden') return false;
                            if (style.opacity === '0') return false;
                            // Check if element is in viewport with actual size
                            var rect = el.getBoundingClientRect();
                            if (rect.width === 0 && rect.height === 0) return false;
                            return true;
                        };

                        var walk = function(node) {
                            if (!node) return;
                            
                            // Handle Document (9), Element (1), or DocumentFragment/ShadowRoot (11)
                            if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;

                            if (processed.has(node)) return;
                            processed.add(node);

                            // Skip hidden elements and their children (like screen readers)
                            if (node.nodeType === 1 && !isVisibleToScreenReader(node)) return;

                            var rect = (node.nodeType === 1) ? node.getBoundingClientRect() : null;
                            
                            if (node.nodeType === 1) {
                                var isInteractive = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].indexOf(node.tagName) !== -1;
                                var isMedia = node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.tagName === 'SVG';
                                var isHeading = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].indexOf(node.tagName) !== -1;
                                var isLabel = node.tagName === 'LABEL' || node.tagName === 'LEGEND';
                                
                                // Detect direct text content (only text nodes, not nested elements)
                                var directText = "";
                                for (var i = 0; i < node.childNodes.length; i++) {
                                    if (node.childNodes[i].nodeType === 3) {
                                        directText += node.childNodes[i].textContent.trim();
                                    }
                                }

                                // Capture if it has direct text OR is a specific interactive/media type
                                if (directText.length > 0 || isInteractive || isMedia || isHeading || isLabel) {
                                    // For inputs, get value; for others get only direct text to avoid duplication
                                    var textValue = "";
                                    if (node.tagName === 'INPUT') {
                                        textValue = node.value || node.placeholder || "";
                                    } else if (node.tagName === 'TEXTAREA') {
                                        textValue = node.value || "";
                                    } else if (node.tagName === 'IMG') {
                                        textValue = node.alt || node.title || "";
                                    } else {
                                        textValue = directText;
                                    }
                                    
                                    if (textValue.trim().length > 0 || isInteractive) {
                                        // Determine semantic role for AI readability
                                        var role = node.getAttribute('role') || '';
                                        var ariaLabel = node.getAttribute('aria-label') || '';
                                        var type = isHeading ? 'heading' : isInteractive ? (node.tagName === 'A' ? 'link' : node.tagName === 'BUTTON' ? 'button' : 'input') : isMedia ? 'media' : isLabel ? 'label' : 'text';
                                        
                                        // Find associated label for form fields
                                        var fieldLabel = '';
                                        if (node.id && (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA')) {
                                            var labelEl = root.querySelector ? root.querySelector('label[for=\"' + node.id + '\"]') : null;
                                            if (labelEl) fieldLabel = labelEl.textContent.trim();
                                        }
                                        
                                        // Build element data based on deep flag
                                        var elemData;
                                        if (args.deep) {
                                            elemData = {
                                                tag: node.tagName.toLowerCase(),
                                                type: type,
                                                text: textValue.trim().substring(0, 500),
                                                id: node.id || null,
                                                fieldLabel: fieldLabel || null,
                                                ariaLabel: ariaLabel || null,
                                                role: role || null,
                                                inputType: node.type || null,
                                                selector: getUniqueSelector(node, root),
                                                rect: rect ? { 
                                                    x: Math.round(rect.x), 
                                                    y: Math.round(rect.y), 
                                                    w: Math.round(rect.width), 
                                                    h: Math.round(rect.height) 
                                                } : null
                                            };
                                        } else {
                                            // Simplified output: only text
                                            elemData = {
                                                tag: node.tagName.toLowerCase(),
                                                type: type,
                                                text: textValue.trim().substring(0, 500)
                                            };
                                        }
                                        visible.push(elemData);
                                    }
                                }
                            }

                            // Recurse into children
                            var children = node.children || [];
                            for (var j = 0; j < children.length; j++) {
                                walk(children[j]);
                            }

                            // Recurse into Shadow DOM
                            if (node.shadowRoot) {
                                walk(node.shadowRoot);
                            }

                            // Recurse into iframes (if accessible)
                            if (node.tagName === 'IFRAME') {
                                try {
                                    if (node.contentDocument) {
                                        walk(node.contentDocument);
                                    }
                                } catch(e) {
                                    // Cross-origin, ignore
                                }
                            }
                        };

                        walk(root);
                    };

                    scanElements(doc);
                    
                    // Limit to 1000 elements to ensure we capture enough detail on complex forms
                    return { 
                        success: true, 
                        visibleElements: visible.slice(0, 1000), 
                        note: 'Returning visible elements (including shadow DOM content) for analysis.' 
                    };
                } catch(e) {
                    return { success: false, error: 'Get visible text failed: ' + e.message };
                }

            case 'get_dom':
                try {
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var iframe = target.iframe;
                    var doc;
                    try { doc = iframe.contentDocument; } catch(e) { doc = null; }
                    if (!doc) return queryWidgetViaPostMessage(iframe, 'get_dom', {});

                    var html;
                    var _domMatchCount;
                    if (args.selector) {
                        var allMatches = doc.querySelectorAll(args.selector);
                        _domMatchCount = allMatches.length;
                        var domEl;
                        if (typeof args.match_index === 'number' && args.match_index >= 0) {
                            domEl = allMatches[args.match_index] || null;
                        } else {
                            domEl = doc.querySelector(args.selector);
                        }
                        if (!domEl) return { success: false, error: 'Element not found: ' + args.selector + (typeof args.match_index === 'number' ? ' (match_index=' + args.match_index + ', total matches: ' + _domMatchCount + ')' : ''), match_count: _domMatchCount };
                        html = domEl.outerHTML;
                    } else {
                        html = doc.documentElement.outerHTML;
                    }
                    if (html.length > 50000) {
                        html = html.substring(0, 50000) + '\n... [truncated, total: ' + html.length + ' chars]';
                    }

                    return { success: true, html: html, match_count: _domMatchCount, note: 'DOM retrieved (from widget)' };
                } catch(e) {
                    return { success: false, error: 'Get DOM failed: ' + e.message };
                }

            case 'click':
                if (!args.selector) return { success: false, error: 'Selector is required for click action' };
                try {
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var doc;
                    try { doc = target.iframe.contentDocument; } catch(e) { doc = null; }
                    if (!doc) return queryWidgetViaPostMessage(target.iframe, 'click', { selector: args.selector });
                    var el = doc.querySelector(args.selector);
                    if (!el) return { success: false, error: 'Element not found: ' + args.selector };
                    el.scrollIntoView({ block: 'center', behavior: 'instant' });
                    el.click();
                    return { success: true, message: 'Clicked ' + args.selector + ' -> ' + describeEl(el) + ' in widget' };
                } catch(e) {
                    return { success: false, error: 'Click failed: ' + e.message };
                }

            case 'fill':
                if (!args.selector) return { success: false, error: 'Selector is required for fill action' };
                if (args.value === undefined) return { success: false, error: 'Value is required for fill action' };
                try {
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var doc;
                    try { doc = target.iframe.contentDocument; } catch(e) { doc = null; }
                    if (!doc) return queryWidgetViaPostMessage(target.iframe, 'fill', { selector: args.selector, value: args.value });
                    var el = doc.querySelector(args.selector);
                    if (!el) return { success: false, error: 'Element not found: ' + args.selector };
                    el.scrollIntoView({ block: 'center', behavior: 'instant' });
                    el.focus();
                    // Full user-typing event chain so frameworks (React/Angular) that listen
                    // for keydown/keyup/input/change see the change as if a real user typed it.
                    var win = doc.defaultView || window;
                    var lastChar = (args.value && String(args.value).length) ? String(args.value).charAt(String(args.value).length - 1) : '';
                    try { el.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, key: lastChar })); } catch(e) {}
                    try { el.dispatchEvent(new win.KeyboardEvent('keypress', { bubbles: true, key: lastChar })); } catch(e) {}
                    // React-safe value setter
                    try {
                        var fproto = (el.tagName === 'TEXTAREA') ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
                        var fdesc = Object.getOwnPropertyDescriptor(fproto, 'value');
                        if (fdesc && fdesc.set) fdesc.set.call(el, args.value); else el.value = args.value;
                    } catch(e) { el.value = args.value; }
                    el.dispatchEvent(new win.Event('input', { bubbles: true }));
                    try { el.dispatchEvent(new win.KeyboardEvent('keyup', { bubbles: true, key: lastChar })); } catch(e) {}
                    el.dispatchEvent(new win.Event('change', { bubbles: true }));
                    return { success: true, message: 'Filled ' + args.selector + ' -> ' + describeEl(el) + ' in widget' };
                } catch(e) {
                    return { success: false, error: 'Fill failed: ' + e.message };
                }

            case 'type':
                if (!args.selector) return { success: false, error: 'Selector is required for type action' };
                if (args.value === undefined) return { success: false, error: 'Value is required for type action' };
                try {
                    var ttarget = getTargetIframe();
                    if (ttarget.error) return { success: false, error: ttarget.error };
                    var tdoc;
                    try { tdoc = ttarget.iframe.contentDocument; } catch(e) { tdoc = null; }
                    if (!tdoc) return queryWidgetViaPostMessage(ttarget.iframe, 'type', { selector: args.selector, value: args.value, delay: args.delay, append: args.append });
                    var tel = tdoc.querySelector(args.selector);
                    if (!tel) return { success: false, error: 'Element not found: ' + args.selector };
                    var tval = String(args.value);
                    var tdelay = (typeof args.delay === 'number' && args.delay >= 0) ? args.delay : 30;
                    var tappend = !!args.append;
                    tel.scrollIntoView({ block: 'center', behavior: 'instant' });
                    tel.focus();
                    var twin = tdoc.defaultView || window;
                    var tproto = (tel.tagName === 'TEXTAREA') ? twin.HTMLTextAreaElement.prototype : twin.HTMLInputElement.prototype;
                    var tdesc = Object.getOwnPropertyDescriptor(tproto, 'value');
                    var tsetter = (tdesc && tdesc.set) || null;
                    var tcurrent = tappend ? (tel.value || '') : '';
                    if (!tappend) { try { tsetter ? tsetter.call(tel, '') : (tel.value = ''); } catch(e) { tel.value = ''; } tel.dispatchEvent(new twin.Event('input', { bubbles: true })); }
                    return await new Promise(function(tresolve) {
                        var ti = 0;
                        function typeNext() {
                            if (ti >= tval.length) {
                                tel.dispatchEvent(new twin.Event('change', { bubbles: true }));
                                tresolve({ success: true, message: 'Typed "' + tval + '" into ' + args.selector + ' -> ' + describeEl(tel) });
                                return;
                            }
                            var ch = tval.charAt(ti);
                            try { tel.dispatchEvent(new twin.KeyboardEvent('keydown', { bubbles: true, key: ch })); } catch(e) {}
                            try { tel.dispatchEvent(new twin.KeyboardEvent('keypress', { bubbles: true, key: ch })); } catch(e) {}
                            tcurrent += ch;
                            try { tsetter ? tsetter.call(tel, tcurrent) : (tel.value = tcurrent); } catch(e) { tel.value = tcurrent; }
                            tel.dispatchEvent(new twin.Event('input', { bubbles: true }));
                            try { tel.dispatchEvent(new twin.KeyboardEvent('keyup', { bubbles: true, key: ch })); } catch(e) {}
                            ti++;
                            if (tdelay > 0) setTimeout(typeNext, tdelay); else typeNext();
                        }
                        typeNext();
                    });
                } catch(e) {
                    return { success: false, error: 'Type failed: ' + e.message };
                }

            case 'wait_for':
                try {
                    var wtarget = getTargetIframe();
                    if (wtarget.error) return { success: false, error: wtarget.error };
                    var wdoc;
                    try { wdoc = wtarget.iframe.contentDocument; } catch(e) { wdoc = null; }
                    if (!wdoc) return { success: false, error: 'Cannot access iframe content (cross-origin)' };
                    var wtimeout = (typeof args.timeout === 'number') ? args.timeout : 10000;
                    var wpoll = (typeof args.poll === 'number') ? args.poll : 100;
                    var wstart = Date.now();
                    return await new Promise(function(wresolve) {
                        function check() {
                            try {
                                if (args.selector_visible) {
                                    var v = wdoc.querySelector(args.selector_visible);
                                    if (v) {
                                        var rect = v.getBoundingClientRect();
                                        if (rect.width > 0 && rect.height > 0) return wresolve({ success: true, waited_ms: Date.now() - wstart, condition: 'selector_visible: ' + args.selector_visible });
                                    }
                                } else if (args.selector_gone) {
                                    var g = wdoc.querySelector(args.selector_gone);
                                    if (!g) return wresolve({ success: true, waited_ms: Date.now() - wstart, condition: 'selector_gone: ' + args.selector_gone });
                                    var grect = g.getBoundingClientRect();
                                    if (grect.width === 0 && grect.height === 0) return wresolve({ success: true, waited_ms: Date.now() - wstart, condition: 'selector_gone: ' + args.selector_gone });
                                } else if (args.text) {
                                    if ((wdoc.body && wdoc.body.innerText || '').indexOf(args.text) !== -1) return wresolve({ success: true, waited_ms: Date.now() - wstart, condition: 'text: ' + args.text });
                                } else if (args.url_matches) {
                                    var loc = (wdoc.defaultView && wdoc.defaultView.location.href) || '';
                                    if (loc.indexOf(args.url_matches) !== -1) return wresolve({ success: true, waited_ms: Date.now() - wstart, condition: 'url_matches: ' + args.url_matches });
                                } else {
                                    return wresolve({ success: false, error: 'wait_for requires one of: selector_visible, selector_gone, text, url_matches' });
                                }
                            } catch(e) {}
                            if (Date.now() - wstart >= wtimeout) {
                                return wresolve({ success: false, error: 'Timed out after ' + wtimeout + 'ms', waited_ms: Date.now() - wstart });
                            }
                            setTimeout(check, wpoll);
                        }
                        check();
                    });
                } catch(e) {
                    return { success: false, error: 'wait_for failed: ' + e.message };
                }

            case 'get_console_logs':
            case 'get_network_requests':
                return { success: false, error: action + ' is not supported for widgets. Use iframe_tool without widget_id to query the active browser tab.' };

            case 'close':
                return { success: false, error: 'Close action is not supported for widgets. Widgets are embedded in chat messages.' };

            case 'open_widget':
                if (!widgetId) return { success: false, error: 'widget_id is required for open_widget action' };
                var widget = getWidgetById(widgetId);
                if (!widget) return { success: false, error: 'Widget not found: ' + widgetId };
                openWidgetInIframePanel(widgetId);
                return {
                    success: true,
                    message: 'Widget "' + widget.title + '" opened in a new tab. You can use get_visible_text, get_dom, click, fill, or edit_html actions with widget_id="' + widgetId + '".'
                };

            case 'edit_html':
                if (!widgetId) return { success: false, error: 'widget_id is required for edit_html action' };
                if (!args.edits || !Array.isArray(args.edits)) return { success: false, error: 'edits array is required for edit_html action. Format: [{ find: "old text", replace: "new text" }]' };
                var widget = getWidgetById(widgetId);
                if (!widget) return { success: false, error: 'Widget not found: ' + widgetId };
                
                var editResult = applySearchReplaceEdits(widget.html, args.edits);
                if (editResult.error) {
                    return { success: false, error: 'Edit failed', validationErrors: editResult.messages };
                }
                
                // Update widget HTML
                widget.html = editResult.content;
                
                // Persist changes
                var chat = chats[widget.chatId || currentChatId];
                if (chat && chat.widgets) {
                    var idx = chat.widgets.findIndex(function(w) { return w.id === widgetId; });
                    if (idx !== -1) chat.widgets[idx].html = widget.html;
                    saveChatsToStorage();
                }
                
                // Refresh inline widget if visible
                var inlineContainer = document.getElementById('widget-content-' + widgetId);
                if (inlineContainer) {
                    inlineContainer.innerHTML = '';
                    renderWidgetInContainer(widget, inlineContainer);
                }
                
                var result = { success: true, message: 'Widget HTML updated', appliedEdits: editResult.appliedEdits.length };
                if (editResult.partialSuccess) {
                    result.warning = 'Some edits failed';
                    result.failedEdits = editResult.failedEdits;
                }
                return result;

            // Hidden actions (not in tool schema - used by skill tools via executeTool)
            case 'scroll':
                try {
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var doc = target.iframe.contentDocument;
                    if (!doc) return { success: false, error: 'Cannot access iframe content' };

                    var beh = args.behavior || 'instant';

                    if (args.selector) {
                        var el = doc.querySelector(args.selector);
                        if (!el) return { success: false, error: 'Element not found: ' + args.selector };
                        el.scrollIntoView({ block: 'start', behavior: beh });
                        var scrollCont = doc.scrollingElement || doc.documentElement || doc.body;
                        return { success: true, scrollTop: scrollCont ? scrollCont.scrollTop : 0, scrollHeight: scrollCont ? scrollCont.scrollHeight : 0, message: 'Scrolled to ' + args.selector };
                    }

                    var st = doc.scrollingElement || doc.documentElement || doc.body;
                    if (!st) return { success: false, error: 'No scrollable element found' };

                    var targetTop = (args.position === 'top') ? 0 : (args.position === 'bottom') ? st.scrollHeight : (args.y || 0);
                    st.scrollTo({ top: targetTop, left: args.x || st.scrollLeft, behavior: beh });

                    return { success: true, scrollTop: st.scrollTop, scrollHeight: st.scrollHeight };
                } catch(e) {
                    return { success: false, error: 'scroll failed: ' + e.message };
                }

            case 'resize':
                return { success: false, error: 'resize is not supported for widgets. Use iframe_tool without widget_id to resize the active browser tab.' };

            case 'get_properties':
                try {
                    if (!args.selector) return { success: false, error: 'selector is required for get_properties action' };
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var doc = target.iframe.contentDocument;
                    if (!doc) return { success: false, error: 'Cannot access iframe content' };
                    var elements;
                    try {
                        elements = Array.prototype.slice.call(doc.querySelectorAll(args.selector));
                    } catch(selErr) {
                        return { success: false, error: 'Invalid selector: ' + args.selector + ' (' + selErr.message + ')' };
                    }
                    if (!elements.length) return { success: false, error: 'No elements found: ' + args.selector };
                    var include = args.include || ['rect', 'styles', 'value', 'attributes'];
                    var results = [];
                    var limit = Math.min(elements.length, 20);
                    for (var i = 0; i < limit; i++) {
                        var el = elements[i];
                        var elWin = el.ownerDocument.defaultView || target.iframe.contentWindow;
                        var info = { tagName: el.tagName.toLowerCase(), visible: el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0 };
                        if (include.indexOf('rect') !== -1) {
                            var rect = el.getBoundingClientRect();
                            info.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
                        }
                        if (include.indexOf('styles') !== -1) {
                            var cs = elWin.getComputedStyle(el);
                            info.styles = { display: cs.display, visibility: cs.visibility, color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight, overflow: cs.overflow, position: cs.position, opacity: cs.opacity };
                        }
                        if (include.indexOf('value') !== -1) {
                            info.value = el.value !== undefined ? el.value : null;
                            info.textContent = (el.textContent || '').substring(0, 200);
                            info.checked = el.checked !== undefined ? el.checked : null;
                        }
                        if (include.indexOf('attributes') !== -1) {
                            info.attributes = {};
                            for (var a = 0; a < el.attributes.length; a++) {
                                info.attributes[el.attributes[a].name] = el.attributes[a].value;
                            }
                        }
                        results.push(info);
                    }
                    return { success: true, count: elements.length, elements: results };
                } catch(e) {
                    return { success: false, error: 'get_properties failed: ' + e.message };
                }

            case 'set_style':
                try {
                    if (!args.selector) return { success: false, error: 'selector is required for set_style action' };
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var doc = target.iframe.contentDocument;
                    if (!doc) return { success: false, error: 'Cannot access iframe content' };
                    var elements;
                    try {
                        elements = Array.prototype.slice.call(doc.querySelectorAll(args.selector));
                    } catch(selErr) {
                        return { success: false, error: 'Invalid selector: ' + args.selector + ' (' + selErr.message + ')' };
                    }
                    if (!elements.length) return { success: false, error: 'No elements found: ' + args.selector };
                    for (var i = 0; i < elements.length; i++) {
                        if (args.styles && typeof args.styles === 'object') {
                            for (var prop in args.styles) {
                                elements[i].style[prop] = args.styles[prop];
                            }
                        }
                        if (args.className) {
                            var parts = args.className.split(':');
                            if (parts[0] === 'add' && parts[1]) elements[i].classList.add(parts[1]);
                            else if (parts[0] === 'remove' && parts[1]) elements[i].classList.remove(parts[1]);
                            else if (parts[0] === 'toggle' && parts[1]) elements[i].classList.toggle(parts[1]);
                        }
                    }
                    return { success: true, modifiedCount: elements.length };
                } catch(e) {
                    return { success: false, error: 'set_style failed: ' + e.message };
                }

            case 'dispatch_event':
                try {
                    if (!args.selector) return { success: false, error: 'selector is required for dispatch_event action' };
                    if (!args.event) return { success: false, error: 'event is required for dispatch_event action' };
                    var allowedEvents = ['click', 'change', 'input', 'focus', 'blur', 'submit', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'keydown', 'keyup'];
                    if (allowedEvents.indexOf(args.event) === -1) return { success: false, error: 'Event "' + args.event + '" not allowed. Allowed: ' + allowedEvents.join(', ') };
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var doc = target.iframe.contentDocument;
                    if (!doc) return { success: false, error: 'Cannot access iframe content' };
                    var el = doc.querySelector(args.selector);
                    if (!el) return { success: false, error: 'Element not found: ' + args.selector };
                    var elWin = el.ownerDocument.defaultView || target.iframe.contentWindow;
                    var eventObj;
                    if (args.event === 'keydown' || args.event === 'keyup') {
                        var keyName = args.key || '';
                        // Map key names to legacy keyCode/which values needed by Bootstrap/jQuery
                        var keyCodes = { Escape: 27, Enter: 13, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46, Space: 32, ' ': 32 };
                        var kc = keyCodes[keyName] || keyName.charCodeAt(0) || 0;
                        var codeMap = { Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space', ' ': 'Space' };
                        var keyCode = codeMap[keyName] || (keyName.length === 1 ? 'Key' + keyName.toUpperCase() : keyName);
                        eventObj = new elWin.KeyboardEvent(args.event, { key: keyName, code: keyCode, keyCode: kc, which: kc, bubbles: true, cancelable: true });
                    } else if (args.event === 'mouseenter' || args.event === 'mouseleave' || args.event === 'mouseover' || args.event === 'mouseout') {
                        eventObj = new elWin.MouseEvent(args.event, { bubbles: args.event === 'mouseover' || args.event === 'mouseout', cancelable: true });
                    } else {
                        eventObj = new elWin.Event(args.event, { bubbles: true, cancelable: true });
                    }
                    el.dispatchEvent(eventObj);
                    // For mouseenter/mouseleave, also dispatch mouseover/mouseout for framework compat
                    // Many frameworks (GWT, jQuery) listen for the bubbling mouseover/mouseout events
                    if (args.event === 'mouseenter') {
                        el.dispatchEvent(new elWin.MouseEvent('mouseover', { bubbles: true, cancelable: true }));
                    } else if (args.event === 'mouseleave') {
                        el.dispatchEvent(new elWin.MouseEvent('mouseout', { bubbles: true, cancelable: true }));
                    }
                    // For keyboard events, also dispatch on the document itself
                    // (many event handlers are attached to document rather than specific elements)
                    if (args.event === 'keydown' || args.event === 'keyup') {
                        try {
                            var docNode = el.ownerDocument;
                            if (docNode && docNode !== el) {
                                docNode.dispatchEvent(new elWin.KeyboardEvent(args.event, { key: keyName, code: eventObj.code, keyCode: kc, which: kc, bubbles: true, cancelable: true }));
                            }
                        } catch(e) {}
                    }
                    var _dispMsg = 'Dispatched ' + args.event + ' on ' + (el.tagName.toLowerCase());
                    if (args.key) _dispMsg += ' (key=' + args.key + ')';
                    return { success: true, message: _dispMsg, event: args.event, selector: args.selector };
                } catch(e) {
                    return { success: false, error: 'dispatch_event failed: ' + e.message };
                }

            case 'select_option':
                try {
                    if (!args.selector) return { success: false, error: 'selector is required for select_option action' };
                    var target = getTargetIframe();
                    if (target.error) return { success: false, error: target.error };
                    var doc = target.iframe.contentDocument;
                    if (!doc) return { success: false, error: 'Cannot access iframe content' };
                    var selectEl = doc.querySelector(args.selector);
                    if (!selectEl) return { success: false, error: 'Element not found: ' + args.selector };
                    if (selectEl.tagName !== 'SELECT') return { success: false, error: 'Element is not a <select>: ' + selectEl.tagName };
                    var matched = false;
                    for (var i = 0; i < selectEl.options.length; i++) {
                        var opt = selectEl.options[i];
                        if ((args.value !== undefined && opt.value === args.value) || (args.text !== undefined && opt.text === args.text)) {
                            selectEl.selectedIndex = i;
                            matched = true;
                            break;
                        }
                    }
                    if (!matched) {
                        var available = Array.prototype.slice.call(selectEl.options).map(function(o) { return { value: o.value, text: o.text }; });
                        return { success: false, error: 'Option not found', availableOptions: available };
                    }
                    var elWin = selectEl.ownerDocument.defaultView || target.iframe.contentWindow;
                    selectEl.dispatchEvent(new elWin.Event('change', { bubbles: true }));
                    var _selText = selectEl.options[selectEl.selectedIndex].text;
                    return { success: true, message: 'Selected "' + _selText + '" (value=' + selectEl.value + ')', selectedValue: selectEl.value, selectedText: _selText };
                } catch(e) {
                    return { success: false, error: 'select_option failed: ' + e.message };
                }

            case 'impersonate':
                if (!args.user) return { success: false, error: 'user is required (username, name, sys_id, or "stop")' };
                try {
                    var impHeaders = { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' };
                    if (args.user === 'stop') {
                        if (!impersonateOriginalUserSysId) {
                            return { success: false, error: 'No active impersonation to stop (original user sys_id not stored).' };
                        }
                        var stopRes = await fetch('/api/now/ui/impersonate/' + impersonateOriginalUserSysId, {
                            method: 'POST',
                            headers: Object.assign({ 'Content-Type': 'application/json' }, impHeaders)
                        });
                        if (!stopRes.ok) return { success: false, error: 'Failed to stop impersonation: HTTP ' + stopRes.status };
                        impersonateOriginalUserSysId = null;
                        appStorage.removeItem('impersonateOriginalUserSysId');
                        Platform.sendBrowserAction('reload', {});
                        return { success: true, message: 'Impersonation ended. Switched back to original user. Iframe reloaded.' };
                    }
                    // Store original user sys_id before first impersonation
                    if (!impersonateOriginalUserSysId) {
                        if (cachedUserSysId) {
                            impersonateOriginalUserSysId = cachedUserSysId;
                            appStorage.setItem('impersonateOriginalUserSysId', impersonateOriginalUserSysId);
                        } else {
                            var meRes = await fetch('/api/now/table/sys_user?sysparm_query=user_name=' + encodeURIComponent(window.NOW?.user_name || 'admin') + '&sysparm_fields=sys_id&sysparm_limit=1', { headers: impHeaders });
                            var meData = await meRes.json();
                            if (meData.result && meData.result[0]) {
                                impersonateOriginalUserSysId = meData.result[0].sys_id;
                                appStorage.setItem('impersonateOriginalUserSysId', impersonateOriginalUserSysId);
                                cachedUserSysId = impersonateOriginalUserSysId;
                            }
                        }
                    }
                    // Resolve user sys_id
                    var userSysId = args.user;
                    if (!/^[0-9a-f]{32}$/.test(args.user)) {
                        var lookupRes = await fetch('/api/now/table/sys_user?sysparm_query=user_name=' + encodeURIComponent(args.user) + '^ORnameLIKE' + encodeURIComponent(args.user) + '&sysparm_fields=sys_id,user_name,name&sysparm_limit=5', { headers: impHeaders });
                        var lookupData = await lookupRes.json();
                        if (!lookupData.result || lookupData.result.length === 0) {
                            return { success: false, error: 'User not found: ' + args.user };
                        }
                        userSysId = lookupData.result[0].sys_id;
                    }
                    // Call impersonation API
                    var impRes = await fetch('/api/now/ui/impersonate/' + userSysId, {
                        method: 'POST',
                        headers: Object.assign({ 'Content-Type': 'application/json' }, impHeaders)
                    });
                    if (!impRes.ok) {
                        return { success: false, error: 'Impersonation failed: HTTP ' + impRes.status };
                    }
                    Platform.sendBrowserAction('reload', {});
                    return { success: true, message: 'Now impersonating user (sys_id: ' + userSysId + '). Iframe reloaded.' };
                } catch(e) {
                    return { success: false, error: 'Impersonate failed: ' + e.message };
                }

            default:
                return { success: false, error: 'Unknown action: ' + action };
        }
    } catch(e) {
        return { success: false, error: e.message };
    }
}
