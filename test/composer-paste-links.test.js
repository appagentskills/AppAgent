// Rich-text paste keeps hyperlinks — ui/246-composer.js composerHtmlToTextWithLinks
// + app/050 handlePasteForImages wiring + 250 mailto markdown links.
describe('composer rich-text paste keeps links', function() {
    async function composer(globals) {
        return loadModules(['src/js/ui/246-composer.js'], { lenient: true, globals: Object.assign({ window: fakeWindow(), chrome: fakeChrome(), DOMParser: DOMParser, URL: URL }, globals || {}) });
    }

    test('anchors become [text](url); blocks and <br> become newlines', async function() {
        var m = await composer();
        var html = '<meta charset="utf-8"><!--StartFragment--><p>See <a href="https://example.com/docs">the docs</a> now.</p>'
            + '<div>Line one<br>Line <b>two</b></div><ul><li>a <a href="https://x.io/p?q=1&amp;r=2">x</a></li><li>b</li></ul><!--EndFragment-->';
        var out = m.composerHtmlToTextWithLinks(html, 'See the docs now.\nLine one\nLine two\na x\nb');
        assert.strictEqual(out, 'See [the docs](https://example.com/docs) now.\nLine one\nLine two\na [x](https://x.io/p?q=1&r=2)\nb');
    }, { tags: ['unit'], timeout: 5000 });

    test('link text equal to url / empty -> bare url; mailto kept', async function() {
        var m = await composer();
        var out = m.composerHtmlToTextWithLinks('<span>Go <a href="https://a.com/">https://a.com</a> or <a href="https://b.com/x"></a> mail <a href="mailto:me@x.com">me@x.com</a></span>', 'Go https://a.com or  mail me@x.com');
        assert.strictEqual(out, 'Go https://a.com/ or https://b.com/x mail [me@x.com](mailto:me@x.com)');
    }, { tags: ['unit'], timeout: 5000 });

    test('unsafe / relative hrefs are dropped but text kept; base resolves relative', async function() {
        var m = await composer();
        assert.strictEqual(m.composerHtmlToTextWithLinks('<a href="javascript:alert(1)">click</a> and <a href="/rel">rel</a> and <a href="#top">top</a>', 'click and rel and top'), null);
        var out = m.composerHtmlToTextWithLinks('<base href="https://site.org/a/"><p><a href="b/c">rel</a> and <a href="javascript:x()">bad</a> <a href="//cdn.net/z">cdn</a></p>', 'rel and bad cdn');
        assert.strictEqual(out, '[rel](https://site.org/a/b/c) and bad [cdn](https://cdn.net/z)');
        assert.strictEqual(m.composerSafeLinkUrl('data:text/html,x'), null);
        assert.strictEqual(m.composerSafeLinkUrl(' HTTPS://ok.com '), 'HTTPS://ok.com');
    }, { tags: ['unit'], timeout: 5000 });

    test('no links / urls already in plain text -> null (native paste untouched)', async function() {
        var m = await composer();
        assert.strictEqual(m.composerHtmlToTextWithLinks('<p>just <b>bold</b></p>', 'just bold'), null);
        assert.strictEqual(m.composerHtmlToTextWithLinks('<a href="https://a.com/x">https://a.com/x</a>', 'https://a.com/x'), null);
        assert.strictEqual(m.composerHtmlToTextWithLinks('', 'x'), null);
        assert.strictEqual(m.composerHtmlToTextWithLinks(null, 'x'), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('markdown-breaking chars are encoded; no raw HTML leaks; script/style skipped', async function() {
        var m = await composer();
        var out = m.composerHtmlToTextWithLinks('<style>p{}</style><script>evil()</script><p>[1] <a href="https://w.org/A_(b) c">ref [1]</a> &lt;tag&gt;</p>', '[1] ref [1] <tag>');
        assert.strictEqual(out, '[1] [ref (1)](https://w.org/A_%28b%29%20c) <tag>');
    }, { tags: ['unit'], timeout: 5000 });

    test('table cells are tab-separated', async function() {
        var m = await composer();
        var out = m.composerHtmlToTextWithLinks('<table><tr><td>A</td><td><a href="https://a.b/">B</a></td></tr><tr><td>C</td><td>D</td></tr></table>', 'A\tB\nC\tD');
        assert.strictEqual(out, 'A\t[B](https://a.b/)\nC\tD');
    }, { tags: ['unit'], timeout: 5000 });

    test('composerPasteText falls back to splice + input event without execCommand', async function() {
        var events = [];
        var el = { id: 'message-input', value: 'hello world', selectionStart: 6, selectionEnd: 11,
            setSelectionRange: function(a, b) { el.selectionStart = a; el.selectionEnd = b; },
            dispatchEvent: function(ev) { events.push(ev.type); } };
        var m = await composer({ document: { activeElement: null }, Event: function(t) { this.type = t; } });
        assert.strictEqual(m.composerPasteText(el, '[x](https://x.y)'), true);
        assert.strictEqual(el.value, 'hello [x](https://x.y)');
        assert.strictEqual(el.selectionStart, 22);
        assert.deepStrictEqual(events, ['input']);
    }, { tags: ['unit'], timeout: 5000 });

    test('paste handler + renderer wiring', async function() {
        var src = await loadFile('src/js/app/050-image-attachments.js');
        assert.ok(src.indexOf("composerHtmlToTextWithLinks(e.clipboardData.getData('text/html'), pasted)") > 0);
        assert.ok(src.indexOf('composerPasteText(ta, linked)') > 0);
        var render = await loadFile('src/js/ui/250-message-render.js');
        var m = /html = html\.replace\((\/\\\[\(\[\^\\\]\]\+\)\\\]\\\(.*?\/g), '<a href="\$2"/.exec(render);
        assert.ok(m, 'markdown link regex found');
        var re = eval(m[1]);
        assert.strictEqual('[me](mailto:me@x.com)'.replace(re, '<a href="$2">$1</a>'), '<a href="mailto:me@x.com">me</a>');
        assert.strictEqual('[x](javascript:alert(1))'.replace(re, 'LINK'), '[x](javascript:alert(1))');
    }, { tags: ['unit'], timeout: 5000 });
});
