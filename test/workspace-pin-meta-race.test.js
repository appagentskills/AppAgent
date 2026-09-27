// S8B-01: setWorkspacePin (tools/020) wrote back stale workspace_meta snapshots — the target row
// read at the top and the sibling rows from getAllWorkspaceMetas — so fields written concurrently
// (prs, head_sha, …) were reverted. It now patches only `pinned` on the fresh row through
// patchWorkspaceMeta (core/130), one readwrite transaction per row.
// fakeIDB / deferred / loadIdb copied from test/workspace-cas-races-4.test.js.
// Run: run_tests { files: ['test/workspace-pin-meta-race.test.js', 'test/workspace-cas-races-4.test.js', 'test/canary.test.js'] }
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

var WK = 'o/r::main', DEV = 'o/r::dev';
async function setup(seed) {
    var idb = fakeIDB(), s = await loadIdb(idb);
    var m = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
    var sc = m.__scope;
    sc.getWorkspaceMeta = s.getWorkspaceMeta; sc.setWorkspaceMeta = s.setWorkspaceMeta; sc.patchWorkspaceMeta = s.patchWorkspaceMeta;
    sc.getAllWorkspaceMetas = s.getAllWorkspaceMetas;
    sc.AgentEvents = { emit: function() {} };
    sc.parseWsKey = function(k) { var i = k.indexOf('::'); return { repo: k.slice(0, i), branch: k.slice(i + 2) }; };
    for (var i = 0; i < seed.length; i++) await s.setWorkspaceMeta(seed[i]);
    return { m: m, s: s, idb: idb };
}
// getAllWorkspaceMetas reads first, then parks on the gate; the returned promise resolves once parked.
function gateAll(w, gate) {
    var entered = deferred(), real = w.s.getAllWorkspaceMetas;
    w.m.__scope.getAllWorkspaceMetas = async function() { var r = await real(); entered.resolve(); await gate.promise; return r; };
    return entered.promise;
}

describe('S8B-01: setWorkspacePin patches only `pinned` on the fresh workspace_meta row', function() {
    test('S8B-01 pin keeps concurrent prs/head_sha', async function() {
        var w = await setup([{ repo: WK, pinned: false }]);
        var gate = deferred(), entered = gateAll(w, gate);
        var p = w.m.setWorkspacePin(WK, false);
        await entered;
        await w.s.setWorkspaceMeta({ repo: WK, pinned: false, prs: [{ number: 1 }], head_sha: 'H2' });
        gate.resolve();
        var res = await p, row = await w.s.getWorkspaceMeta(WK);
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.pinned, true);
        assert.strictEqual(row.pinned, true, 'pinned');
        assert.deepStrictEqual(row.prs, [{ number: 1 }], 'concurrent prs kept (old code put the stale snapshot back)');
        assert.strictEqual(row.head_sha, 'H2', 'concurrent head_sha kept');
    }, { tags: ['unit'] });
    test('S8B-01 sibling unpin keeps the sibling\'s concurrent fields', async function() {
        var w = await setup([{ repo: WK, pinned: false, github_repo: 'o/r' }, { repo: DEV, pinned: true, github_repo: 'o/r', head_sha: 'S1' }]);
        var gate = deferred(), entered = gateAll(w, gate);
        var p = w.m.setWorkspacePin(WK, false);
        await entered;
        var sib = await w.s.getWorkspaceMeta(DEV); sib.head_sha = 'S2';
        await w.s.setWorkspaceMeta(sib);
        gate.resolve();
        var res = await p, dev = await w.s.getWorkspaceMeta(DEV), main = await w.s.getWorkspaceMeta(WK);
        assert.deepStrictEqual(res.unpinned, [DEV]);
        assert.strictEqual(dev.pinned, false, 'sibling unpinned');
        assert.strictEqual(dev.head_sha, 'S2', 'sibling concurrent head_sha kept (old code put the stale snapshot back)');
        assert.strictEqual(main.pinned, true, 'target pinned');
    }, { tags: ['unit'] });
    test('S8B-01 patchWorkspaceMeta skips the put when the mutator returns false; a missing row resolves false', async function() {
        var w = await setup([{ repo: WK, pinned: false, head_sha: 'H' }]);
        var calls = 0;
        assert.strictEqual(await w.s.patchWorkspaceMeta(WK, function(c) { calls++; c.head_sha = 'X'; return false; }), false, 'mutator false: resolves false');
        assert.strictEqual((await w.s.getWorkspaceMeta(WK)).head_sha, 'H', 'nothing was put');
        assert.strictEqual(await w.s.patchWorkspaceMeta('o/r::nope', function() { calls++; }), false, 'missing row: resolves false');
        assert.strictEqual(await w.s.getWorkspaceMeta('o/r::nope'), null, 'no row created');
        assert.strictEqual(calls, 1, 'the mutator never runs for a missing row');
        assert.strictEqual(await w.s.patchWorkspaceMeta(WK, function(c) { c.pinned = true; }), true, 'written: resolves true');
        var row = await w.s.getWorkspaceMeta(WK);
        assert.strictEqual(row.pinned, true);
        assert.strictEqual(row.head_sha, 'H', 'other fields untouched');
    }, { tags: ['unit'] });
});
