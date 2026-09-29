// Run: run_tests { pattern: 'chat-navigation-state' } (js_eval sandbox; no Node).
// Source-derived functions + private fake DOM. Never imports the page bundle,
// dispatches to the service worker, or reads/writes a live chat or settings value.
'use strict';

function runChatNavigationAudit(sources) {
    var results = [];
    var navigation = sources['src/js/ui/170-chat-management.js'];
    var settings = sources['src/js/ui/040-tools-settings.js'];
    // The excerpts call t()/tn()/N_(): the with (env) sandbox gets the REAL i18n core first
    // (no catalog set = English identity, like the harness auto-include in test/harness.js).
    var i18nCore = sources['src/js/core/025-i18n.js'];
    function check(value, message) { if (!value) throw new Error(message); }
    function test(name, fn) {
        try { fn(); results.push({ name: name, passed: true }); }
        catch (e) { results.push({ name: name, passed: false, error: e.message }); }
    }
    // These production declarations use column-zero closing braces. Fail loudly
    // if that convention changes instead of silently testing a different excerpt.
    function declaration(source, name) {
        var start = source.indexOf('function ' + name + '(');
        var end = source.indexOf('\n}', start);
        check(start >= 0 && end > start, 'Missing declaration: ' + name);
        var code = source.slice(start, end + 2);
        new Function(code); // Syntax-check the exact excerpt before executing it.
        return code;
    }
    check(typeof i18nCore === 'string' && i18nCore.indexOf('function t(') >= 0, 'missing i18n core source');
    var code = [i18nCore, declaration(navigation, 'newChat'), declaration(navigation, 'selectChat'),
        declaration(sources['src/js/ui/030-home-view.js'], 'closeHomeView'),
        declaration(settings, 'showChatView'), declaration(settings, 'closeSettingsPageView'),
        declaration(sources['src/js/core/120-init.js'], 'closeSkillsView'),
        declaration(sources['src/js/ui/060-docs-view.js'], 'closeDashboardView'),
        declaration(sources['src/js/tools/110-smart-documents.js'], 'editDocumentWithAgent'),
        declaration(sources['src/js/tools/110-smart-documents.js'], 'sdocStartChat'),
        // A5A3-01 (PM30): tools/150 start_chat. declaration() slices from `function`, so the
        // real `async` is re-added; executeStartChat has no await, so a call finishes synchronously.
        declaration(sources['src/js/tools/150-start-chat.js'], '_startChatResolveWidgetId'),
        'async ' + declaration(sources['src/js/tools/150-start-chat.js'], 'executeStartChat')].join('\n');
    // CHAT-CONTROLS SSOT: the REAL 020 derive, excerpted for the paint tests below.
    var controls = sources['src/js/app/020-api-messages.js'];
    var deriveCode = ['_isStoppedActionChat', '_chatControlsState', '_setChatControlVisible', 'syncChatControlsUI', 'syncPauseButtonUI']
        .map(function(name) { return declaration(controls, name); }).join('\n');
    function fixture(view, overrides, extra) {
        var elements = {};
        function element(id) {
            if (!elements[id]) {
                var classes = new Set(id === 'messages' ? ['is-streaming'] : []);
                elements[id] = { style: {}, value: 'draft', focus: function() {}, setSelectionRange: function() {}, remove: function() {},
                    classList: { add: function(c) { classes.add(c); }, remove: function(c) { classes.delete(c); },
                        contains: function(c) { return classes.has(c); } } };
            }
            return elements[id];
        }
        var events = [], consumed = [], focused = [], renders = [];
        var env = {
            currentView: view, currentChatId: 'old',
            chats: { old: { id: 'old', messages: [{ content: 'old' }], lastViewedAt: 10, lastResponseAt: 20 },
                target: { id: 'target', messages: [{ content: 'target' }], lastViewedAt: 5 } },
            runningChatIds: { old: true }, activeStreamingChatId: 'old', isRunning: true,
            pendingInjection: 'old', pendingInjectionImages: ['old'], pendingInjectionsByChatId: {},
            pendingImageAttachments: ['old'], lastApiError: 'old error', versionHistory: ['old'],
            currentEditingSkill: null, currentEditingWidget: null, activeWidgetStreamingId: null,
            sidebarCollapsed: true, window: { currentSearchHighlight: 'stale search', innerWidth: 1024 },
            document: { getElementById: element, body: element('body') },
            history: { state: null, length: 1, back: function() { events.push('back'); } },
            appStorage: { setItem: function(k, v) { events.push('store:' + k + ':' + v); } },
            generateId: function() { return 'fresh'; },
            getCurrentPendingContext: function() { return env.currentView === 'chat' ? env.currentChatId : env.currentView; },
            savePendingImagesForContext: function(c) { events.push('save-images:' + c); },
            savePendingTextForContext: function(c) { events.push('save-text:' + c); },
            dispatchChatMeta: function(id, meta) { Object.assign(env.chats[id], meta); events.push('seen:' + id); },
            clearUnseenFinishedChat: function(id) { consumed.push(id); },
            pushFocusChatToOffscreen: function(id) { focused.push(id); },
            renderMessages: function() { renders.push({ id: env.currentChatId, highlight: env.window.currentSearchHighlight }); },
            hidePauseButton: function() { events.push('hide-pause'); },
            showPauseButton: function(id) { events.push('show-pause:' + id); },
            syncChatControlsUI: function(id) { events.push('controls:' + id + ':' + env.currentChatId + ':' + env.currentView); },
            _isChatInSilentHook: function() { return false; },
            // A5A3-01: globals of the tools/110 doc -> chat entry points.
            smartDocuments: { d1: { id: 'd1', title: 'Doc One' } }, autoResizeTextarea: function() {},
            sdocAttachToInput: function(id) { events.push('attach:' + id); }, saveChatsToStorage: function() {}
        };
        ('hideContinueButton hideRetryButton hideSnackbar clearUpdateSet renderChatList renderVersionSidebar ' +
            'updateChatTitleHeader updateInputPosition renderPendingImages pushHistoryState stopHomeTrailAnimation ' +
            'updateAllButtonStates updateSkillsButtonState updateDashboardButtonState replaceHistoryState ' +
            'refreshContinueButtonForChat loadVersionHistory restorePendingImagesForContext restorePendingTextForContext ' +
            'showPendingApprovalNotifications hideAllPanels toggleSidebar').split(' ').forEach(function(name) {
                env[name] = function() { events.push(name); };
            });
        Object.assign(env, overrides || {});
        // Every production global used by these excerpts is supplied in env;
        // optional helpers remain undefined so no runtime dependency can run.
        var api = new Function('env', 'with (env) {\n' + code + '\n' + (extra || '') +
            '\nreturn { newChat: newChat, selectChat: selectChat, closeHomeView: closeHomeView, showChatView: showChatView, editDocumentWithAgent: editDocumentWithAgent, sdocStartChat: sdocStartChat, executeStartChat: executeStartChat };\n}')(env);
        return { env: env, api: api, elements: elements, events: events, consumed: consumed, focused: focused, renders: renders };
    }

    ['home', 'settings-page', 'dashboard', 'skills', 'chat'].forEach(function(view) {
        test('newChat from ' + view + ' preserves unseen old chat and saves old context', function() {
            var f = fixture(view);
            f.api.newChat();
            check(f.env.currentChatId === 'fresh' && f.env.chats.fresh.isTemporary, 'fresh identity missing');
            check(f.env.chats.old.lastViewedAt === 10 && f.consumed.indexOf('old') < 0, 'previous unseen chat was consumed');
            check(f.focused.indexOf('old') < 0, 'previous chat was falsely re-focused');
            check(f.events[0] === 'save-images:' + (view === 'chat' ? 'old' : view), 'draft saved in wrong context');
            check(f.events[1] === 'save-text:' + (view === 'chat' ? 'old' : view), 'text saved after switching');
            check(f.env.currentView === 'chat', 'supported view was not closed');
            check(f.env.runningChatIds.old === true, 'background run changed');
            check(!f.elements.messages.classList.contains('is-streaming'), 'streaming layout leaked');
        });
    });
    test('newChat clears search before its first render', function() {
        var f = fixture('chat'); f.api.newChat();
        check(f.env.window.currentSearchHighlight === null, 'search highlight leaked into new chat');
        check(f.renders.length > 0 && f.renders.every(function(r) { return r.id === 'fresh' && r.highlight === null; }), 'stale render');
    });
    test('returning from Home to an actual chat still consumes its unseen status', function() {
        var f = fixture('home'); f.api.closeHomeView();
        check(f.env.chats.old.lastViewedAt > 10 && f.consumed.indexOf('old') >= 0, 'real view tracking removed');
        check(f.focused.indexOf('old') >= 0, 'real chat not re-focused');
    });
    ['silent', 'visible', 'idle'].forEach(function(mode) {
        test('selectChat re-derives streaming layout for ' + mode + ' target', function() {
            var f = fixture('chat', { runningChatIds: { old: true, target: mode !== 'idle' },
                _isChatInSilentHook: function() { return mode === 'silent'; } });
            f.api.selectChat('target');
            check(f.elements.messages.classList.contains('is-streaming') === (mode === 'visible'), 'streaming class does not match target visibility');
            check(f.env.isRunning === (mode !== 'idle'), 'run state changed incorrectly');
            check(f.env.runningChatIds.old === true, 'background run stopped');
            check(f.env.currentChatId === 'target' && f.env.window.currentSearchHighlight === null, 'target state not restored');
            check(f.consumed.indexOf('target') >= 0 && f.env.chats.target.lastViewedAt > 5, 'selected real chat not marked seen');
            check(f.events.indexOf('controls:target:target:chat') >= 0, 'controls not derived for the displayed target');
            check(f.events.indexOf('show-pause:target') < 0 && f.events.indexOf('hide-pause') < 0, 'raw pause write bypassed the derive');
        });
    });
    ['history', 'docs'].forEach(function(view) {
        test('selectChat from ' + view + ' preserves real target tracking', function() {
            var f = fixture(view); f.api.selectChat('target');
            check(f.env.currentView === 'chat' && f.env.currentChatId === 'target', 'target view not opened');
            check(f.env.chats.old.lastViewedAt === 10 && f.consumed.indexOf('old') < 0, 'unrelated old chat consumed');
            check(f.env.chats.target.lastViewedAt > 5 && f.consumed.indexOf('target') >= 0, 'selected target unseen');
            check(f.events.indexOf('controls:target:target:chat') >= 0, 'controls not re-derived after the view switch');
        });
    });
    // CHAT-CONTROLS SSOT: selectChat / newChat paint exactly one control via the real derive.
    function paintFixture(view, overrides) {
        var f = fixture(view, Object.assign({ pausedChats: {}, UI_ICONS: { play: '', pause: '' },
            isChatInterrupted: function(chat) { var m = chat.messages, last = m[m.length - 1];
                return !!last && (last.role === 'user' || last.role === 'tool'); } }, overrides || {}), deriveCode);
        ['pause-btn', 'continue-btn', 'retry-btn'].forEach(function(id) { f.env.document.getElementById(id).classList.add('visible'); });
        return f;
    }
    function shown(f) {
        return ['pause-btn', 'continue-btn', 'retry-btn'].filter(function(id) { return f.elements[id].classList.contains('visible'); }).join(',');
    }
    [{ name: 'paused non-sub chat shows Resume (RC2)', over: { pausedChats: { target: true } }, expect: 'pause-btn', label: 'Resume' },
        { name: 'interrupted chat shows Continue', msgs: [{ role: 'user', content: 'hi' }], expect: 'continue-btn' },
        { name: 'running chat shows Pause', over: { runningChatIds: { old: true, target: true } }, expect: 'pause-btn', label: 'Pause' },
        { name: 'errored chat shows Retry', meta: { _lastApiError: { message: 'x', chatId: 'target' } }, expect: 'retry-btn' },
        { name: 'silent-hook run shows nothing', over: { runningChatIds: { target: true }, _isChatInSilentHook: function() { return true; } }, expect: '' },
        { name: 'idle paused sub chat shows nothing', over: { pausedChats: { target: true } }, meta: { isSubAgent: true }, expect: '' }
    ].forEach(function(c) {
        ['chat', 'home'].forEach(function(view) {
            test('selectChat from ' + view + ': ' + c.name, function() {
                var f = paintFixture(view, c.over);
                if (c.msgs) f.env.chats.target.messages = c.msgs;
                Object.assign(f.env.chats.target, c.meta || {});
                f.api.selectChat('target');
                check(f.env.currentView === 'chat' && f.env.currentChatId === 'target', 'target not displayed');
                check(shown(f) === c.expect, 'controls shown: "' + shown(f) + '", expected "' + c.expect + '"');
                if (c.label) check(f.elements['pause-btn'].innerHTML.indexOf(c.label) >= 0, 'pause label: ' + f.elements['pause-btn'].innerHTML);
            });
        });
    });
    test('newChat derives all three controls hidden for the fresh chat', function() {
        var f = paintFixture('chat', { runningChatIds: { old: true } });
        f.api.newChat();
        check(f.env.currentChatId === 'fresh' && shown(f) === '', 'fresh chat shows: ' + shown(f));
    });
    test('silent target without messages element tolerates partial DOM', function() {
        var f = fixture('chat', { runningChatIds: { target: true }, _isChatInSilentHook: function() { return true; } });
        f.env.document.getElementById = function() { return null; };
        f.api.selectChat('target');
        check(f.env.currentChatId === 'target', 'missing DOM prevented navigation');
    });
    test('newChat tolerates absent optional UI helpers and elements', function() {
        var f = fixture('home');
        f.env.document.getElementById = function() { return null; };
        f.env.hideRetryButton = undefined; f.env.hideSnackbar = undefined;
        f.api.newChat();
        check(f.env.currentChatId === 'fresh' && f.env.chats.old.lastViewedAt === 10, 'partial DOM broke new chat');
    });
    test('newChat resets a stale composer hint (A6A3-02)', function() {
        var f = fixture('chat');
        var input = f.env.document.getElementById('message-input');
        input.placeholder = 'Describe the widget you want to create...';
        f.api.newChat();
        check(input.value === '' && input.placeholder === 'Send a message...', 'stale composer hint survived newChat: ' + input.placeholder);
    });
    // A5A3-01: from a view newChat() has no closer for (the Documents panel), the
    // doc -> chat entry points must open the fresh chat BEFORE showChatView() runs,
    // or its lastViewedAt stamp / clearUnseenFinishedChat consume the user's chat.
    ['editDocumentWithAgent', 'sdocStartChat'].forEach(function(fn) {
        ['documents', 'chat'].forEach(function(view) {
            test(fn + ' from ' + view + ' keeps the old chat unseen (A5A3-01)', function() {
                var f = fixture(view);
                f.api[fn]('d1');
                check(f.env.currentChatId === 'fresh' && f.env.chats.fresh && f.env.chats.fresh.isTemporary, 'fresh chat missing');
                check(f.env.chats.old.lastViewedAt === 10, 'old chat lastViewedAt stamped: ' + f.env.chats.old.lastViewedAt);
                check(f.events.indexOf('seen:old') < 0, 'old chat got a seen stamp');
                check(f.consumed.indexOf('old') < 0, 'old chat unseen state consumed');
                check(f.env.currentView === 'chat', 'view not switched to chat: ' + f.env.currentView);
                if (fn === 'editDocumentWithAgent') {
                    check(f.elements['message-input'].value === 'Edit document d1:\n', 'prefill lost: ' + JSON.stringify(f.elements['message-input'].value));
                } else {
                    check(f.env.chats.fresh.title === 'Re: Doc One' && f.events.indexOf('attach:d1') >= 0, 'title/attachment not on the fresh chat');
                }
            });
        });
    });
    // A5A3-01 (PM30): start_chat (tools/150) follows the same order. newChat() has no
    // closer for 'history', so executeStartChat forces the switch itself; that
    // showChatView() must stamp the fresh chat, not the user's. 'chat' is the control.
    ['history', 'chat'].forEach(function(view) {
        test('start_chat draft from ' + view + ' keeps the old chat unseen (A5A3-01)', function() {
            var f = fixture(view);
            f.api.executeStartChat({ message: 'Hi there', mode: 'draft', title: 'Start title' });
            check(f.env.currentChatId === 'fresh' && f.env.chats.fresh && f.env.chats.fresh.isTemporary, 'fresh chat missing');
            check(f.env.chats.old.lastViewedAt === 10, 'old chat lastViewedAt stamped: ' + f.env.chats.old.lastViewedAt);
            check(f.events.indexOf('seen:old') < 0, 'old chat got a seen stamp');
            check(f.consumed.indexOf('old') < 0 && f.focused.indexOf('old') < 0, 'old chat unseen state consumed or re-focused');
            check(f.env.currentView === 'chat', 'view not switched to chat: ' + f.env.currentView);
            check(view !== 'history' || f.consumed.indexOf('fresh') >= 0, 'forced switch did not show the fresh chat');
            check(f.elements['message-input'].value === 'Hi there' && f.env.chats.fresh.title === 'Start title', 'prefill/title not on the fresh chat');
        });
    });
    test('search match navigation explicitly restores highlights after selectChat', function() {
        var match = declaration(sources['src/js/ui/180-search.js'], 'navigateToSearchMatch');
        var selectIndex = match.indexOf('selectChat(chatId)');
        var highlightIndex = match.indexOf('window.currentSearchHighlight = chatSearchQuery');
        check(selectIndex >= 0 && highlightIndex >= 0 && selectIndex < highlightIndex, 'search restore ordering changed or required call/assignment missing');
    });
    return results;
}

// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/core/025-i18n.js","src/js/app/020-api-messages.js","src/js/ui/170-chat-management.js","src/js/ui/030-home-view.js","src/js/ui/040-tools-settings.js","src/js/core/120-init.js","src/js/ui/060-docs-view.js","src/js/ui/180-search.js","src/js/tools/110-smart-documents.js","src/js/tools/150-start-chat.js"];
await registerRunner('chat-navigation-state', async function() { return runChatNavigationAudit(await loadSources(PATHS)); });
