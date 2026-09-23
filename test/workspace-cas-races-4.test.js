// Workspace race fixes part 4 (H3 wsWrite CAS loop, H6 wsPull raced propagation,
// H9 atomic merged-branch auto-delete). Fake IDB / wireScope / setup copied from
// test/workspace-cas-races-3.test.js.
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

function tick(ms) { return new Promise(function(r) { setTimeout(r, ms || 5); }); }
function gateFirstRead(w, gate) {
    var reads = 0, real = w.s.getWorkspaceFile;
    w.m.__scope.getWorkspaceFile = async function(repo, path) { var r = await real(repo, path); if (reads++ === 0) await gate.promise; return r; };
}

describe('H3: wsWrite is a CAS loop re-deriving metadata from the fresh row (tools/020)', function() {
    test('pull landing between read and write: fresh sha/original_content, net-zero stays clean (old code: stale sha + stale base, spuriously dirty)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        var gate = deferred(); gateFirstRead(w, gate);
        var p = w.m.wsWrite(WK, 'a.js', 'REMOTE', 'c1', 'C1', false);
        await tick();
        await w.s.setWorkspaceFile(row('a.js', 'REMOTE', { sha: 'rb' })); // concurrent pull
        gate.resolve();
        var res = await p;
        assert.strictEqual(res.success, true, JSON.stringify(res));
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.sha, 'rb', 'old code re-wrote the stale sha s-a.js');
        assert.strictEqual(a.original_content, 'REMOTE');
        assert.strictEqual(a.dirty, false, 'net-zero against the FRESH base');
        assert.strictEqual(a.last_modified_by_chat_id, null);
    });
    test('push write-back landing mid-write: keeps the fresh base + pushed_pr/pushed_shas (old code: reverted to pre-push base, pushed_* dropped)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base', { content: 'X', dirty: true, last_modified_by_chat_id: 'c1', last_modified_at: 1 }));
        var gate = deferred(); gateFirstRead(w, gate);
        var p = w.m.wsWrite(WK, 'a.js', 'Y', 'c1', 'C1', false);
        await tick();
        await w.s.setWorkspaceFile(row('a.js', 'X', { sha: 'px', pushed_pr: { number: 7, url: 'https://gh/pr/7' }, pushed_shas: ['px'] }));
        gate.resolve();
        var res = await p;
        assert.strictEqual(res.success, true, JSON.stringify(res));
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.content, 'Y');
        assert.strictEqual(a.dirty, true);
        assert.strictEqual(a.sha, 'px');
        assert.strictEqual(a.original_content, 'X', 'diff base is the pushed content');
        assert.ok(a.pushed_pr && a.pushed_pr.number === 7, 'pushed_pr kept from the fresh row');
        assert.deepStrictEqual(a.pushed_shas, ['px']);
        assert.strictEqual(a.last_modified_by_chat_id, 'c1');
    });
    test('row removed concurrently: retry creates it as a new file', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        var gate = deferred(); gateFirstRead(w, gate);
        var p = w.m.wsWrite(WK, 'a.js', 'new', 'c1', 'C1', false);
        await tick();
        var cur = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual((await w.s.setWorkspaceFileIf(WK, 'a.js', cur, null)).ok, true);
        gate.resolve();
        var res = await p;
        assert.strictEqual(res.success, true, JSON.stringify(res));
        assert.ok(/^Created/.test(res.message), res.message);
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.content, 'new'); assert.strictEqual(a.dirty, true); assert.strictEqual(a.original_content == null, true);
    });
    test('bounded: WS_CAS_MAX_TRIES conflicts -> concurrent_modification error, nothing written', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        var calls = 0;
        w.m.__scope.setWorkspaceFileIf = async function(repo, path) { calls++; return { ok: false, conflict: true, current: await w.s.getWorkspaceFile(repo, path) }; };
        var res = await w.m.wsWrite(WK, 'a.js', 'Z', 'c1', 'C1', false);
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.concurrent_modification, true, JSON.stringify(res));
        assert.strictEqual(calls, 5);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).content, 'base');
    });
    test('non-conflict CAS failure surfaces the error', async function() {
        var w = await setup();
        w.m.__scope.setWorkspaceFileIf = async function() { return { ok: false, error: 'quota' }; };
        var res = await w.m.wsWrite(WK, 'n.js', 'Z', 'c1', 'C1', false);
        assert.strictEqual(res.success, false);
        assert.ok(/quota/.test(res.error), res.error);
    });
    test('no race: plain write still creates / updates', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        var r1 = await w.m.wsWrite(WK, 'a.js', 'v2', 'c1', 'C1', false);
        assert.strictEqual(r1.success, true); assert.ok(/^Updated/.test(r1.message));
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.content, 'v2'); assert.strictEqual(a.sha, 's-a.js'); assert.strictEqual(a.original_content, 'base'); assert.strictEqual(a.dirty, true);
    });
});

