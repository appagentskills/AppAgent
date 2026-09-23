// B1 — UI tests for message cards, tool-call groups, the JSON viewer and the
// TL;DR / caveat / links cards. Renders the REAL src functions (loadModules)
// into the REAL sandbox document with the real CSS, then drives the rendered
// inline handlers through the module scope (test/ui-helpers.js fireInline).
// Run: run_tests { files: ['test/ui-message-cards.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/250-message-render.js'];
var CSS = ['src/css/00-tokens.css', 'src/css/03-chat.css', 'src/css/05-tools.css'];
// typeof-probed (lenient) globals renderMessages/formatContent touch; anything
// else unstubbed fails loadUi/assertUnstubbed.
var ALLOW = ['smartDocuments', '_isChatInSilentHook', 'currentEditingWidget', 'getDisplayHtmlForMessage', 'isChatRunning', 'AgentEvents'];
var HOSTILE = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';

function noop() { return ''; }
function chatGlobals(chat, extra) {
    var s = U.stubs();
    return Object.assign({
        chats: { c1: chat }, currentChatId: 'c1', activeStreamingChatId: null, compactToolCalls: false, showApiStats: false,
        hooksEnabled: {}, compactAreaExpandedState: {}, thinkingExpandedState: {}, userMsgExpandedState: {}, pendingInjectionsByChatId: {},
        stickToBottom: false, pinToBottom: false, showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage,
        updateContextIndicator: noop, updateInputPosition: noop, getWidgetHtmlForMessage: noop, renderInlineChanges: noop,
        initializeWidgetsInView: noop, renderWidgetSidebar: noop, initDisplayChecklists: noop, scrollToBottomIfAllowed: noop, restoreChatScrollTop: noop
    }, extra || {});
}
function load(globals) { return U.loadUi(FILES, { globals: globals || { showSnackbar: U.stubs().showSnackbar }, allowUnstubbed: ALLOW }); }
function tc(id, name, argsObj) { return { id: id, type: 'function', function: { name: name, arguments: JSON.stringify(argsObj) } }; }
function toolChat(result, extraAssistant) {
    return { id: 'c1', messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '', tool_calls: [tc('t1', 'servicenow_api', { method: 'GET', table: 'incident', status_message: 'Fetching <b>rows</b>' })] },
        { role: 'tool', tool_call_id: 't1', name: 'servicenow_api', content: result },
        Object.assign({ role: 'assistant', content: 'Done **ok**' }, extraAssistant || {})
    ] };
}
async function renderChat(chat, extra) {
    var g = chatGlobals(chat, extra);
    var m = await load(g);
    var dom = await U.mountDom({ html: '<div id="input-area"></div><div id="messages" class="messages"></div>', css: CSS });
    m.renderMessages();
    U.assertUnstubbed(m, ALLOW);
    return { m: m, g: g, dom: dom };
}

