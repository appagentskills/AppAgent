// Stale workspace base after a merged PR (#1022 incident):
// (a) sync 3-way-rebases a dirty file whose remote blob is not in pushed_shas,
// (b) scoped push ignores conflicts outside args.files, (c) discard restores the
// REMOTE blob when the remote moved on, (d) sync autoPull fast-forwards clean
// behind files. Helpers copied from test/workspace-cas-races-3.test.js.
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

function api(w, map) {
    w.m.__scope.githubApi = async function(method, url) {
        for (var k in map) { if (new RegExp(k).test(url)) { var v = map[k]; return typeof v === 'function' ? v(method, url) : v; } }
        return { ok: false, status: 500, body: {} };
    };
}
var BASE = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';

describe('_wsMerge3 line 3-way merge (tools/020)', function() {
    test('non-overlapping edits merge cleanly; identical edits count as shared', async function() {
        var w = await setup();
        var r = w.m._wsMerge3(BASE, BASE.replace('l2', 'OURS'), BASE.replace('l7', 'THEIRS'));
        assert.strictEqual(r.clean, true);
        assert.strictEqual(r.content, BASE.replace('l2', 'OURS').replace('l7', 'THEIRS'));
        assert.strictEqual(r.shared, 0);
        var s = w.m._wsMerge3(BASE, BASE.replace('l2', 'X'), BASE.replace('l2', 'X').replace('l8', 'Y'));
        assert.strictEqual(s.clean, true); assert.strictEqual(s.shared, 1);
        assert.strictEqual(s.content, BASE.replace('l2', 'X').replace('l8', 'Y'));
    });
    test('overlapping different edits conflict', async function() {
        var w = await setup();
        var r = w.m._wsMerge3(BASE, BASE.replace('l4', 'A'), BASE.replace('l4', 'B'));
        assert.strictEqual(r.clean, false);
    });
    test('insertions/deletions on both sides', async function() {
        var w = await setup();
        var ours = BASE.replace('l1\n', '').replace('l3\n', 'l3\nNEW\n');
        var theirs = BASE.replace('l8\n', 'l8\nTAIL\n').replace('l6\n', '');
        var r = w.m._wsMerge3(BASE, ours, theirs);
        assert.strictEqual(r.clean, true);
        assert.strictEqual(r.content, 'l2\nl3\nNEW\nl4\nl5\nl7\nl8\nTAIL\n');
    });
});

describe('(a) wsSyncWithRemote adopts a merged remote base via 3-way merge (tools/020)', function() {
    test('pushed file, remote = our change + upstream edit, pushed_shas lost -> rebased clean, PR stamped merged, HEAD advances', async function() {
        var w = await setup();
        var ours = BASE.replace('l2', 'OURS');
        var remote = ours.replace('l7', 'UP');
        var pr = { number: 1022, url: 'u/1022', branch: 'fix/x' };
        w.metas[WK].prs = [{ number: 1022, url: 'u/1022', branch: 'fix/x', state: 'open' }];
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: ours, dirty: true, pushed_pr: pr, pushed_shas: null }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            '/repos/o/r/pulls/1022$': { ok: true, body: { number: 1022, merged: true, merged_at: '2026-01-01T00:00:00Z' } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1', size: 1 }] } },
            'git/blobs/R1': { ok: true, body: { content: b64(remote), encoding: 'base64' } } });
        var res = await w.m.wsSyncWithRemote(WK);
        assert.deepStrictEqual(res.conflictFiles, []);
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.sha, 'R1'); assert.strictEqual(f.original_content, remote);
        assert.strictEqual(f.content, remote); assert.strictEqual(f.dirty, false);
        assert.strictEqual(f.pushed_pr, null);
        assert.strictEqual(w.metas[WK].prs[0].state, 'merged');
        assert.strictEqual(w.metas[WK].head_sha, 'H2');
    });
    test('extra local edits on top stay dirty against the NEW base', async function() {
        var w = await setup();
        var pushed = BASE.replace('l2', 'OURS');
        var local = pushed.replace('l5', 'MORE');
        var remote = pushed.replace('l8', 'UP');
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: local, dirty: true, pushed_pr: { number: 7, url: 'u/7', branch: 'b' } }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/R1': { ok: true, body: { content: b64(remote), encoding: 'base64' } },
            '/repos/o/r/pulls/7$': { ok: true, body: { number: 7, merged: true, merged_at: '2026-01-01T00:00:00Z' } } });
        var res = await w.m.wsSyncWithRemote(WK);
        assert.deepStrictEqual(res.conflictFiles, []);
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.sha, 'R1'); assert.strictEqual(f.original_content, remote);
        assert.strictEqual(f.content, remote.replace('l5', 'MORE')); assert.strictEqual(f.dirty, true);
        assert.strictEqual(f.pushed_pr, null, 'API-confirmed merge clears pushed_pr');
    });
    test('foreign upstream change on an unpushed file with no shared change stays a conflict', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: BASE.replace('l2', 'MINE'), dirty: true }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/R1': { ok: true, body: { content: b64(BASE.replace('l7', 'UP')), encoding: 'base64' } } });
        var res = await w.m.wsSyncWithRemote(WK);
        assert.strictEqual(res.conflictFiles.length, 1);
        assert.strictEqual(res.conflictFiles[0].reason, 'not_ours');
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.sha, 's-t.js'); assert.strictEqual(f.dirty, true);
        assert.strictEqual(w.metas[WK].head_sha, 'H');
    });
    test('overlapping conflicting edits stay a conflict (never auto-resolved)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: BASE.replace('l4', 'A'), dirty: true, pushed_pr: { number: 7, url: 'u/7', branch: 'b' } }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/R1': { ok: true, body: { content: b64(BASE.replace('l4', 'B')), encoding: 'base64' } } });
        var res = await w.m.wsSyncWithRemote(WK);
        assert.strictEqual(res.conflictFiles[0].reason, 'merge_conflict');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 't.js')).content, BASE.replace('l4', 'A'));
    });
});

