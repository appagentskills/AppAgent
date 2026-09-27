// S0C6-04 / S0C6-02: the panel-side getUniqueSelector(Info) in src/js/ui/310-iframe-nav.js (used by
// iframe_tool deep get_visible_text on widgets, src/js/tools/010-iframe-tool.js) must build selectors
// that parse and resolve only to their own element; the widget walker flags the ones that cannot.
function navDoc(html) { return new DOMParser().parseFromString('<html><head></head><body>' + html + '</body></html>', 'text/html'); }
function navBoxAll(root) {
    var box = function() { return { x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }; };
    Array.prototype.forEach.call(root.querySelectorAll('*'), function(e) {
        e.getBoundingClientRect = box;
        if (e.shadowRoot) navBoxAll(e.shadowRoot);
    });
}
function assertOwn(doc, sel, el) {
    var found = null, err = '';
    try { found = doc.querySelectorAll(sel); } catch (e) { err = e.message; }
    assert.ok(found, 'unparseable selector ' + sel + ' ' + err);
    assert.strictEqual(found.length, 1, 'matches for ' + sel);
    assert.strictEqual(found[0], el, 'resolves to its own element: ' + sel);
}
function navRow(t) { return '<li><div class="row"><div class="cell"><span class="wrap"><button class="btn">' + t + '</button></span></div></div></li>'; }

describe('iframe-nav getUniqueSelector (S0C6-04, S0C6-02)', function() {
    test('S0C6-04: classes, attribute values, raw tags and leading-digit ids are escaped', async function() {
        var m = await loadModules(['src/js/ui/310-iframe-nav.js'], { globals: { CSS: CSS } });
        var doc = navDoc('<div id="top"><a class="md:flex" href="#">L</a></div><button aria-label="C:\\temp">T</button><p><o:p>w</o:p></p><section id="1x">S</section>');
        var btn = doc.querySelector('button');
        [doc.querySelector('a'), btn, doc.querySelector('p').firstElementChild, doc.querySelector('section')].forEach(function(el) {
            assertOwn(doc, m.getUniqueSelector(el, doc), el);
        });
        assert.match(m.getUniqueSelector(btn, doc), /^button\[aria-label=/);
    }, { tags: ['unit'] });

    test('S0C6-02: duplicate structures and duplicate ids get unique selectors', async function() {
        var m = await loadModules(['src/js/ui/310-iframe-nav.js'], { globals: { CSS: CSS } });
        var doc = navDoc('<ul>' + navRow('A') + navRow('B') + '</ul><input id="email" value="a"><input id="email" value="b">');
        var els = doc.querySelectorAll('button, input');
        assert.strictEqual(els.length, 4);
        Array.prototype.forEach.call(els, function(el) {
            var info = m.getUniqueSelectorInfo(el, doc);
            assert.strictEqual(info.unique, true, 'unique: ' + info.selector);
            assertOwn(doc, info.selector, el);
        });
    }, { tags: ['unit'] });

    test('S0C6-02: iframe_tool deep get_visible_text flags selectors that match several nodes', async function() {
        var doc = navDoc('<p id="lp">Light</p><div id="h1"></div><div id="h2"></div>');
        ['h1', 'h2'].forEach(function(id) { doc.getElementById(id).attachShadow({ mode: 'open' }).innerHTML = '<button>Go</button>'; });
        navBoxAll(doc);
        var win = { getComputedStyle: function() { return { display: 'block', visibility: 'visible', opacity: '1' }; } };
        var m = await loadModules(['src/js/ui/310-iframe-nav.js', 'src/js/tools/010-iframe-tool.js'], { globals: {
            window: win, DOMParser: DOMParser, CSS: CSS, dashboardWidgets: {}, currentChatId: 'c',
            getWidgetById: function() { return { id: 'w' }; },
            getWidgetIframe: function() { return { contentDocument: doc, contentWindow: win }; }
        } });
        var r = await m._executeIframeToolImpl({ widget_id: 'w', action: 'get_visible_text', deep: true });
        assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 200));
        var go = r.visibleElements.filter(function(e) { return e.text === 'Go'; });
        var light = r.visibleElements.filter(function(e) { return e.text === 'Light'; });
        assert.strictEqual(go.length, 2);
        go.forEach(function(e) { assert.strictEqual(e.selectorUnique, false, 'flagged: ' + e.selector); });
        assert.strictEqual(light.length, 1);
        assert.strictEqual(light[0].selector, '#lp');
        assert.strictEqual('selectorUnique' in light[0], false);
    }, { tags: ['unit'] });

    test('S0C6-03: a shadow twin of a light id is not unique; shadow-root children get a positional part', async function() {
        var m = await loadModules(['src/js/ui/310-iframe-nav.js'], { globals: { CSS: CSS } });
        var doc = navDoc('<input id="q"><div id="h"></div>');
        var sh = doc.getElementById('h').attachShadow({ mode: 'open' });
        sh.innerHTML = '<input id="q"><button>Save</button><button>Delete</button>';
        var info = m.getUniqueSelectorInfo(sh.querySelector('input'), doc);
        assert.strictEqual(info.unique, false, 'shadow #q flagged: ' + info.selector);
        var del = sh.querySelectorAll('button')[1], sel = m.getUniqueSelector(del, doc);
        assert.strictEqual(doc.querySelectorAll(sel).length, 0, 'no light match for ' + sel);
        assertOwn(sh, sel, del);
    }, { tags: ['unit'] });
});

