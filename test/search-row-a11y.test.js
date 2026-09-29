// A1-01 / A1-02 (ZZTEST UI sweep): a search-mode chat row must open the chat
// (a title-only match has no snippet to click) and say "(title match)" instead
// of "(0 matches)"; both chat-row variants must be keyboard-operable buttons.
// Real src/js/ui/180-search.js via loadModules (same pattern as
// test/finished-chat-row-bell.test.js); stubs only DOM/chrome + sidebar deps.
function fakeDocument() {
    return { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
}
async function loadSearchRows(query) {
    var doc = fakeDocument();
    var m = await loadModules(['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js'],
        { lenient: true, globals: { window: fakeWindow({ document: doc }), chrome: fakeChrome(), document: doc } });
    var selected = [];
    m.__scope.currentView = 'chat';
    m.__scope.currentChatId = 'c1';
    m.__scope.chatSearchQuery = query;
    m.__scope.selectChat = function(id) { selected.push(id); };
    m.__scope.chatHasPendingApproval = function() { return false; };
    m.__scope.chatHasPendingItems = function() { return false; };
    return { m: m, selected: selected };
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

describe('search-mode chat rows open the chat (A1-01)', function() {
    test('A1-01: a title-only search row opens the chat and says "title match"', async function() {
        var t = await loadSearchRows('qzx7');
        var html = t.m.renderChatItem({ id: 'c1', title: 'QZX7TOKEN', messages: [{ role: 'user', content: 'nothing relevant' }] });
        var tag = rowTag(html);
        assert.match(tag, / searching"/);
        assert.strictEqual(attr(tag, 'onclick'), "selectChat('c1')");
        new Function('selectChat', 'event', attr(tag, 'onclick'))(t.m.__scope.selectChat, {});
        assert.deepStrictEqual(t.selected, ['c1']);
        assert.strictEqual(html.indexOf('(0 matches)'), -1, 'no "(0 matches)"');
        assert.ok(html.indexOf('<span class="match-count">(title match)</span>') !== -1, 'title match label: ' + html.slice(0, 400));
        // Admitted for a hit the counter skips (system message) with an unrelated title: no false label.
        var other = t.m.renderChatItem({ id: 'c2', title: 'Other', messages: [{ role: 'system', content: 'qzx7 here' }] });
        assert.strictEqual(other.indexOf('(title match)'), -1);
        assert.strictEqual(other.indexOf('(0 matches)'), -1);
    }, { tags: ['unit'] });

    test('A1-01: snippet clicks never bubble to the row', async function() {
        var t = await loadSearchRows('qzx7');
        var html = t.m.renderChatItem({ id: 'c1', title: 'Plain', messages: [{ role: 'user', content: 'has qzx7 inside' }] });
        var snip = html.match(/<div class="chat-result-snippet-item"[^>]*? onclick="([^"]*)"/);
        assert.ok(snip, 'snippet rendered: ' + html.slice(0, 200));
        assert.match(snip[1], /^event\.stopPropagation\(\);/);
        assert.ok(html.indexOf('<span class="match-count">(1 match)</span>') !== -1, 'hit count kept');
        assert.strictEqual(attr(rowTag(html), 'onclick'), "selectChat('c1')");
    }, { tags: ['unit'] });
});

describe('chat rows are keyboard-operable (A1-02)', function() {
    test('A1-02: both row variants are focusable buttons with a key handler', async function() {
        var s = await loadSearchRows('qzx7');
        var n = await loadSearchRows('');
        var rows = [rowTag(s.m.renderChatItem({ id: 'c1', title: 'QZX7', messages: [] })),
            rowTag(n.m.renderChatItem({ id: 'c1', title: 'T', messages: [] }))];
        assert.match(rows[0], / searching"/);
        rows.forEach(function(tag) {
            assert.strictEqual(attr(tag, 'role'), 'button', tag);
            assert.strictEqual(attr(tag, 'tabindex'), '0', tag);
            assert.strictEqual(attr(tag, 'onkeydown'), "chatItemKeydown(event,this,'c1')", tag);
            assert.strictEqual(attr(tag, 'onclick'), "selectChat('c1')", tag);
            assert.strictEqual(attr(tag, 'aria-current'), 'true', 'active row is marked current');
        });
        var inactive = rowTag(n.m.renderChatItem({ id: 'c9', title: 'T', messages: [] }));
        assert.strictEqual(attr(inactive, 'aria-current'), null);
        assert.strictEqual(attr(inactive, 'onkeydown'), "chatItemKeydown(event,this,'c9')");
    }, { tags: ['unit'] });

    test('A1-02: chatItemKeydown selects only on Enter/Space from the row', async function() {
        var t = await loadSearchRows('');
        var row = { tag: 'row' }, child = { tag: 'menu-btn' };
        function key(k, target) {
            var ev = { key: k, target: target, prevented: 0 };
            ev.preventDefault = function() { ev.prevented++; };
            return ev;
        }
        var evs = [key('Enter', row), key(' ', row), key('Tab', row), key('Enter', child), key(' ', child), key('a', row)];
        evs.forEach(function(ev) { t.m.chatItemKeydown(ev, row, 'c1'); });
        assert.deepStrictEqual(t.selected, ['c1', 'c1'], 'Enter + Space on the row open the chat');
        assert.deepStrictEqual(evs.map(function(ev) { return ev.prevented; }), [1, 1, 0, 0, 0, 0], 'preventDefault only when handled');
    }, { tags: ['unit'] });
});
