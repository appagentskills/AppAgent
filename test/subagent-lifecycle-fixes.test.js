// H16: a caller that stopped waiting (await timeout / await_any loser) must
// not stay registered in entry.awaiters — the sub-agent registry reads
// awaiters.length as "parent blocked right now" (_spawnHandleHasAwaiters) and
// skipped the parent wake forever. Old code: timeout left the callback in
// place (awaiters.length === 1) and await_any losers were never removed.
describe('H16 handle awaiter cleanup', function() {
    var m, timers, cleared;
    beforeEach(async function() {
        timers = []; cleared = [];
        m = await loadModules(['src/js/core/095-handle-registry.js'], { globals: {
            self: {}, setTimeout: function(fn) { timers.push(fn); return timers.length; },
            clearTimeout: function(id) { cleared.push(id); }
        }});
    });
    function pending(chat) {
        var resolve;
        var work = new Promise(function(a) { resolve = a; });
        var h = m.Handles.start(chat, 'work', {}, 'task', function() { return work; });
        return { h: h, resolve: resolve };
    }
    test('timed-out await deregisters its awaiter; late settle still works', async function() {
        var p = pending('a');
        var w = m.Handles.await('a', p.h.handleId, 10);
        assert.strictEqual(p.h.entry.awaiters.length, 1);
        timers.splice(0).forEach(function(fn) { fn(); });
        var snap = await w;
        assert.strictEqual(snap.status, 'pending');
        assert.strictEqual(p.h.entry.awaiters.length, 0);
        p.resolve(5); await p.h.entry.promise;
        assert.strictEqual((await m.Handles.await('a', p.h.handleId)).result, 5);
    });
    test('a live (no-timeout) awaiter stays registered until settle', async function() {
        var p = pending('a');
        var w = m.Handles.await('a', p.h.handleId);
        assert.strictEqual(p.h.entry.awaiters.length, 1);
        p.resolve(1); await p.h.entry.promise;
        assert.strictEqual((await w).result, 1);
        assert.strictEqual(p.h.entry.awaiters.length, 0);
    });
    test('await_any losers are deregistered after a winner and after timeout', async function() {
        var a = pending('a'), b = pending('a');
        var race = m.Handles.awaitAny('a', [a.h.handleId, b.h.handleId]);
        a.resolve('win'); await a.h.entry.promise;
        var r = await race;
        assert.strictEqual(r.handle, a.h.handleId);
        assert.strictEqual(b.h.entry.awaiters.length, 0);
        var c = pending('a');
        var race2 = m.Handles.awaitAny('a', [b.h.handleId, c.h.handleId], 10);
        timers.splice(0).forEach(function(fn) { fn(); });
        assert.strictEqual((await race2).timeout, true);
        assert.strictEqual(b.h.entry.awaiters.length, 0);
        assert.strictEqual(c.h.entry.awaiters.length, 0);
    });
    // H16 follow-up (a): old code never cleared the timeout timer, so every
    // settle/cancel left an armed timer until timeoutMs elapsed.
    test('settle clears the await timeout timer; await_any win clears its outer timer', async function() {
        var p = pending('a');
        var w = m.Handles.await('a', p.h.handleId, 60000);
        var awaitTimerId = timers.length;
        assert.strictEqual(awaitTimerId, 1);
        p.resolve(7); await p.h.entry.promise;
        assert.strictEqual((await w).result, 7);
        assert.ok(cleared.indexOf(awaitTimerId) !== -1, 'await timer cleared on settle: ' + JSON.stringify(cleared));
        var x = pending('a'), y = pending('a');
        var before = timers.length;
        var race = m.Handles.awaitAny('a', [x.h.handleId, y.h.handleId], 60000);
        assert.strictEqual(timers.length, before + 3, '2 per-handle timers + 1 outer timer');
        x.resolve('w'); await x.h.entry.promise;
        assert.strictEqual((await race).handle, x.h.handleId);
        [before + 1, before + 2, before + 3].forEach(function(id) {
            assert.ok(cleared.indexOf(id) !== -1, 'timer ' + id + ' cleared: ' + JSON.stringify(cleared));
        });
        assert.strictEqual(y.h.entry.awaiters.length, 0);
    });
    test('cancelAwaitersForChat stops only that chat\'s awaiters; await_any with no timeout resolves', async function() {
        var a1 = pending('a'), a2 = pending('a'), b1 = pending('b');
        var wa = m.Handles.await('a', a1.h.handleId);
        var race = m.Handles.awaitAny('a', [a1.h.handleId, a2.h.handleId]);
        var wb = m.Handles.await('b', b1.h.handleId);
        assert.strictEqual(a1.h.entry.awaiters.length, 2);
        assert.strictEqual(m.Handles.cancelAwaitersForChat('a'), 3);
        assert.strictEqual(a1.h.entry.awaiters.length, 0);
        assert.strictEqual(a2.h.entry.awaiters.length, 0);
        assert.strictEqual(b1.h.entry.awaiters.length, 1, 'other chat untouched');
        assert.strictEqual((await wa).status, 'pending');
        var r = await race;
        assert.strictEqual(r.timeout, true);
        assert.strictEqual(r.handle, null);
        assert.strictEqual(m.Handles.cancelAwaitersForChat('nobody'), 0);
        b1.resolve('ok'); await b1.h.entry.promise;
        assert.strictEqual((await wb).result, 'ok');
    });
});

