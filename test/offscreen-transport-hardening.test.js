// PR #1312 hardening: real source slices with fake peers. No Chrome, no network.
// 1 closing document is not ready; 2 one transport retry per shard; 3 per-file
// SANDBOX_TRANSPORT code; 4 narrow transport label; 5 finish() always runs.
function othCut(src, start, end) {
    var i = src.indexOf(start); if (i < 0) throw new Error('slice start missing: ' + start);
    var j = src.indexOf(end, i + start.length); if (j < 0) throw new Error('slice end missing: ' + end);
    return src.slice(i, j);
}

async function othRunTestsEntry(evalImpl) {
    var policySrc = await loadFile('src/js/core/075-test-run-policy.js');
    var rtSrc = await loadFile('src/js/tools/160-run-tests.js');
    function fakeTimer(fn, ms) { return ms < 1000 ? setTimeout(fn, ms) : null; }
    var P = new Function('setTimeout', 'clearTimeout', policySrc + '\nreturn TestRunPolicy;')(fakeTimer, clearTimeout);
    var calls = [];
    var entry = new Function('TestRunPolicy', 'resolveWorkspace', 'wsLs', 'wsReadRaw', 'wsStatus', 'executeTool', 'crypto', 'TextEncoder', 'AbortController',
        rtSrc + '\nreturn { run: executeRunTests, helpers: RunTestsHelpers };')(
        P,
        async function(w) { return w || 'owner/repo::main'; },
        async function() { return { success: true, entries: ['a.test.js', 'b.test.js'] }; },
        async function(w, path) { return { success: true, file: { content: 'source:' + path } }; },
        async function() { return { success: true, dirty_files: [] }; },
        async function(name, args, index, opts) {
            var callCfg = JSON.parse(String(args.code).split('\n')[0].replace(/^var cfg = /, '').replace(/;$/, ''));
            calls.push({ files: callCfg.files.slice(), ctx: opts._testRunContext, id: opts.toolCallId });
            var forced = evalImpl(callCfg.files, calls.length);
            if (forced) return forced;
            var files = callCfg.files.map(function(f) { return { file: f, status: 'pass', passed: 1, failed: 0, skipped: 0 }; });
            return { success: true, result: { host_test_boundary: true, denied_calls: [], value: { success: true, files: files, isolation: { ok: true }, denied_calls: [], summary: { failed: 0 } } } };
        },
        { subtle: { digest: async function(_, bytes) { return bytes.buffer; } } }, TextEncoder, AbortController);
    return { entry: entry, calls: calls };
}

var OTH_CHANNEL = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';

