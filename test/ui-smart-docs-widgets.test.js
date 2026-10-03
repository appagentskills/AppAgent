// B4 — UI tests for smart documents (tools/110-smart-documents.js) and the
// html_widget host-side chrome (tools/080-widget-tools.js, ui/070-dashboard-ui.js,
// core/135-widget-store.js version picker). Real modules are loaded with
// U.loadUi, rendered into the REAL sandbox document, and driven through their
// inline handlers (U.fireInline) or real listeners. Real widget iframes cannot
// run here, so only the host side (frame attrs, picker, postMessage listeners)
// is exercised.
// Run: run_tests { files: ['test/ui-smart-docs-widgets.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var SD_FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/250-message-render.js', 'src/js/tools/090-display-templates.js',
    'src/js/tools/110-smart-documents.js'];
var WG_FILES = ['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/core/135-widget-store.js', 'src/js/ui/070-dashboard-ui.js',
    'src/js/tools/080-widget-tools.js'];
var HOSTILE = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
var HOUR = 3600000;

// ── local helpers (proposed for ui-helpers.js) ────────────────────────────
// Window stand-in whose add/removeEventListener are observable, so the
// widget 'message' listeners can be counted and invoked directly.
function listenerWindow() {
    var L = [];
    return { document: document, _listeners: L, _rawCopyStore: {},
        addEventListener: function(t, f) { L.push([t, f]); },
        removeEventListener: function(t, f) { for (var i = L.length - 1; i >= 0; i--) if (L[i][0] === t && L[i][1] === f) L.splice(i, 1); },
        open: function() { return null; },
        count: function(t) { return L.filter(function(l) { return l[0] === t; }).length; },
        dispatch: function(t, ev) { L.filter(function(l) { return l[0] === t; }).slice().forEach(function(l) { l[1](ev); }); } };
}
function sdocFixture(over) {
    var now = Date.now();
    return Object.assign({ id: 'doc_ui', title: 'Plan', currentContent: 'line one\n**bold** two', currentVersion: 3, scope: 'shared',
        versions: [{ version: 1, content: 'line one\nold two', author: 'agent', timestamp: now - 2 * HOUR },
            { version: 2, content: 'line one', author: 'user', timestamp: now - HOUR },
            { version: 3, content: 'line one\n**bold** two', author: 'agent', timestamp: now }],
        displays: {}, prompts: [], createdAt: now - 3 * HOUR, updatedAt: now }, over || {});
}
async function loadSdoc(docs, extra) {
    var s = U.stubs();
    var store = {};
    var appStorage = { getItem: function(k) { return k in store ? store[k] : null; }, setItem: function(k, v) { store[k] = String(v); }, removeItem: function(k) { delete store[k]; }, _store: store };
    var m = await U.loadUi(SD_FILES, { globals: Object.assign({ chats: {}, currentChatId: 'c1', activeStreamingChatId: null, showSnackbar: s.showSnackbar,
        saveChatsToStorage: s.saveChatsToStorage, appStorage: appStorage }, extra || {}) });
    m.__appStorage = appStorage;
    Object.keys(docs || {}).forEach(function(k) { m.smartDocuments[k] = docs[k]; });
    // persistence + unrelated re-render hooks → recorders (IndexedDB is opaque here)
    // saveDocument/loadDocumentById are declared in 110 itself, so they can't be
    // swapped from outside; they no-op/resolve null here (no IDB). Only the
    // cross-file hook renderVersionSidebar is a recorder.
    m.__scope.renderVersionSidebar = U.recorder();
    m.__stubs = s;
    return m;
}
async function mountDoc(m, doc) {
    var dom = await U.mountDom({ html: m.sdocRender(doc), css: ['src/css/00-tokens.css'] });
    return { dom: dom, c: dom.$('.sdoc') };
}
function shown(el) { return el.style.display !== 'none'; }

