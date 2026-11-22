// =============================================================
// AppAgent SW runtime — Platform overrides.
//
// The page bundle's platform-bridge.js sets up Platform from a
// real window.sessionToken + DOM APIs. The SW has no DOM and no
// window, so we wire Platform up to chrome.storage for session
// state, and to chrome.notifications directly for notifications.
//
// DOM-needing operations (image canvas, js_eval sandbox, skills
// sandbox) bridge to the offscreen helper via `callOffscreenHelper`
// (declared in background.js, attached to `self`).
//
// All page-style functions called by the loop that DO NOT make
// sense in the SW (showSnackbar, renderMessages, hideSpinner, etc.)
// are stubbed in 020-page-stubs.js — kept separate from Platform
// so the Platform contract stays small.
// =============================================================

Platform = Platform || {};

// Persisted session token, kept in sync via chrome.storage.onChanged.
// Mirrors the cache that the page bundle's platform-bridge maintains
// in window.sessionToken.
var _workerSessionToken = '';
var _workerInstanceUrl = '';
var _workerUserName = '';

Platform.instanceUrl = '';

Platform.getSessionToken = function() {
    return _workerSessionToken || '';
};

// Initial load: read once on startup. Expose Platform.ready so the
// entry script can await it before calling runAgent on resume (so the
// first API call has a non-empty session token).
Platform.ready = new Promise(function(resolve) {
    chrome.storage.local.get(['sessionToken', 'instanceUrl', 'userName'], function(data) {
        _workerSessionToken = data.sessionToken || '';
        _workerInstanceUrl = data.instanceUrl || '';
        _workerUserName = data.userName || '';
        Platform.instanceUrl = _workerInstanceUrl;
        resolve();
    });
});

// Live updates: when a tab refreshes its g_ck, keep the SW mirror current.
chrome.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local') return;
    if (changes.sessionToken) _workerSessionToken = changes.sessionToken.newValue || '';
    if (changes.instanceUrl) {
        _workerInstanceUrl = changes.instanceUrl.newValue || '';
        Platform.instanceUrl = _workerInstanceUrl;
    }
    if (changes.userName) _workerUserName = changes.userName.newValue || '';
});

// Browser notification: we ARE the SW, call chrome.notifications directly.
// The existing show-notification handler in background.js still exists for
// any offscreen helper that wants to forward, but this path is in-SW.
Platform.sendNotification = function(opts) {
    try {
        var title = (opts && opts.title) || 'AppAgent';
        var message = (opts && opts.message) || '';
        // Prefer background.js's helper: it also records opts.chatId so the
        // notification click navigates the open UI to that chat.
        if (typeof self.appagentCreateNotification === 'function') {
            // It also applies the notificationMode gate (silent/notify/sound).
            self.appagentCreateNotification(title, message, (opts && opts.chatId) || '');
            return;
        }
        // Fallback still honors notificationMode (same legacy rule as
        // background.js resolveNotificationMode): 'silent' = none, 'sound' = + chime.
        chrome.storage.local.get(['notificationMode', 'approvalSoundEnabled'], function(d) {
            var m = d && d.notificationMode;
            if (['silent', 'notify', 'sound'].indexOf(m) === -1) m = (d && d.approvalSoundEnabled === true) ? 'sound' : 'notify';
            if (m === 'silent') return;
            if (m === 'sound' && typeof callOffscreenHelper === 'function') {
                try { callOffscreenHelper('play-notification-sound', {}, 5000).catch(function() {}); } catch (e) {}
            }
        // 'appagent-' id prefix is REQUIRED: background.js's notifications.onClicked
        // handler only focuses/opens the panel for ids starting with 'appagent-'.
        // An auto-generated id would make the notification click a silent no-op.
        // Random suffix: two notifications in the same millisecond would share an
        // id and Chrome silently REPLACES the first (concurrent chats can finish together).
        chrome.notifications.create('appagent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), {
            type: 'basic',
            iconUrl: 'icons/AppAgentIconStarOnly_128.png',
            title: title,
            message: message
        });
        });
    } catch (e) { /* notifications unavailable */ }
};

