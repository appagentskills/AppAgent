// Memory: WidgetStore.load() never opens the chats store (legacy widgets come
// from the in-memory chats map) and keeps dashboard history[] intact; riUsageRollup reuses a per-chat
// aggregate cache whose output must equal the uncached walk.
describe('widget store + usage rollup memory', function() {
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    // Minimal in-memory IndexedDB: requests settle on microtasks, the tx
    // completes once no request is pending.
    function fakeDb(stores, log) {
        return {
            transaction: function(names) {
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
                tx.objectStore = function(name) {
                    var s = stores[name] || (stores[name] = new Map());
                    return {
                        getAll: function() { log.push('getAll:' + name); return req(function() { return Array.from(s.values()).map(clone); }); },
                        get: function(k) { return req(function() { return s.has(k) ? clone(s.get(k)) : undefined; }); },
                        put: function(v) { return req(function() { s.set(v.id, clone(v)); return v.id; }); },
                        openCursor: function() {
                            log.push('cursor:' + name);
                            var keys = Array.from(s.keys()), i = 0, r = {};
                            tx.pending++;
                            function step() {
                                Promise.resolve().then(function() {
                                    if (i >= keys.length) { r.result = null; if (r.onsuccess) r.onsuccess(); settle(); return; }
                                    var k = keys[i++];
                                    r.result = { key: k, value: clone(s.get(k)), continue: step };
                                    if (r.onsuccess) r.onsuccess();
                                });
                            }
                            step();
                            return r;
                        }
                    };
                };
                return tx;
            }
        };
    }

    it('load() never opens the chats store; migrates legacy widgets from in-memory chats, keeps dashboard history', async function() {
        var stores = { widgets: new Map(), chats: new Map(), dashboardWidgets: new Map() }, log = [];
        // Decoy: a chats-store row whose widget is not in memory must never be read.
        stores.chats.set('c3', { id: 'c3', messages: [{ role: 'user', content: 'z' }], widgets: [{ id: 'w3', title: 'X', html: '<s>3</s>' }] });
        stores.chats.set('c2', { id: 'c2', messages: [{ role: 'user', content: 'y' }] });
        stores.dashboardWidgets.set('w2', { id: 'w2', title: 'D', html: '<i>2</i>', history: [{ html: '<i>1</i>', title: 'D' }] });
        var dash = { w2: { id: 'w2', title: 'D', html: '<i>2</i>', history: [{ html: '<i>1</i>' }] } };
        var db = fakeDb(stores, log);
        var mod = await loadModules(['src/js/core/135-widget-store.js'], { globals: {
            dbName: 'test', widgetStoreName: 'widgets', chatStoreName: 'chats', dashboardWidgetsStoreName: 'dashboardWidgets',
            BroadcastChannel: undefined, localStorage: { getItem: function() { return null; }, setItem: function() {} },
            chats: { c1: { id: 'c1', messages: [{ role: 'user', content: 'x' }], widgets: [{ id: 'w1', title: 'A', html: '<b>1</b>' }] } }, _chatsHydrated: true, _chatsLoadInFlight: null,
            chatWidgets: {}, dashboardWidgets: dash,
            openDatabase: function() { return Promise.resolve(db); },
            console: { log: function() {}, info: function() {}, warn: function() {}, error: function() {} }
        } });
        await mod.WidgetStore.init();
        assert.ok(log.indexOf('cursor:chats') === -1, 'chats store never cursored');
        assert.ok(log.indexOf('getAll:chats') === -1, 'no chats getAll');
        assert.ok(stores.widgets.has('w1'), 'chat widget migrated');
        assert.ok(!stores.widgets.has('w3'), 'chats-store-only widget not read');
        assert.ok(stores.widgets.has('w2'), 'dashboard widget migrated');
        assert.equal(stores.widgets.get('w2').versions.length, 2, 'history preserved in versions');
        assert.ok(Array.isArray(dash.w2.history) && dash.w2.history.length === 1, 'in-memory dashboard history kept (saves persist the whole row)');
        assert.ok(Array.isArray(stores.dashboardWidgets.get('w2').history), 'DB row untouched');
    });

    it('riUsageRollup cached results equal uncached across edits and deletes', async function() {
        var stores = { chats: new Map() }, log = [];
        function asst(i, o, extra) { return Object.assign({ role: 'assistant', metrics: Object.assign({ input_tokens: i, output_tokens: o, cache_read_tokens: 3, cache_write_tokens: 1, cache_creation_tokens: 2, cost: 0.01, endTime: Date.now() - 5000 }, extra || {}) }); }
        var now = Date.now();
        stores.chats.set('a', { id: 'a', title: 'A', model: 'm1', createdAt: now - 86400000, updatedAt: now - 1000,
            messages: [{ role: 'user' }, asst(100, 10), asst(0, 0), asst(50, 5, { isAggregate: true }), asst(7, 3, { actualModel: 'm2' })] });
        stores.chats.set('b', { id: 'b', title: 'B', createdAt: now - 3600000, updatedAt: now - 500,
            messages: [asst(20, 2, { endTime: 0 }), { role: 'assistant', timestamp: now - 2000, metrics: { input_tokens: 9 } }] });
        stores.chats.set('c', { id: 'c', title: 'C', messages: [{ role: 'user' }] });
        var db = fakeDb(stores, log);
        var mod = await loadModules(['src/js/tools/145-usage-rollup.js'], { globals: {
            openDatabase: function() { return Promise.resolve(db); }
        } });
        var variants = [{}, { series: 'hourly', by_model: true }, { series: 'daily' }, { series: 'monthly', page: 0, pageSize: 5 }];
        async function compare(label) {
            for (var i = 0; i < variants.length; i++) {
                var cached = await mod.riUsageRollup(clone(variants[i]));
                var again = await mod.riUsageRollup(clone(variants[i]));
                var plain = await mod.riUsageRollup(Object.assign(clone(variants[i]), { noCache: true }));
                assert.deepStrictEqual(cached, plain, label + ' variant ' + i + ' first');
                assert.deepStrictEqual(again, plain, label + ' variant ' + i + ' cache hit');
            }
        }
        await compare('initial');
        var first = await mod.riUsageRollup({});
        assert.equal(first.global.llm_calls, 4);
        assert.equal(first.global.input, 136);
        assert.equal(mod._riUsageCache.size, 3);
        var a = stores.chats.get('a');
        a.messages.push(asst(1000, 100)); a.updatedAt = now;
        await compare('after append');
        assert.equal((await mod.riUsageRollup({})).global.input, 1136, 'changed chat re-walked');
        stores.chats.delete('b');
        await compare('after delete');
        await mod.riUsageRollup({});
        assert.equal(mod._riUsageCache.size, 2, 'deleted chat evicted');
        assert.ok(!mod._riUsageCache.has('b'));
    });
});
