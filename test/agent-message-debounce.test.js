// C5 (PR #969 part 3): debounced idle-parent agent_message wakes (core/097)
// + the run-start cancel hook (app/030). Real sources via loadModules;
// globals stub only chrome/storage/IDB/timer plumbing (fake timers).
var T = { tags: ['unit'], timeout: 5000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
// Minimal pending_wakes IDB fake (get/put/delete/getAll, async onsuccess);
// every other store is a no-op sink.
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
async function flush() { for (var i = 0; i < 8; i++) await new Promise(function(r) { setTimeout(r, 0); }); }
function count(rows, sub) { return rows.filter(function(r) { return r && r.role === 'user' && typeof r.content === 'string' && r.content.indexOf(sub) !== -1; }).length; }
function mkEnv(shared) {
    shared = shared || {};
    return { chats: shared.chats || { root: { messages: [] }, c_kid: { isSubAgent: true, subAgentId: 'kid', messages: [] } },
        running: {}, pend: {}, runs: [], timers: [], cleared: [], db: shared.db || fakeDb() };
}
async function load(env) {
    return loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
        self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true }, console: quiet,
        chats: env.chats, pausedChats: {}, runningChatIds: env.running, pendingInjectionsByChatId: env.pend,
        isChatPaused: function() { return false; },
        runAgent: function(id) { env.runs.push(id); return Promise.resolve(); },
        saveChatsToStorage: function() { return Promise.resolve(); },
        openDatabase: env.db.openDatabase, pendingWakesStoreName: 'pending_wakes',
        setTimeout: function(fn, ms) { env.timers.push({ fn: fn, ms: ms }); return env.timers.length; },
        clearTimeout: function(id) { env.cleared.push(id); }
    }});
}
function kid(m) {
    var h = m.Handles.start('root', 'spawn_sub_agent', {}, 'kid', function() { return new Promise(function() {}); });
    var r = { agent_id: 'kid', chat_id: 'c_kid', name: 'Kid', state: 'running', spawn_handle_id: h.handleId, parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now() };
    m._subAgents.kid = r;
    return r;
}
function wakeTimers(env) { return env.timers.filter(function(t) { return t.ms === 20000; }); }
function msg(m, text) { return m.agentMessage({ to: 'parent', content: text }, { chatId: 'c_kid' }); }
function noticeTexts(env) { return ((env.db.data.root && env.db.data.root.notices) || []).map(function(n) { return n.text || ''; }); }

