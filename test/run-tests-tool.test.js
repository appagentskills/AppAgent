// Executes the real host entry point with fake workspace/eval bridges. No live
// run_tests/run_js_file invocation, no network, no writes, no Chrome effects.
async function runRunTestsToolSafetyTests(sources) {
    var passed = [];
    function check(name, yes) { if (!yes) throw new Error(name); passed.push(name); }
    function setup(options) {
        options = options || {};
        var calls = [], statusCount = 0, evalOptions;
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
                calls.push('eval'); evalOptions = opts;
                if (options.hung) return new Promise(function() {});
                if (options.denied) P.registry.gate(opts._testRunContext, 'get_cookie', {});
                if (options.noEnvelope) return { success: true, result: { success: true, files: [] } };
                var files = (options.files || ['test/a.test.js']).map(function(f) { return { file: f, status: 'pass', passed: 1, failed: 0, skipped: 0 }; });
                return { success: true, result: { host_test_boundary: true, denied_calls: options.offscreenDenied ? [{ tool: 'workspace', reason: 'mutation' }] : [], value: { success: true, files: files, isolation: { ok: true }, denied_calls: [], summary: { failed: 0 } } } };
            },
            { subtle: { digest: async function(_, bytes) { return bytes.buffer; } } }, TextEncoder, AbortController
        );
        return { P: P, entry: entry, calls: calls, opts: function() { return evalOptions; } };
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
    var programResult = await program(async function(_, path) { return path === 'test/harness.js' ? H : {}; }, fakeWindow, { postMessage: function(m) { timeoutMessage = m; } });
    check('per-test timeout signals trusted host and aborts remaining files', timeoutMessage.type === 'sandboxTestTimeout' && programResult.aborted && filesVisited.length === 1);
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
    return passed;
}

// Harness registration; executable verification uses source + fake bridges only.
var PATHS = ['src/js/core/075-test-run-policy.js', 'src/js/tools/160-run-tests.js'];
await registerRunner('run-tests-tool', async function() { return runRunTestsToolSafetyTests(await loadSources(PATHS)); });
