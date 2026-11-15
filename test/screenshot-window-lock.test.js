// m2: concurrent take_screenshot calls on DIFFERENT tabs in the SAME window
// must each capture their own tab (background.js per-window lock).
// Runs the REAL slice between '// take_screenshot fast mode state' and
// handleOpenSnForLogin against a fake chrome whose captureVisibleTab returns
// the id of the tab that is active in the window at capture time.
describe('take_screenshot per-window lock (background.js, m2)', function() {
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + start);
        return text.slice(a, b);
    }
    var _src = null;
    async function boot(opts) {
        opts = opts || {};
        if (!_src) {
            var bg = await loadFile('src/platform/extension/background.js');
            _src = between(bg, '// take_screenshot fast mode state', 'async function handleOpenSnForLogin');
        }
        var e = { tabs: {}, caps: 0, capPlan: (opts.capPlan || []).slice(), listeners: [] };
        (opts.tabs || []).forEach(function(t) { e.tabs[t.id] = Object.assign({ windowId: 1, active: false }, t); });
        function activeIn(winId) {
            var k = Object.keys(e.tabs).filter(function(k) { return e.tabs[k].active && e.tabs[k].windowId === winId; })[0];
            return k ? e.tabs[k] : null;
        }
        function activate(id) {
            Object.keys(e.tabs).forEach(function(k) { if (e.tabs[k].windowId === e.tabs[id].windowId) e.tabs[k].active = false; });
            e.tabs[id].active = true;
            e.listeners.slice().forEach(function(fn) { fn({ tabId: id }); });
        }
        async function ticks(n) { for (var i = 0; i < n; i++) await Promise.resolve(); }
        var chrome = {
            tabs: {
                get: async function(id) { await ticks(2); if (!e.tabs[id]) throw new Error('No tab with id: ' + id); return Object.assign({}, e.tabs[id]); },
                query: async function(q) { await ticks(2); return Object.keys(e.tabs).map(function(k) { return e.tabs[k]; }).filter(function(t) { return t.active && t.windowId === q.windowId; }); },
                update: async function(id, p) {
                    await ticks(3);
                    if (!e.tabs[id]) throw new Error('No tab with id: ' + id);
                    if (p.active) activate(id);
                },
                captureVisibleTab: async function(winId) {
                    e.caps++;
                    var step = e.capPlan.shift();
                    await ticks(5);
                    if (step === 'throw') throw new Error('boom');
                    if (step && step.steal) activate(step.steal); // another actor switches tabs
                    var t = activeIn(winId);
                    return 'data:tab/' + (t ? t.id : 'none') + (step && step.steal ? '-stolen' : '');
                },
                onActivated: {
                    addListener: function(fn) { e.listeners.push(fn); },
                    removeListener: function(fn) { e.listeners = e.listeners.filter(function(x) { return x !== fn; }); }
                }
            },
            windows: {
                get: async function(id) { return { id: id, state: 'normal' }; },
                update: async function() { await ticks(1); },
                getLastFocused: async function() { return { id: 1, focused: true }; }
            }
        };
        var fakeSetTimeout = function(fn, ms) { if (ms >= 5000) return 0; Promise.resolve().then(fn); return 0; };
        e.m = new Function('chrome', 'setTimeout', 'clearTimeout', 'BROWSER_ACTION_TAB_REQUIRED_ERROR',
            _src + '\nreturn { handleScreenshot: handleScreenshot, locks: function() { return _ssWindowLocks; }, withLock: _ssWithWindowLock };')(
            chrome, fakeSetTimeout, function() {}, 'tab_id is required');
        e.shot = function(tabId, o) { return new Promise(function(res) { e.m.handleScreenshot(tabId, res, o); }); };
        return e;
    }

    [{ name: 'default', o: {} }, { name: 'fast', o: { fast: true } }].forEach(function(mode) {
        test('m2 (' + mode.name + '): concurrent captures of two tabs in one window each get their own tab', async function() {
            var e = await boot({ tabs: [{ id: 1, active: true }, { id: 2 }, { id: 3 }] });
            var rs = await Promise.all([e.shot(2, mode.o), e.shot(3, mode.o)]);
            assert.strictEqual(rs[0].success, true, JSON.stringify(rs[0]));
            assert.strictEqual(rs[1].success, true, JSON.stringify(rs[1]));
            assert.strictEqual(rs[0].base64, 'data:tab/2', 'tab 2 captured its own page');
            assert.strictEqual(rs[1].base64, 'data:tab/3', 'tab 3 captured its own page');
            // The lock (not the recapture guard) keeps the sequences apart: no retry needed.
            assert.strictEqual(e.caps, 2, 'exactly one capture per call');
            await Promise.resolve(); await Promise.resolve();
            assert.deepStrictEqual(Object.keys(e.m.locks()), [], 'lock map cleaned up when idle');
        });
    });

    test('m2: a throwing capture releases the window lock (next capture proceeds)', async function() {
        var e = await boot({ tabs: [{ id: 1, active: true }, { id: 2 }], capPlan: ['throw'] });
        var rs = await Promise.all([e.shot(2, {}), e.shot(1, { fast: true })]);
        assert.match(rs[0].error, /Screenshot failed: boom/);
        assert.strictEqual(rs[1].success, true, JSON.stringify(rs[1]));
        assert.strictEqual(rs[1].base64, 'data:tab/1');
        await Promise.resolve(); await Promise.resolve();
        assert.deepStrictEqual(Object.keys(e.m.locks()), [], 'no lock left behind');
        var r3 = await e.shot(2, { fast: true });
        assert.strictEqual(r3.base64, 'data:tab/2');
    });

    test('m2: _ssWithWindowLock serializes per window and a rejecting holder still releases it', async function() {
        var e = await boot({ tabs: [] });
        var log = [];
        var p1 = e.m.withLock(1, async function() { log.push('a1'); await Promise.resolve(); log.push('a2'); throw new Error('x'); });
        var p2 = e.m.withLock(1, async function() { log.push('b'); return 'ok'; });
        await assert.rejects(p1, /x/);
        assert.strictEqual(await p2, 'ok', 'queued holder ran after a rejection');
        assert.deepStrictEqual(log, ['a1', 'a2', 'b'], 'no interleaving');
        await Promise.resolve(); await Promise.resolve();
        assert.deepStrictEqual(Object.keys(e.m.locks()), [], 'cleaned up');
    });

    test('m2 guard: a tab switched away during capture is re-activated and captured once more', async function() {
        var e = await boot({ tabs: [{ id: 1, active: true }, { id: 2 }], capPlan: [{ steal: 1 }] });
        var r = await e.shot(2, { fast: true });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.base64, 'data:tab/2', 'recaptured the target');
        assert.strictEqual(e.caps, 2);
    });

    test('m2: different windows are not serialized against each other by the window lock', async function() {
        var e = await boot({ tabs: [{ id: 1, active: true }, { id: 2 }, { id: 5, windowId: 2, active: true }, { id: 6, windowId: 2 }] });
        var rs = await Promise.all([e.shot(2, { fast: true }), e.shot(6, { fast: true })]);
        assert.strictEqual(rs[0].base64, 'data:tab/2');
        assert.strictEqual(rs[1].base64, 'data:tab/6');
    });
});
