// #18 — prompt_user continuity. A chat message typed while a prompt_user
// question is pending is the ANSWER to that question, not an interrupt: the
// SW settles the pending prompt with {success:true, answered_via_chat:true,
// text} (via the existing _swSettleRemotePrompt lane) instead of setting
// userInterruptedChats / firing the interrupt resolver / aborting the stream.
describe('#18 _swAnswerPendingPromptViaChat (worker/120-tool-routing.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/worker/120-tool-routing.js'],
            { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M._swAnswerPendingPromptViaChat, 'function', '_swAnswerPendingPromptViaChat must exist');
        assert.strictEqual(typeof M._swSettleRemotePrompt, 'function', 'real _swSettleRemotePrompt must be loaded');
        return M;
    }
    function arm(m, rows, opts) {
        opts = opts || {};
        var events = [];
        m.__scope.chats = { c1: { id: 'c1', messages: rows } };
        m.__scope.saveChatsToStorage = function() { events.push('save'); };
        m.__scope.AgentEvents = { emit: function(n, p) { events.push(n); } };
        m.__scope.parkedToolCallsByChatId = opts.parked || {};
        // reset the module-level pending map in place (it is a `var` in the module scope)
        var pend = m._pendingUIToolCalls;
        Object.keys(pend).forEach(function(k) { delete pend[k]; });
        if (opts.pending) Object.keys(opts.pending).forEach(function(k) { pend[k] = opts.pending[k]; });
        return events;
    }
    function promptRow(status, tcId) { return { role: 'prompt_user', promptId: 'p_' + tcId, toolCallId: tcId, status: status, prompts: [{ fields: [{ name: 'q', type: 'text', label: 'Q?' }] }] }; }

    test('pending + tracked (_pendingUIToolCalls, no port) → settled with answered_via_chat, row submitted, returns true', async function() {
        var m = await load();
        var got = null;
        var events = arm(m, [{ role: 'user', content: 'do X' }, promptRow('pending', 'tc1')],
            { pending: { tc1: { resolve: function(r) { got = r; }, reject: function() {}, name: 'prompt_user' } } });
        var ok = m._swAnswerPendingPromptViaChat('c1', '  yes, go ahead  ');
        assert.strictEqual(ok, true);
        assert.ok(got, 'pending resolve must have been called');
        assert.strictEqual(got.success, true);
        assert.strictEqual(got.answered_via_chat, true);
        assert.strictEqual(got.text, 'yes, go ahead', 'text is trimmed');
        var row = m.__scope.chats.c1.messages[1];
        assert.strictEqual(row.status, 'submitted');
        assert.strictEqual(row.answered_via_chat, true);
        assert.strictEqual(m._pendingUIToolCalls.tc1, undefined, 'pending entry consumed');
        assert.ok(events.indexOf('messagesAppended') >= 0, 'panels reconcile via messagesAppended');
        assert.ok(events.indexOf('save') >= 0, 'chat persisted');
    });
    test('pending + PARKED entry (executor panel gone) → parked resolve consumed, returns true', async function() {
        var m = await load();
        var got = null;
        var parked = { c1: [{ toolCallId: 'tc2', name: 'prompt_user', resolve: function(r) { got = r; }, reject: function() {} }] };
        arm(m, [promptRow('pending', 'tc2')], { parked: parked });
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', 'blue'), true);
        assert.ok(got && got.answered_via_chat === true && got.text === 'blue');
        assert.strictEqual(parked.c1.length, 0, 'parked entry consumed');
    });
    test('last prompt row already submitted → false (falls back to the interrupt)', async function() {
        var m = await load();
        var resolved = false;
        arm(m, [promptRow('submitted', 'tc3')], { pending: { tc3: { resolve: function() { resolved = true; }, reject: function() {} } } });
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', 'hello'), false);
        assert.strictEqual(resolved, false);
    });
    test('no prompt_user row at all → false; unknown chat → false', async function() {
        var m = await load();
        arm(m, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]);
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', 'hello'), false);
        assert.strictEqual(m._swAnswerPendingPromptViaChat('nope', 'hello'), false);
    });
    test('empty / whitespace-only / non-string text → false, row stays pending', async function() {
        var m = await load();
        arm(m, [promptRow('pending', 'tc4')], { pending: { tc4: { resolve: function() {}, reject: function() {} } } });
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', ''), false);
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', '   \n'), false);
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', null), false);
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', undefined), false);
        assert.strictEqual(m.__scope.chats.c1.messages[0].status, 'pending');
    });
    test('pending row but UNTRACKED toolCallId (no pending/parked entry) → false, row stays pending', async function() {
        var m = await load();
        arm(m, [promptRow('pending', 'tc5')]);
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', 'answer'), false);
        assert.strictEqual(m.__scope.chats.c1.messages[0].status, 'pending');
        var legacy = arm(m, [{ role: 'prompt_user', promptId: 'p_x', toolCallId: null, status: 'pending' }]);
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', 'answer'), false, 'legacy row without toolCallId is untracked');
    });
    test('older pending row shadowed by a NEWER submitted row → false (only the LAST prompt row counts)', async function() {
        var m = await load();
        arm(m, [promptRow('pending', 'tc6'), promptRow('submitted', 'tc7')], { pending: { tc6: { resolve: function() {}, reject: function() {} } } });
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', 'answer'), false);
    });
    test('wiring: SW send-message running branch consults the fast path BEFORE marking the interrupt', async function() {
        var bridge = await loadFile('src/js/worker/130-port-bridge.js');
        var fnStart = bridge.indexOf('function _handlePanelSendMessage(');
        assert.ok(fnStart > 0, '_handlePanelSendMessage must exist');
        var body = bridge.slice(fnStart);
        var fast = body.indexOf('_swAnswerPendingPromptViaChat(chatId, msg.text)');
        var mark = body.indexOf('userInterruptedChats[chatId] = true');
        assert.ok(fast > 0, 'fast path must be called in _handlePanelSendMessage');
        assert.ok(mark > 0 && fast < mark, 'fast path must run before userInterruptedChats[chatId] = true');
        var routing = await loadFile('src/js/worker/120-tool-routing.js');
        assert.ok(/function _swAnswerPendingPromptViaChat\(chatId, text\)/.test(routing));
    });
    test('wiring: agent-loop abandoned branch gives prompt_user an answered_via_chat placeholder; page send has the cosmetic fast path', async function() {
        var loop = await loadFile('src/js/app/030-agent-loop.js');
        var i = loop.indexOf('for (var ri2 = i; !_btPaused');
        assert.ok(i > 0, 'abandoned-calls loop must still exist');
        var seg = loop.slice(i, i + 3200);
        assert.ok(/_wasUserMessage && rtc2\.function && rtc2\.function\.name === 'prompt_user'/.test(seg), 'prompt_user special-case must be in the abandoned loop');
        assert.ok(/answered_via_chat: true/.test(seg), 'placeholder must carry answered_via_chat:true');
        assert.ok(/success: false, cancelled: true, cancelled_via_chat:/.test(seg), 'stop-phrase cancel must record the prompt_user cancel shape, not an answer');
        assert.ok(/recordToolResult\(chat, rtc2\.id, [^;]*_phText\)/.test(seg), 'special-cased text must be what is recorded');
        var send = await loadFile('src/js/app/040-send-message.js');
        assert.ok(/_ansViaChat/.test(send), 'page fast path flag must exist');
        assert.ok(/Answer sent to the pending question/.test(send), 'page spinner text for the fast path');
    });
});
