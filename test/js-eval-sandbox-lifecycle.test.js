/* Run: run_tests { pattern: 'js-eval-sandbox-lifecycle' } (js_eval sandbox; no Node).
 * Executes the production watchdog, worker bridge, background transport and
 * complete offscreen helper against isolated DOM/message/clock mocks. Does not
 * start Chrome, real tools, sandbox user code, or a live extension js_eval.
 */
async function runJsEvalSandboxLifecycleTests(sources) {
    var passed = [];
    function check(name, value) { if (!value) throw new Error(name); passed.push(name); }
    function deferred() {
        var resolve, reject;
        var promise = new Promise(function(res, rej) { resolve = res; reject = rej; });
        return { promise: promise, resolve: resolve, reject: reject };
    }
    function outcome(promise) {
        return promise.then(function(value) { return { ok: true, value: value }; }, function(error) { return { ok: false, error: error }; });
    }
    async function flush() { for (var i = 0; i < 12; i++) await Promise.resolve(); }
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + start);
        return text.slice(a, b);
    }
    var backgroundSource = between(sources['src/platform/extension/background.js'],
        'function swTestPolicyStartupError()', '// Expose to the imported SW bundle.');
    var workerSource = between(sources['src/js/worker/010-platform-stub.js'],
        'Platform.callOffscreenHelper = function(', '\n\n// =============================================================');
    var watchdogSource = between(sources['src/js/tools/020-tool-execution.js'],
        '                var _swEvalTimer = null;', '                var jsEvalResultSw =');
    var AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    var watchdog = new AsyncFunction('Platform', 'chatId', 'sanitizedCodeSw', 'messageIndex', 'options',
        'lastLargeResponseByChatId', '_sandboxEvalCount', '_sandboxPending', '_sandboxActivity',
        '_SANDBOX_HOLD_MAX_MS', '_sandboxEvalCleanup', 'AbortController', 'setInterval', 'clearInterval', 'Date', '_testKey', 'args', 'TestRunPolicy',
        watchdogSource + '\nreturn swEvalResult;');

    function harness(options) {
        options = options || {};
        var h = { frames: [], live: new Set(), listeners: new Set(), timers: new Map(), tools: [], sleeps: [],
            routes: [], warnings: [], cleanups: [], pending: {}, activity: {}, counts: {}, removed: 0,
            now: 1000000, readyCalls: 0, ready: options.ready || Promise.resolve(true), timeouts: [], cleared: [] };
        // P4 #1: every sandbox run arms a 15s 'sandboxReady' timer; the pre-P4
        // assertions about the sleep-backoff timers filter it out via this helper.
        h.backoffs = function() { return h.timeouts.filter(function(t) { return t.ms !== 60000; }); };
        h.readyTimers = function() { return h.timeouts.filter(function(t) { return t.ms === 60000; }); };
        var timerId = 0, tokenId = 0, receiver;
        var fakeDate = { now: function() { return h.now; } };
        var policy = new Function('Date', sources['src/js/core/075-test-run-policy.js'] + '\nreturn TestRunPolicy;')(fakeDate);
        var page = {
            addEventListener: function(type, fn) { if (type === 'message') h.listeners.add(fn); },
            removeEventListener: function(type, fn) { if (type === 'message') h.listeners.delete(fn); }
        };
        var body = {
            appendChild: function(frame) {
                if (options.appendFails) throw new Error('append failed');
                frame.parentNode = body; h.live.add(frame);
            },
            removeChild: function(frame) { h.live.delete(frame); frame.parentNode = null; h.removed++; }
        };
        var doc = {
            body: body,
            createElement: function(tag) {
                if (tag !== 'iframe') throw new Error('unexpected element');
                var events = new Map();
                var frame = { style: {}, parentNode: null, sent: [],
                    addEventListener: function(type, fn) { events.set(type, fn); },
                    removeEventListener: function(type) { events.delete(type); },
                    error: function() { if (events.has('error')) events.get('error')(); }
                };
                frame.contentWindow = { postMessage: function(message) {
                    if (options.postFails) throw new Error('post failed');
                    frame.sent.push(message);
                } };
                h.frames.push(frame);
                return frame;
            }
        };
        var helperChrome = { runtime: {
            id: 'test-extension', getURL: function(p) { return 'chrome-extension://test-extension/' + p; },
            connect: function() { return { onDisconnect: { addListener: function() {} }, onMessage: { addListener: function() {} } }; },
            onMessage: { addListener: function(fn) { receiver = fn; } },
            sendMessage: function(message) {
                var d = deferred(); d.message = message;
                if (message.type === 'sw-exec-tool') h.tools.push(d);
                else if (message.type === 'sw-sleep') h.sleeps.push(d);
                else throw new Error('unexpected helper message: ' + message.type);
                return d.promise;
            }
        } };
        new Function('chrome', 'window', 'document', 'TestRunPolicy', 'setTimeout', 'clearTimeout', 'Date',
            sources['src/platform/extension/offscreen-helper.js'])(helperChrome, page, doc, policy,
            function(fn, ms) { h.timeouts.push({ fn: fn, ms: ms }); return h.timeouts.length; },
            function(id) { if (id) h.cleared.push(id); }, fakeDate);
        h.deliver = function(message) {
            return new Promise(function(resolve) { receiver(message, { id: 'test-extension' }, resolve); });
        };
        var swChrome = { runtime: { sendMessage: function(message) {
            h.routes.push(message);
            if (message.type === 'helper-cancel-sandbox' && options.cancelFails) return Promise.reject(new Error('no helper'));
            if (message.type === 'helper-cancel-sandbox' && options.cancelThrows) throw new Error('no helper sync');
            if (options.transportFails) return Promise.reject(new Error('channel failed'));
            if (options.response) return Promise.resolve(options.response);
            return h.deliver(message);
        } } };
        h.call = new Function('waitForOffscreenReady', 'chrome', 'crypto', 'console', 'TestRunPolicy', backgroundSource + '\nreturn callOffscreenHelper;')(
            function() { h.readyCalls++; return h.ready; }, swChrome,
            { randomUUID: function() { return 'request-' + (++tokenId); } },
            { warn: function() { h.warnings.push(Array.prototype.slice.call(arguments)); } }, policy);
        h.platform = new Function('Platform', 'self', workerSource + '\nreturn Platform;')({}, { callOffscreenHelper: h.call });
        h.emit = function(frame, data) {
            Array.from(h.listeners).forEach(function(fn) { fn({ source: frame.contentWindow, data: data }); });
        };
        h.start = function(chatId) {
            return outcome(watchdog(h.platform, chatId || 'same-chat', 'return 1;', 0,
                { toolCallId: 'same-outer-tool' }, {}, h.counts, h.pending, h.activity, 60 * 60 * 1000,
                function(cid) { h.cleanups.push(cid); }, AbortController,
                function(fn) { var id = ++timerId; h.timers.set(id, fn); return id; },
                function(id) { h.timers.delete(id); }, fakeDate, null, {}, policy));
        };
        h.tick = function(ms) { h.now += ms; Array.from(h.timers.values()).forEach(function(fn) { fn(); }); };
        h.direct = function(controller, payload) {
            return outcome(h.call('helper-js-eval', payload || { code: 'return 1;', chatId: 'same-chat' }, 5000, controller && controller.signal));
        };
        h.cancelCount = function() { return h.routes.filter(function(m) { return m.type === 'helper-cancel-sandbox'; }).length; };
        return h;
    }

    var h = harness(), p = h.start(); await flush();
    check('helper creates exactly one iframe/listener', h.live.size === 1 && h.listeners.size === 1);
    var f = h.frames[0];
    h.emit(f, { type: 'sandboxReady' }); h.emit(f, { type: 'sandboxReady' });
    check('duplicate readiness cannot re-execute sandbox code', f.sent.length === 1);
    h.emit(f, { type: 'sandboxDone', result: 7 });
    check('happy watchdog path returns helper result', (await p).value === 7);
    check('happy completion removes frame/listener/timer once', h.live.size === 0 && h.listeners.size === 0 && h.timers.size === 0 && h.removed === 1);
    check('success detaches abort listener instead of sending cancellation', h.cancelCount() === 0 && h.cleanups.length === 1);
    var token = h.routes[0].payload.sandboxRequestId;
    var ack = await h.deliver({ type: 'helper-cancel-sandbox', payload: { sandboxRequestId: token } });
    check('completed invocation is removed from cancel registry', ack.result.cancelled === false);

    h = harness(); p = h.start(); await flush(); f = h.frames[0];
    h.tick(5 * 60 * 1000 + 15000); await flush(); var timedOut = await p;
    check('watchdog preserves original five-minute error', !timedOut.ok && /5 minutes of inactivity/.test(timedOut.error.message));
    check('timeout disposes never-ready iframe/listener and clears watchdog', h.live.size === 0 && h.listeners.size === 0 && h.timers.size === 0 && h.removed === 1);
    check('timeout sends one invocation-scoped cancel', h.cancelCount() === 1 && h.routes[1].payload.sandboxRequestId === h.routes[0].payload.sandboxRequestId);
    h.emit(f, { type: 'sandboxReady' }); h.emit(f, { type: 'sandboxDone', result: 99 });
    await h.deliver(h.routes[1]);
    check('late ready/done and duplicate cancel are harmless', f.sent.length === 0 && h.removed === 1);

    h = harness(); var a = new AbortController(), b = new AbortController();
    var pa = h.direct(a), pb = h.direct(b); await flush();
    check('same-chat concurrent requests get unique tokens', h.routes[0].payload.sandboxRequestId !== h.routes[1].payload.sandboxRequestId);
    a.abort(); await pa; await flush();
    check('cancelling A leaves same-chat B alive', h.live.size === 1 && h.live.has(h.frames[1]) && h.listeners.size === 1);
    h.emit(h.frames[1], { type: 'sandboxDone', result: 'B' });
    check('sibling can complete normally', (await pb).value === 'B');
    b.abort(); check('late abort of completed sibling is a no-op', h.cancelCount() === 1);

    h = harness(); a = new AbortController(); a.abort();
    var pre = await h.direct(a);
    check('pre-abort rejects without readiness or offscreen creation', !pre.ok && pre.error.name === 'AbortError' && h.readyCalls === 0 && h.routes.length === 0);
    var readiness = deferred(); h = harness({ ready: readiness.promise }); p = h.start();
    h.tick(5 * 60 * 1000 + 15000); await flush();
    check('watchdog can expire while readiness is pending', !(await p).ok && h.routes.length === 0);
    readiness.resolve(true); await flush();
    check('late readiness never dispatches cancelled code or a cancellation-created realm', h.routes.length === 0 && h.frames.length === 0 && h.readyCalls === 1);
    readiness = deferred(); h = harness({ ready: readiness.promise }); a = new AbortController(); p = h.direct(a);
    a.abort(); readiness.reject(new Error('late readiness rejection')); await flush();
    check('late readiness rejection is handled after cancellation', !(await p).ok && h.routes.length === 0);

    h = harness(); p = h.start(); await flush();
    h.pending['same-chat'] = 1; h.activity['same-chat'] = h.now;
    h.tick(5 * 60 * 1000 + 15000); await flush();
    check('legitimate pending inner tool keeps watchdog alive beyond five minutes', h.live.size === 1 && h.cancelCount() === 0 && h.cleanups.length === 0);
    h.pending['same-chat'] = 0; h.activity['same-chat'] = h.now;
    h.tick(15000); await flush();
    check('fresh activity resets inactivity after pending tool settles', h.live.size === 1);
    h.tick(5 * 60 * 1000); await flush(); await p;
    check('inactivity timeout resumes after pending tool completes', h.live.size === 0 && h.cancelCount() === 1);
    h = harness(); p = h.start(); await flush(); h.pending['same-chat'] = 1; h.activity['same-chat'] = h.now;
    h.tick(60 * 60 * 1000 + 15000); await flush();
    check('orphan pending-tool hold still expires at existing maximum', !(await p).ok && h.live.size === 0);

    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); f = h.frames[0];
    h.emit(f, { type: 'sandboxToolCall', name: 'workspace', args: { action: 'list' }, id: 1 });
    check('live sandbox tool routing remains intact', h.tools.length === 1 && h.tools[0].message.payload.toolCallId === 'prog_np_1');
    a.abort(); await p; h.tools[0].resolve({ ok: true, result: 'late result' }); await flush();
    check('late inner-tool success cannot post to cancelled frame', f.sent.length === 0 && h.live.size === 0);
    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); f = h.frames[0];
    h.emit(f, { type: 'sandboxToolCall', name: 'workspace', args: {}, id: 1 });
    a.abort(); await p; h.tools[0].reject(new Error('late tool rejection')); await flush();
    check('late inner-tool rejection cannot post to cancelled frame', f.sent.length === 0);

    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); f = h.frames[0];
    h.emit(f, { type: 'sandboxToolCall', name: '__sandbox_sleep', args: { ms: 10 * 60 * 1000 }, id: 1 });
    check('long sandbox sleep still uses capped SW-backed chunks', h.sleeps.length === 1 && h.sleeps[0].message.payload.ms === 4 * 60 * 1000);
    a.abort(); await p; h.sleeps[0].resolve({ ok: true }); await flush();
    check('cancelled sleep cannot rearm or post a late reply', h.sleeps.length === 1 && f.sent.length === 0);
    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); f = h.frames[0];
    h.emit(f, { type: 'sandboxToolCall', name: '__sandbox_sleep', args: { ms: 10000 }, id: 1 });
    a.abort(); await p; h.sleeps[0].reject(new Error('sleep channel dropped')); await flush();
    check('cancelled sleep rejection cannot start a retry timer', h.sleeps.length === 1 && f.sent.length === 0 && h.backoffs().length === 0);
    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); f = h.frames[0];
    h.emit(f, { type: 'sandboxToolCall', name: '__sandbox_sleep', args: { ms: 10000 }, id: 1 });
    h.sleeps[0].reject(new Error('sleep channel dropped before cancellation')); await flush();
    check('live sleep channel failure schedules existing bounded backoff', h.backoffs().length === 1 && h.backoffs()[0].ms === 250);
    a.abort(); await p;
    h.backoffs()[0].fn(); await flush();
    check('cancellation during scheduled backoff prevents rearm when timer fires', h.sleeps.length === 1 && h.backoffs().length === 1 && f.sent.length === 0);

    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); f = h.frames[0];
    var duplicate = await h.deliver({ type: 'helper-js-eval', payload: h.routes[0].payload });
    check('duplicate request token rejects without replacing live invocation', !duplicate.ok && /Duplicate/.test(duplicate.error) && h.frames.length === 1);
    var unknown = await h.deliver({ type: 'helper-cancel-sandbox', payload: { sandboxRequestId: 'unknown' } });
    var malformed = await h.deliver({ type: 'helper-cancel-sandbox', payload: {} });
    check('unknown or missing cancel token cannot cancel a live invocation', !unknown.result.cancelled && !malformed.result.cancelled && h.live.size === 1);
    h.emit(f, { type: 'sandboxDone', error: 'code rejected' });
    check('sandbox code rejection cleans and reaches caller', /code rejected/.test((await p).error.message) && h.live.size === 0 && h.listeners.size === 0);

    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); h.frames[0].error();
    check('iframe load error cleans listener/frame/registry', /failed to load/.test((await p).error.message) && h.listeners.size === 0 && h.live.size === 0);
    h = harness({ appendFails: true }); a = new AbortController();
    check('iframe setup failure cleans registry and listener', /append failed/.test((await h.direct(a)).error.message) && h.listeners.size === 0 && h.live.size === 0);
    h = harness({ postFails: true }); a = new AbortController(); p = h.direct(a); await flush(); h.emit(h.frames[0], { type: 'sandboxReady' });
    check('execution postMessage failure cleans frame/listener', /post failed/.test((await p).error.message) && h.listeners.size === 0 && h.live.size === 0);
    h = harness({ ready: Promise.resolve(false) }); a = new AbortController();
    var notReady = await h.direct(a);
    check('readiness failure preserves existing error', /not available/.test(notReady.error.message) && h.routes.length === 0);
    // P4 #1 (1): the readiness error is decorated (message + code) but still matches /not available/.
    check('P4#1 readiness failure is decorated offscreen_not_ready', /offscreen_not_ready/.test(notReady.error.message) && notReady.error.code === 'offscreen_not_ready' && /5000ms/.test(notReady.error.message));

    // P4 #1 (2): a sandbox iframe that never posts 'sandboxReady' is disposed by the 15s timer.
    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); f = h.frames[0];
    check('P4#1 sandbox run arms exactly one 60s ready timer', h.readyTimers().length === 1 && h.live.size === 1);
    h.readyTimers()[0].fn(); await flush(); var neverReady = await p;
    check('P4#1 never-ready iframe fails fast with sandbox_never_ready', !neverReady.ok && /sandbox_never_ready/.test(neverReady.error.message));
    check('P4#1 never-ready timer disposes frame/listener via cleanup', h.live.size === 0 && h.listeners.size === 0 && h.removed === 1 && f.sent.length === 0);
    a.abort(); check('P4#1 abort after never-ready disposal sends no cancellation', h.cancelCount() === 0);
    // P4 #1 (3): once 'sandboxReady' arrived the timer is a no-op; completion clears it.
    h = harness(); a = new AbortController(); p = h.direct(a); await flush(); f = h.frames[0];
    h.emit(f, { type: 'sandboxReady' }); h.readyTimers()[0].fn(); await flush();
    check('P4#1 ready timer is a no-op after sandboxReady', h.live.size === 1 && f.sent.length === 1 && h.cleared.length === 0);
    h.emit(f, { type: 'sandboxDone', result: 11 });
    check('P4#1 completion clears the ready timer', (await p).value === 11 && h.cleared.indexOf(h.timeouts.indexOf(h.readyTimers()[0]) + 1) >= 0 && h.live.size === 0);
    h.readyTimers()[0].fn(); await flush();
    check('P4#1 late ready timer after completion is harmless', h.removed === 1 && h.live.size === 0);

    // P4 #1 (4): waitForOffscreenReady self-heal (flag P4_OFFSCREEN_SELF_HEAL) — real production slice,
    // fake chrome.offscreen / setTimeout / self.getP4Flag / persistenceBusyReason.
    var readySource = between(sources['src/platform/extension/background.js'],
        'function waitForOffscreenReady(', '// Called by the SW runtime');
    function readyHarness(opts) {
        opts = opts || {};
        var r = { closes: 0, creates: 0, hasDocCalls: 0, timers: [], resolvers: [], warns: 0, busyCalls: 0 };
        var offscreen = {
            hasDocument: function() { r.hasDocCalls++; return Promise.resolve(opts.hasDocument !== false); },
            closeDocument: function() { r.closes++; return Promise.resolve(); }
        };
        var selfObj = { getP4Flag: function(name) { return name === 'P4_OFFSCREEN_SELF_HEAL' && !!opts.flag; } };
        var busy = opts.busy === undefined ? undefined : function() { r.busyCalls++; return opts.busy; };
        // R4 SF1: _swOffscreenHealing / _swOffscreenClosing are module-level in bg.js (declared outside the
        // slice) — provide them as wrapper params so the slice's assignments hit shared closure state.
        r.wait = new Function('_swOffscreenKeepAlivePort', 'ensureOffscreenDocument', '_swOffscreenReadyResolvers',
            'setTimeout', 'self', 'chrome', 'persistenceBusyReason', 'console', '_swOffscreenHealing', '_swOffscreenClosing',
            readySource + '\nreturn waitForOffscreenReady;')(
            opts.port || null, function() { r.creates++; return Promise.resolve(); }, r.resolvers,
            function(fn, ms) { r.timers.push({ fn: fn, ms: ms }); return r.timers.length; }, selfObj, { offscreen: offscreen }, busy,
            { warn: function() { r.warns++; }, error: function() {} }, null, null);
        // The heal chain awaits hasDocument → closeDocument → ensureOffscreenDocument; flush generously.
        r.fire = async function(i) { r.timers[i].fn(); for (var k = 0; k < 4; k++) await flush(); };
        r.connect = async function() { r.resolvers.splice(0).forEach(function(fn) { fn(); }); await flush(); };
        return r;
    }
    var r = readyHarness({ flag: false }); var rp = r.wait(60000); await flush();
    check('P4#1 readiness wait is capped at 60s and creates once', r.timers.length === 1 && r.timers[0].ms === 60000 && r.creates === 1);
    var rShort = readyHarness({ flag: false }); rShort.wait(30000); await flush();
    check('COR-2 caller timeout below the cap is honoured', rShort.timers.length === 1 && rShort.timers[0].ms === 30000);
    await r.fire(0);
    check('P4#1 flag OFF: timeout resolves false with no close/hasDocument', (await rp) === false && r.closes === 0 && r.hasDocCalls === 0 && r.timers.length === 1);
    r = readyHarness({ flag: true, port: { name: 'sw-keepalive' } });
    check('P4#1 flag ON with keep-alive port resolves true without waiting', (await r.wait(5000)) === true && r.timers.length === 0 && r.creates === 0);
    r = readyHarness({ flag: true }); rp = r.wait(5000); await flush(); await r.fire(0);
    check('P4#1 flag ON zombie: one close + one recreate + second wait', r.hasDocCalls === 1 && r.closes === 1 && r.creates === 2 && r.warns === 1 && r.timers.length === 2 && r.timers[1].ms === 5000);
    await r.connect();
    check('P4#1 healed document connecting its port resolves true', (await rp) === true);
    r = readyHarness({ flag: true }); rp = r.wait(5000); await flush(); await r.fire(0); await r.fire(1);
    check('P4#1 second timeout resolves false and never heals twice', (await rp) === false && r.closes === 1 && r.creates === 2 && r.timers.length === 2);
    r = readyHarness({ flag: true, busy: 'saving 3 chats' }); rp = r.wait(5000); await flush(); await r.fire(0);
    check('P4#1 persistence busy: no close, resolves false', (await rp) === false && r.busyCalls === 1 && r.closes === 0 && r.creates === 1 && r.timers.length === 1);
    r = readyHarness({ flag: true, hasDocument: false }); rp = r.wait(5000); await flush(); await r.fire(0);
    check('P4#1 no document to heal: no close, resolves false', (await rp) === false && r.closes === 0 && r.timers.length === 1);
    // R4 SF1: two callers time out in the SAME window → single-flight heal (1 close + 1 recreate), both re-wait.
    r = readyHarness({ flag: true }); rp = r.wait(5000); var rp2 = r.wait(5000); await flush();
    check('P4#1 concurrent: two waits arm two timers and create twice (pre-heal)', r.timers.length === 2 && r.creates === 2);
    r.timers[0].fn(); r.timers[1].fn(); for (var _k = 0; _k < 6; _k++) await flush();
    check('P4#1 concurrent timeouts heal ONCE: 1 hasDocument + 1 close + 1 recreate + 1 warn, both re-wait', r.hasDocCalls === 1 && r.closes === 1 && r.creates === 3 && r.warns === 1 && r.timers.length === 4);
    await r.connect();
    check('P4#1 concurrent: both callers resolve true once the healed document connects', (await rp) === true && (await rp2) === true);
    h = harness({ transportFails: true }); a = new AbortController();
    check('transport rejection preserves error and removes abort subscription', /channel failed/.test((await h.direct(a)).error.message));
    a.abort(); check('abort after transport failure sends no cancellation', h.cancelCount() === 0);
    h = harness({ response: { ok: false, error: 'helper error' } });
    check('helper error envelope preserves existing contract', /helper error/.test((await h.direct()).error.message));
    h = harness({ response: { ok: true, result: 3 } });
    check('legacy callers without a signal retain results with host-issued invocation identity', (await h.direct()).value === 3 && !!h.routes[0].payload.sandboxRequestId);

    for (var option of ['cancelFails', 'cancelThrows']) {
        var settings = {}; settings[option] = true; h = harness(settings); p = h.start(); await flush();
        h.tick(5 * 60 * 1000 + 15000); await flush();
        check(option + ': cancellation delivery failure cannot mask original timeout', /5 minutes of inactivity/.test((await p).error.message) && h.warnings.length === 1);
        check(option + ': failed delivery is not falsely treated as iframe disposal', h.live.size === 1);
        h.emit(h.frames[0], { type: 'sandboxDone', result: null }); await flush();
    }
    var missing = new Function('Platform', 'self', workerSource + '\nreturn Platform;')({}, {});
    check('worker bridge still rejects an unavailable background helper', /not initialized/.test((await outcome(missing.callOffscreenHelper('helper-js-eval', {}))).error.message));
    return passed;
}

// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/core/075-test-run-policy.js","src/js/tools/020-tool-execution.js","src/js/worker/010-platform-stub.js","src/platform/extension/background.js","src/platform/extension/offscreen-helper.js"];
await registerRunner('js-eval-sandbox-lifecycle', async function() { return runJsEvalSandboxLifecycleTests(await loadSources(PATHS)); });
