// AppAgent Chrome Extension - Background Service Worker
// Detects ServiceNow tabs via window.g_ck (works for any domain including localhost/vanity URLs)
// Injects content script only into confirmed SN tabs — no manifest content_scripts needed

// Track known ServiceNow tabs (populated by probing for g_ck on page load)
let snTabs = new Map(); // tabId -> { url, title, origin }

// Track known SN domains for dynamic www-authenticate header removal rules
let snDomains = new Set();

// Track tab opened for login (auto-close after getting token)
let loginTabId = null;

// --- ServiceNow detection ---

// Probe a tab for ServiceNow by checking window.g_ck in the page's JS context
async function probeTab(tabId) {
    try {
        var results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: function() {
                return {
                    token: window.g_ck || '',
                    userName: (window.NOW && window.NOW.user_name) || '',
                    origin: window.location.origin
                };
            }
        });
        return results && results[0] && results[0].result || null;
    } catch(e) {
        return null; // Can't inject (chrome://, edge cases)
    }
}

// Called when a tab finishes loading — detect SN and inject content script
async function onTabReady(tabId) {
    var info = await probeTab(tabId);
    var isSn = info && info.token;

    if (isSn) {
        // It's a ServiceNow page — track it
        var tab;
        try { tab = await chrome.tabs.get(tabId); } catch(e) { return; }
        snTabs.set(tabId, { url: tab.url, title: tab.title, origin: info.origin });

        // Update stored session
        var data = { sessionToken: info.token };
        if (info.origin) data.instanceUrl = info.origin;
        if (info.userName) data.userName = info.userName;
        chrome.storage.local.set(data);

        // Maintain a per-origin token cache so the heartbeat works even when
        // tabs are discarded by Chrome's Memory Saver (no JS context to probe).
        if (info.origin && info.token) {
            chrome.storage.local.get('instanceTokens', function(d) {
                var map = (d && d.instanceTokens) || {};
                map[info.origin] = { token: info.token, userName: info.userName || '', updated: Date.now() };
                chrome.storage.local.set({ instanceTokens: map });
            });
        }

        // Add domain to header rules
        try {
            var domain = new URL(info.origin).hostname;
            if (!snDomains.has(domain)) {
                snDomains.add(domain);
                updateHeaderRules();
            }
        } catch(e) {}
    } else {
        snTabs.delete(tabId);
    }

    // Inject content script + MAIN world interceptors for SN tabs
    // (non-SN pages the agent navigates to are handled by injectAgentScripts after navigate)
    if (isSn) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content-script.js']
            });
        } catch(e) {}
        // Inject console/network interceptors in MAIN world (bypasses page CSP)
        await injectInterceptors(tabId);
    }

    // Auto-close login tab once we got a token from it
    if (isSn && loginTabId && tabId === loginTabId) {
        chrome.tabs.remove(loginTabId).catch(function() {});
        loginTabId = null;
    }
}

// Inject console/network interceptors into page context via MAIN world execution
// This bypasses CSP restrictions that block the content script's inline <script> approach
async function injectInterceptors(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: function() {
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
            }
        });
    } catch(e) {}
}

// --- Dynamic header rules ---

// Update declarativeNetRequest rules to remove www-authenticate for known SN domains
// This prevents browser auth popups when SN returns 401
async function updateHeaderRules() {
    try {
        var domains = Array.from(snDomains);
        if (domains.length === 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [1000]
            });
            return;
        }
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [1000],
            addRules: [{
                id: 1000,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    responseHeaders: [
                        { header: 'www-authenticate', operation: 'remove' }
                    ]
                },
                condition: {
                    requestDomains: domains,
                    resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame']
                }
            }]
        });
    } catch(e) {}
}

// --- Helpers ---

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Re-open app as a full tab after chrome.runtime.reload().
// sidePanel.open() requires a user gesture so a tab is the only reliable option.
chrome.storage.local.get('reopenAppTab', function(data) {
    if (data.reopenAppTab) {
        chrome.storage.local.remove('reopenAppTab');
        chrome.tabs.create({ url: chrome.runtime.getURL('app.html?mode=tab') });
    }
});

// Strip Origin header from extension-initiated requests only (web_fetch tool)
// Scoped to extension origin so page-initiated XHR (SSO/SAML flows) keep their Origin intact
chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [2000],
    addRules: [{
        id: 2000,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: { resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] }
    }]
}).catch(function() {});

async function getActiveTabId() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] ? tabs[0].id : null;
}

// Get ServiceNow tabs. Uses tracked tabs, falls back to probing all tabs for g_ck
// (fallback needed after service worker restart when snTabs map is lost)
async function getSnTabList() {
    if (snTabs.size > 0) {
        var list = [];
        snTabs.forEach(function(info, tabId) {
            list.push({ id: tabId, url: info.url, title: info.title, origin: info.origin });
        });
        return list;
    }
    // Fallback: probe all tabs for g_ck (e.g. after service worker restart)
    var tabs = await chrome.tabs.query({});
    var list = [];
    for (var i = 0; i < tabs.length; i++) {
        var info = await probeTab(tabs[i].id);
        if (info && info.token) {
            var origin = info.origin || new URL(tabs[i].url).origin;
            var entry = { url: tabs[i].url, title: tabs[i].title, origin: origin };
            snTabs.set(tabs[i].id, entry);
            list.push({ id: tabs[i].id, url: tabs[i].url, title: tabs[i].title, origin: origin });
            // Also inject content script since we just rediscovered this tab
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tabs[i].id },
                    files: ['content-script.js']
                });
            } catch(e) {}
        }
    }
    return list;
}

// --- Notifications ---

chrome.notifications.onClicked.addListener(function(notificationId) {
    // Focus the AppAgent tab or open side panel when notification is clicked
    if (notificationId.startsWith('appagent-')) {
        chrome.tabs.query({ url: chrome.runtime.getURL('app.html*') }, function(tabs) {
            if (tabs.length > 0) {
                chrome.tabs.update(tabs[0].id, { active: true });
                chrome.windows.update(tabs[0].windowId, { focused: true });
            } else {
                // No full-page tab open — try to open side panel on the focused window
                chrome.windows.getCurrent(function(win) {
                    chrome.sidePanel.open({ windowId: win.id }).catch(function() {});
                });
            }
        });
        chrome.notifications.clear(notificationId);
    }
});

