// #3 — sub-agent saturation hard stop (Phase 4, fix-all/4-high;
// app/030-agent-loop.js maybeSubSaturationHardStop, flag
// P4_SUB_SATURATION_HARDSTOP, constants SUBAGENT_HARDSTOP_PCT /
// SUBAGENT_HARDSTOP_GRACE_TURNS in core/097-sub-agent-registry.js).
describe('#3 sub-agent saturation hard stop (app/030-agent-loop.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M.maybeSubSaturationHardStop, 'function');
        assert.strictEqual(typeof M.appendContextNotice, 'function');
        return M;
    }
    function reset(m, opts) {
        opts = opts || {};
        var s = m.__scope;
        s.getAssumedContextTokens = function() { return 1000; };
        s.getP4Flag = function(n) { return n === 'P4_SUB_SATURATION_HARDSTOP' && opts.flag !== false; };
        s.SUBAGENT_HARDSTOP_PCT = 60;
        s.SUBAGENT_HARDSTOP_GRACE_TURNS = 2;
        s.saveChatsToStorage = function() {};
        s.reportCalls = [];
        s.SubAgents = {
            report: function(args, ctx) { s.reportCalls.push({ args: args, ctx: ctx }); return { success: true }; },
            getByChatId: function() { return { state: opts.recState || 'running', last_assistant_text: 'found X' }; }
        };
        return s;
    }
    // Sub chat whose newest assistant row reports `tokens` input tokens.
    function subChat(tokens, isSub) {
        return {
            id: 'sub1',
            isSubAgent: isSub !== false,
            messages: [
                { role: 'user', content: 'task' },
                { role: 'assistant', content: 'working', metrics: { input_tokens: tokens } }
            ]
        };
    }
    function hardStopRows(chat) {
        return chat.messages.filter(function(r) { return r.role === 'context' && r._saturationHardStop; });
    }

    test('(1) sub at 61% with no row → injected exactly once; same-turn re-call → null (no duplicate)', async function() {
        var m = await load(); var s = reset(m);
        var chat = subChat(610);
        assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), 'injected');
        var rows = hardStopRows(chat);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].role, 'context');
        assert.ok(/MANDATORY/.test(rows[0].content) && /~61%/.test(rows[0].content) && /report_to_parent/.test(rows[0].content), rows[0].content);
        assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), null, 'second call same turn: grace not exhausted');
        assert.strictEqual(hardStopRows(chat).length, 1, 'no duplicate row');
        assert.strictEqual(s.reportCalls.length, 0, 'no auto-report yet');
    });
    test('(2) two assistant turns after the row, rec running → reported need_input with auto_handoff + last text', async function() {
        var m = await load(); var s = reset(m);
        var chat = subChat(610);
        assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), 'injected');
        chat.messages.push({ role: 'assistant', content: 'still working', metrics: { input_tokens: 610 } });
        assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), null, 'one turn since row: still in grace');
        chat.messages.push({ role: 'assistant', content: 'and more', metrics: { input_tokens: 610 } });
        assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), 'reported');
        assert.strictEqual(s.reportCalls.length, 1);
        var call = s.reportCalls[0];
        assert.strictEqual(call.args.status, 'need_input');
        assert.strictEqual(call.args.data.auto_handoff, true);
        assert.strictEqual(call.args.data.context_pct, 61);
        assert.ok(call.args.summary.indexOf('found X') !== -1, 'summary carries last_assistant_text');
        assert.ok(/auto-handoff/.test(call.args.summary));
        assert.deepStrictEqual(call.ctx, { chatId: 'sub1' });
        assert.strictEqual(hardStopRows(chat).length, 1, 'no second row injected');
    });
    test('(2c) R4 SF3: SubAgents.report returns {success:false} → null (loop must NOT break); promise-shaped return → reported', async function() {
        var m = await load(); var s = reset(m);
        var warns = [];
        var origWarn = console.warn; console.warn = function() { warns.push(Array.prototype.join.call(arguments, ' ')); };
        try {
            s.SubAgents.report = function(args, ctx) { s.reportCalls.push({ args: args, ctx: ctx }); return { success: false, error: 'already settled' }; };
            var chat = subChat(610);
            assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), 'injected');
            chat.messages.push({ role: 'assistant', content: 'a', metrics: { input_tokens: 610 } });
            chat.messages.push({ role: 'assistant', content: 'b', metrics: { input_tokens: 610 } });
            assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), null, 'rejected report → null, not reported');
            assert.strictEqual(s.reportCalls.length, 1, 'report was attempted once');
            assert.ok(warns.some(function(w) { return /auto-handoff report rejected/.test(w) && /already settled/.test(w); }), warns.join('|'));
            // {success:true} and promise-shaped returns are both accepted
            s.SubAgents.report = function() { return Promise.resolve({ success: false }); };
            assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), 'reported', 'promise return treated as accepted');
            s.SubAgents.report = function() { return { success: true, ok: true }; };
            assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), 'reported');
        } finally { console.warn = origWarn; }
    });
    test('(2b) guards: rec not running → null; flag OFF → null (no row, no report)', async function() {
        var m = await load();
        var s = reset(m, { recState: 'sleeping' });
        var chat = subChat(610);
        assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), 'injected');
        chat.messages.push({ role: 'assistant', content: 'a', metrics: { input_tokens: 610 } });
        chat.messages.push({ role: 'assistant', content: 'b', metrics: { input_tokens: 610 } });
        assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'sub1'), null, 'rec.state !== running → skip');
        assert.strictEqual(s.reportCalls.length, 0);
        s = reset(m, { flag: false });
        var chat2 = subChat(900);
        assert.strictEqual(m.maybeSubSaturationHardStop(chat2, 'sub1'), null);
        assert.strictEqual(hardStopRows(chat2).length, 0);
        assert.strictEqual(s.reportCalls.length, 0);
    });
    test('(3) main chat (isSubAgent false) at 90% → null, nothing injected', async function() {
        var m = await load(); var s = reset(m);
        var chat = subChat(900, false);
        assert.strictEqual(m.maybeSubSaturationHardStop(chat, 'main1'), null);
        assert.strictEqual(hardStopRows(chat).length, 0);
        assert.strictEqual(s.reportCalls.length, 0);
        var under = subChat(590);
        assert.strictEqual(m.maybeSubSaturationHardStop(under, 'sub1'), null, '59% is under threshold');
        assert.strictEqual(hardStopRows(under).length, 0);
    });
    test('(4) appendContextNotice unchanged: 60% sub text still carries FINAL WARNING', async function() {
        var m = await load(); reset(m);
        var chat = subChat(600);
        var out = m.appendContextNotice(chat, 'result');
        var txt = typeof out === 'string' ? out : JSON.stringify(out);
        assert.ok(/FINAL WARNING/.test(txt), txt);
        assert.ok(/~60%/.test(txt), txt);
    });
    test('(5) loop wiring: call site sits between the progress nudge and the assistant row, breaks on reported', async function() {
        var src = await loadFile('src/js/app/030-agent-loop.js');
        var iNudge = src.indexOf('_progressNudge: true,');
        var iCall = src.indexOf("maybeSubSaturationHardStop(chat, streamingChatId) === 'reported'");
        var iAssistant = src.indexOf('var assistantMsg = {');
        assert.ok(iNudge > 0 && iCall > iNudge && iAssistant > iCall, 'order: nudge < hardstop < assistantMsg');
        var slice = src.slice(iCall, iAssistant);
        assert.ok(/saveChatsToStorage\(\);\s*break;/.test(slice), 'reported → save + break');
        var helper = src.slice(src.indexOf('function maybeSubSaturationHardStop'), src.indexOf('function recordToolResult'));
        assert.ok(helper.length > 0 && helper.indexOf('tool_choice') === -1 && slice.indexOf('tool_choice') === -1, 'no tool_choice forcing');
        assert.ok(/_hsRec\.state !== 'running'/.test(helper), 'rec.state running guard present');
        assert.ok(/_hsRes\.success === false/.test(helper) && /return null;/.test(helper.slice(helper.indexOf('_hsRes.success === false'))), 'R4 SF3: report result checked before claiming reported');
    });
});
