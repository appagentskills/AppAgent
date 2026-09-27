// S0C6-04 / S0C6-02: deep get_visible_text selectors built by the real content script
// (getUniqueSelectorInfo) must parse, resolve (shadow/iframe-piercing, like get_properties)
// to exactly their own element, and be flagged selectorUnique:false when no such selector exists.
// Fixture adapted from test/content-script-dispatch.test.js (detached DOMParser document).
async function selectorFixture(html, extraGlobals) {
    var doc = new DOMParser().parseFromString('<html><head></head><body>' + (html || '') + '</body></html>', 'text/html');
    var listeners = [];
    var w = {
        location: { href: 'https://fixture.invalid' }, history: {}, innerWidth: 800, innerHeight: 600,
        addEventListener: function() {},
        getComputedStyle: function() { return { display: 'block', visibility: 'visible', opacity: '1', getPropertyValue: function() { return ''; } }; }
    };
    w.HTMLInputElement = HTMLInputElement; w.HTMLTextAreaElement = HTMLTextAreaElement;
    var globals = {
        window: w, document: doc, Event: Event, KeyboardEvent: KeyboardEvent, CSS: CSS,
        chrome: { runtime: { onMessage: { addListener: function(fn) { listeners.push(fn); } } } },
        MouseEvent: function(type, opts) { return new MouseEvent(type, Object.assign({}, opts, { view: null })); }
    };
    if (extraGlobals) Object.assign(globals, extraGlobals);   // S0C6-05: e.g. a fake Date
    var m = await loadModules(['src/platform/extension/content-script.js'], { globals: globals });
    return {
        doc: doc, m: m,
        action: function(action, args) {
            var replies = [];
            listeners[0]({ type: 'browser-action', action: action, args: args || {} }, {}, function(r) { replies.push(r); });
            return replies[0];
        }
    };
}
// Inert documents report 0x0 rects and the walker skips those: give every element (also inside
// open shadow roots) a 10x10 box.
function boxAll(root) {
    var box = function() { return { x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }; };
    Array.prototype.forEach.call(root.querySelectorAll('*'), function(e) {
        e.getBoundingClientRect = box;
        if (e.shadowRoot) boxAll(e.shadowRoot);
    });
}
function deepEntries(f) {
    boxAll(f.doc);
    var r = f.action('get_visible_text', { deep: true });
    assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 200));
    return r.visibleElements;
}
// The selector parses, light-resolves to exactly el, and get_properties (deep count) sees 1 match.
function assertResolves(f, entry, el) {
    var sel = entry.selector, found = null, err = '';
    try { found = f.doc.querySelectorAll(sel); } catch (e) { err = e.message; }
    assert.ok(found, 'unparseable selector ' + sel + ' ' + err);
    assert.strictEqual(found.length, 1, 'light matches for ' + sel);
    assert.strictEqual(found[0], el, 'resolves to its own element: ' + sel);
    assert.strictEqual(f.action('get_properties', { selector: sel }).match_count, 1, 'get_properties match_count for ' + sel);
}
function dupRow(t) { return '<li><div class="row"><div class="cell"><span class="wrap"><button class="btn">' + t + '</button></span></div></div></li>'; }

