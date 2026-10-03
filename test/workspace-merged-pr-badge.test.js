// #1079: stale "PR #N" badges on a base workspace after the PR merged,
// changed_since_push after a post-push edit. Fake IDB + wiring copied from
// test/workspace-stale-base-after-merge.test.js.
function fakeIDB() {
    var data = { workspace_files: new Map(), workspace_blobs: new Map(), settings: new Map(), workspace_meta: new Map() };
    var keyPaths = { workspace_files: 'id', workspace_blobs: 'sha', settings: 'key', workspace_meta: 'repo' };
    var queue = [], running = null;
    function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
    function pumpQueue() { if (running || !queue.length) return; running = queue.shift(); running.start(); }
    function makeTx(stores) {
        stores = [].concat(stores);
        var staged = {}, reqs = [], done = false, tx;
        stores.forEach(function(s) { staged[s] = null; });
        function st(name) { if (!staged[name]) staged[name] = new Map(Array.from(data[name].entries()).map(function(e) { return [e[0], clone(e[1])]; })); return staged[name]; }
        function request(fn) { var r = { result: undefined, error: null }; reqs.push({ r: r, fn: fn }); if (running === tx) queueMicrotask(step); return r; }
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
                put: function(v) { return request(function() { st(name).set(v[kp], clone(v)); return v[kp]; }); },
                get: function(k) { return request(function() { return clone(st(name).get(k)); }); },
                getAll: function() { return request(function() { return rows().map(clone); }); },
                delete: function(k) { return request(function() { st(name).delete(k); }); },
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
        tx = { objectStore: objectStore, oncomplete: null, onerror: null, onabort: null, error: null, start: function() { queueMicrotask(step); } };
        queue.push(tx); queueMicrotask(pumpQueue);
        return tx;
    }
    var conn = { close: function() {}, objectStoreNames: { contains: function() { return true; } }, transaction: makeTx };
    return { data: data, indexedDB: { open: function() { var r = {}; queueMicrotask(function() { r.result = conn; r.onsuccess({ target: r }); }); return r; } } };
}

var WK = 'o/r::main';
var PR = { url: 'https://github.com/o/r/pull/77', number: 77, branch: 'fix/x', title: 'T', chatId: 'c1' };
function row(path, content, extra) { return Object.assign({ id: WK + '::' + path, repo: WK, path: path, sha: 's-' + path, content: content, original_content: content, dirty: false, deleted: false, file_id: 'f-' + path }, extra || {}); }

