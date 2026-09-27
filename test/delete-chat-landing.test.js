// A2B3-02 — deleting the OPEN chat lands on a fresh chat (newChat()), never on
// another existing chat, and never stamps another chat's lastViewedAt/updatedAt.
// Run: run_tests { files: ['test/delete-chat-landing.test.js'] }
// The REAL deleteChat / newChat / selectChat declarations from src/ run against an
// in-memory env (fake DOM; stubbed modal, save and SW notify). Nothing here touches
// a live chat, the service worker, IndexedDB or settings.
'use strict';

var DCL_NAV = 'src/js/ui/170-chat-management.js';
var DCL_PATHS = [DCL_NAV, 'src/js/ui/030-home-view.js', 'src/js/ui/040-tools-settings.js',
    'src/js/core/120-init.js', 'src/js/ui/060-docs-view.js'];
var DCL_EXISTING = ['a_oldest', 'chat_sub_x', 'cur'];
var _dclSrc = null;

async function dclSources() {
    if (_dclSrc) return _dclSrc;
    var src = {};
    for (var i = 0; i < DCL_PATHS.length; i++) src[DCL_PATHS[i]] = await loadFile(DCL_PATHS[i]);
    _dclSrc = src;
    return src;
}

// Column-zero closing-brace convention (same as test/chat-navigation-state.test.js).
function dclDeclaration(source, header) {
    var start = source.indexOf(header + '(');
    var end = source.indexOf('\n}', start);
    if (!(start >= 0 && end > start)) throw new Error('Missing declaration: ' + header);
    var code = source.slice(start, end + 2);
    new Function(code); // Syntax-check the exact excerpt before executing it.
    return code;
}

function dclIsExisting(id) { return DCL_EXISTING.indexOf(id) >= 0; }

