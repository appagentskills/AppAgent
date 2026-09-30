// Stale-tab instance auth: an instance is connected if ANY open tab yields a
// live session. Evaluates the REAL background.js helpers (extracted by name and
// evaluated together) against fake tabs / fetch / chrome.storage.

function extractFn(src, name) {
    var re = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(');
    var m = re.exec(src);
    if (!m) throw new Error('function not found: ' + name);
    var i = src.indexOf('{', m.index), depth = 0;
    for (var j = i; j < src.length; j++) {
        var ch = src[j];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
    }
    throw new Error('unbalanced: ' + name);
}

var FNS = ['snProbeTabTokenUser', 'snFetchUserName', 'snFetchUserRoles', 'snCollectTabTokens',
    'snPickTabToken', 'snResolveInstanceSession', 'snRememberInstanceToken', 'snUpdateInstanceTokens',
    'snGetInstancesDetailed', 'snGetTokenForInstance', 'handleRefreshToken'];

// world: { tabs: [{id, origin, token, userName}], valid: [tokens], cache: {origin: {token}} }
async function build(world) {
    var src = await loadFile('src/platform/extension/background.js');
    var store = { instanceTokens: world.cache || {}, instanceUrl: world.instanceUrl };
    var calls = [];
    var chrome = {
        scripting: { executeScript: async function(o) {
            var t = world.tabs.filter(function(x) { return x.id === o.target.tabId; })[0];
            if (!t || t.closed) throw new Error('No tab with id');
            return [{ result: { token: t.token, userName: t.userName || '' } }];
        } },
        storage: { local: {
            // Snapshot copies + a deferred callback, like the real async storage — so a
            // non-serialized read-modify-write would visibly lose an update.
            get: function(k, cb) { var o = {}; o[k] = store[k] === undefined ? undefined : JSON.parse(JSON.stringify(store[k])); if (cb) setTimeout(function() { cb(o); }, 0); return Promise.resolve(o); },
            set: function(o) { Object.assign(store, JSON.parse(JSON.stringify(o))); }
        } }
    };
    var fetch = async function(url, opts) {
        var tok = opts.headers['X-UserToken'];
        calls.push(tok);
        var ok = world.valid.indexOf(tok) !== -1;
        // rolesStatus: {token: status} — a VALID token whose sys_user_has_role read is
        // refused for a non-auth reason (403 ACL, 429, 5xx); rolesThrow: network error.
        if (ok && url.indexOf('sys_user_has_role') !== -1) {
            if (world.rolesThrow) throw new Error('network');
            if (world.rolesStatus && world.rolesStatus[tok]) return { ok: false, status: world.rolesStatus[tok], json: async function() { return {}; } };
        }
        return { ok: ok, status: ok ? 200 : 401, json: async function() {
            if (world.noRoles) return { result: [] };   // maint / ESS: 200 with zero rows
            return { result: url.indexOf('sys_user_has_role') !== -1 ? [{ 'role.name': 'admin' }] : [{ user_name: 'admin' }] };
        } };
    };
    var getSnTabList = async function() {
        return world.tabs.map(function(t) { return { id: t.id, origin: t.origin, url: t.origin + '/', title: 't' }; });
    };
    var body = 'var _snInstanceTokensQueue = Promise.resolve();\n' + FNS.map(function(n) { return extractFn(src, n); }).join('\n') +
        '\nreturn { detailed: snGetInstancesDetailed, forInstance: snGetTokenForInstance, pick: snPickTabToken, refresh: handleRefreshToken, remember: snRememberInstanceToken, update: snUpdateInstanceTokens };';
    var mk = new Function('chrome', 'fetch', 'getSnTabList', 'snMaintEligible', 'snDetectMaint', body);
    var api = mk(chrome, fetch, getSnTabList, world.maint ? function(roles, ok, name) { return ok && !roles.length && !name; } : undefined,
        world.maint ? async function(u, t) { return world.valid.indexOf(t) !== -1; } : undefined);
    api.store = store; api.calls = calls;
    return api;
}

var O = 'https://dev1.service-now.com';

describe('stale-tab instance auth', function() {
    test('single healthy tab: connected, no extra validation request', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'good', userName: 'admin' }], valid: ['good'] });
        var r = await a.forInstance(O);
        assert.strictEqual(r.token, 'good');
        assert.strictEqual(a.calls.length, 0);
        var d = await a.detailed();
        assert.strictEqual(d[0].token, 'good');
        assert.deepStrictEqual(d[0].roles, ['admin']);
    }, { tags: ['unit'], timeout: 5000 });

    test('timed-out tab FIRST + healthy tab: healthy one wins everywhere', async function() {
        var w = { tabs: [{ id: 1, origin: O, token: 'dead', userName: 'admin' }, { id: 2, origin: O, token: 'good', userName: 'admin' }], valid: ['good'] };
        var a = await build(w);
        var d = await a.detailed();
        assert.strictEqual(d[0].token, 'good');
        assert.deepStrictEqual(d[0].roles, ['admin']);
        await new Promise(function(r) { setTimeout(r, 10); });   // snRememberInstanceToken is queued
        assert.strictEqual(a.store.instanceTokens[O].token, 'good');
        var r = await a.forInstance(O);
        assert.strictEqual(r.token, 'good');
        assert.strictEqual(r.tabId, 2);
    }, { tags: ['unit'], timeout: 5000 });

    test('healthy tab FIRST + timed-out tab: healthy one wins', async function() {
        var a = await build({ tabs: [{ id: 2, origin: O, token: 'good' }, { id: 1, origin: O, token: 'dead' }], valid: ['good'] });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, 'good');
        assert.strictEqual((await a.forInstance(O)).token, 'good');
    }, { tags: ['unit'], timeout: 5000 });

    test('only a timed-out tab: reported disconnected (token cleared)', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'dead' }], valid: [] });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, '');
        var r = await a.forInstance(O, { validate: true });
        assert.strictEqual(r.token, '');
    }, { tags: ['unit'], timeout: 5000 });

    test('only a timed-out tab that still exposes NOW.user_name: token cleared too', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'dead', userName: 'admin' }], valid: [] });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, '');
        assert.strictEqual(d[0].sessionOk, false);
        assert.deepStrictEqual(d[0].roles, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('maint (no sys_user, 200 empty rows) is unaffected by the 401 clear rule', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'm' }], valid: ['m'], noRoles: true, maint: true });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, 'm');
        assert.strictEqual(d[0].isMaint, true);
        assert.deepStrictEqual(d[0].roles, ['maint', 'admin']);
        assert.strictEqual(d[0].sessionOk, true);
    }, { tags: ['unit'], timeout: 5000 });

    test('ESS user with a known name (200, zero rows) stays connected', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'ess', userName: 'abel' }], valid: ['ess'], noRoles: true });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, 'ess');
        assert.strictEqual(d[0].sessionOk, true);
    }, { tags: ['unit'], timeout: 5000 });

    test('two timed-out tabs: disconnected, nothing cached', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'd1', userName: 'admin' }, { id: 2, origin: O, token: 'd2' }], valid: [] });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, '');
        assert.strictEqual(a.store.instanceTokens[O], undefined);
        assert.strictEqual((await a.forInstance(O)).token, '');
    }, { tags: ['unit'], timeout: 5000 });

    test('handleRefreshToken: dead tab first + healthy sibling -> healthy token persisted', async function() {
        var a = await build({ instanceUrl: O, tabs: [{ id: 1, origin: O, token: 'dead' }, { id: 2, origin: O, token: 'good' }], valid: ['good'] });
        var resp = await new Promise(function(r) { a.refresh(r, 'dead'); });
        assert.deepStrictEqual(resp, { token: 'good' });
        assert.strictEqual(a.store.sessionToken, 'good');
        var b = await build({ instanceUrl: O, tabs: [{ id: 1, origin: O, token: 'dead' }, { id: 2, origin: O, token: 'good' }], valid: ['good'] });
        var resp2 = await new Promise(function(r) { b.refresh(r, ''); });
        assert.strictEqual(resp2.token, 'good');
    }, { tags: ['unit'], timeout: 5000 });

    test('handleRefreshToken: only the excluded token available -> error, nothing persisted', async function() {
        var a = await build({ instanceUrl: O, tabs: [{ id: 1, origin: O, token: 'dead' }], valid: [] });
        var resp = await new Promise(function(r) { a.refresh(r, 'dead'); });
        assert.ok(resp.error && !resp.token);
        assert.strictEqual(a.store.sessionToken, undefined);
    }, { tags: ['unit'], timeout: 5000 });

    test('instanceTokens updates are serialized (no lost update)', async function() {
        var a = await build({ tabs: [], valid: [] });
        var slow = a.update(function(map) { map['https://a'] = { token: 'A' }; });
        var p2 = a.remember('https://b', 'B', 'u');
        await Promise.all([slow, p2]);
        assert.strictEqual(a.store.instanceTokens['https://a'].token, 'A');
        assert.strictEqual(a.store.instanceTokens['https://b'].token, 'B');
    }, { tags: ['unit'], timeout: 5000 });

    test('cached token of a closed tab is skipped when rejected; live sibling used', async function() {
        var a = await build({ tabs: [{ id: 9, origin: O, token: 'x', closed: true }, { id: 2, origin: O, token: 'good' }], valid: ['good'], cache: { 'https://dev1.service-now.com': { token: 'dead' } } });
        var r = await a.forInstance(O, { excludeToken: 'dead', validate: true });
        assert.strictEqual(r.token, 'good');
        assert.strictEqual(r.tabId, 2);
    }, { tags: ['unit'], timeout: 5000 });

    test('401 retry path: excludeToken never hands the failed token back', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'dead' }, { id: 2, origin: O, token: 'good' }], valid: ['good'], cache: { 'https://dev1.service-now.com': { token: 'dead' } } });
        var r = await a.forInstance(O, { excludeToken: 'dead' });
        assert.strictEqual(r.token, 'good');
        var r2 = await a.forInstance(O, { excludeToken: 'good' });
        assert.notStrictEqual(r2.token, 'good');
    }, { tags: ['unit'], timeout: 5000 });

    test('SW shim 401 refresh delegates to the multi-tab probe with excludeToken', async function() {
        var src = await loadFile('src/js/worker/010-platform-stub.js');
        var seen = null;
        var fn = new Function('self', 'Platform', extractFn(src, '_freshTokenAfter401') + '\nreturn _freshTokenAfter401;')(
            { snGetTokenForInstance: async function(u, o) { seen = [u, o]; return { token: 'good' }; } },
            { instanceUrl: O, getTokenForInstance: async function() { return 'dead'; } });
        assert.strictEqual(await fn('dead'), 'good');
        assert.deepStrictEqual(seen, [O, { excludeToken: 'dead' }]);
    }, { tags: ['unit'], timeout: 5000 });
});

