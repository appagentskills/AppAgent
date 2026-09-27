// S0B-14 — deploy-folder handle persistence (core/130-indexeddb.js):
// pickDeployDir returns null ONLY for a user cancel (AbortError), rethrows
// every other picker error, and setDeployDirHandle caches the handle only
// after the settings row actually committed. Real 130 module; browser IDB
// and the directory picker are simulated.
describe('deploy dir handle (S0B-14)', function() {
    var m, rows, failTx, win;
    beforeEach(async function() {
        rows = {}; failTx = false; win = {};
        // Fake tx: 'complete' once issued requests settle, or 'abort' (rolled
        // back, tx.error set) when failTx is on — withStore(readwrite) waits for it.
        var database = { close: function() {}, transaction: function() {
            var listeners = {}, pending = 0, done = false, tx;
            function fire(t) { (listeners[t] || []).forEach(function(l) { l({}); }); }
            function settled() { pending--; queueMicrotask(function() { if (done || pending > 0) return; done = true; if (failTx) { tx.error = new Error('QuotaExceededError: commit failed'); fire('abort'); } else fire('complete'); }); }
            function request(fill) { var r = {}; pending++; queueMicrotask(function() { fill(r); settled(); }); return r; }
            pending++; queueMicrotask(settled);
            tx = { addEventListener: function(t, f) { (listeners[t] = listeners[t] || []).push(f); }, abort: function() {}, error: null, objectStore: function() { return {
                get: function(k) { return request(function(r) { r.result = rows[k]; r.onsuccess && r.onsuccess(); }); },
                put: function(row) { if (!failTx) rows[row.key] = row; return request(function(r) { r.onsuccess && r.onsuccess(); }); },
                delete: function(k) { if (!failTx) delete rows[k]; return request(function(r) { r.onsuccess && r.onsuccess(); }); }
            }; } };
            return tx;
        } };
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js', 'src/js/core/130-indexeddb.js'], { globals: {
            STORAGE_PREFIX: 'test_', self: {}, window: win,
            indexedDB: { open: function() { var r = { result: database }; queueMicrotask(function() { r.onsuccess(); }); return r; } },
            chats: {}, activeStreamingChatId: null, currentChatId: null,
            console: { error: function() {}, warn: function() {}, log: function() {} }
        } });
    });
    function handle(name) { return { name: name, kind: 'directory', queryPermission: async function() { return 'granted'; }, requestPermission: async function() { return 'granted'; } }; }
    function err(name) { var e = new Error(name + ': picker failed'); e.name = name; return e; }

    test('S0B-14 AbortError → null, nothing persisted', async function() {
        win.showDirectoryPicker = async function() { throw err('AbortError'); };
        assert.strictEqual(await m.pickDeployDir(), null);
        assert.strictEqual(rows.deployDirHandle, undefined);
        assert.strictEqual(await m.getDeployDirHandle(), null);
    }, { tags: ['unit'] });

    test('S0B-14 SecurityError rethrown', async function() {
        win.showDirectoryPicker = async function() { throw err('SecurityError'); };
        await assert.rejects(m.pickDeployDir(), function(e) { return e && e.name === 'SecurityError'; });
        assert.strictEqual(rows.deployDirHandle, undefined);
    }, { tags: ['unit'] });

    test('S0B-14 failed persist → throws; getDeployDirHandle() null', async function() {
        var h = handle('my-ext');
        win.showDirectoryPicker = async function() { return h; };
        failTx = true;
        await assert.rejects(m.pickDeployDir(), /commit failed/);
        failTx = false;
        assert.strictEqual(rows.deployDirHandle, undefined, 'nothing committed');
        assert.strictEqual(await m.getDeployDirHandle(), null, 'a failed persist never looks connected');
    }, { tags: ['unit'] });

    test('S0B-14 successful pick persists the row, then caches the handle', async function() {
        var h = handle('my-ext');
        win.showDirectoryPicker = async function() { return h; };
        assert.strictEqual(await m.pickDeployDir(), h);
        assert.strictEqual(rows.deployDirHandle.value, h);
        assert.strictEqual(await m.getDeployDirHandle(), h);
    }, { tags: ['unit'] });

    // S0B3-02 — permission is queried on EVERY call (cached or not); only
    // { interactive: true } may call requestPermission.
    function permHandle(name, perm, answer) {
        var h = { name: name, kind: 'directory', perm: perm, q: 0, r: 0 };
        h.queryPermission = async function() { h.q++; return h.perm; };
        h.requestPermission = async function() { h.r++; h.perm = answer || 'granted'; return h.perm; };
        return h;
    }
    function store(h) { rows.deployDirHandle = { key: 'deployDirHandle', value: h }; }

    test('S0B3-02 revoked grant: cached handle re-queried → null', async function() {
        var h = permHandle('my-ext', 'granted');
        win.showDirectoryPicker = async function() { return h; };
        assert.strictEqual(await m.pickDeployDir(), h);
        assert.strictEqual(await m.getDeployDirHandle(), h);
        h.perm = 'prompt';
        assert.strictEqual(await m.getDeployDirHandle(), null, 'a revoked grant never reads as connected');
        assert.strictEqual(h.r, 0);
    }, { tags: ['unit'] });

    test('S0B3-02 passive call never calls requestPermission', async function() {
        var h = permHandle('my-ext', 'prompt');
        store(h);
        assert.strictEqual(await m.getDeployDirHandle(), null);
        assert.deepStrictEqual([h.q, h.r], [1, 0], 'queried, never a gesture-less prompt');
    }, { tags: ['unit'] });

    test('S0B3-02 interactive + prompt → one requestPermission, handle; denied → null', async function() {
        var h = permHandle('my-ext', 'prompt');
        store(h);
        assert.strictEqual(await m.getDeployDirHandle({ interactive: true }), h);
        assert.deepStrictEqual([h.q, h.r], [1, 1]);
        var d = permHandle('other', 'prompt', 'denied');
        store(d);
        assert.strictEqual(await m.getDeployDirHandle({ interactive: true }), null);
        assert.strictEqual(d.r, 1);
    }, { tags: ['unit'] });

    test('S0B3-02 getDeployDirStatus: none, then prompt + name; never prompts', async function() {
        assert.deepStrictEqual(await m.getDeployDirStatus(), { state: 'none' });
        var h = permHandle('my-ext', 'prompt');
        store(h);
        assert.deepStrictEqual(await m.getDeployDirStatus(), { state: 'prompt', name: 'my-ext' });
        assert.strictEqual(h.r, 0);
    }, { tags: ['unit'] });

    test('S0B3-04 clear → row gone, getDeployDirHandle() null, other rows kept', async function() {
        var h = permHandle('my-ext', 'granted');
        win.showDirectoryPicker = async function() { return h; };
        assert.strictEqual(await m.pickDeployDir(), h);
        rows.theme = { key: 'theme', value: 'dark' };
        await m.clearDeployDirHandle();
        assert.strictEqual(rows.deployDirHandle, undefined, 'stored folder reference removed');
        assert.deepStrictEqual(rows.theme, { key: 'theme', value: 'dark' }, 'no other settings row touched');
        assert.strictEqual(await m.getDeployDirHandle(), null);
        assert.deepStrictEqual(await m.getDeployDirStatus(), { state: 'none' });
    }, { tags: ['unit'] });

    test('S0B3-04 row deleted elsewhere → cache not returned; failed clear rejects', async function() {
        var h = permHandle('my-ext', 'granted');
        win.showDirectoryPicker = async function() { return h; };
        await m.pickDeployDir();
        delete rows.deployDirHandle; // another realm's clearDeployDirHandle
        assert.strictEqual(await m.getDeployDirHandle(), null);
        store(h); failTx = true;
        var threw = null; try { await m.clearDeployDirHandle(); } catch (e) { threw = e; }
        assert.ok(threw && /QuotaExceededError/.test(threw.message), 'a failed commit is reported, never silent');
        assert.ok(rows.deployDirHandle, 'row kept on failure');
    }, { tags: ['unit'] });
});
