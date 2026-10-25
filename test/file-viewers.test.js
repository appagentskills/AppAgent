// Documents-page smart viewers (tools/112-file-viewers.js): kind detection,
// JSON/XML parse fallback, size caps, markdown sanitization, handlers, hook.
describe('file viewers', function() {
    var calls;
    async function load(extra) {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        calls = { overlay: [], load: [], snack: [] };
        var m = await U.loadUi(['src/js/tools/112-file-viewers.js'], { globals: Object.assign({
            highlightJS: function(s) { return '<span class="sh-hl">' + String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>'; },
            highlightXmlLine: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); },
            formatContent: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/^# (.*)$/m, '<h1>$1</h1>'); },
            storeRawCopy: function(c) { return 'rc-test'; },
            showSnackbar: function(msg, type) { calls.snack.push([msg, type]); },
            _sdocOverlay: function(title, body) { calls.overlay.push(title); var d = document.createElement('div'); d.innerHTML = body; return d; },
            _sdocWsLoadInto: async function(host) { calls.load.push(host); host.innerHTML = '<pre class="wsf-code">{"a":1}</pre>'; return true; }
        }, extra || {}) });
        return { m: m, U: U };
    }
    function dom(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

    test('kind detection: extension first, then MIME', async function() {
        var m = (await load()).m;
        assert.strictEqual(m.fvKind('a/b.json'), 'json');
        assert.strictEqual(m.fvKind('x.TSX'), 'js');
        assert.strictEqual(m.fvKind('feed.rss'), 'xml');
        assert.strictEqual(m.fvKind('index.htm'), 'html');
        assert.strictEqual(m.fvKind('README.md'), 'md');
        assert.strictEqual(m.fvKind('notes.txt'), '');
        assert.strictEqual(m.fvKind('.json'), '', 'dotfile has no extension');
        assert.strictEqual(m.fvKind('data.bin', 'application/vnd.api+json; charset=utf-8'), 'json');
        assert.strictEqual(m.fvKind('blob', 'text/javascript'), 'js');
        assert.strictEqual(m.fvKind('blob', 'image/svg+xml'), 'xml');
        assert.strictEqual(m.fvKind('blob', 'text/markdown'), 'md');
        assert.strictEqual(m.fvKind('x.md', 'application/json'), 'md', 'extension wins');
    }, { tags: ['unit'], timeout: 8000 });

    test('JSON tree / pretty, parse-error fallback to Raw', async function() {
        var m = (await load()).m;
        var w = dom(m.fvViewerHtml('a.json', '', '{"k":[1,true,null,"<s>"]}'));
        assert.strictEqual(w.getAttribute('data-view'), 'tree');
        assert.deepStrictEqual(Array.prototype.map.call(w.querySelectorAll('.fv-tab'), function(b) { return b.getAttribute('data-fv-view'); }), ['tree', 'pretty', 'raw']);
        assert.ok(w.querySelector('.fv-pane[data-fv-pane="tree"] details.fv-node[open]'));
        assert.ok(w.querySelector('.json-str').textContent.indexOf('<s>') !== -1 && !w.querySelector('s'), 'strings escaped');
        assert.ok(w.querySelector('[data-fv-pane="pretty"] .json-key'));
        var bad = dom(m.fvViewerHtml('a.json', '', '{bad'));
        assert.deepStrictEqual(Array.prototype.map.call(bad.querySelectorAll('.fv-pane'), function(p) { return p.getAttribute('data-fv-pane'); }), ['raw']);
        assert.match(bad.querySelector('.fv-notice').textContent, /JSON/);
        assert.strictEqual(bad.querySelector('.fv-src').textContent, '{bad');
    }, { tags: ['unit'], timeout: 8000 });

    test('XML tree / pretty, parsererror fallback', async function() {
        var m = (await load()).m;
        var w = dom(m.fvViewerHtml('a.xml', '', '<?xml version="1.0"?><r a="1"><c>t</c><d/><!-- n --></r>'));
        assert.strictEqual(w.getAttribute('data-view'), 'tree');
        assert.ok(w.querySelector('[data-fv-pane="tree"] .xml-tag'));
        var pretty = w.querySelector('[data-fv-pane="pretty"] .fv-code-src').textContent;
        assert.ok(pretty.indexOf('<?xml version="1.0"?>') === 0 && pretty.indexOf('  <c>t</c>') !== -1 && pretty.indexOf('  <d/>') !== -1, pretty);
        var bad = dom(m.fvViewerHtml('a.xml', '', '<r><unclosed></r>'));
        assert.strictEqual(bad.querySelectorAll('.fv-pane').length, 1);
        assert.match(bad.querySelector('.fv-notice').textContent, /XML/);
    }, { tags: ['unit'], timeout: 8000 });

    test('JS / HTML code views with line numbers; unknown kind -> no viewer', async function() {
        var m = (await load()).m;
        var js = dom(m.fvViewerHtml('a.js', '', 'var a;\nvar b;\n'));
        assert.strictEqual(js.getAttribute('data-view'), 'code');
        assert.strictEqual(js.querySelector('.fv-gutter').textContent, '1\n2\n3');
        assert.ok(js.querySelector('.sh-hl'));
        var h = dom(m.fvViewerHtml('a.html', '', '<b onclick="x()">hi</b>'));
        assert.ok(!h.querySelector('b'), 'html source is escaped, not rendered');
        assert.strictEqual(m.fvViewerHtml('a.txt', '', 'x'), '');
    }, { tags: ['unit'], timeout: 8000 });

    test('size limits: smart off > 1 MB, raw cut at 2 MB, tree cap 5000 nodes, truncated notice', async function() {
        var m = (await load()).m;
        var big = '[' + new Array(600000).join('1,') + '1]';
        assert.ok(big.length > m.FV_SMART_MAX);
        var w = dom(m.fvViewerHtml('a.json', '', big));
        assert.strictEqual(w.querySelectorAll('.fv-pane').length, 1, 'raw only');
        var huge = new Array(m.FV_RAW_MAX + 10).join('x');
        var h = dom(m.fvViewerHtml('a.js', '', huge));
        assert.strictEqual(h.querySelector('.fv-src').textContent.length, m.FV_RAW_MAX);
        assert.strictEqual(h.querySelectorAll('.fv-notice').length, 2);
        var arr = []; for (var i = 0; i < 6000; i++) arr.push(i);
        var tw = dom(m.fvViewerHtml('a.json', '', JSON.stringify(arr)));
        assert.strictEqual(tw.querySelectorAll('[data-fv-pane="tree"] .fv-leaf:not(.fv-close)').length, m.FV_TREE_MAX_NODES - 1);
        assert.match(tw.querySelector('.fv-notice').textContent, /5000/);
        var tr = dom(m.fvViewerHtml('a.md', '', 'x', { truncated: true }));
        assert.ok(tr.querySelector('.fv-notice'));
    }, { tags: ['unit'], timeout: 15000 });

    test('markdown: rendered + sanitized, placeholders neutralised', async function() {
        var m = (await load()).m;
        var w = dom(m.fvViewerHtml('a.md', '', '# Title\n<script>alert(1)</script><img src=x onerror="alert(1)">\n<!--document:doc_x-->'));
        assert.strictEqual(w.getAttribute('data-view'), 'rendered');
        var r = w.querySelector('[data-fv-pane="rendered"]');
        assert.strictEqual(r.querySelector('h1').textContent, 'Title');
        assert.ok(!r.querySelector('script') && !r.querySelector('img'), 'raw html stays text');
        assert.ok(r.textContent.indexOf('document:doc_x') !== -1);
        assert.strictEqual(m.fvNeutralizeMd('<!--document:a-->').indexOf('<!--document:'), -1);
        var s = m.fvSanitizeHtml('<p onclick="evil()">a</p><script>x</script><a href="javascript:alert(1)">l</a><img src="data:image/png;base64,AA" onerror="x()"><button onclick="copyCodeBlock(this, event)">c</button><iframe srcdoc="x"></iframe>');
        var d = document.createElement('div'); d.innerHTML = s;
        assert.ok(!d.querySelector('script') && !d.querySelector('iframe'));
        assert.ok(!d.querySelector('[onclick="evil()"]') && !d.querySelector('[onerror]') && !d.querySelector('a[href]'));
        assert.ok(d.querySelector('img[src^="data:image/"]'), 'data:image allowed');
        assert.ok(/copyCodeBlock/.test(s), 'formatContent copy handler kept');
    }, { tags: ['unit'], timeout: 8000 });

    test('handlers: view switch, arrow keys, expand/collapse, copy', async function() {
        var x = await load(), m = x.m, U = x.U;
        var mount = await U.mountDom({ html: m.fvViewerHtml('a.json', '', '{"a":{"b":{"c":{"d":1}}}}') });
        try {
            var w = mount.$('.fv-wrap'), tabs = mount.$$('.fv-tab');
            assert.strictEqual(m.fvSetView(tabs[2], 'raw'), true);
            assert.strictEqual(w.getAttribute('data-view'), 'raw');
            assert.strictEqual(mount.$('[data-fv-pane="tree"]').hidden, true);
            assert.strictEqual(tabs[2].getAttribute('aria-selected'), 'true');
            var info = U.fireInline(tabs[2], 'keydown', m, { key: 'ArrowRight' });
            assert.ok(info.prevented && info.stopped);
            assert.strictEqual(w.getAttribute('data-view'), 'tree', 'wraps around');
            var btn = mount.$('.fv-tree-btn');
            assert.strictEqual(m.fvTreeAll(btn, true), 4, 'root, a, b, c');
            assert.strictEqual(mount.$$('details.fv-node:not([open])').length, 0);
            m.fvTreeAll(btn, false);
            assert.strictEqual(mount.$$('details.fv-node[open]').length, 0);
            assert.strictEqual(await m.fvCopy(mount.$('.fv-copy')), true);
            assert.strictEqual(m.__scope.navigator.clipboard.writes[0], '{"a":{"b":{"c":{"d":1}}}}', 'falls back to .fv-src text');
            assert.strictEqual(calls.snack[0][1], 'success');
        } finally { mount.cleanup(); }
    }, { tags: ['unit'], timeout: 8000 });

    test('hook: overlay and lazy load upgrade plain pre, diffs untouched, no double wrap', async function() {
        var m = (await load()).m;
        assert.ok(m.__scope._sdocOverlay._fv && m.__scope._sdocWsLoadInto._fv, 'both wrapped at load');
        assert.strictEqual(m.fvInstallDocPreviewHooks(), 0, 'idempotent');
        var ov = m.__scope._sdocOverlay('p/a.json', '<pre class="wsf-code">{"x":1}</pre>');
        assert.ok(ov.querySelector('.fv-wrap[data-fv-kind="json"]') && !ov.querySelector('pre.wsf-code:not(.fv-src)'));
        var diff = m.__scope._sdocOverlay('p/a.json', '<div class="sdoc-diff-wrap"><pre class="wsf-code">{}</pre></div>');
        assert.ok(!diff.querySelector('.fv-wrap'));
        var txt = m.__scope._sdocOverlay('p/a.txt', '<pre class="wsf-code">x</pre>');
        assert.ok(!txt.querySelector('.fv-wrap') && txt.querySelector('pre.wsf-code'));
        var host = document.createElement('div'); host.setAttribute('data-path', 'q/b.json');
        assert.strictEqual(await m.__scope._sdocWsLoadInto(host), true);
        assert.ok(host.querySelector('.fv-wrap[data-fv-kind="json"]'));
        assert.strictEqual(calls.overlay.length, 3);
    }, { tags: ['unit'], timeout: 8000 });
});
