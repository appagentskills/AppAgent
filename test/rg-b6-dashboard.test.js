// RG-F33 (post-reload regression pass, B6 part 1) — tools/080-widget-tools.js:
//   NEW-V15-1  scrollToWidget (reached from a chat ID chip via openWidgetMention,
//              and from the widget sidebar): a card that is in the DOM but NOT on
//              screen — inside a collapsed "Widgets" group (<details> without
//              [open], ui/250-message-render.js:1194-1195), not rendered (no
//              layout box) or zero-size — falls back to the modal instead of a
//              silent scroll/highlight of an invisible card.
//   TA-11      toggleWidgetRunning updates EVERY present container, so a hidden
//              inline chat card no longer shadows the dashboard card.
// Real modules are loaded with U.loadUi and driven on the real sandbox document.
// The sandbox has NO layout (every element is 0x0 with no client rects), so an
// on-screen card is simulated by stubbing that card's own geometry methods.
// Run: run_tests { files: ['test/rg-b6-dashboard.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var WG_FILES = ['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/core/135-widget-store.js', 'src/js/ui/070-dashboard-ui.js',
    'src/js/tools/080-widget-tools.js'];
var W1 = { id: 'widget_a', title: 'Sales board', html: '<div>hi</div>', contentVersion: 2, msgIndex: 3, lastHeight: 120 };
// The widget ID chip exactly as decorateIdMentions emits it (ui/250-message-render.js:2511).
var CHIP = '<span class="id-mention id-mention-widget" onclick="openWidgetMention(\'widget_a\', event)" title="Open widget">widget_a</span>';

