// Group A part 2 (core/097-sub-agent-registry.js + ui/175-sub-agent-ui.js):
// stuck-worker signal (_subStuckSignal verdict, sweep latch + delivery,
// agent_status / Workers UI surfacing), N4/N2 stale-running exemption, A3
// halt + watchdog, NEW-W resume drain, N3 paused pending-wake TTL. Real source
// via loadModules; globals stub only IDB/chrome/timers/runtime plumbing.
var T = { tags: ['unit'], timeout: 5000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
var GRACE = 120000;
var CORE = ['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'];
var REG_ONLY = ['src/js/core/097-sub-agent-registry.js'];
function tick(ms) { return new Promise(function(r) { setTimeout(r, ms || 5); }); }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// Store-aware fake IDB (records keyed by parentChatId / agent_id); every
// pending-wake store name maps to the one 'wakes' bucket.
function fakeDb() {
    var st = { stores: {} };
    function bucket(name) {
        var n = /wake/i.test(String(name)) ? 'wakes' : String(name);
        return st.stores[n] || (st.stores[n] = {});
    }
    st.db = { transaction: function(names) {
        var tx = { error: null };
        tx.objectStore = function(name) {
            var b = bucket(name || [].concat(names)[0]);
            function req(result) {
                var q = {};
                setTimeout(function() { q.result = result; if (q.onsuccess) q.onsuccess(); if (tx.oncomplete) tx.oncomplete(); }, 0);
                return q;
            }
            return {
                get: function(k) { return req(clone(b[k])); },
                getAll: function() { return req(Object.keys(b).map(function(k) { return clone(b[k]); })); },
                put: function(r) { b[r.parentChatId || r.agent_id || r.id] = clone(r); return req(undefined); },
                delete: function(k) { delete b[k]; return req(undefined); }
            };
        };
        return tx;
    } };
    st.wakes = function() { return bucket('wakes'); };
    return st;
}

// Handles stub for the registry-only loads: list/cancel observable, any other
// method a no-op.
function stubHandles(entries, cancelled) {
    var base = {
        list: function() { return entries.slice(); },
        cancel: function(cid, h, why) { cancelled.push([cid, h, why]); return true; }
    };
    return new Proxy(base, { get: function(t, k) {
        if (k in t) return t[k];
        if (typeof k !== 'string' || k === 'then' || k === 'toJSON') return undefined;
        return function() { return null; };
    } });
}

async function load(o) {
    o = o || {};
    var env = { chats: o.chats || { root: { messages: [] } }, runs: [], timers: [], pending: {}, paused: {}, running: {}, self: {} };
    env.idb = fakeDb();
    var realSetTimeout = setTimeout;
    var g = {
        self: env.self, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: o.worker !== false },
        chats: env.chats, pausedChats: env.paused, runningChatIds: env.running, pendingInjectionsByChatId: env.pending,
        isChatPaused: o.isChatPaused || function() { return false; },
        runAgent: function(cid) { env.runs.push(cid); return new Promise(function() {}); },
        saveChatsToStorage: function() { return Promise.resolve(); },
        openDatabase: function() { return Promise.resolve(env.idb.db); },
        releaseIdleDbConnection: function() {},
        readAgentCheckpoint: function() { return Promise.resolve(null); },
        pendingWakesStoreName: 'sub_agent_pending_wakes',
        console: quiet
    };
    // Capture only the 15 s halt watchdog; everything else runs for real.
    if (o.timers) g.setTimeout = function(fn, ms) { if (ms === 15000) { env.timers.push(fn); return 0; } return realSetTimeout(fn, ms); };
    var extra = o.globals || {};
    for (var k in extra) g[k] = extra[k];
    env.m = await loadModules(o.files || CORE, { lenient: true, globals: g });
    return env;
}

function sub(env, extra) {
    var r = { agent_id: 'a1', chat_id: 'c_a1', name: 'W', state: 'running', parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now() - 60000, last_activity_at: Date.now() };
    for (var k in (extra || {})) r[k] = extra[k];
    env.m._subAgents[r.agent_id] = r;
    if (!env.chats[r.chat_id]) env.chats[r.chat_id] = { isSubAgent: true, subAgentId: r.agent_id, isBackground: true, messages: [{ role: 'user', content: 'task' }] };
    return r;
}
function rowsWith(env, needle, pcid) {
    return (env.chats[pcid || 'root'].messages || []).filter(function(m) { return JSON.stringify(m).indexOf(needle) !== -1; }).length;
}
function deferred(settled) {
    return { resolve: function(p) { settled.push(p); }, reject: function(e) { settled.push(e); }, promise: new Promise(function() {}) };
}

