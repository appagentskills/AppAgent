// Workspace race fixes part 2 (H4 wsBranch, CAS deletes in wsDelete/wsDiscard,
// _wsChatProgressState). Fake IDB copied from test/workspace-cas-races.test.js.
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

describe('H4: wsBranch discards only the copied rows, CAS against the copy snapshot (tools/020)', function() {
    test('source file edited AFTER its fork copy keeps the new edit (old code: discard-all reverted it)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        await w.s.setWorkspaceFile(Object.assign({}, a, { content: 'edit1', dirty: true, last_modified_at: 1, last_modified_by_chat_id: 'c1' }));
        await w.s.setWorkspaceFile(row('b.js', 'bbase'));
        var b = await w.s.getWorkspaceFile(WK, 'b.js');
        await w.s.setWorkspaceFile(Object.assign({}, b, { content: 'bedit', dirty: true, last_modified_at: 1, last_modified_by_chat_id: 'c1' }));
        var realSetMeta = w.m.__scope.setWorkspaceMeta, raced = false;
        w.m.__scope.setWorkspaceMeta = async function(mm) {
            await realSetMeta(mm);
            if (!raced && mm.forked_from) { raced = true; var cur = await w.s.getWorkspaceFile(WK, 'a.js'); await w.s.setWorkspaceFile(Object.assign({}, cur, { content: 'edit2', last_modified_at: 2 })); }
        };
        var res = await w.m.wsBranch(WK, 'feat', true, 'c1', 'C1', true);
        assert.strictEqual(res.success, true, JSON.stringify(res));
        assert.ok(raced, 'race injected between copy and discard');
        var srcA = await w.s.getWorkspaceFile(WK, 'a.js');
        assert.strictEqual(srcA.content, 'edit2', 'late edit survives on the source');
        assert.strictEqual(srcA.dirty, true);
        assert.deepStrictEqual(res.changed_during_fork, ['a.js']);
        assert.strictEqual(res.dirty_moved, false);
        var srcB = await w.s.getWorkspaceFile(WK, 'b.js');
        assert.strictEqual(srcB.dirty, false, 'untouched travelled row is still discarded');
        assert.strictEqual(srcB.content, 'bbase');
        assert.strictEqual((await w.s.getWorkspaceFile('o/r::feat', 'a.js')).content, 'edit1', 'fork holds the copied version');
    });
});

describe('direct deletes routed through the CAS (wsDelete / wsDiscard)', function() {
    test('wsDelete of a new file whose row changes between read and delete keeps the row (old code: deleted it)', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('n.js', 'x', { sha: null, original_content: null, dirty: true, last_modified_at: 1, last_modified_by_chat_id: 'c1' }));
        var real = w.m.__scope.getWorkspaceFile, once = false;
        w.m.__scope.getWorkspaceFile = async function(r, p) {
            var got = await real(r, p);
            if (!once && p === 'n.js') { once = true; await w.s.setWorkspaceFile(Object.assign({}, got, { content: 'y', last_modified_at: 2 })); }
            return got;
        };
        var res = await w.m.wsDelete(WK, 'n.js', 'c1', 'C1', true);
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.conflict, true);
        assert.strictEqual((await real(WK, 'n.js')).content, 'y');
    });
    test('wsDelete / wsDiscard of an unchanged new file still delete it', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('n.js', 'x', { sha: null, original_content: null, dirty: true, last_modified_at: 1, last_modified_by_chat_id: 'c1' }));
        assert.strictEqual((await w.m.wsDelete(WK, 'n.js', 'c1', 'C1', true)).success, true);
        assert.strictEqual(await w.s.getWorkspaceFile(WK, 'n.js'), null);
        await w.s.setWorkspaceFile(row('m.js', 'x', { sha: null, original_content: null, dirty: true, last_modified_at: 1 }));
        var d = await w.m.wsDiscard(WK, 'm.js', 'c1', 'C1', true);
        assert.strictEqual(d.success, true, JSON.stringify(d));
        assert.strictEqual(await w.s.getWorkspaceFile(WK, 'm.js'), null);
    });
    test('wsDiscard with a stale opts.expected snapshot refuses (conflict) and keeps the row', async function() {
        var w = await setup();
        await w.s.setWorkspaceFile(row('a.js', 'base'));
        var a = await w.s.getWorkspaceFile(WK, 'a.js');
        var snap = Object.assign({}, a, { content: 'e1', dirty: true, last_modified_at: 1 });
        await w.s.setWorkspaceFile(Object.assign({}, snap, { content: 'e2', last_modified_at: 2 }));
        var d = await w.m.wsDiscard(WK, 'a.js', 'c1', 'C1', true, { expected: snap });
        assert.strictEqual(d.success, false); assert.strictEqual(d.conflict, true);
        assert.strictEqual((await w.s.getWorkspaceFile(WK, 'a.js')).content, 'e2');
    });
});

describe('_wsChatProgressState ignores failed / placeholder tool results', function() {
    test('a failed update_action_state result does not count as executed', async function() {
        var w = await setup();
        function tc(id, st) { return { role: 'assistant', tool_calls: [{ id: id, function: { name: 'update_action_state', arguments: JSON.stringify({ state: st }) } }] }; }
        var chat = { messages: [tc('t1', 'running'), { role: 'tool', tool_call_id: 't1', content: '{"success":true}' },
            tc('t2', 'done'), { role: 'tool', tool_call_id: 't2', content: ' {"success":false,"error":"rejected"}' },
            tc('t3', 'error'), { role: 'tool', tool_call_id: 't3', content: '', _placeholder: true }] };
        assert.strictEqual(w.m._wsChatProgressState(chat), 'running', 'old code: returned error (placeholder + failed counted)');
        chat.messages.push(tc('t4', 'pr_opened'), { role: 'tool', tool_call_id: 't4', content: 'plain text ok' });
        assert.strictEqual(w.m._wsChatProgressState(chat), 'pr_opened');
    });
});