// --- Message relay ---

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {

    // Show browser notification (from app when agent finishes in background)
    if (message.type === 'show-notification') {
        chrome.notifications.create('appagent-' + Date.now(), {
            type: 'basic',
            iconUrl: 'icons/AppAgentIconStarOnly_128.png',
            title: message.title || 'AppAgent',
            message: message.message || ''
        });
        return;
    }

    // Side panel requests browser action -> forward to content script in active tab
    if (message.type === 'browser-action') {
        if (message.action === 'navigate') {
            handleNavigate(message.args, message.targetTabId, sendResponse);
            return true;
        }

        if (message.action === 'take_screenshot') {
            handleScreenshot(message.targetTabId, sendResponse);
            return true;
        }

        if (message.action === 'resize') {
            (async function() {
                try {
                    var tabId = message.targetTabId || await getActiveTabId();
                    if (!tabId) { sendResponse({ error: 'No tab found.' }); return; }
                    var tab = await chrome.tabs.get(tabId);
                    var win = await chrome.windows.get(tab.windowId);
                    // Compensate for chrome UI + sidebar: window size - tab viewport = overhead
                    var overheadW = win.width - (tab.width || 0);
                    var overheadH = win.height - (tab.height || 0);
                    var args = message.args || {};
                    var requestedW = args.width || 0;
                    var requestedH = args.height || 0;
                    var w = requestedW ? requestedW + overheadW : undefined;
                    var h = requestedH ? requestedH + overheadH : undefined;
                    await chrome.windows.update(tab.windowId, { width: w, height: h });
                    // Verify actual resulting dimensions
                    await new Promise(function(r) { setTimeout(r, 100); });
                    var updatedTab = await chrome.tabs.get(tabId);
                    var actualW = updatedTab.width || 0;
                    var actualH = updatedTab.height || 0;
                    // If viewport is still too large, apply CSS-based viewport emulation
                    var emulated = false;
                    if (requestedW && actualW > requestedW + 5) {
                        try {
                            await chrome.tabs.sendMessage(tabId, {
                                action: 'viewport_emulate',
                                args: { width: requestedW, enable: true }
                            });
                            emulated = true;
                        } catch(e) { /* content script may not be loaded */ }
                    } else if (requestedW) {
                        // Remove any previous emulation if viewport fits
                        try {
                            await chrome.tabs.sendMessage(tabId, {
                                action: 'viewport_emulate',
                                args: { enable: false }
                            });
                        } catch(e) {}
                    }
                    sendResponse({ success: true, actualWidth: actualW, actualHeight: actualH, emulated: emulated });
                } catch(e) { sendResponse({ error: e.message }); }
            })();
            return true;
        }

        if (message.action === 'close') {
            sendResponse({ success: true });
            return;
        }

        // Forward to content script in chat's target tab (or active tab as fallback)
        (async function() {
            var tabId = null;
            if (message.targetTabId) {
                try { await chrome.tabs.get(message.targetTabId); tabId = message.targetTabId; } catch(e) {
                    sendResponse({ error: 'Target tab was closed. Use navigate to open a new page.' });
                    return;
                }
            } else {
                tabId = await getActiveTabId();
            }
            if (!tabId) {
                sendResponse({ error: 'No active tab found.' });
                return;
            }
            chrome.tabs.sendMessage(tabId, message, function(response) {
                if (chrome.runtime.lastError) {
                    // Content script not injected (e.g. extension reloaded) — inject and retry once
                    injectAgentScripts(tabId).then(function() {
                        chrome.tabs.sendMessage(tabId, message, function(resp2) {
                            if (chrome.runtime.lastError) {
                                sendResponse({ error: chrome.runtime.lastError.message });
                            } else {
                                sendResponse(resp2);
                            }
                        });
                    });
                } else {
                    sendResponse(response);
                }
            });
        })();
        return true;
    }

    // Refresh ServiceNow token by extracting g_ck from an open SN tab
    if (message.type === 'refresh-sn-token') {
        handleRefreshToken(sendResponse);
        return true;
    }

    // Open a ServiceNow page for re-authentication
    if (message.type === 'open-sn-for-login') {
        handleOpenSnForLogin(sendResponse);
        return true;
    }

    // Side panel queries live SN connection status
    if (message.type === 'check-sn-status') {
        getSnTabList().then(function(tabs) {
            if (tabs.length === 0) {
                sendResponse({ connected: false });
            } else {
                sendResponse({ connected: true, url: tabs[0].origin, tabCount: tabs.length });
            }
        });
        return true;
    }

    // List all ServiceNow instances (tabs grouped by origin)
    if (message.type === 'list-sn-instances') {
        getSnTabList().then(function(tabs) {
            var instances = {};
            tabs.forEach(function(tab) {
                var origin = tab.origin;
                if (!instances[origin]) instances[origin] = { url: origin, tabs: [] };
                instances[origin].tabs.push({ id: tab.id, title: tab.title, url: tab.url });
            });
            sendResponse({ instances: Object.values(instances) });
        });
        return true;
    }

    // List all instances WITH tokens and user info (for multi-instance support)
    if (message.type === 'list-sn-instances-detailed') {
        (async function() {
            var tabs = await getSnTabList();
            var byOrigin = {};
            tabs.forEach(function(tab) {
                var origin = tab.origin;
                if (!byOrigin[origin]) byOrigin[origin] = { url: origin, tabs: [] };
                byOrigin[origin].tabs.push({ id: tab.id, title: tab.title, url: tab.url });
            });
            var result = [];
            for (var url in byOrigin) {
                var inst = byOrigin[url];
                var tokenData = null;
                for (var t = 0; t < inst.tabs.length; t++) {
                    try {
                        var results = await chrome.scripting.executeScript({
                            target: { tabId: inst.tabs[t].id },
                            world: 'MAIN',
                            func: function() { return { token: window.g_ck || '', userName: (window.NOW && window.NOW.user_name) || '' }; }
                        });
                        tokenData = results && results[0] && results[0].result;
                        if (tokenData && tokenData.token) break;
                    } catch(e) {}
                }
                var token = (tokenData && tokenData.token) || '';
                var userName = (tokenData && tokenData.userName) || '';

                // Fallback: if we have a token but no username, look it up via the sys_user table.
                if (token && !userName) {
                    try {
                        var apiRes = await fetch(inst.url + '/api/now/table/sys_user?sysparm_query=sys_id=javascript:gs.getUserID()&sysparm_fields=user_name,name&sysparm_limit=1', {
                            method: 'GET',
                            headers: { 'X-UserToken': token, 'Accept': 'application/json' }
                        });
                        if (apiRes.ok) {
                            var apiData = await apiRes.json();
                            var row = apiData && apiData.result && apiData.result[0];
                            if (row) {
                                userName = row.user_name || row.name || '';
                            }
                        }
                    } catch(e) {}
                }

                // Fetch direct (non-inherited) roles for the current user.
                // Used by the picker UI to show privilege badges (admin / security_admin / snc_external)
                // and by the list_instances agent tool for full role context.
                var roles = [];
                if (token) {
                    try {
                        var rolesRes = await fetch(inst.url + '/api/now/table/sys_user_has_role?sysparm_query=user=javascript:gs.getUserID()^inherited=false&sysparm_fields=role.name&sysparm_limit=50', {
                            method: 'GET',
                            headers: { 'X-UserToken': token, 'Accept': 'application/json' }
                        });
                        if (rolesRes.ok) {
                            var rolesData = await rolesRes.json();
                            var rows = (rolesData && rolesData.result) || [];
                            for (var ri = 0; ri < rows.length; ri++) {
                                var rname = rows[ri] && rows[ri]['role.name'];
                                if (rname) roles.push(rname);
                            }
                        }
                    } catch(e) {}
                }

                result.push({
                    url: inst.url,
                    tabs: inst.tabs,
                    token: token,
                    userName: userName,
                    roles: roles
                });
            }
            sendResponse({ instances: result });
        })();
        return true;
    }

    // Get a fresh token for a specific instance URL
    if (message.type === 'get-token-for-instance') {
        (async function() {
            var tabs = await getSnTabList();
            var matchTabs = tabs.filter(function(t) { return t.origin === message.instanceUrl; });
            if (!matchTabs.length) {
                sendResponse({ token: '', error: 'No open tab for ' + message.instanceUrl });
                return;
            }
            for (var i = 0; i < matchTabs.length; i++) {
                try {
                    var results = await chrome.scripting.executeScript({
                        target: { tabId: matchTabs[i].id },
                        world: 'MAIN',
                        func: function() { return { token: window.g_ck || '', userName: (window.NOW && window.NOW.user_name) || '' }; }
                    });
                    var data = results && results[0] && results[0].result;
                    if (data && data.token) {
                        sendResponse({ token: data.token, userName: data.userName, tabId: matchTabs[i].id });
                        return;
                    }
                } catch(e) {}
            }
            sendResponse({ token: '', error: 'Could not get token from tabs for ' + message.instanceUrl });
        })();
        return true;
    }

    // Switch active ServiceNow instance
    if (message.type === 'switch-sn-instance') {
        chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            world: 'MAIN',
            func: function() { return { token: window.g_ck || '', userName: (window.NOW && window.NOW.user_name) || '' }; }
        }).then(function(results) {
            var data = results && results[0] && results[0].result || {};
            var updates = { instanceUrl: message.instanceUrl };
            if (data.token) updates.sessionToken = data.token;
            if (data.userName) updates.userName = data.userName;
            chrome.storage.local.set(updates);
            sendResponse({ success: true, token: data.token || '' });
        }).catch(function() {
            chrome.storage.local.set({ instanceUrl: message.instanceUrl });
            sendResponse({ success: true, token: '' });
        });
        return true;
    }

    // Get token from a specific ServiceNow tab
    if (message.type === 'get-instance-token') {
        chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            world: 'MAIN',
            func: function() { return window.g_ck || ''; }
        }).then(function(results) {
            sendResponse({ token: (results && results[0] && results[0].result) || '' });
        }).catch(function() {
            sendResponse({ token: '' });
        });
        return true;
    }

    // Open the side panel programmatically
    if (message.type === 'open-side-panel') {
        (async function() {
            try {
                var wnd = await chrome.windows.getCurrent();
                await chrome.sidePanel.open({ windowId: wnd.id });
                sendResponse({ success: true });
            } catch (e) {
                sendResponse({ error: e.message });
            }
        })();
        return true;
    }

    // Fetch arbitrary URLs (for web_fetch tool)
    if (message.type === 'web-fetch') {
        (async function() {
            try {
                var opts = {
                    method: message.method || 'GET',
                    headers: message.headers || {}
                };
                if (message.body && ['POST', 'PUT', 'PATCH'].includes(opts.method)) {
                    opts.body = message.body;
                }
                opts.cache = 'no-store';
                var res = await fetch(message.url, opts);
                var contentType = res.headers.get('content-type') || '';
                var body;
                if (message.save_file) {
                    // Read as base64 data URL for file storage
                    var blob = await res.blob();
                    body = await new Promise(function(resolve) {
                        var reader = new FileReader();
                        reader.onload = function() { resolve(reader.result); };
                        reader.readAsDataURL(blob);
                    });
                } else {
                    body = await res.text();
                }
                sendResponse({
                    status: res.status,
                    content_type: contentType,
                    body: body
                });
            } catch (e) {
                sendResponse({ error: e.message });
            }
        })();
        return true;
    }

    // Full-page navigate requests script injection when tab finishes loading
    if (message.type === 'setup-tab-injection') {
        var injTabId = message.tabId;
        // Listen for future load (with cleanup if tab closes before completing)
        function _injListener(tid, changeInfo) {
            if (tid !== injTabId || changeInfo.status !== 'complete') return;
            _injCleanup();
            if (!snTabs.has(injTabId)) injectAgentScripts(injTabId);
        }
        function _injOnRemoved(tid) { if (tid === injTabId) _injCleanup(); }
        function _injCleanup() {
            chrome.tabs.onUpdated.removeListener(_injListener);
            chrome.tabs.onRemoved.removeListener(_injOnRemoved);
        }
        chrome.tabs.onUpdated.addListener(_injListener);
        chrome.tabs.onRemoved.addListener(_injOnRemoved);
        // If tab is already complete, fire immediately (race: load finished before listener added)
        chrome.tabs.get(injTabId, function(tab) {
            if (chrome.runtime.lastError || !tab) { _injCleanup(); return; }
            if (tab.status === 'complete') _injListener(injTabId, { status: 'complete' });
        });
        return;
    }

    // GitHub API proxy (avoids CORS issues for GitHub API calls)
    if (message.type === 'github-api') {
        (async function() {
            try {
                var ghData = await chrome.storage.local.get(['githubToken', 'githubInstanceUrl']);
                var token = message.token || ghData.githubToken;
                var instanceUrl = message.instanceUrl || ghData.githubInstanceUrl || 'https://github.com';
                if (!token) { sendResponse({ error: 'No GitHub token configured' }); return; }
                var apiBase = instanceUrl === 'https://github.com' ? 'https://api.github.com' : instanceUrl.replace(/\/$/, '') + '/api/v3';
                var url = apiBase + message.path;
                var headers = {
                    'Authorization': 'Bearer ' + token,
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                };
                if (message.contentType) headers['Content-Type'] = message.contentType;
                var opts = { method: message.method || 'GET', headers: headers, cache: 'no-store' };
                if (message.body) opts.body = typeof message.body === 'string' ? message.body : JSON.stringify(message.body);
                var res = await fetch(url, opts);
                var body = await res.text();
                var parsed = null;
                try { parsed = JSON.parse(body); } catch(e) { /* not JSON */ }
                sendResponse({ status: res.status, ok: res.ok, body: parsed || body });
            } catch (e) {
                sendResponse({ error: e.message });
            }
        })();
        return true;
    }

    // GitHub token validation
    if (message.type === 'github-validate-token') {
        (async function() {
            try {
                var instanceUrl = message.instanceUrl || 'https://github.com';
                var apiBase = instanceUrl === 'https://github.com' ? 'https://api.github.com' : instanceUrl.replace(/\/$/, '') + '/api/v3';
                var res = await fetch(apiBase + '/user', {
                    headers: {
                        'Authorization': 'Bearer ' + message.token,
                        'Accept': 'application/vnd.github+json'
                    },
                    cache: 'no-store'
                });
                if (res.ok) {
                    var user = await res.json();
                    sendResponse({ ok: true, login: user.login, avatar_url: user.avatar_url, name: user.name });
                } else {
                    sendResponse({ ok: false, status: res.status, error: 'Invalid token or insufficient permissions' });
                }
            } catch (e) {
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }

    // Side panel queries active tab info
    if (message.type === 'get-active-tab-info') {
        (async function() {
            var tabId = await getActiveTabId();
            if (tabId) {
                chrome.tabs.get(tabId, function(tab) {
                    if (chrome.runtime.lastError || !tab) {
                        sendResponse({ tabId: null });
                    } else {
                        sendResponse({ tabId: tab.id, url: tab.url, title: tab.title });
                    }
                });
            } else {
                sendResponse({ tabId: null });
            }
        })();
        return true;
    }
});

// --- Navigation handlers ---

async function handleNavigate(args, targetTabId, sendResponse) {
    if (!args || !args.url) { sendResponse({ error: 'Missing url argument.' }); return; }
    var url = args.url;

    var data = await chrome.storage.local.get('instanceUrl');
    if (url.startsWith('/')) {
        if (!data.instanceUrl) {
            sendResponse({ error: 'No ServiceNow instance connected. Visit a ServiceNow page first.' });
            return;
        }
        url = data.instanceUrl + url;
    }

    // Use chat's target tab if provided, otherwise fall back to active tab
    var tabId = null;
    if (targetTabId) {
        try { await chrome.tabs.get(targetTabId); tabId = targetTabId; } catch(e) {
            sendResponse({ error: 'Target tab was closed. Use navigate to open a new page.' });
            return;
        }
    } else {
        tabId = await getActiveTabId();
    }
    if (!tabId) {
        sendResponse({ error: 'No active tab found.' });
        return;
    }

    // Pre-register listener BEFORE chrome.tabs.update to avoid missing 'complete'
    // for fast/cached loads.
    var _waitMs = (typeof args.wait === 'number') ? args.wait : (args.wait ? 15000 : 0);
    var _navTabId = tabId;
    var _completeFired = false;
    var _waitResolved = false;
    var _waitResolve = null;
    function _injectIfNeeded() {
        if (!snTabs.has(_navTabId)) injectAgentScripts(_navTabId);
    }
    var _loadingSeen = false;
    function _navListener(tid, changeInfo) {
        if (tid !== _navTabId) return;
        if (changeInfo.status === 'loading') { _loadingSeen = true; return; }
        if (changeInfo.status !== 'complete') return;
        _completeFired = true;
        _navCleanup();
        _injectIfNeeded();
        if (_waitResolve && !_waitResolved) { _waitResolved = true; _waitResolve('complete'); }
    }
    function _navOnRemoved(tid) {
        if (tid !== _navTabId) return;
        _navCleanup();
        if (_waitResolve && !_waitResolved) { _waitResolved = true; _waitResolve('removed'); }
    }
    function _navCleanup() {
        chrome.tabs.onUpdated.removeListener(_navListener);
        chrome.tabs.onRemoved.removeListener(_navOnRemoved);
    }
    chrome.tabs.onUpdated.addListener(_navListener);
    chrome.tabs.onRemoved.addListener(_navOnRemoved);

    chrome.tabs.update(tabId, { url: url }, function(tab) {
        if (chrome.runtime.lastError) {
            _navCleanup();
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
        }
        if (_waitMs <= 0) {
            // Fire-and-forget: response immediately, listener will inject on complete
            sendResponse({ success: true, tabId: tab.id, url: url });
            return;
        }
        // Wait for page to finish loading (with timeout + same-URL fallback)
        var _to = setTimeout(function() {
            if (_waitResolved) return;
            _waitResolved = true;
            _navCleanup();
            sendResponse({ success: true, tabId: tab.id, url: url, timedOut: true });
        }, _waitMs);
        _waitResolve = function(reason) {
            clearTimeout(_to);
            clearTimeout(_sameUrlCheck);
            sendResponse({ success: true, tabId: tab.id, url: url });
        };
        if (_completeFired) { _waitResolved = true; _waitResolve('complete'); return; }
        // Same-URL no-op detection: if after 1.5s no 'loading' event has fired AND
        // the tab is 'complete' AND its URL matches the target, this was a no-op.
        var _sameUrlCheck = setTimeout(function() {
            chrome.tabs.get(_navTabId, function(t) {
                if (chrome.runtime.lastError || !t || _waitResolved) return;
                var urlMatches = t.url && t.url.split('#')[0].split('?')[0] === url.split('#')[0].split('?')[0];
                if (!_loadingSeen && t.status === 'complete' && urlMatches) {
                    _waitResolved = true;
                    _navCleanup();
                    _injectIfNeeded();
                    clearTimeout(_to);
                    sendResponse({ success: true, tabId: tab.id, url: url });
                }
            });
        }, 1500);
    });
}

// Inject content script + MAIN world interceptors into a tab
async function injectAgentScripts(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content-script.js']
        });
    } catch(e) {}
    await injectInterceptors(tabId);
}

