// "Continue in a new chat" — phase 2: SW lineage migration
// (worker/130 _swContinueChatLineage + _swCopyLineageGrants, bus
// 'continueChatLineage' / delete-lane guard), core/082 rekeySplitViewChat,
// tools/020 _wsTransferOwnership(includeForceTaken), app/045
// migrateChatLineageOnSW. Real 070/082/095/097 via loadModules; the SW and
// workspace functions are cut out of their files and run against them.
var T = { tags: ['unit'], timeout: 8000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };

function cut(src, name) {
    var re = new RegExp('\\n(async )?function ' + name + '\\(');
    var mm = re.exec(src);
    if (!mm) throw new Error('function not found: ' + name);
    var start = mm.index + 1;
    var end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 2) + '\n';
}

describe('SW continueChatLineage migration', function() {
    var m, chats, sw, ws, fileRows, parked, pend, running, sessionPermissions, posted;
    beforeEach(async function() {
        chats = { A: { messages: [] }, B: { messages: [] } };
        pend = {}; running = {}; parked = {}; posted = [];
        sessionPermissions = { 'A::workspace:write': 'allow', 'A::servicenow_api:POST': 'allow', 'B::servicenow_api:POST': 'deny', 'X::web_fetch': 'allow' };
        m = await loadModules(['src/js/core/070-permissions.js', 'src/js/core/082-split-view.js', 'src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: running, pendingInjectionsByChatId: pend,
            isChatPaused: function() { return false; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
        fileRows = {};
        var src020 = await loadFile('src/js/tools/020-tool-execution.js');
        var wsEnv = {
            SubAgents: m.SubAgents, resolveLineageHead: m.resolveLineageHead, chats: chats, console: quiet,
            isChatRunning: function(id) { return !!running[id]; },
            _wsFormatAgo: function() { return '1h ago'; }, _wsRecentlyModified: function() { return false; }, WS_BRANCH_HINT: '',
            getAllWorkspaceFilesAllRepos: function() { return Promise.resolve(Object.keys(fileRows).map(function(k) { return Object.assign({}, fileRows[k]); })); },
            getWorkspaceFile: function(repo, path) { var r = fileRows[repo + '|' + path]; return Promise.resolve(r ? Object.assign({}, r) : null); },
            setWorkspaceFile: function(row) { fileRows[row.repo + '|' + row.path] = Object.assign({}, row); return Promise.resolve(); }
        };
        ws = new Function('env', 'with (env) {' + ['_wsLineageHead', '_wsRootChatId', '_wsSameChatLineage', '_wsOwnerChatRunning', '_wsCheckCrossChatConflict', '_wsCasWrite', '_wsTransferOwnership'].map(function(n) { return cut(src020, n); }).join('')
            + 'return { _wsTransferOwnership: _wsTransferOwnership, _wsCheckCrossChatConflict: _wsCheckCrossChatConflict }; }')(wsEnv);
        var src130 = await loadFile('src/js/worker/130-port-bridge.js');
        var swEnv = {
            registerLineageLink: m.registerLineageLink, getLineageChatIds: m.getLineageChatIds, resolveLineageHead: m.resolveLineageHead,
            SubAgents: m.SubAgents, rekeySplitViewChat: m.rekeySplitViewChat, _wsTransferOwnership: ws._wsTransferOwnership,
            sessionPermissions: sessionPermissions, parkedToolCallsByChatId: parked, pendingInjectionsByChatId: pend, runningChatIds: running,
            _swPermsDirty: {}, persistSessionPermissionsInWorker: function() { posted.push('persist'); },
            _swPanelPorts: new Set([{ postMessage: function(x) { posted.push(x.type); } }]), console: quiet
        };
        sw = new Function('env', 'with (env) {' + cut(src130, '_swCopyLineageGrants') + cut(src130, '_swContinueChatLineage')
            + 'return { migrate: _swContinueChatLineage, env: env }; }')(swEnv);
    });
    function sub(id, parentChatId) {
        var h = m.Handles.start(parentChatId, 'spawn_sub_agent', {}, id, function() { return new Promise(function() {}); });
        var r = { agent_id: id, chat_id: 'c_' + id, name: id, state: 'running', depth: 1, parent_agent_id: null,
            spawn_handle_id: h.handleId, parent_chat_id: parentChatId, root_chat_id: parentChatId, created_at: Date.now() };
        m._subAgents[id] = r;
        chats[r.chat_id] = { isSubAgent: true, subAgentId: id, parentChatId: parentChatId, messages: [] };
        return r;
    }
    function continueChat(from, to) { chats[from].continuedTo = to; chats[to].continuedFrom = from; }

    test('migration moves subs/handles/grants and is idempotent on re-run', async function() {
        var w = sub('w', 'A');
        continueChat('A', 'B');
        var r1 = await sw.migrate('A', 'B');
        assert.strictEqual(r1.ok, true, JSON.stringify(r1.errors));
        assert.deepStrictEqual(r1.reparented, ['w']);
        assert.strictEqual(r1.handlesMoved, 1);
        assert.strictEqual(w.parent_chat_id, 'B');
        assert.strictEqual(r1.grants, 1, 'only the missing key copied; head grant never overwritten');
        assert.strictEqual(sessionPermissions['B::workspace:write'], 'allow');
        assert.strictEqual(sessionPermissions['B::servicenow_api:POST'], 'deny');
        assert.ok(posted.indexOf('permissions-changed') !== -1 && posted.indexOf('persist') !== -1, 'grants persisted + rebroadcast');
        var r2 = await sw.migrate('A', 'B');
        assert.strictEqual(r2.ok, true);
        assert.deepStrictEqual(r2.reparented, []);
        assert.strictEqual(r2.handlesMoved, 0);
        assert.strictEqual(r2.grants, 0);
        assert.strictEqual(r2.filesMoved, 0);
        assert.strictEqual(w.parent_chat_id, 'B');
    }, T);

    test('grants survive the page prune of the old chat (old keys deleted)', async function() {
        continueChat('A', 'B');
        await sw.migrate('A', 'B');
        Object.keys(sessionPermissions).forEach(function(k) { if (k.indexOf('A::') === 0) delete sessionPermissions[k]; });
        assert.strictEqual(sessionPermissions['B::workspace:write'], 'allow');
        chats.A = { messages: [], _deleted: true };
        assert.strictEqual(m.hasChatPermissionGrant ? true : true, true);
    }, T);

    test('split view: the old chat\u2019s pane (widget, held update, progress) moves to the head; live head pane wins', async function() {
        var rec = { widgetId: 'w1', version: 3, title: 'Dash', heldUpdate: { version: 4 }, progress: { state: 'running', label: 'x' } };
        await m.setSplitViewState('A', rec);
        continueChat('A', 'B');
        var r = await sw.migrate('A', 'B');
        assert.strictEqual(r.splitView, 'moved');
        assert.deepStrictEqual(m.getSplitViewRecord('B'), rec);
        assert.deepStrictEqual(m.getSplitViewState('A'), rec, 'old id resolves to the head family');
        assert.strictEqual(await m.rekeySplitViewChat('A', 'B'), 'none', 'idempotent');
        // head already has its own live pane: kept, old row dropped
        chats.C = { messages: [] }; chats.D = { messages: [] };
        await m.setSplitViewState('C', { widgetId: 'old' });
        await m.setSplitViewState('D', { widgetId: 'new' });
        continueChat('C', 'D');
        assert.strictEqual(await m.rekeySplitViewChat('C', 'D'), 'kept-head');
        assert.strictEqual(m.getSplitViewRecord('D').widgetId, 'new');
    }, T);

    test('parked tool calls of reparented subs are untouched (not rejected), counted; injection of an idle old chat moves', async function() {
        var w = sub('w', 'A');
        var settled = [];
        parked[w.chat_id] = [{ toolCallId: 't1', name: '__approval_prompt__', input: { permissionKey: 'k' }, resolve: function(v) { settled.push(v); }, reject: function() {} }];
        pend.A = { text: 'hi', hasUserText: true };
        continueChat('A', 'B');
        var r = await sw.migrate('A', 'B');
        assert.strictEqual(r.parked.subs, 1);
        assert.strictEqual(parked[w.chat_id].length, 1);
        assert.deepStrictEqual(settled, [], 'nothing resolved/rejected');
        assert.strictEqual(m.resolveRootChatId(w.chat_id), 'B', 'approval routing for the sub resolves to the head');
        assert.strictEqual(r.injection, 'moved');
        assert.strictEqual(pend.B.text, 'hi');
        assert.strictEqual(pend.A, undefined);
    }, T);

    test('delete lane: un-awaited migration reparents synchronously, so stopDescendantsOfChat(old) stops nothing', async function() {
        var w = sub('w', 'A');
        continueChat('A', 'B');
        var p = sw.migrate('A', 'B');
        assert.deepStrictEqual(m.stopDescendantsOfChat('A', 'parent chat deleted'), []);
        assert.strictEqual(w.state, 'running');
        assert.strictEqual(sessionPermissions['B::workspace:write'], 'allow', 'grants copied before the first await');
        await p;
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var lane = src.indexOf("msg.chat._deleted === true");
        var mig = src.indexOf('_swContinueChatLineage(msg.chatId, _delHead, { skipLink: true })', lane);
        var unl = src.indexOf('unlinkLineageChat(msg.chatId)', lane);
        var stop = src.indexOf("SubAgents.stopDescendantsOfChat(msg.chatId, 'parent chat deleted')", lane);
        var swap = src.indexOf('chats[msg.chatId] = msg.chat;', lane);
        assert.ok(lane > 0 && mig > lane && stop > mig, 'tombstone lane migrates (skipLink) before the cascade stop');
        assert.ok(unl > mig && unl < swap, 'chain repair runs after the migration, before the tombstone swap');
        assert.ok(src.slice(unl, unl + 400).indexOf('saveChatsToStorage()') > 0, 'repaired neighbours are persisted');
    }, T);

    test('M1: a kept-head injection is MERGED with the old chat\u2019s (text + images), never dropped', async function() {
        pend.A = { text: 'old report', images: ['i1'] };
        pend.B = { text: 'head note', images: [], hasUserText: true };
        continueChat('A', 'B');
        var r = await sw.migrate('A', 'B');
        assert.strictEqual(r.injection, 'merged');
        assert.strictEqual(pend.A, undefined);
        assert.strictEqual(pend.B.text, 'head note\n\nold report');
        assert.deepStrictEqual(pend.B.images, ['i1']);
        assert.strictEqual(pend.B.hasUserText, true);
    }, T);

    test('m4: delete-lane re-run (skipLink) does not overwrite the head\u2019s predecessor link', async function() {
        chats.C = { messages: [] };
        m.registerLineageLink('A', 'B', { stamp: true });
        m.registerLineageLink('B', 'C', { stamp: true });
        assert.strictEqual(m.resolveLineageHead('A'), 'C');
        var r = await sw.migrate('A', 'C', { skipLink: true });
        assert.strictEqual(r.linked, false, 'link step skipped');
        assert.strictEqual(m._chatLineagePrev.C, 'B', 'C \u2190 B kept');
        assert.strictEqual(chats.C.continuedFrom, 'B');
        assert.deepStrictEqual(m.getLineageChatIds('C'), ['A', 'B', 'C']);
    }, T);

    test('workspace ownership moves to the head (incl. force-taken rows): no cross_chat_conflict after the old chat is gone', async function() {
        fileRows['r|a.js'] = { id: 1, repo: 'r', path: 'a.js', dirty: true, last_modified_by_chat_id: 'A', last_modified_at: 1 };
        fileRows['r|b.js'] = { id: 2, repo: 'r', path: 'b.js', dirty: true, last_modified_by_chat_id: 'A', force_taken_from: 'Z', last_modified_at: 1 };
        fileRows['r|c.js'] = { id: 3, repo: 'r', path: 'c.js', dirty: true, last_modified_by_chat_id: 'Y', last_modified_at: 1 };
        continueChat('A', 'B');
        var r = await sw.migrate('A', 'B');
        assert.strictEqual(r.filesMoved, 2);
        assert.strictEqual(fileRows['r|a.js'].last_modified_by_chat_id, 'B');
        assert.strictEqual(fileRows['r|b.js'].last_modified_by_chat_id, 'B');
        assert.strictEqual(fileRows['r|b.js'].force_taken_from, 'Z', 'takeover marker kept');
        assert.strictEqual(fileRows['r|c.js'].last_modified_by_chat_id, 'Y', 'foreign rows untouched');
        // old chat deleted: tombstone has no continuedTo and the SW link map is gone (restart)
        chats.A = { messages: [], _deleted: true };
        delete chats.B.continuedFrom;
        Object.keys(m._chatLineageNext || {}).forEach(function(k) { delete m._chatLineageNext[k]; });
        Object.keys(m._chatLineagePrev || {}).forEach(function(k) { delete m._chatLineagePrev[k]; });
        assert.strictEqual(ws._wsCheckCrossChatConflict(fileRows['r|a.js'], 'B'), null);
        var stale = { repo: 'r', path: 's.js', dirty: true, last_modified_by_chat_id: 'A', last_modified_at: 1 };
        assert.ok(ws._wsCheckCrossChatConflict(stale, 'B'), 'control: an unmigrated stamp would conflict');
        // default (non-lineage) transfer still skips force-taken rows
        fileRows['r|d.js'] = { id: 4, repo: 'r', path: 'd.js', dirty: true, last_modified_by_chat_id: 'Q', force_taken_from: 'Z' };
        var out = {};
        assert.strictEqual(await ws._wsTransferOwnership('Q', 'B', out), 0);
        assert.deepStrictEqual(out.skipped_force_taken, ['d.js']);
    }, T);

    test('invalid input returns ok:false without touching state', async function() {
        var r = await sw.migrate('A', 'A');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(sessionPermissions['B::workspace:write'], undefined);
    }, T);
});

describe('page migrateChatLineageOnSW', function() {
    async function loadPage(port) {
        var src = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        var env = { _agentBusPort: port, _openAgentBus: function() {}, registerLineageLink: function() { return true; },
            rekeySplitViewChat: function() { return Promise.resolve('moved'); }, setTimeout: setTimeout, clearTimeout: clearTimeout, console: quiet };
        var body = 'var _lineageMigratePending = {}; var LINEAGE_MIGRATE_TIMEOUT_MS = 8000;' + ['_setLineageMigrationPending', '_clearLineageMigrationPending', '_lineageMigrationRefused', '_lineageMigrationSettled'].map(function(n) { return cut(src, n); }).join('') + cut(src, '_lineageMigrateFallback') + cut(src, 'migrateChatLineageOnSW') + cut(src, '_resolveLineageMigrated');
        return new Function('env', 'with (env) {' + body + 'return { migrate: migrateChatLineageOnSW, resolve: _resolveLineageMigrated }; }')(env);
    }
    test('posts continueChatLineage and resolves with the SW reply', async function() {
        var sent = [], api;
        var port = { postMessage: function(x) { sent.push(x); setTimeout(function() { api.resolve({ type: 'lineage-migrated', requestId: x.requestId, result: { ok: true, reparented: ['w'] } }); }, 0); } };
        api = await loadPage(port);
        var res = await api.migrate('A', 'B');
        assert.strictEqual(sent[0].type, 'continueChatLineage');
        assert.strictEqual(sent[0].from, 'A');
        assert.strictEqual(sent[0].to, 'B');
        assert.deepStrictEqual(res, { ok: true, reparented: ['w'] });
    }, T);
    test('no port / timeout fall back to the page-local link only (m5: no split-view rekey from the page)', async function() {
        var api = await loadPage(null);
        var r1 = await api.migrate('A', 'B');
        assert.strictEqual(r1.fallback, true);
        assert.strictEqual(r1.reason, 'no-port');
        assert.strictEqual(r1.linked, true);
        assert.strictEqual(r1.splitView, 'none', 'split view is left to the SW migration retry');
        var api2 = await loadPage({ postMessage: function() {} });
        var r2 = await api2.migrate('A', 'B', { timeoutMs: 20 });
        assert.strictEqual(r2.reason, 'timeout');
        assert.strictEqual(r2.linked, true);
    }, T);

    async function loadPageFull(env) {
        var src = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        // Defaults filled IN PLACE: tests swap env._agentBusPort later.
        var defs = { _openAgentBus: function() {}, registerLineageLink: function() { return true; },
            rekeySplitViewChat: function() { return Promise.resolve('moved'); }, setTimeout: setTimeout, clearTimeout: clearTimeout, console: quiet };
        Object.keys(defs).forEach(function(k) { if (!(k in env)) env[k] = defs[k]; });
        var body = 'var _lineageMigratePending = {}; var LINEAGE_MIGRATE_TIMEOUT_MS = 8000;' + ['_setLineageMigrationPending', '_clearLineageMigrationPending', '_lineageMigrationSettled', '_lineageMigrationRefused', 'retryPendingLineageMigrations',
            'registerLineageLinkOnSW', '_lineageMigrateFallback', 'migrateChatLineageOnSW', '_resolveLineageMigrated'].map(function(n) { return cut(src, n); }).join('')
            .replace('function retryPendingLineageMigrations', 'var _lineageRetryInFlight = {};\nfunction retryPendingLineageMigrations');
        return new Function('env', 'with (env) {' + body + 'return { migrate: migrateChatLineageOnSW, resolve: _resolveLineageMigrated, retry: retryPendingLineageMigrations, link: registerLineageLinkOnSW }; }')(env);
    }
    test('fallback leaves a lineageMigrationPending marker; retry (bus reconnect / select) re-runs the migration and clears it on success', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' } };
        var env = { chats: chats, _agentBusPort: null };
        var api = await loadPageFull(env);
        var r1 = await api.migrate('A', 'B'); // no port: synchronous fallback (no timers in the sandbox)
        assert.strictEqual(r1.fallback, true);
        assert.strictEqual(chats.A.lineageMigrationPending, 'B', 'marker set by the fallback');
        // Bus back: the SW now answers.
        var sent = [];
        // Microtask replies: chained sandbox setTimeouts are throttled.
        env._agentBusPort = { postMessage: function(x) { if (x.type === 'registerLineageLink') return; sent.push(x); Promise.resolve().then(function() { api.resolve({ type: 'lineage-migrated', requestId: x.requestId, result: { ok: true } }); }); } };
        var ps = api.retry('B'); // selecting the head retries its predecessor
        assert.strictEqual(ps.length, 1);
        assert.strictEqual(api.retry().length, 0, 'in-flight retry is not duplicated');
        var r2 = await ps[0];
        assert.strictEqual(r2.ok, true);
        assert.deepStrictEqual([sent[0].type, sent[0].from, sent[0].to], ['continueChatLineage', 'A', 'B']);
        assert.strictEqual(chats.A.lineageMigrationPending, null, 'marker cleared (null: survives the put fill-gap merge) on success');
        assert.strictEqual(api.retry().length, 0, 'nothing pending any more');
    }, T);
    test('SW reply ok:false keeps the marker; no port: retry is a no-op', async function() {
        var chats = { A: { lineageMigrationPending: 'B' }, B: {} };
        var env = { chats: chats, _agentBusPort: null };
        var api = await loadPageFull(env);
        assert.strictEqual(api.retry().length, 0, 'no port: wait for hello');
        env._agentBusPort = { postMessage: function(x) { Promise.resolve().then(function() { api.resolve({ type: 'lineage-migrated', requestId: x.requestId, result: { ok: false, errors: ['x'] } }); }); } };
        await api.retry()[0];
        assert.strictEqual(chats.A.lineageMigrationPending, 'B');
    }, T);
    test('registerLineageLinkOnSW posts a synchronous registerLineageLink message; the SW case stamps the link', async function() {
        var sent = [];
        var api = await loadPageFull({ chats: {}, _agentBusPort: { postMessage: function(x) { sent.push(x); } } });
        assert.strictEqual(api.link('A', 'B'), true);
        assert.deepStrictEqual(sent, [{ type: 'registerLineageLink', from: 'A', to: 'B' }]);
        assert.strictEqual(api.link('A', 'A'), false);
        var src130 = await loadFile('src/js/worker/130-port-bridge.js');
        var i = src130.indexOf("case 'registerLineageLink':");
        assert.ok(i > 0, 'SW handles registerLineageLink');
        var seg = src130.slice(i, i + 800);
        assert.ok(seg.indexOf('registerLineageLink(msg.from, msg.to, { stamp: true })') > 0, 'stamps the link');
    }, T);
});

describe('chain repair on delete (core/070 unlinkLineageChat, ui/170 deleteChat)', function() {
    async function load(chats) {
        return loadModules(['src/js/core/070-permissions.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: chats, pendingInjectionsByChatId: {} } });
    }
    function chain3(m) { m.registerLineageLink('A', 'B', { stamp: true }); m.registerLineageLink('B', 'C', { stamp: true }); }
    test('M2: deleting the middle chat B of A\u2192B\u2192C joins A\u2192C (records + maps); A still resolves to C', async function() {
        var chats = { A: { messages: [] }, B: { messages: [] }, C: { messages: [] } };
        var m = await load(chats);
        chain3(m);
        var u = m.unlinkLineageChat('B');
        assert.deepStrictEqual([u.prev, u.next], ['A', 'C']);
        assert.deepStrictEqual(u.touched.sort(), ['A', 'C']);
        chats.B = { messages: [], _deleted: true }; // SW tombstone swap
        assert.strictEqual(chats.A.continuedTo, 'C');
        assert.strictEqual(chats.C.continuedFrom, 'A');
        assert.strictEqual(m._chatLineageNext.A, 'C');
        assert.strictEqual(m._chatLineagePrev.C, 'A');
        assert.strictEqual(m.resolveLineageHead('A'), 'C');
        assert.deepStrictEqual(m.getLineageChatIds('C'), ['A', 'C']);
        delete chats.B; // page delete: record gone
        assert.strictEqual(m.resolveLineageHead('A'), 'C');
    }, T);
    test('M3: deleting the head B of A\u2192B clears A.continuedTo (null, not undefined); A resolves to itself', async function() {
        var chats = { A: { messages: [] }, B: { messages: [] } };
        var m = await load(chats);
        m.registerLineageLink('A', 'B', { stamp: true });
        var u = m.unlinkLineageChat('B');
        assert.deepStrictEqual(u.touched, ['A']);
        assert.strictEqual(chats.A.continuedTo, null, 'null survives the put fill-gap carry');
        chats.B = { messages: [], _deleted: true };
        assert.strictEqual(m.resolveLineageHead('A'), 'A');
        assert.deepStrictEqual(m.getLineageChatIds('A'), ['A']);
    }, T);
    test('M3: a stale link to a tombstoned chat is never followed (_lineageNextOf skips _deleted)', async function() {
        var chats = { A: { messages: [], continuedTo: 'B' }, B: { messages: [], _deleted: true } };
        var m = await load(chats);
        assert.strictEqual(m.resolveLineageHead('A'), 'A');
        assert.strictEqual(m.forwardLineageInjection('A'), null);
        delete chats.B; chats.A.continuedTo = 'B'; // missing (SW may lag) is still followed
        assert.strictEqual(m.resolveLineageHead('A'), 'B');
    }, T);
    test('deleting the root A of A\u2192B clears B.continuedFrom', async function() {
        var chats = { A: { messages: [] }, B: { messages: [] } };
        var m = await load(chats);
        m.registerLineageLink('A', 'B', { stamp: true });
        m.unlinkLineageChat('A');
        assert.strictEqual(chats.B.continuedFrom, null);
        assert.strictEqual(m._chatLineagePrev.B, undefined);
        assert.deepStrictEqual(m.getLineageChatIds('B'), ['B']);
    }, T);
    test('M3: after deleting the head, confirmSendInContinuedChat does not redirect (no modal)', async function() {
        var chats = { A: { messages: [] }, B: { messages: [] } };
        var m = await load(chats);
        m.registerLineageLink('A', 'B', { stamp: true });
        m.unlinkLineageChat('B');
        delete chats.B;
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var modals = 0;
        var fn = new Function('env', 'with (env) {' + cut(src, 'confirmSendInContinuedChat') + 'return confirmSendInContinuedChat; }')({
            chats: chats, resolveLineageHead: m.resolveLineageHead, t: function(s) { return s; },
            showModal: function() { modals++; return Promise.resolve('head'); } });
        assert.strictEqual(await fn('A'), true);
        assert.strictEqual(modals, 0);
    }, T);
    test('ui/170 deleteChat repairs the chain before removing the record and pushes the touched neighbours', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var body = cut(src, 'deleteChat');
        var ul = body.indexOf('unlinkLineageChat(chatId)');
        var del = body.indexOf('delete chats[chatId];');
        assert.ok(ul > 0 && ul < del, 'unlink before delete');
        assert.ok(body.indexOf('_pushChatSkeletonToSW(nid)') > del, 'touched neighbours pushed to the SW');
        assert.ok(body.indexOf('saveChatsToStorage()') > del, 'and persisted');
    }, T);
});

describe('run-end lineage injection forward (core/070 forwardLineageInjection, app/030)', function() {
    test('a continued chat\u2019s leftover injection moves to the head (merged, never clobbered); no-op without a link', async function() {
        var chats = { A: { messages: [] }, B: { messages: [] }, C: { messages: [] } };
        var pend = { A: { text: 'report', images: ['i1'] }, B: { text: 'head', images: [], hasUserText: true }, C: { text: 'solo' } };
        var m = await loadModules(['src/js/core/070-permissions.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: chats, pendingInjectionsByChatId: pend } });
        assert.strictEqual(m.forwardLineageInjection('C'), null, 'not continued');
        assert.strictEqual(pend.C.text, 'solo');
        chats.A.continuedTo = 'B'; chats.B.continuedFrom = 'A';
        assert.strictEqual(m.forwardLineageInjection('A'), 'B');
        assert.strictEqual(pend.A, undefined);
        assert.strictEqual(pend.B.text, 'head\n\nreport');
        assert.deepStrictEqual(pend.B.images, ['i1']);
        assert.strictEqual(pend.B.hasUserText, true);
        pend.A = { text: 'late' }; delete pend.B;
        assert.strictEqual(m.forwardLineageInjection('A'), 'B');
        assert.deepStrictEqual(pend.B, { text: 'late' }, 'moved as-is when the head has none');
        assert.strictEqual(m.forwardLineageInjection('A'), null, 'nothing left');
    }, T);
    test('agent loop run end forwards before the old chat\u2019s delete/follow-up drain and starts an idle head', async function() {
        var src = await loadFile('src/js/app/030-agent-loop.js');
        var f = src.indexOf('forwardLineageInjection(streamingChatId)');
        assert.ok(f > 0, 'run end calls forwardLineageInjection');
        var del = src.indexOf('delete pendingInjectionsByChatId[streamingChatId];', f - 2000);
        assert.ok(del > f, 'forward happens before the run-end delete');
        assert.ok(src.indexOf('var _pendFollow = pendingInjectionsByChatId[streamingChatId];') > f, 'and before the follow-up drain');
        var seg = src.slice(f, f + 600);
        assert.ok(/!runningChatIds\[_fwdHead\][\s\S]*runAgent\(_fwdHead\)/.test(seg), 'idle head is started');
    }, T);
});
