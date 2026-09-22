// #16 — hook gating. (a) The TL;DR hook skips plain chat answers (no tool
// calls in the turn AND answer < HOOK_TLDR_MIN_CHARS). (b) The progress nudge
// treats chat._progressCardAt (stamped by executeUpdateActionState, mirrored
// to the SW chat via the _progress_card_persist result marker) as "has a card".
describe('#16 TL;DR gating (_hkTurnNeedsTldr, worker/020-page-stubs.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/tools/020-tool-execution.js', 'src/js/worker/020-page-stubs.js'],
            { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M._hkTurnNeedsTldr, 'function', '_hkTurnNeedsTldr must exist');
        assert.strictEqual(typeof M.findHookAnswerSpan, 'function', 'real findHookAnswerSpan must be loaded');
        return M;
    }
    function chatWith(rows) { return { id: 'c1', messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }].concat(rows) }; }
    function tc(name) { return { id: 't_' + name, function: { name: name, arguments: '{}' } }; }
    test('short answer, no tool calls → false (hook skipped)', async function() {
        var m = await load();
        var chat = chatWith([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello! How can I help?' }]);
        var target = m.findHookAnswerTarget(chat, 2);
        assert.strictEqual(target.content, 'Hello! How can I help?');
        assert.strictEqual(m._hkTurnNeedsTldr(chat, 2, target), false);
        assert.strictEqual(m._hkTurnNeedsTldr(chat, undefined, target), false, 'default (unanchored) scan too');
    });
    test('long answer, no tool calls → true', async function() {
        var m = await load();
        var long = new Array(61).join('0123456789'); // 600 chars
        var chat = chatWith([{ role: 'user', content: 'explain' }, { role: 'assistant', content: long }]);
        assert.strictEqual(m.HOOK_TLDR_MIN_CHARS, 600);
        assert.strictEqual(m._hkTurnNeedsTldr(chat, 2, chat.messages[3]), true, '>= 600 chars needs a TL;DR');
        chat.messages[3].content = long.slice(0, 599);
        assert.strictEqual(m._hkTurnNeedsTldr(chat, 2, chat.messages[3]), false, '599 chars does not');
    });
    test('short answer but the turn used a real tool → true', async function() {
        var m = await load();
        var chat = chatWith([
            { role: 'user', content: 'check incidents' },
            { role: 'assistant', content: '', tool_calls: [tc('servicenow_api')] },
            { role: 'tool', content: '{}', tool_call_id: 't_servicenow_api' },
            { role: 'assistant', content: '3 open incidents.' }
        ]);
        assert.strictEqual(m._hkTurnNeedsTldr(chat, 2, chat.messages[5]), true);
    });
    test('answer-card / meta tool calls alone do not count as "used tools"', async function() {
        var m = await load();
        var chat = chatWith([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'Short reply.', tool_calls: [tc('set_chat_title'), tc('update_action_state'), tc('set_caveat')] },
            { role: 'tool', content: 'ok', tool_call_id: 't_set_chat_title' }
        ]);
        assert.strictEqual(m._hkTurnNeedsTldr(chat, 2, chat.messages[3]), false);
    });
    test('tool calls from a PREVIOUS turn do not leak into the current turn', async function() {
        var m = await load();
        var chat = chatWith([
            { role: 'user', content: 'run it' },
            { role: 'assistant', content: '', tool_calls: [tc('js_eval')] },
            { role: 'tool', content: 'ok', tool_call_id: 't_js_eval' },
            { role: 'assistant', content: 'Done.' },
            { role: 'user', content: 'thanks' },
            { role: 'assistant', content: 'You are welcome.' }
        ]);
        assert.strictEqual(m._hkTurnNeedsTldr(chat, 6, chat.messages[7]), false);
        assert.strictEqual(m._hkTurnNeedsTldr(chat, 2, chat.messages[5]), true, 'the earlier turn (anchored) still needs one');
    });
    test('fail-open: no span / no target → true (old behaviour)', async function() {
        var m = await load();
        assert.strictEqual(m._hkTurnNeedsTldr({ id: 'x', messages: [{ role: 'assistant', content: 'no user row' }] }, undefined, { content: 'x' }), true);
        assert.strictEqual(m._hkTurnNeedsTldr(chatWith([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]), 2, null), true);
    });
    test('wiring: executeAfterResponseHooks consults the gate before needsTldr; loop honours _progressCardAt', async function() {
        var stubs = await loadFile('src/js/worker/020-page-stubs.js');
        var gateIdx = stubs.indexOf('!_hkTurnNeedsTldr(chat, _hkAnchor, tldrTarget)) tldrTarget = null;');
        var needsIdx = stubs.indexOf('needsTldr = true;');
        assert.ok(gateIdx > -1 && needsIdx > gateIdx, 'gate must run before needsTldr is set');
        var loop = await loadFile('src/js/app/030-agent-loop.js');
        assert.ok(/PROGRESS_NUDGE_TOOL_CALLS > 0 && !chat\._progressCardAt\) \{/.test(loop), 'progress nudge block must be skipped when chat._progressCardAt is set');
        var routing = await loadFile('src/js/worker/120-tool-routing.js');
        assert.ok(/chats\[chatId\]\._progressCardAt = result\._progress_card_persist;/.test(routing), 'SW routing must mirror the stamp');
        assert.ok(/delete result\._progress_card_persist;/.test(routing), 'SW routing must strip the marker');
        assert.ok(/_resetProgressCardStampForTurn\(chat, lastUserMsgIndex\);/.test(loop), 'run start must re-scope the stamp to the current turn');
    });
});

