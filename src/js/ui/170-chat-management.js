// Update model display with actual model from OpenRouter response
function updateModelDisplayWithProvider(actualModel) {
    var modelNameEl = document.getElementById('model-name');
    var homeModelNameEl = document.getElementById('home-model-name');
    if (!actualModel) return;
    // Format the model name: remove provider prefix and clean up
    var displayName = actualModel;
    if (actualModel.indexOf('/') !== -1) {
        displayName = actualModel.split('/').pop(); // Get part after last /
    }
    // Capitalize and clean up common patterns
    displayName = displayName.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    if (modelNameEl) {
        var textEl = modelNameEl.querySelector('.model-name-text');
        if (textEl) textEl.textContent = displayName;
        modelNameEl.style.display = '';
    }
    if (homeModelNameEl) {
        var homeTextEl = homeModelNameEl.querySelector('.model-name-text');
        if (homeTextEl) homeTextEl.textContent = displayName;
    }
}

async function fetchCredits() {
    var creditsEl = document.getElementById('credits-display');
    var homeCreditsEl = document.getElementById('home-credits-display');

    // Show cached usage immediately to prevent layout shift
    var cachedUsage = appStorage.getItem('cachedCredits');
    if (cachedUsage) {
        if (creditsEl) {
            creditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + cachedUsage;
            creditsEl.className = 'credits-display';
            creditsEl.style.display = '';
        }
        if (homeCreditsEl) {
            homeCreditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + cachedUsage;
            homeCreditsEl.className = 'credits-display';
            homeCreditsEl.style.display = '';
        }
    }

    // Only show loading if no cached value
    if (!cachedUsage) {
        if (creditsEl) {
            creditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>...';
            creditsEl.className = 'credits-display loading';
        }
        if (homeCreditsEl) {
            homeCreditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>...';
            homeCreditsEl.className = 'credits-display loading';
        }
    }

    // Derive credits URL from current provider's endpoint (extract base up to /v1/)
    var provider = getProviderByName(currentProvider);
    if (!provider || !provider.endpoint) return;

    // Claude OAuth: read rate limit headers cached from last API response (no extra network call)
    if (provider.isClaudeOAuth && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
            var rl = await new Promise(function(resolve, reject) {
                chrome.runtime.sendMessage({ type: 'claude-oauth-usage' }, function(response) {
                    if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                    if (response && response.error) { reject(new Error(response.error)); return; }
                    resolve(response && response.data);
                });
            });
            if (!rl) throw new Error('No usage data');
            // Parse: anthropic-ratelimit-unified-5h-utilization, anthropic-ratelimit-unified-5h-reset, etc.
            var util5h = parseFloat(rl['anthropic-ratelimit-unified-5h-utilization']);
            var reset5h = rl['anthropic-ratelimit-unified-5h-reset'];
            var utilRaw = !isNaN(util5h) ? util5h : parseFloat(rl['anthropic-ratelimit-unified-7d-utilization']);
            if (isNaN(utilRaw)) throw new Error('No utilization');
            // Header value is 0-1 decimal (0.28 = 28%), convert to percentage
            var util = utilRaw <= 1 ? utilRaw * 100 : utilRaw;
            var resetStr = '';
            var resetKey = reset5h || rl['anthropic-ratelimit-unified-7d-reset'];
            if (resetKey) {
                var resetTs = parseFloat(resetKey);
                // Unix timestamp in seconds — convert to ms
                var diffMs = (resetTs > 9999999999 ? resetTs : resetTs * 1000) - Date.now();
                if (diffMs > 0) {
                    var diffMin = Math.floor(diffMs / 60000);
                    var h = Math.floor(diffMin / 60);
                    var m = diffMin % 60;
                    resetStr = h > 0 ? h + 'h' + (m > 0 ? m + 'mn' : '') : m + 'mn';
                }
            }
            var displayText = Math.round(util) + '%' + (resetStr ? ' for ' + resetStr : '');
            var creditTitle = util.toFixed(1) + '% used' + (resetStr ? ' \u00b7 resets in ' + resetStr : '') + ' | Click to refresh';
            var cssClass = 'credits-display';
            if (util > 80) cssClass += ' error';
            if (displayText) {
                appStorage.setItem('cachedCredits', displayText);
                var creditHtml = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + displayText;
                if (creditsEl) { creditsEl.innerHTML = creditHtml; creditsEl.className = cssClass; creditsEl.title = creditTitle; creditsEl.style.display = ''; }
                if (homeCreditsEl) { homeCreditsEl.innerHTML = creditHtml; homeCreditsEl.className = cssClass; homeCreditsEl.title = creditTitle; homeCreditsEl.style.display = ''; }
            }
        } catch(e) {
            console.log('Claude OAuth usage error:', e.message);
            // Keep cached value visible, don't flash error
        }
        return;
    }

    var v1Idx = provider.endpoint.indexOf('/v1/');
    if (v1Idx === -1) return;
    var creditsUrl = provider.endpoint.substring(0, v1Idx) + '/v1/credits';

    try {
        var headers = {};
        if (provider.apiKey) headers['Authorization'] = 'Bearer ' + provider.apiKey;
        var res = await fetch(creditsUrl, { method: 'GET', headers: headers, cache: 'no-store' });

        if (!res.ok) {
            throw new Error('Failed to fetch credits');
        }

        var data = await res.json();
        var displayText = '';
        var creditTitle = 'Click to refresh';
        var cssClass = 'credits-display';

        if (data.data && data.data.total_credits !== undefined) {
            // OpenRouter format
            var remaining = (data.data.total_credits - data.data.total_usage).toFixed(2);
            displayText = '$' + remaining;
            creditTitle = 'Credits: $' + data.data.total_credits.toFixed(2) + ' | Used: $' + data.data.total_usage.toFixed(2) + ' | Click to refresh';
        } else if (data.five_hour) {
            // Claude usage format
            var fiveHour = data.five_hour.utilization;
            var resetStr = '';
            if (data.five_hour.resets_at) {
                var resetTime = new Date(data.five_hour.resets_at);
                var diffMs = resetTime - Date.now();
                if (diffMs > 0) {
                    var diffMin = Math.floor(diffMs / 60000);
                    var h = Math.floor(diffMin / 60);
                    var m = diffMin % 60;
                    resetStr = h > 0 ? h + 'h' + (m > 0 ? m + 'mn' : '') : m + 'mn';
                }
            }
            displayText = Math.round(fiveHour) + '%' + (resetStr ? ' for ' + resetStr : '');
            creditTitle = fiveHour.toFixed(1) + '% used' + (resetStr ? ' \u00b7 resets in ' + resetStr : '') + ' | Click to refresh';
            if (fiveHour > 80) cssClass += ' error';
        }

        if (!displayText) return;

        appStorage.setItem('cachedCredits', displayText);
        var creditHtml = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + displayText;

        if (creditsEl) {
            creditsEl.innerHTML = creditHtml;
            creditsEl.className = cssClass;
            creditsEl.title = creditTitle;
            creditsEl.style.display = '';
        }
        if (homeCreditsEl) {
            homeCreditsEl.innerHTML = creditHtml;
            homeCreditsEl.className = cssClass;
            homeCreditsEl.title = creditTitle;
            homeCreditsEl.style.display = '';
        }
    } catch (e) {
        console.error('Failed to fetch credits:', e);
        if (creditsEl) {
            creditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>Error';
            creditsEl.className = 'credits-display error';
        }
        if (homeCreditsEl) {
            homeCreditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>Error';
            homeCreditsEl.className = 'credits-display error';
        }
    }
}