var W1 = { id: 'widget_a', title: 'Sales <b>board</b>', html: '<div>hi</div>', contentVersion: 2, msgIndex: 3, lastHeight: 120 };
function widgetStoreStub(widget) {
    return {
        view: function(id, v) { return id === widget.id ? Object.assign({}, widget, { contentVersion: v ? Number(v) : 2, html: v ? '<p>v' + v + '</p>' : widget.html }) : null; },
        versions: function(id) { return id === widget.id ? [{ version: 1, createdAt: 1 }, { version: 2, createdAt: 2 }] : []; },
        list: function() { return []; },
        read: function() { return Promise.resolve(); }
    };
}
async function loadWidgets(opts) {
    opts = opts || {};
    var s = U.stubs(), win = listenerWindow(), w = Object.assign({}, W1, opts.widget || {});
    var m = await U.loadUi(WG_FILES, { window: win, globals: { chats: { c1: { id: 'c1', widgets: [w], messages: [] } }, currentChatId: 'c1',
        chatWidgets: {}, dashboardWidgets: opts.dashboard || {}, dbName: 'uitest', BroadcastChannel: undefined, expandedWidgetId: null,
        saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar, chrome: s.chrome } });
    var sc = m.__scope;
    sc.WidgetStore = widgetStoreStub(w);
    sc.escapeJsString = function(x) { return String(x).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c'); };
    sc.registerWidgetInstance = U.recorder(function(iframe, id) { return id ? { instance_id: 'inst_' + id } : null; });
    sc.unregisterWidgetInstance = U.recorder();
    // 070-dashboard-ui.js registers its own global 'message' routers at load.
    return { m: m, s: s, win: win, w: w, base: win.count('message') };
}

describe('ui smart documents › sdocRender', function() {
    afterEach(function() { U.cleanupAll(); });
    test('header, version selector, actions, hidden diff/editor and escaped title', async function() {
        var doc = sdocFixture({ title: 'Plan ' + HOSTILE });
        var m = await loadSdoc({ doc_ui: doc });
        var b = U.frag(m.sdocRender(doc)), c = b.querySelector('.sdoc');
        assert.strictEqual(c.id, 'sdoc_doc_ui'); assert.strictEqual(c.getAttribute('data-doc-id'), 'doc_ui');
        assert.strictEqual(c.querySelector('.sdoc-title').textContent, 'Plan ' + HOSTILE);
        assert.strictEqual(c.querySelector('.sdoc-title-input').value, 'Plan ' + HOSTILE);
        assert.strictEqual(b.querySelector('img, script, [onerror]'), null, 'title escaped');
        assert.strictEqual(c.querySelector('.sdoc-version-badge').textContent, 'v3');
        var opts = Array.prototype.map.call(c.querySelectorAll('.sdoc-version-select option'), function(o) { return [o.value, o.textContent]; });
        assert.strictEqual(opts.length, 3, 'current + 2 older');
        assert.deepStrictEqual(opts[0], ['', 'v3']);
        assert.strictEqual(opts[1][0], '2'); assert.match(opts[1][1], /^v2 \u{1F464} 1h ago$/u);
        assert.strictEqual(opts[2][0], '1'); assert.match(opts[2][1], /^v1 \u{1F916} 2h ago$/u);
        var titles = Array.prototype.map.call(c.querySelectorAll('.sdoc-header-actions .sdoc-action-btn'), function(x) { return x.title; });
        assert.deepStrictEqual(titles, ['Edit', 'Edit with agent', 'Copy Markdown', 'Open in new tab', 'New chat']);
        c.querySelectorAll('.sdoc-action-btn').forEach(function(btn) { assert.ok(U.a11y(btn).hasName && btn.querySelector('svg'), 'icon button has title name'); });
        assert.strictEqual(c.querySelector('#sdoc_doc_ui-diff').style.display, 'none');
        assert.strictEqual(c.querySelector('#sdoc_doc_ui-edit').style.display, 'none');
        assert.strictEqual(c.querySelector('.sdoc-editor').value, doc.currentContent);
        assert.strictEqual(c.querySelector('.sdoc-body .message-content strong').textContent, 'bold', 'body is rendered markdown');
        assert.strictEqual(c.querySelector('.sdoc-prompts'), null, 'no prompts section without prompts');
    }, { tags: ['unit'] });

    test('hostile content is escaped in body and editor', async function() {
        var doc = sdocFixture({ currentContent: 'x ' + HOSTILE });
        var m = await loadSdoc({ doc_ui: doc });
        var b = U.frag(m.sdocRender(doc));
        assert.strictEqual(b.querySelector('img, script, [onerror]'), null);
        assert.match(b.querySelector('.sdoc-body').textContent, /<img src=x/);
        assert.strictEqual(b.querySelector('.sdoc-editor').value, 'x ' + HOSTILE);
    }, { tags: ['unit'] });

    test('embedded display placeholder renders the doc-local display', async function() {
        var doc = sdocFixture({ currentContent: 'Intro\n\n<!--display:dsp_ui1-->\n\nOutro',
            displays: { dsp_ui1: { template: 'table', args: { columns: ['Name', 'Qty'], rows: [['alpha', 1], ['beta<i>', 2]] } } } });
        var m = await loadSdoc({ doc_ui: doc });
        var body = U.frag(m.sdocRenderContent(doc));
        var table = body.querySelector('table');
        assert.ok(table, 'display table rendered in place of the placeholder');
        assert.match(table.textContent, /alpha/); assert.match(table.textContent, /beta<i>/);
        assert.strictEqual(table.querySelector('i'), null, 'display cells escaped');
        assert.ok(m._displayStore.dsp_ui1 && m._displayStore.dsp_ui1.template === 'table', 'display cached for formatContent');
        assert.ok(!/<!--display:dsp_ui1-->/.test(body.innerHTML), 'placeholder consumed');
        assert.match(body.textContent, /Intro[\s\S]*Outro/);
    }, { tags: ['unit'] });

    test('placeholder for an uncached doc shows a loading state and triggers a load', async function() {
        var m = await loadSdoc({});
        var b = U.frag(m.renderDocumentPlaceholder('doc_"x'));
        var el = b.querySelector('.sdoc-error');
        assert.ok(el); assert.strictEqual(el.getAttribute('data-doc-id'), 'doc_"x');
        assert.strictEqual(el.textContent, 'Loading document doc_"x\u2026');
    }, { tags: ['unit'] });
});

describe('ui smart documents › inline editing and compare', function() {
    afterEach(function() { U.cleanupAll(); });
    test('Edit toggles editor on, focuses it, Cancel restores the view', async function() {
        var doc = sdocFixture();
        var m = await loadSdoc({ doc_ui: doc });
        var t = await mountDoc(m, doc), c = t.c;
        var body = c.querySelector('.sdoc-body'), edit = c.querySelector('.sdoc-edit'), editor = c.querySelector('.sdoc-editor');
        editor.value = 'stale'; var focus = editor.focus = U.recorder();
        U.fireInline(c.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        assert.ok(shown(edit)); assert.ok(!shown(body)); assert.ok(c.classList.contains('sdoc-editing'));
        assert.strictEqual(editor.value, doc.currentContent, 'editor reloaded from doc');
        assert.strictEqual(focus.calls.length, 1, 'editor focused');
        U.fireInline(c.querySelector('.sdoc-edit-actions button:last-child'), 'click', m);
        assert.ok(!shown(edit)); assert.ok(shown(body)); assert.ok(!c.classList.contains('sdoc-editing'));
        U.fireInline(c.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        U.fireInline(c.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        assert.ok(!shown(edit) && shown(body), 'Edit is a toggle');
    }, { tags: ['unit'] });

    test('Save creates a user version, persists and re-renders; unchanged save only closes', async function() {
        var doc = sdocFixture();
        var m = await loadSdoc({ doc_ui: doc });
        var t = await mountDoc(m, doc);
        U.fireInline(t.c.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        await U.fireInline(t.dom.$('.sdoc-edit-actions .primary'), 'click', m).result;
        assert.strictEqual(doc.currentVersion, 3, 'no-op save does not bump');
        assert.ok(!shown(t.dom.$('.sdoc-edit')));
        U.fireInline(t.dom.$('.sdoc-action-btn[title="Edit"]'), 'click', m);
        t.dom.$('.sdoc-editor').value = 'brand **new**';
        t.dom.$('.sdoc-title-input').value = '  Renamed  ';
        await U.fireInline(t.dom.$('.sdoc-edit-actions .primary'), 'click', m).result;
        assert.strictEqual(doc.currentVersion, 4); assert.strictEqual(doc.title, 'Renamed');
        var last = doc.versions[doc.versions.length - 1];
        assert.strictEqual(last.author, 'user'); assert.strictEqual(last.content, 'brand **new**');
        var fresh = t.dom.$('.sdoc');
        assert.strictEqual(fresh.querySelector('.sdoc-version-badge').textContent, 'v4', 're-rendered in place');
        assert.strictEqual(fresh.querySelector('.sdoc-title').textContent, 'Renamed');
        assert.strictEqual(fresh.querySelector('.sdoc-body strong').textContent, 'new');
        assert.ok(!fresh.classList.contains('sdoc-editing'));
        assert.match(fresh.querySelector('.sdoc-version-select option[value="3"]').textContent, /^v3 /);
    }, { tags: ['unit'] });

    test('version select shows a diff; empty value returns to the body', async function() {
        var doc = sdocFixture();
        var m = await loadSdoc({ doc_ui: doc });
        var t = await mountDoc(m, doc), c = t.c, sel = c.querySelector('.sdoc-version-select');
        sel.value = '1';
        U.fireInline(sel, 'change', m);
        var diff = c.querySelector('.sdoc-diff');
        assert.ok(shown(diff)); assert.ok(!shown(c.querySelector('.sdoc-body'))); assert.ok(c.classList.contains('sdoc-diffing'));
        assert.strictEqual(diff.querySelector('.sdoc-diff-old').textContent, 'v1 (agent)');
        assert.strictEqual(diff.querySelector('.sdoc-diff-new').textContent, 'v3 (current)');
        var lines = Array.prototype.map.call(diff.querySelectorAll('.sdoc-diff-line'), function(l) {
            return l.className.replace('sdoc-diff-line ', '') + '|' + l.querySelector('.sdoc-diff-prefix').textContent + '|' + l.querySelector('.sdoc-diff-text').textContent; });
        assert.deepStrictEqual(lines, ['sdoc-line-ctx| |line one', 'sdoc-line-del|-|old two', 'sdoc-line-add|+|**bold** two']);
        U.fireInline(c.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        assert.ok(!shown(diff) && !c.classList.contains('sdoc-diffing'), 'editing hides the diff');
        sel.value = ''; U.fireInline(sel, 'change', m);
        assert.ok(shown(c.querySelector('.sdoc-body')));
    }, { tags: ['unit'] });

    test('sdocRenderDiff escapes hostile lines and labels', async function() {
        var m = await loadSdoc({});
        var b = U.frag(m.sdocRenderDiff(['same', HOSTILE], ['same', 'ok'], '<b>old</b>', 'new'));
        assert.strictEqual(b.querySelector('img, script, b'), null);
        assert.strictEqual(b.querySelector('.sdoc-diff-old').textContent, '<b>old</b>');
        assert.strictEqual(b.querySelector('.sdoc-diff-arrow').textContent, '\u2192');
        assert.strictEqual(b.querySelector('.sdoc-line-del .sdoc-diff-text').textContent, HOSTILE);
        assert.strictEqual(b.querySelectorAll('.sdoc-line-add').length, 1);
    }, { tags: ['unit'] });
});

describe('ui smart documents › non-blocking prompts', function() {
    afterEach(function() { U.cleanupAll(); });
    function promptDoc(status) {
        return sdocFixture({ prompts: [{ id: 'p1', title: 'Pick <u>one</u>', description: 'Use **care** ' + HOSTILE, status: status || 'pending',
            responses: status === 'answered' ? { env: 'prod', note: 'n1' } : {},
            fields: [{ name: 'env', type: 'select', label: 'Env', options: ['dev', { value: 'prod', label: 'Production' }], value: 'dev' },
                { name: 'note', type: 'textarea', label: 'Note <i>' }, { name: 'ok', type: 'boolean', label: 'Agree', value: true },
                { name: 'n', type: 'number', label: 'Count', placeholder: 'e.g. 3' }, { name: 'who', label: 'Who', value: 'me' }] }] });
    }
    test('fields render per type with labels, defaults and escaping', async function() {
        var doc = promptDoc();
        var m = await loadSdoc({ doc_ui: doc });
        var b = U.frag(m.sdocRender(doc));
        assert.strictEqual(b.querySelector('.sdoc-prompts-title').textContent, 'Questions');
        var item = b.querySelector('.sdoc-prompt-item');
        assert.ok(!item.classList.contains('answered'));
        assert.strictEqual(item.querySelector('.sdoc-prompt-item-title').textContent, 'Pick <u>one</u>');
        assert.strictEqual(item.querySelector('.sdoc-prompt-item-desc.markdown-body strong').textContent, 'care');
        assert.strictEqual(b.querySelector('img, script, u, i'), null, 'title/desc/labels escaped');
        var form = item.querySelector('form#sdoc-prompt-p1.sdoc-prompt-form');
        assert.ok(form);
        var sel = form.querySelector('select[data-field-name="env"]');
        assert.deepStrictEqual(Array.prototype.map.call(sel.options, function(o) { return o.value + ':' + o.textContent; }), ['dev:dev', 'prod:Production']);
        assert.strictEqual(sel.value, 'dev');
        assert.strictEqual(form.querySelector('textarea[data-field-name="note"]').getAttribute('data-field-type'), 'textarea');
        assert.strictEqual(form.querySelector('input[type="checkbox"][data-field-name="ok"]').checked, true);
        var num = form.querySelector('input[data-field-name="n"]');
        assert.strictEqual(num.type, 'number'); assert.strictEqual(num.placeholder, 'e.g. 3');
        assert.strictEqual(form.querySelector('input[data-field-name="who"]').type, 'text');
        assert.strictEqual(form.querySelector('input[data-field-name="who"]').value, 'me');
        var labels = Array.prototype.map.call(form.querySelectorAll('.sdoc-prompt-label'), function(l) { return l.textContent; });
        assert.deepStrictEqual(labels, ['Env', 'Note <i>', 'Agree', 'Count', 'Who']);
        var btn = form.querySelector('button[type="submit"]');
        assert.strictEqual(btn.textContent, 'Submit'); assert.strictEqual(form.querySelector('.sdoc-prompt-answered'), null);
    }, { tags: ['unit'] });

    test('answered prompt shows saved responses, Update label and Saved marker', async function() {
        var doc = promptDoc('answered');
        var m = await loadSdoc({ doc_ui: doc });
        var b = U.frag(m.sdocRender(doc));
        assert.ok(b.querySelector('.sdoc-prompt-item').classList.contains('answered'));
        assert.strictEqual(b.querySelector('select[data-field-name="env"]').value, 'prod', 'response wins over default');
        assert.strictEqual(b.querySelector('textarea[data-field-name="note"]').value, 'n1');
        assert.strictEqual(b.querySelector('button[type="submit"]').textContent, 'Update');
        assert.strictEqual(b.querySelector('.sdoc-prompt-answered').textContent, '✓ Saved');
    }, { tags: ['unit'] });

    test('submit collects every field, marks answered, persists, toasts and re-renders', async function() {
        var doc = promptDoc();
        var m = await loadSdoc({ doc_ui: doc });
        var t = await mountDoc(m, doc), form = t.dom.$('#sdoc-prompt-p1');
        form.querySelector('select').value = 'prod';
        form.querySelector('textarea').value = 'typed';
        form.querySelector('input[type="checkbox"]').checked = false;
        form.querySelector('input[data-field-name="n"]').value = '7';
        var info = U.fireInline(form, 'submit', m);
        assert.ok(info.prevented, 'native submit prevented');
        var p = doc.prompts[0];
        assert.strictEqual(p.status, 'answered');
        assert.deepStrictEqual(p.responses, { env: 'prod', note: 'typed', ok: false, n: '7', who: 'me' });
        assert.deepStrictEqual(m.__stubs.showSnackbar.calls[0], ['Response saved', 'success']);
        assert.strictEqual(t.dom.$('#sdoc-prompt-p1 button[type="submit"]').textContent, 'Update', 're-rendered');
        assert.ok(t.dom.$('.sdoc-prompt-item').classList.contains('answered'));
    }, { tags: ['unit'] });

    test('input marks fields dirty; re-render keeps drafts but takes fresh untouched defaults', async function() {
        var doc = promptDoc();
        var m = await loadSdoc({ doc_ui: doc });
        var t = await mountDoc(m, doc), form = t.dom.$('#sdoc-prompt-p1');
        var note = form.querySelector('textarea');
        note.value = 'my draft';
        U.fireInline(form, 'input', m, { target: note });
        assert.strictEqual(note.getAttribute('data-sdoc-dirty'), '1');
        assert.strictEqual(form.querySelector('input[data-field-name="who"]').hasAttribute('data-sdoc-dirty'), false);
        doc.prompts[0].fields[4].value = 'agent-updated';
        m.sdocReRenderAll('doc_ui');
        var fresh = t.dom.$('#sdoc-prompt-p1');
        assert.notStrictEqual(fresh, form, 'form replaced');
        assert.strictEqual(fresh.querySelector('textarea').value, 'my draft', 'draft carried');
        assert.strictEqual(fresh.querySelector('textarea').getAttribute('data-sdoc-dirty'), '1');
        assert.strictEqual(fresh.querySelector('input[data-field-name="who"]').value, 'agent-updated', 'untouched field refreshed');
    }, { tags: ['unit'] });
});

describe('ui smart documents › documents page and preview modal', function() {
    afterEach(function() { U.cleanupAll(); var p = document.getElementById('sdoc-preview-modal'); if (p) p.remove(); });
    test('empty state with New Document action', async function() {
        var m = await loadSdoc({ c1: sdocFixture({ id: 'c1', scope: 'chat' }) });
        var dom = await U.mountDom({ html: '<button id="documents-toggle-sidebar-btn"></button><div id="documents-list"></div>' });
        m.renderDocumentsPage();
        assert.strictEqual(dom.$('.sdoc-page-empty-title').textContent, 'No documents yet', 'chat-scoped docs are not listed');
        assert.strictEqual(dom.$('#documents-count').textContent, '0 documents');
        var btn = dom.$('.sdoc-page-empty button');
        assert.match(btn.textContent, /New Document/);
        m.sdocCreateFromPage = U.recorder();
        U.fireInline(btn, 'click', m);
        assert.strictEqual(m.sdocCreateFromPage.calls.length, 1);
        assert.ok(dom.$('#documents-toggle-sidebar-btn svg'), 'sidebar toggle icon set');
    }, { tags: ['unit'] });

    test('cards sorted by recency with escaped title, stats and stopPropagation actions', async function() {
        var now = Date.now();
        var a = sdocFixture({ id: 'doc_a', title: 'Older ' + HOSTILE, updatedAt: now - 5 * HOUR, currentContent: '# Head\n*x*' });
        var b = sdocFixture({ id: 'doc_b', title: 'Newer', updatedAt: now, currentVersion: 1,
            versions: [{ version: 1, content: 'c', author: 'user', timestamp: now }] });
        var m = await loadSdoc({ doc_a: a, doc_b: b, doc_c: sdocFixture({ id: 'doc_c', scope: 'chat' }) });
        var dom = await U.mountDom({ html: '<div id="documents-list"></div>' });
        m.renderDocumentsPage();
        var cards = dom.$$('.sdoc-lib-item');
        assert.strictEqual(cards.length, 2);
        assert.strictEqual(cards[0].querySelector('.sdoc-lib-title').textContent, 'Newer');
        assert.strictEqual(cards[1].querySelector('.sdoc-lib-title').textContent, 'Older ' + HOSTILE);
        assert.strictEqual(dom.$('img, script'), null);
        assert.strictEqual(cards[0].querySelector('.sdoc-version-badge').textContent, 'v1');
        assert.strictEqual(cards[0].querySelector('.sdoc-lib-versions').textContent, '1 version');
        assert.match(cards[0].querySelector('.sdoc-lib-author').textContent, /\u{1F464} user/u);
        assert.strictEqual(cards[1].querySelector('.sdoc-lib-versions').textContent, '3 versions');
        assert.strictEqual(cards[1].querySelector('.sdoc-lib-preview').textContent, 'Head  x', 'markdown chars stripped from preview');
        assert.match(cards[1].querySelector('.sdoc-lib-date').textContent, /5h ago/);
        assert.strictEqual(cards[0].querySelector('.sdoc-scope-badge').textContent, 'Shared');
        var acts = Array.prototype.map.call(cards[0].querySelectorAll('.sdoc-lib-actions .widget-library-btn'), function(x) { return x.title; });
        assert.deepStrictEqual(acts.slice(-2), ['Export', 'Delete']);
        assert.match(cards[0].querySelector('.sdoc-start-chat-btn').title, /^Start a chat about /);
        assert.ok(cards[0].querySelector('.widget-library-btn.danger[title="Delete"]'));
        assert.strictEqual(dom.$('#documents-count').textContent, '2 documents');
        m.sdocDeleteFromPage = U.recorder();
        var info = U.fireInline(cards[0].querySelector('[title="Delete"]'), 'click', m);
        assert.ok(info.stopped, 'delete does not open the card');
        assert.deepStrictEqual(m.sdocDeleteFromPage.calls[0], ['doc_b']);
    }, { tags: ['unit'] });
    test('S0C5-02 (b): the Delete Document confirm escapes the title; cancel keeps the doc', async function() {
        var confirm = U.recorder(function() { return Promise.resolve(false); });
        var m = await loadSdoc({ doc_x: sdocFixture({ id: 'doc_x', title: 'notes<script>.md' }) }, { showConfirmModal: confirm });
        await m.sdocDeleteFromPage('doc_x');
        assert.deepStrictEqual(confirm.calls[0], ['Delete Document', 'Delete "notes&lt;script&gt;.md" and all its versions? This cannot be undone.', 'danger']);
        assert.ok(m.smartDocuments.doc_x, 'cancel keeps the document');
        assert.strictEqual(m.__stubs.showSnackbar.calls.length, 0, 'no Document deleted snackbar');
    }, { tags: ['unit'] });

    test('card click opens the preview modal; close button, backdrop and Escape close it', async function() {
        var doc = sdocFixture();
        var m = await loadSdoc({ doc_ui: doc });
        var dom = await U.mountDom({ html: '<div id="documents-list"></div>' });
        m.renderDocumentsPage();
        U.fireInline(dom.$('.sdoc-lib-item'), 'click', m);
        var modal = document.getElementById('sdoc-preview-modal');
        assert.ok(modal && modal.classList.contains('sdoc-preview-overlay'));
        assert.ok(modal.querySelector('.sdoc-preview-container .sdoc[data-doc-id="doc_ui"]'));
        var close = modal.querySelector('.sdoc-header-actions .sdoc-action-btn[title="Close"]');
        assert.ok(close && close.querySelector('svg'));
        // editing targets the modal instance (sdocGetContainer prefers the modal)
        modal.querySelector('.sdoc-editor').focus = function() {};
        U.fireInline(modal.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        assert.ok(modal.querySelector('.sdoc').classList.contains('sdoc-editing'));
        U.click(close);
        assert.strictEqual(document.getElementById('sdoc-preview-modal'), null, 'close button');
        m.sdocOpenPreview('doc_ui');
        U.click(document.querySelector('#sdoc-preview-modal .sdoc-title'));
        assert.ok(document.getElementById('sdoc-preview-modal'), 'inner click does not close');
        U.click(document.getElementById('sdoc-preview-modal'));
        assert.strictEqual(document.getElementById('sdoc-preview-modal'), null, 'backdrop click');
        m.sdocOpenPreview('doc_ui');
        U.key(document.body, 'a');
        assert.ok(document.getElementById('sdoc-preview-modal'), 'other keys ignored');
        U.key(document.body, 'Escape');
        assert.strictEqual(document.getElementById('sdoc-preview-modal'), null, 'Escape');
    }, { tags: ['unit'] });

    test('doc id with a quote breaks out of inline onclick handlers (110-smart-documents.js:419-423,1034-1036,1055)', async function() {
        // escDisplay (tools/090-display-templates.js:131) does not escape `'`, and the
        // HTML entity layer is decoded before the handler JS runs. Imported docs
        // (importDocuments, :1157) keep arbitrary ids.
        // Payload runs during ARGUMENT evaluation (before the handler body can
        // throw) and writes to the module scope (not the fake window) so the
        // injection is observable; the button must exist (no vacuous pass).
        var id = "x'+(__sdocPwn=1)+'";
        var doc = sdocFixture({ id: id });
        var m = await loadSdoc({}); m.smartDocuments[id] = doc;
        var t = await mountDoc(m, doc);
        var btn = t.dom.$('.sdoc-action-btn[title="Edit"]');
        assert.ok(btn, 'Edit button rendered');
        m.__scope.__sdocPwn = 0;
        try { U.fireInline(btn, 'click', m); } catch (e) {}
        assert.strictEqual(m.__scope.__sdocPwn, 0, 'id must not execute as code');
    }, { tags: ['unit'] });

    test('imported version author / currentVersion are not escaped (110-smart-documents.js:407,416,1047,1059)', async function() {
        var doc = sdocFixture({ currentVersion: '<img src=x>', versions: [{ version: 1, content: '', author: '<b>evil</b>', timestamp: Date.now() }] });
        var m = await loadSdoc({ doc_ui: doc });
        var dom = await U.mountDom({ html: '<div id="documents-list"></div>' });
        m.renderDocumentsPage();
        assert.strictEqual(dom.$('#documents-list b, #documents-list img'), null);
    }, { tags: ['unit'] });

    test('search filters by title and content, shows count and a no-results state', async function() {
        var now = Date.now();
        var m = await loadSdoc({
            d1: sdocFixture({ id: 'd1', title: 'Release plan', currentContent: 'ship it', updatedAt: now }),
            d2: sdocFixture({ id: 'd2', title: 'Notes', currentContent: 'the Release checklist lives here', updatedAt: now - HOUR }),
            d3: sdocFixture({ id: 'd3', title: 'Budget', currentContent: 'numbers', updatedAt: now - 2 * HOUR }) });
        var dom = await U.mountDom({ html: '<div id="documents-list"></div>' });
        m.renderDocumentsPage();
        var input = dom.$('.sdoc-page-search-input');
        assert.ok(input && dom.$('.widget-library-search') && dom.$('.sdoc-page-toolbar.widget-library-header'), 'dashboard search chrome reused');
        input.value = '  RELEASE ';
        U.fireInline(input, 'input', m);
        var ids = dom.$$('.sdoc-lib-item').map(function(x) { return x.getAttribute('data-doc-id'); });
        assert.deepStrictEqual(ids, ['d1', 'd2'], 'title match + content match, recency order');
        assert.strictEqual(dom.$('#documents-count').textContent, '2 of 3');
        // re-render (e.g. agent updated a doc) keeps the toolbar/input and the filter
        m.renderDocumentsPage();
        assert.strictEqual(dom.$('.sdoc-page-search-input'), input, 'toolbar not rebuilt');
        assert.strictEqual(dom.$$('.sdoc-lib-item').length, 2);
        input.value = 'zzz<b>';
        U.fireInline(input, 'input', m);
        assert.strictEqual(dom.$$('.sdoc-lib-item').length, 0);
        assert.strictEqual(dom.$('.sdoc-page-empty-title').textContent, 'No documents match \u201czzz<b>\u201d');
        assert.strictEqual(dom.$('#documents-list .sdoc-page-empty b'), null, 'query escaped');
        assert.strictEqual(dom.$('#documents-count').textContent, '0 of 3');
        input.value = '';
        U.fireInline(input, 'input', m);
        assert.strictEqual(dom.$$('.sdoc-lib-item').length, 3);
    }, { tags: ['unit'] });

    test('rows/gallery toggle switches layout, persists in appStorage and keeps actions working', async function() {
        var m = await loadSdoc({ doc_ui: sdocFixture() });
        var dom = await U.mountDom({ html: '<div id="documents-list"></div>' });
        m.renderDocumentsPage();
        var items = dom.$('#documents-items');
        assert.ok(items.classList.contains('layout-rows'), 'rows by default');
        assert.strictEqual(dom.$('.widget-library-layout-btn[data-layout="rows"]').getAttribute('aria-pressed'), 'true');
        U.fireInline(dom.$('.widget-library-layout-btn[data-layout="gallery"]'), 'click', m);
        assert.strictEqual(m.__appStorage.getItem('documentsPageLayout'), 'gallery');
        assert.ok(dom.$('#documents-items').classList.contains('layout-gallery'));
        assert.ok(dom.$('#documents-list').classList.contains('sdoc-page-gallery'));
        assert.strictEqual(dom.$('.widget-library-layout-btn[data-layout="gallery"]').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(dom.$('.widget-library-layout-btn[data-layout="rows"]').classList.contains('active'), false);
        // actions still wired in gallery
        m.sdocStartChat = U.recorder();
        var card = dom.$('.sdoc-lib-item');
        var info = U.fireInline(card.querySelector('.sdoc-start-chat-btn'), 'click', m);
        assert.ok(info.stopped); assert.deepStrictEqual(m.sdocStartChat.calls[0], ['doc_ui']);
        // sdocOpenPreview is called from inside the module, so observe the real modal
        U.fireInline(card, 'keydown', m, { key: 'Enter', target: card.querySelector('[title="Export"]') });
        assert.strictEqual(document.getElementById('sdoc-preview-modal'), null, 'Enter on an action button does not open the card');
        var kd = U.fireInline(card, 'keydown', m, { key: 'Enter' });
        assert.ok(kd.prevented, 'Enter handled');
        var modal = document.getElementById('sdoc-preview-modal');
        assert.ok(modal && modal.querySelector('.sdoc[data-doc-id="doc_ui"]'), 'Enter opens the preview');
        modal.remove();
        // persisted choice survives a fresh page render
        dom.$('#documents-list').innerHTML = '';
        m.renderDocumentsPage();
        assert.ok(dom.$('#documents-items').classList.contains('layout-gallery'), 'restored from appStorage');
        U.fireInline(dom.$('.widget-library-layout-btn[data-layout="rows"]'), 'click', m);
        assert.strictEqual(m.__appStorage.getItem('documentsPageLayout'), 'rows');
        assert.ok(dom.$('#documents-items').classList.contains('layout-rows'));
    }, { tags: ['unit'] });

    // A7A-01: a dirty edit in the preview asks before Esc / backdrop / Close drop it.
    function openDirtyPreview(m) {
        m.sdocOpenPreview('doc_ui');
        var modal = document.getElementById('sdoc-preview-modal');
        modal.querySelector('.sdoc-editor').focus = function() {};
        U.fireInline(modal.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        modal.querySelector('.sdoc-editor').value = 'draft';
        return modal;
    }
    test('A7A-01 dirty edit: Esc, backdrop and Close ask before discarding', async function() {
        var m = await loadSdoc({ doc_ui: sdocFixture() });
        var confirms = [], answer = false;
        m.__scope.showConfirmModal = async function(t, msg, v) { confirms.push([t, msg, v]); return answer; };
        var modal = openDirtyPreview(m);
        var acts = [['Escape', function() { U.key(document.body, 'Escape'); }], ['backdrop', function() { U.click(modal); }],
            ['Close', function() { U.click(modal.querySelector('.sdoc-header-actions .sdoc-action-btn[title="Close"]')); }]];
        for (var i = 0; i < acts.length; i++) {
            var label = acts[i][0];
            acts[i][1]();
            await U.flush(); await U.flush(); // past the macrotask reset of the pending-confirm flag
            assert.strictEqual(document.getElementById('sdoc-preview-modal'), modal, label + ': modal kept');
            assert.ok(modal.querySelector('.sdoc').classList.contains('sdoc-editing'), label + ': still editing');
            assert.strictEqual(modal.querySelector('.sdoc-editor').value, 'draft', label + ': draft kept');
            assert.strictEqual(confirms.length, i + 1, label + ': asked once');
            assert.strictEqual(confirms[i][2], 'warning');
        }
        assert.match(confirms[0][0], /Discard changes/);
        assert.match(confirms[0][1], /"Plan"/);
        answer = true;
        U.key(document.body, 'Escape');
        await U.flush();
        assert.strictEqual(document.getElementById('sdoc-preview-modal'), null, 'confirmed discard closes the preview');
        assert.strictEqual(confirms.length, 4);
    }, { tags: ['unit'] });

    test('A7A-01 Esc while the discard confirm is pending does not re-prompt', async function() {
        var m = await loadSdoc({ doc_ui: sdocFixture() });
        var confirms = [], pending = null;
        m.__scope.showConfirmModal = function(t, msg, v) { confirms.push([t, msg, v]); return new Promise(function(r) { pending = r; }); };
        // Stand-in for core/120-init.js's global Esc: registered first, it closes the
        // open confirm (resolves it as cancel) before the preview's own listener runs.
        function initEsc(e) { if (e.key === 'Escape' && pending) { var r = pending; pending = null; r(false); } }
        document.addEventListener('keydown', initEsc);
        try {
            var modal = openDirtyPreview(m);
            U.key(document.body, 'Escape'); // opens the confirm
            U.key(document.body, 'Escape'); // INIT closes it; the preview must not ask again
            await U.flush(); await U.flush();
            assert.strictEqual(confirms.length, 1, 'one confirm, no re-prompt');
            assert.strictEqual(document.getElementById('sdoc-preview-modal'), modal, 'modal kept');
            assert.strictEqual(modal.querySelector('.sdoc-editor').value, 'draft', 'draft kept');
        } finally {
            document.removeEventListener('keydown', initEsc);
            var p = document.getElementById('sdoc-preview-modal');
            if (p && p._escHandler) document.removeEventListener('keydown', p._escHandler);
        }
    }, { tags: ['unit'] });

    test('RF25-F1: the Discard changes confirm escapes the title; cancel keeps the doc and editor', async function() {
        var m = await loadSdoc({ doc_ui: sdocFixture({ title: '<b>Plan</b>' }) });
        var confirms = [];
        m.__scope.showConfirmModal = async function(t, msg, v) { confirms.push([t, msg, v]); return false; };
        try {
            var modal = openDirtyPreview(m);
            U.key(document.body, 'Escape');
            await U.flush(); await U.flush(); // past the macrotask reset of the pending-confirm flag
            assert.deepStrictEqual(confirms, [['Discard changes?', 'Unsaved edits to "&lt;b&gt;Plan&lt;/b&gt;" will be lost.', 'warning']]);
            assert.strictEqual(document.getElementById('sdoc-preview-modal'), modal, 'cancel keeps the preview');
            assert.ok(modal.querySelector('.sdoc').classList.contains('sdoc-editing'), 'still editing');
            assert.strictEqual(modal.querySelector('.sdoc-editor').value, 'draft', 'draft kept');
            assert.strictEqual(m.smartDocuments.doc_ui.title, '<b>Plan</b>', 'doc title unchanged');
        } finally {
            var p = document.getElementById('sdoc-preview-modal');
            if (p && p._escHandler) document.removeEventListener('keydown', p._escHandler);
        }
    }, { tags: ['unit'] });

    // A7A2-02: Create opens a never-saved blank doc in edit mode.
    async function freshCreate() {
        var un = U.recorder();
        var m = await loadSdoc({}, { newFileId: function() { return 'file_t'; }, registerFile: U.recorder(), unregisterFile: un });
        await U.mountDom({ html: '<div id="documents-list"></div>' });
        await m.sdocCreateFromPage();
        var id = Object.keys(m.smartDocuments)[0];
        var pm = document.getElementById('sdoc-preview-modal');
        assert.ok(id && pm && pm.querySelector('.sdoc.sdoc-editing'), 'Create opens the blank doc in edit mode');
        return { m: m, id: id, pm: pm, un: un };
    }
    function cancelBtn() { return document.querySelector('#sdoc-preview-modal .sdoc-edit .skills-action-btn:not(.primary)'); }
    test('A7A2-02 Cancel right after Create discards the blank doc', async function() {
        var f = await freshCreate();
        U.fireInline(cancelBtn(), 'click', f.m);
        await U.flush(); await U.flush();
        assert.strictEqual(f.m.smartDocuments[f.id], undefined, 'blank doc deleted');
        assert.strictEqual(document.getElementById('sdoc-preview-modal'), null, 'preview closed');
        assert.deepStrictEqual(f.un.calls, [['file_t']], 'file id unregistered');
    }, { tags: ['unit'] });

    test('A7A2-02 Esc right after Create discards the blank doc', async function() {
        var f = await freshCreate();
        U.key(document.body, 'Escape');
        await U.flush(); await U.flush();
        assert.strictEqual(f.m.smartDocuments[f.id], undefined, 'blank doc deleted');
        assert.strictEqual(document.getElementById('sdoc-preview-modal'), null, 'preview closed');
        assert.deepStrictEqual(f.un.calls, [['file_t']], 'file id unregistered');
    }, { tags: ['unit'] });

    test('A7A2-02 Save then Cancel keeps the doc', async function() {
        var f = await freshCreate();
        f.pm.querySelector('.sdoc-title-input').value = 'Named';
        await f.m.sdocSaveEdit(f.id, f.pm.querySelector('.sdoc-edit .skills-action-btn.primary'));
        U.fireInline(cancelBtn(), 'click', f.m);
        U.key(document.body, 'Escape');
        await U.flush(); await U.flush();
        assert.strictEqual(f.m.smartDocuments[f.id].title, 'Named', 'saved doc kept');
        // An unchanged Save (its no-change path runs sdocCancelEdit) is an explicit Save too.
        var g = await freshCreate();
        await g.m.sdocSaveEdit(g.id, g.pm.querySelector('.sdoc-edit .skills-action-btn.primary'));
        U.key(document.body, 'Escape');
        await U.flush(); await U.flush();
        assert.ok(g.m.smartDocuments[g.id], 'unchanged Save keeps the blank doc');
        assert.strictEqual(document.getElementById('sdoc-preview-modal'), null, 'Esc closes the preview');
        assert.strictEqual(f.un.calls.length + g.un.calls.length, 0, 'nothing unregistered');
    }, { tags: ['unit'] });

    test('A7A2-02 a version bump before Cancel keeps the doc', async function() {
        var f = await freshCreate();
        var d = f.m.smartDocuments[f.id];
        d.currentVersion = 2;
        d.versions.push({ version: 2, content: '', title: 'Untitled Document', author: 'agent', timestamp: Date.now() });
        U.fireInline(cancelBtn(), 'click', f.m);
        await U.flush(); await U.flush();
        assert.strictEqual(f.m.smartDocuments[f.id], d, 'doc kept');
        assert.ok(document.getElementById('sdoc-preview-modal'), 'Cancel only leaves edit mode');
        U.key(document.body, 'Escape');
        await U.flush(); await U.flush();
        assert.strictEqual(f.m.smartDocuments[f.id], d, 'closing afterwards keeps it too');
        assert.strictEqual(f.un.calls.length, 0, 'nothing unregistered');
    }, { tags: ['unit'] });
});

describe('ui html_widget › inline frame chrome', function() {
    afterEach(function() { U.cleanupAll(); ['widget-fullscreen-overlay', 'widget-modal-overlay'].forEach(function(id) { var o = document.getElementById(id); if (o) o.remove(); }); });
    test('message widget card: header, escaped title, expand control, content slot', async function() {
        var x = await loadWidgets();
        var html = x.m.getWidgetHtmlForMessage(3);
        assert.strictEqual(x.m.getWidgetHtmlForMessage(4), '', 'other messages get nothing');
        var b = U.frag(html), card = b.querySelector('.widget-inline');
        assert.strictEqual(card.id, 'widget-widget_a'); assert.strictEqual(card.getAttribute('data-widget-id'), 'widget_a');
        assert.ok(card.querySelector('.widget-header .widget-icon svg'));
        assert.strictEqual(card.querySelector('.widget-title').textContent, 'Sales <b>board</b>');
        assert.strictEqual(card.querySelector('.widget-title b'), null);
        var ex = card.querySelector('.widget-controls .widget-fullscreen-btn');
        assert.strictEqual(ex.title, 'Expand'); assert.ok(U.a11y(ex).hasName);
        assert.ok(card.querySelector('#widget-content-widget_a.widget-content'));
        assert.strictEqual(card.querySelector('.widget-content').children.length, 0);
    }, { tags: ['unit'] });

    test('renderWidgetInContainer: sandboxed frame attrs, version picker, resize messaging, cleanup', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: x.m.getWidgetHtmlForMessage(3) });
        var box = dom.$('#widget-content-widget_a');
        var iframe = x.m.renderWidgetInContainer(x.w, box);
        assert.strictEqual(iframe.className, 'widget-iframe');
        assert.strictEqual(iframe.getAttribute('src'), 'widget-sandbox.html');
        assert.strictEqual(iframe.getAttribute('allow'), 'fullscreen *'); assert.ok(!iframe.hasAttribute('allowfullscreen'), 'legacy allowfullscreen must not be set alongside allow (Chrome precedence warning)');
        assert.strictEqual(iframe.hasAttribute('scrolling'), false, 'inline frames can scroll');
        assert.strictEqual(iframe.style.height, '122px', 'lastHeight + 2 slack');
        assert.strictEqual(iframe.dataset.savedWidgetId, 'widget_a');
        assert.deepStrictEqual(x.m.__scope.registerWidgetInstance.calls[0].slice(1), ['widget_a']);
        assert.strictEqual(box.querySelector('select.widget-version-picker'), null, 'no picker row in the content');
        var picker = dom.$('.widget-header .widget-controls > select.widget-version-picker');
        assert.ok(picker, 'picker mounted in the header button group');
        assert.strictEqual(picker.parentNode.firstElementChild, picker, 'picker leads the header buttons');
        assert.ok(picker.nextElementSibling.classList.contains('widget-fullscreen-btn'), 'next to the Expand button');
        assert.strictEqual(picker.getAttribute('aria-label'), 'Widget version');
        assert.deepStrictEqual(Array.prototype.map.call(picker.options, function(o) { return o.value; }), ['', '2', '1']);
        assert.strictEqual(picker.options[0].textContent, 'Latest (v2)');
        assert.strictEqual(picker.value, '');
        assert.strictEqual(x.win.count('message'), x.base + 2, 'sandbox-ready + resize listeners');
        var src = iframe.contentWindow;
        x.win.dispatch('message', { source: {}, data: { type: 'widgetResize', height: 400 } });
        assert.strictEqual(iframe.style.height, '122px', 'foreign source ignored');
        x.win.dispatch('message', { source: src, data: { type: 'widgetResize', height: 300 } });
        assert.strictEqual(iframe.style.height, '302px');
        x.win.dispatch('message', { source: src, data: { type: 'widgetResize', height: 301 } });
        assert.strictEqual(iframe.style.height, '302px', 'within 2px slack: no feedback growth');
        x.win.dispatch('message', { source: src, data: { type: 'other', height: 900 } });
        assert.strictEqual(iframe.style.height, '302px');
        iframe.__widgetCleanup();
        assert.strictEqual(x.win.count('message'), x.base, 'cleanup releases listeners');
        x.win.dispatch('message', { source: src, data: { type: 'widgetResize', height: 700 } });
        assert.strictEqual(iframe.style.height, '302px', 'no resize after cleanup');
        assert.strictEqual(x.m.__scope.unregisterWidgetInstance.calls.length, 1);
    }, { tags: ['unit'] });

    test('version picker change swaps the render to that revision', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: x.m.getWidgetHtmlForMessage(3) });
        var iframe = x.m.renderWidgetInContainer(x.w, dom.$('#widget-content-widget_a'));
        U.input(dom.$('select.widget-version-picker'), '1');
        var frames = dom.$$('iframe.widget-iframe');
        assert.strictEqual(frames.length, 1); assert.notStrictEqual(frames[0], iframe, 'frame replaced');
        assert.strictEqual(frames[0].dataset.selectedWidgetVersion, '1');
        assert.strictEqual(frames[0].dataset.savedWidgetVersion, '1');
        var pickers = dom.$$('select.widget-version-picker');
        assert.strictEqual(pickers.length, 1, 'old picker removed');
        assert.strictEqual(pickers[0].value, '1');
        assert.ok(pickers[0].parentNode.classList.contains('widget-controls'), 'replacement picker stays in the header');
        assert.strictEqual(x.win.count('message'), x.base + 2, 'old listeners released, new ones bound');
    }, { tags: ['unit'] });

    // Per-turn edit renders: chat.widgetRenders refs (recordWidgetRender) put one
    // card per (widget, turn), each pinned to the version its save produced.
    async function loadPerTurn() {
        var x = await loadWidgets();
        var chat = x.m.__scope.chats.c1;
        chat.messages = [{ role: 'user' }, { role: 'tool', tool_call_id: 'tc1' }, { role: 'assistant' }, { role: 'tool', tool_call_id: 'tc2' }];
        chat.widgetRenders = {
            'tc1:widget_a': { id: 'widget_a', version: 1, msgIndex: 1, toolCallId: 'tc1' },
            'tc2:widget_a': { id: 'widget_a', version: 2, msgIndex: 3, toolCallId: 'tc2' }
        };
        var dom = await U.mountDom({ html: x.m.getWidgetHtmlForMessage(1) + x.m.getWidgetHtmlForMessage(3) });
        x.m.initializeWidgetsInView();
        return { x: x, dom: dom, chat: chat };
    }
    function cardFrame(dom, msg) { return dom.$('.widget-inline[data-render-msg="' + msg + '"] iframe.widget-iframe'); }
    function cardBadge(dom, msg) { return dom.$('.widget-inline[data-render-msg="' + msg + '"] .widget-version-badge'); }

    test('per-turn renders: one card per edit turn, newest keeps the canonical ids', async function() {
        var p = await loadPerTurn();
        var places = p.x.m.getWidgetPlacements('c1');
        assert.deepStrictEqual(places.map(function(q) { return [q.msgIndex, q.version, q.canonical, q.domKey]; }),
            [[3, 2, true, 'widget_a'], [1, 1, false, 'widget_a--r1']]);
        var cards = p.dom.$$('.widget-inline');
        assert.strictEqual(cards.length, 2);
        assert.deepStrictEqual(cards.map(function(c) { return [c.id, c.getAttribute('data-render-version')]; }),
            [['widget-widget_a--r1', '1'], ['widget-widget_a', '2']]);
        assert.ok(p.dom.$('#widget-content-widget_a--r1 iframe.widget-iframe'), 'older turn rendered');
        assert.ok(p.dom.$('#widget-content-widget_a iframe.widget-iframe'), 'newest turn rendered');
        // A ref whose tool row is gone (rewound turn) renders nowhere.
        p.chat.messages[1] = { role: 'user' };
        assert.deepStrictEqual(p.x.m.getWidgetPlacements('c1').map(function(q) { return q.msgIndex; }), [3]);
    }, { tags: ['unit'] });

    test('per-turn renders: each card stays pinned to its own version', async function() {
        var p = await loadPerTurn();
        var old = cardFrame(p.dom, 1), cur = cardFrame(p.dom, 3);
        assert.strictEqual(old.dataset.pinnedWidgetVersion, '1');
        assert.strictEqual(old.dataset.selectedWidgetVersion, '1');
        assert.strictEqual(old.dataset.savedWidgetVersion, '1', 'older turn shows v1 content');
        assert.strictEqual(cur.dataset.pinnedWidgetVersion, '2');
        assert.strictEqual(cur.dataset.savedWidgetVersion, '2');
        assert.strictEqual(p.dom.$('.widget-inline[data-render-msg="1"] select.widget-version-picker').value, '1');
    }, { tags: ['unit'] });

    test('per-turn renders: a legacy follow-latest render (no per-turn ref) gets no badge', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: x.m.getWidgetHtmlForMessage(3) });
        x.m.initializeWidgetsInView();
        assert.ok(dom.$('select.widget-version-picker'));
        assert.strictEqual(dom.$('.widget-version-badge'), null, 'unpinned render has no badge');
    }, { tags: ['unit'] });

    test('per-turn renders: badge text for latest vs stale', async function() {
        var p = await loadPerTurn();
        var cur = cardBadge(p.dom, 3), old = cardBadge(p.dom, 1);
        assert.strictEqual(cur.textContent, 'v2 (latest)');
        assert.ok(!cur.classList.contains('is-stale'));
        assert.strictEqual(cur.querySelector('.widget-version-show-latest'), null, 'no Show latest on the latest render');
        assert.strictEqual(old.querySelector('.widget-version-badge-label').textContent, 'v1 \u00b7 latest is v2');
        assert.ok(old.classList.contains('is-stale'));
        var btn = old.querySelector('button.widget-version-show-latest');
        assert.strictEqual(btn.textContent, 'Show latest');
        assert.strictEqual(btn.type, 'button');
        assert.strictEqual(old.nextElementSibling.tagName, 'SELECT', 'badge sits before the picker in the header');
    }, { tags: ['unit'] });

    test('per-turn renders: Show latest switches only that view', async function() {
        var p = await loadPerTurn();
        var old = cardFrame(p.dom, 1), cur = cardFrame(p.dom, 3);
        cardBadge(p.dom, 1).querySelector('.widget-version-show-latest').click();
        var swapped = cardFrame(p.dom, 1);
        assert.notStrictEqual(swapped, old, 'older turn frame replaced');
        assert.strictEqual(swapped.dataset.selectedWidgetVersion, '');
        assert.strictEqual(swapped.dataset.savedWidgetVersion, '2', 'now shows the latest content');
        assert.strictEqual(swapped.dataset.pinnedWidgetVersion, '1', 'pin kept (mount-local view only)');
        assert.strictEqual(cardBadge(p.dom, 1).textContent, 'v2 (latest)');
        assert.strictEqual(p.dom.$$('.widget-inline[data-render-msg="1"] .widget-version-badge').length, 1, 'old badge removed');
        assert.strictEqual(cardFrame(p.dom, 3), cur, 'other turn untouched');
        assert.strictEqual(cur.dataset.selectedWidgetVersion, '2');
        assert.strictEqual(cardBadge(p.dom, 3).textContent, 'v2 (latest)');
        assert.strictEqual(p.chat.widgetRenders['tc1:widget_a'].version, 1, 'nothing persisted');
    }, { tags: ['unit'] });

    test('headerless mount renders no version picker at all', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: '<div id="box"></div>' });
        var iframe = x.m.renderWidgetInContainer(x.w, dom.$('#box'));
        assert.strictEqual(dom.$$('select.widget-version-picker').length, 0);
        assert.strictEqual(dom.$('#box').children.length, 1, 'only the frame, no stray row');
        assert.strictEqual(iframe.dataset.savedWidgetId, 'widget_a', 'still tracked for Latest refresh');
    }, { tags: ['unit'] });

    test('thumbnail preview in a headed card renders no version picker', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: '<div class="widgets-container">' + x.m.getWidgetHtmlForMessage(3) + '</div>' });
        x.m.renderWidgetInContainer(x.w, dom.$('#widget-content-widget_a'));
        assert.strictEqual(dom.$$('select.widget-version-picker').length, 0);
    }, { tags: ['unit'] });

    test('thumbnail mount is a scaled, non-scrolling preview without resize binding', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: '<div class="widgets-container"><div id="thumb"></div></div>' });
        var iframe = x.m.renderWidgetInContainer(x.w, dom.$('#thumb'));
        assert.strictEqual(iframe.getAttribute('scrolling'), 'no');
        assert.match(iframe.style.transform, /scale\(0\.4\)/);
        assert.strictEqual(iframe.style.width, '250%');
        assert.strictEqual(x.win.count('message'), x.base + 1, 'only the sandbox-ready listener');
        assert.strictEqual(x.m.__scope.registerWidgetInstance.calls[0][1], null, 'preview not registered as live instance');
    }, { tags: ['unit'] });

    test('deactivate/activate toggle swaps content and control icon state', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: '<div id="widget-content-widget_a"></div><button class="widget-stop-btn" data-widget-id="widget_a"></button>' });
        x.m.renderWidgetInContainer(x.w, dom.$('#widget-content-widget_a'));
        x.m.toggleWidgetRunning('widget_a');
        assert.strictEqual(dom.$('#widget-content-widget_a iframe'), null);
        assert.strictEqual(dom.$('#widget-content-widget_a').textContent, 'Widget deactivated.');
        assert.strictEqual(dom.$('.widget-stop-btn').title, 'Activate Widget');
        assert.strictEqual(x.w.deactivated, true, 'state flag set for persistence');
        x.m.toggleWidgetRunning('widget_a');
        assert.ok(dom.$('#widget-content-widget_a iframe.widget-iframe'), 'reactivated');
        assert.strictEqual(dom.$('.widget-stop-btn').title, 'Deactivate Widget');
    }, { tags: ['unit'] });
});

