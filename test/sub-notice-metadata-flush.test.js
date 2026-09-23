// SUB-NOTICE-META (B part 2a), consumer side: flushPendingInjection stamps
// the injected row, the page (040) / SW (130) send merges keep subNotices and
// set hasUserText, and buildAPIMessages ignores the new render-only fields.
// Runs against the REAL src modules.
var _q = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };
function _settle(p) {
    // Never let a stub-less tail of an async entry point hang the run.
    return Promise.race([Promise.resolve(p).catch(function() {}), new Promise(function(r) { setTimeout(r, 200); })]);
}
var META = { kind: 'final', agentId: 'kid', name: 'Kid', status: 'done', summary: 'S', text: 'NOTICE' };

describe('sub-notice metadata (consumer side)', function() {
    test('flushPendingInjection stamps subNotices + hasUserText on the injected row (content unchanged)', async function() {
        var pend = { c1: { text: 'NOTICE\n\nuser typed', images: [], subNotices: [META], hasUserText: true } };
        var cleared = [];
        var chat = { id: 'c1', messages: [] };
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: _q, chats: { c1: chat },
            pendingInjectionsByChatId: pend, activeStreamingChatId: null, pendingInjection: null, pendingInjectionImages: null,
            clearDeliveredPendingWakes: function(id, t) { cleared.push([id, t]); },
            newFileId: function() { return 'f1'; }, registerFile: function() {}
        }});
        assert.strictEqual(m.flushPendingInjection(chat), true);
        assert.strictEqual(chat.messages.length, 1);
        var row = chat.messages[0];
        assert.deepStrictEqual(row, { role: 'user', content: 'NOTICE\n\nuser typed', injected: true, subNotices: [META], hasUserText: true });
        assert.notStrictEqual(row.subNotices, undefined);
        assert.strictEqual(pend.c1, undefined, 'entry consumed');
        assert.deepStrictEqual(cleared, [['c1', 'NOTICE\n\nuser typed']], 'targeted durable clear still keyed on the exact text');
        // Legacy entry (no metadata) → the pre-change row shape, byte for byte.
        pend.c1 = { text: 'plain', images: [] };
        assert.strictEqual(m.flushPendingInjection(chat), true);
        assert.deepStrictEqual(chat.messages[1], { role: 'user', content: 'plain', injected: true });
    });

    test('040 sendMessage (running chat) keeps subNotices, sets hasUserText, leaves the prior entry object intact', async function() {
        var input = { value: 'hello', style: {} };
        var prev = { text: 'NOTICE', images: [], subNotices: [META] };
        var pend = { c1: prev };
        var m = await loadModules(['src/js/app/040-send-message.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: _q,
            document: { getElementById: function(id) { return id === 'message-input' ? input : null; } },
            pendingImageAttachments: [], runningChatIds: { c1: true }, currentChatId: 'c1', pendingInjectionsByChatId: pend,
            chats: { c1: { messages: [] } }, clearPendingImages: function() {}, chatPendingTexts: {},
            getCurrentPendingContext: function() { return 'c1'; }, persistPendingTextsToStorage: function() {},
            userInterruptedChats: {}, currentStreamAbortControllers: {}, interruptResolversByChatId: {},
            _agentBusPort: { postMessage: function() {} }, pendingInjection: null, pendingInjectionImages: null
        }});
        await _settle(m.sendMessage());
        var e = pend.c1;
        assert.notStrictEqual(e, prev, 'fresh object (rollback target stays intact)');
        assert.strictEqual(e.text, 'NOTICE\n\nhello', 'model text merge unchanged');
        assert.deepStrictEqual(e.subNotices, [META], 'subNotices kept');
        assert.strictEqual(e.hasUserText, true);
        assert.deepStrictEqual(prev, { text: 'NOTICE', images: [], subNotices: [META] }, 'prior entry not mutated');
    });

    test('130 _handlePanelSendMessage running merge keeps subNotices + sets hasUserText; fresh entry flags user text', async function() {
        var pend = { c1: { text: 'NOTICE', images: [], subNotices: [META] } };
        var m = await loadModules(['src/js/worker/130-port-bridge.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true }, console: _q,
            chats: { c1: { messages: [] }, c2: { messages: [] } }, runningChatIds: { c1: true, c2: true }, pendingInjectionsByChatId: pend,
            setChatPausedPersistent: function() {}, userInterruptedChats: {}, interruptResolversByChatId: {},
            currentStreamAbortControllers: {}, pausedChats: {}
        }});
        await _settle(m._handlePanelSendMessage({ chatId: 'c1', text: 'hi' }));
        assert.strictEqual(pend.c1.text, 'NOTICE\n\nhi');
        assert.deepStrictEqual(pend.c1.subNotices, [META]);
        assert.strictEqual(pend.c1.hasUserText, true);
        await _settle(m._handlePanelSendMessage({ chatId: 'c2', text: 'solo' }));
        assert.strictEqual(pend.c2.text, 'solo');
        assert.strictEqual(pend.c2.hasUserText, true);
        assert.strictEqual(pend.c2.subNotices, undefined);
    });

    test('buildAPIMessages output is identical with and without subNotices/hasUserText', async function() {
        var m = await loadModules(['src/js/app/020-api-messages.js'], { lenient: true, globals: { self: {}, window: fakeWindow(), console: _q, chats: {} } });
        function rows(withMeta) {
            var u1 = { role: 'user', content: 'hi' };
            var u2 = { role: 'user', content: 'NOTICE\n\nuser typed', injected: true };
            if (withMeta) { u2.subNotices = [META]; u2.hasUserText = true; }
            return [u1, { role: 'assistant', content: 'ok' }, u2];
        }
        var a = m.buildAPIMessages(rows(false), null);
        var b = m.buildAPIMessages(rows(true), null);
        assert.ok(Array.isArray(a) && a.length >= 2);
        assert.deepStrictEqual(b, a);
        assert.strictEqual(JSON.stringify(b), JSON.stringify(a));
        assert.strictEqual(JSON.stringify(b).indexOf('subNotices'), -1);
        assert.strictEqual(JSON.stringify(b).indexOf('hasUserText'), -1);
    });
}, { tags: ['unit'], timeout: 5000 });
