// Reload "Aw, Snap!" code 5 after #1039: the in-app build fired every dist
// write (~65 files incl. docs-locales/*) at once. skills/extension-dev/build.js
// now bounds that fan-out with _mapLimit. These tests load the REAL build.js
// and exercise _mapLimit plus the write-site wiring.
// Run: run_tests { files: ['test/build-bounded-fanout.test.js'] }
var BUILD_JS = 'skills/extension-dev/build.js';

async function bfLoad() {
    var src = await loadFile(BUILD_JS);
    var fnSrc = src.slice(src.indexOf('var BUILD_WRITE_CONCURRENCY'), src.indexOf('// \u2500\u2500\u2500 End bounded fan-out'));
    assert.ok(fnSrc.length > 100, 'bounded fan-out region found');
    var mod = new Function(fnSrc + '\n;return { _mapLimit: _mapLimit, W: BUILD_WRITE_CONCURRENCY, R: BUILD_READ_CONCURRENCY };')();
    return { src: src, mod: mod };
}

function bfDelay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

describe('build.js bounded fan-out', function() {
    test('_mapLimit caps in-flight calls and preserves order', async function() {
        var m = (await bfLoad()).mod;
        var active = 0, maxActive = 0;
        var items = []; for (var i = 0; i < 65; i++) items.push(i);
        var out = await m._mapLimit(items, 4, async function(x, idx) {
            active++; if (active > maxActive) maxActive = active;
            await bfDelay((x * 7) % 5);
            active--;
            return x * 2 + ':' + idx;
        });
        assert.strictEqual(maxActive, 4, 'never more than 4 in flight');
        assert.strictEqual(out.length, 65);
        assert.strictEqual(out[0], '0:0');
        assert.strictEqual(out[64], '128:64');
    }, { tags: ['unit'], timeout: 5000 });

    test('_mapLimit handles empty input and bad limits', async function() {
        var m = (await bfLoad()).mod;
        assert.deepStrictEqual(await m._mapLimit([], 4, function() { throw new Error('never'); }), []);
        assert.deepStrictEqual(await m._mapLimit(null, 4, function() { return 1; }), []);
        var active = 0, maxActive = 0;
        var out = await m._mapLimit([1, 2, 3], 0, async function(x) {
            active++; maxActive = Math.max(maxActive, active); await bfDelay(1); active--; return x;
        });
        assert.deepStrictEqual(out, [1, 2, 3]);
        assert.strictEqual(maxActive, 1, 'limit 0 falls back to serial');
    }, { tags: ['unit'], timeout: 5000 });

    test('_mapLimit propagates a rejection', async function() {
        var m = (await bfLoad()).mod;
        await assert.rejects(m._mapLimit([1, 2], 2, function(x) { if (x === 2) throw new Error('boom'); return x; }), /boom/);
    }, { tags: ['unit'], timeout: 5000 });

    test('dist writes and locale reads use _mapLimit, not unbounded Promise.all', async function() {
        var b = await bfLoad();
        assert.ok(b.mod.W > 0 && b.mod.W <= 8, 'write concurrency is small');
        assert.ok(b.mod.R > 0 && b.mod.R <= 16, 'read concurrency is small');
        assert.match(b.src, /writeResults = await _mapLimit\(outputFiles, BUILD_WRITE_CONCURRENCY/);
        assert.match(b.src, /docsLocaleReads = await _mapLimit\(docsLocaleCodes, BUILD_READ_CONCURRENCY/);
        assert.strictEqual(/Promise\.all\(outputFiles\.map/.test(b.src), false, 'no unbounded dist write fan-out');
        assert.match(b.src, /contents = await _mapLimit\(filePaths, BUILD_READ_CONCURRENCY/);
        assert.match(b.src, /ratchetContents = await _mapLimit\(ratchetScanFiles, BUILD_READ_CONCURRENCY/);
        assert.strictEqual(/Promise\.all\(filePaths\.map\(readFile\)\)/.test(b.src), false, 'no unbounded concatFiles reads');
    }, { tags: ['unit'], timeout: 5000 });

    test('wsDeploy: _wsDeployAllSettledLimit caps in-flight writes with allSettled semantics', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var a = src.indexOf('var WS_DEPLOY_CONCURRENCY'), z = src.indexOf('// opts (optional): { ext:', a);
        assert.ok(a > 0 && z > a, 'limiter region found');
        var m = new Function(src.slice(a, z) + '\n;return { f: _wsDeployAllSettledLimit, N: WS_DEPLOY_CONCURRENCY };')();
        assert.ok(m.N > 0 && m.N <= 8);
        var active = 0, maxActive = 0, items = [];
        for (var i = 0; i < 65; i++) items.push(i);
        var out = await m.f(items, m.N, async function(x) {
            active++; maxActive = Math.max(maxActive, active);
            await bfDelay(x % 3); active--;
            if (x === 10) throw new Error('disk full');
            return x % 2 ? 'written' : 'skipped';
        });
        assert.strictEqual(maxActive, m.N);
        assert.strictEqual(out.length, 65);
        assert.deepStrictEqual(out[1], { status: 'fulfilled', value: 'written' });
        assert.strictEqual(out[10].status, 'rejected');
        assert.match(out[10].reason.message, /disk full/);
        assert.deepStrictEqual(out[64], { status: 'fulfilled', value: 'skipped' }, 'siblings keep running after a rejection');
        assert.deepStrictEqual(await m.f([], 4, function() { throw new Error('never'); }), []);
        assert.match(src, /outcomes = await _wsDeployAllSettledLimit\(targets, WS_DEPLOY_CONCURRENCY, writeOne\)/);
        assert.strictEqual(/Promise\.allSettled\(targets\.map\(writeOne\)\)/.test(src), false);
    }, { tags: ['unit'], timeout: 5000 });
});
