// Reload preflight watchdog: chat-less worker-served test frames must get
// inactivity-clock activity from relayed progress / inner calls (per call,
// keyed by sandbox request id), while silent frames still die at 5 minutes.
// Executes the REAL worker js_eval arm, SW transport/relays and offscreen
// ingress with fake clocks, intervals, Chrome and helper. No live tool calls.
function wdCut(text, start, end) { var a = text.indexOf(start), b = text.indexOf(end, a); if (a < 0 || b < 0) throw new Error('Missing marker: ' + start); return text.slice(a, b); }
async function wdFlush() { for (var i = 0; i < 20; i++) await Promise.resolve(); }
function wdClock() {
    var now = 1000000, timers = new Map(), seq = 0;
    return {
        Date: { now: function() { return now; } },
        setInterval: function(fn, ms) { var id = ++seq; timers.set(id, { fn: fn, ms: ms, at: now + ms }); return id; },
        clearInterval: function(id) { timers.delete(id); },
        advance: async function(ms) {
            var end = now + ms;
            for (;;) {
                var next = null;
                timers.forEach(function(t, id) { if (t.at <= end && (!next || t.at < next.t.at)) next = { id: id, t: t }; });
                if (!next) break;
                now = next.t.at; next.t.at += next.t.ms; next.t.fn();
                await wdFlush();
            }
            now = end; await wdFlush();
        },
        active: function() { return timers.size; }
    };
}
// Real worker js_eval arm with injected clock/interval and a fake offscreen helper.
var WD_EXEC_SRC = null;
function wdWorkerArm(helper, options, clock) {
    var src = WD_EXEC_SRC;
    var arm = wdCut(src, "            if (typeof Platform !== 'undefined' && Platform.isWorker) {", '                var jsEvalResultSw') + '\nreturn swEvalResult;\n}';
    var AF = Object.getPrototypeOf(async function() {}).constructor;
    var fn = new AF('Platform', 'args', '_testKey', 'options', 'TestRunPolicy', 'chatId', 'messageIndex', '_sandboxEvalCount', '_sandboxPending', '_sandboxActivity', '_SANDBOX_HOLD_MAX_MS', 'lastLargeResponseByChatId', '_sandboxEvalCleanup', 'self', 'Date', 'setInterval', 'clearInterval', arm);
    var key = options._testRunContext || null;
    var P = { registry: { descriptor: function() { return {}; } } };
    return fn({ isWorker: true, callOffscreenHelper: helper }, { code: 'return 1;' }, key, options, P, null, 0, {}, {}, {}, 60000, {}, function() {}, {}, clock.Date, clock.setInterval, clock.clearInterval);
}
function wdOutcome(p) { var o = { done: false }; p.then(function(v) { o.done = true; o.value = v; }, function(e) { o.done = true; o.error = e; }); return o; }

