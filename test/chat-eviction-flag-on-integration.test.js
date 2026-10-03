// C2 flag-ON integration (CHAT_MESSAGE_EVICTION_ENABLED = true,
// src/js/core/130-indexeddb.js): end-to-end NO-LOSS round trip of cold-chat
// message eviction through the REAL code paths — core/130-indexeddb.js +
// worker/115-storage.js evaluated together (loadModules, one shared scope like
// the SW bundle) over ONE multi-store in-memory IndexedDB fake (chats,
// chat_payloads, settings) that persists across fresh realms:
//   realm 0  saveChatsToStorage persists rows + payload blobs
//   realm A  loadChatsFromStorage boot → sweepColdChatPayloads evicts cold
//            chats to skeletons → consumers (chatMessageCount, file-sum seed,
//            chatReferencedPayloadIds) → mutate-while-evicted
//            (_dirtyWhileEvicted → SAVE-DROP RESCUE) → hydrate + append + save
//            → blobs aged > 24h → sweepColdChatPayloads + sweepOrphanChatPayloads
//   realm B  fresh boot on the same data → ensureChatPayloads → every original
//            message + appended row present in order, all blobs present.
describe('C2 flag-ON cold-chat eviction integration (no loss)', function() {
    var HOUR = 60 * 60 * 1000;
    var U = { tags: ['unit'], timeout: 120000 };
    var MODULES = ['src/js/core/130-indexeddb.js', 'src/js/worker/115-storage.js'];

    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

    // ---- IDBKeyRange fake with real inclusion semantics
    function keyRange(lower, upper, lowerOpen, upperOpen) {
        return { lower: lower, upper: upper, lowerOpen: !!lowerOpen, upperOpen: !!upperOpen,
            includes: function(k) {
                if (lower !== undefined && (lowerOpen ? !(k > lower) : !(k >= lower))) return false;
                if (upper !== undefined && (upperOpen ? !(k < upper) : !(k <= upper))) return false;
                return true;
            } };
    }
    var FakeKeyRange = {
        bound: function(l, u, lo, uo) { return keyRange(l, u, lo, uo); },
        lowerBound: function(l, lo) { return keyRange(l, undefined, lo, false); },
        upperBound: function(u, uo) { return keyRange(undefined, u, false, uo); },
        only: function(v) { return keyRange(v, v, false, false); }
    };
    function inRange(range, k) {
        if (range == null) return true;
        if (typeof range.includes === 'function') return range.includes(k);
        return k === range;
    }

    // ---- Multi-store IndexedDB fake (extends test/gc-empty-chat-rows.test.js).
    // `data` = { storeName: { key: row } } is SHARED by every realm opened on
    // it, so a fresh loadModules realm sees exactly what the previous one
    // committed. Requests settle on microtasks; a transaction fires 'complete'
    // (listeners AND oncomplete) once its last request settled. Rows are
    // JSON-cloned on put and on read (structured-clone stand-in).
    function fakeIdb(data) {
        var calls = { opens: 0, txs: [], puts: [], dels: [] };
        var indexes = { chat_payloads: { at: 'at' } };
        function storeNamesList() {
            var names = Object.keys(data);
            return { contains: function(n) { return names.indexOf(n) >= 0; }, length: names.length,
                item: function(i) { return names[i]; } };
        }
        function makeTx(names, mode) {
            names = Array.isArray(names) ? names : [names];
            var listeners = {}, pending = 0, done = false;
            calls.txs.push({ names: names, mode: mode || 'readonly' });
            var tx = { mode: mode || 'readonly', error: null, objectStoreNames: storeNamesList(),
                addEventListener: function(t, f) { (listeners[t] = listeners[t] || []).push(f); },
                removeEventListener: function() {},
                abort: function() { if (!done) { done = true; fire('abort'); } },
                commit: function() {},
                objectStore: function(n) {
                    if (names.indexOf(n) < 0 || !data[n]) throw Object.assign(new Error('NotFoundError: ' + n), { name: 'NotFoundError' });
                    return makeStore(n);
                } };
            function fire(t) {
                (listeners[t] || []).forEach(function(l) { l({ target: tx }); });
                if (typeof tx['on' + t] === 'function') tx['on' + t]({ target: tx });
            }
            function request(compute, iter) {
                pending++;
                var r = { result: undefined, error: null, readyState: 'pending', transaction: tx };
                queueMicrotask(function() {
                    if (done) { pending--; return; }
                    try { r.result = compute(); } catch (e) {
                        r.error = e; r.readyState = 'done';
                        if (typeof r.onerror === 'function') r.onerror({ target: r, preventDefault: function() {} });
                        settle(); return;
                    }
                    r.readyState = 'done';
                    if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
                    settle();
                });
                function settle() {
                    pending--;
                    if (pending === 0) queueMicrotask(function() {
                        if (pending === 0 && !done) { done = true; fire('complete'); }
                    });
                }
                return r;
            }
            // Cursor over a snapshot of [primaryKey, key, value] tuples: each
            // continue() re-fires onsuccess on the SAME request (real IDB shape).
            function cursorRequest(tuples, keyOnly, storeName) {
                var r = { result: undefined, error: null, transaction: tx }, i = 0;
                function step() {
                    pending++;
                    queueMicrotask(function() {
                        if (done) { pending--; return; }
                        if (i < tuples.length) {
                            var t = tuples[i];
                            r.result = { primaryKey: t[0], key: t[1], value: keyOnly ? undefined : clone(t[2]),
                                continue: function() { i++; step(); },
                                'delete': function() { var k = t[0]; delete data[storeName][k]; calls.dels.push(storeName + ':' + k); return request(function() { return undefined; }); } };
                        } else r.result = null;
                        if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
                        pending--;
                        if (pending === 0) queueMicrotask(function() {
                            if (pending === 0 && !done) { done = true; fire('complete'); }
                        });
                    });
                }
                step();
                return r;
            }
            function makeStore(n) {
                function keys(range) { return Object.keys(data[n]).sort().filter(function(k) { return inRange(range, k); }); }
                var store = {
                    name: n, keyPath: 'id', indexNames: storeNamesList(),
                    get: function(k) { return request(function() { return clone(data[n][k]); }); },
                    getKey: function(k) { return request(function() { return Object.prototype.hasOwnProperty.call(data[n], k) ? k : undefined; }); },
                    put: function(v) {
                        if (tx.mode !== 'readwrite') throw Object.assign(new Error('ReadOnlyError'), { name: 'ReadOnlyError' });
                        var row = clone(v); calls.puts.push(n + ':' + row.id);
                        return request(function() { data[n][row.id] = row; return row.id; });
                    },
                    add: function(v) { return store.put(v); },
                    'delete': function(k) {
                        if (tx.mode !== 'readwrite') throw Object.assign(new Error('ReadOnlyError'), { name: 'ReadOnlyError' });
                        calls.dels.push(n + ':' + k);
                        return request(function() { delete data[n][k]; return undefined; });
                    },
                    clear: function() { return request(function() { Object.keys(data[n]).forEach(function(k) { delete data[n][k]; }); }); },
                    getAll: function(range) { return request(function() { return keys(range).map(function(k) { return clone(data[n][k]); }); }); },
                    getAllKeys: function(range) { return request(function() { return keys(range); }); },
                    count: function(range) { return request(function() { return keys(range).length; }); },
                    openCursor: function(range) { return cursorRequest(keys(range).map(function(k) { return [k, k, data[n][k]]; }), false, n); },
                    openKeyCursor: function(range) { return cursorRequest(keys(range).map(function(k) { return [k, k]; }), true, n); },
                    index: function(ixName) {
                        var field = (indexes[n] || {})[ixName];
                        if (!field) throw Object.assign(new Error('NotFoundError index ' + ixName), { name: 'NotFoundError' });
                        function tuples(range) {
                            return Object.keys(data[n]).filter(function(k) { var v = data[n][k]; return v && v[field] !== undefined && inRange(range, v[field]); })
                                .sort(function(a, b) { return data[n][a][field] - data[n][b][field]; })
                                .map(function(k) { return [k, data[n][k][field], data[n][k]]; });
                        }
                        return {
                            openKeyCursor: function(range) { return cursorRequest(tuples(range), true, n); },
                            openCursor: function(range) { return cursorRequest(tuples(range), false, n); },
                            getAllKeys: function(range) { return request(function() { return tuples(range).map(function(t) { return t[0]; }); }); },
                            count: function(range) { return request(function() { return tuples(range).length; }); }
                        };
                    }
                };
                return store;
            }
            return tx;
        }
        function makeConn() {
            return { name: 'test_AppAgentDB', version: 19, objectStoreNames: storeNamesList(),
                transaction: makeTx, close: function() {}, createObjectStore: function() {} };
        }
        return {
            calls: calls,
            indexedDB: { open: function() {
                calls.opens++;
                var r = { result: makeConn(), error: null };
                queueMicrotask(function() { if (typeof r.onsuccess === 'function') r.onsuccess({ target: r }); });
                return r;
            }, deleteDatabase: function() { return {}; } }
        };
    }

    // ---- one SW-like realm (core/130 + worker/115 in ONE scope) over `data`
    async function realm(data, opts) {
        opts = opts || {};
        var logs = [];
        function rec(level) {
            return function() { logs.push(level + ': ' + Array.prototype.map.call(arguments, function(a) { return (a && a.stack) ? String(a.stack) : String(a); }).join(' ')); };
        }
        var idb = fakeIdb(data);
        var g = {
            STORAGE_PREFIX: 'test_', indexedDB: idb.indexedDB, IDBKeyRange: FakeKeyRange,
            console: { log: rec('log'), info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug'), table: rec('table') },
            chats: opts.chats || {}, currentChatId: 'hot',
            runningChatIds: {}, isChatRunning: function() { return false; },
            _runCleanupGuard: {}, parkedToolCallsByChatId: {}, pausedChats: {}, pausedChatIds: {},
            _skelFileSums: new Map(),
            CHAT_META_TS_FIELDS: ['lastResponseAt', 'lastActivityAt', 'lastViewedAt', 'updatedAt', 'titleUpdatedAt'],
            CHAT_META_FLAG_FIELDS: ['_jobsHidden', 'pinned', '_lastApiError', 'pausedByUser']
        };
        var m = await loadModules(MODULES, { lenient: true, globals: g });
        return { m: m, s: m.__scope, g: g, idb: idb, logs: logs };
    }
    function errLines(r) { return r.logs.filter(function(l) { return /^error: /.test(l); }); }
    async function waitFor(pred, ms, what) {
        var t0 = Date.now();
        while (!pred()) {
            if (Date.now() - t0 > (ms || 10000)) throw new Error('timed out waiting for ' + (what || 'condition'));
            await new Promise(function(res) { setTimeout(res, 5); });
        }
    }

    // ---- fixtures: >512-char blobs (file_id + screenshot_id) and one heavy
    // text body (> CHAT_BODY_EVICT_MIN_CHARS) per chat.
    function mkChat(id, ageMin) {
        var now = Date.now();
        return {
            id: id, title: 'Chat ' + id, createdAt: now - 10 * HOUR, updatedAt: now - ageMin * 60000,
            messages: [
                { role: 'user', content: 'hello from ' + id },
                { role: 'user', content: 'see image', file_id: 'f_' + id, base64: 'data:image/png;base64,' + 'A'.repeat(900) + id },
                { role: 'assistant', content: 'long answer ' + id + ' ' + 'x'.repeat(2400) },
                { role: 'tool', content: 'screenshot taken', screenshot_id: 's_' + id, base64: 'data:image/png;base64,' + 'B'.repeat(700) + id }
            ]
        };
    }
    var BLOB_IDS = ['f_hot', 's_hot', 'f_cold1', 's_cold1', 'f_cold2', 's_cold2'];

    test('evict → consume → mutate-while-evicted → save → sweeps (>24h) → fresh-realm reload: every message, appended row and blob survives', async function() {
        var originals = { hot: mkChat('hot', 1), cold1: mkChat('cold1', 30), cold2: mkChat('cold2', 60) };
        var data = { chats: {}, chat_payloads: {}, settings: {} };

        // ── realm 0: persist rows + payload blobs through the REAL SW save
        var r0 = await realm(data, { chats: clone(originals) });
        assert.strictEqual(r0.m.CHAT_MESSAGE_EVICTION_ENABLED, true, 'flag must be ON');
        r0.s._chatsHydrated = true;
        var out0 = await r0.m.saveChatsToStorage();
        assert.deepStrictEqual(out0, { ok: true }, 'initial save commits: ' + errLines(r0).join(' | '));
        assert.deepStrictEqual(Object.keys(data.chats).sort(), ['cold1', 'cold2', 'hot']);
        assert.deepStrictEqual(Object.keys(data.chat_payloads).sort(), BLOB_IDS.slice().sort(), 'one blob row per payload');
        Object.keys(data.chats).forEach(function(id) {
            assert.strictEqual(data.chats[id].messages.length, 4, id + ' row has every message');
            data.chats[id].messages.forEach(function(msg) { assert.strictEqual(msg.base64, undefined, id + ': no inline base64 on disk'); });
            assert.strictEqual(data.chats[id].messages[2].content, originals[id].messages[2].content, id + ': full heavy body on disk');
        });

        // ── realm A: boot load from disk, then cold-chat eviction
        var rA = await realm(data);
        await rA.m.loadChatsFromStorage();
        assert.strictEqual(rA.s._chatsHydrated, true, 'boot load hydrates');
        assert.deepStrictEqual(Object.keys(rA.g.chats).sort(), ['cold1', 'cold2', 'hot']);
        rA.m.sweepColdChatPayloads(0, true);
        var chatsA = rA.g.chats;
        ['cold1', 'cold2'].forEach(function(id) {
            var c = chatsA[id];
            assert.strictEqual(c._messagesEvicted, true, id + ' is a message-evicted skeleton');
            assert.strictEqual(Array.isArray(c.messages), false, id + ' skeleton holds no messages');
            assert.strictEqual(rA.m.chatMessageCount(c), 4, id + ' chatMessageCount from _msgCount');
            var refs = rA.m.chatReferencedPayloadIds(c);
            assert.ok(refs && refs['f_' + id] && refs['s_' + id], id + ' skeleton still knows its blob refs');
        });
        // SW boot (115 loader) seeds + evicts EVERY durable boot row — the SW
        // realm has no page "current chat" — so hot is a skeleton here too; it
        // must still count/round-trip exactly (verified in realm B below).
        assert.strictEqual(rA.m.chatMessageCount(chatsA.hot), 4, 'hot count intact while boot-evicted');

        // consumer: the SW file-sum seed on a skeleton refuses cleanly, loses nothing
        var skel1 = clone(chatsA.cold1);
        assert.strictEqual(rA.m._swEvictChatSeedingFileSum(chatsA.cold1), false, 'seed+evict on a skeleton is a no-op');
        assert.deepStrictEqual(clone(chatsA.cold1), skel1, 'skeleton unchanged by the seed');

        // ── mutate while evicted → SAVE-DROP RESCUE (hydrate → clear dirty → re-save)
        chatsA.cold1.stampWhileEvicted = 'S1';
        chatsA.cold1._dirtyWhileEvicted = true;
        await rA.m.saveChatsToStorage();
        await waitFor(function() {
            return !(rA.g.chats.cold1 || {})._dirtyWhileEvicted && data.chats.cold1.stampWhileEvicted === 'S1'
                && Object.keys(rA.s._evictedRescueInFlight).length === 0 && !rA.s._workerSavePending;
        }, 15000, 'cold1 rescue to persist the evicted mutation');
        assert.strictEqual(data.chats.cold1.messages.length, 4, 'rescue re-save kept every stored message');
        assert.strictEqual(data.chats.cold1.messages[2].content, originals.cold1.messages[2].content, 'rescue did not persist an evicted body placeholder');

        // ── append a row to each cold chat via the supported path (hydrate first)
        for (var id of ['cold1', 'cold2']) {
            await rA.m.ensureChatPayloads(id);
            var c = rA.g.chats[id];
            assert.ok(Array.isArray(c.messages), id + ' hydrated back');
            assert.strictEqual(c._messagesEvicted, undefined, id + ' skeleton flag cleared');
            assert.deepStrictEqual(clone(c.messages), clone(originals[id].messages), id + ' hydrate restores every message, blob and body');
            c.messages.push({ role: 'user', content: 'appended to ' + id });
            var outA = await rA.m.saveChatsToStorage();
            assert.deepStrictEqual(outA, { ok: true }, id + ' append save commits');
            assert.strictEqual(data.chats[id].messages.length, 5, id + ' appended row durable');
            assert.strictEqual(data.chats[id].messages[4].content, 'appended to ' + id);
        }

        // ── sweeps with every blob aged past the 24h GC floor
        var old = Date.now() - 48 * HOUR;
        Object.keys(data.chat_payloads).forEach(function(k) { data.chat_payloads[k].at = old; });
        data.chat_payloads.orphan_old = { id: 'orphan_old', base64: 'Z'.repeat(600), at: old };
        data.chat_payloads.orphan_fresh = { id: 'orphan_fresh', base64: 'Y'.repeat(600), at: Date.now() };
        rA.m.sweepColdChatPayloads(0, true);
        ['cold1', 'cold2'].forEach(function(id) {
            assert.strictEqual(rA.g.chats[id]._messagesEvicted, true, id + ' re-evicted after its durable append');
            assert.strictEqual(rA.m.chatMessageCount(rA.g.chats[id]), 5, id + ' count includes the appended row');
        });
        await rA.m.sweepOrphanChatPayloads();
        assert.strictEqual(data.chat_payloads.orphan_old, undefined, 'positive control: old unreferenced blob GC\'d — logs: ' + rA.logs.filter(function(l) { return /orphan|payload/i.test(l); }).join(' | '));
        assert.ok(data.chat_payloads.orphan_fresh, 'fresh unreferenced blob kept (24h floor)');
        BLOB_IDS.forEach(function(b) { assert.ok(data.chat_payloads[b], 'referenced blob ' + b + ' survives the orphan sweep'); });
        assert.deepStrictEqual(errLines(rA), [], 'no console.error in realm A');

        // ── realm B: fresh boot on the same data, hydrate, verify no loss
        var rB = await realm(data);
        await rB.m.loadChatsFromStorage();
        assert.strictEqual(rB.s._chatsHydrated, true);
        rB.m.sweepColdChatPayloads(0, true);
        for (var id2 of ['hot', 'cold1', 'cold2']) {
            await rB.m.ensureChatPayloads(id2);
            var cb = rB.g.chats[id2];
            var expected = clone(originals[id2].messages);
            if (id2 !== 'hot') expected.push({ role: 'user', content: 'appended to ' + id2 });
            assert.ok(Array.isArray(cb.messages), id2 + ' hydrated in realm B');
            assert.strictEqual(cb._payloadsEvicted, undefined, id2 + ' payloads fully hydrated');
            assert.strictEqual(cb._messagesEvicted, undefined, id2 + ' messages restored');
            assert.deepStrictEqual(clone(cb.messages), expected, id2 + ': every message (and appended row) present, in order, with blobs + bodies');
            assert.strictEqual(rB.m.chatMessageCount(cb), expected.length, id2 + ' count matches');
            var refsB = rB.m.chatReferencedPayloadIds(cb);
            Object.keys(refsB || {}).forEach(function(b) { assert.ok(data.chat_payloads[b], id2 + ' references blob ' + b + ' that exists'); });
        }
        assert.strictEqual(rB.g.chats.cold1.stampWhileEvicted, 'S1', 'mutation made while evicted survived the reload');
        assert.deepStrictEqual(errLines(rB), [], 'no console.error in realm B');
    }, U);

    test('hot (never-evicted, current) chat round-trips unchanged; a re-save in the new realm writes an identical row', async function() {
        var hot = mkChat('hot', 1);
        var data = { chats: {}, chat_payloads: {}, settings: {} };
        var r0 = await realm(data, { chats: { hot: clone(hot) } });
        r0.s._chatsHydrated = true;
        assert.deepStrictEqual(await r0.m.saveChatsToStorage(), { ok: true });
        assert.ok(Array.isArray(r0.g.chats.hot.messages), 'current chat not evicted by the post-save sweep');
        var rowAfterFirstSave = clone(data.chats.hot);

        var rB = await realm(data);
        await rB.m.loadChatsFromStorage();
        rB.m.sweepColdChatPayloads(0, true);
        assert.strictEqual(rB.m.chatMessageCount(rB.g.chats.hot), 4, 'boot-evicted hot keeps its count');
        await rB.m.ensureChatPayloads('hot');
        assert.deepStrictEqual(clone(rB.g.chats.hot.messages), clone(hot.messages), 'hot messages identical after reload + hydrate');
        assert.strictEqual(rB.g.chats.hot.title, hot.title);
        assert.deepStrictEqual(await rB.m.saveChatsToStorage(), { ok: true });
        assert.deepStrictEqual(clone(data.chats.hot.messages), rowAfterFirstSave.messages, 're-save writes the same message rows');
        ['f_hot', 's_hot'].forEach(function(b) { assert.ok(data.chat_payloads[b] && data.chat_payloads[b].base64 === hot.messages[b[0] === 'f' ? 1 : 3].base64, b + ' blob intact'); });
        assert.deepStrictEqual(errLines(rB), []);
    }, U);
});
