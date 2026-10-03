// Cold-chat eviction (C2 core-misc part A): tools/100-prompt-user.js and
// tools/120-actions.js on a message-evicted SKELETON chat
// ({id, _messagesEvicted, _payloadsEvicted, _msgCount}, no messages array).
// Each site must (a) not TypeError, (b) give the same answer as its hydrated
// twin, (c) fail closed — never write messages:[] over a stored transcript.
function _ccmClone(x) { return JSON.parse(JSON.stringify(x)); }
function _ccmSkeleton(id, n, extra) {
    var c = { id: id, _messagesEvicted: true, _payloadsEvicted: true, _msgCount: n };
    for (var k in (extra || {})) c[k] = extra[k];
    return c;
}
// ensureChatPayloads stub: restores IN PLACE on chats[id] from `store` (a miss
// leaves the skeleton untouched, like the real one on a failed read).
function _ccmHydrator(chats, store, calls) {
    return function(id) {
        calls.push(id);
        var c = chats[id];
        if (c && store[id]) { c.messages = _ccmClone(store[id]); delete c._messagesEvicted; delete c._payloadsEvicted; }
        return Promise.resolve();
    };
}
// Harness assert has no doesNotThrow: run fn, fail with the thrown message.
function _ccmDoesNotThrow(fn) {
    var err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err === null, 'expected no throw, got: ' + (err && (err.stack || err.message || err)));
}
async function _ccmSettle() { for (var i = 0; i < 6; i++) { await new Promise(function(r) { setTimeout(r, 0); }); } }