// Heartbeat: real heartbeatAllInstances + snUpdateInstanceTokens.
async function buildHeartbeat(world) {
    var src = await loadFile('src/platform/extension/background.js');
    var store = { instanceTokens: world.cache || {} };
    var pings = [];
    var chrome = {
        scripting: { executeScript: async function(o) {
            var t = world.tabs.filter(function(x) { return x.id === o.target.tabId; })[0];
            if (!t) throw new Error('No tab with id');
            return [{ result: t.token }];
        } },
        storage: { local: {
            get: function(k, cb) { var o = {}; o[k] = store[k] === undefined ? undefined : JSON.parse(JSON.stringify(store[k])); setTimeout(function() { cb(o); }, 0); },
            set: function(o) { Object.assign(store, JSON.parse(JSON.stringify(o))); }
        } }
    };
    var fetch = async function(url, opts) {
        var tok = opts.headers['X-UserToken'];
        pings.push(tok);
        return { status: world.valid.indexOf(tok) !== -1 ? 200 : 401 };
    };
    var getSnTabList = async function() { return world.tabs.map(function(t) { return { id: t.id, origin: t.origin }; }); };
    var body = 'var _snInstanceTokensQueue = Promise.resolve();\n' + extractFn(src, 'snUpdateInstanceTokens') + '\n' +
        extractFn(src, 'heartbeatAllInstances') + '\nreturn heartbeatAllInstances;';
    var run = new Function('chrome', 'fetch', 'getSnTabList', body)(chrome, fetch, getSnTabList);
    return { run: run, store: store, pings: pings };
}

