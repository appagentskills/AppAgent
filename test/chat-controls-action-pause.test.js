// CHAT-CONTROLS SSOT x Actions (tools/120-actions.js). The action popover
// (pauseAction / resumeAction / stopAction / dismissAction) and the cross-tab
// BroadcastChannel arms flip a chat's pause state outside togglePause; each one
// re-derives the displayed chat's controls through _syncChatPagePauseUIForChat
// -> syncChatControlsUI (app/020), guarded to the displayed chat. The two 5 s
// transient-halt clears (dismissAction, cross-tab `delete`) re-derive too, so a
// stale Resume (whose click would PAUSE, togglePause reads pausedChats) never
// outlives its halt.
// Real: core/030 (setChatPausedPersistent), app/020 (derive + paint), tools/120.
// Stubbed: three fake buttons, chrome, BroadcastChannel (by name), setTimeout
// (manual clock), the app/045 lane (dispatchChatMeta optimistic apply: patch onto
// the chat + pausedChats[id] = pausedByUser === true), the runAgent shim (marks
// runningChatIds synchronously) and the SW pushes (pushPauseToggleToOffscreen
// bumps _pauseToggleGen like 045 does).
// Stopped action (app/020 _isStoppedActionChat): stopAction clears _isPaused but
// leaves the chat paused to halt the loop; that halt is not a user pause, so the
// stopped chat shows no control, running or idle. A send / Resume clears the pause
// and the normal rules apply again.
var T = { tags: ['unit'], timeout: 20000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };
var FILES = ['src/js/core/030-config.js', 'src/js/app/020-api-messages.js', 'src/js/tools/120-actions.js'];
var NO_020 = ['src/js/core/030-config.js', 'src/js/tools/120-actions.js'];

// fakeButton / fakeDocument / painted: copied from test/chat-controls-visibility.test.js.
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
    if ((p ? 1 : 0) + (c ? 1 : 0) + (r ? 1 : 0) > 1) return 'MULTI(' + [p && 'pause', c && 'continue', r && 'retry'].filter(Boolean).join('+') + ')';
    if (p) return /Resume/.test(dom.pause.innerHTML) ? 'resume' : 'pause';
    if (c) return 'continue';
    if (r) return 'retry';
    return 'none';
}
function label(dom) { return /Resume/.test(dom.pause.innerHTML) ? 'Resume' : (/Pause/.test(dom.pause.innerHTML) ? 'Pause' : ''); }
// Run (and drop) every queued timer with this delay; returns how many ran.
function fire(t, ms) {
    var due = t.clock.q.filter(function(x) { return x.ms === ms; });
    t.clock.q = t.clock.q.filter(function(x) { return x.ms !== ms; });
    due.forEach(function(x) { x.fn(); });
    return due.length;
}
function bcSend(t, data) { t.bc.onmessage({ data: data }); }
// Button log: one painted() snapshot per label write (020 syncChatControlsUI ends with syncPauseButtonUI).
function paintLog(t) {
    var log = [], pb = t.dom.pause, html = pb.innerHTML;
    Object.defineProperty(pb, 'innerHTML', { configurable: true, get: function() { return html; },
        set: function(v) { html = v; log.push(painted(t.dom)); } });
    return log;
}

