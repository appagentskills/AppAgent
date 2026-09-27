// B2 (reload-zombie wedge: js_eval / run_tests silently never ran after a
// Reload). ensureOffscreenDocument used to await chrome.offscreen calls with no
// bound, so one wedged close / probe / create left _swOffscreenCreating pending
// forever and every later readiness wait joined it. The fix (background.js,
// offscreen region) caps every await at 5s, rejects with a coded error
// (Error(CODE + ': ' + sentence), e.code = CODE), records it in
// _swOffscreenLastError ({code, message, at}; null after a success), always
// clears the single-flight slot, and pre-handles the returned promise so the
// fire-and-forget callers never raise unhandledrejection. callOffscreenHelper
// appends ' (last offscreen error: <message>)' to its not-available errors.
//
// Runs the REAL production slices of background.js, cut by TEXT markers (never
// line numbers), against fake chrome.offscreen / chrome.runtime, fake timers
// and a manual clock. NOTE the collision: the readiness cap in
// waitForOffscreenReady defaults to 5000ms too, so fire(5000) expires it along
// with an ensure step; tests that need them apart pass timeoutMs 7000.
describe('B2 bounded ensureOffscreenDocument + coded errors (background.js offscreen slice)', function() {
    var STEP = 5000; // STEP_MS inside ensureOffscreenDocument

    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + (a < 0 ? start : end));
        return text.slice(a, b);
    }
    async function flush(n) { for (var i = 0; i < (n || 40); i++) await Promise.resolve(); }
    function deferred() {
        var d = {}; d.promise = new Promise(function(res, rej) { d.resolve = res; d.reject = rej; }); return d;
    }
    function hang() { return new Promise(function() {}); }
    function settledState(p) {
        var s = { done: false };
        p.then(function(v) { s.done = true; s.ok = true; s.value = v; }, function(err) { s.done = true; s.ok = false; s.error = err; });
        return s;
    }

    var _bg = null;
    async function bgSource() {
        if (_bg === null) _bg = await loadFile('src/platform/extension/background.js');
        return _bg;
    }

    // One fake SW realm running the whole offscreen region (vars + ensure +
    // ping/recreate + waitForOffscreenReady + callOffscreenHelper) plus the
    // idle-close + keep-alive slice ('async function maybeCloseOffscreenIfIdle() {'
    // -> '// Heartbeat alarm.'), whose REAL onConnect listener is e.connectListener.
    // opts: flag (P4_OFFSCREEN_SELF_HEAL), noHasDocument, noGetContexts, noOffscreen.
    async function env(opts) {
        opts = opts || {};
        var bg = await bgSource();
        var e = { timers: [], warns: [], errors: [], now: 1000000, flag: !!opts.flag, busy: null,
            calls: { has: 0, create: 0, contexts: 0, close: 0 }, createArgs: [], contextQueries: [], sent: [],
            bound: [], unbound: [] };
        // Per-test behaviours (each returns a promise or throws synchronously).
        e.hasDocument = function() { return Promise.resolve(false); };
        e.createDocument = function() { return Promise.resolve(); };
        e.closeDocument = function() { return Promise.resolve(); };
        e.getContexts = function() { return Promise.resolve([]); };
        e.sendMessage = function() { return hang(); };
        e.running = {};           // runningChatIds as seen by maybeCloseOffscreenIfIdle (bound, never a sandbox global)
        e.connectListener = null; // the REAL keep-alive chrome.runtime.onConnect listener
        var offscreen = {
            createDocument: function(o) { e.calls.create++; e.createArgs.push(o); return e.createDocument(o); },
            closeDocument: function() { e.calls.close++; return e.closeDocument(); }
        };
        if (!opts.noHasDocument) offscreen.hasDocument = function() { e.calls.has++; return e.hasDocument(); };
        var runtime = { sendMessage: function(m) { e.sent.push(m && m.type); return e.sendMessage(m); },
            onConnect: { addListener: function(fn) { e.connectListener = fn; } } };
        if (!opts.noGetContexts) runtime.getContexts = function(q) { e.calls.contexts++; e.contextQueries.push(q); return e.getContexts(q); };
        var chrome = { runtime: runtime };
        if (!opts.noOffscreen) chrome.offscreen = offscreen;
        var selfObj = { getP4Flag: function(name) { return name === 'P4_OFFSCREEN_SELF_HEAL' && e.flag; } };
        var fakeConsole = {
            warn: function() { e.warns.push(Array.prototype.slice.call(arguments).join(' ')); },
            error: function() { e.errors.push(Array.prototype.slice.call(arguments).join(' ')); },
            log: function() {}
        };
        var uuid = 0;
        var fakeCrypto = { randomUUID: function() { return 'uuid' + (++uuid); } };
        var policy = { registry: {
            bind: function(id) { e.bound.push(id); }, descriptor: function() { return {}; },
            unbind: function(id) { e.unbound.push(id); }, relay: function() {}
        } };
        var fakeSetTimeout = function(fn, ms) {
            var t = { id: e.timers.length + 1, fn: fn, ms: ms, cleared: false, fired: false };
            e.timers.push(t);
            return t.id;
        };
        var fakeClearTimeout = function(id) { var t = e.timers[id - 1]; if (t) t.cleared = true; };
        var slice = between(bg, 'var _swOffscreenCreating = null;', '// Expose to the imported SW bundle.')
            + '\n' + between(bg, 'async function maybeCloseOffscreenIfIdle() {', '// Heartbeat alarm.');
        e.api = new Function('chrome', 'self', 'setTimeout', 'clearTimeout', 'console', 'crypto', 'TestRunPolicy', 'persistenceBusyReason', 'Date', 'runningChatIds',
            slice + '\nreturn {'
            + ' ensure: ensureOffscreenDocument, wait: waitForOffscreenReady, call: callOffscreenHelper,'
            + ' recreate: recreateOffscreenDocument, responsive: ensureOffscreenResponsive, idleClose: maybeCloseOffscreenIfIdle,'
            + ' healing: function(v) { if (arguments.length) _swOffscreenHealing = v; return _swOffscreenHealing; },'
            + ' lastError: function(v) { if (arguments.length) _swOffscreenLastError = v; return _swOffscreenLastError; },'
            + ' creating: function() { return _swOffscreenCreating; },'
            + ' closing: function(v) { if (arguments.length) _swOffscreenClosing = v; return _swOffscreenClosing; },'
            + ' port: function(v) { if (arguments.length) _swOffscreenKeepAlivePort = v; return _swOffscreenKeepAlivePort; },'
            + ' idleSince: function(v) { if (arguments.length) _swOffscreenIdleSince = v; return _swOffscreenIdleSince; }'
            + ' };')(chrome, selfObj, fakeSetTimeout, fakeClearTimeout, fakeConsole, fakeCrypto, policy,
            function() { return e.busy; }, { now: function() { return e.now; } }, e.running);
        e.pending = function(ms) {
            return e.timers.filter(function(t) { return !t.cleared && !t.fired && (ms === undefined || t.ms === ms); });
        };
        e.pendingMs = function() { return e.pending().map(function(t) { return t.ms; }); };
        // Advance the manual clock by ms, then fire every timer of that delay
        // that was armed (and not cleared) before this call.
        e.fire = async function(ms) {
            e.now += ms;
            e.pending(ms).forEach(function(t) { t.fired = true; t.fn(); });
            await flush(60);
        };
        return e;
    }

    // Coded-error contract: Error(CODE + ': ' + sentence) with e.code === CODE,
    // mirrored in _swOffscreenLastError; the single-flight slot is cleared, no
    // step timer is left armed, and the failure is logged once.
    function assertCoded(e, err, code) {
        assert.ok(err instanceof Error, 'rejects with an Error, got ' + err);
        assert.strictEqual(err.code, code);
        assert.strictEqual(err.message.indexOf(code + ': '), 0, 'message starts with "' + code + ': ": ' + err.message);
        assert.strictEqual(err.message.slice(0, err.message.indexOf(':')), err.code, 'e.code equals the message prefix');
        assert.deepStrictEqual(e.api.lastError(), { code: code, message: err.message, at: e.now }, '_swOffscreenLastError = {code, message, at}');
        assert.strictEqual(e.api.creating(), null, '_swOffscreenCreating cleared after the failure');
        assert.deepStrictEqual(e.pendingMs(), [], 'no step timer left armed');
        assert.strictEqual(e.errors.filter(function(m) { return m === '[SW] offscreen creation failed: ' + err.message; }).length, 1, 'failure logged once');
    }
    function assertSuccess(e, s) {
        assert.strictEqual(s.done, true, 'ensure settled');
        assert.strictEqual(s.ok, true, 'ensure resolved: ' + (s.error && s.error.message));
        assert.strictEqual(e.api.lastError(), null, '_swOffscreenLastError is null after a success');
        assert.strictEqual(e.api.creating(), null, '_swOffscreenCreating cleared after a success');
        assert.deepStrictEqual(e.pendingMs(), [], 'every step timer was cleared');
    }
    function warned(e, code) { return e.warns.some(function(w) { return w.indexOf('[SW] ' + code + ': ') === 0; }); }

    // ── 1. Closing wait (flag P4_OFFSCREEN_SELF_HEAL only) ──────────────────
    test('flag ON: a hung idle-close is dropped after 5s — OFFSCREEN_CLOSE_TIMEOUT is recorded (no throw), then the create succeeds and lastError returns to null', async function() {
        var e = await env({ flag: true });
        e.api.closing(hang());
        var has = deferred();
        e.hasDocument = function() { return has.promise; };
        var s = settledState(e.api.ensure());
        await flush();
        assert.strictEqual(s.done, false, 'waits for the in-flight close first');
        assert.strictEqual(e.calls.has, 0, 'no probe while the close is pending');
        assert.deepStrictEqual(e.pendingMs(), [STEP], 'the close wait is bounded by one 5s timer');
        await e.fire(STEP);
        assert.strictEqual(e.api.closing(), null, 'the wedged close promise is dropped');
        var le = e.api.lastError();
        assert.ok(le && le.code === 'OFFSCREEN_CLOSE_TIMEOUT', 'lastError is OFFSCREEN_CLOSE_TIMEOUT');
        assert.strictEqual(le.message.slice(0, le.message.indexOf(':')), le.code, 'code equals the message prefix');
        assert.strictEqual(le.at, e.now);
        assert.ok(warned(e, 'OFFSCREEN_CLOSE_TIMEOUT'), 'warned with the coded message');
        assert.strictEqual(s.done, false, 'a close timeout does not throw: the probe runs next');
        assert.strictEqual(e.calls.has, 1);
        has.resolve(false);
        await flush();
        assertSuccess(e, s);
        assert.strictEqual(e.calls.create, 1, 'created once');
        // A later call never waits on the dropped close again.
        e.hasDocument = function() { return Promise.resolve(true); };
        var before = e.timers.length;
        var s2 = settledState(e.api.ensure());
        await flush();
        assertSuccess(e, s2);
        assert.strictEqual(e.timers.length - before, 1, 'only the probe timer: no second close wait');
        assert.strictEqual(e.calls.create, 1, 'existing document: no second create');
    }, { tags: ['unit'] });

    test('flag ON: only the SAME close promise is dropped — a newer close published meanwhile is kept', async function() {
        var e = await env({ flag: true });
        e.api.closing(hang());
        var s = settledState(e.api.ensure());
        await flush();
        var newer = hang();
        e.api.closing(newer);
        await e.fire(STEP);
        assert.strictEqual(e.api.closing(), newer, 'the newer close is not dropped');
        assert.ok(warned(e, 'OFFSCREEN_CLOSE_TIMEOUT'));
        assertSuccess(e, s);
    }, { tags: ['unit'] });

    test('flag ON: a close that rejects in time is awaited and non-fatal (no coded warning, create proceeds)', async function() {
        var e = await env({ flag: true });
        var c = deferred();
        e.api.closing(c.promise);
        var s = settledState(e.api.ensure());
        await flush();
        assert.strictEqual(e.calls.has, 0, 'still waiting on the close');
        c.reject(new Error('close failed'));
        await flush();
        assertSuccess(e, s);
        assert.strictEqual(e.calls.create, 1);
        assert.strictEqual(e.warns.filter(function(w) { return /OFFSCREEN_/.test(w); }).length, 0, 'no coded warning');
    }, { tags: ['unit'] });

    test('flag OFF (default): a hung close is neither awaited nor touched', async function() {
        var e = await env({ flag: false });
        var hung = hang();
        e.api.closing(hung);
        var s = settledState(e.api.ensure());
        await flush();
        assertSuccess(e, s);
        assert.strictEqual(e.api.closing(), hung, 'left for its owner to clear');
        assert.strictEqual(e.calls.create, 1);
        assert.strictEqual(e.timers.length, 2, 'probe + create bounds only');
    }, { tags: ['unit'] });

    // ── 2. Probe (hasDocument, or getContexts when hasDocument is missing) ──
    test('probe hang: hasDocument never settles -> OFFSCREEN_PROBE_TIMEOUT recorded after 5s (no throw); createDocument still runs and succeeds', async function() {
        var e = await env();
        e.hasDocument = hang;
        var cd = deferred();
        e.createDocument = function() { return cd.promise; };
        var s = settledState(e.api.ensure());
        await flush();
        assert.strictEqual(s.done, false);
        assert.strictEqual(e.calls.create, 0, 'no create before the probe bound');
        assert.deepStrictEqual(e.pendingMs(), [STEP]);
        await e.fire(STEP);
        var le = e.api.lastError();
        assert.ok(le && le.code === 'OFFSCREEN_PROBE_TIMEOUT', 'lastError is OFFSCREEN_PROBE_TIMEOUT');
        assert.match(le.message, /^OFFSCREEN_PROBE_TIMEOUT: chrome\.offscreen\.hasDocument did not settle within 5000ms; trying createDocument$/);
        assert.ok(warned(e, 'OFFSCREEN_PROBE_TIMEOUT'));
        assert.strictEqual(e.calls.create, 1, 'unknown state -> create anyway');
        assert.ok(e.api.creating(), 'single-flight slot held while the create is pending');
        cd.resolve();
        await flush();
        assertSuccess(e, s);
        assert.strictEqual(e.calls.contexts, 0, 'no fallback after a successful create');
    }, { tags: ['unit'] });

    test('probe finds a document (hasDocument true / getContexts [{}]) -> no create, stale lastError cleared', async function() {
        var e = await env();
        e.hasDocument = function() { return Promise.resolve(true); };
        e.api.lastError({ code: 'OFFSCREEN_CREATE_FAILED', message: 'OFFSCREEN_CREATE_FAILED: stale', at: 1 });
        var s = settledState(e.api.ensure());
        await flush();
        assertSuccess(e, s);
        assert.strictEqual(e.calls.create, 0);
        var g = await env({ noHasDocument: true });
        g.getContexts = function() { return Promise.resolve([{ contextType: 'OFFSCREEN_DOCUMENT' }]); };
        g.api.lastError({ code: 'OFFSCREEN_CREATE_FAILED', message: 'OFFSCREEN_CREATE_FAILED: stale', at: 1 });
        var gs = settledState(g.api.ensure());
        await flush();
        assertSuccess(g, gs);
        assert.strictEqual(g.calls.create, 0);
        assert.deepStrictEqual(g.contextQueries, [{ contextTypes: ['OFFSCREEN_DOCUMENT'] }], 'getContexts filtered to OFFSCREEN_DOCUMENT');
    }, { tags: ['unit'] });

    test('probe via getContexts (no hasDocument) that hangs -> OFFSCREEN_PROBE_TIMEOUT names getContexts; the create then succeeds', async function() {
        var e = await env({ noHasDocument: true });
        e.getContexts = hang;
        var s = settledState(e.api.ensure());
        await flush();
        assert.deepStrictEqual(e.pendingMs(), [STEP]);
        await e.fire(STEP);
        assert.ok(e.warns.indexOf('[SW] OFFSCREEN_PROBE_TIMEOUT: chrome.runtime.getContexts did not settle within 5000ms; trying createDocument') >= 0, 'coded warning names getContexts');
        assertSuccess(e, s);
        assert.strictEqual(e.calls.create, 1);
        assert.strictEqual(e.calls.contexts, 1, 'the successful create needs no fallback');
    }, { tags: ['unit'] });

    test('a probe that throws synchronously or rejects counts as "no document": create runs, nothing recorded', async function() {
        var e = await env();
        e.hasDocument = function() { throw new Error('hasDocument exploded'); };
        var s = settledState(e.api.ensure());
        await flush();
        assertSuccess(e, s);
        assert.strictEqual(e.calls.create, 1);
        var r = await env();
        r.hasDocument = function() { return Promise.reject(new Error('hasDocument rejected')); };
        var rs = settledState(r.api.ensure());
        await flush();
        assertSuccess(r, rs);
        assert.strictEqual(r.calls.create, 1);
        assert.strictEqual(e.warns.length + r.warns.length, 0, 'not a timeout: no coded warning');
    }, { tags: ['unit'] });

    // ── 3. createDocument + getContexts fallback ────────────────────────────
    test('create hang -> OFFSCREEN_CREATE_TIMEOUT after 5s once the getContexts fallback finds no document', async function() {
        var e = await env();
        e.createDocument = hang;
        var s = settledState(e.api.ensure());
        await flush();
        assert.strictEqual(e.calls.create, 1);
        assert.deepStrictEqual(e.pendingMs(), [STEP], 'the create is bounded by one 5s timer');
        assert.ok(e.api.creating(), 'single-flight slot held while the create is pending');
        await e.fire(STEP);
        assert.strictEqual(s.ok, false);
        assertCoded(e, s.error, 'OFFSCREEN_CREATE_TIMEOUT');
        assert.match(s.error.message, /^OFFSCREEN_CREATE_TIMEOUT: chrome\.offscreen\.createDocument did not settle within 5000ms; no offscreen document exists$/);
        assert.strictEqual(e.calls.contexts, 1, 'one getContexts fallback check');
    }, { tags: ['unit'] });

    test('create hang but the getContexts fallback sees a document -> success, nothing logged', async function() {
        var e = await env();
        e.createDocument = hang;
        e.getContexts = function() { return Promise.resolve([{ contextType: 'OFFSCREEN_DOCUMENT' }]); };
        var s = settledState(e.api.ensure());
        await flush();
        await e.fire(STEP);
        assertSuccess(e, s);
        assert.strictEqual(e.calls.contexts, 1);
        assert.strictEqual(e.errors.length, 0);
    }, { tags: ['unit'] });

    test('"Only a single offscreen document" rejection: getContexts is authoritative ([{}] -> success, [] -> OFFSCREEN_CREATE_FAILED)', async function() {
        var SINGLE = 'Only a single offscreen document may be created.';
        var e = await env();
        e.createDocument = function() { return Promise.reject(new Error(SINGLE)); };
        e.getContexts = function() { return Promise.resolve([{}]); };
        var s = settledState(e.api.ensure());
        await flush();
        assertSuccess(e, s);
        var f = await env();
        f.createDocument = function() { return Promise.reject(new Error(SINGLE)); };
        var sf = settledState(f.api.ensure());
        await flush();
        assert.strictEqual(sf.ok, false);
        assertCoded(f, sf.error, 'OFFSCREEN_CREATE_FAILED');
        assert.strictEqual(sf.error.message, 'OFFSCREEN_CREATE_FAILED: chrome.offscreen.createDocument failed: ' + SINGLE + '; no offscreen document exists');
    }, { tags: ['unit'] });

    test('no chrome.runtime.getContexts: single-document error -> success (pre-B2), other error -> CREATE_FAILED, hang -> CREATE_TIMEOUT with no fallback timer', async function() {
        var a = await env({ noGetContexts: true });
        a.createDocument = function() { return Promise.reject(new Error('Only a single offscreen document may be created.')); };
        var sa = settledState(a.api.ensure());
        await flush();
        assertSuccess(a, sa);
        var b = await env({ noGetContexts: true });
        b.createDocument = function() { return Promise.reject(new Error('boom')); };
        var sb = settledState(b.api.ensure());
        await flush();
        assertCoded(b, sb.error, 'OFFSCREEN_CREATE_FAILED');
        assert.strictEqual(sb.error.message, 'OFFSCREEN_CREATE_FAILED: chrome.offscreen.createDocument failed: boom; no offscreen document exists');
        var c = await env({ noGetContexts: true });
        c.createDocument = hang;
        var sc = settledState(c.api.ensure());
        await flush();
        await c.fire(STEP);
        assertCoded(c, sc.error, 'OFFSCREEN_CREATE_TIMEOUT');
        assert.strictEqual(c.timers.length, 2, 'probe + create bounds only: no fallback timer');
    }, { tags: ['unit'] });

    test('OFFSCREEN_CREATE_FAILED clears the single-flight slot: the next call creates again and succeeds', async function() {
        var e = await env();
        e.createDocument = function() { return Promise.reject(new Error('boom')); };
        var s = settledState(e.api.ensure());
        await flush();
        assertCoded(e, s.error, 'OFFSCREEN_CREATE_FAILED');
        assert.strictEqual(s.error.message, 'OFFSCREEN_CREATE_FAILED: chrome.offscreen.createDocument failed: boom; no offscreen document exists');
        e.createDocument = function() { return Promise.resolve(); };
        var s2 = settledState(e.api.ensure());
        await flush();
        assertSuccess(e, s2);
        assert.strictEqual(e.calls.create, 2, 'a fresh create, not the failed promise');
    }, { tags: ['unit'] });

    test('createDocument throwing synchronously -> OFFSCREEN_CREATE_FAILED with its message', async function() {
        var e = await env();
        e.createDocument = function() { throw new Error('createDocument exploded'); };
        var s = settledState(e.api.ensure());
        await flush();
        assertCoded(e, s.error, 'OFFSCREEN_CREATE_FAILED');
        assert.strictEqual(s.error.message, 'OFFSCREEN_CREATE_FAILED: chrome.offscreen.createDocument failed: createDocument exploded; no offscreen document exists');
    }, { tags: ['unit'] });

    test('fallback getContexts hang -> OFFSCREEN_PROBE_TIMEOUT naming the create cause (after a failure: 1 fire; after a create hang: 2 fires)', async function() {
        var e = await env();
        e.createDocument = function() { return Promise.reject(new Error('boom')); };
        e.getContexts = hang;
        var s = settledState(e.api.ensure());
        await flush();
        assert.deepStrictEqual(e.pendingMs(), [STEP], 'the fallback is bounded by one 5s timer');
        await e.fire(STEP);
        assertCoded(e, s.error, 'OFFSCREEN_PROBE_TIMEOUT');
        assert.strictEqual(s.error.message, 'OFFSCREEN_PROBE_TIMEOUT: chrome.runtime.getContexts did not settle within 5000ms while checking for an existing document after chrome.offscreen.createDocument failed: boom');
        var d = await env();
        d.createDocument = hang;
        d.getContexts = hang;
        var sd = settledState(d.api.ensure());
        await flush();
        await d.fire(STEP);
        assert.strictEqual(sd.done, false, 'the create timed out; the fallback is still pending (bounded)');
        assert.deepStrictEqual(d.pendingMs(), [STEP]);
        await d.fire(STEP);
        assertCoded(d, sd.error, 'OFFSCREEN_PROBE_TIMEOUT');
        assert.match(sd.error.message, / after chrome\.offscreen\.createDocument did not settle within 5000ms$/);
    }, { tags: ['unit'] });

    test('fallback getContexts rejects -> OFFSCREEN_CREATE_FAILED (the create cause wins)', async function() {
        var e = await env();
        e.createDocument = function() { return Promise.reject(new Error('boom')); };
        e.getContexts = function() { return Promise.reject(new Error('contexts boom')); };
        var s = settledState(e.api.ensure());
        await flush();
        assertCoded(e, s.error, 'OFFSCREEN_CREATE_FAILED');
        assert.strictEqual(s.error.message, 'OFFSCREEN_CREATE_FAILED: chrome.offscreen.createDocument failed: boom; no offscreen document exists');
    }, { tags: ['unit'] });

    test('single-flight: concurrent calls share ONE create; both resolve, or both reject with the SAME error; the slot is always cleared', async function() {
        var e = await env();
        var cd = deferred();
        e.createDocument = function() { return cd.promise; };
        var s1 = settledState(e.api.ensure()), s2 = settledState(e.api.ensure());
        await flush();
        assert.strictEqual(e.calls.has, 2, 'each call probes');
        assert.strictEqual(e.calls.create, 1, 'only the first creates');
        assert.ok(e.api.creating(), 'slot held while pending');
        assert.strictEqual(s1.done || s2.done, false);
        cd.resolve();
        await flush();
        assertSuccess(e, s1);
        assertSuccess(e, s2);
        var f = await env();
        var fd = deferred();
        f.createDocument = function() { return fd.promise; };
        var f1 = settledState(f.api.ensure()), f2 = settledState(f.api.ensure());
        await flush();
        assert.strictEqual(f.calls.create, 1);
        fd.reject(new Error('boom'));
        await flush();
        assert.strictEqual(f1.ok, false);
        assert.strictEqual(f2.ok, false);
        assert.strictEqual(f1.error, f2.error, 'the SAME error object');
        assertCoded(f, f1.error, 'OFFSCREEN_CREATE_FAILED');
    }, { tags: ['unit'] });

    test('worst case is bounded: everything hangs -> one 5s timer per step; flag ON settles after 4 steps (+20s), flag OFF after 3 (+15s), as OFFSCREEN_PROBE_TIMEOUT', async function() {
        async function allHang(flag) {
            var e = await env({ flag: flag });
            e.api.closing(hang());
            e.hasDocument = hang; e.createDocument = hang; e.getContexts = hang;
            var start = e.now;
            var s = settledState(e.api.ensure());
            await flush();
            var fires = 0;
            while (!s.done && fires < 6) {
                assert.deepStrictEqual(e.pendingMs(), [STEP], (flag ? 'ON' : 'OFF') + ': exactly one pending 5s timer before step ' + (fires + 1));
                await e.fire(STEP);
                fires++;
            }
            assertCoded(e, s.error, 'OFFSCREEN_PROBE_TIMEOUT');
            assert.match(s.error.message, / after chrome\.offscreen\.createDocument did not settle within 5000ms$/);
            return { e: e, fires: fires, elapsed: e.now - start };
        }
        var on = await allHang(true);
        assert.strictEqual(on.fires, 4);
        assert.strictEqual(on.elapsed, 20000);
        assert.ok(warned(on.e, 'OFFSCREEN_CLOSE_TIMEOUT') && warned(on.e, 'OFFSCREEN_PROBE_TIMEOUT'), 'close + probe timeouts warned on the way');
        var off = await allHang(false);
        assert.strictEqual(off.fires, 3);
        assert.strictEqual(off.elapsed, 15000);
        assert.strictEqual(warned(off.e, 'OFFSCREEN_CLOSE_TIMEOUT'), false, 'flag OFF never waits on the close');
    }, { tags: ['unit'] });

    test('no chrome.offscreen API -> resolves undefined, arms no timer, logs the missing permission', async function() {
        var e = await env({ noOffscreen: true });
        var s = settledState(e.api.ensure());
        await flush();
        assert.strictEqual(s.ok, true);
        assert.strictEqual(s.value, undefined);
        assert.strictEqual(e.timers.length, 0);
        assert.ok(e.errors.some(function(m) { return /chrome\.offscreen API unavailable/.test(m); }));
        assert.strictEqual(e.api.creating(), null);
    }, { tags: ['unit'] });

    test('createDocument args (offscreen.html, BLOBS); idleSince reset to 0 on success, unchanged on failure', async function() {
        var e = await env();
        e.api.idleSince(123);
        var s = settledState(e.api.ensure());
        await flush();
        assertSuccess(e, s);
        assert.strictEqual(e.createArgs.length, 1);
        assert.strictEqual(e.createArgs[0].url, 'offscreen.html');
        assert.deepStrictEqual(e.createArgs[0].reasons, ['BLOBS']);
        assert.strictEqual(typeof e.createArgs[0].justification, 'string');
        assert.strictEqual(e.api.idleSince(), 0);
        var f = await env();
        f.api.idleSince(123);
        f.createDocument = function() { return Promise.reject(new Error('boom')); };
        var sf = settledState(f.api.ensure());
        await flush();
        assertCoded(f, sf.error, 'OFFSCREEN_CREATE_FAILED');
        assert.strictEqual(f.api.idleSince(), 123);
    }, { tags: ['unit'] });

    // ── 4. callOffscreenHelper surfaces the recorded code ────────────────────
    function failingCreate(e) { e.createDocument = function() { return Promise.reject(new Error('boom')); }; }
    var PAYLOAD = { code: 'return 1', chatId: 'c1' };

    test('callOffscreenHelper not-ready error keeps /not available/ and appends the recorded OFFSCREEN_* code', async function() {
        var e = await env();
        failingCreate(e);
        var s = settledState(e.api.call('helper-js-eval', PAYLOAD, 7000));
        await flush();
        assert.deepStrictEqual(e.pendingMs(), [7000], 'only the readiness wait is pending');
        await e.fire(7000);
        assert.strictEqual(s.ok, false);
        var le = e.api.lastError();
        assert.strictEqual(le.code, 'OFFSCREEN_CREATE_FAILED');
        assert.strictEqual(s.error.message, 'Offscreen helper not available (offscreen_not_ready: keep-alive port never connected within 7000ms) (last offscreen error: ' + le.message + ')');
        assert.match(s.error.message, /not available/);
        assert.match(s.error.message, /\bOFFSCREEN_CREATE_FAILED\b/);
        assert.strictEqual(s.error.message.match(/\bOFFSCREEN_[A-Z_]+\b/)[0], le.code, 'the first OFFSCREEN_* token is the code');
        assert.strictEqual(s.error.code, 'offscreen_not_ready');
        assert.strictEqual(e.bound.length, 1);
        assert.deepStrictEqual(e.unbound, e.bound, 'the sandbox invocation is unbound');
        assert.deepStrictEqual(e.sent, [], 'nothing dispatched');
    }, { tags: ['unit'] });

    test('after a successful ensure the not-ready error carries no stale suffix', async function() {
        var e = await env();
        e.api.lastError({ code: 'OFFSCREEN_CREATE_FAILED', message: 'OFFSCREEN_CREATE_FAILED: stale', at: 1 });
        var s = settledState(e.api.call('helper-js-eval', PAYLOAD, 7000));
        await flush();
        assert.strictEqual(e.api.lastError(), null, 'the successful create cleared the stale error');
        await e.fire(7000);
        assert.strictEqual(s.error.message, 'Offscreen helper not available (offscreen_not_ready: keep-alive port never connected within 7000ms)');
        assert.strictEqual(s.error.message.indexOf('(last offscreen error:'), -1);
    }, { tags: ['unit'] });

    test('offscreen_unresponsive (30s of ping misses, persistence busy -> no recreate) also carries the suffix', async function() {
        var e = await env();
        failingCreate(e);
        var first = settledState(e.api.ensure());
        await flush();
        assertCoded(e, first.error, 'OFFSCREEN_CREATE_FAILED');
        e.api.port({ name: 'sw-keepalive' });
        e.busy = 'persist';
        var s = settledState(e.api.call('helper-js-eval', PAYLOAD, 7000));
        await flush();
        var fires = 0;
        while (!s.done && fires < 14) { await e.fire(2500); fires++; }
        assert.strictEqual(fires, 12, '30s of continuous 2.5s ping misses');
        assert.strictEqual(s.ok, false);
        assert.match(s.error.message, /offscreen_unresponsive/);
        assert.match(s.error.message, /not available/);
        assert.ok(s.error.message.endsWith(' (last offscreen error: ' + e.api.lastError().message + ')'), s.error.message);
        assert.strictEqual(s.error.code, 'offscreen_not_ready');
        assert.strictEqual(e.calls.close, 0, 'persistence busy: never torn down');
        assert.ok(e.sent.length === 12 && e.sent.every(function(t) { return t === 'helper-ping'; }), 'only pings were sent: ' + e.sent.join(','));
    }, { tags: ['unit'] });

    test('5000ms collision: the default readiness cap and the create bound expire together -> not-available; a later call carries the recorded CREATE_TIMEOUT', async function() {
        var e = await env();
        e.createDocument = hang;
        var s = settledState(e.api.call('helper-js-eval', PAYLOAD));
        await flush();
        assert.deepStrictEqual(e.pendingMs(), [STEP, STEP], 'readiness cap + create bound, both 5000ms');
        await e.fire(STEP);
        assert.strictEqual(s.ok, false);
        assert.match(s.error.message, /not available/);
        assert.strictEqual(s.error.message.indexOf('Offscreen helper not available (offscreen_not_ready: keep-alive port never connected within 5000ms)'), 0);
        // Deliberately NOT asserting this first suffix: the readiness timer wins the race.
        assert.strictEqual(e.api.lastError().code, 'OFFSCREEN_CREATE_TIMEOUT');
        assert.strictEqual(e.api.creating(), null);
        assert.deepStrictEqual(e.pendingMs(), []);
        var s2 = settledState(e.api.call('helper-js-eval', PAYLOAD));
        await flush();
        await e.fire(STEP);
        assert.strictEqual(s2.ok, false);
        assert.ok(s2.error.message.indexOf('(last offscreen error: OFFSCREEN_CREATE_TIMEOUT: ') >= 0, s2.error.message);
        assert.strictEqual(e.api.creating(), null);
    }, { tags: ['unit'] });

    // ── 5. waitForOffscreenReady alone (the lifecycle test's slice + params) ─
    async function readyOnly(stub) {
        var bg = await bgSource();
        var r = { timers: [], resolvers: [] };
        var src = between(bg, 'function waitForOffscreenReady(', '// Called by the SW runtime');
        r.wait = new Function('_swOffscreenKeepAlivePort', 'ensureOffscreenDocument', '_swOffscreenReadyResolvers',
            'setTimeout', 'self', 'chrome', 'persistenceBusyReason', 'console', '_swOffscreenHealing', '_swOffscreenClosing',
            src + '\nreturn waitForOffscreenReady;')(
            null, stub, r.resolvers,
            function(fn, ms) { r.timers.push({ fn: fn, ms: ms }); return r.timers.length; },
            { getP4Flag: function() { return false; } }, {}, function() { return null; },
            { warn: function() {}, error: function() {}, log: function() {} }, null, null);
        return r;
    }

    test('waitForOffscreenReady with a stubbed ensure that throws, rejects or returns undefined: returns a promise, arms one timer, resolves false', async function() {
        var stubs = {
            throws: function() { throw new Error('B2 stub throw'); },
            rejects: function() { return Promise.reject(new Error('B2 stub rejection')); },
            undef: function() { return undefined; }
        };
        for (var k in stubs) {
            var r = await readyOnly(stubs[k]);
            var p = r.wait(5000);
            assert.ok(p && typeof p.then === 'function', k + ': returns a promise');
            var s = settledState(p);
            await flush();
            assert.strictEqual(r.timers.length, 1, k + ': one readiness timer');
            assert.strictEqual(r.timers[0].ms, 5000);
            assert.strictEqual(s.done, false, k + ': waits for the cap');
            r.timers[0].fn();
            await flush();
            assert.strictEqual(s.ok, true, k + ': never rejects');
            assert.strictEqual(s.value, false, k + ': resolves false');
        }
    }, { tags: ['unit'] });

    // ── 6. Fire-and-forget callers never raise unhandledrejection ───────────
    test('no unhandledrejection from fire-and-forget ensure / waitForOffscreenReady on any failure path', async function() {
        var seen = [];
        function onRejection(ev) {
            var msg = ev && ev.reason && ev.reason.message;
            if (typeof msg === 'string' && /^(OFFSCREEN_[A-Z_]+: |B2 )/.test(msg)) { seen.push(msg); ev.preventDefault(); }
        }
        window.addEventListener('unhandledrejection', onRejection);
        try {
            Promise.reject(new Error('B2 control')); // positive control: this one IS unhandled
            // 1. CREATE_FAILED, not awaited (like worker/130-port-bridge.js)
            var a = await env(); failingCreate(a);
            a.api.ensure();
            await flush();
            assert.strictEqual(a.api.lastError().code, 'OFFSCREEN_CREATE_FAILED');
            // 2. CREATE_TIMEOUT, then the hung create rejects late
            var b = await env(); var bd = deferred();
            b.createDocument = function() { return bd.promise; };
            b.api.ensure();
            await flush();
            await b.fire(STEP);
            bd.reject(new Error('B2 late create rejection'));
            await flush();
            assert.strictEqual(b.api.lastError().code, 'OFFSCREEN_CREATE_TIMEOUT', 'a late rejection does not rewrite lastError');
            // 3. everything hangs, flag ON (4 bounded steps)
            var c = await env({ flag: true });
            c.api.closing(hang()); c.hasDocument = hang; c.createDocument = hang; c.getContexts = hang;
            c.api.ensure();
            await flush();
            for (var i = 0; i < 4; i++) await c.fire(STEP);
            assert.strictEqual(c.api.lastError().code, 'OFFSCREEN_PROBE_TIMEOUT');
            // 4. a readiness wait whose ensure fails
            var d = await env(); failingCreate(d);
            d.api.wait(5000);
            await flush();
            await d.fire(STEP);
            // 5. the readiness-only slice with rejecting / throwing stubs
            var r1 = await readyOnly(function() { return Promise.reject(new Error('B2 stub rejection')); });
            r1.wait(5000);
            var r2 = await readyOnly(function() { throw new Error('B2 stub throw'); });
            r2.wait(5000);
            await flush();
            await new Promise(function(r) { setTimeout(r, 50); });
            if (seen.indexOf('B2 control') < 0) skipTest('this sandbox delivers no unhandledrejection events');
            assert.deepStrictEqual(seen, ['B2 control'], 'only the control is unhandled');
        } finally { window.removeEventListener('unhandledrejection', onRejection); }
    }, { tags: ['unit'], timeout: 5000 });

    // ── 7. recreate bounded + late-settle identity + keep-alive connect ──────
    // recreateOffscreenDocument (H18 ping heal) awaited an in-flight close and
    // its own chrome.offscreen.closeDocument() with NO bound: one wedged close
    // pinned _swOffscreenHealing forever, so every later ensureOffscreenResponsive
    // / checkOffscreenResponsive joined a heal that never settled. Both awaits are
    // now capped at 5s (_swOffscreenWithin, CLOSE_MS == STEP); a wedged close is
    // DROPPED, recorded as OFFSCREEN_CLOSE_TIMEOUT and the re-create runs anyway.
    // Closes can now be dropped, so one may settle LATE: maybeCloseOffscreenIfIdle
    // and recreate clear the closing slot / reset the keep-alive port only while
    // they are still theirs. The keep-alive connect clears a stale lastError.
    // These tests call e.api.recreate() directly: no 5000ms readiness timer.
    var PRIOR_DROPPED = 'OFFSCREEN_CLOSE_TIMEOUT: the in-flight offscreen close did not settle within 5000ms; dropped it and recreating';
    var OWN_DROPPED = 'OFFSCREEN_CLOSE_TIMEOUT: chrome.offscreen.closeDocument did not settle within 5000ms; dropped it and recreating';
    function keepAlivePort(id) { return { name: 'sw-keepalive', id: id, onDisconnect: { addListener: function() {} } }; }
    function countWarns(e, re) { return e.warns.filter(function(w) { return re.test(w); }).length; }

    // (a) Non-vacuous: pre-fix recreate awaited the prior close unbounded, so
    // pendingMs() is [] instead of [5000], s.done stays false after fire(STEP),
    // and the pinned _swOffscreenHealing makes responsive() join it forever.
    test('(a) recreate: a hung in-flight close is dropped after 5s (OFFSCREEN_CLOSE_TIMEOUT, no throw); our close + the re-create run, the heal resolves true, every slot is cleared and a later responsive() does not block', async function() {
        async function run(flag) {
            var tag = 'flag ' + (flag ? 'ON' : 'OFF') + ': ';
            var e = await env({ flag: flag });
            var prior = hang();
            e.api.closing(prior);
            var has = deferred();
            e.hasDocument = function() { return has.promise; };
            var p = e.api.recreate('ping timeout');
            var s = settledState(p);
            await flush();
            assert.strictEqual(e.api.healing(), p, tag + 'the heal holds the single-flight slot');
            assert.strictEqual(e.api.recreate('again'), p, tag + 'a concurrent recreate joins it');
            assert.deepStrictEqual(e.pendingMs(), [STEP], tag + 'the in-flight close wait is bounded by one 5s timer');
            assert.strictEqual(e.calls.close, 0, tag + 'our own close waits for the in-flight one');
            assert.strictEqual(e.api.closing(), prior, tag + 'not dropped before the bound');
            await e.fire(STEP);
            assert.deepStrictEqual(e.api.lastError(), { code: 'OFFSCREEN_CLOSE_TIMEOUT', message: PRIOR_DROPPED, at: e.now }, tag + 'recorded as {code, message, at}');
            assert.ok(e.warns.indexOf('[SW] ' + PRIOR_DROPPED) >= 0, tag + 'warned with the coded message');
            assert.strictEqual(countWarns(e, /OFFSCREEN_CLOSE_TIMEOUT/), 1, tag + 'the dropped close is never awaited again (no second CLOSE_TIMEOUT from ensure)');
            assert.strictEqual(e.calls.close, 1, tag + 'our own close ran');
            assert.strictEqual(e.api.closing(), null, tag + 'the wedged close was dropped and ours cleared its slot');
            assert.strictEqual(s.done, false, tag + 'no throw: the re-create probe is pending');
            assert.strictEqual(e.calls.has, 1);
            assert.deepStrictEqual(e.pendingMs(), [STEP], tag + 'only the probe bound is left (our close timer was cleared)');
            has.resolve(false);
            await flush(80);
            assert.strictEqual(s.ok, true, tag + 'never rejects');
            assert.strictEqual(s.value, true, tag + 'resolves true: a close + re-create happened');
            assert.strictEqual(e.calls.create, 1, tag + 're-created once');
            assert.strictEqual(e.api.healing(), null, tag + 'heal slot cleared');
            assert.strictEqual(e.api.closing(), null);
            assert.strictEqual(e.api.creating(), null);
            assert.deepStrictEqual(e.pendingMs(), [], tag + 'no timer left armed');
            assert.strictEqual(e.api.lastError(), null, tag + 'the successful create clears the record (the CLOSE_TIMEOUT stays in console.warn)');
            // The next health check (dispatch / js_eval watchdog) must not join a pinned heal.
            e.api.port(keepAlivePort('fresh'));
            e.sendMessage = function() { return Promise.resolve({ ok: true }); };
            var rs = settledState(e.api.responsive(5000, 'next dispatch'));
            await flush();
            assert.strictEqual(rs.done, true, tag + 'responsive() settles at once');
            assert.strictEqual(rs.value, true);
            assert.deepStrictEqual(e.sent, ['helper-ping'], tag + 'one ping, answered');
            assert.strictEqual(e.calls.close, 1, tag + 'no second recreate');
            assert.deepStrictEqual(e.pendingMs(), [], tag + 'the ping timer was cleared');
        }
        await run(false);
        await run(true);
    }, { tags: ['unit'] });

    // (b) Non-vacuous: pre-fix recreate awaited closeDocument() unbounded, so
    // pendingMs() is [] instead of [5000]; after fire(STEP) the heal is still
    // pending with closing() set and port() still P.
    test('(b) recreate: a hung chrome.offscreen.closeDocument is dropped after 5s: slot cleared, our own port reset, OFFSCREEN_CLOSE_TIMEOUT names closeDocument, the re-create still runs; a close that settles in time records nothing', async function() {
        var e = await env();
        e.closeDocument = hang;
        var P = keepAlivePort('P');
        e.api.port(P);
        var has = deferred();
        e.hasDocument = function() { return has.promise; };
        var p = e.api.recreate('ping timeout');
        var s = settledState(p);
        await flush();
        assert.ok(e.warns.indexOf('[SW] offscreen document unresponsive (ping timeout); closing and recreating') >= 0);
        assert.strictEqual(e.calls.close, 1, 'no in-flight close: ours runs at once');
        var own = e.api.closing();
        assert.ok(own && typeof own.then === 'function', 'our close is published for a concurrent ensure');
        assert.deepStrictEqual(e.pendingMs(), [STEP], 'the closeDocument wait is bounded by one 5s timer');
        assert.strictEqual(e.api.port(), P, 'the port is reset only when the close settles or is dropped');
        await e.fire(STEP);
        assert.strictEqual(e.api.closing(), null, 'the wedged close is dropped from the slot');
        assert.strictEqual(e.api.port(), null, 'our own (dead) keep-alive port is reset');
        assert.deepStrictEqual(e.api.lastError(), { code: 'OFFSCREEN_CLOSE_TIMEOUT', message: OWN_DROPPED, at: e.now }, 'recorded as {code, message, at}');
        assert.ok(e.warns.indexOf('[SW] ' + OWN_DROPPED) >= 0, 'warned, naming chrome.offscreen.closeDocument');
        assert.strictEqual(s.done, false, 'no throw: the re-create probe is pending');
        assert.strictEqual(e.calls.has, 1);
        has.resolve(false);
        await flush(80);
        assert.strictEqual(s.ok, true, 'never rejects');
        assert.strictEqual(s.value, true);
        assert.strictEqual(e.calls.create, 1, 'the re-create ran despite the wedged close');
        assert.strictEqual(e.calls.close, 1, 'the wedged close is not retried');
        assert.strictEqual(e.api.healing(), null, 'heal slot cleared once settled');
        assert.deepStrictEqual(e.pendingMs(), []);
        assert.strictEqual(e.api.lastError(), null, 'the successful create clears the record');
        // Control: a close that settles in time -> nothing recorded, own port reset, close timer cleared.
        var c = await env();
        c.api.port(keepAlivePort('P2'));
        var cs = settledState(c.api.recreate('ping timeout'));
        await flush(80);
        assert.strictEqual(cs.value, true);
        assert.strictEqual(c.api.port(), null, 'own port reset by the settled close');
        assert.strictEqual(c.api.closing(), null);
        assert.strictEqual(c.api.healing(), null);
        assert.strictEqual(c.api.lastError(), null);
        assert.deepStrictEqual(c.pendingMs(), [], 'close bound + probe + create timers all cleared');
        assert.strictEqual(countWarns(c, /OFFSCREEN_/), 0, 'no coded warning');
        assert.strictEqual(c.calls.close, 1);
        assert.strictEqual(c.calls.create, 1);
    }, { tags: ['unit'] });

    // (c, idle-close) Non-vacuous: pre-fix maybeCloseOffscreenIfIdle nulled
    // _swOffscreenClosing in .finally and _swOffscreenKeepAlivePort in its IIFE
    // unconditionally, so closing() and port() would both be null here. (A fix
    // with only the slot check still fails: port() null instead of Q.)
    test('(c) idle-close settling LATE (after ensure/recreate dropped it) keeps a newer published close and a freshly connected port; a close still published clears its own slot and port', async function() {
        var e = await env();
        var cd = deferred();
        e.closeDocument = function() { return cd.promise; };
        var P = keepAlivePort('P');
        e.api.port(P);
        e.api.idleSince(e.now - 61000);
        var p1 = settledState(e.api.idleClose());
        var published = e.api.closing();
        assert.ok(published && typeof published.then === 'function', 'the idle-close is published synchronously');
        assert.strictEqual(e.calls.close, 1);
        await flush();
        assert.strictEqual(p1.done, false, 'the close is pending');
        // ensure / recreate dropped it after 5s; a fresh document connected (Q) and a newer close was published.
        var newer = hang();
        e.api.closing(newer);
        var Q = keepAlivePort('Q');
        e.api.port(Q);
        cd.resolve();
        await flush();
        assert.strictEqual(p1.done, true, 'the late close settled');
        assert.strictEqual(p1.ok, true);
        assert.strictEqual(e.api.closing(), newer, 'the newer close is kept');
        assert.strictEqual(e.api.port(), Q, 'the fresh keep-alive port is kept');
        assert.strictEqual(e.api.idleSince(), 0);
        // Control: not superseded -> its own slot and its own port are cleared (unchanged behaviour).
        var c = await env();
        c.api.port(keepAlivePort('P'));
        c.api.idleSince(c.now - 61000);
        var cp = settledState(c.api.idleClose());
        await flush();
        assert.strictEqual(cp.ok, true);
        assert.strictEqual(c.calls.close, 1);
        assert.strictEqual(c.api.closing(), null, 'its own slot is cleared');
        assert.strictEqual(c.api.port(), null, 'its own port is reset');
        assert.strictEqual(c.api.idleSince(), 0);
    }, { tags: ['unit'] });

    // (c, recreate) Non-vacuous: pre-fix recreate had no bound (after fire(STEP)
    // s.value is undefined, the heal still pending) and its close IIFE nulled the
    // port unconditionally (a fix with only the bound fails: port() null, not Q).
    test('(c) recreate close settling LATE after it was dropped keeps a newer published close and a freshly connected port', async function() {
        var e = await env();
        var cd = deferred();
        e.closeDocument = function() { return cd.promise; };
        var P = keepAlivePort('P');
        e.api.port(P);
        var s = settledState(e.api.recreate('ping timeout'));
        await flush();
        assert.ok(e.api.closing(), 'our close is published');
        await e.fire(STEP);
        assert.strictEqual(s.value, true, 'dropped after 5s; the re-create ran and the heal settled');
        assert.strictEqual(e.calls.create, 1);
        assert.strictEqual(e.api.closing(), null);
        assert.strictEqual(e.api.port(), null, 'the port at close time (P) was reset on the drop');
        assert.ok(e.warns.indexOf('[SW] ' + OWN_DROPPED) >= 0);
        // The fresh document connected (Q); an idle-close published a newer close.
        var newer = hang();
        e.api.closing(newer);
        var Q = keepAlivePort('Q');
        e.api.port(Q);
        cd.resolve();
        await flush();
        assert.strictEqual(e.api.port(), Q, 'the late settle keeps the fresh port');
        assert.strictEqual(e.api.closing(), newer, 'the late settle keeps the newer close');
        assert.strictEqual(e.api.healing(), null);
    }, { tags: ['unit'] });

    // (d) Non-vacuous: the pre-fix keep-alive onConnect listener never touched
    // _swOffscreenLastError, so lastError() would still be the stale record.
    test('(d) keep-alive connect clears a stale _swOffscreenLastError (a connected document is a success signal); other port names change nothing', async function() {
        var e = await env();
        assert.strictEqual(typeof e.connectListener, 'function', 'the slice registered the real onConnect listener');
        var stale = { code: 'OFFSCREEN_CLOSE_TIMEOUT', message: 'OFFSCREEN_CLOSE_TIMEOUT: stale', at: 1 };
        e.api.lastError(stale);
        e.api.idleSince(123);
        e.connectListener({ name: 'helper-other', onDisconnect: { addListener: function() { throw new Error('must not subscribe'); } } });
        assert.strictEqual(e.api.lastError(), stale, 'a non-keepalive port leaves the record');
        assert.strictEqual(e.api.port(), null);
        assert.strictEqual(e.api.idleSince(), 123);
        var disconnects = [];
        function port(id) { return { name: 'sw-keepalive', id: id, onDisconnect: { addListener: function(fn) { disconnects.push(fn); } } }; }
        var P = port('P');
        e.connectListener(P);
        assert.strictEqual(e.api.lastError(), null, 'the stale record is cleared on connect');
        assert.strictEqual(e.api.port(), P);
        assert.strictEqual(e.api.idleSince(), 0);
        assert.strictEqual(disconnects.length, 1);
        // Same identity contract as the new close checks: a late disconnect of P keeps Q.
        var Q = port('Q');
        e.connectListener(Q);
        disconnects[0]();
        assert.strictEqual(e.api.port(), Q);
        disconnects[1]();
        assert.strictEqual(e.api.port(), null);
    }, { tags: ['unit'] });

    // END OF CASES
});
