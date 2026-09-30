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
            snUpdateInstanceTokens(function(map) {
                map[info.origin] = { token: info.token, userName: info.userName || '', updated: Date.now() };
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
                function isOurs(d) {
                    return !!d && typeof d.type === 'string' && d.type.indexOf('appagent-') === 0;
                }
                // TA3-4: does one log argument carry our payload (the posted object, an event
                // wrapping it, or its serialized form)? Duck-typed, so cross-realm objects match too.
                function carriesOurs(a) {
                    try {
                        if (typeof a === 'string') return a.indexOf('appagent-') === 0 || a.indexOf('"type":"appagent-') !== -1;
                        return !!a && typeof a === 'object' && (isOurs(a) || isOurs(a.data));
                    } catch (e) { return false; }
                }
                function capture(level, args) {
                    // S0C4-06: a page 'message' listener that logs our own appagent-* posts
                    // would re-enter capture and loop forever; skip logs made while one is dispatched.
                    var ev = window.event;
                    if (ev && ev.type === 'message' && ev.data && typeof ev.data.type === 'string' && ev.data.type.indexOf('appagent-') === 0) return;
                    // TA3-4: window.event is unset for a later-task (setTimeout) or cross-realm log,
                    // so also drop any log that carries our payload (private channel later).
                    var list = Array.prototype.slice.call(args);
                    if (list.some(carriesOurs)) return;
                    var msg = list.map(function(a) {
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
                    // S0C4-10: fetch(new Request(...)) carries its method/url on the Request itself.
                    // All probing stays in one try: a non-callable page global Request ({}/null) or a
                    // Proxy / Object.create(Request.prototype) input must never make fetch() throw.
                    var isReq = false, method, reqUrl = '';
                    try {
                        isReq = typeof Request === 'function' && url instanceof Request;
                        method = (opts && opts.method) || (isReq ? url.method : 'GET');
                        reqUrl = isReq ? url.url : String(url);
                    } catch (e) {
                        method = (opts && opts.method) || 'GET';
                        reqUrl = '';
                    }
                    var start = Date.now();
                    return origFetch.apply(this, arguments).then(function(res) {
                        window.postMessage({
                            type: 'appagent-network',
                            method: method,
                            url: reqUrl,
                            status: res.status,
                            duration: Date.now() - start
                        }, '*');
                        return res;
                    }, function(err) {
                        window.postMessage({
                            type: 'appagent-network',
                            method: method,
                            url: reqUrl,
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
                        xhrStart = null;
                        return origOpen.apply(xhr, arguments);
                    };
                    // S0C4-10: one loadend listener per XHR posts once per send, also on
                    // error/abort/timeout (status 0); send/loadstart only stamp the start time.
                    // TA4-8: XMLHttpRequest.prototype.send.call(xhr) skips the send wrapper, so every
                    // async send is also stamped on loadstart; a send with no stamp (a sync prototype
                    // send) posts duration null, and open/each post clear the stamp (never stale).
                    xhr.addEventListener('loadstart', function() { xhrStart = Date.now(); });
                    xhr.addEventListener('loadend', function() {
                        var started = xhrStart;
                        xhrStart = null;
                        window.postMessage({
                            type: 'appagent-network',
                            method: xhrMethod,
                            url: String(xhrUrl),
                            status: xhr.status,
                            duration: started === null ? null : Date.now() - started
                        }, '*');
                    });
                    var origSend = xhr.send;
                    xhr.send = function() {
                        xhrStart = Date.now();
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

// --- App tab: toolbar click + reopen-after-Reload (APP-TAB-REOPEN) ---
//
// Clean reload (PR B1): the in-app Reload (app/060-keep-awake.js) sends
// {type:'app-clean-reload'}. This SW acks {ok:true, ack} at once (synchronously,
// before any await), then writes the reopen marker {at, attempts:0, tabId:null}
// (bounded 1s), closes EVERY extension tab (query+remove bounded ~3s together)
// and only then calls chrome.runtime.reload(). Without an ack within 1.5s the
// page reloads on its own (the page first writes its own Date.now() number
// marker, pre-timestamp builds wrote 'true'; both are still accepted). The
// fresh SW consumes the marker and reopens the app as a full tab
// (sidePanel.open() needs a user gesture).
// Ready handshake: a created tab only counts once its page proves it booted:
// app/070-app-tab-ready.js sends {type:'app-tab-ready'} (recorded even before
// the tabs.create answer). No ready within REOPEN_APP_TAB_READY_MS: the tab is
// closed and one more is created, at most REOPEN_APP_TAB_MAX_ATTEMPTS per Reload
// (counted in the marker, so an SW restart mid-wait closes the unproven tab and
// continues the count; after the final attempt it leaves that tab open and
// gives up). The last tab is left open, never closed; a toolbar click during a
// wait adopts the tab being verified (never closed either).
// Survivors (old-instance app tabs still open ~2s after the reload) are closed,
// never focused or reloaded.
// Kept from earlier fixes: the marker is timestamped and dropped when stale;
// consumption is single-flight and re-checked (startup, onInstalled, delayed
// re-checks); a toolbar click atomically cancels a pending marker and reuses a
// tab the reopen just opened (no second tab). (m1) a reopen only ever touches
// the app tabs that existed at this instance's FIRST attempt (id snapshot kept
// in memory and in chrome.storage.session), never a tab of the new instance;
// (m2) a click cancels the in-flight attempt at its next checkpoint (~one poll).
// HANG-FIX: every chrome.* call here is bounded (REOPEN_APP_TAB_CALL_MS), a
// whole flight by a benign watchdog (REOPEN_APP_TAB_WATCHDOG_MS: it stops later
// creates and marker writes and drops the marker, never closes a tab), and a
// click waits at most REOPEN_APP_TAB_CLICK_WAIT_MS for it, then opens anyway.
var APP_TAB_PATH = 'app.html?mode=tab';
var REOPEN_APP_TAB_MAX_AGE_MS = 60 * 1000;   // marker older than this is stale
var REOPEN_APP_TAB_REUSE_MS = 10 * 1000;     // click right after a reopen reuses that tab
var REOPEN_APP_TAB_SETTLE_POLLS = 8;         // x250ms: wait ~2s for the OLD instance's app tabs to close
var REOPEN_APP_TAB_POLL_MS = 250;
var REOPEN_APP_TAB_SUSPECTS_KEY = 'reopenAppTabSuspects'; // chrome.storage.session: m1 snapshot {ids, marker, at}
var REOPEN_APP_TAB_CALL_MS = 3000;           // max wait for any single chrome.* call below
var REOPEN_APP_TAB_WATCHDOG_MS = 25 * 1000;  // a whole reopen flight; then it is abandoned (benign)
var REOPEN_APP_TAB_CLICK_WAIT_MS = 1500;     // a toolbar click waits at most this for the reopen
var REOPEN_APP_TAB_READY_MS = 8000;          // a created tab must send app-tab-ready within this
var REOPEN_APP_TAB_MAX_ATTEMPTS = 2;         // tabs created + waited for per Reload (marker.attempts)
var REOPEN_APP_TAB_CLEAN_REMOVE_MS = 3000;   // one bounded tabs.query + remove phase
var REOPEN_APP_TAB_READY_TTL_MS = 60 * 1000; // readyTabs entries older than this are pruned
var REOPEN_APP_TAB_PEEK_MS = 1000;           // MED-1: bound of the tabs.get once a ready wait ran out
var REOPEN_APP_TAB_STALE_READY_MS = 500;     // LOW-1: a restart's unverified tab gets this for its waking ready
var _appTabReopenState = {
    done: false, inFlight: null, tab: null, at: 0, suspectIds: null, clickOpened: false,
    verifying: null,    // the created tab awaiting its app-tab-ready
    adoptedTabId: null, // a verifying tab a toolbar click took over (never closed)
    readyTabs: {},      // tabId -> {bootId, at, nav, prevBoot, t}, recorded before any wait
    readyWaiters: {},   // tabId -> fn of the pending _reopenWaitReady
    verifyWaiters: []   // clicks waiting for a created tab to start verifying
};
var _reopenCleanReloadInFlight = false;
// F4 (Boot OOM): ONE toolbar click at a time. A click while another is in
// flight joins it; a click right after one that showed a tab is debounced; an
// existing plain app tab is focused (live) or reloaded (not known alive)
// instead of opening another app instance (_clickReuseOrCreate).
var APP_TAB_CLICK_DEBOUNCE_MS = 2000;
var APP_TAB_CLICK_SW_GRACE_MS = 2000;        // a live page reconnects its port ~250ms after an SW restart
var _APP_TAB_CLICK_STUCK = { stuck: true };  // the click's reopen wait ran out
var _appTabClick = {
    inFlight: null, last: null, okAt: -Infinity,
    queryHungAt: -Infinity, // last tabs.query of this slice that timed out
    touched: {},            // tabId -> when a click created / reloaded it (boot grace)
    swStartAt: Date.now()
};

function _reopenDelay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// Runs fn() (one chrome.* call) and settles with its result, or rejects with a
// timeout error (err.reopenTimeout) after ms. A result arriving after the
// timeout goes to onLate (e.g. a slow tabs.create) instead of being lost.
function _reopenCall(fn, ms, onLate) {
    ms = ms || REOPEN_APP_TAB_CALL_MS;
    return new Promise(function(resolve, reject) {
        var settled = false;
        setTimeout(function() {
            if (settled) return;
            settled = true;
            var err = new Error('chrome call timed out after ' + ms + 'ms');
            err.reopenTimeout = true;
            reject(err);
        }, ms);
        Promise.resolve().then(fn).then(function(v) {
            if (!settled) { settled = true; resolve(v); return; }
            if (onLate) { try { onLate(v); } catch (e) {} }
        }, function(e) {
            if (!settled) { settled = true; reject(e); }
        });
    });
}

// The ONLY chrome.storage.local write of the reopen code (bounded like every
// chrome.* call here). B2 routes the persisted reopen log through it as well.
function _reopenStorageSet(obj, ms) {
    return _reopenCall(function() { return chrome.storage.local.set(obj); }, ms);
}

// Structured reopen log: the persisted ring buffer below (B2) — read it back
// from chrome.storage.local[REOPEN_LOG_KEY]. Synchronous for callers, never
// throws, never awaited.
function _reopenLog(ev, data) {
    try { _reopenLogPersist(_reopenLogEntry(ev, data)); } catch (e) {}
}

// Persisted reopen log (B2): chrome.storage.local[REOPEN_LOG_KEY] is an array
// of {at, event, ...data}, newest last, only the last REOPEN_LOG_MAX kept, so a
// reopen that went wrong can be read back later. ONE module-level promise chain
// serializes the read-modify-write appends in call order; each get and set is
// bounded by REOPEN_LOG_STEP_MS (the setTimeout race of _reopenCall). A get
// that throws, hangs or answers no object skips that entry (the stored log is
// never overwritten with a partial array); a set that throws or hangs is
// dropped; either way the chain moves on. Nothing here is awaited by a caller,
// so it never delays the clean-reload ack -> marker -> close -> reload order.
var REOPEN_LOG_KEY = 'appagentReopenLog';
var REOPEN_LOG_MAX = 50;          // entries kept, newest last
var REOPEN_LOG_DATA_MAX = 500;    // max chars of one entry's stringified data
var REOPEN_LOG_STEP_MS = 1800;    // bound of each log get / set (matches no flow timer)
var _reopenLogChain = Promise.resolve();

// {at, event, ...data}. Data keys named at / event are kept as data_at /
// data_event; data longer than REOPEN_LOG_DATA_MAX chars once stringified is
// kept as the cut JSON string {data, truncated: true}.
function _reopenLogEntry(ev, data) {
    var entry = { at: Date.now(), event: String(ev).slice(0, 100) };
    var json;
    try { json = JSON.stringify(data == null ? {} : data); } catch (e) { entry.unserializable = true; return entry; }
    if (typeof json !== 'string') return entry;
    if (json.length > REOPEN_LOG_DATA_MAX) { entry.truncated = true; entry.data = json.slice(0, REOPEN_LOG_DATA_MAX); return entry; }
    var copy = JSON.parse(json);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) { entry.data = copy; return entry; }
    Object.keys(copy).forEach(function(k) { entry[k === 'at' || k === 'event' ? 'data_' + k : k] = copy[k]; });
    return entry;
}

// Queues one append (get -> trim -> set) on the chain; returns at once.
function _reopenLogPersist(entry) {
    var local = chrome.storage && chrome.storage.local;
    if (!local || typeof local.get !== 'function' || typeof local.set !== 'function') return;
    var append = function() {
        return _reopenCall(function() { return local.get(REOPEN_LOG_KEY); }, REOPEN_LOG_STEP_MS).then(function(got) {
            if (!got || typeof got !== 'object') return; // not a real read: skip, never overwrite
            var prev = got[REOPEN_LOG_KEY];
            var list = (Array.isArray(prev) ? prev : []).concat([entry]).slice(-REOPEN_LOG_MAX);
            var obj = {};
            obj[REOPEN_LOG_KEY] = list;
            return _reopenStorageSet(obj, REOPEN_LOG_STEP_MS).catch(function() {}); // set threw / timed out: move on
        }, function() {}); // get threw / timed out: skip this entry
    };
    _reopenLogChain = (_reopenLogChain || Promise.resolve()).then(append, append);
}

function _reopenErr(e) {
    try { return String((e && e.message) || e); } catch (x) { return 'error'; }
}

function _reopenTabInfo(t) {
    t = t || {};
    return { id: t.id, url: t.url || t.pendingUrl || '', title: t.title || '', status: t.status || '' };
}

function _reopenRemoveMarker() {
    // Once a clean reload wrote the marker for the NEXT instance, nothing of
    // this lifetime may drop it any more.
    if (_reopenCleanReloadInFlight) return Promise.resolve();
    return _reopenCall(function() { return chrome.storage.local.remove('reopenAppTab'); }).catch(function() {});
}

// Bounded close of tab ids: one tabs.remove per id (an id that is already gone
// never keeps the others open), all together at most ms. Never throws;
// resolves the number of tabs Chrome confirmed closed.
function _reopenRemoveTabs(ids, ms) {
    var list = (ids || []).filter(function(id) { return typeof id === 'number'; });
    if (!list.length || !chrome.tabs || !chrome.tabs.remove) return Promise.resolve(0);
    var all = Promise.all(list.map(function(id) {
        return Promise.resolve().then(function() { return chrome.tabs.remove(id); }).then(function() { return 1; }, function(e) {
            _reopenLog('remove-failed', { tabId: id, error: _reopenErr(e) });
            return 0;
        });
    })).then(function(r) { return r.reduce(function(a, b) { return a + b; }, 0); });
    return _reopenCall(function() { return all; }, ms || REOPEN_APP_TAB_CLEAN_REMOVE_MS).catch(function(e) {
        _reopenLog('remove-timeout', { tabIds: list, error: _reopenErr(e) });
        return 0;
    });
}

// A reopen tab whose create answered only after we stopped waiting: keep it as
// THE reopened tab, unless another app tab was opened meanwhile (then close it,
// so a slow create never leaves a duplicate). Only ever touches that new tab.
function _reopenLateTab(tab) {
    var st = _appTabReopenState;
    if (!tab || tab.id == null) return;
    if (st.clickOpened || (st.tab && st.tab.id !== tab.id)) {
        _reopenLog('late-tab-closed', { tabId: tab.id });
        _reopenRemoveTabs([tab.id]);
        return;
    }
    _reopenLog('late-tab-adopted', { tabId: tab.id });
    st.done = true;
    st.tab = tab;
    st.at = Date.now();
    _reopenRemoveMarker();
}

// Wait ~ms in poll-sized steps; returns early once a toolbar click took over
// (st.done), so the click never waits more than ~one poll for this attempt.
function _reopenNap(ms) {
    if (_appTabReopenState.done || ms <= 0) return Promise.resolve();
    var step = Math.min(ms, REOPEN_APP_TAB_POLL_MS);
    return _reopenDelay(step).then(function() { return _reopenNap(ms - step); });
}

// The tab (tabs.get snapshot) while it exists, else null (also when tabs.get
// did not answer). Chrome closes an unloaded extension's tabs asynchronously,
// so a tab seen right after reload() may vanish a moment later.
function _reopenGetTab(id) {
    if (!chrome.tabs.get) return Promise.resolve({ id: id });
    return _reopenCall(function() { return chrome.tabs.get(id); }).then(function(t) { return t || null; }, function() { return null; });
}

function _appTabUrl() { return chrome.runtime.getURL(APP_TAB_PATH); }

function _createAppTab() {
    return _reopenCall(function() { return chrome.tabs.create({ url: _appTabUrl() }); });
}

function _focusAppTab(tab) {
    return _reopenCall(function() { return chrome.tabs.update(tab.id, { active: true }); }).then(function(t) {
        var winId = (t && t.windowId != null) ? t.windowId : tab.windowId;
        if (winId != null && chrome.windows && chrome.windows.update) {
            return _reopenCall(function() { return chrome.windows.update(winId, { focused: true }); }).catch(function() {}).then(function() { return t || tab; });
        }
        return t || tab;
    });
}

// Normalized reopen marker {at, attempts, tabId} (+legacy), or null. Accepts
// the object this SW writes, a Date.now() number and the legacy 'true'.
function _reopenMarker(v) {
    if (v === true) return { at: Date.now(), attempts: 0, tabId: null, legacy: true };
    if (typeof v === 'number') return isFinite(v) ? { at: v, attempts: 0, tabId: null } : null;
    if (v && typeof v === 'object' && typeof v.at === 'number' && isFinite(v.at)) {
        var n = (typeof v.attempts === 'number' && isFinite(v.attempts) && v.attempts > 0) ? Math.floor(v.attempts) : 0;
        return { at: v.at, attempts: n, tabId: typeof v.tabId === 'number' ? v.tabId : null };
    }
    return null;
}

function _reopenMarkerIsFresh(v) {
    var m = _reopenMarker(v);
    if (!m) return false;
    if (m.legacy) return true; // legacy marker from a pre-timestamp page build
    var age = Date.now() - m.at;
    return age >= -5000 && age <= REOPEN_APP_TAB_MAX_AGE_MS;
}

// true once tabId sent app-tab-ready (at once when it already did, e.g. before
// its tabs.create answered), false after ms. The waiter is always cleaned up.
function _reopenWaitReady(tabId, ms) {
    var st = _appTabReopenState;
    if (st.readyTabs[tabId]) return Promise.resolve(true);
    return new Promise(function(resolve) {
        var finished = false;
        function finish(ok) {
            if (finished) return;
            finished = true;
            if (st.readyWaiters[tabId] === onReady) delete st.readyWaiters[tabId];
            resolve(ok);
        }
        function onReady() { finish(true); }
        st.readyWaiters[tabId] = onReady;
        setTimeout(function() { finish(!!st.readyTabs[tabId]); }, ms || REOPEN_APP_TAB_READY_MS);
    });
}

// A created tab started verifying: wake the clicks waiting to adopt one.
function _reopenFireVerify(tab) {
    var st = _appTabReopenState, list = st.verifyWaiters;
    st.verifyWaiters = [];
    list.forEach(function(fn) { try { fn(tab); } catch (e) {} });
}

// Our own extension pages only (same rule as _openaiTrustedAuthSender).
function _reopenTrustedSender(sender) {
    try {
        return !!(sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' &&
            sender.url.indexOf(chrome.runtime.getURL('')) === 0);
    } catch (e) { return false; }
}

// Clean reload, close phase: every tab showing one of our pages (the sender
// too; web tabs untouched). tabs.query + remove share ONE bound.
function _reopenCloseExtensionTabs() {
    var base = chrome.runtime.getURL('');
    var work = Promise.resolve().then(function() { return chrome.tabs.query({}); }).then(function(tabs) {
        var mine = (tabs || []).filter(function(t) { return t && t.id != null && String(t.url || t.pendingUrl || '').indexOf(base) === 0; });
        _reopenLog('clean-reload-close', { tabs: mine.map(_reopenTabInfo) });
        return _reopenRemoveTabs(mine.map(function(t) { return t.id; }), REOPEN_APP_TAB_CLEAN_REMOVE_MS);
    });
    return _reopenCall(function() { return work; }, REOPEN_APP_TAB_CLEAN_REMOVE_MS).catch(function(e) {
        _reopenLog('clean-reload-close-failed', { error: _reopenErr(e) });
        return 0;
    });
}

// app-clean-reload: ack at once (synchronously, before any await) -> marker
// (bounded 1s) -> close every extension tab (one <=3s bound) -> finally
// runtime.reload(). The ack comes first because an SW cold start plus the 1s
// marker write could miss the page's 1.5s fallback; the page already wrote its
// own reopenAppTab timestamp before sending, so an early ack loses nothing.
// Single-flight: a repeat only gets the same ack. Foreign senders: nothing.
function _reopenOnCleanReload(msg, sender, sendResponse) {
    if (!_reopenTrustedSender(sender)) {
        _reopenLog('clean-reload-rejected', { senderId: sender ? sender.id : null, url: sender ? sender.url : null });
        return false;
    }
    var ack = { ok: true, ack: 'app-clean-reload' };
    if (_reopenCleanReloadInFlight) {
        _reopenLog('clean-reload-dup', { reason: msg.reason || null });
        try { sendResponse(ack); } catch (e) {}
        return false;
    }
    _reopenCleanReloadInFlight = true;
    _appTabReopenState.done = true; // this lifetime's reopen creates / writes nothing more
    _reopenLog('clean-reload', { reason: msg.reason || null, at: msg.at || null, url: sender.url, tabId: sender.tab ? sender.tab.id : null });
    try { sendResponse(ack); } catch (e) {}
    _reopenStorageSet({ reopenAppTab: { at: Date.now(), attempts: 0, tabId: null } }, 1000).catch(function(e) {
        _reopenLog('clean-reload-marker-failed', { error: _reopenErr(e) });
    }).then(function() {
        return _reopenCloseExtensionTabs();
    }).catch(function() {}).then(function() {
        return _reopenArmWakeAlarms();
    }).catch(function() {}).then(function() {
        try { chrome.runtime.reload(); } catch (e) {
            _reopenLog('clean-reload-reload-threw', { error: _reopenErr(e) });
            _reopenCleanReloadInFlight = false;
        }
    });
    return false; // ack already sent synchronously (same as the dup path)
}

// WAKE-AFTER-RELOAD: Chrome does NOT reliably start the new SW after
// chrome.runtime.reload() (boot crumbs showed no sw-start for 33s until the
// user clicked the toolbar icon), so the marker sat unread and nothing
// reopened. chrome.alarms persist across an unload/load (AlarmManager
// re-reads them from the StateStore on OnExtensionLoaded, only uninstall
// clears them), and a firing alarm starts the SW. So right before reload()
// arm a few one-shot wake alarms; their handler (bottom of this slice) runs
// the single-flight _consumeReopenAppTab(). Bounded; never blocks the reload.
var REOPEN_WAKE_ALARM_PREFIX = 'appagent-reopen-wake-';
var REOPEN_WAKE_DELAYS_MS = [1000, 3000, 8000, 20000]; // all well inside REOPEN_APP_TAB_MAX_AGE_MS
function _reopenArmWakeAlarms() {
    if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return Promise.resolve(0);
    var now = Date.now();
    return Promise.all(REOPEN_WAKE_DELAYS_MS.map(function(ms, i) {
        return _reopenCall(function() { return chrome.alarms.create(REOPEN_WAKE_ALARM_PREFIX + i, { when: now + ms }); }, 1000)
            .then(function() { return 1; }, function(e) { _reopenLog('wake-alarm-failed', { i: i, error: _reopenErr(e) }); return 0; });
    })).then(function(r) { return r.reduce(function(a, b) { return a + b; }, 0); });
}
function _reopenClearWakeAlarms() {
    if (!chrome.alarms || typeof chrome.alarms.clear !== 'function') return;
    REOPEN_WAKE_DELAYS_MS.forEach(function(ms, i) {
        try { Promise.resolve(chrome.alarms.clear(REOPEN_WAKE_ALARM_PREFIX + i)).catch(function() {}); } catch (e) {}
    });
}
// A wake alarm started (or found running) this SW: consume the marker. In the
// OLD instance mid clean-reload it does nothing (never clears the others).
function _reopenOnWakeAlarm(alarm) {
    if (!alarm || typeof alarm.name !== 'string' || alarm.name.indexOf(REOPEN_WAKE_ALARM_PREFIX) !== 0) return;
    if (_reopenCleanReloadInFlight) return;
    _reopenLog('wake-alarm', { name: alarm.name, done: !!_appTabReopenState.done });
    return Promise.resolve(_consumeReopenAppTab()).catch(function() {}).then(function() {
        if (_appTabReopenState.done) _reopenClearWakeAlarms();
    });
}

// app-tab-ready (app/070-app-tab-ready.js): recorded BEFORE any wait (it can
// beat the tabs.create answer), then the pending wait for that tab resolves.
// No sender.tab (side panel, offscreen) or a foreign sender: ignored, no reply.
function _reopenOnTabReady(msg, sender, sendResponse) {
    var tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId == null || !_reopenTrustedSender(sender)) return false;
    var st = _appTabReopenState, now = Date.now();
    Object.keys(st.readyTabs).forEach(function(k) {
        var r = st.readyTabs[k];
        if (!r || !(now - r.t <= REOPEN_APP_TAB_READY_TTL_MS)) delete st.readyTabs[k];
    });
    st.readyTabs[tabId] = { bootId: msg.bootId || null, at: msg.at || null, nav: msg.nav || null, prevBoot: msg.prevBoot || null, t: now };
    var waiter = st.readyWaiters[tabId] || null;
    if (waiter) delete st.readyWaiters[tabId];
    _reopenLog('ready', { tabId: tabId, bootId: msg.bootId || null, nav: msg.nav || null, prevBoot: msg.prevBoot || null, awaited: !!waiter });
    if (waiter) { try { waiter(); } catch (e) {} }
    try { sendResponse({ ok: true }); } catch (e) {}
    return false;
}

// Own listener (kept inside this slice so the tests run it); every other
// message type is left to the other listeners (no reply from here).
if (chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
    chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'app-clean-reload') return _reopenOnCleanReload(msg, sender, sendResponse);
        if (msg.type === 'app-tab-ready') { _reopenOnTabReady(msg, sender, sendResponse); return; }
    });
}

// Consume the reopen marker at most once per SW lifetime. Resolves to the tab
// opened for the reopen, or null when there was nothing to do.
function _consumeReopenAppTab() {
    var st = _appTabReopenState;
    if (st.done) return Promise.resolve(st.tab);
    if (st.inFlight) return st.inFlight;
    // Every trigger (startup, onInstalled, delayed re-checks) shares this one
    // in-flight attempt. The marker is removed and 'done' set after a verified
    // (or adopted) tab or a final give-up; a create that failed without any tab
    // keeps it so a later trigger retries (bounded by REOPEN_APP_TAB_MAX_AGE_MS).
    var flight = null;
    var deadline = Date.now() + REOPEN_APP_TAB_WATCHDOG_MS; // when the watchdog below fires (MED-1)
    var run = _reopenCall(function() { return chrome.storage.local.get('reopenAppTab'); }).then(function(data) {
        var v = data && data.reopenAppTab;
        if (v === undefined || v === null || v === false) return null;
        // A toolbar click that happened while the read was in flight already
        // opened the app and cancelled the marker - never open a second tab.
        if (st.done) return st.tab;
        function clear(result) {
            st.done = true;
            return _reopenRemoveMarker().then(function() { return result; });
        }
        var m = _reopenMarker(v);
        if (!m || !_reopenMarkerIsFresh(v)) {
            // Garbage / stale leftover: drop silently. A tab it names is NOT
            // closed (it may be a long-lived healthy tab).
            _reopenLog('marker-dropped', { why: m ? 'stale' : 'invalid' });
            return clear(null);
        }
        return Promise.resolve().then(function() {
            if (m.legacy) {
                // Legacy 'true' has no age: persist it as an aged marker, so
                // MAX_AGE bounds its retries (else it retries on every SW start).
                if (!st.done) return _reopenStorageSet({ reopenAppTab: { at: m.at, attempts: 0, tabId: null } }).catch(function() {});
                return null;
            }
            if (m.tabId == null) return null;
            if (st.readyTabs[m.tabId]) return 'ready';
            // The final attempt's tab never proved it booted, but it is the
            // last tab: leave it open (the last tab is never closed), give up
            // below. LOW-2: whether it is still open is read (bounded tabs.get).
            if (m.attempts >= REOPEN_APP_TAB_MAX_ATTEMPTS) {
                return _reopenGetTab(m.tabId).then(function(t) { return t ? 'final' : 'final-gone'; });
            }
            // An earlier SW lifetime died while this tab awaited its ready: it
            // never proved it booted - close it and continue the count. LOW-1:
            // the ready that woke this SW can lose the race with the storage.get
            // reply, so it gets REOPEN_APP_TAB_STALE_READY_MS before the close.
            return _reopenWaitReady(m.tabId, REOPEN_APP_TAB_STALE_READY_MS).then(function(ready) {
                if (ready) return 'ready';
                return _reopenRemoveTabs([m.tabId]).then(function(removed) {
                    _reopenLog('stale-verify-closed', { tabId: m.tabId, attempts: m.attempts, removed: removed });
                    return null;
                });
            });
        }).then(function(pre) {
            if (st.done) return st.tab;
            if (pre === 'ready') {
                // Its ready is what woke this SW: that tab IS the reopen.
                _reopenLog('verified', { tabId: m.tabId, attempt: m.attempts, restart: true });
                st.tab = { id: m.tabId };
                st.at = Date.now();
                return clear(st.tab);
            }
            if (m.attempts >= REOPEN_APP_TAB_MAX_ATTEMPTS) {
                _reopenLog('gave-up', { why: 'restart-max-attempts', attempts: m.attempts, tabId: m.tabId, leftOpen: pre === 'final' });
                return clear(null);
            }
            return _openAppTabForReopen(m, deadline).then(function(tab) {
                if (tab) return clear(tab);
                // null after a click / give-up is handled; otherwise keep the marker.
                if (!st.done) _reopenLog('not-verified-keep-marker', { attempts: m.attempts });
                return null;
            });
        });
    }).catch(function(e) {
        _reopenLog('check-failed', { error: _reopenErr(e) });
        return null;
    });
    // Watchdog (benign): a flight still pending after REOPEN_APP_TAB_WATCHDOG_MS
    // is abandoned for this SW lifetime. st.done stops every later tabs.create
    // and marker write (both check it synchronously right before; storage ops
    // are FIFO, so a write issued earlier lands before this remove), the marker
    // is dropped so no later SW start pops a surprise tab, and st.inFlight is
    // released. A tab still verifying is NOT closed (a click adopts it).
    var watchdog = new Promise(function(resolve) {
        setTimeout(function() {
            if (st.inFlight !== flight) return; // settled already
            st.done = true;
            _reopenRemoveMarker();
            _reopenLog('gave-up', { why: 'watchdog', ms: REOPEN_APP_TAB_WATCHDOG_MS, verifying: st.verifying ? st.verifying.id : null });
            resolve(null);
        }, REOPEN_APP_TAB_WATCHDOG_MS);
    });
    flight = Promise.race([run, watchdog]).then(function(tab) {
        if (st.inFlight === flight) st.inFlight = null;
        return tab;
    });
    st.inFlight = flight;
    return flight;
}

// New app tab in the last-focused normal window, or in a new window if none.
function _createAppTabForReopen() {
    var url = _appTabUrl();
    return Promise.resolve().then(function() {
        if (!chrome.windows || !chrome.windows.getLastFocused) return null;
        return _reopenCall(function() { return chrome.windows.getLastFocused({ windowTypes: ['normal'] }); }).catch(function() { return null; });
    }).then(function(win) {
        if (_appTabReopenState.done) return null; // m2: a toolbar click took over - open nothing
        if (win && win.id != null) {
            return _reopenCall(function() { return chrome.tabs.create({ url: url, windowId: win.id, active: true }); }, 0, _reopenLateTab).then(function(tab) {
                if (chrome.windows.update) _reopenCall(function() { return chrome.windows.update(win.id, { focused: true }); }).catch(function() {});
                return tab;
            });
        }
        if (chrome.windows && chrome.windows.create) {
            return _reopenCall(function() { return chrome.windows.create({ url: url, focused: true, type: 'normal' }); }, 0, function(w) { _reopenLateTab((w && w.tabs && w.tabs[0]) || null); }).then(function(w) { return (w && w.tabs && w.tabs[0]) || null; });
        }
        return _reopenCall(function() { return chrome.tabs.create({ url: url }); }, 0, _reopenLateTab);
    });
}

// m1: the ONLY app tabs a reopen may wait for or close are the ones present at
// this instance's FIRST reopen attempt (the old instance's tabs Chrome is
// closing). Their ids are snapshotted once and kept on the state and in
// chrome.storage.session (in-memory: survives SW restarts, cleared on
// extension reload/update), so neither a retry nor a later SW lifetime of the
// same instance mistakes a NEW tab (a pop-out, one we created) for a suspect.
// Without a usable storage.session the module-level snapshot still covers
// every retry of this SW lifetime.
function _reopenSessionStore() {
    try { return (chrome.storage && chrome.storage.session) || null; } catch (e) { return null; }
}

function _reopenSuspectIds(marker) {
    var st = _appTabReopenState;
    if (st.suspectIds) return Promise.resolve(st.suspectIds);
    return Promise.resolve().then(function() {
        var s = _reopenSessionStore();
        return s && s.get ? _reopenCall(function() { return s.get(REOPEN_APP_TAB_SUSPECTS_KEY); }) : null;
    }).catch(function() { return null; }).then(function(data) {
        var saved = data && data[REOPEN_APP_TAB_SUSPECTS_KEY];
        // Taken by an earlier SW lifetime for THIS Reload (same marker, fresh):
        // reuse, never re-snapshot. TTL: a snapshot of another Reload, one older
        // than the marker max age, or a legacy bare array is ignored, so state a
        // killed SW left behind can never steer (or stall) a later reopen.
        if (saved && Array.isArray(saved.ids) && saved.marker === marker && typeof saved.at === 'number' &&
            Math.abs(Date.now() - saved.at) <= REOPEN_APP_TAB_MAX_AGE_MS) {
            return saved.ids.filter(function(id) { return typeof id === 'number'; });
        }
        return Promise.resolve().then(function() {
            return _reopenCall(function() { return chrome.tabs.query({ url: _appTabUrl().replace(/\?.*$/, '') + '*' }); });
        }).catch(function(e) {
            if (e && e.reopenTimeout) _appTabClick.queryHungAt = Date.now(); // F4: clicks skip their finder
            return [];
        }).then(function(tabs) {
            var ids = (tabs || []).filter(function(t) { return t && t.id != null && t.url && t.url.indexOf(APP_TAB_PATH) >= 0; }).map(function(t) { return t.id; });
            return Promise.resolve().then(function() {
                var s = _reopenSessionStore(), o = {};
                o[REOPEN_APP_TAB_SUSPECTS_KEY] = { ids: ids, marker: marker, at: Date.now() };
                return s && s.set ? _reopenCall(function() { return s.set(o); }) : null;
            }).catch(function() {}).then(function() { return ids; });
        });
    }).then(function(ids) {
        st.suspectIds = ids;
        return ids;
    });
}

// Reopen after Reload (m = normalized marker). The suspect app tabs (m1
// snapshot above) usually belong to the old instance and Chrome is still
// closing them: wait ~2s for them to disappear, close every survivor (bounded;
// never focus or reload one - it runs the old code), then create a fresh tab
// and wait for its app-tab-ready. Resolves the verified (or click-adopted) tab,
// or null. m2: once a toolbar click set st.done every checkpoint bails out with
// no tabs.create; a tab created meanwhile becomes st.verifying so the click
// adopts it (a click that already opened its own tab gets it closed).
function _openAppTabForReopen(m, deadline) {
    var st = _appTabReopenState;
    function clicked() { return st.done; }
    function remember(tab) { st.tab = tab || null; st.at = Date.now(); return st.tab; }
    // Resolves the suspect tabs (tabs.get snapshots) still open after the
    // settle window, or null once a click took over.
    function settle(ids, polls) {
        if (clicked()) return Promise.resolve(null);
        return Promise.all(ids.map(_reopenGetTab)).then(function(res) {
            var alive = res.filter(function(t) { return t && t.id != null; });
            if (clicked()) return null;
            if (!alive.length || polls >= REOPEN_APP_TAB_SETTLE_POLLS) return alive;
            return _reopenDelay(REOPEN_APP_TAB_POLL_MS).then(function() {
                return settle(alive.map(function(t) { return t.id; }), polls + 1);
            });
        });
    }
    // A rejected create (no tab, e.g. "Tabs cannot be edited right now") is
    // retried with back-off, 3 tries per flight, and uses no attempt (the marker
    // stays for the later triggers). A create that did not answer is never
    // repeated (it may still land: _reopenLateTab adopts it).
    function createTab() {
        var tries = 0;
        function tryCreate() {
            if (clicked()) return Promise.resolve(null);
            tries++;
            return _createAppTabForReopen().then(function(tab) {
                if (tab && tab.id != null) return tab;
                if (clicked()) return null;
                throw new Error('create returned no tab');
            }).catch(function(e) {
                if (clicked()) return null;
                if (e && e.reopenTimeout) {
                    st.done = true;
                    _reopenRemoveMarker();
                    _reopenLog('gave-up', { why: 'create-timeout', error: _reopenErr(e) });
                    return null;
                }
                if (tries >= 3) { _reopenLog('create-failed', { tries: tries, error: _reopenErr(e) }); return null; }
                return _reopenNap(400 * tries).then(tryCreate);
            });
        }
        return tryCreate();
    }
    // One create + ready wait per turn; n = attempts used so far (marker).
    function attempt(n) {
        if (clicked()) return Promise.resolve(null);
        return createTab().then(function(tab) {
            if (!tab) return null;
            if (st.clickOpened) {
                // The click already opened its own tab: never leave a duplicate.
                _reopenLog('dup-closed', { tabId: tab.id });
                _reopenRemoveTabs([tab.id]);
                return null;
            }
            n++;
            _reopenLog('created', { tabId: tab.id, attempt: n, windowId: tab.windowId != null ? tab.windowId : null });
            st.verifying = tab;
            _reopenFireVerify(tab);
            // st.done is checked synchronously right before the write (as before
            // every tabs.create): nothing is written after a click / watchdog.
            if (!st.done) _reopenStorageSet({ reopenAppTab: { at: m.at, attempts: n, tabId: tab.id } }).catch(function() {});
            var extended = false;
            // MED-1: 070 only answers once the WHOLE app.js has evaluated, so a
            // healthy tab can miss READY_MS on a slow boot (Chrome is busy right
            // after a reload). A tab that tabs.get (bounded REOPEN_APP_TAB_PEEK_MS)
            // still reports 'loading' gets ONE more READY_MS, only when that ends
            // before this flight's watchdog (deadline), never after a click or the
            // watchdog. A peek that fails or does not answer: the old verdict.
            function slowBoot() {
                if (clicked() || st.adoptedTabId === tab.id) return false;
                if (typeof deadline === 'number' && Date.now() + REOPEN_APP_TAB_PEEK_MS + REOPEN_APP_TAB_READY_MS > deadline) return false;
                return _reopenCall(function() { return chrome.tabs.get(tab.id); }, REOPEN_APP_TAB_PEEK_MS).then(function(t) {
                    return !!(t && t.status === 'loading');
                }, function() { return false; }).then(function(loading) {
                    if (st.readyTabs[tab.id]) return true; // its ready landed during the peek
                    if (!loading || clicked() || st.adoptedTabId === tab.id) return false;
                    extended = true;
                    _reopenLog('ready-slow-extended', { tabId: tab.id, attempt: n, ms: REOPEN_APP_TAB_READY_MS });
                    return _reopenWaitReady(tab.id, REOPEN_APP_TAB_READY_MS);
                });
            }
            return _reopenWaitReady(tab.id, REOPEN_APP_TAB_READY_MS).then(function(ok) {
                return ok || slowBoot();
            }).then(function(ok) {
                if (st.verifying === tab) st.verifying = null;
                if (ok) {
                    _reopenLog('verified', extended ? { tabId: tab.id, attempt: n, extended: true } : { tabId: tab.id, attempt: n });
                    return remember(tab);
                }
                if (st.adoptedTabId === tab.id) {
                    _reopenLog('click-adopted-verify-end', { tabId: tab.id, attempt: n });
                    return tab;
                }
                _reopenLog('ready-timeout', extended ? { tabId: tab.id, attempt: n, ms: 2 * REOPEN_APP_TAB_READY_MS, extended: true } : { tabId: tab.id, attempt: n, ms: REOPEN_APP_TAB_READY_MS });
                if (st.done) {
                    _reopenLog('verify-abandoned-left-open', { tabId: tab.id, attempt: n });
                    return null;
                }
                // MED-A: a retry closes this tab BEFORE the next create's st.done
                // check (_createAppTabForReopen), so it is only made when that close
                // (CLEAN_REMOVE_MS) and the create (getLastFocused + tabs.create,
                // CALL_MS each) end by this flight's watchdog (deadline): else the
                // watchdog can land in between and leave NO app tab. No deadline: as before.
                var retry = n < REOPEN_APP_TAB_MAX_ATTEMPTS;
                var budget = typeof deadline !== 'number' ||
                    Date.now() + REOPEN_APP_TAB_CLEAN_REMOVE_MS + 2 * REOPEN_APP_TAB_CALL_MS <= deadline;
                if (retry && budget) {
                    return _reopenRemoveTabs([tab.id]).then(function(removed) {
                        _reopenLog('closed-unverified', { tabId: tab.id, attempt: n, removed: removed });
                        return attempt(n);
                    });
                }
                // Last attempt, or no budget left for another: leave the tab open (a
                // slow boot or a lost message must never leave the user without an
                // app tab) and stop here.
                st.done = true;
                _reopenRemoveMarker();
                _reopenLog('gave-up', retry ? { why: 'no-budget', tabId: tab.id, attempts: n, leftOpen: true, left: deadline - Date.now() } : { why: 'max-attempts', tabId: tab.id, attempts: n });
                return null;
            });
        });
    }
    return _reopenSuspectIds(m.at).then(function(ids) {
        return ids.length ? settle(ids, 0) : [];
    }).then(function(survivors) {
        if (!survivors || clicked()) return null;
        if (!survivors.length) return attempt(m.attempts);
        var infos = survivors.map(_reopenTabInfo);
        return _reopenRemoveTabs(survivors.map(function(t) { return t.id; })).then(function(removed) {
            _reopenLog('survivors-closed', { tabs: infos, removed: removed });
            return attempt(m.attempts);
        });
    });
}

// A click while a created tab awaits its ready: that tab becomes the click's
// tab (focused now, never closed by the reopen).
function _reopenAdoptVerifying() {
    var st = _appTabReopenState, tab = st.verifying;
    st.adoptedTabId = tab.id;
    _reopenLog('click-adopted', { tabId: tab.id });
    return _focusAppTab(tab).catch(function() { return _clickCreateAppTab(); });
}

// F4 single-flight: joins a click in flight (click-joined); within
// APP_TAB_CLICK_DEBOUNCE_MS after a click that showed a tab it answers that
// tab again (click-debounced); else runs the click (_onActionClickedRun) now,
// synchronously, so st.done is set before any pending reopen read answers.
function _onActionClicked() {
    var c = _appTabClick, now = Date.now();
    if (c.inFlight) { _reopenLog('click-joined', {}); return c.inFlight; }
    if (c.last && now - c.okAt >= 0 && now - c.okAt < APP_TAB_CLICK_DEBOUNCE_MS) {
        _reopenLog('click-debounced', { ms: now - c.okAt });
        return c.last;
    }
    var run;
    try { run = Promise.resolve(_onActionClickedRun()); } catch (e) { run = Promise.reject(e); }
    var p = run.then(function(tab) {
        if (c.inFlight === p) c.inFlight = null;
        if (tab) c.okAt = Date.now();
        return tab;
    }, function(e) {
        if (c.inFlight === p) c.inFlight = null;
        _reopenLog('click-open-failed', { error: _reopenErr(e) });
        return null;
    });
    c.inFlight = p;
    c.last = p;
    return p;
}

function _onActionClickedRun() {
    var st = _appTabReopenState;
    var pending = st.inFlight;
    // The click IS the open: cancel any pending reopen marker atomically (the
    // in-flight consumer checks st.done before opening) and drop it from storage.
    st.done = true;
    try { _reopenRemoveMarker(); } catch (e) {}
    if (st.verifying) return _reopenAdoptVerifying();
    // BOUNDED: wait for an in-flight reopen at most REOPEN_APP_TAB_CLICK_WAIT_MS
    // (it bails at its next checkpoint) or until a tab it was creating starts
    // verifying (adopted). A stuck chrome.* call used to wedge EVERY click.
    var signal = null;
    var waited = pending ? Promise.race([
        Promise.resolve(pending).catch(function() { return null; }),
        new Promise(function(r) { signal = r; st.verifyWaiters.push(r); }),
        _reopenDelay(REOPEN_APP_TAB_CLICK_WAIT_MS).then(function() { return _APP_TAB_CLICK_STUCK; })
    ]) : Promise.resolve(null);
    return waited.then(function(reopenTab) {
        var stuck = reopenTab === _APP_TAB_CLICK_STUCK;
        if (stuck) reopenTab = null;
        if (signal) st.verifyWaiters = st.verifyWaiters.filter(function(f) { return f !== signal; });
        if (st.verifying) return _reopenAdoptVerifying();
        var tab = reopenTab || st.tab;
        if (tab && tab.id != null && Date.now() - st.at <= REOPEN_APP_TAB_REUSE_MS) {
            // The reopen just opened a tab (this click raced it): show that one.
            st.tab = null;
            return _focusAppTab(tab).catch(function() { return _clickCreateAppTab(); });
        }
        return _clickReuseOrCreate(stuck);
    }).catch(function(e) { _reopenLog('click-open-failed', { error: _reopenErr(e) }); });
}

// F4: an existing PLAIN app tab (never a widget / doc / print / standalone
// page, never a reopen suspect of the old instance) is shown instead of a new
// one: focused when known alive, else reloaded (bounded) and focused. Every
// failure falls back to the create, so a tab always opens. Skipped (the plain
// create) when the click's reopen wait ran out or a tabs.query of this slice
// timed out lately: a hung tabs.query must never delay a click again. At most
// ONE create per click (create below): the trailing catch (e.g. the finder
// threw) creates only if this click has not tried one yet, so a create that
// failed or timed out (it may still land) is never doubled.
function _clickReuseOrCreate(stuck) {
    var c = _appTabClick, created = false;
    var create = function(why) { created = true; return _clickCreateAppTab(why); };
    if (stuck) return create('reopen-stuck');
    if (Date.now() - c.queryHungAt <= REOPEN_APP_TAB_WATCHDOG_MS) return create('query-hung');
    return _reopenCall(function() {
        return chrome.tabs.query({ url: _appTabUrl().replace(/\?.*$/, '') + '*' });
    }, REOPEN_APP_TAB_CLICK_WAIT_MS).then(function(tabs) {
        var pick = _clickPickAppTab(tabs || []);
        if (!pick) return create('no-tab');
        var id = pick.tab.id;
        if (pick.why) {
            return _focusAppTab(pick.tab).then(function(t) {
                _reopenLog('click-focused', { tabId: id, why: pick.why });
                return t;
            }, function() { return create('focus-failed'); });
        }
        return _reopenCall(function() { return chrome.tabs.reload(id); }).then(function() {
            _clickTouch(id);
            return _clickFocusReloaded(pick.tab, create);
        }, function() { return create('reload-failed'); });
    }, function(e) {
        if (e && e.reopenTimeout) c.queryHungAt = Date.now();
        return create('query-failed');
    }).catch(function(e) {
        if (created) throw e; // this click's create failed / timed out: never a second one
        _reopenLog('click-reuse-failed', { error: _reopenErr(e) });
        return create('reuse-failed');
    });
}

// The tab a click just reloaded is focused; a failed focus is retried once, at
// once (both bounded). The reload answered, so the tab is there: only a
// bounded tabs.get saying it is gone makes the click create (never a second
// app instance beside it). Still there: the click shows nothing (null, so it
// is not debounced) and the next click focuses it (its boot grace).
function _clickFocusReloaded(tab, create) {
    var id = tab.id;
    return _focusAppTab(tab).catch(function() { return _focusAppTab(tab); }).then(function(t) {
        _reopenLog('click-reloaded', { tabId: id });
        return t;
    }, function(e) {
        return _reopenGetTab(id).then(function(live) {
            if (!live) return create('reload-gone');
            _reopenLog('click-focus-failed', { tabId: id, error: _reopenErr(e) });
            return null;
        });
    });
}

// {tab, why} of the tab a click shows (why = its liveness proof, null = reload
// it), live tabs first; null when there is no plain app tab to reuse.
function _clickPickAppTab(tabs) {
    var now = Date.now(), suspects = _appTabReopenState.suspectIds || [], dead = null;
    for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i], u = t && t.id != null ? String(t.url || t.pendingUrl || '') : '';
        if (u.indexOf(APP_TAB_PATH) < 0 || /[?&](widget|doc|standalone)=|print/i.test(u)) continue;
        if (suspects.indexOf(t.id) >= 0) continue; // the old instance's tab: Chrome is closing it
        var why = _clickTabLive(t, now);
        if (why) return { tab: t, why: why };
        if (!dead) dead = { tab: t, why: null };
    }
    return dead;
}

// Why tab t is known alive (a port of the SW bundle, a fresh app-tab-ready, a
// click's own create / reload still booting, loading, or an SW too young for
// the page to have reconnected), else null.
function _clickTabLive(t, now) {
    var c = _appTabClick, r = _appTabReopenState.readyTabs[t.id], port = false;
    try {
        if (typeof _swPanelPorts !== 'undefined' && _swPanelPorts && _swPanelPorts.forEach) {
            _swPanelPorts.forEach(function(p) { if (p && p.sender && p.sender.tab && p.sender.tab.id === t.id) port = true; });
        }
    } catch (e) {}
    if (port) return 'port';
    if (r && now - r.t <= REOPEN_APP_TAB_READY_TTL_MS) return 'ready';
    if (typeof c.touched[t.id] === 'number' && now - c.touched[t.id] <= REOPEN_APP_TAB_READY_MS) return 'recent';
    if (t.status === 'loading') return 'loading';
    if (now - c.swStartAt < APP_TAB_CLICK_SW_GRACE_MS) return 'sw-young';
    return null;
}

// Records a click's create / reload (pruned by rebuilding the map).
function _clickTouch(id) {
    var c = _appTabClick, now = Date.now(), keep = {};
    Object.keys(c.touched).forEach(function(k) { if (now - c.touched[k] <= REOPEN_APP_TAB_READY_MS) keep[k] = c.touched[k]; });
    keep[id] = now;
    c.touched = keep;
}

// The click's own tab (a late reopen tab is closed from now on). A failed create
// (e.g. "Tabs cannot be edited right now") is retried once; one that did not
// answer in time is not (it may still land).
function _clickCreateAppTab(why) {
    _appTabReopenState.clickOpened = true;
    return _createAppTab().catch(function(e) {
        if (e && e.reopenTimeout) throw e;
        return _reopenDelay(300).then(_createAppTab);
    }).then(function(tab) {
        if (tab && tab.id != null) _clickTouch(tab.id);
        _reopenLog('click-created', { tabId: tab && tab.id != null ? tab.id : null, why: why || 'create' });
        return tab;
    });
}

// Open AppAgent in a full page tab when the toolbar icon is clicked.
// (openPanelOnActionClick must be false so the action.onClicked event fires.)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
chrome.action.onClicked.addListener(_onActionClicked);

// Re-open app as a full tab after chrome.runtime.reload(): check on every SW
// start, again on onInstalled (fires after a reload of the unpacked build),
// and once more shortly after startup to catch a marker that landed late.
_consumeReopenAppTab();
chrome.runtime.onInstalled.addListener(function() { _consumeReopenAppTab(); });
setTimeout(function() { _consumeReopenAppTab(); }, 1500);
// Last retry for a failed attempt (marker kept when a create failed with no tab).
setTimeout(function() { _consumeReopenAppTab(); }, 5000);
// WAKE-AFTER-RELOAD: registered synchronously at top level so the persisted
// wake alarm armed before reload() is delivered to the new SW.
if (chrome.alarms && chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener) {
    chrome.alarms.onAlarm.addListener(_reopenOnWakeAlarm);
}
// APP-TAB-REOPEN end

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
                // + MAIN-world console/network interceptors (non-fatal)
                try { await injectInterceptors(tabs[i].id); } catch (e2) { console.warn('[SW] injectInterceptors failed', e2); }
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
        var rolesRes = await fetch(instanceUrl + '/api/now/table/sys_user_has_role?sysparm_query=user=javascript:gs.getUserID()^inherited=false&sysparm_fields=role.name&sysparm_limit=500', {
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

// Collect the DISTINCT non-empty g_ck tokens exposed by ALL open tabs of one
// instance, in tab order, skipping excludeToken (a token the caller just saw
// rejected with 401). Several tabs of the same host can disagree: a tab left
// session-timed-out keeps its old (now dead) g_ck in memory while a newer tab
// the user signed in with holds the live one — so never stop at the first tab.
// Returns { candidates: [{ token, userName, tabId }], sawOpenTab } where
// sawOpenTab is true when at least one tab's MAIN world could be read.
async function snCollectTabTokens(matchTabs, excludeToken) {
    var candidates = [];
    var sawOpenTab = false;
    for (var i = 0; i < matchTabs.length; i++) {
        var data = await snProbeTabTokenUser(matchTabs[i].id);
        if (data) sawOpenTab = true;   // page responded (even if g_ck was empty = logged out)
        if (!data || !data.token || data.token === excludeToken) continue;
        var dup = false;
        for (var d = 0; d < candidates.length; d++) { if (candidates[d].token === data.token) dup = true; }
        if (dup) continue;
        candidates.push({ token: data.token, userName: data.userName || '', tabId: matchTabs[i].id });
    }
    return { candidates: candidates, sawOpenTab: sawOpenTab };
}

// Pick the HEALTHY token among an instance's open tabs. With a single candidate
// (the normal one-tab case) it is returned as-is unless opts.validate is set —
// no extra request. With several distinct candidates (e.g. a timed-out tab + a
// freshly signed-in one), each is checked against the instance and the first
// one NOT explicitly rejected (HTTP 401) wins; 403 / network errors are
// indeterminate and accepted, matching snGetInstancesDetailed.
// Returns { pick: { token, userName, tabId } | null, sawOpenTab, rejected: [tokens] }.
async function snPickTabToken(matchTabs, instanceUrl, opts) {
    opts = opts || {};
    var col = await snCollectTabTokens(matchTabs, opts.excludeToken);
    var cands = col.candidates;
    if (cands.length === 0) return { pick: null, sawOpenTab: col.sawOpenTab, rejected: [] };
    if (cands.length === 1 && !opts.validate) return { pick: cands[0], sawOpenTab: col.sawOpenTab, rejected: [] };
    var rejected = [];
    for (var c = 0; c < cands.length; c++) {
        var chk = await snFetchUserName(instanceUrl, cands[c].token);
        if (chk.status === 401) { rejected.push(cands[c].token); continue; }
        if (!cands[c].userName && chk.name) cands[c].userName = chk.name;
        return { pick: cands[c], sawOpenTab: col.sawOpenTab, rejected: rejected };
    }
    return { pick: null, sawOpenTab: col.sawOpenTab, rejected: rejected };
}

// Resolve identity + roles (+ maint) for ONE candidate token of an instance.
// Returns { token, userName, roles, isMaint, authRejected } — token is '' when
// the instance explicitly rejected it (see the rule below).
async function snResolveInstanceSession(instanceUrl, token, userName) {
    // Track whether the instance EXPLICITLY rejected the
    // session (HTTP 401) — that is the only response that proves the token is dead.
    var authRejected = false;
    var _nameOk = false;   // identity probe answered 2xx
    if (token && !userName) {
        var _nm = await snFetchUserName(instanceUrl, token);
        userName = _nm.name;
        if (_nm.status === 401) authRejected = true;
        if (_nm.status >= 200 && _nm.status < 300) _nameOk = true;
    }
    var roles = [];
    var _rr = null;
    if (token) {
        _rr = await snFetchUserRoles(instanceUrl, token);
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
    // The rule applies whether or not a user name is known: a session-timed-out tab
    // still exposes NOW.user_name next to its dead g_ck (so the name probe is
    // skipped), and only the roles probe's 401 reveals it. maint is unaffected —
    // it is only detected on a NON-rejected token (see below).
    if (token && roles.length === 0 && authRejected) {
        token = '';
    }
    // maint: no roles + no user name (maint is not a sys_user) + admin-level read
    // of the roles table. Synthetic roles ['maint','admin'] so the badge, the
    // list_instances admin check and the servicenow_run_script gate treat it as admin.
    // maint: probe ONLY when the roles probe SUCCEEDED (2xx) with 0 roles and no
    // user name (maint is not a sys_user) — shared snDetectMaint/snMaintEligible in
    // core/150-record-helpers.js (via sw-bundle), one request, cached per URL+token.
    var isMaint = false;
    var _rolesOk = !!(_rr && _rr.responded && _rr.status >= 200 && _rr.status < 300);
    if (token && !authRejected && typeof snMaintEligible === 'function' && snMaintEligible(roles, _rolesOk, userName)) {
        isMaint = await snDetectMaint(instanceUrl, token);
        if (isMaint) { roles = ['maint', 'admin']; if (!userName) userName = 'maint'; }
    }
    // sessionOk: the instance ACCEPTED this token — it was NOT rejected with 401 and
    // a 2xx or 403 roles read, or a 2xx identity (name) read, proves the session
    // (in ServiceNow a 403 ACL refusal comes after authentication). A 429, a 5xx or
    // a network error proves nothing: a proxy or rate limiter can answer first.
    // Those cases reach adoption only through the stub fallback, when the held
    // worker token was 401'd in this probe (js/worker/010-platform-stub.js ~L163).
    var _rolesAnswered = !!(_rr && _rr.responded && (_rolesOk || _rr.status === 403));
    var sessionOk = !!(token && !authRejected && (_rolesAnswered || _nameOk));
    return { token: token, userName: userName || '', roles: roles, isMaint: isMaint, authRejected: authRejected, sessionOk: sessionOk };
}

// Remember a token proven usable for an origin in the per-origin heartbeat cache,
// replacing a stale one (e.g. cached from a tab that later timed out).
function snRememberInstanceToken(origin, token, userName) {
    if (!origin || !token) return Promise.resolve();
    return snUpdateInstanceTokens(function(map) {
        if (map[origin] && map[origin].token === token) return false;
        map[origin] = { token: token, userName: userName || (map[origin] && map[origin].userName) || '', updated: Date.now() };
    });
}

// Single serialized read-modify-write of the per-origin instanceTokens map.
// Every writer (tab-ready, snRememberInstanceToken, the heartbeat) goes through
// this queue, so a writer never saves a map snapshot that predates another
// writer's update (lost update). mutate(map) edits in place; returning false
// means "unchanged" and skips the write. chrome.storage.local processes calls in
// issue order, so the next queued get() observes this set().
var _snInstanceTokensQueue = Promise.resolve();
function snUpdateInstanceTokens(mutate) {
    var run = _snInstanceTokensQueue.then(function() {
        return new Promise(function(resolve) {
            chrome.storage.local.get('instanceTokens', function(d) {
                var map = (d && d.instanceTokens) || {};
                var changed = true;
                try { changed = mutate(map) !== false; } catch (e) { changed = false; }
                if (changed) chrome.storage.local.set({ instanceTokens: map });
                resolve(map);
            });
        });
    });
    _snInstanceTokensQueue = run.catch(function() {});
    return run;
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
        // Probe EVERY tab of this origin, not just the first one with a g_ck: a
        // session-timed-out tab still exposes its dead token and used to win just by
        // being first in snTabs, flipping the whole instance to signed-out even though
        // another tab is logged in.
        var col = await snCollectTabTokens(inst.tabs);
        var candidates = col.candidates;
        // Fall back to the cached heartbeat token ONLY when there is no live tab we could
        // read (all tabs closed, or discarded by Chrome Memory Saver — no JS context), so a
        // tab-less instance still resolves as connected (tabCount:0) for list_instances.
        // If an open tab DID respond with an empty g_ck the user is LOGGED OUT — never
        // resurrect a stale token, or the selector would wrongly show it connected.
        var fromCache = false;
        if (!candidates.length && !col.sawOpenTab && instanceTokenCache[inst.url] && instanceTokenCache[inst.url].token) {
            candidates.push({ token: instanceTokenCache[inst.url].token, userName: instanceTokenCache[inst.url].userName || '' });
            fromCache = true;
        }
        // Connected if ANY candidate yields a session the instance does not reject:
        // take the first non-401 one; when every candidate is rejected keep the first
        // one's result (its token is cleared by snResolveInstanceSession's 401 rule).
        var session = null;
        var rejectedTokens = [];   // candidates the instance rejected with 401 (never adoptable)
        for (var c = 0; c < candidates.length; c++) {
            var s = await snResolveInstanceSession(inst.url, candidates[c].token, candidates[c].userName);
            if (!session) session = s;
            if (s.authRejected) { rejectedTokens.push(candidates[c].token); continue; }
            session = s; break;
        }
        if (!session) session = { token: '', userName: '', roles: [], isMaint: false, authRejected: false };
        // A live tab's token that just proved usable while a sibling tab's was rejected:
        // refresh the per-origin cache so the heartbeat stops pinging the dead one.
        if (session.token && !session.authRejected && !fromCache && candidates.length > 1) {
            snRememberInstanceToken(inst.url, session.token, session.userName);
        }
        result.push({ url: inst.url, tabs: inst.tabs, token: session.token, userName: session.userName, roles: session.roles, isMaint: session.isMaint, sessionOk: !!session.sessionOk, rejectedTokens: rejectedTokens });
    }
    return result;
}

// Probe a fresh g_ck for a specific instance URL by scanning ALL its open tabs.
// opts (optional): { excludeToken, validate } — excludeToken skips a token the
// caller just saw rejected (401), so a stale sibling tab can never hand it back;
// validate checks even a single candidate (and the cached fallback) against the
// instance. Several distinct tab tokens are always checked (snPickTabToken).
// Returns { token, userName, tabId } or { token: '', error } if nothing available.
async function snGetTokenForInstance(instanceUrl, opts) {
    opts = opts || {};
    var tabs = await getSnTabList();
    var matchTabs = tabs.filter(function(t) { return t.origin === instanceUrl; });
    var picked = await snPickTabToken(matchTabs, instanceUrl, opts);
    if (picked.pick) {
        if (picked.rejected.length) snRememberInstanceToken(instanceUrl, picked.pick.token, picked.pick.userName);
        return { token: picked.pick.token, userName: picked.pick.userName, tabId: picked.pick.tabId };
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
    if (cached && cached.token && cached.token !== opts.excludeToken && picked.rejected.indexOf(cached.token) === -1) {
        if (!opts.validate || (await snFetchUserName(instanceUrl, cached.token)).status !== 401) {
            return { token: cached.token, userName: cached.userName || '' };
        }
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
        // Only the trusted offscreen host can relay an invocation. Every frame,
        // including unrestricted js_eval, is registered by callOffscreenHelper.
        // A worker restart loses registrations and therefore FAILS CLOSED.
        if (!sender || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('offscreen.html')) {
            sendResponse({ ok: false, error: 'Untrusted sandbox relay sender' });
            return false;
        }
        var policyError = swTestPolicyStartupError();
        if (policyError) {
            sendResponse({ ok: false, error: policyError.message });
            return false;
        }
        var decision = TestRunPolicy.registry.relay(p.sandboxRequestId, p.name, p.args);
        if (!decision.ok) {
            sendResponse({ ok: false, error: decision.reason });
            return false;
        }
        p.args = decision.args;
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
        handleRefreshToken(sendResponse, message.excludeToken);
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
        snGetTokenForInstance(message.instanceUrl, { excludeToken: message.excludeToken, validate: !!message.validate }).then(sendResponse);
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
                // + MAIN-world console/network interceptors; non-fatal, never
                // changes the { ok: true } response of a successful inject.
                try { await injectInterceptors(message.tabId); } catch (e2) { console.warn('[SW] injectInterceptors failed', e2); }
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
            var token = await snGetTokenForInstance(instanceUrl, { excludeToken: oldToken });
            if (token && token.token && token.token !== oldToken) {
                return token.token;
            }
        } catch (e) {}
    }
    return null;
};

async function handleRefreshToken(sendResponse, excludeToken) {
    try {
        var storage = await chrome.storage.local.get('instanceUrl');
        var tabs = await getSnTabList();
        if (tabs.length === 0) {
            sendResponse({ error: 'No ServiceNow tab open. Open a ServiceNow page to authenticate.' });
            return;
        }

        // Active instance with open tabs: pick the healthy token across ALL of them
        // (skipping the one the caller just saw 401), not the first matching tab —
        // which may be a session-timed-out tab holding a dead g_ck.
        var matchTabs = storage.instanceUrl ? tabs.filter(function(t) { return t.origin === storage.instanceUrl; }) : [];
        if (matchTabs.length) {
            var picked = await snPickTabToken(matchTabs, storage.instanceUrl, { excludeToken: excludeToken });
            if (picked.pick) {
                chrome.storage.local.set({ sessionToken: picked.pick.token });
                sendResponse({ token: picked.pick.token });
            } else {
                sendResponse({ error: 'Could not extract token. The ServiceNow page may need to be refreshed.' });
            }
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

// Turn a chatgpt.com/backend-api/codex 429 body into a human-readable,
// actionable headline. The raw body looks like
//   {"type":"usage_limit_reached","message":"The usage limit has been reached",
//    "plan_type":"plus","resets_at":1788470346,"eligible_promo":null,
//    "resets_in_seconds":2319}
// and conciseApiErrorBody() would reduce it to just "The usage limit has been
// reached" — dropping the plan, the reset countdown and the wall-clock reset
// time, which are exactly what the user needs to decide whether to wait or
// switch provider. Returns { headline, plan, resetsAt, resetsIn, raw } or
// null when the body is not a recognizable usage-limit payload.
function describeChatGPTUsageLimit(bodyText) {
    var raw = String(bodyText == null ? '' : bodyText).trim();
    if (!raw || raw.charAt(0) !== '{') return null;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    // Some responses nest under .error (OpenAI style) — accept both shapes.
    var o = (obj.error && typeof obj.error === 'object') ? obj.error : obj;
    var type = String(o.type || o.code || '');
    var msg = typeof o.message === 'string' ? o.message : '';
    if (!/usage_limit|usage limit|quota|plan_limit|insufficient/i.test(type + ' ' + msg)) return null;
    var now = Date.now();
    var resetsAt = null;
    if (typeof o.resets_at === 'number' && o.resets_at > 0) {
        resetsAt = o.resets_at > 9999999999 ? Math.floor(o.resets_at / 1000) : Math.floor(o.resets_at);
    } else if (typeof o.resets_at === 'string' && o.resets_at) {
        var parsed = Date.parse(o.resets_at);
        if (!isNaN(parsed)) resetsAt = Math.floor(parsed / 1000);
    }
    if (resetsAt == null && typeof o.resets_in_seconds === 'number' && o.resets_in_seconds > 0) {
        resetsAt = Math.floor(now / 1000) + Math.round(o.resets_in_seconds);
    }
    var plan = o.plan_type ? String(o.plan_type) : '';
    var planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase() + ' plan' : '';
    var resetIn = formatResetDelta(resetsAt);
    var resetClock = '';
    if (resetsAt) {
        try {
            var d = new Date(resetsAt * 1000);
            var sameDay = d.toDateString() === new Date(now).toDateString();
            resetClock = sameDay
                ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        } catch (e) { resetClock = ''; }
    }
    var headline = 'ChatGPT usage limit reached' + (planLabel ? ' (' + planLabel + ')' : '');
    if (resetIn) {
        headline += ' \u2014 resets in ' + resetIn + (resetClock ? ' (at ' + resetClock + ')' : '');
    } else if (resetsAt) {
        headline += ' \u2014 limit should have reset' + (resetClock ? ' at ' + resetClock : '') + '; try again';
    } else {
        headline += ' \u2014 no reset time reported';
    }
    headline += '.';
    if (o.eligible_promo) headline += ' A promo is available on your account: ' + String(o.eligible_promo) + '.';
    headline += ' Retrying won\'t help until the limit resets \u2014 wait, or switch to another provider/model in Settings.';
    return { headline: headline, plan: plan, resetsAt: resetsAt, resetsIn: resetIn, message: msg, raw: raw };
}

// TA4-3: logout epoch. 'claude-oauth-logout' bumps it FIRST; every login/renew
// carries the epoch it started under, and saveOAuthCreds drops (throws) a write
// from an older epoch, so a token exchange that resolves after the logout can't
// silently re-write claudeOAuth (logging the user back in).
var claudeOAuthEpoch = 0;

async function startClaudeOAuth(epoch) {
    if (typeof epoch !== 'number') epoch = claudeOAuthEpoch;
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
    return saveOAuthCreds(await tokRes.json(), undefined, epoch);
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
async function renewClaudeToken(oauth, epoch) {
    if (typeof epoch !== 'number') epoch = claudeOAuthEpoch;
    if (oauth && oauth.refreshToken) {
        try {
            var tokenData = await refreshClaudeToken(oauth.refreshToken);
            return saveOAuthCreds(tokenData, oauth.refreshToken, epoch);
        } catch (e) {
            // TA4-3: fenced by a logout - a cookie re-auth would be dropped too.
            if (e && e.claudeOAuthStale) throw e;
            // fall through to silent re-auth
            console.warn('[Claude OAuth] refresh failed, falling back to silent re-auth:', e && e.message);
        }
    }
    // Silent re-auth via the claude.ai session cookie.
    return await startClaudeOAuth(epoch);
}

function saveOAuthCreds(tokenData, existingRefresh, epoch) {
    if (typeof epoch === 'number' && epoch !== claudeOAuthEpoch) {
        // TA4-3: the user logged out after this login/renew started - drop it
        // (no storage write, no broadcast).
        var stale = new Error('Claude sign-in was cancelled by a logout; the new token was discarded.');
        stale.claudeOAuthStale = true;
        throw stale;
    }
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
        // TA4-3: capture the epoch on arrival, so a logout during the get/renew fences it.
        var refreshEpoch = claudeOAuthEpoch;
        chrome.storage.local.get('claudeOAuth', function(data) {
            renewClaudeToken(data.claudeOAuth, refreshEpoch).then(function(creds) {
                sendResponse({ success: true, claudeOAuth: creds });
            }).catch(function(err) { sendResponse({ error: err.message }); });
        });
        return true;
    }
    if (message.type === 'claude-oauth-status') {
        // TA4-3: captured on arrival; a logout mid-poll fences its auto-login/renew writes.
        var statusEpoch = claudeOAuthEpoch;
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
                            var creds = await startClaudeOAuth(statusEpoch);
                            chrome.storage.local.remove('claudeAutoLoginFailedFor');
                            sendResponse({ loggedIn: true, expired: false, expiresAt: creds.expiresAt });
                            return;
                        }
                    } catch (e) {
                        // Remember this cookie failed so we don't retry it every poll
                        // (not when a logout fenced the attempt: the cookie itself is fine).
                        if (sk && !(e && e.claudeOAuthStale)) chrome.storage.local.set({ claudeAutoLoginFailedFor: sk });
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
                    oauth = await renewClaudeToken(oauth, statusEpoch);
                } catch(e) {
                    // TA4-3: a logout fenced the renew - report logged out, not expired.
                    if (e && e.claudeOAuthStale) { sendResponse({ loggedIn: false }); return; }
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
        // TA4-3: bump the epoch FIRST so an in-flight login/renew can't re-write the token.
        claudeOAuthEpoch++;
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
        var triedCliVersionBump = false;
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
                    // Same shape as the version-gate retry below: the re-auth
                    // retry is budgeted by triedReauth (once), so it must not
                    // burn a timed-backoff attempt, and the 401 body is never
                    // read here — clear any stale 429 body so a later failure
                    // re-reads its OWN body in the !res.ok handler.
                    attempt--;
                    errBodyText = null;
                    continue;
                } catch (e) {
                    sink({ type: 'error', error: 'Session expired and silent re-auth failed: ' + e.message + '. Open https://claude.ai, sign in, then retry.' });
                    sink({ type: 'done' });
                    return;
                }
            }

            // Claude Code version gate: a 400 whose body says "version A.B.C or
            // newer is required" (error_code claude_code_version_too_old) means
            // the spoofed claude-cli User-Agent is below the per-model minimum
            // (see CLAUDE_CLI_VERSION). Raise the DNR rule to the demanded
            // version, persist it, and retry the SAME request ONCE. The body is
            // consumed here (single-use), so on any non-recoverable 400 it is
            // handed to the !res.ok handler via errBodyText and the surfaced
            // error stays exactly what it was without this block.
            if (res.status === 400 && !triedCliVersionBump) {
                triedCliVersionBump = true;
                var body400 = '';
                try { body400 = await res.text(); } catch (e) { body400 = ''; }
                var requiredCliVersion = parseRequiredClaudeCliVersion(body400);
                if (requiredCliVersion) {
                    var bumped = false;
                    try { bumped = await bumpClaudeCliVersion(requiredCliVersion); }
                    catch (e) { console.warn('[AppAgent] claude-cli version bump to ' + requiredCliVersion + ' failed:', e && e.message); }
                    if (bumped) {
                        console.warn('[AppAgent] API requires Claude Code ' + requiredCliVersion + ' — claude-cli User-Agent raised, retrying once');
                        sink({ type: 'status', status: 'retrying', reason: 'claude_code_version_too_old', message: 'Model requires Claude Code ' + requiredCliVersion + ' — updating and retrying…' });
                        // The bump retry is budgeted by triedCliVersionBump
                        // (once): compensate the for-loop increment so it never
                        // eats the last attempt (which used to exit the loop
                        // with THIS consumed 400 as res → the !res.ok handler
                        // re-read a used body or surfaced a stale 429 body).
                        // body400 is consumed and belongs to this attempt only,
                        // so clear errBodyText for the retried response.
                        attempt--;
                        errBodyText = null;
                        continue;
                    }
                }
                errBodyText = body400;
                break;
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
                    }
                    // Block-order marker (Fable 5.1+ / Opus 5.5 thinking binding):
                    // the OpenAI-chunk translation below flattens the turn into
                    // content / tool_calls / reasoning_details, losing the order
                    // of the content blocks. Replaying a turn reordered (e.g.
                    // [thinking,text,thinking,tool_use] → [thinking,thinking,text,
                    // tool_use]) changes the prefix bound to the later thinking
                    // blocks, which the API then silently drops. The page side
                    // (010-llm-streaming.js) records these markers into
                    // assistantMsg.block_order; transformMessageToAnthropic
                    // replays in that order when it still validates.
                    sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                        id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                        choices: [{ index: 0, delta: { anthropic_block: {
                            index: typeof eventData.index === 'number' ? eventData.index : null,
                            type: block.type || '',
                            tool_index: block.type === 'tool_use' ? toolIdx : null,
                            id: block.type === 'tool_use' ? currentToolId : null
                        } }, finish_reason: null }]
                    }) + '\n\n' });
                    if (block.type === 'tool_use') {
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, id: currentToolId, type: 'function', function: { name: block.name || '', arguments: '' } }] }, finish_reason: null }]
                        }) + '\n\n' });
                    }
                    else if (block.type === 'thinking') {
                        var blockIdx = eventData.index || 0;
                        sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                            id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                            choices: [{ index: 0, delta: { reasoning_details: [{ index: blockIdx, thinking: typeof block.thinking === 'string' ? block.thinking : '' }] }, finish_reason: null }]
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
                            // Synthetic text — give it its own block-order entry so it
                            // never merges into (or breaks the tiling of) the model's
                            // own text blocks on replay.
                            sink({ type: 'sse', data: 'data: ' + JSON.stringify({
                                id: 'chatcmpl-' + msgId, object: 'chat.completion.chunk', created: ts, model: model,
                                choices: [{ index: 0, delta: { anthropic_block: { index: null, type: 'text', tool_index: null, id: null } }, finish_reason: null }]
                            }) + '\n\n' });
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
    browserRedirectUri: 'http://localhost:1455/auth/callback',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
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
// always a guess with a shelf life — these are the GPT-6 slugs Codex lists
// for ChatGPT accounts (codex-rs model-selection popup snapshot, 2026-09-22:
// GPT-6-Astra / GPT-6-Sol / GPT-6-Luna). GPT-5.6 Terra was dropped (no GPT-6
// Terra); Codex migrates gpt-5.6-terra/-sol → gpt-6-sol, gpt-5.6-luna → gpt-6-luna.
// 2026-09-30: GPT-6.1-Sol is Codex's new default; GPT-6-Sol stays listed as
// "previous generation" (codex-rs model_selection_popup snapshot).
var OPENAI_FALLBACK_MODELS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'];
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
    // Both commit and rollback stay in the storage lane. No newer login/refresh
    // or logout can write between the snapshot and rollback of this attempt.
    function writeCreds(value) {
        if (value === undefined) return chrome.storage.local.remove('openaiOAuth');
        return chrome.storage.local.set({ openaiOAuth: value });
    }
    await _openaiQueueOAuthStorage(async function() {
        _openaiAssertGeneration(generation, signal);
        var before = (await chrome.storage.local.get('openaiOAuth')).openaiOAuth;
        _openaiAssertGeneration(generation, signal);
        await writeCreds(creds);
        try { _openaiAssertGeneration(generation, signal); }
        catch (e) {
            // Chrome cannot abort a storage write already issued. Undo only this
            // lane-owned commit before allowing cancellation/newer writers in.
            await writeCreds(before);
            throw e;
        }
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
        finally { if (openaiStartLoginInFlight === loginPromise) openaiStartLoginInFlight = null; }
    })();
    var loginPromise = openaiStartLoginInFlight;
    return loginPromise;
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

// Browser PKCE uses the Codex client's registered loopback redirect. Chrome may
// not report a failed localhost navigation: manual LOCAL paste and device code
// remain explicit alternatives. No redirect injection or new permissions.
var openaiBrowserStartInFlight = null;
var openaiBrowserExchange = null;
var OPENAI_BROWSER_PENDING_KEY = 'openaiPendingBrowserAuth';

function _openaiTrustedAuthSender(sender) {
    return !!(sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.indexOf(chrome.runtime.getURL('')) === 0);
}

async function _openaiCancelPendingLogin() {
    // Invalidate synchronously before any await: late network/storage completions
    // cannot publish credentials for an abandoned method or cancelled dialog.
    openaiAuthGeneration++;
    openaiActiveDeviceAuthId = null;
    openaiDeviceLoginInFlight = false;
    openaiStartLoginInFlight = null;
    openaiBrowserStartInFlight = null;
    if (openaiDeviceAbortController) openaiDeviceAbortController.abort();
    if (openaiStartAbortController) openaiStartAbortController.abort();
    var exchange = openaiBrowserExchange;
    if (exchange) exchange.controller.abort();
    openaiBrowserExchange = null;
    await _openaiQueueOAuthStorage(async function() {
        var stored = await chrome.storage.session.get(OPENAI_BROWSER_PENDING_KEY);
        var pending = stored[OPENAI_BROWSER_PENDING_KEY];
        await chrome.storage.session.remove(OPENAI_BROWSER_PENDING_KEY);
        await chrome.storage.local.remove('openaiPendingDeviceAuth');
        var tabId = pending ? pending.tabId : exchange && exchange.tabId;
        if (Number.isInteger(tabId)) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
    });
}

function _openaiBrowserPublic(pending) {
    return { pending: true, method: 'browser', expiresAt: pending.expiresAt };
}

async function _openaiStartBrowserLogin() {
    var generation = openaiAuthGeneration;
    var tab = null;
    try {
        var pkce = await makePkce();
        _openaiAssertGeneration(generation);
        // Persist the owned tab BEFORE navigating to authorize; a fast consent
        // redirect must not race the pending record. session is trusted-only by
        // Chrome's default access level and does not survive browser shutdown.
        tab = await chrome.tabs.create({ url: 'about:blank', active: true });
        _openaiAssertGeneration(generation);
        if (!tab || !Number.isInteger(tab.id)) throw new Error('tab unavailable');
        var pending = { state: pkce.state, verifier: pkce.verifier, tabId: tab.id, expiresAt: Date.now() + OPENAI_DEVICE_AUTH_TTL_MS };
        await _openaiQueueOAuthStorage(async function() {
            _openaiAssertGeneration(generation);
            await chrome.storage.session.set({ openaiPendingBrowserAuth: pending });
            _openaiAssertGeneration(generation);
        });
        var url = new URL(OPENAI_OAUTH.authorizeUrl);
        url.search = new URLSearchParams({ response_type: 'code', client_id: OPENAI_OAUTH.clientId, redirect_uri: OPENAI_OAUTH.browserRedirectUri, scope: OPENAI_OAUTH.scopes, code_challenge: pkce.challenge, code_challenge_method: 'S256', state: pkce.state, id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: OPENAI_OAUTH.originator }).toString();
        _openaiAssertGeneration(generation);
        await chrome.tabs.update(tab.id, { url: url.href });
        _openaiAssertGeneration(generation);
        return _openaiBrowserPublic(pending);
    } catch (e) {
        // Never reflect authorize/callback URLs, authorization codes or token
        // endpoint bodies into errors, console logs, or conversation history.
        if (generation === openaiAuthGeneration) await _openaiCancelPendingLogin();
        else if (tab && Number.isInteger(tab.id)) { try { await chrome.tabs.remove(tab.id); } catch (ignored) {} }
        throw new Error('Browser sign-in could not start. Choose device-code login to try another method.');
    }
}

function _openaiBrowserCallback(url, pending, tabId) {
    if (!pending || pending.tabId !== tabId || pending.expiresAt <= Date.now()) return null;
    var parsed;
    try { parsed = new URL(url); } catch (e) { return null; }
    if (parsed.origin !== 'http://localhost:1455' || parsed.pathname !== '/auth/callback' || parsed.username || parsed.password || parsed.hash) return null;
    var params = parsed.searchParams;
    if (params.getAll('state').length !== 1 || params.get('state') !== pending.state) return null;
    if (params.has('error')) return { denied: true };
    if (params.getAll('code').length !== 1 || !params.get('code')) return null;
    return { code: params.get('code') };
}

async function _openaiHandleBrowserCallback(tabId, url) {
    var generation = openaiAuthGeneration;
    // Claim/remove one-time state in the SAME lane as cancellation and logout.
    // If the worker dies after consumption, require a fresh login, never replay.
    var claimedTab = false;
    var exchange;
    var claim;
    try { claim = await _openaiQueueOAuthStorage(async function() {
        _openaiAssertGeneration(generation);
        var stored = await chrome.storage.session.get(OPENAI_BROWSER_PENDING_KEY);
        var pending = stored[OPENAI_BROWSER_PENDING_KEY];
        var callback = _openaiBrowserCallback(url, pending, tabId);
        if (!callback) return null;
        claimedTab = true;
        // Own the exchange BEFORE removing pending state: a method switch or tab
        // close must still find/abort us during the awaited one-time consumption.
        exchange = { tabId: tabId, controller: new AbortController() };
        openaiBrowserExchange = exchange;
        await chrome.storage.session.remove(OPENAI_BROWSER_PENDING_KEY);
        _openaiAssertGeneration(generation, exchange.controller.signal);
        return { pending: pending, callback: callback, exchange: exchange };
    }); } catch (e) {
        // Cancellation during the awaited one-time removal has already erased
        // the record, so its cleanup cannot discover this tab. We still own it.
        if (openaiBrowserExchange === exchange) openaiBrowserExchange = null;
        if (claimedTab) { try { await chrome.tabs.remove(tabId); } catch (ignored) {} }
        throw e;
    }
    if (!claim) return false;
    var signal = claim.exchange.controller.signal;
    try {
        if (claim.callback.denied) throw new Error('denied');
        // USA-1: a tab closed during the storage claim no longer fails the
        // exchange — the callback was already validated against the owned
        // tab id (_openaiBrowserCallback); user cancel / method switch still
        // abort via generation + signal.
        _openaiAssertGeneration(generation, signal);
        var response = await fetch(OPENAI_OAUTH.tokenUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code: claim.callback.code, client_id: OPENAI_OAUTH.clientId, redirect_uri: OPENAI_OAUTH.browserRedirectUri, code_verifier: claim.pending.verifier }).toString(), signal: signal
        });
        if (!response.ok) throw new Error('exchange failed');
        var token = await response.json();
        if (!token || !token.access_token) throw new Error('missing token');
        _openaiAssertGeneration(generation, signal);
        await saveChatGPTOAuthCreds(token, null, generation, signal);
        return true;
    } catch (e) {
        if (generation === openaiAuthGeneration && !signal.aborted) {
            chrome.runtime.sendMessage({ type: 'openai-oauth-updated', error: claim.callback.denied ? 'Browser sign-in was declined. Choose a login method to try again.' : 'Browser token exchange failed. Start a new login or choose device code.' }).catch(function() {});
        }
        return false;
    } finally {
        if (openaiBrowserExchange === claim.exchange) openaiBrowserExchange = null;
        // Only the owned auth tab is closed, never a pasted URL's source tab.
        try { await chrome.tabs.remove(tabId); } catch (e) {}
    }
}

