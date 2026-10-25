// get_file / local_folder thumbnail helpers (tools/040-file-store.js).
describe('file store thumbnails', function() {
    async function load() {
        var src = await loadFile('src/js/tools/040-file-store.js');
        var a = src.indexOf('function fileStoreThumbMax(');
        var b = src.indexOf('async function _ufsToLegacyShape(');
        assert.ok(a > 0 && b > a, 'helpers present');
        return new Function('_ufsBytesToB64', src.slice(a, b) + '\nreturn { fileStoreThumbMax: fileStoreThumbMax, fileStoreThumbnail: fileStoreThumbnail };')(function(u8) { return 'B64'; });
    }
    test('fileStoreThumbMax parses true / number / {max} and clamps', async function() {
        var m = await load();
        assert.strictEqual(m.fileStoreThumbMax(undefined), 0);
        assert.strictEqual(m.fileStoreThumbMax(false), 0);
        assert.strictEqual(m.fileStoreThumbMax(true), 512);
        assert.strictEqual(m.fileStoreThumbMax(256), 256);
        assert.strictEqual(m.fileStoreThumbMax({ max: 128 }), 128);
        assert.strictEqual(m.fileStoreThumbMax({}), 512);
        assert.strictEqual(m.fileStoreThumbMax(1), 16);
        assert.strictEqual(m.fileStoreThumbMax(99999), 2048);
        assert.strictEqual(m.fileStoreThumbMax('x'), 0);
    }, { tags: ['unit'] });
    test('fileStoreThumbnail never throws: non-image and undecodable input return {error}', async function() {
        var m = await load();
        var t1 = await m.fileStoreThumbnail(new Uint8Array([1, 2, 3]), 'application/pdf', 512);
        assert.match(t1.error, /not an image/);
        var t2 = await m.fileStoreThumbnail(new Uint8Array([1, 2, 3]), 'image/png', 512);
        assert.ok(t2.error && !t2.data_url, JSON.stringify(t2));
    }, { tags: ['unit'] });
});
