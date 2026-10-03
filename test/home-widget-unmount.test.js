// Run: run_tests { pattern: 'home-widget-unmount' }
// MEMORY: pinned home widgets must not keep running while Home is hidden, and
// dashboard/home widget iframes mount lazily (IntersectionObserver). Real
// declarations are sliced from source and run against the sandbox DOM with a
// controllable fake IntersectionObserver + the REAL live-widget registry.
'use strict';

function hwDecl(src, name) {
    var start = src.indexOf('function ' + name + '(');
    var end = src.indexOf('\n}', start);
    if (start < 0 || end < start) throw new Error('Missing declaration: ' + name);
    return src.slice(start, end + 2);
}

async function hwBuild(opts) {
    opts = opts || {};
    var dash = await loadFile('src/js/ui/070-dashboard-ui.js');
    var home = await loadFile('src/js/ui/030-home-view.js');
    var evalSrc = await loadFile('src/js/tools/085-widget-eval.js');
    var registry = evalSrc.slice(0, evalSrc.indexOf("window.addEventListener('message'"));
    var code = registry + '\n' + ['renderWidgetContent', '_mountWidgetIframe', '_disconnectWidgetLazyMount',
        '_unmountWidgetIframe', 'unmountWidgetContainer', 'unmountDashboardWidgets', 'writeWidgetHtml', '_widgetContainerProvablyOffscreen']
        .map(function(n) { return hwDecl(dash, n); }).join('\n') + '\n' + hwDecl(home, 'closeHomeView') +
        '\nreturn { renderWidgetContent: renderWidgetContent, unmountDashboardWidgets: unmountDashboardWidgets,' +
        ' closeHomeView: closeHomeView, listWidgetInstances: listWidgetInstances, setView: function(v){ currentView = v; }, getView: function(){ return currentView; } };';
    var observers = [];
    function FakeIO(cb) { this.cb = cb; this.targets = []; this.disconnected = false; observers.push(this); }
    FakeIO.prototype.observe = function(el) { this.targets.push(el); };
    FakeIO.prototype.disconnect = function() { this.disconnected = true; this.targets = []; };
    FakeIO.prototype.fire = function(isIntersecting) {
        var self = this;
        this.cb(this.targets.map(function(t) { return { target: t, isIntersecting: isIntersecting }; }), this);
    };
    var root = document.createElement('div');
    root.innerHTML = '<div id="home-panel" style="display:flex"><div id="home-dashboard-grid" class="dashboard-grid"></div></div>' +
        '<div id="dashboard-panel"><div id="dashboard-grid" class="dashboard-grid"></div></div>';
    document.body.appendChild(root);
    var gen = { main: 0, home: 0 };
    var calls = [];
    var g = {
        currentView: 'home',
        IntersectionObserver: opts.noIO ? undefined : FakeIO,
        WidgetStore: { view: function() { return null; } },
        isWidgetDeactivated: function() { return false; },
        dashboardWidgets: {},
        escapeHtml: function(s) { return String(s); }, t: function(s) { return s; },
        injectWidgetBridge: function(h) { return h; }, injectWidgetTokens: function(h) { return h; },
        attachWidgetVersionPicker: function() {},
        dashboardRenderGeneration: gen,
        dashboardGridEl: function(d) { return root.querySelector(d === 'home' ? '#home-dashboard-grid' : '#dashboard-grid'); },
        appStorage: { setItem: function() {} },
        stopHomeTrailAnimation: function() { calls.push('stopTrail'); },
        showChatView: function() { calls.push('showChatView'); },
        updateAllButtonStates: function() {},
        window: new Proxy(window, { get: function(t, k) { if (k === 'innerHeight') return 800; if (k === 'innerWidth') return 1200; var v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } }),
        document: { getElementById: function(id) { return root.querySelector('#' + id); }, documentElement: document.documentElement,
            createElement: function(tag) { return document.createElement(tag); } }
    };
    var keys = Object.keys(g);
    var api = new Function(keys.join(','), code).apply(null, keys.map(function(k) { return g[k]; }));
    // layout: undefined = real sandbox layout (may have none); 'offscreen' /
    // 'visible' = stubbed client rects (toggle c.__hidden to drop them).
    function addCard(dashboard, id, layout) {
        var grid = g.dashboardGridEl(dashboard);
        var card = document.createElement('div');
        card.className = 'dashboard-widget'; card.setAttribute('data-widget-id', id);
        card.innerHTML = '<div class="dashboard-widget-content" id="dashboard-widget-content-' + id + '" style="height:50px"></div>';
        grid.appendChild(card);
        var c = card.querySelector('.dashboard-widget-content');
        if (layout) {
            var top = layout === 'offscreen' ? 100000 : 10;
            c.getClientRects = function() { return c.__hidden ? [] : [{}]; };
            c.getBoundingClientRect = function() { return c.__hidden ? { top: 0, bottom: 0, left: 0, right: 0 } : { top: top, bottom: top + 50, left: 0, right: 50 }; };
        }
        return c;
    }
    function iframeIn(c) { var h = c.querySelector('.widget-shadow-host'); return h && h.shadowRoot ? h.shadowRoot.querySelector('iframe') : null; }
    return { api: api, root: root, observers: observers, gen: gen, calls: calls, addCard: addCard, iframeIn: iframeIn,
        cleanup: function() { root.querySelectorAll('.dashboard-widget-content').forEach(function(c) { if (c.__widgetLazyObs) c.__widgetLazyObs.disconnect(); var f = iframeIn(c); if (f && f.__widgetCleanup) f.__widgetCleanup(); }); root.remove(); } };
}

