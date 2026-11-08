// Chat auto-scroll follow-ups (src/js/core/050-streaming.js): intent window,
// editable-target keys, pointer-held scoping/clearing, releaseChatFollow,
// button visibility, switch/empty handling, re-stick/clamp, scoped save.

async function _followEnv() {
    var src = await loadFile('src/js/core/050-streaming.js');
    var listeners = {}, winListeners = {}, timers = [], storage = {};
    var clock = { now: 100000 };
    var btnClasses = {};
    var btn = { id: 'scroll-to-bottom-btn', attrs: {}, tabIndex: -1,
        classList: { toggle: function(c, on) { btnClasses[c] = !!on; } },
        setAttribute: function(k, v) { this.attrs[k] = v; } };
    var inner = { tagName: 'DIV' };
    var messages = { id: 'messages', scrollHeight: 5000, clientHeight: 500, scrollTop: 4500,
        querySelector: function() { return null; },
        contains: function(n) { return n === messages || n === inner; } };
    var outside = { tagName: 'DIV' };
    var composer = { tagName: 'TEXTAREA', focused: 0, focus: function() { this.focused++; document.activeElement = composer; } };
    var document = {
        visibilityState: 'visible', activeElement: null,
        getElementById: function(id) { return id === 'scroll-to-bottom-btn' ? btn : id === 'messages' ? messages : id === 'message-input' ? composer : null; },
        addEventListener: function(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }
    };
    var win = {
        currentChatId: 'c1', document: document, isNearBottom: undefined,
        Date: { now: function() { return clock.now; } },
        setTimeout: function(fn, ms) { timers.push({ fn: fn, at: clock.now + ms, live: true }); return timers.length; },
        clearTimeout: function(h) { if (h && timers[h - 1]) timers[h - 1].live = false; },
        appStorage: { setItem: function(k, v) { storage[k] = v; } },
        addEventListener: function(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); }
    };
    win.window = win;
    var f = new Function('win', 'with (win) {\n' + src + '\nreturn { handleChatScroll: handleChatScroll, resetChatScrollForSwitch: resetChatScrollForSwitch, releaseChatFollow: releaseChatFollow, scheduleChatScrollSave: scheduleChatScrollSave, cancelChatScrollSave: cancelChatScrollSave, scrollChatToBottom: scrollChatToBottom, updateScrollToBottomButton: updateScrollToBottomButton, hasIntent: _agHasUserScrollIntent, held: function() { return _agPointerHeld; }, SCROLL_INTENT_MS: SCROLL_INTENT_MS, stickMap: stickToBottomByChatId, get stick() { return win.stickToBottom; } };\n}');
    var api = f(win);
    return {
        api: api, win: win, el: messages, inner: inner, composer: composer, outside: outside, btn: btn, btnClasses: btnClasses, storage: storage, clock: clock, document: document,
        fire: function(t, e) { (listeners[t] || []).forEach(function(fn) { fn(e || {}); }); },
        fireWin: function(t) { (winListeners[t] || []).forEach(function(fn) { fn({}); }); },
        advance: function(ms) { clock.now += ms; timers.forEach(function(x) { if (x.live && x.at <= clock.now) { x.live = false; x.fn(); } }); }
    };
}

