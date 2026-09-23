// APP-TAB-REOPEN — "after Reload the app sometimes doesn't reopen; clicking the
// toolbar icon then opens TWO pages", and "sometimes it does not even re-open
// the page". Runs the REAL background.js slice (between the APP-TAB-REOPEN
// markers) against a fake chrome with controllable storage, tabs and windows.
// Short internal delays (settle polls, verify, create backoff: <=1000ms) run
// automatically; the startup re-check triggers (1500ms, 5000ms) are captured
// and fired explicitly with runTimers().
describe('APP-TAB-REOPEN: reopen after Reload opens exactly one tab (background.js)', function() {
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + start);
        return text.slice(a, b);
    }
    async function flush(n) { for (var i = 0; i < (n || 600); i++) await Promise.resolve(); }
    var _src = null;
    async function slice() {
        if (_src) return _src;
        var bg = await loadFile('src/platform/extension/background.js');
        _src = between(bg, '// --- App tab: toolbar click + reopen-after-Reload (APP-TAB-REOPEN) ---', '// APP-TAB-REOPEN end');
        return _src;
    }
    // opts.store: initial chrome.storage.local; opts.holdGet: defer the first get;
    // opts.existingTabs: app tabs present at SW start (vanishAfterGets: n => the
    // tab is closed by Chrome after n tabs.get polls); opts.createFails: every
    // tabs.create / windows.create rejects; opts.noWindow: no normal window.
    // opts.session: backing object of a fake chrome.storage.session (share it
    // across boots = SW restarts of ONE instance; omit => no storage.session);
    // opts.sessionThrows: its get/set throw. opts.manualTimers: EVERY timer
    // (also the short ones) waits for e.advance(ms) on a fake clock.
    async function boot(opts) {
        opts = opts || {};
        var e = { store: Object.assign({}, opts.store || {}), created: [], focused: [], reloaded: [], removed: [], windowsCreated: [], createArgs: [], createCalls: 0, warns: [], clickFn: null, installedFn: null, timers: [], queue: [], clock: 0, seq: 0, now: opts.now || 10000000, getGate: null, tabs: {}, gets: 0 };
        (opts.existingTabs || []).forEach(function(t) { e.tabs[t.id] = Object.assign({}, t); });
        var nextId = 100;
        function newTab(o) {
            var t = { id: nextId++, url: o.url, windowId: o.windowId != null ? o.windowId : 1 };
            if ((opts.vanishCreated || []).indexOf(t.id) < 0) e.tabs[t.id] = t; // vanishCreated: closed by Chrome at once
            e.created.push(t); return t;
        }
        var chrome = {
            runtime: {
                getURL: function(p) { return 'chrome-extension://ext/' + p; },
                onInstalled: { addListener: function(fn) { e.installedFn = fn; } }
            },
            sidePanel: { setPanelBehavior: function() { return Promise.resolve(); } },
            action: { onClicked: { addListener: function(fn) { e.clickFn = fn; } } },
            storage: { local: {
                get: function(k) {
                    e.gets++;
                    var snap = function() { var o = {}; if (k in e.store) o[k] = e.store[k]; return o; };
                    if (opts.holdGet && e.gets === 1) {
                        return new Promise(function(res) { e.getGate = function() { res(snap()); }; });
                    }
                    return Promise.resolve(snap());
                },
                remove: function(k) { delete e.store[k]; return Promise.resolve(); }
            } },
            tabs: {
                create: function(o) { e.createCalls++; e.createArgs.push(o); return opts.createFails ? Promise.reject(new Error('Tabs cannot be edited right now')) : Promise.resolve(newTab(o)); },
                update: function(id) {
                    if (!e.tabs[id]) return Promise.reject(new Error('No tab with id: ' + id));
                    e.focused.push(id); return Promise.resolve({ id: id, windowId: e.tabs[id].windowId });
                },
                reload: function(id) { e.reloaded.push(id); return Promise.resolve(); },
                remove: function(id) { e.removed.push(id); delete e.tabs[id]; return Promise.resolve(); },
                get: function(id) {
                    var t = e.tabs[id];
                    if (t && t.vanishAfterGets != null && t.vanishAfterGets-- <= 0) { delete e.tabs[id]; t = null; }
                    return t ? Promise.resolve(t) : Promise.reject(new Error('No tab with id: ' + id));
                },
                query: function() { return Promise.resolve(Object.keys(e.tabs).map(function(id) { return e.tabs[id]; })); }
            },
            windows: {
                update: function() { return Promise.resolve(); },
                getLastFocused: function() { return opts.noWindow ? Promise.reject(new Error('No last-focused window')) : Promise.resolve({ id: 1, type: 'normal' }); },
                create: function(o) {
                    e.createCalls++;
                    if (opts.createFails) return Promise.reject(new Error('cannot create window'));
                    var t = newTab({ url: o.url, windowId: 2 }); e.windowsCreated.push(o);
                    return Promise.resolve({ id: 2, tabs: [t] });
                }
            }
        };
        if (opts.session) {
            var sessionOp = function(fn) { if (opts.sessionThrows) throw new Error('storage.session unavailable'); return Promise.resolve(fn()); };
            chrome.storage.session = {
                get: function(k) { return sessionOp(function() { var o = {}; if (k in opts.session) o[k] = JSON.parse(JSON.stringify(opts.session[k])); return o; }); },
                set: function(o) { return sessionOp(function() { Object.assign(opts.session, JSON.parse(JSON.stringify(o))); }); }
            };
        }
        var fakeDate = { now: function() { return e.now; } };
        var fakeSetTimeout = function(fn, ms) {
            if (opts.manualTimers) { e.queue.push({ fn: fn, due: e.clock + (ms || 0), seq: ++e.seq }); return e.seq; }
            if (ms <= 1000) { Promise.resolve().then(fn); return 0; }
            e.timers.push({ fn: fn, ms: ms }); return e.timers.length;
        };
        var quietConsole = { warn: function() { e.warns.push([].slice.call(arguments).join(' ')); }, log: function() {}, error: function() {}, info: function() {} };
        new Function('chrome', 'Date', 'setTimeout', 'console', await slice())(chrome, fakeDate, fakeSetTimeout, quietConsole);
        e.runTimers = async function() { var t = e.timers.splice(0); for (var i = 0; i < t.length; i++) { t[i].fn(); await flush(); } };
        // manualTimers: run, in due order, every timer due within the next `ms` of fake time.
        e.advance = async function(ms) {
            var target = e.clock + ms;
            for (;;) {
                await flush();
                var next = null;
                e.queue.forEach(function(t) { if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t; });
                if (!next) break;
                e.queue.splice(e.queue.indexOf(next), 1);
                e.now += next.due - e.clock; e.clock = next.due;
                next.fn();
            }
            e.now += target - e.clock; e.clock = target;
        };
        await flush();
        return e;
    }

    test('fresh marker after Reload reopens exactly one tab and is cleared', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 2000 } });
        e.installedFn(); await flush(); await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.match(e.created[0].url, /app\.html\?mode=tab$/);
        assert.strictEqual(e.created[0].windowId, 1); // last-focused normal window
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('legacy boolean marker (written by the pre-fix page) still reopens once', async function() {
        var e = await boot({ store: { reopenAppTab: true } });
        await e.runTimers();
        assert.strictEqual(e.created.length, 1);
    }, { tags: ['unit'], timeout: 2000 });

    test('stale marker left by a missed reopen + toolbar click opens ONE tab (the bug)', async function() {
        // Marker written 10 minutes ago; this SW start is caused by the click.
        var e = await boot({ store: { reopenAppTab: 10000000 - 600000 }, holdGet: true });
        e.clickFn();            // onClicked dispatched while the startup read is in flight
        e.getGate(); await flush(); await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('stale marker without a click is dropped silently (no surprise tab)', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 600000 } });
        await e.runTimers();
        assert.strictEqual(e.created.length, 0);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('fresh marker + click racing the reopen still yields one tab (focused)', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 } });
        assert.strictEqual(e.created.length, 1); // reopen already opened it
        await e.clickFn(); await flush();
        assert.strictEqual(e.created.length, 1);
        assert.deepStrictEqual(e.focused.slice(-1), [e.created[0].id]);
        // A later click (outside the reuse window) opens a new tab as usual.
        e.now += 60000;
        await e.clickFn(); await flush();
        assert.strictEqual(e.created.length, 2);
    }, { tags: ['unit'], timeout: 2000 });

    test('marker that lands late is caught by the delayed re-check', async function() {
        var e = await boot({ store: {} });
        assert.strictEqual(e.created.length, 0);
        e.store.reopenAppTab = e.now - 500; // write committed after the startup read
        await e.runTimers();
        assert.strictEqual(e.created.length, 1);
    }, { tags: ['unit'], timeout: 2000 });

    test('an app tab that SURVIVES the settle window is focused and reloaded (old instance code)', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, existingTabs: [{ id: 7, url: 'chrome-extension://ext/app.html?mode=tab', windowId: 1 }] });
        assert.strictEqual(e.created.length, 0);
        assert.deepStrictEqual(e.focused, [7]);
        assert.deepStrictEqual(e.reloaded, [7]);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('an old-instance app tab that disappears within the settle window leads to a NEW tab', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, existingTabs: [{ id: 7, url: 'chrome-extension://ext/app.html?mode=tab', windowId: 1, vanishAfterGets: 2 }] });
        assert.deepStrictEqual(e.focused, [], 'the vanishing tab must never be focused');
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('no normal window: the reopen creates a new window with the app tab', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, noWindow: true });
        assert.strictEqual(e.windowsCreated.length, 1);
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.created[0].windowId, 2);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('all creates fail: the marker is KEPT and every later trigger retries', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, createFails: true });
        assert.strictEqual(e.created.length, 0);
        assert.strictEqual('reopenAppTab' in e.store, true, 'marker must survive a failed reopen');
        var getsBefore = e.gets;
        e.installedFn(); await flush(); await e.runTimers();
        assert.ok(e.gets >= getsBefore + 3, 'onInstalled, +1.5s and +5s triggers each re-read the marker');
        assert.strictEqual('reopenAppTab' in e.store, true);
    }, { tags: ['unit'], timeout: 2000 });

    test('a created tab that vanishes before verification is retried, then succeeds', async function() {
        // First created tab (id 100) is closed by Chrome before verification.
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, vanishCreated: [100] });
        await e.runTimers();
        assert.strictEqual(e.created.length, 2);
        assert.ok(!!e.tabs[101], 'second tab verified and kept');
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('concurrent triggers (startup + onInstalled + delayed re-checks) open only ONE tab', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, holdGet: true });
        // While the startup read is still in flight every other trigger fires.
        e.installedFn(); e.installedFn();
        var t = e.timers.splice(0); t.forEach(function(x) { x.fn(); });
        e.getGate(); await flush(); await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.gets, 1, 'all triggers joined the single in-flight attempt');
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('plain click with no marker opens one tab each time', async function() {
        var e = await boot({ store: {} });
        await e.clickFn(); await flush();
        await e.clickFn(); await flush();
        assert.strictEqual(e.created.length, 2);
    }, { tags: ['unit'], timeout: 2000 });

    // --- Review fixes: m1 (a reopen never touches a NEW-instance tab), m2 (a
    // toolbar click opens its tab promptly), nit (legacy `true` consumed once).
    var OLD_TAB = { id: 7, url: 'chrome-extension://ext/app.html?mode=tab', windowId: 1, vanishAfterGets: 0 };
    var POPOUT = { id: 50, url: 'chrome-extension://ext/app.html?mode=tab&chat=c1', windowId: 1 };
    function untouched(e, id, label) {
        label = label ? label + ': ' : '';
        assert.strictEqual(e.focused.indexOf(id), -1, label + 'tab ' + id + ' must never be focused');
        assert.strictEqual(e.reloaded.indexOf(id), -1, label + 'tab ' + id + ' must never be reloaded');
        assert.strictEqual(e.removed.indexOf(id), -1, label + 'tab ' + id + ' must never be removed');
    }
    function failWarns(e) { return e.warns.filter(function(w) { return /keeping marker|reopen app tab failed/.test(w); }); }

    test('m1: a retry never focuses/reloads/removes an app tab that appeared after the first attempt (pop-out)', async function() {
        var modes = [{ label: 'no storage.session' }, { label: 'storage.session', session: {} }, { label: 'storage.session throws', session: {}, sessionThrows: true }];
        for (var i = 0; i < modes.length; i++) {
            var m = modes[i];
            // First attempt: old tab 7 is closing; every tab it creates vanishes => fails, marker kept.
            var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, existingTabs: [OLD_TAB], vanishCreated: [100, 101, 102], session: m.session, sessionThrows: m.sessionThrows });
            await flush(3000);
            assert.strictEqual(e.created.length, 3, m.label + ': first attempt tried 3 creates');
            assert.strictEqual('reopenAppTab' in e.store, true, m.label + ': a failed attempt keeps the numeric marker');
            e.tabs[POPOUT.id] = Object.assign({}, POPOUT);   // user pops a chat out in the NEW instance
            e.installedFn(); await flush(3000); await e.runTimers();
            untouched(e, POPOUT.id, m.label);
            assert.ok(!!e.tabs[103], m.label + ': the retry opened (and verified) a fresh tab instead');
            assert.strictEqual('reopenAppTab' in e.store, false, m.label + ': marker cleared after the verified retry');
        }
    }, { tags: ['unit'], timeout: 4000 });

    test('m1: a LATER SW lifetime of the same instance reuses the storage.session snapshot (pop-out untouched)', async function() {
        var session = {};   // chrome.storage.session outlives SW restarts of one instance
        var e1 = await boot({ store: { reopenAppTab: 10000000 - 1000 }, existingTabs: [OLD_TAB], vanishCreated: [100, 101, 102], session: session });
        await flush(3000);
        assert.strictEqual('reopenAppTab' in e1.store, true, 'first lifetime failed and kept the marker');
        // That SW is stopped (its pending timers never fire); a pop-out exists when it restarts.
        var e2 = await boot({ store: e1.store, existingTabs: [POPOUT], session: session });
        await flush(3000); e2.installedFn(); await flush(3000); await e2.runTimers();
        untouched(e2, POPOUT.id, 'restarted SW');
        assert.strictEqual(e2.created.length, 1, 'the restarted SW opened one fresh tab');
        assert.strictEqual('reopenAppTab' in e2.store, false);
    }, { tags: ['unit'], timeout: 4000 });

    test('m2: a click during the settle wait gets its own tab within ~one poll; the cancelled attempt touches nothing', async function() {
        // Tab 7 never closes, so the attempt would settle ~2s, then focus + reload it.
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, manualTimers: true, existingTabs: [{ id: 7, url: 'chrome-extension://ext/app.html?mode=tab', windowId: 1 }] });
        await e.advance(250);                      // one settle poll in: tab 7 still alive
        assert.strictEqual(e.created.length, 0);
        var click = e.clickFn();
        await e.advance(260);                      // ~one poll interval after the click
        assert.strictEqual(e.created.length, 1, "the click's tab opens without waiting out the ~2s settle");
        assert.strictEqual(e.createArgs[0].windowId, undefined, "it is the click's plain tabs.create, not the reopen's");
        await e.advance(10000);                    // drain every remaining timer (settle, verify, triggers)
        await click;
        assert.strictEqual(e.created.length, 1, 'the cancelled attempt created no second tab');
        assert.deepStrictEqual(e.reloaded, [], 'the cancelled attempt reloaded nothing');
        assert.deepStrictEqual(e.focused, [], 'the cancelled attempt focused nothing');
        assert.strictEqual('reopenAppTab' in e.store, false);
        assert.deepStrictEqual(failWarns(e), [], 'no failure warning for a click-cancelled attempt');
    }, { tags: ['unit'], timeout: 3000 });

    test('m2: a click during the create back-off stops the reopen retries and opens within ~one poll', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, manualTimers: true, vanishCreated: [100] });
        assert.strictEqual(e.created.length, 1, 'the reopen created tab 100 at once (no old tabs)');
        await e.advance(501);                      // verify: tab 100 vanished -> back-off before a retry
        var click = e.clickFn();
        await e.advance(260);
        assert.strictEqual(e.created.length, 2, "the click's tab opens without waiting out the back-off");
        assert.strictEqual(e.createArgs[1].windowId, undefined, "the second create is the click's, not a reopen retry");
        await e.advance(10000); await click;
        assert.strictEqual(e.created.length, 2, 'no reopen retry after the click');
        assert.deepStrictEqual(failWarns(e), [], 'no failure warning for a click-cancelled attempt');
    }, { tags: ['unit'], timeout: 3000 });

    test('m2: a click while the reopen verifies its created tab reuses that tab (no second tab)', async function() {
        var e = await boot({ store: { reopenAppTab: 10000000 - 1000 }, manualTimers: true });
        assert.strictEqual(e.created.length, 1, 'the reopen created its tab');
        var click = e.clickFn();                   // verify (500ms) still pending
        await e.advance(10000); await click;
        assert.strictEqual(e.created.length, 1, 'the click reused the verified reopen tab');
        assert.deepStrictEqual(e.focused, [e.created[0].id]);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, { tags: ['unit'], timeout: 3000 });

    test('nit: legacy `true` marker is consumed once - removed even when its attempt fails, never retried', async function() {
        var e = await boot({ store: { reopenAppTab: true }, createFails: true });
        await flush(3000);
        var calls = e.createCalls;
        assert.ok(calls > 0, 'the legacy marker still gets its one reopen attempt');
        assert.strictEqual('reopenAppTab' in e.store, false, 'legacy marker removed although the attempt failed');
        e.installedFn(); await flush(3000); await e.runTimers();
        assert.strictEqual(e.createCalls, calls, 'no later trigger retries the legacy marker');
        assert.strictEqual(e.warns.filter(function(w) { return /keeping marker/.test(w); }).length, 0, 'no "keeping marker" warning for a consumed legacy marker');
    }, { tags: ['unit'], timeout: 2000 });
});