describe('cold-chat eviction: tools/100 prompt_user on a skeleton', function() {
    var m, g, chats, store, hydrates, saves, injected;
    beforeEach(async function() {
        chats = {}; store = {}; hydrates = []; saves = 0; injected = [];
        g = { chats: chats, activeStreamingChatId: null, currentChatId: null, currentView: 'other',
            document: { getElementById: function() { return null; }, createElement: function() { return {}; } },
            setTimeout: function() {}, saveChatsToStorage: function() { saves++; }, renderMessages: function() {}, scrollToBottomIfAllowed: function() {},
            postPromptRowToSW: function() {}, _promptResultViaSW: function() { return false; },
            recordToolResult: function(chat, tc, name, content) { injected.push([chat.id, tc, JSON.parse(content)]); },
            runAgent: function() { return Promise.resolve(); }, console: console,
            ensureChatPayloads: _ccmHydrator(chats, store, hydrates) };
        m = await loadModules(['src/js/tools/100-prompt-user.js'], { globals: g });
    });

    test('executePromptUser hydrates a skeleton and adopts the replayed pending row (same as hydrated twin)', async function() {
        var row = { role: 'prompt_user', promptId: 'p1', toolCallId: 'tc1', title: 'T', fields: [{ name: 'q', type: 'text' }], status: 'pending' };
        store.s = [{ role: 'user', content: 'go' }, row];
        chats.s = _ccmSkeleton('s', 2);
        var p = m.executePromptUser({ fields: [{ name: 'q', type: 'text' }] }, { chatId: 's', toolCallId: 'tc1' });
        await _ccmSettle();
        assert.deepStrictEqual(hydrates, ['s']);
        assert.strictEqual(chats.s.messages.length, 2, 'adopted the stored row, no duplicate push');
        assert.ok(m.pendingPromptResolvers.p1, 'resolver armed for the adopted promptId');
        m.cancelPromptUser('p1', 's');
        var r = await p;
        assert.strictEqual(r.cancelled, true);
        assert.strictEqual(chats.s.messages[1].status, 'cancelled');
    });

    test('executePromptUser fails closed when the skeleton cannot be hydrated', async function() {
        chats.s = _ccmSkeleton('s', 3);
        var r = await m.executePromptUser({ fields: [{ name: 'q', type: 'text' }] }, { chatId: 's', toolCallId: 'tc1' });
        assert.strictEqual(r.success, false);
        assert.strictEqual(chats.s.messages, undefined, 'never fabricates an empty transcript');
        assert.deepStrictEqual(Object.keys(m.pendingPromptResolvers), []);
    });

    test('cancelPromptUser on a skeleton: hydrate, then flip + inject (equals hydrated twin)', async function() {
        var msgs = [{ role: 'user', content: 'go' }, { role: 'prompt_user', promptId: 'p2', toolCallId: 'tc2', fields: [], status: 'pending' }];
        // hydrated twin: synchronous, unchanged path
        chats.h = { id: 'h', messages: _ccmClone(msgs) };
        _ccmDoesNotThrow(function() { m.cancelPromptUser('p2', 'h'); });
        assert.strictEqual(chats.h.messages[1].status, 'cancelled');
        assert.strictEqual(hydrates.length, 0, 'hydrated chat never hydrates');
        // skeleton
        store.s = _ccmClone(msgs);
        chats.s = _ccmSkeleton('s', 2);
        _ccmDoesNotThrow(function() { m.cancelPromptUser('p2', 's'); });
        await _ccmSettle();
        assert.deepStrictEqual(hydrates, ['s']);
        assert.strictEqual(chats.s.messages[1].status, 'cancelled');
        assert.deepStrictEqual(injected.map(function(x) { return x[0]; }), ['h', 's']);
    });

    test('cancelPromptUser on a skeleton whose hydrate misses: no throw, no write', async function() {
        chats.s = _ccmSkeleton('s', 2);
        var s0 = saves;
        _ccmDoesNotThrow(function() { m.cancelPromptUser('p9', 's'); });
        await _ccmSettle();
        assert.strictEqual(chats.s.messages, undefined);
        assert.strictEqual(saves, s0);
        assert.strictEqual(injected.length, 0);
    });

    test('openBackgroundPromptPopup on an unhydratable skeleton does not throw', async function() {
        chats.s = _ccmSkeleton('s', 2);
        _ccmDoesNotThrow(function() { m.openBackgroundPromptPopup('s', 'p1'); });
        await _ccmSettle();
        assert.deepStrictEqual(hydrates, ['s']);
    });

    // Microtask-only flush (no timers): enough hops for
    // Promise.resolve().then(ensure).then(done) plus the inject chain.
    async function _ccmFlush() { for (var i = 0; i < 20; i++) await Promise.resolve(); }
    function _ccmForm() { return { querySelectorAll: function() { return []; }, querySelector: function() { return null; } }; }

    test('submitPromptUser on a skeleton: hydrates once (dedupe), flips to submitted, injects exactly one result', async function() {
        store.s = [{ role: 'user', content: 'go' }, { role: 'prompt_user', promptId: 'p1', toolCallId: 'tc1', fields: [], status: 'pending' }];
        chats.s = _ccmSkeleton('s', 2);
        var r1 = m.submitPromptUser('p1', 's', _ccmForm());
        var r2 = m.submitPromptUser('p1', 's', _ccmForm());
        assert.strictEqual(r1, true);
        assert.strictEqual(r2, true, 'a second click while the hydrate is in flight is accepted, not dropped');
        await _ccmFlush();
        assert.deepStrictEqual(hydrates, ['s'], 'single-flight per prompt (_promptTailInFlight)');
        assert.strictEqual(chats.s.messages[1].status, 'submitted');
        assert.deepStrictEqual(chats.s.messages[1].values, {});
        assert.deepStrictEqual(injected, [['s', 'tc1', { success: true, values: {} }]]);
    });

    test('submitPromptUser on a skeleton whose hydrate misses: returns true, saves nothing, injects nothing', async function() {
        chats.s = _ccmSkeleton('s', 2);
        var r = m.submitPromptUser('p1', 's', _ccmForm());
        assert.strictEqual(r, true);
        await _ccmFlush();
        assert.deepStrictEqual(hydrates, ['s']);
        assert.strictEqual(chats.s.messages, undefined, 'never fabricates an empty transcript');
        assert.strictEqual(saves, 0);
        assert.strictEqual(injected.length, 0);
    });

    test('openBackgroundPromptPopup on a skeleton that hydrates re-opens the popup on the restored row', async function() {
        store.s = [{ role: 'user', content: 'go' }, { role: 'prompt_user', promptId: 'p1', toolCallId: 'tc1', fields: [], status: 'pending' }];
        chats.s = _ccmSkeleton('s', 2);
        // An already-open host for the same prompt: the re-invoked call takes
        // the refocus branch, which is only reachable after the row is found.
        var looked = [], focused = 0;
        var host = { getAttribute: function(k) { return k === 'data-prompt-id' ? 'p1' : null; },
            querySelector: function() { return { focus: function() { focused++; } }; } };
        m.__scope.document = { getElementById: function(id) { looked.push(id); return id === 'bg-popup-host' ? host : null; },
            createElement: function() { return {}; } };
        _ccmDoesNotThrow(function() { m.openBackgroundPromptPopup('s', 'p1'); });
        assert.deepStrictEqual(looked, [], 'skeleton: nothing rendered before the hydrate');
        await _ccmFlush();
        assert.deepStrictEqual(hydrates, ['s']);
        assert.deepStrictEqual(looked, ['bg-popup-host']);
        assert.strictEqual(focused, 1);
    });
});

