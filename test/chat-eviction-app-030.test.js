// C2 (cold-chat eviction) — app/030-agent-loop.js consumers.
// A: runAgent entry hydrates a message-evicted skeleton (not only
//    _payloadsEvicted) and fails closed BEFORE runStarted on a hydrate miss.
// B: recordToolResult's same-length in-place rewrite clears the durability
//    proof (unmarkChatMessagesDurable) so the sweep cannot evict it unsaved.
// C: sweepStrandedPlaceholders hands skeletons to sweepStrandedSkeletons,
//    which reads the stored row read-only, hydrates only chats that really
//    hold a stranded placeholder, and never rewrites/saves a skeleton.
describe('C2 chat eviction: app/030 agent loop', function() {
    var M = null;
    var SENTINEL = 'stop-after-entry';
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M.runAgent, 'function');
        assert.strictEqual(typeof M.sweepStrandedPlaceholders, 'function');
        assert.strictEqual(typeof M.sweepStrandedSkeletons, 'function');
        return M;
    }
    function hydratedRows() {
        return [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', tool_calls: [
                { id: 't1', type: 'function', function: { name: 'js_eval', arguments: '{}' } },
                { id: 't2', type: 'function', function: { name: 'workspace', arguments: '{}' } }
            ] },
            { role: 'tool', tool_call_id: 't1', name: 'js_eval', content: '[Tool call pending]', _placeholder: true },
            { role: 'tool', tool_call_id: 't2', name: 'workspace', content: '[Tool call pending]', _placeholder: true }
        ];
    }
    function skeleton(id, extra) {
        return Object.assign({ id: id, _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 4 }, extra || {});
    }
    // opts: { stored: {id: row}, restore: bool, running, emitThrows }
    function reset(m, opts) {
        opts = opts || {};
        var s = m.__scope;
        s.chats = {};
        s.currentChatId = null;
        s.runningChatIds = opts.running || {};
        s._runCleanupGuard = {};
        s.lastApiError = null;
        s.saveCalls = 0;
        s.saveChatsToStorage = function() { s.saveCalls++; return Promise.resolve(); };
        s.emits = [];
        s.AgentEvents = { emit: function(type, detail) {
            s.emits.push({ type: type, detail: detail });
            if (type === 'runStarted') throw new Error(SENTINEL);
        } };
        s._chatDeltaSync = {};
        s.SubAgents = { getByChatId: function() { return null; } };
        s.pausedChats = undefined;
        s._pausedByParentChat = undefined;
        s.reads = [];
        s.hydrates = [];
        s.unmarks = 0;
        s.unmarkChatMessagesDurable = function() { s.unmarks++; return true; };
        s.loadChatRowFromDB = function(id) {
            s.reads.push(id);
            return Promise.resolve(opts.stored && opts.stored[id] ? opts.stored[id] : null);
        };
        s.ensureChatPayloads = function(id) {
            s.hydrates.push(id);
            var c = s.chats[id];
            if (c && opts.restore !== false && opts.stored && opts.stored[id]) {
                c.messages = JSON.parse(JSON.stringify(opts.stored[id].messages));
                delete c._messagesEvicted; delete c._msgCount; delete c._payloadsEvicted;
            }
            return Promise.resolve();
        };
        m.sweepStrandedPlaceholders.skeletonPass = undefined;
        return s;
    }
    function types(s) { return s.emits.map(function(e) { return e.type; }); }

    test('A1 skeleton restored at the entry: the loop sees the real transcript (reaches runStarted)', async function() {
        var m = await load(); var s = reset(m, { stored: { c1: { id: 'c1', messages: hydratedRows() } } });
        s.chats.c1 = skeleton('c1');
        var err = null;
        try { await m.runAgent('c1'); } catch (e) { err = e; }
        assert.ok(err && err.message === SENTINEL, String(err && err.message));
        assert.deepStrictEqual(s.hydrates, ['c1']);
        assert.ok(Array.isArray(s.chats.c1.messages) && s.chats.c1.messages.length === 4);
        assert.deepStrictEqual(types(s), ['runStarted', 'runCrashed']);
        assert.strictEqual(s.runningChatIds.c1, undefined, 'running flag cleared');
    });
    test('A2 hydrate miss fails closed BEFORE runStarted with a clear error; no transcript invented', async function() {
        var m = await load(); var s = reset(m, { restore: false, stored: { c1: { id: 'c1', messages: hydratedRows() } } });
        s.chats.c1 = skeleton('c1');
        var err = null;
        try { await m.runAgent('c1'); } catch (e) { err = e; }
        assert.ok(err && /transcript is evicted and could not be restored/.test(err.message), String(err && err.message));
        assert.ok(!(err instanceof TypeError));
        assert.strictEqual(s.chats.c1.messages, undefined, 'skeleton not given an empty array');
        assert.strictEqual(s.chats.c1._messagesEvicted, true);
        assert.deepStrictEqual(types(s), ['runCrashed'], 'no runStarted (checkpoint poison guard)');
        assert.strictEqual(s.runningChatIds.c1, undefined);
        assert.strictEqual(s.saveCalls, 0);
    });
    test('A3 hydrated chat (flag-off shape): no hydrate call, unchanged entry', async function() {
        var m = await load(); var s = reset(m);
        s.chats.c1 = { id: 'c1', messages: hydratedRows() };
        var err = null;
        try { await m.runAgent('c1'); } catch (e) { err = e; }
        assert.ok(err && err.message === SENTINEL);
        assert.deepStrictEqual(s.hydrates, []);
        assert.deepStrictEqual(types(s), ['runStarted', 'runCrashed']);
    });
    function deferred() { var d = {}; d.promise = new Promise(function(resolve, reject) { d.resolve = resolve; d.reject = reject; }); return d; }
    test('A4 hydration rejection is translated to the restoration error and emits only runCrashed', async function() {
        var m = await load(), s = reset(m), entered = deferred(), gate = deferred();
        s.chats.c1 = skeleton('c1');
        s.ensureChatPayloads = function(id) { s.hydrates.push(id); entered.resolve(); return gate.promise; };
        var outcome = m.runAgent('c1').then(function() { return null; }, function(e) { return e.message; });
        await entered.promise;
        assert.deepStrictEqual(types(s), []);
        gate.reject(new Error('idb boom'));
        assert.strictEqual(await outcome, 'runAgent: chat c1 transcript is evicted and could not be restored — refusing to start');
        assert.deepStrictEqual(s.hydrates, ['c1']);
        assert.deepStrictEqual(types(s), ['runCrashed']);
        assert.strictEqual(s.runningChatIds.c1, undefined);
        assert.strictEqual(s.chats.c1.messages, undefined);
        assert.strictEqual(s.saveCalls, 0);
    });
    test('A5 a replacement tombstone after hydration fails closed before runStarted', async function() {
        var m = await load(), s = reset(m), entered = deferred(), gate = deferred();
        s.chats.c1 = skeleton('c1');
        s.ensureChatPayloads = function(id) { s.hydrates.push(id); entered.resolve(); return gate.promise; };
        var outcome = m.runAgent('c1').then(function() { return null; }, function(e) { return e.message; });
        await entered.promise;
        assert.deepStrictEqual(types(s), []);
        s.chats.c1 = { id: 'c1', _deleted: true, messages: [] };
        gate.resolve();
        assert.strictEqual(await outcome, 'runAgent: chat c1 is deleted (tombstone) — refusing to start');
        assert.deepStrictEqual(s.hydrates, ['c1']);
        assert.deepStrictEqual(types(s), ['runCrashed']);
        assert.strictEqual(s.runningChatIds.c1, undefined);
        assert.strictEqual(s.saveCalls, 0);
    });
    test('B recordToolResult: in-place rewrite clears the durability proof; skeleton is a no-op', async function() {
        var m = await load(); var s = reset(m);
        var chat = { id: 'c1', messages: hydratedRows() };
        var row = m.recordToolResult(chat, 't1', 'js_eval', 'ok');
        assert.ok(row && row.content === 'ok' && row._placeholder === undefined);
        assert.strictEqual(chat.messages.length, 4);
        assert.strictEqual(s.unmarks, 1);
        assert.strictEqual(m.recordToolResult(skeleton('c2'), 't1', 'js_eval', 'ok'), null);
    });
    test('C1 sweep: skeleton with a stranded tail is read, hydrated, rewritten, saved and broadcast', async function() {
        var m = await load(); var s = reset(m, { stored: { c1: { id: 'c1', messages: hydratedRows() } } });
        s.chats.c1 = skeleton('c1');
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 0, 'sync pass leaves skeletons to the async pass');
        assert.strictEqual(s.saveCalls, 0);
        var n = await m.sweepStrandedPlaceholders.skeletonPass;
        assert.strictEqual(n, 2);
        assert.deepStrictEqual(s.reads, ['c1']);
        assert.deepStrictEqual(s.hydrates, ['c1']);
        var tools = s.chats.c1.messages.filter(function(r) { return r.role === 'tool'; });
        assert.strictEqual(tools.length, 2);
        tools.forEach(function(r) {
            assert.strictEqual(r._placeholder, undefined);
            assert.strictEqual(JSON.parse(r.content).code, 'runtime_restarted');
        });
        assert.strictEqual(s.saveCalls, 1);
        assert.deepStrictEqual(s.emits.map(function(e) { return e.detail.chatId; }), ['c1']);
    });
    test('C2 sweep: skeleton with no stranded tail is never hydrated', async function() {
        var rows = hydratedRows().slice(0, 2).concat([{ role: 'tool', tool_call_id: 't1', name: 'js_eval', content: 'real' }]);
        var m = await load(); var s = reset(m, { stored: { c1: { id: 'c1', messages: rows } } });
        s.chats.c1 = skeleton('c1');
        m.sweepStrandedPlaceholders({});
        assert.strictEqual(await m.sweepStrandedPlaceholders.skeletonPass, 0);
        assert.deepStrictEqual(s.reads, ['c1']);
        assert.deepStrictEqual(s.hydrates, []);
        assert.strictEqual(s.chats.c1.messages, undefined);
        assert.strictEqual(s.saveCalls, 0);
    });
    test('C3 sweep: hydrate miss / row miss leave the skeleton untouched and unsaved', async function() {
        var m = await load(); var s = reset(m, { restore: false, stored: { c1: { id: 'c1', messages: hydratedRows() } } });
        s.chats.c1 = skeleton('c1');
        s.chats.c2 = skeleton('c2'); // no stored row
        m.sweepStrandedPlaceholders({});
        assert.strictEqual(await m.sweepStrandedPlaceholders.skeletonPass, 0);
        assert.deepStrictEqual(s.hydrates, ['c1']);
        assert.strictEqual(s.chats.c1.messages, undefined);
        assert.strictEqual(s.chats.c2.messages, undefined);
        assert.strictEqual(s.saveCalls, 0);
        assert.strictEqual(s.emits.length, 0);
    });
    test('C4 sweep: resumed / running / paused / deleted / empty skeletons are skipped without a read', async function() {
        var m = await load(); var s = reset(m, { running: { c2: true }, stored: {
            c1: { id: 'c1', messages: hydratedRows() }, c2: { id: 'c2', messages: hydratedRows() },
            c3: { id: 'c3', messages: hydratedRows() }, c4: { id: 'c4', messages: hydratedRows() } } });
        s.chats.c1 = skeleton('c1');
        s.chats.c2 = skeleton('c2');
        s.chats.c3 = skeleton('c3', { pausedByUser: true });
        s.chats.c4 = skeleton('c4', { _deleted: true });
        s.chats.c5 = skeleton('c5', { _msgCount: 0 });
        m.sweepStrandedPlaceholders({ c1: true });
        var n = await (m.sweepStrandedPlaceholders.skeletonPass || Promise.resolve(0));
        assert.strictEqual(n, 0);
        assert.deepStrictEqual(s.reads, []);
        assert.deepStrictEqual(s.hydrates, []);
    });
    test('C5 no skeletons (flag-off shape): no async pass is started', async function() {
        var m = await load(); var s = reset(m);
        s.chats.c1 = { id: 'c1', messages: hydratedRows() };
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 2);
        assert.strictEqual(m.sweepStrandedPlaceholders.skeletonPass, undefined);
        assert.deepStrictEqual(s.reads, []);
    });
});
