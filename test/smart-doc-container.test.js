// H13 — smart-doc duplicate container (tools/110-smart-documents.js).
// The same doc can render several times in one transcript and every copy
// shares the same element ids, so sdocGetContainer's getElementById always
// returned the FIRST copy: Edit / Save / Cancel / Compare / prompt Submit on a
// later copy acted on (or read from) the wrong copy. Renders the REAL
// sdocRender twice into the real sandbox document and drives the real inline
// handlers (U.fireInline: `this` = the element, like the CSP polyfill).
// Fails on the old code: every action below lands on copy #1.
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var SD_FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/250-message-render.js', 'src/js/tools/090-display-templates.js',
    'src/js/tools/110-smart-documents.js'];
var HOUR = 3600000;

function fixture(over) {
    var now = Date.now();
    return Object.assign({ id: 'doc_dup', title: 'Plan', currentContent: 'line one\nline two', currentVersion: 2, scope: 'shared',
        versions: [{ version: 1, content: 'line one', author: 'agent', timestamp: now - HOUR },
            { version: 2, content: 'line one\nline two', author: 'agent', timestamp: now }],
        displays: {}, prompts: [{ id: 'dpr_q1', title: 'Q', status: 'pending', responses: {}, fields: [{ name: 'a', type: 'text', label: 'A' }] }],
        createdAt: now - HOUR, updatedAt: now }, over || {});
}
async function loadSdoc(doc) {
    var s = U.stubs();
    var m = await U.loadUi(SD_FILES, { globals: { chats: {}, currentChatId: 'c1', activeStreamingChatId: null,
        showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage } });
    m.smartDocuments[doc.id] = doc;
    m.__scope.renderVersionSidebar = U.recorder();
    return m;
}
// Two copies of the same doc, as two transcript messages referencing it.
async function mountTwice(m, doc) {
    var html = '<div class="msg-a">' + m.sdocRender(doc) + '</div><div class="msg-b">' + m.sdocRender(doc) + '</div>';
    var dom = await U.mountDom({ html: html });
    var copies = dom.$$('.sdoc[data-doc-id]');
    copies.forEach(function(c) { var ed = c.querySelector('.sdoc-editor'); if (ed) ed.focus = function() {}; });
    return { dom: dom, a: copies[0], b: copies[1] };
}
function shown(el) { return el.style.display !== 'none'; }

