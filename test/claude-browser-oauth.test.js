// Run: run_tests { pattern: 'claude-browser-oauth' } (js_eval sandbox; no Node). No real login, cookies or network.
'use strict';

async function runClaudeBrowserOAuthTests(source, cryptoImpl) {
    var checks = [];
    function check(name, ok) { if (!ok) throw new Error('FAIL: ' + name); checks.push(name); }
    function region(start, end) {
        var a = source.indexOf(start);
        var b = source.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Missing fixture region: ' + start + ' .. ' + end);
        return source.slice(a, b);
    }

    var code = region('var CLAUDE_OAUTH = {', "    if (message.type === 'claude-oauth-usage') {") + '\n});\n';
    var local = {}, session = {}, tabs = new Map(), nextTab = 1, handlers = {}, broadcasts = [], requests = [];
    var fetchGate = null;
    var fetchOverride = null;
    var cookieSessionKey = null;
    var tokenReply = { access_token: 'claude-fixture-access', refresh_token: 'claude-fixture-refresh', expires_in: 28800 };

    function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

    function area(data) {
        return {
            get: function(keys, callback) {
                var result = {};
                var list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
                list.forEach(function(k) { if (k in data) result[k] = clone(data[k]); });
                if (callback) callback(result);
                return Promise.resolve(result);
            },
            set: function(values, callback) {
                Object.assign(data, clone(values));
                if (callback) callback();
                return Promise.resolve();
            },
            remove: function(keys, callback) {
                (Array.isArray(keys) ? keys : [keys]).forEach(function(k) { delete data[k]; });
                if (callback) callback();
                return Promise.resolve();
            }
        };
    }

    function event(name) {
        return { addListener: function(fn) { (handlers[name] || (handlers[name] = [])).push(fn); } };
    }

    var chrome = {
        storage: { local: area(local), session: area(session) },
        cookies: {
            get: function(details, callback) {
                var val = details && details.name === 'sessionKey' && cookieSessionKey ? { value: cookieSessionKey } : null;
                if (callback) callback(val);
                return Promise.resolve(val);
            },
            getAll: function(details, callback) {
                var arr = cookieSessionKey ? [{ name: 'sessionKey', value: cookieSessionKey }] : [];
                if (callback) callback(arr);
                return Promise.resolve(arr);
            }
        },
        runtime: {
            id: 'fixture-extension',
            lastError: null,
            getURL: function(p) { return 'chrome-extension://fixture-extension/' + p; },
            onMessage: event('message'),
            sendMessage: function(message) {
                broadcasts.push(clone(message));
                return Promise.resolve();
            }
        },
        tabs: {
            onUpdated: event('updated'),
            onRemoved: event('removed'),
            create: async function(options) {
                var tab = { id: nextTab++, url: options.url, active: !!options.active };
                tabs.set(tab.id, tab);
                return clone(tab);
            },
            update: async function(id, options) {
                if (!tabs.has(id)) throw new Error('Missing tab ' + id);
                Object.assign(tabs.get(id), options);
                return clone(tabs.get(id));
            },
            remove: async function(id) {
                if (!tabs.has(id)) return;
                tabs.delete(id);
                (handlers.removed || []).forEach(function(fn) { fn(id); });
            }
        }
    };

    async function fetchStub(url, options) {
        requests.push({ url: url, options: options || {}, body: options && options.body, signal: options && options.signal });
        if (fetchGate) await fetchGate;
        if (fetchOverride) return fetchOverride(url, options);
        return {
            ok: true,
            status: 200,
            json: async function() { return clone(tokenReply); },
            text: async function() { return JSON.stringify(tokenReply); }
        };
    }

    function boot() {
        handlers.message = [];
        handlers.updated = [];
        handlers.removed = [];
        var fn = new Function(
            'chrome', 'fetch', 'crypto', 'self', 'AbortController',
            code + '\nreturn {' +
            'CLAUDE_OAUTH: CLAUDE_OAUTH,' +
            'startBrowser: startClaudeBrowserOAuth,' +
            'cancelBrowser: _claudeCancelPendingBrowserOAuth,' +
            'browserStatus: _claudeBrowserOAuthStatus,' +
            'handleCallback: _claudeHandleBrowserCallback,' +
            'startHeadless: startClaudeOAuth,' +
            'flushStorage: function() { return claudeBrowserOAuthStorageQueue; },' +
            'epoch: function() { return claudeOAuthEpoch; }' +
            '};'
        );
        return fn(chrome, fetchStub, cryptoImpl, {}, AbortController);
    }

    var api = boot();
    var sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('app.html') };

    function message(payload, from) {
        return new Promise(function(resolve, reject) {
            var replied = false;
            var accepted = handlers.message.some(function(fn) {
                return fn(payload, from || sender, function(value) {
                    replied = true;
                    resolve(value);
                }) === true;
            });
            if (!accepted && !replied) reject(new Error('Message not handled: ' + payload.type));
        });
    }

    function pending() { return session.claudeBrowserOAuthPending; }

    function callbackUrl(p, extra) {
        return 'https://platform.claude.com/oauth/code/callback?code=' + encodeURIComponent('fixture-auth-code') +
            '&state=' + encodeURIComponent(p.state) + (extra ? '&' + extra : '');
    }

    // 1. Exact authorize URL & query params + PKCE S256
    var started = await message({ type: 'claude-oauth-login' });
    var p = clone(pending());
    check('Default claude-oauth-login starts browser OAuth and returns pending without secrets',
        started.success === true && started.pending === true && started.method === 'browser' &&
        typeof started.expiresAt === 'number' && !JSON.stringify(started).includes(p.state) && !JSON.stringify(started).includes(p.verifier));

    var authUrl = new URL(tabs.get(p.tabId).url);
    check('Exact Claude authorize URL and query params',
        authUrl.origin === 'https://claude.ai' &&
        authUrl.pathname === '/oauth/authorize' &&
        authUrl.searchParams.get('code') === 'true' &&
        authUrl.searchParams.get('client_id') === '9d1c250a-e61b-44d9-88ed-5944d1962f5e' &&
        authUrl.searchParams.get('response_type') === 'code' &&
        authUrl.searchParams.get('redirect_uri') === 'https://platform.claude.com/oauth/code/callback' &&
        authUrl.searchParams.get('scope') === 'user:profile user:inference user:sessions:claude_code user:mcp_servers' &&
        authUrl.searchParams.get('code_challenge_method') === 'S256' &&
        authUrl.searchParams.get('state') === p.state);

    var hash = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(p.verifier));
    var expectedChallenge = btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    check('PKCE S256 code_challenge matches verifier', authUrl.searchParams.get('code_challenge') === expectedChallenge);

    var statusWhilePending = await message({ type: 'claude-oauth-status' });
    check('claude-oauth-status reports pending browser flow',
        statusWhilePending.loggedIn === false && statusWhilePending.pending === true && statusWhilePending.method === 'browser');

    // 2. State mismatch rejection (both callback URL and manual paste)
    var reqBeforeMismatch = requests.length;
    var badUrlRes = await api.handleCallback(p.tabId, callbackUrl(p).replace(p.state, 'wrong-state'));
    check('Callback URL with mismatched state is rejected without token exchange',
        badUrlRes.ok === false && badUrlRes.matched === false && requests.length === reqBeforeMismatch && !!pending());

    var badManualRes = await message({ type: 'claude-oauth-browser-complete', code: 'fixture-auth-code#wrong-state' });
    check('Manual CODE#STATE with mismatched state is rejected',
        !!badManualRes.error && requests.length === reqBeforeMismatch && !!pending());

    // 3. SW restart recovery (pending state persisted in chrome.storage.session)
    api = boot();
    var recoveredStatus = await message({ type: 'claude-oauth-browser-status' });
    check('Pending state survives SW restart via chrome.storage.session',
        recoveredStatus.pending === true && recoveredStatus.method === 'browser' && recoveredStatus.expiresAt === p.expiresAt);

    // 4. Callback URL capture, state verification, tab close, token exchange with PKCE verifier, saveOAuthCreds
    var capRes = await api.handleCallback(p.tabId, callbackUrl(p));
    check('Callback URL capture succeeds, closes tab, and saves OAuth creds',
        capRes.ok === true && !tabs.has(p.tabId) && !pending() &&
        local.claudeOAuth && local.claudeOAuth.accessToken === 'claude-fixture-access' &&
        local.claudeOAuth.refreshToken === 'claude-fixture-refresh');

    var tokReq = requests[requests.length - 1];
    var tokBody = JSON.parse(tokReq.body);
    check('Token exchange hits api.anthropic.com/v1/oauth/token with PKCE code_verifier',
        tokReq.url === 'https://api.anthropic.com/v1/oauth/token' &&
        tokBody.grant_type === 'authorization_code' &&
        tokBody.client_id === '9d1c250a-e61b-44d9-88ed-5944d1962f5e' &&
        tokBody.code === 'fixture-auth-code' &&
        tokBody.redirect_uri === 'https://platform.claude.com/oauth/code/callback' &&
        tokBody.code_verifier === p.verifier &&
        tokBody.state === p.state);

    // 5. Manual CODE#STATE paste completion via claude-oauth-browser-complete
    delete local.claudeOAuth;
    await message({ type: 'claude-oauth-browser-start' });
    p = clone(pending());
    var manualRes = await message({ type: 'claude-oauth-browser-complete', code: 'manual-code-123#' + p.state });
    var manualTokBody = JSON.parse(requests[requests.length - 1].body);
    check('Manual CODE#STATE paste completes exchange and closes tab',
        manualRes.success === true && manualTokBody.code === 'manual-code-123' &&
        manualTokBody.code_verifier === p.verifier && manualTokBody.state === p.state &&
        !tabs.has(p.tabId) && !pending() && local.claudeOAuth.accessToken === 'claude-fixture-access');

    // 6. Tab-close cancellation & explicit claude-oauth-browser-cancel
    delete local.claudeOAuth;
    await message({ type: 'claude-oauth-login' });
    p = clone(pending());
    var bcBeforeClose = broadcasts.length;
    await chrome.tabs.remove(p.tabId);
    await api.flushStorage();
    check('Closing auth tab clears pending state and broadcasts error',
        !pending() && broadcasts.slice(bcBeforeClose).some(function(m) {
            return m.type === 'claude-oauth-browser-status' && m.pending === false && /closed/i.test(m.error || '');
        }));

    await message({ type: 'claude-oauth-login' });
    p = clone(pending());
    var cancelRes = await message({ type: 'claude-oauth-browser-cancel' });
    check('Explicit claude-oauth-browser-cancel clears pending state and closes tab',
        cancelRes.success === true && !pending() && !tabs.has(p.tabId));

    // 7. Logout epoch fence (cancels pending flow & discards in-flight exchange)
    delete local.claudeOAuth;
    await message({ type: 'claude-oauth-login' });
    p = clone(pending());
    var reqBeforeExchange = requests.length;
    var releaseFetch;
    fetchGate = new Promise(function(r) { releaseFetch = r; });
    var inFlightExchange = api.handleCallback(p.tabId, callbackUrl(p));
    for (var i = 0; i < 30 && requests.length === reqBeforeExchange; i++) await Promise.resolve();
    check('Logout fence fixture reached token exchange', requests.length === reqBeforeExchange + 1);
    var epochBefore = api.epoch();
    await message({ type: 'claude-oauth-logout' });
    releaseFetch();
    fetchGate = null;
    var fencedRes = await inFlightExchange;
    check('Logout bumps epoch, aborts in-flight exchange, and never persists stale creds',
        api.epoch() > epochBefore && fencedRes.ok === false &&
        requests[requests.length - 1].signal.aborted === true &&
        !local.claudeOAuth && !pending());

    // 8. Headless missing_client_attestation error & silent auto-login never opens a browser tab
    delete local.claudeOAuth;
    delete local.claudeOAuthSuppressAutoLogin;
    delete local.claudeAutoLoginFailedFor;
    cookieSessionKey = 'sk-ant-sid01-fixture';
    fetchOverride = function(url) {
        if (url.indexOf('/api/organizations') >= 0) {
            return {
                ok: true,
                status: 200,
                json: async function() { return [{ uuid: 'org-fixture-1', capabilities: ['chat'] }]; },
                text: async function() { return '[{"uuid":"org-fixture-1"}]'; }
            };
        }
        if (url.indexOf('/v1/oauth/org-fixture-1/authorize') >= 0) {
            return {
                ok: false,
                status: 403,
                text: async function() { return '{"error":{"type":"permission_error","message":"missing_client_attestation"}}'; }
            };
        }
        return { ok: false, status: 500, text: async function() { return 'unexpected'; } };
    };

    var headlessErr = null;
    try {
        await api.startHeadless();
    } catch (e) {
        headlessErr = e;
    }
    check('Headless missing_client_attestation throws clean error with claudeInteractiveRequired',
        !!headlessErr && headlessErr.claudeInteractiveRequired === true && /missing_client_attestation/.test(headlessErr.message));

    var tabsBeforeAuto = nextTab;
    var autoStatus = await message({ type: 'claude-oauth-status' });
    check('Silent auto-login on missing_client_attestation returns loggedIn:false and never opens a browser tab',
        autoStatus.loggedIn === false && !autoStatus.pending && nextTab === tabsBeforeAuto &&
        local.claudeAutoLoginFailedFor === cookieSessionKey);

    fetchOverride = null;
    cookieSessionKey = null;

    return checks;
}

// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ['src/platform/extension/background.js'];
await registerRunner('claude-browser-oauth', async function() {
    return runClaudeBrowserOAuthTests(await loadFile(PATHS[0]), crypto);
});
