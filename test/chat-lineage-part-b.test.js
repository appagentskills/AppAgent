// Lineage fix part B: migration replay to the current head (whole-lineage
// walk, chain-accepting SW migration), marker cleared/rewritten on unlink,
// persisted marker clear (m2) incl. late replies, grant carry on delete (m1),
// injection forward on delete (m3).
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
function load070(chats, extra) {
    return loadModules(['src/js/core/070-permissions.js'], { lenient: true, globals: Object.assign({
        self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: chats
    }, extra || {}) });
}
var PAGE_FNS = ['_setLineageMigrationPending', '_clearLineageMigrationPending', '_lineageMigrationSettled', '_lineageMigrationRefused',
    'retryPendingLineageMigrations', 'registerLineageLinkOnSW', '_lineageMigrateFallback', 'migrateChatLineageOnSW', '_resolveLineageMigrated'];
async function loadPage(env) {
    var src = await loadFile('src/js/app/045-agent-port-bridge-page.js');
    return new Function('env', 'with (env) { var _lineageMigratePending = {}; var LINEAGE_MIGRATE_TIMEOUT_MS = 8000; var _lineageRetryInFlight = {};\n'
        + cutFns(src, PAGE_FNS) + '\nreturn { retry: retryPendingLineageMigrations, reply: _resolveLineageMigrated, migrate: migrateChatLineageOnSW }; }')(env);
}

