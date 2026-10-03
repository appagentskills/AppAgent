// Model-bound image media-type gate: sanitizeModelImageUrl / normalizeImageMime
// (tools/040-file-store.js) + the js_eval producer gate _validModelImageRows
// (tools/020-tool-execution.js). Regression: a js_eval `_images` entry of
// `data:,` (toDataURL on a 0x0 canvas) was persisted and sent as an image block
// with media_type '' -> Anthropic 400 on EVERY later send (chat bricked).

var PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
var JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
var GIF_B64 = 'R0lGODlhAQABAAAAACw=';

describe('image media-type sanitizer', function() {
    var fs;
    beforeEach(async function() { fs = await runFile('src/js/tools/040-file-store.js'); });

    test('png / jpeg / gif / webp are sniffed from the bytes', async function() {
        var p = fs.sanitizeModelImageUrl('data:image/png;base64,' + PNG_B64);
        assert.strictEqual(p.ok, true); assert.strictEqual(p.mime, 'image/png');
        var j = fs.sanitizeModelImageUrl('data:application/octet-stream;base64,' + JPEG_B64);
        assert.strictEqual(j.ok, true); assert.ok(j.url.indexOf('data:image/jpeg;base64,') === 0);
        assert.strictEqual(fs.sanitizeModelImageUrl('data:;base64,' + GIF_B64).mime, 'image/gif');
        var webp = btoa('RIFF\0\0\0\0WEBPVP8 \0\0\0\0');
        assert.strictEqual(fs.sanitizeModelImageUrl('data:image/png;base64,' + webp).mime, 'image/webp');
        // bare base64 (no prefix) is accepted and given a canonical prefix
        assert.ok(fs.sanitizeModelImageUrl(PNG_B64).url.indexOf('data:image/png;base64,') === 0);
        assert.strictEqual(fs.sanitizeModelImageUrl('https://x.test/a.png').ok, true);
    }, { tags: ['unit'] });

    test('image/jpg alias + params normalise; mislabelled bytes are corrected', async function() {
        assert.strictEqual(fs.normalizeImageMime('IMAGE/JPG; charset=x'), 'image/jpeg');
        assert.strictEqual(fs.normalizeImageMime('image/pjpeg'), 'image/jpeg');
        var r = fs.sanitizeModelImageUrl('data:image/jpg;base64,' + JPEG_B64);
        assert.strictEqual(r.ok, true); assert.ok(r.url.indexOf('data:image/jpeg;base64,') === 0);
        var mis = fs.sanitizeModelImageUrl('data:image/png;base64,' + JPEG_B64);
        assert.strictEqual(mis.mime, 'image/jpeg');
    }, { tags: ['unit'] });

    test('regression: data:, (0x0 canvas) and empty payloads are rejected', async function() {
        var r = fs.sanitizeModelImageUrl('data:,');
        assert.strictEqual(r.ok, false); assert.match(r.reason, /unsupported|empty/);
        assert.strictEqual(fs.sanitizeModelImageUrl('data:image/png;base64,').ok, false);
        assert.strictEqual(fs.sanitizeModelImageUrl('').ok, false);
        assert.strictEqual(fs.sanitizeModelImageUrl(undefined).ok, false);
    }, { tags: ['unit'] });

    test('svg -> converted to png or placeholder; garbage -> placeholder', async function() {
        var svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
        var s = fs.sanitizeModelImageUrl(svg);
        assert.strictEqual(s.ok, false); assert.match(s.reason, /image\/svg\+xml/);
        var conv = await fs.convertImageDataUrlToPng(svg);
        assert.ok(conv === null || fs.sanitizeModelImageUrl(conv).mime === 'image/png');
        var g = fs.sanitizeModelImageUrl('data:image/png;base64,' + btoa('hello world garbage!!'));
        assert.strictEqual(g.ok, false); assert.match(g.reason, /unsupported type image\/png/);
        var bmp = fs.sanitizeModelImageUrl('data:image/bmp;base64,' + btoa('BM\x10\0\0\0\0\0\0\0\x36\0'));
        assert.strictEqual(bmp.ok, false); assert.match(bmp.reason, /image\/bmp/);
        assert.strictEqual(await fs.convertImageDataUrlToPng('data:,'), null);
    }, { tags: ['unit'] });

    test('js_eval producer gate drops invalid rows and reports _images_rejected', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var start = src.indexOf('async function _validModelImageRows(');
        var end = src.indexOf('\n}\n', start) + 3;
        assert.ok(start > 0 && end > start);
        var make = new Function('sanitizeModelImageUrl', 'convertImageDataUrlToPng', src.slice(start, end) + '\nreturn _validModelImageRows;');
        var gate = make(fs.sanitizeModelImageUrl, async function() { return null; });
        var res = {};
        var rows = await gate([
            { name: 'sheet', base64: 'data:,' },
            { name: 'ok', base64: 'data:image/jpg;base64,' + JPEG_B64 }
        ], res);
        assert.strictEqual(rows.length, 1);
        assert.ok(rows[0].base64.indexOf('data:image/jpeg;base64,') === 0);
        assert.strictEqual(res._images_rejected.length, 1);
        assert.strictEqual(res._images_rejected[0].name, 'sheet');
    }, { tags: ['unit'] });

    test('send-time choke points are wired (api messages + Anthropic converter)', async function() {
        var api = await loadFile('src/js/app/020-api-messages.js');
        assert.match(api, /sanitizeModelImageUrl\(_ssSrc\)/);
        assert.match(api, /\[image omitted: ' \+ _ssSan\.reason/);
        var bg = await loadFile('src/platform/extension/background.js');
        assert.match(bg, /\[image omitted: unsupported type ' \+ \(_declMt \|\| 'empty'\)/);
    }, { tags: ['unit'] });
});