describe('stuck verdict (_subStuckSignal)', function() {
    test('each reason, first-match order, only while running', async function() {
        var env = await load();
        var S = env.m._subStuckSignal;
        var now = Date.now();
        function R(extra) { var r = { state: 'running', created_at: now - 10 * GRACE }; for (var k in extra) r[k] = extra[k]; return r; }
        var report = { status: 'done', summary: 'S', at: now - GRACE - 1 };
        var card = { state: 'done', label: 'x', at: now - GRACE - 1 };
        assert.strictEqual(env.m.SUB_STUCK_GRACE_MS, GRACE);
        assert.strictEqual(S(R({}), now), null, 'healthy');
        var a = S(R({ awaiting_approval: { tool: 'servicenow_api', since: now - GRACE - 5 } }), now);
        assert.deepStrictEqual([a.reason, a.tool, a.since_ms], ['awaiting_approval', 'servicenow_api', GRACE + 5]);
        assert.strictEqual(S(R({ awaiting_approval: { tool: 'servicenow_api', since: now - 5 } }), now), null, 'fresh approval: within the grace');
        assert.strictEqual(S(R({ _pending_approvals: 1 }), now), null, '_pending_approvals alone: unknown start, not past the grace');
        var rb = S(R({ last_report: report }), now);
        assert.deepStrictEqual([rb.reason, rb.status, rb.since, rb.since_ms], ['reported_but_running', 'done', report.at, GRACE + 1]);
        var tc = S(R({ action_state: card }), now);
        assert.deepStrictEqual([tc.reason, tc.card_state, tc.since_ms], ['terminal_card_but_running', 'done', GRACE + 1]);
        assert.strictEqual(S(R({ _pending_approvals: 1, awaiting_approval: { tool: 't', since: now - GRACE - 1 }, last_report: report, action_state: card }), now).reason, 'awaiting_approval', 'approval past the grace wins');
        assert.strictEqual(S(R({ _pending_approvals: 1, awaiting_approval: { tool: 't', since: now }, last_report: report, action_state: card }), now).reason, 'reported_but_running', 'approval within the grace falls through');
        assert.strictEqual(S(R({ last_report: report, action_state: card }), now).reason, 'reported_but_running', 'report beats card');
        ['sleeping', 'stopped', 'errored', 'queued'].forEach(function(s) {
            assert.strictEqual(S(R({ state: s, _pending_approvals: 1, last_report: report, action_state: card }), now), null, s + ' is never stuck');
        });
    }, T);

    test('grace boundary: exactly 120000 ms is not stuck, +1 ms is; approval has the same grace', async function() {
        var env = await load();
        var S = env.m._subStuckSignal;
        var now = Date.now();
        function R(extra) { var r = { state: 'running', created_at: now - 10 * GRACE }; for (var k in extra) r[k] = extra[k]; return r; }
        assert.strictEqual(S(R({ last_report: { status: 'done', at: now - GRACE } }), now), null);
        assert.strictEqual(S(R({ last_report: { status: 'done', at: now - GRACE - 1 } }), now).reason, 'reported_but_running');
        assert.strictEqual(S(R({ action_state: { state: 'finished', at: now - GRACE } }), now), null);
        assert.strictEqual(S(R({ action_state: { state: 'finished', at: now - GRACE - 1 } }), now).reason, 'terminal_card_but_running');
        assert.strictEqual(S(R({ awaiting_approval: { tool: 't', since: now } }), now), null, 'approval at 0 ms');
        assert.strictEqual(S(R({ _pending_approvals: 1, awaiting_approval: { tool: 't', since: now - GRACE } }), now), null, 'approval at exactly the grace');
        var ap = S(R({ _pending_approvals: 1, awaiting_approval: { tool: 't', since: now - GRACE - 1 } }), now);
        assert.strictEqual(ap.reason, 'awaiting_approval');
        assert.strictEqual(ap.since_ms, GRACE + 1);
    }, T);

    test('stale evidence is ignored: orphaned / pre-wake report, previous-episode or non-terminal card', async function() {
        var env = await load();
        var S = env.m._subStuckSignal;
        var now = Date.now();
        var old = now - 5 * GRACE;
        function R(extra) { var r = { state: 'running', created_at: now - 10 * GRACE }; for (var k in extra) r[k] = extra[k]; return r; }
        assert.strictEqual(S(R({ last_report: { status: 'error', at: old, _orphaned: true } }), now), null, 'orphaned');
        assert.strictEqual(S(R({ woken_at: old + 1, last_report: { status: 'done', at: old } }), now), null, 'report older than the last wake');
        assert.strictEqual(S(R({ woken_at: old + 1, action_state: { state: 'done', at: old } }), now), null, 'card from a previous episode');
        assert.strictEqual(S(R({ action_state: { state: 'running', at: old } }), now), null, 'non-terminal card');
        assert.strictEqual(S(R({ woken_at: old, action_state: { state: 'pr_opened', at: old } }), now).reason, 'terminal_card_but_running', 'card set at the episode start counts');
    }, T);
});

