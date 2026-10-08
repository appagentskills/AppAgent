// Explicit tab_id contract for browser actions (PR #1159): no active-tab / chat-pin
// fallback, tab_id:"new" only on navigate, own extension tab readable/screenshottable
// but never navigable. Real src/js/tools/010-iframe-tool.js with a fake chrome.
describe('explicit tab_id', function() {
    var EXT = 'chrome-extension://abc/';
    async function load(tabs) {
        var calls = { get: [], query: 0, sent: [] };
        var chromeStub = {
            runtime: { getURL: function(p) { return EXT + (p || ''); } },
            tabs: {
                get: async function(id) { calls.get.push(id); if (!tabs[id]) throw new Error('No tab with id: ' + id); return Object.assign({ id: id }, tabs[id]); },
                query: async function() { calls.query++; return [{ id: 1, url: 'https://active.example/' }]; }
            }
        };
        var plat = { sendBrowserAction: function(a, args, tabId) { calls.sent.push([a, tabId]); return Promise.resolve({ success: true }); } };
        var m = await loadModules(['src/js/tools/010-iframe-tool.js'], { lenient: true, globals: {
            chrome: chromeStub, Platform: plat, chats: {}, currentChatId: undefined
        } });
        return { m: m, calls: calls };
    }
    var TABS = { 7: { url: 'https://dev1.service-now.com/x' }, 9: { url: EXT + 'app.html?mode=tab' } };

    test('missing tab_id is an error for every browser action (no active-tab fallback)', async function() {
        var x = await load(TABS);
        for (var a of ['navigate', 'click', 'get_visible_text', 'get_page_info', 'resize']) {
            var r = await x.m.executeIframeTool({ action: a, url: '/x', selector: 'b', instance: 'dev1' }, {});
            assert.strictEqual(r.success, false, a + ' fails');
            assert.match(r.error, /tab_id is required/, a + ' error names tab_id');
        }
        var t = await x.m.resolveBrowserTabTarget(undefined, 'take_screenshot', { toolLabel: 'take_screenshot target=browser' });
        assert.match(t.error, /tab_id is required for take_screenshot/);
        assert.strictEqual(x.calls.query, 0, 'active tab never queried');
        assert.deepStrictEqual(x.calls.sent, [], 'nothing dispatched');
    }, { tags: ['unit'], timeout: 5000 });

    test('tab_id:"new" is accepted only for navigate', async function() {
        var x = await load(TABS);
        assert.deepStrictEqual(await x.m.resolveBrowserTabTarget('new', 'navigate'), { tabId: 'new' });
        var r = await x.m.resolveBrowserTabTarget('new', 'click');
        assert.match(r.error, /only valid for navigate/);
        r = await x.m.executeIframeTool({ action: 'get_dom', tab_id: 'new' }, {});
        assert.strictEqual(r.success, false); assert.match(r.error, /only valid for navigate/);
        r = await x.m.resolveBrowserTabTarget('new', 'take_screenshot');
        assert.match(r.error, /only valid for navigate/, 'screenshot cannot use new');
    }, { tags: ['unit'], timeout: 5000 });

    test('invalid and closed tab ids are rejected; numeric strings coerce', async function() {
        var x = await load(TABS);
        assert.match((await x.m.resolveBrowserTabTarget('abc', 'click')).error, /Invalid tab_id/);
        assert.match((await x.m.resolveBrowserTabTarget(1.5, 'click')).error, /Invalid tab_id/);
        assert.match((await x.m.resolveBrowserTabTarget(99, 'click')).error, /not an open tab/);
        assert.strictEqual((await x.m.resolveBrowserTabTarget('7', 'click')).tabId, 7);
    }, { tags: ['unit'], timeout: 5000 });

    test('own extension tab: screenshot/read allowed, navigate blocked', async function() {
        var x = await load(TABS);
        var s = await x.m.resolveBrowserTabTarget(9, 'take_screenshot', { toolLabel: 'take_screenshot target=browser' });
        assert.strictEqual(s.error, undefined, 'own-tab screenshot allowed');
        assert.strictEqual(s.tabId, 9);
        assert.strictEqual((await x.m.resolveBrowserTabTarget(9, 'get_visible_text')).tabId, 9, 'own-tab read allowed');
        var n = await x.m.resolveBrowserTabTarget(9, 'navigate');
        assert.match(n.error, /extension's own tab/);
        var r = await x.m.executeIframeTool({ action: 'navigate', url: '/x', tab_id: 9, instance: 'dev1' }, {});
        assert.strictEqual(r.success, false); assert.match(r.error, /own tab/);
        assert.deepStrictEqual(x.calls.sent, [], 'blocked navigate never dispatched');
        assert.strictEqual((await x.m.resolveBrowserTabTarget(7, 'navigate')).tabId, 7, 'instance tab navigable');
    }, { tags: ['unit'], timeout: 5000 });
});
