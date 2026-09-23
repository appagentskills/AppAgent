// Group A part 1 (core/097-sub-agent-registry.js): N1 load-merge + persist
// await/retry, A1/NEW-Z boot park / lost-report recovery / orphan notices,
// A2 paused / re-queue / post-boot _drainPool, woken_at guard. Real source via
// loadModules; globals stub only IDB/chrome/timers/runtime plumbing.
var T = { tags: ['unit'], timeout: 5000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
function tick(ms) { return new Promise(function(r) { setTimeout(r, ms || 5); }); }

function fakeDb(list, opts) {
    opts = opts || {};
    var st = { puts: [], throwLeft: opts.throwPut || 0, errName: opts.errName || 'InvalidStateError' };
    st.db = { transaction: function() {
        var tx = { error: null };
        tx.objectStore = function() { return {
            getAll: function() { var q = {}; setTimeout(function() { q.result = (list || []).slice(); if (q.onsuccess) q.onsuccess(); }, 0); return q; },
            get: function() { var q = {}; setTimeout(function() { q.result = undefined; if (q.onsuccess) q.onsuccess(); }, 0); return q; },
            put: function(r) {
                if (st.throwLeft > 0) { st.throwLeft--; var e = new Error('connection is closing'); e.name = st.errName; throw e; }
                st.puts.push(JSON.parse(JSON.stringify(r)));
                setTimeout(function() { if (tx.oncomplete) tx.oncomplete(); }, 0);
            },
            delete: function() { setTimeout(function() { if (tx.oncomplete) tx.oncomplete(); }, 0); }
        }; };
        return tx;
    } };
    return st;
}

async function load(o) {
    o = o || {};
    var env = { chats: o.chats || { root: { messages: [] } }, runs: [], released: 0, cp: o.cp || {} };
    env.idb = fakeDb(o.list, o.db);
    env.m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
        self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: o.worker !== false },
        chats: env.chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
        isChatPaused: function() { return false; },
        runAgent: function(cid) { env.runs.push(cid); return new Promise(function() {}); },
        saveChatsToStorage: function() { return Promise.resolve(); },
        openDatabase: function() { return Promise.resolve(env.idb.db); },
        releaseIdleDbConnection: function() { env.released++; },
        readAgentCheckpoint: function(cid) { return Promise.resolve(env.cp[cid] || null); },
        console: quiet
    }});
    return env;
}

function sub(env, extra) {
    var r = { agent_id: 'a1', chat_id: 'c_a1', name: 'W', state: 'running', parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now() - 60000 };
    for (var k in (extra || {})) r[k] = extra[k];
    env.m._subAgents[r.agent_id] = r;
    return r;
}
function reportRows(summary, id) {
    return [
        { role: 'assistant', content: '', tool_calls: [{ id: id, type: 'function', function: { name: 'report_to_parent', arguments: JSON.stringify({ status: 'done', summary: summary, data: { n: 1 } }) } }] },
        { role: 'tool', tool_call_id: id, name: 'report_to_parent', content: JSON.stringify({ success: true, ok: true }) }
    ];
}

