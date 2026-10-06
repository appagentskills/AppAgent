// SW 'skills-refresh' (worker/130-port-bridge.js) must reload skill
// DEFINITIONS (loadSkillsFromStorage) before re-running loadActiveSkills, so
// the SW's in-memory `skills` map (e.g. skills[id].devOnly) is not stale until
// the next service-worker restart. Executes the real case body extracted from
// the source with stubbed globals.
describe('SW skills-refresh handler (worker/130-port-bridge.js)', function() {
    var CASE = "case 'skills-refresh':";

    async function buildHandler(loadSkillsFromStorage, loadActiveSkills, consoleStub) {
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var start = src.indexOf(CASE);
        assert.ok(start > 0, 'skills-refresh case exists');
        var end = src.indexOf("\n        case '", start + CASE.length);
        assert.ok(end > start, 'next case found');
        var body = src.slice(start, end);
        var factory = new Function('loadSkillsFromStorage', 'loadActiveSkills', 'console',
            'return function(msg) { switch (msg.type) { ' + body + ' } };');
        return factory(loadSkillsFromStorage, loadActiveSkills, consoleStub);
    }
    function flush() { return new Promise(function(r) { setTimeout(r, 0); }); }
    function quietConsole(warns) { return { warn: function() { warns.push([].slice.call(arguments)); }, log: function() {}, error: function() {} }; }

    test('awaits loadSkillsFromStorage before loadActiveSkills', async function() {
        var order = [], warns = [];
        var resolveDefs;
        var defs = function() { order.push('defs:start'); return new Promise(function(r) { resolveDefs = function() { order.push('defs:end'); r(); }; }); };
        var active = function() { order.push('active'); return Promise.resolve(); };
        var h = await buildHandler(defs, active, quietConsole(warns));
        var ret = h({ type: 'skills-refresh' });
        assert.strictEqual(ret, undefined, 'handler returns synchronously');
        await flush();
        assert.deepStrictEqual(order, ['defs:start'], 'loadActiveSkills must wait for definitions');
        resolveDefs();
        await flush();
        assert.deepStrictEqual(order, ['defs:start', 'defs:end', 'active']);
        assert.strictEqual(warns.length, 0);
    }, { tags: ['unit'] });

    test('a rejection from loadSkillsFromStorage is caught and skips loadActiveSkills', async function() {
        var warns = [], activeCalls = 0;
        var h = await buildHandler(function() { return Promise.reject(new Error('idb boom')); },
            function() { activeCalls++; }, quietConsole(warns));
        h({ type: 'skills-refresh' });
        await flush(); await flush();
        assert.strictEqual(activeCalls, 0);
        assert.strictEqual(warns.length, 1);
        assert.match(String(warns[0][0]), /skills-refresh failed/);
        assert.match(String(warns[0][1] && warns[0][1].message), /idb boom/);
    }, { tags: ['unit'] });

    test('a rejection (or sync throw) from loadActiveSkills is caught', async function() {
        var warns = [];
        var h = await buildHandler(function() { return Promise.resolve(); },
            function() { throw new Error('active boom'); }, quietConsole(warns));
        h({ type: 'skills-refresh' });
        await flush(); await flush();
        assert.strictEqual(warns.length, 1);
        assert.match(String(warns[0][1] && warns[0][1].message), /active boom/);
    }, { tags: ['unit'] });

    test('typeof guards: safe when either or both functions are undefined', async function() {
        var warns = [], calls = [];
        var h1 = await buildHandler(undefined, function() { calls.push('active'); }, quietConsole(warns));
        h1({ type: 'skills-refresh' });
        var h2 = await buildHandler(function() { calls.push('defs'); }, undefined, quietConsole(warns));
        h2({ type: 'skills-refresh' });
        var h3 = await buildHandler(undefined, undefined, quietConsole(warns));
        assert.strictEqual(h3({ type: 'skills-refresh' }), undefined);
        await flush(); await flush();
        assert.deepStrictEqual(calls.sort(), ['active', 'defs']);
        assert.strictEqual(warns.length, 0, 'missing functions are not errors');
    }, { tags: ['unit'] });
});
