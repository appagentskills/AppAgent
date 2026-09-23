// H1 + H14 render robustness. Real source via loadModules / U.loadUi; only
// externals (DOM mount, storage, renderers from unloaded files) are stubbed.
// Run: run_tests { files: ['test/render-robustness.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var BASE = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js'];
var RENDER = BASE.concat(['src/js/tools/100-prompt-user.js', 'src/js/ui/250-message-render.js']);
var DOCS = BASE.concat(['src/js/tools/090-display-templates.js', 'src/js/tools/110-smart-documents.js', 'src/js/ui/250-message-render.js']);
var ALLOW = ['smartDocuments', '_isChatInSilentHook', 'currentEditingWidget', 'getDisplayHtmlForMessage', 'isChatRunning', 'AgentEvents',
    'formatContent', 'ensureChatPayloads', 'postPromptRowToSW', '_refreshWaitingBadges', 'setActionNeedsInput', 'loadDocumentById', 'sdocReRenderAll',
    '_promptResultViaSW', 'recordToolResult', 'runAgent', 'renderSubReport', 'renderSubAgentMessage'];
function noop() { return ''; }
function chatGlobals(chat, extra) {
    var s = U.stubs();
    return Object.assign({
        chats: { c1: chat }, currentChatId: 'c1', activeStreamingChatId: null, compactToolCalls: false, showApiStats: false, currentView: 'chat',
        hooksEnabled: {}, compactAreaExpandedState: {}, thinkingExpandedState: {}, userMsgExpandedState: {}, pendingInjectionsByChatId: {},
        stickToBottom: false, pinToBottom: false, showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage,
        updateContextIndicator: noop, updateInputPosition: noop, getWidgetHtmlForMessage: noop, renderInlineChanges: noop,
        initializeWidgetsInView: noop, renderWidgetSidebar: noop, initDisplayChecklists: noop, scrollToBottomIfAllowed: noop, restoreChatScrollTop: noop
    }, extra || {});
}
function load(paths, g) { return U.loadUi(paths, { globals: g || { showSnackbar: U.stubs().showSnackbar }, allowUnstubbed: ALLOW, lenient: false }); }

describe('H1 › renderPromptField is defensive', function() {
    afterEach(function() { U.cleanupAll(); });
    // OLD: field.name on null → TypeError at 100:546.
    test('null / non-object field renders empty string instead of throwing', async function() {
        var m = await load(RENDER);
        assert.strictEqual(m.renderPromptField(null, 'p1'), '');
        assert.strictEqual(m.renderPromptField(undefined, 'p1'), '');
        assert.strictEqual(m.renderPromptField('oops', 'p1'), '');
    }, { tags: ['unit'] });
    // OLD: options.forEach is not a function (string options) at 100:584.
    test('string options are coerced to comma-separated pills', async function() {
        var m = await load(RENDER);
        var b = U.frag(m.renderPromptField({ name: 'c', type: 'select', options: 'Yes, No' }, 'p1'));
        var chips = b.querySelectorAll('.prompt-chip');
        assert.strictEqual(chips.length, 2);
        assert.deepStrictEqual([chips[0].getAttribute('data-value'), chips[1].textContent], ['Yes', 'No']);
    }, { tags: ['unit'] });
    // OLD: typeof null === 'object' → null.value TypeError at 100:585.
    test('null / label-only / empty entries in options are dropped or repaired', async function() {
        var m = await load(RENDER);
        var b = U.frag(m.renderPromptField({ name: 'c', type: 'multi-select', options: [null, 'x', { label: 'L' }, {}, undefined] }, 'p1'));
        var vals = Array.prototype.map.call(b.querySelectorAll('.prompt-chip'), function(c) { return c.getAttribute('data-value'); });
        assert.deepStrictEqual(vals, ['x', 'L']);
        assert.strictEqual(m.promptOptionLabel({ options: [null, { value: 'v', label: 'Vee' }] }, 'v'), 'Vee');
    }, { tags: ['unit'] });
});

