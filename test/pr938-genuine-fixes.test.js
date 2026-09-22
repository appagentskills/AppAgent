// Genuine fixes re-applied from reverted PR #938 (roll-forward, PR #939).
// Each test drives the REAL source with only browser/DOM effects faked.
describe('PR #938 genuine fixes (roll-forward)', function() {

    // ── 1. core/130-indexeddb.js: readwrite waits for tx complete/abort ──────
    function fakeIdb() {
        var txs = [];
        var conn = { close: function() {}, transaction: function(names, mode) {
            var listeners = {};
            var tx = { mode: mode, error: null, aborted: false,
                addEventListener: function(t, f) { (listeners[t] = listeners[t] || []).push(f); },
                abort: function() { tx.aborted = true; },
                fire: function(t) { (listeners[t] || []).forEach(function(l) { l({ target: tx }); }); },
                objectStore: function() { return { put: function() { var r = {}; queueMicrotask(function() { r.result = 1; if (r.onsuccess) r.onsuccess({ target: r }); }); return r; },
                    get: function() { var r = {}; queueMicrotask(function() { r.result = { v: 1 }; if (r.onsuccess) r.onsuccess({ target: r }); }); return r; } }; } };
            txs.push(tx); return tx;
        } };
        return { txs: txs, indexedDB: { open: function() { var r = { result: conn }; queueMicrotask(function() { r.onsuccess({ target: r }); }); return r; } } };
    }
    async function loadIdb(idb) {
        return loadModules(['src/js/core/130-indexeddb.js'], { globals: { STORAGE_PREFIX: 'test_', indexedDB: idb.indexedDB, console: { warn: function() {}, error: function() {} } } });
    }
    function putBody(tx) { return new Promise(function(res) { var r = tx.objectStore('chats').put({ id: 'a' }); r.onsuccess = function() { res('saved'); }; }); }
    async function ticks(n) { for (var i = 0; i < n; i++) await Promise.resolve(); }

    test('withStore readwrite stays pending after request success until the transaction commits', async function() {
        var idb = fakeIdb(), m = await loadIdb(idb), state = 'pending';
        var p = m.withStore(['chats'], 'readwrite', putBody).then(function(v) { state = 'resolved:' + v; }, function(e) { state = 'rejected:' + e.message; });
        await ticks(30);
        assert.strictEqual(idb.txs.length, 1);
        assert.strictEqual(state, 'pending', 'request onsuccess alone must not settle a readwrite');
        idb.txs[0].fire('complete');
        await p;
        assert.strictEqual(state, 'resolved:saved');
    });
    test('withStore readwrite rejects with the transaction error on commit-time abort', async function() {
        var idb = fakeIdb(), m = await loadIdb(idb);
        var p = m.withStore(['chats'], 'readwrite', putBody);
        await ticks(30);
        idb.txs[0].error = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        idb.txs[0].fire('abort');
        await assert.rejects(p, function(e) { return e.name === 'QuotaExceededError'; });
    });
    test('withStore readonly still resolves on the body alone (no commit to wait for)', async function() {
        var idb = fakeIdb(), m = await loadIdb(idb);
        var v = await m.withStore(['chats'], 'readonly', function(tx) { return new Promise(function(res) { var r = tx.objectStore('chats').get('a'); r.onsuccess = function() { res(r.result.v); }; }); });
        assert.strictEqual(v, 1);
        assert.strictEqual(idb.txs[0].mode, 'readonly');
    });

    // ── 2. tools/085-widget-eval.js: observer lifecycle + entry-guarded unregister ──
    function mockObserver() {
        var stats = { constructed: 0, observed: 0, disconnected: 0 };
        function MO(cb) { stats.constructed++; this.cb = cb; }
        MO.prototype.observe = function() { stats.observed++; };
        MO.prototype.disconnect = function() { stats.disconnected++; };
        return { MO: MO, stats: stats };
    }
    function fakeIframe() { return { isConnected: true, addEventListener: function() {}, removeEventListener: function() {}, getRootNode: function() { return {}; }, contentWindow: {} }; }
    async function loadWidgetEval(mo) {
        return loadModules(['src/js/tools/085-widget-eval.js'], { lenient: true, globals: {
            window: { addEventListener: function() {} }, document: { documentElement: {} },
            crypto: { randomUUID: function() { return Math.random().toString(16).slice(2); } }, MutationObserver: mo.MO } });
    }
    test('document-wide observer exists only while live widget instances exist', async function() {
        var mo = mockObserver(), m = await loadWidgetEval(mo);
        assert.strictEqual(mo.stats.constructed, 0, 'no observer at load with zero instances');
        var f1 = fakeIframe(), f2 = fakeIframe();
        m.registerWidgetInstance(f1, 'w1'); m.registerWidgetInstance(f2, 'w2');
        assert.strictEqual(mo.stats.constructed, 1); assert.strictEqual(mo.stats.observed, 1);
        m.unregisterWidgetInstance(f1);
        assert.strictEqual(mo.stats.disconnected, 0, 'one instance still live');
        m.unregisterWidgetInstance(f2);
        assert.strictEqual(mo.stats.disconnected, 1);
        assert.strictEqual(m._liveWidgetInstances.size, 0);
        m.registerWidgetInstance(fakeIframe(), 'w3');
        assert.strictEqual(mo.stats.constructed, 2, 'observer re-created for a new lifecycle');
    });
    test('a stale entry cannot unregister the entry currently bound to the same iframe', async function() {
        var mo = mockObserver(), m = await loadWidgetEval(mo), iframe = fakeIframe();
        var old = m.registerWidgetInstance(iframe, 'w1');
        m.unregisterWidgetInstance(iframe);
        var fresh = m.registerWidgetInstance(iframe, 'w1');
        m.unregisterWidgetInstance(iframe, old); // e.g. the old entry's 1s probe timer firing late
        assert.ok(m._liveWidgetInstances.has(fresh.instance_id), 'fresh entry survives a stale unregister');
        assert.strictEqual(m._liveWidgetInstances.size, 1);
        m.unregisterWidgetInstance(iframe, fresh);
        assert.strictEqual(m._liveWidgetInstances.size, 0, 'matching entry unregisters normally');
    });

    // ── 4a. app/030-agent-loop.js: `position\s+` tolerant truncation detection ──
    test('truncated-args detection tolerates extra whitespace after "position"', async function() {
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        var s = '{"code":"' + 'x'.repeat(5000);
        var single = m._toolArgsParseErrorMessage(s, new SyntaxError('Unexpected end of JSON input at position ' + (s.length - 1)));
        var multi = m._toolArgsParseErrorMessage(s, new SyntaxError('Unexpected end of JSON input at position   ' + (s.length - 1)));
        var tab = m._toolArgsParseErrorMessage(s, new SyntaxError('Unexpected end of JSON input at position\t' + (s.length - 1)));
        var unrelated = m._toolArgsParseErrorMessage(s, new SyntaxError('Unexpected token x'));
        var truncated = /cut off|truncated/i;
        assert.ok(truncated.test(single), 'baseline single-space form is detected: ' + single);
        assert.ok(truncated.test(multi), 'multiple spaces must still be detected as truncation: ' + multi);
        assert.ok(truncated.test(tab), 'tab must still be detected as truncation: ' + tab);
        assert.ok(!truncated.test(unrelated), 'a non-positional error is not called truncated: ' + unrelated);
    });

    // ── 5. ui/160-notifications.js: handleApproval ignores a tombstoned chat ──
    test('handleApproval is a no-op against a deleted (tombstoned) chat', async function() {
        var resolved = [];
        var chats = { x: { id: 'x', _deleted: true, messages: [{ role: 'approval', status: 'pending', toolCallId: 't1' }] } };
        var pendingToolApprovals = { 'x:0': { chatId: 'x', approvalIndex: 0, toolCallId: 't1', resolve: function(v) { resolved.push(v); } } };
        var m = await loadModules(['src/js/ui/160-notifications.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), document: { getElementById: function() { return null; }, querySelectorAll: function() { return []; }, addEventListener: function() {} },
            chats: chats, pendingToolApprovals: pendingToolApprovals, currentChatId: 'x' } });
        await m.handleApproval(0, 'allow', true, 'x');
        assert.strictEqual(chats.x.messages[0].status, 'pending');
        assert.deepStrictEqual(resolved, []);
        assert.ok(pendingToolApprovals['x:0'], 'pending entry untouched');
    });

    // ── 6. ui/065-widget-library.js: listeners bound per element, never doubled ──
    function fakeLib() {
        var e = { listeners: {}, input: null, _html: '' };
        e.addEventListener = function(t, f) { var l = e.listeners[t] = e.listeners[t] || []; if (l.indexOf(f) < 0) l.push(f); }; // DOM dedupes same fn
        e.querySelector = function(sel) { if (sel === '.widget-library-header') return e._html ? {} : null; if (sel === '.widget-library-search-input') return e.input; return null; };
        e.querySelectorAll = function() { return []; };
        Object.defineProperty(e, 'innerHTML', { get: function() { return e._html; }, set: function(v) { e._html = v; e.input = { value: '', listeners: [], addEventListener: function(t, f) { e.input.listeners.push(f); } }; } });
        return e;
    }
    async function loadRenderWidgetLibrary(doc) {
        var src = (await loadSources(['src/js/ui/065-widget-library.js']))['src/js/ui/065-widget-library.js'];
        function slice(from, to) { var a = src.indexOf(from), b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, 'source anchors present: ' + from); return src.slice(a, b); }
        var body = slice('var widgetLibraryState =', '\n') + '\n' + slice('function onWidgetLibraryKeydown(', '\n// ---- rendering ----') + slice('function renderWidgetLibrary() {', '\nfunction renderWidgetLibraryItems()') +
            '\nreturn { render: renderWidgetLibrary, state: widgetLibraryState };';
        return new Function('document', 'UI_ICONS', 'WIDGET_LIBRARY_GRID_ICON', 'getWidgetLibraryLayout', 'renderWidgetLibraryItems', 'onWidgetLibraryClick', 'setWidgetLibraryLayout', body)(
            doc, { search: '', list: '' }, '', function() { return 'rows'; }, function() {}, function() {}, function() {});
    }
    test('re-created #widget-library gets its listeners; re-render on the same element never doubles them', async function() {
        var libA = fakeLib(), current = libA;
        var lib = await loadRenderWidgetLibrary({ getElementById: function() { return current; } });
        lib.render(); lib.render();
        assert.strictEqual(libA.listeners.click.length, 1); assert.strictEqual(libA.listeners.keydown.length, 1); assert.strictEqual(libA.input.listeners.length, 1);
        assert.strictEqual(lib.state.bound, libA);
        var libB = fakeLib(); current = libB;
        lib.render();
        assert.strictEqual(libB.listeners.click.length, 1, 'new element is bound (old boolean flag left it dead)');
        assert.strictEqual(libB.input.listeners.length, 1);
        assert.strictEqual(lib.state.bound, libB);
    });
    test('a wiped header on the same element is re-bound once (named handlers dedupe)', async function() {
        var libA = fakeLib();
        var lib = await loadRenderWidgetLibrary({ getElementById: function() { return libA; } });
        lib.render();
        var firstInput = libA.input;
        libA._html = ''; libA.input = null; // header wiped externally
        lib.render();
        assert.notStrictEqual(libA.input, firstInput, 'header rebuilt');
        assert.strictEqual(libA.input.listeners.length, 1, 'new search input bound');
        assert.strictEqual(libA.listeners.click.length, 1); assert.strictEqual(libA.listeners.keydown.length, 1);
    });
});