// S0C6-05: count querySelectorAll calls (all, and the '*' host sweeps) on documents, elements and
// shadow roots (DocumentFragment) while fn runs; the prototypes are restored afterwards.
async function navCountQsa(fn) {
    var protos = [Document.prototype, Element.prototype, DocumentFragment.prototype];
    var saved = protos.map(function(p) { return Object.getOwnPropertyDescriptor(p, 'querySelectorAll'); });
    var c = { total: 0, star: 0 };
    protos.forEach(function(p, i) {
        var orig = saved[i].value;
        Object.defineProperty(p, 'querySelectorAll', { configurable: true, writable: true, value: function(sel) {
            c.total++; if (sel === '*') c.star++;
            return orig.call(this, sel);
        } });
    });
    try { c.result = await fn(); } finally { protos.forEach(function(p, i) { Object.defineProperty(p, 'querySelectorAll', saved[i]); }); }
    return c;
}

describe('iframe_tool deep get_visible_text cost bounds (S0C6-05)', function() {
    test('S0C6-05: the widget scan stops at 1000 entries and sweeps shadow hosts once', async function() {
        var doc = navDoc(new Array(3001).join('<p>t</p>'));
        navBoxAll(doc);
        var win = { getComputedStyle: function() { return { display: 'block', visibility: 'visible', opacity: '1' }; } };
        var m = await loadModules(['src/js/ui/310-iframe-nav.js', 'src/js/tools/010-iframe-tool.js'], { globals: {
            window: win, DOMParser: DOMParser, CSS: CSS, dashboardWidgets: {}, currentChatId: 'c',
            getWidgetById: function() { return { id: 'w' }; },
            getWidgetIframe: function() { return { contentDocument: doc, contentWindow: win }; }
        } });
        var c = await navCountQsa(function() { return m._executeIframeToolImpl({ widget_id: 'w', action: 'get_visible_text', deep: true }); });
        assert.strictEqual(c.result.success, true, JSON.stringify(c.result).slice(0, 200));
        assert.strictEqual(c.result.visibleElements.length, 1000);
        assert.strictEqual(typeof c.result.visibleElements[999].selector, 'string');
        assert.strictEqual('truncated' in c.result, false);
        assert.ok(c.star <= 1, "'*' sweeps: " + c.star);
        assert.ok(c.total <= 2000, 'querySelectorAll calls: ' + c.total);
    }, { tags: ['unit'] });
});