describe('stuck sweep delivery', function() {
    test('notifies once per reason per episode; a wake starts a fresh latch', async function() {
        var env = await load();
        var now = Date.now();
        var RB = 'appears STUCK (reported_but_running)';
        var LR = { status: 'done', summary: 'S', at: now - GRACE - 1 };
        var r = sub(env, { spawn_handle_id: 'h_spawn', created_at: now - 10 * GRACE, last_report: LR });
        assert.strictEqual(env.m._sweepStuckSignal(r, now).reason, 'reported_but_running');
        assert.deepStrictEqual(r.stuck, { reason: 'reported_but_running', since: LR.at });
        assert.strictEqual(rowsWith(env, RB), 1, 'one lifecycle notice in the parent');
        await tick(10);
        assert.deepStrictEqual(env.runs, ['root'], 'idle parent woken');
        env.m._sweepStuckSignal(r, now + 60000);
        assert.strictEqual(rowsWith(env, RB), 1, 'latched');
        r.last_report = null;
        assert.strictEqual(env.m._sweepStuckSignal(r, now + 70000), null);
        assert.strictEqual(r.stuck, undefined, 'stamp cleared with the signal');
        r.last_report = LR;
        env.m._sweepStuckSignal(r, now + 80000);
        assert.strictEqual(r.stuck.reason, 'reported_but_running');
        assert.strictEqual(rowsWith(env, RB), 1, 'a re-appearing signal stays latched this episode');
        r._pending_approvals = 1;
        r.awaiting_approval = { tool: 'x', since: now + 90000 };
        env.m._sweepStuckSignal(r, now + 90000 + 60000);
        assert.strictEqual(rowsWith(env, 'appears STUCK (awaiting_approval)'), 0, 'within the grace: no approval notice');
        env.m._sweepStuckSignal(r, now + 90000 + GRACE + 1);
        assert.strictEqual(rowsWith(env, 'appears STUCK (awaiting_approval)'), 1, 'past the grace: a new reason notifies');
        r._pending_approvals = 0;
        r.awaiting_approval = null;
        // A wake is a new episode: latch, stamp and halt marker are dropped.
        r.state = 'sleeping';
        r._halt_at = 123;
        env.m._wakeSubAgentImpl({ agent_id: 'a1', instruction: 'next step' }, null, true);
        assert.strictEqual(typeof r.woken_at, 'number');
        assert.strictEqual(r._stuck_notified, undefined);
        assert.strictEqual(r.stuck, undefined);
        assert.strictEqual(r._halt_at, undefined);
        r.state = 'running';
        r.last_report = { status: 'done', summary: 'S2', at: r.woken_at + 1 };
        env.m._sweepStuckSignal(r, r.woken_at + 1 + GRACE + 1);
        assert.strictEqual(rowsWith(env, RB), 2, 'the new episode notifies again');
    }, T);

    test('wake_parent:false: one passive need_input row, no wake, no durable pending wake', async function() {
        var env = await load();
        var now = Date.now();
        var r = sub(env, { wake_parent: false, created_at: now - 10 * GRACE, action_state: { state: 'done', at: now - GRACE - 1 } });
        env.m._sweepStuckSignal(r, now);
        env.m._sweepStuckSignal(r, now + 60000);
        await tick(20);
        var rows = env.chats.root.messages.filter(function(m) { return m.role === 'sub_msg' && m.kind === 'passive_report'; });
        assert.strictEqual(rows.length, 1, 'one passive row (latched)');
        assert.strictEqual(rows[0].status, 'need_input');
        assert.ok(/STUCK/.test(rows[0].text), String(rows[0].text));
        assert.strictEqual(rowsWith(env, '[sub-agent lifecycle]'), 0, 'no model-visible notice');
        assert.strictEqual(env.runs.length, 0, 'parent not woken');
        assert.strictEqual(env.idb.wakes().root, undefined, 'no durable pending wake');
        assert.strictEqual(r.stuck.reason, 'terminal_card_but_running');
    }, T);

    test('the synthetic stuck report settles nothing: spawn handle, last_report, state untouched (idle + live parent)', async function() {
        var env = await load();
        var now = Date.now();
        var settled = [];
        var LR = { status: 'done', summary: 'real report', from: 'a1', at: now - GRACE - 1 };
        var snapshot = JSON.stringify(LR);
        var r = sub(env, { spawn_handle_id: 'h_spawn', pending_handles: ['h_spawn'], report_collected: false, created_at: now - 10 * GRACE, last_report: LR });
        env.m._spawnDeferreds.h_spawn = deferred(settled);
        env.m._sweepStuckSignal(r, now);
        await tick(20);
        assert.strictEqual(rowsWith(env, 'appears STUCK (reported_but_running)'), 1, 'notice delivered (idle parent)');
        assert.deepStrictEqual(env.runs, ['root']);
        assert.strictEqual(settled.length, 0, 'spawn handle not settled');
        assert.ok(env.m._spawnDeferreds.h_spawn, 'spawn deferred still armed');
        assert.strictEqual(r.last_report, LR, 'last_report not replaced');
        assert.strictEqual(JSON.stringify(r.last_report), snapshot, 'last_report not mutated');
        assert.strictEqual(r.state, 'running');
        assert.ok(!r.settled_at, 'not settled');
        assert.strictEqual(r.report_collected, false);
        assert.deepStrictEqual(r.pending_handles, ['h_spawn']);
        assert.strictEqual(env.m._subStuckSignal(r, now + 5 * GRACE).since, LR.at, 'the signal does not feed itself');
        // Live parent: the lifecycle notice is queued for the running loop.
        env.running.root = true;
        var r2 = sub(env, { agent_id: 'a2', chat_id: 'c_a2', spawn_handle_id: 'h2', pending_handles: ['h2'], created_at: now - 10 * GRACE, action_state: { state: 'done', at: now - GRACE - 1 } });
        env.m._spawnDeferreds.h2 = deferred(settled);
        env.m._sweepStuckSignal(r2, now);
        await tick(20);
        assert.ok(JSON.stringify(env.pending.root || null).indexOf('appears STUCK (terminal_card_but_running)') !== -1, 'queued for the live parent');
        assert.strictEqual(settled.length, 0);
        assert.ok(env.m._spawnDeferreds.h2);
        assert.strictEqual(r2.last_report, undefined, 'no report fabricated');
        assert.strictEqual(r2.state, 'running');
        assert.deepStrictEqual(env.runs, ['root'], 'no extra run while the parent is live');
    }, T);

    test('_idleSweepTick stamps rec.stuck in the authoritative context only; clears it once not running', async function() {
        var env = await load();
        var now = Date.now();
        var r = sub(env, { created_at: now - 10 * GRACE, last_report: { status: 'done', summary: 'S', at: now - GRACE - 1000 } });
        env.m._idleSweepTick();
        assert.strictEqual(r.stuck && r.stuck.reason, 'reported_but_running');
        assert.strictEqual(rowsWith(env, 'appears STUCK (reported_but_running)'), 1);
        r.state = 'sleeping';
        env.m._idleSweepTick();
        assert.strictEqual(r.stuck, undefined, 'cleared once no longer running');
        var page = await load({ worker: false });
        var p = sub(page, { created_at: now - 10 * GRACE, last_report: { status: 'done', summary: 'S', at: now - GRACE - 1000 } });
        page.m._idleSweepTick();
        assert.strictEqual(p.stuck, undefined, 'page mirror never stamps');
        assert.strictEqual(rowsWith(page, 'appears STUCK'), 0);
    }, T);
});

