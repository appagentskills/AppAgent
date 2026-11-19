// Instance registry latency (background.js snGetInstancesDetailed): origins
// resolve in PARALLEL under one overall deadline; a slow origin comes back as a
// partial entry and a notify fires when its late resolve lands. Also the 5s caps
// on list_instances' registry wait (020-tool-execution.js) and the panel
// validateToken touch-session (platform-bridge.js). Real source, fake effects.

var EX = await runFile('test/extract.js', { i18n: false });
function extractFn(src, name) {
    var f = EX.findFunction(src, name);
    if (!f) throw new Error('function not found: ' + name);
    if (!(f.end > f.start)) throw new Error('unbalanced: ' + name);
    return src.slice(f.start, f.end);
}
function sleepMs(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

var A = 'https://a.service-now.com', B = 'https://b.service-now.com';
var FNS = ['snTimeoutMs', 'snWithTimeout', 'snInjectBounded', 'snFetchWithTimeout', 'snLoginProbeState', 'snLoginLooksSignedIn', 'snStrictTokenOk', 'snTokenAccepted', 'snForgetRegistryOrigin',
    'snProbeTabTokenUser', 'snFetchUserName', 'snFetchUserRoles', 'snCollectTabTokens', 'snPickTabToken', 'snResolveInstanceSession', 'snRememberInstanceToken',
    'snUpdateInstanceTokens', 'snNotifyInstancesChanged', 'snGetInstancesDetailed'];

// Every registry built by a test: its queued trailing-notify timers are
// cleared after each test (no timer outlives its test).
var BUILT = [];
function cleanupBuilt() {
    BUILT.splice(0).forEach(function(a) {
        var st = a.detailed && a.detailed._st;
        if (st && st.notifyTimer) Object.keys(st.notifyTimer).forEach(function(k) { clearTimeout(st.notifyTimer[k]); delete st.notifyTimer[k]; });
    });
}

// world: { tabs: [{id, origin, token}], delay: {origin: ms}, registryMs }
async function build(world) {
    var src = await loadFile('src/platform/extension/background.js');
    var sent = [], fetched = [];
    var chrome = {
        runtime: { sendMessage: function(m) { sent.push(m); return Promise.resolve(); } },
        scripting: { executeScript: async function(o) {
            var t = world.tabs.filter(function(x) { return x.id === o.target.tabId; })[0];
            return [{ result: { token: t.token, userName: 'admin' } }];
        } },
        storage: { local: { get: function(k, cb) { setTimeout(function() { cb({}); }, 0); }, set: function() {} } }
    };
    var fetch = function(url, opts) {
        var origin = new URL(url).origin;
        var tok = opts.headers['X-UserToken'];
        fetched.push({ origin: origin, at: Date.now(), url: url });
        if (world.respond) { var rr = world.respond(url, tok); if (rr) return Promise.resolve(rr); }
        var ok = !(world.dead || []).includes(tok);
        return sleepMs((world.delay && world.delay[origin]) || 0).then(function() {
            return { ok: ok, status: ok ? 200 : 401, json: async function() { return { result: [{ 'role.name': 'admin' }] }; } };
        });
    };
    var getSnTabList = async function() {
        if (world.listHangs) return new Promise(function() {});
        return world.tabs.map(function(t) { return { id: t.id, origin: t.origin, url: t.origin + '/', title: 't' }; });
    };
    var body = 'var _snInstanceTokensQueue = Promise.resolve();\nvar snTabs = world.snTabs || new Map();\nvar _snTokenCheckCache = new Map();\nvar SN_TOKEN_CHECK_TTL_MS = 30000;\nvar snMaintCached = world.maintCached;\n' +
        FNS.map(function(n) { return extractFn(src, n); }).join('\n') +
        '\nreturn { detailed: snGetInstancesDetailed, cache: _snTokenCheckCache };';
    var self = { __snRegistryMs: world.registryMs || 400, __snTimeouts: { tab: 2000, fetch: 3000 }, __snRegistryNotifyGapMs: world.notifyGapMs };
    var api = new Function('chrome', 'fetch', 'getSnTabList', 'self', 'world', body.replace(/\nreturn \{ detailed/, '\nreturn { accepted: snTokenAccepted, notify: snNotifyInstancesChanged, pick: snPickTabToken, forget: snForgetRegistryOrigin, detailed'))(chrome, fetch, getSnTabList, self, world);
    BUILT.push(api);
    api.sent = sent; api.fetched = fetched;
    api.st = function() { return api.detailed._st; };
    api.notes = function() { return sent.filter(function(m) { return m.type === 'sn-instances-changed'; }); };
    return api;
}

describe('snGetInstancesDetailed: parallel origins under one deadline', function() {
    afterEach(cleanupBuilt);
    test('two 400ms origins resolve in parallel (not one after the other)', async function() {
        var b = await build({ tabs: [{ id: 1, origin: A, token: 'ta' }, { id: 2, origin: B, token: 'tb' }], delay: { 'https://a.service-now.com': 400, 'https://b.service-now.com': 400 }, registryMs: 2000 });
        var t0 = Date.now();
        var d = await b.detailed();
        var el = Date.now() - t0;
        assert.strictEqual(d.length, 2);
        // Loose wall-clock bound (CI load); the start-time check below is the parallelism proof.
        assert.ok(el < 1900, 'took ' + el + 'ms');
        d.forEach(function(e) { assert.ok(!e.partial, e.url + ' partial'); assert.strictEqual(e.sessionOk, true); assert.deepStrictEqual(e.roles, ['admin']); });
        // B's first request did not wait for A's to finish.
        var firstB = b.fetched.filter(function(f) { return f.origin === B; })[0].at;
        var firstA = b.fetched.filter(function(f) { return f.origin === A; })[0].at;
        assert.ok(Math.abs(firstB - firstA) < 380, 'B started ' + (firstB - firstA) + 'ms after A (sequential: >= 400)');
    }, { tags: ['unit'], timeout: 5000 });

    test('slow origin: returns within the deadline with a partial entry; no notify when the late result equals it', async function() {
        var world = { tabs: [{ id: 1, origin: A, token: 'ta' }, { id: 2, origin: B, token: 'tb' }], delay: {}, registryMs: 300 };
        var a = await build(world);
        var first = await a.detailed();   // full resolve: remembers B's roles
        assert.ok(!first[1].partial);
        a.cache.set(B + '|tb', { status: 200, user: 'admin', rows: 1, at: Date.now() });
        var lastBefore = a.st().last[B];
        world.delay[B] = 2500;
        var t0 = Date.now();
        var d = await a.detailed();
        var el = Date.now() - t0;
        assert.ok(el < 2000, 'registry took ' + el + 'ms (deadline 300, slow origin 2500)');
        var eA = d.filter(function(e) { return e.url === A; })[0], eB = d.filter(function(e) { return e.url === B; })[0];
        assert.ok(!eA.partial, 'fast origin is complete');
        assert.strictEqual(eB.partial, true);
        assert.strictEqual(eB.token, 'tb');
        assert.strictEqual(eB.sessionOk, true, 'from the token-check cache 2xx');
        assert.deepStrictEqual(eB.roles, ['admin'], 'roles from the last resolve');
        assert.strictEqual(a.notes().length, 0, 'no notify yet');
        await sleepMs(3500);
        // The late resolve really ran and landed (this is what proves the
        // no-notify branch was evaluated, not skipped).
        var lastAfter = a.st().last[B];
        assert.ok(lastAfter && lastAfter !== lastBefore, 'late resolve wrote a new last entry');
        assert.strictEqual(lastAfter.lateResolved, true, 'marked as a late resolve');
        assert.strictEqual(a.st().inflight[B], undefined, 'late run settled');
        assert.strictEqual(a.notes().length, 0, 'late entry == partial served (token, sessionOk, roles, user, maint): no notify');
    }, { tags: ['unit'], timeout: 9000 });

    test('late resolve that changes the entry notifies once; the panel refresh is served from it without re-resolving', async function() {
        var world = { tabs: [{ id: 2, origin: B, token: 'tb' }], delay: { 'https://b.service-now.com': 300 }, registryMs: 100 };
        var a = await build(world);
        var d1 = await a.detailed();
        assert.strictEqual(d1[0].partial, true);
        assert.strictEqual(d1[0].sessionOk, false);
        await sleepMs(1500);
        assert.strictEqual(a.notes().length, 1, 'sessionOk false -> true: notified');
        // The panel refreshes on that notify: fresh late result served, no new resolve.
        var n = a.fetched.length;
        var d2 = await a.detailed();
        assert.ok(!d2[0].partial);
        assert.strictEqual(d2[0].sessionOk, true);
        assert.strictEqual(a.fetched.length, n, 'no re-resolve');
        await sleepMs(500);
        assert.strictEqual(a.notes().length, 1, 'no refresh loop');
        // An outside change (sign-in notify) invalidates the served result.
        a.notify(B);
        await a.detailed();
        assert.ok(a.fetched.length > n, 're-resolved after an external notify');
    }, { tags: ['unit'], timeout: 6000 });

    test('late-resolve notifies are rate-limited per origin (trailing one kept)', async function() {
        var world = { tabs: [{ id: 2, origin: B, token: 'tb' }], delay: { 'https://b.service-now.com': 200 }, registryMs: 80, notifyGapMs: 3000 };
        var a = await build(world);
        await a.detailed();
        await sleepMs(800);
        assert.strictEqual(a.notes().length, 1);
        // New tab set (forces a resolve) and the old token now dead: the late
        // result changes (token tb -> tb2) inside the gap.
        world.tabs.push({ id: 3, origin: B, token: 'tb2' });
        world.dead = ['tb'];
        var d = await a.detailed();
        assert.strictEqual(d[0].partial, true);
        // first notify ~200ms; second late result ~1000ms; trailing at ~3200ms.
        await sleepMs(1000);
        assert.strictEqual(a.notes().length, 1, 'second notify held by the 3s gap');
        assert.ok(a.st().notifyTimer[B], 'trailing notify queued');
        await sleepMs(2600);
        assert.strictEqual(a.notes().length, 2, 'trailing notify after the gap');
    }, { tags: ['unit'], timeout: 9000 });

    test('partial entry skips a token the cache knows was 401 and joins the in-flight resolve', async function() {
        var world = { tabs: [{ id: 2, origin: B, token: 'dead' }, { id: 3, origin: B, token: 'good' }], delay: { 'https://b.service-now.com': 1000 }, registryMs: 150, dead: ['dead'] };
        var a = await build(world);
        a.cache.set(B + '|dead', { status: 401, at: Date.now() });
        var d1 = await a.detailed();
        assert.strictEqual(d1[0].partial, true);
        assert.strictEqual(d1[0].token, 'good');
        assert.strictEqual(d1[0].sessionOk, false, 'nothing proves the session yet');
        var before = a.fetched.length;
        var d2 = await a.detailed();
        assert.strictEqual(d2[0].partial, true);
        assert.strictEqual(a.fetched.length, before, 'second call joined the in-flight resolve');
        await sleepMs(3200);   // dead (401) then good: 2 x 1000ms, sequential within the origin
        assert.strictEqual(a.sent.length, 1, 'late resolve notified once');
        // Next call: the fresh late result is served as-is.
        var d3 = await a.detailed();
        assert.strictEqual(d3[0].token, 'good');
        assert.strictEqual(d3[0].sessionOk, true, 'last resolve proved this token');
        assert.deepStrictEqual(d3[0].roles, ['admin']);
        assert.deepStrictEqual(d3[0].rejectedTokens, ['dead']);
    }, { tags: ['unit'], timeout: 10000 });

    test('hung tab listing falls back to the tracked snTabs within the deadline', async function() {
        var snTabs = new Map([[1, { url: A + '/', title: 't', origin: A }]]);
        var a = await build({ tabs: [{ id: 1, origin: A, token: 'ta' }], listHangs: true, snTabs: snTabs, registryMs: 400 });
        var t0 = Date.now();
        var d = await a.detailed();
        assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0) + 'ms (the listing never settles)');
        assert.strictEqual(d.length, 1);
        assert.strictEqual(d[0].url, A);
        assert.strictEqual(d[0].token, 'ta');
    }, { tags: ['unit'], timeout: 5000 });

    test('default deadline is <= 4.5s', async function() {
        var src = await loadFile('src/platform/extension/background.js');
        var fn = extractFn(src, 'snGetInstancesDetailed');
        var m = fn.match(/__snRegistryMs\) \|\| (\d+)/);
        assert.ok(m && Number(m[1]) <= 4500, 'default ' + (m && m[1]));
    }, { tags: ['unit'] });
});

