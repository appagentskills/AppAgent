// Tool HTTP hard timeout + 5s slow-request pending handle
// (tools/020-tool-execution.js _toolFetch / _slowFetchDispatch).
describe('slow-fetch: hard timeout + pending handle', function() {
    var NOTICE_MS = 60;
    async function fixture(fetchImpl) {
        var notices = [];
        var fetchCalls = [];
        var g = {
            window: fakeWindow(), chrome: fakeChrome(), console: console,
            fetch: function(url, opts) { fetchCalls.push({ url: url, opts: opts }); return fetchImpl(url, opts); },
            requestProgrammaticToolApproval: async function() { return { allowed: true, permission: 'allow' }; },
            SubAgents: { notifyChat: function(chatId, text, src) { notices.push({ chatId: chatId, text: text, src: src }); return true; } },
            activeStreamingChatId: 'c1', currentChatId: 'c1'
        };
        var m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/tools/020-tool-execution.js'], { lenient: true, globals: g });
        m._sfSetNoticeMs(NOTICE_MS);
        return { m: m, notices: notices, fetchCalls: fetchCalls };
    }
    function delayedRes(ms, body, signal) {
        return new Promise(function(resolve, reject) {
            var t = setTimeout(function() {
                resolve({ ok: true, status: 200, headers: { get: function(k) { return /content-type/i.test(k) ? 'application/json' : null; }, forEach: function() {} },
                    text: async function() { return body; }, json: async function() { return JSON.parse(body); } });
            }, ms);
            if (signal) signal.addEventListener('abort', function() { clearTimeout(t); var e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e); });
        });
    }
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    var OPTS = { chatId: 'c1' };

    test('fast call returns the normal result (no pending, no notice)', async function() {
        var f = await fixture(function(u, o) { return delayedRes(5, '{"a":1}', o.signal); });
        var r = await f.m.executeTool('web_fetch', { url: 'https://example.com/x' }, 0, OPTS);
        assert.strictEqual(r.pending, undefined);
        assert.ok(r.success !== false, JSON.stringify(r));
        assert.ok(f.fetchCalls[0].opts.signal, 'fetch gets an abort signal');
        await wait(NOTICE_MS + 20);
        assert.strictEqual(f.notices.length, 0);
    }, { tags: ['unit'], timeout: 3000 });

    test('slow top-level call returns a pending handle, then settles and notifies', async function() {
        var f = await fixture(function(u, o) { return delayedRes(NOTICE_MS * 3, '{"a":2}', o.signal); });
        var r = await f.m.executeTool('web_fetch', { url: 'https://example.com/slow' }, 0, OPTS);
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.pending, true);
        assert.strictEqual(typeof r.handle, 'string');
        assert.ok(r.handle.length > 0);
        assert.match(r.message, /await_handle/);
        await wait(NOTICE_MS * 4);
        var snap = f.m.Handles.poll('c1', r.handle);
        assert.strictEqual(snap.status, 'done', JSON.stringify(snap));
        assert.strictEqual(f.notices.length, 1);
        assert.strictEqual(f.notices[0].chatId, 'c1');
        assert.match(f.notices[0].text, /Background request completed/);
        assert.ok(f.notices[0].text.indexOf(r.handle) !== -1);
    }, { tags: ['unit'], timeout: 3000 });

    test('no notice when the agent is blocked awaiting the handle', async function() {
        var f = await fixture(function(u, o) { return delayedRes(NOTICE_MS * 3, '{"a":3}', o.signal); });
        var r = await f.m.executeTool('web_fetch', { url: 'https://example.com/slow' }, 0, OPTS);
        assert.strictEqual(r.pending, true);
        var aw = await f.m.executeTool('await_handle', { handle: r.handle }, 0, OPTS);
        assert.strictEqual(aw.snapshot.status, 'done', JSON.stringify(aw));
        assert.strictEqual(aw.snapshot.result.body, '{"a":3}');
        assert.strictEqual(typeof aw.snapshot.result.elapsed_ms, 'number');
        await wait(20);
        assert.strictEqual(f.notices.length, 0);
    }, { tags: ['unit'], timeout: 3000 });

    test('await_handle cancel:true aborts the in-flight fetch', async function() {
        var aborted = false;
        var f = await fixture(function(u, o) { o.signal.addEventListener('abort', function() { aborted = true; }); return delayedRes(5000, '{}', o.signal); });
        var r = await f.m.executeTool('web_fetch', { url: 'https://example.com/hang' }, 0, OPTS);
        assert.strictEqual(r.pending, true);
        var c = await f.m.executeTool('await_handle', { handle: r.handle, cancel: true }, 0, OPTS);
        assert.strictEqual(c.success, true, JSON.stringify(c));
        assert.strictEqual(c.cancelled, true);
        assert.strictEqual(aborted, true);
        await wait(20);
        assert.strictEqual(f.notices.length, 0);
    }, { tags: ['unit'], timeout: 3000 });

    test('hard timeout returns timed_out (timeout_ms honored)', async function() {
        var f = await fixture(function(u, o) { return delayedRes(5000, '{}', o.signal); });
        f.m._sfSetNoticeMs(10000);
        var r = await f.m.executeTool('web_fetch', { url: 'https://example.com/hang', timeout_ms: 40 }, 0, OPTS);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.timed_out, true);
        assert.strictEqual(r.error, 'Timed out after 40ms');
        assert.strictEqual(typeof r.elapsed_ms, 'number');
    }, { tags: ['unit'], timeout: 3000 });

    test('sandbox (js_eval) calls never return early', async function() {
        var f = await fixture(function(u, o) { return delayedRes(NOTICE_MS * 3, '{"a":4}', o.signal); });
        var r = await f.m.executeTool('web_fetch', { url: 'https://example.com/slow' }, 0, { chatId: 'c1', fromSandbox: true });
        assert.strictEqual(r.pending, undefined);
        assert.ok(r.success !== false, JSON.stringify(r));
        assert.strictEqual(typeof r.elapsed_ms, 'number');
        assert.strictEqual(f.notices.length, 0);
    }, { tags: ['unit'], timeout: 3000 });
});
