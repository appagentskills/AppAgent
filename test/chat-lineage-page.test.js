// "Continue in a new chat" — phase 3 page side: handover block, page-state
// copy, file keep-alive on delete, lineage stamp, lineage-union views (PRs,
// workers, widgets, progress, done-gate), banners and the send redirect.
// Real functions are cut out of their source files and run against stubs for
// runtime plumbing only; core/070 lineage helpers are loaded for real.
var T = { tags: ['unit'], timeout: 5000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };

function cut(src, name) {
    var re = new RegExp('\\n(async )?function ' + name + '\\(');
    var mm = re.exec(src);
    if (!mm) throw new Error('function not found: ' + name);
    var start = mm.index + 1;
    var end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 2) + '\n';
}
async function cutAll(path, names) {
    var src = await loadFile(path);
    return names.map(function(n) { return cut(src, n); }).join('\n');
}
function build(code, names, env) {
    return new Function('env', 'with (env) {\n' + code + '\nreturn {' + names.map(function(n) { return n + ': ' + n; }).join(', ') + '};\n}')(env);
}
function load070(chats) {
    return loadModules(['src/js/core/070-permissions.js'], { lenient: true, globals: {
        self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: chats
    } });
}
function tr(s, p) { return p ? String(s).replace(/\{(\w+)\}/g, function(m, k) { return p[k]; }) : s; }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function pushMsgs(tcId, url, num, title, branch) {
    return [
        { role: 'assistant', content: '', tool_calls: [{ id: tcId, function: { name: 'workspace', arguments: JSON.stringify({ action: 'push', pr_title: title, branch_name: branch }) } }] },
        { role: 'tool', tool_call_id: tcId, content: JSON.stringify({ success: true, pr_url: url, pr_number: num }) }
    ];
}
var UI120 = ['lineageAncestorIds', 'lineageAncestorSet', 'getPushedPRsForLineage', '_getPushedPRsLive'];
var PR_STUB = '\nfunction getPushedPRsForChat(c) { return _getPushedPRsLive(c); }\n';