async function handleScreenshot(targetTabId, sendResponse) {
    try {
        var windowId = null;
        var tabWidth = 1280, tabHeight = 900;
        var targetTab = null;

        // Ensure chat's target tab is active and visible before capture
        if (targetTabId) {
            try {
                targetTab = await chrome.tabs.get(targetTabId);
                windowId = targetTab.windowId;
                tabWidth = targetTab.width || 1280;
                tabHeight = targetTab.height || 900;

                if (!targetTab.active) {
                    await chrome.tabs.update(targetTabId, { active: true });
                    // Wait for tab activation event, then a short compositing delay
                    await new Promise(function(resolve) {
                        function listener(activeInfo) {
                            if (activeInfo.tabId === targetTabId) {
                                chrome.tabs.onActivated.removeListener(listener);
                                clearTimeout(fallback);
                                setTimeout(resolve, 100);
                            }
                        }
                        chrome.tabs.onActivated.addListener(listener);
                        var fallback = setTimeout(function() {
                            chrome.tabs.onActivated.removeListener(listener);
                            resolve();
                        }, 1000);
                    });
                }
            } catch(e) {
                sendResponse({ error: 'Target tab was closed. Use navigate to open a new page.' });
                return;
            }
        }

        var tabUrl = '', tabTitle = '';
        if (targetTabId) {
            tabUrl = targetTab.url || ''; tabTitle = targetTab.title || '';
        } else {
            var aid = await getActiveTabId();
            if (aid) { try { var at = await chrome.tabs.get(aid); tabUrl = at.url || ''; tabTitle = at.title || ''; } catch(e) {} }
        }
        var dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        sendResponse({ success: true, base64: dataUrl, width: tabWidth, height: tabHeight, url: tabUrl, title: tabTitle });
    } catch (e) {
        sendResponse({ error: 'Screenshot failed: ' + e.message });
    }
}

