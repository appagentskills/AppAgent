// AppAgent Chrome Extension - Background Service Worker
// Detects ServiceNow tabs via window.g_ck (works for any domain including localhost/vanity URLs)
// Injects content script only into confirmed SN tabs — no manifest content_scripts needed

// Load the agent runtime into the SW. The bundle declares chats, runningChatIds,
// runAgent, executeTool, AgentEvents, etc. as module-scope globals on the SW's
// ServiceWorkerGlobalScope. Code below this line can use those symbols freely.
// DOM-needing tools (js_eval, skills sandbox, image canvas) bridge to the
// offscreen document via chrome.runtime.sendMessage — see worker/010-platform-stub.js
// and the message handlers further down this file.
try {
    importScripts('sw-bundle.js');
} catch (e) {
    console.error('[SW] failed to import sw-bundle.js — agent runtime unavailable', e);
}

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

        // Update stored session — but never steal the ACTIVE instance: after an
        // explicit tab-less switch, an unrelated SN tab loading/reloading must
        // not overwrite instanceUrl/sessionToken with its own origin. Only adopt
        // the tab's session when nothing is stored yet or the tab belongs to the
        // currently active instance. (The per-origin instanceTokens cache below
        // is always updated regardless.)
        chrome.storage.local.get('instanceUrl', function(cur) {
            var stored = cur && cur.instanceUrl;
            if (stored && info.origin && stored !== info.origin) return;
            var data = { sessionToken: info.token };
            if (info.origin) data.instanceUrl = info.origin;
            if (info.userName) data.userName = info.userName;
            chrome.storage.local.set(data);
        });

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

// Open AppAgent in a full page tab when the toolbar icon is clicked.
// (openPanelOnActionClick must be false so the action.onClicked event fires.)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
chrome.action.onClicked.addListener(function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html?mode=tab') });
});

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

// --- Multi-instance SN helpers ---
// Shared between the chrome.runtime.onMessage handlers (used by the panel via
// platform-bridge) and the SW-side Platform stub in worker/010-platform-stub.js
// (used by the agent loop). Extracted so we have a single source of truth and
// the SW doesn't have to sendMessage to itself.

// Probe one tab for { token, userName } from its MAIN world. Returns null on failure.
async function snProbeTabTokenUser(tabId) {
    try {
        var results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: function() { return { token: window.g_ck || '', userName: (window.NOW && window.NOW.user_name) || '' }; }
        });
        return (results && results[0] && results[0].result) || null;
    } catch (e) {
        return null;
    }
}

// Fetch the current user's display name from sys_user when MAIN-world probe didn't give one.
// Returns { name, responded, status }: responded is true when the instance returned ANY
// HTTP response (including 401/403), false on a network/CORS error; status is the HTTP
// status code (0 on network error) — so the caller can tell an explicit auth rejection
// (401) from an empty-but-OK answer (ACL-filtered 200) or an unreachable instance.
async function snFetchUserName(instanceUrl, token) {
    try {
        // credentials:'include' — see snFetchUserRoles: keeps the cross-origin GET
        // authenticated for tab-less instances via the still-valid session cookie
        // when the cached X-UserToken is stale.
        var apiRes = await fetch(instanceUrl + '/api/now/table/sys_user?sysparm_query=sys_id=javascript:gs.getUserID()&sysparm_fields=user_name,name&sysparm_limit=1', {
            method: 'GET',
            credentials: 'include',
            headers: { 'X-UserToken': token, 'Accept': 'application/json' }
        });
        if (!apiRes.ok) return { name: '', responded: true, status: apiRes.status };
        var apiData = await apiRes.json();
        var row = apiData && apiData.result && apiData.result[0];
        return { name: (row && (row.user_name || row.name)) || '', responded: true, status: apiRes.status };
    } catch (e) {
        return { name: '', responded: false, status: 0 };
    }
}

// Fetch the current user's direct (non-inherited) roles, used for privilege badges
// and the list_instances agent tool. Returns { roles, responded, status } (see snFetchUserName).
async function snFetchUserRoles(instanceUrl, token) {
    var roles = [];
    try {
        // credentials:'include' sends the instance session cookie so the fetch
        // still authenticates for tab-less instances whose cached g_ck (X-UserToken)
        // has gone stale — the cookie stays valid as long as the heartbeat's
        // touch-session keeps returning non-401. Mirrors heartbeatAllInstances.
        var rolesRes = await fetch(instanceUrl + '/api/now/table/sys_user_has_role?sysparm_query=user=javascript:gs.getUserID()^inherited=false&sysparm_fields=role.name&sysparm_limit=50', {
            method: 'GET',
            credentials: 'include',
            headers: { 'X-UserToken': token, 'Accept': 'application/json' }
        });
        if (!rolesRes.ok) return { roles: roles, responded: true, status: rolesRes.status };
        var rolesData = await rolesRes.json();
        var rows = (rolesData && rolesData.result) || [];
        for (var ri = 0; ri < rows.length; ri++) {
            var rname = rows[ri] && rows[ri]['role.name'];
            if (rname) roles.push(rname);
        }
        return { roles: roles, responded: true, status: rolesRes.status };
    } catch (e) {}
    return { roles: roles, responded: false, status: 0 };
}

// Build the detailed instance list: probe every SN tab for tokens, group by origin,
// fill in user/roles per instance. Used by the panel via list-sn-instances-detailed
// and by the SW Platform stub's refreshInstances.
async function snGetInstancesDetailed() {
    var tabs = await getSnTabList();
    var byOrigin = {};
    tabs.forEach(function(tab) {
        var origin = tab.origin;
        if (!byOrigin[origin]) byOrigin[origin] = { url: origin, tabs: [] };
        byOrigin[origin].tabs.push({ id: tab.id, title: tab.title, url: tab.url });
    });

    // Keep instances visible in the selector after their last tab closes. The
    // touch-session heartbeat (heartbeatAllInstances) keeps pinging every cached
    // origin and only DELETES the instanceTokens entry on a hard 401 (logged out
    // for good). So any origin still present in this cache is one ServiceNow that
    // still considers us connected — fold it in even with zero open tabs, since
    // the user may have closed the tab without paying attention.
    var instanceTokenCache = await new Promise(function(r) {
        chrome.storage.local.get('instanceTokens', function(d) { r((d && d.instanceTokens) || {}); });
    });
    Object.keys(instanceTokenCache).forEach(function(origin) {
        if (!byOrigin[origin]) byOrigin[origin] = { url: origin, tabs: [] };
    });

    var result = [];
    for (var url in byOrigin) {
        var inst = byOrigin[url];
        var tokenData = null;
        var sawOpenTab = false;   // a tab whose MAIN-world context we could actually read
        for (var t = 0; t < inst.tabs.length; t++) {
            tokenData = await snProbeTabTokenUser(inst.tabs[t].id);
            if (tokenData) sawOpenTab = true;          // page responded (even if g_ck was empty = logged out)
            if (tokenData && tokenData.token) break;
        }
        var token = (tokenData && tokenData.token) || '';
        var userName = (tokenData && tokenData.userName) || '';
        // Fall back to the cached heartbeat token ONLY when there is no live tab we could
        // read (all tabs closed, or discarded by Chrome Memory Saver — no JS context), so a
        // tab-less instance still resolves as connected (tabCount:0) for list_instances.
        // If an open tab DID respond with an empty g_ck the user is LOGGED OUT — never
        // resurrect a stale token, or the selector would wrongly show it connected.
        if (!token && !sawOpenTab && instanceTokenCache[inst.url] && instanceTokenCache[inst.url].token) {
            token = instanceTokenCache[inst.url].token;
            if (!userName) userName = instanceTokenCache[inst.url].userName || '';
        }
        // Resolve identity + roles. Track whether the instance EXPLICITLY rejected the
        // session (HTTP 401) — that is the only response that proves the token is dead.
        var authRejected = false;
        if (token && !userName) {
            var _nm = await snFetchUserName(inst.url, token);
            userName = _nm.name;
            if (_nm.status === 401) authRejected = true;
        }
        var roles = [];
        if (token) {
            var _rr = await snFetchUserRoles(inst.url, token);
            roles = _rr.roles;
            if (_rr.status === 401) authRejected = true;
        }
        // A token by itself is NOT proof of an authenticated session: a logged-out tab
        // still exposes an anonymous g_ck, and a cached heartbeat token can outlive its
        // session. But an EMPTY answer is not proof of a dead one either: low-privilege
        // (ESS) users get HTTP 200 with zero rows from BOTH probes (ACL-filtered reads
        // of sys_user / sys_user_has_role), so demoting on "responded but empty" wrongly
        // flips valid ESS sessions to signed-out. Clear the token only when the instance
        // EXPLICITLY rejected it (HTTP 401). 403 (authenticated but access denied) and
        // network failures are indeterminate — keep the token and let the next refresh
        // or the heartbeat (which deletes the cache entry on a hard 401) re-check.
        if (token && !userName && roles.length === 0 && authRejected) {
            token = '';
        }
        result.push({ url: inst.url, tabs: inst.tabs, token: token, userName: userName, roles: roles });
    }
    return result;
}

// Probe a fresh g_ck for a specific instance URL by scanning its open tabs.
// Returns { token, userName, tabId } or { token: '', error } if nothing available.
async function snGetTokenForInstance(instanceUrl) {
    var tabs = await getSnTabList();
    var matchTabs = tabs.filter(function(t) { return t.origin === instanceUrl; });
    for (var i = 0; i < matchTabs.length; i++) {
        var data = await snProbeTabTokenUser(matchTabs[i].id);
        if (data && data.token) {
            return { token: data.token, userName: data.userName, tabId: matchTabs[i].id };
        }
    }
    // No open tab yielded a token — fall back to the cached heartbeat token
    // (per-origin instanceTokens map), mirroring the switch-sn-instance
    // _cachedTokenSwitch path, so tab-less but still-connected instances
    // (kept warm by the heartbeat) can still resolve a usable token.
    var cached = await new Promise(function(resolve) {
        chrome.storage.local.get('instanceTokens', function(d) {
            resolve((d && d.instanceTokens && d.instanceTokens[instanceUrl]) || null);
        });
    });
    if (cached && cached.token) {
        return { token: cached.token, userName: cached.userName || '' };
    }
    return { token: '', error: matchTabs.length
        ? 'Could not get token from tabs for ' + instanceUrl
        : 'No open tab for ' + instanceUrl };
}

// Exposed on `self` so the SW Platform stub (which runs first via importScripts)
// can lazy-reference them at call time.
self.snGetInstancesDetailed = snGetInstancesDetailed;
self.snGetTokenForInstance = snGetTokenForInstance;

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