describe('N1 registry persistence', function() {
    test('loadAll: in-memory record wins over the stale IDB row', async function() {
        var env = await load({ worker: false, list: [{ agent_id: 'a1', chat_id: 'c_a1', state: 'running', parent_chat_id: 'root' }] });
        var mem = sub(env, { state: 'sleeping', last_report: { status: 'done', summary: 'new', at: Date.now() } });
        await env.m.loadAllSubAgents();
        assert.strictEqual(env.m._subAgents.a1, mem, 'same object kept');
        assert.strictEqual(env.m._subAgents.a1.state, 'sleeping');
    }, T);
    test('_isLiveThisSession: reported/touched this session counts as live', async function() {
        var env = await load();
        assert.strictEqual(env.m._isLiveThisSession({ agent_id: 'x', last_report: { at: Date.now() + 1 } }), true);
        assert.strictEqual(env.m._isLiveThisSession({ agent_id: 'x', last_activity_at: Date.now() + 1 }), true);
        assert.strictEqual(env.m._isLiveThisSession({ agent_id: 'x', last_activity_at: 1, last_report: { at: 1 } }), false);
    }, T);
    test('_subAgentsPersist resolves true after commit; retries once on a dead connection with the CURRENT record', async function() {
        var env = await load({ db: { throwPut: 1 } });
        var r = sub(env, { summary_marker: 'old' });
        var p = env.m._subAgentsPersist({ agent_id: 'a1', summary_marker: 'snapshot' });
        r.summary_marker = 'current';
        assert.strictEqual(await p, true);
        assert.strictEqual(env.released, 1, 'cached connection dropped');
        assert.strictEqual(env.idb.puts.length, 1);
        assert.strictEqual(env.idb.puts[0].summary_marker, 'current', 'retry writes the in-memory record');
    }, T);
    test('_subAgentsPersist: non-retryable error and a failed retry resolve false (never reject)', async function() {
        var env = await load({ db: { throwPut: 1, errName: 'DataError' } });
        sub(env);
        assert.strictEqual(await env.m._subAgentsPersist(env.m._subAgents.a1), false);
        assert.strictEqual(env.released, 0, 'no retry for a non-connection error');
        var env2 = await load({ db: { throwPut: 2 } });
        sub(env2);
        assert.strictEqual(await env2.m._subAgentsPersist(env2.m._subAgents.a1), false);
        assert.strictEqual(env2.idb.puts.length, 0);
    }, T);
});

describe('A1 + NEW-Z boot orphan handling', function() {
    test('persisted report + paused checkpoint → parks sleeping with the report', async function() {
        var env = await load({ cp: { c_a1: { status: 'paused' } } });
        env.chats.c_a1 = { messages: [{ role: 'user', content: 'task' }] };
        var r = sub(env, { last_report: { status: 'done', summary: 'S', at: Date.now() - 1000 } });
        await env.m._resumeOrOrphanSubAtBoot(r);
        assert.strictEqual(r.state, 'sleeping');
        assert.strictEqual(r.last_report.summary, 'S');
    }, T);
    test('lost report is recovered from the sub transcript (tool_calls[].function.arguments)', async function() {
        var env = await load({ cp: { c_a1: { status: 'errored' } } });
        env.chats.c_a1 = { messages: [{ role: 'user', content: 'task' }].concat(reportRows('Recovered!', 't1')) };
        var r = sub(env);
        await env.m._resumeOrOrphanSubAtBoot(r);
        assert.strictEqual(r.state, 'sleeping');
        assert.strictEqual(r.last_report._recovered, true);
        assert.strictEqual(r.last_report.summary, 'Recovered!');
        assert.deepStrictEqual(r.last_report.data, { n: 1 });
        assert.strictEqual(r.report_collected, false);
    }, T);
    test('a failed report_to_parent row is not a report', async function() {
        var env = await load();
        assert.strictEqual(env.m._subToolResultOk(JSON.stringify({ success: false, error: 'x' })), false);
        assert.strictEqual(env.m._subToolResultOk(JSON.stringify({ success: true, already_settled: true })), false);
        assert.strictEqual(env.m._subToolResultOk('{"success":true,"ok":true}\n[note]'), true);
    }, T);
    test('no report, episode ran → errored + durable pending wake (not silent)', async function() {
        var env = await load({ cp: { c_a1: { status: 'errored' } } });
        env.chats.c_a1 = { messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'working' }] };
        var r = sub(env);
        assert.strictEqual(env.m._subBootDecideNonResumable(r, { status: 'errored' }), 'errored');
        assert.strictEqual(r.state, 'errored');
        assert.strictEqual(r.last_report._orphaned, true);
        assert.strictEqual(env.m._subNotifyParentOfBootOrphan(r), 'pending_wake');
    }, T);
    test('wake_parent:false → passive notice path; rehydrate (silent) still errors', async function() {
        var env = await load();
        var r = sub(env, { wake_parent: false });
        assert.strictEqual(env.m._subNotifyParentOfBootOrphan(r), 'passive');
        var r2 = sub(env, { agent_id: 'a2', chat_id: 'c_a2' });
        assert.strictEqual(env.m._orphanErrorSubAtBoot(r2, { silent: true }), 'errored');
        assert.strictEqual(r2.state, 'errored');
    }, T);
});

