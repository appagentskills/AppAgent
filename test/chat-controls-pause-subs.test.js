// PAUSE-SUBS (PR #1181): an IDLE main chat whose sub-agents are still running
// shows Pause (_chatControlsState -> 'pause'). That Pause stands only the subs
// down (pausedByUser + pausedSubsOnly, propagate=true); the matching Resume
// re-queues the subs (propagate=true) WITHOUT starting a run of the main chat.
// With the main agent running, Pause/Resume behave as before (subsOnly false,
// Resume runs main). Real 030 (setChatPausedPersistent) + real 020 via
// loadModules; DOM, SubAgents registry and the offscreen pushes are stubbed.
var T = { tags: ['unit'], timeout: 15000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };
var FILES = ['src/js/core/030-config.js', 'src/js/app/020-api-messages.js'];

function fakeButton(id) {
    var cls = {};
    return { id: id, title: '', innerHTML: '', textContent: '', style: {},
        classList: { add: function(c) { cls[c] = true; }, remove: function(c) { delete cls[c]; }, contains: function(c) { return !!cls[c]; } } };
}
function fakeDocument(btns) {
    return { addEventListener: function() {}, removeEventListener: function() {},
        querySelector: function() { return null; }, querySelectorAll: function() { return []; },
        getElementById: function(id) { return btns[id] || null; },
        createElement: function() { return fakeButton('x'); }, body: fakeButton('body') };
}
function mkChat(id, o) {
    return Object.assign({ id: id, title: id, messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }] }, o || {});
}
function painted(dom) {
    var p = dom.pause.classList.contains('visible'), c = dom.cont.classList.contains('visible'), r = dom.retry.classList.contains('visible');
    if ((p ? 1 : 0) + (c ? 1 : 0) + (r ? 1 : 0) > 1) return 'MULTI';
    if (p) return /Resume/.test(dom.pause.innerHTML) ? 'resume' : 'pause';
    if (c) return 'continue';
    if (r) return 'retry';
    return 'none';
}

async function load() {
    var btns = { 'pause-btn': fakeButton('pause-btn'), 'continue-btn': fakeButton('continue-btn'), 'retry-btn': fakeButton('retry-btn') };
    var doc = fakeDocument(btns);
    var globals = { window: fakeWindow({ document: doc }), chrome: fakeChrome(), document: doc, console: quiet,
        setTimeout: function() { return 0; }, clearTimeout: function() {}, setInterval: function() { return 0; }, clearInterval: function() {} };
    var m = await loadModules(FILES, { lenient: true, globals: globals });
    var s = m.__scope;
    s.chats = { a: mkChat('a'), s1: mkChat('s1', { isSubAgent: true }) };
    s.currentChatId = 'a';
    s.currentView = 'chat';
    s.runningChatIds = {};
    s.pausedChats = {};
    s.pausedChatIds = {};
    s.paused = false;
    s.lastApiError = null;
    s.UI_ICONS = { play: '', pause: '' };
    s.currentStreamAbortControllers = {};
    s.interruptResolversByChatId = {};
    s.hideSnackbar = function() {};
    s.runs = [];
    s.runAgent = function(id) { var cid = id || s.currentChatId; if (cid) s.runningChatIds[cid] = true; s.runs.push(cid); return Promise.resolve(); };
    s.metas = [];
    // app/045 optimistic apply: patch onto the record, derive pausedChats.
    s.dispatchChatMeta = function(id, patch) {
        s.metas.push({ id: id, patch: Object.assign({}, patch) });
        if (s.chats[id]) Object.assign(s.chats[id], patch);
        if (patch && patch.pausedByUser !== undefined) {
            if (patch.pausedByUser === true) { s.pausedChats[id] = true; s.pausedChatIds[id] = true; }
            else { delete s.pausedChats[id]; delete s.pausedChatIds[id]; }
        }
    };
    s.pushes = [];
    s.pushPauseToggleToOffscreen = function(id, p, a3, a4, propagate) { s.pushes.push({ id: id, paused: p === true, propagate: propagate === true }); };
    s.pushInterruptToOffscreen = function() {};
    s.rejectPendingApprovalsForChat = function() {};
    s.subs = [];
    s.SubAgents = { listAll: function() { return s.subs.slice(); } };
    return { m: m, s: s, dom: { pause: btns['pause-btn'], cont: btns['continue-btn'], retry: btns['retry-btn'] } };
}
function liveSub(o) {
    return Object.assign({ agent_id: 'sub_1', chat_id: 's1', parent_chat_id: 'a', root_chat_id: 'a', state: 'running' }, o || {});
}