async function updateStorageIndicator() {
    var storageEl = document.getElementById('storage-display');
    if (!storageEl) return;
    
    try {
        // Estimate IndexedDB usage via navigator.storage API
        if (navigator.storage && navigator.storage.estimate) {
            var estimate = await navigator.storage.estimate();
            var usedMB = (estimate.usage || 0) / (1024 * 1024);
            var quotaMB = (estimate.quota || 0) / (1024 * 1024);
            var remainingMB = quotaMB - usedMB;
            
            // Only show indicator if less than 5MB remaining
            if (remainingMB >= 5) {
                storageEl.style.display = 'none';
                return;
            }
            
            storageEl.style.display = '';
            var displayText = remainingMB.toFixed(1) + 'MB left';
            var className;
            
            if (remainingMB < 1) {
                className = 'storage-display critical';
            } else if (remainingMB < 3) {
                className = 'storage-display warning';
            } else {
                className = 'storage-display';
            }
            
            storageEl.innerHTML = '<span class="storage-icon">' + UI_ICONS.storage + '</span>' + displayText;
            storageEl.className = className;
            storageEl.title = 'IndexedDB Storage: ' + usedMB.toFixed(1) + 'MB used / ' + quotaMB.toFixed(0) + 'MB quota';
        } else {
            // Can't estimate - hide indicator
            storageEl.style.display = 'none';
        }
    } catch (e) {
        storageEl.style.display = 'none';
    }
}

