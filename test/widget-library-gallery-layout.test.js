// Widget Library gallery layout regression (real CSS + real buildWidgetLibraryItem markup).
// Bug: with many widgets every gallery card collapsed to ~43px (thin thumb strip,
// caption clipped away). Root cause: the list is a flex:1 child with a DEFINITE
// height and the overflow:hidden cards have a 0 automatic min-height, so `auto`
// grid rows were squeezed into the viewport instead of overflowing + scrolling.
// Fix: .widget-library-items.layout-gallery { grid-auto-rows: max-content }.
// The run_tests sandbox renders without layout (offset* are 0), so geometry is
// asserted through the computed-style contract and the real CSS rules (16:10
// padding-top thumb, scrolling flex:1 list) instead of measured offsets.
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

    test('60 cards: real CSS keeps a 16:10 thumb + caption per card and the list scrolls', async function() {
        var dom = await mountGallery(60);
        var list = dom.$('#widget-library-items');
        var items = dom.$$('.widget-library-item');
        assert.strictEqual(items.length, 60);
        [items[0], items[items.length - 1]].forEach(function(card) {
            assert.ok(card.querySelector('.widget-library-thumb'), 'thumb present');
            assert.ok(card.querySelector('.widget-library-info'), 'caption present');
        });
        assert.strictEqual(getComputedStyle(list).overflowY, 'auto', 'list scrolls instead of clipping');
        // Geometry contract read from the real stylesheet (no layout engine here).
        var css = (await loadFile('src/css/19b-widget-library.css')).replace(/\/\*[\s\S]*?\*\//g, '');
        function rule(sel) {
            var esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var m = new RegExp('(?:^|[}\\n])\\s*' + esc + '\\s*\\{([^}]*)\\}').exec(css);
            assert.ok(m, 'rule not found: ' + sel);
            return m[1].replace(/\s+/g, ' ');
        }
        var thumb = rule('.layout-gallery .widget-library-thumb');
        assert.ok(/width:\s*100%/.test(thumb), 'thumb spans the card width');
        assert.ok(/(?:^|;)\s*height:\s*0\s*;/.test(thumb), 'thumb height comes from padding only');
        assert.ok(/padding-top:\s*62\.5%/.test(thumb), '16:10 thumb (padding-top 62.5% = 10/16)');
        var items_ = rule('.widget-library-items');
        assert.ok(/flex:\s*1/.test(items_) && /overflow-y:\s*auto/.test(items_), 'list is the flex:1 scroll container');
        assert.ok(/grid-auto-rows:\s*max-content/.test(rule('.widget-library-items.layout-gallery')), 'rows never squeezed');
        assert.ok(/min-height:\s*0/.test(rule('.widget-library')), 'library column can shrink so the list scrolls');
    }, { tags: ['unit'], timeout: 10000 });
});