describe('PAUSE-SUBS: Pause running sub-agents of an idle chat (app/020)', function() {
    test('_chatControlsState: idle + live sub -> pause; no live sub -> not pause', async function() {
        var t = await load(), s = t.s, m = t.m;
        assert.strictEqual(m._chatControlsState('a'), 'none', 'idle clean chat, no subs');
        s.subs = [liveSub()];
        assert.strictEqual(m._chatHasLiveSubAgents('a'), true, 'live sub detected');
        assert.strictEqual(m._chatControlsState('a'), 'pause', 'idle chat with a running sub -> pause');
        assert.strictEqual(m.syncChatControlsUI('a'), 'pause', 'syncChatControlsUI returns pause');
        assert.strictEqual(painted(t.dom), 'pause', 'Pause painted');
        assert.strictEqual(/Pause/.test(t.dom.pause.innerHTML), true, 'label reads Pause');
        // Non-live subs do not count.
        s.subs = [liveSub({ state: 'sleeping' })];
        assert.notStrictEqual(m._chatControlsState('a'), 'pause', 'sleeping sub is not live');
        s.subs = [liveSub({ paused_by_parent_chat: 'a' })];
        assert.notStrictEqual(m._chatControlsState('a'), 'pause', 'parent-paused sub is not live');
        s.subs = [liveSub()]; s.pausedChats.s1 = true;
        assert.notStrictEqual(m._chatControlsState('a'), 'pause', 'user-paused sub chat is not live');
        delete s.pausedChats.s1;
        s.subs = [liveSub({ parent_chat_id: 'zz', root_chat_id: 'zz' })];
        assert.notStrictEqual(m._chatControlsState('a'), 'pause', "another chat's sub is not counted");
        // Deeper subtree member (root is this chat) counts.
        s.subs = [liveSub({ parent_chat_id: 's1', root_chat_id: 'a', chat_id: 's2' })];
        assert.strictEqual(m._chatControlsState('a'), 'pause', 'depth-2 sub rooted at this chat counts');
        // No SubAgents registry at all -> false, no throw.
        s.SubAgents = undefined;
        assert.strictEqual(m._chatHasLiveSubAgents('a'), false, 'no registry -> false');
        // Sub-agent chats never get the idle Pause.
        s.SubAgents = { listAll: function() { return [liveSub({ parent_chat_id: 's1', root_chat_id: 's1', chat_id: 's9' })]; } };
        assert.strictEqual(m._chatControlsState('s1'), 'none', 'idle sub-agent chat: none');
    }, T);

    test('idle Pause sets pausedByUser + pausedSubsOnly and propagates; Resume re-queues subs without runAgent', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.subs = [liveSub()];
        m.togglePause();
        assert.strictEqual(s.chats.a.pausedByUser, true, 'pausedByUser stamped');
        assert.strictEqual(s.chats.a.pausedSubsOnly, true, 'pausedSubsOnly stamped');
        assert.strictEqual(s.pausedChats.a, true, 'pausedChats derived');
        assert.deepStrictEqual(s.pushes, [{ id: 'a', paused: true, propagate: true }], 'pause pushed with propagate=true');
        assert.strictEqual(s.metas.length, 1, 'one meta dispatch');
        assert.deepStrictEqual(s.metas[0].patch, { pausedByUser: true, pausedSubsOnly: true }, 'single dispatch carries both flags');
        assert.strictEqual(m.syncChatControlsUI('a'), 'resume', 'paused idle chat shows Resume');
        assert.strictEqual(painted(t.dom), 'resume', 'Resume painted');

        s.pushes = []; s.metas = [];
        m.togglePause();
        assert.deepStrictEqual(s.runs, [], 'Resume did NOT run the main agent');
        assert.strictEqual(!!s.runningChatIds.a, false, 'main chat still idle');
        assert.deepStrictEqual(s.pushes, [{ id: 'a', paused: false, propagate: true }], 'resume pushed with propagate=true');
        assert.strictEqual(s.chats.a.pausedByUser, false, 'pausedByUser cleared');
        assert.strictEqual(s.chats.a.pausedSubsOnly, false, 'pausedSubsOnly cleared on unpause');
        assert.strictEqual(s.pausedChats.a, undefined, 'pausedChats cleared');
        assert.strictEqual(m._chatControlsState('a'), 'pause', 'subs live again -> Pause offered again');
    }, T);

    test('main agent running: Pause is a normal pause (subsOnly false) and Resume runs main', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.subs = [liveSub()];
        s.runningChatIds.a = true;
        assert.strictEqual(m._chatControlsState('a'), 'pause', 'running chat -> pause');
        m.togglePause();
        assert.strictEqual(s.chats.a.pausedByUser, true, 'pausedByUser stamped');
        assert.strictEqual(s.chats.a.pausedSubsOnly === true, false, 'pausedSubsOnly NOT set while main runs');
        assert.deepStrictEqual(s.pushes, [{ id: 'a', paused: true, propagate: true }], 'pause pushed with propagate=true');
        // The loop exits on pause.
        delete s.runningChatIds.a;
        s.pushes = [];
        m.togglePause();
        assert.deepStrictEqual(s.runs, ['a'], 'Resume runs the main agent');
        assert.deepStrictEqual(s.pushes, [{ id: 'a', paused: false, propagate: true }], 'resume pushed with propagate=true');
        assert.strictEqual(s.pausedChats.a, undefined, 'unpaused');
    }, T);

    test('stale pausedSubsOnly from an earlier idle pause does not leak into a running pause', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.subs = [liveSub()];
        m.togglePause();               // idle pause -> subsOnly
        m.togglePause();               // resume (clears rider)
        assert.strictEqual(s.chats.a.pausedSubsOnly, false, 'rider cleared');
        s.runningChatIds.a = true;
        m.togglePause();               // running pause
        assert.strictEqual(s.chats.a.pausedSubsOnly, false, 'running pause stamps subsOnly=false');
        delete s.runningChatIds.a;
        s.runs = [];
        m.togglePause();
        assert.deepStrictEqual(s.runs, ['a'], 'Resume runs main');
    }, T);

    test('030 setChatPausedPersistent: subsOnly rider dispatch + no-op guard', async function() {
        var t = await load(), s = t.s, m = t.m;
        m.setChatPausedPersistent('a', true, { subsOnly: true });
        assert.deepStrictEqual(s.metas.pop().patch, { pausedByUser: true, pausedSubsOnly: true });
        // Same state again -> no dispatch.
        m.setChatPausedPersistent('a', true, { subsOnly: true });
        assert.strictEqual(s.metas.length, 0, 'idempotent re-pause is a no-op');
        // Same pause, rider flips -> dispatched.
        m.setChatPausedPersistent('a', true, { subsOnly: false });
        assert.deepStrictEqual(s.metas.pop().patch, { pausedByUser: true, pausedSubsOnly: false });
        m.setChatPausedPersistent('a', true, { subsOnly: true });
        s.metas = [];
        m.setChatPausedPersistent('a', false);
        assert.deepStrictEqual(s.metas.pop().patch, { pausedByUser: false, pausedSubsOnly: false }, 'unpause clears rider');
        // Plain pause with no opts carries no rider.
        m.setChatPausedPersistent('a', true);
        assert.deepStrictEqual(s.metas.pop().patch, { pausedByUser: true });
        assert.strictEqual(m.CHAT_META_FLAG_FIELDS.indexOf('pausedSubsOnly') >= 0, true, 'pausedSubsOnly is a meta flag field');
    }, T);
});