describe('H1 › executePromptUser sanitizes before persisting', function() {
    var m, chats, renders;
    beforeEach(async function() {
        chats = { a: { id: 'a', messages: [] } }; renders = 0;
        m = await loadModules(['src/js/tools/100-prompt-user.js'], { workspace: WS, globals: { chats: chats, activeStreamingChatId: null, currentChatId: 'a', currentView: 'other',
            document: { getElementById: function() { return null; } }, setTimeout: function() {}, saveChatsToStorage: function() {}, renderMessages: function() { renders++; },
            scrollToBottomIfAllowed: function() {}, postPromptRowToSW: function() {}, console: console } });
    });
    // OLD: the row was stored with fields [null, {options:'a,b'}] verbatim.
    test('drops non-object fields and coerces options to arrays', async function() {
        m.executePromptUser({ fields: [null, 'str', { name: 'c', type: 'select', options: 'a,b' }, { name: 'd', type: 'select', options: [null, 'x'] }] }, { chatId: 'a' });
        await Promise.resolve();
        var row = chats.a.messages[0];
        assert.ok(row && row.role === 'prompt_user');
        assert.deepStrictEqual(row.fields.map(function(f) { return f.name; }), ['c', 'd', 'free_text_response']);
        assert.deepStrictEqual(row.fields[0].options, ['a', 'b']);
        assert.deepStrictEqual(row.fields[1].options, ['x']);
    }, { tags: ['unit'] });
    // OLD: fields [null] → pushed a row whose render crashed every later renderMessages.
    test('nothing valid → clear error, no row pushed', async function() {
        var r = await m.executePromptUser({ fields: [null, 42] }, { chatId: 'a' });
        assert.strictEqual(r.success, false);
        assert.match(r.error, /array of objects/);
        assert.strictEqual(chats.a.messages.length, 0);
        assert.deepStrictEqual(await m.executePromptUser({ fields: [] }, { chatId: 'a' }), { success: false, error: 'fields array is required' });
    }, { tags: ['unit'] });
});

describe('H1 › renderMessages isolates a failing message', function() {
    afterEach(function() { U.cleanupAll(); });
    // OLD: legacy malformed prompt_user row threw out of the .map at 250:858 → nothing rendered.
    test('legacy malformed prompt_user row renders; neighbours intact', async function() {
        var chat = { id: 'c1', messages: [
            { role: 'user', content: 'hello' },
            { role: 'prompt_user', promptId: 'p1', status: 'pending', title: 'Q', fields: [null, { name: 'c', type: 'select', options: 'a,b' }, { name: 'd', type: 'select', options: [null] }] },
            { role: 'assistant', content: 'after **prompt**' }
        ] };
        var m = await load(RENDER, chatGlobals(chat));
        var dom = await U.mountDom({ html: '<div id="input-area"></div><div id="messages" class="messages"></div>' });
        m.renderMessages();
        assert.strictEqual(dom.$$('#prompt-form-p1 .prompt-chip').length, 2);
        assert.ok(dom.$('#msg-2'), 'assistant after the prompt rendered');
        assert.strictEqual(dom.$('.render-error'), null);
    }, { tags: ['unit'] });
    // OLD: any renderer throw aborted the whole transcript.
    test('a throwing renderer degrades to an escaped error row', async function() {
        var chat = { id: 'c1', messages: [
            { role: 'user', content: 'first' },
            { role: 'sub_report', content: 'x' },
            { role: 'assistant', content: 'still here' }
        ] };
        var m = await load(RENDER, chatGlobals(chat, { renderSubReport: function() { throw new Error('boom <img src=x onerror=1>'); } }));
        var dom = await U.mountDom({ html: '<div id="input-area"></div><div id="messages" class="messages"></div>' });
        m.renderMessages();
        var err = dom.$('#msg-1.render-error');
        assert.ok(err, 'error row keeps msg-<index> id');
        assert.match(err.textContent, /Could not render this sub_report message: boom <img/);
        assert.strictEqual(err.querySelector('img'), null);
        assert.match(dom.$('#messages').textContent, /still here/);
    }, { tags: ['unit'] });
});

