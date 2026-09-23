// Workspace race fixes (H3, H8 + the CAS primitive). Real core/130-indexeddb.js
// runs over a minimal in-memory IndexedDB (serialized readwrite transactions,
// staged commit / rollback on abort), and the real tools/020 wsEdit /
// _wsTransferOwnership are wired onto that store.
function fakeIDB(opts) {
    opts = opts || {};
    var data = { workspace_files: new Map(), workspace_blobs: new Map(), settings: new Map(), workspace_meta: new Map() };
    var keyPaths = { workspace_files: 'id', workspace_blobs: 'sha', settings: 'key', workspace_meta: 'repo' };
    var queue = [], running = null, txLog = [];
    function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
    function pumpQueue() {
        if (running || !queue.length) return;
        running = queue.shift();
        running.start();
    }
    function makeTx(stores, mode) {
        stores = [].concat(stores);
        txLog.push({ stores: stores.slice().sort(), mode: mode });
        var staged = {}, reqs = [], done = false, tx;
        stores.forEach(function(s) { staged[s] = null; });
        function st(name) { if (!staged[name]) staged[name] = new Map(Array.from(data[name].entries()).map(function(e) { return [e[0], clone(e[1])]; })); return staged[name]; }
        function request(fn) {
            var r = { result: undefined, error: null };
            reqs.push({ r: r, fn: fn });
            if (running === tx) queueMicrotask(step);
            return r;
        }
        function finish(ok, err) {
            if (done) return; done = true;
            if (ok) { Object.keys(staged).forEach(function(s) { if (staged[s]) data[s] = staged[s]; }); if (tx.oncomplete) tx.oncomplete(); }
            else { tx.error = err; if (tx.onerror) tx.onerror(); if (tx.onabort) tx.onabort(); }
            running = null; queueMicrotask(pumpQueue);
        }
        var busy = false;
        function step() {
            if (done || busy) return;
            var q = reqs.shift();
            if (!q) { queueMicrotask(function() { queueMicrotask(function() { if (!reqs.length && !busy) finish(true); else step(); }); }); return; }
            busy = true;
            try { q.r.result = q.fn(); } catch (e) { busy = false; q.r.error = e; finish(false, e); return; }
            busy = false;
            if (q.r.onsuccess) q.r.onsuccess({ target: q.r });
            queueMicrotask(step);
        }
        function objectStore(name) {
            var kp = keyPaths[name];
            function rows() { return Array.from(st(name).values()); }
            return {
                put: function(v) { return request(function() { if (name === 'workspace_blobs' && opts.failBlobPut) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); st(name).set(v[kp], clone(v)); return v[kp]; }); },
                get: function(k) { return request(function() { return clone(st(name).get(k)); }); },
                getAll: function() { return request(function() { return rows().map(clone); }); },
                delete: function(k) { return request(function() { st(name).delete(k); }); },
                openCursor: function() {
                    var keys = Array.from(st(name).keys()), i = 0, r;
                    r = request(function next() {
                        if (i >= keys.length) return null;
                        var k = keys[i++];
                        return { key: k, value: clone(st(name).get(k)), delete: function() { st(name).delete(k); }, continue: function() { var rr = request(next); rr.onsuccess = function() { r.result = rr.result; if (r.onsuccess) r.onsuccess({ target: r }); }; } };
                    });
                    return r;
                },
                index: function(ix) {
                    function match(row, key) { return ix === 'repo_path' ? (row.repo === key[0] && row.path === key[1]) : row[ix] === key; }
                    return {
                        get: function(key) { return request(function() { var f = rows().filter(function(r) { return match(r, key); })[0]; return f ? clone(f) : undefined; }); },
                        getAll: function(key) { return request(function() { return rows().filter(function(r) { return match(r, key); }).map(clone); }); },
                        getAllKeys: function(key) { return request(function() { return rows().filter(function(r) { return match(r, key); }).map(function(r) { return r[kp]; }); }); }
                    };
                }
            };
        }
        tx = { objectStore: objectStore, oncomplete: null, onerror: null, onabort: null, error: null,
            start: function() { queueMicrotask(step); } };
        queue.push(tx); queueMicrotask(pumpQueue);
        return tx;
    }
    var conn = { close: function() {}, objectStoreNames: { contains: function() { return true; } }, transaction: makeTx };
    return { data: data, txLog: txLog, indexedDB: { open: function() { var r = {}; queueMicrotask(function() { r.result = conn; r.onsuccess({ target: r }); }); return r; } } };
}
function deferred() { var d = {}; d.promise = new Promise(function(res) { d.resolve = res; }); return d; }

