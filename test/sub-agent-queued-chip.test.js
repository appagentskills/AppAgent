// B1/B2 (PR #1015 part 2): a sub waiting in the pool queue is a 'running'
// record with no loop yet. Real core/097 registry + ui/175 renderers via
// loadModules; _chipKey (nested in the _wireSubAgentUi IIFE) is cut from the
// real source. Globals stub only IDB/chrome/runtime plumbing.
var T = { tags: ['unit'], timeout: 8000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
var REG = ['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'];

async function loadReg(chats) {
    var self = {};
    var m = await loadModules(REG, { lenient: true, globals: {
        self: self, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
        chats: chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
        isChatPaused: function() { return false; },
        runAgent: function() { return new Promise(function() {}); },
        saveChatsToStorage: function() { return Promise.resolve(); },
        openDatabase: function() { return new Promise(function() {}); },
        releaseIdleDbConnection: function() {}, readAgentCheckpoint: function() { return Promise.resolve(null); },
        pendingWakesStoreName: 'sub_agent_pending_wakes', console: quiet
    } });
    return { m: m, SA: m.SubAgents || self.SubAgents };
}
function rec(extra) {
    var r = { agent_id: 'a1', chat_id: 'c_a1', name: 'W', state: 'running', parent_chat_id: 'root', root_chat_id: 'root', depth: 1, created_at: Date.now() - 1000, last_activity_at: Date.now() };
    for (var k in (extra || {})) r[k] = extra[k];
    return r;
}
async function loadUi(SA) {
    // Real registry methods; addListener no-op so the boot IIFE schedules nothing.
    var view = {};
    for (var k in SA) view[k] = SA[k];
    view.addListener = function() {}; view.removeListener = function() {};
    return loadModules(['src/js/ui/175-sub-agent-ui.js'], { lenient: true, globals: {
        self: {}, window: fakeWindow(), console: quiet, SubAgents: view, chats: { root: { messages: [] } },
        escapeHtml: function(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); },
        UI_ICONS: { bot: 'BOT', thinking: 'THINK' }, getToolIcon: function(t) { return 'TI:' + t; }
    } });
}
// Cut the nested `function _chipKey() {...}` by brace matching (no braces in its strings/comments).
async function chipKeyFn(env) {
    var src = await loadFile('src/js/ui/175-sub-agent-ui.js');
    var a = src.indexOf('function _chipKey() {');
    assert.ok(a > 0, '_chipKey declaration present');
    var i = src.indexOf('{', a), depth = 0, b = -1;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { b = i + 1; break; } } }
    return new Function('env', 'with (env) { return (' + src.slice(a, b) + '); }')(env);
}

describe('pool queue visibility (core/097)', function() {
    test('poolSnapshot exposes queue_ids as a copy of the live queue', async function() {
        var R = await loadReg({ root: { messages: [] } });
        assert.deepStrictEqual(R.SA.poolSnapshot().queue_ids, []);
        R.m._subPool.queue.push('a1');
        var snap = R.SA.poolSnapshot();
        assert.deepStrictEqual(snap.queue_ids, ['a1']);
        assert.strictEqual(snap.queued, 1);
        snap.queue_ids.push('x');
        assert.deepStrictEqual(R.m._subPool.queue, ['a1'], 'snapshot must not alias the queue');
    }, T);

    test('compact agent_status carries in_pool_queue only while queued (B2)', async function() {
        var chats = { root: { messages: [] }, c_a1: { isSubAgent: true, subAgentId: 'a1', messages: [{ role: 'user', content: 't' }] } };
        var R = await loadReg(chats);
        R.m._subAgents.a1 = rec();
        var e = R.m.agentStatus({}, { chatId: 'root' }).agents[0];
        assert.strictEqual(e.agent_id, 'a1');
        assert.strictEqual('in_pool_queue' in e, false, 'healthy sub stays compact');
        R.m._subPool.queue.push('a1');
        assert.strictEqual(R.m.agentStatus({}, { chatId: 'root' }).agents[0].in_pool_queue, true);
        assert.strictEqual(R.m.agentStatus({ verbose: true }, { chatId: 'root' }).agents[0].in_pool_queue, true, 'agrees with verbose');
    }, T);

    test('page applySnapshot mirrors pool.queue_ids; isQueued flips on the dequeue snapshot', async function() {
        var R = await loadReg({ root: { messages: [] } });
        assert.strictEqual(R.SA.isQueued('a1'), false);
        R.SA.applySnapshot([rec()], { running: 1, queued: 1, queue_ids: ['a1'] });
        assert.strictEqual(R.SA.getById('a1').state, 'running');
        assert.strictEqual(R.SA.isQueued('a1'), true, 'mirror consulted when the local queue is empty');
        R.SA.applySnapshot([rec()], { running: 1, queued: 0, queue_ids: [] });
        assert.strictEqual(R.SA.isQueued('a1'), false, 'dequeue snapshot clears it');
        R.SA.applySnapshot([rec()], { queue_ids: ['a1'] });
        R.SA.applySnapshot([rec()]);
        assert.strictEqual(R.SA.isQueued('a1'), false, 'pool-less snapshot never leaves a stale mirror');
        R.m._subPool.queue.push('a1');
        assert.strictEqual(R.SA.isQueued('a1'), true, 'local (SW) queue wins');
        assert.strictEqual(R.SA.isQueued(''), false);
    }, T);

    test('page bridge forwards the envelope pool (source pin, app/045)', async function() {
        var src = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        assert.match(src, /SubAgents\.applySnapshot\(msg\.records \|\| \[\], msg\.pool \|\| null\)/);
    }, T);
});