// Window stand-in whose add/removeEventListener are observable (as in ui-smart-docs-widgets).
function listenerWindow() {
    var L = [];
    return { document: document, _listeners: L, _rawCopyStore: {},
        addEventListener: function(t, f) { L.push([t, f]); },
        removeEventListener: function(t, f) { for (var i = L.length - 1; i >= 0; i--) if (L[i][0] === t && L[i][1] === f) L.splice(i, 1); },
        open: function() { return null; },
        count: function(t) { return L.filter(function(l) { return l[0] === t; }).length; } };
}
function widgetStoreStub(widget) {
    return {
        view: function(id, v) { return id === widget.id ? Object.assign({}, widget, { contentVersion: v ? Number(v) : 2, html: v ? '<p>v' + v + '</p>' : widget.html }) : null; },
        versions: function(id) { return id === widget.id ? [{ version: 1, createdAt: 1 }, { version: 2, createdAt: 2 }] : []; },
        list: function() { return []; },
        read: function() { return Promise.resolve(); }
    };
}
async function loadWidgets(opts) {
    opts = opts || {};
    var s = U.stubs(), win = listenerWindow(), w = Object.assign({}, W1, opts.widget || {});
    var m = await U.loadUi(WG_FILES, { window: win, globals: { chats: { c1: { id: 'c1', widgets: [w], messages: [] } }, currentChatId: 'c1',
        chatWidgets: {}, dashboardWidgets: opts.dashboard || {}, dbName: 'uitest', BroadcastChannel: undefined, expandedWidgetId: null,
        saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar, chrome: s.chrome } });
    var sc = m.__scope;
    sc.WidgetStore = widgetStoreStub(w);
    sc.escapeJsString = function(x) { return String(x).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c'); };
    sc.registerWidgetInstance = U.recorder(function(iframe, id) { return id ? { instance_id: 'inst_' + id } : null; });
    sc.unregisterWidgetInstance = U.recorder();
    return { m: m, s: s, win: win, w: w, base: win.count('message') };
}

// Simulate layout for ONE element: `rects` client rects and a w x h box.
function layout(el, w, h, rects) {
    var n = rects === undefined ? 1 : rects, box = { x: 0, y: 0, top: 0, left: 0, width: w, height: h, right: w, bottom: h };
    el.getClientRects = function() { var a = []; for (var i = 0; i < n; i++) a.push(box); return a; };
    el.getBoundingClientRect = function() { return box; };
    return el;
}
function modal() { return document.getElementById('widget-modal-overlay'); }
// The "Widgets" group exactly as ui/250-message-render.js:1194-1195 renders it.
function groupHtml(m, open) {
    return '<details class="widgets-details" data-widget-group-idx="0"' + (open ? ' open' : '') + '><summary class="widgets-summary">Widgets</summary>' +
        '<div class="widgets-container">' + m.getWidgetHtmlForMessage(3) + '</div></details>';
}

describe('RG-B6 › NEW-V15-1 a widget chip on a hidden card opens the modal', function() {
    afterEach(function() { U.cleanupAll(); var o = modal(); if (o) o.remove(); });

    test('a chip on a collapsed-group card opens the modal', async function() {
        var x = await loadWidgets();
        var dom = await U.mountDom({ html: groupHtml(x.m, false) + CHIP });
        var group = dom.$('details.widgets-details'), card = dom.$('#widget-widget_a');
        // Layout still reports a box for the card (Chrome can lay out closed-<details>
        // content), so ONLY the collapsed group makes it hidden here.
        layout(card, 300, 200); card.scrollIntoView = U.recorder();
        assert.strictEqual(group.open, false);
        var info = U.fireInline(dom.$('.id-mention-widget'), 'click', x.m);
        assert.strictEqual(info.stopped && info.prevented, true, 'the chip handler consumed the click');
        assert.ok(modal(), 'the modal opened for the collapsed-group card');
        assert.ok(modal().querySelector('.widget-modal-content iframe.widget-iframe'), 'the modal renders the widget');
        assert.strictEqual(card.scrollIntoView.calls.length, 0, 'no scroll to the hidden card');
        assert.strictEqual(card.classList.contains('highlight'), false, 'the hidden card is not highlighted');
        x.m.closeWidgetModal();
        assert.strictEqual(modal(), null);
        assert.strictEqual(x.win.count('message'), x.base, 'modal listeners released');
        // Control: the SAME card with its group expanded is scrolled to + highlighted.
        group.open = true;
        U.fireInline(dom.$('.id-mention-widget'), 'click', x.m);
        assert.strictEqual(modal(), null, 'no modal for an on-screen card');
        assert.deepStrictEqual(card.scrollIntoView.calls, [[{ behavior: 'smooth', block: 'center' }]]);
        assert.strictEqual(card.classList.contains('highlight'), true);
    }, { tags: ['unit'] });

    test('a not-rendered or zero-size card opens the modal; an on-screen card is highlighted', async function() {
        var x = await loadWidgets();
        // (a) Not rendered: the sandbox has no layout, so an unstubbed card has no client
        // rects, exactly like a card under a display:none view in the panel.
        var dom = await U.mountDom({ html: '<div class="widgets-container" style="display:none">' + x.m.getWidgetHtmlForMessage(3) + '</div>' });
        var card = dom.$('#widget-widget_a'); card.scrollIntoView = U.recorder();
        assert.strictEqual(card.getClientRects().length, 0);
        x.m.scrollToWidget('widget_a');
        assert.ok(modal(), 'not rendered -> modal');
        assert.strictEqual(card.classList.contains('highlight'), false);
        x.m.closeWidgetModal();
        // (b) Zero-size: a layout box exists, but it is 0x0.
        layout(card, 0, 0);
        x.m.scrollToWidget('widget_a');
        assert.ok(modal(), 'zero-size -> modal');
        assert.strictEqual(card.scrollIntoView.calls.length, 0);
        assert.strictEqual(card.classList.contains('highlight'), false);
        x.m.closeWidgetModal();
        // (c) On screen: highlighted in place, no modal.
        layout(card, 300, 200);
        x.m.scrollToWidget('widget_a');
        assert.strictEqual(modal(), null, 'on-screen card -> no modal');
        assert.strictEqual(card.scrollIntoView.calls.length, 1);
        assert.strictEqual(card.classList.contains('highlight'), true);
        dom.cleanup();
        // (d) The <summary> of a closed <details> stays visible, so a card there is on screen.
        var dom2 = await U.mountDom({ html: '<details><summary>' + x.m.getWidgetHtmlForMessage(3) + '</summary><p>body</p></details>' });
        var card2 = layout(dom2.$('#widget-widget_a'), 300, 200); card2.scrollIntoView = U.recorder();
        x.m.scrollToWidget('widget_a');
        assert.strictEqual(modal(), null, 'a card in a closed details summary is on screen');
        assert.strictEqual(card2.scrollIntoView.calls.length, 1);
        assert.strictEqual(card2.classList.contains('highlight'), true);
    }, { tags: ['unit'] });
});

describe('RG-B6 › TA-11 toggleWidgetRunning updates every present container', function() {
    afterEach(function() { U.cleanupAll(); var o = document.getElementById('widget-fullscreen-overlay'); if (o) o.remove(); });

    test('the dashboard card re-renders while a hidden inline card is also mounted', async function() {
        var x = await loadWidgets({ dashboard: { widget_a: { id: 'widget_a', html: W1.html, dashboard: 'main' } } });
        var sc = x.m.__scope, saves = [];
        sc.WidgetStore.project = function() {};
        sc.saveDashboardWidget = function(w, skipHistory) { saves.push([w === sc.dashboardWidgets.widget_a, w.deactivated, skipHistory]); return Promise.resolve(); };
        // The chat view (with the inline card) is hidden while the dashboard page is shown.
        var dom = await U.mountDom({ html: '<div class="chat-view" style="display:none"><div id="widget-content-widget_a"></div></div>' +
            '<div id="dashboard-widget-content-widget_a"></div><button class="widget-stop-btn" data-widget-id="widget_a"></button>' });
        var inline = dom.$('#widget-content-widget_a'), dash = dom.$('#dashboard-widget-content-widget_a');
        x.m.renderWidgetInContainer(x.w, inline);
        x.m.renderWidgetContent(sc.dashboardWidgets.widget_a);
        assert.ok(inline.querySelector('iframe.widget-iframe'), 'inline card live before');
        assert.ok(dash.querySelector('.widget-shadow-host'), 'dashboard card live before');
        // Deactivate (e.g. from the dashboard's expanded card, ui/070-dashboard-ui.js:77).
        x.m.toggleWidgetRunning('widget_a');
        assert.strictEqual(dash.querySelector('.widget-shadow-host'), null, 'the dashboard card is torn down');
        assert.strictEqual(dash.textContent, 'Widget deactivated.', 'the dashboard card shows the placeholder');
        assert.strictEqual(inline.querySelector('iframe'), null, 'the inline card is torn down too');
        assert.strictEqual(inline.textContent, 'Widget deactivated.');
        assert.strictEqual(sc.dashboardWidgets.widget_a.deactivated, true);
        assert.strictEqual(x.w.deactivated, true);
        assert.strictEqual(dom.$('.widget-stop-btn').title, 'Activate Widget');
        // Activate: each card is re-rendered by its own renderer.
        x.m.toggleWidgetRunning('widget_a');
        assert.ok(dash.querySelector('.widget-shadow-host'), 'the dashboard card re-renders (grid renderer)');
        assert.strictEqual(dash.textContent.indexOf('Widget deactivated.'), -1);
        assert.ok(inline.querySelector('iframe.widget-iframe'), 'the inline card re-renders (inline renderer)');
        assert.strictEqual(inline.querySelector('.widget-shadow-host'), null);
        assert.strictEqual(sc.dashboardWidgets.widget_a.deactivated, false);
        assert.strictEqual(x.w.deactivated, false);
        assert.strictEqual(dom.$('.widget-stop-btn').title, 'Deactivate Widget');
        assert.deepStrictEqual(saves, [[true, true, true], [true, false, true]], 'the dashboard record is persisted once per toggle, with no revision');
    }, { tags: ['unit'], timeout: 5000 });
});

// RG-F35 (B6 part 2) — ui/070-dashboard-ui.js:
//   TA-8   confirmDeleteDashboardWidget: the confirm TITLE names where the widget
//          is pinned ("Remove from Home" for a Home widget), like its message.
//   TA-10  expandDashboardWidget: a stopped (deactivated) widget shows the
//          "Widget deactivated." placeholder and mounts NO iframe.
describe('RG-B6 › TA-8 the Home remove confirm is titled "Remove from Home"', function() {
    afterEach(function() { U.cleanupAll(); });

    test('the confirm title follows where the widget is pinned', async function() {
        var x = await loadWidgets({ dashboard: {
            widget_h: { id: 'widget_h', title: 'H', html: '<p>h</p>', dashboard: 'home' },
            widget_a: { id: 'widget_a', title: 'Sales board', html: W1.html, dashboard: 'main' } } });
        var sc = x.m.__scope, confirms = [];
        // Same mapping as ui/020-dashboard.js:116-118 (that file is not loaded here).
        sc.widgetDashboardOf = function(w) { return (w && w.dashboard === 'home') ? 'home' : 'main'; };
        sc.showConfirmModal = async function(t, msg, v) { confirms.push([t, msg, v]); return false; };
        await x.m.confirmDeleteDashboardWidget('widget_h');
        await x.m.confirmDeleteDashboardWidget('widget_a');
        assert.strictEqual(confirms.length, 2);
        assert.strictEqual(confirms[0][0], 'Remove from Home', 'the confirm of a Home widget is titled Home');
        assert.strictEqual(confirms[0][1], 'Remove "H" from Home? The widget and its saved versions stay in your library.');
        assert.strictEqual(confirms[0][2], 'danger');
        assert.strictEqual(confirms[1][0], 'Remove from Dashboard', 'a main-dashboard widget keeps its title');
        assert.strictEqual(confirms[1][1], 'Remove "Sales board" from the dashboard? The widget and its saved versions stay in your library.');
        assert.ok(sc.dashboardWidgets.widget_h && sc.dashboardWidgets.widget_a, 'cancel removes nothing');
    }, { tags: ['unit'] });
});

describe('RG-B6 › TA-10 the expanded view of a stopped widget mounts no iframe', function() {
    afterEach(function() { U.cleanupAll(); var o = document.getElementById('widget-fullscreen-overlay'); if (o) o.remove(); });

    test('stopped: the placeholder and no iframe; running: the iframe mounts', async function() {
        var x = await loadWidgets({ dashboard: { widget_a: { id: 'widget_a', title: 'Sales board', html: W1.html, dashboard: 'main', deactivated: true } } });
        var sc = x.m.__scope;
        sc.WidgetStore.project = function() {};
        x.m.expandDashboardWidget('widget_a');
        var content = document.getElementById('widget-fullscreen-content');
        assert.ok(content, 'the expanded modal opens');
        assert.strictEqual(content.querySelector('iframe'), null, 'a stopped widget mounts no iframe');
        assert.strictEqual(content.textContent, 'Widget deactivated.', 'the stopped placeholder is shown');
        assert.strictEqual(document.querySelector('#widget-fullscreen-overlay .widget-stop-btn').title, 'Activate Widget');
        x.m.closeExpandedWidget();
        assert.strictEqual(document.getElementById('widget-fullscreen-overlay'), null);
        // Stopped through the chat copy only (A6A3-01 merged flag, tools/080-widget-tools.js:203-207).
        sc.dashboardWidgets.widget_a.deactivated = false;
        x.w.deactivated = true;
        x.m.expandDashboardWidget('widget_a');
        content = document.getElementById('widget-fullscreen-content');
        assert.strictEqual(content.querySelector('iframe'), null, 'the stopped flag of the chat copy is honoured too');
        assert.strictEqual(content.textContent, 'Widget deactivated.');
        x.m.closeExpandedWidget();
        // Running: the iframe still mounts (unchanged path).
        x.w.deactivated = false;
        x.m.expandDashboardWidget('widget_a');
        content = document.getElementById('widget-fullscreen-content');
        assert.ok(content.querySelector('iframe.widget-iframe'), 'a running widget mounts its iframe');
        assert.strictEqual(content.textContent.indexOf('Widget deactivated.'), -1);
        assert.strictEqual(document.querySelector('#widget-fullscreen-overlay .widget-stop-btn').title, 'Deactivate Widget');
    }, { tags: ['unit'], timeout: 5000 });
});

// RG-F36 (B6 part 3) — ui/070-dashboard-ui.js:
//   TA4-6  resetAllPermissionsToDefaults resets the instance the confirm dialog
//          NAMED (host0), even if the connected host changes while it is open.
// The REAL function is cut out of the workspace source (brace end '\n}\n', as in
// test/permissions-reset-confirm.test.js) and run over in-memory maps.
async function realReset(getHost, confirmResult) {
    var src = await loadFile('src/js/ui/070-dashboard-ui.js', WS);
    var a = src.indexOf('\nasync function resetAllPermissionsToDefaults(') + 1, b = src.indexOf('\n}\n', a);
    assert.ok(a > 0 && b > a, 'resetAllPermissionsToDefaults found');
    var S = { host: getHost, confirm: confirmResult, dialogs: [], saves: 0,
        inst: { 'a.service-now.com': { tier: 'autonomous', tools: { iw: 'allow' } }, 'b.service-now.com': { tier: 'full', tools: { iw: 'allow' } } } };
    var run = new Function('S',
        'var toolPermissions = {}, instancePermissions = S.inst, sessionPermissions = { c1: { w: "allow" } };\n' +
        'var GLOBAL_READ_KEYS = ["r"], GLOBAL_WRITE_KEYS = ["w"], INSTANCE_READ_KEYS = ["ir"], INSTANCE_WRITE_KEYS = ["iw"];\n' +
        'function getGlobalDefaultPermission(k) { return k === "web_fetch" ? "ask" : "auto"; }\n' +
        'function saveToolPermissions() {} function saveInstancePermissions() { S.saves++; } function pushPermissionsToOffscreen() {}\n' +
        'function renderToolPermissions() {} function renderSettingsToolPermissions() {} function updateSnStatus() {} function showSnackbar() {}\n' +
        'function escapeHtml(s) { return String(s); }\n' +
        'function getConnectedInstanceHost() { return S.host(); }\n' +
        'function showConfirmModal(title, message) { S.dialogs.push(message); return S.confirm; }\n' +
        src.slice(a, b + 2) + '\nreturn resetAllPermissionsToDefaults;')(S);
    return { run: run, S: S };
}

describe('RG-B6 › TA4-6 reset permissions resets the host the confirm named', function() {
    test('a host change while the confirm is open resets only host0', async function() {
        var host = 'a.service-now.com', resolve;
        var h = await realReset(function() { return host; }, new Promise(function(r) { resolve = r; }));
        var done = h.run();
        assert.strictEqual(h.S.dialogs.length, 1, 'the confirm is open');
        assert.ok(h.S.dialogs[0].indexOf('<strong>a.service-now.com</strong> goes back to the <strong>Manual</strong> tier') >= 0, 'the dialog names host0');
        host = 'b.service-now.com'; // the user connects another instance meanwhile
        resolve(true); await done;
        assert.deepStrictEqual(h.S.inst['a.service-now.com'], { tier: 'manual', tools: { ir: 'allow', iw: 'ask' } }, 'host0, named in the dialog, is reset');
        assert.deepStrictEqual(h.S.inst['b.service-now.com'], { tier: 'full', tools: { iw: 'allow' } }, 'the newly connected host is untouched');
        assert.strictEqual(h.S.saves, 1);
        // No host at confirm time: the dialog names none, so a host connected meanwhile is not reset.
        host = '';
        var h2 = await realReset(function() { return host; }, new Promise(function(r) { resolve = r; }));
        done = h2.run();
        assert.strictEqual(h2.S.dialogs[0].indexOf('<strong>'), -1, 'no host is named');
        host = 'b.service-now.com';
        resolve(true); await done;
        assert.deepStrictEqual(h2.S.inst['b.service-now.com'], { tier: 'full', tools: { iw: 'allow' } }, 'a host connected mid-confirm is not reset');
        assert.strictEqual(h2.S.saves, 0, 'no instance permissions were saved');
    }, { tags: ['unit'], timeout: 2000 });
});

// RG-F37 (B6 part 4) — ui/020-dashboard.js (+ its import caller in ui/070):
//   TB-7  saveDashboardWidget swallowed an IndexedDB throw AFTER its in-memory set,
//         so importDashboard counted every row as saved ("Imported N widget(s)").
//         The set is now rolled back and the error rethrown: the import reports
//         the rows really saved ("0 of N" when all fail). A caller that fires and
//         forgets (ui/070 grid migration, drag end, resize end) gets no unhandled
//         rejection from it.
// The REAL code is cut out of the workspace source: ui/020 from the
// DASHBOARD_CONTENT_FIELDS line up to deleteDashboardWidget, and ui/070's
// importDashboard (brace end '\n}\n'). IndexedDB is an in-memory stand-in.
function tb7State() {
    var S = { dw: {}, idb: {}, snacks: [], refreshes: 0, errors: [], input: null };
    S.console = { error: function() { S.errors.push([].slice.call(arguments)); }, warn: function() {}, log: function() {} };
    return S;
}
// fail(k) for the k-th openDatabase call: 'open' rejects, 'tx' throws in transaction(), 'put' fires request.onerror.
function tb7Idb(S, fail) {
    var k = 0;
    return function() {
        var mode = fail ? fail(++k) : null;
        if (mode === 'open') return Promise.reject(new Error('IDB unavailable'));
        return Promise.resolve({ transaction: function() {
            if (mode === 'tx') throw new Error('the database connection is closing');
            return { objectStore: function() { return { put: function(rec) {
                var req = {};
                Promise.resolve().then(function() {
                    if (mode === 'put') { req.error = new Error('put failed'); req.onerror(); } else { S.idb[rec.id] = rec; req.onsuccess(); }
                });
                return req;
            } }; } };
        } });
    };
}
async function realDashboardSave(S) {
    var s20 = await loadFile('src/js/ui/020-dashboard.js', WS), s70 = await loadFile('src/js/ui/070-dashboard-ui.js', WS);
    var a = s20.indexOf('\nvar DASHBOARD_CONTENT_FIELDS') + 1, b = s20.indexOf('\nasync function deleteDashboardWidget(', a);
    var c = s70.indexOf('\nasync function importDashboard(') + 1, d = s70.indexOf('\n}\n', c);
    assert.ok(a > 0 && b > a && c > 0 && d > c, 'saveDashboardWidget and importDashboard found');
    return new Function('S',
        'var dashboardWidgets = S.dw, dashboardWidgetsStoreName = "dashboardWidgets", console = S.console;\n' +
        'var WidgetStore = { view: function() { return null; } };\n' +
        'var document = { createElement: function() { return (S.input = { click: function() {} }); } };\n' +
        'function openDatabase() { return S.open(); }\n' +
        'function showSnackbar(msg, type) { S.snacks.push([type, msg]); }\n' +
        'function showConfirmModal() { return Promise.resolve(true); }\n' +
        'function refreshVisibleDashboards() { S.refreshes++; }\n' +
        s20.slice(a, b) + '\n' + s70.slice(c, d + 2) +
        '\nreturn { save: saveDashboardWidget, importDashboard: importDashboard };')(S);
}
async function tb7Import(h, S, rows) {
    await h.importDashboard();
    var json = JSON.stringify({ type: 'appagent-dashboard', version: 1, widgets: rows });
    await S.input.onchange({ target: { files: [{ text: function() { return Promise.resolve(json); } }] } });
}
function tb7Rows() { return [{ id: 'w1', title: 'A', html: '<p>a</p>' }, { id: 'w2', title: 'B', html: '<p>b</p>' }, { id: 'w3', title: 'C', html: '<p>c</p>' }]; }

describe('RG-B6 › TB-7 an IndexedDB failure is not reported as a saved widget', function() {
    test('saveDashboardWidget rejects and rolls back its in-memory set', async function() {
        var S = tb7State(); S.open = tb7Idb(S, function() { return 'open'; });
        var h = await realDashboardSave(S);
        await assert.rejects(h.save({ id: 'w_new', title: 'New', html: '<p>n</p>' }), /IDB unavailable/);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(S.dw, 'w_new'), false, 'a new widget is not left in memory');
        // Existing record (merge path): the same object stays, content and stamps are restored, placement is untouched.
        var rec = { id: 'w_old', title: 'Old', html: '<p>o</p>', gridX: 2, gridY: 3, updatedAt: 5, prompt: 'p' };
        S.dw.w_old = rec;
        S.open = tb7Idb(S, function() { return 'tx'; });
        await assert.rejects(h.save({ id: 'w_old', title: 'Imported', html: '<p>i</p>' }), /connection is closing/);
        assert.strictEqual(S.dw.w_old, rec, 'the record object stays');
        assert.deepStrictEqual(Object.assign({}, rec), { id: 'w_old', title: 'Old', html: '<p>o</p>', gridX: 2, gridY: 3, updatedAt: 5, prompt: 'p' }, 'no merged field or stamp survives');
        // An async put error already rejected; now it is rolled back too.
        S.open = tb7Idb(S, function() { return 'put'; });
        await assert.rejects(h.save({ id: 'w_put', title: 'P' }), /put failed/);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(S.dw, 'w_put'), false);
        // Healthy IndexedDB: unchanged, resolves with the record in memory and in the store.
        S.open = tb7Idb(S);
        assert.strictEqual(await h.save({ id: 'w_ok', title: 'OK' }), undefined);
        assert.strictEqual(S.dw.w_ok.title, 'OK');
        assert.strictEqual(S.idb.w_ok.title, 'OK');
        assert.ok(S.errors.length >= 3, 'every failure is logged');
    }, { tags: ['unit'], timeout: 2000 });

    test('an import whose writes all fail says "0 of N", not success', async function() {
        var S = tb7State(); S.open = tb7Idb(S, function() { return 'open'; });
        var h = await realDashboardSave(S);
        await tb7Import(h, S, tb7Rows());
        assert.deepStrictEqual(S.snacks, [['error', 'Failed to import (0 of 3 saved): IDB unavailable']]);
        assert.deepStrictEqual(Object.keys(S.dw), [], 'no widget is left in memory');
        assert.strictEqual(S.refreshes, 1, 'the dashboards still refresh');
    }, { tags: ['unit'], timeout: 2000 });

    test('a partial failure reports the rows really saved; a healthy import still succeeds', async function() {
        var S = tb7State(); S.open = tb7Idb(S, function(k) { return k === 2 ? 'tx' : null; });
        var h = await realDashboardSave(S);
        await tb7Import(h, S, tb7Rows());
        assert.deepStrictEqual(S.snacks, [['error', 'Failed to import (1 of 3 saved): the database connection is closing']]);
        assert.deepStrictEqual(Object.keys(S.dw), ['w1'], 'memory holds only the saved row');
        assert.deepStrictEqual(Object.keys(S.idb), ['w1']);
        var S2 = tb7State(); S2.open = tb7Idb(S2);
        var h2 = await realDashboardSave(S2);
        await tb7Import(h2, S2, tb7Rows());
        assert.deepStrictEqual(S2.snacks, [['success', 'Imported 3 widget(s)']]);
        assert.deepStrictEqual(Object.keys(S2.idb).sort(), ['w1', 'w2', 'w3']);
        assert.deepStrictEqual(Object.keys(S2.dw).sort(), ['w1', 'w2', 'w3']);
    }, { tags: ['unit'], timeout: 2000 });

    test('a fire-and-forget save that fails leaves no unhandled rejection', async function() {
        var seen = [];
        function onRejection(ev) {
            var msg = ev && ev.reason && ev.reason.message;
            if (msg === 'TB7 control' || msg === 'IDB unavailable') { seen.push(msg); ev.preventDefault(); }
        }
        window.addEventListener('unhandledrejection', onRejection);
        try {
            Promise.reject(new Error('TB7 control')); // positive control: this one IS unhandled
            var S = tb7State(); S.open = tb7Idb(S, function() { return 'open'; });
            var h = await realDashboardSave(S);
            h.save({ id: 'w_ff', title: 'F' }); // not awaited, like ui/070:235/346/523
            await new Promise(function(r) { setTimeout(r, 50); });
            if (seen.indexOf('TB7 control') < 0) skipTest('this sandbox delivers no unhandledrejection events');
            assert.deepStrictEqual(seen, ['TB7 control'], 'only the control is unhandled');
            assert.strictEqual(Object.prototype.hasOwnProperty.call(S.dw, 'w_ff'), false, 'the failed widget is not left in memory');
        } finally { window.removeEventListener('unhandledrejection', onRejection); }
    }, { tags: ['unit'], timeout: 5000 });
});