// ─── sw-sleep: unthrottled sandbox sleep ────────────────────────────
// State + alarm listener for the 'sw-sleep' handler below (see the
// comment on the handler for the full rationale).
var SW_SLEEP_ALARM_MIN_MS = 30 * 1000;   // >= this uses chrome.alarms (MV3 alarm minimum)
var SW_SLEEP_MAX_MS = 60 * 60 * 1000;    // sanity cap: 1 hour per bridged sleep request
var _swSleepSeq = 0;
var _swSleepPending = {};                // alarmName -> { respond, ms } (in-memory only)
chrome.alarms.onAlarm.addListener(function(alarm) {
    if (!alarm || !alarm.name || alarm.name.indexOf('sw-sleep_') !== 0) return;
    try { chrome.alarms.clear(alarm.name); } catch (e) {}
    var entry = _swSleepPending[alarm.name];
    delete _swSleepPending[alarm.name];
    // No entry = the SW was suspended/restarted mid-wait. The response
    // channel died with it; the offscreen side's swSleep() re-arms for the
    // remaining time (offscreen-helper.js), so the stale alarm's only job
    // was to wake the SW — nothing else to do.
    if (entry && typeof entry.respond === 'function') {
        try { entry.respond({ ok: true, slept_ms: entry.ms }); } catch (e) {}
    }
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {

    // Show browser notification (from app when agent finishes in background)
    if (message.type === 'show-notification') {
        // Random suffix: two notifications in the same millisecond would share an
        // id and Chrome silently REPLACES the first (concurrent chats can finish together).
        chrome.notifications.create('appagent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), {
            type: 'basic',
            iconUrl: 'icons/AppAgentIconStarOnly_128.png',
            title: message.title || 'AppAgent',
            message: message.message || ''
        });
        return;
    }

    // Offscreen helper relays a sandbox-bound tool call back to the SW
    // for execution (during js_eval or skill-tool runs). We dispatch via
    // the SW's own executeTool (from sw-bundle.js), then sendResponse
    // with the result envelope. Return true so the channel stays open
    // for the async response.
    if (message.type === 'sw-exec-tool') {
        if (typeof executeTool !== 'function') {
            sendResponse({ ok: false, error: 'SW runtime not loaded' });
            return false;
        }
        var p = message.payload || {};
        var execPromise;
        try {
            execPromise = executeTool(p.name, p.args, p.messageIndex, {
                chatId: p.chatId,
                fromSandbox: true,
                toolCallId: p.toolCallId,
                // The OUTER tool's id, used by display's eager-render path to
                // attach its msgIndex to the parent's tool_result slot.
                parentToolCallId: p.parentToolCallId || null
            });
        } catch (e) {
            sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
            return false;
        }
        Promise.resolve(execPromise).then(async function(result) {
            // BUG3 (real fix): a take_screenshot — or any tool that returns a
            // _screenshotMessage — invoked via executeTool() from INSIDE a
            // js_eval / skill-tool sandbox is bridged through here (offscreen
            // -> SW). The agent loop only persists _screenshotMessage for
            // TOP-LEVEL tool calls, so a NESTED capture was never written to
            // the chat's screenshots map and its base64 never reached the
            // sandbox caller — the sandbox saw {screenshot_id, no base64} and a
            // later screenshot_by_id / get_file 404'd on the phantom id. Mirror
            // the page-side sandbox bridge (tools/020-tool-execution.js):
            // persist into chats[chatId].screenshots, register the id in the
            // file index, AWAIT the storage write, then flatten base64 onto the
            // result before it is posted back to the running sandbox code.
            try {
                if (result && result._screenshotMessage) {
                    var ssMsg = result._screenshotMessage;
                    if (ssMsg.screenshot_id) {
                        var ssChat = (typeof chats !== 'undefined' && chats) ? chats[p.chatId] : null;
                        if (ssChat) {
                            if (!ssChat.screenshots) ssChat.screenshots = {};
                            ssChat.screenshots[ssMsg.screenshot_id] = { base64: ssMsg.base64, name: ssMsg.name, width: ssMsg.width, height: ssMsg.height, timestamp: ssMsg.timestamp, description: ssMsg.description };
                            // Sweep 753-773 (771-1): cap the per-chat screenshots map
                            // (~20, LRU by timestamp) — mirrors the page-side sandbox
                            // bridge (tools/020-tool-execution.js) and the skills-engine
                            // cap (core/140-skills-engine.js). Without it, SW-routed
                            // nested captures (background/sub-agent js_eval) grew
                            // chats[chatId].screenshots unbounded.
                            try {
                                var _ssKeys = Object.keys(ssChat.screenshots);
                                var _SS_CAP = 20;
                                if (_ssKeys.length > _SS_CAP) {
                                    _ssKeys.sort(function(a, b) { return (ssChat.screenshots[a].timestamp || 0) - (ssChat.screenshots[b].timestamp || 0); });
                                    for (var _ei = 0; _ei < _ssKeys.length - _SS_CAP; _ei++) {
                                        delete ssChat.screenshots[_ssKeys[_ei]];
                                    }
                                }
                            } catch (eCap) {}
                            if (typeof registerFile === 'function') registerFile(ssMsg.screenshot_id, { type: 'screenshots_map', chatId: p.chatId });
                            if (typeof saveChatsToStorage === 'function') { try { await saveChatsToStorage(); } catch (e) {} }
                        }
                    }
                    // Flatten base64 + dims onto the result so the sandbox
                    // caller sees the same shape as a top-level take_screenshot
                    // ({ base64, width, height, screenshot_id, ... }).
                    result.base64 = ssMsg.base64;
                    result.width = ssMsg.width;
                    result.height = ssMsg.height;
                    result.screenshot_id = ssMsg.screenshot_id || result.screenshot_id;
                    delete result._screenshotMessage;
                }
            } catch (persistErr) { /* persistence is best-effort; still return the captured result */ }
            sendResponse({ ok: true, result: result });
        }).catch(function(err) {
            sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
        });
        return true;
    }

    // Offscreen helper requests an UNTHROTTLED sleep on behalf of a sandbox
    // (`sleep(ms)` global / setTimeout shim in sandbox.html). Rationale: the
    // sandbox iframe lives inside the always-hidden offscreen document, where
    // Chrome's intensive wake-up throttling aligns chained setTimeout timers
    // to 1/minute (page hidden >= 5 min + timer nesting >= 5) — a nominal 10s
    // sleep in agent code was measured at ~60s. Message delivery is NOT
    // throttled, so the wait happens here in the SW instead:
    //   • < 30s  — plain setTimeout. The SW idle timeout is ~30s and the 30s
    //     'agent-heartbeat' alarm + the offscreen keep-alive port reset it,
    //     so short timers are reliable here.
    //   • >= 30s — chrome.alarms (survives SW suspension; 30s is also the
    //     MV3 alarm minimum). sendResponse is kept in-memory only: if the SW
    //     is suspended mid-wait the response channel is torn down anyway and
    //     the offscreen side re-arms for the remaining time (swSleep in
    //     offscreen-helper.js); the alarm still fires and wakes the SW.
    if (message.type === 'sw-sleep') {
        var reqMs = Math.max(0, Math.min(Number(message.payload && message.payload.ms) || 0, SW_SLEEP_MAX_MS));
        // Feed the js_eval inactivity watchdog (tools/020-tool-execution.js
        // kills an eval after 5 min without sandbox activity): the offscreen
        // side chunks sleep requests to <= 4 min, so stamping the activity
        // clock on every chunk arrival keeps long `await sleep(...)` calls
        // alive. _sandboxActivity is a global from the imported sw-bundle.
        try {
            // FIX (SL-1): only stamp activity while a js_eval for this chat is
            // actually live (mirrors tools/020-tool-execution.js:984-988) -- an
            // orphaned sleep settling after eval cleanup must not resurrect the
            // per-chat activity map for a run that already ended.
            if (message.payload && message.payload.chatId && typeof _sandboxActivity !== 'undefined'
                && typeof _sandboxEvalCount !== 'undefined' && _sandboxEvalCount[message.payload.chatId] > 0) {
                _sandboxActivity[message.payload.chatId] = Date.now();
            }
        } catch (e) { /* watchdog feed is best-effort */ }
        if (reqMs < SW_SLEEP_ALARM_MIN_MS) {
            setTimeout(function() {
                try { sendResponse({ ok: true, slept_ms: reqMs }); } catch (e) { /* channel gone — offscreen re-arms */ }
            }, reqMs);
        } else {
            var sleepAlarmName = 'sw-sleep_' + (++_swSleepSeq) + '_' + Date.now();
            _swSleepPending[sleepAlarmName] = { respond: sendResponse, ms: reqMs };
            chrome.alarms.create(sleepAlarmName, { when: Date.now() + reqMs });
        }
        return true; // keep the response channel open for the async resolve
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
                                type: 'browser-action',
                                action: 'viewport_emulate',
                                args: { width: requestedW, enable: true }
                            });
                            emulated = true;
                        } catch(e) { /* content script may not be loaded */ }
                    } else if (requestedW) {
                        // Remove any previous emulation if viewport fits
                        try {
                            await chrome.tabs.sendMessage(tabId, {
                                type: 'browser-action',
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
        snGetInstancesDetailed().then(function(instances) {
            sendResponse({ instances: instances });
        });
        return true;
    }

    // Get a fresh token for a specific instance URL
    if (message.type === 'get-token-for-instance') {
        snGetTokenForInstance(message.instanceUrl).then(sendResponse);
        return true;
    }

    // Switch active ServiceNow instance
    if (message.type === 'switch-sn-instance') {
        // Persist the active instance plus the best token available: a live tab's g_ck when
        // a tab is open and readable, else the cached heartbeat token — so a tab-less but
        // still-connected instance can be selected without forcing open a new tab.
        var _finishSwitch = function(token, userName) {
            // Read the currently-active instance so we can tell a real cross-instance
            // switch from re-selecting the same one.
            chrome.storage.local.get('instanceUrl', function(cur) {
                var updates = { instanceUrl: message.instanceUrl };
                if (token) updates.sessionToken = token;
                if (userName) updates.userName = userName;
                // Switching to a DIFFERENT instance but no token resolved (e.g. logged out
                // mid-switch): drop the previous instance's cached session so tools never
                // send instance A's g_ck to instance B. A same-instance transient read
                // failure keeps the existing token (defensive — avoids killing a live
                // session over one bad probe).
                if (!token && cur && cur.instanceUrl && cur.instanceUrl !== message.instanceUrl) {
                    updates.sessionToken = '';
                    updates.userName = '';
                }
                chrome.storage.local.set(updates);
                sendResponse({ success: true, token: token || '' });
            });
        };
        var _cachedTokenSwitch = function() {
            chrome.storage.local.get('instanceTokens', function(d) {
                var c = (d && d.instanceTokens && d.instanceTokens[message.instanceUrl]) || null;
                _finishSwitch((c && c.token) || '', (c && c.userName) || '');
            });
        };
        if (!message.tabId) { _cachedTokenSwitch(); return true; }
        chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            world: 'MAIN',
            func: function() { return { token: window.g_ck || '', userName: (window.NOW && window.NOW.user_name) || '' }; }
        }).then(function(results) {
            var data = results && results[0] && results[0].result || {};
            // A readable tab returning an empty g_ck = logged out; don't resurrect a cached
            // token (mirrors snGetInstancesDetailed). A discarded/closed tab throws → catch.
            _finishSwitch(data.token || '', data.userName || '');
        }).catch(function() { _cachedTokenSwitch(); });
        return true;
    }

    // Remove a saved instance (header instance picker's \u2715 button). Deletes the
    // per-origin heartbeat token so snGetInstancesDetailed stops folding the
    // origin back into the instance list \u2014 without this the removed row would
    // reappear on the next detailed probe. The picker clears its own
    // snInstancesCache entry page-side (platform-bridge.js).
    if (message.type === 'remove-sn-instance') {
        var _rmUrl = String(message.instanceUrl || '').replace(/\/+$/, '');
        chrome.storage.local.get('instanceTokens', function(d) {
            var map = (d && d.instanceTokens) || {};
            var removed = false;
            Object.keys(map).forEach(function(k) {
                if (String(k).replace(/\/+$/, '') === _rmUrl) { delete map[k]; removed = true; }
            });
            chrome.storage.local.set({ instanceTokens: map }, function() {
                sendResponse({ success: true, removed: removed });
            });
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

    // Eagerly (re)inject the content script into a tab. Used when iframe_tool
    // adopts an already-open user tab whose content script may be missing/stale
    // and chrome.scripting isn't available in the caller's context.
    if (message.type === 'ensure-content-script') {
        (async function() {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: message.tabId },
                    files: ['content-script.js']
                });
                sendResponse({ ok: true });
            } catch (e) {
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }

    // GitHub API proxy (avoids CORS issues for GitHub API calls)
    if (message.type === 'github-api') {
        (async function() {
            try {
                var ghData = await chrome.storage.local.get(['githubToken', 'githubInstanceUrl']);
                var token = message.token || ghData.githubToken;
                var instanceUrl = message.instanceUrl || ghData.githubInstanceUrl || 'https://github.com';
                // Normalize (trim, strip trailing slashes, lowercase protocol+host) so
                // the strict-equality cloud check matches slash/case variants — keep in
                // sync with normalizeGitHubInstanceUrl() in core/130-indexeddb.js.
                instanceUrl = instanceUrl.trim().replace(/\/+$/, '') || 'https://github.com';
                try { var _nu = new URL(instanceUrl); instanceUrl = _nu.protocol + '//' + _nu.host + _nu.pathname.replace(/\/+$/, ''); } catch (e) { /* keep trimmed */ }
                if (!token) { sendResponse({ error: 'No GitHub token configured' }); return; }
                var apiBase = instanceUrl === 'https://github.com' ? 'https://api.github.com' : instanceUrl + '/api/v3';
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
                // Same normalization as the github-api proxy above (sync with
                // normalizeGitHubInstanceUrl() in core/130-indexeddb.js).
                instanceUrl = instanceUrl.trim().replace(/\/+$/, '') || 'https://github.com';
                try { var _nv = new URL(instanceUrl); instanceUrl = _nv.protocol + '//' + _nv.host + _nv.pathname.replace(/\/+$/, ''); } catch (e) { /* keep trimmed */ }
                var apiBase = instanceUrl === 'https://github.com' ? 'https://api.github.com' : instanceUrl + '/api/v3';
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
        // Cold-start: on the very first capture the activeTab permission may not
        // be in effect yet ('activeTab permission is not in effect'). Proactively
        // focus the target window, and on that specific error re-activate+focus
        // the tab and retry once.
        var _capWindowId = windowId;
        var _doCapture = async function() {
            try { if (_capWindowId != null) await chrome.windows.update(_capWindowId, { focused: true }); } catch (e) {}
            return await chrome.tabs.captureVisibleTab(_capWindowId, { format: 'png' });
        };
        var dataUrl;
        try {
            dataUrl = await _doCapture();
        } catch (capErr) {
            var _capMsg = (capErr && capErr.message) || String(capErr);
            if (/activeTab|not in effect/i.test(_capMsg)) {
                try {
                    var _capTabId = targetTabId || await getActiveTabId();
                    if (_capTabId) {
                        await chrome.tabs.update(_capTabId, { active: true });
                        var _capTab = await chrome.tabs.get(_capTabId);
                        _capWindowId = _capTab.windowId;
                        await chrome.windows.update(_capWindowId, { focused: true });
                    }
                } catch (focusErr) { /* defensive */ }
                await new Promise(function(r){ setTimeout(r, 150); });
                dataUrl = await chrome.tabs.captureVisibleTab(_capWindowId, { format: 'png' });
            } else {
                throw capErr;
            }
        }
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

// SW-internal equivalent of platform-bridge's _openSnForLogin: open/reload the
// SN tab and poll for a fresh g_ck. Used by the SW SN-fetch shim on persistent
// 401 so agent-initiated SN calls can recover from a fully-expired session
// without surfacing the 401 to the tool dispatcher.
self.snOpenForLoginAndWait = async function snOpenForLoginAndWait(oldToken) {
    var instanceUrl;
    try {
        var storage = await chrome.storage.local.get('instanceUrl');
        if (!storage.instanceUrl) return null;
        instanceUrl = storage.instanceUrl;
        var tabs = await getSnTabList();
        if (tabs.length > 0) {
            var targetTab = tabs[0];
            for (var i = 0; i < tabs.length; i++) {
                if (tabs[i].origin === instanceUrl) { targetTab = tabs[i]; break; }
            }
            try { await chrome.tabs.update(targetTab.id, { active: true }); } catch (e) {}
            try { await chrome.tabs.reload(targetTab.id); } catch (e) {}
            try { var t = await chrome.tabs.get(targetTab.id); chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
            loginTabId = null;
        } else {
            var tab = await chrome.tabs.create({ url: instanceUrl, active: true });
            loginTabId = tab.id;
        }
    } catch (e) {
        return null;
    }
    // Poll for a fresh token. 120 attempts × 2s = 4 min, same as page version.
    for (var attempt = 0; attempt < 120; attempt++) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        try {
            var token = await snGetTokenForInstance(instanceUrl);
            if (token && token.token && token.token !== oldToken) {
                return token.token;
            }
        } catch (e) {}
    }
    return null;
};

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

// Guard for silent auto-login (see the claude-oauth-status handler). In-memory
// flag blocks two overlapping token exchanges within one service-worker
// lifecycle. The "already failed for this cookie" guard is persisted in
// chrome.storage.local (claudeAutoLoginFailedFor) so an invalid/expired
// sessionKey cookie cannot trigger a token-exchange storm across the frequent
// MV3 service-worker restarts.
var claudeAutoLoginInFlight = false;

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

// Live-refresh Claude usage from claude.ai's web API (cookie-authenticated).
// Unlike the anthropic-ratelimit-* headers we scrape off /v1/messages responses
// (which only update AFTER an inference call), this can be polled on demand with no
// message sent. Auth is the claude.ai sessionKey cookie — Chrome attaches it
// automatically for the credentialed fetch (we hold <all_urls> host + cookies perms).
// The user:inference OAuth bearer is NOT honored on claude.ai org endpoints, so we
// deliberately send no Authorization header.
async function refreshClaudeOrgUsage() {
    var sessionKey = await getClaudeCookie('sessionKey');
    if (!sessionKey) throw new Error('Not signed into claude.ai');
    var orgId = await resolveActiveOrg(sessionKey);
    var res = await fetch('https://claude.ai/api/organizations/' + orgId + '/usage', {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error('Usage HTTP ' + res.status);
    var json = await res.json();
    var normalized = normalizeClaudeUsage(json);
    if (!normalized || !Object.keys(normalized).length) {
        // Endpoint shape changed; degrade gracefully — the indicator keeps the
        // last header-based value rather than rendering nothing useful.
        console.warn('[Claude usage] response shape not recognized');
        return json;
    }
    // Merge over header-captured values so we never drop fields the headers carry.
    var existing = (await chrome.storage.local.get('claudeRateLimits')).claudeRateLimits || {};
    var merged = Object.assign({}, existing, normalized);
    await chrome.storage.local.set({ claudeRateLimits: merged });
    return merged;
}

// Map an unknown claude.ai usage payload into the anthropic-ratelimit-unified-*
// header shape the credits indicator already parses (fetchCredits in
// 170-chat-management.js). Handles the {five_hour:{utilization,resets_at}} style plus
// a few field aliases, and passes through any flat anthropic-ratelimit-* keys verbatim.
function normalizeClaudeUsage(json) {
    if (!json || typeof json !== 'object') return null;
    var out = {};
    function toEpochSeconds(v) {
        if (v == null) return null;
        if (typeof v === 'number') return v > 9999999999 ? Math.floor(v / 1000) : Math.floor(v);
        var t = Date.parse(v);
        return isNaN(t) ? null : Math.floor(t / 1000);
    }
    function applyBucket(bucket, label) {
        if (!bucket || typeof bucket !== 'object') return;
        var u = bucket.utilization;
        var isFraction = false;
        if (u == null && bucket.used_fraction != null) { u = bucket.used_fraction; isFraction = true; }
        if (u == null) u = bucket.utilization_percent;
        var un = parseFloat(u);
        if (!isNaN(un)) {
            // claude.ai reports `utilization` / `utilization_percent` as a percent
            // (0-100); `used_fraction` is already a 0-1 fraction. The header shape
            // the indicator parses (fetchCredits) expects a 0-1 fraction, so convert
            // by FIELD NAME, not by value: the old `un > 1 ? un / 100 : un` heuristic
            // read a utilization of exactly 1 (= 1% used) as a 1.0 fraction, making
            // the pill show 100% (red) while the per-limit popover showed 1%.
            if (!isFraction) un = un / 100;
            out['anthropic-ratelimit-unified-' + label + '-utilization'] = String(un);
        }
        var r = bucket.resets_at;
        if (r == null) r = bucket.reset_at;
        if (r == null) r = bucket.resets;
        var rs = toEpochSeconds(r);
        if (rs != null) out['anthropic-ratelimit-unified-' + label + '-reset'] = String(rs);
    }
    applyBucket(json.five_hour || json.fiveHour || json.unified_5h || json['5h'], '5h');
    applyBucket(json.seven_day || json.sevenDay || json.unified_7d || json['7d'], '7d');
    // Extra usage (pay-as-you-go beyond plan limits). When a subscription is on
    // extra usage only, five_hour/seven_day come back null, so this is the only
    // bucket with data. The anthropic-ratelimit header shape can't express
    // currency/amounts, so stash it under appagent-extra-usage-* for the pill
    // (parseClaudeExtraUsage in 170-chat-management.js) to render. monthly_limit
    // and used_credits are in MINOR units (divide by 10^decimal_places).
    // Capture the per-limit breakdown (session / weekly all-models / weekly
    // per-model scoped) so the pill can render a rich tooltip with one bar per
    // limit. Normalized to a compact array under appagent-usage-limits.
    if (Array.isArray(json.limits) && json.limits.length) {
        var lims = [];
        json.limits.forEach(function(l) {
            if (!l || typeof l !== 'object') return;
            var pct = parseFloat(l.percent);
            if (isNaN(pct)) return;
            lims.push({
                kind: l.kind || null,
                group: l.group || null,
                percent: pct,
                severity: l.severity || null,
                resets_at: toEpochSeconds(l.resets_at),
                is_active: l.is_active === true,
                label: (l.scope && l.scope.model && l.scope.model.display_name) ? String(l.scope.model.display_name) : null
            });
        });
        if (lims.length) out['appagent-usage-limits'] = JSON.stringify(lims);
    }
    var eu = json.extra_usage || json.extraUsage;
    if (eu && typeof eu === 'object') {
        out['appagent-extra-usage-enabled'] = String(eu.is_enabled !== false);
        if (eu.monthly_limit != null && !isNaN(parseFloat(eu.monthly_limit)))
            out['appagent-extra-usage-limit'] = String(parseFloat(eu.monthly_limit));
        if (eu.used_credits != null && !isNaN(parseFloat(eu.used_credits)))
            out['appagent-extra-usage-used'] = String(parseFloat(eu.used_credits));
        if (eu.utilization != null && !isNaN(parseFloat(eu.utilization)))
            out['appagent-extra-usage-utilization'] = String(parseFloat(eu.utilization));
        if (eu.currency) out['appagent-extra-usage-currency'] = String(eu.currency);
        var _dp = parseInt(eu.decimal_places, 10);
        out['appagent-extra-usage-decimals'] = String(isNaN(_dp) ? 2 : _dp);
    }
    Object.keys(json).forEach(function(k) {
        if (k.indexOf('anthropic-ratelimit-') === 0) out[k] = String(json[k]);
    });
    return out;
}

// Distill a provider error body into a short human-readable headline.
// Provider errors arrive as (often nested/escaped) JSON — e.g. Anthropic:
// {"type":"error","error":{"type":"rate_limit_error","message":"{\"type\":\"exceeded_limit\",…}"},"request_id":"…"}.
// Surfacing that verbatim floods every downstream UI (sub-agent notice
// cards, lifecycle retry rows, snackbars, agent_status). Drill into the
// innermost string message, collapse whitespace and hard-cap the result;
// the FULL raw body is logged to the SW console so nothing is lost for
// debugging. Generic on purpose: any long body (not just 429) gets the
// same treatment, while short plain-text bodies pass through untouched.
function conciseApiErrorBody(bodyText) {
    var raw = String(bodyText == null ? '' : bodyText).trim();
    if (!raw) return raw;
    var t = raw;
    for (var depth = 0; depth < 4; depth++) {
        var c = t.charAt(0);
        if (c !== '{' && c !== '[') break;
        var obj;
        try { obj = JSON.parse(t); } catch (e) { break; }
        var msg = obj && (
            (obj.error && typeof obj.error === 'object' && (obj.error.message || obj.error.type))
            || (typeof obj.error === 'string' && obj.error)
            || obj.message || obj.detail);
        if (typeof msg !== 'string' || !msg.trim()) {
            // JSON with no usable message field — fall back to a type/code
            // hint (e.g. {"type":"exceeded_limit",…} → "exceeded limit").
            var hint = obj && (obj.type || obj.code);
            if (hint) t = String(hint).replace(/_/g, ' ');
            break;
        }
        t = msg.trim(); // may itself be escaped JSON (Anthropic nests it) — loop
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > 240) t = t.slice(0, 240).trim() + '\u2026';
    if (t !== raw) console.error('[AppAgent] full API error body:', raw);
    return t || raw.slice(0, 240);
}

// Decide whether an ACCOUNT limit (credits / 5h window / weekly window /
// extra-usage cap) is actually exhausted, from a flat claudeRateLimits-style
// map — either headers scraped off a /v1/messages response or the output of
// refreshClaudeOrgUsage(). Used to reclassify ambiguous 429s whose body
// doesn't say WHY we were shed: a credit-exhausted 429 looks identical to a
// transient rate-limit unless we cross-check usage. Returns
// { label, resetsAt (epoch seconds|null) } or null when nothing is exhausted.
function detectUsageExhaustion(map) {
    if (!map || typeof map !== 'object') return null;
    function num(k) { var v = parseFloat(map[k]); return isNaN(v) ? null : v; }
    // Reset values are epoch seconds from normalizeClaudeUsage but RFC3339
    // timestamps in raw anthropic-ratelimit-*-reset headers — accept both.
    function epochSec(k) {
        var raw = map[k];
        if (raw == null) return null;
        if (/^\d+(\.\d+)?$/.test(String(raw).trim())) {
            var n = parseFloat(raw);
            return n > 9999999999 ? Math.floor(n / 1000) : Math.floor(n);
        }
        var t = Date.parse(raw);
        return isNaN(t) ? null : Math.floor(t / 1000);
    }
    // Per-limit breakdown from claude.ai (percent is 0-100 per limit).
    try {
        var lims = JSON.parse(map['appagent-usage-limits'] || 'null') || [];
        for (var i = 0; i < lims.length; i++) {
            var l = lims[i];
            if (!l || typeof l.percent !== 'number') continue;
            if (l.percent >= 100) {
                return {
                    label: 'Usage limit reached' + (l.label ? ' — ' + l.label : (l.kind ? ' — ' + String(l.kind).replace(/_/g, ' ') : '')),
                    resetsAt: l.resets_at || null
                };
            }
        }
    } catch (e) {}
    // Unified window utilization — a 0-1 fraction in both the header shape
    // and normalizeClaudeUsage output (which canonicalizes percents).
    var u5 = num('anthropic-ratelimit-unified-5h-utilization');
    if (u5 != null && u5 >= 1) return { label: 'Usage limit reached — 5-hour window', resetsAt: epochSec('anthropic-ratelimit-unified-5h-reset') };
    var u7 = num('anthropic-ratelimit-unified-7d-utilization');
    if (u7 != null && u7 >= 1) return { label: 'Usage limit reached — weekly window', resetsAt: epochSec('anthropic-ratelimit-unified-7d-reset') };
    // Extra usage (pay-as-you-go credits): cap reached = out of credits.
    if (map['appagent-extra-usage-enabled'] === 'true') {
        var lim = num('appagent-extra-usage-limit');
        var used = num('appagent-extra-usage-used');
        if (lim != null && used != null && lim > 0 && used >= lim) {
            // No rolling window here — credits stay exhausted until the user
            // raises the cap or the billing month rolls over. hardStop tells
            // the retry loop to surface immediately instead of retrying.
            return { label: 'Out of credits — extra-usage cap reached', resetsAt: null, hardStop: true };
        }
    }
    return null;
}

// "2h 5m" / "12m" until an epoch-seconds reset, or '' when unknown/past.
function formatResetDelta(epochSec) {
    if (!epochSec) return '';
    var ms = epochSec * 1000 - Date.now();
    if (ms <= 0) return '';
    var m = Math.round(ms / 60000);
    if (m < 1) return 'under a minute';
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
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

// Renew the Claude access token. The Claude Desktop OAuth client (the one this
// extension uses) does NOT issue refresh tokens, so refreshClaudeToken() above
// always fails for us. Instead we silently re-run startClaudeOAuth(), which only
// needs the user's claude.ai sessionKey cookie (long-lived). If a refresh_token
// IS present we still try the proper refresh first — that's the standards path
// and would work if Anthropic ever turns it on for this client.
async function renewClaudeToken(oauth) {
    if (oauth && oauth.refreshToken) {
        try {
            var tokenData = await refreshClaudeToken(oauth.refreshToken);
            return saveOAuthCreds(tokenData, oauth.refreshToken);
        } catch (e) {
            // fall through to silent re-auth
            console.log('[Claude OAuth] refresh failed, falling back to silent re-auth:', e.message);
        }
    }
    // Silent re-auth via the claude.ai session cookie.
    return await startClaudeOAuth();
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
        // Manual login re-enables auto-login and clears any stale failed-cookie guard.
        chrome.storage.local.remove(['claudeOAuthSuppressAutoLogin', 'claudeAutoLoginFailedFor']);
        startClaudeOAuth().then(function(creds) {
            sendResponse({ success: true, claudeOAuth: creds });
        }).catch(function(err) {
            sendResponse({ error: err.message });
        });
        return true;
    }
    if (message.type === 'claude-oauth-refresh') {
        chrome.storage.local.get('claudeOAuth', function(data) {
            renewClaudeToken(data.claudeOAuth).then(function(creds) {
                sendResponse({ success: true, claudeOAuth: creds });
            }).catch(function(err) { sendResponse({ error: err.message }); });
        });
        return true;
    }
    if (message.type === 'claude-oauth-status') {
        chrome.storage.local.get(['claudeOAuth', 'claudeAutoLoginFailedFor', 'claudeOAuthSuppressAutoLogin'], async function(data) {
            if (!data.claudeOAuth) {
                // AUTO-LOGIN: no token stored yet. If the user is signed into
                // claude.ai (sessionKey cookie present) and has not manually
                // logged out, silently exchange the cookie for an OAuth token —
                // no click needed. Guarded so a bad/expired cookie can't spam
                // token exchange:
                //   - claudeAutoLoginInFlight (memory) blocks overlapping tries
                //   - claudeAutoLoginFailedFor (persisted) blocks retrying the
                //     same cookie value across service-worker restarts
                if (!claudeAutoLoginInFlight && !data.claudeOAuthSuppressAutoLogin) {
                    // Claim the in-flight guard SYNCHRONOUSLY (before any await) so two
                    // near-simultaneous status polls can't both pass the check and each
                    // launch startClaudeOAuth(). The reset lives in finally.
                    claudeAutoLoginInFlight = true;
                    var sk = null;
                    try {
                        try { sk = await getClaudeCookie('sessionKey'); } catch (e) {}
                        if (sk && sk !== data.claudeAutoLoginFailedFor) {
                            var creds = await startClaudeOAuth();
                            chrome.storage.local.remove('claudeAutoLoginFailedFor');
                            sendResponse({ loggedIn: true, expired: false, expiresAt: creds.expiresAt });
                            return;
                        }
                    } catch (e) {
                        // Remember this cookie failed so we don't retry it every poll.
                        if (sk) chrome.storage.local.set({ claudeAutoLoginFailedFor: sk });
                    } finally {
                        claudeAutoLoginInFlight = false;
                    }
                }
                sendResponse({ loggedIn: false });
                return;
            }
            var oauth = data.claudeOAuth;
            // Auto-renew if expired or expiring within 1 minute. Uses refresh_token
            // if available, otherwise falls back to silent re-auth via the claude.ai
            // session cookie (the Desktop OAuth client we use does not issue refresh tokens).
            if (Date.now() > oauth.expiresAt - 60000) {
                try {
                    oauth = await renewClaudeToken(oauth);
                } catch(e) {
                    // Renew failed — login is truly expired (claude.ai session gone too)
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
        // Suppress auto-login so an explicit logout sticks — otherwise the next
        // status poll would immediately re-exchange the still-present cookie.
        chrome.storage.local.set({ claudeOAuthSuppressAutoLogin: true });
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
    if (message.type === 'claude-oauth-usage-refresh') {
        refreshClaudeOrgUsage().then(function(data) {
            sendResponse({ data: data });
        }).catch(function(e) {
            sendResponse({ error: e.message });
        });
        return true;
    }
});

// --- Claude OAuth Streaming Proxy ---
// Transforms OpenAI-format request to Anthropic format, streams response back as OpenAI SSE.
//
// Two callers:
//   • The 'claude-oauth-stream' port (legacy panel path — kept for any UI
//     that still uses it, e.g. widgets that call the LLM directly).
//   • The SW-internal LLM streaming code in 010-llm-streaming.js, which
//     calls `self.runClaudeOAuthStream(requestBody, callbacks, abortSignal)`
//     directly because the SW can't open a port to itself.

// --- Claude stream semaphore (PR#501 follow-up) ---
// Tracks how many Anthropic streams are currently consuming a response
// body. A 429 whose representativeClaim is "concurrents" means the
// account-level concurrent-stream cap is hit — the right recovery is to
// PARK until a sibling stream actually ends (event-driven), not to sleep
// on a blind timer. A timeout fallback prevents deadlock when ALL local
// streams are parked (the cap may be consumed by another device/session).
var _claudeStreams = { active: 0, waiters: [] };
function _claudeStreamEnded() {
    _claudeStreams.active = Math.max(0, _claudeStreams.active - 1);
    var ws = _claudeStreams.waiters.splice(0);
    for (var i = 0; i < ws.length; i++) { try { ws[i](); } catch (e) {} }
}
// Resolves when ANY in-flight stream ends, after timeoutMs, or when the
// optional abortSignal fires — whichever comes first. Never rejects.
function _waitForFreeStreamSlot(timeoutMs, abortSignal) {
    return new Promise(function(resolve) {
        var done = false;
        function fire() {
            if (done) return;
            done = true;
            // PR#874 follow-up (P3): a Pause/Stop during the concurrency park
            // must not sit out the full 8-15s wait.
            if (abortSignal) { try { abortSignal.removeEventListener('abort', fire); } catch (e) {} }
            // Remove ourselves so timed-out waiters don't accumulate in the
            // array when no stream ever completes (inert but unbounded).
            var i = _claudeStreams.waiters.indexOf(fire);
            if (i >= 0) _claudeStreams.waiters.splice(i, 1);
            resolve();
        }
        _claudeStreams.waiters.push(fire);
        setTimeout(fire, timeoutMs);
        if (abortSignal) {
            if (abortSignal.aborted) fire();
            else abortSignal.addEventListener('abort', fire, { once: true });
        }
    });
}
// PR#874 follow-up (P3): abort-aware sleep for the 429/529 backoff. Resolves
// (never rejects) on timeout OR abort — the loop-head `if (aborted)` guard in
// runClaudeOAuthStream then ends the stream cleanly. Mirrors
// _openaiAbortableDelay (ChatGPT sibling) minus the reject.
function _claudeAbortableDelay(ms, signal) {
    return new Promise(function(resolve) {
        if (signal && signal.aborted) { resolve(); return; }
        var timer = setTimeout(done, ms);
        function done() { cleanup(); resolve(); }
        function onAbort() { clearTimeout(timer); done(); }
        function cleanup() { if (signal) { try { signal.removeEventListener('abort', onAbort); } catch (e) {} } }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

// Core streamer: feeds {type:'sse'|'error'|'done'|'status'} envelopes to the
// provided sink. Generic over transport (port.postMessage vs direct fn).
// 'status' envelopes are transport-level progress (rate-limit backoff / slot
// park) — consumers that don't know the type safely ignore it.
async function runClaudeOAuthStream(requestBody, sink, abortSignal) {
    var streamKeepAlive = null;
    var aborted = false;
    var _slotHeld = false;
    function onAbort() {
        aborted = true;
        if (streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }
    }
    if (abortSignal) {
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        var data = await chrome.storage.local.get('claudeOAuth');
        var oauth = data.claudeOAuth;
        if (!oauth || !oauth.accessToken) {
            sink({ type: 'error', error: 'Not logged in to Claude. Click the login button.' });
            sink({ type: 'done' });
            return;
        }

        if (Date.now() > oauth.expiresAt - 60000) {
            try {
                oauth = await renewClaudeToken(oauth);
            } catch(e) {
                sink({ type: 'error', error: 'Token refresh failed: ' + e.message + '. Open https://claude.ai, sign in, then retry.' });
                sink({ type: 'done' });
                return;
            }
        }

        var anthropicBody = transformToAnthropic(requestBody);
        var anthropicJson = JSON.stringify(anthropicBody);

        var res;
        var maxRetries = 3;
        var maxParks = 4;
        var parks = 0;
        var errBodyText = null;
        var triedReauth = false;
        var usageProbed = false;
        for (var attempt = 0; attempt <= maxRetries; attempt++) {
            if (aborted) {
                // Match the in-loop abort path (post-break fall-through emits both
                // [DONE] then done); consumers that fold these into a single end
                // signal expect the SSE marker first.
                sink({ type: 'sse', data: 'data: [DONE]\n\n' });
                sink({ type: 'done' });
                return;
            }
            res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                // PR#874 follow-up (P3): without the signal, Pause/Stop could
                // not cancel an in-flight request — the SW kept streaming until
                // the next chunk arrived (minutes on a slow first token). An
                // AbortError from fetch()/reader.read() is folded into a clean
                // end-of-stream by the outer catch below.
                signal: abortSignal || undefined,
                headers: {
                    'accept': 'text/event-stream',
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': getAnthropicBetas(anthropicBody.model),
                    'anthropic-dangerous-direct-browser-access': 'true',
                    'authorization': 'Bearer ' + oauth.accessToken,
                    'content-type': 'application/json'
                },
                body: anthropicJson
            });

            // "Stays signed in": a hard 401 means the access token was rejected
            // server-side (revoked, or the claude.ai session expired before our
            // clock-based proactive refresh at expiresAt-60s could fire).
            // Silently re-authenticate ONCE via renewClaudeToken (refresh_token
            // if present, else claude.ai cookie re-auth) and retry with the
            // fresh token instead of surfacing the 401 as a failed request.
            if (res.status === 401 && !triedReauth) {
                triedReauth = true;
                try {
                    oauth = await renewClaudeToken(oauth);
                    continue;
                } catch (e) {
                    sink({ type: 'error', error: 'Session expired and silent re-auth failed: ' + e.message + '. Open https://claude.ai, sign in, then retry.' });
                    sink({ type: 'done' });
                    return;
                }
            }

            // 429 (rate-limit) and 529 (overloaded) are transient shed-load
            // responses — recover instead of surfacing them. Reset errBodyText
            // BEFORE the break so a 429 attempt followed by a DIFFERENT failing
            // status (400/500/second 401) doesn't surface the stale 429 body
            // under the new status code — the !res.ok handler below re-reads
            // the fresh body when errBodyText is null.
            errBodyText = null;
            if (res.status !== 529 && res.status !== 429) break;
            // Read the error body ONCE (a Response body is single-use) — it
            // tells us WHICH limit was hit, and the final surfaced error
            // reuses it after the loop.
            try { errBodyText = await res.text(); } catch (e) { errBodyText = ''; }
            // "concurrents": the account-level concurrent-stream cap. This
            // clears the moment a sibling stream ends, so park on the
            // semaphore (event-driven, jittered 8-15s timeout fallback for
            // the all-parked / other-device case). Parks have their own
            // budget and do NOT burn timed-backoff attempts.
            var isConcurrents = res.status === 429 && /concurrents/.test(errBodyText || '');
            if (isConcurrents && parks < maxParks && !aborted) {
                parks++;
                var parkMs = Math.round(8000 + Math.random() * 7000);
                // Only claim "another agent" when a sibling stream from THIS
                // service worker is actually holding a slot. With 0 local
                // streams the concurrency cap was consumed elsewhere (another
                // device/profile) or the endpoint is shedding load under
                // saturation — saying "another agent" there is misleading.
                var parkSuffix = parks > 1 ? ' (' + parks + '/' + maxParks + ')…' : '…';
                var parkMsg = _claudeStreams.active > 0
                    ? (parks > 1 ? 'Still waiting for another agent to finish' : 'Waiting for another agent to finish') + parkSuffix
                    : 'AI endpoint saturated — no free stream slot, waiting' + parkSuffix;
                sink({ type: 'status', status: 'rate_limited', reason: 'concurrents', waitMs: parkMs, message: parkMsg });
                console.warn('[AppAgent] 429 concurrents, parking for a free stream slot (' + parks + '/' + maxParks + ', ≤' + Math.round(parkMs / 1000) + 's, ' + _claudeStreams.active + ' active)');
                await _waitForFreeStreamSlot(parkMs, abortSignal); // PR#874 follow-up (P3): abort-aware park
                attempt--; // compensate the for-loop increment — parks are budgeted separately
                continue;
            }
            if (attempt === maxRetries) break;
            // Timed backoff: honor Retry-After (seconds, capped 30s — an MV3
            // SW can be killed during long sleeps) else exponential 4s → 8s →
            // 16s, with ±30% jitter so parent + sub-agent streams that got
            // shed at the same instant don't retry in lockstep and
            // re-collide on the same cap.
            var retryDelayMs = 4000 * Math.pow(2, attempt);
            var retryAfterSec = parseInt(res.headers.get('retry-after'), 10);
            if (!isNaN(retryAfterSec) && retryAfterSec > 0) retryDelayMs = Math.min(retryAfterSec * 1000, 30000);
            retryDelayMs = Math.round(retryDelayMs * (0.7 + Math.random() * 0.6));
            // Classify WHY we were shed so the snackbar tells the truth:
            // 529 = endpoint saturated; 429 mentioning credits/usage-limit =
            // account exhaustion (retry-after still honored — OAuth usage
            // windows roll over); anything else = plain rate-limit.
            var backoffLabel;
            if (res.status === 529) backoffLabel = 'AI endpoint saturated';
            else if (/credit|billing|balance/i.test(errBodyText || '')) backoffLabel = 'Out of credits';
            else if (/usage[ _-]?limit|quota/i.test(errBodyText || '')) backoffLabel = 'Usage limit reached';
            else backoffLabel = 'Rate-limited';
            // A 429 whose body doesn't mention credits is often still an
            // exhausted ACCOUNT limit, not a transient rate-limit. Cross-check:
            // first the unified ratelimit headers on THIS 429 (free), then the
            // claude.ai usage API (cookie-auth'd, probed at most once per
            // request). When a limit is truly exhausted and resets far in the
            // future, retrying in seconds is pointless — surface a clear error
            // immediately instead of burning the retry budget on "Rate-limited".
            if (res.status === 429) {
                var hdrMap = {};
                try { res.headers.forEach(function(v, k) { if (k.indexOf('anthropic-ratelimit-') === 0) hdrMap[k] = v; }); } catch (e) {}
                var exhaustion = detectUsageExhaustion(hdrMap);
                if (!exhaustion && !usageProbed) {
                    usageProbed = true;
                    try { exhaustion = detectUsageExhaustion(await refreshClaudeOrgUsage()); } catch (e) {}
                }
                if (exhaustion) {
                    backoffLabel = exhaustion.label;
                    var resetIn = formatResetDelta(exhaustion.resetsAt);
                    if (exhaustion.hardStop || (exhaustion.resetsAt && exhaustion.resetsAt * 1000 - Date.now() > 60000)) {
                        // Concise headline ONLY — the raw provider body used
                        // to be appended in parens here and flooded every
                        // error surface downstream (sub-agent notice cards,
                        // lifecycle retry rows). It goes to the console now.
                        if (errBodyText) console.error('[AppAgent] 429 raw error body:', errBodyText);
                        errBodyText = exhaustion.label + (resetIn ? ' — resets in ' + resetIn : '') + '. Retrying won\'t help until the limit resets.';
                        console.error('[AppAgent] 429 ' + exhaustion.label + (resetIn ? ', resets in ' + resetIn : '') + ' — not retrying');
                        break;
                    }
                    if (resetIn) backoffLabel += ' (resets in ' + resetIn + ')';
                }
            }
            sink({ type: 'status', status: 'rate_limited', reason: res.status, waitMs: retryDelayMs, message: backoffLabel + ' — retrying in ' + Math.round(retryDelayMs / 1000) + 's (attempt ' + (attempt + 1) + '/' + maxRetries + ')…' });
            console.error('[AppAgent] ' + res.status + ' ' + backoffLabel + ', retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + Math.round(retryDelayMs / 1000) + 's');
            await _claudeAbortableDelay(retryDelayMs, abortSignal); // PR#874 follow-up (P3): abort-aware backoff
        }

        if (!res.ok) {
            // errBodyText is set when the retry loop already consumed the
            // body (429/529 exhausted) — a Response body can only be read once.
            var errText = (errBodyText !== null) ? errBodyText : await res.text();
            // conciseApiErrorBody: distill nested provider JSON into a short
            // headline (full raw body goes to the console) so raw payloads
            // never leak into transcripts, notice cards or status rows.
            sink({ type: 'error', error: 'API error ' + res.status + ': ' + conciseApiErrorBody(errText) });
            sink({ type: 'done' });
            return;
        }

        // Response is streaming from here — hold a semaphore slot until the
        // finally below releases it, waking any parked "concurrents" 429s.
        _claudeStreams.active++;
        _slotHeld = true;

        var rlHeaders = {};
        res.headers.forEach(function(v, k) {
            if (k.startsWith('anthropic-ratelimit-')) rlHeaders[k] = v;
        });
        if (Object.keys(rlHeaders).length > 0) {
            // Merge over existing values (mirrors refreshClaudeOrgUsage) so a header
            // capture doesn't wipe API-derived keys the headers don't carry (e.g. 7d).
            try {
                var _rlExisting = (await chrome.storage.local.get('claudeRateLimits')).claudeRateLimits || {};
                chrome.storage.local.set({ claudeRateLimits: Object.assign({}, _rlExisting, rlHeaders) });
            } catch (e) {
                chrome.storage.local.set({ claudeRateLimits: rlHeaders });
            }
        }

        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var sseBuffer = '';
        var msgId = '';
        var toolIdx = 0;
        var currentToolId = null;
        var anthropicUsage = {};
        var model = anthropicBody.model;

        streamKeepAlive = setInterval(function() {
            chrome.runtime.getPlatformInfo(function() {});
        }, 5000);

        var done = false;
        while (!done) {
            if (aborted) { try { reader.cancel(); } catch (e) {} break; }
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
                    // Fable 5.1+ (thinking-binding-controls beta): with
                    // block_binding.prefix_mismatch_behavior:'drop_block' the API
                    // silently removes replayed thinking blocks whose bound prefix
                    // no longer matches (prefix_binding_mismatch) or that the
                    // current model cannot read (model_binding_mismatch) — and
                    // every thinking block after them. It reports each drop here,
                    // on message_start, as { type:'thinking_dropped', path, reason }.
                    // Empty/absent = history intact. Non-empty = the prompt cache
                    // restarted at that block — log it so drops are not invisible.
                    // Console only (SW console): the page-side 'status' envelope
                    // raises a snackbar, and a drop repeats on every request until
                    // the block ages out, which would be pure noise there.
                    var _inputTx = eventData.message.input_transformations;
                    if (Array.isArray(_inputTx) && _inputTx.length > 0) {
                        var _txSummary = _inputTx.map(function(t) {
                            return (t && t.type || '?') + '@' + (t && t.path || '?') + ' (' + (t && t.reason || 'no reason') + ')';
                        }).join(', ');
                        console.warn('[AppAgent] ' + model + ': ' + _inputTx.length + ' input_transformations reported by the API — ' + _txSummary, _inputTx);
                    }
                    sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                        id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
                    }) + '\n\n' });
                }
                else if (eventType === 'content_block_start') {
                    var block = eventData.content_block || {};
                    if (block.type === 'tool_use') {
                        currentToolId = block.id || ('call_' + Math.random().toString(36).substr(2, 8));
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, id: currentToolId, type: 'function', function: { name: block.name || '', arguments: '' } }] }, finish_reason: null }]
                        }) + '\n\n' });
                    }
                    else if (block.type === 'thinking') {
                        var blockIdx = eventData.index || 0;
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { reasoning_details: [{ index: blockIdx, thinking: '' }] }, finish_reason: null }]
                        }) + '\n\n' });
                    }
                    else if (block.type === 'redacted_thinking') {
                        // Safety-redacted reasoning: the whole block arrives on
                        // content_block_start (opaque `data`, no deltas follow).
                        // Forward it into the same reasoning_details store as
                        // thinking blocks (page side merges by index and keeps
                        // `type`/`data` — 010-llm-streaming.js) so
                        // transformMessageToAnthropic can replay it verbatim on
                        // the next tool-use continuation.
                        var blockIdx = eventData.index || 0;
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { reasoning_details: [{ index: blockIdx, type: 'redacted_thinking', data: block.data || '' }] }, finish_reason: null }]
                        }) + '\n\n' });
                    }
                }
                else if (eventType === 'content_block_delta') {
                    var delta = eventData.delta || {};
                    if (delta.type === 'text_delta') {
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { content: delta.text || '' }, finish_reason: null }]
                        }) + '\n\n' });
                    }
                    else if (delta.type === 'input_json_delta') {
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, function: { arguments: delta.partial_json || '' } }] }, finish_reason: null }]
                        }) + '\n\n' });
                    }
                    else if (delta.type === 'thinking_delta') {
                        var blockIdx = eventData.index || 0;
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { reasoning_details: [{ index: blockIdx, thinking: delta.thinking || '' }] }, finish_reason: null }]
                        }) + '\n\n' });
                    }
                    else if (delta.type === 'signature_delta') {
                        var blockIdx = eventData.index || 0;
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
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
                        var finishMap = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls', refusal: 'content_filter' };
                        // Fable 5 (and Opus 4.7+ stop_details) refusals arrive as a
                        // SUCCESSFUL HTTP 200 stream with stop_reason 'refusal' — not an
                        // error. Without explicit handling the turn renders as a normal
                        // empty 'stop' and the user never learns the request was declined.
                        // Surface it as visible assistant text including the classifier
                        // category from stop_details when present.
                        if (stopReason === 'refusal') {
                            var sd = (eventData.delta || {}).stop_details || null;
                            var sdCat = (sd && (sd.category || sd.reason || sd.type)) || '';
                            var refusalNote = '\n\n[Request declined by the model (' + model + ')' + (sdCat ? ' (category: ' + sdCat + ')' : '') + '. Refused requests can often be served by a different model — switch the provider and retry.]';
                            sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: { content: refusalNote }, finish_reason: null }]
                            }) + '\n\n' });
                        }
                        var promptTokens = (anthropicUsage.input_tokens || 0) +
                            (anthropicUsage.cache_creation_input_tokens || 0) +
                            (anthropicUsage.cache_read_input_tokens || 0);
                        var completionTokens = anthropicUsage.output_tokens || 0;
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
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
                    sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                        error: { message: (eventData.error || {}).message || 'Unknown error', type: 'api_error' }
                    }) + '\n\n' });
                }
            }
        }

        clearInterval(streamKeepAlive); streamKeepAlive = null;
        sink({ type: 'sse', data: 'data: [DONE]\n\n' });
        sink({ type: 'done' });

    } catch(e) {
        clearInterval(streamKeepAlive); streamKeepAlive = null;
        // PR#874 follow-up (P3): an aborted fetch()/reader.read() is a clean
        // end-of-stream, not an error — emit the same envelopes as the
        // loop-head `aborted` guard (SSE [DONE] first, then done).
        if (aborted || (e && e.name === 'AbortError')) {
            try { sink({ type: 'sse', data: 'data: [DONE]\n\n' }); } catch(e2) {}
            try { sink({ type: 'done' }); } catch(e2) {}
            return;
        }
        try { sink({ type: 'error', error: e.message }); } catch(e2) {}
        try { sink({ type: 'done' }); } catch(e2) {}
    } finally {
        // Release the stream slot (if held) and wake parked siblings. Fires
        // on clean finish, stream error, AND abort — every exit path.
        if (_slotHeld) { _slotHeld = false; _claudeStreamEnded(); }
    }
}
self.runClaudeOAuthStream = runClaudeOAuthStream;

