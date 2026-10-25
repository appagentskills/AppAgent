// Browser tools may target ANY website tab (not only ServiceNow / extension
// tabs): real src/js/tools/010-iframe-tool.js + 020 _liOtherTabInfo, fake chrome.
describe('browser tools on any website', function() {
    var EXT = 'chrome-extension://abc/';
    var TABS = {
        3: { url: 'https://www.example.com/page' },
        4: { url: 'chrome://newtab/' },
        5: { url: 'https://chromewebstore.google.com/detail/x' },
        6: { url: 'chrome-extension://other/popup.html' },
        7: { url: 'https://dev1.service-now.com/x' },
        8: { url: 'about:blank' },
        9: { url: EXT + 'app.html?mode=tab' }
    };
    async function load() {
        var sent = [];
        var chromeStub = {
            runtime: { getURL: function(p) { return EXT + (p || ''); } },
            tabs: {
                get: async function(id) { if (!TABS[id]) throw new Error('No tab'); return Object.assign({ id: id }, TABS[id]); },
                query: async function() { return Object.keys(TABS).map(function(k) { return Object.assign({ id: Number(k), title: 't' + k, active: false, windowId: 1 }, TABS[k]); }); }
            }
        };
        var m = await loadModules(['src/js/tools/010-iframe-tool.js'], { lenient: true, globals: {
            chrome: chromeStub, Platform: { sendBrowserAction: function(a, args, tabId) { sent.push([a, tabId]); return Promise.resolve({ success: true }); } }, chats: {}, currentChatId: undefined
        } });
        return { m: m, sent: sent, chrome: chromeStub };
    }

    test('regular website tab is a valid target for every action', async function() {
        var x = await load();
        for (var a of ['click', 'get_dom', 'fill', 'take_screenshot', 'navigate', 'get_visible_text']) {
            var r = await x.m.resolveBrowserTabTarget(3, a);
            assert.strictEqual(r.error, undefined, a + ' allowed on example.com');
            assert.strictEqual(r.tabId, 3);
        }
        assert.strictEqual((await x.m.resolveBrowserTabTarget(8, 'get_dom')).tabId, 8, 'about:blank not restricted');
    }, { tags: ['unit'], timeout: 5000 });

    test('browser-internal pages refused for read/click/capture, but navigable away / closable', async function() {
        var x = await load();
        for (var id of [4, 5, 6]) {
            assert.match((await x.m.resolveBrowserTabTarget(id, 'click')).error, /browser-internal/, 'click ' + id);
            assert.match((await x.m.resolveBrowserTabTarget(id, 'take_screenshot')).error, /browser-internal/, 'shot ' + id);
        }
        assert.strictEqual((await x.m.resolveBrowserTabTarget(4, 'navigate')).tabId, 4, 'navigate away from newtab ok');
        assert.strictEqual((await x.m.resolveBrowserTabTarget(4, 'close')).tabId, 4, 'close ok');
        var r = await x.m.executeIframeTool({ action: 'navigate', url: 'chrome://settings', tab_id: 3 }, {});
        assert.strictEqual(r.success, false); assert.match(r.error, /browser-internal/);
        assert.deepStrictEqual(x.sent, [], 'refused navigate never dispatched');
        assert.strictEqual(x.m._isBrowserInternalUrl(EXT + 'app.html'), false, 'own extension handled separately');
        assert.strictEqual(x.m._isBrowserInternalUrl('https://chrome.google.com/webstore/detail/y'), true);
        assert.strictEqual(x.m._isBrowserInternalUrl('https://google.com/'), false);
    }, { tags: ['unit'], timeout: 5000 });

    test('_liOtherTabInfo lists non-SN, non-extension tabs with restricted flag', async function() {
        var x = await load();
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var start = src.indexOf('async function _liOtherTabInfo');
        var end = src.indexOf('// Execute set_chat_title tool', start);
        assert.ok(start > 0 && end > start, 'function found');
        var fn = new Function('chrome', '_isBrowserInternalUrl', src.slice(start, end) + '; return _liOtherTabInfo;')(x.chrome, x.m._isBrowserInternalUrl);
        var rows = await fn([7]);
        assert.deepStrictEqual(rows.map(function(t) { return t.id; }), [3, 4, 5, 6, 8]);
        assert.strictEqual(rows[0].restricted, undefined);
        assert.strictEqual(rows[0].url, 'https://www.example.com/page');
        assert.strictEqual(rows[1].restricted, true);
        assert.strictEqual(rows[2].restricted, true);
    }, { tags: ['unit'], timeout: 5000 });
});
