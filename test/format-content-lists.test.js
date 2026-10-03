// Nested / mixed markdown lists in formatContent (ui/250-message-render.js).
// Run: run_tests { pattern: 'format-content-lists' }
'use strict';
var emojiSrc = await loadFile('src/js/core/055-emoji-shortcodes.js');
var renderSrc = await loadFile('src/js/ui/250-message-render.js');
var start = renderSrc.indexOf('function formatContent(content) {');
var end = renderSrc.indexOf('// Render a transient "queued" user bubble');
if (start < 0 || end < 0 || end <= start) throw new Error('format-content-lists: could not slice formatContent');
var stubs = [
  "function escapeHtml(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }",
  'function highlightJS(c){ return escapeHtml(c); }',
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

describe('format-content nested lists', function() {
  test('3-level bullet nesting lands inside parent <li>', function() {
    assert.strictEqual(fc('- a\n- b\n  - b1\n  - b2\n    - b2x\n- c'),
      '<ul><li>a</li><li>b<ul><li>b1</li><li>b2<ul><li>b2x</li></ul></li></ul></li><li>c</li></ul>');
  }, { tags: ['unit'] });

  test('ordered list keeps numbering across a nested bullet', function() {
    var h = fc('1. one\n2. two\n   - sub\n3. three');
    assert.strictEqual(h, '<ol><li>one</li><li>two<ul><li>sub</li></ul></li><li>three</li></ol>');
    assert.strictEqual((h.match(/<ol/g) || []).length, 1, 'single <ol>, no restart');
  }, { tags: ['unit'] });

  test('* and + markers are bullets', function() {
    assert.strictEqual(fc('* x\n+ y\n- z'), '<ul><li>x</li><li>y</li><li>z</li></ul>');
  }, { tags: ['unit'] });

  test('4-space and tab indentation nest (tab = 4 columns)', function() {
    assert.strictEqual(fc('- a\n    - four\n\t- tab\n- b'),
      '<ul><li>a<ul><li>four</li><li>tab</li></ul></li><li>b</li></ul>');
  }, { tags: ['unit'] });

  test('dedent by two levels returns to the root list', function() {
    assert.strictEqual(fc('- a\n  - b\n    - c\n- d'),
      '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  }, { tags: ['unit'] });

  test('nested ordered list under a bullet, with 1) markers', function() {
    assert.strictEqual(fc('- a\n  1) x\n  2) y\n- b'),
      '<ul><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ul>');
  }, { tags: ['unit'] });

  test('indented continuation line stays in the item', function() {
    assert.strictEqual(fc('- item\n  more text\n- next'), '<ul><li>item<br>more text</li><li>next</li></ul>');
  }, { tags: ['unit'] });

  test('continuation paragraph after a blank line stays in the item', function() {
    assert.strictEqual(fc('- item\n\n  para two\n- next'),
      '<ul><li>item<span class="md-paragraph md-li-paragraph">para two</span></li><li>next</li></ul>');
  }, { tags: ['unit'] });

  test('inline code and bold inside nested items', function() {
    assert.strictEqual(fc('- **b**\n  - `c` x'),
      '<ul><li><strong>b</strong><ul><li><code class="inline-code">c</code> x</li></ul></li></ul>');
  }, { tags: ['unit'] });

  test('list right after a paragraph (no blank line) and text after', function() {
    assert.strictEqual(fc('Intro:\n- a\n- b\n\nOutro'),
      '<span class="md-paragraph">Intro:</span><ul><li>a</li><li>b</li></ul><span class="md-paragraph">Outro</span>');
  }, { tags: ['unit'] });

  test('loose list (blank lines between items) is one list without <br>', function() {
    assert.strictEqual(fc('- a\n\n- b\n\n  - b1\n\n- c'), '<ul><li>a</li><li>b<ul><li>b1</li></ul></li><li>c</li></ul>');
  }, { tags: ['unit'] });

  test('ordered list starting at N keeps start=, kind change starts new list', function() {
    assert.strictEqual(fc('3. c\n4. d\n- x'), '<ol start="3"><li>c</li><li>d</li></ol><ul><li>x</li></ul>');
  }, { tags: ['unit'] });

  test('fenced code inside an item stays inside the <li>', function() {
    var h = fc('1. s\n   ```js\n   x\n   ```\n2. t');
    assert.match(h, /^<ol><li>s<div class="code-block-wrapper"[\s\S]*<\/div><\/li><li>t<\/li><\/ol>$/);
  }, { tags: ['unit'] });

  test('non-list text: hr-like and **bold** lines are not list items', function() {
    var h = fc('---\n**Bold** text');
    assert.ok(h.indexOf('<li>') < 0, h);
  }, { tags: ['unit'] });
});
