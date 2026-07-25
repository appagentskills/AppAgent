// Format element as tag#id.class1.class2 for logging
function describeEl(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).join('.');
    return s;
}

// Tab ids currently being adopted/navigated by a navigate call in this context.
// Guards against two concurrent navigates (e.g. two chats) adopting the same tab.
var _adoptionInFlight = new Set();

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

// Public entry point. Thin wrapper around the implementation that handles the
// explicit tab_id pin: it validates the tab ONCE and, after the action runs,
// mirrors the pin to the service-worker chat snapshot via _target_tab_persist
// for EVERY browser action. navigate sets its own _target_tab_persist; without
// this, the page-side chats[].targetTabId write for NON-navigate actions is
// wiped by the next agent-event, so the "pins subsequent browser actions in
// this chat to that tab" contract was broken for everything except navigate.
async function executeIframeTool(args) {
    var _pinTab = null;
    if (args && args.tab_id != null && !args.widget_id &&
        typeof chrome !== 'undefined' && chrome.tabs &&
        typeof document !== 'undefined' && !document.body.classList.contains('sidepanel-mode')) {
        try { await chrome.tabs.get(args.tab_id); }
        catch (e) { return { success: false, error: 'tab_id ' + args.tab_id + ' is not an open tab. Use list_instances to see open tab ids.' }; }
        _pinTab = args.tab_id;
    }
    // No-pin guard: when NO tab is targeted (neither an explicit tab_id nor a
    // chat targetTabId), non-navigate browser actions silently fall back to
    // the ACTIVE tab (background.js getActiveTabId) — which can be a totally
    // unrelated tab the user happens to be looking at. Detect that case up
    // front, stamp the result with which tab/URL was actually used
    // (unpinned_tab), and add a prominent tab_warning when that tab is not on
    // the connected instance. Full-tab mode only — in sidepanel mode the
    // active tab IS the intended target. Pinning behavior is unchanged.
    var _noPinTab = null;
    var _NOPIN_ACTIONS = ['get_visible_text', 'get_dom', 'click', 'fill', 'type', 'wait_for',
        'scroll', 'get_console_logs', 'get_network_requests', 'dispatch_event', 'select_option',
        'get_properties', 'set_style', 'get_page_info'];
    if (args && !args.widget_id && args.tab_id == null && _NOPIN_ACTIONS.indexOf(args.action) !== -1 &&
        typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query &&
        typeof document !== 'undefined' && !document.body.classList.contains('sidepanel-mode') &&
        !(typeof chats !== 'undefined' && typeof currentChatId !== 'undefined' &&
          chats[currentChatId] && chats[currentChatId].targetTabId)) {
        try {
            // Same query background.js getActiveTabId uses (currentWindow), so
            // the stamped unpinned_tab matches the tab the action actually hit.
            var _actTabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (_actTabs && _actTabs[0] && _actTabs[0].url) _noPinTab = { id: _actTabs[0].id, url: _actTabs[0].url };
        } catch (e) { /* tabs API unavailable — skip the guard */ }
    }
    var _ftResult = await _executeIframeToolImpl(args);
    if (_noPinTab && _ftResult && typeof _ftResult === 'object' && _ftResult.success) {
        _ftResult.unpinned_tab = { tab_id: _noPinTab.id, url: _noPinTab.url };
        var _instOrigin = null, _tabOrigin = null;
        try { if (typeof Platform !== 'undefined' && Platform.instanceUrl) _instOrigin = new URL(Platform.instanceUrl).origin; } catch (e) {}
        try { _tabOrigin = new URL(_noPinTab.url).origin; } catch (e) {}
        if (_instOrigin && _tabOrigin && _tabOrigin !== _instOrigin) {
            _ftResult.tab_warning = 'WARNING: no tab is pinned for this chat, so this action ran against the ACTIVE browser tab (tab_id ' + _noPinTab.id + ', ' + _noPinTab.url + '), which is NOT on the connected instance (' + _instOrigin + '). If this is the wrong tab, pass tab_id (see list_instances activeTabs) or navigate first to pin the right tab.';
        }
    }
    if (_pinTab != null && _ftResult && typeof _ftResult === 'object' && _ftResult._target_tab_persist == null) {
        _ftResult._target_tab_persist = _pinTab;
    }
    return _ftResult;
}

