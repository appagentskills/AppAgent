// B6 — UI tests for the composer (chat + home), attachment chips, drag overlay,
// pause/resume while running, the chat-list sidebar (render, active item,
// pinned divider, status dots, search/filter, ⋯ menu, rename modal) and the
// home composer (recent prompts, fillHomeInput, Enter handling).
// REAL src modules (loadModules) render into the REAL sandbox document with
// src/html/body.html + real CSS; inline handlers are driven through the module
// scope with U.fireInline.
// Run: run_tests { files: ['test/canary.test.js','test/ui-composer-sidebar.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var CSS = ['src/css/00-tokens.css', 'src/css/02-layout.css', 'src/css/06-input.css'];
var BASE = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js'];
var SIDEBAR = BASE.concat(['src/js/ui/210-chat-menus.js']);
var COMPOSER = BASE.concat(['src/js/app/020-api-messages.js', 'src/js/app/040-send-message.js', 'src/js/app/050-image-attachments.js', 'src/js/ui/030-home-view.js']);
var ALLOW = ['isChatPaused', 'isChatRunning', '_isChatInSilentHook', 'renderSubAgentBreadcrumb', '_storageDegraded', 'buildDegradedChatListHtml',
    'dispatchChatMeta', 'ensureChatPayloads', 'renderHistoryPage', 'pushPauseToggleToOffscreen', 'pushInterruptToOffscreen', '_supersedeInterruptToggle',
    '_silentHookChats', '_agentBusPort', 'currentProvider', 'autoResizeTextarea', '_openAgentBus', 'smartDocuments', 'sdocOpenPreview', 'AgentEvents'];
var HOSTILE = '<img src=x onerror="window.__pwn=1">"\'';

