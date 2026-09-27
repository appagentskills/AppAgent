// RG-B2 part 1 (T1b-1, T1b-2, TA4-2): three gaps in the global Escape handler
// (src/js/core/120-init.js). The REAL handler is sliced from the source (same anchors as
// test/global-escape-backdrop.test.js, ending at the NAV-H7 marker) and installed with a
// document proxy scoped to this test's own nodes, so leftovers from other files cannot
// claim the key first.
//   T1b-1  Esc in #chat-search-input clears the query through the REAL clearGlobalSearch
//          (ui/180-search.js); Esc on the empty box blurs it.
//   T1b-2  Esc closes an open sidebar row menu (.chat-dropdown.open) through the REAL
//          closeChatDropdowns (ui/210-chat-menus.js) and refocuses that row's .chat-menu-btn.
//   TA4-2  the step-3 sweep still replays the REAL Reload checklist's backdrop click (its
//          async cancel) but no longer removes the overlay under it: ui.close() owns that.
// Sandbox focus() does not move activeElement, so focus is observed through spies.
// Run: run_tests { files: ['test/rg-b2-esc.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var ANY_UNSTUBBED = { indexOf: function() { return 0; } };
var FROM = "document.addEventListener('keydown', function(e) {\n        if (e.key !== 'Escape')";
var TO = '// NAV-H7';
var CLOSERS = ['closeModal', 'closeWidgetFullscreen', 'closeWidgetCodeEdit', 'closeWidgetModal',
    'closeWidgetHistory', 'closeResultPopover', 'closeDiffViewer', 'closeDropdowns', 'closeAllHeaderMenus'];

