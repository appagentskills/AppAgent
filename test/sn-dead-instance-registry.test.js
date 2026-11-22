// Dead/hibernating instance registry (platform-bridge.js): a dead instance (live
// case dev428560 answering HTTP 200 "Instance Hibernating page") is never shown
// connected and is hidden/retired from the pill + picker at ANY age. Real source
// extracted by name; fake chrome / fetch / DOM.
var EX = await runFile('test/extract.js', { i18n: false });

var O = 'https://dev428560.service-now.com';
var HIB_HTML = '<html><head><title>Instance Hibernating page</title></head><body>Your instance is hibernating</body></html>';
function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function resp(o) {
    var hdr = o.headers || {};
    return {
        status: o.status || 200, ok: (o.status || 200) < 300, redirected: false, url: o.url || (O + '/stats.do'),
        headers: { get: function(k) { return hdr[String(k).toLowerCase()] || null; } },
        text: function() { return Promise.resolve(o.body || ''); }
    };
}
function htmlRes(body) { return resp({ headers: { 'content-type': 'text/html;charset=UTF-8' }, body: body || HIB_HTML }); }
function jsonRes() { return resp({ headers: { 'content-type': 'application/json' } }); }

// Source of the registry block: `var _SN_DEAD_KEY ...` through `_setInstanceDead`.
function registrySrc(src) {
    var start = src.indexOf('var _SN_DEAD_KEY');
    var f = EX.findFunction(src, '_setInstanceDead');
    if (start < 0 || !f || !(f.end > start)) throw new Error('dead registry block not found');
    return src.slice(start, f.end);
}
function constLine(src, name) {
    var m = src.match(new RegExp('var ' + name + ' = [^;]+;'));
    if (!m) throw new Error('constant ' + name + ' not found');
    return m[0];
}
function fakeChrome(initial) {
    var store = JSON.parse(JSON.stringify(initial || {}));
    var sent = [];
    return {
        store: store, sent: sent,
        storage: { local: {
            get: function(k, cb) { var o = {}; if (store[k] !== undefined) o[k] = JSON.parse(JSON.stringify(store[k])); cb(o); },
            set: function(o) { Object.assign(store, JSON.parse(JSON.stringify(o))); }
        } },
        runtime: { lastError: null, sendMessage: function(msg, cb) { sent.push(msg); if (cb) setTimeout(function() { cb({ success: true, token: '' }); }, 0); } }
    };
}

async function loadRegistry(opts) {
    opts = opts || {};
    var src = await loadFile('src/platform/extension/platform-bridge.js');
    var fns = EX.extractFunctions(src, [
        '_normUrl', '_deadUrl', '_markDead', '_isRecentlyRemoved', '_isStaleTablessInstance', '_hideStaleTablessInstances',
        '_cacheInstances', '_persistInstancesCache', '_withRetainedInstances', '_seedRenderList', '_orderInstances',
        '_retireStaleActiveInstance', '_hydrateInstancesCache'
    ]);
    var body = [
        'var _snActiveDead = null;',
        'var _instancesCache = null;',
        constLine(src, '_INSTANCES_CACHE_KEY'),
        constLine(src, '_INSTANCE_RETENTION_MS'),
        constLine(src, '_INSTANCE_TAB_STALE_MS'),
        'var _recentlyRemoved = {};',
        'var _staleActiveRetiringFor = \'\';',
        constLine(src, '_REMOVED_TOMBSTONE_MS'),
        fns,
        registrySrc(src),
        'return {',
        '  get cache() { return _instancesCache; }, set cache(v) { _instancesCache = v; },',
        '  registry: function() { return _snDeadInstances; }, marker: function() { return _snActiveDead; },',
        '  isDead: _isInstanceDeadUrl, setDead: _setInstanceDead, isStale: _isStaleTablessInstance, hide: _hideStaleTablessInstances,',
        '  cacheInstances: _cacheInstances, withRetained: _withRetainedInstances, retire: _retireStaleActiveInstance',
        '};'
    ].join('\n');
    var chrome = fakeChrome(opts.store);
    var Platform = { instanceUrl: opts.activeUrl === undefined ? O : opts.activeUrl, instances: [] };
    var win = { sessionToken: opts.token === undefined ? 'tok' : opts.token };
    var m = new Function('chrome', 'Platform', 'updateSnStatus', 'window', body)(chrome, Platform, function() {}, win);
    m.chrome = chrome; m.Platform = Platform; m.win = win;
    return m;
}