function rec(impl) { return U.recorder(impl); }
function noop() {}
// Test-local stand-in for tools/120-actions.js escapeJsString (not under test here).
function escJs(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function sidebarGlobals(chats, extra) {
    var s = U.stubs();
    return Object.assign({
        chats: chats, currentChatId: null, currentView: 'chat', chatSearchQuery: '', skills: {}, TOOLS: [], dashboardWidgets: {},
        escapeJsString: escJs, chatActivityTs: function(c) { return c.updatedAt || 0; },
        chatHasPendingApproval: function() { return false; }, chatHasPendingItems: function() { return false; },
        // NOTE: no downloadChat stub — 210-chat-menus.js declares the real one, and a
        // module's own function declaration always shadows a scope stub.
        selectChat: rec(), deleteChat: rec(), togglePinChat: rec(), renderMessages: rec(), closeModal: rec(),
        showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage, updateChatTitleHeader: rec(),
        showToolInspector: rec(), toggleSkillsView: rec(), openSkillEditor: rec(), toggleDashboardView: rec(), handleSearchSnippetClick: undefined
    }, extra || {});
}
function chat(id, title, o) { return Object.assign({ id: id, title: title, messages: [{ role: 'user', content: 'hi ' + title }], updatedAt: 1 }, o || {}); }

async function mountSidebar(chats, extra) {
    var g = sidebarGlobals(chats, extra);
    if (g.handleSearchSnippetClick === undefined) delete g.handleSearchSnippetClick;
    var m = await U.loadUi(SIDEBAR, { globals: g, allowUnstubbed: ALLOW });
    var dom = await U.mountDom({ body: true, css: CSS });
    return { m: m, g: g, dom: dom, s: m.__scope };
}

function composerGlobals(extra) {
    var s = U.stubs();
    return Object.assign({
        chats: { c1: { id: 'c1', title: 'C1', messages: [] } }, currentChatId: 'c1', currentView: 'chat', chatSearchQuery: '', skills: {}, TOOLS: [], dashboardWidgets: {},
        escapeJsString: escJs, chatActivityTs: function() { return 0; }, chatHasPendingApproval: function() { return false; }, chatHasPendingItems: function() { return false; },
        pendingImageAttachments: [], chatPendingImages: {}, chatPendingTexts: {}, runningChatIds: {}, pausedChats: {}, paused: false,
        pendingInjection: null, pendingInjectionImages: null, pendingInjectionsByChatId: {}, userInterruptedChats: {},
        currentStreamAbortControllers: {}, interruptResolversByChatId: {}, currentEditingWidget: null, stickToBottom: false,
        activeStreamingChatId: null, isRunning: false,
        setSetting: rec(), getSetting: rec(function() { return Promise.resolve(null); }), updateHomePendingIndicator: rec(),
        renderMessages: rec(), showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage, runAgent: rec(function() { return Promise.resolve(); }),
        setChatPausedPersistent: rec(function(id, v) { if (v) U.__last.pausedChats[id] = true; else delete U.__last.pausedChats[id]; }),
        injectInterruptedToolResults: function() { return false; }, consumeWidgetComposerTarget: function() { return null; },
        updateChatTitle: rec(), registerFile: rec(), newFileId: function() { return 'file_x'; }, showSpinner: rec(), hideSpinner: rec(),
        // rejectPendingApprovalsForChat (020) and openPdfModal/openFileModal (050) are REAL
        // module functions — stubs here would be shadowed, so they are not stubbed.
        pendingToolApprovals: {},
        autoResizeTextarea: rec(), newChat: rec(), openScreenshotModal: rec(),
        selectChat: rec(), deleteChat: rec(), togglePinChat: rec(),
        init: noop // 050-image-attachments.js:746 `window.onload = init;` (core/120-init.js not loaded)
    }, extra || {});
}
async function mountComposer(extra) {
    var g = composerGlobals(extra);
    U.__last = g;
    var m = await U.loadUi(COMPOSER, { globals: g, allowUnstubbed: ALLOW });
    var dom = await U.mountDom({ body: true, css: CSS });
    return { m: m, g: g, dom: dom, s: m.__scope };
}
function img(name, o) { return Object.assign({ name: name, base64: 'data:image/png;base64,AAAA', width: 2, height: 3 }, o || {}); }

// ---------------------------------------------------------------- composer
describe('ui composer › Enter / Shift+Enter / IME', function() {
    afterEach(function() { U.cleanupAll(); });
    test('#message-input is wired to handleKeyDown and has an accessible name', async function() {
        var c = await mountComposer();
        var ta = c.dom.$('#message-input');
        assert.strictEqual(ta.tagName, 'TEXTAREA');
        assert.match(ta.getAttribute('onkeydown'), /handleKeyDown\(event\)/);
        assert.strictEqual(U.a11y(ta).hasName, true);
        var send = c.dom.$('#send-btn');
        assert.strictEqual(U.a11y(send).aria.label, 'Send message');
        assert.match(send.getAttribute('onclick'), /sendMessage\(\)/);
    }, { tags: ['unit'] });
    test('Enter sends (prevented, user row pushed, input cleared, runAgent once); Shift+Enter / IME do not', async function() {
        var c = await mountComposer();
        var ta = c.dom.$('#message-input');
        ta.value = 'line one';
        // fireInline builds a plain Event (no .key), so drive the real handler with real KeyboardEvents
        var ks = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
        c.m.handleKeyDown(ks);
        var ime = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true });
        c.m.handleKeyDown(ime);
        await U.flush();
        assert.strictEqual(ks.defaultPrevented, false, 'Shift+Enter keeps newline');
        assert.strictEqual(ime.defaultPrevented, false, 'IME commit not hijacked');
        assert.strictEqual(c.g.runAgent.calls.length, 0);
        assert.strictEqual(ta.value, 'line one');
        var ev = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
        c.m.handleKeyDown(ev);
        await U.flush();
        assert.strictEqual(ev.defaultPrevented, true);
        assert.strictEqual(c.g.runAgent.calls.length, 1);
        assert.deepStrictEqual(c.g.chats.c1.messages.map(function(x) { return x.role + ':' + x.content; }), ['user:line one']);
        assert.strictEqual(ta.value, '');
        assert.strictEqual(c.dom.$('#pause-btn').textContent, 'Pause');
    }, { tags: ['unit'] });
    test('empty / whitespace input with no attachments is a no-op', async function() {
        var c = await mountComposer();
        c.dom.$('#message-input').value = '   ';
        await c.m.sendMessage();
        assert.strictEqual(c.g.runAgent.calls.length, 0);
        assert.strictEqual(c.g.chats.c1.messages.length, 0);
    }, { tags: ['unit'] });
    test('draft is cleared on send and restored per context (draft prefill)', async function() {
        var c = await mountComposer();
        var ta = c.dom.$('#message-input');
        ta.value = 'draft A';
        c.m.savePendingTextForContext('c1');
        assert.strictEqual(c.s.chatPendingTexts.c1, 'draft A');
        ta.value = '';
        c.m.restorePendingTextForContext('c1');
        assert.strictEqual(ta.value, 'draft A');
        assert.strictEqual(c.g.autoResizeTextarea.calls[0][0], ta);
        await c.m.sendMessage();
        assert.strictEqual(c.s.chatPendingTexts.c1, undefined, 'draft deleted after send');
        c.m.restorePendingTextForContext('c1');
        assert.strictEqual(ta.value, '');
    }, { tags: ['unit'] });
});

