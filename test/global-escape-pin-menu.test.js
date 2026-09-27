// A3B2-01: the global Escape handler (src/js/core/120-init.js) must close the
// widget pin menu (#widget-pin-menu, ui/070-dashboard-ui.js showWidgetPinMenu)
// FIRST. The menu is the topmost surface (z-index 2147483000,
// css/19-dashboard.css .widget-pin-menu) and only ever had a click-outside
// once-listener, so Escape left it open — and with the widget fullscreen
// overlay open, Escape ran closeWidgetFullscreen() and orphaned the menu.
// The REAL handler is sliced from the source (same idiom as
// test/pr938-genuine-fixes.test.js loadRenderWidgetLibrary) and evaluated with
// a fake document; only DOM effects and the close functions are stubbed.
describe('A3B2-01 global Escape closes the widget pin menu', function() {
    var FROM = "document.addEventListener('keydown', function(e) {\n        if (e.key !== 'Escape')";
    var TO = '// NAV-H7';
    var CLOSERS = ['closeModal', 'closeWidgetFullscreen', 'closeWidgetCodeEdit', 'closeWidgetModal',
        'closeWidgetHistory', 'closeResultPopover', 'closeDiffViewer', 'closeDropdowns', 'closeAllHeaderMenus'];

    // els: id -> fake element. opts.noPinCloser: closeWidgetPinMenu is not defined.
    async function loadEscapeHandler(els, opts) {
        opts = opts || {};
        var src = await loadFile('src/js/core/120-init.js');
        var a = src.indexOf(FROM), b = src.indexOf(TO, a);
        assert.ok(a >= 0 && b > a, 'global Escape handler anchors present in 120-init.js');
        var body = src.slice(a, b);
        var listeners = {}, calls = [];
        var doc = {
            addEventListener: function(type, fn) { listeners[type] = fn; },
            getElementById: function(id) { return els[id] || null; },
            querySelector: function() { return null; },
            querySelectorAll: function() { return []; }
        };
        var win = { getComputedStyle: function() { return { display: 'none' }; } };
        var fns = CLOSERS.map(function(name) { return function() { calls.push(name); }; });
        var pinCloser = opts.noPinCloser ? undefined : function() {
            calls.push('closeWidgetPinMenu');
            delete els['widget-pin-menu']; // the real closeWidgetPinMenu removes the element
        };
        var install = Function.apply(null, ['document', 'window'].concat(CLOSERS, ['closeWidgetPinMenu', body]));
        install.apply(null, [doc, win].concat(fns, [pinCloser]));
        assert.strictEqual(typeof listeners.keydown, 'function', 'the sliced source registers the keydown handler');
        return { press: function(key) { listeners.keydown({ key: key || 'Escape' }); }, calls: calls };
    }
    function pinMenu() {
        var m = { removed: 0 };
        m.remove = function() { m.removed++; };
        return m;
    }
    function shownModal() {
        return { classList: { contains: function(c) { return c === 'show'; } } };
    }

    test('Escape closes the pin menu before the fullscreen overlay', async function() {
        var els = { 'widget-pin-menu': pinMenu(), 'widget-fullscreen-overlay': {} };
        var h = await loadEscapeHandler(els);
        h.press();
        assert.deepStrictEqual(h.calls, ['closeWidgetPinMenu'], 'only the pin menu closes; closeWidgetFullscreen is not called');
        h.press(); // menu gone -> the next Escape reaches the overlay as before
        assert.deepStrictEqual(h.calls, ['closeWidgetPinMenu', 'closeWidgetFullscreen']);
    }, { tags: ['unit'], timeout: 2000 });

    test('Escape closes the pin menu and does not call closeModal while #modal-overlay is shown', async function() {
        var els = { 'widget-pin-menu': pinMenu(), 'modal-overlay': shownModal() };
        var h = await loadEscapeHandler(els);
        h.press();
        assert.deepStrictEqual(h.calls, ['closeWidgetPinMenu'], 'closeModal is not called while the pin menu is open');
    }, { tags: ['unit'], timeout: 2000 });

    test('without closeWidgetPinMenu the menu element is removed directly', async function() {
        var menu = pinMenu();
        var els = { 'widget-pin-menu': menu, 'widget-fullscreen-overlay': {} };
        var h = await loadEscapeHandler(els, { noPinCloser: true });
        h.press();
        assert.strictEqual(menu.removed, 1, 'fallback removes #widget-pin-menu');
        assert.deepStrictEqual(h.calls, [], 'nothing below the pin menu is closed');
    }, { tags: ['unit'], timeout: 2000 });

    test('no pin menu: the ladder is unchanged, and non-Escape keys are ignored', async function() {
        var els = { 'modal-overlay': shownModal(), 'widget-fullscreen-overlay': {} };
        var h = await loadEscapeHandler(els);
        h.press('Enter');
        assert.deepStrictEqual(h.calls, [], 'non-Escape key is a no-op');
        h.press();
        assert.deepStrictEqual(h.calls, ['closeModal'], 'the generic modal still closes first');
    }, { tags: ['unit'], timeout: 2000 });
});
