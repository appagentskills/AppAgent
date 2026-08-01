// Hooks system
var hooksEnabled = {
    autoTitle: true, // Hook to auto-generate chat title after agent completes
    autoTldr: true, // Hook to ask the agent for a TL;DR card after each answer
    autoLinks: false, // Hook to ask the agent for relevant links after each answer (OFF by default)
    autoCaveat: true, // Hook to let the agent flag a must-read caveat/warning after an answer
    autoProgress: true, // Hook to ask the agent to finalize the chat progress card (update_action_state terminal state)
    showHookMessages: false // Show hook messages in chat UI
};
// Per-chat silent-hook flags for the shared agent loop (app/030-agent-loop.js).
// The SW bundle declares its own copy in worker/000-runtime-globals.js; on the
// page this stays dormant (the authoritative loop runs in the SW, and the
// page's UI gates use the _silentHookChats map in tools/120-actions.js).
var _silentHookRunningByChat = {};

// Browser History Management
function getHistoryTitle(view, chatId, skillId) {
    var baseTitle = 'AppAgent';
    if (view === 'chat' && chatId && chats[chatId]) {
        var chat = chats[chatId];
        return (chat.title && chat.title !== 'New Chat') ? chat.title + ' - ' + baseTitle : 'New Chat - ' + baseTitle;
    } else if (view === 'skill-editor' && skillId && skills[skillId]) {
        return skills[skillId].name + ' - Skills - ' + baseTitle;
    } else if (view === 'skills') {
        return 'Skills - ' + baseTitle;
    } else if (view === 'dashboard') {
        return 'Dashboard - ' + baseTitle;
    } else if (view === 'home') {
        return baseTitle;
    } else if (view === 'settings-page') {
        return 'Settings - ' + baseTitle;
    } else if (view === 'docs') {
        return 'Documentation - ' + baseTitle;
    } else if (view === 'history') {
        return 'Chat History - ' + baseTitle;
    } else if (view === 'documents') {
        return 'Documents - ' + baseTitle;
    }
    return baseTitle;
}

function pushHistoryState(view, chatId, skillId) {
    if (isHandlingPopState) return; // Don't push state when handling back/forward
    var state = { view: view, chatId: chatId || null, skillId: skillId || null };
    var url = window.location.pathname + window.location.search; // Keep current URL
    var title = getHistoryTitle(view, chatId, skillId);
    document.title = title;
    // NAV-H4: never stack two identical entries. Re-opening the view we are already on
    // (double tap on a nav button, a view-open that runs twice, an in-app back landing
    // on its own parent) pushed a duplicate, so Back appeared to do nothing and the
    // user needed N presses to leave one view. Identical {view,chatId,skillId} as the
    // current entry => replaceState. history.state is read defensively: it is a plain
    // getter, but a serialization-restricted host would throw and wedge navigation.
    var currentState = null;
    try { currentState = history.state; } catch (e) { currentState = null; }
    var isSameEntry = !!currentState && currentState.view === state.view &&
        (currentState.chatId || null) === state.chatId &&
        (currentState.skillId || null) === state.skillId;
    if (isInitialLoad || isSameEntry) {
        // Use replaceState for initial load to set up base state without creating extra history entry
        // Note: isInitialLoad is set to false at the end of init(), not here, to ensure
        // all pushHistoryState calls during initialization use replaceState
        history.replaceState(state, '', url);
    } else {
        history.pushState(state, '', url);
    }
}

function replaceHistoryState(view, chatId, skillId) {
    var state = { view: view, chatId: chatId || null, skillId: skillId || null };
    var url = window.location.pathname + window.location.search;
    var title = getHistoryTitle(view, chatId, skillId);
    document.title = title;
    history.replaceState(state, '', url);
}

