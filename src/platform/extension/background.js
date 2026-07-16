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
            if (message.payload && message.payload.chatId && typeof _sandboxActivity !== 'undefined') {
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
        if (u == null) u = bucket.used_fraction;
        if (u == null) u = bucket.utilization_percent;
        var un = parseFloat(u);
        if (!isNaN(un)) {
            // claude.ai reports utilization as a percent (0-100); the header shape
            // the indicator parses (fetchCredits) expects a 0-1 fraction — it
            // multiplies values <= 1 by 100. Canonicalize to a fraction here so
            // sub-1% utilization doesn't render ~100x too large.
            un = un > 1 ? un / 100 : un;
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
// Resolves when ANY in-flight stream ends, or after timeoutMs — whichever
// comes first. Never rejects.
function _waitForFreeStreamSlot(timeoutMs) {
    return new Promise(function(resolve) {
        var done = false;
        function fire() {
            if (done) return;
            done = true;
            // Remove ourselves so timed-out waiters don't accumulate in the
            // array when no stream ever completes (inert but unbounded).
            var i = _claudeStreams.waiters.indexOf(fire);
            if (i >= 0) _claudeStreams.waiters.splice(i, 1);
            resolve();
        }
        _claudeStreams.waiters.push(fire);
        setTimeout(fire, timeoutMs);
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
                await _waitForFreeStreamSlot(parkMs);
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
            await new Promise(function(r) { setTimeout(r, retryDelayMs); });
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
            if (!entry || !entry.at) continue;
            var idle = now - entry.at;
            if (idle < CACHE_HEARTBEAT_AFTER_MS) continue;
            // Safety stop: a run idle for 2h+ is dead — drop the entry so we
            // never heartbeat a stale conversation forever.
            if (idle > CACHE_HEARTBEAT_MAX_AGE_MS) { delete reg[chatId]; continue; }
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
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'claude-cli/2.1.37 (external, cli)' }] },
        condition: { urlFilter: 'api.anthropic.com/*', resourceTypes: ['xmlhttprequest'] }
    }]
}).catch(function() {});