describe('H6: wsPull passes syncResult.raced through (tools/020)', function() {
    function remote(w, tree) {
        w.m.__scope.githubApi = async function(method, url) {
            if (/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H2' } } };
            if (/git\/trees\/H2/.test(url)) return { ok: true, body: { sha: 'T2', tree: tree } };
            if (/git\/blobs\//.test(url)) return { ok: true, body: { content: b64('REMOTE'), encoding: 'base64' } };
            return { ok: false, status: 500, body: {} };
        };
    }
    function raceAfterSyncSnapshot(w) {
        var n = 0, real = w.m.__scope.getAllWorkspaceFiles;
        w.m.__scope.getAllWorkspaceFiles = async function(k) { var rows = await real(k); n++; if (n === 2) await edit(w, 'a.js', 'Y', 2); return rows; };
    }
    test('early "Already up to date" return carries raced (old code: dropped)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        await edit(w, 'a.js', 'X', 1);
        remote(w, [{ type: 'blob', path: 'a.js', sha: await blobSha(w, 'X'), size: 1 }]);
        raceAfterSyncSnapshot(w);
        var res = await w.m.wsPull(WK);
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.pulled, 0);
        assert.deepStrictEqual(res.raced, ['a.js'], JSON.stringify(res));
        assert.ok(/a\.js/.test(res.message), res.message);
        assert.strictEqual(w.metas[WK].head_sha, 'H');
    });
    test('final result carries raced alongside pulled files (old code: dropped)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        await w.s.setWorkspaceFile(row('b.js', 'base'));
        await edit(w, 'a.js', 'X', 1);
        remote(w, [{ type: 'blob', path: 'a.js', sha: await blobSha(w, 'X'), size: 1 }, { type: 'blob', path: 'b.js', sha: 'rb', size: 6 }]);
        raceAfterSyncSnapshot(w);
        var res = await w.m.wsPull(WK);
        assert.strictEqual(res.pulled, 1, JSON.stringify(res));
        assert.deepStrictEqual(res.raced, ['a.js']);
        assert.ok(/HEAD not advanced/.test(res.message), res.message);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'b.js')).content, 'REMOTE');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).content, 'Y', 'raced edit kept');
        assert.strictEqual(w.metas[WK].head_sha, 'H');
    });
    test('no race: no raced key', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('b.js', 'base'));
        remote(w, [{ type: 'blob', path: 'b.js', sha: 'rb', size: 6 }]);
        var res = await w.m.wsPull(WK);
        assert.strictEqual(res.raced, undefined);
        assert.strictEqual(res.pulled, 1);
        assert.strictEqual(w.metas[WK].head_sha, 'H2');
    });
});

var FK = 'o/r::feat';
function frow(path, content, extra) { return Object.assign(row(path, content), { id: FK + '::' + path, repo: FK }, extra || {}); }

