// "Continue in a new chat": code-generated <handover_live> block
// (ui/170-chat-management.js buildHandoffLiveBlock) — the lineage's PRs with
// live GitHub state (cached fallback) + the old chat's last final answer.
// Real function texts cut from source, run against a stubbed env.
// Run: run_tests { files: ['test/handover-live-block.test.js'] }
var EX = await runFile('test/extract.js', { i18n: false });
var HLB_FNS = ['_handoffMsgText', 'getHandoffLastAnswer', '_handoffPrCachedState', 'collectHandoffPRs',
    'fetchHandoffPRStates', 'formatHandoffLiveBlock', 'buildHandoffLiveBlock'];
async function hlb(env) {
    var src = await loadFile('src/js/ui/170-chat-management.js');
    var mask = EX.codeMask(src);
    var consts = ['HANDOFF_LIVE_PR_TIMEOUT_MS', 'HANDOFF_LAST_ANSWER_MAX', 'HANDOFF_LIVE_PR_MAX', 'HANDOFF_LIVE_OVERALL_TIMEOUT_MS'].map(function(n) {
        var m = new RegExp('\\nvar ' + n + ' = \\d+;').exec(src);
        if (!m) throw new Error('missing ' + n);
        return m[0];
    }).join('\n');
    var code = HLB_FNS.map(function(n) {
        var f = EX.findFunction(src, n, { mask: mask });
        if (!(f && f.end > f.start)) throw new Error('function not found: ' + n);
        return src.slice(f.start, f.end);
    }).join('\n');
    env = env || {};
    if (!env.console) env.console = { warn: function() {} };
    return new Function('env', 'with (env) {\n' + consts + '\n' + code + '\nreturn { getHandoffLastAnswer: getHandoffLastAnswer, formatHandoffLiveBlock: formatHandoffLiveBlock, buildHandoffLiveBlock: buildHandoffLiveBlock };\n}')(env || {});
}
function hlbEnv(metas, githubApi) {
    return {
        getLineageChatIds: function(id) { return ['A0', id]; },
        _wsRootChatId: function(id) { return id === 'SUB1' ? 'OLD' : null; },
        getAllWorkspaceMetas: function() { return Promise.resolve(metas); },
        getPushedPRsForLineage: function() { return []; },
        githubApi: githubApi
    };
}
var META = [{ repo: 'o/r', prs: [
    { url: 'https://github.com/o/r/pull/12', number: 12, title: 'Fix A', chatId: 'OLD', state: '' },
    { url: 'https://github.com/o/r/pull/13', number: 13, title: 'Worker PR', chatId: 'SUB1', state: 'merged', merged_at: '2026-11-01T00:00:00Z' },
    { url: 'https://github.com/o/r/pull/99', number: 99, title: 'Other chat', chatId: 'ELSE' }
] }];