describe('stuck surfacing: agent_status + Workers UI', function() {
    test('agent_status carries stuck {reason, since_ms} in single, verbose and compact shapes; absent when healthy', async function() {
        var env = await load();
        var now = Date.now();
        var r = sub(env, { created_at: now - 10 * GRACE, last_report: { status: 'done', summary: 'S', at: now - GRACE - 5000 } });
        var one = env.m.agentStatus({ agent_id: 'a1' }, { chatId: 'root' });
        assert.strictEqual(one.agent.stuck.reason, 'reported_but_running');
        assert.ok(one.agent.stuck.since_ms >= GRACE + 5000);
        var verbose = env.m.agentStatus({ verbose: true }, { chatId: 'root' });
        assert.strictEqual(verbose.agents[0].stuck.reason, 'reported_but_running');
        var compact = env.m.agentStatus({}, { chatId: 'root' });
        assert.strictEqual(compact.agents[0].stuck.reason, 'reported_but_running');
        assert.deepStrictEqual(Object.keys(compact.agents[0].stuck).sort(), ['reason', 'since_ms']);
        r.last_report.at = Date.now();
        assert.strictEqual('stuck' in env.m.agentStatus({ agent_id: 'a1' }, { chatId: 'root' }).agent, false);
        assert.strictEqual('stuck' in env.m.agentStatus({}, { chatId: 'root' }).agents[0], false);
        var SA = env.m.SubAgents || env.self.SubAgents;
        assert.strictEqual(SA.stuckSignal, env.m._subStuckSignal);
        assert.strictEqual(SA.drainPendingWakesForChat, env.m._drainPendingWakesForChat);
    }, T);

    test('Workers UI: _subActivityInfo / _subActivityKey show the core verdict reason', async function() {
        var core = await load();
        var ui = await loadModules(['src/js/ui/175-sub-agent-ui.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), console: quiet, _subStuckSignal: core.m._subStuckSignal,
            UI_ICONS: new Proxy({}, { get: function(t, k) { return typeof k !== 'string' ? undefined : (k === 'alert' ? 'ICON_ALERT' : '<i data-i="' + k + '"></i>'); } }),
            getToolIcon: function(t) { return 'TI:' + t; }
        } });
        var now = Date.now();
        var rec = { state: 'running', created_at: now - 10 * GRACE, last_report: { status: 'done', at: now - GRACE - 1000 }, activity: { phase: 'tool', tool: 'web_fetch' } };
        var info = ui._subActivityInfo(rec);
        assert.deepStrictEqual([info.phase, info.reason, info.label, info.icon], ['stuck', 'reported_but_running', 'stuck: reported_but_running', 'ICON_ALERT']);
        assert.strictEqual(info.reason, core.m._subStuckSignal(rec, Date.now()).reason, 'same verdict as agent_status');
        assert.strictEqual(ui._subActivityKey(rec), 'stuck:reported_but_running');
        var ok = { state: 'running', created_at: now, activity: { phase: 'tool', tool: 'web_fetch' } };
        assert.strictEqual(ui._subActivityInfo(ok).phase, 'tool');
        assert.strictEqual(ui._subActivityKey(ok), 'tool:web_fetch', 'legacy key unchanged');
        assert.strictEqual(ui._subActivityInfo({ state: 'sleeping', stuck: { reason: 'awaiting_approval' }, activity: ok.activity }), null);
    }, T);

    test('Workers UI falls back to the SW-stamped rec.stuck when the core verdict is unavailable', async function() {
        var ui = await loadModules(['src/js/ui/175-sub-agent-ui.js'], { lenient: true, globals: { self: {}, window: fakeWindow(), console: quiet } });
        var info = ui._subActivityInfo({ state: 'running', stuck: { reason: 'awaiting_approval', since: 1 } });
        assert.strictEqual(info.phase, 'stuck');
        assert.strictEqual(info.label, 'stuck: awaiting_approval');
        assert.strictEqual(ui._subActivityKey({ state: 'running', stuck: { reason: 'awaiting_approval', since: 1 } }), 'stuck:awaiting_approval');
        assert.strictEqual(ui._subActivityInfo({ state: 'running' }), null, 'no activity, not stuck');
    }, T);
});