describe('H9: deleteWorkspaceIfClean — check + delete in ONE tx over files+meta (core/130)', function() {
    async function seed() {
        var idb = fakeIDB(), s = await loadIdb(idb);
        await s.setWorkspaceMeta({ repo: FK, branch: 'feat' });
        await s.setWorkspaceMeta({ repo: WK, branch: 'main' });
        await s.setWorkspaceFile(frow('a.js', 'base'));
        await s.setWorkspaceFile(frow('c.js', 'base'));
        await s.setWorkspaceFile(row('b.js', 'keep'));
        return { idb: idb, s: s };
    }
    test('clean workspace: file rows + meta removed in a single readwrite tx; other workspaces untouched', async function() {
        var t = await seed();
        t.idb.txLog.length = 0;
        var res = await t.s.deleteWorkspaceIfClean(FK, function() { return false; });
        assert.deepStrictEqual(res, { kept: false, deleted: true, count: 2 });
        var rw = t.idb.txLog.filter(function(x) { return x.mode === 'readwrite'; });
        assert.strictEqual(rw.length, 1, 'old path: 3 separate txs (scan, files delete, meta delete)');
        assert.deepStrictEqual(rw[0].stores, ['workspace_files', 'workspace_meta']);
        assert.strictEqual(await t.s.getWorkspaceMeta(FK), null);
        assert.deepStrictEqual(await t.s.getAllWorkspaceFiles(FK), []);
        assert.ok(await t.s.getWorkspaceMeta(WK));
        assert.strictEqual((await t.s.getWorkspaceFile(WK, 'b.js')).content, 'keep');
    });
    test('dirty or tombstoned row: kept with the dirty paths, NOTHING deleted', async function() {
        var t = await seed();
        await t.s.setWorkspaceFile(frow('a.js', 'base', { content: 'mine', dirty: true }));
        await t.s.setWorkspaceFile(frow('c.js', 'base', { content: '', dirty: true, deleted: true }));
        var res = await t.s.deleteWorkspaceIfClean(FK, null);
        assert.strictEqual(res.kept, true);
        assert.deepStrictEqual(res.dirty.slice().sort(), ['a.js', 'c.js']);
        assert.ok(await t.s.getWorkspaceMeta(FK), 'meta kept');
        assert.strictEqual((await t.s.getWorkspaceFile(FK, 'a.js')).content, 'mine');
    });
    test('ignored dirty rows do not block; a throwing filter is treated as not-ignored (keep)', async function() {
        var t = await seed();
        await t.s.setWorkspaceFile(frow('dist/x.js', 'b', { content: 'built', dirty: true }));
        var res = await t.s.deleteWorkspaceIfClean(FK, function(p) { return p.indexOf('dist/') === 0; });
        assert.strictEqual(res.deleted, true);
        assert.deepStrictEqual(await t.s.getAllWorkspaceFiles(FK), []);
        var t2 = await seed();
        await t2.s.setWorkspaceFile(frow('dist/x.js', 'b', { content: 'built', dirty: true }));
        var res2 = await t2.s.deleteWorkspaceIfClean(FK, function() { throw new Error('bad filter'); });
        assert.strictEqual(res2.kept, true);
        assert.deepStrictEqual(res2.dirty, ['dist/x.js']);
    });
});

