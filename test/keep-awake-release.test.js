// H17 — keep-awake display lock leak.
// The OS display lock was only released on runFinished/runCrashed. Bulk
// clears of runningChatIds (port drop, hello reconcile, 15s safety settle)
// emit neither, so the lock (and its 20s heartbeat) stayed on forever.
// "Disable this session" also left the lock on while a run was active.
// These tests load the REAL app/060-keep-awake.js (and app/045 for the
// wiring) with in-memory stubs for chrome / DOM / timers.

function makeKeepAwakeEnv() {
    var sent = [];
    var intervals = [];
    var timeouts = [];
    var clock = { now: 0 };            // fake clock for advance() (appCleanReload tests)
    var handlers = {};
    var runningChatIds = {};
    var clicks = {};
    function el() {
        var e = {
            className: '', innerHTML: '', parentNode: null, offsetWidth: 1,
            classList: { add: function() {}, remove: function() {} },
            addEventListener: function() {},
            contains: function() { return false; },
            querySelector: function(sel) {
                return { addEventListener: function(type, fn) { if (type === 'click') clicks[sel] = fn; } };
            }
        };
        return e;
    }
    var doc = {
        readyState: 'complete', hidden: false,
        getElementById: function() { return null; },
        createElement: function() { return el(); },
        head: { appendChild: function() {} },
        body: { appendChild: function(c) { c.parentNode = doc.body; }, removeChild: function() {} },
        _listeners: {},
        addEventListener: function(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
        removeEventListener: function(type, fn) { var l = doc._listeners[type] || []; var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    };
    var win = fakeWindow();
    // RELOAD-ZOMBIE: reload counters + per-type responders (default: {ok:true}, synchronously).
    var reloads = { runtime: 0, page: 0 };
    var responders = {};
    win.location.reload = function() { reloads.page++; };
    var chrome = {
        runtime: {
            lastError: undefined,
            sendMessage: function(msg, cb) {
                sent.push(msg);
                if (msg && responders[msg.type]) return responders[msg.type](msg, cb);
                if (typeof cb === 'function') cb({ ok: true });
            },
            reload: function() { reloads.runtime++; }
        }
    };
    var AgentEvents = {
        on: function(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
        emit: function(t, d) { (handlers[t] || []).forEach(function(fn) { fn(d); }); }
    };
    var globals = {
        chrome: chrome, document: doc, window: win, AgentEvents: AgentEvents,
        runningChatIds: runningChatIds,
        getSetting: async function(k, d) { return d; }, setSetting: function() {},
        // Fake timers: `at` = fake-clock time when armed; clearTimeout marks the record `cleared`.
        setTimeout: function(fn, ms) { timeouts.push({ fn: fn, ms: ms, at: clock.now }); return timeouts.length; },
        clearTimeout: function(id) { if (timeouts[id - 1]) timeouts[id - 1].cleared = true; },
        setInterval: function(fn, ms) { intervals.push({ fn: fn, ms: ms, live: true }); return intervals.length; },
        clearInterval: function(id) { if (intervals[id - 1]) intervals[id - 1].live = false; },
        console: { log: function() {}, table: function() {}, warn: function() {}, error: function() {} }
    };
    return {
        globals: globals, win: win, sent: sent, intervals: intervals, clicks: clicks,
        timeouts: timeouts, clock: clock, reloads: reloads, doc: doc, respond: function(type, fn) { responders[type] = fn; },
        runningChatIds: runningChatIds, AgentEvents: AgentEvents,
        lastSent: function() { var s = sent.filter(function(m) { return m.type === 'keep-awake-set'; }); return s.length ? s[s.length - 1].enabled : undefined; },
        status: function() { return win.keepAwakeStatus(); },
        startRun: function(cid) { runningChatIds[cid] = true; AgentEvents.emit('runStarted', { chatId: cid }); }
    };
}

async function loadKeepAwake() {
    var env = makeKeepAwakeEnv();
    await loadModules(['src/js/app/060-keep-awake.js'], { globals: env.globals });
    // init() is async (awaits getSetting) — let it finish attaching listeners.
    for (var i = 0; i < 5; i++) await Promise.resolve();
    return env;
}

describe('H17 keep-awake: lock follows runningChatIds bulk clears', function() {
    test('port-drop style bulk clear + reconcile releases the lock', async function() {
        var env = await loadKeepAwake();
        env.startRun('c1');
        assert.strictEqual(env.status().lockActive, true, 'run acquires lock');
        assert.strictEqual(env.lastSent(), true);
        // 045 onDisconnect: wipes runningChatIds without emitting runFinished.
        delete env.runningChatIds.c1;
        assert.strictEqual(typeof env.win.keepAwakeReconcileRuns, 'function', 'reconcile hook exposed');
        env.win.keepAwakeReconcileRuns();
        assert.strictEqual(env.status().lockActive, false, 'lock released after bulk clear');
        assert.strictEqual(env.lastSent(), false, 'SW told to release');
        assert.strictEqual(env.status().heartbeatRunning, false, 'heartbeat stopped');
    }, { tags: ['unit'], timeout: 3000 });

    test('hello reconcile-up re-acquires the lock (transient flap does not regress)', async function() {
        var env = await loadKeepAwake();
        env.startRun('c1');
        delete env.runningChatIds.c1;
        env.win.keepAwakeReconcileRuns();
        assert.strictEqual(env.status().lockActive, false);
        // hello reports the SW is still running c1.
        env.runningChatIds.c1 = true;
        env.win.keepAwakeReconcileRuns();
        assert.strictEqual(env.status().lockActive, true, 'lock back on for a still-live run');
        assert.deepStrictEqual(env.status().runningChats, ['c1']);
        // Normal terminal event still releases it.
        delete env.runningChatIds.c1;
        env.AgentEvents.emit('runFinished', { chatId: 'c1' });
        assert.strictEqual(env.status().lockActive, false);
    }, { tags: ['unit'], timeout: 3000 });

    test('heartbeat backstop drops a run cleared without any event', async function() {
        var env = await loadKeepAwake();
        env.startRun('c1');
        var hb = env.intervals.filter(function(t) { return t.live; });
        assert.strictEqual(hb.length, 1, 'heartbeat armed');
        delete env.runningChatIds.c1; // e.g. a clear site that forgot to reconcile
        var before = env.sent.length;
        hb[0].fn();
        assert.strictEqual(env.status().lockActive, false, 'heartbeat reconciled and released');
        assert.strictEqual(env.lastSent(), false);
        assert.ok(env.sent.slice(before).every(function(m) { return m.enabled === false; }), 'no re-assert after release');
    }, { tags: ['unit'], timeout: 3000 });

    test('partial shrink keeps the lock while another run is live', async function() {
        var env = await loadKeepAwake();
        env.startRun('c1');
        env.startRun('c2');
        delete env.runningChatIds.c1;
        env.win.keepAwakeReconcileRuns();
        assert.strictEqual(env.status().lockActive, true);
        assert.deepStrictEqual(env.status().runningChats, ['c2']);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('H17 keep-awake: "Disable this session" releases unconditionally', function() {
    test('session disable releases the lock even while a run is active', async function() {
        var env = await loadKeepAwake();
        env.win.keepAwakeForceOn(); // idle path -> notice shown
        assert.strictEqual(typeof env.clicks['.ka-session'], 'function', 'notice rendered');
        env.startRun('c1');
        assert.strictEqual(env.status().lockActive, true);
        env.clicks['.ka-session']();
        assert.strictEqual(env.status().sessionDisabled, true);
        assert.strictEqual(env.status().lockActive, false, 'lock released despite active run');
        assert.strictEqual(env.lastSent(), false);
        // A new run later this session does not re-acquire it.
        env.startRun('c2');
        assert.strictEqual(env.status().lockActive, false);
        env.win.keepAwakeReconcileRuns();
        assert.strictEqual(env.status().lockActive, false);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('H17 port bridge (045) calls the keep-awake reconcile hook', function() {
    test('onDisconnect clear and 15s safety settle both reconcile', async function() {
        var ports = [];
        var timers = [];
        var reconciles = 0;
        var win = fakeWindow({ keepAwakeReconcileRuns: function() { reconciles++; } });
        var rc = { c1: true };
        var chrome = fakeChrome({ runtime: { connect: function(o) {
            var p = { name: o && o.name, postMessage: function() {}, disconnect: function() {},
                onMessage: { addListener: function() {} },
                onDisconnect: { _l: [], addListener: function(fn) { this._l.push(fn); } } };
            ports.push(p); return p;
        } } });
        var m = await loadModules(['src/js/app/045-agent-port-bridge-page.js'], { lenient: true, globals: {
            chrome: chrome, window: win, runningChatIds: rc,
            setTimeout: function(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
            clearTimeout: function() {},
            console: { log: function() {}, warn: function() {}, error: function() {} }
        } });
        assert.strictEqual(typeof m._openAgentBus, 'function');
        m._openAgentBus();
        assert.ok(ports.length >= 1, 'bus port opened');
        var port = ports[ports.length - 1];
        var r0 = reconciles;
        port.onDisconnect._l.forEach(function(fn) { fn(); });
        assert.deepStrictEqual(Object.keys(rc), [], 'runningChatIds cleared on drop');
        assert.ok(reconciles > r0, 'keep-awake reconciled on port drop');
        var safety = timers.filter(function(t) { return t.ms >= 10000; });
        assert.strictEqual(safety.length, 1, '15s safety timer armed');
        var r1 = reconciles;
        safety[0].fn();
        assert.ok(reconciles > r1, 'keep-awake reconciled in 15s safety cleanup');
    }, { tags: ['unit'], timeout: 5000 });
});

describe('A8B-02 keep-awake: checkbox twins follow the setting', function() {
    // Gear #keep-awake-checkbox and Settings-page #settings-keep-awake stubs.
    async function loadWithBoxes() {
        var env = makeKeepAwakeEnv();
        var boxes = { 'keep-awake-checkbox': { checked: true }, 'settings-keep-awake': { checked: true } };
        env.globals.document.getElementById = function(id) { return boxes[id] || null; };
        await loadModules(['src/js/app/060-keep-awake.js'], { globals: env.globals });
        for (var i = 0; i < 5; i++) await Promise.resolve();
        env.boxes = boxes;
        return env;
    }
    test('A8B-02: keep-awake checkbox twins follow setKeepAwakeForeverDisabled', async function() {
        var env = await loadWithBoxes();
        env.win.toggleKeepAwake(false);
        assert.strictEqual(env.win.getKeepAwakeForeverDisabled(), true);
        assert.strictEqual(env.boxes['keep-awake-checkbox'].checked, false, 'gear twin unchecked');
        assert.strictEqual(env.boxes['settings-keep-awake'].checked, false, 'Settings twin unchecked');
        env.win.toggleKeepAwake(true);
        assert.strictEqual(env.win.getKeepAwakeForeverDisabled(), false);
        assert.strictEqual(env.boxes['keep-awake-checkbox'].checked, true, 'gear twin re-checked');
        assert.strictEqual(env.boxes['settings-keep-awake'].checked, true, 'Settings twin re-checked');
    }, { tags: ['unit'], timeout: 3000 });
    test("A8B-02: the notice's forever button unchecks both twins", async function() {
        var env = await loadWithBoxes();
        env.win.keepAwakeForceOn(); // idle path -> notice shown
        assert.strictEqual(typeof env.clicks['.ka-forever'], 'function', 'notice rendered');
        env.clicks['.ka-forever']();
        assert.strictEqual(env.win.getKeepAwakeForeverDisabled(), true);
        assert.strictEqual(env.boxes['keep-awake-checkbox'].checked, false, 'gear twin unchecked');
        assert.strictEqual(env.boxes['settings-keep-awake'].checked, false, 'Settings twin unchecked');
    }, { tags: ['unit'], timeout: 3000 });
});

// RELOAD-ZOMBIE: a beforeunload/unload/pagehide/visibilitychange handler (ours,
// or any iframe's) makes Chrome's CLOSE_NONE close of the old app tab on
// chrome.runtime.reload() defer to dispatch it;
// the tab then survives as ERR_BLOCKED_BY_CLIENT / "Aw, Snap!".
describe('RELOAD-ZOMBIE: keepAwakeDisarmUnload drops every unload blocker', function() {
    test('removes our beforeunload/pagehide/visibilitychange listeners and on* props, detaches frames; out is accurate', async function() {
        var env = await loadKeepAwake();
        assert.strictEqual((env.win._listeners.beforeunload || []).length, 1, 'armed at init');
        assert.strictEqual((env.win._listeners.pagehide || []).length, 1, 'pagehide armed at init');
        assert.strictEqual((env.doc._listeners.visibilitychange || []).length, 1, 'visibilitychange armed at init');
        var removed = [];
        var parent = { removeChild: function(c) { removed.push(c.id); c.parentNode = null; } };
        var frames = [{ id: 'sn', parentNode: parent }, { id: 'sandbox', parentNode: parent }];
        env.globals.document.querySelectorAll = function(sel) { return /iframe/.test(sel) ? frames : []; };
        env.win.onbeforeunload = function() { return 'x'; };
        var out = env.win.keepAwakeDisarmUnload();
        assert.strictEqual((env.win._listeners.beforeunload || []).length, 0, 'beforeunload removed');
        assert.strictEqual((env.win._listeners.pagehide || []).length, 0, 'pagehide removed (it defers the close too)');
        assert.strictEqual((env.doc._listeners.visibilitychange || []).length, 0, 'visibilitychange removed (it defers the close too)');
        assert.strictEqual((env.win._listeners.mousemove || []).length, 1, 'activity listeners (not close blockers) stay');
        assert.strictEqual(env.win.onbeforeunload, null);
        assert.strictEqual(env.win.onpagehide, null);
        assert.deepStrictEqual(removed, ['sn', 'sandbox']);
        assert.deepStrictEqual(out, { beforeunload: true, pagehide: true, visibilitychange: true, iframes: 2 });
        delete env.globals.document.querySelectorAll; // idempotent, no DOM: never throws
        assert.deepStrictEqual(env.win.keepAwakeDisarmUnload(), { beforeunload: false, pagehide: false, visibilitychange: false, iframes: 0 }, 'second call claims nothing');
    }, { tags: ['unit'], timeout: 2000 });
    test('releases an active run lock (reload tears the run down)', async function() {
        var env = await loadKeepAwake();
        env.startRun('c1');
        assert.strictEqual(env.lastSent(), true);
        env.win.keepAwakeDisarmUnload();
        assert.strictEqual(env.lastSent(), false, 'OS lock released before the reload');
    }, { tags: ['unit'], timeout: 2000 });
    test('disarm while init() awaits getSetting: no unload-type listener or idle timer is ever added', async function() {
        var env = makeKeepAwakeEnv(), release = null;
        env.globals.getSetting = function(k, d) { return new Promise(function(r) { release = function() { r(d); }; }); };
        await loadModules(['src/js/app/060-keep-awake.js'], { globals: env.globals });
        assert.strictEqual(typeof release, 'function', 'init() parked on getSetting');
        assert.deepStrictEqual(env.win.keepAwakeDisarmUnload(), { beforeunload: false, pagehide: false, visibilitychange: false, iframes: 0 }, 'nothing attached yet, nothing claimed');
        release();
        for (var i = 0; i < 5; i++) await Promise.resolve();
        assert.strictEqual((env.win._listeners.beforeunload || []).length, 0, 'no beforeunload after init');
        assert.strictEqual((env.win._listeners.pagehide || []).length, 0, 'no pagehide after init');
        assert.strictEqual((env.doc._listeners.visibilitychange || []).length, 0, 'no visibilitychange after init');
        assert.ok(!env.timeouts.some(function(t) { return t.ms === 5 * 60 * 1000; }), 'idle timer never armed');
    }, { tags: ['unit'], timeout: 2000 });
});

describe('RELOAD-ZOMBIE (P1): appCleanReload hands the reload to the SW only on a valid ack', function() {
    var ACK = { ok: true, ack: 'app-clean-reload' };
    function cleanMsgs(env) { return env.sent.filter(function(m) { return m.type === 'app-clean-reload'; }); }
    function timersAt(env, ms) { return env.timeouts.filter(function(t) { return t.ms === ms; }); }
    // Fake clock: move env.clock forward by `ms`, firing each live (not cleared, not yet fired) timeout as it comes due.
    function advance(env, ms) {
        var end = env.clock.now + ms;
        for (;;) {
            var due = env.timeouts.filter(function(t) { return !t.cleared && !t.fired && t.at + t.ms <= end; });
            if (!due.length) break;
            due.sort(function(a, b) { return (a.at + a.ms) - (b.at + b.ms); });
            env.clock.now = due[0].at + due[0].ms; due[0].fired = true; due[0].fn();
        }
        env.clock.now = end;
    }
    function track(p) { var s = { value: 'pending' }; p.then(function(v) { s.value = v; }, function(e) { s.value = 'REJECTED: ' + e; }); return s; }
    async function flush() { for (var i = 0; i < 5; i++) await Promise.resolve(); }
    test('disarms BEFORE sending; after a valid ack the promise stays pending with 0 reloads at 9.9 s', async function() {
        var env = await loadKeepAwake(), atSend = null;
        env.respond('app-clean-reload', function(msg, cb) {
            atSend = [(env.win._listeners.beforeunload || []).length, (env.win._listeners.pagehide || []).length, (env.doc._listeners.visibilitychange || []).length];
            cb(ACK);
        });
        var p = env.win.appCleanReload({ reason: 'reload' }), s = track(p);
        assert.deepStrictEqual(atSend, [0, 0, 0], 'already disarmed when the message goes out');
        var m = cleanMsgs(env);
        assert.strictEqual(m.length, 1);
        assert.strictEqual(m[0].reason, 'reload');
        assert.strictEqual(typeof m[0].at, 'number');
        assert.strictEqual(timersAt(env, 1500)[0].cleared, true, 'the ack clears the 1.5 s deadline');
        assert.strictEqual(timersAt(env, 10000).length, 1, 'post-ack watchdog armed');
        advance(env, 9900);
        timersAt(env, 1500)[0].fn(); // even a stale deadline (clearTimeout lost) is ignored
        await flush();
        assert.strictEqual(s.value, 'pending', 'still pending at 9.9 s: Reload lock + buttons stay held');
        assert.deepStrictEqual(env.reloads, { runtime: 0, page: 0 }, 'the SW owns the reload');
    }, { tags: ['unit'], timeout: 2000 });
    [
        ['{ok:true} without ack', function(env, msg, cb) { cb({ ok: true }); }, 'invalid'],
        ['undefined reply', function(env, msg, cb) { cb(undefined); }, 'invalid'],
        ['foreign ack', function(env, msg, cb) { cb({ ok: true, ack: 'keep-awake-set' }); }, 'invalid'],
        ['{ok:false} with the ack', function(env, msg, cb) { cb({ ok: false, ack: 'app-clean-reload' }); }, 'invalid'],
        ['{ok:1} (truthy, not true) with the ack', function(env, msg, cb) { cb({ ok: 1, ack: 'app-clean-reload' }); }, 'invalid'],
        ['lastError (no SW listener: port closed)', function(env, msg, cb) {
            env.globals.chrome.runtime.lastError = { message: 'The message port closed before a response was received.' };
            cb(undefined);
            env.globals.chrome.runtime.lastError = undefined;
        }, 'error'],
        ['sendMessage throws', function() { throw new Error('Extension context invalidated.'); }, 'threw']
    ].forEach(function(c) {
        test('direct chrome.runtime.reload() exactly once, synchronously: ' + c[0], async function() {
            var env = await loadKeepAwake();
            env.respond('app-clean-reload', function(msg, cb) { return c[1](env, msg, cb); });
            var p = env.win.appCleanReload({ reason: 'reload' });
            assert.strictEqual(env.reloads.runtime, 1, 'reloaded before returning');
            assert.strictEqual(await p, c[2]);
            env.timeouts.filter(function(t) { return t.ms === 1500; }).forEach(function(t) { t.fn(); });
            assert.deepStrictEqual(env.reloads, { runtime: 1, page: 0 }, 'the deadline never reloads twice');
            assert.strictEqual(timersAt(env, 10000).length, 0, 'no watchdog without a valid ack');
        }, { tags: ['unit'], timeout: 2000 });
    });
    test('missing sendMessage -> direct reload; reload() throwing -> window.location.reload()', async function() {
        var env = await loadKeepAwake();
        delete env.globals.chrome.runtime.sendMessage;
        env.globals.chrome.runtime.reload = function() { env.reloads.runtime++; throw new Error('reload unavailable'); };
        assert.strictEqual(await env.win.appCleanReload(), 'no-sendMessage');
        assert.deepStrictEqual(env.reloads, { runtime: 1, page: 1 });
    }, { tags: ['unit'], timeout: 2000 });
    test('no reply within 1500 ms -> one direct reload; a late ack changes nothing', async function() {
        var env = await loadKeepAwake(), late = null;
        env.respond('app-clean-reload', function(msg, cb) { late = cb; });
        var p = env.win.appCleanReload({ reason: 'restart-after-import' });
        assert.strictEqual(env.reloads.runtime, 0, 'waits for the ack');
        var t = env.timeouts.filter(function(x) { return x.ms === 1500; });
        assert.strictEqual(t.length, 1, 'ack deadline armed');
        t[0].fn();
        assert.strictEqual(env.reloads.runtime, 1);
        assert.strictEqual(await p, 'timeout');
        late(ACK);
        assert.deepStrictEqual(env.reloads, { runtime: 1, page: 0 }, 'late ack never reloads again');
        assert.strictEqual(timersAt(env, 10000).length, 0, 'a late ack arms no watchdog');
    }, { tags: ['unit'], timeout: 2000 });
    test('single-shot: repeat calls while the ack is pending return the same promise; no extra send or reload', async function() {
        var env = await loadKeepAwake(), reply = null;
        env.respond('app-clean-reload', function(msg, cb) { reply = cb; });
        var p1 = env.win.appCleanReload({ reason: 'reload' });
        var p2 = env.win.appCleanReload({ reason: 'restart-after-import' });
        assert.strictEqual(p1, p2);
        advance(env, 1200);
        reply(ACK); // ack 1.2 s in: clears the 1.5 s deadline; the watchdog runs from here
        assert.strictEqual(env.win.appCleanReload({ reason: 'reload' }), p1, 'same promise while the ack is pending');
        advance(env, 9900); // 11.1 s: the deadline never fired, the watchdog is not due yet
        assert.strictEqual(cleanMsgs(env).length, 1, 'one send');
        assert.strictEqual(timersAt(env, 10000).length, 1, 'one watchdog');
        assert.deepStrictEqual(env.reloads, { runtime: 0, page: 0 });
        advance(env, 100);
        assert.strictEqual(await p2, 'ack-timeout');
        assert.strictEqual(env.win.appCleanReload(), p1, 'still the same promise once settled');
        assert.strictEqual(cleanMsgs(env).length, 1);
        assert.deepStrictEqual(env.reloads, { runtime: 1, page: 0 });
    }, { tags: ['unit'], timeout: 2000 });
    test('ack, page still alive at 10 s: the watchdog does exactly one chrome.runtime.reload() and resolves ack-timeout', async function() {
        var env = await loadKeepAwake(), reply = null;
        env.respond('app-clean-reload', function(msg, cb) { reply = cb; cb(ACK); });
        var p = env.win.appCleanReload({ reason: 'reload' }), s = track(p);
        advance(env, 9999);
        await flush();
        assert.strictEqual(s.value, 'pending');
        assert.strictEqual(env.reloads.runtime, 0);
        advance(env, 1);
        assert.deepStrictEqual(env.reloads, { runtime: 1, page: 0 }, 'exactly one direct reload');
        assert.strictEqual(await p, 'ack-timeout');
        reply(ACK); reply({ ok: false }); // late / duplicate replies are ignored
        advance(env, 60000);
        assert.deepStrictEqual(env.reloads, { runtime: 1, page: 0 }, 'nothing reloads again');
        assert.strictEqual(timersAt(env, 10000).length, 1, 'one watchdog only');
    }, { tags: ['unit'], timeout: 2000 });
    test('ack, watchdog fires and chrome.runtime.reload() throws: exactly one window.location.reload(), still ack-timeout', async function() {
        var env = await loadKeepAwake();
        env.respond('app-clean-reload', function(msg, cb) { cb(ACK); });
        env.globals.chrome.runtime.reload = function() { env.reloads.runtime++; throw new Error('reload unavailable'); };
        var p = env.win.appCleanReload({ reason: 'restart-after-import' });
        advance(env, 10000);
        assert.deepStrictEqual(env.reloads, { runtime: 1, page: 1 });
        assert.strictEqual(await p, 'ack-timeout');
        advance(env, 60000);
        assert.deepStrictEqual(env.reloads, { runtime: 1, page: 1 }, 'never twice');
    }, { tags: ['unit'], timeout: 2000 });
    test('ack but the watchdog cannot be armed (setTimeout throws): resolves ack, the SW keeps the reload, never rejects', async function() {
        var env = makeKeepAwakeEnv(), st = env.globals.setTimeout;
        env.globals.setTimeout = function(fn, ms) { if (ms === 10000) throw new Error('timers unavailable'); return st(fn, ms); };
        await loadModules(['src/js/app/060-keep-awake.js'], { globals: env.globals });
        await flush();
        env.respond('app-clean-reload', function(msg, cb) { cb(ACK); });
        var s = track(env.win.appCleanReload({ reason: 'reload' }));
        await flush();
        assert.strictEqual(s.value, 'ack');
        advance(env, 60000);
        assert.deepStrictEqual(env.reloads, { runtime: 0, page: 0 });
    }, { tags: ['unit'], timeout: 2000 });
    [
        ['Infinity', Infinity, 1500], ['NaN', NaN, 1500], ['0', 0, 1500], ['negative', -250, 1500], ['a string', '5000', 1500],
        ['in range', 2500, 2500], ['at the cap', 60000, 60000], ['above the cap', 60001, 60000], ['2^31 (Chrome would fire at once)', Math.pow(2, 31), 60000]
    ].forEach(function(c) {
        test('timeoutMs clamp: ' + c[0] + ' -> ' + c[2] + ' ms deadline', async function() {
            var env = await loadKeepAwake();
            env.respond('app-clean-reload', function() {}); // never replies
            var before = env.timeouts.length;
            var p = env.win.appCleanReload({ timeoutMs: c[1] });
            assert.deepStrictEqual(env.timeouts.slice(before).map(function(t) { return t.ms; }), [c[2]], 'one deadline, clamped');
            advance(env, c[2] - 1);
            assert.strictEqual(env.reloads.runtime, 0, 'nothing before the clamped deadline');
            advance(env, 1);
            assert.strictEqual(env.reloads.runtime, 1);
            assert.strictEqual(await p, 'timeout');
        }, { tags: ['unit'], timeout: 2000 });
    });
});

describe('RELOAD-ZOMBIE (P1): Reload and restart-after-import route through appCleanReload', function() {
    function between(src, a, b) { var i = src.indexOf(a), j = src.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, 'located ' + a); return src.slice(i, j); }
    test('270 _doReload returns appCleanReload before any direct reload; the sequence returns _doReload()', async function() {
        var src = await loadFile('src/js/ui/270-iframe-panel.js');
        var body = between(src, 'function _doReload()', 'function _startReloadSequence');
        var c = body.indexOf('return window.appCleanReload(');
        assert.ok(c > 0, 'returns the appCleanReload promise');
        assert.ok(c < body.lastIndexOf('chrome.runtime.reload()') && c < body.lastIndexOf('window.location.reload()'), 'direct reload is only the fallback');
        assert.ok(body.lastIndexOf('keepAwakeDisarmUnload()') > c, 'the synchronous fallback still disarms first');
        assert.match(between(src, 'function _startReloadSequence', '// Rebuild-then-reload'), /return _doReload\(\);/);
    }, { tags: ['unit'], timeout: 2000 });
    test('130 _restartAfterImport awaits appCleanReload before the direct fallback', async function() {
        var src = await loadFile('src/js/ui/130-data-management.js');
        var body = between(src, 'async function _restartAfterImport', 'POST_IMPORT_NOTICE_KEY');
        var c = body.indexOf('window.appCleanReload(');
        assert.ok(c > 0, 'calls appCleanReload');
        assert.match(body, /await clean;[^\n]*return;/, 'awaits the helper, then returns');
        assert.ok(c < body.indexOf('chrome.runtime.reload()') && c < body.lastIndexOf('window.location.reload()'), 'direct reload is only the fallback');
    }, { tags: ['unit'], timeout: 2000 });
});