async function _openaiBrowserStatus() {
    var stored = await chrome.storage.session.get(OPENAI_BROWSER_PENDING_KEY);
    var pending = stored[OPENAI_BROWSER_PENDING_KEY];
    if (!pending) return null;
    if (pending.expiresAt <= Date.now()) {
        await _openaiQueueOAuthStorage(async function() {
            var current = (await chrome.storage.session.get(OPENAI_BROWSER_PENDING_KEY))[OPENAI_BROWSER_PENDING_KEY];
            if (current && current.state === pending.state) {
                await chrome.storage.session.remove(OPENAI_BROWSER_PENDING_KEY);
                try { await chrome.tabs.remove(current.tabId); } catch (e) {}
            }
        });
        return null;
    }
    return _openaiBrowserPublic(pending);
}

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo) {
    if (changeInfo.url && changeInfo.url.indexOf(OPENAI_OAUTH.browserRedirectUri) === 0) _openaiHandleBrowserCallback(tabId, changeInfo.url).catch(function() {});
});
chrome.tabs.onRemoved.addListener(function(tabId) {
    // Read + ownership check in the serialized lane; a stale close event must
    // never cancel a newer tab's login. Exchange cancellation is synchronous.
    // USA-1 (#895): once the callback URL has been CAPTURED (an exchange owns
    // this tab — the user already approved on auth.openai.com and the ~1s
    // token exchange is in flight) closing the auth tab is NOT a cancel: users
    // routinely close the localhost redirect page themselves and the exchange
    // closes it in its finally anyway. Let the exchange finish. Only a close
    // BEFORE the callback is captured (pending record still owns the tab)
    // cancels below. Explicit cancel / logout / method switch still abort the
    // exchange through _openaiCancelPendingLogin (generation + controller).
    _openaiQueueOAuthStorage(async function() {
        var pending = (await chrome.storage.session.get(OPENAI_BROWSER_PENDING_KEY))[OPENAI_BROWSER_PENDING_KEY];
        var ownedPending = !!(pending && pending.tabId === tabId);
        if (ownedPending) await chrome.storage.session.remove(OPENAI_BROWSER_PENDING_KEY);
        // Only an OWNED tab dismisses the UI's "Waiting for approval" dialog
        // (same {error} shape as the exchange-failure broadcast). Cancel /
        // logout / method switch clear ownership in this lane BEFORE removing
        // the tab, so their close events fall through silently here.
        if (ownedPending) {
            chrome.runtime.sendMessage({ type: 'openai-oauth-updated', error: 'Sign-in window was closed. Choose a login method to try again.' }).catch(function() {});
        }
    }).catch(function() {});
});