async function handleOpenSnForLogin(sendResponse) {
    try {
        var storage = await chrome.storage.local.get('instanceUrl');
        if (!storage.instanceUrl) {
            sendResponse({ error: 'No instance URL stored.' });
            return;
        }
        var tabs = await getSnTabList();
        if (tabs.length > 0) {
            var targetTab = tabs[0];
            for (var i = 0; i < tabs.length; i++) {
                if (tabs[i].origin === storage.instanceUrl) {
                    targetTab = tabs[i];
                    break;
                }
            }
            chrome.tabs.update(targetTab.id, { active: true });
            chrome.tabs.reload(targetTab.id);
            chrome.windows.update((await chrome.tabs.get(targetTab.id)).windowId, { focused: true });
            loginTabId = null;
            sendResponse({ needsLogin: true });
        } else {
            var tab = await chrome.tabs.create({ url: storage.instanceUrl, active: true });
            loginTabId = tab.id;
            sendResponse({ needsLogin: true, loginTabId: tab.id });
        }
    } catch (e) {
        sendResponse({ error: e.message });
    }
}

async function handleRefreshToken(sendResponse) {
    try {
        var storage = await chrome.storage.local.get('instanceUrl');
        var tabs = await getSnTabList();
        if (tabs.length === 0) {
            sendResponse({ error: 'No ServiceNow tab open. Open a ServiceNow page to authenticate.' });
            return;
        }

        var targetTab = tabs[0];
        if (storage.instanceUrl) {
            for (var i = 0; i < tabs.length; i++) {
                if (tabs[i].origin === storage.instanceUrl) {
                    targetTab = tabs[i];
                    break;
                }
            }
        }

        var results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            world: 'MAIN',
            func: function() { return window.g_ck || ''; }
        });

        var token = results && results[0] && results[0].result;
        if (token) {
            chrome.storage.local.set({ sessionToken: token });
            sendResponse({ token: token });
        } else {
            sendResponse({ error: 'Could not extract token. The ServiceNow page may need to be refreshed.' });
        }
    } catch (e) {
        sendResponse({ error: e.message });
    }
}

