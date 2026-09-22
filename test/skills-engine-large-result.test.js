// #10 — large skill-tool results must reach the agent in FULL (so the normal
// >16 KB `_cached` path / cached_content_* tools can see them) while still being
// stored per chat for js_eval's `lastLargeResponse`. Sandbox callers unchanged.
describe('skills engine large result handling (140-skills-engine.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/core/140-skills-engine.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        return M;
    }
    function bigResult() {
        var items = [];
        for (var i = 0; i < 200; i++) items.push({ id: i, name: 'item ' + i });
        return { success: true, status: 200, items: items };
    }
    function wire(m, swResult) {
        var stored = [];
        m.__scope.setLastLargeResponse = function(chatId, value) { stored.push({ chatId: chatId, value: value }); };
        m.__scope.activeStreamingChatId = null;
        m.__scope.currentChatId = 'chat-x';
        m.__scope.Platform = { isWorker: true, callOffscreenHelper: async function() { return swResult; } };
        m.skillTools['sk'] = { big_tool: { code: 'async function big_tool(){}', name: 'big_tool', definition: {} } };
        return stored;
    }
    test('SW path, non-sandbox caller: full result returned (no preview), stored for js_eval, notice mentions both channels', async function() {
        var m = await load();
        var big = bigResult();
        var stored = wire(m, big);
        var r = await m.executeSkillTool('big_tool', {}, { chatId: 'c1' }, 3);
        assert.strictEqual(r._response_truncated, undefined, 'preview branch must be gone');
        assert.strictEqual(r.preview, undefined);
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.items.length, 200, 'full payload must be present');
        assert.strictEqual(stored.length, 1, 'setLastLargeResponse still called once');
        assert.strictEqual(stored[0].chatId, 'c1');
        assert.strictEqual(stored[0].value, big, 'the ORIGINAL object is stored (not a copy)');
        assert.ok(/lastLargeResponse/.test(r._notice), '_notice mentions lastLargeResponse: ' + r._notice);
        assert.ok(/cached_content_/.test(r._notice), '_notice mentions cached_content_*: ' + r._notice);
        assert.strictEqual(big._notice, undefined, 'stored object is not mutated with the notice');
    });
    test('SW path, sandbox caller (fromSandbox): result returned untouched, nothing stored', async function() {
        var m = await load();
        var big = bigResult();
        var stored = wire(m, big);
        var r = await m.executeSkillTool('big_tool', {}, { chatId: 'c1', fromSandbox: true }, 3);
        assert.strictEqual(r, big);
        assert.strictEqual(r._notice, undefined);
        assert.strictEqual(stored.length, 0);
    });
    test('SW path, small result: returned untouched, nothing stored', async function() {
        var m = await load();
        var small = { success: true, n: 1 };
        var stored = wire(m, small);
        var r = await m.executeSkillTool('big_tool', {}, { chatId: 'c1' }, 3);
        assert.strictEqual(r, small);
        assert.strictEqual(stored.length, 0);
    });
    test('SW path, large ARRAY result: returned as-is (no notice key can be attached) but stored', async function() {
        var m = await load();
        var arr = [];
        for (var i = 0; i < 100; i++) arr.push({ i: i });
        var stored = wire(m, arr);
        var r = await m.executeSkillTool('big_tool', {}, { chatId: 'c1' }, 3);
        assert.strictEqual(r, arr);
        assert.strictEqual(stored.length, 1);
    });
});