// --- ChatGPT OAuth message handlers ---
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === 'openai-oauth-login') {
        if (!_openaiTrustedAuthSender(sender)) { sendResponse({ error: 'Sign-in must be started from AppAgent.' }); return false; }
        var method = message.method === 'device' ? 'device' : 'browser';
        if (!openaiBrowserStartInFlight || openaiBrowserStartInFlight.method !== method) {
            var attempt = { method: method, generation: openaiAuthGeneration };
            var previous = openaiBrowserStartInFlight;
            // A consumed browser callback no longer has a pending record/start
            // promise. Its exchange still owns login, including an awaited token
            // commit: invalidate synchronously before starting another method.
            var clearing = previous || openaiBrowserExchange ? _openaiCancelPendingLogin() : Promise.resolve();
            attempt.generation = openaiAuthGeneration;
            attempt.promise = clearing.then(async function() {
                _openaiAssertGeneration(attempt.generation);
                var browser = (await chrome.storage.session.get(OPENAI_BROWSER_PENDING_KEY))[OPENAI_BROWSER_PENDING_KEY];
                _openaiAssertGeneration(attempt.generation);
                if (method === 'browser' && browser && browser.expiresAt > Date.now()) {
                    try {
                        await chrome.tabs.update(browser.tabId, { active: true });
                        _openaiAssertGeneration(attempt.generation);
                        return _openaiBrowserPublic(browser);
                    } catch (e) { _openaiAssertGeneration(attempt.generation); }
                }
                if (browser || openaiBrowserExchange || method === 'browser') {
                    var cancellation = _openaiCancelPendingLogin();
                    attempt.generation = openaiAuthGeneration;
                    openaiBrowserStartInFlight = attempt;
                    await cancellation;
                    _openaiAssertGeneration(attempt.generation);
                }
                await _openaiQueueOAuthStorage(async function() {
                    _openaiAssertGeneration(attempt.generation);
                    await chrome.storage.local.remove(['openaiOAuthSuppressAutoLogin']);
                    _openaiAssertGeneration(attempt.generation);
                });
                _openaiAssertGeneration(attempt.generation);
                return method === 'device' ? startChatGPTOAuth() : _openaiStartBrowserLogin();
            }).finally(function() { if (openaiBrowserStartInFlight === attempt) openaiBrowserStartInFlight = null; });
            openaiBrowserStartInFlight = attempt;
        }
        openaiBrowserStartInFlight.promise.then(function(info) {
            sendResponse(Object.assign({ success: true }, info));
        }).catch(function() {
            sendResponse({ error: 'Sign-in did not start or was cancelled. Choose a login method to try again.' });
        });
        return true;
    }
    if (message.type === 'openai-oauth-cancel' || message.type === 'openai-oauth-browser-callback') {
        if (!_openaiTrustedAuthSender(sender)) { sendResponse({ error: 'Use the AppAgent sign-in dialog.' }); return false; }
        if (message.type === 'openai-oauth-cancel') {
            _openaiCancelPendingLogin().then(function() { sendResponse({ success: true }); }).catch(function() { sendResponse({ error: 'Could not cancel sign-in.' }); });
        } else {
            (async function() {
                var pending = (await chrome.storage.session.get(OPENAI_BROWSER_PENDING_KEY))[OPENAI_BROWSER_PENDING_KEY];
                if (!pending) return false;
                // The paste is only an alternate transport for our OWN live tab.
                // Never store, echo, log, or forward its URL outside this exchange.
                try { await chrome.tabs.get(pending.tabId); } catch (e) { return false; }
                return _openaiHandleBrowserCallback(pending.tabId, String(message.url || ''));
            })().then(function(ok) { sendResponse(ok ? { success: true } : { error: 'Callback was not accepted. Check the address, or start a new login.' }); }).catch(function() { sendResponse({ error: 'Callback was not accepted. Start a new login.' }); });
        }
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
            try {
                var browserStatus = await _openaiBrowserStatus();
                if (browserStatus && !data.openaiOAuthSuppressAutoLogin) { sendResponse(Object.assign({ loggedIn: false }, browserStatus)); return; }
            } catch (e) { /* Session storage unavailable: device flow remains usable. */ }
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
        if (!_openaiTrustedAuthSender(sender)) { sendResponse({ error: 'Use AppAgent to log out.' }); return false; }
        _openaiCancelPendingLogin().catch(function() {});
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
        if (p.type === 'file' || p.type === 'input_file') {
            // buildAPIMessages emits chat-completions file parts for PDFs.
            // Codex Responses needs the file fields flattened into input_file;
            // otherwise the text fallback below silently keeps only its label.
            var file = (p.type === 'file' ? p.file : p) || {};
            var filename = typeof file.filename === 'string' && file.filename ? file.filename : 'document.pdf';
            var fileData = file.file_data;
            // AppAgent attachments carry full base64 data URLs. Do not forward
            // local file-store IDs as upstream file IDs or stringify bad data.
            // Require complete base64 quartets and correctly sized final padding,
            // as emitted by FileReader. Alphabet-only checks also accept invalid
            // one-character bodies and extra padding (A, ABC==, AAAA=).
            var encoded = typeof fileData === 'string' && /^data:[^;,]+;base64,([A-Za-z0-9+/]+={0,2})(?![\s\S])/.exec(fileData);
            if (encoded && encoded[1].length % 4 === 0) {
                parts.push({ type: 'input_file', filename: filename, file_data: fileData });
            } else {
                parts.push({ type: textType, text: '[File content unavailable: ' + filename + '. Missing or invalid base64 data URL.]' });
            }
            continue;
        }
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
    // Public summaries only, never hidden raw reasoning. Default 'auto' —
    // the value every reference Codex client sends to this backend:
    //   OpenCode packages/opencode/src/provider/transform.ts (reasoningSummary:"auto"),
    //   Pi packages/ai/src/api/openai-codex-responses.ts (summary: ?? "auto"),
    //   Codex codex-rs/protocol/src/config_types.rs ReasoningSummary #[default] Auto.
    // 'detailed' was never shown to yield more than heading-only summaries here
    // (openai/codex#34873); an explicit caller value is still honoured.
    var askedSummary = (body && body.reasoning && typeof body.reasoning === 'object' && typeof body.reasoning.summary === 'string')
        ? body.reasoning.summary.toLowerCase() : '';
    reasoning.summary = (askedSummary === 'detailed' || askedSummary === 'concise') ? askedSummary : 'auto';
    if (isChatGPTAstraModel(body && body.model)) {
        // Astra requires reasoning, including when the global thinking budget
        // is off. Its five supported levels must not take the legacy clamp.
        var astraEffort = String(effort || 'high').toLowerCase();
        if (thinkingOff || astraEffort === 'none' || astraEffort === 'minimal') astraEffort = 'low';
        reasoning.effort = ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(astraEffort) >= 0 ? astraEffort : 'high';
    } else if (isChatGPTGpt61SolModel(body && body.model)) {
        // GPT-6.1 Sol: low|medium(default)|high|xhigh|max; 'none'/'minimal' are
        // NOT supported (docs/models/gpt-6.1-sol) → low, incl. thinking off.
        // No effort → omitted (server default medium); unknown → high.
        var s61Effort = effort ? String(effort).toLowerCase() : '';
        if (thinkingOff || s61Effort === 'none' || s61Effort === 'minimal') s61Effort = 'low';
        if (s61Effort) reasoning.effort = ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(s61Effort) >= 0 ? s61Effort : 'high';
    } else if (isChatGPTGpt6SolLunaModel(body && body.model)) {
        // GPT-6 Sol/Luna accept none|low|medium|high|xhigh|max natively: no
        // legacy xhigh/max clamp. Thinking off maps to the documented 'none'
        // (not an omitted object, which would get the server's medium).
        // 'minimal' is not listed for these models → low; unknown → high.
        var slEffort = effort ? String(effort).toLowerCase() : '';
        if (thinkingOff || slEffort === 'none') reasoning = { effort: 'none' };
        else if (slEffort) {
            if (slEffort === 'minimal') slEffort = 'low';
            reasoning.effort = ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(slEffort) >= 0 ? slEffort : 'high';
        }
    } else if (thinkingOff) reasoning = null;
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
    var modelSlug = _openaiNormalizeModelSlug(body && body.model) || 'gpt-6.1-sol';
    var quirks = _openaiModelQuirks[modelSlug] || {};
    if (reasoning && quirks.reasoningSummary === 'omit') delete reasoning.summary;
    else if (reasoning && quirks.reasoningSummary === 'auto') reasoning.summary = 'auto';
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
    var model = _openaiNormalizeModelSlug(requestBody && requestBody.model) || 'gpt-6.1-sol';
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

    // Only explicit rejection of this field/value may degrade public summaries.
    // Authentication, capacity and unrelated 400s keep their existing handling.
    function reasoningSummaryFallback(errorText, current) {
        var error = {};
        try { var parsed = JSON.parse(errorText); error = parsed.error || parsed; } catch (e) { error = { message: String(errorText || '') }; }
        var message = String(error.message || '');
        if (error.param && error.param !== 'reasoning.summary') return null;
        var exactParam = error.param === 'reasoning.summary';
        var namesParam = /["']?reasoning\.summary["']?/i.test(message);
        if (!exactParam && !namesParam) return null;
        if ((exactParam && error.code === 'unsupported_parameter') ||
            /unsupported (?:parameter|field)[:\s]+["']?reasoning\.summary["']?/i.test(message) ||
            /["']?reasoning\.summary["']? (?:parameter )?is not supported/i.test(message)) return 'omit';
        if (current !== 'detailed' && current !== 'concise') return null; // 'auto' has no lower summary rung
        // Structured param + rejection code identifies the requested value even
        // when the message does not echo it. Without param, require one clause
        // linking this field to rejection of detailed, not unrelated words.
        if (exactParam && (/^(?:unsupported_value|invalid_value|invalid_enum)$/.test(error.code || '') ||
            /^(?:unsupported|invalid) value\b/i.test(message))) return 'auto';
        if (/["']?reasoning\.summary["']?\s+(?:does not support|doesn't support)\s+["']?detailed\b/i.test(message) ||
            /["']?detailed["']?\s+(?:is not supported|is invalid|is unsupported)\s+(?:for|by)\s+["']?reasoning\.summary\b/i.test(message) ||
            /(?:unsupported|invalid)\s+(?:value\s*[:=]?\s*)?["']?detailed["']?\s+(?:for|of)\s+(?:parameter\s+)?["']?reasoning\.summary\b/i.test(message)) return 'auto';
        return null;
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
                var summaryFallback = responsesBody.reasoning && reasoningSummaryFallback(errBodyText, responsesBody.reasoning.summary);
                if (summaryFallback && responsesBody.reasoning.summary !== undefined && attempt < maxRetries) {
                    if (summaryFallback === 'omit') delete responsesBody.reasoning.summary;
                    else responsesBody.reasoning.summary = summaryFallback;
                    quirk.reasoningSummary = summaryFallback;
                    degraded = 'reasoning.summary (' + summaryFallback + ')';
                } else if (responsesBody.reasoning && responsesBody.reasoning.context !== undefined) {
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
                // Prefer the structured usage_limit_reached payload (plan,
                // resets_at / resets_in_seconds, eligible_promo) so the user
                // sees WHEN they can retry, not just "limit has been reached".
                var usageInfo = describeChatGPTUsageLimit(errBodyText);
                var usageMsg = usageInfo
                    ? usageInfo.headline
                    : 'ChatGPT usage limit reached: ' + (conciseApiErrorBody(errBodyText) || 'plan or quota exhausted');
                console.error('[AppAgent] ChatGPT 429 usage limit — raw body:', errBodyText);
                sink({ type: 'error', error: usageMsg, code: 'usage_exhausted', retryable: false, resetsAt: usageInfo ? usageInfo.resetsAt : null, plan: usageInfo ? usageInfo.plan : null });
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
        var reasoningById = new Map();
        var reasoningByOutput = new Map();
        var reasoningItems = [];
        var visibleReasoning = '';
        var reasoningDirty = false; // set when a part/record actually changes; flushReasoning is a no-op otherwise
        var replayedReasoning = new Map();

        // Display only explicitly public text. Opaque replay data is a separate
        // lane; neither encrypted_content nor redacted blocks are display text.
        function reasoningRecord(ev, item) {
            var id = ev.item_id || item.id;
            var oi = Number.isInteger(ev.output_index) && ev.output_index >= 0 ? ev.output_index : null;
            var byId = id ? reasoningById.get(id) : null;
            var byOutput = oi !== null ? reasoningByOutput.get(oi) : null;
            var record = byId || byOutput;
            if (!record) {
                // Legacy unkeyed deltas can stream, but cannot safely be matched
                // to a later identified item without an identity bridge.
                record = !id && oi === null ? reasoningById.get('') : null;
                if (!record) {
                    record = { order: reasoningItems.length, output: oi, parts: new Map() };
                    reasoningItems.push(record);
                }
            }
            if (byId && byOutput && byId !== byOutput) {
                reasoningDirty = true; // records merge → join order/content may change

                byOutput.parts.forEach(function(part, key) {
                    var prior = record.parts.get(key);
                    if (!prior || part.rank > prior.rank || (part.rank === prior.rank && part.text.startsWith(prior.text))) record.parts.set(key, part);
                });
                reasoningById.forEach(function(value, key) { if (value === byOutput) reasoningById.set(key, record); });
                reasoningByOutput.forEach(function(value, key) { if (value === byOutput) reasoningByOutput.set(key, record); });
                reasoningItems.splice(reasoningItems.indexOf(byOutput), 1);
            }
            if (id) reasoningById.set(id, record);
            else if (oi === null) reasoningById.set('', record);
            if (oi !== null) {
                if (record.output !== oi) reasoningDirty = true; // sort key changed
                record.output = oi; reasoningByOutput.set(oi, record);
            }
            return record;
        }
        function reconcileReasoning(record, lane, index, text, rank, isDelta) {
            if (typeof text !== 'string' || !text) return; // missing/empty is not an erasure
            var pi = Number.isInteger(index) && index >= 0 ? index : 0;
            var key = lane + ':' + pi;
            var part = record.parts.get(key);
            if (!part) { part = { lane: lane, index: pi, text: '', rank: -1 }; record.parts.set(key, part); }
            if (isDelta) {
                if (part.rank > 0) return; // a terminal snapshot already owns this part
                part.text += text;
            } else {
                if (rank < part.rank) return;
                // Repeated/stale snapshots must not truncate an equal-authority
                // prefix; a HIGHER-authority terminal revision may replace it.
                if (rank === part.rank && part.text.startsWith(text)) return;
                if (part.text !== text) reasoningDirty = true;
                part.text = text;
            }
            if (isDelta) reasoningDirty = true;
            part.rank = rank;
        }
        function recoverReasoningItem(ev, item, rank) {
            if (item.type !== 'reasoning') return;
            var record = reasoningRecord(ev, item);
            if (Array.isArray(item.summary)) item.summary.forEach(function(part, index) {
                if (part && part.type === 'summary_text') reconcileReasoning(record, 'summary', index, part.text, rank, false);
            });
            if (Array.isArray(item.content)) item.content.forEach(function(part, index) {
                if (part && part.type === 'reasoning_text') reconcileReasoning(record, 'text', index, part.text, rank, false);
            });
        }
        function flushReasoning() {
            // Only rebuild the joined text when a part/record changed since the
            // last flush: output_item.added/done for NON-reasoning items, stale
            // snapshots and no-op events used to re-sort + re-join every part
            // and re-run startsWith on the whole text (O(n²) over a stream).
            if (!reasoningDirty) return;
            reasoningDirty = false;
            var text = reasoningItems.slice().sort(function(a, b) {
                return (a.output === null ? a.order : a.output) - (b.output === null ? b.order : b.output);
            }).map(function(record) {
                return Array.from(record.parts.values()).sort(function(a, b) {
                    return a.lane === b.lane ? a.index - b.index : (a.lane === 'summary' ? -1 : 1);
                }).map(function(part) { return part.text; }).filter(Boolean).join('\n\n');
            }).filter(Boolean).join('\n\n');
            if (text === visibleReasoning) return;
            if (text.startsWith(visibleReasoning)) emitDelta({ reasoning: text.slice(visibleReasoning.length) });
            else emitDelta({ reasoning_snapshot: text }); // correction/insertion, NOT an append
            visibleReasoning = text;
        }
        function captureReasoningReplay(item) {
            if (!item.id || typeof item.encrypted_content !== 'string' || !item.encrypted_content) return;
            var summary = Array.isArray(item.summary) ? item.summary : [];
            var fingerprint = JSON.stringify([item.encrypted_content, summary]);
            var prior = replayedReasoning.get(item.id);
            if (prior && prior.fingerprint === fingerprint) return;
            var index = prior ? prior.index : reasoningItemIndex++;
            replayedReasoning.set(item.id, { index: index, fingerprint: fingerprint });
            emitDelta({ reasoning_details: [{ index: index, type: 'reasoning.encrypted',
                format: OPENAI_REASONING_FORMAT, id: item.id, data: item.encrypted_content, summary: summary }] });
        }
        function processReasoningEvent(ev) {
            var type = ev.type;
            // Legacy public-summary aliases (response.reasoning_summary.delta/done)
            // share canonical indexing and snapshot authority.
            if (type === 'response.reasoning_summary.delta' || type === 'response.reasoning_summary.done') {
                type = type.replace('reasoning_summary.', 'reasoning_summary_text.');
            }
            if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta' ||
                type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done') {
                var summary = type.indexOf('reasoning_summary_') !== -1;
                var isDelta = type.endsWith('.delta');
                reconcileReasoning(reasoningRecord(ev, {}), summary ? 'summary' : 'text',
                    summary ? ev.summary_index : ev.content_index, isDelta ? ev.delta : ev.text, isDelta ? 0 : 1, isDelta);
            } else if (type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done') {
                var part = ev.part || {};
                if (part.type === 'summary_text') reconcileReasoning(reasoningRecord(ev, {}), 'summary', ev.summary_index,
                    part.text, type.endsWith('.done') ? 2 : 0, false);
            } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
                var item = ev.item || {};
                recoverReasoningItem(ev, item, type.endsWith('.done') ? 3 : 0);
                if (type.endsWith('.done') && item.type === 'reasoning') captureReasoningReplay(item);
            } else if (type === 'response.completed' && ev.response && Array.isArray(ev.response.output)) {
                ev.response.output.forEach(function(item, index) {
                    if (!item) return;
                    recoverReasoningItem({ output_index: index }, item, 4);
                    if (item.type === 'reasoning') captureReasoningReplay(item);
                });
            } else return; // ordinary answer/tool deltas do not rebuild reasoning text
            flushReasoning();
        }

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

                // Reconcile public snapshots before completion commits the turn.
                // Late/repeated events after success must not mutate its final state.
                if (finished) continue;
                processReasoningEvent(ev);

                if (et === 'response.output_text.delta') {
                    if (ev.delta) emitDelta({ content: ev.delta });

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
                    // Public display and opaque replay were reconciled above.
                    if (et === 'response.output_item.done' && doneItem.type === 'reasoning') continue;
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
                    if (incompleteReason === 'max_output_tokens') {
                        // G-3: a max_output_tokens truncation is NOT an error —
                        // the streamed text is complete-so-far. Finish the
                        // synthetic stream like OpenRouter does (final chunk
                        // finish_reason 'length'), so app/010-llm-streaming keeps
                        // the partial content instead of throwing on data.error
                        // and discarding everything streamed so far.
                        finished = true;
                        emitDelta({}, 'length');
                    } else {
                        emit({ error: { message: 'ChatGPT response incomplete: ' + incompleteReason, type: 'incomplete_response', recoverable: true } });
                        finished = true;
                    }
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
// FABLE_5_1_PLUS_RE / isFable51Plus and the wider THINKING_BINDING_RE /
// isThinkingBindingModel (Fable/Mythos 5.1+ OR Opus 5.5+ OR Sonnet 5.5+ — the set this file
// actually gates on) are DEFINED in src/js/core/030-config.js (single source
// of truth, shared with buildAPIMessages in the page + SW bundles) and reach
// this file through importScripts('sw-bundle.js') at the top. Do not
// redeclare them here — a second copy is exactly the drift the shared
// definition exists to prevent.

// Beta flags for the OAuth /v1/messages call. The base trio is unconditional
// (OAuth access, interleaved thinking, cache scope); the bound-thinking models
// (Fable/Mythos 5.1+, Opus 5.5+ AND Sonnet 5.5+ — THINKING_BINDING_RE / isThinkingBindingModel
// in src/js/core/030-config.js) additionally need the two thinking betas that
// back the block_binding / display fields transformToAnthropic emits for them —
// sending those fields WITHOUT the betas is a 400, and sending the betas to
// older models is harmless but noisy, so they are gated on the same regex.
var ANTHROPIC_BASE_BETAS = ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'prompt-caching-scope-2026-01-05'];
var ANTHROPIC_THINKING_BINDING_BETAS = ['thinking-binding-controls-2026-08-01', 'thinking-display-updates-2026-08-18'];

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
    if (isThinkingBindingModel(model)) betas = betas.concat(ANTHROPIC_THINKING_BINDING_BETAS);
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
        // the global Max Tokens setting) — this is a last-resort fallback.
        // getDefaultMaxTokensForModel (src/js/core/030-config.js, shared into
        // the SW bundle) gives 128000 for Opus 5.5+ / Sonnet 5.5+ / 64000 otherwise; the
        // literal 64000 = DEFAULT_MAX_TOKENS guards a realm without it.
        max_tokens: body.max_tokens || (typeof getDefaultMaxTokensForModel === 'function' ? getDefaultMaxTokensForModel(body.model) : 64000),
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

    // Bound-thinking models (Fable/Mythos 5.1+, Opus 5.5+, Sonnet 5.5+ — isThinkingBindingModel):
    // thinking is always-on adaptive (type 'enabled'/'disabled' → 400), so the
    // thinking object is sent UNCONDITIONALLY for them — even when the
    // provider has no effort/budget configured (effort then stays at the model
    // default; output_config is only emitted when body.reasoning asks for one).
    //   display:'summarized' — public reasoning summaries AND progress updates;
    //                        'updates' alone keeps reasoning summaries hidden.
    //                        See docs/en/models/fable-5-1/whats-new-fable-5-1.
    //   block_binding.prefix_mismatch_behavior:'drop_block' — replayed thinking
    //                        blocks whose bound prefix no longer matches (edited
    //                        system prompt, tool roster change, context compaction)
    //                        are dropped server-side and reported in the response's
    //                        input_transformations instead of failing the request
    //                        with a 400 (beta thinking-binding-controls-2026-08-01).
    // Both betas are added by getAnthropicBetas for the same THINKING_BINDING_RE match.
    //   thinkingOff — the request builder's explicit off switch (global Thinking
    //                 Budget = 0, no provider effort → reasoning:{enabled:false},
    //                 see callOpenRouterStreaming). Fable/Mythos 5.1+ and Opus
    //                 5.5+ never receive it (the builder's offSignalOk gate) and
    //                 have no accepted 'disabled' shape, so they get the forced
    //                 adaptive object below. Sonnet 5.5+ on this OAuth path DOES
    //                 receive it and maps it to {type:'between_tools'} via
    //                 thinkingOffShapeFor — the only bound model with an off-ish
    //                 mode. Never 'disabled' for any bound model.
    var thinkingBound = isThinkingBindingModel(body.model);
    var thinkingOff = !!(body.reasoning && body.reasoning.enabled === false);
    var effort = (body.reasoning && !thinkingOff) ? body.reasoning.effort : null;
    var budget = (body.reasoning && !thinkingOff) ? body.reasoning.max_tokens : null;
    var modelLower = String(body.model || '').toLowerCase();
    var adaptiveOnly = isAdaptiveOnlyClaude(modelLower);
    var adaptiveCapable = adaptiveOnly || ADAPTIVE_CAPABLE_CLAUDE_RE.test(modelLower);
    // Sonnet 5.5+ exception (thinkingOffShapeFor, core/030-config.js): the
    // off switch maps to {type:'between_tools'} (no other fields allowed).
    // The builder REPLACES reasoning with exactly {enabled:false}, so
    // body.reasoning.effort is undefined here in practice; the xhigh/max →
    // adaptive result of thinkingOffShapeFor is a defensive guard only (a
    // provider effort always wins over the off switch upstream, so xhigh/max
    // arrive as {effort} and take the forced-adaptive branch instead).
    // Never 'disabled'.
    var offShape = (thinkingOff && typeof thinkingOffShapeFor === 'function')
        ? thinkingOffShapeFor(modelLower, body.reasoning.effort) : null;
    if (thinkingBound && offShape && offShape.type === 'between_tools') {
        result.thinking = offShape;
        stripReplayedThinkingBeforeLastUserTurn(merged);
    } else if (thinkingBound) {
        result.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
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
    // output_config.effort only exists on adaptive models (4.6+ / Fable 5.1+ /
    // Opus 5.5+). A budget-only request on an adaptive model keeps the
    // historical mapping to effort:'high' (the budget itself has no adaptive
    // equivalent).
    if (!thinkingOff && (thinkingBound || adaptiveCapable)) {
        if (effort) result.output_config = { effort: effort };
        else if (budget) result.output_config = { effort: 'high' };
    }

    result.metadata = { user_id: 'appagent_extension' };
    return result;
}

// One stored reasoning_details entry → Anthropic thinking block, or null when
// it cannot be replayed. redacted_thinking blocks (safety-redacted reasoning)
// carry an opaque `data` payload instead of thinking+signature; the API
// requires them to be replayed verbatim during tool-use continuations
// (captured by the SSE handler in runClaudeOAuthStream as
// { type:'redacted_thinking', data }). Unsigned thinking is never replayed.
function anthropicThinkingBlockFromRd(rd) {
    if (!rd) return null;
    if (rd.type === 'redacted_thinking') {
        return rd.data ? { type: 'redacted_thinking', data: rd.data } : null;
    }
    if (!rd.signature) return null;
    return { type: 'thinking', thinking: rd.thinking || rd.text || rd.content || '', signature: rd.signature };
}

function anthropicToolUseBlockFromCall(tc) {
    var func = tc.function || {};
    var args = func.arguments || '{}';
    var input = (typeof args === 'string') ? (function() { try { return JSON.parse(args); } catch(e) { return {}; } })() : args;
    return { type: 'tool_use', id: tc.id, name: func.name, input: input };
}

// Replay an assistant turn in its ORIGINAL content-block order (Opus 5.5 /
// Fable 5.1+ thinking binding: a thinking block is bound to everything before
// it, so reordering [thinking,text,thinking,tool_use] silently drops the later
// thinking). msg.block_order is recorded page-side (010-llm-streaming.js) from
// the SSE handler's delta.anthropic_block markers. Returns the block array, or
// null when the order is absent or no longer matches the message exactly —
// the caller then uses the legacy thinking→text→tool_use layout unchanged.
// Validation: text entries must tile the text contiguously from 0 to its full
// length; every reasoning_details entry and every tool call must be referenced
// exactly once (by rd.index / tool call id); no unknown entry types.
function buildOrderedAnthropicAssistantBlocks(msg) {
    var order = msg.block_order;
    if (!Array.isArray(order) || order.length === 0) return null;

    // Text + cache_control. By replay time callOpenRouterStreaming has
    // normalized a string content into [{type:'text', text, cache_control?}].
    var text = '';
    var cc = null;
    if (typeof msg.content === 'string') {
        text = msg.content;
    } else if (Array.isArray(msg.content)) {
        if (msg.content.length > 1) return null;
        if (msg.content.length === 1) {
            var part = msg.content[0];
            if (!part || part.type !== 'text' || typeof part.text !== 'string') return null;
            text = part.text;
            cc = part.cache_control || null;
        }
    } else if (msg.content != null && msg.content !== '') {
        return null;
    }

    var rds = Array.isArray(msg.reasoning_details) ? msg.reasoning_details : [];
    var rdByIdx = {};
    for (var r = 0; r < rds.length; r++) {
        var rd = rds[r];
        if (!rd || typeof rd.index !== 'number' || rdByIdx.hasOwnProperty(rd.index)) return null;
        rdByIdx[rd.index] = rd;
    }
    var tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    var tcById = {};
    for (var t = 0; t < tcs.length; t++) {
        var tc = tcs[t];
        if (!tc || !tc.id || tcById.hasOwnProperty(tc.id)) return null;
        tcById[tc.id] = tc;
    }

    var out = [];
    var usedRd = {}, usedRdCount = 0;
    var usedTc = {}, usedTcCount = 0;
    var pos = 0;
    var lastTextOut = -1;
    for (var k = 0; k < order.length; k++) {
        var entry = order[k];
        if (!entry || typeof entry !== 'object') return null;
        if (entry.t === 'r') {
            if (!rdByIdx.hasOwnProperty(entry.i) || usedRd.hasOwnProperty(entry.i)) return null;
            usedRd[entry.i] = true; usedRdCount++;
            var tb = anthropicThinkingBlockFromRd(rdByIdx[entry.i]);
            if (tb) out.push(tb); // unsigned / empty-redacted: skipped, as legacy
        } else if (entry.t === 'x') {
            if (typeof entry.s !== 'number' || typeof entry.e !== 'number') return null;
            if (entry.s !== pos || entry.e < entry.s || entry.e > text.length) return null;
            pos = entry.e;
            var piece = text.slice(entry.s, entry.e);
            // Empty / whitespace-only text blocks are rejected by the API as
            // request input; skip them (the tiling check still covers them).
            // Note: skipping one that precedes a later thinking entry can change the replayed prefix.
            if (piece.trim()) { out.push({ type: 'text', text: piece }); lastTextOut = out.length - 1; }
        } else if (entry.t === 'u') {
            if (typeof entry.id !== 'string' || !tcById.hasOwnProperty(entry.id) || usedTc.hasOwnProperty(entry.id)) return null;
            usedTc[entry.id] = true; usedTcCount++;
            out.push(anthropicToolUseBlockFromCall(tcById[entry.id]));
        } else {
            return null;
        }
    }
    if (pos !== text.length) return null;
    if (usedRdCount !== rds.length || usedTcCount !== tcs.length) return null;
    // cache_control stays on the (last) text piece — the block the page-side
    // cache pass put it on. No text block emitted to carry it → legacy.
    if (cc) {
        if (lastTextOut < 0) return null;
        out[lastTextOut].cache_control = cc;
    }
    return out.length > 0 ? out : null;
}

// between_tools (Sonnet 5.5+ thinking OFF): the model only thinks between
// tool calls, so thinking blocks replayed from EARLIER turns are dead weight
// (and, bound to a prefix, may be dropped server-side anyway). Strip
// `thinking` / `redacted_thinking` blocks IN PLACE from assistant messages
// that come BEFORE the last genuine user turn — a user message with no
// tool_result block (a user message carrying any tool_result is part of the
// running tool loop). Blocks of the in-flight tool loop (assistant messages
// after that boundary) are KEPT: the API requires the final assistant
// tool-use turn to start with its thinking block, else 400. The boundary is
// identical for every request of one turn, so the stripped prefix stays
// byte-stable across that turn's tool loop (prompt cache friendly). An
// assistant message that would become empty is left unchanged.
// NOT covered: a system-prompt edit or a context compaction in the MIDDLE of
// a turn rewrites the prefix under the in-flight loop's kept thinking blocks;
// between_tools carries no block_binding field, so that case still depends
// on the API accepting (or the caller retrying) the replayed blocks.
function stripReplayedThinkingBeforeLastUserTurn(messages) {
    if (!Array.isArray(messages)) return messages;
    var boundary = -1;
    for (var i = messages.length - 1; i >= 0; i--) {
        var m = messages[i];
        if (!m || m.role !== 'user') continue;
        var hasToolResult = Array.isArray(m.content) && m.content.some(function(b) {
            return b && b.type === 'tool_result';
        });
        if (!hasToolResult) { boundary = i; break; }
    }
    for (var j = 0; j < boundary; j++) {
        var a = messages[j];
        if (!a || a.role !== 'assistant' || !Array.isArray(a.content)) continue;
        var kept = a.content.filter(function(b) {
            return !(b && (b.type === 'thinking' || b.type === 'redacted_thinking'));
        });
        if (kept.length > 0 && kept.length !== a.content.length) a.content = kept;
    }
    return messages;
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
        var ordered = buildOrderedAnthropicAssistantBlocks(msg);
        if (ordered) return { role: 'assistant', content: ordered };
        // Legacy layout (no/invalid block_order): thinking → text → tool_use.
        var blocks = [];
        if (msg.reasoning_details && Array.isArray(msg.reasoning_details)) {
            msg.reasoning_details.forEach(function(rd) {
                var tb = anthropicThinkingBlockFromRd(rd);
                if (tb) blocks.push(tb);
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
                blocks.push(anthropicToolUseBlockFromCall(tc));
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
    var tabsByOrigin = {};   // ALL tabs per origin — a sibling may hold the live session
    (tabs || []).forEach(function(t) {
        if (!byOrigin[t.origin]) byOrigin[t.origin] = t;
        (tabsByOrigin[t.origin] = tabsByOrigin[t.origin] || []).push(t);
    });

    var cache = await new Promise(function(r) {
        chrome.storage.local.get('instanceTokens', function(d) { r((d && d.instanceTokens) || {}); });
    });
    Object.keys(cache).forEach(function(o) { if (!byOrigin[o]) byOrigin[o] = null; });

    var origins = Object.keys(byOrigin);
    if (!origins.length) return;

    var results = [];
    // Per-origin cache changes, merged into a FRESH read of instanceTokens at the
    // end via snUpdateInstanceTokens (never a whole-map write of the snapshot read
    // above, which would clobber a concurrent snRememberInstanceToken).
    //   { set: entry }        — store this token (it just answered non-401)
    //   { del: [tokens] }     — drop the entry, only if it still holds one of these
    var cacheOps = {};

    function touchSession(origin, tok) {
        return fetch(origin + '/api/now/uisession/touch-session', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'Accept': '*/*',
                'X-UserToken': tok,
                'X-WantAuthSessionNotifications': 'true'
            }
        });
    }

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
        var liveTokens = [];   // distinct g_ck values held by this origin's open tabs, tab order

        // Prefer the LIVE tab's current g_ck over the cached token. After a
        // logoff -> logon, ServiceNow mints a brand-new session + g_ck on the
        // tab, but our per-origin cache still holds the OLD token. Pinging
        // touch-session with that stale token — especially with
        // X-WantAuthSessionNotifications below — makes ServiceNow broadcast a
        // "you have been logged off" notification to the open tab even though
        // the user just signed back in. Reading the tab first keeps the
        // heartbeat on the session's current token and refreshes the cache.
        //
        // But read EVERY tab of the origin: a session-timed-out tab keeps its dead
        // g_ck while a sibling the user signed in with holds the live one. If the
        // cached token is still held by ANY open tab it is current — ping with it
        // first and leave the cache alone (never overwrite a good cached token
        // with whatever the first tab happens to hold). Otherwise the first tab's
        // token goes first (the logoff -> logon case above) and siblings follow.
        if (tab) {
            var _originTabs = tabsByOrigin[origin] || [tab];
            for (var lt = 0; lt < _originTabs.length; lt++) {
                var live = await readTokenFromTab(_originTabs[lt]);
                if (live && liveTokens.indexOf(live) === -1) liveTokens.push(live);
            }
            if (liveTokens.length) {
                if (cached && cached.token && liveTokens.indexOf(cached.token) !== -1) {
                    liveTokens.splice(liveTokens.indexOf(cached.token), 1);
                    liveTokens.unshift(cached.token);
                }
                token = liveTokens[0];
                source = 'tab';
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

        var _triedTokens = [token];
        try {
            var res = await touchSession(origin, token);

            // 401 = cached token went stale. Re-probe a live tab once and retry.
            if (res.status === 401 && tab && source === 'cache') {
                var fresh = await readTokenFromTab(tab);
                if (fresh && _triedTokens.indexOf(fresh) === -1) {
                    token = fresh;
                    _triedTokens.push(fresh);
                    res = await touchSession(origin, token);
                    source = 'tab-refresh';
                }
            }

            // Still 401: the token we led with may belong to a session-timed-out tab
            // while ANOTHER tab of the same origin is signed in. Try each remaining
            // distinct tab token (already read above) before declaring logged out.
            for (var st = 0; st < liveTokens.length && res.status === 401; st++) {
                var alt = liveTokens[st];
                if (_triedTokens.indexOf(alt) !== -1) continue;
                _triedTokens.push(alt);
                var altRes = await touchSession(origin, alt);
                if (altRes.status !== 401) {
                    res = altRes;
                    token = alt;
                    source = 'tab-sibling';
                }
            }

            if (res.status === 401) {
                // Drop the cache entry if the instance has logged us out for good.
                // Every tab token was rejected, so the browser session is gone: the
                // cached token (same cookie jar) goes too, even if it was not pinged.
                if (cached) cacheOps[origin] = { del: _triedTokens.concat([cached.token]) };
            } else if (!cached || cached.token !== token) {
                // Cache only a token the instance just ACCEPTED (non-401).
                cacheOps[origin] = { set: { token: token, userName: (cached && cached.userName) || '', updated: Date.now() } };
            }

            results.push({ origin: origin, status: res.status, source: source });
        } catch (e) {
            results.push({ origin: origin, status: 'error', error: String(e && e.message || e), source: source });
        }
    }

    if (Object.keys(cacheOps).length) {
        await snUpdateInstanceTokens(function(map) {
            var changed = false;
            Object.keys(cacheOps).forEach(function(o) {
                var op = cacheOps[o];
                if (op.set) { map[o] = op.set; changed = true; }
                // A concurrent writer may have stored a NEWER token meanwhile — keep it.
                else if (op.del && map[o] && op.del.indexOf(map[o].token) !== -1) { delete map[o]; changed = true; }
            });
            return changed;
        });
    }
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
var _swOffscreenClosing = null;           // P4 #1: Promise while an idle-close is in flight (ensureOffscreenDocument awaits it)
var _swOffscreenHealing = null;           // P4 #1: Promise while a zombie self-heal (close → recreate) is in flight — single-flight across concurrent waitForOffscreenReady timeouts
var _swOffscreenLastError = null;         // B2: {code, message, at} of the last failed ensure step (OFFSCREEN_* code); null after a success. Surfaced by callOffscreenHelper.
var _swOffscreenIdleSince = 0;            // ms when last run finished; 0 = busy or unknown
var _swOffscreenReadyResolvers = [];      // Awaiters that need offscreen up + handlers registered
var OFFSCREEN_IDLE_GRACE_MS = 60 * 1000;  // close offscreen 60s after the last run ends

// B2 (post-Reload wedge: js_eval / run_tests silently never ran). Every await
// below is capped at 5s (closing wait, hasDocument/getContexts probe,
// createDocument, getContexts fallback), so a call settles within ~20s worst
// case. Failures reject with e = Error(CODE + ': ' + sentence), e.code = CODE
// (OFFSCREEN_CLOSE_TIMEOUT | OFFSCREEN_PROBE_TIMEOUT | OFFSCREEN_CREATE_TIMEOUT |
// OFFSCREEN_CREATE_FAILED), recorded in _swOffscreenLastError ({code, message,
// at}; null after a success). Helpers are INLINE so text slices of this
// function stay self-contained.
function ensureOffscreenDocument() {
    var p = (async function() {
    if (typeof chrome.offscreen === 'undefined') {
        console.error('[SW] chrome.offscreen API unavailable — manifest "offscreen" permission missing?');
        return;
    }
    var STEP_MS = 5000;
    // Settles {ok,value} | {ok:false,error} | {timedOut:true} within STEP_MS; never rejects.
    function within(fn) {
        return new Promise(function(resolve) {
            var t = setTimeout(function() { resolve({ timedOut: true }); }, STEP_MS);
            function done(r) { clearTimeout(t); resolve(r); }
            try { Promise.resolve(fn()).then(function(v) { done({ ok: true, value: v }); }, function(err) { done({ ok: false, error: err }); }); }
            catch (err) { done({ ok: false, error: err }); }
        });
    }
    function fail(code, sentence) {
        var e = new Error(code + ': ' + sentence);
        e.code = code;
        _swOffscreenLastError = { code: code, message: e.message, at: Date.now() };
        return e;
    }
    var useHas = typeof chrome.offscreen.hasDocument === 'function';
    var canContexts = !!(chrome.runtime && typeof chrome.runtime.getContexts === 'function');
    function contexts() { return chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }); }
    // P4 #1 (flag P4_OFFSCREEN_SELF_HEAL, read at CALL time — bg.js loads
    // BEFORE the SW bundle that defines self.getP4Flag): never race a create
    // against an in-flight idle-close. hasDocument() still reports the doc
    // being torn down, so without this we would skip creation and the next
    // waitForOffscreenReady would time out on a document that is gone.
    // B2: bounded — a wedged close is DROPPED on timeout (never awaited again
    // by later calls); a close failure stays non-fatal.
    var closing = _swOffscreenClosing;
    if (closing && typeof self.getP4Flag === 'function' && self.getP4Flag('P4_OFFSCREEN_SELF_HEAL')) {
        var cw = await within(function() { return closing; });
        if (cw.timedOut) {
            if (_swOffscreenClosing === closing) _swOffscreenClosing = null;
            console.warn('[SW] ' + fail('OFFSCREEN_CLOSE_TIMEOUT', 'the in-flight offscreen close did not settle within ' + STEP_MS
                + 'ms; dropped it and continuing').message);
        }
    }
    var exists = false;
    var probe = await within(useHas ? function() { return chrome.offscreen.hasDocument(); } : (canContexts ? contexts : function() { return []; }));
    if (probe.timedOut) {
        // Unknown state: try the create anyway — its failure/timeout path
        // re-checks getContexts, so an existing document still counts.
        console.warn('[SW] ' + fail('OFFSCREEN_PROBE_TIMEOUT', (useHas ? 'chrome.offscreen.hasDocument' : 'chrome.runtime.getContexts')
            + ' did not settle within ' + STEP_MS + 'ms; trying createDocument').message);
    } else if (probe.ok) {
        exists = useHas ? !!probe.value : !!(probe.value && probe.value.length > 0);
    }
    if (exists) { _swOffscreenLastError = null; return; }
    if (_swOffscreenCreating) return _swOffscreenCreating;
    var creating = (async function() {
        var cr = await within(function() {
            return chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['BLOBS'],
                justification: 'Host the JS sandbox iframe for js_eval / skill tools and provide a keep-alive anchor for the agent loop in the service worker.'
            });
        });
        if (cr.ok) { _swOffscreenIdleSince = 0; _swOffscreenLastError = null; return; }
        var cause = cr.timedOut ? 'chrome.offscreen.createDocument did not settle within ' + STEP_MS + 'ms'
            : 'chrome.offscreen.createDocument failed: ' + String(cr.error && cr.error.message || cr.error);
        // Fallback: a document may exist although the create failed or hung
        // ("Only a single offscreen document may be created", or a probe that
        // timed out above). An existing OFFSCREEN_DOCUMENT context = success.
        if (canContexts) {
            var fb = await within(contexts);
            if (fb.ok && fb.value && fb.value.length > 0) { _swOffscreenLastError = null; return; }
            if (fb.timedOut) throw fail('OFFSCREEN_PROBE_TIMEOUT', 'chrome.runtime.getContexts did not settle within ' + STEP_MS
                + 'ms while checking for an existing document after ' + cause);
        } else if (!cr.timedOut && /single offscreen document/.test(cause)) {
            _swOffscreenLastError = null; return; // pre-B2 behaviour when getContexts is unavailable
        }
        throw fail(cr.timedOut ? 'OFFSCREEN_CREATE_TIMEOUT' : 'OFFSCREEN_CREATE_FAILED', cause + '; no offscreen document exists');
    })();
    // Always settles (every step above is bounded) and ALWAYS clears, so the
    // next call after a failure starts fresh and recreate/heal never hang on it.
    var tracked = creating.finally(function() { if (_swOffscreenCreating === tracked) _swOffscreenCreating = null; });
    _swOffscreenCreating = tracked;
    tracked.catch(function(err) { console.error('[SW] offscreen creation failed: ' + (err && err.message || err)); });
    return tracked;
    })();
    // Pre-handled: fire-and-forget callers (worker/130-port-bridge.js) never
    // raise unhandledrejection; awaiting callers still receive the coded error.
    p.catch(function() {});
    return p;
}

// H18 — liveness ping. An open keep-alive port only proves the document
// CONNECTED once; a js_eval that loops synchronously freezes the offscreen
// realm while the port stays open, so every later dispatch hung until the
// 5-min js_eval watchdog. Before each helper dispatch (and after a js_eval
// timeout) we round-trip a 'helper-ping' (answered by offscreen-helper.js).
// A BUSY-but-healthy document (long async eval awaiting tools/sleeps) still
// answers — the handler runs on its event loop; only a sync loop blocks it.
// Each ping waits OFFSCREEN_PING_TIMEOUT_MS; misses are retried until
// OFFSCREEN_UNRESPONSIVE_MS of CONTINUOUS misses have elapsed, and only then
// is the document treated as wedged (close, recreate, reset the port, re-wait
// readiness). The window is deliberately long: a recreate kills EVERY
// in-flight eval in the shared document, so a finite CPU burst in another
// chat (seconds, not minutes) must be absorbed, not punished — same rationale
// as the 60s readiness cap in waitForOffscreenReady. The waiting dispatch
// stalls meanwhile, which is fine: the document is frozen anyway.
var OFFSCREEN_PING_TIMEOUT_MS = 2500;
var OFFSCREEN_UNRESPONSIVE_MS = 30000;
var _swOffscreenPinging = null;           // single-flight ping round (shared by concurrent dispatches)

function pingOffscreenDocument(timeoutMs) {
    return new Promise(function(resolve) {
        var done = false;
        var timer = setTimeout(function() { settle(false); }, timeoutMs || OFFSCREEN_PING_TIMEOUT_MS);
        function settle(alive) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(alive);
        }
        try {
            Promise.resolve(chrome.runtime.sendMessage({ type: 'helper-ping', payload: {} }))
                .then(function(resp) { settle(!!(resp && resp.ok)); }, function() { settle(false); });
        } catch (e) { settle(false); }
    });
}

// B2 (recreate hardening): settles {ok,value} | {ok:false,error} | {timedOut:true}
// within ms; never rejects; always clears its timer. Module-level twin of the
// inline within() in ensureOffscreenDocument. Deliberately declared OUTSIDE the
// waitForOffscreenReady slice (test/js-eval-sandbox-lifecycle.test.js counts
// that slice's timers).
function _swOffscreenWithin(fn, ms) {
    return new Promise(function(resolve) {
        var t = setTimeout(function() { resolve({ timedOut: true }); }, ms);
        function done(r) { clearTimeout(t); resolve(r); }
        try { Promise.resolve(fn()).then(function(v) { done({ ok: true, value: v }); }, function(err) { done({ ok: false, error: err }); }); }
        catch (err) { done({ ok: false, error: err }); }
    });
}

// Close + recreate a wedged document. Shares the _swOffscreenHealing slot with
// the zombie self-heal in waitForOffscreenReady, so at most ONE close/recreate
// is in flight; publishes _swOffscreenClosing like maybeCloseOffscreenIfIdle so
// a concurrent ensureOffscreenDocument waits instead of racing the teardown.
// B2: both close awaits (an in-flight close, then our closeDocument) are capped
// at 5s. A wedged close is DROPPED (only if it is still the published one),
// recorded as OFFSCREEN_CLOSE_TIMEOUT in _swOffscreenLastError, and the
// (bounded) re-create runs anyway, so the heal ALWAYS settles (worst case ~5s +
// 5s + ensure) and the slot is ALWAYS cleared (identity-checked). The port reset
// is identity-checked too: a close settling late must not null the port a
// fresh document connected meanwhile.
function recreateOffscreenDocument(reason) {
    if (_swOffscreenHealing) return _swOffscreenHealing;
    var CLOSE_MS = 5000;
    function closeTimeout(sentence) {
        var msg = 'OFFSCREEN_CLOSE_TIMEOUT: ' + sentence;
        _swOffscreenLastError = { code: 'OFFSCREEN_CLOSE_TIMEOUT', message: msg, at: Date.now() };
        console.warn('[SW] ' + msg);
    }
    var healing = (async function() {
        var prior = _swOffscreenClosing;
        if (prior) {
            var pw = await _swOffscreenWithin(function() { return prior; }, CLOSE_MS); // a rejection stays non-fatal
            if (pw.timedOut) {
                if (_swOffscreenClosing === prior) _swOffscreenClosing = null;
                closeTimeout('the in-flight offscreen close did not settle within ' + CLOSE_MS + 'ms; dropped it and recreating');
            }
        }
        console.warn('[SW] offscreen document unresponsive (' + (reason || 'ping') + '); closing and recreating');
        var portAtClose = _swOffscreenKeepAlivePort;
        var closing = (async function() {
            try {
                if (typeof chrome.offscreen !== 'undefined' && chrome.offscreen.closeDocument) await chrome.offscreen.closeDocument();
            } catch (e) { /* already gone */ }
            if (_swOffscreenKeepAlivePort === portAtClose) _swOffscreenKeepAlivePort = null;
        })();
        _swOffscreenClosing = closing;
        var cw = await _swOffscreenWithin(function() { return closing; }, CLOSE_MS);
        if (_swOffscreenClosing === closing) _swOffscreenClosing = null;
        if (cw.timedOut) {
            if (_swOffscreenKeepAlivePort === portAtClose) _swOffscreenKeepAlivePort = null;
            closeTimeout('chrome.offscreen.closeDocument did not settle within ' + CLOSE_MS + 'ms; dropped it and recreating');
        }
        try { await ensureOffscreenDocument(); } catch (e) { /* creation errors are logged there */ }
        return true;
    })();
    var tracked = healing.finally(function() { if (_swOffscreenHealing === tracked) _swOffscreenHealing = null; });
    _swOffscreenHealing = tracked;
    return tracked;
}

// Resolves true when the document answers a ping (or a fresh one is ready
// after a recreate), false when no responsive document could be obtained.
async function ensureOffscreenResponsive(timeoutMs, reason) {
    if (_swOffscreenHealing) {
        try { await _swOffscreenHealing; } catch (e) { /* ignore */ }
        return waitForOffscreenReady(timeoutMs || 5000);
    }
    if (!_swOffscreenPinging) {
        _swOffscreenPinging = (async function() {
            // Port identity at round start: if a DIFFERENT port connects
            // during the misses, a fresh document already replaced the old
            // one (zombie heal / idle-close + recreate) — never close it.
            var portAtStart = _swOffscreenKeepAlivePort;
            var deadline = Date.now() + OFFSCREEN_UNRESPONSIVE_MS;
            for (;;) {
                var started = Date.now();
                if (await pingOffscreenDocument()) return true;
                if (_swOffscreenKeepAlivePort && _swOffscreenKeepAlivePort !== portAtStart) return true;
                if (Date.now() >= deadline) return false;
                // A fast miss (sendMessage rejected immediately) must not
                // spin: pace retries at one per ping slot.
                var rest = OFFSCREEN_PING_TIMEOUT_MS - (Date.now() - started);
                if (rest > 0) await new Promise(function(r) { setTimeout(r, rest); });
                if (_swOffscreenKeepAlivePort && _swOffscreenKeepAlivePort !== portAtStart) return true;
            }
        })().finally(function() { _swOffscreenPinging = null; });
    }
    if (await _swOffscreenPinging) return true;
    // Never tear the document down while persistence is busy (same guard
    // as the zombie self-heal / idle-close): report not-available instead.
    if (typeof persistenceBusyReason === 'function' && persistenceBusyReason()) return false;
    await recreateOffscreenDocument(reason || 'ping timeout');
    return waitForOffscreenReady(timeoutMs || 5000);
}

// Called by the js_eval watchdog (tools/020-tool-execution.js) after an
// inactivity timeout: fire-and-forget health check so a wedged document is
// replaced before the next call. Never CREATES a document when none is
// connected (cancelling a dead request must not spawn a realm) and never
// re-runs the timed-out user code.
self.checkOffscreenResponsive = function(reason) {
    if (!_swOffscreenKeepAlivePort && !_swOffscreenHealing) return Promise.resolve(false);
    return ensureOffscreenResponsive(5000, reason || 'js_eval timeout').catch(function() { return false; });
};

// Wait until the offscreen doc is up AND has connected its keep-alive
// port (== handlers are registered). Resolves to true if ready.
function waitForOffscreenReady(timeoutMs) {
    if (_swOffscreenKeepAlivePort) return Promise.resolve(true);
    // B2: fire-and-forget, but never an unhandled rejection — the coded error
    // is recorded in _swOffscreenLastError and surfaced by callOffscreenHelper.
    // Guarded: test slices stub ensureOffscreenDocument.
    try {
        var _ensure = ensureOffscreenDocument();
        if (_ensure && typeof _ensure.catch === 'function') _ensure.catch(function() { /* logged + recorded in ensure */ });
    } catch (e) { /* stub threw synchronously */ }
    // P4 #1: cap the readiness wait (callers pass their execution timeout
    // here, sometimes minutes — a dead document should fail fast). Hard cap
    // 60s, not 20s (#923 follow-up): a long-running caller whose offscreen
    // document is merely BUSY (another chat's CPU-bound js_eval starving the
    // keep-alive connect) must not be failed early — the caller's own
    // timeout stays authoritative below the cap. Kept inline (no module
    // constant) so the test slice of this function stays self-contained.
    var cap = Math.min(timeoutMs || 5000, 60000);
    function waitOnce() {
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
            }, cap);
        });
    }
    return waitOnce().then(function(ready) {
        if (ready) return true;
        // P4 #1 one-shot self-heal (flag P4_OFFSCREEN_SELF_HEAL, read at call
        // time via self.getP4Flag — see ensureOffscreenDocument). A "zombie"
        // offscreen document exists but never connected its keep-alive port
        // (handlers not registered — hung load / stuck realm). Previously
        // every call timed out forever: hasDocument() said true, so nothing
        // ever recreated it. Close it ONCE, recreate, wait one more cap.
        // Never while persistence is busy (same guard as the idle-close).
        if (!(typeof self.getP4Flag === 'function' && self.getP4Flag('P4_OFFSCREEN_SELF_HEAL'))) return false;
        if (_swOffscreenKeepAlivePort) return true;
        // SINGLE-FLIGHT (R4 SF1): several callers can time out in the same
        // window. Only the first runs the heal; the others join its promise.
        // Without this the 2nd caller saw hasDocument() true for the document
        // the 1st heal had JUST recreated and closeDocument()'d the healthy one.
        // Resolves true when a close+recreate happened, false when there was
        // nothing to heal (no document / persistence busy).
        if (!_swOffscreenHealing) {
            _swOffscreenHealing = (async function() {
                var exists = false;
                try {
                    exists = !!(typeof chrome.offscreen !== 'undefined' && typeof chrome.offscreen.hasDocument === 'function'
                        && await chrome.offscreen.hasDocument());
                } catch (e) { exists = false; }
                if (!exists) return false;
                if (typeof persistenceBusyReason === 'function' && persistenceBusyReason()) return false;
                // Publish the close via _swOffscreenClosing so a concurrent
                // ensureOffscreenDocument waits for it instead of racing a create
                // against the teardown (same contract as maybeCloseOffscreenIfIdle).
                var closing = (async function() {
                    try { await chrome.offscreen.closeDocument(); } catch (e) { /* already gone */ }
                    _swOffscreenKeepAlivePort = null;
                })();
                _swOffscreenClosing = closing;
                try { await closing; } finally { if (_swOffscreenClosing === closing) _swOffscreenClosing = null; }
                console.warn('[SW] offscreen self-heal: zombie document (no keep-alive port within ' + cap + 'ms) closed; recreating');
                try { await ensureOffscreenDocument(); } catch (e) { /* creation errors are logged there */ }
                return true;
            })().finally(function() { _swOffscreenHealing = null; });
        }
        return _swOffscreenHealing.then(function(healed) {
            if (!healed) return false;
            if (_swOffscreenKeepAlivePort) return true;
            return waitOnce();
        });
    });
}

