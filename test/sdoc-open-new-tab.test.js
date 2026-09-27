// S0B4-02 / S0B4-03 — smart document "Open in new tab" (tools/110-smart-documents.js
// sdocOpenNewTab). It used to dump the panel CSS + rendered HTML into a Blob page
// opened with window.open: inline handlers were dead there (no panel functions, no
// csp-polyfill), collapsed content stayed hidden, and the blob URL (revoked after 60 s,
// dead with the side panel) broke reload / "Reopen closed tab" / session restore.
// It now opens the persistent app.html?doc=<id> deep link, rendered by core/120-init.js
// with the real app realm (handlers bound by the page's polyfill) + a print stylesheet.
// Run: run_tests { files: ['test/sdoc-open-new-tab.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

// Same real module set as test/ui-smart-docs-widgets.test.js:12-14.
var SD_FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/250-message-render.js', 'src/js/tools/090-display-templates.js',
    'src/js/tools/110-smart-documents.js'];

// Same loader pattern as loadSdoc in test/ui-smart-docs-widgets.test.js:40-55, plus
// spies on chrome.tabs.create, URL.createObjectURL (blob page) and window.open.
async function loadSdoc() {
    var s = U.stubs();
    var store = {};
    var appStorage = { getItem: function(k) { return k in store ? store[k] : null; }, setItem: function(k, v) { store[k] = String(v); }, removeItem: function(k) { delete store[k]; } };
    var create = U.recorder(), blobSpy = U.recorder(function() { return 'blob:sdoc-test'; }), openSpy = U.recorder(function() { return null; });
    var FakeURL = function(u, b) { return new URL(u, b); };
    FakeURL.createObjectURL = blobSpy;
    FakeURL.revokeObjectURL = U.recorder();
    var m = await U.loadUi(SD_FILES, {
        globals: { chats: {}, currentChatId: 'c1', activeStreamingChatId: null, showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage, appStorage: appStorage,
            chrome: { tabs: { create: create }, runtime: { getURL: function(p) { return 'chrome-extension://ext/' + p; } } },
            URL: FakeURL, Blob: function(parts, o) { this.parts = parts; this.type = o && o.type; } },
        window: { document: document, _rawCopyStore: {}, currentSearchHighlight: null, isRunning: false, open: openSpy,
            addEventListener: function() {}, removeEventListener: function() {} }
    });
    m.__scope.renderVersionSidebar = U.recorder();
    return { m: m, create: create, blobSpy: blobSpy, openSpy: openSpy };
}

// Evaluate the REAL ?doc= block of core/120-init.js (sliced from the source) against a
// detached fake body, so the page under test is never wiped.
async function runDocDeepLink(m, search, loadImpl, render) {
    var src = await loadFile('src/js/core/120-init.js', WS);
    var start = src.indexOf("var deepLinkDocId = urlParams.get('doc');");
    var end = src.indexOf('isInitialLoad = false;', start);
    assert.ok(start > 0 && end > start, '120-init has the ?doc= block before isInitialLoad = false');
    var body = document.createElement('div');
    body.innerHTML = '<div id="app-shell">panel UI</div>';
    var fakeDoc = { body: body, title: 'AppAgent', createElement: function(t) { return document.createElement(t); } };
    var errors = [], loads = [];
    var load = function(id) { loads.push(id); return loadImpl(id); };
    var fn = new Function('urlParams', 'smartDocuments', 'loadDocumentById', 'document', 'escDisplay', 'sdocRenderContent', 'console',
        src.slice(start, end) + '\nreturn "fell-through";');
    var ret = fn(new URLSearchParams(search), m.smartDocuments, load, fakeDoc, m.escDisplay, render || m.sdocRenderContent,
        { error: function() { errors.push(Array.prototype.slice.call(arguments).join(' ')); } });
    await new Promise(function(r) { setTimeout(r, 0); });
    return { ret: ret, body: body, doc: fakeDoc, errors: errors, loads: loads };
}

