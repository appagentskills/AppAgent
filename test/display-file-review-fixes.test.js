// Review fixes for the display 'file' template (#1372) and list_instances
// include_roles (#1375): connected-folder snapshots, metadata-only file_id
// resolution, display-card pinning in the file store, the 20-file cap flag,
// and the maint userName/token pairing.
var DRF_DISPLAY = 'src/js/tools/090-display-templates.js';

function drfDir(name) {
    var kids = {};
    return { kind: 'directory', name: name, _kids: kids,
        queryPermission: async function() { return 'granted'; },
        requestPermission: async function() { return 'granted'; },
        getDirectoryHandle: async function(n) { if (!kids[n] || kids[n].kind !== 'directory') { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; } return kids[n]; },
        getFileHandle: async function(n) { if (!kids[n]) { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; } return kids[n]; },
        values: async function*() { for (var k in kids) yield kids[k]; } };
}
function drfFile(dir, n, bytes) {
    dir._kids[n] = { kind: 'file', name: n, getFile: async function() { return { size: bytes.length, type: '', lastModified: 42, arrayBuffer: async function() { return bytes.slice().buffer; }, slice: function(a, b) { var s = bytes.slice(a, b); return { arrayBuffer: async function() { return s.buffer; } }; } }; } };
}

describe('display file cards: review fixes', function() {
    test('F1: connected-folder paths become downloadable blob snapshots (not NOT_VIRTUAL)', async function() {
        var calls = [];
        var m = await loadModules([DRF_DISPLAY], { globals: {
            lfIsVirtualFolderRef: function(r) { return r == null || r === 'virtual'; },
            lfShareFile: async function() { calls.push('share'); throw new Error('NOT_VIRTUAL'); },
            lfAuthorizeSourceRead: async function(folder, path, o) { calls.push(['auth', folder, path, o && o.chatId]); return true; },
            lfSnapshotFile: async function(folder, path) { calls.push(['snap', folder, path]); return { file_id: 'file_1_2', name: 'a.png', mime: 'image/png', size: 4, lastModified: 7, bytes: new Uint8Array([1, 2, 3, 4]) }; },
            fileStoreThumbnail: async function(blob) { calls.push(['thumb', blob instanceof Blob]); return { data_url: 'data:image/jpeg;base64,QQ==' }; }
        } });
        var out = await m.resolveDisplayFiles({ template: 'file', folder: 'lf_photos', files: ['pics/a.png'] }, { chatId: 'chat_d' });
        var f = out.files[0];
        assert.deepStrictEqual([f.file_id, f.name, f.size, f.modified, f.error], ['file_1_2', 'a.png', 4, 7, undefined]);
        assert.deepStrictEqual(calls, [['auth', 'lf_photos', 'pics/a.png', 'chat_d'], ['snap', 'lf_photos', 'pics/a.png'], ['thumb', true]]);
    }, { tags: ['unit'] });

    test('F6: connected-folder snapshot honours local_folder:read (denied → card error, no snapshot)', async function() {
        var snaps = [];
        var gate = null;
        var m = await loadModules([DRF_DISPLAY], { globals: {
            lfIsVirtualFolderRef: function(r) { return r == null || r === 'virtual'; },
            lfAuthorizeSourceRead: async function(folder, path, o) { return gate(folder, path, o); },
            lfSnapshotFile: async function(folder, path) { snaps.push(path); return { file_id: 'file_1_2', name: 'a.txt', mime: 'text/plain', size: 1, lastModified: 1 }; },
            resolveFile: async function(id) { return { name: id, mime: 'text/plain', size: 1 }; }
        } });
        gate = async function() { var e = new Error('Reading "a.txt" is refused: local_folder:read is Off in Settings > Tool permissions.'); e.code = 'PERMISSION_DENIED'; throw e; };
        var out = await m.resolveDisplayFiles({ template: 'file', folder: 'lf_photos', files: ['a.txt', 'b.txt'] }, { chatId: 'c' });
        assert.strictEqual(out.files.length, 2);
        out.files.forEach(function(f) { assert.ok(/local_folder:read is Off/.test(f.error)); assert.strictEqual(f.file_id, undefined); });
        assert.deepStrictEqual(snaps, [], 'no bytes read when the permission is Off');
        // Agent Files / file_id entries are unaffected by the connected-folder gate
        var vf = await m.resolveDisplayFiles({ template: 'file', files: [{ file_id: 'file_7_7' }] }, {});
        assert.ok(!vf.files[0].error);
        gate = async function() { return true; };
        var ok = await m.resolveDisplayFiles({ template: 'file', folder: 'lf_photos', files: ['a.txt'] }, { chatId: 'c' });
        assert.deepStrictEqual([ok.files[0].file_id, ok.files[0].error], ['file_1_2', undefined]);
        assert.deepStrictEqual(snaps, ['a.txt']);
    }, { tags: ['unit'] });

    test('#1379: connected-folder file_id pointers are gated + snapshotted; virtual pointers unchanged', async function() {
        var calls = [];
        var gate = async function() { return true; };
        var m = await loadModules([DRF_DISPLAY], { globals: {
            lfIsVirtualFolderRef: function(r) { return r == null || r === 'virtual'; },
            resolveFileMeta: async function(id) {
                if (id === 'file_cf') return { kind: 'folder', folder: 'lf_photos', path: 'pics/a.png', name: 'a.png', mime: 'image/png', size: 4 };
                if (id === 'file_vf') return { kind: 'folder', folder: 'virtual', path: 'out/b.txt', name: 'b.txt', mime: 'text/plain', size: 2, lastModified: 5 };
                return null;
            },
            resolveFile: async function() { return null; },
            lfAuthorizeSourceRead: async function(folder, path, o) { calls.push(['auth', folder, path, o && o.chatId]); return gate(); },
            lfSnapshotFile: async function(folder, path) { calls.push(['snap', folder, path]); return { file_id: 'file_snap', name: 'a.png', mime: 'image/png', size: 4, lastModified: 9, bytes: new Uint8Array([1, 2, 3, 4]) }; },
            fileStoreThumbnail: async function(blob) { calls.push(['thumb', blob instanceof Blob]); return { data_url: 'data:image/jpeg;base64,QQ==' }; }
        } });
        var out = await m.resolveDisplayFiles({ template: 'file', files: [{ file_id: 'file_cf' }, { file_id: 'file_vf' }] }, { chatId: 'chat_z' });
        var a = out.files[0], b = out.files[1];
        assert.deepStrictEqual([a.file_id, a.name, a.mime, a.size, a.modified, a.thumb, a.error], ['file_snap', 'a.png', 'image/png', 4, 9, 'data:image/jpeg;base64,QQ==', undefined]);
        assert.deepStrictEqual([b.file_id, b.name, b.size, b.modified, b.error], ['file_vf', 'b.txt', 2, 5, undefined]);
        assert.deepStrictEqual(calls, [['auth', 'lf_photos', 'pics/a.png', 'chat_z'], ['snap', 'lf_photos', 'pics/a.png'], ['thumb', true]]);
        // denied gate → card error, no snapshot, file_id dropped
        calls = [];
        gate = async function() { throw new Error('Reading "pics/a.png" is refused: local_folder:read is Off'); };
        var den = await m.resolveDisplayFiles({ template: 'file', files: [{ file_id: 'file_cf' }] }, {});
        assert.ok(/local_folder:read is Off/.test(den.files[0].error));
        assert.strictEqual(den.files[0].file_id, undefined);
        assert.deepStrictEqual(calls.map(function(c) { return c[0]; }), ['auth']);
    }, { tags: ['unit'] });

    test('#1379: connected-folder file_id fails closed without the permission gate', async function() {
        var snaps = [];
        var m = await loadModules([DRF_DISPLAY], { globals: {
            lfIsVirtualFolderRef: function(r) { return r == null || r === 'virtual'; },
            resolveFileMeta: async function() { return { kind: 'folder', folder: 'lf_x', path: 'a.txt', name: 'a.txt', mime: 'text/plain', size: 1 }; },
            lfSnapshotFile: async function(folder, path) { snaps.push(path); return { file_id: 'x' }; }
        } });
        var out = await m.resolveDisplayFiles({ template: 'file', files: [{ file_id: 'file_cf' }] }, {});
        assert.ok(/not permitted/.test(out.files[0].error));
        assert.strictEqual(out.files[0].file_id, undefined);
        assert.deepStrictEqual(snaps, []);
    }, { tags: ['unit'] });

    test('F6: fails closed when the permission gate is not loaded', async function() {
        var snaps = [];
        var m = await loadModules([DRF_DISPLAY], { globals: {
            lfIsVirtualFolderRef: function(r) { return r == null || r === 'virtual'; },
            lfSnapshotFile: async function(folder, path) { snaps.push(path); return { file_id: 'x' }; }
        } });
        var out = await m.resolveDisplayFiles({ template: 'file', folder: 'lf_photos', files: ['a.txt'] }, {});
        assert.ok(/not permitted/.test(out.files[0].error));
        assert.deepStrictEqual(snaps, []);
    }, { tags: ['unit'] });

    test('F6: real lfAuthorizeSourceRead gate — Off/Ask refuse, allow snapshots', async function() {
        var lf = await runFile('src/js/tools/170-local-folders.js');
        var perm = 'disabled', snaps = [];
        lf.lfSetDeps({ getToolPermission: function(tool, action) { assert.deepStrictEqual([tool, action], ['local_folder', 'read']); return perm; } });
        var m = await loadModules([DRF_DISPLAY], { globals: {
            lfIsVirtualFolderRef: function(r) { return r == null || r === 'virtual'; },
            lfAuthorizeSourceRead: lf.lfAuthorizeSourceRead,
            lfSnapshotFile: async function(folder, path) { snaps.push(path); return { file_id: 'file_3_3', name: 'a.txt', mime: 'text/plain', size: 1 }; }
        } });
        var off = await m.resolveDisplayFiles({ template: 'file', folder: 'lf_x', files: ['a.txt'] }, {});
        assert.ok(/local_folder:read is Off/.test(off.files[0].error));
        perm = 'ask';
        var ask = await m.resolveDisplayFiles({ template: 'file', folder: 'lf_x', files: ['a.txt'] }, {});
        assert.ok(/needs approval/.test(ask.files[0].error));
        assert.deepStrictEqual(snaps, []);
        perm = 'allow';
        var ok = await m.resolveDisplayFiles({ template: 'file', folder: 'lf_x', files: ['a.txt'] }, {});
        assert.strictEqual(ok.files[0].file_id, 'file_3_3');
        assert.deepStrictEqual(snaps, ['a.txt']);
        // approval prompt path receives the calling options
        var seen = null;
        lf.lfSetDeps({ approve: async function(t, a, o) { seen = [t, a, o && o.chatId]; return { allowed: false, error: 'denied by the user' }; } });
        var den = await m.resolveDisplayFiles({ template: 'file', folder: 'lf_x', files: ['a.txt'] }, { chatId: 'chat_q' });
        assert.ok(/not permitted \(local_folder:read\)/.test(den.files[0].error));
        assert.deepStrictEqual(seen, ['local_folder', { action: 'read', folder: 'lf_x', path: 'a.txt' }, 'chat_q']);
        assert.deepStrictEqual(snaps, ['a.txt']);
    }, { tags: ['unit'] });

    test('F6: display handler threads options into resolveDisplayFiles', async function() {
        var ex = await loadFile('src/js/tools/020-tool-execution.js');
        assert.ok(/args = await resolveDisplayFiles\(args, options\);/.test(ex));
    }, { tags: ['unit'] });

    test('F1: lfSnapshotFile stores a blob under the stable per-path id', async function() {
        var m = await runFile('src/js/tools/170-local-folders.js');
        var local = drfDir('photos'), store = {};
        drfFile(local, 'a.png', new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        m.lfSetDeps({ getOpfsRoot: async function() { return drfDir(''); }, readRow: async function() { return [{ id: 'lf_ro', label: 'Photos', access: 'read', handle: local, addedAt: 1 }]; },
            writeRow: async function() {}, newFileId: function() { return 'file_9_9'; }, registerFile: function(id, p) { store[id] = p; } });
        var s = await m.lfSnapshotFile('lf_ro', 'a.png');
        assert.strictEqual(s.file_id, m.lfShareFileId('lf_ro', 'a.png'));
        assert.strictEqual(store[s.file_id].type, 'memory', 'blob copy, not a folder pointer');
        assert.strictEqual(store[s.file_id].data.length, 8);
        assert.deepStrictEqual([s.name, s.size, s.lastModified], ['a.png', 8, 42]);
    }, { tags: ['unit'] });

    test('F2: file_id cards use metadata only; bytes only for capped image thumbnails', async function() {
        var full = [];
        var metas = {
            file_1_1: { kind: 'folder', name: 'big.mp4', mime: 'video/mp4', size: 400 * 1048576, lastModified: 5 },
            file_2_2: { kind: 'folder', name: 'huge.png', mime: 'image/png', size: 30 * 1048576 },
            file_3_3: { kind: 'folder', name: 'small.png', mime: 'image/png', size: 100 }
        };
        var m = await loadModules([DRF_DISPLAY], { globals: {
            resolveFileMeta: async function(id) { return metas[id] || null; },
            resolveFile: async function(id) { full.push(id); return { blob: new Blob([new Uint8Array(1)]) }; },
            fileStoreThumbnail: async function() { return { data_url: 'data:image/jpeg;base64,QQ==' }; }
        } });
        var out = await m.resolveDisplayFiles({ template: 'file', files: [{ file_id: 'file_1_1' }, { file_id: 'file_2_2' }, { file_id: 'file_3_3' }] });
        assert.deepStrictEqual(out.files.map(function(f) { return [f.name, f.size, !!f.error, !!f.thumb]; }),
            [['big.mp4', 400 * 1048576, false, false], ['huge.png', 30 * 1048576, false, false], ['small.png', 100, false, true]]);
        assert.strictEqual(out.files[0].modified, 5);
        assert.deepStrictEqual(full, ['file_3_3'], 'full bytes read only for the small image');
    }, { tags: ['unit'] });

    test('F2: resolveFileMeta answers folder pointers from the record (no byte read)', async function() {
        var fs = await runFile('src/js/tools/040-file-store.js');
        var rows = {}, reads = 0;
        fs.ufsSetDeps({ idb: { get: async function(id) { return rows[id] || null; }, put: async function(r) { rows[r.id] = r; }, del: async function(id) { delete rows[id]; }, all: async function() { return Object.values(rows); } },
            readFolderFile: async function() { reads++; var e = new Error('too big'); e.code = 'TOO_LARGE'; throw e; } });
        var id = await fs.registerFileAsync({ pointer: { kind: 'folder', folder: 'lf_x', path: 'v/big.mp4', size: 400 * 1048576, mime: 'video/mp4', lastModified: 9 } });
        var r = await fs.resolveFileMeta(id);
        assert.deepStrictEqual([r.kind, r.name, r.mime, r.size, r.lastModified], ['folder', 'big.mp4', 'video/mp4', 400 * 1048576, 9]);
        assert.strictEqual(reads, 0);
        var b = await fs.registerFileAsync({ data: 'hello', name: 'a.txt' });
        var rb = await fs.resolveFileMeta(b);
        assert.ok(rb.blob instanceof Blob && rb.size === 5);
        assert.strictEqual(await fs.resolveFileMeta('file_404_404'), null);
    }, { tags: ['unit'] });

    test('F3: reference scan pins file_ids of chat display file cards (persisted + in-memory) only', async function() {
        var chatRows = [
            { id: 'c1', messages: [{ content: 'mentions file_5_5 in prose' }], displays: { d1: { template: 'file', args: { files: [{ file_id: 'file_1_1700000000000', name: 'a.pdf' }] } }, d2: { template: 'table', args: { rows: [['file_6_6']] } } } },
            { id: 'c2' }
        ];
        var fakeDb = { objectStoreNames: { contains: function(n) { return n === 'chats'; } },
            transaction: function() { return { objectStore: function() { return { openCursor: function() {
                var rq = {}, i = 0;
                var step = function() { setTimeout(function() { rq.result = i < chatRows.length ? { value: chatRows[i], continue: function() { i++; step(); } } : null; rq.onsuccess(); }, 0); };
                step(); return rq; } }; } }; } };
        var mem = { c3: { displays: { d9: { template: 'file', args: { file_id: 'file_2_1700000000000' } } } } };
        var M = await loadModules(['src/js/tools/040-file-store.js'], { lenient: true, globals: { openDatabase: async function() { return fakeDb; }, chatStoreName: 'chats', chats: mem } });
        var set = await M._ufsReferencedIds();
        assert.deepStrictEqual(Array.from(set).sort(), ['file_1_1700000000000', 'file_2_1700000000000']);
    }, { tags: ['unit'] });

    test('F4: more than DISPLAY_FILE_MAX entries are flagged, and the tool result reports it', async function() {
        var m = await loadModules([DRF_DISPLAY], { globals: { resolveFile: async function(id) { return { name: id, mime: 'text/plain', size: 1 }; } } });
        var files = []; for (var i = 0; i < 23; i++) files.push({ file_id: 'f' + i });
        var out = await m.resolveDisplayFiles({ template: 'file', files: files });
        assert.strictEqual(out.files.length, m.DISPLAY_FILE_MAX);
        assert.strictEqual(out.files_omitted, 3);
        assert.strictEqual(m.displayFileOverflow({ files: files.slice(0, 5) }), 0);
        var ex = await loadFile('src/js/tools/020-tool-execution.js');
        assert.ok(/fileDisp\.truncated = args\.files_omitted;/.test(ex), 'display tool result carries truncated');
    }, { tags: ['unit'] });

    test('F5: include_roles uses inst.userName only with inst.token', async function() {
        var ex = await loadFile('src/js/tools/020-tool-execution.js');
        assert.ok(/var _liUser = _tok === inst\.token \? inst\.userName : '';/.test(ex));
        assert.ok(/snMaintEligible\(_dr, true, _liUser\)/.test(ex));
        assert.ok(!/snMaintEligible\(_dr, true, inst\.userName\)/.test(ex));
    }, { tags: ['unit'] });
});
