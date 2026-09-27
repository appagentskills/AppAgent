// Run: run_tests { files: ['test/chat-controls-page-routing.test.js'] } (js_eval sandbox; no Node).
//
// CHAT-CONTROLS SSOT, page routing. The view-switch entry points paint Pause/Resume,
// Continue and Retry ONLY through the typeof-guarded derive syncChatControlsUI
// (app/020-api-messages.js), never through the raw show/hide primitives:
//   ui/025-history-nav.js   handlePopState       chat branch + home branch
//   ui/050-history-view.js  openChatFromHistory  history card -> chat
//   ui/030-home-view.js     openHomeView         any view -> Home
// Derive contract: not the chat view -> hide all three; a chatId that is not the
// displayed chat -> no-op; else exactly one control, first match wins: Pause (running;
// labelled Resume when paused) > none (idle sub-agent) > Resume (paused) > Retry (error,
// not running) > Continue (interrupted tail) > none.
//
// Real 020 via loadModules (the derive is NOT stubbed). The three entry points are
// excerpted from the real sources and evaluated with(scope) against the 020 scope, so
// their currentView / displayed-chat / lastApiError writes are exactly what the derive
// reads. ui/170-chat-management.js is NOT loaded: selectChat and every other cross-file
// function is a recording stub; showChatView mirrors ui/040-tools-settings.js (#main-area
// flex + the guarded derive for the displayed chat). Assertions read the fake buttons'
// real `visible` classes and the Pause/Resume label.
'use strict';
var T = { tags: ['unit'], timeout: 15000 };
function noop() {}
var quiet = { log: noop, warn: noop, error: noop, info: noop, debug: noop };
var P020 = 'src/js/app/020-api-messages.js';
var P025 = 'src/js/ui/025-history-nav.js';
var P050 = 'src/js/ui/050-history-view.js';
var P030 = 'src/js/ui/030-home-view.js';

// fakeButton / fakeDocument / tail / mkChat / painted follow test/chat-controls-visibility.test.js.
function fakeButton(id) {
    var cls = {};
    return { id: id, title: '', innerHTML: '', textContent: '', style: {},
        classList: { add: function(c) { cls[c] = true; }, remove: function(c) { delete cls[c]; }, contains: function(c) { return !!cls[c]; } } };
}
function fakeDocument(els) {
    return { title: '', addEventListener: noop, removeEventListener: noop,
        querySelector: function() { return null; }, querySelectorAll: function() { return []; },
        getElementById: function(id) { return els[id] || null; },
        createElement: function() { return fakeButton('x'); }, body: fakeButton('body') };
}
function tail(interrupted) {
    return interrupted
        ? [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'x', arguments: '{}' } }] }]
        : [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }];
}
function mkChat(id, o) { return Object.assign({ id: id, title: id, messages: tail(false) }, o || {}); }
// What the DOM shows. More than one visible control is reported as MULTI(...).
function painted(dom) {
    var p = dom.pause.classList.contains('visible'), c = dom.cont.classList.contains('visible'), r = dom.retry.classList.contains('visible');
    if ((p ? 1 : 0) + (c ? 1 : 0) + (r ? 1 : 0) > 1) return 'MULTI(' + [p && 'pause', c && 'continue', r && 'retry'].filter(Boolean).join('+') + ')';
    if (p) return /Resume/.test(dom.pause.innerHTML) ? 'resume' : 'pause';
    if (c) return 'continue';
    if (r) return 'retry';
    return 'none';
}