async function _executeIframeToolImpl(args) {
    var action = args.action;
    var widgetId = args.widget_id;

    // Validate required action parameter
    if (!action) {
        return { success: false, error: 'Missing required parameter "action". Valid actions: navigate, get_visible_text, get_dom, click, fill, get_console_logs, get_network_requests, close' };
    }

    // Route browser actions through the real Chrome tab (not an embedded iframe)
    // Widget actions still use local iframes in the extension page
    if (!widgetId) {
        // Explicit tab_id: pin every browser action in this chat to that exact Chrome
        // tab (e.g. an id from list_instances' activeTabs), so the caller can drive /
        // reuse a specific tab. Full-tab mode only (real tabs). A non-existent id is a
        // hard error rather than silently falling back to a new tab.
        if (args.tab_id != null && typeof chrome !== 'undefined' && chrome.tabs &&
            typeof document !== 'undefined' && !document.body.classList.contains('sidepanel-mode')) {
            // tab_id already validated by the executeIframeTool wrapper, which also
            // mirrors this pin to the SW chat snapshot (_target_tab_persist), so a
            // subsequent browser action that omits tab_id stays pinned to this tab.
            if (chats[currentChatId]) {
                chats[currentChatId].targetTabId = args.tab_id;
                if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
            }
        }
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
                // Wait for the real viewport to settle to the requested size before
                // resolving, so an immediate get_page_info doesn't read stale dims.
                var _settleDeadline = Date.now() + 1500;
                while (Date.now() < _settleDeadline) {
                    var _pi;
                    try { _pi = await Platform.sendBrowserAction('get_page_info', {}); } catch (e) { _pi = null; }
                    if (_pi && !_pi.error) {
                        var _wOk = !rw || Math.abs((_pi.viewportWidth || 0) - rw) <= 2;
                        var _hOk = !rh || Math.abs((_pi.viewportHeight || 0) - rh) <= 2;
                        if (_wOk && _hOk) break;
                    }
                    await new Promise(function(r){ setTimeout(r, 100); });
                }
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
                            var _instanceTabId = Platform.getTabForInstance(_navInstanceUrl, fullTabNavUrl);
                            if (_instanceTabId && _instanceTabId !== _existingTabId) {
                                _existingTabId = _instanceTabId;
                            }
                        }
                        // An explicit tab_id wins over instance-based tab discovery and the
                        // adoption guard: navigate exactly the tab the caller named (already
                        // validated + pinned to the chat above).
                        if (args.tab_id != null) _existingTabId = args.tab_id;
                        // Validate the recorded / cross-instance tab still exists.
                        if (_existingTabId) {
                            try { await chrome.tabs.get(_existingTabId); _reuseTab = true; } catch(e) { _existingTabId = null; }
                        }
                        // No live tab to reuse yet? Adopt an already-open tab that is already
                        // sitting on the *same* page instead of spawning a duplicate. We only
                        // adopt when an open tab has the same origin + path AND already contains
                        // every query param of the target URL, so we never hijack a tab showing a
                        // different record / catalog item. This lets iframe_tool drive a tab the
                        // user already had open (previously, navigating to a page the user already
                        // had open always created a second background tab).
                        var _adoptedTab = null;
                        if (!_reuseTab) {
                            try {
                                var _tgtU = new URL(fullTabNavUrl);
                                var _tgtPath = _tgtU.pathname.replace(/\/+$/, '');
                                // Tab ids already owned by OTHER chats — never steal those.
                                var _otherChatTabIds = {};
                                try {
                                    Object.keys(chats || {}).forEach(function(_cid) {
                                        if (_cid !== currentChatId && chats[_cid] && chats[_cid].targetTabId) {
                                            _otherChatTabIds[chats[_cid].targetTabId] = true;
                                        }
                                    });
                                } catch (e) {}
                                // Focused window id — used to skip the tab the user is looking at.
                                var _focusedWinId = null;
                                try {
                                    if (chrome.windows && chrome.windows.getLastFocused) {
                                        var _focusedWin = await chrome.windows.getLastFocused();
                                        if (_focusedWin) _focusedWinId = _focusedWin.id;
                                    }
                                } catch (e) {}
                                var _openTabs = await chrome.tabs.query({});
                                for (var _oti = 0; _oti < _openTabs.length; _oti++) {
                                    var _cand = _openTabs[_oti];
                                    if (!_cand || !_cand.url) continue;
                                    // Never adopt pinned/incognito/discarded tabs, tabs another
                                    // chat owns, or tabs another navigate is currently adopting.
                                    if (_cand.pinned || _cand.incognito || _cand.discarded) continue;
                                    if (_adoptionInFlight.has(_cand.id) || _otherChatTabIds[_cand.id]) continue;
                                    // Skip the tab the user is actively looking at (active tab of
                                    // the focused window). If we can't tell which window is
                                    // focused, err on the side of skipping every active tab.
                                    if (_cand.active && (_focusedWinId === null || _cand.windowId === _focusedWinId)) continue;
                                    var _candU;
                                    try { _candU = new URL(_cand.url); } catch (e) { continue; }
                                    if (_candU.origin !== _tgtU.origin) continue;
                                    if (_candU.pathname.replace(/\/+$/, '') !== _tgtPath) continue;
                                    // Require EXACT query equality (both directions) so we never
                                    // hijack a tab showing a more specific page (e.g. target
                                    // /incident.do must not adopt /incident.do?sys_id=X).
                                    var _paramsMatch = true;
                                    _tgtU.searchParams.forEach(function(v, k) {
                                        if (_candU.searchParams.get(k) !== v) _paramsMatch = false;
                                    });
                                    _candU.searchParams.forEach(function(v, k) {
                                        if (_tgtU.searchParams.get(k) !== v) _paramsMatch = false;
                                    });
                                    if (!_paramsMatch) continue;
                                    _existingTabId = _cand.id;
                                    _adoptedTab = _cand;
                                    _reuseTab = true;
                                    break;
                                }
                            } catch (e) { /* fall through and create a new tab */ }
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
                        if (_reuseTab && _existingTabId != null) _adoptionInFlight.add(_existingTabId);
                        try {
                            // If the adopted tab is already sitting on the exact target URL
                            // (ignoring hash / trailing slash), don't force a reload — a
                            // tabs.update would destroy the user's in-page state.
                            var _normNavUrl = function(u) {
                                try { var _x = new URL(u); return _x.origin + _x.pathname.replace(/\/+$/, '') + _x.search; }
                                catch (e) { return String(u || '').split('#')[0].replace(/\/+$/, ''); }
                            };
                            if (_reuseTab && _adoptedTab && _adoptedTab.url && _normNavUrl(_adoptedTab.url) === _normNavUrl(fullTabNavUrl)) {
                                _targetTab = _adoptedTab;
                            } else if (_reuseTab) {
                                _targetTab = await chrome.tabs.update(_existingTabId, { url: fullTabNavUrl });
                            } else {
                                _targetTab = await chrome.tabs.create({ url: fullTabNavUrl, active: false });
                                if (_earlyListener) _navTabIdEarly = _targetTab.id;
                            }
                            if (_ftChat) {
                                _ftChat.targetTabId = _targetTab.id;
                                saveChatsToStorage();
                            }
                        } finally {
                            if (_existingTabId != null) _adoptionInFlight.delete(_existingTabId);
                        }
                        // Adopted tabs were opened by the user (not the agent), so the
                        // content script may not be injected yet — inject eagerly so the
                        // very next action doesn't fail. Idempotent; mirrors the pattern
                        // background.js uses in getSnTabList.
                        if (_adoptedTab) {
                            try {
                                if (chrome.scripting && chrome.scripting.executeScript) {
                                    await chrome.scripting.executeScript({ target: { tabId: _targetTab.id }, files: ['content-script.js'] });
                                } else {
                                    chrome.runtime.sendMessage({ type: 'ensure-content-script', tabId: _targetTab.id });
                                }
                            } catch (e) {
                                try { chrome.runtime.sendMessage({ type: 'ensure-content-script', tabId: _targetTab.id }); } catch (e2) {}
                            }
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
                                    if (reason === 'removed') { resolve(); return; }
                                    chrome.runtime.sendMessage({ type: 'setup-tab-injection', tabId: _targetTab.id });
                                    // Readiness handshake: after re-arming injection, poll the
                                    // content script with a cheap action until it responds
                                    // (injected + listening) or a ~3s cap elapses. This closes
                                    // the "message port closed" race where the very next read
                                    // action hits a tab whose content script isn't ready yet.
                                    // Fully defensive: never throws, always resolves.
                                    var _readyDeadline = Date.now() + 3000;
                                    (async function _pollReady() {
                                        while (Date.now() < _readyDeadline) {
                                            try {
                                                var _ping = await Platform.sendBrowserAction('get_page_info', {});
                                                if (_ping && !_ping.error) { resolve(); return; }
                                            } catch (e) { /* not ready yet */ }
                                            await new Promise(function(r){ setTimeout(r, 150); });
                                        }
                                        // Cap reached: fall through with a brief SPA settle.
                                        var settle = (reason === 'complete') ? 1000 : 0;
                                        setTimeout(resolve, settle);
                                    })();
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

                        var _navMsg = _reuseTab
                            ? 'Navigated the existing tab (id ' + _targetTab.id + ') to ' + fullTabNavUrl + ' \u2014 same tab reused in place, not brought to the foreground'
                            : 'Opened ' + fullTabNavUrl + ' in a new background tab (id ' + _targetTab.id + ')';
                        return { success: true, message: _navMsg, _target_tab_persist: _ftPersist };
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
                        if (typeof isChatRunning !== 'function' || !isChatRunning(currentChatId)) {
                            clearInterval(_expandCheck);
                            saveChatsToStorage().then(function() {
                                expandSidePanel();
                            });
                        }
                    }, 500);
                    setTimeout(function() { clearInterval(_expandCheck); }, 60000);
                    return { success: true, message: 'Browser closed. Returning to full page view.' };
                }

                // Read actions can race a content script whose port isn't ready
                // yet right after navigate ("message port closed"). For those
                // (non-mutating) actions only, re-arm injection and retry ONCE.
                var _readRetryActions = ['get_visible_text', 'get_dom', 'get_page_info', 'get_properties', 'get_console_logs', 'get_network_requests', 'scroll'];
                var _isPortError = function(msg) {
                    return /message port closed|Receiving end does not exist|Could not establish connection/i.test(msg || '');
                };
                var extResult;
                try {
                    extResult = await Platform.sendBrowserAction(action, args);
                } catch (e) {
                    extResult = { error: 'Extension browser action failed: ' + e.message };
                }
                if (_readRetryActions.indexOf(action) !== -1) {
                    // Content script can take a moment to (re)attach after navigate,
                    // yielding "message port closed"/"Receiving end does not exist".
                    // Re-arm injection and retry with a small bounded linear backoff.
                    var _maxPortRetries = 3;
                    var _portAttempt = 0;
                    while (_portAttempt < _maxPortRetries && extResult && extResult.error && _isPortError(extResult.error)) {
                        _portAttempt++;
                        try {
                            var _retryChat = chats[currentChatId];
                            var _retryTabId = _retryChat && _retryChat.targetTabId;
                            if (_retryTabId) chrome.runtime.sendMessage({ type: 'setup-tab-injection', tabId: _retryTabId });
                        } catch (e) { /* defensive */ }
                        await new Promise(function(r){ setTimeout(r, 300 * _portAttempt); });
                        try {
                            extResult = await Platform.sendBrowserAction(action, args);
                        } catch (e2) {
                            extResult = { error: 'Extension browser action failed: ' + e2.message };
                        }
                    }
                }
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
                    // Preserve an explicit null (no-match) instead of masking it as {}, and
                    // always surface match_count so callers can branch on 0 matches cleanly.
                    var _propRes = { success: true, properties: (extResult.properties !== undefined ? extResult.properties : {}) };
                    _propRes.match_count = (extResult.match_count !== undefined ? extResult.match_count : (extResult.properties ? 1 : 0));
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
            if (_tgtWidget) {
                return { error: 'Widget "' + (_tgtWidget.title || widgetId) + '" (' + widgetId + ') exists but is not rendered in a live panel in the current chat context, so live-DOM actions (get_visible_text, get_dom, click, fill) cannot attach to it. This typically happens in a background/non-foreground chat where the widget is not mounted in the visible DOM. Re-run the widget interaction in a foreground chat. Note: edit_html still works here because it mutates the stored widget HTML directly.' };
            }
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
                    var maxLen = (typeof args.max_length === 'number' ? args.max_length : 200000);
                    if (html.length > maxLen) {
                        html = html.substring(0, maxLen) + '\n... [truncated, total: ' + html.length + ' chars]';
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
                
                // Update widget HTML (keep the pre-edit html: saveDashboardWidget's
                // history diff needs it when the record IS `widget`, see below)
                var _prevHtml = widget.html;
                widget.html = editResult.content;
                // Bump a monotonic content version whenever the HTML changes. The
                // widget runs in a cross-origin (sandboxed, opaque-origin) iframe,
                // so its live DOM can't be rasterized directly — take_screenshot
                // re-renders it in a temp tab via the ?widget= deep link. Keying that
                // deep link on this version (see 060-take-screenshot.js) guarantees a
                // fresh render after edit_html instead of a stale cached frame.
                widget.contentVersion = (widget.contentVersion || 0) + 1;
                widget.updatedAt = Date.now();
                
                // DASHBOARD COPY (#737): a pinned widget's dashboard record is a
                // SEPARATE object in its own store — update it through the same
                // merge path the manual editor uses (tools/080-widget-tools.js:627-637).
                // saveDashboardWidget MERGES DASHBOARD_CONTENT_FIELDS onto the existing
                // record so grid placement survives; _prevHtml keeps the history diff
                // working when the record IS `widget` (a dashboard-only widget resolved
                // by getWidgetById's dashboardWidgets fallback, tools/080-widget-tools.js:229).
                if (typeof dashboardWidgets !== 'undefined' && dashboardWidgets[widgetId]
                    && typeof saveDashboardWidget === 'function') {
                    try { await saveDashboardWidget(widget, false, _prevHtml); } catch (e) {}
                }
                
                // Persist changes into the OWNING chat — mirror saveWidgetCodeEdit
                // (tools/080-widget-tools.js:650-677): resolve the chat that actually
                // HOLDS the widget (widget.chatId is stamped at creation, but legacy
                // widgets predate it and the declared owner may be gone), push-if-
                // missing, and for a DASHBOARD-ONLY widget (source chat deleted) skip
                // the chat write — the dashboard write above is its durable copy —
                // instead of silently dropping the edit while reporting success (#737).
                var _owningChatId = widget.chatId || currentChatId;
                var _holdsWidget = function(c) {
                    return !!(c && Array.isArray(c.widgets)
                        && c.widgets.some(function(w) { return w && w.id === widgetId; }));
                };
                var chat = _owningChatId ? chats[_owningChatId] : null;
                if (!_holdsWidget(chat)) {
                    var _cIds = Object.keys(chats);
                    for (var _ci = 0; _ci < _cIds.length; _ci++) {
                        if (_holdsWidget(chats[_cIds[_ci]])) {
                            _owningChatId = _cIds[_ci];
                            chat = chats[_owningChatId];
                            break;
                        }
                    }
                    if (!_holdsWidget(chat) && typeof dashboardWidgets !== 'undefined'
                        && dashboardWidgets[widgetId] === widget) {
                        chat = null;
                    }
                }
                if (chat) {
                    if (!Array.isArray(chat.widgets)) chat.widgets = [];
                    var idx = chat.widgets.findIndex(function(w) { return w.id === widgetId; });
                    if (idx !== -1) {
                        chat.widgets[idx].html = widget.html;
                        chat.widgets[idx].contentVersion = widget.contentVersion;
                        chat.widgets[idx].updatedAt = widget.updatedAt;
                    } else {
                        chat.widgets.push(widget);
                    }
                    // MEMFIX: rehydrate evicted payloads BEFORE persisting — both realms'
                    // put-loops skip a _payloadsEvicted chat (ui/070-dashboard-ui.js:2011,
                    // worker/115-storage.js:178), and the page loader flags every chat
                    // outside the newest 8 (ui/070-dashboard-ui.js:1804-1815). Without this
                    // the await below commits NOTHING for a cross-chat / non-recent owning
                    // chat and the edit is lost on reload. Must run AFTER the mutation above
                    // and immediately BEFORE the save: hydration awaits, so doing it earlier
                    // lets an SW chat-snapshot replace (app/045-agent-port-bridge-page.js:550)
                    // land mid-await and leave `chat` dangling; doing it after the save is
                    // useless because the put has already been skipped.
                    // Same pattern as tools/100-prompt-user.js:267-278 and
                    // ui/170-chat-management.js:1086-1093. ensureChatPayloads never rejects
                    // and is a cheap no-op when the flag is clear; never clear
                    // _payloadsEvicted by hand — extractChatPayloadsForPut would then put a
                    // stripped record and destroy a legacy-inline row's only durable base64.
                    if (chat._payloadsEvicted && typeof ensureChatPayloads === 'function') {
                        try { await ensureChatPayloads(_owningChatId); } catch (e) {}
                    }
                    // Await the IndexedDB commit: a take_screenshot(widget) that runs
                    // right after this edit deep-links a temp tab that reads the widget
                    // html back from IndexedDB. If the write hasn't committed the temp
                    // tab renders the PRE-edit html, broadcasts the old contentVersion,
                    // never matches the capture guard, and falls back to a stale frame
                    // after the 5s safety-net.
                    await saveChatsToStorage();
                } else if (typeof dashboardWidgets === 'undefined' || !dashboardWidgets[widgetId]) {
                    // No chat holds it and it has no dashboard record: the edit is
                    // in-memory only. Same loud warn as saveWidgetCodeEdit's no-home path.
                    console.warn('[iframe-tool] edit_html: no owning chat or dashboard record for '
                        + widgetId + ' — edit NOT persisted');
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
                // Propagate the updated html + contentVersion to the service worker's
                // authoritative chat object. The SW's saveChatsToStorage() does a full
                // store.clear()+rewrite of the chat store from SW memory after each tool
                // result; without this the SW still holds the PRE-edit widget and
                // clobbers the page-side IndexedDB save back to the old html. The
                // take_screenshot deep-link temp tab then loadChatsFromStorage()'s that
                // stale html and re-renders the OLD widget — the byte-identical
                // post-edit screenshot. The SW mirror upserts by id (worker/120-tool-routing.js).
                result._widget_persist = widget;
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
                    if (!elements.length) return { success: true, count: 0, match_count: 0, elements: [], properties: null };
                    var include = args.include || ['rect', 'styles', 'value', 'attributes'];
                    var results = [];
                    var limit = Math.min(elements.length, 20);
                    for (var i = 0; i < limit; i++) {
                        var el = elements[i];
                        var elWin = el.ownerDocument.defaultView || target.iframe.contentWindow;
                        var _clsStr = (typeof el.className === 'string') ? el.className : ((el.getAttribute && el.getAttribute('class')) || '');
                        var info = { tagName: el.tagName.toLowerCase(), visible: el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0, className: _clsStr, classList: _clsStr ? _clsStr.trim().split(/\s+/).filter(Boolean) : [] };
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
                    // `properties` mirrors the extension path (first match) so callers get one
                    // consistent shape regardless of which backend served the request.
                    return { success: true, count: elements.length, match_count: elements.length, elements: results, properties: results[0] || null };
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
                    var allowedEvents = ['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'contextmenu', 'change', 'input', 'focus', 'blur', 'submit', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'keydown', 'keyup'];
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
                    } else if (['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'contextmenu'].indexOf(args.event) !== -1) {
                        // Real MouseEvent (not a generic Event) so frameworks see a genuine pointer interaction.
                        var _mr = el.getBoundingClientRect();
                        var _nb = (args.event === 'mouseenter' || args.event === 'mouseleave');
                        eventObj = new elWin.MouseEvent(args.event, {
                            bubbles: !_nb,
                            cancelable: true,
                            view: elWin,
                            button: 0,
                            buttons: (args.event === 'mousedown' ? 1 : 0),
                            clientX: Math.round(_mr.left + _mr.width / 2),
                            clientY: Math.round(_mr.top + _mr.height / 2)
                        });
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
