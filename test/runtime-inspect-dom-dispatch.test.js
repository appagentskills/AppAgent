// A2A-01 — runtime_inspect dispatch target:'dom' (tools/140-runtime-inspect.js
// _riDispatchDom) used to answer dispatched:true for every matched element, so a
// cancelled event or a click on a disabled control looked like a success. It now
// reports dispatched (false when el.click() fires nothing), defaultPrevented and,
// for synthetic events, notCanceled (the dispatchEvent return value).
describe('A2A-01 runtime_inspect dom dispatch reports the outcome (tools/140-runtime-inspect.js)', function() {
    var M = null, cur = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/tools/140-runtime-inspect.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(),
            document: { querySelector: function() { return cur; } },
            Event: Event, MouseEvent: MouseEvent, KeyboardEvent: KeyboardEvent
        } });
        M.__scope._reloadRebuildsFromWorkspace = async function() { return true; };
        assert.strictEqual(typeof M.executeRuntimeInspect, 'function');
        return M;
    }
    function dispatch(m, event, options) {
        var a = { action: 'dispatch', target: 'dom', selector: '#x', event: event };
        if (options) a.options = options;
        return m.executeRuntimeInspect(a);
    }
    test('dom keydown reports defaultPrevented', async function() {
        var m = await load();
        var ta = document.createElement('textarea');
        ta.addEventListener('keydown', function(e) { if (e.key === 'Enter') e.preventDefault(); });
        cur = ta;
        var enter = await dispatch(m, 'keydown', { key: 'Enter' });
        assert.strictEqual(enter.success, true, JSON.stringify(enter));
        assert.strictEqual(enter.dispatched, true);
        assert.strictEqual(enter.defaultPrevented, true, 'Enter is cancelled by the handler');
        assert.strictEqual(enter.notCanceled, false);
        var letter = await dispatch(m, 'keydown', { key: 'a' });
        assert.strictEqual(letter.dispatched, true);
        assert.strictEqual(letter.defaultPrevented, false, "'a' is not cancelled");
        assert.strictEqual(letter.notCanceled, true);
    }, { tags: ['unit'], timeout: 2000 });
    test('dom click reports defaultPrevented; disabled → dispatched:false', async function() {
        var m = await load();
        var clicks = 0, btn = document.createElement('button');
        btn.addEventListener('click', function(e) { clicks++; e.preventDefault(); });
        cur = btn;
        var r = await dispatch(m, 'click');
        assert.strictEqual(r.matched, true, JSON.stringify(r));
        assert.strictEqual(r.dispatched, true);
        assert.strictEqual(r.defaultPrevented, true);
        assert.strictEqual(clicks, 1);
        var plain = document.createElement('button');
        cur = plain;
        var p = await dispatch(m, 'click');
        assert.strictEqual(p.dispatched, true);
        assert.strictEqual(p.defaultPrevented, false);
        btn.disabled = true;
        cur = btn;
        var d = await dispatch(m, 'click');
        assert.strictEqual(d.success, true);
        assert.strictEqual(d.matched, true);
        assert.strictEqual(d.dispatched, false, 'a disabled control gets no click event');
        assert.strictEqual(d.defaultPrevented, false);
        assert.strictEqual(clicks, 1, 'handler did not run');
    }, { tags: ['unit'], timeout: 2000 });
});
