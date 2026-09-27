// RG-B9 (NEW-T11-1 / NEW-T11-2): formatContent (ui/250-message-render.js)
// renders numbered items as <ol> (separate from bullet <ul> lists, first
// number kept via start=) and a GFM table header row (first row followed by a
// | --- | delimiter) as <thead>/<th> with the body in <tbody>. Every other
// markdown path must stay byte-identical: the GOLDENS below were captured from
// the pre-fix formatContent. A computed-style check covers the matching
// 07-markdown.css header rule. Loader = the slice + stubs of
// test/format-content.test.js.
// Run: run_tests { pattern: 'rg-b9' }   (js_eval sandbox; see test/harness.js)
'use strict';
var emojiSrc = await loadFile('src/js/core/055-emoji-shortcodes.js');
var renderSrc = await loadFile('src/js/ui/250-message-render.js');
var cssSrc = await loadFile('src/css/07-markdown.css');
// Extract ONLY formatContent — the rest of 250 touches the DOM.
var start = renderSrc.indexOf('function formatContent(content) {');
var end = renderSrc.indexOf('// Render a transient "queued" user bubble');
if (start < 0 || end < 0 || end <= start) throw new Error('rg-b9: could not slice formatContent from 250-message-render.js');
var stubs = [
  "function escapeHtml(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }",
  'function highlightJS(c){ return escapeHtml(c); }',
  "function storeRawCopy(c){ return 'copyX'; }",
  "var UI_ICONS = { copy: 'C' };",
  "function renderDisplayPlaceholder(id){ return '[DSP]'; }",
  "function renderDocumentPlaceholder(id){ return '[DOC]'; }",
  'function escapeAttr(t){ return escapeHtml(t); }',
  'function getWidgetById(){ return null; }',
  'var window = { currentSearchHighlight: null };'
].join('\n');
var fc = new Function(stubs + '\n' + emojiSrc + '\n' + renderSrc.slice(start, end) + '\nreturn formatContent;')();
var T = { tags: ['unit'], timeout: 2000 };

function count(s, re) { return (s.match(re) || []).length; }
function codeBlockHtml(inner) {
  return '<div class="code-block-wrapper" data-copy-id="copyX"><button class="code-block-expand-btn" onclick="toggleCodeBlockExpand(this, event)" title="Expand">\u2922</button>' +
    '<pre class="code-block collapsed"><code>' + inner + '</code></pre>' +
    '<button class="code-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">C</button></div>';
}
function assertBalanced(html) {
  [['table', /<table\b/g, /<\/table>/g], ['thead', /<thead>/g, /<\/thead>/g], ['tbody', /<tbody>/g, /<\/tbody>/g],
   ['ul', /<ul>/g, /<\/ul>/g], ['ol', /<ol\b/g, /<\/ol>/g], ['blockquote', /<blockquote\b/g, /<\/blockquote>/g]
  ].forEach(function(p) { assert.strictEqual(count(html, p[1]), count(html, p[2]), p[0] + ' open/close balance in: ' + html); });
}
var HDR = '<table class="md-table"><thead><tr><th>H</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>';
var BQ = '<blockquote class="md-blockquote"><span class="md-paragraph">q</span></blockquote>';

