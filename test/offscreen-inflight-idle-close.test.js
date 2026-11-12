// Reload pre-check flake ("Checks need attention": Test runner / Sandbox
// lifecycle / Full test suite shards failing with "A listener indicated an
// asynchronous response by returning true, but the message channel closed
// before a response was received"). Root cause: maybeCloseOffscreenIfIdle
// judged idleness by runningChatIds only. The SW-served Reload run_tests is
// chat-less, so once any earlier chat run had marked the document idle (>60s
// ago) the 30s heartbeat closed the offscreen document UNDER the in-flight
// js_eval shards, killing the listener that had returned `true`.
// Fix: callOffscreenHelper counts in-flight calls (_swOffscreenInFlight); the
// idle-close and markOffscreenMaybeIdle never fire while > 0, and the last call
// out restarts the idle grace when no chat run is active.
// Runs the REAL background.js slices (cut by text markers) against fakes.
describe('offscreen idle-close never tears down under in-flight helper calls', function() {
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + (a < 0 ? start : end));
        return text.slice(a, b);
    }
    async function flush(n) { for (var i = 0; i < (n || 60); i++) await Promise.resolve(); }
    function deferred() { var d = {}; d.promise = new Promise(function(res, rej) { d.resolve = res; d.reject = rej; }); return d; }

    async function env() {
        var bg = await loadFile('src/platform/extension/background.js');
        var e = { now: 1000000, closes: 0, running: {}, helper: [], warns: [] };
        var chrome = {
            offscreen: {
                hasDocument: function() { return Promise.resolve(true); },
                createDocument: function() { return Promise.resolve(); },
                closeDocument: function() {
                    e.closes++;
                    // Chrome semantics: closing the document closes every open
                    // response channel whose listener returned true.
                    e.helper.splice(0).forEach(function(d) { d.reject(new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received')); });
                    return Promise.resolve();
                }
            },
            runtime: {
                sendMessage: function(m) {
                    if (m && m.type === 'helper-ping') return Promise.resolve({ ok: true, pong: true });
                    if (m && m.type === 'helper-js-eval') { var d = deferred(); e.helper.push(d); return d.promise; }
                    return Promise.resolve({ ok: true });
                },
                onConnect: { addListener: function() {} }
            }
        };
        var timers = [];
        var policy = { registry: { bind: function() {}, descriptor: function() { return {}; }, unbind: function() {}, relay: function() {} } };
        var slice = between(bg, 'var _swOffscreenCreating = null;', '// Expose to the imported SW bundle.')
            + '\n' + between(bg, 'async function maybeCloseOffscreenIfIdle() {', '// Heartbeat alarm.');
        var selfObj = { getP4Flag: function() { return false; } };
        e.api = new Function('chrome', 'self', 'setTimeout', 'clearTimeout', 'console', 'crypto', 'TestRunPolicy', 'persistenceBusyReason', 'Date', 'runningChatIds',
            slice + '\nreturn { call: callOffscreenHelper, idleClose: maybeCloseOffscreenIfIdle, markIdle: self.markOffscreenMaybeIdle,'
            + ' port: function(v) { if (arguments.length) _swOffscreenKeepAlivePort = v; return _swOffscreenKeepAlivePort; },'
            + ' inFlight: function() { return _swOffscreenInFlight; },'
            + ' idleSince: function(v) { if (arguments.length) _swOffscreenIdleSince = v; return _swOffscreenIdleSince; } };')(
            chrome, selfObj, function(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; }, function() {},
            { warn: function(m) { e.warns.push(String(m)); }, error: function() {}, log: function() {} },
            { randomUUID: function() { var n = 0; return function() { return 'u' + (++n); }; }() }, policy,
            function() { return null; }, { now: function() { return e.now; } }, e.running);
        e.api.port({ name: 'sw-keepalive' }); // document up + handlers registered
        return e;
    }

    test('chat-less shard in flight: heartbeat idle-close is refused even when idleSince is stale (> grace)', async function() {
        var e = await env();
        e.api.idleSince(e.now - 5 * 60 * 1000); // an earlier chat run finished long ago
        var p = e.api.call('helper-js-eval', { code: '1' }, 5000);
        var outcome = null; p.then(function(v) { outcome = { ok: true, v: v }; }, function(err) { outcome = { ok: false, err: err }; });
        await flush();
        assert.strictEqual(e.helper.length, 1, 'helper call dispatched');
        assert.strictEqual(e.api.inFlight(), 1);
        e.now += 10 * 60 * 1000; // several heartbeats later, still no chat running
        await e.api.idleClose();
        await flush();
        assert.strictEqual(e.closes, 0, 'document must not be closed under an in-flight call');
        assert.strictEqual(outcome, null, 'call still pending (channel not closed)');
        e.helper[0].resolve({ ok: true, result: { success: true } });
        await flush();
        assert.deepStrictEqual(outcome, { ok: true, v: { success: true } });
        assert.strictEqual(e.api.inFlight(), 0);
        assert.strictEqual(e.api.idleSince(), e.now, 'last call out restarts the idle grace (no chat running)');
    }, { tags: ['unit'], timeout: 3000 });

    test('after the last call settles, the grace elapses and the idle-close proceeds (document still reaped)', async function() {
        var e = await env();
        var p = e.api.call('helper-js-eval', { code: '1' }, 5000);
        await flush();
        e.helper[0].resolve({ ok: true, result: 1 });
        assert.strictEqual(await p, 1);
        await e.api.idleClose();
        assert.strictEqual(e.closes, 0, 'within the 60s grace: kept');
        e.now += 61000;
        await e.api.idleClose();
        assert.strictEqual(e.closes, 1, 'idle after grace: closed');
    }, { tags: ['unit'], timeout: 3000 });

    test('markOffscreenMaybeIdle (chat run ended) is ignored while a helper call is in flight; failures also release the count', async function() {
        var e = await env();
        e.api.idleSince(0);
        var p = e.api.call('helper-js-eval', { code: '1' }, 5000);
        p.catch(function() {});
        await flush();
        e.api.markIdle();
        assert.strictEqual(e.api.idleSince(), 0, 'not marked idle under an in-flight call');
        e.helper[0].reject(new Error('boom'));
        await assert.rejects(p, /boom/);
        assert.strictEqual(e.api.inFlight(), 0, 'rejected call released the in-flight count');
        assert.ok(e.api.idleSince() > 0, 'idle grace starts after the last call');
    }, { tags: ['unit'], timeout: 3000 });

    test('a chat run still active keeps idleSince untouched when the last call settles (the run marks idle itself)', async function() {
        var e = await env();
        e.running.chat_1 = true;
        e.api.idleSince(0);
        var p = e.api.call('helper-js-eval', { code: '1' }, 5000);
        await flush();
        e.helper[0].resolve({ ok: true, result: 2 });
        assert.strictEqual(await p, 2);
        assert.strictEqual(e.api.idleSince(), 0);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('run_tests shard merge: a dead transport is reported distinctly, never as a test verdict', function() {
    test('a shard whose js_eval rejected (message channel closed) is SANDBOX_TRANSPORT, its files not_run, 0 failed', async function() {
        var m = await loadModules(['src/js/core/075-test-run-policy.js', 'src/js/tools/160-run-tests.js']);
        var cfg = { files: ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'] };
        var ok = { success: true, result: { host_test_boundary: true, denied_calls: [], value: { files: [
            { file: 'test/a.test.js', status: 'pass', passed: 3, failed: 0, skipped: 0 }], denied_calls: [] } } };
        var chan = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';
        var out = m.rtMergeShardResults([
            { indices: [0], evalRes: ok, duration_ms: 1 },
            { indices: [1, 2], evalRes: { success: false, error: chan }, duration_ms: 1 }
        ], cfg, { ok: true }, []);
        assert.strictEqual(out.success, false);
        assert.strictEqual(out.shards[1].status, 'error');
        assert.strictEqual(out.shards[1].error_code, 'SANDBOX_TRANSPORT');
        assert.strictEqual(out.shards[0].error_code, undefined);
        assert.match(out.error, /^Sandbox transport failure \(no test verdict\) \(shard 2\/2\): A listener indicated/);
        assert.strictEqual(out.summary.failed, 0, 'transport loss is not counted as failed tests');
        assert.strictEqual(out.summary.not_run, 2);
        assert.deepStrictEqual(out.files.map(function(f) { return f.status; }), ['pass', 'not_run', 'not_run']);
    }, { tags: ['unit'], timeout: 3000 });

    test('a malformed envelope keeps the Invalid/incomplete label (not transport)', async function() {
        var m = await loadModules(['src/js/core/075-test-run-policy.js', 'src/js/tools/160-run-tests.js']);
        var cfg = { files: ['test/a.test.js'] };
        var bad = { success: true, result: { host_test_boundary: true, value: { files: [] } } };
        var out = m.rtMergeShardResults([{ indices: [0], evalRes: bad, duration_ms: 1 }], cfg, { ok: true }, []);
        assert.strictEqual(out.shards[0].error_code, undefined);
        assert.match(out.error, /Invalid\/incomplete sandbox result/);
    }, { tags: ['unit'], timeout: 3000 });
});
