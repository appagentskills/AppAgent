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
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/AppAgentIconStarOnly_128.png',
            title: title,
            message: message
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
Platform.callOffscreenHelper = function(type, payload, timeoutMs) {
    if (typeof self.callOffscreenHelper !== 'function') {
        return Promise.reject(new Error('Offscreen helper bridge not initialized'));
    }
    return self.callOffscreenHelper(type, payload, timeoutMs);
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

Platform.refreshInstances = async function() {
    if (typeof self.snGetInstancesDetailed !== 'function') return Platform.instances;
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
            tabs: inst.tabs || [],
            isActive: inst.url === Platform.instanceUrl
        };
    });
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
Platform.getTokenForInstance = async function(instanceUrl) {
    if (instanceUrl === Platform.instanceUrl && _workerSessionToken) {
        return _workerSessionToken;
    }
    for (var i = 0; i < Platform.instances.length; i++) {
        if (Platform.instances[i].url === instanceUrl && Platform.instances[i].token) {
            return Platform.instances[i].token;
        }
    }
    if (typeof self.snGetTokenForInstance !== 'function') return '';
    var probed = await self.snGetTokenForInstance(instanceUrl);
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
Platform.getTabForInstance = function(instanceUrl) {
    for (var i = 0; i < Platform.instances.length; i++) {
        if (Platform.instances[i].url === instanceUrl && Platform.instances[i].tabs.length > 0) {
            return Platform.instances[i].tabs[0].id;
        }
    }
    return null;
};

// Refresh the instance cache after the initial sessionToken / instanceUrl load,
// so the first tool call after SW boot sees a populated registry. Subsequent
// refreshes happen on-demand via list_instances({refresh:true}).
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
(function installSnFetchShim() {
    var _origFetch = self.fetch.bind(self);

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
        mergedOpts.headers = Object.assign({}, (opts && opts.headers) || {});
        mergedOpts.headers['X-UserToken'] = _workerSessionToken || '';
        mergedOpts.credentials = 'include';

        return _origFetch(fullUrl, mergedOpts).then(function(res) {
            if (res.status !== 401) return res;
            // Token stale — probe a fresh one from an open tab and retry once.
            return Platform.getTokenForInstance(Platform.instanceUrl).then(function(freshToken) {
                if (freshToken && freshToken !== mergedOpts.headers['X-UserToken']) {
                    // Sync caches so subsequent calls see the new token.
                    _workerSessionToken = freshToken;
                    chrome.storage.local.set({ sessionToken: freshToken });
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

        function _openForLoginAndRetry(failedRes, oldToken) {
            if (typeof self.snOpenForLoginAndWait !== 'function') return failedRes;
            return self.snOpenForLoginAndWait(oldToken).then(function(loginToken) {
                if (!loginToken || loginToken === oldToken) return failedRes;
                _workerSessionToken = loginToken;
                chrome.storage.local.set({ sessionToken: loginToken });
                mergedOpts.headers['X-UserToken'] = loginToken;
                return _origFetch(fullUrl, mergedOpts);
            });
        }
    };
})();