// Fail closed on hybrid installs before allocating an invocation or relaying tools.
// Keep normal eval unrestricted when the host is healthy; never bypass its registry.
function swTestPolicyStartupError() {
    if (typeof TestRunPolicy === 'undefined' || !TestRunPolicy || !TestRunPolicy.registry ||
        !['bind', 'descriptor', 'unbind', 'relay'].every(function(name) { return typeof TestRunPolicy.registry[name] === 'function'; })) {
        return new Error('Inconsistent extension installation: SW TestRunPolicy is missing or incompatible. Rebuild all extension artifacts using the header Reload; sandbox execution remains blocked.');
    }
    return null;
}

// Called by the SW runtime (sw-bundle.js, worker/010-platform-stub.js)
// any time the agent loop needs DOM (js_eval, skills sandbox, image).
// timeoutMs gates readiness, not execution. Sandbox callers may additionally
// supply an AbortSignal to dispose just their invocation after an outer timeout.
async function callOffscreenHelper(type, payload, timeoutMs, signal) {
    return new Promise(function(resolve, reject) {
        var settled = false;
        var dispatched = false;
        // Generated here, never derived from chat/tool ids or supplied by code.
        // Two nested evals in the same chat must have different cancellation keys.
        var isSandbox = type === 'helper-js-eval' || type === 'helper-skill-sandbox';
        var policyError = isSandbox ? swTestPolicyStartupError() : null;
        if (policyError) { reject(policyError); return; }
        var requestId = isSandbox ? 'sandbox_' + crypto.randomUUID() : null;
        var testKey = payload && payload._testRunContext || null;
        var wirePayload = Object.assign({}, payload);
        delete wirePayload._testRunContext;
        delete wirePayload.testRunPolicy;
        if (requestId) {
            TestRunPolicy.registry.bind(requestId, testKey);
            if (testKey) wirePayload.testRunPolicy = TestRunPolicy.registry.descriptor(testKey);
            wirePayload.sandboxRequestId = requestId;
        }
        function finish(error, result) {
            if (settled) return;
            settled = true;
            if (requestId) TestRunPolicy.registry.unbind(requestId);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve(result);
        }
        function onAbort() {
            if (settled) return;
            var error = new Error('Offscreen helper execution cancelled');
            error.name = 'AbortError';
            finish(error);
            if (dispatched) {
                // Never call ensureOffscreenDocument/callOffscreenHelper here:
                // cancelling a dead request must not create a new helper realm.
                // The helper owns iframe/listener cleanup and settles the original
                // response channel too. Failure here cannot mask the outer timeout.
                try {
                    chrome.runtime.sendMessage({ type: 'helper-cancel-sandbox', payload: { sandboxRequestId: requestId } })
                        .catch(function(err) { console.warn('[SW] sandbox cancellation delivery failed', err); });
                } catch (err) { console.warn('[SW] sandbox cancellation delivery failed', err); }
            }
        }
        // B2: append the last coded ensure failure (OFFSCREEN_*). typeof guard:
        // test slices of this function run without the module-level state.
        function lastOffscreenError() {
            var le = typeof _swOffscreenLastError !== 'undefined' ? _swOffscreenLastError : null;
            return le && le.message ? ' (last offscreen error: ' + le.message + ')' : '';
        }
        if (signal) {
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        waitForOffscreenReady(timeoutMs || 5000).then(function(ready) {
            // An outer timeout may have won while readiness was pending. Its
            // cancelled invocation must NEVER spring to life when the helper wakes.
            if (settled) return;
            if (!ready) {
                // P4 #1: decorated so callers/logs can tell "keep-alive port
                // never connected" from a helper runtime error. The message
                // keeps the /not available/ contract (tests + worker stub).
                var e = new Error('Offscreen helper not available (offscreen_not_ready: keep-alive port never connected within '
                    + Math.min(timeoutMs || 5000, 60000) + 'ms)' + lastOffscreenError());
                e.code = 'offscreen_not_ready';
                throw e;
            }
            function dispatch() {
                dispatched = true;
                return chrome.runtime.sendMessage({
                    type: type,
                    payload: wirePayload
                });
            }
            // H18: an open keep-alive port does not prove the document is
            // responsive (a sync-looping js_eval freezes it). Ping first;
            // ensureOffscreenResponsive recreates a wedged document. typeof
            // guard: test slices of this function run without it.
            if (typeof ensureOffscreenResponsive !== 'function') return dispatch();
            return ensureOffscreenResponsive(timeoutMs || 5000, type).then(function(alive) {
                if (settled) return;
                if (!alive) {
                    var ue = new Error('Offscreen helper not available (offscreen_unresponsive: document did not answer a ping and could not be recreated)' + lastOffscreenError());
                    ue.code = 'offscreen_not_ready';
                    throw ue;
                }
                return dispatch();
            });
        }).then(function(resp) {
            if (settled) return; // late helper response after abort
            if (!resp) throw new Error('Offscreen helper returned no response');
            if (!resp.ok) throw new Error(resp.error || 'Offscreen helper error');
            finish(null, resp.result);
        }).catch(function(err) { finish(err); });
    });
}
// Expose to the imported SW bundle.
self.callOffscreenHelper = callOffscreenHelper;
self.ensureOffscreenDocument = ensureOffscreenDocument;
// #17 runtime_inspect action:'sandbox_registry' — read-only snapshot of the
// offscreen-document bookkeeping for the SW 'pull-debug-state' reply
// (worker/130-port-bridge.js). Synchronous; hasDocument() is awaited there.
self._swOffscreenDebug = function() {
    return {
        keepAlivePort: !!_swOffscreenKeepAlivePort,
        idleSince: _swOffscreenIdleSince,
        creating: !!_swOffscreenCreating,
        lastError: _swOffscreenLastError,
        readyWaiters: _swOffscreenReadyResolvers.length
    };
};

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
        if (_pbr) return;
    }
    // P4 #1: publish the in-flight close so ensureOffscreenDocument (flag
    // P4_OFFSCREEN_SELF_HEAL) can await it instead of racing a create against
    // a document that hasDocument() still reports.
    // B2: ensure / recreate DROP a close that hangs >5s, so this one may settle
    // late: clear the slot and reset the port only if they are still ours.
    var portAtClose = _swOffscreenKeepAlivePort;
    var closing = (async function() {
        try {
            if (typeof chrome.offscreen !== 'undefined' && chrome.offscreen.closeDocument) {
                await chrome.offscreen.closeDocument();
            }
        } catch (e) { /* ignore — already gone */ }
        _swOffscreenIdleSince = 0;
        if (_swOffscreenKeepAlivePort === portAtClose) _swOffscreenKeepAlivePort = null;
    })().finally(function() { if (_swOffscreenClosing === closing) _swOffscreenClosing = null; });
    _swOffscreenClosing = closing;
    return closing;
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
    _swOffscreenLastError = null; // B2: a connected document is a success signal (no stale OFFSCREEN_* suffix)
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