describe('(b) wsPush filters sync conflicts to the args.files allowlist (tools/020)', function() {
    async function stubPush(w) {
        w.m.__scope.loadGitHubSettings = async function() { return { token: 't' }; };
        // other.js: dirty, never pushed, remote changed by someone else -> real sync conflict
        await w.s.setWorkspaceFile(row('other.js', BASE, { content: BASE.replace('l2', 'MINE'), dirty: true }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'other.js', sha: 'R9' }, { type: 'blob', path: 'mine.js', sha: 's-mine.js' }] } },
            'git/blobs/R9': { ok: true, body: { content: b64(BASE.replace('l7', 'UP')), encoding: 'base64' } } });
    }
    test('conflict on a non-listed file does not block the scoped push', async function() {
        var w = await setup(); await stubPush(w);
        await w.s.setWorkspaceFile(row('mine.js', 'a', { content: 'b', dirty: true }));
        var res = await w.m.wsPush(WK, { branch_name: 'fix/y', commit_message: 'm', pr_title: 't', files: ['mine.js'] }, 'c1', 'chat');
        assert.ok(!/conflicting remote changes/.test(res.error || ''), 'not rejected by the unrelated conflict: ' + res.error);
    });
    test('conflict on a listed file (or unscoped push) still blocks', async function() {
        var w = await setup(); await stubPush(w);
        var r1 = await w.m.wsPush(WK, { branch_name: 'fix/y', commit_message: 'm', pr_title: 't', files: ['other.js'] }, 'c1', 'chat');
        assert.ok(/conflicting remote changes/.test(r1.error), 'r1: ' + r1.error);
        var r2 = await w.m.wsPush(WK, { branch_name: 'fix/y', commit_message: 'm', pr_title: 't' }, 'c1', 'chat');
        assert.ok(/conflicting remote changes/.test(r2.error));
    });
});

describe('(c) wsDiscard never restores a base the remote moved past (tools/020)', function() {
    test('remoteCheck: restores the remote blob and updates sha', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', 'old', { content: 'edit', dirty: true }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/R1': { ok: true, body: { content: b64('merged'), encoding: 'base64' } } });
        var res = await w.m.wsDiscard(WK, 't.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.files[0].action, 'restored_to_remote');
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.content, 'merged'); assert.strictEqual(f.original_content, 'merged');
        assert.strictEqual(f.sha, 'R1'); assert.strictEqual(f.dirty, false);
    });
    test('remoteCheck: blob fetch failure refuses instead of restoring stale content', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', 'old', { content: 'edit', dirty: true }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } } });
        var res = await w.m.wsDiscard(WK, 't.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(res.success, false); assert.ok(/remote ahead/.test(res.error));
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.content, 'edit'); assert.strictEqual(f.dirty, true);
    });
    test('remote unchanged: restores original_content as before', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', 'old', { content: 'edit', dirty: true }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 's-t.js' }] } } });
        var res = await w.m.wsDiscard(WK, 't.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(res.files[0].action, 'restored');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 't.js')).content, 'old');
    });
});

