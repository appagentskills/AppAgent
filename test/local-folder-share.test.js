// local_folder share: Agent Files writes return file_id + download_url and
// render get_file's download card for direct calls; action 'share' does the
// same for an existing file; non-virtual folders are refused.
// Real src/js/tools/170-local-folders.js; OPFS / file store / card are fakes.

function lfsFakeDir() {
    var kids = {};
    return {
        kind: 'directory', _kids: kids,
        getDirectoryHandle: async function(n, o) {
            if (!kids[n]) { if (!(o && o.create)) { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; } kids[n] = lfsFakeDir(); }
            return kids[n];
        },
        getFileHandle: async function(n, o) {
            if (!kids[n]) { if (!(o && o.create)) { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; } kids[n] = lfsFakeFile(n); }
            return kids[n];
        }
    };
}
function lfsFakeFile(name) {
    var h = { kind: 'file', name: name, bytes: new Uint8Array(0) };
    h.getFile = async function() { return new Blob([h.bytes], { type: '' }); };
    h.createWritable = async function() { var buf; return { write: async function(b) { buf = b; }, close: async function() { h.bytes = buf; } }; };
    return h;
}

async function lfsLoad(shareOverride) {
    var m = await loadModules(['src/js/tools/170-local-folders.js'], { lenient: true });
    var reg = {}, cards = [], n = 0, root = lfsFakeDir();
    m.lfSetDeps({
        getOpfsRoot: async function() { return root; },
        newFileId: function() { return 'file_t' + (++n); },
        registerFile: function(id, p) { reg[id] = p; },
        shareFile: shareOverride || async function(a, o, internal) { cards.push({ args: a, internal: internal }); return { success: true, download_url: 'chrome-extension://x/file-download.html?id=' + a.id, widgetId: 'w' + cards.length }; }
    });
    return { m: m, reg: reg, cards: cards };
}

