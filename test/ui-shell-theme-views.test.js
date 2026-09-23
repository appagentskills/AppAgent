// B8 — UI tests for the sidepanel shell (sidebar toggle, history section),
// light/dark theme switching (real CSS tokens via getComputedStyle), the
// Workers panel / sub-agent breadcrumb, the history view, the diff engine
// markup, the screenshot modal, plus two INTEGRITY checks over body.html:
//   (1) every inline on* handler names a function the real bundle defines;
//   (2) every getElementById / querySelector('#id') literal in src resolves to
//       a body.html id or an id src creates dynamically (allow-list below).
// Real src modules are loaded with U.loadUi and driven through their real
// handlers (U.fireInline for inline attrs, real clicks for delegated ones).
// Run: run_tests { files: ['test/ui-shell-theme-views.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var HOSTILE = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
var ALL_CSS = ['00-tokens', '01-dark-theme', '02-layout', '03-chat', '04-header', '05-tools', '06-input', '07-markdown', '08-browser', '09-settings',
    '10-approval', '11-version', '12-artifacts', '13-notifications', '14-modals', '15-widgets', '16-diff', '17-skills', '18-panels', '19-dashboard',
    '19b-widget-library', '20-responsive', '21-display-templates', '21b-prompt-user', '21c-smart-documents', '22-sidepanel', '23-actions',
    '24-sub-agents', '25-ws-files'].map(function(n) { return 'src/css/' + n + '.css'; });
var ICONS = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js'];
var ESC = 'src/js/ui/180-search.js'; // real escapeHtml

// Local helper (proposed shared): accept every lenient/typeof-probed global.
// These surfaces touch dozens of optional cross-module hooks behind typeof
// guards; the assertions below pin the behaviour, m.__unstubbed is kept for debugging.
var ANY_UNSTUBBED = { indexOf: function() { return 0; } };
// Local helper (proposed shared): a window stub with matchMedia (240-layout.js
// subscribes to prefers-color-scheme at load time) + a recorder.
function winStub(opts) {
    opts = opts || {};
    var mq = { matches: !!opts.dark, listeners: [], addEventListener: function(t, f) { mq.listeners.push(f); }, addListener: function(f) { mq.listeners.push(f); } };
    var w = fakeWindow(Object.assign({ document: document, _rawCopyStore: {}, isRunning: false, open: U.recorder(),
        matchMedia: U.recorder(function() { return mq; }) }, opts.extra || {}));
    w._mq = mq;
    return w;
}
function appStorageStub() {
    var data = {};
    return { data: data, setItem: U.recorder(function(k, v) { data[k] = String(v); }), getItem: function(k) { return k in data ? data[k] : null; }, removeItem: function(k) { delete data[k]; } };
}
function loadLenient(paths, globals) {
    return U.loadUi(paths, { globals: globals, lenient: true, allowUnstubbed: ANY_UNSTUBBED, window: globals.window });
}