// HTTP-Referer used by callOpenRouterStreaming. The SW has no window;
// fall back to the connected SN instance URL or a stable static referer.
Platform.getReferer = function() {
    return Platform.instanceUrl || 'https://appagent.local/sw';
};

// =============================================================
// Offscreen-helper bridge. Used by 020-tool-execution.js (js_eval,
// image utils) and 140-skills-engine.js (skill sandbox) to run DOM-
// needing code in the offscreen document. The actual implementation
// lives in background.js (callOffscreenHelper); we re-export here so
// shared code can rely on a single API.
// =============================================================
Platform.callOffscreenHelper = function(type, payload, timeoutMs, signal) {
    if (typeof self.callOffscreenHelper !== 'function') {
        return Promise.reject(new Error('Offscreen helper bridge not initialized'));
    }
    return self.callOffscreenHelper(type, payload, timeoutMs, signal);
};

// =============================================================
// Multi-instance SN registry.
//
// The page bundle's platform-bridge keeps this cache by sending
// `list-sn-instances-detailed` / `get-token-for-instance` to the
// background. The SW IS the background, so we just call the shared
// helpers (snGetInstancesDetailed / snGetTokenForInstance) which
// are defined in background.js and exposed on `self`. We resolve
// them at call time because background.js executes AFTER this
// file (this file is loaded via `importScripts('sw-bundle.js')` at
// the top of background.js).
//
// Caches mirror the page-bridge shape so shared tool code (e.g.
// list_instances in 020-tool-execution.js and the args.instance
// branches in servicenow_api) works identically here.
// =============================================================
Platform.instances = [];

// Set the worker's active-instance session: in-memory + persisted sessionToken
// (the page bridge follows via storage.onChanged). The SINGLE sessionToken
// persist site of this file — adoption (401-retry, open-for-login, probe) and
// drop (proven-dead token) both go through it (RB-01 write-site ratchet).
function _persistWorkerToken(token) {
    _workerSessionToken = token || '';
    try { chrome.storage.local.set({ sessionToken: _workerSessionToken }); } catch (e) {}
}
function _adoptWorkerToken(token) {
    if (!token || token === _workerSessionToken) return false;
    _persistWorkerToken(token);
    return true;
}
// Forget a token the instance proved dead (401 with no replacement, shim login
// wait timed out, probe saw the tab signed out). Only drops the token we still
// hold, so a newer adoption is never clobbered. Persisted, so the page bridge
// and the next SW boot stop reporting a dead session as connected.
function _dropWorkerToken(token) {
    if (!token || token !== _workerSessionToken) return false;
    _persistWorkerToken('');
    return true;
}

