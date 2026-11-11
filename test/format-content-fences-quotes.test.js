// formatContent (ui/250-message-render.js): CommonMark fence matching, code
// spans with equal-length backtick runs, line breaks inside blockquotes, and
// ```text / ```plaintext / ```txt blocks that are never highlighted.
// Run: run_tests { pattern: 'format-content-fences-quotes' }
'use strict';
var emojiSrc = await loadFile('src/js/core/055-emoji-shortcodes.js');
var renderSrc = await loadFile('src/js/ui/250-message-render.js');
var cssSrc = await loadFile('src/css/07-markdown.css');
var start = renderSrc.indexOf('function formatContent(content) {');
var end = renderSrc.indexOf('// Render a transient "queued" user bubble');
if (start < 0 || end < 0 || end <= start) throw new Error('format-content-fences-quotes: could not slice formatContent');
var stubs = [
  "function escapeHtml(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); }",
  // Marks highlighted output so tests can see WHICH blocks were highlighted.
  "function highlightJS(c){ return '[HL]' + escapeHtml(c); }",
  "function storeRawCopy(c){ return 'copyX'; }",
  "var UI_ICONS = { copy: 'C' };",
  "function renderDisplayPlaceholder(id){ return '[DSP]'; }",
  "function renderDocumentPlaceholder(id){ return '[DOC]'; }",
  'function escapeAttr(t){ return escapeHtml(t); }',
  'function getWidgetById(){ return null; }',
  'function t(s){ return s; }',
  'var window = { currentSearchHighlight: null };'
].join('\n');
var fc = new Function(stubs + '\n' + emojiSrc + '\n' + renderSrc.slice(start, end) + '\nreturn formatContent;')();
var T = { tags: ['unit'] };
var P = function(s) { return '<span class="md-paragraph">' + s + '</span>'; };
function codeOf(html) {
  var out = [], re = /<pre class="([^"]*)"><code>([\s\S]*?)<\/code><\/pre>/g, m;
  while ((m = re.exec(html)) !== null) out.push({ cls: m[1], code: m[2] });
  return out;
}
function bqInner(html) {
  var m = /<blockquote class="md-blockquote">([\s\S]*)<\/blockquote>/.exec(html);
  return m ? m[1] : null;
}

describe('bug 1: blockquote line breaks', function() {
  test('consecutive > lines join with <br>; a quoted blank > splits paragraphs; copy button kept', function() {
    var h = fc('> Hi Bob,\n>\n> Thanks for the update.\n> See you soon.\n>\n> Best,\n> Alice');
    assert.strictEqual(bqInner(h), P('Hi Bob,') + P('Thanks for the update.<br>See you soon.') + P('Best,<br>Alice'));
    assert.ok(h.indexOf('quote-copy-btn') > 0, 'quote copy button kept');
  }, T);
  test('a stray ``` in a quote line no longer folds the following quote lines into an inline <code>', function() {
    var h = fc('> Use a fenced ```text block.\n> Line two\n> Line three');
    assert.strictEqual(bqInner(h), P('Use a fenced ```text block.<br>Line two<br>Line three'));
  }, T);
});

describe('bug 2: code spans (CommonMark backtick runs)', function() {
  test('the reported input: ``` is literal, `>` is code, the following list renders', function() {
    var h = fc('> Rule: put it in a fenced ```text code block \u2014 never a `>` blockquote.\n\n- item one\n- item `two`\n- three');
    assert.ok(h.indexOf('fenced ```text code block \u2014 never a <code class="inline-code">&gt;</code> blockquote.') > 0, h);
    assert.ok(/<\/div><ul><li>item one<\/li><li>item <code class="inline-code">two<\/code><\/li><li>three<\/li><\/ul>$/.test(h), h);
  }, T);
  test('a run closes only on a run of equal length', function() {
    assert.strictEqual(fc('a ``x ` y`` b'), P('a <code class="inline-code">x ` y</code> b'));
    assert.strictEqual(fc('`` `x` ``'), P('<code class="inline-code">`x`</code>'));
    assert.strictEqual(fc('`a``b`'), P('<code class="inline-code">a``b</code>'));
  }, T);
  test('spans never cross a blank line or a block start (list item, quote line)', function() {
    assert.strictEqual(fc('one ` two\n- three ` four'), P('one ` two') + '<ul><li>three ` four</li></ul>');
    assert.ok(fc('> a ` b\n> c ` d').indexOf('inline-code') < 0, 'no span across quote lines');
    assert.strictEqual(fc('a `x\ny` b'), P('a <code class="inline-code">x\ny</code> b'), 'soft break inside one paragraph is allowed');
    assert.strictEqual(fc('x `` y\n\nz `` w'), P('x `` y') + P('z `` w'));
  }, T);
});

