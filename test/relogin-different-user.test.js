// Log out of a ServiceNow instance and back in as a DIFFERENT user: the cached
// identity (roles / maint / user name) of the old token must never be served
// for the new token, while the same token keeps it. Real source, fake effects.
var EX = await runFile('test/extract.js', { i18n: false });
function extractFn(src, name) {
    var f = EX.findFunction(src, name);
    if (!f) throw new Error('function not found: ' + name);
    if (!(f.end > f.start)) throw new Error('unbalanced: ' + name);
    return src.slice(f.start, f.end);
}
function sleepMs(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function jsonRes(status, body) { return { ok: status >= 200 && status < 300, status: status, json: async function() { return body; } }; }
var URL = 'https://dev1.service-now.com';

// ── D1: background.js snResolveInstanceSession _partial ──
describe('D1: partial registry entry reuses the last identity only for the same token', function() {
    var B = 'https://b.service-now.com';
    var FNS = ['snTimeoutMs', 'snWithTimeout', 'snInjectBounded', 'snFetchWithTimeout', 'snLoginProbeState', 'snLoginLooksSignedIn', 'snStrictTokenOk', 'snTokenAccepted', 'snForgetRegistryOrigin',
        'snProbeTabTokenUser', 'snIsHtmlResponse', 'snResponseIsDeadInstance', 'snFetchUserName', 'snFetchUserRoles', 'snCollectTabTokens', 'snPickTabToken', 'snResolveInstanceSession', 'snRememberInstanceToken',
        'snUpdateInstanceTokens', 'snNotifyInstancesChanged', 'snGetInstancesDetailed'];
    async function build(world) {
        var src = await loadFile('src/platform/extension/background.js');
        var chrome = {
            runtime: { sendMessage: function() { return Promise.resolve(); } },
            scripting: { executeScript: async function(o) {
                var t = world.tabs.filter(function(x) { return x.id === o.target.tabId; })[0];
                return [{ result: { token: t.token, userName: t.user || '' } }];
            } },
            storage: { local: { get: function(k, cb) { setTimeout(function() { cb({}); }, 0); }, set: function() {} } }
        };
        var fetch = function(url, opts) {
            return sleepMs(world.delay || 0).then(function() {
                return { ok: true, status: 200, json: async function() { return { result: [{ 'role.name': 'admin' }] }; } };
            });
        };
        var getSnTabList = async function() { return world.tabs.map(function(t) { return { id: t.id, origin: t.origin, url: t.origin + '/', title: 't' }; }); };
        var body = 'var _snInstanceTokensQueue = Promise.resolve();\nvar snTabs = new Map();\nvar _snTokenCheckCache = new Map();\nvar SN_TOKEN_CHECK_TTL_MS = 30000;\nvar snMaintCached = undefined;\n' +
            FNS.map(function(n) { return extractFn(src, n); }).join('\n') + '\nreturn { detailed: snGetInstancesDetailed, notify: snNotifyInstancesChanged };';
        var self = { __snRegistryMs: world.registryMs || 300, __snTimeouts: { tab: 2000, fetch: 3000 } };
        return new Function('chrome', 'fetch', 'getSnTabList', 'self', body)(chrome, fetch, getSnTabList, self);
    }
    function cleanup(a) { var st = a.detailed._st; if (st && st.notifyTimer) Object.keys(st.notifyTimer).forEach(function(k) { clearTimeout(st.notifyTimer[k]); }); }

    test('token change: the partial entry drops the old roles / maint / user name', async function() {
        var world = { tabs: [{ id: 2, origin: B, token: 'tokA', user: 'alice' }], registryMs: 1500 };
        var a = await build(world);
        var d1 = await a.detailed();
        assert.ok(!d1[0].partial);
        assert.deepStrictEqual(d1[0].roles, ['admin']);
        var last = a.detailed._st.last[B];
        last.isMaint = true;   // the old session was maint
        // Signed out and back in as bob: new token, slow origin -> partial entry.
        world.tabs[0] = { id: 2, origin: B, token: 'tokB', user: '' };
        world.delay = 2000; world.registryMs = 150;
        a.notify(B);
        var d2 = await a.detailed();
        assert.strictEqual(d2[0].partial, true);
        assert.strictEqual(d2[0].token, 'tokB');
        assert.deepStrictEqual(d2[0].roles, [], 'old user roles not inherited');
        assert.strictEqual(d2[0].isMaint, false);
        assert.notStrictEqual(d2[0].userName, 'alice', 'old user name not inherited');
        await sleepMs(2300); cleanup(a);
    }, { tags: ['unit'], timeout: 8000 });
});

// ── N1: tools/020 _rsCheckAdmin fast path ──
describe('N1: run-script admin gate fast path requires the cached token', function() {
    async function fixture(instances, fetchImpl) {
        var calls = [];
        var g = { Platform: { instances: instances, instanceUrl: URL }, fetch: async function(url, opts) { calls.push(url); return fetchImpl(url, opts); }, console: console };
        var m = await loadModules(['src/js/core/150-record-helpers.js', 'src/js/tools/020-tool-execution.js'], { globals: g });
        return { m: m, calls: calls };
    }
    test('stale-token admin entry does NOT pass the fast path (live check refuses)', async function() {
        var f = await fixture([{ url: URL, shortName: 'dev1', userName: 'alice', roles: ['admin'], token: 'tokA' }],
            function(u) { return jsonRes(u.indexOf('sys_properties') !== -1 ? 403 : 200, { result: [] }); });
        var r = await f.m._rsCheckAdmin(URL, 'tokB');
        assert.strictEqual(r.ok, false);
        assert.ok(f.calls.length >= 1, 'live lookup ran');
        assert.ok(r.error.indexOf('alice') === -1, 'old user name not used for the new token');
    }, { tags: ['unit'] });
    test('stale maint entry does not pass either', async function() {
        var f = await fixture([{ url: URL, shortName: 'dev1', userName: 'maint', roles: ['maint', 'admin'], isMaint: true, token: 'tokA' }],
            function(u) { return jsonRes(u.indexOf('sys_properties') !== -1 ? 403 : 200, { result: [] }); });
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tokB')).ok, false);
    }, { tags: ['unit'] });
    test('matching token still passes with zero requests', async function() {
        var f = await fixture([{ url: URL, shortName: 'dev1', userName: 'alice', roles: ['admin'], token: 'tokA' }],
            function() { throw new Error('should not fetch'); });
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tokA')).ok, true);
        assert.strictEqual(f.calls.length, 0);
    }, { tags: ['unit'] });
});

// ── 401: worker/010 Platform.refreshTokenAfter401 ──
describe('401 refresh clears the old token roles', function() {
    // Same harness as test/session-retry-401.test.js buildStub.
    async function stub(probed, inst) {
        var src = await loadFile('src/js/worker/010-platform-stub.js');
        var chrome = {
            storage: { local: { get: function(k, cb) { cb({ sessionToken: 'other', instanceUrl: 'https://x.service-now.com' }); }, set: function() {} },
                onChanged: { addListener: function() {} } },
            notifications: { create: function() {} }
        };
        var self = { __snProbeDeadlineMs: 200, fetch: function() { return Promise.resolve({ status: 200 }); }, snGetTokenForInstance: function() { return Promise.resolve(probed); } };
        var P = new Function('Platform', 'chrome', 'self', src + '\nreturn Platform;')(null, chrome, self);
        await P.ready;
        P.instances = [inst];
        return P;
    }
    test('replacement token: roles + isMaint cleared, new token set', async function() {
        var P = await stub({ token: 'tokB', userName: 'bob' }, { url: URL, token: 'tokA', userName: 'alice', roles: ['admin'], isMaint: true });
        assert.strictEqual(await P.refreshTokenAfter401(URL, 'tokA'), 'tokB');
        assert.strictEqual(P.instances[0].token, 'tokB');
        assert.deepStrictEqual(P.instances[0].roles, []);
        assert.strictEqual(P.instances[0].isMaint, false);
        assert.strictEqual(P.instances[0].userName, 'bob');
    }, { tags: ['unit'] });
    test('replacement token with an empty probed userName: old user name cleared', async function() {
        var P = await stub({ token: 'tokB', userName: '' }, { url: URL, token: 'tokA', userName: 'alice', roles: ['admin'] });
        assert.strictEqual(await P.refreshTokenAfter401(URL, 'tokA'), 'tokB');
        assert.strictEqual(P.instances[0].token, 'tokB');
        assert.strictEqual(P.instances[0].userName, '', 'alice must not survive on the tokB entry');
        assert.deepStrictEqual(P.instances[0].roles, []);
    }, { tags: ['unit'] });
    test('no replacement token: old user name cleared too', async function() {
        var P = await stub(null, { url: URL, token: 'tokA', userName: 'alice', roles: ['admin'] });
        assert.strictEqual(await P.refreshTokenAfter401(URL, 'tokA'), '');
        assert.strictEqual(P.instances[0].token, '');
        assert.strictEqual(P.instances[0].userName, '');
    }, { tags: ['unit'] });
    test('after the refresh, a maint-eligible new user is still maint-probed by _rsCheckAdmin', async function() {
        var P = await stub({ token: 'tokB', userName: '' }, { url: URL, shortName: 'dev1', token: 'tokA', userName: 'alice', roles: ['admin'] });
        await P.refreshTokenAfter401(URL, 'tokA');
        var calls = [];
        var g = { Platform: { instances: P.instances, instanceUrl: URL }, console: console,
            fetch: async function(u) { calls.push(u); return jsonRes(200, { result: u.indexOf('sys_properties') !== -1 ? [{ sys_id: 'p1' }] : [] }); } };
        var m = await loadModules(['src/js/core/150-record-helpers.js', 'src/js/tools/020-tool-execution.js'], { globals: g });
        var r = await m._rsCheckAdmin(URL, 'tokB');
        assert.strictEqual(r.ok, true, 'maint login passes the gate');
        assert.ok(calls.some(function(u) { return u.indexOf('sys_properties') !== -1; }), 'maint probe ran (stale name would have skipped it)');
    }, { tags: ['unit'] });
    test('entry already on the fresh token keeps its roles', async function() {
        var P = await stub({ token: 'tokB', userName: 'bob' }, { url: URL, token: 'tokB', userName: 'bob', roles: ['itil'] });
        await P.refreshTokenAfter401(URL, 'tokA');
        assert.deepStrictEqual(P.instances[0].roles, ['itil']);
    }, { tags: ['unit'] });
});

// ── worker/010 refreshInstances: active origin missing from the probe ──
describe('refreshInstances: missing active origin carries identity only for the held token', function() {
    async function stub(worker, prevEntry) {
        var src = await loadFile('src/js/worker/010-platform-stub.js');
        var chrome = {
            storage: { local: { get: function(k, cb) { cb({ sessionToken: worker, instanceUrl: URL }); }, set: function() {} },
                onChanged: { addListener: function() {} } },
            notifications: { create: function() {} }
        };
        var self = { fetch: async function() { return { status: 200 }; },
            snGetInstancesDetailed: async function() { return []; },
            snGetTokenForInstance: async function() { return null; } };
        var P = new Function('Platform', 'chrome', 'self', src + '\nreturn Platform;')(null, chrome, self);
        await P.ready; await sleepMs(0);
        P.instances = [prevEntry];
        return P;
    }
    test('same user (prev entry on the held token, Memory-Saver case): identity kept', async function() {
        var P = await stub('held', { url: URL, token: 'held', userName: 'alice', roles: ['admin'] });
        var list = await P.refreshInstances();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].token, '');
        assert.strictEqual(list[0].userName, 'alice');
        assert.deepStrictEqual(list[0].roles, ['admin']);
    }, { tags: ['unit'] });
    test('different token (prev entry belongs to another session): identity dropped', async function() {
        var P = await stub('held', { url: URL, token: 'tokA', userName: 'alice', roles: ['admin'] });
        var list = await P.refreshInstances();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].userName, '');
        assert.deepStrictEqual(list[0].roles, []);
    }, { tags: ['unit'] });
});