describe('lineage part B', function() {
    test('M1 replay targets the current head and walks the whole lineage', async function() {
        var chats = { A: { continuedTo: 'B', lineageMigrationPending: 'B' }, B: { continuedFrom: 'A', continuedTo: 'C' }, C: { continuedFrom: 'B' } };
        var m = await load070(chats);
        var posted = [], saves = 0;
        var env = { chats: chats, _agentBusPort: { postMessage: function(x) { posted.push(x); } },
            resolveLineageHead: m.resolveLineageHead, getLineageChatIds: m.getLineageChatIds,
            saveChatsToStorage: function() { saves++; }, _pushChatSkeletonToSW: function() {},
            setTimeout: function() { return 0; }, clearTimeout: function() {}, console: quiet };
        var p = await loadPage(env);
        var ps = p.retry('C'); // selecting the head replays A (two hops back)
        assert.strictEqual(ps.length, 1);
        var mig = posted.filter(function(x) { return x.type === 'continueChatLineage'; });
        assert.deepStrictEqual([mig[0].from, mig[0].to], ['A', 'C'], 'replayed to the head, not the stale target');
        var links = posted.filter(function(x) { return x.type === 'registerLineageLink'; }).map(function(x) { return x.from + '>' + x.to; });
        assert.deepStrictEqual(links, ['A>B', 'B>C'], 'adjacent links re-taught before the migration');
        p.reply({ requestId: mig[0].requestId, result: { ok: true } });
        await Promise.all(ps);
        assert.strictEqual(chats.A.lineageMigrationPending, null);
        assert.ok(saves >= 1, 'm2: the clear is persisted');
    }, T);

    test('M1 a marker whose successor is gone is cleared without a replay', async function() {
        var chats = { A: { lineageMigrationPending: 'B' } };
        var m = await load070(chats);
        var posted = [];
        var env = { chats: chats, _agentBusPort: { postMessage: function(x) { posted.push(x); } },
            resolveLineageHead: m.resolveLineageHead, getLineageChatIds: m.getLineageChatIds,
            saveChatsToStorage: function() {}, _pushChatSkeletonToSW: function() {},
            setTimeout: function() { return 0; }, clearTimeout: function() {}, console: quiet };
        var p = await loadPage(env);
        assert.strictEqual(p.retry().length, 0);
        assert.strictEqual(posted.length, 0);
        assert.strictEqual(chats.A.lineageMigrationPending, null);
    }, T);

    test('M1 unlinkLineageChat rewrites or clears the replay marker', async function() {
        var chats = { A: { continuedTo: 'B', lineageMigrationPending: 'B' }, B: { continuedFrom: 'A', continuedTo: 'C', lineageMigrationPending: 'C' }, C: { continuedFrom: 'B' } };
        var m = await load070(chats);
        var r = m.unlinkLineageChat('B');
        assert.strictEqual(chats.A.lineageMigrationPending, 'C', 'rewritten to the joined successor');
        assert.strictEqual(chats.B.lineageMigrationPending, null, 'deleted chat\'s own marker cleared');
        assert.ok(r.touched.indexOf('A') >= 0);
        delete chats.B;
        m.unlinkLineageChat('C');
        assert.strictEqual(chats.A.lineageMigrationPending, null, 'head deleted: nothing to migrate to');
    }, T);

    test('M1 SW migration accepts (from, head) over an existing chain, still refuses a fork', async function() {
        var chats = { A: { messages: [], continuedTo: 'B' }, B: { messages: [], continuedFrom: 'A', continuedTo: 'C' }, C: { messages: [], continuedFrom: 'B' }, X: { messages: [] } };
        var m = await load070(chats);
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var env = { chats: chats, registerLineageLink: m.registerLineageLink, resolveLineageHead: m.resolveLineageHead, console: quiet,
            SubAgents: { reparentChat: function() { return {}; }, getByChatId: function() { return null; } },
            _swCopyLineageGrants: function() { return 0; } };
        var run = new Function('env', 'with (env) {\n' + cutFns(src, ['_swContinueChatLineage']) + '\nreturn _swContinueChatLineage; }')(env);
        var ok = await run('A', 'C');
        assert.strictEqual(ok.linked, 'chain');
        assert.deepStrictEqual(ok.errors, []);
        var fork = await run('A', 'X');
        assert.ok(/link refused/.test(fork.errors.join(' ')));
    }, T);

    test('m2/save timing: a late SW reply clears + persists the marker', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' } };
        var saves = 0, timers = [];
        var env = { chats: chats, _agentBusPort: { postMessage: function() {} },
            saveChatsToStorage: function() { saves++; }, _pushChatSkeletonToSW: function() {},
            registerLineageLink: function() { return true; },
            setTimeout: function(fn) { timers.push(fn); return timers.length; }, clearTimeout: function() {}, console: quiet };
        var p = await loadPage(env);
        var pr = p.migrate('A', 'B');
        assert.strictEqual(chats.A.lineageMigrationPending, 'B', 'marker set before the request');
        timers[0]();
        var r = await pr;
        assert.strictEqual(r.reason, 'timeout');
        p.reply({ requestId: 'gone', from: 'A', to: 'B', result: { ok: true } });
        assert.strictEqual(chats.A.lineageMigrationPending, null, 'late success clears');
        assert.ok(saves >= 1);
    }, T);

    test('m1 _pruneChatPermissionGrants carries grants to the surviving head first', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var posted = [];
        var env = { sessionPermissions: { 'B::tool_x': 'allow', 'C::tool_y': 'allow', 'B::tool_y': 'allow' },
            _agentBusPort: { postMessage: function(x) { posted.push(x); } } };
        var prune = new Function('env', 'with (env) {\n' + cutFns(src, ['_pruneChatPermissionGrants']) + '\nreturn _pruneChatPermissionGrants; }')(env);
        assert.strictEqual(prune('B', 'C'), 2);
        assert.deepStrictEqual(env.sessionPermissions, { 'C::tool_y': 'allow', 'C::tool_x': 'allow' });
        assert.deepStrictEqual(posted[0].sessionPermissionsDelta.set, { 'C::tool_x': 'allow' }, 'never overwrites a head grant');
        assert.deepStrictEqual(posted[0].sessionPermissionsDelta.del.sort(), ['B::tool_x', 'B::tool_y']);
    }, T);

    test('m3 forwardLineageInjection with an explicit target (delete paths)', async function() {
        var inj = { B: { text: 'report from w1' }, C: { text: 'head note' } };
        var m = await load070({ B: {}, C: {} }, { pendingInjectionsByChatId: inj });
        assert.strictEqual(m.forwardLineageInjection('B', 'C'), 'C');
        assert.strictEqual(inj.C.text, 'head note\n\nreport from w1');
        assert.strictEqual(inj.B, undefined);
    }, T);
});
