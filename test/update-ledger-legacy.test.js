// PR #971 (part 3): the request-time update ledger (app/020-api-messages.js
// _buildUpdateLedger) labelled an agent_message callout "[message, not sent
// to you before]" when its model-visible notice had been delivered by a
// LEGACY row — one persisted by an older build: role/content/injected only,
// no subNotices meta, no hasUserText. _ledgerLegacyTwinSent now finds that
// notice by its exact core/097 text. Loads the REAL 020 + 097: callouts and
// notices come from the real agentMessage / _wakeParentOnReport /
// _notifySubLifecycle; a legacy row is a real notice row with its meta
// removed (the #969-build shape, reminder kept) or with the pre-#968 text
// (core/097 agentMessage at e4484d6: no reminder). Part 5 (L1): the match is
// anchored on both edges, so a longer legacy message that only shares the
// callout's prefix does not count.
var T = { tags: ['unit'], timeout: 5000 };
var HEADER = "Updates since the user's last message:";
var REMINDER = "Reminder: your final message must be a cumulative digest of everything since the user's last message.";
var NOT_SENT = 'not sent to you before';
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
function snap(x) { return JSON.stringify(x); }
// Pre-#968 core/097 agentMessage(to:'parent') notice: no meta, no reminder,
// newlines flattened, capped at 3800.
function legacyNotice(name, id, text) {
    return '[sub-agent lifecycle] ' + name + ' (' + id + '): sent a message: ' + String(text).replace(/\s*\n+\s*/g, ' ').slice(0, 3800);
}
function legacyRow(content) { return { role: 'user', content: content, injected: true }; }