var SRC_CACHE = {};
async function srcOf(path) {
    if (!SRC_CACHE[path]) SRC_CACHE[path] = await loadFile(path);
    return SRC_CACHE[path];
}
// The real top-level `function name(...) {...}` (its closing brace sits at column 0).
function declaration(src, name) {
    var start = src.indexOf('\nfunction ' + name + '(');
    assert.ok(start >= 0, 'declaration found: ' + name);
    var end = src.indexOf('\n}', start + 1);
    assert.ok(end > start, 'end of declaration found: ' + name);
    var code = src.slice(start + 1, end + 2);
    new Function(code);   // the excerpt compiles on its own
    return code;
}
// Source lines with comments blanked (line numbers preserved). Line-based on purpose:
// 030 has accept="image/*,..." inside a string, which a multi-line block-comment strip would eat.
function codeLines(src) {
    return src.split('\n').map(function(l) {
        if (/^\s*(\/\/|\/\*|\*)/.test(l)) return '';
        return l.replace(/\/\*.*?\*\//g, '').replace(/(^|\s)\/\/.*$/, '');
    });
}

async function load() {
    var els = { 'pause-btn': fakeButton('pause-btn'), 'continue-btn': fakeButton('continue-btn'), 'retry-btn': fakeButton('retry-btn'),
        'main-area': fakeButton('main-area'), 'home-panel': fakeButton('home-panel') };
    var doc = fakeDocument(els);
    var m = await loadModules([P020], { lenient: true, globals: {
        window: fakeWindow({ document: doc }), chrome: fakeChrome(), document: doc, console: quiet } });
    var s = m.__scope;
    var t = { m: m, s: s, els: els, dom: { pause: els['pause-btn'], cont: els['continue-btn'], retry: els['retry-btn'] },
        log: [], derives: [], warns: [], timers: [], silent: {} };
    var inShowChatView = 0;
    function rec(name, fn) {
        return function() {
            var args = Array.prototype.slice.call(arguments);
            t.log.push({ name: name, args: args });
            return fn ? fn.apply(null, args) : undefined;
        };
    }
    // Page state shared by the derive and the excerpts. Own properties of the scope, so the
    // excerpts' with(scope) writes (view, displayed chat, lastApiError, isRunning, ...) land here.
    s.document = doc;
    s.console = { log: noop, info: noop, debug: noop, error: noop,
        warn: function() { t.warns.push(Array.prototype.slice.call(arguments).map(String).join(' ')); } };
    s.chats = {
        idle: mkChat('idle'),
        run: mkChat('run'),
        paused: mkChat('paused'),
        intr: mkChat('intr', { messages: tail(true) }),
        // Errored AND interrupted: Retry must beat Continue (PR-PAUSE R6).
        err: mkChat('err', { messages: tail(true), _lastApiError: { chatId: 'err', message: 'HTTP 500' } }),
        hook: mkChat('hook', { messages: tail(true) })
    };
    s.currentChatId = 'idle';
    s.currentView = 'chat';
    s.runningChatIds = {};
    s.pausedChats = {};
    s.paused = false;
    s.lastApiError = null;
    s.UI_ICONS = { play: '', pause: '' };
    s.isRunning = false;
    s.activeStreamingChatId = null;
    s.isHandlingPopState = false;
    s.currentEditingWidget = null;
    s.currentEditingSkill = null;
    s.chatPendingTexts = {};
    s.isChatControlsHeld = function() { return false; };
    s._isChatInSilentHook = function(id) { return !!t.silent[id]; };
    // Cross-file stubs (170 is NOT loaded; nothing here may route through selectChat).
    s.appStorage = { data: {}, setItem: function(k, v) { s.appStorage.data[k] = String(v); },
        getItem: function(k) { return k in s.appStorage.data ? s.appStorage.data[k] : null; },
        removeItem: function(k) { delete s.appStorage.data[k]; } };
    s.hideAllPanels = rec('hideAllPanels', function() { els['main-area'].style.display = 'none'; els['home-panel'].style.display = 'none'; });
    // Mirrors ui/040-tools-settings.js showChatView (:3322-3351) for what matters here:
    // #main-area flex, then the guarded derive for the displayed chat.
    s.showChatView = rec('showChatView', function() {
        els['main-area'].style.display = 'flex';
        inShowChatView++;
        try { if (typeof s.syncChatControlsUI === 'function') s.syncChatControlsUI(s.currentChatId || null); }
        finally { inShowChatView--; }
    });
    ['selectChat', 'clearUpdateSet', 'loadVersionHistory', 'renderChatList', 'renderMessages', 'updateInputPosition',
        'updateChatTitleHeader', 'updateAllButtonStates', 'renderHome', 'renderWorkersStrip', 'hideSnackbar',
        'pushFocusChatToOffscreen', 'pushHistoryState', 'replaceHistoryState', 'clearUnseenFinishedChat',
        'exitWidgetModeChrome', 'showPendingApprovalNotifications', 'rerenderCurrentNotification',
        'savePendingTextForContext', 'savePendingImagesForContext', 'restorePendingTextForContext',
        'restorePendingImagesForContext', 'autoResizeTextarea'].forEach(function(n) { s[n] = rec(n); });
    s.getCurrentPendingContext = function() { return s.currentView === 'home' ? 'home' : s.currentChatId; };
    s.getHistoryTitle = function(view, id) { return 'AppAgent - ' + view + (id ? ' - ' + id : ''); };
    s.setTimeout = function(fn) { t.timers.push(fn); return t.timers.length; };
    // The REAL 020 derive, wrapped only to record the state it saw. `direct` = called by the
    // entry point itself, not via the showChatView stub.
    var realDerive = m.syncChatControlsUI;
    assert.strictEqual(typeof realDerive, 'function', 'real 020 syncChatControlsUI loaded');
    s.syncChatControlsUI = function(chatId) {
        var r = realDerive.apply(null, arguments);
        t.derives.push({ argc: arguments.length, arg: chatId, direct: inShowChatView === 0, view: s.currentView,
            shown: s.currentChatId, lastApiError: s.lastApiError, result: r });
        t.log.push({ name: 'derive', args: Array.prototype.slice.call(arguments) });
        return r;
    };
    var code = [declaration(await srcOf(P025), 'handlePopState'),
        declaration(await srcOf(P050), 'openChatFromHistory'),
        declaration(await srcOf(P030), 'openHomeView')].join('\n');
    t.api = new Function('env', 'with(env){\n' + code +
        '\nreturn {handlePopState: handlePopState, openChatFromHistory: openChatFromHistory, openHomeView: openHomeView};\n}')(s);
    return t;
}

function lastDerive(t) { return t.derives[t.derives.length - 1] || {}; }
function fmt(d) { return JSON.stringify({ argc: d.argc, arg: d.arg, direct: d.direct, view: d.view, shown: d.shown, result: d.result }); }
function callsOf(t, name) { return t.log.filter(function(e) { return e.name === name; }); }
function lastArgs(t, name) { var c = callsOf(t, name); return c.length ? c[c.length - 1].args : null; }
function lastIdx(t, name) { for (var i = t.log.length - 1; i >= 0; i--) if (t.log[i].name === name) return i; return -1; }
function expectPainted(t, want, msg) {
    var got = painted(t.dom);
    assert.strictEqual(got, want, msg + ': painted ' + got + ', want ' + want);
}
// handlePopState swallows throws into a chat-view fallback (025 catch): make sure it never ran.
function expectNoFallback(t, msg) {
    assert.strictEqual(t.warns.length, 0, msg + ': handlePopState fell into its catch fallback: ' + t.warns.join(' | '));
    assert.strictEqual(t.s.isHandlingPopState, false, msg + ': isHandlingPopState released');
}
function popTo(t, state) { t.api.handlePopState({ state: state }); }
// Put chat `id` on screen through the real derive (setup, not under test).
function putOnScreen(t, id, want) {
    t.s.currentView = 'chat'; t.s.currentChatId = id;
    assert.strictEqual(t.m.syncChatControlsUI(id), want, 'setup: ' + id + ' derives ' + want);
    expectPainted(t, want, 'setup: ' + id);
}

describe('chat controls across page routing (025 popstate, 050 openChatFromHistory, 030 openHomeView)', function() {
    test('openHomeView hides Pause, Continue and Retry, even when the chat was running, paused, interrupted or errored', async function() {
        var t = await load(), s = t.s;
        s.runningChatIds.run = true;
        s.pausedChats.paused = true;
        [['run', 'pause'], ['paused', 'resume'], ['intr', 'continue'], ['err', 'retry']].forEach(function(c) {
            putOnScreen(t, c[0], c[1]);
            var n = t.derives.length;
            t.api.openHomeView();
            expectPainted(t, 'none', c[0] + ' (' + c[1] + ') -> openHomeView');
            assert.strictEqual(s.currentView, 'home', 'openHomeView switched the view');
            assert.strictEqual(t.derives.length, n + 1, 'openHomeView derived exactly once');
            var d = lastDerive(t);
            assert.ok(d.direct && d.argc === 0 && d.view === 'home' && d.result === 'none',
                'the guarded derive ran with the view already home: ' + fmt(d));
            assert.ok(lastIdx(t, 'derive') > lastIdx(t, 'hideAllPanels'), 'derive runs after hideAllPanels');
            assert.deepStrictEqual(lastArgs(t, 'pushHistoryState'), ['home', null], 'home history entry pushed');
        });
        // Home stays clean while the chat keeps running: a later run event for it paints nothing.
        assert.strictEqual(s.runningChatIds.run, true, 'the run was not stopped');
        assert.strictEqual(t.m.syncChatControlsUI('run'), 'none', 'run event while on Home');
        expectPainted(t, 'none', 'still on Home');
        assert.strictEqual(callsOf(t, 'selectChat').length, 0, 'selectChat never reached');
    }, T);

    test('popstate to Home hides all three (from a running, an interrupted and an errored chat)', async function() {
        var t = await load(), s = t.s;
        s.runningChatIds.run = true;
        [['run', 'pause'], ['intr', 'continue'], ['err', 'retry']].forEach(function(c) {
            popTo(t, { view: 'chat', chatId: c[0] });
            expectNoFallback(t, 'popstate to ' + c[0]);
            expectPainted(t, c[1], 'popstate to ' + c[0]);
            var n = t.derives.length;
            popTo(t, { view: 'home' });
            expectNoFallback(t, 'popstate home from ' + c[0]);
            expectPainted(t, 'none', 'popstate home from ' + c[0] + ' (' + c[1] + ')');
            assert.strictEqual(s.currentView, 'home', 'view is home');
            assert.strictEqual(t.derives.length, n + 1, 'the home branch derived exactly once');
            var d = lastDerive(t);
            assert.ok(d.direct && d.argc === 0 && d.view === 'home' && d.result === 'none',
                'home-branch derive ran after the view switch: ' + fmt(d));
            assert.deepStrictEqual(lastArgs(t, 'pushFocusChatToOffscreen'), [null], 'focus cleared on leaving the chat view');
        });
        assert.strictEqual(callsOf(t, 'selectChat').length, 0, 'selectChat never reached');
    }, T);

    test("popstate to a chat paints only that chat's control: paused -> Resume, running -> Pause, interrupted -> Continue, errored idle -> Retry", async function() {
        var t = await load(), s = t.s;
        s.currentView = 'home';
        s.pausedChats.paused = true;
        s.runningChatIds.run = true;
        function go(id, want, msg) {
            popTo(t, { view: 'chat', chatId: id });
            expectNoFallback(t, msg);
            expectPainted(t, want, msg);
            assert.strictEqual(s.currentView, 'chat', msg + ': view');
            assert.strictEqual(s.currentChatId, id, msg + ': displayed chat');
            var d = lastDerive(t);
            assert.ok(d.direct && d.arg === id && d.view === 'chat' && d.shown === id && d.result === want,
                msg + ': the chat-branch derive ran last, for the target: ' + fmt(d));
        }
        go('paused', 'resume', 'paused idle chat');
        assert.match(t.dom.pause.innerHTML, /Resume/, 'label reads Resume');
        go('run', 'pause', 'running chat');
        assert.match(t.dom.pause.innerHTML, /Pause/, 'label reads Pause');
        assert.strictEqual(s.isRunning, true, 'isRunning synced');
        assert.strictEqual(s.activeStreamingChatId, 'run', 'activeStreamingChatId synced');
        go('intr', 'continue', 'interrupted idle chat (the running chat\'s Pause is cleared)');
        assert.strictEqual(t.dom.cont.title, 'Resume the interrupted run', 'Continue title');
        assert.strictEqual(s.isRunning, false, 'isRunning cleared');
        assert.strictEqual(s.activeStreamingChatId, null, 'activeStreamingChatId cleared');
        go('err', 'retry', 'errored idle chat (Retry beats its interrupted tail)');
        assert.strictEqual(t.dom.retry.title, 'Retry the failed request', 'Retry title');
        s.runningChatIds.err = true;
        go('err', 'pause', 'errored chat running again: Pause only, never Pause + Retry');
        delete s.runningChatIds.err;
        s.runningChatIds.hook = true; t.silent.hook = true;
        go('hook', 'none', 'running silent after-response hook');
        go('idle', 'none', 'clean idle chat');
        assert.strictEqual(callsOf(t, 'selectChat').length, 0, 'selectChat never reached');
    }, T);

    test('openChatFromHistory: interrupted -> Continue; errored -> Retry with lastApiError restored before the derive', async function() {
        var t = await load(), s = t.s;
        s.runningChatIds.run = true;
        // 'run' was streaming (Pause up) with a stale global error, then the History page opened
        // without a re-derive: the worst case, a stale Pause still painted underneath.
        putOnScreen(t, 'run', 'pause');
        s.lastApiError = { chatId: 'run', message: 'stale' };
        s.currentView = 'history';

        t.api.openChatFromHistory('intr');
        expectPainted(t, 'continue', 'history -> interrupted chat');
        assert.strictEqual(s.currentView, 'chat', 'view is chat');
        assert.strictEqual(s.currentChatId, 'intr', 'displayed chat');
        assert.strictEqual(s.lastApiError, null, "the other chat's stale error is cleared");
        assert.strictEqual(s.isRunning, false, 'isRunning cleared');
        assert.strictEqual(s.activeStreamingChatId, null, 'activeStreamingChatId cleared');
        var d = lastDerive(t);
        assert.ok(d.direct && d.arg === 'intr' && d.view === 'chat' && d.shown === 'intr' && d.result === 'continue',
            'final derive for the opened chat: ' + fmt(d));
        assert.ok(lastIdx(t, 'derive') > lastIdx(t, 'pushHistoryState'), 'the derive runs last (after pushHistoryState)');

        s.currentView = 'history';
        var hides = callsOf(t, 'hideSnackbar').length;
        t.api.openChatFromHistory('err');
        expectPainted(t, 'retry', 'history -> errored chat');
        assert.strictEqual(s.lastApiError, s.chats.err._lastApiError, "lastApiError restored from the chat's _lastApiError");
        d = lastDerive(t);
        assert.ok(d.direct && d.arg === 'err' && d.shown === 'err' && d.result === 'retry', 'final derive for the errored chat: ' + fmt(d));
        assert.strictEqual(d.lastApiError, s.chats.err._lastApiError, 'lastApiError was restored BEFORE the final derive ran');
        assert.strictEqual(callsOf(t, 'hideSnackbar').length, hides + 1, 'stale error snackbar hidden');

        s.currentView = 'history';
        t.api.openChatFromHistory('run');
        expectPainted(t, 'pause', 'history -> running chat (Retry cleared)');
        assert.strictEqual(s.isRunning, true, 'isRunning synced');
        assert.strictEqual(s.activeStreamingChatId, 'run', 'activeStreamingChatId synced');
        assert.strictEqual(s.lastApiError, null, "the errored chat's error is not carried over");
        assert.strictEqual(callsOf(t, 'selectChat').length, 0, 'selectChat never reached');
    }, T);

    test('regression guard: no raw control primitives left in 025/050/030; each entry point calls the guarded derive', async function() {
        var files = [P025, P050, P030];
        var names = ['showPauseButton', 'hidePauseButton', 'showContinueButton', 'hideContinueButton',
            'showRetryButton', 'hideRetryButton', 'refreshContinueButtonForChat', 'syncPauseButtonUI'];
        var raw = new RegExp('\\b(' + names.join('|') + ')\\b');
        var guarded = "if (typeof syncChatControlsUI === 'function') syncChatControlsUI(";
        var srcs = {}, hits = [];
        for (var i = 0; i < files.length; i++) srcs[files[i]] = await srcOf(files[i]);
        files.forEach(function(path) {
            var calls = 0, guardedCalls = 0;
            codeLines(srcs[path]).forEach(function(l, n) {
                if (raw.test(l)) hits.push(path + ':' + (n + 1) + ': ' + l.trim());
                calls += (l.match(/\bsyncChatControlsUI\s*\(/g) || []).length;
                if (l.indexOf(guarded) >= 0) guardedCalls++;
            });
            assert.ok(calls > 0, path + ' calls the derive');
            assert.strictEqual(guardedCalls, calls, path + ': every syncChatControlsUI( call is typeof-guarded (' + guardedCalls + '/' + calls + ')');
        });
        assert.strictEqual(hits.length, 0, 'raw show/hide primitives left: ' + hits.join(' | '));
        function deriveArgs(body) {
            return codeLines(body).filter(function(l) { return l.indexOf(guarded) >= 0; }).map(function(l) {
                var from = l.indexOf(guarded) + guarded.length;
                return l.slice(from, l.indexOf(')', from));
            });
        }
        assert.deepStrictEqual(deriveArgs(declaration(srcs[P025], 'handlePopState')), ['targetChatId', ''],
            'handlePopState: the chat branch derives for the target, the home branch with no id');
        assert.deepStrictEqual(deriveArgs(declaration(srcs[P050], 'openChatFromHistory')), ['chatId'],
            'openChatFromHistory derives for the opened chat');
        assert.deepStrictEqual(deriveArgs(declaration(srcs[P030], 'openHomeView')), [''],
            'openHomeView derives with no id');
    }, T);

    test('popstate to a chat clears the previous chat\'s lastApiError and restores the target\'s saved one (Retry targets the shown chat)', async function() {
        var t = await load(), s = t.s;
        [['err', 'retry', s.chats.err._lastApiError], ['intr', 'continue', null]].forEach(function(c) {
            putOnScreen(t, 'idle', 'none');
            s.lastApiError = { chatId: 'idle', message: 'chat A blew up' };   // chat A errors while focused
            var n = t.derives.length;
            popTo(t, { view: 'chat', chatId: c[0] });
            expectNoFallback(t, 'popstate to ' + c[0]);
            assert.strictEqual(s.lastApiError, c[2], 'popstate to ' + c[0] + ': lastApiError is ' + (c[2] ? 'the target\'s saved error' : 'cleared'));
            expectPainted(t, c[1], 'popstate to ' + c[0]);
            assert.ok(t.derives.length > n, 'popstate derived');
            t.derives.slice(n).forEach(function(d) {
                assert.strictEqual(d.lastApiError, c[2], 'every derive after popstate to ' + c[0] + ' saw the target\'s error, not chat A\'s: ' + fmt(d));
            });
            // retryLastCall (020) retries lastApiError.chatId: it must be the shown chat, never chat A.
            if (c[2]) assert.strictEqual(s.lastApiError.chatId, c[0], 'Retry would target ' + c[0]);
        });
        assert.strictEqual(callsOf(t, 'selectChat').length, 0, 'selectChat never reached');
    }, T);
});