describe('ui composer › running: queue + pause/resume', function() {
    afterEach(function() { U.cleanupAll(); });
    test('send while running queues into pendingInjectionsByChatId, clears input, posts to bus, shows "Interrupting…"', async function() {
        var port = { postMessage: rec() };
        var c = await mountComposer({ runningChatIds: { c1: true }, _agentBusPort: port, pushPauseToggleToOffscreen: rec(), _supersedeInterruptToggle: rec() });
        var ta = c.dom.$('#message-input');
        ta.value = 'first';
        await c.m.sendMessage();
        ta.value = 'second';
        await c.m.sendMessage();
        assert.strictEqual(c.s.pendingInjectionsByChatId.c1.text, 'first\n\nsecond', 'merged, never overwritten');
        assert.strictEqual(ta.value, '');
        assert.strictEqual(c.g.runAgent.calls.length, 0, 'no new run while running');
        assert.strictEqual(port.postMessage.calls.length, 2);
        assert.strictEqual(port.postMessage.calls[1][0].type, 'send-message');
        assert.strictEqual(c.g.showSpinner.calls[0][0], 'Interrupting…');
        assert.strictEqual(c.s.userInterruptedChats.c1, true);
    }, { tags: ['unit'] });
    test('pause button: hidden by default, visible while running (real CSS), label Pause⇄Resume, Continue mutually exclusive', async function() {
        var mine = { chatId: 'c1', approvalIndex: 0, resolve: rec() }, other = { chatId: 'zz', approvalIndex: 0, resolve: rec() };
        var c = await mountComposer({ pushPauseToggleToOffscreen: rec(), pushInterruptToOffscreen: rec(), _supersedeInterruptToggle: rec(),
            chats: { c1: { id: 'c1', title: 'C1', messages: [{ role: 'approval', status: 'pending' }] } }, pendingToolApprovals: { k1: mine, k2: other } });
        var pb = c.dom.$('#pause-btn'), cont = c.dom.$('#continue-btn');
        assert.strictEqual(U.css(pb, 'display'), 'none');
        c.m.showContinueButton();
        assert.strictEqual(cont.classList.contains('visible'), true);
        c.m.showPauseButton('c1');
        assert.strictEqual(pb.classList.contains('visible'), true);
        assert.strictEqual(U.css(pb, 'display'), 'flex');
        assert.strictEqual(cont.classList.contains('visible'), false, 'continue hidden when pause shown');
        assert.strictEqual(pb.textContent, 'Pause');
        U.fireInline(pb, 'click', c.m);
        assert.strictEqual(c.s.pausedChats.c1, true);
        assert.strictEqual(pb.textContent, 'Resume');
        assert.ok(pb.querySelector('.btn-icon svg'), 'icon');
        // real rejectPendingApprovalsForChat: only THIS chat's parked approval is denied + resolved(false)
        assert.strictEqual(c.g.chats.c1.messages[0].status, 'denied');
        assert.strictEqual(c.g.chats.c1.messages[0].deniedByPause, true);
        assert.deepStrictEqual(mine.resolve.calls, [[false]]);
        assert.strictEqual(other.resolve.calls.length, 0);
        assert.deepStrictEqual(Object.keys(c.s.pendingToolApprovals), ['k2']);
        assert.ok(c.g.saveChatsToStorage.calls.length >= 1, 'denial persisted');
        assert.strictEqual(c.g.pushPauseToggleToOffscreen.calls[0][1], true);
        U.fireInline(pb, 'click', c.m);
        assert.strictEqual(pb.textContent, 'Pause');
        assert.strictEqual(c.g.runAgent.calls.length, 1, 'resume of an idle paused chat restarts the run');
        c.m.hidePauseButton();
        assert.strictEqual(U.css(pb, 'display'), 'none');
    }, { tags: ['unit'] });
});