function dclFixture(src, openChatId) {
    var calls = { newChat: 0, selectChat: [], renderChatList: 0, saves: 0, notified: [],
        metaWrites: [], focused: [], timers: [] };
    var elements = {};
    function element(id) {
        if (!elements[id]) {
            var classes = new Set();
            elements[id] = { style: {}, value: '', focus: function() {},
                classList: { add: function(c) { classes.add(c); }, remove: function(c) { classes.delete(c); },
                    contains: function(c) { return classes.has(c); } } };
        }
        return elements[id];
    }
    // NEW-T21-1: backing store of the appStorage stub below (localStorage semantics).
    var store = { scrollPos_cur: '120', scrollPos_a_oldest: '40' };
    var env = {
        currentView: 'chat', currentChatId: openChatId,
        // Insertion order = the old first-key pick: the oldest chat comes first,
        // and a hidden sub-agent chat is next.
        chats: {
            a_oldest: { id: 'a_oldest', title: 'Oldest', messages: [{ role: 'user', content: 'old' }], lastViewedAt: 1, updatedAt: 1 },
            chat_sub_x: { id: 'chat_sub_x', title: 'Sub', messages: [], isSubAgent: true },
            cur: { id: 'cur', title: 'Current', messages: [{ role: 'user', content: 'cur' }], lastViewedAt: 3 }
        },
        dashboardWidgets: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
        activeStreamingChatId: null, isRunning: false, pendingInjection: null, pendingInjectionImages: null,
        pendingImageAttachments: [], lastApiError: null, versionHistory: [],
        currentEditingSkill: null, currentEditingWidget: null, activeWidgetStreamingId: null,
        sidebarCollapsed: true, window: { currentSearchHighlight: null, innerWidth: 1024 },
        document: { getElementById: element, body: element('body') },
        history: { state: null, length: 1, back: function() {} },
        appStorage: {
            getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function(k, v) { store[k] = String(v); },
            removeItem: function(k) { delete store[k]; }
        },
        // NEW-T15-2: in-memory pause flags (core/030-config.js pausedChats).
        pausedChats: { cur: true, a_oldest: true },
        generateId: function() { return 'fresh'; },
        getCurrentPendingContext: function() { return env.currentChatId || 'none'; },
        savePendingImagesForContext: function() {},
        savePendingTextForContext: function() {},
        dispatchChatMeta: function(id, meta) { calls.metaWrites.push(id); if (env.chats[id]) Object.assign(env.chats[id], meta); },
        clearUnseenFinishedChat: function() {},
        pushFocusChatToOffscreen: function(id) { calls.focused.push(id); },
        renderMessages: function() {},
        hidePauseButton: function() {},
        showPauseButton: function() {},
        _isChatInSilentHook: function() { return false; },
        escapeHtml: function(s) { return String(s); },
        showModal: function() { return Promise.resolve('delete'); }, // the user confirms
        _pruneChatPermissionGrants: function() {},
        _notifyWorkerChatDeleted: function(id) { calls.notified.push(id); return true; },
        saveChatsToStorage: function() { calls.saves++; },
        renderChatList: function() { calls.renderChatList++; },
        renderHistoryPage: function() {},
        showSnackbar: function() {},
        setTimeout: function(fn, ms) { calls.timers.push(ms); return 0; } // never runs the 3s retry
    };
    ('hideContinueButton hideRetryButton hideSnackbar clearUpdateSet renderVersionSidebar updateChatTitleHeader ' +
        'updateInputPosition renderPendingImages pushHistoryState stopHomeTrailAnimation updateAllButtonStates ' +
        'updateSkillsButtonState updateDashboardButtonState replaceHistoryState refreshContinueButtonForChat ' +
        'loadVersionHistory restorePendingImagesForContext restorePendingTextForContext ' +
        'showPendingApprovalNotifications hideAllPanels toggleSidebar').split(' ').forEach(function(name) {
        env[name] = function() {};
    });
    // Real newChat / selectChat (plus the view helpers they may call), wrapped as spies,
    // so the old first-key pick would really stamp the chat it opens.
    var real = new Function('env', 'with (env) {\n' + [
        dclDeclaration(src[DCL_NAV], 'function newChat'),
        dclDeclaration(src[DCL_NAV], 'function selectChat'),
        dclDeclaration(src['src/js/ui/030-home-view.js'], 'function closeHomeView'),
        dclDeclaration(src['src/js/ui/040-tools-settings.js'], 'function showChatView'),
        dclDeclaration(src['src/js/ui/040-tools-settings.js'], 'function closeSettingsPageView'),
        dclDeclaration(src['src/js/core/120-init.js'], 'function closeSkillsView'),
        dclDeclaration(src['src/js/ui/060-docs-view.js'], 'function closeDashboardView')
    ].join('\n') + '\nreturn { newChat: newChat, selectChat: selectChat };\n}')(env);
    env.newChat = function() { calls.newChat++; return real.newChat.apply(null, arguments); };
    env.selectChat = function(id) { calls.selectChat.push(id); return real.selectChat.apply(null, arguments); };
    var deleteChat = new Function('env', 'with (env) {\n' +
        dclDeclaration(src[DCL_NAV], 'async function deleteChat') + '\nreturn deleteChat;\n}')(env);
    return { env: env, calls: calls, deleteChat: deleteChat };
}

test('A2B3-02: deleteChat of the open chat lands on a new chat, never an existing one', async function() {
    var f = dclFixture(await dclSources(), 'cur');
    var others = JSON.stringify({ a_oldest: f.env.chats.a_oldest, chat_sub_x: f.env.chats.chat_sub_x });
    await f.deleteChat('cur', { stopPropagation: function() {} });
    assert.strictEqual(f.calls.newChat, 1, 'deleting the open chat must land on newChat() exactly once');
    assert.deepStrictEqual(f.calls.selectChat.filter(dclIsExisting), [], 'selectChat opened an existing chat');
    assert.strictEqual(f.env.chats.a_oldest.lastViewedAt, 1, 'the oldest chat was stamped as viewed');
    assert.strictEqual(JSON.stringify({ a_oldest: f.env.chats.a_oldest, chat_sub_x: f.env.chats.chat_sub_x }), others,
        'another existing chat was written (lastViewedAt/updatedAt/...)');
    assert.deepStrictEqual(f.calls.metaWrites.filter(dclIsExisting), [], 'chat-meta written for an existing chat');
    assert.deepStrictEqual(f.calls.focused.filter(dclIsExisting), [], 'an existing chat was focused');
    assert.strictEqual('cur' in f.env.chats, false, 'the deleted chat is still in the map');
    assert.strictEqual(f.env.currentChatId, 'fresh', 'did not land on the fresh chat');
    assert.strictEqual(f.env.chats.fresh.isTemporary, true, 'landing chat is not a fresh temporary chat');
    assert.deepStrictEqual(f.calls.notified, ['cur'], 'SW tombstone not sent for the deleted chat');
    assert.strictEqual(f.calls.saves, 1, 'save not run once');
}, { tags: ['unit'], timeout: 2000 });

