// Per-frame loadFile cache injected into every run_tests shard frame
// (src/js/tools/160-run-tests.js RT_SOURCE_CACHE_CODE). Evaluates the REAL
// injected snippet against a fake window whose loadFile counts host reads.
async function loadRunTests() {
    return loadModules(['src/js/core/075-test-run-policy.js', 'src/js/tools/160-run-tests.js'], { lenient: true });
}
function fakeWin(impl) {
    var w = { calls: [] };
    w.loadFile = function(path, ws) { w.calls.push([path, ws]); return impl(path, ws, w.calls.length); };
    return w;
}
function install(m, w) { new Function('window', m.RT_SOURCE_CACHE_CODE)(w); return w; }

describe('run_tests per-frame source cache', function() {
    test('repeated reads of the same path hit the host once (also when concurrent)', async function() {
        var m = await loadRunTests();
        var w = install(m, fakeWin(function(p) { return Promise.resolve('src:' + p); }));
        var a = await Promise.all([w.loadFile('src/a.js'), w.loadFile('src/a.js')]);
        var b = await w.loadFile('src/a.js');
        assert.deepStrictEqual(a, ['src:src/a.js', 'src:src/a.js']);
        assert.strictEqual(b, 'src:src/a.js');
        assert.strictEqual(w.calls.length, 1);
    }, { tags: ['unit'], timeout: 4000 });

    test('cache key includes the workspace', async function() {
        var m = await loadRunTests();
        var w = install(m, fakeWin(function(p, ws) { return Promise.resolve(p + '@' + ws); }));
        assert.strictEqual(await w.loadFile('x.js', 'o/r::a'), 'x.js@o/r::a');
        assert.strictEqual(await w.loadFile('x.js', 'o/r::b'), 'x.js@o/r::b');
        assert.strictEqual(w.calls.length, 2);
    }, { tags: ['unit'], timeout: 4000 });

    test('failed / denied reads are not cached: the next call asks the host again', async function() {
        var m = await loadRunTests();
        var w = install(m, fakeWin(function(p, ws, n) { return n === 1 ? Promise.reject(new Error('denied_by_host')) : Promise.resolve('ok'); }));
        await assert.rejects(w.loadFile('src/d.js'), /denied_by_host/);
        await Promise.resolve();
        assert.strictEqual(await w.loadFile('src/d.js'), 'ok');
        assert.strictEqual(w.calls.length, 2);
    }, { tags: ['unit'], timeout: 4000 });

    test('non-string results are evicted', async function() {
        var m = await loadRunTests();
        var w = install(m, fakeWin(function(p, ws, n) { return Promise.resolve(n === 1 ? undefined : 'ok'); }));
        assert.strictEqual(await w.loadFile('src/e.js'), undefined);
        await Promise.resolve();
        assert.strictEqual(await w.loadFile('src/e.js'), 'ok');
        assert.strictEqual(w.calls.length, 2);
    }, { tags: ['unit'], timeout: 4000 });

    test('shard code installs the cache before the harness wraps loadFile', async function() {
        var m = await loadRunTests();
        var code = m.rtBuildSandboxCode({ files: [], sources: [], harness_source: '', tags: ['unit'], test_timeout_ms: 1000, workspace: 'o/r::main', harness: 'test/harness.js' });
        var at = code.indexOf(m.RT_SOURCE_CACHE_CODE);
        assert.ok(at > 0, 'cache snippet present');
        assert.ok(at < code.indexOf('H.install(window)'), 'cache installed before H.install');
    }, { tags: ['unit'], timeout: 4000 });
});