describe('partial entries never resurrect a stale token (H1)', function() {
    afterEach(cleanupBuilt);
    function hungRec(col, ageMs) {
        return { col: col, cacheTok: null, late: false, served: null, startedAt: Date.now() - (ageMs || 0), promise: new Promise(function() {}) };
    }
    test('an open tab was seen: the last token is not used', async function() {
        var a = await build({ tabs: [{ id: 2, origin: B, token: 'old' }], registryMs: 120 });
        await a.detailed();                       // last = { token: old, sessionOk }
        a.st().inflight[B] = hungRec({ candidates: [], sawOpenTab: true });
        var d = await a.detailed();
        assert.strictEqual(d[0].partial, true);
        assert.strictEqual(d[0].token, '', 'signed-out tab: old token not resurrected');
        assert.strictEqual(d[0].sessionOk, false);
    }, { tags: ['unit'], timeout: 4000 });

    test('no tab seen: last token used; its sessionOk kept for the same unrejected token (<5min)', async function() {
        var a = await build({ tabs: [{ id: 2, origin: B, token: 'old' }], registryMs: 120 });
        await a.detailed();
        a.st().inflight[B] = hungRec(null);
        var d = await a.detailed();
        assert.strictEqual(d[0].token, 'old');
        assert.strictEqual(d[0].sessionOk, true, 'fresh last');
        a.st().last[B].at = Date.now() - 31000;
        d = await a.detailed();
        assert.strictEqual(d[0].sessionOk, true, 'always-slow origin does not flip at 30s');
        a.st().last[B].at = Date.now() - 301000;
        d = await a.detailed();
        assert.strictEqual(d[0].token, 'old');
        assert.strictEqual(d[0].sessionOk, false, 'stale last (>5min): sessionOk not trusted');
    }, { tags: ['unit'], timeout: 4000 });

    test('partial sessionOk uses the strict rule on the token-check cache', async function() {
        var cases = [[{ status: 403, user: '', rows: -1 }, false], [{ status: 200, user: 'guest', rows: 1 }, false],
            [{ status: 200, user: '', rows: 0 }, true], [{ status: 200, user: 'bob', rows: 1 }, true]];
        for (var i = 0; i < cases.length; i++) {
            var a = await build({ tabs: [{ id: 2, origin: B, token: 'tb' }], registryMs: 120 });
            a.detailed._st = { inflight: {}, last: {} };
            a.st().inflight[B] = hungRec({ candidates: [{ token: 'tb', userName: '' }], sawOpenTab: true });
            a.cache.set(B + '|tb', Object.assign({ at: Date.now() }, cases[i][0]));
            var d = await a.detailed();
            assert.strictEqual(d[0].partial, true);
            assert.strictEqual(d[0].sessionOk, cases[i][1], 'case ' + JSON.stringify(cases[i][0]));
        }
    }, { tags: ['unit'], timeout: 4000 });

    test('a still-running resolve past the old pin window is joined, not stacked', async function() {
        var a = await build({ tabs: [{ id: 2, origin: B, token: 'tb' }], registryMs: 150 });
        a.detailed._st = { inflight: {}, last: {} };
        a.st().inflight[B] = hungRec(null, 10000);   // 10s old, still running
        var d = await a.detailed();
        assert.strictEqual(d[0].partial, true, 'joined the running resolve');
        assert.strictEqual(a.fetched.length, 0, 'no duplicate resolve started');
    }, { tags: ['unit'], timeout: 4000 });

    test('forget marks the in-flight run stale: no last write, no notify; queued notify cleared', async function() {
        var world = { tabs: [{ id: 2, origin: B, token: 'tb' }], delay: { 'https://b.service-now.com': 400 }, registryMs: 80 };
        var a = await build(world);
        var d = await a.detailed();
        assert.strictEqual(d[0].partial, true);
        var rec = a.st().inflight[B];
        assert.ok(rec, 'resolve in flight');
        var fired = false;
        a.st().notifyTimer[B] = setTimeout(function() { fired = true; }, 300);
        a.st().notifiedAt[B] = Date.now();
        a.forget(B);
        assert.strictEqual(rec.stale, true);
        assert.strictEqual(a.st().notifyTimer[B], undefined);
        assert.strictEqual(a.st().notifiedAt[B], undefined);
        await sleepMs(1200);
        assert.strictEqual(rec.done, true, 'the stale run did finish');
        assert.strictEqual(a.st().last[B], undefined, 'stale run wrote no last entry');
        assert.strictEqual(a.notes().length, 0, 'stale run did not notify');
        assert.strictEqual(fired, false, 'queued notify timer cleared');
    }, { tags: ['unit'], timeout: 4000 });

    test('a token forgotten (401) mid-run is never published by that run', async function() {
        var world = { tabs: [{ id: 2, origin: B, token: 'tb' }], delay: { 'https://b.service-now.com': 400 }, registryMs: 80 };
        var a = await build(world);
        await a.detailed();
        var rec = a.st().inflight[B];
        a.forget(B, 'tb');
        assert.deepStrictEqual(rec.deadTokens, ['tb']);
        await sleepMs(1200);
        assert.strictEqual(rec.done, true);
        assert.strictEqual(a.st().last[B], undefined);
        assert.strictEqual(a.notes().length, 0);
    }, { tags: ['unit'], timeout: 4000 });

    test('a 401 for the remembered token prunes it', async function() {
        var a = await build({ tabs: [{ id: 2, origin: B, token: 'old' }], registryMs: 300, dead: [] });
        await a.detailed();
        assert.ok(a.st().last[B]);
        a.st().inflight[B] = hungRec(null);
        a.cache.set(B + '|old', { status: 401, at: Date.now() });
        await a.accepted(B, 'old');
        assert.strictEqual(a.st().last[B], undefined);
    }, { tags: ['unit'], timeout: 4000 });

    test('a hung resolve older than the pin window is not joined', async function() {
        var a = await build({ tabs: [{ id: 2, origin: B, token: 'tb' }], registryMs: 200 });
        a.detailed._st = { inflight: {}, last: {} };
        a.st().inflight[B] = hungRec(null, 60000);
        var d = await a.detailed();
        assert.ok(!d[0].partial, 'fresh resolve started and finished');
        assert.strictEqual(d[0].sessionOk, true);
    }, { tags: ['unit'], timeout: 4000 });
});

