// Panel validateToken (platform-bridge.js): a hibernating PDI answers every URL,
// touch-session included, with HTTP 200 + its "Instance Hibernating page" HTML.
// A non-401 like that must NOT render the header pill as Connected.
// Real source extracted by name, fake fetch / chrome.

var EX = await runFile('test/extract.js', { i18n: false });
function extractFn(src, name) {
    var f = EX.findFunction(src, name);
    if (!f) throw new Error('function not found: ' + name);
    if (!(f.end > f.start)) throw new Error('unbalanced: ' + name);
    return src.slice(f.start, f.end);
}
function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

var O = 'https://dev428560.service-now.com';
var HIB_HTML = '<html><head><meta HTTP-EQUIV="refresh" content="5;https://developer.servicenow.com/dev.do#!/home?wu=true"><title>Instance Hibernating page</title></head><body>Your instance is hibernating</body></html>';

function resp(o) {
    var hdr = o.headers || {};
    return {
        status: o.status || 200, ok: (o.status || 200) < 300, redirected: !!o.redirected, url: o.url || (O + '/api/now/uisession/touch-session'),
        headers: { get: function(k) { return hdr[String(k).toLowerCase()] || null; } },
        text: function() { return Promise.resolve(o.body || ''); }
    };
}

async function buildValidate(response, initial) {
    var src = await loadFile('src/platform/extension/platform-bridge.js');
    var w = { sessionToken: 'stale' };
    var chrome = { runtime: { lastError: null, sendMessage: function() {} }, storage: { local: { set: function() {} } } };
    var cur = { response: response };
    var origFetch = { call: function() { return Promise.resolve(cur.response); } };
    var Platform = { instanceUrl: O, instances: [] };
    var body = 'var _snStatusState = ' + JSON.stringify(initial || 'unknown') + ';\nvar _snActiveDead = null;\n' + extractFn(src, '_sendMessageBounded') + '\n' + extractFn(src, '_adoptRecoveredToken') + '\n' +
        extractFn(src, '_snIsHtmlResponse') + '\n' + extractFn(src, '_snResponseIsDeadInstance') + '\n' + extractFn(src, 'validateToken') + '\n' + extractFn(src, '_reconcileActiveToken') +
        '\nreturn { run: validateToken, state: function() { return _snStatusState; }, dead: _snResponseIsDeadInstance, reconcile: _reconcileActiveToken, marker: function() { return _snActiveDead; } };';
    var api = new Function('window', 'chrome', 'Platform', '_origFetch', 'updateSnStatus', '_normUrl', body)(w, chrome, Platform, origFetch, function() {},
        function(u) { return String(u || '').replace(/\/+$/, ''); });
    api.w = w; api.Platform = Platform; api.setResponse = function(r) { cur.response = r; };
    return api;
}
function hibRes() { return resp({ headers: { 'content-type': 'text/html;charset=UTF-8' }, body: HIB_HTML }); }
function jsonRes() { return resp({ headers: { 'content-type': 'application/json' } }); }

describe('hibernating instance is never shown connected', function() {
    test('touch-session 200 + hibernation HTML: disconnected (even if previously connected)', async function() {
        var a = await buildValidate(resp({ headers: { 'content-type': 'text/html;charset=UTF-8' }, body: HIB_HTML }), 'connected');
        a.run(); await wait(20);
        assert.strictEqual(a.state(), 'disconnected');
    }, { tags: ['unit'], timeout: 3000 });

    test('off-instance redirect (developer.servicenow.com): disconnected', async function() {
        var a = await buildValidate(resp({ redirected: true, url: 'https://developer.servicenow.com/dev.do', headers: { 'content-type': 'text/html' }, body: '' }));
        a.run(); await wait(20);
        assert.strictEqual(a.state(), 'disconnected');
    }, { tags: ['unit'], timeout: 3000 });

    test('genuine REST answer (JSON or no content-type): connected, body not read', async function() {
        var read = 0;
        var r = resp({ headers: { 'content-type': 'application/json' } });
        r.text = function() { read++; return Promise.resolve(''); };
        var a = await buildValidate(r);
        a.run(); await wait(20);
        assert.strictEqual(a.state(), 'connected');
        assert.strictEqual(read, 0, 'JSON body is not read');
        var b = await buildValidate({ status: 200 });   // legacy fake: no headers at all
        b.run(); await wait(20);
        assert.strictEqual(b.state(), 'connected');
    }, { tags: ['unit'], timeout: 3000 });

    test('any HTML 200 (not only hibernation) is disconnected; unreadable body is disconnected too', async function() {
        var a = await buildValidate(resp({ headers: { 'content-type': 'text/html' }, body: '<html><title>Something</title></html>' }));
        a.run(); await wait(20);
        assert.strictEqual(a.state(), 'disconnected');
        var r = resp({ headers: { 'content-type': 'text/html' } });
        r.text = function() { return Promise.reject(new Error('aborted')); };
        var b = await buildValidate(r, 'unknown');
        b.run(); await wait(20);
        assert.strictEqual(b.state(), 'disconnected');
        assert.deepStrictEqual(b.marker(), { url: O, token: 'stale' }, 'dead flag latched');
    }, { tags: ['unit'], timeout: 3000 });
});

