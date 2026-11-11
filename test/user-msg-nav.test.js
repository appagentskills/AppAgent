// USER-MSG-NAV (ui/250-message-render.js): up/down buttons on user bubbles.
// Real module + real DOM; only scrolling/intent side effects are stubbed.
async function navFixture(windowStart) {
    var doc = document.implementation.createHTMLDocument('user msg nav');
    var scrolls = [], intents = [];
    var m = await loadModules(['src/js/ui/250-message-render.js'], {
        globals: {
            document: doc, window: { isRunning: false },
            chats: {}, currentChatId: 'c', activeStreamingChatId: null,
            _isChatInSilentHook: function() { return false; }, currentEditingWidget: null,
            getDisplayHtmlForMessage: null,
            updateContextIndicator: function() {}, updateInputPosition: function() {},
            updateScrollToBottomButton: function() {},
            escapeHtml: function(s) { return String(s); },
            t: function(s) { return s; },
            UI_ICONS: { arrowUp: '<svg class="ui-icon up"></svg>', arrowDown: '<svg class="ui-icon down"></svg>' },
            _agMarkUserScrollIntent: function() { intents.push(1); }
        }
    });
    if (windowStart) m._msgWindowStart.c = windowStart;
    function bubble(i, extra, attrs) {
        return '<div class="message user' + (extra || '') + '" id="msg-' + i + '"' + (attrs || '') + '><div class="msg-actions">' +
            m._userMsgNavButtonsHtml() + '</div><div class="message-content">u' + i + '</div></div>';
    }
    doc.body.innerHTML = '<div id="messages">' +
        bubble(0) +
        '<div class="message assistant" id="msg-1">a</div>' +
        bubble(2, ' sub-notice-msg') +
        bubble(3, '', ' style="display:none;"') +
        bubble(4) +
        '<div id="msg-5" hidden class="message user"></div>' +
        bubble(6) +
        '</div>';
    var box = doc.getElementById('messages');
    box.scrollTo = function(o) { scrolls.push(o); };
    function btn(i, dir) { return doc.querySelector('#msg-' + i + ' .user-msg-nav-btn[data-nav-dir="' + dir + '"]'); }
    return { m: m, doc: doc, box: box, scrolls: scrolls, intents: intents, btn: btn };
}

describe('user message up/down navigation', function() {
    test('buttons are accessible, keyboard-focusable and use the arrow icons', async function() {
        var f = await navFixture();
        var up = f.btn(0, -1), down = f.btn(0, 1);
        assert.strictEqual(up.tagName, 'BUTTON');
        assert.strictEqual(up.getAttribute('type'), 'button');
        assert.strictEqual(up.getAttribute('aria-label'), 'Previous message');
        assert.strictEqual(up.getAttribute('title'), 'Previous message');
        assert.strictEqual(down.getAttribute('aria-label'), 'Next message');
        assert.ok(up.querySelector('svg.up') && down.querySelector('svg.down'));
        assert.ok(!up.hasAttribute('disabled') && !down.hasAttribute('disabled'), 'never natively disabled (keeps focus)');
    }, { tags: ['unit'], timeout: 3000 });

    test('nav list skips assistant, sub-notice, display:none and hidden rows', async function() {
        var f = await navFixture();
        var ids = f.m._userMsgNavList(f.box).map(function(e) { return e.id; });
        assert.deepStrictEqual(ids, ['msg-0', 'msg-4', 'msg-6']);
    }, { tags: ['unit'], timeout: 3000 });

    test('edge state: Up disabled on first, Down disabled on last, middle both enabled', async function() {
        var f = await navFixture();
        ['0', '4', '6'].forEach(function(i) { f.m.refreshUserMsgNav(f.doc.getElementById('msg-' + i)); });
        assert.strictEqual(f.btn(0, -1).getAttribute('aria-disabled'), 'true');
        assert.strictEqual(f.btn(0, 1).getAttribute('aria-disabled'), null);
        assert.strictEqual(f.btn(4, -1).getAttribute('aria-disabled'), null);
        assert.strictEqual(f.btn(4, 1).getAttribute('aria-disabled'), null);
        assert.strictEqual(f.btn(6, -1).getAttribute('aria-disabled'), null);
        assert.strictEqual(f.btn(6, 1).getAttribute('aria-disabled'), 'true');
    }, { tags: ['unit'], timeout: 3000 });

    test('state follows DOM changes (a new last message re-enables Down)', async function() {
        var f = await navFixture();
        f.m.refreshUserMsgNav(f.doc.getElementById('msg-6'));
        assert.strictEqual(f.btn(6, 1).getAttribute('aria-disabled'), 'true');
        f.box.insertAdjacentHTML('beforeend', '<div class="message user" id="msg-7"><div class="msg-actions">' + f.m._userMsgNavButtonsHtml() + '</div></div>');
        f.m.refreshUserMsgNav(f.btn(6, 1));
        assert.strictEqual(f.btn(6, 1).getAttribute('aria-disabled'), null);
    }, { tags: ['unit'], timeout: 3000 });

    test('Up on first is enabled when earlier turns are windowed out', async function() {
        var f = await navFixture(10);
        f.m.refreshUserMsgNav(f.doc.getElementById('msg-0'));
        assert.strictEqual(f.btn(0, -1).getAttribute('aria-disabled'), null);
    }, { tags: ['unit'], timeout: 3000 });

    test('Down/Up smooth-scroll to the neighbour, flash it and mark user intent', async function() {
        var f = await navFixture();
        f.m.jumpToUserMessage(f.btn(0, 1), 1);
        assert.strictEqual(f.scrolls.length, 1);
        assert.strictEqual(f.scrolls[0].behavior, 'smooth');
        assert.strictEqual(typeof f.scrolls[0].top, 'number');
        assert.ok(f.doc.getElementById('msg-4').classList.contains('user-msg-nav-flash'));
        assert.strictEqual(f.intents.length, 1);
        f.m.jumpToUserMessage(f.btn(6, -1), -1);
        assert.strictEqual(f.scrolls.length, 2);
        assert.ok(f.doc.getElementById('msg-4').classList.contains('user-msg-nav-flash'));
    }, { tags: ['unit'], timeout: 3000 });

    test('edge clicks are no-ops (no scroll) and mark the button disabled', async function() {
        var f = await navFixture();
        f.m.jumpToUserMessage(f.btn(0, -1), -1);
        f.m.jumpToUserMessage(f.btn(6, 1), 1);
        assert.strictEqual(f.scrolls.length, 0);
        assert.strictEqual(f.intents.length, 0);
        assert.strictEqual(f.btn(0, -1).getAttribute('aria-disabled'), 'true');
        assert.strictEqual(f.btn(6, 1).getAttribute('aria-disabled'), 'true');
    }, { tags: ['unit'], timeout: 3000 });
});
