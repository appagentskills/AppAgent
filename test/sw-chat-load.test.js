// F2 (Boot OOM fix) regression tests for the BATCHED service-worker boot
// load in src/js/worker/115-storage.js: loadChatsFromStorage is now a
// single-flight wrapper over _swLoadChatsFromStorageBatched (one key-only
// getAllKeys pass, then getAll(range) batches of SW_CHATS_LOAD_BATCH_SIZE,
// each in its OWN readonly withStore, then ONE synchronous commit).
// The REAL source is evaluated with in-memory fakes for the IDB layer
// (withStore, IDBKeyRange, requests) and the REAL stripChatPayloadsInPlace,
// brace-cut from src/js/core/130-indexeddb.js and wrapped in a spy.
// ORACLE: the same source with a frozen verbatim copy of the PRE-F2 loader
// (ONE range-less store.getAll(); preF2LoaderHolder at the bottom) appended.
// The later function declaration wins, so old and new run over identical
// stores and their end states are compared.
describe('SW batched chat load (F2 boot OOM fix)', function() {
    var STORE = 'chats';
    var _sourcesP = null;
    function sources() {
        if (!_sourcesP) {
            _sourcesP = Promise.all([
                loadFile('src/js/worker/115-storage.js'),
                loadFile('src/js/core/130-indexeddb.js')
            ]).then(function(r) {
                var core = r[1];
                var at = core.indexOf('function stripChatPayloadsInPlace(');
                var end = at < 0 ? -1 : core.indexOf('\n}\n', at);
                if (end < 0) throw new Error('stripChatPayloadsInPlace not found in core/130-indexeddb.js');
                return { src: r[0], strip: core.slice(at, end + 2), oldLoader: preF2LoaderSource() };
            });
        }
        return _sourcesP;
    }
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    function idbError(name, msg) { var e = new Error(msg || name); e.name = name; return e; }
    function byId(a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); }

    // ---- fake IDBKeyRange: real inclusion/validation semantics for string keys
    function keyRange(kind, lower, upper, lowerOpen, upperOpen) {
        if (lower !== undefined && upper !== undefined
            && (lower > upper || (lower === upper && (lowerOpen || upperOpen)))) {
            throw idbError('DataError', 'invalid key range');
        }
        return {
            kind: kind, lower: lower, upper: upper, lowerOpen: !!lowerOpen, upperOpen: !!upperOpen,
            includes: function(k) {
                if (lower !== undefined && (lowerOpen ? !(k > lower) : !(k >= lower))) return false;
                if (upper !== undefined && (upperOpen ? !(k < upper) : !(k <= upper))) return false;
                return true;
            }
        };
    }
    var FakeKeyRange = {
        bound: function(l, u, lo, uo) { return keyRange('bound', l, u, lo, uo); },
        lowerBound: function(l, lo) { return keyRange('lowerBound', l, undefined, lo, false); },
        upperBound: function(u, uo) { return keyRange('upperBound', undefined, u, false, uo); },
        only: function(v) { return keyRange('only', v, v, false, false); }
    };

    // ---- env: the REAL 115 source over an in-memory chats store
    //  opts.rows     disk records (cloned in; every read returns fresh clones)
    //  opts.chats    pre-boot adopted entries already in the chats map
    //  opts.pending  _swChatMetaPendingByChatId (boot-window meta dispatches)
    //  opts.failOp   fn(op, env) -> Error|null: each request's outcome
    //  opts.afterOp  fn(op, env): runs right after a request's onsuccess
    //  opts.oracle   append the frozen PRE-F2 loader (overrides the new one)
    async function makeEnv(opts) {
        opts = opts || {};
        var s = await sources();
        var env = {
            db: new Map(), ops: [], txs: [], logs: [], warns: [], errors: [],
            stripCalls: [], overlayCalls: [], applyCalls: [], rebuilds: 0, deleteCalls: [],
            chats: clone(opts.chats || {}), pending: clone(opts.pending || {}),
            pausedChats: {}, pausedChatIds: {},
            failOp: opts.failOp || null, afterOp: opts.afterOp || null
        };
        (opts.rows || []).forEach(function(r) { env.db.set(r.id, clone(r)); });
        function sortedKeys() { return Array.from(env.db.keys()).sort(); }
        function request(op) {
            var req = { result: undefined, error: null, onsuccess: null, onerror: null };
            env.ops.push(op);
            Promise.resolve().then(function() {
                var err = env.failOp ? env.failOp(op, env) : null;
                if (err) { req.error = err; if (req.onerror) req.onerror({ target: req }); return; }
                req.result = op.compute();
                if (req.onsuccess) req.onsuccess({ target: req });
                if (env.afterOp) env.afterOp(op, env);
            });
            return req;
        }
        function makeTx(txRec) {
            function op(kind, args) {
                return { op: kind, argc: args.length, range: args[0], tx: txRec.index, attempt: txRec.attempts, index: env.ops.length };
            }
            return {
                objectStore: function(name) {
                    if (name !== STORE) throw new Error('unexpected store ' + name);
                    return {
                        getAllKeys: function() {
                            var o = op('getAllKeys', arguments);
                            o.compute = function() { return sortedKeys(); };
                            return request(o);
                        },
                        getAll: function(range) {
                            var o = op('getAll', arguments);
                            o.compute = function() {
                                return sortedKeys().filter(function(k) { return range == null || range.includes(k); })
                                    .map(function(k) { return clone(env.db.get(k)); });
                            };
                            return request(o);
                        },
                        get: function() { throw new Error('boot load must not issue per-key gets'); },
                        put: function() { throw new Error('boot load must not write'); }
                    };
                }
            };
        }
        // Mirrors core/130 withStore: ONE retry, on a fresh transaction (the fn
        // runs again from scratch), when the first attempt hit a dead connection.
        function withStore(storeNames, mode, fn) {
            var txRec = { index: env.txs.length, storeNames: storeNames, mode: mode, attempts: 0, outcome: 'pending' };
            env.txs.push(txRec);
            function attempt() {
                txRec.attempts++;
                var tx = makeTx(txRec);
                return Promise.resolve().then(function() { return fn(tx); });
            }
            return attempt().catch(function(e) {
                if (e && e.name === 'InvalidStateError' && txRec.attempts === 1) return attempt();
                throw e;
            }).then(function(v) { txRec.outcome = 'resolved'; return v; },
                function(e) { txRec.outcome = 'rejected'; txRec.error = e; throw e; });
        }
        // REAL strip (CHAT_BODY_EVICT_MIN_CHARS only matters with evictBodies,
        // which the SW must never pass: the long bodies below would be evicted).
        var realStrip = new Function('CHAT_BODY_EVICT_MIN_CHARS', s.strip + '\n;return stripChatPayloadsInPlace;')(1024);
        function stripSpy(c) {
            env.stripCalls.push({ id: c && c.id, argc: arguments.length });
            return realStrip.apply(null, arguments);
        }
        function overlay(prev, next) {
            env.overlayCalls.push({ disk: prev.id, kept: next.id, diskStripped: prev._payloadsEvicted === true });
            next.metaOverlays = (next.metaOverlays || 0) + 1;
            if ((prev.updatedAt || 0) > (next.updatedAt || 0)) next.updatedAt = prev.updatedAt;
        }
        function applyMeta(rec, fields) {
            env.applyCalls.push(rec.id);
            Object.keys(fields).forEach(function(k) { rec[k] = fields[k]; });
        }
        var inject = [
            ['chats', env.chats], ['withStore', withStore], ['IDBKeyRange', FakeKeyRange],
            ['stripChatPayloadsInPlace', stripSpy], ['_swOverlayChatMeta', overlay],
            ['_swApplyChatMetaFields', applyMeta], ['_swChatMetaPendingByChatId', env.pending],
            ['pausedChats', env.pausedChats], ['pausedChatIds', env.pausedChatIds],
            ['rebuildFileIndexAll', function() { env.rebuilds++; }],
            ['ensureChatPayloads', function() { return Promise.resolve(); }],
            ['primeChatPayloadIdCache', function(tx, cb) { cb(); }],
            ['extractChatPayloadsForPut', function(c) { return { record: c, payloads: [] }; }],
            ['queueChatPayloadPuts', function() { return 0; }],
            ['_mergeChatRowForPut', function(r) { return r; }],
            ['CHAT_META_TS_FIELDS', []], ['CHAT_META_FLAG_FIELDS', []],
            ['chatStoreName', STORE], ['chatPayloadsStoreName', 'chat_payloads'],
            ['sweepColdChatPayloads', function() {}],
            // DELETE-RACE: the chats-row delete primitive (core/130) that the SW delete
            // lane (scheduleChatRowDelete -> deleteChatFromDB) calls; true = verified gone.
            ['deleteChatRow', function(id) { env.deleteCalls.push(id); env.db.delete(id); return Promise.resolve(true); }],
            ['console', { log: function(m) { env.logs.push(String(m)); }, warn: function(m) { env.warns.push(String(m)); },
                error: function(m) { env.errors.push(String(m)); } }],
            ['chrome', undefined] // TA-3: the EOF listener registration never touches a real chrome
        ];
        var body = s.src + (opts.oracle ? '\n;\n' + s.oldLoader + '\n' : '') + '\n;return {' +
            'load: loadChatsFromStorage,' +
            'hydrated: function() { return _chatsHydrated; },' +
            'loadStats: function() { return swChatLoadStats; },' +
            'queue: function() { return _legacyPayloadMigrationQueue; },' +
            'setQueue: function(q) { _legacyPayloadMigrationQueue = q; },' +
            'inFlight: function() { return _swChatsLoadInFlight; },' +
            'scheduleDelete: scheduleChatRowDelete,' +
            'pendingDeletes: function() { return _pendingDeletes; },' +
            'loadDeletedIds: function() { return _swChatsLoadDeletedIds; },' +
            'batchSize: SW_CHATS_LOAD_BATCH_SIZE };';
        env.api = new Function(inject.map(function(p) { return p[0]; }).join(','), body)
            .apply(null, inject.map(function(p) { return p[1]; }));
        return env;
    }

    // ---- fixtures: one record shape per loader branch (i % 8)
    function rowId(i) { return 'c' + ('00' + i).slice(-3); }
    function makeRow(i) {
        var row = { id: rowId(i), title: 'chat ' + i, updatedAt: 1000 + i, messages: [{ role: 'user', content: 'hello ' + i }] };
        switch (i % 8) {
            case 0: // legacy inline image WITH a file_id pointer: stripped, queued, b64-counted
                row.messages.push({ role: 'user', content: 'img', file_id: 'f' + i, base64: 'A'.repeat(64 + i) });
                break;
            case 1: // screenshot base64: stripped, queued, b64-counted
                row.screenshots = {};
                row.screenshots['s' + i] = { base64: 'B'.repeat(80), mime: 'image/png' };
                break;
            case 2: // cached tool result fullContent (MEMFIX-CTR): stripped, queued, NOT b64-counted
                row.cachedToolResults = { ctr: { fullContent: 'x'.repeat(200) } };
                break;
            case 3: // base64 with NO file_id/screenshot_id: never stripped (no pointer), still b64-counted
                row.messages.push({ role: 'user', content: 'raw', base64: 'C'.repeat(50) });
                break;
            case 4: // empty history: filtered out by the loader
                row.messages = [];
                break;
            case 5: // heavy TEXT bodies: kept intact (the SW never evicts bodies)
                row.messages.push({ role: 'tool', content: 'T'.repeat(5000), tool_call_id: 't' + i });
                row.messages.push({ role: 'assistant', content: 'ok', thinking: 'H'.repeat(5000),
                    reasoning_details: [{ type: 'thinking', text: 'r' }],
                    tool_calls: [{ id: 't' + i, type: 'function', function: { name: 'x', arguments: 'G'.repeat(5000) } }] });
                break;
            case 6: // user-paused: pause flags rehydrated
                row.pausedByUser = true;
                break;
            default: // 7: no messages field at all: filtered out
                delete row.messages;
        }
        return row;
    }
    function makeRows(n) { var out = []; for (var i = 0; i < n; i++) out.push(makeRow(i)); return out; }
    function loadedIds(rows) {
        return rows.filter(function(r) { return r.messages && r.messages.length > 0; }).map(function(r) { return r.id; });
    }
    function idx(id) { return parseInt(id.slice(1), 10); }
    // Pre-boot adopts already in the chats map when the load starts.
    function adopted() {
        return {
            c005: { id: 'c005', title: 'adopted', updatedAt: 5, messages: [{ role: 'user', content: 'fresh turn' }] }, // collides: kept, disk meta overlaid
            c013: { id: 'c013', _deleted: true }, // parked tombstone on a loaded row: kept untouched
            c004: { id: 'c004', messages: [{ role: 'user', content: 'x' }] }, // its disk row is filtered (empty history)
            xonly: { id: 'xonly', messages: [{ role: 'user', content: 'adopt only' }] }
        };
    }
    function pendingMeta() {
        return { c003: { starred: true, updatedAt: 99999 }, c030: { pinned: true }, c013: { starred: true }, gone: { starred: true } };
    }
    function norm(s) { return String(s).replace(/ in \d+ms/, ' in <t>ms'); }
    function snapshot(env) {
        return {
            keys: Object.keys(env.chats),
            chats: clone(env.chats),
            queue: clone(env.api.queue()),
            hydrated: env.api.hydrated(),
            paused: Object.keys(env.pausedChats).sort(),
            pausedIds: Object.keys(env.pausedChatIds).sort(),
            overlays: clone(env.overlayCalls),
            applies: env.applyCalls.slice(),
            rebuilds: env.rebuilds,
            stripIds: env.stripCalls.map(function(c) { return c.id; }),
            logs: env.logs.map(norm),
            errors: env.errors.map(norm)
        };
    }
    var FAIL_FIELDS = ['keys', 'chats', 'queue', 'hydrated', 'paused', 'pausedIds', 'overlays', 'applies', 'rebuilds', 'logs', 'errors'];

    test('reads: ONE key-only pass, then gap-free getAll(range) batches, each its own readonly withStore; never a range-less getAll', async function() {
        var s = await sources();
        var at = s.src.indexOf('async function _swLoadChatsFromStorageBatched(');
        assert.ok(at >= 0, 'batched loader present');
        var code = s.src.slice(at, s.src.indexOf('\n}\n', at)).replace(/\/\/[^\n]*/g, '');
        assert.ok(!/\.getAll\(\s*\)/.test(code), 'no range-less getAll() in the batched loader');
        assert.match(s.oldLoader, /store\.getAll\(\)/, 'oracle is the pre-F2 single range-less getAll loader');
        var rows = makeRows(57), keys = rows.map(function(r) { return r.id; });
        var env = await makeEnv({ rows: rows });
        assert.strictEqual(env.api.batchSize, 25);
        assert.strictEqual(await env.api.load(), undefined);
        assert.deepStrictEqual(env.ops.map(function(o) { return o.op; }), ['getAllKeys', 'getAll', 'getAll', 'getAll']);
        var ranges = env.ops.slice(1).map(function(o) {
            assert.ok(o.argc === 1 && o.range, 'every getAll carries a key range');
            return [o.range.kind, o.range.lower, o.range.upper, o.range.lowerOpen, o.range.upperOpen];
        });
        // [k0,k25) [k25,k50) [k50,+inf): contiguous, tiles [k0,+inf) with no holes
        assert.deepStrictEqual(ranges, [
            ['bound', keys[0], keys[25], false, true],
            ['bound', keys[25], keys[50], false, true],
            ['lowerBound', keys[50], undefined, false, false]
        ]);
        assert.strictEqual(env.txs.length, 4, 'one transaction per read');
        env.txs.forEach(function(t, i) {
            assert.deepStrictEqual(t.storeNames, [STORE]);
            assert.strictEqual(t.mode, 'readonly');
            assert.strictEqual(t.outcome, 'resolved');
            assert.strictEqual(env.ops[i].tx, i, 'one request per transaction');
        });
        assert.strictEqual(env.api.hydrated(), true);
        assert.deepStrictEqual(Object.keys(env.chats), loadedIds(rows));
    }, { tags: ['unit'], timeout: 10000 });

    test('end state == the pre-F2 single-getAll loader over static stores (0/1/24/25/26/50/57 rows, adopts, boot-window meta)', async function() {
        var sizes = [0, 1, 24, 25, 26, 50, 57];
        for (var si = 0; si < sizes.length; si++) {
            var n = sizes[si];
            var cfg = { rows: makeRows(n), chats: adopted(), pending: pendingMeta() };
            var oldEnv = await makeEnv(Object.assign({ oracle: true }, cfg));
            var newEnv = await makeEnv(cfg);
            assert.strictEqual(await oldEnv.api.load(), undefined);
            assert.strictEqual(await newEnv.api.load(), undefined);
            assert.deepStrictEqual(oldEnv.ops.map(function(o) { return o.op + ':' + o.argc; }), ['getAll:0'], 'oracle ran the old single range-less getAll');
            assert.strictEqual(newEnv.ops.filter(function(o) { return o.op === 'getAll'; }).length, Math.ceil(n / 25), 'n=' + n + ': ceil(n/25) batch reads');
            if (n === 0) assert.deepStrictEqual(newEnv.ops.map(function(o) { return o.op; }), ['getAllKeys'], '0 keys: no row read at all');
            assert.deepStrictEqual(snapshot(newEnv), snapshot(oldEnv), 'n=' + n + ': batched end state == old end state');
        }
    }, { tags: ['unit'], timeout: 20000 });

    test('strip semantics unchanged: ONE-arg strip (no body eviction), every loaded record _payloadsEvicted, legacy rows queued in key order', async function() {
        var rows = makeRows(57);
        var env = await makeEnv({ rows: rows });
        await env.api.load();
        var loaded = loadedIds(rows);
        assert.deepStrictEqual(Object.keys(env.chats), loaded, 'rows without messages are not loaded; key order kept');
        assert.ok(!env.chats.c004 && !env.chats.c007, 'empty / missing history filtered');
        assert.deepStrictEqual(env.stripCalls.map(function(c) { return c.id; }), loaded, 'strip exactly once per loaded row');
        env.stripCalls.forEach(function(c) { assert.strictEqual(c.argc, 1, 'strip called with ONE arg (no evictBodies) for ' + c.id); });
        loaded.forEach(function(id) { assert.strictEqual(env.chats[id]._payloadsEvicted, true, id + ' marked _payloadsEvicted'); });
        var queued = loaded.filter(function(id) { return idx(id) % 8 <= 2; });
        assert.deepStrictEqual(env.api.queue(), queued, 'records that held inline payloads queued for migration, key order');
        var m0 = env.chats.c000.messages[1];
        assert.strictEqual(m0.base64, undefined); assert.strictEqual(m0._b64Evicted, true);
        var s1 = env.chats.c001.screenshots.s1;
        assert.strictEqual(s1.base64, undefined); assert.strictEqual(s1._b64Evicted, true);
        var t2 = env.chats.c002.cachedToolResults.ctr;
        assert.strictEqual(t2.fullContent, undefined); assert.strictEqual(t2._fcEvicted, true);
        assert.strictEqual(env.chats.c003.messages[1].base64.length, 50, 'no pointer: base64 kept');
        var b5 = env.chats.c005.messages;
        assert.strictEqual(b5[1].content.length, 5000);
        assert.strictEqual(b5[2].thinking.length, 5000);
        assert.strictEqual(b5[2].tool_calls[0].function.arguments.length, 5000);
        assert.strictEqual(b5[2].reasoning_details.length, 1);
        assert.ok(JSON.stringify(env.chats).indexOf('_bodyEvicted') < 0, 'no body eviction in the SW');
        var paused = loaded.filter(function(id) { return idx(id) % 8 === 6; });
        assert.deepStrictEqual(Object.keys(env.pausedChats).sort(), paused);
        assert.deepStrictEqual(Object.keys(env.pausedChatIds).sort(), paused);
        assert.strictEqual(env.rebuilds, 1);
        assert.deepStrictEqual(env.logs, [], 'no debug console output');
        var st = env.api.loadStats();
        assert.ok(st, 'STORE-ACCT stats recorded at the commit');
        assert.strictEqual(st.chats, loaded.length);
        assert.ok(typeof st.ms === 'number' && st.ms >= 0);
        assert.strictEqual(st.queued, queued.length);
        assert.strictEqual(st.largestId, 'c056');
        assert.ok(st.inlineB64Chars >= st.largestB64Chars && st.largestB64Chars > 0);
    }, { tags: ['unit'], timeout: 10000 });

    test('rows written AFTER the key pass beyond the last key, or between two batch bounds, are still loaded (gap-free ranges)', async function() {
        var late = { id: 'c999', updatedAt: 1, messages: [{ role: 'user', content: 'late', file_id: 'f999', base64: 'Z'.repeat(10) }] };
        var gap = { id: 'c024z', updatedAt: 1, messages: [{ role: 'user', content: 'between batch bounds' }] };
        var fired = 0;
        var rows = makeRows(30);
        var env = await makeEnv({ rows: rows, afterOp: function(op, e) {
            if (op.op === 'getAllKeys' && !fired++) { e.db.set(late.id, clone(late)); e.db.set(gap.id, clone(gap)); }
        } });
        await env.api.load();
        assert.strictEqual(fired, 1);
        var rg = env.ops.slice(1).map(function(o) { return [o.range.kind, o.range.lower, o.range.upper]; });
        assert.deepStrictEqual(rg, [['bound', 'c000', 'c025'], ['lowerBound', 'c025', undefined]], 'batches planned from the 30 pre-write keys');
        assert.ok(env.chats.c999, 'row past the last planned key loaded by the open-ended last batch');
        assert.ok(env.chats.c024z, 'row between two planned keys loaded (half-open contiguous batches)');
        assert.strictEqual(env.chats.c999._payloadsEvicted, true);
        assert.strictEqual(env.chats.c999.messages[0].base64, undefined, 'late row stripped like any other');
        assert.ok(env.api.queue().indexOf('c999') >= 0, 'late legacy row queued for migration');
        assert.deepStrictEqual(Object.keys(env.chats), loadedIds(rows.concat([gap, late]).sort(byId)));
        assert.strictEqual(env.api.hydrated(), true);
    }, { tags: ['unit'], timeout: 10000 });

    test('a failed read (key pass, or any batch after earlier batches succeeded) merges NOTHING, like the old failed getAll', async function() {
        var cfg = { rows: makeRows(57), chats: adopted(), pending: pendingMeta() };
        var oldEnv = await makeEnv(Object.assign({ oracle: true, failOp: function() { return idbError('UnknownError', 'disk boom'); } }, cfg));
        oldEnv.api.setQueue(['sentinel']);
        assert.strictEqual(await oldEnv.api.load(), undefined);
        var oldSnap = snapshot(oldEnv);
        assert.strictEqual(oldSnap.hydrated, false, 'oracle failed as expected');
        async function failCase(failAt) {
            var env = await makeEnv(Object.assign({ failOp: function(op) {
                return op.index === failAt ? idbError('UnknownError', 'disk boom') : null;
            } }, cfg));
            var sentinel = ['sentinel'];
            env.api.setQueue(sentinel);
            assert.strictEqual(await env.api.load(), undefined, 'the loader never rejects (_chatsLoadP contract)');
            var tag = 'failAt=' + failAt + ': ';
            assert.strictEqual(env.ops.length, failAt + 1, tag + 'no read after the failed one');
            assert.strictEqual(env.txs[failAt].outcome, 'rejected', tag + 'the request error REJECTS (no resolve-empty)');
            assert.strictEqual(env.txs[failAt].attempts, 1, tag + 'not a connection error: no retry');
            assert.strictEqual(env.api.queue(), sentinel, tag + 'migration queue untouched');
            assert.deepStrictEqual(env.chats, adopted(), tag + 'chats map untouched: no disk row merged, no overlay');
            assert.strictEqual(env.api.hydrated(), false, tag + 'wipe-guard: _chatsHydrated stays false');
            assert.strictEqual(env.errors.length, 1);
            assert.match(env.errors[0], /open failed \(post-retry\)/);
            if (failAt >= 2) assert.ok(env.stripCalls.length > 0, tag + 'earlier batches were processed, yet nothing merged');
            var snap = snapshot(env);
            FAIL_FIELDS.forEach(function(k) { assert.deepStrictEqual(snap[k], oldSnap[k], tag + k + ' == old failed getAll'); });
        }
        for (var failAt = 0; failAt <= 3; failAt++) await failCase(failAt);
    }, { tags: ['unit'], timeout: 20000 });

    test('a withStore connection retry (InvalidStateError) re-runs the read without double-processing any row', async function() {
        var cfg = { rows: makeRows(57), chats: adopted(), pending: pendingMeta() };
        var oldEnv = await makeEnv(Object.assign({ oracle: true }, cfg));
        await oldEnv.api.load();
        var oldSnap = snapshot(oldEnv);
        async function retryCase(failAt) {
            var failed = false;
            var env = await makeEnv(Object.assign({ failOp: function(op) {
                if (op.index === failAt && !failed) { failed = true; return idbError('InvalidStateError', 'connection is closing'); }
                return null;
            } }, cfg));
            await env.api.load();
            var tag = 'failAt=' + failAt + ': ';
            assert.ok(failed, tag + 'failure injected');
            assert.strictEqual(env.txs.length, 4, tag + 'the retry stays inside the same withStore call');
            assert.strictEqual(env.txs[failAt].attempts, 2, tag + 'withStore retried that read once');
            assert.strictEqual(env.ops.length, 5, tag + 'the failed read was re-issued once');
            var ids = env.stripCalls.map(function(c) { return c.id; });
            assert.strictEqual(new Set(ids).size, ids.length, tag + 'every row stripped exactly once');
            assert.deepStrictEqual(snapshot(env), oldSnap, tag + 'end state == old path on the same static store');
        }
        await retryCase(0); // the key pass
        await retryCase(2); // a middle batch
    }, { tags: ['unit'], timeout: 20000 });

    test('adopts landing BETWEEN batch reads win at the single post-loop commit (FLUX-H2); nothing is merged before it', async function() {
        var a3 = { id: 'c003', title: 'adopted mid-load', updatedAt: 1, messages: [{ role: 'user', content: 'typed during boot' }] };
        var a40 = { id: 'c040', title: 'adopted mid-load', updatedAt: 1, messages: [{ role: 'user', content: 'typed during boot' }] };
        var seen = [];
        var env = await makeEnv({ rows: makeRows(57), afterOp: function(op, e) {
            // op 1 = batch [c000,c025) was just read (holds c003); c040 sits in the next batch
            if (op.index === 1) { e.chats.c003 = a3; e.chats.c040 = a40; }
            seen.push({ keys: Object.keys(e.chats).join(','), hydrated: e.api.hydrated() });
        } });
        await env.api.load();
        assert.deepStrictEqual(seen.map(function(x) { return x.keys; }), ['', 'c003,c040', 'c003,c040', 'c003,c040'], 'no disk row enters the map before the commit');
        assert.ok(seen.every(function(x) { return x.hydrated === false; }), 'not hydrated before the commit');
        assert.strictEqual(env.chats.c003, a3, 'adopted record kept (identity)');
        assert.strictEqual(env.chats.c040, a40, 'adopted record kept (identity)');
        assert.deepStrictEqual(env.overlayCalls, [
            { disk: 'c003', kept: 'c003', diskStripped: true },
            { disk: 'c040', kept: 'c040', diskStripped: true }
        ], 'disk copies (stripped) overlaid as prev onto the adopted records');
        assert.strictEqual(a3.updatedAt, 1003, 'disk meta pulled forward');
        assert.strictEqual(env.api.hydrated(), true);
    }, { tags: ['unit'], timeout: 10000 });

    test('single-flight: concurrent callers share ONE load; the slot clears when it settles (failure or success)', async function() {
        var failKeys = true;
        var env = await makeEnv({ rows: makeRows(30), failOp: function(op) {
            return (failKeys && op.op === 'getAllKeys') ? idbError('UnknownError', 'keys boom') : null;
        } });
        var f1 = env.api.load(), f2 = env.api.load();
        assert.ok(env.api.inFlight(), 'slot held while the load runs');
        assert.strictEqual(await f1, undefined);
        assert.strictEqual(await f2, undefined);
        assert.strictEqual(env.ops.length, 1, 'both callers shared ONE key pass');
        assert.strictEqual(env.errors.length, 1, 'one failure logged');
        assert.strictEqual(env.api.inFlight(), null, 'slot cleared after a failed load');
        assert.strictEqual(env.api.hydrated(), false);
        // Recovery: the next call starts a FRESH load; a caller arriving mid-load joins it.
        failKeys = false;
        var joined = null, slotAtJoin = null, joinedSawHydrated = null;
        env.afterOp = function(op, e) {
            if (op.op === 'getAllKeys' && !joined) {
                slotAtJoin = e.api.inFlight();
                joined = e.api.load();
                joined.then(function() { joinedSawHydrated = e.api.hydrated(); });
            }
        };
        await env.api.load();
        assert.ok(joined, 'second caller arrived mid-load');
        assert.ok(slotAtJoin, 'it found the in-flight slot');
        assert.strictEqual(await joined, undefined);
        assert.strictEqual(joinedSawHydrated, true, 'the joined caller resolved only after the shared commit');
        assert.strictEqual(env.ops.filter(function(o) { return o.op === 'getAllKeys'; }).length, 2, 'one key pass per load, none for the joined caller');
        assert.strictEqual(env.ops.filter(function(o) { return o.op === 'getAll'; }).length, 2, '30 rows = 2 batches, read once');
        var ids = env.stripCalls.map(function(c) { return c.id; });
        assert.strictEqual(new Set(ids).size, ids.length, 'every row processed once');
        assert.strictEqual(env.rebuilds, 1, 'ONE commit');
        assert.strictEqual(env.api.inFlight(), null);
        assert.strictEqual(env.api.hydrated(), true);
    }, { tags: ['unit'], timeout: 10000 });

    // DELETE-RACE (F2 review finding): the delete lane (scheduleChatRowDelete ->
    // _finish(true)) drops the parked tombstone once the row is verified gone. A
    // row an earlier batch already read must NOT be re-inserted by the single
    // commit after that: the FLUX-H2 tombstone guard is gone by then.
    function userDelete(e, id, onFinished) {
        // worker/130-port-bridge.js update-chat tombstone branch: park, then arm the lane.
        var tomb = { id: id, messages: [], _deleted: true };
        e.chats[id] = tomb;
        return e.api.scheduleDelete(id, tomb).then(function(ok) {
            // Runs one tick after _finish. The commit (and a failure) closes the set,
            // so an OPEN set holding the id proves _finish ran while the load was in flight.
            var set = e.api.loadDeletedIds();
            onFinished({ ok: ok, recorded: !!(set && set[id] === true), hydrated: e.api.hydrated() });
        });
    }

    test('DELETE-RACE: a delete verified mid-load (between two batch reads, or after the last read) is never resurrected by the commit', async function() {
        var rows = makeRows(57);
        var atFinish = {}, probes = [], lanes = [];
        function kick(e, id) { lanes.push(userDelete(e, id, function(r) { atFinish[id] = r; })); }
        var env = await makeEnv({ rows: rows, afterOp: function(op, e) {
            // op 1 = batch [c000,c025) just read (holds c003): its delete lands during ops 2-3
            if (op.index === 1) kick(e, 'c003');
            // op 3 = the LAST batch [c050,+inf) just read (holds c051): its delete lands before the commit
            if (op.index === 3) kick(e, 'c051');
            probes.push([op.index, 'c003' in e.chats, 'c051' in e.chats, e.api.hydrated()]);
        } });
        await env.api.load();
        await Promise.all(lanes);
        assert.deepStrictEqual(probes, [
            [0, false, false, false],
            [1, true, false, false],
            [2, false, false, false],
            [3, false, true, false]
        ], 'c003 tombstone parked at op 1 and already dropped (verified gone) by op 2; c051 parked after the last read');
        var raced = { ok: true, recorded: true, hydrated: false };
        assert.deepStrictEqual(atFinish.c003, raced, 'c003 verified gone between two batch reads, before the commit');
        assert.deepStrictEqual(atFinish.c051, raced, 'c051 verified gone between the last batch read and the commit');
        var stripIds = env.stripCalls.map(function(c) { return c.id; });
        assert.ok(stripIds.indexOf('c003') >= 0 && stripIds.indexOf('c051') >= 0, 'both stale rows WERE read and queued locally by their batches');
        assert.strictEqual(env.api.hydrated(), true);
        assert.strictEqual(env.rebuilds, 1, 'ONE commit');
        assert.ok(!('c003' in env.chats), 'c003 NOT resurrected by the commit');
        assert.ok(!('c051' in env.chats), 'c051 NOT resurrected by the commit');
        assert.ok(!env.db.has('c003') && !env.db.has('c051'), 'both rows gone from disk');
        assert.deepStrictEqual(env.deleteCalls, ['c003', 'c051']);
        assert.deepStrictEqual(Object.keys(env.api.pendingDeletes()), [], 'delete ledger drained');
        assert.strictEqual(env.api.loadDeletedIds(), null, 'set closed at the commit');
        assert.deepStrictEqual(env.overlayCalls, [], 'no disk meta overlaid for the deleted ids');
        assert.deepStrictEqual(Object.keys(env.chats), loadedIds(rows).filter(function(id) { return id !== 'c003' && id !== 'c051'; }), 'every other row loaded, in key order');
    }, { tags: ['unit'], timeout: 10000 });

    test('DELETE-RACE: a delete verified AFTER the commit behaves as before (tombstone dropped, live record kept) and records nothing', async function() {
        var rows = makeRows(57);
        var env = await makeEnv({ rows: rows });
        await env.api.load();
        assert.strictEqual(env.api.hydrated(), true);
        assert.strictEqual(env.api.loadDeletedIds(), null, 'no load in flight: set closed');
        var atFinish = null;
        await userDelete(env, 'c005', function(r) { atFinish = r; });
        assert.deepStrictEqual(atFinish, { ok: true, recorded: false, hydrated: true }, 'post-commit delete records nothing');
        assert.ok(!('c005' in env.chats), 'verified-gone tombstone dropped');
        assert.ok(!env.db.has('c005'), 'row deleted');
        // A LIVE record holding the id (re-adopted while the delete ran) is never dropped.
        var live = env.chats.c006;
        assert.ok(live && !live._deleted, 'c006 loaded live');
        assert.strictEqual(await env.api.scheduleDelete('c006', clone(live)), true);
        assert.strictEqual(env.chats.c006, live, 'live record kept (identity)');
        assert.ok(!env.db.has('c006'));
        assert.deepStrictEqual(env.deleteCalls, ['c005', 'c006']);
        assert.deepStrictEqual(Object.keys(env.api.pendingDeletes()), [], 'delete ledger drained');
        assert.strictEqual(env.api.loadDeletedIds(), null, 'still nothing recorded');
        assert.deepStrictEqual(Object.keys(env.chats), loadedIds(rows).filter(function(id) { return id !== 'c005'; }), 'every other chat intact');
    }, { tags: ['unit'], timeout: 10000 });

    test('DELETE-RACE: a failed load closes the set too; the next load opens a fresh one', async function() {
        var rows = makeRows(57), lane = null, atFinish = null, failBatch2 = true;
        var env = await makeEnv({ rows: rows,
            failOp: function(op) { return (failBatch2 && op.index === 2) ? idbError('UnknownError', 'disk boom') : null; },
            afterOp: function(op, e) {
                if (op.index === 1 && !lane) lane = userDelete(e, 'c003', function(r) { atFinish = r; });
            } });
        await env.api.load();
        await lane;
        assert.deepStrictEqual(atFinish, { ok: true, recorded: true, hydrated: false }, 'recorded while the load was in flight');
        assert.strictEqual(env.api.hydrated(), false, 'batch 2 failed: nothing merged');
        assert.strictEqual(env.errors.length, 1);
        assert.strictEqual(env.api.loadDeletedIds(), null, 'set closed on failure');
        assert.deepStrictEqual(Object.keys(env.chats), [], 'tombstone dropped, no disk row merged');
        failBatch2 = false;
        await env.api.load();
        assert.strictEqual(env.api.hydrated(), true);
        assert.strictEqual(env.api.loadDeletedIds(), null, 'set closed at the recovery commit');
        assert.deepStrictEqual(Object.keys(env.chats), loadedIds(rows).filter(function(id) { return id !== 'c003'; }));
    }, { tags: ['unit'], timeout: 10000 });
});