describe('H1 › sdocRenderPrompt tolerates null doc-prompt fields', function() {
    afterEach(function() { U.cleanupAll(); });
    // OLD: (prompt.fields||[]).forEach → field.name on null → TypeError at 110:510.
    test('null / non-object fields are skipped; valid fields still render', async function() {
        var m = await load(DOCS.concat(['src/js/tools/100-prompt-user.js']));
        var d = { id: 'doc1', title: 'D', prompts: [] };
        var html = m.sdocRenderPrompt(d, { id: 'p1', title: 'Q', fields: [null, 'str', 7, { name: 'ok', type: 'text', label: 'OK' }, undefined] });
        var b = U.frag(html);
        var inputs = b.querySelectorAll('[data-field-name]');
        assert.strictEqual(inputs.length, 1);
        assert.strictEqual(inputs[0].getAttribute('data-field-name'), 'ok');
        assert.ok(b.querySelector('#sdoc-prompt-p1'), 'C1 id kept');
    }, { tags: ['unit'] });
    test('filter fallback when sanitizePromptFields is not loaded', async function() {
        var m = await load(DOCS);
        var html = m.sdocRenderPrompt({ id: 'doc2', prompts: [] }, { id: 'p2', fields: [null, { name: 'a', type: 'textarea', label: 'A' }] });
        var b = U.frag(html);
        assert.strictEqual(b.querySelectorAll('textarea[data-field-name="a"]').length, 1);
        assert.strictEqual(m.sdocRenderPrompt({ id: 'doc3', prompts: [] }, { id: 'p3', fields: null }).indexOf('sdoc-prompt-form') > -1, true);
    }, { tags: ['unit'] });
});

describe('H14 › formatContent document recursion guard', function() {
    afterEach(function() { U.cleanupAll(); });
    function doc(id, content) { return { id: id, title: id, currentVersion: 1, versions: [{ version: 1, author: 'agent', timestamp: 0 }], currentContent: content, prompts: [] }; }
    // OLD: formatContent → renderDocumentPlaceholder → sdocRender → sdocRenderContent → formatContent … RangeError.
    test('self-referencing doc renders once plus a recursion chip', async function() {
        var m = await load(DOCS);
        m.smartDocuments.self = doc('self', 'hello <!--document:self-->');
        var out = m.formatContent('see <!--document:self-->');
        var b = U.frag(out);
        assert.strictEqual(b.querySelectorAll('.sdoc').length, 1);
        var chip = b.querySelector('.sdoc-recursive-ref');
        assert.ok(chip); assert.match(chip.textContent, /recursive document reference: self/);
        assert.deepStrictEqual(m.formatContent._docStack, [], 'stack popped');
    }, { tags: ['unit'] });
    test('A→B→A cycle and deep chains stop without throwing', async function() {
        var m = await load(DOCS);
        m.smartDocuments.a = doc('a', 'A <!--document:b-->');
        m.smartDocuments.b = doc('b', 'B <!--document:a-->');
        var b1 = U.frag(m.formatContent('<!--document:a-->'));
        assert.strictEqual(b1.querySelectorAll('.sdoc').length, 2);
        assert.match(b1.querySelector('.sdoc-recursive-ref').textContent, /recursive document reference: a/);
        ['d1', 'd2', 'd3', 'd4', 'd5'].forEach(function(id, i, arr) { m.smartDocuments[id] = doc(id, id + (arr[i + 1] ? ' <!--document:' + arr[i + 1] + '-->' : '')); });
        var b2 = U.frag(m.formatContent('<!--document:d1-->'));
        assert.strictEqual(b2.querySelectorAll('.sdoc').length, 3);
        assert.match(b2.querySelector('.sdoc-recursive-ref').textContent, /document nesting too deep: d4/);
        assert.deepStrictEqual(m.formatContent._docStack, []);
    }, { tags: ['unit'] });
});