describe('(d) wsSyncWithRemote autoPull fast-forwards clean behind files (tools/020)', function() {
    test('autoPull downloads the clean behind file, keeps the dirty one, advances HEAD', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('clean.js', 'c-old'));
        await w.s.setWorkspaceFile(row('dirty.js', 'd', { content: 'd-edit', dirty: true }));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'clean.js', sha: 'C2' }, { type: 'blob', path: 'dirty.js', sha: 's-dirty.js' }] } },
            'git/blobs/C2': { ok: true, body: { content: b64('c-new'), encoding: 'base64' } } });
        var res = await w.m.wsSyncWithRemote(WK, { autoPull: true });
        assert.strictEqual(res.auto_pulled, 1);
        assert.strictEqual(res.behind, false);
        assert.strictEqual((res.behindFiles || []).length, 0);
        var c = await w.s.getWorkspaceFile(WK, 'clean.js');
        assert.strictEqual(c.content, 'c-new'); assert.strictEqual(c.sha, 'C2');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'dirty.js')).content, 'd-edit');
        assert.strictEqual(w.metas[WK].head_sha, 'H2');
    });
    test('default (no autoPull) only lists behind files; noAutoPull wins', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('clean.js', 'c-old'));
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H2' } } },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'clean.js', sha: 'C2' }] } },
            'git/blobs/C2': { ok: true, body: { content: b64('c-new'), encoding: 'base64' } } });
        var r1 = await w.m.wsSyncWithRemote(WK);
        var r2 = await w.m.wsSyncWithRemote(WK, { autoPull: true, noAutoPull: true });
        assert.strictEqual(r1.behindFiles.length, 1); assert.strictEqual(r2.behindFiles.length, 1);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'clean.js')).content, 'c-old');
    });
});

var REF_H2 = { ok: true, body: { object: { sha: 'H2' } } };
describe('(e) review follow-ups: fail-closed discard (tools/020)', function() {
    test('ref fetch failure: single discard REFUSES (never restores original_content)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', 'old', { content: 'edit', dirty: true }));
        api(w, { 'git/ref/heads/main$': { ok: false, status: 500, body: {} } });
        var res = await w.m.wsDiscard(WK, 't.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(res.success, false); assert.strictEqual(res.unverified, true);
        assert.ok(/couldn't verify remote/.test(res.error) && /click \u21bb sync on the workspace, then discard again/.test(res.error), res.error);
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.content, 'edit'); assert.strictEqual(f.dirty, true);
    });
    test('tree fetch failure and truncated tree both refuse', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', 'old', { content: 'edit', dirty: true }));
        api(w, { 'git/ref/heads/main$': REF_H2, 'git/trees/H2': { ok: false, status: 502, body: {} } });
        var r1 = await w.m.wsDiscard(WK, 't.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(r1.success, false); assert.strictEqual(r1.unverified, true);
        api(w, { 'git/ref/heads/main$': REF_H2, 'git/trees/H2': { ok: true, body: { sha: 'T2', truncated: true, tree: [{ type: 'blob', path: 't.js', sha: 's-t.js' }] } } });
        var r2 = await w.m.wsDiscard(WK, 't.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(r2.success, false); assert.strictEqual(r2.unverified, true);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 't.js')).content, 'edit');
    });
    test('discard-all skips unverifiable files and reports them; new files still removed', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'old', { content: 'edit', dirty: true }));
        await w.s.setWorkspaceFile(row('n.js', null, { sha: null, content: 'new', original_content: null, dirty: true }));
        api(w, { 'git/ref/heads/main$': { ok: false, status: 500, body: {} } });
        var res = await w.m.wsDiscard(WK, null, 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(res.unverified, ['a.js']);
        assert.ok(/couldn't verify remote/.test(res.message), res.message);
        assert.strictEqual(res.discarded, 1);
        assert.strictEqual(await w.s.getWorkspaceFile(WK, 'n.js'), null);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).content, 'edit');
    });
    test('path deleted on the remote: single refuses, discard-all skips + reports', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('gone.js', 'old', { content: 'edit', dirty: true }));
        await w.s.setWorkspaceFile(row('kept.js', 'k0', { content: 'k1', dirty: true }));
        api(w, { 'git/ref/heads/main$': REF_H2, 'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'kept.js', sha: 's-kept.js' }] } } });
        var r1 = await w.m.wsDiscard(WK, 'gone.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(r1.success, false); assert.strictEqual(r1.remote_deleted, true);
        assert.ok(/no longer exists on the remote/.test(r1.error), r1.error);
        var r2 = await w.m.wsDiscard(WK, null, 'c1', 'chat', false, { remoteCheck: true });
        assert.deepStrictEqual(r2.remote_deleted, ['gone.js']);
        assert.strictEqual(r2.files.length, 1); assert.strictEqual(r2.files[0].path, 'kept.js');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'gone.js')).content, 'edit');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'kept.js')).content, 'k0');
    });
});