function generateId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Track pending summary request
var pendingSummaryRequest = null; // { chatId, chatTitle }

// Summarize current conversation and start a new chat with the summary
async function summarizeAndStartNewChat() {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages || chat.messages.length < 3) {
        showSnackbar('Not enough conversation to summarize', 'warning');
        return;
    }
    
    // Check if agent is already running
    if (isRunning) {
        showSnackbar('Please wait for the current request to complete', 'warning');
        return;
    }
    
    // Store info for after the summary is generated
    pendingSummaryRequest = {
        chatId: currentChatId,
        chatTitle: chat.title || 'Chat'
    };
    
    // Add summary request as a user message
    var summaryPrompt = 'Please provide a concise summary of this conversation for context continuity. Include:\n' +
        '1. User\'s main questions/goals\n' +
        '2. Current progress and accomplishments\n' +
        '3. Any unresolved issues or blockers\n' +
        '4. Suggested next steps\n\n' +
        'Keep it brief but comprehensive. Do not include tool call details, just outcomes. Do not use any tools for this task.';
    
    chat.messages.push({
        role: 'user',
        content: summaryPrompt,
        isSummaryRequest: true
    });
    
    saveChatsToStorage();
    renderMessages();
    
    // Run the agent to generate the summary
    isFollowingScroll = true;
    paused = false;
    document.getElementById('pause-btn').innerHTML = '<span class="btn-icon">' + UI_ICONS.pause + '</span>Pause';
    await runAgent();
    
    // After agent completes, check if we need to create a new chat with the summary
    if (pendingSummaryRequest && pendingSummaryRequest.chatId === currentChatId) {
        completeSummaryAndCreateNewChat();
    }
}

// Called after agent completes a summary request to create the new chat
function completeSummaryAndCreateNewChat() {
    if (!pendingSummaryRequest) return;
    
    var chat = chats[pendingSummaryRequest.chatId];
    if (!chat || !chat.messages || chat.messages.length === 0) {
        pendingSummaryRequest = null;
        return;
    }
    
    // Find the last assistant message (the summary)
    var summary = null;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var msg = chat.messages[i];
        if (msg.role === 'assistant' && msg.content && !msg.isSummary) {
            summary = msg.content;
            // Mark as summary so it's not counted in metrics
            msg.isSummary = true;
            break;
        }
        if (msg.role === 'user') break; // Stop if we hit user message without finding assistant
    }
    
    if (!summary) {
        showSnackbar('Failed to generate summary', 'error');
        pendingSummaryRequest = null;
        return;
    }
    
    // Create new chat with summary as first message
    var newChatId = generateId();
    var summaryMessage = '**Continuing from previous conversation:**\n\n' + summary + '\n\n---\n\nPlease continue helping me with the above context.';
    
    chats[newChatId] = {
        id: newChatId,
        title: 'Continued: ' + pendingSummaryRequest.chatTitle,
        messages: [{ role: 'user', content: summaryMessage }],
        createdAt: Date.now()
    };
    
    pendingSummaryRequest = null;
    
    currentChatId = newChatId;
    appStorage.setItem('lastChatId', currentChatId);
    saveChatsToStorage();
    
    versionHistory = [];
    clearUpdateSet();
    renderChatList();
    renderMessages();
    renderVersionSidebar();
    updateChatTitleHeader();
    // Reset Workers strip for the fresh chat — the new chat owns no
    // sub-agents yet, so the strip should be empty/hidden. Without this,
    // chips from the previous chat persist until the next selectChat.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
    
    showSnackbar('New chat created with summary', 'success');
    
    // Auto-start agent to get AI response
    isFollowingScroll = true;
    paused = false;
    document.getElementById('pause-btn').innerHTML = '<span class="btn-icon">' + UI_ICONS.pause + '</span>Pause';
    runAgent();
}