async function load(opts) {
    opts = opts || {};
    var btns = { 'pause-btn': fakeButton('pause-btn'), 'continue-btn': fakeButton('continue-btn'), 'retry-btn': fakeButton('retry-btn') };
    var doc = fakeDocument(btns), gets = { n: 0 }, rawGet = doc.getElementById;
    doc.getElementById = function(id) { if (btns[id]) gets.n++; return rawGet(id); };   // lookups of the three controls
    var clock = { q: [], id: 0 }, bcs = {};
    function FakeBC(name) { this.name = name; this.posted = []; this.onmessage = null; bcs[name] = this; }
    FakeBC.prototype.postMessage = function(d) { this.posted.push(d); };
    FakeBC.prototype.close = function() {};
    var globals = { window: fakeWindow({ document: doc }), chrome: fakeChrome(), document: doc, console: quiet,
        BroadcastChannel: FakeBC,
        setTimeout: function(fn, ms) { var id = ++clock.id; clock.q.push({ id: id, fn: fn, ms: ms }); return id; },
        clearTimeout: function(id) { clock.q = clock.q.filter(function(x) { return x.id !== id; }); },
        setInterval: function() { return 0; }, clearInterval: function() {} };
    Object.assign(globals, opts.globals || {});
    var m = await loadModules(opts.files || FILES, { lenient: true, globals: globals });
    var s = m.__scope;
    clock.q = [];   // load-time timers are not under test
    s.chats = { a: mkChat('a'), bg: mkChat('bg', { isBackground: true, actionId: 'act1' }) };
    s.currentChatId = 'bg';
    s.currentView = 'chat';
    s.runningChatIds = {};
    s.pausedChats = {};
    s.paused = false;
    s.lastApiError = null;
    s.UI_ICONS = { play: '', pause: '' };
    s.currentStreamAbortControllers = {};
    s.interruptResolversByChatId = {};
    s.hideSnackbar = function() {};
    s.runs = [];
    s.runAgent = function(id) { var cid = id || s.currentChatId; if (cid) s.runningChatIds[cid] = true; s.runs.push(cid); return Promise.resolve(); };
    // app/045 optimistic apply (045:~1939): patch onto the record, derive pausedChats.
    s.dispatchChatMeta = function(id, patch) {
        if (s.chats[id]) Object.assign(s.chats[id], patch);
        if (patch && patch.pausedByUser !== undefined) s.pausedChats[id] = patch.pausedByUser === true;
        // opts.laneRepaint models 045:2009 (_repaintDisplayedChatControls): a synchronous derive inside the pause write.
        if (opts.laneRepaint && patch && patch.pausedByUser !== undefined && id === s.currentChatId) m.syncChatControlsUI(s.currentChatId);
    };
    s._pauseToggleGen = Object.create(null);
    s.pushes = [];
    s.pushPauseToggleToOffscreen = function(id, p) { s._pauseToggleGen[id] = (s._pauseToggleGen[id] || 0) + 1; s.pushes.push(id + ':' + (p === true)); };
    s.pushInterruptToOffscreen = function() {};
    if (!s.activeActions) s.activeActions = {};
    s.activeActions.act1 = { actionId: 'act1', chatId: 'bg', state: 'running' };
    return { m: m, s: s, dom: { pause: btns['pause-btn'], cont: btns['continue-btn'], retry: btns['retry-btn'] },
        bc: bcs['appagent-actions'], clock: clock, gets: gets };
}