// H16 follow-up (b): an await_handle (timeout_ms 0) abandoned by a user
// interrupt/pause in executeToolWithInterrupt (app/030) left its `done` in
// entry.awaiters forever, so the next sub report sampled hadAwaiters=true
// while the parent was live and _wakeParentOnReport skipped the notice.
describe('H16 follow-up: interrupted await_handle no longer swallows the wake', function() {
    var m, loop, chats, pend, irs, warns = [];
    var quiet = { log: function() {}, warn: function() { warns.push([].slice.call(arguments).map(String).join(' ')); }, error: function() { warns.push([].slice.call(arguments).map(String).join(' ')); }, info: function() {} };
    beforeEach(async function() {
        chats = { root: { messages: [] } }; pend = {}; irs = {};
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: { root: true }, pendingInjectionsByChatId: pend,
            isChatPaused: function() { return false; }, console: quiet,
            // persistPendingWake's durable IDB mirror is out of scope here.
            openDatabase: function() { return new Promise(function() {}); }
        }});
        loop = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: {
            self: {}, console: quiet, Handles: m.Handles,
            interruptResolversByChatId: irs, userInterruptedChats: {},
            // Same shape as the tools/020 await_handle arm: Handles.await(options.chatId, handle, 0).
            executeTool: function(name, args, idx, opts) {
                return m.Handles.await(opts.chatId, args.handle, 0).then(function(s) { return { success: true, snapshot: s }; });
            }
        }});
    });
    test('interrupt deregisters the parent awaiter and the next report wakes the parent', async function() {
        var h = m.Handles.start('root', 'spawn_sub_agent', {}, 'kid', function() { return new Promise(function() {}); });
        var rec = { agent_id: 'kid', chat_id: 'c_kid', name: 'kid', state: 'running', spawn_handle_id: h.handleId,
            parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now() };
        m._subAgents.kid = rec;
        var p = loop.executeToolWithInterrupt('root', 'await_handle', { handle: h.handleId }, 0, { chatId: 'root' });
        assert.strictEqual(m._spawnHandleHasAwaiters(rec), true, 'parent genuinely blocked before the interrupt');
        assert.strictEqual(typeof irs.root, 'function');
        irs.root(); // user interrupt / pause (sendMessage, port-bridge toggle-pause)
        assert.strictEqual((await p)._interrupted, true);
        assert.strictEqual(h.entry.awaiters.length, 0, 'stale awaiter removed');
        var sampled = m._spawnHandleHasAwaiters(rec);
        assert.strictEqual(sampled, false);
        var woke = m._wakeParentOnReport(rec, { status: 'done', summary: 'KID-REPORT' }, { hadAwaiters: sampled });
        assert.strictEqual(woke, true, 'wake not skipped; pend=' + JSON.stringify(pend) + ' warns=' + JSON.stringify(warns));
        assert.ok(pend.root && /KID-REPORT/.test(pend.root.text), 'notice queued for the live parent');
    });
});

