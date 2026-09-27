// CHAT-CONTROLS SSOT (fix for "the Continue and Pause buttons seem to be randomly
// shown"): syncChatControlsUI (app/020-api-messages.js) is the ONE writer of
// #pause-btn / #continue-btn / #retry-btn visibility + the Pause/Resume label.
// Real 020 via loadModules; only the DOM (three fake buttons), chrome and the
// run/pause plumbing (runAgent shim, setChatPausedPersistent, dispatchChatMeta)
// are stubbed. An independent oracle (below) encodes the contract:
//   not the chat view -> none; non-displayed chatId -> no-op;
//   pause (running|held, not silent hook; Resume label when paused) >
//   none (idle sub-agent: parked subs are not in the page's pausedChats) >
//   resume (paused, idle) > retry (error, idle) >
//   continue (interrupted tail) > none.
var T = { tags: ['unit'], timeout: 15000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };

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
function tail(interrupted) {
    return interrupted
        ? [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'x', arguments: '{}' } }] }]
        : [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }];
}
// `_interrupted` is read by the ORACLE only; the real code inspects the messages.
function mkChat(id, o) { return Object.assign({ id: id, title: id, messages: tail(false), _interrupted: false }, o || {}); }
function setTail(c, interrupted) { c.messages = tail(interrupted); c._interrupted = interrupted; }

async function load(extra) {
    var btns = { 'pause-btn': fakeButton('pause-btn'), 'continue-btn': fakeButton('continue-btn'), 'retry-btn': fakeButton('retry-btn') };
    var doc = fakeDocument(btns);
    var m = await loadModules(['src/js/app/020-api-messages.js'], { lenient: true, globals: {
        window: fakeWindow({ document: doc }), chrome: fakeChrome(), document: doc, console: quiet } });
    var s = m.__scope;
    s.chats = { a: mkChat('a'), b: mkChat('b'), s: mkChat('s', { isSubAgent: true }) };
    s.currentChatId = 'a';
    s.currentView = 'chat';
    s.runningChatIds = {};
    s.pausedChats = {};
    s.paused = false;
    s.lastApiError = null;
    s.UI_ICONS = { play: '', pause: '' };
    s.currentStreamAbortControllers = {};
    s.interruptResolversByChatId = {};
    s.runs = [];
    // Mirrors the runAgent shim (app/045): runningChatIds is set synchronously.
    s.runAgent = function(id) { var cid = id || s.currentChatId; if (cid) s.runningChatIds[cid] = true; s.runs.push(cid); return Promise.resolve(); };
    s.setChatPausedPersistent = function(id, v) { if (v) s.pausedChats[id] = true; else delete s.pausedChats[id]; };
    s.dispatchChatMeta = function(id, patch) { if (s.chats[id]) Object.assign(s.chats[id], patch); };
    s.hideSnackbar = function() {};
    Object.assign(s, extra || {});
    return { m: m, s: s, dom: { pause: btns['pause-btn'], cont: btns['continue-btn'], retry: btns['retry-btn'] } };
}

// What the DOM shows. More than one visible control is reported as MULTI(...).
function painted(dom) {
    var p = dom.pause.classList.contains('visible'), c = dom.cont.classList.contains('visible'), r = dom.retry.classList.contains('visible');
    if ((p ? 1 : 0) + (c ? 1 : 0) + (r ? 1 : 0) > 1) return 'MULTI(' + [p && 'pause', c && 'continue', r && 'retry'].filter(Boolean).join('+') + ')';
    if (p) return /Resume/.test(dom.pause.innerHTML) ? 'resume' : 'pause';
    if (c) return 'continue';
    if (r) return 'retry';
    return 'none';
}
// Independent oracle for the displayed chat (the contract, not the implementation).
function oracle(s) {
    if (s.currentView !== 'chat') return 'none';
    var id = s.currentChatId, c = id && s.chats[id];
    if (!c) return 'none';
    var held = typeof s.isChatControlsHeld === 'function' && !!s.isChatControlsHeld(id);
    var running = !!s.runningChatIds[id] || held;
    var pausedNow = s.pausedChats[id] === true;
    if (running) {
        if (typeof s._isChatInSilentHook === 'function' && s._isChatInSilentHook(id)) return 'none';
        return pausedNow ? 'resume' : 'pause';
    }
    if (c.isSubAgent) return 'none';   // idle sub-agent: no control, its parent resumes it
    if (pausedNow) return 'resume';
    if ((s.lastApiError && s.lastApiError.chatId === id) || c._lastApiError) return 'retry';
    return c._interrupted ? 'continue' : 'none';
}

