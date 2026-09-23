// Workspace race fixes part 3 (H5 wsPull, H6 wsSyncWithRemote, H7 wsPush).
// Fake IDB / wireScope / setup copied from test/workspace-cas-races-2.test.js.
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

function wireScope(m, s, metas) {
    var sc = m.__scope;
    sc.getWorkspaceFile = s.getWorkspaceFile; sc.setWorkspaceFile = s.setWorkspaceFile; sc.setWorkspaceFileIf = s.setWorkspaceFileIf;
    sc.getAllWorkspaceFiles = s.getAllWorkspaceFiles; sc.getAllWorkspaceFilesAllRepos = s.getAllWorkspaceFilesAllRepos;
    sc.getWorkspaceMeta = async function(k) { return metas[k] ? JSON.parse(JSON.stringify(metas[k])) : null; };
    sc.setWorkspaceMeta = async function(mm) { metas[mm.repo] = JSON.parse(JSON.stringify(mm)); };
    sc.getAllWorkspaceMetas = async function() { return Object.keys(metas).map(function(k) { return metas[k]; }); };
    sc.wsGetIgnoreFilter = async function() { return function() { return false; }; };
    sc.registerFile = function() {}; sc.unregisterFile = function() {}; sc.invalidateWorkspaceFilePointer = function() {};
    var n = 0; sc.newFileId = function() { return 'nf' + (n++); };
    sc.AgentEvents = { emit: function() {} };
    sc.wsKey = function(repo, br) { return repo + '::' + br; };
    sc.parseWsKey = function(k) { var i = k.indexOf('::'); return { repo: k.slice(0, i), branch: k.slice(i + 2) }; };
    sc.chats = {}; sc.SubAgents = { getByChatId: function() { return null; } };
}
async function setup() {
    var idb = fakeIDB(), s = await loadIdb(idb);
    var m = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
    var metas = {}; metas[WK] = { repo: WK, branch: 'main', github_repo: 'o/r', head_sha: 'H' };
    wireScope(m, s, metas);
    return { m: m, s: s, metas: metas };
}

function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
async function blobSha(w, s) { var fn = w.m.computeGitBlobSha || w.m.__scope.computeGitBlobSha; return await fn(s); }
async function edit(w, path, content, at) { var cur = await w.s.getWorkspaceFile(WK, path); await w.s.setWorkspaceFile(Object.assign({}, cur, { content: content, dirty: true, last_modified_at: at, last_modified_by_chat_id: 'c2' })); }

describe('H6: wsSyncWithRemote step-3 writes are CAS against a pre-mutation copy (tools/020)', function() {
    test('dirty row edited between snapshot and clean-mark keeps the edit and HEAD stays (old code: marked clean, edit lost)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        await edit(w, 'a.js', 'X', 1);
        var shaX = await blobSha(w, 'X');
        w.m.__scope.githubApi = async function(method, url) {
            if (/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H2' } } };
            if (/git\/trees\/H2/.test(url)) return { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'a.js', sha: shaX, size: 1 }] } };
            return { ok: false, status: 500, body: {} };
        };
        var n = 0, real = w.m.__scope.getAllWorkspaceFiles;
        // Call #1 = wsMaybeAutoDeleteMerged's scan, #2 = sync's step-3
        // snapshot: the edit lands right after that snapshot is taken.
        w.m.__scope.getAllWorkspaceFiles = async function(k) { var rows = await real(k); n++; if (n === 2) await edit(w, 'a.js', 'Y', 2); return rows; };
        var res = await w.m.wsSyncWithRemote(WK);
        assert.ok(n >= 2, 'race injected after the sync snapshot');
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.content, 'Y', 'concurrent edit survives');
        assert.strictEqual(a.dirty, true);
        assert.deepStrictEqual(res.raced, ['a.js']);
        assert.strictEqual(w.metas[WK].head_sha, 'H', 'HEAD not advanced past a raced row');
    });
    test('no race: clean-match still marks clean and advances HEAD', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        await edit(w, 'a.js', 'X', 1);
        var shaX = await blobSha(w, 'X');
        w.m.__scope.githubApi = async function(method, url) {
            if (/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H2' } } };
            if (/git\/trees\/H2/.test(url)) return { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'a.js', sha: shaX, size: 1 }] } };
            return { ok: false, status: 500, body: {} };
        };
        var res = await w.m.wsSyncWithRemote(WK);
        assert.strictEqual(res.raced, undefined);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).dirty, false);
        assert.strictEqual(w.metas[WK].head_sha, 'H2');
    });
});