async function setup(prMerged) {
    var idb = fakeIDB();
    var s = await loadModules(['src/js/core/130-indexeddb.js'], { lenient: true, globals: { STORAGE_PREFIX: 'test_', skillAssetsStoreName: 'skillAssets', indexedDB: idb.indexedDB, console: { warn: function() {}, error: function() {}, log: function() {} } } });
    var m = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
    var metas = {}; metas[WK] = { repo: WK, branch: 'main', github_repo: 'o/r', head_sha: 'H', prs: [Object.assign({}, PR)] };
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
    var notified = [], prGets = [];
    sc.githubApi = async function(method, url) {
        if (/\/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H' } } }; // up to date
        var pm = url.match(/\/pulls\/(\d+)$/);
        if (pm) { prGets.push(pm[1]); return { ok: true, body: prMerged ? { merged: true, merged_at: '2026-10-01T10:00:00Z' } : { merged: false, merged_at: null, state: 'open' } }; }
        return { ok: false, status: 500, body: {} };
    };
    // a: pushed, content back to original (clean-equal); b: pushed, diverged; c: never in the PR
    await s.setWorkspaceFile(row('a.js', 'A', { dirty: true, pushed_pr: PR, pushed_shas: ['x'] }));
    await s.setWorkspaceFile(row('b.js', 'B', { content: 'B2', dirty: true, pushed_pr: PR, pushed_shas: ['y'], changed_since_push: true }));
    await s.setWorkspaceFile(row('c.js', 'C', { content: 'C2', dirty: true }));
    return { m: m, s: s, metas: metas, notified: notified, prGets: prGets };
}

describe('#1079 merged-PR reconcile on a base workspace (tools/020)', function() {
    test('up-to-date sync: clean-equal row goes clean; divergent row stays dirty, badge hidden, evidence kept', async function() {
        var w = await setup(true);
        var res = await w.m.wsSyncWithRemote(WK);
        assert.ok(res.merged_prs && res.merged_prs[77], 'merged_prs reported');
        var a = await w.s.getWorkspaceFile(WK, 'a.js'), b = await w.s.getWorkspaceFile(WK, 'b.js'), c = await w.s.getWorkspaceFile(WK, 'c.js');
        assert.strictEqual(a.pushed_pr, null); assert.strictEqual(a.dirty, false);
        assert.strictEqual(b.dirty, true); assert.strictEqual(b.content, 'B2');
        assert.strictEqual(b.pushed_pr_merged, true, 'badge hidden via marker');
        assert.strictEqual(b.pushed_pr.number, 77, 'pushed_pr kept for the _m3PrMerged path');
        assert.deepStrictEqual(b.pushed_shas, ['y'], 'pushed_shas kept for _isOurWork');
        assert.strictEqual(c.dirty, true); assert.strictEqual(c.content, 'C2');
        assert.strictEqual(w.metas[WK].prs[0].state, 'merged');
        assert.strictEqual(w.metas[WK].prs[0].merged_at, '2026-10-01T10:00:00Z');
    });
    test('open PR: nothing cleared; merge info memoized (one GET)', async function() {
        var w = await setup(false);
        await w.m.wsSyncWithRemote(WK);
        await w.m.wsSyncWithRemote(WK);
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.pushed_pr.number, 77); assert.strictEqual(a.dirty, true);
        assert.strictEqual(w.prGets.length, 1);
        assert.ok(!w.metas[WK].prs[0].state);
    });
    test('head-branch PRs are skipped (left to the head-branch lifecycle)', async function() {
        var w = await setup(true);
        w.metas[WK].branch = 'fix/x';
        var out = await w.m._wsReconcileMergedPrs(WK, w.metas[WK], 'o/r', {});
        assert.deepStrictEqual(out.merged, {});
        assert.strictEqual(w.prGets.length, 0);
    });
    test('wsStatus (readOnly) annotates only, writes nothing', async function() {
        var w = await setup(true);
        var st = await w.m.wsStatus(WK, false, 'c1');
        var pr = st.prs.filter(function(p) { return p.number === 77; })[0];
        assert.strictEqual(pr.state, 'merged');
        var da = st.dirty_files.filter(function(f) { return f.path === 'a.js'; })[0];
        var db = st.dirty_files.filter(function(f) { return f.path === 'b.js'; })[0];
        var dc = st.dirty_files.filter(function(f) { return f.path === 'c.js'; })[0];
        assert.strictEqual(da.pushed_pr_merged, true);
        assert.strictEqual(db.changed_since_push, true);
        assert.ok(!dc.pushed_pr_merged);
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.pushed_pr.number, 77, 'row untouched');
        assert.ok(!w.metas[WK].prs[0].state, 'meta untouched');
    });
});

