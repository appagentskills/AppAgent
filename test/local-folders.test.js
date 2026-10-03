// Connected folders (tools/170-local-folders.js): path normalization, read-only
// refusal, OPFS read/write/grep via an in-memory directory-handle stub, the
// file-store bridge, and the servicenow_api / web_fetch binary-input resolution.

function fakeFile(name, bytes) {
    return { size: bytes.length, type: '', lastModified: 1, arrayBuffer: async function() { return bytes.slice().buffer; } };
}
function fakeDir(name, perm) {
    var kids = {};
    var d = {
        kind: 'directory', name: name, _kids: kids,
        queryPermission: async function() { return perm ? perm.state : 'granted'; },
        requestPermission: async function() { if (perm) perm.state = perm.onRequest || perm.state; return perm ? perm.state : 'granted'; },
        getDirectoryHandle: async function(n, o) {
            if (!kids[n]) { if (!(o && o.create)) { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; } kids[n] = fakeDir(n); }
            if (kids[n].kind !== 'directory') throw new Error('TypeMismatchError');
            return kids[n];
        },
        getFileHandle: async function(n, o) {
            if (!kids[n]) {
                if (!(o && o.create)) { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; }
                var fh = { kind: 'file', name: n, _bytes: new Uint8Array(0) };
                fh.getFile = async function() { return fakeFile(n, fh._bytes); };
                fh.createWritable = async function() { var buf; return { write: async function(b) { buf = new Uint8Array(b); }, close: async function() { fh._bytes = buf; } }; };
                kids[n] = fh;
            }
            return kids[n];
        },
        removeEntry: async function(n, o) {
            if (!kids[n]) { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; }
            if (kids[n].kind === 'directory' && Object.keys(kids[n]._kids).length && !(o && o.recursive)) throw new Error('InvalidModificationError');
            delete kids[n];
        },
        values: async function*() { for (var k in kids) yield kids[k]; }
    };
    return d;
}