test('A2B3-02: deleteChat of a non-open chat keeps the open chat', async function() {
    var f = dclFixture(await dclSources(), 'a_oldest');
    await f.deleteChat('cur', { stopPropagation: function() {} });
    assert.strictEqual(f.calls.newChat, 0, 'newChat ran for a non-open delete');
    assert.deepStrictEqual(f.calls.selectChat, [], 'selectChat ran for a non-open delete');
    assert.strictEqual(f.env.currentChatId, 'a_oldest', 'the open chat changed');
    assert.strictEqual(f.calls.renderChatList, 1, 'the sidebar was not re-rendered once');
    assert.strictEqual('cur' in f.env.chats, false, 'the deleted chat is still in the map');
    assert.strictEqual(f.env.chats.a_oldest.lastViewedAt, 1, 'the open chat was re-stamped');
}, { tags: ['unit'], timeout: 2000 });

test('A2B3-02: deleteChat has no first-key pick and its open-chat branch calls newChat()', async function() {
    var code = dclDeclaration((await dclSources())[DCL_NAV], 'async function deleteChat');
    assert.strictEqual(code.indexOf('Object.keys(chats)'), -1, 'deleteChat still reads Object.keys(chats)');
    assert.strictEqual(code.indexOf('selectChat(ids[0])'), -1, 'deleteChat still opens the first chat key');
    var start = code.indexOf('if (currentChatId === chatId) {');
    var end = code.indexOf('} else renderChatList();', start);
    assert.ok(start >= 0 && end > start, 'open-chat branch shape changed');
    var branch = code.slice(start, end).split('\n')
        .filter(function(line) { return !/^\s*\/\//.test(line); }).join('\n');
    assert.match(branch, /\bnewChat\(\);/, 'open-chat branch does not call newChat()');
    assert.strictEqual(/selectChat\(/.test(branch), false, 'open-chat branch still calls selectChat');
}, { tags: ['unit'], timeout: 2000 });

test('TA3-5: deleteChat drops the chat\'s pending text + images, in memory and in settings', async function() {
    var f = dclFixture(await dclSources(), 'cur'), env = f.env, saved = [];
    env.chatPendingTexts = { cur: 'half-typed', a_oldest: 'keep me' };
    env.chatPendingImages = { cur: [{ name: 'shot.png' }], a_oldest: [{ name: 'keep.png' }] };
    // Like the real savePendingText/ImagesForContext, newChat() first files the open
    // composer under the (deleted) open chat id.
    env.savePendingTextForContext = function(ctx) { env.chatPendingTexts[ctx] = 'half-typed'; };
    env.savePendingImagesForContext = function(ctx) { env.chatPendingImages[ctx] = [{ name: 'shot.png' }]; };
    env.persistPendingTextsToStorage = function() { saved.push(['chatPendingTexts', JSON.parse(JSON.stringify(env.chatPendingTexts))]); };
    env.setSetting = function(k, v) { saved.push([k, v && JSON.parse(JSON.stringify(v))]); return Promise.resolve(); };
    await f.deleteChat('cur', { stopPropagation: function() {} });
    assert.strictEqual('cur' in env.chatPendingTexts, false, 'the deleted chat kept its text draft');
    assert.strictEqual('cur' in env.chatPendingImages, false, 'the deleted chat kept its image draft');
    assert.deepStrictEqual(env.chatPendingTexts, { a_oldest: 'keep me' });
    assert.deepStrictEqual(env.chatPendingImages, { a_oldest: [{ name: 'keep.png' }] });
    assert.deepStrictEqual(saved, [['chatPendingTexts', { a_oldest: 'keep me' }],
        ['chatPendingImages', { a_oldest: [{ name: 'keep.png' }] }]], 'pruned maps not persisted');
}, { tags: ['unit'], timeout: 2000 });

test('NEW-T15-2: a confirmed deleteChat drops the chat\'s pausedChats flag and keeps the others', async function() {
    var opens = ['cur', 'a_oldest']; // the open chat, then a non-open delete
    for (var i = 0; i < opens.length; i++) {
        var f = dclFixture(await dclSources(), opens[i]);
        await f.deleteChat('cur', { stopPropagation: function() {} });
        assert.strictEqual('cur' in f.env.chats, false, opens[i] + ': the delete did not run');
        assert.strictEqual('cur' in f.env.pausedChats, false, opens[i] + ': the deleted chat kept its pausedChats flag');
        assert.strictEqual(f.env.pausedChats.a_oldest, true, opens[i] + ': another chat lost its pausedChats flag');
        assert.strictEqual(f.calls.metaWrites.indexOf('cur'), -1, opens[i] + ': chat-meta written for the deleted chat');
    }
}, { tags: ['unit'], timeout: 2000 });

test('NEW-T21-1: a confirmed deleteChat removes the chat\'s scrollPos_ key and keeps the others', async function() {
    var opens = ['cur', 'a_oldest']; // the open chat, then a non-open delete
    for (var i = 0; i < opens.length; i++) {
        var f = dclFixture(await dclSources(), opens[i]);
        await f.deleteChat('cur', { stopPropagation: function() {} });
        assert.strictEqual('cur' in f.env.chats, false, opens[i] + ': the delete did not run');
        assert.strictEqual(f.env.appStorage.getItem('scrollPos_cur'), null, opens[i] + ': the deleted chat leaked its scrollPos_ key');
        assert.strictEqual(f.env.appStorage.getItem('scrollPos_a_oldest'), '40', opens[i] + ': another chat lost its scrollPos_ key');
    }
}, { tags: ['unit'], timeout: 2000 });

test('NEW-T15-2/NEW-T21-1: a cancelled deleteChat keeps the pausedChats flag and the scrollPos_ key', async function() {
    var f = dclFixture(await dclSources(), 'cur');
    f.env.showModal = function() { return Promise.resolve('cancel'); };
    await f.deleteChat('cur', { stopPropagation: function() {} });
    assert.strictEqual('cur' in f.env.chats, true, 'a cancelled delete removed the chat');
    assert.deepStrictEqual(f.env.pausedChats, { cur: true, a_oldest: true }, 'a cancelled delete changed pausedChats');
    assert.strictEqual(f.env.appStorage.getItem('scrollPos_cur'), '120', 'a cancelled delete removed scrollPos_cur');
    assert.strictEqual(f.env.appStorage.getItem('scrollPos_a_oldest'), '40', 'a cancelled delete removed scrollPos_a_oldest');
}, { tags: ['unit'], timeout: 2000 });

test('TA-9: continue-from-summary resets a stale composer hint (A6A3-02)', async function() {
    var src = (await dclSources())[DCL_NAV];
    var input = { value: '', placeholder: 'Describe the widget you want to create...' };
    function noop() {}
    var env = {
        pendingSummaryRequest: { chatId: 'Z', chatTitle: 'Old chat' },
        chats: { Z: { id: 'Z', messages: [{ role: 'user', content: 'sum' }, { role: 'assistant', content: 'THE SUMMARY' }] } },
        currentChatId: 'Z', versionHistory: [], stickToBottom: false, paused: false,
        DEFAULT_COMPOSER_PLACEHOLDER: 'Send a message...',
        document: { getElementById: function(id) { return id === 'message-input' ? input : null; } },
        generateId: function() { return 'N'; }, showSnackbar: noop, appStorage: { setItem: noop },
        pushFocusChatToOffscreen: noop, saveChatsToStorage: noop, clearUpdateSet: noop, renderChatList: noop,
        renderMessages: noop, renderVersionSidebar: noop, updateChatTitleHeader: noop, renderWorkersStrip: noop,
        setChatPausedPersistent: noop, pushPauseToggleToOffscreen: noop, syncPauseButtonUI: noop,
        runAgent: function() { return Promise.resolve(); }
    };
    var fn = new Function('env', 'with (env) {\n' + dclDeclaration(src, 'function resetComposerPlaceholder') + '\n' +
        dclDeclaration(src, 'function completeSummaryAndCreateNewChat') + '\nreturn completeSummaryAndCreateNewChat;\n}')(env);
    fn();
    await Promise.resolve();
    assert.strictEqual(env.currentChatId, 'N', 'did not switch to the continued chat');
    assert.strictEqual(input.placeholder, 'Send a message...', 'stale composer hint survived: ' + input.placeholder);
}, { tags: ['unit'], timeout: 2000 });