// A6A3-01 / A6A2-01 — dashboard deactivate persistence + screenshot fallback cleanup.
describe('ui html_widget › dashboard deactivate + screenshot fallback', function() {
    afterEach(function() { U.cleanupAll(); var o = document.getElementById('widget-fullscreen-overlay'); if (o) o.remove(); });
    test('dashboard deactivate persists + survives re-render (A6A3-01)', async function() {
        var x = await loadWidgets({ dashboard: { widget_a: { id: 'widget_a', html: W1.html, dashboard: 'main' } } });
        var sc = x.m.__scope, saves = [];
        sc.WidgetStore.project = function() {};
        sc.saveDashboardWidget = function(w, skipHistory) { saves.push({ rec: Object.assign({}, w), same: w === sc.dashboardWidgets.widget_a, skipHistory: skipHistory }); return Promise.resolve(); };
        var dom = await U.mountDom({ html: '<div id="dashboard-widget-content-widget_a"></div>' });
        var box = dom.$('#dashboard-widget-content-widget_a');
        x.m.renderWidgetContent(sc.dashboardWidgets.widget_a);
        assert.ok(box.querySelector('.widget-shadow-host'), 'live before');
        x.m.toggleWidgetRunning('widget_a');
        assert.strictEqual(sc.dashboardWidgets.widget_a.deactivated, true, 'dashboard record flagged');
        assert.strictEqual(saves.length, 1, 'dashboard record persisted');
        assert.strictEqual(saves[0].same, true);
        assert.strictEqual(saves[0].skipHistory, true, 'no revision');
        assert.deepStrictEqual([saves[0].rec.id, saves[0].rec.html, saves[0].rec.dashboard, saves[0].rec.deactivated], ['widget_a', W1.html, 'main', true]);
        x.m.expandDashboardWidget('widget_a');
        var btn = document.querySelector('#widget-fullscreen-overlay .widget-stop-btn');
        assert.strictEqual(btn.title, 'Activate Widget');
        document.getElementById('widget-fullscreen-overlay').remove();
        x.m.renderWidgetContent(sc.dashboardWidgets.widget_a);
        assert.strictEqual(box.textContent, 'Widget deactivated.', 'grid re-render honours the flag');
        assert.strictEqual(box.querySelector('.widget-shadow-host'), null);
        x.m.toggleWidgetRunning('widget_a');
        assert.strictEqual(sc.dashboardWidgets.widget_a.deactivated, false);
        assert.strictEqual(x.w.deactivated, false);
        assert.ok(box.querySelector('.widget-shadow-host'), 'reactivated with the grid renderer');
        assert.strictEqual(saves.length, 2);
    }, { tags: ['unit'], timeout: 5000 });

    // NEW-T23-1: the chat fullscreen (openWidgetFullscreen) and its dashboard twin
    // (expandDashboardWidget) honour deactivation like the grid above: placeholder,
    // no live iframe (so no bridge 'message' listener), and an 'Activate Widget' button.
    test('NEW-T23-1: fullscreen and expanded views of a deactivated widget mount no iframe', async function() {
        var x = await loadWidgets({ dashboard: { widget_a: { id: 'widget_a', html: W1.html, title: 'T', dashboard: 'main' } } });
        var sc = x.m.__scope;
        sc.WidgetStore.project = function() {};
        sc.saveDashboardWidget = function() { return Promise.resolve(); };
        var views = { fullscreen: [x.m.openWidgetFullscreen, x.m.closeWidgetFullscreen], expand: [x.m.expandDashboardWidget, x.m.closeExpandedWidget] };
        function snap(name) {
            var base = x.win.count('message');
            views[name][0]('widget_a');
            var ov = document.getElementById('widget-fullscreen-overlay');
            var c = ov.querySelector('.widget-fullscreen-content');
            var r = [c.textContent, !!c.querySelector('iframe'), ov.querySelector('.widget-stop-btn').title, x.win.count('message') > base];
            views[name][1]();
            return r;
        }
        x.m.toggleWidgetRunning('widget_a');
        assert.strictEqual(x.m.isWidgetDeactivated('widget_a'), true);
        var DEAD = ['Widget deactivated.', false, 'Activate Widget', false];
        assert.deepStrictEqual(snap('fullscreen'), DEAD, 'chat fullscreen: placeholder, no iframe, no bridge listener');
        assert.deepStrictEqual(snap('expand'), DEAD, 'dashboard expand twin');
        x.m.toggleWidgetRunning('widget_a');
        assert.strictEqual(x.m.isWidgetDeactivated('widget_a'), false);
        assert.deepStrictEqual(snap('fullscreen').slice(1, 3), [true, 'Deactivate Widget'], 're-activated fullscreen mounts an iframe');
        assert.deepStrictEqual(snap('expand').slice(1, 3), [true, 'Deactivate Widget'], 're-activated expand mounts an iframe');
    }, { tags: ['unit'], timeout: 5000 });

    test('NEW-T23-1: chat fullscreen reads the merged flag (only the dashboard record is flagged)', async function() {
        var x = await loadWidgets({ dashboard: { widget_a: { id: 'widget_a', html: W1.html, dashboard: 'main', deactivated: true } } });
        assert.strictEqual(x.w.deactivated, undefined, 'chat copy not flagged');
        x.m.openWidgetFullscreen('widget_a');
        var ov = document.getElementById('widget-fullscreen-overlay');
        var c = ov.querySelector('.widget-fullscreen-content');
        assert.deepStrictEqual([c.textContent, c.querySelector('iframe'), ov.querySelector('.widget-stop-btn').title], ['Widget deactivated.', null, 'Activate Widget']);
    }, { tags: ['unit'], timeout: 5000 });

    test('screenshot fallback cleans up when capture fails (A6A2-01)', async function() {
        var x = await loadWidgets();
        var sc = x.m.__scope, ch = x.s.chrome, removed = [], sent = [];
        sc.chats.c1.targetTabId = 5;
        sc.getWidgetIframe = function() { return { contentDocument: null }; };
        ch.tabs.create = function() { return Promise.resolve({ id: 77 }); };
        ch.tabs.remove = function(id) { removed.push(id); };
        ch.tabs.onUpdated.addListener = function(fn) { setTimeout(function() { fn(77, { status: 'complete' }); }, 0); };
        ch.runtime.sendMessage = function(msg) { sent.push(msg); throw new Error('Extension context invalidated.'); };
        await x.m.screenshotWidget('widget_a');
        assert.strictEqual(sc.chats.c1.targetTabId, 5, 'viewed chat tab target untouched');
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].targetTabId, 77, 'temp tab targeted explicitly');
        assert.deepStrictEqual(removed, [77], 'temp tab closed');
        assert.deepStrictEqual(x.s.showSnackbar.calls[x.s.showSnackbar.calls.length - 1], ['Screenshot failed', 'error']);
        ch.tabs.create = function() { return Promise.reject(new Error('no tabs')); };
        await x.m.screenshotWidget('widget_a');
        assert.deepStrictEqual(removed, [77]);
        assert.deepStrictEqual(x.s.showSnackbar.calls[x.s.showSnackbar.calls.length - 1], ['Screenshot failed', 'error']);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('ui html_widget › fullscreen, pin and sidebar', function() {
    afterEach(function() { U.cleanupAll(); ['widget-fullscreen-overlay'].forEach(function(id) { var o = document.getElementById(id); if (o) o.remove(); }); });
    test('fullscreen header controls, pin state and close paths', async function() {
        var x = await loadWidgets();
        x.m.openWidgetFullscreen('widget_a');
        var ov = document.getElementById('widget-fullscreen-overlay');
        assert.ok(ov && ov.classList.contains('widget-fullscreen-overlay'));
        assert.strictEqual(x.m.__scope.expandedWidgetId, 'widget_a');
        var hdr = ov.querySelector('.widget-fullscreen-header');
        assert.strictEqual(hdr.querySelector('.widget-title').textContent, 'Sales <b>board</b>');
        assert.strictEqual(hdr.querySelector('.widget-title b'), null);
        var titles = Array.prototype.map.call(hdr.querySelectorAll('.widget-ctrl-btn'), function(b) { return b.title; });
        assert.deepStrictEqual(titles, ['Deactivate Widget', 'Pin to dashboard\u2026', 'Print', 'Screenshot', 'Open in new tab', 'Edit', 'Edit code']);
        assert.strictEqual(hdr.querySelector('.widget-stop-btn').getAttribute('data-widget-id'), 'widget_a');
        assert.ok(!hdr.querySelector('.widget-dashboard-btn').classList.contains('on-dashboard'));
        var frame = ov.querySelector('.widget-fullscreen-content iframe.widget-iframe');
        assert.strictEqual(frame.style.height, '100%', 'fills the modal');
        assert.strictEqual(x.win.count('message'), x.base + 2);
        U.fireInline(hdr.querySelector('.widget-close-btn'), 'click', m2(x));
        assert.strictEqual(document.getElementById('widget-fullscreen-overlay'), null);
        assert.strictEqual(x.win.count('message'), x.base, 'close runs frame cleanup');
        assert.strictEqual(x.m.__scope.expandedWidgetId, null);
        x.m.openWidgetFullscreen('widget_a');
        U.click(document.querySelector('.widget-fullscreen-header'));
        assert.ok(document.getElementById('widget-fullscreen-overlay'), 'header click keeps it open');
        U.click(document.getElementById('widget-fullscreen-overlay'));
        assert.strictEqual(document.getElementById('widget-fullscreen-overlay'), null, 'backdrop closes');
        x.m.openWidgetFullscreen('nope');
        assert.strictEqual(document.getElementById('widget-fullscreen-overlay'), null, 'unknown id is a no-op');
    }, { tags: ['unit'] });
    function m2(x) { return x.m; }

    test('pinned widget shows the filled pin state in fullscreen and sidebar', async function() {
        var x = await loadWidgets({ dashboard: { widget_a: { id: 'widget_a' } } });
        x.m.openWidgetFullscreen('widget_a');
        var pin = document.querySelector('#widget-fullscreen-overlay .widget-dashboard-btn');
        assert.ok(pin.classList.contains('on-dashboard')); assert.strictEqual(pin.title, 'Pinned \u2014 click to change');
        x.m.closeWidgetFullscreen();
        var dom = await U.mountDom({ html: '<div id="widget-sidebar-list"></div>' });
        x.m.renderWidgetSidebar();
        var sp = dom.$('.widget-sidebar-btn.widget-dashboard-btn');
        assert.ok(sp.classList.contains('on-dashboard')); assert.strictEqual(sp.title, 'Pinned \u2014 click to change');
    }, { tags: ['unit'] });

    test('sidebar entry: empty state, escaped title, actions routing and stopPropagation', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: '<div id="widget-sidebar-list"></div>' });
        var saved = x.m.__scope.chats.c1.widgets; x.m.__scope.chats.c1.widgets = [];
        x.m.renderWidgetSidebar();
        assert.strictEqual(dom.$('.widget-sidebar-empty').textContent, 'No widgets yet');
        x.m.__scope.chats.c1.widgets = saved;
        x.m.renderWidgetSidebar();
        var items = dom.$$('.widget-sidebar-item');
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].querySelector('.widget-sidebar-title').textContent, 'Sales <b>board</b>');
        assert.strictEqual(items[0].querySelector('.widget-sidebar-title b'), null);
        var btns = items[0].querySelectorAll('.widget-sidebar-actions button');
        assert.deepStrictEqual(Array.prototype.map.call(btns, function(b) { return b.title; }), ['Open in new tab', 'Pin to dashboard\u2026', 'Fullscreen']);
        Array.prototype.forEach.call(btns, function(b) { assert.ok(U.a11y(b).hasName && b.querySelector('svg')); });
        x.m.showWidgetPinMenu = U.recorder(); x.m.showWidgetInPanel = U.recorder(); x.m.openWidgetFullscreen = U.recorder(); x.m.scrollToWidget = U.recorder();
        var r = U.fireInline(btns[1], 'click', x.m);
        assert.strictEqual(x.m.showWidgetPinMenu.calls[0][0], 'widget_a'); assert.strictEqual(x.m.showWidgetPinMenu.calls[0][1], r.event);
        assert.ok(U.fireInline(btns[0], 'click', x.m).stopped); assert.deepStrictEqual(x.m.showWidgetInPanel.calls[0], ['widget_a']);
        assert.ok(U.fireInline(btns[2], 'click', x.m).stopped); assert.deepStrictEqual(x.m.openWidgetFullscreen.calls[0], ['widget_a']);
        U.fireInline(items[0], 'click', x.m);
        assert.deepStrictEqual(x.m.scrollToWidget.calls[0], ['widget_a']);
    }, { tags: ['unit'] });

    test('A3B2-02: the tab-opening sidebar button reads "Open in new tab" with the external-link icon in both renderers', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: '<div id="widget-sidebar-list"></div>' });
        x.m.renderWidgetSidebar();
        var btn = dom.$('.widget-sidebar-item .widget-sidebar-actions button');
        var ref = document.createElement('div'); ref.innerHTML = x.m.UI_ICONS.externalLink;
        assert.strictEqual(btn.title, 'Open in new tab');
        assert.strictEqual(btn.innerHTML, ref.innerHTML);
        // 080 renderWidgetSidebar and 120 renderVersionSidebar render the same row: keep both in sync.
        var files = ['src/js/tools/080-widget-tools.js', 'src/js/ui/120-ui-utils.js'];
        for (var i = 0; i < files.length; i++) {
            var src = await loadFile(files[i], WS);
            assert.strictEqual(src.indexOf('Show in Panel'), -1, files[i] + ' still labels the tab-opening button "Show in Panel"');
            var rows = src.split('\n').filter(function(l) { return l.indexOf('<button') >= 0 && l.indexOf('showWidgetInPanel(') >= 0; });
            assert.strictEqual(rows.length, 1, files[i]);
            assert.ok((rows[0].indexOf('title="Open in new tab">') >= 0 || rows[0].indexOf("title=\"' + t('Open in new tab') + '\">") >= 0) && rows[0].indexOf('UI_ICONS.externalLink') >= 0 && rows[0].indexOf('UI_ICONS.panelRight') < 0, files[i] + ': ' + rows[0].trim());
        }
    }, { tags: ['unit'] });

    test('scrollToWidget highlights an inline card, else opens the modal', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: '<div id="widget-widget_a"></div>' });
        var el = dom.$('#widget-widget_a'); el.scrollIntoView = U.recorder();
        // NEW-V15-1: only an on-screen card is highlighted, and the sandbox has no
        // layout, so give this card a 300x200 box (see test/rg-b6-dashboard.test.js).
        el.getClientRects = function() { return [{ width: 300, height: 200 }]; };
        el.getBoundingClientRect = function() { return { width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200 }; };
        x.m.scrollToWidget('widget_a');
        assert.ok(el.classList.contains('highlight')); assert.strictEqual(el.scrollIntoView.calls.length, 1);
        dom.cleanup();
        x.m.scrollToWidget('widget_a');
        var ov = document.getElementById('widget-modal-overlay');
        assert.ok(ov && ov.querySelector('.widget-modal-header .widget-title'));
        assert.strictEqual(ov.querySelector('.widget-modal-content iframe.widget-iframe') !== null, true);
        x.m.closeWidgetModal();
        assert.strictEqual(document.getElementById('widget-modal-overlay'), null);
        assert.strictEqual(x.win.count('message'), x.base);
    }, { tags: ['unit'] });

    test('injectWidgetTokens: head insertion, header-safe, idempotent', async function() {
        var x = await loadWidgets();
        var inj = x.m.injectWidgetTokens;
        var a = inj('<html><head><title>t</title></head><body>x</body></html>');
        assert.match(a, /<head><style data-appagent-tokens="1">:where\(:root\)\{/);
        assert.match(a, /:where\(:root\[data-appagent-theme="dark"\]\)\{[^}]*--bg-main:#111317/);
        assert.strictEqual(inj(a), a, 'idempotent');
        var h = inj('<header>top</header>');
        assert.ok(h.indexOf('<style data-appagent-tokens') === 0, 'fragment: prepended, not inside <header>');
        var d = U.parse(h);
        assert.strictEqual(d.head.querySelectorAll('style[data-appagent-tokens]').length, 1);
        assert.strictEqual(d.querySelector('header').textContent, 'top');
        var mention = inj('<p>data-appagent-tokens</p>');
        assert.strictEqual((mention.match(/<style data-appagent-tokens/g) || []).length, 1, 'plain mention still injected');
        assert.strictEqual(inj(null), null);
    }, { tags: ['unit'] });

    test('RC7B2-F1: no widget control claims a side panel; new-tab labels are sentence case', async function() {
        var x = await loadWidgets({ dashboard: { widget_a: Object.assign({}, W1, { dashboard: 'main' }) } });
        function tabBtns(root) { return Array.prototype.filter.call(root.querySelectorAll('button'), function(b) { return (b.getAttribute('onclick') || '').indexOf('openWidgetLink(') >= 0; }); }
        // Chat fullscreen (080 openWidgetFullscreen): one tab-opening control, no "side panel" twin that opens the same tab.
        x.m.openWidgetFullscreen('widget_a');
        var hdr = document.querySelector('#widget-fullscreen-overlay .widget-fullscreen-header');
        assert.strictEqual(tabBtns(hdr).length, 1, 'exactly one openWidgetLink( button');
        // RC7B2-F1: the icon-only button also needs an accessible name (aria-label), like 070 below.
        assert.deepStrictEqual([tabBtns(hdr)[0].title, tabBtns(hdr)[0].getAttribute('aria-label')], ['Open in new tab', 'Open in new tab']);
        assert.strictEqual(hdr.querySelector('.widget-panel-btn'), null, 'no duplicate side-panel button');
        assert.strictEqual(Array.prototype.filter.call(hdr.querySelectorAll('button'), function(b) { return (b.getAttribute('onclick') || '').indexOf('openWidgetInIframePanel(') >= 0; }).length, 0);
        document.getElementById('widget-fullscreen-overlay').remove();
        // Dashboard expanded view (070 expandDashboardWidget): same label on title and aria-label.
        x.m.__scope.WidgetStore.project = function() {};
        x.m.expandDashboardWidget('widget_a');
        var ov = document.getElementById('widget-fullscreen-overlay');
        assert.strictEqual(tabBtns(ov).length, 1);
        assert.deepStrictEqual([tabBtns(ov)[0].title, tabBtns(ov)[0].getAttribute('aria-label')], ['Open in new tab', 'Open in new tab']);
        var files = ['src/js/tools/080-widget-tools.js', 'src/js/ui/070-dashboard-ui.js'];
        for (var i = 0; i < files.length; i++) {
            var src = await loadFile(files[i], WS);
            assert.strictEqual(src.indexOf('Open in Side Panel'), -1, files[i] + ' still has an "Open in Side Panel" control');
            assert.strictEqual(src.indexOf('Open in New Tab'), -1, files[i] + ' still title-cases "Open in New Tab"');
        }
    }, { tags: ['unit'] });

    test('NEW-T20-1: every icon-only widget close button has an accessible name', async function() {
        var x = await loadWidgets({ dashboard: { widget_a: Object.assign({}, W1, { dashboard: 'main' }) } });
        // Chat fullscreen (080 openWidgetFullscreen).
        x.m.openWidgetFullscreen('widget_a');
        var c1 = document.querySelector('#widget-fullscreen-overlay .widget-close-btn');
        assert.ok(c1, 'fullscreen close button rendered');
        assert.deepStrictEqual([c1.title, c1.getAttribute('aria-label')], ['Close', 'Close']);
        document.getElementById('widget-fullscreen-overlay').remove();
        // Dashboard expanded view (070 expandDashboardWidget).
        x.m.__scope.WidgetStore.project = function() {};
        x.m.expandDashboardWidget('widget_a');
        var c2 = document.querySelector('#widget-fullscreen-overlay .widget-close-btn');
        assert.ok(c2, 'expanded-view close button rendered');
        assert.deepStrictEqual([c2.title, c2.getAttribute('aria-label')], ['Close', 'Close']);
        document.getElementById('widget-fullscreen-overlay').remove();
        // Source scan: every close-button tag (080: fullscreen, code editor, modal; 070: expanded view).
        // The counts are pinned so a regex miss cannot pass silently.
        var want = { 'src/js/tools/080-widget-tools.js': 3, 'src/js/ui/070-dashboard-ui.js': 1 };
        for (var f in want) {
            var tags = (await loadFile(f, WS)).match(/<button class="widget-close-btn"[^>]*>/g) || [];
            assert.strictEqual(tags.length, want[f], f + ': close-button count');
            // i18n: the label is either the literal or the t()-wrapped key; the
            // rendered English value is asserted above (c1/c2).
            tags.forEach(function(tag) {
                assert.ok(/aria-label="(?:Close|' \+ escapeHtml\(t\('Close'\)\) \+ ')"/.test(tag), f + ': no aria-label in ' + tag);
                assert.ok(/title="(?:Close|' \+ escapeHtml\(t\('Close'\)\) \+ ')"/.test(tag), f + ': no title in ' + tag);
            });
        }
    }, { tags: ['unit'] });
});