// --- Tab event listeners ---

// Probe tabs on load complete — detect SN and inject content script
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete') {
        onTabReady(tabId);
    }
    // Broadcast active tab URL changes to side panel
    if (tab.active && (changeInfo.url || changeInfo.title)) {
        chrome.runtime.sendMessage({
            type: 'active-tab-changed',
            tabId: tabId,
            url: tab.url,
            title: tab.title
        }).catch(function() {});
    }
});

chrome.tabs.onActivated.addListener(function(activeInfo) {
    chrome.tabs.get(activeInfo.tabId, function(tab) {
        if (chrome.runtime.lastError || !tab) return;
        chrome.runtime.sendMessage({
            type: 'active-tab-changed',
            tabId: tab.id,
            url: tab.url,
            title: tab.title
        }).catch(function() {});
    });
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener(function(tabId) {
    snTabs.delete(tabId);
    if (tabId === loginTabId) loginTabId = null;
});

// --- Claude OAuth (cookie-exchange flow, à la Claude Desktop) ---
//
// Reads the user's existing claude.ai session cookie and exchanges it directly
// against api.anthropic.com with PKCE. No consent UI, no auxiliary tab. Works
// for both personal accounts and SSO-enforced orgs where claude.ai's
// /oauth/authorize page returns 403.
//
// Uses Claude Desktop's public OAuth client_id (no secret — public client).
//
// Prerequisite: user is signed into claude.ai in the same Chrome profile.

var CLAUDE_OAUTH = {
    clientId: '89355bc3-cbfd-4382-905b-976645cad410',
    apiHost: 'https://api.anthropic.com',
    redirectUri: 'https://claude.ai/desktop/callback',
    scopes: 'user:inference'
};

function base64url(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makePkce() {
    var verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    var verifier = base64url(verifierBytes);
    var hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    var challenge = base64url(new Uint8Array(hash));
    var state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    return { verifier: verifier, challenge: challenge, state: state };
}

function getClaudeCookie(name) {
    return new Promise(function(resolve) {
        chrome.cookies.get({ url: 'https://claude.ai', name: name }, function(c) {
            resolve(c && c.value ? c.value : null);
        });
    });
}

async function resolveActiveOrg(sessionKey) {
    // Prefer the cookie — it's what the user last used in the UI.
    var fromCookie = await getClaudeCookie('lastActiveOrg');
    if (fromCookie) return fromCookie;

    // Fallback: ask the API which orgs this session belongs to.
    var res = await fetch(CLAUDE_OAUTH.apiHost + '/api/organizations', {
        headers: { 'Authorization': 'Bearer ' + sessionKey, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error('Could not list organizations (HTTP ' + res.status + ')');
    var orgs = await res.json();
    var list = Array.isArray(orgs) ? orgs : (orgs && orgs.organizations) || [];
    if (!list.length) throw new Error('No organizations found on this claude.ai account');
    return list[0].uuid || list[0].id;
}

async function startClaudeOAuth() {
    var sessionKey = await getClaudeCookie('sessionKey');
    if (!sessionKey) {
        throw new Error('Not signed into claude.ai. Open https://claude.ai, sign in, then retry.');
    }

    var orgId = await resolveActiveOrg(sessionKey);
    var pkce = await makePkce();

    // Step 1: authorize against api.anthropic.com using the session cookie as bearer + PKCE.
    // Server responds with { redirect_uri: "https://claude.ai/desktop/callback?code=...&state=..." }.
    var authRes = await fetch(CLAUDE_OAUTH.apiHost + '/v1/oauth/' + orgId + '/authorize', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + sessionKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            client_id: CLAUDE_OAUTH.clientId,
            organization_uuid: orgId,
            response_type: 'code',
            redirect_uri: CLAUDE_OAUTH.redirectUri,
            scope: CLAUDE_OAUTH.scopes,
            state: pkce.state,
            code_challenge: pkce.challenge,
            code_challenge_method: 'S256'
        })
    });
    if (!authRes.ok) {
        var aErr = await authRes.text();
        throw new Error('Authorize failed: ' + authRes.status + ' ' + aErr);
    }
    var authJson = await authRes.json();
    if (!authJson || !authJson.redirect_uri) throw new Error('Authorize response missing redirect_uri');

    var cbUrl;
    try { cbUrl = new URL(authJson.redirect_uri); } catch (e) { throw new Error('Invalid redirect_uri'); }
    var code = cbUrl.searchParams.get('code');
    var returnedState = cbUrl.searchParams.get('state') || '';
    if (!code) throw new Error('Authorize response missing code');
    if (returnedState && returnedState !== pkce.state) throw new Error('OAuth state mismatch');

    // Step 2: exchange the code for tokens (include code_verifier for PKCE).
    var tokRes = await fetch(CLAUDE_OAUTH.apiHost + '/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: CLAUDE_OAUTH.clientId,
            code: code,
            redirect_uri: CLAUDE_OAUTH.redirectUri,
            code_verifier: pkce.verifier,
            state: pkce.state,
            scope: CLAUDE_OAUTH.scopes
        })
    });
    if (!tokRes.ok) {
        var tErr = await tokRes.text();
        throw new Error('Token exchange failed: ' + tokRes.status + ' ' + tErr);
    }
    return saveOAuthCreds(await tokRes.json());
}

async function refreshClaudeToken(refreshToken) {
    var res = await fetch(CLAUDE_OAUTH.apiHost + '/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: CLAUDE_OAUTH.clientId,
            refresh_token: refreshToken
        })
    });
    if (!res.ok) {
        var errText = await res.text();
        throw new Error('Token refresh failed: ' + res.status + ' ' + errText);
    }
    return await res.json();
}

function saveOAuthCreds(tokenData, existingRefresh) {
    var creds = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || existingRefresh,
        expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000
    };
    chrome.storage.local.set({ claudeOAuth: creds });
    chrome.runtime.sendMessage({ type: 'claude-oauth-updated', claudeOAuth: creds }).catch(function() {});
    return creds;
}

