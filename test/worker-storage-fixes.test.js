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
        var env = { chats: opts.chats || {}, withStoreCalls: 0, ensureCalls: 0, puts: 0, ensureImpl: opts.ensure, withStoreImpl: opts.withStore };
        function fakeTx() { return { objectStore: function() { return { get: function() { return {}; }, put: function() { env.puts++; return {}; } }; } }; }
        function withStore(names, mode, fn) {
            env.withStoreCalls++;
            if (env.withStoreImpl) return env.withStoreImpl(fn, fakeTx);
            return Promise.resolve(fn(fakeTx()));
        }
        var names = ['chats', 'withStore', 'ensureChatPayloads', 'primeChatPayloadIdCache', 'extractChatPayloadsForPut',
            'queueChatPayloadPuts', '_mergeChatRowForPut', 'CHAT_META_TS_FIELDS', 'CHAT_META_FLAG_FIELDS',
            'chatStoreName', 'chatPayloadsStoreName', 'sweepColdChatPayloads', 'console', 'chrome'];
        var api = new Function(names.join(','), src + '\n;return {' +
            'save: saveChatsToStorage, rescue: _rescueDirtyEvictedChat,' +
            'hydrate: function(v) { _chatsHydrated = v; },' +
            'inFlight: function() { return _evictedRescueInFlight; },' +
            'lockMsg: _onDeleteAllSaveLockMessage, wipeLocked: function() { return _chatsWipeLocked; } };')(
            env.chats, withStore,
            function(id) { env.ensureCalls++; return env.ensureImpl ? env.ensureImpl(id, env.chats) : Promise.resolve(); },
            function(tx, cb) { cb(); },
            function(c) { return { record: c, payloads: [] }; },
            function() { return 0; },
            function(r) { return r; },
            [], [], 'chats', 'chat_payloads', function() {},
            { log: function() {}, warn: function() {}, error: function() {} },
            opts.chrome); // TA-3: default undefined, so the EOF listener registration never touches a real chrome
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

    // TA-3 (Delete All save lock): the chrome fake answers getURL like the real
    // extension origin and captures the onMessage listener the EOF registers.
    function lockChrome() {
        var c = { listeners: [] };
        c.chrome = { runtime: { getURL: function(p) { return 'chrome-extension://abc/' + p; },
            onMessage: { addListener: function(fn) { c.listeners.push(fn); } } } };
        return c;
    }
    var LOCK_OWN = { url: 'chrome-extension://abc/index.html' };
    function lockMsgOf(locked) { return { type: 'delete-all-save-lock', locked: locked }; }

    test('TA-3: a lock set while a save waits for its transaction fails it and its parked waiter {ok:false}, 0 puts', async function() {
        var release, lc = lockChrome();
        // the tx a real save would get: get answers async (the put is issued from its handler), put counts
        function countTx() {
            function req(r) { Promise.resolve().then(function() { if (r.onsuccess) r.onsuccess(); }); return r; }
            return { objectStore: function() { return {
                get: function() { return req({ result: undefined }); },
                put: function() { env.puts++; return req({}); } }; } };
        }
        var env = await makeEnv({ chats: { a: { messages: [{ role: 'user', content: 'hi' }] } }, chrome: lc.chrome,
            withStore: function(fn) { return new Promise(function(res, rej) { release = function() { try { res(fn(countTx())); } catch (e) { rej(e); } }; }); } });
        env.api.hydrate(true);
        var a = env.api.save();
        var b = env.api.save(); // parks behind the in-flight save (pending-again)
        await flush();
        assert.strictEqual(env.withStoreCalls, 1);
        env.api.lockMsg(lockMsgOf(true), LOCK_OWN, function() {});
        release();
        var ra = await a;
        await flush();
        // checked before awaiting b: a re-run that reached withStore would never resolve here
        assert.strictEqual(env.withStoreCalls, 1, 'the pending-again re-run is refused before withStore');
        var rb = await b;
        assert.strictEqual(ra.ok, false); assert.match(ra.error, /locked by Delete All/);
        assert.strictEqual(rb.ok, false); assert.match(rb.error, /locked by Delete All/);
        assert.strictEqual(env.puts, 0, 'no chat row re-written');
    }, { tags: ['unit'], timeout: 5000 });

    test('TA-3: the save-lock listener takes only its own message from our own pages; unlock re-enables saves', async function() {
        var lc = lockChrome(), env = await makeEnv({ chrome: lc.chrome }), replies = [];
        function reply(r) { replies.push(r); }
        env.api.hydrate(true);
        assert.strictEqual(lc.listeners.length, 1, 'registered once');
        assert.strictEqual(lc.listeners[0], env.api.lockMsg);
        var on = lc.listeners[0];
        on(lockMsgOf(true), { url: 'https://evil.example/' }, reply);
        on(lockMsgOf(true), undefined, reply);
        on(lockMsgOf(true), { url: 'chrome-extension://abcdef/' }, reply);
        on({ type: 'claude-oauth-logout', locked: true }, LOCK_OWN, reply);
        assert.deepStrictEqual(replies, [], 'ignored: no reply');
        assert.strictEqual(env.api.wipeLocked(), false, 'ignored: not locked');
        on(lockMsgOf(true), LOCK_OWN, reply);
        assert.deepStrictEqual(replies, [{ ok: true }]);
        assert.strictEqual(env.api.wipeLocked(), true);
        var r1 = await env.api.save();
        assert.strictEqual(r1.ok, false); assert.match(r1.error, /locked by Delete All/);
        assert.strictEqual(env.withStoreCalls, 0, 'a locked save never opens a transaction');
        on(lockMsgOf(false), LOCK_OWN, reply);
        assert.deepStrictEqual(replies, [{ ok: true }, { ok: true }]);
        assert.strictEqual(env.api.wipeLocked(), false);
        assert.deepStrictEqual(await env.api.save(), { ok: true });
        assert.strictEqual(env.withStoreCalls, 1);
    }, { tags: ['unit'], timeout: 5000 });
});
