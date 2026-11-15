// "Continue in a new chat" — phase 1: chat lineage helpers + resolvers +
// sub-agent registry reparenting + Handles.rekey. Real source files via
// loadModules; globals stub only runtime plumbing (chats map, IDB, runAgent).
var T = { tags: ['unit'], timeout: 5000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };

// Cut one top-level function out of a big file (body ends at the first
// column-zero "}" line after its header).
function cutFn(src, name) {
    var start = src.indexOf('\nfunction ' + name + '(');
    if (start === -1) throw new Error('function not found: ' + name);
    var end = src.indexOf('\n}\n', start + 1);
    return src.slice(start + 1, end + 2);
}

function load070(globals) {
    return loadModules(['src/js/core/070-permissions.js'], { lenient: true, globals: Object.assign({
        self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet
    }, globals || {}) });
}

describe('core/070 lineage helpers', function() {
    test('resolveLineageHead follows A->B->C; getLineageChatIds returns the whole chain from any member', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A', continuedTo: 'C' }, C: { continuedFrom: 'B' }, X: {} };
        var m = await load070({ chats: chats });
        assert.strictEqual(m.resolveLineageHead('A'), 'C');
        assert.strictEqual(m.resolveLineageHead('B'), 'C');
        assert.strictEqual(m.resolveLineageHead('C'), 'C');
        assert.strictEqual(m.resolveLineageHead('X'), 'X', 'never-continued chat is its own head');
        assert.strictEqual(m.resolveLineageHead(null), null);
        assert.deepStrictEqual(m.getLineageChatIds('A'), ['A', 'B', 'C']);
        assert.deepStrictEqual(m.getLineageChatIds('B'), ['A', 'B', 'C']);
        assert.deepStrictEqual(m.getLineageChatIds('C'), ['A', 'B', 'C']);
        assert.deepStrictEqual(m.getLineageChatIds('X'), ['X']);
        assert.deepStrictEqual(m.getLineageChatIds(''), []);
    }, T);

    test('long chains have no small hop cap', async function() {
        var chats = {};
        for (var i = 0; i < 40; i++) chats['c' + i] = { continuedTo: 'c' + (i + 1), continuedFrom: i ? 'c' + (i - 1) : undefined };
        chats.c40 = { continuedFrom: 'c39' };
        var m = await load070({ chats: chats });
        assert.strictEqual(m.resolveLineageHead('c0'), 'c40');
        assert.strictEqual(m.getLineageChatIds('c17').length, 41);
    }, T);

    test('cycles terminate (A->B->A, self-link)', async function() {
        var chats = { A: { continuedTo: 'B', continuedFrom: 'B' }, B: { continuedTo: 'A', continuedFrom: 'A' }, S: { continuedTo: 'S' } };
        var m = await load070({ chats: chats });
        assert.strictEqual(m.resolveLineageHead('A'), 'B');
        assert.strictEqual(m.resolveLineageHead('B'), 'A');
        assert.strictEqual(m.resolveLineageHead('S'), 'S');
        var ids = m.getLineageChatIds('A');
        assert.strictEqual(ids.length, 2);
        assert.ok(ids.indexOf('A') !== -1 && ids.indexOf('B') !== -1);
        assert.deepStrictEqual(m.getLineageChatIds('S'), ['S']);
    }, T);

    test('registerLineageLink is the fallback when chats has no stamps', async function() {
        var m = await load070({ chats: {} });
        assert.strictEqual(m.registerLineageLink('P', 'Q'), true);
        assert.strictEqual(m.registerLineageLink('Q', 'Q'), false);
        m.registerLineageLink('Q', 'R');
        assert.strictEqual(m.resolveLineageHead('P'), 'R');
        assert.deepStrictEqual(m.getLineageChatIds('Q'), ['P', 'Q', 'R']);
    }, T);

    test('resolveRootChatId resolves a sub of an old chat to the lineage head; grants carry over', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' } };
        var recs = { c_sub: { root_chat_id: 'A', parent_chat_id: 'A' } };
        var sessionPermissions = { 'A::servicenow_write': 'allow' };
        var m = await load070({
            chats: chats, sessionPermissions: sessionPermissions,
            SubAgents: { getByChatId: function(id) { return recs[id] || null; } }
        });
        assert.strictEqual(m.resolveRootChatId('A'), 'B');
        assert.strictEqual(m.resolveRootChatId('c_sub'), 'B');
        assert.strictEqual(m.resolveRootChatId('B'), 'B');
        assert.strictEqual(m.hasChatPermissionGrant('servicenow_write', 'B'), true, 'approval from A applies in B');
        assert.strictEqual(m.hasChatPermissionGrant('servicenow_write', 'c_sub'), true);
        assert.strictEqual(m.hasChatPermissionGrant('other_key', 'B'), false);
    }, T);
});

