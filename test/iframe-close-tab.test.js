// iframe_tool close with an explicit tab_id must really remove that Chrome tab
// (previously background.js answered {success:true} without touching it).
// Real src/js/tools/010-iframe-tool.js + the real background.js handleCloseTab
// and browser-action 'close' branch, wired through a fake chrome.
describe('iframe_tool close tab_id closes the Chrome tab', function() {
    var EXT = 'chrome-extension://abc/';
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + start);
        return text.slice(a, b);
    }
    function fakeChrome(tabs, opts) {
        opts = opts || {};
        var calls = { remove: [] };
        var chrome = {
            runtime: { getURL: function(p) { return EXT + (p || ''); } },
            tabs: {
                get: async function(id) { if (!tabs[id]) throw new Error('No tab with id: ' + id); return Object.assign({ id: id }, tabs[id]); },
                remove: async function(id) { calls.remove.push(id); if (!opts.stuck) delete tabs[id]; }
            }
        };
        return { chrome: chrome, calls: calls };
    }
    async function bgRouter(chrome) {
        var bg = await loadFile('src/platform/extension/background.js');
        var helpers = between(bg, 'function isExtensionOwnTabUrl(u) {', '// --- end handleCloseTab ---');
        var branch = between(bg, "        if (message.action === 'close') {", '        // Forward to content script');
        var mk = new Function('chrome', helpers + '\nreturn { handleCloseTab: handleCloseTab, route: function(message, sendResponse) {\n' + branch + '\n} };');
        var api = mk(chrome);
        return function(action, args, tabId) {
            return new Promise(function(resolve) {
                var targetTabId = (typeof tabId === 'number') ? tabId : null;
                var sync = api.route({ type: 'browser-action', action: action, args: args, targetTabId: targetTabId }, resolve);
                if (sync === undefined && action !== 'close') resolve({ error: 'not routed' });
            });
        };
    }
    async function load(tabs, opts) {
        var f = fakeChrome(tabs, opts);
        var send = await bgRouter(f.chrome);
        var sent = [];
        var plat = { sendBrowserAction: function(a, args, id) { sent.push([a, id]); return send(a, args, id); } };
        var m = await loadModules(['src/js/tools/010-iframe-tool.js'], { lenient: true, globals: {
            chrome: f.chrome, Platform: plat, chats: {}, currentChatId: undefined,
            document: { body: { classList: { contains: function() { return false; } } } }
        } });
        return { m: m, calls: f.calls, sent: sent, tabs: tabs };
    }

    test('close with tab_id removes the tab and reports success only after it is gone', async function() {
        var x = await load({ 525431368: { url: 'https://dev1.service-now.com/x' } });
        var r = await x.m.executeIframeTool({ action: 'close', tab_id: 525431368 }, {});
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.closed, true);
        assert.strictEqual(r.tab_id, 525431368);
        assert.deepStrictEqual(x.calls.remove, [525431368]);
        assert.strictEqual(x.tabs[525431368], undefined, 'tab gone');
    }, { tags: ['unit'], timeout: 5000 });

    test('numeric-string tab_id coerces and closes', async function() {
        var x = await load({ 7: { url: 'https://a.example/' } });
        var r = await x.m.executeIframeTool({ action: 'close', tab_id: '7' }, {});
        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(x.calls.remove, [7]);
    }, { tags: ['unit'], timeout: 5000 });

    test('refuses to close the extension own tab (page and background guards)', async function() {
        var x = await load({ 9: { url: EXT + 'app.html?mode=tab' } });
        var r = await x.m.executeIframeTool({ action: 'close', tab_id: 9 }, {});
        assert.strictEqual(r.success, false);
        assert.match(r.error, /extension's own tab/);
        assert.deepStrictEqual(x.calls.remove, []);
        assert.deepStrictEqual(x.sent, [], 'page guard stops before dispatch');
        var f = fakeChrome({ 9: { url: EXT + 'app.html' } });
        var bgResp = await (await bgRouter(f.chrome))('close', {}, 9);
        assert.match(bgResp.error, /extension's own tab/, 'background also refuses');
        assert.deepStrictEqual(f.calls.remove, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('closed/unknown/invalid tab ids are errors, never success', async function() {
        var x = await load({});
        var r = await x.m.executeIframeTool({ action: 'close', tab_id: 42 }, {});
        assert.strictEqual(r.success, false); assert.match(r.error, /not an open tab/);
        r = await x.m.executeIframeTool({ action: 'close', tab_id: 'abc' }, {});
        assert.strictEqual(r.success, false); assert.match(r.error, /Invalid tab_id/);
        r = await x.m.executeIframeTool({ action: 'close', tab_id: 'new' }, {});
        assert.strictEqual(r.success, false); assert.match(r.error, /only valid for navigate/);
        assert.deepStrictEqual(x.calls.remove, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('remove that leaves the tab open reports an error', async function() {
        var x = await load({ 5: { url: 'https://a.example/' } }, { stuck: true });
        var r = await x.m.executeIframeTool({ action: 'close', tab_id: 5 }, {});
        assert.strictEqual(r.success, false);
        assert.match(r.error, /still open/);
        assert.deepStrictEqual(x.calls.remove, [5]);
    }, { tags: ['unit'], timeout: 5000 });

    test('close without tab_id keeps the legacy no-op (nothing removed)', async function() {
        var x = await load({ 5: { url: 'https://a.example/' } });
        var r = await x.m.executeIframeTool({ action: 'close' }, {});
        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(x.calls.remove, []);
        assert.ok(x.tabs[5], 'tab untouched');
    }, { tags: ['unit'], timeout: 5000 });
});
