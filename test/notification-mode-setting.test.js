// Notifications mode (PR #1276; header pill + dropdown E3): chrome.storage.local.notificationMode
// 'silent' | 'notify' (default) | 'sound'. background.js appagentCreateNotification
// is the central gate; 010-platform-stub.js fallback honors 'silent' and
// chimes for 'sound'; legacy approvalSoundEnabled===true reads as 'sound'
// (never rewritten: no new storage write site). Page: ui/240-layout.js (header pill
// opens #notif-mode-menu, the reused model-menu; Settings row = native select).
// Run: run_tests { files: ['test/notification-mode-setting.test.js'] }
var WS = args.workspace;
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

function between(text, start, end) {
    var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + (a < 0 ? start : end));
    return text.slice(a, b);
}
async function flush(n) { for (var i = 0; i < (n || 10); i++) await Promise.resolve(); }


describe('notification mode: background.js central gate (REAL slice)', function() {
    async function bgEnv(stored) {
        var bg = await loadFile('src/platform/extension/background.js');
        var slice = between(bg, 'var NOTIFICATION_MODES =', 'function _takeNotificationChatId(');
        var e = { creates: [], helperCalls: [], listeners: [], session: [], data: Object.assign({}, stored || {}), removed: [] };
        var chrome = {
            storage: {
                local: {
                    get: function(keys, cb) { var d = {}; [].concat(keys).forEach(function(k) { if (k in e.data) d[k] = e.data[k]; }); cb(d); },
                    set: function(o, cb) { Object.assign(e.data, o); if (cb) cb(); },
                    remove: function(k, cb) { e.removed.push(k); delete e.data[k]; if (cb) cb(); }
                },
                session: { set: function(o) { e.session.push(o); } }
            },
            notifications: { create: function(id, opts) { e.creates.push({ id: id, opts: opts }); } },
            runtime: { onMessage: { addListener: function(fn) { e.listeners.push(fn); } } }
        };
        var helper = function(type, payload, ms) { e.helperCalls.push({ type: type, ms: ms }); return Promise.resolve({ ok: true }); };
        var self = {};
        e.api = new Function('chrome', 'callOffscreenHelper', 'console', 'self', 'var _notifChatIds = {}; function _notifStorageKey(id) { return "notifChat:" + id; }\n' +
            slice + '\nreturn { create: appagentCreateNotification, resolve: resolveNotificationMode, ids: _notifChatIds };')(chrome, helper, { warn: function() {}, log: function() {} }, self);
        await flush();
        e.creates.length = 0; e.helperCalls.length = 0;
        return e;
    }
    test('unset -> notify: notification created, no chime, id returned synchronously', async function() {
        var e = await bgEnv({});
        var id = e.api.create('T', 'M', 'chat1');
        assert.ok(/^appagent-/.test(id));
        await flush();
        assert.strictEqual(e.creates.length, 1);
        assert.strictEqual(e.creates[0].id, id);
        assert.strictEqual(e.helperCalls.length, 0, 'no chime by default');
        assert.strictEqual(e.api.ids[id], 'chat1');
    }, { tags: ['unit'] });
    test('silent -> no chrome.notifications.create, no chat record, no chime', async function() {
        var e = await bgEnv({ notificationMode: 'silent' });
        var id = e.api.create('T', 'M', 'chat1'); await flush();
        assert.strictEqual(e.creates.length, 0);
        assert.strictEqual(e.helperCalls.length, 0);
        assert.strictEqual(e.api.ids[id], undefined);
        assert.strictEqual(e.session.length, 0);
    }, { tags: ['unit'] });
    test('sound -> create + one play-notification-sound chime', async function() {
        var e = await bgEnv({ notificationMode: 'sound' });
        e.api.create('T', 'M', ''); await flush();
        assert.strictEqual(e.creates.length, 1);
        assert.deepStrictEqual(e.helperCalls, [{ type: 'play-notification-sound', ms: 5000 }]);
    }, { tags: ['unit'] });
    test('invalid values fall back to notify; legacy true resolves to sound', async function() {
        var e = await bgEnv({});
        assert.strictEqual(e.api.resolve({ notificationMode: 'loud' }), 'notify');
        assert.strictEqual(e.api.resolve({ approvalSoundEnabled: 'true' }), 'notify');
        assert.strictEqual(e.api.resolve({ approvalSoundEnabled: true }), 'sound');
        assert.strictEqual(e.api.resolve({ approvalSoundEnabled: true, notificationMode: 'silent' }), 'silent');
    }, { tags: ['unit'] });
    test('loading the gate never writes storage (legacy key is read-only)', async function() {
        var e = await bgEnv({ approvalSoundEnabled: true });
        assert.ok(!('notificationMode' in e.data));
        assert.strictEqual(e.removed.length, 0);
        e.api.create('T', 'M', ''); await flush();
        assert.deepStrictEqual(e.helperCalls, [{ type: 'play-notification-sound', ms: 5000 }], 'legacy true chimes');
    }, { tags: ['unit'] });
    test('preview-notification-sound message plays without the setting check', async function() {
        var e = await bgEnv({ notificationMode: 'silent' });
        var resp = [];
        e.listeners[0]({ type: 'preview-notification-sound' }, {}, function(r) { resp.push(r); }); await flush();
        assert.deepStrictEqual(e.helperCalls, [{ type: 'play-notification-sound', ms: 5000 }]);
        assert.deepStrictEqual(resp, [{ ok: true }]);
    }, { tags: ['unit'] });
});

