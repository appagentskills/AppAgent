// Regression sweep #1336/#1338: take_screenshot fast mode (background.js).
// Runs the REAL slice between '// take_screenshot fast mode state' and
// handleOpenSnForLogin against a fake chrome. Timers run at once (microtask).
//  - fix 8: restore_tab still restores the user's tab when the target tab is gone
//  - fix 9: captureVisibleTab calls are serialized + a quota error is retried once
//  - fix 10: a minimized window is restored before a fast capture
describe('take_screenshot fast mode: restore on closed tab, serialized captures, minimized window (background.js)', function() {
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
        var e = { tabs: {}, updates: [], winUpdates: [], longTimers: [], order: [], caps: 0, inFlight: 0, maxInFlight: 0, capPlan: (opts.capPlan || []).slice(), listeners: [] };
        (opts.tabs || []).forEach(function(t) { e.tabs[t.id] = Object.assign({ windowId: 1, active: false }, t); });
        e.winState = opts.winState || 'normal';
        var chrome = {
            tabs: {
                get: async function(id) { if (!e.tabs[id]) throw new Error('No tab with id: ' + id); return Object.assign({}, e.tabs[id]); },
                query: async function(q) { return Object.keys(e.tabs).map(function(k) { return e.tabs[k]; }).filter(function(t) { return t.active && t.windowId === q.windowId; }); },
                update: async function(id, p) {
                    e.updates.push([id, p]);
                    if (!e.tabs[id]) throw new Error('No tab with id: ' + id);
                    if (p.active) {
                        Object.keys(e.tabs).forEach(function(k) { if (e.tabs[k].windowId === e.tabs[id].windowId) e.tabs[k].active = false; });
                        e.tabs[id].active = true;
                        e.listeners.slice().forEach(function(fn) { fn({ tabId: id }); });
                    }
                },
                captureVisibleTab: async function() {
                    e.caps++; e.inFlight++; e.maxInFlight = Math.max(e.maxInFlight, e.inFlight);
                    e.order.push('cap');
                    if (e.capPlan[0] === 'hang') { e.capPlan.shift(); return new Promise(function() {}); }
                    if (e.winState === 'minimized') { e.inFlight--; throw new Error('Failed to capture tab: image readback failed'); }
                    for (var i = 0; i < 20; i++) await Promise.resolve();
                    e.inFlight--;
                    var step = e.capPlan.shift();
                    if (step === 'quota') throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
                    return 'data:image/jpeg;base64,AAAA';
                },
                onActivated: {
                    addListener: function(fn) { e.listeners.push(fn); },
                    removeListener: function(fn) { e.listeners = e.listeners.filter(function(x) { return x !== fn; }); }
                }
            },
            windows: {
                get: async function() { return { id: 1, state: e.winState }; },
                update: async function(id, p) { e.winUpdates.push([id, p]); if (p.focused) e.order.push('focus'); if (p.state) e.winState = p.state; },
                getLastFocused: async function() { return { id: 1, focused: true }; }
            }
        };
        // Short timers fire at once; long ones (the 10 s capture timeout) are
        // parked in e.longTimers and fired only by the test.
        var fakeSetTimeout = function(fn, ms) { if (ms >= 5000) { e.longTimers.push(fn); return e.longTimers.length; } Promise.resolve().then(fn); return 0; };
        e.m = new Function('chrome', 'setTimeout', 'clearTimeout', 'BROWSER_ACTION_TAB_REQUIRED_ERROR',
            _src + '\nreturn { handleScreenshot: handleScreenshot, remembered: function() { return _ssFastPrevActiveByWindow; } };')(
            chrome, fakeSetTimeout, function() {}, 'tab_id is required');
        e.shot = function(tabId, o) { return new Promise(function(res) { e.m.handleScreenshot(tabId, res, o); }); };
        return e;
    }

    test('fix 8: fast restore_tab restores the user tab even when the target tab was closed', async function() {
        var e = await boot({ tabs: [{ id: 5, active: true }, { id: 7 }] });
        var r1 = await e.shot(7, { fast: true });
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r1.switched, true);
        assert.strictEqual(e.m.remembered()[1], 5, 'user tab remembered');
        delete e.tabs[7]; // target closed mid-burst
        var r2 = await e.shot(7, { fast: true, restore_tab: true });
        assert.match(r2.error, /not an open tab/);
        assert.deepStrictEqual(r2.restored_tab_ids, [5]);
        assert.strictEqual(e.tabs[5].active, true, 'user tab active again');
        assert.deepStrictEqual(Object.keys(e.m.remembered()), [], 'remembered tab cleared');
    });

    test('fix 8: default-path restore_tab restores a fast burst when the target tab was closed', async function() {
        var e = await boot({ tabs: [{ id: 5, active: true }, { id: 7 }] });
        await e.shot(7, { fast: true });
        delete e.tabs[7];
        var r = await e.shot(7, { restore_tab: true });
        assert.match(r.error, /not an open tab/);
        assert.strictEqual(e.tabs[5].active, true);
        assert.deepStrictEqual(Object.keys(e.m.remembered()), []);
    });

    test('m3: default-path early exits (closed tab / no tab) report restored_tab_ids like the outer catch', async function() {
        // Closed target tab after a fast burst: the restored user tab is reported.
        var e = await boot({ tabs: [{ id: 5, active: true }, { id: 7 }] });
        await e.shot(7, { fast: true });
        delete e.tabs[7];
        var r = await e.shot(7, { restore_tab: true });
        assert.match(r.error, /not an open tab/);
        assert.deepStrictEqual(r.restored_tab_ids, [5]);
        // Missing tab id after a fast burst: same contract.
        var e2 = await boot({ tabs: [{ id: 5, active: true }, { id: 7 }] });
        await e2.shot(7, { fast: true });
        var r2 = await e2.shot(undefined, { restore_tab: true });
        assert.strictEqual(r2.error, 'tab_id is required');
        assert.deepStrictEqual(r2.restored_tab_ids, [5]);
        assert.strictEqual(e2.tabs[5].active, true, 'user tab active again');
        // Without restore_tab nothing is restored and the field stays undefined.
        var r3 = await e2.shot(undefined, {});
        assert.strictEqual(r3.restored_tab_ids, undefined);
    });

    test('fix 9: concurrent captures are serialized (never two captureVisibleTab in flight)', async function() {
        var e = await boot({ tabs: [{ id: 5, active: true }, { id: 6, windowId: 2, active: true }] });
        var rs = await Promise.all([e.shot(5, { fast: true }), e.shot(6, { fast: true }), e.shot(5, {})]);
        rs.forEach(function(r) { assert.strictEqual(r.success, true, JSON.stringify(r)); });
        assert.strictEqual(e.caps, 3);
        assert.strictEqual(e.maxInFlight, 1);
    });

    test('fix 9: a MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota error is retried once', async function() {
        var e = await boot({ tabs: [{ id: 5, active: true }], capPlan: ['quota'] });
        var r = await e.shot(5, { fast: true });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(e.caps, 2);
        var e2 = await boot({ tabs: [{ id: 5, active: true }], capPlan: ['quota', 'quota'] });
        var r2 = await e2.shot(5, { fast: true });
        assert.match(r2.error, /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/);
        assert.strictEqual(e2.caps, 2, 'only one retry');
    });

    test('fix 10: fast mode un-minimizes a minimized window before capturing', async function() {
        var e = await boot({ tabs: [{ id: 5, active: true }], winState: 'minimized' });
        var r = await e.shot(5, { fast: true });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.deepStrictEqual(e.winUpdates, [[1, { state: 'normal' }]]);
        var e2 = await boot({ tabs: [{ id: 5, active: true }] });
        await e2.shot(5, { fast: true });
        assert.deepStrictEqual(e2.winUpdates, [], 'normal window untouched');
    });

    test('review: a hung captureVisibleTab times out and does not block the next capture', async function() {
        var e = await boot({ tabs: [{ id: 5, active: true }], capPlan: ['hang'] });
        var p1 = e.shot(5, { fast: true, restore_tab: true });
        var p2 = e.shot(5, {});
        for (var i = 0; i < 500 && !e.longTimers.length; i++) await Promise.resolve();
        assert.strictEqual(e.longTimers.length, 1, 'timeout armed for the hung capture');
        assert.strictEqual(e.caps, 1, 'second capture waits behind the hung one');
        e.longTimers.shift()();
        var r1 = await p1;
        assert.match(r1.error, /timed out after 10000 ms/);
        assert.deepStrictEqual(r1.restored_tab_ids, [], 'restore result reported on error');
        var r2 = await p2;
        assert.strictEqual(r2.success, true, JSON.stringify(r2));
        assert.strictEqual(e.caps, 2);
    });

    test('review: default path focuses inside the serialized section; error reports restored_tab_ids', async function() {
        var e = await boot({ tabs: [{ id: 5, active: true }, { id: 6, windowId: 2, active: true }], capPlan: ['hang'] });
        var p1 = e.shot(5, { fast: true });
        var p2 = e.shot(6, {});
        for (var i = 0; i < 500 && !e.longTimers.length; i++) await Promise.resolve();
        for (var k = 0; k < 300; k++) await Promise.resolve(); // let p2 reach its capture
        assert.deepStrictEqual(e.order, ['cap'], 'default-path focus not run while another capture is in flight');
        e.longTimers.shift()();
        await p1;
        var r2 = await p2;
        assert.strictEqual(r2.success, true, JSON.stringify(r2));
        assert.deepStrictEqual(e.order.slice(0, 3), ['cap', 'focus', 'cap'], 'focus runs right before its own capture');
        // Default-path failure with restore_tab: restored ids are returned.
        var e3 = await boot({ tabs: [{ id: 5, active: true }, { id: 7 }], capPlan: [] });
        await e3.shot(7, { fast: true });
        e3.longTimers.length = 0; // drop the settled first capture's timer
        e3.capPlan.push('hang');
        var p3 = e3.shot(7, { restore_tab: true });
        for (var j = 0; j < 500 && !e3.longTimers.length; j++) await Promise.resolve();
        e3.longTimers.shift()();
        var r3 = await p3;
        assert.match(r3.error, /Screenshot failed: captureVisibleTab timed out/);
        assert.deepStrictEqual(r3.restored_tab_ids, [5]);
        assert.strictEqual(e3.tabs[5].active, true);
    });
});