// Thin port wrapper — forwards a 'claude-oauth-stream' port to the
// shared streamer. Kept for any caller (e.g. widget contexts) that
// still uses port-based streaming. The SW-internal LLM call path
// (010-llm-streaming.js) skips this and invokes runClaudeOAuthStream
// directly.
chrome.runtime.onConnect.addListener(function(port) {
    if (port.name !== 'claude-oauth-stream') return;
    var abortController = new AbortController();
    port.onDisconnect.addListener(function() {
        try { abortController.abort(); } catch (e) {}
    });
    port.onMessage.addListener(function(msg) {
        if (msg.type !== 'start-stream') return;
        var requestBody;
        try { requestBody = JSON.parse(msg.body); }
        catch (e) {
            try { port.postMessage({ type: 'error', error: 'Bad request body: ' + e.message }); } catch (e2) {}
            try { port.postMessage({ type: 'done' }); } catch (e2) {}
            return;
        }
        runClaudeOAuthStream(requestBody, function(env) {
            try { port.postMessage(env); } catch (e) {}
        }, abortController.signal);
    });
});

// ============================================================
// ChatGPT subscription (OAuth) provider — device-code auth + Responses adapter
// ============================================================
//
// Auth is the OAuth 2.0 DEVICE-CODE flow that the public Codex client_id
// supports. No redirect/localhost listener, no declarativeNetRequest, no
// chrome.identity — so no new manifest permission is required (we already hold
// <all_urls> host access).
//
// Field names verified against openai/codex codex-rs/login/src/device_code_auth.rs
// (usercode -> {device_auth_id, user_code, interval}; token poll -> {authorization_code,
// code_challenge, code_verifier}; PENDING is signalled by HTTP 403/404) and
// codex-rs/login/src/server.rs (form-encoded /oauth/token exchange with
// grant_type/code/redirect_uri/client_id/code_verifier -> {id_token, access_token,
// refresh_token}). Refresh shape verified against codex-rs/login/src/auth/manager.rs
// (JSON {client_id, grant_type:'refresh_token', refresh_token} -> all-optional
// {id_token, access_token, refresh_token}).

