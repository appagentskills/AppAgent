// Errored / stuck chats whose last activity is older than
// STALE_FAILED_CHAT_MAX_AGE_MS (7 days) must NOT appear in "Active chats" --
// neither the population (getActiveChatsList: header pill, jobs dropdown, home
// panel, expand modal) nor the section predicate (_isChatInActiveSection) nor
// the home buckets (_jobsExpandBuckets().active). Fresh ones still do, and a
// genuinely running chat is never hidden. Real source via loadModules.
function fakeDocument() {
    return { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
}
async function loadActionModules() {
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
var DAY = 24 * 60 * 60 * 1000;
function erroredChat(id, ageMs) {
    var t = Date.now() - ageMs;
    return { id: id, title: 'E', createdAt: t - 1000, messages: [{ role: 'user', content: 'x' }],
        lastResponseAt: t, lastActivityAt: t, lastViewedAt: t + 1, _lastApiError: { chatId: id, message: 'HTTP 500' } };
}
function stuckChat(id, ageMs) {
    var t = Date.now() - ageMs;
    var args = JSON.stringify({ state: 'stuck', icon: 'alert', label: 'Blocked', status_message: 's' });
    return { id: id, title: 'S', createdAt: t - 1000, lastResponseAt: t, lastActivityAt: t, lastViewedAt: t + 1, messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'u0', type: 'function', function: { name: 'update_action_state', arguments: args } }] },
        { role: 'tool', tool_call_id: 'u0', content: '{"success":true}' }
    ] };
}
function ids(list) { return list.map(function(c) { return c.id; }).sort(); }

describe('stale errored / stuck chats leave Active chats after 7 days', function() {
    test('constant is 7 days', async function() {
        var m = await loadActionModules();
        assert.strictEqual(m.__scope.STALE_FAILED_CHAT_MAX_AGE_MS, 7 * DAY);
    }, { tags: ['unit'], timeout: 5000 });

    test('errored + stuck: fresh stay Active, > 7 days are hidden (panel + home)', async function() {
        var m = await loadActionModules();
        var C = m.__scope.chats;
        C.errFresh = erroredChat('errFresh', 2 * DAY);
        C.errOld = erroredChat('errOld', 8 * DAY);
        C.stuckFresh = stuckChat('stuckFresh', 2 * DAY);
        C.stuckOld = stuckChat('stuckOld', 8 * DAY);
        assert.strictEqual(m._homeChatFilterKey('stuckOld'), 'stuck', 'fixture: stuck card classifies stuck');
        assert.strictEqual(m._homeChatFilterKey('errOld'), 'error', 'fixture: errored chat classifies error');

        assert.deepStrictEqual(ids(m.getActiveChatsList()), ['errFresh', 'stuckFresh'], 'population (pill / dropdown)');
        assert.strictEqual(m._isChatInActiveSection('errOld'), false);
        assert.strictEqual(m._isChatInActiveSection('stuckOld'), false);
        assert.strictEqual(m._isChatInActiveSection('errFresh'), true);
        assert.strictEqual(m._isChatInActiveSection('stuckFresh'), true);
        assert.deepStrictEqual(ids(m._jobsExpandBuckets().active), ['errFresh', 'stuckFresh'], 'home panel Active bucket');
        // Data untouched: the stale chats still exist (History).
        assert.ok(C.errOld && C.errOld._lastApiError && C.stuckOld, 'stale chats are not deleted or cleared');
    }, { tags: ['unit'], timeout: 5000 });

    test('a running chat is never hidden, and boundary / unknown age stays Active', async function() {
        var m = await loadActionModules();
        var C = m.__scope.chats;
        C.errRun = erroredChat('errRun', 30 * DAY);
        m.__scope.runningChatIds.errRun = true;
        C.errEdge = erroredChat('errEdge', 7 * DAY - 60000);
        var noStamp = erroredChat('noStamp', 0);
        delete noStamp.lastResponseAt; delete noStamp.lastActivityAt; delete noStamp.createdAt; delete noStamp.lastViewedAt;
        C.noStamp = noStamp;
        var now = Date.now();
        assert.strictEqual(m._isStaleFailedChat('errRun', now), false, 'running chat not stale');
        assert.strictEqual(m._isStaleFailedChat('errEdge', now), false, 'just under 7 days not stale');
        assert.strictEqual(m._isStaleFailedChat('noStamp', now), false, 'unknown age not stale');
        assert.strictEqual(m._isStaleFailedChat('errEdge', now + 2 * 60000), true, 'past 7 days -> stale');
        // updatedAt counts as activity too.
        C.errUpd = erroredChat('errUpd', 10 * DAY); C.errUpd.updatedAt = now - DAY;
        assert.strictEqual(m._isStaleFailedChat('errUpd', now), false, 'recent updatedAt keeps it fresh');
        var act = ids(m.getActiveChatsList());
        assert.ok(act.indexOf('errRun') !== -1 && act.indexOf('errEdge') !== -1 && act.indexOf('errUpd') !== -1, JSON.stringify(act));
    }, { tags: ['unit'], timeout: 5000 });

    test('an old DONE chat is unaffected (not stale-failed)', async function() {
        var m = await loadActionModules();
        var c = erroredChat('ok', 9 * DAY); delete c._lastApiError;
        m.__scope.chats.ok = c;
        assert.strictEqual(m._isStaleFailedChat('ok', Date.now()), false);
    }, { tags: ['unit'], timeout: 5000 });
});
