// #17 — runtime_inspect action:'sandbox_registry' (Phase 4, fix-all/4-high).
// Page side (tools/140-runtime-inspect.js): pulls the SW 'pull-debug-state'
// reply and returns its `sandboxes` + `offscreen` sections. SW side
// (worker/130-port-bridge.js): the reply now carries `sandboxes` (js_eval
// bookkeeping globals) and `offscreen` (background.js self._swOffscreenDebug
// + the async chrome.offscreen.hasDocument()).
describe('#17 runtime_inspect sandbox_registry (tools/140-runtime-inspect.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/tools/140-runtime-inspect.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M.executeRuntimeInspect, 'function');
        return M;
    }
    // _riPullSwDebugState is module-local (cannot be stubbed via __scope), so
    // drive the REAL round-trip: a fake _agentBusPort answers 'pull-debug-state'
    // through _riResolveDebugState({type:'debug-state', requestId, state}).
    function wire(m, devMode, state) {
        m.__scope._reloadRebuildsFromWorkspace = async function() { return devMode; };
        m.__scope._agentBusPort = { postMessage: function(msg) {
            assert.strictEqual(msg.type, 'pull-debug-state');
            setTimeout(function() { m._riResolveDebugState({ type: 'debug-state', requestId: msg.requestId, state: state }); }, 0);
        } };
    }
    test('returns the SW sandboxes + offscreen sections (dev mode on)', async function() {
        var m = await load();
        wire(m, true, { runningChatIds: [], sandboxes: { evalCount: { c1: 1 }, pending: { c1: 0 }, activity: { c1: 123 }, gen: { c1: 2 } }, offscreen: { hasDocument: true, keepAlivePort: false, idleSince: 0, creating: false, readyWaiters: 0 } });
        var r = await m.executeRuntimeInspect({ action: 'sandbox_registry' });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.deepStrictEqual(r.sandboxes, { evalCount: { c1: 1 }, pending: { c1: 0 }, activity: { c1: 123 }, gen: { c1: 2 } });
        assert.strictEqual(r.offscreen.hasDocument, true);
        assert.strictEqual(r.offscreen.keepAlivePort, false, 'zombie signature: document exists, port not connected');
        assert.strictEqual(r.state, undefined, 'does not leak the whole sw_state payload');
    });
    test('missing sections from an older SW → null, still success', async function() {
        var m = await load();
        wire(m, true, { runningChatIds: ['x'] });
        var r = await m.executeRuntimeInspect({ action: 'sandbox_registry' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.sandboxes, null);
        assert.strictEqual(r.offscreen, null);
    });
    test('dev-mode gate fails closed', async function() {
        var m = await load();
        wire(m, false, { sandboxes: {} });
        var r = await m.executeRuntimeInspect({ action: 'sandbox_registry' });
        assert.strictEqual(r.success, false);
        assert.ok(/dev mode/.test(r.error), r.error);
    });
    test('unknown-action error lists sandbox_registry', async function() {
        var m = await load();
        wire(m, true, {});
        var r = await m.executeRuntimeInspect({ action: 'bogus_action' });
        assert.strictEqual(r.success, false);
        assert.ok(/sandbox_registry/.test(r.error), r.error);
        assert.ok(/sw_state/.test(r.error), r.error);
    });
});

describe('#17 pull-debug-state reply carries sandboxes + offscreen (worker/130-port-bridge.js)', function() {
    var SRC = null;
    async function slice() {
        if (SRC) return SRC;
        var full = await loadFile('src/js/worker/130-port-bridge.js');
        var a = full.indexOf("case 'pull-debug-state':");
        var b = full.indexOf("case 'update-chat':");
        assert.ok(a > 0 && b > a, 'pull-debug-state / update-chat markers must exist in 130-port-bridge.js');
        // Keep only the handler body (drop the `case` label and the trailing `return;`).
        var body = full.slice(a + "case 'pull-debug-state':".length, b);
        body = body.replace(/return;\s*$/, '');
        SRC = body;
        return SRC;
    }
    function fakeSelf(offDbg) {
        return { _swDevModeActive: true, _swOffscreenDebug: offDbg };
    }
    function run(body, opts) {
        var posted = [];
        var port = { postMessage: function(m) { if (opts.deadPort) throw new Error('port closed'); posted.push(m); } };
        var chrome = { offscreen: { hasDocument: opts.hasDocument } };
        var scope = {
            port: port, msg: { requestId: 'r1' }, chrome: chrome, self: fakeSelf(opts.offDbg),
            _sandboxEvalCount: { c1: 1 }, _sandboxPending: { c1: 0 }, _sandboxActivity: { c1: 42 }, _sandboxGen: { c1: 3 },
            runningChatIds: { c1: true, c2: false }
        };
        var names = Object.keys(scope);
        var fn = new Function(names.join(','), body);
        fn.apply(null, names.map(function(n) { return scope[n]; }));
        return posted;
    }
    async function settle() { await new Promise(function(r) { setTimeout(r, 0); }); await Promise.resolve(); await new Promise(function(r) { setTimeout(r, 0); }); }
    test('hasDocument resolves true → state.sandboxes + state.offscreen.hasDocument:true merged with _swOffscreenDebug()', async function() {
        var body = await slice();
        var posted = run(body, { hasDocument: function() { return Promise.resolve(true); }, offDbg: function() { return { keepAlivePort: false, idleSince: 7, creating: false, readyWaiters: 2 }; } });
        assert.strictEqual(posted.length, 0, 'reply is posted asynchronously after hasDocument settles');
        await settle();
        assert.strictEqual(posted.length, 1);
        var st = posted[0].state;
        assert.strictEqual(posted[0].type, 'debug-state');
        assert.strictEqual(posted[0].requestId, 'r1');
        assert.deepStrictEqual(st.runningChatIds, ['c1'], 'existing fields untouched');
        assert.strictEqual(st.devMode, true);
        assert.deepStrictEqual(st.sandboxes, { evalCount: { c1: 1 }, pending: { c1: 0 }, activity: { c1: 42 }, gen: { c1: 3 } });
        assert.deepStrictEqual(st.offscreen, { hasDocument: true, keepAlivePort: false, idleSince: 7, creating: false, readyWaiters: 2 });
    });
    test('hasDocument rejects / _swOffscreenDebug missing → offscreen.hasDocument:null, reply still posted', async function() {
        var body = await slice();
        var posted = run(body, { hasDocument: function() { return Promise.reject(new Error('no offscreen api')); }, offDbg: undefined });
        await settle();
        assert.strictEqual(posted.length, 1);
        assert.deepStrictEqual(posted[0].state.offscreen, { hasDocument: null });
        assert.ok(posted[0].state.sandboxes, 'sandboxes still present');
    });
    test('chrome.offscreen absent → hasDocument:null (no throw)', async function() {
        var body = await slice();
        var posted = [];
        var port = { postMessage: function(m) { posted.push(m); } };
        var fn = new Function('port', 'msg', 'chrome', 'self', 'runningChatIds', body);
        fn(port, { requestId: 'r2' }, {}, { _swDevModeActive: false }, {});
        await settle();
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].state.offscreen.hasDocument, null);
        assert.deepStrictEqual(posted[0].state.sandboxes, { evalCount: null, pending: null, activity: null, gen: null }, 'globals absent (typeof-guarded) → null');
    });
    test('dead port never throws (sync or async)', async function() {
        var body = await slice();
        var posted = run(body, { deadPort: true, hasDocument: function() { return Promise.resolve(false); }, offDbg: function() { return {}; } });
        await settle();
        assert.strictEqual(posted.length, 0);
    });
});
