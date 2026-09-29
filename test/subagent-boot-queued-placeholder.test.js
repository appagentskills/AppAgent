// #1038 (core/097-sub-agent-registry.js): a sub still QUEUED when the SW
// restarted must be re-queued at boot, not parked on the parent card's
// {status:'running', summary:''} spawn placeholder (which pre-settled the
// spawn handle 'done' with an empty summary). Real source via loadModules;
// globals stub only IDB/chrome/timers/runtime plumbing.
var T = { tags: ['unit'], timeout: 5000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
function tick(ms) { return new Promise(function(r) { setTimeout(r, ms || 5); }); }

function fakeDb(list) {
    var st = { puts: [] };
    st.db = { transaction: function() {
        var tx = { error: null };
        tx.objectStore = function() { return {
            getAll: function() { var q = {}; setTimeout(function() { q.result = (list || []).slice(); if (q.onsuccess) q.onsuccess(); }, 0); return q; },
            get: function() { var q = {}; setTimeout(function() { q.result = undefined; if (q.onsuccess) q.onsuccess(); }, 0); return q; },
            put: function(r) { st.puts.push(JSON.parse(JSON.stringify(r))); setTimeout(function() { if (tx.oncomplete) tx.oncomplete(); }, 0); },
            delete: function() { setTimeout(function() { if (tx.oncomplete) tx.oncomplete(); }, 0); }
        }; };
        return tx;
    } };
    return st;
}

async function load(o) {
    o = o || {};
    var env = { chats: o.chats || { root: { messages: [] } }, runs: [], cp: o.cp || {}, paused: {} };
    env.idb = fakeDb(o.list);
    env.m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
        self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
        chats: env.chats, pausedChats: env.paused, runningChatIds: {}, pendingInjectionsByChatId: {},
        isChatPaused: function() { return false; },
        runAgent: function(cid) { env.runs.push(cid); return new Promise(function() {}); },
        saveChatsToStorage: function() { return Promise.resolve(); },
        openDatabase: function() { return Promise.resolve(env.idb.db); },
        releaseIdleDbConnection: function() {},
        readAgentCheckpoint: function(cid) { return Promise.resolve(env.cp[cid] || null); },
        console: quiet
    }});
    return env;
}

// Parent card exactly as spawnSubAgent pushes it (running placeholder).
function placeholderCard(aid, at) {
    return { role: 'sub_report', subAgentId: aid, subChatId: 'c_' + aid, progress: [],
        report: { status: 'running', summary: '', from: aid, from_name: 'Q', at: at }, createdAt: at };
}
function queuedRec(extra) {
    var r = { agent_id: 'q1', chat_id: 'c_q1', name: 'Q', state: 'running', parent_chat_id: 'root', root_chat_id: 'root',
        spawn_handle_id: 'h_q1', created_at: 1000, last_activity_at: 1000 };
    for (var k in (extra || {})) r[k] = extra[k];
    return r;
}