function handlePopState(event) {
    // NAV-H1: the browser legitimately fires popstate with a NULL state — a plain hash
    // change, or an entry pushed by something that isn't pushHistoryState(). There is
    // nothing to restore in that case, so leave the current view exactly as it is
    // instead of dereferencing state.view (which would throw). `event` is guarded too:
    // a hand-invoked handlePopState() with no argument used to throw on event.state.
    // Both returns happen BEFORE isHandlingPopState is set, so neither can wedge it.
    var state = event && event.state;
    if (!state || typeof state !== 'object') return;
    
    isHandlingPopState = true;
    
    try {
        var targetView = state.view || 'chat';
        var targetChatId = state.chatId;

        // Save the LEAVING context's pending composer state (text + images)
        // BEFORE the view switch — mirrors selectChat (ui/170-chat-management.js)
        // and openHomeView. Without this, browser Back/Forward silently dropped
        // the draft, and the next normal exit persisted the empty composer over
        // the stored one. typeof-guarded: the helpers live in the app tier
        // (app/050-image-attachments.js), which loads after this core file.
        if (typeof getCurrentPendingContext === 'function' && typeof savePendingTextForContext === 'function') {
            try {
                var leavingContext = getCurrentPendingContext();
                savePendingImagesForContext(leavingContext);
                savePendingTextForContext(leavingContext);
            } catch (e) {}
        }

        
        // NAV-H3: widget chat mode paints its chrome on the SHARED .main-header
        // (widget-mode class + dataset + #widget-back-btn, ui/070-dashboard-ui.js:999-1024)
        // and pushes NO history entry of its own, so browser Back out of it left that
        // chrome orphaned over whatever view we land on. No popstate state.view ever
        // means "widget mode", so tear it down for every branch below. The helper
        // deliberately does NOT touch #header-chat-title (see its comment): the chat
        // branch below rebuilds that via updateChatTitleHeader, and a blanket
        // .textContent write here would flatten its badge + progress pill. Idempotent and
        // typeof-guarded: the helper lives in the ui tier, which loads after this core file.
        if (typeof exitWidgetModeChrome === 'function') {
            try { exitWidgetModeChrome(); } catch (e) {}
        }

        // NAV-H6: the entry points at a chat that no longer exists (deleteChat,
        // ui/170-chat-management.js:1047, never prunes history entries). This used to
        // fall through to the default branch at the bottom, which force-showed the chat
        // view with whatever currentChatId happened to be — under the deleted chat's
        // stale title. Redirect to Home, which always exists.
        if (targetView === 'chat' && targetChatId && (typeof chats === 'undefined' || !chats[targetChatId])) {
            // In-memory retarget only — never destructive, so it is unconditional.
            targetView = 'home';
            targetChatId = null;
            // Re-seeding the ENTRY (so a Forward/Back bounce can't land on the dead chat
            // again) is destructive if `chats` simply has not hydrated yet: this listener
            // is registered at parse time (:356 below) while loadChatsFromStorage resolves
            // async (core/120-init.js:355), so an early Back would rewrite a perfectly
            // VALID chat entry into 'home' and lose it for good. Only rewrite once
            // hydration has definitively succeeded — _chatsHydrated (ui/070-dashboard-ui.js:1549,
            // set :1867) is the same gate the save path and ui/160-notifications.js:115 use.
            // Otherwise leave the entry intact and let the next visit re-evaluate it
            // against the then-populated `chats`.
            var chatsReady = (typeof _chatsHydrated !== 'undefined') && _chatsHydrated === true;
            if (chatsReady && typeof replaceHistoryState === 'function') {
                try { replaceHistoryState('home', null, null); } catch (e) {}
            }
        }

        // Navigate to the appropriate view
        if (targetView === 'chat' && targetChatId && chats[targetChatId]) {
            // Close any open view first
            hideAllPanels();
            // Set currentView/currentChatId BEFORE showChatView() so its gated
            // lastViewedAt stamp applies to the chat being opened — otherwise
            // the jobs row stays bold/unread (same ordering as SWM2-T3 below).
            currentView = 'chat';
            appStorage.setItem('currentView', 'chat');
            currentChatId = targetChatId;
            appStorage.setItem('lastChatId', targetChatId);
            showChatView();
            // Viewing the chat via Back/Forward consumes its finished-chat bell
            // entry (ui/165-finished-chat-badge.js) — this entry point bypasses
            // both selectChat() and showChatView()'s gated clear.
            if (typeof clearUnseenFinishedChat === 'function') { try { clearUnseenFinishedChat(targetChatId); } catch (e) {} }
            // B5: browser Back/Forward is a real chat switch — tell the SW the focused
            // chat changed so the sub-agent GC (_idleSweepTick / loadAllSubAgents)
            // doesn't reclaim a sub transcript the user just navigated to. selectChat
            // and openChatFromHistory push focus; popstate bypassed both, so a viewed
            // sub transcript could be GC'd out from under the user within ~60s.
            if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(targetChatId);
            clearUpdateSet();
            loadVersionHistory();
            renderChatList();
            renderMessages();
            updateInputPosition();
            updateChatTitleHeader();
            updateAllButtonStates();
            // Refresh Workers strip for the newly-selected chat. The rAF-
            // coalesced listener in 175-sub-agent-ui.js only fires on
            // registry mutations; a pure chat switch with no sub-agent
            // activity wouldn't repaint the strip otherwise and we'd
            // keep the previous chat's chips visible until reload.
            if (typeof renderWorkersStrip === 'function') {
                try { renderWorkersStrip(); } catch (e) {}
            }
            document.title = getHistoryTitle('chat', targetChatId, null);

            // Sync streaming UI state for the target chat. Mirror selectChat: if THAT
            // chat actually has a live agent loop (per-tab `runningChatIds`), show Pause;
            // otherwise reset Pause and surface the Continue button if the chat looks
            // interrupted. Without the symmetric reset, navigating back/forward from a
            // streaming chat to a non-streaming one left Pause visible.
            if (typeof runningChatIds !== 'undefined' && runningChatIds[targetChatId]) {
                isRunning = true;
                activeStreamingChatId = targetChatId;
                showPauseButton(targetChatId);
                if (typeof hideContinueButton === 'function') hideContinueButton();
            } else {
                isRunning = false;
                activeStreamingChatId = null;
                hidePauseButton();
                if (typeof refreshContinueButtonForChat === 'function') refreshContinueButtonForChat(targetChatId);
            }
            // B-D1: surface pending approvals on browser back/forward, same as selectChat.
            if (typeof showPendingApprovalNotifications === 'function') {
                showPendingApprovalNotifications(targetChatId);
            }
            // B-A1: refresh any showing snackbar so its copy matches the new currentChatId.
            if (typeof rerenderCurrentNotification === 'function') {
                rerenderCurrentNotification();
            }
            // Restore the target chat's pending draft (images + text) — mirrors
            // selectChat's restore; popstate bypassed it, so the composer kept
            // the previous context's text.
            if (typeof restorePendingImagesForContext === 'function') { try { restorePendingImagesForContext(targetChatId); } catch (e) {} }
            if (typeof restorePendingTextForContext === 'function') { try { restorePendingTextForContext(targetChatId); } catch (e) {} }
        } else if (targetView === 'dashboard') {
            currentView = 'dashboard';
            appStorage.setItem('currentView', 'dashboard');
            currentEditingWidget = null;
            hideAllPanels();
            var dashboardPanel = document.getElementById('dashboard-panel');
            if (dashboardPanel) { dashboardPanel.style.display = 'flex'; renderDashboard(); }
            updateAllButtonStates();
            renderChatList();
            document.title = getHistoryTitle('dashboard', null, null);
        } else if (targetView === 'skill-editor' && state.skillId && skills[state.skillId]) {
            // Open specific skill editor
            currentView = 'skills';
            appStorage.setItem('currentView', 'skills');
            hideAllPanels();
            var skillsPanel = document.getElementById('skills-panel');
            if (skillsPanel) skillsPanel.style.display = 'flex';
            // Open the skill editor directly
            openSkillEditor(state.skillId);
            updateAllButtonStates();
            renderChatList();
            document.title = getHistoryTitle('skill-editor', null, state.skillId);
        } else if (targetView === 'skills') {
            currentView = 'skills';
            appStorage.setItem('currentView', 'skills');
            currentEditingSkill = null;
            hideAllPanels();
            var skillsPanel = document.getElementById('skills-panel');
            var listPanel = document.getElementById('skills-list-panel');
            var editorPanel = document.getElementById('skill-editor-panel');
            if (listPanel) listPanel.style.display = 'flex';
            if (editorPanel) editorPanel.style.display = 'none';
            if (skillsPanel) { skillsPanel.style.display = 'flex'; renderSkillsList(); }
            updateAllButtonStates();
            renderChatList();
            document.title = getHistoryTitle('skills', null, null);
        } else if (targetView === 'home') {
            currentView = 'home';
            appStorage.setItem('currentView', 'home');
            hideAllPanels();
            var homePanel = document.getElementById('home-panel');
            if (homePanel) { homePanel.style.display = 'flex'; renderHome(); }
            updateAllButtonStates();
            renderChatList();
            if (typeof restorePendingImagesForContext === 'function') { try { restorePendingImagesForContext('home'); } catch (e) {} }
            // Restore the saved home draft: renderHome() just recreated
            // #home-message-input empty (mirrors openHomeView's restore; the
            // input exists synchronously after renderHome, so no timeout).
            if (typeof restorePendingTextForContext === 'function') { try { restorePendingTextForContext('home'); } catch (e) {} }
            document.title = getHistoryTitle('home', null, null);
        } else if (targetView === 'settings-page') {
            currentView = 'settings-page';
            appStorage.setItem('currentView', 'settings-page');
            hideAllPanels();
            var settingsPanel = document.getElementById('settings-page-panel');
            if (settingsPanel) { settingsPanel.style.display = 'flex'; renderSettingsPage(); }
            updateAllButtonStates();
            renderChatList();
            document.title = getHistoryTitle('settings-page', null, null);
        } else if (targetView === 'docs') {
            currentView = 'docs';
            appStorage.setItem('currentView', 'docs');
            hideAllPanels();
            var docsPanel = document.getElementById('docs-panel');
            if (docsPanel) { docsPanel.style.display = 'flex'; renderDocsPage(); }
            updateAllButtonStates();
            renderChatList();
            document.title = getHistoryTitle('docs', null, null);
        } else if (targetView === 'history') {
            currentView = 'history';
            appStorage.setItem('currentView', 'history');
            hideAllPanels();
            var historyPanel = document.getElementById('history-panel');
            if (historyPanel) { historyPanel.style.display = 'flex'; renderHistoryPage(); }
            updateAllButtonStates();
            renderChatList();
            document.title = getHistoryTitle('history', null, null);
        } else if (targetView === 'documents') {
            // NAV-H2: openDocumentsView pushes 'documents' (tools/110-smart-documents.js:895)
            // but there was no restore branch, so Back/Forward onto a Documents entry fell
            // through to the default below and force-switched to the chat view. Mirrors the
            // docs/history branches above; renderDocumentsPage lives in the tools tier, so
            // it gets the same typeof guard this file uses for cross-tier calls.
            currentView = 'documents';
            appStorage.setItem('currentView', 'documents');
            hideAllPanels();
            var documentsPanel = document.getElementById('documents-panel');
            if (documentsPanel) {
                documentsPanel.style.display = 'flex';
                if (typeof renderDocumentsPage === 'function') renderDocumentsPage();
            }
            updateAllButtonStates();
            renderChatList();
            document.title = getHistoryTitle('documents', null, null);
        } else {
            // Default: go to home or current chat
            hideAllPanels();
            // SWM2-T3: set currentView='chat' BEFORE showChatView() so showChatView's
            // focus-repost guard (ui/040-tools-settings.js:1504, keyed on
            // currentView==='chat') fires and re-pins the viewed chat for the SW
            // sub-agent GC. The post-chain :215 null-clear is skipped on this branch
            // (currentView==='chat'), so showChatView is the ONLY focus signal on a
            // return-to-chat — it must run after the assignment, not before.
            currentView = 'chat';
            showChatView();
            appStorage.setItem('currentView', 'chat');
            updateAllButtonStates();
            renderChatList();
            renderMessages();
            // #744: every named branch above sets document.title; the default
            // (return-to-chat) branch must too, or the tab keeps the previous
            // view's title. getHistoryTitle falls back to the base title when
            // currentChatId is null/unknown.
            document.title = getHistoryTitle('chat', currentChatId, null);
        }
        // SWM2-F3: leaving the chat view for any NON-chat view must clear this
        // panel's focus entry so the SW sub-agent GC isn't pinned on a chat the user
        // is no longer viewing (with F2's port-keyed map this clears only THIS port's
        // focus). Every non-chat branch above leaves currentView !== 'chat'; the chat
        // + default branches set it back to 'chat', so this single post-chain check
        // covers dashboard / skill-editor / skills / home / settings / docs / history.
        if (currentView !== 'chat' && typeof pushFocusChatToOffscreen === 'function') {
            pushFocusChatToOffscreen(null);
        }
    } catch (err) {
        // NAV-H1b: one view's re-render must not be able to wedge navigation. The finally
        // below already guarantees isHandlingPopState is cleared, but an escaping throw
        // still left the app on a half-switched view (hideAllPanels ran, no panel shown).
        // Log — console.warn('[tag] …', err) is the bundle convention, e.g.
        // core/120-init.js:295 — and fall back to the chat view, the same recovery the
        // default branch above performs. Nested try so a failing fallback can't rethrow.
        console.warn('[history] popstate restore failed for view "' + (state && state.view) + '" — falling back to the chat view', err);
        try {
            hideAllPanels();
            currentView = 'chat';
            showChatView();
            appStorage.setItem('currentView', 'chat');
            updateAllButtonStates();
            renderChatList();
            renderMessages();
            document.title = getHistoryTitle('chat', currentChatId, null);
        } catch (e2) {
            console.warn('[history] popstate fallback re-render also failed', e2);
        }
    } finally {
        isHandlingPopState = false;
    }
}