async function loadIdb(idb) {
    return loadModules(['src/js/core/130-indexeddb.js'], { lenient: true, globals: { STORAGE_PREFIX: 'test_', skillAssetsStoreName: 'skillAssets', indexedDB: idb.indexedDB, console: { warn: function() {}, error: function() {}, log: function() {} } } });
}
var WK = 'o/r::main';
function row(path, content, extra) { return Object.assign({ id: WK + '::' + path, repo: WK, path: path, sha: 's-' + path, content: content, original_content: content, dirty: false, deleted: false, file_id: 'f-' + path }, extra || {}); }

describe('CAS primitive setWorkspaceFileIf (core/130-indexeddb.js)', function() {
    test('writes when the stored row still matches `expected`; conflicts (and returns current) when it changed', async function() {
        var idb = fakeIDB(), m = await loadIdb(idb);
        assert.strictEqual(typeof m.setWorkspaceFileIf, 'function', 'CAS primitive exists (old code: missing)');
        await m.setWorkspaceFile(row('a.js', 'v0'));
        var snap = await m.getWorkspaceFile(WK, 'a.js');
        var edited = Object.assign({}, snap, { content: 'v1', dirty: true, last_modified_at: 1, last_modified_by_chat_id: 'A' });
        assert.strictEqual((await m.setWorkspaceFileIf(WK, 'a.js', snap, edited)).ok, true);
        var stale = Object.assign({}, snap, { content: 'v2', dirty: true, last_modified_at: 2, last_modified_by_chat_id: 'B' });
        var r = await m.setWorkspaceFileIf(WK, 'a.js', snap, stale);
        assert.strictEqual(r.ok, false); assert.strictEqual(r.conflict, true);
        assert.strictEqual(r.current.content, 'v1', 'current = the concurrently written row');
        assert.strictEqual((await m.getWorkspaceFile(WK, 'a.js')).content, 'v1', 'stale writer did not clobber');
    });
    test('expected=null requires absence; newRow=null deletes only an unchanged row', async function() {
        var idb = fakeIDB(), m = await loadIdb(idb);
        assert.strictEqual((await m.setWorkspaceFileIf(WK, 'n.js', null, row('n.js', 'x', { sha: null, original_content: null, dirty: true }))).ok, true);
        assert.strictEqual((await m.setWorkspaceFileIf(WK, 'n.js', null, row('n.js', 'y', { sha: null, dirty: true }))).conflict, true, 'second create conflicts');
        var cur = await m.getWorkspaceFile(WK, 'n.js');
        assert.strictEqual((await m.setWorkspaceFileIf(WK, 'n.js', Object.assign({}, cur, { content: 'other', dirty: true }), null)).conflict, true, 'delete with stale expected refused');
        assert.ok(await m.getWorkspaceFile(WK, 'n.js'));
        assert.strictEqual((await m.setWorkspaceFileIf(WK, 'n.js', cur, null)).ok, true);
        assert.strictEqual(await m.getWorkspaceFile(WK, 'n.js'), null);
    });
    test('H8: blob + row are written in ONE transaction over both stores (GC cannot interleave); quota on blob falls back to inline row', async function() {
        var idb = fakeIDB(), m = await loadIdb(idb);
        idb.txLog.length = 0;
        await m.setWorkspaceFile(row('b.js', 'base'));
        var rw = idb.txLog.filter(function(t) { return t.mode === 'readwrite'; });
        assert.strictEqual(rw.length, 1, 'old code: two separate readwrite txs (blob, then row)');
        assert.deepStrictEqual(rw[0].stores, ['workspace_blobs', 'workspace_files']);
        assert.strictEqual(idb.data.workspace_blobs.get('s-b.js').content, 'base');
        assert.ok(!('original_content' in idb.data.workspace_files.get(WK + '::b.js')), 'row stripped');
        var idb2 = fakeIDB({ failBlobPut: true }), m2 = await loadIdb(idb2);
        await m2.setWorkspaceFile(row('q.js', 'inline'));
        assert.strictEqual(idb2.data.workspace_files.get(WK + '::q.js').original_content, 'inline', 'blob failure keeps inline content');
        assert.strictEqual(idb2.data.workspace_blobs.size, 0, 'aborted blob put rolled back');
    });
});

