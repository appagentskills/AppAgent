// F6 (Boot OOM fix, SW half) — boot breadcrumbs persisted by the service
// worker: worker/185-boot-crumbs-sw.js (swBootCrumb, ring key
// appagentBootCrumbsSW) and its three guarded call sites in
// worker/190-entry.js (sw-start, sw-loaders-done, sw-boot-error).
// Runs the REAL modules against an in-memory chrome.storage.local, a fake
// _reopenStorageSet (the background.js write path) and fake timers: a timer
// only fires when a test calls timers.fire() (settle() does so between
// microtask rounds, i.e. for steps that hang), so no test waits on real time.
describe('F6 SW boot crumbs: swBootCrumb ring (worker/185-boot-crumbs-sw.js)', function() {
    var KEY = 'appagentBootCrumbsSW';
    var MOD = 'src/js/worker/185-boot-crumbs-sw.js';
    function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
    async function flush(n) { for (var i = 0; i < (n || 300); i++) await Promise.resolve(); }
    function phases(ring) { return (ring || []).map(function(x) { return x.phase; }); }
    function fakeTimers() {
        var t = { list: [], armed: [], seq: 0 };
        t.setTimeout = function(fn, ms) { var id = ++t.seq; t.list.push({ id: id, fn: fn, ms: ms }); t.armed.push(ms); return id; };
        t.clearTimeout = function(id) { t.list = t.list.filter(function(x) { return x.id !== id; }); };
        t.fire = function() { var l = t.list; t.list = []; l.forEach(function(x) { x.fn(); }); return l.length; };
        return t;
    }
    // {done, rejected, value} of p; between microtask rounds fires the fake
    // timers still pending (the bounds of hanging steps) unless opts.noFire.
    async function settle(p, timers, opts) {
        var st = { done: false, rejected: false, value: undefined };
        Promise.resolve(p).then(function(v) { st.done = true; st.value = v; }, function(err) { st.done = true; st.rejected = true; st.value = err; });
        for (var i = 0; i < 40 && !st.done; i++) {
            await flush(300);
            if (!st.done && timers && !(opts && opts.noFire)) timers.fire();
        }
        return st;
    }
    // Calls swBootCrumb, asserting it neither throws nor (after settling) rejects.
    async function crumb(e, phase, extra) {
        var p, threw = null;
        try { p = e.m.swBootCrumb(phase, extra); } catch (x) { threw = x; }
        assert.strictEqual(threw, null, 'swBootCrumb threw: ' + threw);
        var st = await settle(p, e.timers);
        assert.strictEqual(st.done, true, 'swBootCrumb promise settled');
        assert.strictEqual(st.rejected, false, 'swBootCrumb promise never rejects');
        return st;
    }
    // e.getMode / e.setMode: 'ok' | 'throw' (sync) | 'reject' | 'hang' | 'none'
    // (get answers undefined). opts.store is shared across loads = SW restarts.
    async function loadCrumbs(opts) {
        opts = opts || {};
        var e = { store: opts.store || {}, gets: 0, sets: [], setMs: [], directSets: 0, timers: fakeTimers(), getMode: 'ok', setMode: 'ok' };
        e.read = function(key) { var out = {}; if (Object.prototype.hasOwnProperty.call(e.store, key)) out[key] = clone(e.store[key]); return out; };
        var local = {
            get: function(key) {
                e.gets++;
                if (opts.get) return opts.get(key, e);
                if (e.getMode === 'throw') throw new Error('get threw');
                if (e.getMode === 'reject') return Promise.reject(new Error('get rejected'));
                if (e.getMode === 'hang') return new Promise(function() {});
                if (e.getMode === 'none') return Promise.resolve(undefined);
                return Promise.resolve(e.read(key));
            },
            // Never used: every write goes through _reopenStorageSet.
            set: function() { e.directSets++; return Promise.resolve(); }
        };
        var globals = {
            window: {},
            setTimeout: e.timers.setTimeout,
            clearTimeout: e.timers.clearTimeout,
            chrome: opts.noChrome ? undefined : { storage: { local: local } },
            _reopenStorageSet: opts.noSet ? undefined : function(obj, ms) {
                e.setMs.push(ms);
                if (e.setMode === 'throw') throw new Error('set threw');
                if (e.setMode === 'reject') return Promise.reject(new Error('set rejected'));
                if (e.setMode === 'hang') return new Promise(function() {});
                Object.keys(obj).forEach(function(k) { e.store[k] = clone(obj[k]); });
                e.sets.push(clone(obj));
                return Promise.resolve();
            }
        };
        e.m = await loadModules([MOD], { globals: globals });
        return e;
    }
    function oldRing(n) {
        var out = [];
        for (var i = 0; i < n; i++) out.push({ bootId: 'sw-old', ctx: 'sw', phase: 'p' + i, t: i });
        return out;
    }

    test('appends {bootId, ctx:sw, phase, t, ...extra} newest last, via _reopenStorageSet with an explicit ms', async function() {
        var e = await loadCrumbs();
        assert.deepStrictEqual(e.m.__unstubbed, []);
        await crumb(e, 'sw-start');
        await crumb(e, 'sw-loaders-done', { chats: 3, docs: 1, subs: 0, phase: 'x', t: 5, ctx: 'page', bootId: 'b' });
        var ring = e.store[KEY];
        assert.deepStrictEqual(phases(ring), ['sw-start', 'sw-loaders-done']);
        assert.match(ring[0].bootId, /^sw-/);
        assert.strictEqual(ring[1].bootId, ring[0].bootId, 'one bootId per SW boot');
        assert.strictEqual(ring[0].ctx, 'sw');
        assert.strictEqual(typeof ring[0].t, 'number');
        assert.strictEqual(ring[1].chats, 3);
        assert.strictEqual(ring[1].docs, 1);
        assert.strictEqual(ring[1].subs, 0);
        assert.deepStrictEqual([ring[1].x_phase, ring[1].x_t, ring[1].x_ctx, ring[1].x_bootId, ring[1].ctx], ['x', 5, 'page', 'b', 'sw'], 'reserved keys are never overwritten by extra');
        assert.deepStrictEqual(e.setMs, [3000, 3000], 'explicit ms on every _reopenStorageSet call');
        assert.strictEqual(e.directSets, 0, 'no direct chrome.storage.local write');
        assert.ok(e.timers.armed.length >= 4, 'get and set are both bounded');
        e.timers.armed.forEach(function(ms) { assert.ok(typeof ms === 'number' && ms > 0, 'timer armed with explicit ms: ' + ms); });
    }, { tags: ['unit'], timeout: 5000 });

    test('the ring is capped at 40 (oldest dropped); a non-array stored value is replaced', async function() {
        var e = await loadCrumbs({ store: {} });
        e.store[KEY] = oldRing(39);
        await crumb(e, 'a');
        await crumb(e, 'b');
        await crumb(e, 'c');
        var ring = e.store[KEY];
        assert.strictEqual(ring.length, 40);
        assert.strictEqual(ring[0].phase, 'p2');
        assert.deepStrictEqual(phases(ring).slice(-3), ['a', 'b', 'c']);
        var e2 = await loadCrumbs({ store: {} });
        e2.store[KEY] = oldRing(40);
        for (var i = 0; i < 6; i++) await crumb(e2, 'n' + i);
        assert.strictEqual(e2.store[KEY].length, 40);
        assert.deepStrictEqual(phases(e2.store[KEY]).slice(-6), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
        assert.strictEqual(e2.store[KEY][0].phase, 'p6');
        var e3 = await loadCrumbs({ store: {} });
        e3.store[KEY] = 'garbage';
        await crumb(e3, 'fresh');
        assert.deepStrictEqual(phases(e3.store[KEY]), ['fresh']);
    }, { tags: ['unit'], timeout: 5000 });

    test('at most 6 crumbs per SW boot; a burst is coalesced into ONE get -> set; a new boot gets a new bootId and budget', async function() {
        var store = {};
        var e = await loadCrumbs({ store: store });
        var ps = [], threw = null;
        try { for (var i = 0; i < 10; i++) ps.push(e.m.swBootCrumb('c' + i)); } catch (x) { threw = x; }
        assert.strictEqual(threw, null);
        var st = await settle(Promise.all(ps), e.timers);
        assert.strictEqual(st.done && !st.rejected, true);
        assert.deepStrictEqual(phases(store[KEY]), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
        assert.strictEqual(e.sets.length, 1, 'burst coalesced into one write');
        assert.strictEqual(e.gets, 1);
        await crumb(e, 'late-1');
        await crumb(e, 'late-2');
        assert.strictEqual(e.sets.length, 1, 'no write beyond the per-boot cap');
        assert.strictEqual(store[KEY].length, 6);
        var e2 = await loadCrumbs({ store: store });
        for (var j = 0; j < 8; j++) await crumb(e2, 'r' + j);
        assert.ok(e2.sets.length <= 6, 'at most 6 writes per boot: ' + e2.sets.length);
        var ring = store[KEY];
        assert.strictEqual(ring.length, 12);
        assert.deepStrictEqual(phases(ring).slice(6), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
        assert.notStrictEqual(ring[6].bootId, ring[0].bootId, 'new boot, new bootId');
    }, { tags: ['unit'], timeout: 5000 });

    test('writes are serialized: a crumb arriving mid-flush waits for it, then re-reads the ring (no lost update)', async function() {
        var release = null;
        var e = await loadCrumbs({ get: function(key, env) {
            if (env.gets === 1) return new Promise(function(r) { release = function() { r(env.read(key)); }; });
            return Promise.resolve(env.read(key));
        } });
        var pA = e.m.swBootCrumb('a');
        await flush(100);
        assert.strictEqual(e.gets, 1, 'first flush is parked on its get');
        var pB = e.m.swBootCrumb('b');
        await flush(100);
        assert.strictEqual(e.gets, 1, 'second flush waits for the first');
        release();
        var st = await settle(Promise.all([pA, pB]), e.timers, { noFire: true });
        assert.strictEqual(st.done && !st.rejected, true);
        assert.strictEqual(e.sets.length, 2);
        assert.deepStrictEqual(phases(e.sets[0][KEY]), ['a']);
        assert.deepStrictEqual(phases(e.sets[1][KEY]), ['a', 'b']);
    }, { tags: ['unit'], timeout: 5000 });

    test('get that throws / rejects / hangs / answers no object: never throws or rejects, never overwrites, chain moves on', async function() {
        var modes = ['throw', 'reject', 'hang', 'none'];
        for (var i = 0; i < modes.length; i++) {
            var e = await loadCrumbs({ store: {} });
            e.store[KEY] = oldRing(2);
            e.getMode = modes[i];
            await crumb(e, 'lost-' + modes[i]);
            assert.strictEqual(e.sets.length, 0, modes[i] + ': no write after a failed read');
            assert.deepStrictEqual(phases(e.store[KEY]), ['p0', 'p1'], modes[i] + ': stored ring untouched');
            e.getMode = 'ok';
            await crumb(e, 'next');
            assert.deepStrictEqual(phases(e.store[KEY]), ['p0', 'p1', 'next'], modes[i] + ': the next crumb still lands');
        }
    }, { tags: ['unit'], timeout: 10000 });

    test('_reopenStorageSet that throws / rejects / hangs, or is missing, or chrome is missing: never throws or rejects', async function() {
        var modes = ['throw', 'reject', 'hang'];
        for (var i = 0; i < modes.length; i++) {
            var e = await loadCrumbs();
            e.setMode = modes[i];
            await crumb(e, 'dropped');
            assert.strictEqual(e.store[KEY], undefined, modes[i] + ': nothing stored');
            e.setMode = 'ok';
            await crumb(e, 'next');
            assert.deepStrictEqual(phases(e.store[KEY]), ['next'], modes[i] + ': chain moved on');
            e.setMs.forEach(function(ms) { assert.strictEqual(ms, 3000); });
        }
        var noSet = await loadCrumbs({ noSet: true });
        await crumb(noSet, 'x');
        assert.strictEqual(noSet.gets, 0);
        var noChrome = await loadCrumbs({ noChrome: true });
        await crumb(noChrome, 'x');
        assert.strictEqual(noChrome.setMs.length, 0);
    }, { tags: ['unit'], timeout: 10000 });

    test('unserializable and oversized extras are recorded safely', async function() {
        var e = await loadCrumbs();
        var circ = { a: 1 };
        circ.loop = circ;
        await crumb(e, 'circ', circ);
        await crumb(e, 'big', { s: new Array(3000).join('x') });
        await crumb(e, 'num', 7);
        var ring = e.store[KEY];
        assert.strictEqual(ring[0].unserializable, true);
        assert.strictEqual(ring[1].truncated, true);
        assert.strictEqual(typeof ring[1].extra, 'string');
        assert.ok(ring[1].extra.length <= 400);
        assert.strictEqual(ring[2].extra, 7);
    }, { tags: ['unit'], timeout: 5000 });

    test('real background.js _reopenCall/_reopenStorageSet at importScripts time (REOPEN_APP_TAB_CALL_MS unset): ring lands, no timer armed without ms', async function() {
        function extractFn(text, sig) {
            var a = text.indexOf(sig);
            if (a < 0) throw new Error('background.js no longer defines ' + sig + ' (worker/185 writes through it)');
            var depth = 0;
            for (var i = text.indexOf('{', a); i < text.length; i++) {
                if (text[i] === '{') depth++;
                else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(a, i + 1); }
            }
            throw new Error('unterminated ' + sig);
        }
        var bg = await loadFile('src/platform/extension/background.js');
        var fns = extractFn(bg, 'function _reopenCall(') + '\n' + extractFn(bg, 'function _reopenStorageSet(');
        var timers = fakeTimers(), store = {};
        var local = {
            get: function(key) { var out = {}; if (key in store) out[key] = clone(store[key]); return Promise.resolve(out); },
            set: function(obj) { Object.keys(obj).forEach(function(k) { store[k] = clone(obj[k]); }); return Promise.resolve(); }
        };
        var ns = await evalModules([await loadFile(MOD), fns], [MOD, 'background.js _reopenCall + _reopenStorageSet'], { globals: {
            window: {}, chrome: { storage: { local: local } }, REOPEN_APP_TAB_CALL_MS: undefined,
            setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
        } });
        assert.strictEqual(typeof ns._reopenStorageSet, 'function');
        var st = await settle(ns.swBootCrumb('sw-start'), timers, { noFire: true });
        assert.strictEqual(st.done && !st.rejected, true);
        assert.deepStrictEqual(phases(store[KEY]), ['sw-start']);
        assert.ok(timers.armed.length >= 3, 'get bound, set bound and _reopenCall timer: ' + JSON.stringify(timers.armed));
        timers.armed.forEach(function(ms) { assert.ok(typeof ms === 'number' && ms > 0, 'timer armed without an explicit ms: ' + ms); });
    }, { tags: ['unit'], timeout: 5000 });
});

describe('F6 SW boot crumbs: worker/190-entry.js call sites', function() {
    var KEY = 'appagentBootCrumbsSW';
    function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
    async function flush(n) { for (var i = 0; i < (n || 300); i++) await Promise.resolve(); }
    function phases(ring) { return (ring || []).map(function(x) { return x.phase; }); }
    async function settled(p) {
        var st = { done: false, rejected: false };
        Promise.resolve(p).then(function() { st.done = true; }, function() { st.done = true; st.rejected = true; });
        for (var i = 0; i < 40 && !st.done; i++) await flush(300);
        return st;
    }
    // Evaluates the real 190-entry (with the real 185 unless withModule:false)
    // over stubbed loaders. Timers never fire (loaders answer at once).
    async function bootEntry(opts) {
        opts = opts || {};
        var e = { store: {}, setMs: [], settles: 0, errors: [] };
        var win = { _settleResumeScan: function() { e.settles++; } };
        var noop = function() {};
        var globals = {
            window: win,
            console: { log: noop, info: noop, warn: noop, error: function() { e.errors.push([].slice.call(arguments)); } },
            setTimeout: function() { return 0; },
            clearTimeout: noop,
            chrome: { storage: { local: { get: function(key) { var out = {}; if (key in e.store) out[key] = clone(e.store[key]); return Promise.resolve(out); } } } },
            _reopenStorageSet: function(obj, ms) { e.setMs.push(ms); Object.keys(obj).forEach(function(k) { e.store[k] = clone(obj[k]); }); return Promise.resolve(); },
            loadChatsFromStorage: function() { return Promise.resolve(); },
            loadApiProviders: function() { return Promise.resolve(); },
            Platform: { ready: Promise.resolve() },
            listRunningAgentCheckpoints: opts.listReject
                ? function() { return Promise.reject(new Error('boom')); }
                : function() { return Promise.resolve([]); },
            chats: { c1: {}, c2: {}, c3: {} },
            smartDocuments: { d1: {} },
            SubAgents: { loadAll: function() { return Promise.resolve(); }, listAll: function() { return [{}, {}]; } },
            _chatsHydrated: true
        };
        if (opts.crumb) globals.swBootCrumb = opts.crumb;
        var files = opts.withModule === false ? ['src/js/worker/190-entry.js'] : ['src/js/worker/185-boot-crumbs-sw.js', 'src/js/worker/190-entry.js'];
        e.m = await loadModules(files, { globals: globals });
        e.ready = await settled(win._swBootReady);
        for (var i = 0; i < 20 && e.settles === 0; i++) await flush(300);
        if (e.m.__scope._swBootCrumbChain) await settled(e.m.__scope._swBootCrumbChain);
        e.ring = e.store[KEY] || [];
        return e;
    }

    test('clean boot: sw-start then sw-loaders-done {chats, docs, subs}; gate opens, scan settles', async function() {
        var e = await bootEntry();
        assert.strictEqual(e.ready.done && !e.ready.rejected, true, 'boot gate resolved');
        assert.strictEqual(e.settles, 1, 'resume scan settled once');
        assert.deepStrictEqual(phases(e.ring), ['sw-start', 'sw-loaders-done']);
        assert.strictEqual(e.ring[0].ctx, 'sw');
        assert.strictEqual(e.ring[1].bootId, e.ring[0].bootId);
        assert.deepStrictEqual([e.ring[1].chats, e.ring[1].docs, e.ring[1].subs, e.ring[1].hydrated], [3, 1, 2, true]);
        e.setMs.forEach(function(ms) { assert.strictEqual(ms, 3000); });
        assert.deepStrictEqual(e.errors, []);
    }, { tags: ['unit'], timeout: 10000 });

    test('failed resume scan (.catch): exactly one sw-boot-error crumb; gate still open, scan still settled', async function() {
        var e = await bootEntry({ listReject: true });
        assert.strictEqual(e.ready.done && !e.ready.rejected, true);
        assert.strictEqual(e.settles, 1);
        assert.deepStrictEqual(phases(e.ring), ['sw-start', 'sw-loaders-done', 'sw-boot-error']);
        assert.strictEqual(e.ring[2].err, 'boom');
        assert.strictEqual(e.errors.length, 1, 'boot/resume error logged once');
    }, { tags: ['unit'], timeout: 10000 });

    test('a throwing swBootCrumb never breaks boot (clean and failing scan)', async function() {
        var calls = [];
        var boom = function(phase) { calls.push(phase); throw new Error('crumb exploded'); };
        var e = await bootEntry({ withModule: false, crumb: boom });
        assert.strictEqual(e.ready.done && !e.ready.rejected, true);
        assert.strictEqual(e.settles, 1);
        assert.deepStrictEqual(calls, ['sw-start', 'sw-loaders-done']);
        calls = [];
        var e2 = await bootEntry({ withModule: false, crumb: boom, listReject: true });
        assert.strictEqual(e2.ready.done && !e2.ready.rejected, true);
        assert.strictEqual(e2.settles, 1);
        assert.deepStrictEqual(calls, ['sw-start', 'sw-loaders-done', 'sw-boot-error']);
    }, { tags: ['unit'], timeout: 10000 });

    test('without the crumb module (swBootCrumb undefined) boot is unchanged', async function() {
        var e = await bootEntry({ withModule: false });
        assert.strictEqual(e.ready.done && !e.ready.rejected, true);
        assert.strictEqual(e.settles, 1);
        assert.ok(e.m.__unstubbed.indexOf('swBootCrumb') >= 0, 'guarded by a typeof probe');
        assert.deepStrictEqual(e.ring, []);
    }, { tags: ['unit'], timeout: 10000 });

    test('wiring: three call sites, each typeof-guarded and wrapped in try', async function() {
        var src = await loadFile('src/js/worker/190-entry.js');
        var re = /swBootCrumb\('([\w-]+)'/g, m, found = [];
        while ((m = re.exec(src))) {
            found.push(m[1]);
            var before = src.slice(Math.max(0, m.index - 140), m.index);
            assert.ok(/if \(typeof swBootCrumb === 'function'\) \{\s*try \{\s*$/.test(before), 'guarded call site: ' + m[1]);
        }
        assert.deepStrictEqual(found, ['sw-start', 'sw-loaders-done', 'sw-boot-error']);
    }, { tags: ['unit'], timeout: 5000 });
});
