// run_tests page-path regressions after #1240 (parallel shards):
// - page ingress (Reload pre-check) is delegated to the SW / offscreen sandbox;
// - pre-dispatch failures keep a readable, failing envelope (files + summary);
// - every shard gets its own tool-call id even without a host toolCallId;
// - denial accounting (no double count, timeout denials kept) and timed_out.file.

var EX = await runFile('test/extract.js', { i18n: false });
async function rrEntry(evalImpl, env) {
    env = env || {};
    var P = new Function('setTimeout', 'clearTimeout', (await loadFile('src/js/core/075-test-run-policy.js')) + '\nreturn TestRunPolicy;')(function() { return null; }, function() {});
    var calls = [];
    var entry = new Function('TestRunPolicy', 'resolveWorkspace', 'wsLs', 'wsReadRaw', 'wsStatus', 'executeTool', 'crypto', 'TextEncoder', 'AbortController', 'Platform', '_agentBusPort', 'setTimeout', 'clearTimeout',
        (await loadFile('src/js/tools/160-run-tests.js')) + '\nreturn { run: executeRunTests, helpers: RunTestsHelpers };')(
        P,
        async function(w) { return w || 'owner/repo::main'; },
        async function() { return { success: true, entries: ['a.test.js', 'b.test.js', 'harness.js'] }; },
        env.read || async function(w, path) { return { success: true, file: { content: 'test("x", function(){});' } }; },
        env.status || async function() { return { success: true, dirty_files: [] }; },
        async function(name, args, i, opts) { calls.push({ name: name, opts: opts }); return evalImpl(name, args, opts); },
        { subtle: { digest: async function(_, b) { return b.buffer; } } }, TextEncoder, AbortController,
        env.Platform, env.port, env.setTimeout || function() { return 1; }, env.clearTimeout || function() {});
    entry.calls = calls; entry.P = P;
    return entry;
}
function rrEnvelope(files, extra) { return { success: true, result: Object.assign({ host_test_boundary: true, denied_calls: [], value: { files: files, denied_calls: [] } }, extra || {}) }; }
function rrFile(file) { return { file: file, status: 'pass', passed: 1, failed: 0, skipped: 0 }; }
var RA = 'test/a.test.js', RB = 'test/b.test.js';
function rrFilesOf(args) { var m = /var cfg = (\{.*?\});\n/.exec(args.code); return JSON.parse(m[1]).files; }