describe('lineage page helpers (ui/170, ui/120, core/070)', function() {
    test('buildLineageHandoverBlock: PRs, live workers w/ spawn_handle_id, split widget latestVersion, chat docs, dirty files', async function() {
        var chats = {
            Z: { id: 'Z', continuedTo: 'A', messages: pushMsgs('tc1', 'https://github.com/o/r/pull/1327', 1327, 'Feat', 'feat/x') },
            A: { id: 'A', continuedFrom: 'Z', messages: [] }
        };
        var m = await load070(chats);
        var env = {
            chats: chats, t: tr, getLineageChatIds: m.getLineageChatIds,
            subAgentsForChatTree: function() { return [
                { agent_id: 'sub_1', name: 'w1', state: 'running', spawn_handle_id: 'h_9' },
                { agent_id: 'sub_2', name: 'w2', state: 'stopped', spawn_handle_id: 'h_2' },
                { agent_id: 'sub_3', state: 'sleeping', _reconstructed: true }
            ]; },
            getSplitViewRecord: function(id) { return id === 'A' ? { widgetId: 'w_split' } : null; },
            WidgetStore: { view: function(id) { return id === 'w_split' ? { latestVersion: 7, contentVersion: 3 } : null; } },
            getWidgetsForChat: function() { return [{ id: 'w_split' }, { id: 'w_other' }]; },
            getChatProgressStateFor: function() { return { label: 'Build', state: 'running', tasks: [{ label: 't1', status: 'done' }, { label: 't2' }] }; },
            smartDocuments: { d1: { scope: 'chat', ownerChatId: 'Z', title: 'Notes' }, d2: { scope: 'chat', ownerChatId: 'Q' }, d3: { scope: 'shared', ownerChatId: 'A' } },
            getAllWorkspaceFilesAllRepos: function() { return Promise.resolve([
                { repo: 'o/r', path: 'a.js', dirty: true, last_modified_by_chat_id: 'A' },
                { repo: 'o/r', path: 'b.js', dirty: true, last_modified_by_chat_id: 'chat_sub_x' },
                { repo: 'o/r', path: 'c.js', dirty: true, last_modified_by_chat_id: 'Q' },
                { repo: 'o/r', path: 'd.js', dirty: false, last_modified_by_chat_id: 'A' }
            ]); },
            _wsRootChatId: function(id) { return id === 'chat_sub_x' ? 'Z' : id; }
        };
        var f = build((await cutAll('src/js/ui/120-ui-utils.js', UI120)) + PR_STUB + (await cutAll('src/js/ui/170-chat-management.js', ['buildLineageHandoverBlock'])),
            ['buildLineageHandoverBlock'], env);
        var out = await f.buildLineageHandoverBlock('A');
        assert.match(out, /^<handover_state>\n[\s\S]*\n<\/handover_state>$/);
        assert.ok(out.indexOf('- #1327 https://github.com/o/r/pull/1327 (branch `feat/x`)') >= 0, 'ancestor PR listed');
        assert.ok(out.indexOf('- sub_1 "w1" \u2014 running (spawn handle h_9)') >= 0, 'live worker with spawn_handle_id');
        assert.strictEqual(out.indexOf('sub_2'), -1, 'stopped worker not listed');
        assert.strictEqual(out.indexOf('sub_3'), -1, 'reconstructed worker not listed');
        assert.ok(out.indexOf('Split pane widget: w_split (version 7)') >= 0, 'latestVersion wins');
        assert.ok(out.indexOf('Other widgets: w_other') >= 0);
        assert.ok(out.indexOf('Progress card: "Build" (running) \u2014 tasks: done: t1; pending: t2') >= 0);
        assert.ok(out.indexOf('d1 "Notes"') >= 0, 'chat doc owned by an ancestor');
        assert.strictEqual(/d2|d3/.test(out), false, 'foreign / shared docs excluded');
        assert.ok(out.indexOf('- o/r: a.js, b.js') >= 0, 'own + sub-agent-owned dirty files');
        assert.strictEqual(/c\.js|d\.js/.test(out), false, 'foreign and clean files excluded');
        var empty = build(await cutAll('src/js/ui/170-chat-management.js', ['buildLineageHandoverBlock']), ['buildLineageHandoverBlock'], { chats: {} });
        assert.strictEqual(await empty.buildLineageHandoverBlock('A'), '', 'no subsystems: no block');
    }, T);

    test('copyLineagePageState: copies artifacts/caches/model/progress, moves drafts, repoints actions + pinned widgets', async function() {
        var calls = [];
        var env = {
            chats: {
                O: { versionHistory: [{ id: 'v1', chatId: 'O' }], cachedToolResults: { a: 1 }, displays: { d: 1 }, widgetRenders: { w: 1 }, model: 'm1' },
                N: {}
            },
            getChatProgressStateFor: function() { return { state: 'running', label: 'L', icon: 'code', tasks: [{ label: 'x', status: 'done' }] }; },
            chatPendingTexts: { O: 'draft' }, persistPendingTextsToStorage: function() { calls.push('texts'); },
            chatPendingImages: { O: ['img'] }, setSetting: function(k) { calls.push('set:' + k); },
            activeActions: { act1: { chatId: 'O' }, act2: { chatId: 'X' } }, persistActionState: function(id) { calls.push('act:' + id); },
            dashboardWidgets: { w1: { chatId: 'O' }, w2: { chatId: 'X' } }, saveDashboardWidget: function(d) { calls.push('dash:' + d.chatId); }
        };
        var f = build(await cutAll('src/js/ui/170-chat-management.js', ['copyLineagePageState']), ['copyLineagePageState'], env);
        f.copyLineagePageState('O', 'N');
        var N = env.chats.N;
        assert.deepStrictEqual(N.versionHistory, [{ id: 'v1', chatId: 'N' }]);
        assert.strictEqual(env.chats.O.versionHistory[0].chatId, 'O', 'old entries not mutated');
        assert.deepStrictEqual(N.cachedToolResults, { a: 1 });
        assert.notStrictEqual(N.cachedToolResults, env.chats.O.cachedToolResults, 'copied, not shared');
        assert.deepStrictEqual(N.displays, { d: 1 });
        assert.deepStrictEqual(N.widgetRenders, { w: 1 });
        assert.strictEqual(N.model, 'm1');
        assert.strictEqual(N.progressCarryOver.label, 'L');
        assert.strictEqual(N.progressCarryOver.state, 'running');
        assert.deepStrictEqual(env.chatPendingTexts, { N: 'draft' });
        assert.deepStrictEqual(env.chatPendingImages, { N: ['img'] });
        assert.strictEqual(env.activeActions.act1.chatId, 'N');
        assert.strictEqual(env.activeActions.act2.chatId, 'X');
        assert.strictEqual(env.dashboardWidgets.w1.chatId, 'N');
        assert.strictEqual(env.dashboardWidgets.w2.chatId, 'X');
        assert.deepStrictEqual(calls, ['texts', 'set:chatPendingImages', 'act:act1', 'dash:N']);
        env.chats.P = {}; env.chats.Q = { model: 'keep' };
        f.copyLineagePageState('P', 'Q');
        assert.deepStrictEqual(env.chats.Q.versionHistory, [], 'always an array');
        assert.strictEqual(env.chats.Q.model, 'keep');
        f.copyLineagePageState('nope', 'Q'); // missing chat: no throw
    }, T);

    test('copyLineagePageState: background-action identity (isBackground/actionId/…) moves to the head, cleared on the old chat', async function() {
        var env = {
            chats: {
                O: { isBackground: true, actionId: 'act1', skillId: 'sk', actionName: 'Run', sourceChatId: 'S', _revealed: true },
                N: {}, P: {}, Q: { isBackground: false }
            },
            activeActions: { act1: { chatId: 'O' } }, persistActionState: function() {}
        };
        var f = build(await cutAll('src/js/ui/170-chat-management.js', ['copyLineagePageState']), ['copyLineagePageState'], env);
        f.copyLineagePageState('O', 'N');
        var N = env.chats.N, O = env.chats.O;
        assert.strictEqual(env.activeActions.act1.chatId, 'N');
        // tools/120 executeUpdateActionState / finishActionIfDone gate on exactly this.
        assert.ok(N.isBackground && N.actionId === 'act1', 'head is the action chat');
        assert.strictEqual(N.skillId, 'sk');
        assert.strictEqual(N.actionName, 'Run');
        assert.strictEqual(N.sourceChatId, 'S');
        assert.strictEqual(N._revealed, true);
        ['isBackground', 'actionId', 'skillId', 'actionName', 'sourceChatId'].forEach(function(k) {
            assert.strictEqual(O[k], null, 'old chat cleared ' + k + ' (null survives the put fill-gap)');
        });
        assert.strictEqual(Object.prototype.hasOwnProperty.call(O, '_revealed'), false, 'old chat lost _revealed');
        f.copyLineagePageState('P', 'Q');
        assert.strictEqual(env.chats.Q.isBackground, false, 'non-action chat: nothing copied');
    }, T);

    test('keepLineageFilesAlive: chat file_ids are copied into the store and survive deleting the chat', async function() {
        var store = {};
        var env = {
            chats: {
                O: { messages: [{ role: 'screenshot', file_id: 'f1', base64: 'data:image/png;base64,AAA' }], screenshots: { f2: { base64: 'data:image/png;base64,BBB', name: 's.png' } } },
                X: { messages: [{ role: 'screenshot', file_id: 'f3', base64: 'data:image/png;base64,CCC' }] }
            },
            fileIndex: new Map([['f1', { type: 'chat', chatId: 'O', msgIndex: 0 }], ['f2', { type: 'screenshots_map', chatId: 'O' }], ['f3', { type: 'chat', chatId: 'X', msgIndex: 0 }], ['f4', { type: 'workspace', chatId: 'O' }]]),
            dataUrlMime: function(s) { var mm = /^data:([^;,]+)/.exec(s || ''); return mm ? mm[1] : null; },
            guessMimeFromRole: function() { return 'image/png'; },
            registerFile: function(spec) { store[spec.id] = spec; return spec.id; },
            smartDocuments: {}
        };
        var f = build((await cutAll('src/js/tools/040-file-store.js', ['getFile', 'resolveFilePointer'])) + (await cutAll('src/js/ui/170-chat-management.js', ['keepLineageFilesAlive'])),
            ['keepLineageFilesAlive', 'getFile'], env);
        var kept = f.keepLineageFilesAlive('O');
        assert.deepStrictEqual(kept, { f1: true, f2: true });
        assert.deepStrictEqual(Object.keys(store).sort(), ['f1', 'f2'], 'other chats / non-chat pointers untouched');
        assert.strictEqual(store.f1.data, 'data:image/png;base64,AAA');
        assert.strictEqual(store.f2.name, 's.png');
        delete env.chats.O;
        assert.strictEqual(f.getFile('f1'), null, 'the chat pointer is dead after delete');
        assert.strictEqual(store.f1.data, 'data:image/png;base64,AAA', '...but the content lives on in the store');
        assert.deepStrictEqual(f.keepLineageFilesAlive(''), {});
    }, T);

    test('registerLineageLink {stamp}: stamps both chats, never overwrites, skips tombstones', async function() {
        var chats = { A: {}, B: {}, C: { continuedTo: 'Z' }, D: { _deleted: true }, U: {}, V: {} };
        var m = await load070(chats);
        assert.strictEqual(m.registerLineageLink('U', 'V'), true);
        assert.strictEqual(chats.U.continuedTo, undefined, 'no stamp without opts.stamp');
        assert.strictEqual(m.registerLineageLink('A', 'B', { stamp: true }), true);
        assert.strictEqual(chats.A.continuedTo, 'B');
        assert.strictEqual(chats.B.continuedFrom, 'A');
        m.registerLineageLink('C', 'B', { stamp: true });
        assert.strictEqual(chats.C.continuedTo, 'Z', 'existing continuedTo kept');
        assert.strictEqual(chats.B.continuedFrom, 'A', 'existing continuedFrom kept');
        m.registerLineageLink('D', 'E', { stamp: true });
        assert.strictEqual(chats.D.continuedTo, undefined, 'tombstone untouched');
        assert.strictEqual(m.resolveLineageHead('D'), 'E', 'in-memory link still resolves');
    }, T);

    test('lineageAncestorIds / lineageAncestorSet: earlier chats + self only', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A', continuedTo: 'C' }, C: { continuedFrom: 'B' } };
        var m = await load070(chats);
        var f = build(await cutAll('src/js/ui/120-ui-utils.js', UI120) + PR_STUB, UI120, { chats: chats, getLineageChatIds: m.getLineageChatIds, t: tr });
        assert.deepStrictEqual(f.lineageAncestorIds('B'), ['A', 'B']);
        assert.deepStrictEqual(f.lineageAncestorIds('C'), ['A', 'B', 'C']);
        assert.deepStrictEqual(f.lineageAncestorIds('A'), ['A'], 'successors excluded');
        assert.deepStrictEqual(f.lineageAncestorIds('X'), ['X']);
        assert.deepStrictEqual(f.lineageAncestorIds(''), []);
        assert.deepStrictEqual(Object.keys(f.lineageAncestorSet('C')).sort(), ['A', 'B', 'C']);
        var g = build(await cutAll('src/js/ui/120-ui-utils.js', UI120) + PR_STUB, UI120, { chats: chats, t: tr });
        assert.deepStrictEqual(g.lineageAncestorIds('C'), ['C'], 'no core/070: self only');
    }, T);
});