describe('ui composer › attachment chips + drag overlay', function() {
    afterEach(function() { U.cleanupAll(); });
    test('empty list hides both containers', async function() {
        var c = await mountComposer();
        c.m.renderPendingImages();
        ['#pending-images-container', '#home-pending-images-container'].forEach(function(sel) {
            assert.strictEqual(c.dom.$(sel).style.display, 'none', sel);
            assert.strictEqual(c.dom.$(sel).innerHTML, '');
        });
    }, { tags: ['unit'] });
    test('chips per type, hint pluralisation, hostile names escaped, mirrored to home container', async function() {
        var c = await mountComposer();
        c.s.pendingImageAttachments.push(img(HOSTILE), img('b.png'), { fileType: 'pdf', name: 'r<b>.pdf', base64: 'x' },
            { fileType: 'file', name: 'data.csv', content: 'a,b' }, { fileType: 'document', name: 'Doc <i>1</i>', sdocId: 'sd1' });
        c.m.renderPendingImages();
        var box = c.dom.$('#pending-images-container');
        assert.strictEqual(box.style.display, 'flex');
        assert.strictEqual(box.querySelectorAll('.pending-image-item').length, 5);
        assert.strictEqual(box.querySelectorAll('.pending-pdf-item').length, 1);
        assert.strictEqual(box.querySelectorAll('.pending-file-item').length, 2);
        assert.strictEqual(box.querySelector('.pending-pdf-name').textContent, 'r<b>.pdf');
        assert.strictEqual(box.querySelector('.pending-file-item .pending-file-label').textContent, 'CSV');
        assert.strictEqual(box.querySelector('img').getAttribute('alt'), HOSTILE, 'alt escaped, not injected');
        assert.strictEqual(box.querySelectorAll('img').length, 2);
        assert.strictEqual(box.querySelector('[onerror]'), null);
        assert.strictEqual(box.querySelector('b, i'), null);
        assert.strictEqual(box.querySelector('.pending-images-hint').textContent, '2 images, 1 PDF, 1 file, 1 document attached. Click to preview, or × to remove.');
        assert.strictEqual(c.dom.$('#home-pending-images-container').innerHTML, box.innerHTML);
        assert.strictEqual(c.g.setSetting.calls.slice(-1)[0][0], 'chatPendingImages', 'persisted');
    }, { tags: ['unit'] });
    test('× removes the right chip without opening preview; chip click previews', async function() {
        var c = await mountComposer();
        c.s.pendingImageAttachments.push(img('a.png'), img('b.png'), img('c.png'));
        c.m.renderPendingImages();
        var btn = c.dom.$$('#pending-images-container .pending-image-remove')[1];
        assert.strictEqual(btn.getAttribute('title'), 'Remove');
        var r = U.fireInline(btn, 'click', c.m);
        assert.strictEqual(r.stopped, true, 'stopPropagation so preview does not open');
        assert.deepStrictEqual(c.s.pendingImageAttachments.map(function(x) { return x.name; }), ['a.png', 'c.png']);
        assert.strictEqual(c.dom.$$('#pending-images-container .pending-image-item').length, 2);
        assert.match(c.dom.$('.pending-images-hint').textContent, /^2 images attached/);
        U.fireInline(c.dom.$$('#pending-images-container .pending-image-item')[1], 'click', c.m);
        assert.strictEqual(c.g.openScreenshotModal.calls.length, 1);
        assert.strictEqual(c.g.openScreenshotModal.calls[0][1], 'c.png (2×3)');
        U.fireInline(c.dom.$('#pending-images-container .pending-image-remove'), 'click', c.m);
        U.fireInline(c.dom.$('#pending-images-container .pending-image-remove'), 'click', c.m);
        assert.strictEqual(c.dom.$('#pending-images-container').style.display, 'none', 'last removal hides container');
    }, { tags: ['unit'] });
    test('chip × has an aria-label; image src is attribute-escaped (ordinary data URLs unchanged)', async function() {
        var c = await mountComposer();
        var ok = img('a.png'), bad = img('b.png'); bad.base64 = 'data:image/png;base64,AA" onerror="window.__pwn=1';
        c.s.pendingImageAttachments.push(ok, bad, { fileType: 'file', name: 'data.csv', content: 'a,b' });
        c.m.renderPendingImages();
        var box = c.dom.$('#pending-images-container');
        assert.deepStrictEqual(c.dom.$$('#pending-images-container .pending-image-remove').map(function(b) { return b.getAttribute('aria-label'); }), ['Remove', 'Remove', 'Remove']);
        var imgs = box.querySelectorAll('img');
        assert.strictEqual(imgs[0].getAttribute('src'), ok.base64, 'ordinary data URL untouched');
        assert.strictEqual(imgs[1].getAttribute('src'), bad.base64, 'quote stays inside src');
        assert.strictEqual(box.querySelector('[onerror]'), null);
    }, { tags: ['unit'] });
    test('attachment-only send pushes user label + screenshot row and clears chips', async function() {
        var c = await mountComposer();
        c.s.pendingImageAttachments.push(img('a.png'));
        c.m.renderPendingImages();
        await c.m.sendMessage();
        var msgs = c.g.chats.c1.messages;
        assert.strictEqual(msgs[0].content, '[User attached 1 image(s)]');
        assert.strictEqual(msgs[1].role, 'screenshot');
        assert.strictEqual(c.s.pendingImageAttachments.length, 0);
        assert.strictEqual(c.dom.$('#pending-images-container').style.display, 'none');
    }, { tags: ['unit'] });
    test('drag overlay: nested enter/leave depth, drop hides it', async function() {
        var c = await mountComposer();
        var ov = c.dom.$('#drop-overlay');
        function ev() { return { prevented: 0, preventDefault: function() { this.prevented++; }, stopPropagation: noop }; }
        assert.strictEqual(U.css(ov, 'display'), 'none');
        c.m.handleDragEnter(ev()); c.m.handleDragEnter(ev());
        assert.strictEqual(ov.classList.contains('visible'), true);
        assert.strictEqual(U.css(ov, 'display'), 'flex');
        c.m.handleDragLeave(ev());
        assert.strictEqual(ov.classList.contains('visible'), true, 'still inside a child');
        c.m.handleDragLeave(ev());
        assert.strictEqual(ov.classList.contains('visible'), false);
        c.m.handleDragEnter(ev());
        var d = ev(); d.dataTransfer = { files: [] };
        c.m.handleDrop(d);
        assert.strictEqual(d.prevented, 1);
        assert.strictEqual(ov.classList.contains('visible'), false);
        c.m.handleDragEnter(ev());
        assert.strictEqual(ov.classList.contains('visible'), true, 'depth reset by drop');
    }, { tags: ['unit'] });
});

describe('ui composer › home composer', function() {
    afterEach(function() { U.cleanupAll(); });
    test('recent prompts: first user msg per chat, newest first, dedup, skips sub-agent/background', async function() {
        var chats = {
            a: { id: 'a', createdAt: 1, messages: [{ role: 'user', content: 'old' }] },
            b: { id: 'b', createdAt: 3, messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: ' new ' }, { role: 'user', content: 'second' }] },
            c: { id: 'c', createdAt: 2, messages: [{ role: 'user', content: 'new' }] },
            s: { id: 's', createdAt: 9, isSubAgent: true, messages: [{ role: 'user', content: 'You are a sub' }] },
            g: { id: 'g', createdAt: 8, isBackground: true, messages: [{ role: 'user', content: 'Run action: x' }] }
        };
        var c = await mountComposer({ chats: chats });
        assert.deepStrictEqual(c.m.getRecentUserPrompts(5), [{ text: 'new', chatId: 'b' }, { text: 'old', chatId: 'a' }]);
        assert.strictEqual(c.m.getRecentUserPrompts(1).length, 1);
        assert.strictEqual(c.m.truncateText('a\nb c', 3), 'a b...');
    }, { tags: ['unit'] });
    test('fillHomeInput prefills, focuses and persists the home draft', async function() {
        var c = await mountComposer();
        var ta = c.dom.$('#home-message-input');
        var focused = 0; ta.focus = function() { focused++; };
        c.m.fillHomeInput('Hello <b>');
        assert.strictEqual(ta.value, 'Hello <b>');
        assert.strictEqual(focused, 1);
        assert.strictEqual(c.s.chatPendingTexts.home, 'Hello <b>');
        assert.strictEqual(c.g.setSetting.calls.slice(-1)[0][0], 'chatPendingTexts');
    }, { tags: ['unit'] });
    test('home Enter creates a chat and forwards text to the chat composer; Shift+Enter does not', async function() {
        var c = await mountComposer({ currentView: 'home' });
        var ta = c.dom.$('#home-message-input');
        assert.match(ta.getAttribute('onkeydown'), /handleHomeKeyDown\(event\)/);
        ta.value = 'from home';
        var sh = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
        c.m.handleHomeKeyDown(sh);
        assert.strictEqual(sh.defaultPrevented, false);
        assert.strictEqual(c.g.newChat.calls.length, 0);
        var ev = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
        c.m.handleHomeKeyDown(ev);
        await U.flush();
        assert.strictEqual(ev.defaultPrevented, true);
        assert.strictEqual(c.g.newChat.calls.length, 1);
        assert.strictEqual(ta.value, '');
        assert.strictEqual(c.g.chats.c1.messages[0].content, 'from home');
    }, { tags: ['unit'] });
    test('home composer Enter is ignored during IME composition (isComposing/keyCode 229 guard, same as handleKeyDown)', async function() {
        var c = await mountComposer({ currentView: 'home' });
        c.dom.$('#home-message-input').value = 'にほん';
        var ev = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true });
        c.m.handleHomeKeyDown(ev);
        assert.strictEqual(ev.defaultPrevented, false);
        assert.strictEqual(c.g.newChat.calls.length, 0);
    }, { tags: ['unit'] });
});