describe('N4/N2 stale-running exemption', function() {
    test('parked-for-await and approval-waiting subs are never reclaimed as stale; an idle one is', async function() {
        var env = await load();
        var TTL = env.m.SUBAGENT_RUNNING_TTL_MS || 2 * 3600 * 1000;
        var old = Date.now() - TTL - 60000;
        var a = sub(env, { agent_id: 'a1', chat_id: 'c_a1', created_at: old, last_activity_at: old, _parked_for_await: true });
        var b = sub(env, { agent_id: 'a2', chat_id: 'c_a2', created_at: old, last_activity_at: old, awaiting_approval: { tool: 'x', since: old } });
        var c = sub(env, { agent_id: 'a3', chat_id: 'c_a3', created_at: old, last_activity_at: old, _pending_approvals: 2 });
        var d = sub(env, { agent_id: 'a4', chat_id: 'c_a4', created_at: old, last_activity_at: old, _retry_used: true });
        env.m._idleSweepTick();
        assert.deepStrictEqual([a.state, b.state, c.state], ['running', 'running', 'running']);
        assert.strictEqual(d.state, 'errored', 'control is reclaimed');
        assert.strictEqual(d.last_report._stale_running, true);
        assert.strictEqual(b.stuck.reason, 'awaiting_approval', 'surfaced as stuck instead');
    }, T);
});

