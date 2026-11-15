// Lineage audit round: never fork a lineage (registerLineageLink refuses a
// different existing link; continued chats get "Go to the new chat"), and
// worker chats are never continued (page gate + SW migration gate).
var T = { tags: ['unit'], timeout: 8000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
var EX = await runFile('test/extract.js', { i18n: false });
function cutFns(src, names) {
    var mask = EX.codeMask(src);
    return names.map(function(n) {
        var f = EX.findFunction(src, n, { mask: mask });
        if (!(f && f.end > f.start)) throw new Error('function not found: ' + n);
        return src.slice(f.start, f.end);
    }).join('\n');
}
function load070(chats) {
    return loadModules(['src/js/core/070-permissions.js'], { lenient: true, globals: {
        self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: chats
    } });
}
function el() {
    var cls = {};
    return {
        style: {}, title: '', attrs: {}, hidden: true, textContent: '',
        setAttribute: function(k, v) { this.attrs[k] = String(v); },
        set className(v) { cls = {}; String(v).split(/\s+/).filter(Boolean).forEach(function(c) { cls[c] = 1; }); },
        get className() { return Object.keys(cls).join(' '); },
        classList: { add: function(c) { cls[c] = 1; }, contains: function(c) { return !!cls[c]; } }
    };
}

describe('lineage audit round', function() {
    test('F1 registerLineageLink: refuses to fork, idempotent on the same link', async function() {
        var chats = { A: {}, B: {}, C: {}, D: {} };
        var m = await load070(chats);
        assert.strictEqual(m.registerLineageLink('A', 'B', { stamp: true }), true);
        assert.strictEqual(m.registerLineageLink('A', 'B', { stamp: true }), true, 'same link again is fine');
        assert.strictEqual(m.registerLineageLink('A', 'C', { stamp: true }), false, 'A already continues into B');
        assert.strictEqual(m.resolveLineageHead('A'), 'B', 'in-memory link not overwritten');
        assert.strictEqual(chats.A.continuedTo, 'B');
        assert.strictEqual(m.registerLineageLink('D', 'B'), false, 'B already continues A');
        assert.strictEqual(chats.B.continuedFrom, 'A');
        // In-memory only link (no durable field) also blocks a fork.
        assert.strictEqual(m.registerLineageLink('C', 'D'), true);
        assert.strictEqual(m.registerLineageLink('C', 'A'), false);
        // A link to a tombstoned chat is dead: it may be replaced.
        chats.E = { continuedTo: 'F' }; chats.F = { _deleted: true }; chats.G = {};
        assert.strictEqual(m.registerLineageLink('E', 'G'), true);
    }, T);

    test('F1/F2 SW migration refuses a fork and a sub-agent chat before moving anything', async function() {
        var chats = { A: { messages: [], continuedTo: 'B' }, B: { messages: [], continuedFrom: 'A' }, C: { messages: [] },
            S: { messages: [], isSubAgent: true, parentChatId: 'A' }, N: { messages: [] } };
        var m = await load070(chats);
        var calls = [];
        var env = {
            chats: chats, registerLineageLink: m.registerLineageLink, console: quiet,
            SubAgents: { reparentChat: function(a, b) { calls.push('reparent:' + a + '>' + b); return {}; }, getByChatId: function() { return null; } },
            _swCopyLineageGrants: function(a, b) { calls.push('grants:' + a + '>' + b); return 0; }
        };
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var migrate = new Function('env', 'with (env) {' + cutFns(src, ['_swContinueChatLineage']) + '\nreturn _swContinueChatLineage; }')(env);
        var r1 = await migrate('A', 'C');
        assert.strictEqual(r1.ok, false);
        assert.strictEqual(r1.linked, false);
        assert.match(r1.errors.join(' '), /link refused/);
        var r2 = await migrate('S', 'N');
        assert.strictEqual(r2.ok, false);
        assert.match(r2.errors.join(' '), /sub-agent chat cannot be continued/);
        assert.strictEqual(chats.S.continuedTo, undefined, 'sub chat never linked');
        // Registry-only sub (page chat record missing the flags) is refused too.
        env.SubAgents.getByChatId = function(id) { return id === 'N' ? { agent_id: 'x' } : null; };
        chats.Q = { messages: [] };
        var r3 = await migrate('N', 'Q');
        assert.match(r3.errors.join(' '), /sub-agent chat cannot be continued/);
        assert.deepStrictEqual(calls, [], 'no reparent/grant moves on a refused migration');
        assert.strictEqual(chats.C.continuedFrom, undefined);
    }, T);

    test('F1/F2 page gate: continueChatBlockReason + summarizeAndStartNewChat + completeSummaryAndCreateNewChat', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var snacks = [], selected = [];
        var env = {
            chats: {
                A: { continuedTo: 'B', messages: [1, 2, 3] }, B: { continuedFrom: 'A', messages: [1, 2, 3] },
                S: { isSubAgent: true, parentChatId: 'B', messages: [1, 2, 3] }, P: { parentChatId: 'B', messages: [1, 2, 3] }
            },
            currentChatId: 'A', pendingSummaryRequest: null,
            t: function(s) { return s; }, showSnackbar: function(s) { snacks.push(s); }, selectChat: function(id) { selected.push(id); },
            resolveLineageHead: function() { return 'B'; }, runningChatIds: {}, isRunning: false,
            runAgent: function() { throw new Error('must not run'); }
        };
        var f = new Function('env', 'with (env) {' + cutFns(src, ['continueChatBlockReason', 'summarizeAndStartNewChat', 'completeSummaryAndCreateNewChat'])
            + '\nreturn { block: continueChatBlockReason, sum: summarizeAndStartNewChat, done: completeSummaryAndCreateNewChat }; }')(env);
        assert.strictEqual(f.block(env.chats.A), 'continued');
        assert.strictEqual(f.block(env.chats.B), null);
        assert.strictEqual(f.block(env.chats.S), 'subagent');
        assert.strictEqual(f.block(env.chats.P), 'subagent', 'parentChatId alone is enough');
        assert.strictEqual(f.block(null), null);
        await f.sum();
        assert.deepStrictEqual(selected, ['B'], 'continued chat: jump to the head, no new summary');
        assert.strictEqual(env.chats.A.messages.length, 3, 'no summary prompt pushed');
        env.currentChatId = 'S';
        await f.sum();
        assert.match(snacks.pop(), /Sub-agent chats/);
        assert.strictEqual(env.chats.S.messages.length, 3);
        assert.strictEqual(env.pendingSummaryRequest, null);
        // A summary that finished after the chat got continued never forks.
        env.pendingSummaryRequest = { chatId: 'A', chatTitle: 'x' };
        snacks.length = 0;
        await f.done();
        assert.strictEqual(env.pendingSummaryRequest, null);
        assert.deepStrictEqual(Object.keys(env.chats).sort(), ['A', 'B', 'P', 'S'], 'no new chat created');
        assert.deepStrictEqual(snacks, ['This chat was already continued in a new chat'], 'M3: late abort is not silent');
        env.pendingSummaryRequest = { chatId: 'S', chatTitle: 'x' };
        await f.done();
        assert.match(snacks.pop(), /Sub-agent chats/);
        assert.strictEqual(env.pendingSummaryRequest, null);
    }, T);

    test('M1 a dead or missing successor never blocks Continue; registerLineageLink replaces it', async function() {
        var chats = { A: { continuedTo: 'GONE', messages: [] }, B: {}, C: { continuedTo: 'T', messages: [] }, T: { _deleted: true }, N: {}, N2: {} };
        var m = await load070(chats);
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var env = { chats: chats, currentChatId: 'A', _lineageNextOf: m._lineageNextOf };
        var block = new Function('env', 'with (env) {' + cutFns(src, ['continueChatBlockReason']) + '\nreturn continueChatBlockReason; }')(env);
        assert.strictEqual(block(chats.A), null, 'successor missing from the page map: not blocked (id from currentChatId)');
        assert.strictEqual(block(chats.C, 'C'), null, 'tombstoned successor: not blocked');
        assert.strictEqual(block(chats.A, 'A'), null);
        // SW semantics kept: a missing link still counts without missingIsDead.
        assert.strictEqual(m.registerLineageLink('A', 'B', { stamp: true }), false, 'SW: missing chat may be lagging, refuse');
        assert.strictEqual(chats.A.continuedTo, 'GONE');
        // Page: missing counts as dead — replaced, durable field re-stamped.
        assert.strictEqual(m.registerLineageLink('A', 'B', { stamp: true, missingIsDead: true }), true);
        assert.strictEqual(chats.A.continuedTo, 'B');
        assert.strictEqual(chats.B.continuedFrom, 'A');
        assert.strictEqual(m.resolveLineageHead('A'), 'B');
        assert.strictEqual(block(chats.A, 'A'), 'continued', 'live successor blocks again');
        // Tombstoned durable field is overwritten by the stamp.
        assert.strictEqual(m.registerLineageLink('C', 'N', { stamp: true }), true);
        assert.strictEqual(chats.C.continuedTo, 'N');
        // A live link is still never forked, even with missingIsDead.
        assert.strictEqual(m.registerLineageLink('C', 'N2', { stamp: true, missingIsDead: true }), false);
        assert.strictEqual(chats.C.continuedTo, 'N');
        // Missing predecessor of `to` (in-memory only) is replaceable on the page.
        assert.strictEqual(m.registerLineageLink('X1', 'N2'), true);
        assert.strictEqual(m.registerLineageLink('B', 'N2', { missingIsDead: true }), true, 'X1 is not in the map');
    }, T);

    test('M2 a refused SW migration clears lineageMigrationPending (no endless retry)', async function() {
        var src = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        var posted = [];
        var env = {
            chats: { A: { lineageMigrationPending: 'B' }, B: { continuedFrom: 'A' }, C: { lineageMigrationPending: 'D' }, D: {} },
            _agentBusPort: { postMessage: function(m) { posted.push(m); } },
            setTimeout: function() { return 0; }, clearTimeout: function() {}, console: quiet
        };
        var names = ['_setLineageMigrationPending', '_clearLineageMigrationPending', '_lineageMigrationSettled', '_lineageMigrationRefused', 'retryPendingLineageMigrations', '_lineageMigrateFallback', 'migrateChatLineageOnSW', '_resolveLineageMigrated'];
        var f = new Function('env', 'with (env) { var _lineageMigratePending = {}; var LINEAGE_MIGRATE_TIMEOUT_MS = 8000; var _lineageRetryInFlight = {};\n' + cutFns(src, names)
            + '\nreturn { retry: retryPendingLineageMigrations, reply: _resolveLineageMigrated }; }')(env);
        var ps = f.retry();
        assert.strictEqual(posted.length, 2);
        f.reply({ requestId: posted[0].requestId, result: { ok: false, errors: ['link refused: A already continues into Z'] } });
        f.reply({ requestId: posted[1].requestId, result: { ok: false, errors: ['split view: transient'] } });
        await Promise.all(ps);
        assert.ok(!env.chats.A.lineageMigrationPending, 'refused: marker cleared');
        assert.strictEqual(env.chats.C.lineageMigrationPending, 'D', 'other failure: still retried later');
        env.chats.C.isSubAgent = true;
        var ps2 = f.retry();
        assert.strictEqual(posted.length, 3, 'only C is replayed');
        f.reply({ requestId: posted[2].requestId, result: { ok: false, errors: ['sub-agent chat cannot be continued'] } });
        await Promise.all(ps2);
        assert.ok(!env.chats.C.lineageMigrationPending);
        assert.strictEqual(f.retry().length, 0, 'nothing left to replay');
    }, T);

    test('F1/F2 pill: "Go to the new chat" on a continued chat, ring only on a worker chat', async function() {
        var i18n = await loadFile('src/js/core/025-i18n.js');
        var src240 = await loadFile('src/js/ui/240-layout.js');
        var src170 = await loadFile('src/js/ui/170-chat-management.js');
        var th = /\nvar CONTEXT_CONTINUE_THRESHOLD = \d+;/.exec(src240)[0];
        function run(chat) {
            var els = { 'context-indicator': el(), 'context-fill': el(), 'context-label': el(), 'context-pct': el(), 'context-label-short': el(), 'message-input': { value: '' } };
            chat.messages = [{ role: 'assistant', content: 'x', metrics: { input_tokens: 150000 } }];
            var env = {
                document: { getElementById: function(id) { return els[id] || null; } },
                chats: { c1: chat, B: {} }, currentChatId: 'c1',
                getAssumedContextTokens: function() { return 200000; }, composerDraftTokens: function() { return 0; }
            };
            new Function('env', 'with (env) {\n' + i18n + '\n' + th + '\n' + cutFns(src170, ['continueChatBlockReason']) + '\n' + cutFns(src240, ['updateContextIndicator']) + '\nreturn updateContextIndicator;\n}')(env)();
            return els;
        }
        var plain = run({});
        assert.strictEqual(plain['context-label'].textContent, 'Continue in a new chat');
        var cont = run({ continuedTo: 'B' });
        assert.ok(cont['context-indicator'].classList.contains('continue-cta'));
        assert.strictEqual(cont['context-label'].textContent, 'Go to the new chat');
        assert.strictEqual(cont['context-indicator'].attrs['aria-label'], 'Go to the new chat');
        var gone = run({ continuedTo: 'GONE' });
        assert.strictEqual(gone['context-label'].textContent, 'Continue in a new chat', 'dangling link: Continue offered again');
        var sub = run({ isSubAgent: true, parentChatId: 'P' });
        assert.strictEqual(sub['context-indicator'].classList.contains('continue-cta'), false, 'worker chat: ring only');
        assert.strictEqual(sub['context-label'].hidden, true);
    }, T);

    // F3-F5 share one env: A continued into B; workers re-rooted onto B, one
    // of them nested under another sub's chat.
    async function stripEnv(regList) {
        var subRep = function(id, status) { return { role: 'sub_report', subAgentId: id, subAgentName: id, subChatId: 'chat_sub_' + id, report: { status: status, at: 1 } }; };
        var chats = {
            A: { continuedTo: 'B', messages: [subRep('g_run', 'running'), subRep('g_wait', 'need_input'), subRep('g_err', 'error'), subRep('g_done', 'done')] },
            B: { continuedFrom: 'A', messages: [] },
            X: { messages: [] }
        };
        var m = await load070(chats);
        var reg = {};
        (regList || []).forEach(function(r) { reg[r.agent_id] = r; });
        var env = {
            chats: chats, getLineageChatIds: m.getLineageChatIds, currentChatId: 'A',
            SubAgents: { listAll: function() { return Object.keys(reg).map(function(k) { return reg[k]; }); }, getById: function(id) { return reg[id] || null; } },
            _reconstructedSubs: Object.create(null),
            _subUiIsSkeleton: function() { return false; },
            _subIsQueued: function() { return false; }, _subIsPaused: function() { return false; }
        };
        var src = await loadFile('src/js/ui/175-sub-agent-ui.js');
        var names = ['_subLineageSet', '_reportStatusToWorkerState', '_reconstructSubsFromMessages', '_reconstructSubsFromChat',
            '_mergeReconstructedSubs', '_dedupeWorkersById', 'subAgentsForChatTree', '_chipKey'];
        var f = new Function('env', 'with (env) {' + cutFns(src, names) + '\nreturn { lin: _subLineageSet, tree: subAgentsForChatTree, merge: _mergeReconstructedSubs, key: _chipKey }; }')(env);
        return { env: env, f: f, reg: reg };
    }
    var W1 = function() { return { agent_id: 'w1', chat_id: 'chat_sub_w1', parent_chat_id: 'B', root_chat_id: 'B', state: 'sleeping' }; };
    var N1 = function() { return { agent_id: 'n1', chat_id: 'chat_sub_n1', parent_chat_id: 'chat_sub_w1', parent_agent_id: 'w1', root_chat_id: 'B', state: 'running', depth: 2 }; };

    test('F3 old chat lists the same lineage-wide workers (incl. a re-rooted nested worker)', async function() {
        var s = await stripEnv([W1(), N1(), { agent_id: 'x1', parent_chat_id: 'X', root_chat_id: 'X', state: 'running' }]);
        assert.deepStrictEqual(Object.keys(s.f.lin('A')).sort(), ['A', 'B'], 'old chat: whole lineage');
        assert.deepStrictEqual(Object.keys(s.f.lin('B')).sort(), ['A', 'B']);
        var live = function(id) { return s.f.tree(id).filter(function(r) { return !r._reconstructed; }).map(function(r) { return r.agent_id; }).sort(); };
        assert.deepStrictEqual(live('A'), ['n1', 'w1'], 'nested worker (parent = a sub chat, root = new chat) kept on the old chat');
        assert.deepStrictEqual(live('A'), live('B'), 'old and new chat show the same workers');
        assert.ok(live('X').indexOf('n1') < 0, 'unrelated chat unaffected');
    }, T);

    test('F4 rebuilt (GC\'d, transcript-only) workers render as ended, never sleeping/running', async function() {
        var s = await stripEnv([]);
        var list = s.f.merge([], 'A');
        var st = {};
        list.forEach(function(r) { st[r.agent_id] = r.state; assert.ok(r._reconstructed); });
        assert.deepStrictEqual(st, { g_run: 'stopped', g_wait: 'stopped', g_err: 'errored', g_done: 'stopped' });
        // A worker still in the registry keeps its live state.
        var s2 = await stripEnv([{ agent_id: 'g_wait', chat_id: 'chat_sub_g_wait', parent_chat_id: 'B', root_chat_id: 'B', state: 'sleeping' }]);
        var l2 = s2.f.merge([], 'A');
        assert.strictEqual(l2.filter(function(r) { return r.agent_id === 'g_wait'; })[0].state, 'sleeping', 'live record wins');
        // Registry not hydrated yet: a missing record proves nothing — keep the report state.
        var s3 = await stripEnv([]);
        s3.env.SubAgents.isLoaded = function() { return false; };
        var st3 = {};
        s3.f.merge([], 'A').forEach(function(r) { st3[r.agent_id] = r.state; });
        assert.notStrictEqual(st3.g_run, 'stopped', 'not forced to stopped before load');
        assert.strictEqual(st3.g_err, 'errored');
    }, T);

    test('F5 _chipKey uses the lineage set: a re-rooted worker\'s state change repaints the old chat', async function() {
        var s = await stripEnv([W1(), N1()]);
        var k1 = s.f.key();
        assert.match(k1, /n1:running/);
        assert.match(k1, /w1:sleeping/);
        s.reg.n1.state = 'stopped';
        var k2 = s.f.key();
        assert.notStrictEqual(k1, k2, 'state change on a nested re-rooted worker changes the key');
        s.env.currentChatId = 'X';
        assert.strictEqual(s.f.key(), 'X|', 'unrelated chat key excludes the lineage workers');
    }, T);
});