describe('queued worker chip (ui/175)', function() {
    test('card renders queued (not the running look); dequeue restores running', async function() {
        var R = await loadReg({ root: { messages: [] } });
        var ui = await loadUi(R.SA);
        var r = rec({ activity: { phase: 'tool', tool: 'web_fetch' } });
        R.SA.applySnapshot([r], { queue_ids: ['a1'] });
        var html = ui._workerCardHtml(R.SA.getById('a1'));
        assert.match(html, /class="worker-card worker-queued/);
        assert.match(html, /worker-dot-queued/);
        assert.match(html, /data-worker-state>queued</);
        assert.ok(!/worker-running|worker-dot-running/.test(html), 'no running look while queued');
        assert.strictEqual(ui._subActivityInfo(R.SA.getById('a1')), null, 'no activity while queued');
        R.SA.applySnapshot([r], { queue_ids: [] });
        var html2 = ui._workerCardHtml(R.SA.getById('a1'));
        assert.match(html2, /class="worker-card worker-running/);
        assert.ok(!/queued/.test(html2));
        assert.strictEqual(ui._subActivityInfo(R.SA.getById('a1')).phase, 'tool');
    }, T);

    test('in-place patch labels queued, then repaints on dequeue', async function() {
        var R = await loadReg({ root: { messages: [] } });
        var ui = await loadUi(R.SA);
        var attrs = {}, cls = {};
        var icon = { innerHTML: '', getAttribute: function(k) { return k in attrs ? attrs[k] : null; }, setAttribute: function(k, v) { attrs[k] = v; },
            classList: { toggle: function(c, on) { cls[c] = !!on; } } };
        var st = { textContent: 'running', title: '' };
        var card = { querySelector: function(s) { return s === '.worker-card-icon' ? icon : (s === '[data-worker-state]' ? st : null); } };
        R.SA.applySnapshot([rec()], { queue_ids: ['a1'] });
        ui._patchWorkerCardActivity(card, R.SA.getById('a1'));
        assert.strictEqual(st.textContent, 'queued');
        R.SA.applySnapshot([rec()], { queue_ids: [] });
        ui._patchWorkerCardActivity(card, R.SA.getById('a1'));
        assert.strictEqual(st.textContent, 'running', 'activity key changed so the label repaints');
    }, T);

    test('_chipKey changes on dequeue and stays legacy-identical when not queued', async function() {
        var R = await loadReg({ root: { messages: [] } });
        var ui = await loadUi(R.SA);
        var chipKey = await chipKeyFn({ SubAgents: R.SA, currentChatId: 'root', chats: { root: { messages: [] } }, _subIsQueued: ui._subIsQueued });
        R.SA.applySnapshot([rec()], { queue_ids: ['a1'] });
        var k1 = chipKey();
        R.SA.applySnapshot([rec()], { queue_ids: [] });
        var k2 = chipKey();
        assert.notStrictEqual(k1, k2, 'dequeue must repaint the strip');
        assert.strictEqual(k2, 'root|a1:running:1');
    }, T);

    test('CSS ships the queued dot + card rules', async function() {
        var css = await loadFile('src/css/24-sub-agents.css');
        assert.match(css, /\.worker-dot-queued\s*\{[^}]*dashed/);
        assert.match(css, /\.worker-card\.worker-queued\s*\{[^}]*dashed/);
    }, T);
});
