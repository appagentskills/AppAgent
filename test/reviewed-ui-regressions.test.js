// Run: run_tests { pattern: 'reviewed-ui-regressions' } (js_eval sandbox; no Node).
// Production declarations in an isolated fixture; no live page/SW/settings writes.
'use strict';
async function runReviewedUiAudit(sources) {
    var results = [];
    function check(value, message) { if (!value) throw new Error(message); }
    async function test(name, fn) {
        try { await fn(); results.push({ name: name, passed: true }); }
        catch (e) { results.push({ name: name, passed: false, error: e.message }); }
    }
    function declaration(source, name) {
        var start = source.indexOf('function ' + name + '(');
        var end = source.indexOf('\n}', start);
        check(start >= 0 && end > start, 'Missing declaration: ' + name);
        var code = source.slice(start, end + 2);
        new Function(code);
        return code;
    }
    var attachments = sources['src/js/app/050-image-attachments.js'];
    var navigation = sources['src/js/ui/170-chat-management.js'];
    var notifications = sources['src/js/ui/160-notifications.js'];
    var names = ['processImageFile', 'appendPendingImageForContext', 'clearPendingImages',
        'getCurrentPendingContext', 'savePendingImagesForContext', 'restorePendingImagesForContext',
        'savePendingTextForContext', 'restorePendingTextForContext', 'persistPendingTextsToStorage',
        'persistPendingImagesToSession', 'getEditedTurnAttachments', 'editMessage',
        'setPendingImagesOwner', 'getPendingImagesOwnerContext'];
    var code = names.map(function(n) { return declaration(attachments, n); }).join('\n') + '\n' +
        declaration(navigation, 'selectChat') + '\n' + declaration(sources['src/js/ui/030-home-view.js'], 'sendHomeMessage') + '\n' +
        declaration(sources['src/js/ui/050-history-view.js'], 'openChatFromHistory');
    function fixture(view) {
        var readers = [], images = [], compression = [], renders = [], writes = [], errors = [], elements = {}, api;
        function element(id) {
            if (!elements[id]) elements[id] = { value: '', style: {}, focus: function() {},
                classList: { add: function() {}, remove: function() {}, contains: function() { return false; } } };
            return elements[id];
        }
        var env = { currentView: view || 'chat', currentChatId: 'A',
            chats: { A: { id: 'A', title: 'Source', messages: [] }, B: { id: 'B', messages: [] } },
            pendingImageAttachments: [], chatPendingImages: {}, chatPendingTexts: {},
            pendingImagesOwnerContext: null, pendingImagesOwnerList: null,
            runningChatIds: {}, pendingInjectionsByChatId: {}, sidebarCollapsed: true,
            isRunning: false, activeStreamingChatId: null, lastApiError: null,
            pendingInjection: null, pendingInjectionImages: null,
            window: { innerWidth: 1024, currentSearchHighlight: null },
            appStorage: { setItem: function() {} },
            document: { getElementById: element, body: element('body'), createElement: function() {
                return { getContext: function() { return { drawImage: function() {} }; }, toDataURL: function() { return 'data:image/png;base64,raw'; } };
            } },
            FileReader: function() { readers.push(this); this.readAsDataURL = this.readAsText = function() {}; },
            Image: function() { images.push(this); this.width = 1400; this.height = 700; },
            compressBase64Image: function() { return new Promise(function(resolve, reject) { compression.push({ resolve: resolve, reject: reject }); }); },
            newFileId: function() { return 'file_' + (readers.length + images.length); },
            setSetting: function(k, v) { writes.push({ key: k, value: JSON.parse(JSON.stringify(v)) }); },
            showSnackbar: function(message) { errors.push(message); },
            renderPendingImages: function() { renders.push(env.currentView === 'home' ? 'home' : env.currentChatId); api.persistPendingImagesToSession(); },
            newChat: function() {
                api.savePendingImagesForContext('home'); api.savePendingTextForContext('home');
                env.currentChatId = 'B'; env.currentView = 'chat'; api.restorePendingImagesForContext('B');
            },
            sendMessage: function() { api.clearPendingImages(); }
        };
        ('renderChatList updateHomePendingIndicator autoResizeTextarea saveChatsToStorage hidePauseButton ' +
            'hideContinueButton hideRetryButton hideSnackbar clearUpdateSet loadVersionHistory renderMessages ' +
            'updateChatTitleHeader updateInputPosition refreshContinueButtonForChat pushHistoryState ' +
            'showPendingApprovalNotifications hideAllPanels showChatView updateAllButtonStates').split(' ').forEach(function(n) { env[n] = function() {}; });
        api = new Function('env', 'with(env){\n' + code + '\nreturn {' + names.concat(['selectChat', 'sendHomeMessage', 'openChatFromHistory']).map(function(n) { return n + ':' + n; }).join(',') + '};}')(env);
        function switchTo(id) {
            var old = api.getCurrentPendingContext(); api.savePendingImagesForContext(old); api.savePendingTextForContext(old);
            env.currentView = id === 'home' ? 'home' : 'chat'; if (id !== 'home') env.currentChatId = id;
            api.restorePendingImagesForContext(id); api.restorePendingTextForContext(id);
        }
        return { env: env, api: api, readers: readers, images: images, compression: compression, renders: renders,
            writes: writes, errors: errors, element: element, switchTo: switchTo };
    }
    function file(type, name) { return { type: type, name: name, size: 12 }; }
    function finish(reader, value) { reader.onload({ target: { result: value } }); }
    await test('PDF completion stays in A while B composer and persisted draft remain unchanged', function() {
        var f = fixture(); f.api.processImageFile(file('application/pdf', 'a.pdf'));
        f.switchTo('B'); f.env.pendingImageAttachments = [{ name: 'b' }];
        var before = f.renders.length; finish(f.readers[0], 'data:pdf');
        check(f.renders.length === before, 'background upload rendered another composer');
        check(f.env.pendingImageAttachments[0].name === 'b', 'B draft contaminated');
        check(f.env.chatPendingImages.A[0].base64 === 'data:pdf', 'origin PDF missing');
        var stored = f.writes[f.writes.length - 1].value;
        check(stored.A[0].name === 'a.pdf' && stored.B[0].name === 'b', 'map not persisted');
        f.switchTo('A'); check(f.env.pendingImageAttachments[0].name === 'a.pdf', 'return did not restore upload');
    });
    await test('A to B to A with concurrent text uploads merges latest draft, not captured arrays', function() {
        var f = fixture(); f.api.processImageFile(file('text/plain', 'one.txt')); f.api.processImageFile(file('text/csv', 'two.csv'));
        f.switchTo('B'); finish(f.readers[1], 'two'); f.switchTo('A'); finish(f.readers[0], 'one');
        check(f.env.pendingImageAttachments.map(function(a) { return a.content; }).join(',') === 'two,one', 'concurrent result lost');
        check(!f.env.chatPendingImages.B, 'upload leaked into B');
    });
    await test('image compression completion keeps origin and resized metadata after navigation', async function() {
        var f = fixture(); f.api.processImageFile(file('image/png', 'photo.png')); finish(f.readers[0], 'image'); f.images[0].onload();
        f.switchTo('B'); var before = f.renders.length; f.compression[0].resolve('compressed'); await Promise.resolve();
        var image = f.env.chatPendingImages.A[0];
        check(image.base64 === 'compressed' && image.width === 1200 && image.height === 600 && image.file_id, 'image payload or metadata lost');
        check(f.renders.length === before && !f.env.pendingImageAttachments.length, 'wrong composer rendered');
    });
    await test('send before upload completion creates next origin draft without resurrecting sent attachments', function() {
        var f = fixture(); f.env.pendingImageAttachments = [{ name: 'already sent' }];
        f.api.processImageFile(file('text/plain', 'late.txt')); f.api.clearPendingImages(); finish(f.readers[0], 'late');
        check(f.env.pendingImageAttachments.length === 1 && f.env.pendingImageAttachments[0].name === 'late.txt', 'sent snapshot resurrected');
    });
    await test('home send before completion leaves late upload at home, not new sent chat', function() {
        var f = fixture('home'); f.element('home-message-input').value = 'send now';
        f.api.processImageFile(file('application/pdf', 'home.pdf')); f.api.sendHomeMessage(); var before = f.renders.length;
        finish(f.readers[0], 'home-pdf');
        check(f.env.currentChatId === 'B' && !f.env.pendingImageAttachments.length && !f.env.chatPendingImages.B, 'home upload crossed into sent chat');
        check(f.renders.length === before && f.env.chatPendingImages.home[0].name === 'home.pdf', 'home origin missing');
        f.switchTo('home'); check(f.env.pendingImageAttachments[0].base64 === 'home-pdf', 'home draft not restored');
    });
    await test('home to chat to home before completion restores the active home draft', function() {
        var f = fixture('home'); f.api.processImageFile(file('text/plain', 'home.txt')); f.switchTo('A'); f.switchTo('home'); finish(f.readers[0], 'home');
        check(f.env.pendingImageAttachments[0].content === 'home' && !f.env.chatPendingImages.A, 'home revisit lost origin');
    });
    await test('deleted origin cannot be resurrected by callback', function() {
        var f = fixture(); f.api.processImageFile(file('text/plain', 'gone.txt')); f.switchTo('B'); delete f.env.chats.A; finish(f.readers[0], 'gone');
        check(!f.env.chatPendingImages.A && !f.env.pendingImageAttachments.length, 'deleted chat draft resurrected');
    });
    await test('validation and read/compression failures add no attachments', async function() {
        var f = fixture(); f.api.processImageFile(file('application/zip', 'bad.zip'));
        f.api.processImageFile({ type: 'application/pdf', name: 'big.pdf', size: 11 * 1024 * 1024 });
        f.api.processImageFile(file('text/plain', 'bad.txt')); f.readers[0].onerror();
        f.api.processImageFile(file('image/png', 'bad.png')); finish(f.readers[1], 'image'); f.images[0].onload(); f.compression[0].reject(new Error('bad')); await Promise.resolve(); await Promise.resolve();
        check(!f.env.pendingImageAttachments.length && f.errors.length === 4, 'failure path attached payload or hid error');
    });
    await test('saving an empty active draft clears a stale map entry', function() {
        var f = fixture(); f.env.chatPendingImages.A = [{ name: 'stale' }]; f.api.savePendingImagesForContext('A'); check(!f.env.chatPendingImages.A, 'stale draft retained');
    });
    await test('A draft survives A -> Home -> History -> open chat (live list is Home, not A)', function() {
        var f = fixture(); f.env.chatPendingImages.home = [{ name: 'home.png' }]; f.env.pendingImageAttachments = [{ name: 'a.pdf' }];
        f.switchTo('home'); f.env.currentView = 'history'; f.api.openChatFromHistory('B');
        check(f.env.chatPendingImages.A && f.env.chatPendingImages.A[0].name === 'a.pdf', 'A draft deleted by history open');
        check(f.env.chatPendingImages.home[0].name === 'home.png' && !f.env.pendingImageAttachments.length, 'home draft lost or leaked into B');
        f.api.openChatFromHistory('A'); check(f.env.pendingImageAttachments[0].name === 'a.pdf' && !f.env.chatPendingImages.B, 'A not restored / B polluted');
    });
    await test('owning chat that removed all attachments still clears its saved draft on switch', function() {
        var f = fixture(); f.env.chatPendingImages.A = [{ name: 'x' }]; f.switchTo('A'); f.env.pendingImageAttachments.splice(0, 1);
        f.switchTo('B'); check(!f.env.chatPendingImages.A, 'emptied owner draft retained');
    });
    await test('uploads finishing while History covers Home land in their origin draft only', function() {
        var f = fixture(); f.env.pendingImageAttachments = [{ name: 'a0' }];
        f.api.processImageFile(file('text/plain', 'a1.txt')); f.switchTo('home'); f.api.processImageFile(file('text/plain', 'h.txt'));
        f.env.currentView = 'history'; finish(f.readers[0], 'a1'); finish(f.readers[1], 'h');
        check(f.env.chatPendingImages.A.map(function(a) { return a.name; }).join() === 'a0,a1.txt', 'A upload lost or A overwritten');
        check(f.env.pendingImageAttachments.length === 1 && f.env.chatPendingImages.home[0].name === 'h.txt', 'home upload misrouted');
        f.api.openChatFromHistory('B'); check(f.env.chatPendingImages.A.length === 2 && f.env.chatPendingImages.home.length === 1, 'drafts lost on history open');
    });
    var legacyDoc = { role: 'context', content: '[User referenced Smart Document "Legacy" (doc_id: old_doc). Use the document tool with action "read" and this doc_id to access its content.]' };
    await test('edit branch preserves earlier history and all attachment metadata, isolates source draft and transcript', function() {
        var f = fixture();
        var original = [ { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'answer', tool_calls: [{ id: 'kept' }] },
            { role: 'user', content: 'edit me' }, { role: 'screenshot', base64: 'image', width: 12, height: 8, name: 'pic', file_id: 'img_id' },
            { role: 'pdf', base64: 'pdf', name: 'paper.pdf', file_id: 'pdf_id' },
            { role: 'file', content: 'csv', name: 'data.csv', mimeType: 'text/csv', size: 3, file_id: 'csv_id' },
            { role: 'context', attachment: { fileType: 'document', name: 'Doc', sdocId: 'doc_ref' }, content: 'reference' },
            { role: 'assistant', content: 'discard in branch' }, { role: 'screenshot', name: 'tool output' } ];
        f.env.chats.A.messages = original; f.env.chats.A.cachedToolResults = { cache1: 'cached' };
        f.env.chats.A.versionHistory = [{ messageIndex: 1, chatId: 'A' }, { messageIndex: 7, chatId: 'A' }];
        var snapshot = JSON.stringify(f.env.chats.A); f.env.pendingImageAttachments = [{ name: 'unrelated pending' }]; f.element('message-input').value = 'unfinished source draft';
        f.api.editMessage(2); var branch = f.env.chats[f.env.currentChatId];
        check(f.env.currentChatId !== 'A' && branch.messages.length === 2, 'history boundary incorrect');
        check(JSON.stringify(f.env.chats.A) === snapshot, 'source chat mutated');
        check(f.env.chatPendingImages.A[0].name === 'unrelated pending' && f.env.chatPendingTexts.A === 'unfinished source draft', 'source draft lost');
        check(f.element('message-input').value === 'edit me' && f.env.pendingImageAttachments.length === 4, 'branch composer wrong');
        var a = f.env.pendingImageAttachments;
        check(a[0].file_id === 'img_id' && a[0].width === 12 && a[1].base64 === 'pdf' && a[1].fileType === 'pdf', 'binary metadata lost');
        check(a[2].content === 'csv' && a[2].mimeType === 'text/csv' && a[2].size === 3 && a[2].file_id === 'csv_id' && a[3].sdocId === 'doc_ref', 'file/document references lost');
        check(branch.cachedToolResults.cache1 === 'cached' && branch.versionHistory.length === 1 && branch.versionHistory[0].chatId === branch.id, 'artifacts not preserved');
        branch.messages[1].tool_calls[0].id = 'changed'; check(original[1].tool_calls[0].id === 'kept', 'history shares nested objects');
        f.api.selectChat('A'); check(f.element('message-input').value === 'unfinished source draft' && f.env.pendingImageAttachments[0].name === 'unrelated pending', 'source draft failed round trip');
    });
    await test('edit attachment scan handles legacy documents and stops at unrelated context or next user', function() {
        var f = fixture(); var rows = [{ role: 'user' }, legacyDoc, { role: 'context', content: 'unrelated context' }, { role: 'pdf' }];
        var a = f.api.getEditedTurnAttachments(rows, 0); check(a.length === 1 && a[0].sdocId === 'old_doc', 'legacy document scan failed');
        check(f.api.getEditedTurnAttachments([{ role: 'user' }, { role: 'user' }, { role: 'file' }], 0).length === 0, 'scan crossed next user');
    });
    await test('edit branch skips attachments whose base64 was evicted from the transcript', function() {
        var f = fixture(); f.env.chats.A.messages = [{ role: 'user', content: 'edit me' }, { role: 'screenshot', name: 'gone.png', file_id: 'ev_id', _b64Evicted: true }, { role: 'screenshot', name: 'kept.png', file_id: 'ok_id', base64: 'data:image/png;base64,AA' }];
        f.api.editMessage(0); var a = f.env.pendingImageAttachments;
        check(a.length === 1 && a[0].name === 'kept.png' && a[0].base64 === 'data:image/png;base64,AA', 'evicted attachment leaked into branch draft');
    });
    await test('editing first text-only turn excludes unrelated pending attachments and rejects non-user rows', function() {
        var f = fixture(); f.env.chats.A.messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }];
        f.api.editMessage(1); check(f.env.currentChatId === 'A', 'non-user edit allowed');
        f.api.editMessage(99); check(f.env.currentChatId === 'A', 'invalid edit allowed');
        f.env.pendingImageAttachments = [{ name: 'unrelated' }]; f.api.editMessage(0);
        check(f.env.chats[f.env.currentChatId].messages.length === 0 && !f.env.pendingImageAttachments.length, 'empty branch inherited pending data');
    });
    await test('sendMessage stores structured Smart Document attachment metadata', function() {
        check(/role: 'context',\s*attachment: \{ fileType: 'document', name: docTitle, sdocId: docId \}/.test(sources['src/js/app/040-send-message.js']), 'new reference metadata not wired');
    });
    function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    var renderer = sources['src/js/ui/250-message-render.js'];
    var renderEnv = { escapeHtml: escapeHtml, highlightJS: escapeHtml, storeRawCopy: function() { return 'copy'; },
        UI_ICONS: { copy: 'C' }, window: { currentSearchHighlight: null }, decorateIdMentions: function(s) { return s; },
        renderDisplayPlaceholder: function() { return '<div>DISPLAY</div>'; }, renderDocumentPlaceholder: function() { return '<div>DOCUMENT</div>'; } };
    var fc = new Function('env', 'with(env){\n' + sources['src/js/core/055-emoji-shortcodes.js'] + '\n' + declaration(renderer, 'formatContent') + '\nreturn formatContent;}')(renderEnv);
    await test('inline bold, markdown links, bare URLs, IDs, emoji, table pipes and HTML all remain literal', function() {
        var literals = ['**bold**', '[x](https://example.com)', 'https://example.com', ':bug:', 'widget_1788610000000_abc', '<img src=x onerror=bad()>', 'a | b', '# heading', '<!--document:doc_x-->', '<!--display:dsp_x-->', '$& $$'];
        literals.forEach(function(literal) { var html = fc('`' + literal + '`'); check(html.indexOf('<code class="inline-code">' + escapeHtml(literal) + '</code>') >= 0, 'inline transformed: ' + literal + ' => ' + html); });
    });
    await test('inline marker collisions and whitespace stay literal while surrounding markdown renders', function() {
        var html = fc('\u0000INLINE0\u0000 **outside** `a  b\n c` [link](https://example.com)');
        check(html.indexOf('\u0000INLINE0\u0000') >= 0 && html.indexOf('<strong>outside</strong>') >= 0 && html.indexOf('<a href="https://example.com"') >= 0, 'surrounding markup broken');
        check(html.indexOf('<code class="inline-code">a  b\n c</code>') >= 0, 'inline whitespace changed');
    });
    await test('fenced code stays escaped with literal document markers and inline backticks', function() {
        var html = fc('```txt\n`**raw**` <b> <!--document:doc_x-->\n```\n\nAfter :bug:');
        check(html.indexOf('`**raw**` &lt;b&gt; &lt;!--document:doc_x--&gt;') >= 0 && html.indexOf('inline-code') < 0 && html.indexOf('DOCUMENT') < 0, 'fenced code transformed');
        check(html.indexOf('\uD83D\uDC1B') >= 0 && html.indexOf('code-block-wrapper') >= 0, 'fence or prose regressed');
    });
    await test('headers lists tables and real document placeholders retain normal rendering', function() {
        var html = fc('## Heading\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| `a | b` | ok |\n\n<!--document:doc_x-->');
        check(html.indexOf('<h3>Heading</h3>') >= 0 && html.indexOf('<ul>') >= 0 && html.indexOf('<table') >= 0 && html.indexOf('<div>DOCUMENT</div>') >= 0, 'block formatting regressed');
        check(html.indexOf('<code class="inline-code">a | b</code>') >= 0, 'inline pipe split table cells');
    });
    function runHandler(code, element, event, env) { return new Function('env', 'event', 'with(env){' + code + '}').call(element, env || {}, event); }
    function keyEvent(key, repeat) { return { key: key, repeat: !!repeat, prevented: false, stopped: false, preventDefault: function() { this.prevented = true; }, stopPropagation: function() { this.stopped = true; } }; }
    var body = sources['src/html/body.html'];
    ['ws-header-status', 'home-ws-header-status'].forEach(function(id) {
        results.push((function() {
            try {
                var tag = body.match(new RegExp('<span[^>]*id="' + id + '"[^>]*>'))[0];
                check(/role="button"/.test(tag) && /tabindex="0"/.test(tag), 'pill not focusable');
                var handler = tag.match(/onkeydown="([^"]*)"/)[1], clicks = 0, el = { click: function() { clicks++; } };
                ['Enter', ' '].forEach(function(key) { var e = keyEvent(key); runHandler(handler, el, e); check(e.prevented, 'page may scroll'); });
                var other = keyEvent('ArrowDown'); runHandler(handler, el, other); runHandler(handler, el, keyEvent(' ', true));
                check(clicks === 2 && !other.prevented, 'wrong/repeated key activated pill');
                return { name: id + ' Enter/Space activation and repeat guard', passed: true };
            } catch (e) { return { name: id + ' keyboard handler', passed: false, error: e.message }; }
        })());
    });
    await test('both instance pills are focusable and their real key bindings activate only Enter/Space', function() {
        var bridge = sources['src/platform/extension/platform-bridge.js'];
        var binding = bridge.slice(bridge.indexOf('    // Make status indicators clickable'), bridge.indexOf('    // Chrome storage helpers'));
        check(binding.indexOf("addEventListener('keydown'") >= 0, 'binding missing');
        var picks = 0, elements = {};
        ['ext-sn-status', 'home-ext-sn-status'].forEach(function(id) {
            var tag = body.match(new RegExp('<span[^>]*id="' + id + '"[^>]*>'))[0];
            check(/role="button"/.test(tag) && /tabindex="0"/.test(tag), 'instance pill not focusable');
            var listeners = {}; elements[id] = { style: {}, addEventListener: function(k, fn) { listeners[k] = fn; }, listeners: listeners, click: function() { listeners.click(keyEvent('')); } };
        });
        new Function('Platform', 'document', 'showInstancePicker', binding)({ ready: { then: function(fn) { fn(); } } }, { getElementById: function(id) { return elements[id]; } }, function() { picks++; });
        Object.keys(elements).forEach(function(id) {
            ['Enter', ' '].forEach(function(k) { var e = keyEvent(k); elements[id].listeners.keydown(e); check(e.prevented && e.stopped, 'instance key not prevented/stopped'); });
            elements[id].listeners.keydown(keyEvent('x')); elements[id].listeners.keydown(keyEvent(' ', true));
        });
        check(picks === 4, 'wrong/repeated key activated instance picker');
    });
    await test('model select and Edit are native sibling buttons with isolated actions and selected state', function() {
        var selected = [], edited = [], env = { currentProvider: 'One', UI_ICONS: { model: 'M', edit: 'E' },
            escapeHtml: escapeHtml, escapeJsString: function(s) { return s.replace(/'/g, "\\'"); },
            selectModelFromMenu: function(n) { selected.push(n); }, editModelFromMenu: function(n) { edited.push(n); } };
        var row = new Function('env', 'with(env){' + declaration(notifications, '_modelRowMeta') + '\n' + declaration(notifications, '_modelMenuRowHtml') + '\nreturn _modelMenuRowHtml;}')(env);
        var html = row({ name: 'One', model: 'model', endpoint: 'https://anthropic.com', isClaudeOAuth: true });
        check(!/^<div[^>]+onclick=/.test(html), 'container still selects');
        var buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
        check(buttons.length === 2 && buttons.every(function(b) { return /type="button"/.test(b) && b.indexOf('<button', 1) < 0; }), 'native sibling structure invalid');
        check(/aria-pressed="true"/.test(buttons[0]) && /aria-label="Select model One"/.test(buttons[0]), 'selection state/name missing');
        runHandler(buttons[1].match(/onclick="([^"]*)"/)[1], {}, keyEvent(''), env);
        check(edited.join() === 'One' && !selected.length, 'Edit selected model');
        var css = sources['src/css/04-header.css'];
        check(/\.model-menu-row:focus-within \.model-row-edit\s*\{ opacity: 1; \}/.test(css), 'Edit invisible to keyboard focus');
        check(/\.model-row-select:focus-visible[^{]*\{ outline: 2px solid var\(--primary\)/.test(css), 'native keyboard focus outline missing');
        check(/\.model-menu \.custom-dropdown-option:hover\s*\{ background:/.test(css) && !/style=/.test(buttons[0]), 'native reset overrides hover styling');
        runHandler(buttons[0].match(/onclick="([^"]*)"/)[1], {}, keyEvent(''), env);
        check(selected.join() === 'One', 'native select click not wired');
        check(/aria-pressed="false"/.test(row({ name: 'Two', endpoint: '' })), 'unselected state missing');
    });
    await test('both subscription options are native buttons; popup keyboard entry and Escape are wired', function() {
        ['modelMenuOAuthToggle', 'modelMenuChatGPTOAuthToggle'].forEach(function(fn) {
            check(new RegExp('<button type="button" class="custom-dropdown-option"[^\n]*onclick="' + fn + '\\(\\)"').test(notifications), 'subscription option not native: ' + fn);
        });
        var toggle = declaration(notifications, 'toggleModelMenu');
        check(toggle.indexOf("event.type === 'keydown') menu.querySelector") >= 0 && toggle.indexOf("if (e.key === 'Escape')") >= 0 && toggle.indexOf('anchor.focus()') >= 0, 'popup keyboard focus lifecycle missing');
    });
    return results;
}
// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/app/050-image-attachments.js","src/js/app/040-send-message.js","src/js/ui/170-chat-management.js","src/js/ui/030-home-view.js","src/js/ui/050-history-view.js","src/js/ui/160-notifications.js","src/js/ui/250-message-render.js","src/js/core/055-emoji-shortcodes.js","src/platform/extension/platform-bridge.js","src/html/body.html","src/css/04-header.css"];
await registerRunner('reviewed-ui-regressions', async function() { return runReviewedUiAudit(await loadSources(PATHS)); });
