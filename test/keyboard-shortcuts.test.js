// Keyboard shortcuts registry (src/js/ui/320-keyboard-shortcuts.js): pure matcher,
// formatter, per-platform keys, filter, Tab-trap and the capture-phase Esc-to-pause gate.
describe('keyboard shortcuts', function() {
    var M, state, overlay, paused, sidebarToggles, byId;
    function ev(key, mods, target) {
        mods = mods || {};
        var e = { key: key, code: mods.code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift,
            target: target || { tagName: 'BODY' }, defaultPrevented: false, isComposing: !!mods.composing };
        e.preventDefault = function() { e.defaultPrevented = true; };
        return e;
    }
    function id(s) { return s ? s.id : null; }
    var textarea = function(v) { return { tagName: 'TEXTAREA', value: v || '' }; };
    var input = function(v) { return { tagName: 'INPUT', type: 'text', value: v || '' }; };

    beforeEach(async function() {
        state = 'send'; overlay = null; paused = 0; sidebarToggles = 0; byId = {};
        var fakeDoc = {
            activeElement: { tagName: 'BODY' },
            querySelector: function() { return overlay; },
            querySelectorAll: function() { return []; },
            getElementById: function(i) { return byId[i] || null; },
            addEventListener: function() {}
        };
        M = await loadModules(['src/js/ui/320-keyboard-shortcuts.js'], { lenient: true, globals: {
            document: fakeDoc,
            window: { getComputedStyle: function() { return { display: 'none' }; } },
            currentChatId: 'c1',
            togglePause: function() { paused++; },
            toggleSidebar: function() { sidebarToggles++; },
            t: function(s) { return s; },
            N_: function(s) { return s; },
            _chatControlsState: function() { return state; },
            console: { warn: function() {}, log: function() {}, error: function() {} }
        } });
    });

    test('Mod resolves to Cmd on macOS and Ctrl elsewhere', function() {
        assert.strictEqual(id(M.matchShortcut(ev('o', { meta: true, shift: true }), true)), 'new-chat');
        assert.strictEqual(M.matchShortcut(ev('o', { ctrl: true, shift: true }), true), null);
        assert.strictEqual(id(M.matchShortcut(ev('O', { ctrl: true, shift: true }), false)), 'new-chat');
        assert.strictEqual(M.matchShortcut(ev('o', { meta: true, shift: true }), false), null);
        assert.strictEqual(id(M.matchShortcut(ev('/', { ctrl: true }), false)), 'help');
        assert.strictEqual(id(M.matchShortcut(ev('s', { meta: true, shift: true }), true)), 'sidebar');
        assert.strictEqual(id(M.matchShortcut(ev(',', { ctrl: true }), false)), 'settings');
        // Extra modifiers never match.
        assert.strictEqual(M.matchShortcut(ev('o', { ctrl: true, shift: true, alt: true }), false), null);
        // IME composition is ignored.
        assert.strictEqual(M.matchShortcut(ev('o', { ctrl: true, shift: true, composing: true }), false), null);
        // Non-Latin layout falls back to the physical key.
        assert.strictEqual(id(M.matchShortcut(ev('\u0449', { ctrl: true, shift: true, code: 'KeyO' }), false)), 'new-chat');
    });

    test('copy last response: Alt+Shift+C everywhere (Cmd+Shift+C / Ctrl+Shift+C are DevTools)', function() {
        assert.strictEqual(M.matchShortcut(ev('c', { meta: true, shift: true }), true), null, 'Cmd+Shift+C is DevTools inspect on macOS');
        // macOS Option+Shift+C types \u00c7 in e.key: matched through e.code.
        assert.strictEqual(id(M.matchShortcut(ev('\u00c7', { alt: true, shift: true, code: 'KeyC' }), true)), 'copy-last');
        assert.strictEqual(M.matchShortcut(ev('\u00c7', { alt: true, shift: true, code: 'KeyV' }), true), null);
        assert.strictEqual(id(M.matchShortcut(ev('C', { alt: true, shift: true, code: 'KeyC' }), false)), 'copy-last');
        assert.strictEqual(id(M.matchShortcut(ev('C', { alt: true, shift: true }), false)), 'copy-last');
        assert.strictEqual(M.matchShortcut(ev('C', { ctrl: true, shift: true }), false), null);
        // Allowed while typing in the composer.
        assert.strictEqual(id(M.matchShortcut(ev('C', { alt: true, shift: true }, textarea('draft')), false)), 'copy-last');
    });

    test('kbdKeysFor picks keysMac on macOS only', function() {
        var s = M.kbdFindShortcut('copy-last');
        assert.deepStrictEqual(M.kbdKeysFor(s, true), ['Alt+Shift+C']);
        assert.deepStrictEqual(M.kbdKeysFor(s, false), ['Alt+Shift+C']);
        var fake = { keys: ['Alt+X'], keysMac: ['Mod+X'] };
        assert.deepStrictEqual(M.kbdKeysFor(fake, true), ['Mod+X']);
        assert.deepStrictEqual(M.kbdKeysFor(fake, false), ['Alt+X']);
        assert.deepStrictEqual(M.kbdKeysFor(M.kbdFindShortcut('new-chat'), true), ['Mod+Shift+O']);
        assert.deepStrictEqual(M.kbdKeysFor(null, true), []);
    });

    test('no browser-reserved combos are bound (Shift+Esc, Ctrl+Shift+C on Windows/Linux)', function() {
        assert.strictEqual(M.matchShortcut(ev('Escape', { shift: true }), false), null);
        assert.strictEqual(M.matchShortcut(ev('Escape', { shift: true }), false, { phase: 'capture' }), null);
        M.KBD_SHORTCUTS.forEach(function(s) {
            M.kbdKeysFor(s, false).forEach(function(k) {
                assert.ok(!/^(Mod|Ctrl)\+Shift\+[CIJ]$/i.test(k), s.id + ' binds DevTools combo ' + k);
                assert.notStrictEqual(k, 'Shift+Escape', s.id + ' binds Task Manager');
            });
            M.kbdKeysFor(s, true).forEach(function(k) {
                assert.ok(!/^(Mod|Meta)\+(Shift|Alt)\+[CIJ]$/i.test(k), s.id + ' binds macOS DevTools combo ' + k);
            });
        });
    });

    test('? and / are single keys: ignored in text fields and when the switch is off', function() {
        assert.strictEqual(id(M.matchShortcut(ev('?', { shift: true }), false)), 'help');
        assert.strictEqual(id(M.matchShortcut(ev('/'), false)), 'focus-input');
        assert.strictEqual(id(M.matchShortcut(ev('/'), true)), 'focus-input');
        assert.strictEqual(M.matchShortcut(ev('?', { shift: true }, textarea()), false), null);
        assert.strictEqual(M.matchShortcut(ev('/', {}, input()), false), null);
        assert.strictEqual(M.matchShortcut(ev('/', {}, { tagName: 'DIV', isContentEditable: true }), false), null);
        assert.strictEqual(M.matchShortcut(ev('?', { shift: true }), false, { singleKey: false }), null);
        assert.strictEqual(M.matchShortcut(ev('/'), false, { singleKey: false }), null);
        // Mod+/ still opens help when single keys are off, and inside fields.
        assert.strictEqual(id(M.matchShortcut(ev('/', { ctrl: true }, textarea('x')), false, { singleKey: false })), 'help');
        // Checkboxes are not text fields.
        assert.strictEqual(id(M.matchShortcut(ev('/', {}, { tagName: 'INPUT', type: 'checkbox' }), false)), 'focus-input');
    });

    test('Alt+Up/Down step chats only from an empty field', function() {
        assert.strictEqual(id(M.matchShortcut(ev('ArrowUp', { alt: true }), false)), 'prev-chat');
        assert.strictEqual(id(M.matchShortcut(ev('ArrowDown', { alt: true }), true)), 'next-chat');
        assert.strictEqual(id(M.matchShortcut(ev('ArrowUp', { alt: true }, textarea('')), false)), 'prev-chat');
        assert.strictEqual(M.matchShortcut(ev('ArrowUp', { alt: true }, textarea('hello')), false), null);
        assert.strictEqual(M.matchShortcut(ev('ArrowDown', { alt: true }, input('q')), false), null);
    });

    test('Esc: only the capture phase maps it, to pause; info rows never dispatch', function() {
        assert.strictEqual(M.matchShortcut(ev('Escape'), false), null);
        assert.strictEqual(id(M.matchShortcut(ev('Escape'), false, { phase: 'capture' })), 'pause');
        assert.strictEqual(id(M.matchShortcut(ev('Escape', {}, textarea('x')), true, { phase: 'capture' })), 'pause');
        assert.strictEqual(M.matchShortcut(ev('o', { ctrl: true, shift: true }), false, { phase: 'capture' }), null);
        assert.strictEqual(M.matchShortcut(ev('k', { ctrl: true }), false), null);          // search: own listener
        assert.strictEqual(M.matchShortcut(ev('ArrowLeft', { alt: true }), false), null);   // back: own listener
        assert.strictEqual(M.matchShortcut(ev('Enter'), false), null);
    });

    test('capture-phase Esc pauses only while the agent runs and nothing is open', function() {
        var e = ev('Escape');
        M.kbdHandleKeydownCapture(e);
        assert.strictEqual(paused, 0, 'idle chat: Esc is left to the ladder');
        assert.strictEqual(e.defaultPrevented, false);
        state = 'pause';
        e = ev('Escape');
        M.kbdHandleKeydownCapture(e);
        assert.strictEqual(paused, 1);
        assert.strictEqual(e.defaultPrevented, true);
        overlay = { className: 'modal-overlay show' };
        e = ev('Escape');
        M.kbdHandleKeydownCapture(e);
        assert.strictEqual(paused, 1, 'an open overlay owns Esc');
        assert.strictEqual(e.defaultPrevented, false);
        overlay = null;
        M.kbdHandleKeydownCapture(ev('Enter'));
        assert.strictEqual(paused, 1);
    });

    test('held keys (e.repeat) never re-fire toggles; Alt+Up/Down may repeat', function() {
        var mac = M.kbdIsMac();
        var e = ev('s', { meta: mac, ctrl: !mac, shift: true });
        M.kbdHandleKeydown(e);
        assert.strictEqual(sidebarToggles, 1);
        e = ev('s', { meta: mac, ctrl: !mac, shift: true }); e.repeat = true;
        M.kbdHandleKeydown(e);
        assert.strictEqual(sidebarToggles, 1, 'auto-repeat ignored');
        assert.strictEqual(e.defaultPrevented, true, 'repeat still suppresses the browser default');
        state = 'pause';
        e = ev('Escape'); e.repeat = true;
        M.kbdHandleKeydownCapture(e);
        assert.strictEqual(paused, 0, 'holding Esc does not toggle pause');
        var rep = M.KBD_SHORTCUTS.filter(function(s) { return s.repeatable; }).map(id).sort();
        assert.deepStrictEqual(rep, ['next-chat', 'prev-chat']);
    });

    test('formatKeys: Mac glyphs vs PC names, per-platform combos', function() {
        assert.deepStrictEqual(M.formatKeys('Mod+Shift+O', true), ['\u21E7', '\u2318', 'O']);
        assert.deepStrictEqual(M.formatKeys('Mod+Shift+O', false), ['Ctrl', 'Shift', 'O']);
        assert.deepStrictEqual(M.formatKeys('Alt+Shift+C', false), ['Alt', 'Shift', 'C']);
        assert.deepStrictEqual(M.formatKeys('Alt+ArrowUp', true), ['\u2325', '\u2191']);
        assert.deepStrictEqual(M.formatKeys('Escape', false), ['Esc']);
        assert.deepStrictEqual(M.formatKeys('/', false), ['/']);
        assert.deepStrictEqual(M.formatKeys(['Mod+/', '?'], true), [['\u2318', '/'], ['?']]);
        assert.strictEqual(M.kbdComboText('Mod+Shift+S', true), '\u21E7\u2318S');
        assert.strictEqual(M.kbdComboText('Mod+Shift+S', false), 'Ctrl+Shift+S');
        var s = M.kbdFindShortcut('copy-last');
        assert.strictEqual(M.kbdComboText(M.kbdKeysFor(s, true)[0], true), '\u2325\u21E7C');
        assert.strictEqual(M.kbdComboText(M.kbdKeysFor(s, false)[0], false), 'Alt+Shift+C');
        assert.strictEqual(M.kbdAriaKeys(M.kbdKeysFor(s, true)[0], true), 'Alt+Shift+C');
        assert.strictEqual(M.kbdAriaKeys('Alt+Shift+C', false), 'Alt+Shift+C');
        assert.strictEqual(M.kbdAriaKeys('Mod+Shift+O', true), 'Meta+Shift+O');
        assert.strictEqual(M.kbdAriaKeys('/', false), '/');
        assert.strictEqual(M.kbdSpokenCombo('Mod+/', true), 'Command+Slash');
        assert.strictEqual(M.kbdSpokenCombo('Alt+ArrowDown', false), 'Alt+Down Arrow');
    });

    test('filterShortcuts matches labels, groups and platform key text', function() {
        var all = M.filterShortcuts(M.KBD_SHORTCUTS, '', false);
        assert.strictEqual(all.length, M.KBD_SHORTCUTS.length);
        assert.notStrictEqual(all, M.KBD_SHORTCUTS, 'returns a copy');
        var ids = function(q, mac) { return M.filterShortcuts(M.KBD_SHORTCUTS, q, mac).map(id); };
        assert.ok(ids('copy', false).indexOf('copy-last') >= 0);
        assert.deepStrictEqual(ids('previous chat', false), ['prev-chat']);
        assert.ok(ids('esc', false).indexOf('close') >= 0 && ids('esc', false).indexOf('pause') >= 0);
        assert.ok(ids('navigation', false).indexOf('back') >= 0, 'group name matches');
        assert.ok(ids('alt+shift+c', false).indexOf('copy-last') >= 0);
        assert.ok(ids('option', true).indexOf('copy-last') >= 0, 'macOS spells Alt as Option');
        assert.strictEqual(ids('command', true).indexOf('copy-last'), -1);
        assert.deepStrictEqual(ids('zzzz-nothing', false), []);
    });

    test('kbdTrapTarget wraps Tab and Shift+Tab at the edges', function() {
        var a = {}, b = {}, c = {}, nodes = [a, b, c];
        assert.strictEqual(M.kbdTrapTarget(nodes, c, false), a);
        assert.strictEqual(M.kbdTrapTarget(nodes, a, true), c);
        assert.strictEqual(M.kbdTrapTarget(nodes, b, false), null);
        assert.strictEqual(M.kbdTrapTarget(nodes, b, true), null);
        assert.strictEqual(M.kbdTrapTarget(nodes, {}, false), a, 'focus outside -> first');
        assert.strictEqual(M.kbdTrapTarget(nodes, {}, true), c, 'focus outside + shift -> last');
        assert.strictEqual(M.kbdTrapTarget([a], a, false), a);
        assert.strictEqual(M.kbdTrapTarget([], a, false), null);
    });

    // Fake element: matches(KBD_CLICK_SELECTOR) is true when `kbd` is set
    // (data-kbd-click / non-<button> role=button).
    function kel(opts) {
        opts = opts || {};
        var attrs = opts.attrs || {};
        return { tagName: opts.tag || 'DIV', type: opts.type, isContentEditable: !!opts.editable,
            matches: function(sel) { return sel === M.KBD_CLICK_SELECTOR && opts.kbd !== false; },
            getAttribute: function(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; } };
    }

    test('kbdActivationFor: Enter and Space activate a [data-kbd-click] control', function() {
        var el = kel();
        assert.strictEqual(M.kbdActivationFor(ev('Enter', {}, el), el), 'click');
        assert.strictEqual(M.kbdActivationFor(ev(' ', {}, el), el), 'click');
        assert.strictEqual(M.kbdActivationFor(ev('a', {}, el), el), null, 'other keys ignored');
        assert.strictEqual(M.kbdActivationFor(ev('Tab', {}, el), el), null);
    });

    test('kbdActivationFor: skips handled, composing, repeat and modified events', function() {
        var el = kel();
        var handled = ev('Enter', {}, el); handled.preventDefault();
        assert.strictEqual(M.kbdActivationFor(handled, el), null, 'defaultPrevented -> own handler already ran');
        assert.strictEqual(M.kbdActivationFor(ev('Enter', { composing: true }, el), el), null);
        var rep = ev('Enter', {}, el); rep.repeat = true;
        assert.strictEqual(M.kbdActivationFor(rep, el), null);
        assert.strictEqual(M.kbdActivationFor(ev('Enter', { ctrl: true }, el), el), null);
        assert.strictEqual(M.kbdActivationFor(ev('Enter', { meta: true }, el), el), null);
        assert.strictEqual(M.kbdActivationFor(ev(' ', { alt: true }, el), el), null);
        assert.strictEqual(M.kbdActivationFor(null, el), null);
        assert.strictEqual(M.kbdActivationFor(ev('Enter', {}, el), null), null);
    });

    test('kbdActivationFor: only the focused control itself, never disabled or text fields', function() {
        var el = kel();
        assert.strictEqual(M.kbdActivationFor(ev('Enter', {}, kel()), el), null, 'bubbled from a child');
        assert.strictEqual(M.kbdActivationFor(ev('Enter', {}, kel({ kbd: false })), kel({ kbd: false })), null);
        var plain = kel({ kbd: false });
        assert.strictEqual(M.kbdActivationFor(ev('Enter', {}, plain), plain), null, 'not a kbd-click target');
        var dis = kel({ attrs: { 'aria-disabled': 'true' } });
        assert.strictEqual(M.kbdActivationFor(ev('Enter', {}, dis), dis), null);
        var ta = kel({ tag: 'TEXTAREA' });
        assert.strictEqual(M.kbdActivationFor(ev(' ', {}, ta), ta), null);
        var ed = kel({ editable: true });
        assert.strictEqual(M.kbdActivationFor(ev(' ', {}, ed), ed), null);
        var cb = kel({ tag: 'INPUT', type: 'checkbox' });
        assert.strictEqual(M.kbdActivationFor(ev('Enter', {}, cb), cb), 'click', 'non-text input is fine');
    });

    test('KBD_CLICK_SELECTOR covers data-kbd-click and non-button role=button', function() {
        assert.ok(M.KBD_CLICK_SELECTOR.indexOf('[data-kbd-click]') !== -1);
        assert.ok(M.KBD_CLICK_SELECTOR.indexOf('[role="button"]:not(button)') !== -1);
    });

    test('kbdRadioNextIndex: arrows wrap forward/back (APG radiogroup)', function() {
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'ArrowRight'), 1);
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'ArrowDown'), 1);
        assert.strictEqual(M.kbdRadioNextIndex(3, 2, 'ArrowRight'), 0, 'wraps to first');
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'ArrowLeft'), 2, 'wraps to last');
        assert.strictEqual(M.kbdRadioNextIndex(3, 1, 'ArrowUp'), 0);
        assert.strictEqual(M.kbdRadioNextIndex(1, 0, 'ArrowDown'), 0, 'single radio stays');
    });

    test('kbdRadioNextIndex: RTL mirrors Left/Right only; other keys and bad input -> -1', function() {
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'ArrowLeft', true), 1);
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'ArrowRight', true), 2);
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'ArrowDown', true), 1);
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'ArrowUp', true), 2);
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'Enter'), -1);
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, ' '), -1);
        assert.strictEqual(M.kbdRadioNextIndex(3, 0, 'Home'), -1);
        assert.strictEqual(M.kbdRadioNextIndex(0, 0, 'ArrowDown'), -1);
        assert.strictEqual(M.kbdRadioNextIndex(3, -1, 'ArrowDown'), -1);
        assert.strictEqual(M.kbdRadioNextIndex(3, 3, 'ArrowDown'), -1);
    });

    test('kbdRovingIndex: Up/Down wrap, Home/End jump, entry from outside, other keys -1', function() {
        assert.strictEqual(M.kbdRovingIndex(4, 0, 'ArrowDown'), 1);
        assert.strictEqual(M.kbdRovingIndex(4, 3, 'ArrowDown'), 0, 'wraps to first');
        assert.strictEqual(M.kbdRovingIndex(4, 0, 'ArrowUp'), 3, 'wraps to last');
        assert.strictEqual(M.kbdRovingIndex(4, 2, 'Home'), 0);
        assert.strictEqual(M.kbdRovingIndex(4, 1, 'End'), 3);
        assert.strictEqual(M.kbdRovingIndex(4, -1, 'ArrowDown'), 0, 'enters at top');
        assert.strictEqual(M.kbdRovingIndex(4, -1, 'ArrowUp'), 3, 'enters at bottom');
        assert.strictEqual(M.kbdRovingIndex(1, 0, 'ArrowDown'), 0);
        assert.strictEqual(M.kbdRovingIndex(4, 1, 'ArrowLeft'), -1);
        assert.strictEqual(M.kbdRovingIndex(4, 1, 'Enter'), -1);
        assert.strictEqual(M.kbdRovingIndex(0, 0, 'ArrowDown'), -1);
    });

    test('kbdModalFocusPlan: open focuses inside unless focus is already there or the overlay opts out', function() {
        var p = M.kbdModalFocusPlan({ wasEmpty: true, top: { isNew: true, hasFocus: false, selfFocus: false } });
        assert.deepStrictEqual(p, { action: 'focus-inside', remember: true });
        p = M.kbdModalFocusPlan({ wasEmpty: true, top: { isNew: true, hasFocus: true, selfFocus: false } });
        assert.deepStrictEqual(p, { action: 'none', remember: true }, 'autofocused input keeps focus, opener still remembered');
        p = M.kbdModalFocusPlan({ wasEmpty: true, top: { isNew: true, hasFocus: false, selfFocus: true } });
        assert.strictEqual(p.action, 'none', 'data-kbd-self-focus overlays manage themselves');
        p = M.kbdModalFocusPlan({ wasEmpty: false, top: { isNew: true, hasFocus: false, selfFocus: false } });
        assert.deepStrictEqual(p, { action: 'focus-inside', remember: false }, 'stacked modal keeps the first opener');
    });

    test('kbdModalFocusPlan: an already-open modal only refocuses when focus really fell out', function() {
        var top = { isNew: false, hasFocus: false, selfFocus: false };
        assert.strictEqual(M.kbdModalFocusPlan({ top: top }).action, 'none', 'unrelated mutation never steals focus');
        assert.strictEqual(M.kbdModalFocusPlan({ top: top, focusLost: true }).action, 'focus-inside');
        assert.strictEqual(M.kbdModalFocusPlan({ top: top, closed: 1, focusLost: false }).action, 'none', 'stacked close with focus kept elsewhere');
        assert.strictEqual(M.kbdModalFocusPlan({ top: top, closed: 1, focusLost: true }).action, 'focus-inside', 'focus was in the stacked modal');
    });

    test('kbdFocusWasLost: body focus alone is not loss; removed/hidden/closed-overlay focus is', function() {
        var body = { tagName: 'BODY' };
        var boxes = [];
        var hasBox = function(el) { return boxes.indexOf(el) >= 0; };
        var btn = { tagName: 'BUTTON', isConnected: true };
        boxes.push(btn);
        // User clicked plain text (activeElement=body) then a snackbar appeared.
        assert.strictEqual(M.kbdFocusWasLost(body, btn, [], body, hasBox), false, 'last focused still visible');
        assert.strictEqual(M.kbdFocusWasLost(body, null, [], body, hasBox), false, 'nothing was focused');
        // Focused element was removed or hidden.
        var gone = { tagName: 'BUTTON', isConnected: false };
        assert.strictEqual(M.kbdFocusWasLost(body, gone, [], body, hasBox), true);
        assert.strictEqual(M.kbdFocusWasLost(null, gone, [], body, hasBox), true);
        var hidden = { tagName: 'BUTTON', isConnected: true };
        assert.strictEqual(M.kbdFocusWasLost(body, hidden, [], body, hasBox), true);
        // Focus inside an overlay that just closed.
        var inner = { tagName: 'BUTTON', isConnected: true };
        boxes.push(inner);
        var ov = { contains: function(el) { return el === inner; } };
        assert.strictEqual(M.kbdFocusWasLost(inner, inner, [ov], body, hasBox), true);
        assert.strictEqual(M.kbdFocusWasLost(body, inner, [ov], body, hasBox), true, 'backdrop click after focusing inside');
        // Focus on a live element elsewhere.
        assert.strictEqual(M.kbdFocusWasLost(btn, inner, [ov], body, hasBox), false);
        assert.strictEqual(M.kbdFocusWasLost(btn, btn, [], body, hasBox), false);
    });

    test('kbdApplyFilter keeps the #kbd-empty live region rendered and swaps its content', function() {
        assert.ok(/id="kbd-empty" role="status"><\/div>/.test(M.kbdModalHtml(false)), 'rendered empty, never [hidden]');
        var row = { hidden: false, getAttribute: function() { return 'copy-last'; } };
        var sec = { hidden: false, querySelectorAll: function() { return [row]; } };
        var empty = { innerHTML: '', hidden: false };
        byId['keyboard-shortcuts-modal'] = { querySelectorAll: function() { return [sec]; } };
        byId['kbd-empty'] = empty;
        assert.strictEqual(M.kbdApplyFilter('zzzz-nothing'), 0);
        assert.ok(empty.innerHTML.indexOf('No shortcuts found') >= 0, 'message announced');
        assert.strictEqual(empty.hidden, false, 'never toggles hidden');
        assert.strictEqual(row.hidden, true);
        assert.strictEqual(M.kbdApplyFilter('copy'), 1);
        assert.strictEqual(empty.innerHTML, '', 'cleared; CSS :empty hides it');
        assert.strictEqual(sec.hidden, false);
    });

    test('kbdModalFocusPlan: close restores to opener, else composer, only when focus was lost', function() {
        assert.deepStrictEqual(M.kbdModalFocusPlan({ top: null, closed: 1, focusLost: true, openerUsable: true }), { action: 'restore-opener', remember: false });
        assert.strictEqual(M.kbdModalFocusPlan({ top: null, closed: 1, focusLost: true, openerUsable: false }).action, 'restore-composer');
        assert.strictEqual(M.kbdModalFocusPlan({ top: null, closed: 1, focusLost: false, openerUsable: true }).action, 'none', 'modal restored focus itself');
        assert.strictEqual(M.kbdModalFocusPlan({ top: null, closed: 0, focusLost: true }).action, 'none', 'only opt-out overlays closed');
        assert.strictEqual(M.kbdModalFocusPlan().action, 'none');
    });

    test('kbdHandleRoving: arrows move focus between visible chat rows; modifiers pass through', function() {
        if (typeof document === 'undefined' || !document.body) return skipTest('no DOM');
        var list = document.createElement('div');
        list.id = 'chat-list';
        list.innerHTML = '<div class="chat-item" tabindex="0">a</div><div class="chat-item" tabindex="0">b</div><div class="chat-item" tabindex="0">c</div>';
        document.body.appendChild(list);
        try {
            var rows = list.querySelectorAll('.chat-item');
            // The sandbox frame has no layout or focus: fake a box so _kbdHasBox
            // counts the rows, and record focus() calls.
            var focused = null;
            Array.prototype.forEach.call(rows, function(r) {
                r.getClientRects = function() { return [{}]; };
                r.focus = function() { focused = r; };
            });
            function key(el, k, extra) {
                var ev = { key: k, target: el, defaultPrevented: false, preventDefault: function() { this.defaultPrevented = true; } };
                Object.keys(extra || {}).forEach(function(n) { ev[n] = extra[n]; });
                M.kbdHandleRoving(ev);
                return ev;
            }
            assert.ok(key(rows[0], 'ArrowDown').defaultPrevented);
            assert.strictEqual(focused, rows[1]);
            key(rows[1], 'End');
            assert.strictEqual(focused, rows[2]);
            key(rows[2], 'ArrowDown');
            assert.strictEqual(focused, rows[0], 'wraps');
            key(rows[1], 'Home');
            assert.strictEqual(focused, rows[0]);
            focused = null;
            assert.ok(!key(rows[0], 'ArrowDown', { altKey: true }).defaultPrevented, 'Alt+Down is the next-chat shortcut');
            assert.ok(!key(rows[0], 'Enter').defaultPrevented, 'Enter stays with chatItemKeydown');
            assert.strictEqual(focused, null);
        } finally { list.remove(); }
    });
});
