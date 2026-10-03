// BOOT-OOM (F1): the page chat loader (ui/070-dashboard-ui.js
// _loadChatsFromStorageImpl) strips every record's heavy payloads PER BATCH,
// right after the STORE-ACCT base64 tally, instead of holding every record's
// bodies until the post-swap pass. The newest CHAT_KEEP_HYDRATED non-retired
// chats are re-hydrated after the swap by _hydrateRecent.
// These tests evaluate the REAL loader (its 4 functions cut out of the
// workspace source by brace matching) over the REAL core/130 strip
// (stripChatPayloadsInPlace / chatPayloadRecencyTs / CHAT_KEEP_HYDRATED via
// loadModules). Only IDB (an in-memory withStore serving key-range batches),
// ensureChatPayloads (restores the stored record in place), boot crumbs and
// UI effects are faked. No timers: every fake settles on microtasks.
// fix-f1: the CURRENT chat leads the keep set (restored + repainted first),
// and one test swaps the adoptChatRow stub for the REAL 045 guard + merges.
describe('chat boot load: per-batch payload strip (F1)', function() {
    var LOADER = 'src/js/ui/070-dashboard-ui.js';
    var FNS = ['loadChatsFromStorage', '_loadChatsFromStorageImpl', '_bootStripLoadedChat', '_chatsLoadCrumb'];
    var ADOPT_SRC = 'src/js/app/045-agent-port-bridge-page.js';
    var ADOPT_FNS = ['adoptChatRow', '_chatRowStaler', '_mergePagePendingRows', '_mergePageChatMeta',
        '_mergePageHeavyPayloads', '_graftHeavyMap'];

    // realDecl pattern (test/permissions-reset-confirm.test.js), over one read.
    function cutDecl(src, name, file) {
        file = file || LOADER;
        var m = new RegExp('\\n(?:async )?function ' + name + '\\(').exec(src);
        assert.ok(m, name + ' found in ' + file);
        var a = m.index + 1;
        var b = src.indexOf('\n}\n', a);
        assert.ok(b > a, name + ' end found in ' + file);
        return src.slice(a, b + 2);
    }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function big(ch, n) { return new Array(n + 1).join(ch); }
    async function ticks(n) { for (var i = 0; i < n; i++) await Promise.resolve(); }

    var _m130 = null;
    async function core130() {
        if (!_m130) {
            _m130 = await loadModules(['src/js/core/130-indexeddb.js'], { globals: {
                STORAGE_PREFIX: 'test_',
                indexedDB: { open: function() { throw new Error('no IDB in chat-boot-load tests'); } },
                console: { log: function() {}, info: function() {}, warn: function() {}, error: function() {} }
            } });
        }
        return _m130;
    }

    // A legacy-inline record carrying every payload kind the strip evicts.
    function heavyRecord(id, ts, extra) {
        var r = { id: id, title: id, createdAt: ts - 5, updatedAt: ts, messages: [
            { role: 'user', content: 'hello ' + id },
            { role: 'assistant', content: 'ok', thinking: big('t', 600),
                tool_calls: [{ id: 'tc_' + id, type: 'function', function: { name: 'web_fetch', arguments: big('a', 700) } }],
                reasoning_details: [{ type: 'reasoning.text', text: 'why' }] },
            { role: 'tool', tool_call_id: 'tc_' + id, content: big('x', 900) },
            { role: 'user', content: 'see image', file_id: 'f_' + id, base64: 'data:image/png;base64,' + big('B', 800) }
        ], screenshots: {}, cachedToolResults: {} };
        r.screenshots['ss_' + id] = { base64: big('S', 400), name: 'shot' };
        r.cachedToolResults['ctr_' + id] = { fullContent: big('C', 1000), summary: 'sum' };
        return Object.assign(r, extra || {});
    }
    // n chats (n coprime with 7). Key order differs from recency order:
    // rank = (i*7) % n, rank 0 = newest. rankIds[rank] = id.
    function fixture(n, opts) {
        opts = opts || {};
        var records = [], rankIds = [];
        for (var i = 0; i < n; i++) {
            var id = 'c_' + String(i).padStart(4, '0');
            var rank = (i * 7) % n;
            var ts = 1700000000000 - rank * 1000;
            records.push(opts.tiny
                ? { id: id, createdAt: ts, updatedAt: ts, messages: [{ role: 'user', content: 'hi' }] }
                : heavyRecord(id, ts, opts.extra && opts.extra[rank]));
            rankIds[rank] = id;
        }
        if (!opts.tiny) {
            // Key-sorted AFTER every c_ id, so both land in the last batch.
            records.push({ id: 'e_empty', createdAt: 2, updatedAt: 2, messages: [] });
            records.push({ id: 's_small', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'short' }] });
        }
        return { records: records, rankIds: rankIds };
    }

    // Heavy fields the boot strip must have removed (mirrors core/130).
    function heavyFields(chat, minChars) {
        var out = [];
        (chat.messages || []).forEach(function(m, i) {
            if (!m) return;
            if ((m.file_id || m.screenshot_id) && m.base64) out.push(i + '.base64');
            if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > minChars) out.push(i + '.content');
            if (typeof m.thinking === 'string' && m.thinking.length > minChars) out.push(i + '.thinking');
            (Array.isArray(m.tool_calls) ? m.tool_calls : []).forEach(function(tc, j) {
                if (tc && tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments.length > minChars) out.push(i + '.tool_calls.' + j);
            });
            if (Array.isArray(m.reasoning_details) && m.reasoning_details.length) out.push(i + '.reasoning_details');
        });
        Object.keys(chat.screenshots || {}).forEach(function(k) { if (chat.screenshots[k] && chat.screenshots[k].base64) out.push('screenshots.' + k); });
        Object.keys(chat.cachedToolResults || {}).forEach(function(k) { if (chat.cachedToolResults[k] && chat.cachedToolResults[k].fullContent !== undefined) out.push('ctr.' + k); });
        return out;
    }

    // The OLD (pre-F1) post-swap algorithm over the REAL strip: sort by
    // recency, keep the first K untouched, strip (evictBodies) + flag every
    // other chat. keepFilter narrows the keep candidates (retired / failed);
    // keepFirst (the current chat) is kept FIRST whatever its rank (fix-f1).
    function oracle(records, m130, keepFilter, keepFirst) {
        var map = {};
        records.forEach(function(r) { if (r && r.messages && r.messages.length > 0) map[r.id] = clone(r); });
        var ids = Object.keys(map);
        ids.sort(function(a, b) { return m130.chatPayloadRecencyTs(map[b]) - m130.chatPayloadRecencyTs(map[a]); });
        var cand = keepFilter ? ids.filter(function(id) { return keepFilter(map[id]); }) : ids;
        if (keepFirst && map[keepFirst]) cand = [keepFirst].concat(cand.filter(function(id) { return id !== keepFirst; }));
        var keep = cand.slice(0, m130.CHAT_KEEP_HYDRATED);
        ids.forEach(function(id) {
            if (keep.indexOf(id) >= 0) return;
            m130.stripChatPayloadsInPlace(map[id], true);
            map[id]._payloadsEvicted = true;
        });
        return { map: map, keep: keep };
    }

    async function runLoad(opts) {
        var m130 = await core130();
        var src = await loadFile(LOADER);
        var decls = FNS.map(function(n) { return cutDecl(src, n); });
        var names = FNS.slice();
        if (opts.realAdopt) {
            // The REAL boot carry-forward guard + merges (045) replace the
            // refuse-everything adoptChatRow stub below.
            var src045 = await loadFile(ADOPT_SRC);
            ADOPT_FNS.forEach(function(n) { decls.push(cutDecl(src045, n, ADOPT_SRC)); });
            names = names.concat(ADOPT_FNS);
        }
        var chunkM = /\nvar CHATS_LOAD_CHUNK_SIZE = (\d+);/.exec(src);
        assert.ok(chunkM, 'CHATS_LOAD_CHUNK_SIZE found');
        var chunk = Number(chunkM[1]);
        var minChars = m130.CHAT_BODY_EVICT_MIN_CHARS;
        var failIds = opts.failIds || {};
        var byId = {};
        opts.records.forEach(function(r) { byId[r.id] = clone(r); });
        var keys = Object.keys(byId).sort();
        var rec = { crumbs: [], ensure: [], strip: {}, errors: [], logs: [], degraded: [], timeouts: 0,
            intervals: 0, renders: 0, renderAt: [], adopt: 0, fileIndex: 0, batches: [], leaks: [] };
        function checkRows(rows, when) {
            rows.forEach(function(r) {
                if (!r || !r.messages || !r.messages.length || failIds[r.id]) return;
                var h = heavyFields(r, minChars);
                if (h.length) rec.leaks.push(when + ':' + r.id + ':' + h.join(','));
            });
        }
        function req(result) {
            var r = {};
            queueMicrotask(function() { r.result = result; r.onsuccess(); });
            return r;
        }
        function withStore(names, mode, fn, o) {
            assert.deepStrictEqual(names, ['chats']);
            assert.strictEqual(mode, 'readonly');
            assert.ok(o && o.deadlineMs > 0, 'boot reads pass a deadline');
            var tx = { objectStore: function(name) {
                assert.strictEqual(name, 'chats');
                return {
                    getAllKeys: function() { return req(keys.slice()); },
                    getAll: function(range) {
                        // The previous batch's iteration is over: its rows must be stripped.
                        if (rec.batches.length) checkRows(rec.batches[rec.batches.length - 1], 'batch' + (rec.batches.length - 1));
                        var rows = keys.filter(function(k) { return k >= range.lower && k <= range.upper; })
                            .map(function(k) { return clone(byId[k]); });
                        rec.batches.push(rows);
                        return req(rows);
                    }
                };
            } };
            return Promise.resolve().then(function() { return fn(tx); });
        }
        var scope = null;
        var globals = {
            chats: opts.initialChats || {},
            currentChatId: opts.currentChatId || null,
            chatStoreName: 'chats',
            CHATS_LOAD_CHUNK_SIZE: chunk,
            BOOT_CHATS_TX_DEADLINE_MS: 6000,
            _chatsLoadInFlight: null,
            IDBKeyRange: { bound: function(lower, upper) { return { lower: lower, upper: upper }; } },
            withStore: withStore,
            // Carry-forward runs after the batch loop, before the swap: every
            // batch row (the last one included) must already be stripped.
            adoptChatRow: function() {
                rec.adopt++;
                rec.batches.forEach(function(rows, i) { checkRows(rows, 'preswap' + i); });
                return false;
            },
            _storageDegraded: false,
            pausedChats: {},
            chatPayloadRecencyTs: m130.chatPayloadRecencyTs,
            CHAT_KEEP_HYDRATED: m130.CHAT_KEEP_HYDRATED,
            // Restores the stored record in place (the real one re-reads the
            // record + chat_payloads and clears the eviction flags).
            ensureChatPayloads: function(id) {
                rec.ensure.push(id);
                return Promise.resolve().then(function() {
                    var live = scope.chats[id];
                    Object.keys(live).forEach(function(k) { delete live[k]; });
                    Object.assign(live, clone(byId[id]));
                });
            },
            // renderAt: how many restores had STARTED when each repaint ran.
            renderMessages: function() { rec.renders++; rec.renderAt.push(rec.ensure.length); },
            _coldSweepTimer: null,
            rebuildFileIndexAll: function() { rec.fileIndex++; },
            _chatsHydrated: false,
            window: rec.win = {},
            enterStorageDegradedMode: function(e) { rec.degraded.push(String((e && e.message) || e)); },
            console: {
                log: function() { rec.logs.push(Array.prototype.map.call(arguments, String).join(' ')); },
                info: function() {}, warn: function() {},
                error: function() { rec.errors.push(Array.prototype.map.call(arguments, String).join(' ')); }
            },
            setTimeout: function() { rec.timeouts++; throw new Error('setTimeout used by the chat loader'); },
            setInterval: function() { rec.intervals++; return 0; }
        };
        if (!opts.noStrip) {
            globals.stripChatPayloadsInPlace = function(chat, evictBodies) {
                var id = chat && chat.id;
                (rec.strip[id] = rec.strip[id] || []).push({ flagged: !!(chat && chat._payloadsEvicted === true), evictBodies: evictBodies });
                if (failIds[id]) throw new Error('strip boom ' + id);
                return m130.stripChatPayloadsInPlace(chat, evictBodies);
            };
        }
        if (!opts.noCrumb) {
            globals.appBootCrumb = function(phase, extra) { rec.crumbs.push({ phase: phase, extra: clone(extra) }); };
        }
        if (opts.realAdopt) {
            delete globals.adoptChatRow;
            globals.pendingToolApprovals = {};
            globals._unionChatDisplaysForPut = m130._unionChatDisplaysForPut;
        }
        var ns = await evalModules(decls, names, { globals: globals });
        scope = ns.__scope;
        await ns.loadChatsFromStorage();
        await ticks(400); // _hydrateRecent: fire-and-forget, sequential, microtasks only
        return { ns: ns, scope: scope, rec: rec, keys: keys, chunk: chunk, m130: m130, minChars: minChars };
    }

    function assertCleanRun(r) {
        assert.deepStrictEqual(r.rec.degraded, [], 'no degraded-mode entry');
        assert.strictEqual(r.scope._chatsHydrated, true, '_chatsHydrated set');
        assert.strictEqual(r.rec.fileIndex, 1, 'file index rebuilt once');
        assert.strictEqual(r.rec.timeouts, 0, 'no setTimeout');
        assert.strictEqual(r.rec.intervals, 0, 'no timer registered (sweep fn absent in harness)');
    }

    test('strips every record inside its own batch, after the base64 tally', async function() {
        var fx = fixture(61);
        var initial = {};
        initial[fx.rankIds[20]] = { id: fx.rankIds[20], updatedAt: 1, messages: [{ role: 'user', content: 'stale in-memory copy' }] };
        var r = await runLoad({ records: fx.records, initialChats: initial });
        assertCleanRun(r);
        assert.strictEqual(r.rec.batches.length, Math.ceil(r.keys.length / r.chunk), 'one read per chunk');
        assert.ok(r.rec.batches.length >= 3, 'fixture spans several batches');
        assert.strictEqual(r.rec.adopt, 1, 'pre-swap check ran');
        assert.deepStrictEqual(r.rec.leaks, [], 'no batch row kept a body after its iteration');
        var loadedIds = Object.keys(r.scope.chats).sort();
        assert.strictEqual(loadedIds.length, 62, '61 heavy + s_small; e_empty skipped');
        assert.ok(!('e_empty' in r.scope.chats));
        loadedIds.forEach(function(id) {
            assert.ok(r.rec.strip[id] && r.rec.strip[id].length >= 1, 'stripped in loop: ' + id);
            assert.strictEqual(r.rec.strip[id][0].evictBodies, true, 'evictBodies on ' + id);
        });
        // The tally read base64 BEFORE the strip removed it.
        var st = r.rec.win.pageChatLoadStats;
        assert.ok(st && st.chats === 62, 'STORE-ACCT stats recorded: ' + JSON.stringify(st));
        assert.ok(st.inlineB64Chars > 0 && st.largestB64Chars > 0 && typeof st.largestId === 'string', 'inline base64 still in records was tallied');
        assert.deepStrictEqual(r.rec.logs, [], 'no debug console output');
        assert.deepStrictEqual(r.rec.crumbs, [
            { phase: 'pre-chats', extra: { n: 63 } },
            { phase: 'post-strip', extra: { n: 62, kept: 8 } }
        ]);
        assert.deepStrictEqual(r.ns.__unstubbed.slice().sort(), ['CHAT_MESSAGE_EVICTION_ENABLED', 'markChatMessagesDurable', 'sweepColdChatPayloads']);
    }, { tags: ['unit'], timeout: 15000 });

    test('re-hydrates the newest 8 chats; final map equals the pre-F1 post-swap oracle', async function() {
        var fx = fixture(61);
        var initial = {};
        initial[fx.rankIds[20]] = { id: fx.rankIds[20], updatedAt: 1, messages: [{ role: 'user', content: 'stale in-memory copy' }] };
        var r = await runLoad({ records: fx.records, initialChats: initial, currentChatId: fx.rankIds[2] });
        assertCleanRun(r);
        var top8 = fx.rankIds.slice(0, 8);
        var cur = fx.rankIds[2];
        assert.deepStrictEqual(r.rec.ensure, [cur].concat(top8.filter(function(id) { return id !== cur; })),
            'newest 8 re-hydrated: the current chat first, then recency order');
        var o = oracle(fx.records, r.m130);
        assert.deepStrictEqual(o.keep, top8);
        assert.deepStrictEqual(r.scope.chats, o.map, 'final map equals the old post-swap algorithm');
        top8.forEach(function(id) {
            assert.strictEqual(r.scope.chats[id]._payloadsEvicted, undefined, 'kept chat hydrated: ' + id);
            assert.strictEqual(r.rec.strip[id].length, 1, 'kept chat stripped once (in loop): ' + id);
        });
        Object.keys(r.scope.chats).forEach(function(id) {
            if (top8.indexOf(id) >= 0) return;
            assert.strictEqual(r.scope.chats[id]._payloadsEvicted, true, 'cold chat flagged: ' + id);
            assert.deepStrictEqual(heavyFields(r.scope.chats[id], r.minChars), [], 'cold chat stripped: ' + id);
            assert.strictEqual(r.rec.strip[id].length, 2, 'cold chat: loop + post-swap strip: ' + id);
            assert.strictEqual(r.rec.strip[id][1].flagged, true, 'flag set before the post-swap strip: ' + id);
        });
        assert.strictEqual(r.rec.strip.s_small[0].flagged, false, 'text-only chat: nothing stripped in loop');
        assert.strictEqual(r.rec.renders, 1, 'current chat repainted once hydrated');
        assert.deepStrictEqual(r.rec.renderAt, [1], 'repaint follows the FIRST restore');
    }, { tags: ['unit'], timeout: 15000 });

    test('retired sub-agent chats are excluded from the keep set', async function() {
        var fx = fixture(61, { extra: { 0: { retiredSubAgent: true }, 3: { retiredSubAgent: true } } });
        var r = await runLoad({ records: fx.records });
        assertCleanRun(r);
        var expected = [1, 2, 4, 5, 6, 7, 8, 9].map(function(k) { return fx.rankIds[k]; });
        assert.deepStrictEqual(r.rec.ensure, expected, 'top 8 NON-retired chats re-hydrated');
        [fx.rankIds[0], fx.rankIds[3]].forEach(function(id) {
            assert.strictEqual(r.scope.chats[id].retiredSubAgent, true);
            assert.strictEqual(r.scope.chats[id]._payloadsEvicted, true, 'retired chat stays cold: ' + id);
            assert.deepStrictEqual(heavyFields(r.scope.chats[id], r.minChars), [], 'retired chat stripped: ' + id);
        });
        var o = oracle(fx.records, r.m130, function(c) { return c.retiredSubAgent !== true; });
        assert.deepStrictEqual(o.keep, expected);
        assert.deepStrictEqual(r.scope.chats, o.map);
        assert.deepStrictEqual(r.rec.crumbs[r.rec.crumbs.length - 1], { phase: 'post-strip', extra: { n: 62, kept: 8 } });
    }, { tags: ['unit'], timeout: 15000 });

    test('a failed in-loop strip is isolated: flagged evicted first, never kept', async function() {
        var fx = fixture(61);
        var bad = fx.rankIds[1];
        var failIds = {};
        failIds[bad] = true;
        var r = await runLoad({ records: fx.records, failIds: failIds });
        assertCleanRun(r);
        var expected = [0, 2, 3, 4, 5, 6, 7, 8].map(function(k) { return fx.rankIds[k]; });
        assert.deepStrictEqual(r.rec.ensure, expected, 'keep set skips the failed chat');
        assert.strictEqual(r.rec.strip[bad].length, 2, 'loop strip + post-swap strip attempted');
        assert.strictEqual(r.rec.strip[bad][1].flagged, true, 'flag set before the post-swap strip');
        assert.strictEqual(r.scope.chats[bad]._payloadsEvicted, true, 'failed chat is put-skip protected');
        var errs = r.rec.errors.filter(function(e) { return /chat payload eviction failed during hydration:/.test(e); });
        assert.strictEqual(errs.length, 2, 'both failures logged, neither aborted the load');
        var o = oracle(fx.records, r.m130, function(c) { return c.id !== bad; });
        assert.deepStrictEqual(o.keep, expected);
        Object.keys(o.map).forEach(function(id) {
            if (id === bad) return;
            assert.deepStrictEqual(r.scope.chats[id], o.map[id], 'unaffected chat matches oracle: ' + id);
        });
    }, { tags: ['unit'], timeout: 15000 });

    test('without stripChatPayloadsInPlace, records load untouched and nothing is flagged', async function() {
        var fx = fixture(61);
        var r = await runLoad({ records: fx.records, noStrip: true });
        assertCleanRun(r);
        var pristine = {};
        fx.records.forEach(function(rec) { if (rec.messages.length) pristine[rec.id] = clone(rec); });
        assert.deepStrictEqual(r.scope.chats, pristine);
        assert.deepStrictEqual(r.rec.ensure, []);
        assert.deepStrictEqual(r.rec.crumbs, [{ phase: 'pre-chats', extra: { n: 63 } }]);
    }, { tags: ['unit'], timeout: 15000 });

    test('crumbs: <=7 per load, progress every max(500, n/5) records; appBootCrumb optional', async function() {
        var fx = fixture(3000, { tiny: true });
        var r = await runLoad({ records: fx.records });
        assertCleanRun(r);
        assert.deepStrictEqual(r.rec.crumbs, [
            { phase: 'pre-chats', extra: { n: 3000 } },
            { phase: 'chats-progress', extra: { n: 600 } },
            { phase: 'chats-progress', extra: { n: 1200 } },
            { phase: 'chats-progress', extra: { n: 1800 } },
            { phase: 'chats-progress', extra: { n: 2400 } },
            { phase: 'chats-progress', extra: { n: 3000 } },
            { phase: 'post-strip', extra: { n: 3000, kept: 8 } }
        ]);
        assert.deepStrictEqual(r.rec.ensure, [], 'tiny chats: nothing stripped, nothing to re-hydrate');
        var small = fixture(61);
        var r2 = await runLoad({ records: small.records, noCrumb: true });
        assertCleanRun(r2);
        assert.strictEqual(Object.keys(r2.scope.chats).length, 62);
        assert.deepStrictEqual(r2.rec.ensure, small.rankIds.slice(0, 8));
    }, { tags: ['unit'], timeout: 30000 });

    // fix-f1 (review A #1): the chat on screen is restored FIRST, even from
    // outside the newest K, and the keep set stays K in total.
    test('the current chat is kept FIRST even outside the newest 8; the keep set stays 8', async function() {
        var fx = fixture(61);
        var cur = fx.rankIds[30];
        var r = await runLoad({ records: fx.records, currentChatId: cur });
        assertCleanRun(r);
        var K = r.m130.CHAT_KEEP_HYDRATED;
        assert.strictEqual(K, 8);
        var expected = [cur].concat(fx.rankIds.slice(0, K - 1));
        assert.deepStrictEqual(r.rec.ensure, expected, 'current chat restored first, then the newest K-1');
        assert.deepStrictEqual(r.rec.renderAt, [1], 'repainted right after its own (first) restore');
        var o = oracle(fx.records, r.m130, null, cur);
        assert.deepStrictEqual(o.keep, expected);
        assert.deepStrictEqual(r.scope.chats, o.map, 'final map equals the oracle keeping the current chat');
        assert.strictEqual(r.scope.chats[cur]._payloadsEvicted, undefined, 'current chat hydrated');
        assert.strictEqual(r.rec.strip[cur].length, 1, 'current chat stripped once (in loop)');
        var bumped = fx.rankIds[K - 1];
        assert.strictEqual(r.scope.chats[bumped]._payloadsEvicted, true, 'K-th newest chat yields its slot');
        assert.deepStrictEqual(heavyFields(r.scope.chats[bumped], r.minChars), [], 'bumped chat stays stripped');
        assert.deepStrictEqual(r.rec.crumbs[r.rec.crumbs.length - 1], { phase: 'post-strip', extra: { n: 62, kept: K } });
    }, { tags: ['unit'], timeout: 15000 });

    test('current-first edges: a strip-failed or unknown current id takes no slot; a retired one does', async function() {
        var fx = fixture(61, { extra: { 0: { retiredSubAgent: true } } });
        var top = fx.rankIds.slice(1, 9); // newest 8 NON-retired
        var cur = fx.rankIds[30], failIds = {};
        failIds[cur] = true;
        var r1 = await runLoad({ records: fx.records, currentChatId: cur, failIds: failIds });
        assertCleanRun(r1);
        assert.deepStrictEqual(r1.rec.ensure, top, 'strip-failed current chat is not kept');
        assert.strictEqual(r1.scope.chats[cur]._payloadsEvicted, true, 'put-skip protected instead');
        assert.deepStrictEqual(r1.rec.renderAt, [], 'not restored at boot, so no boot repaint');
        var r2 = await runLoad({ records: fx.records, currentChatId: 'chat_not_loaded' });
        assertCleanRun(r2);
        assert.deepStrictEqual(r2.rec.ensure, top, 'unknown current id is ignored');
        assert.ok(!('chat_not_loaded' in r2.scope.chats));
        // A retired sub-agent chat ON SCREEN is still restored first (the
        // runtime sweep never strips the current chat either).
        var r3 = await runLoad({ records: fx.records, currentChatId: fx.rankIds[0] });
        assertCleanRun(r3);
        assert.deepStrictEqual(r3.rec.ensure, fx.rankIds.slice(0, 8), 'retired current chat first, then 7 newest non-retired');
        assert.strictEqual(r3.scope.chats[fx.rankIds[0]]._payloadsEvicted, undefined);
        assert.strictEqual(r3.scope.chats[fx.rankIds[8]]._payloadsEvicted, true, '8th non-retired chat yields its slot');
    }, { tags: ['unit'], timeout: 30000 });

    // fix-f1 (review A #2): disk rows are stripped BEFORE the FLUX-ADOPT
    // carry-forward. Pins that the REAL adoptChatRow never moves a stripped
    // disk row's bodies onto the in-memory chat it adopts: it only copies
    // PENDING prompt_user/approval rows (RES-5), which the strip never touches,
    // and the heavy graft only takes entries that still HAVE their payload.
    test('real adoptChatRow: a fresher in-memory chat keeps its bodies over a stripped disk row', async function() {
        var fx = fixture(61);
        var X = fx.rankIds[30], Y = fx.rankIds[40];
        function rec0(id) { return fx.records.filter(function(rr) { return rr.id === id; })[0]; }
        var diskX = rec0(X);
        diskX.rev = 5;
        diskX.messages.push(
            { role: 'approval', toolName: 'web_fetch', actualToolName: 'web_fetch', args: { url: 'https://example.com/' + big('q', 700) },
                permissionKey: 'web_fetch', toolCallId: 'tc_appr_' + X, status: 'pending' },
            { role: 'prompt_user', promptId: 'p_' + X, toolCallId: 'tc_prompt_' + X, title: 'Pick', description: big('d', 700),
                fields: [{ name: 'a', type: 'text', value: big('v', 700) }], status: 'pending' });
        var diskApproval = clone(diskX.messages[4]), diskPrompt = clone(diskX.messages[5]);
        rec0(Y).rev = 5;
        // In-memory X: FRESHER (rev 6), unflagged, hydrated with its OWN bodies.
        var memX = heavyRecord(X, diskX.updatedAt, { rev: 6, title: 'mem ' + X });
        memX.messages[1].thinking = big('M', 650);
        memX.messages[2].content = big('Y', 950);
        memX.messages.push(
            { role: 'prompt_user', promptId: 'p_' + X, toolCallId: 'tc_prompt_' + X, title: 'Pick',
                fields: [{ name: 'a', type: 'text', value: 'draft' }], status: 'pending' },
            { role: 'assistant', content: 'newer tail' });
        memX.screenshots['ss_' + X] = { name: 'shot-mem', _b64Evicted: true };
        memX.cachedToolResults['ctr_' + X] = { summary: 'sum-mem', _fcEvicted: true };
        var memXBefore = clone(memX);
        // In-memory Y: STALER (rev 1): refused, the stripped disk row stays.
        var memY = { id: Y, rev: 1, updatedAt: 1, messages: [{ role: 'user', content: 'stale ' + Y }] };
        var initial = {};
        initial[X] = memX;
        initial[Y] = memY;
        var r = await runLoad({ records: fx.records, initialChats: initial, currentChatId: X, realAdopt: true });
        assertCleanRun(r);
        var x = r.scope.chats[X];
        assert.strictEqual(x, memX, 'fresher in-memory object adopted');
        assert.strictEqual(x._payloadsEvicted, undefined, 'no flag copied, none needed');
        assert.strictEqual(x.title, 'mem ' + X);
        assert.strictEqual(x.messages.length, 7, 'pending approval spliced in from disk');
        [0, 1, 2, 3].forEach(function(i) { assert.deepStrictEqual(x.messages[i], memXBefore.messages[i], 'in-memory row intact: ' + i); });
        assert.deepStrictEqual(x.messages[4], diskApproval, 'spliced disk approval row is body-intact');
        assert.deepStrictEqual(x.messages[5], diskPrompt, 'pending disk prompt row is body-intact');
        assert.deepStrictEqual(x.messages[6], memXBefore.messages[5]);
        x.messages.forEach(function(m, i) { assert.ok(!m._bodyEvicted && !m._b64Evicted, 'no evicted row on the unflagged chat: ' + i); });
        assert.deepStrictEqual(heavyFields(x, r.minChars), heavyFields(memXBefore, r.minChars), 'every in-memory heavy field survives');
        assert.deepStrictEqual(x.screenshots['ss_' + X], { name: 'shot-mem', _b64Evicted: true }, 'stripped disk screenshot never grafted');
        assert.deepStrictEqual(x.cachedToolResults['ctr_' + X], { summary: 'sum-mem', _fcEvicted: true }, 'stripped disk CTR never grafted');
        assert.deepStrictEqual(r.rec.ensure, fx.rankIds.slice(0, 7), 'unflagged current chat needs no restore; newest 7 restored');
        assert.deepStrictEqual(r.rec.renderAt, [0], 'current chat still repainted first');
        var y = r.scope.chats[Y];
        assert.notStrictEqual(y, memY, 'staler in-memory copy refused');
        assert.strictEqual(y._payloadsEvicted, true, 'stripped disk row stays flagged: put-skip protected');
        assert.deepStrictEqual(heavyFields(y, r.minChars), []);
    }, { tags: ['unit'], timeout: 15000 });
});
