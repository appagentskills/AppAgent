// End-to-end keydown wiring for the shared composer: the textarea markup ->
// handleKeyDown (app/040) / handleHomeKeyDown (ui/030) -> composerHandleKeyDown
// (ui/246) -> registered key handlers (history recall).
//
// Regression guard for the "ArrowUp/ArrowDown history recall does nothing"
// report: the deployed build carried a stale 040-send-message.js whose
// handleKeyDown still had the pre-#1220 inline Enter logic, so no registered
// composer handler (history, later the picker) ever ran in the chat composer.
// These tests drive the REAL delegate functions from the source files, so any
// copy of 040/030 that stops delegating fails here.
describe('composer keydown wiring (markup -> delegate -> registered handlers)', function() {
    function key(k, o) {
        var e = Object.assign({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
            isComposing: false, keyCode: 0, prevented: 0 }, o || {});
        e.preventDefault = function() { e.prevented++; };
        return e;
    }
    function ta(id, value) {
        var v = value || '';
        var el = { id: id, value: v, style: {}, selectionStart: v.length, selectionEnd: v.length };
        el.setSelectionRange = function(a, b) { el.selectionStart = a; el.selectionEnd = b; };
        el.dispatchEvent = function() {};
        return el;
    }
    // Extract one top-level `function name(...) { ... }` declaration.
    function extractFn(src, name) {
        var start = src.indexOf('function ' + name + '(');
        assert.ok(start !== -1, name + ' declared');
        var end = src.indexOf('\n}\n', start);
        assert.ok(end !== -1, name + ' closed');
        return src.slice(start, end + 2);
    }
    async function setup(messages) {
        var input = ta('message-input', '');
        var home = ta('home-message-input', '');
        var els = { 'message-input': input, 'home-message-input': home };
        var doc = { body: {}, documentElement: {}, activeElement: null,
            getElementById: function(id) { return els[id] || null; }, addEventListener: function() {} };
        var sent = { chat: 0, home: 0 };
        var m = await loadModules(['src/js/ui/246-composer.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), document: doc, currentChatId: 'c1',
            autoResizeTextarea: function() {},
            Event: function(type, o) { this.type = type; this.bubbles = o && o.bubbles; },
            sendMessage: function() { sent.chat++; }, sendHomeMessage: function() { sent.home++; },
            chats: { c1: { messages: messages || [{ role: 'user', content: 'older' }, { role: 'assistant', content: 'r' }, { role: 'user', content: 'newest' }] } }
        } });
        var src040 = await loadFile('src/js/app/040-send-message.js');
        var src030 = await loadFile('src/js/ui/030-home-view.js');
        var handleKeyDown = new Function('composerHandleKeyDown', extractFn(src040, 'handleKeyDown') + '\nreturn handleKeyDown;')(m.composerHandleKeyDown);
        var handleHomeKeyDown = new Function('composerHandleKeyDown', extractFn(src030, 'handleHomeKeyDown') + '\nreturn handleHomeKeyDown;')(m.composerHandleKeyDown);
        return { m: m, input: input, home: home, sent: sent, handleKeyDown: handleKeyDown, handleHomeKeyDown: handleHomeKeyDown };
    }

    test('markup routes composer keydown to the delegates', async function() {
        var body = await loadFile('src/html/body.html');
        assert.match(body, /<textarea id="message-input"[^>]*onkeydown="handleKeyDown\(event\)"/);
        var home = await loadFile('src/js/ui/030-home-view.js');
        assert.match(home, /id="home-message-input"[^>]*onkeydown="handleHomeKeyDown\(event\)"/);
    }, { tags: ['unit'], timeout: 5000 });

    test('ArrowUp/ArrowDown/Esc through the real handleKeyDown recall and restore', async function() {
        var s = await setup();
        var up = key('ArrowUp', { target: s.input });
        s.handleKeyDown(up);
        assert.strictEqual(up.prevented, 1, 'ArrowUp consumed');
        assert.strictEqual(s.input.value, 'newest');
        s.handleKeyDown(key('ArrowUp', { target: s.input }));
        assert.strictEqual(s.input.value, 'older');
        s.handleKeyDown(key('ArrowDown', { target: s.input }));
        assert.strictEqual(s.input.value, 'newest');
        var esc = key('Escape', { target: s.input });
        s.handleKeyDown(esc);
        assert.strictEqual(esc.prevented, 1);
        assert.strictEqual(s.input.value, '', 'draft restored');
        assert.strictEqual(s.sent.chat, 0, 'arrows never submit');
    }, { tags: ['unit'], timeout: 5000 });

    test('Enter still submits through the delegates; registered handlers see both kinds', async function() {
        var s = await setup();
        var seen = [];
        var off = s.m.registerComposerKeyHandler(function(e, kind) { seen.push(kind + ':' + e.key); return false; });
        s.input.value = 'hi';
        var enter = key('Enter', { target: s.input });
        s.handleKeyDown(enter);
        assert.strictEqual(enter.prevented, 1);
        assert.strictEqual(s.sent.chat, 1);
        s.handleHomeKeyDown(key('Enter', { target: s.home }));
        assert.strictEqual(s.sent.home, 1);
        s.handleHomeKeyDown(key('x', { target: s.home }));
        assert.deepStrictEqual(seen, ['chat:Enter', 'home:Enter', 'home:x']);
        off();
    }, { tags: ['unit'], timeout: 5000 });

    test('widget-mode wrapper rows are skipped whatever their capitalisation', async function() {
        var s = await setup([{ role: 'user', content: 'real' }, { role: 'user', content: '[Widget mode] You are editing' },
            { role: 'user', content: '[WIDGET MODE] You are editing' }]);
        assert.deepStrictEqual(s.m.composerUserHistory({ messages: [{ role: 'user', content: 'real' },
            { role: 'user', content: '[Widget mode] x' }, { role: 'user', content: '[WIDGET MODE] y' }] }), ['real']);
        s.handleKeyDown(key('ArrowUp', { target: s.input }));
        assert.strictEqual(s.input.value, 'real');
    }, { tags: ['unit'], timeout: 5000 });
});