var OPENAI_OAUTH = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    issuer: 'https://auth.openai.com',
    deviceUserCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'https://auth.openai.com/deviceauth/callback',
    verifyUrl: 'https://auth.openai.com/codex/device',
    scopes: 'openid profile email offline_access',
    responsesUrl: 'https://chatgpt.com/backend-api/codex/responses',
    // Live Codex model catalog. Upstream requires ?client_version= (see
    // fetchCodexModelCatalog, EvanZhouDev/openai-oauth packages/core/src/models.ts
    // and codex-rs/model-provider/src/models_endpoint.rs MODELS_ENDPOINT).
    modelsUrl: 'https://chatgpt.com/backend-api/codex/models',
    // VERIFIED openai/codex codex-rs/login/src/auth/default_client.rs:40
    // `pub const DEFAULT_ORIGINATOR: &str = "codex_cli_rs";` — sent as the
    // `originator` header by default_headers() (same file, :337) on every
    // Codex request.
    originator: 'codex_cli_rs',
    // The Codex client version is NEVER hardcoded as the primary path: OpenAI
    // gates model availability on it (every catalog entry carries
    // `minimal_client_version` — codex-rs/codex-api/src/endpoint/models.rs) and
    // answers 400 "The '<model>' model requires a newer version of Codex."
    // when the advertised version is below a model's floor. A pinned constant
    // is stale the moment Codex ships — that is exactly the bug this replaces
    // (0.50.0 vs 0.151.0 on npm). resolveCodexClientVersion() reads the live
    // npm dist-tag; the constant below is only the net when that fetch fails.
    // Mirrors EvanZhouDev/openai-oauth packages/core/src/models.ts:3
    // (DEFAULT_CODEX_CLIENT_VERSION) + :114 resolveCodexClientVersion.
    codexVersionRegistryUrl: 'https://registry.npmjs.org/@openai/codex/latest',
    fallbackClientVersion: '0.151.0'
};

// ---- Codex client version -------------------------------------------------
// Memoised in memory (NO chrome.storage write site added on purpose — the
// write-site ratchet stays put) with a 1h TTL, matching upstream's
// CODEX_VERSION_CACHE_TTL_MS. A shared in-flight promise collapses concurrent
// callers so a burst of turns costs one registry fetch.
var OPENAI_CODEX_VERSION_TTL_MS = 60 * 60 * 1000;
var _openaiCodexVersion = null;
var _openaiCodexVersionAt = 0;
var _openaiCodexVersionInFlight = null;
// 'npm' when the live registry answered, 'fallback' when the constant was used.
// Surfaced in the version-gate error message so the NEXT gate failure names
// both the version AND where it came from.
var _openaiCodexVersionSource = 'fallback';

function _openaiValidVersion(v) {
    return (typeof v === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+/.test(v.trim())) ? v.trim() : null;
}

async function resolveCodexClientVersion(force) {
    if (!force && _openaiCodexVersion && (Date.now() - _openaiCodexVersionAt) < OPENAI_CODEX_VERSION_TTL_MS) {
        return _openaiCodexVersion;
    }
    if (_openaiCodexVersionInFlight) return _openaiCodexVersionInFlight;
    _openaiCodexVersionInFlight = (async function() {
        var version = null;
        try {
            var res = await fetch(OPENAI_OAUTH.codexVersionRegistryUrl, { headers: { accept: 'application/json' } });
            if (res.ok) {
                var j = await res.json();
                version = _openaiValidVersion(j && j.version);
            }
        } catch (e) { /* offline / blocked — fall through to the net below */ }
        if (version) {
            _openaiCodexVersionSource = 'npm';
        } else {
            version = OPENAI_OAUTH.fallbackClientVersion;
            _openaiCodexVersionSource = 'fallback';
            console.warn('[AppAgent] Could not resolve the latest @openai/codex version — advertising ' + version + ' to the Codex backend.');
        }
        _openaiCodexVersion = version;
        _openaiCodexVersionAt = Date.now();
        // Keep the spoofed User-Agent in lockstep with the advertised version.
        _openaiEnsureCodexUserAgentRule(version);
        return version;
    })();
    var p = _openaiCodexVersionInFlight;
    try { return await p; }
    finally { if (_openaiCodexVersionInFlight === p) _openaiCodexVersionInFlight = null; }
}
self.resolveCodexClientVersion = resolveCodexClientVersion;

// `User-Agent` is a FORBIDDEN header for fetch() — a service worker cannot set
// it. But the real Codex client advertises its version there:
// codex-rs/login/src/auth/default_client.rs:335 default_headers() inserts
// USER_AGENT = get_codex_user_agent(), whose format is (same file, :163)
//   "{originator}/{version} ({os_type} {os_version}; {arch}) {terminal}".
// declarativeNetRequest CAN set it, which is exactly how this extension
// already spoofs claude-cli for api.anthropic.com (dynamic rule id 3000 at the
// bottom of this file). Rule id 3001 does the same for the Codex backend.
var OPENAI_CODEX_UA_RULE_ID = 3001;
var _openaiCodexUaRuleVersion = null;
function _openaiCodexUserAgent(version) {
    return OPENAI_OAUTH.originator + '/' + version + ' (Mac OS 15.6.0; arm64) Apple_Terminal';
}
function _openaiEnsureCodexUserAgentRule(version) {
    if (!version || _openaiCodexUaRuleVersion === version) return;
    _openaiCodexUaRuleVersion = version;
    try {
        chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [OPENAI_CODEX_UA_RULE_ID],
            addRules: [{
                id: OPENAI_CODEX_UA_RULE_ID,
                priority: 1,
                action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: _openaiCodexUserAgent(version) }] },
                condition: { urlFilter: 'chatgpt.com/backend-api/codex/*', resourceTypes: ['xmlhttprequest'] }
            }]
        }).catch(function() { _openaiCodexUaRuleVersion = null; });
    } catch (e) { _openaiCodexUaRuleVersion = null; }
}

// Append ?client_version=<resolved> to a Codex backend URL. VERIFIED against
// codex-rs/codex-api/src/endpoint/models.rs `append_client_version_query`
// (and its `appends_client_version_query` test asserting
// ".../models?client_version=0.99.0"), plus EvanZhouDev/openai-oauth
// packages/core/src/models.ts:174 and runtime.ts:941.
function _openaiWithClientVersion(url, version) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'client_version=' + encodeURIComponent(version);
}

// Refresh proactively this far before expiry (mirrors Codex/creatorweave's 5 min).
var OPENAI_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Device auth is only valid for 15 minutes server-side.
var OPENAI_DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;

// Guards, mirroring the Claude trio but shaped for device-code:
//   - openaiDeviceLoginInFlight (memory): blocks overlapping poll loops in one
//     service-worker lifecycle.
//   - openaiPendingDeviceAuth (chrome.storage.local): the in-progress device
//     auth. A status poll RESUMES this instead of starting a second login, and
//     it self-expires, so a stale/abandoned code can never spam the endpoint.
//   - openaiOAuthSuppressAutoLogin (chrome.storage.local): an explicit logout
//     sticks — no resume until the user logs in again.
// NOTE: unlike Claude (cookie -> token, fully silent) device-code CANNOT
// auto-login: it requires the human to type a code. So there is no
// cookie-exchange auto-login branch; the status handler resumes a pending
// device auth instead.
var openaiDeviceLoginInFlight = false;
// deviceAuthId the live poll loop OWNS. A newer login claims it, which makes the
// older loop exit at its next tick. This replaced the old `if (inFlight) return`
// bail, which could leave a freshly minted code with no poll loop behind it.
var openaiActiveDeviceAuthId = null;
var openaiAuthGeneration = 0;
var openaiDeviceAbortController = null;
var openaiStartAbortController = null;
var openaiRenewAbortController = null;
var openaiRenewInFlight = null;
// Serializes ALL OAuth-owned storage writes with logout. Queue order is the
// proof: a pending/credential write that started first commits before logout's
// removal; anything queued later must re-check generation/ownership inside its
// operation and cannot resurrect the logged-out session.
var openaiOAuthStorageQueue = Promise.resolve();
function _openaiQueueOAuthStorage(operation) {
    var result = openaiOAuthStorageQueue.catch(function() {}).then(operation);
    openaiOAuthStorageQueue = result.catch(function() {});
    return result;
}
// Concurrent startChatGPTOAuth() callers (e.g. the model-menu "Log in" row and
// a status-poll resume firing in the same tick) would BOTH sail past the
// pending-record checks below before either has written openaiPendingDeviceAuth,
// minting two device codes and showing the caller a code that no poll loop owns.
// One shared in-flight promise (same shape as openaiRenewInFlight) collapses
// them onto a single login.
var openaiStartLoginInFlight = null;
// Per-model-slug memo of request fields the Codex backend rejected for that
// model, learned from a 400 (see runChatGPTOAuthStream's degrade-and-retry).
// Shape: { '<model>': { noReasoningContext: true, noParallelToolCalls: true } }.
var _openaiModelQuirks = {};

// Net for when the LIVE catalog fetch below fails. openai/codex deleted its
// hardcoded presets (codex-rs/models-manager/src/model_presets.rs: "model
// listings are now derived from the active catalog"), so a hardcoded list is
// always a guess with a shelf life — these three are the GPT-5.6 slugs
// advertised for ChatGPT accounts by EvanZhouDev/openai-oauth (README:
// "Available Models: gpt-5.6-terra, gpt-5.6-sol, ...") and present in
// codex-rs/model-provider/src/provider.rs.
var OPENAI_FALLBACK_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
var OPENAI_MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
var _openaiModelCatalog = null;
var _openaiModelCatalogAt = 0;
var _openaiModelCatalogAccountId = null;
var _openaiModelCatalogInFlight = null;
var _openaiModelCatalogEpoch = 0;
function _openaiInvalidateModelCatalog() {
    _openaiModelCatalogEpoch++;
    _openaiModelCatalog = null;
    _openaiModelCatalogAt = 0;
    _openaiModelCatalogAccountId = null;
    _openaiModelCatalogInFlight = null;
}

// Strip an OpenRouter-style vendor prefix. AppAgent model slugs are routinely
// carried over from OpenRouter ('openai/gpt-5.6-sol'), but the Codex Responses
// backend accepts only the BARE slug and answers a 400 otherwise:
//   "The 'openai/gpt-5.6-sol' model is not supported when using Codex with a
//    ChatGPT account."
// Exactly ONE leading '<vendor>/' segment is removed, and only when it looks
// like a vendor token, so an unusual slug is left intact.
function _openaiNormalizeModelSlug(model) {
    var s = String(model == null ? '' : model).trim();
    if (!s) return '';
    var m = s.match(/^[A-Za-z0-9_.-]+\/(.+)$/);
    return m ? m[1].trim() : s;
}
self._openaiNormalizeModelSlug = _openaiNormalizeModelSlug;

// The account's REAL model list, straight from the Codex catalog endpoint.
// Memoised in-memory (no chrome.storage write site added on purpose) with a
// short TTL and a shared in-flight promise so concurrent callers collapse.
// Filtering mirrors isPublicCodexModel (openai-oauth packages/core/src/models.ts).
async function fetchChatGPTModelCatalog(force) {
    var data = await chrome.storage.local.get('openaiOAuth');
    var oauth = data.openaiOAuth;
    if (!oauth || !oauth.accessToken) throw new Error('Not logged in to ChatGPT.');
    if (Date.now() > oauth.expiresAt - OPENAI_REFRESH_MARGIN_MS) oauth = await renewChatGPTToken(oauth);
    var accountId = oauth.accountId || '';
    if (!force && _openaiModelCatalog && _openaiModelCatalogAccountId === accountId && (Date.now() - _openaiModelCatalogAt) < OPENAI_MODEL_CATALOG_TTL_MS) return _openaiModelCatalog;
    if (_openaiModelCatalogInFlight && _openaiModelCatalogInFlight.accountId === accountId) return _openaiModelCatalogInFlight.promise;
    // Starting B while A is still in flight invalidates A's publication epoch;
    // A may resolve for its caller but cannot overwrite/evict B's cache state.
    if (_openaiModelCatalogInFlight && _openaiModelCatalogInFlight.accountId !== accountId) _openaiModelCatalogEpoch++;
    var catalogGeneration = openaiAuthGeneration;
    var catalogEpoch = _openaiModelCatalogEpoch;
    var flight;
    var catalogPromise = (async function() {
        var clientVersion = await resolveCodexClientVersion();
        var url = _openaiWithClientVersion(OPENAI_OAUTH.modelsUrl, clientVersion);
        var res = await fetch(url, {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'authorization': 'Bearer ' + oauth.accessToken,
                'chatgpt-account-id': oauth.accountId || '',
                'originator': OPENAI_OAUTH.originator,
                'version': clientVersion
            }
        });
        var parsed = await _openaiJson(res);
        if (!res.ok) throw new Error('Codex model catalog request failed: ' + res.status + ' ' + conciseApiErrorBody(parsed.text));
        var j = parsed.json || {};
        // Codex answers {models:[{slug,...}]}; the OpenAI-compatible shape is
        // {data:[{id}]}. Accept both so a backend swap does not break this.
        var raw = Array.isArray(j.models) ? j.models : (Array.isArray(j.data) ? j.data : []);
        var out = [];
        var seen = {};
        for (var i = 0; i < raw.length; i++) {
            var m = raw[i] || {};
            var slug = m.slug || m.id;
            if (!slug || seen[slug]) continue;
            if (m.supported_in_api === false) continue;
            if (m.visibility !== undefined && m.visibility !== 'list') continue;
            seen[slug] = true;
            out.push({ slug: slug, useResponsesLite: m.use_responses_lite === true });
        }
        if (!out.length) throw new Error('Codex returned an empty models list.');
        if (catalogGeneration !== openaiAuthGeneration || catalogEpoch !== _openaiModelCatalogEpoch) throw new DOMException('OAuth session changed', 'AbortError');
        _openaiModelCatalog = out;
        _openaiModelCatalogAt = Date.now();
        _openaiModelCatalogAccountId = accountId;
        return out;
    })();
    flight = { accountId: accountId, promise: catalogPromise };
    _openaiModelCatalogInFlight = flight;
    try { return await catalogPromise; }
    finally { if (_openaiModelCatalogInFlight === flight) _openaiModelCatalogInFlight = null; }
}
self.fetchChatGPTModelCatalog = fetchChatGPTModelCatalog;

// Slug list for user-facing messages — live catalog, hardcoded net on failure.
async function _openaiAvailableModelSlugs() {
    try {
        var cat = await fetchChatGPTModelCatalog();
        return cat.map(function(m) { return m.slug; });
    } catch (e) {
        return OPENAI_FALLBACK_MODELS.slice();
    }
}

function _openaiDecodeJwt(token) {
    try {
        var parts = String(token || '').split('.');
        if (parts.length < 2 || !parts[1]) return null;
        var norm = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (norm.length % 4) norm += '=';
        return JSON.parse(atob(norm));
    } catch (e) { return null; }
}

// accountId lives in the id_token's namespaced auth claim
// ("https://api.openai.com/auth".chatgpt_account_id) — see codex token_data.rs.
// The access_token carries the same claim, so it is the fallback when the
// refresh response omits id_token.
function _openaiAccountId(idToken, accessToken) {
    var toks = [idToken, accessToken];
    for (var i = 0; i < toks.length; i++) {
        var claims = _openaiDecodeJwt(toks[i]);
        var auth = claims && claims['https://api.openai.com/auth'];
        if (auth && auth.chatgpt_account_id) return auth.chatgpt_account_id;
    }
    return null;
}

// JWT exp (seconds) is authoritative for access-token lifetime; the token
// endpoint's expires_in is the fallback.
function _openaiExpiresAt(tokenData) {
    var claims = _openaiDecodeJwt(tokenData && tokenData.access_token);
    if (claims && claims.exp) return claims.exp * 1000;
    return Date.now() + ((tokenData && tokenData.expires_in) || 3600) * 1000;
}

function _openaiAbortError(message) {
    try { return new DOMException(message || 'OAuth operation cancelled', 'AbortError'); }
    catch (e) { var err = new Error(message || 'OAuth operation cancelled'); err.name = 'AbortError'; return err; }
}
function _openaiAssertGeneration(generation, signal) {
    if (generation !== openaiAuthGeneration || (signal && signal.aborted)) throw _openaiAbortError();
}
function _openaiAwaitWithSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(_openaiAbortError());
    return new Promise(function(resolve, reject) {
        function aborted() { cleanup(); reject(_openaiAbortError()); }
        function cleanup() { signal.removeEventListener('abort', aborted); }
        signal.addEventListener('abort', aborted, { once: true });
        promise.then(function(value) { cleanup(); resolve(value); }, function(error) { cleanup(); reject(error); });
    });
}
function _openaiAbortableDelay(ms, signal) {
    return new Promise(function(resolve, reject) {
        if (signal && signal.aborted) { reject(_openaiAbortError()); return; }
        var timer = setTimeout(done, ms);
        function done() { cleanup(); resolve(); }
        function aborted() { clearTimeout(timer); cleanup(); reject(_openaiAbortError()); }
        function cleanup() { if (signal) signal.removeEventListener('abort', aborted); }
        if (signal) signal.addEventListener('abort', aborted, { once: true });
    });
}
// Mirrors saveOAuthCreds (Claude) — same storage/broadcast contract, different key.
async function saveChatGPTOAuthCreds(tokenData, existing, generation, signal) {
    if (generation === undefined) generation = openaiAuthGeneration;
    _openaiAssertGeneration(generation, signal);
    existing = existing || {};
    var accessToken = tokenData.access_token || existing.accessToken;
    var idToken = tokenData.id_token || existing.idToken;
    var creds = {
        accessToken: accessToken,
        refreshToken: tokenData.refresh_token || existing.refreshToken,
        idToken: idToken,
        accountId: _openaiAccountId(idToken, accessToken) || existing.accountId || null,
        expiresAt: _openaiExpiresAt({ access_token: accessToken, expires_in: tokenData.expires_in })
    };
    await _openaiQueueOAuthStorage(async function() {
        _openaiAssertGeneration(generation, signal);
        await chrome.storage.local.set({ openaiOAuth: creds });
        _openaiAssertGeneration(generation, signal);
    });
    if ((existing.accountId || null) !== creds.accountId) _openaiInvalidateModelCatalog();
    chrome.runtime.sendMessage({ type: 'openai-oauth-updated', openaiOAuth: creds }).catch(function() {});
    return creds;
}