describe('local folders', function() {
    var m, opfs, row, store, local, perm;
    beforeEach(async function() {
        m = await runFile('src/js/tools/170-local-folders.js');
        opfs = fakeDir('');
        perm = { state: 'granted' };
        local = fakeDir('photos', perm);
        row = [{ id: 'lf_ro', label: 'Photos', access: 'read', handle: local, addedAt: 1 }];
        store = {}; var n = 0;
        m.lfSetDeps({
            getOpfsRoot: async function() { return opfs; },
            readRow: async function() { return row; },
            writeRow: async function(l) { row = l; },
            newFileId: function() { return 'file_t' + (++n); },
            registerFile: function(id, p) { store[id] = p; },
            getFileAsync: async function(id) {
                var p = store[id]; if (!p) return null;
                if (p.kind === 'folder') { var fr = await m.lfReadFileAsDataUrl(p.folder, p.path); return { id: id, name: p.name, mime: fr.mime, data: fr.data_url }; }
                return { id: id, name: p.name, mime: p.mime, data: p.data };
            }
        });
    });

    test('normalizes paths and rejects .. escapes', async function() {
        assert.strictEqual(m.lfNormalizePath('/a//./b\\c.png'), 'a/b/c.png');
        assert.strictEqual(m.lfNormalizePath(''), '');
        assert.strictEqual(m.lfNormalizePath(null), '');
        assert.throws(function() { m.lfNormalizePath('a/../../etc'); }, function(e) { return e.code === 'PATH_ESCAPE'; });
        var r = await m.executeLocalFolder({ action: 'read', path: '../x' });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.code, 'PATH_ESCAPE');
    }, { tags: ['unit'] });

    test('virtual folder: write, ls, read text, grep, delete', async function() {
        var w = await m.executeLocalFolder({ action: 'write', path: 'notes/hello.txt', content: 'hello\nworld foo' });
        assert.strictEqual(w.success, true, JSON.stringify(w));
        assert.strictEqual(w.folder, 'virtual');
        var ls = await m.executeLocalFolder({ action: 'ls', recursive: true });
        assert.deepStrictEqual(ls.entries.map(function(e) { return e.path; }), ['notes', 'notes/hello.txt']);
        var rd = await m.executeLocalFolder({ action: 'read', path: 'notes/hello.txt' });
        assert.strictEqual(rd.content, 'hello\nworld foo');
        assert.strictEqual(rd.file_id, undefined);
        var g = await m.executeLocalFolder({ action: 'grep', pattern: 'FOO' });
        assert.strictEqual(g.total, 1);
        assert.strictEqual(g.matches[0].line, 2);
        var del = await m.executeLocalFolder({ action: 'delete', path: 'notes', recursive: true });
        assert.strictEqual(del.success, true);
        var ls2 = await m.executeLocalFolder({ action: 'ls' });
        assert.strictEqual(ls2.entries.length, 0);
    }, { tags: ['unit'] });

    test('binary read registers a file_id; base64 adds data_url; write from file_id round-trips', async function() {
        var png = 'data:image/png;base64,iVBORw0KGgo=';
        await m.executeLocalFolder({ action: 'write', path: 'img/a.png', base64: png });
        var rd = await m.executeLocalFolder({ action: 'read', path: 'img/a.png' });
        assert.strictEqual(rd.binary, true);
        assert.ok(rd.file_id && store[rd.file_id], 'file registered');
        assert.strictEqual(rd.content, undefined);
        // Lazy folder pointer — no bytes copied into the store.
        assert.strictEqual(store[rd.file_id].kind, 'folder');
        assert.strictEqual(store[rd.file_id].path, 'img/a.png');
        assert.strictEqual(store[rd.file_id].data, undefined);
        assert.strictEqual(rd.mime_type, 'image/png');
        var rd64 = await m.executeLocalFolder({ action: 'read', path: 'img/a.png', encoding: 'base64' });
        assert.strictEqual(rd64.data_url, png);
        var w = await m.executeLocalFolder({ action: 'write', path: 'copy.png', file_id: rd.file_id });
        assert.strictEqual(w.size, 8);
        var again = await m.lfReadFileAsDataUrl('virtual', 'copy.png');
        assert.strictEqual(again.data_url, png);
    }, { tags: ['unit'] });

    test('read-only folder refuses writes/mkdir/delete but allows reads', async function() {
        var fh = await local.getFileHandle('p.txt', { create: true });
        fh._bytes = new TextEncoder().encode('pic');
        var rd = await m.executeLocalFolder({ action: 'read', folder: 'Photos', path: 'p.txt' });
        assert.strictEqual(rd.content, 'pic');
        var w = await m.executeLocalFolder({ action: 'write', folder: 'lf_ro', path: 'x.txt', content: 'no' });
        assert.strictEqual(w.code, 'READ_ONLY');
        assert.strictEqual((await m.executeLocalFolder({ action: 'mkdir', folder: 'lf_ro', path: 'd' })).code, 'READ_ONLY');
        assert.strictEqual((await m.executeLocalFolder({ action: 'delete', folder: 'lf_ro', path: 'p.txt' })).code, 'READ_ONLY');
        assert.ok(local._kids['p.txt'], 'file untouched');
        await m.setLocalFolderAccess('lf_ro', 'readwrite');
        var w2 = await m.executeLocalFolder({ action: 'write', folder: 'lf_ro', path: 'x.txt', content: 'ok' });
        assert.strictEqual(w2.success, true);
    }, { tags: ['unit'] });

    test('lapsed permission reports PERMISSION_REQUIRED; registry helpers', async function() {
        perm.state = 'prompt';
        var r = await m.executeLocalFolder({ action: 'ls', folder: 'lf_ro' });
        assert.strictEqual(r.code, 'PERMISSION_REQUIRED');
        var list = await m.listLocalFolders();
        assert.strictEqual(list[0].id, 'virtual');
        assert.strictEqual(list[0].access, 'readwrite');
        assert.strictEqual(list[1].permission, 'prompt');
        var added = await m.addLocalFolder(fakeDir('docs'), { access: 'readwrite' });
        assert.strictEqual(added.label, 'docs');
        assert.strictEqual(row.length, 2);
        await m.removeLocalFolder(added.id);
        assert.strictEqual(row.length, 1);
        await assert.rejects(m.removeLocalFolder('virtual'));
        await assert.rejects(m.setLocalFolderAccess('lf_ro', 'admin'));
    }, { tags: ['unit'] });

    test('pickLocalFolder: cancel returns null, pick persists with access', async function() {
        m.lfSetDeps(Object.assign({}, { getOpfsRoot: async function() { return opfs; }, readRow: async function() { return row; }, writeRow: async function(l) { row = l; },
            showDirectoryPicker: async function(o) { if (o.mode !== 'readwrite') { var e = new Error('x'); e.name = 'AbortError'; throw e; } return fakeDir('picked'); } }));
        assert.strictEqual(await m.pickLocalFolder('read'), null);
        var e = await m.pickLocalFolder('readwrite', 'My pics');
        assert.strictEqual(e.label, 'My pics');
        assert.strictEqual(row[row.length - 1].access, 'readwrite');
    }, { tags: ['unit'] });

    test('lfResolveBinaryInput + lfBuildFetchBody (attachment / web_fetch arg resolution)', async function() {
        store.f1 = { name: 'shot.png', mime: 'image/png', data: 'data:image/png;base64,AAEC' };
        var a = await m.lfResolveBinaryInput({ file_id: 'f1' });
        assert.deepStrictEqual(Array.from(a.bytes), [0, 1, 2]);
        assert.strictEqual(a.name, 'shot.png');
        assert.strictEqual(a.mime, 'image/png');
        await m.executeLocalFolder({ action: 'write', path: 'b.bin', base64: 'AwQF' });
        var s = await m.lfResolveBinaryInput({ source: { folder: 'virtual', path: 'b.bin' } });
        assert.deepStrictEqual(Array.from(s.bytes), [3, 4, 5]);
        await assert.rejects(m.lfResolveBinaryInput({ file_id: 'missing' }));
        await assert.rejects(m.lfResolveBinaryInput({}));
        assert.strictEqual(await m.lfBuildFetchBody({ body: 'x' }), null);
        var b = await m.lfBuildFetchBody({ body_file_id: 'f1' });
        assert.strictEqual(b.contentType, 'image/png');
        assert.strictEqual(b.multipart, false);
        var b2 = await m.lfBuildFetchBody({ body_base64: 'AAEC', content_type: 'application/x-test' });
        assert.strictEqual(b2.contentType, 'application/x-test');
        if (typeof FormData === 'function' && typeof Blob === 'function') {
            var f = await m.lfBuildFetchBody({ form: { note: 'hi', file: { file_id: 'f1' }, other: { folder: 'virtual', path: 'b.bin', filename: 'o.bin' } } });
            assert.strictEqual(f.multipart, true);
            assert.strictEqual(f.body.get('note'), 'hi');
            assert.strictEqual(f.body.get('file').size, 3);
            assert.strictEqual(f.body.get('other').name, 'o.bin');
        }
    }, { tags: ['unit'] });

    test('servicenow_api and web_fetch arms are wired to the resolver', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        assert.ok(/args\.attachment_data \|\| args\.attachment_file_id \|\| args\.attachment_source/.test(src));
        assert.ok(/lfResolveBinaryInput\(\{ file_id: args\.attachment_file_id, source: args\.attachment_source \}, options\)/.test(src));
        assert.ok(/await lfBuildFetchBody\(args, options\)/.test(src));
        assert.ok(/name === 'local_folder'/.test(src));
        var tools = await loadFile('src/js/core/080-tools.js');
        assert.ok(/name === 'local_folder' && args && args\.action === 'request'\) return false/.test(tools));
        var b1 = await loadFile('build/build.js'), b2 = await loadFile('skills/extension-dev/build.js');
        assert.ok(b1.indexOf("'js/tools/170-local-folders.js',\n    'js/tools/020-tool-execution.js'") !== -1);
        assert.ok(b2.indexOf("'src/js/tools/170-local-folders.js',\n        'src/js/tools/020-tool-execution.js'") !== -1);
    }, { tags: ['unit'] });
});