describe('dead instance registry: hydration + persistence', function() {
    test('hydrates snDeadInstances from storage and re-latches the active marker for the held token', async function() {
        var store = { snDeadInstances: {} };
        store.snDeadInstances[O] = { token: 'tok', at: 1 };
        var m = await loadRegistry({ store: store });
        assert.strictEqual(m.isDead(O + '/'), true, 'normalized lookup');
        assert.strictEqual(m.isDead('https://alive.service-now.com'), false);
        assert.deepStrictEqual(m.marker(), { url: O, token: 'tok' });
        var other = await loadRegistry({ store: store, token: 'different' });
        assert.strictEqual(other.marker(), null, 'marker only for the same held token');
    }, { tags: ['unit'], timeout: 3000 });

    test('_setInstanceDead persists set and clear to chrome.storage.local', async function() {
        var m = await loadRegistry();
        m.setDead(O + '/', 'tok', true);
        assert.strictEqual(m.isDead(O), true);
        assert.strictEqual(m.chrome.store.snDeadInstances[O].token, 'tok');
        m.setDead(O, '', false);
        assert.strictEqual(m.isDead(O), false);
        assert.deepStrictEqual(m.chrome.store.snDeadInstances, {});
    }, { tags: ['unit'], timeout: 3000 });
});

