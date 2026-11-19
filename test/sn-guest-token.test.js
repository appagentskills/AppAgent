// Guest g_ck (login / SSO / MFA / password-change pages) is never a session.
// Evaluates the REAL background.js helpers (extracted by name) against fake
// tabs / fetch / chrome.storage: onTabReady must not store a guest token or
// auto-close the login tab on it, the login poll must not hand it back, and
// handleRefreshToken must not persist it.

var EX = await runFile('test/extract.js', { i18n: false });
function extractFn(src, name) {
    var f = EX.findFunction(src, name);
    if (!f) throw new Error('function not found: ' + name);
    if (!(f.end > f.start)) throw new Error('unbalanced: ' + name);
    return src.slice(f.start, f.end);
}

var FNS = ['snTimeoutMs', 'snWithTimeout', 'snInjectBounded', 'snFetchWithTimeout', 'snLoginProbeState', 'snLoginLooksSignedIn', 'probeTab',
    'snProbeTabTokenUser', 'snFetchUserName', 'snStrictTokenOk', 'snTokenAccepted', 'snCollectTabTokens', 'snPickTabToken', 'snRememberInstanceToken',
    'snUpdateInstanceTokens', 'snInjectTabScripts', 'snTabsForOrigin', 'snNotConnectedError', 'snGetTokenForInstance',
    'snGetTokenForInstanceUnbounded', 'snProbeNegForget', 'onTabReady', 'snOpenForLoginAndWait', 'handleRefreshToken'];

var O = 'https://dev1.service-now.com';

// world: { tabs: [{id, origin, token, path, hasLoginForm, userName}], valid: [tokens], instanceUrl }
async function build(world) {
    var src = await loadFile('src/platform/extension/background.js');
    var store = { instanceTokens: world.cache || {}, instanceUrl: world.instanceUrl };
    var log = { sets: [], removed: [], fetches: [] };
    function tab(id) { return world.tabs.filter(function(t) { return t.id === id; })[0]; }
    var chrome = {
        tabs: {
            query: async function() { return world.tabs.map(function(t) { return { id: t.id, url: t.origin + (t.path || '/'), title: 't' }; }); },
            get: async function(id) { var t = tab(id); if (!t) throw new Error('No tab'); return { id: id, url: t.origin + (t.path || '/'), title: 't', windowId: 1 }; },
            remove: async function(id) { log.removed.push(id); world.tabs = world.tabs.filter(function(t) { return t.id !== id; }); },
            update: async function() {}, reload: async function() {},
            create: async function(o) { var t = { id: 500, origin: O, path: '/login.do', hasLoginForm: true, token: 'guest' }; world.tabs.push(t); return { id: 500 }; }
        },
        windows: { update: function() {} },
        scripting: { executeScript: async function(o) {
            var t = tab(o.target.tabId);
            if (!t) throw new Error('No tab with id');
            if (o.files) return [{ result: true }];
            if (world.onProbe) world.onProbe(t);
            return [{ result: { token: t.token || '', userName: t.userName || '', origin: t.origin, path: t.path || '/',
                hasLoginForm: !!t.hasLoginForm, mfa: !!t.mfa, pwChange: !!t.pwChange } }];
        } },
        storage: { local: {
            get: function(k, cb) {
                var o = {}; (Array.isArray(k) ? k : [k]).forEach(function(key) { o[key] = store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key])); });
                if (cb) setTimeout(function() { cb(o); }, 0); return Promise.resolve(o);
            },
            set: function(o) { log.sets.push(JSON.parse(JSON.stringify(o))); Object.assign(store, JSON.parse(JSON.stringify(o))); return Promise.resolve(); }
        } }
    };
    var fetch = async function(url, opts) {
        var tok = opts.headers['X-UserToken'];
        log.fetches.push(tok);
        var ok = world.valid.indexOf(tok) !== -1;
        return { ok: ok, status: ok ? 200 : 401, json: async function() { return { result: [{ user_name: 'admin' }] }; } };
    };
    var getSnTabList = async function() { return world.tabs.map(function(t) { return { id: t.id, origin: t.origin, url: t.origin + '/', title: 't' }; }); };
    var body = 'var _snInstanceTokensQueue = Promise.resolve();\nvar snTabs = new Map();\nvar snDomains = new Set();\nvar loginTabId = null;\n' +
        'var SN_TOKEN_LOOKUP_DEADLINE_MS = 5000;\nvar _snProbeNegCache = new Map();\nvar _snTokenCheckCache = new Map();\nvar SN_TOKEN_CHECK_TTL_MS = 30000;\n' +
        'function injectInterceptors() { return Promise.resolve(); }\nfunction updateHeaderRules() {}\n' +
        FNS.map(function(n) { return extractFn(src, n); }).join('\n') +
        '\nreturn { ready: onTabReady, poll: snOpenForLoginAndWait, refresh: handleRefreshToken, forInstance: snGetTokenForInstance, signedIn: snLoginLooksSignedIn,' +
        ' accepted: snTokenAccepted, setLoginTab: function(id) { loginTabId = id; }, loginTab: function() { return loginTabId; }, tracked: function(id) { return snTabs.has(id); } };';
    var api = new Function('chrome', 'fetch', 'getSnTabList', 'self', body)(chrome, fetch, getSnTabList, { __snLoginPollMs: 1 });
    api.store = store; api.log = log;
    return api;
}

