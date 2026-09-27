// S8A-01 / S8A-02 / S8A-03 — ChatGPT login dialogs (src/js/ui/160-notifications.js)
// and the global Escape handler (src/js/core/120-init.js).
// S8A-02: the 10 s browser-login expiry tick writes only #chatgpt-browser-expiry, so a
//         "Callback not accepted…" error in #chatgpt-browser-feedback survives it, and
//         the tick no longer re-enables submit while a callback is in flight.
// S8A-03: the countdown lines are not live regions (aria-live="off"); device-code
//         expiry is announced once through the polite #chatgpt-device-copy-feedback.
// S8A-01: the global Escape handler skips both ChatGPT dialogs (each owns Escape), so
//         the device dialog's own close runs (timer, listener, focus); the dialog's
//         keydown guard also cleans up when its overlay was removed by someone else.
// Loads the REAL 180-search + 160-notifications into the REAL sandbox document with a
// fake clock (setInterval/clearInterval/Date). The INIT handler is sliced from source
// like test/global-escape-backdrop.test.js and is never attached to the real document.
// Run: run_tests { files: ['test/chatgpt-login-modals.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var FILES = ['src/js/ui/180-search.js', 'src/js/ui/160-notifications.js'];

// Deterministic setInterval/clearInterval/Date for the module scope.
function fakeClock() {
    var c = { now: 1000000, timers: [], seq: 0 };
    c.setInterval = function(fn, ms) { var id = ++c.seq; c.timers.push({ id: id, at: c.now + ms, fn: fn, every: ms }); return id; };
    c.clearInterval = function(id) { c.timers = c.timers.filter(function(t) { return t.id !== id; }); };
    c.tick = function(ms) {
        var end = c.now + ms;
        for (;;) {
            var due = c.timers.filter(function(t) { return t.at <= end; }).sort(function(a, b) { return a.at - b.at || a.id - b.id; })[0];
            if (!due) break;
            c.now = due.at;
            due.at += due.every;
            due.fn();
        }
        c.now = end;
    };
    var RealDate = Date;
    c.Date = function() { return arguments.length ? new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))() : new RealDate(c.now); };
    c.Date.now = function() { return c.now; };
    return c;
}