describe('notification mode: platform-stub fallback', function() {
    test('fallback (no SW helper) honors silent; notify creates; sound creates + chimes', async function() {
        var src = await loadFile('src/js/worker/010-platform-stub.js');
        var slice = between(src, 'Platform.sendNotification = function(opts) {', '// HTTP-Referer');
        var cases = [[{ notificationMode: 'silent' }, 0, 0], [{ notificationMode: 'notify' }, 1, 0], [{}, 1, 0],
            [{ notificationMode: 'sound' }, 1, 1], [{ approvalSoundEnabled: true }, 1, 1], [{ approvalSoundEnabled: true, notificationMode: 'silent' }, 0, 0]];
        for (var c of cases) {
            var creates = [], chimes = [], stored = c[0];
            var chrome = { storage: { local: { get: function(k, cb) { cb(stored); } } },
                notifications: { create: function(id) { creates.push(id); } } };
            var helper = function(type) { chimes.push(type); return Promise.resolve({ ok: true }); };
            var Platform = {};
            new Function('chrome', 'Platform', 'self', 'callOffscreenHelper', slice)(chrome, Platform, {}, helper);
            Platform.sendNotification({ title: 'a', message: 'b' });
            assert.strictEqual(creates.length, c[1], 'creates for ' + JSON.stringify(stored));
            assert.deepStrictEqual(chimes, c[2] ? ['play-notification-sound'] : [], 'chime for ' + JSON.stringify(stored));
        }
    }, { tags: ['unit'] });
});