// ─────────────────────────── Theme ───────────────────────────
describe('ui shell › theme switching (real CSS tokens)', function() {
    var prevTheme;
    beforeEach(function() { prevTheme = document.documentElement.getAttribute('data-theme'); });
    afterEach(function() {
        U.cleanupAll();
        if (prevTheme == null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', prevTheme);
    });
    async function setup(opts) {
        var st = appStorageStub(), win = winStub(opts);
        var m = await loadLenient(ICONS.concat(['src/js/ui/240-layout.js']), { window: win, appStorage: st, appTheme: 'light', sidebarCollapsed: true, historyExpanded: true });
        var dom = await U.mountDom({ body: true, css: ALL_CSS });
        return { m: m, st: st, win: win, dom: dom };
    }
    function tok(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase(); }

    test('setAppTheme light/dark flips data-theme, persists, and CSS tokens + element colours resolve differently', async function() {
        var s = await setup();
        s.m.setAppTheme('light');
        assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'light');
        var lightPrimary = tok('--primary'), lightText = tok('--text-primary');
        var sidebar = s.dom.$('#sidebar'), lightBg = getComputedStyle(sidebar).backgroundColor, lightFg = getComputedStyle(document.body).color;
        assert.strictEqual(lightPrimary, '#293e6b'); assert.strictEqual(lightText, '#1f2937');
        s.m.setAppTheme('dark');
        assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'dark');
        assert.strictEqual(tok('--primary'), '#6b8bc4'); assert.strictEqual(tok('--text-primary'), '#e5e7eb');
        assert.notStrictEqual(getComputedStyle(sidebar).backgroundColor, lightBg, 'sidebar background changes with theme');
        assert.notStrictEqual(getComputedStyle(document.body).color, lightFg, 'body text colour changes with theme');
        assert.strictEqual(getComputedStyle(document.documentElement).colorScheme, 'dark', 'dark color-scheme for native controls');
        assert.deepStrictEqual(s.st.setItem.calls, [['appTheme', 'light'], ['appTheme', 'dark']]);
        assert.strictEqual(s.m.__scope.appTheme, 'dark');
    }, { tags: ['unit'] });

    test("'system' follows prefers-color-scheme and the OS change listener re-applies only in system mode", async function() {
        var s = await setup({ dark: true });
        assert.ok(s.win.matchMedia.calls.some(function(c) { return c[0] === '(prefers-color-scheme: dark)'; }), 'subscribed at load');
        assert.strictEqual(s.win._mq.listeners.length, 1);
        s.m.setAppTheme('system');
        assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'dark');
        s.win._mq.matches = false; s.win._mq.listeners[0]();
        assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'light', 'OS switch re-applied');
        s.m.setAppTheme('dark'); s.win._mq.matches = false; s.win._mq.listeners[0]();
        assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'dark', 'explicit theme ignores OS change');
    }, { tags: ['unit'] });

    test('gear-panel theme radios (body.html inline handlers) switch theme and mark exactly one option selected', async function() {
        var s = await setup();
        var group = s.dom.$('#settings-panel-theme');
        var opts = Array.prototype.slice.call(group.querySelectorAll('.radio-option'));
        assert.deepStrictEqual(opts.map(function(o) { return o.getAttribute('data-value'); }), ['system', 'light', 'dark']);
        var dark = opts[2];
        assert.strictEqual(dark.getAttribute('onclick'), "setAppThemeFromPanel('dark')");
        U.fireInline(dark, 'click', s.m);
        assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'dark');
        assert.deepStrictEqual(opts.map(function(o) { return o.classList.contains('selected'); }), [false, false, true]);
        U.fireInline(opts[1], 'click', s.m);
        assert.deepStrictEqual(opts.map(function(o) { return o.classList.contains('selected'); }), [false, true, false]);
        assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'light');
    }, { tags: ['unit'] });

    test('broadcastWidgetTheme posts themeChange to every widget iframe and tolerates none', async function() {
        var s = await setup();
        s.m.broadcastWidgetTheme('dark'); // no widgets: silent no-op
        var posted = [];
        var fr = document.createElement('iframe'); fr.className = 'widget-iframe';
        s.dom.root.appendChild(fr);
        var cw = fr.contentWindow;
        try { cw.postMessage = function(msg, o) { posted.push([msg, o]); }; } catch (e) { cw = null; }
        if (!cw || fr.contentWindow.postMessage === HTMLIFrameElement.prototype.postMessage) { assert.ok(true, 'contentWindow not patchable in this frame'); return; }
        s.m.broadcastWidgetTheme('weird');
        assert.deepStrictEqual(posted, [[{ type: 'themeChange', theme: 'light' }, '*']], 'unknown theme normalised to light');
    }, { tags: ['unit'] });
});

