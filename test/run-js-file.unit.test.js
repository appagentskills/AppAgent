// Unit layer: the sandbox file helpers (loadFile / runFile / evalModule) that
// back run_js_file, exercised read-only exactly as tests and agents call them.
// Replaces the former run-js-file.contract.test.js, whose contract-tagged tests
// were always skipped by the read-only run_tests host.
// Run: run_tests { files: ['test/run-js-file.unit.test.js'] }
describe('run_js_file sandbox helpers', function() {
    var U = { tags: ['unit'] };

    test('loadFile returns raw source (no line-number prefixes)', async function() {
        var src = await loadFile('test/harness.js');
        assert.strictEqual(typeof src, 'string');
        assert.ok(src.indexOf('async function registerRunner(') >= 0);
        assert.ok(src.indexOf('function install(') >= 0, 'mode:source content carries the harness body');
        assert.ok(!/^\d+\t/.test(src.split('\n')[0]), 'first line must not carry a line-number prefix');
    }, U);
    test('runFile: module.exports namespace of a real file', async function() {
        var m = await runFile('test/harness.js');
        assert.strictEqual(typeof m.run, 'function'); assert.strictEqual(typeof m.registerRunner, 'function');
    }, U);
    test('evalModule: return mode and module.exports mode', async function() {
        assert.strictEqual(await evalModule('return 40 + 2;', 'inline-return.js', {}), 42);
        var m = await evalModule('var a = 1; function f() { return a + 1; } module.exports = { f: f };', 'inline-exports.js', {});
        assert.strictEqual(typeof m.f, 'function'); assert.strictEqual(m.f(), 2);
    }, U);
    test('evalModule: top-level declaration namespace and args', async function() {
        var m = await evalModule('function g() { return args.n * 2; }\nvar k = 7;', 'inline-ns.js', { n: 21 });
        assert.strictEqual(m.g(), 42); assert.strictEqual(m.k, 7);
    }, U);
    test('loadFile rejects on a missing path', async function() {
        var err = null;
        try { await loadFile('test/does-not-exist.js'); } catch (e) { err = e; }
        assert.ok(err, 'expected loadFile to reject for a missing path');
        assert.ok(/does-not-exist/.test(String(err && err.message)), 'error names the path: ' + String(err && err.message).slice(0, 200));
    }, U);
});
