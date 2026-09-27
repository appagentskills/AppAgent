// Run: run_tests { files: ['test/widget-print.test.js'] } (js_eval sandbox; no Node).
// S0C2-02: the widget Print button must open the persistent app.html?widget=<id>&print=1
// deep link (real widget sandbox + csp-polyfill), never document.write() the widget
// into an about:blank popup where the MV3 CSP kills its scripts and inline handlers.
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var WG_FILES = ['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/core/135-widget-store.js', 'src/js/ui/070-dashboard-ui.js',
    'src/js/tools/080-widget-tools.js'];

describe('widget print (S0C2-02)', function() {
    afterEach(function() { U.cleanupAll(); });
    test('Print opens app.html?widget=w1&print=1 and never document.write()s a popup (S0C2-02)', async function() {
        var s = U.stubs();
        var created = [], opened = [], writes = [];
        var win = { document: document, _rawCopyStore: {}, addEventListener: function() {}, removeEventListener: function() {},
            open: function() {
                opened.push([].slice.call(arguments));
                return { document: { write: function(h) { writes.push(h); }, close: function() {} }, focus: function() {}, print: function() {} };
            } };
        var chromeStub = Object.assign({}, s.chrome, {
            tabs: { create: function(o) { created.push(o); return Promise.resolve({ id: 1 }); } },
            runtime: Object.assign({}, s.chrome && s.chrome.runtime, { getURL: function(p) { return 'chrome-extension://ext/' + p; } }) });
        var w = { id: 'w1', title: 'W', html: '<div>hi</div>' };
        var m = await U.loadUi(WG_FILES, { window: win, globals: { chats: { c1: { id: 'c1', widgets: [w], messages: [] } }, currentChatId: 'c1',
            chatWidgets: {}, dashboardWidgets: {}, dbName: 'uitest', BroadcastChannel: undefined, expandedWidgetId: null,
            saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar, chrome: chromeStub } });
        m.__scope.expandedWidgetId = 'w1';
        m.printWidgetFullscreen();
        assert.strictEqual(created.length, 1, 'opens exactly one tab');
        assert.strictEqual(created[0].url, 'chrome-extension://ext/app.html?widget=w1&print=1');
        assert.strictEqual(opened.length, 0, 'no about:blank popup');
        assert.strictEqual(writes.length, 0, 'no document.write');
    }, { tags: ['unit'] });

    test('120-init widget deep link prints when print=1 (S0C2-02, static)', async function() {
        var src = await loadFile('src/js/core/120-init.js');
        var a = src.indexOf('function _dlOnWidgetMsg');
        var b = src.indexOf("window.addEventListener('message', _dlOnWidgetMsg)");
        assert.strictEqual(a > 0 && b > a, true, 'deep-link widget message handler found');
        var body = src.slice(a, b);
        assert.strictEqual(body.indexOf("urlParams.get('print') === '1'") >= 0, true, 'print=1 is honoured after render');
        assert.strictEqual(body.indexOf('window.print()') >= 0, true, 'calls window.print()');
    }, { tags: ['unit'] });
});

// P1 (R-C2a follow-up to S0C2-02): the print tab kept the saved dark palette. Evaluates the
// REAL theme-load hunk of core/120-init.js (sliced from the source, same pattern as
// runDocDeepLink in test/sdoc-open-new-tab.test.js) with the REAL applyTheme (ui/240-layout.js,
// loaded like test/ui-shell-theme-views.test.js:40-54) against a saved theme of 'dark'.
describe('widget print › light palette (P1)', function() {
    var prevTheme;
    beforeEach(function() { prevTheme = document.documentElement.getAttribute('data-theme'); });
    afterEach(function() {
        U.cleanupAll();
        if (prevTheme == null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', prevTheme);
    });
    async function runThemeHunk(search) {
        var src = await loadFile('src/js/core/120-init.js', WS);
        var start = src.indexOf("var savedTheme = appStorage.getItem('appTheme');");
        var end = src.indexOf('// Restore sidebar state', start);
        assert.ok(start > 0 && end > start, '120-init has the theme-load hunk');
        var data = { appTheme: 'dark' }, writes = [];
        var appStorage = { getItem: function(k) { return k in data ? data[k] : null; },
            setItem: function(k, v) { writes.push(k); data[k] = String(v); }, removeItem: function(k) { writes.push(k); delete data[k]; } };
        var mq = { matches: false, addEventListener: function() {}, addListener: function() {} };
        var win = fakeWindow({ document: document, _rawCopyStore: {}, isRunning: false, matchMedia: function() { return mq; } });
        var m = await U.loadUi(['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/240-layout.js'], {
            globals: { window: win, appStorage: appStorage, appTheme: 'system', sidebarCollapsed: true, historyExpanded: true },
            lenient: true, allowUnstubbed: { indexOf: function() { return 0; } }, window: win });
        // The hunk's bare appTheme reads/writes go to the module scope the real applyTheme reads.
        var scope = { appStorage: appStorage, applyTheme: m.applyTheme, location: { search: search } };
        Object.defineProperty(scope, 'appTheme', { get: function() { return m.__scope.appTheme; }, set: function(v) { m.__scope.appTheme = v; } });
        new Function('__s', 'with (__s) {\n' + src.slice(start, end) + '\n}')(scope);
        return { theme: document.documentElement.getAttribute('data-theme'), appTheme: m.__scope.appTheme, stored: data.appTheme, writes: writes };
    }

    test('print=1 forces the light theme without persisting it', async function() {
        var p = await runThemeHunk('?widget=w1&print=1');
        assert.strictEqual(p.theme, 'light', 'the print tab renders on the light palette');
        assert.strictEqual(p.stored, 'dark', 'the stored appTheme is still dark');
        assert.strictEqual(p.appTheme, 'dark', 'the in-memory appTheme is not rewritten');
        assert.deepStrictEqual(p.writes, [], 'nothing is written to appStorage');
        var n = await runThemeHunk('?widget=w1');
        assert.strictEqual(n.theme, 'dark', 'without print=1 the saved dark theme still applies');
        // Static: the override comes after applyTheme(), inside the theme-load hunk.
        var src = await loadFile('src/js/core/120-init.js', WS);
        var iApply = src.indexOf('applyTheme();');
        var iOverride = src.indexOf("setAttribute('data-theme', 'light')");
        assert.ok(iApply > 0 && iOverride > iApply && iOverride < src.indexOf('// Restore sidebar state', iApply), 'the override follows applyTheme()');
    }, { tags: ['unit'] });
});
