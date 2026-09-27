// A2B-01: the jobs-row "current" signal (tools/120-actions.js _jobsRowSignals)
// must follow the CHAT view. currentChatId keeps pointing at the last opened
// chat while the user is on Home / Dashboard, so there that row must NOT be
// .is-current (which suppressed its unread dot) — it must read as unread.
// Real source via loadModules (loader copied from finished-chat-row-bell);
// stubs only for the DOM / chrome.
function fakeDocument() {
    return { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
}
async function loadSignalModules() {
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
    return { m: m, doc: doc };
}
function finishedChat(id) {
    var now = Date.now();
    return { id: id, title: 'T', messages: [{ role: 'user', content: 'x' }], lastResponseAt: now, lastViewedAt: now - 1000 };
}

describe('jobs row signals (A2B-01)', function() {
    test('jobs row signals follow the chat view', async function() {
        var t = await loadSignalModules();
        var m = t.m;
        m.__scope.chats.c1 = finishedChat('c1');
        m.__scope.currentChatId = 'c1';

        // Home / Dashboard: the last-opened chat is not being viewed, so its
        // unseen activity shows (unread dot + bold) and it is not "current".
        ['dashboard', 'home'].forEach(function(view) {
            m.__scope.currentView = view;
            assert.strictEqual(m._chatHasUnseenActivity('c1'), true, view + ': chat has unseen activity');
            var sig = m._jobsRowSignals('c1', 'done');
            assert.ok(sig.trail.indexOf('jobs-unread-dot') !== -1, view + ': trail shows the unread dot: ' + JSON.stringify(sig));
            assert.ok(sig.cls.indexOf(' jobs-unread') !== -1, view + ': cls has jobs-unread: ' + JSON.stringify(sig));
            assert.ok(sig.cls.indexOf(' is-current') === -1, view + ': cls is not current: ' + JSON.stringify(sig));
        });

        // Chat view: the open chat is the current row with no trailing signal,
        // even when the window lost focus (unseen activity is then true, but
        // the explicit isCur branch keeps the dot off the current row).
        m.__scope.currentView = 'chat';
        [null, false].forEach(function(focus) {
            if (focus === null) delete t.doc.hasFocus;
            else t.doc.hasFocus = function() { return focus; };
            var label = 'chat view' + (focus === null ? '' : ' (hasFocus false)');
            var sig = m._jobsRowSignals('c1', 'done');
            assert.ok(sig.cls.indexOf(' is-current') !== -1, label + ': cls is current: ' + JSON.stringify(sig));
            assert.strictEqual(sig.trail, '', label + ': no trailing signal');
        });
        assert.strictEqual(m._chatHasUnseenActivity('c1'), true, 'unfocused window: activity still counts as unseen');
    }, { tags: ['unit'], timeout: 5000 });
});
