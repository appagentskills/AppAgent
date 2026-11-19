// PR #1359 follow-ups: absolute-URL 401 recovery in the SW Platform stub
// (Platform.fetchWithSessionRetry / Platform.refreshTokenAfter401) and the
// untracked-tab probe in background.js getSnTabList (host exclusion, negative
// cache, bounded parallel probing). Real source, evaluated with fake chrome/self.
var O = 'https://dev1.service-now.com';

function abortErr() { var e = new Error('aborted'); e.name = 'AbortError'; return e; }

// world: { worker, valid: [tokens the instance accepts], probe(opts) -> token|Promise, hangRetry }
async function buildStub(world) {
    var src = await loadFile('src/js/worker/010-platform-stub.js');
    var stored = { sessionToken: world.worker, instanceUrl: O };
    var calls = [];
    var probes = [];
    var chrome = {
        storage: {
            local: { get: function(k, cb) { cb({ sessionToken: stored.sessionToken, instanceUrl: stored.instanceUrl }); },
                     set: function(o) { Object.assign(stored, o); } },
            onChanged: { addListener: function() {} }
        },
        notifications: { create: function() {} }
    };
    var self = {
        __snProbeDeadlineMs: world.probeDeadlineMs || 50,
        fetch: function(url, opts) {
            var tok = (opts && opts.headers && (opts.headers['X-UserToken'] || '')) || '';
            calls.push(tok);
            var sig = opts && opts.signal;
            if (world.hangRetry && calls.length > 1) {
                return new Promise(function(res, rej) {
                    if (sig) sig.addEventListener('abort', function() { rej(abortErr()); });
                });
            }
            return Promise.resolve({ status: (world.valid || []).indexOf(tok) !== -1 ? 200 : 401 });
        },
        snGetInstancesDetailed: async function() { return [{ url: O, token: world.worker, roles: [], sessionOk: false, tabs: [] }]; },
        snGetTokenForInstance: function(url, opts) {
            probes.push(opts || null);
            return Promise.resolve(world.probe ? world.probe(opts) : '').then(function(t) { return { token: t || '' }; });
        }
    };
    var api = new Function('Platform', 'chrome', 'self', src + '\nreturn { P: Platform, tok: function() { return _workerSessionToken; } };')(null, chrome, self);
    await api.P.ready; await new Promise(function(r) { setTimeout(r, 0); });
    api.calls = calls; api.probes = probes; api.stored = stored;
    return api;
}
function req(token, signal) {
    var o = { method: 'GET', headers: { 'X-UserToken': token, Accept: 'application/json' } };
    if (signal) o.signal = signal;
    return o;
}