describe('C5 agent_message idle-parent wake debounce (core/097)', function() {
    test('2 idle messages in the window: rows + durable notices immediate, ONE run at fire, each drained once', async function() {
        var env = mkEnv(), m = await load(env); kid(m);
        assert.strictEqual(m.AGENT_MESSAGE_WAKE_DEBOUNCE_MS, 20000);
        assert.strictEqual(msg(m, 'first').success, true); await flush();
        assert.strictEqual(msg(m, 'second').success, true); await flush();
        var rows = env.chats.root.messages;
        assert.strictEqual(count(rows, 'sent a message: first'), 1);
        assert.strictEqual(count(rows, 'sent a message: second'), 1);
        assert.strictEqual(wakeTimers(env).length, 1, 'second message joins the open window');
        assert.strictEqual(env.runs.length, 0, 'no run inside the window');
        assert.strictEqual(noticeTexts(env).length, 2, 'both notices persisted immediately');
        await m.drainPendingWakes(); await flush();
        assert.strictEqual(env.runs.length, 0, 'heartbeat drain defers to the pending timer');
        wakeTimers(env)[0].fn(); await flush();
        assert.strictEqual(env.runs.join(','), 'root', 'exactly one wake run');
        assert.ok(!m._amDebounceTimers.root, 'timer entry consumed');
        assert.strictEqual(count(rows, 'sent a message: first'), 1);
        assert.strictEqual(count(rows, 'sent a message: second'), 1);
        rows.push({ role: 'assistant', content: 'ack both' });
        await m.drainPendingWakes(); await flush();
        assert.ok(!env.db.data.root, 'answered record cleared by the drain');
        assert.strictEqual(env.runs.length, 1, 'no extra run');
    }, T);
    test('final report inside the window: immediate run, timer cleared, all drained, no second run at fire', async function() {
        var env = mkEnv(), m = await load(env), rec = kid(m);
        msg(m, 'mid'); await flush();
        var t = wakeTimers(env); assert.strictEqual(t.length, 1);
        var tid = env.timers.indexOf(t[0]) + 1;
        assert.strictEqual(m._wakeParentOnReport(rec, { status: 'done', summary: 'fin' }, {}), true); await flush();
        assert.strictEqual(env.runs.join(','), 'root', 'report wake runs immediately');
        assert.ok(!m._amDebounceTimers.root, 'pending timer cancelled');
        assert.ok(env.cleared.indexOf(tid) !== -1, 'clearTimeout called on the debounce timer');
        t[0].fn(); await flush();
        assert.strictEqual(env.runs.length, 1, 'stale fire starts no second run');
        var rows = env.chats.root.messages;
        assert.strictEqual(count(rows, 'sent a message: mid'), 1);
        assert.strictEqual(count(rows, 'reported (done):\nfin'), 1);
        var nt = noticeTexts(env);
        assert.strictEqual(nt.filter(function(s) { return s.indexOf('sent a message: mid') !== -1; }).length, 1);
        assert.strictEqual(nt.filter(function(s) { return s.indexOf('reported (done):\nfin') !== -1; }).length, 1);
    }, T);
    test('RUNNING parent: unchanged live injection, no debounce timer, no run', async function() {
        var env = mkEnv(), m = await load(env); kid(m);
        env.running.root = true;
        msg(m, 'live'); await flush();
        assert.strictEqual(wakeTimers(env).length, 0);
        assert.ok(!m._amDebounceTimers.root);
        assert.ok(env.pend.root && env.pend.root.text.indexOf('sent a message: live') !== -1, 'queued for safe-point injection');
        assert.strictEqual(count(env.chats.root.messages, 'sent a message: live'), 0, 'no idle row');
        assert.strictEqual(env.runs.length, 0);
    }, T);
    test('parent became RUNNING before the fire: no second run, row stays for that run', async function() {
        var env = mkEnv(), m = await load(env); kid(m);
        msg(m, 'early'); await flush();
        env.running.root = true;
        wakeTimers(env)[0].fn(); await flush();
        assert.strictEqual(env.runs.length, 0);
        assert.ok(!m._amDebounceTimers.root);
        assert.strictEqual(count(env.chats.root.messages, 'sent a message: early'), 1);
    }, T);
    test('SW restart: timers lost, persisted wakes drain via drainPendingWakes (one run, no duplicate rows)', async function() {
        var env = mkEnv(), m1 = await load(env); kid(m1);
        msg(m1, 'a1'); await flush(); msg(m1, 'b2'); await flush();
        assert.strictEqual(env.runs.length, 0);
        var env2 = mkEnv({ chats: env.chats, db: env.db });
        var m2 = await load(env2); // fresh realm: same IDB + transcript, empty timer map
        assert.strictEqual(Object.keys(m2._amDebounceTimers).length, 0);
        await m2.drainPendingWakes(); await flush();
        assert.strictEqual(env2.runs.join(','), 'root', 'restart drain starts one run');
        var rows = env.chats.root.messages;
        assert.strictEqual(count(rows, 'sent a message: a1'), 1);
        assert.strictEqual(count(rows, 'sent a message: b2'), 1);
        assert.strictEqual(env.db.data.root.attempts, 1);
        rows.push({ role: 'assistant', content: 'done' });
        await m2.drainPendingWakes(); await flush();
        assert.ok(!env.db.data.root, 'record cleared once answered');
        assert.strictEqual(env2.runs.length, 1);
    }, T);
    test('deleting the parent (stopDescendantsOfChat) drops its pending timer', async function() {
        var env = mkEnv(), m = await load(env); kid(m);
        msg(m, 'bye'); await flush();
        assert.ok(m._amDebounceTimers.root);
        m.stopDescendantsOfChat('root', 'parent chat deleted');
        assert.ok(!m._amDebounceTimers.root);
        wakeTimers(env)[0].fn(); await flush();
        assert.strictEqual(env.runs.length, 0);
    }, T);
});

describe('C5 run-start cancel hook (app/030-agent-loop.js)', function() {
    test('runAgent cancels the pending debounced wake once it claims the chat; a refused run does not', async function() {
        var calls = [];
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), console: quiet,
            chats: { root: { messages: [] }, dead: { _deleted: true, messages: [] } }, runningChatIds: {}, currentChatId: null, lastApiError: null,
            AgentEvents: { emit: function(ev) { if (ev === 'runStarted') throw new Error('halt'); } },
            _cancelAgentMessageWake: function(id) { calls.push(id); return true; }
        }});
        var e1 = await m.runAgent('root').then(function() { return null; }, function(e) { return e; });
        assert.ok(e1, 'stubbed runStarted halts the run');
        assert.strictEqual(calls.join(','), 'root');
        await m.runAgent('dead').then(function() {}, function() {});
        assert.strictEqual(calls.join(','), 'root', 'tombstone refusal leaves the timer alone');
    }, T);
});
