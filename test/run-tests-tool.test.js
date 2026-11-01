// Executes the real host entry point with fake workspace/eval bridges. No live
// run_tests/run_js_file invocation, no network, no writes, no Chrome effects.
async function runRunTestsToolSafetyTests(sources) {
    var passed = [];
    function check(name, yes) { if (!yes) throw new Error(name); passed.push(name); }
    function setup(options) {
        options = options || {};
        var calls = [], statusCount = 0, evalOptions, allOpts = [];
        // Long timers are inert in this fake realm; only the explicit 10ms
        // timeout test uses a local timer. Never call the sandbox sleep bridge.
        function fakeTimer(fn, ms) { return ms < 1000 ? setTimeout(fn, ms) : null; }
        var P = new Function('setTimeout', 'clearTimeout', sources['src/js/core/075-test-run-policy.js'] + '\nreturn TestRunPolicy;')(fakeTimer, clearTimeout);
        var entry = new Function('TestRunPolicy', 'resolveWorkspace', 'wsLs', 'wsReadRaw', 'wsStatus', 'executeTool', 'crypto', 'TextEncoder', 'AbortController', sources['src/js/tools/160-run-tests.js'] + '\nreturn { run: executeRunTests, file: executeRunJsFile, helpers: RunTestsHelpers };')(
            P,
            async function(w) { calls.push('resolve'); if (options.resolve) return options.resolve(); return w || 'owner/repo::main'; },
            async function() { return { success: true, entries: ['a.test.js', 'b.test.js *', 'harness.js'] }; },
            async function(w, path) {
                calls.push('read:' + path);
                if (options.onRead) options.onRead(path);
                if (options.readMissing && path === 'src/dirty.js') return { success: true, file: {} };
                if (options.readFails && path === 'src/dirty.js') return { success: false, error: 'read failed' };
                if (options.readCapped && path === 'src/dirty.js') return { success: true, capped: true, file: { content: 'partial' } };
                if (options.sourceCapped && path === 'test/harness.js') return { success: true, file: { content: 'partial', truncated: true } };
                if (options.sourceFails && path === 'test/harness.js') return { success: false, error: 'source missing' };
                return { success: true, file: { content: options.changed && statusCount > 1 && path === 'src/dirty.js' ? 'changed' : 'source:' + path } };
            },
            async function() {
                calls.push('status'); statusCount++;
                if (options.statusFails || (options.afterFails && statusCount > 1)) return { success: false, error: 'status failed' };
                if (options.statusMissing) return { success: true };
                if (options.capped) return { success: true, dirty_files: [], capped: true };
                if (options.overCap) return { success: true, dirty_files: Array.from({ length: 501 }, function(_, i) { return { path: 'src/' + i }; }) };
                return { success: true, dirty_files: [{ path: 'src/dirty.js' }] };
            },
            async function(name, args, index, opts) {
                calls.push('eval'); evalOptions = opts; allOpts.push(opts);
                if (options.hung) return new Promise(function() {});
                if (options.denied) P.registry.gate(opts._testRunContext, 'get_cookie', {});
                if (options.noEnvelope) return { success: true, result: { success: true, files: [] } };
                // Build the result from THIS call's (shard) cfg, embedded on line 1.
                var callCfg = JSON.parse(String(args.code).split('\n')[0].replace(/^var cfg = /, '').replace(/;$/, ''));
                var files = callCfg.files.map(function(f) { return { file: f, status: 'pass', passed: 1, failed: 0, skipped: 0 }; });
                return { success: true, result: { host_test_boundary: true, denied_calls: options.offscreenDenied ? [{ tool: 'workspace', reason: 'mutation' }] : [], value: { success: true, files: files, isolation: { ok: true }, denied_calls: [], summary: { failed: 0 } } } };
            },
            { subtle: { digest: async function(_, bytes) { return bytes.buffer; } } }, TextEncoder, AbortController
        );
        return { P: P, entry: entry, calls: calls, opts: function() { return evalOptions; }, allOpts: allOpts };
    }
    var h = setup(), RT = h.entry.helpers;
    check('source file args default to module for normal callers', RT.rjfValidateArgs({ path: ' a.js ' }).value.mode === 'module');
    check('source mode validates', RT.rjfValidateArgs({ path: 'a', mode: 'source' }).ok);
    for (var bad of [{}, { path: ' ' }, { path: 'a', mode: 'bad' }, { path: 'a', args: [] }]) check('file validator rejects ' + JSON.stringify(bad), !RT.rjfValidateArgs(bad).ok);
    for (var badRun of [{ files: 'x' }, { files: ['test/../a.test.js'] }, { files: ['src/a.js'] }, { pattern: '(' }, { tags: [] }, { tags: ['bad'] }, { timeout_ms: 0 }, { timeout_ms: 2147483648 }, { test_timeout_ms: 'x' }, { allow_tools: ['workspace'] }, { allow_tools: [{ name: 'workspace', actions: ['push'] }] }]) check('run validator rejects ' + JSON.stringify(badRun), !RT.rtValidateArgs(badRun).ok);
    check('typed safe grant accepted', RT.rtValidateArgs({ allow_tools: [{ name: 'workspace', actions: ['status'] }] }).ok);
    check('default timeout remains 120 seconds', RT.rtValidateArgs({}).value.timeout_ms === 120000);
    check('dirty decorated discovery preserved', JSON.stringify(RT.rtSelectTestFiles(['b.test.js * WIP', 'a.test.js', 'harness.js'])) === JSON.stringify(['test/a.test.js', 'test/b.test.js']));
    var cfg = { files: ['test/a.test.js'], sources: [''], harness_source: '', tags: ['unit'], test_timeout_ms: 10, workspace: 'owner/repo::main', harness: 'test/harness.js' };
    check('sandbox program parses without executing repository code', !!new (Object.getPrototypeOf(async function() {}).constructor)(RT.rtBuildSandboxCode(cfg)));
    check('nested runner rejected before workspace access', !(await h.entry.run({}, 0, { fromSandbox: true })).success && h.calls.length === 0);
    var result = await h.entry.run({ files: ['test/a.test.js'] }, 0, {});
    check('host runner succeeds with fully verified fake isolation', result.success && result.isolation.host_verified && result.summary.passed === 1);
    check('host snapshots happen twice outside sandbox', h.calls.filter(function(c) { return c === 'status'; }).length === 2);
    check('host freezes selected workspace in context', h.opts()._testRunContext && !h.P.registry.gate(h.opts()._testRunContext, 'run_js_file', { path: 'a', mode: 'source' }).ok);
    check('host completion aborts exact invocation signal', h.opts()._testRunSignal.aborted);
    check('runner clearly reports unsupported live layers', JSON.stringify(result.unsupported_layers) === '["contract","runtime"]');
    for (var flag of ['statusFails', 'statusMissing', 'readFails', 'readMissing', 'readCapped', 'sourceCapped', 'capped', 'overCap']) {
        var settings = {}; settings[flag] = true; h = setup(settings);
        var failed = await h.entry.run({ files: ['test/a.test.js'] }, 0, {});
        check(flag + ': baseline fails BEFORE any eval', !failed.success && h.calls.indexOf('eval') < 0);
    }
    for (var flag of ['afterFails', 'changed', 'denied', 'offscreenDenied', 'noEnvelope', 'sourceFails']) {
        var settings = {}; settings[flag] = true; h = setup(settings);
        var failed = await h.entry.run({ files: ['test/a.test.js'] }, 0, {});
        check(flag + ': sandbox green cannot erase host failure', !failed.success);
    }
    h = setup({ hung: true });
    var timed = await h.entry.run({ files: ['test/a.test.js'], timeout_ms: 10 }, 0, {});
    check('host timeout aborts signal and revokes bridge', !timed.success && h.opts()._testRunSignal.aborted && !h.P.registry.gate(h.opts()._testRunContext, 'run_js_file', { path: 'a', mode: 'source' }).ok);
    h = setup({ files: ['test/a.test.js', 'test/b.test.js'] });
    check('default discovery runs selected tests', (await h.entry.run({}, 0, {})).success);
    h = setup(); var none = await h.entry.run({ files: [] }, 0, {});
    check('no matches is a failure (NO_TESTS_MATCHED), never a green run', none.success === false && none.code === 'NO_TESTS_MATCHED' && /NO_TESTS_MATCHED/.test(none.error) && none.summary.total === 0 && h.calls.indexOf('eval') < 0);
    var source = await h.entry.file({ path: 'src/a', mode: 'source' }, 0, {});
    check('normal source retrieval compatibility', source.success && source.content === 'source:src/a');

    // Execute generated program against a tiny, isolated fake harness. Its timeout
    // result must stop file iteration; it is not allowed to perform snapshots or cleanup.
    var filesVisited = [], timeoutMessage = null, fakeWindow = { executeTool: function() { throw new Error('No real bridge'); } };
    var H = { install: function() {}, installToolGuard: function() { return { denied_calls: [] }; }, reset: function(f) { filesVisited.push(f); }, run: async function(opts) {
        opts.onTimeout(); return { aborted: true, passed: 0, failed: 1, skipped: 0, tests: [{ name: 'timeout', status: 'fail', error: { message: 'timeout' } }] };
    } };
    cfg.files = ['test/a.test.js', 'test/b.test.js']; cfg.sources = ['', ''];
    var program = new (Object.getPrototypeOf(async function() {}).constructor)('evalModule', 'window', 'parent', RT.rtBuildSandboxCode(cfg));
    var fileArgs = [];
    var posted = [];
    var programResult = await program(async function(_, path, args) { if (path === 'test/harness.js') return H; fileArgs.push(args); return {}; }, fakeWindow, { postMessage: function(m) { posted.push(m); } });
    timeoutMessage = posted.filter(function(m) { return m.type === 'sandboxTestTimeout'; })[0];
    check('per-test timeout signals trusted host and aborts remaining files', timeoutMessage && timeoutMessage.type === 'sandboxTestTimeout' && programResult.aborted && filesVisited.length === 1);
    check('per-test timeout message carries the completed-file prefix', timeoutMessage && timeoutMessage.partial && Array.isArray(timeoutMessage.partial.files) && timeoutMessage.partial.files.length === 0);
    var prog = posted.filter(function(m) { return m.type === 'sandboxTestProgress'; });
    check('sandbox streams per-file start/done progress', prog.length === 2 && prog[0].phase === 'start' && prog[0].index === 0 && prog[1].phase === 'done' && prog[1].file === 'test/a.test.js' && prog[1].failed === 1);
    var pcfg = { files: ['test/a.test.js', 'test/b.test.js'] };
    check('progress sanitizer accepts exact index/file', RT.rtProgressEvent({ index: 1, file: 'test/b.test.js', phase: 'done', status: 'pass', passed: 2, failed: 0, skipped: 0 }, pcfg).total === 2);
    for (var badEv of [null, { index: 1, file: 'test/a.test.js', phase: 'start' }, { index: 5, file: 'x', phase: 'start' }, { index: 0, file: 'test/a.test.js', phase: 'done', status: 'ok', passed: 0, failed: 0, skipped: 0 }, { index: 0, file: 'test/a.test.js', phase: 'done', status: 'pass', passed: -1, failed: 0, skipped: 0 }]) check('progress sanitizer rejects ' + JSON.stringify(badEv), RT.rtProgressEvent(badEv, pcfg) === null);
    var seen = []; h = setup();
    await h.entry.run({ files: ['test/a.test.js'] }, 0, { _runTestsOnProgress: function(ev) { seen.push(ev); } });
    check('host forwards only sanitized progress while live', typeof h.opts()._testRunOnProgress === 'function' && (h.opts()._testRunOnProgress({ index: 0, file: 'test/a.test.js', phase: 'start' }), seen.length === 0));
    h = setup({ hung: true }); seen = [];
    var progRun = h.entry.run({ files: ['test/a.test.js'], timeout_ms: 50 }, 0, { _runTestsOnProgress: function(ev) { seen.push(ev); } });
    for (var w = 0; w < 100 && !h.opts(); w++) await Promise.resolve();
    h.opts()._testRunOnProgress({ index: 0, file: 'test/a.test.js', phase: 'start' });
    h.opts()._testRunOnProgress({ index: 0, file: 'test/forged.test.js', phase: 'start' });
    check('live progress forwarded once; forged file dropped', seen.length === 1 && seen[0].phase === 'start' && seen[0].total === 1);
    await progRun;
    h = setup(); await h.entry.run({ files: ['test/a.test.js'], _runTestsOnProgress: function() {} }, 0, {});
    check('model args cannot inject a progress hook', h.opts()._testRunOnProgress === undefined);
    check('test files receive the resolved workspace as args.workspace', fileArgs.length === 1 && fileArgs[0].workspace === 'owner/repo::main');
    // The actual cleanup snapshot callbacks must stop after their independent
    // deadline even when an already-started read settles late. All clocks/effects fake.
    var clock = 1000, reads = [], statuses = 0, finishLateRead;
    var FakeDate = { now: function() { return clock; } };
    var cleanupPolicy = new Function('Date', 'setTimeout', 'clearTimeout', sources['src/js/core/075-test-run-policy.js'] + '\nreturn TestRunPolicy;')(FakeDate, function() { return null; }, function() {});
    var cleanupRun = new Function('Date', 'TestRunPolicy', 'resolveWorkspace', 'wsStatus', 'wsReadRaw', 'executeTool', 'crypto', sources['src/js/tools/160-run-tests.js'] + '\nreturn executeRunTests;')(
        FakeDate, cleanupPolicy, async function() { return 'owner/repo::main'; },
        async function() { statuses++; return { success: true, dirty_files: [{ path: 'src/a' }, { path: 'src/b' }] }; },
        async function(_, path) {
            reads.push(statuses + ':' + path);
            if (statuses === 2 && path === 'src/a') return new Promise(function(resolve) { finishLateRead = resolve; });
            return { success: true, file: { content: path } };
        },
        async function() { return { success: true, result: { host_test_boundary: true, value: { files: [{ file: 'test/a.test.js', status: 'pass', passed: 1, failed: 0, skipped: 0 }] } } }; },
        { subtle: { digest: async function(_, bytes) { return bytes.buffer; } } });
    var cleanupResult = cleanupRun({ files: ['test/a.test.js'] }, 0, {});
    for (var spin = 0; spin < 100 && !finishLateRead; spin++) await Promise.resolve();
    check('post-run snapshot starts with independent read budget', !!finishLateRead);
    clock += 10001; finishLateRead({ success: true, file: { content: 'src/a' } });
    var lateResult = await cleanupResult;
    check('late snapshot read fails closed and cannot initiate subsequent reads', !lateResult.success && !lateResult.isolation.ok && reads.indexOf('2:src/b') < 0);
    // Native cancellation travels only in host options, never model arguments.
    var cancelled = new AbortController(); cancelled.abort(); h = setup();
    var preCancelled = await h.entry.run({}, null, { _runTestsAbortSignal: cancelled.signal });
    check('cancel before dispatch does not resolve workspace or open authority', !preCancelled.success && h.calls.length === 0);
    h = setup();
    var forged = await h.entry.run({ files: ['test/a.test.js'], _runTestsAbortSignal: cancelled.signal, trustedUI: true, force: true }, null, {});
    check('model cancellation and trust args ignored', forged.success);
    h = setup();
    check('forged native args never bypass sandbox guard', !(await h.entry.run({ trustedUI: true, force: true, _runTestsAbortSignal: {} }, null, { fromSandbox: true })).success && !h.calls.length);
    var lateResolve, preparing = new AbortController();
    h = setup({ resolve: function() { return new Promise(function(resolve) { lateResolve = resolve; }); } });
    var preparingRun = h.entry.run({ files: ['test/a.test.js'] }, null, { _runTestsAbortSignal: preparing.signal });
    preparing.abort();
    check('cancel pending preparation returns failure without waiting for late read', !(await preparingRun).success && h.calls.indexOf('eval') < 0);
    lateResolve('owner/repo::main'); await Promise.resolve();
    check('late preparation never dispatches eval', h.calls.indexOf('eval') < 0);
    var inSource = new AbortController();
    h = setup({ onRead: function(path) { if (path === 'test/harness.js') inSource.abort(); } });
    check('cancel while loading source never opens sandbox', !(await h.entry.run({ files: ['test/a.test.js'] }, null, { _runTestsAbortSignal: inSource.signal })).success && h.calls.indexOf('eval') < 0);
    var live = new AbortController(); h = setup({ hung: true });
    var liveRun = h.entry.run({ files: ['test/a.test.js'] }, null, { _runTestsAbortSignal: live.signal });
    for (var n = 0; n < 100 && !h.opts(); n++) await Promise.resolve();
    check('fixture reached live invocation before cancel', !!h.opts());
    live.abort();
    check('native cancel synchronously aborts exact invocation', h.opts()._testRunSignal.aborted);
    check('native cancel synchronously revokes registry key', !h.P.registry.gate(h.opts()._testRunContext, 'workspace', { action: 'status' }).ok);
    check('cancelled hung invocation settles with failure and host cleanup', !(await liveRun).success && h.calls.filter(function(c) { return c === 'status'; }).length === 2);

    // ─── parallel shards ───
    for (var badShards of [0, 9, 1.5, 'x']) check('shards validator rejects ' + JSON.stringify(badShards), !RT.rtValidateArgs({ shards: badShards }).ok);
    check('shards default 4', RT.rtValidateArgs({}).value.shards === 4 && RT.rtValidateArgs({ shards: 8 }).value.shards === 8);
    var pf = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'];
    var plan = RT.rtPlanShards(pf, ['', '', '', ''], { 'test/a.test.js': 400, 'test/b.test.js': 300, 'test/c.test.js': 200, 'test/d.test.js': 100 }, 2);
    check('plan balances by recorded duration (LPT)', plan.length === 2 && plan[0].weight === 500 && plan[1].weight === 500 &&
        JSON.stringify(plan.map(function(p) { return p.indices; })) === '[[0,3],[1,2]]');
    var cover = [].concat.apply([], RT.rtPlanShards(pf, ['test(1);test(2);test(3)', 'test(1)', '', 'test.skip(1);test(2)'], {}, 8).map(function(p) { return p.indices; })).sort();
    check('plan caps shards at file count and covers every file once', JSON.stringify(cover) === '[0,1,2,3]');
    var byCount = RT.rtPlanShards(pf, ['test(1);test(2);test(3)', 'test(1)', 'test(1)', 'test(1)'], {}, 2);
    check('plan falls back to test count without durations', JSON.stringify(byCount.map(function(p) { return p.indices; })) === '[[0],[1,2,3]]');
    var shardEv = RT.rtShardProgressEvent({ index: 1, file: 'test/d.test.js', phase: 'start' }, { files: ['test/b.test.js', 'test/d.test.js'] }, [1, 3], 4);
    check('shard progress remapped to global index', shardEv && shardEv.index === 3 && shardEv.total === 4 && shardEv.file === 'test/d.test.js');
    check('shard progress forged file dropped', RT.rtShardProgressEvent({ index: 1, file: 'test/c.test.js', phase: 'start' }, { files: ['test/b.test.js', 'test/d.test.js'] }, [1, 3], 4) === null);
    function okEntry(f) { return { file: f, status: 'pass', passed: 2, failed: 0, skipped: 0 }; }
    function env(files, extra) { var v = { files: files }; for (var k in (extra || {})) v[k] = extra[k]; return { success: true, result: { host_test_boundary: true, denied_calls: [], value: v } }; }
    var mcfg = { files: pf }, isoOk = { ok: true, host_verified: true };
    var green = RT.rtMergeShardResults([{ indices: [0, 2], evalRes: env([okEntry(pf[0]), okEntry(pf[2])]) }, { indices: [1, 3], evalRes: env([okEntry(pf[1]), okEntry(pf[3])]) }], mcfg, isoOk, []);
    check('merge: all shards valid is green in global order', green.success && green.summary.passed === 8 && green.files.map(function(f) { return f.file; }).join() === pf.join() && green.shards.length === 2);
    var timedOut = RT.rtMergeShardResults([{ indices: [0, 1], evalRes: env([okEntry(pf[0]), okEntry(pf[1])]) }, { indices: [2, 3], evalRes: env([], { aborted: true, timed_out: { file: pf[2], test: 'suite \u203a slow' } }) }], mcfg, isoOk, []);
    check('merge: timed-out shard keeps other shards, names the test, fails', !timedOut.success && timedOut.aborted === true &&
        timedOut.files[0].status === 'pass' && timedOut.files[1].status === 'pass' && timedOut.files[2].status === 'aborted' && timedOut.files[2].failures[0].name === 'suite \u203a slow' &&
        timedOut.files[3].status === 'not_run' && timedOut.summary.aborted === 1 && timedOut.summary.not_run === 1 && timedOut.summary.failed === 1 &&
        /Per-test timeout in test\/c\.test\.js \u203a suite \u203a slow \(shard 2\/2\)/.test(timedOut.error));
    var misnamed = RT.rtMergeShardResults([{ indices: [0, 1, 2, 3], evalRes: env([okEntry(pf[0])], { aborted: true, timed_out: { file: pf[3], test: 't' } }) }], mcfg, isoOk, []);
    check('merge: timeout naming a non-next file fails closed (all not_run)', !misnamed.success && misnamed.files.length === 0 && misnamed.shards[0].status === 'error');
    var missing = RT.rtMergeShardResults([{ indices: [0, 1], evalRes: env([okEntry(pf[0]), okEntry(pf[1])]) }, { indices: [2, 3], evalRes: { success: false, error: 'boom' } }], mcfg, isoOk, []);
    check('merge: missing envelope marks that shard not_run and fails', !missing.success && missing.files[0].status === 'pass' && missing.files[2].status === 'not_run' && missing.files[3].status === 'not_run' &&
        missing.summary.not_run === 2 && missing.shards[1].status === 'error' && /boom/.test(missing.error));
    var shortEnv = RT.rtMergeShardResults([{ indices: [0, 1], evalRes: env([okEntry(pf[0])]) }, { indices: [2, 3], evalRes: env([okEntry(pf[2]), okEntry(pf[3])]) }], mcfg, isoOk, []);
    check('merge: incomplete (non-timeout) envelope fails closed', !shortEnv.success && shortEnv.files[0].status === 'not_run' && shortEnv.files[1].status === 'not_run');
    var dEnv = env([okEntry(pf[0]), okEntry(pf[1])]); dEnv.result.denied_calls = [{ tool: 'get_cookie' }];
    var dEnv2 = env([okEntry(pf[2]), okEntry(pf[3])], { denied_calls: [{ tool: 'workspace' }] });
    var denials = RT.rtMergeShardResults([{ indices: [0, 1], evalRes: dEnv }, { indices: [2, 3], evalRes: dEnv2 }], mcfg, isoOk, [{ tool: 'host' }]);
    check('merge: denied_calls combined across shards and host', !denials.success && denials.denied_calls.length === 3);
    var isoBad = RT.rtMergeShardResults([{ indices: [0, 1, 2, 3], evalRes: env(pf.map(okEntry)) }], mcfg, { ok: false, violations: ['src/x'] }, []);
    check('merge: isolation failure fails the run', !isoBad.success && isoBad.summary.failed === 0);
    var allFail = RT.rtMergeShardResults([{ indices: [0, 1], evalRes: { success: false, error: 'OFFSCREEN_UNAVAILABLE: x' } }, { indices: [2, 3], evalRes: { success: false, error: 'y' } }], mcfg, isoOk, []);
    check('merge: no valid shard keeps legacy empty shape', !allFail.success && allFail.files.length === 0 && /OFFSCREEN_UNAVAILABLE/.test(allFail.error));
    h = setup();
    var sharded = await h.entry.run({ files: pf, shards: 2 }, 0, {});
    check('host: two shards, two exact-frame evals, one snapshot pair', sharded.success && h.allOpts.length === 2 && sharded.summary.passed === 4 && sharded.shards.length === 2 &&
        h.calls.filter(function(c) { return c === 'status'; }).length === 2);
    check('host: each shard has its own registry context', h.allOpts[0]._testRunContext && h.allOpts[0]._testRunContext !== h.allOpts[1]._testRunContext);
    h = setup();
    var serial = await h.entry.run({ files: pf, shards: 1 }, 0, {});
    check('host: shards:1 runs one eval', serial.success && h.allOpts.length === 1);
    var live2 = new AbortController(); h = setup({ hung: true });
    var liveRun2 = h.entry.run({ files: pf, shards: 3 }, null, { _runTestsAbortSignal: live2.signal });
    for (var n2 = 0; n2 < 200 && h.allOpts.length < 3; n2++) await Promise.resolve();
    check('fixture dispatched every shard before cancel', h.allOpts.length === 3);
    live2.abort();
    check('cancel revokes every shard context', h.allOpts.every(function(o) { return o._testRunSignal.aborted && !h.P.registry.gate(o._testRunContext, 'workspace', { action: 'status' }).ok; }));
    check('cancelled sharded run fails', !(await liveRun2).success);
    var seen2 = []; h = setup({ hung: true });
    var progRun2 = h.entry.run({ files: pf, shards: 2, timeout_ms: 50 }, 0, { _runTestsOnProgress: function(ev) { seen2.push(ev); } });
    for (var n3 = 0; n3 < 200 && h.allOpts.length < 2; n3++) await Promise.resolve();
    h.allOpts.forEach(function(o, k) { o._testRunOnProgress({ index: 0, file: k === 0 ? pf[0] : pf[1], phase: 'start' }); });
    check('host remaps shard-local progress to global index', seen2.length === 2 && seen2[0].index === 0 && seen2[1].index === 1 && seen2[1].total === 4 && seen2[1].shard === 1);
    await progRun2;
    return passed;
}

// Harness registration; executable verification uses source + fake bridges only.
var PATHS = ['src/js/core/075-test-run-policy.js', 'src/js/tools/160-run-tests.js'];
await registerRunner('run-tests-tool', async function() { return runRunTestsToolSafetyTests(await loadSources(PATHS)); });