describe('smart docs › Open in new tab (S0B4-02/03)', function() {
    afterEach(function() { U.cleanupAll(); });

    test('Open in new tab uses the persistent app.html?doc= link, no blob/window.open (S0B4-02/03)', async function() {
        var t = await loadSdoc();
        t.m.smartDocuments.d1 = { id: 'd1', title: 'T', content: '# hi' };
        t.m.sdocOpenNewTab('d1');
        assert.strictEqual(t.create.calls.length, 1, 'one tab via chrome.tabs.create');
        assert.strictEqual(t.create.calls[0][0].url, 'chrome-extension://ext/app.html?doc=d1');
        assert.ok(/app\.html\?doc=d1$/.test(t.create.calls[0][0].url), 'url ends with app.html?doc=d1');
        assert.strictEqual(t.blobSpy.calls.length, 0, 'no blob URL (it died on reload/restore)');
        assert.strictEqual(t.openSpy.calls.length, 0, 'no window.open of an inert page');
        t.m.smartDocuments['a b&c'] = { id: 'a b&c', title: 'X', content: 'x' };
        t.m.sdocOpenNewTab('a b&c');
        assert.strictEqual(t.create.calls[1][0].url, 'chrome-extension://ext/app.html?doc=a%20b%26c', 'doc id is URL-encoded');
        t.m.sdocOpenNewTab('missing');
        assert.strictEqual(t.create.calls.length, 2, 'unknown doc: no tab (if (!doc) return; kept)');
    }, { tags: ['unit'] });

    test('120-init has a ?doc= deep link that loads the doc (S0B4-02, static)', async function() {
        var src = await loadFile('src/js/core/120-init.js', WS);
        assert.ok(src.indexOf("urlParams.get('doc')") >= 0, "reads urlParams.get('doc')");
        assert.ok(src.indexOf('loadDocumentById(deepLinkDocId)') >= 0, 'loads the persisted doc');
        assert.ok(src.indexOf('sdoc-standalone') >= 0, 'standalone body class');
        var css = await loadFile('src/css/21-display-templates.css', WS);
        assert.ok(/body\.sdoc-standalone\s*\{/.test(css), 'standalone page layout rule');
        assert.ok(/@media print\s*\{[\s\S]*\.sdoc-standalone \.code-block\.collapsed \{ max-height: none;[\s\S]*\.sdoc-standalone \.display-card-detail, \.sdoc-standalone \.display-tl-detail \{ display: block; \}/.test(css),
            'print expands collapsed code + card/timeline details');
    }, { tags: ['unit'] });

    test('?doc= deep link renders the persisted doc (escaped title, real sdocRenderContent) and stops the app boot', async function() {
        var t = await loadSdoc();
        var persisted = { id: 'd9', title: 'Plan <i>x</i>', currentContent: 'line one\n**bold** two', currentVersion: 1, versions: [], displays: {}, prompts: [] };
        var r = await runDocDeepLink(t.m, '?doc=d9', function(id) { return Promise.resolve(id === 'd9' ? persisted : null); });
        assert.strictEqual(r.ret, undefined, 'returns early like the widget deep link (no further panel boot)');
        assert.deepStrictEqual(r.loads, ['d9'], 'not cached in this fresh tab: loaded from IndexedDB');
        assert.deepStrictEqual(r.errors, []);
        assert.ok(r.body.classList.contains('sdoc-standalone'));
        assert.strictEqual(r.body.querySelector('#app-shell'), null, 'panel UI replaced by the document');
        var wrap = r.body.querySelector('.message-content');
        assert.ok(wrap, '.message-content wrapper');
        assert.strictEqual(wrap.querySelector('h1').textContent, 'Plan <i>x</i>', 'title escaped, not parsed');
        assert.strictEqual(wrap.querySelector('h1 i'), null);
        assert.ok(wrap.textContent.indexOf('bold two') >= 0, 'content rendered by the real sdocRenderContent');
        assert.strictEqual(r.doc.title, 'Plan <i>x</i>');

        t.m.smartDocuments.dc = { id: 'dc', title: 'Cached', currentContent: 'cached body', currentVersion: 1, versions: [], displays: {}, prompts: [] };
        var c = await runDocDeepLink(t.m, '?doc=dc', function() { return Promise.resolve(null); });
        assert.deepStrictEqual(c.loads, [], 'cached doc is used directly');
        assert.ok(c.body.querySelector('.message-content').textContent.indexOf('cached body') >= 0);

        var nf = await runDocDeepLink(t.m, '?doc=gone', function() { return Promise.resolve(null); });
        assert.strictEqual(nf.body.querySelector('.message-content').textContent, 'Document not found');
        assert.strictEqual(nf.body.querySelector('#app-shell'), null);

        var none = await runDocDeepLink(t.m, '?mode=tab', function() { return Promise.resolve(persisted); });
        assert.strictEqual(none.ret, 'fell-through', 'no ?doc=: normal boot continues');
        assert.deepStrictEqual(none.loads, []);
        assert.ok(none.body.querySelector('#app-shell'), 'panel UI untouched');
        assert.strictEqual(none.body.classList.contains('sdoc-standalone'), false);
    }, { tags: ['unit'] });

    // RC2A3-F1: the body was wiped before rendering, so a sdocRenderContent throw left a blank tab.
    test('?doc= render error shows an error, not a blank page', async function() {
        var t = await loadSdoc();
        var persisted = { id: 'd7', title: 'Seven', currentContent: 'x', currentVersion: 1, versions: [], displays: {}, prompts: [] };
        var r = await runDocDeepLink(t.m, '?doc=d7', function(id) { return Promise.resolve(id === 'd7' ? persisted : null); },
            function() { throw new Error('boom <b>x</b>'); });
        assert.strictEqual(r.ret, undefined, 'still stops the app boot');
        assert.strictEqual(r.errors.length, 1, 'the failure is logged once');
        assert.ok(r.body.classList.contains('sdoc-standalone'));
        assert.ok(r.body.textContent.indexOf('Could not render document: boom <b>x</b>') >= 0, 'error shown, not a blank page: ' + r.body.textContent);
        assert.strictEqual(r.body.querySelector('b'), null, 'error message escaped, not parsed');
        assert.strictEqual(r.body.querySelector('#app-shell'), null);
    }, { tags: ['unit'] });
});
