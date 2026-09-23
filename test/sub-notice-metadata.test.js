// SUB-NOTICE-META (B part 2a): pending-injection writers keep every entry
// field and append structured `subNotices`; idle injected rows carry them.
// Runs against the REAL registry (core/097-sub-agent-registry.js).
describe('sub-notice metadata (producer side)', function() {
    var m, chats, pend, running;
    var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
    beforeEach(async function() {
        chats = { root: { messages: [] } }; pend = {}; running = {};
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: running, pendingInjectionsByChatId: pend,
            isChatPaused: function() { return false; },
            runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); },
            openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function kid() {
        var h = m.Handles.start('root', 'spawn_sub_agent', {}, 'kid', function() { return new Promise(function() {}); });
        var r = { agent_id: 'kid', chat_id: 'c_kid', name: 'Kid', state: 'running', spawn_handle_id: h.handleId,
            parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now() };
        m._subAgents.kid = r;
        chats.c_kid = { isSubAgent: true, subAgentId: 'kid', messages: [] };
        return r;
    }

    test('live writer merge keeps prior fields + subNotices and appends this notice meta', async function() {
        var rec = kid(); running.root = true;
        var prior = { kind: 'message', agentId: 'x', name: 'X', status: null, summary: 's', text: 'user typed' };
        pend.root = { text: 'user typed', images: [], hasUserText: true, subNotices: [prior] };
        assert.strictEqual(m._notifySubLifecycle(rec, 'crashed (boom)'), true);
        var e = pend.root;
        assert.strictEqual(e.hasUserText, true, 'hasUserText kept');
        assert.strictEqual(e.subNotices.length, 2, 'prior kept + one appended');
        assert.strictEqual(e.subNotices[0], prior);
        var meta = e.subNotices[1];
        assert.strictEqual(meta.kind, 'lifecycle');
        assert.strictEqual(meta.agentId, 'kid');
        assert.strictEqual(meta.name, 'Kid');
        assert.strictEqual(e.text, 'user typed\n\n' + meta.text, 'model text unchanged, meta.text is the exact appended notice');
    });

    test('live report: entry text is the flattened notice, meta kind final with full summary', async function() {
        var rec = kid(); running.root = true;
        m._wakeParentOnReport(rec, { status: 'done', summary: 'line1\nline2' }, { hadAwaiters: false });
        var e = pend.root;
        assert.ok(e && e.subNotices && e.subNotices.length === 1);
        assert.strictEqual(e.subNotices[0].kind, 'final');
        assert.strictEqual(e.subNotices[0].status, 'done');
        assert.strictEqual(e.subNotices[0].summary, 'line1\nline2');
        assert.strictEqual(e.text, e.subNotices[0].text, 'text === exact notice');
        assert.strictEqual(e.hasUserText, undefined, 'notice-only entry has no hasUserText');
    });

    test('idle report: injected row carries subNotices, no hasUserText', async function() {
        var rec = kid();
        m._wakeParentOnReport(rec, { status: 'need_input', summary: 'which one?' }, { hadAwaiters: false });
        var rows = chats.root.messages.filter(function(x) { return x.role === 'user'; });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].injected, true);
        assert.strictEqual(rows[0].subNotices.length, 1);
        assert.strictEqual(rows[0].subNotices[0].kind, 'mid');
        assert.strictEqual(rows[0].subNotices[0].text, rows[0].content);
        assert.strictEqual(rows[0].hasUserText, undefined);
    });

    test('idle lifecycle row + _pushPendingWakeRows accept metas (legacy strings still work)', async function() {
        var rec = kid();
        m._notifySubLifecycle(rec, 'force-stopped');
        var r0 = chats.root.messages[0];
        assert.strictEqual(r0.subNotices[0].kind, 'lifecycle');
        assert.strictEqual(r0.subNotices[0].text, r0.content);
        await m._pushPendingWakeRows(chats.root, ['legacy', { text: 'T', subNotices: [{ kind: 'final', text: 'T' }], hasUserText: true }]);
        var rows = chats.root.messages;
        assert.deepStrictEqual(rows[1], { role: 'user', content: 'legacy', injected: true });
        assert.strictEqual(rows[2].subNotices[0].kind, 'final');
        assert.strictEqual(rows[2].hasUserText, true);
    });

    test('agent_message inbox drain to a live sub: meta text is the exact combined drain', async function() {
        kid(); running.c_kid = true;
        var item = { kind: 'message', from: 'parent', content: 'hi\nthere', at: 1 };
        var combined = m._formatInboxDrain([item]);
        var meta = m._inboxDrainMeta([item], combined);
        assert.strictEqual(meta.kind, 'message');
        assert.strictEqual(meta.agentId, 'parent');
        assert.strictEqual(meta.summary, 'hi\nthere');
        assert.strictEqual(meta.text, combined);
        var carried = m._inboxDrainMeta([{ kind: 'report', from: 'kid', content: 'N', subNotice: { kind: 'final', agentId: 'kid', text: 'N' } }], 'DRAIN');
        assert.strictEqual(carried.kind, 'final', 'a single carried child notice keeps its identity');
        assert.strictEqual(carried.text, 'DRAIN');
    });
}, { tags: ['unit'], timeout: 5000 });
