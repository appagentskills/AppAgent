// Documents page folder view: image thumbnails (sdocThumbEligible / sdocThumbsAttach /
// sdocThumbLoad) and prev/next navigation in the media viewer (sdocMediaNavList /
// sdocMediaNavStep / sdocAttachMediaNav), tools/110-smart-documents.js.

describe('documents page thumbnails + media viewer navigation', function() {
    async function load(extra) {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var made = [], revoked = [];
        var urlStub = {
            createObjectURL: function(b) { var u = 'blob:test/' + made.length; made.push({ url: u, blob: b }); return u; },
            revokeObjectURL: function(u) { revoked.push(u); }
        };
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/115-workspace-files-sidebar.js', 'src/js/tools/110-smart-documents.js'], { globals: Object.assign({
            chats: {}, currentChatId: 'c1', LOCAL_FOLDER_VIRTUAL_ID: 'virtual', URL: urlStub, Blob: Blob,
            escapeHtml: function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
            escDisplay: function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
            showSnackbar: function() {},
            LF_LIMITS: { maxReadBytes: 25 * 1024 * 1024 }
        }, extra || {}) });
        return { m: m, made: made, revoked: revoked };
    }
    var SRC = { id: 'lf:f1', type: 'local', folderId: 'f1', label: 'Media', permission: 'granted', access: 'read' };
    function fe(name, size) { return { name: name, path: name, kind: 'file', size: size == null ? 100 : size }; }
    function row(name, size) { return { src: SRC, entry: fe(name, size) }; }
    function fakeFile(name, size, type) { return { name: name, size: size, type: type || '', slice: function() { return { arrayBuffer: async function() { return new ArrayBuffer(0); } }; } }; }
    function tick() { return new Promise(function(r) { setTimeout(r, 0); }); }
    function closeAll() { document.querySelectorAll('.wsf-overlay').forEach(function(o) { o._wsfClose ? o._wsfClose() : o.remove(); }); }

    test('image rows get a thumbnail host; other rows keep the plain icon', async function() {
        var m = (await load()).m;
        ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg', 'g.bmp', 'h.ico', 'i.avif'].forEach(function(n) {
            assert.ok(m.sdocThumbEligible(fe(n)), n + ' eligible');
        });
        assert.ok(!m.sdocThumbEligible(fe('a.txt')), 'text not eligible');
        assert.ok(!m.sdocThumbEligible(fe('a.mp4')), 'video not eligible');
        assert.ok(!m.sdocThumbEligible(fe('big.png', 16 * 1024 * 1024)), 'over 15 MB keeps the icon');
        assert.ok(!m.sdocThumbEligible({ name: 'pics.png', path: 'pics.png', kind: 'directory' }), 'folder not eligible');
        assert.ok(!m.sdocThumbEligible({ name: 'a.png', path: 'a.png', kind: 'file', pr: 1 }), 'PR entry not eligible');
        var img = m.buildDocumentsFileItem(row('a.png'), 3), txt = m.buildDocumentsFileItem(row('a.txt'), 4);
        assert.ok(/class="sdoc-lib-icon sdoc-file-icon sdoc-ft-image" data-thumb="1"/.test(img), 'thumb host on image row');
        assert.ok(/data-row-idx="3"/.test(img), 'row index for on-screen nav order');
        assert.ok(!/data-thumb/.test(txt), 'no thumb host on text row');
        assert.ok(txt.indexOf(m.sdocFileIcon(fe('a.txt'))) !== -1, 'text row keeps its type icon');
    }, { tags: ['unit'] });

    test('thumbnails lazy-load via IntersectionObserver as blob: URLs and are revoked on the next render', async function() {
        var observed = [], cb = null;
        function IO(fn) { cb = fn; this.observe = function(el) { observed.push(el); }; this.unobserve = function() {}; this.disconnect = function() {}; }
        var e = await load({ IntersectionObserver: IO, lfGetFile: async function(folder, path) { var f = fakeFile(path, 500, path === 'x.svg' ? '' : 'image/png'); return { file: f, name: path, path: path, mime: f.type, size: f.size, folder: folder }; } });
        var m = e.m;
        m.sdocSrcState.sources = [SRC];
        var host = document.createElement('div');
        host.innerHTML = m.buildDocumentsFileItem(row('a.png'), 0) + m.buildDocumentsFileItem(row('x.svg'), 1) + m.buildDocumentsFileItem(row('n.txt'), 2);
        document.body.appendChild(host);
        try {
            assert.strictEqual(m.sdocThumbsAttach(host), 2, 'two image rows observed');
            assert.strictEqual(e.made.length, 0, 'nothing loaded before intersecting');
            assert.ok(typeof cb === 'function', 'observer created');
            var res = await Promise.all(observed.map(function(el) { return m.sdocThumbLoad(el); }));
            assert.deepStrictEqual(res, [true, true], 'loaded: ' + JSON.stringify({ src: !!m.sdocSrcById(SRC.id), made: e.made.length }));
            var imgs = host.querySelectorAll('img.sdoc-thumb-img');
            assert.strictEqual(imgs.length, 2);
            assert.strictEqual(imgs[0].getAttribute('src'), 'blob:test/0');
            assert.strictEqual(e.made[1].blob.type, 'image/svg+xml', 'untyped SVG re-wrapped so it renders');
            m.sdocThumbsAttach(host);
            assert.deepStrictEqual(e.revoked.slice().sort(), ['blob:test/0', 'blob:test/1'], 'previous render revoked');
            // The observer callback itself triggers the load.
            host.querySelectorAll('img.sdoc-thumb-img').forEach(function(i) { i.remove(); });
            observed.length = 0; m.sdocThumbsAttach(host);
            cb([{ target: observed[0], isIntersecting: true }]);
            for (var k = 0; k < 50 && !host.querySelector('img.sdoc-thumb-img'); k++) await new Promise(function(r) { Promise.resolve().then(r); });
            assert.ok(host.querySelector('img.sdoc-thumb-img'), 'intersection loads the thumbnail');
        } finally { host.remove(); m.sdocThumbsReset(); }
    }, { tags: ['unit'] });

    test('next/prev index skips non-media rows and stops at the ends', async function() {
        var m = (await load()).m;
        var rows = [{ src: SRC, entry: { name: 'dir', path: 'dir', kind: 'directory' } }, row('a.png'), row('notes.txt'), row('b.mp4'), row('c.js'), row('d.mp3'), row('e.pdf')];
        var list = m.sdocMediaNavList(rows);
        assert.deepStrictEqual(list.map(function(r) { return r.entry.name; }), ['a.png', 'b.mp4', 'd.mp3', 'e.pdf']);
        var s = m.sdocMediaNavStep(list, SRC.id, 'b.mp4');
        assert.strictEqual(s.index, 1); assert.strictEqual(s.total, 4);
        assert.strictEqual(s.prev.entry.name, 'a.png'); assert.strictEqual(s.next.entry.name, 'd.mp3');
        var first = m.sdocMediaNavStep(list, SRC.id, 'a.png');
        assert.strictEqual(first.prev, null, 'no wrap at start'); assert.strictEqual(first.next.entry.name, 'b.mp4');
        var last = m.sdocMediaNavStep(list, SRC.id, 'e.pdf');
        assert.strictEqual(last.next, null, 'no wrap at end');
        assert.strictEqual(m.sdocMediaNavStep(list, SRC.id, 'notes.txt').index, -1);
        assert.strictEqual(m.sdocMediaNavStep(list, 'other', 'a.png').index, -1, 'source must match');
    }, { tags: ['unit'] });

    test('viewer shows chevrons + counter, arrows move between files, ends disabled, inputs ignored', async function() {
        var files = { 'v.mp4': fakeFile('v.mp4', 5000, 'video/mp4'), 's.mp3': fakeFile('s.mp3', 300, 'audio/mpeg'), 'd.pdf': fakeFile('d.pdf', 100, 'application/pdf') };
        var e = await load({ lfGetFile: async function(folder, path) { var f = files[path]; return { file: f, name: path, path: path, mime: f.type, size: f.size, folder: folder }; } });
        var m = e.m;
        var rows = [row('v.mp4'), row('readme.txt'), row('s.mp3'), row('d.pdf')];
        m.sdocSrcState.rendered = rows;
        var list = document.createElement('div');
        list.innerHTML = rows.map(function(r, i) { return m.buildDocumentsFileItem(r, i); }).join('');
        document.body.appendChild(list);
        var origFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function() {};
        try {
            var ov = await m.sdocPreviewFile(SRC, 'v.mp4');
            assert.strictEqual(ov.querySelector('.sdoc-media-counter').textContent, '1 / 3');
            assert.ok(ov.querySelector('.sdoc-media-prev').disabled, 'prev disabled at start');
            assert.ok(!ov.querySelector('.sdoc-media-next').disabled);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            assert.ok(document.body.contains(ov), 'ArrowLeft at the start does nothing');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            await tick();
            assert.ok(!document.body.contains(ov), 'old overlay closed');
            var all = document.querySelectorAll('.wsf-overlay');
            assert.strictEqual(all.length, 1, 'exactly one overlay');
            ov = all[0];
            assert.ok(ov.querySelector('audio.sdoc-file-preview-audio'), 'skipped readme.txt to s.mp3');
            assert.strictEqual(ov.querySelector('.sdoc-media-counter').textContent, '2 / 3');
            var inp = document.createElement('input'); ov.appendChild(inp);
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            assert.ok(document.body.contains(ov), 'arrows in an input are not hijacked');
            ov.querySelector('.sdoc-media-next').click();
            await tick();
            ov = document.querySelector('.wsf-overlay');
            assert.ok(ov.querySelector('iframe.sdoc-file-preview-pdf'));
            assert.strictEqual(ov.querySelector('.sdoc-media-counter').textContent, '3 / 3');
            assert.ok(ov.querySelector('.sdoc-media-next').disabled, 'next disabled at end');
            ov._wsfClose();
            // Listener cleaned up: an arrow after close opens nothing.
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            await tick();
            assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 0, 'key listener removed on close');
            assert.strictEqual(e.revoked.length, e.made.length, 'every blob: URL revoked');
        } finally { HTMLElement.prototype.focus = origFocus; closeAll(); list.remove(); }
    }, { tags: ['unit'] });
});