describe('content script deep selectors (S0C6-04, S0C6-02)', function() {
    test('S0C6-04: classes, attribute values and raw tags are escaped', async function() {
        var f = await selectorFixture('<div id="top"><a class="md:flex" href="#">L</a></div><button aria-label="C:\\temp">T</button><p><o:p>w</o:p></p>');
        var btn = f.doc.querySelector('button');
        assert.strictEqual(btn.getAttribute('aria-label'), 'C:\\temp');
        var entries = deepEntries(f);
        var byTag = function(t) { return entries.filter(function(e) { return e.tag === t; }); };
        [['a', f.doc.querySelector('a')], ['button', btn], ['o:p', f.doc.querySelector('p').firstElementChild]].forEach(function(p) {
            var hits = byTag(p[0]);
            assert.strictEqual(hits.length, 1, 'one entry for ' + p[0]);
            assertResolves(f, hits[0], p[1]);
        });
        assert.match(byTag('button')[0].selector, /^button\[aria-label=/);
    }, { tags: ['unit'] });

    test('S0C6-02: duplicate structures and duplicate ids resolve only to their own element', async function() {
        var f = await selectorFixture('<ul>' + dupRow('A') + dupRow('B') + '</ul><input id="email" value="a"><input id="email" value="b">');
        var btns = f.doc.querySelectorAll('button.btn'), inputs = f.doc.querySelectorAll('input');
        var want = { A: btns[0], B: btns[1], a: inputs[0], b: inputs[1] };
        var entries = deepEntries(f);
        assert.deepStrictEqual(entries.map(function(e) { return e.text; }).sort(), ['A', 'B', 'a', 'b']);
        entries.forEach(function(e) {
            assertResolves(f, e, want[e.text]);
            assert.strictEqual('selectorUnique' in e, false, 'unique selector is not flagged: ' + e.selector);
        });
    }, { tags: ['unit'] });

    test('S0C6-02: shadow nodes no selector can single out are flagged selectorUnique:false', async function() {
        var f = await selectorFixture('<p id="lp">Light</p><div id="h1"></div><div id="h2"></div>');
        ['h1', 'h2'].forEach(function(id) { f.doc.getElementById(id).attachShadow({ mode: 'open' }).innerHTML = '<button>Go</button>'; });
        var entries = deepEntries(f);
        var go = entries.filter(function(e) { return e.text === 'Go'; }), light = entries.filter(function(e) { return e.text === 'Light'; });
        assert.strictEqual(go.length, 2);
        go.forEach(function(e) { assert.strictEqual(e.selectorUnique, false, 'flagged: ' + e.selector); });
        assert.strictEqual(light.length, 1);
        assert.strictEqual(light[0].selector, '#lp');
        assert.strictEqual('selectorUnique' in light[0], false);
    }, { tags: ['unit'] });

    test('S0C6-03: shadow/iframe twins of a light id are not reported unique', async function() {
        var f = await selectorFixture('<input id="q" value="light"><div id="host"></div><iframe id="fr"></iframe>');
        f.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input id="q" value="shadow">';
        var inner = new DOMParser().parseFromString('<html><body><input id="q" value="framed"></body></html>', 'text/html');
        Object.defineProperty(f.doc.getElementById('fr'), 'contentDocument', { value: inner });
        boxAll(inner);
        var entries = deepEntries(f);
        ['shadow', 'framed'].forEach(function(t) {
            var hits = entries.filter(function(e) { return e.text === t; });
            assert.strictEqual(hits.length, 1, 'one entry for ' + t);
            var n = f.action('get_properties', { selector: hits[0].selector }).match_count;
            assert.ok(hits[0].selectorUnique === false || n === 1, t + ': ' + hits[0].selector + ' matches ' + n + ' but is not flagged');
        });
    }, { tags: ['unit'] });

    test('S0C6-03: the selector of a shadow Delete button never clicks a Save button', async function() {
        var f = await selectorFixture('<div id="h1"></div><div id="h2"></div>');
        var saves = [];
        ['h1', 'h2'].forEach(function(id) {
            var sh = f.doc.getElementById(id).attachShadow({ mode: 'open' });
            sh.innerHTML = '<button>Save</button><button>Delete</button>';
            sh.querySelector('button').addEventListener('click', function() { saves.push(id); });
        });
        var del = deepEntries(f).filter(function(e) { return e.text === 'Delete'; });
        assert.strictEqual(del.length, 2);
        del.forEach(function(e) {
            var r = f.action('click', { selector: e.selector });
            assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 200));
            assert.strictEqual(r.element.text, 'Delete', 'clicked via ' + e.selector);
        });
        assert.deepStrictEqual(saves, []);
    }, { tags: ['unit'] });
});

// S0C6-05: count querySelectorAll calls (all, and the '*' host sweeps) on documents, elements and
// shadow roots (DocumentFragment); the prototypes are restored afterwards.
function countQsa(fn) {
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
    try { c.result = fn(); } finally { protos.forEach(function(p, i) { Object.defineProperty(p, 'querySelectorAll', saved[i]); }); }
    return c;
}
function countedDeepScan(f) {
    boxAll(f.doc);
    var c = countQsa(function() { return f.action('get_visible_text', { deep: true }); });
    assert.strictEqual(c.result.success, true, JSON.stringify(c.result).slice(0, 200));
    return c;
}

describe('content script deep get_visible_text cost bounds (S0C6-05)', function() {
    test('S0C6-05: the scan stops at 1000 entries and sweeps shadow hosts once', async function() {
        var f = await selectorFixture(new Array(3001).join('<p>t</p>'));
        var c = countedDeepScan(f);
        assert.strictEqual(c.result.visibleElements.length, 1000);
        assert.ok(c.star <= 1, "'*' sweeps: " + c.star);
        assert.ok(c.total <= 2000, 'querySelectorAll calls: ' + c.total);
    }, { tags: ['unit'] });

    test('S0C6-05: shadow duplicates share a per-scan memo instead of re-sweeping every root', async function() {
        var f = await selectorFixture(new Array(301).join('<div class="host"></div>'));
        Array.prototype.forEach.call(f.doc.querySelectorAll('.host'), function(h) {
            h.attachShadow({ mode: 'open' }).innerHTML = '<div class="card"><button>Go</button></div>';
        });
        var c = countedDeepScan(f);
        var go = c.result.visibleElements.filter(function(e) { return e.text === 'Go'; });
        assert.strictEqual(go.length, 300);
        assert.strictEqual(go.filter(function(e) { return e.selectorUnique === false; }).length, 300);
        assert.ok(c.total <= 1000, 'querySelectorAll calls: ' + c.total);
    }, { tags: ['unit'] });

    test('S0C6-05: past the 2 s budget selectors are null and the result is flagged truncated', async function() {
        var n = 0, fakeDate = { now: function() { return 1500 * n++; } };   // 0, 1500, 3000, ...
        var f = await selectorFixture('<p>a</p><p>b</p><p>c</p>', { Date: fakeDate });
        boxAll(f.doc);
        var r = f.action('get_visible_text', { deep: true });
        assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 200));
        assert.strictEqual(r.visibleElements.length, 3);
        assert.strictEqual(typeof r.visibleElements[0].selector, 'string');
        assert.strictEqual(r.visibleElements[1].selector, null);
        assert.strictEqual(r.visibleElements[2].selector, null);
        assert.strictEqual(r.truncated, true);
        var g = await selectorFixture('<p>a</p><p>b</p>');
        boxAll(g.doc);
        var ok = g.action('get_visible_text', { deep: true });
        assert.strictEqual('truncated' in ok, false);
        assert.deepStrictEqual(ok.visibleElements.map(function(e) { return typeof e.selector; }), ['string', 'string']);
    }, { tags: ['unit'] });
});