describe('RG-B2 global Escape: search box, chat row menu, Reload checklist (core/120-init.js)', function() {
    var M = null, opened = [], mounted = [];
    afterEach(function() {
        opened.forEach(function(ui) { ui.close(); });
        opened = [];
        mounted.forEach(function(r) { r.remove(); });
        mounted = [];
    });
    function mount(html) {
        var r = document.createElement('div');
        r.className = 'zz-rg-b2-esc-root';
        r.innerHTML = html || '';
        document.body.appendChild(r);
        mounted.push(r);
        return r;
    }
    // Every query the handler makes is answered from `root` only. opts.active() stands in
    // for document.activeElement; opts.byId overrides getElementById with fakes.
    function scopedDoc(root, opts) {
        opts = opts || {};
        return {
            get body() { return document.body; },
            get activeElement() { return opts.active ? opts.active() : null; },
            listeners: {},
            addEventListener: function(type, fn) { this.listeners[type] = fn; },
            getElementById: function(id) {
                if (opts.byId && Object.prototype.hasOwnProperty.call(opts.byId, id)) return opts.byId[id];
                return root.querySelector('[id="' + id + '"]');
            },
            querySelector: function(sel) { return root.querySelector(sel); },
            querySelectorAll: function(sel) { return root.querySelectorAll(sel); }
        };
    }
    // The REAL top-level `function name(...) {...}` from `file` (it ends at the first
    // column-0 "}"), evaluated against `doc` plus the named deps (`pre` declares module vars).
    async function realFn(file, name, doc, deps, pre) {
        var src = await loadFile(file, WS);
        var a = src.indexOf('\nfunction ' + name + '('), b = src.indexOf('\n}\n', a);
        assert.ok(a >= 0 && b > a, name + ' found in ' + file);
        deps = deps || {};
        var names = Object.keys(deps);
        var body = (pre || '') + src.slice(a, b + 2) + '\nreturn ' + name + ';';
        return Function.apply(null, ['document'].concat(names, [body]))
            .apply(null, [doc].concat(names.map(function(k) { return deps[k]; })));
    }
    async function installEscape(doc, fns) {
        fns = fns || {};
        var src = await loadFile('src/js/core/120-init.js', WS);
        var a = src.indexOf(FROM), b = src.indexOf(TO, a);
        assert.ok(a >= 0 && b > a, 'global Escape handler anchors present in 120-init.js');
        var calls = [];
        var win = { getComputedStyle: function() { return { display: 'none' }; } };
        var closers = CLOSERS.map(function(name) { return function() { calls.push(name); }; });
        var install = Function.apply(null, ['document', 'window'].concat(CLOSERS,
            ['closeWidgetPinMenu', 'closeChatDropdowns', 'clearGlobalSearch', src.slice(a, b)]));
        install.apply(null, [doc, win].concat(closers, [undefined, fns.closeChatDropdowns, fns.clearGlobalSearch]));
        assert.strictEqual(typeof doc.listeners.keydown, 'function', 'the sliced source registers the keydown handler');
        return { calls: calls, press: function(ev) { doc.listeners.keydown(Object.assign({ key: 'Escape' }, ev || {})); } };
    }

    test('T1b-1: Esc in the search box clears it via the real clearGlobalSearch; Esc on the empty box blurs it', async function() {
        var root = mount('<div id="sidebar" class="sidebar searching"></div>');
        var active = null, blurs = 0, log = [];
        var input = { id: 'chat-search-input', value: 'zz rg', blur: function() { blurs++; active = null; } };
        var doc = scopedDoc(root, { active: function() { return active; }, byId: { 'chat-search-input': input } });
        var win = { currentSearchHighlight: { query: 'zz rg' } };
        function rec(n) { return function() { log.push(n); }; }
        var realClear = await realFn('src/js/ui/180-search.js', 'clearGlobalSearch', doc,
            { window: win, _cancelSearchDebounce: rec('cancelDebounce'), renderChatList: rec('renderChatList'), renderMessages: rec('renderMessages') },
            'var chatSearchQuery = "zz rg", lastSearchQuery = "zz rg", searchMatchesCache = {};\n');
        var clears = 0;
        var h = await installEscape(doc, { clearGlobalSearch: function() { clears++; return realClear(); } });
        h.press();
        assert.strictEqual(input.value, 'zz rg', 'focus elsewhere: the search box does not claim Esc');
        active = input;
        h.press({ isComposing: true });
        assert.strictEqual(input.value, 'zz rg', 'an Esc that cancels an IME composition keeps the query');
        h.press();
        assert.strictEqual(clears, 1, 'cleared through clearGlobalSearch');
        assert.strictEqual(input.value, '', 'the box is empty');
        assert.deepStrictEqual(log, ['cancelDebounce', 'renderChatList', 'renderMessages'], 'pending debounce cancelled; list + messages re-rendered');
        assert.strictEqual(win.currentSearchHighlight, null, 'message highlights dropped');
        assert.strictEqual(root.querySelector('#sidebar').classList.contains('searching'), false, 'the sidebar left search mode');
        assert.strictEqual(blurs, 0, 'the first Esc keeps focus in the box');
        h.press();
        assert.strictEqual(blurs, 1, 'Esc on the empty box blurs it');
        assert.strictEqual(clears, 1, 'no second clear');
        h.press();
        assert.strictEqual(blurs, 1, 'once blurred, the box no longer claims Esc');
        assert.deepStrictEqual(h.calls, [], 'no other closer ran');
    }, { tags: ['unit'], timeout: 3000 });

    test('T1b-2: Esc closes the open chat row menu via the real closeChatDropdowns and refocuses its menu button', async function() {
        var row = '<div class="chat-item"><div class="chat-menu-wrapper"><button class="chat-menu-btn" title="More options">...</button>' +
            '<div class="chat-dropdown{OPEN}" id="chat-dropdown-zz-rg-{N}"><button class="chat-dropdown-item">Rename</button></div></div></div>';
        var root = mount(row.replace('{OPEN}', '').replace('{N}', '1') + row.replace('{OPEN}', ' open').replace('{N}', '2'));
        var btns = root.querySelectorAll('.chat-menu-btn'), focused = [];
        Array.prototype.forEach.call(btns, function(b) { b.focus = function() { focused.push(b); }; });
        var doc = scopedDoc(root);
        var realClose = await realFn('src/js/ui/210-chat-menus.js', 'closeChatDropdowns', doc);
        var closes = 0;
        var h = await installEscape(doc, { closeChatDropdowns: function() { closes++; return realClose(); } });
        h.press();
        assert.strictEqual(closes, 1, 'closed through closeChatDropdowns');
        assert.strictEqual(root.querySelectorAll('.chat-dropdown.open').length, 0, 'no row menu left open');
        assert.strictEqual(focused.length, 1, 'focus moved once');
        assert.ok(focused[0] === btns[1], "focus returned to the open menu's own .chat-menu-btn");
        assert.deepStrictEqual(h.calls, [], 'no other closer ran');
        h.press();
        assert.strictEqual(closes, 1, 'nothing open: the next Esc is a no-op');
        assert.strictEqual(focused.length, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('TA4-2: the sweep replays the real Reload checklist backdrop click and leaves the overlay to its own ui.close()', async function() {
        if (!M) M = await U.loadUi(['src/js/ui/270-iframe-panel.js'], { globals: { window: fakeWindow({ document: document }) }, lenient: true, allowUnstubbed: ANY_UNSTUBBED });
        var aborts = 0, ui = M._reloadChecklist({ abort: function() { aborts++; } });
        opened.push(ui);
        var ov = document.querySelector('.reload-preflight');
        assert.ok(ov && !ov.id && ov.classList.contains('modal-overlay') && ov.classList.contains('show'), 'the real checklist is an id-less .modal-overlay.show');
        var root = mount();
        root.appendChild(ov); // scope the sweep to this test's overlay
        var h = await installEscape(scopedDoc(root));
        h.press();
        assert.strictEqual(ui.cancelled(), true, 'the replayed backdrop click cancelled');
        assert.strictEqual(aborts, 1, 'controller aborted once');
        assert.strictEqual(await ui.decision, 'cancel');
        assert.strictEqual(ov.isConnected, true, 'the sweep no longer removes the checklist mid-cancel');
        assert.match(ov.querySelector('.reload-preflight-status').textContent, /Cancelling/, 'its cancelling status stays visible');
        h.press();
        assert.strictEqual(aborts, 1, 'a second Esc during the cancel does not abort again');
        assert.strictEqual(ov.isConnected, true, 'and still does not remove it');
        assert.deepStrictEqual(h.calls, [], 'the sweep claimed the key: nothing below closed');
        ui.close();
        assert.strictEqual(ov.isConnected, false, 'ui.close() removes it');
    }, { tags: ['unit'], timeout: 8000 });

    test('TA4-2 control: an ordinary .modal-overlay.show twin is still replayed with {target: ov}, then removed', async function() {
        var root = mount('<div class="modal-overlay show" id="zz-rg-b2-twin"></div>');
        var tw = root.firstChild, seen = [];
        tw.onclick = function(ev) { seen.push(ev); }; // a closer that leaves the node in place
        var h = await installEscape(scopedDoc(root));
        h.press();
        assert.strictEqual(seen.length, 1, 'backdrop click replayed once');
        assert.ok(seen[0].target === tw && seen[0].currentTarget === tw, 'replay contract: target === currentTarget === overlay');
        assert.strictEqual(tw.isConnected, false, 'the belt-and-braces remove is kept for ordinary twins');
        assert.deepStrictEqual(h.calls, []);
    }, { tags: ['unit'], timeout: 3000 });
});