// ── connect_instance wrapper passthrough ──
describe('connect_instance passes userMismatch + note through', function() {
    async function run(bgRes) {
        var g = {
            Platform: { instances: [], instanceUrl: '', resolveInstanceUrl: function(x) { return x; }, refreshInstances: async function() {} },
            chrome: { storage: { local: { get: function(k, cb) { cb({}); } } } },
            self: { snAutoLogin: async function() { return bgRes; } },
            requestProgrammaticToolApproval: async function() { return { allowed: true }; },
            console: console
        };
        var m = await loadModules(['src/js/core/150-record-helpers.js', 'src/js/tools/020-tool-execution.js'], { globals: g, lenient: true });
        return m.executeTool('connect_instance', { instance: URL, username: 'bob', password: 'pw' }, {});
    }
    test('mismatch: success stays true, userMismatch + note returned', async function() {
        var r = await run({ success: true, alreadyConnected: true, instance: URL, userName: 'alice', tabId: 7, userMismatch: true, note: 'signed in as alice' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.alreadyConnected, true);
        assert.strictEqual(r.userMismatch, true);
        assert.strictEqual(r.note, 'signed in as alice');
        assert.strictEqual(r.userName, 'alice');
        assert.ok(JSON.stringify(r).indexOf('"pw"') === -1, 'password never echoed');
    }, { tags: ['unit'] });
    test('same user: no userMismatch / note keys', async function() {
        var r = await run({ success: true, alreadyConnected: true, instance: URL, userName: 'bob', tabId: 7 });
        assert.strictEqual(r.success, true);
        assert.ok(!('userMismatch' in r) && !('note' in r));
    }, { tags: ['unit'] });
});

// ── N2: platform-bridge _reconcileActiveToken / _ensureActiveRoles ──
describe('N2: panel active-instance identity carry-over is per token', function() {
    async function bridge(win, instances, fetchImpl, maint) {
        var src = await loadFile('src/platform/extension/platform-bridge.js');
        var calls = [];
        var Platform = { instanceUrl: URL, instances: instances };
        var body = 'var _activeRolesFetchedFor = "";\nvar _instanceDropdown = null;\nvar _snActiveDead = null;\n' + extractFn(src, '_reconcileActiveToken') + '\n' + extractFn(src, '_ensureActiveRoles') +
            '\nreturn { reconcile: _reconcileActiveToken, ensure: _ensureActiveRoles };';
        var origFetch = function(u) { calls.push(u); return Promise.resolve(fetchImpl(u)); };
        var api = new Function('Platform', 'window', '_normUrl', '_origFetch', 'snMaintEligible', 'snDetectMaint', 'renderInstanceDropdown', body)(
            Platform, win, function(u) { return String(u || '').replace(/\/+$/, ''); }, origFetch,
            (maint && maint.eligible) || function() { return false; }, (maint && maint.detect) || async function() { return false; }, function() {});
        api.calls = calls; api.Platform = Platform;
        return api;
    }
    test('same token: roles + user name carried forward', async function() {
        var b = await bridge({ sessionToken: 'tokA' }, [{ url: URL, token: 'tokA', userName: 'alice', roles: ['admin'] }], function() { return jsonRes(200, { result: [] }); });
        var out = b.reconcile([{ url: URL, token: '', roles: [], userName: '', tabs: [{ id: 1 }] }]);
        assert.deepStrictEqual(out[0].roles, ['admin']);
        assert.strictEqual(out[0].userName, 'alice');
        // An origin the probe missed is pushed with no token -> no identity either.
        var miss = b.reconcile([]);
        assert.strictEqual(miss[0].token, '');
        assert.deepStrictEqual(miss[0].roles, []);
        assert.strictEqual(miss[0].userName, '');
    }, { tags: ['unit'] });
    test('token change: no carry-over (inserted or probed entry)', async function() {
        var b = await bridge({ sessionToken: 'tokB' }, [{ url: URL, token: 'tokA', userName: 'alice', roles: ['admin'] }], function() { return jsonRes(200, { result: [] }); });
        var out = b.reconcile([{ url: URL, token: '', roles: [], userName: '', tabs: [{ id: 1 }] }]);
        assert.strictEqual(out[0].token, 'tokB');
        assert.deepStrictEqual(out[0].roles, []);
        assert.strictEqual(out[0].userName, '');
        var miss = b.reconcile([]);
        assert.strictEqual(miss[0].token, '');
        assert.deepStrictEqual(miss[0].roles, []);
        assert.strictEqual(miss[0].userName, '');
    }, { tags: ['unit'] });
    test('_ensureActiveRoles: once per token, re-fetches for a new token', async function() {
        var win = { sessionToken: 'tokA' };
        var b = await bridge(win, [{ url: URL }], function() { return jsonRes(200, { result: [{ 'role.name': 'itil' }] }); });
        b.ensure({ url: URL, roles: [] }, []);
        b.ensure({ url: URL, roles: [] }, []);
        assert.strictEqual(b.calls.length, 1, 'guarded for the same token');
        win.sessionToken = 'tokB';
        var inst = { url: URL, roles: [] };
        b.ensure(inst, []);
        assert.strictEqual(b.calls.length, 2, 'new token re-fetches');
        await sleepMs(20);
        assert.deepStrictEqual(inst.roles, ['itil']);
    }, { tags: ['unit'] });
    test('_ensureActiveRoles: a late response for the old token does not touch the new token entries', async function() {
        var win = { sessionToken: 'tokA' };
        var release;
        var gate = new Promise(function(r) { release = r; });
        var b = await bridge(win, [{ url: URL, token: 'tokA', roles: [] }],
            function() { return gate.then(function() { return jsonRes(200, { result: [{ 'role.name': 'admin' }] }); }); });
        var instA = { url: URL, token: 'tokA', roles: [] };
        b.ensure(instA, []);
        // User switch before the response lands.
        win.sessionToken = 'tokB';
        b.Platform.instances = [{ url: URL, token: 'tokB', userName: 'bob', roles: [] }];
        release(); await sleepMs(20);
        assert.deepStrictEqual(b.Platform.instances[0].roles, [], 'old user roles not written onto tokB');
        assert.strictEqual(b.Platform.instances[0].userName, 'bob');
    }, { tags: ['unit'] });
    test('_ensureActiveRoles: patches only entries on the fetched token', async function() {
        var win = { sessionToken: 'tokA' };
        var b = await bridge(win, [{ url: URL, token: 'tokA', roles: [] }, { url: URL, token: 'tokB', roles: [] }, { url: URL, roles: [] }],
            function() { return jsonRes(200, { result: [{ 'role.name': 'itil' }] }); });
        b.ensure({ url: URL, roles: [] }, []);
        await sleepMs(20);
        assert.deepStrictEqual(b.Platform.instances[0].roles, ['itil']);
        assert.deepStrictEqual(b.Platform.instances[1].roles, [], 'other-token entry untouched');
        assert.deepStrictEqual(b.Platform.instances[2].roles, ['itil'], 'token-less entry patched');
    }, { tags: ['unit'] });
    test('_ensureActiveRoles: late maint follow-up for the old token is ignored', async function() {
        var win = { sessionToken: 'tokA' };
        var releaseM;
        var mGate = new Promise(function(r) { releaseM = r; });
        var detectTok = null;
        var b = await bridge(win, [{ url: URL, token: 'tokA', roles: [] }], function() { return jsonRes(200, { result: [] }); },
            { eligible: function() { return true; }, detect: function(u, t) { detectTok = t; return mGate.then(function() { return true; }); } });
        var instA = { url: URL, token: 'tokA', roles: [] };
        b.ensure(instA, []);
        await sleepMs(10);
        assert.strictEqual(detectTok, 'tokA', 'maint probe uses the captured token');
        win.sessionToken = 'tokB';
        b.Platform.instances = [{ url: URL, token: 'tokB', userName: 'bob', roles: [] }];
        releaseM(); await sleepMs(20);
        assert.deepStrictEqual(b.Platform.instances[0].roles, []);
        assert.ok(!b.Platform.instances[0].isMaint);
        assert.strictEqual(b.Platform.instances[0].userName, 'bob');
    }, { tags: ['unit'] });
});