Platform.refreshInstances = async function() {
    if (typeof self.snGetInstancesDetailed !== 'function') return Platform.instances;
    var prev = Platform.instances || [];
    var raw = await self.snGetInstancesDetailed();
    Platform.instances = raw.map(function(inst) {
        var host = inst.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
        return {
            url: inst.url,
            shortName: host.split('.')[0],
            host: host,
            token: inst.token || '',
            userName: inst.userName || '',
            roles: inst.roles || [],
            // maint login (not a sys_user; synthetic roles ['maint','admin']) — see background.js snDetectMaint
            isMaint: !!inst.isMaint || (inst.roles || []).indexOf('maint') !== -1,
            tabs: inst.tabs || [],
            // the instance ACCEPTED this token on the probe (not 401; see snResolveInstanceSession)
            sessionOk: !!inst.sessionOk,
            isActive: inst.url === Platform.instanceUrl
        };
    });
    // Adopt a healthier active-instance token: the probe checks ALL open tabs and
    // returns the one the instance accepted, while _workerSessionToken may still be
    // the dead g_ck of a session-timed-out tab. getTokenForInstance() returns
    // _workerSessionToken for the active instance, so without this every tool that
    // fetches with it directly (servicenow_api args.instance, servicenow_run_script
    // + its admin gate, list_instances roles, diff/attachment) kept the dead token.
    // Adopt when the instance accepted the probed token (sessionOk), OR when the held
    // worker token was itself 401-rejected by the probe while this one was not. A
    // 401-rejected token is never adopted. A partial entry (the origin missed the
    // registry deadline; built from cached guesses) is never adopted either.
    if (Platform.instanceUrl) {
        var _probedActive = Platform.instances.filter(function(i) { return i.url === Platform.instanceUrl; })[0];
        var _rawActive = raw.filter(function(i) { return i && i.url === Platform.instanceUrl; })[0];
        var _rejected = (_rawActive && _rawActive.rejectedTokens) || [];
        if (_probedActive && _probedActive.token && !(_rawActive && _rawActive.partial) && _rejected.indexOf(_probedActive.token) === -1 &&
            (_probedActive.sessionOk || (_workerSessionToken && _rejected.indexOf(_workerSessionToken) !== -1))) {
            _adoptWorkerToken(_probedActive.token);
        }
    }
    // Guard: the active instance is the one this service worker is actively making
    // authenticated API calls against via _workerSessionToken. A tab probe that
    // transiently fails to read g_ck (tab discarded by Chrome Memory Saver, scripting
    // blocked, or no readable main-world context) returns an empty token, which would
    // wrongly flip our live session to "disconnected" in list_instances even though we
    // are demonstrably using it. Never let the probe override a session we hold a token
    // for: restore the worker token (carrying the prior identity forward) for the
    // active instance. This matches getTokenForInstance(), which already trusts
    // _workerSessionToken for the active instance unconditionally.
    if (Platform.instanceUrl && _workerSessionToken) {
        var _heldTok = _workerSessionToken;
        var _prevActive = prev.filter(function(p) { return p && p.url === Platform.instanceUrl; })[0];
        var _activeEntry = Platform.instances.filter(function(i) { return i.url === Platform.instanceUrl; })[0];
        // ...but only when the probe could NOT see the session. If an open tab
        // answered with an empty g_ck (user signed out / session expired) or the
        // instance 401'd the very token we hold, the session is gone: resurrecting
        // it made list_instances report connected:true for a dead session, so the
        // agent never tried to reconnect (open a tab / connect_instance).
        var _rawAct = raw.filter(function(i) { return i && i.url === Platform.instanceUrl; })[0];
        var _heldRejected = !!(_rawAct && (_rawAct.rejectedTokens || []).indexOf(_heldTok) !== -1);
        var _provenDead = _heldRejected || !!(_rawAct && _rawAct.sawOpenTab);
        if (_activeEntry) {
            // Restore ONLY when an open tab exists but could not be read (Memory
            // Saver discard, blocked injection). No open tab = nothing vouches for
            // the held token (the session may have expired with the tab closed):
            // report it disconnected so the agent reconnects instead of waiting.
            var _hasTabs = !!(_activeEntry.tabs && _activeEntry.tabs.length);
            if (!_activeEntry.token && !_provenDead && _hasTabs) {
                _activeEntry.token = _heldTok;
                // Carry the prior identity only when it belongs to the held token.
                var _prevSame = !!(_prevActive && _prevActive.token === _heldTok);
                if (!_activeEntry.userName && _prevSame) _activeEntry.userName = _prevActive.userName || '';
                if ((!_activeEntry.roles || !_activeEntry.roles.length) && _prevSame) _activeEntry.roles = _prevActive.roles || [];
            }
            // 401'd by the probe, or the open tab answered signed-out: drop it.
            if (_heldRejected || (!_activeEntry.token && _provenDead)) _dropWorkerToken(_heldTok);
        } else {
            // Active origin wasn't even in the probe (no tab + no cached token entry):
            // list it, but disconnected — a tab-less held token is unverified.
            if (_heldRejected) _dropWorkerToken(_heldTok);
            var _ah = Platform.instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
            Platform.instances.push({
                url: Platform.instanceUrl,
                shortName: _ah.split('.')[0],
                host: _ah,
                token: '',
                // Carry the prior identity only when it belongs to the held token
                // (Memory-Saver restore, same user); otherwise it is another user's.
                userName: (_prevActive && _prevActive.token === _heldTok) ? (_prevActive.userName || '') : '',
                roles: (_prevActive && _prevActive.token === _heldTok) ? (_prevActive.roles || []) : [],
                tabs: [],
                isActive: true
            });
        }
    }
    return Platform.instances;
};

