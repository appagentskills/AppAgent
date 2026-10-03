// Follow-up to the widget-store delete tombstones. `tombstones` is each tab's
// in-memory copy of the localStorage list and is refreshed only by
// setTombstone, the channel's onmessage and resendDeletes, so a tab whose
// BroadcastChannel notice is missing or late keeps a STALE copy. Every
// read-modify-write that could (re)create a row — migrate()'s mutate and
// commit()'s mutate — must re-read the shared list inside the transaction.
// A delete is permanent: a stale tab's save never resurrects the id (only a
// backup import revives it). clearCache() must also reset the legacy-pass
// state, so an orphaned deferred pass cannot write pre-reset rows back.
describe('widget store tombstone follow-up (cross-tab RMW + clearCache reset)', function() {
    var KEY = 'appagent-widget-tombstones-test';
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    async function flush(n) { for (var i = 0; i < (n || 300); i++) await Promise.resolve(); }
    // Minimal in-memory IndexedDB (same shape as widget-store-boot-scan).
    function fakeDb(stores) {
        return {
            transaction: function() {
                var tx = { pending: 0 };
                function settle() {
                    Promise.resolve().then(function() {
                        if (--tx.pending === 0) Promise.resolve().then(function() { if (tx.pending === 0 && tx.oncomplete) tx.oncomplete(); });
                    });
                }
                function req(fn) {
                    var r = {}; tx.pending++;
                    Promise.resolve().then(function() { r.result = fn(); if (r.onsuccess) r.onsuccess(); settle(); });
                    return r;
                }
                tx.abort = function() { if (tx.onabort) tx.onabort(); };
                tx.objectStore = function(name) {
                    var s = stores[name] || (stores[name] = new Map());
                    return {
                        getAll: function() { return req(function() { return Array.from(s.values()).map(clone); }); },
                        get: function(k) { return req(function() { return s.has(k) ? clone(s.get(k)) : undefined; }); },
                        delete: function(k) { return req(function() { s.delete(k); }); },
                        put: function(v) { return req(function() { s.set(v.id, clone(v)); return v.id; }); }
                    };
                };
                return tx;
            }
        };
    }
    function row(id, html) {
        return { id: id, origin: { chatId: 'c1', msgIndex: 0, createdAt: 1 },
            versions: [{ version: 1, title: 'W', html: html || '<b>1</b>', width: '400px', height: '400px', createdAt: 1, source: 'save' }] };
    }
    function chatsWith(ids) {
        return { c1: { id: 'c1', messages: [{ role: 'user', content: 'hi' }],
            widgets: ids.map(function(id, i) { return { id: id, title: 'W', html: '<b>1</b>', msgIndex: i }; }) } };
    }
    // Shared by every "tab": the IDB stores and localStorage.
    function sharedState(rows) {
        var stores = { widgets: new Map(), chats: new Map(), dashboardWidgets: new Map() };
        (rows || []).forEach(function(r) { stores.widgets.set(r.id, clone(r)); });
        return { stores: stores, ls: {}, db: fakeDb(stores) };
    }
    function stored(s) { return JSON.parse(s.ls[KEY] || '[]'); }
    // One tab = one module instance with its own in-memory maps. No
    // BroadcastChannel: the cross-tab notice never arrives (the stale case).
    async function tab(s, opts) {
        opts = opts || {};
        var ls = s.ls;
        var m = await loadModules(['src/js/core/135-widget-store.js'], { globals: {
            dbName: 'test', widgetStoreName: 'widgets', chatStoreName: 'chats', dashboardWidgetsStoreName: 'dashboardWidgets',
            BroadcastChannel: undefined,
            localStorage: opts.storage || { getItem: function(k) { return k in ls ? ls[k] : null; }, setItem: function(k, v) { ls[k] = String(v); } },
            chats: opts.chats || chatsWith(['widget_x']), chatWidgets: {}, dashboardWidgets: opts.dashboardWidgets || {},
            _chatsHydrated: opts.hydrated === undefined ? true : opts.hydrated, _chatsLoadInFlight: opts.inflight || null,
            openDatabase: opts.openDatabase || function() { return Promise.resolve(s.db); },
            console: { log: function() {}, info: function() {}, warn: function() {}, error: function() {} }
        } });
        return m;
    }
    async function twoTabsAfterDelete() {
        var s = sharedState([row('widget_x')]);
        var a = await tab(s), b = await tab(s);
        await a.WidgetStore.init();
        await b.WidgetStore.init();
        await a.WidgetStore.remove('widget_x');
        assert.deepStrictEqual(stored(s), ['widget_x'], 'tab A tombstoned the id in localStorage');
        assert.ok(!s.stores.widgets.has('widget_x'), 'tab A deleted the row');
        return { s: s, a: a, b: b };
    }

    test('migrate() in a stale tab honours a tombstone another tab wrote (no channel notice)', async function() {
        var x = await twoTabsAfterDelete();
        // Tab B never heard about the delete: its chat projection still has it.
        var item = Object.assign({}, x.b.__scope.chats.c1.widgets[0], { chatId: 'c1' });
        var result = await x.b.WidgetStore.migrate([{ id: 'widget_x', items: [item] }]);
        assert.strictEqual(result, null, 'migrate refused the deleted id');
        assert.ok(!x.s.stores.widgets.has('widget_x'), 'stale tab did not write the deleted widget back');
        assert.deepStrictEqual(stored(x.s), ['widget_x'], 'tombstone kept');
    }, { tags: ['unit'], timeout: 5000 });

    test('read() in a stale tab cannot re-migrate a widget another tab deleted', async function() {
        var x = await twoTabsAfterDelete();
        var got = await x.b.WidgetStore.read('widget_x');
        assert.strictEqual(got, null, 'read() returns nothing for the deleted id');
        assert.ok(!x.s.stores.widgets.has('widget_x'), 'stale chat projection did not resurrect the row');
        // A later boot of any tab still sees it as deleted.
        var c = await tab(x.s);
        await c.WidgetStore.init();
        assert.ok(!x.s.stores.widgets.has('widget_x'), 'boot legacy pass did not re-migrate it');
        assert.ok(c.WidgetStore.isDeleted('widget_x'));
    }, { tags: ['unit'], timeout: 5000 });

    test("a stale tab's save (create replay or edit) cannot resurrect a deleted id", async function() {
        var x = await twoTabsAfterDelete();
        // html_widget derives the id from the operation id, so a replayed
        // create commits the SAME id with expected_version 0.
        var res = await x.b.WidgetStore.commit('widget_x', { title: 'W', html: '<b>again</b>' }, 0, 'c1:op-replay');
        assert.strictEqual(res.success, false, 'create replay refused: ' + JSON.stringify(res));
        assert.strictEqual(res.code, 'WIDGET_DELETED');
        assert.ok(!x.s.stores.widgets.has('widget_x'), 'no row re-created');
        assert.deepStrictEqual(stored(x.s), ['widget_x'], 'a refused save never clears the tombstone');
        var edit = await x.b.WidgetStore.commit('widget_x', { title: 'W', html: '<b>edit</b>' }, 1, 'c1:op-edit');
        assert.strictEqual(edit.success, false, 'edit save refused');
        assert.strictEqual(edit.code, 'WIDGET_DELETED');
        assert.ok(!x.s.stores.widgets.has('widget_x'));
        // The deleting tab itself cannot re-create it either: delete is permanent.
        var own = await x.a.WidgetStore.commit('widget_x', { title: 'W', html: '<b>own</b>' }, 0, 'c1:op-own');
        assert.strictEqual(own.code, 'WIDGET_DELETED');
        assert.ok(!x.s.stores.widgets.has('widget_x'));
    }, { tags: ['unit'], timeout: 5000 });

    test('a save landing while remove() is in flight (tombstone set, row not yet deleted) neither commits nor clears the tombstone', async function() {
        var s = sharedState([row('widget_x')]);
        var b = await tab(s);
        await b.WidgetStore.init();
        // Tab A's remove(): the tombstone is written first, the delete commits later.
        s.ls[KEY] = JSON.stringify(['widget_x']);
        var res = await b.WidgetStore.commit('widget_x', { title: 'W', html: '<b>2</b>' }, 1, 'c1:op-edit');
        assert.strictEqual(res.success, false, 'refused: ' + JSON.stringify(res));
        assert.strictEqual(res.code, 'WIDGET_DELETED');
        assert.strictEqual(s.stores.widgets.get('widget_x').versions.length, 1, 'no version appended');
        assert.deepStrictEqual(stored(s), ['widget_x'], "tab A's tombstone survives the racing save");
    }, { tags: ['unit'], timeout: 5000 });

    test('backup import is the revive path: it re-creates the id and a stale tab can then save it', async function() {
        var s = sharedState([row('widget_x')]);
        var a = await tab(s);
        await a.WidgetStore.init();
        await a.WidgetStore.remove('widget_x');
        var b = await tab(s); // booted AFTER the delete: its copy holds the tombstone
        await b.WidgetStore.init();
        assert.ok(b.WidgetStore.isDeleted('widget_x'));
        await a.WidgetStore.importRecords([row('widget_x')]);
        assert.ok(s.stores.widgets.has('widget_x'), 'import re-created the row');
        assert.deepStrictEqual(stored(s), [], 'import cleared the tombstone');
        // Tab B missed the reload notice; the fresh read inside commit's RMW sees the revive.
        var res = await b.WidgetStore.commit('widget_x', { title: 'W', html: '<b>2</b>' }, 1, 'c1:op-after-import');
        assert.strictEqual(res.success, true, JSON.stringify(res));
        assert.strictEqual(s.stores.widgets.get('widget_x').versions.length, 2);
    }, { tags: ['unit'], timeout: 5000 });

    test('without localStorage the tombstones stay in memory: removes accumulate and the RMW re-reads keep them', async function() {
        var s = sharedState([row('widget_a'), row('widget_b')]);
        var denied = { getItem: function() { throw new Error('SecurityError'); }, setItem: function() { throw new Error('SecurityError'); } };
        var t = await tab(s, { storage: denied, chats: chatsWith(['widget_a', 'widget_b']) });
        await t.WidgetStore.init();
        await t.WidgetStore.remove('widget_a');
        await t.WidgetStore.remove('widget_b');
        assert.ok(t.WidgetStore.isDeleted('widget_a') && t.WidgetStore.isDeleted('widget_b'), 'both tombstones kept in memory');
        var res = await t.WidgetStore.commit('widget_a', { title: 'W', html: '<b>a</b>' }, 0, 'c1:op-a');
        assert.strictEqual(res.success, false, 'same-tab save of a deleted id refused');
        await t.WidgetStore.migrate([{ id: 'widget_b', items: [{ id: 'widget_b', title: 'W', html: '<b>1</b>', chatId: 'c1', msgIndex: 1 }] }]);
        assert.ok(!s.stores.widgets.has('widget_a') && !s.stores.widgets.has('widget_b'), 'neither row re-created');
        assert.ok(t.WidgetStore.isDeleted('widget_a') && t.WidgetStore.isDeleted('widget_b'), 'the re-reads did not drop them');
    }, { tags: ['unit'], timeout: 5000 });

    test('clearCache() orphans a pending deferred legacy pass: pre-reset dashboard rows are not written back', async function() {
        var s = sharedState([]);
        var dash = { id: 'widget_dash', title: 'D', html: '<i>2</i>', history: [{ html: '<i>1</i>', title: 'D' }] };
        s.stores.dashboardWidgets.set('widget_dash', clone(dash));
        var release, inflight = new Promise(function(r) { release = r; });
        var t = await tab(s, { chats: {}, hydrated: false, inflight: inflight, dashboardWidgets: { widget_dash: clone(dash) } });
        await t.WidgetStore.init(); // pass deferred on the chat load; dashboard rows retained for it
        // Delete All: every store cleared, then the caches reset.
        s.stores.widgets.clear();
        s.stores.dashboardWidgets.clear();
        t.WidgetStore.clearCache(false);
        t.__scope._chatsHydrated = true;
        t.__scope._chatsLoadInFlight = null;
        release();
        await flush();
        assert.ok(!s.stores.widgets.has('widget_dash'), 'orphaned pass wrote nothing into the cleared store');
        assert.strictEqual(t.WidgetStore.list().length, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('clearCache() lets the next init() schedule a fresh legacy pass (no stale legacyDeferred)', async function() {
        var s = sharedState([]);
        var release1, inflight1 = new Promise(function(r) { release1 = r; });
        var t = await tab(s, { chats: {}, hydrated: false, inflight: inflight1 });
        await t.WidgetStore.init(); // pass #1 deferred on the first chat load
        t.WidgetStore.clearCache(false);
        var release2, inflight2 = new Promise(function(r) { release2 = r; });
        t.__scope._chatsLoadInFlight = inflight2;
        await t.WidgetStore.init(); // must schedule pass #2 on the new load
        t.__scope.chats = chatsWith(['widget_new']);
        t.__scope._chatsHydrated = true;
        t.__scope._chatsLoadInFlight = null;
        release2();
        await flush();
        assert.ok(s.stores.widgets.has('widget_new'), 'fresh pass migrated the post-reset chat widget');
        assert.strictEqual(t.__scope.chats.c1.widgets[0].contentVersion, 1, 'and projected it');
        release1(); // the orphaned pass settles last: it bails and clobbers nothing
        await flush();
        assert.deepStrictEqual(Array.from(s.stores.widgets.keys()), ['widget_new']);
        assert.deepStrictEqual(t.WidgetStore.list().map(function(w) { return w.id; }), ['widget_new']);
    }, { tags: ['unit'], timeout: 5000 });

    // Deterministic ordering: no timers, only deferreds released by the test.
    function deferred() { var d = {}; d.promise = new Promise(function(r) { d.resolve = r; }); return d; }
    // openDatabase that parks the NEXT call on a deferred (one-shot), and a db
    // wrapper that logs the key read by every readwrite transaction.
    function gatedDb(s) {
        var g = { hold: null, parked: 0, rw: [] };
        var db = { transaction: function(names, mode) {
            var tx = s.db.transaction(names, mode);
            if (mode === 'readwrite') {
                var os = tx.objectStore;
                tx.objectStore = function(n) {
                    var st = os(n), get = st.get;
                    st.get = function(k) { g.rw.push(k); return get(k); };
                    return st;
                };
            }
            return tx;
        } };
        g.openDatabase = function() {
            if (!g.hold) return Promise.resolve(db);
            var d = g.hold; g.hold = null; g.parked++;
            return d.promise.then(function() { return db; });
        };
        return g;
    }
    // Shared setup: pass #1 is collected (widget_a) and parked in transact's
    // openDatabase, then clearCache(false) runs while it is parked.
    async function passParkedThenCleared() {
        var s = sharedState([]), g = gatedDb(s);
        var inflight1 = deferred();
        var t = await tab(s, { chats: chatsWith(['widget_a']), inflight: inflight1.promise, openDatabase: g.openDatabase });
        await t.WidgetStore.init(); // load() done; pass #1 deferred on the chat load
        var held = deferred();
        g.hold = held;
        inflight1.resolve();
        await flush();
        assert.strictEqual(g.parked, 1, 'pass #1 is parked inside openDatabase');
        assert.deepStrictEqual(g.rw, [], 'no readwrite transaction opened yet');
        t.WidgetStore.clearCache(false);
        return { s: s, g: g, t: t, held: held };
    }

    test('P1a: clearCache() while the legacy pass is parked in openDatabase: the pass writes nothing (inner gen check)', async function() {
        var x = await passParkedThenCleared();
        x.held.resolve();
        await flush();
        assert.deepStrictEqual(x.g.rw, ['widget_a'], 'the parked transaction did run');
        assert.strictEqual(x.s.stores.widgets.size, 0, 'orphaned pass wrote nothing into the cleared store');
        assert.deepStrictEqual(x.t.WidgetStore.list(), [], 'and cached nothing');
    }, { tags: ['unit'], timeout: 5000 });

    test("P1a': an orphaned pass settling late does not clear the NEW pass's legacyDeferred (no duplicate pass)", async function() {
        var x = await passParkedThenCleared();
        var inflight2 = deferred();
        x.t.__scope._chatsLoadInFlight = inflight2.promise;
        await x.t.WidgetStore.init(); // schedules pass #2 on the new load
        x.held.resolve(); // orphaned pass #1 settles while pass #2 is pending
        await flush();
        await x.t.WidgetStore.init(); // 3rd init: pass #2 is still pending, must not schedule another
        x.t.__scope.chats = chatsWith(['widget_new']);
        x.t.__scope._chatsLoadInFlight = null;
        inflight2.resolve();
        await flush();
        assert.strictEqual(x.g.rw.filter(function(k) { return k === 'widget_new'; }).length, 1, 'exactly one readwrite transaction for widget_new: ' + JSON.stringify(x.g.rw));
        assert.deepStrictEqual(x.g.rw, ['widget_a', 'widget_new']);
        assert.deepStrictEqual(Array.from(x.s.stores.widgets.keys()), ['widget_new']);
        assert.deepStrictEqual(x.t.WidgetStore.list().map(function(w) { return w.id; }), ['widget_new']);
    }, { tags: ['unit'], timeout: 5000 });

    test('P2d: migrate() of an existing row tombstoned after load (no init) returns null and does not cache it', async function() {
        var s = sharedState([row('widget_x')]);
        var t = await tab(s); // tombstone copy read at load: empty
        s.ls[KEY] = JSON.stringify(['widget_x']); // another tab deleted it; no notice
        var item = { id: 'widget_x', title: 'W', html: '<b>1</b>', chatId: 'c1', msgIndex: 0 };
        var result = await t.WidgetStore.migrate([{ id: 'widget_x', items: [item] }]);
        assert.strictEqual(result, null, 'the fresh tombstone wins over the existing row');
        assert.deepStrictEqual(t.WidgetStore.list(), [], 'the row was not re-cached');
        assert.ok(s.stores.widgets.has('widget_x'), 'migrate never deletes: the row is left to remove()');
    }, { tags: ['unit'], timeout: 5000 });

    test('clearCache() refreshes the in-memory tombstone copy', async function() {
        var s = sharedState([row('widget_x')]);
        var b = await tab(s);
        await b.WidgetStore.init();
        s.ls[KEY] = JSON.stringify(['widget_x']); // another tab's delete; its notice was lost
        b.WidgetStore.clearCache(false);
        assert.ok(b.WidgetStore.isDeleted('widget_x'));
    }, { tags: ['unit'], timeout: 5000 });

    test('a failed localStorage write never drops a tombstone: fresh re-reads keep it and the next write retries it', async function() {
        var s = sharedState([row('widget_x'), row('widget_y')]);
        var failWrites = true, ls = s.ls;
        var flaky = { getItem: function(k) { return k in ls ? ls[k] : null; },
            setItem: function(k, v) { if (failWrites) throw new Error('QuotaExceededError'); ls[k] = String(v); } };
        var t = await tab(s, { storage: flaky, chats: chatsWith(['widget_x', 'widget_y']) });
        await t.WidgetStore.init();
        await t.WidgetStore.remove('widget_x');
        assert.deepStrictEqual(stored(s), [], 'the write failed: nothing persisted yet');
        assert.ok(t.WidgetStore.isDeleted('widget_x'), 'kept in memory');
        // commit() re-reads localStorage (tombstonedNow): the pending op survives it.
        var res = await t.WidgetStore.commit('widget_x', { title: 'W', html: '<b>again</b>' }, 0, 'c1:op-replay');
        assert.strictEqual(res.code, 'WIDGET_DELETED', JSON.stringify(res));
        assert.ok(/operation_id/.test(res.error), 'the hint names operation_id: ' + res.error);
        assert.ok(!s.stores.widgets.has('widget_x'), 'no row re-created');
        t.WidgetStore.clearCache(false);
        assert.ok(t.WidgetStore.isDeleted('widget_x'), 'clearCache re-read keeps it');
        failWrites = false;
        await t.WidgetStore.remove('widget_y');
        assert.deepStrictEqual(stored(s).slice().sort(), ['widget_x', 'widget_y'], 'the next successful write persisted the pending tombstone too');
    }, { tags: ['unit'], timeout: 5000 });

    test('import with a failed un-tombstone write stays revived across fresh reads and accepts a fresh commit', async function() {
        var s = sharedState([row('widget_x')]), failWrites = false, writes = [];
        var storage = {
            getItem: function(k) { return k in s.ls ? s.ls[k] : null; },
            setItem: function(k, v) {
                writes.push([k, JSON.parse(v)]);
                if (failWrites) throw new Error('QuotaExceededError');
                s.ls[k] = String(v);
            }
        };
        var t = await tab(s, { storage: storage });
        await t.WidgetStore.init();
        await t.WidgetStore.remove('widget_x');
        assert.deepStrictEqual(stored(s), ['widget_x']);
        assert.strictEqual(s.stores.widgets.has('widget_x'), false);
        assert.strictEqual(t.WidgetStore.isDeleted('widget_x'), true);

        failWrites = true;
        await t.WidgetStore.importRecords([row('widget_x')]);
        assert.deepStrictEqual(writes, [[KEY, ['widget_x']], [KEY, []]], 'import attempted the un-tombstone write');
        assert.deepStrictEqual(stored(s), ['widget_x'], 'durable list remains stale after failed write');
        assert.strictEqual(s.stores.widgets.has('widget_x'), true, 'import restored the row');
        t.WidgetStore.clearCache(false); // re-read the stale durable list plus pending off
        assert.strictEqual(t.WidgetStore.isDeleted('widget_x'), false, 'pending off splices the durable tombstone');
        var result = await t.WidgetStore.commit('widget_x', { title: 'W', html: '<b>revived</b>' }, 1, 'c1:op-fresh-import');
        assert.strictEqual(result.success, true, JSON.stringify(result));
        assert.strictEqual(result.code, undefined);
        assert.deepStrictEqual(s.stores.widgets.get('widget_x').versions.map(function(v) { return [v.version, v.html]; }),
            [[1, '<b>1</b>'], [2, '<b>revived</b>']]);
        assert.deepStrictEqual(stored(s), ['widget_x'], 'commit did not pretend the failed write persisted');
    }, { tags: ['unit'], timeout: 5000 });

    test('no failed write: tombstones persist exactly as before (no pending state leaks)', async function() {
        var x = await twoTabsAfterDelete();
        x.s.ls[KEY] = JSON.stringify([]); // a backup import elsewhere revived it
        x.a.WidgetStore.clearCache(false);
        assert.ok(!x.a.WidgetStore.isDeleted('widget_x'), 'a successful write leaves no pending op to re-apply');
    }, { tags: ['unit'], timeout: 5000 });

    test('widgetSaveErrorText: translated editor snackbar text per failure code', async function() {
        var m = await loadModules(['src/js/core/135-widget-store.js'], { globals: {
            dbName: 'test', widgetStoreName: 'widgets', chatStoreName: 'chats', dashboardWidgetsStoreName: 'dashboardWidgets',
            BroadcastChannel: undefined, localStorage: { getItem: function() { return null; }, setItem: function() {} },
            chats: {}, chatWidgets: {}, dashboardWidgets: {}, _chatsHydrated: true, _chatsLoadInFlight: null,
            openDatabase: function() { return Promise.resolve(sharedState([]).db); },
            t: function(s, p) { return 'T:' + String(s).replace(/\{(\w+)\}/g, function(_, k) { return p && k in p ? p[k] : _; }); },
            console: { log: function() {}, info: function() {}, warn: function() {}, error: function() {} }
        } });
        assert.strictEqual(m.widgetSaveErrorText({ success: false, code: 'WIDGET_DELETED', error: 'x' }), 'T:This widget was deleted and cannot be saved again.');
        assert.strictEqual(m.widgetSaveErrorText({ success: false, code: 'VERSION_CONFLICT', error: 'x' }), 'T:This widget changed since the editor opened. Reopen the editor and try again.');
        assert.strictEqual(m.widgetSaveErrorText({ success: false, code: 'OPERATION_CONFLICT', error: 'boom' }), 'T:Widget save failed: boom');
        assert.strictEqual(m.widgetSaveErrorText({ success: false }), 'T:Widget save failed: T:unknown error');
    }, { tags: ['unit'], timeout: 5000 });
});