// Handle OAuth messages from side panel and content script
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === 'claude-oauth-login') {
        startClaudeOAuth().then(function(creds) {
            sendResponse({ success: true, claudeOAuth: creds });
        }).catch(function(err) {
            sendResponse({ error: err.message });
        });
        return true;
    }
    if (message.type === 'claude-oauth-refresh') {
        chrome.storage.local.get('claudeOAuth', function(data) {
            var rt = data.claudeOAuth && data.claudeOAuth.refreshToken;
            if (!rt) { sendResponse({ error: 'No refresh token' }); return; }
            refreshClaudeToken(rt).then(function(t) {
                sendResponse({ success: true, claudeOAuth: saveOAuthCreds(t, rt) });
            }).catch(function(err) { sendResponse({ error: err.message }); });
        });
        return true;
    }
    if (message.type === 'claude-oauth-status') {
        chrome.storage.local.get('claudeOAuth', async function(data) {
            if (!data.claudeOAuth) { sendResponse({ loggedIn: false }); return; }
            var oauth = data.claudeOAuth;
            // Auto-refresh if expired or expiring within 1 minute
            if (Date.now() > oauth.expiresAt - 60000 && oauth.refreshToken) {
                try {
                    var tokenData = await refreshClaudeToken(oauth.refreshToken);
                    oauth = saveOAuthCreds(tokenData, oauth.refreshToken);
                } catch(e) {
                    // Refresh failed — login is truly expired
                    sendResponse({ loggedIn: true, expired: true, expiresAt: oauth.expiresAt });
                    return;
                }
            }
            sendResponse({
                loggedIn: true,
                expired: Date.now() > oauth.expiresAt,
                expiresAt: oauth.expiresAt
            });
        });
        return true;
    }
    if (message.type === 'claude-oauth-logout') {
        chrome.storage.local.remove('claudeOAuth');
        chrome.runtime.sendMessage({ type: 'claude-oauth-updated', claudeOAuth: null }).catch(function() {});
        sendResponse({ success: true });
        return true;
    }
    if (message.type === 'claude-oauth-usage') {
        chrome.storage.local.get('claudeRateLimits', function(data) {
            if (data.claudeRateLimits) sendResponse({ data: data.claudeRateLimits });
            else sendResponse({ error: 'No usage data yet' });
        });
        return true;
    }
});

// --- Claude OAuth Streaming Proxy via Port ---
// Transforms OpenAI-format request to Anthropic format, streams response back as OpenAI SSE

chrome.runtime.onConnect.addListener(function(port) {
    if (port.name !== 'claude-oauth-stream') return;

    var portDisconnected = false;
    var streamKeepAlive = null;
    port.onDisconnect.addListener(function() {
        portDisconnected = true;
        if (streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }
    });

    port.onMessage.addListener(async function(msg) {
        if (msg.type !== 'start-stream') return;

        try {
            var data = await chrome.storage.local.get('claudeOAuth');
            var oauth = data.claudeOAuth;
            if (!oauth || !oauth.accessToken) {
                port.postMessage({ type: 'error', error: 'Not logged in to Claude. Click the login button.' });
                port.postMessage({ type: 'done' });
                return;
            }

            // Auto-refresh if expired or expiring within 1 minute
            if (Date.now() > oauth.expiresAt - 60000) {
                try {
                    var tokenData = await refreshClaudeToken(oauth.refreshToken);
                    var now = Date.now();
                    oauth = {
                        accessToken: tokenData.access_token,
                        refreshToken: tokenData.refresh_token || oauth.refreshToken,
                        expiresAt: now + (tokenData.expires_in || 3600) * 1000
                    };
                    await chrome.storage.local.set({ claudeOAuth: oauth });
                } catch(e) {
                    port.postMessage({ type: 'error', error: 'Token refresh failed: ' + e.message });
                    port.postMessage({ type: 'done' });
                    return;
                }
            }

            var requestBody = JSON.parse(msg.body);
            var anthropicBody = transformToAnthropic(requestBody);
            var anthropicJson = JSON.stringify(anthropicBody);

            var res;
            var maxRetries = 3;
            for (var attempt = 0; attempt <= maxRetries; attempt++) {
                res = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'accept': 'text/event-stream',
                        'anthropic-version': '2023-06-01',
                        'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05',
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'authorization': 'Bearer ' + oauth.accessToken,
                        'content-type': 'application/json'
                    },
                    body: anthropicJson
                });

                if (res.status !== 529 || attempt === maxRetries) break;
                console.error('[AppAgent] 529 overloaded, retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + (4 * Math.pow(2, attempt)) + 's');
                // Exponential backoff: 4s, 8s, 16s
                await new Promise(function(r) { setTimeout(r, 4000 * Math.pow(2, attempt)); });
            }

            if (!res.ok) {
                var errText = await res.text();
                port.postMessage({ type: 'error', error: 'API error ' + res.status + ': ' + errText });
                port.postMessage({ type: 'done' });
                return;
            }

            // Capture rate limit headers (free usage data from every API response)
            var rlHeaders = {};
            res.headers.forEach(function(v, k) {
                if (k.startsWith('anthropic-ratelimit-')) rlHeaders[k] = v;
            });
            if (Object.keys(rlHeaders).length > 0) chrome.storage.local.set({ claudeRateLimits: rlHeaders });

            // Read Anthropic SSE stream and convert to OpenAI format
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var sseBuffer = '';
            var msgId = '';
            var toolIdx = 0;
            var currentToolId = null;
            var anthropicUsage = {};
            var model = anthropicBody.model;

            // Keep service worker alive during streaming — Chrome MV3 can terminate
            // workers that haven't touched a Chrome API in ~30s, even with active fetch
            streamKeepAlive = setInterval(function() {
                chrome.runtime.getPlatformInfo(function() {});
            }, 5000);

            var done = false;
            while (!done) {
                if (portDisconnected) { reader.cancel(); break; }
                var result = await reader.read();
                done = result.done;
                sseBuffer += decoder.decode(result.value, { stream: !done });

                while (sseBuffer.indexOf('\n\n') !== -1) {
                    var splitIdx = sseBuffer.indexOf('\n\n');
                    var eventStr = sseBuffer.substring(0, splitIdx);
                    sseBuffer = sseBuffer.substring(splitIdx + 2);

                    var eventType = null, eventData = null;
                    var eventLines = eventStr.split('\n');
                    for (var i = 0; i < eventLines.length; i++) {
                        if (eventLines[i].startsWith('event: ')) eventType = eventLines[i].substring(7);
                        else if (eventLines[i].startsWith('data: ')) {
                            try { eventData = JSON.parse(eventLines[i].substring(6)); } catch(e) {}
                        }
                    }
                    if (!eventType || !eventData) continue;

                    var ts = Math.floor(Date.now() / 1000);

                    if (eventType === 'message_start' && eventData.message) {
                        msgId = eventData.message.id || '';
                        Object.assign(anthropicUsage, eventData.message.usage || {});
                        port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
                        }) + '\n\n' });
                    }
                    else if (eventType === 'content_block_start') {
                        var block = eventData.content_block || {};
                        if (block.type === 'tool_use') {
                            currentToolId = block.id || ('call_' + Math.random().toString(36).substr(2, 8));
                            port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, id: currentToolId, type: 'function', function: { name: block.name || '', arguments: '' } }] }, finish_reason: null }]
                            }) + '\n\n' });
                        }
                        else if (block.type === 'thinking') {
                            var blockIdx = eventData.index || 0;
                            port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: { reasoning_details: [{ index: blockIdx, thinking: '' }] }, finish_reason: null }]
                            }) + '\n\n' });
                        }
                    }
                    else if (eventType === 'content_block_delta') {
                        var delta = eventData.delta || {};
                        if (delta.type === 'text_delta') {
                            port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: { content: delta.text || '' }, finish_reason: null }]
                            }) + '\n\n' });
                        }
                        else if (delta.type === 'input_json_delta') {
                            port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, function: { arguments: delta.partial_json || '' } }] }, finish_reason: null }]
                            }) + '\n\n' });
                        }
                        else if (delta.type === 'thinking_delta') {
                            var blockIdx = eventData.index || 0;
                            port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: { reasoning_details: [{ index: blockIdx, thinking: delta.thinking || '' }] }, finish_reason: null }]
                            }) + '\n\n' });
                        }
                        else if (delta.type === 'signature_delta') {
                            var blockIdx = eventData.index || 0;
                            port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: { reasoning_details: [{ index: blockIdx, signature: delta.signature || '' }] }, finish_reason: null }]
                            }) + '\n\n' });
                        }
                    }
                    else if (eventType === 'content_block_stop') {
                        if (currentToolId) { toolIdx++; currentToolId = null; }
                    }
                    else if (eventType === 'message_delta') {
                        Object.assign(anthropicUsage, eventData.usage || {});
                        var stopReason = (eventData.delta || {}).stop_reason;
                        if (stopReason) {
                            var finishMap = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls' };
                            var promptTokens = (anthropicUsage.input_tokens || 0) +
                                (anthropicUsage.cache_creation_input_tokens || 0) +
                                (anthropicUsage.cache_read_input_tokens || 0);
                            var completionTokens = anthropicUsage.output_tokens || 0;
                            port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: {}, finish_reason: finishMap[stopReason] || 'stop' }],
                                usage: {
                                    prompt_tokens: promptTokens, completion_tokens: completionTokens,
                                    total_tokens: promptTokens + completionTokens,
                                    cache_read_input_tokens: anthropicUsage.cache_read_input_tokens || 0,
                                    cache_creation_input_tokens: anthropicUsage.cache_creation_input_tokens || 0
                                }
                            }) + '\n\n' });
                        }
                    }
                    else if (eventType === 'error') {
                        port.postMessage({ type: 'sse', data: 'data: ' + JSON.stringify({
                            error: { message: (eventData.error || {}).message || 'Unknown error', type: 'api_error' }
                        }) + '\n\n' });
                    }
                }
            }

            clearInterval(streamKeepAlive); streamKeepAlive = null;
            port.postMessage({ type: 'sse', data: 'data: [DONE]\n\n' });
            port.postMessage({ type: 'done' });

        } catch(e) {
            clearInterval(streamKeepAlive); streamKeepAlive = null;
            try { port.postMessage({ type: 'error', error: e.message }); } catch(e2) {}
            try { port.postMessage({ type: 'done' }); } catch(e2) {}
        }
    });
});

