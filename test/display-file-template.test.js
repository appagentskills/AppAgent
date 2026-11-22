// display template 'file': Agent Files download cards. Real module:
// src/js/tools/090-display-templates.js (generateFile, resolveDisplayFiles,
// displayFileDownload). Generator output is parsed into an inert document.
var DFT_FILE = 'src/js/tools/090-display-templates.js';
async function dftLoad(globals) { return loadModules([DFT_FILE], { globals: globals || {} }); }
function dftDoc(html) { return new DOMParser().parseFromString(html, 'text/html'); }

describe('display file template', function() {
    test('single file: name, size, type badge and a wired Download button', async function() {
        var m = await dftLoad();
        assert.strictEqual(m.DISPLAY_GENERATORS.file, m.generateFile);
        var d = dftDoc(m.generateFile({ files: [{ file_id: 'file_1', name: 'report.pdf', size: 2048, mime: 'application/pdf', description: 'Q3 numbers' }] }));
        assert.ok(d.querySelector('.display-file.display-file--pdf'));
        assert.strictEqual(d.querySelector('.display-file-name').textContent, 'report.pdf');
        assert.strictEqual(d.querySelector('.display-file-ext').textContent, 'PDF');
        assert.match(d.querySelector('.display-file-meta').textContent, /2\.0 KB/);
        assert.strictEqual(d.querySelector('.display-file-desc').textContent, 'Q3 numbers');
        var b = d.querySelector('button.display-file-dl');
        assert.deepStrictEqual([b.getAttribute('data-file-id'), b.getAttribute('data-name'), b.getAttribute('onclick')], ['file_1', 'report.pdf', 'displayFileDownload(this)']);
        assert.ok(b.getAttribute('aria-label').indexOf('report.pdf') !== -1);
        assert.strictEqual(d.querySelector('.display-files-all'), null, 'no Download All for one file');
        assert.deepStrictEqual(m.__unstubbed, []);
    }, { tags: ['unit'] });

    test('escapes names, descriptions and attributes; rejects non-data thumbs', async function() {
        var m = await dftLoad();
        var evil = '<img src=x onerror=bad()>"\'.txt';
        var d = dftDoc(m.generateFile({ files: [{ file_id: 'id" onclick="bad()', name: evil, description: '<b>x</b>', thumb: 'javascript:bad()' }] }));
        assert.strictEqual(d.querySelector('img'), null);
        assert.strictEqual(d.querySelector('b'), null);
        assert.strictEqual(d.querySelector('.display-file-name').textContent, evil);
        assert.strictEqual(d.querySelector('.display-file-dl').getAttribute('data-file-id'), 'id" onclick="bad()');
        assert.strictEqual(d.querySelectorAll('[onclick]').length, 1);
        var ok = dftDoc(m.generateFile({ files: [{ file_id: 'f', name: 'a.png', thumb: 'data:image/jpeg;base64,AAAA' }] }));
        assert.strictEqual(ok.querySelector('img.display-file-thumb').getAttribute('src'), 'data:image/jpeg;base64,AAAA');
    }, { tags: ['unit'] });

    test('multiple files: header, count, Download All, and an error card without a button', async function() {
        var m = await dftLoad();
        var d = dftDoc(m.generateFile({ title: 'Exports', files: [
            { file_id: 'a', name: 'data.csv', size: 10 }, { file_id: 'b', name: 'app.zip', size: 5 * 1048576 },
            { path: 'gone.txt', error: 'NotFoundError' }] }));
        assert.strictEqual(d.querySelector('.display-files-title').textContent, 'Exports');
        assert.strictEqual(d.querySelector('.display-files-count').textContent, '3 files');
        assert.ok(d.querySelector('.display-files-all'));
        assert.strictEqual(d.querySelectorAll('.display-file').length, 3);
        assert.strictEqual(d.querySelectorAll('.display-file-dl').length, 2);
        assert.ok(d.querySelector('.display-file--sheet') && d.querySelector('.display-file--archive'));
        var err = d.querySelector('.display-file-error');
        assert.strictEqual(err.querySelector('.display-file-name').textContent, 'gone.txt');
        assert.strictEqual(err.querySelector('.display-file-errmsg').textContent, 'NotFoundError');
        assert.match(err.querySelector('.display-file-meta').textContent, /File not found/);
        assert.match(d.querySelectorAll('.display-file-meta')[1].textContent, /5\.0 MB/);
    }, { tags: ['unit'] });

    test('resolveDisplayFiles enriches path / file_id entries and records per-entry errors', async function() {
        var calls = [];
        var m = await dftLoad({
            lfShareFile: async function(folder, path, opts) { calls.push(['share', folder, path, opts.card]); if (path === 'missing.txt') throw new Error('not found'); return { file_id: 'file_' + path, name: path.split('/').pop(), mime: path.endsWith('.png') ? 'image/png' : 'text/plain', size: 12 }; },
            lfStatFile: async function() { return { lastModified: 1700000000000 }; },
            lfGetFile: async function() { return { file: 'BLOB' }; },
            resolveFile: async function(id) { return id === 'f_ok' ? { name: 'x.bin', mime: 'application/octet-stream', size: 3, blob: 'B' } : null; },
            fileStoreThumbnail: async function(blob, mime, max) { calls.push(['thumb', blob, max]); return { data_url: 'data:image/jpeg;base64,QQ==' }; }
        });
        var out = await m.resolveDisplayFiles({ template: 'file', files: ['out/a.png', { path: 'missing.txt' }, { file_id: 'f_ok', description: 'd' }, { file_id: 'nope' }, {}] });
        var f = out.files;
        assert.deepStrictEqual([f[0].file_id, f[0].name, f[0].size, f[0].modified, f[0].thumb], ['file_out/a.png', 'a.png', 12, 1700000000000, 'data:image/jpeg;base64,QQ==']);
        assert.deepStrictEqual([f[1].file_id, f[1].error], [undefined, 'not found']);
        assert.deepStrictEqual([f[2].name, f[2].size, f[2].description], ['x.bin', 3, 'd']);
        assert.match(f[3].error, /nope/);
        assert.ok(f[4].error);
        assert.deepStrictEqual(calls.filter(function(c) { return c[0] === 'share'; })[0], ['share', 'virtual', 'out/a.png', false]);
        assert.deepStrictEqual(calls.filter(function(c) { return c[0] === 'thumb'; }), [['thumb', 'BLOB', 96]]);
        var d = dftDoc(m.generateFile(out));
        assert.strictEqual(d.querySelectorAll('.display-file-dl').length, 2);
        assert.strictEqual(d.querySelectorAll('.display-file-error').length, 3);
    }, { tags: ['unit'] });

    test('download button: Opening -> Opened on success, Failed, retry on error', async function() {
        var opened = [], fail = false;
        var m = await dftLoad({ openFileDownloadTab: function(id, name) { opened.push([id, name]); return fail ? Promise.reject(new Error('x')) : Promise.resolve(); }, showSnackbar: function() {} });
        var d = dftDoc(m.generateFile({ files: [{ file_id: 'a', name: 'a.txt' }, { file_id: 'b', name: 'b.txt' }] }));
        var b = d.querySelector('.display-file-dl');
        var p = m.displayFileDownload(b);
        assert.ok(b.classList.contains('is-busy'));
        assert.strictEqual(b.querySelector('.display-file-dl-label').textContent, 'Opening...');
        assert.strictEqual(await p, true);
        assert.ok(b.classList.contains('is-done'));
        assert.strictEqual(b.querySelector('.display-file-dl-label').textContent, 'Opened');
        fail = true;
        var b2 = d.querySelectorAll('.display-file-dl')[1];
        assert.strictEqual(await m.displayFileDownload(b2), false);
        assert.ok(b2.classList.contains('is-failed'));
        assert.strictEqual(b2.querySelector('.display-file-dl-label').textContent, 'Failed, retry');
        assert.deepStrictEqual(opened, [['a', 'a.txt'], ['b', 'b.txt']]);
        fail = false; opened = [];
        b.classList.remove('is-done');
        assert.strictEqual(await m.displayFileDownloadAll(d.querySelector('.display-file')), 2);
        assert.deepStrictEqual(opened, [['a', 'a.txt'], ['b', 'b.txt']]);
    }, { tags: ['unit'], timeout: 6000 });
});
