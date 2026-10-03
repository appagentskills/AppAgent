// BOOT-MEM: WidgetStore.load() must never open/cursor the chats object store
// (that deserialised every full chat record on every boot). Legacy chat
// `widgets` projections are migrated from the in-memory `chats` map, only
// once the page chat load (_chatsLoadInFlight / _chatsHydrated) has settled.
describe('widget store boot scan (no chats-store read)', function() {
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    async function flush(n) { for (var i = 0; i < (n || 300); i++) await Promise.resolve(); }
    // Minimal in-memory IndexedDB that logs every store touched. gates[key]
    // (a promise) parks get(key) until it resolves, to pin a race window.
    function fakeDb(stores, log, gates) {
        return {
            transaction: function(names) {
                log.push('tx:' + [].concat(names).join(','));
                var tx = { pending: 0 };
                function settle() {
                    Promise.resolve().then(function() {
                        if (--tx.pending === 0) Promise.resolve().then(function() { if (tx.pending === 0 && tx.oncomplete) tx.oncomplete(); });
                    });
                }
                function req(fn, wait) {
                    var r = {}; tx.pending++;
                    Promise.resolve(wait).then(function() { r.result = fn(); if (r.onsuccess) r.onsuccess(); settle(); });
                    return r;
                }
                tx.abort = function() { if (tx.onabort) tx.onabort(); };
                tx.objectStore = function(name) {
                    log.push('store:' + name);
                    var s = stores[name] || (stores[name] = new Map());
                    return {
                        getAll: function() { log.push('getAll:' + name); return req(function() { return Array.from(s.values()).map(clone); }); },
                        get: function(k) { return req(function() { return s.has(k) ? clone(s.get(k)) : undefined; }, gates && gates[k]); },
                        delete: function(k) { return req(function() { s.delete(k); }); },
                        put: function(v) { return req(function() { s.set(v.id, clone(v)); return v.id; }); },
                        openCursor: function() { log.push('cursor:' + name); throw new Error('cursor not allowed in this test'); }
                    };
                };
                return tx;
            }
        };
    }
    function chatsTouched(log) { return log.filter(function(e) { return /chats/.test(e); }); }
    async function setup(opts) {
        var stores = { widgets: new Map(), chats: new Map(), dashboardWidgets: new Map() }, log = [], gates = {}, ls = {};
        // A chats-store row whose widget is NOT in memory: must never be read.
        stores.chats.set('cDisk', { id: 'cDisk', messages: [{ role: 'user', content: 'x' }], widgets: [{ id: 'widget_disk', title: 'Disk', html: '<b>d</b>' }] });
        stores.dashboardWidgets.set('widget_dash', { id: 'widget_dash', title: 'D', html: '<i>2</i>', history: [{ html: '<i>1</i>', title: 'D' }] });
        var db = fakeDb(stores, log, gates);
        var m = await loadModules(['src/js/core/135-widget-store.js'], { globals: {
            dbName: 'test', widgetStoreName: 'widgets', chatStoreName: 'chats', dashboardWidgetsStoreName: 'dashboardWidgets',
            BroadcastChannel: undefined,
            localStorage: { getItem: function(k) { return k in ls ? ls[k] : null; }, setItem: function(k, v) { ls[k] = String(v); } },
            chats: opts.chats, chatWidgets: {}, dashboardWidgets: { widget_dash: clone(stores.dashboardWidgets.get('widget_dash')) },
            _chatsHydrated: opts.hydrated, _chatsLoadInFlight: opts.inflight || null,
            openDatabase: function() { return Promise.resolve(db); },
            console: { log: function() {}, info: function() {}, warn: function() {}, error: function() {} }
        } });
        return { m: m, stores: stores, log: log, gates: gates };
    }
    function memChats() {
        return { c1: { id: 'c1', messages: [{ role: 'user', content: 'hi' }], widgets: [{ id: 'widget_mem', title: 'Mem', html: '<b>1</b>', msgIndex: 0 }] } };
    }

    test('legacy chat widgets migrate from in-memory chats; chats store never opened or cursored', async function() {
        var x = await setup({ chats: memChats(), hydrated: true });
        await x.m.WidgetStore.init();
        assert.ok(x.stores.widgets.has('widget_mem'), 'in-memory chat widget migrated');
        assert.strictEqual(x.stores.widgets.get('widget_mem').origin.chatId, 'c1', 'origin chat kept');
        assert.ok(x.stores.widgets.has('widget_dash'), 'dashboard widget migrated');
        assert.strictEqual(x.stores.widgets.get('widget_dash').versions.length, 2, 'dashboard history preserved');
        assert.ok(!x.stores.widgets.has('widget_disk'), 'chats-store-only widget not read');
        assert.deepStrictEqual(chatsTouched(x.log), [], 'chats store never in a transaction scope, opened or cursored');
        assert.ok(x.log.indexOf('getAll:widgets') >= 0 && x.log.indexOf('getAll:dashboardWidgets') >= 0, 'widgets + dashboard getAll kept');
        var ids = x.m.WidgetStore.list().map(function(w) { return w.id; }).sort();
        assert.deepStrictEqual(ids, ['widget_dash', 'widget_mem']);
    }, { tags: ['unit'], timeout: 5000 });

    test('legacy migration waits for the in-flight chats-load promise (init does not block boot)', async function() {
        var release, inflight = new Promise(function(r) { release = r; });
        var x = await setup({ chats: {}, hydrated: false, inflight: inflight });
        await x.m.WidgetStore.init(); // must resolve while the chat load is pending
        await flush();
        assert.ok(!x.stores.widgets.has('widget_mem'), 'nothing migrated before the chat load settles');
        assert.ok(!x.stores.widgets.has('widget_dash'), 'dashboard legacy rows wait with the chat candidates');
        // Loader settles: reassigns `chats`, flips the wipe-guard, clears in-flight.
        x.m.__scope.chats = memChats();
        x.m.__scope._chatsHydrated = true;
        x.m.__scope._chatsLoadInFlight = null;
        release();
        await flush();
        assert.ok(x.stores.widgets.has('widget_mem'), 'migrated once the chat load settled');
        assert.ok(x.stores.widgets.has('widget_dash'), 'dashboard row migrated too');
        assert.strictEqual(x.m.__scope.chats.c1.widgets[0].contentVersion, 1, 'deferred migration projected into the chat');
        assert.deepStrictEqual(chatsTouched(x.log), [], 'chats store never touched');
    }, { tags: ['unit'], timeout: 5000 });

    test('failed chat load skips the migration and a later init() retries it', async function() {
        var x = await setup({ chats: memChats(), hydrated: false });
        await x.m.WidgetStore.init();
        assert.ok(!x.stores.widgets.has('widget_mem'), 'skipped while chats are not hydrated');
        x.m.__scope._chatsHydrated = true; // degraded-mode retry succeeded
        await x.m.WidgetStore.init();
        assert.ok(x.stores.widgets.has('widget_mem'), 'retried and migrated on the next init()');
        assert.ok(x.stores.widgets.has('widget_dash'));
        assert.deepStrictEqual(chatsTouched(x.log), [], 'chats store never touched');
    }, { tags: ['unit'], timeout: 5000 });

    test('a retried init() projects the ids it migrated', async function() {
        var x = await setup({ chats: memChats(), hydrated: false });
        await x.m.WidgetStore.init();
        assert.strictEqual(x.m.__scope.chats.c1.widgets[0].contentVersion, undefined, 'nothing projected while skipped');
        x.m.__scope._chatsHydrated = true;
        await x.m.WidgetStore.init();
        assert.ok(x.stores.widgets.has('widget_mem'), 'retry migrated');
        assert.strictEqual(x.m.__scope.chats.c1.widgets[0].contentVersion, 1, 'retry projected into the chat');
        assert.strictEqual(x.m.__scope.dashboardWidgets.widget_dash.contentVersion, 2, 'retry projected the dashboard row');
    }, { tags: ['unit'], timeout: 5000 });

    test('remove() while the deferred pass is pending keeps the id absent', async function() {
        var release, inflight = new Promise(function(r) { release = r; });
        var x = await setup({ chats: memChats(), hydrated: false, inflight: inflight });
        await x.m.WidgetStore.init();
        await x.m.WidgetStore.remove('widget_mem');
        // The loader settles with a fresh map that still carries the widget
        // (the SW has not dropped it yet): the tombstone keeps it out.
        x.m.__scope.chats = memChats();
        x.m.__scope._chatsHydrated = true;
        x.m.__scope._chatsLoadInFlight = null;
        release();
        await flush();
        assert.ok(x.stores.widgets.has('widget_dash'), 'deferred pass ran');
        assert.ok(!x.stores.widgets.has('widget_mem'), 'removed id stays absent');
        assert.strictEqual(x.m.WidgetStore.view('widget_mem'), null);
        assert.ok(x.m.WidgetStore.isDeleted('widget_mem'));
    }, { tags: ['unit'], timeout: 5000 });

    // Candidates are collected when the deferred pass starts; a remove() that
    // lands mid-chain must not be undone by that id's migrate() transact.
    test('remove() landing mid deferred pass is not resurrected by migrate()', async function() {
        var release, inflight = new Promise(function(r) { release = r; });
        var x = await setup({ chats: {}, hydrated: false, inflight: inflight });
        await x.m.WidgetStore.init();
        var open, gate = new Promise(function(r) { open = r; });
        x.gates.widget_first = gate; // park the FIRST candidate's transact
        x.m.__scope.chats = { c1: { id: 'c1', messages: [{ role: 'user', content: 'hi' }], widgets: [
            { id: 'widget_first', title: 'F', html: '<b>f</b>', msgIndex: 0 },
            { id: 'widget_mem', title: 'Mem', html: '<b>1</b>', msgIndex: 1 }] } };
        x.m.__scope._chatsHydrated = true;
        x.m.__scope._chatsLoadInFlight = null;
        release();
        await flush(); // candidates collected, chain parked on widget_first
        assert.ok(!x.stores.widgets.has('widget_first') && !x.stores.widgets.has('widget_mem'), 'chain parked before any write');
        await x.m.WidgetStore.remove('widget_mem');
        open();
        await flush();
        assert.ok(x.stores.widgets.has('widget_first'), 'other candidates still migrate');
        assert.ok(!x.stores.widgets.has('widget_mem'), 'removed widget not written back');
        assert.strictEqual(x.m.WidgetStore.view('widget_mem'), null);
        assert.ok(!x.m.WidgetStore.list().some(function(w) { return w.id === 'widget_mem'; }), 'list() omits it');
        assert.ok(!x.m.__scope.chats.c1.widgets.some(function(w) { return w.id === 'widget_mem'; }), 'chat projection stays dropped');
    }, { tags: ['unit'], timeout: 5000 });

    test('an id shared by two chats takes origin.chatId from the lowest chat id (old cursor order)', async function() {
        // Insertion order c_b, c_a: the old chats-store cursor visited c_a first.
        var chats = {
            c_b: { id: 'c_b', messages: [{ role: 'user', content: 'b' }], widgets: [{ id: 'widget_dup', title: 'B', html: '<b>b</b>', msgIndex: 2 }] },
            c_a: { id: 'c_a', messages: [{ role: 'user', content: 'a' }], widgets: [{ id: 'widget_dup', title: 'A', html: '<b>a</b>', msgIndex: 5 }] }
        };
        var x = await setup({ chats: chats, hydrated: true });
        await x.m.WidgetStore.init();
        var row = x.stores.widgets.get('widget_dup');
        assert.strictEqual(row.origin.chatId, 'c_a', 'first chat in ascending key order');
        assert.strictEqual(row.origin.msgIndex, 5);
        assert.deepStrictEqual(row.versions.map(function(v) { return v.html; }), ['<b>a</b>', '<b>b</b>'], 'candidate order = ascending chat id');
    }, { tags: ['unit'], timeout: 5000 });
});