describe('dead tab-less instance is hidden and retired at any age', function() {
    test('isStale: dead tab-less entry stale even with a fresh stamp; an open tab still wins', async function() {
        var m = await loadRegistry({ activeUrl: '' });
        var now = Date.now();
        assert.strictEqual(m.isStale({ url: O, tabs: [] }, now - 1000, now), false, 'fresh + alive -> shown');
        m.setDead(O, 'tok', true);
        assert.strictEqual(m.isStale({ url: O, tabs: [] }, now - 1000, now), true, 'fresh + dead -> stale');
        assert.strictEqual(m.isStale({ url: O, tabs: [{ id: 1 }] }, now - 1000, now), false, 'open tab never hidden');
        m.cache = [{ url: O, tabs: [], tabLastSeen: now - 1000 }, { url: 'https://alive.service-now.com', tabs: [], tabLastSeen: now - 1000 }];
        assert.deepStrictEqual(m.hide([{ url: O, tabs: [] }, { url: 'https://alive.service-now.com', tabs: [] }]).map(function(i) { return i.url; }),
            ['https://alive.service-now.com']);
    }, { tags: ['unit'], timeout: 3000 });

    test('_cacheInstances: dead entry never connected (even with a token) and the dead active is retired', async function() {
        var store = { snDeadInstances: {} };
        store.snDeadInstances[O] = { token: 'tok', at: 1 };
        var m = await loadRegistry({ store: store });
        var now = Date.now();
        m.cache = [{ url: O, tabs: [], lastSeen: now, tabLastSeen: now - 1000 }];
        // Injected token (panel-held, not background-verified) must not clear the dead flag.
        m.cacheInstances([{ url: O, tabs: [], token: 'tok', _injectedToken: true }, { url: 'https://b.service-now.com', tabs: [{ id: 4 }], token: 'b' }]);
        var d = m.cache.filter(function(c) { return c.url === O; })[0];
        assert.strictEqual(d.connected, false);
        assert.strictEqual(d.dead, true);
        assert.strictEqual(m.retire(), true, 'fresh-stamped dead active retired');
        assert.deepStrictEqual(m.chrome.sent[0], { type: 'switch-sn-instance', instanceUrl: 'https://b.service-now.com', tabId: 4 });
    }, { tags: ['unit'], timeout: 3000 });

    test('a background-verified token for that origin clears the dead flag', async function() {
        var store = { snDeadInstances: {} };
        store.snDeadInstances[O] = { token: 'tok', at: 1 };
        var m = await loadRegistry({ store: store, activeUrl: '' });
        m.cache = [];
        m.cacheInstances([{ url: O, tabs: [{ id: 2 }], token: 'bgTok' }]);
        assert.strictEqual(m.isDead(O), false);
        assert.strictEqual(m.cache[0].connected, true);
        assert.strictEqual(m.chrome.store.snDeadInstances[O], undefined);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('fetch interceptor ignores HTML answers', function() {
    async function loadInterceptor(response) {
        var src = await loadFile('src/platform/extension/platform-bridge.js');
        var start = src.indexOf('var _origFetch = window.fetch;');
        var end = src.indexOf('// Refresh token by extracting g_ck');
        if (start < 0 || end < start) throw new Error('interceptor not found');
        var body = 'var _snStatusState = "unknown";\n' + EX.extractFunctions(src, ['_snIsHtmlResponse']) + '\n' + src.slice(start, end) +
            '\nreturn { state: function() { return _snStatusState; } };';
        var cur = { response: response };
        var win = { sessionToken: 'tok', fetch: function() { return Promise.resolve(cur.response); } };
        var Platform = { instanceUrl: O };
        var api = new Function('window', 'Platform', 'updateSnStatus', '_refreshToken', '_openSnForLogin', body)(
            win, Platform, function() {}, function() { return Promise.resolve(null); }, function() { return Promise.resolve(null); });
        api.fetch = win.fetch; api.setResponse = function(r) { cur.response = r; };
        return api;
    }
    test('HTML /stats.do (hibernation page) does not mark connected; a JSON answer does', async function() {
        var a = await loadInterceptor(htmlRes());
        var r = await a.fetch('/stats.do');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(a.state(), 'unknown', 'HTML 200 is no proof of a session');
        await a.fetch('/api/now/table/sys_user?sysparm_limit=1');
        assert.strictEqual(a.state(), 'unknown', '/api/ HTML ignored too');
        a.setResponse(jsonRes());
        await a.fetch('/api/now/table/sys_user?sysparm_limit=1');
        assert.strictEqual(a.state(), 'connected');
    }, { tags: ['unit'], timeout: 3000 });
});

describe('testInstanceConnection persists the dead flag', function() {
    async function loadTest(response, store) {
        var src = await loadFile('src/platform/extension/platform-bridge.js');
        var body = 'var _snActiveDead = null;\nvar _snStatusState = "connected";\n' +
            EX.extractFunctions(src, ['_normUrl', '_snIsHtmlResponse', '_snResponseIsDeadInstance', 'testInstanceConnection']) + '\n' + registrySrc(src) +
            '\nreturn { run: testInstanceConnection, state: function() { return _snStatusState; }, marker: function() { return _snActiveDead; }, isDead: _isInstanceDeadUrl };';
        function el() { return { style: {}, textContent: '', className: '', title: '', disabled: false }; }
        var els = { '.ext-instance-test': el(), '.ext-instance-dot': el(), '.ext-instance-tier': el() };
        var row = { querySelector: function(s) { return els[s] || null; } };
        var cur = { response: response };
        var chrome = fakeChrome(store);
        var win = { sessionToken: 'tok' };
        var api = new Function('window', 'chrome', 'Platform', '_origFetch', 'updateSnStatus', 't', '_friendlyConnError', body)(
            win, chrome, { instanceUrl: O }, { call: function() { return Promise.resolve(cur.response); } }, function() {},
            function(s) { return s; }, function(st) { return { label: 'HTTP ' + st, title: '' }; });
        api.row = row; api.els = els; api.chrome = chrome; api.setResponse = function(r) { cur.response = r; };
        return api;
    }
    test('hibernation answer: row failed, header disconnected, dead flag persisted; JSON answer clears it', async function() {
        var a = await loadTest(htmlRes());
        a.run({ url: O }, a.row); await wait(20);
        assert.strictEqual(a.els['.ext-instance-dot'].className, 'ext-instance-dot fail');
        assert.strictEqual(a.state(), 'disconnected');
        assert.deepStrictEqual(a.marker(), { url: O, token: 'tok' });
        assert.strictEqual(a.isDead(O), true);
        assert.strictEqual(a.chrome.store.snDeadInstances[O].token, 'tok', 'persisted to chrome.storage.local');
        a.setResponse(jsonRes());
        a.run({ url: O }, a.row); await wait(20);
        assert.strictEqual(a.els['.ext-instance-dot'].className, 'ext-instance-dot ok');
        assert.strictEqual(a.state(), 'connected');
        assert.strictEqual(a.isDead(O), false);
        assert.deepStrictEqual(a.chrome.store.snDeadInstances, {});
    }, { tags: ['unit'], timeout: 3000 });

    test('any non-hibernation HTML 200 also counts as dead', async function() {
        var a = await loadTest(htmlRes('<html><title>Login</title></html>'));
        a.run({ url: O }, a.row); await wait(20);
        assert.strictEqual(a.state(), 'disconnected');
        assert.strictEqual(a.isDead(O), true);
    }, { tags: ['unit'], timeout: 3000 });
});