describe('(f) review follow-ups: landing evidence, races, merge3 edges (tools/020)', function() {
    test('partial shared hunk + open PR: NOT adopted, NOT stamped merged (pr_not_merged)', async function() {
        var w = await setup();
        var local = BASE.replace('l2', 'OURS').replace('l5', 'MORE');
        var remote = BASE.replace('l2', 'OURS').replace('l8', 'UP');
        w.metas[WK].prs = [{ number: 7, url: 'u/7', branch: 'b', state: 'open' }];
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: local, dirty: true, pushed_pr: { number: 7, url: 'u/7', branch: 'b' } }));
        var prCalls = 0;
        api(w, { 'git/ref/heads/main$': REF_H2,
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/R1': { ok: true, body: { content: b64(remote), encoding: 'base64' } },
            '/repos/o/r/pulls/7$': function() { prCalls++; return { ok: true, body: { number: 7, state: 'open', merged: false, merged_at: null } }; } });
        var res = await w.m.wsSyncWithRemote(WK);
        assert.strictEqual(prCalls, 1, 'PR state looked up via the API');
        assert.strictEqual(res.conflictFiles.length, 1); assert.strictEqual(res.conflictFiles[0].reason, 'pr_not_merged');
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.sha, 's-t.js'); assert.strictEqual(f.content, local);
        assert.strictEqual(f.pushed_pr.number, 7);
        assert.strictEqual(w.metas[WK].prs[0].state, 'open');
        assert.strictEqual(w.metas[WK].head_sha, 'H');
    });
    test('partial shared hunk on an unpushed file stays a conflict (not_ours)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: BASE.replace('l2', 'X').replace('l5', 'MORE'), dirty: true }));
        api(w, { 'git/ref/heads/main$': REF_H2,
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/R1': { ok: true, body: { content: b64(BASE.replace('l2', 'X')), encoding: 'base64' } } });
        var res = await w.m.wsSyncWithRemote(WK);
        assert.strictEqual(res.conflictFiles[0].reason, 'not_ours');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 't.js')).sha, 's-t.js');
    });
    test('CAS race in the 3-way merge path: concurrent edit kept, raced, no stamp, HEAD stays', async function() {
        var w = await setup();
        var ours = BASE.replace('l2', 'OURS'), remote = ours.replace('l7', 'UP');
        w.metas[WK].prs = [{ number: 9, url: 'u/9', branch: 'fix/z', state: 'open' }];
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: ours, dirty: true, pushed_pr: { number: 9, url: 'u/9', branch: 'fix/z' } }));
        api(w, { 'git/ref/heads/main$': REF_H2,
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/R1': async function() { await edit(w, 't.js', 'CONCURRENT', 5); return { ok: true, body: { content: b64(remote), encoding: 'base64' } }; } });
        var res = await w.m.wsSyncWithRemote(WK);
        assert.deepStrictEqual(res.raced, ['t.js']);
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.content, 'CONCURRENT'); assert.strictEqual(f.sha, 's-t.js');
        assert.strictEqual(w.metas[WK].prs[0].state, 'open');
        assert.strictEqual(w.metas[WK].head_sha, 'H');
    });
    test('merge3 preserves CRLF line endings and handles empty files', async function() {
        var w = await setup();
        var base = 'a\r\nb\r\nc\r\nd\r\n';
        var r = w.m._wsMerge3(base, base.replace('a\r', 'A\r'), base.replace('d\r', 'D\r'));
        assert.strictEqual(r.clean, true); assert.strictEqual(r.content, 'A\r\nb\r\nc\r\nD\r\n');
        assert.strictEqual(w.m._wsMerge3(base, base.replace('b\r', 'X\r'), base.replace('b\r\n', 'b\n')).clean, false, 'EOL-only change vs edit on the same line conflicts');
        assert.deepStrictEqual(w.m._wsMerge3('', 'x\n', ''), { clean: true, content: 'x\n', shared: 0 });
        assert.deepStrictEqual(w.m._wsMerge3('', '', 'y\n'), { clean: true, content: 'y\n', shared: 0 });
        assert.strictEqual(w.m._wsMerge3('', 'x\n', 'y\n').clean, false);
        var e = w.m._wsMerge3('keep\n', '', 'keep\nmore\n');
        assert.strictEqual(e.clean, false, 'local truncation vs remote append conflicts');
    });
    test('cap fallback: a large rewrite returns null / conflict instead of a huge trace', async function() {
        var w = await setup();
        var a = [], b = [], c = [];
        for (var i = 0; i < 2500; i++) { a.push('base' + i); b.push('ours' + i); c.push('theirs' + i); }
        assert.strictEqual(w.m._wsLineHunks(a, b), null, 'default cap (2000) exceeded');
        assert.strictEqual(w.m._wsLineHunks(a.slice(0, 20), b.slice(0, 20), 5), null, 'explicit cap');
        assert.deepStrictEqual(w.m._wsLineHunks(['x', 'y', 'z'], ['x', 'Y', 'z'], 5), [{ bs: 1, be: 2, os: 1, oe: 2 }]);
        var t0 = Date.now();
        var r = w.m._wsMerge3(a.join('\n'), b.join('\n'), c.join('\n'));
        assert.strictEqual(r.clean, false);
        assert.ok(Date.now() - t0 < 10000, 'bounded time');
    });
});

