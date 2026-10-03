// Documents page: workspace image previews (data: URLs from '::binary::' / SVG text)
// and uploads to read & write local folders (tools/110-smart-documents.js).
describe('documents media + upload', function() {
    async function load(g) {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var globals = Object.assign({
            chats: {}, currentChatId: 'c1', currentView: 'documents',
            escDisplay: function(s) { return String(s); }, escapeHtml: function(s) { return String(s); },
            appStorage: { getItem: function() { return null; }, setItem: function() {} }
        }, g || {});
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: globals });
        return { m: m, U: U };
    }
    var RW = { id: 'lf:lf_rw', type: 'local', folderId: 'lf_rw', label: 'Photos', access: 'readwrite', permission: 'granted' };
    var RW_PROMPT = { id: 'lf:lf_p', type: 'local', folderId: 'lf_p', label: 'Pending', access: 'readwrite', permission: 'prompt' };
    var RO = { id: 'lf:lf_ro', type: 'local', folderId: 'lf_ro', label: 'Docs', access: 'read', permission: 'granted' };
    var VIRT = { id: 'lf:virtual', type: 'virtual', folderId: 'virtual', label: 'Agent Files', access: 'readwrite', permission: 'granted' };
    var WSRC = { id: 'ws:o/r::main', type: 'ws', wk: 'o/r::main', label: 'o/r', access: 'readwrite' };
    function fakeFile(name, bytes) { return { name: name, arrayBuffer: async function() { return new Uint8Array(bytes || [1]).buffer; } }; }

    test('image detection and MIME type', async function() {
        var m = (await load()).m;
        var cases = { 'a.png': 'image/png', 'b.JPG': 'image/jpeg', 'c.jpeg': 'image/jpeg', 'd/e.gif': 'image/gif', 'f.webp': 'image/webp',
            'g.svg': 'image/svg+xml', 'h.bmp': 'image/bmp', 'i.ico': 'image/x-icon' };
        Object.keys(cases).forEach(function(n) { assert.strictEqual(m.sdocImageMime(n), cases[n], n); });
        ['a.txt', 'png', 'a.png.md', '', null, 'x.heic'].forEach(function(n) { assert.strictEqual(m.sdocImageMime(n), '', String(n)); });
    }, { tags: ['unit'], timeout: 5000 });

    test('data URL from workspace content', async function() {
        var m = (await load()).m;
        assert.strictEqual(m.sdocWsImageDataUrl('a.png', '::binary::iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
        assert.strictEqual(m.sdocWsImageDataUrl('a.jpg', '::binary::/9j/\n4AAQ'), 'data:image/jpeg;base64,/9j/4AAQ', 'whitespace stripped');
        var svg = m.sdocWsImageDataUrl('i.svg', '<svg xmlns="http://www.w3.org/2000/svg">é</svg>');
        assert.ok(/^data:image\/svg\+xml;base64,/.test(svg));
        assert.strictEqual(new TextDecoder().decode(Uint8Array.from(atob(svg.split(',')[1]), function(c) { return c.charCodeAt(0); })), '<svg xmlns="http://www.w3.org/2000/svg">é</svg>', 'UTF-8 round trip');
        assert.strictEqual(m.sdocWsImageDataUrl('a.png', 'not binary text'), null, 'raster stored as text: no preview');
        assert.strictEqual(m.sdocWsImageDataUrl('a.txt', '::binary::AAAA'), null, 'not an image');
        assert.strictEqual(m.sdocWsImageDataUrl('a.png', null), null);
        assert.strictEqual(m.sdocWsImageDataUrl('a.png', '::binary::<script>'), null, 'invalid base64 rejected');
        assert.strictEqual(m.sdocWsImageDataUrl('a.png', '::binary::AAAAAAAA', 3), null, 'over the size cap');
    }, { tags: ['unit'], timeout: 5000 });

    test('workspace image preview renders an <img>, hydrating stubs', async function() {
        var hyd = [], snacks = [], store = { 'logo.png': { stub: true, content: null }, 'x.svg': { content: '<svg onload="alert(1)"></svg>' } };
        var e = await load({
            getWorkspaceFile: async function(wk, p) { return store[p] ? Object.assign({ path: p }, store[p]) : null; },
            wsHydrate: async function(wk, paths) { hyd.push(paths[0]); store['logo.png'] = { content: '::binary::iVBORw0KGgo=' }; },
            showSnackbar: function(msg, kind) { snacks.push([kind, msg]); },
            _wsfOverlay: function(title, body) { var d = document.createElement('div'); d.innerHTML = body; document.body.appendChild(d); return d; }
        });
        var m = e.m;
        try {
            var ov = await m.sdocPreviewFile(WSRC, 'logo.png');
            assert.ok(ov, 'overlay opened: ' + JSON.stringify(snacks));
            var img = ov.querySelector('.sdoc-ws-load img.sdoc-file-preview-img');
            assert.ok(img, 'img rendered');
            assert.strictEqual(img.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
            assert.strictEqual(img.getAttribute('alt'), 'Image: logo.png');
            assert.deepStrictEqual(hyd, ['logo.png'], 'stub hydrated once');
            if (ov.remove) ov.remove();
            var ov2 = await m.sdocPreviewFile(WSRC, 'x.svg');
            assert.ok(ov2.querySelector('img.sdoc-file-preview-img[src^="data:image/svg+xml;base64,"]'), 'SVG via <img>');
            assert.strictEqual(ov2.querySelector('.sdoc-ws-load svg'), null, 'SVG never inlined');
            if (ov2.remove) ov2.remove();
        } finally { e.U.cleanupAll(); }
    }, { tags: ['unit'], timeout: 8000 });

    test('upload target: read & write only, browsed dir when selected', async function() {
        var m = (await load()).m;
        assert.deepStrictEqual(m.sdocUploadTarget(RW, 'lf:lf_rw', 'sub/dir/'), { srcId: 'lf:lf_rw', folderId: 'lf_rw', dir: 'sub/dir', needsGrant: false });
        assert.strictEqual(m.sdocUploadTarget(RW, 'all', 'sub').dir, '', 'not selected -> root');
        assert.strictEqual(m.sdocUploadTarget(RW_PROMPT, 'lf:lf_p', '').needsGrant, true);
        assert.strictEqual(m.sdocUploadTarget(VIRT, 'lf:virtual', 'a').folderId, 'virtual');
        assert.strictEqual(m.sdocUploadTarget(RO, 'lf:lf_ro', ''), null, 'read-only');
        assert.strictEqual(m.sdocUploadTarget(WSRC, WSRC.id, ''), null, 'workspace');
        assert.strictEqual(m.sdocUploadTarget(null), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('file-name conflicts', async function() {
        var m = (await load()).m;
        assert.strictEqual(m.sdocUniqueName('a.png', []), 'a.png');
        assert.strictEqual(m.sdocUniqueName('a.png', ['a.png']), 'a (1).png');
        assert.strictEqual(m.sdocUniqueName('a.png', new Set(['a.png', 'a (1).png'])), 'a (2).png');
        assert.strictEqual(m.sdocUniqueName('README', ['README']), 'README (1)');
        assert.strictEqual(m.sdocUniqueName('.env', ['.env']), '.env (1)', 'dotfile has no extension');
    }, { tags: ['unit'], timeout: 5000 });

    test('upload to a read & write folder: browsed dir, renames conflicts, re-grant, read-only refused', async function() {
        var written = [], snacks = [], grants = [];
        var e = await load({
            lfWriteFileBytes: async function(f, p, b) { written.push([f, p, b.length]); return { folder: f, path: p, size: b.length }; },
            showSnackbar: function(msg, kind) { snacks.push([kind, msg]); },
            regrantLocalFolder: async function(id) { grants.push(id); return id === 'lf_p' ? 'granted' : 'denied'; }
        });
        var m = e.m;
        try {
            m.sdocSrcState.sources = [VIRT, RW, RW_PROMPT, RO];
            m.sdocSrcState.sel = 'lf:lf_rw'; m.sdocSrcState.path = 'pics';
            m.sdocSrcState.listings['lf:lf_rw#pics'] = { entries: [{ name: 'a.png', kind: 'file' }] };
            var r = await m.sdocUploadToSource(RW, [fakeFile('a.png', [1, 2]), fakeFile('b.png')]);
            assert.strictEqual(r.uploaded, 2);
            assert.deepStrictEqual(written, [['lf_rw', 'pics/a (1).png', 2], ['lf_rw', 'pics/b.png', 1]]);
            assert.deepStrictEqual(snacks, [['success', 'Uploaded 2 files to Photos']]);
            assert.strictEqual(m.sdocSrcState.listings['lf:lf_rw#pics'], undefined, 'listing invalidated');

            written.length = 0; snacks.length = 0;
            r = await m.sdocUploadToSource(RO, [fakeFile('c.png')]);
            assert.strictEqual(r.uploaded, 0);
            assert.deepStrictEqual(written, [], 'read-only never written');
            assert.strictEqual(snacks[0][0], 'error');

            snacks.length = 0;
            m.sdocSrcState.sel = 'lf:lf_p'; m.sdocSrcState.path = '';
            r = await m.sdocUploadToSource(RW_PROMPT, [fakeFile('d.png')]);
            assert.deepStrictEqual(grants, ['lf_p'], 'permission requested');
            assert.deepStrictEqual(written, [['lf_p', 'd.png', 1]]);

            written.length = 0; snacks.length = 0;
            r = await m.sdocUploadToSource(RW_PROMPT, [fakeFile('e.png')], { grant: Promise.resolve('denied') });
            assert.deepStrictEqual(written, [], 'denied grant: nothing written');
            assert.deepStrictEqual(snacks, [['error', 'Access was not granted (denied)']]);
        } finally { e.U.cleanupAll(); }
    }, { tags: ['unit'], timeout: 8000 });
});