describe('fetchWithSessionRetry / refreshTokenAfter401', function() {
    test('401 -> fresh token from tabs -> retried once with it and adopted', async function() {
        var s = await buildStub({ worker: 'dead', valid: ['fresh'], probe: function() { return 'fresh'; } });
        var res = await s.P.fetchWithSessionRetry(O + '/api/now/table/incident', req('dead'));
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(s.calls, ['dead', 'fresh']);
        assert.strictEqual(s.probes[0].excludeToken, 'dead');
        assert.strictEqual(s.tok(), 'fresh');
    }, { tags: ['unit'], timeout: 5000 });

    test('second 401 is returned as-is (no retry loop)', async function() {
        var s = await buildStub({ worker: 'dead', valid: [], probe: function() { return 'alsoDead'; } });
        var res = await s.P.fetchWithSessionRetry(O + '/api/now/table/incident', req('dead'));
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(s.calls, ['dead', 'alsoDead']);
        assert.strictEqual(s.probes.length, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('no fresh token: original 401 returned, dead worker token dropped', async function() {
        var s = await buildStub({ worker: 'dead', valid: [], probe: function() { return ''; } });
        var res = await s.P.fetchWithSessionRetry(O + '/x', req('dead'));
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(s.calls, ['dead']);
        assert.strictEqual(s.tok(), '');
        assert.notStrictEqual(await s.P.getTokenForInstance(O), 'dead');
    }, { tags: ['unit'], timeout: 5000 });

    test('hung tab re-probe: refresh settles at the deadline and the single-flight entry is cleared', async function() {
        var n = 0;
        var s = await buildStub({ worker: 'dead', valid: ['fresh'], probe: function() { n++; return n === 1 ? new Promise(function() {}) : 'fresh'; } });
        // probe deadline = self.__snProbeDeadlineMs (50ms in buildStub)
        var t0 = Date.now();
        var first = await s.P.refreshTokenAfter401(O, 'dead');
        assert.strictEqual(first, '');
        assert.ok(Date.now() - t0 < 2000, 'bounded by the probe deadline');
        // A new call with the SAME dead token must re-probe, not join the hung flight.
        var second = await s.P.refreshTokenAfter401(O, 'dead');
        assert.strictEqual(second, 'fresh');
        assert.strictEqual(s.probes.length, 2);
    }, { tags: ['unit'], timeout: 5000 });

    test('getTokenForInstance: hung tab probe returns "" at the deadline', async function() {
        var s = await buildStub({ worker: '', valid: [], probe: function() { return new Promise(function() {}); } });
        var t0 = Date.now();
        var tok = await s.P.getTokenForInstance('https://dev9.service-now.com');
        assert.strictEqual(tok, '');
        assert.ok(Date.now() - t0 < 2000, 'bounded by the probe deadline, took ' + (Date.now() - t0) + 'ms');
        assert.strictEqual(s.probes.length, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('unknown origin / no token header: no refresh attempted', async function() {
        var s = await buildStub({ worker: 'dead', valid: [], probe: function() { return 'fresh'; } });
        var r1 = await s.P.fetchWithSessionRetry('https://other.example.com/x', req('dead'));
        var r2 = await s.P.fetchWithSessionRetry(O + '/x', { headers: {} });
        assert.strictEqual(r1.status, 401); assert.strictEqual(r2.status, 401);
        assert.strictEqual(s.probes.length, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('abort during a hung refresh probe rejects (not the stale 401)', async function() {
        var s = await buildStub({ worker: 'dead', valid: [], probe: function() { return new Promise(function() {}); } });
        var ac = new AbortController();
        var p = s.P.fetchWithSessionRetry(O + '/x', req('dead', ac.signal));
        setTimeout(function() { ac.abort(); }, 20);
        var err = null;
        try { await p; } catch (e) { err = e; }
        assert.ok(err, 'expected rejection');
    }, { tags: ['unit'], timeout: 5000 });

    test('abort during the retry fetch propagates', async function() {
        var s = await buildStub({ worker: 'dead', valid: [], probe: function() { return 'fresh'; }, hangRetry: true });
        var ac = new AbortController();
        var p = s.P.fetchWithSessionRetry(O + '/x', req('dead', ac.signal));
        setTimeout(function() { ac.abort(); }, 20);
        var err = null;
        try { await p; } catch (e) { err = e; }
        assert.ok(err && err.name === 'AbortError', 'AbortError expected, got ' + (err && err.name));
    }, { tags: ['unit'], timeout: 5000 });

    test('single-flight: concurrent 401s share one re-probe', async function() {
        var release;
        var gate = new Promise(function(r) { release = r; });
        var s = await buildStub({ worker: 'dead', valid: ['fresh'], probe: function() { return gate.then(function() { return 'fresh'; }); } });
        var ps = [1, 2, 3].map(function() { return s.P.fetchWithSessionRetry(O + '/x', req('dead')); });
        await new Promise(function(r) { setTimeout(r, 10); });
        release();
        var rs = await Promise.all(ps);
        rs.forEach(function(r) { assert.strictEqual(r.status, 200); });
        assert.strictEqual(s.probes.length, 1);
        // In-flight entry is cleared afterwards: a later 401 probes again.
        await s.P.refreshTokenAfter401(O, 'dead');
        assert.strictEqual(s.probes.length, 2);
    }, { tags: ['unit'], timeout: 5000 });
});

// background.js getSnTabList: extract the helper block and run it with stubs.
async function buildTabList(world) {
    var src = await loadFile('src/platform/extension/background.js');
    var a = src.indexOf('var SN_NON_INSTANCE_HOST_RE');
    // through snTimeoutMs/snWithTimeout (bounded content-script injection)
    var b = src.indexOf('// fetch with a hard deadline');
    assert.ok(a > 0 && b > a, 'getSnTabList block found');
    var body = src.slice(a, b);
    var probed = [];
    var inflight = 0, maxInflight = 0;
    var chrome = {
        storage: { local: { get: function(k, cb) { cb({ instanceTokens: world.cache || {}, instanceUrl: world.instanceUrl || '' }); } } },
        tabs: { query: async function() { return world.tabs; } },
        scripting: { executeScript: world.hangInject ? function() { return new Promise(function() {}); } : async function() {} }
    };
    var probeTab = async function(id) {
        probed.push(id);
        inflight++; maxInflight = Math.max(maxInflight, inflight);
        await new Promise(function(r) { setTimeout(r, 5); });
        inflight--;
        var t = world.tokens[id];
        return t ? { token: t } : { token: '' };
    };
    // getSnTabList probes via snProbeTabState ({st, timedOut}), defined outside
    // the extracted block: wrap the probeTab stub in that shape.
    var snProbeTabState = async function(id) { return { st: await probeTab(id), timedOut: false }; };
    var snTabs = world.snTabs || new Map();
    var fn = new Function('chrome', 'snTabs', 'snDomains', 'probeTab', 'snProbeTabState', 'injectInterceptors',
        body + '\nreturn { getSnTabList: getSnTabList, isNon: snIsNonInstanceHost };')(
        chrome, snTabs, new Set(), probeTab, snProbeTabState, async function() {});
    fn.probed = probed; fn.max = function() { return maxInflight; }; fn.snTabs = snTabs;
    return fn;
}

describe('getSnTabList probing', function() {
    test('non-instance ServiceNow hosts are never probed', async function() {
        var tracked = new Map([[99, { url: O + '/', origin: O, title: 't' }]]);
        var tabs = [
            { id: 1, url: 'https://www.servicenow.com/products.html' },
            { id: 2, url: 'https://docs.servicenow.com/bundle/x' },
            { id: 3, url: 'https://signon.service-now.com/x' },
            { id: 4, url: 'https://dev2.service-now.com/nav_to.do' },
            { id: 5, url: 'https://community.servicenow.com/' },
            { id: 99, url: O + '/' }
        ];
        var t = await buildTabList({ tabs: tabs, tokens: { 4: 'g' }, snTabs: tracked });
        var list = await t.getSnTabList();
        assert.deepStrictEqual(t.probed, [4]);
        assert.deepStrictEqual(list.map(function(x) { return x.id; }).sort(), [4, 99]);
        assert.ok(t.isNon('developer.servicenow.com'));
        assert.ok(!t.isNon('dev12345.service-now.com'));
        assert.ok(!t.isNon('hi.service-now.com'));
    }, { tags: ['unit'], timeout: 5000 });

    test('negative cache skips no-g_ck tabs until the URL changes', async function() {
        var tracked = new Map([[99, { url: O + '/', origin: O, title: 't' }]]);
        var world = { tabs: [{ id: 7, url: 'https://dev3.service-now.com/login.do' }, { id: 99, url: O + '/' }], tokens: {}, snTabs: tracked };
        var t = await buildTabList(world);
        await t.getSnTabList();
        await t.getSnTabList();
        assert.deepStrictEqual(t.probed, [7]);
        world.tabs[0].url = 'https://dev3.service-now.com/nav_to.do';
        world.tokens[7] = 'g';
        var list = await t.getSnTabList();
        assert.deepStrictEqual(t.probed, [7, 7]);
        assert.ok(list.some(function(x) { return x.id === 7; }));
    }, { tags: ['unit'], timeout: 5000 });

    test('hanging content-script injection does not block getSnTabList', async function() {
        var tracked = new Map([[99, { url: O + '/', origin: O, title: 't' }]]);
        var t = await buildTabList({ tabs: [{ id: 4, url: 'https://dev2.service-now.com/nav_to.do' }, { id: 99, url: O + '/' }], tokens: { 4: 'g' }, snTabs: tracked, hangInject: true });
        var t0 = Date.now();
        var list = await t.getSnTabList();
        assert.ok(Date.now() - t0 < 1000, 'returned without waiting on executeScript, took ' + (Date.now() - t0) + 'ms');
        assert.deepStrictEqual(list.map(function(x) { return x.id; }).sort(), [4, 99]);
        assert.ok(t.snTabs.has(4), 'rediscovered tab is tracked');
    }, { tags: ['unit'], timeout: 5000 });

    test('full scan probes in parallel with bounded concurrency', async function() {
        var tabs = [];
        for (var i = 1; i <= 10; i++) tabs.push({ id: i, url: 'https://inst' + i + '.example.com/' });
        var t = await buildTabList({ tabs: tabs, tokens: { 3: 'a', 8: 'b' } });
        var list = await t.getSnTabList();
        assert.strictEqual(t.probed.length, 10);
        assert.ok(t.max() > 1 && t.max() <= 4, 'max in-flight ' + t.max());
        assert.deepStrictEqual(list.map(function(x) { return x.id; }), [3, 8]);
    }, { tags: ['unit'], timeout: 5000 });
});