describe('update ledger: legacy agent_message notices count as sent (app/020 _ledgerLegacyTwinSent)', function() {
    var m, chats, pend, running, paused;
    beforeEach(async function() {
        chats = { root: { id: 'root', messages: [] } }; pend = {}; running = {}; paused = {};
        m = await loadModules(['src/js/app/020-api-messages.js', 'src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: paused, runningChatIds: running, pendingInjectionsByChatId: pend,
            isChatPaused: function(id) { return paused[id] === true; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function sub(id, name, wakeParent) {
        var h = m.Handles.start('root', 'spawn_sub_agent', {}, id, function() { return new Promise(function() {}); });
        var r = { agent_id: id, chat_id: 'c_' + id, name: name, state: 'running', spawn_handle_id: h.handleId, parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now() };
        if (wakeParent === false) r.wake_parent = false;
        m._subAgents[id] = r;
        chats['c_' + id] = { isSubAgent: true, subAgentId: id, messages: [] };
        return r;
    }
    function msgs() { return chats.root.messages; }
    function linesOf(r) { return r ? r.block.split('\n') : null; }
    // REAL agent_message(to:'parent') (core/097 agentMessage): its sub_msg
    // callout and, unless wake_parent:false, its current-build notice row.
    // The parent is paused only for the call, so the idle path pushes the
    // row without scheduling a run.
    function send(rec, text) {
        var before = msgs().length, res;
        paused.root = true;
        try { res = m.agentMessage({ to: 'parent', content: text }, { chatId: rec.chat_id }); } finally { paused.root = false; }
        assert.strictEqual(res && res.success, true, JSON.stringify(res));
        var added = msgs().slice(before);
        return {
            callout: added.filter(function(r) { return r.role === 'sub_msg'; })[0],
            notice: added.filter(function(r) { return r.role === 'user'; })[0]
        };
    }
    // An older build's copy of a notice row: meta removed; content kept (the
    // #969-build shape, reminder line included) or replaced by pre968 text.
    function legacify(row, pre968) {
        delete row.subNotices;
        if (pre968 != null) row.content = pre968;
        assert.ok(!m._isRealUserRow(row) && row.hasUserText === undefined, 'injected-only legacy row');
        return row;
    }
    // The pre-fix _buildUpdateLedger, rebuilt from the REAL 020 pieces (meta
    // twin filter only): the byte-identity reference and the bug repro.
    function preFixLedger(rows) {
        var ai = -1;
        for (var i = rows.length - 1; i >= 0; i--) { if (rows[i] && rows[i].role === 'user' && rows[i].isHookMessage !== true) { ai = i; break; } }
        if (ai === -1 || m._isRealUserRow(rows[ai])) return null;
        var start = ai;
        while (start > 0 && !m._isLedgerBoundaryRow(rows[start - 1])) start--;
        var items = [];
        for (var k = start; k <= ai; k++) items.push.apply(items, m._ledgerRowItems(rows[k]));
        items = items.filter(function(it) {
            return it.twinOf == null || !items.some(function(o) { return o.twinOf == null && o.kind === 'message' && o.agentId === it.agentId && o.summary === it.twinOf; });
        });
        var unsent = items.some(function(it) { return it.unsent; });
        if (items.length < 2 && !unsent) return null;
        return { anchorIdx: ai, block: m._formatUpdateLedger(items), count: items.length };
    }

    test('diag repro: [0] is the only real user row; messages delivered by legacy rows are listed as sent', async function() {
        var a = sub('a', 'Alpha'), c = sub('c', 'Gamma');
        msgs().push({ role: 'user', content: 'run the audit' }, { role: 'assistant', content: 'spawned' });
        var s1 = send(a, 'Scanning 097\nfound 2 hits');
        legacify(s1.notice, legacyNotice('Alpha', 'a', s1.callout.text)); // pre-#968 row
        msgs().push({ role: 'assistant', content: 'noted' });
        var s2 = send(c, 'Gate: 0 refuted');
        legacify(s2.notice); // #969-build row (reminder kept)
        msgs().push({ role: 'assistant', content: 'noted' });
        m._wakeParentOnReport(a, { status: 'done', summary: 'A finished' }, {}); // current-build anchor
        var before = snap(msgs());
        var old = preFixLedger(msgs());
        assert.ok(old.block.indexOf('- [message, ' + NOT_SENT + '] Alpha (a): Scanning 097') !== -1, 'pre-fix mislabel reproduced');
        assert.ok(old.block.indexOf('- [message, ' + NOT_SENT + '] Gamma (c): Gate: 0 refuted') !== -1, 'pre-fix mislabel reproduced (#969 row)');
        var got = m._buildUpdateLedger(msgs());
        assert.deepStrictEqual(linesOf(got), [HEADER,
            '- [message] Alpha (a): Scanning 097',
            '- [message] Gamma (c): Gate: 0 refuted',
            '- [final] Alpha (a) \u2014 done: A finished']);
        assert.strictEqual(got.count, old.count, 'same items, only the label changes');
        var out = m.buildAPIMessages(msgs(), 'root');
        var tail = out[out.length - 1].content;
        assert.ok(tail.indexOf('\n\n' + got.block) !== -1, 'block appended to the anchor');
        assert.strictEqual(tail.indexOf(NOT_SENT), -1);
        assert.strictEqual(snap(msgs()), before, 'chat rows not mutated');
        assert.strictEqual(snap(m._buildUpdateLedger(msgs())), snap(got), 'deterministic');
    }, T);

    test('pre-#968 legacy row (no reminder suffix): [message]', async function() {
        var a = sub('a', 'Alpha');
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        var s = send(a, 'Halfway there');
        legacify(s.notice, legacyNotice('Alpha', 'a', s.callout.text));
        assert.strictEqual(s.notice.content, '[sub-agent lifecycle] Alpha (a): sent a message: Halfway there');
        m._notifySubLifecycle(a, 'still running');
        assert.deepStrictEqual(linesOf(m._buildUpdateLedger(msgs())), [HEADER,
            '- [message] Alpha (a): Halfway there',
            '- [lifecycle] Alpha (a) \u2014 running: still running']);
    }, T);

    test('#969-build legacy row (reminder suffix) is the real notice minus its meta: [message]', async function() {
        var a = sub('a', 'Alpha');
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        var s = send(a, 'Halfway there');
        assert.ok(Array.isArray(s.notice.subNotices) && s.notice.subNotices[0].kind === 'message', 'current build writes a meta');
        assert.strictEqual(s.notice.content, legacyNotice('Alpha', 'a', s.callout.text) + '\n' + REMINDER, 'real notice = pre-#968 text + reminder line');
        legacify(s.notice);
        m._notifySubLifecycle(a, 'still running');
        var got = m._buildUpdateLedger(msgs());
        assert.deepStrictEqual(linesOf(got), [HEADER,
            '- [message] Alpha (a): Halfway there',
            '- [lifecycle] Alpha (a) \u2014 running: still running']);
        assert.ok(preFixLedger(msgs()).block.indexOf('[message, ' + NOT_SENT + '] Alpha (a)') !== -1, 'pre-fix mislabel');
    }, T);

    test('multi-line text: flattened exactly like core/097', async function() {
        var a = sub('a', 'Alpha');
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        var s = send(a, '## Status\n\n- item 1\n  - item 2\r\nlast line  \n');
        assert.ok(s.callout.text.indexOf('\n') !== -1, 'callout keeps the multi-line text');
        var flatAt = s.notice.content.indexOf('): sent a message: ');
        assert.strictEqual(s.notice.content.slice(flatAt).split('\n')[0], '): sent a message: ## Status - item 1 - item 2 last line ', 'real notice text is flattened to one line');
        legacify(s.notice, legacyNotice('Alpha', 'a', s.callout.text));
        m._notifySubLifecycle(a, 'still running');
        assert.deepStrictEqual(linesOf(m._buildUpdateLedger(msgs())), [HEADER,
            '- [message] Alpha (a): Status',
            '- [lifecycle] Alpha (a) \u2014 running: still running']);
        // The RAW multi-line text is not the delivered shape: no match.
        s.notice.content = '[sub-agent lifecycle] Alpha (a): sent a message: ' + s.callout.text;
        assert.strictEqual(linesOf(m._buildUpdateLedger(msgs()))[1], '- [message, ' + NOT_SENT + '] Alpha (a): Status');
    }, T);

    test('text over the 3800 cap: the capped legacy text matches; a differently cut one does not', async function() {
        var a = sub('a', 'Alpha');
        var big = '';
        for (var i = 0; big.length < 5000; i++) big += 'line ' + i + ' of a long report\n';
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        var s = send(a, big);
        var flat = s.callout.text.replace(/\s*\n+\s*/g, ' ');
        assert.ok(flat.length > 3800, 'callout text over the cap (' + flat.length + ')');
        var body = s.notice.content.slice(s.notice.content.indexOf('): sent a message: ') + '): sent a message: '.length);
        assert.strictEqual(body, flat.slice(0, 3800) + '\n' + REMINDER, 'real builder caps the notice at 3800');
        legacify(s.notice); // #969 shape, capped text + reminder
        m._notifySubLifecycle(a, 'still running');
        var want = [HEADER, '- [message] Alpha (a): line 0 of a long report', '- [lifecycle] Alpha (a) \u2014 running: still running'];
        assert.deepStrictEqual(linesOf(m._buildUpdateLedger(msgs())), want);
        legacify(s.notice, legacyNotice('Alpha', 'a', s.callout.text)); // pre-#968 shape
        assert.deepStrictEqual(linesOf(m._buildUpdateLedger(msgs())), want);
        s.notice.content = '[sub-agent lifecycle] Alpha (a): sent a message: ' + flat.slice(0, 3000);
        assert.strictEqual(linesOf(m._buildUpdateLedger(msgs()))[1], '- [message, ' + NOT_SENT + '] Alpha (a): line 0 of a long report');
    }, T);

    test('no delivered twin stays "not sent": wake_parent:false, other agent, other text, assistant echo, row outside the window', async function() {
        var a = sub('a', 'Alpha'), b = sub('b', 'Beta', false);
        msgs().push(legacyRow(legacyNotice('Beta', 'b', 'hello there')), // before the boundary
            { role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        var s = send(b, 'hello there');
        assert.ok(s.callout && s.notice === undefined, 'wake_parent:false: callout only, no notice');
        msgs().push(legacyRow(legacyNotice('Alpha', 'a', 'hello there')), // same text, other agent
            legacyRow(legacyNotice('Beta', 'b', 'goodbye')), // same agent, other text
            { role: 'assistant', content: legacyNotice('Beta', 'b', 'hello there') }); // not a user row
        m._notifySubLifecycle(a, 'still running');
        var got = m._buildUpdateLedger(msgs());
        assert.deepStrictEqual(linesOf(got), [HEADER,
            '- [message, ' + NOT_SENT + '] Beta (b): hello there',
            '- [lifecycle] Alpha (a) \u2014 running: still running']);
        assert.strictEqual(snap(got), snap(preFixLedger(msgs())), 'unchanged vs pre-fix');
        var ai = msgs().length - 1;
        assert.strictEqual(m._ledgerLegacyTwinSent(msgs(), 0, ai, 'b', 'hello there'), true, 'found when the window includes [0]');
        assert.strictEqual(m._ledgerLegacyTwinSent(msgs(), 1, ai, 'b', 'hello there'), false, 'only msgs[start..end] is searched');
        // A row WITH subNotices is left to the meta filter even if its text matches.
        var withMeta = { role: 'user', injected: true, content: legacyNotice('Beta', 'b', 'hello there'), subNotices: [m._subNoticeMeta('lifecycle', 'b', 'Beta', 'running', 'x', 'x')] };
        assert.strictEqual(m._ledgerLegacyTwinSent([withMeta], 0, 0, 'b', 'hello there'), false);
        assert.strictEqual(m._ledgerLegacyTwinSent([legacyRow(legacyNotice('Beta', 'b', ''))], 0, 0, 'b', ''), false, 'empty text never matches');
        assert.strictEqual(m._ledgerLegacyTwinSent([legacyRow(legacyNotice('Beta', 'b', 'x'))], 0, 0, null, 'x'), false, 'no agent id never matches');
    }, T);

    test('meta twin (current build): unchanged — the callout is listed once, as the meta item', async function() {
        var a = sub('a', 'Alpha'), c = sub('c', 'Gamma');
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        send(a, 'progress: 50%\nhalfway');
        var s = send(c, 'legacy one');
        legacify(s.notice);
        m._wakeParentOnReport(a, { status: 'done', summary: 'A finished' }, {});
        assert.deepStrictEqual(linesOf(m._buildUpdateLedger(msgs())), [HEADER,
            '- [message] Alpha (a) \u2014 running: progress: 50%',
            '- [message] Gamma (c): legacy one',
            '- [final] Alpha (a) \u2014 done: A finished']);
        msgs().splice(msgs().indexOf(s.callout), 2); // drop Gamma's legacy pair: meta-only window
        var got = m._buildUpdateLedger(msgs());
        assert.strictEqual(snap(got), snap(preFixLedger(msgs())), 'meta-twin window byte-identical to pre-fix');
        assert.deepStrictEqual(linesOf(got), [HEADER,
            '- [message] Alpha (a) \u2014 running: progress: 50%',
            '- [final] Alpha (a) \u2014 done: A finished']);
    }, T);

    test('no legacy rows: output byte-identical to the pre-fix ledger', async function() {
        var a = sub('a', 'Alpha'), b = sub('b', 'Beta', false);
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        send(a, 'twin message\nline 2');
        send(b, 'silent message');
        msgs().push({ role: 'user', content: 'plain injected note', injected: true }); // no meta, no notice text
        m._wakeParentOnReport(b, { status: 'done', summary: 'B passive' }, {});
        m._notifySubLifecycle(a, 'STUCK \u2014 no progress');
        var before = snap(msgs());
        var got = m._buildUpdateLedger(msgs());
        assert.strictEqual(snap(got), snap(preFixLedger(msgs())));
        assert.deepStrictEqual(linesOf(got), [HEADER,
            '- [message] Alpha (a) \u2014 running: twin message',
            '- [message, ' + NOT_SENT + '] Beta (b): silent message',
            '- [passive report, ' + NOT_SENT + '] Beta (b) \u2014 done: B passive',
            '- [lifecycle] Alpha (a) \u2014 running: STUCK \u2014 no progress']);
        var out = m.buildAPIMessages(msgs(), 'root');
        assert.ok(out[out.length - 1].content.indexOf('\n\n' + got.block) !== -1);
        assert.strictEqual(snap(msgs()), before, 'chat rows not mutated');
        // Every prefix window ending on an injected row matches the reference too.
        for (var n = 1; n <= msgs().length; n++) {
            var w = msgs().slice(0, n);
            assert.strictEqual(snap(m._buildUpdateLedger(w)), snap(preFixLedger(w)), 'window 0..' + (n - 1));
        }
    }, T);

    test('lone callout whose legacy notice is the anchor itself: no block (was a spurious "not sent" block)', async function() {
        var a = sub('a', 'Alpha');
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        var s = send(a, 'only update');
        legacify(s.notice, legacyNotice('Alpha', 'a', s.callout.text));
        assert.strictEqual(msgs()[msgs().length - 1], s.notice, 'the legacy notice is the anchor');
        assert.ok(preFixLedger(msgs()) !== null, 'pre-fix: spurious block');
        assert.strictEqual(m._buildUpdateLedger(msgs()), null);
        var out = m.buildAPIMessages(msgs(), 'root');
        assert.strictEqual(out[out.length - 1].content, s.notice.content, 'anchor sent as persisted');
    }, T);

    // L1 (#972 delta review): the needle was only left-anchored, so a callout
    // "Done" counted as sent when a legacy row of the same sub said "Done with
    // phase 1". A hit now needs end-of-row or '\n' right after the needle.
    test('L1: a longer legacy message that only shares the prefix does not mark the callout sent', async function() {
        var a = sub('a', 'Alpha');
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        var s1 = send(a, 'Done with phase 1');
        legacify(s1.notice, legacyNotice('Alpha', 'a', s1.callout.text)); // pre-#968 row
        var s2 = send(a, 'Done');
        msgs().splice(msgs().indexOf(s2.notice), 1); // this callout's notice was never delivered
        m._notifySubLifecycle(a, 'still running');
        var ai = msgs().length - 1;
        assert.ok(s1.notice.content.indexOf('(a): sent a message: Done') !== -1, 'the old left-anchored substring hit (L1 repro)');
        assert.strictEqual(m._ledgerLegacyTwinSent(msgs(), 0, ai, 'a', 'Done'), false);
        assert.strictEqual(m._ledgerLegacyTwinSent(msgs(), 0, ai, 'a', 'Done with phase 1'), true);
        var want = [HEADER,
            '- [message] Alpha (a): Done with phase 1',
            '- [message, ' + NOT_SENT + '] Alpha (a): Done',
            '- [lifecycle] Alpha (a) \u2014 running: still running'];
        assert.deepStrictEqual(linesOf(m._buildUpdateLedger(msgs())), want);
        legacify(s1.notice, legacyNotice('Alpha', 'a', s1.callout.text) + '\n' + REMINDER); // #969 shape
        assert.strictEqual(m._ledgerLegacyTwinSent(msgs(), 0, ai, 'a', 'Done'), false, 'reminder-suffixed longer row');
        assert.deepStrictEqual(linesOf(m._buildUpdateLedger(msgs())), want);
        // One coalesced legacy row delivered both notices: both callouts were sent.
        legacify(s1.notice, legacyNotice('Alpha', 'a', 'Done with phase 1') + '\n' + REMINDER + '\n\n' + legacyNotice('Alpha', 'a', 'Done') + '\n' + REMINDER);
        assert.deepStrictEqual(linesOf(m._buildUpdateLedger(msgs())), [HEADER,
            '- [message] Alpha (a): Done with phase 1',
            '- [message] Alpha (a): Done',
            '- [lifecycle] Alpha (a) \u2014 running: still running']);
    }, T);

    test('L1: exact, reminder-suffixed and \\n\\n-joined rows still count; a prefix-only hit before an exact one in the same row counts', async function() {
        var A = legacyNotice('Alpha', 'a', 'Done'), LONG = legacyNotice('Alpha', 'a', 'Done with phase 1'), B = legacyNotice('Beta', 'b', 'other');
        function sent(content) { return m._ledgerLegacyTwinSent([legacyRow(content)], 0, 0, 'a', 'Done'); }
        assert.strictEqual(sent(A), true, 'exact (pre-#968 row)');
        assert.strictEqual(sent(A + '\n' + REMINDER), true, 'reminder suffix (#969 row)');
        assert.strictEqual(sent(A + '\n\n' + B), true, 'joined: head');
        assert.strictEqual(sent(B + '\n' + REMINDER + '\n\n' + A), true, 'joined: tail');
        assert.strictEqual(sent(B + '\n\n' + A + '\n' + REMINDER + '\n\n' + B), true, 'joined: middle');
        assert.strictEqual(sent(LONG), false, 'prefix only');
        assert.strictEqual(sent(LONG + '\n' + REMINDER + '\n\n' + B), false, 'prefix only, joined');
        assert.strictEqual(sent(LONG + '\n\n' + LONG), false, 'two prefix-only occurrences');
        assert.strictEqual(sent(A + ' '), false, 'a trailing space is not a boundary');
        assert.strictEqual(sent(LONG + '\n\n' + A), true, 'prefix-only occurrence, then an exact one');
        assert.strictEqual(sent(LONG + '\n' + REMINDER + '\n\n' + A + '\n' + REMINDER), true, 'same, #969 shape');
        // The other guards are unchanged.
        assert.strictEqual(m._ledgerLegacyTwinSent([legacyRow(A), { role: 'user', content: 'go' }], 1, 1, 'a', 'Done'), false, 'row outside the window');
        assert.strictEqual(m._ledgerLegacyTwinSent([{ role: 'user', content: A }], 0, 0, 'a', 'Done'), false, 'real user row');
        assert.strictEqual(m._ledgerLegacyTwinSent([{ role: 'assistant', content: A }], 0, 0, 'a', 'Done'), false, 'assistant row');
        assert.strictEqual(m._ledgerLegacyTwinSent([{ role: 'user', injected: true, content: [{ type: 'text', text: A }] }], 0, 0, 'a', 'Done'), false, 'non-string content');
        assert.strictEqual(m._ledgerLegacyTwinSent([{ role: 'user', injected: true, content: A, subNotices: [] }], 0, 0, 'a', 'Done'), true, 'an empty subNotices list is still a legacy row');
    }, T);
});