// ---------------------------------------------------------------- renderHome sections
// renderHome (030) owns the section CHROME for pinned widgets + active chats and hands the
// fill to renderHomeDashboard (ui/070) / renderHomeActiveChats (tools/120) — those two are
// stubbed here (their own logic is covered by their module tests).
function homeGlobals(o) {
    return Object.assign({ currentView: 'home', renderActionsForPlacement: rec(function() { return ''; }),
        getBootCachedCredits: function() { return '$1 <b>'; }, getSystemPromptTokenCount: function() { return 1500; },
        toggleHomeDashboardExpanded: rec(), handleWidgetDragOver: rec(), handleWidgetDrop: rec(),
        toggleSkillsView: rec(), toggleDashboardView: rec(), openBrowser: rec(), toggleDocsView: rec(), toggleSettingsView: rec() }, o || {});
}
describe('ui composer › renderHome pinned widgets + active chats', function() {
    afterEach(function() { U.cleanupAll(); });
    test('sections render hidden + wired, in order (widgets → active chats → cards → stats), then handed to their renderers', async function() {
        var seen = {};
        var c = await mountComposer(homeGlobals({ dashboardWidgets: { w1: { title: 'W' } }, skills: { s: {} }, TOOLS: [{}, {}],
            renderHomeDashboard: rec(function() { var s = document.getElementById('home-dashboard-section'); seen.dash = s && s.style.display; seen.grid = !!document.getElementById('home-dashboard-grid'); }),
            renderHomeActiveChats: rec(function() { var el = document.getElementById('home-active-chats'); seen.active = el && el.style.display; }) }));
        c.m.renderHome();
        c.m.stopHomeTrailAnimation();
        assert.strictEqual(c.g.renderHomeDashboard.calls.length, 1);
        assert.strictEqual(c.g.renderHomeActiveChats.calls.length, 1);
        assert.deepStrictEqual(seen, { dash: 'none', grid: true, active: 'none' }, 'containers exist + hidden when renderers run');
        var sec = c.dom.$('#home-dashboard-section'), ac = c.dom.$('#home-active-chats'), cards = c.dom.$('#home-cards'), stats = c.dom.$('#home-stats');
        [[sec, ac], [ac, cards], [cards, stats]].forEach(function(p) { assert.ok(p[0].compareDocumentPosition(p[1]) & Node.DOCUMENT_POSITION_FOLLOWING); });
        assert.strictEqual(U.css(sec, 'display'), 'none');
        assert.strictEqual(U.css(ac, 'display'), 'none');
        assert.strictEqual(sec.querySelector('.home-section-label').textContent, 'Pinned widgets');
        var btn = c.dom.$('#home-dashboard-expand-btn');
        assert.strictEqual(U.a11y(btn).aria.label, 'Expand pinned widgets');
        assert.strictEqual(btn.getAttribute('title'), 'Expand');
        U.fireInline(btn, 'click', c.m);
        assert.strictEqual(c.g.toggleHomeDashboardExpanded.calls.length, 1);
        var grid = c.dom.$('#home-dashboard-grid');
        assert.strictEqual(grid.className, 'dashboard-grid home-dashboard-grid');
        var dov = U.fireInline(grid, 'dragover', c.m), drp = U.fireInline(grid, 'drop', c.m);
        assert.strictEqual(c.g.handleWidgetDragOver.calls[0][0], dov.event);
        assert.strictEqual(c.g.handleWidgetDrop.calls[0][0], drp.event);
        assert.deepStrictEqual(c.g.renderActionsForPlacement.calls[0], ['home', 'placement-home']);
        assert.strictEqual(c.dom.$('#home-actions-row'), null, 'no actions → no row');
        assert.strictEqual(c.dom.$$('.home-example-chip').length, 4, 'example chips fallback');
        assert.deepStrictEqual(c.dom.$$('#home-stats .home-stat-value').map(function(v) { return v.textContent; }), ['1', '1', '1', '2', '1.5k', '$1 <b>', 'N/A']);
        assert.strictEqual(stats.querySelector('b'), null, 'credits escaped');
        var hc = c.dom.$$('#home-cards .home-card');
        assert.deepStrictEqual(hc.map(function(h) { return U.a11y(h).aria.label; }), ['Open AI Skills', 'Open Dashboard', 'Open Browse with AI', 'Open Documentation', 'Open Settings']);
        assert.ok(hc.every(function(h) { return h.getAttribute('role') === 'button' && U.a11y(h).focusable; }));
        U.fireInline(hc[1], 'click', c.m);
        assert.strictEqual(c.g.toggleDashboardView.calls.length, 1);
    }, { tags: ['unit'] });
    test('a throwing section renderer does not break home; re-render keeps one section each; actions row replaces chips; recent chip fills input', async function() {
        var chats = { c1: { id: 'c1', title: 'C1', createdAt: 1, messages: [{ role: 'user', content: 'Hi <b>there</b>' }] } };
        var c = await mountComposer(homeGlobals({ chats: chats,
            collectActionsForPlacement: function() { return [{ id: 'a1' }]; },
            renderActionsForPlacement: rec(function() { return '<button class="action-pill">Run A</button>'; }),
            renderHomeDashboard: rec(function() { throw new Error('boom'); }), renderHomeActiveChats: rec(function() { throw new Error('boom'); }) }));
        c.m.renderHome();
        c.m.renderHome();
        c.m.stopHomeTrailAnimation();
        assert.strictEqual(c.g.renderHomeDashboard.calls.length, 2);
        assert.strictEqual(c.dom.$$('#home-dashboard-section').length, 1);
        assert.strictEqual(c.dom.$$('#home-active-chats').length, 1);
        assert.strictEqual(c.dom.$$('#home-cards .home-card').length, 5, 'rest of home still rendered');
        assert.strictEqual(c.dom.$('#home-actions-row .action-pill').textContent, 'Run A');
        assert.strictEqual(c.dom.$$('.home-example-chip').length, 0, 'actions replace example chips');
        var chip = c.dom.$('#home-recent-prompts .home-prompt-chip');
        assert.strictEqual(chip.textContent, 'Hi <b>there</b>');
        assert.strictEqual(chip.querySelector('b'), null);
        U.fireInline(chip, 'click', c.m);
        assert.strictEqual(c.dom.$('#home-message-input').value, 'Hi <b>there</b>');
    }, { tags: ['unit'] });
});