describe('lineage-union views', function() {
    test('getPushedPRsForLineage: ancestors\' PRs, dedup by URL (newest entry wins)', async function() {
        var chats = {
            A: { id: 'A', continuedTo: 'B', messages: pushMsgs('t1', 'u1', 1, 'One', 'b1').concat(pushMsgs('t2', 'u2', 2, 'Two', 'b2')) },
            B: { id: 'B', continuedFrom: 'A', messages: pushMsgs('t3', 'u1', 1, 'One v2', 'b1') }
        };
        var m = await load070(chats);
        var f = build(await cutAll('src/js/ui/120-ui-utils.js', UI120) + PR_STUB, UI120, { chats: chats, getLineageChatIds: m.getLineageChatIds, t: tr });
        var prs = f.getPushedPRsForLineage('B');
        assert.deepStrictEqual(prs.map(function(p) { return p.url + ':' + p.title; }), ['u1:One v2', 'u2:Two']);
        assert.deepStrictEqual(f.getPushedPRsForLineage('A').map(function(p) { return p.title; }), ['One', 'Two'], 'old chat: own only');
    }, T);

    test('subAgentsForChatTree (Workers strip): union of the lineage subtree, sorted by state', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' } };
        var m = await load070(chats);
        var merged = [];
        var env = {
            chats: chats, getLineageChatIds: m.getLineageChatIds, t: tr,
            SubAgents: { listAll: function() { return [
                { agent_id: 's4', root_chat_id: 'B', parent_chat_id: 'B', state: 'stopped' },
                { agent_id: 's2', parent_chat_id: 'B', state: 'sleeping' },
                { agent_id: 's3', root_chat_id: 'X', parent_chat_id: 'X', state: 'running' },
                { agent_id: 's1', root_chat_id: 'A', parent_chat_id: 'A', state: 'running' }
            ]; } },
            _mergeReconstructedSubs: function(list, id) { merged.push(id); }
        };
        var f = build(await cutAll('src/js/ui/120-ui-utils.js', UI120) + PR_STUB + (await cutAll('src/js/ui/175-sub-agent-ui.js', ['_subLineageSet', '_dedupeWorkersById', 'subAgentsForChatTree'])),
            ['subAgentsForChatTree'], env);
        assert.deepStrictEqual(f.subAgentsForChatTree('B').map(function(r) { return r.agent_id; }), ['s1', 's2', 's4']);
        assert.deepStrictEqual(merged.sort(), ['A', 'B'], 'reconstructed subs merged per lineage chat');
        assert.deepStrictEqual(f.subAgentsForChatTree('A').map(function(r) { return r.agent_id; }), ['s1', 's2', 's4'], 'old chat: same lineage-wide workers');
    }, T);

    test('Workers strip after continue: one card per agent_id, live registry wins over old-chat spawn/report cards, gauge = agent_status context_pct', async function() {
        // Old chat A carries sub_report cards for a moved live worker (w_live),
        // a GC'd worker (w_gone) and, in B too, the same live worker again.
        var subRep = function(id, chatId, at) { return { role: 'sub_report', subAgentId: id, subAgentName: id, subChatId: chatId, report: { status: 'done', at: at } }; };
        var chats = {
            A: { continuedTo: 'B', messages: [subRep('w_live', 'chat_sub_w_live', 1), subRep('w_gone', 'chat_sub_w_gone', 2)] },
            B: { continuedFrom: 'A', messages: [subRep('w_live', 'chat_sub_w_live', 3)] },
            // Page copy of the live sub chat is stale (older, smaller context).
            chat_sub_w_live: { messages: [{ role: 'assistant', metrics: { input_tokens: 40000 } }] }
        };
        var m = await load070(chats);
        var live = { agent_id: 'w_live', name: 'w_live', chat_id: 'chat_sub_w_live', root_chat_id: 'B', parent_chat_id: 'B', state: 'sleeping',
            tier: 'heavy', profiles: ['code'], last_input_tokens: 140000 };
        var reg = { w_live: live };
        var env = {
            chats: chats, getLineageChatIds: m.getLineageChatIds, t: tr,
            SubAgents: { listAll: function() { return [live]; }, getById: function(id) { return reg[id] || null; } },
            _reconstructedSubs: Object.create(null),
            _subUiIsSkeleton: function() { return false; },
            _reportStatusToWorkerState: function(s) { return s === 'error' ? 'errored' : 'stopped'; },
            _subContextLimit: function() { return 200000; }
        };
        var names = ['_subLineageSet', '_reconstructSubsFromMessages', '_reconstructSubsFromChat', '_mergeReconstructedSubs', '_dedupeWorkersById', 'subAgentsForChatTree', '_subContextInfo'];
        var f = build(await cutAll('src/js/ui/120-ui-utils.js', UI120) + PR_STUB + (await cutAll('src/js/ui/175-sub-agent-ui.js', names)), names, env);
        var list = f.subAgentsForChatTree('B');
        assert.deepStrictEqual(list.map(function(r) { return r.agent_id; }).sort(), ['w_gone', 'w_live'], 'each agent_id once; header count = 2');
        var wl = list.filter(function(r) { return r.agent_id === 'w_live'; })[0];
        assert.strictEqual(wl, live, 'live registry record (tier/profiles/state) used, not the transcript rebuild');
        assert.ok(!env._reconstructedSubs.w_live, 'live worker never cached as reconstructed');
        var wg = list.filter(function(r) { return r.agent_id === 'w_gone'; })[0];
        assert.ok(wg._reconstructed && wg.state === 'stopped', 'GC\'d sub kept as an ended card (same as a normal chat)');
        // Gauge: registry last_input_tokens (agent_status context_pct = 70) beats the stale chat scan (20).
        assert.deepStrictEqual(f._subContextInfo(wl.chat_id, wl), { tokens: 140000, pct: 70 });
        assert.deepStrictEqual(f._subContextInfo(wl.chat_id), { tokens: 40000, pct: 20 }, 'no record: legacy chat scan');
        // Sub chat not loaded on the page at all: still the registry value, not "\u2014".
        assert.deepStrictEqual(f._subContextInfo('chat_sub_missing', { agent_id: 'x', last_input_tokens: 112000 }), { tokens: 112000, pct: 56 });
        // GC'd/reconstructed record with a missing chat: no fake gauge.
        assert.deepStrictEqual(f._subContextInfo(wg.chat_id, wg), { tokens: 0, pct: 0 });
        // _dedupeWorkersById: a later live record replaces an earlier reconstructed one.
        var d = f._dedupeWorkersById([{ agent_id: 'q', _reconstructed: true }, { agent_id: 'r' }, { agent_id: 'q', state: 'running' }, { agent_id: 'r', _reconstructed: true }]);
        assert.deepStrictEqual(d.map(function(r) { return r.agent_id + (r._reconstructed ? '*' : ''); }), ['q', 'r']);
    }, T);

    test('getWidgetsForChat: ancestors\' widgets first, each keeps its own chatId; store widgets of the lineage included', async function() {
        var chats = { A: { continuedTo: 'B', widgets: [{ id: 'wa', chatId: 'A' }, { id: 'wn' }] }, B: { continuedFrom: 'A', widgets: [{ id: 'wb' }] }, X: { widgets: [{ id: 'wx' }] } };
        var m = await load070(chats);
        var views = { ws: { id: 'ws', chatId: 'A', latestVersion: 2 }, wa: { latestVersion: 5 }, wf: { id: 'wf', chatId: 'X' } };
        var env = {
            chats: chats, chatWidgets: {}, getLineageChatIds: m.getLineageChatIds, t: tr,
            WidgetStore: { list: function() { return [{ id: 'ws' }, { id: 'wf' }]; }, view: function(id) { return views[id] || null; } }
        };
        var f = build(await cutAll('src/js/ui/120-ui-utils.js', UI120) + PR_STUB + (await cutAll('src/js/tools/080-widget-tools.js', ['getWidgetsForChat'])), ['getWidgetsForChat'], env);
        var wB = f.getWidgetsForChat('B');
        assert.deepStrictEqual(wB.map(function(w) { return w.id + '@' + w.chatId; }), ['wa@A', 'wn@A', 'wb@B', 'ws@A']);
        assert.strictEqual(wB[0].latestVersion, 5, 'store view merged');
        assert.deepStrictEqual(f.getWidgetsForChat('A').map(function(w) { return w.id; }), ['wa', 'wn', 'ws'], 'old chat: own only');
    }, T);

    test('collectAllActionUpdates: progressCarryOver is prepended; own updates follow', async function() {
        var src120 = await loadFile('src/js/tools/120-actions.js');
        var vps = /\nvar VALID_PROGRESS_TASK_STATUSES = [^;]*;/.exec(src120);
        assert.ok(vps, 'VALID_PROGRESS_TASK_STATUSES found');
        var f = build(vps[0] + '\n' + (await cutAll('src/js/tools/120-actions.js', ['normalizeProgressTasks', 'progressToolResultFailed', '_progressCarryOverEntry', 'collectAllActionUpdates', '_progressLatestForSkeleton'])),
            ['collectAllActionUpdates', '_progressLatestForSkeleton'], { _progressLatestByChat: {}, _progressFillTried: {}, chatMessageCount: function(c) { return c._msgCount || 0; } });
        var chat = { progressCarryOver: { state: 'running', label: 'Old card', icon: 'code', tasks: [{ label: 'x', status: 'done' }] }, messages: [] };
        var ups = f.collectAllActionUpdates(chat);
        assert.strictEqual(ups.length, 1);
        assert.strictEqual(ups[0].carriedOver, true);
        assert.strictEqual(ups[0].label, 'Old card');
        assert.strictEqual(ups[0].tasks[0].label, 'x');
        chat.messages = [
            { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'update_action_state', arguments: JSON.stringify({ state: 'done', label: 'New card', tasks: [] }) } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{"success":true}' }
        ];
        ups = f.collectAllActionUpdates(chat);
        assert.deepStrictEqual(ups.map(function(u) { return u.label; }), ['Old card', 'New card'], 'latest = own update');
        assert.strictEqual(f.collectAllActionUpdates({ messages: [] }).length, 0, 'no carry-over: nothing');
        // Evicted skeleton (no messages array, no cached compute): carry-over fallback.
        var sk = f._progressLatestForSkeleton({ id: 'K', _msgCount: 3, progressCarryOver: { state: 'running', label: 'Old card' } });
        assert.ok(sk && sk.label === 'Old card' && sk.carriedOver === true, 'skeleton falls back to progressCarryOver');
        assert.strictEqual(f._progressLatestForSkeleton({ id: 'K2', _msgCount: 1 }), null, 'skeleton w/o carry-over: null');
    }, T);

    test('done-gate: a running sub of an earlier lineage chat blocks a terminal state', async function() {
        var chats = { A: { continuedTo: 'B', messages: [] }, B: { continuedFrom: 'A', messages: [] } };
        var m = await load070(chats);
        var subs = [{ agent_id: 's1', name: 'w1', parent_chat_id: 'A', state: 'running' }];
        var env = {
            chats: chats, getLineageChatIds: m.getLineageChatIds, t: tr, activeStreamingChatId: null, currentChatId: 'B',
            SubAgents: { listAll: function() { return subs; } }, saveChatsToStorage: function() {}
        };
        var f = build(await cutAll('src/js/ui/120-ui-utils.js', UI120) + PR_STUB + (await cutAll('src/js/tools/120-actions.js', ['executeUpdateActionState'])), ['executeUpdateActionState'], env);
        var r = await f.executeUpdateActionState({ state: 'done', label: 'x' }, { chatId: 'B' });
        assert.strictEqual(r.success, false);
        assert.match(r.error, /1 sub-agent\(s\) still running \(w1\)/);
        subs[0].state = 'sleeping';
        var err = null, r2 = null;
        try { r2 = await f.executeUpdateActionState({ state: 'done', label: 'x' }, { chatId: 'B' }); } catch (e) { err = e; }
        // Past the gate the real function needs more runtime; only the gate is under test.
        assert.ok(!(r2 && /still running/.test(r2.error || '')) && !(err && /still running/.test(err.message)), 'settled sub does not block');
    }, T);
});

