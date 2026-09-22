// #9 — empty final assistant message. (a) A response with NO text and NO
// tool calls used to be stored as an empty assistant row and end the run
// silently; now the loop nudges the model once (role:'context') and tags the
// row `_empty`. (b) findHookAnswerSpan accepts the run's own user-row anchor so
// a user message that landed AFTER the final answer does not move the span.
describe('empty assistant turn nudge (030-agent-loop.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M._isEmptyAssistantTurn, 'function', '_isEmptyAssistantTurn must exist');
        assert.strictEqual(typeof M._pushEmptyResponseNudge, 'function', '_pushEmptyResponseNudge must exist');
        return M;
    }
    test('_isEmptyAssistantTurn: only no-content + no-tool_calls + no-thinking rows are empty', async function() {
        var m = await load();
        assert.strictEqual(m._isEmptyAssistantTurn({ role: 'assistant', content: '' }), true);
        assert.strictEqual(m._isEmptyAssistantTurn({ role: 'assistant', content: '   \n' }), true, 'whitespace-only counts as empty');
        assert.strictEqual(m._isEmptyAssistantTurn({ role: 'assistant', content: '', tool_calls: [] }), true);
        assert.strictEqual(m._isEmptyAssistantTurn({ role: 'assistant', content: 'hi' }), false);
        assert.strictEqual(m._isEmptyAssistantTurn({ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'set_tldr', arguments: '{}' } }] }), false, 'tool-call-only turns are NOT empty');
        assert.strictEqual(m._isEmptyAssistantTurn({ role: 'assistant', content: '', thinking: 'hmm' }), false, 'thinking-only is not empty');
        assert.strictEqual(m._isEmptyAssistantTurn({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }), false, 'array content is content');
        assert.strictEqual(m._isEmptyAssistantTurn({ role: 'user', content: '' }), false);
        assert.strictEqual(m._isEmptyAssistantTurn(null), false);
    });
    test('_pushEmptyResponseNudge: one context nudge per run, then gives up', async function() {
        var m = await load();
        var chat = { id: 'c1', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', _empty: true }], _emptyRetries: 0 };
        assert.strictEqual(m._pushEmptyResponseNudge(chat), true, 'first empty turn → nudge');
        assert.strictEqual(chat.messages.length, 3);
        var nudge = chat.messages[2];
        assert.strictEqual(nudge.role, 'context');
        assert.ok(/empty/i.test(nudge.content) && /final answer/i.test(nudge.content), nudge.content);
        assert.strictEqual(nudge._emptyNudge, true, 'nudge row is tagged for the renderer / counters');
        assert.strictEqual(chat._emptyRetries, 1);
        chat.messages.push({ role: 'assistant', content: '', _empty: true });
        assert.strictEqual(m._pushEmptyResponseNudge(chat), false, 'second empty turn in the same run → no nudge (run ends)');
        assert.strictEqual(chat.messages.length, 4, 'nothing pushed');
        // Run-start reset (the loop sets chat._emptyRetries = 0) re-arms it.
        chat._emptyRetries = 0;
        assert.strictEqual(m._pushEmptyResponseNudge(chat), true);
    });
    test('_pushEmptyResponseNudge: undefined counter (legacy chat) behaves like 0', async function() {
        var m = await load();
        var chat = { id: 'c2', messages: [] };
        assert.strictEqual(m._pushEmptyResponseNudge(chat), true);
        assert.strictEqual(chat._emptyRetries, 1);
    });
    test('loop wiring: run start resets _emptyRetries and the no-tool_calls branch consults the nudge', async function() {
        var src = await loadFile('src/js/app/030-agent-loop.js');
        assert.ok(/chat\._emptyRetries = 0;/.test(src), 'run start must reset chat._emptyRetries');
        var idx = src.indexOf('_pushEmptyResponseNudge(chat)');
        var defIdx = src.indexOf('function _pushEmptyResponseNudge');
        assert.ok(idx > -1 && src.indexOf('_pushEmptyResponseNudge(chat)', defIdx + 40) > -1, 'the loop must call _pushEmptyResponseNudge(chat)');
        var callSite = src.indexOf('_pushEmptyResponseNudge(chat)', defIdx + 40);
        var flushIdx = src.indexOf('if (flushPendingInjection(chat)) {', callSite);
        assert.ok(flushIdx > -1 && flushIdx - callSite < 600, 'nudge check must sit right before the final flushPendingInjection in the no-tool_calls branch');
        assert.ok(/executeAfterResponseHooks\(streamingChatId, lastUserMsgIndex\)/.test(src), 'hooks must receive the run anchor');
    });
});

