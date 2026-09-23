// PR #969 part 5 (C review fixes). Fix 1: the cumulative-final reminder
// (core/097 _withWakeFinalReminder) targets TOP-LEVEL parents only — a
// sub-agent parent (nested) gets the bare notice, and meta.text stays equal
// to the text actually placed on the row / queue entry. Fix 2: after-response
// hook rows are not turns for the progress-card key (app/030).
// Real source files via loadModules; globals stub only runtime plumbing.
var T = { tags: ['unit'], timeout: 5000 };
var REMINDER = "Reminder: your final message must be a cumulative digest of everything since the user's last message.";
function count(s, sub) { return String(s).split(sub).length - 1; }
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };

describe('Fix 1: wake reminder only for top-level parents (core/097)', function() {
    var m, chats, pend, running, pausedChats;
    beforeEach(async function() {
        chats = { root: { messages: [] } }; pend = {}; running = {}; pausedChats = {};
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: pausedChats, runningChatIds: running, pendingInjectionsByChatId: pend,
            isChatPaused: function(id) { return pausedChats[id] === true; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function sub(id, parentChatId, extra) {
        var h = m.Handles.start(parentChatId, 'spawn_sub_agent', {}, id, function() { return new Promise(function() {}); });
        var r = Object.assign({ agent_id: id, chat_id: 'c_' + id, name: id.charAt(0).toUpperCase() + id.slice(1), state: 'running',
            spawn_handle_id: h.handleId, parent_chat_id: parentChatId, root_chat_id: 'root', created_at: Date.now() }, extra || {});
        m._subAgents[id] = r;
        chats[r.chat_id] = { isSubAgent: true, subAgentId: id, messages: [] };
        return r;
    }
    function nested() { var pa = sub('pa', 'root'); return { pa: pa, kid: sub('kid', pa.chat_id), pchat: chats[pa.chat_id] }; }

    test('helper: sub-agent parent -> text unchanged (flag, or registry when the chat is not loaded / unflagged); top-level / no id -> one reminder', async function() {
        var s = nested();
        assert.strictEqual(m._withWakeFinalReminder('X', s.pa.chat_id), 'X', 'chats[pcid].isSubAgent');
        delete chats[s.pa.chat_id];
        assert.strictEqual(m._withWakeFinalReminder('X', s.pa.chat_id), 'X', 'chat not loaded -> registry record chat_id === pcid');
        chats[s.pa.chat_id] = { messages: [] };
        assert.strictEqual(m._withWakeFinalReminder('X', s.pa.chat_id), 'X', 'loaded without the flag -> registry');
        assert.strictEqual(m._withWakeFinalReminder('X', 'root'), 'X\n' + REMINDER);
        assert.strictEqual(m._withWakeFinalReminder('X'), 'X\n' + REMINDER, 'no id keeps the old contract');
        assert.strictEqual(m._withWakeFinalReminder(null, s.pa.chat_id), '');
    }, T);

    test('_wakeParentOnReport nested: live queue + paused-parent row carry no reminder; meta.text === delivered text', async function() {
        var s = nested();
        running[s.pa.chat_id] = true;
        assert.strictEqual(m._wakeParentOnReport(s.kid, { status: 'done', summary: 'KID-DONE' }, {}), true);
        var e = pend[s.pa.chat_id];
        assert.strictEqual(e.text, 'Sub-agent "Kid" (kid) reported (done):\nKID-DONE\n\u2014 full report via await_handle("' + s.kid.spawn_handle_id + '") or agent_status.');
        assert.strictEqual(count(e.text, 'Reminder:'), 0);
        assert.strictEqual(e.subNotices.length, 1);
        assert.strictEqual(e.subNotices[0].text, e.text, 'meta.text === queued text');
        delete running[s.pa.chat_id]; delete pend[s.pa.chat_id];
        s.pa.paused_by_parent_chat = 'root'; pausedChats[s.pa.chat_id] = true;
        assert.strictEqual(m._wakeParentOnReport(s.kid, { status: 'need_input', summary: 'which one?' }, {}), false);
        var row = s.pchat.messages[s.pchat.messages.length - 1];
        assert.ok(row && row.role === 'user' && row.injected === true, 'paused sub-parent got a transcript row');
        assert.ok(/reported \(need_input\):\nwhich one\?/.test(row.content));
        assert.strictEqual(count(row.content, 'Reminder:'), 0);
        assert.ok(row.content.indexOf(row.subNotices[0].text) !== -1, 'UI match: content.indexOf(meta.text)');
        assert.strictEqual(row.subNotices[0].text, row.content);
    }, T);

    test('_notifySubLifecycle nested: idle row + live queue are bare; meta.text matches', async function() {
        var s = nested();
        assert.strictEqual(m._notifySubLifecycle(s.kid, 'STUCK \u2014 no progress'), true);
        var row = s.pchat.messages[s.pchat.messages.length - 1];
        assert.strictEqual(row.content, '[sub-agent lifecycle] Kid (kid): STUCK \u2014 no progress');
        assert.strictEqual(row.subNotices[0].text, row.content);
        running[s.pa.chat_id] = true;
        assert.strictEqual(m._notifySubLifecycle(s.kid, 'crashed (boom)'), true);
        assert.strictEqual(pend[s.pa.chat_id].text, '[sub-agent lifecycle] Kid (kid): crashed (boom)');
        assert.strictEqual(pend[s.pa.chat_id].subNotices[0].text, pend[s.pa.chat_id].text);
    }, T);

    test('agentMessage(to:parent) nested: queued notice has no reminder; meta.text === queued text', async function() {
        var s = nested();
        running[s.pa.chat_id] = true;
        var res = m.agentMessage({ to: 'parent', content: 'hello\nworld' }, { chatId: s.kid.chat_id });
        assert.ok(res && res.success !== false, 'send ok');
        var e = pend[s.pa.chat_id];
        assert.ok(e, 'model-visible notice queued for the live sub-parent');
        assert.strictEqual(e.text, '[sub-agent lifecycle] Kid (kid): sent a message: hello world');
        assert.strictEqual(e.subNotices[e.subNotices.length - 1].text, e.text);
    }, T);

    test('top-level parent still gets exactly ONE reminder on every surface (meta.text covers it)', async function() {
        var kid = sub('kid', 'root');
        assert.strictEqual(m._wakeParentOnReport(kid, { status: 'done', summary: 'All good' }, {}), true);
        var row = chats.root.messages[chats.root.messages.length - 1];
        assert.strictEqual(row.content, 'Sub-agent "Kid" (kid) reported (done):\nAll good\n\u2014 full report via await_handle("' + kid.spawn_handle_id + '") or agent_status.\n' + REMINDER);
        assert.strictEqual(count(row.content, REMINDER), 1);
        assert.strictEqual(row.subNotices[0].text, row.content);
        assert.strictEqual(m._notifySubLifecycle(kid, 'STUCK'), true);
        var lc = chats.root.messages[chats.root.messages.length - 1];
        assert.strictEqual(lc.content, '[sub-agent lifecycle] Kid (kid): STUCK\n' + REMINDER);
        assert.strictEqual(lc.subNotices[0].text, lc.content);
        running.root = true;
        m.agentMessage({ to: 'parent', content: 'hi' }, { chatId: kid.chat_id });
        assert.strictEqual(pend.root.text, '[sub-agent lifecycle] Kid (kid): sent a message: hi\n' + REMINDER);
        assert.strictEqual(count(pend.root.text, REMINDER), 1);
        assert.strictEqual(pend.root.subNotices[pend.root.subNotices.length - 1].text, pend.root.text);
    }, T);
});

describe('Fix 2: hook rows are not turns for _progressCardTurnKey (app/030)', function() {
    async function load() {
        return loadModules(['src/js/app/020-api-messages.js', 'src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome(), console: quiet } });
    }
    function chatWithHook() {
        return { id: 'c1', messages: [
            { role: 'user', content: 'do it' },                                                                                  // 0
            { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'update_action_state', arguments: '{}' } }] }, // 1
            { role: 'tool', tool_call_id: 't1', content: '{"success":true}' },                                                   // 2
            { role: 'assistant', content: 'dispatched' },                                                                        // 3
            { role: 'user', content: 'Now provide a TL;DR...', isHookMessage: true },                                            // 4
            { role: 'assistant', content: '', tool_calls: [{ id: 't2', function: { name: 'set_tldr', arguments: '{}' } }] }        // 5
        ] };
    }
    test('a hook row between the user turn and a wake run keeps the key on the user row', async function() {
        var m = await load();
        var chat = chatWithHook();
        assert.strictEqual(m._progressCardTurnKey(chat, 4), 0, 'hook run keys on the organic user row');
        chat.messages.push({ role: 'tool', tool_call_id: 't2', content: '{"success":true}' });
        chat.messages.push({ role: 'user', injected: true, content: 'Sub-agent report' });                                     // 7
        assert.strictEqual(m._progressCardTurnKey(chat, 7), 0, 'later wake run does not key on the hook row');
    }, T);
    test('stamp survives the hook run and the later wake run; a new organic turn still clears it', async function() {
        var m = await load();
        var chat = chatWithHook();
        chat.messages.length = 1;
        m._resetProgressCardStampForTurn(chat, 0);
        chat._progressCardAt = 1700000000000;
        chat.messages = chatWithHook().messages;
        assert.strictEqual(m._resetProgressCardStampForTurn(chat, 4), false, 'hook run: not cleared');
        assert.strictEqual(chat._progressCardAt, 1700000000000);
        chat.messages.push({ role: 'user', injected: true, content: 'wake notice' });                                          // 6
        assert.strictEqual(m._resetProgressCardStampForTurn(chat, 6), false, 'wake run: not cleared');
        assert.strictEqual(chat._progressCardTurn, 0);
        chat.messages.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'turn 2' });                         // 8
        assert.strictEqual(m._resetProgressCardStampForTurn(chat, 8), true, 'new organic turn clears');
        assert.strictEqual(chat._progressCardTurn, 8);
    }, T);
});