describe('ui message cards › TL;DR / caveat / links', function() {
    afterEach(function() { U.cleanupAll(); });
    test('empty inputs render nothing', async function() {
        var m = await load();
        [null, undefined, {}, { tldr: '' }].forEach(function(x) { assert.strictEqual(m.renderTldrCard(x), '', 'tldr ' + JSON.stringify(x)); });
        [null, {}, { caveat: '' }].forEach(function(x) { assert.strictEqual(m.renderCaveatCard(x), '', 'caveat ' + JSON.stringify(x)); });
        [null, {}, { links: [] }, { links: 'x' }, { links: [null, {}, { url: 'javascript:alert(1)' }, { url: 'data:text/html,x' }] }]
            .forEach(function(x) { assert.strictEqual(m.renderLinksCard(x), '', 'links ' + JSON.stringify(x)); });
    }, { tags: ['unit'] });
    test('TL;DR card structure, markdown and hostile-input escaping', async function() {
        var m = await load(), b = U.frag(m.renderTldrCard({ tldr: 'Fixed **it** ' + HOSTILE }));
        var card = b.querySelector('.tldr-card');
        assert.ok(card, 'card'); assert.strictEqual(card.children.length, 2);
        assert.strictEqual(card.querySelector('.tldr-card-label').textContent, 'TL;DR');
        assert.strictEqual(card.querySelector('.tldr-card-text strong').textContent, 'it');
        assert.strictEqual(b.querySelector('img'), null); assert.strictEqual(b.querySelector('script'), null); assert.strictEqual(b.querySelector('[onerror]'), null);
        assert.match(card.querySelector('.tldr-card-text').textContent, /<img src=x/);
    }, { tags: ['unit'] });
    test('caveat card structure and escaping', async function() {
        var m = await load(), b = U.frag(m.renderCaveatCard({ caveat: HOSTILE + ' check' }));
        assert.strictEqual(b.querySelector('.caveat-card .caveat-card-label').textContent, '⚠ Caveat — read this');
        assert.match(b.querySelector('.caveat-card-text').textContent, /<script>window.__pwn=2<\/script> check/);
        assert.strictEqual(b.querySelector('script, img'), null);
    }, { tags: ['unit'] });
    test('links card: safe schemes only, escaped title/href, new-tab rel, url fallback title', async function() {
        var m = await load();
        var b = U.frag(m.renderLinksCard({ links: [
            { title: '<b>PR</b> #1', url: 'https://github.com/o/r/pull/1' },
            { url: 'HTTP://example.com/"onmouseover="bad()' },
            { title: 'evil', url: 'javascript:alert(1)' }, { title: 'data', url: 'data:text/html,<b>' }
        ] }));
        var items = b.querySelectorAll('li.links-card-item');
        assert.strictEqual(items.length, 2, 'javascript:/data: links dropped');
        assert.strictEqual(b.querySelector('.links-card-label').textContent, 'LINKS');
        var a = items[0].querySelector('a.links-card-link');
        assert.strictEqual(a.getAttribute('href'), 'https://github.com/o/r/pull/1');
        assert.strictEqual(a.getAttribute('target'), '_blank');
        assert.deepStrictEqual(a.getAttribute('rel').split(' ').sort(), ['noopener', 'noreferrer']);
        assert.strictEqual(a.querySelector('.links-card-title').textContent, '<b>PR</b> #1'); assert.strictEqual(b.querySelector('b'), null);
        assert.ok(a.querySelector('.links-card-icon svg'), 'icon');
        var a2 = items[1].querySelector('a');
        assert.strictEqual(a2.hasAttribute('onmouseover'), false); assert.strictEqual(a2.getAttribute('href'), 'HTTP://example.com/"onmouseover="bad()');
        assert.strictEqual(a2.querySelector('.links-card-title').textContent, 'HTTP://example.com/"onmouseover="bad()', 'title falls back to url');
        assert.strictEqual(b.querySelectorAll('[href^="javascript"], [href^="data"]').length, 0);
    }, { tags: ['unit'] });
    test('cards get the real CSS in the live document', async function() {
        var m = await load();
        var dom = await U.mountDom({ html: m.renderCaveatCard({ caveat: 'c' }) + m.renderTldrCard({ tldr: 't' }) + m.renderLinksCard({ links: [{ title: 't', url: 'https://a.b' }] }), css: CSS });
        assert.strictEqual(U.css(dom.$('.tldr-card'), 'position'), 'relative');
        assert.strictEqual(U.css(dom.$('.tldr-card-label'), 'position'), 'absolute');
        assert.strictEqual(U.css(dom.$('.links-card-list'), 'display'), 'flex');
        assert.strictEqual(U.css(dom.$('.links-card-list'), 'list-style-type'), 'none');
        assert.strictEqual(U.css(dom.$('.links-card-title'), 'white-space'), 'nowrap');
        assert.notStrictEqual(U.css(dom.$('.caveat-card'), 'background-color'), U.css(dom.$('.tldr-card'), 'background-color'), 'caveat is warning-tinted');
    }, { tags: ['unit'] });
    test('a11y: link has an accessible name and is keyboard-focusable', async function() {
        var m = await load(), dom = await U.mountDom({ html: m.renderLinksCard({ links: [{ title: 'Docs', url: 'https://a.b' }] }) });
        var info = U.a11y(dom.$('a.links-card-link'));
        assert.strictEqual(info.hasName, true); assert.strictEqual(info.name, 'Docs'); assert.strictEqual(info.focusable, true);
    }, { tags: ['unit'] });
});

