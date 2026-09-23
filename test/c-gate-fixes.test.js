// C-gate fixes (PR #969 part 2/3, part 4): after-response hook rows
// (worker/020-page-stubs.js pushes {role:'user', content, isHookMessage:true},
// NOT injected) must not end the C2 update-ledger window nor become its
// anchor (app/020-api-messages.js _buildUpdateLedger). Notice rows are built
// by the REAL core/097 builders (_withWakeFinalReminder, _subNoticeMeta,
// _noticeRow); globals stub only chrome/DOM/storage/runtime plumbing.
var T = { tags: ['unit'], timeout: 5000 };
var HEADER = "Updates since the user's last message:";
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
function count(s, sub) { return String(s).split(sub).length - 1; }

describe('C-gate: update ledger ignores after-response hook rows', function() {
    var m, chats;
    beforeEach(async function() {
        chats = { root: { id: 'root', messages: [] } };
        m = await loadModules(['src/js/app/020-api-messages.js', 'src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
            isChatPaused: function() { return false; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function report(id, name, summary) {
        var text = m._withWakeFinalReminder('Sub-agent "' + name + '" (' + id + ') reported (done):\n' + summary
            + '\n\u2014 full report via await_handle("h_' + id + '") or agent_status.');
        return m._noticeRow(text, [m._subNoticeMeta('final', id, name, 'done', summary, text)]);
    }
    function hook(text) { return { role: 'user', content: text, isHookMessage: true }; }
    function lastUser(payload) {
        for (var i = payload.length - 1; i >= 0; i--) if (payload[i].role === 'user') return payload[i];
        return null;
    }
    function transcript() {
        return [
            { role: 'user', content: 'audit X' },
            { role: 'assistant', content: 'dispatched Alpha and Beta' },
            hook('set a concise chat title (max 50 chars) using the set_chat_title tool'),
            { role: 'assistant', content: 'titled' },
            report('sub_a', 'Alpha', 'Alpha found 3 bugs'),
            { role: 'assistant', content: 'Alpha found 3 bugs; Beta still running' },
            hook('provide a TL;DR of everything since the user\'s last message using the set_tldr tool'),
            { role: 'assistant', content: 'tldr set' },
            report('sub_b', 'Beta', 'Beta found nothing')
        ];
    }

    test('wake run after a hook run still lists every update since the real user message', function() {
        var rows = transcript();
        var before = JSON.stringify(rows);
        var payload = m.buildAPIMessages(rows, 'root');
        var anchor = lastUser(payload);
        assert.ok(anchor && typeof anchor.content === 'string', 'wake anchor present');
        assert.strictEqual(count(anchor.content, HEADER), 1, 'exactly one ledger block on the wake anchor');
        var ledger = anchor.content.slice(anchor.content.indexOf(HEADER));
        assert.ok(ledger.indexOf('Alpha found 3 bugs') !== -1, 'earlier wake-run report (before the hook row) is listed');
        assert.ok(ledger.indexOf('Beta found nothing') !== -1, 'current report is listed');
        assert.strictEqual(count(ledger, '\n- [final]'), 2, 'two items, hook rows contribute none');
        assert.strictEqual(JSON.stringify(rows), before, 'chat rows are not mutated (ledger never persisted)');
    }, T);

    test('hook run after a wake run keeps the wake anchor block: payload prefix byte-identical', function() {
        var rows = transcript();
        var wakeReq = m.buildAPIMessages(rows, 'root');
        var hookRows = rows.concat([{ role: 'assistant', content: 'digest: Alpha 3 bugs, Beta nothing' },
            hook('provide a TL;DR of everything since the user\'s last message using the set_tldr tool')]);
        var hookReq = m.buildAPIMessages(hookRows, 'root');
        assert.ok(hookReq.length > wakeReq.length, 'hook request extends the wake request');
        assert.strictEqual(JSON.stringify(hookReq.slice(0, wakeReq.length)), JSON.stringify(wakeReq),
            'every message of the wake run request is unchanged in the hook run request');
        var hookMsg = lastUser(hookReq);
        assert.strictEqual(count(hookMsg.content, HEADER), 0, 'the hook message itself carries no ledger');
        var r = m._buildUpdateLedger(hookRows);
        assert.ok(r && r.anchorIdx === rows.length - 1, 'ledger anchor stays on the wake notice row');
    }, T);

    test('normal run: real user message after hook rows gets no ledger', function() {
        var rows = transcript().concat([{ role: 'assistant', content: 'digest' },
            hook('provide a TL;DR of everything since the user\'s last message using the set_tldr tool'),
            { role: 'assistant', content: 'tldr set' },
            { role: 'user', content: 'thanks, now fix the 3 bugs' }]);
        assert.strictEqual(m._buildUpdateLedger(rows), null, 'real user anchor -> no ledger');
        var payload = m.buildAPIMessages(rows, 'root');
        assert.strictEqual(lastUser(payload).content, 'thanks, now fix the 3 bugs', 'user text byte-identical');
        // Earlier wake anchors carry no block on a normal run.
        payload.forEach(function(p) { if (p.role === 'user') assert.strictEqual(count(p.content, HEADER), 0); });
    }, T);
});