describe('rg-b9 ordered lists (NEW-T11-1)', function() {
  test('numbered-only list renders as <ol>, never <ul>', function() {
    assert.strictEqual(fc('1. x\n2. y'), '<ol><li>x</li><li>y</li></ol>');
  }, T);
  test('bullets then numbers (blank line between) are two separate lists', function() {
    assert.strictEqual(fc('- a\n- b\n\n1. first\n2. second'), '<ul><li>a</li><li>b</li></ul><ol><li>first</li><li>second</li></ol>');
  }, T);
  test('numbers then adjacent bullets are two separate lists', function() {
    assert.strictEqual(fc('1. a\n2. b\n- c'), '<ol><li>a</li><li>b</li></ol><ul><li>c</li></ul>');
  }, T);
  test('alternating kinds each get their own list; a later <ol> keeps its number', function() {
    assert.strictEqual(fc('- a\n1. b\n- c\n2. d'), '<ul><li>a</li></ul><ol><li>b</li></ol><ul><li>c</li></ul><ol start="2"><li>d</li></ol>');
  }, T);
  test('blank lines between same-kind items keep ONE list', function() {
    assert.strictEqual(fc('1. a\n\n2. b\n\n3. c'), '<ol><li>a</li><li>b</li><li>c</li></ol>');
    assert.strictEqual(fc('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>');
  }, T);
  test('steps split by a fenced code block continue via start=', function() {
    assert.strictEqual(fc('1. Step one\n\n```sh\nnpm i\n```\n\n2. Step two'),
      '<ol><li>Step one</li></ol>' + codeBlockHtml('npm i\n') + '<ol start="2"><li>Step two</li></ol>');
  }, T);
  test('a list starting at 3. carries start="3"', function() {
    assert.strictEqual(fc('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  }, T);
  test('numbered steps with indented sub-bullets keep their numbering', function() {
    assert.strictEqual(fc('1. **Step one**\n   - detail a\n2. Step two'),
      '<ol><li><strong>Step one</strong></li></ol><ul><li>detail a</li></ul><ol start="2"><li>Step two</li></ol>');
  }, T);
  test('lazy 1. numbering and 01. add no start; a >9-digit first number is not used as start', function() {
    assert.strictEqual(fc('1. a\n1. b\n1. c'), '<ol><li>a</li><li>b</li><li>c</li></ol>');
    assert.strictEqual(fc('01. a\n02. b'), '<ol><li>a</li><li>b</li></ol>');
    assert.strictEqual(fc('1234567890. big'), '<ol><li>big</li></ol>');
  }, T);
  test('all 4 list close sites emit the matching </ol> (table, blockquote, text, end of input)', function() {
    var cases = [
      [fc('1. a\n| x | y |'), '<ol><li>a</li></ol><table class="md-table"><tr><td>x</td><td>y</td></tr></table>'],
      [fc('1. a\n> q'), '<ol><li>a</li></ol>' + BQ],
      [fc('1. a\ntext'), '<ol><li>a</li></ol><span class="md-paragraph">text</span>'],
      [fc('1. a'), '<ol><li>a</li></ol>']
    ];
    cases.forEach(function(c) { assert.strictEqual(c[0], c[1]); assertBalanced(c[0]); });
  }, T);
});

describe('rg-b9 table header (NEW-T11-2)', function() {
  test('first row + delimiter row renders <thead>/<th>, body rows in <tbody>', function() {
    var html = fc('| H1 | H2 |\n| --- | --- |\n| a | b |');
    assert.strictEqual(html, '<table class="md-table"><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>');
    assert.strictEqual(html.indexOf('<td>H1</td>'), -1);
  }, T);
  test('alignment delimiters (:---, ---:) also mark the header', function() {
    assert.strictEqual(fc('| L | R |\n|:---|---:|\n| 1 | 2 |'),
      '<table class="md-table"><thead><tr><th>L</th><th>R</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  }, T);
  test('a header-only table gets an empty <tbody>', function() {
    assert.strictEqual(fc('| H1 | H2 |\n| --- | --- |'), '<table class="md-table"><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody></tbody></table>');
  }, T);
  test('a table without a delimiter row keeps the old <tr><td> markup', function() {
    assert.strictEqual(fc('| a | b |\n| c | d |'), '<table class="md-table"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
  }, T);
  test('a later delimiter row does not turn a body row into a header', function() {
    var html = fc('| a | b |\n| c | d |\n| --- | --- |\n| e | f |');
    assert.strictEqual(html, '<table class="md-table"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr><tr><td>e</td><td>f</td></tr></table>');
  }, T);
  test('all 4 table close sites emit </tbody></table> after a header (blockquote, list, text, end)', function() {
    var t = '| H |\n| - |\n| v |\n';
    var cases = [
      [fc(t + '> q'), HDR + BQ],
      [fc(t + '- x'), HDR + '<ul><li>x</li></ul>'],
      [fc(t + 'after'), HDR + '<span class="md-paragraph">after</span>'],
      [fc(t.slice(0, -1)), HDR]
    ];
    cases.forEach(function(c) { assert.strictEqual(c[0], c[1]); assertBalanced(c[0]); });
  }, T);
  test('a header table right after a list closes the list first and stays balanced', function() {
    var html = fc('1. a\n| H |\n| - |\n| v |');
    assert.strictEqual(html, '<ol><li>a</li></ol>' + HDR);
    assertBalanced(fc('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| C | D |\n| --- | --- |\n| 3 | 4 |'));
  }, T);
});

describe('rg-b9 goldens: other markdown paths are byte-identical to the pre-fix output', function() {
  var GOLDENS = [
    ['fenced code block', 'Intro\n\n```js\nvar a = 1 < 2;\nvar b = "x";\n```\n\nOutro',
      '<span class="md-paragraph">Intro</span>' + codeBlockHtml('var a = 1 &lt; 2;\nvar b = &quot;x&quot;;\n') + '<span class="md-paragraph">Outro</span>'],
    ['inline marks', '**bold** *em* `code` ~~gone~~ _u_',
      '<span class="md-paragraph"><strong>bold</strong> *em* <code class="inline-code">code</code> ~~gone~~ _u_</span>'],
    ['links', 'See [docs](https://example.com/a?b=1&c=2) and https://example.org/x.',
      '<span class="md-paragraph">See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener">docs</a> and <a href="https://example.org/x" target="_blank" rel="noopener">https://example.org/x</a>.</span>'],
    ['bullets', '- one\n- two\n\n- three\n\nafter',
      '<ul><li>one</li><li>two</li><li>three</li></ul><span class="md-paragraph">after</span>'],
    ['header-less table', '| a | b |\n| c | d |',
      '<table class="md-table"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'],
    ['blockquote', '> quote line\n> more\n>\n> second para\n\ntext',
      '<blockquote class="md-blockquote"><span class="md-paragraph">quote line<br>more</span><span class="md-paragraph">second para</span></blockquote><span class="md-paragraph">text</span>'],
    ['headings', '# H1\n## H2\n### H3\n#### H4\n\nbody',
      '<h2>H1</h2><h3>H2</h3><h4>H3</h4><span class="md-paragraph"><h5>H4</h5></span><span class="md-paragraph">body</span>'],
    ['mixed document', '## Title\n\nPara one\nline two\n\n- a\n- b\n\n| x | y |\n| z | w |\n\n> q\n\n```\ncode\n```\n\nEnd **b** [l](https://e.com)',
      '<h3>Title</h3><span class="md-paragraph">Para one<br>line two</span><ul><li>a</li><li>b</li></ul>' +
      '<table class="md-table"><tr><td>x</td><td>y</td></tr><tr><td>z</td><td>w</td></tr></table>' + BQ + codeBlockHtml('code\n') +
      '<span class="md-paragraph">End <strong>b</strong><a href="https://e.com" target="_blank" rel="noopener">l</a></span>']
  ];
  GOLDENS.forEach(function(g) {
    test('golden: ' + g[0], function() { assert.strictEqual(fc(g[1]), g[2]); }, T);
  });
});

describe('rg-b9 header CSS (07-markdown.css header rule)', function() {
  test('th gets the header look, the first body row after a <thead> does not, a header-less first row keeps it', function() {
    if (typeof document === 'undefined' || !document.body || typeof getComputedStyle !== 'function') skipTest('no DOM in this sandbox');
    var host = document.createElement('div');
    host.setAttribute('style', 'font-weight: 400; --font-semibold: 600; --bg-code: rgb(10, 20, 30); --text-primary: rgb(1, 2, 3); --bg-light: rgb(200, 201, 202); --border: rgb(0, 0, 0); --border-dark: rgb(0, 0, 0);');
    var style = document.createElement('style');
    style.textContent = cssSrc;
    host.appendChild(style);
    var box = document.createElement('div');
    box.innerHTML = fc('| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |') + fc('| x | y |\n| z | w |');
    host.appendChild(box);
    document.body.appendChild(host);
    try {
      var tables = box.querySelectorAll('table.md-table');
      assert.strictEqual(tables.length, 2);
      var th = tables[0].querySelector('thead th');
      var bodyFirstTd = tables[0].querySelector('tbody tr td');
      var plainRows = tables[1].querySelectorAll('tr');
      assert.ok(th, 'header table has no <thead><th>: ' + box.innerHTML);
      assert.strictEqual(getComputedStyle(th).fontWeight, '600');
      assert.strictEqual(getComputedStyle(th).backgroundColor, 'rgb(10, 20, 30)');
      assert.strictEqual(getComputedStyle(bodyFirstTd).fontWeight, '400');
      assert.strictEqual(getComputedStyle(bodyFirstTd).backgroundColor, 'rgba(0, 0, 0, 0)');
      assert.strictEqual(getComputedStyle(plainRows[0].querySelector('td')).fontWeight, '600');
      assert.strictEqual(getComputedStyle(plainRows[0].querySelector('td')).backgroundColor, 'rgb(10, 20, 30)');
      assert.strictEqual(getComputedStyle(plainRows[1].querySelector('td')).backgroundColor, 'rgba(0, 0, 0, 0)');
    } finally {
      host.remove();
    }
  }, T);
});

// ---------------------------------------------------------------------------
// RG-B9 P2 (NEW-T11-3): a screenshot/pdf/file that joins an attachment group is
// drawn inside the group's .attachments-row at the first member's slot, and its
// own slot keeps a hidden placeholder. That placeholder must NOT repeat
// id="msg-N" (duplicate DOM ids); it carries data-grouped-msg="N" instead.
// Runs the REAL renderMessages (+ the 8 helpers it needs, sliced from 250) in
// with(env) on the sandbox document; only external effects are stubbed.
describe('rg-b9 P2: attachment-group placeholders carry no duplicate msg-N id', function() {
  var T2 = { tags: ['unit'], timeout: 5000 };
  function declaration(source, name) {
    var s = source.indexOf('\nfunction ' + name + '(');
    var e = source.indexOf('\n}', s + 1);
    if (s < 0 || e < 0) throw new Error('rg-b9 P2: missing declaration ' + name);
    return source.slice(s + 1, e + 2);
  }
  var PARTS = ['isAttachmentRole', 'renderAttachmentContent', 'findAdjacentForAttachmentGroup', '_renderSig',
    '_sigHasWidget', '_tryIncrementalRender', '_sweepOrphanedParkedWidgets', '_renderCompactThinking',
    'renderMessages'].map(function(n) { return declaration(renderSrc, n); });
  function noop() {}
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function makeEnv(messages, compact) {
    return {
      chats: { A: { messages: messages } }, currentChatId: 'A', window: { isRunning: false },
      UI_ICONS: { eye: 'E', copy: 'C' }, _lastRenderState: { chatId: null, count: 0, sigs: [] },
      activeStreamingChatId: null, thinkingExpandedState: {}, compactAreaExpandedState: {}, userMsgExpandedState: {},
      hooksEnabled: { showHookMessages: true }, showApiStats: false, showMessageSource: false, compactToolCalls: !!compact,
      console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
      isChatRunning: function() { return false; }, _getWindowStart: function() { return 0; },
      formatContent: esc, escapeHtml: esc, escapeDataUrlAttr: esc, renderInlineChanges: function() { return ''; },
      updateContextIndicator: noop, updateInputPosition: noop, _captureTranscriptFocus: noop, _restoreTranscriptFocus: noop,
      renderQueuedUserBubble: noop, updateVersionSidebarVisibility: noop, renderVersionSidebar: noop,
      initializeWidgetsInView: noop, renderWidgetSidebar: noop, initDisplayChecklists: noop, pinToBottom: noop,
      scrollToBottomIfAllowed: noop, _attachRowScrollShadow: noop, restoreChatScrollTop: noop,
      stickToBottom: false, // a BOOLEAN in 250 (read + assigned), not a function
      TOOL_DISPLAY_NAMES: {}, isHookToolName: function() { return false; }, toolResultIsError: function() { return false; },
      extractStatusMessage: function() { return ''; }, getToolIcon: function() { return ''; },
      getWidgetHtmlForMessage: function() { return ''; },
      formatJsonPretty: function(x) { return esc(typeof x === 'string' ? x : JSON.stringify(x)); },
      escapeJsString: function(x) { return String(x); }, storeRawCopy: function() { return 'copyX'; }
    };
  }
  function build(env) {
    return new Function('env', 'with (env) {\n' + PARTS.join('\n') + '\nreturn renderMessages;\n}')(env);
  }
  var PNG = 'data:image/png;base64,iVBORw0KGgo=';
  function shot(n) { return { role: 'screenshot', name: 'Shot ' + n, base64: PNG }; }
  function toolMsg(id) { return { role: 'tool', tool_call_id: id, name: 'take_screenshot', content: '{"success":true}' }; }
  function fixture() {
    return [
      { role: 'user', content: 'take two screenshots' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'take_screenshot', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'take_screenshot', arguments: '{}' } }] },
      toolMsg('c1'), shot(1), toolMsg('c2'), shot(2)
    ];
  }
  function withHost(fn) {
    var host = document.createElement('div');
    host.innerHTML = '<div id="messages"></div>';
    document.body.appendChild(host);
    try { return fn(host.querySelector('#messages')); } finally { host.remove(); }
  }
  function idCounts(root) {
    var c = {};
    Array.prototype.forEach.call(root.querySelectorAll('[id^="msg-"]'), function(el) { c[el.id] = (c[el.id] || 0) + 1; });
    return c;
  }
  function expectIds(n) { var c = {}; for (var i = 0; i < n; i++) c['msg-' + i] = 1; return c; }
  function placeholders(root) {
    return Array.prototype.filter.call(root.children, function(el) { return el.hasAttribute('data-grouped-msg'); });
  }
  function noRenderErrors(root) {
    assert.strictEqual(root.querySelectorAll('.render-error').length, 0, 'render-error rows: ' + root.textContent.slice(0, 300));
  }

  [false, true].forEach(function(compact) {
    test('P2-1 each msg-N id appears once; msg-3 and msg-5 share one .attachments-row (compactToolCalls=' + compact + ')', function() {
      withHost(function(root) {
        build(makeEnv(fixture(), compact))();
        noRenderErrors(root);
        assert.deepStrictEqual(idCounts(root), expectIds(6));
        var row = root.querySelector('#msg-3').closest('.attachments-row');
        assert.ok(row, 'msg-3 is not inside an .attachments-row');
        assert.ok(row.querySelector('#msg-5'), 'msg-5 is not in the msg-3 .attachments-row');
      });
    }, T2);
  });

  test('P2-2 the grouped slot keeps a hidden, id-less placeholder with data-grouped-msg', function() {
    withHost(function(root) {
      build(makeEnv(fixture(), false))();
      noRenderErrors(root);
      assert.strictEqual(root.children.length, 6);
      var ph = root.children[5];
      assert.strictEqual(ph.style.display, 'none');
      assert.strictEqual(ph.getAttribute('data-grouped-msg'), '5');
      assert.strictEqual(ph.hasAttribute('id'), false);
      assert.strictEqual(ph.className, 'message screenshot');
    });
  }, T2);

  test('P2-3 getElementById(msg-5) resolves to the visible in-row copy', function() {
    withHost(function(root) {
      build(makeEnv(fixture(), false))();
      var el = document.getElementById('msg-5');
      assert.ok(el && root.contains(el), 'msg-5 not found in #messages');
      assert.ok(el.closest('.attachments-row'), 'msg-5 lookup hit the out-of-row placeholder');
      assert.notStrictEqual(el.style.display, 'none');
      assert.ok(el.querySelector('img.screenshot-thumbnail'), 'msg-5 lookup has no thumbnail');
    });
  }, T2);

  test('P2-4 re-renders keep msg-N ids unique (same count, new user turn, 3rd screenshot joins the group)', function() {
    withHost(function(root) {
      var msgs = fixture();
      var render = build(makeEnv(msgs, false));
      render();
      render(); // same-count re-render
      assert.deepStrictEqual(idCounts(root), expectIds(6), 'same-count re-render');
      msgs.push({ role: 'user', content: 'thanks' });
      render();
      noRenderErrors(root);
      assert.deepStrictEqual(idCounts(root), expectIds(7), 'added user turn');
      assert.strictEqual(root.querySelector('#msg-6').parentNode, root, 'msg-6 is not a direct child of #messages');
    });
    withHost(function(root) {
      var msgs = fixture();
      var render = build(makeEnv(msgs, false));
      render();
      msgs.push(shot(3));
      render();
      noRenderErrors(root);
      assert.deepStrictEqual(idCounts(root), expectIds(7), '3rd screenshot joins the group');
      var row = root.querySelector('#msg-3').closest('.attachments-row');
      assert.ok(row && row.querySelector('#msg-5') && row.querySelector('#msg-6'), 'msg-5/msg-6 not in the msg-3 row');
      assert.deepStrictEqual(placeholders(root).map(function(el) { return el.getAttribute('data-grouped-msg') + ':' + el.hasAttribute('id'); }), ['5:false', '6:false']);
    });
  }, T2);

  test('P2-5 a screenshot + pdf + file group renders each msg-N id once', function() {
    withHost(function(root) {
      build(makeEnv([
        { role: 'user', content: 'attach' },
        { role: 'screenshot', name: 'S', base64: PNG },
        { role: 'pdf', name: 'doc.pdf', base64: 'data:application/pdf;base64,JVBERi0=' },
        { role: 'file', name: 'notes.txt', content: 'hello' }
      ], false))();
      noRenderErrors(root);
      assert.deepStrictEqual(idCounts(root), expectIds(4));
      var row = root.querySelector('#msg-1').closest('.attachments-row');
      assert.ok(row && row.querySelector('#msg-2') && row.querySelector('#msg-3'), 'pdf/file not in the screenshot row');
      assert.deepStrictEqual(placeholders(root).map(function(el) { return el.getAttribute('data-grouped-msg') + ':' + el.className; }), ['2:message pdf', '3:message file']);
    });
  }, T2);
});