describe('home widget unmount + lazy mount', function() {
    test('lazy: iframe mounts only once the card intersects', async function() {
        var h = await hwBuild();
        try {
            var c = h.addCard('home', 'w1', 'offscreen');
            h.api.renderWidgetContent({ id: 'w1', title: 'W', html: '<p>x</p>' });
            assert.strictEqual(h.iframeIn(c), null, 'not mounted before intersection');
            assert.strictEqual(h.observers.length, 1);
            h.observers[0].fire(false);
            assert.strictEqual(h.iframeIn(c), null, 'still unmounted when off-screen');
            h.observers[0].fire(true);
            assert.ok(h.iframeIn(c), 'mounted on intersection');
            assert.strictEqual(h.api.listWidgetInstances().filter(function(i) { return i.widget_id === 'w1'; }).length, 1);
            h.observers[0].fire(true);
            assert.strictEqual(c.querySelectorAll('.widget-shadow-host').length, 1, 'no double mount');
        } finally { h.cleanup(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('lazy: an on-screen card mounts synchronously (callers read the iframe right away)', async function() {
        var h = await hwBuild();
        try {
            var c = h.addCard('main', 'w0');
            h.api.renderWidgetContent({ id: 'w0', title: 'W', html: '<p>x</p>' });
            assert.ok(h.iframeIn(c), 'mounted without waiting for the observer');
            assert.strictEqual(h.observers.length, 1, 'still observed for hide/show');
        } finally { h.cleanup(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('no IntersectionObserver: mounts immediately', async function() {
        var h = await hwBuild({ noIO: true });
        try {
            var c = h.addCard('main', 'w2');
            h.api.renderWidgetContent({ id: 'w2', title: 'W', html: '<p>x</p>' });
            assert.ok(h.iframeIn(c), 'mounted synchronously');
            assert.strictEqual(h.observers.length, 0);
        } finally { h.cleanup(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('closeHomeView unmounts home widgets, empties the grid and drops registry entries', async function() {
        var h = await hwBuild();
        try {
            var c = h.addCard('home', 'w3');
            var cm = h.addCard('main', 'w4');
            h.api.renderWidgetContent({ id: 'w3', title: 'W', html: '<p>x</p>' });
            h.api.renderWidgetContent({ id: 'w4', title: 'W', html: '<p>y</p>' });
            h.observers.forEach(function(o) { o.fire(true); });
            var f = h.iframeIn(c);
            assert.ok(f && h.iframeIn(cm));
            assert.strictEqual(h.api.listWidgetInstances().length, 2);
            var genBefore = h.gen.home;
            h.api.closeHomeView();
            assert.strictEqual(h.api.getView(), 'chat');
            assert.strictEqual(h.root.querySelector('#home-dashboard-grid').innerHTML, '', 'home grid emptied');
            assert.strictEqual(f.isConnected, false, 'home iframe detached');
            assert.strictEqual(h.observers[0].disconnected, true, 'lazy observer released');
            assert.strictEqual(h.gen.home, genBefore + 1, 'pending rAF render cancelled');
            var ids = h.api.listWidgetInstances().map(function(i) { return i.widget_id; });
            assert.deepStrictEqual(ids, ['w4'], 'only the main-dashboard instance survives');
            assert.ok(h.iframeIn(cm), 'main dashboard untouched');
            assert.ok(h.calls.indexOf('showChatView') >= 0);
        } finally { h.cleanup(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('hidden home (hideAllPanels path) unmounts via the observer and re-mounts when shown', async function() {
        var h = await hwBuild();
        try {
            var c = h.addCard('home', 'w5', 'visible');
            h.api.renderWidgetContent({ id: 'w5', title: 'W', html: '<p>x</p>' });
            assert.ok(h.iframeIn(c), 'visible card mounted synchronously');
            h.observers[0].fire(true);
            assert.strictEqual(c.querySelectorAll('.widget-shadow-host').length, 1, 'no double mount');
            h.root.querySelector('#home-panel').style.display = 'none';
            c.__hidden = true;
            h.observers[0].fire(false);
            assert.strictEqual(h.iframeIn(c), null, 'unmounted while hidden');
            assert.strictEqual(h.api.listWidgetInstances().length, 0, 'registry dropped');
            h.root.querySelector('#home-panel').style.display = 'flex';
            c.__hidden = false;
            h.observers[0].fire(true);
            assert.ok(h.iframeIn(c), 're-mounted when visible');
        } finally { h.cleanup(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('scrolling a visible card off-screen does not unmount it (state kept)', async function() {
        var h = await hwBuild();
        try {
            var c = h.addCard('home', 'w6', 'visible');
            h.api.renderWidgetContent({ id: 'w6', title: 'W', html: '<p>x</p>' });
            h.observers[0].fire(true);
            h.observers[0].fire(false); // still displayed -> has client rects
            assert.ok(h.iframeIn(c), 'kept mounted');
        } finally { h.cleanup(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('no layout (no client rects): mounts synchronously and the observer never unmounts it (no loop)', async function() {
        var h = await hwBuild();
        try {
            var c = h.addCard('home', 'w8');
            c.getClientRects = function() { return []; };
            h.api.renderWidgetContent({ id: 'w8', title: 'W', html: '<p>x</p>' });
            var f = h.iframeIn(c);
            assert.ok(f, 'mounted right away');
            h.observers[0].fire(false);
            h.observers[0].fire(false);
            assert.strictEqual(h.iframeIn(c), f, 'same iframe kept (never mounted while visible)');
            h.observers[0].fire(true);
            assert.strictEqual(c.querySelectorAll('.widget-shadow-host').length, 1, 'no re-mount');
        } finally { h.cleanup(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('re-render releases the previous observer', async function() {
        var h = await hwBuild();
        try {
            h.addCard('main', 'w7');
            h.api.renderWidgetContent({ id: 'w7', title: 'W', html: '<p>x</p>' });
            h.api.renderWidgetContent({ id: 'w7', title: 'W', html: '<p>x2</p>' });
            assert.strictEqual(h.observers.length, 2);
            assert.strictEqual(h.observers[0].disconnected, true);
            assert.strictEqual(h.observers[1].disconnected, false);
        } finally { h.cleanup(); }
    }, { tags: ['unit'], timeout: 4000 });
});

describe('sidebar limit reset + kbdStepChat expansion', function() {
    async function sidebar(n) {
        var src = await loadFile('src/js/ui/180-search.js');
        var kbd = await loadFile('src/js/ui/320-keyboard-shortcuts.js');
        var list = document.createElement('div');
        list.id = 'chat-list';
        document.body.appendChild(list);
        var sorted = [];
        for (var i = 0; i < n; i++) sorted.push({ id: 'c' + i });
        var state = { currentChatId: 'c0' };
        var code = 'var CHAT_LIST_PAGE_SIZE = 50; var _chatListLimit = CHAT_LIST_PAGE_SIZE; var _chatListLimitChatId = null;\n' +
            hwDecl(src, '_maybeResetChatListLimit') + '\n' + hwDecl(kbd, '_kbdChatListIds') + '\n' + hwDecl(kbd, 'kbdStepChat') + '\n' +
            'function _render() { _maybeResetChatListLimit(sorted, state.currentChatId); var vis = sorted.slice(0, _chatListLimit);' +
            ' var hidden = sorted.length - vis.length; if (hidden > 0) { for (var k = _chatListLimit; k < sorted.length; k++) if (sorted[k].id === state.currentChatId) { vis.push(sorted[k]); hidden--; break; } }' +
            ' list.innerHTML = vis.map(function(c){ return \'<div class="chat-item" data-chat-id="\' + c.id + \'"></div>\'; }).join(\'\') + (hidden > 0 ? \'<div class="chat-list-more"></div>\' : \'\'); }\n' +
            'function showMoreChatListItems() { _chatListLimit += CHAT_LIST_PAGE_SIZE; _render(); }\n' +
            'function selectChat(id) { state.currentChatId = id; currentChatId = id; _render(); }\n' +
            'var currentChatId = state.currentChatId; _render();\n' +
            'return { render: _render, more: showMoreChatListItems, select: selectChat, step: kbdStepChat, limit: function(){ return _chatListLimit; }, rows: function(){ return list.querySelectorAll(".chat-item").length; } };';
        var api = new Function('sorted', 'state', 'list', 'document', code)(sorted, state,
            list, { getElementById: function(id) { return id === 'chat-list' ? list : null; } });
        api.state = state; api.list = list;
        return api;
    }

    test('limit resets to 50 when switching to a chat in the first page; kept for a deep chat', async function() {
        var s = await sidebar(200);
        try {
            s.more(); s.more();
            assert.strictEqual(s.limit(), 150);
            s.select('c120');
            assert.strictEqual(s.limit(), 150, 'deep chat keeps the expansion');
            s.select('c10');
            assert.strictEqual(s.limit(), 50, 'reset on switching to a first-page chat');
            assert.strictEqual(s.rows(), 50);
        } finally { s.list.remove(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('ArrowDown past the last rendered row expands by 50 and continues', async function() {
        var s = await sidebar(120);
        try {
            s.select('c49');
            assert.strictEqual(s.rows(), 50);
            assert.strictEqual(s.step(1), true);
            assert.strictEqual(s.state.currentChatId, 'c50');
            assert.strictEqual(s.limit(), 100);
            s.select('c119'); // beyond the cap: appended after row 100
            assert.strictEqual(s.step(1), false, 'no wrap at the true end');
            s.select('c99');
            assert.strictEqual(s.step(1), true);
            assert.strictEqual(s.state.currentChatId, 'c100');
            assert.strictEqual(s.limit(), 150);
        } finally { s.list.remove(); }
    }, { tags: ['unit'], timeout: 4000 });

    test('ArrowDown from an appended beyond-cap active chat reaches its real successor', async function() {
        var s = await sidebar(200);
        try {
            s.select('c120'); // limit 50: rendered as rows c0..c49 + c120
            assert.strictEqual(s.rows(), 51);
            assert.strictEqual(s.step(1), true);
            assert.strictEqual(s.state.currentChatId, 'c121');
        } finally { s.list.remove(); }
    }, { tags: ['unit'], timeout: 4000 });
});