// --- Claude CLI User-Agent version gate ---
// DNR rule 3000 spoofs `User-Agent: claude-cli/<version> (external, cli)` on
// every api.anthropic.com request. Anthropic enforces a SERVER-SIDE per-model
// minimum Claude Code version read from that header (we send no billing
// system block, so the UA is the only version signal): a too-old version is a
// 400 invalid_request_error with error_code 'claude_code_version_too_old' and
// the message "Claude Code X.Y.Z does not support this model; version A.B.C
// or newer is required" (Opus 5.5 needs 2.1.280). CLAUDE_CLI_VERSION is the
// shipped floor; when the API asks for a newer one, runClaudeOAuthStream
// persists it under claudeCliVersionOverride, re-installs the rule and retries
// the request once — so the next model bump does not need an extension
// release. Startup applies max(shipped, stored override): a release that
// ships a floor ABOVE an old override wins, an override ABOVE the floor keeps
// winning until the floor catches up.
var CLAUDE_CLI_VERSION = '2.1.280';
var CLAUDE_CLI_VERSION_OVERRIDE_KEY = 'claudeCliVersionOverride';
var CLAUDE_CLI_UA_RULE_ID = 3000;
var CLAUDE_CLI_SEMVER_RE = /^\d+\.\d+\.\d+$/;
// "version A.B.C or newer is required" — the version the API demands.
var CLAUDE_CLI_REQUIRED_VERSION_RE = /version\s+(\d+\.\d+\.\d+)\s+or\s+newer\s+is\s+required/i;
// The version currently installed in rule 3000 (best-effort mirror; updated
// by applyClaudeCliUaRule). Starts at the shipped floor so a bump decision
// made before the async startup install resolves still compares sanely.
var _claudeCliVersionApplied = CLAUDE_CLI_VERSION;

