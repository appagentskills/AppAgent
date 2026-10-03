// Block/inline markdown features in formatContent (ui/250-message-render.js):
// headings h2-h6, horizontal rules, strikethrough, task lists,
// blockquote <-> list nesting, images (URL allow-list), table alignment + wrap.
// Run: run_tests { pattern: 'format-content-blocks' }
'use strict';
var emojiSrc = await loadFile('src/js/core/055-emoji-shortcodes.js');
var renderSrc = await loadFile('src/js/ui/250-message-render.js');
var cssSrc = await loadFile('src/css/07-markdown.css');
var start = renderSrc.indexOf('function formatContent(content) {');
var end = renderSrc.indexOf('// Render a transient "queued" user bubble');
if (start < 0 || end < 0 || end <= start) throw new Error('format-content-blocks: could not slice formatContent');
var stubs = [
  "function escapeHtml(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); }",
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
var T = { tags: ['unit'] };
var P = function(s) { return '<span class="md-paragraph">' + s + '</span>'; };
var BOX = '<input type="checkbox" class="md-task-box" disabled>';
var BOXC = '<input type="checkbox" class="md-task-box" disabled checked>';
var WRAP = '<div class="md-table-wrap"><table class="md-table">';

describe('format-content headings', function() {
  test('# .. ###### map to h2..h6 and every level is a block (no paragraph wrap)', function() {
    assert.strictEqual(fc('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n\nbody'),
      '<h2>H1</h2><h3>H2</h3><h4>H3</h4><h5>H4</h5><h6>H5</h6><h6>H6</h6>' + P('body'));
  }, T);
  test('h5 directly followed by a list has no stray spacing', function() {
    assert.strictEqual(fc('#### Steps\n- a'), '<h5>Steps</h5><ul><li>a</li></ul>');
  }, T);
  test('7 hashes or no space is not a heading', function() {
    assert.strictEqual(fc('####### x'), P('####### x'));
    assert.strictEqual(fc('#tag'), P('#tag'));
  }, T);
  test('heading inside a blockquote', function() {
    assert.strictEqual(fc('> ## Note\n> text'), '<blockquote class="md-blockquote"><h3>Note</h3>' + P('text') + '</blockquote>');
  }, T);
});

describe('format-content horizontal rules', function() {
  test('---, ***, ___ and spaced variants become <hr class="md-hr">', function() {
    ['---', '***', '___', '- - -', '* * *', '-----'].forEach(function(r) {
      assert.strictEqual(fc('a\n\n' + r + '\n\nb'), P('a') + '<hr class="md-hr">' + P('b'), r);
    });
  }, T);
  test('--- right after a text line is an hr, not a setext heading', function() {
    assert.strictEqual(fc('Title\n---\nbody'), P('Title') + '<hr class="md-hr">' + P('body'));
  }, T);
  test('hr closes an open list', function() {
    assert.strictEqual(fc('- a\n---\n- b'), '<ul><li>a</li></ul><hr class="md-hr"><ul><li>b</li></ul>');
  }, T);
  test('negative: -- , a table separator row and --- inside a code fence stay', function() {
    assert.strictEqual(fc('--'), P('--'));
    var tbl = fc('| a | b |\n| --- | --- |\n| --- x | y |');
    assert.ok(tbl.indexOf('<hr') < 0 && tbl.indexOf('<td>--- x</td>') >= 0, tbl);
    var code = fc('```yaml\n---\nkey: v\n---\n```');
    assert.ok(code.indexOf('<hr') < 0 && code.indexOf('---\nkey: v\n---') >= 0, code);
  }, T);
});

describe('format-content strikethrough', function() {
  test('~~text~~ becomes <del>', function() {
    assert.strictEqual(fc('keep ~~gone~~ ok'), P('keep <del>gone</del> ok'));
  }, T);
  test('negative: inline code, code fence, single tildes, ~~ with inner spaces', function() {
    assert.strictEqual(fc('`~~x~~`'), P('<code class="inline-code">~~x~~</code>'));
    assert.ok(fc('```\n~~x~~\n```').indexOf('<del>') < 0);
    assert.strictEqual(fc('a ~ b ~ c'), P('a ~ b ~ c'));
    assert.strictEqual(fc('~~ x ~~'), P('~~ x ~~'));
  }, T);
  test('single ~ inside a table cell is untouched', function() {
    assert.strictEqual(fc('| a ~ b | c |'), WRAP + '<tr><td>a ~ b</td><td>c</td></tr></table></div>');
  }, T);
});

describe('format-content task lists', function() {
  test('- [ ] / - [x] render disabled checkboxes on li.md-task', function() {
    assert.strictEqual(fc('- [ ] todo\n- [x] done\n- [X] Done'),
      '<ul><li class="md-task">' + BOX + 'todo</li><li class="md-task">' + BOXC + 'done</li><li class="md-task">' + BOXC + 'Done</li></ul>');
  }, T);
  test('* / + / ordered markers and nested task items', function() {
    assert.strictEqual(fc('* [ ] a\n+ [x] b'), '<ul><li class="md-task">' + BOX + 'a</li><li class="md-task">' + BOXC + 'b</li></ul>');
    assert.strictEqual(fc('1. [x] one\n2. two'), '<ol><li class="md-task">' + BOXC + 'one</li><li>two</li></ol>');
    assert.strictEqual(fc('- parent\n  - [ ] child'), '<ul><li>parent<ul><li class="md-task">' + BOX + 'child</li></ul></li></ul>');
  }, T);
  test('negative: [ ] mid-text and [link](url) items are not tasks', function() {
    assert.ok(fc('- see [ ] here').indexOf('md-task') < 0);
    assert.ok(fc('- [x](https://e.com) link').indexOf('md-task') < 0);
  }, T);
  test('CSS hides the bullet on task items', function() {
    assert.match(cssSrc, /li\.md-task\s*\{[^}]*list-style:\s*none/);
  }, T);
});

describe('format-content blockquote / list nesting', function() {
  test('list (with sub-list) inside a blockquote', function() {
    assert.strictEqual(fc('> - a\n> - b\n>   - c'),
      '<blockquote class="md-blockquote"><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul></blockquote>');
  }, T);
  test('blockquote inside a list item', function() {
    assert.strictEqual(fc('- item\n  > quote\n  > more\n- next'),
      '<ul><li>item<blockquote class="md-blockquote">' + P('quote<br>more') + '</blockquote></li><li>next</li></ul>');
  }, T);
  test('nested blockquote', function() {
    assert.strictEqual(fc('> outer\n> > inner'),
      '<blockquote class="md-blockquote">' + P('outer') + '<blockquote class="md-blockquote">' + P('inner') + '</blockquote></blockquote>');
  }, T);
  test('hr and task list inside a blockquote', function() {
    assert.strictEqual(fc('> a\n> ---\n> - [x] t'),
      '<blockquote class="md-blockquote">' + P('a') + '<hr class="md-hr"><ul><li class="md-task">' + BOXC + 't</li></ul></blockquote>');
  }, T);
  test('deep > > > nesting is bounded (no stack blow-up, balanced tags)', function() {
    var h = fc(new Array(200).join('&gt; '.replace('&gt;', '>')) + 'x');
    var open = (h.match(/<blockquote\b/g) || []).length, close = (h.match(/<\/blockquote>/g) || []).length;
    assert.strictEqual(open, close);
    assert.ok(open <= 16 && open > 0, 'depth ' + open);
  }, T);
  test('blank lines between quote lines keep one quote; text after closes it', function() {
    assert.strictEqual(fc('> a\n\n> b\nafter'),
      '<blockquote class="md-blockquote">' + P('a') + P('b') + '</blockquote>' + P('after'));
  }, T);
  test('existing blockquote paragraphs unchanged', function() {
    assert.strictEqual(fc('> quote line\n> more\n>\n> second para\n\ntext'),
      '<blockquote class="md-blockquote">' + P('quote line<br>more') + P('second para') + '</blockquote>' + P('text'));
  }, T);
});

describe('format-content images', function() {
  test('![alt](https url) -> img.md-img with escaped attributes', function() {
    assert.strictEqual(fc('![a "q" <b>](https://e.com/i.png?x=1&y=2)'),
      P('<img class="md-img" alt="a &quot;q&quot; &lt;b&gt;" src="https://e.com/i.png?x=1&amp;y=2">'));
  }, T);
  test('data:image/ URLs are allowed', function() {
    assert.strictEqual(fc('![d](data:image/png;base64,iVBORw0K)'), P('<img class="md-img" alt="d" src="data:image/png;base64,iVBORw0K">'));
  }, T);
  test('linked image: [![i](img)](link)', function() {
    assert.strictEqual(fc('[![i](https://e.com/i.png)](https://e.com/p)'),
      P('<a href="https://e.com/p" target="_blank" rel="noopener"><img class="md-img" alt="i" src="https://e.com/i.png"></a>'));
  }, T);
  test('the bare-URL autolinker does not touch the img src', function() {
    var h = fc('![i](https://e.com/i.png)');
    assert.ok(h.indexOf('<a ') < 0, h);
  }, T);
  test('XSS: javascript:, data:text/html, vbscript: and attribute breakout are rejected', function() {
    ['![x](javascript:alert(1))', '![x](JavaScript:alert(1))', '![x](data:text/html,<script>alert(1)</script>)',
     '![x](vbscript:msgbox)', '![x" onerror="alert(1)](https://e.com/i.png)'].forEach(function(s) {
      var h = fc(s);
      assert.ok(!/<img[^>]*src="(?:javascript|data:text|vbscript)/i.test(h), s + ' -> ' + h);
      // A real injected attribute needs an unescaped quote; an escaped
      // `onerror=&quot;` inside the alt VALUE is inert text.
      assert.ok(!/<[a-z][^>]*\sonerror\s*=\s*["']/i.test(h), s + ' -> ' + h);
      assert.ok(h.indexOf('<script') < 0 && !/href="javascript/i.test(h), s + ' -> ' + h);
    });
  }, T);
  test('attribute breakout attempt stays inside an escaped alt value', function() {
    assert.strictEqual(fc('![x" onerror="alert(1)](https://e.com/i.png)'),
      P('<img class="md-img" alt="x&quot; onerror=&quot;alert(1)" src="https://e.com/i.png">'));
  }, T);
  test('image src stops at whitespace/quote-free URL; inline code in alt is not rendered as img', function() {
    assert.ok(fc('![`c`](https://e.com/i.png)').indexOf('<img') < 0);
  }, T);
  test('image syntax inside inline code stays literal', function() {
    assert.strictEqual(fc('`![a](https://e.com/i.png)`'), P('<code class="inline-code">![a](https://e.com/i.png)</code>'));
  }, T);
  test('CSS: md-img max-width 100% and rounded', function() {
    assert.match(cssSrc, /\.md-img\s*\{[^}]*max-width:\s*100%[^}]*\}/);
    assert.match(cssSrc, /\.md-img\s*\{[^}]*border-radius/);
  }, T);
});

describe('format-content table alignment + wrap', function() {
  test(':--- / :---: / ---: set per-column alignment classes on th and td', function() {
    assert.strictEqual(fc('| L | C | R | N |\n|:---|:---:|---:|---|\n| 1 | 2 | 3 | 4 |'),
      WRAP + '<thead><tr><th class="md-align-left">L</th><th class="md-align-center">C</th><th class="md-align-right">R</th><th>N</th></tr></thead>' +
      '<tbody><tr><td class="md-align-left">1</td><td class="md-align-center">2</td><td class="md-align-right">3</td><td>4</td></tr></tbody></table></div>');
  }, T);
  test('table is wrapped in a horizontally scrolling .md-table-wrap', function() {
    assert.strictEqual(fc('| a | b |'), WRAP + '<tr><td>a</td><td>b</td></tr></table></div>');
    assert.match(cssSrc, /\.md-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    assert.match(cssSrc, /\.md-table\s+\.md-align-center\s*\{[^}]*text-align:\s*center/);
  }, T);
  test('text, list and table around each other stay balanced', function() {
    assert.strictEqual(fc('intro\n| a |\n- x'), P('intro') + WRAP + '<tr><td>a</td></tr></table></div><ul><li>x</li></ul>');
  }, T);
});