describe('notification mode: header pill + dropdown + Settings select', function() {
    var ICONS = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js'];
    var ANY_UNSTUBBED = { indexOf: function() { return 0; } };
    // The hidden test frame has no window focus, so real .focus() never moves
    // document.activeElement: spy on focus() and mirror it onto activeElement.
    var _focused = null, _origFocus = null;
    beforeEach(function() {
        _focused = null; _origFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function() { _focused = this; };
        Object.defineProperty(document, 'activeElement', { configurable: true, get: function() { return _focused || document.body; } });
    });
    afterEach(function() {
        HTMLElement.prototype.focus = _origFocus;
        delete document.activeElement;
        var m = document.getElementById('notif-mode-menu'); if (m) m.remove();
        U.cleanupAll();
    });

    function fakeChromeStore(initial) {
        var c = { data: Object.assign({}, initial || {}), sets: [], sent: [] };
        c.chrome = {
            storage: { local: {
                get: function(keys, cb) { var d = {}; [].concat(keys).forEach(function(k) { if (k in c.data) d[k] = c.data[k]; }); cb(d); },
                set: function(obj) { c.sets.push(Object.assign({}, obj)); Object.assign(c.data, obj); }
            } },
            runtime: { lastError: undefined, sendMessage: function(m, cb) { c.sent.push(m); if (cb) cb({ ok: true }); } }
        };
        return c;
    }
    async function setup(paths, store, extra) {
        var mq = { matches: false, addEventListener: function() {}, addListener: function() {} };
        var win = fakeWindow({ document: document, _rawCopyStore: {}, isRunning: false, open: U.recorder(), innerWidth: 1200,
            matchMedia: function() { return mq; } });
        var data = {};
        var st = { setItem: function(k, v) { data[k] = String(v); }, getItem: function(k) { return k in data ? data[k] : null; }, removeItem: function(k) { delete data[k]; } };
        var globals = Object.assign({ window: win, appStorage: st, showApiStats: false, renderMessages: U.recorder(),
            appTheme: 'light', sidebarCollapsed: true, historyExpanded: true, chrome: store.chrome }, extra || {});
        var m = await U.loadUi(ICONS.concat(paths), { globals: globals, lenient: true, allowUnstubbed: ANY_UNSTUBBED, window: win });
        var dom = await U.mountDom({ body: true });
        return { m: m, dom: dom };
    }
    function withPermission(store, level) {
        var p = { level: level, listeners: [], calls: 0, tabs: [] };
        store.chrome.notifications = {
            getPermissionLevel: function(cb) { p.calls++; cb(p.level); },
            onPermissionLevelChanged: { addListener: function(fn) { p.listeners.push(fn); } }
        };
        store.chrome.tabs = { create: function(o) { p.tabs.push(o.url); } };
        return p;
    }
    function menu() { return document.getElementById('notif-mode-menu'); }
    function rows() { return Array.prototype.slice.call(menu().querySelectorAll('.model-menu-row')); }
    async function tick() { await new Promise(function(r) { setTimeout(r, 5); }); }
    var IDS = ['header-notif-mode', 'home-header-notif-mode'];

    test('pill sits after the Active chats pill and before the gear (both headers); button, menu popup, no chevron', async function() {
        var s = await setup(['src/js/ui/240-layout.js'], fakeChromeStore({}));
        IDS.forEach(function(id) {
            var pill = s.dom.$('#' + id);
            assert.strictEqual(pill.tagName, 'BUTTON', id + ' is a button');
            assert.ok(pill.classList.contains('notif-mode-pill') && pill.classList.contains('notif-mode-wrap'), id + ' classes');
            var prev = pill.previousElementSibling, next = pill.nextElementSibling;
            assert.ok(prev && prev.classList.contains('jobs-badge-wrapper'), id + ' follows the Active chats pill');
            assert.ok(next && next.classList.contains('settings-btn'), id + ' precedes the gear');
            assert.strictEqual(pill.getAttribute('aria-haspopup'), 'menu');
            assert.strictEqual(pill.getAttribute('aria-expanded'), 'false');
            assert.ok(pill.querySelector('.notif-mode-icon-slot'), id + ' icon');
            assert.ok(!pill.querySelector('.notif-mode-label'), id + ' no visible label (icon only)');
            assert.strictEqual(pill.textContent.trim(), '', id + ' has no visible text');
            assert.ok(pill.getAttribute('aria-label'), id + ' has an aria-label');
            assert.ok(!pill.querySelector('[class*="chevron"], [class*="caret"]'), id + ' has no chevron');
            assert.ok(!pill.querySelector('[role="radio"]'), id + ': old radiogroup gone');
        });
        assert.ok(!s.dom.$('#settings-panel-notif-mode'), 'no gear popover row');
    }, { tags: ['unit'] });

    test('icon, title, aria-label and data-mode follow the state (no label); unset loads notify without writing', async function() {
        var store = fakeChromeStore({});
        var s = await setup(['src/js/ui/240-layout.js'], store);
        s.m.loadNotificationModeSetting();
        assert.strictEqual(store.sets.length, 0, 'loading never writes');
        var cases = [['notify', 'Notify'], ['silent', 'Silent'], ['sound', 'With sound']];
        for (var c of cases) {
            if (c[0] !== 'notify') s.m.setNotificationMode(c[0]);
            IDS.forEach(function(id) {
                var p = s.dom.$('#' + id);
                assert.strictEqual(p.getAttribute('data-mode'), c[0], id + ' data-mode ' + c[0]);
                assert.strictEqual(p.getAttribute('title'), 'Notifications: ' + c[1], id + ' title');
                assert.strictEqual(p.getAttribute('aria-label'), 'Notifications: ' + c[1], id + ' aria-label');
                assert.ok(!p.querySelector('.notif-mode-label') && p.textContent.trim() === '', id + ' no visible label');
                var slot = p.querySelector('.notif-mode-icon-slot');
                assert.strictEqual(slot.getAttribute('data-value'), c[0], id + ' icon slot value');
                assert.ok(slot.querySelector('svg.notif-mode-icon[data-value="' + c[0] + '"]'), id + ' state icon ' + c[0]);
            });
        }
        assert.deepStrictEqual(store.sets.map(function(x) { return x.notificationMode; }), ['silent', 'sound'], 'one store.set per change');
        s.m.setNotificationMode('loud');
        assert.strictEqual(store.sets.length, 2, 'invalid mode ignored');
    }, { tags: ['unit'] });

    test('menu opens on click (model-menu component) and closes on click, outside click and Esc; aria-expanded mirrors', async function() {
        var s = await setup(['src/js/ui/240-layout.js'], fakeChromeStore({}));
        s.m.loadNotificationModeSetting();
        var pill = s.dom.$('#header-notif-mode'), home = s.dom.$('#home-header-notif-mode');
        var info = U.fireInline(pill, 'click', s.m);
        assert.ok(info.stopped, 'click does not bubble to the outside-closer');
        var m = menu();
        assert.ok(m, 'menu opened');
        ['header-menu', 'model-menu', 'notif-mode-menu'].forEach(function(c) { assert.ok(m.classList.contains(c), 'menu class ' + c); });
        assert.strictEqual(m.getAttribute('role'), 'menu');
        assert.strictEqual(pill.getAttribute('aria-expanded'), 'true');
        assert.strictEqual(home.getAttribute('aria-expanded'), 'true');
        // click again toggles closed
        U.fireInline(pill, 'click', s.m);
        assert.ok(!menu(), 'second click closes');
        assert.strictEqual(pill.getAttribute('aria-expanded'), 'false');
        // outside click
        U.fireInline(pill, 'click', s.m);
        await tick();
        menu().firstElementChild.dispatchEvent(new Event('click', { bubbles: true }));
        assert.ok(menu(), 'click inside the menu (not a row handler) keeps it open');
        document.body.dispatchEvent(new Event('click', { bubbles: true }));
        assert.ok(!menu(), 'outside click closes');
        assert.strictEqual(pill.getAttribute('aria-expanded'), 'false');
        // Esc from the pill
        U.fireInline(pill, 'click', s.m);
        var esc = U.fireInline(pill, 'keydown', s.m, { key: 'Escape' });
        assert.ok(!menu(), 'Esc on the pill closes');
        assert.ok(esc.prevented);
        // Esc inside the menu returns focus to the pill
        U.fireInline(pill, 'click', s.m);
        menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        assert.ok(!menu(), 'Esc in the menu closes');
        assert.strictEqual(document.activeElement, pill, 'focus returns to the pill');
        // closeAllHeaderMenus closes it; except 'notif' keeps it
        U.fireInline(pill, 'click', s.m);
        s.m.closeAllHeaderMenus('notif');
        assert.ok(menu(), "closeAllHeaderMenus('notif') keeps it");
        s.m.closeAllHeaderMenus();
        assert.ok(!menu(), 'closeAllHeaderMenus closes it');
        assert.strictEqual(pill.getAttribute('aria-expanded'), 'false');
    }, { tags: ['unit'] });

    test('rows: model-menu-row menuitemradio with check + aria-checked on the current mode; selecting saves and closes', async function() {
        var store = fakeChromeStore({ notificationMode: 'silent' });
        var s = await setup(['src/js/ui/240-layout.js'], store);
        s.m.loadNotificationModeSetting();
        U.fireInline(s.dom.$('#header-notif-mode'), 'click', s.m);
        var r = rows();
        assert.deepStrictEqual(r.map(function(x) { return x.getAttribute('data-value'); }), ['silent', 'notify', 'sound']);
        assert.deepStrictEqual(r.map(function(x) { return x.querySelector('.model-row-title').textContent; }), ['Silent', 'Notify', 'With sound']);
        r.forEach(function(x) {
            assert.strictEqual(x.getAttribute('role'), 'menuitemradio');
            assert.ok(x.querySelector('.model-row-icon svg'), 'row icon');
        });
        assert.deepStrictEqual(r.map(function(x) { return x.getAttribute('aria-checked'); }), ['true', 'false', 'false']);
        assert.deepStrictEqual(r.map(function(x) { return !!x.querySelector('.model-row-check'); }), [true, false, false], 'check only on current');
        assert.ok(r[0].classList.contains('selected'));
        U.fireInline(r[1], 'click', s.m);
        assert.deepStrictEqual(store.sets, [{ notificationMode: 'notify' }], 'single store.set');
        assert.ok(!menu(), 'selecting closes the menu');
        assert.strictEqual(s.dom.$('#header-notif-mode').getAttribute('data-mode'), 'notify');
        U.fireInline(s.dom.$('#home-header-notif-mode'), 'click', s.m);
        assert.deepStrictEqual(rows().map(function(x) { return x.getAttribute('aria-checked'); }), ['false', 'true', 'false'], 'reopened menu shows the new mode');
        assert.ok(rows()[1].querySelector('.model-row-check'));
    }, { tags: ['unit'] });

    test('blocked: Chrome denied + mode not silent -> red pill, alert icon, tooltip, first menu row opens Chrome settings', async function() {
        var store = fakeChromeStore({ notificationMode: 'notify' });
        var perm = withPermission(store, 'denied');
        var s = await setup(['src/js/ui/240-layout.js'], store);
        s.m.loadNotificationModeSetting();
        assert.ok(perm.calls >= 1, 'permission checked at startup');
        var TIP = 'Notifications are blocked by Chrome \u2014 click to see how to enable them';
        IDS.forEach(function(id) {
            var p = s.dom.$('#' + id);
            assert.ok(p.classList.contains('notif-mode-blocked'), id + ' red class');
            assert.strictEqual(p.getAttribute('title'), TIP, id + ' tooltip');
            assert.strictEqual(p.getAttribute('aria-label'), TIP, id + ' aria-label');
            assert.strictEqual(p.querySelector('.notif-mode-icon-slot').getAttribute('data-value'), 'blocked', id + ' alert icon');
        });
        var before = perm.calls;
        U.fireInline(s.dom.$('#header-notif-mode'), 'click', s.m);
        assert.ok(perm.calls > before, 'permission re-checked when the menu opens');
        var r = rows();
        assert.strictEqual(r.length, 4, 'extra explanatory row');
        assert.ok(r[0].classList.contains('notif-mode-blocked-row') && r[0].getAttribute('role') === 'menuitem', 'blocked row first');
        assert.strictEqual(r[0].querySelector('.model-row-title').textContent, 'Blocked by Chrome');
        assert.ok(r[0].querySelector('.model-row-sub'), 'explanation line');
        assert.deepStrictEqual(r.slice(1).map(function(x) { return x.getAttribute('data-value'); }), ['silent', 'notify', 'sound']);
        U.fireInline(r[0], 'click', s.m);
        assert.deepStrictEqual(perm.tabs, ['chrome://settings/content/notifications'], 'opens Chrome notification settings');
        assert.ok(!menu(), 'row click closes the menu');
        assert.strictEqual(store.sets.length, 0, 'no storage write');
        // Keyboard: Enter on the pill focuses the current mode (index shifted by the blocked row); Home + Enter opens settings.
        U.fireInline(s.dom.$('#header-notif-mode'), 'keydown', s.m, { key: 'Enter' });
        assert.strictEqual(document.activeElement.getAttribute('data-value'), 'notify');
        menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
        menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        assert.strictEqual(perm.tabs.length, 2, 'Enter on the blocked row opens settings');
        // onPermissionLevelChanged -> granted clears the state
        assert.ok(perm.listeners.length >= 1, 'listens to onPermissionLevelChanged');
        perm.listeners.forEach(function(fn) { fn('granted'); });
        assert.ok(!s.dom.$('#header-notif-mode').classList.contains('notif-mode-blocked'), 'granted clears the red state');
    }, { tags: ['unit'] });

    test('not blocked when permission is granted, or when the mode is silent', async function() {
        var store = fakeChromeStore({ notificationMode: 'sound' });
        withPermission(store, 'granted');
        var s = await setup(['src/js/ui/240-layout.js'], store);
        s.m.loadNotificationModeSetting();
        var p = s.dom.$('#header-notif-mode');
        assert.ok(!p.classList.contains('notif-mode-blocked'), 'granted: no red class');
        assert.strictEqual(p.getAttribute('title'), 'Notifications: With sound');
        U.fireInline(p, 'click', s.m);
        assert.strictEqual(rows().length, 3, 'granted: no blocked row');
        U.fireInline(p, 'click', s.m);
        U.cleanupAll();

        var store2 = fakeChromeStore({ notificationMode: 'silent' });
        withPermission(store2, 'denied');
        var s2 = await setup(['src/js/ui/240-layout.js'], store2);
        s2.m.loadNotificationModeSetting();
        var p2 = s2.dom.$('#header-notif-mode');
        assert.ok(!p2.classList.contains('notif-mode-blocked'), 'silent: no red class even when denied');
        assert.strictEqual(p2.getAttribute('title'), 'Notifications: Silent');
        assert.strictEqual(p2.querySelector('.notif-mode-icon-slot').getAttribute('data-value'), 'silent');
        U.fireInline(p2, 'click', s2.m);
        assert.strictEqual(rows().length, 3, 'silent: no blocked row');
        U.fireInline(menu().querySelector('[data-value="notify"]'), 'click', s2.m);
        assert.ok(p2.classList.contains('notif-mode-blocked'), 'leaving silent while denied turns the pill red');
    }, { tags: ['unit'] });

    test('preview chime only when switching to sound', async function() {
        var store = fakeChromeStore({});
        var s = await setup(['src/js/ui/240-layout.js'], store);
        s.m.loadNotificationModeSetting();
        function pick(v) { U.fireInline(s.dom.$('#header-notif-mode'), 'click', s.m); U.fireInline(menu().querySelector('[data-value="' + v + '"]'), 'click', s.m); }
        pick('silent');
        assert.strictEqual(store.sent.length, 0, 'no preview for silent');
        pick('sound');
        assert.deepStrictEqual(store.sent, [{ type: 'preview-notification-sound' }]);
        pick('sound');
        assert.strictEqual(store.sent.length, 1, 're-picking sound does not chime again');
        pick('notify');
        assert.strictEqual(store.sent.length, 1, 'no preview for notify');
        assert.strictEqual(store.data.notificationMode, 'notify');
    }, { tags: ['unit'] });

    test('keyboard: pill Enter/Down open on the current mode, Up on the last; menu arrows wrap, Home/End, Enter selects, Tab closes', async function() {
        var store = fakeChromeStore({ notificationMode: 'notify' });
        var s = await setup(['src/js/ui/240-layout.js'], store);
        s.m.loadNotificationModeSetting();
        var pill = s.dom.$('#header-notif-mode');
        function key(k) { menu().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }
        function focused() { return document.activeElement && document.activeElement.getAttribute('data-value'); }
        var ev = U.fireInline(pill, 'keydown', s.m, { key: 'Enter' });
        assert.ok(ev.prevented, 'Enter handled (native click suppressed)');
        assert.ok(menu(), 'Enter opens');
        assert.strictEqual(focused(), 'notify', 'focus on the current mode');
        assert.deepStrictEqual(rows().map(function(x) { return x.getAttribute('tabindex'); }), ['-1', '0', '-1'], 'roving tabindex');
        key('ArrowDown'); assert.strictEqual(focused(), 'sound');
        key('ArrowDown'); assert.strictEqual(focused(), 'silent', 'Down wraps');
        key('ArrowUp'); assert.strictEqual(focused(), 'sound', 'Up wraps');
        key('Home'); assert.strictEqual(focused(), 'silent');
        key('End'); assert.strictEqual(focused(), 'sound');
        key('Enter');
        assert.strictEqual(store.data.notificationMode, 'sound', 'Enter selects');
        assert.ok(!menu(), 'and closes');
        assert.strictEqual(document.activeElement, pill, 'focus back on the pill');
        U.fireInline(pill, 'keydown', s.m, { key: 'ArrowUp' });
        assert.strictEqual(focused(), 'sound', 'Up opens on the last item');
        key('ArrowUp'); key(' ');
        assert.strictEqual(store.data.notificationMode, 'notify', 'Space selects');
        U.fireInline(pill, 'keydown', s.m, { key: 'ArrowDown' });
        assert.strictEqual(focused(), 'notify', 'Down opens on the current mode');
        key('Tab');
        assert.ok(!menu(), 'Tab closes');
        U.fireInline(pill, 'keydown', s.m, { key: ' ' });
        assert.ok(menu(), 'Space opens');
        U.fireInline(pill, 'keydown', s.m, { key: 'Enter' });
        assert.ok(!menu(), 'Enter on the pill while open closes');
    }, { tags: ['unit'] });

    test('Settings page: native select rendered from state, kept in sync both ways', async function() {
        var store = fakeChromeStore({ notificationMode: 'sound' });
        var s = await setup(['src/js/ui/040-tools-settings.js', 'src/js/ui/240-layout.js'], store, {
            CSS: CSS, showSnackbar: U.recorder(), apiProviders: [], llmEndpoints: [], currentProvider: null, DEFAULT_API_PROVIDERS: [],
            getAssumedContextTokens: function() { return 200000; }, getGlobalMaxTokens: function() { return 16000; },
            getGlobalThinkingBudget: function() { return 0; }, hooksEnabled: {}
        });
        s.m.loadNotificationModeSetting();
        var renderErr = null;
        try { s.m.renderSettingsPage(); } catch (e) { renderErr = e; }
        var sel = s.dom.$('#settings-page-content #settings-page-notif-mode');
        assert.ok(sel, 'Settings select rendered' + (renderErr ? ' (render error: ' + renderErr.message + ')' : ''));
        assert.strictEqual(sel.tagName, 'SELECT');
        assert.ok(sel.classList.contains('notif-mode-select'));
        assert.deepStrictEqual(Array.prototype.map.call(sel.options, function(o) { return o.value + ':' + o.textContent; }), ['silent:Silent', 'notify:Notify', 'sound:With sound']);
        assert.strictEqual(sel.value, 'sound', 'rendered from the loaded state');
        sel.value = 'silent';
        U.fireInline(sel, 'change', s.m);
        assert.strictEqual(store.data.notificationMode, 'silent');
        IDS.forEach(function(id) { assert.strictEqual(s.dom.$('#' + id).getAttribute('data-mode'), 'silent', id + ' follows the Settings select'); });
        U.fireInline(s.dom.$('#header-notif-mode'), 'click', s.m);
        U.fireInline(menu().querySelector('[data-value="notify"]'), 'click', s.m);
        assert.strictEqual(sel.value, 'notify', 'Settings select follows the header menu');
        assert.ok(/notif-mode-select/.test(s.m.notificationModeSwitchHtml('x')) && /selected/.test(s.m.notificationModeSwitchHtml('x')), 'html helper marks the selected option');
    }, { tags: ['unit'] });

    test('CSS: flat neighbour tokens, no gradient/violet/hex; label hidden on narrow headers; menu reuses model-menu', async function() {
        var hdr = await loadFile('src/css/04-header.css'), resp = await loadFile('src/css/20-responsive.css');
        var rules = hdr.split('\n').filter(function(l) { return /notif-mode/.test(l); }).join('\n');
        assert.ok(rules.length > 0, 'pill rules present');
        assert.ok(!/gradient/i.test(rules), 'no gradient');
        assert.ok(!/#7c3aed|#a78bfa|violet/i.test(hdr + resp), 'no violet');
        assert.ok(!/#[0-9a-f]{3,8}(?![\w-])/i.test(rules), 'no hardcoded hex');
        var base = (rules.match(/^\.notif-mode-pill \{[^}]*\}/m) || [''])[0];
        assert.ok(/background: var\(--bg-code\)/.test(base) && /border: 1px solid var\(--border\)/.test(base) && /border-radius: var\(--radius-xl\)/.test(base), 'silent = idle model pill tokens, header-pill radius');
        assert.ok(/\.notif-mode-pill\[data-mode="notify"\] \{[^}]*background: var\(--primary-lighter\)[^}]*border-color: var\(--primary-light, var\(--primary-lighter\)\)/.test(rules), 'notify = Active chats tokens');
        assert.ok(/\.notif-mode-pill\[data-mode="sound"\] \{[^}]*background: var\(--success-lighter\)[^}]*border-color: var\(--success-light\)/.test(rules), 'sound = connected model pill tokens');
        assert.ok(/\.notif-mode-pill:focus-visible \{[^}]*outline/.test(rules), 'focus ring');
        assert.ok(/prefers-reduced-motion[^\n]*notif-mode/.test(rules), 'reduced motion honoured');
        assert.ok(!/\.notif-mode-(knob|track|hit|dot)\b/.test(hdr), 'old knob/track CSS removed');
        assert.ok(!/notif-mode-label/.test(hdr + resp), 'no label rules (icon-only pill, no <=480px label rule)');
        assert.ok(/padding: var\(--space-2\) var\(--space-3\)/.test(base), 'compact symmetric padding');
        assert.ok(/\.notif-mode-pill\.notif-mode-blocked \{[^}]*background: var\(--danger-lighter\)[^}]*color: var\(--danger-hover\)[^}]*border-color: var\(--danger-light\)/.test(rules), 'blocked = disconnected model pill danger tokens');
    }, { tags: ['unit'] });
});