describe('syncChatControlsUI derive (app/020-api-messages.js)', function() {
    test('fixtures: the interrupted/clean tails match isChatInterrupted', async function() {
        var t = await load();
        assert.strictEqual(typeof t.m.syncChatControlsUI, 'function', 'syncChatControlsUI is a global in 020');
        assert.strictEqual(t.m.isChatInterrupted(t.s.chats.a), false, 'clean tail');
        setTail(t.s.chats.a, true);
        assert.strictEqual(t.m.isChatInterrupted(t.s.chats.a), true, 'unanswered tool_call tail');
    }, T);

    test('every arm paints exactly one control (or none) and returns its state', async function() {
        var t = await load(), s = t.s, m = t.m;
        function expect(state, msg) {
            assert.strictEqual(m.syncChatControlsUI('a'), state, msg + ' (return)');
            assert.strictEqual(painted(t.dom), state, msg + ' (DOM)');
        }
        expect('none', 'idle clean chat');
        s.runningChatIds.a = true; expect('pause', 'running');
        assert.strictEqual(/Pause/.test(t.dom.pause.innerHTML), true, 'label reads Pause');
        s.pausedChats.a = true; expect('resume', 'running + paused: Pause button labelled Resume');
        delete s.runningChatIds.a; expect('resume', 'idle paused non-sub chat: Resume');
        delete s.pausedChats.a; setTail(s.chats.a, true); expect('continue', 'interrupted tail');
        assert.strictEqual(t.dom.cont.title, 'Resume the interrupted run', 'R6 Continue title');
        s.lastApiError = { chatId: 'a', message: 'x' }; expect('retry', 'API error beats Continue');
        assert.strictEqual(t.dom.retry.title, 'Retry the failed request', 'R6 Retry title');
        s.lastApiError = { chatId: 'b', message: 'x' }; expect('continue', "another chat's global error is ignored");
        s.chats.a._lastApiError = { message: 'persisted' }; expect('retry', 'persisted per-chat error');
        s.chats.a._lastApiError = null; setTail(s.chats.a, false); expect('none', 'clean again');
    }, T);

    test('non-displayed chatId is a no-op (RC4), incl. the legacy primitives; no chat -> none', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.a = true;
        assert.strictEqual(m.syncChatControlsUI('a'), 'pause');
        setTail(s.chats.b, true); s.chats.b._lastApiError = { message: 'b failed' };
        assert.strictEqual(m.syncChatControlsUI('b'), null, 'background chat derive returns null');
        assert.strictEqual(painted(t.dom), 'pause', 'displayed chat keeps its Pause');
        assert.strictEqual(m.refreshContinueButtonForChat('b'), null, 'refreshContinueButtonForChat(bg) is a no-op');
        assert.strictEqual(painted(t.dom), 'pause', 'still Pause after the background refresh');
        delete s.runningChatIds.a;
        assert.strictEqual(m.syncChatControlsUI(), 'none', 'no-arg call derives the displayed chat');
        s.runningChatIds.b = true;
        m.showPauseButton('b');
        assert.strictEqual(painted(t.dom), 'none', "RC4: a background chat's showPauseButton cannot paint Pause");
        m.showPauseButton('a');
        assert.strictEqual(painted(t.dom), 'pause', 'raw primitive still works for the displayed chat');
        s.currentChatId = null;
        assert.strictEqual(m.syncChatControlsUI(), 'none', 'no displayed chat: none');
        assert.strictEqual(painted(t.dom), 'none', 'no displayed chat: all hidden');
        assert.strictEqual(m.syncChatControlsUI('a'), null, 'chatId given but nothing displayed: no-op');
    }, T);

    test('non-chat views hide all three; returning to chat repaints', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.a = true;
        assert.strictEqual(m.syncChatControlsUI('a'), 'pause');
        ['home', 'settings-page', 'docs', 'history', 'dashboard'].forEach(function(v) {
            s.currentView = v;
            assert.strictEqual(m.syncChatControlsUI('a'), 'none', v + ': state none');
            assert.strictEqual(painted(t.dom), 'none', v + ': all hidden');
        });
        s.currentView = 'home';
        m.syncChatControlsUI('a');
        assert.strictEqual(m.syncChatControlsUI('b'), 'none', 'view check precedes the no-op check');
        s.currentView = 'chat';
        assert.strictEqual(m.syncChatControlsUI(), 'pause', 'back on the chat view');
        assert.strictEqual(painted(t.dom), 'pause', 'Pause repainted on return');
    }, T);

    test('showChatView carries the typeof-guarded derive call (every return-to-chat path)', async function() {
        var src = await loadFile('src/js/ui/040-tools-settings.js');
        var start = src.indexOf('function showChatView() {');
        assert.strictEqual(start >= 0, true, 'showChatView found');
        var body = src.slice(start, src.indexOf('\n}\n', start));
        assert.strictEqual(body.indexOf("if (typeof syncChatControlsUI === 'function') syncChatControlsUI(") >= 0, true, 'derive call inside showChatView');
    }, T);

    test('isChatControlsHeld hook: a held, non-running chat shows Pause (not Retry/Continue)', async function() {
        var t = await load({ isChatControlsHeld: function(id) { return id === 'a'; } }), s = t.s, m = t.m;
        setTail(s.chats.a, true); s.lastApiError = { chatId: 'a', message: 'x' };
        assert.strictEqual(s.runningChatIds.a, undefined, 'not in runningChatIds');
        assert.strictEqual(m.syncChatControlsUI('a'), 'pause', 'held counts as running');
        assert.strictEqual(painted(t.dom), 'pause', 'only Pause visible');
        s.pausedChats.a = true;
        assert.strictEqual(m.syncChatControlsUI('a'), 'resume', 'held + paused: Resume label');
        s.currentChatId = 'b';
        assert.strictEqual(m.syncChatControlsUI('b'), 'none', 'hook is per chat');
    }, T);

    test('silent after-response hook run shows no Pause', async function() {
        var t = await load({ _isChatInSilentHook: function(id) { return id === 'a'; } }), s = t.s, m = t.m;
        s.runningChatIds.a = true; setTail(s.chats.a, true);
        assert.strictEqual(m.syncChatControlsUI('a'), 'none', 'silent hook run: none');
        assert.strictEqual(painted(t.dom), 'none', 'no Pause, no Continue');
        delete s.runningChatIds.a;
        assert.strictEqual(m.syncChatControlsUI('a'), 'continue', 'hook ended: true interrupted state shows');
    }, T);

    test('paused sub-agent shows no Resume (a parked sub is resumed by its parent)', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.currentChatId = 's'; s.pausedChats.s = true;
        assert.strictEqual(m.syncChatControlsUI('s'), 'none', 'idle paused sub: none');
        setTail(s.chats.s, true); s.chats.s._lastApiError = { message: 'x' };
        assert.strictEqual(m.syncChatControlsUI('s'), 'none', 'still none when interrupted/errored');
        assert.strictEqual(painted(t.dom), 'none', 'all hidden');
        s.currentChatId = 'a'; s.pausedChats.a = true;
        assert.strictEqual(m.syncChatControlsUI('a'), 'resume', 'a paused NON-sub chat does show Resume');
    }, T);

    // Idle sub-agent rule: the page's pausedChats does NOT mirror a parked sub (the park is
    // SW-realm only) and after report_to_parent a sub transcript ends on role:'tool', which
    // isChatInterrupted reads as interrupted. Without the rule every parked sub showed Continue.
    function reportedTail() {
        return [{ role: 'user', content: 'task' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'report_to_parent', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'r1', name: 'report_to_parent', content: '{"success":true}' }];
    }

    test('idle sub-agent, interrupted transcript, not in pausedChats -> none, Continue hidden', async function() {
        var t = await load(), s = t.s, m = t.m;
        setTail(s.chats.a, true);
        assert.strictEqual(m.syncChatControlsUI('a'), 'continue', 'precondition: Continue painted on a non-sub');
        s.currentChatId = 's'; s.chats.s.messages = reportedTail(); s.chats.s._interrupted = true;
        assert.strictEqual(m.isChatInterrupted(s.chats.s), true, 'fixture: a report_to_parent tail reads as interrupted');
        assert.strictEqual(s.pausedChats.s, undefined, 'fixture: the SW-only park is not mirrored in pausedChats');
        assert.strictEqual(m.syncChatControlsUI('s'), 'none', 'report_to_parent tail on an idle sub: none');
        assert.strictEqual(t.dom.cont.classList.contains('visible'), false, 'Continue hidden');
        setTail(s.chats.s, true);
        assert.strictEqual(m.syncChatControlsUI('s'), 'none', 'unanswered tool_call tail on an idle sub: none');
        assert.strictEqual(m.refreshContinueButtonForChat('s'), 'none', 'legacy alias agrees');
        assert.strictEqual(painted(t.dom), 'none', 'all hidden');
    }, T);

    test('idle sub-agent with an API error -> none, Retry hidden', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.chats.a._lastApiError = { message: 'x' };
        assert.strictEqual(m.syncChatControlsUI('a'), 'retry', 'precondition: Retry painted on a non-sub');
        s.currentChatId = 's'; s.chats.s._lastApiError = { message: '429' };
        assert.strictEqual(m.syncChatControlsUI('s'), 'none', 'persisted _lastApiError on an idle sub: none');
        assert.strictEqual(t.dom.retry.classList.contains('visible'), false, 'Retry hidden');
        s.chats.s._lastApiError = null; s.lastApiError = { chatId: 's', message: '429' };
        assert.strictEqual(m.syncChatControlsUI('s'), 'none', 'global lastApiError for an idle sub: none');
        assert.strictEqual(painted(t.dom), 'none', 'all hidden');
    }, T);

    test('a running sub-agent still shows Pause; at run end it shows nothing', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.currentChatId = 's'; s.runningChatIds.s = true;
        setTail(s.chats.s, true); s.chats.s._lastApiError = { message: 'x' };
        assert.strictEqual(m.syncChatControlsUI('s'), 'pause', 'running sub: Pause');
        assert.strictEqual(painted(t.dom), 'pause', 'only Pause painted');
        assert.strictEqual(/Pause/.test(t.dom.pause.innerHTML), true, 'label reads Pause');
        delete s.runningChatIds.s;
        assert.strictEqual(m.syncChatControlsUI('s'), 'none', 'run end on an errored, interrupted sub: none');
        assert.strictEqual(painted(t.dom), 'none', 'all hidden once the sub is idle');
    }, T);

    test('no regression: a non-sub interrupted chat still shows Continue', async function() {
        var t = await load(), s = t.s, m = t.m;
        setTail(s.chats.a, true);
        assert.strictEqual(m.syncChatControlsUI('a'), 'continue', 'unanswered tool_call tail on a non-sub: Continue');
        assert.strictEqual(painted(t.dom), 'continue', 'only Continue painted');
        s.chats.a.messages = reportedTail();
        assert.strictEqual(m.syncChatControlsUI('a'), 'continue', 'the same tool-tailed transcript on a non-sub: Continue');
        assert.strictEqual(t.dom.cont.classList.contains('visible'), true, 'Continue visible');
    }, T);

    test('no regression: a non-sub chat with _lastApiError, not running -> Retry', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.chats.a._lastApiError = { message: 'persisted' };
        assert.strictEqual(m.syncChatControlsUI('a'), 'retry', 'idle errored non-sub (clean tail): Retry');
        setTail(s.chats.a, true);
        assert.strictEqual(m.syncChatControlsUI('a'), 'retry', 'idle errored non-sub (interrupted tail): Retry beats Continue');
        assert.strictEqual(painted(t.dom), 'retry', 'only Retry painted');
        assert.strictEqual(t.dom.retry.title, 'Retry the failed request', 'R6 Retry title');
    }, T);

    test('Retry beats Continue; Retry is hidden while running and appears at run end', async function() {
        var t = await load(), s = t.s, m = t.m;
        setTail(s.chats.a, true); s.lastApiError = { chatId: 'a', message: '429' };
        assert.strictEqual(m.syncChatControlsUI('a'), 'retry', 'retry over continue');
        s.runningChatIds.a = true;
        assert.strictEqual(m.syncChatControlsUI('a'), 'pause', 'error mid-run keeps Pause up');
        assert.strictEqual(t.dom.retry.classList.contains('visible'), false, 'Retry hidden while running');
        delete s.runningChatIds.a;
        assert.strictEqual(m.syncChatControlsUI('a'), 'retry', 'run end: Retry');
        assert.strictEqual(t.dom.cont.classList.contains('visible'), false, 'Continue hidden alongside Retry');
    }, T);

    test('click handlers repaint from state (togglePause both ways, continueAgent, retryLastCall, retryChat)', async function() {
        var t = await load(), s = t.s, m = t.m;
        s.runningChatIds.a = true; m.syncChatControlsUI('a');
        m.togglePause();
        assert.strictEqual(s.pausedChats.a, true, 'paused');
        assert.strictEqual(painted(t.dom), 'resume', 'Pause click: Resume while the loop exits');
        delete s.runningChatIds.a; m.syncChatControlsUI('a');
        assert.strictEqual(painted(t.dom), 'resume', 'loop exited: idle paused chat keeps Resume');
        m.togglePause();
        assert.strictEqual(s.runs.join(','), 'a', 'Resume kicked one run');
        assert.strictEqual(painted(t.dom), 'pause', 'Resume click: Pause with no flash (shim marks running synchronously)');
        // Resume while the old loop is still exiting: no new run, Pause stays, no dead Pause after it ends.
        s.pausedChats.a = true; m.syncChatControlsUI('a');
        m.togglePause();
        assert.strictEqual(s.runs.length, 1, 'no second run while still running');
        assert.strictEqual(painted(t.dom), 'pause', 'still running + unpaused: Pause');
        delete s.runningChatIds.a; m.syncChatControlsUI('a');
        assert.strictEqual(painted(t.dom), 'none', 'run end: no dead Pause');
        // Continue
        setTail(s.chats.a, true); m.syncChatControlsUI('a');
        assert.strictEqual(painted(t.dom), 'continue');
        m.continueAgent();
        assert.strictEqual(painted(t.dom), 'pause', 'Continue click: Pause');
        // Retry (global error)
        delete s.runningChatIds.a; s.lastApiError = { chatId: 'a', message: '429' }; m.syncChatControlsUI('a');
        assert.strictEqual(painted(t.dom), 'retry');
        m.retryLastCall();
        assert.strictEqual(s.lastApiError, null, 'error consumed');
        assert.strictEqual(painted(t.dom), 'pause', 'Retry click: Pause, Retry and Continue gone');
        // Retry for a persisted per-chat error only: never a dead button
        delete s.runningChatIds.a; s.chats.a._lastApiError = { message: 'persisted' }; m.syncChatControlsUI('a');
        assert.strictEqual(painted(t.dom), 'retry');
        var before = s.runs.length;
        m.retryLastCall();
        assert.strictEqual(s.runs.length, before + 1, 'persisted error retried via retryChat');
        assert.strictEqual(s.chats.a._lastApiError, null, 'persisted error cleared');
        assert.strictEqual(painted(t.dom), 'pause', 'Pause after the fallback retry');
        // retryChat for a BACKGROUND chat leaves the displayed chat's controls alone
        delete s.runningChatIds.a; m.syncChatControlsUI('a');
        assert.strictEqual(painted(t.dom), 'continue');
        s.chats.b._lastApiError = { message: 'bg' };
        m.retryChat('b');
        assert.strictEqual(s.runningChatIds.b, true, 'background chat re-run');
        assert.strictEqual(painted(t.dom), 'continue', "displayed chat's Continue untouched");
    }, T);

    test('seeded fuzz (>=200 events, until every arm is covered): one control at most, DOM always equals the derive of the displayed chat', async function() {
        var SEED = 20260926;
        var held = {}, silent = {};
        var t = await load({
            isChatControlsHeld: function(id) { return !!held[id]; },
            _isChatInSilentHook: function(id) { return !!silent[id]; }
        }), s = t.s, m = t.m;
        var a = SEED >>> 0;
        function rnd() { a = (a + 0x6D2B79F5) >>> 0; var x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }
        function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
        var IDS = ['a', 'b', 's'];
        var EVENTS = ['start', 'finish', 'pause', 'unpause', 'error', 'clearErr', 'interrupt', 'clean', 'silent', 'hold',
            'select', 'view', 'leak', 'click', 'click', 'finish', 'start'];
        var seen = {};
        m.syncChatControlsUI();
        // At least 200 steps (the original run, unchanged), then on until every arm has been
        // seen (cap 2000). The idle-sub rule means chat 's' never reaches Continue, and this
        // seed then needs more than 400 steps to reach the continue arm on 'a'/'b'.
        var ARMS = ['pause', 'resume', 'retry', 'continue', 'none'];
        function allArmsSeen() { return ARMS.every(function(k) { return (seen[k] || 0) > 0; }); }
        for (var i = 0; i < 2000 && (i < 200 || !allArmsSeen()); i++) {
            var ev = pick(EVENTS), x = pick(IDS);
            switch (ev) {
                case 'start': s.runningChatIds[x] = true; m.syncChatControlsUI(x); break;       // runStarted
                case 'finish': delete s.runningChatIds[x]; m.syncChatControlsUI(x); break;      // runFinished
                case 'pause': s.pausedChats[x] = true; m.syncChatControlsUI(x); break;          // popover/broadcast flip
                case 'unpause': delete s.pausedChats[x]; m.syncChatControlsUI(x); break;
                case 'error':                                                                  // the global tracks the focused chat
                    if (x === s.currentChatId && rnd() < 0.5) s.lastApiError = { chatId: x, message: 'e' + i };
                    else s.chats[x]._lastApiError = { message: 'e' + i };
                    m.syncChatControlsUI(x); break;
                case 'clearErr':
                    if (s.lastApiError && s.lastApiError.chatId === x) s.lastApiError = null;
                    s.chats[x]._lastApiError = null; m.syncChatControlsUI(x); break;
                case 'interrupt': setTail(s.chats[x], true); m.syncChatControlsUI(x); break;
                case 'clean': setTail(s.chats[x], false); m.syncChatControlsUI(x); break;
                case 'silent': silent[x] = !silent[x]; m.syncChatControlsUI(x); break;
                case 'hold': held[x] = !held[x]; m.syncChatControlsUI(x); break;
                case 'select':                                                                 // selectChat
                    s.currentChatId = x;
                    s.lastApiError = s.chats[x]._lastApiError ? { chatId: x, message: 'restored' } : null;
                    m.syncChatControlsUI(x); break;
                case 'view': s.currentView = pick(['chat', 'chat', 'home', 'settings-page', 'docs']); m.syncChatControlsUI(); break;
                case 'leak':                                                                   // legacy background writers
                    var y = pick(IDS.filter(function(k) { return k !== s.currentChatId; }));
                    if (rnd() < 0.5) m.showPauseButton(y); else m.refreshContinueButtonForChat(y);
                    break;
                case 'click':
                    if (s.currentView !== 'chat') break;
                    var shown = painted(t.dom);
                    if (shown === 'pause' || shown === 'resume') m.togglePause();
                    else if (shown === 'continue') m.continueAgent();
                    else if (shown === 'retry') m.retryLastCall();
                    break;
            }
            var got = painted(t.dom), want = oracle(s), where = 'seed ' + SEED + ' step ' + i + ' ' + ev + ':' + x;
            var pv = t.dom.pause.classList.contains('visible'), cv = t.dom.cont.classList.contains('visible'), rv = t.dom.retry.classList.contains('visible');
            assert.strictEqual(pv && cv, false, 'Pause+Continue both visible at ' + where);
            assert.strictEqual(rv && cv, false, 'Retry+Continue both visible at ' + where);
            assert.strictEqual(pv && rv, false, 'Pause+Retry both visible at ' + where);
            assert.strictEqual(got, want, 'DOM != derive at ' + where);
            seen[want] = (seen[want] || 0) + 1;
        }
        ['pause', 'resume', 'retry', 'continue', 'none'].forEach(function(k) {
            assert.strictEqual((seen[k] || 0) > 0, true, 'fuzz covered the ' + k + ' arm (' + JSON.stringify(seen) + ')');
        });
    }, T);
});
