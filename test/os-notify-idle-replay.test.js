// IDLE-REPLAY — an approval / finished-chat bell that arrived while the user was
// present (panel visible + focused, machine active) never got an OS
// notification. On the chrome.idle transition to idle/locked (the moment the
// Keep-awake popup appears) ui/220 replays ONE coalesced OS notification for
// those items, once, deduped across panels via a shared localStorage marker.
// Loads the REAL ui/165 + ui/220 with in-memory chrome.idle / DOM / storage stubs.

function makeIdleReplayEnv() {
    var idle = { state: 'active', listeners: [], fire: function(s) { idle.state = s; idle.listeners.forEach(function(f) { f(s); }); } };
    var store = {};
    var localStorage = {
        getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem: function(k, v) { store[k] = String(v); }
    };
    var notes = [];
    return { idle: idle, store: store, localStorage: localStorage, notes: notes };
}

async function loadPanel(env, chats, extra) {
    var noop = function() {};
    var g = {
        document: { hidden: false, hasFocus: function() { return true; }, addEventListener: noop,
            querySelectorAll: function() { return []; }, getElementById: function() { return null; } },
        window: { addEventListener: noop, chrome: { idle: {
            setDetectionInterval: noop,
            queryState: function(s, cb) { cb(env.idle.state); },
            onStateChanged: { addListener: function(f) { env.idle.listeners.push(f); } } } } },
        localStorage: env.localStorage,
        chats: chats, currentChatId: 'focused', currentView: 'chat',
        t: function(s) { return s; },
        Platform: { sendNotification: function(o) { env.notes.push(o); } },
        setTimeout: function() { return 1; }, clearTimeout: noop
    };
    Object.keys(extra || {}).forEach(function(k) { g[k] = extra[k]; });
    return loadModules(['src/js/ui/165-finished-chat-badge.js', 'src/js/ui/220-notification-system.js'], { globals: g });
}

function approvalEntry(over) {
    var e = { chatTitle: 'Deploy', toolName: 'servicenow_api', chatId: 'c1', statusMessage: 'Updating incident', approvalIndex: 3, toolCallId: 'tc1', args: null, osEligible: true, osNotified: false };
    Object.keys(over || {}).forEach(function(k) { e[k] = over[k]; });
    return e;
}

describe('IDLE-REPLAY: missed OS notifications fire when the user goes idle', function() {
    test('pending never-notified approval replays once on idle; not again on locked or the next idle', async function() {
        var env = makeIdleReplayEnv();
        var p = await loadPanel(env, { c1: { id: 'c1', title: 'Deploy', messages: [] } });
        p.approvalNotificationQueue.push(approvalEntry());
        env.idle.fire('active'); // no-op transition guard
        assert.strictEqual(env.notes.length, 0, 'nothing while active');
        env.idle.fire('idle');
        assert.deepStrictEqual(env.notes, [{ title: 'Tool needs approval', message: 'Updating incident \u2014 Deploy', chatId: 'c1' }]);
        env.idle.fire('locked');
        env.idle.fire('active');
        env.idle.fire('idle');
        assert.strictEqual(env.notes.length, 1, 'once per item, not per idle period');
        assert.strictEqual(p.approvalNotificationQueue[0].osNotified, true);
    }, { tags: ['unit'], timeout: 4000 });

    test('fan-out copy (osEligible false), already-notified and dismissed approvals never replay', async function() {
        var env = makeIdleReplayEnv();
        var p = await loadPanel(env, {});
        p.approvalNotificationQueue.push(approvalEntry({ osEligible: false }));
        p.approvalNotificationQueue.push(approvalEntry({ toolCallId: 'tc2', approvalIndex: 4, osNotified: true }));
        p.approvalNotificationQueue.push(approvalEntry({ toolCallId: 'tc3', approvalIndex: 5 }));
        p._dismissedApprovalKeys['c1:5'] = true;
        env.idle.fire('idle');
        assert.deepStrictEqual(env.notes, []);
    }, { tags: ['unit'], timeout: 4000 });

    test('unseen bell replays; one coalesced notification lists approvals first, then bells', async function() {
        var env = makeIdleReplayEnv();
        var chats = { c1: { id: 'c1', title: 'Deploy', messages: [] }, c2: { id: 'c2', title: 'Build', messages: [] }, c3: { id: 'c3', title: 'New Chat', messages: [] } };
        var p = await loadPanel(env, chats);
        p.noteChatFinishedUnseen('c2', false);
        p.noteChatFinishedUnseen('c3', true);
        p.approvalNotificationQueue.push(approvalEntry());
        env.idle.fire('idle');
        assert.strictEqual(env.notes.length, 1, 'coalesced into ONE notification');
        assert.strictEqual(env.notes[0].title, 'Tool needs approval');
        assert.strictEqual(env.notes[0].chatId, 'c1');
        assert.deepStrictEqual(env.notes[0].message.split('\n'), ['Updating incident \u2014 Deploy', 'New Chat', 'Build']);
        env.idle.fire('active'); env.idle.fire('idle');
        assert.strictEqual(env.notes.length, 1, 'bells are marked notified too');
    }, { tags: ['unit'], timeout: 4000 });

    test('bell already OS-notified at finish (marker) is skipped; sub-agent and focused chats never bell', async function() {
        var env = makeIdleReplayEnv();
        var chats = { c2: { id: 'c2', title: 'Build', messages: [] }, sub: { id: 'sub', isSubAgent: true, messages: [] }, focused: { id: 'focused', messages: [] } };
        var p = await loadPanel(env, chats);
        p.noteOsNotified('finish:c2');     // the finish toast fired at arrival (036 stamps this)
        p.noteChatFinishedUnseen('c2', false);
        p.noteChatFinishedUnseen('sub', false);
        p.noteChatFinishedUnseen('focused', false);
        env.idle.fire('idle');
        assert.deepStrictEqual(env.notes, []);
    }, { tags: ['unit'], timeout: 4000 });

    test('two panels on the same idle event: the shared marker yields exactly one notification', async function() {
        var env = makeIdleReplayEnv();
        var chats = { c2: { id: 'c2', title: 'Build', messages: [] } };
        var a = await loadPanel(env, chats);
        var b = await loadPanel(env, chats);
        a.noteChatFinishedUnseen('c2', false);
        b.noteChatFinishedUnseen('c2', false);
        env.idle.fire('idle');
        assert.deepStrictEqual(env.notes, [{ title: 'Agent finished', message: 'Build', chatId: 'c2' }]);
        assert.ok(JSON.parse(env.store.appagentOsNotified)['finish:c2'] > 0, 'marker persisted in shared localStorage');
    }, { tags: ['unit'], timeout: 4000 });

    test('no chrome.idle (offscreen host / tests): nothing subscribes, replay is still callable and safe', async function() {
        var env = makeIdleReplayEnv();
        var noop = function() {};
        var p = await loadModules(['src/js/ui/220-notification-system.js'], { globals: {
            document: { hidden: false, hasFocus: function() { return true; }, addEventListener: noop },
            window: { addEventListener: noop, chrome: {} }, localStorage: env.localStorage,
            t: function(s) { return s; }, Platform: { sendNotification: function(o) { env.notes.push(o); } } } });
        assert.strictEqual(env.idle.listeners.length, 0);
        assert.strictEqual(p.replayMissedOsNotifications(), 0);
        assert.deepStrictEqual(env.notes, []);
    }, { tags: ['unit'], timeout: 4000 });
});