// Numeric dotted-version compare: -1 / 0 / 1. Non-numeric or missing segments
// count as 0, so '2.1' < '2.1.1' and '2.1.280' > '2.1.257'.
function compareSemver(a, b) {
    var pa = String(a || '').split('.'), pb = String(b || '').split('.');
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
        var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

// Given a non-2xx response body (raw text, usually JSON), return the Claude
// Code version the API says is required, or null when the body is not a
// version gate. Detects the gate by the documented message shape OR the
// error_code; only the message carries the version, so an error_code hit with
// no parsable version is still null (logged — nothing to bump to).
function parseRequiredClaudeCliVersion(errText) {
    var text = String(errText || '');
    if (!text) return null;
    var m = CLAUDE_CLI_REQUIRED_VERSION_RE.exec(text);
    if (m && CLAUDE_CLI_SEMVER_RE.test(m[1])) return m[1];
    var gated = /claude_code_version_too_old/i.test(text);
    if (!gated) {
        try {
            var parsed = JSON.parse(text);
            var err = parsed && (parsed.error || parsed);
            gated = !!(err && (err.error_code === 'claude_code_version_too_old' || err.code === 'claude_code_version_too_old'));
        } catch (e) { /* not JSON */ }
    }
    if (gated) console.warn('[AppAgent] claude_code_version_too_old without a parsable required version:', text.slice(0, 300));
    return null;
}

// Install (replace) DNR rule 3000 with the given claude-cli version. Resolves
// once the rule is live — the NEXT fetch carries the new header.
function applyClaudeCliUaRule(version) {
    if (!CLAUDE_CLI_SEMVER_RE.test(String(version || ''))) return Promise.reject(new Error('applyClaudeCliUaRule: invalid version ' + version));
    return chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [CLAUDE_CLI_UA_RULE_ID],
        addRules: [{
            id: CLAUDE_CLI_UA_RULE_ID,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'claude-cli/' + version + ' (external, cli)' }] },
            condition: { urlFilter: 'api.anthropic.com/*', resourceTypes: ['xmlhttprequest'] }
        }]
    }).then(function() { _claudeCliVersionApplied = version; });
}

