// SW-EVICT (memory footprint): the service worker now evicts heavy text
// bodies (boot load + post-save sweep). Drives the REAL
// src/js/core/130-indexeddb.js: report_to_parent / update_action_state
// argument exemption, parked-tool-call skip, the save-race bodyGuard, and the
// deferred idempotent boot-cleanup scheduler.
describe('SW body eviction + deferred boot cleanup', function() {
    var U = { tags: ['unit'], timeout: 20000 };
    var BIG = 'Z'.repeat(2000);

    async function load(chatsMap, extra) {
        var g = Object.assign({ STORAGE_PREFIX: 'test_', chats: chatsMap || {}, _chatsHydrated: true,
            console: { log: function() {}, info: function() {}, warn: function() {}, error: function() {}, debug: function() {} } }, extra || {});
        return await loadModules(['src/js/core/130-indexeddb.js'], { globals: g });
    }
    function mkChat(id, name) {
        return { id: id, updatedAt: 1, messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: name, arguments: '{"summary":"' + BIG + '"}' } }] },
            { role: 'tool', tool_call_id: 't1', content: BIG }
        ] };
    }

    test('report_to_parent / update_action_state args are never evicted; other tool args are', async function() {
        var m = await load({});
        ['report_to_parent', 'update_action_state'].forEach(function(n) {
            var c = mkChat('c_' + n, n);
            assert.strictEqual(m.chatHasEvictableBodies({ id: 'x', messages: [c.messages[0], c.messages[1]] }), false, n + ': args alone are not evictable');
            m.stripChatPayloadsInPlace(c, true);
            assert.ok(c.messages[1].tool_calls[0].function.arguments.length > 1000, n + ' args kept');
            assert.strictEqual(c.messages[2].content, undefined, n + ': its large tool RESULT is still evicted');
        });
        var o = mkChat('c_other', 'servicenow_api');
        assert.strictEqual(m.chatHasEvictableBodies(o), true);
        m.stripChatPayloadsInPlace(o, true);
        assert.strictEqual(o.messages[1].tool_calls[0].function.arguments, '', 'other args evicted');
        assert.strictEqual(o._payloadsEvicted, true);
    }, U);

    test('sweep skips chats with parked tool calls', async function() {
        var map = { a: mkChat('a', 'x'), b: mkChat('b', 'x') };
        var m = await load(map, { parkedToolCallsByChatId: { a: [{ id: 'p1' }] } });
        var n = m.sweepColdChatPayloads(0, true);
        assert.strictEqual(n, 1);
        assert.ok(map.a.messages[2].content.length > 1000, 'parked chat untouched');
        assert.strictEqual(map.b.messages[2].content, undefined, 'unparked chat body-evicted');
    }, U);

    test('bodyGuard: refused chats keep bodies (b64 leg only), accepted chats are body-evicted; no guard = old behavior', async function() {
        var mk = function(id) {
            var c = mkChat(id, 'x');
            c.messages.push({ role: 'user', content: 'img', file_id: 'f_' + id, base64: 'QUFB' });
            return c;
        };
        var map = { ok: mk('ok'), no: mk('no') };
        var m = await load(map);
        var seen = [];
        m.sweepColdChatPayloads(0, true, function(id, c) { seen.push(id); return id === 'ok'; });
        assert.deepStrictEqual(seen.sort(), ['no', 'ok'], 'guard asked exactly once per chat (msg + bodies legs share the verdict)');
        // C2-final (CHAT_MESSAGE_EVICTION_ENABLED on): the guard proof lets the
        // whole-message leg drop the accepted chat's messages entirely (a
        // superset of body eviction); the stored row restores them.
        assert.strictEqual(map.ok.messages, undefined, 'guarded-ok chat message-evicted');
        assert.strictEqual(map.ok._messagesEvicted, true);
        assert.strictEqual(map.ok._msgCount, 4);
        assert.deepStrictEqual(Object.keys(map.ok._evictedPayloadRefs), ['f_ok'], 'blob ref stamped on the skeleton');
        assert.ok(map.no.messages[2].content.length > 1000, 'refused chat keeps its body');
        assert.strictEqual(map.no.messages[3].base64, undefined, 'refused chat still gets the b64 strip');
        assert.strictEqual(map.no.messages[3]._b64Evicted, true);
        var map2 = { p: mk('p') };
        var m2 = await load(map2);
        m2.sweepColdChatPayloads(0, true);
        assert.strictEqual(map2.p.messages[2].content, undefined, 'no guard: bodies evicted as before');
    }, U);

    test('report_to_parent RESULT rows are never body-evicted (lost-report recovery reads them)', async function() {
        var m = await load({});
        var c = mkChat('c_rtp', 'report_to_parent');
        c.messages[2].name = 'report_to_parent';
        c.messages[2].content = '{"success":true,"ok":true,"note":"' + BIG + '"}';
        assert.strictEqual(m.chatHasEvictableBodies(c), false, 'rtp result row alone is not evictable');
        m.stripChatPayloadsInPlace(c, true);
        assert.ok(c.messages[2].content.length > 1000, 'rtp result kept');
        var o = mkChat('c_o', 'servicenow_api');
        o.messages[1].tool_calls[0].function.arguments = '{}';
        o.messages[2].name = 'servicenow_api';
        assert.strictEqual(m.chatHasEvictableBodies(o), true, 'other named result rows still evictable');
        m.stripChatPayloadsInPlace(o, true);
        assert.strictEqual(o.messages[2].content, undefined, 'other result evicted');
    }, U);

    test('_repaintParent stamps an evicted parent _dirtyWhileEvicted before saving (review must-fix)', async function() {
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        var at = src.indexOf('function _repaintParent(');
        var end = src.indexOf('\n}\n', at);
        assert.ok(at >= 0 && end > at, '_repaintParent found');
        var saves = [];
        var map = { p: { id: 'p', _payloadsEvicted: true, messages: [] }, q: { id: 'q', messages: [] } };
        var fn = new Function('chats', 'saveChatsToStorage', 'AgentEvents', src.slice(at, end + 2) + '\n;return _repaintParent;')(
            map, function() { saves.push(!!map.p._dirtyWhileEvicted); }, undefined);
        fn('p');
        assert.strictEqual(map.p._dirtyWhileEvicted, true, 'evicted parent stamped dirty');
        assert.deepStrictEqual(saves, [true], 'stamp lands BEFORE the save runs');
        fn('q');
        assert.strictEqual(map.q._dirtyWhileEvicted, undefined, 'hydrated parent not stamped');
        fn('missing'); // no throw
    }, U);

    test('scheduleDeferredBootCleanup: deferred, once per name, failures swallowed', async function() {
        var m = await load({});
        var runs = 0;
        assert.strictEqual(m.scheduleDeferredBootCleanup('t', function() { runs++; return Promise.resolve(1); }, 0), true);
        assert.strictEqual(m.scheduleDeferredBootCleanup('t', function() { runs += 100; }, 0), false, 'second schedule is a no-op');
        assert.strictEqual(runs, 0, 'not run synchronously');
        assert.strictEqual(m.scheduleDeferredBootCleanup('bad', function() { return Promise.reject(new Error('x')); }, 0), true);
        for (var i = 0; i < 100 && runs === 0; i++) await new Promise(function(r) { setTimeout(r, 50); });
        assert.strictEqual(runs, 1, 'ran exactly once');
    }, U);
});