describe('handover live block', function() {
    test('PRs of the lineage listed with LIVE state from GitHub', async function() {
        var calls = [];
        var f = await hlb(hlbEnv(META, function(m, path) {
            calls.push(path);
            var n = path.split('/').pop();
            return Promise.resolve({ ok: true, body: n === '12' ? { state: 'closed', merged: true, merged_at: 'x' } : { state: 'closed', merged: false } });
        }));
        var out = await f.buildHandoffLiveBlock('OLD', [], 500);
        assert.deepStrictEqual(calls.sort(), ['/repos/o/r/pulls/12', '/repos/o/r/pulls/13']);
        assert.match(out, /^<handover_live>\n[\s\S]*\n<\/handover_live>$/);
        assert.ok(out.indexOf('- #12 "Fix A" \u2014 https://github.com/o/r/pull/12 \u2014 merged\n') > 0, out);
        assert.ok(out.indexOf('- #13 "Worker PR" \u2014 https://github.com/o/r/pull/13 \u2014 closed') > 0, 'worker PR via root chat; live overrides cached');
        assert.strictEqual(out.indexOf('#99'), -1, 'other chats\' PRs excluded');
        assert.strictEqual(out.indexOf('(cached)'), -1);
        assert.strictEqual(/sha|dirty/i.test(out), false, 'no SHAs / dirty files');
    });

    test('fetch failure or timeout falls back to the cached state', async function() {
        var f = await hlb(hlbEnv(META, function(m, path) {
            if (path.slice(-2) === '12') return Promise.reject(new Error('net'));
            return new Promise(function() {}); // hangs past the deadline
        }));
        var t0 = Date.now();
        var out = await f.buildHandoffLiveBlock('OLD', [], 150);
        assert.ok(Date.now() - t0 < 2000, 'bounded by the deadline');
        assert.ok(out.indexOf('#12 "Fix A" \u2014 https://github.com/o/r/pull/12 \u2014 open (cached)') > 0, out);
        assert.ok(out.indexOf('#13 "Worker PR" \u2014 https://github.com/o/r/pull/13 \u2014 merged (cached)') > 0, out);
        var f2 = await hlb(hlbEnv(META, function() { return Promise.resolve({ error: 'No GitHub token configured' }); }));
        assert.match(await f2.buildHandoffLiveBlock('OLD', [], 150), /pull\/12 \u2014 open \(cached\)/);
    });

    test('last final answer verbatim; hook / summary rows skipped; truncation marker', async function() {
        var f = await hlb({});
        var ms = [
            { role: 'user', content: 'do X' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'c' }] },
            { role: 'tool', content: '{}' },
            { role: 'assistant', content: 'Done: **X** shipped.\n  - line 2' },
            { role: 'user', content: 'hook check', isHookMessage: true },
            { role: 'assistant', content: 'HOOK REPLY' },
            { role: 'user', content: 'summarize', isSummaryRequest: true },
            { role: 'assistant', content: '<summary>S</summary>' }
        ];
        var la = f.getHandoffLastAnswer(ms);
        assert.deepStrictEqual(la, { index: 3, text: 'Done: **X** shipped.\n  - line 2' });
        var out = f.formatHandoffLiveBlock([], la, 'OLD');
        assert.ok(out.indexOf('<last_answer>\nDone: **X** shipped.\n  - line 2\n</last_answer>') > 0, 'verbatim');
        assert.strictEqual(out.indexOf('PRs this chat'), -1, 'PR section omitted when empty');
        var long = 'y'.repeat(4100);
        var t = f.formatHandoffLiveBlock([], { index: 7, text: long }, 'OLD');
        assert.ok(t.indexOf('y'.repeat(4000) + '\n\u2026[truncated \u2014 4100 chars total; full text: chat_history get {chat_id: "OLD", path: "messages[7].content"}]') > 0);
        assert.strictEqual(t.indexOf('y'.repeat(4001)), -1, 'capped at 4000');
        var arr = f.getHandoffLastAnswer([{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'part A' }] }]);
        assert.strictEqual(arr.text, 'part A', 'array content, no summary request');
    });

    test('hung collect step (meta read) still resolves within the overall deadline', async function() {
        var env = hlbEnv(META, function() { throw new Error('not reached'); });
        env.getAllWorkspaceMetas = function() { return new Promise(function() {}); }; // IDB hang
        var f = await hlb(env);
        var ms = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'ANSWER' }, { role: 'user', content: 's', isSummaryRequest: true }];
        var t0 = Date.now();
        var out = await f.buildHandoffLiveBlock('OLD', ms, 100, 200);
        assert.ok(Date.now() - t0 < 2000, 'bounded by the overall deadline');
        assert.strictEqual(out, '<handover_live>\nLast final answer shown to the user in the previous chat (messages[1], verbatim):\n<last_answer>\nANSWER\n</last_answer>\n</handover_live>', 'last-answer section alone');
        assert.strictEqual(await f.buildHandoffLiveBlock('OLD', [], 100, 150), '', 'no answer → empty');
    });

    test('sections omitted when empty; whole block empty', async function() {
        var f = await hlb(hlbEnv([], function() { throw new Error('should not be called'); }));
        assert.strictEqual(await f.buildHandoffLiveBlock('OLD', [{ role: 'user', content: 'hi' }, { role: 'user', content: 's', isSummaryRequest: true }], 100), '');
        assert.strictEqual(f.formatHandoffLiveBlock([], null, 'OLD'), '');
        var onlyPr = f.formatHandoffLiveBlock([{ number: 5, title: 'T', url: 'u', state: 'open', cached: false }], null, 'OLD');
        assert.strictEqual(onlyPr, '<handover_live>\nPRs this chat opened or pushed (state fetched from GitHub at handoff):\n- #5 "T" \u2014 u \u2014 open\n</handover_live>');
        assert.strictEqual(onlyPr.indexOf('last_answer'), -1);
    });
});