// R3 SHOULD-FIX-2: the stamp is scoped to the ORGANIC user turn it was taken
// under — a card from an earlier turn must not silence the nudge forever.
describe('#16 progress-card stamp is per-turn (_resetProgressCardStampForTurn, app/030-agent-loop.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M._resetProgressCardStampForTurn, 'function', '_resetProgressCardStampForTurn must exist');
        assert.strictEqual(typeof M._progressCardTurnKey, 'function', '_progressCardTurnKey must exist');
        return M;
    }
    function lastUser(chat) { for (var i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === 'user') return i; return -1; }
    test('nudge fires again on a later turn: stamp from turn 1 is cleared when a run starts on turn 2', async function() {
        var m = await load();
        var chat = { id: 'c1', messages: [{ role: 'user', content: 'turn 1' }] };
        m._resetProgressCardStampForTurn(chat, lastUser(chat));
        assert.strictEqual(chat._progressCardTurn, 0);
        assert.ok(!chat._progressCardAt, 'no card yet');
        chat._progressCardAt = 1700000000000; // card created during turn 1 (executeUpdateActionState)
        // Same-turn resume (SW restart / page reload): stamp survives.
        chat.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'update_action_state', arguments: '{}' } }] });
        assert.strictEqual(m._resetProgressCardStampForTurn(chat, lastUser(chat)), false, 'same organic turn → not cleared');
        assert.strictEqual(chat._progressCardAt, 1700000000000);
        // Injected user-role row (sub-agent report / wake notice) continues the organic turn.
        chat.messages.push({ role: 'user', content: '[sub report]', injected: true });
        assert.strictEqual(m._progressCardTurnKey(chat, lastUser(chat)), 0, 'injected rows do not start a new turn');
        assert.strictEqual(m._resetProgressCardStampForTurn(chat, lastUser(chat)), false);
        assert.strictEqual(chat._progressCardAt, 1700000000000, 'still silenced within the same organic turn');
        // A NEW organic user message → new turn → stamp cleared → the gate
        // `!chat._progressCardAt` in the loop is open again.
        chat.messages.push({ role: 'assistant', content: 'done' });
        chat.messages.push({ role: 'user', content: 'turn 2' });
        assert.strictEqual(m._resetProgressCardStampForTurn(chat, lastUser(chat)), true, 'stale stamp cleared');
        assert.strictEqual(chat._progressCardAt, null);
        assert.strictEqual(chat._progressCardTurn, 4);
    });
    test('_progressCardTurnKey: falls back to lastUserMsgIndex when every user row is injected / none exists', async function() {
        var m = await load();
        assert.strictEqual(m._progressCardTurnKey({ messages: [{ role: 'user', content: 'x', injected: true }] }, 0), 0);
        assert.strictEqual(m._progressCardTurnKey({ messages: [] }, -1), -1);
        assert.strictEqual(m._progressCardTurnKey({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c', injected: true }] }, 2), 0);
    });
});

describe('#16 executeUpdateActionState stamps _progressCardAt (tools/120-actions.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        var fakeDoc = { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
        M = await loadModules(['src/js/tools/120-actions.js'], { lenient: true, globals: { window: fakeWindow({ document: fakeDoc }), chrome: fakeChrome(), document: fakeDoc } });
        assert.strictEqual(typeof M.executeUpdateActionState, 'function');
        M.__scope.chats = {};
        M.__scope.activeActions = {};
        M.__scope.AgentEvents = { emit: function() {} };
        M.__scope.SubAgents = undefined;
        M.__scope.activeStreamingChatId = null;
        M.__scope.currentChatId = null;
        M.__scope.saveChatsToStorage = function() {};
        M.__scope.updateChatTitleHeader = undefined;
        M.__scope._refreshOpenChatProgressPopover = function() {};
        return M;
    }
    test('foreground chat: stamps the page chat and carries _progress_card_persist on the result', async function() {
        var m = await load();
        m.__scope.chats.c1 = { id: 'c1', messages: [] };
        var before = Date.now();
        var res = await m.executeUpdateActionState({ state: 'running', icon: 'code', label: 'x' }, { chatId: 'c1' });
        assert.strictEqual(res.success, true);
        assert.ok(typeof res._progress_card_persist === 'number' && res._progress_card_persist >= before, 'marker carries the stamp');
        assert.strictEqual(m.__scope.chats.c1._progressCardAt, res._progress_card_persist);
        assert.strictEqual(res._sub_action_state, undefined, 'not a sub-agent chat');
    });
    test('invalid state: no stamp, error unchanged', async function() {
        var m = await load();
        m.__scope.chats.c2 = { id: 'c2', messages: [] };
        var res = await m.executeUpdateActionState({ state: 'bogus' }, { chatId: 'c2' });
        assert.strictEqual(res.success, false);
        assert.ok(/Invalid state/.test(res.error));
        assert.strictEqual(m.__scope.chats.c2._progressCardAt, undefined, 'a rejected update must not count as a card');
    });
    test('no chat: unchanged error', async function() {
        var m = await load();
        var res = await m.executeUpdateActionState({ state: 'running' }, { chatId: 'nope' });
        assert.strictEqual(res.success, false);
    });
    test('background chat whose action is gone: "Active action not found" → NO stamp, no marker (R3 SHOULD-FIX-2)', async function() {
        var m = await load();
        m.__scope.chats.c3 = { id: 'c3', messages: [], isBackground: true, actionId: 'act_missing' };
        var res = await m.executeUpdateActionState({ state: 'running', icon: 'code', label: 'x' }, { chatId: 'c3' });
        assert.strictEqual(res.success, false);
        assert.ok(/Active action not found/.test(res.error));
        assert.strictEqual(m.__scope.chats.c3._progressCardAt, undefined, 'a rejected update must not count as a card');
        assert.strictEqual(res._progress_card_persist, undefined, 'no marker for the SW to mirror');
    });
    test('background chat with a live action: stamped only after the action was updated', async function() {
        var m = await load();
        m.__scope.chats.c4 = { id: 'c4', messages: [], isBackground: true, actionId: 'act_live' };
        m.__scope.activeActions.act_live = { id: 'act_live', state: 'running', tasks: null };
        m.__scope.persistActionState = async function() {};
        m.__scope.notifyActionStateChanged = function() {};
        m.__scope.isTerminalProgressState = function(s) { return ['done', 'error', 'finished', 'pr_opened', 'finished_with_caveat'].indexOf(s) >= 0; };
        var res = await m.executeUpdateActionState({ state: 'running', icon: 'code', label: 'y' }, { chatId: 'c4' });
        assert.strictEqual(res.success, true, res.error);
        assert.strictEqual(m.__scope.activeActions.act_live.label, 'y');
        assert.ok(typeof res._progress_card_persist === 'number');
        assert.strictEqual(m.__scope.chats.c4._progressCardAt, res._progress_card_persist);
    });
});
