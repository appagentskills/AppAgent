// Regression: bold bleeding across the whole chat transcript.
// formatContent's bold pass used /\*\*([^*]+)\*\*/ (spans newlines), so two
// unrelated `**` produced <strong> in one block and </strong> inside a table
// cell — a parser no-op — and the <strong> re-opened in every later message of
// the joined renderMessages innerHTML.
// Run: run_tests { pattern: 'format-content-bold-bleed' }
'use strict';
var emojiSrc = await loadFile('src/js/core/055-emoji-shortcodes.js');
var renderSrc = await loadFile('src/js/ui/250-message-render.js');
var start = renderSrc.indexOf('function formatContent(content) {');
var end = renderSrc.indexOf('// Render a transient "queued" user bubble');
if (start < 0 || end < 0 || end <= start) throw new Error('format-content-bold-bleed: could not slice formatContent');
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

var TRIGGER_TABLE_CELL = 'Summary **important\n\n| Col | Val** |\n|---|---|\n| a | b |';
var TRIGGER_GLOBS = 'Patterns: src/**/x.js\n\n| glob | note |\n|---|---|\n| lib/** | all |';

function wrap(i, inner) {
  return '<div class="message" id="msg-' + i + '"><div class="message-content">' + inner + '</div></div>';
}
// Mirror renderMessages: all message parts joined into ONE innerHTML string.
function laterTurnsBold(firstMd) {
  var joined = wrap(0, fc(firstMd)) + wrap(1, fc('Second turn, plain text.')) + wrap(2, fc('Third turn.'));
  var doc = new DOMParser().parseFromString('<div id="messages">' + joined + '</div>', 'text/html');
  return ['msg-1', 'msg-2'].filter(function(id) {
    var el = doc.getElementById(id);
    return !el || !!el.querySelector('strong') || !!el.closest('strong');
  });
}
function count(re, s) { return (s.match(re) || []).length; }

describe('format-content bold never bleeds across blocks or turns', function() {
  test('bold does not span lines (table-cell trigger)', function() {
    var h = fc(TRIGGER_TABLE_CELL);
    assert.ok(h.indexOf('<strong>') === -1, 'no cross-line <strong>: ' + h);
    assert.ok(h.indexOf('**important') !== -1, 'unmatched ** stays literal: ' + h);
  }, { tags: ['unit'] });

  test('glob ** across a paragraph and a table cell stays literal', function() {
    var h = fc(TRIGGER_GLOBS);
    assert.ok(h.indexOf('<strong>') === -1, 'no <strong>: ' + h);
    assert.ok(h.indexOf('src/**/x.js') !== -1 && h.indexOf('lib/**') !== -1, h);
  }, { tags: ['unit'] });

  test('later turns parsed after a trigger contain no <strong>', function() {
    assert.deepStrictEqual(laterTurnsBold(TRIGGER_TABLE_CELL), []);
    assert.deepStrictEqual(laterTurnsBold(TRIGGER_GLOBS), []);
  }, { tags: ['unit'] });

  test('control: same-line bold still renders in paragraphs, list items and cells', function() {
    var p = fc('Run **bold** and **`npm i`** now');
    assert.strictEqual(count(/<strong>/g, p), 2, p);
    assert.strictEqual(count(/<strong>/g, p), count(/<\/strong>/g, p), p);
    assert.ok(p.indexOf('<strong><code class="inline-code">npm i</code></strong>') !== -1, p);
    var li = fc('- **Note:** item\n- plain');
    assert.ok(li.indexOf('<li><strong>Note:</strong> item</li>') !== -1, li);
    var tb = fc('| **a** | b |\n|---|---|\n| c | **d** |');
    assert.strictEqual(count(/<strong>/g, tb), 2, tb);
    assert.ok(tb.indexOf('<strong>a</strong>') !== -1 && tb.indexOf('<strong>d</strong>') !== -1, tb);
    assert.deepStrictEqual(laterTurnsBold('Run **bold** now\n\n| **a** | b |\n|---|---|\n| c | d |'), []);
  }, { tags: ['unit'] });

  test('defence in depth: output is balanced per message even if the bold regex regresses', function() {
    var NEW_RE = '/\\*\\*([^*\\n]+?)\\*\\*/g', OLD_RE = '/\\*\\*([^*]+)\\*\\*/g';
    var body = renderSrc.slice(start, end);
    assert.ok(body.indexOf(NEW_RE) !== -1, 'line-bounded bold regex present');
    var fcOld = new Function(stubs + '\n' + emojiSrc + '\n' + body.replace(NEW_RE, OLD_RE) + '\nreturn formatContent;')();
    var saved = fc;
    fc = fcOld;
    try {
      var h = fcOld(TRIGGER_TABLE_CELL);
      assert.ok(h.indexOf('<strong>') !== -1, 'old regex still produces the cross-block bold: ' + h);
      assert.deepStrictEqual(laterTurnsBold(TRIGGER_TABLE_CELL), []);
      assert.deepStrictEqual(laterTurnsBold(TRIGGER_GLOBS), []);
    } finally { fc = saved; }
  }, { tags: ['unit'] });

  test('same-line bold spanning two cells is balanced per message (no cross-turn leak)', function() {
    var h = fc('Lead **x\n\n| a **b | c** |\n|---|---|\n| d | e |');
    assert.deepStrictEqual(laterTurnsBold('Lead **x\n\n| a **b | c** |\n|---|---|\n| d | e |'), [], h);
  }, { tags: ['unit'] });
});
