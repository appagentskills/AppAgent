// Follow-ups to the explicit tab_id contract (PR #1160): list_instances own-tab info
// (_liExtensionTabInfo -> selfTabId / extensionTabs) and the take_screenshot
// browser/element path. Real modules, fake chrome; no lenient loading.
describe('explicit tab_id follow-ups', function() {
    var EXT = 'chrome-extension://abc/';

    describe('_liExtensionTabInfo', function() {
        async function load(tabs, opts) {
            opts = opts || {};
            var chromeStub = {
                runtime: { getURL: function(p) { return EXT + (p || ''); } },
                tabs: {
                    query: async function() { return tabs; },
                    getCurrent: async function() { return opts.current || undefined; }
                }
            };
            var doc = { body: { classList: { contains: function(c) { return !!opts.sidepanel && c === 'sidepanel-mode'; } } } };
            return loadModules(['src/js/tools/020-tool-execution.js'], { globals: { chrome: chromeStub, document: doc } });
        }
        var TABS = [
            { id: 3, url: 'https://dev1.service-now.com/incident.do', title: 'INC', active: true, windowId: 1 },
            { id: 9, url: EXT + 'app.html?mode=tab', title: 'AppAgent', active: false, windowId: 1 },
            { id: 11, url: EXT + 'app.html?mode=tab&widget=w1', title: 'Widget', active: false, windowId: 2 }
        ];

        test('lists only extension tabs and infers selfTabId from the single plain app tab', async function() {
            var m = await load(TABS);
            var info = await m._liExtensionTabInfo();
            assert.deepStrictEqual(info.extensionTabs.map(function(t) { return t.id; }), [9, 11]);
            assert.deepStrictEqual(info.extensionTabs[0], { id: 9, title: 'AppAgent', url: EXT + 'app.html?mode=tab', active: false, windowId: 1 });
            assert.strictEqual(info.selfTabId, 9, 'widget tab is not a plain app tab');
        }, { tags: ['unit'], timeout: 5000 });

        test('chrome.tabs.getCurrent wins; sidepanel or ambiguous app tabs give null', async function() {
            var m = await load(TABS, { current: { id: 11 } });
            assert.strictEqual((await m._liExtensionTabInfo()).selfTabId, 11, 'getCurrent wins');
            m = await load(TABS, { sidepanel: true });
            var sp = await m._liExtensionTabInfo();
            assert.strictEqual(sp.selfTabId, null, 'sidepanel has no own tab');
            assert.strictEqual(sp.extensionTabs.length, 2, 'extension tabs still listed');
            var two = TABS.concat([{ id: 12, url: EXT + 'app.html?mode=tab', title: 'AppAgent 2', windowId: 3 }]);
            m = await load(two);
            assert.strictEqual((await m._liExtensionTabInfo()).selfTabId, null, 'two plain app tabs -> ambiguous');
        }, { tags: ['unit'], timeout: 5000 });

        test('never throws: missing chrome or failing query yields defaults', async function() {
            var m = await loadModules(['src/js/tools/020-tool-execution.js'], { globals: { chrome: undefined, document: undefined } });
            assert.deepStrictEqual(await m._liExtensionTabInfo(), { selfTabId: null, extensionTabs: [] });
            var bad = { runtime: { getURL: function() { return EXT; } }, tabs: { query: async function() { throw new Error('boom'); } } };
            m = await loadModules(['src/js/tools/020-tool-execution.js'], { globals: { chrome: bad, document: undefined } });
            assert.deepStrictEqual(await m._liExtensionTabInfo(), { selfTabId: null, extensionTabs: [] });
        }, { tags: ['unit'], timeout: 5000 });
    });

    describe('take_screenshot browser/element target', function() {
        var TABS = { 7: { url: 'https://dev1.service-now.com/x' }, 9: { url: EXT + 'app.html?mode=tab' } };
        async function load() {
            var calls = { get: [], query: 0, sent: [] };
            var chromeStub = {
                runtime: { getURL: function(p) { return EXT + (p || ''); } },
                tabs: {
                    get: async function(id) { calls.get.push(id); if (!TABS[id]) throw new Error('No tab with id: ' + id); return Object.assign({ id: id }, TABS[id]); },
                    query: async function() { calls.query++; return [{ id: 1, url: 'https://active.example/' }]; }
                }
            };
            // Stop right after dispatch: the test asserts the routed tab id, not image processing.
            var plat = { sendBrowserAction: function(a, args, tabId) { calls.sent.push([a, tabId]); return Promise.resolve({ error: 'stub-stop' }); } };
            var m = await loadModules(['src/js/tools/010-iframe-tool.js', 'src/js/tools/060-take-screenshot.js'], { globals: {
                chrome: chromeStub, Platform: plat, chats: {}, currentChatId: undefined
            } });
            return { m: m, calls: calls };
        }

        test('missing tab_id is an error for browser and element targets', async function() {
            var x = await load();
            var r = await x.m.executeTakeScreenshot({ target: 'browser', name: 'x' }, {});
            assert.strictEqual(r.success, false);
            assert.match(r.error, /tab_id is required for take_screenshot target "browser"/);
            r = await x.m.executeTakeScreenshot({ target: 'element', selector: 'body', name: 'x' }, {});
            assert.strictEqual(r.success, false);
            assert.match(r.error, /tab_id is required for take_screenshot target "element"/);
            r = await x.m.executeTakeScreenshot({ target: 'browser', tab_id: 'new', name: 'x' }, {});
            assert.match(r.error, /only valid for navigate/);
            assert.strictEqual(x.calls.query, 0, 'active tab never queried');
            assert.deepStrictEqual(x.calls.sent, [], 'nothing captured');
        }, { tags: ['unit'], timeout: 5000 });

        test('own extension tab id is allowed and passed through to the capture', async function() {
            var x = await load();
            var r = await x.m.executeTakeScreenshot({ target: 'browser', tab_id: 9, name: 'own' }, {});
            assert.deepStrictEqual(x.calls.sent, [['take_screenshot', 9]], 'captured the own tab');
            assert.strictEqual(r.error, 'stub-stop', 'reached the capture (no tab_id refusal)');
            await x.m.executeTakeScreenshot({ target: 'browser', tab_id: '7', name: 'inst' }, {});
            assert.deepStrictEqual(x.calls.sent[1], ['take_screenshot', 7], 'numeric string coerced');
            r = await x.m.executeTakeScreenshot({ target: 'browser', tab_id: 99, name: 'gone' }, {});
            assert.match(r.error, /not an open tab/);
            assert.strictEqual(x.calls.sent.length, 2, 'closed tab never captured');
        }, { tags: ['unit'], timeout: 5000 });
    });
});
