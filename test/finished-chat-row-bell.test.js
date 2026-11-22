// Finished-chat bell parity: a chat counted in the "Active chats" pill's bell
// segment (ui/165-finished-chat-badge.js) must render the SAME bell on its
// chat row (tools/120-actions.js _jobsStateIndicatorHtml), and the row bell
// must clear when the pill clears it. Real source via loadModules; stubs only
// for the DOM / chrome.
function fakeDocument() {
    return { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
}
async function loadBellModules() {
    var doc = fakeDocument();
    var m = await loadModules(['src/js/core/060-ui-constants.js', 'src/js/ui/165-finished-chat-badge.js', 'src/js/ui/180-search.js', 'src/js/tools/120-actions.js'],
        { lenient: true, globals: { window: fakeWindow({ document: doc }), chrome: fakeChrome(), document: doc } });
    m.__scope.chats = {};
    m.__scope.activeActions = {};
    m.__scope.AgentEvents = { emit: function() {} };
    m.__scope.currentChatId = 'other';
    m.__scope.currentView = 'home';
    m.__scope.runningChatIds = {};
    m.__scope.saveChatsToStorage = function() {};
    return m;
}
function finishedChat(id) {
    var now = Date.now();
    return { id: id, title: 'T', messages: [{ role: 'user', content: 'x' }], lastResponseAt: now, lastViewedAt: now - 1000 };
}

describe('finished-chat bell shows on the chat row, not only on the pill', function() {
    test('row indicator renders the bell exactly when the pill counts the chat, and clears with it', async function() {
        var m = await loadBellModules();
        m.__scope.chats.c1 = finishedChat('c1');
        // Before the bell is set: plain check, pill empty.
        assert.strictEqual(m.getUnseenFinishedChatsInfo().count, 0);
        assert.ok(m._jobsStateIndicatorHtml('unseen', 'c1').indexOf('jobs-row-bell') === -1);

        m.noteChatFinishedUnseen('c1', false);
        assert.strictEqual(m.getUnseenFinishedChatsInfo().count, 1, 'pill counts the bell');
        var html = m._jobsStateIndicatorHtml(m._jobsChatState('c1'), 'c1');
        assert.ok(html.indexOf('jobs-row-bell') !== -1, 'row shows the bell: ' + html);
        // Active-dropdown rows map 'unseen' -> 'done' before rendering; still a bell.
        assert.ok(m._jobsStateIndicatorHtml('done', 'c1').indexOf('jobs-row-bell') !== -1);
        // Without a chatId (legacy callers) the indicator is unchanged.
        assert.ok(m._jobsStateIndicatorHtml('unseen').indexOf('jobs-row-check') !== -1);

        m.clearUnseenFinishedChat('c1');
        assert.strictEqual(m.getUnseenFinishedChatsInfo().count, 0);
        assert.ok(m._jobsStateIndicatorHtml('unseen', 'c1').indexOf('jobs-row-bell') === -1, 'row bell clears with the pill');
    }, { tags: ['unit'], timeout: 5000 });

    test('row bell follows the pill read-side gates (running chat / focused chat => no bell anywhere)', async function() {
        var m = await loadBellModules();
        m.__scope.chats.c2 = finishedChat('c2');
        m.noteChatFinishedUnseen('c2', false);
        m.__scope.runningChatIds.c2 = true; // re-running
        assert.strictEqual(m.getUnseenFinishedChatsInfo().count, 0);
        assert.strictEqual(m.getFinishedChatBell('c2'), null);
        assert.ok(m._jobsStateIndicatorHtml(m._jobsChatState('c2'), 'c2').indexOf('jobs-row-bell') === -1);
        delete m.__scope.runningChatIds.c2;
        assert.ok(m.getFinishedChatBell('c2'), 'bell returns once no longer running');
        assert.strictEqual(m.getUnseenFinishedChatsInfo().count, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('continued chat: the handoff finish is silent, a later run in the old chat rings the bell', async function() {
        var m = await loadBellModules();
        var now = Date.now();
        // Handoff just happened: the summary run's late notifyFinish is suppressed.
        var hand = [{ role: 'user', content: 'do x' }, { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'HANDOFF', isSummaryRequest: true }, { role: 'assistant', content: 'done' }];
        var h = finishedChat('h'); h.continuedTo = 'n'; h.continuedAt = now - 1000; h.messages = hand.slice();
        m.__scope.chats.h = h;
        m.noteChatFinishedUnseen('h', false);
        assert.strictEqual(m.getFinishedChatBell('h'), null, 'handoff finish: no bell');
        // Legacy link without continuedAt: still suppressed.
        // (message-evicted skeleton → timestamp fallback)
        var lg = finishedChat('lg'); lg.continuedTo = 'n'; delete lg.messages; lg._messagesEvicted = true;
        m.__scope.chats.lg = lg;
        // Run identity, no grace window: "Send here anyway" 1s after the
        // handoff (a user row after the request) rings the bell immediately.
        var q = finishedChat('q'); q.continuedTo = 'n'; q.continuedAt = now - 1000;
        q.messages = hand.concat([{ role: 'user', content: 'send here anyway' }, { role: 'assistant', content: 'r' }]);
        m.__scope.chats.q = q;
        m.noteChatFinishedUnseen('q', false);
        assert.ok(m.getFinishedChatBell('q'), 'post-handoff run inside the old 30s grace: bell');
        // Evicted skeleton inside the grace: timestamp fallback still suppresses.
        var sk = finishedChat('sk'); sk.continuedTo = 'n'; sk.continuedAt = now - 1000; delete sk.messages; sk._messagesEvicted = true;
        m.__scope.chats.sk = sk;
        m.noteChatFinishedUnseen('sk', false);
        assert.strictEqual(m.getFinishedChatBell('sk'), null, 'evicted skeleton: timestamp fallback');
        m.noteChatFinishedUnseen('lg', false);
        assert.strictEqual(m.getFinishedChatBell('lg'), null, 'legacy link: no bell');
        // "Send here anyway" run finishing well after the handoff: bell + unseen.
        var o = finishedChat('o'); o.continuedTo = 'n'; o.continuedAt = now - 10 * 60 * 1000;
        o.messages = hand.concat([{ role: 'user', content: 'more' }, { role: 'assistant', content: 'r' }]);
        m.__scope.chats.o = o;
        m.noteChatFinishedUnseen('o', false);
        assert.ok(m.getFinishedChatBell('o'), 'later run: bell');
        assert.strictEqual(m._jobsChatState('o'), 'unseen');
        assert.strictEqual(m.getUnseenFinishedChatsInfo().count, 2, 'q (send-here-anyway inside 30s) + o');
    }, { tags: ['unit'], timeout: 5000 });
});
