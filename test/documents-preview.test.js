// Documents page file preview (tools/110-smart-documents.js sdocPreviewFile):
// extension -> viewer kind, video/audio/PDF through blob: URLs inside the
// shared _wsfOverlay (ui/115-workspace-files-sidebar.js), the size guard,
// blob: URL revocation + focus return on close.

describe('documents page file preview', function() {
    async function load(extra) {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var made = [], revoked = [], snacks = [];
        var urlStub = {
            createObjectURL: function(b) { var u = 'blob:test/' + made.length; made.push({ url: u, blob: b }); return u; },
            revokeObjectURL: function(u) { revoked.push(u); }
        };
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/115-workspace-files-sidebar.js', 'src/js/tools/110-smart-documents.js'], { globals: Object.assign({
            chats: {}, currentChatId: 'c1', LOCAL_FOLDER_VIRTUAL_ID: 'virtual', URL: urlStub, Blob: Blob,
            escapeHtml: function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
            escDisplay: function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
            showSnackbar: function(msg, kind) { snacks.push([kind, msg]); },
            LF_LIMITS: { maxReadBytes: 25 * 1024 * 1024 },
            lfBytesToBase64: function() { return 'AAAA'; },
            lfIsBinary: function(name, bytes) { return bytes[0] === 0; }
        }, extra || {}) });
        return { m: m, U: U, made: made, revoked: revoked, snacks: snacks };
    }
    function fakeFile(name, size, type) { return { name: name, size: size, type: type || '', slice: function() { return { arrayBuffer: async function() { return new ArrayBuffer(0); } }; } }; }
    function lfStub(file, mime) {
        return async function(folder, path) { return { file: file, name: path.split('/').pop(), path: path, mime: mime || file.type || 'application/octet-stream', size: file.size, folder: folder }; };
    }
    var SRC = { id: 'lf:f1', type: 'lf', folderId: 'f1', label: 'Media' };
    function closeTop() { var all = document.querySelectorAll('.wsf-overlay'); var o = all[all.length - 1]; o._wsfClose(); }

    test('sdocPreviewKind maps each extension to its viewer and sdocFileIcon follows', async function() {
        var e = await load();
        var m = e.m;
        var cases = {
            'a.mp4': 'video', 'a.webm': 'video', 'a.ogv': 'video', 'a.MOV': 'video', 'a.m4v': 'video',
            'a.mp3': 'audio', 'a.wav': 'audio', 'a.oga': 'audio', 'a.ogg': 'audio', 'a.m4a': 'audio', 'a.flac': 'audio', 'a.aac': 'audio',
            'a.pdf': 'pdf', 'a.png': 'image', 'a.JPG': 'image', 'a.svg': 'image', 'a.txt': '', 'a.js': '', 'a.bin': ''
        };
        Object.keys(cases).forEach(function(n) { assert.strictEqual(m.sdocPreviewKind(n), cases[n], n); });
        assert.strictEqual(m.sdocPreviewKind('clip.ogg', 'video/ogg'), 'video', '.ogg with a video MIME');
        assert.strictEqual(m.sdocPreviewKind('noext', 'video/mp4'), 'video', 'MIME fallback');
        assert.strictEqual(m.sdocPreviewKind('noext', 'application/pdf'), 'pdf');
        assert.strictEqual(m.sdocFileIcon({ kind: 'file', name: 'a.mp4' }), m.UI_ICONS.video);
        assert.strictEqual(m.sdocFileIcon({ kind: 'file', name: 'a.flac' }), m.UI_ICONS.audio);
        assert.strictEqual(m.sdocFileIcon({ kind: 'file', name: 'a.pdf' }), m.UI_ICONS.pdf);
        assert.strictEqual(m.sdocFileIcon({ kind: 'file', name: 'a.png' }), m.UI_ICONS.image);
        assert.ok(m.UI_ICONS.video && m.UI_ICONS.audio && m.UI_ICONS.pdf);
    }, { tags: ['unit'] });

    test('video / audio / PDF open in the overlay via blob: URLs, revoked on close, focus returns to the row', async function() {
        var files = { 'v.mp4': fakeFile('v.mp4', 5000, 'video/mp4'), 's.mp3': fakeFile('s.mp3', 300, 'audio/mpeg'), 'd.pdf': fakeFile('d.pdf', 100, '') };
        var e = await load({ lfGetFile: async function(folder, path) { return lfStub(files[path])(folder, path); },
            lfReadFileBytes: async function() { throw new Error('media must not be read into memory'); } });
        var m = e.m;
        var row = document.createElement('div');
        row.className = 'sdoc-file-item'; row.tabIndex = 0;
        row.setAttribute('data-src-id', 'lf:f1'); row.setAttribute('data-path', 'v.mp4');
        document.body.appendChild(row);
        // The test frame may be hidden (focus() is then a no-op): spy on it instead.
        var focused = [], origFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function() { focused.push(this); };
        try {
            var ov = await m.sdocPreviewFile(SRC, 'v.mp4');
            assert.ok(ov, 'overlay opened: ' + JSON.stringify(e.snacks));
            var v = ov.querySelector('video.sdoc-file-preview-media');
            assert.ok(v && v.hasAttribute('controls'), 'native video controls');
            assert.strictEqual(v.getAttribute('src'), 'blob:test/0');
            assert.ok(/v\.mp4/.test(v.getAttribute('aria-label')) && v.getAttribute('title'), 'accessible title');
            assert.strictEqual(e.made[0].blob, files['v.mp4'], 'File handed straight to createObjectURL');
            assert.strictEqual(ov.querySelector('.wsf-modal').getAttribute('role'), 'dialog');
            assert.strictEqual(focused.length, 1);
            assert.ok(focused[0] === ov.querySelector('.wsf-modal-close'), 'focus moved into the overlay');
            assert.deepStrictEqual(e.revoked, []);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            assert.ok(!document.body.contains(ov), 'Escape closes');
            assert.deepStrictEqual(e.revoked, ['blob:test/0'], 'revoked on close');
            assert.strictEqual(focused[1], row, 'focus returned to the row');

            ov = await m.sdocPreviewFile(SRC, 's.mp3');
            assert.ok(ov.querySelector('audio.sdoc-file-preview-audio[controls]'));
            closeTop();
            assert.deepStrictEqual(e.revoked, ['blob:test/0', 'blob:test/1']);

            ov = await m.sdocPreviewFile(SRC, 'd.pdf');
            var fr = ov.querySelector('iframe.sdoc-file-preview-pdf');
            assert.ok(fr && fr.getAttribute('src') === 'blob:test/2' && /d\.pdf/.test(fr.getAttribute('title')));
            assert.strictEqual(e.made[2].blob.type, 'application/pdf', 'untyped PDF re-wrapped as application/pdf');
            closeTop();
            assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 0);
            assert.strictEqual(e.revoked.length, 3);
        } finally { HTMLElement.prototype.focus = origFocus; row.remove(); e.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('size guard: over 200MB and unknown binaries fall back to "No preview" + Download', async function() {
        var reads = [];
        var files = { 'huge.mp4': fakeFile('huge.mp4', 300 * 1024 * 1024, 'video/mp4'), 'big.txt': fakeFile('big.txt', 30 * 1024 * 1024, 'text/plain'), 'x.bin': fakeFile('x.bin', 10, '') };
        var e = await load({ lfGetFile: async function(folder, path) { return lfStub(files[path])(folder, path); },
            lfReadFileBytes: async function(folder, path) { reads.push(path); return { bytes: new Uint8Array([0, 1, 2]), name: path, mime: 'application/octet-stream', size: 3 }; } });
        var m = e.m;
        try {
            var ov = await m.sdocPreviewFile(SRC, 'huge.mp4');
            assert.strictEqual(ov.querySelector('video'), null, 'no inline player past the guard');
            var dl = ov.querySelector('.sdoc-file-nopreview a[download]');
            assert.ok(dl && dl.getAttribute('href') === 'blob:test/0' && dl.getAttribute('download') === 'huge.mp4', 'Download link');
            closeTop();
            ov = await m.sdocPreviewFile(SRC, 'big.txt');
            assert.ok(ov.querySelector('.sdoc-file-nopreview a[download]'), 'over the read cap: Download');
            closeTop();
            assert.deepStrictEqual(reads, [], 'nothing over the caps was read into memory');
            ov = await m.sdocPreviewFile(SRC, 'x.bin');
            assert.ok(ov.querySelector('.sdoc-file-nopreview a[download]') && /No preview available/.test(ov.textContent));
            closeTop();
            assert.deepStrictEqual(e.revoked, ['blob:test/0', 'blob:test/1', 'blob:test/2']);
            assert.deepStrictEqual(e.snacks, []);
        } finally { e.U.cleanupAll(); }
    }, { tags: ['unit'] });
});