// Initialize popstate listener
window.addEventListener('popstate', handlePopState);

// Centralized scroll helpers
function isNearBottom(container) {
    container = container || document.getElementById('messages');
    if (!container) return false;
    var distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < 150;
}

// Get buffered content for consistent streaming speed.
// B1: key by chatId+':'+index so two concurrently streaming chats with the same
// message-array length don't share a buffer slot (would cause one chat's reveal
// pace to corrupt the other's). currentChatId is the right scope here because
// getDisplayContent is only called while iterating chats[currentChatId].messages
// inside renderMessages.
function getDisplayContent(msg, index) {
    var key = (currentChatId || '_') + ':' + index;
    if (!msg.isStreaming || !msg.content) {
        delete streamingDisplayLen[key];
        return msg.content || '';
    }
    var prevLen = streamingDisplayLen[key] || 0;
    var remaining = msg.content.length - prevLen;
    // Adaptive rate: faster when buffer is large to avoid falling too far behind
    var rate = remaining > 500 ? 120 : remaining > 200 ? 80 : STREAM_CHARS_PER_TICK;
    var newLen = Math.min(prevLen + rate, msg.content.length);
    // Snap to word boundary to avoid cutting mid-word
    if (newLen < msg.content.length && newLen > prevLen) {
        var space = msg.content.indexOf(' ', newLen);
        if (space !== -1 && space - newLen < 30) newLen = space + 1;
    }
    streamingDisplayLen[key] = newLen;
    return msg.content.substring(0, newLen);
}