describe('#1038 queued sub + card placeholder at boot', function() {
    test('card placeholder / running last_report are not recoverable reports', async function() {
        var env = await load();
        env.chats.root.messages.push(placeholderCard('q1', 2000));
        env.chats.c_q1 = { messages: [{ role: 'user', content: '## Task\n\nx' }] };
        var r = queuedRec();
        env.m._subAgents.q1 = r;
        assert.strictEqual(env.m._subBootRecoverableReport(r), null, 'card placeholder rejected');
        r.last_report = { status: 'running', summary: '', at: 3000, _recovered: true, _recovered_from: 'card' };
        assert.strictEqual(env.m._subBootRecoverableReport(r), null, 'persisted placeholder rejected');
        assert.strictEqual(env.m._subBootIsRealReport({ status: 'done' }), true);
        assert.strictEqual(env.m._subBootIsRealReport({ status: 'need_input' }), true);
        assert.strictEqual(env.m._subBootIsRealReport({ status: 'error' }), false);
        assert.strictEqual(env.m._subBootIsRealReport({ status: 'done', _synthesized: true }), false);
    }, T);

    test('queued sub, no checkpoint, card placeholder → requeued (not parked)', async function() {
        var env = await load();
        env.chats.root.messages.push(placeholderCard('q1', 2000));
        env.chats.c_q1 = { messages: [{ role: 'user', content: '## Task\n\nx' }] };
        var r = queuedRec();
        env.m._subAgents.q1 = r;
        assert.strictEqual(env.m._subBootDecideNonResumable(r, null), 'requeued');
        assert.strictEqual(r.state, 'running');
        assert.ok(env.m._subPool.queue.indexOf('q1') >= 0, 'queued');
        assert.ok(!r.last_report, 'no placeholder report persisted');
    }, T);

    test('loadAll boot: queued sub with card placeholder is started, handle stays pending', async function() {
        var env = await load({ list: [queuedRec()] });
        env.chats.root.messages.push(placeholderCard('q1', 2000));
        env.chats.c_q1 = { messages: [{ role: 'user', content: '## Task\n\nx' }] };
        await env.m.loadAllSubAgents();
        await tick(30);
        var r = env.m._subAgents.q1;
        assert.strictEqual(r.state, 'running');
        assert.deepStrictEqual(env.runs, ['c_q1'], 'runAgent started for the re-queued sub');
        assert.ok(env.m._spawnDeferreds.h_q1, 'spawn handle re-armed as pending (not pre-settled done)');
    }, T);

    test('self-heal: sleeping record parked on the placeholder by a pre-fix boot is re-queued', async function() {
        var broken = queuedRec({ state: 'sleeping', report_collected: false,
            last_report: { status: 'running', summary: '', from: 'q1', at: 2000, _recovered: true, _recovered_from: 'card' } });
        var env = await load({ list: [broken] });
        env.paused.c_q1 = true;
        env.chats.root.messages.push(placeholderCard('q1', 2000));
        env.chats.c_q1 = { messages: [{ role: 'user', content: '## Task\n\nx' }] };
        await env.m.loadAllSubAgents();
        await tick(30);
        var r = env.m._subAgents.q1;
        assert.strictEqual(r.state, 'running');
        assert.ok(!r.last_report, 'placeholder report dropped');
        assert.ok(!env.paused.c_q1, 'park pause flag cleared');
        assert.deepStrictEqual(env.runs, ['c_q1']);
        assert.ok(env.m._spawnDeferreds.h_q1, 'handle pending, not settled done');
    }, T);

    test('regression: a sub with a real done report is still parked with it', async function() {
        var env = await load({ cp: { c_q1: { status: 'paused' } } });
        env.chats.root.messages.push(placeholderCard('q1', 2000));
        env.chats.c_q1 = { messages: [{ role: 'user', content: '## Task\n\nx' }] };
        var r = queuedRec({ last_report: { status: 'done', summary: 'real', from: 'q1', at: 5000 } });
        env.m._subAgents.q1 = r;
        await env.m._resumeOrOrphanSubAtBoot(r);
        assert.strictEqual(r.state, 'sleeping');
        assert.strictEqual(r.last_report.summary, 'real');
        assert.strictEqual(env.m._subPool.queue.indexOf('q1'), -1, 'not re-queued');
    }, T);

    test('woken-then-sleep_self bug-parked record is NOT healed at boot (stays sleeping)', async function() {
        var rec = queuedRec({ state: 'sleeping', woken_at: 9000, last_activity_at: 9500,
            last_report: { status: 'running', summary: '', from: 'q1', at: 2000, _recovered: true, _recovered_from: 'card' } });
        var env = await load({ list: [rec] });
        env.chats.c_q1 = { messages: [{ role: 'user', content: 'task' }, { role: 'user', content: 'wake' }, { role: 'assistant', content: 'ok, sleeping' }] };
        assert.strictEqual(env.m._subBootIsPlaceholderPark(rec), false, 'woken after placeholder');
        await env.m.loadAllSubAgents();
        await tick(30);
        assert.strictEqual(env.m._subAgents.q1.state, 'sleeping');
        assert.deepStrictEqual(env.runs, [], 'not restarted');
        // queued wake bug-parked (placeholder at >= woken_at) still heals
        assert.strictEqual(env.m._subBootIsPlaceholderPark(queuedRec({ state: 'sleeping', woken_at: 3000,
            last_report: { status: 'running', at: 3000, _recovered_from: 'card' } })), true);
    }, T);

    test('sleep_self replaces a placeholder last_report with the synthetic sleep report', async function() {
        var env = await load();
        var r = queuedRec({ last_report: { status: 'running', summary: '', at: 2000, _recovered_from: 'card' } });
        env.m._subAgents.q1 = r;
        env.chats.c_q1 = { messages: [{ role: 'user', content: 'task' }], isSubAgent: true, subAgentId: 'q1' };
        env.m._spawnDeferreds.h_q1 = { resolve: function() {}, reject: function() {}, promise: new Promise(function() {}) };
        try { await env.m.sleepSelf({ reason: 'zz' }, { chatId: 'c_q1' }); } catch (_) { /* downstream plumbing */ }
        assert.strictEqual(r.last_report.status, 'need_input');
        assert.strictEqual(r.last_report._synthesized, true);
    }, T);

    test('regression: real need_input report still parks end-to-end at boot', async function() {
        var env = await load({ list: [queuedRec({ last_report: { status: 'need_input', summary: 'ask', from: 'q1', at: 5000 } })], cp: { c_q1: { status: 'paused' } } });
        env.chats.root.messages.push(placeholderCard('q1', 2000));
        env.chats.c_q1 = { messages: [{ role: 'user', content: 'task' }] };
        await env.m.loadAllSubAgents();
        await tick(30);
        var r = env.m._subAgents.q1;
        assert.strictEqual(r.state, 'sleeping');
        assert.strictEqual(r.last_report.status, 'need_input');
        assert.deepStrictEqual(env.runs, [], 'not re-queued');
        assert.ok(!env.m._spawnDeferreds.h_q1, 'handle pre-settled, not pending');
    }, T);

    test('regression: a real done report on the card (lost registry persist) still parks', async function() {
        var env = await load();
        var card = placeholderCard('q1', 2000);
        card.report = { status: 'done', summary: 'from card', from: 'q1', at: 6000 };
        env.chats.root.messages.push(card);
        env.chats.c_q1 = { messages: [{ role: 'user', content: '## Task\n\nx' }] };
        var r = queuedRec();
        env.m._subAgents.q1 = r;
        assert.strictEqual(env.m._subBootDecideNonResumable(r, null), 'parked');
        assert.strictEqual(r.state, 'sleeping');
        assert.strictEqual(r.last_report.summary, 'from card');
        assert.strictEqual(r.last_report._recovered_from, 'card');
    }, T);
});