// H15 / M11 / H11 on the REAL registry (core/097-sub-agent-registry.js).
describe('sub-agent registry pause/delete fixes (H15, M11, H11)', function() {
    var m, chats, pausedChats, ensured, saves;
    beforeEach(async function() {
        chats = {}; pausedChats = {}; ensured = []; saves = 0;
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: pausedChats, runningChatIds: {},
            isChatPaused: function(id) { return pausedChats[id] === true; },
            ensureChatPayloads: function(id) { ensured.push(id); if (chats[id]) delete chats[id]._payloadsEvicted; return Promise.resolve(); },
            saveChatsToStorage: function() { saves++; return Promise.resolve(); },
            console: { log: function() {}, warn: function() {}, error: function() {}, info: function() {} }
        }});
    });
    function rec(id, extra) {
        var r = Object.assign({ agent_id: id, chat_id: 'c_' + id, name: id, state: 'running', spawn_handle_id: 'h_' + id,
            parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now() }, extra || {});
        m._subAgents[id] = r;
        return r;
    }
    var OLD = Date.now() - 3 * 60 * 60 * 1000; // > SUBAGENT_RUNNING_TTL_MS (2h)

    test('H15: idle sweep never ages out a paused running sub; control sub is reclaimed', async function() {
        var ctl = rec('ctl', { last_activity_at: OLD });
        var p1 = rec('p1', { last_activity_at: OLD, paused_by_parent_chat: 'root' });
        var p2 = rec('p2', { last_activity_at: OLD });
        m._pausedByParentChat[p2.chat_id] = { parentChatId: 'root', resumePending: false };
        var p3 = rec('p3', { last_activity_at: OLD }); pausedChats[p3.chat_id] = true;
        var p4 = rec('p4', { last_activity_at: OLD }); chats[p4.chat_id] = { messages: [], pausedByUser: true };
        m._idleSweepTick();
        assert.strictEqual(ctl.state, 'errored', 'unpaused stale running sub is reclaimed (sweep is live)');
        [p1, p2, p3, p4].forEach(function(r) { assert.strictEqual(r.state, 'running', r.agent_id + ' paused -> kept'); });
    });

    function nestedSetup(parentState) {
        var pa = rec('pa', { state: parentState, last_activity_at: 1 });
        chats[pa.chat_id] = { isSubAgent: true, subAgentId: 'pa', messages: [] };
        var kid = rec('kid', { parent_chat_id: pa.chat_id });
        return { pa: pa, kid: kid, pchat: chats[pa.chat_id] };
    }
    test('M11: parent-paused running sub-parent gets a transcript row, is NOT woken', async function() {
        var s = nestedSetup('running');
        s.pa.paused_by_parent_chat = 'root'; pausedChats[s.pa.chat_id] = true; s.pchat._payloadsEvicted = true;
        var woke = m._wakeParentOnReport(s.kid, { status: 'done', summary: 'KID-SUMMARY' }, {});
        assert.strictEqual(woke, false);
        // Evicted parent: hydrate FIRST, then push + persist (never a push
        // into an evicted row that the evicted-put guard would drop).
        assert.deepStrictEqual(ensured, [s.pa.chat_id], 'evicted parent hydrated before delivery');
        assert.strictEqual(s.pchat.messages.length, 0, 'no push before hydration settles');
        await new Promise(function(r) { setTimeout(r, 0); });
        assert.strictEqual(s.pchat.messages.length, 1);
        assert.match(s.pchat.messages[0].content, /KID-SUMMARY/);
        assert.strictEqual(s.pchat.messages[0].injected, true);
        assert.strictEqual(s.pchat._payloadsEvicted, undefined, 'row pushed into the hydrated chat');
        assert.ok(saves >= 1, 'notice row persisted');
        assert.strictEqual(pausedChats[s.pa.chat_id], true, 'pause flag untouched');
        assert.strictEqual(m._subPool.queue.indexOf('pa'), -1, 'not re-queued');
        assert.ok(s.pa.last_activity_at > 1);
    });
    test('M11: hydrated parent-paused sub-parent gets the row synchronously + persisted', async function() {
        var s = nestedSetup('running');
        s.pa.paused_by_parent_chat = 'root'; pausedChats[s.pa.chat_id] = true;
        var woke = m._wakeParentOnReport(s.kid, { status: 'done', summary: 'KID-SYNC' }, {});
        assert.strictEqual(woke, false);
        assert.deepStrictEqual(ensured, [], 'no hydration needed');
        assert.strictEqual(s.pchat.messages.length, 1);
        assert.match(s.pchat.messages[0].content, /KID-SYNC/);
        assert.ok(saves >= 1, 'notice row persisted');
        assert.strictEqual(m._subPool.queue.indexOf('pa'), -1, 'not re-queued');
    });
    test('M11: user-paused sleeping sub-parent gets the notice in rec.inbox, is NOT woken', async function() {
        var s = nestedSetup('sleeping');
        s.pchat.pausedByUser = true; pausedChats[s.pa.chat_id] = true;
        var woke = m._wakeParentOnReport(s.kid, { status: 'done', summary: 'KID2' }, {});
        assert.strictEqual(woke, false);
        assert.strictEqual(s.pa.state, 'sleeping');
        assert.strictEqual(s.pchat.messages.length, 0);
        assert.strictEqual(s.pa.inbox.length, 1);
        assert.match(s.pa.inbox[0].content, /KID2/);
        assert.strictEqual(pausedChats[s.pa.chat_id], true);
    });

    test('H11: stopDescendantsOfChat stops every live descendant of the deleted chat only', async function() {
        assert.strictEqual(typeof m.SubAgents.stopDescendantsOfChat, 'function', 'exported on SubAgents');
        var a = rec('a');
        var b = rec('b', { parent_chat_id: a.chat_id, parent_agent_id: 'a' });
        var c = rec('c', { parent_chat_id: 'other_parent' }); // root_chat_id root
        var d = rec('d', { parent_chat_id: 'unrelated', root_chat_id: 'unrelated' });
        var e = rec('e', { state: 'stopped' });
        var ids = m.SubAgents.stopDescendantsOfChat('root', 'parent chat deleted');
        assert.strictEqual(a.state, 'stopped'); assert.strictEqual(b.state, 'stopped'); assert.strictEqual(c.state, 'stopped');
        assert.strictEqual(d.state, 'running', 'unrelated tree untouched');
        assert.strictEqual(e.state, 'stopped');
        assert.ok(ids.indexOf('a') !== -1 && ids.indexOf('c') !== -1 && ids.indexOf('e') === -1, JSON.stringify(ids));
        assert.deepStrictEqual(m.SubAgents.stopDescendantsOfChat(''), []);
    });
    test('H11: SW tombstone branch cascade-stops BEFORE swapping in the tombstone', async function() {
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var i = src.indexOf('if (msg.chatId && msg.chat && msg.chat._deleted === true) {');
        assert.ok(i > 0, 'tombstone branch found');
        var body = src.slice(i, src.indexOf('return;', i));
        var stop = body.indexOf("SubAgents.stopDescendantsOfChat(msg.chatId");
        var swap = body.indexOf('chats[msg.chatId] = msg.chat;');
        assert.ok(stop > 0 && swap > stop, 'stop precedes tombstone assignment');
    });
});
