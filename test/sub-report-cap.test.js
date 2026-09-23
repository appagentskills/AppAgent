// Sub-agent report cap + names (group B, part 1): the report_to_parent /
// fallback summary cap counts REAL UTF-8 bytes, cuts on a code-point
// boundary and closes an open ``` fence; spawn names are sanitised and the
// spawn fuse compares against the stored (sanitised) name. Runs against the
// REAL registry (core/097-sub-agent-registry.js).
// Run: run_tests { files: ['test/sub-report-cap.test.js'] }
describe('sub-agent report cap and sanitised names', function() {
    var m, chats, runs;
    var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
    var MARK = '\n\u2026[truncated]';
    function utf8(s) { return new TextEncoder().encode(s).length; }
    function loneSurrogate(s) { return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s); }
    beforeEach(async function() {
        chats = { root: { messages: [] } }; runs = [];
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
            isChatPaused: function() { return false; }, runAgent: function(id) { runs.push(id); return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    test('3000 emoji: at most the cap in UTF-8 bytes, no lone surrogate, marker kept', function() {
        var out = m._subCapUtf8('\uD83D\uDE00'.repeat(3000), 4096, MARK);
        assert.ok(utf8(out) <= 4096, 'bytes: ' + utf8(out));
        assert.ok(utf8(out) > 3900, 'budget used: ' + utf8(out));
        assert.ok(!loneSurrogate(out), 'lone surrogate at the cut');
        assert.ok(out.slice(-MARK.length) === MARK, 'marker appended');
        assert.strictEqual(m._subUtf8Len('\uD83D\uDE00\u00e9a'), 7);
    });
    test('an open ``` fence is closed before the marker; a closed one is left alone', function() {
        var out = m._subCapUtf8('Intro\n```js\n' + 'x = 1;\n'.repeat(2000), 1024, MARK);
        assert.ok(utf8(out) <= 1024, 'bytes: ' + utf8(out));
        assert.strictEqual((out.match(/^[ \t]*```/gm) || []).length % 2, 0, 'fence balanced');
        assert.ok(out.slice(-(4 + MARK.length)) === '\n```' + MARK, 'closing fence right before the marker');
        var closed = m._subCapUtf8('```\ncode\n```\n' + 'y'.repeat(3000), 1024, MARK);
        assert.strictEqual((closed.match(/^```/gm) || []).length, 2, 'no extra fence');
        assert.ok(utf8(closed) <= 1024);
    });
    test('text that fits is returned unchanged', function() {
        assert.strictEqual(m._subCapUtf8('abc \uD83D\uDE00', 64, MARK), 'abc \uD83D\uDE00');
    });
    test('names: quotes, parentheses, newlines and control chars stripped; capped; id fallback', function() {
        assert.strictEqual(m._subSanitizeName('Fix "quotes" (v2)\n\tnow', 'id'), 'Fix quotes v2 now');
        assert.strictEqual(m._subSanitizeName('a\u2028b\u0007c', 'id'), 'a b c');
        assert.strictEqual(m._subSanitizeName('  ""()  ', 'sub_x'), 'sub_x');
        assert.strictEqual(m._subSanitizeName(null, 'sub_x'), 'sub_x');
        var n = m._subSanitizeName('\uD83D\uDE80'.repeat(100), 'x');
        assert.strictEqual(Array.from(n).length, 80);
        assert.ok(!loneSurrogate(n));
    });
    test('producer-side newline normaliser follows the render-side rule', function() {
        assert.strictEqual(m._subNormalizeNewlines('a\\nb\\nc'), 'a\nb\nc');
        assert.strictEqual(m._subNormalizeNewlines('one \\n only'), 'one \\n only');
        assert.strictEqual(m._subNormalizeNewlines('x\r\ny'), 'x\ny');
        assert.strictEqual(m._subNormalizeNewlines('real\nand \\n literal \\n'), 'real\nand \\n literal \\n');
    });
    test('spawn fuse compares the sanitised name (a quoted variant cannot bypass it)', function() {
        for (var i = 0; i < 3; i++) m._subAgents['d' + i] = { agent_id: 'd' + i, name: 'Dup name', parent_chat_id: 'root', state: 'running' };
        var r = m.spawnSubAgent({ name: 'Dup "name"', instructions: 'x' }, { chatId: 'root' });
        assert.strictEqual(r.success, false, JSON.stringify(r));
        assert.ok(/SPAWN FUSE/.test(r.error) && r.error.indexOf('named "Dup name"') >= 0, r.error);
    });
    test('spawn stores the sanitised name on the record and the sub chat title', function() {
        var r = m.spawnSubAgent({ name: 'Fix "q" (v2)', instructions: 'do it' }, { chatId: 'root' });
        var id = Object.keys(m._subAgents).filter(function(k) { return m._subAgents[k].parent_chat_id === 'root'; })[0];
        assert.ok(id, 'record created: ' + JSON.stringify(r));
        var rec = m._subAgents[id];
        assert.strictEqual(rec.name, 'Fix q v2');
        assert.strictEqual(chats[rec.chat_id] && chats[rec.chat_id].title, 'Fix q v2');
    });
});
