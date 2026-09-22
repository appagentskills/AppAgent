// #6a — SW-boot stranded-placeholder sweep (Phase 4, fix-all/4-high;
// app/030-agent-loop.js sweepStrandedPlaceholders, flag
// P4_BOOT_PLACEHOLDER_SWEEP; call sites in worker/130-port-bridge.js
// resumeRunningCheckpoints and worker/190-entry.js empty-list boot path).
describe('#6a boot placeholder sweep (app/030-agent-loop.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M.sweepStrandedPlaceholders, 'function');
        assert.strictEqual(typeof M.seedPlaceholderToolResults, 'function');
        assert.strictEqual(typeof M.recordToolResult, 'function');
        return M;
    }
    function reset(m, opts) {
        opts = opts || {};
        var s = m.__scope;
        s.chats = {};
        s.runningChatIds = opts.running || {};
        s.saveCalls = 0;
        s.saveChatsToStorage = function() { s.saveCalls++; return Promise.resolve(); };
        // R4 SF4: chat-inlining broadcast spy (SW tier AgentEvents.emit) + a fake delta watermark map
        s.emits = [];
        s.AgentEvents = opts.noBus ? undefined : { emit: function(type, detail) { s.emits.push({ type: type, detail: detail }); } };
        s._chatDeltaSync = opts.deltaSync || {};
        s.SubAgents = { getByChatId: function(id) { return opts.subState ? { state: opts.subState } : null; } };
        // B11: pause sources consulted by _sweepIsPausedChat — cleared per test
        s.pausedChats = undefined;
        s._pausedByParentChat = undefined;
        return s;
    }
    function strandedChat(id, extra) {
        var chat = {
            id: id,
            messages: [
                { role: 'user', content: 'go' },
                { role: 'assistant', content: '', tool_calls: [
                    { id: 't1', type: 'function', function: { name: 'js_eval', arguments: '{}' } },
                    { id: 't2', type: 'function', function: { name: 'workspace', arguments: '{}' } }
                ] },
                { role: 'tool', tool_call_id: 't1', name: 'js_eval', content: '[Tool call pending — agent runtime restarted before result]', _placeholder: true },
                { role: 'tool', tool_call_id: 't2', name: 'workspace', content: '[Tool call pending — agent runtime restarted before result]', _placeholder: true }
            ]
        };
        Object.assign(chat, extra || {});
        return chat;
    }
    function toolRows(chat) { return chat.messages.filter(function(r) { return r.role === 'tool'; }); }

    test('(1) stranded chat → both rows rewritten in place, _placeholder gone, content is a runtime_restarted failure, one save', async function() {
        var m = await load(); var s = reset(m);
        s.chats.c1 = strandedChat('c1');
        var n = m.sweepStrandedPlaceholders({});
        assert.strictEqual(n, 2);
        var rows = toolRows(s.chats.c1);
        assert.strictEqual(rows.length, 2, 'no rows added or removed');
        assert.strictEqual(s.chats.c1.messages.length, 4);
        rows.forEach(function(r) {
            assert.strictEqual(r._placeholder, undefined, 'flag dropped');
            var parsed = JSON.parse(r.content);
            assert.strictEqual(parsed.success, false);
            assert.strictEqual(parsed.code, 'runtime_restarted');
            assert.ok(/not re-executed/.test(parsed.error), parsed.error);
        });
        assert.strictEqual(rows[0].name, 'js_eval'); assert.strictEqual(rows[1].name, 'workspace');
        assert.strictEqual(s.saveCalls, 1, 'exactly one save');
        // R4 SF4: exactly one chat-inlining broadcast for the rewritten chat, after the save
        assert.strictEqual(s.emits.length, 1, 'one broadcast per rewritten chat');
        assert.strictEqual(s.emits[0].type, 'messagesAppended');
        assert.deepStrictEqual(s.emits[0].detail, { chatId: 'c1', reason: 'stranded_placeholder_sweep' });
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 0, 'idempotent: second sweep finds nothing');
        assert.strictEqual(s.saveCalls, 1, 'no save when nothing rewritten');
        assert.strictEqual(s.emits.length, 1, 'no broadcast when nothing rewritten');
    });
    test('(1b) R4 SF4: broadcast once per REWRITTEN chat only, watermark dropped so the envelope is a full snapshot; no bus → no throw', async function() {
        var m = await load(); var s = reset(m, { deltaSync: { c1: { len: 4, lastRef: null }, other: { len: 1, lastRef: null } } });
        s.chats.c1 = strandedChat('c1');
        s.chats.c2 = strandedChat('c2');
        s.chats.clean = { id: 'clean', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] };
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 4);
        assert.strictEqual(s.emits.length, 2, 'c1 + c2 only');
        assert.deepStrictEqual(s.emits.map(function(e) { return e.detail.chatId; }).sort(), ['c1', 'c2']);
        assert.ok(s.emits.every(function(e) { return e.type === 'messagesAppended' && e.detail.reason === 'stranded_placeholder_sweep'; }));
        assert.strictEqual(s._chatDeltaSync.c1, undefined, 'c1 watermark dropped → full slim snapshot');
        assert.ok(s._chatDeltaSync.other, 'unrelated watermark untouched');
        assert.strictEqual(s.saveCalls, 1, 'save still exactly once');
        // page tier / bus missing: sweep still rewrites + saves, no throw
        s = reset(m, { noBus: true });
        s.chats.c3 = strandedChat('c3');
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 2);
        assert.strictEqual(s.saveCalls, 1);
    });
    test('(2) resumed / running / deleted / running-sub chats are untouched', async function() {
        var m = await load(); var s = reset(m, { running: { run1: true }, subState: 'running' });
        s.chats.res1 = strandedChat('res1');
        s.chats.run1 = strandedChat('run1');
        s.chats.del1 = strandedChat('del1', { _deleted: true });
        s.chats.sub1 = strandedChat('sub1', { isSubAgent: true });
        s.chats.ok1 = strandedChat('ok1');
        var n = m.sweepStrandedPlaceholders({ res1: true });
        assert.strictEqual(n, 2, 'only ok1 swept');
        ['res1', 'run1', 'del1', 'sub1'].forEach(function(id) {
            toolRows(s.chats[id]).forEach(function(r) { assert.strictEqual(r._placeholder, true, id + ' untouched'); });
        });
        toolRows(s.chats.ok1).forEach(function(r) { assert.strictEqual(r._placeholder, undefined); });
        // a sub whose registry record is NOT running (e.g. sleeping/orphaned) IS swept
        s = reset(m, { subState: 'sleeping' });
        s.chats.sub2 = strandedChat('sub2', { isSubAgent: true });
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 2);
    });
    test('(2b) B11: paused chats (pausedByUser / pausedChats / _pausedByParentChat / rec.paused_by_parent_chat) are untouched', async function() {
        var m = await load(); var s = reset(m);
        s.pausedChats = { p2: true };
        s._pausedByParentChat = { p3: { parentChatId: 'parent', resumePending: false } };
        s.SubAgents = { getByChatId: function(id) { return id === 'p4' ? { state: 'sleeping', paused_by_parent_chat: 'parent' } : null; } };
        s.chats.p1 = strandedChat('p1', { pausedByUser: true });
        s.chats.p2 = strandedChat('p2');
        s.chats.p3 = strandedChat('p3', { isSubAgent: true });
        s.chats.p4 = strandedChat('p4', { isSubAgent: true });
        s.chats.ok1 = strandedChat('ok1', { pausedByUser: false });
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 2, 'only ok1 swept');
        ['p1', 'p2', 'p3', 'p4'].forEach(function(id) {
            toolRows(s.chats[id]).forEach(function(r) { assert.strictEqual(r._placeholder, true, id + ' untouched'); });
        });
        toolRows(s.chats.ok1).forEach(function(r) { assert.strictEqual(r._placeholder, undefined); });
        assert.deepStrictEqual(s.emits.map(function(e) { return e.detail.chatId; }), ['ok1']);
        // pause lifted → the next sweep rewrites p1 (no longer paused)
        s.chats.p1.pausedByUser = false;
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 2, 'p1 swept once unpaused');
    });
    test('(3) real tool rows and placeholders in an EARLIER turn are left alone', async function() {
        var m = await load(); var s = reset(m);
        var chat = strandedChat('c3');
        chat.messages[2]._placeholder = undefined; delete chat.messages[2]._placeholder;
        chat.messages[2].content = '{"success":true,"real":1}';
        // an old placeholder BEFORE the last user row is out of scope (walk stops at `user`)
        chat.messages.unshift({ role: 'tool', tool_call_id: 't0', name: 'x', content: 'old', _placeholder: true });
        chat.messages.unshift({ role: 'assistant', content: '', tool_calls: [{ id: 't0', function: { name: 'x' } }] });
        chat.messages.unshift({ role: 'user', content: 'earlier' });
        s.chats.c3 = chat;
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 1, 'only t2 rewritten');
        assert.strictEqual(chat.messages[5].content, '{"success":true,"real":1}', 'real row untouched');
        assert.strictEqual(chat.messages[5]._placeholder, undefined);
        assert.strictEqual(chat.messages[2].tool_call_id, 't0');
        assert.strictEqual(chat.messages[2]._placeholder, true, 'earlier-turn placeholder untouched');
        assert.strictEqual(JSON.parse(chat.messages[6].content).code, 'runtime_restarted');
        // no chats map → 0, no throw
        s.chats = undefined;
        assert.strictEqual(m.sweepStrandedPlaceholders({}), 0);
    });
    test('(4) regression: seedPlaceholderToolResults still seeds exactly N `_placeholder` rows', async function() {
        var m = await load(); reset(m);
        var chat = { messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [] }] };
        var calls = [{ id: 'a', function: { name: 'f1' } }, { id: 'b', function: { name: 'f2' } }, { id: 'c', function: { name: 'f3' } }];
        m.seedPlaceholderToolResults(chat, calls);
        var rows = toolRows(chat);
        assert.strictEqual(rows.length, 3);
        rows.forEach(function(r, i) {
            assert.strictEqual(r._placeholder, true);
            assert.strictEqual(r.tool_call_id, calls[i].id);
            assert.ok(/Tool call pending/.test(r.content));
        });
        m.seedPlaceholderToolResults(chat, calls);
        assert.strictEqual(toolRows(chat).length, 3, 'no duplicates on re-seed');
    });
    test('(5) wiring: both boot call sites are flag-gated, typeof-guarded, hydration-gated and sit before _settleResumeScan', async function() {
        var bridge = await loadFile('src/js/worker/130-port-bridge.js');
        var iFn = bridge.indexOf('function resumeRunningCheckpoints(');
        var body = bridge.slice(iFn);
        var iForEach = body.indexOf('checkpoints.forEach(function(cp) {');
        var iMark = body.indexOf('_p4ResumedIds[cp.chatId] = true;');
        var iSweep = body.indexOf('sweepStrandedPlaceholders(_p4ResumedIds)');
        var iSettle = body.indexOf('_settleResumeScan();', iSweep);
        assert.ok(iForEach > 0 && iMark > iForEach && iSweep > iMark && iSettle > iSweep, '130 order: forEach < mark < sweep < settle');
        var gate130 = body.slice(body.lastIndexOf('if (', iSweep), iSweep);
        assert.ok(/getP4Flag\('P4_BOOT_PLACEHOLDER_SWEEP'\)/.test(gate130) && /typeof sweepStrandedPlaceholders === 'function'/.test(gate130) && /_chatsHydrated/.test(gate130), gate130);
        assert.ok(body.indexOf('runAgent(cp.chatId)', iMark) > iMark, 'mark precedes the runAgent chains');
        var entry = await loadFile('src/js/worker/190-entry.js');
        var iEmpty = entry.indexOf('if (!checkpoints || checkpoints.length === 0) {');
        var iSweepE = entry.indexOf('sweepStrandedPlaceholders({})', iEmpty);
        var iSettleE = entry.indexOf('self._settleResumeScan();', iSweepE);
        var iResume = entry.indexOf('resumeRunningCheckpoints(checkpoints);');
        assert.ok(iEmpty > 0 && iSweepE > iEmpty && iSettleE > iSweepE && iSweepE < iResume, '190 order: empty-list branch < sweep < settle, before the non-empty resume call');
        var gate190 = entry.slice(entry.lastIndexOf('if (', iSweepE), iSweepE);
        assert.ok(/getP4Flag\('P4_BOOT_PLACEHOLDER_SWEEP'\)/.test(gate190) && /typeof sweepStrandedPlaceholders === 'function'/.test(gate190) && /_chatsHydrated/.test(gate190), gate190);
    });
});