describe('run_tests page path: SW/offscreen routing', function() {
    test('a Reload-shaped page call is delegated to the SW and never runs a local frame', async function() {
        var posted = [];
        var port = { postMessage: function(m) { posted.push(m); } };
        var e = await rrEntry(async function() { throw new Error('local js_eval must not run'); }, { port: port });
        var progress = [];
        var p = e.run({ files: [RA, RB], tags: ['unit', 'canary'], timeout_ms: 600000 }, null, { _runTestsOnProgress: function(ev) { progress.push(ev); } });
        await Promise.resolve();
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].type, 'run-tests-exec');
        assert.deepStrictEqual(posted[0].args.files, [RA, RB]);
        var id = posted[0].requestId;
        e.helpers.rtHandleWorkerMessage({ type: 'run-tests-progress', requestId: id, event: { index: 1, file: RB, phase: 'start', shard: 1 } });
        e.helpers.rtHandleWorkerMessage({ type: 'run-tests-progress', requestId: id, event: { index: 0, file: 'test/forged.test.js', phase: 'start' } });
        e.helpers.rtHandleWorkerMessage({ type: 'run-tests-progress', requestId: 'other', event: { index: 0, file: RA, phase: 'start' } });
        var verdict = { success: true, files: [rrFile(RA), rrFile(RB)], summary: { files: 2 } };
        e.helpers.rtHandleWorkerMessage({ type: 'run-tests-result', requestId: id, result: verdict });
        var r = await p;
        assert.strictEqual(r, verdict);
        assert.strictEqual(e.calls.length, 0);
        assert.strictEqual(progress.length, 1);
        assert.strictEqual(progress[0].file, RB);
        assert.strictEqual(progress[0].shard, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('cancel posts run-tests-cancel and fails; a missing SW result fails closed', async function() {
        var posted = [];
        var e = await rrEntry(async function() { throw new Error('no local'); }, { port: { postMessage: function(m) { posted.push(m); } } });
        var ctrl = new AbortController();
        var p = e.run({ files: [RA] }, null, { _runTestsAbortSignal: ctrl.signal });
        await Promise.resolve();
        ctrl.abort();
        var r = await p;
        assert.strictEqual(r.success, false);
        assert.ok(Array.isArray(r.files) && r.summary && r.error);
        assert.strictEqual(posted[1].type, 'run-tests-cancel');
        assert.strictEqual(posted[1].requestId, posted[0].requestId);
        var p2 = e.run({ files: [RA] }, null, {});
        await Promise.resolve();
        e.helpers.rtHandleWorkerMessage({ type: 'run-tests-result', requestId: posted[2].requestId, result: null });
        var r2 = await p2;
        assert.strictEqual(r2.success, false);
        assert.strictEqual(r2.error_code, 'WORKER_NO_RESULT');
        assert.strictEqual(e.calls.length, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('a request that never reached the SW falls back to the guarded local path', async function() {
        var e = await rrEntry(async function(n, args) { return rrEnvelope(rrFilesOf(args).map(rrFile)); }, { port: { postMessage: function() { throw new Error('port closed'); } } });
        var r = await e.run({ files: [RA] }, null, {});
        assert.strictEqual(r.success, true);
        assert.strictEqual(e.calls.length, 1);
        assert.strictEqual(r.isolation.ok, true);
    }, { tags: ['unit'], timeout: 5000 });

    test('the SW serves the request locally (no re-delegation) and posts the verdict', async function() {
        var e = await rrEntry(async function(n, args) { return rrEnvelope(rrFilesOf(args).map(rrFile)); }, { Platform: { isWorker: true }, port: { postMessage: function() { throw new Error('SW must not re-delegate'); } } });
        var out = [];
        var done = new Promise(function(resolve) { e.helpers.rtServeWorkerRequest({ postMessage: function(m) { out.push(m); if (m.type === 'run-tests-result') resolve(m); } }, { requestId: 'q1', args: { files: [RA, RB], shards: 2 } }); });
        var m = await done;
        assert.strictEqual(m.requestId, 'q1');
        assert.strictEqual(m.result.success, true);
        assert.strictEqual(m.result.summary.passed, 2);
        assert.strictEqual(e.calls.length, 2);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('run_tests: pre-dispatch failures and shard ids', function() {
    test('end-to-end: no toolCallId with shards>1 gives every shard its own id', async function() {
        var e = await rrEntry(async function(n, args) { return rrEnvelope(rrFilesOf(args).map(rrFile)); });
        var r = await e.run({ files: [RA, RB], shards: 2 }, null, {});
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.shards.length, 2);
        var ids = e.calls.map(function(c) { return c.opts.toolCallId; });
        assert.strictEqual(ids.length, 2);
        assert.ok(ids.every(function(id) { return typeof id === 'string' && id; }), JSON.stringify(ids));
        assert.notStrictEqual(ids[0], ids[1]);
    }, { tags: ['unit'], timeout: 5000 });

    test('a source-read failure before dispatch returns a readable failing envelope', async function() {
        var e = await rrEntry(async function() { throw new Error('must not dispatch'); }, { read: async function(w, path) { return path === 'test/harness.js' ? { success: false, error: 'gone' } : { success: true, file: { content: 'x' } }; } });
        var r = await e.run({ files: [RA] }, null, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'PRE_DISPATCH_FAILED');
        assert.ok(Array.isArray(r.files) && r.files.length === 0);
        assert.strictEqual(r.summary.files, 0);
        assert.ok(r.error.indexOf('Cannot read complete source: test/harness.js') > 0, r.error);
        assert.strictEqual(e.calls.length, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('a baseline failure returns the same shape with the cause', async function() {
        var e = await rrEntry(async function() { throw new Error('must not dispatch'); }, { status: async function() { throw new Error('status exploded'); } });
        var r = await e.run({ files: [RA] }, null, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'PRE_DISPATCH_FAILED');
        assert.ok(r.summary && Array.isArray(r.files));
        assert.ok(/baseline/.test(r.error) && r.error.indexOf('status exploded') > 0, r.error);
        assert.strictEqual(r.isolation.ok, false);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('run_tests: denial accounting and timed_out.file', function() {
    test('page envelope denials equal to host denials are not double counted; extra ones are kept', async function() {
        var H = (await rrEntry(async function() {})).helpers;
        var d = { tool: 'get_cookie', reason: 'denied' };
        assert.strictEqual(H.rtCombineDenials([d], [{ tool: 'get_cookie', reason: 'denied' }], []).length, 1);
        assert.strictEqual(H.rtCombineDenials([d], [d, { tool: 'x' }], [{ tool: 'y' }]).length, 3);
        assert.strictEqual(H.rtCombineDenials([], [d], []).length, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('a timeout result keeps sandbox denials and an empty timed_out.file fails closed', async function() {
        var H = (await rrEntry(async function() {})).helpers;
        var cfg = { files: [RA, RB] };
        var ok = H.rtMergeShardResults([{ indices: [0, 1], evalRes: rrEnvelope([rrFile(RA)], {}) }], cfg, { ok: true }, []);
        assert.strictEqual(ok.success, false);
        var withDenial = rrEnvelope([rrFile(RA)]);
        withDenial.result.value = { files: [rrFile(RA)], aborted: true, timed_out: { file: RB, test: 't' }, denied_calls: [{ tool: 'z' }] };
        var m1 = H.rtMergeShardResults([{ indices: [0, 1], evalRes: withDenial }], cfg, { ok: true }, []);
        assert.strictEqual(m1.denied_calls.length, 1);
        assert.strictEqual(m1.shards[0].status, 'timed_out');
        var empty = rrEnvelope([rrFile(RA)]);
        empty.result.value = { files: [rrFile(RA)], aborted: true, timed_out: { file: '', test: 't' } };
        var m2 = H.rtMergeShardResults([{ indices: [0, 1], evalRes: empty }], cfg, { ok: true }, []);
        assert.strictEqual(m2.success, false);
        assert.strictEqual(m2.shards[0].status, 'error');
    }, { tags: ['unit'], timeout: 5000 });

    test('a per-test timeout carries sandbox denials through the sandbox code, runFrame and the merge', async function() {
        var e = await rrEntry(async function() {});
        var H = e.helpers, posted = [];
        var AsyncFn = Object.getPrototypeOf(async function() {}).constructor;
        var guard = { denied_calls: [{ tool: 'g', reason: 'guard' }] }, n = 0;
        var fakeH = { install: function() {}, installToolGuard: function() { return guard; }, reset: function() {},
            run: async function(o) { o.onTimeout({ test: 't1', file: RA }); return { passed: 0, failed: 0, skipped: 0, tests: [], aborted: true }; } };
        await new AsyncFn('evalModule', 'window', 'parent', H.rtBuildSandboxCode({ files: [RA, RB], sources: ['', ''], harness_source: '', harness: 'test/harness.js', workspace: 'o/r::main', tags: ['unit'], test_timeout_ms: 1000 }))(
            async function() { return n++ === 0 ? fakeH : {}; }, {}, { postMessage: function(m) { posted.push(m); } });
        var tmsg = posted.filter(function(m) { return m.type === 'sandboxTestTimeout'; })[0];
        assert.ok(tmsg, JSON.stringify(posted));
        assert.deepStrictEqual(tmsg.partial.denied_calls, guard.denied_calls);
        assert.notStrictEqual(tmsg.partial.denied_calls, guard.denied_calls);
        var reg = e.P.createRegistry(), key = reg.open({ workspace: 'o/r::main', deadline: Date.now() + 60000 }), handler = null;
        var frame = { style: {}, addEventListener: function() {}, removeEventListener: function() {}, contentWindow: { postMessage: function() {} }, parentNode: null };
        var p = e.P.runFrame({ registry: reg, context: key, code: '', dispatch: function() {}, window: { addEventListener: function(t, f) { handler = f; }, removeEventListener: function() { handler = null; } },
            document: { createElement: function() { return frame; }, body: { appendChild: function() {} } } });
        handler({ source: frame.contentWindow, data: tmsg });
        var env = await p;
        assert.strictEqual(handler, null);
        assert.deepStrictEqual(env.value.denied_calls, guard.denied_calls);
        assert.throws(function() { reg.descriptor(key); });
        var m = H.rtMergeShardResults([{ indices: [0, 1], evalRes: { success: true, result: env }, hostDenials: [] }], { files: [RA, RB] }, { ok: true }, []);
        assert.strictEqual(m.success, false);
        assert.strictEqual(m.shards[0].status, 'timed_out');
        assert.deepStrictEqual(m.denied_calls, guard.denied_calls);
    }, { tags: ['unit'], timeout: 5000 });

    test('envelope denials are deduped only against their own shard host log', async function() {
        var H = (await rrEntry(async function() {})).helpers;
        var d = { tool: 'get_cookie', reason: 'denied' }, cfg = { files: [RA, RB] };
        var s0 = rrEnvelope([rrFile(RA)]); s0.result.denied_calls = [d];
        var s1 = rrEnvelope([rrFile(RB)]); s1.result.denied_calls = [d];
        var m = H.rtMergeShardResults([{ indices: [0], evalRes: s0, hostDenials: [d] }, { indices: [1], evalRes: s1, hostDenials: [] }], cfg, { ok: true }, [d]);
        assert.strictEqual(m.denied_calls.length, 2);
        assert.strictEqual(m.success, false);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('run_tests SW delegation: fail-closed lifecycle', function() {
    function fakeTimers() {
        var list = [];
        return { list: list, set: function(fn, ms) { var t = { fn: fn, ms: ms, cleared: false }; list.push(t); return t; }, clear: function(t) { if (t) t.cleared = true; } };
    }
    function fakeSignal() {
        var ls = [];
        return { aborted: false, listeners: ls, addEventListener: function(t, f) { ls.push(f); }, removeEventListener: function(t, f) { var i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); } };
    }
    test('WORKER_TIMEOUT fires from the controllable timer, cancels remotely and cleans up', async function() {
        var T = fakeTimers(), posted = [], sig = fakeSignal();
        var e = await rrEntry(async function() { throw new Error('no local'); }, { port: { postMessage: function(m) { posted.push(m); } }, setTimeout: T.set, clearTimeout: T.clear });
        var p = e.run({ files: [RA], timeout_ms: 60000 }, null, { _runTestsAbortSignal: sig });
        await Promise.resolve();
        assert.strictEqual(T.list.length, 1);
        assert.strictEqual(T.list[0].ms, 90000);
        assert.strictEqual(sig.listeners.length, 1);
        T.list[0].fn();
        var r = await p;
        assert.strictEqual(r.error_code, 'WORKER_TIMEOUT');
        assert.strictEqual(r.success, false);
        assert.strictEqual(posted[1].type, 'run-tests-cancel');
        assert.strictEqual(sig.listeners.length, 0);
        assert.strictEqual(e.helpers.rtWorkerRunCounts().page, 0);
        assert.strictEqual(e.calls.length, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('bus port loss fails pending runs with WORKER_DISCONNECTED (only that port) and clears timers', async function() {
        var T = fakeTimers(), sig = fakeSignal();
        var portA = { postMessage: function() {} };
        var e = await rrEntry(async function() { throw new Error('no local'); }, { port: portA, setTimeout: T.set, clearTimeout: T.clear });
        var p = e.run({ files: [RA] }, null, { _runTestsAbortSignal: sig });
        await Promise.resolve();
        e.helpers.rtWorkerPortLost({ postMessage: function() {} });
        assert.strictEqual(e.helpers.rtWorkerRunCounts().page, 1);
        e.helpers.rtWorkerPortLost(portA);
        var r = await p;
        assert.strictEqual(r.error_code, 'WORKER_DISCONNECTED');
        assert.strictEqual(r.success, false);
        assert.ok(Array.isArray(r.files) && r.summary);
        assert.ok(T.list[0].cleared);
        assert.strictEqual(sig.listeners.length, 0);
        assert.strictEqual(e.helpers.rtWorkerRunCounts().page, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('two concurrent page runs do not cross over; malformed SW results fail closed', async function() {
        var posted = [];
        var e = await rrEntry(async function() { throw new Error('no local'); }, { port: { postMessage: function(m) { posted.push(m); } } });
        var p1 = e.run({ files: [RA] }, null, {}), p2 = e.run({ files: [RB] }, null, {});
        await Promise.resolve(); await Promise.resolve();
        assert.strictEqual(posted.length, 2);
        assert.ok(posted.every(function(m) { return !('chatId' in m) && !('options' in m); }));
        var v2 = { success: true, files: [rrFile(RB)], summary: { files: 1 } };
        e.helpers.rtHandleWorkerMessage({ type: 'run-tests-result', requestId: posted[1].requestId, result: v2 });
        e.helpers.rtHandleWorkerMessage({ type: 'run-tests-result', requestId: posted[0].requestId, result: { success: true } });
        assert.strictEqual(await p2, v2);
        var r1 = await p1;
        assert.strictEqual(r1.success, false);
        assert.strictEqual(r1.error_code, 'WORKER_BAD_RESULT');
    }, { tags: ['unit'], timeout: 5000 });

    test('progress is forwarded without an explicit files list, and forged paths are dropped', async function() {
        var H = (await rrEntry(async function() {})).helpers;
        var ev = H.rtWorkerProgressEvent({ index: 1, total: 3, file: RB, phase: 'start', shard: 2 }, null);
        assert.deepStrictEqual(ev, { index: 1, file: RB, total: 3, phase: 'start', shard: 2 });
        assert.strictEqual(H.rtWorkerProgressEvent({ index: 0, total: 3, file: 'src/evil.js', phase: 'start' }, null), null);
        assert.strictEqual(H.rtWorkerProgressEvent({ index: 3, total: 3, file: RB, phase: 'start' }, null), null);
        assert.strictEqual(H.rtWorkerProgressEvent({ index: 0, file: RB, phase: 'start' }, [RA]), null);
    }, { tags: ['unit'], timeout: 5000 });

    async function swEntry(block) {
        var ctxs = [];
        var e = await rrEntry(function(n, args, opts) { ctxs.push(opts._testRunContext); return block ? new Promise(function() {}) : Promise.resolve(rrEnvelope(rrFilesOf(args).map(rrFile))); }, { Platform: { isWorker: true } });
        e.ctxs = ctxs;
        return e;
    }
    function swPort() { var p = { out: [], postMessage: function(m) { p.out.push(m); } }; p.result = function(id) { return p.out.filter(function(m) { return m.type === 'run-tests-result' && m.requestId === id; }); }; return p; }
    async function until(fn) { for (var i = 0; i < 200 && !fn(); i++) await new Promise(function(r) { Promise.resolve().then(r); }); }

    test('SW cancel aborts the run and revokes its contexts; another port cannot cancel it', async function() {
        var e = await swEntry(true), A = swPort(), B = swPort();
        e.helpers.rtServeWorkerRequest(A, { requestId: 'q', args: { files: [RA, RB], shards: 2 } });
        await until(function() { return e.ctxs.length === 2; });
        assert.strictEqual(e.ctxs.length, 2);
        e.helpers.rtCancelWorkerRequest(B, { requestId: 'q' });
        await Promise.resolve(); await Promise.resolve();
        assert.strictEqual(A.result('q').length, 0);
        e.ctxs.forEach(function(c) { assert.ok(e.P.registry.descriptor(c)); });
        e.helpers.rtCancelWorkerRequest(A, { requestId: 'q' });
        await until(function() { return A.result('q').length === 1; });
        assert.strictEqual(A.result('q')[0].result.success, false);
        e.ctxs.forEach(function(c) { assert.throws(function() { e.P.registry.descriptor(c); }); });
        assert.deepStrictEqual(e.helpers.rtWorkerRunCounts(), { page: 0, host: 0, host_ports: 0 });
    }, { tags: ['unit'], timeout: 5000 });

    test('SW: port disconnect aborts its runs; a duplicate id gets an explicit error; forged options are ignored', async function() {
        var e = await swEntry(true), A = swPort(), B = swPort(), forged = [];
        e.helpers.rtServeWorkerRequest(A, { requestId: 'q', args: { files: [RA] }, chatId: 'evil', _runTestsLocal: false, options: { chatId: 'evil', _runTestsOnProgress: function() { forged.push(1); } } });
        e.helpers.rtServeWorkerRequest(B, { requestId: 'q', args: { files: [RB] } });
        await until(function() { return e.ctxs.length === 2; });
        assert.strictEqual(e.calls.length, 2);
        assert.ok(e.calls.every(function(c) { return c.opts.chatId === undefined; }));
        e.helpers.rtServeWorkerRequest(B, { requestId: 'q', args: { files: [RB] } });
        assert.strictEqual(B.result('q')[0].result.error_code, 'DUPLICATE_REQUEST');
        e.helpers.rtWorkerHostPortClosed(A);
        await until(function() { return A.result('q').length === 1 && B.result('q').length === 2; });
        assert.strictEqual(A.result('q')[0].result.success, false);
        e.ctxs.forEach(function(c) { assert.throws(function() { e.P.registry.descriptor(c); }); });
        assert.strictEqual(forged.length, 0);
        assert.deepStrictEqual(e.helpers.rtWorkerRunCounts(), { page: 0, host: 0, host_ports: 0 });
    }, { tags: ['unit'], timeout: 5000 });
});

describe('Reload checklist: pre-dispatch failure rows', function() {
    test('_reloadSuiteRows shows the cause once on the first row and fails every suite', async function() {
        var src = await loadFile('src/js/ui/270-iframe-panel.js');
        function fn(name) { var f = EX.findFunction(src, name, { includeAsync: false }); assert.ok(f && f.end > f.start, name); return src.slice(f.start, f.end); }
        var rows = new Function(fn('_reloadSuiteResult') + fn('_reloadSuiteRows') + 'return _reloadSuiteRows;')();
        var H = (await rrEntry(async function() {})).helpers;
        var r = rows(H.rtFailedRunResult('run_tests failed before any test ran: Cannot read complete source: test/harness.js', 'PRE_DISPATCH_FAILED'), [RA, RB]);
        assert.strictEqual(r.length, 2);
        assert.ok(r.every(function(x) { return x.state === 'error'; }));
        assert.ok(r[0].detail.indexOf('Cannot read complete source: test/harness.js') > 0, r[0].detail);
        assert.ok(r[1].detail.indexOf('Cannot read') < 0 && /cause on the first row/.test(r[1].detail), r[1].detail);
        var ok = rows({ success: true, files: [], summary: { files: 0, total: 0, passed: 0, failed: 0, skipped: 0, no_assertions: 0 } }, [RA]);
        assert.ok(/Malformed|Not reported/.test(ok[0].detail) && ok[0].state === 'error');
    }, { tags: ['unit'], timeout: 5000 });
});