// ─────────────────────────── Shell ───────────────────────────
describe('ui shell › sidebar + history section', function() {
    afterEach(function() { U.cleanupAll(); var o = document.getElementById('sidebar-overlay'); if (o) o.remove(); });
    async function setup(width) {
        var st = appStorageStub(), win = winStub({ extra: { innerWidth: width || 1280 } }), rcl = U.recorder();
        var m = await loadLenient(ICONS.concat(['src/js/ui/240-layout.js']), { window: win, appStorage: st, appTheme: 'light', sidebarCollapsed: true, historyExpanded: true, renderChatList: rcl });
        var dom = await U.mountDom({ body: true, css: ALL_CSS });
        return { m: m, st: st, dom: dom, rcl: rcl };
    }
    test('sidebar toggle button: expand/collapse class, icon, title, persistence, chat-list refresh on expand only', async function() {
        var s = await setup();
        var sb = s.dom.$('#sidebar'), btn = s.dom.$('#sidebar-toggle-btn');
        assert.strictEqual(btn.getAttribute('onclick'), 'toggleSidebar()');
        U.fireInline(btn, 'click', s.m);
        assert.ok(sb.classList.contains('expanded'));
        assert.strictEqual(btn.title, 'Collapse sidebar');
        assert.strictEqual(btn.innerHTML, U.frag(s.m.UI_ICONS.panelLeftClose).innerHTML, 'close icon');
        assert.strictEqual(s.rcl.calls.length, 1, 'chat list re-rendered on expand');
        assert.deepStrictEqual(s.st.setItem.calls[0], ['sidebarCollapsed', 'false']);
        U.fireInline(btn, 'click', s.m);
        assert.ok(!sb.classList.contains('expanded'));
        assert.strictEqual(btn.title, 'Expand sidebar');
        assert.strictEqual(btn.innerHTML, U.frag(s.m.UI_ICONS.panelLeftOpen).innerHTML, 'open icon');
        assert.notStrictEqual(U.frag(s.m.UI_ICONS.panelLeftOpen).innerHTML, U.frag(s.m.UI_ICONS.panelLeftClose).innerHTML);
        assert.strictEqual(s.rcl.calls.length, 1, 'no re-render on collapse');
        assert.deepStrictEqual(s.st.setItem.calls[1], ['sidebarCollapsed', 'true']);
        assert.strictEqual(document.getElementById('sidebar-overlay'), null, 'no overlay on wide screens');
    }, { tags: ['unit'] });
    test('every view header hamburger in body.html is wired to toggleSidebar', async function() {
        var s = await setup();
        var ids = ['floating-sidebar-toggle', 'toggle-sidebar-btn', 'skills-toggle-sidebar-btn', 'dashboard-toggle-sidebar-btn', 'home-toggle-sidebar-btn',
            'settings-page-toggle-sidebar-btn', 'docs-toggle-sidebar-btn', 'documents-toggle-sidebar-btn', 'history-toggle-sidebar-btn'];
        ids.forEach(function(id) {
            var el = s.dom.$('#' + id);
            assert.ok(el, id + ' exists'); assert.strictEqual(el.getAttribute('onclick'), 'toggleSidebar()', id);
        });
        U.fireInline(s.dom.$('#history-toggle-sidebar-btn'), 'click', s.m);
        assert.ok(s.dom.$('#sidebar').classList.contains('expanded'));
    }, { tags: ['unit'] });
    test('narrow screen: expanding adds a click-to-close overlay; clicking it collapses and removes it', async function() {
        var s = await setup(400);
        s.m.toggleSidebar();
        var ov = document.getElementById('sidebar-overlay');
        assert.ok(ov, 'overlay added'); assert.strictEqual(ov.parentNode, document.body);
        ov.click();
        assert.ok(!s.dom.$('#sidebar').classList.contains('expanded'));
        assert.strictEqual(document.getElementById('sidebar-overlay'), null, 'overlay removed');
    }, { tags: ['unit'] });
    test('history chevron stops propagation and toggles #chat-list.collapsed + button state', async function() {
        var s = await setup();
        var chev = s.dom.$('#history-chevron-btn'), list = s.dom.$('#chat-list'), hbtn = s.dom.$('#history-toggle-btn');
        var r = U.fireInline(chev, 'click', s.m);
        assert.ok(r.stopped, 'stopPropagation (does not also open history view)');
        assert.ok(list.classList.contains('collapsed')); assert.ok(!hbtn.classList.contains('expanded'));
        assert.deepStrictEqual(s.st.setItem.calls[0], ['historyExpanded', 'false']);
        U.fireInline(chev, 'click', s.m);
        assert.ok(!list.classList.contains('collapsed')); assert.ok(hbtn.classList.contains('expanded'));
    }, { tags: ['unit'] });
});

