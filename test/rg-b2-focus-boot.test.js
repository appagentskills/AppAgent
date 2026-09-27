// RG-B2 part 3 (T2b, TB-5):
//   T2b  closeSettingsPanel (ui/130-data-management.js) hands focus back to the VISIBLE
//        .settings-btn gear when focus was inside the panel. Driven end to end: the REAL
//        global Escape handler (core/120-init.js, step 7) -> the REAL closeAllHeaderMenus
//        (ui/240-layout.js) -> the REAL closeSettingsPanel. Focus outside is left alone.
//   TB-5 a ?doc= boot (core/120-init.js) keeps lastChatId in memory only: no selectChat and
//        no lastChatId write. A plain boot is unchanged.
//   TB-5b (RG-F8) a ?doc= boot with savedView 'chat' does not run the REAL showChatView
//        (ui/040-tools-settings.js), so the doc tab neither stamps lastViewedAt nor consumes
//        the unseen-finished badge of a chat it never shows. A plain boot still does both.
// Sandbox focus() does not move activeElement and there is no layout, so focus is observed
// through per-element spies and visibility through an offsetParent getter on the shown gear.
// Run: run_tests { files: ['test/rg-b2-focus-boot.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var FROM = "document.addEventListener('keydown', function(e) {\n        if (e.key !== 'Escape')";
var TO = '// NAV-H7';
var CLOSERS = ['closeModal', 'closeWidgetFullscreen', 'closeWidgetCodeEdit', 'closeWidgetModal',
    'closeWidgetHistory', 'closeResultPopover', 'closeDiffViewer', 'closeDropdowns', 'closeAllHeaderMenus'];

