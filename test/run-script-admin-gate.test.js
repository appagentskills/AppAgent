// servicenow_run_script admin gate (_rsCheckAdmin) + list_instances direct-roles fetch.
describe('servicenow_run_script admin gate', function() {
    async function fixture(instances, fetchImpl) {
        var calls = [];
        var g = {
            Platform: { instances: instances, instanceUrl: 'https://dev1.service-now.com' },
            fetch: async function(url, opts) { calls.push(url); return fetchImpl(url, opts); },
            console: console
        };
        var m = await loadModules(['src/js/tools/020-tool-execution.js'], { globals: g });
        return { m: m, calls: calls };
    }
    function jsonRes(status, body) {
        return { ok: status >= 200 && status < 300, status: status, json: async function() { return body; } };
    }
    var URL = 'https://dev1.service-now.com';

    test('cached direct admin role allows without a network lookup', async function() {
        var f = await fixture([{ url: URL, shortName: 'dev1', userName: 'alice', roles: ['admin'] }],
            function() { throw new Error('should not fetch'); });
        var r = await f.m._rsCheckAdmin(URL, 'tok');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(f.calls.length, 0);
    });
    test('inherited admin found by Table API lookup is allowed', async function() {
        var f = await fixture([{ url: URL, shortName: 'dev1', userName: 'bob', roles: ['itil'] }],
            function() { return jsonRes(200, { result: [{ sys_id: 'x' }] }); });
        var r = await f.m._rsCheckAdmin(URL, 'tok');
        assert.strictEqual(r.ok, true);
        assert.ok(decodeURIComponent(f.calls[0]).indexOf('role.name=admin') !== -1);
        assert.ok(decodeURIComponent(f.calls[0]).indexOf('inherited') === -1, 'effective admin: no inherited filter');
    });
    test('non-admin is refused with the Table API hint', async function() {
        var f = await fixture([{ url: URL, shortName: 'dev1', userName: 'carol', roles: ['itil'] }],
            function() { return jsonRes(200, { result: [] }); });
        var r = await f.m._rsCheckAdmin(URL, 'tok');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'User carol lacks the admin role on dev1; server scripts require admin \u2014 use servicenow_api (Table API) instead.');
    });
    test('lookup failure fails safe (refuses)', async function() {
        var f = await fixture([{ url: URL, shortName: 'dev1', userName: 'dave', roles: [] }],
            function() { return jsonRes(403, {}); });
        var r = await f.m._rsCheckAdmin(URL, 'tok');
        assert.strictEqual(r.ok, false);
        assert.ok(/HTTP 403/.test(r.error) && /NOT run/.test(r.error));
    });
    test('_liFetchDirectRoles queries inherited=false and dedupes', async function() {
        var f = await fixture([], function() { return jsonRes(200, { result: [{ 'role.name': 'admin' }, { 'role.name': 'itil' }, { 'role.name': 'admin' }] }); });
        var roles = await f.m._liFetchDirectRoles(URL, 'tok');
        assert.deepStrictEqual(roles, ['admin', 'itil']);
        assert.ok(decodeURIComponent(f.calls[0]).indexOf('inherited=false') !== -1);
    });
});