function newChat() {
    // Save pending state for current context before switching
    var prevContext = getCurrentPendingContext();
    savePendingImagesForContext(prevContext);
    savePendingTextForContext(prevContext);

    // Close skills or dashboard view if open
    if (currentView === 'skills') {
        closeSkillsView();
    } else if (currentView === 'dashboard') {
        closeDashboardView();
    } else if (currentView === 'home') {
        closeHomeView();
    } else if (currentView === 'settings-page') {
        closeSettingsPageView();
    }

    // Reset UI state for new chat (don't clear pendingToolApprovals - they're per-chat)
    // newChat: resetting foreground UI state only. Background loops keep running.
    isRunning = false;
    activeStreamingChatId = null;
    pendingInjection = null;
    pendingInjectionImages = null;
    hidePauseButton();
    hideContinueButton();
    // Clear foreground-UI globals so the previous chat's state doesn't leak
    // into the fresh new chat. Two real cases were observed:
    //   - lastApiError: drives the inline error banner. If chat A blew up
    //     with an API error then the user hit "New Chat", the banner stuck
    //     to the new chat even though the new chat had never made a request.
    //   - #messages.is-streaming: drives bottom-padding / scroll pinning for
    //     the streaming UI. If chat A was mid-stream when New Chat fired,
    //     the class lingered on the messages container and the empty new
    //     chat rendered with the streaming layout active.
    // selectChat clears both via its own branch below; newChat needs the
    // same treatment since it bypasses selectChat entirely.
    lastApiError = null;
    var _newChatMessagesEl = document.getElementById('messages');
    if (_newChatMessagesEl) _newChatMessagesEl.classList.remove('is-streaming');

    currentChatId = generateId();
    chats[currentChatId] = { id: currentChatId, title: 'New Chat', messages: [], createdAt: Date.now(), isTemporary: true };

    appStorage.setItem('lastChatId', currentChatId);
    // Don't save empty chat
    versionHistory = [];
    clearUpdateSet();
    renderChatList();
    renderMessages();
    renderVersionSidebar();
    updateChatTitleHeader();
    // Reset Workers strip for the fresh new chat (no subs yet — strip
    // should hide). Same reason as in the continue-from-summary path
    // above: newChat bypasses selectChat.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
    // Same reason as in selectChat — dismiss any popover left over from the
    // previous chat so it doesn't hover over the empty new-chat header.
    if (typeof closeChatProgressPopoverIfStale === 'function') {
        try { closeChatProgressPopoverIfStale(); } catch (e) {}
    }

    // Temporarily close the right sidebar without affecting stored state
    var sidebar = document.getElementById('version-sidebar');
    var openBtn = document.getElementById('version-sidebar-open');
    if (sidebar) sidebar.classList.remove('visible');
    if (openBtn) openBtn.classList.add('visible');
    updateInputPosition();

    // New chat starts with empty input
    var inputEl = document.getElementById('message-input');
    if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = 'auto';
        inputEl.focus();
    }

    // Start with empty pending images for the new chat
    pendingImageAttachments = [];
    renderPendingImages();

    // Push browser history state
    pushHistoryState('chat', currentChatId);
}