describe('PR1312 item 2: shard transport loss is retried once in a fresh sandbox', function() {
    test('a channel-closed shard is re-run once and the run goes green with transport_retries:1', async function() {
        var seen = {};
        var h = await othRunTestsEntry(function(files) {
            var k = files.join(',');
            if (files.indexOf('test/b.test.js') >= 0 && !seen[k]) { seen[k] = 1; return { success: false, error: OTH_CHANNEL }; }
            return null;
        });
        var r = await h.entry.run({ files: ['test/a.test.js', 'test/b.test.js'], shards: 2 }, 0, { _runTestsLocal: true });
        assert.strictEqual(r.success, true, JSON.stringify(r.error));
        var retried = r.shards.filter(function(s) { return s.transport_retries === 1; });
        assert.strictEqual(retried.length, 1);
        assert.strictEqual(retried[0].status, 'ok');
        assert.strictEqual(h.calls.length, 3);
        var bCalls = h.calls.filter(function(c) { return c.files.indexOf('test/b.test.js') >= 0; });
        assert.strictEqual(bCalls.length, 2);
        assert.notStrictEqual(bCalls[0].ctx, bCalls[1].ctx, 'retry uses a fresh registry context');
        assert.match(String(bCalls[1].id), /_r1$/);
        assert.strictEqual(r.summary.passed, 2);
    }, { tags: ['unit'], timeout: 5000 });

    test('a retry that fails again is reported as before (SANDBOX_TRANSPORT, red) and not retried twice', async function() {
        var h = await othRunTestsEntry(function(files) {
            if (files.indexOf('test/b.test.js') >= 0) return { success: false, error: OTH_CHANNEL };
            return null;
        });
        var r = await h.entry.run({ files: ['test/a.test.js', 'test/b.test.js'], shards: 2 }, 0, { _runTestsLocal: true });
        assert.strictEqual(r.success, false);
        var bad = r.shards.filter(function(s) { return s.status === 'error'; });
        assert.strictEqual(bad.length, 1);
        assert.strictEqual(bad[0].error_code, 'SANDBOX_TRANSPORT');
        assert.strictEqual(bad[0].transport_retries, 1);
        assert.strictEqual(h.calls.filter(function(c) { return c.files.indexOf('test/b.test.js') >= 0; }).length, 2);
        var row = r.files.filter(function(f) { return f.file === 'test/b.test.js'; })[0];
        assert.strictEqual(row.status, 'not_run');
        assert.strictEqual(row.error_code, 'SANDBOX_TRANSPORT');
        assert.match(r.error, /Sandbox transport failure/);
    }, { tags: ['unit'], timeout: 5000 });

    test('real failures, inactivity timeouts and envelope-less successes are never retried', async function() {
        var cases = [
            { success: false, error: 'js_eval timed out after 5 minutes of inactivity (no tool calls or completion)' },
            { success: true, result: { success: true, files: [] } },
            { success: false, error: 'SyntaxError: Unexpected token' }
        ];
        for (var c of cases) {
            var h = await othRunTestsEntry(function(files) { return files.indexOf('test/b.test.js') >= 0 ? c : null; });
            var r = await h.entry.run({ files: ['test/a.test.js', 'test/b.test.js'], shards: 2 }, 0, { _runTestsLocal: true });
            assert.strictEqual(r.success, false);
            assert.strictEqual(h.calls.length, 2, 'no retry for ' + JSON.stringify(c));
            assert.ok(r.shards.every(function(s) { return !s.transport_retries && s.error_code !== 'SANDBOX_TRANSPORT'; }));
        }
    }, { tags: ['unit'], timeout: 5000 });
});

