// Picker popup height is capped to the room under the header (clipping fix).
describe('composer picker fits under the header', function() {
    // getComputedStyle is stubbed per test; restore it so other test files
    // sharing this sandbox keep the real one.
    var savedGcs;
    beforeEach(function() { savedGcs = globalThis.getComputedStyle; });
    afterEach(function() { globalThis.getComputedStyle = savedGcs; });
    function rect(top, bottom) { return function() { return { top: top, bottom: bottom }; }; }
    async function load() {
        return await loadModules(['src/js/ui/246-composer.js', 'src/js/ui/247-composer-picker.js'], { lenient: true, globals: {} });
    }
    function setup(hostTop, hdrBottom, clipTop) {
        var hdr = { offsetParent: {}, getBoundingClientRect: rect(0, hdrBottom) };
        var main = { getBoundingClientRect: rect(clipTop, 0), querySelector: function(s) { return s === '.main-header' ? hdr : null; } };
        var area = { parentElement: main, getBoundingClientRect: rect(hostTop - 10, 0) };
        main.parentElement = null;
        var host = { parentElement: area, getBoundingClientRect: rect(hostTop, 0), closest: function(s) { return s === '.main' ? main : null; } };
        var el = { parentElement: host, style: {} };
        globalThis.getComputedStyle = function(a) { return a === main ? { overflow: 'hidden', overflowY: 'hidden' } : { overflow: 'visible', overflowY: 'visible' }; };
        return el;
    }
    test('short window: max-height = composer top - header bottom - gap', async function() {
        var m = await load();
        var el = setup(200, 60, 0);
        m._composerPickerFit(el);
        assert.strictEqual(el.style.maxHeight, '124px');
    }, { tags: ['unit'], timeout: 3000 });
    test('tall window: keeps the 260px cap', async function() {
        var m = await load();
        var el = setup(900, 60, 0);
        m._composerPickerFit(el);
        assert.strictEqual(el.style.maxHeight, '260px');
    }, { tags: ['unit'], timeout: 3000 });
    test('tiny room: never below the minimum', async function() {
        var m = await load();
        var el = setup(70, 60, 0);
        m._composerPickerFit(el);
        assert.strictEqual(el.style.maxHeight, '64px');
    }, { tags: ['unit'], timeout: 3000 });
});