describe('findHookAnswerSpan anchor (020-tool-execution.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        return M;
    }
    function baseChat() {
        return { id: 'h1', messages: [
            { role: 'user', content: 'first question' },                     // 0
            { role: 'assistant', content: 'first answer' },                  // 1
            { role: 'user', content: 'real question' },                      // 2  ← run anchor
            { role: 'assistant', content: '', tool_calls: [{ id: 't', function: { name: 'js_eval', arguments: '{}' } }] }, // 3
            { role: 'tool', content: 'ok', tool_call_id: 't' },              // 4
            { role: 'assistant', content: 'FINAL ANSWER' }                   // 5
        ] };
    }
    test('no anchor: unchanged behaviour (last non-hook user row)', async function() {
        var m = await load();
        var chat = baseChat();
        var span = m.findHookAnswerSpan(chat);
        assert.strictEqual(span.lastUserIdx, 2);
        assert.strictEqual(span.target && span.target.content, 'FINAL ANSWER');
        assert.strictEqual(span.endIdx, 5);
    });
    test('user message landed after the answer: default scan loses the target, anchor keeps it', async function() {
        var m = await load();
        var chat = baseChat();
        chat.messages.push({ role: 'user', content: 'new question typed after the answer' }); // 6
        var noAnchor = m.findHookAnswerSpan(chat);
        assert.strictEqual(noAnchor.lastUserIdx, 6);
        assert.strictEqual(noAnchor.target, null, 'default scan: span is empty (the old bug)');
        var anchored = m.findHookAnswerSpan(chat, 2);
        assert.strictEqual(anchored.lastUserIdx, 2);
        assert.strictEqual(anchored.endIdx, 5, 'span must END before the new organic user row');
        assert.strictEqual(anchored.target && anchored.target.content, 'FINAL ANSWER');
        assert.strictEqual(m.findHookAnswerTarget(chat, 2).content, 'FINAL ANSWER');
    });
    test('injected mid-run rows (sub-agent notices / queued user text) do not end the anchored span', async function() {
        var m = await load();
        var chat = baseChat();
        chat.messages.splice(5, 0, { role: 'user', content: '[sub-agent reported]', injected: true }); // 5, FINAL moves to 6
        var anchored = m.findHookAnswerSpan(chat, 2);
        assert.strictEqual(anchored.endIdx, 6);
        assert.strictEqual(anchored.target.content, 'FINAL ANSWER');
        // and a hook user row still terminates the span
        chat.messages.push({ role: 'user', content: 'hook', isHookMessage: true }); // 7
        chat.messages.push({ role: 'assistant', content: 'hook prose' });          // 8
        var a2 = m.findHookAnswerSpan(chat, 2);
        assert.strictEqual(a2.endIdx, 6);
        assert.strictEqual(a2.target.content, 'FINAL ANSWER');
    });
    test('invalid anchors fall back to the default scan', async function() {
        var m = await load();
        var chat = baseChat();
        assert.strictEqual(m.findHookAnswerSpan(chat, -1).lastUserIdx, 2, 'negative');
        assert.strictEqual(m.findHookAnswerSpan(chat, 99).lastUserIdx, 2, 'out of range');
        assert.strictEqual(m.findHookAnswerSpan(chat, 1).lastUserIdx, 2, 'points at an assistant row');
        assert.strictEqual(m.findHookAnswerSpan(chat, 'x').lastUserIdx, 2, 'non-number');
        chat.messages.push({ role: 'user', content: 'hook', isHookMessage: true });
        assert.strictEqual(m.findHookAnswerSpan(chat, 6).lastUserIdx, 2, 'points at a hook row (hook-run anchor) → default');
    });
    test('attachAnswerCard / relocateAnswerCard accept the anchor too', async function() {
        var m = await load();
        var chat = baseChat();
        chat.messages.push({ role: 'user', content: 'late message' });
        var r = m.attachAnswerCard(chat, 'tldr', 'T', 2);
        assert.strictEqual(r.success, true);
        assert.strictEqual(chat.messages[5].tldr, 'T');
        chat.messages[3].links = [{ url: 'u' }];
        delete chat.messages[5].links;
        assert.ok(m.relocateAnswerCard(chat, 'links', 2), 'relocates within the anchored span');
        assert.ok(chat.messages[5].links && !chat.messages[3].links);
    });
});
