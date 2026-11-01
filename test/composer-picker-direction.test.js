// Picker opens below the composer on the New chat (home) page, above in a chat.
describe('composer picker direction', function() {
    // getComputedStyle / window are injected via loadModules globals (never
    // patched on globalThis); still save/restore globalThis.getComputedStyle so
    // a stray stub can never leak into other test files sharing this sandbox.
    var savedGcs;
    beforeEach(function() { savedGcs = globalThis.getComputedStyle; });
    afterEach(function() { globalThis.getComputedStyle = savedGcs; });
    function rect(top, bottom) { return function() { return { top: top, bottom: bottom }; }; }
    var gcsStub = null;
    async function load(innerHeight) {
        return await loadModules(['src/js/ui/246-composer.js', 'src/js/ui/247-composer-picker.js'], { lenient: true, globals: {
            getComputedStyle: function(a) { return gcsStub ? gcsStub(a) : { overflow: 'visible', overflowY: 'visible' }; },
            window: { innerHeight: innerHeight || 5000 }
        } });
    }
    // host = composer (top/bottom), scroller = overflow-clipping ancestor.
    function setup(cls, hostTop, hostBottom, clipTop, clipBottom) {
        var scroller = { tagName: 'DIV', parentElement: null, getBoundingClientRect: rect(clipTop, clipBottom) };
        var section = { tagName: 'DIV', parentElement: scroller, getBoundingClientRect: rect(hostTop, hostBottom) };
        var host = { parentElement: section, getBoundingClientRect: rect(hostTop, hostBottom), closest: function() { return null; } };
        var el = { parentElement: host, className: cls, style: {} };
        gcsStub = function(a) { return a === scroller ? { overflow: 'auto', overflowY: 'auto' } : { overflow: 'visible', overflowY: 'visible' }; };
        return el;
    }
    test('below: max-height = clip bottom - composer bottom - gap', async function() {
        var m = await load();
        var el = setup('composer-picker composer-picker-below', 100, 200, 0, 400);
        m._composerPickerFit(el);
        assert.strictEqual(el.style.maxHeight, '184px');
    }, { tags: ['unit'], timeout: 3000 });
    test('below: tall room keeps the 260px cap', async function() {
        var m = await load();
        var el = setup('composer-picker composer-picker-below', 100, 200, 0, 2000);
        m._composerPickerFit(el);
        assert.strictEqual(el.style.maxHeight, '260px');
    }, { tags: ['unit'], timeout: 3000 });
    test('below: tiny room never below the minimum', async function() {
        var m = await load();
        var el = setup('composer-picker composer-picker-below', 100, 200, 0, 210);
        m._composerPickerFit(el);
        assert.strictEqual(el.style.maxHeight, '64px');
    }, { tags: ['unit'], timeout: 3000 });
    test('below: viewport bottom wins when nearer than the clip ancestor', async function() {
        var m = await load(300);
        var el = setup('composer-picker composer-picker-below', 100, 200, 0, 2000);
        m._composerPickerFit(el);
        assert.strictEqual(el.style.maxHeight, '84px');
    }, { tags: ['unit'], timeout: 3000 });
    test('above (chat): room measured upward from the composer top', async function() {
        var m = await load();
        var el = setup('composer-picker', 150, 200, 20, 2000);
        m._composerPickerFit(el);
        assert.strictEqual(el.style.maxHeight, '114px');
    }, { tags: ['unit'], timeout: 3000 });
    test('_composerPickerBelow reads the class', async function() {
        var m = await load();
        assert.strictEqual(m._composerPickerBelow({ className: 'composer-picker composer-picker-below' }), true);
        assert.strictEqual(m._composerPickerBelow({ className: 'composer-picker' }), false);
        assert.strictEqual(m._composerPickerBelow(null), false);
    }, { tags: ['unit'], timeout: 3000 });
    test('CSS: below variant anchors to top and outranks the base z-index', async function() {
        var css = await loadFile('src/css/06-input.css');
        assert.ok(/\.composer-picker\.composer-picker-below\s*\{[^}]*top:\s*calc\(100% \+ var\(--space-2\)\);[^}]*bottom:\s*auto;[^}]*z-index:\s*50;/.test(css));
        assert.ok(/\.composer-picker\s*\{[^}]*bottom:\s*calc\(100% \+ var\(--space-2\)\)/.test(css));
    }, { tags: ['unit'], timeout: 3000 });
    test('render: home kind gets the below class, chat does not', async function() {
        var src = await loadFile('src/js/ui/247-composer-picker.js');
        assert.ok(src.indexOf("el.className = 'composer-picker' + (p.kind === 'home' ? ' composer-picker-below' : '');") !== -1);
    }, { tags: ['unit'], timeout: 3000 });
});