// Transform OpenAI-format request body to Anthropic Messages API format

function convertContentPart(part) {
    if (typeof part === 'string') return { type: 'text', text: part };
    var cc = part.cache_control;
    var result;
    if (part.type === 'text') {
        result = { type: 'text', text: part.text || '' };
    } else if (part.type === 'image_url') {
        var url = (typeof part.image_url === 'string') ? part.image_url : (part.image_url || {}).url || '';
        if (url.startsWith('data:')) {
            try {
                var commaIdx = url.indexOf(',');
                var header = url.substring(0, commaIdx);
                var imgData = url.substring(commaIdx + 1);
                result = { type: 'image', source: { type: 'base64', media_type: header.split(':')[1].split(';')[0], data: imgData } };
            } catch(e) { result = { type: 'text', text: '[Invalid image]' }; }
        } else {
            result = { type: 'image', source: { type: 'url', url: url } };
        }
    } else if (part.type === 'file') {
        var fi = part.file || {};
        var fd = fi.file_data || '';
        var fn = fi.filename || '';
        if (typeof fd !== 'string') fd = fd ? String(fd) : '';
        var mediaType, data;
        if (fd && fd.startsWith('data:')) {
            try {
                var sp = fd.split(',', 2);
                mediaType = sp[0].split(':')[1].split(';')[0];
                data = sp[1];
            } catch(e) {
                mediaType = 'application/pdf';
                data = fd;
            }
        } else {
            data = fd;
            mediaType = (fn && fn.toLowerCase().endsWith('.pdf')) ? 'application/pdf' : 'application/octet-stream';
        }
        result = { type: 'document', source: { type: 'base64', media_type: mediaType, data: data } };
    } else {
        result = { type: 'text', text: JSON.stringify(part) };
    }
    if (cc) result.cache_control = cc;
    return result;
}

function transformToAnthropic(body) {
    var systemBlocks = [];
    var transformedMessages = [];

    (body.messages || []).forEach(function(msg) {
        if (msg.role === 'system') {
            var content = msg.content;
            if (typeof content === 'string') systemBlocks.push({ type: 'text', text: content });
            else if (Array.isArray(content)) {
                content.forEach(function(item) {
                    if (typeof item === 'string') systemBlocks.push({ type: 'text', text: item });
                    else if (typeof item === 'object') systemBlocks.push(item); // preserves cache_control
                });
            }
        } else {
            transformedMessages.push(transformMessageToAnthropic(msg));
        }
    });

    // Merge consecutive user messages (Anthropic requires alternating roles).
    // When merging, move cache_control to the last block.
    var merged = [];
    transformedMessages.forEach(function(msg) {
        if (merged.length > 0 && merged[merged.length - 1].role === 'user' && msg.role === 'user') {
            var prev = merged[merged.length - 1];
            var prevContent = typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : (prev.content || []);
            var currContent = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || []);
            var all = prevContent.concat(currContent);
            var cc = null;
            all.forEach(function(b) { if (b.cache_control) { cc = b.cache_control; delete b.cache_control; } });
            if (cc && all.length > 0) all[all.length - 1].cache_control = cc;
            prev.content = all;
        } else {
            merged.push(msg);
        }
    });

    var result = {
        model: body.model,
        max_tokens: body.max_tokens || 8192,
        stream: true,
        messages: merged
    };

    // Prepend Claude Code identity (required for OAuth token access)
    var ccIdentity = { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." };
    result.system = [ccIdentity].concat(systemBlocks);

    if (body.tools && body.tools.length > 0) {
        result.tools = body.tools.map(function(t) {
            if (t.type === 'function' && t.function) {
                return {
                    name: t.function.name,
                    description: t.function.description || '',
                    input_schema: t.function.parameters || { type: 'object', properties: {} }
                };
            }
            return t;
        });
        result.tool_choice = { type: 'auto' };
    }

    if (body.reasoning) {
        if (body.reasoning.effort) {
            // Claude 4.6 adaptive thinking — model decides how much to think based on effort level
            // display: 'summarized' is required for Opus 4.7+ (default changed to 'omitted')
            result.thinking = { type: 'adaptive', display: 'summarized' };
            result.output_config = { effort: body.reasoning.effort };
        } else if (body.reasoning.max_tokens) {
            // Use adaptive thinking for all models (enabled is deprecated for newer models)
            // display: 'summarized' is required for Opus 4.7+ (default changed to 'omitted')
            result.thinking = { type: 'adaptive', display: 'summarized' };
            result.output_config = { effort: 'high' };
        }
    }

    result.metadata = { user_id: 'appagent_extension' };
    return result;
}

