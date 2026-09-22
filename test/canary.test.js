// Canary: tiny liveness / round-trip checks for the js_eval test sandbox.
// Run: run_tests { tags: ['canary'] }   (see test/harness.js)
describe('canary', function() {
    var C = { tags: ['canary'] };
    test('arithmetic', function() { assert.strictEqual(1 + 1, 2); }, C);
    test('await sleep(1) resolves', async function() { var t0 = Date.now(); await sleep(1); assert.ok(Date.now() - t0 >= 0); }, C);
    test('executeTool workspace read round-trips under the default host policy', async function() {
        var r = await executeTool('workspace', { action: 'read', path: 'test/harness.js' });
        assert.strictEqual(r.success, true, 'workspace read failed: ' + JSON.stringify(r).slice(0, 200));
        assert.strictEqual(typeof r.content, 'string');
        assert.ok(r.content.indexOf('async function registerRunner(') >= 0, 'real harness source must round-trip');
    }, C);
});