describe('PR1312 items 3+4: transport label is narrow and reaches per-file rows', function() {
    test('rtIsTransportFailure only labels channel/port closure or a missing reply', async function() {
        var h = await othRunTestsEntry(function() { return null; });
        var T = h.entry.helpers.rtIsTransportFailure;
        assert.strictEqual(T({ success: false, error: OTH_CHANNEL }), true);
        assert.strictEqual(T({ success: false, error: 'Offscreen helper returned no response' }), true);
        assert.strictEqual(T({ success: false, error: 'Could not establish connection. Receiving end does not exist.' }), true);
        assert.strictEqual(T(null), true);
        assert.strictEqual(T({ success: true, result: {} }), false);
        assert.strictEqual(T({ success: false, error: 'js_eval timed out after 5 minutes of inactivity (no tool calls or completion)' }), false);
        assert.strictEqual(T({ success: false, error: 'run_tests cancelled' }), false);
        assert.strictEqual(T({ success: false, error: 'OFFSCREEN_CREATE_TIMEOUT: x' }), false);
        assert.strictEqual(T({ success: false, error: 'TypeError: boom' }), false);
    }, { tags: ['unit'], timeout: 3000 });

    test('_reloadNoVerdict sees the code on the merged per-file rows (check is live, not dead)', async function() {
        var h = await othRunTestsEntry(function() { return null; });
        var merged = h.entry.helpers.rtMergeShardResults([
            { indices: [0], evalRes: { success: true, result: { host_test_boundary: true, value: { files: [{ file: 'test/a.test.js', status: 'pass', passed: 1, failed: 0, skipped: 0 }] } } } },
            { indices: [1], evalRes: { success: false, error: OTH_CHANNEL } }
        ], { files: ['test/a.test.js', 'test/b.test.js'] }, { ok: true }, []);
        var row = merged.files[1];
        assert.strictEqual(row.error_code, 'SANDBOX_TRANSPORT');
        var panel = await loadFile('src/js/ui/270-iframe-panel.js');
        var noVerdict = new Function(othCut(panel, 'function _reloadNoVerdict(', '\n}') + '\n}\nreturn _reloadNoVerdict;')();
        // Strip the not_run status: the error_code arm alone must classify it.
        assert.strictEqual(noVerdict({ status: 'error', error_code: row.error_code }), true);
        assert.strictEqual(noVerdict({ status: 'fail' }), false);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('PR1312 item 1: a document being closed is never ready', function() {
    test('waitForOffscreenReady awaits an in-flight close and does not trust the stale port', async function() {
        var bg = await loadFile('src/platform/extension/background.js');
        var src = othCut(bg, 'function _swOffscreenWithin(', '// Close + recreate a wedged document.') + othCut(bg, 'function waitForOffscreenReady(', '// Fail closed on hybrid installs');
        var env = { port: 'old-port', closing: null, resolvers: [], ensured: 0 };
        var wait = new Function('env', 'self', 'chrome', 'console',
            'var _swOffscreenReadyResolvers = env.resolvers, _swOffscreenHealing = null, _swOffscreenLastError = null;\n' +
            src.replace(/_swOffscreenKeepAlivePort/g, 'env.port').replace(/_swOffscreenClosing/g, 'env.closing') +
            '\nfunction ensureOffscreenDocument() { env.ensured++; return Promise.resolve(); }\nreturn waitForOffscreenReady;'
        )(env, {}, { offscreen: {} }, console);
        var releaseClose;
        env.closing = new Promise(function(r) { releaseClose = r; }).then(function() { env.port = null; });
        var outcome = null;
        var p = wait(5000).then(function(v) { outcome = v; });
        await new Promise(function(r) { setTimeout(r, 20); });
        assert.strictEqual(outcome, null, 'must not report ready while the close is in progress (port still set)');
        env.closing.then(function() { env.closing = null; });
        releaseClose();
        await new Promise(function(r) { setTimeout(r, 20); });
        assert.strictEqual(outcome, null, 'after the close it waits for a FRESH document');
        assert.ok(env.ensured >= 1, 'ensure (recreate) was requested after the close');
        env.port = 'new-port';
        env.resolvers.splice(0).forEach(function(fn) { fn(); });
        await p;
        assert.strictEqual(outcome, true);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('PR1312 item 5: finish() runs even if waitForOffscreenReady throws synchronously', function() {
    test('sync throw rejects the call and releases the in-flight counter', async function() {
        var bg = await loadFile('src/platform/extension/background.js');
        var src = othCut(bg, 'async function callOffscreenHelper(', '// Expose to the imported SW bundle.');
        var state = { inflight: 0 };
        var call = new Function('waitForOffscreenReady', 'chrome', 'state',
            'var _swOffscreenInFlight = 0, _swOffscreenIdleSince = 0, _swOffscreenLastError = null;\n' +
            'function swAnyChatRunning() { return false; }\n' + src +
            '\nreturn { call: callOffscreenHelper, inflight: function() { return _swOffscreenInFlight; } };')(
            function() { throw new Error('sync boom'); }, { runtime: { sendMessage: function() { return Promise.resolve({ ok: true }); } } }, state);
        var err = null;
        await call.call('helper-image', {}, 1000).catch(function(e) { err = e; });
        assert.ok(err && /sync boom/.test(err.message), 'rejects with the thrown error');
        assert.strictEqual(call.inflight(), 0, 'counter released by finish()');
    }, { tags: ['unit'], timeout: 3000 });
});
