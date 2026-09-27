// APP-TAB-REOPEN (PR B1) — "after Reload the app sometimes doesn't reopen;
// clicking the toolbar icon then opens TWO pages", "sometimes it does not even
// re-open the page", and the clean in-app Reload (ack -> marker -> close every
// extension tab -> runtime.reload()). Runs the REAL background.js slice (between
// the APP-TAB-REOPEN markers) against a fake chrome with controllable storage,
// tabs, windows and runtime messaging; plus the page-side app/070-app-tab-ready.js.
// Timers: without manualTimers, delays < 1000ms run at once (microtask) and
// longer ones are captured (runTimers() fires them once); with manualTimers
// EVERY timer waits for e.advance(ms) on a fake clock (Date.now moves with it).
describe('APP-TAB-REOPEN: reopen after Reload opens exactly one verified tab (background.js)', function() {
    var NOW = 10000000;
    var APP = 'chrome-extension://ext/app.html?mode=tab';
    var ACK = { ok: true, ack: 'app-clean-reload' };
    var FAIL_EVENTS = ['gave-up', 'ready-timeout', 'create-failed', 'check-failed', 'remove-failed', 'remove-timeout', 'clean-reload-marker-failed'];
    var LOG_KEY = 'appagentReopenLog'; // B2: persisted reopen log (ring buffer of the last 50 entries)
    var LOG_STEP_MS = 1800;            // B2: bound of each log get / set (REOPEN_LOG_STEP_MS)
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + start);
        return text.slice(a, b);
    }
    async function flush(n) { for (var i = 0; i < (n || 1500); i++) await Promise.resolve(); }
    var _src = null;
    async function slice() {
        if (_src) return _src;
        var bg = await loadFile('src/platform/extension/background.js');
        _src = between(bg, '// --- App tab: toolbar click + reopen-after-Reload (APP-TAB-REOPEN) ---', '// APP-TAB-REOPEN end');
        return _src;
    }
    function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
    function inList(v, id) { return v === true || (Array.isArray(v) && v.indexOf(id) >= 0); }
    function nsort(a) { return a.slice().sort(function(x, y) { return x - y; }); }
    function extSender(tabId, url) { return { id: 'ext', url: url || APP, tab: tabId == null ? undefined : { id: tabId, windowId: 1 } }; }
    function cleanMsg() { return { type: 'app-clean-reload', reason: 'reload-button', at: NOW }; }
    // opts.store: initial chrome.storage.local; opts.holdGet: defer the first
    // reopenAppTab get (e.getGate() answers it); opts.existingTabs: tabs present
    // at SW start (vanishAfterGets: n => closed by Chrome after n tabs.get polls).
    // Creates: createFails (all reject), createFailsFirst: n (the first n tabs /
    // windows creates reject; a failed create uses no tab id), hangCreates: n
    // (the first n tabs.create never answer), noWindow (no normal window),
    // slowCreateMs: ms (manualTimers: tabs.create answers ms later, and the tab
    // only exists from then).
    // Ready: every created tab sends app-tab-ready ~50 microtasks after its
    // create resolved; readyBeforeCreateResolves sends it inside tabs.create;
    // noReady: true | [ids] suppresses it. e.send(msg, sender) runs every
    // runtime.onMessage listener: {responses, returnedTrue}.
    // storage.local.set: setThrows (sync throw), hangSet (never answers, no write).
    // appagentReopenLog only (the n-th log get / set, 1-based): logGet(n) =>
    // 'throw' | 'hang' (answer kept in e.logGetLate) | 'none' (answers undefined);
    // logSet(n) => 'throw' | 'hang'; e.logOps records 'get<n>' / 'set<n>'.
    // noStorage: chrome.storage absent.
    // tabs.remove: removeThrows (sync throw), hangRemove: true | [ids] (never
    // answers), hangRemoveClosed: true | [ids] (closes the tab but never answers).
    // runtime.reload: reloadThrows. opts.session: backing object of
    // chrome.storage.session (share it across boots = SW restarts of ONE
    // instance; omit => none); sessionThrows / hangSession. hangQuery (tabs.query)
    // and hangGets (tabs.get) never answer. manualTimers: see the header.
    async function boot(opts) {
        opts = opts || {};
        var e = { store: clone(opts.store || {}), created: [], focused: [], reloaded: [], removed: [], removeCalls: [], windowsCreated: [], createArgs: [], createCalls: 0,
            logs: [], warns: [], sets: [], order: [], msgFns: [], reloads: 0, clickFn: null, installedFn: null,
            timers: [], queue: [], clock: 0, seq: 0, now: opts.now || NOW, getGate: null, tabs: {}, gets: 0,
            logGets: 0, logSetCalls: 0, logOps: [], logGetLate: [] };
        (opts.existingTabs || []).forEach(function(t) { e.tabs[t.id] = Object.assign({}, t); });
        var nextId = 100;
        e.send = function(msg, sender) {
            var out = { responses: [], returnedTrue: false };
            var reply = function(r) { out.responses.push(r); e.order.push('ack:' + (msg && msg.type)); };
            e.msgFns.forEach(function(fn) { if (fn(msg, sender, reply) === true) out.returnedTrue = true; });
            return out;
        };
        e.ready = function(id, over) {
            var t = e.tabs[id] || { id: id, url: APP, windowId: 1 };
            return e.send(Object.assign({ type: 'app-tab-ready', bootId: 'b' + id, at: e.now, nav: 'navigate', prevBoot: null }, over || {}),
                { id: 'ext', url: t.url, tab: { id: id, windowId: t.windowId } });
        };
        function newTab(o) {
            var t = { id: nextId++, url: o.url, windowId: o.windowId != null ? o.windowId : 1, title: 'AppAgent', status: 'complete' };
            e.tabs[t.id] = t;
            e.created.push(t);
            if (!inList(opts.noReady, t.id)) {
                if (opts.readyBeforeCreateResolves) e.ready(t.id);
                else (async function() { await flush(50); if (e.tabs[t.id]) e.ready(t.id); })();
            }
            return t;
        }
        function createFails() { return !!(opts.createFails || (opts.createFailsFirst && e.createCalls <= opts.createFailsFirst)); }
        var chrome = {
            runtime: {
                id: 'ext',
                getURL: function(p) { return 'chrome-extension://ext/' + p; },
                onInstalled: { addListener: function(fn) { e.installedFn = fn; } },
                onMessage: { addListener: function(fn) { e.msgFns.push(fn); } },
                reload: function() { e.reloads++; e.order.push('reload'); if (opts.reloadThrows) throw new Error('reload failed'); }
            },
            sidePanel: { setPanelBehavior: function() { return Promise.resolve(); } },
            action: { onClicked: { addListener: function(fn) { e.clickFn = fn; } } },
            storage: { local: {
                get: function(k) {
                    var mine = k === 'reopenAppTab';
                    if (mine) e.gets++;
                    var snap = function() { var o = {}; if (k in e.store) o[k] = clone(e.store[k]); return o; };
                    if (opts.holdGet && mine && e.gets === 1) return new Promise(function(res) { e.getGate = function() { res(snap()); }; });
                    if (k === LOG_KEY) {
                        var gi = ++e.logGets, gm = opts.logGet ? opts.logGet(gi) : null;
                        e.logOps.push('get' + gi);
                        if (gm === 'throw') throw new Error('storage.local.get failed');
                        if (gm === 'hang') return new Promise(function(res) { e.logGetLate.push(function() { res(snap()); }); });
                        if (gm === 'none') return Promise.resolve(undefined);
                    }
                    return Promise.resolve(snap());
                },
                set: function(o) {
                    e.order.push('set:' + Object.keys(o).join(','));
                    if (LOG_KEY in o) {
                        var si = ++e.logSetCalls, sm = opts.logSet ? opts.logSet(si) : null;
                        e.logOps.push('set' + si);
                        if (sm === 'throw') throw new Error('storage.local.set failed');
                        if (sm === 'hang') return new Promise(function() {});
                    }
                    if (opts.setThrows) throw new Error('storage.local.set failed');
                    if (opts.hangSet) return new Promise(function() {});
                    Object.assign(e.store, clone(o));
                    e.sets.push({ o: clone(o), clock: e.clock });
                    return Promise.resolve();
                },
                remove: function(k) { e.order.push('marker-remove'); delete e.store[k]; return Promise.resolve(); }
            } },
            tabs: {
                create: function(o) {
                    e.createCalls++; e.createArgs.push(o);
                    if (opts.hangCreates && e.createCalls <= opts.hangCreates) return new Promise(function() {});
                    if (createFails()) return Promise.reject(new Error('Tabs cannot be edited right now'));
                    if (opts.slowCreateMs) return new Promise(function(res) { e.queue.push({ fn: function() { res(newTab(o)); }, due: e.clock + opts.slowCreateMs, seq: ++e.seq }); });
                    return Promise.resolve(newTab(o));
                },
                update: function(id) {
                    if (!e.tabs[id]) return Promise.reject(new Error('No tab with id: ' + id));
                    e.focused.push(id); return Promise.resolve({ id: id, windowId: e.tabs[id].windowId });
                },
                reload: function(id) { e.reloaded.push(id); return Promise.resolve(); },
                remove: function(ids) {
                    ids = [].concat(ids);
                    ids.forEach(function(id) { e.removeCalls.push(id); e.order.push('remove:' + id); });
                    if (opts.removeThrows) throw new Error('remove failed');
                    if (ids.some(function(id) { return inList(opts.hangRemove, id); })) return new Promise(function() {});
                    ids.forEach(function(id) { e.removed.push(id); delete e.tabs[id]; });
                    if (ids.some(function(id) { return inList(opts.hangRemoveClosed, id); })) return new Promise(function() {});
                    return Promise.resolve();
                },
                get: function(id) {
                    if (opts.hangGets) return new Promise(function() {});
                    var t = e.tabs[id];
                    if (t && t.vanishAfterGets != null && t.vanishAfterGets-- <= 0) { delete e.tabs[id]; t = null; }
                    return t ? Promise.resolve(clone(t)) : Promise.reject(new Error('No tab with id: ' + id));
                },
                query: function(q) {
                    if (opts.hangQuery) return new Promise(function() {});
                    var all = Object.keys(e.tabs).map(function(id) { return clone(e.tabs[id]); });
                    if (q && q.url) {
                        var pre = String(q.url).replace(/\*$/, '');
                        all = all.filter(function(t) { return String(t.url || '').indexOf(pre) === 0; });
                    }
                    return Promise.resolve(all);
                }
            },
            windows: {
                update: function() { return Promise.resolve(); },
                getLastFocused: function() { return opts.noWindow ? Promise.reject(new Error('No last-focused window')) : Promise.resolve({ id: 1, type: 'normal' }); },
                create: function(o) {
                    e.createCalls++;
                    if (createFails()) return Promise.reject(new Error('cannot create window'));
                    var t = newTab({ url: o.url, windowId: 2 }); e.windowsCreated.push(o);
                    return Promise.resolve({ id: 2, tabs: [t] });
                }
            }
        };
        if (opts.session) {
            var sessionOp = function(fn) { if (opts.hangSession) return new Promise(function() {}); if (opts.sessionThrows) throw new Error('storage.session unavailable'); return Promise.resolve(fn()); };
            chrome.storage.session = {
                get: function(k) { return sessionOp(function() { var o = {}; if (k in opts.session) o[k] = clone(opts.session[k]); return o; }); },
                set: function(o) { return sessionOp(function() { Object.assign(opts.session, clone(o)); }); }
            };
        }
        if (opts.noStorage) chrome.storage = undefined;
        var fakeDate = { now: function() { return e.now; } };
        var fakeSetTimeout = function(fn, ms) {
            if (opts.manualTimers) { e.queue.push({ fn: fn, due: e.clock + (ms || 0), seq: ++e.seq }); return e.seq; }
            if ((ms || 0) < 1000) { Promise.resolve().then(fn); return 0; }
            e.timers.push({ fn: fn, ms: ms }); return e.timers.length;
        };
        var fakeConsole = {
            info: function(msg, data) { var m = /^\[SW\]\[reopen\] (.+)$/.exec(String(msg)); if (m) e.logs.push({ ev: m[1], data: data || {}, clock: e.clock }); },
            warn: function() { e.warns.push([].slice.call(arguments).join(' ')); }, log: function() {}, error: function() {}
        };
        e.ev = function(name) { return e.logs.filter(function(l) { return l.ev === name; }); };
        e.evNames = function() { return e.logs.map(function(l) { return l.ev; }); };
        e.failLogs = function() { return e.logs.filter(function(l) { return FAIL_EVENTS.indexOf(l.ev) >= 0; }); };
        e.markerSets = function() { return e.sets.filter(function(s) { return 'reopenAppTab' in s.o; }).map(function(s) { return s.o.reopenAppTab; }); };
        e.flowSets = function() { return e.sets.filter(function(s) { return !(LOG_KEY in s.o); }); }; // every set but the log's
        e.logSets = function() { return e.sets.filter(function(s) { return LOG_KEY in s.o; }); };
        e.stored = function() { return e.store[LOG_KEY] || []; };
        new Function('chrome', 'Date', 'setTimeout', 'console', await slice())(chrome, fakeDate, fakeSetTimeout, fakeConsole);
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
    var OPTS = { tags: ['unit'], timeout: 3000 };
    var LONG = { tags: ['unit'], timeout: 6000 };

    // --- Reopen after Reload (kept + rewritten) --------------------------------
    test('fresh numeric marker: exactly one tab, verified by its app-tab-ready, marker cleared', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 2000 } });
        e.installedFn(); await flush(); await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.match(e.created[0].url, /app\.html\?mode=tab$/);
        assert.strictEqual(e.created[0].windowId, 1, 'last-focused normal window');
        assert.deepStrictEqual(e.evNames(), ['created', 'ready', 'verified']);
        assert.strictEqual(e.ev('ready')[0].data.awaited, true, 'the ready resolved the pending wait');
        assert.strictEqual(e.ev('verified')[0].data.tabId, 100);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('numeric marker 59s old is still fresh: it reopens one verified tab', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 59000 } });
        await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.ev('verified').length, 1);
        assert.deepStrictEqual(e.ev('marker-dropped'), []);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('numeric marker 61s old is dropped as stale: nothing created, marker removed', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 61000 } });
        await e.runTimers();
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.ev('marker-dropped').map(function(l) { return l.data; }), [{ why: 'stale' }]);
        assert.strictEqual('reopenAppTab' in e.store, false);
        assert.deepStrictEqual(e.removeCalls, [], 'a stale marker closes nothing');
    }, OPTS);

    test('legacy boolean marker (pre-timestamp page) still reopens once', async function() {
        var e = await boot({ store: { reopenAppTab: true } });
        await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.ev('verified').length, 1);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('stale marker left by a missed reopen + toolbar click opens ONE tab (the bug)', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 600000 }, holdGet: true });
        e.clickFn();            // onClicked dispatched while the startup read is in flight
        e.getGate(); await flush(); await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('stale marker without a click is dropped silently (no surprise tab)', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 600000 } });
        await e.runTimers();
        assert.strictEqual(e.created.length, 0);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('fresh marker + click racing the reopen still yields one tab (focused)', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 } });
        assert.strictEqual(e.created.length, 1); // reopen already opened it
        await e.clickFn(); await flush();
        assert.strictEqual(e.created.length, 1);
        assert.deepStrictEqual(e.focused.slice(-1), [e.created[0].id]);
        // F4 (intended change, was: a 2nd tab): a later click outside the reuse
        // window no longer opens a 2nd app instance. The reopen tab is still live
        // (its app-tab-ready at NOW is within READY_TTL at NOW+60000): focused.
        e.now += 60000;
        await e.clickFn(); await flush();
        assert.strictEqual(e.created.length, 1);
        assert.deepStrictEqual(e.ev('click-focused').map(function(l) { return l.data.tabId; }), [e.created[0].id]);
    }, OPTS);

    test('marker that lands late is caught by the delayed re-check', async function() {
        var e = await boot({ store: {} });
        assert.strictEqual(e.created.length, 0);
        e.store.reopenAppTab = e.now - 500; // write committed after the startup read
        await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.ev('verified').length, 1);
    }, OPTS);

    test('an old-instance app tab that SURVIVES the settle window is closed (never focused/reloaded); a fresh tab is verified', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, existingTabs: [{ id: 7, url: APP, windowId: 1, title: 'Old AppAgent', status: 'complete' }] });
        await flush(3000);
        var sc = e.ev('survivors-closed');
        assert.strictEqual(sc.length, 1);
        assert.deepStrictEqual(sc[0].data.tabs, [{ id: 7, url: APP, title: 'Old AppAgent', status: 'complete' }]);
        assert.strictEqual(sc[0].data.removed, 1);
        assert.deepStrictEqual(e.removed, [7]);
        assert.deepStrictEqual(e.focused, []);
        assert.deepStrictEqual(e.reloaded, []);
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.ev('verified')[0].data.tabId, 100);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('an old-instance app tab that disappears within the settle window leads to a NEW tab', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, existingTabs: [{ id: 7, url: APP, windowId: 1, vanishAfterGets: 2 }] });
        await flush(3000);
        assert.deepStrictEqual(e.focused, [], 'the vanishing tab must never be focused');
        assert.deepStrictEqual(e.removeCalls, [], 'nothing left to close');
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.ev('verified').length, 1);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('no normal window: the reopen creates a new window with the app tab', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, noWindow: true });
        await flush(3000);
        assert.strictEqual(e.windowsCreated.length, 1);
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.created[0].windowId, 2);
        assert.strictEqual(e.ev('verified').length, 1);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('all creates fail: the marker is KEPT and every later trigger retries', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, createFails: true });
        await flush(3000);
        assert.strictEqual(e.created.length, 0);
        assert.strictEqual(e.createCalls, 3, 'three create tries');
        assert.ok(e.ev('create-failed').length >= 1);
        assert.strictEqual('reopenAppTab' in e.store, true, 'marker must survive a failed reopen');
        var getsBefore = e.gets;
        e.installedFn(); await flush(); await e.runTimers();
        assert.ok(e.gets >= getsBefore + 3, 'onInstalled, +1.5s and +5s triggers each re-read the marker');
        assert.strictEqual('reopenAppTab' in e.store, true);
    }, OPTS);

    test('a created tab that never sends app-tab-ready is closed after 8s and ONE more tab is created and verified', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: [100] });
        assert.strictEqual(e.created.length, 1, 'the reopen created tab 100 at once');
        await e.advance(9000);
        assert.deepStrictEqual(e.removeCalls, [100]);
        assert.strictEqual(e.created.length, 2);
        assert.ok(!!e.tabs[101], 'second tab verified and kept');
        assert.strictEqual(e.ev('ready-timeout').length, 1);
        assert.strictEqual(e.ev('verified')[0].data.tabId, 101);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, LONG);

    test('concurrent triggers (startup + onInstalled + delayed re-checks) open only ONE tab', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, holdGet: true });
        e.installedFn(); e.installedFn();
        // Only the re-check TRIGGERS (1.5s, 5s) - not the per-call timeouts/watchdog.
        var t = e.timers.filter(function(x) { return x.ms === 1500 || x.ms === 5000; });
        e.timers = e.timers.filter(function(x) { return t.indexOf(x) < 0; });
        t.forEach(function(x) { x.fn(); });
        e.getGate(); await flush(); await e.runTimers();
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.gets, 1, 'all triggers joined the single in-flight attempt');
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('plain rapid double click with no marker opens ONE tab (the 2nd is debounced)', async function() {
        var e = await boot({ store: {} });
        await e.clickFn(); await flush();
        await e.clickFn(); await flush();
        // F4 (intended change, was: 2 tabs): the 2nd click lands within
        // APP_TAB_CLICK_DEBOUNCE_MS of the 1st (frozen clock) and answers its tab.
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.ev('click-debounced').length, 1);
    }, OPTS);

    // --- Clean reload (app-clean-reload): ack first ---------------------------
    var T7 = { id: 7, url: APP, windowId: 1, title: 'AppAgent', status: 'complete' };
    var T8 = { id: 8, url: APP + '&chat=c1', windowId: 1 };
    var T9 = { id: 9, url: 'https://x.service-now.com/now', windowId: 1 };
    var T10 = { id: 10, url: '', pendingUrl: APP, windowId: 1 };

    test('clean reload: synchronous ack, then the marker, then EVERY extension tab closed, then runtime.reload()', async function() {
        var e = await boot({ existingTabs: [T7, T8, T9, T10] });
        e.order = [];
        var r = e.send(cleanMsg(), extSender(7));
        assert.deepStrictEqual(r.responses, [ACK], 'acked synchronously, before any await');
        assert.strictEqual(r.returnedTrue, false, 'no async response channel kept open');
        assert.strictEqual(e.reloads, 0);
        await flush(3000);
        // The persisted-log writes (B2) run beside this sequence, never inside it.
        var o = e.order.filter(function(x) { return x !== 'set:' + LOG_KEY; });
        var iAck = o.indexOf('ack:app-clean-reload'), iSet = o.indexOf('set:reopenAppTab'), iReload = o.indexOf('reload');
        var iRemoves = o.map(function(x, i) { return /^remove:/.test(x) ? i : -1; }).filter(function(i) { return i >= 0; });
        assert.ok(iAck >= 0 && iSet > iAck, 'ack before the marker write: ' + o.join(' '));
        assert.strictEqual(iRemoves.length, 3, o.join(' '));
        assert.ok(iRemoves.every(function(i) { return i > iSet && i < iReload; }), 'every remove after the marker and before reload: ' + o.join(' '));
        assert.strictEqual(iReload, o.length - 1, 'reload is last: ' + o.join(' '));
        assert.deepStrictEqual(r.responses, [ACK], 'the ack is sent exactly once');
        assert.deepStrictEqual(e.store.reopenAppTab, { at: NOW, attempts: 0, tabId: null });
        assert.deepStrictEqual(nsort(e.removed), [7, 8, 10], 'app tab, pop-out and the pendingUrl tab closed');
        assert.ok(!!e.tabs[9], 'the web tab is untouched');
        assert.strictEqual(e.reloads, 1);
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.failLogs(), []);
    }, OPTS);

    test('clean reload, storage.local.set hangs: ack immediate, marker bound 1s, reload at ~1s', async function() {
        var e = await boot({ existingTabs: [T7, T9], manualTimers: true, hangSet: true });
        var r = e.send(cleanMsg(), extSender(7));
        assert.deepStrictEqual(r.responses, [ACK], 'immediate ack');
        await e.advance(990);
        assert.strictEqual(e.reloads, 0, 'still inside the 1s marker bound');
        await e.advance(20);
        assert.strictEqual(e.reloads, 1, 'reload right after the 1s marker bound');
        assert.strictEqual(e.ev('clean-reload-marker-failed').length, 1);
        assert.deepStrictEqual(e.removeCalls, [7]);
        assert.deepStrictEqual(r.responses, [ACK], 'the ack is sent exactly once');
    }, OPTS);

    test('clean reload, set AND remove hang: ack immediate, reload at ~4s (under the page 10s post-ack watchdog)', async function() {
        // LOW-4a: bounds derived from the slice (marker write bound + close bound)
        // and from the page (060 CLEAN_RELOAD_POST_ACK_MS), not pinned literals.
        var CLOSE = await K('REOPEN_APP_TAB_CLEAN_REMOVE_MS');
        var MARK = +/_reopenStorageSet\(\{ reopenAppTab: \{ at: Date\.now\(\), attempts: 0, tabId: null \} \}, (\d+)\)/.exec(await slice())[1];
        var PAGE = +/var CLEAN_RELOAD_POST_ACK_MS = (\d+);/.exec(await loadFile('src/js/app/060-keep-awake.js'))[1];
        assert.ok(MARK > 0 && CLOSE > 0 && MARK + CLOSE < PAGE, 'SW worst case ack->reload ' + (MARK + CLOSE) + 'ms < page post-ack watchdog ' + PAGE + 'ms');
        var e = await boot({ existingTabs: [T7, T9], manualTimers: true, hangSet: true, hangRemove: [7] });
        var r = e.send(cleanMsg(), extSender(7));
        assert.deepStrictEqual(r.responses, [ACK], 'immediate ack');
        await e.advance(MARK + CLOSE - 10);
        assert.strictEqual(e.reloads, 0);
        await e.advance(20);
        assert.strictEqual(e.reloads, 1, 'reload after the 1s marker bound + the 3s close bound');
        var names = e.evNames().filter(function(n) { return n === 'clean-reload-close-failed' || n === 'remove-timeout'; });
        assert.deepStrictEqual(names, ['clean-reload-close-failed', 'remove-timeout']);
        assert.deepStrictEqual(e.ev('clean-reload-marker-failed').map(function(l) { return l.clock; }), [MARK]);
        assert.deepStrictEqual(e.removeCalls, [7], 'only the extension tab, never the web tab');
        assert.deepStrictEqual(e.markerSets(), [], 'the hung marker write never landed');
        var o = e.order.filter(function(x) { return x !== 'set:' + LOG_KEY; });
        assert.ok(o.indexOf('ack:app-clean-reload') === 0 && o.indexOf('set:reopenAppTab') < o.indexOf('remove:7') && o.indexOf('remove:7') < o.indexOf('reload'), 'ack -> marker -> close -> reload: ' + o.join(' '));
        await e.advance(PAGE);
        assert.strictEqual(e.reloads, 1, 'exactly one reload');
        assert.deepStrictEqual(r.responses, [ACK]);
    }, OPTS);

    test('clean reload, a remove hangs: ack at once, reload bounded at 3s', async function() {
        var e = await boot({ existingTabs: [T7, T9], manualTimers: true, hangRemove: [7] });
        var r = e.send(cleanMsg(), extSender(7));
        assert.deepStrictEqual(r.responses, [ACK]);
        await e.advance(10);
        assert.deepStrictEqual(e.store.reopenAppTab, { at: NOW, attempts: 0, tabId: null });
        await e.advance(2900);
        assert.strictEqual(e.reloads, 0);
        await e.advance(200);
        assert.strictEqual(e.reloads, 1);
        assert.strictEqual(e.ev('clean-reload-close-failed').length, 1);
    }, OPTS);

    test('clean reload, tabs.remove throws: remove-failed logged, reload still called at once', async function() {
        var e = await boot({ existingTabs: [T7, T9], manualTimers: true, removeThrows: true });
        var r = e.send(cleanMsg(), extSender(7));
        await e.advance(10);
        assert.deepStrictEqual(r.responses, [ACK]);
        assert.deepStrictEqual(e.removeCalls, [7]);
        assert.strictEqual(e.ev('remove-failed').length, 1);
        assert.strictEqual(e.reloads, 1);
    }, OPTS);

    test('clean reload, tabs.query hangs: reload at the 3s close bound', async function() {
        var e = await boot({ existingTabs: [T7, T9], manualTimers: true, hangQuery: true });
        var r = e.send(cleanMsg(), extSender(7));
        assert.deepStrictEqual(r.responses, [ACK]);
        await e.advance(2990);
        assert.strictEqual(e.reloads, 0);
        await e.advance(20);
        assert.strictEqual(e.reloads, 1);
        assert.strictEqual(e.ev('clean-reload-close-failed').length, 1);
        assert.deepStrictEqual(e.removeCalls, []);
    }, OPTS);

    test('clean reload, runtime.reload throws: logged, the in-flight flag resets, a 2nd request is handled fresh', async function() {
        var e = await boot({ existingTabs: [T7, T9], reloadThrows: true });
        var r1 = e.send(cleanMsg(), extSender(7));
        await flush(3000);
        assert.deepStrictEqual(r1.responses, [ACK]);
        assert.strictEqual(e.reloads, 1);
        assert.strictEqual(e.ev('clean-reload-reload-threw').length, 1);
        var r2 = e.send(cleanMsg(), extSender(null, 'chrome-extension://ext/app.html'));
        assert.deepStrictEqual(r2.responses, [ACK]);
        await flush(3000);
        assert.strictEqual(e.ev('clean-reload-dup').length, 0, 'not treated as a duplicate');
        assert.strictEqual(e.ev('clean-reload').length, 2);
        assert.strictEqual(e.reloads, 2);
    }, OPTS);

    test('clean reload, storage.local.set throws: marker-failed logged, ack still sent, reload still called', async function() {
        var e = await boot({ existingTabs: [T7, T9], setThrows: true });
        var r = e.send(cleanMsg(), extSender(7));
        assert.deepStrictEqual(r.responses, [ACK]);
        await flush(3000);
        assert.strictEqual(e.ev('clean-reload-marker-failed').length, 1);
        assert.deepStrictEqual(e.removed, [7]);
        assert.strictEqual(e.reloads, 1);
        assert.deepStrictEqual(r.responses, [ACK]);
    }, OPTS);

    test('clean reload is single-flight: repeats get the same immediate ack, one marker write, one reload', async function() {
        var e = await boot({ existingTabs: [T7, T9] });
        var rs = [e.send(cleanMsg(), extSender(7)), e.send(cleanMsg(), extSender(7)), e.send(cleanMsg(), extSender(7))];
        rs.forEach(function(r, i) {
            assert.deepStrictEqual(r.responses, [ACK], 'send #' + (i + 1) + ' acked at once');
            assert.strictEqual(r.returnedTrue, false);
        });
        await flush(3000);
        assert.strictEqual(e.ev('clean-reload-dup').length, 2);
        assert.strictEqual(e.markerSets().length, 1);
        assert.strictEqual(e.reloads, 1);
        rs.forEach(function(r) { assert.strictEqual(r.responses.length, 1); });
    }, OPTS);

    test('clean reload from a foreign / untrusted sender does nothing (no reply, no write, no close, no reload)', async function() {
        var e = await boot({ existingTabs: [T7, T9] });
        var senders = [
            { id: 'other', url: 'chrome-extension://other/app.html', tab: { id: 9, windowId: 1 } },
            { id: 'ext', url: 'https://x.service-now.com/now', tab: { id: 9, windowId: 1 } },
            { id: 'ext' },
            undefined
        ];
        senders.forEach(function(s, i) {
            var r = e.send(cleanMsg(), s);
            assert.deepStrictEqual(r.responses, [], 'sender #' + i + ' gets no reply');
            assert.strictEqual(r.returnedTrue, false);
        });
        await flush(3000);
        assert.deepStrictEqual(e.flowSets(), [], 'no marker (or any other non-log) write');
        assert.deepStrictEqual(e.stored().map(function(x) { return x.event; }), ['clean-reload-rejected', 'clean-reload-rejected', 'clean-reload-rejected', 'clean-reload-rejected'],
            'only the persisted reopen log was written');
        assert.deepStrictEqual(e.removeCalls, []);
        assert.strictEqual(e.reloads, 0);
        assert.strictEqual(e.ev('clean-reload-rejected').length, 4);
    }, OPTS);

    test('a clean reload during a pending reopen stops it: the next instance marker survives the old flight', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: [100] });
        assert.strictEqual(e.created.length, 1, 'the reopen created tab 100 and waits for its ready');
        var r = e.send(cleanMsg(), extSender(100));
        assert.deepStrictEqual(r.responses, [ACK]);
        await e.advance(30000);
        assert.deepStrictEqual(e.store.reopenAppTab, { at: NOW, attempts: 0, tabId: null }, 'marker for the next instance kept');
        assert.strictEqual(e.createCalls, 1, 'the old flight created nothing more');
        assert.deepStrictEqual(e.markerSets(), [{ at: NOW - 1000, attempts: 1, tabId: 100 }, { at: NOW, attempts: 0, tabId: null }],
            'no marker write after the clean reload\'s own');
        assert.strictEqual(e.ev('verify-abandoned-left-open').length, 1);
        assert.strictEqual(e.reloads, 1);
    }, LONG);

    // --- m1 / m2 / nit (kept + rewritten) --------------------------------------
    var OLD_TAB = { id: 7, url: APP, windowId: 1, vanishAfterGets: 0 };
    var POPOUT = { id: 50, url: APP + '&chat=c1', windowId: 1 };
    function untouched(e, id, label) {
        label = label ? label + ': ' : '';
        assert.strictEqual(e.focused.indexOf(id), -1, label + 'tab ' + id + ' must never be focused');
        assert.strictEqual(e.reloaded.indexOf(id), -1, label + 'tab ' + id + ' must never be reloaded');
        assert.strictEqual(e.removeCalls.indexOf(id), -1, label + 'tab ' + id + ' must never be removed');
    }

    test('m1: a retry never focuses/reloads/removes an app tab that appeared after the first flight (pop-out)', async function() {
        var modes = [{ label: 'no storage.session' }, { label: 'storage.session', session: {} }, { label: 'storage.session throws', session: {}, sessionThrows: true }];
        for (var i = 0; i < modes.length; i++) {
            var m = modes[i];
            // First flight: old tab 7 is closing; every tabs.create is rejected => no tab, marker kept.
            var e = await boot({ store: { reopenAppTab: NOW - 1000 }, existingTabs: [OLD_TAB], createFailsFirst: 3, session: m.session, sessionThrows: m.sessionThrows });
            await flush(3000);
            assert.strictEqual(e.createCalls, 3, m.label + ': first flight tried 3 creates');
            assert.strictEqual(e.created.length, 0, m.label + ': no tab from the first flight');
            assert.strictEqual('reopenAppTab' in e.store, true, m.label + ': a failed flight keeps the marker');
            e.tabs[POPOUT.id] = Object.assign({}, POPOUT);   // user pops a chat out in the NEW instance
            e.installedFn(); await flush(3000); await e.runTimers();
            untouched(e, POPOUT.id, m.label);
            assert.strictEqual(e.created.length, 1, m.label + ': the retry opened one fresh tab');
            assert.strictEqual(e.created[0].id, 100, m.label + ': a rejected create uses no tab id');
            assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data.tabId; }), [100], m.label);
            assert.strictEqual('reopenAppTab' in e.store, false, m.label + ': marker cleared after the verified retry');
        }
    }, LONG);

    test('m1: a LATER SW lifetime of the same instance reuses the storage.session snapshot (pop-out untouched)', async function() {
        var session = {};   // chrome.storage.session outlives SW restarts of one instance
        var e1 = await boot({ store: { reopenAppTab: NOW - 1000 }, existingTabs: [OLD_TAB], createFailsFirst: 3, session: session });
        await flush(3000);
        assert.strictEqual(e1.createCalls, 3);
        assert.strictEqual('reopenAppTab' in e1.store, true, 'first lifetime failed and kept the marker');
        assert.deepStrictEqual(session.reopenAppTabSuspects && session.reopenAppTabSuspects.ids, [7], 'old-instance snapshot saved');
        // That SW is stopped (its pending timers never fire); a pop-out exists when it restarts.
        var e2 = await boot({ store: e1.store, existingTabs: [POPOUT], session: session });
        await flush(3000); e2.installedFn(); await flush(3000); await e2.runTimers();
        untouched(e2, POPOUT.id, 'restarted SW');
        assert.strictEqual(e2.created.length, 1, 'the restarted SW opened one fresh tab');
        assert.strictEqual(e2.ev('verified').length, 1);
        assert.strictEqual('reopenAppTab' in e2.store, false);
    }, LONG);

    test('m2: a click during the settle wait gets its own tab within ~one poll; the cancelled flight touches nothing', async function() {
        // Tab 7 never closes, so the flight would settle ~2s, then close it and create.
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, existingTabs: [{ id: 7, url: APP, windowId: 1 }] });
        await e.advance(250);                      // one settle poll in: tab 7 still alive
        assert.strictEqual(e.created.length, 0);
        var click = e.clickFn();
        await e.advance(260);                      // ~one poll interval after the click
        assert.strictEqual(e.created.length, 1, "the click's tab opens without waiting out the ~2s settle");
        assert.strictEqual(e.createArgs[0].windowId, undefined, "it is the click's plain tabs.create, not the reopen's");
        await e.advance(10000);                    // drain the settle, call bounds and re-check triggers
        await click;
        assert.strictEqual(e.created.length, 1, 'the cancelled flight created no second tab');
        assert.deepStrictEqual(e.reloaded, [], 'the cancelled flight reloaded nothing');
        assert.deepStrictEqual(e.focused, [], 'the cancelled flight focused nothing');
        assert.deepStrictEqual(e.removeCalls, [], 'the cancelled flight closed nothing');
        assert.strictEqual('reopenAppTab' in e.store, false);
        assert.deepStrictEqual(e.failLogs(), [], 'no failure log for a click-cancelled flight');
    }, OPTS);

    test('m2: a click during the create back-off stops the reopen retries and opens within ~one nap step', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, createFailsFirst: 1 });
        assert.strictEqual(e.createCalls, 1, 'the reopen tabs.create was rejected (back-off before a retry)');
        await e.advance(100);
        var click = e.clickFn();
        await e.advance(260);
        assert.strictEqual(e.created.length, 1, "the click's tab opens without waiting out the back-off");
        assert.strictEqual(e.created[0].id, 100);
        assert.strictEqual(e.createArgs[1].windowId, undefined, "the second create is the click's, not a reopen retry");
        assert.strictEqual(e.createCalls, 2);
        await e.advance(10000); await click;
        assert.strictEqual(e.createCalls, 2, 'no reopen retry after the click');
        assert.deepStrictEqual(e.failLogs(), [], 'no create-failed / gave-up for a click-cancelled flight');
    }, OPTS);

    test('m2: a click while the reopen waits for its tab ready adopts that tab (focused, never closed)', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: [100] });
        assert.strictEqual(e.created.length, 1, 'the reopen created its tab');
        var click = e.clickFn();
        await e.advance(10);
        assert.deepStrictEqual(e.ev('click-adopted').map(function(l) { return l.data.tabId; }), [100]);
        assert.deepStrictEqual(e.focused, [100]);
        await e.advance(10000); await click;
        assert.strictEqual(e.created.length, 1, 'no second tab');
        var end = e.ev('click-adopted-verify-end');
        assert.strictEqual(end.length, 1);
        assert.strictEqual(end[0].clock, 8000, 'the ready wait ran out at 8s');
        assert.deepStrictEqual(e.removeCalls, [], 'the adopted tab is never closed');
        assert.deepStrictEqual(e.ev('ready-timeout'), []);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('nit: a legacy `true` marker is re-persisted as {at,attempts:0,tabId:null}; kept on failure, it then ages out', async function() {
        var e = await boot({ store: { reopenAppTab: true }, createFails: true });
        await flush(3000);
        assert.strictEqual(e.createCalls, 3, 'the legacy marker gets its reopen flight');
        assert.deepStrictEqual(e.store.reopenAppTab, { at: NOW, attempts: 0, tabId: null }, 'converted and kept for the later triggers');
        e.now += 61000;
        e.installedFn(); await flush(3000); await e.runTimers();
        assert.deepStrictEqual(e.ev('marker-dropped').map(function(l) { return l.data; }), [{ why: 'stale' }]);
        assert.strictEqual(e.createCalls, 3, 'an aged-out converted marker is never retried');
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    // --- HANG-FIX / stale guard / happy path (kept + rewritten) -----------------
    test('hang (i): tabs.query never answers - the icon click still calls tabs.create within the ~1.5s bound', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, hangQuery: true });
        await e.advance(100);
        assert.strictEqual(e.createCalls, 0, 'the reopen is stuck in tabs.query');
        var click = e.clickFn();
        await e.advance(1600);
        assert.strictEqual(e.createCalls, 1, 'the click opened its tab within the bound');
        assert.strictEqual(e.createArgs[0].windowId, undefined, "it is the click's own tabs.create");
        await e.advance(20000); await click;
        assert.strictEqual(e.createCalls, 1, 'the timed-out reopen opened nothing more');
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('hang (i): the reopen tabs.create never answers - the click still opens, the create is never repeated', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, hangCreates: 1 });
        assert.strictEqual(e.createCalls, 1, "the reopen's tabs.create is pending forever");
        var click = e.clickFn();
        await e.advance(1600);
        assert.strictEqual(e.createCalls, 2, 'the click called tabs.create within the bound');
        assert.strictEqual(e.createArgs[1].windowId, undefined, "the second create is the click's");
        await e.advance(20000); await click;
        assert.strictEqual(e.createCalls, 2, 'no reopen retry after the timed-out create');
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('hang (i): with no click a stuck reopen gives up at the create bound (marker consumed); a LATER click opens at once', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, session: {}, hangSession: true, hangQuery: true, hangCreates: 1 });
        await e.advance(15000);   // session.get 3s, tabs.query 6s, session.set 9s, tabs.create 12s
        var g = e.ev('gave-up');
        assert.deepStrictEqual(g.map(function(l) { return l.data.why; }), ['create-timeout']);
        assert.strictEqual(g[0].clock, 12000);
        assert.strictEqual('reopenAppTab' in e.store, false, 'no marker left for a surprise tab on a later SW start');
        var click = e.clickFn();
        await e.advance(10);
        assert.strictEqual(e.createCalls, 2, 'the click did not wait at all');
        await e.advance(20000); await click;
        assert.strictEqual(e.created.length, 1, 'exactly the click tab exists');
        assert.deepStrictEqual(e.ev('gave-up').map(function(l) { return l.data.why; }), ['create-timeout'], 'the 25s watchdog stays silent');
    }, OPTS);

    test('hang (i): tabs.get never answers during the settle - no survivor assumed, ONE tab created and verified', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, hangGets: true, existingTabs: [{ id: 7, url: APP, windowId: 1 }] });
        assert.strictEqual(e.createCalls, 0, 'the settle waits on tabs.get(7)');
        await e.advance(30000);
        assert.strictEqual(e.createCalls, 1, 'an unanswered tabs.get is "gone", never a retry create');
        var v = e.ev('verified');
        assert.deepStrictEqual(v.map(function(l) { return l.data.tabId; }), [100]);
        assert.strictEqual(v[0].clock, 3000, 'created and verified right after the 3s tabs.get bound');
        untouched(e, 7, 'unanswered tabs.get');
        assert.strictEqual('reopenAppTab' in e.store, false);
        // F4 (intended change, was: a 2nd tab): the later click (outside the reuse
        // window) focuses the live verified tab 100 (ready at 3s, within
        // READY_TTL); suspect tab 7 stays excluded (never focused / reloaded).
        var click = e.clickFn(); await e.advance(10); await click;
        assert.strictEqual(e.created.length, 1, 'a later click reuses the live reopen tab');
        assert.deepStrictEqual(e.ev('click-focused').map(function(l) { return l.data.tabId; }), [100]);
        untouched(e, 7, 'later click');
    }, OPTS);

    test('stale guard (ii): state a killed SW / another Reload left behind never blocks the click nor steers the reopen', async function() {
        var SN_TAB = { id: 7, url: 'https://x.service-now.com/now', windowId: 1 };
        // (a) snapshot of an older Reload + a marker a killed SW left; this SW start IS the click.
        var e = await boot({ store: { reopenAppTab: NOW - 30000 }, session: { reopenAppTabSuspects: { ids: [7], marker: NOW - 900000, at: NOW - 900000 } }, manualTimers: true, existingTabs: [SN_TAB], holdGet: true });
        var click = e.clickFn();
        e.getGate(); await e.advance(10);
        assert.strictEqual(e.createCalls, 1, 'the click opened its tab at once');
        await e.advance(20000); await click;
        assert.strictEqual(e.created.length, 1);
        untouched(e, 7, 'clicked');
        assert.strictEqual('reopenAppTab' in e.store, false);
        // (b) no click, a legacy bare-array snapshot (no TTL): it is NOT reused.
        var e2 = await boot({ store: { reopenAppTab: NOW - 1000 }, session: { reopenAppTabSuspects: [7] }, existingTabs: [SN_TAB] });
        await flush(3000); await e2.runTimers();
        untouched(e2, 7, 'stale snapshot');
        assert.strictEqual(e2.created.length, 1, 'a fresh app tab was opened');
        assert.strictEqual(e2.ev('verified').length, 1);
        assert.strictEqual('reopenAppTab' in e2.store, false);
    }, OPTS);

    test('happy path (iii): exactly ONE reopened tab; call bounds, re-checks and the watchdog stay silent', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, session: {} });
        await e.advance(30000);   // drain the ready wait, call bounds, watchdog and the 1.5s/5s re-checks
        assert.strictEqual(e.created.length, 1);
        assert.match(e.created[0].url, /app\.html\?mode=tab$/);
        assert.deepStrictEqual(e.evNames(), ['created', 'ready', 'verified']);
        assert.deepStrictEqual(e.failLogs(), [], 'no timeout / watchdog / failure log');
        assert.strictEqual('reopenAppTab' in e.store, false);
        // F4 (intended change, was: a 2nd tab): the later click (outside the reuse
        // window) focuses the live reopen tab (ready ~0s, within READY_TTL).
        var click = e.clickFn(); await e.advance(10); await click;
        assert.strictEqual(e.created.length, 1, 'a later click reuses the live reopen tab');
        assert.deepStrictEqual(e.ev('click-focused').map(function(l) { return l.data.tabId; }), [e.created[0].id]);
        assert.deepStrictEqual(e.failLogs(), []);
    }, OPTS);

    test('a ready that arrives before tabs.create resolves still verifies the tab (recorded first, awaited:false)', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, readyBeforeCreateResolves: true });
        await flush(3000);
        assert.strictEqual(e.created.length, 1);
        assert.strictEqual(e.ev('ready')[0].data.awaited, false, 'no wait was pending when the ready came');
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data.tabId; }), [100]);
        assert.deepStrictEqual(e.ev('ready-timeout'), []);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    // --- Max attempts / SW restart (new) ---------------------------------------
    var T55 = { id: 55, url: APP, windowId: 1 };
    test('noReady: the 1st unverified tab is closed, the LAST is left open; gave-up max-attempts at 16s', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: true });
        await e.advance(8000);
        assert.deepStrictEqual(e.removeCalls, [100]);
        assert.strictEqual(e.created.length, 2, '101 created at 8s');
        await e.advance(8000);
        var g = e.ev('gave-up');
        assert.deepStrictEqual(g.map(function(l) { return l.data; }), [{ why: 'max-attempts', tabId: 101, attempts: 2 }]);
        assert.strictEqual(g[0].clock, 16000);
        assert.deepStrictEqual(e.markerSets(), [{ at: NOW - 1000, attempts: 1, tabId: 100 }, { at: NOW - 1000, attempts: 2, tabId: 101 }]);
        assert.deepStrictEqual(e.removeCalls, [100], 'the last tab is never closed');
        assert.ok(!!e.tabs[101], '101 stays open');
        assert.strictEqual('reopenAppTab' in e.store, false);
        var n = e.createCalls;
        e.installedFn(); await e.advance(10000);
        assert.strictEqual(e.createCalls, n, 'a later trigger creates nothing');
    }, LONG);

    test('SW restart (a): marker {attempts:1,tabId:55}, no ready from 55 => 55 closed (stale-verify-closed), 100 verified as attempt 2', async function() {
        var e = await boot({ store: { reopenAppTab: { at: NOW - 1000, attempts: 1, tabId: 55 } }, existingTabs: [T55] });
        await flush(3000);
        assert.deepStrictEqual(e.ev('stale-verify-closed').map(function(l) { return l.data; }), [{ tabId: 55, attempts: 1, removed: 1 }]);
        assert.deepStrictEqual(e.removeCalls, [55]);
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data; }), [{ tabId: 100, attempt: 2 }]);
        assert.deepStrictEqual(e.markerSets(), [{ at: NOW - 1000, attempts: 2, tabId: 100 }]);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    test('SW restart (b), deviation 4: marker at max attempts + a live tab => that tab is LEFT OPEN, nothing created, gave-up', async function() {
        var e = await boot({ store: { reopenAppTab: { at: NOW - 1000, attempts: 2, tabId: 55 } }, existingTabs: [T55] });
        await flush(3000);
        assert.deepStrictEqual(e.removeCalls, [], 'the last tab is never closed');
        assert.ok(!!e.tabs[55], 'tab 55 still open');
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.ev('gave-up').map(function(l) { return l.data; }), [{ why: 'restart-max-attempts', attempts: 2, tabId: 55, leftOpen: true }]);
        assert.deepStrictEqual(e.ev('stale-verify-closed'), []);
        assert.strictEqual('reopenAppTab' in e.store, false);
        var gets = e.gets;
        e.installedFn(); await flush(); await e.runTimers();
        assert.strictEqual(e.gets, gets, 'st.done: later triggers do not re-read the marker');
        assert.strictEqual(e.createCalls, 0);
    }, OPTS);

    test('SW restart (c): the ready that woke the SW is recorded before the marker read => 55 verified (restart), no create, no close', async function() {
        var e = await boot({ store: { reopenAppTab: { at: NOW - 1000, attempts: 1, tabId: 55 } }, existingTabs: [T55], holdGet: true });
        var r = e.ready(55);
        assert.deepStrictEqual(r.responses, [{ ok: true }]);
        e.getGate(); await flush(3000); await e.runTimers();
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data; }), [{ tabId: 55, attempt: 1, restart: true }]);
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.removeCalls, []);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    // --- Review 1 fixes: MED-1, LOW-1, LOW-2 (fix b1) ----------------------------
    // LOW-3 (opportunistic): timelines derived from the slice's own constants.
    async function K(name) {
        var m = new RegExp('var ' + name + ' = ([0-9 *]+);').exec(await slice());
        if (!m) throw new Error('constant missing in the APP-TAB-REOPEN slice: ' + name);
        return Function('return (' + m[1] + ');')();
    }
    test('MED-1: a tab still loading at READY_MS gets ONE more READY_MS; its late ready verifies it (no close, no 2nd tab)', async function() {
        var READY = await K('REOPEN_APP_TAB_READY_MS');
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: [100] });
        e.tabs[100].status = 'loading';
        await e.advance(READY);
        assert.deepStrictEqual(e.ev('ready-slow-extended').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 100, attempt: 1, ms: READY }, READY]]);
        assert.deepStrictEqual(e.removeCalls, [], 'the loading tab is not closed at READY_MS');
        await e.advance(READY - 1000);
        e.ready(100); await e.advance(10);
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 100, attempt: 1, extended: true }, 2 * READY - 1000]]);
        await e.advance(30000);
        assert.deepStrictEqual(e.removeCalls, []);
        assert.strictEqual(e.createCalls, 1, 'no second tab');
        assert.deepStrictEqual(e.failLogs(), []);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, LONG);
    test('MED-1: still loading after the ONE extension => closed at 2*READY_MS; attempt 2 is not extended past the watchdog and ends before it', async function() {
        var READY = await K('REOPEN_APP_TAB_READY_MS'), PEEK = await K('REOPEN_APP_TAB_PEEK_MS'), WD = await K('REOPEN_APP_TAB_WATCHDOG_MS');
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: true });
        e.tabs[100].status = 'loading';
        await e.advance(2 * READY);
        assert.deepStrictEqual(e.ev('ready-slow-extended').map(function(l) { return l.data.tabId; }), [100], 'extended once');
        assert.deepStrictEqual(e.ev('ready-timeout').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 100, attempt: 1, ms: 2 * READY, extended: true }, 2 * READY]]);
        assert.deepStrictEqual(e.removeCalls, [100]);
        assert.deepStrictEqual(e.ev('created').map(function(l) { return [l.data.tabId, l.clock]; }), [[100, 0], [101, 2 * READY]]);
        e.tabs[101].status = 'loading';
        assert.ok(3 * READY + PEEK + READY > WD && 3 * READY < WD, 'precondition: a 2nd extension would outlive the watchdog');
        await e.advance(READY);
        assert.strictEqual(e.ev('ready-slow-extended').length, 1, 'no extension that would outlive the watchdog');
        assert.deepStrictEqual(e.ev('gave-up').map(function(l) { return [l.data.why, l.clock]; }), [['max-attempts', 3 * READY]]);
        await e.advance(WD);
        assert.strictEqual(e.ev('gave-up').length, 1, 'no watchdog give-up: the flight ended before it');
        assert.deepStrictEqual(e.removeCalls, [100], 'the last tab is never closed');
        assert.ok(!!e.tabs[101]);
    }, LONG);
    test('MED-1: the peek never answers (bounded PEEK_MS) or rejects => today\'s close + attempt 2', async function() {
        var READY = await K('REOPEN_APP_TAB_READY_MS'), PEEK = await K('REOPEN_APP_TAB_PEEK_MS');
        assert.ok(PEEK > 0 && PEEK <= 1000, 'the peek is bounded to <= 1s');
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: [100], hangGets: true });
        e.tabs[100].status = 'loading';
        await e.advance(READY + PEEK - 1);
        assert.deepStrictEqual(e.removeCalls, [], 'still inside the bounded peek');
        await e.advance(2);
        assert.deepStrictEqual(e.removeCalls, [100]);
        assert.deepStrictEqual(e.ev('ready-slow-extended'), []);
        assert.deepStrictEqual(e.ev('ready-timeout').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 100, attempt: 1, ms: READY }, READY + PEEK]]);
        await e.advance(100);
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data.tabId; }), [101]);
        var e2 = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: [100] });
        e2.tabs[100].status = 'loading'; e2.tabs[100].vanishAfterGets = 0; // tabs.get rejects
        await e2.advance(READY);
        assert.deepStrictEqual(e2.ev('ready-timeout').map(function(l) { return l.clock; }), [READY]);
        assert.deepStrictEqual(e2.ev('ready-slow-extended'), []);
        assert.deepStrictEqual(e2.removeCalls, [100]);
    }, LONG);
    test('LOW-1: SW restart, the waking ready of 55 lands just AFTER the marker read => 55 verified (restart), never closed', async function() {
        var e = await boot({ store: { reopenAppTab: { at: NOW - 1000, attempts: 1, tabId: 55 } }, existingTabs: [T55], holdGet: true, manualTimers: true });
        e.getGate(); await flush(3000);
        assert.deepStrictEqual(e.removeCalls, [], 'no close while its ready may still be in flight');
        e.ready(55); await e.advance(10);
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data; }), [{ tabId: 55, attempt: 1, restart: true }]);
        await e.advance(30000);
        assert.deepStrictEqual(e.removeCalls, []);
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.ev('stale-verify-closed'), []);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, LONG);
    test('LOW-1: no ready within STALE_READY_MS => 55 closed at that bound (stale-verify-closed), attempt 2 verified', async function() {
        var W = await K('REOPEN_APP_TAB_STALE_READY_MS');
        var e = await boot({ store: { reopenAppTab: { at: NOW - 1000, attempts: 1, tabId: 55 } }, existingTabs: [T55], manualTimers: true });
        await e.advance(W - 1);
        assert.deepStrictEqual(e.removeCalls, []);
        await e.advance(2);
        assert.deepStrictEqual(e.removeCalls, [55]);
        assert.deepStrictEqual(e.ev('stale-verify-closed').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 55, attempts: 1, removed: 1 }, W]]);
        await e.advance(100);
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data; }), [{ tabId: 100, attempt: 2 }]);
    }, LONG);
    test('LOW-2: marker at max attempts but its tab is GONE (or tabs.get hangs) => gave-up leftOpen:false from a bounded tabs.get', async function() {
        var e = await boot({ store: { reopenAppTab: { at: NOW - 1000, attempts: 2, tabId: 55 } } });
        await flush(3000);
        assert.deepStrictEqual(e.ev('gave-up').map(function(l) { return l.data; }), [{ why: 'restart-max-attempts', attempts: 2, tabId: 55, leftOpen: false }]);
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.removeCalls, []);
        assert.strictEqual('reopenAppTab' in e.store, false);
        var CALL = await K('REOPEN_APP_TAB_CALL_MS');
        var h = await boot({ store: { reopenAppTab: { at: NOW - 1000, attempts: 2, tabId: 55 } }, existingTabs: [T55], hangGets: true, manualTimers: true });
        await h.advance(CALL - 1);
        assert.deepStrictEqual(h.ev('gave-up'), [], 'waits for the bounded tabs.get');
        await h.advance(2);
        assert.deepStrictEqual(h.ev('gave-up').map(function(l) { return [l.data.leftOpen, l.clock]; }), [[false, CALL]]);
        assert.deepStrictEqual(h.removeCalls, []);
        assert.ok(!!h.tabs[55]);
    }, LONG);

    // --- MED-A (fix meda): no retry that the watchdog can cut in half ---------------
    // A retry closes its tab BEFORE the next create, so it is only made when the
    // close (CLEAN_REMOVE_MS) + that create (getLastFocused + tabs.create, CALL_MS
    // each) end by the flight's watchdog; else the tab is kept (gave-up no-budget).
    // storage.session hangs (2 bounded calls before the first create), every
    // tabs.create answers `slow` ms late and 100's remove closes it, never answers.
    async function medaK() {
        return { CALL: await K('REOPEN_APP_TAB_CALL_MS'), CLOSE: await K('REOPEN_APP_TAB_CLEAN_REMOVE_MS'), READY: await K('REOPEN_APP_TAB_READY_MS'),
            PEEK: await K('REOPEN_APP_TAB_PEEK_MS'), WD: await K('REOPEN_APP_TAB_WATCHDOG_MS') };
    }
    function medaBoot(slow) {
        return boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, session: {}, hangSession: true, slowCreateMs: slow, noReady: [100], hangRemoveClosed: [100] });
    }
    test('MED-A (i): a post-extension retry with no budget left keeps tab 1 (gave-up no-budget); no close, no 2nd tab, the watchdog stays silent', async function() {
        var k = await medaK(), SLOW = 1000, C1 = 2 * k.CALL + SLOW, E = C1 + 2 * k.READY;
        assert.ok(C1 + k.READY + k.PEEK + k.READY <= k.WD, 'precondition: the ONE extension fits before the watchdog');
        assert.ok(E + k.CLOSE + 2 * k.CALL > k.WD, 'precondition: no budget left for a close + a create');
        assert.ok(E + k.CLOSE > k.WD, 'precondition: pre-fix, the watchdog lands during the close');
        var e = await medaBoot(SLOW);
        await e.advance(C1);
        assert.deepStrictEqual(e.ev('created').map(function(l) { return [l.data.tabId, l.clock]; }), [[100, C1]]);
        e.tabs[100].status = 'loading';
        await e.advance(E - C1);
        assert.deepStrictEqual(e.ev('ready-slow-extended').map(function(l) { return [l.data.tabId, l.clock]; }), [[100, C1 + k.READY]]);
        assert.deepStrictEqual(e.ev('ready-timeout').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 100, attempt: 1, ms: 2 * k.READY, extended: true }, E]]);
        assert.deepStrictEqual(e.ev('gave-up').map(function(l) { return [l.data, l.clock]; }), [[{ why: 'no-budget', tabId: 100, attempts: 1, leftOpen: true, left: k.WD - E }, E]]);
        assert.deepStrictEqual(e.removeCalls, [], 'tab 1 is not closed');
        assert.deepStrictEqual(e.ev('closed-unverified'), []);
        assert.strictEqual('reopenAppTab' in e.store, false, 'the marker is removed');
        await e.advance(k.WD);
        assert.ok(!!e.tabs[100], 'the app tab stays open');
        assert.strictEqual(e.createCalls, 1, 'no second tab');
        assert.strictEqual(e.ev('gave-up').length, 1, 'the watchdog is silent: the flight ended at E');
        assert.deepStrictEqual(e.markerSets(), [{ at: NOW - 1000, attempts: 1, tabId: 100 }]);
    }, LONG);
    test('MED-A (ii): boundary control: a retry whose close + create end exactly at the watchdog is made (attempt 2 verified); 1ms later it is not (no-budget)', async function() {
        var k = await medaK(), T1 = k.WD - k.CLOSE - 2 * k.CALL, SLOW = T1 - k.READY - 2 * k.CALL;
        assert.ok(SLOW > 0 && SLOW + 1 < k.CALL, 'precondition: each create answers inside its CALL_MS bound');
        var e = await medaBoot(SLOW);   // 100 stays 'complete': no extension
        await e.advance(k.WD);
        assert.deepStrictEqual(e.ev('ready-timeout').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 100, attempt: 1, ms: k.READY }, T1]]);
        assert.deepStrictEqual(e.removeCalls, [100]);
        assert.deepStrictEqual(e.ev('closed-unverified').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 100, attempt: 1, removed: 0 }, T1 + k.CLOSE]]);
        assert.deepStrictEqual(e.ev('created').map(function(l) { return [l.data.tabId, l.clock]; }), [[100, T1 - k.READY], [101, T1 + k.CLOSE + SLOW]]);
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data; }), [{ tabId: 101, attempt: 2 }]);
        assert.deepStrictEqual(e.ev('gave-up'), [], 'no no-budget at the exact boundary');
        var b = await medaBoot(SLOW + 1);
        await b.advance(k.WD);
        assert.deepStrictEqual(b.ev('gave-up').map(function(l) { return [l.data, l.clock]; }), [[{ why: 'no-budget', tabId: 100, attempts: 1, leftOpen: true, left: k.WD - (T1 + 1) }, T1 + 1]]);
        assert.deepStrictEqual(b.removeCalls, [], 'tab 1 is not closed');
        assert.strictEqual(b.createCalls, 1, 'no second tab');
        assert.ok(!!b.tabs[100], 'tab 1 is kept');
        assert.strictEqual('reopenAppTab' in b.store, false);
    }, LONG);

    // --- Adopt on the final attempt (new) -----------------------------------------
    test('a click while the FINAL attempt waits for its ready adopts it: focused, never closed, no max-attempts give-up', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: true });
        await e.advance(8000);
        assert.deepStrictEqual(e.removeCalls, [100], 'attempt 1 (100) closed unverified at 8s');
        assert.deepStrictEqual(e.ev('created').map(function(l) { return l.data.tabId; }), [100, 101], '101 created and verifying');
        var click = e.clickFn();
        await e.advance(10);
        assert.deepStrictEqual(e.focused, [101]);
        assert.deepStrictEqual(e.ev('click-adopted').map(function(l) { return l.data; }), [{ tabId: 101 }]);
        await e.advance(10000); await click;
        var end = e.ev('click-adopted-verify-end');
        assert.deepStrictEqual(end.map(function(l) { return l.data; }), [{ tabId: 101, attempt: 2 }]);
        assert.strictEqual(end[0].clock, 16000, 'the final ready wait ran out at 16s');
        assert.deepStrictEqual(e.removeCalls, [100], 'the adopted final tab is never closed');
        assert.ok(!!e.tabs[101], '101 stays open');
        assert.strictEqual(e.createCalls, 2, 'the click opened no tab of its own');
        await e.advance(10000);   // past the 25s watchdog: the flight settled at 16s
        assert.deepStrictEqual(e.ev('gave-up'), [], 'no max-attempts / watchdog give-up');
        assert.deepStrictEqual(e.ev('ready-timeout').map(function(l) { return l.data.tabId; }), [100], 'only attempt 1 timed out');
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, LONG);

    // --- Ready handling (new) -----------------------------------------------------
    var FOREIGN = { id: 'other', url: 'chrome-extension://other/app.html' };
    var WEBPAGE = { id: 'ext', url: 'https://example.com/app.html' };   // our content script on a web page
    function withTab(s, id) { return Object.assign({ tab: { id: id, windowId: 1 } }, s); }
    test('app-tab-ready: only a trusted extension page WITH a tab is recorded + answered {ok:true}; other types get no reply', async function() {
        var e = await boot({ store: {} });
        var noTab = e.send({ type: 'app-tab-ready', bootId: 'x' }, { id: 'ext', url: APP });
        assert.deepStrictEqual(noTab.responses, [], 'no sender.tab => no reply');
        assert.strictEqual(noTab.returnedTrue, false);
        assert.deepStrictEqual(e.send({ type: 'app-tab-ready', bootId: 'x' }, withTab(FOREIGN, 5)).responses, [], 'foreign extension => no reply');
        assert.deepStrictEqual(e.send({ type: 'app-tab-ready', bootId: 'x' }, withTab(WEBPAGE, 5)).responses, [], 'web-page sender => no reply');
        assert.deepStrictEqual(e.ev('ready'), [], 'nothing recorded for an untrusted / tab-less sender');
        var ok = e.ready(5);
        assert.deepStrictEqual(ok.responses, [{ ok: true }]);
        assert.strictEqual(ok.returnedTrue, false, 'answered synchronously');
        assert.deepStrictEqual(e.ev('ready').map(function(l) { return l.data; }), [{ tabId: 5, bootId: 'b5', nav: 'navigate', prevBoot: null, awaited: false }]);
        var other = e.send({ type: 'something-else' }, extSender(7));
        assert.deepStrictEqual(other.responses, [], 'other message types are left to the other listeners');
        assert.strictEqual(other.returnedTrue, false);
        [null, 'app-tab-ready', 42].forEach(function(m) {
            assert.deepStrictEqual(e.send(m, extSender(7)).responses, [], 'non-object message ' + JSON.stringify(m) + ' => no reply');
        });
        assert.strictEqual(e.ev('ready').length, 1);
        assert.strictEqual(e.createCalls, 0);
    }, OPTS);

    test('app-tab-ready from an untrusted sender naming the verifying tab does NOT verify it (8s timeout, 101 verified)', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, manualTimers: true, noReady: [100] });
        assert.strictEqual(e.created.length, 1, 'the reopen created 100');
        assert.deepStrictEqual(e.send({ type: 'app-tab-ready', bootId: 'x' }, withTab(FOREIGN, 100)).responses, []);
        assert.deepStrictEqual(e.send({ type: 'app-tab-ready', bootId: 'x' }, withTab(WEBPAGE, 100)).responses, []);
        await e.advance(8000);
        assert.deepStrictEqual(e.ev('ready-timeout').map(function(l) { return l.data.tabId; }), [100]);
        assert.deepStrictEqual(e.removeCalls, [100]);
        await e.advance(10);
        assert.deepStrictEqual(e.ev('verified').map(function(l) { return l.data; }), [{ tabId: 101, attempt: 2 }]);
        assert.strictEqual('reopenAppTab' in e.store, false);
    }, OPTS);

    // --- Watchdog timeline (new; re-timed for MED-A: G3-B) -------------------------
    // storage.session hangs (2 bounded calls), every tabs.create answers SLOW late,
    // no tab ever readies and 100's remove hangs: created 100 @C1 (7s), ready-
    // timeout @T1 (15s; the retry still fits: T1 + CLOSE + 2*CALL <= WD), remove-
    // timeout + closed-unverified{removed:0} @T1+CLOSE (18s), created 101 @C2 (19s),
    // benign watchdog @WD (25s) while 101 verifies (its ready wait ends @END, 27s).
    async function watchdogBoot() {
        var CALL = await K('REOPEN_APP_TAB_CALL_MS'), CLOSE = await K('REOPEN_APP_TAB_CLEAN_REMOVE_MS'), READY = await K('REOPEN_APP_TAB_READY_MS'), WD = await K('REOPEN_APP_TAB_WATCHDOG_MS');
        var SLOW = 1000, C1 = 2 * CALL + SLOW, T1 = C1 + READY, C2 = T1 + CLOSE + SLOW;
        assert.ok(T1 + CLOSE + 2 * CALL <= WD, 'precondition: attempt 1 times out with budget left for the retry');
        assert.ok(C2 < WD && C2 + READY > WD, 'precondition: the watchdog lands while 101 verifies');
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, session: {}, hangSession: true, slowCreateMs: SLOW, noReady: true, hangRemove: [100], manualTimers: true });
        await e.advance(WD);
        var at = function(name) { return e.ev(name).map(function(l) { return l.clock; }); };
        assert.deepStrictEqual(e.ev('created').map(function(l) { return [l.data.tabId, l.clock]; }), [[100, C1], [101, C2]]);
        assert.deepStrictEqual(at('ready-timeout'), [T1]);
        assert.deepStrictEqual(at('remove-timeout'), [T1 + CLOSE]);
        assert.deepStrictEqual(e.ev('closed-unverified').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 100, attempt: 1, removed: 0 }, T1 + CLOSE]]);
        assert.deepStrictEqual(e.ev('gave-up').map(function(l) { return [l.data.why, l.data.verifying, l.clock]; }), [['watchdog', 101, WD]]);
        assert.strictEqual('reopenAppTab' in e.store, false, 'the watchdog dropped the marker');
        e.wd = { WD: WD, T1: T1, END: C2 + READY };
        return e;
    }
    function watchdogEnd(e) {
        assert.strictEqual(e.createCalls, 2);
        assert.deepStrictEqual(e.removeCalls, [100], '101 is never closed');
        assert.ok(!!e.tabs[101], '101 stays open');
        assert.deepStrictEqual(e.sets.filter(function(s) { return 'reopenAppTab' in s.o && s.clock >= e.wd.WD; }), [], 'no marker write after the watchdog');
        assert.strictEqual('reopenAppTab' in e.store, false);
        assert.strictEqual(e.ev('gave-up').length, 1, 'only the watchdog give-up');
        assert.deepStrictEqual(e.ev('not-verified-keep-marker'), []);
    }
    test('watchdog timeline (a): the WD give-up keeps the verifying tab; a click at WD+0.5s adopts it (verify-end when its ready wait ends)', async function() {
        var e = await watchdogBoot(), t = e.wd;
        await e.advance(500);
        var click = e.clickFn();
        await e.advance(10);
        assert.deepStrictEqual(e.focused, [101]);
        assert.deepStrictEqual(e.ev('click-adopted').map(function(l) { return [l.data.tabId, l.clock]; }), [[101, t.WD + 500]]);
        await e.advance(t.END - t.WD); await click;
        assert.deepStrictEqual(e.ev('click-adopted-verify-end').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 101, attempt: 2 }, t.END]]);
        assert.deepStrictEqual(e.ev('verify-abandoned-left-open'), []);
        assert.deepStrictEqual(e.ev('ready-timeout').map(function(l) { return l.clock; }), [t.T1], 'the adopted tab is not reported as timed out');
        await e.advance(10000);
        assert.strictEqual(e.createCalls, 2, 'the click opened no tab of its own');
        watchdogEnd(e);
    }, LONG);

    test('watchdog timeline (b): no click => the verifying tab is left open when its ready wait ends (verify-abandoned-left-open), nothing more', async function() {
        var e = await watchdogBoot(), t = e.wd;
        await e.advance(t.END - t.WD + 500);
        assert.deepStrictEqual(e.ev('verify-abandoned-left-open').map(function(l) { return [l.data, l.clock]; }), [[{ tabId: 101, attempt: 2 }, t.END]]);
        assert.deepStrictEqual(e.ev('ready-timeout').map(function(l) { return l.clock; }), [t.T1, t.END]);
        assert.deepStrictEqual(e.ev('click-adopted'), []);
        assert.deepStrictEqual(e.focused, []);
        await e.advance(10000);
        watchdogEnd(e);
    }, LONG);

    // --- B2: persisted reopen log (appagentReopenLog ring buffer) --------------
    // Entries come through the REAL listener: a foreign clean-reload request only
    // logs clean-reload-rejected {senderId, url}; the url carries the index.
    function rej(e, i) { return e.send(cleanMsg(), { id: 'other', url: 'chrome-extension://other/' + i }); }
    function urls(list) { return list.map(function(x) { return x.url; }); }
    function range(a, b) { var r = []; for (var i = a; i <= b; i++) r.push('chrome-extension://other/' + i); return r; }

    test('reopen log: 55 appends keep the 50 newest, in order, each {at, event, ...data}', async function() {
        var e = await boot({});
        for (var i = 1; i <= 55; i++) rej(e, i);
        await flush(6000);
        var s = e.stored();
        assert.strictEqual(s.length, 50);
        assert.deepStrictEqual(urls(s), range(6, 55), 'the oldest 5 trimmed, newest last');
        assert.deepStrictEqual(s[49], { at: NOW, event: 'clean-reload-rejected', senderId: 'other', url: 'chrome-extension://other/55' });
        assert.strictEqual(e.logSets().length, 55, 'one set per append');
        assert.ok(e.logSets().every(function(x) { return x.o[LOG_KEY].length <= 50; }), 'never more than 50 stored');
        assert.strictEqual(e.ev('clean-reload-rejected').length, 55, 'console log unchanged');
    }, LONG);

    test('reopen log: back-to-back calls are serialized in call order (get, set, get, set ...)', async function() {
        var e = await boot({});
        for (var i = 1; i <= 5; i++) rej(e, i);
        assert.deepStrictEqual(e.logOps, [], 'no storage call inside _reopenLog itself');
        await flush(3000);
        assert.deepStrictEqual(e.logOps, ['get1', 'set1', 'get2', 'set2', 'get3', 'set3', 'get4', 'set4', 'get5', 'set5']);
        assert.deepStrictEqual(urls(e.stored()), range(1, 5), 'no append lost to an overlapping read-modify-write');
        assert.deepStrictEqual(e.logSets().map(function(x) { return x.o[LOG_KEY].length; }), [1, 2, 3, 4, 5]);
    }, OPTS);

    test('reopen log: a throwing (or empty) get skips that entry, never writes a partial log, and the chain continues', async function() {
        var e = await boot({ logGet: function(n) { return n === 2 ? 'throw' : n === 3 ? 'none' : null; } });
        for (var i = 1; i <= 4; i++) rej(e, i);
        await flush(3000);
        assert.deepStrictEqual(e.logOps, ['get1', 'set1', 'get2', 'get3', 'get4', 'set2']);
        assert.deepStrictEqual(urls(e.stored()), range(1, 1).concat(range(4, 4)));
        assert.deepStrictEqual(e.logSets().map(function(x) { return urls(x.o[LOG_KEY]); }), [range(1, 1), range(1, 1).concat(range(4, 4))],
            'every write kept the stored entries');
    }, OPTS);

    test('reopen log: a throwing set is dropped and the chain continues', async function() {
        var e = await boot({ logSet: function(n) { return n === 1 ? 'throw' : null; } });
        for (var i = 1; i <= 3; i++) rej(e, i);
        await flush(3000);
        assert.deepStrictEqual(e.logOps, ['get1', 'set1', 'get2', 'set2', 'get3', 'set3']);
        assert.deepStrictEqual(urls(e.stored()), range(2, 3));
    }, OPTS);

    test('reopen log: a hung get is bounded (1.8s), later entries still persist, its late answer writes nothing', async function() {
        var e = await boot({ manualTimers: true, logGet: function(n) { return n === 1 ? 'hang' : null; } });
        for (var i = 1; i <= 3; i++) rej(e, i);
        await e.advance(LOG_STEP_MS - 10);
        assert.deepStrictEqual(e.logOps, ['get1'], 'the chain waits for the bounded get');
        assert.deepStrictEqual(e.stored(), []);
        await e.advance(20);
        assert.deepStrictEqual(e.logOps, ['get1', 'get2', 'set1', 'get3', 'set2']);
        assert.deepStrictEqual(urls(e.stored()), range(2, 3), 'entry 1 skipped, 2 and 3 kept');
        e.logGetLate.forEach(function(f) { f(); });
        await e.advance(5000);
        assert.strictEqual(e.logSets().length, 2, 'the late get answer is ignored');
        assert.deepStrictEqual(urls(e.stored()), range(2, 3));
    }, OPTS);

    test('reopen log: with its storage hung, the clean-reload ack stays synchronous and reload still runs at once', async function() {
        var e = await boot({ existingTabs: [T7, T9], manualTimers: true, logGet: function(n) { return n === 1 ? 'hang' : null; }, logSet: function() { return 'hang'; } });
        e.order = [];
        var r = e.send(cleanMsg(), extSender(7));
        assert.deepStrictEqual(r.responses, [ACK], 'acked synchronously');
        await e.advance(10);
        assert.strictEqual(e.reloads, 1, 'reload did not wait for the log');
        assert.deepStrictEqual(e.order.filter(function(x) { return x !== 'set:' + LOG_KEY; }), ['ack:app-clean-reload', 'set:reopenAppTab', 'remove:7', 'reload']);
        assert.deepStrictEqual(e.store.reopenAppTab, { at: NOW, attempts: 0, tabId: null });
        assert.deepStrictEqual(e.logOps, ['get1'], 'the log still waits on its hung get');
        await e.advance(LOG_STEP_MS);
        assert.deepStrictEqual(e.logOps, ['get1', 'get2', 'set1'], 'hung get bounded: the next entry went on (its set hangs)');
        rej(e, 1);
        await e.advance(LOG_STEP_MS - 30);
        assert.deepStrictEqual(e.logOps, ['get1', 'get2', 'set1'], 'queued behind the hung set');
        await e.advance(40);
        assert.deepStrictEqual(e.logOps, ['get1', 'get2', 'set1', 'get3', 'set2'], 'hung set bounded too');
        assert.deepStrictEqual(e.failLogs(), []);
    }, OPTS);

    test('reopen log: no chrome.storage => never throws; the clean reload still acks and reloads', async function() {
        var e = await boot({ existingTabs: [T7, T9], noStorage: true });
        var r = e.send(cleanMsg(), extSender(7));
        assert.deepStrictEqual(r.responses, [ACK]);
        await flush(3000);
        assert.strictEqual(e.reloads, 1);
        assert.strictEqual(e.ev('clean-reload').length, 1, 'console log unchanged');
        assert.strictEqual(e.ev('clean-reload-marker-failed').length, 1);
        assert.deepStrictEqual(rej(e, 1).responses, []);
        assert.strictEqual(e.ev('clean-reload-rejected').length, 1);
        assert.deepStrictEqual(e.sets, []);
    }, OPTS);

    test('reopen log: entry data is capped (~500 chars) and at / event stay the log time and name', async function() {
        var e = await boot({ existingTabs: [T7, T9] });
        e.send({ type: 'app-clean-reload', reason: 'r', at: NOW - 5 }, extSender(7));
        rej(e, new Array(2001).join('x'));
        await flush(3000);
        var s = e.stored();
        assert.deepStrictEqual(s[0], { at: NOW, event: 'clean-reload', reason: 'r', data_at: NOW - 5, url: APP, tabId: 7 });
        assert.strictEqual(s[1].event, 'clean-reload-rejected');
        assert.strictEqual(s[1].truncated, true);
        assert.strictEqual(s[1].data.length, 500);
        assert.ok(JSON.stringify(s[1]).length < 700, 'small entry');
        assert.strictEqual(e.reloads, 1);
    }, OPTS);
});

