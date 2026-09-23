// C1/C3/C4 (PR #969 part C1): CUMULATIVE FINAL prompt rule, the wake-notice
// reminder (097), the shared _isRealUserRow helper (app/020) and the wake-run
// hook wording (worker/020-page-stubs). Real source files via loadModules;
// globals stub only chrome/DOM/storage/runtime plumbing.
var T = { tags: ['unit'], timeout: 5000 };
var REMINDER = "Reminder: your final message must be a cumulative digest of everything since the user's last message.";
function count(s, sub) { return String(s).split(sub).length - 1; }
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };

describe('C1 CUMULATIVE FINAL policy (core/110-system-prompt.js)', function() {
    async function load() {
        return loadModules(['src/js/core/110-system-prompt.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), console: quiet,
            getSetting: function() { return Promise.resolve(null); }, setSetting: function() { return Promise.resolve(); },
            getDisabledTools: function() { return []; }, TOOL_DISPLAY_NAMES: {}, getSkillsSummaryForPrompt: function() { return ''; },
            chats: { p: { messages: [] }, s: { isSubAgent: true, messages: [] } }
        }});
    }
    function build(m, chatId) { return m._maybeAppendOrchestratorPolicy(m.expandSystemPromptPlaceholders(m.getSystemPromptTemplate(), chatId), chatId); }
    test('policy carries CUMULATIVE FINAL + cumulative FAN-OUT; OUTPUT covers earlier wake runs', async function() {
        var m = await load();
        var cf = m.ORCHESTRATOR_POLICY_LINES.filter(function(l) { return l.indexOf('CUMULATIVE FINAL:') === 0; });
        assert.strictEqual(cf.length, 1, 'exactly one CUMULATIVE FINAL line');
        assert.ok(/after any wake run/.test(cf[0]) && /EVERYTHING since the user's last real message/.test(cf[0]) && /earlier wake runs/.test(cf[0]) && /Never assume the user read/.test(cf[0]));
        var fan = m.ORCHESTRATOR_POLICY_LINES.filter(function(l) { return l.indexOf('FAN-OUT:') === 0; })[0];
        assert.ok(/Interim answers as reports arrive are cumulative: restate ALL results so far, not only the newest report\./.test(fan));
        assert.ok(m.DEFAULT_SYSTEM_PROMPT_TEMPLATE.indexOf("from mid-run or from earlier wake runs since the user's last message") !== -1);
    }, T);
    test('policy appears exactly ONCE for default, custom and placeholder-custom prompts; never for subs', async function() {
        var m = await load();
        var def = build(m, 'p');
        assert.strictEqual(count(def, 'SUB-AGENT DELEGATION & ORCHESTRATION'), 1);
        assert.strictEqual(count(def, 'CUMULATIVE FINAL:'), 1);
        assert.strictEqual(count(build(m, 's'), 'CUMULATIVE FINAL:'), 0, 'sub chats get no parent policy');
        await m.saveCustomSystemPrompt('My custom prompt {{CURRENT_DATE}}');
        var cus = build(m, 'p');
        assert.ok(cus.indexOf('My custom prompt') === 0);
        assert.strictEqual(count(cus, 'SUB-AGENT DELEGATION & ORCHESTRATION'), 1, 'appended once on custom');
        assert.strictEqual(count(cus, 'CUMULATIVE FINAL:'), 1);
        await m.saveCustomSystemPrompt('Head\n{{ORCHESTRATOR_POLICY}}\nTail');
        var ph = build(m, 'p');
        assert.strictEqual(count(ph, 'CUMULATIVE FINAL:'), 1, 'placeholder custom not duplicated by the append');
        assert.strictEqual(count(build(m, 's'), 'CUMULATIVE FINAL:'), 0);
        await m.clearCustomSystemPrompt();
        assert.strictEqual(build(m, 'p'), def, 'default restored byte-identical');
    }, T);
});

