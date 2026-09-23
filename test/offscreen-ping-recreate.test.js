// H18 — a js_eval that loops synchronously freezes the offscreen document while
// its keep-alive port stays open. waitForOffscreenReady trusted the port, so
// every later js_eval hung until the 5-min watchdog. Fix (background.js):
// callOffscreenHelper pings ('helper-ping', answered by offscreen-helper.js)
// before dispatch; ~30s (OFFSCREEN_UNRESPONSIVE_MS) of continuous missed pings
// => close + recreate the document, reset the port, dispatch to the fresh one.
// A shorter CPU burst is absorbed; a port swap during the misses or a busy
// persistence layer skips the recreate. The js_eval watchdog (020) triggers the
// same health check after an inactivity timeout (fire-and-forget, no re-run).
//
// Runs the REAL production slices of background.js (offscreen lifecycle +
// callOffscreenHelper + the sw-keepalive onConnect handler), the REAL
// offscreen-helper.js message handler, and the REAL 020 watchdog slice against
// fake chrome.offscreen / chrome.runtime messaging and a manual clock.
describe('H18 offscreen ping + recreate (background.js / offscreen-helper.js / 020 watchdog)', function() {
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + start);
        return text.slice(a, b);
    }
    async function flush(n) { for (var i = 0; i < (n || 40); i++) await Promise.resolve(); }
    function deferred() {
        var d = {}; d.promise = new Promise(function(res, rej) { d.resolve = res; d.reject = rej; }); return d;
    }
    function settledState(p) {
        var s = { done: false };
        p.then(function(v) { s.done = true; s.ok = true; s.value = v; }, function(e) { s.done = true; s.ok = false; s.error = e; });
        return s;
    }

    var _src = null;
    async function sources() {
        if (_src) return _src;
        _src = {
            bg: await loadFile('src/platform/extension/background.js'),
            helper: await loadFile('src/platform/extension/offscreen-helper.js'),
            exec: await loadFile('src/js/tools/020-tool-execution.js')
        };
        return _src;
    }

    // One fake SW realm + fake offscreen documents.
    async function env() {
        var src = await sources();
        var e = { docs: [], current: null, creates: 0, closes: 0, routes: [], timers: [], warns: [], now: 1000000, busy: null };
        var fakeDate = { now: function() { return e.now; } };
        var connectListener = null;
        function makeDoc() {
            var doc = { id: e.docs.length + 1, frozen: false, closed: false, holdEvals: false, evals: [], receiver: null, swPortDisconnect: [] };
            e.docs.push(doc);
            var helperChrome = { runtime: {
                id: 'ext', getURL: function(p) { return 'chrome-extension://ext/' + p; },
                connect: function() {
                    // Real keep-alive: the SW side gets its own port object.
                    var swPort = { name: 'sw-keepalive', onDisconnect: { addListener: function(fn) { doc.swPortDisconnect.push(fn); } }, onMessage: { addListener: function() {} } };
                    Promise.resolve().then(function() { if (!doc.closed && connectListener) connectListener(swPort); });
                    return { onDisconnect: { addListener: function() {} }, onMessage: { addListener: function() {} } };
                },
                onMessage: { addListener: function(fn) { doc.receiver = fn; } },
                sendMessage: function() { return new Promise(function() {}); }
            } };
            var stubWin = { addEventListener: function() {}, removeEventListener: function() {} };
            new Function('chrome', 'window', 'document', 'TestRunPolicy', 'setTimeout', 'clearTimeout', 'Date', src.helper)(
                helperChrome, stubWin, { body: {}, createElement: function() { throw new Error('no iframes in this test'); } }, {},
                function() { return 0; }, function() {}, Date);
            return doc;
        }
        e.makeDoc = makeDoc;
        var chrome = {
            offscreen: {
                hasDocument: function() { return Promise.resolve(!!(e.current && !e.current.closed)); },
                createDocument: function() { e.creates++; e.current = makeDoc(); return Promise.resolve(); },
                closeDocument: function() {
                    e.closes++;
                    var d = e.current;
                    if (!d || d.closed) return Promise.reject(new Error('No current offscreen document'));
                    d.closed = true;
                    d.evals.forEach(function(ev) { ev.d.reject(new Error('The message port closed before a response was received.')); });
                    d.swPortDisconnect.forEach(function(fn) { fn(); });
                    return Promise.resolve();
                }
            },
            runtime: {
                onConnect: { addListener: function(fn) { connectListener = fn; } },
                sendMessage: function(msg) {
                    var d = e.current;
                    e.routes.push({ type: msg.type, doc: d ? d.id : null });
                    if (!d || d.closed) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
                    if (d.frozen) return new Promise(function() {}); // sync loop: never answers
                    if (msg.type === 'helper-js-eval') {
                        var ev = { msg: msg, d: deferred() };
                        d.evals.push(ev);
                        if (!d.holdEvals) ev.d.resolve({ ok: true, result: 'ran@doc' + d.id });
                        return ev.d.promise;
                    }
                    if (msg.type === 'helper-cancel-sandbox') return Promise.resolve({ ok: true });
                    return new Promise(function(resolve) { d.receiver(msg, { id: 'ext' }, resolve); });
                }
            }
        };
        var selfObj = { getP4Flag: function() { return false; } };
        var policy = { registry: { bind: function() {}, descriptor: function() { return {}; }, unbind: function() {}, relay: function() {} } };
        var fakeSetTimeout = function(fn, ms) { var t = { id: e.timers.length + 1, fn: fn, ms: ms, cleared: false, fired: false }; e.timers.push(t); return t.id; };
        var fakeClearTimeout = function(id) { var t = e.timers[id - 1]; if (t) t.cleared = true; };
        var slice = between(src.bg, 'var _swOffscreenCreating = null;', '// Expose to the imported SW bundle.')
            + '\n' + between(src.bg, "chrome.runtime.onConnect.addListener(function(port) {\n    if (port.name !== 'sw-keepalive')", '// Heartbeat alarm.');
        var api = new Function('chrome', 'self', 'setTimeout', 'clearTimeout', 'console', 'crypto', 'TestRunPolicy', 'persistenceBusyReason', 'Date',
            slice + '\nreturn { call: callOffscreenHelper, port: function() { return _swOffscreenKeepAlivePort; } };')(
            chrome, selfObj, fakeSetTimeout, fakeClearTimeout,
            { warn: function() { e.warns.push(Array.prototype.slice.call(arguments).join(' ')); }, error: function() {}, log: function() {} },
            { randomUUID: function() { return 'u' + Math.random().toString(36).slice(2); } }, policy,
            function() { return e.busy; }, fakeDate);
        e.api = api; e.self = selfObj; e.chrome = chrome;
        e.call = function() { return e.api.call('helper-js-eval', { code: 'return 1', chatId: 'c1' }, 5000); };
        // Advance the manual clock by ms, then fire every pending (not
        // cleared / not yet fired) timer with this delay.
        e.fire = async function(ms) {
            e.now += ms;
            e.timers.filter(function(t) { return t.ms === ms && !t.cleared && !t.fired; }).forEach(function(t) { t.fired = true; t.fn(); });
            await flush();
        };
        // Let `total` ms of consecutive ping timeouts elapse (2.5s each).
        e.missFor = async function(total) {
            for (var t = 0; t < total; t += 2500) await e.fire(2500);
            await flush(80);
        };
        e.count = function(type, docId) { return e.routes.filter(function(r) { return r.type === type && (docId === undefined || r.doc === docId); }).length; };
        return e;
    }

    test('offscreen-helper.js answers helper-ping on its event loop', async function() {
        var e = await env();
        var doc = e.makeDoc();
        var resp = await new Promise(function(resolve) { doc.receiver({ type: 'helper-ping', payload: {} }, { id: 'ext' }, resolve); });
        assert.strictEqual(resp && resp.ok, true, 'ping answered with ok:true');
        assert.strictEqual(resp.result && resp.result.pong, true);
    }, { tags: ['unit'] });

    test('healthy document: ping round-trip precedes dispatch, no recreate', async function() {
        var e = await env();
        var r = await e.call();
        assert.strictEqual(r, 'ran@doc1');
        assert.deepStrictEqual(e.routes.map(function(x) { return x.type; }), ['helper-ping', 'helper-js-eval'], 'ping first, then dispatch');
        assert.strictEqual(e.creates, 1);
        assert.strictEqual(e.closes, 0);
    }, { tags: ['unit'] });

    test('frozen document (sync loop, port still open): 30s of missed pings -> close + recreate -> dispatch to the fresh doc', async function() {
        var e = await env();
        assert.strictEqual(await e.call(), 'ran@doc1');
        e.docs[0].frozen = true; // a js_eval is now spinning synchronously in doc1
        assert.ok(e.api.port(), 'keep-alive port is still open on the frozen doc');
        var s = settledState(e.call());
        await flush();
        assert.strictEqual(s.done, false, 'waiting on the first ping');
        assert.strictEqual(e.count('helper-js-eval', 1), 1, 'nothing new was dispatched to the frozen doc');
        await e.fire(2500); // 1st ping timeout -> retry
        assert.strictEqual(e.closes, 0, 'one missed ping is not enough to recreate');
        for (var i = 2; i <= 11; i++) await e.fire(2500); // 27.5s of misses
        await flush(80);
        assert.strictEqual(e.closes, 0, '27.5s of misses is still below OFFSCREEN_UNRESPONSIVE_MS');
        assert.strictEqual(s.done, false, 'dispatch waits while the doc is frozen');
        await e.fire(2500); // 30s reached -> recreate
        await flush(80);
        assert.strictEqual(e.closes, 1, 'wedged doc closed exactly once');
        assert.strictEqual(e.creates, 2, 'fresh doc created');
        assert.strictEqual(s.done, true, 'call settled without waiting for the 5-min watchdog');
        assert.strictEqual(s.ok, true, s.error && s.error.message);
        assert.strictEqual(s.value, 'ran@doc2', 'dispatched to the fresh document');
        assert.strictEqual(e.count('helper-js-eval', 1), 1, 'user code never re-dispatched to the frozen doc');
        assert.ok(e.warns.some(function(w) { return /unresponsive/.test(w); }), 'recreate is logged');
        // Next call: fresh doc answers the ping, no further recreate.
        assert.strictEqual(await e.call(), 'ran@doc2');
        assert.strictEqual(e.closes, 1);
        assert.strictEqual(e.creates, 2);
    }, { tags: ['unit'] });

    test('10s CPU burst (finite freeze) is absorbed: no recreate, dispatch lands on the same doc', async function() {
        var e = await env();
        assert.strictEqual(await e.call(), 'ran@doc1');
        e.docs[0].frozen = true;
        var s = settledState(e.call());
        await flush();
        await e.missFor(10000); // 4 missed pings
        assert.strictEqual(e.closes, 0, 'a 10s burst never recreates');
        assert.strictEqual(s.done, false, 'dispatch still waiting');
        e.docs[0].frozen = false; // burst over
        await e.fire(2500); // the in-flight ping (sent while frozen) times out; the retry is answered
        await flush(80);
        assert.strictEqual(s.done, true);
        assert.strictEqual(s.ok, true, s.error && s.error.message);
        assert.strictEqual(s.value, 'ran@doc1', 'dispatched to the original doc');
        assert.strictEqual(e.closes, 0);
        assert.strictEqual(e.creates, 1);
        assert.ok(!e.warns.some(function(w) { return /unresponsive/.test(w); }), 'no recreate logged');
    }, { tags: ['unit'] });

    test('port changes during the misses (fresh doc already replaced it): no recreate, dispatch to the fresh doc', async function() {
        var e = await env();
        await e.call();
        var oldPort = e.api.port();
        e.docs[0].frozen = true;
        var s = settledState(e.call());
        await flush();
        await e.missFor(5000);
        // Another path (zombie heal / idle-close) replaced the document.
        e.creates++; e.current = e.makeDoc();
        await flush();
        assert.ok(e.api.port() && e.api.port() !== oldPort, 'fresh doc connected a new keep-alive port');
        await e.fire(2500); // the ping in flight to the frozen doc misses -> port check
        await flush(80);
        assert.strictEqual(e.closes, 0, 'fresh doc never closed');
        assert.strictEqual(e.creates, 2, 'no extra create');
        assert.strictEqual(s.ok, true, s.error && s.error.message);
        assert.strictEqual(s.value, 'ran@doc2');
        await e.missFor(30000); // no timers left that could still recreate
        assert.strictEqual(e.closes, 0);
    }, { tags: ['unit'] });

    test('persistence busy: 30s of misses does NOT recreate (mirrors zombie heal), dispatch fails offscreen_unresponsive', async function() {
        var e = await env();
        await e.call();
        e.busy = 'saving chat';
        e.docs[0].frozen = true;
        var s = settledState(e.call());
        await flush();
        await e.missFor(30000);
        assert.strictEqual(e.closes, 0, 'no teardown while persistence is busy');
        assert.strictEqual(e.creates, 1);
        assert.strictEqual(s.done, true);
        assert.strictEqual(s.ok, false);
        assert.match(s.error.message, /offscreen_unresponsive/);
    }, { tags: ['unit'] });

    test('busy but healthy document (long async eval in flight) still answers the ping: no recreate', async function() {
        var e = await env();
        await e.call();
        e.docs[0].holdEvals = true;
        var longEval = settledState(e.call()); // long async eval, pending
        await flush();
        var pingsBefore = e.count('helper-ping');
        var second = settledState(e.call());
        await flush();
        assert.strictEqual(e.count('helper-ping'), pingsBefore + 1, 'second dispatch pinged');
        assert.strictEqual(e.closes, 0, 'healthy busy doc is never closed');
        assert.strictEqual(e.docs[0].evals.length, 3, 'both evals dispatched to the same doc');
        e.docs[0].evals.forEach(function(ev) { ev.d.resolve({ ok: true, result: 'late' }); });
        await flush();
        assert.strictEqual(longEval.value, 'late');
        assert.strictEqual(second.value, 'late');
    }, { tags: ['unit'] });

    test('concurrent dispatches to a frozen doc: single ping round, single close + recreate, both land on the fresh doc', async function() {
        var e = await env();
        await e.call();
        e.docs[0].frozen = true;
        var pingsBefore = e.count('helper-ping');
        var a = settledState(e.call()), b = settledState(e.call());
        await flush();
        assert.strictEqual(e.count('helper-ping') - pingsBefore, 1, 'one shared ping, not one per caller');
        await e.missFor(30000);
        assert.strictEqual(e.closes, 1, 'closed once');
        assert.strictEqual(e.creates, 2, 'recreated once');
        assert.strictEqual(a.value, 'ran@doc2');
        assert.strictEqual(b.value, 'ran@doc2');
    }, { tags: ['unit'] });

    test('self.checkOffscreenResponsive (js_eval timeout hook): heals a frozen doc, never creates one when none is connected', async function() {
        var e = await env();
        assert.strictEqual(typeof e.self.checkOffscreenResponsive, 'function', 'hook exported on self');
        assert.strictEqual(await e.self.checkOffscreenResponsive('js_eval timeout'), false, 'no connected doc -> nothing to check');
        assert.strictEqual(e.creates, 0, 'did not spawn a document');
        await e.call();
        assert.strictEqual(await e.self.checkOffscreenResponsive('js_eval timeout'), true, 'healthy doc');
        assert.strictEqual(e.closes, 0);
        e.docs[0].frozen = true;
        var s = settledState(e.self.checkOffscreenResponsive('js_eval timeout'));
        await flush();
        await e.missFor(30000);
        assert.strictEqual(s.value, true, 'fresh doc ready');
        assert.strictEqual(e.closes, 1);
        assert.strictEqual(e.creates, 2);
        assert.strictEqual(e.count('helper-js-eval'), 1, 'health check never dispatches user code');
    }, { tags: ['unit'] });

    test('020 watchdog: inactivity timeout returns the error and fires the offscreen health check once (no retry)', async function() {
        var src = await sources();
        var watchdogSource = between(src.exec, '                var _swEvalTimer = null;', '                var jsEvalResultSw =');
        var AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
        var watchdog = new AsyncFunction('Platform', 'chatId', 'sanitizedCodeSw', 'messageIndex', 'options',
            'lastLargeResponseByChatId', '_sandboxEvalCount', '_sandboxPending', '_sandboxActivity',
            '_SANDBOX_HOLD_MAX_MS', '_sandboxEvalCleanup', 'AbortController', 'setInterval', 'clearInterval', 'Date', '_testKey', 'args', 'TestRunPolicy', 'self',
            watchdogSource + '\nreturn swEvalResult;');
        var now = 1000000, timers = new Map(), tid = 0, helperCalls = 0, checks = [];
        var platform = { callOffscreenHelper: function() { helperCalls++; return new Promise(function() {}); } };
        var selfObj = { checkOffscreenResponsive: function(reason) { checks.push(reason); return Promise.resolve(true); } };
        var s = settledState(watchdog(platform, 'c1', 'while(true){}', 0, { toolCallId: 't1' }, {}, {}, {}, {}, 60 * 60 * 1000,
            function() {}, AbortController,
            function(fn) { var id = ++tid; timers.set(id, fn); return id; }, function(id) { timers.delete(id); },
            { now: function() { return now; } }, null, {}, {}, selfObj));
        await flush();
        now += 5 * 60 * 1000 + 15000;
        Array.from(timers.values()).forEach(function(fn) { fn(); });
        await flush();
        assert.strictEqual(s.done, true);
        assert.strictEqual(s.ok, false);
        assert.match(s.error.message, /5 minutes of inactivity/);
        assert.deepStrictEqual(checks, ['js_eval timeout'], 'health check fired exactly once');
        assert.strictEqual(helperCalls, 1, 'user code not retried');
        assert.strictEqual(timers.size, 0, 'watchdog interval cleared');
    }, { tags: ['unit'] });
});
