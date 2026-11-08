// Chat scroll: user-intent gating of the follow release, the scroll-to-bottom
// button, and per-chat reset on switch (src/js/core/050-streaming.js).

async function _scrollEnv() {
    var src = await loadFile('src/js/core/050-streaming.js');
    var listeners = {};
    var btnClasses = {};
    var btn = {
        attrs: {}, tabIndex: -1,
        classList: { toggle: function(c, on) { btnClasses[c] = !!on; } },
        setAttribute: function(k, v) { this.attrs[k] = v; }
    };
    var messages = { scrollHeight: 5000, clientHeight: 500, scrollTop: 4500, querySelector: function() { return null; } };
    var document = {
        getElementById: function(id) { return id === 'scroll-to-bottom-btn' ? btn : id === 'messages' ? messages : null; },
        addEventListener: function(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }
    };
    var win = { currentChatId: 'c1', document: document, isNearBottom: undefined };
    var f = new Function('win',
        'with (win) {\n' + src + '\nreturn { handleChatScroll: handleChatScroll, resetChatScrollForSwitch: resetChatScrollForSwitch, stickMap: stickToBottomByChatId, get stick() { return win.stickToBottom; } };\n}');
    // window inside the source resolves to win via `with`.
    win.window = win;
    var api = f(win);
    return {
        api: api, win: win, el: messages, btnClasses: btnClasses, btn: btn,
        fire: function(t, e) { (listeners[t] || []).forEach(function(fn) { fn(e || {}); }); }
    };
}

describe('chat scroll intent', function() {
    test('programmatic small scroll-up without a gesture keeps following', async function() {
        var env = await _scrollEnv();
        env.api.handleChatScroll(env.el);          // seed last = 4500 (bottom)
        env.el.scrollTop = 4300;                   // focus()/layout shift, 200px up
        env.api.handleChatScroll(env.el);
        assert.strictEqual(env.api.stick, true);
        assert.strictEqual(env.btnClasses.visible, false);
    }, { tags: ['unit'] });

    test('wheel gesture then scroll-up releases and shows the button', async function() {
        var env = await _scrollEnv();
        env.api.handleChatScroll(env.el);
        env.fire('wheel', { target: env.el }); // wheel over #messages (S2: scoped)
        env.el.scrollTop = 4300;
        env.api.handleChatScroll(env.el);
        assert.strictEqual(env.api.stick, false);
        assert.strictEqual(env.btnClasses.visible, true);
        assert.strictEqual(env.btn.attrs['aria-hidden'], 'false');
    }, { tags: ['unit'] });

    test('typing keys do not count as scroll intent; PageUp does', async function() {
        var env = await _scrollEnv();
        env.api.handleChatScroll(env.el);
        env.fire('keydown', { key: 'a' });
        env.el.scrollTop = 4300;
        env.api.handleChatScroll(env.el);
        assert.strictEqual(env.api.stick, true);
        env.fire('keydown', { key: 'PageUp' });
        env.el.scrollTop = 4100;
        env.api.handleChatScroll(env.el);
        assert.strictEqual(env.api.stick, false);
    }, { tags: ['unit'] });

    test('jump of more than one viewport releases even without a gesture', async function() {
        var env = await _scrollEnv();
        env.api.handleChatScroll(env.el);
        env.el.scrollTop = 1000;
        env.api.handleChatScroll(env.el);
        assert.strictEqual(env.api.stick, false);
    }, { tags: ['unit'] });

    test('chat switch resets the new chat to following and forgets last scrollTop', async function() {
        var env = await _scrollEnv();
        env.api.stickMap.c2 = false;
        env.el._agLastScrollTop = 1234;
        env.api.resetChatScrollForSwitch('c2');
        assert.strictEqual(env.api.stickMap.c2, true);
        assert.strictEqual(env.el._agLastScrollTop, undefined);
    }, { tags: ['unit'] });
});