function selectChat(chatId, options) {
    options = options || {};
    // Save pending state for current context before switching
    var prevContext = getCurrentPendingContext();
    savePendingImagesForContext(prevContext);
    savePendingTextForContext(prevContext);

    // Reset UI state for the new focused chat.
    // If THAT chat is streaming — show pause/streaming UI.
    // Otherwise, reset (but DO NOT stop any other chat's running loop).
    // Re-sync the messages container's `is-streaming` class to the target chat's
    // actual run state. Without this, the class would reflect whichever chat last
    // started/finished a run, not the chat currently in view.
    var _messagesEl = document.getElementById('messages');
    // lastApiError is a foreground-UI global (drives the error banner). Clearing
    // it on chat switch prevents an error from a previous chat bleeding into the
    // newly-viewed chat's UI; renderMessages will re-derive any per-chat error.
    lastApiError = null;
    if (runningChatIds[chatId]) {
        isRunning = true;
        activeStreamingChatId = chatId;
        if (_messagesEl) _messagesEl.classList.add('is-streaming');
        // Pass chatId explicitly — currentChatId hasn't been updated yet (line below)
        // so showPauseButton's syncPauseButtonUI call would otherwise read the
        // previous chat's pausedChats flag and mislabel the button.
        showPauseButton(chatId);
        hideContinueButton();
        var stored = pendingInjectionsByChatId[chatId];
        if (stored) {
            pendingInjection = stored.text;
            pendingInjectionImages = stored.images;
        }
    } else {
        // Target chat is not streaming — reset foreground UI.
        // Other chats' background loops are unaffected (runningChatIds is unchanged).
        isRunning = false;
        activeStreamingChatId = null;
        if (_messagesEl) _messagesEl.classList.remove('is-streaming');
        hidePauseButton();
        pendingInjection = null;
        pendingInjectionImages = null;
        // If the chat looks interrupted (e.g. page was reloaded mid-stream), show
        // a Continue button so the user can pick up where the agent left off.
        refreshContinueButtonForChat(chatId);
    }
    currentChatId = chatId;
    appStorage.setItem('lastChatId', chatId);
    clearUpdateSet();
    loadVersionHistory();
    renderChatList();
    renderMessages();
    updateInputPosition();
    updateChatTitleHeader();
    // Refresh the Workers strip so chips reflect the newly-selected chat's
    // sub-agents (each parent chat has its own set). Hidden when the chat
    // owns no subs. Source: src/js/ui/175-sub-agent-ui.js.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
    // Re-render the header live-action pills: the suppression rule depends on
    // whether the newly-selected chat is a sub-agent, so switching between a
    // regular chat and a sub-agent chat must trigger a recompute. Without
    // this, the pills row would only update on activeActions membership
    // changes — stale shape persists across navigation.
    if (typeof renderLiveActionPills === 'function') {
        try { renderLiveActionPills(); } catch (e) {}
    }
    // A chat-progress popover belongs to a specific chatId. Without this, the
    // popover would hover above the new chat's header showing stale data from
    // the previous chat — _refreshOpenChatProgressPopover short-circuits on
    // chatId mismatch but never closes.
    if (typeof closeChatProgressPopoverIfStale === 'function') {
        try { closeChatProgressPopoverIfStale(); } catch (e) {}
    }
    // Close any non-chat view when selecting a chat
    if (currentView !== 'chat') {
        hideAllPanels();
        showChatView();
        currentView = 'chat';
        appStorage.setItem('currentView', 'chat');
        updateAllButtonStates();
    } else if (!sidebarCollapsed && (document.body.classList.contains('sidepanel-mode') || window.innerWidth <= 480)) {
        toggleSidebar();
    }
    // Restore pending state for the target chat
    restorePendingImagesForContext(chatId);
    restorePendingTextForContext(chatId);
    // Push browser history state
    pushHistoryState('chat', chatId);
    // Show notifications for any pending tool approvals in this chat
    // Skip if user came from "Go to chat" button (they'll handle approvals inline)
    if (!options.skipApprovalNotifications) {
        showPendingApprovalNotifications(chatId);
    }
    // B-A1: if a snackbar is already up for some other chat, recompute its copy
    // ("The agent wants to run X" vs "<title> wants to run X") so it reflects the
    // new currentChatId. Without this, the popup keeps the stale copy from the
    // chat the user came from.
    if (typeof rerenderCurrentNotification === 'function') {
        rerenderCurrentNotification();
    }
}

