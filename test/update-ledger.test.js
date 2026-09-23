// C2/C2b (PR #969 part 2/3, part 2): request-time "update ledger" and the
// wake-reminder dedupe in buildAPIMessages (app/020-api-messages.js). Rows
// are built by the REAL core/097 builders (_wakeParentOnReport,
// _notifySubLifecycle, _noticeRow, _queueNoticeInjection); globals stub only
// chrome/DOM/storage/runtime plumbing.
var T = { tags: ['unit'], timeout: 5000 };
var REMINDER = "Reminder: your final message must be a cumulative digest of everything since the user's last message.";
var HEADER = "Updates since the user's last message:";
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
function count(s, sub) { return String(s).split(sub).length - 1; }
function snap(x) { return JSON.stringify(x); }

describe('C2 update ledger + C2b reminder dedupe (app/020 buildAPIMessages)', function() {
    var m, chats, pend, running;
    beforeEach(async function() {
        chats = { root: { id: 'root', messages: [] } }; pend = {}; running = {};
        m = await loadModules(['src/js/app/020-api-messages.js', 'src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: running, pendingInjectionsByChatId: pend,
            isChatPaused: function() { return false; }, runAgent: function() { return Promise.resolve(); },
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
    function last() { return msgs()[msgs().length - 1]; }
    function ledgerOf(content) { var at = String(content).indexOf(HEADER); return at === -1 ? null : String(content).slice(at); }

    test('normal run (real user anchor): payload byte-identical, no ledger', async function() {
        var a = sub('a', 'Alpha'), b = sub('b', 'Beta', false);
        msgs().push({ role: 'user', content: 'do X' }, { role: 'assistant', content: 'spawned' });
        assert.strictEqual(m._wakeParentOnReport(a, { status: 'done', summary: 'A finished' }, {}), true);
        var n1 = last();
        msgs().push({ role: 'assistant', content: 'noted A' });
        m._wakeParentOnReport(b, { status: 'done', summary: 'B found 3 issues' }, {});
        assert.strictEqual(last().role, 'sub_msg', 'passive row from the real builder');
        m._notifySubLifecycle(a, 'STUCK \u2014 no progress');
        var n2 = last();
        msgs().push({ role: 'assistant', content: 'noted lifecycle' }, { role: 'user', content: 'next question' });
        var before = snap(msgs());
        var out = m.buildAPIMessages(msgs(), 'root');
        var expected = [
            { role: 'user', content: 'do X' }, { role: 'assistant', content: 'spawned' },
            { role: 'user', content: n1.content }, { role: 'assistant', content: 'noted A' },
            { role: 'user', content: n2.content }, { role: 'assistant', content: 'noted lifecycle' },
            { role: 'user', content: 'next question' }
        ];
        assert.strictEqual(snap(out), snap(expected), 'byte-identical to the plain role/content mapping');
        assert.strictEqual(snap(out).indexOf('Updates since'), -1);
        assert.strictEqual(snap(msgs()), before, 'chat rows not mutated');
    }, T);

    test('wake run with a single notice (the anchor itself): no block', async function() {
        var a = sub('a', 'Alpha');
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        m._wakeParentOnReport(a, { status: 'done', summary: 'All good' }, {});
        var anchor = last();
        assert.strictEqual(m._isRealUserRow(anchor), false);
        msgs().push({ role: 'assistant', content: '' }); // streaming placeholder
        var out = m.buildAPIMessages(msgs(), 'root');
        assert.strictEqual(out.length, 3);
        assert.strictEqual(out[2].content, anchor.content, 'anchor content exactly as persisted');
        assert.strictEqual(m._buildUpdateLedger(msgs()), null);
    }, T);

    test('wake run: earlier notice + passive sub_msg + lifecycle -> ONE block on the latest row only', async function() {
        var a = sub('a', 'Alpha'), b = sub('b', 'Beta', false);
        msgs().push({ role: 'user', content: 'do X' }, { role: 'assistant', content: 'spawned' });
        m._wakeParentOnReport(a, { status: 'done', summary: '## A finished\nsecond line' }, {});
        var n1 = last();
        msgs().push({ role: 'assistant', content: 'noted A' });
        m._wakeParentOnReport(b, { status: 'done', summary: 'B found 3 issues' }, {});
        assert.strictEqual(last().role, 'sub_msg');
        assert.strictEqual(last().kind, 'passive_report');
        m._notifySubLifecycle(a, 'STUCK \u2014 no progress');
        var anchor = last();
        var before = snap(msgs());
        var out = m.buildAPIMessages(msgs(), 'root');
        assert.strictEqual(out.length, 5, 'sub_msg row itself still dropped');
        assert.strictEqual(out[2].content, n1.content, 'earlier notice row unchanged');
        assert.strictEqual(count(snap(out), HEADER), 1, 'exactly one block');
        var tail = out[4].content;
        assert.strictEqual(tail.indexOf(anchor.content), 0, 'anchor text first, unchanged');
        var block = tail.slice(anchor.content.length);
        assert.strictEqual(block.indexOf('\n\n' + HEADER + '\n'), 0);
        var lines = block.slice(2).split('\n');
        assert.deepStrictEqual(lines, [
            HEADER,
            '- [final] Alpha (a) \u2014 done: A finished',
            '- [passive report, not sent to you before] Beta (b) \u2014 done: B found 3 issues',
            '- [lifecycle] Alpha (a) \u2014 running: STUCK \u2014 no progress'
        ]);
        assert.strictEqual(snap(msgs()), before, 'input chat not mutated (nothing persisted)');
        assert.ok(!msgs().some(function(r) { return r.role === 'context'; }), 'no context row added');
        assert.strictEqual(snap(m.buildAPIMessages(msgs(), 'root')), snap(out), 'deterministic (prefix-cache stable)');
    }, T);

    test('lone passive sub_msg is enough; rows after the anchor are ignored', async function() {
        var b = sub('b', 'Beta', false), a = sub('a', 'Alpha');
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' });
        m._wakeParentOnReport(b, { status: 'error', summary: 'B broke' }, {});
        m._wakeParentOnReport(a, { status: 'done', summary: 'A ok' }, {});
        var anchor = last();
        var out1 = m.buildAPIMessages(msgs(), 'root');
        var blk = ledgerOf(out1[out1.length - 1].content);
        assert.ok(blk && blk.indexOf('Beta (b) \u2014 error: B broke') !== -1 && blk.indexOf('Alpha (a) \u2014 done: A ok') !== -1);
        // A passive row landing AFTER the anchor (mid-run) must not change the anchor's content.
        msgs().push({ role: 'assistant', content: 'working' });
        m._wakeParentOnReport(b, { status: 'done', summary: 'B again' }, {});
        var out2 = m.buildAPIMessages(msgs(), 'root');
        assert.strictEqual(out2[2].content, out1[2].content, 'anchor content stable within the run');
        assert.strictEqual(anchor.content.indexOf(HEADER), -1);
    }, T);

    test('cap: <= 20 newest items + "\u2026N earlier", <= 2000 chars, lines <= 200 chars', async function() {
        msgs().push({ role: 'user', content: 'go' });
        for (var i = 0; i < 25; i++) {
            var txt = m._withWakeFinalReminder('[sub-agent lifecycle] S' + i + ' (s' + i + '): event ' + i);
            msgs().push({ role: 'assistant', content: 'a' + i });
            msgs().push(m._noticeRow(txt, [m._subNoticeMeta('lifecycle', 's' + i, 'S' + i, 'running', 'event ' + i + ' ' + new Array(60).join('xyz '), txt)]));
        }
        var out = m.buildAPIMessages(msgs(), 'root');
        var blk = ledgerOf(out[out.length - 1].content);
        assert.ok(blk, 'block emitted');
        var lines = blk.split('\n');
        assert.strictEqual(lines[0], HEADER);
        assert.ok(/^- \u2026\d+ earlier updates not listed$/.test(lines[1]), lines[1]);
        var items = lines.slice(2);
        assert.ok(items.length <= 20 && items.length >= 5, 'item count ' + items.length);
        assert.strictEqual(Number(lines[1].match(/\d+/)[0]) + items.length, 25, 'omitted + kept = all');
        assert.ok(items[items.length - 1].indexOf('S24 (s24)') !== -1, 'newest kept');
        assert.ok(blk.length <= 2000, 'block ' + blk.length + ' chars');
        items.forEach(function(l) { assert.ok(l.length <= 200, 'line ' + l.length); });
        for (var j = 3; j < out.length - 1; j += 2) assert.strictEqual(ledgerOf(out[j].content), null, 'earlier rows carry no block');
    }, T);

    test('C2b: coalesced row keeps ONE reminder (the last) in outgoing content; persisted row + meta.text untouched', async function() {
        var a = sub('a', 'Alpha'), b = sub('b', 'Beta');
        running.root = true; // live parent -> notices coalesce in the injection queue
        m._wakeParentOnReport(a, { status: 'done', summary: 'A ok' }, {});
        m._notifySubLifecycle(b, 'crashed (boom)');
        m._wakeParentOnReport(b, { status: 'need_input', summary: 'B asks?' }, {});
        var entry = pend.root;
        assert.strictEqual(count(entry.text, REMINDER), 3);
        var row = m._noticeRow(entry.text, entry.subNotices);
        msgs().push({ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }, row,
            { role: 'assistant', content: 'done' }, { role: 'user', content: 'thanks' });
        var before = snap(msgs());
        var out = m.buildAPIMessages(msgs(), 'root');
        var c = out[2].content;
        assert.strictEqual(count(c, REMINDER), 1, 'one reminder');
        assert.strictEqual(c.slice(-REMINDER.length - 1), '\n' + REMINDER, 'the last copy is kept');
        assert.strictEqual(c, entry.text.split('\n').filter(function(l, i, arr) { return l !== REMINDER || i === arr.lastIndexOf(REMINDER); }).join('\n'));
        assert.strictEqual(snap(msgs()), before, 'persisted rows unchanged');
        assert.strictEqual(count(row.content, REMINDER), 3);
        row.subNotices.forEach(function(sn) { assert.ok(row.content.indexOf(sn.text) !== -1, 'meta.text span still locatable'); });
        assert.strictEqual(out[4].content, 'thanks');
        // Same coalesced row as a wake anchor: dedupe + ledger (3 items) together.
        msgs().splice(3);
        var out2 = m.buildAPIMessages(msgs(), 'root');
        var c2 = out2[2].content;
        assert.strictEqual(count(c2, REMINDER), 1);
        assert.strictEqual(count(ledgerOf(c2), '\n- ['), 3);
        assert.ok(c2.indexOf(REMINDER) < c2.indexOf(HEADER), 'block after the kept reminder');
    }, T);
});
