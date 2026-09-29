// maint detection: shared snMaintEligible/snDetectMaint (core/150-record-helpers.js)
// and every caller (tools/020 _rsCheckAdmin + list_instances, background.js
// snGetInstancesDetailed, platform-bridge _ensureActiveRoles). Asserts request counts.
describe('maint detection', function() {
    var URL = 'https://dev1.service-now.com';
    function jsonRes(status, body) { return { ok: status >= 200 && status < 300, status: status, json: async function() { return body; } }; }
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('marker missing: ' + start);
        return text.slice(a, b);
    }
    // Router: admin-lookup (gate) / direct roles / sys_properties probe.
    function router(o) {
        o = o || {};
        return function(url) {
            var u = decodeURIComponent(url);
            if (u.indexOf('/sys_properties?') !== -1) { if (o.probeThrow) throw new Error('network'); return o.probe || jsonRes(200, { result: [{ sys_id: 'p' }] }); }
            if (u.indexOf('role.name=admin') !== -1) return o.adminLookup || jsonRes(200, { result: [] });
            if (u.indexOf('/sys_user_has_role?') !== -1) { if (o.rolesThrow) throw new Error('network'); return o.roles || jsonRes(200, { result: [] }); }
            if (u.indexOf('/sys_user?') !== -1) return jsonRes(200, { result: [] });
            return jsonRes(404, {});
        };
    }
    async function mods(instances, fetchImpl) {
        var calls = [];
        var m = await loadModules(['src/js/core/150-record-helpers.js', 'src/js/tools/020-tool-execution.js'], { globals: {
            Platform: { instances: instances, instanceUrl: URL },
            fetch: async function(url, opts) { calls.push(decodeURIComponent(url)); return fetchImpl(url, opts); },
            console: console
        } });
        return { m: m, calls: calls, probes: function() { return calls.filter(function(c) { return c.indexOf('sys_properties') !== -1; }).length; } };
    }

    test('snMaintEligible: only a successful 0-role probe with no / maint name', async function() {
        var f = await mods([], router());
        assert.strictEqual(f.m.snMaintEligible([], true, ''), true);
        assert.strictEqual(f.m.snMaintEligible([], true, 'maint'), true);
        assert.strictEqual(f.m.snMaintEligible(['itil'], true, ''), false);
        assert.strictEqual(f.m.snMaintEligible([], true, 'alice'), false);
        assert.strictEqual(f.m.snMaintEligible([], false, ''), false);
    }, { tags: ['unit'] });
    test('snDetectMaint: ONE sys_properties request; 200 + >=1 row => maint', async function() {
        var f = await mods([], router());
        assert.strictEqual(await f.m.snDetectMaint(URL, 't1'), true);
        assert.strictEqual(f.calls.length, 1);
        assert.ok(f.calls[0].indexOf('/api/now/table/sys_properties?sysparm_limit=1') !== -1);
    }, { tags: ['unit'] });
    test('snDetectMaint: 403 / 401 / empty / error body / network => false', async function() {
        var cases = [{ probe: jsonRes(403, {}) }, { probe: jsonRes(401, {}) }, { probe: jsonRes(200, { result: [] }) },
            { probe: jsonRes(200, { error: { message: 'x' } }) }, { probe: { ok: true, status: 200, json: async function() { throw new Error('bad json'); } } }, { probeThrow: true }];
        for (var i = 0; i < cases.length; i++) {
            var f = await mods([], router(cases[i]));
            assert.strictEqual(await f.m.snDetectMaint(URL, 't' + i), false, 'case ' + i);
        }
    }, { tags: ['unit'] });
    test('cache: second call no re-probe; token change => re-probe; network error not cached', async function() {
        var f = await mods([], router());
        await f.m.snDetectMaint(URL, 'tA'); await f.m.snDetectMaint(URL + '/', 'tA');
        assert.strictEqual(f.probes(), 1);
        await f.m.snDetectMaint(URL, 'tB');
        assert.strictEqual(f.probes(), 2);
        var g = await mods([], router({ probeThrow: true }));
        await g.m.snDetectMaint(URL, 'tA'); await g.m.snDetectMaint(URL, 'tA');
        assert.strictEqual(g.calls.length, 2);
    }, { tags: ['unit'] });

    test('gate: user with roles => admin lookup only, ZERO maint probes', async function() {
        var f = await mods([{ url: URL, shortName: 'dev1', userName: '', roles: ['itil'] }], router());
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tok')).ok, false);
        assert.strictEqual(f.calls.length, 1); assert.strictEqual(f.probes(), 0);
    }, { tags: ['unit'] });
    test('gate: known non-maint name => ZERO maint probes', async function() {
        var f = await mods([{ url: URL, shortName: 'dev1', userName: 'erin', roles: [] }], router());
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tok')).ok, false);
        assert.strictEqual(f.probes(), 0);
    }, { tags: ['unit'] });
    test('gate: failed admin lookup (401) => ZERO maint probes, refused', async function() {
        var f = await mods([{ url: URL, shortName: 'dev1', userName: '', roles: [] }], router({ adminLookup: jsonRes(401, {}) }));
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tok')).ok, false);
        assert.strictEqual(f.probes(), 0);
    }, { tags: ['unit'] });
    test('gate allows maint with exactly ONE probe; second call cached (0 requests)', async function() {
        var f = await mods([{ url: URL, shortName: 'dev1', userName: '', roles: [] }], router());
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tok')).ok, true);
        assert.strictEqual(f.probes(), 1); assert.strictEqual(f.calls.length, 2);
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tok')).ok, true);
        assert.strictEqual(f.calls.length, 2);
    }, { tags: ['unit'] });
    test('gate: cached maint roles => ZERO requests; pass does not survive a token switch', async function() {
        var f = await mods([{ url: URL, shortName: 'dev1', userName: 'maint', roles: ['maint', 'admin'], isMaint: true }], router());
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tok')).ok, true);
        assert.strictEqual(f.calls.length, 0);
        var g = await mods([{ url: URL, shortName: 'dev1', userName: '', roles: [] }], router());
        assert.strictEqual((await g.m._rsCheckAdmin(URL, 'tokA')).ok, true);
        var n = g.calls.length;
        await g.m._rsCheckAdmin(URL, 'tokB');
        assert.ok(g.calls.length > n, 'new token must re-check');
    }, { tags: ['unit'] });
    test('gate: maint probe 403 => refused', async function() {
        var f = await mods([{ url: URL, shortName: 'dev1', userName: '', roles: [] }], router({ probe: jsonRes(403, {}) }));
        assert.strictEqual((await f.m._rsCheckAdmin(URL, 'tok')).ok, false);
    }, { tags: ['unit'] });

    test('background snGetInstancesDetailed: maint marked with ONE probe; roles/named/failed => ZERO probes', async function() {
        var bg = await loadFile('src/platform/extension/background.js');
        assert.strictEqual(bg.indexOf('function snDetectMaint'), -1, 'no local copy — uses the shared helper');
        var src = between(bg, '// Probe one tab for { token, userName }', '// Probe a fresh g_ck for a specific instance URL');
        async function run(o, userName) {
            var f = await mods([], router(o));
            var chrome = { scripting: { executeScript: async function() { return [{ result: { token: 'tk', userName: userName || '' } }]; } },
                storage: { local: { get: function(k, cb) { cb({}); } } } };
            var fn = new Function('chrome', 'fetch', 'getSnTabList', 'snMaintEligible', 'snDetectMaint', src + '\nreturn snGetInstancesDetailed;')(
                chrome, function(u, op) { f.calls.push(decodeURIComponent(u)); return router(o)(u, op); },
                async function() { return [{ id: 1, origin: URL, title: 't', url: URL + '/' }]; }, f.m.snMaintEligible,
                function(u, t) { return f.m.snDetectMaint(u, t, function(x, op) { f.calls.push(decodeURIComponent(x)); return router(o)(x, op); }); });
            return { list: await fn(), f: f };
        }
        var r = await run({}, '');
        assert.strictEqual(r.list[0].isMaint, true); assert.deepStrictEqual(r.list[0].roles, ['maint', 'admin']);
        assert.strictEqual(r.f.probes(), 1);
        var r2 = await run({ roles: jsonRes(200, { result: [{ 'role.name': 'itil' }] }) }, '');
        assert.strictEqual(r2.list[0].isMaint, false); assert.strictEqual(r2.f.probes(), 0);
        var r3 = await run({}, 'alice');
        assert.strictEqual(r3.f.probes(), 0);
        var r4 = await run({ roles: jsonRes(403, {}) }, '');
        assert.strictEqual(r4.f.probes(), 0);
        var r5 = await run({ rolesThrow: true }, '');
        assert.strictEqual(r5.f.probes(), 0);
    }, { tags: ['unit'] });

    test('platform-bridge _ensureActiveRoles: uses shared helper; probes only for 0 roles + no name', async function() {
        var pb = await loadFile('src/platform/extension/platform-bridge.js');
        assert.strictEqual(pb.indexOf('_detectMaintActive'), -1);
        var src = between(pb, '    var _activeRolesFetchedFor = ', '    // Refresh the full instance list from background');
        async function run(o, userName) {
            var f = await mods([], router(o));
            var win = { sessionToken: 'st' };
            var P = { instanceUrl: URL, instances: [] };
            var inst = { url: URL, roles: [], userName: userName || '' };
            P.instances.push(inst);
            var fn = new Function('window', 'Platform', '_origFetch', '_instanceDropdown', 'renderInstanceDropdown', 'snMaintEligible', 'snDetectMaint', src + '\nreturn _ensureActiveRoles;')(
                win, P, function(u, op) { f.calls.push(decodeURIComponent(u)); return Promise.resolve(router(o)(u, op)); }, null, function() {},
                f.m.snMaintEligible, f.m.snDetectMaint);
            fn(inst, P.instances);
            for (var i = 0; i < 20; i++) await Promise.resolve();
            await new Promise(function(r) { setTimeout(r, 5); });
            return { inst: inst, f: f };
        }
        var r = await run({}, '');
        assert.strictEqual(r.inst.isMaint, true); assert.deepStrictEqual(r.inst.roles, ['maint', 'admin']); assert.strictEqual(r.f.probes(), 1);
        var r2 = await run({}, 'bob'); assert.strictEqual(r2.f.probes(), 0);
        var r3 = await run({ roles: jsonRes(401, {}) }, ''); assert.strictEqual(r3.f.probes(), 0);
        var r4 = await run({ roles: jsonRes(200, { result: [{ 'role.name': 'itil' }] }) }, ''); assert.strictEqual(r4.f.probes(), 0);
    }, { tags: ['unit'] });

    test('shared helper file is in both SW build lists (single copy reaches background.js)', async function() {
        var b1 = await loadFile('build/build.js'), b2 = await loadFile('skills/extension-dev/build.js');
        assert.ok(b1.indexOf("'js/core/150-record-helpers.js'") !== -1);
        assert.ok(b2.indexOf("'src/js/core/150-record-helpers.js'") !== -1);
    }, { tags: ['unit'] });
});