// Picker rows (_reconcileActiveToken): validateToken keeps window.sessionToken on a
// hibernation answer (no 401), so the reconcile must not re-inject that confirmed-dead
// token into the active entry — else the row renders connected and a click just
// closes the picker instead of opening the instance to sign in.
describe('picker: confirmed-dead active token is not re-injected', function() {
    test('hibernating: active entry keeps token "" and a missing origin is pushed with token ""', async function() {
        var a = await buildValidate(hibRes(), 'connected');
        a.run(); await wait(20);
        assert.strictEqual(a.state(), 'disconnected');
        assert.strictEqual(a.w.sessionToken, 'stale', 'session token deliberately kept');
        assert.deepStrictEqual(a.marker(), { url: O, token: 'stale' });
        var l = a.reconcile([{ url: O + '/', token: '' }]);
        assert.strictEqual(l[0].token, '');
        var m = a.reconcile([]);
        assert.strictEqual(m.length, 1);
        assert.strictEqual(m[0].url, O);
        assert.strictEqual(m[0].token, '');
        assert.strictEqual(m[0].userName, '');
        assert.deepStrictEqual(m[0].roles, []);
    }, { tags: ['unit'], timeout: 3000 });

    test('JSON-connected token is refilled only into an entry with an open tab; tab-less / missing origin get ""', async function() {
        var a = await buildValidate(jsonRes());
        a.run(); await wait(20);
        assert.strictEqual(a.state(), 'connected');
        assert.strictEqual(a.marker(), null);
        var withTab = a.reconcile([{ url: O, token: '', tabs: [{ id: 1 }] }])[0];
        assert.strictEqual(withTab.token, 'stale');
        assert.strictEqual(withTab._injectedToken, true);
        assert.strictEqual(a.reconcile([{ url: O, token: '', tabs: [] }])[0].token, '', 'tab-less entry not injected');
        assert.strictEqual(a.reconcile([])[0].token, '', 'missing origin pushed with empty token');
    }, { tags: ['unit'], timeout: 3000 });

    test('marker clears after a later successful validation of the same token', async function() {
        var a = await buildValidate(hibRes(), 'connected');
        a.run(); await wait(20);
        assert.strictEqual(a.reconcile([{ url: O, token: '', tabs: [{ id: 1 }] }])[0].token, '');
        a.setResponse(jsonRes());
        a.run(); await wait(20);
        assert.strictEqual(a.state(), 'connected');
        assert.strictEqual(a.marker(), null);
        assert.strictEqual(a.reconcile([{ url: O, token: '', tabs: [{ id: 1 }] }])[0].token, 'stale');
    }, { tags: ['unit'], timeout: 3000 });

    test('marker is ignored once the session token changes', async function() {
        var a = await buildValidate(hibRes(), 'connected');
        a.run(); await wait(20);
        a.w.sessionToken = 'fresh';
        assert.strictEqual(a.reconcile([{ url: O, token: '', tabs: [{ id: 1 }] }])[0].token, 'fresh');
        assert.strictEqual(a.reconcile([])[0].token, '', 'missing origin never injected');
    }, { tags: ['unit'], timeout: 3000 });

    test('same token, different active url: token still refilled', async function() {
        var a = await buildValidate(hibRes(), 'connected');
        a.run(); await wait(20);
        var B = 'https://other.service-now.com';
        a.Platform.instanceUrl = B;
        assert.strictEqual(a.reconcile([{ url: B, token: '', tabs: [{ id: 1 }] }])[0].token, 'stale');
        assert.strictEqual(a.reconcile([])[0].token, '', 'missing origin never injected');
    }, { tags: ['unit'], timeout: 3000 });
});

// Background registry + heartbeat (background.js): same rule for the registry
// entries the panel picker rows are built from (snGetInstancesDetailed). list_instances
// does not read this panel registry: it runs in the service-worker Platform stub
// (src/js/worker/010-platform-stub.js) refreshInstances, which starts from the same
// background registry entries and re-injects its held token only for an active
// entry with an open-but-unreadable tab.
var BG_FNS = ['snTimeoutMs', 'snWithTimeout', 'snFetchWithTimeout', 'snIsHtmlResponse', 'snResponseIsDeadInstance',
    'snFetchUserName', 'snFetchUserRoles', 'snResolveInstanceSession'];
