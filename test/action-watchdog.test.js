// #6b — action watchdog (Phase 4, fix-all/4-high; tools/120-actions.js).
// startAction awaits the chat save, then runs the never-started check on BOTH
// runAgent settle paths; finishActionIfDone refuses to flip a never-started
// chat to a false 'Complete'; reconcileNeverStartedActions() is the one-shot
// boot scan (P4_ACTION_WATCHDOG ON → re-kick once; OFF → honest error).
describe('#6b action watchdog (tools/120-actions.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        var fakeDoc = { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
        M = await loadModules(['src/js/tools/120-actions.js'], { lenient: true, globals: { window: fakeWindow({ document: fakeDoc }), chrome: fakeChrome(), document: fakeDoc } });
        assert.strictEqual(typeof M.startAction, 'function');
        assert.strictEqual(typeof M._watchdogCheckNeverStarted, 'function');
        assert.strictEqual(typeof M.reconcileNeverStartedActions, 'function');
        return M;
    }
    function reset(m, opts) {
        opts = opts || {};
        var s = m.__scope;
        s.order = [];
        s.skills = { s1: { name: 'S', actions: [{ name: 'A', icon: 'play' }] } };
        s.chats = {};
        for (var k in m.activeActions) delete m.activeActions[k];
        s.currentChatId = null;
        s.activeStreamingChatId = null;
        s.runningChatIds = {};
        s._pendingRunAgents = {};
        s.AgentEvents = { emit: function() {} };
        s.SubAgents = undefined;
        s.persistCalls = [];
        s.persistActionState = async function(id) { s.persistCalls.push(id); };
        s.notifyActionStateChanged = function() {};
        s.broadcastActionChange = function() {};
        s.isChatPaused = function() { return false; };
        s.setChatPausedPersistent = function() {};
        s.dismissAction = async function() {};
        s.renderChatList = function() {};
        s.renderJobsBadge = function() {};
        s._refreshOpenChatProgressPopover = function() {};
        s.generateId = function() { return 'bg_' + Math.random().toString(36).slice(2, 8); };
        s.saveChatsToStorage = async function() { await Promise.resolve(); s.order.push('save'); };
        s.runAgentCalls = [];
        s.runAgent = opts.runAgent || function(cid) { s.order.push('run'); s.runAgentCalls.push(cid); return Promise.resolve(); };
        s.getP4Flag = function(n) { return n === 'P4_ACTION_WATCHDOG' && !!opts.flag; };
        s._swResumeScanSettledSeen = (opts.settled === undefined) ? true : opts.settled;
        m.__scope._neverStartedSweepDone = false; // module vars: reset through the namespace object below
        return s;
    }
    function bgChatOf(m) {
        var s = m.__scope;
        var ids = Object.keys(s.chats).filter(function(c) { return s.chats[c].isBackground; });
        return ids.length ? s.chats[ids[0]] : null;
    }
    function theAction(m) {
        var ids = Object.keys(m.activeActions);
        return ids.length ? m.activeActions[ids[0]] : null;
    }
    async function settle() { for (var i = 0; i < 4; i++) { await new Promise(function(r) { setTimeout(r, 0); }); } }

    test('(3) startAction awaits saveChatsToStorage BEFORE runAgent', async function() {
        var m = await load(); var s = reset(m);
        await m.startAction('s1', 'A');
        assert.deepStrictEqual(s.order, ['save', 'run']);
        assert.strictEqual(s.runAgentCalls.length, 1);
        var chat = bgChatOf(m);
        assert.ok(chat && chat.messages.length === 1 && chat.messages[0].role === 'user', 'seed user row present');
    });
    test('(1) runAgent resolves with the chat still at its seed row → neutral error "Action did not produce a response" + persisted', async function() {
        var m = await load(); var s = reset(m);
        await m.startAction('s1', 'A');
        await settle();
        var a = theAction(m);
        assert.strictEqual(a.state, 'error');
        // R4 SF2: no error in hand → neutral copy (the loop also pops the assistant row on API error / Stop / throttle)
        assert.strictEqual(a.label, 'Action did not produce a response');
        assert.strictEqual(a.icon, 'alert');
        assert.ok(/no assistant reply/.test(a.output) && /API error, stop, or runtime restart/.test(a.output), a.output);
        assert.ok(!/never picked up/.test(a.output) && !/service worker unavailable/.test(a.output), 'no misleading SW-unavailable claim: ' + a.output);
        assert.ok(!/Last API error/.test(a.output), 'no API error appended when the chat has none');
        // persistActionState is module-local (real IDB path swallows errors here); assert the record itself.
        assert.ok(typeof a.updatedAt === 'number' && a.reloadInterrupted === false, 'record stamped for persistence');
    });
    test('(1b) runAgent rejects → error carries the rejection message', async function() {
        var m = await load(); var s = reset(m, { runAgent: function() { return Promise.reject(new Error('port gone')); } });
        await m.startAction('s1', 'A');
        await settle();
        var a = theAction(m);
        assert.strictEqual(a.state, 'error');
        assert.strictEqual(a.label, 'Action never started', 'err present → original wording kept');
        assert.ok(/never picked up/.test(a.output) && /port gone/.test(a.output), a.output);
    });
    test('(1c) R4 SF2: chat._lastApiError present → neutral label + its message appended', async function() {
        var m = await load(); var s = reset(m);
        s.chats.cE = { id: 'cE', isBackground: true, actionId: 'actE', messages: [{ role: 'user', content: 'Run action' }], _lastApiError: { message: 'HTTP 529 overloaded', chatId: 'cE', timestamp: 1 } };
        m.activeActions.actE = { actionId: 'actE', chatId: 'cE', state: 'running', label: 'Starting…' };
        assert.strictEqual(await m._watchdogCheckNeverStarted('actE'), true);
        var a = m.activeActions.actE;
        assert.strictEqual(a.state, 'error');
        assert.strictEqual(a.label, 'Action did not produce a response');
        assert.ok(/Last API error: HTTP 529 overloaded/.test(a.output), a.output);
        assert.ok(!/never picked up/.test(a.output), a.output);
    });
    test('(2) runAgent resolves but the run progressed (assistant row) → untouched, still running', async function() {
        var m = await load(); var s = reset(m, { runAgent: function(cid) { s.chats[cid].messages.push({ role: 'assistant', content: 'hi' }); return Promise.resolve(); } });
        await m.startAction('s1', 'A');
        await settle();
        assert.strictEqual(theAction(m).state, 'running');
    });
    test('(2b) live run (runningChatIds) or pending runAgent → watchdog is a no-op', async function() {
        var m = await load(); var s = reset(m, { runAgent: function(cid) { s.runningChatIds[cid] = true; return Promise.resolve(); } });
        await m.startAction('s1', 'A');
        await settle();
        var a = theAction(m);
        assert.strictEqual(a.state, 'running');
        delete s.runningChatIds[a.chatId];
        s._pendingRunAgents[a.chatId] = { resolve: function() {} };
        assert.strictEqual(await m._watchdogCheckNeverStarted(a.actionId), false);
        assert.strictEqual(a.state, 'running');
        delete s._pendingRunAgents[a.chatId];
        assert.strictEqual(await m._watchdogCheckNeverStarted(a.actionId), true);
        assert.strictEqual(a.state, 'error');
        assert.strictEqual(await m._watchdogCheckNeverStarted(a.actionId), false, 'idempotent once not running');
    });
    test('(4) finishActionIfDone: never-started chat → error, not done; progressed chat → done/Complete (regression)', async function() {
        var m = await load(); var s = reset(m);
        s.chats.c1 = { id: 'c1', isBackground: true, actionId: 'act1', messages: [{ role: 'user', content: 'Run action' }] };
        m.activeActions.act1 = { actionId: 'act1', chatId: 'c1', state: 'running', label: 'Starting…' };
        await m.finishActionIfDone('c1');
        assert.strictEqual(m.activeActions.act1.state, 'error');
        assert.strictEqual(m.activeActions.act1.label, 'Action did not produce a response');
        s.chats.c2 = { id: 'c2', isBackground: true, actionId: 'act2', messages: [{ role: 'user', content: 'Run action' }, { role: 'assistant', content: 'done' }] };
        m.activeActions.act2 = { actionId: 'act2', chatId: 'c2', state: 'running', label: 'Starting…' };
        await m.finishActionIfDone('c2');
        assert.strictEqual(m.activeActions.act2.state, 'done');
        assert.strictEqual(m.activeActions.act2.label, 'Complete');
        assert.strictEqual(m.activeActions.act2.icon, 'check');
    });
    test('_chatNeverStarted: exactly one user row and no assistant row', async function() {
        var m = await load();
        assert.strictEqual(m._chatNeverStarted({ messages: [{ role: 'user' }] }), true);
        assert.strictEqual(m._chatNeverStarted({ messages: [{ role: 'user' }, { role: 'tool' }] }), true);
        assert.strictEqual(m._chatNeverStarted({ messages: [{ role: 'user' }, { role: 'assistant' }] }), false);
        assert.strictEqual(m._chatNeverStarted({ messages: [{ role: 'user' }, { role: 'user' }] }), false);
        assert.strictEqual(m._chatNeverStarted({ messages: [] }), false);
        assert.strictEqual(m._chatNeverStarted(null), false);
    });
    function seedInterrupted(m, s, id, cid, extra) {
        s.chats[cid] = Object.assign({ id: cid, isBackground: true, actionId: id, messages: [{ role: 'user', content: 'Run action' }] }, extra || {});
        m.activeActions[id] = { actionId: id, chatId: cid, state: 'running', reloadInterrupted: true, label: 'Starting…' };
    }
    async function freshSweep(m, s) {
        // _neverStartedSweepDone / _neverStartedSweepRearmed are module vars; reload a fresh module per case.
        M = null; var m2 = await load(); return m2;
    }
    test('(5a) reconcileNeverStartedActions, flag OFF → honest error; progressed / live chats untouched', async function() {
        var m = await freshSweep(); var s = reset(m, { flag: false });
        seedInterrupted(m, s, 'a1', 'c1');
        seedInterrupted(m, s, 'a2', 'c2'); s.chats.c2.messages.push({ role: 'assistant', content: 'x' });
        seedInterrupted(m, s, 'a3', 'c3'); s.runningChatIds.c3 = true;
        m.reconcileNeverStartedActions();
        await settle();
        assert.strictEqual(m.activeActions.a1.state, 'error');
        assert.strictEqual(m.activeActions.a1.reloadInterrupted, false);
        assert.strictEqual(m.activeActions.a2.state, 'running');
        assert.strictEqual(m.activeActions.a2.reloadInterrupted, true);
        assert.strictEqual(m.activeActions.a3.state, 'running');
        assert.strictEqual(s.runAgentCalls.length, 0, 'flag OFF never re-kicks');
        m.reconcileNeverStartedActions(); await settle();
        assert.strictEqual(s.runAgentCalls.length, 0, 'one-shot');
    });
    test('(5b) flag ON → runAgent re-kicked exactly once, reloadInterrupted cleared; a still-empty chat after the re-kick → error', async function() {
        var m = await freshSweep(); var s = reset(m, { flag: true });
        seedInterrupted(m, s, 'a1', 'c1');
        m.reconcileNeverStartedActions();
        assert.deepStrictEqual(s.runAgentCalls, ['c1']);
        assert.strictEqual(m.activeActions.a1.reloadInterrupted, false);
        m.reconcileNeverStartedActions();
        assert.strictEqual(s.runAgentCalls.length, 1, 'one-shot guard');
        await settle();
        assert.strictEqual(m.activeActions.a1.state, 'error', 're-kick resolved with no progress → honest error');
    });
    test('(5c) flag ON, re-kick progresses the chat → stays running', async function() {
        var m = await freshSweep(); var s = reset(m, { flag: true, runAgent: function(cid) { s.runAgentCalls.push(cid); s.chats[cid].messages.push({ role: 'assistant', content: 'go' }); return Promise.resolve(); } });
        seedInterrupted(m, s, 'a1', 'c1');
        m.reconcileNeverStartedActions();
        await settle();
        assert.deepStrictEqual(s.runAgentCalls, ['c1']);
        assert.strictEqual(m.activeActions.a1.state, 'running');
    });
    test('(5d) B11: SW resume scan not yet settled → keeps deferring (bounded re-arms); settle signal releases the sweep at once', async function() {
        var m = await freshSweep(); var s = reset(m, { flag: true, settled: false });
        seedInterrupted(m, s, 'a1', 'c1');
        m.reconcileNeverStartedActions();
        await settle();
        assert.strictEqual(s.runAgentCalls.length, 0);
        assert.strictEqual(m.activeActions.a1.state, 'running');
        assert.strictEqual(m.activeActions.a1.reloadInterrupted, true);
        // further calls with the scan still unsettled KEEP deferring (no longer a single re-arm)
        m.reconcileNeverStartedActions(); m.reconcileNeverStartedActions();
        assert.strictEqual(s.runAgentCalls.length, 0, 'still deferred while unsettled');
        // hook fires before init armed anything? here it is armed → settle signal releases the sweep immediately
        s._swResumeScanSettledSeen = true;
        m._onResumeScanSettledForActions();
        assert.deepStrictEqual(s.runAgentCalls, ['c1'], 'settle signal ran the deferred sweep with re-kick');
        m._onResumeScanSettledForActions(); m.reconcileNeverStartedActions();
        assert.strictEqual(s.runAgentCalls.length, 1, 'one-shot after completion');
    });
    test('(5e) B11: re-arm cap exhausted with no settle → sweeps WITHOUT re-kick (honest error only); hook is a no-op before the first arm', async function() {
        var m = await freshSweep(); var s = reset(m, { flag: true, settled: false });
        seedInterrupted(m, s, 'a1', 'c1');
        m._onResumeScanSettledForActions();
        assert.strictEqual(m.activeActions.a1.reloadInterrupted, true, 'hook before init\'s first call does nothing');
        for (var i = 0; i < m.NEVER_STARTED_SWEEP_MAX_REARMS; i++) m.reconcileNeverStartedActions();
        assert.strictEqual(s.runAgentCalls.length, 0, 'deferred through the whole cap');
        m.reconcileNeverStartedActions();
        await settle();
        assert.strictEqual(s.runAgentCalls.length, 0, 'cap exhausted → no re-kick even with the flag ON');
        assert.strictEqual(m.activeActions.a1.state, 'error', 'honest-error branch still ran');
    });
});