// S0B-10 / S0B-15 — ui/070-dashboard-ui.js importDashboard / exportDashboard.
// saveDashboardWidget, refreshVisibleDashboards and showConfirmModal live in
// files outside WG_FILES, so they are free identifiers set on the scope. The
// file <input> / <a> are captured by wrapping the real document.createElement
// (removed again in afterEach): no real file picker or download ever opens.
describe('S0B-10 / S0B-15 dashboard import-export', function() {
    afterEach(function() { delete document.createElement; });
    async function setup(dash) {
        var x = await loadWidgets({ dashboard: dash || { widget_a: { id: 'widget_a', title: 'Old' } } });
        var sc = x.m.__scope;
        x.saves = []; x.fail = null; x.blobs = []; x.confirm = { answer: false, calls: [] }; x.cap = { inputs: [], anchors: [] };
        sc.saveDashboardWidget = async function(w) { if (x.fail && x.fail(w)) throw new Error('boom'); x.saves.push(w.id); };
        sc.refreshVisibleDashboards = U.recorder();
        sc.showConfirmModal = async function(t, msg, v) { x.confirm.calls.push([t, msg, v]); return x.confirm.answer; };
        sc.Blob = function(parts, o) { this.parts = parts.slice(); this.type = o && o.type; x.blobs.push(this); };
        sc.URL = { createObjectURL: function() { return 'blob:test'; }, revokeObjectURL: function() {} };
        document.createElement = function(t) { var el = { tagName: String(t).toUpperCase(), click: function() {} }; (t === 'input' ? x.cap.inputs : x.cap.anchors).push(el); return el; };
        x.importData = async function(data) {
            await x.m.importDashboard();
            var input = x.cap.inputs[x.cap.inputs.length - 1];
            await input.onchange({ target: { files: [{ text: async function() { return JSON.stringify(data); } }] } });
        };
        x.snacks = x.s.showSnackbar.calls;
        x.refreshes = function() { return sc.refreshVisibleDashboards.calls.length; };
        return x;
    }

    test('S0B-10 non-array widgets gives an error and 0 saves', async function() {
        var x = await setup();
        await x.importData({ type: 'appagent-dashboard', version: 1, widgets: { a: { id: 'w1' } } });
        assert.deepStrictEqual(x.snacks, [['Invalid dashboard file format', 'error']], 'was "Imported 0 widget(s)"');
        await x.importData(null);
        assert.deepStrictEqual(x.snacks[1], ['Invalid dashboard file format', 'error']);
        assert.deepStrictEqual(x.saves, []);
        assert.strictEqual(x.confirm.calls.length, 0);
        assert.strictEqual(x.refreshes(), 0, 'nothing written, nothing to refresh');
    }, { tags: ['unit'] });

    test('S0B-10 an id-less row after a valid row gives an error and 0 saves', async function() {
        var x = await setup();
        await x.importData({ type: 'appagent-dashboard', widgets: [{ id: 'w1', title: 'A' }, { title: 'no id' }, null, { id: 'w1' }] });
        assert.deepStrictEqual(x.snacks, [['Invalid dashboard file: 3 widget(s) lack a valid unique id', 'error']]);
        assert.deepStrictEqual(x.saves, [], 'the valid first row is not saved either');
        await x.importData({ type: 'appagent-dashboard-widget', widget: { id: '__proto__', title: 'polluted' } });
        assert.deepStrictEqual(x.snacks[1], ['Invalid dashboard file: 1 widget(s) lack a valid unique id', 'error']);
        assert.deepStrictEqual(x.saves, []);
        assert.strictEqual(x.confirm.calls.length, 0, '__proto__ is not an existing widget');
        assert.strictEqual(x.refreshes(), 0);
    }, { tags: ['unit'] });

    test('S0B-10 existing ids ask first, and Cancel saves nothing', async function() {
        var x = await setup();
        var file = { type: 'appagent-dashboard', widgets: [{ id: 'widget_a', title: 'New' }, { id: 'w2', title: 'B' }] };
        await x.importData(file);
        assert.strictEqual(x.confirm.calls.length, 1);
        assert.strictEqual(x.confirm.calls[0][0], 'Import dashboard');
        assert.match(x.confirm.calls[0][1], /^1 widget\(s\) already exist; their title\/content will be updated \(layout kept\)/);
        assert.strictEqual(x.confirm.calls[0][2], 'warning');
        assert.deepStrictEqual(x.saves, [], 'Cancel writes nothing');
        assert.deepStrictEqual(x.snacks, []);
        assert.strictEqual(x.refreshes(), 0);
        x.confirm.answer = true;
        await x.importData(file);
        assert.deepStrictEqual(x.saves, ['widget_a', 'w2']);
        assert.deepStrictEqual(x.snacks, [['Imported 1 widget(s), updated 1', 'success']]);
        assert.strictEqual(x.refreshes(), 1);
        await x.importData({ type: 'appagent-dashboard-widget', widget: { id: 'w3' } });
        assert.strictEqual(x.confirm.calls.length, 2, 'only new widgets: no confirmation');
        assert.deepStrictEqual(x.saves, ['widget_a', 'w2', 'w3']);
        assert.deepStrictEqual(x.snacks[1], ['Imported 1 widget(s)', 'success']);
    }, { tags: ['unit'] });

    test('S0B-10 a save rejection still refreshes and reports an error', async function() {
        var x = await setup({});
        x.fail = function(w) { return w.id === 'w2'; };
        await x.importData({ type: 'appagent-dashboard', widgets: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] });
        assert.deepStrictEqual(x.saves, ['w1']);
        assert.deepStrictEqual(x.snacks, [['Failed to import (1 of 3 saved): boom', 'error']]);
        assert.strictEqual(x.refreshes(), 1, 'refresh runs even after a failed save');
    }, { tags: ['unit'] });

    test('S0B-15 exportDashboard: a throwing widget getter → error snackbar', async function() {
        var bad = { id: 'w_bad' };
        Object.defineProperty(bad, 'html', { enumerable: true, get: function() { throw new Error('getter boom'); } });
        var x = await setup({ w_bad: bad });
        x.m.exportDashboard();
        assert.deepStrictEqual(x.snacks, [['Download failed: getter boom', 'error']], 'was an uncaught exception');
        assert.strictEqual(x.cap.anchors.length, 0, 'no download started');
        var y = await setup();
        y.m.exportDashboard();
        assert.deepStrictEqual(y.snacks, [['Dashboard exported', 'success']]);
        assert.strictEqual(y.cap.anchors.length, 1);
        assert.match(y.cap.anchors[0].download, /^dashboard-\d{4}-\d{2}-\d{2}\.json$/);
        assert.strictEqual(JSON.parse(y.blobs[0].parts.join('')).widgets[0].id, 'widget_a');
    }, { tags: ['unit'] });
});