describe('old chat UI: banners + send redirect', function() {
    test('renderLineageBanner: both directions, escaped, missing target', async function() {
        var chats = { O: { continuedTo: 'N', title: 'Old' }, N: { continuedFrom: 'O', title: 'New <b>' }, P: { continuedTo: 'GONE' } };
        var env = { chats: chats, t: tr, escapeHtml: escHtml, escapeJsString: function(s) { return String(s).replace(/'/g, "\\'"); } };
        var f = build(await cutAll('src/js/ui/170-chat-management.js', ['renderLineageBanner']), ['renderLineageBanner'], env);
        var to = f.renderLineageBanner(chats.O, 'bottom');
        assert.match(to, /class="chat-lineage-banner chat-lineage-banner-to"/);
        assert.ok(to.indexOf('Continued in \u2192 ') >= 0);
        assert.ok(to.indexOf("onclick=\"selectChat('N')\" role=\"button\" tabindex=\"0\"") >= 0);
        assert.ok(to.indexOf('New &lt;b&gt;') >= 0 && to.indexOf('<b>') === -1, 'title escaped');
        var from = f.renderLineageBanner(chats.N, 'top');
        assert.match(from, /chat-lineage-banner-from/);
        assert.ok(from.indexOf('Continued from \u2190 ') >= 0 && from.indexOf("selectChat('O')") >= 0 && from.indexOf('>Old<') >= 0);
        assert.strictEqual(f.renderLineageBanner(chats.O, 'top'), '', 'no continuedFrom: no top banner');
        assert.strictEqual(f.renderLineageBanner(chats.N, 'bottom'), '', 'head: no bottom banner');
        var miss = f.renderLineageBanner(chats.P, 'bottom');
        assert.match(miss, /is-missing/);
        assert.ok(miss.indexOf('deleted chat') >= 0 && miss.indexOf('onclick') === -1, 'missing target: not clickable');
        assert.strictEqual(f.renderLineageBanner(null, 'top'), '');
    }, T);

    test('confirmSendInContinuedChat: "Go to the new chat" moves the draft and redirects; "here" proceeds', async function() {
        var chats = { O: { continuedTo: 'N', title: 'Old' }, N: { continuedFrom: 'O', title: 'New' }, S: {}, Q: { continuedTo: 'GONE' } };
        var m = await load070(chats);
        var answer = 'head', modals = 0, selected = [];
        var input = { value: 'hello' };
        var env = {
            chats: chats, t: tr, escapeHtml: escHtml, resolveLineageHead: m.resolveLineageHead,
            showModal: function() { modals++; return Promise.resolve(answer); },
            document: { getElementById: function(id) { return id === 'message-input' ? input : null; } },
            chatPendingTexts: { O: 'hello', N: 'head draft' }, selectChat: function(id) { selected.push(id); },
            persisted: 0, persistPendingTextsToStorage: function() { env.persisted++; },
            pendingImageAttachments: [{ name: 'live.png' }], getPendingImagesOwnerContext: function() { return 'O'; },
            chatPendingImages: { O: [{ name: 'live.png' }], N: [{ name: 'head.png' }] }, setSetting: function() {},
            modalMsgs: []
        };
        env.showModal = function(title, msg) { modals++; env.modalMsgs.push(msg); return Promise.resolve(answer); };
        chats.N.title = 'New & <i>';
        var f = build(await cutAll('src/js/ui/170-chat-management.js', ['confirmSendInContinuedChat']), ['confirmSendInContinuedChat'], env);
        assert.strictEqual(await f.confirmSendInContinuedChat('O'), false, 'redirect: do not send here');
        assert.deepStrictEqual(selected, ['N']);
        assert.deepStrictEqual(env.chatPendingTexts, { N: 'head draft\n\nhello' }, 'draft merged into the head draft');
        assert.strictEqual(env.persisted, 1, 'drafts persisted');
        assert.deepStrictEqual(env.chatPendingImages, { N: [{ name: 'head.png' }, { name: 'live.png' }] }, 'images moved to the head');
        assert.strictEqual(env.pendingImageAttachments.length, 0, 'live list emptied in place');
        assert.ok(env.modalMsgs[0].indexOf('"New & <i>"') >= 0, 'raw title passed to the sanitizing modal');
        assert.strictEqual(input.value, '');
        answer = 'here'; input.value = 'again';
        assert.strictEqual(await f.confirmSendInContinuedChat('O'), true);
        assert.deepStrictEqual(selected, ['N'], 'no navigation');
        assert.strictEqual(input.value, 'again');
        answer = undefined;
        assert.strictEqual(await f.confirmSendInContinuedChat('O'), false, 'dismissed modal: no send');
        var before = modals;
        assert.strictEqual(await f.confirmSendInContinuedChat('S'), true, 'never continued');
        assert.strictEqual(await f.confirmSendInContinuedChat('Q'), true, 'head missing');
        assert.strictEqual(modals, before, 'no modal in those cases');
        var src = await loadFile('src/js/app/040-send-message.js');
        assert.match(cut(src, 'sendMessage'), /chats\[currentChatId\]\.continuedTo\) \{\s*var _sendHere = true;\s*try \{ _sendHere = await confirmSendInContinuedChat\(currentChatId\);/, 'sendMessage gates on it');
    }, T);
});