// ─────────────────────────── Workers / sub-agents ───────────────────────────
describe('ui shell › Workers panel + sub-agent breadcrumb', function() {
    var loaded = [];
    afterEach(function() {
        U.cleanupAll();
        loaded.forEach(function(m) { var h = m._handleSubAgentUiClick || (m.__scope && m.__scope._handleSubAgentUiClick); if (h) document.removeEventListener('click', h); });
        loaded = [];
    });
    function rec(o) { return Object.assign({ agent_id: 'sub_1', name: 'Worker', state: 'running', parent_chat_id: 'c1', root_chat_id: 'c1', chat_id: 'sc1', tool_calls_used: 3, depth: 1, last_activity_at: 1 }, o); }
    async function setup(records, chatsObj, extra) {
        var reg = { listAll: function() { return records.slice(); }, getById: function(id) { return records.filter(function(r) { return r.agent_id === id; })[0] || null; }, addListener: function() {} };
        var reveal = U.recorder(); // selectChat spy: revealSubAgentChat's navigation sink
        var g = Object.assign({ window: winStub(), SubAgents: reg, chats: chatsObj || { c1: { id: 'c1', title: 'Root', messages: [] } }, currentChatId: 'c1',
            selectChat: reveal, getAssumedContextTokens: function() { return 200000; }, requestAnimationFrame: function(f) { f(); return 1; } }, extra || {});
        var m = await loadLenient(ICONS.concat([ESC, 'src/js/ui/175-sub-agent-ui.js']), g);
        loaded.push(m);
        var dom = await U.mountDom({ html: '<div id="sidebar-workers"></div>', css: ALL_CSS });
        return { m: m, dom: dom, reveal: reveal };
    }
    test('empty state: no current chat / no workers hides the panel', async function() {
        var s = await setup([]);
        var el = s.dom.$('#sidebar-workers');
        el.innerHTML = 'stale';
        s.m.renderWorkersStrip();
        assert.strictEqual(el.innerHTML, ''); assert.strictEqual(el.style.display, 'none');
        U.cleanupAll();
        var s2 = await setup([rec()], null, { currentChatId: null });
        s2.m.renderWorkersStrip();
        assert.strictEqual(s2.dom.$('#sidebar-workers').style.display, 'none');
    }, { tags: ['unit'] });
    test('cards: header count, running-first sort, state classes, escaped hostile name, a11y', async function() {
        var s = await setup([rec({ agent_id: 'a_stop', name: 'Stopped one', state: 'stopped', last_activity_at: 9 }),
            rec({ agent_id: 'a_run', name: HOSTILE, state: 'running' }), rec({ agent_id: 'other', parent_chat_id: 'zz', root_chat_id: 'zz' })]);
        s.m.renderWorkersStrip();
        var el = s.dom.$('#sidebar-workers');
        assert.strictEqual(el.style.display, '');
        assert.strictEqual(el.querySelector('.sidebar-workers-header').textContent, 'Workers (2)', 'foreign-root sub excluded');
        var cards = el.querySelectorAll('.worker-card');
        assert.strictEqual(cards.length, 2);
        assert.strictEqual(cards[0].getAttribute('data-worker-toggle'), 'a_run', 'running sorts first');
        assert.ok(cards[0].classList.contains('worker-running')); assert.ok(cards[1].classList.contains('worker-stopped'));
        assert.strictEqual(cards[0].querySelector('.worker-name').textContent, HOSTILE, 'name rendered as text');
        assert.strictEqual(el.querySelector('script, img[onerror]'), null);
        var a = U.a11y(cards[0]);
        assert.strictEqual(a.tag, 'button'); assert.strictEqual(a.type, 'button' === a.type ? 'button' : a.type); assert.strictEqual(a.aria.expanded, 'false'); assert.ok(a.focusable);
        assert.strictEqual(cards[0].querySelector('.worker-card-icon').getAttribute('aria-hidden'), 'true');
        assert.strictEqual(cards[0].querySelector('.worker-tools').textContent, '3 tool calls');
        assert.ok(cards[0].querySelector('[data-worker-approval]').hasAttribute('hidden'), 'approval badge hidden by default');
        assert.strictEqual(el.querySelectorAll('.worker-card-progress').length, 0, 'collapsed cards carry no progress panel');
    }, { tags: ['unit'] });
    test('clicking a card expands its progress panel (empty state + Open chat), second click removes it; Open chat reveals', async function() {
        var s = await setup([rec({ agent_id: 'a1' })]);
        s.m.renderWorkersStrip();
        var card = s.dom.$('.worker-card');
        card.click(); // real click → document-level delegated listener
        assert.strictEqual(card.getAttribute('aria-expanded'), 'true'); assert.ok(card.classList.contains('worker-card-expanded'));
        var panel = card.nextElementSibling;
        assert.ok(panel && panel.classList.contains('worker-card-progress'));
        assert.strictEqual(panel.querySelector('.worker-progress-empty').textContent, 'No progress reported yet.');
        var open = panel.querySelector('.worker-progress-open');
        assert.strictEqual(open.getAttribute('data-sub-agent-reveal'), 'a1');
        var ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        open.dispatchEvent(ev);
        assert.ok(ev.defaultPrevented, 'Open chat handled by the delegated reveal branch');
        assert.strictEqual(card.getAttribute('aria-expanded'), 'true', 'reveal click does not toggle the card');
        card.click();
        assert.strictEqual(card.getAttribute('aria-expanded'), 'false');
        assert.strictEqual(s.dom.$$('.worker-card-progress').length, 0, 'panel removed from DOM');
        card.click(); card.click(); card.click();
        assert.strictEqual(s.dom.$$('.worker-card-progress').length, 1, 'repeated toggles never duplicate panels');
    }, { tags: ['unit'] });
    test('breadcrumb: non-sub → empty; chain root›parent; depth>3 collapses middle; cycle-safe; escaped', async function() {
        var chats = { r: { id: 'r', title: 'Root ' + HOSTILE }, p1: { id: 'p1', title: 'P1', parentChatId: 'r' }, p2: { id: 'p2', title: 'P2', parentChatId: 'p1' },
            p3: { id: 'p3', title: 'P3', parentChatId: 'p2' }, x: { id: 'x', title: 'X', parentChatId: 'y' }, y: { id: 'y', title: 'Y', parentChatId: 'x' } };
        var s = await setup([], chats);
        assert.strictEqual(s.m.renderSubAgentBreadcrumb({ title: 'n' }), '');
        assert.strictEqual(s.m.renderSubAgentBreadcrumb({ isSubAgent: true }), '');
        var b = U.frag(s.m.renderSubAgentBreadcrumb({ isSubAgent: true, parentChatId: 'p1' })).querySelector('.sub-agent-breadcrumb');
        assert.strictEqual(b.getAttribute('data-depth'), '2');
        var links = b.querySelectorAll('.breadcrumb-link');
        assert.deepStrictEqual(Array.prototype.map.call(links, function(a) { return a.getAttribute('data-sub-agent-reveal'); }), ['r', 'p1']);
        assert.strictEqual(links[0].textContent, 'Root ' + HOSTILE); assert.strictEqual(b.querySelector('img, script'), null);
        var deep = U.frag(s.m.renderSubAgentBreadcrumb({ isSubAgent: true, parentChatId: 'p3' })).querySelector('.sub-agent-breadcrumb');
        assert.strictEqual(deep.getAttribute('data-depth'), '4');
        assert.ok(deep.querySelector('.breadcrumb-ellipsis'));
        assert.deepStrictEqual(Array.prototype.map.call(deep.querySelectorAll('.breadcrumb-link'), function(a) { return a.textContent; }).slice(-1), ['P3']);
        var cyc = U.frag(s.m.renderSubAgentBreadcrumb({ isSubAgent: true, parentChatId: 'x' }));
        assert.ok(cyc.querySelectorAll('.breadcrumb-link').length <= 3, 'cycle bounded');
        var miss = U.frag(s.m.renderSubAgentBreadcrumb({ isSubAgent: true, parentChatId: 'gone' })).querySelector('.breadcrumb-link');
        assert.strictEqual(miss.textContent, 'parent', 'missing ancestor placeholder');
    }, { tags: ['unit'] });
});

