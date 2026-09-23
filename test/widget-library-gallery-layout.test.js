// Widget Library gallery layout regression (real CSS + real buildWidgetLibraryItem markup).
// Bug: with many widgets every gallery card collapsed to ~43px (thin thumb strip,
// caption clipped away). Root cause: the list is a flex:1 child with a DEFINITE
// height and the overflow:hidden cards have a 0 automatic min-height, so `auto`
// grid rows were squeezed into the viewport instead of overflowing + scrolling.
// Fix: .widget-library-items.layout-gallery { grid-auto-rows: max-content }.
// The run_tests sandbox renders without layout (offset* are 0), so the computed
// style contract is always asserted; the measured-geometry test runs only when a
// layout engine is available and is skipped (explicitly) otherwise.
// Run: run_tests { files: ['test/widget-library-gallery-layout.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var CSS = ['src/css/00-tokens.css', 'src/css/19b-widget-library.css'];
var ANY_UNSTUBBED = { indexOf: function() { return 0; } };

async function mountGallery(count) {
    var m = await U.loadUi(['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/065-widget-library.js'], {
        lenient: true, allowUnstubbed: ANY_UNSTUBBED,
        globals: { chats: {}, appStorage: { getItem: function() { return null; }, setItem: function() {} } }
    });
    var cards = '';
    for (var i = 0; i < count; i++) {
        cards += m.buildWidgetLibraryItem({ id: 'w' + i, title: 'Widget ' + i, pinned: i % 2 ? 'home' : null, latestVersion: 3, versionCount: 3, createdAt: Date.now() });
    }
    // Mirror the live structure: fixed-height column flex page, #widget-library
    // (flex:1, column, min-height:0) and the flex:1 scrolling items list.
    var html = '<div style="display:flex;flex-direction:column;width:1300px;height:600px;">' +
        '<div class="widget-library" id="widget-library">' +
        '<div class="widget-library-header">header</div>' +
        '<div class="widget-library-items layout-gallery" id="widget-library-items">' + cards + '</div>' +
        '</div></div>';
    return U.mountDom({ css: CSS, html: html });
}

describe('widget library › gallery layout (real CSS)', function() {
    afterEach(function() { U.cleanupAll(); });

    test('gallery rows are max-content (never squeezed to fit the definite-height list)', async function() {
        var dom = await mountGallery(3);
        var list = dom.$('#widget-library-items');
        var ls = getComputedStyle(list);
        assert.strictEqual(ls.display, 'grid');
        assert.strictEqual(ls.gridAutoRows, 'max-content');
        var card = dom.$('.widget-library-item');
        // Card children the gallery relies on: thumb then caption, caption visible.
        assert.ok(card.children[0].classList.contains('widget-library-thumb'));
        assert.ok(card.children[1].classList.contains('widget-library-info'));
        var cs = getComputedStyle(card), ts = getComputedStyle(card.children[0]), is = getComputedStyle(card.children[1]);
        assert.strictEqual(cs.display, 'block');
        assert.strictEqual(ts.display, 'block');
        assert.strictEqual(ts.position, 'relative');
        assert.notStrictEqual(is.display, 'none', 'caption row displayed');
        assert.strictEqual(is.minHeight, '40px');
        assert.strictEqual(getComputedStyle(card.querySelector('.widget-library-actions')).display, 'none');
    }, { tags: ['unit'], timeout: 10000 });

    test('measured: 60 cards keep 16:10 thumb + caption and the list scrolls (needs layout)', async function() {
        var dom = await mountGallery(60);
        var list = dom.$('#widget-library-items');
        if (!list.offsetWidth) { skipTest('run_tests sandbox has no layout engine (offsetWidth 0) — verified live instead'); return; }
        var items = dom.$$('.widget-library-item');
        [items[0], items[items.length - 1]].forEach(function(card) {
            var thumb = card.querySelector('.widget-library-thumb'), info = card.querySelector('.widget-library-info');
            assert.ok(Math.abs(thumb.offsetHeight - thumb.offsetWidth * 0.625) <= 1.5, '16:10 thumb');
            assert.ok(thumb.offsetHeight >= 148, 'thumb >= ~150px');
            assert.ok(card.clientHeight >= thumb.offsetHeight + info.offsetHeight - 1, 'card contains thumb + caption');
        });
        assert.ok(list.scrollHeight > list.clientHeight + 100, 'list scrolls instead of squeezing rows');
    }, { tags: ['unit'], timeout: 10000 });
});
