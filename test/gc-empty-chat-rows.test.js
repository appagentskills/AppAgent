// F3 (Boot OOM fix, round 3): gcEmptyChatRows' candidate scan is a KEY-DIFF
// (getAllKeys() minus the in-memory chats map, then by-key re-reads in small
// readonly batches) instead of a value openCursor() over every transcript,
// gated on _chatsHydrated === true; and sweepColdChatPayloads' keep-set no
// longer spends slots on retired sub-agent rows. Drives the REAL
// src/js/core/130-indexeddb.js with only IndexedDB + console faked.
describe('F3 gcEmptyChatRows key-diff + sweep keep-set', function() {
    var DAY = 24 * 60 * 60 * 1000;
    var U = { tags: ['unit'], timeout: 20000 };

    // Minimal IndexedDB fake: ONE keyed store shared by every transaction.
    // Requests settle on microtasks; a transaction fires 'complete' (listeners
    // AND the oncomplete property) once its last request has settled.
    function fakeIdb(rows) {
        var data = Object.assign({}, rows || {});
        var calls = { opens: 0, txs: [], getAllKeys: 0, openCursor: 0, getAll: 0, gets: [], dels: [] };
        var api = {
            calls: calls, onGet: null, failTx: false,
            has: function(k) { return Object.prototype.hasOwnProperty.call(data, k); },
            set: function(k, v) { var next = Object.assign({}, data); next[k] = v; data = next; }
        };
        function makeTx(names, mode) {
            if (api.failTx) throw Object.assign(new Error('boom'), { name: 'UnknownError' });
            var listeners = {}, pending = 0, done = false;
            var info = { names: names, mode: mode, gets: 0 };
            calls.txs.push(info);
            var tx = { mode: mode, error: null,
                addEventListener: function(t, f) { (listeners[t] = listeners[t] || []).push(f); },
                abort: function() { if (!done) { done = true; fire('abort'); } },
                objectStore: function() { return store; } };
            function fire(t) {
                (listeners[t] || []).forEach(function(l) { l({ target: tx }); });
                if (typeof tx['on' + t] === 'function') tx['on' + t]({ target: tx });
            }
            function request(compute) {
                pending++;
                var r = {};
                queueMicrotask(function() {
                    r.result = compute();
                    if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
                    pending--;
                    if (pending === 0) queueMicrotask(function() {
                        if (pending === 0 && !done) { done = true; fire('complete'); }
                    });
                });
                return r;
            }
            var store = {
                getAllKeys: function() { calls.getAllKeys++; return request(function() { return Object.keys(data).sort(); }); },
                get: function(k) {
                    calls.gets.push(k); info.gets++;
                    return request(function() { var v = data[k]; if (api.onGet) api.onGet(k, mode); return v; });
                },
                openCursor: function() { calls.openCursor++; return request(function() { return null; }); },
                getAll: function() { calls.getAll++; return request(function() { return []; }); },
                'delete': function(k) {
                    calls.dels.push(k);
                    return request(function() {
                        var rest = {};
                        Object.keys(data).forEach(function(x) { if (x !== k) rest[x] = data[x]; });
                        data = rest;
                    });
                }
            };
            return tx;
        }
        var conn = { close: function() {}, transaction: makeTx };
        api.indexedDB = { open: function() {
            calls.opens++;
            var r = { result: conn };
            queueMicrotask(function() { if (r.onsuccess) r.onsuccess({ target: r }); });
            return r;
        } };
        return api;
    }

    async function load(opts) {
        var logs = [];
        function rec(level) {
            return function() { logs.push(level + ': ' + Array.prototype.map.call(arguments, function(a) { return String(a); }).join(' ')); };
        }
        var idb = fakeIdb(opts.rows);
        var g = { STORAGE_PREFIX: 'test_', indexedDB: idb.indexedDB,
            console: { log: rec('log'), info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug'), table: rec('table') },
            chats: opts.chats || {}, runningChatIds: opts.running || {} };
        if (Object.prototype.hasOwnProperty.call(opts, 'hydrated')) g._chatsHydrated = opts.hydrated;
        Object.assign(g, opts.globals || {});
        var m = await loadModules(['src/js/core/130-indexeddb.js'], { globals: g });
        return { m: m, idb: idb, logs: logs };
    }
    function oldRow(id, extra) {
        var t = Date.now() - 3 * DAY;
        return Object.assign({ id: id, title: id, messages: [], createdAt: t, updatedAt: t }, extra || {});
    }
    function gcLines(logs) { return logs.filter(function(l) { return l.indexOf('empty-row GC: reaped') !== -1; }); }

    test('reaps only rows absent from memory AND empty on disk AND past 24h AND not running; keys-only scan, no value cursor', async function() {
        var r = await load({
            hydrated: true,
            rows: {
                e_old: oldRow('e_old'),
                e_mem: oldRow('e_mem'),
                e_fresh: oldRow('e_fresh', { updatedAt: Date.now() - 60 * 1000 }),
                e_active: oldRow('e_active', { lastActivityAt: Date.now() - 60 * 1000 }),
                e_run: oldRow('e_run'),
                full: oldRow('full', { messages: [{ role: 'user', content: 'keep me' }] }),
                hot: oldRow('hot', { messages: [{ role: 'user', content: 'hydrated' }] })
            },
            chats: { e_mem: { id: 'e_mem', messages: [] }, hot: { id: 'hot', messages: [{ role: 'user', content: 'hydrated' }] } },
            running: { e_run: true }
        });
        var reaped = await r.m.gcEmptyChatRows();
        assert.strictEqual(reaped, 1);
        assert.strictEqual(r.idb.has('e_old'), false, 'the one qualifying row is reaped');
        ['e_mem', 'e_fresh', 'e_active', 'e_run', 'full', 'hot'].forEach(function(id) {
            assert.strictEqual(r.idb.has(id), true, id + ' must survive');
        });
        assert.deepStrictEqual(r.idb.calls.dels, ['e_old']);
        assert.strictEqual(r.idb.calls.openCursor, 0, 'no value openCursor');
        assert.strictEqual(r.idb.calls.getAll, 0, 'no range-less value getAll');
        assert.strictEqual(r.idb.calls.getAllKeys, 1, 'one keys-only scan');
        // By-key reads: exactly the ids ABSENT from memory (memory-held ids are
        // never materialised), plus the delete tx's own re-read of e_old.
        assert.deepStrictEqual(r.idb.calls.gets.slice().sort(), ['e_active', 'e_fresh', 'e_old', 'e_old', 'e_run', 'full']);
        var rw = r.idb.calls.txs.filter(function(t) { return t.mode === 'readwrite'; });
        assert.strictEqual(rw.length, 1, 'one readwrite tx: the deleteChatRow for e_old');
        assert.deepStrictEqual(gcLines(r.logs), ['log: [chat-delete] empty-row GC: reaped 1 of 1 empty candidate row(s)']);
    }, U);

    test('a candidate absent from memory but NON-empty on disk survives (no delete issued)', async function() {
        var r = await load({ hydrated: true, chats: {},
            rows: { full: oldRow('full', { messages: [{ role: 'user', content: 'x' }] }) } });
        assert.strictEqual(await r.m.gcEmptyChatRows(), 0);
        assert.strictEqual(r.idb.has('full'), true);
        assert.deepStrictEqual(r.idb.calls.dels, []);
        assert.deepStrictEqual(r.idb.calls.gets, ['full']);
        assert.strictEqual(r.idb.calls.txs.every(function(t) { return t.mode === 'readonly'; }), true);
        assert.deepStrictEqual(gcLines(r.logs), []);
    }, U);

    test('a row that gains messages after the by-key pre-filter is refused by the delete tx and survives', async function() {
        var r = await load({ hydrated: true, chats: {}, rows: { race: oldRow('race') } });
        r.idb.onGet = function(k, mode) {
            if (k === 'race' && mode === 'readonly') r.idb.set('race', oldRow('race', { messages: [{ role: 'user', content: 'typed' }] }));
        };
        assert.strictEqual(await r.m.gcEmptyChatRows(), 0);
        assert.strictEqual(r.idb.has('race'), true);
        assert.deepStrictEqual(r.idb.calls.dels, []);
        assert.deepStrictEqual(gcLines(r.logs), ['log: [chat-delete] empty-row GC: reaped 0 of 1 empty candidate row(s)']);
    }, U);

    test('unhydrated map (false or undeclared): returns 0 with zero IDB access', async function() {
        var variants = [{ hydrated: false }, {}];
        for (var i = 0; i < variants.length; i++) {
            var r = await load(Object.assign({ chats: {}, rows: { e_old: oldRow('e_old') } }, variants[i]));
            var opensAtLoad = r.idb.calls.opens;
            assert.strictEqual(await r.m.gcEmptyChatRows(), 0);
            assert.strictEqual(r.idb.calls.opens, opensAtLoad, 'no IDB open');
            assert.strictEqual(r.idb.calls.txs.length, 0, 'no transaction');
            assert.strictEqual(r.idb.calls.getAllKeys + r.idb.calls.gets.length + r.idb.calls.openCursor + r.idb.calls.getAll, 0);
            assert.strictEqual(r.idb.has('e_old'), true);
            assert.deepStrictEqual(gcLines(r.logs), []);
        }
    }, U);

    test('per-boot cap: at most 200 candidates, read by key in batches of <= 25, cap log kept', async function() {
        var rows = {};
        for (var i = 0; i < 230; i++) { var id = 'e' + String(i).padStart(3, '0'); rows[id] = oldRow(id); }
        var r = await load({ hydrated: true, chats: {}, rows: rows });
        assert.strictEqual(await r.m.gcEmptyChatRows(), 200);
        assert.strictEqual(r.idb.calls.dels.length, 200);
        assert.strictEqual(Object.keys(rows).filter(function(k) { return r.idb.has(k); }).length, 30);
        var ro = r.idb.calls.txs.filter(function(t) { return t.mode === 'readonly'; });
        assert.strictEqual(ro.reduce(function(s, t) { return s + t.gets; }, 0), 200, 'by-key reading stops at the cap');
        assert.strictEqual(ro.every(function(t) { return t.gets <= 25; }), true, 'batches of <= 25');
        var lines = gcLines(r.logs);
        assert.strictEqual(lines.length, 1);
        assert.match(lines[0], /reaped 200 of 200 empty candidate row\(s\) \(per-boot cap hit/);
    }, U);

    test('store failure keeps the contract: resolves 0 and warns', async function() {
        var r = await load({ hydrated: true, chats: {}, rows: { e_old: oldRow('e_old') } });
        r.idb.failTx = true;
        assert.strictEqual(await r.m.gcEmptyChatRows(), 0);
        assert.strictEqual(r.idb.has('e_old'), true);
        assert.strictEqual(r.logs.some(function(l) { return l.indexOf('empty-row GC failed') !== -1; }), true);
    }, U);

    // ── sweepColdChatPayloads keep-set (B design) ─────────────────────────
    function mkChats() {
        var now = Date.now();
        function mk(id, ageMin, extra) {
            return Object.assign({ id: id, updatedAt: now - ageMin * 60000, createdAt: now - DAY,
                messages: [{ role: 'user', content: 'img', file_id: 'f_' + id, base64: 'data:image/png;base64,QUFB' }] }, extra || {});
        }
        return {
            r1: mk('r1', 1, { retiredSubAgent: true }),
            a: mk('a', 2), b: mk('b', 3), c: mk('c', 4),
            cur: mk('cur', 5, { retiredSubAgent: true }),
            rrun: mk('rrun', 6, { retiredSubAgent: true }),
            guard: mk('guard', 7)
        };
    }
    function strippedIds(map) {
        return Object.keys(map).filter(function(id) { return map[id].messages[0].base64 === undefined; }).sort();
    }
    var sweepGlobals = { currentChatId: 'cur', isChatRunning: function(id) { return id === 'rrun'; }, _runCleanupGuard: { guard: true } };

    test('sweep keep-set: newest K NON-retired kept, retired rows swept, current/running/cleanup-guarded still protected', async function() {
        var map = mkChats();
        var r = await load({ hydrated: true, rows: {}, chats: map, globals: sweepGlobals });
        var swept = r.m.sweepColdChatPayloads(2, false);
        // r1 (newest, retired) no longer burns a slot; a+b fill K=2; c is cold.
        assert.deepStrictEqual(strippedIds(map), ['c', 'r1']);
        assert.strictEqual(swept, 2);
    }, U);

    test('sweep keep-set: K=0 (SW) sweeps every unprotected chat, protections unchanged', async function() {
        var map = mkChats();
        var r = await load({ hydrated: true, rows: {}, chats: map, globals: sweepGlobals });
        assert.strictEqual(r.m.sweepColdChatPayloads(0, false), 4);
        assert.deepStrictEqual(strippedIds(map), ['a', 'b', 'c', 'r1']);
    }, U);
});
