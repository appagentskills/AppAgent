// New-instance connect latency (background.js): snEarlyTabProbe adopts a
// signed-in ServiceNow tab while it is still loading, but only on a parsed,
// same-origin document with a STRICTLY accepted token, within 5s; onTabReady
// runs once per navigation; panels are notified only on a change; a timed-out
// list_instances probe is never negatively cached. Every function under test
// (incl. snIsNonInstanceHost and its regex) is cut from the real source.
var EX = await runFile('test/extract.js', { i18n: false });

describe('early SN tab adoption (background.js)', function() {
    var FNS = ['snLoginProbeState', 'snIsNonInstanceHost', 'snLooksLikeSnUrl', 'snLoginLooksSignedIn', 'snEarlyLooksAdoptable',
        'snTimeoutMs', 'snWithTimeout', 'snInjectBounded', 'snFetchWithTimeout', 'snFetchUserName', 'snStrictTokenOk', 'snTokenAccepted',
        'snUpdateInstanceTokens', 'snNotifyInstancesChanged', '_snProbeNegHit', 'snProbeNegForget',
        'probeTab', 'snProbeTabState', 'onTabReady', 'getSnTabList',
        'snEarlyTabProbe', 'snOnTabComplete', 'snOnTabUpdated'];
    var NEVER = function() { return new Promise(function() {}); };
    var D1 = 'https://dev1.service-now.com';
    function page(o) {
        return Object.assign({ token: 'gck', userName: 'admin', origin: D1, path: '/now/nav/ui/home',
            readyState: 'interactive', hasLoginForm: false, mfa: false, pwChange: false }, o || {});
    }
    async function build(w) {
        var src = await loadFile('src/platform/extension/background.js');
        var re = src.match(/\nvar SN_NON_INSTANCE_HOST_RE = [^\n]+\n/);
        if (!re) throw new Error('SN_NON_INSTANCE_HOST_RE not found');
        var e = { store: Object.assign({}, w.store || {}), msgs: [], scripts: 0, fetches: 0, tabsGet: 0, injected: 0 };
        var chrome = {
            scripting: { executeScript: function(a) {
                if (a.files) return Promise.resolve([{}]);
                e.scripts++;
                if (a.injectImmediately !== true) e.notImmediate = (e.notImmediate || 0) + 1;
                var st = w.page(a.target.tabId, e.scripts);
                return st === 'hang' ? NEVER() : Promise.resolve([{ result: st }]);
            } },
            tabs: {
                get: async function(id) { e.tabsGet++; return { id: id, url: w.url || D1 + '/', title: 't' }; },
                query: async function() { return w.tabs || []; }
            },
            storage: { local: {
                get: function(k, cb) { var o = {}; [].concat(k).forEach(function(x) { if (x in e.store) o[x] = JSON.parse(JSON.stringify(e.store[x])); }); cb(o); },
                set: function(o) { Object.assign(e.store, JSON.parse(JSON.stringify(o))); }
            } },
            runtime: { sendMessage: function(m) { e.msgs.push(m); return Promise.resolve(); } }
        };
        var fetchFn = function() {
            e.fetches++;
            var r = w.fetch ? w.fetch(e.fetches) : { status: 200 };
            if (r === 'hang') return NEVER();
            return (r.delay ? new Promise(function(ok) { setTimeout(ok, r.delay); }) : Promise.resolve()).then(function() {
                return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async function() { return { result: [{ user_name: 'admin' }] }; } };
            });
        };
        var body = re[0] +
            'var snTabs = new Map(); var snDomains = new Set(); var loginTabId = null;\n' +
            'var _snEarlyProbes = new Map(); var _snTabReadyRuns = new Map();\n' +
            'var SN_EARLY_PROBE_INTERVAL_MS = 400; var SN_EARLY_PROBE_INTERVAL_MAX_MS = 1000; var SN_EARLY_PROBE_MAX_MS = 60000; var SN_EARLY_CHECK_MS = 4500;\n' +
            'var _snProbeNegCache = new Map(); var SN_PROBE_NEG_TTL_MS = 20000; var SN_PROBE_CONCURRENCY = 4;\n' +
            'var _snTokenCheckCache = new Map(); var SN_TOKEN_CHECK_TTL_MS = 30000; var _snInstanceTokensQueue = Promise.resolve();\n' +
            EX.extractFunctions(src, FNS) +
            '\nreturn { early: snEarlyTabProbe, complete: snOnTabComplete, updated: snOnTabUpdated, ready: onTabReady,' +
            ' list: getSnTabList, neg: _snProbeNegCache, runs: _snTabReadyRuns, nonInstance: snIsNonInstanceHost };';
        var api = new Function('chrome', 'fetch', 'self', 'updateHeaderRules', 'injectInterceptors', 'snInjectTabScripts', body)(
            chrome, fetchFn, { __snEarlyProbeMs: 20, __snEarlyProbeMaxMs: w.maxMs || 5000, __snTimeouts: w.timeouts || null },
            function() {}, async function() {}, function() { e.injected++; });
        api.e = e;
        api.notifies = function() { return e.msgs.filter(function(m) { return m.type === 'sn-instances-changed'; }).length; };
        return api;
    }
    var flush = function(ms) { return new Promise(function(r) { setTimeout(r, ms || 30); }); };

    test('onUpdated wiring: loading adopts early, complete does not re-run onTabReady', async function() {
        var a = await build({ page: function(id, n) { return n < 2 ? page({ token: '' }) : page(); } });
        var url = D1 + '/now/nav/ui/home';
        a.updated(5, { status: 'loading' }, { url: url, active: false });
        await flush(150);
        assert.strictEqual(a.e.store.sessionToken, 'gck', 'adopted before complete');
        assert.strictEqual(a.e.store.instanceTokens[D1].token, 'gck');
        var probes = a.e.scripts, fetches = a.e.fetches;
        a.updated(5, { status: 'complete' }, { url: url, active: false });
        await flush(50);
        assert.strictEqual(a.e.scripts, probes, 'complete did not probe again');
        assert.strictEqual(a.e.fetches, fetches, 'complete did not re-check the token');
        assert.strictEqual(a.notifies(), 1);
        assert.strictEqual(a.e.tabsGet, 1);
        assert.ok(a.nonInstance('www.servicenow.com') && !a.nonInstance('dev1.service-now.com'), 'real host regex');
    }, { tags: ['unit'], timeout: 3000 });

    test('onTabReady runs once when complete arrives while the early adoption is in flight', async function() {
        var a = await build({ page: function() { return page(); }, fetch: function() { return { status: 200, delay: 120 }; } });
        var url = D1 + '/';
        a.updated(6, { status: 'loading' }, { url: url });
        await flush(40); // early run is now inside the token check
        var c = a.complete(6, url);
        assert.strictEqual(await c, true, 'complete awaited the early run');
        await flush(30);
        assert.strictEqual(a.e.fetches, 1);
        assert.strictEqual(a.e.tabsGet, 1);
        assert.strictEqual(a.notifies(), 1);
        await a.complete(6, url); // a repeated complete of the same navigation
        assert.strictEqual(a.e.tabsGet, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('guest g_ck on /navpage.do while readyState is loading is rejected by the strict check (401)', async function() {
        var a = await build({ maxMs: 300, page: function() { return page({ token: 'guest', path: '/navpage.do', readyState: 'loading' }); },
            fetch: function() { return { status: 401 }; } });
        var ok = await a.early(7, D1 + '/navpage.do');
        assert.strictEqual(ok, false);
        assert.strictEqual(a.e.fetches, 1, 'one strict check; the cached 401 is reused while polling');
        assert.strictEqual(a.e.store.sessionToken, undefined);
        assert.strictEqual(a.e.store.instanceTokens, undefined);
        assert.ok(a.e.scripts >= 2, 'kept polling after the rejection');
        assert.strictEqual(a.e.notImmediate || 0, 0, 'probes use injectImmediately');
    }, { tags: ['unit'], timeout: 3000 });

    test('cold visit: signed-in page still loading after 5s is adopted (loop keeps polling, backs off)', async function() {
        // g_ck shows up only on the 8th probe; probes start 20ms apart and back off x1.5.
        var a = await build({ page: function(id, n) { return n < 8 ? page({ token: '', readyState: 'loading' }) : page({ readyState: 'loading' }); } });
        var ok = await a.early(13, D1 + '/now/nav/ui/home');
        assert.strictEqual(ok, true);
        assert.strictEqual(a.e.store.instanceTokens[D1].token, 'gck');
        assert.strictEqual(a.e.scripts, 8);
        // stops on complete / navigation: a cleared loop ends without adopting
        var b = await build({ page: function() { return page({ token: '' }); } });
        var p = b.early(14, D1 + '/');
        await flush(80);
        b.complete(14, D1 + '/');
        assert.strictEqual(await p, false);
    }, { tags: ['unit'], timeout: 3000 });

    test('origin mismatch (previous document still scripted) is rejected', async function() {
        var a = await build({ maxMs: 200, page: function() { return page({ origin: D1 }); } });
        assert.strictEqual(await a.early(8, 'https://dev2.service-now.com/now/nav/ui/home'), false);
        assert.strictEqual(a.e.fetches, 0);
        assert.strictEqual(a.e.store.instanceTokens, undefined);
    }, { tags: ['unit'], timeout: 3000 });

    test('a probe that hangs past the deadline ends the early path at the deadline', async function() {
        var a = await build({ maxMs: 250, page: function() { return 'hang'; } });
        var t0 = Date.now();
        assert.strictEqual(await a.early(9, D1 + '/'), false);
        var ms = Date.now() - t0;
        assert.ok(ms < 600, 'took ' + ms + 'ms (tab timeout is 2500ms)');
        assert.strictEqual(a.e.scripts, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('strict early check: a token-check fetch timeout rejects within the deadline', async function() {
        var a = await build({ maxMs: 300, timeouts: { fetch: 150 }, page: function() { return page(); }, fetch: function() { return 'hang'; } });
        var t0 = Date.now();
        assert.strictEqual(await a.early(10, D1 + '/'), false);
        assert.ok(Date.now() - t0 < 700, 'took ' + (Date.now() - t0) + 'ms');
        await flush(100);
        assert.strictEqual(a.e.store.sessionToken, undefined);
        assert.strictEqual(a.notifies(), 0);
        // a 401 (guest session) is rejected too
        var b = await build({ maxMs: 300, page: function() { return page(); }, fetch: function() { return { status: 401 }; } });
        assert.strictEqual(await b.early(11, D1 + '/'), false);
        assert.strictEqual(b.e.store.instanceTokens, undefined);
    }, { tags: ['unit'], timeout: 3000 });

    test('no notify when the origin is already connected with the same token', async function() {
        var store = { instanceUrl: D1, instanceTokens: {} };
        store.instanceTokens[D1] = { token: 'gck', userName: 'admin', updated: 1 };
        var a = await build({ store: store, page: function() { return page(); } });
        assert.strictEqual(await a.ready(12), true);
        await flush(30);
        assert.strictEqual(a.notifies(), 0);
        assert.strictEqual(a.e.store.instanceTokens[D1].updated, 1, 'no rewrite');
        var b = await build({ store: store, page: function() { return page({ token: 'gck2' }); } });
        await b.ready(12);
        await flush(30);
        assert.strictEqual(b.notifies(), 1, 'token changed');
    }, { tags: ['unit'], timeout: 3000 });

    test('list_instances probe: a timeout is not negatively cached; adoption clears the origin', async function() {
        var tabs = [{ id: 1, url: D1 + '/x' }, { id: 2, url: D1 + '/login.do' }];
        var a = await build({ tabs: tabs, timeouts: { tab: 60 }, page: function(id) { return id === 1 ? 'hang' : page({ token: '' }); } });
        a.e.store.instanceTokens = {}; a.e.store.instanceTokens[D1] = { token: 'old' };
        var list = await a.list();
        assert.strictEqual(list.length, 0);
        assert.strictEqual(a.neg.has(1), false, 'timed-out probe not cached');
        assert.strictEqual(a.neg.has(2), true, 'answered no-g_ck probe cached');
        var b = await build({ page: function() { return page(); } });
        b.neg.set(2, { url: D1 + '/login.do', until: Date.now() + 20000 });
        b.neg.set(3, { url: 'https://other.example.com/', until: Date.now() + 20000 });
        assert.strictEqual(await b.ready(1), true);
        assert.strictEqual(b.neg.has(2), false, 'origin entries cleared');
        assert.strictEqual(b.neg.has(3), true);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('panel _onSnInstancesChanged (platform-bridge.js)', function() {
    test('debounces refreshInstances and validateToken into one call per burst', async function() {
        var src = await loadFile('src/platform/extension/platform-bridge.js');
        var start = src.indexOf('    var _snChangedTimer = null;');
        var fn = EX.extractFunction(src, '_onSnInstancesChanged');
        var head = src.slice(start, src.indexOf('function _onSnInstancesChanged', start));
        var c = { refresh: 0, validate: 0 };
        var Platform = { instanceUrl: 'https://dev1.service-now.com', refreshInstances: function() { c.refresh++; } };
        var on = new Function('Platform', 'validateToken', '_normUrl', '_snStatusState', head + fn + '\nreturn _onSnInstancesChanged;')(
            Platform, function() { c.validate++; }, function(u) { return String(u || '').replace(/\/$/, ''); }, 'disconnected');
        on('https://dev1.service-now.com'); on('https://dev1.service-now.com/'); on('https://dev2.service-now.com');
        assert.strictEqual(c.validate + c.refresh, 0, 'nothing synchronous');
        await new Promise(function(r) { setTimeout(r, 320); });
        assert.strictEqual(c.refresh, 1);
        assert.strictEqual(c.validate, 1);
        on('https://dev2.service-now.com');
        await new Promise(function(r) { setTimeout(r, 320); });
        assert.strictEqual(c.refresh, 2);
        assert.strictEqual(c.validate, 1, 'not the active instance');
    }, { tags: ['unit'], timeout: 3000 });
});
