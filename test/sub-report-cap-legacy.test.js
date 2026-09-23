// Sub-agents (1/3, part 1b) — déroulement fix: a sub record persisted before
// #15 has no summary_cap_bytes. _subCapUtf8 used to compute a NaN budget,
// copy the whole text and STILL append the truncation marker (an empty
// crash fallback became just the marker). A missing cap is now no cap in the
// helper, and report_to_parent / the auto-report fallback use the default.
// Runs against the REAL registry (core/097-sub-agent-registry.js).
// Run: run_tests { files: ['test/sub-report-cap-legacy.test.js'] }
describe('sub-agent report cap: legacy record without summary_cap_bytes', function() {
    var m, chats;
    var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
    var MARK = '\n\u2026[truncated]';
    beforeEach(async function() {
        chats = { root: { messages: [] } };
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
            isChatPaused: function() { return false; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function legacySub() {
        m.spawnSubAgent({ name: 'legacy', instructions: 'do it' }, { chatId: 'root' });
        var id = Object.keys(m._subAgents).filter(function(k) { return m._subAgents[k].parent_chat_id === 'root'; })[0];
        var rec = m._subAgents[id];
        delete rec.summary_cap_bytes; // shape of a record persisted before #15
        return rec;
    }
    test('_subCapUtf8 with no numeric cap returns the text unchanged (no marker)', function() {
        assert.strictEqual(m._subCapUtf8('', undefined, MARK), '');
        assert.strictEqual(m._subCapUtf8('hello', NaN, MARK), 'hello');
        assert.strictEqual(m._subCapUtf8('abc', '12', MARK), 'abc');
        assert.strictEqual(m._subCapUtf8('x'.repeat(50), 20, MARK).slice(-MARK.length), MARK, 'a numeric cap still truncates');
    });
    test('report_to_parent on a legacy record keeps a short summary verbatim', function() {
        var rec = legacySub();
        try { m.reportToParent({ status: 'done', summary: 'All good' }, { chatId: rec.chat_id }); } catch (_) { /* later side effects */ }
        assert.ok(rec.last_report, 'report recorded');
        assert.strictEqual(rec.last_report.summary, 'All good');
    });
    test('report_to_parent on a legacy record applies the default 4 KB cap with a numeric marker', function() {
        var rec = legacySub();
        try { m.reportToParent({ status: 'done', summary: 'y'.repeat(9000) }, { chatId: rec.chat_id }); } catch (_) { /* later side effects */ }
        var s = rec.last_report && rec.last_report.summary;
        assert.ok(s, 'report recorded');
        assert.ok(new TextEncoder().encode(s).length <= 4096, 'bytes: ' + new TextEncoder().encode(s).length);
        assert.ok(/summary exceeded 4096 bytes\]$/.test(s), s.slice(-80));
        assert.ok(s.indexOf('undefined') === -1, 'no "undefined" in the marker');
    });
});