describe('A3 halt a live loop', function() {
    test('_haltSubLoop: pause flag, resolvers, stream abort; pending handles cancelled except the spawn handle', async function() {
        var calls = { backoff: 0, interrupt: 0, abort: 0 };
        var cancelled = [];
        var backoff = { c_a1: function() { calls.backoff++; } };
        var env = await load({ timers: true, files: REG_ONLY, globals: {
            Handles: stubHandles([{ handle: 'h_spawn', status: 'pending' }, { handle: 'h_bg', status: 'pending' }, { handle: 'h_old', status: 'done' }], cancelled),
            providerChangeBackoffResolversByChatId: backoff,
            interruptResolversByChatId: { c_a1: function() { calls.interrupt++; } },
            currentStreamAbortControllers: { c_a1: { abort: function() { calls.abort++; } } }
        } });
        var r = sub(env, { spawn_handle_id: 'h_spawn', state: 'stopped' });
        env.running.c_a1 = true;
        var armed = env.timers.length;
        env.m._haltSubLoop(r, 'stopped by parent');
        assert.strictEqual(env.paused.c_a1, true, 'loop told to stand down');
        assert.deepStrictEqual(calls, { backoff: 1, interrupt: 1, abort: 1 });
        assert.strictEqual(backoff.c_a1, undefined, 'backoff resolver consumed');
        assert.deepStrictEqual(cancelled, [['c_a1', 'h_bg', 'stopped by parent']]);
        assert.strictEqual(env.running.c_a1, true, 'runningChatIds left to the unwinding loop');
        assert.strictEqual(typeof r._halt_at, 'number');
        assert.strictEqual(env.timers.length, armed + 1, 'watchdog armed');
    }, T);

    test('watchdog force-clears runningChatIds only while the SAME halt still stands', async function() {
        var env = await load({ timers: true, files: REG_ONLY, globals: { Handles: stubHandles([], []) } });
        assert.strictEqual(env.m.SUB_HALT_WATCHDOG_MS, 15000);
        var r = sub(env, { state: 'stopped' });
        function halt() { env.running.c_a1 = true; env.m._haltSubLoop(r, 'x'); return env.timers[env.timers.length - 1]; }
        halt()();
        assert.strictEqual(env.running.c_a1, undefined, 'loop never unwound -> cleared');
        var fire = halt();
        r._halt_at = r._halt_at + 1;
        fire();
        assert.strictEqual(env.running.c_a1, true, 're-halted since -> kept');
        fire = halt();
        delete r._halt_at;
        fire();
        assert.strictEqual(env.running.c_a1, true, 'woken/resurrected (marker dropped) -> kept');
        fire = halt();
        r.state = 'running';
        fire();
        assert.strictEqual(env.running.c_a1, true, 'record running again -> kept');
        r.state = 'errored';
        delete env.running.c_a1;
        delete r._halt_at;
        var n = env.timers.length;
        env.m._haltSubLoop(r, 'idle');
        assert.strictEqual(env.timers.length, n, 'no live loop -> no watchdog');
        assert.strictEqual(r._halt_at, undefined);
    }, T);

    test('_markErrored halts the live loop (abort + pause) and never cancels the spawn handle', async function() {
        var aborts = 0;
        var cancelled = [];
        var env = await load({ timers: true, files: REG_ONLY, globals: {
            Handles: stubHandles([{ handle: 'h_spawn', status: 'pending' }, { handle: 'h_bg', status: 'pending' }], cancelled),
            currentStreamAbortControllers: { c_a1: { abort: function() { aborts++; } } }
        } });
        var r = sub(env, { spawn_handle_id: 'h_spawn', _retry_used: true });
        env.running.c_a1 = true;
        env.m._markErrored('a1', 'boom');
        assert.strictEqual(r.state, 'errored');
        assert.strictEqual(aborts, 1, 'stream aborted');
        assert.strictEqual(env.paused.c_a1, true);
        assert.ok(cancelled.some(function(c) { return c[1] === 'h_bg'; }), 'side handle cancelled');
        assert.ok(cancelled.every(function(c) { return c[1] !== 'h_spawn'; }), 'spawn handle left to the settle');
    }, T);
});

describe('NEW-W resume delivers parked wakes', function() {
    test('resumeDescendantsOfChat drains the parent durable wake at once (SW)', async function() {
        var env = await load();
        env.idb.wakes().root = { parentChatId: 'root', notices: [{ text: 'NOTICE-X from W', sub_id: 'a1', at: 1 }], attempts: 0 };
        env.m.resumeDescendantsOfChat('root');
        await tick(40);
        assert.strictEqual(rowsWith(env, 'NOTICE-X from W'), 1, 'row pushed');
        assert.deepStrictEqual(env.runs, ['root'], 'parent run started');
    }, T);

    test('no drain from the page mirror or before chats are hydrated', async function() {
        var variants = [{ worker: false }, { globals: { _chatsHydrated: false } }];
        for (var i = 0; i < variants.length; i++) {
            var env = await load(variants[i]);
            env.idb.wakes().root = { parentChatId: 'root', notices: [{ text: 'NOTICE-Y', sub_id: 'a1', at: 1 }], attempts: 0 };
            env.m.resumeDescendantsOfChat('root');
            await tick(30);
            assert.strictEqual(rowsWith(env, 'NOTICE-Y'), 0, 'variant ' + i);
            assert.strictEqual(env.runs.length, 0, 'variant ' + i);
            assert.ok(env.idb.wakes().root, 'record kept for the heartbeat drain (variant ' + i + ')');
        }
    }, T);
});

