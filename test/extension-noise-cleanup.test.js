// chrome://extensions error-noise cleanup: (1) content-script.js no longer builds
// the CSP-blocked inline interceptor <script> (background.js injectInterceptors()
// installs them in the MAIN world) but still collects what they post; (2) dashboard
// widget iframes drop the no-op allow-same-origin; (3) dropped warning toasts are
// logged with console.info, dropped error toasts keep console.warn.
// Run: run_tests { files: ['test/extension-noise-cleanup.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

describe('noise cleanup › content script interceptor', function() {
    test('creates no inline <script>, still collects console/network posts', async function() {
        var doc = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
        var scripts = [], listeners = [], messages = [];
        var create = doc.createElement.bind(doc);
        doc.createElement = function(tag) { var el = create(tag); if (String(tag).toLowerCase() === 'script') scripts.push(el); return el; };
        var w = { location: { href: 'https://fixture.invalid' }, innerWidth: 800, innerHeight: 600,
            addEventListener: function(type, fn) { if (type === 'message') messages.push(fn); },
            HTMLInputElement: HTMLInputElement, HTMLTextAreaElement: HTMLTextAreaElement };
        var m = await loadModules(['src/platform/extension/content-script.js'], { globals: { window: w, document: doc, Event: Event, KeyboardEvent: KeyboardEvent, MouseEvent: MouseEvent,
            chrome: { runtime: { onMessage: { addListener: function(fn) { listeners.push(fn); } } } } } });
        assert.strictEqual(scripts.length, 0, 'no inline interceptor script element');
        assert.strictEqual(doc.querySelector('script'), null);
        assert.strictEqual(w.__appagentInterceptorsActive, undefined, 'interceptor flag belongs to the MAIN-world injection only');
        assert.strictEqual(listeners.length, 1); assert.strictEqual(messages.length, 1);
        messages[0]({ source: w, data: { type: 'appagent-console', level: 'warn', message: 'hi' } });
        messages[0]({ source: w, data: { type: 'appagent-network', method: 'GET', url: 'https://fixture.invalid/x', status: 200, duration: 5 } });
        var ask = function(action) { var out = []; listeners[0]({ type: 'browser-action', action: action, args: {} }, {}, function(r) { out.push(r); }); return out[0]; };
        var logs = ask('get_console_logs').logs;
        assert.deepStrictEqual([logs.length, logs[0].level, logs[0].message], [1, 'warn', 'hi']);
        var reqs = ask('get_network_requests').requests;
        assert.deepStrictEqual([reqs.length, reqs[0].status, reqs[0].url], [1, 200, 'https://fixture.invalid/x']);
        assert.deepStrictEqual(m.__unstubbed, []);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('noise cleanup › snackbar drop logging', function() {
    afterEach(function() { U.cleanupAll(); });
    var FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
        'src/js/ui/220-notification-system.js', 'src/js/ui/230-modals.js', 'src/js/ui/225-approval-attention.js', 'src/js/ui/160-notifications.js'];
    var ALLOW = ['_teardownWorkerChatModal', 'startClaudeOAuthLogin', 'startChatGPTOAuthLogin', 'startApprovalTitleFlash', 'syncApprovalTitleFlash',
        'setActionNeedsPermission', 'clearActionNeedsPermission', '_refreshWaitingBadges', 'resolveRootChatId', 'pushPermissionsToOffscreen',
        'clearApprovalNotificationsForChat', '_chatsHydrated', 'getApprovalCardEl', 'settlePendingModalResolve', '_dismissedApprovalKeys',
        'smartDocuments', 'currentEditingWidget', 'AgentEvents', 'invalidateCreditsRequests'];
    async function load() {
        var s = U.stubs(), rec = U.recorder, con = { warn: rec(), info: rec(), log: function() {}, error: function() {} };
        await U.mountDom({ html: '<div id="snackbar"></div><div id="approval-card"></div><div id="modal-overlay"></div>' });
        var addDoc = document.addEventListener, added = [];
        document.addEventListener = function(t, f, o) { added.push([t, f, o]); return addDoc.call(document, t, f, o); };
        var m;
        try {
            m = await U.loadUi(FILES, { allowUnstubbed: ALLOW, globals: { console: con, setTimeout: function() { return 1; }, clearTimeout: function() {},
                setInterval: function() { return 1; }, clearInterval: function() {}, Platform: { instanceUrl: 'https://dev1.service-now.com', sendNotification: rec() },
                escapeJsString: function(x) { return String(x); }, screenshotModalKeyHandler: function() {}, screenshotNav: { list: [1], index: 0 },
                chats: {}, currentChatId: 'c1', currentView: 'chat', pendingToolApprovals: {}, sessionPermissions: {}, chatPermKey: function(r, k) { return r + '::' + k; },
                saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar, renderMessages: rec(), renderChatList: rec(), scrollToBottomIfAllowed: rec(),
                runAgent: rec(function() { return Promise.resolve(); }), selectChat: rec(), setToolPermissionByKey: rec(), chatPendingImages: {}, chatPendingTexts: {} } });
        } finally { document.addEventListener = addDoc; added.forEach(function(l) { document.removeEventListener(l[0], l[1], l[2]); }); }
        return { m: m, con: con };
    }
    test('hideSnackbar: queued warning -> console.info, queued error/legacy true -> console.warn', async function() {
        var t = await load();
        t.m.showSnackbar('On screen', 'error');
        t.m.showSnackbar('Queued warn', 'warning'); t.m.showSnackbar('Queued err', 'error'); t.m.showSnackbar('Queued legacy', true); t.m.showSnackbar('status', 'success');
        t.m.hideSnackbar();
        assert.strictEqual(t.con.warn.calls.length, 2, 'errors only');
        assert.match(t.con.warn.calls[0][0], /toast area cleared \u2014 unseen error toast never shown: Queued err/);
        assert.match(t.con.warn.calls[1][0], /unseen error toast never shown: Queued legacy/);
        assert.strictEqual(t.con.info.calls.length, 1, 'warning demoted to info; success dropped quietly');
        assert.match(t.con.info.calls[0][0], /toast area cleared \u2014 unseen warning toast never shown: Queued warn/);
    }, { tags: ['unit'], timeout: 5000 });
    test('queue full of pinned warnings: newcomer is logged via console.info, not warn', async function() {
        var t = await load();
        for (var i = 0; i <= 20; i++) t.m.showSnackbar('W' + i, 'warning');
        t.m.showSnackbar('W21', 'warning');
        assert.strictEqual(t.con.warn.calls.length, 0);
        assert.strictEqual(t.con.info.calls.length, 1);
        assert.match(t.con.info.calls[0][0], /queue full \(20 pinned toasts unread\).*W21/);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('noise cleanup › dashboard widget iframe sandbox', function() {
    afterEach(function() { U.cleanupAll(); var o = document.getElementById('widget-fullscreen-overlay'); if (o) o.remove(); });
    var W = { id: 'widget_a', title: 'Board', html: '<div>hi</div>', contentVersion: 1 };
    async function load() {
        var s = U.stubs(), L = [];
        var win = { document: document, _rawCopyStore: {}, open: function() { return null; },
            addEventListener: function(t, f) { L.push([t, f]); }, removeEventListener: function(t, f) { for (var i = L.length - 1; i >= 0; i--) if (L[i][1] === f) L.splice(i, 1); } };
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/core/135-widget-store.js', 'src/js/ui/070-dashboard-ui.js', 'src/js/tools/080-widget-tools.js'],
            { window: win, globals: { chats: {}, currentChatId: 'c1', chatWidgets: {}, dashboardWidgets: { widget_a: W }, dbName: 'uitest', BroadcastChannel: undefined,
                expandedWidgetId: null, saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar, chrome: s.chrome } });
        m.__scope.WidgetStore = { view: function(id) { return id === W.id ? Object.assign({}, W) : null; }, versions: function() { return [{ version: 1, createdAt: 1 }]; },
            project: function() {}, list: function() { return []; }, read: function() { return Promise.resolve(); } };
        m.__scope.registerWidgetInstance = U.recorder(function(f, id) { return id ? { instance_id: 'inst_' + id } : null; });
        m.__scope.unregisterWidgetInstance = U.recorder();
        m.__scope.escapeJsString = function(x) { return String(x).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c'); };
        return m;
    }
    function check(iframe) {
        assert.ok(iframe, 'iframe rendered');
        assert.strictEqual(iframe.getAttribute('sandbox'), 'allow-scripts allow-forms');
        assert.strictEqual(iframe.sandbox.contains('allow-same-origin'), false);
        assert.strictEqual(iframe.getAttribute('src'), 'widget-sandbox.html', 'still the manifest sandbox page');
    }
    test('renderWidgetContent (dashboard grid) frame has no allow-same-origin', async function() {
        var m = await load();
        var dom = await U.mountDom({ html: '<div id="dashboard-widget-content-widget_a"></div>' });
        m.renderWidgetContent(W);
        var host = dom.$('#dashboard-widget-content-widget_a .widget-shadow-host');
        check(host && host.shadowRoot && host.shadowRoot.querySelector('iframe.widget-iframe'));
    }, { tags: ['unit'], timeout: 5000 });
    test('expandDashboardWidget (fullscreen modal) frame has no allow-same-origin', async function() {
        var m = await load();
        m.expandDashboardWidget('widget_a');
        check(document.querySelector('#widget-fullscreen-overlay iframe.widget-iframe'));
    }, { tags: ['unit'], timeout: 5000 });
});
