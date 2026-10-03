// riUsageRollup NO-FULL-SCAN (tools/145-usage-rollup.js): a warm poll
// enumerates keys and replays cached chats whose in-memory page row still
// matches the record pre-signature; only changed / not-in-memory / re-verify
// chats are read (one store.get each). Output must equal the exact full pass.
// The fixture numbers match what the old full-cursor implementation returned
// (see test/widget-store-usage-rollup-memory.test.js: 4 calls / 136 input).
// M1: a page row's message count is read ONLY via core's chatMessageCount()
// (evicted skeletons keep `_msgCount`, no `messages`); without it every warm
// call is the exact full pass. S1/S3: re-verify capacity is
// max(8, ceil(n*elapsed/R)) and each batch's trust stamps are spread over the
// span it covers, so expiries never bunch (fake clock, n = 20 chats).
describe('usage rollup: no full-record scan on warm polls', function() {
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    // In-memory IDB store: every record read is logged ('get:k' / 'cur:k').
    function fakeDb(s, log, control) {
        function req(fn) {
            var r = {};
            Promise.resolve().then(function() { r.result = fn(); if (r.onsuccess) r.onsuccess(); });
            return r;
        }
        return { transaction: function() { return { objectStore: function() { return {
            getAllKeys: function() { log.push('keys'); return req(function() { return Array.from(s.keys()).sort(); }); },
            get: function(k) { log.push('get:' + k); return req(function() { return s.has(k) ? clone(s.get(k)) : undefined; }); },
            openCursor: function() {
                var keys = Array.from(s.keys()).sort(), i = 0, r = {};
                function step() {
                    Promise.resolve().then(function() {
                        if (control.cursorError) { r.error=control.cursorError;r.onerror();return; }
                        if (i >= keys.length) { r.result = null; r.onsuccess(); return; }
                        var k = keys[i++];
                        log.push('cur:' + k);
                        r.result = { key: k, value: clone(s.get(k)), continue: step };
                        r.onsuccess();
                    });
                }
                step();
                return r;
            }
        }; } }; } };
    }
    function asst(i, o, extra) {
        return { role: 'assistant', metrics: Object.assign({ input_tokens: i, output_tokens: o, cache_read_tokens: 3,
            cache_write_tokens: 1, cache_creation_tokens: 2, cost: 0.01, endTime: Date.now() - 5000 }, extra || {}) };
    }
    var R = 3600000; // RI_USAGE_REVERIFY_MS (asserted in S3)
    // Load the real skeleton-safe counter from core; do not duplicate its implementation.
    var core;
    beforeEach(async function(){core=await loadModules(['src/js/core/130-indexeddb.js'],{globals:{STORAGE_PREFIX:'test_',self:{}}});});
    // opts.n: that many uniform chats k00.. (input 10+i) instead of a/b/c;
    // opts.countFn:false: core's chatMessageCount not loaded; opts.clock: {now}
    // drives the module's Date.
    async function setup(opts) {
        opts = opts || {};
        var now = Date.now(), store = new Map(), log = [], mem = {};
        if (opts.n) {
            for (var i = 0; i < opts.n; i++) {
                var k = 'k' + ('0' + i).slice(-2);
                store.set(k, { id: k, rev: 1, title: k, model: 'm1', createdAt: now - 86400000, updatedAt: now - 1000,
                    messages: [{ role: 'user' }, asst(10 + i, 1)] });
            }
        } else {
            store.set('a', { id: 'a', rev: 1, title: 'A', model: 'm1', createdAt: now - 86400000, updatedAt: now - 1000,
                messages: [{ role: 'user' }, asst(100, 10), asst(0, 0), asst(50, 5, { isAggregate: true }), asst(7, 3, { actualModel: 'm2' })] });
            store.set('b', { id: 'b', rev: 4, title: 'B', createdAt: now - 3600000, updatedAt: now - 500,
                messages: [asst(20, 2, { endTime: 0 }), { role: 'assistant', timestamp: now - 2000, metrics: { input_tokens: 9 } }] });
            store.set('c', { id: 'c', title: 'C', messages: [{ role: 'user' }] });
        }
        // Page rows carry meta + message COUNT only (bodies/metrics stripped).
        store.forEach(function(v, k) {
            mem[k] = clone(v);
            mem[k].messages = mem[k].messages.map(function(m) { return { role: m.role, _bodyEvicted: true }; });
        });
        var control={cursorError:null},db = fakeDb(store, log, control);
        var globals = { chats: mem, openDatabase: function() { return Promise.resolve(db); } };
        if (opts.countFn !== false) globals.chatMessageCount = core.chatMessageCount;
        if (opts.clock) {
            var clock = opts.clock, FakeDate = function(a) { return arguments.length ? new Date(a) : new Date(clock.now); };
            FakeDate.now = function() { return clock.now; };
            globals.Date = FakeDate;
        }
        var mod = await loadModules(['src/js/tools/145-usage-rollup.js'], { globals: globals });
        return { mod: mod, store: store, log: log, mem: mem, control:control, clock: opts.clock, keys: Array.from(store.keys()).sort() };
    }
    async function poll(t, opts) { t.log.length = 0; return t.mod.riUsageRollup(opts || {}); }
    function reads(log) { return log.filter(function(x) { return x !== 'keys'; }); }
    function getK(k) { return 'get:' + k; }
    // last[key] = fake-clock time of that chat's latest disk read (get / cursor).
    function track(t, last) { t.log.forEach(function(x) { var m = /^(?:get|cur):(.*)$/.exec(x); if (m) last[m[1]] = t.clock.now; }); }
    // 20 polls every P = R/10 (cap stays 8): each re-reads exactly 2 chats, no
    // chat goes R + P or longer without a disk read, and the output stays exact.
    // Returns the re-read order.
    async function densePolls(t, first, last, label) {
        var P = R / 10, order = [];
        for (var p = 1; p <= 20; p++) {
            t.clock.now += P;
            var r = await poll(t), got = reads(t.log);
            assert.strictEqual(got.length, 2, label + ' poll ' + p + ' re-reads exactly 2: ' + got.join(','));
            order = order.concat(got); track(t, last);
            t.keys.forEach(function(k) { assert.ok(t.clock.now - last[k] < R + P, label + ' poll ' + p + ' ' + k + ' age ' + (t.clock.now - last[k])); });
            assert.deepStrictEqual(r, first, label + ' poll ' + p);
            if (p % 5 === 0) assert.deepStrictEqual(r, await poll(t, { noCache: true }), label + ' poll ' + p + ' = exact');
        }
        return order;
    }

    it('cold call is one cursor pass with the old numbers; warm polls read no record and are identical', async function() {
        var t = await setup();
        var first = await poll(t);
        assert.deepStrictEqual(reads(t.log), ['cur:a', 'cur:b', 'cur:c'], 'cold cache = exact full pass');
        var g = first.global;
        assert.deepStrictEqual([g.chats, g.chats_with_usage, g.llm_calls, g.input, g.output, g.cache_read, g.cache_write],
            [3, 2, 4, 136, 15, 9, 9]);
        assert.deepStrictEqual(first.chats.map(function(r) { return [r.key, r.title, r.calls, r.input, r.msgs, r.models.join(',')]; }),
            [['a', 'A', 2, 107, 5, 'm1,m2'], ['b', 'B', 2, 29, 2, 'unknown']]);
        assert.deepStrictEqual(Object.keys(first.per_model), ['m1', 'm2', 'unknown']);
        var second = await poll(t);
        assert.deepStrictEqual(t.log, ['keys'], 'warm poll: keys only, no get, no cursor');
        assert.deepStrictEqual(second, first);
        var variants = [{ series: 'hourly', by_model: true }, { series: 'daily' }, { series: 'monthly', page: 0, pageSize: 5 }, { page: 1, pageSize: 1 }];
        for (var i = 0; i < variants.length; i++) {
            var warm = await poll(t, clone(variants[i]));
            assert.deepStrictEqual(t.log, ['keys'], 'variant ' + i + ' warm');
            var exact = await poll(t, Object.assign(clone(variants[i]), { noCache: true }));
            assert.deepStrictEqual(warm, exact, 'variant ' + i + ' equals exact pass');
        }
        assert.deepStrictEqual(t.mod.__unstubbed, []);
    }, { tags: ['unit'], timeout: 5000 });

    it('changed meta re-reads exactly that record; memory-ahead and disk-ahead staleness converge', async function() {
        var t = await setup();
        await poll(t);
        var a = t.store.get('a');
        a.messages.push(asst(1000, 100)); a.rev = 2;
        t.mem.a.messages.push({ role: 'assistant' }); t.mem.a.rev = 2;
        var r = await poll(t);
        assert.deepStrictEqual(reads(t.log), ['get:a'], 'only the changed chat is read');
        assert.strictEqual(r.global.input, 1136);
        assert.deepStrictEqual(r, await poll(t, { noCache: true }));
        // Memory AHEAD of disk (append not saved yet): re-read every poll.
        t.mem.b.rev = 5; t.mem.b.messages.push({ role: 'assistant' });
        for (var n = 0; n < 2; n++) {
            r = await poll(t);
            assert.deepStrictEqual(reads(t.log), ['get:b'], 'unsaved chat re-read, poll ' + n);
            assert.strictEqual(r.global.input, 1136);
        }
        var b = t.store.get('b');
        b.rev = 5; b.messages.push(asst(5, 1));
        r = await poll(t);
        assert.deepStrictEqual(reads(t.log), ['get:b']);
        assert.strictEqual(r.global.input, 1141, 'save landed -> counted');
        await poll(t);
        assert.deepStrictEqual(t.log, ['keys'], 'converged: back to keys only');
        // Disk AHEAD of memory (write the page never heard of): trusted until
        // RI_USAGE_REVERIFY_MS, then re-read and exact again.
        t.store.get('a').messages.push(asst(1, 1));
        r = await poll(t);
        assert.deepStrictEqual(t.log, ['keys']);
        assert.strictEqual(r.global.input, 1141, 'stale within the re-verify window (documented trade-off)');
        t.mod._riUsageCache.get('a').at -= t.mod.RI_USAGE_REVERIFY_MS;
        r = await poll(t);
        assert.deepStrictEqual(reads(t.log), ['get:a'], 'expired hit re-verified');
        assert.strictEqual(r.global.input, 1142);
        assert.deepStrictEqual(r, await poll(t, { noCache: true }));
    }, { tags: ['unit'], timeout: 5000 });

    it('chats missing from the page map use get; noCache is a full cursor pass that leaves the cache alone', async function() {
        var t = await setup();
        var first = await poll(t);
        delete t.mem.c;
        var r = await poll(t);
        assert.deepStrictEqual(reads(t.log), ['get:c']);
        assert.deepStrictEqual(r, first);
        var entryA = t.mod._riUsageCache.get('a');
        var exact = await poll(t, { noCache: true });
        assert.deepStrictEqual(t.log, ['cur:a', 'cur:b', 'cur:c'], 'noCache = full cursor, no key enumeration');
        assert.deepStrictEqual(exact, first);
        assert.strictEqual(t.mod._riUsageCache.get('a'), entryA, 'noCache does not touch the cache');
        t.store.delete('b'); delete t.mem.b;
        r = await poll(t);
        assert.deepStrictEqual(reads(t.log), ['get:c'], 'c is still not in the page map');
        assert.ok(!t.mod._riUsageCache.has('b'), 'deleted chat evicted');
        assert.strictEqual(r.global.input, 107);
        assert.deepStrictEqual(r, await poll(t, { noCache: true }));
    }, { tags: ['unit'], timeout: 5000 });

    it('M1a: evicted skeleton rows (no messages, _msgCount) are trusted via chatMessageCount; a wrong count re-reads', async function() {
        var t = await setup();
        var first = await poll(t);
        Object.keys(t.mem).forEach(function(k) {
            var row = t.mem[k];
            row._msgCount = row.messages.length; row._messagesEvicted = true; delete row.messages;
        });
        var r = await poll(t);
        assert.deepStrictEqual(t.log, ['keys'], 'skeleton rows are hits: keys only (a .messages count would read 0 and re-read all)');
        assert.deepStrictEqual(r, first);
        assert.deepStrictEqual(r, await poll(t, { noCache: true }));
        delete t.mem.c._msgCount;
        r = await poll(t);
        assert.deepStrictEqual(reads(t.log), ['get:c'], 'skeleton without _msgCount counts 0 -> pre mismatch -> re-read');
        assert.deepStrictEqual(r, first);
        assert.deepStrictEqual(t.mod.__unstubbed, []);
    }, { tags: ['unit'], timeout: 10000 });

    it('M1b: without chatMessageCount no page row is trusted: every warm call is the exact full pass, row.messages never read', async function() {
        var t = await setup({ countFn: false });
        Object.keys(t.mem).forEach(function(k) {
            var msgs = t.mem[k].messages;
            Object.defineProperty(t.mem[k], 'messages', { configurable: true, enumerable: true,
                get: function() { t.log.push('mem:' + k); return msgs; } });
        });
        var full = ['keys', 'cur:a', 'cur:b', 'cur:c'];
        var first = await poll(t);
        assert.deepStrictEqual(t.log, full, 'cold: one cursor pass, no mem: read');
        assert.strictEqual(first.global.input, 136);
        for (var n = 0; n < 2; n++) {
            var r = await poll(t);
            assert.deepStrictEqual(t.log, full, 'warm ' + n + ': exact full pass, no mem: read');
            assert.deepStrictEqual(r, first, 'warm ' + n);
            var exact = await poll(t, { noCache: true });
            assert.deepStrictEqual(t.log, ['cur:a', 'cur:b', 'cur:c'], 'noCache ' + n + ': no mem: read');
            assert.deepStrictEqual(r, exact, 'warm ' + n + ' = exact');
        }
        assert.deepStrictEqual(t.mod.__unstubbed, ['chatMessageCount']);
    }, { tags: ['unit'], timeout: 10000 });

    it('S3a: a cold pass staggers trust stamps over R, so dense polls re-read a steady 2 per poll in FIFO order', async function() {
        var clock = { now: Date.now() };
        var t = await setup({ n: 20, clock: clock });
        assert.strictEqual(t.mod.RI_USAGE_REVERIFY_MS, R);
        var first = await poll(t), T0 = clock.now, last = {};
        assert.deepStrictEqual(reads(t.log), t.keys.map(function(k) { return 'cur:' + k; }), 'cold = one cursor pass');
        track(t, last);
        t.keys.forEach(function(k, i) {
            assert.strictEqual(T0 - t.mod._riUsageCache.get(k).at, Math.floor(R * (19 - i) / 20), k + ' stamp');
        });
        var once = t.keys.map(getK);
        assert.deepStrictEqual(await densePolls(t, first, last, 'S3a'), once.concat(once));
    }, { tags: ['unit'], timeout: 10000 });

    it('S3b: re-verify cap is max(8, ceil(n*elapsed/R)): 8 per call at short gaps, all 20 after 2R, then restaggered', async function() {
        var clock = { now: Date.now() };
        var t = await setup({ n: 20, clock: clock });
        var first = await poll(t);
        // Everything due, k19 oldest.
        t.keys.forEach(function(k, i) { t.mod._riUsageCache.get(k).at = clock.now - R - (i + 1) * 1000; });
        var batches = [t.keys.slice(12), t.keys.slice(4, 12), t.keys.slice(0, 4)];
        for (var c = 0; c < 3; c++) {
            clock.now += 1000;
            var r = await poll(t);
            assert.deepStrictEqual(reads(t.log), batches[c].map(getK), 'call ' + c + ': oldest due first, cap 8');
            assert.deepStrictEqual(r, first, 'call ' + c);
        }
        clock.now += 1000;
        assert.deepStrictEqual(await poll(t), first);
        assert.deepStrictEqual(t.log, ['keys'], 'nothing due');
        clock.now += 2 * R;
        r = await poll(t);
        assert.deepStrictEqual(reads(t.log), t.keys.map(getK), 'gap 2R: cap 40 re-reads all 20 (a fixed cap of 8 would not)');
        assert.deepStrictEqual(r, first);
        clock.now += R / 10;
        r = await poll(t);
        assert.deepStrictEqual(reads(t.log), ['get:k18', 'get:k19'], 'restaggered over R: only the 2 oldest are due R/10 later');
        assert.deepStrictEqual(r, first);
        assert.deepStrictEqual(r, await poll(t, { noCache: true }));
    }, { tags: ['unit'], timeout: 10000 });

    it('clock rolls back R/2: reverified stamps clamp to now instead of moving into the future',async function(){
        var clock={now:20000000},t=await setup({n:20,clock:clock});
        var first=await poll(t);clock.now-=R/2;
        // Make all hits due; elapsed remains negative relative to the last successful call.
        t.keys.forEach(function(k){t.mod._riUsageCache.get(k).at=clock.now-R;});
        assert.deepStrictEqual(await poll(t),first);
        assert.deepStrictEqual(reads(t.log),t.keys.slice(0,8).map(getK));
        assert.deepStrictEqual(t.keys.map(function(k){return t.mod._riUsageCache.get(k).at;}),
            t.keys.map(function(k,i){return i<8?clock.now:clock.now-R;}));
        assert.strictEqual(t.mod.__scope._riUsageLastCall,clock.now);
    });
    it('cursor failure before its first record leaves trust stamps and last-call time unchanged',async function(){
        var clock={now:20000000},t=await setup({n:20,clock:clock});await poll(t);
        var stamps=t.keys.map(function(k){return t.mod._riUsageCache.get(k).at;}),last=t.mod.__scope._riUsageLastCall;
        // Force the full-cursor path without changing the existing cache; fail before any record is adopted.
        t.keys.forEach(function(k){delete t.mem[k];});clock.now+=R/2;
        var failure=new Error('cursor broke');t.control.cursorError=failure;
        var caught;try{await poll(t);}catch(e){caught=e;}
        assert.strictEqual(caught,failure);assert.deepStrictEqual(t.log,['keys']);
        assert.deepStrictEqual(t.keys.map(function(k){return t.mod._riUsageCache.get(k).at;}),stamps);
        assert.strictEqual(t.mod.__scope._riUsageLastCall,last);
    });

    it('S3c: a call after a gap >= R (R and 3R) spreads the re-read stamps over R instead of bunching them', async function() {
        var gaps = [R, 3 * R];
        for (var gi = 0; gi < gaps.length; gi++) {
            var clock = { now: Date.now() }, label = 'gap ' + (gaps[gi] / R) + 'R';
            var t = await setup({ n: 20, clock: clock });
            var first = await poll(t);
            clock.now += gaps[gi];
            var r = await poll(t), last = {};
            assert.deepStrictEqual(reads(t.log), t.keys.map(getK), label + ': every chat due and re-read');
            assert.deepStrictEqual(r, first, label);
            track(t, last);
            var ages = t.keys.map(function(k) { return clock.now - t.mod._riUsageCache.get(k).at; })
                .sort(function(a, b) { return a - b; });
            assert.deepStrictEqual(ages, t.keys.map(function(_, i) { return i * R / 20; }), label + ': stamps spread evenly over R');
            var once = t.keys.map(getK);
            assert.deepStrictEqual(await densePolls(t, first, last, label), once.concat(once), label + ': steady 2 per poll');
        }
    }, { tags: ['unit'], timeout: 10000 });
});