async function _openaiJson(res) {
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { text: text, json: json };
}

// Step 1 of the device flow: ask for a user code.
async function requestChatGPTDeviceCode(signal) {
    var res = await fetch(OPENAI_OAUTH.deviceUserCodeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ client_id: OPENAI_OAUTH.clientId }),
        signal: signal
    });
    var parsed = await _openaiJson(res);
    if (!res.ok) {
        if (res.status === 404) throw new Error('Device-code login is not enabled for this OpenAI client (HTTP 404).');
        throw new Error('Device code request failed: ' + res.status + ' ' + conciseApiErrorBody(parsed.text));
    }
    var j = parsed.json || {};
    // `usercode` is an accepted alias for `user_code` (serde alias in codex).
    var userCode = j.user_code || j.usercode;
    if (!j.device_auth_id || !userCode) throw new Error('Device code response missing device_auth_id/user_code');
    var intervalSec = parseInt(j.interval, 10);
    if (isNaN(intervalSec) || intervalSec < 1) intervalSec = 5;
    return {
        deviceAuthId: j.device_auth_id,
        userCode: userCode,
        intervalMs: intervalSec * 1000,
        verificationUrl: OPENAI_OAUTH.verifyUrl,
        expiresAt: Date.now() + OPENAI_DEVICE_AUTH_TTL_MS
    };
}

// Step 2: one poll of the device-auth token endpoint.
// Returns {pending:true} | {authorizationCode, codeVerifier}. Throws on hard failure.
async function pollChatGPTDeviceAuthOnce(deviceAuthId, userCode, signal) {
    var res = await fetch(OPENAI_OAUTH.deviceTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            client_id: OPENAI_OAUTH.clientId,
            device_auth_id: deviceAuthId,
            user_code: userCode
        }),
        signal: signal
    });
    var parsed = await _openaiJson(res);
    if (!res.ok) {
        // Codex treats 403/404 as "not approved yet"; the OAuth-standard JSON
        // codes are also honored (slow_down asks us to back off).
        var code = (parsed.json && (parsed.json.error || parsed.json.error_code)) || '';
        if (res.status === 403 || res.status === 404 || code === 'authorization_pending' || code === 'slow_down') {
            return { pending: true, slowDown: code === 'slow_down' };
        }
        throw new Error('Device auth failed: ' + res.status + ' ' + conciseApiErrorBody(parsed.text));
    }
    var j = parsed.json || {};
    if (!j.authorization_code || !j.code_verifier) {
        throw new Error('Device auth response missing authorization_code/code_verifier');
    }
    return { authorizationCode: j.authorization_code, codeVerifier: j.code_verifier };
}

// Step 3: exchange the device-issued authorization_code for tokens. The PKCE
// verifier is generated SERVER-side for this flow and handed back by step 2.
async function exchangeChatGPTDeviceCode(authorizationCode, codeVerifier, generation, signal) {
    _openaiAssertGeneration(generation, signal);
    var body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: OPENAI_OAUTH.redirectUri,
        client_id: OPENAI_OAUTH.clientId,
        code_verifier: codeVerifier
    });
    var res = await fetch(OPENAI_OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body.toString(),
        signal: signal
    });
    var parsed = await _openaiJson(res);
    if (!res.ok || !parsed.json || !parsed.json.access_token) {
        throw new Error('Token exchange failed: ' + res.status + ' ' + conciseApiErrorBody(parsed.text));
    }
    _openaiAssertGeneration(generation, signal);
    return saveChatGPTOAuthCreds(parsed.json, null, generation, signal);
}

function _openaiSetPending(pending, generation, signal) {
    if (generation === undefined) generation = openaiAuthGeneration;
    return _openaiQueueOAuthStorage(async function() {
        _openaiAssertGeneration(generation, signal);
        if (!pending || !pending.deviceAuthId) throw new Error('Pending device auth is missing its owner id');
        await chrome.storage.local.set({ openaiPendingDeviceAuth: pending });
        _openaiAssertGeneration(generation, signal);
    });
}
function _openaiClearPending(generation, signal, deviceAuthId) {
    if (generation === undefined) generation = openaiAuthGeneration;
    return _openaiQueueOAuthStorage(async function() {
        _openaiAssertGeneration(generation, signal);
        if (deviceAuthId) {
            var latest = (await chrome.storage.local.get('openaiPendingDeviceAuth')).openaiPendingDeviceAuth;
            _openaiAssertGeneration(generation, signal);
            if (latest && latest.deviceAuthId !== deviceAuthId) return false;
        }
        await chrome.storage.local.remove('openaiPendingDeviceAuth');
        _openaiAssertGeneration(generation, signal);
        return true;
    });
}

// Drive the poll loop to completion. Fire-and-forget: the UI learns the result
// from the 'openai-oauth-updated' broadcast / the next status poll. Awaited
// fetches keep the MV3 worker alive between polls; if it is evicted anyway the
// persisted pending record lets the next status poll resume the same code.
async function pollChatGPTDeviceAuthUntilDone(pending) {
    // Already polling THIS code: never stack a second loop on it.
    if (openaiDeviceLoginInFlight && openaiActiveDeviceAuthId === pending.deviceAuthId) return;
    // A DIFFERENT (newer) code: claim ownership. The older loop notices it lost
    // ownership on its next tick and returns without polling or mutating shared
    // state, so we never poll two codes at once AND never leave a newly minted
    // code unpolled.
    openaiActiveDeviceAuthId = pending.deviceAuthId;
    openaiDeviceLoginInFlight = true;
    if (openaiDeviceAbortController) openaiDeviceAbortController.abort();
    var deviceController = new AbortController();
    openaiDeviceAbortController = deviceController;
    var loginGeneration = openaiAuthGeneration;
    var intervalMs = pending.intervalMs || 5000;
    try {
        while (Date.now() < pending.expiresAt) {
            await _openaiAbortableDelay(intervalMs, deviceController.signal);
            _openaiAssertGeneration(loginGeneration, deviceController.signal);
            if (openaiActiveDeviceAuthId !== pending.deviceAuthId) return;
            var step;
            try {
                step = await pollChatGPTDeviceAuthOnce(pending.deviceAuthId, pending.userCode, deviceController.signal);
                _openaiAssertGeneration(loginGeneration, deviceController.signal);
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                await _openaiClearPending(loginGeneration, deviceController.signal, pending.deviceAuthId);
                chrome.runtime.sendMessage({ type: 'openai-oauth-updated', openaiOAuth: null, error: e.message }).catch(function() {});
                return;
            }
            if (step.pending) {
                if (step.slowDown) intervalMs = Math.min(intervalMs + 5000, 30000);
                continue;
            }
            try {
                _openaiAssertGeneration(loginGeneration, deviceController.signal);
                await exchangeChatGPTDeviceCode(step.authorizationCode, step.codeVerifier, loginGeneration, deviceController.signal);
                _openaiAssertGeneration(loginGeneration, deviceController.signal);
                await _openaiClearPending(loginGeneration, deviceController.signal, pending.deviceAuthId);
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                await _openaiClearPending(loginGeneration, deviceController.signal, pending.deviceAuthId);
                chrome.runtime.sendMessage({ type: 'openai-oauth-updated', openaiOAuth: null, error: e.message }).catch(function() {});
            }
            return;
        }
        // Expired without approval. Only clear if the stored record is still
        // OURS — a newer login may have replaced it while we were sleeping.
        var latest = (await chrome.storage.local.get('openaiPendingDeviceAuth')).openaiPendingDeviceAuth;
        if (!latest || latest.deviceAuthId === pending.deviceAuthId) await _openaiClearPending(loginGeneration, deviceController.signal, pending.deviceAuthId);
        chrome.runtime.sendMessage({ type: 'openai-oauth-updated', openaiOAuth: null, error: 'Device code expired — start the login again.' }).catch(function() {});
    } catch (e) {
        if (!e || e.name !== 'AbortError') throw e;
    } finally {
        // Only the loop that still OWNS the login releases the shared flag — a
        // superseded loop must not advertise "no login in flight" while the newer
        // loop is still polling.
        if (openaiActiveDeviceAuthId === pending.deviceAuthId) {
            openaiDeviceLoginInFlight = false;
            openaiActiveDeviceAuthId = null;
            if (openaiDeviceAbortController === deviceController) openaiDeviceAbortController = null;
        }
    }
}

// Kick off a login. Returns immediately with the code the user must type, then
// polls in the background. Opens (or focuses) the approval page on EVERY attempt
// — reused-code attempts included — and reports whether that succeeded via
// `tabOpened`; the code still has to be entered by hand.
function startChatGPTOAuth() {
    if (openaiStartLoginInFlight) return openaiStartLoginInFlight;
    openaiStartLoginInFlight = (async function() {
        try { return await _startChatGPTOAuth(); }
        finally { openaiStartLoginInFlight = null; }
    })();
    return openaiStartLoginInFlight;
}

// Open — or FOCUS, when it is already open — the device-approval page. EVERY
// path that hands the caller a user code MUST call this: a code with no page to
// type it on is a dead end. That was the reported bug — only the fresh-mint path
// opened a tab, so the 2nd..Nth login click within the 15-minute TTL took the
// code-reuse branch and showed "enter code X on the page that just opened" with
// no page. Returns true when a tab was opened/focused; false is surfaced to the
// UI (as the verification URL in copyable text) instead of being swallowed.
async function _openaiOpenVerifyTab() {
    var url = OPENAI_OAUTH.verifyUrl;
    try {
        var existing = await chrome.tabs.query({ url: url + '*' });
        if (existing && existing.length) {
            await chrome.tabs.update(existing[0].id, { active: true });
            try { await chrome.windows.update(existing[0].windowId, { focused: true }); } catch (e) {}
            return true;
        }
    } catch (e) { /* tabs.query/update unavailable — fall through to create */ }
    try {
        var tab = await chrome.tabs.create({ url: url, active: true });
        return !!tab;
    } catch (e) {
        console.warn('[openai-oauth] could not open the device-approval page:', e && e.message);
        return false;
    }
}

async function _startChatGPTOAuth() {
    var startGeneration = openaiAuthGeneration;
    var startController = new AbortController();
    openaiStartAbortController = startController;
    var signal = startController.signal;
    try {
    _openaiAssertGeneration(startGeneration, signal);
    var stored = await chrome.storage.local.get('openaiPendingDeviceAuth');
    _openaiAssertGeneration(startGeneration, signal);
    var pending = stored.openaiPendingDeviceAuth;
    // Never resurrect an expired/consumed record: handing back a code the server
    // no longer honours is worse than minting a fresh one.
    if (pending && !(pending.expiresAt > Date.now())) {
        _openaiAssertGeneration(startGeneration, signal);
        await _openaiClearPending(startGeneration, signal, pending.deviceAuthId);
        _openaiAssertGeneration(startGeneration, signal);
        pending = null;
    }
    if (pending) {
        // A live code exists: reuse it rather than burning a second one (the
        // running loop owns the pending record and would clear a newer one when
        // the old one expires) — but ALWAYS re-open/focus the approval page so
        // the reused code stays reachable.
        _openaiAssertGeneration(startGeneration, signal);
        var reFocused = await _openaiOpenVerifyTab();
        _openaiAssertGeneration(startGeneration, signal);
        pollChatGPTDeviceAuthUntilDone(pending);
        return {
            pending: true,
            userCode: pending.userCode,
            verificationUrl: pending.verificationUrl || OPENAI_OAUTH.verifyUrl,
            expiresAt: pending.expiresAt,
            reused: true,
            tabOpened: reFocused
        };
    }
    var dc = await requestChatGPTDeviceCode(signal);
    _openaiAssertGeneration(startGeneration, signal);
    await _openaiSetPending(dc, startGeneration, signal);
    _openaiAssertGeneration(startGeneration, signal);
    var tabOpened = await _openaiOpenVerifyTab();
    _openaiAssertGeneration(startGeneration, signal);
    pollChatGPTDeviceAuthUntilDone(dc);
    return { pending: true, userCode: dc.userCode, verificationUrl: dc.verificationUrl, expiresAt: dc.expiresAt, reused: false, tabOpened: tabOpened };
    } finally {
        if (openaiStartAbortController === startController) openaiStartAbortController = null;
    }
}

async function refreshChatGPTToken(refreshToken, signal) {
    var res = await fetch(OPENAI_OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            client_id: OPENAI_OAUTH.clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            scope: OPENAI_OAUTH.scopes
        }),
        signal: signal
    });
    var parsed = await _openaiJson(res);
    if (!res.ok) throw new Error('Token refresh failed: ' + res.status + ' ' + conciseApiErrorBody(parsed.text));
    if (!parsed.json || !parsed.json.access_token) throw new Error('Token refresh returned no access_token');
    return parsed.json;
}

// Unlike the Claude Desktop client, OpenAI DOES issue refresh tokens for this
// client_id, so renewal is fully silent — there is no cookie fallback and no
// re-prompt unless the refresh token itself is dead. Concurrent callers share
// one in-flight refresh so N parked streams can't rotate the token N times
// (refresh tokens are single-use).
function renewChatGPTToken(oauth, callerSignal) {
    if (openaiRenewInFlight) return _openaiAwaitWithSignal(openaiRenewInFlight, callerSignal);
    var renewGeneration = openaiAuthGeneration;
    var renewController = new AbortController();
    openaiRenewAbortController = renewController;
    openaiRenewInFlight = (async function() {
        try {
            _openaiAssertGeneration(renewGeneration, renewController.signal);
            if (!oauth || !oauth.refreshToken) {
                throw new Error('Not logged in to ChatGPT (no refresh token). Use "Log in" in the model menu.');
            }
            var tokenData = await refreshChatGPTToken(oauth.refreshToken, renewController.signal);
            _openaiAssertGeneration(renewGeneration, renewController.signal);
            return saveChatGPTOAuthCreds(tokenData, oauth, renewGeneration, renewController.signal);
        } finally {
            if (openaiRenewAbortController === renewController) openaiRenewAbortController = null;
            openaiRenewInFlight = null;
        }
    })();
    return _openaiAwaitWithSignal(openaiRenewInFlight, callerSignal);
}

// --- ChatGPT OAuth message handlers ---
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === 'openai-oauth-login') {
        // Manual login re-enables resume in the same ordered OAuth lane. If
        // logout wins first, the generation check prevents this remove from
        // landing after logout's suppression write.
        var manualLoginGeneration = openaiAuthGeneration;
        _openaiQueueOAuthStorage(async function() {
            _openaiAssertGeneration(manualLoginGeneration);
            await chrome.storage.local.remove(['openaiOAuthSuppressAutoLogin']);
            _openaiAssertGeneration(manualLoginGeneration);
        }).then(function() { return startChatGPTOAuth(); }).then(function(info) {
            sendResponse({
                success: true, pending: true,
                userCode: info.userCode,
                verificationUrl: info.verificationUrl || OPENAI_OAUTH.verifyUrl,
                reused: !!info.reused,
                tabOpened: info.tabOpened !== false
            });
        }).catch(function(err) {
            sendResponse({ error: err.message });
        });
        return true;
    }
    // "Open the page again" in the device-code modal. One place owns the
    // open-or-focus logic so the UI never has to duplicate it.
    if (message.type === 'openai-oauth-open-verify') {
        _openaiOpenVerifyTab().then(function(opened) {
            sendResponse({ success: true, tabOpened: opened, verificationUrl: OPENAI_OAUTH.verifyUrl });
        });
        return true;
    }
    if (message.type === 'openai-oauth-refresh') {
        chrome.storage.local.get('openaiOAuth', function(data) {
            renewChatGPTToken(data.openaiOAuth).then(function(creds) {
                sendResponse({ success: true, openaiOAuth: creds });
            }).catch(function(err) { sendResponse({ error: err.message }); });
        });
        return true;
    }
    if (message.type === 'openai-oauth-status') {
        chrome.storage.local.get(['openaiOAuth', 'openaiPendingDeviceAuth', 'openaiOAuthSuppressAutoLogin'], async function(data) {
            if (!data.openaiOAuth) {
                // No token yet. Device-code cannot log in silently, so instead of
                // starting a login we RESUME an approved-but-unpolled device auth
                // (e.g. the service worker was evicted mid-flow). Guards mirror
                // Claude's: in-flight (memory), the persisted pending record
                // (self-expiring, replaces the failed-cookie guard), and the
                // explicit-logout suppression flag.
                var pending = data.openaiPendingDeviceAuth;
                // No !openaiDeviceLoginInFlight guard any more: the poll loop now
                // dedupes by deviceAuthId, which is strictly stronger — the old
                // global boolean also skipped resuming a NEWER stored code.
                if (pending && pending.expiresAt > Date.now() && !data.openaiOAuthSuppressAutoLogin) {
                    pollChatGPTDeviceAuthUntilDone(pending);
                    sendResponse({ loggedIn: false, pending: true, userCode: pending.userCode, verificationUrl: pending.verificationUrl });
                    return;
                }
                if (pending && pending.expiresAt <= Date.now()) {
                    _openaiClearPending(openaiAuthGeneration, null, pending.deviceAuthId).catch(function() {});
                }
                sendResponse({ loggedIn: false });
                return;
            }
            var oauth = data.openaiOAuth;
            if (Date.now() > oauth.expiresAt - OPENAI_REFRESH_MARGIN_MS) {
                try {
                    oauth = await renewChatGPTToken(oauth);
                } catch (e) {
                    sendResponse({ loggedIn: true, expired: true, expiresAt: oauth.expiresAt, error: e.message });
                    return;
                }
            }
            sendResponse({
                loggedIn: true,
                expired: Date.now() > oauth.expiresAt,
                expiresAt: oauth.expiresAt,
                accountId: oauth.accountId || null
            });
        });
        return true;
    }
    if (message.type === 'openai-oauth-logout') {
        openaiAuthGeneration++;
        openaiActiveDeviceAuthId = null;
        openaiDeviceLoginInFlight = false;
        openaiStartLoginInFlight = null;
        if (openaiDeviceAbortController) openaiDeviceAbortController.abort();
        if (openaiStartAbortController) openaiStartAbortController.abort();
        if (openaiRenewAbortController) openaiRenewAbortController.abort();
        openaiDeviceAbortController = null;
        openaiStartAbortController = null;
        openaiRenewAbortController = null;
        openaiRenewInFlight = null;
        _openaiInvalidateModelCatalog();
        _openaiQueueOAuthStorage(function() {
            return Promise.all([
                chrome.storage.local.remove(['openaiOAuth', 'openaiPendingDeviceAuth']),
                chrome.storage.local.set({ openaiOAuthSuppressAutoLogin: true })
            ]);
        }).then(function() {
            chrome.runtime.sendMessage({ type: 'openai-oauth-updated', openaiOAuth: null }).catch(function() {});
            sendResponse({ success: true });
        }).catch(function(err) { sendResponse({ error: err && err.message }); });
        return true;
    }
    // Live model catalog for the model menu's ChatGPT Subscription model section. Falls
    // back to OPENAI_FALLBACK_MODELS (live:false) so the picker is never empty.
    if (message.type === 'openai-oauth-models') {
        fetchChatGPTModelCatalog(message.force === true).then(function(cat) {
            sendResponse({ success: true, live: true, models: cat.map(function(m) { return m.slug; }) });
        }).catch(function(e) {
            sendResponse({ success: false, live: false, error: e && e.message, models: OPENAI_FALLBACK_MODELS.slice() });
        });
        return true;
    }

    if (message.type === 'openai-oauth-usage') {
        chrome.storage.local.get('openaiRateLimits', function(data) {
            if (data.openaiRateLimits) sendResponse({ data: data.openaiRateLimits });
            else sendResponse({ error: 'No usage data yet' });
        });
        return true;
    }
});

// --- OpenAI chat-completions -> Responses API request transform ---
//
// Body rules confirmed from EvanZhouDev/openai-oauth packages/core/src/runtime.ts
// (normalizeCodexResponsesBodyInternal / addEncryptedReasoningContent /
// applyModelDefaults): store=false, stream forced true, include must contain
// reasoning.encrypted_content, max_output_tokens deleted. reasoning.context=
// 'all_turns' AND parallel_tool_calls=false are BOTH responses-lite-only
// (`if (modelInfo.useResponsesLite) reasoning.context = "all_turns"`, then
// `if (!modelInfo.useResponsesLite) return` guards the block that ends
// `normalized.parallel_tool_calls = false`) — see the scoping note at the
// reasoning block below. previous_response_id / item_reference are NEVER sent —
// the upstream Codex endpoint is stateless and hard-rejects them, so every
// request carries the full history.
function _openaiTextOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : String(content);
    var out = '';
    for (var i = 0; i < content.length; i++) {
        var p = content[i];
        if (typeof p === 'string') out += p;
        else if (p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text')) out += (p.text || '');
    }
    return out;
}