describe('worker test-frame inactivity watchdog', function() {
    beforeEach(async function() { if (!WD_EXEC_SRC) WD_EXEC_SRC = await loadFile('src/js/tools/020-tool-execution.js'); });
    test('progress every 60s for 7 minutes keeps a chat-less test frame alive', async function() {
        var clock = wdClock(), seen = [], payload, resolveHelper;
        var helper = function(type, p) { payload = p; return new Promise(function(r) { resolveHelper = r; }); };
        var run = wdOutcome(wdWorkerArm(helper, { _testRunContext: { k: 1 }, _testRunOnProgress: function(ev) { seen.push(ev.file); } }, clock));
        await wdFlush();
        assert.strictEqual(typeof payload._onActivity, 'function', 'test frames register a per-call activity hook');
        for (var m = 1; m <= 7; m++) { await clock.advance(60000); assert.strictEqual(run.done, false, 'alive at minute ' + m); payload._onActivity({ file: 'test/f' + m + '.test.js', phase: 'done' }); }
        resolveHelper({ ok: 1 }); await wdFlush();
        assert.strictEqual(run.done, true); assert.strictEqual(run.error, undefined); assert.deepStrictEqual(run.value, { ok: 1 });
        assert.strictEqual(seen.length, 7, 'progress forwarded to the host-only hook');
        assert.strictEqual(clock.active(), 0, 'watchdog interval cleared');
    }, { tags: ['unit'], timeout: 5000 });

    test('silent test frame still times out at 5 minutes', async function() {
        var clock = wdClock();
        var run = wdOutcome(wdWorkerArm(function() { return new Promise(function() {}); }, { _testRunContext: { k: 2 } }, clock));
        await wdFlush();
        await clock.advance(4 * 60000 + 45000);
        assert.strictEqual(run.done, false, 'not before 5 minutes');
        await clock.advance(15000);
        assert.strictEqual(run.done, true); assert.match(String(run.error && run.error.message), /5 minutes of inactivity/);
    }, { tags: ['unit'], timeout: 5000 });

    test('non-test js_eval registers no activity hook (behavior unchanged)', async function() {
        var clock = wdClock(), payload;
        var run = wdOutcome(wdWorkerArm(function(t, p) { payload = p; return Promise.resolve(2); }, {}, clock));
        await wdFlush();
        assert.strictEqual(run.value, 2); assert.strictEqual('_onActivity' in payload, false);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('SW transport + relays stamp the per-request activity hook', function() {
    async function sw() {
        var bg = await loadFile('src/platform/extension/background.js');
        var policy = await loadFile('src/js/core/075-test-run-policy.js');
        var P = new Function(policy + '\nreturn TestRunPolicy;')();
        var startup = wdCut(bg, 'function swTestPolicyStartupError()', '// Called by the SW runtime');
        var transportSrc = startup + wdCut(bg, 'async function callOffscreenHelper(', '// Expose to the imported SW bundle.');
        var relaySrc = wdCut(bg, "    if (message.type === 'sw-exec-tool') {", '\n    // Offscreen helper requests an UNTHROTTLED sleep');
        var progSrc = wdCut(bg, "    if (message.type === 'sw-sandbox-progress') {", '\n    // Side panel requests browser action');
        var wire, release, chrome = { runtime: { id: 'x', getURL: function(p) { return 'chrome-extension://x/' + p; }, sendMessage: function(m) { wire = m; return new Promise(function(r) { release = r; }); } } };
        var seq = 0;
        var env = new Function('waitForOffscreenReady', 'chrome', 'crypto', 'TestRunPolicy', 'executeTool', transportSrc +
            '\nreturn { call: callOffscreenHelper, relay: function(message, sender, sendResponse) {' + relaySrc + '}, progress: function(message, sender, sendResponse) {' + progSrc + '} };')(
            async function() { return true; }, chrome, { randomUUID: function() { return String(++seq); } }, P,
            function() { return Promise.resolve({ success: true }); });
        return { env: env, P: P, chrome: chrome, wire: function() { return wire; }, release: function(v) { release(v); } };
    }
    test('progress + inner calls reach the hook; wire never carries it; finished ids are ignored', async function() {
        var s = await sw(), hits = [];
        var key = s.P.registry.open({ workspace: 'o/r::main', deadline: Date.now() + 60000 });
        var p = s.env.call('helper-js-eval', { _testRunContext: key, _onActivity: function(ev) { hits.push(ev); }, chatId: null }, 5000);
        await wdFlush();
        var w = s.wire(), id = w.payload.sandboxRequestId, trusted = { id: 'x', url: s.chrome.runtime.getURL('offscreen.html') };
        assert.strictEqual('_onActivity' in w.payload, false, 'hook never crosses the wire');
        var r1; s.env.progress({ type: 'sw-sandbox-progress', payload: { sandboxRequestId: id, progress: { file: 'test/a.test.js', phase: 'start', index: 0, evil: { x: 1 } } } }, trusted, function(r) { r1 = r; });
        assert.strictEqual(r1.result.accepted, true);
        assert.deepStrictEqual(hits[0], { type: 'sandboxTestProgress', index: 0, file: 'test/a.test.js', phase: 'start' }, 'sanitized plain fields only');
        var r2; s.env.progress({ type: 'sw-sandbox-progress', payload: { sandboxRequestId: id, progress: { file: 'x' } } }, { id: 'evil', url: 'evil' }, function(r) { r2 = r; });
        assert.strictEqual(r2.ok, false, 'untrusted sender rejected'); assert.strictEqual(hits.length, 1);
        var r3; s.env.relay({ type: 'sw-exec-tool', payload: { sandboxRequestId: id, name: 'run_js_file', args: { path: 'a', mode: 'source' } } }, trusted, function(r) { r3 = r; });
        await wdFlush();
        assert.strictEqual(r3.ok, true); assert.strictEqual(hits.length, 3, 'inner call stamps on admit and settle');
        s.release({ ok: true, result: 7 });
        assert.strictEqual(await p, 7);
        var r4; s.env.progress({ type: 'sw-sandbox-progress', payload: { sandboxRequestId: id, progress: { file: 'late' } } }, trusted, function(r) { r4 = r; });
        assert.strictEqual(r4.result.accepted, false, 'finished invocation ignores late progress'); assert.strictEqual(hits.length, 3);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('offscreen test ingress relays progress by request id', function() {
    test('sandboxTestProgress from the exact frame is relayed as sw-sandbox-progress', async function() {
        var off = await loadFile('src/platform/extension/offscreen-helper.js');
        var policy = await loadFile('src/js/core/075-test-run-policy.js');
        var P = new Function(policy + '\nreturn TestRunPolicy;')();
        var listeners = new Set(), frames = [], sent = [], receiver;
        var win = { addEventListener: function(_, f) { listeners.add(f); }, removeEventListener: function(_, f) { listeners.delete(f); } };
        var body = { appendChild: function(f) { f.parentNode = body; }, removeChild: function(f) { f.parentNode = null; } };
        var doc = { body: body, createElement: function() { var f = { style: {}, addEventListener: function() {}, removeEventListener: function() {}, contentWindow: { postMessage: function() {} } }; frames.push(f); return f; } };
        var chrome = { runtime: { id: 'x', getURL: function(p) { return p; }, connect: function() { return { onDisconnect: { addListener: function() {} }, onMessage: { addListener: function() {} } }; }, onMessage: { addListener: function(fn) { receiver = fn; } }, sendMessage: function(m) { sent.push(m); return Promise.resolve({ ok: true }); } } };
        new Function('chrome', 'window', 'document', 'TestRunPolicy', off)(chrome, win, doc, P);
        var reply; receiver({ type: 'helper-js-eval', payload: { sandboxRequestId: 'req-1', testRunPolicy: { workspace: 'o/r::main', deadline: Date.now() + 60000 }, code: '' } }, { id: 'x', url: 'background.js' }, function(r) { reply = r; });
        var f = frames[0];
        Array.from(listeners).forEach(function(fn) { fn({ source: f.contentWindow, data: { type: 'sandboxTestProgress', index: 2, file: 'test/b.test.js', phase: 'done', passed: 3, extra: 'x' } }); });
        var prog = sent.filter(function(m) { return m.type === 'sw-sandbox-progress'; });
        assert.strictEqual(prog.length, 1);
        assert.strictEqual(prog[0].payload.sandboxRequestId, 'req-1');
        assert.strictEqual(prog[0].payload.progress.file, 'test/b.test.js');
        assert.strictEqual('extra' in prog[0].payload.progress, false);
        Array.from(listeners).forEach(function(fn) { fn({ source: f.contentWindow, data: { type: 'sandboxDone', result: {} } }); });
        await wdFlush(); assert.strictEqual(reply && reply.ok, true);
    }, { tags: ['unit'], timeout: 5000 });
});
