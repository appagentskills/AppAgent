// F4 (Boot OOM fix): toolbar-icon clicks are SINGLE-FLIGHT and never open a
// second app instance when a plain app tab exists: a live one is focused, one
// not known alive is reloaded (bounded) and focused, none -> tabs.create.
// Runs the REAL background.js APP-TAB-REOPEN slice (between its markers, as in
// test/app-tab-reopen.test.js) against a fake chrome; the SW bundle's
// _swPanelPorts is injected as a Set of fake runtime ports {sender:{tab:{id}}}.
// Timers are ALL manual: each waits for e.advance(ms) (Date.now moves with it).
describe('F4 icon click: single-flight + reuse of an existing app tab (background.js)', function() {
    var NOW = 10000000;
    var APP = 'chrome-extension://ext/app.html?mode=tab';
    var OPTS = { tags: ['unit'], timeout: 3000 };
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
    // opts: store (chrome.storage.local), existingTabs, ports (tab ids holding a
    // live SW port), hangQuery / hangReload (never answer), hangCreates: n (the
    // first n tabs.create never answer), createFails: n (the first n reject).
    // fix-f4: queryResult() (tabs.query answers it, as is), failUpdates: n (the
    // first n tabs.update reject), hangUpdates (never answer), reloadCloses
    // (tabs.reload answers, then the tab is gone); e.gets = tabs.get ids.
    async function boot(opts) {
        opts = opts || {};
        var e = { store: clone(opts.store || {}), tabs: {}, created: [], focused: [], reloaded: [], removed: [], createCalls: 0, queries: 0, updateCalls: 0, gets: [],
            logs: [], queue: [], clock: 0, seq: 0, now: NOW, clickFn: null, msgFns: [] };
        (opts.existingTabs || []).forEach(function(t) { e.tabs[t.id] = Object.assign({ windowId: 1, status: 'complete' }, t); });
        var ports = new Set();
        (opts.ports || []).forEach(function(id) { ports.add({ name: 'panel', sender: { id: 'ext', url: APP, tab: { id: id, windowId: 1 } } }); });
        e.ports = ports;
        var nextId = 100;
        var chrome = {
            runtime: {
                id: 'ext',
                getURL: function(p) { return 'chrome-extension://ext/' + p; },
                onInstalled: { addListener: function() {} },
                onMessage: { addListener: function(fn) { e.msgFns.push(fn); } },
                reload: function() {}
            },
            sidePanel: { setPanelBehavior: function() { return Promise.resolve(); } },
            action: { onClicked: { addListener: function(fn) { e.clickFn = fn; } } },
            storage: { local: {
                get: function(k) { var o = {}; if (k in e.store) o[k] = clone(e.store[k]); return Promise.resolve(o); },
                set: function(o) { Object.assign(e.store, clone(o)); return Promise.resolve(); },
                remove: function(k) { delete e.store[k]; return Promise.resolve(); }
            } },
            tabs: {
                create: function(o) {
                    e.createCalls++;
                    if (opts.hangCreates && e.createCalls <= opts.hangCreates) return new Promise(function() {});
                    if (opts.createFails && e.createCalls <= opts.createFails) return Promise.reject(new Error('Tabs cannot be edited right now'));
                    var t = { id: nextId++, url: o.url, windowId: 1, status: 'complete' };
                    e.tabs[t.id] = t; e.created.push(t);
                    return Promise.resolve(clone(t));
                },
                update: function(id) {
                    e.updateCalls++;
                    if (opts.hangUpdates) return new Promise(function() {});
                    if (!e.tabs[id]) return Promise.reject(new Error('No tab with id: ' + id));
                    if (opts.failUpdates && e.updateCalls <= opts.failUpdates) return Promise.reject(new Error('Tabs cannot be edited right now'));
                    e.focused.push(id); return Promise.resolve({ id: id, windowId: e.tabs[id].windowId });
                },
                reload: function(id) {
                    e.reloaded.push(id);
                    if (opts.hangReload) return new Promise(function() {});
                    if (!e.tabs[id]) return Promise.reject(new Error('No tab with id: ' + id));
                    if (opts.reloadCloses) delete e.tabs[id];
                    return Promise.resolve();
                },
                remove: function(ids) { [].concat(ids).forEach(function(id) { e.removed.push(id); delete e.tabs[id]; }); return Promise.resolve(); },
                get: function(id) { e.gets.push(id); return e.tabs[id] ? Promise.resolve(clone(e.tabs[id])) : Promise.reject(new Error('No tab with id: ' + id)); },
                query: function(q) {
                    e.queries++;
                    if (opts.hangQuery) return new Promise(function() {});
                    if (opts.queryResult) return Promise.resolve(opts.queryResult());
                    var pre = String((q && q.url) || '').replace(/\*$/, '');
                    return Promise.resolve(Object.keys(e.tabs).map(function(id) { return clone(e.tabs[id]); })
                        .filter(function(t) { return String(t.url || '').indexOf(pre) === 0; }));
                }
            },
            windows: {
                update: function() { return Promise.resolve(); },
                getLastFocused: function() { return Promise.resolve({ id: 1, type: 'normal' }); },
                create: function(o) { return chrome.tabs.create({ url: o.url }).then(function(t) { return { id: 1, tabs: [t] }; }); }
            }
        };
        var fakeDate = { now: function() { return e.now; } };
        var fakeSetTimeout = function(fn, ms) { e.queue.push({ fn: fn, due: e.clock + (ms || 0), seq: ++e.seq }); return e.seq; };
        var fakeConsole = {
            info: function(msg, data) { var m = /^\[SW\]\[reopen\] (.+)$/.exec(String(msg)); if (m) e.logs.push({ ev: m[1], data: data || {}, clock: e.clock }); },
            warn: function() {}, log: function() {}, error: function() {}
        };
        e.ev = function(name) { return e.logs.filter(function(l) { return l.ev === name; }); };
        e.ready = function(id) {
            e.msgFns.forEach(function(fn) {
                fn({ type: 'app-tab-ready', bootId: 'b' + id, at: e.now, nav: 'navigate', prevBoot: null }, { id: 'ext', url: APP, tab: { id: id, windowId: 1 } }, function() {});
            });
        };
        new Function('chrome', 'Date', 'setTimeout', 'console', '_swPanelPorts', await slice())(chrome, fakeDate, fakeSetTimeout, fakeConsole, ports);
        // Run, in due order, every timer due within the next `ms` of fake time.
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
    function whys(e, ev) { return e.ev(ev).map(function(l) { return l.data.why; }); }
    var OLD_SW_MS = 6000; // past the SW-young grace (2s) and the 1.5s / 5s re-check triggers

    test('two rapid clicks open ONE tab: the 2nd joins the 1st in flight, a 3rd right after is debounced', async function() {
        var e = await boot();
        await e.advance(OLD_SW_MS);
        var a = e.clickFn(), b = e.clickFn();
        assert.strictEqual(a, b, 'the 2nd click joined the 1st (same promise)');
        await e.advance(10); await a;
        assert.strictEqual(e.createCalls, 1);
        assert.deepStrictEqual(whys(e, 'click-created'), ['no-tab']);
        assert.strictEqual(e.ev('click-joined').length, 1);
        await e.clickFn(); await e.advance(10);
        assert.strictEqual(e.ev('click-debounced').length, 1, 'within 2s of a click that showed a tab');
        assert.strictEqual(e.createCalls, 1);
        await e.advance(2500);                  // debounce over, the click's tab still booting (8s grace)
        var c = e.clickFn(); await e.advance(10); await c;
        assert.strictEqual(e.createCalls, 1, 'no second app instance');
        assert.deepStrictEqual(e.focused, [100]);
        assert.deepStrictEqual(whys(e, 'click-focused'), ['recent']);
        assert.deepStrictEqual(e.reloaded, []);
    }, OPTS);

    test('an existing plain app tab with a live SW port is focused (live first), never reloaded, no create', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }, { id: 8, url: APP }], ports: [8] });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn(); await e.advance(10); await c;
        assert.deepStrictEqual(e.focused, [8], 'the live tab, not the first one found');
        assert.deepStrictEqual(e.reloaded, []);
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.ev('click-focused').map(function(l) { return l.data; }), [{ tabId: 8, why: 'port' }]);
    }, OPTS);

    test('a tab whose app-tab-ready is fresh is focused (why: ready)', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }] });
        await e.advance(OLD_SW_MS);
        e.ready(7);
        await e.advance(30000);                 // still within READY_TTL (60s)
        var c = e.clickFn(); await e.advance(10); await c;
        assert.deepStrictEqual(e.focused, [7]);
        assert.deepStrictEqual(whys(e, 'click-focused'), ['ready']);
        assert.deepStrictEqual(e.reloaded, []);
        assert.strictEqual(e.createCalls, 0);
    }, OPTS);

    test('a tab not known alive (no port, SW past its grace) is reloaded + focused, never a second instance', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }] });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn(); await e.advance(10); await c;
        assert.deepStrictEqual(e.reloaded, [7]);
        assert.deepStrictEqual(e.focused, [7]);
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.ev('click-reloaded').map(function(l) { return l.data.tabId; }), [7]);
        await e.advance(3000);                  // past the debounce, inside the reload's 8s boot grace
        c = e.clickFn(); await e.advance(10); await c;
        assert.deepStrictEqual(e.reloaded, [7], 'a booting reloaded tab is not reloaded again');
        assert.deepStrictEqual(e.focused, [7, 7]);
        assert.deepStrictEqual(whys(e, 'click-focused'), ['recent']);
    }, OPTS);

    test('a young SW (the page has not reconnected its port yet) focuses, never reloads', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }] });
        var c = e.clickFn(); await e.advance(10); await c;
        assert.deepStrictEqual(e.focused, [7]);
        assert.deepStrictEqual(e.reloaded, []);
        assert.deepStrictEqual(whys(e, 'click-focused'), ['sw-young']);
        assert.strictEqual(e.createCalls, 0);
    }, OPTS);

    test('no plain app tab: the click creates; widget / doc / print / standalone / foreign pages are never reused', async function() {
        var e = await boot({ ports: [7, 8, 9, 10], existingTabs: [
            { id: 7, url: APP + '&widget=w1' }, { id: 8, url: APP + '&doc=d1' }, { id: 9, url: APP + '&print=1' },
            { id: 10, url: APP + '&standalone=1' }, { id: 11, url: 'https://x.service-now.com/now' }] });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn(); await e.advance(10); await c;
        assert.strictEqual(e.createCalls, 1);
        assert.match(e.created[0].url, /app\.html\?mode=tab$/);
        assert.deepStrictEqual(whys(e, 'click-created'), ['no-tab']);
        assert.deepStrictEqual(e.focused, []);
        assert.deepStrictEqual(e.reloaded, []);
    }, OPTS);

    test('hung tabs.query: the click still creates within the 1.5s bound; a later click skips the finder at once', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }], ports: [7], hangQuery: true });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn();
        await e.advance(1400);
        assert.strictEqual(e.createCalls, 0, 'waiting on the bounded tabs.query');
        await e.advance(200); await c;
        assert.strictEqual(e.createCalls, 1, 'created at the 1.5s bound');
        assert.deepStrictEqual(whys(e, 'click-created'), ['query-failed']);
        await e.advance(2500);                  // past the debounce
        c = e.clickFn(); await e.advance(10); await c;
        assert.strictEqual(e.createCalls, 2, 'did not wait on tabs.query again');
        assert.deepStrictEqual(whys(e, 'click-created'), ['query-failed', 'query-hung']);
        assert.strictEqual(e.queries, 1);
    }, OPTS);

    test('hung tabs.create: clicks meanwhile join (ONE create call); a failed click is not debounced, the next one opens', async function() {
        var e = await boot({ hangCreates: 1 });
        await e.advance(OLD_SW_MS);
        var a = e.clickFn();
        await e.advance(500);
        var b = e.clickFn();
        assert.strictEqual(a, b, 'joined the click in flight');
        await e.advance(3100); await a;         // the 3s tabs.create bound (no retry after a timeout)
        assert.strictEqual(e.createCalls, 1);
        assert.strictEqual(e.ev('click-open-failed').length, 1);
        var c = e.clickFn(); await e.advance(10); await c;
        assert.strictEqual(e.ev('click-debounced').length, 0);
        assert.strictEqual(e.createCalls, 2);
        assert.strictEqual(e.created.length, 1, 'exactly one tab exists');
    }, OPTS);

    test('hung tabs.reload: bounded at 3s, then the click creates (a tab always opens)', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }], hangReload: true });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn();
        await e.advance(3100); await c;
        assert.deepStrictEqual(e.reloaded, [7]);
        assert.strictEqual(e.createCalls, 1);
        assert.deepStrictEqual(whys(e, 'click-created'), ['reload-failed']);
    }, OPTS);

    test('reopen suspects (the old instance tabs) are never focused nor reloaded, even with a port', async function() {
        var e = await boot({ store: { reopenAppTab: NOW - 1000 }, existingTabs: [{ id: 7, url: APP }], ports: [7] });
        await e.advance(250);                   // the reopen snapshotted tab 7 and is in its settle wait
        var c = e.clickFn();
        await e.advance(300);
        assert.strictEqual(e.createCalls, 1, "the click's own tab");
        await e.advance(10000); await c;
        assert.deepStrictEqual(e.focused.filter(function(id) { return id === 7; }), []);
        assert.deepStrictEqual(e.reloaded, []);
        assert.strictEqual(e.created.length, 1);
        assert.deepStrictEqual(whys(e, 'click-created'), ['no-tab']);
    }, OPTS);

    // --- fix-f4: hardened reuse fallbacks (reviewer B nit + minor) -------------
    test('nit: the reuse step throws (the finder chokes on a tab): the trailing catch still opens ONE tab', async function() {
        var e = await boot({ queryResult: function() { return [{ id: 7, get url() { throw new Error('boom'); } }]; } });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn(); await e.advance(10); var t = await c;
        assert.deepStrictEqual(e.ev('click-reuse-failed').map(function(l) { return l.data.error; }), ['boom']);
        assert.strictEqual(e.createCalls, 1);
        assert.deepStrictEqual(whys(e, 'click-created'), ['reuse-failed']);
        assert.strictEqual(e.ev('click-open-failed').length, 0);
        assert.strictEqual(t && t.id, 100, 'the click answers its tab');
    }, OPTS);

    test('nit guard: a click whose own create fails is never re-created by the trailing catch (one create per click)', async function() {
        var e = await boot({ createFails: 2 });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn(); await e.advance(400); await c;   // the create, its one retry 300ms later
        assert.strictEqual(e.createCalls, 2, 'no fallback create after the failed one');
        assert.strictEqual(e.ev('click-reuse-failed').length, 0);
        assert.strictEqual(e.ev('click-open-failed').length, 1);
        c = e.clickFn(); await e.advance(10); await c;        // a failed click is not debounced
        assert.strictEqual(e.createCalls, 3);
        assert.strictEqual(e.created.length, 1, 'exactly one tab exists');
    }, OPTS);

    test('minor: reload ok, the focus fails once -> retried at once and focused, no create', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }], failUpdates: 1 });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn(); await e.advance(10); var t = await c;
        assert.deepStrictEqual(e.reloaded, [7]);
        assert.strictEqual(e.updateCalls, 2, 'the focus + ONE retry');
        assert.deepStrictEqual(e.focused, [7]);
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.ev('click-reloaded').map(function(l) { return l.data.tabId; }), [7]);
        assert.strictEqual(t && t.id, 7);
    }, OPTS);

    test('minor: reload ok, the focus fails twice, the tab still exists -> NO second create; the next click focuses it', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }], failUpdates: 2 });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn(); await e.advance(10); var t = await c;
        assert.deepStrictEqual(e.reloaded, [7]);
        assert.strictEqual(e.updateCalls, 2, 'the focus + ONE retry');
        assert.deepStrictEqual(e.gets, [7], 'one bounded tabs.get');
        assert.strictEqual(e.createCalls, 0, 'no second app instance beside the reloaded tab');
        assert.deepStrictEqual(e.ev('click-focus-failed').map(function(l) { return l.data.tabId; }), [7]);
        assert.strictEqual(e.ev('click-reloaded').length, 0);
        assert.strictEqual(t, null, 'nothing shown');
        c = e.clickFn(); await e.advance(10); await c;        // not debounced: nothing was shown
        assert.strictEqual(e.ev('click-debounced').length, 0);
        assert.deepStrictEqual(e.focused, [7]);
        assert.deepStrictEqual(whys(e, 'click-focused'), ['recent']);
        assert.deepStrictEqual(e.reloaded, [7], 'not reloaded again');
        assert.strictEqual(e.createCalls, 0);
    }, OPTS);

    test('minor: reload ok, then the tab is gone (focus fails, tabs.get: no tab) -> the click creates ONE tab', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }], reloadCloses: true });
        await e.advance(OLD_SW_MS);
        var c = e.clickFn(); await e.advance(10); var t = await c;
        assert.deepStrictEqual(e.reloaded, [7]);
        assert.strictEqual(e.updateCalls, 2, 'the focus + ONE retry');
        assert.deepStrictEqual(e.gets, [7]);
        assert.strictEqual(e.createCalls, 1);
        assert.deepStrictEqual(whys(e, 'click-created'), ['reload-gone']);
        assert.strictEqual(e.ev('click-focus-failed').length, 0);
        assert.strictEqual(t && t.id, 100);
    }, OPTS);

    test('minor: reload ok, the focus hangs -> bounded (3s + ONE 3s retry), the tab is there -> no create', async function() {
        var e = await boot({ existingTabs: [{ id: 7, url: APP }], hangUpdates: true });
        await e.advance(OLD_SW_MS);
        var done = false, c = e.clickFn();
        c.then(function() { done = true; });
        await e.advance(5900);
        assert.strictEqual(done, false, 'the retry is still within its bound');
        assert.strictEqual(e.updateCalls, 2);
        assert.deepStrictEqual(e.gets, []);
        await e.advance(200); await c;
        assert.strictEqual(done, true, 'settled at the 6s bound');
        assert.deepStrictEqual(e.gets, [7]);
        assert.strictEqual(e.createCalls, 0);
        assert.deepStrictEqual(e.ev('click-focus-failed').map(function(l) { return l.data.tabId; }), [7]);
    }, OPTS);
});
