// Tool HTTP hard timeout + 5s slow-request pending handle
// (tools/020-tool-execution.js _toolFetch / _slowFetchDispatch).
describe('slow-fetch: hard timeout + pending handle', function() {
    var NOTICE_MS = 60;
    async function fixture(fetchImpl, platform) {
        var notices = [];
        var fetchCalls = [];
        var g = {
            window: fakeWindow(), chrome: fakeChrome(), console: console,
            fetch: function(url, opts) { fetchCalls.push({ url: url, opts: opts }); return fetchImpl(url, opts); },
            requestProgrammaticToolApproval: async function() { return { allowed: true, permission: 'allow' }; },
            SubAgents: { notifyChat: function(chatId, text, src) { notices.push({ chatId: chatId, text: text, src: src }); return true; } },
            activeStreamingChatId: 'c1', currentChatId: 'c1'
        };
        if (platform) g.Platform = platform;
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
    function wait(ms) { return freshTimeout(ms); }
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

    test('hang outside the bounded fetch still settles the pending handle (session-expiry regression)', async function() {
        // fetch ignores the abort signal and never settles — stands in for an
        // unbounded token probe / tab injection awaited outside _toolFetch.
        var f = await fixture(function() { return new Promise(function() {}); });
        f.m._sfSetNoticeMs(NOTICE_MS, 20);
        var r = await f.m.executeTool('web_fetch', { url: 'https://example.com/stuck', timeout_ms: 80 }, 0, OPTS);
        assert.strictEqual(r.pending, true, JSON.stringify(r));
        var aw = await f.m.executeTool('await_handle', { handle: r.handle }, 0, OPTS);
        assert.strictEqual(aw.snapshot.status, 'done', JSON.stringify(aw));
        assert.strictEqual(aw.snapshot.result.success, false);
        assert.strictEqual(aw.snapshot.result.timed_out, true);
        assert.match(aw.snapshot.result.error, /Timed out after 80ms/);
    }, { tags: ['unit'], timeout: 3000 });

    test('token lookup resolving after the deadline never sends the write', async function() {
        var I = 'https://dev9.service-now.com';
        var f = await fixture(function(u, o) { return delayedRes(5, '{"result":{}}', o.signal); }, {
            instanceUrl: 'https://dev1.service-now.com', instances: [],
            resolveInstanceUrl: function() { return I; },
            getSessionToken: function() { return ''; },
            // Hung tab probe that finally resolves well after the deadline.
            getTokenForInstance: function() { return freshTimeout(150).then(function() { return 'late-token'; }); }
        });
        f.m._sfSetNoticeMs(10000, 20);
        var r = await f.m.executeTool('servicenow_api', { method: 'POST', table: 'incident', instance: 'dev9', scope: 'global', data: { short_description: 'x' }, timeout_ms: 40 }, 0, OPTS);
        assert.strictEqual(r.success, false, JSON.stringify(r));
        assert.strictEqual(r.timed_out, true, JSON.stringify(r));
        await wait(250); // token lookup has now resolved late
        assert.strictEqual(f.fetchCalls.length, 0, 'no request after timed_out: ' + JSON.stringify(f.fetchCalls.map(function(c) { return c.url; })));
    }, { tags: ['unit'], timeout: 3000 });

    test('connection failure (hung token probe) errors inline under 5s — no pending handle (real budgets)', async function() {
        var I = 'https://dev9.service-now.com', got = [];
        var f = await fixture(function(u, o) { return delayedRes(5, '{"result":{}}', o.signal); }, {
            instanceUrl: 'https://dev1.service-now.com', instances: [],
            resolveInstanceUrl: function() { return I; },
            getSessionToken: function() { return ''; },
            // Tab probe that never yields a token; honors the caller's budget
            // like the real _probeWithDeadline does.
            getTokenForInstance: function(u, o) { got.push(o && o.timeoutMs); return freshTimeout((o && o.timeoutMs) || 60000).then(function() { return ''; }); }
        });
        f.m._sfSetNoticeMs(5000, 5000, 4000, 1000); // production values
        var t0 = Date.now();
        var r = await f.m.executeTool('servicenow_api', { method: 'GET', table: 'incident', instance: 'dev9', timeout_ms: 60000 }, 0, OPTS);
        var ms = Date.now() - t0;
        assert.strictEqual(r.pending, undefined, 'must not become a pending handle: ' + JSON.stringify(r));
        assert.strictEqual(r.success, false, JSON.stringify(r));
        assert.ok(ms < 5000, 'errored in ' + ms + 'ms');
        assert.ok(got[0] > 0 && got[0] <= 4000, 'token lookup got the remaining budget: ' + got[0]);
        assert.strictEqual(f.fetchCalls.length, 0);
    }, { tags: ['unit'], timeout: 9000 });

    test('sandbox (js_eval) calls never return early', async function() {
        var f = await fixture(function(u, o) { return delayedRes(NOTICE_MS * 3, '{"a":4}', o.signal); });
        var r = await f.m.executeTool('web_fetch', { url: 'https://example.com/slow' }, 0, { chatId: 'c1', fromSandbox: true });
        assert.strictEqual(r.pending, undefined);
        assert.ok(r.success !== false, JSON.stringify(r));
        assert.strictEqual(typeof r.elapsed_ms, 'number');
        assert.strictEqual(f.notices.length, 0);
    }, { tags: ['unit'], timeout: 3000 });
});