// ─────────────────────────── History view ───────────────────────────
describe('ui views › history page', function() {
    afterEach(function() { U.cleanupAll(); });
    async function setup(chatsObj) {
        var g = { window: winStub(), chats: chatsObj, currentChatId: null, historySearchQuery: '', historySearchDebounceTimer: null, appStorage: appStorageStub(),
            getWidgetsForChat: function() { return []; }, estimateTokens: function(t) { return Math.ceil(String(t || '').length / 4); } };
        var m = await loadLenient(ICONS.concat([ESC, 'src/js/ui/050-history-view.js']), g);
        var dom = await U.mountDom({ body: true, css: ALL_CSS });
        return { m: m, dom: dom };
    }
    function chat(id, title, extra) { return Object.assign({ id: id, title: title, createdAt: 1700000000000, updatedAt: 1700000000000, messages: [{ role: 'user', content: 'hello ' + title }] }, extra || {}); }
    test('filterHistoryChats hides sub-agent + unrevealed background chats; short query = all visible; query matches', async function() {
        var s = await setup({ a: chat('a', 'Alpha incident'), b: chat('b', 'Beta'), s: chat('s', 'Sub', { isSubAgent: true }), bg: chat('bg', 'Bg', { isBackground: true }),
            bgr: chat('bgr', 'Bg revealed', { isBackground: true, _revealed: true }) });
        assert.deepStrictEqual(s.m.filterHistoryChats('').sort(), ['a', 'b', 'bgr']);
        assert.deepStrictEqual(s.m.filterHistoryChats('a').sort(), ['a', 'b', 'bgr'], '1-char query ignored');
        assert.deepStrictEqual(s.m.filterHistoryChats('ALPHA'), ['a'], 'case-insensitive');
        assert.deepStrictEqual(s.m.filterHistoryChats('zzzz'), []);
    }, { tags: ['unit'] });
    test('renderHistoryChatCard escapes a hostile title and exposes the chat id', async function() {
        var s = await setup({ h: chat('h', HOSTILE) });
        var html = s.m.renderHistoryChatCard('h');
        assert.ok(typeof html === 'string' && html.length > 0);
        var b = U.frag(html);
        assert.strictEqual(b.querySelector('img, script, [onerror]'), null);
        assert.ok(b.textContent.indexOf('<img src=x') >= 0, 'title visible as text');
        assert.ok(html.indexOf("'h'") >= 0 || html.indexOf('"h"') >= 0, 'card carries chat id');
    }, { tags: ['unit'] });
    test('renderHistoryPage lists visible chats; search input debounces; clear button resets input + query', async function() {
        var s = await setup({ a: chat('a', 'Alpha'), b: chat('b', 'Beta') });
        s.m.renderHistoryPage();
        var list = s.dom.$('#history-list');
        assert.ok(list.innerHTML.indexOf('Alpha') >= 0 && list.innerHTML.indexOf('Beta') >= 0);
        var input = s.dom.$('#history-search-input');
        input.value = 'Alpha';
        U.fireInline(input, 'input', s.m);
        assert.strictEqual(s.m.__scope.historySearchQuery, '', 'not applied before debounce');
        await new Promise(function(r) { setTimeout(r, 320); });
        assert.strictEqual(s.m.__scope.historySearchQuery, 'Alpha');
        assert.ok(list.innerHTML.indexOf('Beta') < 0, 'Beta filtered out');
        U.fireInline(s.dom.$('#history-search-clear'), 'click', s.m);
        assert.strictEqual(input.value, ''); assert.strictEqual(s.m.__scope.historySearchQuery, '');
        assert.ok(list.innerHTML.indexOf('Beta') >= 0);
    }, { tags: ['unit'] });
});