describe('RG-B2 part 3: settings focus return (ui/130) and ?doc= boot (core/120-init.js)', function() {
    var mounted = [];
    afterEach(function() {
        mounted.forEach(function(r) { r.remove(); });
        mounted = [];
    });
    function mount(html) {
        var r = document.createElement('div');
        r.className = 'zz-rg-b2-focus-root';
        r.innerHTML = html || '';
        document.body.appendChild(r);
        mounted.push(r);
        return r;
    }
    function noop() {}
    // Every query is answered from `root` only; opts.active() stands in for document.activeElement.
    function scopedDoc(root, opts) {
        opts = opts || {};
        return {
            get body() { return document.body; },
            get activeElement() { return opts.active ? opts.active() : null; },
            listeners: {},
            addEventListener: function(type, fn) { this.listeners[type] = fn; },
            removeEventListener: function(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; },
            getElementById: function(id) { return root.querySelector('[id="' + id + '"]'); },
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
    // The REAL global Escape handler; every closer is a recorder, `real[name]` runs through.
    async function installEscape(doc, win, real) {
        var src = await loadFile('src/js/core/120-init.js', WS);
        var a = src.indexOf(FROM), b = src.indexOf(TO, a);
        assert.ok(a >= 0 && b > a, 'global Escape handler anchors present in 120-init.js');
        var calls = [];
        var closers = CLOSERS.map(function(name) {
            return function() { calls.push(name); if (real[name]) return real[name].apply(null, arguments); };
        });
        var install = Function.apply(null, ['document', 'window'].concat(CLOSERS,
            ['closeWidgetPinMenu', 'closeChatDropdowns', 'clearGlobalSearch', src.slice(a, b)]));
        install.apply(null, [doc, win].concat(closers, [undefined, undefined, undefined]));
        assert.strictEqual(typeof doc.listeners.keydown, 'function', 'the sliced source registers the keydown handler');
        return { calls: calls, press: function() { doc.listeners.keydown({ key: 'Escape', preventDefault: noop, stopPropagation: noop }); } };
    }

    test('T2b: Esc with focus inside the settings panel returns focus to the visible gear; focus outside is left alone', async function() {
        // body.html order: header gear (:109), home gear (:278), the panel (:57) with a link item.
        var root = mount('<button type="button" title="Settings" class="settings-btn" aria-label="Open settings"></button>' +
            '<button type="button" title="Settings" class="settings-btn" id="home-settings-btn" aria-label="Open settings"></button>' +
            '<div class="settings-panel header-menu visible" id="settings-panel"><button class="settings-link-item">Tool permissions</button></div>' +
            '<button type="button" class="zz-rg-outside">Outside</button>');
        var gears = root.querySelectorAll('.settings-btn'), headerGear = gears[0], homeGear = gears[1];
        var panel = root.querySelector('#settings-panel'), item = panel.querySelector('.settings-link-item');
        var outside = root.querySelector('.zz-rg-outside');
        assert.ok(homeGear.id === 'home-settings-btn' && !headerGear.id, 'header gear first, then #home-settings-btn');
        var cur = null, focused = [], shown = homeGear;
        [headerGear, homeGear, item, outside].forEach(function(el) {
            el.focus = function() { focused.push(this); cur = this; };
        });
        [headerGear, homeGear].forEach(function(g) {
            Object.defineProperty(g, 'offsetParent', { configurable: true, get: function() { return this === shown ? document.body : null; } });
        });
        var doc = scopedDoc(root, { active: function() { return cur; } });
        var realClose = await realFn('src/js/ui/130-data-management.js', 'closeSettingsPanel', doc,
            { closeSettingsPanelOnOutsideClick: noop }, 'var settingsPanelOpen = true;\n');
        var realCloseAll = await realFn('src/js/ui/240-layout.js', 'closeAllHeaderMenus', doc,
            { closeSettingsPanel: realClose, _closeModelMenu: noop, closeJobsDropdown: noop, hideWorkspaceDropdown: noop, hideUsageTooltipNow: noop, window: {} });
        var win = { getComputedStyle: function(el) { return { display: el && el.classList && el.classList.contains('visible') ? 'block' : 'none' }; } };
        var h = await installEscape(doc, win, { closeAllHeaderMenus: realCloseAll });

        // (a) home view: the header gear is hidden, the home gear shown, focus on a link item
        cur = item;
        h.press();
        assert.deepStrictEqual(h.calls, ['closeAllHeaderMenus'], 'step 7 claimed Esc through closeAllHeaderMenus');
        assert.strictEqual(panel.classList.contains('visible'), false, 'the panel closed');
        assert.ok(cur === homeGear, 'focus returned to the shown #home-settings-btn');
        assert.strictEqual(focused.length, 1, 'exactly one focus() call');

        // (b) chat view: the header gear is the shown twin
        panel.classList.add('visible'); shown = headerGear; cur = item; focused = [];
        h.press();
        assert.strictEqual(panel.classList.contains('visible'), false, 'the panel closed again');
        assert.ok(cur === headerGear, 'focus returned to the shown header gear');
        assert.strictEqual(focused.length, 1, 'exactly one focus() call');

        // (c) focus outside the panel stays where it is
        panel.classList.add('visible'); cur = outside; focused = [];
        h.press();
        assert.strictEqual(panel.classList.contains('visible'), false, 'Esc still closes the panel');
        assert.strictEqual(focused.length, 0, 'no gear focus() call when focus was outside the panel');
        assert.ok(cur === outside, 'focus stays on the outside control');
        assert.strictEqual(h.calls.length, 3, 'each Esc went through closeAllHeaderMenus');
    }, { tags: ['unit'], timeout: 3000 });

    test('TB-5: a ?doc= boot keeps lastChatId in memory only (no selectChat, no lastChatId write); a plain boot is unchanged', async function() {
        var src = await loadFile('src/js/core/120-init.js', WS);
        var A = "var deepLinkChatId = urlParams.get('chat');", B = '// SAGF-1 / SWM2-T2';
        var a = src.indexOf(A), b = src.indexOf(B, a);
        assert.ok(a >= 0 && b > a && src.indexOf(A, a + 1) < 0, 'boot chat-restore branch anchors present (once) in 120-init.js');
        var P = ['urlParams', 'savedView', 'appStorage', 'chats', 'currentChatId', 'selectChat', 'generateId', 'versionHistory',
            'clearUpdateSet', 'renderChatList', 'renderMessages', 'renderVersionSidebar', 'updateInputPosition', 'updateChatTitleHeader', '_storageDegraded'];
        var branch = Function.apply(null, P.concat([src.slice(a, b) + '\nreturn { currentChatId: currentChatId, isNewChat: isNewChat };']));
        function boot(query, savedView, stored, chats) {
            var sets = [], selects = [], log = [];
            var appStorage = {
                getItem: function(k) { return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null; },
                setItem: function(k, v) { sets.push([k, v]); }
            };
            function rec(n) { return function() { log.push(n); }; }
            var r = branch(new URLSearchParams(query), savedView, appStorage, chats, null,
                function(id) { selects.push(id); }, function() { return 'zz-rg-gen'; }, [],
                rec('clearUpdateSet'), rec('renderChatList'), rec('renderMessages'), rec('renderVersionSidebar'),
                rec('updateInputPosition'), rec('updateChatTitleHeader'), false);
            r.sets = sets.filter(function(s) { return s[0] === 'lastChatId'; });
            r.selects = selects;
            r.log = log;
            return r;
        }
        var LAST = 'zz-rg-last';
        function withLast() {
            var c = {};
            c[LAST] = { id: LAST, title: 'ZZTEST-RG last', messages: [{ role: 'user', content: 'x' }] };
            return c;
        }

        // (1) ?doc= with a valid lastChatId and savedView 'chat'
        var r1 = boot('?doc=zz-rg-doc', 'chat', { lastChatId: LAST }, withLast());
        assert.strictEqual(r1.selects.length, 0, 'a ?doc= boot does not selectChat the last chat');
        assert.strictEqual(r1.sets.length, 0, 'a ?doc= boot does not write lastChatId');
        assert.strictEqual(r1.currentChatId, LAST, 'lastChatId is kept in memory as currentChatId');
        assert.strictEqual(r1.isNewChat, false, 'the kept chat has messages');

        // (2) ?doc= with a stale lastChatId: the temp chat stays in memory, lastChatId is not re-pointed
        var c2 = {};
        var r2 = boot('?doc=zz-rg-doc', 'chat', { lastChatId: 'zz-rg-gone' }, c2);
        assert.strictEqual(r2.sets.length, 0, 'a ?doc= boot does not re-point lastChatId at the temp chat');
        assert.strictEqual(r2.selects.length, 0, 'no selectChat');
        assert.strictEqual(r2.currentChatId, 'zz-rg-gen', 'a temporary chat is still created in memory');
        assert.ok(c2['zz-rg-gen'] && c2['zz-rg-gen'].isTemporary === true, 'the temp chat is registered');

        // (3) plain boot, savedView 'chat': selectChat(lastChatId) exactly once
        var r3 = boot('', 'chat', { lastChatId: LAST }, withLast());
        assert.deepStrictEqual(r3.selects, [LAST], 'a plain boot still opens the last chat once');
        assert.strictEqual(r3.sets.length, 0, 'the branch itself writes nothing for a valid last chat');

        // (4) plain boot with a stale lastChatId still records the new temp chat
        var r4 = boot('', 'chat', { lastChatId: 'zz-rg-gone' }, {});
        assert.deepStrictEqual(r4.sets, [['lastChatId', 'zz-rg-gen']], 'a plain boot still records the new chat as lastChatId');
        assert.strictEqual(r4.log.indexOf('renderMessages') >= 0, true, 'and paints the composer');
    }, { tags: ['unit'], timeout: 3000 });

    test('TB-5b: a ?doc= boot with savedView chat skips showChatView (no lastViewedAt stamp, no unseen clear); a plain boot still runs it', async function() {
        var src = await loadFile('src/js/core/120-init.js', WS);
        var ui = await loadFile('src/js/ui/040-tools-settings.js', WS);
        var A = "var deepLinkChatId = urlParams.get('chat');", B = '// Deep-link to a specific widget via ?widget= parameter';
        var a = src.indexOf(A), b = src.indexOf(B, a);
        assert.ok(a >= 0 && b > a && src.indexOf(A, a + 1) < 0 && src.indexOf(B, b + 1) < 0, 'boot restore + view anchors present (once) in 120-init.js');
        var S = 'function showChatView() {', s = ui.indexOf(S), e = ui.indexOf('\n}\n', s);
        assert.ok(s >= 0 && e > s && ui.indexOf(S, s + 1) < 0, 'the real showChatView is present (once) in ui/040-tools-settings.js');
        var P = ['urlParams', 'savedView', 'appStorage', 'chats', 'currentChatId', 'selectChat', 'generateId', 'versionHistory',
            'clearUpdateSet', 'renderChatList', 'renderMessages', 'renderVersionSidebar', 'updateInputPosition', 'updateChatTitleHeader', '_storageDegraded',
            'pushFocusChatToOffscreen', 'document', 'updateVersionSidebarVisibility', 'restoreChatScrollTop', 'isNearBottom', 'stickToBottom',
            'messageInput', 'chatPendingTexts', 'autoResizeTextarea', 'updateContextIndicator', 'skills', 'currentView', 'hideAllPanels',
            'openSkillEditor', 'updateAllButtonStates', 'openDashboardView', 'openSkillsView', 'openDocsView', 'openSettingsPageView',
            'openHistoryView', 'openDocumentsView', 'openHomeView', 'clearUnseenFinishedChat', 'dispatchChatMeta', 'renderJobsBadge'];
        // ONE scope: the real showChatView (renamed, behind a counting wrapper) and the real boot
        // slice share currentView, currentChatId and chats through the Function params.
        var run = Function.apply(null, P.concat([[
            'var __n = 0;',
            ui.slice(s, e + 2).replace(S, 'function __realShowChatView() {'),
            'function showChatView() { __n++; return __realShowChatView(); }',
            // the real selectChat makes its id the current chat; model just that on the shared variable
            'var __select = selectChat; selectChat = function(id) { __select(id); currentChatId = id; };',
            src.slice(a, b),
            'return { n: __n, currentView: currentView, currentChatId: currentChatId };'
        ].join('\n')]));
        var LAST = 'zz-rg-last';
        function boot(query) {
            var rec = { selects: [], unseen: [], metas: [], views: [] };
            var chats = {};
            chats[LAST] = { id: LAST, title: 'ZZTEST-RG last', messages: [{ role: 'user', content: 'x' }] };
            var stored = { lastChatId: LAST };
            var mainArea = { style: {} };
            function noop() {}
            function view(n) { return function() { rec.views.push(n); }; }
            var env = {
                urlParams: new URLSearchParams(query), savedView: 'chat', chats: chats, currentChatId: null,
                appStorage: { getItem: function(k) { return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null; }, setItem: noop },
                selectChat: function(id) { rec.selects.push(id); }, generateId: function() { return 'zz-rg-gen'; }, versionHistory: [],
                clearUpdateSet: noop, renderChatList: noop, renderMessages: noop, renderVersionSidebar: noop, updateInputPosition: noop,
                updateChatTitleHeader: noop, _storageDegraded: false, pushFocusChatToOffscreen: noop,
                document: { getElementById: function(id) { return id === 'main-area' ? mainArea : null; } },
                updateVersionSidebarVisibility: noop, restoreChatScrollTop: noop, isNearBottom: function() { return true; }, stickToBottom: true,
                messageInput: null, chatPendingTexts: {}, autoResizeTextarea: noop, updateContextIndicator: noop, skills: {}, currentView: null,
                hideAllPanels: noop, openSkillEditor: noop, updateAllButtonStates: noop,
                openDashboardView: view('dashboard'), openSkillsView: view('skills'), openDocsView: view('docs'),
                openSettingsPageView: view('settings-page'), openHistoryView: view('history'), openDocumentsView: view('documents'),
                openHomeView: view('home'),
                clearUnseenFinishedChat: function(id) { rec.unseen.push(id); },
                dispatchChatMeta: function(id, patch) { rec.metas.push([id, patch]); },
                renderJobsBadge: noop
            };
            assert.deepStrictEqual(P.filter(function(k) { return !(k in env); }), [], 'every param is stubbed');
            var r = run.apply(null, P.map(function(k) { return env[k]; }));
            r.rec = rec;
            r.mainArea = mainArea;
            r.stamped = rec.metas.filter(function(x) { return x[1] && typeof x[1].lastViewedAt === 'number'; }).map(function(x) { return x[0]; });
            return r;
        }

        // (a) ?doc= + savedView 'chat' + a valid lastChatId
        var r1 = boot('?doc=zz-rg-doc');
        assert.strictEqual(r1.n, 0, 'a ?doc= boot does not run showChatView');
        assert.deepStrictEqual(r1.stamped, [], 'no lastViewedAt stamp from the doc tab');
        assert.deepStrictEqual(r1.rec.unseen, [], 'the unseen-finished badge is not consumed');
        assert.deepStrictEqual(r1.rec.views, [], 'no other view is opened here (the ?doc= deep link below owns the view)');
        assert.strictEqual(r1.currentChatId, LAST, 'lastChatId is still kept in memory (TB-5)');
        assert.deepStrictEqual(r1.rec.selects, [], 'no selectChat (TB-5)');

        // (b) plain boot, savedView 'chat': the real showChatView runs once for the last chat
        var r2 = boot('');
        assert.strictEqual(r2.n, 1, 'a plain boot runs showChatView once');
        assert.deepStrictEqual(r2.rec.selects, [LAST], 'and opens the last chat');
        assert.deepStrictEqual(r2.stamped, [LAST], 'lastViewedAt is stamped for the last chat');
        assert.deepStrictEqual(r2.rec.unseen, [LAST], 'its unseen-finished entry is consumed');
        assert.strictEqual(r2.currentView, 'chat');
        assert.strictEqual(r2.mainArea.style.display, 'flex', 'the real showChatView body ran');
    }, { tags: ['unit'], timeout: 3000 });
});