describe('heartbeat with a session-timed-out tab', function() {
    test('cached token held by a sibling tab: ONE ping with it, cache untouched', async function() {
        var h = await buildHeartbeat({ tabs: [{ id: 1, origin: O, token: 'dead' }, { id: 2, origin: O, token: 'good' }], valid: ['good'],
            cache: { 'https://dev1.service-now.com': { token: 'good', userName: 'admin', updated: 1 } } });
        await h.run();
        assert.deepStrictEqual(h.pings, ['good']);
        assert.deepStrictEqual(h.store.instanceTokens[O], { token: 'good', userName: 'admin', updated: 1 });
        assert.strictEqual(h.store.heartbeatLastResults[0].status, 200);
    }, { tags: ['unit'], timeout: 5000 });

    test('dead cached token held by the first tab: sibling wins and is cached', async function() {
        var h = await buildHeartbeat({ tabs: [{ id: 1, origin: O, token: 'dead' }, { id: 2, origin: O, token: 'good' }], valid: ['good'],
            cache: { 'https://dev1.service-now.com': { token: 'dead', userName: 'admin' } } });
        await h.run();
        assert.deepStrictEqual(h.pings, ['dead', 'good']);
        assert.strictEqual(h.store.instanceTokens[O].token, 'good');
        assert.strictEqual(h.store.instanceTokens[O].userName, 'admin');
        assert.strictEqual(h.store.heartbeatLastResults[0].source, 'tab-sibling');
    }, { tags: ['unit'], timeout: 5000 });

    test('every tab dead: entry dropped', async function() {
        var h = await buildHeartbeat({ tabs: [{ id: 1, origin: O, token: 'd1' }, { id: 2, origin: O, token: 'd2' }], valid: [],
            cache: { 'https://dev1.service-now.com': { token: 'old' } } });
        await h.run();
        assert.deepStrictEqual(h.pings, ['d1', 'd2']);
        assert.strictEqual(h.store.instanceTokens[O], undefined);
    }, { tags: ['unit'], timeout: 5000 });

    test('tab-less cached origin keeps pinging with the cache', async function() {
        var h = await buildHeartbeat({ tabs: [], valid: ['c'], cache: { 'https://dev1.service-now.com': { token: 'c' } } });
        await h.run();
        assert.deepStrictEqual(h.pings, ['c']);
        assert.strictEqual(h.store.instanceTokens[O].token, 'c');
    }, { tags: ['unit'], timeout: 5000 });
});