describe('chat controls x action pause (tools/120-actions.js)', function() {
    test('harness: real 020/030/120 loaded, BroadcastChannel captured', async function() {
        var t = await load();
        ['syncChatControlsUI', 'togglePause', 'setChatPausedPersistent', 'pauseAction', 'resumeAction', 'stopAction',
            'dismissAction', '_syncChatPagePauseUIForChat'].forEach(function(n) {
            assert.strictEqual(typeof t.m[n], 'function', n + ' is a real global');
        });
        assert.strictEqual(!!(t.bc && typeof t.bc.onmessage === 'function'), true, "'appagent-actions' onmessage wired");
    }, T);

    test('pauseAction on the displayed running chat paints Resume; it survives re-derives; the click resumes', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.bg = true;
        assert.strictEqual(m.syncChatControlsUI(), 'pause', 'precondition: running action chat shows Pause');
        await m.pauseAction('act1');
        assert.strictEqual(s.activeActions.act1._isPaused, true, 'action _isPaused');
        assert.strictEqual(s.pausedChats.bg, true, 'pausedChats mirrors _isPaused (lane optimistic apply)');
        assert.strictEqual(s.chats.bg.pausedByUser, true, 'pausedByUser persisted on the record');
        assert.strictEqual(painted(t.dom), 'resume', 'the 120 re-derive painted Resume');
        assert.strictEqual(m.syncChatControlsUI(), 'resume', 'a later re-derive agrees');
        delete s.runningChatIds.bg;
        assert.strictEqual(m.syncChatControlsUI(), 'resume', 'loop exited: the idle paused chat keeps Resume');
        m.togglePause();
        assert.strictEqual(s.pausedChats.bg, false, 'the Resume click resumes (same map as the label)');
        assert.strictEqual(s.runs.join(','), 'bg', 'Resume re-kicked the run');
        assert.strictEqual(painted(t.dom), 'pause', 'running again: Pause');
        assert.strictEqual(label(t.dom), 'Pause', 'label reads Pause');
    }, T);

    test('resumeAction while the paused loop still runs paints Pause', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.bg = true;
        await m.pauseAction('act1');
        assert.strictEqual(painted(t.dom), 'resume', 'paused');
        await m.resumeAction('act1');
        assert.strictEqual(s.activeActions.act1._isPaused, false, 'action _isPaused cleared');
        assert.strictEqual(s.pausedChats.bg, false, 'pausedChats cleared');
        assert.strictEqual(painted(t.dom), 'pause', 'Pause');
        assert.strictEqual(label(t.dom), 'Pause', 'label reads Pause');
        assert.strictEqual(s.runs.length, 0, 'already running: no re-kick');
    }, T);

    test('resumeAction after the paused loop exited re-kicks and paints Pause (not an empty bar)', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.bg = true;
        await m.pauseAction('act1');
        delete s.runningChatIds.bg;
        assert.strictEqual(m.syncChatControlsUI(), 'resume', 'idle paused: Resume');
        await m.resumeAction('act1');
        assert.strictEqual(s.runs.join(','), 'bg', 'resumeAction re-kicked the run');
        assert.strictEqual(s.runningChatIds.bg, true, 'the shim marked it running');
        assert.strictEqual(painted(t.dom), 'pause', 'running: Pause is painted right after the kick');
        assert.strictEqual(label(t.dom), 'Pause', 'label reads Pause');
    }, T);

    test("an action chat that is not displayed never paints the displayed chat's buttons", async function() {
        var t = await load(), s = t.s, m = t.m;
        s.currentChatId = 'a'; s.runningChatIds.a = true; s.runningChatIds.bg = true;
        assert.strictEqual(m.syncChatControlsUI(), 'pause', "precondition: 'a' shows Pause");
        var n = t.gets.n;
        await m.pauseAction('act1');
        assert.strictEqual(s.pausedChats.bg, true, 'bg paused');
        assert.strictEqual(t.gets.n, n, 'no DOM touch for the background chat');
        assert.strictEqual(painted(t.dom), 'pause', "'a' keeps Pause");
        assert.strictEqual(label(t.dom), 'Pause', "'a' keeps the Pause label");
        s.currentChatId = 'bg';
        assert.strictEqual(m.syncChatControlsUI(), 'resume', 'navigating into bg derives its Resume');
    }, T);

    test('deferred clears (dismiss, cross-tab delete) for a chat that is not displayed leave the buttons alone', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.currentChatId = 'a'; s.runningChatIds.a = true;
        assert.strictEqual(m.syncChatControlsUI(), 'pause', "precondition: 'a' shows Pause");
        var n = t.gets.n;
        bcSend(t, { type: 'delete', actionId: 'act1', chatId: 'bg' });
        s.activeActions.act2 = { actionId: 'act2', chatId: 'bg', state: 'running' };
        await m.dismissAction('act2');
        assert.strictEqual(fire(t, 5000), 2, 'both 5 s clears queued');
        assert.strictEqual(s.pausedChats.bg, undefined, 'transient halts cleared');
        assert.strictEqual(t.gets.n, n, 'no DOM touch');
        assert.strictEqual(painted(t.dom), 'pause', "'a' keeps Pause");
    }, T);

    test('the 120 guard: only the displayed chat is re-derived; label-only fallback without 020', async function() {
        var calls = [];
        var t = await load({ files: NO_020, globals: { syncChatControlsUI: function(id) { calls.push(id); return null; } } });
        var s = t.s, m = t.m;
        s.currentChatId = 'a';
        await m.pauseAction('act1'); await m.resumeAction('act1'); await m.stopAction('act1');
        bcSend(t, { type: 'pauseChat', actionId: 'act1', chatId: 'bg' });
        bcSend(t, { type: 'resumeChat', actionId: 'act1', chatId: 'bg' });
        await m.dismissAction('act1');
        assert.strictEqual(fire(t, 5000), 1, 'dismiss clear queued');
        assert.strictEqual(calls.length, 0, 'no derive for a chat that is not displayed: ' + calls.join(','));
        s.currentChatId = 'bg';
        s.activeActions.act2 = { actionId: 'act2', chatId: 'bg', state: 'running' };
        await m.pauseAction('act2');
        assert.strictEqual(calls.join(','), 'bg', 'displayed chat: one derive, scoped to it');
        var labels = [];
        var u = await load({ files: NO_020, globals: { syncPauseButtonUI: function(id) { labels.push(id); } } });
        await u.m.pauseAction('act1');
        assert.strictEqual(labels.join(','), 'bg', 'no syncChatControlsUI in the realm: label-only fallback');
    }, T);

    test('cross-tab pauseChat / resumeChat re-derive the displayed chat', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.bg = true;
        assert.strictEqual(m.syncChatControlsUI(), 'pause', 'precondition: Pause');
        bcSend(t, { type: 'pauseChat', actionId: 'act1', chatId: 'bg' });
        assert.strictEqual(s.pausedChats.bg, true, 'paused from another tab');
        assert.strictEqual(painted(t.dom), 'resume', 'Resume');
        bcSend(t, { type: 'resumeChat', actionId: 'act1', chatId: 'bg' });
        assert.strictEqual(s.pausedChats.bg, false, 'resumed from another tab');
        assert.strictEqual(painted(t.dom), 'pause', 'Pause');
        assert.strictEqual(label(t.dom), 'Pause', 'label reads Pause');
    }, T);

    test('cross-tab delete: the transient halt shows no control and its 5 s clear re-derives', async function() {
        var t = await load(), s = t.s, m = t.m;
        assert.strictEqual(m.syncChatControlsUI(), 'none', 'precondition: idle clean chat, no control');
        bcSend(t, { type: 'delete', actionId: 'act1', chatId: 'bg' });
        assert.strictEqual(s.pausedChats.bg, true, 'transient halt');
        assert.strictEqual(s.activeActions.act1, undefined, 'action dropped');
        assert.strictEqual(painted(t.dom), 'none', 'no (spurious) Resume while halted');
        assert.strictEqual(fire(t, 5000), 1, 'one 5 s clear queued');
        assert.strictEqual(s.pausedChats.bg, undefined, 'halt cleared');
        assert.strictEqual(painted(t.dom), 'none', 'still no control');
    }, T);

    test('dismissAction: the halt shows no control and the 5 s clear re-derives', async function() {
        var t = await load(), s = t.s, m = t.m;
        assert.strictEqual(m.syncChatControlsUI(), 'none', 'precondition: idle clean chat');
        await m.dismissAction('act1');
        assert.strictEqual(s.pausedChats.bg, true, 'transient halt');
        assert.strictEqual(painted(t.dom), 'none', 'no (spurious) Resume while halted');
        assert.strictEqual(fire(t, 5000), 1, 'one 5 s clear queued');
        assert.strictEqual(s.pausedChats.bg, undefined, 'halt cleared');
        assert.strictEqual(s.pushes[s.pushes.length - 1], 'bg:false', 'SW pause copy cleared');
        assert.strictEqual(painted(t.dom), 'none', 'still no control');
    }, T);

    test('dismissing a done action on the displayed idle chat never exposes Resume (no spurious turn)', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.activeActions.act1.state = 'done';
        s.chats.bg.messages.push({ role: 'user', content: 'tail' });
        var pre = m.syncChatControlsUI();
        assert.strictEqual(pre, 'continue', 'precondition: idle chat with a user tail shows Continue');
        var log = paintLog(t);
        await m.dismissAction('act1');
        assert.strictEqual(painted(t.dom), 'none', 'no control during the 5 s halt');
        assert.strictEqual(m.syncChatControlsUI(), 'none', 'a re-derive during the halt agrees');
        assert.strictEqual(fire(t, 5000), 1, 'one 5 s clear');
        assert.strictEqual(s._dismissHaltChats.bg, undefined, 'halt marker cleared');
        assert.strictEqual(painted(t.dom), pre, 'the timeout re-derives the pre-dismiss state');
        assert.ok(log.length > 0 && log.indexOf('resume') === -1, 'Resume (-> togglePause) never painted: ' + log.join(','));
        assert.strictEqual(s.runs.length, 0, 'no runAgent');
    }, T);

    test('dismissAction: a newer pause inside the 5 s window is not clobbered', async function() {
        var t = await load(), s = t.s, m = t.m;
        await m.dismissAction('act1');
        assert.strictEqual(painted(t.dom), 'none', 'no control while halted');
        s.activeActions.act2 = { actionId: 'act2', chatId: 'bg', state: 'running' };
        s.runningChatIds.bg = true;
        await m.pauseAction('act2');
        assert.strictEqual(painted(t.dom), 'resume', 'the new pause paints Resume');
        var pushes = s.pushes.length;
        assert.strictEqual(fire(t, 5000), 1, 'the stale 5 s clear fires');
        assert.strictEqual(s.pausedChats.bg, true, 'the newer pause survives');
        assert.strictEqual(s.chats.bg.pausedByUser, true, 'record still paused');
        assert.strictEqual(s.pushes.length, pushes, 'no stale SW unpause push');
        assert.strictEqual(painted(t.dom), 'resume', 'Resume stays');
        assert.strictEqual(m.syncChatControlsUI(), 'resume', 'a re-derive agrees');
    }, T);

    test('a stopped action chat shows no control, running or idle', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.bg = true;
        await m.stopAction('act1');
        var a = s.activeActions.act1;
        assert.strictEqual(a.state, 'stopped', 'action stopped');
        assert.strictEqual(a._isPaused, false, 'stopAction clears the action _isPaused');
        assert.strictEqual(s.pausedChats.bg, true, '...but the chat stays paused (soft-stop halt)');
        assert.strictEqual(s.chats.bg.pausedByUser, true, 'pausedByUser persisted');
        assert.strictEqual(painted(t.dom), 'none', 'running + stop halt: no control (the halt is not a user pause)');
        delete s.runningChatIds.bg;
        s.chats.bg.messages.push({ role: 'user', content: 'more' });
        s.chats.bg._lastApiError = 'boom';
        assert.strictEqual(m.syncChatControlsUI(), 'none', 'idle, user tail, errored: still no control (no Resume / Continue / Retry)');
    }, T);

    test('stopped action (i): pause then stop while running; Resume goes away and stays away when the loop exits', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.bg = true;
        await m.pauseAction('act1');
        assert.strictEqual(painted(t.dom), 'resume', 'precondition: the paused running action shows Resume');
        await m.stopAction('act1');
        var a = s.activeActions.act1;
        assert.strictEqual(a._isPaused, false, 'stop clears _isPaused');
        assert.strictEqual(a.state, 'stopped', 'action stopped');
        assert.strictEqual(s.pausedChats.bg, true, 'chat still halted');
        assert.strictEqual(painted(t.dom), 'none', 'the stop removes Resume');
        delete s.runningChatIds.bg;
        assert.strictEqual(m.syncChatControlsUI(), 'none', 'loop exited: still no control');
    }, T);

    test('stopped action (ii): boot restores the stopped record; selecting the halted chat shows no control', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.currentChatId = null;   // core/120-init:594 loadAllActionStates runs before selectChat (:632-635)
        delete s.activeActions.act1;
        s.chats.bg.pausedByUser = true;
        s.pausedChats.bg = true;
        s.actionStateStoreName = 'action_state';
        s.openDatabase = async function() { return { transaction: function() { return { objectStore: function() { return {
            getAll: function() { var r = {}; Promise.resolve().then(function() { r.result = [{ actionId: 'act1', chatId: 'bg', state: 'stopped', _isPaused: false }]; if (r.onsuccess) r.onsuccess(); }); return r; } }; } }; } }; };
        await m.loadAllActionStates();
        assert.strictEqual(s.activeActions.act1 && s.activeActions.act1.state, 'stopped', 'the stopped record is restored as-is (120:186)');
        s.currentChatId = 'bg';
        assert.strictEqual(m.syncChatControlsUI('bg'), 'none', 'selectChat after boot: no Resume');
    }, T);

    test('stopped action (iii): dismiss derives before the delete; a re-used actionId follows its record chat', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.bg = true;
        await m.stopAction('act1');
        delete s.runningChatIds.bg;
        await m.dismissAction('act1');
        assert.strictEqual(painted(t.dom), 'none', 'dismiss derives (120:866) before it deletes the record (:879)');
        assert.strictEqual(s.activeActions.act1, undefined, 'record deleted');
        s.chats.bg2 = mkChat('bg2', { isBackground: true, actionId: 'act1' });
        s.activeActions.act1 = { actionId: 'act1', chatId: 'bg2', state: 'running' };
        s.runningChatIds.bg2 = true;
        s.currentChatId = 'bg2';
        assert.strictEqual(m.syncChatControlsUI(), 'pause', 'the re-used actionId runs on bg2: Pause');
        await m.stopAction('act1');
        assert.strictEqual(painted(t.dom), 'none', 'stopping it on bg2: no control');
        s.chats.bg.messages.push({ role: 'user', content: 'more' });
        s.currentChatId = 'bg';
        assert.strictEqual(m.syncChatControlsUI(), 'none', "bg is not the record's chat (bg2), but its dismiss halt still shows no control");
        assert.strictEqual(fire(t, 5000), 1, "dismiss's 5 s halt clear fires");
        assert.strictEqual(painted(t.dom), 'continue', 'halt cleared: normal rules (user tail -> Continue)');
    }, T);

    test('stopped action (iv): a send / Resume clears the halt and the normal rules apply (local lane, cross-tab resumeChat)', async function() {
        var t = await load(), s = t.s, m = t.m;
        await m.stopAction('act1');
        assert.strictEqual(painted(t.dom), 'none', 'stopped, idle: no control');
        s.chats.bg.messages.push({ role: 'user', content: 'more' });
        m.setChatPausedPersistent('bg', false);
        assert.strictEqual(m.syncChatControlsUI(), 'continue', 'pause cleared: user tail -> Continue');
        s.chats.bg._lastApiError = 'boom';
        assert.strictEqual(m.syncChatControlsUI(), 'retry', 'pause cleared + error: Retry');
        var u = await load();
        await u.m.stopAction('act1');
        assert.strictEqual(painted(u.dom), 'none', 'fresh load: stopped, idle: no control');
        u.s.chats.bg.messages.push({ role: 'user', content: 'more' });
        bcSend(u, { type: 'resumeChat', actionId: 'act1', chatId: 'bg' });
        assert.strictEqual(painted(u.dom), 'continue', 'cross-tab resumeChat: Continue');
        u.s.chats.bg._lastApiError = 'boom';
        assert.strictEqual(u.m.syncChatControlsUI(), 'retry', 'cross-tab resumeChat + error: Retry');
    }, T);

    test('stopped action (v): cross-tab stop; pauseChat derives from the stale record, the update reload re-derives to no control', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.bg = true;
        s.actionStateStoreName = 'action_state';
        var REC = { actionId: 'act1', chatId: 'bg', state: 'stopped', _isPaused: false };
        s.openDatabase = async function() { return { transaction: function() { return { objectStore: function() { return {
            get: function() { var r = {}; Promise.resolve().then(function() { r.result = REC; if (r.onsuccess) r.onsuccess(); }); return r; } }; } }; } }; };
        bcSend(t, { type: 'pauseChat', actionId: 'act1', chatId: 'bg' });
        assert.strictEqual(painted(t.dom), 'resume', 'pauseChat derives against the stale running record: Resume');
        bcSend(t, { type: 'update', actionId: 'act1', chatId: 'bg' });
        for (var i = 0; i < 20; i++) await Promise.resolve();
        assert.strictEqual(s.activeActions.act1.state, 'stopped', 'the stopped record is reloaded (120:241)');
        assert.strictEqual(painted(t.dom), 'none', 'the reload re-derives (120:258): no control');
    }, T);

    test('stopped action (vii): stopAction re-derives before its persist await, so no Resume lingers at the synchronous return', async function() {
        // (a) paused + idle: pauseAction painted Resume; the stop's pause write is a no-op (030 guard), so no lane repaint.
        var t = await load({ laneRepaint: true }), m = t.m;
        await m.pauseAction('act1');
        assert.strictEqual(painted(t.dom), 'resume', 'precondition (a): paused idle action shows Resume');
        var log = paintLog(t);
        var p = m.stopAction('act1');
        var at = painted(t.dom), l = log.slice();
        await p;
        assert.strictEqual(at, 'none', '(a) no control at the synchronous return; paints ' + JSON.stringify(l));
        assert.strictEqual(l.indexOf('resume'), -1, '(a) no Resume painted by the stop; paints ' + JSON.stringify(l));
        assert.strictEqual(painted(t.dom), 'none', '(a) none after the await');
        // (b) running: the lane repaint inside the pause write (120:796, state still running) paints Resume.
        var u = await load({ laneRepaint: true });
        u.s.runningChatIds.bg = true;
        assert.strictEqual(u.m.syncChatControlsUI(), 'pause', 'precondition (b): running action shows Pause');
        var log2 = paintLog(u);
        var p2 = u.m.stopAction('act1');
        var at2 = painted(u.dom), l2 = log2.slice();
        await p2;
        assert.strictEqual(at2, 'none', '(b) no control at the synchronous return; paints ' + JSON.stringify(l2));
        assert.strictEqual(l2[l2.length - 1], 'none', '(b) the last paint before the await is none; paints ' + JSON.stringify(l2));
        l2.forEach(function(v, i) {
            if (v === 'resume') assert.strictEqual(l2.indexOf('none', i + 1) > i, true, '(b) every Resume is followed by none; paints ' + JSON.stringify(l2));
        });
        assert.strictEqual(painted(u.dom), 'none', '(b) none after the await');
    }, T);

    test('static: stopAction re-derives the displayed chat between the stopped write and the persist await', async function() {
        var src = await loadFile('src/js/tools/120-actions.js');
        var start = src.indexOf('async function stopAction(actionId) {');
        assert.strictEqual(start >= 0, true, 'stopAction found');
        var body = src.slice(start, src.indexOf('\n}\n', start) + 2);
        var w = body.indexOf("a.state = 'stopped';"), d = body.indexOf('_syncChatPagePauseUIForChat(a.chatId);'), p = body.indexOf('await persistActionState(actionId);');
        assert.strictEqual(w >= 0 && p >= 0, true, 'stopped write and persist await found');
        assert.strictEqual(w < d && d < p, true, 'order: stopped write < derive < persist await (w=' + w + ' d=' + d + ' p=' + p + ')');
    }, T);

    test('static: _syncChatPagePauseUIForChat keeps the displayed-chat guard and the typeof-guarded derive', async function() {
        var src = await loadFile('src/js/tools/120-actions.js');
        var start = src.indexOf('function _syncChatPagePauseUIForChat(chatId) {');
        assert.strictEqual(start >= 0, true, 'function found');
        var body = src.slice(start, src.indexOf('\n}\n', start) + 2);
        assert.strictEqual(body.indexOf("if (!chatId || typeof currentChatId === 'undefined' || chatId !== currentChatId) return;") >= 0, true, 'displayed-chat guard');
        assert.strictEqual(body.indexOf("if (typeof syncChatControlsUI === 'function') syncChatControlsUI(chatId);") >= 0, true, 'typeof-guarded derive');
        assert.strictEqual(body.indexOf("else if (typeof syncPauseButtonUI === 'function') syncPauseButtonUI(chatId);") >= 0, true, 'label-only fallback');
    }, T);
});
