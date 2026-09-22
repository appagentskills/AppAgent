// Contract layer: the sandbox file helpers and the run_js_file tool, called
// exactly as agents call them. Writes only under test/.scratch/ and cleans up.
// Run: run_tests { tags: ['contract'], pattern: 'run-js-file' }
describe('run_js_file contract', function() {
    var C = { tags: ['contract'] };
    var scratch = scratchPath('rjf-contract.js');
    afterEach(async function() { try { await executeTool('workspace', { action: 'discard', path: scratch }); } catch (e) {} });

    test('loadFile returns raw source (no line-number prefixes)', async function() {
        var src = await loadFile('test/harness.js');
        assert.ok(src.indexOf('async function registerRunner(') >= 0);
        assert.ok(!/^\d+\t/m.test(src.split('\n')[0]), 'first line must not carry a line-number prefix');
    }, C);
    test('runFile: module.exports namespace of a real file', async function() {
        var m = await runFile('test/harness.js');
        assert.strictEqual(typeof m.run, 'function'); assert.strictEqual(typeof m.registerRunner, 'function');
    }, C);
    test('evalModule: return mode and module.exports mode', async function() {
        assert.strictEqual(await evalModule('return 40 + 2;', 'inline-return.js', {}), 42);
        var m = await evalModule('var a = 1; function f() { return a + 1; } module.exports = { f: f };', 'inline-exports.js', {});
        assert.strictEqual(typeof m.f, 'function'); assert.strictEqual(m.f(), 2);
    }, C);
    test('scratch file round-trip through workspace write → runFile → discard', async function() {
        var w = await executeTool('workspace', { action: 'write', path: scratch, content: 'module.exports = { answer: 6 * 7, tool: typeof executeTool };' });
        assert.ok(w && w.success, 'write failed: ' + JSON.stringify(w).slice(0, 200));
        var m = await runFile(scratch);
        assert.strictEqual(m.answer, 42); assert.strictEqual(m.tool, 'function');
    }, C);
    // run_js_file exists only after the extension is rebuilt (Reload): probe once and skip otherwise.
    async function probeRunJsFile() {
        var r = await executeTool('run_js_file', { path: 'test/harness.js', mode: 'source' });
        if (!r || r.success !== true) skipTest('run_js_file not available yet (Reload required): ' + String((r && r.error) || 'no result').slice(0, 120));
        return r;
    }
    test('run_js_file mode:source returns harness content', async function() {
        var r = await probeRunJsFile();
        assert.ok(typeof r.content === 'string' && r.content.indexOf('function install(') >= 0, 'content missing');
    }, C);
    test('run_js_file mode:source errors on a missing path', async function() {
        await probeRunJsFile();
        var r = await executeTool('run_js_file', { path: 'test/does-not-exist.js', mode: 'source' });
        assert.ok(r && r.success === false, 'expected failure, got ' + JSON.stringify(r).slice(0, 200));
    }, C);
});