describe('(g) review follow-ups: pushed_shas retry loop + read-only status (tools/020)', function() {
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
    function raceCas(w, times) {
        var sc = w.m.__scope, orig = sc.setWorkspaceFileIf, st = { armed: false, injected: 0, calls: 0 };
        sc.setWorkspaceFileIf = async function(repo, path, expected, newRow) {
            if (st.armed && path === 'a.js') {
                st.calls++;
                if (st.injected < times) { st.injected++; await edit(w, 'a.js', 'e' + st.injected, 10 + st.injected); }
            }
            return orig(repo, path, expected, newRow);
        };
        return st;
    }
    test('retry loop stamps pushed_shas after repeated lost CAS races', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        await edit(w, 'a.js', 'pushed', 1);
        var st = raceCas(w, 2);
        gh(w, async function() { st.armed = true; });
        var res = await w.m.wsPush(WK, { branch_name: 'feat', commit_message: 'c', pr_title: 'T' }, 'c1', 'C1');
        assert.strictEqual(res.success, true, JSON.stringify(res).slice(0, 300));
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.content, 'e2'); assert.strictEqual(a.dirty, true);
        assert.ok(a.pushed_pr && a.pushed_pr.number === 7);
        assert.ok(a.pushed_shas && a.pushed_shas.indexOf('B1') !== -1);
        assert.strictEqual(st.calls, 3, 'write-back + 2 retries');
        assert.strictEqual(res.changed_during_push[0].stamped, true);
    });
    test('retry loop is bounded (3 retries) and reports stamped:false', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        await edit(w, 'a.js', 'pushed', 1);
        var st = raceCas(w, 99);
        gh(w, async function() { st.armed = true; });
        var res = await w.m.wsPush(WK, { branch_name: 'feat', commit_message: 'c', pr_title: 'T' }, 'c1', 'C1');
        assert.strictEqual(st.calls, 4, 'write-back + 3 retries, then give up');
        assert.strictEqual(res.changed_during_push[0].stamped, false);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).content, 'e4');
    });
    test('wsStatus performs NO writes (no auto-pull / rebase / clean-mark) and reports pending_rebase', async function() {
        var w = await setup();
        var ours = BASE.replace('l2', 'OURS');
        await w.s.setWorkspaceFile(row('clean.js', 'c-old'));
        await w.s.setWorkspaceFile(row('same.js', 'x0', { content: 'x1', dirty: true }));
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: ours, dirty: true, pushed_pr: { number: 3, url: 'u/3', branch: 'b' } }));
        var x1Sha = await blobSha(w, 'x1');
        api(w, { 'git/ref/heads/main$': REF_H2,
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'clean.js', sha: 'C2' }, { type: 'blob', path: 'same.js', sha: x1Sha }, { type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/C2': { ok: true, body: { content: b64('c-new'), encoding: 'base64' } },
            'git/blobs/R1': { ok: true, body: { content: b64(ours.replace('l7', 'UP')), encoding: 'base64' } } });
        var sc = w.m.__scope, writes = [];
        ['setWorkspaceFileIf', 'setWorkspaceFile', 'setWorkspaceMeta', 'deleteWorkspaceFiles', 'deleteWorkspaceMeta', 'wsPull'].forEach(function(n) {
            var o = sc[n];
            sc[n] = async function() { writes.push(n); return o ? o.apply(null, arguments) : undefined; };
        });
        var snap = JSON.stringify(await w.s.getAllWorkspaceFiles(WK));
        var res = await w.m.wsStatus(WK, false, 'c1');
        assert.deepStrictEqual(writes, [], 'no writes: ' + writes.join(','));
        assert.strictEqual(JSON.stringify(await w.s.getAllWorkspaceFiles(WK)), snap, 'rows untouched');
        assert.strictEqual(w.metas[WK].head_sha, 'H');
        assert.ok(res.behind_files && res.behind_files.some(function(b) { return b.path === 'clean.js'; }), JSON.stringify(res).slice(0, 300));
        var pend = (res.pending_rebase || []).map(function(p) { return p.path + ':' + p.reason; }).sort();
        assert.deepStrictEqual(pend, ['same.js:matches_remote', 't.js:rebase_available']);
    });
});

