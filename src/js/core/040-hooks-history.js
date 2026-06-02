// Hooks system
var hooksEnabled = {
    autoTitle: true, // Hook to auto-generate chat title after agent completes
    showHookMessages: false // Show hook messages in chat UI
};
var _silentHookRunning = false; // Suppress UI updates during silent hook runs

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
    }
    return baseTitle;
}

function pushHistoryState(view, chatId, skillId) {
    if (isHandlingPopState) return; // Don't push state when handling back/forward
    var state = { view: view, chatId: chatId || null, skillId: skillId || null };
    var url = window.location.pathname + window.location.search; // Keep current URL
    var title = getHistoryTitle(view, chatId, skillId);
    document.title = title;
    if (isInitialLoad) {
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
    var state = event.state;
    if (!state) return;
    
    isHandlingPopState = true;
    
    try {
        var targetView = state.view || 'chat';
        var targetChatId = state.chatId;
        
        // Navigate to the appropriate view
        if (targetView === 'chat' && targetChatId && chats[targetChatId]) {
            // Close any open view first
            hideAllPanels();
            showChatView();
            currentView = 'chat';
            appStorage.setItem('currentView', 'chat');
            
            // Select the chat
            currentChatId = targetChatId;
            appStorage.setItem('lastChatId', targetChatId);
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
        } else if (targetView === 'dashboard') {
            currentView = 'dashboard';
            appStorage.setItem('currentView', 'dashboard');
            currentEditingWidget = null;
            hideAllPanels();
            var dashboardPanel = document.getElementById('dashboard-panel');
            if (dashboardPanel) { dashboardPanel.style.display = 'flex'; renderDashboard(); }
            var headersBtn = document.getElementById('dashboard-toggle-headers-btn');
            if (headersBtn) headersBtn.classList.toggle('active', showDashboardHeaders);
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
            restorePendingImagesForContext('home');
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

// Execute hooks after agent completes
function executeAfterResponseHooks(chatId) {
    var chat = chats[chatId];
    if (!chat) return;

    // Auto-title hook: generate title if chat has no title yet
    if (hooksEnabled.autoTitle && (!chat.title || chat.title === 'New Chat')) {
        executeAutoTitleHook(chatId);
    }
}

// Auto-title hook implementation - appends a message to trigger title generation
function executeAutoTitleHook(chatId) {
    var chat = chats[chatId];
    if (!chat || !chat.messages || chat.messages.length < 2) {
        return;
    }

    // Suppress UI updates during hook if hook messages are hidden
    _silentHookRunning = !hooksEnabled.showHookMessages;

    chat.messages.push({
        role: 'user',
        content: 'Now set a concise chat title (max 50 chars) for this conversation using the set_chat_title tool. Do NOT say anything else.',
        isHookMessage: true
    });
    saveChatsToStorage();
    if (hooksEnabled.showHookMessages) {
        renderMessages();
    }

    runAgent();
}