function transformMessageToAnthropic(msg) {
    if (msg.role === 'tool') {
        // Convert tool result — extract cache_control from last content block, move to tool_result level
        var content = msg.content;
        var cc = null;
        var toolContent;
        if (typeof content === 'string') {
            toolContent = content;
        } else if (Array.isArray(content)) {
            toolContent = [];
            for (var i = 0; i < content.length; i++) {
                var converted = convertContentPart(content[i]);
                // Extract cache_control from last block, move to tool_result level
                if (i === content.length - 1 && converted.cache_control) {
                    cc = converted.cache_control;
                    delete converted.cache_control;
                }
                toolContent.push(converted);
            }
        } else {
            toolContent = String(content || '');
        }
        var toolResult = { type: 'tool_result', tool_use_id: msg.tool_call_id, content: toolContent };
        if (cc) toolResult.cache_control = cc;
        return { role: 'user', content: [toolResult] };
    }

    if (msg.role === 'assistant') {
        var blocks = [];
        if (msg.reasoning_details && Array.isArray(msg.reasoning_details)) {
            msg.reasoning_details.forEach(function(rd) {
                if (!rd.signature) return;
                blocks.push({ type: 'thinking', thinking: rd.thinking || rd.text || rd.content || '', signature: rd.signature });
            });
        }
        if (msg.content) {
            if (typeof msg.content === 'string') {
                blocks.push({ type: 'text', text: msg.content });
            } else if (Array.isArray(msg.content)) {
                msg.content.forEach(function(p) { blocks.push(convertContentPart(p)); });
            }
        }
        if (msg.tool_calls) {
            msg.tool_calls.forEach(function(tc) {
                var func = tc.function || {};
                var args = func.arguments || '{}';
                var input = (typeof args === 'string') ? (function() { try { return JSON.parse(args); } catch(e) { return {}; } })() : args;
                blocks.push({ type: 'tool_use', id: tc.id, name: func.name, input: input });
            });
        }
        return { role: 'assistant', content: blocks.length > 0 ? blocks : '' };
    }

    // User messages
    if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
    if (Array.isArray(msg.content)) {
        return { role: msg.role, content: msg.content.map(convertContentPart) };
    }
    return { role: msg.role, content: msg.content || '' };
}

// --- ServiceNow session heartbeat ---
// Calls POST /api/now/uisession/touch-session every minute on each connected
// instance to keep sessions alive (prevents idle logout / stale g_ck tokens).
async function heartbeatAllInstances() {
    // Build the union of origins we know about: live tabs + cached tokens.
    // Cached tokens let us keep pinging even when tabs have been discarded
    // by Chrome's Memory Saver (no JS context to probe via executeScript).
    var tabs = [];
    try { tabs = await getSnTabList(); } catch(e) {}
    var byOrigin = {};
    (tabs || []).forEach(function(t) { if (!byOrigin[t.origin]) byOrigin[t.origin] = t; });

    var cache = await new Promise(function(r) {
        chrome.storage.local.get('instanceTokens', function(d) { r((d && d.instanceTokens) || {}); });
    });
    Object.keys(cache).forEach(function(o) { if (!byOrigin[o]) byOrigin[o] = null; });

    var origins = Object.keys(byOrigin);
    if (!origins.length) return;

    var results = [];
    var cacheDirty = false;

    async function readTokenFromTab(tab) {
        try {
            var probe = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: function() { return window.g_ck || ''; }
            });
            return probe && probe[0] && probe[0].result || '';
        } catch (e) { return ''; }
    }

    for (var i = 0; i < origins.length; i++) {
        var origin = origins[i];
        var tab = byOrigin[origin];
        var cached = cache[origin];
        var token = (cached && cached.token) || '';
        var source = token ? 'cache' : '';

        // No cached token? Try to read from a live tab.
        if (!token && tab) {
            token = await readTokenFromTab(tab);
            if (token) {
                source = 'tab';
                cache[origin] = { token: token, userName: (cached && cached.userName) || '', updated: Date.now() };
                cacheDirty = true;
            }
        }

        if (!token) { results.push({ origin: origin, status: 'no-token' }); continue; }

        try {
            var res = await fetch(origin + '/api/now/uisession/touch-session', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': '*/*',
                    'X-UserToken': token,
                    'X-WantAuthSessionNotifications': 'true'
                }
            });

            // 401 = cached token went stale. Re-probe a live tab once and retry.
            if (res.status === 401 && tab && source === 'cache') {
                var fresh = await readTokenFromTab(tab);
                if (fresh && fresh !== token) {
                    token = fresh;
                    cache[origin] = { token: token, userName: (cached && cached.userName) || '', updated: Date.now() };
                    cacheDirty = true;
                    res = await fetch(origin + '/api/now/uisession/touch-session', {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': '*/*',
                            'X-UserToken': token,
                            'X-WantAuthSessionNotifications': 'true'
                        }
                    });
                    source = 'tab-refresh';
                }
            }

            // Drop the cache entry if the instance has logged us out for good.
            if (res.status === 401) {
                delete cache[origin];
                cacheDirty = true;
            }

            results.push({ origin: origin, status: res.status, source: source });
        } catch (e) {
            results.push({ origin: origin, status: 'error', error: String(e && e.message || e), source: source });
        }
    }

    if (cacheDirty) chrome.storage.local.set({ instanceTokens: cache });
    try {
        chrome.storage.local.set({
            heartbeatLastRun: Date.now(),
            heartbeatLastResults: results
        });
    } catch(e) {}
}

// Register a 1-minute alarm; survives service worker restarts.
chrome.alarms.create('sn-heartbeat', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(function(alarm) {
    if (alarm.name === 'sn-heartbeat') heartbeatAllInstances();
});
// Run once on startup so we don't wait a full minute for the first ping.
heartbeatAllInstances();

// Allow the side panel to trigger a manual heartbeat or read last results.
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message && message.type === 'sn-heartbeat-now') {
        heartbeatAllInstances().then(function() {
            chrome.storage.local.get(['heartbeatLastRun', 'heartbeatLastResults'], function(d) {
                sendResponse({ ok: true, lastRun: d.heartbeatLastRun, results: d.heartbeatLastResults || [] });
            });
        });
        return true;
    }
    if (message && message.type === 'sn-heartbeat-status') {
        chrome.storage.local.get(['heartbeatLastRun', 'heartbeatLastResults'], function(d) {
            sendResponse({ ok: true, lastRun: d.heartbeatLastRun || 0, results: d.heartbeatLastResults || [] });
        });
        return true;
    }
});

// --- Keep-Awake (display) ---
// Triggered by the chat page when the user has been idle for a while.
// Released by the page on user activity, tab hide, or unload.
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message && message.type === 'keep-awake-set') {
        try {
            if (message.enabled) {
                chrome.power.requestKeepAwake('display');
            } else {
                chrome.power.releaseKeepAwake();
            }
            sendResponse({ ok: true, enabled: !!message.enabled });
        } catch (e) {
            sendResponse({ ok: false, error: String(e) });
        }
        return true;
    }
});
// Safety: release any stale lock on Chrome startup.
chrome.runtime.onStartup.addListener(function() {
    try { chrome.power.releaseKeepAwake(); } catch (e) {}
});

// DNR rule: spoof User-Agent for Anthropic API requests
chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [3000],
    addRules: [{
        id: 3000,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'claude-cli/2.1.37 (external, cli)' }] },
        condition: { urlFilter: 'api.anthropic.com/*', resourceTypes: ['xmlhttprequest'] }
    }]
}).catch(function() {});
