// Sidebar memory footprint: render cap + "Show more", active chat beyond the
// cap, search over ALL chats with capped render, and burst coalescing of
// renderChatList(). REAL src/js/ui/180-search.js rendered into the sandbox DOM.
// Run: run_tests { files: ['test/sidebar-render-cap.test.js'] }
var WS = args.workspace;
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var CSS = ['src/css/00-tokens.css', 'src/css/02-layout.css'];
var MODS = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/210-chat-menus.js'];
var ALLOW = ['isChatPaused', 'isChatRunning', '_isChatInSilentHook', 'renderSubAgentBreadcrumb', '_storageDegraded', 'buildDegradedChatListHtml',
    'dispatchChatMeta', 'ensureChatPayloads', 'renderHistoryPage', 'smartDocuments', 'sdocOpenPreview', 'AgentEvents'];

function rec(impl) { return U.recorder(impl); }
function escJs(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function makeChats(n) {
    var out = {};
    for (var i = 0; i < n; i++) {
        var id = 'c' + i;
        // updatedAt descending with i, so c0 is newest and c(n-1) oldest.
        out[id] = { id: id, title: 'Chat ' + i + (i === n - 1 ? ' needle' : ''), messages: [{ role: 'user', content: 'hi ' + i }], updatedAt: n - i };
    }
    return out;
}

async function mount(chats, extra) {
    var s = U.stubs();
    var g = Object.assign({
        chats: chats, currentChatId: null, currentView: 'chat', chatSearchQuery: '', skills: {}, TOOLS: [], dashboardWidgets: {},
        escapeJsString: escJs, chatActivityTs: function(c) { return c.updatedAt || 0; },
        // Mirrors core/130-indexeddb.js chatMessageCount (skeleton-aware count).
        chatMessageCount: function(c) { return !c ? 0 : (Array.isArray(c.messages) ? c.messages.length : (c._msgCount || 0)); },
        chatHasPendingApproval: function() { return false; }, chatHasPendingItems: function() { return false; },
        selectChat: rec(), deleteChat: rec(), togglePinChat: rec(), renderMessages: rec(), closeModal: rec(),
        showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage, updateChatTitleHeader: rec(),
        showToolInspector: rec(), toggleSkillsView: rec(), openSkillEditor: rec(), toggleDashboardView: rec()
    }, extra || {});
    var m = await U.loadUi(MODS, { globals: g, allowUnstubbed: ALLOW });
    var dom = await U.mountDom({ body: true, css: CSS });
    return { m: m, g: g, dom: dom, s: m.__scope };
}

describe('sidebar render cap', function() {
    afterEach(function() { U.cleanupAll(); });

    test('renders only the first page + a Show more row; Show more adds a page', async function() {
        var t = await mount(makeChats(120));
        t.m.renderChatList();
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 50);
        var more = t.dom.$('#chat-list .chat-list-more');
        assert.ok(more, 'show-more row present');
        assert.match(more.textContent, /\(70\)/);
        assert.strictEqual(t.dom.$('#chat-list > .chat-item').getAttribute('data-chat-id'), 'c0', 'sort preserved');
        t.m.showMoreChatListItems();
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 100);
        t.m.showMoreChatListItems();
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 120);
        assert.strictEqual(t.dom.$('#chat-list .chat-list-more'), null, 'no show-more when all rendered');
    }, { tags: ['unit'] });

    test('active chat beyond the cap is still rendered and highlighted', async function() {
        var t = await mount(makeChats(120), { currentChatId: 'c99', currentView: 'chat' });
        t.m.renderChatList();
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 51);
        var act = t.dom.$('#chat-list > .chat-item.active');
        assert.ok(act, 'active row rendered');
        assert.strictEqual(act.getAttribute('data-chat-id'), 'c99');
        assert.match(t.dom.$('#chat-list .chat-list-more').textContent, /\(69\)/);
    }, { tags: ['unit'] });

    test('search runs over all chats (finds one beyond the cap)', async function() {
        var t = await mount(makeChats(120), { chatSearchQuery: 'needle' });
        t.m.renderChatList();
        var items = t.dom.$$('#chat-list > .chat-item');
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].getAttribute('data-chat-id'), 'c119');
    }, { tags: ['unit'] });

    test('small lists render fully with no Show more row', async function() {
        var t = await mount(makeChats(3));
        t.m.renderChatList();
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 3);
        assert.strictEqual(t.dom.$('#chat-list .chat-list-more'), null);
    }, { tags: ['unit'] });

    test('bursts of renderChatList coalesce into one trailing render with the final state', async function() {
        var chats = makeChats(3);
        var t = await mount(chats);
        for (var i = 0; i < 12; i++) {
            chats['n' + i] = { id: 'n' + i, title: 'New ' + i, messages: [{ role: 'user', content: 'x' }], updatedAt: 100 + i };
            t.m.renderChatList();
        }
        // First calls in the window rendered synchronously; the rest are deferred.
        assert.ok(t.dom.$$('#chat-list > .chat-item').length < 15, 'later burst calls deferred');
        await new Promise(function(r) { setTimeout(r, 250); });
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 15, 'trailing render shows final state');
        assert.strictEqual(t.dom.$('#chat-list > .chat-item').getAttribute('data-chat-id'), 'n11');
    }, { tags: ['unit'] });
});
