// CHAT-CONTROLS HOLD (app/045 _chatControlsHeld, RC1): a bus disconnect wipes
// runningChatIds with no terminal event, and the hello down-reconcile drops ids
// the SW may re-add within the REG-F1 grace. 045 holds those chats so the app/020
// derive (_chatControlsState) keeps them "running": Pause neither vanishes nor
// flips to Continue until a hello lists the chat, its own runStarted/runFinished/
// runCrashed, the grace decision, or the 15s no-hello timer ends the hold.
// Real 020 + 045 through ONE loadModules call (shared scope, so 020's typeof
// guard resolves 045's isChatControlsHeld). Faked: the three DOM buttons (every
// class/label write is logged, so a one-tick Continue flash is caught), the
// chrome.runtime bus ports, and timers (recorded, fired by hand). selectChat
// (ui/170, not loaded) is simulated: currentChatId + currentView + one derive.
var T = { tags: ['unit'], timeout: 20000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };

function fakeButton(id, log) {
    var cls = {}, html = '';
    var b = { id: id, title: '', textContent: '', style: {},
        classList: {
            add: function(c) { cls[c] = true; log.push({ id: id, op: 'add', cls: c }); },
            remove: function(c) { delete cls[c]; log.push({ id: id, op: 'remove', cls: c }); },
            contains: function(c) { return !!cls[c]; } } };
    Object.defineProperty(b, 'innerHTML', { enumerable: true,
        get: function() { return html; }, set: function(v) { html = String(v); log.push({ id: id, op: 'html', value: html }); } });
    return b;
}
function fakeDocument(btns) {
    return { addEventListener: function() {}, removeEventListener: function() {},
        querySelector: function() { return null; }, querySelectorAll: function() { return []; },
        getElementById: function(id) { return btns[id] || null; },
        createElement: function() { return fakeButton('x', []); }, body: fakeButton('body', []) };
}
function tail(interrupted) {
    return interrupted
        ? [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'x', arguments: '{}' } }] }]
        : [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }];
}
function mkChat(id) { return { id: id, title: id, messages: tail(false) }; }
// What the DOM shows. More than one visible control is reported as MULTI(...).
function painted(dom) {
    var p = dom.pause.classList.contains('visible'), c = dom.cont.classList.contains('visible'), r = dom.retry.classList.contains('visible');
    if ((p ? 1 : 0) + (c ? 1 : 0) + (r ? 1 : 0) > 1) return 'MULTI(' + [p && 'pause', c && 'continue', r && 'retry'].filter(Boolean).join('+') + ')';
    if (p) return /Resume/.test(dom.pause.innerHTML) ? 'resume' : 'pause';
    if (c) return 'continue';
    if (r) return 'retry';
    return 'none';
}
// The lane field lists live in core/030 (not loaded): read them from source.
async function laneFieldLists() {
    var cfg = await loadFile('src/js/core/030-config.js');
    function arr(name) {
        var mm = cfg.match(new RegExp('var ' + name + '\\s*=\\s*(\\[[^\\]]*\\])'));
        assert.ok(mm, name + ' found in core/030-config.js');
        return JSON.parse(mm[1].replace(/'/g, '"'));
    }
    return { ts: arr('CHAT_META_TS_FIELDS'), flags: arr('CHAT_META_FLAG_FIELDS') };
}

async function load() {
    var lane = await laneFieldLists();
    assert.ok(lane.flags.indexOf('pausedByUser') >= 0, 'pausedByUser is a lane flag field');
    var log = [];
    var btns = { 'pause-btn': fakeButton('pause-btn', log), 'continue-btn': fakeButton('continue-btn', log), 'retry-btn': fakeButton('retry-btn', log) };
    var doc = fakeDocument(btns);
    var env = { log: log, ports: [], timers: [], emits: [], runningChatIds: {}, pausedChats: {},
        chats: { x: mkChat('x'), y: mkChat('y'), z: mkChat('z') },
        dom: { pause: btns['pause-btn'], cont: btns['continue-btn'], retry: btns['retry-btn'] } };
    var chrome = fakeChrome({ runtime: { connect: function(o) {
        var p = { name: o && o.name, posted: [], postMessage: function(msg) { p.posted.push(msg); }, disconnect: function() {},
            onMessage: { _l: [], addListener: function(fn) { this._l.push(fn); } },
            onDisconnect: { _l: [], addListener: function(fn) { this._l.push(fn); } } };
        env.ports.push(p); return p;
    } } });
    var m = await loadModules(['src/js/app/020-api-messages.js', 'src/js/app/045-agent-port-bridge-page.js'], { lenient: true, globals: {
        window: fakeWindow({ document: doc }), chrome: chrome, document: doc, console: quiet,
        runningChatIds: env.runningChatIds, pausedChats: env.pausedChats, chats: env.chats,
        CHAT_META_TS_FIELDS: lane.ts, CHAT_META_FLAG_FIELDS: lane.flags,
        // Snapshot at re-emit time: 036 paints inside this emit, so the hold must already be gone.
        AgentEvents: { on: function() {}, emit: function(type, d) {
            var cid = d && d.chatId;
            env.emits.push({ type: type, chatId: cid, held: !!(env.m && cid && env.m.isChatControlsHeld(cid)), painted: painted(env.dom) });
        } },
        setTimeout: function(fn, ms) { env.timers.push({ fn: fn, ms: ms, id: env.timers.length + 1 }); return env.timers.length; },
        clearTimeout: function(id) { env.timers.forEach(function(t) { if (t.id === id) t.cleared = true; }); }
    } });
    var s = m.__scope;
    s.currentChatId = null;
    s.currentView = 'chat';
    s.lastApiError = null;
    s.UI_ICONS = { play: '', pause: '' };
    s.isRunning = false;
    s.activeStreamingChatId = null;
    env.m = m; env.s = s;
    env.GRACE = typeof s.HELLO_SETTLE_GRACE_MS === 'number' ? s.HELLO_SETTLE_GRACE_MS : 3000;
    env.SAFETY = typeof s.BUS_HELLO_SAFETY_MS === 'number' ? s.BUS_HELLO_SAFETY_MS : 15000;
    return env;
}

// selectChat (ui/170) simulation: set the displayed chat, then the one derive.
function select(env, id) { env.s.currentChatId = id; env.s.currentView = 'chat'; return env.m.syncChatControlsUI(id); }
function livePort(env) { return env.ports[env.ports.length - 1]; }
function deliver(env, msg) {
    var p = livePort(env);
    assert.ok(p && p.onMessage._l.length, 'the live bus port has a message listener');
    p.onMessage._l.forEach(function(fn) { fn(msg); });
}
function hello(env, ids) { deliver(env, { type: 'hello', runningChatIds: ids, resumeScanSettled: true }); }
function runEvent(env, type, id) { deliver(env, { type: 'agent-event', eventType: type, detail: { chatId: id } }); }
function disconnect(env) { livePort(env).onDisconnect._l.forEach(function(fn) { fn(); }); }
function pendingTimers(env, ms) { return env.timers.filter(function(t) { return !t.cleared && !t.fired && t.ms === ms; }); }
function fire(env, ms, label) {
    var list = pendingTimers(env, ms);
    assert.strictEqual(list.length, 1, label + ': exactly one pending ' + ms + 'ms timer');
    list[0].fired = true;
    list[0].fn();
}
// The 250ms onDisconnect reconnect: opens a fresh port (the SW posts hello on it).
function reconnect(env) {
    var n = env.ports.length;
    pendingTimers(env, 250).forEach(function(t) { t.fired = true; t.fn(); });
    assert.strictEqual(env.ports.length, n + 1, 'reconnect opened a new bus port');
}
function shownSince(env, mark, id) {
    return env.log.slice(mark).some(function(e) { return e.id === id && e.op === 'add' && e.cls === 'visible'; });
}
function expectPainted(env, state, msg) { assert.strictEqual(painted(env.dom), state, msg + ' (DOM)'); }

describe('chat-controls hold across the agent-bus bridge (app/045 + app/020)', function() {
    test('wiring: one shared scope, the bus port opens at load, a bare hold derives as running', async function() {
        var env = await load(), m = env.m;
        assert.strictEqual(typeof m.isChatControlsHeld, 'function', '045 exports isChatControlsHeld');
        assert.strictEqual(typeof m.syncChatControlsUI, 'function', '020 exports syncChatControlsUI');
        assert.strictEqual(env.ports.length, 1, '045 opened the agent bus at load');
        assert.strictEqual(select(env, 'x'), 'none', 'idle clean chat (return)');
        expectPainted(env, 'none', 'idle clean chat');
        m._holdChatControls('x');
        assert.strictEqual(select(env, 'x'), 'pause', 'held + not in runningChatIds -> Pause (020 sees the 045 hook)');
        expectPainted(env, 'pause', 'held chat');
        assert.strictEqual(m._releaseChatControlsHold('x'), true, 'release reports it was held');
        expectPainted(env, 'none', 'release repainted the displayed chat');
        assert.strictEqual(m._releaseChatControlsHold('x'), false, 'second release is a no-op');
    }, T);

    test('1 boot: a chat selected before the first hello is not Pause; the hello listing it paints Pause', async function() {
        var env = await load(), m = env.m;
        env.chats.x.messages = tail(true);   // the checkpointed run stopped mid-tool-call
        assert.strictEqual(select(env, 'y'), 'none', 'clean chat before hello (return)');
        expectPainted(env, 'none', 'clean chat before hello');
        assert.notStrictEqual(select(env, 'x'), 'pause', 'not running before hello (return)');
        expectPainted(env, 'continue', 'interrupted, not running before hello');
        var mark = env.log.length;
        hello(env, ['x']);
        expectPainted(env, 'pause', 'the hello repainted the displayed chat, no selectChat needed');
        assert.ok(/Pause/.test(env.dom.pause.innerHTML), 'labelled Pause');
        assert.ok(env.log.length > mark, 'the hello wrote the buttons');
        assert.strictEqual(env.runningChatIds.x, true, 'hello up-reconcile');
        assert.strictEqual(m.isChatControlsHeld('x'), false, 'nothing held');
        assert.strictEqual(pendingTimers(env, env.GRACE).length, 0, 'nothing to defer: no grace timer');
    }, T);

    test('2 disconnect: a running chat keeps Pause through the wipe and chat/view switches; the hello listing it ends the hold', async function() {
        var env = await load(), m = env.m;
        env.chats.x.messages = tail(true);   // mid-tool-call: exactly the tail Continue would read
        runEvent(env, 'runStarted', 'x');
        assert.strictEqual(select(env, 'x'), 'pause', 'running');
        var mark = env.log.length;
        disconnect(env);
        assert.strictEqual(env.runningChatIds.x, undefined, 'RETRY-F2 still wipes runningChatIds');
        assert.strictEqual(m.isChatControlsHeld('x'), true, 'the wiped chat is held');
        expectPainted(env, 'pause', 'disconnect repaint keeps Pause');
        assert.strictEqual(pendingTimers(env, env.SAFETY).length, 1, 'no-hello safety timer armed');
        assert.strictEqual(select(env, 'y'), 'none', 'switch to Y (return)');
        expectPainted(env, 'none', 'Y shows its own state');
        env.s.currentView = 'settings';
        assert.strictEqual(m.syncChatControlsUI('x'), 'none', 'off the chat view (return)');
        expectPainted(env, 'none', 'off the chat view all three are hidden');
        assert.strictEqual(select(env, 'x'), 'pause', 'back on X (return)');
        expectPainted(env, 'pause', 'back on X: still Pause');
        assert.strictEqual(shownSince(env, mark, 'continue-btn'), false, 'Continue never shown during the gap');
        reconnect(env);
        assert.strictEqual(m.isChatControlsHeld('x'), true, 'the reconnect alone does not end the hold');
        hello(env, ['x']);
        expectPainted(env, 'pause', 'hello listing X');
        assert.strictEqual(m.isChatControlsHeld('x'), false, 'hello listing X ends the hold');
        assert.strictEqual(env.runningChatIds.x, true, 'X running again');
        assert.strictEqual(pendingTimers(env, env.SAFETY).length, 0, 'hello cancelled the no-hello timer');
        assert.strictEqual(pendingTimers(env, env.GRACE).length, 0, 'no leftover hold: no grace timer');
        assert.strictEqual(shownSince(env, mark, 'continue-btn'), false, 'Continue never shown, start to finish');
    }, T);

    test('3 grace: a chat the hello drops shows no Continue during the REG-F1 grace; the grace decision follows the contract', async function() {
        // (a) hello down-loop: running on the page, absent from the hello.
        var env = await load(), m = env.m;
        env.chats.x.messages = tail(true);
        runEvent(env, 'runStarted', 'x');
        select(env, 'x');
        var mark = env.log.length;
        hello(env, []);
        assert.strictEqual(env.runningChatIds.x, undefined, 'the down-reconcile dropped X');
        assert.strictEqual(m.isChatControlsHeld('x'), true, 'X held for the grace');
        expectPainted(env, 'pause', 'during the grace');
        assert.strictEqual(pendingTimers(env, env.GRACE).length, 1, 'REG-F1 grace armed');
        select(env, 'y'); select(env, 'x');
        expectPainted(env, 'pause', 'reselected during the grace');
        assert.strictEqual(shownSince(env, mark, 'continue-btn'), false, 'no Continue during the grace window');
        fire(env, env.GRACE, 'grace');
        assert.strictEqual(m.isChatControlsHeld('x'), false, 'the grace decision released the hold');
        expectPainted(env, 'continue', 'after the grace: not running + interrupted -> Continue');

        // (b) the SW resumes it inside the window: its runStarted ends the hold, Pause stays.
        var e2 = await load();
        e2.chats.x.messages = tail(true);
        runEvent(e2, 'runStarted', 'x');
        select(e2, 'x');
        var mark2 = e2.log.length;
        hello(e2, []);
        runEvent(e2, 'runStarted', 'x');
        assert.strictEqual(e2.m.isChatControlsHeld('x'), false, 'own runStarted ends the hold');
        expectPainted(e2, 'pause', 'resumed inside the grace');
        fire(e2, e2.GRACE, 'grace (b)');
        expectPainted(e2, 'pause', 'the grace skips a chat that came back');
        assert.strictEqual(shownSince(e2, mark2, 'continue-btn'), false, 'no Continue at all');

        // (c) held since a disconnect, the reconnect hello does not list it: the hold rides the grace.
        var e3 = await load();
        runEvent(e3, 'runStarted', 'x');
        select(e3, 'x');
        disconnect(e3);
        reconnect(e3);
        hello(e3, []);
        assert.strictEqual(e3.m.isChatControlsHeld('x'), true, 'leftover hold passed to the grace');
        assert.strictEqual(pendingTimers(e3, e3.GRACE).length, 1, 'grace armed for a hold alone');
        expectPainted(e3, 'pause', 'during the grace (c)');
        fire(e3, e3.GRACE, 'grace (c)');
        assert.strictEqual(e3.m.isChatControlsHeld('x'), false, 'released at the grace decision');
        expectPainted(e3, 'none', 'after the grace: clean tail -> none (repainted by the grace)');
    }, T);

    test('4 lane pausedByUser writes relabel Pause <-> Resume for the displayed chat only', async function() {
        var env = await load(), m = env.m;
        runEvent(env, 'runStarted', 'x');
        runEvent(env, 'runStarted', 'y');
        select(env, 'x');
        expectPainted(env, 'pause', 'running');
        m.dispatchChatMeta('x', { pausedByUser: true });
        assert.strictEqual(env.pausedChats.x, true, 'optimistic cache write');
        expectPainted(env, 'resume', 'dispatchChatMeta relabels to Resume');
        m._applyChatMetaChangedFromSW('x', { pausedByUser: false });
        assert.strictEqual(env.pausedChats.x, false, 'SW-authoritative cache write');
        expectPainted(env, 'pause', '_applyChatMetaChangedFromSW relabels back to Pause');
        assert.ok(/Pause/.test(env.dom.pause.innerHTML), 'label reads Pause');

        var mark = env.log.length;
        m.dispatchChatMeta('y', { pausedByUser: true });
        m._applyChatMetaChangedFromSW('y', { pausedByUser: true });
        assert.strictEqual(env.pausedChats.y, true, 'the non-displayed cache is still written');
        assert.strictEqual(env.log.length, mark, 'a non-displayed chat write paints nothing');
        expectPainted(env, 'pause', 'displayed chat untouched');
        assert.strictEqual(select(env, 'y'), 'resume', 'selecting Y reads its own flag');

        // A HELD chat (bus down) relabels too: the gap-time toggle is queued for the SW.
        select(env, 'x');
        disconnect(env);
        assert.strictEqual(m.isChatControlsHeld('x'), true);
        m.dispatchChatMeta('x', { pausedByUser: true });
        expectPainted(env, 'resume', 'held chat relabels to Resume while the bus is down');
        m.dispatchChatMeta('x', { pausedByUser: false });
        expectPainted(env, 'pause', 'held chat relabels back to Pause');
    }, T);

    test('5 runFinished / runCrashed / runStarted end the hold before the AgentEvents re-emit; the derive then follows the contract', async function() {
        var env = await load(), m = env.m;
        env.chats.x.messages = tail(true);   // stopped mid-tool-call -> Continue
        ['x', 'y', 'z'].forEach(function(cid) { runEvent(env, 'runStarted', cid); });
        disconnect(env);
        reconnect(env);
        hello(env, []);                       // none listed: all three held by the grace
        ['x', 'y', 'z'].forEach(function(cid) { assert.strictEqual(m.isChatControlsHeld(cid), true, cid + ' held'); });
        function lastEmit(type, cid) { var l = env.emits.filter(function(e) { return e.type === type && e.chatId === cid; }); return l[l.length - 1]; }

        select(env, 'x');
        expectPainted(env, 'pause', 'x held');
        runEvent(env, 'runFinished', 'x');
        assert.strictEqual(m.isChatControlsHeld('x'), false, 'runFinished released x');
        assert.deepStrictEqual([lastEmit('runFinished', 'x').held, lastEmit('runFinished', 'x').painted], [false, 'continue'],
            'released and repainted BEFORE the re-emit');
        expectPainted(env, 'continue', 'x: interrupted, not running -> Continue');

        select(env, 'y');
        expectPainted(env, 'pause', 'y still held');
        runEvent(env, 'runStarted', 'y');
        assert.strictEqual(m.isChatControlsHeld('y'), false, 'runStarted released y');
        assert.deepStrictEqual([lastEmit('runStarted', 'y').held, lastEmit('runStarted', 'y').painted], [false, 'pause'], 'runStarted: released before the re-emit');
        runEvent(env, 'runFinished', 'y');
        // y was no longer held, so 045 does not repaint: app/036's runFinished handler
        // (not loaded; it paints inside the re-emit) runs the derive.
        assert.strictEqual(m.syncChatControlsUI('y'), 'none', '036-style derive after runFinished (return)');
        expectPainted(env, 'none', 'y: clean tail -> none');

        select(env, 'z');
        expectPainted(env, 'pause', 'z still held');
        env.s.lastApiError = { chatId: 'z', message: 'boom' };
        runEvent(env, 'runCrashed', 'z');
        assert.strictEqual(m.isChatControlsHeld('z'), false, 'runCrashed released z');
        assert.deepStrictEqual([lastEmit('runCrashed', 'z').held, lastEmit('runCrashed', 'z').painted], [false, 'retry'], 'runCrashed: released before the re-emit');
        expectPainted(env, 'retry', 'z: API error -> Retry');

        var mark = env.log.length;
        fire(env, env.GRACE, 'grace');
        expectPainted(env, 'retry', 'the later grace decision changes nothing');
        assert.strictEqual(shownSince(env, mark, 'continue-btn'), false, 'no Continue flash from the grace');
        assert.deepStrictEqual(Object.keys(env.s._chatControlsHeld), [], 'no hold left');
    }, T);

    test('6 no-hello safety timer (BUS_HELLO_SAFETY_MS) ends every hold and repaints', async function() {
        var env = await load(), m = env.m;
        env.chats.x.messages = tail(true);
        runEvent(env, 'runStarted', 'x');
        runEvent(env, 'runStarted', 'y');
        select(env, 'x');
        disconnect(env);
        assert.deepStrictEqual([m.isChatControlsHeld('x'), m.isChatControlsHeld('y')], [true, true], 'both held');
        expectPainted(env, 'pause', 'held through the gap');
        var mark = env.log.length;
        fire(env, env.SAFETY, 'no-hello safety');
        assert.deepStrictEqual([m.isChatControlsHeld('x'), m.isChatControlsHeld('y')], [false, false], 'both released');
        assert.deepStrictEqual(Object.keys(env.s._chatControlsHeld), [], 'no hold left');
        assert.ok(env.log.length > mark, 'the safety timer repainted');
        expectPainted(env, 'continue', 'x: repainted from Pause to Continue without a selectChat');
        assert.strictEqual(select(env, 'y'), 'none', 'y (return)');
        expectPainted(env, 'none', 'y: clean tail, no run -> none');
    }, T);
});