describe('Platform stub never adopts a partial entry (H1)', function() {
    async function stub(entry) {
        var src = await loadFile('src/js/worker/010-platform-stub.js');
        var stored = { sessionToken: 'held', instanceUrl: B };
        var chrome = { storage: { local: { get: function(k, cb) { cb({ sessionToken: stored.sessionToken, instanceUrl: stored.instanceUrl }); }, set: function(o) { Object.assign(stored, o); } },
            onChanged: { addListener: function() {} } }, notifications: { create: function() {} } };
        var self = { fetch: function() { return Promise.resolve({ status: 200 }); },
            snGetInstancesDetailed: async function() { return [entry]; },
            snGetTokenForInstance: function() { return Promise.resolve({ token: '' }); } };
        var api = new Function('Platform', 'chrome', 'self', src + '\nreturn { P: Platform, tok: function() { return _workerSessionToken; } };')(null, chrome, self);
        await api.P.ready; await sleepMs(0);
        return api;
    }
    test('partial sessionOk entry: held token kept; same entry non-partial: adopted', async function() {
        var e = { url: B, token: 'guess', sessionOk: true, roles: [], tabs: [{ id: 1 }], rejectedTokens: ['held'], partial: true };
        var s = await stub(e);
        await s.P.refreshInstances();
        assert.notStrictEqual(s.tok(), 'guess');
        var s2 = await stub(Object.assign({}, e, { partial: false }));
        await s2.P.refreshInstances();
        assert.strictEqual(s2.tok(), 'guess');
    }, { tags: ['unit'], timeout: 4000 });
});