function _openaiContentParts(content, textType) {
    if (typeof content === 'string' || !Array.isArray(content)) {
        return [{ type: textType, text: _openaiTextOf(content) }];
    }
    var parts = [];
    for (var i = 0; i < content.length; i++) {
        var p = content[i];
        if (typeof p === 'string') { parts.push({ type: textType, text: p }); continue; }
        if (!p) continue;
        if (p.type === 'image_url') {
            var url = p.image_url && (p.image_url.url || p.image_url);
            if (url) parts.push({ type: 'input_image', image_url: url });
            continue;
        }
        if (p.type === 'input_image') { parts.push(p); continue; }
        var t = p.text != null ? p.text : '';
        if (t) parts.push({ type: textType, text: t });
    }
    if (!parts.length) parts.push({ type: textType, text: '' });
    return parts;
}

// Encrypted-reasoning replay for the stateless (store:false) Codex Responses
// endpoint. OpenAI reasoning guide: "When you create a response in stateless
// mode, reasoning items in the response's output array include an
// encrypted_content property by default" and "If the model calls multiple
// functions consecutively, you should pass back all reasoning items, function
// call items, and function call output items, since the last user message"; "To
// use all_turns with store: false, preserve every output item, append the next
// user message, and replay the complete history". The translator stores each
// completed `reasoning` output item on the assistant message's
// reasoning_details using OpenRouter's documented `reasoning.encrypted` shape
// ({type, id, data, format, index} + the item's summary) so the SAME history
// stays a valid chat-completions body if the chat later runs on OpenRouter,
// and is skipped by transformMessageToAnthropic (no `signature`). This helper
// turns those entries back into the Responses item the API returned:
// {type:'reasoning', id, summary, encrypted_content}. Anything that is not a
// Codex entry (Anthropic thinking blocks, redacted_thinking, OpenRouter text
// reasoning) is dropped — the endpoint would 400 on unknown item types.
var OPENAI_REASONING_FORMAT = 'openai-responses-v1';
function _openaiReasoningItemsOf(reasoningDetails) {
    var out = [];
    if (!Array.isArray(reasoningDetails)) return out;
    for (var i = 0; i < reasoningDetails.length; i++) {
        var rd = reasoningDetails[i];
        if (!rd || rd.type !== 'reasoning.encrypted' || rd.format !== OPENAI_REASONING_FORMAT) continue;
        if (!rd.id || typeof rd.data !== 'string' || !rd.data) continue;
        out.push({
            type: 'reasoning',
            id: rd.id,
            summary: Array.isArray(rd.summary) ? rd.summary : [],
            encrypted_content: rd.data
        });
    }
    return out;
}

function transformToResponses(body) {
    var messages = (body && body.messages) || [];
    var input = [];
    var instructions = '';
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i] || {};
        if (m.role === 'system' || m.role === 'developer') {
            var sysText = _openaiTextOf(m.content);
            if (!instructions) {
                // First system message becomes the Responses `instructions`.
                instructions = sysText;
            } else if (sysText) {
                // Any further system prompt is rewritten into a developer
                // input_text item (the Codex responses-lite shape) — the
                // endpoint only accepts one instructions string.
                input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: sysText }] });
            }
            continue;
        }
        if (m.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: m.tool_call_id || m.id || '',
                output: _openaiTextOf(m.content)
            });
            continue;
        }
        if (m.role === 'assistant') {
            // Replay the turn's reasoning items FIRST (the Responses output order
            // is reasoning → message / function_call). Stored by the SSE
            // translator in runChatGPTOAuthStream as OpenRouter-shaped
            // `reasoning.encrypted` entries (format 'openai-responses-v1') on the
            // assistant message's reasoning_details; _openaiReasoningItemsOf
            // ignores every other entry (Anthropic thinking blocks from a
            // provider switch mid-chat) so nothing foreign reaches the endpoint.
            // History without stored items is byte-identical to before.
            var rItems = _openaiReasoningItemsOf(m.reasoning_details);
            for (var ri = 0; ri < rItems.length; ri++) input.push(rItems[ri]);
            var aText = _openaiTextOf(m.content);
            if (aText) {
                input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: aText }] });
            }
            var calls = m.tool_calls || [];
            for (var c = 0; c < calls.length; c++) {
                var tc = calls[c] || {};
                var fn = tc.function || {};
                input.push({
                    type: 'function_call',
                    name: fn.name || '',
                    arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
                    call_id: tc.id || ''
                });
            }
            continue;
        }
        // user (and anything unrecognized) -> user message
        input.push({ type: 'message', role: 'user', content: _openaiContentParts(m.content, 'input_text') });
    }

    var tools = [];
    var srcTools = (body && body.tools) || [];
    for (var t = 0; t < srcTools.length; t++) {
        var st = srcTools[t] || {};
        var f = st.function || st;
        if (!f.name) continue;
        tools.push({
            type: 'function',
            name: f.name,
            description: f.description || '',
            parameters: f.parameters || { type: 'object', properties: {} },
            strict: false
        });
    }

    var reasoning = {};
    var effort = null;
    // Explicit off switch from the request builder (global Thinking Budget = 0,
    // no provider effort → reasoning:{enabled:false}, callOpenRouterStreaming).
    // The Responses API has no `enabled` field: send NO `reasoning` object at
    // all (server default effort, no summaries requested) instead of the usual
    // effort + summary:'auto'.
    var thinkingOff = !!(body && body.reasoning && typeof body.reasoning === 'object' && body.reasoning.enabled === false);
    if (body && body.reasoning && typeof body.reasoning === 'object') effort = body.reasoning.effort;
    else if (body && body.reasoning_effort) effort = body.reasoning_effort;
    // AppAgent providers can carry Anthropic-flavoured efforts (e.g. 'xhigh')
    // that the Responses API rejects — clamp to the values OpenAI accepts.
    if (effort) {
        var OK_EFFORTS = { minimal: 1, low: 1, medium: 1, high: 1 };
        reasoning.effort = OK_EFFORTS[String(effort).toLowerCase()] ? String(effort).toLowerCase() : 'high';
    }
    reasoning.summary = 'auto';
    if (thinkingOff) reasoning = null;
    // SCOPING (reviewer item): upstream applies reasoning.context='all_turns' and
    // parallel_tool_calls=false ONLY on the responses-lite path — selected from
    // the live Codex model catalog (`use_responses_lite`, packages/core/src/
    // models.ts), which also sends a responses-lite request header and folds
    // `tools` into a developer message. AppAgent sends the PLAIN Responses shape
    // (real `tools` array + `instructions` string, no lite header) and does not
    // fetch that catalog, so it takes the NON-lite defaults: no reasoning.context
    // unless the caller asked for one, and the caller's own parallel_tool_calls
    // (010-llm-streaming.js:107 requests true — the agent loop really does emit
    // independent tool calls in a single turn). Anything the backend rejects for
    // a given model is dropped and memoised in _openaiModelQuirks by the
    // degrade-and-retry in runChatGPTOAuthStream, so at worst we pay one 400.
    // NORMALISED here, once: `out.model` and the _openaiModelQuirks memo key
    // are both this value, and runChatGPTOAuthStream keys the degrade-and-retry
    // memo off responsesBody.model — so key parity is structural, not a
    // convention two call sites have to remember.
    var modelSlug = _openaiNormalizeModelSlug(body && body.model) || 'gpt-5.6-sol';
    var quirks = _openaiModelQuirks[modelSlug] || {};
    var askedCtx = (body && body.reasoning && typeof body.reasoning === 'object') ? body.reasoning.context : null;
    if (reasoning && askedCtx && !quirks.noReasoningContext) reasoning.context = askedCtx;

    var out = {
        model: modelSlug,
        instructions: instructions,
        input: input,
        stream: true,
        store: false,
        include: ['reasoning.encrypted_content'],
        parallel_tool_calls: !(body && body.parallel_tool_calls === false) && !quirks.noParallelToolCalls
    };
    if (reasoning) out.reasoning = reasoning;
    if (tools.length) {
        out.tools = tools;
        // chat-completions puts the forced tool name under .function.name;
        // Responses expects it flat as {type:'function', name}.
        var tc = body.tool_choice;
        if (tc) {
            if (typeof tc === 'string') out.tool_choice = tc;
            else if (tc.function && tc.function.name) out.tool_choice = { type: 'function', name: tc.function.name };
            else if (tc.name) out.tool_choice = { type: 'function', name: tc.name };
        }
    }
    // Stable per-conversation cache key. Codex CLI sends prompt_cache_key =
    // session_id on every Responses request (codex-rs/core/src/client.rs
    // prompt_cache_key()) and the backend routes its prompt cache off it
    // (openai/codex#5556) — without it every turn is a cache miss.
    // _codexSessionKey is stamped by 010-llm-streaming.js for the ChatGPT
    // OAuth path only; the internal field itself is never forwarded (this
    // function builds `out` fresh). quirks.noPromptCacheKey is a
    // degrade-and-retry escape hatch, see runChatGPTOAuthStream's 400 ladder.
    if (body && body._codexSessionKey && !quirks.noPromptCacheKey) {
        out.prompt_cache_key = String(body._codexSessionKey);
    }
    // Heartbeat-only output cap (sendCacheHeartbeat in 010-llm-streaming.js):
    // chat-completions `max_tokens` is deliberately NOT mapped for real
    // requests, but the keep-warm ping must be as cheap as possible. 16 is
    // the minimum the Responses API accepts for max_output_tokens.
    if (body && body._maxOutputTokens) {
        out.max_output_tokens = Math.max(16, body._maxOutputTokens | 0);
    }
    return out;
}

// --- ChatGPT OAuth streaming proxy ---
// Same envelope contract as runClaudeOAuthStream: {type:'sse'|'error'|'done'|'status'}.
// SSE payloads are OpenAI chat.completion.chunk objects so the existing
// chat-completions parser in 010-llm-streaming.js needs no changes.
function mergeCodexRateLimitSnapshot(previous, incoming, capturedAt) {
    var rl = incoming || {};
    var merged = Object.assign({}, previous || {});
    ['primary', 'secondary'].forEach(function(prefix) {
        var stem = 'x-codex-' + prefix + '-';
        var bucketChanged = Object.keys(rl).some(function(k) { return k.indexOf(stem) === 0; });
        if (!bucketChanged) return;
        var resetAtKey = stem + 'reset-at';
        var resetAfterKey = stem + 'reset-after-seconds';
        var capturedKey = 'appagent-codex-' + prefix + '-captured-at';
        if (Object.prototype.hasOwnProperty.call(rl, resetAfterKey)) {
            // Bucket-specific capture metadata prevents a partial primary snapshot
            // from rebasing a retained secondary duration. A new relative reset
            // supersedes any retained absolute timestamp for the same bucket.
            rl[capturedKey] = String(capturedAt);
            delete merged[resetAtKey];
        } else {
            delete merged[capturedKey];
            delete merged[resetAfterKey];
        }
        if (Object.prototype.hasOwnProperty.call(rl, resetAtKey)) {
            // Absolute time wins; do not retain a conflicting relative reset.
            delete merged[resetAfterKey];
            delete merged[capturedKey];
        } else if (!Object.prototype.hasOwnProperty.call(rl, resetAfterKey)) {
            delete merged[resetAtKey];
        }
    });
    // Legacy snapshots used one global capture timestamp. Never replace it during
    // a partial merge: retained legacy durations keep their original base, while
    // new relative values use bucket-specific capture metadata.
    Object.keys(rl).forEach(function(k) { merged[k] = rl[k]; });
    return merged;
}
self.mergeCodexRateLimitSnapshot = mergeCodexRateLimitSnapshot;