// FROZEN ORACLE (do not edit): the PRE-F2 loadChatsFromStorage, verbatim from
// src/js/worker/115-storage.js before F2 (ONE range-less store.getAll() over
// the whole chats store, all processing inside onsuccess). Recovered from the
// F2 diff. Never called here: only its source text is used, appended after
// the real source so this later declaration overrides the batched loader.
function preF2LoaderHolder() {
async function loadChatsFromStorage() {
    try {
        // withStore (core/130-indexeddb.js, shared into this bundle): retries
        // ONCE on a fresh connection if the cached one was force-closed.
        var _loadT0 = Date.now();
        return await withStore([chatStoreName], 'readonly', function(transaction) {
        var store = transaction.objectStore(chatStoreName);
        var request = store.getAll();
        return new Promise(function(resolve, reject) {
            request.onsuccess = function() {
                var results = request.result || [];
                // FLUX-H2 (boot-adopt preservation): do NOT wholesale-replace
                // `chats`. This loader runs once per SW life (worker/190-entry.js)
                // and `chats` starts {}, so any entry present here is a panel
                // snapshot adopted while this getAll was in flight (the pre-gate
                // run-agent adopt, the ungated update-chat put, or a parked
                // tombstone — worker/130-port-bridge.js). The old `chats = {}`
                // replace dropped those adopts, losing the freshly-typed user
                // turn the snapshot carried. Disk rows fill in around them below;
                // on id collision the adopted record wins and disk-only meta is
                // pulled forward via _swOverlayChatMeta (same prev=SW-copy
                // semantics as a post-boot adopt overlay).
                _legacyPayloadMigrationQueue = [];
                // STORE-ACCT: one line per boot sizing the store — record count,
                // read duration, and how much inline base64 is still riding in
                // records (the legacy tail the trickle migrator is burning down).
                // This is the number that decides whether slowness is data-size
                // or transaction-queue congestion.
                var _acctB64 = 0, _acctTopB64 = 0, _acctTopId = null;
                results.forEach(function(chat) {
                    if (chat.messages && chat.messages.length > 0) {
                        // MEMFIX: the SW strips inline base64 payloads from EVERY
                        // chat at load (K=0 — the SW has no UI; run entry points
                        // rehydrate via ensureChatPayloads in core/130-indexeddb.js
                        // before a chat is run/persisted). Evicted chats stay in
                        // `chats` (they are live chats; saves are upsert-only) and are skipped by the
                        // put-loop in saveChatsToStorage above (put safety).
                        // LEGACY-MIGRATE: strip returning true means the RECORD
                        // itself still held inline base64 — a legacy-inline row
                        // (pre-v16 or an imported backup). Queue it for the
                        // heartbeat trickle migrator below so the store converges
                        // to the v16 shape instead of re-materializing these
                        // payloads in this getAll on every SW boot.
                        if (typeof stripChatPayloadsInPlace === 'function') {
                            try {
                                var _cb64 = 0;
                                for (var _ai = 0; _ai < chat.messages.length; _ai++) {
                                    var _am = chat.messages[_ai];
                                    if (_am && _am.base64) _cb64 += _am.base64.length;
                                }
                                if (chat.screenshots) {
                                    for (var _ak in chat.screenshots) {
                                        var _as = chat.screenshots[_ak];
                                        if (_as && _as.base64) _cb64 += _as.base64.length;
                                    }
                                }
                                if (_cb64) {
                                    _acctB64 += _cb64;
                                    if (_cb64 > _acctTopB64) { _acctTopB64 = _cb64; _acctTopId = chat.id; }
                                }
                                if (stripChatPayloadsInPlace(chat)) _legacyPayloadMigrationQueue.push(chat.id);
                                // WRITE-AMP root fix: strip only sets
                                // _payloadsEvicted when it stripped base64, so a
                                // pure-TEXT chat (most of the store) never got the
                                // flag and the save put-loop re-wrote its UNCHANGED
                                // record on EVERY save — with hundreds of chats,
                                // tens of MB per tool boundary, the engine of the
                                // chronic [chats, chat_payloads] congestion. At
                                // load the in-memory copy is identical to the disk
                                // record by definition, so mark EVERY chat evicted
                                // ("nothing new to persist"). Every mutation path
                                // (run gate, send, wake drain, resume, migration)
                                // already calls ensureChatPayloads first, which
                                // clears the flag (single cheap get for text-only
                                // chats) and re-admits the chat to the put set.
                                chat._payloadsEvicted = true;
                            } catch (e) {}
                        }
                        var _rowId = chat.id;
                        var _adoptedPreBoot = chats[_rowId];
                        if (_adoptedPreBoot) {
                            // FLUX-H2: keep the fresher adopted record and replay
                            // the post-boot adopt ordering — overlay the DISK
                            // copy as `prev` (timestamps max-wins, disk DEFINED
                            // flags win; boot-window dispatches are re-asserted
                            // by the pending fold below, keeping last-dispatch-
                            // wins intact). A parked tombstone is kept untouched:
                            // the delete lane owns it and its meta must never be
                            // resurrected from the doomed disk row.
                            if (!_adoptedPreBoot._deleted && typeof _swOverlayChatMeta === 'function') {
                                try { _swOverlayChatMeta(chat, _adoptedPreBoot); } catch (eOv) { /* best-effort — adopt stays */ }
                            }
                            chat = _adoptedPreBoot;
                        }
                        chats[_rowId] = chat;
                    }
                });
                // FLUX-H3 (boot-window lane fold): fold chat-meta dispatches
                // buffered in _swChatMetaPendingByChatId into the hydrated
                // records, with the lane's own merge (_swApplyChatMetaFields:
                // ts max-wins, flags last-wins). getAll is a SNAPSHOT — a
                // 'chat-meta-update' landing mid-window RMWed the STORED row
                // (durable) and buffered its fields, but the rows read above
                // can predate that RMW; without this fold the stale disk value
                // wins in memory, a later adopt's `chats[id] || pending` prefers
                // the stale held record and deletes the pending entry unfolded,
                // and the next save writes the stale flag back over the RMWed
                // row (_preservePageChatFields lets a DEFINED record flag beat
                // disk). Entries are NOT deleted here: adopt sites still
                // consume them for never-held chats, and the serialized RMW
                // chain reads the map at execution time — re-folding is
                // idempotent (same values, max-wins/last-wins).
                try {
                    if (typeof _swChatMetaPendingByChatId === 'object' && _swChatMetaPendingByChatId
                        && typeof _swApplyChatMetaFields === 'function') {
                        Object.keys(_swChatMetaPendingByChatId).forEach(function(_pmCid) {
                            if (chats[_pmCid] && !chats[_pmCid]._deleted) {
                                _swApplyChatMetaFields(chats[_pmCid], _swChatMetaPendingByChatId[_pmCid]);
                            }
                        });
                    }
                } catch (eFold) { /* fold is best-effort — the RMW already persisted the fields */ }
                // Rehydrate per-chat pause flags from the persisted record field
                // (chat.pausedByUser — see setChatPausedPersistent in
                // core/030-config.js) so a user-paused chat stays paused across an
                // SW restart: the loop's `while (!isChatPaused)` gate reads THIS
                // realm's pausedChats copy. Cleared on resume/toggle-pause(false),
                // on run-agent for an idle chat, and on a fresh user send.
                try {
                    if (typeof pausedChats !== 'undefined') {
                        Object.keys(chats).forEach(function(_pcid) {
                            if (chats[_pcid] && chats[_pcid].pausedByUser === true) {
                                pausedChats[_pcid] = true;
                                // FLUX-P1: pausedChatIds is a derived cache of the
                                // lane's pausedByUser flag — fold it here too so the
                                // worker/020-page-stubs.js isChatPaused fallback
                                // agrees after an SW restart.
                                if (typeof pausedChatIds !== 'undefined') pausedChatIds[_pcid] = true;
                            }
                        });
                    }
                } catch (e) { /* rehydration is best-effort */ }
                if (typeof rebuildFileIndexAll === 'function') {
                    // WS-T1: surface a boot file-index rebuild failure instead of
                    // swallowing it — a silent failure here leaves file_id lookups
                    // (attachments, screenshots) broken with no diagnostic.
                    try { rebuildFileIndexAll(); } catch (e) { console.error('[worker-storage] rebuildFileIndexAll failed', e); }
                }
                _chatsHydrated = true;
                // (boot log line dropped with the product's; parity compares logs = [])
                resolve();
            };
            request.onerror = function() {
                // SLEEP-WEDGE: REJECT (do not resolve-empty) so withStore's
                // connection-error retry engages on a fresh connection. The
                // outer catch below logs only after the retry has also failed.
                reject(request.error || new Error('chats getAll failed'));
            };
        });
        }); // end withStore fn
    } catch (e) {
        // Post-retry failure — no DOM in this realm, so log loudly; the page
        // realm surfaces its own user-visible notice, and the wipe-guard
        // (_chatsHydrated stays false) keeps saves blocked so nothing is lost.
        console.error('[worker-storage] open failed (post-retry) — chat storage unavailable in the worker realm', e);
    }
}
}
function preF2LoaderSource() {
    var s = preF2LoaderHolder.toString();
    var body = s.slice(s.indexOf('{') + 1, s.lastIndexOf('}'));
    if (body.indexOf('async function loadChatsFromStorage()') < 0) throw new Error('frozen pre-F2 loader missing from preF2LoaderHolder');
    return body;
}
