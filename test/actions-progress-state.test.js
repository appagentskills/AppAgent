// H19a / H19b / M4 — progress-state derivation (tools/120-actions.js) and the
// SW autoProgress finalize hook (worker/020-page-stubs.js).
// Real source via loadModules; stubs only for externals (DOM, chrome, storage,
// runAgent, answer-target lookup).
function fakeDocument() {
    return { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
}
var _M = null;
async function loadActions() {
    if (_M) return _M;
    var doc = fakeDocument();
    _M = await loadModules(['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/tools/120-actions.js'],
        { lenient: true, globals: { window: fakeWindow({ document: doc }), chrome: fakeChrome(), document: doc } });
    _M.__scope.chats = {};
    _M.__scope.activeActions = {};
    _M.__scope.AgentEvents = { emit: function() {} };
    _M.__scope.SubAgents = undefined;
    _M.__scope.activeStreamingChatId = null;
    _M.__scope.currentChatId = null;
    _M.__scope.saveChatsToStorage = function() {};
    _M.__scope.formatContent = undefined;
    return _M;
}
function uasCall(id, args) {
    return { id: id, type: 'function', function: { name: 'update_action_state', arguments: JSON.stringify(args) } };
}

describe('H19a rejected update_action_state never renders as the card state', function() {
    test('a {success:false} result is skipped by getChatProgressStateFor (old code: returned the rejected DONE)', async function() {
        var m = await loadActions();
        m.__scope.chats.r1 = { id: 'r1', messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', tool_calls: [uasCall('t1', { state: 'done', label: 'Finished!' })] },
            { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ success: false, error: "Cannot set terminal state 'done': 1 sub-agent(s) still running (x)." }) }
        ] };
        assert.strictEqual(m.getChatProgressStateFor('r1'), null);
        assert.strictEqual(m.renderActionUpdatesSection(m.__scope.chats.r1), '');
    });
    test('falls back to the previous successful update; non-JSON results still count as executed', async function() {
        var m = await loadActions();
        m.__scope.chats.r2 = { id: 'r2', messages: [
            { role: 'assistant', content: '', tool_calls: [uasCall('a', { state: 'running', label: 'Working' })] },
            { role: 'tool', tool_call_id: 'a', content: 'ok (legacy plain-text result)' },
            { role: 'assistant', content: '', tool_calls: [uasCall('b', { state: 'done', label: 'Done?' })] },
            { role: 'tool', tool_call_id: 'b', content: '  {"success": false, "error": "rejected"}' }
        ] };
        var st = m.getChatProgressStateFor('r2');
        assert.ok(st, 'previous update still visible');
        assert.strictEqual(st.state, 'running');
        assert.strictEqual(st.label, 'Working');
        assert.strictEqual(m.progressToolResultFailed('{"success":true}'), false);
        assert.strictEqual(m.progressToolResultFailed('not json {'), false);
        assert.strictEqual(m.progressToolResultFailed([{ type: 'text', text: '{"success":false}' }]), true);
    });
    test('seeded _placeholder rows are not results', async function() {
        var m = await loadActions();
        m.__scope.chats.r3 = { id: 'r3', messages: [
            { role: 'assistant', content: '', tool_calls: [uasCall('p', { state: 'done' })] },
            { role: 'tool', tool_call_id: 'p', content: '[Tool call pending — agent runtime restarted before result]', _placeholder: true }
        ] };
        assert.strictEqual(m.getChatProgressStateFor('r3'), null);
        assert.strictEqual(m.getChatProgressStateFor('r3', 'p').state, 'done', 'includeToolCallId still marks the in-flight call');
    });
});

describe('H19b null task entries never break the renderers', function() {
    test('tasks:[null, …] → renderActionUpdatesSection returns a string (old code: TypeError on t.status)', async function() {
        var m = await loadActions();
        var chat = { id: 'n1', messages: [
            { role: 'assistant', content: '', tool_calls: [uasCall('n', { state: 'running', label: 'L', tasks: [null, 5, 'x', { label: 'Real', status: 'done' }, { label: 'Odd', status: 'weird' }] })] },
            { role: 'tool', tool_call_id: 'n', content: '{"success":true}' }
        ] };
        m.__scope.chats.n1 = chat;
        var html = m.renderActionUpdatesSection(chat);
        assert.strictEqual(typeof html, 'string');
        assert.match(html, /Real/);
        var st = m.getChatProgressStateFor('n1');
        assert.deepStrictEqual(st.tasks, [{ label: 'Real', status: 'done' }, { label: 'Odd', status: 'pending' }]);
    });
    test('normalizeProgressTasks: non-array → null, cap 20, label coerced', async function() {
        var m = await loadActions();
        assert.strictEqual(m.normalizeProgressTasks(undefined), null);
        assert.strictEqual(m.normalizeProgressTasks({}), null);
        var many = []; for (var i = 0; i < 30; i++) many.push({ label: i, status: 'done' });
        var out = m.normalizeProgressTasks(many);
        assert.strictEqual(out.length, 20);
        assert.strictEqual(out[3].label, '3');
    });
});