// Startup: rule = max(shipped floor, persisted override).
async function installClaudeCliUaRule() {
    var version = CLAUDE_CLI_VERSION;
    try {
        var stored = (await chrome.storage.local.get(CLAUDE_CLI_VERSION_OVERRIDE_KEY))[CLAUDE_CLI_VERSION_OVERRIDE_KEY];
        if (stored && CLAUDE_CLI_SEMVER_RE.test(String(stored)) && compareSemver(stored, version) > 0) version = String(stored);
    } catch (e) { /* storage unavailable — shipped floor */ }
    await applyClaudeCliUaRule(version);
    return version;
}

// Version-gate recovery for runClaudeOAuthStream: persist the demanded version
// as the override and re-install the rule. Returns true when the header was
// actually raised (caller retries once), false when the demanded version is
// not above what is already installed (retrying would fail identically —
// surface the original error instead).
async function bumpClaudeCliVersion(version) {
    if (!CLAUDE_CLI_SEMVER_RE.test(String(version || ''))) return false;
    if (compareSemver(version, _claudeCliVersionApplied) <= 0) return false;
    try {
        var payload = {};
        payload[CLAUDE_CLI_VERSION_OVERRIDE_KEY] = version;
        await chrome.storage.local.set(payload);
    } catch (e) { /* persist is best-effort; the in-session rule still applies */ }
    await applyClaudeCliUaRule(version);
    return true;
}

installClaudeCliUaRule().catch(function(e) {
    console.warn('[AppAgent] claude-cli User-Agent rule install failed:', e && e.message);
});
// --- end Claude CLI User-Agent version gate ---