describe('ui message cards › code blocks (formatContent)', function() {
    afterEach(function() { U.cleanupAll(); });
    test('fenced code renders collapsed wrapper with copy/expand controls and escaped code', async function() {
        var m = await load(), dom = await U.mountDom({ html: m.formatContent('```js\nvar a = "<b>x</b>";\n```'), css: CSS });
        var w = dom.$('.code-block-wrapper');
        assert.ok(w && /^rc-\d+$/.test(w.getAttribute('data-copy-id')), 'copy id');
        assert.ok(dom.$('pre.code-block').classList.contains('collapsed'));
        assert.strictEqual(dom.$('b'), null); assert.match(dom.$('pre code').textContent, /var a = "<b>x<\/b>";/);
        var exp = dom.$('.code-block-expand-btn'), cp = dom.$('.code-copy-btn');
        assert.strictEqual(exp.getAttribute('title'), 'Expand'); assert.strictEqual(exp.textContent, '⤢');
        assert.strictEqual(U.a11y(exp).hasName, true); assert.strictEqual(U.a11y(cp).name, 'Copy');
        assert.ok(dom.$('.sh-keyword'), 'syntax highlight span');
    }, { tags: ['unit'] });
    test('expand button toggles collapsed <-> expanded and stops propagation', async function() {
        var m = await load(), dom = await U.mountDom({ html: m.formatContent('```\nx\n```'), css: CSS });
        var btn = dom.$('.code-block-expand-btn'), pre = dom.$('pre.code-block'), w = dom.$('.code-block-wrapper');
        var r = U.fireInline(btn, 'click', m);
        assert.strictEqual(r.stopped, true);
        assert.strictEqual(pre.classList.contains('collapsed'), false); assert.ok(w.classList.contains('expanded'));
        assert.strictEqual(btn.textContent, '⤡'); assert.strictEqual(btn.title, 'Collapse');
        U.fireInline(btn, 'click', m);
        assert.ok(pre.classList.contains('collapsed')); assert.strictEqual(w.classList.contains('expanded'), false); assert.strictEqual(btn.title, 'Expand');
    }, { tags: ['unit'] });
    test('copy button copies RAW code and reports success / failure via snackbar', async function() {
        var snack = U.recorder(), m = await load({ showSnackbar: snack });
        var dom = await U.mountDom({ html: m.formatContent('```\n<raw> & "q"\n```') });
        var clip = m.__scope.navigator.clipboard;
        U.fireInline(dom.$('.code-copy-btn'), 'click', m); await U.flush();
        assert.deepStrictEqual(clip.writes, ['<raw> & "q"\n']); assert.deepStrictEqual(snack.calls, [['Copied to clipboard', 'success']]);
        clip.mode = 'fail'; U.fireInline(dom.$('.code-copy-btn'), 'click', m); await U.flush();
        assert.deepStrictEqual(snack.calls[1], ['Copy failed', 'error']);
    }, { tags: ['unit'] });
    test('hostile markdown: no live tags, javascript: links not linkified, quote-breaking href escaped', async function() {
        var m = await load(), b = U.frag(m.formatContent(HOSTILE + ' [x](javascript:alert(1)) [y](https://ok.com/"onmouseover="z)'));
        assert.strictEqual(b.querySelector('script, img, [onerror], [onmouseover]'), null);
        assert.strictEqual(b.querySelectorAll('a').length, 1); assert.strictEqual(b.querySelector('a').getAttribute('href'), 'https://ok.com/"onmouseover="z');
    }, { tags: ['unit'] });
});

describe('ui message cards › JSON viewer', function() {
    afterEach(function() { U.cleanupAll(); });
    test('pretty JSON: keys, types, status_message hidden, strings escaped', async function() {
        var m = await load();
        var b = U.frag(m.formatJsonPretty(JSON.stringify({ status_message: 'hidden', a: [1, true, null], '<k>': '<b>v</b>' })));
        var keys = Array.prototype.map.call(b.querySelectorAll('.json-key'), function(k) { return k.textContent; });
        assert.deepStrictEqual(keys, ['a', '<k>']);
        assert.strictEqual(b.querySelector('.json-num').textContent, '1'); assert.strictEqual(b.querySelector('.json-bool').textContent, 'true');
        assert.strictEqual(b.querySelector('.json-null').textContent, 'null'); assert.strictEqual(b.querySelector('b'), null);
        assert.strictEqual(b.querySelector('.json-str').textContent, '<b>v</b>');
        var outer = b.querySelectorAll('.json-collapsed'); assert.strictEqual(outer[outer.length - 1].querySelector('.json-preview').textContent, '2 keys');
    }, { tags: ['unit'] });
    test('empty and error states: non-JSON text is escaped, non-strings pass through, empty containers are literal', async function() {
        var m = await load();
        assert.strictEqual(m.formatJsonPretty('<img src=x onerror=1> partial {"a":'), '&lt;img src=x onerror=1&gt; partial {&quot;a&quot;:');
        assert.strictEqual(m.formatJsonPretty(null), null); assert.strictEqual(m.formatJsonPretty(''), '');
        assert.strictEqual(m.formatJsonPretty('[]'), '[]'); assert.strictEqual(m.formatJsonPretty('{}'), '{}');
    }, { tags: ['unit'] });
    test('collapse button toggles expanded/collapsed views; multi-line string preview', async function() {
        var m = await load(), dom = await U.mountDom({ html: '<pre>' + m.formatJsonPretty(JSON.stringify({ list: [1, 2, 3], s: 'l1\nl2\nl3' })) + '</pre>', css: CSS });
        var arrBtn = dom.$$('.json-collapse').filter(function(b) { return /json-arr-/.test(b.getAttribute('onclick')); })[0];
        var id = /'(json-arr-[^']+)'/.exec(arrBtn.getAttribute('onclick'))[1];
        var open = document.getElementById(id), shut = document.getElementById(id + '-collapsed');
        assert.strictEqual(shut.querySelector('.json-preview').textContent, '3 items');
        var r = U.fireInline(arrBtn, 'click', m);
        assert.strictEqual(r.stopped, true); assert.strictEqual(open.style.display, 'none'); assert.strictEqual(shut.style.display, 'inline'); assert.strictEqual(arrBtn.textContent, '+');
        U.fireInline(arrBtn, 'click', m);
        assert.strictEqual(open.style.display, 'inline'); assert.strictEqual(shut.style.display, 'none'); assert.strictEqual(arrBtn.textContent, '−');
        var strPrev = dom.$$('.json-collapsed.json-str .json-preview')[0];
        assert.strictEqual(strPrev.textContent, ' +2 lines');
    }, { tags: ['unit'] });
});