describe('N3 paused pending-wake TTL', function() {
    test('a paused parent stamps pausedSince once, keeps the record inside 24 h, drops it after', async function() {
        var env = await load({ isChatPaused: function() { return true; } });
        var W = env.idb.wakes();
        var TTL = env.m.PENDING_WAKE_PAUSED_TTL_MS;
        assert.strictEqual(TTL, 24 * 60 * 60 * 1000);
        W.root = { parentChatId: 'root', notices: [{ text: 'N-PAUSED', sub_id: 'a1', at: 1 }], attempts: 0 };
        var t0 = Date.now();
        await env.m._drainOnePendingWake(clone(W.root));
        assert.ok(W.root.pausedSince >= t0, 'stamped');
        var stamp = W.root.pausedSince;
        await env.m._drainOnePendingWake(clone(W.root));
        assert.strictEqual(W.root.pausedSince, stamp, 'stamped once');
        W.root.pausedSince = Date.now() - TTL + 60000;
        await env.m._drainOnePendingWake(clone(W.root));
        assert.ok(W.root, 'kept inside the TTL');
        W.root.pausedSince = Date.now() - TTL - 1;
        await env.m._drainOnePendingWake(clone(W.root));
        assert.strictEqual(W.root, undefined, 'expired record cleared');
        assert.strictEqual(env.runs.length, 0, 'paused parent never started');
        assert.strictEqual(rowsWith(env, 'N-PAUSED'), 0, 'nothing injected while paused');
    }, T);

    test('_bumpPendingWakeAttempts clears pausedSince (a delivery attempt means not paused)', async function() {
        var env = await load();
        var W = env.idb.wakes();
        W.root = { parentChatId: 'root', notices: [], attempts: 2, pausedSince: 123 };
        await env.m._bumpPendingWakeAttempts('root');
        assert.strictEqual(W.root.attempts, 3);
        assert.strictEqual('pausedSince' in W.root, false);
    }, T);
});