// ─────────────────────────── Diff ───────────────────────────
describe('ui views › diff engine markup', function() {
    async function load() { return loadLenient([ESC, 'src/js/ui/090-version-history.js'], { window: winStub() }); }
    test('computeDiff line ops + numbering', async function() {
        var m = await load();
        var d = m.computeDiff('a\nb\nc', 'a\nB\nc\nd');
        assert.deepStrictEqual(d.map(function(x) { return x.type + ':' + x.text; }), ['same:a', 'remove:b', 'add:B', 'same:c', 'add:d']);
        assert.deepStrictEqual([d[1].oldLine, d[1].newLine, d[2].oldLine, d[2].newLine], [2, null, null, 2]);
        assert.ok(m.computeDiff('x', 'x').every(function(x) { return x.type === 'same'; }));
    }, { tags: ['unit'] });
    test('computeWordDiff wraps only changed words and escapes HTML in both sides', async function() {
        var m = await load();
        var w = m.computeWordDiff('the quick fox', 'the slow fox');
        var o = U.frag(w.oldHtml), n = U.frag(w.newHtml);
        assert.strictEqual(o.querySelector('.diff-word-remove').textContent, 'quick');
        assert.strictEqual(n.querySelector('.diff-word-add').textContent, 'slow');
        assert.strictEqual(o.textContent, 'the quick fox');
        var h = m.computeWordDiff('a <b>x</b>', 'a ' + HOSTILE);
        assert.strictEqual(U.frag(h.newHtml).querySelector('img, script, b'), null, 'new side escaped');
        assert.strictEqual(U.frag(h.oldHtml).querySelector('b'), null, 'old side escaped');
    }, { tags: ['unit'] });
});