// SW Platform stub: the real 010-platform-stub.js evaluated with fake chrome/self.
async function buildStub(worker, probe) {
    var src = await loadFile('src/js/worker/010-platform-stub.js');
    var stored = { sessionToken: worker, instanceUrl: O };
    var sets = [];
    var chrome = {
        storage: {
            local: { get: function(k, cb) { cb({ sessionToken: stored.sessionToken, instanceUrl: stored.instanceUrl }); },
                     set: function(o) { sets.push(o); Object.assign(stored, o); } },
            onChanged: { addListener: function() {} }
        },
        notifications: { create: function() {} }
    };
    var self = { fetch: async function() { return { status: 200 }; },
        snGetInstancesDetailed: async function() { return probe; },
        snGetTokenForInstance: async function() { return { token: 'probed' }; } };
    var api = new Function('Platform', 'chrome', 'self', src + '\nreturn { P: Platform, tok: function() { return _workerSessionToken; } };')(null, chrome, self);
    await api.P.ready; await new Promise(function(r) { setTimeout(r, 0); });
    api.sets = sets;   // includes the boot-time refreshInstances (Platform.ready)
    return api;
}

describe('SW Platform stub adopts the probed healthy token', function() {
    test('dead worker token + accepted probed token: adopted and persisted', async function() {
        var s = await buildStub('dead', [{ url: O, token: 'good', userName: 'admin', roles: ['admin'], sessionOk: true, tabs: [{ id: 2 }] }]);
        await s.P.refreshInstances();
        assert.strictEqual(s.tok(), 'good');
        assert.strictEqual(await s.P.getTokenForInstance(O), 'good');
        assert.deepStrictEqual(s.sets, [{ sessionToken: 'good' }]);   // boot + explicit refresh: ONE write
    }, { tags: ['unit'], timeout: 5000 });

    test('probed token not proven accepted (sessionOk false): worker token kept', async function() {
        var s = await buildStub('held', [{ url: O, token: 'unproven', roles: [], sessionOk: false, tabs: [] }]);
        await s.P.refreshInstances();
        assert.strictEqual(s.tok(), 'held');
        assert.deepStrictEqual(s.sets, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('same token: no write; empty probe keeps the held session (guard)', async function() {
        var s = await buildStub('good', [{ url: O, token: 'good', roles: ['admin'], sessionOk: true, tabs: [] }]);
        await s.P.refreshInstances();
        assert.deepStrictEqual(s.sets, []);
        var s2 = await buildStub('held', [{ url: O, token: '', roles: [], sessionOk: false, tabs: [] }]);
        var list = await s2.P.refreshInstances();
        assert.strictEqual(list[0].token, 'held');
        assert.strictEqual(await s2.P.getTokenForInstance(O), 'held');
    }, { tags: ['unit'], timeout: 5000 });
});

// Roles read refused (403/429/5xx) on an otherwise working token: the probe
// (real snGetInstancesDetailed) feeds the real SW stub, end to end.
describe('roles read refused for a non-auth reason still adopts the working token', function() {
    var DEAD_THEN_GOOD = [{ id: 1, origin: O, token: 'dead', userName: 'admin' }, { id: 2, origin: O, token: 'good', userName: 'admin' }];

    test('roles read 403 + working sibling token: sessionOk, adopted by the stub', async function() {
        var a = await build({ tabs: DEAD_THEN_GOOD, valid: ['good'], rolesStatus: { good: 403 } });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, 'good');
        assert.strictEqual(d[0].sessionOk, true);
        assert.deepStrictEqual(d[0].rejectedTokens, ['dead']);
        var s = await buildStub('dead', d);
        await s.P.refreshInstances();
        assert.strictEqual(s.tok(), 'good');
        assert.strictEqual(await s.P.getTokenForInstance(O), 'good');
        assert.deepStrictEqual(s.sets, [{ sessionToken: 'good' }]);
    }, { tags: ['unit'], timeout: 5000 });

    test('roles read 429 / 500 / 503: not sessionOk; adopted only via the 401 fallback', async function() {
        var codes = [429, 500, 503];
        for (var i = 0; i < codes.length; i++) {
            var m = 'status ' + codes[i];
            var a = await build({ tabs: DEAD_THEN_GOOD, valid: ['good'], rolesStatus: { good: codes[i] } });
            var d = await a.detailed();
            assert.strictEqual(d[0].token, 'good', m);
            assert.strictEqual(d[0].sessionOk, false, m);
            assert.deepStrictEqual(d[0].rejectedTokens, ['dead'], m);
            var s = await buildStub('dead', d);           // held token was 401d: fallback adopts
            await s.P.refreshInstances();
            assert.strictEqual(s.tok(), 'good', m);
            var s2 = await buildStub('held', d);          // held token not rejected: kept
            await s2.P.refreshInstances();
            assert.strictEqual(s2.tok(), 'held', m);
            assert.deepStrictEqual(s2.sets, [], m);
        }
    }, { tags: ['unit'], timeout: 5000 });

    test('proxy 503 / 429 on a single tab token: not sessionOk, worker token kept', async function() {
        var codes = [503, 429];
        for (var i = 0; i < codes.length; i++) {
            var m = 'status ' + codes[i];
            var rs = {}; rs.bad = codes[i];
            var a = await build({ tabs: [{ id: 1, origin: O, token: 'bad', userName: 'admin' }], valid: ['bad'], rolesStatus: rs });
            var d = await a.detailed();
            assert.strictEqual(d[0].token, 'bad', m);
            assert.strictEqual(d[0].sessionOk, false, m);
            assert.deepStrictEqual(d[0].rejectedTokens, [], m);
            var s = await buildStub('good', d);
            await s.P.refreshInstances();
            assert.strictEqual(s.tok(), 'good', m);
            assert.strictEqual(await s.P.getTokenForInstance(O), 'good', m);
            assert.deepStrictEqual(s.sets, [], m);
        }
    }, { tags: ['unit'], timeout: 5000 });

    test('roles read network error: 2xx identity probe proves it; else held token was 401d', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'dead', userName: 'admin' }, { id: 2, origin: O, token: 'good' }], valid: ['good'], rolesThrow: true });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, 'good');
        assert.strictEqual(d[0].sessionOk, true);   // name probe answered 2xx
        var b = await build({ tabs: DEAD_THEN_GOOD, valid: ['good'], rolesThrow: true });
        var d2 = await b.detailed();
        assert.strictEqual(d2[0].sessionOk, false);   // no probe answered: not proof by itself
        var s = await buildStub('dead', d2);          // ...but the held token was 401d, this one was not
        await s.P.refreshInstances();
        assert.strictEqual(s.tok(), 'good');
        var s2 = await buildStub('held', d2);         // held token NOT among the rejected: kept
        await s2.P.refreshInstances();
        assert.strictEqual(s2.tok(), 'held');
    }, { tags: ['unit'], timeout: 5000 });

    test('every token 401: nothing adopted, worker token kept', async function() {
        var a = await build({ tabs: DEAD_THEN_GOOD.map(function(t) { return { id: t.id, origin: O, token: t.id === 1 ? 'd1' : 'd2', userName: 'admin' }; }), valid: [] });
        var d = await a.detailed();
        assert.strictEqual(d[0].token, '');
        assert.strictEqual(d[0].sessionOk, false);
        assert.deepStrictEqual(d[0].rejectedTokens, ['d1', 'd2']);
        var s = await buildStub('d1', d);
        await s.P.refreshInstances();
        assert.strictEqual(s.tok(), 'd1');
        assert.deepStrictEqual(s.sets, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('a 401-rejected token is never adopted, even if flagged sessionOk', async function() {
        var s = await buildStub('dead', [{ url: O, token: 'x', roles: [], sessionOk: true, rejectedTokens: ['dead', 'x'], tabs: [] }]);
        await s.P.refreshInstances();
        assert.strictEqual(s.tok(), 'dead');
        assert.deepStrictEqual(s.sets, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('single healthy tab with a 403 roles read: one request, no extra validation', async function() {
        var a = await build({ tabs: [{ id: 1, origin: O, token: 'good', userName: 'admin' }], valid: ['good'], rolesStatus: { good: 403 } });
        var d = await a.detailed();
        assert.deepStrictEqual(a.calls, ['good']);   // roles read only (name known)
        assert.strictEqual(d[0].sessionOk, true);
        assert.deepStrictEqual(d[0].rejectedTokens, []);
        var b = await build({ tabs: [{ id: 1, origin: O, token: 'good', userName: 'admin' }], valid: ['good'] });
        await b.detailed();
        assert.deepStrictEqual(b.calls, ['good']);   // unchanged baseline
    }, { tags: ['unit'], timeout: 5000 });
});

// Panel validateToken(): real source from platform-bridge.js (+ its persist helper).
async function buildValidate(valid, recoverWith) {
    var src = await loadFile('src/platform/extension/platform-bridge.js');
    var w = { sessionToken: 'dead' }, stored = {}, msgs = [], pings = [];
    var chrome = {
        runtime: { lastError: null, sendMessage: function(m, cb) { msgs.push(m); setTimeout(function() { cb({ token: recoverWith }); }, 0); } },
        storage: { local: { set: function(o) { Object.assign(stored, o); } } }
    };
    var origFetch = { call: function(_w, url, opts) { var t = opts.headers['X-UserToken']; pings.push(t); return Promise.resolve({ status: valid.indexOf(t) !== -1 ? 200 : 401 }); } };
    var body = 'var _snStatusState = "";\n' + extractFn(src, '_adoptRecoveredToken') + '\n' + extractFn(src, 'validateToken') +
        '\nreturn { run: validateToken, state: function() { return _snStatusState; } };';
    var api = new Function('window', 'chrome', 'Platform', '_origFetch', 'updateSnStatus', body)(w, chrome, { instanceUrl: O }, origFetch, function() {});
    api.w = w; api.stored = stored; api.msgs = msgs; api.pings = pings;
    return api;
}
function settle() { return new Promise(function(r) { setTimeout(r, 20); }); }

describe('panel validateToken sibling recovery', function() {
    test('dead token + healthy sibling: recovers once, connected, persisted', async function() {
        var a = await buildValidate(['good'], 'good');
        a.run(); await settle();
        assert.strictEqual(a.state(), 'connected');
        assert.strictEqual(a.w.sessionToken, 'good');
        assert.strictEqual(a.stored.sessionToken, 'good');
        assert.strictEqual(a.msgs.length, 1);
        assert.strictEqual(a.msgs[0].excludeToken, 'dead');
        assert.strictEqual(a.msgs[0].validate, true);
        assert.deepStrictEqual(a.pings, ['dead', 'good']);
    }, { tags: ['unit'], timeout: 5000 });

    test('two dead tabs: single recovery attempt, then disconnected (no ping-pong)', async function() {
        var a = await buildValidate([], 'dead2');
        a.run(); await settle();
        assert.strictEqual(a.state(), 'disconnected');
        assert.strictEqual(a.w.sessionToken, '');
        assert.strictEqual(a.msgs.length, 1);
        assert.deepStrictEqual(a.pings, ['dead', 'dead2']);
    }, { tags: ['unit'], timeout: 5000 });

    test('recovery returns the same failed token or nothing: disconnected, no re-ping', async function() {
        var a = await buildValidate([], 'dead');
        a.run(); await settle();
        assert.strictEqual(a.state(), 'disconnected');
        assert.deepStrictEqual(a.pings, ['dead']);
        var b = await buildValidate([], '');
        b.run(); await settle();
        assert.strictEqual(b.state(), 'disconnected');
        assert.deepStrictEqual(b.pings, ['dead']);
    }, { tags: ['unit'], timeout: 5000 });

    test('healthy token: no recovery message at all', async function() {
        var a = await buildValidate(['dead'], 'x');
        a.run(); await settle();
        assert.strictEqual(a.state(), 'connected');
        assert.strictEqual(a.msgs.length, 0);
    }, { tags: ['unit'], timeout: 5000 });
});
