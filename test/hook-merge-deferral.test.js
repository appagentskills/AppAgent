// HOOK-MERGE: a user message sent while an after-response hook run is live
// must NOT be flushed into the hook turn (buildAPIMessages would join it onto
// the "…say nothing else: …" prompt, and findHookAnswerSpan would anchor on it
// → "No answer message found to attach tldr"). It stays queued and is
// delivered as its own turn by the end-of-run follow-up drain.
var _q = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };
function _settle(p) {
    return Promise.race([Promise.resolve(p).catch(function() {}), new Promise(function(r) { setTimeout(r, 200); })]);
}
var HOOK = 'Now do the following, calling ALL the tools in THIS SINGLE response (parallel tool calls), and say nothing else: 1) x; 2) y.';

describe('hook-run injection deferral (HOOK-MERGE)', function() {
    test('_isHookRunStart: only a trailing hook row starts a hook run', async function() {
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: _q, chats: {}, pendingInjectionsByChatId: {}
        }});
        var u = { role: 'user', content: 'q' }, a = { role: 'assistant', content: 'answer' };
        var h = { role: 'user', content: HOOK, isHookMessage: true };
        assert.strictEqual(m._isHookRunStart({ messages: [u, a, h] }, 2), true, 'fresh hook row');
        assert.strictEqual(m._isHookRunStart({ messages: [u, a, h, { role: 'assistant', content: '' }] }, 2), false, 'hook row already answered (follow-up run)');
        assert.strictEqual(m._isHookRunStart({ messages: [u, a] }, 0), false, 'organic user row');
        assert.strictEqual(m._isHookRunStart({ messages: [] }, -1), false, 'empty');
    });

    test('flushPendingInjection defers while the hook-run flag is set, then flushes as its own row', async function() {
        var pend = { c1: { text: 'Or search online.', images: [], hasUserText: true } };
        var chat = { id: 'c1', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: HOOK, isHookMessage: true }] };
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: _q, chats: { c1: chat },
            pendingInjectionsByChatId: pend, activeStreamingChatId: 'c1', pendingInjection: 'Or search online.', pendingInjectionImages: null,
            clearDeliveredPendingWakes: function() {}, newFileId: function() { return 'f1'; }, registerFile: function() {}
        }});
        m._hookRunDeferInjectionByChat.c1 = true;
        assert.strictEqual(m.flushPendingInjection(chat), false, 'deferred during hook run');
        assert.strictEqual(chat.messages.length, 3, 'nothing appended after the hook row');
        assert.ok(pend.c1 && pend.c1.text === 'Or search online.', 'entry kept for the follow-up run');
        delete m._hookRunDeferInjectionByChat.c1;
        assert.strictEqual(m.flushPendingInjection(chat), true, 'flushed once the hook run is over');
        assert.deepStrictEqual(chat.messages[3], { role: 'user', content: 'Or search online.', injected: true, hasUserText: true });
    });

    test('with the deferral, the hook turn keeps its answer target (no merged user row)', async function() {
        var m = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: _q, chats: {}
        }});
        var answer = { role: 'assistant', content: 'final answer' };
        var base = [{ role: 'user', content: 'q' }, answer, { role: 'user', content: HOOK, isHookMessage: true }];
        // Deferred (fixed) shape: the answer is found.
        assert.strictEqual(m.findHookAnswerSpan({ messages: base.slice() }, 2).target, answer);
        // Old merged shape reproduced the bug: the injected row became the anchor.
        var merged = base.concat([{ role: 'user', content: 'Or search online.', injected: true, hasUserText: true }]);
        assert.strictEqual(m.findHookAnswerSpan({ messages: merged }, 2).target, null, 'documents the pre-fix failure mode');
    });

    test('130 _handlePanelSendMessage queues but does not interrupt a live hook run', async function() {
        var pend = {}, interrupted = {}, resolverCalls = 0;
        var m = await loadModules(['src/js/worker/130-port-bridge.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true }, console: _q,
            chats: { c1: { messages: [] }, c2: { messages: [] } }, runningChatIds: { c1: true, c2: true }, pendingInjectionsByChatId: pend,
            setChatPausedPersistent: function() {}, userInterruptedChats: interrupted,
            interruptResolversByChatId: { c1: function() { resolverCalls++; }, c2: function() { resolverCalls++; } },
            currentStreamAbortControllers: {}, pausedChats: {}, _hookRunDeferInjectionByChat: { c1: true }
        }});
        await _settle(m._handlePanelSendMessage({ chatId: 'c1', text: 'Or search online.' }));
        assert.strictEqual(pend.c1.text, 'Or search online.', 'queued');
        assert.strictEqual(pend.c1.hasUserText, true);
        assert.ok(!interrupted.c1, 'hook run not interrupted');
        assert.strictEqual(resolverCalls, 0);
        await _settle(m._handlePanelSendMessage({ chatId: 'c2', text: 'normal' }));
        assert.strictEqual(interrupted.c2, true, 'non-hook runs still interrupt');
        assert.strictEqual(resolverCalls, 1);
    });

    test('run cleanup keeps a deferred entry and lets the follow-up drain run instead of re-firing hooks', async function() {
        var src = await loadFile('src/js/app/030-agent-loop.js');
        assert.ok(src.indexOf('!_hasOwnSubs && !_hookDeferredPending) {\n            delete pendingInjectionsByChatId[streamingChatId];') > -1, 'delete guarded');
        assert.ok(src.indexOf("!(chat && chat.isSubAgent) && !_hookDeferredPending) {\n        // typeof guard") > -1, 'hooks gated');
        var setAt = src.indexOf('if (_isHookRunStart(chat, lastUserMsgIndex)) _hookRunDeferInjectionByChat[streamingChatId] = true;');
        var loopAt = src.indexOf('while (!isChatPaused(streamingChatId)) {');
        assert.ok(setAt > -1 && setAt < loopAt, 'flag set at run start, before the first flush');
    });
}, { tags: ['unit'], timeout: 5000 });