// ─────────────────────────── Screenshots ───────────────────────────
describe('ui views › screenshot modal', function() {
    var mods = [];
    afterEach(function() { mods.forEach(function(m) { document.removeEventListener('keydown', m.screenshotModalKeyHandler); }); mods = []; U.cleanupAll(); });
    var PNG = function(i) { return 'data:image/png;base64,AAA' + i; };
    async function setup(n) {
        var msgs = [{ role: 'user', content: 'x' }];
        for (var i = 0; i < n; i++) msgs.push({ role: 'screenshot', base64: PNG(i), name: 'shot ' + i + (i === 1 ? ' ' + HOSTILE : ''), width: 10, height: 20 });
        var g = { window: winStub(), chats: { c1: { id: 'c1', messages: msgs } }, currentChatId: 'c1', screenshotNav: { list: [], index: -1 },
            escapeJsString: function(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); } };
        var m = await loadLenient(ICONS.concat([ESC, 'src/js/ui/290-screenshot-ui.js']), g);
        mods.push(m);
        var dom = await U.mountDom({ body: true, css: ALL_CSS });
        return { m: m, dom: dom };
    }
    test('open shows title/size/counter, prev hidden on first; arrows + keyboard navigate; bounds respected', async function() {
        var s = await setup(3);
        s.m.openScreenshotModal(PNG(0), 'shot 0', 10, 20, '');
        var ov = s.dom.$('#modal-overlay');
        assert.ok(ov.classList.contains('show') && ov.classList.contains('screenshot-modal'));
        assert.strictEqual(s.dom.$('.screenshot-modal-counter').textContent, '1 / 3');
        assert.strictEqual(s.dom.$('.screenshot-modal-size').textContent, '10 × 20px');
        assert.strictEqual(s.dom.$('.screenshot-nav-prev').style.display, 'none');
        assert.strictEqual(s.dom.$('#modal-body img').getAttribute('src'), PNG(0));
        var r = U.fireInline(s.dom.$('.screenshot-nav-next'), 'click', s.m);
        assert.ok(r.stopped, 'arrow click does not close the overlay');
        assert.strictEqual(s.dom.$('.screenshot-modal-counter').textContent, '2 / 3');
        assert.strictEqual(s.dom.$('.screenshot-nav-prev').style.display, '');
        assert.strictEqual(s.dom.$('.screenshot-modal-title').textContent.indexOf(HOSTILE) >= 0, true, 'hostile name as text');
        assert.strictEqual(s.dom.$('#modal-header img, #modal-header script'), null);
        var ev = U.key(document, 'ArrowRight'); // real keydown → listener attached by open
        assert.ok(ev.defaultPrevented);
        assert.strictEqual(s.dom.$('.screenshot-modal-counter').textContent, '3 / 3');
        assert.strictEqual(s.dom.$('.screenshot-nav-next').style.display, 'none');
        U.key(document, 'ArrowRight');
        assert.strictEqual(s.dom.$('.screenshot-modal-counter').textContent, '3 / 3', 'no wrap past last');
        U.key(document, 'ArrowLeft');
        assert.strictEqual(s.dom.$('#modal-body img').getAttribute('src'), PNG(1));
    }, { tags: ['unit'] });
    test('single screenshot: no nav arrows / counter; keys ignored when overlay not a screenshot modal', async function() {
        var s = await setup(1);
        s.m.openScreenshotModal(PNG(0), '', 0, 0, '');
        assert.strictEqual(s.dom.$('.screenshot-nav-prev'), null); assert.strictEqual(s.dom.$('.screenshot-modal-counter'), null);
        assert.strictEqual(s.dom.$('.screenshot-modal-title').textContent, 'Screenshot', 'default title');
        s.dom.$('#modal-overlay').classList.remove('screenshot-modal');
        var ev = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
        s.m.screenshotModalKeyHandler(ev);
        assert.strictEqual(ev.defaultPrevented, false);
    }, { tags: ['unit'] });
    test('openScreenshotModal interpolates src into <img src="..."> unescaped (ui/290-screenshot-ui.js:77)', async function() {
        var s = await setup(1);
        s.m.openScreenshotModal('x" onerror="window.__pwn=3', 't', 0, 0, '');
        assert.strictEqual(s.dom.$('#modal-body img').hasAttribute('onerror'), false, 'src must not break out of the attribute');
    }, { tags: ['unit'] });
});