describe('H13 smart-doc actions target the clicked copy, not the first', function() {
    afterEach(function() { U.cleanupAll(); });

    test('two copies share ids (precondition — otherwise the test is vacuous)', async function() {
        var m = await loadSdoc(fixture());
        var t = await mountTwice(m, fixture());
        assert.ok(t.a && t.b && t.a !== t.b);
        assert.strictEqual(t.a.id, t.b.id, 'duplicate container ids');
        assert.strictEqual(document.getElementById(t.b.id), t.a, 'getElementById resolves to copy #1');
    }, { tags: ['unit'], timeout: 5000 });

    test('Edit on copy #2 opens the editor in copy #2 only', async function() {
        var m = await loadSdoc(fixture());
        var t = await mountTwice(m, m.smartDocuments.doc_dup);
        U.fireInline(t.b.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        assert.ok(t.b.classList.contains('sdoc-editing'), 'copy #2 editing');
        assert.ok(shown(t.b.querySelector('.sdoc-edit')) && !shown(t.b.querySelector('.sdoc-body')));
        assert.ok(!t.a.classList.contains('sdoc-editing'), 'copy #1 untouched');
        assert.ok(shown(t.a.querySelector('.sdoc-body')) && !shown(t.a.querySelector('.sdoc-edit')));
    }, { tags: ['unit'], timeout: 5000 });

    test('Cancel on copy #2 closes copy #2 and leaves copy #1 editing', async function() {
        var m = await loadSdoc(fixture());
        var t = await mountTwice(m, m.smartDocuments.doc_dup);
        U.fireInline(t.a.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        U.fireInline(t.b.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        assert.ok(t.a.classList.contains('sdoc-editing') && t.b.classList.contains('sdoc-editing'));
        U.fireInline(t.b.querySelector('.sdoc-edit-actions .skills-action-btn:not(.primary)'), 'click', m);
        assert.ok(!t.b.classList.contains('sdoc-editing') && shown(t.b.querySelector('.sdoc-body')), 'copy #2 closed');
        assert.ok(t.a.classList.contains('sdoc-editing') && shown(t.a.querySelector('.sdoc-edit')), 'copy #1 still editing');
    }, { tags: ['unit'], timeout: 5000 });

    test('Save on copy #2 persists copy #2 editor text', async function() {
        var doc = fixture();
        var m = await loadSdoc(doc);
        var t = await mountTwice(m, doc);
        U.fireInline(t.b.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        t.b.querySelector('.sdoc-editor').value = 'edited in copy two';
        t.b.querySelector('.sdoc-title-input').value = 'Title two';
        var info = U.fireInline(t.b.querySelector('.sdoc-edit-actions .skills-action-btn.primary'), 'click', m);
        await info.result;
        assert.strictEqual(doc.currentContent, 'edited in copy two', 'saved copy #2 text');
        assert.strictEqual(doc.title, 'Title two');
        assert.strictEqual(doc.currentVersion, 3);
        assert.strictEqual(doc.versions[doc.versions.length - 1].author, 'user');
    }, { tags: ['unit'], timeout: 5000 });

    test('Save with unchanged text on copy #2 cancels copy #2 (not copy #1)', async function() {
        var doc = fixture();
        var m = await loadSdoc(doc);
        var t = await mountTwice(m, doc);
        U.fireInline(t.a.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        U.fireInline(t.b.querySelector('.sdoc-action-btn[title="Edit"]'), 'click', m);
        var info = U.fireInline(t.b.querySelector('.sdoc-edit-actions .skills-action-btn.primary'), 'click', m);
        await info.result;
        assert.strictEqual(doc.currentVersion, 2, 'no new version');
        assert.ok(!t.b.classList.contains('sdoc-editing'), 'copy #2 closed');
        assert.ok(t.a.classList.contains('sdoc-editing'), 'copy #1 still editing');
    }, { tags: ['unit'], timeout: 5000 });

    test('Compare on copy #2 shows the diff in copy #2 only; empty value restores it', async function() {
        var m = await loadSdoc(fixture());
        var t = await mountTwice(m, m.smartDocuments.doc_dup);
        var sel = t.b.querySelector('.sdoc-version-select');
        sel.value = '1';
        U.fireInline(sel, 'change', m);
        assert.ok(t.b.classList.contains('sdoc-diffing') && shown(t.b.querySelector('.sdoc-diff')), 'copy #2 diffing');
        assert.ok(t.b.querySelector('.sdoc-diff .sdoc-line-add'), 'diff rendered into copy #2');
        assert.ok(!t.a.classList.contains('sdoc-diffing') && !shown(t.a.querySelector('.sdoc-diff')), 'copy #1 untouched');
        assert.strictEqual(t.a.querySelector('.sdoc-diff').innerHTML, '');
        sel.value = '';
        U.fireInline(sel, 'change', m);
        assert.ok(!t.b.classList.contains('sdoc-diffing') && shown(t.b.querySelector('.sdoc-body')));
    }, { tags: ['unit'], timeout: 5000 });

    test('prompt Submit from copy #2 (polyfill receiver = form) reads copy #2 fields', async function() {
        var doc = fixture();
        var m = await loadSdoc(doc);
        var t = await mountTwice(m, doc);
        var f1 = t.a.querySelector('form.sdoc-prompt-form'), f2 = t.b.querySelector('form.sdoc-prompt-form');
        assert.strictEqual(f1.id, f2.id, 'duplicate form ids');
        // C1 shape unchanged: the attribute carries no element arg
        assert.strictEqual(f2.getAttribute('onsubmit'), "event.preventDefault(); sdocSubmitPrompt('doc_dup', 'dpr_q1')");
        f1.querySelector('[data-field-name="a"]').value = 'from one';
        f2.querySelector('[data-field-name="a"]').value = 'from two';
        // csp-polyfill.js _call: fn.apply(el, args) — el is the <form> the listener is bound to
        m.sdocSubmitPrompt.apply(f2, ['doc_dup', 'dpr_q1']);
        assert.strictEqual(doc.prompts[0].status, 'answered');
        assert.deepStrictEqual(doc.prompts[0].responses, { a: 'from two' });
    }, { tags: ['unit'], timeout: 5000 });

    test('prompt Submit with an explicit element arg from copy #2', async function() {
        var doc = fixture();
        var m = await loadSdoc(doc);
        var t = await mountTwice(m, doc);
        t.a.querySelector('[data-field-name="a"]').value = 'from one';
        var in2 = t.b.querySelector('[data-field-name="a"]');
        in2.value = 'from two';
        m.sdocSubmitPrompt('doc_dup', 'dpr_q1', in2);
        assert.deepStrictEqual(doc.prompts[0].responses, { a: 'from two' });
    }, { tags: ['unit'], timeout: 5000 });

    test('no element (programmatic call) keeps the old fallback: first copy', async function() {
        var m = await loadSdoc(fixture());
        var t = await mountTwice(m, m.smartDocuments.doc_dup);
        m.sdocToggleEdit('doc_dup');
        assert.ok(t.a.classList.contains('sdoc-editing') && !t.b.classList.contains('sdoc-editing'));
        assert.strictEqual(m.sdocGetContainer('doc_dup'), t.a);
        assert.strictEqual(m.sdocGetContainer('doc_dup', null), t.a);
        assert.strictEqual(m.sdocGetContainer('doc_dup', {}), t.a, 'non-element ignored');
        assert.strictEqual(m.sdocGetContainer('doc_dup', t.b.querySelector('.sdoc-title')), t.b);
    }, { tags: ['unit'], timeout: 5000 });

    test('nested .sdoc of another doc: resolution walks up to the matching id', async function() {
        var m = await loadSdoc(fixture());
        var inner = fixture({ id: 'doc_inner', prompts: [] });
        m.smartDocuments.doc_inner = inner;
        var dom = await U.mountDom({ html: m.sdocRender(m.smartDocuments.doc_dup) });
        var outer = dom.$('.sdoc[data-doc-id="doc_dup"]');
        outer.querySelector('.sdoc-body').insertAdjacentHTML('beforeend', m.sdocRender(inner));
        var innerEl = dom.$('.sdoc[data-doc-id="doc_inner"]');
        var btn = innerEl.querySelector('.sdoc-title');
        assert.strictEqual(m.sdocContainerFrom(btn, 'doc_inner'), innerEl);
        assert.strictEqual(m.sdocContainerFrom(btn, 'doc_dup'), outer);
        assert.strictEqual(m.sdocContainerFrom(btn, 'doc_missing'), null);
        assert.strictEqual(m.sdocContainerFrom(document.body, 'doc_dup'), null);
    }, { tags: ['unit'], timeout: 5000 });
});
