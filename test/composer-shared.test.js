// Shared composer (ui/246-composer.js, composer item 9) + #1218 review fixes a–f.
describe('shared composer + #1218 review fixes', function() {
    function fakeDoc(els) {
        return { body: { id: 'body' }, documentElement: {}, getElementById: function(id) { return els[id] || null; } };
    }
    function key(k, o) {
        var e = Object.assign({ key: k, shiftKey: false, isComposing: false, keyCode: 0, repeat: false, prevented: 0, stopped: 0 }, o || {});
        e.preventDefault = function() { e.prevented++; };
        e.stopPropagation = function() { e.stopped++; };
        return e;
    }
    async function composer(globals) {
        return loadModules(['src/js/ui/246-composer.js'], { lenient: true, globals: Object.assign({ window: fakeWindow(), chrome: fakeChrome() }, globals || {}) });
    }

    test('9: composerHandleKeyDown submits on plain Enter only, per composer kind', async function() {
        var calls = [];
        var m = await composer({ sendMessage: function() { calls.push('chat'); }, sendHomeMessage: function() { calls.push('home'); } });
        var e = key('Enter');
        m.composerHandleKeyDown(e, 'chat');
        assert.deepStrictEqual(calls, ['chat']);
        assert.strictEqual(e.prevented, 1);
        m.composerHandleKeyDown(key('Enter'), 'home');
        assert.deepStrictEqual(calls, ['chat', 'home']);
        m.composerHandleKeyDown(key('Enter', { shiftKey: true }), 'chat');
        m.composerHandleKeyDown(key('Enter', { isComposing: true }), 'chat');
        m.composerHandleKeyDown(key('Enter', { keyCode: 229 }), 'home');
        m.composerHandleKeyDown(key('a'), 'chat');
        m.composerHandleKeyDown(key('Enter'), 'nope');
        assert.deepStrictEqual(calls, ['chat', 'home'], 'Shift/IME/other keys/unknown kind never submit');
    }, { tags: ['unit'], timeout: 5000 });

    test('9: registerComposerKeyHandler runs first, can consume, and unregisters', async function() {
        var calls = [];
        var m = await composer({ sendMessage: function() { calls.push('send'); } });
        var off = m.registerComposerKeyHandler(function(e, kind, c) { calls.push('h:' + kind + ':' + c.inputId); return e.key === 'Enter'; });
        m.composerHandleKeyDown(key('Enter'), 'chat');
        assert.deepStrictEqual(calls, ['h:chat:message-input'], 'consumed Enter does not submit');
        off();
        m.composerHandleKeyDown(key('Enter'), 'chat');
        assert.deepStrictEqual(calls, ['h:chat:message-input', 'send']);
    }, { tags: ['unit'], timeout: 5000 });

    test('9: buildAttachmentLabel keeps the legacy wording and order', async function() {
        var m = await composer();
        assert.strictEqual(m.buildAttachmentLabel([]), '');
        assert.strictEqual(m.buildAttachmentLabel(null), '');
        assert.strictEqual(m.buildAttachmentLabel([{ fileType: 'document' }, { fileType: 'pdf' }, {}, { fileType: 'image' }, { fileType: 'file' }]),
            '[User attached 2 image(s) and 1 PDF(s) and 1 file(s) and 1 document(s)]');
    }, { tags: ['unit'], timeout: 5000 });

    test('9: syncSendButton iterates COMPOSERS; composerResetInput clears + repaints', async function() {
        var els = { 'message-input': { value: 'hi', style: { height: '80px' } }, 'send-btn': { disabled: false },
            'home-message-input': { value: '  ', style: {} }, 'home-send-btn': { disabled: false } };
        var m = await composer({ document: fakeDoc(els), pendingImageAttachments: [] });
        m.syncSendButton();
        assert.strictEqual(els['send-btn'].disabled, false);
        assert.strictEqual(els['home-send-btn'].disabled, true, 'whitespace-only home box is empty');
        m.composerResetInput(els['message-input']);
        assert.strictEqual(els['message-input'].value, '');
        assert.strictEqual(els['message-input'].style.height, 'auto');
        assert.strictEqual(els['send-btn'].disabled, true);
        assert.deepStrictEqual(Object.keys(m.COMPOSERS).sort(), ['chat', 'home']);
    }, { tags: ['unit'], timeout: 5000 });

    test('9: chat + home keydown handlers and both attach-label sites delegate to the shared helpers', async function() {
        var send = await loadFile('src/js/app/040-send-message.js');
        var home = await loadFile('src/js/ui/030-home-view.js');
        var layout = await loadFile('src/js/ui/240-layout.js');
        assert.ok(/function handleKeyDown\(e\) \{\s*composerHandleKeyDown\(e, 'chat'\);\s*\}/.test(send));
        assert.ok(/function handleHomeKeyDown\(e\) \{\s*composerHandleKeyDown\(e, 'home'\);\s*\}/.test(home));
        assert.strictEqual((send.match(/buildAttachmentLabel\(pendingImageAttachments\)/g) || []).length, 2);
        assert.strictEqual(send.indexOf("' image(s)'"), -1, 'no inline label copies left');
        assert.strictEqual((send.match(/composerResetInput\(input\)/g) || []).length, 3);
        assert.ok(home.indexOf('composerResetInput(input)') > 0);
        assert.strictEqual(layout.indexOf('function syncSendButton'), -1, 'syncSendButton lives in 246-composer.js');
    }, { tags: ['unit'], timeout: 5000 });

    test('a: paste is skipped only inside a NON-composer editable', async function() {
        var m = await loadModules(['src/js/app/050-image-attachments.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome(), document: fakeDoc({}) } });
        function el(ed) { return { id: 'x', closest: function() { return ed; } }; }
        assert.strictEqual(m._isComposerPasteTarget(null), true);
        assert.strictEqual(m._isComposerPasteTarget(el(null)), true, 'non-editable target (chip, button, bubble) routes to the composer');
        assert.strictEqual(m._isComposerPasteTarget(el({ id: 'message-input' })), true);
        assert.strictEqual(m._isComposerPasteTarget(el({ id: 'home-message-input' })), true);
        assert.strictEqual(m._isComposerPasteTarget(el({ id: 'settings-field' })), false, 'other editables keep native paste');
    }, { tags: ['unit'], timeout: 5000 });

    test('b: a held (auto-repeat) Backspace on a chip removes nothing', async function() {
        var m = await loadModules(['src/js/app/050-image-attachments.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome(), document: fakeDoc({}) } });
        var e = key('Backspace', { repeat: true, currentTarget: null });
        m.handlePendingChipKeydown(e, 0);
        assert.strictEqual(e.prevented, 1);
        assert.strictEqual(e.stopped, 0, 'returns before the removal path');
    }, { tags: ['unit'], timeout: 5000 });

    test('c: widget attachment refusal precedes the stale-injection clear', async function() {
        var send = await loadFile('src/js/app/040-send-message.js');
        var refuse = send.indexOf('if (currentEditingWidget && pendingImageAttachments.length > 0)');
        var clear = send.indexOf('    pendingInjection = null;\n    pendingInjectionImages = null;');
        assert.ok(refuse > 0 && clear > refuse, 'refusal must come first so a refused send keeps the queued injection');
    }, { tags: ['unit'], timeout: 5000 });

    test('d: ResizeObserver drops detached composers', async function() {
        var cb = null, observed = [], unobserved = [];
        function RO(fn) { cb = fn; this.observe = function(t) { observed.push(t); }; this.unobserve = function(t) { unobserved.push(t); }; }
        var m = await loadModules(['src/js/ui/240-layout.js'], { lenient: true, globals: { window: Object.assign(fakeWindow(), { matchMedia: function() { return { matches: false, addEventListener: function() {}, addListener: function() {} }; } }), chrome: fakeChrome(), ResizeObserver: RO,
            requestAnimationFrame: function() { throw new Error('no rAF for a detached element'); } } });
        var ta = { isConnected: false };
        m._observeComposerWidth(ta);
        assert.strictEqual(observed.length, 1);
        cb([{ target: ta, contentRect: { width: 10 } }]);
        assert.deepStrictEqual(unobserved, [ta]);
        m._observeComposerWidth(ta);
        assert.strictEqual(observed.length, 2, 'removed from the observed set, so it can be re-observed');
    }, { tags: ['unit'], timeout: 5000 });

    test('e + f: startup paints Send; no redundant #send-btn:disabled:hover', async function() {
        var init = await loadFile('src/js/core/120-init.js');
        assert.ok(/autoResizeTextarea\(messageInput\);\s*\}\s*\/\/[^\n]*\n[^\n]*\n\s*if \(typeof syncSendButton === 'function'\) syncSendButton\(\);/.test(init), 'unconditional syncSendButton after the draft restore');
        var css = await loadFile('src/css/06-input.css');
        assert.strictEqual(css.indexOf('#send-btn:disabled:hover'), -1);
        assert.ok(css.indexOf('#home-send-btn:disabled:hover') > 0);
        var panels = await loadFile('src/css/18-panels.css');
        assert.strictEqual(panels.indexOf('#home-send-btn {'), -1, 'home send/attach/container rules are shared in 06-input.css');
    }, { tags: ['unit'], timeout: 5000 });
});