function settle(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

describe('guest g_ck is never adopted as a session', function() {
    test('snLoginLooksSignedIn rejects login / SSO / MFA / password pages', async function() {
        var a = await build({ tabs: [], valid: [] });
        var ok = { token: 't', path: '/now/nav/ui/home' };
        assert.strictEqual(a.signedIn(ok), true);
        ['/login.do', '/login_with_sso.do', '/login_redirect.do', '/saml_redirector.do', '/sso_login.do', '/logout.do', '/validate_multifactor_auth_code.do', '/change_password.do']
            .forEach(function(p) { assert.strictEqual(a.signedIn({ token: 't', path: p }), false, p); });
        assert.strictEqual(a.signedIn({ token: 't', path: '/home', hasLoginForm: true }), false);
        assert.strictEqual(a.signedIn({ token: 't', path: '/home', mfa: true }), false);
        assert.strictEqual(a.signedIn({ token: '', path: '/home' }), false);
    }, { tags: ['unit'], timeout: 5000 });

    test('onTabReady on the login page: tracked, but no token stored and login tab kept open', async function() {
        var a = await build({ instanceUrl: O, tabs: [{ id: 5, origin: O, token: 'guest', path: '/login.do', hasLoginForm: true }], valid: [] });
        a.setLoginTab(5);
        await a.ready(5);
        await settle(5);
        assert.strictEqual(a.tracked(5), true);
        assert.strictEqual(a.store.sessionToken, undefined);
        assert.strictEqual(a.store.instanceTokens[O], undefined);
        assert.deepStrictEqual(a.log.removed, []);
        assert.strictEqual(a.loginTab(), 5);
    }, { tags: ['unit'], timeout: 5000 });

    test('onTabReady on a non-login page whose token the instance 401s (anonymous portal): not stored, not closed', async function() {
        var a = await build({ instanceUrl: O, tabs: [{ id: 6, origin: O, token: 'anon', path: '/sp' }], valid: [] });
        a.setLoginTab(6);
        await a.ready(6);
        await settle(5);
        assert.strictEqual(a.store.sessionToken, undefined);
        assert.strictEqual(a.store.instanceTokens[O], undefined);
        assert.deepStrictEqual(a.log.removed, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('onTabReady on a signed-in page with an accepted token: stored and login tab closed', async function() {
        var a = await build({ instanceUrl: O, tabs: [{ id: 7, origin: O, token: 'live', path: '/now/nav/ui/home', userName: 'admin' }], valid: ['live'] });
        a.setLoginTab(7);
        await a.ready(7);
        await settle(5);
        assert.strictEqual(a.store.sessionToken, 'live');
        assert.strictEqual(a.store.instanceTokens[O].token, 'live');
        assert.deepStrictEqual(a.log.removed, [7]);
        assert.strictEqual(a.loginTab(), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('login poll ignores the guest token and returns only the accepted post-login token', async function() {
        var n = 0;
        var w = { instanceUrl: O, tabs: [{ id: 1, origin: O, token: 'guest', path: '/login.do', hasLoginForm: true }], valid: ['fresh'],
            onProbe: function(t) { if (++n === 6) { t.token = 'fresh'; t.path = '/now/nav/ui/home'; t.hasLoginForm = false; } } };
        var a = await build(w);
        await a.store;
        var tok = await a.poll('old');
        assert.strictEqual(tok, 'fresh');
    }, { tags: ['unit'], timeout: 8000 });

    test('login poll never returns a 401 token from a non-login page (gives up instead)', async function() {
        var a = await build({ instanceUrl: O, tabs: [{ id: 1, origin: O, token: 'anon', path: '/sp' }], valid: [] });
        var tok = await a.poll('old');
        assert.strictEqual(tok, null);
    }, { tags: ['unit'], timeout: 15000 });

    test('handleRefreshToken: only a login-page tab -> error, nothing persisted', async function() {
        var a = await build({ instanceUrl: O, tabs: [{ id: 1, origin: O, token: 'guest', path: '/login.do', hasLoginForm: true }], valid: ['guest'] });
        var resp = await new Promise(function(r) { a.refresh(r, 'dead'); });
        assert.ok(resp.error && !resp.token, JSON.stringify(resp));
        assert.strictEqual(a.store.sessionToken, undefined);
    }, { tags: ['unit'], timeout: 5000 });

    test('handleRefreshToken: other-instance tab with a 401 token -> not persisted', async function() {
        var a = await build({ instanceUrl: O, tabs: [{ id: 2, origin: 'https://other.service-now.com', token: 'x', path: '/home' }], valid: [] });
        var resp = await new Promise(function(r) { a.refresh(r, ''); });
        assert.ok(resp.error && !resp.token, JSON.stringify(resp));
        assert.strictEqual(a.store.sessionToken, undefined);
    }, { tags: ['unit'], timeout: 5000 });

    test('snTokenAccepted: lenient accepts indeterminate, strict needs 2xx/403; 401 always rejects', async function() {
        var a = await build({ tabs: [], valid: ['ok'] });
        assert.strictEqual(await a.accepted(O, 'ok', { strict: true }), true);
        assert.strictEqual(await a.accepted(O, 'bad'), false);
        assert.strictEqual(await a.accepted(O, ''), false);
        var before = a.log.fetches.length;
        await a.accepted(O, 'ok');
        assert.strictEqual(a.log.fetches.length, before, 'cached');
    }, { tags: ['unit'], timeout: 5000 });
});