describe('H9: wsMaybeAutoDeleteMerged uses the atomic delete (tools/020)', function() {
    async function setupMerged(legacy) {
        var idb = fakeIDB(), s = await loadIdb(idb);
        var m = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        wireScope(m, s, {});
        var sc = m.__scope;
        sc.getWorkspaceMeta = s.getWorkspaceMeta; sc.setWorkspaceMeta = s.setWorkspaceMeta; sc.getAllWorkspaceMetas = s.getAllWorkspaceMetas;
        sc.deleteWorkspaceFiles = s.deleteWorkspaceFiles; sc.deleteWorkspaceMeta = s.deleteWorkspaceMeta;
        sc.deleteWorkspaceIfClean = legacy ? undefined : s.deleteWorkspaceIfClean;
        sc.gcWorkspaceBlobs = function() {};
        sc.wsSyncWithRemote = async function() { return { behind: false }; };
        sc.setWorkspacePin = async function() { return { success: true }; };
        sc.githubApi = async function(method, url) {
            if (/\/pulls\?/.test(url)) return { ok: true, body: [{ state: 'closed', merged_at: '2026-09-01T00:00:00Z', number: 5, html_url: 'https://gh/pr/5', base: { ref: 'main' } }] };
            if (/\/repos\/o\/r$/.test(url)) return { ok: true, body: { default_branch: 'main' } };
            return { ok: false, status: 404, body: {} };
        };
        await s.setWorkspaceMeta({ repo: WK, branch: 'main', github_repo: 'o/r', head_sha: 'H' });
        await s.setWorkspaceMeta({ repo: FK, branch: 'feat', github_repo: 'o/r', head_sha: 'H' });
        await s.setWorkspaceFile(frow('a.js', 'base'));
        return { idb: idb, s: s, m: m, sc: sc };
    }
    async function lateEdit(w) { var cur = await w.s.getWorkspaceFile(FK, 'a.js'); await w.s.setWorkspaceFile(Object.assign({}, cur, { content: 'mine', dirty: true, last_modified_by_chat_id: 'c2', last_modified_at: 9 })); }
    test('clean merged fork: deleted (files + meta)', async function() {
        var w = await setupMerged(false);
        var res = await w.m.wsMaybeAutoDeleteMerged(FK, await w.s.getWorkspaceMeta(FK));
        assert.strictEqual(res && res.deleted, true, JSON.stringify(res));
        assert.strictEqual(await w.s.getWorkspaceMeta(FK), null);
        assert.deepStrictEqual(await w.s.getAllWorkspaceFiles(FK), []);
        assert.ok(await w.s.getWorkspaceMeta(WK), 'base kept');
    });
    test('BEFORE (legacy non-atomic path): an edit landing after the final re-scan is swept by the delete', async function() {
        var w = await setupMerged(true);
        // Dry run on a twin counts the legacy path's scans; the edit is then
        // injected right after the LAST one (the _late2 re-scan).
        var dry = await setupMerged(true), dn = 0, dreal = dry.sc.getAllWorkspaceFiles;
        dry.sc.getAllWorkspaceFiles = async function(k) { dn++; return dreal(k); };
        await dry.m.wsMaybeAutoDeleteMerged(FK, await dry.s.getWorkspaceMeta(FK));
        var LAST = dn;
        var n = 0, real = w.sc.getAllWorkspaceFiles;
        w.sc.getAllWorkspaceFiles = async function(k) { var rows = await real(k); n++; if (n === LAST) await lateEdit(w); return rows; };
        var res = await w.m.wsMaybeAutoDeleteMerged(FK, await w.s.getWorkspaceMeta(FK));
        assert.ok(LAST >= 3 && n === LAST, 'initial scan + late re-scans; n=' + n + ' LAST=' + LAST);
        assert.strictEqual(res && res.deleted, true);
        assert.strictEqual(await w.s.getWorkspaceFile(FK, 'a.js'), null, 'the late edit was lost \u2014 the H9 bug');
    });
    test('AFTER: the same late edit (after every JS-side scan, right before the delete) keeps the workspace with late_dirty', async function() {
        var w = await setupMerged(false);
        var realDel = w.s.deleteWorkspaceIfClean, calls = 0;
        w.sc.deleteWorkspaceIfClean = async function(k, f) { calls++; await lateEdit(w); return realDel(k, f); };
        var res = await w.m.wsMaybeAutoDeleteMerged(FK, await w.s.getWorkspaceMeta(FK));
        assert.strictEqual(calls, 1);
        assert.strictEqual(res.deleted, false); assert.strictEqual(res.kept, true);
        assert.deepStrictEqual(res.late_dirty, ['a.js'], JSON.stringify(res));
        assert.ok(/modified during the merge cleanup/.test(res.warning), res.warning);
        assert.strictEqual((await w.s.getWorkspaceFile(FK, 'a.js')).content, 'mine');
        assert.ok(await w.s.getWorkspaceMeta(FK), 'meta kept');
    });
    test('AFTER: a truly concurrent wsEdit is never silently lost (kept with the edit, or the edit reports failure)', async function() {
        var w = await setupMerged(false);
        var realDel = w.s.deleteWorkspaceIfClean, pEdit = null;
        w.sc.deleteWorkspaceIfClean = function(k, f) { pEdit = w.m.wsEdit(FK, 'a.js', [{ find: 'base', replace: 'mine' }], 'c2', 'C2', false); return realDel(k, f); };
        var res = await w.m.wsMaybeAutoDeleteMerged(FK, await w.s.getWorkspaceMeta(FK));
        var e = await pEdit;
        var row2 = await w.s.getWorkspaceFile(FK, 'a.js');
        if (res.deleted) {
            assert.strictEqual(e.success, false, 'edit after the delete must fail loudly: ' + JSON.stringify(e));
            assert.strictEqual(row2, null);
            assert.strictEqual(await w.s.getWorkspaceMeta(FK), null);
        } else {
            assert.strictEqual(e.success, true, JSON.stringify(e));
            assert.strictEqual(row2.content, 'mine');
            assert.deepStrictEqual(res.late_dirty, ['a.js']);
        }
    });
    test('delete failure: nothing removed, workspace kept with a warning', async function() {
        var w = await setupMerged(false);
        w.sc.deleteWorkspaceIfClean = async function() { throw new Error('tx aborted'); };
        var res = await w.m.wsMaybeAutoDeleteMerged(FK, await w.s.getWorkspaceMeta(FK));
        assert.strictEqual(res.kept, true); assert.ok(/tx aborted/.test(res.warning));
        assert.ok(await w.s.getWorkspaceMeta(FK));
    });
});