describe('A2 boot re-queue / paused', function() {
    test("'paused' checkpoint, episode ran, no report → stays running, no slot, not queued", async function() {
        var env = await load({ cp: { c_a1: { status: 'paused' } } });
        env.chats.c_a1 = { messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'mid' }] };
        var r = sub(env);
        await env.m._resumeOrOrphanSubAtBoot(r);
        assert.strictEqual(r.state, 'running');
        assert.strictEqual(env.m._subPool.queue.indexOf('a1'), -1);
        assert.ok(!env.m._subPool.running.a1);
    }, T);
    test('never started (no checkpoint, transcript ends on its user row) → re-queued; ran episode → errored', async function() {
        var env = await load();
        env.chats.c_a1 = { messages: [{ role: 'user', content: 'task' }] };
        var r = sub(env);
        await env.m._resumeOrOrphanSubAtBoot(r);
        assert.strictEqual(r.state, 'running');
        assert.ok(env.m._subPool.queue.indexOf('a1') >= 0, 'queued');
        env.chats.c_a2 = { messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'done, no report' }] };
        var r2 = sub(env, { agent_id: 'a2', chat_id: 'c_a2' });
        await env.m._resumeOrOrphanSubAtBoot(r2);
        assert.strictEqual(r2.state, 'errored', 'a finished episode is not replayed');
    }, T);
    test('retry-delayed sub is re-queued even with an errored checkpoint', async function() {
        var env = await load({ cp: { c_a1: { status: 'errored' } } });
        env.chats.c_a1 = { messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'x' }] };
        var r = sub(env);
        env.m._subBootRetryDelayed.a1 = true;
        await env.m._resumeOrOrphanSubAtBoot(r);
        assert.strictEqual(r.state, 'running');
        assert.ok(env.m._subPool.queue.indexOf('a1') >= 0);
    }, T);
    test('loadAll boot scan re-queues a never-started sub and drains the pool after the gate', async function() {
        var env = await load({ list: [{ agent_id: 'q1', chat_id: 'c_q1', name: 'Q', state: 'running', parent_chat_id: 'root', root_chat_id: 'root', created_at: 1, last_activity_at: 1 }] });
        env.chats.c_q1 = { messages: [{ role: 'user', content: 'task' }] };
        await env.m.loadAllSubAgents();
        await tick(30);
        assert.deepStrictEqual(env.runs, ['c_q1'], 'runAgent started once for the re-queued sub');
        assert.ok(env.m._subPool.running.q1, 'slot claimed by _drainPool');
    }, T);
});

describe('A1 woken_at guard', function() {
    test('a last_report older than woken_at is not reused', async function() {
        var env = await load();
        env.chats.c_a1 = { messages: [{ role: 'user', content: 'wake' }] };
        var r = sub(env, { woken_at: Date.now(), last_report: { status: 'done', summary: 'R1', at: Date.now() - 5000 } });
        assert.strictEqual(env.m._subBootRecoverableReport(r), null);
    }, T);
    test('pre-upgrade record (no woken_at): report before the last wake row → previous episode, not reused', async function() {
        var env = await load();
        env.chats.c_a1 = { messages: [{ role: 'user', content: 'task' }].concat(reportRows('R1', 't1'), [{ role: 'user', content: 'wake' }]) };
        var r = sub(env, { last_report: { status: 'done', summary: 'R1', at: 5 } });
        assert.strictEqual(env.m._subBootRecoverableReport(r), null);
        env.chats.c_a1.messages = [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'x' }];
        assert.strictEqual(env.m._subBootRecoverableReport(r), r.last_report, 'no earlier report → last_report still usable');
    }, T);
});