// Mirror of platform-bridge's resolveInstanceUrl. Accepts short names
// ("dev12345"), bare hostnames, or full URLs.
Platform.resolveInstanceUrl = function(nameOrUrl) {
    if (!nameOrUrl) return Platform.instanceUrl;
    if (nameOrUrl.startsWith('http')) return nameOrUrl.replace(/\/$/, '');
    if (nameOrUrl.indexOf('.') !== -1) return 'https://' + nameOrUrl.replace(/\/$/, '');
    for (var i = 0; i < Platform.instances.length; i++) {
        if (Platform.instances[i].shortName === nameOrUrl) return Platform.instances[i].url;
    }
    return null;
};

// Token lookup for a specific instance: active token, then per-instance cache,
// then live probe via the shared SW helper.
// After a 401 on an ABSOLUTE instance URL (every servicenow_api / run_script /
// attachment / diff call passes args.instance, so they all bypass the relative-
// URL shim below): drop the dead token from the registry, re-probe that
// instance's open tabs (excluding the failed token, validated) and cache the
// fresh one. Returns '' when no other usable token exists.
// Single-flight per instance origin: concurrent 401s (parallel tool calls on the
// same dead session) share ONE in-flight re-probe instead of each re-scanning tabs.
var _refresh401InFlight = {};
// Hard cap on one tab re-probe (getSnTabList + per-tab probes + validation). A
// probe that never settles (tab stuck on a login/SSO page, blocked injection)
// used to pin the single-flight entry forever: every later 401 with the same
// dead token joined it, so the instance stayed unreachable until a browser
// restart cleared SW memory. Resolves null on timeout/rejection.
// 5s: the lookup only probes tabs of the target origin, in parallel (each
// bounded at snTimeoutMs('tab') 2.5s), and snGetTokenForInstance has its own
// 5s whole-lookup cap — an API call must never wait longer for a token.
var SN_TOKEN_PROBE_DEADLINE_MS = 5000;
function _probeWithDeadline(p, ms) {
    return new Promise(function(resolve) {
        var done = false;
        var t = setTimeout(function() { if (!done) { done = true; resolve(null); } }, ms || (self && self.__snProbeDeadlineMs) || SN_TOKEN_PROBE_DEADLINE_MS);
        Promise.resolve(p).then(function(v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
            function() { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
}
Platform.refreshTokenAfter401 = function(instanceUrl, failedToken) {
    if (!instanceUrl || typeof self.snGetTokenForInstance !== 'function') return Promise.resolve('');
    var key = instanceUrl + '\u0000' + (failedToken || '');
    if (_refresh401InFlight[key]) return _refresh401InFlight[key];
    var p = (async function() {
        var probed = null;
        try { probed = await _probeWithDeadline(self.snGetTokenForInstance(instanceUrl, { excludeToken: failedToken, validate: true })); } catch (e) { probed = null; }
        var fresh = (probed && probed.token && probed.token !== failedToken) ? probed.token : '';
        for (var i = 0; i < Platform.instances.length; i++) {
            if (Platform.instances[i].url !== instanceUrl) continue;
            // Roles / maint describe the OLD token's user: a replacement token
            // may be another user (signed out and back in), so they are dropped
            // until the next registry resolve re-reads them for the new token.
            if (Platform.instances[i].token !== fresh) {
                Platform.instances[i].roles = [];
                if ('isMaint' in Platform.instances[i]) Platform.instances[i].isMaint = false;
                // The old token's user name must not survive either: a stale name
                // made _rsCheckAdmin skip the maint probe and name the wrong user.
                Platform.instances[i].userName = (fresh && probed.userName) || '';
            }
            Platform.instances[i].token = fresh;
            if (fresh && probed.userName) Platform.instances[i].userName = probed.userName;
        }
        if (instanceUrl === Platform.instanceUrl) {
            if (fresh) _adoptWorkerToken(fresh);
            // No replacement: the held token is proven dead (401) — drop it
            // (memory + storage) so getTokenForInstance() stops handing it out
            // and list_instances / the page stop reporting it connected.
            else _dropWorkerToken(failedToken);
        }
        return fresh;
    })();
    _refresh401InFlight[key] = p;
    var clear = function() { if (_refresh401InFlight[key] === p) delete _refresh401InFlight[key]; };
    p.then(clear, clear);
    return p;
};

// opts.timeoutMs: the caller's remaining connection budget (tools/020
// _sfTokenFor) — caps the tab probe below the 5s default.
Platform.getTokenForInstance = async function(instanceUrl, opts) {
    if (instanceUrl === Platform.instanceUrl && _workerSessionToken) {
        return _workerSessionToken;
    }
    for (var i = 0; i < Platform.instances.length; i++) {
        if (Platform.instances[i].url === instanceUrl && Platform.instances[i].token) {
            return Platform.instances[i].token;
        }
    }
    if (typeof self.snGetTokenForInstance !== 'function') return '';
    var probed = null;
    var _gtMs = (opts && opts.timeoutMs > 0) ? opts.timeoutMs : undefined;
    try { probed = await _probeWithDeadline(self.snGetTokenForInstance(instanceUrl), _gtMs); } catch (e) { probed = null; }
    if (!probed || !probed.token) return '';
    // Update cache (or insert if this is a new instance).
    var found = false;
    for (var j = 0; j < Platform.instances.length; j++) {
        if (Platform.instances[j].url === instanceUrl) {
            Platform.instances[j].token = probed.token;
            if (probed.userName) Platform.instances[j].userName = probed.userName;
            found = true;
            break;
        }
    }
    if (!found) {
        var host = instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        Platform.instances.push({
            url: instanceUrl,
            shortName: host.split('.')[0],
            host: host,
            token: probed.token,
            userName: probed.userName || '',
            roles: [],
            tabs: [],
            isActive: instanceUrl === Platform.instanceUrl
        });
    }
    return probed.token;
};

// Tab targeting (used by iframe_tool when args.instance is given).
// When a target URL is given, only return a tab already sitting on that page
// (same origin + path) so we never hand back a tab the user is actively using;
// with no match, return null and let the caller's guarded adoption logic decide.
Platform.getTabForInstance = function(instanceUrl, targetUrl) {
    for (var i = 0; i < Platform.instances.length; i++) {
        if (Platform.instances[i].url !== instanceUrl || Platform.instances[i].tabs.length === 0) continue;
        var tabs = Platform.instances[i].tabs;
        if (targetUrl) {
            try {
                var _tgt = new URL(targetUrl);
                var _tgtPath = _tgt.pathname.replace(/\/+$/, '');
                for (var j = 0; j < tabs.length; j++) {
                    try {
                        var _tu = new URL(tabs[j].url);
                        if (_tu.origin === _tgt.origin && _tu.pathname.replace(/\/+$/, '') === _tgtPath) return tabs[j].id;
                    } catch (e) {}
                }
                return null;
            } catch (e) {}
        }
        return tabs[0].id;
    }
    return null;
};

// Refresh the instance cache after the initial sessionToken / instanceUrl load,
// so the first tool call after SW boot sees a populated registry. list_instances
// now ALWAYS re-probes (matching the header pill), and servicenow_api /
// iframe_tool instance resolution still reads this registry between probes.
Platform.ready.then(function() {
    Platform.refreshInstances().catch(function() {});
});

// =============================================================
// SW fetch shim for relative SN URLs.
//
// Shared tool code (servicenow_api, getRecordVersion, etc.) calls
// `fetch('/api/now/...')` with relative URLs. In the page that works
// because platform-bridge intercepts window.fetch to prepend the
// active instance URL and attach X-UserToken. The SW has no such
// intercept — a relative URL resolves against the SW's own location
// (chrome-extension://EXTID/) and fails with "Failed to fetch".
//
// We install a thin wrapper that ONLY handles strings starting with
// '/'. Full URLs (https://api.anthropic.com/..., cross-instance SN
// URLs the tool already prepended, etc.) pass straight through. On
// 401 we refresh the token once via the shared SW helper.
// =============================================================
// After a 401 on the active instance, re-probe ALL its open tabs for a token
// other than the one that just failed. Platform.getTokenForInstance() would
// short-circuit to _workerSessionToken (the dead token) for the active
// instance, so a healthy sibling tab was never tried and the call fell
// straight through to the open-for-login flow.
function _freshTokenAfter401(failedToken, ms) {
    if (typeof self.snGetTokenForInstance === 'function') {
        // Same tab probe as refreshTokenAfter401 → same hang risk: bound it
        // (by the caller's remaining connection budget when given).
        return _probeWithDeadline(self.snGetTokenForInstance(Platform.instanceUrl, { excludeToken: failedToken }), ms).then(function(p) {
            return (p && p.token) || '';
        });
    }
    return Platform.getTokenForInstance(Platform.instanceUrl);
}

(function installSnFetchShim() {
    var _origFetch = self.fetch.bind(self);

    // NOTE: absolute-URL 401 recovery lives in _toolFetch (tools/020) via
    // Platform.refreshTokenAfter401 — NOT here, because the background probes
    // (snFetchUserName/Roles, heartbeat) also use this global fetch and must SEE
    // the 401 (a retry would mask a dead token and could recurse).
    function _knownInstanceOrigin(u) {
        var o; try { o = new URL(u).origin; } catch (e) { return ''; }
        if (o === Platform.instanceUrl) return o;
        for (var i = 0; i < (Platform.instances || []).length; i++) { if (Platform.instances[i].url === o) return o; }
        return '';
    }
    function _hdrToken(h) {
        if (!h) return '';
        if (typeof h.get === 'function') return h.get('X-UserToken') || '';
        return h['X-UserToken'] || h['x-usertoken'] || '';
    }
    // extra.deadlineAt: the tool call's 5s connection budget (tools/020
    // ctx.connDeadlineAt) — bounds the 401 re-probe / login wait, never the
    // request itself (that stays on the tool's timeout_ms signal).
    function _absoluteWith401Retry(url, opts, extra) {
        var deadlineAt = (extra && extra.deadlineAt) || 0;
        // Relative URLs keep the shim's own active-instance 401 handling.
        if (typeof url === 'string' && url.charAt(0) === '/') {
            return self.fetch(url, deadlineAt ? Object.assign({}, opts || {}, { _snDeadlineAt: deadlineAt }) : opts);
        }
        var p = _origFetch(url, opts);
        if (typeof url !== 'string' || !opts || (opts.body && typeof opts.body !== 'string')) return p;
        var failed = _hdrToken(opts.headers);
        if (!failed) return p;
        var origin = _knownInstanceOrigin(url);
        if (!origin || typeof Platform.refreshTokenAfter401 !== 'function') return p;
        var sig = opts.signal || null;
        function _abortErr() {
            var r = sig && sig.reason;
            if (r instanceof Error) return r;
            var e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e;
        }
        // Race the (signal-less) tab re-probe against the caller's abort/timeout so
        // a hung probe can't outlive the tool's deadline.
        function _refreshRespectingSignal() {
            var rp = Platform.refreshTokenAfter401(origin, failed);
            // Past the connection budget: stop waiting on the (shared) re-probe
            // and surface the 401 — the probe keeps running for the next call.
            if (deadlineAt) rp = _probeWithDeadline(rp, Math.max(1000, deadlineAt - Date.now())).then(function(v) { return v || ''; });
            if (!sig) return rp;
            if (sig.aborted) return Promise.reject(_abortErr());
            return new Promise(function(resolve, reject) {
                var onAbort = function() { reject(_abortErr()); };
                sig.addEventListener('abort', onAbort, { once: true });
                rp.then(function(v) { sig.removeEventListener('abort', onAbort); resolve(v); },
                        function(e) { sig.removeEventListener('abort', onAbort); reject(e); });
            });
        }
        return p.then(function(res) {
            if (res.status !== 401) return res;
            return _refreshRespectingSignal().then(function(fresh) {
                if (!fresh) return res;
                if (sig && sig.aborted) throw _abortErr();
                var o2 = Object.assign({}, opts);
                var h = opts.headers;
                if (h && typeof h.get === 'function') { h = new Headers(h); h.set('X-UserToken', fresh); }
                else { h = Object.assign({}, h || {}); delete h['x-usertoken']; h['X-UserToken'] = fresh; }
                o2.headers = h;
                if (!o2.credentials) o2.credentials = 'include';
                // A network error on the retry falls back to the original 401, but an
                // abort (timeout / cancel) must propagate so _toolFetch reports it.
                return _origFetch(url, o2).catch(function(e) { if (sig && sig.aborted) throw e; return res; });
            }, function(e) { if (sig && sig.aborted) throw e; return res; });
        });
    }
    // Used by _toolFetch (agent-tool HTTP only) for absolute instance URLs.
    Platform.fetchWithSessionRetry = _absoluteWith401Retry;

    self.fetch = function(url, opts) {
        // Anything that isn't a plain relative path goes straight to native fetch.
        if (typeof url !== 'string' || !url.startsWith('/')) {
            return _origFetch(url, opts);
        }
        if (!Platform.instanceUrl) {
            return Promise.reject(new Error('No ServiceNow instance connected. Open a ServiceNow tab first.'));
        }
        var fullUrl = Platform.instanceUrl + url;
        var mergedOpts = Object.assign({}, opts || {});
        // Connection budget from _absoluteWith401Retry (never sent on the wire).
        var _dl = mergedOpts._snDeadlineAt || 0;
        delete mergedOpts._snDeadlineAt;
        mergedOpts.headers = Object.assign({}, (opts && opts.headers) || {});
        mergedOpts.headers['X-UserToken'] = _workerSessionToken || '';
        mergedOpts.credentials = 'include';

        var _t401 = 0;
        return _origFetch(fullUrl, mergedOpts).then(function(res) {
            if (res.status !== 401) return res;
            _t401 = Date.now();
            // Fast path: a login wait for this instance is already running and
            // THIS token already burned its budget (or was dropped) — fail now
            // instead of stacking another ~5s wait (getRecordVersion + main
            // request, back-to-back calls).
            var _key = Platform.instanceUrl || '';
            var _sent = mergedOpts.headers['X-UserToken'] || '';
            if (_shimLoginWaits[_key] && _key in _shimExpiredTokens
                && (_sent === _shimExpiredTokens[_key] || !_sent)) {
                return _sessionExpiredResponse(res, Platform.instanceUrl);
            }
            // Token stale — probe a fresh one from an open tab and retry once.
            return _freshTokenAfter401(mergedOpts.headers['X-UserToken'], _connLeft()).then(function(freshToken) {
                if (freshToken && freshToken !== mergedOpts.headers['X-UserToken']) {
                    // Sync caches so subsequent calls see the new token.
                    _adoptWorkerToken(freshToken);
                    mergedOpts.headers['X-UserToken'] = freshToken;
                    return _origFetch(fullUrl, mergedOpts).then(function(retryRes) {
                        if (retryRes.status !== 401) return retryRes;
                        // Refresh worked but the token is also unauthorized — fall
                        // through to the open-for-login flow.
                        return _openForLoginAndRetry(retryRes, freshToken);
                    });
                }
                // No fresh token available (no SN tab open, or same token came back).
                // Mirror the page bridge: open SN for re-auth and retry once.
                return _openForLoginAndRetry(res, mergedOpts.headers['X-UserToken']);
            });
        });

        // Remaining connection budget for the token re-probe (min 1s), or
        // undefined (default 5s probe cap) when the caller passed none.
        function _connLeft() { return _dl ? Math.max(1000, _dl - Date.now()) : undefined; }
        function _openForLoginAndRetry(failedRes, oldToken) {
            if (typeof self.snOpenForLoginAndWait !== 'function') return failedRes;
            var instanceUrl = Platform.instanceUrl;
            // ONE ~5s budget from the first 401 covers the token re-probe AND the
            // login wait; the login tab keeps loading in the background.
            var _cap = (self && self.__snShimLoginWaitMs) || SN_SHIM_LOGIN_WAIT_MS;
            var _left = Math.max(250, _cap - (_t401 ? Date.now() - _t401 : 0));
            if (_dl) _left = Math.max(250, Math.min(_left, _dl - Date.now()));
            return _awaitLoginBounded(instanceUrl, oldToken, mergedOpts.signal, _left).then(function(out) {
                if (out.timedOut) {
                    // Still 401 after the whole budget: the token is dead. Drop it
                    // so later calls stop sending it (the login wait keeps going and
                    // adopts the fresh token when the user signs in).
                    _dropWorkerToken(oldToken);
                    _shimExpiredTokens[instanceUrl || ''] = oldToken || '';
                    return _sessionExpiredResponse(failedRes, instanceUrl);
                }
                var loginToken = out.token;
                if (!loginToken || loginToken === oldToken) return failedRes;
                _adoptWorkerToken(loginToken);
                mergedOpts.headers['X-UserToken'] = loginToken;
                return _origFetch(fullUrl, mergedOpts);
            });
        }
    };
})();

// --- Shim login wait: shared + bounded --------------------------------------
// At v1.1.43 every relative SN call that hit a persistent 401 awaited its OWN
// snOpenForLoginAndWait (reload/focus the SN tab, then poll up to 4 min). The
// tool's hard timeout could not abort it (the fetch had already resolved with
// 401), so the call — its pending handle and the per-instance sys.scripts.do
// queue behind it — stayed blocked, and every new call reloaded the user's
// login tab again. Now: ONE detached login wait per instance that later 401s
// join, and each caller waits at most SN_SHIM_LOGIN_WAIT_MS (or until its
// abort signal fires) before failing fast with a "session expired" 401.
// 5s total from the 401 (maintainer: "an API call should not take longer");
// the detached login wait keeps polling so the NEXT call picks up the token.
var SN_SHIM_LOGIN_WAIT_MS = 5000;
var _shimLoginWaits = {};
// instanceUrl -> the token whose bounded login wait already timed out while
// _shimLoginWaits[instanceUrl] is still running (shim fast path). Cleared
// when the login wait settles.
var _shimExpiredTokens = {};
function _sharedLoginWait(instanceUrl, oldToken) {
    var key = instanceUrl || '';
    if (_shimLoginWaits[key]) return _shimLoginWaits[key];
    var p = Promise.resolve().then(function() {
        return self.snOpenForLoginAndWait(oldToken);
    }).then(function(t) { return t || null; }, function() { return null; }).then(function(t) {
        // Login finished after every caller gave up: adopt the token so the
        // NEXT call works without another probe. Guarded — tests evaluate
        // this section without the worker-token helpers.
        try {
            if (t && t !== oldToken && typeof _adoptWorkerToken === 'function'
                && typeof Platform !== 'undefined' && Platform && Platform.instanceUrl === instanceUrl) {
                _adoptWorkerToken(t);
            }
        } catch (e) {}
        delete _shimExpiredTokens[key];
        return t;
    });
    _shimLoginWaits[key] = p;
    // Hard backstop so a wait that never settles can't pin the entry forever.
    var backstop = setTimeout(function() { if (_shimLoginWaits[key] === p) delete _shimLoginWaits[key]; }, 5 * 60 * 1000);
    p.then(function() { clearTimeout(backstop); if (_shimLoginWaits[key] === p) delete _shimLoginWaits[key]; });
    return p;
}
// Resolves { token } when the shared login wait yields within the cap, or
// { timedOut: true } after the cap; rejects with an AbortError if `signal`
// aborts first (tool hard timeout / cancel).
function _awaitLoginBounded(instanceUrl, oldToken, signal, capMs) {
    var cap = capMs || (self && self.__snShimLoginWaitMs) || SN_SHIM_LOGIN_WAIT_MS;
    return new Promise(function(resolve, reject) {
        var done = false, timer = null, onAbort = null;
        function finish(fn, v) {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (e) {} }
            fn(v);
        }
        if (signal) {
            onAbort = function() {
                var r = signal.reason;
                var err = (r instanceof Error) ? r : new Error('The operation was aborted.');
                if (!(r instanceof Error)) err.name = 'AbortError';
                finish(reject, err);
            };
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        timer = setTimeout(function() { finish(resolve, { timedOut: true }); }, cap);
        _sharedLoginWait(instanceUrl, oldToken).then(function(t) { finish(resolve, { token: t }); });
    });
}
function _sessionExpiredResponse(failedRes, instanceUrl) {
    var msg = 'ServiceNow session expired for ' + (instanceUrl || 'the active instance') +
        ' (HTTP 401) — not connected. Log in to ' + (instanceUrl || 'the instance') + ' (a login tab was opened/reloaded for it), then retry.';
    if (typeof Response !== 'function') return failedRes;
    try {
        return new Response(JSON.stringify({ error: { message: msg, detail: 'session_expired' }, status: 'failure' }), {
            status: 401, statusText: 'Unauthorized', headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { return failedRes; }
}