describe('tools/020 _wsRootChatId + tools/110 _sdocChatChain route through lineage', function() {
    test('_wsRootChatId: sub of old chat and the continuation share one root', async function() {
        var m = await load070({ chats: { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' } } });
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var recs = { c_sub: { root_chat_id: 'A', parent_chat_id: 'A' } };
        var env = { resolveLineageHead: m.resolveLineageHead, SubAgents: { getByChatId: function(id) { return recs[id] || null; } } };
        var fns = new Function('env', 'with (env) {' + cutFn(src, '_wsLineageHead') + cutFn(src, '_wsRootChatId') + cutFn(src, '_wsSameChatLineage')
            + 'return { root: _wsRootChatId, same: _wsSameChatLineage }; }')(env);
        assert.strictEqual(fns.root('c_sub'), 'B');
        assert.strictEqual(fns.root('A'), 'B');
        assert.strictEqual(fns.same('c_sub', 'B'), true);
        assert.strictEqual(fns.same('A', 'B'), true);
        assert.strictEqual(fns.same('A', 'Z'), false);
    }, T);

    test('_sdocChatChain: chat-scoped doc of the old chat is visible from the continuation and its subs', async function() {
        var m = await load070({ chats: { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' } } });
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        var recs = { c_sub: { parent_chat_id: 'B' } };
        var env = { getLineageChatIds: m.getLineageChatIds, SubAgents: { getByChatId: function(id) { return recs[id] || null; } } };
        var fns = new Function('env', 'with (env) {' + cutFn(src, '_sdocChatChain') + cutFn(src, '_sdocSameLineage')
            + 'return { chain: _sdocChatChain, same: _sdocSameLineage }; }')(env);
        assert.deepStrictEqual(fns.chain('c_sub'), ['c_sub', 'B', 'A']);
        assert.strictEqual(fns.same('B', 'A'), true);
        assert.strictEqual(fns.same('c_sub', 'A'), true);
        assert.strictEqual(fns.same('Z', 'A'), false);
    }, T);
});

describe('core/095 Handles.rekey', function() {
    test('moves pending + settled entries; live deferred still settles the moved entry', async function() {
        var m = await loadModules(['src/js/core/095-handle-registry.js'], { lenient: true, globals: { self: {}, console: quiet } });
        var resolveIt;
        var p = m.Handles.start('A', 'spawn_sub_agent', {}, 'w', function() { return new Promise(function(r) { resolveIt = r; }); });
        var s = m.Handles.start('A', 'x', {}, 'done', function() { return Promise.resolve('ok'); });
        await new Promise(function(r) { setTimeout(r, 0); });
        assert.strictEqual(m.Handles.get('A', s.handleId).status, 'done');
        assert.strictEqual(m.Handles.rekey('A', 'B'), 2);
        assert.strictEqual(m.Handles.get('A', p.handleId), null);
        assert.strictEqual(m.Handles.get('B', s.handleId).status, 'done');
        var moved = m.Handles.get('B', p.handleId);
        assert.strictEqual(moved.chatId, 'B');
        assert.strictEqual(moved.status, 'pending');
        resolveIt({ summary: 'hi' });
        var snap = await m.Handles.await('B', p.handleId, 2000);
        assert.strictEqual(snap.status, 'done');
        assert.strictEqual(m.Handles.rekey('A', 'B'), 0, 'idempotent');
        assert.strictEqual(m.Handles.rekey('B', 'B'), 0);
    }, T);
});

describe('core/097 reparentChat + lazy reparent + lineage ACL', function() {
    var m, chats, pend, running;
    beforeEach(async function() {
        chats = { A: { messages: [] }, B: { messages: [] } };
        pend = {}; running = {};
        m = await loadModules(['src/js/core/070-permissions.js', 'src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: running, pendingInjectionsByChatId: pend,
            isChatPaused: function() { return false; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function sub(id, parentChatId, extra) {
        var h = m.Handles.start(parentChatId, 'spawn_sub_agent', {}, id, function() { return new Promise(function() {}); });
        var r = Object.assign({ agent_id: id, chat_id: 'c_' + id, name: id, state: 'running', depth: 1, parent_agent_id: null,
            spawn_handle_id: h.handleId, parent_chat_id: parentChatId, root_chat_id: parentChatId, created_at: Date.now() }, extra || {});
        m._subAgents[id] = r;
        chats[r.chat_id] = { isSubAgent: true, subAgentId: id, parentChatId: parentChatId, messages: [] };
        return r;
    }
    function continueChat(from, to) { chats[from].continuedTo = to; chats[to].continuedFrom = from; }

    test('reparentChat moves depth-1 subs, re-roots nested subs, rekeys handles; stopDescendantsOfChat(old) no longer matches', async function() {
        var w = sub('w', 'A');
        var kid = sub('kid', w.chat_id, { depth: 2, parent_agent_id: 'w', root_chat_id: 'A' });
        continueChat('A', 'B');
        var res = m.reparentChat('A', 'B');
        assert.deepStrictEqual(res.reparented, ['w']);
        assert.deepStrictEqual(res.rerooted, ['kid']);
        assert.strictEqual(res.handlesMoved, 1);
        assert.strictEqual(w.parent_chat_id, 'B');
        assert.strictEqual(w.root_chat_id, 'B');
        assert.strictEqual(chats.c_w.parentChatId, 'B');
        assert.strictEqual(kid.parent_chat_id, w.chat_id, 'nested parent untouched');
        assert.strictEqual(kid.root_chat_id, 'B');
        assert.ok(m.Handles.get('B', w.spawn_handle_id), 'spawn handle now under B');
        assert.strictEqual(m.Handles.get('A', w.spawn_handle_id), null);
        assert.deepStrictEqual(m.stopDescendantsOfChat('A', 'old chat deleted'), [], 'deleting the old chat kills nothing');
        assert.strictEqual(w.state, 'running');
        assert.strictEqual(m.reparentChat('A', 'B').reparented.length, 0, 'idempotent');
    }, T);

    test('_callerOwnsTarget + markReportCollected are lineage-aware', async function() {
        var w = sub('w', 'A');
        continueChat('A', 'B');
        assert.strictEqual(m._callerOwnsTarget('B', null, w), true, 'continuation owns old chat workers before migration');
        assert.strictEqual(m._callerOwnsTarget('Z', null, w), false);
        assert.strictEqual(m.markReportCollected('B', w.spawn_handle_id), true);
        assert.strictEqual(w.report_collected, true);
        assert.strictEqual(m.markReportCollected('Z', w.spawn_handle_id), false);
    }, T);

    test('a report arriving for an old parent lazily reparents and wakes the continuation', async function() {
        var w = sub('w', 'A');
        continueChat('A', 'B');
        running.B = true;
        assert.strictEqual(m._wakeParentOnReport(w, { status: 'done', summary: 'FINISHED' }, {}), true);
        assert.strictEqual(w.parent_chat_id, 'B');
        assert.ok(pend.B && /FINISHED/.test(pend.B.text), 'notice queued for the continuation');
        assert.ok(!pend.A, 'nothing queued for the old chat');
        assert.ok(m.Handles.get('B', w.spawn_handle_id), 'handle rekeyed');
    }, T);

    test('lazy reparent on spawn-handle settle (A->B->C) and no-op without lineage', async function() {
        var w = sub('w', 'A');
        chats.C = { messages: [] };
        continueChat('A', 'B'); continueChat('B', 'C');
        assert.strictEqual(m._subLazyReparent(w), true);
        assert.strictEqual(w.parent_chat_id, 'C');
        assert.strictEqual(w.root_chat_id, 'C');
        assert.ok(m.Handles.get('C', w.spawn_handle_id));
        assert.strictEqual(m._subLazyReparent(w), false, 'already at head');
        var u = sub('u', 'C');
        assert.strictEqual(m._subLazyReparent(u), false);
        assert.strictEqual(typeof m.SubAgents.reparentChat, 'function');
    }, T);
});

describe('close-out: pending-wake move, linSig full rebuild, SWM-S1 placement', function() {
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    // pending_wakes IDB fake copied from test/agent-message-debounce.test.js.
    function fakeDb() {
        var data = {};
        function req(fn) { var r = {}; Promise.resolve().then(function() { r.result = fn(); if (r.onsuccess) r.onsuccess({ target: r }); }); return r; }
        var wakes = {
            get: function(k) { return req(function() { return clone(data[k]); }); },
            put: function(v) { return req(function() { data[v.parentChatId] = clone(v); return v.parentChatId; }); },
            delete: function(k) { return req(function() { delete data[k]; }); },
            getAll: function() { return req(function() { return Object.keys(data).map(function(k) { return clone(data[k]); }); }); }
        };
        var sink = new Proxy({}, { get: function(t, p) { if (p === 'then') return undefined; return function() { return req(function() { return undefined; }); }; } });
        var idb = { transaction: function() { return { objectStore: function(n) { return n === 'pending_wakes' ? wakes : sink; } }; } };
        return { data: data, openDatabase: function() { return Promise.resolve(idb); } };
    }
    function tick() {
        return new Promise(function(r) {
            if (typeof MessageChannel !== 'function') { Promise.resolve().then(r); return; }
            var ch = new MessageChannel();
            ch.port1.onmessage = function() { ch.port1.close(); r(); };
            ch.port2.postMessage(0);
        });
    }
    async function flush() { for (var i = 0; i < 8; i++) { await Promise.resolve(); await tick(); } }

    test('_movePendingWake(O,N): O row deleted, notices land under N and N is drained (runAgent(N))', async function() {
        var db = fakeDb(), runs = [];
        var chats = { O: { messages: [], continuedTo: 'N' }, N: { messages: [], continuedFrom: 'O' } };
        var m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true }, console: quiet,
            chats: chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
            isChatPaused: function() { return false; },
            runAgent: function(id) { runs.push(id); return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); },
            openDatabase: db.openDatabase, pendingWakesStoreName: 'pending_wakes'
        }});
        db.data.O = { parentChatId: 'O', notices: [{ text: 'Sub-agent W reported (done):\nMOVED-NOTICE', at: Date.now() }], attempts: 0 };
        var moved = await m._movePendingWake('O', 'N');
        await flush();
        assert.strictEqual(moved, true, 'resolves true when a record moved');
        assert.ok(!db.data.O, 'old chat row deleted');
        assert.ok(!db.data.N || runs.indexOf('N') !== -1, 'N drained or a run started for N');
        assert.strictEqual(runs.indexOf('O'), -1, 'old chat never woken');
        assert.ok(chats.N.messages.some(function(r) { return r && r.role === 'user' && String(r.content).indexOf('MOVED-NOTICE') !== -1; }), 'notice delivered into the continuation');
        assert.strictEqual(await m._movePendingWake('O', 'N'), false, 'idempotent: nothing left to move');
    }, T);

    test('_movePendingWake dedupes by agent id + text (same text from two workers both kept)', async function() {
        var db = fakeDb(), puts = [];
        var idb = await db.openDatabase();
        var st = idb.transaction().objectStore('pending_wakes');
        var origPut = st.put;
        st.put = function(v) { puts.push(clone(v)); return origPut(v); };
        var chats = { O: { messages: [], continuedTo: 'N' }, N: { messages: [], continuedFrom: 'O' } };
        var m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true }, console: quiet,
            chats: chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
            isChatPaused: function() { return false; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); },
            openDatabase: db.openDatabase, pendingWakesStoreName: 'pending_wakes'
        }});
        db.data.N = { parentChatId: 'N', notices: [{ text: 'done', sub_id: 'w1', at: 1 }], attempts: 0 };
        db.data.O = { parentChatId: 'O', notices: [{ text: 'done', sub_id: 'w1', at: 2 }, { text: 'done', sub_id: 'w2', at: 3 }], attempts: 0 };
        assert.strictEqual(await m._movePendingWake('O', 'N'), true);
        var merged = puts.filter(function(p) { return p.parentChatId === 'N'; })[0];
        assert.ok(merged, 'merged row put under N');
        assert.deepStrictEqual(merged.notices.map(function(n) { return n.sub_id + ':' + n.text; }), ['w1:done', 'w2:done'],
            'same sub + text deduped; another sub with the same text kept');
        await flush();
    }, T);

    test('ui/250: a linSig change (continuedFrom>continuedTo) skips _tryIncrementalRender', async function() {
        var src = await loadFile('src/js/ui/250-message-render.js');
        var s = src.indexOf("    var _linSig = '';");
        var e = src.indexOf('    // During streaming, keep #streaming-text', s);
        assert.ok(s > 0 && e > s, 'could slice the linSig block from 250-message-render.js');
        // rg-b9 style: run the real slice with stubs for only the names it
        // touches. 'incremental' = the R1 fast path returned; 'full' = it fell
        // through to the full rebuild.
        var make = new Function('env', [
            'var chats = env.chats, currentChatId = env.cur, container = {}, isRunning = false, savedScrollTop = 0;',
            'var mappedParts = env.parts, mappedHtml = env.parts.join("");',
            'function renderLineageBanner(c, where) { return (c.continuedFrom || c.continuedTo) ? "[" + where + "]" : ""; }',
            'function _renderSig(p) { return p; }',
            'function _tryIncrementalRender() { env.incCalls++; return true; }',
            'return function() { var _lastRenderState = env.state;',
            src.slice(s, e),
            '  env.state = _lastRenderState; return "full"; };'
        ].join('\n'));
        var env = { chats: { A: { messages: [] } }, cur: 'A', parts: ['<p1>', '<p2>'], incCalls: 0, state: { chatId: 'A', count: 2, sigs: ['<p1>', '<p2>'], linSig: '>' } };
        function run() { var r = make(env)(); return r === undefined ? 'incremental' : r; }
        assert.strictEqual(run(), 'incremental', 'unchanged lineage keeps the R1 fast path');
        assert.strictEqual(env.incCalls, 1);
        env.chats.A.continuedTo = 'B';
        var before = env.incCalls;
        assert.strictEqual(run(), 'full', 'continuedTo stamped -> full rebuild');
        assert.strictEqual(env.incCalls, before, '_tryIncrementalRender not called on a linSig change');
        env.state = { chatId: 'A', count: 2, sigs: ['<p1>', '<p2>'], linSig: '>B' };
        assert.strictEqual(run(), 'incremental', 'same linSig again -> fast path');
        env.chats.A.continuedFrom = 'Z';
        before = env.incCalls;
        assert.strictEqual(run(), 'full', 'continuedFrom change -> full rebuild');
        assert.strictEqual(env.incCalls, before);
    }, T);

    test('worker/130: the SWM-S1 comment sits directly above _extractUnseenTrailingUserInput; file ends with a newline', async function() {
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var fi = src.indexOf('\nfunction _extractUnseenTrailingUserInput(');
        assert.ok(fi > 0, 'function present');
        var lines = src.slice(0, fi).split('\n');
        var i = lines.length - 1, block = [];
        while (i >= 0 && /^\/\//.test(lines[i])) { block.unshift(lines[i]); i--; }
        assert.ok(block.length > 0, 'a comment block directly precedes the function');
        assert.ok(/^\/\/ SWM-S1: extract the trailing user-input block/.test(block[0]), 'block starts with the SWM-S1 header, got: ' + block[0]);
        assert.ok(i < 0 || lines[i].trim() === '', 'comment block is preceded by a blank line');
        assert.strictEqual(src.charAt(src.length - 1), '\n', 'file ends with a newline');
    }, T);
});