describe('#1083 review: merge evidence survives the reconcile; closed PRs stop polling (tools/020)', function() {
    function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
    test('raced/unadopted divergent row keeps pushed_shas; next sync adopts via _isOurWork and clears everything', async function() {
        var w = await setup(true);
        await w.m._wsReconcileMergedPrs(WK, w.metas[WK], 'o/r', {});
        var b = await w.s.getWorkspaceFile(WK, 'b.js');
        assert.deepStrictEqual(b.pushed_shas, ['y']); assert.strictEqual(b.pushed_pr_merged, true);
        // HEAD advances later: the merged blob 'y' is now on the base.
        w.m.__scope.githubApi = async function(method, url) {
            if (/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H2' } } };
            if (/git\/trees\/H2/.test(url)) return { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'b.js', sha: 'y' }, { type: 'blob', path: 'c.js', sha: 's-c.js' }] } };
            if (/git\/blobs\/y$/.test(url)) return { ok: true, body: { content: b64('B2'), encoding: 'base64' } };
            if (/\/pulls\/\d+$/.test(url)) return { ok: true, body: { merged: true, merged_at: '2026-10-01T10:00:00Z' } };
            return { ok: false, status: 500, body: {} };
        };
        await w.m.wsSyncWithRemote(WK);
        b = await w.s.getWorkspaceFile(WK, 'b.js');
        assert.strictEqual(b.sha, 'y', 'adopted as our merged work (no false conflict)');
        assert.strictEqual(b.pushed_shas, null); assert.strictEqual(b.pushed_pr, null); assert.ok(!b.pushed_pr_merged);
    });
    test('pushed delete keeps its ::deleted:: sentinel after a merged reconcile (deletePushed on next sync)', async function() {
        var w = await setup(true);
        await w.s.setWorkspaceFile(row('d.js', 'D', { content: '', dirty: true, deleted: true, pushed_pr: PR, pushed_shas: ['::deleted::'] }));
        await w.m._wsReconcileMergedPrs(WK, w.metas[WK], 'o/r', {});
        var d = await w.s.getWorkspaceFile(WK, 'd.js');
        assert.deepStrictEqual(d.pushed_shas, ['::deleted::']); assert.strictEqual(d.pushed_pr_merged, true);
        w.m.__scope.githubApi = async function(method, url) {
            if (/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H2' } } };
            if (/git\/trees\/H2/.test(url)) return { ok: true, body: { sha: 'T2', tree: [{ type: 'blob', path: 'd.js', sha: 'R9' }, { type: 'blob', path: 'b.js', sha: 's-b.js' }, { type: 'blob', path: 'c.js', sha: 's-c.js' }] } };
            return { ok: false, status: 500, body: {} };
        };
        var res = await w.m.wsSyncWithRemote(WK);
        var cd = (res.conflictFiles || []).filter(function(c) { return c.path === 'd.js'; })[0];
        assert.ok(cd && cd.deletePushed === true, JSON.stringify(res.conflictFiles));
    });
    test('status exposes pushed_pr_merged for marked rows; marker blocks re-polling', async function() {
        var w = await setup(true);
        await w.m._wsReconcileMergedPrs(WK, w.metas[WK], 'o/r', {});
        var st = await w.m.wsStatus(WK, false, 'c1');
        var db = st.dirty_files.filter(function(f) { return f.path === 'b.js'; })[0];
        assert.strictEqual(db.pushed_pr_merged, true);
    });
    test('closed-unmerged PR: memoized as final (one GET) and meta entry marked closed', async function() {
        var w = await setup(false);
        var gets = 0;
        w.m.__scope.githubApi = async function(method, url) {
            if (/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H' } } };
            if (/\/pulls\/(\d+)$/.test(url)) { gets++; return { ok: true, body: { merged: false, merged_at: null, state: 'closed' } }; }
            return { ok: false, status: 500, body: {} };
        };
        var orig = Date.now; Date.now = function() { return orig() + 3600 * 1000; };
        try {
            await w.m.wsSyncWithRemote(WK);
            Date.now = function() { return orig() + 7200 * 1000; }; // past the 60 s open TTL
            await w.m.wsSyncWithRemote(WK);
        } finally { Date.now = orig; }
        assert.strictEqual(gets, 1, 'closed result cached for good');
        assert.strictEqual(w.metas[WK].prs[0].state, 'closed');
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(a.pushed_pr.number, 77, 'closed PR: rows untouched'); assert.ok(!a.pushed_pr_merged);
    });
    test('API error stays fail-closed (not cached as closed/merged)', async function() {
        var w = await setup(false);
        var gets = 0;
        w.m.__scope.githubApi = async function(method, url) {
            if (/git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H' } } };
            if (/\/pulls\/(\d+)$/.test(url)) { gets++; return { ok: false, status: 500, body: {} }; }
            return { ok: false, status: 500, body: {} };
        };
        var orig = Date.now;
        try {
            Date.now = function() { return orig() + 10 * 3600 * 1000; };
            await w.m.wsSyncWithRemote(WK);
            Date.now = function() { return orig() + 11 * 3600 * 1000; };
            await w.m.wsSyncWithRemote(WK);
        } finally { Date.now = orig; }
        assert.strictEqual(gets, 2, 're-polled after TTL');
        assert.ok(!w.metas[WK].prs[0].state);
    });
});

describe('#1083 review: wsPush stamping (tools/020)', function() {
    // gh stub modelled on test/workspace-stale-base-after-merge.test.js (g).
    function gh(w, opts) {
        opts = opts || {};
        var sc = w.m.__scope;
        sc.loadGitHubSettings = async function() { return { token: 'tok' }; };
        sc._wsCheckCrossChatConflict = function() { return null; };
        var blobN = 0;
        sc.githubApi = async function(method, url) {
            if (method === 'GET' && /git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'H' } } };
            if (method === 'GET' && /git\/ref\/heads\/feat$/.test(url)) return opts.stale ? { ok: true, body: { object: { sha: 'OLD' } } } : { ok: false, status: 404, body: {} };
            if (method === 'GET' && /git\/commits\//.test(url)) return { ok: true, body: { sha: 'H', tree: { sha: 'T' } } };
            if (method === 'GET' && /git\/trees\//.test(url)) return { ok: true, body: { sha: 'T', tree: [] } };
            if (method === 'POST' && /git\/blobs$/.test(url)) return { ok: true, body: { sha: 'NB' + (++blobN) } };
            if (method === 'POST' && /git\/trees$/.test(url)) return { ok: true, body: { sha: 'T2' } };
            if (method === 'POST' && /git\/commits$/.test(url)) return { ok: true, body: { sha: 'C2' } };
            if (method === 'POST' && /git\/refs$/.test(url)) return { ok: true, body: { ref: 'refs/heads/feat', object: { sha: 'C2' } } };
            if (method === 'PATCH' && /git\/refs\/heads\/feat$/.test(url)) return { ok: true, body: { object: { sha: 'C2' } } };
            if (method === 'PATCH' && /\/pulls\/\d+$/.test(url)) return { ok: false, status: 422, body: {} };
            if (method === 'GET' && /\/pulls\?state=all/.test(url)) return { ok: true, body: opts.stale ? [{ number: 5, state: 'closed', merged_at: opts.prevMerged ? '2026-09-30T00:00:00Z' : null }] : [] };
            if (method === 'GET' && /\/pulls/.test(url)) return { ok: true, body: [] };
            if (method === 'POST' && /\/pulls$/.test(url)) return { ok: true, status: 201, body: { number: 9, html_url: 'https://github.com/o/r/pull/9', head: { ref: 'feat' }, base: { ref: 'main' }, title: 'T' } };
            return { ok: true, body: {} };
        };
    }
    var OLD = { url: 'https://github.com/o/r/pull/5', number: 5, branch: 'feat', title: 'Old' };
    async function base() {
        var w = await setup(false);
        if (w.s.putWorkspaceBlob) w.m.__scope.putWorkspaceBlob = w.s.putWorkspaceBlob;
        // Drop setup's rows that are stamped with PR 77 (unrelated here).
        await w.s.setWorkspaceFile(row('a.js', 'A')); await w.s.setWorkspaceFile(row('b.js', 'B')); await w.s.setWorkspaceFile(row('c.js', 'C'));
        w.metas[WK].prs = [];
        return w;
    }
    test('stamp loop resets changed_since_push / pushed_pr_merged; only committed rows (files:[...]) stamped', async function() {
        var w = await base(); gh(w);
        await w.s.setWorkspaceFile(row('p.js', 'P', { content: 'P2', dirty: true, pushed_pr: PR, pushed_shas: ['old'], changed_since_push: true, pushed_pr_merged: true, last_modified_by_chat_id: 'c1' }));
        await w.s.setWorkspaceFile(row('q.js', 'Q', { content: 'Q2', dirty: true, last_modified_by_chat_id: 'c1' }));
        var res = await w.m.wsPush(WK, { branch_name: 'feat', commit_message: 'c', pr_title: 'T', files: ['p.js'] }, 'c1', 'C1');
        assert.strictEqual(res.success, true, JSON.stringify(res).slice(0, 400));
        var p = await w.s.getWorkspaceFile(WK, 'p.js'), q = await w.s.getWorkspaceFile(WK, 'q.js');
        assert.strictEqual(p.pushed_pr.number, 9);
        assert.ok(!p.changed_since_push, 'changed_since_push reset'); assert.ok(!p.pushed_pr_merged, 'merged marker reset');
        assert.ok(p.pushed_shas.indexOf('old') !== -1 && p.pushed_shas.length === 2);
        assert.ok(!q.pushed_pr, 'unlisted row not stamped'); assert.strictEqual(q.dirty, true);
        assert.ok(!(res.cross_chat_warnings || []).some(function(x) { return x.path === 'p.js' && x.other_pr_number; }), 'merged stamp is not a competing PR');
    });
    test('staleBranchRecreated (prev closed unmerged): other rows of the branch lose stamps; _prevPrFiles not merged', async function() {
        var w = await base(); gh(w, { stale: true, prevMerged: false });
        w.metas[WK].prs = [Object.assign({}, OLD, { files: [{ path: 'gone.js', old_sha: 'o', new_sha: 'n' }] })];
        await w.s.setWorkspaceFile(row('s.js', 'S', { content: 'S2', dirty: true, pushed_pr: OLD, pushed_shas: ['sx'], changed_since_push: true }));
        await w.s.setWorkspaceFile(row('n.js', 'N', { content: 'N2', dirty: true, last_modified_by_chat_id: 'c1' }));
        var res = await w.m.wsPush(WK, { branch_name: 'feat', commit_message: 'c', pr_title: 'T', files: ['n.js'] }, 'c1', 'C1');
        assert.strictEqual(res.success, true, JSON.stringify(res).slice(0, 400));
        assert.strictEqual(res.stale_branch_recreated, true);
        var s = await w.s.getWorkspaceFile(WK, 's.js'), n = await w.s.getWorkspaceFile(WK, 'n.js');
        assert.strictEqual(s.pushed_pr, null); assert.strictEqual(s.pushed_shas, null); assert.ok(!s.changed_since_push);
        assert.strictEqual(s.dirty, true, 'content untouched');
        assert.strictEqual(n.pushed_pr.number, 9);
        var entry = w.metas[WK].prs.filter(function(p) { return p.number === 9; })[0];
        var paths = (entry.files || []).map(function(f) { return f.path; });
        assert.ok(paths.indexOf('gone.js') === -1, 'previous PR files not carried over: ' + JSON.stringify(paths));
        assert.strictEqual(entry.title, 'T');
    });
    test('staleBranchRecreated (prev MERGED): other rows keep evidence, badge hidden', async function() {
        var w = await base(); gh(w, { stale: true, prevMerged: true });
        await w.s.setWorkspaceFile(row('s.js', 'S', { content: 'S2', dirty: true, pushed_pr: OLD, pushed_shas: ['sx'] }));
        await w.s.setWorkspaceFile(row('n.js', 'N', { content: 'N2', dirty: true, last_modified_by_chat_id: 'c1' }));
        var res = await w.m.wsPush(WK, { branch_name: 'feat', commit_message: 'c', pr_title: 'T', files: ['n.js'] }, 'c1', 'C1');
        assert.strictEqual(res.success, true, JSON.stringify(res).slice(0, 400));
        var s = await w.s.getWorkspaceFile(WK, 's.js');
        assert.deepStrictEqual(s.pushed_shas, ['sx']); assert.strictEqual(s.pushed_pr.number, 5); assert.strictEqual(s.pushed_pr_merged, true);
    });
});

describe('#1079 changed_since_push (tools/020)', function() {
    test('edit / write / delete of a pushed row set the flag; unpushed rows stay unflagged', async function() {
        var w = await setup(false);
        var r = await w.m.wsEdit(WK, 'a.js', [{ find: 'A', replace: 'A2' }], 'c1', 'chat');
        assert.ok(r.success, JSON.stringify(r));
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).changed_since_push, true);
        await w.s.setWorkspaceFile(row('d.js', 'D', { dirty: true, pushed_pr: PR }));
        var wr = await w.m.wsWrite(WK, 'd.js', 'D2', 'c1', 'chat');
        assert.ok(wr.success, JSON.stringify(wr));
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'd.js')).changed_since_push, true);
        await w.s.setWorkspaceFile(row('e.js', 'E', { dirty: false, pushed_pr: PR }));
        var dr = await w.m.wsDelete(WK, 'e.js', 'c1', 'chat');
        assert.ok(dr.success, JSON.stringify(dr));
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'e.js')).changed_since_push, true);
        await w.m.wsEdit(WK, 'c.js', [{ find: 'C2', replace: 'C3' }], 'c1', 'chat');
        assert.ok(!(await w.s.getWorkspaceFile(WK, 'c.js')).changed_since_push);
    });
});
