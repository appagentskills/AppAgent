// A5A2-02 / A4A4-01: the global Escape handler (src/js/core/120-init.js) must
// close the ad-hoc .modal-backdrop hosts: the icon picker
// (ui/010-skills-ui.js -> #icon-picker-host) and the background prompt popup
// (tools/100-prompt-user.js openBackgroundPromptPopup -> #bg-popup-host).
// Neither has a key handler of its own and no step of the Escape ladder
// queried .modal-backdrop, so Escape left both open.
// The REAL handler is sliced from the source (same loader as
// test/global-escape-pin-menu.test.js) and evaluated with a fake document. The
// bg-popup case builds the REAL popup with PU and runs the sliced handler
// against the real sandbox document through a proxy (no listener is leaked).
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var PROMPT_FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/tools/100-prompt-user.js'];
var PROMPT_ALLOW = ['formatContent', 'ensureChatPayloads'];

describe('A5A2-02 / A4A4-01 global Escape closes .modal-backdrop hosts', function() {
    var FROM = "document.addEventListener('keydown', function(e) {\n        if (e.key !== 'Escape')";
    var TO = '// NAV-H7';
    var CLOSERS = ['closeModal', 'closeWidgetFullscreen', 'closeWidgetCodeEdit', 'closeWidgetModal',
        'closeWidgetHistory', 'closeResultPopover', 'closeDiffViewer', 'closeDropdowns', 'closeAllHeaderMenus'];

    // els: id -> fake element. bds: fake .modal-backdrop elements in document order.
    // opts.dropdownOpen: '.sn-dropdown.open' matches (step 6 would run if 5b fell through).
    // opts.doc: delegate every query to this (real) document instead of the fakes.
    async function loadEscapeHandler(els, bds, opts) {
        opts = opts || {};
        var src = await loadFile('src/js/core/120-init.js');
        var a = src.indexOf(FROM), b = src.indexOf(TO, a);
        assert.ok(a >= 0 && b > a, 'global Escape handler anchors present in 120-init.js');
        var body = src.slice(a, b);
        var listeners = {}, calls = [], real = opts.doc;
        var doc = {
            body: real ? real.body : {},
            addEventListener: function(type, fn) { listeners[type] = fn; },
            getElementById: function(id) { return real ? real.getElementById(id) : (els[id] || null); },
            querySelector: function(sel) {
                if (real) return real.querySelector(sel);
                return opts.dropdownOpen && sel === '.sn-dropdown.open' ? {} : null;
            },
            querySelectorAll: function(sel) {
                if (real) return real.querySelectorAll(sel);
                return sel === '.modal-backdrop' ? bds.filter(function(x) { return x.isConnected; }) : [];
            }
        };
        var win = { getComputedStyle: function() { return { display: 'none' }; } };
        var fns = CLOSERS.map(function(name) { return function() { calls.push(name); }; });
        var install = Function.apply(null, ['document', 'window'].concat(CLOSERS, ['closeWidgetPinMenu', body]));
        install.apply(null, [doc, win].concat(fns, [undefined]));
        assert.strictEqual(typeof listeners.keydown, 'function', 'the sliced source registers the keydown handler');
        return { press: function(key) { listeners.keydown({ key: key || 'Escape' }); }, calls: calls };
    }
    function backdrop(onclick) {
        var host = { removed: 0 }, bd = { isConnected: true, parentElement: host, onclick: onclick };
        host.remove = function() { host.removed++; bd.isConnected = false; };
        bd.remove = function() { bd.isConnected = false; };
        return { bd: bd, host: host };
    }
    function shownModal() {
        return { classList: { contains: function(c) { return c === 'show'; } } };
    }
    // Same globals as test/ui-prompt-and-display.test.js promptEnv (PU's real deps are stubbed).
    function promptEnv(extraChats) {
        var s = U.stubs();
        var rec = {
            renderMessages: U.recorder(), scrollToBottomIfAllowed: U.recorder(), runAgent: U.recorder(function() { return Promise.resolve(); }),
            recordToolResult: U.recorder(), _promptResultViaSW: U.recorder(function() { return false; }),
            _refreshWaitingBadges: U.recorder(), clearActionNeedsInput: U.recorder(), setActionNeedsInput: U.recorder(), postPromptRowToSW: U.recorder()
        };
        var chats = Object.assign({ c1: { id: 'c1', messages: [] } }, extraChats || {});
        var globals = Object.assign({ chats: chats, currentChatId: 'c1', activeStreamingChatId: null, currentView: 'chat',
            saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar }, rec);
        return { rec: rec, globals: globals };
    }
    afterEach(function() { U.cleanupAll(); var x = document.getElementById('bg-popup-host'); if (x) x.remove(); });

    test('Escape replays the icon-picker backdrop click (A5A2-02)', async function() {
        var seen = [];
        var p = backdrop(function(ev) { seen.push(ev); p.bd.isConnected = false; }); // the real closer removes the host
        var h = await loadEscapeHandler({}, [p.bd], { dropdownOpen: true });
        h.press();
        assert.strictEqual(seen.length, 1, 'the backdrop onclick ran once');
        assert.ok(seen[0].target === p.bd && seen[0].currentTarget === p.bd, 'synthetic backdrop click: target === currentTarget === backdrop');
        assert.strictEqual(p.host.removed, 0, 'the closer removed the host itself: no fallback remove');
        assert.deepStrictEqual(h.calls, [], 'the handler returned at 5b: the open sn-dropdown below is not closed');
    }, { tags: ['unit'], timeout: 2000 });

    test('Escape removes the picker host when onclick is missing or throws (A5A2-02)', async function() {
        var p1 = backdrop(null); // inline onclick left uncompiled
        var h1 = await loadEscapeHandler({}, [p1.bd]);
        h1.press();
        assert.strictEqual(p1.host.removed, 1, 'no onclick: the host is removed');
        var p2 = backdrop(function() { throw new Error('closeIconPicker is not defined'); });
        var h2 = await loadEscapeHandler({}, [p2.bd]);
        h2.press(); // a throwing closer must not escape the handler
        assert.strictEqual(p2.host.removed, 1, 'throwing onclick: the host is still removed');
        assert.deepStrictEqual(h1.calls.concat(h2.calls), []);
    }, { tags: ['unit'], timeout: 2000 });

    test('Escape closes the bg prompt popup without cancelling (A4A4-01)', async function() {
        var bg = { id: 'b1', isBackground: true, actionId: 'act1', messages: [] };
        var env = promptEnv({ b1: bg });
        var m = await U.loadUi(PROMPT_FILES, { globals: env.globals, allowUnstubbed: PROMPT_ALLOW });
        var p = m.executePromptUser({ title: 'BG ask', fields: [{ name: 'why', type: 'text' }] }, { chatId: 'b1' });
        var pid = bg.messages[0].promptId;
        m.openBackgroundPromptPopup('b1', pid);
        assert.ok(document.getElementById('bg-popup-host'), 'popup open');
        var h = await loadEscapeHandler({}, [], { doc: document });
        h.press();
        assert.strictEqual(document.getElementById('bg-popup-host'), null, 'Escape closed the popup');
        assert.strictEqual(bg.messages[0].status, 'pending', 'dismiss only: the prompt stays pending');
        assert.strictEqual(env.rec.clearActionNeedsInput.calls.length, 0, 'needs_input is not cleared');
        assert.strictEqual(env.rec.recordToolResult.calls.length, 0, 'no cancelled result is recorded');
        assert.deepStrictEqual(h.calls, []);
        // Still live: the bell reopens it and Cancel resolves the original call.
        m.openBackgroundPromptPopup('b1', pid);
        U.fireInline(document.querySelectorAll('#bg-popup-host .bg-popup-footer button')[0], 'click', m);
        var timer, res = await Promise.race([p, new Promise(function(r) { timer = setTimeout(function() { r({ timedOut: true }); }, 1500); })]);
        clearTimeout(timer);
        assert.strictEqual(res.cancelled, true, 'Cancel after Escape resolves the still-pending prompt');
    }, { tags: ['unit'], timeout: 4000 });

    test('#modal-overlay.show above the picker closes first', async function() {
        var seen = 0;
        var p = backdrop(function() { seen++; p.bd.isConnected = false; });
        var els = { 'modal-overlay': shownModal() };
        var h = await loadEscapeHandler(els, [p.bd]);
        h.press();
        assert.deepStrictEqual(h.calls, ['closeModal']);
        assert.strictEqual(seen, 0, 'the picker is not touched under the modal');
        assert.strictEqual(p.bd.isConnected, true);
        delete els['modal-overlay']; // closeModal hid it
        h.press();
        assert.strictEqual(seen, 1, 'the next Escape reaches the picker');
        assert.deepStrictEqual(h.calls, ['closeModal']);
    }, { tags: ['unit'], timeout: 2000 });

    test('the last of two stacked backdrops wins', async function() {
        var order = [];
        var p1 = backdrop(function() { order.push('first'); p1.bd.isConnected = false; });
        var p2 = backdrop(function() { order.push('second'); p2.bd.isConnected = false; });
        var h = await loadEscapeHandler({}, [p1.bd, p2.bd]);
        h.press();
        assert.deepStrictEqual(order, ['second'], 'only the most recently opened (last) backdrop closes');
        assert.strictEqual(p1.bd.isConnected, true);
        h.press();
        assert.deepStrictEqual(order, ['second', 'first'], 'the next Escape closes the one below');
        assert.strictEqual(p1.host.removed + p2.host.removed, 0);
    }, { tags: ['unit'], timeout: 2000 });
});