async function buildBg(mkRes) {
    var src = await loadFile('src/platform/extension/background.js');
    var fetch = async function(url) {
        var r = mkRes(url);
        if (!r.json) r.json = async function() { return { result: url.indexOf('sys_user_has_role') !== -1 ? [{ 'role.name': 'admin' }] : [{ user_name: 'admin' }] }; };
        return r;
    };
    var body = BG_FNS.map(function(n) { return extractFn(src, n); }).join('\n') + '\nreturn snResolveInstanceSession;';
    return new Function('fetch', 'self', 'snMaintEligible', 'snDetectMaint', body)(fetch, {}, function() { return false; }, async function() { return false; });
}
async function buildBgHeartbeat(mkRes, cache) {
    var src = await loadFile('src/platform/extension/background.js');
    var store = { instanceTokens: cache };
    var chrome = { storage: { local: {
        get: function(k, cb) { var o = {}; o[k] = store[k] === undefined ? undefined : JSON.parse(JSON.stringify(store[k])); setTimeout(function() { cb(o); }, 0); },
        set: function(o) { Object.assign(store, JSON.parse(JSON.stringify(o))); }
    } }, scripting: { executeScript: async function() { throw new Error('No tab with id'); } } };
    var body = 'var _snInstanceTokensQueue = Promise.resolve();\n' +
        ['snUpdateInstanceTokens', 'snTimeoutMs', 'snWithTimeout', 'snInjectBounded', 'snIsHtmlResponse', 'snResponseIsDeadInstance', 'heartbeatAllInstances']
            .map(function(n) { return extractFn(src, n); }).join('\n') + '\nreturn heartbeatAllInstances;';
    var run = new Function('chrome', 'fetch', 'getSnTabList', body)(chrome, async function(url) { return mkRes(url); }, async function() { return []; });
    return { run: run, store: store };
}

describe('registry + heartbeat: hibernating instance is not a session', function() {
    test('session resolve: hibernation HTML from both probes -> token cleared, sessionOk false, not a 401', async function() {
        var resolve = await buildBg(function(url) { return resp({ headers: { 'content-type': 'text/html' }, body: HIB_HTML, url: url }); });
        var s = await resolve(O, 'cachedTok', '');
        assert.strictEqual(s.token, '');
        assert.strictEqual(s.sessionOk, false);
        assert.strictEqual(s.authRejected, false);
        // also when the user name is already known (only the roles probe runs)
        var s2 = await resolve(O, 'cachedTok', 'admin');
        assert.strictEqual(s2.token, '');
        assert.strictEqual(s2.sessionOk, false);
    }, { tags: ['unit'], timeout: 3000 });

    test('session resolve: JSON 200 still connected; non-hibernation HTML unchanged; off-origin redirect dead', async function() {
        var ok = await buildBg(function(url) { return resp({ headers: { 'content-type': 'application/json' }, url: url }); });
        var s = await ok(O, 'tok', '');
        assert.strictEqual(s.token, 'tok');
        assert.strictEqual(s.sessionOk, true);
        assert.deepStrictEqual(s.roles, ['admin']);
        var other = await buildBg(function(url) { return resp({ headers: { 'content-type': 'text/html' }, body: '<html>proxy</html>', url: url }); });
        var s2 = await other(O, 'tok', '');
        assert.strictEqual(s2.token, 'tok', 'non-hibernation HTML keeps the old behaviour');
        var redir = await buildBg(function() { return resp({ redirected: true, url: 'https://developer.servicenow.com/dev.do', headers: { 'content-type': 'text/html' } }); });
        var s3 = await redir(O, 'tok', '');
        assert.strictEqual(s3.token, '');
        assert.strictEqual(s3.sessionOk, false);
    }, { tags: ['unit'], timeout: 3000 });

    test('heartbeat: hibernation answer drops the cached token; a JSON/headerless 200 keeps it', async function() {
        var h = await buildBgHeartbeat(function(url) { return resp({ headers: { 'content-type': 'text/html' }, body: HIB_HTML, url: url }); },
            { 'https://dev428560.service-now.com': { token: 'c', userName: 'admin' } });
        await h.run();
        assert.strictEqual(h.store.instanceTokens[O], undefined);
        var k = await buildBgHeartbeat(function() { return { status: 200 }; }, { 'https://dev428560.service-now.com': { token: 'c', userName: 'admin', updated: 1 } });
        await k.run();
        assert.deepStrictEqual(k.store.instanceTokens[O], { token: 'c', userName: 'admin', updated: 1 });
    }, { tags: ['unit'], timeout: 3000 });
});
