// OS "Agent finished" notification click must open its chat even when the
// extension tab is ALREADY loaded/active (focusing it never reloads, so the
// page has to act on background.js's 'open-chat-from-notification' broadcast).
// Run: run_tests { files: ['test/notification-open-chat.test.js'] }
var WS = args.workspace;
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/220-notification-system.js'];
var ALLOW = ['_teardownWorkerChatModal', 'startClaudeOAuthLogin', 'startChatGPTOAuthLogin', 'startApprovalTitleFlash', 'syncApprovalTitleFlash',
    'setActionNeedsPermission', 'clearActionNeedsPermission', '_refreshWaitingBadges', 'resolveRootChatId', 'pushPermissionsToOffscreen',
    'clearApprovalNotificationsForChat', '_chatsHydrated', 'getApprovalCardEl', 'settlePendingModalResolve', '_dismissedApprovalKeys',
    'smartDocuments', 'currentEditingWidget', 'AgentEvents', 'invalidateCreditsRequests'];

async function load(view, current) {
    var selected = [];
    var getCurrentTab = function(cb) { cb({ id: 7 }); };
    var m = await U.loadUi(FILES, { allowUnstubbed: ALLOW, globals: {
        chats: { a: { id: 'a' }, b: { id: 'b' } },
        currentChatId: current,
        currentView: view,
        selectChat: function(id) { selected.push(id); }
    } });
    return { m: m, selected: selected, fire: function(msg) { m.handleOpenChatFromNotificationMessage(msg, getCurrentTab); } };
}

describe('notification click opens its chat in an already-open page', function() {
    afterEach(function() { U.cleanupAll(); });

    test('shouldOpenChatFromNotification targets the right surface', async function() {
        var h = await load('chat', 'a');
        var f = h.m.shouldOpenChatFromNotification;
        var msg = { type: 'open-chat-from-notification', chatId: 'b', tabId: 7 };
        assert.strictEqual(f(msg, false, 7), true, 'matching full-page tab');
        assert.strictEqual(f(msg, false, 8), false, 'other full-page tab');
        assert.strictEqual(f(msg, true, null), false, 'side panel ignores a tab-targeted click');
        var sp = { type: 'open-chat-from-notification', chatId: 'b', tabId: null };
        assert.strictEqual(f(sp, true, null), true, 'side panel handles tabId:null');
        assert.strictEqual(f(sp, false, 7), false, 'full tab ignores side-panel click');
        assert.strictEqual(f({ type: 'other', chatId: 'b', tabId: 7 }, false, 7), false);
        assert.strictEqual(f({ type: 'open-chat-from-notification', tabId: 7 }, false, 7), false, 'no chatId');
    }, { tags: ['unit'] });

    test('active extension tab viewing another chat navigates to the notified chat', async function() {
        var h = await load('chat', 'a');
        var bridge = await loadFile('src/platform/extension/platform-bridge.js');
        assert.match(bridge, /handleOpenChatFromNotificationMessage\(msg,/, 'platform-bridge wires the runtime message');
        h.fire({ type: 'open-chat-from-notification', chatId: 'b', tabId: 7 });
        assert.deepStrictEqual(h.selected, ['b']);
        h.fire({ type: 'open-chat-from-notification', chatId: 'b', tabId: 9 });
        h.fire({ type: 'open-chat-from-notification', chatId: 'zzz', tabId: 7 });
        assert.deepStrictEqual(h.selected, ['b'], 'other tab / unknown chat ignored');
    }, { tags: ['unit'] });

    test('same chat on a non-chat view (home) still switches to it; already-shown chat is a no-op', async function() {
        var h = await load('home', 'b');
        h.fire({ type: 'open-chat-from-notification', chatId: 'b', tabId: 7 });
        assert.deepStrictEqual(h.selected, ['b']);
        var h2 = await load('chat', 'b');
        assert.strictEqual(h2.m.openChatFromNotification('b'), true);
        assert.deepStrictEqual(h2.selected, []);
    }, { tags: ['unit'] });
});
