// C1 — smart-doc prompt-id XSS (tools/110-smart-documents.js). An agent-
// controlled prompt.id was interpolated raw into the form id attribute and
// (entity-escaped only) into an inline onsubmit JS string, whose &#39; the
// HTML parser decodes back into a quote. Renders the REAL sdocRender and
// parses the output with the real DOMParser.
// Fails on the old code: the id attr breakout yields an <img onerror> element
// and the onsubmit value contains the raw quote breakout.
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var SD_FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/250-message-render.js', 'src/js/tools/090-display-templates.js',
    'src/js/tools/110-smart-documents.js'];
var SAFE_SUBMIT = /^event\.preventDefault\(\); sdocSubmitPrompt\('doc_x', '[A-Za-z0-9_-]{1,64}'\)$/;

async function loadSdoc() {
    var s = U.stubs();
    return U.loadUi(SD_FILES, { globals: { chats: {}, currentChatId: 'c1', activeStreamingChatId: null,
        showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage } });
}
function docWith(pid) {
    var now = Date.now();
    return { id: 'doc_x', title: 'T', currentContent: 'body', currentVersion: 1, scope: 'shared',
        versions: [{ version: 1, content: 'body', author: 'agent', timestamp: now }], displays: {},
        prompts: [{ id: pid, title: 'Q', status: 'pending', responses: {}, fields: [{ name: 'a', type: 'text', label: 'A' }] }],
        createdAt: now, updatedAt: now };
}
function parse(html) { return new DOMParser().parseFromString(html, 'text/html'); }

describe('C1 smart-doc prompt id cannot break out of attributes', function() {
    ['a\'"<b>', 'x"><img src=x onerror="window.__pwn=1">', "q');handleApproval(-1,'allow',false,currentChatId);//"].forEach(function(bad) {
        test('hostile stored id is neutralized on render: ' + bad.slice(0, 24), async function() {
            var m = await loadSdoc();
            var doc = docWith(bad);
            var d = parse(m.sdocRender(doc));
            assert.strictEqual(d.querySelectorAll('img').length, 0, 'no injected <img>');
            assert.strictEqual(d.querySelectorAll('b').length, 0, 'no injected <b>');
            var forms = d.querySelectorAll('form.sdoc-prompt-form');
            assert.strictEqual(forms.length, 1);
            assert.match(forms[0].getAttribute('onsubmit'), SAFE_SUBMIT);
            // id rewritten in place to a safe one; form id + submit arg agree with it
            assert.match(doc.prompts[0].id, /^[A-Za-z0-9_-]{1,64}$/);
            assert.strictEqual(forms[0].id, 'sdoc-prompt-' + doc.prompts[0].id);
            assert.ok(forms[0].getAttribute('onsubmit').indexOf("'" + doc.prompts[0].id + "'") > 0);
        }, { tags: ['unit'], timeout: 5000 });
    });

    test('sdocInitPrompts regenerates invalid ids and keeps valid ones', async function() {
        var m = await loadSdoc();
        var doc = { prompts: [{ id: 'ok_id-1' }, { id: 'bad id\'' }, { id: 42 }, {}] };
        m.sdocInitPrompts(doc);
        assert.strictEqual(doc.prompts[0].id, 'ok_id-1');
        for (var i = 1; i < 4; i++) assert.match(String(doc.prompts[i].id), /^dpr_[A-Za-z0-9_]+$/);
        assert.strictEqual(doc.prompts[1].status, 'pending');
    }, { tags: ['unit'], timeout: 5000 });

    test('valid id renders unchanged and submit arg is JS-safe', async function() {
        var m = await loadSdoc();
        var doc = docWith('dpr_123_abc');
        var f = parse(m.sdocRender(doc)).querySelector('form.sdoc-prompt-form');
        assert.strictEqual(f.id, 'sdoc-prompt-dpr_123_abc');
        assert.strictEqual(f.getAttribute('onsubmit'), "event.preventDefault(); sdocSubmitPrompt('doc_x', 'dpr_123_abc')");
    }, { tags: ['unit'], timeout: 5000 });
});