describe('cold-chat eviction: tools/120 actions on a skeleton', function() {
    var M = null;
    async function load() {
        if (M) return M;
        var fakeDoc = { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
        M = await loadModules(['src/js/tools/120-actions.js'], { lenient: true, globals: { window: fakeWindow({ document: fakeDoc }), chrome: fakeChrome(), document: fakeDoc } });
        return M;
    }
    function reset(m, rows) {
        var s = m.__scope;
        s.chats = {};
        for (var k in m.activeActions) delete m.activeActions[k];
        s.runningChatIds = {};
        s._pendingRunAgents = {};
        s.rowReads = [];
        s.hydrates = [];
        s.saves = 0;
        s.loadChatRowFromDB = function(id) { s.rowReads.push(id); return Promise.resolve(rows[id] ? { id: id, messages: _ccmClone(rows[id]) } : null); };
        s.ensureChatPayloads = _ccmHydrator(s.chats, rows, s.hydrates);
        s.chatMessageCount = function(c) { return !c ? 0 : Array.isArray(c.messages) ? c.messages.length : (c._msgCount || 0); };
        s.persistActionState = async function() {};
        s.notifyActionStateChanged = function() {};
        s.renderJobsBadge = function() {};
        s.renderChatList = function() {};
        s.saveChatsToStorage = function() { s.saves++; };
        s.isChatActivelyRunning = function() { return false; };
        s.pendingToolApprovals = {};
        return s;
    }
    var SEED = [{ role: 'user', content: 'go' }];
    var STARTED = [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }];

    test('_chatNeverStartedAsync matches the sync result of the hydrated twin; sync path unchanged', async function() {
        var m = await load(); reset(m, { s1: SEED, s2: STARTED });
        assert.strictEqual(m._chatNeverStarted({ id: 'h1', messages: SEED }), true);
        assert.strictEqual(m._chatNeverStarted({ id: 'h2', messages: STARTED }), false);
        assert.strictEqual(m._chatNeverStarted(_ccmSkeleton('s1', 1)), false, 'sync variant keeps its exact (array-only) semantics');
        assert.strictEqual(await m._chatNeverStartedAsync(_ccmSkeleton('s1', 1)), true);
        assert.strictEqual(await m._chatNeverStartedAsync(_ccmSkeleton('s2', 2)), false);
        assert.strictEqual(await m._chatNeverStartedAsync({ id: 'h1', messages: SEED }), true);
        assert.strictEqual(await m._chatNeverStartedAsync(_ccmSkeleton('miss', 1)), false, 'row miss fails closed');
        var s = m.__scope; var before = s.rowReads.length;
        assert.strictEqual(await m._chatNeverStartedAsync(_ccmSkeleton('s1', 0)), false, 'empty count needs no read');
        assert.strictEqual(s.rowReads.length, before);
        assert.strictEqual(s.hydrates.length, 0, 'read-only: never hydrates');
    });

    test('_watchdogCheckNeverStarted flips a never-started SKELETON action chat to error', async function() {
        var m = await load(); var s = reset(m, { cs: SEED });
        s.chats.cs = _ccmSkeleton('cs', 1, { isBackground: true, actionId: 'act1' });
        m.activeActions.act1 = { state: 'running', chatId: 'cs' };
        assert.strictEqual(await m._watchdogCheckNeverStarted('act1'), true);
        assert.strictEqual(m.activeActions.act1.state, 'error');
        assert.strictEqual(s.chats.cs.messages, undefined, 'skeleton untouched');
    });

    test('getChatProgressStateFor on a skeleton fills from the stored row and equals the hydrated twin', async function() {
        var m = await load(); var s = reset(m, {});
        var msgs = [{ role: 'user', content: 'go' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'update_action_state', arguments: JSON.stringify({ state: 'running', icon: 'play', label: 'L1' }) } }] },
            { role: 'tool', tool_call_id: 't1', content: '{"success":true}' }];
        s.chats.ph = { id: 'ph', messages: _ccmClone(msgs) };
        var twin = m.getChatProgressStateFor('ph');
        assert.ok(twin && twin.label === 'L1');
        var rows = { pk: msgs };
        s.loadChatRowFromDB = function(id) { s.rowReads.push(id); return Promise.resolve(rows[id] ? { id: id, messages: _ccmClone(rows[id]) } : null); };
        s.chats.pk = _ccmSkeleton('pk', 3);
        _ccmDoesNotThrow(function() { m.getChatProgressStateFor('pk'); });
        await _ccmSettle();
        assert.deepStrictEqual(m.getChatProgressStateFor('pk'), twin);
        assert.deepStrictEqual(s.rowReads, ['pk'], 'one row read');
        assert.strictEqual(s.chats.pk.messages, undefined, 'never hydrated');
    });

    test('_jobsAllUserChats counts a skeleton by _msgCount', async function() {
        var m = await load(); var s = reset(m, {});
        s.chats.a = _ccmSkeleton('a', 4);
        s.chats.b = _ccmSkeleton('b', 0);
        s.chats.c = { id: 'c', messages: [{ role: 'user', content: 'x' }] };
        s.chats.d = { id: 'd', messages: [] };
        var ids = m._jobsAllUserChats().map(function(c) { return c.id; }).sort();
        assert.deepStrictEqual(ids, ['a', 'c']);
    });

    test('_clearChatApprovalRows on a skeleton hydrates only when the stored row has a pending approval', async function() {
        var m = await load(); var s = reset(m, {
            ap: [{ role: 'user', content: 'go' }, { role: 'approval', status: 'pending' }],
            na: [{ role: 'user', content: 'go' }] });
        s.chats.ap = _ccmSkeleton('ap', 2);
        s.chats.na = _ccmSkeleton('na', 1);
        assert.strictEqual(m._clearChatApprovalRows(s.chats.ap), false);
        assert.strictEqual(m._clearChatApprovalRows(s.chats.na), false);
        await _ccmSettle();
        assert.deepStrictEqual(s.hydrates, ['ap']);
        assert.strictEqual(s.chats.ap.messages[1].status, 'denied');
        assert.strictEqual(s.chats.na.messages, undefined);
        assert.strictEqual(s.saves, 1);
    });
});