describe('H5: wsPull re-reads each row and CASes (tools/020)', function() {
    function remote(w, extraTree, onBlob) {
        w.m.__scope.githubApi = async function(method, url) {
            if (/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H2' } } };
            if (/git\/trees\/H2/.test(url)) return { ok: true, body: { sha: 'T2', tree: extraTree } };
            if (/git\/blobs\//.test(url)) { if (onBlob) await onBlob(url); return { ok: true, body: { content: b64('REMOTE'), encoding: 'base64' } }; }
            return { ok: false, status: 500, body: {} };
        };
    }
    test('file edited locally while its blob downloads is kept, reported localChanged, HEAD stays (old code: overwritten)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('b.js', 'base'));
        remote(w, [{ type: 'blob', path: 'b.js', sha: 'rb', size: 6 }], async function() { await edit(w, 'b.js', 'mine', 5); });
        var res = await w.m.wsPull(WK);
        var b = await w.s.getWorkspaceFile(WK, 'b.js');
        assert.strictEqual(b.content, 'mine'); assert.strictEqual(b.dirty, true);
        assert.ok((res.conflicts || []).some(function(c) { return c.path === 'b.js' && c.localChanged; }), JSON.stringify(res));
        assert.strictEqual(w.metas[WK].head_sha, 'H');
    });
    test('remote-deleted file edited locally is kept (old code: raw delete)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('d.js', 'base'));
        await w.s.setWorkspaceFile(row('k.js', 'base'));
        remote(w, [{ type: 'blob', path: 'k.js', sha: 's-k.js', size: 4 }, { type: 'blob', path: 'n.js', sha: 'rn', size: 6 }], async function() { await edit(w, 'd.js', 'mine', 5); });
        var res = await w.m.wsPull(WK);
        var d = await w.s.getWorkspaceFile(WK, 'd.js');
        assert.ok(d && d.content === 'mine', 'edited row not deleted');
        assert.ok((res.conflicts || []).some(function(c) { return c.path === 'd.js' && c.localChanged; }), JSON.stringify(res));
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'n.js')).content, 'REMOTE', 'new file still pulled');
    });
    test('no race: updates, new files and remote deletes apply and HEAD advances', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('b.js', 'base'));
        await w.s.setWorkspaceFile(row('d.js', 'base'));
        remote(w, [{ type: 'blob', path: 'b.js', sha: 'rb', size: 6 }, { type: 'blob', path: 'n.js', sha: 'rn', size: 6 }]);
        var res = await w.m.wsPull(WK);
        assert.strictEqual(res.conflicts, undefined, JSON.stringify(res));
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'b.js')).content, 'REMOTE');
        assert.strictEqual(await w.s.getWorkspaceFile(WK, 'd.js'), null);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'n.js')).content, 'REMOTE');
        assert.strictEqual(w.metas[WK].head_sha, 'H2');
    });
});

describe('H7: wsPush write-back is CAS against the pre-push snapshot (tools/020)', function() {
    function gh(w, onPr) {
        w.m.__scope.loadGitHubSettings = async function() { return { token: 'tok' }; };
        w.m.__scope._wsCheckCrossChatConflict = function() { return null; };
        w.m.__scope.githubApi = async function(method, url) {
            if (method === 'GET' && /git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H' } } };
            if (method === 'GET' && /git\/ref\/heads\/feat$/.test(url)) return { ok: false, status: 404, body: {} };
            if (method === 'GET' && /git\/commits\//.test(url)) return { ok: true, body: { sha: 'H', tree: { sha: 'T' } } };
            if (method === 'GET' && /git\/trees\//.test(url)) return { ok: true, body: { sha: 'T', tree: [] } };
            if (method === 'POST' && /git\/blobs$/.test(url)) return { ok: true, body: { sha: 'B1' } };
            if (method === 'POST' && /git\/trees$/.test(url)) return { ok: true, body: { sha: 'T2' } };
            if (method === 'POST' && /git\/commits$/.test(url)) return { ok: true, body: { sha: 'C2' } };
            if (method === 'POST' && /git\/refs$/.test(url)) return { ok: true, body: { ref: 'refs/heads/feat', object: { sha: 'C2' } } };
            if (method === 'GET' && /\/pulls/.test(url)) return { ok: true, body: [] };
            if (method === 'POST' && /\/pulls$/.test(url)) { if (onPr) await onPr(); return { ok: true, status: 201, body: { number: 7, html_url: 'https://gh/pr/7', head: { ref: 'feat' }, base: { ref: 'main' }, title: 'T' } }; }
            return { ok: true, body: {} };
        };
    }
    test('edit landing mid-push stays dirty with new content + gets pushed_pr/pushed_shas (old code: reverted to pushed content)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        await edit(w, 'a.js', 'pushed', 1);
        gh(w, async function() { await edit(w, 'a.js', 'newer', 9); });
        var res = await w.m.wsPush(WK, { branch_name: 'feat', commit_message: 'c', pr_title: 'T' }, 'c1', 'C1');
        assert.strictEqual(res.success, true, JSON.stringify(res).slice(0, 400));
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.content, 'newer', 'mid-push edit survives');
        assert.strictEqual(a.dirty, true);
        assert.strictEqual(a.last_modified_by_chat_id, 'c2', 'ownership of the newer edit kept');
        assert.ok(a.pushed_pr && a.pushed_pr.number === 7, 'pushed_pr stamped on retry');
        assert.ok(Array.isArray(a.pushed_shas) && a.pushed_shas.indexOf('B1') !== -1, 'pushed sha stamped');
        assert.ok(res.changed_during_push && res.changed_during_push[0].path === 'a.js' && res.changed_during_push[0].stamped === true, JSON.stringify(res.changed_during_push));
    });
    test('no race: write-back stamps and releases ownership', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        await edit(w, 'a.js', 'pushed', 1);
        gh(w);
        var res = await w.m.wsPush(WK, { branch_name: 'feat', commit_message: 'c', pr_title: 'T' }, 'c1', 'C1');
        assert.strictEqual(res.success, true, JSON.stringify(res).slice(0, 400));
        assert.strictEqual(res.changed_during_push, undefined);
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.content, 'pushed'); assert.strictEqual(a.last_modified_by_chat_id, null);
        assert.ok(a.pushed_pr && a.pushed_pr.number === 7);
    });
});
