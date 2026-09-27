// F6 boot breadcrumbs, page half: src/js/core/015-boot-crumbs.js plus its guarded call
// sites in app/070-app-tab-ready.js and core/120-init.js.
// The REAL module is evaluated with new Function so the test owns every global it
// touches: Platform (a mutable binding, so "platform-bridge not loaded yet" is the real
// typeof path), performance, setTimeout/clearTimeout (a virtual clock: timers fire only
// from advance()) and Date. Storage is a fake Platform.storageGet/storageSet.
// One smoke test also loads it through loadModules (the standard real-module path).
describe('F6 boot crumbs (page): core/015-boot-crumbs.js', function() {
    var SRC = 'src/js/core/015-boot-crumbs.js';
    var KEY = 'appagentBootCrumbs';
    var T0 = 1700000000000;
    var _code = null;
    async function source() { return _code || (_code = await loadFile(SRC)); }
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    async function ticks(n) { for (var i = 0; i < (n || 200); i++) await Promise.resolve(); }
    function deferred() { var d = {}; d.promise = new Promise(function(res, rej) { d.resolve = res; d.reject = rej; }); return d; }

    // Virtual clock: timers fire only from advance(ms), in due order, microtasks drained between.
    function fakeClock() {
        var c = { now: 0, seq: 0, timers: [], fired: 0, errors: [] };
        c.setTimeout = function(fn, ms) { var id = ++c.seq; c.timers.push({ id: id, at: c.now + (Number(ms) || 0), fn: fn }); return id; };
        c.clearTimeout = function(id) { c.timers = c.timers.filter(function(t) { return t.id !== id; }); };
        c.advance = async function(ms) {
            var end = c.now + (ms || 0);
            for (var guard = 0; guard < 1000; guard++) {
                await ticks();
                var due = c.timers.filter(function(t) { return t.at <= end; }).sort(function(a, b) { return (a.at - b.at) || (a.id - b.id); });
                if (!due.length) break;
                var t = due[0];
                c.timers = c.timers.filter(function(x) { return x !== t; });
                c.now = t.at; c.fired++;
                try { t.fn(); } catch (e) { c.errors.push(e); }
            }
            c.now = end;
            await ticks();
        };
        return c;
    }

    // Fake Platform with an in-memory store. opts.get(p, keys) / opts.set(p, data) override
    // the default behavior (p.read / p.write are the in-memory primitives).
    function fakePlatform(prior, opts) {
        opts = opts || {};
        var p = { store: {}, gets: 0, sets: 0, events: [], writes: [] };
        if (prior !== undefined && prior !== null) p.store[KEY] = clone(prior);
        p.read = function(keys) {
            var out = {};
            [].concat(keys).forEach(function(k) { if (Object.prototype.hasOwnProperty.call(p.store, k)) out[k] = clone(p.store[k]); });
            return out;
        };
        p.write = function(data) { Object.keys(data).forEach(function(k) { p.store[k] = clone(data[k]); }); p.writes.push(clone(data)); };
        p.storageGet = function(keys) { p.gets++; p.events.push('get'); return opts.get ? opts.get(p, keys) : Promise.resolve(p.read(keys)); };
        p.storageSet = function(data) { p.sets++; p.events.push('set'); if (opts.set) return opts.set(p, data); p.write(data); return Promise.resolve(); };
        return p;
    }

    // opts.platform: the Platform global at evaluation time (omitted = not loaded yet);
    // opts.perf: the performance global (default: now() = 1234.4 ms, a 50 MB heap); null = absent.
    async function load(opts) {
        opts = opts || {};
        var clock = fakeClock();
        var perf = Object.prototype.hasOwnProperty.call(opts, 'perf') ? opts.perf
            : { now: function() { return 1234.4; }, memory: { usedJSHeapSize: 50 * 1048576 } };
        var api = new Function('Platform', 'performance', 'setTimeout', 'clearTimeout', 'Date', (await source()) +
            '\n;return { appBootCrumb: appBootCrumb, appBootCrumbState: appBootCrumbState, KEY: BOOT_CRUMBS_KEY,' +
            ' setPlatform: function(p) { Platform = p; } };')(
            opts.platform, perf === null ? undefined : perf, clock.setTimeout, clock.clearTimeout,
            { now: function() { return T0 + clock.now; } });
        api.clock = clock;
        return api;
    }

    function track(promise) {
        var s = { v: 'pending', isPromise: !!(promise && typeof promise.then === 'function') };
        if (s.isPromise) promise.then(function(v) { s.v = v; }, function(e) { s.v = 'REJECTED: ' + (e && e.message); });
        return s;
    }
    function phases(p) { return (Array.isArray(p.store[KEY]) ? p.store[KEY] : []).map(function(e) { return e.phase; }); }

    test('one well-formed page entry per crumb under appagentBootCrumbs; resolves true; IO timers cleared', async function() {
        var P = fakePlatform(), m = await load({ platform: P });
        assert.strictEqual(m.KEY, KEY);
        var s = track(m.appBootCrumb('script-start', { nav: 'reload', readyBootId: 'rb1' }));
        assert.ok(s.isPromise, 'returns a promise');
        await m.clock.advance(0);
        assert.strictEqual(s.v, true);
        var ring = P.store[KEY];
        assert.strictEqual(ring.length, 1);
        var e = ring[0];
        assert.deepStrictEqual(Object.keys(e).sort(), ['bootId', 'ctx', 'heapMB', 'nav', 'phase', 'readyBootId', 't']);
        assert.strictEqual(e.ctx, 'page');
        assert.strictEqual(e.phase, 'script-start');
        assert.strictEqual(e.t, T0);
        assert.strictEqual(e.heapMB, 50, 'usedJSHeapSize in MB');
        assert.strictEqual(e.nav, 'reload');
        assert.strictEqual(e.readyBootId, 'rb1');
        assert.ok(typeof e.bootId === 'string' && e.bootId.length > 4, 'bootId string');
        assert.strictEqual(m.clock.timers.length, 0, 'bounded get/set timers are cleared');
        assert.strictEqual(m.appBootCrumbState().written, 1);
        assert.strictEqual(m.clock.errors.length, 0);
    });

    test('one bootId per page load; heapMB only where performance.memory exists; ms falls back to Date', async function() {
        var P = fakePlatform(), a = await load({ platform: P });
        a.appBootCrumb('x'); a.appBootCrumb('y');
        await a.clock.advance(0);
        var P2 = fakePlatform(), b = await load({ platform: P2, perf: { now: function() { return 5; } } });
        b.appBootCrumb('z');
        await b.clock.advance(0);
        assert.strictEqual(P.store[KEY][0].bootId, P.store[KEY][1].bootId, 'same load, same bootId');
        assert.notStrictEqual(P2.store[KEY][0].bootId, P.store[KEY][0].bootId, 'a new load gets a new bootId');
        assert.strictEqual('heapMB' in P2.store[KEY][0], false, 'no performance.memory, no heapMB');
        // performance absent entirely, or throwing now()/memory: no throw, ms = Date.now() - t0.
        var P3 = fakePlatform(), c = await load({ platform: P3, perf: null });
        var perfBoom = { now: function() { throw new Error('now'); } };
        Object.defineProperty(perfBoom, 'memory', { get: function() { throw new Error('memory'); } });
        var P4 = fakePlatform(), d = await load({ platform: P4, perf: perfBoom });
        await c.clock.advance(700);
        c.appBootCrumb('boot-complete');
        await c.clock.advance(0);
        await d.clock.advance(250);
        d.appBootCrumb('boot-complete');
        await d.clock.advance(0);
        assert.strictEqual(P3.store[KEY][0].ms, 700, 'no performance: ms = Date.now() - t0');
        assert.strictEqual('heapMB' in P3.store[KEY][0], false);
        assert.strictEqual(P4.store[KEY][0].ms, 250, 'throwing performance.now falls back to Date');
        assert.strictEqual('heapMB' in P4.store[KEY][0], false);
    });

    test('extra: own primitives only (strings cut to 200, at most 12 keys); it cannot override the core fields', async function() {
        var P = fakePlatform(), m = await load({ platform: P });
        var extra = { phase: 'evil', ctx: 'sw', bootId: 'forged', t: 1, heapMB: 999, obj: { a: 1 }, fn: function() {}, list: [1],
            n: 3, kept: 2, s: new Array(501).join('y'), ok: true, none: null };
        for (var i = 0; i < 20; i++) extra['k' + i] = i;
        m.appBootCrumb('post-strip', extra);
        var boom = {};
        Object.defineProperty(boom, 'bad', { enumerable: true, get: function() { throw new Error('getter'); } });
        var s2 = track(m.appBootCrumb('post-render', boom));
        var s3 = track(m.appBootCrumb({ toString: function() { throw new Error('phase'); } }));
        var s4 = track(m.appBootCrumb(new Array(101).join('p')));
        await m.clock.advance(0);
        var e = P.store[KEY][0];
        assert.strictEqual(e.phase, 'post-strip');
        assert.strictEqual(e.ctx, 'page');
        assert.notStrictEqual(e.bootId, 'forged');
        assert.strictEqual(e.t, T0);
        assert.strictEqual(e.heapMB, 50);
        ['obj', 'fn', 'list'].forEach(function(k) { assert.strictEqual(k in e, false, k + ' dropped'); });
        assert.strictEqual(e.n, 3);
        assert.strictEqual(e.kept, 2);
        assert.strictEqual(e.s.length, 200, 'string cut to 200');
        assert.strictEqual(e.ok, true);
        assert.strictEqual(e.none, null);
        var extras = Object.keys(e).filter(function(k) { return ['bootId', 'ctx', 'phase', 't', 'heapMB'].indexOf(k) < 0; });
        assert.strictEqual(extras.length, 12, 'at most 12 extra keys');
        assert.strictEqual(P.store[KEY][1].phase, 'post-render', 'a throwing extra getter still logs the phase');
        assert.strictEqual(s2.v, true);
        assert.strictEqual(s3.v, false, 'an unstringifiable phase resolves false (no throw)');
        assert.strictEqual(s4.v, true);
        assert.strictEqual(P.store[KEY][2].phase.length, 64, 'phase cut to 64');
        assert.strictEqual(P.store[KEY].length, 3);
    });

    test('ring capped at 40: keeps the newest, drops the oldest (prior boots and other contexts included)', async function() {
        var prior = [];
        for (var i = 0; i < 38; i++) prior.push({ bootId: 'old', ctx: 'page', phase: 'old-' + i, t: i });
        var P = fakePlatform(prior), m = await load({ platform: P });
        ['a', 'b', 'c', 'd', 'e'].forEach(function(ph) { m.appBootCrumb(ph); });
        await m.clock.advance(0);
        var ring = P.store[KEY];
        assert.strictEqual(ring.length, 40);
        assert.strictEqual(ring[0].phase, 'old-3');
        assert.deepStrictEqual(ring.slice(-5).map(function(x) { return x.phase; }), ['a', 'b', 'c', 'd', 'e']);
        assert.strictEqual(P.sets, 1, 'five synchronous crumbs coalesce into one write');
        var big = [];
        for (var j = 0; j < 75; j++) big.push({ phase: 'x' + j });
        var P2 = fakePlatform(big), m2 = await load({ platform: P2 });
        m2.appBootCrumb('z');
        await m2.clock.advance(0);
        assert.strictEqual(P2.store[KEY].length, 40, 'an oversized ring is trimmed on our next write');
        assert.strictEqual(P2.store[KEY][0].phase, 'x36');
        assert.strictEqual(P2.store[KEY][39].phase, 'z');
        var P3 = fakePlatform('garbage'), m3 = await load({ platform: P3 });
        m3.appBootCrumb('fresh');
        await m3.clock.advance(0);
        assert.deepStrictEqual(phases(P3), ['fresh'], 'a non-array value is replaced by a fresh ring');
    });

    test('never throws or rejects: a failed, hung or empty read never writes (prior crumbs survive) and is retried', async function() {
        var modes = ['throw', 'reject', 'hang', 'empty'];
        for (var i = 0; i < modes.length; i++) {
            var mode = modes[i], broken = { on: true };
            var prior = [{ bootId: 'prev', ctx: 'page', phase: 'post-render', t: 1 }];
            var P = fakePlatform(prior, { get: (function(md, br) {
                return function(p, keys) {
                    if (!br.on) return Promise.resolve(p.read(keys));
                    if (md === 'throw') throw new Error('Extension context invalidated.');
                    if (md === 'reject') return Promise.reject(new Error('IO error'));
                    if (md === 'hang') return new Promise(function() {});
                    return Promise.resolve(undefined);
                };
            })(mode, broken) });
            var m = await load({ platform: P });
            var s = null;
            try { s = track(m.appBootCrumb('pre-chats', { n: 3 })); } catch (e) { assert.fail(mode + ': appBootCrumb threw ' + e.message); }
            await m.clock.advance(mode === 'hang' ? 3000 : 0);
            assert.strictEqual(P.sets, 0, mode + ': no write after a failed read');
            assert.deepStrictEqual(P.store[KEY], prior, mode + ': the previous boot crumbs survive');
            assert.strictEqual(s.v, 'pending', mode + ': entry kept for a delayed retry');
            broken.on = false;
            await m.clock.advance(1000);
            assert.strictEqual(s.v, true, mode + ': written on the retry');
            assert.deepStrictEqual(phases(P), ['post-render', 'pre-chats'], mode + ': appended after the prior crumbs');
            assert.strictEqual(m.appBootCrumbState().spent, 2, mode + ': one failed + one good flush');
            assert.strictEqual(m.clock.timers.length, 0, mode + ': nothing left scheduled');
            assert.strictEqual(m.clock.errors.length, 0, mode + ': no timer callback threw');
        }
    });

    test('a failed or hung write drops its batch (resolves false, no duplicate re-write); later crumbs still land', async function() {
        var modes = ['throw', 'reject', 'hang'];
        for (var i = 0; i < modes.length; i++) {
            var mode = modes[i], broken = { on: true };
            var P = fakePlatform(null, { set: (function(md, br) {
                return function(p, data) {
                    if (!br.on) { p.write(data); return Promise.resolve(); }
                    if (md === 'throw') throw new Error('QUOTA_BYTES quota exceeded');
                    if (md === 'reject') return Promise.reject(new Error('quota'));
                    return new Promise(function() {});
                };
            })(mode, broken) });
            var m = await load({ platform: P });
            var s1 = track(m.appBootCrumb('pre-chats'));
            await m.clock.advance(3000);
            assert.strictEqual(s1.v, false, mode + ': a dropped batch resolves false');
            assert.strictEqual(P.sets, 1, mode + ': no re-write of a dropped batch');
            broken.on = false;
            var s2 = track(m.appBootCrumb('post-strip', { n: 1, kept: 1 }));
            await m.clock.advance(0);
            assert.strictEqual(s2.v, true, mode + ': the next crumb lands');
            assert.deepStrictEqual(phases(P), ['post-strip']);
            assert.strictEqual(m.clock.timers.length, 0, mode + ': nothing left scheduled');
        }
    });

    test('a Platform whose accessors throw is treated as not ready (no throw, bounded back-off, then dropped)', async function() {
        var evil = { storageSet: function() { return Promise.resolve(); } };
        Object.defineProperty(evil, 'storageGet', { get: function() { throw new Error('accessor'); } });
        var m = await load({ platform: evil });
        var s = track(m.appBootCrumb('script-start'));
        await m.clock.advance(60000);
        assert.strictEqual(s.v, false);
        assert.strictEqual(m.clock.timers.length, 0);
        assert.strictEqual(m.clock.errors.length, 0);
    });

    test('crumbs issued before Platform exists are buffered, then flushed in one write when it appears in the same task', async function() {
        var m = await load({});
        var s1 = track(m.appBootCrumb('script-start')), s2 = track(m.appBootCrumb('pre-chats', { n: 12 }));
        assert.strictEqual(m.appBootCrumbState().queued, 2, 'held in memory');
        var P = fakePlatform();
        m.setPlatform(P);   // platform-bridge is evaluated LAST in the page bundle, same task
        await m.clock.advance(0);
        assert.deepStrictEqual(phases(P), ['script-start', 'pre-chats']);
        assert.strictEqual(P.sets, 1, 'the buffer is flushed in one write');
        assert.strictEqual(m.clock.fired, 0, 'no back-off timer was needed (deferred to a microtask)');
        assert.strictEqual(m.appBootCrumbState().waits, 0);
        assert.strictEqual(s1.v, true);
        assert.strictEqual(s2.v, true);
    });

    test('a late Platform is picked up by the bounded back-off; one that never comes drops the buffer after 6 tries', async function() {
        var m = await load({});
        var s = track(m.appBootCrumb('script-start'));
        await m.clock.advance(0);
        assert.strictEqual(m.clock.timers.length, 1, 'a single back-off timer, not a loop');
        await m.clock.advance(400);   // tries at 10 ms and 110 ms: still no Platform
        assert.strictEqual(s.v, 'pending');
        var P = fakePlatform();
        m.setPlatform(P);
        await m.clock.advance(500);   // next try at 610 ms
        assert.strictEqual(s.v, true);
        assert.deepStrictEqual(phases(P), ['script-start']);
        assert.strictEqual(m.appBootCrumbState().waits, 3);

        var n = await load({});
        var s2 = track(n.appBootCrumb('script-start'));
        await n.clock.advance(60000);
        assert.strictEqual(s2.v, false, 'dropped after the bounded back-off');
        var st = n.appBootCrumbState();
        assert.strictEqual(st.waits, 6);
        assert.strictEqual(st.queued, 0);
        assert.strictEqual(st.dropped, 1);
        assert.strictEqual(n.clock.fired, 6, 'six back-off timers (10 ms .. 4 s), no tight loop');
        assert.strictEqual(n.clock.timers.length, 0, 'nothing left scheduled');
    });

    test('the in-memory buffer is capped at 40 too (oldest dropped, resolved false)', async function() {
        var m = await load({});
        var ss = [];
        for (var i = 0; i < 45; i++) ss.push(track(m.appBootCrumb('c' + i)));
        await m.clock.advance(0);
        assert.strictEqual(m.appBootCrumbState().queued, 40);
        assert.deepStrictEqual(ss.slice(0, 5).map(function(x) { return x.v; }), [false, false, false, false, false]);
        var P = fakePlatform();
        m.setPlatform(P);
        await m.clock.advance(10);
        assert.strictEqual(P.store[KEY].length, 40);
        assert.strictEqual(P.store[KEY][0].phase, 'c5');
        assert.strictEqual(ss[44].v, true);
    });

    test('at most 15 writes per boot; the last is reserved for boot-complete (ms auto-filled); later crumbs resolve false', async function() {
        var P = fakePlatform(), m = await load({ platform: P });
        for (var i = 0; i < 20; i++) { m.appBootCrumb('step-' + i); await m.clock.advance(0); }
        assert.strictEqual(P.sets, 14, 'one write held back for boot-complete');
        assert.strictEqual(m.appBootCrumbState().queued, 6, 'the rest wait in memory');
        var bc = track(m.appBootCrumb('boot-complete'));
        await m.clock.advance(0);
        assert.strictEqual(bc.v, true);
        assert.strictEqual(P.sets, 15);
        var ring = P.store[KEY];
        assert.strictEqual(ring.length, 21);
        assert.deepStrictEqual(ring.slice(-7).map(function(x) { return x.phase; }),
            ['step-14', 'step-15', 'step-16', 'step-17', 'step-18', 'step-19', 'boot-complete'], 'waiting crumbs ride along');
        assert.strictEqual(ring[20].ms, 1234, 'ms from performance.now()');
        var late = track(m.appBootCrumb('late'));
        await m.clock.advance(5000);
        assert.strictEqual(late.v, false, 'budget spent: resolves false at once');
        assert.strictEqual(P.sets, 15, 'no 16th write');
        assert.strictEqual(m.appBootCrumbState().spent, 15);
        assert.strictEqual(m.clock.timers.length, 0);

        var P2 = fakePlatform(), n = await load({ platform: P2 });
        n.appBootCrumb('boot-complete', { ms: 42 });
        await n.clock.advance(0);
        for (var j = 0; j < 30; j++) { n.appBootCrumb('after-' + j); await n.clock.advance(0); }
        assert.strictEqual(P2.sets, 15, 'an early boot-complete frees the reserve, still capped at 15');
        assert.strictEqual(P2.store[KEY][0].ms, 42, 'a caller-supplied numeric ms is kept');
        assert.strictEqual(P2.store[KEY].length, 15);
    });

    test('the full F1 + F6 phase sequence (11 crumbs) fits the budget even when every crumb flushes alone', async function() {
        var seq = ['script-start', 'pre-chats', 'chats-progress', 'chats-progress', 'chats-progress', 'chats-progress',
            'chats-progress', 'post-strip', 'post-subagents', 'post-render', 'boot-complete'];
        var P = fakePlatform(), m = await load({ platform: P });
        var ss = [];
        for (var i = 0; i < seq.length; i++) { ss.push(track(m.appBootCrumb(seq[i], { n: i }))); await m.clock.advance(0); }
        assert.deepStrictEqual(phases(P), seq);
        assert.strictEqual(P.sets, 11);
        assert.ok(ss.every(function(x) { return x.v === true; }), 'every crumb resolved true');
        assert.strictEqual(typeof P.store[KEY][10].ms, 'number');
    });

    test('writes are serialized in-context and queued crumbs coalesce: no lost update', async function() {
        var gates = [];
        var P = fakePlatform(null, { get: function(p, keys) {
            var d = deferred();
            gates.push(d);
            return d.promise.then(function() { return p.read(keys); });
        } });
        var m = await load({ platform: P });
        m.appBootCrumb('a');
        await m.clock.advance(0);
        assert.strictEqual(P.gets, 1);
        m.appBootCrumb('b');
        m.appBootCrumb('c');
        await m.clock.advance(0);
        assert.strictEqual(P.gets, 1, 'no second read-modify-write while one is in flight');
        assert.strictEqual(m.appBootCrumbState().busy, true);
        gates[0].resolve();
        await m.clock.advance(0);
        assert.strictEqual(P.gets, 2, 'b + c ride ONE read-modify-write');
        m.appBootCrumb('d');
        gates[1].resolve();
        await m.clock.advance(0);
        gates[2].resolve();
        await m.clock.advance(0);
        assert.deepStrictEqual(phases(P), ['a', 'b', 'c', 'd']);
        assert.deepStrictEqual(P.events, ['get', 'set', 'get', 'set', 'get', 'set'], 'strictly alternating get/set');
        assert.deepStrictEqual(P.writes.map(function(w) { return w[KEY].length; }), [1, 3, 4]);
        assert.strictEqual(m.appBootCrumbState().queued, 0);
    });

    test('also loads through loadModules (fake Platform/performance/setTimeout)', async function() {
        var P = fakePlatform(), clock = fakeClock();
        var m = await loadModules([SRC], { globals: { Platform: P, performance: { now: function() { return 7; } },
            setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } });
        assert.strictEqual(typeof m.appBootCrumb, 'function');
        assert.strictEqual(m.BOOT_CRUMBS_KEY, KEY);
        var s = track(m.appBootCrumb('boot-complete'));
        await clock.advance(0);
        assert.strictEqual(s.v, true);
        assert.strictEqual(P.store[KEY][0].ms, 7);
        assert.strictEqual(P.store[KEY][0].ctx, 'page');
    });
});