// ---------------------------------------------------------------- sidebar
describe('ui sidebar › chat list render', function() {
    afterEach(function() { U.cleanupAll(); });
    test('empty state: no chats → empty list; chats with no messages / sub-agents hidden', async function() {
        var t = await mountSidebar({ e: chat('e', 'Empty', { messages: [] }), s: chat('s', 'Sub', { isSubAgent: true }), b: chat('b', 'Bg', { isBackground: true }) });
        t.m.renderChatList();
        assert.strictEqual(t.dom.$('#chat-list').children.length, 0);
    }, { tags: ['unit'] });
    test('pinned first + divider, recency order, active item, escaped titles, status dots, action badge', async function() {
        var chats = {
            a: chat('a', 'Alpha ' + HOSTILE, { updatedAt: 5 }), b: chat('b', 'Beta', { updatedAt: 9 }), p: chat('p', 'Pinned', { pinned: true, updatedAt: 1 }),
            x: chat('x', 'Action', { isBackground: true, actionId: 'act1', updatedAt: 2 })
        };
        var t = await mountSidebar(chats, { currentChatId: 'a', chatHasPendingItems: function(id) { return id === 'b'; },
            chatHasPendingApproval: function(id) { return id === 'x'; }, isChatRunning: function(id) { return id === 'b' || id === 'x'; } });
        t.m.renderChatList();
        var list = t.dom.$('#chat-list');
        var items = t.dom.$$('#chat-list > .chat-item');
        assert.deepStrictEqual(items.map(function(i) { return i.querySelector('.chat-title').textContent; }), ['Pinned', 'Beta', 'Alpha ' + HOSTILE, 'Action']);
        assert.strictEqual(list.children[1].className, 'chat-list-divider');
        assert.ok(items[0].querySelector('.pin-icon'), 'pin icon');
        assert.strictEqual(items[1].querySelector('.pin-icon'), null);
        assert.deepStrictEqual(items.map(function(i) { return i.classList.contains('active'); }), [false, false, true, false]);
        assert.strictEqual(list.querySelector('img, [onerror]'), null);
        assert.ok(items[1].querySelector('.chat-streaming-dot') && items[1].querySelector('.chat-pending-dot'));
        assert.ok(items[3].querySelector('.chat-attention-dot'));
        assert.strictEqual(items[3].querySelector('.chat-streaming-dot'), null, 'attention dot suppresses streaming dot');
        assert.ok(items[3].querySelector('.chat-action-badge svg'));
        U.fireInline(items[1], 'click', t.m);
        assert.deepStrictEqual(t.g.selectChat.calls, [['b']]);
    }, { tags: ['unit'] });
    test('no active highlight outside chat view; paused chat shows no streaming dot', async function() {
        var t = await mountSidebar({ a: chat('a', 'A') }, { currentChatId: 'a', currentView: 'home', isChatRunning: function() { return true; }, isChatPaused: function() { return true; } });
        t.m.renderChatList();
        var it = t.dom.$('.chat-item');
        assert.strictEqual(it.classList.contains('active'), false);
        assert.strictEqual(it.querySelector('.chat-streaming-dot'), null);
    }, { tags: ['unit'] });
});