// Load hooks settings from storage
async function loadHooksSettings() {
    var saved = await getSetting('hooksEnabled', null);
    if (saved !== null) {
        hooksEnabled = saved;
        // Migration: autoTldr was added after users may have saved settings.
        if (hooksEnabled.autoTldr === undefined) hooksEnabled.autoTldr = true;
        // Migration: autoLinks now defaults OFF — users without the key get the
        // new default (an explicit saved `true` is preserved; only undefined→false).
        if (hooksEnabled.autoLinks === undefined) hooksEnabled.autoLinks = false;
        // Migration: autoCaveat was added later — default ON for existing users.
        if (hooksEnabled.autoCaveat === undefined) hooksEnabled.autoCaveat = true;
        // Migration: autoProgress was added later — default ON for existing users.
        if (hooksEnabled.autoProgress === undefined) hooksEnabled.autoProgress = true;
    }
}

// Save hooks settings to storage AND mirror to the SW. The agent loop now
// runs in the SW, so it has its own `hooksEnabled` copy hydrated from IDB
// at boot; without this push the SW would keep the boot-time value until
// next restart and the user's toggle wouldn't take effect on background runs.
async function saveHooksSettings() {
    await setSetting('hooksEnabled', hooksEnabled);
    if (typeof pushHooksSettingsToOffscreen === 'function') {
        pushHooksSettingsToOffscreen(hooksEnabled);
    }
}

// Toggle a specific hook
async function toggleHook(hookName) {
    hooksEnabled[hookName] = !hooksEnabled[hookName];
    await saveHooksSettings();
    renderSettingsPage();
}

// The after-response hook implementations (executeAfterResponseHooks /
// executeHookRun) live in worker/020-page-stubs.js — the agent loop runs in
// the SERVICE WORKER, so the SW copy is the only live one. The page-bundle
// duplicates that used to live here were dead code (the page's runAgent is
// replaced by the port bridge in app/045-agent-port-bridge-page.js) and had
// drifted from the SW copy; they were removed to prevent further drift.