describe('(h) #1027 review follow-ups: upstream deletions, read-only diff, re-sync failure, unconfirmed exact match (tools/020)', function() {
    function spyWrites(w) {
        var sc = w.m.__scope, writes = [];
        ['setWorkspaceFileIf', 'setWorkspaceFile', 'setWorkspaceMeta', 'deleteWorkspaceFiles', 'deleteWorkspaceMeta', 'wsPull'].forEach(function(n) {
            var o = sc[n];
            sc[n] = async function() { writes.push(n); return o ? o.apply(null, arguments) : undefined; };
        });
        return writes;
    }
    // gone.js: dirty + tracked, deleted upstream (the ONLY remote change);
    // kept.js: clean, unchanged; n.js: new local file (never on the remote).
    async function seedGone(w) {
        await w.s.setWorkspaceFile(row('gone.js', 'old', { content: 'edit', dirty: true }));
        await w.s.setWorkspaceFile(row('kept.js', 'k'));
        await w.s.setWorkspaceFile(row('n.js', null, { sha: null, content: 'new', original_content: null, dirty: true }));
        api(w, { 'git/ref/heads/main$': REF_H2,
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'kept.js', sha: 's-kept.js' }] } } });
    }
    var GONE = [{ path: 'gone.js', remoteSha: null, reason: 'remote_deleted' }];
    test('sync: dirty tracked file deleted upstream (only remote change) -> remote_deleted conflict, rows untouched, HEAD stays', async function() {
        var w = await setup(); await seedGone(w);
        var snap = JSON.stringify(await w.s.getAllWorkspaceFiles(WK));
        var res = await w.m.wsSyncWithRemote(WK);
        assert.deepStrictEqual(res.conflictFiles, GONE, 'only the tracked file is flagged (new n.js is not)');
        assert.strictEqual(res.behind, true);
        assert.strictEqual(JSON.stringify(await w.s.getAllWorkspaceFiles(WK)), snap, 'rows untouched');
        assert.strictEqual(w.metas[WK].head_sha, 'H', 'HEAD never advances past the deletion');
    });
    test('sync readOnly: the same upstream deletion is reported with NO writes', async function() {
        var w = await setup(); await seedGone(w);
        var snap = JSON.stringify(await w.s.getAllWorkspaceFiles(WK));
        var writes = spyWrites(w);
        var res = await w.m.wsSyncWithRemote(WK, { readOnly: true });
        assert.deepStrictEqual(writes, [], 'no writes: ' + writes.join(','));
        assert.deepStrictEqual(res.conflictFiles, GONE);
        assert.strictEqual(JSON.stringify(await w.s.getAllWorkspaceFiles(WK)), snap, 'rows untouched');
        assert.strictEqual(w.metas[WK].head_sha, 'H');
    });
    // Remote head == meta.head_sha: the removed up-to-date shortcut must not
    // skip the tree check (the tree is fetched at H itself).
    function atOwnHead(w, tree, calls) {
        api(w, { 'git/ref/heads/main$': { ok: true, body: { object: { sha: 'H' } } },
            'git/trees/H\\?': function() { calls.tree++; return { ok: true, body: { sha: 'T', tree: tree } }; } });
    }
    test('discard at own head: path missing from the tree at H -> remote_deleted refusal, edits kept', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('gone.js', 'old', { content: 'edit', dirty: true }));
        var calls = { tree: 0 };
        atOwnHead(w, [{ type: 'blob', path: 'other.js', sha: 's-other.js' }], calls);
        var res = await w.m.wsDiscard(WK, 'gone.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(calls.tree, 1, 'tree fetched at H (no up-to-date shortcut)');
        assert.strictEqual(res.success, false); assert.strictEqual(res.remote_deleted, true);
        assert.ok(/no longer exists on the remote/.test(res.error) && /workspace delete/.test(res.error), res.error);
        var f = await w.s.getWorkspaceFile(WK, 'gone.js');
        assert.strictEqual(f.content, 'edit'); assert.strictEqual(f.dirty, true); assert.strictEqual(f.original_content, 'old');
    });
    test('discard at own head: path in the tree at H with the same sha -> restored', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('t.js', 'old', { content: 'edit', dirty: true }));
        var calls = { tree: 0 };
        atOwnHead(w, [{ type: 'blob', path: 't.js', sha: 's-t.js' }], calls);
        var res = await w.m.wsDiscard(WK, 't.js', 'c1', 'chat', false, { remoteCheck: true });
        assert.strictEqual(calls.tree, 1);
        assert.strictEqual(res.success, true); assert.strictEqual(res.files[0].action, 'restored');
        var f = await w.s.getWorkspaceFile(WK, 't.js');
        assert.strictEqual(f.content, 'old'); assert.strictEqual(f.dirty, false); assert.strictEqual(f.sha, 's-t.js');
    });
    test('wsDiff performs NO writes and passes through pending_rebase + conflict_files', async function() {
        var w = await setup();
        var ours = BASE.replace('l2', 'OURS');
        await w.s.setWorkspaceFile(row('clean.js', 'c-old'));
        await w.s.setWorkspaceFile(row('same.js', 'x0', { content: 'x1', dirty: true }));
        await w.s.setWorkspaceFile(row('t.js', BASE, { content: ours, dirty: true, pushed_pr: { number: 3, url: 'u/3', branch: 'b' } }));
        await w.s.setWorkspaceFile(row('gone.js', 'old', { content: 'edit', dirty: true }));
        var x1Sha = await blobSha(w, 'x1');
        api(w, { 'git/ref/heads/main$': REF_H2,
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'clean.js', sha: 'C2' }, { type: 'blob', path: 'same.js', sha: x1Sha }, { type: 'blob', path: 't.js', sha: 'R1' }] } },
            'git/blobs/C2': { ok: true, body: { content: b64('c-new'), encoding: 'base64' } },
            'git/blobs/R1': { ok: true, body: { content: b64(ours.replace('l7', 'UP')), encoding: 'base64' } } });
        var snap = JSON.stringify(await w.s.getAllWorkspaceFiles(WK));
        var writes = spyWrites(w);
        var res = await w.m.wsDiff(WK, null, false, 'c1');
        assert.deepStrictEqual(writes, [], 'no writes: ' + writes.join(','));
        assert.strictEqual(JSON.stringify(await w.s.getAllWorkspaceFiles(WK)), snap, 'rows untouched');
        assert.strictEqual(w.metas[WK].head_sha, 'H');
        assert.strictEqual(res.success, true, JSON.stringify(res).slice(0, 300));
        assert.deepStrictEqual(res.diffs.map(function(d) { return d.path; }).sort(), ['gone.js', 'same.js', 't.js']);
        var pend = (res.pending_rebase || []).map(function(p) { return p.path + ':' + p.reason; }).sort();
        assert.deepStrictEqual(pend, ['same.js:matches_remote', 't.js:rebase_available']);
        assert.deepStrictEqual((res.conflict_files || []).map(function(c) { return c.path + ':' + c.reason; }), ['gone.js:remote_deleted']);
    });
    test('autoPull: a failed follow-up re-sync returns an explicit unverified state, not the stale pre-pull result', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('clean.js', 'c-old'));
        var refCalls = 0;
        api(w, { 'git/ref/heads/main$': function() { refCalls++; return refCalls === 1 ? REF_H2 : { ok: false, status: 500, body: {} }; },
            'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'clean.js', sha: 'C2' }] } },
            'git/blobs/C2': { ok: true, body: { content: b64('c-new'), encoding: 'base64' } } });
        var res = await w.m.wsSyncWithRemote(WK, { autoPull: true });
        assert.strictEqual(refCalls, 2, 'initial sync + the follow-up re-sync');
        assert.strictEqual(res.resync_failed, true, JSON.stringify(res).slice(0, 300));
        assert.strictEqual(res.behind, true); assert.strictEqual(res.dirty_remaining, -1);
        assert.strictEqual(res.auto_pulled, 1);
        assert.ok(/re-sync failed/.test(res.sync_warning), res.sync_warning);
        assert.strictEqual(res.conflictFiles, undefined, 'no conflictFiles array: callers treat it as unchecked');
        assert.strictEqual(res.behindFiles, undefined, 'not the stale pre-pull behind list');
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'clean.js')).content, 'c-new', 'wsPull did write the row');
    });
    [['open PR', { ok: true, body: { number: 1022, state: 'open', merged: false, merged_at: null } }],
     ['PR lookup 500', { ok: false, status: 500, body: {} }]].forEach(function(c) {
        test('exact match, merge NOT confirmed (' + c[0] + '): row clean at R1, pushed_pr kept, PR not stamped, HEAD advances', async function() {
            var w = await setup();
            var ours = BASE.replace('l2', 'OURS'), remote = ours.replace('l7', 'UP');
            w.metas[WK].prs = [{ number: 1022, url: 'u/1022', branch: 'fix/x', state: 'open' }];
            await w.s.setWorkspaceFile(row('t.js', BASE, { content: ours, dirty: true, pushed_pr: { number: 1022, url: 'u/1022', branch: 'fix/x' }, pushed_shas: null }));
            var prCalls = 0;
            api(w, { 'git/ref/heads/main$': REF_H2,
                '/repos/o/r/pulls/1022$': function() { prCalls++; return c[1]; },
                'git/trees/H2': { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 't.js', sha: 'R1' }] } },
                'git/blobs/R1': { ok: true, body: { content: b64(remote), encoding: 'base64' } } });
            var res = await w.m.wsSyncWithRemote(WK);
            assert.deepStrictEqual(res.conflictFiles, []);
            assert.strictEqual(prCalls, 1, 'merge state looked up via the API');
            var f = await w.s.getWorkspaceFile(WK, 't.js');
            assert.strictEqual(f.sha, 'R1'); assert.strictEqual(f.original_content, remote);
            assert.strictEqual(f.content, remote); assert.strictEqual(f.dirty, false);
            assert.ok(f.pushed_pr && f.pushed_pr.number === 1022, 'pushed_pr kept: ' + JSON.stringify(f.pushed_pr));
            assert.strictEqual(w.metas[WK].prs[0].state, 'open', 'not stamped merged');
            assert.strictEqual(w.metas[WK].head_sha, 'H2');
        });
    });
});
