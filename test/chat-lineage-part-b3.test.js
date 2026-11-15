// Lineage fix part B (3): migration single-flight (race), versionHistory cap
// = VERSION_HISTORY_CAP, action reopen only for THIS continue, lineage
// fallback on read for cachedToolResults / displays, progress history.
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
        self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: chats } });
}
var PAGE_FNS = ['_setLineageMigrationPending', '_clearLineageMigrationPending', '_lineageMigrationSettled', '_lineageMigrationRefused',
    'reserveLineageMigration', 'releaseLineageMigrationReservation', 'retryPendingLineageMigrations', 'registerLineageLinkOnSW',
    '_lineageMigrateFallback', 'migrateChatLineageOnSW', '_resolveLineageMigrated'];
async function loadPage(env) {
    var src = await loadFile('src/js/app/045-agent-port-bridge-page.js');
    return new Function('env', 'with (env) { var _lineageMigratePending = {}; var LINEAGE_MIGRATE_TIMEOUT_MS = 8000; var _lineageRetryInFlight = {};\n'
        + cutFns(src, PAGE_FNS) + '\nreturn { retry: retryPendingLineageMigrations, reply: _resolveLineageMigrated, migrate: migrateChatLineageOnSW,'
        + ' reserve: reserveLineageMigration, release: releaseLineageMigrationReservation, inflight: _lineageRetryInFlight }; }')(env);
}
async function loadCopy(env) {
    var src = await loadFile('src/js/ui/170-chat-management.js');
    return new Function('env', 'with (env) {\n' + cutFns(src, ['copyLineagePageState']) + '\nreturn copyLineagePageState; }')(env);
}