describe('chat scroll follow', function() {
    test('intent window expires after SCROLL_INTENT_MS', async function() {
        var env = await _followEnv();
        env.fire('wheel', { target: env.inner });
        assert.strictEqual(env.api.hasIntent(), true);
        env.advance(env.api.SCROLL_INTENT_MS - 1);
        assert.strictEqual(env.api.hasIntent(), true);
        env.advance(2);
        assert.strictEqual(env.api.hasIntent(), false);
    }, { tags: ['unit'] });

    test('scroll keys in editable fields do not mark intent; on non-editable targets they do', async function() {
        var env = await _followEnv();
        env.fire('keydown', { key: ' ', target: { tagName: 'TEXTAREA' } });
        env.fire('keydown', { key: 'ArrowUp', target: { tagName: 'INPUT', type: 'text' } });
        env.fire('keydown', { key: 'End', target: { tagName: 'DIV', isContentEditable: true } });
        assert.strictEqual(env.api.hasIntent(), false);
        env.inner.tagName = 'INPUT'; env.inner.type = 'checkbox'; // non-text control inside #messages
        env.fire('keydown', { key: ' ', target: env.inner });
        assert.strictEqual(env.api.hasIntent(), true);
        env.advance(5000);
        env.fire('keydown', { key: 'PageUp', target: { tagName: 'BUTTON' } }); // sidebar button
        assert.strictEqual(env.api.hasIntent(), false, 'keys outside #messages/body do not mark intent');
        env.fire('keydown', { key: 'PageUp', target: { tagName: 'BODY' } });
        assert.strictEqual(env.api.hasIntent(), true);
    }, { tags: ['unit'] });

    test('wheel / pointerdown outside #messages do not mark intent or hold', async function() {
        var env = await _followEnv();
        env.fire('wheel', { target: env.outside });
        env.fire('pointerdown', { target: env.outside });
        assert.strictEqual(env.api.held(), false);
        assert.strictEqual(env.api.hasIntent(), false);
        env.fire('pointerdown', { target: env.el }); // scrollbar of #messages
        assert.strictEqual(env.api.held(), true);
    }, { tags: ['unit'] });

    test('held pointer clears on blur, hidden tab, lostpointercapture and safety timeout', async function() {
        var env = await _followEnv();
        env.fire('pointerdown', { target: env.inner });
        env.fireWin('blur');
        assert.strictEqual(env.api.held(), false);
        env.fire('pointerdown', { target: env.inner });
        env.document.visibilityState = 'hidden';
        env.fire('visibilitychange');
        assert.strictEqual(env.api.held(), false);
        env.document.visibilityState = 'visible';
        env.fire('pointerdown', { target: env.inner });
        env.fire('lostpointercapture');
        assert.strictEqual(env.api.held(), false);
        env.fire('pointerdown', { target: env.inner });
        env.advance(6000); env.fire('pointermove'); env.advance(6000);
        assert.strictEqual(env.api.held(), true, 'pointermove re-arms the timeout');
        env.advance(3000); env.api.handleChatScroll(env.el); env.advance(6000);
        assert.strictEqual(env.api.held(), true, 'scroll while held (scrollbar drag) re-arms the timeout');
        env.advance(10001);
        assert.strictEqual(env.api.held(), false, 'auto-cleared without pointermove');
    }, { tags: ['unit'] });

    test('releaseChatFollow stops following (only for targets inside #messages)', async function() {
        var env = await _followEnv();
        assert.strictEqual(env.api.releaseChatFollow(env.outside), false);
        assert.strictEqual(env.api.stick, true);
        env.el.scrollTop = 3000;
        assert.strictEqual(env.api.releaseChatFollow(env.inner), true);
        assert.strictEqual(env.api.stick, false);
        assert.strictEqual(env.btnClasses.visible, true);
    }, { tags: ['unit'] });

    test('button threshold: hidden within 40px of bottom, visible beyond when not following', async function() {
        var env = await _followEnv();
        env.win.stickToBottom = false;
        env.el.scrollTop = 4500 - 40; env.api.updateScrollToBottomButton();
        assert.strictEqual(env.btnClasses.visible, false);
        env.el.scrollTop = 4500 - 41; env.api.updateScrollToBottomButton();
        assert.strictEqual(env.btnClasses.visible, true);
        assert.strictEqual(env.btn.tabIndex, 0);
    }, { tags: ['unit'] });

    test('button hidden after switch (new chat follows) and in an empty chat', async function() {
        var env = await _followEnv();
        env.win.stickToBottom = false; env.el.scrollTop = 1000; env.api.updateScrollToBottomButton();
        assert.strictEqual(env.btnClasses.visible, true);
        env.api.resetChatScrollForSwitch('c2'); // currentChatId still c1 here
        assert.strictEqual(env.btnClasses.visible, false);
        assert.strictEqual(env.btn.attrs['aria-hidden'], 'true');
        env.win.currentChatId = 'c2';
        env.el.scrollHeight = 500; env.el.scrollTop = 0; env.api.updateScrollToBottomButton(); // empty chat
        assert.strictEqual(env.btnClasses.visible, false);
        var r = await loadFile('src/js/ui/250-message-render.js');
        assert.ok((r.match(/updateScrollToBottomButton\(\); \/\/ S4/g) || []).length === 2, 'empty + loading branches refresh the button');
    }, { tags: ['unit'] });

    test('downward scroll near bottom re-sticks; clamp (shrink) keeps state', async function() {
        var env = await _followEnv();
        env.api.handleChatScroll(env.el);
        env.fire('wheel', { target: env.inner });
        env.el.scrollTop = 3000; env.api.handleChatScroll(env.el);
        assert.strictEqual(env.api.stick, false);
        env.el.scrollTop = 4400; env.api.handleChatScroll(env.el); // down, 100px from bottom
        assert.strictEqual(env.api.stick, true);
        env.fire('wheel', { target: env.inner });
        env.el.scrollTop = 3000; env.api.handleChatScroll(env.el);
        assert.strictEqual(env.api.stick, false);
        env.el.scrollHeight = 3400; env.el.scrollTop = 2900; env.api.handleChatScroll(env.el); // clamp to new max
        assert.strictEqual(env.api.stick, false, 'released user not re-stuck by a shrink');
    }, { tags: ['unit'] });

    test('scrollChatToBottom re-follows and moves focus from the hidden button to the composer (S8)', async function() {
        var env = await _followEnv();
        env.win.stickToBottom = false; env.el.scrollTop = 1000;
        env.document.activeElement = env.btn;
        env.api.scrollChatToBottom();
        assert.strictEqual(env.api.stick, true);
        assert.strictEqual(env.btnClasses.visible, false);
        assert.strictEqual(env.composer.focused, 1);
        assert.strictEqual(env.document.activeElement, env.composer);
    }, { tags: ['unit'] });

    test('cancelChatScrollSave drops a pending save for the deleted chat', async function() {
        var env = await _followEnv();
        env.api.scheduleChatScrollSave('gone', 77);
        env.api.cancelChatScrollSave('other');
        env.api.cancelChatScrollSave('gone');
        env.advance(1000);
        assert.strictEqual(env.storage.scrollPos_gone, undefined);
    }, { tags: ['unit'] });

    test('debounced scroll save uses the chat id captured when scheduled', async function() {
        var env = await _followEnv();
        env.api.scheduleChatScrollSave('c1', 1234);
        env.win.currentChatId = 'c2';
        env.advance(250);
        assert.strictEqual(env.storage.scrollPos_c1, 1234);
        assert.strictEqual(env.storage.scrollPos_c2, undefined);
        env.api.scheduleChatScrollSave('c2', 10);
        env.api.scheduleChatScrollSave('c3', 20); // other chat: c2 flushed, not dropped
        assert.strictEqual(env.storage.scrollPos_c2, 10);
        env.api.scheduleChatScrollSave('c3', 30);
        env.api.resetChatScrollForSwitch('c4'); // switch flushes pending save
        assert.strictEqual(env.storage.scrollPos_c3, 30);
    }, { tags: ['unit'] });
});