describe('snDetectMaint is bounded (H3)', function() {
    async function load() {
        var src = await loadFile('src/js/core/150-record-helpers.js');
        var s = src.indexOf('var SN_MAINT_PROBE_PATH'), e = src.indexOf('\n}\n', src.indexOf('async function snDetectMaint')) + 3;
        return new Function('fetch', src.slice(s, e) + '\nreturn snDetectMaint;')(function() { return new Promise(function() {}); });
    }
    test('hung fetch and hung body both resolve false within the budget, not cached', async function() {
        var det = await load();
        var t0 = Date.now();
        assert.strictEqual(await det(A, 't1', function() { return new Promise(function() {}); }, 150), false);
        assert.ok(Date.now() - t0 < 1000, 'fetch hang bounded: ' + (Date.now() - t0));
        t0 = Date.now();
        assert.strictEqual(await det(A, 't2', function() { return Promise.resolve({ ok: true, json: function() { return new Promise(function() {}); } }); }, 150), false);
        assert.ok(Date.now() - t0 < 1000, 'body hang bounded');
        t0 = Date.now();
        assert.strictEqual(await det(A, 't3', undefined, 150), false, 'default fetch path also bounded');
        assert.ok(Date.now() - t0 < 1000);
        // not cached: a later answer is honoured
        assert.strictEqual(await det(A, 't1', function() { return Promise.resolve({ ok: true, json: async function() { return { result: [{}] }; } }); }, 150), true);
    }, { tags: ['unit'], timeout: 5000 });
    test('budget is capped at 5s', async function() {
        var src = await loadFile('src/js/core/150-record-helpers.js');
        assert.ok(/SN_MAINT_PROBE_MAX_MS = 5000/.test(src));
        var bg = await loadFile('src/platform/extension/background.js');
        assert.ok(/snWithTimeout\(snDetectMaint\([^;]*, 5000, false\)/.test(bg), 'registry call wrapped');
    }, { tags: ['unit'] });
});

describe('strict snTokenAccepted (M1)', function() {
    afterEach(cleanupBuilt);
    function world(status, user, extra) {
        return Object.assign({ tabs: [], respond: function(url) {
            if (url.indexOf('/sys_user?') === -1) return null;
            if (status === 'hang') return new Promise(function() {});
            return { ok: status >= 200 && status < 300, status: status, json: async function() { return { result: user === undefined ? [] : [{ user_name: user }] }; } };
        } }, extra || {});
    }
    test('strict rejects guest/empty-name rows, 403, 401 and a timeout; accepts a named user', async function() {
        var cases = [[200, 'guest', false], [200, ' Guest ', false], [200, '', false], [403, 'x', false], [500, 'x', false], [200, 'admin', true], [401, 'admin', false]];
        for (var i = 0; i < cases.length; i++) {
            var a = await build(world(cases[i][0], cases[i][1]));
            assert.strictEqual(await a.accepted(A, 'tok' + i, { strict: true }), cases[i][2], 'case ' + JSON.stringify(cases[i]));
        }
        var h = await build(world('hang'));
        var t0 = Date.now();
        assert.strictEqual(await h.accepted(A, 'tokh', { strict: true, timeoutMs: 150 }), false, 'timeout rejects');
        assert.ok(Date.now() - t0 < 1500);
    }, { tags: ['unit'], timeout: 4000 });
    test('strict accepts an ESS session (2xx, zero rows)', async function() {
        var a = await build(world(200, undefined));
        assert.strictEqual(await a.accepted(A, 'ess', { strict: true }), true);
    }, { tags: ['unit'], timeout: 4000 });
    test('strict accepts maint (opts.isMaint or a cached maint detection), never on a 401', async function() {
        var a = await build(world(403, 'x'));
        assert.strictEqual(await a.accepted(A, 'm1', { strict: true, isMaint: true }), true, 'opts.isMaint');
        var b = await build(world(403, 'x', { maintCached: function(o, t) { return t === 'm2' ? true : undefined; } }));
        assert.strictEqual(await b.accepted(A, 'm2', { strict: true }), true, 'cached maint');
        assert.strictEqual(await b.accepted(A, 'm3', { strict: true }), false, 'not maint: 403 rejects');
        var c = await build(world(401, 'x'));
        assert.strictEqual(await c.accepted(A, 'm4', { strict: true, isMaint: true }), false, '401 always rejects');
    }, { tags: ['unit'], timeout: 4000 });
    test('non-strict behaviour unchanged: only 401 rejects', async function() {
        var cases = [[200, 'guest', true], [403, 'x', true], [500, 'x', true], [401, 'x', false]];
        for (var i = 0; i < cases.length; i++) {
            var a = await build(world(cases[i][0], cases[i][1]));
            assert.strictEqual(await a.accepted(A, 'tok' + i), cases[i][2], 'case ' + JSON.stringify(cases[i]));
        }
    }, { tags: ['unit'], timeout: 4000 });
});

describe('snPickTabToken: candidates checked in parallel, bounded', function() {
    afterEach(cleanupBuilt);
    test('two slow candidates are checked in parallel; the 401 one is skipped', async function() {
        var world = { tabs: [{ id: 1, origin: A, token: 'dead' }, { id: 2, origin: A, token: 'good' }], delay: { 'https://a.service-now.com': 1000 }, dead: ['dead'] };
        var a = await build(world);
        var t0 = Date.now();
        var r = await a.pick([{ id: 1, origin: A }, { id: 2, origin: A }], A, {});
        var el = Date.now() - t0;
        assert.strictEqual(r.pick.token, 'good');
        assert.deepStrictEqual(r.rejected, ['dead']);
        assert.ok(el < 1800, 'parallel: ' + el + 'ms (sequential >= 2000)');
    }, { tags: ['unit'], timeout: 5000 });
    test('the whole pick is bounded: unanswered checks are indeterminate (first candidate kept)', async function() {
        var world = { tabs: [{ id: 1, origin: A, token: 't1' }, { id: 2, origin: A, token: 't2' }], respond: function() { return new Promise(function() {}); } };
        var a = await build(world);
        var t0 = Date.now();
        var r = await a.pick([{ id: 1, origin: A }, { id: 2, origin: A }], A, { pickMs: 200 });
        assert.ok(Date.now() - t0 < 1500, 'bounded: ' + (Date.now() - t0));
        assert.strictEqual(r.pick.token, 't1');
        var src = await loadFile('src/platform/extension/background.js');
        assert.ok(/SN_PICK_TOKEN_MS = 5000;/.test(src) && /Math\.min\(SN_PICK_TOKEN_MS, opts\.pickMs/.test(src), 'cap is 5s; pickMs only lowers it');
    }, { tags: ['unit'], timeout: 5000 });
});

describe('list_instances registry wait is capped at 5s', function() {
    async function run(selfObj) {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var s = src.indexOf('        // Bounded (5s, the hard per-call cap');
        var e = src.indexOf('        // Per-instance "disabled for agent" flags', s);
        assert.ok(s > 0 && e > s, 'slice markers');
        var timers = [];
        var fakeSetTimeout = function(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
        var body = 'return (async function() {\n' + src.slice(s, e) + '\nreturn _liProbeWarning; })();';
        var p = new Function('Platform', 'self', 'setTimeout', 'clearTimeout', body)(
            { refreshInstances: function() { return new Promise(function() {}); } }, selfObj, fakeSetTimeout, function() {});
        await sleepMs(0);
        return { p: p, timers: timers };
    }
    test('a never-settling refreshInstances gives up at 5000ms (even if an override asks for more)', async function() {
        var r = await run({});
        assert.strictEqual(r.timers.length, 1);
        assert.strictEqual(r.timers[0].ms, 5000);
        r.timers[0].fn();
        var warn = await r.p;
        assert.ok(/timed out after 5s/.test(warn), warn);
        var r2 = await run({ __snListInstancesMs: 60000 });
        assert.strictEqual(r2.timers[0].ms, 5000);
        r2.timers[0].fn(); await r2.p;
    }, { tags: ['unit'], timeout: 3000 });
});

describe('panel validateToken touch-session is bounded', function() {
    async function build(winExtra) {
        var src = await loadFile('src/platform/extension/platform-bridge.js');
        var w = Object.assign({ sessionToken: 'tok' }, winExtra || {});
        var updates = 0, aborted = false, timers = [];
        var origFetch = { call: function(_w, url, opts) {
            if (opts.signal) opts.signal.addEventListener('abort', function() { aborted = true; });
            return new Promise(function() {});   // never settles, ignores abort
        } };
        var fakeSetTimeout = function(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
        var body = 'var _snStatusState = "connected";\n' + extractFn(src, '_sendMessageBounded') + '\n' + extractFn(src, '_adoptRecoveredToken') + '\n' + extractFn(src, 'validateToken') +
            '\nreturn { run: validateToken, state: function() { return _snStatusState; } };';
        if (w.__fetch401) origFetch = { call: function() { return Promise.resolve({ status: 401 }); } };
        var sentMsgs = [];
        var api = new Function('window', 'chrome', 'Platform', '_origFetch', 'updateSnStatus', 'setTimeout', 'clearTimeout', body)(
            w, { runtime: { sendMessage: function(m) { sentMsgs.push(m); } }, storage: { local: { set: function() {} } } }, { instanceUrl: A }, origFetch, function() { updates++; }, fakeSetTimeout, function() {});
        api.sentMsgs = sentMsgs;
        api.timers = timers; api.aborted = function() { return aborted; }; api.updates = function() { return updates; };
        return api;
    }
    test('a hung touch-session aborts at <= 5s and leaves the status as-is', async function() {
        var a = await build();
        a.run();
        assert.strictEqual(a.timers.length, 1);
        assert.strictEqual(a.timers[0].ms, 5000);
        a.timers[0].fn();
        await sleepMs(10);
        assert.strictEqual(a.aborted(), true);
        assert.strictEqual(a.state(), 'connected');
        var b = await build({ __snValidateMs: 60000 });
        b.run();
        assert.strictEqual(b.timers[0].ms, 5000, 'override cannot exceed 5s');
    }, { tags: ['unit'], timeout: 3000 });
    test('get-token-for-instance with no answer gives up at <= 5s', async function() {
        var a = await build({ sessionToken: '', __snTokenMsgMs: 60000 });
        a.run();
        assert.strictEqual(a.sentMsgs.length, 1);
        assert.strictEqual(a.timers.length, 1);
        assert.strictEqual(a.timers[0].ms, 5000, 'bounded at 5s');
        a.timers[0].fn();
        assert.strictEqual(a.state(), 'connected', 'no answer proves nothing: status as-is');
        // 401 then a hung recovery: disconnected once the 5s bound fires.
        var b = await build({ __fetch401: true });
        b.run();
        await sleepMs(10);
        assert.strictEqual(b.sentMsgs.length, 1, 'recovery asked');
        var t = b.timers[b.timers.length - 1];
        assert.strictEqual(t.ms, 5000);
        t.fn();
        assert.strictEqual(b.state(), 'disconnected');
    }, { tags: ['unit'], timeout: 3000 });
});