describe('local_folder share / download links', function() {
    test('direct write to Agent Files returns link fields and renders a card', async function() {
        var t = await lfsLoad();
        var r = await t.m.executeLocalFolder({ action: 'write', path: 'out/report.txt', content: 'hello' }, {});
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.path, 'out/report.txt');
        assert.strictEqual(r.size, 5);
        var fid = t.m.lfShareFileId('virtual', 'out/report.txt');
        assert.match(fid, /^file_\d+_\d+$/, 'pinnable id shape');
        assert.strictEqual(r.file_id, fid);
        assert.strictEqual(r.name, 'report.txt');
        assert.ok(r.download_url.indexOf('file-download.html?id=' + fid) > -1, r.download_url);
        assert.strictEqual(r.widgetId, 'w1');
        // Card built from stat metadata (no byte read), passed via the internal
        // 3rd param of executeGetFile — never as a tool arg.
        assert.deepStrictEqual(t.cards, [{ args: { id: fid, download: true }, internal: { meta: { name: 'report.txt', mime: t.cards[0].internal.meta.mime, size: 5 } } }]);
        assert.strictEqual(t.reg[fid].kind, 'folder');
        assert.strictEqual(t.reg[fid].folder, 'virtual');
        assert.strictEqual(t.reg[fid].path, 'out/report.txt');
    }, { tags: ['unit'], timeout: 3000 });

    test('js_eval writes get a link but no card unless share:true; share:false skips both', async function() {
        var t = await lfsLoad();
        var r = await t.m.executeLocalFolder({ action: 'write', path: 'a.txt', content: 'x' }, { fromSandbox: true });
        assert.strictEqual(r.success, true);
        assert.ok(r.download_url && r.file_id, 'link fields present');
        assert.strictEqual(t.cards.length, 0, 'no card for programmatic callers');
        await t.m.executeLocalFolder({ action: 'write', path: 'b.txt', content: 'x', share: true }, { fromSandbox: true });
        assert.strictEqual(t.cards.length, 1, 'share:true opts in');
        var r3 = await t.m.executeLocalFolder({ action: 'write', path: 'c.txt', content: 'x', share: false }, {});
        assert.strictEqual(r3.file_id, undefined);
        assert.strictEqual(t.cards.length, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('share action renders a card for an existing file; missing file and other folders fail', async function() {
        var t = await lfsLoad();
        await t.m.executeLocalFolder({ action: 'write', path: 'd.csv', content: 'a,b', share: false }, {});
        var r = await t.m.executeLocalFolder({ action: 'share', path: 'd.csv' }, {});
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.name, 'd.csv');
        assert.strictEqual(r.size, 3);
        assert.strictEqual(t.cards.length, 1);
        var miss = await t.m.executeLocalFolder({ action: 'share', path: 'nope.txt' }, {});
        assert.strictEqual(miss.success, false);
        var other = await t.m.executeLocalFolder({ action: 'share', folder: 'my-folder', path: 'd.csv' }, {});
        assert.strictEqual(other.success, false);
        assert.strictEqual(other.code, 'NOT_VIRTUAL');
    }, { tags: ['unit'], timeout: 3000 });

    test('sweep: one folder record per path (re-writes reuse the id), distinct paths differ', async function() {
        var t = await lfsLoad();
        var a1 = await t.m.executeLocalFolder({ action: 'write', path: 'rec/v.webm', content: 'aa' }, { fromSandbox: true });
        var a2 = await t.m.executeLocalFolder({ action: 'write', path: 'rec/v.webm', content: 'aaaa' }, { fromSandbox: true });
        var b = await t.m.executeLocalFolder({ action: 'write', path: 'rec/w.webm', content: 'b' }, { fromSandbox: true });
        assert.strictEqual(a1.file_id, a2.file_id, 'same path, same id');
        assert.notStrictEqual(a1.file_id, b.file_id);
        assert.strictEqual(Object.keys(t.reg).length, 2, 'no record per write');
        assert.strictEqual(t.reg[a2.file_id].size, 4, 'record refreshed');
    }, { tags: ['unit'], timeout: 3000 });

    test('sweep: a failing/throwing download card still returns file_id + download_url', async function() {
        var t = await lfsLoad(async function() { throw new Error('File is 30000000 bytes — over the read limit'); });
        var w = await t.m.executeLocalFolder({ action: 'write', path: 'big.bin', content: 'x' }, {});
        assert.strictEqual(w.success, true);
        assert.ok(w.file_id && /file-download\.html\?id=/.test(w.download_url), JSON.stringify(w));
        assert.match(w.share_error, /read limit/);
        var s = await t.m.executeLocalFolder({ action: 'share', path: 'big.bin' }, {});
        assert.strictEqual(s.success, true, JSON.stringify(s));
        assert.strictEqual(s.file_id, w.file_id);
        assert.ok(s.download_url);
    }, { tags: ['unit'], timeout: 3000 });

    // Real executeGetFile (sliced from 040-file-store.js) with stubbed globals.
    async function lfsGetFile() {
        var src = await loadFile('src/js/tools/040-file-store.js');
        var a = src.indexOf('async function executeGetFile('), b = src.indexOf('// =============================================', a);
        assert.ok(a > -1 && b > a, 'executeGetFile slice');
        var calls = { read: 0, widgets: [] };
        var fn = new Function('getFileAsync', 'executeTool', 't', 'i18nFormatNumber', 'chats', '_fileIndexColdReady', '_chatFileIdsSync',
            src.slice(a, b) + '\nreturn executeGetFile;')(
            async function(id) { calls.read++; return { id: id, name: 'real.bin', mime: 'application/octet-stream', data: 'data:application/octet-stream;base64,QUJD' }; },
            async function(n, x) { calls.widgets.push(x); return { widgetId: 'w' + calls.widgets.length }; },
            function(s, v) { return v ? String(s).replace(/\{(\w+)\}/g, function(m, k) { return v[k]; }) : s; },
            function(n) { return String(n); },
            {}, async function() {}, function() { return []; });
        return { get: fn, calls: calls };
    }

    test('sweep: executeGetFile download with internal meta never reads the bytes', async function() {
        var g = await lfsGetFile();
        var r = await g.get({ id: 'file_1_2', download: true }, null, { meta: { name: 'clip.webm', mime: 'video/webm', size: 30000000 } });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(g.calls.read, 0, 'no byte read');
        assert.match(g.calls.widgets[0].title, /clip\.webm/);
    }, { tags: ['unit'], timeout: 3000 });

    test('review: _meta in plain get_file tool args is ignored (bytes resolved for real)', async function() {
        var g = await lfsGetFile();
        var r = await g.get({ id: 'file_1_2', download: true, _meta: { name: 'fake.exe', mime: 'text/plain', size: 1 } });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(g.calls.read, 1, 'getFileAsync used');
        assert.match(g.calls.widgets[0].title, /real\.bin/);
        assert.ok(g.calls.widgets[0].title.indexOf('fake.exe') < 0, 'spoofed name not used');
    }, { tags: ['unit'], timeout: 3000 });
});
