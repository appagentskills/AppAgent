// Unified file store (tools/040-file-store.js): registerFile/resolveFile for
// blobs and folder pointers, persistence across a simulated SW restart,
// sniffMime, image media types, and consumers resolving through the helper.

function fakeIdb() {
    var rows = {};
    return { rows: rows,
        get: async function(id) { return rows[id] || null; },
        put: async function(r) { rows[r.id] = r; },
        del: async function(id) { delete rows[id]; },
        all: async function() { return Object.keys(rows).map(function(k) { return rows[k]; }); } };
}
var JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
var PNG_HEAD = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];

describe('unified file store', function() {
    var fs, idb;
    beforeEach(async function() {
        fs = await runFile('src/js/tools/040-file-store.js');
        idb = fakeIdb();
        fs.ufsSetDeps({ idb: idb });
    });

    test('sniffMime recognises magic bytes', async function() {
        assert.strictEqual(fs.sniffMime(new Uint8Array(PNG_HEAD)), 'image/png');
        assert.strictEqual(fs.sniffMime(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');
        assert.strictEqual(fs.sniffMime(new TextEncoder().encode('GIF89a...')), 'image/gif');
        assert.strictEqual(fs.sniffMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
        assert.strictEqual(fs.sniffMime(new TextEncoder().encode('%PDF-1.7')), 'application/pdf');
        assert.strictEqual(fs.sniffMime(new TextEncoder().encode('ID3\x03')), 'audio/mpeg');
        assert.strictEqual(fs.sniffMime(new TextEncoder().encode('hello')), null);
    }, { tags: ['unit'] });

    test('JPEG bytes labelled .png / image/png get image/jpeg (regression)', async function() {
        var fixed = fs.fixDataUrlMime('data:image/png;base64,' + JPEG_B64);
        assert.ok(fixed.indexOf('data:image/jpeg;base64,') === 0, fixed.slice(0, 30));
        var id = await fs.registerFileAsync({ data: 'data:image/png;base64,' + JPEG_B64, name: 'extension.png', mime: 'image/png' });
        var r = await fs.resolveFile(id);
        assert.strictEqual(r.mime, 'image/jpeg');
        var legacy = await fs.getFileAsync(id);
        assert.ok(legacy.data.indexOf('data:image/jpeg;base64,') === 0);
        // background.js convertContentPart sets media_type from the bytes
        var bg = await loadFile('src/platform/extension/background.js');
        assert.ok(/var _mt = _bgSniffImageMime\(imgData\)/.test(bg));
        assert.ok(/media_type: _mt, data: imgData/.test(bg));
        assert.ok(/fixDataUrlMime\(_ssSrc\)/.test(await loadFile('src/js/app/020-api-messages.js')));
    }, { tags: ['unit'] });

    test('blob register/resolve persists as a Blob and survives a SW restart', async function() {
        var id = await fs.registerFileAsync({ blob: new Blob([new Uint8Array(PNG_HEAD)]), name: 'a.bin' });
        assert.ok(idb.rows[id].blob instanceof Blob, 'stored as Blob, not base64');
        assert.strictEqual(idb.rows[id].mime, 'image/png');
        var fresh = await runFile('src/js/tools/040-file-store.js');
        fresh.ufsSetDeps({ idb: idb });
        var r = await fresh.resolveFile(id);
        assert.ok(r && r.blob instanceof Blob);
        assert.strictEqual(r.size, PNG_HEAD.length);
        assert.strictEqual(r.mime, 'image/png');
        var ss = await fresh.executeScreenshotById ? null : null; // screenshot_by_id lives in 070
    }, { tags: ['unit'] });

    test('legacy (id, memory pointer) form lands in the same store', async function() {
        fs.registerFile('file_x', { type: 'memory', data: 'data:application/pdf;base64,JVBERi0xLjc=', name: 'd.pdf' });
        var r = await fs.resolveFile('file_x');
        assert.strictEqual(r.mime, 'application/pdf');
        assert.ok(idb.rows.file_x, 'persisted');
    }, { tags: ['unit'] });

    test('folder pointers resolve lazily through readFolderFile', async function() {
        var reads = 0;
        fs.ufsSetDeps({ idb: idb, readFolderFile: async function(folder, path) { reads++; return { bytes: new Uint8Array([0xFF, 0xD8, 0xFF, 1, 2]) }; } });
        var id = await fs.registerFileAsync({ pointer: { kind: 'folder', folder: 'virtual', path: 'pics/extension.png', size: 5, mime: 'image/png' } });
        assert.strictEqual(reads, 0, 'no bytes read at register time');
        assert.strictEqual(idb.rows[id].kind, 'folder');
        assert.strictEqual(idb.rows[id].blob, undefined);
        var r = await fs.resolveFile(id);
        assert.strictEqual(reads, 1);
        assert.strictEqual(r.mime, 'image/jpeg');
        assert.strictEqual(r.size, 5);
    }, { tags: ['unit'] });

    test('cleanup evicts old blobs only, never folder pointers', async function() {
        var t = 1000;
        fs.ufsSetDeps({ idb: idb, now: function() { return t; } });
        var b = await fs.registerFileAsync({ data: 'hello', name: 'a.txt' });
        var f = await fs.registerFileAsync({ pointer: { kind: 'folder', folder: 'virtual', path: 'x.png' } });
        t += fs.UFS_LIMITS.ttlMs + 1;
        var res = await fs.fileStoreCleanup();
        assert.deepStrictEqual(res.deleted, [b]);
        assert.ok(idb.rows[f], 'folder pointer kept');
        assert.throws(function() { fs.registerFile({ blob: { size: fs.UFS_LIMITS.maxFileBytes + 1, type: '' } }); });
    }, { tags: ['unit'] });

    test('consumers resolve through the unified helper', async function() {
        var lf = await loadFile('src/js/tools/170-local-folders.js');
        assert.ok(/typeof resolveFile === 'function' \? resolveFile/.test(lf), 'lfResolveBinaryInput (servicenow_api / web_fetch / local_folder write) uses resolveFile');
        assert.ok(/kind: 'folder', type: 'folder'/.test(lf), 'local_folder read registers a folder pointer');
        var ex = await loadFile('src/js/tools/020-tool-execution.js');
        assert.ok(/registerFileAsync\(\{ blob: _wfBlob/.test(ex), 'web_fetch save_file registers the Blob');
        assert.ok(/lfResolveBinaryInput\(\{ file_id: args\.attachment_file_id/.test(ex), 'servicenow_api attachment path');
        var sb = await loadFile('src/js/tools/070-screenshot-by-id.js');
        assert.ok(/await getFileAsync\(id\)/.test(sb), 'screenshot_by_id resolves via the store');
        var gf = await loadFile('src/js/tools/040-file-store.js');
        assert.ok(/var file = await getFileAsync\(id\)/.test(gf), 'get_file resolves via the store');
    }, { tags: ['unit'] });

    test('runtime_inspect screenshot registers a file_id with MIME from the bytes and survives a restart', async function() {
        var db = fakeIdb();
        var M = await loadModules(['src/js/tools/040-file-store.js', 'src/js/tools/140-runtime-inspect.js'], { lenient: true, globals: { window: {}, chrome: {}, chats: {} } });
        M.ufsSetDeps({ idb: db });
        // Mislabelled on purpose: the bytes are JPEG, the data URL says PNG.
        var out = await M._riRegisterScreenshot('data:image/png;base64,' + JPEG_B64, 12, 8);
        assert.strictEqual(out.success, true);
        assert.ok(/^file_/.test(out.file_id), 'file_id returned: ' + out.file_id);
        assert.strictEqual(out.mime, 'image/jpeg');
        assert.ok(out.base64.indexOf('data:') === 0, 'base64 kept for backward compatibility');
        assert.ok(db.rows[out.file_id], 'persisted in the files store');
        M.ufsSetDeps({ idb: db }); // simulated SW restart: in-realm caches dropped
        var r = await M.resolveFile(out.file_id);
        assert.strictEqual(r.mime, 'image/jpeg');
        assert.strictEqual(r.width, 12);
        assert.ok(/\.jpg$/.test(r.name), r.name);
        var legacy = await M.getFileAsync(out.file_id);
        assert.ok(legacy.data.indexOf('data:image/jpeg;base64,') === 0);
    }, { tags: ['unit'] });

    test('runtime_inspect screenshot degrades to base64 only when the store is unavailable', async function() {
        var M = await loadModules(['src/js/tools/140-runtime-inspect.js'], { lenient: true, globals: { window: {}, chrome: {} } });
        var out = await M._riRegisterScreenshot('data:image/jpeg;base64,' + JPEG_B64, 1, 1);
        assert.strictEqual(out.success, true);
        assert.strictEqual(out.file_id, null);
        assert.ok(out.file_store_error);
        assert.ok(out.base64);
    }, { tags: ['unit'] });

    test('read_attached_file resolves text through resolveFile, never returns binary as text', async function() {
        var db = fakeIdb();
        var chatsG = {};
        var M = await loadModules(['src/js/tools/040-file-store.js', 'src/js/tools/050-file-tools.js'], { lenient: true, globals: { chats: chatsG, activeStreamingChatId: null, currentChatId: null } });
        M.ufsSetDeps({ idb: db });
        var csvId = await M.registerFileAsync({ data: 'a,b\n1,2', name: 'rows.csv', mime: 'text/csv' });
        var pngId = await M.registerFileAsync({ bytes: new Uint8Array(PNG_HEAD), name: 'pic.txt', mime: 'text/plain' });
        chatsG.c1 = { messages: [
            { role: 'file', name: 'rows.csv', file_id: csvId, content: 'stale inline' },
            { role: 'file', name: 'pic.txt', file_id: pngId, content: 'inline text' },
            { role: 'file', name: 'gone.txt', file_id: 'file_missing_1', content: 'fallback' }
        ] };
        M.ufsSetDeps({ idb: db }); // after a SW restart
        var a = await M.executeReadAttachedFile({ filename: 'rows.csv' }, { chatId: 'c1' });
        assert.strictEqual(a.content, 'a,b\n1,2');
        var b = await M.executeReadAttachedFile({ filename: 'pic.txt' }, { chatId: 'c1' });
        assert.strictEqual(b.content, 'inline text', 'PNG bytes (sniffed) never replace text content');
        var c = await M.executeReadAttachedFile({ filename: 'gone.txt' }, { chatId: 'c1' });
        assert.strictEqual(c.content, 'fallback');
    }, { tags: ['unit'] });

    test('no sync getFile() consumers remain outside the store', async function() {
        var files = ['src/js/tools/050-file-tools.js', 'src/js/tools/020-tool-execution.js', 'src/js/tools/070-screenshot-by-id.js', 'src/js/tools/140-runtime-inspect.js', 'src/js/tools/170-local-folders.js'];
        for (var i = 0; i < files.length; i++) {
            // Code lines only: comments may still mention the legacy helper.
            var code = (await loadFile(files[i])).split('\n').filter(function(l) { return !/^\s*(\/\/|\*)/.test(l); }).join('\n');
            assert.ok(!/(^|[^.\w])getFile\(/m.test(code), files[i] + ' still calls the sync getFile()');
        }
    }, { tags: ['unit'] });
});