describe('M4 a stopped action is not revived by a late update_action_state', function() {
    test('non-terminal update after Stop is rejected without mutating (old code: a.state overwritten to running)', async function() {
        var m = await loadActions();
        m.__scope.chats.s1 = { id: 's1', messages: [], isBackground: true, actionId: 'act_s' };
        m.__scope.activeActions.act_s = { actionId: 'act_s', chatId: 's1', state: 'stopped', icon: 'stop', label: 'Stopped', tasks: null };
        var res = await m.executeUpdateActionState({ state: 'running', icon: 'code', label: 'Still going' }, { chatId: 's1' });
        assert.strictEqual(res.success, false);
        assert.match(res.error, /stopped by the user/);
        var a = m.__scope.activeActions.act_s;
        assert.strictEqual(a.state, 'stopped');
        assert.strictEqual(a.label, 'Stopped');
        assert.strictEqual(a.icon, 'stop');
        assert.strictEqual(m.__scope.chats.s1._progressCardAt, undefined, 'rejected update is not a card');
    });
    test('stopped + chat STILL paused → late non-terminal update rejected', async function() {
        var m = await loadActions();
        var prev = m.__scope.isChatPaused;
        m.__scope.isChatPaused = function(id) { return id === 's2'; };
        try {
            m.__scope.chats.s2 = { id: 's2', messages: [], isBackground: true, actionId: 'act_s2' };
            m.__scope.activeActions.act_s2 = { actionId: 'act_s2', chatId: 's2', state: 'stopped', icon: 'stop', label: 'Stopped', tasks: null };
            var res = await m.executeUpdateActionState({ state: 'running', icon: 'code', label: 'Late' }, { chatId: 's2' });
            assert.strictEqual(res.success, false);
            assert.match(res.error, /stopped by the user/);
            assert.strictEqual(m.__scope.activeActions.act_s2.state, 'stopped');
        } finally { m.__scope.isChatPaused = prev; }
    });
    test('stopped + pause CLEARED (user resumed) → running is accepted (old code: rejected forever)', async function() {
        var m = await loadActions();
        var prev = m.__scope.isChatPaused;
        m.__scope.isChatPaused = function() { return false; };
        try {
            m.__scope.chats.s3 = { id: 's3', messages: [], isBackground: true, actionId: 'act_s3' };
            m.__scope.activeActions.act_s3 = { actionId: 'act_s3', chatId: 's3', state: 'stopped', icon: 'stop', label: 'Stopped', tasks: null };
            var res = await m.executeUpdateActionState({ state: 'running', icon: 'code', label: 'Resumed' }, { chatId: 's3' });
            assert.notStrictEqual(res.success, false, 'accepted: ' + JSON.stringify(res));
            var a = m.__scope.activeActions.act_s3;
            assert.strictEqual(a.state, 'running');
            assert.strictEqual(a.label, 'Resumed');
            assert.strictEqual(a.icon, 'code');
        } finally { m.__scope.isChatPaused = prev; }
    });
});

describe('H19a SW autoProgress hook ignores a rejected terminal update', function() {
    test('rejected done → finalize nudge still fires (old code: treated as final, no run)', async function() {
        var ran = [];
        var target = { role: 'assistant', content: 'final answer' };
        var chat = { id: 'h1', messages: [
            { role: 'user', content: 'do it' },
            { role: 'assistant', content: '', tool_calls: [uasCall('u1', { state: 'running' })] },
            { role: 'tool', tool_call_id: 'u1', content: '{"success":true}' },
            { role: 'assistant', content: '', tool_calls: [uasCall('u2', { state: 'done' })] },
            { role: 'tool', tool_call_id: 'u2', content: '{"success":false,"error":"subs running"}' },
            target
        ] };
        var m = await loadModules(['src/js/worker/020-page-stubs.js'], { lenient: true, globals: {
            chats: { h1: chat },
            hooksEnabled: { autoProgress: true, showHookMessages: true },
            findHookAnswerTarget: function() { return target; },
            mergeChatAutoLinks: function() { return false; },
            relocateAnswerCard: function() { return false; },
            saveChatsToStorage: function() {},
            runAgent: function(id) { ran.push(id); },
            AgentEvents: { emit: function() {} }
        } });
        m.executeAfterResponseHooks('h1');
        assert.deepStrictEqual(ran, ['h1'], 'hook run started');
        var last = chat.messages[chat.messages.length - 1];
        assert.strictEqual(last.isHookMessage, true);
        assert.match(last.content, /finalize the chat progress card/);
    });
    test('an ACCEPTED done still suppresses the nudge (no regression)', async function() {
        var ran = [];
        var target = { role: 'assistant', content: 'final answer' };
        var chat = { id: 'h2', messages: [
            { role: 'user', content: 'do it' },
            { role: 'assistant', content: '', tool_calls: [uasCall('v1', { state: 'done' })] },
            { role: 'tool', tool_call_id: 'v1', content: '{"success":true}' },
            target
        ] };
        var m = await loadModules(['src/js/worker/020-page-stubs.js'], { lenient: true, globals: {
            chats: { h2: chat },
            hooksEnabled: { autoProgress: true, showHookMessages: true },
            findHookAnswerTarget: function() { return target; },
            mergeChatAutoLinks: function() { return false; },
            relocateAnswerCard: function() { return false; },
            saveChatsToStorage: function() {},
            runAgent: function(id) { ran.push(id); },
            AgentEvents: { emit: function() {} }
        } });
        m.executeAfterResponseHooks('h2');
        assert.deepStrictEqual(ran, []);
    });
});