describe('bug 3: fence matching', function() {
  test('prose after a ```text block is outside the block', function() {
    var h = fc('```text\nhello\n```\n\nProse after.');
    assert.deepStrictEqual(codeOf(h).map(function(c) { return c.code; }), ['hello\n']);
    assert.ok(/<\/div><span class="md-paragraph">Prose after\.<\/span>$/.test(h), h);
  }, T);
  test('a mid-line ``` neither opens nor closes a fence', function() {
    var h = fc('```text\nsay ```hi``` here\n```\nafter');
    assert.deepStrictEqual(codeOf(h).map(function(c) { return c.code; }), ['say ```hi``` here\n']);
    assert.ok(/<\/div><span class="md-paragraph">after<\/span>$/.test(h), h);
    assert.ok(fc('see ```js and more').indexOf('code-block') < 0);
  }, T);
  test('a ```` fence contains ``` lines; a shorter run does not close it', function() {
    var h = fc('````md\n```js\nx\n```\n````\nafter');
    assert.deepStrictEqual(codeOf(h).map(function(c) { return c.code; }), ['```js\nx\n```\n']);
    assert.ok(/<span class="md-paragraph">after<\/span>$/.test(h), h);
  }, T);
  test('closer: same character, may be longer, 0-3 spaces, nothing else on the line', function() {
    assert.deepStrictEqual(codeOf(fc('~~~\na\n```\n~~~~\nz')).map(function(c) { return c.code; }), ['[HL]a\n```\n']);
    assert.deepStrictEqual(codeOf(fc('```\na\n   ```\nz')).map(function(c) { return c.code; }), ['[HL]a\n']);
    assert.deepStrictEqual(codeOf(fc('```\na\n``` x\n```\nz')).map(function(c) { return c.code; }), ['[HL]a\n``` x\n']);
    assert.deepStrictEqual(codeOf(fc('```\na\n    ```\nb\n```')).map(function(c) { return c.code; }), ['[HL]a\n    ```\nb\n']);
  }, T);
  test('unterminated fence still runs to the end (streaming)', function() {
    assert.deepStrictEqual(codeOf(fc('Streaming:\n```python\nprint(1)\n')).map(function(c) { return c.code; }), ['print(1)\n']);
  }, T);
  test('fence inside a quote: > markers stripped, block ends at the closer, quote continues', function() {
    var h = fc('> ```\n> a\n> ```\n> after');
    assert.deepStrictEqual(codeOf(h).map(function(c) { return c.code; }), ['[HL]a\n']);
    assert.ok(/<\/div><span class="md-paragraph">after<\/span><\/blockquote>/.test(h), h);
  }, T);
  test('deeply nested > lines do not backtrack catastrophically in fence detection', function() {
    var t0 = Date.now();
    var h = fc('&gt; '.repeat(0) + '> '.repeat(40) + 'deep\n' + '> '.repeat(30) + ' x');
    assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
    assert.ok(h.indexOf('deep') >= 0);
  }, T);
  test('indented fence inside a list item stays in the <li> and loses the item indent', function() {
    var h = fc('1. s\n   ```js\n   x\n   ```\n2. t');
    assert.match(h, /^<ol><li>s<div class="code-block-wrapper"[\s\S]*<\/div><\/li><li>t<\/li><\/ol>$/);
    assert.deepStrictEqual(codeOf(h).map(function(c) { return c.code; }), ['[HL]x\n']);
  }, T);
});

describe('bug 4: text/plaintext/txt blocks', function() {
  test('never highlighted, tagged .code-block-text; real code languages unchanged', function() {
    ['text', 'plaintext', 'txt', 'TEXT'].forEach(function(lang) {
      var c = codeOf(fc('```' + lang + "\nit's in for case\n```"))[0];
      assert.strictEqual(c.code, 'it&#39;s in for case\n', lang);
      assert.strictEqual(c.cls, 'code-block code-block-text collapsed', lang);
    });
    assert.ok(fc('```text\nx\n```').indexOf('class="code-block-wrapper code-block-text"') >= 0);
    assert.strictEqual(codeOf(fc('```js\nfor (x in y) {}\n```'))[0].code, '[HL]for (x in y) {}\n');
    assert.strictEqual(codeOf(fc('```\nvar a\n```'))[0].code, '[HL]var a\n');
    assert.strictEqual(codeOf(fc('```python\nfor x in y\n```'))[0].cls, 'code-block collapsed');
  }, T);
  test('CSS: text blocks wrap (pre-wrap) with the prose font, also when collapsed', function() {
    var m = /\.code-block\.code-block-text,\s*\.code-block\.code-block-text\.collapsed\s*\{([^}]*)\}/.exec(cssSrc);
    assert.ok(m, 'rule present');
    assert.match(m[1], /white-space:\s*pre-wrap/);
    assert.match(m[1], /font-family:\s*var\(--font-sans\)/);
  }, T);
});