// `includeToolCallId` (optional): forwarded to getCurrentChatProgressState so
// the in-flight update_action_state call — whose role:'tool' result row hasn't
// been pushed yet by the agent loop — still appears in the pill. Without it,
// calling updateChatTitleHeader from inside executeUpdateActionState would
// skip the just-issued state and the pill would lag one update behind.
function updateChatTitleHeader(includeToolCallId) {
    var titleEl = document.getElementById('header-chat-title');
    if (!titleEl) return;
    var chat = chats[currentChatId];
    var title = (chat && chat.title && chat.title !== 'New Chat') ? chat.title : '';

    // Sub-agent badge — makes it instantly visible in the chat header that
    // the user is looking at a delegated worker chat, not a top-level
    // conversation. Clicking the badge jumps to the immediate parent chat
    // (the breadcrumb in the sidebar / history card has the full chain).
    var subAgentBadgeHtml = '';
    if (chat && chat.isSubAgent) {
        var parentChatId = chat.parentChatId || '';
        var parentTitle = (parentChatId && chats[parentChatId] && chats[parentChatId].title) ? chats[parentChatId].title : 'parent chat';
        var iconHtml = (typeof UI_ICONS !== 'undefined' && UI_ICONS.bot) ? UI_ICONS.bot : '';
        // Data-attribute + delegated click handler (in 175-sub-agent-ui.js)
        // instead of an inline onclick. escapeHtml does NOT escape single
        // quotes, so a parentChatId containing one would break the inline JS
        // string and could leak attribute context. The inline onkeydown only
        // calls this.click() — no user data in inline JS — so Enter/Space on
        // the focused span dispatches a real click event that the delegated
        // handler picks up via the data-attribute.
        var clickAttrs = parentChatId
            ? ' role="button" tabindex="0" data-open-parent-chat-id="' + escapeHtml(parentChatId) + '" onkeydown="if(event.key===\u0027Enter\u0027||event.key===\u0027 \u0027){this.click();event.preventDefault();}"'
            : '';
        var tipText = parentChatId
            ? 'Sub-agent of: ' + parentTitle + ' — click to open parent'
            : 'Delegated worker chat';
        subAgentBadgeHtml = ' <span class="chat-title-subagent-pill" title="' + escapeHtml(tipText) + '"' + clickAttrs + '>'
            + '<span class="chat-title-subagent-icon">' + iconHtml + '</span>'
            + '<span class="chat-title-subagent-label">Sub-agent</span>'
            + '</span>';
    }

    // Append a small progress state pill (running/stuck/done/error) when the
    // current chat has any update_action_state calls. Visible always — no need
    // to open the right sidebar to see what state the agent is in.
    var pillHtml = '';
    if (typeof getCurrentChatProgressState === 'function') {
        try {
            var current = getCurrentChatProgressState(includeToolCallId);
            if (current && current.state) {
                var s = current.state;
                var icon = s === 'done' ? UI_ICONS.check :
                           s === 'error' ? UI_ICONS.close :
                           s === 'stuck' ? UI_ICONS.alert :
                           UI_ICONS.spinner;
                pillHtml = ' <span class="chat-title-state-pill state-' + s + '" ' +
                    'title="Progress: ' + s + ' — click for details" ' +
                    'aria-label="Progress: ' + s + ' — click for details" ' +
                    'role="button" tabindex="0" ' +
                    'onclick="onChatTitleStatePillClick(this, event)" ' +
                    'onkeydown="if(event.key===\u0027Enter\u0027||event.key===\u0027 \u0027)onChatTitleStatePillClick(this, event)">' +
                    '<span class="chat-title-state-icon">' + icon + '</span>' +
                    '<span class="chat-title-state-label">' + s + '</span>' +
                '</span>';
            }
        } catch (e) {}
    }

    if (title || pillHtml || subAgentBadgeHtml) {
        titleEl.innerHTML = (title ? escapeHtml(title) : '') + subAgentBadgeHtml + pillHtml;
    } else {
        titleEl.textContent = '';
    }
}

async function deleteChat(chatId, e) {
    e.stopPropagation();
    var chat = chats[chatId];
    var title = chat ? chat.title : 'this chat';

    // Check if any dashboard widgets are linked to this chat
    var linkedWidgets = [];
    for (var widgetId in dashboardWidgets) {
        var widget = dashboardWidgets[widgetId];
        if (widget.chatId === chatId) {
            linkedWidgets.push(widget.title || 'Untitled Widget');
        }
    }

    var message = 'Delete "' + escapeHtml(title) + '"? This action cannot be undone.';
    if (linkedWidgets.length > 0) {
        var escapedWidgets = linkedWidgets.map(function(w) { return escapeHtml(w); });
        message = 'Delete "' + escapeHtml(title) + '"?<br><br>⚠️ <strong>Warning:</strong> This chat is linked to ' + linkedWidgets.length +
            ' dashboard widget' + (linkedWidgets.length > 1 ? 's' : '') + ':<br>• ' + escapedWidgets.join('<br>• ') +
            '<br><br>Deleting this chat will prevent these widgets from being regenerated with their original context.';
    }

    var result = await showModal('Delete Chat', message, [
        { label: 'Cancel', value: 'cancel', class: 'secondary' },
        { label: 'Delete', value: 'delete', class: 'danger' }
    ]);
    if (result !== 'delete') return;
    delete chats[chatId];
    saveChatsToStorage();
    if (currentChatId === chatId) {
        var ids = Object.keys(chats);
        ids.length > 0 ? selectChat(ids[0]) : newChat();
    } else renderChatList();
    renderHistoryPage();
    showSnackbar('Chat deleted', 'success');
}

function togglePinChat(chatId) {
    var chat = chats[chatId];
    if (!chat) return;
    chat.pinned = !chat.pinned;
    saveChatsToStorage();
    renderChatList();
    renderVersionSidebar();
}

function deleteChatFromSidebar() {
    if (!currentChatId) return;
    deleteChat(currentChatId, { stopPropagation: function() {} });
}
