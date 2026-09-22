// Tests for test/harness.js itself, run against a SECOND harness instance so
// the outer run (this file) is never disturbed. Never H2.install(window).
// Run: run_tests { pattern: 'harness.test' }
var H2 = await runFile('test/harness.js');

describe('harness', function() {
    beforeEach(async function() { H2 = await runFile('test/harness.js'); H2.reset('h2-file'); });

    test('assert helpers: ok/strictEqual/deepStrictEqual/throws/rejects/match', async function() {
        var A = H2.assert;
        A.ok(1); A.strictEqual('a', 'a'); A.deepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }); A.match('abc', /b/);
        A.throws(function() { throw new TypeError('x'); }, TypeError);
        A.throws(function() { A.deepStrictEqual([1], [2]); }, { isAssertion: true });
        A.throws(function() { A.ok(false); }, /truthy/);
        await A.rejects(Promise.reject(new Error('nope')), /nope/);
        await A.rejects(function() { return A.rejects(Promise.resolve(1)); });
        assert.ok(!H2._isDeepEqual({ a: 1 }, { a: 1, b: undefined }), 'key count matters');
        assert.ok(H2._isDeepEqual(NaN, NaN), 'NaN equals NaN');
    });

    test('run: pass / fail / skip / tag filter / fullName', async function() {
        H2.describe('S', function() {
            H2.test('p', function() { H2.assert.ok(true); });
            H2.test('f', function() { H2.assert.fail('boom'); });
            H2.test.skip('s', function() {});
            H2.test('c', function() { H2.assert.ok(true); }, { tags: ['contract'] });
        });
        var r = await H2.run({ tags: ['unit'] });
        assert.strictEqual(r.file, 'h2-file');
        assert.deepStrictEqual([r.passed, r.failed, r.skipped], [1, 1, 2]);
        var byName = {}; r.tests.forEach(function(t) { byName[t.name] = t; });
        assert.strictEqual(byName['S › f'].status, 'fail');
        assert.strictEqual(byName['S › f'].error.message, 'boom');
        assert.strictEqual(byName['S › f'].error.assertion, true);
        assert.strictEqual(byName['S › s'].reason, 'test.skip');
        assert.strictEqual(byName['S › c'].reason, 'tag filter');
        var all = await H2.run();
        assert.strictEqual(all.passed, 2, 'no tag filter runs every tag');
    });

    test('run: skipTest inside body and per-test timeout', async function() {
        H2.test('sk', function() { H2.skip('not here'); });
        H2.test('slow', function() { return new Promise(function() {}); }, { timeout: 20 });
        var r = await H2.run();
        assert.strictEqual(r.tests[0].status, 'skip'); assert.strictEqual(r.tests[0].reason, 'not here');
        assert.strictEqual(r.tests[1].status, 'fail'); assert.match(r.tests[1].error.message, /timed out after 20ms/);
    });

    test('run: {timeout_ms} sets the default per-test timeout; per-test {timeout} still wins; default is 30 s', async function() {
        var sleep50 = function() { return new Promise(function(res) { setTimeout(res, 50); }); };
        H2.test('slow', sleep50, { noAssert: true });
        H2.test('slow-own-timeout', sleep50, { timeout: 500, noAssert: true });
        var r = await H2.run({ timeout_ms: 10 });
        assert.strictEqual(r.tests[0].status, 'fail', 'run-level timeout_ms must apply to a test without its own timeout');
        assert.match(r.tests[0].error.message, /timed out after 10ms/);
        assert.strictEqual(r.tests.length, 1, 'timeout aborts remaining tests');
        assert.strictEqual(r.aborted, true);
        H2 = await runFile('test/harness.js'); H2.reset('h2-file'); H2.test('slow', sleep50, { timeout: 500, noAssert: true });
        var r2 = await H2.run();
        assert.strictEqual(r2.tests[0].status, 'pass', 'no timeout_ms → HARNESS_DEFAULT_TIMEOUT_MS (30 s) → a 50 ms test passes');
        assert.strictEqual(H2.DEFAULT_TIMEOUT_MS, 30000);
        assert.strictEqual(H2._state.suites[0].tests[0].timeout, 500, 'explicit per-test timeout is preserved');
        H2.reset('h2-file'); H2.test('bogus', sleep50, { noAssert: true });
        assert.strictEqual(H2._state.suites[0].tests[0].timeout, null, 'tests without override retain null until run');
        var r3 = await H2.run({ timeout_ms: 'nope' });
        assert.strictEqual(r3.tests[0].status, 'pass', 'non-numeric timeout_ms falls back to the default');
    });

    test('hooks: root beforeEach runs ONCE per nested test; afterEach reversed; afterEach runs on failure', async function() {
        var log = [];
        H2.beforeEach(function() { log.push('root-before'); });
        H2.afterEach(function() { log.push('root-after'); });
        H2.describe('outer', function() {
            H2.beforeEach(function() { log.push('outer-before'); });
            H2.afterEach(function() { log.push('outer-after'); });
            H2.describe('inner', function() {
                H2.test('t', function() { log.push('t'); throw new Error('fail-in-t'); });
            });
        });
        var r = await H2.run();
        assert.strictEqual(r.failed, 1);
        assert.deepStrictEqual(log, ['root-before', 'outer-before', 't', 'outer-after', 'root-after']);
    });

    test('describe rejects async callbacks; test requires a function', function() {
        assert.throws(function() { H2.describe('a', async function() {}); }, /must be synchronous/);
        assert.throws(function() { H2.test('b'); }, /second argument must be a function/);
    });

    test('registerRunner: array of {name,passed}', async function() {
        await H2.registerRunner('r', async function() { return [{ name: 'a', passed: true }, { name: 'b', passed: false, message: 'bad b' }, { passed: true }]; });
        var r = await H2.run();
        assert.deepStrictEqual([r.passed, r.failed], [2, 1]);
        assert.strictEqual(r.tests[1].name, 'r › b'); assert.strictEqual(r.tests[1].error.message, 'bad b');
        assert.strictEqual(r.tests[2].name, 'r › check #3');
    });
    test('registerRunner: {passed,total,results} adds a tally test', async function() {
        await H2.registerRunner('r', function() { return { passed: 1, total: 2, results: [{ name: 'a', passed: true }, { name: 'b', passed: false, error: 'e' }] }; });
        var r = await H2.run();
        assert.deepStrictEqual([r.passed, r.failed], [1, 2]);
        assert.strictEqual(r.tests[2].name, 'r › tally 1/2'); assert.strictEqual(r.tests[2].status, 'fail');
    });
    test('registerRunner: array of check-name strings', async function() {
        await H2.registerRunner('r', function() { return ['x', 'y']; });
        var r = await H2.run();
        assert.deepStrictEqual([r.passed, r.failed], [2, 0]); assert.strictEqual(r.tests[1].name, 'r › y');
    });
    test('registerRunner: throwing runner → one failing test carrying the error', async function() {
        await H2.registerRunner('r', async function() { throw new ReferenceError('zzz is not defined'); });
        var r = await H2.run();
        assert.deepStrictEqual([r.passed, r.failed], [0, 1]);
        assert.strictEqual(r.tests[0].name, 'r › runner completed without throwing');
        assert.match(r.tests[0].error.message, /zzz is not defined/);
    });
    test('registerRunner: {passed,total} without list → tally only; garbage → failing shape test', async function() {
        await H2.registerRunner('r', function() { return { passed: 3, total: 3 }; });
        var r = await H2.run();
        assert.deepStrictEqual([r.passed, r.failed, r.tests[0].name], [1, 0, 'r › tally 3/3']);
        H2.reset();
        await H2.registerRunner('r', function() { return 42; });
        r = await H2.run();
        assert.strictEqual(r.failed, 1); assert.match(r.tests[0].error.message, /unexpected runner result/);
    });

    test('scratchPath / isScratchPath', function() {
        assert.strictEqual(H2.scratchPath('/a/../b.js'), 'test/.scratch/a/_/b.js');
        assert.ok(H2.isScratchPath('test/.scratch/x')); assert.ok(!H2.isScratchPath('src/x'));
        assert.ok(!H2.isScratchPath('test/.scratch/../../src/x.js'), 'traversal is never scratch');
        assert.ok(!H2.isScratchPath('test/.scratch/..'));
    });

    // ── F5: assertion counting ──
    test('no_assertions: a passing test with zero assert.* calls FAILS unless {noAssert:true}', async function() {
        H2.test('silent', function() {});
        H2.test('opted-out', function() {}, { noAssert: true });
        H2.test('asserting', function() { H2.assert.ok(1); });
        H2.test('throwing-without-assert', function() { throw new Error('x'); });
        var r = await H2.run();
        assert.strictEqual(r.tests[0].status, 'no_assertions'); assert.match(r.tests[0].error.message, /no assertions/);
        assert.strictEqual(r.tests[1].status, 'pass'); assert.strictEqual(r.tests[2].status, 'pass'); assert.strictEqual(r.tests[2].assertions, 1);
        assert.strictEqual(r.tests[3].status, 'fail', 'a thrown error is still a plain fail');
        assert.deepStrictEqual([r.passed, r.failed, r.no_assertions], [2, 2, 1], 'no_assertions counts in failed');
    });
    test('registerRunner: passes reported before a throwing runner are preserved (progress.pass / err.passed)', async function() {
        await H2.registerRunner('r', async function(progress) { progress.pass('a'); progress.pass('b'); var e = new Error('FAIL: c'); e.passed = ['c-before']; throw e; });
        var r = await H2.run();
        assert.deepStrictEqual(r.tests.map(function(t) { return t.name + ':' + t.status; }), ['r › a:pass', 'r › b:pass', 'r › c-before:pass', 'r › runner completed without throwing:fail']);
        assert.deepStrictEqual([r.passed, r.failed], [3, 1]);
    });

    // ── F6: runtime layer auto-skip ──
    test('runtime-tagged tests are skipped unless run({dev_mode:true})', async function() {
        H2.test('rt', function() { H2.assert.ok(1); }, { tags: ['runtime'] });
        var r = await H2.run({ tags: ['runtime'] });
        assert.strictEqual(r.tests[0].status, 'skip'); assert.strictEqual(r.tests[0].reason, 'runtime: dev mode not active');
        var r2 = await H2.run({ tags: ['runtime'], dev_mode: true });
        assert.strictEqual(r2.tests[0].status, 'pass');
    });

    // ── F4: timeout permanently aborts this invocation; no later body/cleanup ──
    test('timed-out body: no next context or cleanup is opened, late rejection stays lexical', async function() {
        var log = [];
        var late;
        H2.afterEach(function() { log.push('after'); });
        H2.test('hang', function() { return new Promise(function(_, rej) { late = rej; }); }, { timeout: 20 });
        H2.test('next', async function() { late(new Error('late boom')); await new Promise(function(res) { setTimeout(res, 5); }); H2.assert.ok(1); });
        var r = await H2.run();
        assert.strictEqual(r.tests[0].status, 'fail'); assert.match(r.tests[0].error.message, /timed out/);
        assert.strictEqual(r.tests.length, 1); assert.strictEqual(r.aborted, true);
        late(new Error('late boom')); await Promise.resolve(); await Promise.resolve();
        assert.deepStrictEqual(H2._state.late_failures.map(function(l) { return l.test + ':' + l.message; }), ['hang:late boom']);
        assert.deepStrictEqual(log, []);
        await assert.rejects(function() { H2.reset(); return H2.run(); }, /aborted/);
        assert.strictEqual(H2.AFTER_TIMEOUT_MS, 5000);
    });

    // ── F3: content fingerprint isolation ──
    test('checkIsolation flags changes and rejects path-only baselines', async function() {
        var reads = { 'src/a.js': 'v1', 'src/b.js': 'same' }, status = [{ path: 'src/a.js' }, { path: 'src/b.js' }];
        var fakeExec = async function(name, args) { if (args.action === 'status') return { success: true, dirty_files: status }; if (args.action === 'read') return { success: true, content: reads[args.path] }; return {}; };
        var hm = await evalModules([await loadFile('test/harness.js')], ['harness'], { globals: { module: { exports: {} }, executeTool: fakeExec, window: {} } });
        var H3 = hm.__scope.module.exports;
        var before = await H3.snapshotDirtyState('w');
        assert.deepStrictEqual(before.paths, ['src/a.js', 'src/b.js']); assert.strictEqual(before.fingerprints['src/a.js'], H3.fingerprint('v1'));
        var clean = await H3.checkIsolation(before, 'w'); assert.strictEqual(clean.ok, true); assert.deepStrictEqual(clean.violations, []);
        reads['src/a.js'] = 'v2'; reads['src/new.js'] = 'new'; status.push({ path: 'test/.scratch/t.js' }, { path: 'src/new.js' });
        var iso = await H3.checkIsolation(before, 'w');
        assert.strictEqual(iso.ok, false);
        assert.deepStrictEqual(iso.violations, ['src/a.js', 'src/new.js']); assert.deepStrictEqual(iso.changed, ['src/a.js']); assert.deepStrictEqual(iso.scratch_leftovers, ['test/.scratch/t.js']);
        await assert.rejects(function() { return H3.checkIsolation(['src/a.js', 'src/b.js'], 'w'); }, /Complete uncapped baseline/);
        assert.notStrictEqual(H3.fingerprint('ab'), H3.fingerprint('ba'));
    });

    test('diagnostics do not grant mutation authority or expose the raw bridge', async function() {
        var calls = [];
        var target = { executeTool: async function(name) { calls.push(name); return name === 'get_cookie' ? { success: false, denied_by_host: true, error: 'host denied' } : { success: true, name: name }; } };
        var g = H2.installToolGuard(target, { allow_tools: ['get_cookie'] });
        assert.strictEqual(target.executeTool.__harnessRaw, undefined);
        assert.strictEqual(g.restore, undefined);
        assert.strictEqual(g.authority, 'host-only');
        H2.test('bad', async function() { H2.assert.strictEqual((await target.executeTool('get_cookie', {})).success, false); });
        H2.test('good', async function() { H2.assert.strictEqual((await target.executeTool('workspace', { action: 'ls' })).success, true); });
        var r = await H2.run();
        assert.strictEqual(r.tests[0].status, 'fail'); assert.strictEqual(r.tests[1].status, 'pass');
        assert.deepStrictEqual(calls, ['get_cookie', 'workspace'], 'host observes every decision');
        assert.strictEqual(g.denied_calls[0].test, 'bad');
        assert.strictEqual(H2.toolDecision('workspace', { action: 'write', path: 'test/.scratch/a' }, ['workspace']).ok, false);
        assert.strictEqual(H2.toolDecision('run_js_file', { path: 'src/a', mode: 'module' }).ok, false);
        await assert.rejects(function() { return H2.cleanupScratch(); }, /unsupported/);
    });
    test('read-only host reports live layers as unsupported skips', async function() {
        H2.test('live', function() { throw new Error('must not execute'); }, { tags: ['contract'] });
        H2.test('runtime', function() { throw new Error('must not execute'); }, { tags: ['runtime'] });
        var r = await H2.run({ read_only_host: true, dev_mode: true });
        assert.strictEqual(r.passed, 0); assert.strictEqual(r.skipped, 2);
        r.tests.forEach(function(t) { assert.match(t.reason, /unsupported/); });
        var withoutDevMode = await H2.run({ tags: ['runtime'], read_only_host: true });
        assert.strictEqual(withoutDevMode.tests[1].reason, 'unsupported: live contract/runtime tools disabled by host read-only policy', 'host unsupported reason takes precedence over absent dev mode');
        assert.strictEqual(withoutDevMode.passed, 0);
    });
    test('fakeChrome storage + sendMessage; fakeWindow listeners', async function() {
        var c = H2.fakeChrome();
        await c.storage.local.set({ k: 1 });
        assert.deepStrictEqual(await c.storage.local.get(['k', 'z']), { k: 1 });
        assert.deepStrictEqual(await c.storage.local.get({ z: 'd' }), { z: 'd' });
        c.runtime.onMessage.addListener(function(msg, sender, reply) { reply(msg.n + 1); });
        assert.strictEqual(await c.runtime.sendMessage({ n: 1 }), 2);
        assert.ok(c._calls.some(function(x) { return x.api === 'storage.local.set'; }));
        var w = H2.fakeWindow(); var got; w.addEventListener('x', function(e) { got = e; }); w.dispatchEvent({ type: 'x' });
        assert.deepStrictEqual(got, { type: 'x' }); w.postMessage('m', '*'); assert.deepStrictEqual(w._posted, [{ message: 'm', origin: '*' }]);
    });
});