// ─────────────────────────── Integrity (runs last: loads the whole bundle) ───────────────────────────
describe('ui integrity › body.html wiring', function() {
    // IDs referenced by src that no longer exist anywhere (body.html or dynamic
    // markup). Every call site is null-guarded, so they are dead code, not
    // crashes; kept explicit so a NEW orphan fails the test.
    var STALE_IDS = {
        'browse-icon': 'core/120-init.js:114 — guarded icon init for a removed button',
        'home-browse-icon': 'core/120-init.js:119 — guarded icon init for a removed button',
        'section-icon-cache': 'core/120-init.js:160 — gear panel lost its Cache section',
        'widget-history-modal-overlay': 'core/120-init.js:251,360 — showWidgetHistory now reuses the widget modal',
        'settings-provider-container': 'ui/010-skills-ui.js:1195 — populateProviderDropdown returns early',
        'tool-permissions-list': 'ui/140-dropdowns.js:152 — renderToolPermissions returns early (settings page uses its own list)'
    };
    async function srcFiles() { return (await buildOrder(WS)); }
    test('every on* handler in body.html calls a function defined by the real bundle', async function() {
        var order = (await srcFiles()).filter(function(p) { return p !== 'src/js/app/030-agent-loop.js'; }); // 045 redeclares runAgent (async fn dup is a SyntaxError inside one with-block; the real bundle keeps the later one)
        var win = winStub();
        var m = await loadLenient(order, { window: win, chrome: fakeChrome() });
        var doc = U.parse(await loadFile('src/html/body.html', WS));
        var names = {}, count = 0;
        Array.prototype.forEach.call(doc.querySelectorAll('*'), function(el) {
            Array.prototype.forEach.call(el.attributes, function(a) {
                if (!/^on/.test(a.name)) return;
                count++;
                var code = a.value.replace(/'[^']*'|"[^"]*"/g, "''"), re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g, mm;
                while ((mm = re.exec(code))) if (['if', 'for', 'while', 'return', 'function', 'switch'].indexOf(mm[2]) < 0) (names[mm[2]] = names[mm[2]] || []).push(el.id || el.tagName);
            });
        });
        assert.ok(count >= 100, 'body.html handler count sanity: ' + count);
        assert.ok(Object.keys(names).length >= 60, 'distinct handler fns: ' + Object.keys(names).length);
        var missing = Object.keys(names).filter(function(n) { return typeof m[n] !== 'function' && typeof m.__scope[n] !== 'function' && typeof win[n] !== 'function'; });
        assert.deepStrictEqual(missing.map(function(n) { return n + ' <- #' + names[n].join(',#'); }), [], 'inline handlers must resolve');
    }, { tags: ['unit'], timeout: 60000 });
    test('every getElementById / querySelector("#id") literal in src exists in body.html or is created dynamically', async function() {
        var files = await srcFiles();
        var bodyIds = {}; Array.prototype.forEach.call(U.parse(await loadFile('src/html/body.html', WS)).querySelectorAll('[id]'), function(e) { bodyIds[e.id] = 1; });
        var all = '', refs = {};
        for (var i = 0; i < files.length; i++) {
            var s = await loadFile(files[i], WS); all += s + '\n';
            var re = /getElementById\(\s*['"]([^'"]+)['"]\s*\)|querySelector(?:All)?\(\s*['"]#([\w-]+)['"]\s*\)/g, mm;
            while ((mm = re.exec(s))) { var id = mm[1] || mm[2]; (refs[id] = refs[id] || []).push(files[i].replace('src/js/', '')); }
        }
        assert.ok(Object.keys(refs).length > 150, 'ref sanity: ' + Object.keys(refs).length);
        function dynamic(id) {
            var e = id.replace(/[-]/g, '\\-');
            return new RegExp('id=\\\\?["\']' + e + '\\\\?["\']|\\.id\\s*=\\s*[\'"]' + e + '[\'"]|\\bid:\\s*[\'"]' + e + '[\'"]').test(all);
        }
        var orphans = Object.keys(refs).filter(function(id) { return !bodyIds[id] && !dynamic(id) && !STALE_IDS[id]; });
        assert.deepStrictEqual(orphans.map(function(id) { return id + ' <- ' + refs[id].join(','); }), [], 'unresolved element ids');
        var staleNowReal = Object.keys(STALE_IDS).filter(function(id) { return bodyIds[id] || dynamic(id) || !refs[id]; });
        assert.deepStrictEqual(staleNowReal, [], 'STALE_IDS allow-list must stay minimal (remove fixed/unreferenced entries)');
        ['sidebar', 'main-area', 'messages', 'message-input', 'send-btn', 'modal-overlay', 'history-list', 'settings-panel-theme', 'chat-list'].forEach(function(id) {
            assert.ok(bodyIds[id], 'core shell id #' + id);
        });
    }, { tags: ['unit'], timeout: 60000 });
});