describe('lineage part B3', function() {
    test('item 1: a reserved continue blocks replays; concurrent migrations are single-flight', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' } };
        var m = await load070(chats);
        var posted = [];
        var env = { chats: chats, _agentBusPort: { postMessage: function(x) { posted.push(x); } },
            resolveLineageHead: m.resolveLineageHead, getLineageChatIds: m.getLineageChatIds,
            saveChatsToStorage: function() {}, _pushChatSkeletonToSW: function() {},
            setTimeout: function() { return 0; }, clearTimeout: function() {}, console: quiet };
        var p = await loadPage(env);
        // Continue flow: reserve, then set the marker, then await the handover build.
        p.reserve('A');
        chats.A.lineageMigrationPending = 'B';
        assert.strictEqual(p.retry('B').length, 0, 'selectChat replay skipped while reserved');
        assert.strictEqual(p.retry().length, 0, 'hello replay skipped while reserved');
        var mig = function() { return posted.filter(function(x) { return x.type === 'continueChatLineage'; }); };
        assert.strictEqual(mig().length, 0, 'no early migration');
        var m1 = p.migrate('A', 'B');
        var m2 = p.migrate('A', 'B');
        assert.strictEqual(m1, m2, 'same pair joins the in-flight call');
        assert.strictEqual(mig().length, 1, 'posted once');
        assert.strictEqual(p.retry().length, 0, 'replay skipped while in flight');
        p.reply({ requestId: mig()[0].requestId, result: { ok: true } });
        await m1; await Promise.resolve();
        assert.strictEqual(p.inflight.A, undefined, 'in-flight entry cleared on settle');
        assert.strictEqual(chats.A.lineageMigrationPending, null);
        p.release('A'); // no-op after the migration took it over
        chats.A.lineageMigrationPending = 'B';
        assert.strictEqual(p.retry().length, 1, 'replays run again once settled');
    }, T);

    test('item 1: release frees a reservation the migration never claimed', async function() {
        var p = await loadPage({ chats: {}, _agentBusPort: null, console: quiet });
        p.reserve('A');
        assert.strictEqual(p.inflight.A, true);
        p.release('A');
        assert.strictEqual(p.inflight.A, undefined);
    }, T);

    test('item 3: versionHistory copy cap is VERSION_HISTORY_CAP', async function() {
        var vh = [];
        for (var i = 0; i < 300; i++) vh.push({ id: 'v' + i });
        var env = { chats: { O: { versionHistory: vh }, N: {} }, persistActionState: function() {} };
        (await loadCopy(env))('O', 'N');
        assert.strictEqual(env.chats.N.versionHistory.length, 200, 'defaults to 200 (core/030)');
        var env2 = { chats: { O: { versionHistory: vh }, N: {} }, VERSION_HISTORY_CAP: 7, persistActionState: function() {} };
        (await loadCopy(env2))('O', 'N');
        assert.strictEqual(env2.chats.N.versionHistory.length, 7);
        assert.strictEqual(env2.chats.N.versionHistory[6].id, 'v299');
    }, T);

    test('item 4: an action auto-finalized before this continue stays done', async function() {
        var env = { chats: { O: {}, N: {} }, persistActionState: function() {}, notifyActionStateChanged: function() {},
            activeActions: { a1: { chatId: 'O', state: 'done', updatedAt: 5, _autoFinalizedAt: 5 } } };
        var copy = await loadCopy(env);
        copy('O', 'N', { since: 10 });
        assert.strictEqual(env.activeActions.a1.state, 'done', 'finished before the summary: not reopened');
        assert.strictEqual(env.activeActions.a1.chatId, 'N', 'still moved');
        env.activeActions.a1 = { chatId: 'N', state: 'done', updatedAt: 12, _autoFinalizedAt: 12 };
        env.chats.M = {};
        copy('N', 'M');
        assert.strictEqual(env.activeActions.a1.state, 'done', 'no since: never reopened');
    }, T);

    test('item 2: cached_content_read on the head falls back to the predecessor holding the id', async function() {
        var chats = { A: { continuedTo: 'B', cachedToolResults: { old1: { fullContent: { x: 'OLDVALUE' } } } },
            B: { continuedFrom: 'A', cachedToolResults: { new1: { fullContent: { y: 1 } } } } };
        var m70 = await load070(chats);
        var M = await loadModules(['src/js/core/100-cached-results.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        M.__scope.cacheTokenLimit = 4000;
        M.__scope.ensureCachedContent = async function() {};
        M.__scope.chats = chats;
        M.__scope.findLineageChatWithEntry = m70.findLineageChatWithEntry;
        assert.strictEqual(m70.findLineageChatWithEntry('B', 'cachedToolResults', 'old1'), 'A');
        assert.strictEqual(m70.findLineageChatWithEntry('B', 'cachedToolResults', 'new1'), 'B');
        assert.strictEqual(m70.findLineageChatWithEntry('B', 'cachedToolResults', 'nope'), null);
        var r = await M.executeCachedContentRead('B', { content_id: 'old1', path: 'x' });
        assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 300));
        assert.match(JSON.stringify(r), /OLDVALUE/);
        var s = await M.executeCachedContentSearch('B', { content_id: 'old1', query: 'OLDVALUE' });
        assert.ok(s && s.success !== false, JSON.stringify(s).slice(0, 300));
    }, T);

    test('item 5: sdocCopyDisplays embeds a display only a predecessor still holds', async function() {
        var chats = { A: { continuedTo: 'B', displays: { dsp_old: { template: 't1', args: { a: 1 } } } },
            B: { continuedFrom: 'A', displays: { dsp_new: { template: 't2', args: {} } } } };
        var m70 = await load070(chats);
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        var env = { chats: chats, findLineageChatWithEntry: m70.findLineageChatWithEntry, _sdocChatId: function() { return 'B'; } };
        var copy = new Function('env', 'with (env) {\n' + cutFns(src, ['sdocCopyDisplays']) + '\nreturn sdocCopyDisplays; }')(env);
        var doc = { displays: {} };
        copy(doc, 'x <!--display:dsp_old--> y <!--display:dsp_new-->', {});
        assert.deepStrictEqual(doc.displays.dsp_old, { template: 't1', args: { a: 1 } });
        assert.strictEqual(doc.displays.dsp_new.template, 't2');
    }, T);

    test('item 6: the head card history spans the predecessor updates', async function() {
        function upd(id, label) {
            return [{ role: 'assistant', tool_calls: [{ id: id, function: { name: 'update_action_state', arguments: JSON.stringify({ state: 'running', label: label }) } }] },
                { role: 'tool', tool_call_id: id, content: '{"success":true}' }];
        }
        var chats = { A: { id: 'A', continuedTo: 'B', messages: upd('t1', 'one').concat(upd('t2', 'two')) },
            B: { id: 'B', continuedFrom: 'A', progressCarryOver: { state: 'running', label: 'two' }, messages: upd('t3', 'three') } };
        var m70 = await load070(chats);
        var src = await loadFile('src/js/tools/120-actions.js');
        var env = { chats: chats, getLineageChatIds: m70.getLineageChatIds,
            normalizeProgressTasks: function(t) { return Array.isArray(t) ? t : []; }, progressToolResultFailed: function() { return false; } };
        var f = new Function('env', 'with (env) {\n' + cutFns(src, ['_progressCarryOverEntry', 'collectAllActionUpdates', '_lineageMessagesSignature', '_lineagePriorActionUpdates'])
            + '\nreturn { prior: _lineagePriorActionUpdates, all: collectAllActionUpdates }; }')(env);
        var prior = f.prior(chats.B);
        assert.deepStrictEqual(prior.map(function(u) { return u.label; }), ['one', 'two']);
        var merged = prior.concat(f.all(chats.B).filter(function(u) { return !u.carriedOver; }));
        assert.deepStrictEqual(merged.map(function(u) { return u.label; }), ['one', 'two', 'three'], 'carried-over duplicate dropped');
        var body = cutFns(src, ['renderActionUpdatesSection']);
        assert.match(body, /_lineagePriorActionUpdates\(chat\)/, 'wired into the card renderer');
        assert.deepStrictEqual(f.prior(chats.A), [], 'chat without predecessor: nothing');
    }, T);
});
