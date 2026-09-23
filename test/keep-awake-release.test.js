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
        addEventListener: function() {}, removeEventListener: function() {}
    };
    var win = fakeWindow();
    var chrome = {
        runtime: {
            lastError: undefined,
            sendMessage: function(msg, cb) { sent.push(msg); if (typeof cb === 'function') cb({ ok: true }); }
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
        setTimeout: function(fn, ms) { timeouts.push({ fn: fn, ms: ms }); return timeouts.length; },
        clearTimeout: function() {},
        setInterval: function(fn, ms) { intervals.push({ fn: fn, ms: ms, live: true }); return intervals.length; },
        clearInterval: function(id) { if (intervals[id - 1]) intervals[id - 1].live = false; },
        console: { log: function() {}, table: function() {}, warn: function() {}, error: function() {} }
    };
    return {
        globals: globals, win: win, sent: sent, intervals: intervals, clicks: clicks,
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