describe('C1 wake-notice reminder (core/097-sub-agent-registry.js)', function() {
    var m, chats, pend, running;
    beforeEach(async function() {
        chats = { root: { messages: [] } }; pend = {}; running = {};
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: running, pendingInjectionsByChatId: pend,
            isChatPaused: function() { return false; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function kid() {
        var h = m.Handles.start('root', 'spawn_sub_agent', {}, 'kid', function() { return new Promise(function() {}); });
        var r = { agent_id: 'kid', chat_id: 'c_kid', name: 'Kid', state: 'running', spawn_handle_id: h.handleId, parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now() };
        m._subAgents.kid = r;
        chats.c_kid = { isSubAgent: true, subAgentId: 'kid', messages: [] };
        return r;
    }
    test('helper appends the reminder on its own line', async function() {
        assert.strictEqual(m._withWakeFinalReminder('X'), 'X\n' + REMINDER);
        assert.strictEqual(m._withWakeFinalReminder(null), '\n' + REMINDER);
    }, T);
    test('_wakeParentOnReport idle row: reminder after the await_handle terminator, inside meta.text', async function() {
        var rec = kid();
        assert.strictEqual(m._wakeParentOnReport(rec, { status: 'done', summary: 'All good' }, {}), true);
        var row = chats.root.messages[chats.root.messages.length - 1];
        assert.strictEqual(row.content, 'Sub-agent "Kid" (kid) reported (done):\nAll good\n\u2014 full report via await_handle("' + rec.spawn_handle_id + '") or agent_status.\n' + REMINDER);
        assert.strictEqual(row.injected, true);
        assert.strictEqual(row.subNotices.length, 1);
        assert.strictEqual(row.subNotices[0].text, row.content, 'meta.text covers the reminder (UI hides it)');
        assert.strictEqual(row.subNotices[0].summary, 'All good', 'card body excludes the reminder');
    }, T);
    test('_wakeParentOnReport live arm queues the same reminder-bearing text', async function() {
        var rec = kid(); running.root = true;
        assert.strictEqual(m._wakeParentOnReport(rec, { status: 'need_input', summary: 'Q?' }, {}), true);
        assert.ok(pend.root.text.slice(-REMINDER.length - 1) === '\n' + REMINDER);
        assert.strictEqual(pend.root.subNotices[0].text, pend.root.text);
    }, T);
    test('_notifySubLifecycle: model row + queue carry the reminder, card progress stays bare', async function() {
        var rec = kid();
        var card = { role: 'sub_report', subAgentId: 'kid', subChatId: 'c_kid', progress: [] };
        chats.root.messages.push(card);
        assert.strictEqual(m._notifySubLifecycle(rec, 'STUCK \u2014 no progress'), true);
        var row = chats.root.messages[chats.root.messages.length - 1];
        assert.strictEqual(row.content, '[sub-agent lifecycle] Kid (kid): STUCK \u2014 no progress\n' + REMINDER);
        assert.strictEqual(row.subNotices[0].text, row.content);
        assert.strictEqual(row.subNotices[0].summary, 'STUCK \u2014 no progress');
        if (card.progress.length) assert.strictEqual(card.progress[card.progress.length - 1].text.indexOf('Reminder:'), -1, 'UI progress stream has no reminder');
        running.root = true;
        assert.strictEqual(m._notifySubLifecycle(rec, 'crashed (boom)'), true);
        assert.strictEqual(pend.root.text, '[sub-agent lifecycle] Kid (kid): crashed (boom)\n' + REMINDER);
        assert.strictEqual(pend.root.subNotices[0].text, pend.root.text);
    }, T);
});

describe('C3 _isRealUserRow (app/020-api-messages.js) + progress turn key (app/030)', function() {
    test('truth table', async function() {
        var m = await loadModules(['src/js/app/020-api-messages.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome(), console: quiet } });
        var f = m._isRealUserRow;
        assert.strictEqual(typeof f, 'function');
        assert.strictEqual(f({ role: 'user', content: 'hi' }), true);
        assert.strictEqual(f({ role: 'user', injected: true }), false);
        assert.strictEqual(f({ role: 'user', injected: true, hasUserText: true }), true);
        assert.strictEqual(f({ role: 'user', injected: true, hasUserText: 'yes' }), false, 'strict true only');
        assert.strictEqual(f({ role: 'assistant' }), false);
        assert.strictEqual(f(null), false);
        assert.strictEqual(f(undefined), false);
    }, T);
    test('_progressCardTurnKey skips injected-only rows but stops at merged user text', async function() {
        var m = await loadModules(['src/js/app/020-api-messages.js', 'src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome(), console: quiet } });
        var chat = { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', injected: true, content: 'notice' }, { role: 'assistant', content: 'b' }, { role: 'user', injected: true, hasUserText: true, content: 'notice\n\ntyped' }] };
        assert.strictEqual(m._progressCardTurnKey(chat, 2), 0, 'wake row continues the organic turn');
        assert.strictEqual(m._progressCardTurnKey(chat, 4), 4, 'merged user text is a real turn');
        assert.strictEqual(m._progressCardTurnKey({ messages: [{ role: 'user', injected: true }] }, 0), 0, 'fallback when all injected');
    }, T);
});

describe('C4 wake-run hook wording (worker/020-page-stubs.js)', function() {
    var LONG = new Array(71).join('0123456789');
    var NORMAL = 'Now do the following, calling ALL the tools in THIS SINGLE response (parallel tool calls), and say nothing else: 1) provide a TL;DR of your answer using the set_tldr tool (1-2 short sentences, max 280 chars); 2) finalize the chat progress card by calling the update_action_state tool with the appropriate TERMINAL state \u2014 `pr_opened` if a PR was opened/pushed during this task, `finished_with_caveat` if you are also flagging a caveat with set_caveat, `error` if the task failed, otherwise `finished` \u2014 passing the full tasks array (all marked done) and a short markdown `output` summary; SKIP this call entirely if no substantive work was done (pure conversational answer). (Item 2 \u2014 update_action_state \u2014 is also conditional: skip it ONLY when no substantive work was done this turn.)';
    async function run(rows, anchor) {
        var G = { chats: {}, hooksEnabled: { autoTitle: false, autoTldr: true, autoLinks: false, autoCaveat: false, autoProgress: true, showHookMessages: true } };
        var runs = [];
        var M = await loadModules(['src/js/tools/020-tool-execution.js', 'src/js/worker/020-page-stubs.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: G.chats, hooksEnabled: G.hooksEnabled,
            _silentHookRunningByChat: {}, saveChatsToStorage: function() {}, runAgent: function(id) { runs.push(id); }
        }});
        if (M.hooksEnabled && M.hooksEnabled !== G.hooksEnabled) Object.assign(M.hooksEnabled, G.hooksEnabled);
        var store = (M.chats && typeof M.chats === 'object') ? M.chats : G.chats;
        store.c1 = { id: 'c1', title: 'T', messages: rows };
        M.executeAfterResponseHooks('c1', anchor);
        var last = rows[rows.length - 1];
        return { hook: (last && last.isHookMessage) ? last.content : null, runs: runs };
    }
    function base() {
        return [{ role: 'user', content: 'do it' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'workspace', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 't1', content: '{"success":true}' }];
    }
    test('normal run: wording byte-identical to the pre-change instruction', async function() {
        var r = await run(base().concat([{ role: 'assistant', content: LONG }]), 0);
        assert.strictEqual(r.hook, NORMAL);
        assert.strictEqual(r.runs.length, 1);
    }, T);
    test('wake run (injected-only anchor): TL;DR + progress cover everything since the user\'s last message', async function() {
        var rows = base().concat([{ role: 'assistant', content: 'dispatched' }, { role: 'user', injected: true, content: 'Sub-agent report\n' + REMINDER }, { role: 'assistant', content: LONG }]);
        var r = await run(rows, 4);
        var expected = NORMAL.replace('TL;DR of your answer', "TL;DR of everything since the user's last message")
            .replace('`output` summary;', "`output` summary of everything since the user's last message;");
        assert.notStrictEqual(expected, NORMAL);
        assert.strictEqual(r.hook, expected, 'progress hook still fires: tools since the real user row count');
    }, T);
    test('anchor with merged user text is a normal turn (normal wording)', async function() {
        var rows = base().concat([{ role: 'assistant', content: 'dispatched' }, { role: 'user', injected: true, hasUserText: true, content: 'notice\n\ntyped' }, { role: 'assistant', content: LONG }]);
        var r = await run(rows, 4);
        assert.strictEqual(r.hook, 'Now provide a TL;DR of your answer using the set_tldr tool (1-2 short sentences, max 280 chars). Do NOT say anything else.');
    }, T);
});