describe('S8A ChatGPT login dialogs (ui/160-notifications.js, core/120-init.js)', function() {
    var m = null;
    afterEach(function() {
        if (m) { m.closeChatGPTBrowserModal(); m.closeChatGPTDeviceCodeModal({ restoreFocus: false }); }
        m = null;
    });

    async function loadDialogs() {
        var clock = fakeClock(), sent = [];
        var chrome = fakeChrome({ runtime: { lastError: null, sendMessage: function(msg, cb) { sent.push({ msg: msg, cb: cb }); } } });
        m = await U.loadUi(FILES, { lenient: true, globals: { chrome: chrome, Date: clock.Date,
            setInterval: clock.setInterval, clearInterval: clock.clearInterval, showSnackbar: function() {},
            getProviderById: function() { return null; }, currentProvider: 'fixture' } });
        return { m: m, clock: clock, sent: sent };
    }
    function $(sel) { return document.querySelector(sel); }
    function lastCallback(sent) {
        var hits = sent.filter(function(s) { return s.msg && s.msg.type === 'openai-oauth-browser-callback'; });
        return hits[hits.length - 1];
    }

    // The global Escape handler, sliced from 120-init.js (same recipe as
    // test/global-escape-backdrop.test.js). overlays answer '.modal-overlay.show';
    // realDoc delegates every query to the real document instead.
    var FROM = "document.addEventListener('keydown', function(e) {\n        if (e.key !== 'Escape')";
    var TO = '// NAV-H7';
    var CLOSERS = ['closeModal', 'closeWidgetFullscreen', 'closeWidgetCodeEdit', 'closeWidgetModal',
        'closeWidgetHistory', 'closeResultPopover', 'closeDiffViewer', 'closeDropdowns', 'closeAllHeaderMenus'];
    async function loadEscapeHandler(overlays, realDoc) {
        var src = await loadFile('src/js/core/120-init.js');
        var a = src.indexOf(FROM), b = src.indexOf(TO, a);
        assert.ok(a >= 0 && b > a, 'global Escape handler anchors present in 120-init.js');
        var listeners = {}, calls = [];
        var doc = {
            body: realDoc ? realDoc.body : {},
            addEventListener: function(type, fn) { listeners[type] = fn; },
            getElementById: function(id) { return realDoc ? realDoc.getElementById(id) : null; },
            querySelector: function(sel) { return realDoc ? realDoc.querySelector(sel) : null; },
            querySelectorAll: function(sel) {
                if (realDoc) return realDoc.querySelectorAll(sel);
                return sel === '.modal-overlay.show' ? overlays.filter(function(o) { return o.isConnected; }) : [];
            }
        };
        var win = { getComputedStyle: function() { return { display: 'none' }; } };
        var fns = CLOSERS.map(function(name) { return function() { calls.push(name); }; });
        var install = Function.apply(null, ['document', 'window'].concat(CLOSERS, ['closeWidgetPinMenu', src.slice(a, b)]));
        install.apply(null, [doc, win].concat(fns, [undefined]));
        assert.strictEqual(typeof listeners.keydown, 'function', 'the sliced source registers the keydown handler');
        return { keydown: listeners.keydown, calls: calls };
    }
    function overlayStub(id, withOnclick) {
        var ov = { id: id, isConnected: true, removed: 0, clicks: 0 };
        ov.remove = function() { ov.removed++; ov.isConnected = false; };
        ov.onclick = withOnclick ? function() { ov.clicks++; } : null;
        return ov;
    }
    // A real, connected opener whose focus() is counted (sandbox focus() does not move activeElement).
    function opener() {
        var btn = document.createElement('button');
        btn.setAttribute('data-ui-test-root', '1');
        btn.focusCalls = 0;
        btn.focus = function() { btn.focusCalls++; };
        document.body.appendChild(btn);
        return btn;
    }

    test('S8A-02: callback error survives the expiry tick; in-flight lock holds', async function() {
        var env = await loadDialogs();
        env.m.showChatGPTBrowserModal({ expiresAt: env.clock.now + 600000 });
        var input = $('#chatgpt-browser-callback'), submit = $('#chatgpt-browser-submit');
        var feedback = $('#chatgpt-browser-feedback'), line = $('#chatgpt-browser-expiry');
        assert.ok(line, 'the dialog has a separate #chatgpt-browser-expiry countdown line');
        assert.match(line.textContent, /Waiting for approval/);
        assert.strictEqual(feedback.textContent, '', 'the polite feedback line is not the countdown');

        input.value = 'http://localhost:1455/auth/callback?state=fixture&code=fixture';
        submit.click();
        assert.ok(lastCallback(env.sent), 'the pasted address was sent');
        assert.strictEqual(submit.disabled, true, 'submission is locked while the callback is in flight');
        env.clock.tick(10000);
        assert.strictEqual(submit.disabled, true, 'the expiry tick does not re-enable submit mid-flight');

        lastCallback(env.sent).cb({ error: 'x' });
        assert.match(feedback.textContent, /not accepted/);
        assert.strictEqual(submit.disabled, false, 'an error unlocks submission on a live dialog');
        env.clock.tick(10000);
        assert.match(feedback.textContent, /not accepted/, 'the error survives the next expiry tick');
        assert.match(line.textContent, /Waiting for approval/);

        input.value = 'http://localhost:1455/auth/callback?state=fixture&code=again';
        submit.click();
        assert.strictEqual(feedback.textContent, '', 'a resubmission clears the old result so a repeat error is announced again');
        env.clock.tick(600000);
        assert.strictEqual(input.disabled, true, 'expired dialog disables the field');
        assert.match(feedback.textContent, /expired/, 'expiry is announced on the feedback line');
        lastCallback(env.sent).cb({ error: 'x' });
        assert.strictEqual(submit.disabled, true, 'a late error does not re-enable submit on an expired dialog');
    }, { tags: ['unit'], timeout: 10000 });

    test('S8A-03: countdowns are not live regions; expiry announced once', async function() {
        var env = await loadDialogs();
        env.m.showChatGPTBrowserModal({ expiresAt: env.clock.now + 600000 });
        var bLine = $('#chatgpt-browser-expiry');
        assert.ok(bLine, 'browser countdown line exists');
        assert.strictEqual(bLine.getAttribute('aria-live'), 'off');
        env.m.closeChatGPTBrowserModal();

        env.m.showChatGPTDeviceCodeModal({ userCode: 'ABCD-EFGH', expiresAt: env.clock.now + 120000 });
        var dLine = $('#chatgpt-device-expiry'), fb = $('#chatgpt-device-copy-feedback');
        assert.strictEqual(dLine.getAttribute('aria-live'), 'off');
        assert.strictEqual(dLine.getAttribute('role'), 'timer');
        assert.match($('#chatgpt-device-modal').getAttribute('aria-describedby'), /chatgpt-device-expiry/, 'still read once as part of the description');
        env.clock.tick(3000);
        assert.match(dLine.textContent, /Code expires in 1:5\d\./);
        assert.strictEqual(fb.textContent, '', 'the per-second countdown never reaches the polite line');
        env.clock.tick(120000);
        assert.strictEqual(fb.textContent, 'This code has expired.');
        env.m.closeChatGPTDeviceCodeModal({ restoreFocus: false });

        // Already expired at open: the first update and the first tick both see "expired".
        env.m.showChatGPTDeviceCodeModal({ userCode: 'ABCD-EFGH', expiresAt: env.clock.now - 1 });
        fb = $('#chatgpt-device-copy-feedback');
        assert.match(fb.textContent, /expired/);
        var node = fb.firstChild;
        env.clock.tick(3000);
        assert.ok(fb.firstChild === node, 'the expiry text is written once, not re-announced by later ticks');
        assert.strictEqual(env.clock.timers.length, 0, 'the countdown timer stops after expiry');
    }, { tags: ['unit'], timeout: 10000 });

    test('S8A-01: global Escape handler skips ChatGPT dialogs that own Escape', async function() {
        var ids = ['chatgpt-device-modal', 'chatgpt-browser-modal'];
        for (var i = 0; i < ids.length; i++) {
            var ov = overlayStub(ids[i], false);
            var h = await loadEscapeHandler([ov]);
            h.keydown({ key: 'Escape' });
            assert.strictEqual(ov.removed, 0, ids[i] + ' is left to its own Escape handler');
        }
        var gh = overlayStub('github-setup-modal', true);
        var h2 = await loadEscapeHandler([gh]);
        h2.keydown({ key: 'Escape' });
        assert.strictEqual(gh.clicks, 1, 'a twin without its own key handler still gets its backdrop close');
        assert.strictEqual(gh.removed, 1, 'and the .remove() fallback');
    }, { tags: ['unit'], timeout: 10000 });

    test('S8A-01: Esc on the device-code dialog runs its own close (timer, listener, focus)', async function() {
        var env = await loadDialogs();
        var esc = await loadEscapeHandler([], document);
        var btn = opener();
        try {
            env.m.__scope._chatGPTDeviceReturnFocus = btn; // picked up by `_chatGPTDeviceReturnFocus || document.activeElement`
            env.m.showChatGPTDeviceCodeModal({ userCode: 'ABCD-EFGH', expiresAt: env.clock.now + 120000 });
            assert.ok($('#chatgpt-device-modal'), 'dialog open');
            assert.ok(env.m.__scope._chatGPTDeviceExpiryTimer, 'countdown running');
            // Real order: init()'s global listener was registered first, the dialog's at open.
            var ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            esc.keydown(ev);
            document.dispatchEvent(ev);
            assert.strictEqual($('#chatgpt-device-modal'), null, 'dialog closed');
            assert.strictEqual(env.m.__scope._chatGPTDeviceExpiryTimer, null, 'countdown timer cleared');
            assert.strictEqual(env.clock.timers.length, 0, 'no interval left ticking');
            assert.strictEqual(env.m.__scope._chatGPTDeviceKeyHandler, null, 'keydown listener removed');
            assert.strictEqual(env.m.__scope._chatGPTDeviceReturnFocus, null, 'no stale opener kept for later focus jumps');
            assert.strictEqual(btn.focusCalls, 1, 'focus returned to the opener');
        } finally { btn.remove(); }
    }, { tags: ['unit'], timeout: 10000 });

    test('S8A-01: the device-code keydown guard cleans up when its overlay is already gone', async function() {
        var env = await loadDialogs();
        var btn = opener();
        try {
            env.m.__scope._chatGPTDeviceReturnFocus = btn;
            env.m.showChatGPTDeviceCodeModal({ userCode: 'ABCD-EFGH', expiresAt: env.clock.now + 120000 });
            $('#chatgpt-device-modal').remove(); // e.g. another generic remover got there first
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            assert.strictEqual(env.m.__scope._chatGPTDeviceExpiryTimer, null, 'countdown timer cleared');
            assert.strictEqual(env.clock.timers.length, 0, 'no interval left ticking');
            assert.strictEqual(env.m.__scope._chatGPTDeviceKeyHandler, null, 'keydown listener removed');
            assert.strictEqual(env.m.__scope._chatGPTDeviceReturnFocus, null, 'stale opener dropped');
            assert.strictEqual(btn.focusCalls, 0, 'no focus jump: the dialog was not visibly closed by the user');
        } finally { btn.remove(); }
    }, { tags: ['unit'], timeout: 10000 });
});