describe('#971 review fixes (B1 / M1 / M2 / B2 / pausedChats)', function() {
    test('M1: a pending approval neither notifies nor wakes the parent inside the grace; once past it', async function() {
        var env = await load();
        var now = Date.now();
        var AP = 'appears STUCK (awaiting_approval)';
        var r = sub(env, { created_at: now - 10 * GRACE, _pending_approvals: 1, awaiting_approval: { tool: 'servicenow_api', since: now } });
        assert.strictEqual(env.m._sweepStuckSignal(r, now + 60000), null, 'a 60 s sweep tick: not stuck');
        assert.strictEqual(r.stuck, undefined);
        await tick(10);
        assert.strictEqual(rowsWith(env, AP), 0);
        assert.deepStrictEqual(env.runs, [], 'idle parent not woken');
        assert.strictEqual(env.m._sweepStuckSignal(r, now + GRACE + 1).reason, 'awaiting_approval');
        assert.strictEqual(rowsWith(env, AP), 1, 'one notice past the grace');
        await tick(10);
        assert.deepStrictEqual(env.runs, ['root'], 'idle parent woken once');
    }, T);

    test('B1: a user message restarting a sleeping sub starts a new episode (woken_at, stuck + latch reset)', async function() {
        var env = await load();
        var t0 = Date.now() - 10 * GRACE;
        var r = sub(env, { state: 'sleeping', created_at: t0, woken_at: t0, spawn_handle_id: 'h_old',
            last_report: { status: 'done', summary: 'OLD', at: t0 + 1000 },
            stuck: { reason: 'reported_but_running', since: t0 + 1000 },
            _stuck_notified: { episode: t0, reasons: { terminal_card_but_running: t0 + 5000 } } });
        var before = Date.now();
        assert.strictEqual(env.m.onUserMessageToSubChat('c_a1'), true);
        assert.strictEqual(r.state, 'running');
        assert.ok(r.woken_at >= before, 'new episode stamped');
        assert.strictEqual(r.stuck, undefined, 'stuck stamp reset');
        assert.strictEqual(r._stuck_notified, undefined, 'stuck latch reset');
        var later = r.woken_at + GRACE + 10;
        assert.strictEqual(env.m._subStuckSignal(r, later), null, 'the previous report is not this episode\'s');
        assert.strictEqual(env.m._sweepStuckSignal(r, later), null);
        await tick(10);
        assert.strictEqual(rowsWith(env, 'appears STUCK'), 0, 'no false reported_but_running notice');
        assert.strictEqual(env.m._subBootRecoverableReport(r), null, 'no stale-report boot park');
    }, T);

    test('M2: a resume drain refused by the in-flight latch re-runs once when the full drain releases', async function() {
        var env, calls = 0;
        env = await load({ isChatPaused: function(pcid) {
            if (pcid !== 'root') return false;
            calls++;
            if (calls === 1) { env.m._drainPendingWakesForChat('root'); return true; } // user resumes mid-drain
            return false;
        } });
        env.idb.wakes().root = { parentChatId: 'root', notices: [{ text: 'NOTICE-M2 from W', sub_id: 'a1', at: 1 }], attempts: 0 };
        await env.m.drainPendingWakes();
        await tick(40);
        assert.ok(calls >= 2, 'the full drain re-ran');
        assert.strictEqual(rowsWith(env, 'NOTICE-M2 from W'), 1, 'row pushed without waiting for the heartbeat');
        assert.deepStrictEqual(env.runs, ['root'], 'parent run started once');
        var n = calls;
        await env.m.drainPendingWakes();
        await tick(20);
        assert.strictEqual(env.runs.length <= 2, true, 'flag consumed: no re-run loop');
        assert.ok(calls - n <= 2, 'one pass per drain');
    }, T);

    test('B2: the persisted boot-orphan wake text ends with the C1 reminder for a top-level parent only; meta.text === text', async function() {
        var env = await load();
        var W = env.idb.wakes();
        var HEAD = 'errored \u2014 orphaned by a service-worker restart before it reported (wake or resurrect it to retry)';
        var REMINDER_LINE = "\nReminder: your final message must be a cumulative digest of everything since the user's last message.";
        async function notices(pcid) {
            for (var i = 0; i < 60 && !(W[pcid] && W[pcid].notices && W[pcid].notices.length); i++) await tick(5);
            return (W[pcid] && W[pcid].notices) || [];
        }
        // Top-level parent 'root' (not a sub chat, no registry record owns it), via the real boot path.
        var r = sub(env);
        assert.strictEqual(env.m._orphanErrorSubAtBoot(r), 'errored');
        var n = await notices('root');
        assert.strictEqual(n.length, 1, JSON.stringify(W));
        assert.strictEqual(n[0].text, '[sub-agent lifecycle] W (a1): ' + HEAD + REMINDER_LINE, 'top-level parent: ends with the _withWakeFinalReminder line');
        assert.strictEqual(n[0].sub_id, 'a1');
        assert.strictEqual(n[0].subNotices.length, 1);
        var meta = n[0].subNotices[0];
        assert.deepStrictEqual([meta.kind, meta.agentId, meta.status, meta.summary], ['lifecycle', 'a1', 'errored', HEAD]);
        assert.strictEqual(meta.text, n[0].text, 'meta.text === text (top-level)');
        // Sub-agent parent (chats[pcid].isSubAgent): text unchanged, no reminder.
        sub(env, { agent_id: 'p1', chat_id: 'c_p1', name: 'P', state: 'sleeping' });
        var k1 = sub(env, { agent_id: 'k1', chat_id: 'c_k1', name: 'K', parent_chat_id: 'c_p1', state: 'errored' });
        assert.strictEqual(env.m._subNotifyParentOfBootOrphan(k1), 'pending_wake');
        var nk = await notices('c_p1');
        assert.strictEqual(nk[0].text, '[sub-agent lifecycle] K (k1): ' + HEAD, 'sub-agent parent: text unchanged');
        assert.strictEqual(nk[0].text.indexOf('Reminder:'), -1);
        assert.strictEqual(nk[0].subNotices[0].text, nk[0].text, 'meta.text === text (sub-agent parent)');
        // Parent chat not loaded: the registry record owning the chat id marks it nested too.
        sub(env, { agent_id: 'p2', chat_id: 'c_p2', name: 'P2', state: 'sleeping' });
        delete env.chats.c_p2;
        var k2 = sub(env, { agent_id: 'k2', chat_id: 'c_k2', name: 'K2', parent_chat_id: 'c_p2', state: 'errored' });
        assert.strictEqual(env.m._subNotifyParentOfBootOrphan(k2), 'pending_wake');
        var nk2 = await notices('c_p2');
        assert.strictEqual(nk2[0].text, '[sub-agent lifecycle] K2 (k2): ' + HEAD, 'registry-only nested parent: unchanged');
        assert.strictEqual(nk2[0].subNotices[0].text, nk2[0].text);
    }, T);

    test('pausedChats: _markErrored sets the halt pause flag; a resurrect wake clears it', async function() {
        var env = await load();
        var r = sub(env, { spawn_handle_id: 'h_spawn', _retry_used: true });
        env.m._markErrored('a1', 'boom');
        assert.strictEqual(r.state, 'errored');
        assert.strictEqual(env.paused.c_a1, true, 'halt pause flag set');
        var res = env.m._wakeSubAgentImpl({ agent_id: 'a1' }, null, true);
        assert.notStrictEqual(res && res.success, false, 'resurrected: ' + JSON.stringify(res && res.error));
        assert.strictEqual(r.state, 'running');
        assert.strictEqual(env.paused.c_a1, undefined, 'resurrect cleared the pause flag');
    }, T);
});