describe('ui sidebar › ⋯ menu + rename', function() {
    afterEach(function() { U.cleanupAll(); });
    test('menu toggles open (real CSS display), only one open at a time, survives re-render, outside click closes', async function() {
        var t = await mountSidebar({ a: chat('a', 'A', { updatedAt: 2 }), b: chat('b', 'B') });
        t.m.renderChatList();
        var btnA = t.dom.$('#chat-dropdown-a').previousElementSibling;
        assert.strictEqual(btnA.getAttribute('title'), 'More options');
        assert.strictEqual(U.css(t.dom.$('#chat-dropdown-a'), 'display'), 'none');
        var r = U.fireInline(btnA, 'click', t.m);
        assert.strictEqual(r.stopped, true, 'does not select the chat');
        assert.strictEqual(t.g.selectChat.calls.length, 0);
        assert.strictEqual(t.dom.$('#chat-dropdown-a').classList.contains('open'), true);
        assert.strictEqual(U.css(t.dom.$('#chat-dropdown-a'), 'display'), 'block');
        U.fireInline(t.dom.$('#chat-dropdown-b').previousElementSibling, 'click', t.m);
        assert.strictEqual(t.dom.$('#chat-dropdown-a').classList.contains('open'), false);
        assert.strictEqual(t.dom.$('#chat-dropdown-b').classList.contains('open'), true);
        t.m.renderChatList();
        assert.strictEqual(t.dom.$('#chat-dropdown-b').classList.contains('open'), true, 'kept open across rebuild');
        U.fireInline(t.dom.$('#chat-dropdown-b').previousElementSibling, 'click', t.m);
        assert.strictEqual(t.dom.$$('.chat-dropdown.open').length, 0, 'second click closes');
        U.fireInline(btnA = t.dom.$('#chat-dropdown-a').previousElementSibling, 'click', t.m);
        t.dom.$('#message-input').click();
        assert.strictEqual(t.dom.$$('.chat-dropdown.open').length, 0, 'document click outside closes');
    }, { tags: ['unit'] });
    test('menu items: labels, pin label reflects state, each routes to its action and closes the menu', async function() {
        var fakeURL = { createObjectURL: rec(function() { return 'blob:ui-test'; }), revokeObjectURL: rec() };
        var t = await mountSidebar({ p: chat('p', 'P', { pinned: true }) }, { URL: fakeURL });
        t.m.renderChatList();
        var dd = t.dom.$('#chat-dropdown-p');
        var items = Array.prototype.slice.call(dd.querySelectorAll('.chat-dropdown-item'));
        assert.deepStrictEqual(items.map(function(b) { return b.textContent; }), ['Rename', 'Download', 'Unpin Chat', 'Delete']);
        assert.strictEqual(items[3].classList.contains('danger'), true);
        dd.classList.add('open');
        U.fireInline(items[2], 'click', t.m);
        assert.deepStrictEqual(t.g.togglePinChat.calls, [['p']]);
        assert.strictEqual(dd.classList.contains('open'), false);
        // Download: REAL downloadChat (210) — capture the synthetic <a download> click and cancel it
        var dl = [];
        function grab(e) { var a = e.target; if (a && a.tagName === 'A' && a.hasAttribute('download')) { e.preventDefault(); dl.push({ href: a.getAttribute('href'), name: a.getAttribute('download') }); } }
        document.addEventListener('click', grab, true);
        try {
            dd.classList.add('open');
            U.fireInline(items[1], 'click', t.m);
            await U.flush();
        } finally { document.removeEventListener('click', grab, true); }
        assert.strictEqual(dd.classList.contains('open'), false);
        assert.strictEqual(dl.length, 1);
        assert.strictEqual(dl[0].href, 'blob:ui-test');
        assert.match(dl[0].name, /^chat_P_\d{4}-\d{2}-\d{2}\.json$/);
        var blob = fakeURL.createObjectURL.calls[0][0];
        assert.strictEqual(blob.type, 'application/json');
        var exp = JSON.parse(await blob.text());
        assert.strictEqual(exp.exportType, 'single_chat');
        assert.strictEqual(exp.chat.id, 'p');
        assert.deepStrictEqual(fakeURL.revokeObjectURL.calls, [['blob:ui-test']]);
        assert.strictEqual(document.querySelector('a[download]'), null, 'temp anchor removed');
        assert.deepStrictEqual(t.g.showSnackbar.calls.slice(-1)[0], ['Chat downloaded', 'success']);
        var del = U.fireInline(items[3], 'click', t.m);
        assert.strictEqual(t.g.deleteChat.calls[0][0], 'p');
        assert.strictEqual(t.g.deleteChat.calls[0][1], del.event);
        assert.strictEqual(t.g.selectChat.calls.length, 0);
    }, { tags: ['unit'] });
    test('rename modal: prefilled + escaped value, empty name rejected, valid name applied via dispatchChatMeta', async function() {
        var chats = { a: chat('a', 'Old "q" <b>') };
        var t = await mountSidebar(chats, { currentChatId: 'a', dispatchChatMeta: rec(function(id, meta) { chats[id].title = meta.title; }) });
        t.m.renderChatList();
        U.fireInline(t.dom.$('#chat-dropdown-a .chat-dropdown-item'), 'click', t.m);
        assert.strictEqual(t.dom.$('#modal-overlay').classList.contains('show'), true);
        assert.strictEqual(t.dom.$('#modal-header').textContent, 'Rename Chat');
        var inp = t.dom.$('#rename-chat-input');
        assert.strictEqual(inp.value, 'Old "q" <b>');
        var btns = t.dom.$$('#modal-actions .modal-btn');
        assert.deepStrictEqual(btns.map(function(b) { return b.textContent; }), ['Cancel', 'Rename']);
        inp.value = '   ';
        U.fireInline(btns[1], 'click', t.m);
        assert.deepStrictEqual(t.g.showSnackbar.calls[0], ['Please enter a valid name', 'error']);
        assert.strictEqual(t.g.closeModal.calls.length, 0, 'modal stays open');
        inp.value = '  New <i>name</i> ';
        U.fireInline(btns[1], 'click', t.m);
        assert.deepStrictEqual(t.s.dispatchChatMeta.calls[0], ['a', { title: 'New <i>name</i>' }]);
        assert.strictEqual(t.g.closeModal.calls.length, 1);
        assert.strictEqual(t.g.updateChatTitleHeader.calls.length, 1, 'header refreshed for current chat');
        assert.strictEqual(t.dom.$('.chat-title').textContent, 'New <i>name</i>');
        assert.strictEqual(t.dom.$('#chat-list i'), null);
        U.fireInline(btns[0], 'click', t.m);
        assert.strictEqual(t.g.closeModal.calls.length, 2, 'Cancel closes');
    }, { tags: ['unit'] });
});