describe('ui message cards › tool-call groups (renderMessages)', function() {
    afterEach(function() { U.cleanupAll(); });
    test('empty chat shows the empty state; a non-empty render removes it', async function() {
        var chat = { id: 'c1', messages: [] }, r = await renderChat(chat);
        assert.strictEqual(r.dom.$('#messages').innerHTML, '');
        assert.strictEqual(r.dom.$('#input-area .empty-state').textContent, 'Start a conversation');
        chat.messages.push({ role: 'user', content: 'hi' }); r.m.renderMessages();
        assert.strictEqual(r.dom.$('#input-area .empty-state'), null); assert.ok(r.dom.$('#msg-0.message.user'));
    }, { tags: ['unit'] });
    test('standard mode: collapsed tool call with name, escaped status message, success badge, result panel and end cards', async function() {
        var r = await renderChat(toolChat(JSON.stringify({ success: true, rows: 2 }), { caveat: 'careful', tldr: 'short', links: [{ title: 'L', url: 'https://x.y' }] }));
        var d = r.dom.$('details.tool-call#tc-1-0');
        assert.ok(d, 'tool-call details'); assert.strictEqual(d.open, false, 'collapsed by default');
        assert.match(d.querySelector('summary .tool-name').textContent, /ServiceNow API/);
        assert.strictEqual(d.querySelector('.tool-status-message').textContent, 'Fetching <b>rows</b>'); assert.strictEqual(d.querySelector('summary b'), null);
        var badge = d.querySelector('.tool-result-badge');
        assert.strictEqual(badge.classList.contains('error'), false); assert.strictEqual(badge.getAttribute('title'), 'Tool call succeeded');
        assert.ok(d.querySelector('.tool-args-wrapper[data-copy-id] pre.tool-args .json-key'), 'args rendered by JSON viewer');
        assert.strictEqual(d.querySelector('.tool-args').textContent.indexOf('status_message'), -1);
        var res = r.dom.$('#msg-2 details.tool-result');
        assert.ok(res); assert.match(res.querySelector('.tool-label').textContent, /ServiceNow API result/);
        var order = r.dom.$$('#msg-3 .caveat-card, #msg-3 .tldr-card, #msg-3 .links-card').map(function(e) { return e.className; });
        assert.deepStrictEqual(order, ['caveat-card', 'tldr-card', 'links-card']);
    }, { tags: ['unit'] });
    test('error result flips the summary badge to the failure state', async function() {
        var r = await renderChat(toolChat(JSON.stringify({ success: false, error: 'boom' })));
        var badge = r.dom.$('#tc-1-0 .tool-result-badge');
        assert.ok(badge.classList.contains('error')); assert.strictEqual(badge.getAttribute('title'), 'Tool call failed');
    }, { tags: ['unit'] });
    test('stored tool-call preference drives open state and each click flips it', async function() {
        var chat = toolChat('"ok"'); chat.messages[1].toolCallsExpanded = { 0: true };
        var r = await renderChat(chat);
        assert.strictEqual(r.dom.$('#tc-1-0').open, true);
        U.fireInline(r.dom.$('#tc-1-0'), 'click', r.m); r.m.renderMessages();
        assert.strictEqual(chat.messages[1].toolCallsExpanded[0], false); assert.strictEqual(r.dom.$('#tc-1-0').open, false);
        U.fireInline(r.dom.$('#tc-1-0'), 'click', r.m); r.m.renderMessages();
        assert.strictEqual(chat.messages[1].toolCallsExpanded[0], true); assert.strictEqual(r.dom.$('#tc-1-0').open, true);
    }, { tags: ['unit'] });
    // onclick runs BEFORE the <details> activation toggle, so with no stored
    // pref toggleToolCallExpanded must treat details.open as the pre-click
    // state and persist the state the user is toggling TO.
    test('first click on a collapsed tool call should persist expanded', async function() {
        var chat = toolChat('"ok"'), r = await renderChat(chat);
        U.fireInline(r.dom.$('#tc-1-0'), 'click', r.m);
        assert.deepStrictEqual(chat.messages[1].toolCallsExpanded, { 0: true });
    }, { tags: ['unit'] });
    test('clicking a tool result persists msg.expanded and re-renders open', async function() {
        var chat = toolChat('"ok"'), r = await renderChat(chat);
        U.fireInline(r.dom.$('#msg-2 details.tool-result'), 'click', r.m);
        assert.strictEqual(chat.messages[2].expanded, true);
        r.m.renderMessages(); assert.strictEqual(r.dom.$('#msg-2 details.tool-result').open, true);
    }, { tags: ['unit'] });
    test('hook tool calls (set_tldr) are hidden by default', async function() {
        var chat = toolChat('"ok"'); chat.messages[1].tool_calls.push(tc('t2', 'set_tldr', { tldr: 'x' }));
        var r = await renderChat(chat);
        assert.ok(r.dom.$('#tc-1-0'), 'regular call still rendered');
        assert.strictEqual(r.dom.$('#tc-1-1'), null, 'hook call hidden');
    }, { tags: ['unit'] });
    test('hostile tool name is escaped in the summary', async function() {
        var chat = toolChat('"ok"'); chat.messages[1].tool_calls[0].function.name = '<img src=x onerror=1>';
        chat.messages[2].name = '<img src=x onerror=1>';
        var r = await renderChat(chat);
        assert.strictEqual(r.dom.$('#messages img'), null);
        assert.match(r.dom.$('#tc-1-0 .tool-name').textContent, /<img src=x onerror=1>/);
    }, { tags: ['unit'] });
    test('compact mode: grouped area summary, toggle persists per chat and re-renders open', async function() {
        var chat = toolChat('"ok"'), r = await renderChat(chat, { compactToolCalls: true });
        var area = r.dom.$('#msg-1 details.compact-tools-area');
        assert.ok(area, 'compact area'); assert.strictEqual(area.open, false);
        assert.strictEqual(area.querySelector('.compact-tools-status').textContent, '1 tool call');
        assert.strictEqual(r.dom.$('#msg-2').style.display, 'none', 'result row hidden in compact mode');
        area.open = true; U.fireInline(area, 'toggle', r.m);
        assert.strictEqual(r.g.compactAreaExpandedState['c1:1'], true);
        r.m.renderMessages(); assert.strictEqual(r.dom.$('#msg-1 details.compact-tools-area').open, true);
    }, { tags: ['unit'] });
    test('collapseOtherTools closes every open panel except the target, scoped to the container', async function() {
        var m = await load();
        var dom = await U.mountDom({ html: '<div id="a"><details class="tool-call" open></details><details class="tool-result" open></details><details class="tool-call" open></details></div><div id="b"><details class="tool-call" open></details></div>' });
        var list = dom.$$('#a details'), target = list[2];
        m.collapseOtherTools(target, dom.$('#a'));
        assert.deepStrictEqual(list.map(function(d) { return d.open; }), [false, false, true]);
        assert.strictEqual(dom.$('#b details').open, true, 'outside container untouched');
    }, { tags: ['unit'] });
    test('getToolIcon returns an svg for known tools and a fallback svg for unknown/empty names', async function() {
        var m = await load();
        [m.getToolIcon('servicenow_api'), m.getToolIcon('no_such_tool'), m.getToolIcon(undefined)].forEach(function(h, i) {
            var b = U.frag(h); assert.ok(b.querySelector('svg.ui-icon'), 'icon #' + i);
        });
    }, { tags: ['unit'] });
});
