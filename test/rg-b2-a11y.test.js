// RG-B2 part 2 (R3b-a, R3b-b, R3b-c): chat-row accessibility + the modal Enter guard.
//   R3b-a  both chat-row variants (search + normal) rendered by the REAL renderChatItem
//          (src/js/ui/180-search.js) carry aria-label = escapeAttr(title).
//   R3b-a fixup (RG-F8): a title with '=' (e.g. ending in " onclick=") must not let the REAL
//          CSP polyfill rewrite (src/platform/extension/csp-polyfill.js) match inside the
//          aria-label: the row keeps selectChat on data-_ev-click, has no raw on* attribute
//          and its aria-label is the exact title.
//   R3b-b  Enter/Space on a row -> selectChat() rebuilds #chat-list -> the REAL
//          chatItemKeydown refocuses the NEW row for that chat (found by data-chat-id)
//          instead of leaving focus on BODY, and never steals focus moved elsewhere.
//   R3b-c  the REAL anonymous Enter listener that src/js/ui/230-modals.js registers at
//          load ignores an Enter that a focused control already handled (defaultPrevented).
// Sandbox focus() does not move activeElement, so rows are fakes built from the REAL
// row markup whose focus() records the element (as in test/rg-b2-esc.test.js).
// Run: run_tests { files: ['test/rg-b2-a11y.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests

function fakeDoc(extra) {
    var d = {
        listeners: [],
        body: { tag: 'BODY', appendChild: function() {}, classList: { add: function() {}, remove: function() {} } },
        addEventListener: function(t, f) { d.listeners.push([t, f]); },
        removeEventListener: function() {},
        querySelector: function() { return null; },
        querySelectorAll: function() { return []; },
        getElementById: function() { return null; },
        createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }
    };
    d.activeElement = d.body;
    return Object.assign(d, extra || {});
}
async function loadSearch(query, doc) {
    var m = await loadModules(['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js'],
        { workspace: WS, lenient: true, globals: { window: fakeWindow({ document: doc }), chrome: fakeChrome(), document: doc } });
    m.__scope.currentView = 'chat';
    m.__scope.currentChatId = 'c1';
    m.__scope.chatSearchQuery = query;
    m.__scope.chatHasPendingApproval = function() { return false; };
    m.__scope.chatHasPendingItems = function() { return false; };
    return m;
}
function rowTag(html) {
    var tag = html.match(/^<div class="chat-item[^>]*>/);
    assert.ok(tag, 'row wrapper: ' + html.slice(0, 160));
    return tag[0];
}
function attr(tag, name) {
    var v = tag.match(new RegExp('\\s' + name + '="([^"]*)"'));
    return v ? v[1] : null;
}
// A fake #chat-list whose rows are rebuilt from the REAL renderChatItem markup on every
// render, the way renderChatList's innerHTML swap replaces them (a focused row that is
// removed hands focus to BODY, as in the browser).
function listEnv(m, doc, chats) {
    var env = { rows: [], focused: [] };
    function build(c) {
        var tag = rowTag(m.renderChatItem(c));
        var el = { chatId: c.id, dataId: attr(tag, 'data-chat-id') };
        el.getAttribute = function(n) { return n === 'data-chat-id' ? el.dataId : null; };
        el.focus = function() { env.focused.push(el); doc.activeElement = el; };
        return el;
    }
    env.render = function() {
        var lost = env.rows.indexOf(doc.activeElement) !== -1;
        env.rows = chats.map(build);
        if (lost) doc.activeElement = doc.body;
    };
    var list = {
        querySelectorAll: function(sel) {
            assert.strictEqual(sel, '.chat-item[data-chat-id]');
            return env.rows.filter(function(r) { return r.dataId !== null; });
        }
    };
    doc.getElementById = function(id) { return id === 'chat-list' ? list : null; };
    env.render();
    return env;
}
function key(k, target) {
    var ev = { key: k, target: target, isComposing: false, defaultPrevented: false, prevented: 0 };
    ev.preventDefault = function() { ev.prevented++; ev.defaultPrevented = true; };
    return ev;
}

describe('R3b-a: chat rows have an accessible name (ui/180-search.js)', function() {
    test('R3b-a: search and normal rows carry aria-label = escapeAttr(title)', async function() {
        var title = 'Q7 "plan" <b>&\nnext';
        var s = await loadSearch('q7', fakeDoc());
        var n = await loadSearch('', fakeDoc());
        var want = n.escapeAttr(title);
        assert.strictEqual(/["<>\n]/.test(want), false, 'attribute-safe: ' + want);
        var rows = [rowTag(s.renderChatItem({ id: 'c1', title: title, messages: [] })),
            rowTag(n.renderChatItem({ id: 'c1', title: title, messages: [] })),
            rowTag(n.renderChatItem({ id: 'c9', title: title, messages: [] }))];
        assert.match(rows[0], / searching"/);
        rows.forEach(function(tag) {
            assert.strictEqual(attr(tag, 'aria-label'), want, tag);
            assert.strictEqual(attr(tag, 'role'), 'button', tag);
        });
        var plain = rowTag(n.renderChatItem({ id: 'c2', title: 'Budget review', messages: [] }));
        assert.strictEqual(attr(plain, 'aria-label'), 'Budget review');
    }, { tags: ['unit'], timeout: 3000 });
});

// The REAL CSP polyfill IIFE installed on a private Element facade (as in
// test/csp-polyfill-behavior.test.js). The facade's own innerHTML setter stands in for the
// native one, so it records the markup the polyfill forwards after its inline-handler rewrite.
async function cspRewrite() {
    var seen = [];
    function El() {}
    Object.defineProperties(El.prototype, {
        innerHTML: { configurable: true, get: function() { return ''; }, set: function(v) { seen.push(String(v)); } },
        outerHTML: { configurable: true, get: function() { return ''; }, set: function() {} }
    });
    El.prototype.insertAdjacentHTML = function() {};
    El.prototype.setAttribute = function() {};
    El.prototype.querySelectorAll = function() { return []; };
    await loadModules(['src/platform/extension/csp-polyfill.js'], { workspace: WS, globals: { Element: El } });
    return function(html) {
        var n = seen.length;
        new El().innerHTML = html;
        assert.strictEqual(seen.length, n + 1, 'the polyfill forwarded the markup to the native setter once');
        return seen[n];
    };
}

describe('R3b-a fixup: a title with "=" cannot forge an inline handler through the CSP rewrite (ui/180-search.js)', function() {
    test('R3b-a fixup: non-active search and normal rows keep selectChat on data-_ev-click, no raw on*, aria-label = title', async function() {
        var rewrite = await cspRewrite();
        var title = 'ZZTEST-RG budget onclick=';
        var queries = ['', 'budget'];
        for (var i = 0; i < queries.length; i++) {
            var where = 'query ' + JSON.stringify(queries[i]) + ': ';
            var m = await loadSearch(queries[i], fakeDoc());
            var html = m.renderChatItem({ id: 'c9', title: title, messages: [] }); // currentChatId is c1: non-active row
            rowTag(html);
            var row = new DOMParser().parseFromString(rewrite(html), 'text/html').body.firstElementChild;
            assert.ok(row && row.classList.contains('chat-item'), where + 'the row is the first element');
            assert.strictEqual(row.getAttribute('data-_ev-click'), "selectChat('c9')", where + 'the row click survives the rewrite');
            assert.strictEqual(row.hasAttribute('onclick'), false, where + 'no raw onclick is left on the row');
            var inline = [row].concat(Array.from(row.querySelectorAll('*'))).reduce(function(acc, el) {
                Array.from(el.attributes).forEach(function(a) { if (/^on/i.test(a.name)) acc.push(el.tagName.toLowerCase() + '[' + a.name + ']'); });
                return acc;
            }, []);
            assert.deepStrictEqual(inline, [], where + 'no inline on* attribute anywhere in the row');
            assert.strictEqual(row.getAttribute('aria-label'), title, where + 'the accessible name is the exact title');
            assert.strictEqual(row.getAttribute('data-_ev-keydown'), "chatItemKeydown(event,this,'c9')", where + 'the row keydown is intact');
        }
    }, { tags: ['unit'], timeout: 3000 });
});

describe('R3b-b: Enter keeps focus on the chat row across the re-render (ui/180-search.js)', function() {
    test('R3b-b: Enter -> selectChat re-render -> focus is on the NEW row for that chat', async function() {
        var doc = fakeDoc();
        var m = await loadSearch('', doc);
        var env = listEnv(m, doc, [{ id: 'c1', title: 'One', messages: [] }, { id: 'c2', title: 'Two', messages: [] }]);
        assert.deepStrictEqual(env.rows.map(function(r) { return r.dataId; }), ['c1', 'c2'], 'rows carry data-chat-id');
        var selected = [];
        m.__scope.selectChat = function(id) { selected.push(id); m.__scope.currentChatId = id; env.render(); };
        var old = env.rows[1];
        old.focus();
        env.focused = [];
        var ev = key('Enter', old);
        m.chatItemKeydown(ev, old, 'c2');
        assert.deepStrictEqual(selected, ['c2']);
        assert.strictEqual(ev.prevented, 1);
        assert.ok(env.rows[1] !== old, 'the list was re-rendered');
        assert.ok(doc.activeElement !== doc.body, 'focus did not fall to BODY');
        assert.strictEqual(doc.activeElement, env.rows[1], 'focus is on the re-rendered row');
        assert.strictEqual(env.rows[1].chatId, 'c2');
        assert.strictEqual(env.focused.length, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('R3b-b: Space too; focus that selectChat moved elsewhere is not stolen', async function() {
        var doc = fakeDoc();
        var m = await loadSearch('', doc);
        var env = listEnv(m, doc, [{ id: 'c1', title: 'One', messages: [] }, { id: 'c2', title: 'Two', messages: [] }]);
        var composer = { tagName: 'TEXTAREA' }, moveFocus = false;
        m.__scope.selectChat = function() { env.render(); if (moveFocus) doc.activeElement = composer; };
        var r = env.rows[0];
        r.focus();
        m.chatItemKeydown(key(' ', r), r, 'c1');
        assert.ok(env.rows[0] !== r, 'the list was re-rendered');
        assert.strictEqual(doc.activeElement, env.rows[0], 'Space refocuses the re-rendered row');
        moveFocus = true;
        r = env.rows[1];
        r.focus();
        env.focused = [];
        m.chatItemKeydown(key('Enter', r), r, 'c2');
        assert.strictEqual(doc.activeElement, composer, 'focus moved by selectChat is kept');
        assert.strictEqual(env.focused.length, 0);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('R3b-c: the modal Enter listener respects defaultPrevented (ui/230-modals.js)', function() {
    async function loadModalKeys() {
        var clicks = { n: 0 };
        var overlay = { classList: { contains: function(c) { return c === 'show'; } }, contains: function() { return false; } };
        var primary = { click: function() { clicks.n++; } };
        var doc = fakeDoc({
            getElementById: function(id) { return id === 'modal-overlay' ? overlay : null; },
            querySelector: function(sel) { return sel.indexOf('#modal-actions .modal-btn.primary') !== -1 ? primary : null; }
        });
        await loadModules(['src/js/ui/230-modals.js'], { workspace: WS, globals: { document: doc, modalResolve: function() {} } });
        var keydowns = doc.listeners.filter(function(l) { return l[0] === 'keydown'; });
        assert.strictEqual(keydowns.length, 1, 'one keydown listener registered at load');
        return { fire: keydowns[0][1], clicks: clicks };
    }

    test('R3b-c: a prevented Enter does not click the primary; an unhandled one still does', async function() {
        var t = await loadModalKeys();
        var handled = key('Enter', { tagName: 'INPUT' });
        handled.defaultPrevented = true;
        t.fire(handled);
        assert.strictEqual(t.clicks.n, 0, 'a prevented Enter does not click primary');
        assert.strictEqual(handled.prevented, 0);
        var plain = key('Enter', { tagName: 'INPUT' });
        t.fire(plain);
        assert.strictEqual(t.clicks.n, 1, 'an unhandled Enter still submits');
        assert.strictEqual(plain.prevented, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('R3b-c: an Enter the REAL chatItemKeydown handled does not also confirm an open modal', async function() {
        var t = await loadModalKeys();
        var s = await loadSearch('', fakeDoc());
        var selected = [];
        s.__scope.selectChat = function(id) { selected.push(id); };
        var row = { tag: 'row' };
        var ev = key('Enter', row);
        s.chatItemKeydown(ev, row, 'c1'); // target phase: the row's inline onkeydown
        t.fire(ev);                       // bubble phase: 230's document listener
        assert.deepStrictEqual(selected, ['c1']);
        assert.strictEqual(ev.defaultPrevented, true);
        assert.strictEqual(t.clicks.n, 0, 'the modal primary is not clicked');
    }, { tags: ['unit'], timeout: 3000 });
});