describe('ui sidebar › search', function() {
    afterEach(function() { U.cleanupAll(); });
    test('typing toggles .searching immediately and filters after debounce; snippets escaped + bolded; clear restores', async function() {
        var chats = {
            a: chat('a', 'Alpha', { messages: [{ role: 'user', content: 'find the <b>needle</b> here' }, { role: 'assistant', content: 'NEEDLE again' }] }),
            b: chat('b', 'Beta', { messages: [{ role: 'user', content: 'nothing' }] })
        };
        var t = await mountSidebar(chats);
        var si = t.dom.$('#chat-search-input');
        assert.strictEqual(U.a11y(si).aria.label, 'Search chats');
        si.value = 'needle';
        U.fireInline(si, 'input', t.m);
        assert.strictEqual(t.dom.$('#sidebar').classList.contains('searching'), true);
        await new Promise(function(r) { setTimeout(r, 320); });
        var items = t.dom.$$('#chat-list > .chat-item');
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].classList.contains('searching'), true);
        assert.match(items[0].querySelector('.chat-result-title').textContent, /Alpha \(2 matches\)/);
        var snips = items[0].querySelectorAll('.chat-result-snippet-item');
        assert.strictEqual(snips.length, 2);
        assert.strictEqual(snips[0].querySelector('strong').textContent, 'needle');
        assert.match(snips[0].querySelector('.snippet-text').textContent, /<b>/);
        assert.strictEqual(items[0].querySelector('.snippet-text b'), null);
        assert.match(snips[0].querySelector('.snippet-type').textContent, /You/);
        assert.match(snips[1].querySelector('.snippet-type').textContent, /AI/);
        t.m.clearGlobalSearch();
        assert.strictEqual(si.value, '');
        assert.strictEqual(t.dom.$('#sidebar').classList.contains('searching'), false);
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 2);
        assert.strictEqual(t.g.renderMessages.calls.length, 1, 'messages re-rendered to drop highlights');
    }, { tags: ['unit'] });
    test('1-char query does not filter; skills/tools/widgets sections appear with headers', async function() {
        var t = await mountSidebar({ a: chat('a', 'Alpha') }, { chatSearchQuery: 'x',
            skills: { s1: { id: 's1', name: 'Zeta <b>skill</b>' } }, dashboardWidgets: { w: { title: 'zeta board' } } });
        t.m.renderChatList();
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 1, 'short query shows everything');
        t.s.chatSearchQuery = 'zeta';
        t.m.renderChatList();
        var heads = t.dom.$$('.search-section-header').map(function(h) { return h.textContent.trim(); });
        assert.deepStrictEqual(heads, ['Skills', 'Widgets', 'Chats']);
        assert.strictEqual(t.dom.$('.search-result-text').textContent, 'Zeta <b>skill</b>');
        assert.strictEqual(t.dom.$('#chat-list b'), null);
        assert.strictEqual(t.dom.$$('#chat-list > .chat-item').length, 0);
    }, { tags: ['unit'] });
    test('search snippet label escapes the tool name (renderChatItem typeLabel)', async function() {
        var bad = '<img src=x onerror=1>';
        var t = await mountSidebar({ a: chat('a', 'A', { messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: bad, arguments: '{"q":"needle"}' } }] }] }) }, { chatSearchQuery: 'needle' });
        t.m.renderChatList();
        assert.strictEqual(t.dom.$('#chat-list img'), null);
        assert.match(t.dom.$('#chat-list .snippet-type').textContent, /<img src=x onerror=1>/);
    }, { tags: ['unit'] });
});
