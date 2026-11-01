// Composer item 7 (history recall) + item 8 (large pastes, draft size) — ui/246-composer.js.
describe('composer history recall + large paste / draft size', function() {
    function fakeDoc(els, active) {
        return { body: { id: 'body' }, documentElement: {}, activeElement: active || null,
            getElementById: function(id) { return els[id] || null; }, addEventListener: function() {} };
    }
    function key(k, o) {
        var e = Object.assign({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, prevented: 0 }, o || {});
        e.preventDefault = function() { e.prevented++; };
        return e;
    }
    function ta(id, value, s, en) {
        var v = value || '';
        var el = { id: id, value: v, style: {}, selectionStart: s == null ? v.length : s, selectionEnd: en == null ? (s == null ? v.length : s) : en };
        el.setSelectionRange = function(a, b) { el.selectionStart = a; el.selectionEnd = b; };
        return el;
    }
    async function composer(globals) {
        return loadModules(['src/js/ui/246-composer.js'], { lenient: true, globals: Object.assign({ window: fakeWindow(), chrome: fakeChrome() }, globals || {}) });
    }

    // ---- item 7 ----
    test('7: composerUserHistory filters, orders newest-first, dedupes and strips notices', async function() {
        var m = await composer();
        var chat = { messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'with image' }] },
            { role: 'user', content: '[User attached 1 image(s)]' },
            { role: 'user', content: '[WIDGET MODE] edit it' },
            { role: 'user', content: 'hook says hi', isHookMessage: true },
            { role: 'user', content: 'injected only', injected: true },
            { role: 'user', content: 'NOTICE A real text', injected: true, hasUserText: true, subNotices: [{ text: 'NOTICE A' }] },
            { role: 'user', content: 'dup' },
            { role: 'user', content: 'dup' },
            { role: 'user', content: '   ' }
        ] };
        assert.deepStrictEqual(m.composerUserHistory(chat), ['dup', 'real text', 'with image', 'first']);
        assert.deepStrictEqual(m.composerUserHistory(null), []);
        assert.deepStrictEqual(m.composerUserHistory({}), []);
        var many = { messages: [] };
        for (var i = 0; i < 150; i++) many.messages.push({ role: 'user', content: 'm' + i });
        var h = m.composerUserHistory(many);
        assert.strictEqual(h.length, 100, 'capped at COMPOSER_HISTORY_MAX');
        assert.strictEqual(h[0], 'm149');
    }, { tags: ['unit'], timeout: 5000 });

    test('7: composerUserHistory uses _isRealUserRow when present', async function() {
        var m = await composer({ _isRealUserRow: function(r) { return r.role === 'user' && r.content !== 'skip'; } });
        assert.deepStrictEqual(m.composerUserHistory({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'skip' }] }), ['a']);
    }, { tags: ['unit'], timeout: 5000 });

    test('7: composerHistoryStep up/down/escape matrix with edges', async function() {
        var m = await composer();
        var E = ['new', 'mid', 'old'];
        assert.strictEqual(m.composerHistoryStep(null, 'up', [], 'd'), null, 'no entries');
        assert.deepStrictEqual(m.composerHistoryStep(null, 'up', E, 'd'), { state: { index: 0, draft: 'd' }, value: 'new' });
        assert.deepStrictEqual(m.composerHistoryStep({ index: 0, draft: 'd' }, 'up', E, 'new'), { state: { index: 1, draft: 'd' }, value: 'mid' });
        assert.strictEqual(m.composerHistoryStep({ index: 2, draft: 'd' }, 'up', E, 'old'), null, 'oldest');
        assert.strictEqual(m.composerHistoryStep(null, 'down', E, 'd'), null, 'not browsing');
        assert.deepStrictEqual(m.composerHistoryStep({ index: 2, draft: 'd' }, 'down', E, 'old'), { state: { index: 1, draft: 'd' }, value: 'mid' });
        assert.deepStrictEqual(m.composerHistoryStep({ index: 0, draft: 'd' }, 'down', E, 'new'), { state: null, value: 'd' }, 'newest restores draft');
        assert.strictEqual(m.composerHistoryStep(null, 'escape', E, 'd'), null);
        assert.deepStrictEqual(m.composerHistoryStep({ index: 1, draft: 'd' }, 'escape', E, 'mid'), { state: null, value: 'd' });
        assert.strictEqual(m.composerHistoryStep({ index: 0, draft: 'd' }, 'left', E, 'x'), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('7: composerHistoryKeyDir honours modifiers, IME, caret and selection', async function() {
        var m = await composer();
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowUp'), ta('message-input', ''), false), 'up');
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowUp'), ta('message-input', 'abc', 0), false), 'up', 'caret at 0');
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowUp'), ta('message-input', 'abc', 2), false), null, 'caret mid-text');
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowUp'), ta('message-input', 'abc', 0, 2), false), null, 'selection');
        ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].forEach(function(mod) {
            var o = {}; o[mod] = true;
            assert.strictEqual(m.composerHistoryKeyDir(key('ArrowUp', o), ta('message-input', ''), false), null, mod);
        });
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowUp', { isComposing: true }), ta('message-input', ''), false), null);
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowUp', { keyCode: 229 }), ta('message-input', ''), false), null);
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowDown'), ta('message-input', 'a\nb', 0), true), null, 'caret not on last line');
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowDown'), ta('message-input', 'a\nb', 2), true), 'down');
        assert.strictEqual(m.composerHistoryKeyDir(key('ArrowDown'), ta('message-input', 'a'), false), null, 'down only while browsing');
        assert.strictEqual(m.composerHistoryKeyDir(key('Escape'), ta('message-input', 'a'), true), 'escape');
        assert.strictEqual(m.composerHistoryKeyDir(key('Escape'), ta('message-input', 'a'), false), null);
        assert.strictEqual(m.composerHistoryKeyDir(key('Enter'), ta('message-input', ''), true), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('7: ArrowUp/Down/Escape through composerHandleKeyDown (chat only), editing ends browsing', async function() {
        var input = ta('message-input', 'draft');
        input.selectionStart = input.selectionEnd = 0;
        var home = ta('home-message-input', '');
        var els = { 'message-input': input, 'home-message-input': home };
        var doc = fakeDoc(els, input);
        var resized = 0;
        var m = await composer({ document: doc, currentChatId: 'c1', autoResizeTextarea: function() { resized++; },
            chats: { c1: { messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two\nlines' }] } } });
        var e = key('ArrowUp', { target: input });
        m.composerHandleKeyDown(e, 'chat');
        assert.strictEqual(e.prevented, 1);
        assert.strictEqual(input.value, 'two\nlines');
        assert.strictEqual(input.selectionStart, 0, 'caret at 0 for a recalled entry');
        assert.strictEqual(m.composerIsBrowsingHistory(), true);
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        assert.strictEqual(input.value, 'one');
        var stuck = key('ArrowUp', { target: input });
        m.composerHandleKeyDown(stuck, 'chat');
        assert.strictEqual(stuck.prevented, 0, 'oldest: native key');
        m.composerHandleKeyDown(key('ArrowDown', { target: input }), 'chat');
        assert.strictEqual(input.value, 'two\nlines');
        var esc = key('Escape', { target: input });
        m.composerHandleKeyDown(esc, 'chat');
        assert.strictEqual(esc.prevented, 1);
        assert.strictEqual(input.value, 'draft');
        assert.strictEqual(input.selectionStart, 5, 'caret at end for the restored draft');
        assert.strictEqual(m.composerIsBrowsingHistory(), false);
        // A value replaced from outside (no 'input' event) ends browsing.
        input.value = ''; input.selectionStart = input.selectionEnd = 0;
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        input.value = 'two\nlines!';
        assert.strictEqual(m.composerIsBrowsingHistory(), false, 'external value set ends browsing');
        // Home composer has no history.
        var he = key('ArrowUp', { target: home });
        m.composerHandleKeyDown(he, 'home');
        assert.strictEqual(he.prevented, 0);
        assert.ok(resized >= 4);
    }, { tags: ['unit'], timeout: 5000 });

    test('7: kbdCanPause yields Esc while composer history is browsing', async function() {
        var src = await loadFile('src/js/ui/320-keyboard-shortcuts.js');
        var fn = src.slice(src.indexOf('function kbdCanPause'));
        fn = fn.slice(0, fn.indexOf('\n}\n') + 2);
        assert.ok(/composerIsBrowsingHistory\(\)\) return false;/.test(fn));
        assert.ok(fn.indexOf('composerIsBrowsingHistory') < fn.indexOf("_chatControlsState(currentChatId) === 'pause'"));
    }, { tags: ['unit'], timeout: 5000 });

    // ---- #1222 review fixes ----
    function liveInput(m, value) {
        var input = ta('message-input', value);
        input.selectionStart = input.selectionEnd = 0;
        input.events = 0;
        input.dispatchEvent = function(ev) { input.events++; m.composerHistoryNoteInput(input); };
        return input;
    }
    async function liveComposer(input, extra) {
        var doc = fakeDoc({ 'message-input': input }, input);
        var g = Object.assign({ document: doc, currentChatId: 'c1', autoResizeTextarea: function() {},
            Event: function(type, o) { this.type = type; this.bubbles = o && o.bubbles; },
            chats: { c1: { messages: [{ role: 'user', content: 'old' }, { role: 'user', content: 'new' }] },
                c2: { messages: [{ role: 'user', content: 'other' }] } } }, extra || {});
        var m = await composer(g);
        return { m: m, g: g, doc: doc };
    }
    function type(m, input, v) { input.value = v; input.selectionStart = input.selectionEnd = 0; m.composerHistoryNoteInput(input); }

    test('fix1: editing a recalled entry keeps the draft for ArrowDown and Esc', async function() {
        var input = ta('message-input', 'my draft');
        var c = await liveComposer(input); var m = c.m;
        input.dispatchEvent = function() { m.composerHistoryNoteInput(input); };
        input.selectionStart = input.selectionEnd = 0;
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        assert.strictEqual(input.value, 'new');
        type(m, input, 'new EDITED');
        assert.strictEqual(m.composerIsBrowsingHistory(), true, 'edit keeps browsing');
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        assert.strictEqual(input.value, 'old');
        m.composerHandleKeyDown(key('ArrowDown', { target: input }), 'chat');
        assert.strictEqual(input.value, 'new EDITED', 'edit kept while walking');
        m.composerHandleKeyDown(key('ArrowDown', { target: input }), 'chat');
        assert.strictEqual(input.value, 'my draft', 'ArrowDown past newest restores the draft');
        assert.strictEqual(m.composerIsBrowsingHistory(), false);
        input.selectionStart = input.selectionEnd = 0;
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        type(m, input, 'changed');
        var esc = key('Escape', { target: input });
        m.composerHandleKeyDown(esc, 'chat');
        assert.strictEqual(esc.prevented, 1);
        assert.strictEqual(input.value, 'my draft', 'Esc after an edit restores the draft');
    }, { tags: ['unit'], timeout: 5000 });

    test('fix1: browsing state is per chat, like chatPendingTexts', async function() {
        var input = ta('message-input', 'draft A');
        var c = await liveComposer(input); var m = c.m;
        input.dispatchEvent = function() { m.composerHistoryNoteInput(input); };
        input.selectionStart = input.selectionEnd = 0;
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        assert.strictEqual(input.value, 'new');
        var states = m._composerHistoryStates;
        assert.deepStrictEqual(Object.keys(states), ['chat:c1'], 'state keyed by composer + chat');
        // Another chat's state is never consulted for c1.
        states['chat:c2'] = { index: 0, draft: 'B', entries: ['x'], edits: {}, shown: 'new' };
        // Switch away + back: savePendingTextForContext(c1) stores the recalled
        // text, restorePendingTextForContext(c1) puts it back (no input event).
        var pendingA = input.value;
        input.value = '';
        input.value = pendingA;
        assert.strictEqual(m.composerIsBrowsingHistory(), true, 'c1 resumes browsing');
        assert.strictEqual(states['chat:c1'].draft, 'draft A');
        m.composerHandleKeyDown(key('Escape', { target: input }), 'chat');
        assert.strictEqual(input.value, 'draft A', 'draft survives the chat switch');
    }, { tags: ['unit'], timeout: 5000 });

    test('fix2: recall fires input (execCommand when focused, else composerInsertText)', async function() {
        var input = liveInput(null, 'd');
        var c = await liveComposer(input); var m = c.m;
        input.dispatchEvent = function(ev) { input.events++; m.composerHistoryNoteInput(input); };
        input.selectionStart = input.selectionEnd = 0;
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        assert.strictEqual(input.value, 'new');
        assert.strictEqual(input.events, 1, 'input fired for the recall');
        assert.strictEqual(m.composerIsBrowsingHistory(), true, 'own input event is not an edit');
        m.composerHandleKeyDown(key('Escape', { target: input }), 'chat');
        assert.strictEqual(input.events, 2, 'input fired for the restore');
        // Undoable path: document.execCommand('insertText').
        var cmds = [];
        c.doc.execCommand = function(cmd, ui, v) { cmds.push(cmd); input.value = v || ''; m.composerHistoryNoteInput(input); return true; };
        input.select = function() {};
        input.selectionStart = input.selectionEnd = 0;
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        assert.deepStrictEqual(cmds, ['insertText']);
        assert.strictEqual(input.value, 'new');
        assert.strictEqual(input.events, 2, 'no extra synthetic event');
        assert.strictEqual(m.composerIsBrowsingHistory(), true);
    }, { tags: ['unit'], timeout: 5000 });

    test('nit: Esc while browsing -> kbdCanPause false; otherwise pause', async function() {
        var input = ta('message-input', '');
        var c = await liveComposer(input); var m = c.m;
        input.dispatchEvent = function() { m.composerHistoryNoteInput(input); };
        var src = await loadFile('src/js/ui/320-keyboard-shortcuts.js');
        var fn = src.slice(src.indexOf('function kbdCanPause'));
        fn = fn.slice(0, fn.indexOf('\n}\n') + 2);
        var canPause = new Function('togglePause', '_chatControlsState', 'currentChatId', 'kbdOverlayOpen', 'kbdMenuOpen',
            'composerIsBrowsingHistory', 'document', 'kbdIsTextField', fn + '\nreturn kbdCanPause();');
        function run() { return canPause(function() {}, function() { return 'pause'; }, 'c1', function() { return false; },
            function() { return false; }, m.composerIsBrowsingHistory, c.doc, function() { return true; }); }
        assert.strictEqual(run(), true, 'idle composer: Esc pauses');
        m.composerHandleKeyDown(key('ArrowUp', { target: input }), 'chat');
        assert.strictEqual(run(), false, 'browsing: Esc goes to the composer');
        m.composerHandleKeyDown(key('Escape', { target: input }), 'chat');
        assert.strictEqual(run(), true, 'after restore: Esc pauses again');
    }, { tags: ['unit'], timeout: 5000 });

    test('fix: Send buttons start disabled in markup; no transition into :disabled', async function() {
        var body = await loadFile('src/html/body.html');
        assert.ok(/<button id="send-btn" disabled[ >]/.test(body), 'body #send-btn');
        assert.ok(/<button id="home-send-btn" disabled[ >]/.test(body), 'body #home-send-btn');
        var home = await loadFile('src/js/ui/030-home-view.js');
        assert.ok(home.indexOf('<button id="home-send-btn" disabled ') > 0, '030 #home-send-btn');
        var css = await loadFile('src/css/06-input.css');
        assert.ok(/#send-btn:disabled[^{]*\{[^}]*transition: none;/.test(css));
        // A restored draft enables Send right after the sync.
        var btn = { disabled: true }, inp = { value: 'restored' };
        var m = await composer({ document: fakeDoc({ 'send-btn': btn, 'message-input': inp }) });
        m.syncSendButton();
        assert.strictEqual(btn.disabled, false);
        inp.value = '';
        m.syncSendButton();
        assert.strictEqual(btn.disabled, true);
    }, { tags: ['unit'], timeout: 5000 });

    // ---- item 8 ----
    test('8: composerShouldOfferPasteAsFile boundary', async function() {
        var m = await composer();
        assert.strictEqual(m.composerShouldOfferPasteAsFile('x'.repeat(20000)), false);
        assert.strictEqual(m.composerShouldOfferPasteAsFile('x'.repeat(20001)), true);
        assert.strictEqual(m.composerShouldOfferPasteAsFile(''), false);
        assert.strictEqual(m.composerShouldOfferPasteAsFile(null), false);
        assert.strictEqual(m.composerShouldOfferPasteAsFile(30000), false);
    }, { tags: ['unit'], timeout: 5000 });

    test('8: draft hint threshold, painting and debounced context refresh', async function() {
        var hint = { textContent: '', hidden: true };
        var input = ta('message-input', 'x'.repeat(2000));
        var ctx = 0;
        var m = await composer({ document: fakeDoc({ 'message-input': input, 'message-draft-hint': hint }),
            t: function(k, v) { return k.replace(/\{(\w+)\}/g, function(_, n) { return v[n]; }); },
            updateContextIndicator: function() { ctx++; } });
        assert.strictEqual(m.composerDraftHintText('x'.repeat(2000)), '');
        assert.ok(/^2.?001 characters · ~501 tokens$/.test(m.composerDraftHintText('x'.repeat(2001))));
        assert.strictEqual(m.composerDraftTokens('abcde'), 2);
        m.composerSyncDraftSize(input);
        assert.strictEqual(hint.hidden, true);
        input.value = 'x'.repeat(4000);
        m.composerSyncDraftSize(input);
        m.composerSyncDraftSize(input);
        assert.strictEqual(hint.hidden, false);
        assert.ok(hint.textContent.indexOf('characters') > 0);
        await new Promise(function(r) { setTimeout(r, 250); });
        assert.strictEqual(ctx, 1, 'debounced to one refresh');
        assert.strictEqual(m.composerKindForInput({ id: 'home-message-input' }), 'home');
        assert.strictEqual(m.composerKindForInput({ id: 'other' }), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('8: composerInsertText replaces the range and fires input', async function() {
        var m = await composer({ Event: function(type, o) { this.type = type; this.bubbles = o && o.bubbles; } });
        var input = ta('message-input', 'hello world');
        var fired = [];
        input.dispatchEvent = function(ev) { fired.push(ev.type + ':' + ev.bubbles); };
        m.composerInsertText(input, 'BIG', 6, 11);
        assert.strictEqual(input.value, 'hello BIG');
        assert.strictEqual(input.selectionStart, 9);
        assert.deepStrictEqual(fired, ['input:true']);
    }, { tags: ['unit'], timeout: 5000 });

    test('8: composerOfferPasteAsFile routes the modal choice', async function() {
        var choice = 'file', files = [], modalArgs = null;
        function F(parts, name, o) { this.parts = parts; this.name = name; this.type = o.type; }
        var m = await composer({ File: F, t: function(k) { return k; }, escapeHtml: function(s) { return s; },
            showModal: function(a, b, c) { modalArgs = c; return Promise.resolve(choice); },
            processImageFile: function(f) { files.push(f); },
            Event: function(type) { this.type = type; } });
        var input = ta('message-input', 'ab', 1); input.focus = function() {}; input.dispatchEvent = function() {};
        await m.composerOfferPasteAsFile(input, 'TEXT');
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].name, 'pasted-text.txt');
        assert.strictEqual(files[0].type, 'text/plain');
        assert.deepStrictEqual(modalArgs.map(function(b) { return b.value; }), ['cancel', 'text', 'file']);
        assert.strictEqual(input.value, 'ab', 'file choice leaves the text untouched');
        choice = 'text';
        await m.composerOfferPasteAsFile(input, 'TEXT');
        assert.strictEqual(input.value, 'aTEXTb');
        choice = null;
        await m.composerOfferPasteAsFile(input, 'ZZZ');
        assert.strictEqual(input.value, 'aTEXTb', 'Esc/cancel does nothing');
        assert.strictEqual(files.length, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('8: 050 paste handler offers large composer pastes only', async function() {
        var offered = [];
        var m = await loadModules(['src/js/app/050-image-attachments.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome(), document: fakeDoc({}),
            composerShouldOfferPasteAsFile: function(t) { return typeof t === 'string' && t.length > 5; },
            composerOfferPasteAsFile: function(el, t) { offered.push(el.id + ':' + t); } } });
        function paste(id, text) {
            var area = { id: id };
            var e = { target: { closest: function(sel) { return area; } }, prevented: 0,
                clipboardData: { items: [{ type: 'text/plain' }], getData: function() { return text; } } };
            e.preventDefault = function() { e.prevented++; };
            m.handlePasteForImages(e);
            return e.prevented;
        }
        assert.strictEqual(paste('message-input', 'long text'), 1);
        assert.strictEqual(paste('home-message-input', 'long text'), 1);
        assert.strictEqual(paste('message-input', 'tiny'), 0, 'small paste stays native');
        assert.strictEqual(paste('settings-field', 'long text'), 0, 'other editables untouched');
        assert.deepStrictEqual(offered, ['message-input:long text', 'home-message-input:long text']);
    }, { tags: ['unit'], timeout: 5000 });

    test('fix3: large paste with an image still attaches the image and offers the text', async function() {
        var offered = [], files = [];
        var m = await loadModules(['src/js/app/050-image-attachments.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome(), document: fakeDoc({}),
            composerShouldOfferPasteAsFile: function(t) { return typeof t === 'string' && t.length > 5; },
            composerOfferPasteAsFile: function(el, t) { offered.push(el.id + ':' + t); } } });
        m.processImageFile = function(f) { files.push(f); };
        try { processImageFile = m.processImageFile; } catch (e) {}
        function paste(text) {
            var area = { id: 'message-input' };
            var e = { target: { closest: function() { return area; } }, prevented: 0,
                clipboardData: { items: [{ type: 'image/png', getAsFile: function() { return { name: 'img.png' }; } }, { type: 'text/plain' }],
                    getData: function() { return text; } } };
            e.preventDefault = function() { e.prevented++; };
            m.handlePasteForImages(e);
            return e.prevented;
        }
        assert.strictEqual(paste('long text'), 1, 'large text with image: offered');
        assert.strictEqual(paste('tiny'), 0, 'small text with image: native text paste');
        assert.deepStrictEqual(offered, ['message-input:long text']);
    }, { tags: ['unit'], timeout: 5000 });

    test('8 + nits: wiring in 240/body/030/CSS and #1220 nits', async function() {
        var layout = await loadFile('src/js/ui/240-layout.js');
        assert.ok(/syncSendButton\(\);\s*\n\s*\/\/[^\n]*\n\s*if \(typeof composerSyncDraftSize === 'function'\) composerSyncDraftSize\(textarea\);/.test(layout));
        assert.ok(layout.indexOf("incl. ~{draft} in draft") > 0);
        assert.ok(layout.indexOf('if (_composerObserved) _composerObserved.delete(el);') > 0);
        var body = await loadFile('src/html/body.html');
        assert.ok(body.indexOf('id="message-draft-hint"') > 0);
        assert.strictEqual(body.indexOf('autoResizeTextarea(this); updateContextIndicator();'), -1);
        var home = await loadFile('src/js/ui/030-home-view.js');
        assert.ok(home.indexOf('id="home-draft-hint"') > 0);
        assert.strictEqual(home.indexOf('ui/245-composer.js'), -1);
        var send = await loadFile('src/js/app/040-send-message.js');
        assert.strictEqual(send.indexOf('ui/245-composer.js'), -1);
        var css = await loadFile('src/css/06-input.css');
        assert.ok(css.indexOf('.composer-draft-hint {') > 0);
        var comp = await loadFile('src/js/ui/246-composer.js');
        assert.ok(/console\.warn\('\[composer\] key handler failed:'/.test(comp));
    }, { tags: ['unit'], timeout: 5000 });

    test('nit: a throwing key handler is logged, not fatal', async function() {
        var warned = [];
        var sent = 0;
        var m = await composer({ console: { warn: function() { warned.push(arguments[0]); }, log: function() {}, error: function() {} },
            sendMessage: function() { sent++; } });
        m.registerComposerKeyHandler(function() { throw new Error('boom'); });
        m.composerHandleKeyDown(key('Enter'), 'chat');
        assert.strictEqual(sent, 1);
        assert.strictEqual(warned.length, 1);
    }, { tags: ['unit'], timeout: 5000 });
});
