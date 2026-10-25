// Regression tests for the split-pane fixes on top of PRs #1198/#1199:
//  1. html_widget action=patch notes the slot patch BEFORE WidgetStore.commit,
//     because commit -> project -> refreshWidgetVersionViews -> splitViewApplyUpdate
//     runs synchronously inside commit (core/135-widget-store.js). The pane must
//     take the in-place 'slots' path, not a full reload.
//  2. take_screenshot target:'split_widget' rejects a pane owned by another
//     chat family, or showing a different widget than args.widget_id.
//  3. widgetApplySlotsToHtml gives the same result for nested slots in either
//     key order (outer wins, inner reported in overridden_slots).
describe('split view slot patch / screenshot guards / nested slots', function() {
    var BASE = '<div data-slot="outer"><span data-slot="inner">old-inner</span></div><p data-slot="other">o</p>';

    async function patchFixture(opts) {
        opts = opts || {};
        var versions = [{ version: 1, html: BASE, title: 'T' }];
        var applies = [], requests = [], writes = [];
        var iframe = {
            dataset: { savedWidgetId: 'w1', savedWidgetVersion: '1' },
            isConnected: true,
            contentWindow: { postMessage: function() {} }
        };
        var g = {
            console: console, document: document,
            TOOLS: [], HEADLESS_TOOLS: {}, TOOL_SHORT_DESCRIPTIONS: {},
            currentChatId: 'c1', activeStreamingChatId: null,
            chats: { c1: { id: 'c1', messages: [], widgets: [{ id: 'w1' }] } },
            chatWidgets: {},
            widgetEditTarget: function() { return null; },
            widgetOperationId: async function() { return 'op_' + Math.random(); },
            widgetIdForOperation: async function() { return 'w_new'; },
            recordWidgetRender: function() { return null; },
            saveChatsToStorage: async function() {},
            getSidebarWidgets: function() { return []; },
            getSplitViewRecord: function() { return null; },
            widgetPortRequest: function(fr, msg, replyType) {
                requests.push({ type: msg.type, slots: msg.slots, replyType: replyType });
                return Promise.resolve({ type: replyType, missing: [] });
            },
            writeWidgetHtml: function(fr, html) { writes.push(html); },
            WidgetStore: {
                init: async function() {},
                read: async function() {},
                view: function(id, v) {
                    var latest = versions[versions.length - 1];
                    var sel = v == null ? latest : versions.find(function(x) { return x.version === v; });
                    return sel ? Object.assign({ id: id, contentVersion: sel.version, latestVersion: latest.version, title: sel.title, html: sel.html }, {}) : null;
                },
                commit: async function(id, data, expected) {
                    if (opts.throwCommit) throw new Error('idb down');
                    // Concurrent writer: another agent commits the SAME next
                    // version number first (different html); its synchronous
                    // project() runs the pane update while our patch is noted.
                    if (opts.concurrentHtml) {
                        versions.push({ version: versions.length + 1, html: opts.concurrentHtml, title: 'T' });
                        applies.push(g.__m.splitViewApplyUpdate(iframe, id));
                        opts.concurrentHtml = null;
                    }
                    if (expected !== versions[versions.length - 1].version) return { success: false, code: 'VERSION_CONFLICT', latest_version: versions[versions.length - 1].version };
                    var v = versions.length + 1;
                    versions.push({ version: v, html: data.html, title: data.title });
                    // Mirrors WidgetStore.commit -> project(id) -> refreshWidgetVersionViews:
                    // the pane update runs synchronously INSIDE commit.
                    applies.push(g.__m.splitViewApplyUpdate(iframe, id));
                    return { success: true, id: id, version: v, latest_version: v };
                },
                project: function() {}
            }
        };
        var m = await loadModules(['src/js/core/082-split-view.js', 'src/js/tools/080-widget-tools.js'], { globals: g });
        g.__m = m;
        return { m: m, g: g, applies: applies, requests: requests, writes: writes, iframe: iframe, versions: versions };
    }

    test('(1) patch -> commit order: the shown pane takes the in-place slots path', async function() {
        var f = await patchFixture();
        var r = await f.m.executeHtmlWidget({ action: 'patch', widget_id: 'w1', expected_version: 1, slots: { other: 'NEW' } }, 0, { chatId: 'c1' });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.version, 2);
        assert.deepStrictEqual(f.applies, ['slots'], 'apply inside commit used slots (was: reload)');
        await new Promise(function(res) { setTimeout(res, 0); });
        assert.deepStrictEqual(f.requests.map(function(x) { return x.type; }), ['applySlots']);
        assert.deepStrictEqual(f.requests[0].slots, { other: 'NEW' });
        assert.strictEqual(f.writes.length, 0, 'no full reload');
        assert.deepStrictEqual(Object.keys(f.m._splitViewSlotPatches), [], 'patch consumed, nothing left over');
    }, { tags: ['unit'], timeout: 3000 });

    test('(1) failed / conflicting commits clear the pre-noted patch', async function() {
        var f = await patchFixture({ throwCommit: true });
        var r = await f.m.executeHtmlWidget({ action: 'patch', widget_id: 'w1', expected_version: 1, slots: { other: 'X' } }, 0, { chatId: 'c1' });
        assert.strictEqual(r.code, 'STORAGE_ERROR');
        assert.deepStrictEqual(Object.keys(f.m._splitViewSlotPatches), [], 'cleared after a thrown commit');
        var f2 = await patchFixture();
        f2.versions.push({ version: 2, html: BASE, title: 'T' });
        var r2 = await f2.m.executeHtmlWidget({ action: 'patch', widget_id: 'w1', expected_version: 1, slots: { other: 'X' } }, 0, { chatId: 'c1' });
        assert.strictEqual(r2.code, 'VERSION_CONFLICT');
        assert.deepStrictEqual(Object.keys(f2.m._splitViewSlotPatches), [], 'cleared after VERSION_CONFLICT');
    }, { tags: ['unit'], timeout: 3000 });

    test('(1) concurrent writer committing the same version first never gets our slots', async function() {
        var THEIRS = '<div data-slot="outer">theirs</div><p data-slot="other">theirs</p>';
        var f = await patchFixture({ concurrentHtml: THEIRS });
        var r = await f.m.executeHtmlWidget({ action: 'patch', widget_id: 'w1', expected_version: 1, slots: { other: 'OURS' } }, 0, { chatId: 'c1' });
        assert.strictEqual(r.code, 'VERSION_CONFLICT', 'our commit loses the race');
        assert.deepStrictEqual(f.applies, ['reload'], 'their v2 reloads the pane (was: our slots applied in place)');
        await new Promise(function(res) { setTimeout(res, 0); });
        assert.ok(!f.requests.some(function(x) { return x.type === 'applySlots'; }), 'no in-place applySlots for their content');
        assert.deepStrictEqual(Object.keys(f.m._splitViewSlotPatches), [], 'patch dropped');
    }, { tags: ['unit'], timeout: 3000 });

    test('(1) html guard: same version but different html is never applied in place', async function() {
        var f = await patchFixture();
        f.versions.push({ version: 2, html: BASE, title: 'T' });
        f.m.splitViewNoteSlotPatch('w1', 1, 2, { other: 'X' }, '<p data-slot="other">X</p>');
        assert.strictEqual(f.m.splitViewApplyUpdate(f.iframe, 'w1'), 'reload');
        assert.deepStrictEqual(Object.keys(f.m._splitViewSlotPatches), []);
    }, { tags: ['unit'], timeout: 3000 });

    test('closing or replacing the split pane clears the old widget\'s pending slot patch', async function() {
        var f = await patchFixture();
        await f.m.setSplitViewState('c1', { widgetId: 'w1', version: 1 }).catch(function() {});
        f.m.splitViewNoteSlotPatch('w1', 1, 2, { other: 'X' }, 'h');
        await f.m.setSplitViewState('c1', { widgetId: 'w1', version: 1, progress: {} }).catch(function() {});
        assert.deepStrictEqual(Object.keys(f.m._splitViewSlotPatches), ['w1'], 'same widget still shown: kept');
        await f.m.setSplitViewState('c1', { widgetId: 'w2', version: 1 }).catch(function() {});
        assert.deepStrictEqual(Object.keys(f.m._splitViewSlotPatches), [], 'replaced: cleared');
        await f.m.setSplitViewState('c1', { widgetId: 'w1', version: 1 }).catch(function() {});
        f.m.splitViewNoteSlotPatch('w1', 1, 2, { other: 'X' }, 'h');
        await f.m.setSplitViewState('c1', { closed: true, widgetId: 'w1' }).catch(function() {});
        assert.deepStrictEqual(Object.keys(f.m._splitViewSlotPatches), [], 'closed: cleared');
    }, { tags: ['unit'], timeout: 3000 });

    test('(1) version guard: a patch for a different version is never applied in place', async function() {
        var f = await patchFixture();
        f.m.splitViewNoteSlotPatch('w1', 1, 5, { other: 'stale' });
        f.versions.push({ version: 2, html: BASE, title: 'T' });
        assert.strictEqual(f.m.splitViewApplyUpdate(f.iframe, 'w1'), 'reload');
        assert.ok(!f.requests.some(function(x) { return x.type === 'applySlots'; }), 'no in-place applySlots');
    }, { tags: ['unit'], timeout: 3000 });

    test('(3) nested slots: same result in either key order, inner reported as overridden', async function() {
        var m = await loadModules(['src/js/tools/080-widget-tools.js'], { globals: { console: console, document: document } });
        var a = m.widgetApplySlotsToHtml(BASE, { outer: '<b>OUT</b>', inner: 'IN' });
        var b = m.widgetApplySlotsToHtml(BASE, { inner: 'IN', outer: '<b>OUT</b>' });
        assert.strictEqual(a.success, true, a.error);
        assert.strictEqual(b.success, true, b.error);
        assert.strictEqual(a.html, b.html, 'order-independent html');
        assert.strictEqual(a.html, '<div data-slot="outer"><b>OUT</b></div><p data-slot="other">o</p>');
        assert.deepStrictEqual(a.overridden_slots, ['inner']);
        assert.deepStrictEqual(b.overridden_slots, ['inner']);
        assert.deepStrictEqual(a.applied_slots, { outer: '<b>OUT</b>' });
        var c = m.widgetApplySlotsToHtml(BASE, { inner: 'IN', other: 'P' });
        assert.strictEqual(c.html, '<div data-slot="outer"><span data-slot="inner">IN</span></div><p data-slot="other">P</p>');
        assert.strictEqual(c.overridden_slots, undefined);
        var d = m.widgetApplySlotsToHtml(BASE, { outer: 'x', nope: 'y' });
        assert.strictEqual(d.code, 'SLOT_NOT_FOUND');
        assert.match(d.error, /nope/);
        assert.ok(!/outer/.test(d.error));
    }, { tags: ['unit'], timeout: 3000 });

    // --- (2) screenshot pane ownership ---
    async function shotFixture(paneChatId, paneWidgetId) {
        var captured = 0;
        var frame = { getBoundingClientRect: function() { return { left: 600, top: 60, right: 1000, bottom: 800 }; }, dataset: { savedWidgetId: paneWidgetId } };
        var pane = { hidden: false, dataset: { chatId: paneChatId, widgetId: paneWidgetId }, querySelector: function() { return null; },
            getBoundingClientRect: function() { return { left: 600, top: 0, right: 1000, bottom: 800 }; } };
        function FakeCanvas(w, h) { this.width = w; this.height = h; }
        FakeCanvas.prototype.getContext = function() { return { drawImage: function() {} }; };
        FakeCanvas.prototype.convertToBlob = async function() { return {}; };
        var m = await loadModules(['src/js/tools/060-take-screenshot.js'], { globals: {
            document: { visibilityState: 'visible', body: { classList: { contains: function() { return false; } } },
                getElementById: function(id) { return id === 'split-widget-pane' ? pane : null; } },
            window: { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 },
            chrome: { runtime: {}, tabs: { getCurrent: async function() { return { id: 1, windowId: 2, active: true }; },
                captureVisibleTab: async function() { captured++; return 'data:image/png;base64,F'; } } },
            _splitViewPaneFrame: function() { return frame; },
            resolveRootChatId: function(id) { return { sub1: 'c1' }[id] || id; },
            createImageBitmap: async function() { return { width: 1000, height: 800, close: function() {} }; },
            OffscreenCanvas: FakeCanvas,
            _b64DataUrlToBlob: function() { return {}; },
            _blobToBase64DataUrl: async function() { return 'data:image/png;base64,C'; },
            fitScreenshotScale: function() { return 1; },
            compressBase64Image: async function(s) { return s; },
            newFileId: function() { return 'file_1'; },
            chats: { c1: {}, c2: {}, sub1: {} }, currentChatId: 'c1'
        } });
        return { m: m, captured: function() { return captured; } };
    }

    test('(2) split_widget rejects a pane of another chat family or another widget', async function() {
        var x = await shotFixture('c1', 'w1');
        var r = await x.m.executeTakeScreenshot({ target: 'split_widget' }, { chatId: 'c2' });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.code, 'SPLIT_PANE_OTHER_CHAT');
        assert.match(r.error, /^split pane mismatch/);
        r = await x.m.executeTakeScreenshot({ target: 'split_widget', widget_id: 'w9' }, { chatId: 'c1' });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.code, 'SPLIT_PANE_OTHER_WIDGET');
        assert.match(r.error, /shows widget w1, not w9/);
        assert.strictEqual(x.captured(), 0, 'nothing captured on mismatch');
        r = await x.m.executeTakeScreenshot({ target: 'split_widget', widget_id: 'w1' }, { chatId: 'sub1' });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.widget_id, 'w1');
        assert.strictEqual(x.captured(), 1, 'sub-agent of the same family captures');
    }, { tags: ['unit'], timeout: 3000 });
});
