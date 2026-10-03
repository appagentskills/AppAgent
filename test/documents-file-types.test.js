// Documents page file rows (tools/110-smart-documents.js): file-type icon/color map,
// folder vs file styling hooks, and the last-modified stamp next to the size.
describe('documents file types + mtime', function() {
    async function load() {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        return U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: {
            chats: {}, currentChatId: 'c1', currentView: 'documents',
            escDisplay: function(s) { return String(s); }, escapeHtml: function(s) { return String(s); },
            appStorage: { getItem: function() { return null; }, setItem: function() {} }
        } });
    }

    test('extension map follows editor conventions', async function() {
        var m = await load();
        function ti(n) { return m.sdocFileTypeInfo(n); }
        assert.strictEqual(ti('a.js').label, 'JS');
        assert.strictEqual(ti('a.MJS').color, ti('a.js').color, 'case-insensitive, mjs = js');
        assert.strictEqual(ti('a.ts').color, '#3178c6');
        assert.strictEqual(ti('index.html').color, '#e34c26');
        assert.strictEqual(ti('a.py').color, '#3776ab');
        assert.strictEqual(ti('a.pdf').kind, 'pdf');
        assert.strictEqual(ti('a.png').kind, 'image');
        assert.strictEqual(ti('a.tar.gz').kind, 'archive');
        assert.strictEqual(ti('.env').label, 'ENV', 'dotfile extension');
        assert.strictEqual(ti('a.mp4').kind, 'video', 'media via preview kind');
        assert.notStrictEqual(ti('a.js').color, ti('a.json').color);
        assert.notStrictEqual(ti('a.css').color, ti('a.scss').color);
        assert.strictEqual(ti('Makefile').kind, 'file', 'default');
        assert.strictEqual(ti('Makefile').label, '');
        var f = m.sdocFileTypeInfo('src', 'directory');
        assert.strictEqual(f.kind, 'folder');
        assert.notStrictEqual(f.color, ti('Makefile').color, 'folders and files differ');
    }, { tags: ['unit'], timeout: 5000 });

    test('icons: badge svg for code, shared icons for folder/media', async function() {
        var m = await load();
        var js = m.sdocFileIcon({ kind: 'file', name: 'a.js' });
        assert.ok(/class="sdoc-ft-svg"/.test(js) && />JS</.test(js) && /color="#f1c40f"/.test(js), js);
        assert.notStrictEqual(m.sdocFileIcon({ kind: 'file', name: 'a.py' }), js, 'types differ');
        assert.strictEqual(m.sdocFileIcon({ kind: 'directory', name: 'a.js' }), m.UI_ICONS.folder);
        assert.strictEqual(m.sdocFileIcon({ kind: 'file', name: 'a.pdf' }), m.UI_ICONS.pdf);
    }, { tags: ['unit'], timeout: 5000 });

    test('row markup: folder class, type class, mtime next to size', async function() {
        var m = await load();
        var src = { id: 'lf:1', type: 'local', label: 'Disk', access: 'read' };
        var ts = Date.now() - 300000;
        var html = m.buildDocumentsFileItem({ src: src, entry: { kind: 'file', name: 'a.ts', path: 'a.ts', size: 2048, lastModified: ts } }, 0);
        assert.ok(/sdoc-ft-code/.test(html), 'type class');
        assert.ok(!/is-folder/.test(html));
        assert.ok(/<span class="sdoc-lib-stat sdoc-file-mtime" title="[^"]+">[^<]+<\/span>/.test(html), html);
        assert.ok(html.indexOf(m.sdocTimeAgo(ts)) > 0, 'relative text from sdocTimeAgo');
        var ws = m.buildDocumentsFileItem({ src: { id: 'ws:1', type: 'ws', label: 'R', branch: 'main' }, entry: { kind: 'file', name: 'b.md', path: 'b.md', size: 1, mtime: new Date(ts).toISOString() } }, 1);
        assert.ok(/sdoc-file-mtime/.test(ws), 'ISO stamp from workspace rows');
        var none = m.buildDocumentsFileItem({ src: src, entry: { kind: 'file', name: 'c.txt', path: 'c.txt', size: 1 } }, 2);
        assert.ok(!/sdoc-file-mtime/.test(none), 'omitted when unknown');
        var dir = m.buildDocumentsFileItem({ src: src, entry: { kind: 'directory', name: 'src', path: 'src', lastModified: ts } }, 3);
        assert.ok(/is-folder/.test(dir) && /sdoc-ft-folder/.test(dir) && !/sdoc-file-mtime/.test(dir));
        assert.strictEqual(m.sdocEntryMtime({ mtime: 'garbage' }), null);
    }, { tags: ['unit'], timeout: 5000 });
});
