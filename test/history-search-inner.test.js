// History search scope: default = title + user text + assistant text;
// "Include inner model text" adds tool calls and tool results.
describe('history search scope (ui/180-search.js)', function() {
    async function load() {
        return loadModules(['src/js/ui/180-search.js'], { globals: {
            appStorage: { getItem: function() { return null; }, setItem: function() {} },
            skeletonScanValue: function(slot, id, chat, fn) { return fn(chat); },
            document: { getElementById: function() { return null; } },
            window: {}
        }, lenient: true });
    }
    var chat = { id: 'c1', title: 'Radiators', messages: [
        { role: 'user', content: 'how do I pair the thermostat' },
        { role: 'assistant', content: 'Let me look', tool_calls: [{ function: { name: 'web_search', arguments: '{"q":"zigbee relay"}' } }] },
        { role: 'tool', name: 'web_search', content: 'result mentions matter bridge' },
        { role: 'assistant', content: [{ type: 'text', text: 'Use a Thread border router' }] }
    ] };

    test('default scope matches title, user and assistant text only', async function() {
        var m = await load();
        assert.strictEqual(m.chatMatchesSearch(chat, 'radiat'), true);
        assert.strictEqual(m.chatMatchesSearch(chat, 'thermostat'), true);
        assert.strictEqual(m.chatMatchesSearch(chat, 'border router'), true, 'array content blocks are searched, not thrown on');
        assert.strictEqual(m.chatMatchesSearch(chat, 'zigbee'), false, 'tool args excluded by default');
        assert.strictEqual(m.chatMatchesSearch(chat, 'matter bridge'), false, 'tool results excluded by default');
        assert.deepStrictEqual(m.findAllSearchMatches(chat, 'zigbee'), []);
    }, { tags: ['unit'], timeout: 3000 });

    test('includeInner adds tool calls and tool results', async function() {
        var m = await load();
        var o = { includeInner: true };
        assert.strictEqual(m.chatMatchesSearch(chat, 'zigbee', null, o), true);
        assert.strictEqual(m.chatMatchesSearch(chat, 'matter bridge', null, o), true);
        var snips = m.findAllSearchMatches(chat, 'zigbee', o);
        assert.strictEqual(snips.length, 1);
        assert.strictEqual(snips[0].type, 'tool_call');
        assert.strictEqual(m.findAllSearchMatches(chat, 'matter', o)[0].type, 'tool_result');
    }, { tags: ['unit'], timeout: 3000 });

});