// A6B-01 — the dashboard expanded-modal trash button only UNPINS
// (deleteDashboardWidget drops the dashboardWidgets row); the WidgetStore
// record, its versions and the library item stay. deleteDashboardWidget,
// dashboardGridEl, dashboardWidgetsFor, widgetDashboardOf (020),
// showConfirmModal (230), renderVersionSidebar (120) and currentEditingWidget
// (130) live outside WG_FILES, so they are free identifiers set on the scope.
describe('A6B-01 dashboard expanded-modal remove', function() {
    afterEach(function() { U.cleanupAll(); var o = document.getElementById('widget-fullscreen-overlay'); if (o) o.remove(); });
    async function setup(dash, board) {
        var x = await loadWidgets({ dashboard: dash });
        var sc = x.m.__scope, id = Object.keys(dash)[0];
        x.answer = true; x.confirms = []; x.dels = []; x.removes = [];
        sc.currentEditingWidget = null;
        sc.WidgetStore.project = function() {};
        sc.WidgetStore.remove = function(wid) { x.removes.push(wid); return Promise.resolve(); };
        sc.showConfirmModal = async function(t, msg, v) { x.confirms.push([t, msg, v]); return x.answer; };
        sc.deleteDashboardWidget = async function(wid) { x.dels.push(wid); delete sc.dashboardWidgets[wid]; };
        sc.widgetDashboardOf = function(w) { return (w && w.dashboard) || 'main'; };
        sc.dashboardWidgetsFor = function(d) { return Object.keys(sc.dashboardWidgets).map(function(k) { return sc.dashboardWidgets[k]; }).filter(function(w) { return sc.widgetDashboardOf(w) === d; }); };
        sc.renderVersionSidebar = U.recorder();
        x.dom = await U.mountDom({ html: '<div id="a6b-grid"><div class="dashboard-widget" data-widget-id="' + id + '"></div></div>' +
            '<button class="widget-dashboard-btn on-dashboard" data-widget-id="' + id + '"></button>' });
        x.grid = x.dom.$('#a6b-grid');
        sc.dashboardGridEl = function(d) { return d === board ? x.grid : null; };
        x.clickRemove = async function() {
            x.m.expandDashboardWidget(id);
            var btn = document.querySelector('#widget-fullscreen-overlay .widget-modal-btn.danger');
            U.fireInline(btn, 'click', x.m);
            await U.flush(); await U.flush();
            return btn;
        };
        x.lastSnack = function() { var c = x.s.showSnackbar.calls; return c[c.length - 1]; };
        return x;
    }

    test('A6B-01 expanded-modal remove says Remove and never deletes the widget record', async function() {
        var x = await setup({ widget_a: { id: 'widget_a', title: 'T' } }, 'main');
        x.answer = false;
        var btn = await x.clickRemove();
        assert.strictEqual(btn.title, 'Remove from dashboard');
        assert.strictEqual(btn.getAttribute('aria-label'), 'Remove from dashboard');
        assert.strictEqual(x.confirms.length, 1);
        assert.strictEqual(x.confirms[0][0], 'Remove from Dashboard');
        assert.ok(!/delete/i.test(x.confirms[0][0] + ' ' + x.confirms[0][1]), x.confirms[0][1]);
        assert.strictEqual(x.confirms[0][1], 'Remove "T" from the dashboard? The widget and its saved versions stay in your library.');
        assert.strictEqual(x.confirms[0][2], 'danger');
        assert.deepStrictEqual(x.dels, [], 'cancel removes nothing');
        assert.ok(x.dom.$('.dashboard-widget'), 'card kept on cancel');
        x.answer = true;
        await x.clickRemove();
        assert.deepStrictEqual(x.dels, ['widget_a'], 'deleteDashboardWidget once (unpin only)');
        assert.deepStrictEqual(x.removes, [], 'WidgetStore.remove never called');
        assert.deepStrictEqual(x.lastSnack(), ['Removed from dashboard', 'success']);
        assert.ok(!x.s.showSnackbar.calls.some(function(c) { return /delete/i.test(c[0]); }), 'no "deleted" snackbar');
        assert.strictEqual(x.dom.$('.dashboard-widget'), null, 'grid card removed');
        assert.match(x.grid.textContent, /No widgets yet/);
        assert.strictEqual(x.dom.$('.widget-dashboard-btn').classList.contains('on-dashboard'), false, 'chat pin button refreshed');
        assert.strictEqual(x.m.__scope.renderVersionSidebar.calls.length, 1, 'version sidebar refreshed');
    }, { tags: ['unit'], timeout: 5000 });

    test('A6B-01 removing a Home widget says Home and keeps the record', async function() {
        var x = await setup({ widget_h: { id: 'widget_h', title: 'H', dashboard: 'home' } }, 'home');
        await x.clickRemove();
        assert.strictEqual(x.confirms.length, 1);
        assert.strictEqual(x.confirms[0][0], 'Remove from Home'); // TA-8: the title names Home too
        assert.strictEqual(x.confirms[0][1], 'Remove "H" from Home? The widget and its saved versions stay in your library.');
        assert.deepStrictEqual(x.dels, ['widget_h']);
        assert.deepStrictEqual(x.removes, [], 'WidgetStore.remove never called');
        assert.deepStrictEqual(x.lastSnack(), ['Removed from Home', 'success']);
        assert.strictEqual(x.dom.$('.dashboard-widget'), null, 'home card removed');
        assert.strictEqual(x.grid.innerHTML, '', 'home grid emptied (no dashboard empty-state card)');
    }, { tags: ['unit'], timeout: 5000 });

    // The expanded modal of a pinned widget shows a direct Unpin button that
    // reuses pinWidgetTo(id, 'none') (no confirm, like the pin menu's Unpin),
    // closes the modal and refreshes the grid / pin buttons / sidebar.
    test('expanded modal of a pinned widget shows an Unpin button that unpins and closes', async function() {
        var x = await setup({ widget_a: { id: 'widget_a', title: 'T' } }, 'main');
        x.m.expandDashboardWidget('widget_a');
        var btn = document.querySelector('#widget-fullscreen-overlay .widget-unpin-btn');
        assert.ok(btn, 'Unpin button rendered for a pinned widget');
        assert.strictEqual(btn.title, 'Unpin');
        assert.strictEqual(btn.getAttribute('aria-label'), 'Unpin');
        assert.ok(!btn.classList.contains('danger'), 'not the destructive control');
        U.fireInline(btn, 'click', x.m);
        await U.flush(); await U.flush();
        assert.strictEqual(document.getElementById('widget-fullscreen-overlay'), null, 'modal closed');
        assert.strictEqual(x.confirms.length, 0, 'no confirm (same as pin-menu Unpin)');
        assert.deepStrictEqual(x.dels, ['widget_a'], 'unpinned via deleteDashboardWidget');
        assert.deepStrictEqual(x.removes, [], 'WidgetStore.remove never called');
        assert.deepStrictEqual(x.lastSnack(), ['Removed from dashboard', 'success']);
        assert.strictEqual(x.dom.$('.dashboard-widget'), null, 'grid card removed');
        assert.strictEqual(x.dom.$('.widget-dashboard-btn').classList.contains('on-dashboard'), false, 'chat pin button refreshed');
    }, { tags: ['unit'], timeout: 5000 });

    test('Unpin on a Home widget says Removed from Home', async function() {
        var x = await setup({ widget_h: { id: 'widget_h', title: 'H', dashboard: 'home' } }, 'home');
        x.m.expandDashboardWidget('widget_h');
        var btn = document.querySelector('#widget-fullscreen-overlay .widget-unpin-btn');
        assert.ok(btn);
        U.fireInline(btn, 'click', x.m);
        await U.flush(); await U.flush();
        assert.deepStrictEqual(x.dels, ['widget_h']);
        assert.deepStrictEqual(x.lastSnack(), ['Removed from Home', 'success']);
    }, { tags: ['unit'], timeout: 5000 });
});