// --- Page side: app/070-app-tab-ready.js (PR B1) ---------------------------------
// Runs the REAL page script with injected chrome / sessionStorage / performance /
// setTimeout / Date / Math: one app-tab-ready per load, exactly one retry at 1.5s
// when no {ok:true} came back, and only the tab's own sessionStorage boot record.
describe('APP-TAB-REOPEN: page-side ready handshake (app/070-app-tab-ready.js)', function() {
    var AT = 1790000000000;
    var KEY = 'appagentPageAlive';
    var OPTS = { tags: ['unit'], timeout: 3000 };
    var _src = null;
    async function source() { return _src || (_src = await loadFile('src/js/app/070-app-tab-ready.js')); }
    // opts.backing: sessionStorage backing object (share it = the next load of the same
    // tab); getThrows / setThrows; at (Date.now); nav (navigation entry type) / navThrows;
    // lastError (rt.lastError message); sendThrows; noSend / noRuntime / noChrome.
    async function load(opts) {
        opts = opts || {};
        var r = { sent: [], cbs: [], timers: [], backing: opts.backing || {}, ssWrites: 0, lastErrorReads: 0 };
        var ss = {
            getItem: function(k) { if (opts.getThrows) throw new Error('SecurityError'); return Object.prototype.hasOwnProperty.call(r.backing, k) ? r.backing[k] : null; },
            setItem: function(k, v) { r.ssWrites++; if (opts.setThrows) throw new Error('QuotaExceededError'); r.backing[k] = String(v); }
        };
        var rt = { sendMessage: function(msg, cb) {
            r.sent.push(JSON.parse(JSON.stringify(msg))); r.cbs.push(cb);
            if (opts.sendThrows) throw new Error('Extension context invalidated.');
        } };
        Object.defineProperty(rt, 'lastError', { get: function() { r.lastErrorReads++; return opts.lastError ? { message: opts.lastError } : undefined; } });
        if (opts.noSend) delete rt.sendMessage;
        var chrome = opts.noChrome ? undefined : (opts.noRuntime ? {} : { runtime: rt });
        var perf = { getEntriesByType: function(t) { if (opts.navThrows) throw new Error('unsupported'); return t === 'navigation' ? [{ type: opts.nav || 'navigate' }] : []; } };
        var fakeSetTimeout = function(fn, ms) { r.timers.push({ fn: fn, ms: ms }); return r.timers.length; };
        new Function('chrome', 'sessionStorage', 'performance', 'setTimeout', 'Date', 'Math', await source())(
            chrome, ss, perf, fakeSetTimeout, { now: function() { return opts.at || AT; } }, { random: function() { return 0.123456789; } });
        r.reply = function(i, res) { r.cbs[i](res); };
        r.fire = function() { r.timers.splice(0).forEach(function(t) { t.fn(); }); };
        r.record = function() { return r.backing[KEY] == null ? null : JSON.parse(r.backing[KEY]); };
        return r;
    }

    test('one app-tab-ready per load: {type, bootId, at, nav, prevBoot:null} + the tab\'s own sessionStorage boot record', async function() {
        var r = await load({ nav: 'reload' });
        assert.strictEqual(r.sent.length, 1, 'sent once at load');
        var m = r.sent[0];
        assert.deepStrictEqual(Object.keys(m).sort(), ['at', 'bootId', 'nav', 'prevBoot', 'type']);
        assert.strictEqual(m.type, 'app-tab-ready');
        assert.strictEqual(m.at, AT);
        assert.strictEqual(m.nav, 'reload');
        assert.strictEqual(m.prevBoot, null);
        assert.ok(/^[0-9a-z]+-[0-9a-z]{1,8}$/.test(m.bootId) && m.bootId.indexOf(AT.toString(36) + '-') === 0, 'bootId = base36(at)-random: ' + m.bootId);
        assert.strictEqual(typeof r.cbs[0], 'function', 'a response callback is passed');
        assert.deepStrictEqual(r.record(), { bootId: m.bootId, at: AT, nav: 'reload' });
        assert.strictEqual(r.ssWrites, 1, 'the only write');
        assert.deepStrictEqual(r.timers.map(function(t) { return t.ms; }), [1500], 'one retry timer');
    }, OPTS);

    test('prevBoot: the next load of the same tab reports the previous boot record; malformed / unreadable => null', async function() {
        var backing = {};
        var first = await load({ backing: backing, nav: 'navigate' });
        var second = await load({ backing: backing, nav: 'reload', at: AT + 5000 });
        assert.deepStrictEqual(second.sent[0].prevBoot, { bootId: first.sent[0].bootId, at: AT, nav: 'navigate' });
        assert.deepStrictEqual(second.record(), { bootId: second.sent[0].bootId, at: AT + 5000, nav: 'reload' }, 'the record now describes the 2nd load');
        var bad = await load({ backing: { appagentPageAlive: '{not json' } });
        assert.strictEqual(bad.sent.length, 1, 'still sent');
        assert.strictEqual(bad.sent[0].prevBoot, null, 'malformed JSON => null');
        assert.strictEqual(bad.record().bootId, bad.sent[0].bootId, 'record rewritten');
        var denied = await load({ getThrows: true, setThrows: true, navThrows: true });
        assert.strictEqual(denied.sent.length, 1, 'sessionStorage / performance failures never block the handshake');
        assert.strictEqual(denied.sent[0].prevBoot, null);
        assert.strictEqual(denied.sent[0].nav, null);
    }, OPTS);

    test('exactly ONE retry at 1.5s when no {ok:true} came back (lastError / {ok:false} / no reply)', async function() {
        var cases = [
            { name: 'lastError', opts: { lastError: 'Could not establish connection. Receiving end does not exist.' }, res: undefined },
            { name: '{ok:false}', opts: {}, res: { ok: false } },
            { name: 'no reply', opts: {}, none: true }
        ];
        for (var i = 0; i < cases.length; i++) {
            var c = cases[i], r = await load(c.opts);
            if (!c.none) r.reply(0, c.res);
            assert.deepStrictEqual(r.timers.map(function(t) { return t.ms; }), [1500], c.name);
            r.fire();
            assert.strictEqual(r.sent.length, 2, c.name + ': one retry');
            assert.deepStrictEqual(r.sent[1], r.sent[0], c.name + ': the same message (same bootId)');
            if (!c.none) r.reply(1, c.res);
            r.fire();
            assert.strictEqual(r.timers.length, 0, c.name + ': no further timer');
            assert.strictEqual(r.sent.length, 2, c.name + ': never a 3rd send');
        }
        var le = await load({ lastError: 'x' });
        le.reply(0, undefined);
        assert.ok(le.lastErrorReads >= 1, 'runtime.lastError is read in the callback (no unchecked-error log)');
    }, OPTS);

    test('no retry after {ok:true}', async function() {
        var r = await load();
        r.reply(0, { ok: true });
        r.fire();
        assert.strictEqual(r.sent.length, 1);
        assert.strictEqual(r.timers.length, 0);
    }, OPTS);

    test('no-op without chrome / chrome.runtime / runtime.sendMessage: no send, no timer, no sessionStorage write', async function() {
        var runs = [await load({ noChrome: true }), await load({ noRuntime: true }), await load({ noSend: true })];
        runs.forEach(function(r, i) {
            assert.strictEqual(r.sent.length, 0, 'case ' + i);
            assert.strictEqual(r.timers.length, 0, 'case ' + i);
            assert.strictEqual(r.ssWrites, 0, 'case ' + i);
        });
    }, OPTS);

    test('a throwing sendMessage is swallowed (the page never breaks); the one retry still happens', async function() {
        var r = await load({ sendThrows: true });   // load() would reject if the throw escaped
        assert.strictEqual(r.sent.length, 1);
        r.fire();
        assert.strictEqual(r.sent.length, 2, 'the retry is attempted (its throw swallowed too)');
        assert.strictEqual(r.timers.length, 0);
    }, OPTS);

    test('static: registers no page listeners and writes no extension storage', async function() {
        var src = await source();
        assert.ok(!/addEventListener|pagehide|unload|visibilitychange|storage\.local\.set|chrome\.storage/.test(src), 'no listeners / extension storage');
        assert.strictEqual((src.match(/sessionStorage\.setItem\(/g) || []).length, 1, 'the only write: its own sessionStorage boot record');
        assert.strictEqual((src.match(/setTimeout\(/g) || []).length, 1, 'one retry timer');
    }, OPTS);
});
