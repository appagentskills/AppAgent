// revealSubAgentChat must not silently no-op when the page mirror has not yet
// received the sub's chat row (pool-queued / just-spawned / pull in flight).
async function _loadReveal(env) {
    var text = await loadFile('src/js/ui/175-sub-agent-ui.js');
    var start = text.indexOf('function revealSubAgentChat');
    var end = text.indexOf('// ---------- Sidebar breadcrumb');
    var chunk = text.slice(start, end);
    var f = new Function('chats', 'SubAgents', 'selectChat', '_requestChatPull', 'showSnackbar', 't', 'saveChatsToStorage',
        chunk + '; return { reveal: revealSubAgentChat, setTimeoutMs: SUB_REVEAL_PULL_TIMEOUT_MS };');
    return f(env.chats, env.SubAgents, env.selectChat, env.pull, env.snack, function(s) { return s; }, function() {});
}

describe('revealSubAgentChat', function() {
    test('selects immediately when the chat is mirrored', async function() {
        var sel = [];
        var m = await _loadReveal({ chats: { c1: { id: 'c1', isBackground: true } },
            SubAgents: { getById: function(id) { return id === 'a1' ? { chat_id: 'c1' } : null; } },
            selectChat: function(id) { sel.push(id); }, pull: function() {}, snack: function() {} });
        m.reveal('a1');
        assert.deepStrictEqual(sel, ['c1']);
    }, { tags: ['unit'], timeout: 2000 });

    test('pulls a missing chat and selects it once the snapshot lands', async function() {
        var sel = [], pulled = [], chats = {};
        var m = await _loadReveal({ chats: chats,
            SubAgents: { getById: function(id) { return id === 'a1' ? { chat_id: 'c1' } : null; } },
            selectChat: function(id) { sel.push(id); },
            pull: function(id) { pulled.push(id); chats.c1 = { id: 'c1', isBackground: true }; },
            snack: function() {} });
        m.reveal('a1');
        assert.deepStrictEqual(pulled, ['c1']);
        await sleep(400);
        assert.deepStrictEqual(sel, ['c1']);
    }, { tags: ['unit'], timeout: 3000 });

    test('shows a snackbar when the chat never arrives', async function() {
        var sel = [], snacks = 0;
        var m = await _loadReveal({ chats: {}, SubAgents: { getById: function() { return null; } },
            selectChat: function(id) { sel.push(id); }, pull: function() {}, snack: function() { snacks++; } });
        m.reveal('gone');
        // The timeout is counted in setTimeout hops (waitedMs += POLL_MS), not wall
        // time, so under main-thread load (dense parallel test shards) the snackbar
        // can land well after setTimeoutMs. Poll for it with a generous deadline
        // instead of a fixed sleep with thin slack.
        await sleep(m.setTimeoutMs);
        var deadline = Date.now() + 10000;
        while (snacks === 0 && Date.now() < deadline) await sleep(100);
        assert.strictEqual(snacks, 1);
        assert.deepStrictEqual(sel, []);
        // No duplicate snackbar / late select after the poll chain ended.
        await sleep(300);
        assert.strictEqual(snacks, 1);
        assert.deepStrictEqual(sel, []);
    }, { tags: ['unit'], timeout: 20000 });
});
