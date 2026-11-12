// Run: run_tests { files: ['test/split-view-popstate.test.js'] } (js_eval sandbox; no Node).
//
// Split view follows browser Back/Forward. selectChat (ui/170-chat-management.js)
// re-renders the split widget pane for the displayed chat; handlePopState
// (ui/025-history-nav.js) and openChatFromHistory (ui/050-history-view.js) bypass
// selectChat, so they must call renderSplitViewPane themselves.
//
// The REAL core/082-split-view.js holds the per-chat records (open / user-closed);
// the real handlePopState / openChatFromHistory are excerpted from source and run
// with(scope). renderSplitViewPane is wrapped to record, at call time, which chat
// is displayed, whether #main-area is visible, and what the real 082 would show.
'use strict';
var EX = await runFile('test/extract.js', { i18n: false });
var T = { tags: ['unit'], timeout: 15000 };
function noop() {}

function declaration(src, name) {
    var f = EX.findFunction(src, name, { includeAsync: false });
    assert.ok(f && f.end > f.start, 'declaration found: ' + name);
    return src.slice(f.start, f.end);
}

async function load() {
    var stored = {};
    var sv = await loadModules(['src/js/core/082-split-view.js'], { globals: {
        currentChatId: null, activeStreamingChatId: null,
        chrome: { storage: { local: {
            get: function(k, cb) { var o = {}; o[k] = stored[k]; cb(o); },
            set: function(o, cb) { Object.assign(stored, JSON.parse(JSON.stringify(o))); if (cb) cb(); }
        }, onChanged: { addListener: function() {} } } },
        getWidgetById: function(id) { return { w1: { id: 'w1', title: 'Chart', version: 1 } }[id] || null; },
        console: console
    } });
    // Chat a: widget shown. Chat c: shown then closed by the user (x). Chat b: never opened.
    await sv.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'a' });
    await sv.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'c' });
    sv.__scope.currentChatId = 'c';
    await sv.closeSplitView();
    assert.ok(sv.getSplitViewState('a'), 'setup: a shows w1');
    assert.strictEqual(sv.getSplitViewState('c'), null, 'setup: c is user-closed');
    assert.strictEqual(sv.getSplitViewRecord('c').closedBy, 'user', 'setup: closed marker kept');

    var main = { style: { display: 'none' } };
    var t = { renders: [], warns: [] };
    var s = {
        chats: { a: { id: 'a', messages: [] }, b: { id: 'b', messages: [] }, c: { id: 'c', messages: [] } },
        currentChatId: 'b', currentView: 'home', isHandlingPopState: false, lastApiError: null,
        isRunning: false, activeStreamingChatId: null, runningChatIds: {},
        appStorage: { setItem: noop, getItem: function() { return null; } },
        document: { title: '', getElementById: function(id) { return id === 'main-area' ? main : null; } },
        console: { log: noop, warn: function(m) { t.warns.push(String(m)); } },
        hideAllPanels: function() { main.style.display = 'none'; },
        showChatView: function() { main.style.display = 'flex'; },
        getHistoryTitle: function() { return 'AppAgent'; },
        renderSplitViewPane: function() {
            t.renders.push({ chat: s.currentChatId, mainVisible: main.style.display !== 'none',
                shown: sv.getSplitViewState(s.currentChatId) });
        }
    };
    ['clearUpdateSet', 'loadVersionHistory', 'renderChatList', 'renderMessages', 'updateInputPosition',
        'updateChatTitleHeader', 'updateAllButtonStates', 'hideSnackbar', 'renderHome', 'pushHistoryState'].forEach(function(n) { s[n] = noop; });
    var code = declaration(await loadFile('src/js/ui/025-history-nav.js'), 'handlePopState') + '\n' +
        declaration(await loadFile('src/js/ui/050-history-view.js'), 'openChatFromHistory');
    t.api = new Function('env', 'with(env){\n' + code +
        '\nreturn {handlePopState: handlePopState, openChatFromHistory: openChatFromHistory};\n}')(s);
    t.s = s;
    return t;
}

describe('split view pane follows Back/Forward and history-card opens', function() {
    test('Back to a chat with a widget in split view re-renders the pane for that chat', async function() {
        var t = await load();
        t.api.handlePopState({ state: { view: 'chat', chatId: 'a' } });
        assert.deepStrictEqual(t.warns, [], 'no catch fallback');
        assert.strictEqual(t.s.isHandlingPopState, false);
        assert.strictEqual(t.renders.length, 1, 'renderSplitViewPane called once');
        var r = t.renders[0];
        assert.strictEqual(r.chat, 'a', 'rendered for the target chat (after currentChatId switch)');
        assert.strictEqual(r.mainVisible, true, 'rendered after showChatView (pane not hidden)');
        assert.ok(r.shown && r.shown.widgetId === 'w1', 'real 082 state: w1 shown for a');
    }, T);

    test('Forward to a chat without a pane re-renders too (tears down the previous chat pane)', async function() {
        var t = await load();
        t.api.handlePopState({ state: { view: 'chat', chatId: 'a' } });
        t.api.handlePopState({ state: { view: 'chat', chatId: 'b' } });
        assert.strictEqual(t.renders.length, 2);
        assert.strictEqual(t.renders[1].chat, 'b');
        assert.strictEqual(t.renders[1].shown, null, 'nothing shown for b');
    }, T);

    test('a pane the user closed stays closed after Back', async function() {
        var t = await load();
        t.api.handlePopState({ state: { view: 'chat', chatId: 'c' } });
        assert.strictEqual(t.renders.length, 1);
        assert.strictEqual(t.renders[0].chat, 'c');
        assert.strictEqual(t.renders[0].shown, null, 'closed record is not shown');
    }, T);

    test('non-chat views do not render the pane; openChatFromHistory does', async function() {
        var t = await load();
        t.api.handlePopState({ state: { view: 'home' } });
        assert.strictEqual(t.renders.length, 0, 'home branch untouched');
        t.api.openChatFromHistory('a');
        assert.strictEqual(t.renders.length, 1);
        assert.strictEqual(t.renders[0].chat, 'a');
        assert.strictEqual(t.renders[0].mainVisible, true);
        assert.ok(t.renders[0].shown && t.renders[0].shown.widgetId === 'w1');
    }, T);
});
