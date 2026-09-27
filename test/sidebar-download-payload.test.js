// S0B2-08 — ui/290-screenshot-ui.js sidebar downloads when the payload is evicted.
// MEMFIX eviction deletes message base64, so the sidebar download buttons used to
// return silently. downloadScreenshotFromSidebar / downloadPdfFromSidebar /
// downloadFileFromSidebar must await ensureChatPayloads(<chat current at click
// time>) and download the restored payload, else show a warning snackbar and
// click nothing, and never reject (they run from inline onclick). Image downloads
// take the extension from the data URL (jpeg -> .jpg, png fallback), in the modal too.
// Run: run_tests { files: ['test/sidebar-download-payload.test.js'] }
describe('S0B2-08 sidebar downloads rehydrate evicted payloads (ui/290-screenshot-ui.js)', function() {
    var SRC = 'src/js/ui/290-screenshot-ui.js';
    var WARN = ['Attachment not available (still loading or removed)', 'warning'];
    var JPG = 'data:image/jpeg;base64,/9j/4AAQ', PNG = 'data:image/png;base64,iVBORw0K';
    async function setup(chatsObj, opts) {
        opts = opts || {};
        var s = { clicks: [], snacks: [], ensures: [], blobs: [], revoked: [], m: null };
        function FakeBlob(parts, o) { this.parts = parts.slice(); this.size = this.parts.join('').length; this.type = o && o.type; s.blobs.push(this); }
        var doc = {
            createElement: function(tag) {
                var el = { tagName: String(tag).toUpperCase() };
                el.click = function() { s.clicks.push({ href: el.href, download: el.download }); };
                return el;
            },
            querySelector: function(sel) { return sel === '#modal-body img' ? (opts.modalImg || null) : null; }
        };
        var url = { createObjectURL: function(b) { return 'blob:test/' + s.blobs.indexOf(b); }, revokeObjectURL: function(u) { s.revoked.push(u); } };
        async function ensureChatPayloads(id) {
            s.ensures.push(id);
            await Promise.resolve();
            if (opts.onEnsure) opts.onEnsure(id, chatsObj, s.m);
        }
        s.m = await loadModules([SRC], { globals: { chats: chatsObj, currentChatId: 'c1', ensureChatPayloads: ensureChatPayloads,
            showSnackbar: function(msg, type) { s.snacks.push([msg, type]); }, document: doc, Blob: FakeBlob, URL: url } });
        return s;
    }

    test('evicted screenshot restored by ensureChatPayloads -> downloads the restored data URL as .jpg, from the chat current at click time', async function() {
        var chatsObj = {
            c1: { _payloadsEvicted: true, messages: [{ role: 'user', content: 'hi' }, { role: 'screenshot', base64: PNG },
                { role: 'screenshot', name: 'my shot', screenshot_id: 'ss_2', _b64Evicted: true }] },
            c2: { messages: [{ role: 'screenshot', base64: PNG }, { role: 'screenshot', name: 'other', base64: 'data:image/png;base64,QzI=' }] }
        };
        var s = await setup(chatsObj, { onEnsure: function(id, cs, m) {
            m.__scope.currentChatId = 'c2'; // the user switches chat while the payload loads
            // R2e-1: like the real ensureChatPayloads (it re-reads chats[chatId]), hydration can swap in
            // NEW objects: replace the chat with a restored clone, so only a re-pick finds the payload.
            var restored = JSON.parse(JSON.stringify(cs[id]));
            restored.messages[2].base64 = JPG;
            delete restored.messages[2]._b64Evicted;
            delete restored._payloadsEvicted;
            cs[id] = restored;
        } });
        await s.m.downloadScreenshotFromSidebar('1');
        assert.deepStrictEqual(s.ensures, ['c1']);
        assert.strictEqual(s.clicks.length, 1);
        assert.strictEqual(s.clicks[0].href, JPG);
        assert.match(s.clicks[0].download, /^my_shot-\d+\.jpg$/);
        assert.deepStrictEqual(s.snacks, []);
    }, { tags: ['unit'] });

    test('evicted screenshot not restored -> warning snackbar, nothing clicked; a missing index warns without hydrating', async function() {
        var chatsObj = { c1: { _payloadsEvicted: true, messages: [{ role: 'screenshot', name: 'x', screenshot_id: 'ss_1', _b64Evicted: true },
            { role: 'file', name: 'a.txt', content: 'A' }] } };
        var s = await setup(chatsObj, { onEnsure: function() {} }); // hydration finds nothing
        await s.m.downloadScreenshotFromSidebar('0');
        assert.deepStrictEqual(s.ensures, ['c1']);
        assert.deepStrictEqual(s.clicks, []);
        assert.deepStrictEqual(s.snacks, [WARN]);
        await s.m.downloadFileFromSidebar(3); // removed / out of range
        assert.deepStrictEqual(s.ensures, ['c1']);
        assert.deepStrictEqual(s.clicks, []);
        assert.deepStrictEqual(s.snacks, [WARN, WARN]);
    }, { tags: ['unit'] });

    test('a rejecting ensureChatPayloads -> the download promise resolves and a warning is shown; a chat without messages warns too', async function() {
        var chatsObj = { c1: { _payloadsEvicted: true, messages: [{ role: 'pdf', name: 'r.pdf', file_id: 'f1', _b64Evicted: true }] }, c3: {} };
        var s = await setup(chatsObj, { onEnsure: function() { throw new Error('IndexedDB unavailable'); } });
        var err = null;
        try { await s.m.downloadPdfFromSidebar(0); } catch (e) { err = e; }
        assert.strictEqual(err, null);
        assert.deepStrictEqual(s.ensures, ['c1']);
        assert.deepStrictEqual(s.clicks, []);
        assert.deepStrictEqual(s.snacks, [WARN]);
        s.m.__scope.currentChatId = 'c3';
        try { await s.m.downloadScreenshotFromSidebar('0'); } catch (e) { err = e; }
        assert.strictEqual(err, null);
        assert.deepStrictEqual(s.ensures, ['c1']);
        assert.deepStrictEqual(s.snacks, [WARN, WARN]);
    }, { tags: ['unit'] });

    test('evicted pdf and file restored -> pdf downloads its data URL, file downloads a Blob of the restored content; a present payload skips hydration', async function() {
        var PDF = 'data:application/pdf;base64,JVBERi0x';
        var chatsObj = { c1: { _payloadsEvicted: true, messages: [
            { role: 'pdf', name: 'Q3 report', file_id: 'f1', _b64Evicted: true },
            { role: 'file', name: 'notes.md', mimeType: 'text/markdown', file_id: 'f2', _b64Evicted: true }
        ] } };
        var s = await setup(chatsObj, { onEnsure: function(id, cs) {
            cs[id].messages[0].base64 = PDF;
            cs[id].messages[1].content = '# notes';
            delete cs[id]._payloadsEvicted;
        } });
        await s.m.downloadPdfFromSidebar(0);
        await s.m.downloadFileFromSidebar(0);
        assert.deepStrictEqual(s.ensures, ['c1']); // the file was restored by the first hydration: no second call
        assert.deepStrictEqual(s.clicks, [{ href: PDF, download: 'Q3_report.pdf' }, { href: 'blob:test/0', download: 'notes.md' }]);
        assert.deepStrictEqual(s.blobs.map(function(b) { return [b.parts, b.type]; }), [[['# notes'], 'text/markdown']]);
        assert.deepStrictEqual(s.revoked, ['blob:test/0']);
        assert.deepStrictEqual(s.snacks, []);
    }, { tags: ['unit'] });

    test('R2e-2: an empty text file (content "") downloads a 0-byte Blob, with no hydration and no warning', async function() {
        var s = await setup({ c1: { messages: [{ role: 'file', name: 'empty.txt', content: '' }] } }, { onEnsure: function() {} });
        await s.m.downloadFileFromSidebar(0);
        assert.deepStrictEqual(s.ensures, []);
        assert.deepStrictEqual(s.clicks, [{ href: 'blob:test/0', download: 'empty.txt' }]);
        assert.deepStrictEqual(s.blobs.map(function(b) { return [b.parts, b.size, b.type]; }), [[[''], 0, 'text/plain']]);
        assert.deepStrictEqual(s.revoked, ['blob:test/0']);
        assert.deepStrictEqual(s.snacks, []);
    }, { tags: ['unit'] });

    test('downloadScreenshot names the file from the data URL type: jpeg -> .jpg, webp -> .webp, png or non-data -> .png', async function() {
        var WEBP = 'data:image/webp;base64,UklGR', HTTP = 'https://example.test/a.jpg';
        var img = { dataset: { fullSrc: JPG } };
        var s = await setup({ c1: { messages: [] } }, { modalImg: img });
        s.m.downloadScreenshot();
        img.dataset.fullSrc = WEBP; s.m.downloadScreenshot();
        img.dataset.fullSrc = PNG; s.m.downloadScreenshot();
        img.dataset.fullSrc = HTTP; s.m.downloadScreenshot();
        assert.deepStrictEqual(s.clicks.map(function(c) { return c.href; }), [JPG, WEBP, PNG, HTTP]);
        var names = s.clicks.map(function(c) { return c.download; });
        assert.match(names[0], /^screenshot-\d+\.jpg$/);
        assert.match(names[1], /^screenshot-\d+\.webp$/);
        assert.match(names[2], /^screenshot-\d+\.png$/);
        assert.match(names[3], /^screenshot-\d+\.png$/);
    }, { tags: ['unit'] });
});
