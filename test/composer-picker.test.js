// Composer items 10 (picker) and 11 (Send -> Stop), driven through the REAL
// handleKeyDown (app/040) / handleHomeKeyDown (ui/030) delegates and the real
// ui/246 + ui/247 sources, with stub globals and a small fake DOM.
var EX = await runFile('test/extract.js', { i18n: false });
describe('composer picker (item 10) through the real keydown delegates', function() {
    var ICONS = { skill: '<svg>SK</svg>', compose: '<svg>DOC</svg>', chat: '<svg>CH</svg>', image: '<svg>IMG</svg>',
        pdf: '<svg>PDF</svg>', file: '<svg>FILE</svg>', code: '<svg>CODE</svg>', send: '<svg>SEND</svg>', stop: '<svg>STOP</svg>' };

    function key(k, o) {
        var e = Object.assign({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
            isComposing: false, keyCode: 0, prevented: 0 }, o || {});
        e.preventDefault = function() { e.prevented++; };
        return e;
    }
    function extractFn(src, name) {
        var f = EX.findFunction(src, name, { includeAsync: false });
        assert.ok(f, name + ' declared');
        assert.ok(f.end > f.start, name + ' closed');
        return src.slice(f.start, f.end);
    }
    function makeDom() {
        var els = {}, docL = {};
        function el(id) {
            var attrs = {}, set = {};
            var e = { id: id || '', style: {}, attrs: attrs, hidden: false, innerHTML: '', children: [], listeners: {}, disabled: false,
                classList: { add: function(c) { set[c] = 1; }, remove: function(c) { delete set[c]; }, contains: function(c) { return !!set[c]; } },
                setAttribute: function(k, v) { attrs[k] = String(v); },
                getAttribute: function(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
                removeAttribute: function(k) { delete attrs[k]; },
                addEventListener: function(t, f) { (e.listeners[t] = e.listeners[t] || []).push(f); },
                appendChild: function(c) { e.children.push(c); if (c.id) els[c.id] = c; return c; } };
            if (id) els[id] = e;
            return e;
        }
        function textarea(id, host) {
            var t = el(id);
            t.value = ''; t.selectionStart = 0; t.selectionEnd = 0; t.parentElement = host;
            t.setSelectionRange = function(a, b) { t.selectionStart = a; t.selectionEnd = b; };
            t.focus = function() {};
            t.dispatchEvent = function(ev) { ev.target = t; fire(ev.type, ev); return true; };
            return t;
        }
        function fire(type, ev) { (docL[type] || []).slice().forEach(function(f) { f(ev); }); }
        var doc = { body: {}, documentElement: {}, activeElement: null,
            getElementById: function(id) { return els[id] || null; },
            createElement: function() { return el(''); },
            addEventListener: function(t, f) { (docL[t] = docL[t] || []).push(f); } };
        var chatHost = el('chat-host'), homeHost = el('home-host');
        return { doc: doc, els: els, docL: docL, fire: fire, el: el,
            input: textarea('message-input', chatHost), home: textarea('home-message-input', homeHost) };
    }

    async function setup(extra) {
        var dom = makeDom();
        var sent = { chat: 0, home: 0 };
        var ctl = { active: false, state: 'pause', toggles: 0 };
        var globals = Object.assign({
            window: fakeWindow(), chrome: fakeChrome(), document: dom.doc, currentChatId: 'c1',
            autoResizeTextarea: function() {},
            Event: function(type, o) { this.type = type; this.bubbles = o && o.bubbles; },
            sendMessage: function() { sent.chat++; }, sendHomeMessage: function() { sent.home++; },
            UI_ICONS: ICONS,
            skills: { alpha: { name: 'Alpha', description: 'First skill' }, beta: { name: 'Beta', description: 'Inactive' },
                gamma: { name: 'Gamma', description: 'Third skill' } },
            activeSkills: { alpha: true, beta: false, gamma: true },
            smartDocuments: {
                doc_1: { id: 'doc_1', title: 'Spec', updatedAt: 5 },
                doc_2: { id: 'doc_2', title: 'Other private', scope: 'chat', ownerChatId: 'c9', updatedAt: 9 },
                doc_3: { id: 'doc_3', title: 'Mine', scope: 'chat', ownerChatId: 'c1', updatedAt: 7 } },
            chats: {
                c1: { id: 'c1', title: 'Current', updatedAt: 100, messages: [
                    { role: 'user', content: 'older' },
                    { role: 'screenshot', file_id: 'file_img1', name: 'shot.png', description: 'User attached image shot.png' },
                    { role: 'user', content: 'newest' }] },
                c2: { id: 'c2', title: 'Earlier chat', updatedAt: 50 },
                c3: { id: 'c3', title: 'Worker', updatedAt: 60, isSubAgent: true },
                c4: { id: 'c4', title: 'Child', updatedAt: 70, parentChatId: 'c2' },
                c5: { id: 'c5', title: 'Oldest chat', createdAt: 10 } },
            lfListDir: function() {
                return Promise.resolve({ entries: [
                    { kind: 'file', name: 'a b.txt', path: 'dir/a b.txt', lastModified: 3 },
                    { kind: 'file', name: 'notes.md', path: 'notes.md', lastModified: 2 },
                    { kind: 'dir', name: 'dir', path: 'dir' }] });
            },
            sdocFileIcon: function(f) { return '<svg>F:' + f.name + '</svg>'; },
            sdocFileTypeInfo: function() { return { label: 'File' }; },
            sdocTimeAgo: function() { return '1h'; },
            _isChatLoopActive: function() { return ctl.active; },
            _chatControlsState: function() { return ctl.state; },
            togglePause: function() { ctl.toggles++; ctl.state = 'resume'; }
        }, extra || {});
        var m = await loadModules(['src/js/ui/246-composer.js', 'src/js/ui/247-composer-picker.js'], { lenient: true, globals: globals });
        var src040 = await loadFile('src/js/app/040-send-message.js');
        var src030 = await loadFile('src/js/ui/030-home-view.js');
        var handleKeyDown = new Function('composerHandleKeyDown', extractFn(src040, 'handleKeyDown') + '\nreturn handleKeyDown;')(m.composerHandleKeyDown);
        var handleHomeKeyDown = new Function('composerHandleKeyDown', extractFn(src030, 'handleHomeKeyDown') + '\nreturn handleHomeKeyDown;')(m.composerHandleKeyDown);
        return { m: m, dom: dom, input: dom.input, home: dom.home, sent: sent, ctl: ctl,
            handleKeyDown: handleKeyDown, handleHomeKeyDown: handleHomeKeyDown };
    }
    // Type text: value + caret at end, then the 'input' event the browser fires.
    function type(s, input, text) {
        input.value = text;
        input.selectionStart = input.selectionEnd = text.length;
        s.dom.fire('input', { type: 'input', target: input });
    }
    async function flush() { for (var i = 0; i < 20; i++) await Promise.resolve(); }
    function popup(s, input) { return s.dom.els[input.id + '-picker'] || null; }
    function optionTypes(html) { var out = [], re = /data-picker-type="([^"]+)"/g, x; while ((x = re.exec(html))) out.push(x[1]); return out; }

    test('/ lists only active skills; Arrow keys move the picker, not history', async function() {
        var s = await setup();
        type(s, s.input, '/');
        assert.ok(s.m.composerPickerIsOpen(), 'picker opened');
        var items = s.m.composerPickerItems('skills', '', 'chat');
        assert.deepStrictEqual(items.map(function(i) { return i.insert; }), ['/alpha ', '/gamma '], 'inactive beta excluded');
        var pop = popup(s, s.input);
        assert.ok(pop && !pop.hidden, 'listbox visible');
        assert.strictEqual(pop.getAttribute('role'), 'listbox');
        assert.strictEqual(s.input.getAttribute('aria-expanded'), 'true');
        assert.strictEqual(s.input.getAttribute('aria-controls'), 'message-input-picker');
        // Option ids are per item (type + id), stable across re-ranking.
        assert.strictEqual(s.input.getAttribute('aria-activedescendant'), 'message-input-picker-opt-skill-alpha');

        var down = key('ArrowDown', { target: s.input });
        s.handleKeyDown(down);
        assert.strictEqual(down.prevented, 1, 'ArrowDown consumed');
        assert.strictEqual(s.input.value, '/', 'no history recall on ArrowDown');
        assert.strictEqual(s.input.getAttribute('aria-activedescendant'), 'message-input-picker-opt-skill-gamma');
        assert.match(pop.innerHTML, /id="message-input-picker-opt-skill-gamma"[^>]*aria-selected="true"/);

        var up = key('ArrowUp', { target: s.input });
        s.handleKeyDown(up);
        assert.strictEqual(up.prevented, 1, 'ArrowUp consumed');
        assert.strictEqual(s.input.value, '/', 'no history recall on ArrowUp');
        assert.strictEqual(s.input.getAttribute('aria-activedescendant'), 'message-input-picker-opt-skill-alpha');
        s.handleKeyDown(key('ArrowUp', { target: s.input }));
        assert.strictEqual(s.input.getAttribute('aria-activedescendant'), 'message-input-picker-opt-skill-gamma', 'wraps to last');
        assert.strictEqual(s.sent.chat, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('Enter and Tab insert the active item instead of submitting', async function() {
        var s = await setup();
        type(s, s.input, 'use /gam');
        var enter = key('Enter', { target: s.input });
        s.handleKeyDown(enter);
        assert.strictEqual(enter.prevented, 1);
        assert.strictEqual(s.sent.chat, 0, 'Enter did not submit');
        assert.strictEqual(s.input.value, 'use /gamma ');
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'closed after insert');
        assert.strictEqual(s.input.getAttribute('aria-expanded'), 'false');
        assert.strictEqual(s.input.getAttribute('aria-activedescendant'), null);

        type(s, s.input, 'use /gamma /al');
        var tab = key('Tab', { target: s.input });
        s.handleKeyDown(tab);
        assert.strictEqual(tab.prevented, 1);
        assert.strictEqual(s.input.value, 'use /gamma /alpha ');
        // Picker closed: Enter submits again.
        s.handleKeyDown(key('Enter', { target: s.input }));
        assert.strictEqual(s.sent.chat, 1, 'Enter submits once the picker is closed');
    }, { tags: ['unit'], timeout: 5000 });

    test('Home composer: picker works through handleHomeKeyDown without sending', async function() {
        var s = await setup();
        type(s, s.home, '/');
        assert.ok(s.m.composerPickerIsOpen());
        assert.strictEqual(s.home.getAttribute('aria-activedescendant'), 'home-message-input-picker-opt-skill-alpha');
        s.handleHomeKeyDown(key('ArrowDown', { target: s.home }));
        s.handleHomeKeyDown(key('Enter', { target: s.home }));
        assert.strictEqual(s.sent.home, 0, 'Enter did not submit the Home composer');
        assert.strictEqual(s.home.value, '/gamma ');
    }, { tags: ['unit'], timeout: 5000 });

    test('Esc closes the picker without restoring the history draft', async function() {
        var s = await setup();
        s.handleKeyDown(key('ArrowUp', { target: s.input }));
        assert.strictEqual(s.input.value, 'newest', 'history recalled');
        type(s, s.input, 'newest /');
        assert.ok(s.m.composerPickerIsOpen());
        var esc = key('Escape', { target: s.input });
        s.handleKeyDown(esc);
        assert.strictEqual(esc.prevented, 1);
        assert.strictEqual(s.m.composerPickerIsOpen(), false);
        assert.strictEqual(s.input.value, 'newest /', 'draft NOT restored by the picker Esc');
        assert.strictEqual(s.input.getAttribute('aria-expanded'), 'false');
        assert.strictEqual(popup(s, s.input).hidden, true);
        // Dismissed for this word: further typing keeps it closed.
        type(s, s.input, 'newest /al');
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'stays dismissed for the word');
        // Second Esc now belongs to history recall: draft restored.
        s.handleKeyDown(key('Escape', { target: s.input }));
        assert.strictEqual(s.input.value, '', 'history Esc restores the draft');
    }, { tags: ['unit'], timeout: 5000 });

    test('@ sources: formats, quoted paths, chat filtering, private docs', async function() {
        var s = await setup();
        type(s, s.input, '@');
        await flush(); // Agent Files listing lands asynchronously, then re-syncs.
        var items = s.m.composerPickerItems('refs', '', 'chat');
        var ins = items.map(function(i) { return i.type + ' ' + i.insert; });
        // Empty query: one list merged by recency (100, 50, 10, 7, 5, 3, 2).
        assert.deepStrictEqual(ins, [
            'attachment @file_img1 ',
            'chat @chat:c2 ', 'chat @chat:c5 ',
            'doc @doc_3 ', 'doc @doc_1 ',
            'file @virtual:"dir/a b.txt" ', 'file @virtual:notes.md '
        ]);
        assert.strictEqual(s.m.composerPickerFileRef('x/"q".md'), '@virtual:"x/\\"q\\".md"', 'quotes escaped');
        // Rendered rows match the items, in rank order.
        var pop = popup(s, s.input);
        assert.deepStrictEqual(optionTypes(pop.innerHTML), ['attachment', 'chat', 'chat', 'doc', 'doc', 'file', 'file']);
        // Home composer has no current-chat attachments or private docs.
        var homeIns = s.m.composerPickerItems('refs', '', 'home').map(function(i) { return i.insert; });
        assert.ok(homeIns.indexOf('@file_img1 ') === -1 && homeIns.indexOf('@doc_3 ') === -1, 'no chat-scoped refs on Home');
        // Accept a path with a space through the real keydown path.
        type(s, s.input, 'see @dir');
        s.handleKeyDown(key('Enter', { target: s.input }));
        assert.strictEqual(s.input.value, 'see @virtual:"dir/a b.txt" ');
        assert.strictEqual(s.sent.chat, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('every rendered row has a non-empty type icon', async function() {
        var s = await setup();
        type(s, s.input, '@');
        await flush();
        var html = popup(s, s.input).innerHTML;
        var rows = (html.match(/role="option"/g) || []).length;
        var icons = html.match(/<span class="composer-picker-icon[^"]*" aria-hidden="true">([^<]|<(?!\/span>))+<\/span>/g) || [];
        assert.ok(rows >= 7, 'rows rendered: ' + rows);
        assert.strictEqual(icons.length, rows, 'one non-empty icon per row');
        type(s, s.input, '/');
        html = popup(s, s.input).innerHTML;
        rows = (html.match(/role="option"/g) || []).length;
        assert.strictEqual(rows, 2);
        assert.strictEqual((html.match(/<svg>SK<\/svg>/g) || []).length, 2, 'skill icon on each skill row');
    }, { tags: ['unit'], timeout: 5000 });

    test('chats: per-type cap then fill to 30, newest first, current + sub-agent chats excluded, all searchable', async function() {
        var many = { cur: { id: 'cur', title: 'Me', updatedAt: 999 } };
        for (var i = 0; i < 30; i++) many['k' + i] = { id: 'k' + i, title: 'Chat ' + i, updatedAt: i };
        many.sub = { id: 'sub', title: 'Sub', updatedAt: 500, isSubAgent: true };
        var s = await setup({ chats: many, currentChatId: 'cur', smartDocuments: {}, lfListDir: undefined });
        var chatsOut = s.m.composerPickerItems('refs', '', 'chat').filter(function(i) { return i.type === 'chat'; });
        // Only chats match: 12 per type, then the free rows are filled (max 30).
        assert.strictEqual(chatsOut.length, 30);
        assert.strictEqual(chatsOut[0].insert, '@chat:k29 ');
        assert.strictEqual(chatsOut[29].insert, '@chat:k0 ');
        var ids = chatsOut.map(function(i) { return i.id; });
        assert.ok(ids.indexOf('cur') === -1 && ids.indexOf('sub') === -1, 'current + sub-agent excluded');
        assert.strictEqual(chatsOut[0].id, 'k29', 'raw chat id');
        assert.strictEqual(chatsOut[0].key, 'chat:k29', 'type-prefixed key');
        // Search covers every chat, not a recency window: exact word first.
        var nine = s.m.composerPickerItems('refs', 'chat 9', 'chat');
        assert.deepStrictEqual(nine.slice(0, 3).map(function(i) { return i.id; }), ['k9', 'k29', 'k19']);
        // A mixed pool caps each type at 12 when others compete.
        var docs = {};
        for (var d = 0; d < 30; d++) docs['d' + d] = { id: 'd' + d, title: 'Doc ' + d, updatedAt: 100 + d };
        var s2 = await setup({ chats: many, currentChatId: 'cur', smartDocuments: docs, lfListDir: undefined });
        var mixed = s2.m.composerPickerItems('refs', '', 'chat');
        assert.strictEqual(mixed.length, 30);
        var nDocs = mixed.filter(function(i) { return i.type === 'doc'; }).length;
        assert.ok(nDocs >= 12 && mixed.length - nDocs >= 12, 'both types get >= 12 rows: ' + nDocs);
    }, { tags: ['unit'], timeout: 5000 });

    // ---------- search (v10) ----------

    test('composerPickerScore: tiers, name bonus, path segments, multi-word AND, fuzzy', async function() {
        var s = await setup();
        var S = s.m.composerPickerScore;
        assert.strictEqual(S('spec', ['Spec']).score, 45, 'exact + name');
        assert.strictEqual(S('spec', ['Spec draft']).score, 35, 'prefix + name');
        assert.strictEqual(S('spec', ['My spec']).score, 25, 'word boundary + name');
        assert.strictEqual(S('spec', ['Inspection']).score, 15, 'substring + name');
        assert.strictEqual(S('spc', ['Spec']).score, 5, 'fuzzy + name');
        assert.deepStrictEqual(S('spc', ['Spec']).hits, [[0, 1, 3]], 'fuzzy hit indices');
        assert.strictEqual(S('pc', ['Spec']), null, 'fuzzy must start a word');
        assert.strictEqual(S('x', ['Spec']), null, 'single char: no fuzzy');
        assert.strictEqual(S('spec', [{ text: 'Spec', name: false }]).score, 40, 'non-name field: no bonus');
        // Path segments start after '/', '.', '_' ...
        var p = S('notes', [{ text: 'dir/sub/notes.md', name: false }]);
        assert.strictEqual(p.score, 20);
        assert.deepStrictEqual(p.hits, [[8, 9, 10, 11, 12]]);
        assert.strictEqual(S('sub', [{ text: 'dir/sub/notes.md', name: false }]).score, 20);
        assert.strictEqual(S('md', [{ text: 'dir/sub/notes.md', name: false }]).score, 20);
        // Multi-word AND, each word scored on its best field.
        assert.strictEqual(S('spec draft', ['Spec draft']).score, 60);
        assert.strictEqual(S('draft spec', ['Spec draft']).score, 60, 'word order free');
        assert.strictEqual(S('spec final', ['Spec draft']), null, 'every word must match');
        var two = S('spec notes', ['Spec', { text: 'docs/notes.md', name: false }]);
        assert.strictEqual(two.score, 65);
        assert.deepStrictEqual(two.hits, [[0, 1, 2, 3], [5, 6, 7, 8, 9]]);
        assert.strictEqual(S('', ['Spec']).score, 0, 'empty query matches everything');
    }, { tags: ['unit'], timeout: 5000 });

    test('composerPickerScore: accents, full-width, and no reference-syntax matching', async function() {
        var s = await setup();
        var S = s.m.composerPickerScore;
        var r = S('resume', ['R\u00e9sum\u00e9']);
        assert.strictEqual(r.score, 45, 'accents ignored');
        assert.deepStrictEqual(r.hits, [[0, 1, 2, 3, 4, 5]], 'hits map back to source chars');
        assert.strictEqual(S('r\u00e9sum\u00e9', ['resume']).score, 45, 'accented query');
        assert.strictEqual(S('resume', ['Re\u0301sume\u0301']).score, 45, 'decomposed source');
        assert.strictEqual(S('abc', ['\uFF21\uFF22\uFF23']).score, 45, 'full-width source');
        assert.strictEqual(S('\uFF41\uFF42\uFF43', ['ABC']).score, 45, 'full-width query');
        // Users never need the '@virtual:' / '@chat:' syntax, and it does not match.
        type(s, s.input, '@');
        await flush();
        assert.strictEqual(s.m.composerPickerItems('refs', 'virtual:', 'chat').length, 0);
        assert.strictEqual(s.m.composerPickerItems('refs', 'virtual:notes', 'chat').length, 0);
        assert.strictEqual(s.m.composerPickerItems('refs', 'chat:c2', 'chat').length, 0);
        // Plain words find files by name / folder / path, chats by title.
        assert.deepStrictEqual(s.m.composerPickerItems('refs', 'notes', 'chat').map(function(i) { return i.key; }), ['file:notes.md']);
        assert.deepStrictEqual(s.m.composerPickerItems('refs', 'dir', 'chat').map(function(i) { return i.key; }), ['file:dir/a b.txt']);
        assert.deepStrictEqual(s.m.composerPickerItems('refs', 'earlier', 'chat').map(function(i) { return i.key; }), ['chat:c2']);
        assert.deepStrictEqual(s.m.composerPickerItems('refs', 'oldest chat', 'chat').map(function(i) { return i.key; }), ['chat:c5']);
    }, { tags: ['unit'], timeout: 5000 });

    test('highlighting escapes first: <script> in a title stays text', async function() {
        var s = await setup({ smartDocuments: { doc_x: { id: 'doc_x', title: '<script>alert(1)</script>', updatedAt: 1 } } });
        assert.strictEqual(s.m.composerPickerHighlight('<script>x</script>', [1, 2]), '&lt;<mark>sc</mark>ript&gt;x&lt;/script&gt;');
        assert.strictEqual(s.m.composerPickerHighlight('a&b', []), 'a&amp;b');
        type(s, s.input, '@script');
        await flush();
        var docs = s.m.composerPickerItems('refs', 'script', 'chat').filter(function(i) { return i.type === 'doc'; });
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0].labelHtml, '&lt;<mark>script</mark>&gt;alert(1)&lt;/script&gt;');
        var html = popup(s, s.input).innerHTML;
        assert.ok(html.indexOf('<mark>script</mark>') !== -1, 'match marked in the listbox');
        assert.ok(!/<script/i.test(html), 'no live <script> markup');
    }, { tags: ['unit'], timeout: 5000 });

    test('history recall of a message ending in @word leaves the picker closed; next ArrowUp walks history', async function() {
        var s = await setup({ chats: { c1: { id: 'c1', title: 'Current', updatedAt: 100, messages: [
            { role: 'user', content: 'first' }, { role: 'user', content: 'see @spec' }] } } });
        s.dom.doc.activeElement = s.input;
        var up = key('ArrowUp', { target: s.input });
        s.handleKeyDown(up);
        assert.strictEqual(up.prevented, 1);
        assert.strictEqual(s.input.value, 'see @spec', 'recalled');
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'picker closed after recall');
        assert.notStrictEqual(s.input.getAttribute('aria-expanded'), 'true');
        // The browser's async selectionchange (caret at 0) must not reopen it.
        s.dom.fire('selectionchange', { type: 'selectionchange' });
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'still closed after selectionchange');
        s.handleKeyDown(key('ArrowUp', { target: s.input }));
        assert.strictEqual(s.input.value, 'first', 'ArrowUp walks history, not the picker');
        assert.strictEqual(s.m.composerPickerIsOpen(), false);
        // Control: typing the same text does open it.
        type(s, s.input, 'see @spec');
        assert.strictEqual(s.m.composerPickerIsOpen(), true);
    }, { tags: ['unit'], timeout: 5000 });

    // ---------- hotfix (v11) ----------

    test('Accept keeps the picker closed for every ref type; next Enter submits; ArrowUp walks history', async function() {
        var s = await setup();
        s.dom.doc.activeElement = s.input;
        type(s, s.input, '@');
        await flush();
        [['@shot', '@file_img1 '], ['@Earlier', '@chat:c2 '], ['@Spec', '@doc_1 '], ['@notes', '@virtual:notes.md '],
            ['/gam', '/gamma ']].forEach(function(c) {
            type(s, s.input, '');
            type(s, s.input, c[0]);
            assert.ok(s.m.composerPickerIsOpen(), c[0] + ' opens');
            var en = key('Enter', { target: s.input });
            s.handleKeyDown(en);
            assert.strictEqual(en.prevented, 1, c[0] + ' Enter consumed');
            assert.strictEqual(s.input.value, c[1]);
            assert.strictEqual(s.m.composerPickerIsOpen(), false, c[0] + ' closed after accept');
            s.dom.fire('selectionchange', { type: 'selectionchange' });
            assert.strictEqual(s.m.composerPickerIsOpen(), false, c[0] + ' still closed after selectionchange');
            var before = s.sent.chat;
            s.handleKeyDown(key('Enter', { target: s.input }));
            assert.strictEqual(s.sent.chat, before + 1, c[0] + ' next Enter submits');
            assert.strictEqual(s.input.value, c[1], c[0] + ' not re-inserted');
        });
        // An inserted ref followed by prose is never a query again.
        type(s, s.input, '');
        type(s, s.input, '@doc_1 hi');
        assert.strictEqual(s.m.composerPickerIsOpen(), false, '@doc_1 hi: closed');
        // Depends on the inserted-ref rule: an accepted id + space is no query,
        // a never-inserted id + space still is.
        assert.strictEqual(s.m.composerPickerQuery('@doc_1 hi', 9, 9), null, 'inserted ref + space is complete');
        assert.notStrictEqual(s.m.composerPickerQuery('@doc_9 hi', 9, 9), null, 'unknown id is still a query');
        assert.strictEqual(s.m.composerPickerQuery('@chat:c2', 8, 8), null, 'chat: form is complete');
        assert.strictEqual(s.m.composerPickerQuery('@virtual:x', 10, 10), null, 'virtual: form is complete');
        var before2 = s.sent.chat;
        s.handleKeyDown(key('Enter', { target: s.input }));
        assert.strictEqual(s.sent.chat, before2 + 1);
        assert.strictEqual(s.input.value, '@doc_1 hi', 'hi kept');
        // An empty 'No matching references' popup does not swallow arrows.
        type(s, s.input, '');
        type(s, s.input, '@zzz');
        assert.ok(s.m.composerPickerIsOpen(), 'empty popup open (caret at the end of @zzz)');
        var dn = key('ArrowDown', { target: s.input }), up0 = key('ArrowUp', { target: s.input });
        s.handleKeyDown(dn);
        s.handleKeyDown(up0);
        assert.strictEqual(dn.prevented + up0.prevented, 0, 'arrows pass through an empty popup');
        // After an accepted ref, ArrowUp at caret 0 walks history.
        type(s, s.input, '@chat:c2 ');
        s.input.setSelectionRange(0, 0);
        s.dom.fire('selectionchange', { type: 'selectionchange' });
        var up = key('ArrowUp', { target: s.input });
        s.handleKeyDown(up);
        assert.strictEqual(s.input.value, 'newest', 'ArrowUp walks history');
    }, { tags: ['unit'], timeout: 5000 });

    test('multi-word @ query: Enter submits unless a row was picked with arrows; Tab accepts; last word must match a name', async function() {
        var docs = { doc_s: { id: 'doc_s', title: 'Ship it plan', updatedAt: 5 } };
        var s = await setup({ smartDocuments: docs, lfListDir: undefined });
        type(s, s.input, 'ask @ship it');
        assert.ok(s.m.composerPickerIsOpen(), 'open on a matching multi-word query');
        var en = key('Enter', { target: s.input });
        s.handleKeyDown(en);
        assert.strictEqual(s.sent.chat, 1, 'Enter submits the prose');
        assert.strictEqual(s.input.value, 'ask @ship it', 'prose not replaced');
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'closed');
        // Explicit ArrowDown, then Enter accepts.
        type(s, s.input, '');
        type(s, s.input, 'ask @ship it');
        s.handleKeyDown(key('ArrowDown', { target: s.input }));
        s.handleKeyDown(key('Enter', { target: s.input }));
        assert.strictEqual(s.input.value, 'ask @doc_s ');
        assert.strictEqual(s.sent.chat, 1);
        // Tab always accepts.
        type(s, s.input, '');
        type(s, s.input, 'ask @ship it');
        var tab = key('Tab', { target: s.input });
        s.handleKeyDown(tab);
        assert.strictEqual(tab.prevented, 1);
        assert.strictEqual(s.input.value, 'ask @doc_s ');
        // Last word matching only the id field: still a lookup (open), and
        // Enter still submits the prose.
        type(s, s.input, '');
        type(s, s.input, 'ask @ship doc');
        assert.strictEqual(s.m.composerPickerIsOpen(), true, 'open while something matches');
        var sent0 = s.sent.chat;
        s.handleKeyDown(key('Enter', { target: s.input }));
        assert.strictEqual(s.sent.chat, sent0 + 1, 'Enter submits');
        assert.strictEqual(s.input.value, 'ask @ship doc');
        // Single word + trailing space with no match: closed.
        type(s, s.input, '');
        type(s, s.input, '@zzz ');
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'no match once the query ends in whitespace');
    }, { tags: ['unit'], timeout: 5000 });

    test('no-match memo: extending a no-match query does no work; shortening reopens', async function() {
        var calls = { n: 0 }, realNow = Date.now;
        var s = await setup({ lfListDir: undefined, Date: { now: function() { calls.n++; return realNow(); } } });
        type(s, s.input, 'x @zz q');
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'prose closed');
        var n0 = calls.n;
        assert.ok(n0 > 0, 'Date.now spy is wired (pool built once)');
        type(s, s.input, 'x @zz qx');
        type(s, s.input, 'x @zz qxy');
        assert.strictEqual(calls.n, n0, 'no pool rebuild / match while extending');
        assert.strictEqual(s.m.composerPickerIsOpen(), false);
        type(s, s.input, 'x @zz');
        assert.strictEqual(s.m.composerPickerIsOpen(), true, 'shortened token reopens');
    }, { tags: ['unit'], timeout: 5000 });

    test('char-by-char typing matches paste; folder last word; files listing and reset invalidate memo/dismissal', async function() {
        function typeChars(s, text) { for (var i = 1; i <= text.length; i++) type(s, s.input, text.slice(0, i)); }
        var resolveFiles = null;
        var s = await setup({ smartDocuments: { doc_s: { id: 'doc_s', title: 'Ship it plan', updatedAt: 5 } },
            lfListDir: function() { return new Promise(function(r) { resolveFiles = r; }); } });
        // L2: '@q3 ' matches nothing before the listing lands -> memo.
        type(s, s.input, '@q3 ');
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'no match yet');
        resolveFiles({ entries: [{ kind: 'file', name: 'q3.pdf', path: 'finance/reports/q3.pdf', lastModified: 1 }] });
        await flush();
        type(s, s.input, '@q3 r');
        assert.strictEqual(s.m.composerPickerIsOpen(), true, 'new listing invalidates the memo');
        // M2: a folder-name last word still lists the file.
        type(s, s.input, '');
        type(s, s.input, '@q3 reports');
        assert.match(popup(s, s.input).innerHTML, /q3\.pdf/, 'q3 reports lists finance/reports/q3.pdf');
        // M1: typed char by char == pasted.
        type(s, s.input, '');
        typeChars(s, '@finance reports q3');
        assert.strictEqual(s.m.composerPickerIsOpen(), true, 'char-by-char @finance reports q3 opens');
        type(s, s.input, '');
        typeChars(s, 'ask @ship doc plan');
        assert.strictEqual(s.m.composerPickerIsOpen(), true, 'char-by-char ask @ship doc plan opens');
        // L3: reset (send) forgets the Esc dismissal at the same start
        // (composerResetInput does not re-sync, so only the reset clears it).
        type(s, s.input, '');
        type(s, s.input, '@Sh');
        assert.strictEqual(s.m.composerPickerIsOpen(), true, '@Sh opens');
        s.handleKeyDown(key('Escape', { target: s.input }));
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'Esc closes');
        s.m.composerResetInput(s.input);
        type(s, s.input, '@Sh');
        assert.strictEqual(s.m.composerPickerIsOpen(), true, 'next message reopens at the same start');
    }, { tags: ['unit'], timeout: 5000 });

    test('restored history draft ending in @word stays closed after the delayed selectionchange', async function() {
        var s = await setup();
        s.dom.doc.activeElement = s.input;
        type(s, s.input, 'see @spec');
        assert.ok(s.m.composerPickerIsOpen());
        s.input.setSelectionRange(0, 0);
        s.dom.fire('selectionchange', { type: 'selectionchange' });
        assert.strictEqual(s.m.composerPickerIsOpen(), false);
        s.handleKeyDown(key('ArrowUp', { target: s.input }));
        assert.strictEqual(s.input.value, 'newest');
        s.handleKeyDown(key('ArrowDown', { target: s.input }));
        assert.strictEqual(s.input.value, 'see @spec', 'draft restored');
        assert.strictEqual(s.input.selectionStart, 9, 'caret at the end');
        s.dom.fire('selectionchange', { type: 'selectionchange' });
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'restored draft does not reopen the picker');
    }, { tags: ['unit'], timeout: 5000 });

    test('Home composer lists the background currentChatId chat; chat composer excludes it', async function() {
        var s = await setup({ lfListDir: undefined });
        var home = s.m.composerPickerItems('refs', '', 'home').map(function(i) { return i.insert; });
        var chat = s.m.composerPickerItems('refs', '', 'chat').map(function(i) { return i.insert; });
        assert.ok(home.indexOf('@chat:c1 ') !== -1, 'Home includes c1');
        assert.ok(chat.indexOf('@chat:c1 ') === -1, 'chat composer excludes its own chat');
    }, { tags: ['unit'], timeout: 5000 });

    test('Ctrl+A / Shift+arrows pass through; selectionchange re-syncs; Accept re-checks a stale token', async function() {
        var s = await setup();
        s.dom.doc.activeElement = s.input;
        type(s, s.input, '/');
        var ad = s.input.getAttribute('aria-activedescendant');
        var sd = key('ArrowDown', { target: s.input, shiftKey: true });
        s.handleKeyDown(sd);
        assert.strictEqual(sd.prevented, 0, 'Shift+ArrowDown not consumed');
        assert.strictEqual(s.input.getAttribute('aria-activedescendant'), ad, 'selection unchanged');
        var su = key('ArrowUp', { target: s.input, shiftKey: true });
        s.handleKeyDown(su);
        assert.strictEqual(su.prevented, 0, 'Shift+ArrowUp not consumed');
        var ca = key('a', { target: s.input, ctrlKey: true });
        s.handleKeyDown(ca);
        assert.strictEqual(ca.prevented, 0, 'Ctrl+A not consumed');
        s.input.setSelectionRange(0, 1);
        s.dom.fire('selectionchange', { type: 'selectionchange' });
        assert.strictEqual(s.m.composerPickerIsOpen(), false, 'a selection closes the picker');
        s.input.setSelectionRange(1, 1);
        s.dom.fire('selectionchange', { type: 'selectionchange' });
        assert.strictEqual(s.m.composerPickerIsOpen(), true, 'collapsed caret re-syncs and reopens');
        // Value changed without an event: Enter re-syncs, inserts nothing.
        s.input.value = '/gam';
        s.input.selectionStart = s.input.selectionEnd = 4;
        var en = key('Enter', { target: s.input });
        s.handleKeyDown(en);
        assert.strictEqual(en.prevented, 1, 'stale Enter consumed');
        assert.strictEqual(s.input.value, '/gam', 'nothing inserted for an unseen row');
        assert.strictEqual(s.sent.chat, 0);
        assert.strictEqual(s.input.getAttribute('aria-activedescendant'), 'message-input-picker-opt-skill-gamma', 'fresh rows shown');
        s.handleKeyDown(key('Enter', { target: s.input }));
        assert.strictEqual(s.input.value, '/gamma ');
    }, { tags: ['unit'], timeout: 5000 });

    test('ranking is a total order: same result whatever the pool order', async function() {
        var list = [['x0', 'Alpha chat'], ['x1', 'Beta chat'], ['x2', 'Gamma chat'], ['x3', 'Alpha chat'], ['x4', 'chat log']];
        async function order(perm) {
            var cs = {};
            perm.forEach(function(i) { cs[list[i][0]] = { id: list[i][0], title: list[i][1], updatedAt: 5 }; });
            var s = await setup({ chats: cs, currentChatId: 'none', smartDocuments: {}, lfListDir: undefined });
            return s.m.composerPickerItems('refs', 'chat', 'chat').map(function(i) { return i.key; });
        }
        var expected = ['chat:x4', 'chat:x0', 'chat:x3', 'chat:x1', 'chat:x2'];
        assert.deepStrictEqual(await order([0, 1, 2, 3, 4]), expected, 'prefix first, then label, then key');
        assert.deepStrictEqual(await order([4, 3, 2, 1, 0]), expected);
        assert.deepStrictEqual(await order([2, 4, 0, 3, 1]), expected);
        assert.deepStrictEqual(await order([3, 1, 4, 2, 0]), expected);
    }, { tags: ['unit'], timeout: 5000 });

    test('Agent Files cache: timeout, TTL, generation (force supersedes, stale dropped)', async function() {
        var pending = [], timers = [], cleared = [];
        function deferred() { var d = {}; d.p = new Promise(function(r) { d.resolve = r; }); return d; }
        function file(n) { return { kind: 'file', name: n, path: n, lastModified: 1 }; }
        var s = await setup({
            lfListDir: function() { var d = deferred(); pending.push(d); return d.p; },
            setTimeout: function(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
            clearTimeout: function(id) { cleared.push(id); }
        });
        var F = s.m._composerPickerFiles;
        function fileTimers() { return timers.filter(function(t) { return t.ms === 5000; }); }
        // 1. Timeout: listing hangs, 5 s timer rejects, entries [] and retry allowed.
        var p1 = s.m.composerPickerRefreshFiles();
        assert.ok(p1, 'started');
        assert.strictEqual(F.loading, true);
        assert.strictEqual(fileTimers().length, 1, '5 s timeout armed');
        assert.strictEqual(s.m.composerPickerRefreshFiles(), null, 'no second load while in flight');
        fileTimers()[0].fn();
        await p1;
        assert.strictEqual(F.loading, false);
        assert.deepStrictEqual(F.entries, []);
        assert.strictEqual(F.at, 0, 'retry on next open');
        assert.strictEqual(F.version, 0);
        pending[0].resolve({ entries: [file('late.md')] });
        await flush();
        assert.deepStrictEqual(F.entries, [], 'late listing after timeout ignored');
        // 2. Success: entries land, version bumps, timer cleared.
        var p2 = s.m.composerPickerRefreshFiles();
        assert.ok(p2);
        pending[1].resolve({ entries: [file('a.md'), { kind: 'dir', name: 'd', path: 'd' }] });
        await p2;
        assert.deepStrictEqual(F.entries.map(function(e) { return e.path; }), ['a.md']);
        assert.strictEqual(F.version, 1);
        assert.ok(cleared.length >= 1, 'timeout cleared');
        // 3. TTL: fresh listing is reused for 10 s.
        assert.strictEqual(s.m.composerPickerRefreshFiles(), null, 'within TTL');
        assert.strictEqual(pending.length, 2);
        F.at = Date.now() - 10001;
        var p3 = s.m.composerPickerRefreshFiles();
        assert.ok(p3, 'expired TTL reloads');
        // 4. Generation: force supersedes the in-flight load; stale result dropped.
        var p4 = s.m.composerPickerRefreshFiles(true);
        assert.ok(p4, 'force starts a new generation');
        pending[3].resolve({ entries: [file('b.md')] });
        await p4;
        assert.deepStrictEqual(F.entries.map(function(e) { return e.path; }), ['b.md']);
        assert.strictEqual(F.version, 2);
        assert.strictEqual(F.loading, false);
        pending[2].resolve({ entries: [file('stale.md')] });
        await p3;
        assert.deepStrictEqual(F.entries.map(function(e) { return e.path; }), ['b.md'], 'stale generation ignored');
        assert.strictEqual(F.version, 2);
        assert.strictEqual(F.loading, false);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('composer Send -> Stop (item 11)', function() {
    function stopBtn(els, id) {
        var attrs = {}, set = {};
        var b = { id: id, disabled: false, attrs: attrs,
            classList: { add: function(c) { set[c] = 1; }, remove: function(c) { delete set[c]; }, contains: function(c) { return !!set[c]; } },
            setAttribute: function(k, v) { attrs[k] = String(v); },
            getAttribute: function(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
            hasAttribute: function(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
            removeAttribute: function(k) { delete attrs[k]; } };
        b.closest = function(sel) { return sel === '#' + id ? b : null; };
        els[id] = b; return b;
    }

    test('Stop aria-label/title survive applyI18n language switches', async function() {
        var src245 = await loadFile('src/js/ui/245-i18n-dom.js');
        var a = src245.indexOf('function i18nNormalizeKey(');
        var b = src245.indexOf('function _i18nTranslateAttrs(');
        assert.ok(a !== -1 && b > a, '245 helpers present');
        var e = src245.indexOf('\n}\n', b);
        var wm = new WeakMap(), lang = {};
        var T = function(k) { return Object.prototype.hasOwnProperty.call(lang, k) ? lang[k] : k; };
        var translateAttrs = new Function('_i18nAttrOrig', '_i18nTextOrig', 't', src245.slice(a, e + 2) + '\nreturn _i18nTranslateAttrs;')(wm, null, T);
        var els = {}, docL = {};
        var send = stopBtn(els, 'send-btn');
        stopBtn(els, 'home-send-btn');
        send.setAttribute('aria-label', 'Send message');
        send.setAttribute('data-i18n-attr', 'aria-label,title');
        els['message-input'] = { id: 'message-input', value: '' };
        els['home-message-input'] = { id: 'home-message-input', value: '' };
        els['send-icon'] = { innerHTML: '' }; els['home-send-icon'] = { innerHTML: '' };
        var doc = { getElementById: function(id) { return els[id] || null; },
            addEventListener: function(t, f, cap) { (docL[t] = docL[t] || []).push({ f: f, cap: cap }); } };
        var ctl = { active: true, state: 'pause' };
        var m = await loadModules(['src/js/ui/246-composer.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), document: doc, currentChatId: 'c1',
            UI_ICONS: { send: 'SEND', stop: 'STOP' }, t: T, _i18nAttrOrig: wm,
            _isChatLoopActive: function() { return ctl.active; },
            _chatControlsState: function() { return ctl.state; },
            togglePause: function() {}, sendMessage: function() {}, sendHomeMessage: function() {}
        } });
        lang = { 'Stop': 'Arr\u00eater', 'Send message': 'Envoyer', 'Interrupting\u2026': 'Interruption\u2026' };
        translateAttrs(send); // boot applyI18n on the body.html markup
        assert.strictEqual(send.getAttribute('aria-label'), 'Envoyer');
        m.syncSendButton();
        assert.strictEqual(send.getAttribute('aria-label'), 'Arr\u00eater');
        // Language switch while in Stop mode: re-translated from the key 'Stop'.
        lang = { 'Stop': 'Stopp', 'Send message': 'Nachricht senden' };
        translateAttrs(send);
        assert.strictEqual(send.getAttribute('aria-label'), 'Stopp', 'not a stale French label');
        assert.strictEqual(send.getAttribute('title'), 'Stopp');
        m.syncSendButton(); // unchanged mode: label stays correct
        assert.strictEqual(send.getAttribute('aria-label'), 'Stopp');
        ctl.active = false;
        m.syncSendButton();
        assert.strictEqual(send.getAttribute('aria-label'), 'Nachricht senden');
        lang = {};
        translateAttrs(send);
        assert.strictEqual(send.getAttribute('aria-label'), 'Send message', 'back to English source');
        // Markup + CSS hooks the fixes rely on.
        var body = await loadFile('src/html/body.html');
        assert.match(body, /id="send-btn"[^>]*data-i18n-attr="aria-label,title"|data-i18n-attr="aria-label,title"[^>]*id="send-btn"/);
        var css = await loadFile('src/css/06-input.css');
        assert.ok(css.indexOf('#send-btn[aria-disabled="true"]') !== -1, 'Interrupting styled via aria-disabled');
    }, { tags: ['unit'], timeout: 5000 });

    test('syncSendButton modes, draft keeps Send, click toggles pause only in stop mode', async function() {
        var els = {}, docL = {};
        function btn(id) {
            var attrs = {}, set = {};
            var b = { id: id, disabled: false, attrs: attrs,
                classList: { add: function(c) { set[c] = 1; }, remove: function(c) { delete set[c]; }, contains: function(c) { return !!set[c]; } },
                setAttribute: function(k, v) { attrs[k] = String(v); },
                getAttribute: function(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
                removeAttribute: function(k) { delete attrs[k]; } };
            b.closest = function(sel) { return sel === '#' + id ? b : null; };
            els[id] = b; return b;
        }
        var send = btn('send-btn'), homeSend = btn('home-send-btn');
        els['message-input'] = { id: 'message-input', value: '' };
        els['home-message-input'] = { id: 'home-message-input', value: '' };
        els['send-icon'] = { innerHTML: '' }; els['home-send-icon'] = { innerHTML: '' };
        var doc = { getElementById: function(id) { return els[id] || null; },
            addEventListener: function(t, f, cap) { (docL[t] = docL[t] || []).push({ f: f, cap: cap }); } };
        var ctl = { active: true, state: 'pause', toggles: 0 };
        var m = await loadModules(['src/js/ui/246-composer.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), document: doc, currentChatId: 'c1',
            UI_ICONS: { send: 'SEND', stop: 'STOP' },
            _isChatLoopActive: function() { return ctl.active; },
            _chatControlsState: function() { return ctl.state; },
            togglePause: function() { ctl.toggles++; ctl.state = 'resume'; },
            sendMessage: function() {}, sendHomeMessage: function() {}
        } });
        assert.ok((docL.click || []).some(function(l) { return l.f === m.composerSendButtonClick && l.cap === true; }), 'capture click listener');

        m.syncSendButton();
        assert.strictEqual(send.getAttribute('data-mode'), 'stop');
        assert.strictEqual(send.disabled, false);
        assert.strictEqual(send.getAttribute('aria-label'), 'Stop');
        assert.ok(send.classList.contains('is-stop'));
        assert.strictEqual(els['send-icon'].innerHTML, 'STOP');
        assert.strictEqual(homeSend.getAttribute('data-mode') || 'send', 'send', 'Home never becomes Stop');
        assert.strictEqual(homeSend.disabled, true, 'empty Home stays disabled');

        // A non-empty draft keeps Send (text is injected into the run).
        els['message-input'].value = 'more context';
        m.syncSendButton();
        assert.strictEqual(send.getAttribute('data-mode'), 'send');
        assert.strictEqual(send.disabled, false);
        assert.strictEqual(send.getAttribute('aria-label'), 'Send message');
        assert.ok(!send.classList.contains('is-stop'));
        assert.strictEqual(els['send-icon'].innerHTML, 'SEND');
        // Send mode click: not intercepted.
        var ev1 = { target: send, prevented: 0, stopped: 0 };
        ev1.preventDefault = function() { ev1.prevented++; }; ev1.stopImmediatePropagation = function() { ev1.stopped++; };
        assert.strictEqual(m.composerSendButtonClick(ev1), false);
        assert.strictEqual(ev1.stopped + ev1.prevented, 0, 'send click propagates to onclick=sendMessage');
        assert.strictEqual(ctl.toggles, 0);

        // Stop mode click: togglePause, propagation stopped, then Interrupting.
        els['message-input'].value = '';
        m.syncSendButton();
        var ev2 = { target: send, prevented: 0, stopped: 0 };
        ev2.preventDefault = function() { ev2.prevented++; }; ev2.stopImmediatePropagation = function() { ev2.stopped++; };
        assert.strictEqual(m.composerSendButtonClick(ev2), true);
        assert.strictEqual(ctl.toggles, 1, 'togglePause called');
        assert.strictEqual(ev2.stopped, 1);
        assert.strictEqual(ev2.prevented, 1);
        assert.strictEqual(send.getAttribute('data-mode'), 'interrupting');
        // aria-disabled, not disabled: the focused button keeps focus.
        assert.strictEqual(send.disabled, false);
        assert.strictEqual(send.getAttribute('aria-disabled'), 'true');
        assert.strictEqual(send.getAttribute('aria-label'), 'Interrupting…');
        // Clicks while Interrupting are swallowed: no second togglePause.
        var ev3 = { target: send, prevented: 0, stopped: 0 };
        ev3.preventDefault = function() { ev3.prevented++; }; ev3.stopImmediatePropagation = function() { ev3.stopped++; };
        assert.strictEqual(m.composerSendButtonClick(ev3), true);
        assert.strictEqual(ctl.toggles, 1, 'no toggle while interrupting');
        assert.strictEqual(ev3.stopped + ev3.prevented, 2, 'click never reaches onclick=sendMessage');
        assert.strictEqual(send.disabled, false, 'still focusable');

        // Loop ended: back to Send (disabled, empty draft).
        ctl.active = false;
        m.syncSendButton();
        assert.strictEqual(send.getAttribute('data-mode'), 'send');
        assert.strictEqual(send.disabled, true);
        assert.strictEqual(send.getAttribute('title'), null, 'title removed in send mode');
        assert.strictEqual(send.getAttribute('aria-disabled'), null, 'aria-disabled cleared');
        // A click that is not on #send-btn is ignored.
        assert.strictEqual(m.composerSendButtonClick({ target: { closest: function() { return null; } } }), false);
    }, { tags: ['unit'], timeout: 5000 });
});