describe('F6 boot crumbs (page): call sites', function() {
    var GUARD = "if (typeof appBootCrumb === 'function') { try { appBootCrumb(";
    function stripComments(s) {
        return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
    }
    function count(hay, needle) { return hay.split(needle).length - 1; }
    // GUARD ends with 'appBootCrumb(' which is also where call begins: the guard must end the
    // text right before the call's phase argument.
    function guarded(src, call) {
        var i = src.indexOf(call), g = i - GUARD.length + 'appBootCrumb('.length;
        return i > 0 && g >= 0 && src.slice(g, g + GUARD.length) === GUARD;
    }

    test('core/015 writes only through Platform.storageGet/storageSet (no chrome.* call site)', async function() {
        var src = stripComments(await loadFile('src/js/core/015-boot-crumbs.js'));
        assert.strictEqual(src.indexOf('chrome.'), -1, 'no chrome API in code');
        assert.match(src, /\.storageGet\(/);
        assert.match(src, /\.storageSet\(/);
    });

    test('core/120-init: post-subagents, post-render, boot-complete each once, guarded, never awaited, in boot order', async function() {
        var src = await loadFile('src/js/core/120-init.js');
        ['post-subagents', 'post-render', 'boot-complete'].forEach(function(ph) {
            var call = "appBootCrumb('" + ph + "'";
            assert.strictEqual(count(src, call), 1, ph + ' logged once');
            assert.ok(guarded(src, call), ph + ' is typeof-guarded inside try');
        });
        assert.ok(!/await\s+appBootCrumb/.test(src), 'never awaited');
        var iSub = src.indexOf("appBootCrumb('post-subagents'"), iRender = src.indexOf("appBootCrumb('post-render'"),
            iDone = src.indexOf("appBootCrumb('boot-complete'");
        assert.ok(src.indexOf('await SubAgents.loadAll()') < iSub && iSub < src.indexOf('cleanupStaleWorkspaces();', src.indexOf('await SubAgents.loadAll()')),
            'post-subagents right after the SubAgents.loadAll block');
        var before = src.slice(iRender - 300, iRender);
        assert.ok(before.indexOf('renderChatList();') >= 0 && before.indexOf('updateModelDisplay();') >= 0, 'post-render follows the first render');
        assert.ok(iRender < src.indexOf('var deepLinkChatId'), 'post-render precedes the chat deep-link');
        assert.ok(iSub < iRender && iRender < iDone, 'boot order');
        assert.ok(src.lastIndexOf('openHomeView();', iDone) > src.indexOf('var deepLinkChatId'), 'boot-complete follows the PHASE 3 view chain');
        assert.ok(iDone < src.indexOf('var deepLinkWidgetId'), 'boot-complete precedes the widget deep-link early return');
        assert.ok(iDone < src.indexOf('var deepLinkDocId'), 'boot-complete precedes the doc deep-link early return');
        assert.match(src, /\n {4}if \(typeof appBootCrumb === 'function'\) \{ try \{ appBootCrumb\('boot-complete'\)/, 'boot-complete sits at init top level, not in a branch');
    });

    test('app/070-app-tab-ready: script-start logged once, typeof-guarded, after the tab boot record', async function() {
        var src = await loadFile('src/js/app/070-app-tab-ready.js');
        var call = "appBootCrumb('script-start'";
        assert.strictEqual(count(src, call), 1);
        assert.ok(guarded(src, call), 'typeof-guarded inside try');
        assert.ok(src.indexOf('sessionStorage.setItem(') < src.indexOf(call), 'after the sessionStorage boot record');
    });

    test('app/070 IIFE hands script-start {nav, readyBootId} to appBootCrumb and survives a throwing one', async function() {
        var code = await loadFile('src/js/app/070-app-tab-ready.js');
        function run(crumb) {
            var r = { sent: [], calls: [], backing: {} };
            var ss = {
                getItem: function(k) { return Object.prototype.hasOwnProperty.call(r.backing, k) ? r.backing[k] : null; },
                setItem: function(k, v) { r.backing[k] = String(v); }
            };
            var chrome = { runtime: { sendMessage: function(msg) { r.sent.push(JSON.parse(JSON.stringify(msg))); } } };
            var perf = { getEntriesByType: function(t) { return t === 'navigation' ? [{ type: 'reload' }] : []; } };
            var spy = function(phase, extra) {
                r.calls.push({ phase: phase, extra: JSON.parse(JSON.stringify(extra)), records: Object.keys(r.backing).length });
                return crumb(phase, extra);
            };
            new Function('chrome', 'sessionStorage', 'performance', 'setTimeout', 'Date', 'Math', 'appBootCrumb', code)(
                chrome, ss, perf, function() { return 1; }, { now: function() { return T0_070; } }, { random: function() { return 0.5; } }, spy);
            return r;
        }
        var T0_070 = 1700000000000;
        var ok = run(function() { return Promise.resolve(true); });
        assert.strictEqual(ok.calls.length, 1);
        assert.strictEqual(ok.calls[0].phase, 'script-start');
        assert.strictEqual(ok.sent.length, 1, 'app-tab-ready sent once');
        assert.deepStrictEqual(ok.calls[0].extra, { nav: 'reload', readyBootId: ok.sent[0].bootId });
        assert.strictEqual(ok.calls[0].records, 1, 'called after the sessionStorage boot record');
        var boom = run(function() { throw new Error('crumb'); });
        assert.strictEqual(boom.sent.length, 1, 'a throwing appBootCrumb does not stop app-tab-ready');
        assert.strictEqual(Object.keys(boom.backing).length, 1, 'boot record still written');
    });
});
