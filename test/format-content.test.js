#!/usr/bin/env node
// Unit tests for the shared markdown pipeline: emoji shortcodes +
// newline/paragraph handling in formatContent (ui/250-message-render.js)
// with the map/converter from core/055-emoji-shortcodes.js.
// Run: node test/format-content.test.js
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var emojiSrc = fs.readFileSync(path.join(ROOT, 'src/js/core/055-emoji-shortcodes.js'), 'utf8');
var renderSrc = fs.readFileSync(path.join(ROOT, 'src/js/ui/250-message-render.js'), 'utf8');
// Extract ONLY formatContent — the rest of 250 touches the DOM.
var start = renderSrc.indexOf('function formatContent(content) {');
var end = renderSrc.indexOf('// Render a transient "queued" user bubble');
if (start < 0 || end < 0 || end <= start) { console.error('FAIL: could not slice formatContent'); process.exit(1); }
var fcSrc = renderSrc.slice(start, end);
var stubs = [
  "function escapeHtml(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }",
  'function highlightJS(c){ return escapeHtml(c); }',
  "function storeRawCopy(c){ return 'copyX'; }",
  "var UI_ICONS = { copy: 'C' };",
  "function renderDisplayPlaceholder(id){ return '[DSP]'; }",
  "function renderDocumentPlaceholder(id){ return '[DOC]'; }",
  'var window = { currentSearchHighlight: null };'
].join('\n');
var api = new Function(stubs + '\n' + emojiSrc + '\n' + fcSrc + '\nreturn { formatContent: formatContent, replaceEmojiShortcodes: replaceEmojiShortcodes };')();
var fc = api.formatContent;
var failures = 0;
function check(name, cond, actual) {
  if (cond) { console.log('PASS ' + name); }
  else { failures++; console.error('FAIL ' + name + '\n  actual: ' + actual); }
}
// 1. shortcode in plain text
var r1 = fc('Fixed :bug: now :rocket:');
check('shortcode in plain text', r1.indexOf('\uD83D\uDC1B') >= 0 && r1.indexOf('\uD83D\uDE80') >= 0 && r1.indexOf(':bug:') < 0, r1);
// 2. shortcode inside inline code stays literal
var r2 = fc('Use `:mag:` here and :mag: there');
check('inline code stays literal', r2.indexOf('<code class="inline-code">:mag:</code>') >= 0 && /there/.test(r2) && r2.indexOf('\uD83D\uDD0D') >= 0, r2);
// 3. single newline -> <br> within one paragraph
var r3 = fc('line one\nline two');
check('single newline -> <br>', r3.indexOf('line one<br>line two') >= 0 && (r3.match(/md-paragraph/g)||[]).length === 1, r3);
// 4. blank line -> separate paragraphs
var r4 = fc('para one\n\npara two');
check('blank line -> two paragraphs', (r4.match(/<span class="md-paragraph">/g)||[]).length === 2 && r4.indexOf('<br>') < 0, r4);
// 5. heading rendering
var r5 = fc('## :mag: Findings\n\nBody text');
check('## heading -> h3 with emoji', r5.indexOf('<h3>\uD83D\uDD0D Findings</h3>') >= 0, r5);
// 6. fenced code preserved verbatim (shortcode + newlines untouched)
var r6 = fc('Before\n\n```js\nvar a = \":bug:\";\nvar b = 2;\n```\n\nAfter :bug:');
check('code block verbatim', r6.indexOf('var a = &quot;:bug:&quot;;\nvar b = 2;') >= 0 && r6.indexOf('<br>', r6.indexOf('<code>')) === -1 || (r6.indexOf('code-block') >= 0 && r6.indexOf(':bug:') >= 0 && r6.slice(r6.lastIndexOf('</code>')).indexOf(':bug:') < 0), r6);
var codeInner = r6.slice(r6.indexOf('<code>') + 6, r6.indexOf('</code>'));
check('no <br> inside code block', codeInner.indexOf('<br>') < 0 && codeInner.indexOf(':bug:') >= 0, codeInner);
check('code block flushed as block (own line, not <br>-glued)', r6.indexOf('Before<br>') < 0, r6);
check('text after code block converts emoji', r6.slice(r6.indexOf('</code>')).indexOf('\uD83D\uDC1B') >= 0, r6);
// 7. list rendering unaffected
var r7 = fc('- item one\n- item two\n\ntail');
check('list renders as ul/li', r7.indexOf('<ul><li>item one</li><li>item two</li></ul>') >= 0, r7);
// 8. numbered list
var r8 = fc('1. first\n2. second');
check('numbered list', (r8.match(/<li>/g)||[]).length === 2, r8);
// 9. :check: convenience alias
var r9 = fc('done :check:');
check(':check: alias', r9.indexOf('\u2705') >= 0, r9);
// 10. unknown shortcode stays literal
var r10 = fc('what :notarealcode: is this');
check('unknown shortcode literal', r10.indexOf(':notarealcode:') >= 0, r10);
// 11. prototype key stays literal
var r11 = fc('evil :constructor: attempt');
check('prototype key literal', r11.indexOf(':constructor:') >= 0, r11);
// 12. shortcode inside markdown link text/url untouched
var r12 = fc('[x :bug: y](https://ex.com/:bug:/z)');
check('link href protected', r12.indexOf('https://ex.com/:bug:/z') >= 0, r12);
if (failures) { console.error(failures + ' test(s) failed'); process.exit(1); }
console.log('All tests passed.');