describe('H3: concurrent wsEdit / ownership transfer do not lose writes (tools/020)', function() {
    async function wire(gateFirstRead) {
        var idb = fakeIDB(), s = await loadIdb(idb);
        var m = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        var reads = 0;
        m.__scope.getWorkspaceFile = async function(repo, path) {
            var r = await s.getWorkspaceFile(repo, path);
            if (gateFirstRead && reads++ === 0) await gateFirstRead.promise;
            return r;
        };
        m.__scope.setWorkspaceFile = s.setWorkspaceFile;
        m.__scope.setWorkspaceFileIf = s.setWorkspaceFileIf;
        m.__scope.getAllWorkspaceFilesAllRepos = s.getAllWorkspaceFilesAllRepos;
        m.__scope.getWorkspaceMeta = async function() { return { repo: WK, branch: 'main', github_repo: 'o/r' }; };
        m.__scope.wsGetIgnoreFilter = async function() { return function() { return false; }; };
        m.__scope.chats = { root1: { id: 'root1', title: 'Root' }, sub1: { id: 'sub1', isSubAgent: true } };
        m.__scope.SubAgents = { getByChatId: function(id) { return id === 'sub1' ? { chat_id: 'sub1', root_chat_id: 'root1', parent_chat_id: 'root1' } : null; } };
        await s.setWorkspaceFile(row('a.js', 'one\ntwo\n'));
        return { m: m, s: s };
    }
    test('edit A paused between read and write + edit B completes → BOTH edits survive (old code: A clobbers B)', async function() {
        var gate = deferred(), w = await wire(gate);
        var pA = w.m.wsEdit(WK, 'a.js', [{ find: 'one', replace: 'ONE' }], 'root1', 'Root', false);
        await new Promise(function(r) { setTimeout(r, 5); });
        var rB = await w.m.wsEdit(WK, 'a.js', [{ find: 'two', replace: 'TWO' }], 'root1', 'Root', false);
        assert.strictEqual(rB.success, true, JSON.stringify(rB));
        gate.resolve();
        var rA = await pA;
        assert.strictEqual(rA.success, true, JSON.stringify(rA));
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).content, 'ONE\nTWO\n');
    });
    test('re-applied edit whose find no longer matches returns the normal "All edits failed" error, never a clobber', async function() {
        var gate = deferred(), w = await wire(gate);
        var pA = w.m.wsEdit(WK, 'a.js', [{ find: 'one', replace: 'ONE' }], 'root1', 'Root', false);
        await new Promise(function(r) { setTimeout(r, 5); });
        await w.m.wsEdit(WK, 'a.js', [{ find: 'one', replace: 'uno' }], 'root1', 'Root', false);
        gate.resolve();
        var rA = await pA;
        assert.strictEqual(rA.success, false);
        assert.strictEqual(rA.error, 'All edits failed');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).content, 'uno\ntwo\n');
    });
    test('_wsTransferOwnership racing a parent edit (after its re-read) leaves the edit intact', async function() {
        var w = await wire(null);
        await w.m.wsEdit(WK, 'a.js', [{ find: 'one', replace: 'sub' }], 'sub1', 'sub', false);
        var gate = deferred(), n = 0, real = w.m.__scope.getWorkspaceFile;
        w.m.__scope.getWorkspaceFile = async function(repo, path) { var r = await real(repo, path); if (n++ === 0) await gate.promise; return r; };
        var pT = w.m._wsTransferOwnership('sub1', 'root1');
        await new Promise(function(r) { setTimeout(r, 5); });
        w.m.__scope.getWorkspaceFile = real;
        var e = await w.m.wsEdit(WK, 'a.js', [{ find: 'two', replace: 'parent' }], 'root1', 'Root', false);
        assert.strictEqual(e.success, true, JSON.stringify(e));
        gate.resolve();
        await pT;
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).content, 'sub\nparent\n', 'old code: transfer re-put the pre-edit snapshot');
    });
});