async function runChatGPTOAuthStream(requestBody, sink, abortSignal) {
    var aborted = false;
    var completionSent = false;
    var activeReader = null;
    function complete(includeDoneMarker) {
        if (completionSent) return;
        completionSent = true;
        if (includeDoneMarker) sink({ type: 'sse', data: 'data: [DONE]\n\n' });
        sink({ type: 'done' });
    }
    // MV3 service workers are evicted after ~30s of inactivity; an awaited
    // reader.read() does NOT count as activity. Mirrors runClaudeOAuthStream's
    // keep-alive (background.js: streamKeepAlive) so long Codex streams survive.
    var cgKeepAlive = null;
    function onAbort() {
        aborted = true;
        // fetch abort does not reliably settle an already-awaited reader.read().
        // Cancel the active reader so the read promise settles immediately.
        if (activeReader) {
            try { Promise.resolve(activeReader.cancel()).catch(function() {}); } catch (e) {}
        }
    }
    if (abortSignal) {
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    var chunkId = 'chatcmpl-' + Date.now().toString(36);
    var created = Math.floor(Date.now() / 1000);
    // Echoed back in every chat.completion.chunk — normalise so the UI shows
    // the slug we actually sent upstream.
    var model = _openaiNormalizeModelSlug(requestBody && requestBody.model) || 'gpt-5.6-sol';
    function emit(payload) {
        sink({ type: 'sse', data: 'data: ' + JSON.stringify(payload) + '\n\n' });
    }
    function emitDelta(delta, finishReason) {
        emit({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [{ index: 0, delta: delta, finish_reason: finishReason === undefined ? null : finishReason }]
        });
    }

    try {
        var data = await chrome.storage.local.get('openaiOAuth');
        var oauth = data.openaiOAuth;
        if (!oauth || !oauth.accessToken) {
            sink({ type: 'error', error: 'Not logged in to ChatGPT. Use "Log in" in the model menu.' });
            sink({ type: 'done' });
            return;
        }
        if (Date.now() > oauth.expiresAt - OPENAI_REFRESH_MARGIN_MS) {
            try {
                oauth = await renewChatGPTToken(oauth, abortSignal);
            } catch (e) {
                if ((e && e.name === 'AbortError') || aborted) throw e;
                sink({ type: 'error', error: 'Token refresh failed: ' + e.message + '. Log in to ChatGPT again from the model menu.' });
                sink({ type: 'done' });
                return;
            }
        }
        if (!oauth.accountId) {
            sink({ type: 'error', error: 'ChatGPT account id missing from the OAuth token — log out and log in again.' });
            sink({ type: 'done' });
            return;
        }

        var responsesBody = transformToResponses(requestBody);
        // Stable per-chat session identity (openai/codex#5556): the backend
        // derives its prompt-cache routing from these headers, so the old
        // crypto.randomUUID()-per-request re-keyed the cache on EVERY turn and
        // burned subscription usage on full-price uncached tokens.
        // 010-llm-streaming.js stamps _codexSessionKey (deterministic per-chat
        // UUID); random remains only as a fallback for callers that didn't
        // stamp one. Codex CLI keeps one session_id/thread_id for the whole
        // conversation and sets x-client-request-id = thread_id too
        // (codex-api/src/endpoint/responses.rs), so all three stay stable.
        var sessionId = (requestBody && requestBody._codexSessionKey)
            || ((crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()));
        var threadId = sessionId;
        // Resolved ONCE per stream so every retry advertises the same version,
        // and so the version-gate branch below can name it.
        var clientVersion = await _openaiAwaitWithSignal(resolveCodexClientVersion(), abortSignal);
        if (aborted || (abortSignal && abortSignal.aborted)) throw _openaiAbortError();
        var responsesUrl = _openaiWithClientVersion(OPENAI_OAUTH.responsesUrl, clientVersion);

        var res;
        var maxRetries = 3;
        var errBodyText = null;
        var triedReauth = false;
        for (var attempt = 0; attempt <= maxRetries; attempt++) {
            if (aborted) { complete(true); return; }
            res = await fetch(responsesUrl, {
                method: 'POST',
                headers: {
                    // accept: codex-rs/codex-api/src/endpoint/responses.rs:176
                    //   inserts ACCEPT = "text/event-stream".
                    'accept': 'text/event-stream',
                    'content-type': 'application/json',
                    'authorization': 'Bearer ' + oauth.accessToken,
                    'chatgpt-account-id': oauth.accountId,
                    // originator: codex-rs/login/src/auth/default_client.rs:337.
                    'originator': OPENAI_OAUTH.originator,
                    // `version`: legacy Codex client-version header, kept because
                    // it costs nothing. The AUTHORITATIVE advertisement is the
                    // ?client_version= query param (see responsesUrl) plus the
                    // DNR-spoofed User-Agent, since fetch() forbids setting
                    // User-Agent from a service worker.
                    'version': clientVersion,
                    // session-id / thread-id are the REAL header names:
                    // codex-rs/codex-api/src/requests/headers.rs
                    //   build_session_headers -> "session-id", "thread-id";
                    // codex-api/src/endpoint/responses.rs:121 also sets
                    //   "x-client-request-id" = thread id (stable per thread,
                    //   NOT per-request — verified against upstream).
                    // All three carry the stable per-chat sessionId so the
                    // backend's prompt cache stays keyed to this conversation.
                    // The old underscored `session_id` is kept alongside them
                    // (harmless, and it is what pre-rename backends accepted).
                    'session-id': sessionId,
                    'thread-id': threadId,
                    'x-client-request-id': threadId,
                    'session_id': sessionId
                },
                body: JSON.stringify(responsesBody),
                signal: abortSignal
            });

            // Hard 401: token rejected server-side before our clock-based
            // proactive refresh fired. Silently renew ONCE and retry.
            if (res.status === 401 && !triedReauth) {
                triedReauth = true;
                try { oauth = await renewChatGPTToken(oauth, abortSignal); continue; }
                catch (e) {
                    if ((e && e.name === 'AbortError') || aborted) throw e;
                    sink({ type: 'error', error: 'ChatGPT session expired and refresh failed: ' + e.message });
                    sink({ type: 'done' });
                    return;
                }
            }

            errBodyText = null;
            if (res.status === 400) {
                // TOLERANT 400 recovery. OpenAI's wording for a rejected Responses
                // field is not stable ("Unknown parameter", "Unsupported value",
                // "Invalid schema for …", plain `detail` strings), so instead of
                // pattern-matching the message we DEGRADE the body one optimistic
                // field at a time and retry. A retry is always strictly more
                // conservative than the request that just failed, so a false
                // positive costs one round trip and nothing else; a genuine 400
                // (e.g. a bad tool schema) exhausts the ladder and is reported
                // verbatim below. Each rung fires at most once, so the loop
                // always makes progress. The verdict is memoised per model slug
                // in _openaiModelQuirks, so later turns never re-send the field.
                try { errBodyText = await res.text(); } catch (e) { errBodyText = ''; }
                // A client-version gate is NOT a body-shape problem: degrading
                // reasoning.context / parallel_tool_calls cannot fix it, would
                // burn three round trips, and would poison _openaiModelQuirks
                // with bogus verdicts for this model. Break straight out so the
                // !res.ok handler reports it verbatim (and legibly).
                if (/newer version|upgrade to the latest|out of date|outdated/i.test(errBodyText || '')) break;
                var quirk = _openaiModelQuirks[responsesBody.model] || (_openaiModelQuirks[responsesBody.model] = {});
                var degraded = null;
                if (responsesBody.reasoning && responsesBody.reasoning.context !== undefined) {
                    delete responsesBody.reasoning.context;
                    quirk.noReasoningContext = true;
                    degraded = 'reasoning.context';
                } else if (responsesBody.parallel_tool_calls) {
                    responsesBody.parallel_tool_calls = false;
                    quirk.noParallelToolCalls = true;
                    degraded = 'parallel_tool_calls';
                } else if (responsesBody.prompt_cache_key) {
                    // Standard Responses field (Codex CLI always sends it),
                    // but keep an escape hatch in case a backend variant
                    // rejects it — losing cache hits beats hard-failing.
                    delete responsesBody.prompt_cache_key;
                    quirk.noPromptCacheKey = true;
                    degraded = 'prompt_cache_key';
                }
                if (degraded && attempt < maxRetries) {
                    console.warn('[AppAgent] ChatGPT 400 — retrying without ' + degraded + ' for model ' + responsesBody.model + ': ' + conciseApiErrorBody(errBodyText || ''));
                    errBodyText = null;
                    continue;
                }
                break;
            }
            if (res.status !== 429 && res.status !== 500 && res.status !== 502 && res.status !== 503) break;
            try { errBodyText = await res.text(); } catch (e) { errBodyText = ''; }
            // A plan/quota exhaustion is not transient. Retrying it only burns the
            // complete transport budget and then invites the agent loop to replay
            // that whole budget again. Surface a machine-readable terminal error on
            // the FIRST response so every layer can preserve the no-retry decision.
            if (res.status === 429 && /usage[ _-]?(?:limit|quota)|quota(?:[ _-]?(?:exceeded|exhausted))?|insufficient[ _-]?quota|plan(?:[ _-]?(?:limit|exhausted))|billing[ _-]?hard[ _-]?limit/i.test(errBodyText || '')) {
                sink({ type: 'error', error: 'ChatGPT usage limit reached: ' + (conciseApiErrorBody(errBodyText) || 'plan or quota exhausted'), code: 'usage_exhausted', retryable: false });
                sink({ type: 'done' });
                return;
            }
            if (attempt === maxRetries) break;
            var retryDelayMs = 4000 * Math.pow(2, attempt);
            var retryAfterSec = parseInt(res.headers.get('retry-after'), 10);
            if (!isNaN(retryAfterSec) && retryAfterSec > 0) retryDelayMs = Math.min(retryAfterSec * 1000, 30000);
            retryDelayMs = Math.round(retryDelayMs * (0.7 + Math.random() * 0.6));
            var label = res.status === 429
                ? (/usage[ _-]?limit|quota|plan/i.test(errBodyText || '') ? 'ChatGPT usage limit reached' : 'Rate-limited')
                : 'ChatGPT endpoint error ' + res.status;
            var transportRetryNumber = attempt + 1;
            sink({ type: 'status', status: 'rate_limited', reason: res.status, waitMs: retryDelayMs, message: label + ' — transport retry ' + transportRetryNumber + ' of ' + maxRetries + ' (request attempt ' + (transportRetryNumber + 1) + ' of ' + (maxRetries + 1) + ') in ' + Math.round(retryDelayMs / 1000) + 's…' });
            console.error('[AppAgent] ChatGPT ' + res.status + ' ' + label + ', transport retry ' + transportRetryNumber + '/' + maxRetries + ' (request attempt ' + (transportRetryNumber + 1) + '/' + (maxRetries + 1) + ')');
            await _openaiAbortableDelay(retryDelayMs, abortSignal);
        }

        if (!res.ok) {
            var errText = (errBodyText !== null) ? errBodyText : await res.text();
            var concise = conciseApiErrorBody(errText) || '';
            // CLIENT-VERSION GATE. OpenAI answers
            //   400 "The 'gpt-5.6-sol' model requires a newer version of Codex.
            //        Please upgrade to the latest app or CLI and try again."
            // when the version we advertise is below the model's
            // `minimal_client_version`. The raw message is opaque because it
            // never says WHICH version we sent — so name it, and say where it
            // came from, making the next occurrence self-diagnosing.
            if (res.status === 400 && /newer version|upgrade to the latest|out of date|outdated/i.test(concise)) {
                sink({ type: 'error', error: 'ChatGPT/Codex rejected the request as an out-of-date client. We advertised client_version=' + clientVersion
                    + ' (' + (_openaiCodexVersionSource === 'npm' ? 'resolved live from the npm registry' : 'HARDCODED fallback — the npm registry lookup failed, so this is probably stale') + ')'
                    + ', originator=' + OPENAI_OAUTH.originator + ', User-Agent="' + _openaiCodexUserAgent(clientVersion) + '"'
                    + ' for model "' + responsesBody.model + '". If ' + clientVersion + ' really is the latest @openai/codex release, this model needs a client version we cannot yet advertise — open the ChatGPT Subscription model section and edit Model ID or choose another model. Upstream said: ' + concise });
                sink({ type: 'done' });
                return;
            }
            // A model-not-supported 400 is the ONE 400 the user can fix
            // themselves, so name the model and list what the account can
            // actually use instead of echoing the raw API error.
            if (res.status === 400 && /model/i.test(concise) && /not\s+supported|not\s+available|not\s+found|does\s+not\s+exist|unknown\s+model|invalid\s+model/i.test(concise)) {
                var avail = await _openaiAvailableModelSlugs();
                sink({ type: 'error', error: 'ChatGPT/Codex rejected the model "' + responsesBody.model + '": it is not available on this ChatGPT account. Available ChatGPT Subscription models: ' + avail.join(', ') + '. Open the ChatGPT Subscription model section and edit Model ID or choose another model. Upstream said: ' + concise });
                sink({ type: 'done' });
                return;
            }
            var transportWasRetried = (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503) && attempt === maxRetries;
            // Only stamp a hard no-retry decision when we KNOW retrying is futile:
            // the transport exhausted its own budget on a retried status, or the
            // status is clearly non-transient (4xx client errors). Transient
            // statuses OUTSIDE the transport retry set (529/524/408…) were never
            // retried here, so leave `retryable` undefined and let the outer
            // agent-loop throttle heuristic (030-agent-loop.js) decide.
            var _nonTransient = (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404);
            var _terminalErr = {
                type: 'error',
                error: transportWasRetried
                    ? 'ChatGPT transport retries exhausted after ' + (maxRetries + 1) + ' request attempts (HTTP ' + res.status + '): ' + concise
                    : 'API error ' + res.status + ': ' + concise,
                code: transportWasRetried ? 'transport_exhausted' : 'api_error'
            };
            if (transportWasRetried || _nonTransient) _terminalErr.retryable = false;
            sink(_terminalErr);
            sink({ type: 'done' });
            return;
        }

        // Codex surfaces plan usage in x-codex-* response headers — persist them
        // for the credits pill (mirrors the anthropic-ratelimit-* scrape).
        try {
            var rl = {};
            res.headers.forEach(function(v, k) {
                if (k.indexOf('x-codex-') === 0 || k.indexOf('x-ratelimit-') === 0) rl[k] = v;
            });
            if (Object.keys(rl).length) {
                var prev = (await chrome.storage.local.get('openaiRateLimits')).openaiRateLimits || {};
                await chrome.storage.local.set({ openaiRateLimits: mergeCodexRateLimitSnapshot(prev, rl, Date.now()) });
            }
        } catch (e) {}

        var reader = res.body.getReader();
        activeReader = reader;
        var decoder = new TextDecoder();
        cgKeepAlive = setInterval(function() {
            chrome.runtime.getPlatformInfo(function() {});
        }, 5000);
        var buffer = '';
        var roleSent = false;
        var toolIndexes = {};   // responses item_id -> chat tool_call index
        var toolArgsSeen = {};  // responses item_id -> saw an arguments delta
        var nextToolIndex = 0;
        var sawToolCall = false;
        var finished = false;
        var reasoningItemIndex = 0; // reasoning_details[].index for captured reasoning items

        while (true) {
            // Cancel the body on abort — without this the fetch stream is left
            // open and the connection leaks until the SW dies (mirrors
            // runClaudeOAuthStream).
            if (aborted) {
                try { await reader.cancel(); } catch (e) {}
                break;
            }
            var step = await reader.read();
            if (step.done) break;
            buffer += decoder.decode(step.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop();
            for (var li = 0; li < lines.length; li++) {
                var line = lines[li].trim();
                if (!line || line.indexOf('data:') !== 0) continue;
                var raw = line.slice(5).trim();
                if (!raw || raw === '[DONE]') continue;
                var ev;
                try { ev = JSON.parse(raw); } catch (e) { continue; }
                var et = ev.type || '';

                if (!roleSent && et.indexOf('response.') === 0) {
                    roleSent = true;
                    emitDelta({ role: 'assistant' });
                }

                if (et === 'response.output_text.delta') {
                    if (ev.delta) emitDelta({ content: ev.delta });
                } else if (et === 'response.reasoning_summary_text.delta' || et === 'response.reasoning_text.delta') {
                    if (ev.delta) emitDelta({ reasoning: ev.delta });
                } else if (et === 'response.output_item.added') {
                    var item = ev.item || {};
                    if (item.type === 'function_call') {
                        sawToolCall = true;
                        var key = item.id || item.call_id;
                        toolIndexes[key] = nextToolIndex;
                        emitDelta({
                            tool_calls: [{
                                index: nextToolIndex,
                                id: item.call_id || item.id,
                                type: 'function',
                                function: { name: item.name || '', arguments: '' }
                            }]
                        });
                        nextToolIndex++;
                    }
                } else if (et === 'response.function_call_arguments.delta') {
                    var dKey = ev.item_id;
                    var dIdx = toolIndexes[dKey];
                    if (dIdx !== undefined && ev.delta) {
                        toolArgsSeen[dKey] = true;
                        emitDelta({ tool_calls: [{ index: dIdx, function: { arguments: ev.delta } }] });
                    }
                } else if (et === 'response.function_call_arguments.done' || et === 'response.output_item.done') {
                    var doneItem = ev.item || {};
                    // Completed encrypted reasoning item (store:false + include
                    // reasoning.encrypted_content). Forward it as a chat-completions
                    // reasoning_details delta so 010-llm-streaming.js's by-index
                    // merge stores it on the assistant message and
                    // transformToResponses (_openaiReasoningItemsOf) replays it
                    // as {type:'reasoning', id, summary, encrypted_content} on the
                    // next request. Shape = OpenRouter `reasoning.encrypted`
                    // (type/id/data/format/index) so the entry is also a valid
                    // chat-completions reasoning_details element. No text/thinking
                    // key on purpose: the summary is already displayed through
                    // the reasoning_summary_text.delta events above, and the
                    // merge would otherwise render the encrypted blob.
                    if (et === 'response.output_item.done' && doneItem.type === 'reasoning') {
                        if (doneItem.id && typeof doneItem.encrypted_content === 'string' && doneItem.encrypted_content) {
                            emitDelta({
                                reasoning_details: [{
                                    index: reasoningItemIndex++,
                                    type: 'reasoning.encrypted',
                                    format: OPENAI_REASONING_FORMAT,
                                    id: doneItem.id,
                                    data: doneItem.encrypted_content,
                                    summary: Array.isArray(doneItem.summary) ? doneItem.summary : []
                                }]
                            });
                        }
                        continue;
                    }
                    // Some models (e.g. the codex-spark family) return tool-call
                    // arguments in ONE shot with no incremental deltas — synthesize
                    // the full-arguments chunk from the terminal event.
                    // (chat-stream.ts:167-190 in EvanZhouDev/openai-oauth.)
                    var dnKey = ev.item_id || doneItem.id || doneItem.call_id;
                    var dnIdx = toolIndexes[dnKey];
                    if (dnIdx === undefined || toolArgsSeen[dnKey]) continue;
                    var full = ev.arguments;
                    if (full === undefined) full = doneItem.arguments;
                    if (full === undefined) continue;
                    if (typeof full !== 'string') full = JSON.stringify(full);
                    toolArgsSeen[dnKey] = true;
                    emitDelta({ tool_calls: [{ index: dnIdx, function: { arguments: full } }] });
                } else if (et === 'response.completed') {
                    if (finished) continue;
                    // Only a successful terminal response owns usage. Emit it before
                    // finish_reason so the page parser has the final, non-partial
                    // metrics before the assistant message is committed.
                    var usage = (ev.response && ev.response.usage) || {};
                    var inputTokens = Number(usage.input_tokens);
                    var outputTokens = Number(usage.output_tokens);
                    var totalTokens = Number(usage.total_tokens);
                    var inputDetails = usage.input_tokens_details || {};
                    var outputDetails = usage.output_tokens_details || {};
                    var cachedTokens = Number(inputDetails.cached_tokens);
                    var reasoningTokens = Number(outputDetails.reasoning_tokens);
                    if (!Number.isFinite(inputTokens) || inputTokens < 0) inputTokens = 0;
                    if (!Number.isFinite(outputTokens) || outputTokens < 0) outputTokens = 0;
                    if (!Number.isFinite(totalTokens) || totalTokens < 0) totalTokens = inputTokens + outputTokens;
                    if (!Number.isFinite(cachedTokens) || cachedTokens < 0) cachedTokens = 0;
                    if (!Number.isFinite(reasoningTokens) || reasoningTokens < 0) reasoningTokens = 0;
                    emit({
                        id: chunkId,
                        object: 'chat.completion.chunk',
                        created: created,
                        model: model,
                        choices: [],
                        usage: {
                            prompt_tokens: inputTokens,
                            completion_tokens: outputTokens,
                            total_tokens: totalTokens,
                            prompt_tokens_details: { cached_tokens: cachedTokens },
                            completion_tokens_details: { reasoning_tokens: reasoningTokens }
                        }
                    });
                    finished = true;
                    emitDelta({}, sawToolCall ? 'tool_calls' : 'stop');
                } else if (et === 'response.incomplete') {
                    if (finished) continue;
                    var incomplete = (ev.response && ev.response.incomplete_details) || ev.incomplete_details || {};
                    var incompleteReason = incomplete.reason || incomplete.message || 'unknown reason';
                    emit({ error: { message: 'ChatGPT response incomplete: ' + incompleteReason, type: 'incomplete_response', recoverable: true } });
                    finished = true;
                } else if (et === 'response.failed' || et === 'error') {
                    if (finished) continue;
                    var errObj = (ev.response && ev.response.error) || ev.error || {};
                    emit({ error: { message: errObj.message || 'ChatGPT stream error', type: 'api_error' } });
                    finished = true;
                }
            }
        }

        // EOF is never success. Partial text/tool fragments stay uncommitted and
        // cannot trigger tool execution unless response.completed was observed.
        if (!finished && !aborted) {
            emit({ error: { message: 'ChatGPT stream ended before response.completed', type: 'incomplete_stream', recoverable: true } });
            finished = true;
        }
        complete(true);
    } catch (e) {
        if ((e && e.name === 'AbortError') || aborted) {
            try { complete(true); } catch (e2) {}
        } else {
            try { sink({ type: 'error', error: e.message, code: e && e.code, retryable: e && e.retryable }); } catch (e2) {}
            try { complete(false); } catch (e2) {}
        }
    } finally {
        // Every exit path — clean finish, error, abort, and the pre-stream
        // early returns (not-logged-in / refresh-failed / !res.ok) where
        // cgKeepAlive is still null.
        if (cgKeepAlive) { clearInterval(cgKeepAlive); cgKeepAlive = null; }
        activeReader = null;
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    }
}
self.runChatGPTOAuthStream = runChatGPTOAuthStream;

// Thin port wrapper — mirrors the 'claude-oauth-stream' port for page-context
// callers. The SW-internal path calls self.runChatGPTOAuthStream directly.
chrome.runtime.onConnect.addListener(function(port) {
    if (port.name !== 'chatgpt-oauth-stream') return;
    var abortController = new AbortController();
    port.onDisconnect.addListener(function() {
        try { abortController.abort(); } catch (e) {}
    });
    port.onMessage.addListener(function(msg) {
        if (msg.type !== 'start-stream') return;
        var requestBody;
        try { requestBody = JSON.parse(msg.body); }
        catch (e) {
            try { port.postMessage({ type: 'error', error: 'Bad request body: ' + e.message }); } catch (e2) {}
            try { port.postMessage({ type: 'done' }); } catch (e2) {}
            return;
        }
        runChatGPTOAuthStream(requestBody, function(env) {
            try { port.postMessage(env); } catch (e) {}
        }, abortController.signal);
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
        } else if (url.indexOf('https://') === 0) {
            result = { type: 'image', source: { type: 'url', url: url } };
        } else {
            // Anthropic rejects any non-https url source with a hard 400
            // ("Only HTTPS URLs are supported") — chrome-extension://,
            // http://, blob:, or ''/undefined from an image row whose base64
            // payload was evicted and never rehydrated. A text placeholder
            // keeps the request alive instead of crashing the whole run.
            result = { type: 'text', text: '[image no longer available]' };
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
        if (!data) {
            // Same eviction guard as the image arm: an empty document payload
            // (evicted pdf row that was never rehydrated) is a provider 400.
            result = { type: 'text', text: '[document no longer available' + (fn ? ': ' + fn : '') + ']' };
        } else {
            result = { type: 'document', source: { type: 'base64', media_type: mediaType, data: data } };
        }
    } else {
        result = { type: 'text', text: JSON.stringify(part) };
    }
    if (cc) result.cache_control = cc;
    return result;
}

// Claude Fable 5.1+ / Mythos 5.1+ (Sept 2026). These models bind thinking blocks
// to the exact system/tools/prior-message prefix (a mismatch on replay is a 400
// unless the request opts into block_binding.prefix_mismatch_behavior:'drop_block'
// via the thinking-binding-controls beta), and only show readable progress
// updates between tool calls when thinking.display:'updates' is requested
// under the thinking-display-updates beta. Matches the dateless pinned ids
// (claude-fable-5-1) and dated variants (claude-fable-5-1-2026MMDD); does NOT
// match the 5.0 ids (claude-fable-5, claude-fable-5-20260501) which keep the
// display:'summarized' shape — the (?!\d) lookahead is what keeps an 8-digit
// date suffix on a 5.0 id from reading as a minor version (1–2 digit minors
// only). Reused by getAnthropicBetas (header) and transformToAnthropic
// (thinking object) — keep those two in lock-step.
// Docs: https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1
//       https://platform.claude.com/docs/en/models/fable-5-1/migration-guide
//
// FABLE_5_1_PLUS_RE / isFable51Plus are DEFINED in src/js/core/030-config.js
// (single source of truth, shared with buildAPIMessages in the page + SW
// bundles) and reach this file through importScripts('sw-bundle.js') at the
// top. Do not redeclare them here — a second copy is exactly the drift the
// shared definition exists to prevent.

// Beta flags for the OAuth /v1/messages call. The base trio is unconditional
// (OAuth access, interleaved thinking, cache scope); Fable 5.1+ additionally
// needs the two thinking betas that back the block_binding / display:'updates'
// fields transformToAnthropic emits for it — sending those fields WITHOUT the
// betas is a 400, and sending the betas to older models is harmless but noisy,
// so they are gated on the same regex.
var ANTHROPIC_BASE_BETAS = ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'prompt-caching-scope-2026-01-05'];
var ANTHROPIC_FABLE_5_1_BETAS = ['thinking-binding-controls-2026-08-01', 'thinking-display-updates-2026-08-18'];

// Claude models that ACCEPT thinking:{type:'adaptive'} (+ output_config.effort):
// Opus / Sonnet 4.6 and later. Everything the adaptive-ONLY pattern matches
// (ADAPTIVE_ONLY_CLAUDE_RE / isAdaptiveOnlyClaude in src/js/core/030-config.js,
// loaded here via importScripts('sw-bundle.js') like isFable51Plus) is a
// superset of this — transformToAnthropic ORs the two. Anything else
// (Sonnet/Opus ≤4.5, Haiku, 3.x) is treated as LEGACY and gets budget-style
// thinking:{type:'enabled', budget_tokens} — deliberately conservative: a
// budget is accepted by every pre-adaptive model, `adaptive` is not.
var ADAPTIVE_CAPABLE_CLAUDE_RE = /claude-(?:opus|sonnet)-4[.-](?:[6-9]|\d{2,})/;
// Legacy budget for an effort-only provider on a pre-4.6 model (the API has
// no effort control there). Default (no effort, no budget) is
// DEFAULT_THINKING_BUDGET (32000, core/030-config.js).
var LEGACY_EFFORT_BUDGET_TOKENS = { low: 4096, medium: 16000, high: 32000, xhigh: 64000, max: 64000 };
function getAnthropicBetas(model) {
    var betas = ANTHROPIC_BASE_BETAS.slice();
    if (isFable51Plus(model)) betas = betas.concat(ANTHROPIC_FABLE_5_1_BETAS);
    return betas.join(',');
}

function transformToAnthropic(body) {
    var systemBlocks = [];
    var transformedMessages = [];

    // Opus 4.8 / Fable 5 / Mythos 5 accept role:"system" messages MID-conversation
    // (placement rule: immediately after a user turn). For those models, keeping a
    // late system message IN PLACE preserves the prompt prefix — hoisting it to the
    // top-level `system` field (the legacy behavior) rewrites the cached prefix and
    // invalidates every prompt-cache entry for the conversation. Older models
    // (Sonnet 4.6, Opus ≤4.7, Haiku) do not accept mid-conversation system
    // messages, so they keep the hoisting behavior.
    //
    // NOTE: no caller currently produces mid-conversation system messages — the
    // only system-message producer in the app is the single top-of-conversation
    // message built in src/js/app/010-llm-streaming.js (always hoisted because
    // seenNonSystem is false there). This branch is forward wiring for future
    // producers (e.g. sub-agent wake notices); until one exists it is dead code.
    //
    // Keep this pattern in sync with ADAPTIVE_ONLY_CLAUDE_RE in
    // src/js/core/030-config.js — this one is intentionally NARROWER (4.8+,
    // not 4.7) because Opus 4.7 is adaptive-only but does NOT accept
    // mid-conversation system messages.
    var supportsMidSystem = /claude-(?:fable|mythos|opus-(?:[5-9]|\d{2,}|4[.-](?:[89]|\d{2,})))/.test(String(body.model || '').toLowerCase());
    var seenNonSystem = false;

    (body.messages || []).forEach(function(msg) {
        if (msg.role === 'system') {
            var content = msg.content;
            var blocks = [];
            if (typeof content === 'string') blocks.push({ type: 'text', text: content });
            else if (Array.isArray(content)) {
                content.forEach(function(item) {
                    if (typeof item === 'string') blocks.push({ type: 'text', text: item });
                    else if (typeof item === 'object') blocks.push(item); // preserves cache_control
                });
            }
            // Keep mid-conversation system messages inline only when the model
            // supports them AND the preceding transformed message is a user turn
            // (tool results transform to user turns), matching the API placement
            // rule. Anything else falls back to legacy hoisting — still a valid
            // request, just without the cache benefit.
            var prevMsg = transformedMessages[transformedMessages.length - 1];
            if (supportsMidSystem && seenNonSystem && prevMsg && prevMsg.role === 'user') {
                transformedMessages.push({ role: 'system', content: blocks });
            } else {
                systemBlocks = systemBlocks.concat(blocks);
            }
        } else {
            seenNonSystem = true;
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
        // body.max_tokens is always set by the request builder
        // (callOpenRouterStreaming in src/js/app/010-llm-streaming.js, from
        // the global Max Tokens setting) — the literal below is a
        // last-resort fallback. 64000 = DEFAULT_MAX_TOKENS in
        // src/js/core/030-config.js (not importable here) — keep in sync.
        max_tokens: body.max_tokens || 64000,
        stream: true,
        messages: merged
    };

    // Prepend Claude Code identity (required for OAuth token access). Keep the
    // identity block byte-identical — the OAuth backend expects it verbatim —
    // and add a separate bridging block so the jump from "you are a CLI" to the
    // AppAgent role below doesn't read as two contradictory identities.
    var ccIdentity = { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." };
    var ccBridge = { type: 'text', text: 'In this session you are running inside the AppAgent browser extension; the instructions below define your actual role, tools, and behavior.' };
    result.system = [ccIdentity, ccBridge].concat(systemBlocks);

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

    // Fable 5.1+: thinking is always-on adaptive (type 'enabled'/'disabled' → 400),
    // so the thinking object is sent UNCONDITIONALLY for it — even when the
    // provider has no effort/budget configured (effort then stays at the model
    // default; output_config is only emitted when body.reasoning asks for one).
    //   display:'updates'  — readable progress-update thinking blocks between
    //                        tool calls (beta thinking-display-updates-2026-08-18).
    //   block_binding.prefix_mismatch_behavior:'drop_block' — replayed thinking
    //                        blocks whose bound prefix no longer matches (edited
    //                        system prompt, tool roster change, context compaction)
    //                        are dropped server-side and reported in the response's
    //                        input_transformations instead of failing the request
    //                        with a 400 (beta thinking-binding-controls-2026-08-01).
    // Both betas are added by getAnthropicBetas for the same FABLE_5_1_PLUS_RE match.
    //   thinkingOff — the request builder's explicit off switch (global Thinking
    //                 Budget = 0, no provider effort → reasoning:{enabled:false},
    //                 see callOpenRouterStreaming). Fable 5.1+ IGNORES it: its
    //                 thinking is always-on and there is no accepted 'disabled'
    //                 shape, so the forced branch below stays unconditional (the
    //                 Settings hint says "not for Fable 5.1+").
    var fable51 = isFable51Plus(body.model);
    var thinkingOff = !!(body.reasoning && body.reasoning.enabled === false);
    var effort = (body.reasoning && !thinkingOff) ? body.reasoning.effort : null;
    var budget = (body.reasoning && !thinkingOff) ? body.reasoning.max_tokens : null;
    var modelLower = String(body.model || '').toLowerCase();
    var adaptiveOnly = isAdaptiveOnlyClaude(modelLower);
    var adaptiveCapable = adaptiveOnly || ADAPTIVE_CAPABLE_CLAUDE_RE.test(modelLower);
    if (fable51) {
        result.thinking = { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
    } else if (!thinkingOff) {
        if (adaptiveCapable) {
            // Claude 4.6+ adaptive thinking — the model decides how much to think
            // from output_config.effort. display:'summarized' is required for
            // Opus 4.7+ (default changed to 'omitted'). Adaptive-ONLY models get
            // the object even with NO effort/budget configured: without it their
            // thinking is invisible, and budget_tokens is a 400 there —
            // output_config is still omitted so "(default)" effort keeps meaning
            // the model-default effort.
            if (effort || budget || adaptiveOnly) {
                result.thinking = { type: 'adaptive', display: 'summarized' };
            }
        } else if (effort || budget) {
            // LEGACY Claude (≤4.5): budget-style thinking is the only shape.
            // An effort-only provider is mapped to a budget (no effort control
            // on these models; output_config omitted). API rules: 1024 ≤
            // budget_tokens < max_tokens — the budget is clamped under the
            // (user-configured) max_tokens rather than raising max_tokens past a
            // model's output cap. Only when max_tokens is too small to fit the
            // 1024 minimum (max_tokens < 2048) is the pair forced to the smallest
            // valid shape (budget 1024 / max_tokens 2048) — bounded, so it can
            // never exceed any model's output cap.
            var budgetTokens = budget || LEGACY_EFFORT_BUDGET_TOKENS[String(effort).toLowerCase()] ||
                (typeof DEFAULT_THINKING_BUDGET === 'number' ? DEFAULT_THINKING_BUDGET : 32000);
            budgetTokens = Math.max(1024, budgetTokens | 0);
            var budgetCap = result.max_tokens - 1024;
            if (budgetTokens > budgetCap) {
                if (budgetCap >= 1024) {
                    budgetTokens = budgetCap;
                } else {
                    budgetTokens = 1024;
                    result.max_tokens = 2048;
                }
            }
            result.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        }
    }
    // output_config.effort only exists on adaptive models (4.6+ / Fable 5.1+).
    // A budget-only request on an adaptive model keeps the historical mapping
    // to effort:'high' (the budget itself has no adaptive equivalent).
    if (!thinkingOff && (fable51 || adaptiveCapable)) {
        if (effort) result.output_config = { effort: effort };
        else if (budget) result.output_config = { effort: 'high' };
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
                // redacted_thinking blocks (safety-redacted reasoning) carry an
                // opaque `data` payload instead of thinking+signature; the API
                // requires them to be replayed verbatim during tool-use
                // continuations. Captured by the SSE handler in
                // runClaudeOAuthStream as { type:'redacted_thinking', data }.
                if (rd.type === 'redacted_thinking') {
                    if (rd.data) blocks.push({ type: 'redacted_thinking', data: rd.data });
                    return;
                }
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
        var token = '';
        var source = '';

        // Prefer the LIVE tab's current g_ck over the cached token. After a
        // logoff -> logon, ServiceNow mints a brand-new session + g_ck on the
        // tab, but our per-origin cache still holds the OLD token. Pinging
        // touch-session with that stale token — especially with
        // X-WantAuthSessionNotifications below — makes ServiceNow broadcast a
        // "you have been logged off" notification to the open tab even though
        // the user just signed back in. Reading the tab first keeps the
        // heartbeat on the session's current token and refreshes the cache.
        if (tab) {
            var live = await readTokenFromTab(tab);
            if (live) {
                token = live;
                source = 'tab';
                if (!cached || cached.token !== live) {
                    cache[origin] = { token: live, userName: (cached && cached.userName) || '', updated: Date.now() };
                    cacheDirty = true;
                }
            }
        }

        // Fall back to the cached heartbeat token only when no live tab yielded
        // one (all tabs closed, or discarded by Chrome's Memory Saver — no JS
        // context to probe). This keeps tab-less instances pinging/connected.
        if (!token && cached && cached.token) {
            token = cached.token;
            source = 'cache';
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

// RELOAD-DB backstop: when the MV3 service worker is about to be suspended,
// close its cached IDB connection cleanly. closeDatabase() is defined in the
// imported sw-bundle.js (WORKER_SHARED_FILES -> core/130-indexeddb.js). This
// does NOT fire on an abrupt chrome.runtime.reload() (the 'prepare-reload'
// port message covers that path), but it cleanly releases the connection on a
// normal idle suspend so it is never abandoned mid-teardown.
if (chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener) {
    chrome.runtime.onSuspend.addListener(function() {
        try { if (typeof closeDatabase === 'function') closeDatabase(); } catch (e) {}
    });
}

// =============================================================
// Offscreen helper — DOM ops + keep-alive ONLY.
//
// The agent loop lives in THIS SW (loaded via importScripts at the
// top of this file). The offscreen document is just:
//   1. A keep-alive shell — the persistent 'sw-keepalive' port the
//      offscreen opens to us holds the SW alive while the doc exists.
//   2. A DOM helper — handles requests for js_eval sandbox, skills
//      sandbox iframe, and image canvas operations that need real
//      DOM (SW has OffscreenCanvas but not <iframe>/Image).
//
// SW state to track: whether the doc exists + its keep-alive port +
// how many agents currently want it open. We create it lazily when
// the first agent run starts AND/OR when an LLM call wants image
// processing, and close it after a grace period of full idleness.
// =============================================================

var _swOffscreenCreating = null;          // Promise while creation is in flight (avoid races)
var _swOffscreenKeepAlivePort = null;     // Persistent port opened by offscreen → SW
var _swOffscreenIdleSince = 0;            // ms when last run finished; 0 = busy or unknown
var _swOffscreenReadyResolvers = [];      // Awaiters that need offscreen up + handlers registered
var OFFSCREEN_IDLE_GRACE_MS = 60 * 1000;  // close offscreen 60s after the last run ends

async function ensureOffscreenDocument() {
    if (typeof chrome.offscreen === 'undefined') {
        console.error('[SW] chrome.offscreen API unavailable — manifest "offscreen" permission missing?');
        return;
    }
    var exists = false;
    try {
        if (typeof chrome.offscreen.hasDocument === 'function') {
            exists = await chrome.offscreen.hasDocument();
        } else {
            var contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
            exists = (contexts && contexts.length > 0);
        }
    } catch (e) { exists = false; }
    if (exists) return;
    if (_swOffscreenCreating) return _swOffscreenCreating;
    _swOffscreenCreating = chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Host the JS sandbox iframe for js_eval / skill tools and provide a keep-alive anchor for the agent loop in the service worker.'
    }).then(function() {
        _swOffscreenCreating = null;
        _swOffscreenIdleSince = 0;
    }).catch(function(e) {
        _swOffscreenCreating = null;
        if (e && e.message && e.message.indexOf('single offscreen document') >= 0) return;
        console.error('[SW] offscreen creation failed', e);
    });
    return _swOffscreenCreating;
}

// Wait until the offscreen doc is up AND has connected its keep-alive
// port (== handlers are registered). Resolves to true if ready.
function waitForOffscreenReady(timeoutMs) {
    if (_swOffscreenKeepAlivePort) return Promise.resolve(true);
    ensureOffscreenDocument();
    return new Promise(function(resolve) {
        var done = false;
        var entry = function() { if (!done) { done = true; resolve(true); } };
        _swOffscreenReadyResolvers.push(entry);
        setTimeout(function() {
            if (!done) {
                done = true;
                var idx = _swOffscreenReadyResolvers.indexOf(entry);
                if (idx >= 0) _swOffscreenReadyResolvers.splice(idx, 1);
                resolve(false);
            }
        }, timeoutMs || 5000);
    });
}

// Called by the SW runtime (sw-bundle.js, worker/010-platform-stub.js)
// any time the agent loop needs DOM (js_eval, skills sandbox, image).
// Returns the helper's response or throws on timeout.
async function callOffscreenHelper(type, payload, timeoutMs) {
    var ready = await waitForOffscreenReady(timeoutMs || 5000);
    if (!ready) throw new Error('Offscreen helper not available');
    // Promise-style sendMessage — Chrome MV3 supports it. The offscreen
    // returns a {ok:true, result} or {ok:false, error} envelope.
    var resp = await chrome.runtime.sendMessage({
        type: type,
        payload: payload
    });
    if (!resp) throw new Error('Offscreen helper returned no response');
    if (!resp.ok) throw new Error(resp.error || 'Offscreen helper error');
    return resp.result;
}
// Expose to the imported SW bundle.
self.callOffscreenHelper = callOffscreenHelper;
self.ensureOffscreenDocument = ensureOffscreenDocument;

async function maybeCloseOffscreenIfIdle() {
    if (!_swOffscreenIdleSince) return;
    // Don't close while any agent run is active.
    if (typeof runningChatIds === 'object' && runningChatIds) {
        for (var c in runningChatIds) {
            if (runningChatIds[c]) return;
        }
    }
    if (Date.now() - _swOffscreenIdleSince < OFFSCREEN_IDLE_GRACE_MS) return;
    // PERSIST-BUSY (root-cause fix): never reap the persistence realm while
    // IndexedDB work is in flight. Closing the offscreen doc drops the SW
    // keep-alive port; Chrome then kills THIS realm (~30s later) — the realm
    // running every [chats, chat_payloads] transaction. A kill mid-write
    // discarded the uncommitted transaction (chats missing from the store
    // until a reload/restart re-saved them) and could wedge Chromium's IDB
    // backend for the whole origin (reads AND writes hanging until a Chrome
    // restart). Judging idle by runningChatIds alone is exactly how that
    // fired on every idle cycle under save congestion. Defer instead — the
    // 30s heartbeat re-checks and closes once the save channel is quiet.
    if (typeof persistenceBusyReason === 'function') {
        var _pbr = persistenceBusyReason();
        if (_pbr) {
            console.log('[sw] offscreen idle-close deferred: ' + _pbr);
            return;
        }
    }
    try {
        if (typeof chrome.offscreen !== 'undefined' && chrome.offscreen.closeDocument) {
            await chrome.offscreen.closeDocument();
        }
    } catch (e) { /* ignore — already gone */ }
    _swOffscreenIdleSince = 0;
    _swOffscreenKeepAlivePort = null;
}
self.markOffscreenMaybeIdle = function() { _swOffscreenIdleSince = Date.now(); };

// Offscreen→SW keep-alive port. Offscreen opens this in offscreen-helper.js
// right after its onMessage handlers are registered. While the port is open,
// the SW stays alive (port traffic resets the idle timer). The offscreen
// document also stays alive while the SW holds the port reference.
chrome.runtime.onConnect.addListener(function(port) {
    if (port.name !== 'sw-keepalive') return;
    _swOffscreenKeepAlivePort = port;
    _swOffscreenIdleSince = 0;
    // Drain ready-waiters now that offscreen is fully online.
    var waiters = _swOffscreenReadyResolvers.splice(0);
    waiters.forEach(function(fn) { try { fn(); } catch (e) {} });
    port.onDisconnect.addListener(function() {
        if (_swOffscreenKeepAlivePort === port) _swOffscreenKeepAlivePort = null;
    });
});

// Heartbeat alarm. Two jobs:
//   1. Keep the SW alive (chrome.* call resets the SW idle timer).
//   2. Close the offscreen doc after the idle grace period.
//   3. Resume runs that the IDB checkpoint store says were in-flight.
chrome.alarms.create('agent-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(function(alarm) {
    if (alarm.name !== 'agent-heartbeat') return;
    chrome.storage.local.get('agent-heartbeat-tick', function() {});
    maybeCloseOffscreenIfIdle();
    _swResumeIfNeeded();
    // WAKE-DUR: deliver durably-persisted sub-agent parent wakes
    // (pending_wakes store) user-independently. _swResumeIfNeeded only
    // resumes 'running' checkpoints — a parent waiting on subs has none,
    // so without this a wake lost to SW death stalled until the user
    // typed. drainPendingWakes (core/097, in sw-bundle.js) awaits
    // self._swBootReady itself, dedupes against the transcript, and is
    // single-flight. Fully guarded — must never break the keepalive.
    try {
        if (typeof drainPendingWakes === 'function') drainPendingWakes();
    } catch (e) { /* non-fatal */ }
    // Prompt-cache heartbeat (see sendCacheHeartbeat in
    // src/js/app/010-llm-streaming.js). Fully guarded — must never break
    // the SW keepalive above.
    try { _cacheHeartbeatTick(); } catch (e) { /* non-fatal */ }
    // SLEEP-WEDGE: round-trip probe the SW realm's cached IDB connection so
    // a silently-dead post-suspend connection is dropped and reopened instead
    // of hanging the next checkpoint/chat save. probeDbAfterResume lives in
    // core/130-indexeddb.js (inside sw-bundle.js) and is single-flight +
    // throttled internally. Fully guarded — must never break the keepalive.
    try { if (typeof probeDbAfterResume === 'function') probeDbAfterResume(); } catch (e) { /* non-fatal */ }
    // SW-IDLE-CLOSE (empty-chat-list root fix): release the SW's cached IDB
    // connection once it has been idle (see DB_SW_IDLE_CLOSE_MS) so it is never
    // held long enough to be abandoned by an abrupt SW kill / OS sleep, which
    // wedges the origin's IDB backing store and makes the next reload render an
    // empty chat list. Alarm-driven because setTimeout is unreliable in an MV3
    // SW. Lives in core/130-indexeddb.js (sw-bundle). Guarded — must never
    // break the keepalive.
    try { if (typeof maybeReleaseIdleDbConnection === 'function') maybeReleaseIdleDbConnection(); } catch (e) { /* non-fatal */ }
    // LEGACY-MIGRATE: move ONE legacy-inline chat record per tick into the
    // v16 chat_payloads shape (see migrateNextLegacyChatPayloads in
    // worker/115-storage.js, sw-bundle). Bounded work per tick — one chat's
    // payloads hydrated, saved, re-evicted. No-op once the boot-time queue
    // is drained. Guarded — must never break the keepalive.
    try { if (typeof migrateNextLegacyChatPayloads === 'function') migrateNextLegacyChatPayloads(); } catch (e) { /* non-fatal */ }
});

// ─── Prompt-cache heartbeat trigger ─────────────────────────────────────
// Anthropic's prompt cache expires ~5 min after the last request. For every
// chat that is WAITING ON SUB-AGENTS and idle > 4 min, re-send its last
// request body (stamped by callOpenRouterStreaming into self._cacheHeartbeat)
// as a discarded 1-token request so the cache TTL rolls forward. Runs on the
// existing 30s agent-heartbeat alarm tick.
var CACHE_HEARTBEAT_AFTER_MS = 4 * 60 * 1000;      // idle threshold
var CACHE_HEARTBEAT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // stale-run safety stop

function _cacheHeartbeatTick() {
    var reg = self._cacheHeartbeat;
    if (!reg) return;
    var now = Date.now();
    for (var chatId in reg) {
        try {
            var entry = reg[chatId];
            // lastRealRequestAt anchors the 2h lifetime (immutable between
            // real requests); legacy entries stamped by older code only carry
            // `at`, which doubles as the anchor for them. lastHeartbeatAt only
            // paces the 4-minute cadence — it must NOT extend the lifetime
            // (the old code reset entry.at on every heartbeat, so the 2h hard
            // stop below could never fire).
            var born = entry && (entry.lastRealRequestAt || entry.at);
            if (!entry || !born) continue;
            // Lifetime hard stop: a run older than 2h is dead — drop the entry
            // so we never heartbeat a stale conversation forever.
            if (now - born > CACHE_HEARTBEAT_MAX_AGE_MS) { delete reg[chatId]; continue; }
            var lastActivity = (entry.lastHeartbeatAt && entry.lastHeartbeatAt > born) ? entry.lastHeartbeatAt : born;
            if (now - lastActivity < CACHE_HEARTBEAT_AFTER_MS) continue;
            // Only chats actually waiting on sub-agent work get heartbeats.
            if (!_chatWaitingOnSubAgents(chatId)) continue;
            // Skip if a REAL stream is currently in flight for this chat —
            // it refreshes the cache itself (and will re-stamp on dispatch).
            if (typeof currentStreamAbortControllers !== 'undefined'
                && currentStreamAbortControllers[chatId]) continue;
            if (typeof self.sendCacheHeartbeat === 'function') {
                self.sendCacheHeartbeat(chatId);
            }
        } catch (e) { /* per-chat, non-fatal */ }
    }
}

// "Waiting on sub-agents" = (a) a RUNNING sub whose parent is this chat
// (covers turn-ended-waiting-for-wake_parent), OR (b) a pending
// spawn_sub_agent handle for this chat (covers blocked-in-await_handle).
// Both registries live in sw-bundle.js (core tier), imported above.
function _chatWaitingOnSubAgents(chatId) {
    try {
        if (self.SubAgents && typeof self.SubAgents.listAll === 'function') {
            var subs = self.SubAgents.listAll();
            for (var i = 0; i < subs.length; i++) {
                var r = subs[i];
                if (r && r.parent_chat_id === chatId && r.state === 'running') return true;
            }
        }
        if (self.Handles && typeof self.Handles.list === 'function') {
            var hs = self.Handles.list(chatId);
            for (var j = 0; j < hs.length; j++) {
                if (hs[j] && hs[j].status === 'pending' && hs[j].tool === 'spawn_sub_agent') return true;
            }
        }
    } catch (e) { /* registries not hydrated yet — treat as not waiting */ }
    return false;
}

async function _swResumeIfNeeded() {
    try {
        if (typeof listRunningAgentCheckpoints !== 'function') return;
        var checkpoints = await listRunningAgentCheckpoints();
        if (!checkpoints || !checkpoints.length) return;
        // The sw-bundle's entry already does its own resume scan on
        // SW boot; this alarm just re-triggers it after a long idle.
        if (typeof resumeRunningCheckpoints === 'function') {
            resumeRunningCheckpoints(checkpoints);
        }
    } catch (e) { /* non-fatal */ }
}

chrome.runtime.onStartup.addListener(function() { _swResumeIfNeeded(); });
chrome.runtime.onInstalled.addListener(function() { _swResumeIfNeeded(); });

// DNR rule: spoof User-Agent for Anthropic API requests
chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [3000],
    addRules: [{
        id: 3000,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'claude-cli/2.1.257 (external, cli)' }] },
        condition: { urlFilter: 'api.anthropic.com/*', resourceTypes: ['xmlhttprequest'] }
    }]
}).catch(function() {});
