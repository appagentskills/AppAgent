// H10 + M3 regression tests for src/js/worker/115-storage.js, evaluated from the
// REAL source with in-memory stubs for the IDB layer (withStore etc.).
//  H10: _rescueDirtyEvictedChat must keep _dirtyWhileEvicted (and skip the
//       save) when ensureChatPayloads resolved WITHOUT hydrating (it never
//       rejects). Old code deleted the stamp unconditionally → mutation lost.
//  M3:  saveChatsToStorage waiters resolve {ok:true} / {ok:false,error}. Old
//       code resolved undefined even when the save threw.
describe('worker storage fixes (H10, M3)', function() {
    async function makeEnv(opts) {
        opts = opts || {};
        var src = await loadFile('src/js/worker/115-storage.js');
        var env = { chats: opts.chats || {}, withStoreCalls: 0, ensureCalls: 0, ensureImpl: opts.ensure, withStoreImpl: opts.withStore };
        function fakeTx() { return { objectStore: function() { return { get: function() { return {}; }, put: function() { return {}; } }; } }; }
        function withStore(names, mode, fn) {
            env.withStoreCalls++;
            if (env.withStoreImpl) return env.withStoreImpl(fn, fakeTx);
            return Promise.resolve(fn(fakeTx()));
        }
        var names = ['chats', 'withStore', 'ensureChatPayloads', 'primeChatPayloadIdCache', 'extractChatPayloadsForPut',
            'queueChatPayloadPuts', '_mergeChatRowForPut', 'CHAT_META_TS_FIELDS', 'CHAT_META_FLAG_FIELDS',
            'chatStoreName', 'chatPayloadsStoreName', 'sweepColdChatPayloads', 'console'];
        var api = new Function(names.join(','), src + '\n;return {' +
            'save: saveChatsToStorage, rescue: _rescueDirtyEvictedChat,' +
            'hydrate: function(v) { _chatsHydrated = v; },' +
            'inFlight: function() { return _evictedRescueInFlight; } };')(
            env.chats, withStore,
            function(id) { env.ensureCalls++; return env.ensureImpl ? env.ensureImpl(id, env.chats) : Promise.resolve(); },
            function(tx, cb) { cb(); },
            function(c) { return { record: c, payloads: [] }; },
            function() { return 0; },
            function(r) { return r; },
            [], [], 'chats', 'chat_payloads', function() {},
            { log: function() {}, warn: function() {}, error: function() {} });
        env.api = api;
        return env;
    }
    async function flush() { for (var n = 0; n < 30; n++) await Promise.resolve(); }

    test('M3: committed save resolves {ok:true}', async function() {
        var env = await makeEnv(); env.api.hydrate(true);
        var r = await env.api.save();
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(env.withStoreCalls, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('M3: failed save resolves {ok:false,error} for the caller AND coalesced waiters', async function() {
        var release;
        var env = await makeEnv({ withStore: function() { return new Promise(function(_, rej) { release = function() { rej(new Error('quota boom')); }; }); } });
        env.api.hydrate(true);
        var a = env.api.save();
        var b = env.api.save(); // parks behind the in-flight save (pending-again)
        await flush();
        release();
        await flush();
        // second pass (pending-again re-run) also fails the same way
        if (release) release();
        var ra = await a, rb = await b;
        assert.strictEqual(ra.ok, false); assert.match(ra.error, /quota boom/);
        assert.strictEqual(rb.ok, false); assert.match(rb.error, /quota boom/);
    }, { tags: ['unit'], timeout: 5000 });

    test('M3: an aborted first attempt that withStore retries and commits reports ok:true', async function() {
        // Mirrors withStore's reopen-retry: attempt 1's tx aborts, attempt 2 commits.
        var env = await makeEnv({ withStore: function(fn, fakeTx) {
            var t1 = fakeTx(); var p1 = fn(t1);
            if (t1.onabort) t1.onabort();
            return p1.then(function() { return fn(fakeTx()); });
        } });
        env.api.hydrate(true);
        var r = await env.api.save();
        assert.deepStrictEqual(r, { ok: true });
    }, { tags: ['unit'], timeout: 5000 });

    test('M3: unhydrated wipe-guard returns {ok:false} and never opens a transaction', async function() {
        var env = await makeEnv();
        var r = await env.api.save();
        assert.strictEqual(r.ok, false); assert.match(r.error, /not hydrated/);
        assert.strictEqual(env.withStoreCalls, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('H10: failed hydration keeps _dirtyWhileEvicted, skips the save, and allows a retry', async function() {
        var chats = { x: { messages: [{ role: 'user', content: 'hi' }], _payloadsEvicted: true, _dirtyWhileEvicted: true } };
        var env = await makeEnv({ chats: chats, ensure: function() { return Promise.resolve(); } }); // resolves, flag kept
        env.api.hydrate(true);
        env.api.rescue('x');
        await flush();
        assert.strictEqual(chats.x._dirtyWhileEvicted, true, 'dirty stamp must survive a failed hydration');
        assert.strictEqual(env.withStoreCalls, 0, 'no save of a still-evicted chat');
        assert.strictEqual(env.api.inFlight().x, undefined, 'single-flight latch released');
        env.api.rescue('x'); await flush();
        assert.strictEqual(env.ensureCalls, 2, 'next save can re-trigger the rescue');
    }, { tags: ['unit'], timeout: 5000 });

    test('H10: successful hydration clears the stamp and saves', async function() {
        var chats = { x: { messages: [{ role: 'user', content: 'hi' }], _payloadsEvicted: true, _dirtyWhileEvicted: true } };
        var env = await makeEnv({ chats: chats, ensure: function(id, c) { delete c[id]._payloadsEvicted; return Promise.resolve(); } });
        env.api.hydrate(true);
        env.api.rescue('x');
        await flush();
        assert.strictEqual(chats.x._dirtyWhileEvicted, undefined);
        assert.strictEqual(env.withStoreCalls, 1);
    }, { tags: ['unit'], timeout: 5000 });
});
