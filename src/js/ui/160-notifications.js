// Check if a context (chatId or 'home') has pending draft items (text or images)
function chatHasPendingItems(contextKey) {
    return (chatPendingImages[contextKey] && chatPendingImages[contextKey].length > 0) ||
           (chatPendingTexts[contextKey] && chatPendingTexts[contextKey].length > 0);
}

// Update the pending-draft indicator on the New Chat sidebar button
function updateHomePendingIndicator() {
    var dot = document.getElementById('home-pending-dot');
    if (dot) dot.style.display = chatHasPendingItems('home') ? 'inline-block' : 'none';
}

// Check if a chat has any pending tool approvals
function chatHasPendingApproval(chatId) {
    var chat = chats[chatId];
    if (!chat || !chat.messages) return false;
    return chat.messages.some(function(m) {
        return m.role === 'approval' && m.status === 'pending';
    });
}

// Show notifications for pending approvals when opening a chat (e.g., after page reload)
function showPendingApprovalNotifications(chatId) {
    var chat = chats[chatId];
    if (!chat || !chat.messages) return;

    // First, check if there are any pending approvals for this chat
    var pendingApprovals = [];
    for (var i = 0; i < chat.messages.length; i++) {
        var msg = chat.messages[i];
        if (msg.role === 'approval' && msg.status === 'pending') {
            pendingApprovals.push({ index: i, msg: msg });
        }
    }

    // If no pending approvals, nothing to show
    if (pendingApprovals.length === 0) return;

    // Clear any existing notifications for this chat to avoid duplicates
    approvalNotificationQueue = approvalNotificationQueue.filter(function(n) {
        return n.chatId !== chatId;
    });

    // If currently showing notifications for this chat, clear them
    if (Array.isArray(currentApprovalNotification) &&
        currentApprovalNotification.length > 0 &&
        currentApprovalNotification[0].chatId === chatId) {
        currentApprovalNotification = null;
        isShowingApprovalNotification = false;
        var snackbar = document.getElementById('snackbar');
        if (snackbar) snackbar.classList.remove('show');
    }

    // Now add notifications for each pending approval
    for (var j = 0; j < pendingApprovals.length; j++) {
        var approval = pendingApprovals[j];
        var chatTitle = chat.title || 'A chat';
        var statusMessage = (approval.msg.args && approval.msg.args.status_message) ? approval.msg.args.status_message : null;
        showApprovalNotification(chatTitle, approval.msg.toolName, chatId, statusMessage, approval.index, approval.msg.args);
    }
}

function showToolApprovalPrompt(displayName, args, permissionKey, toolCallId, actualToolName, targetChatId, options) {
    options = options || {};
    return new Promise(function(resolve) {
        // Use targetChatId if provided (for background streaming), otherwise currentChatId
        var chatId = targetChatId || currentChatId;
        var chat = chats[chatId];
        var approvalIndex = chat.messages.length;

        // Add approval message to chat
        chat.messages.push({
            role: 'approval',
            toolName: displayName,
            actualToolName: actualToolName || displayName,
            args: args,
            permissionKey: permissionKey,
            toolCallId: toolCallId,
            status: 'pending'
        });
        saveChatsToStorage();

        // If this is a background Action chat, flip the button to 'needs_permission' (lock)
        if (chat.isBackground && chat.actionId && typeof setActionNeedsPermission === 'function') {
            setActionNeedsPermission(chat.actionId, { approvalIndex: approvalIndex });
        }

        // Store resolve function BEFORE rendering (so it's available for handleApproval)
        var approvalKey = chatId + ':' + approvalIndex;
        pendingToolApprovals[approvalKey] = { resolve: resolve, approvalIndex: approvalIndex, chatId: chatId };

        // For programmatic tool calls (from widgets/js_eval), always use notification
        // This avoids calling renderMessages() which would destroy widget iframes
        // Notifications work everywhere: chat view, dashboard, any view
        var isProgrammaticCall = toolCallId && toolCallId.startsWith('prog_');
        if (isProgrammaticCall) {
            // Use widget name if provided (from widget tool calls), otherwise fallback to 'Widget'
            var notificationTitle = options.widgetName || 'Widget';
            var statusMessage = (args && args.status_message) ? args.status_message : null;
            showApprovalNotification(notificationTitle, displayName, chatId, statusMessage, approvalIndex, args);
        } else if (currentChatId === chatId && currentView === 'chat') {
            // For agent tool calls on current chat, show notification popup instead of inline
            var chatTitle = chat.title || 'A chat';
            var statusMessage = (args && args.status_message) ? args.status_message : null;
            showApprovalNotification(chatTitle, displayName, chatId, statusMessage, approvalIndex, args);
            renderMessages(); // Still render to update chat but notification handles approval
            scrollToBottomIfAllowed();
        } else {
            // Show notification when user is on a different chat or different view
            var chatTitle = chat.title || 'A chat';
            var statusMessage = (args && args.status_message) ? args.status_message : null;
            showApprovalNotification(chatTitle, displayName, chatId, statusMessage, approvalIndex, args);
        }
        // Always update chat list to show attention indicator
        renderChatList();
    });
}

// Batch version: adds approval message without rendering/notifying immediately
// Used when adding multiple approvals at once - caller handles render and notifications after all are added
function showToolApprovalPromptBatch(displayName, args, permissionKey, toolCallId, actualToolName, targetChatId, options) {
    options = options || {};
    return new Promise(function(resolve) {
        var chatId = targetChatId || currentChatId;
        var chat = chats[chatId];
        var approvalIndex = chat.messages.length;

        // Add approval message to chat
        chat.messages.push({
            role: 'approval',
            toolName: displayName,
            actualToolName: actualToolName || displayName,
            args: args,
            permissionKey: permissionKey,
            toolCallId: toolCallId,
            status: 'pending'
        });

        // Store resolve function
        var approvalKey = chatId + ':' + approvalIndex;
        pendingToolApprovals[approvalKey] = { resolve: resolve, approvalIndex: approvalIndex, chatId: chatId };

        // Queue notification (will be shown after all approvals are added)
        // Always show notification popup (not just when on different chat/view)
        var isProgrammaticCall = toolCallId && toolCallId.startsWith('prog_');
        var notificationTitle = isProgrammaticCall ? (options.widgetName || 'Widget') : (chat.title || 'A chat');
        var statusMessage = (args && args.status_message) ? args.status_message : null;
        showApprovalNotification(notificationTitle, displayName, chatId, statusMessage, approvalIndex, args);
    });
}

// Global approval handler - called from onclick in rendered HTML
// skipNotificationClear: true when called from notification (notification handles its own state)
// targetChatId: optional - used when approving from notification where chatId is known
async function handleApproval(approvalIndex, action, skipNotificationClear, targetChatId) {
    // B-A4: when targetChatId is provided, the (chatId, approvalIndex) pair is
    // authoritative — build the composite key directly. Without this, the loop
    // below matched on approvalIndex alone and could resolve a *different* chat's
    // approval at the same array index. Only fall back to the unscoped scan when
    // no targetChatId is available (legacy inline-from-current-chat path).
    var chatId = targetChatId || currentChatId;
    var approvalKey = null;
    if (targetChatId) {
        var directKey = targetChatId + ':' + approvalIndex;
        if (pendingToolApprovals[directKey]) {
            approvalKey = directKey;
            chatId = targetChatId;
        }
    } else {
        // No targetChatId — fall back to scanning, but prefer matches on currentChatId first
        // so a same-index approval on another chat doesn't steal this one.
        var preferred = currentChatId + ':' + approvalIndex;
        if (pendingToolApprovals[preferred] && pendingToolApprovals[preferred].approvalIndex === approvalIndex) {
            approvalKey = preferred;
            chatId = currentChatId;
        } else {
            for (var key in pendingToolApprovals) {
                if (pendingToolApprovals[key].approvalIndex === approvalIndex) {
                    chatId = pendingToolApprovals[key].chatId;
                    approvalKey = key;
                    break;
                }
            }
        }
    }

    var chat = chats[chatId];
    if (!chat || !chat.messages[approvalIndex]) return;

    var msg = chat.messages[approvalIndex];
    if (msg.role !== 'approval' || msg.status !== 'pending') return;

    var approved = action !== 'deny';

    // Update status based on action
    if (action === 'allow') {
        msg.status = 'allowed';
    } else if (action === 'session') {
        msg.status = 'session_allowed';
        if (msg.permissionKey) {
            sessionPermissions[msg.permissionKey] = 'allow';
        }
    } else if (action === 'auto') {
        msg.status = 'always_allowed';
        if (msg.permissionKey) {
            setToolPermissionByKey(msg.permissionKey, 'allow');
        }
    } else if (action === 'deny') {
        msg.status = 'denied';
    }

    saveChatsToStorage();

    // If this was a background Action chat, clear the needs_permission state
    if (chat.isBackground && chat.actionId && typeof clearActionNeedsPermission === 'function') {
        clearActionNeedsPermission(chat.actionId);
    }

    // Check if this is a programmatic approval (from widget/js_eval)
    // Programmatic approvals use notifications, so no need to call renderMessages()
    var isProgrammaticApproval = msg.toolCallId && msg.toolCallId.startsWith('prog_');

    if (!isProgrammaticApproval) {
        // For agent tool calls, use full renderMessages()
        renderMessages();
    }

    renderChatList(); // Update chat list to remove attention indicator

    // Clear any notifications for this chat since approval was handled from chat
    // Skip if called from notification (notification handles its own state)
    if (!skipNotificationClear && typeof clearApprovalNotificationsForChat === 'function') {
        clearApprovalNotificationsForChat(chatId);
    }

    // If there's an active conversation waiting for this approval, resolve it
    if (approvalKey && pendingToolApprovals[approvalKey]) {
        var resolve = pendingToolApprovals[approvalKey].resolve;
        delete pendingToolApprovals[approvalKey];
        resolve(approved);
        return;
    }

    // No active conversation — run agent which will detect and execute approved tools.
    // B-A3: post-reload (or after the original loop died), no resolver exists for this
    // approval. Previously this branch only ran when called from the inline chat path
    // (skipNotificationClear === false) AND implicitly assumed the user was already on
    // the right chat. The notification-click path also hit this branch with
    // skipNotificationClear=true, then fell through with no runAgent call — leaving
    // an `allowed` approval message and no loop to consume it. Always re-kick on the
    // target chat when there's no live resolver, regardless of caller.
    if (action !== 'deny') {
        await runAgent(chatId);
    }
}

function saveProviderToStorage() {
    appStorage.setItem('appagent_provider', currentProvider);
}

function changeProvider(providerId) {
    if (getProviderById(providerId)) {
        currentProvider = providerId;
        saveProviderToStorage();
        updateModelDisplay();
        // Re-render the provider dropdown to update selection
        populateProviderDropdown();
        // Show/hide OAuth button based on provider
        updateClaudeOAuthButton();
    }
}

// --- Claude OAuth UI ---

function initClaudeOAuth() {
    chrome.runtime.onMessage.addListener(function(msg) {
        if (msg.type === 'claude-oauth-updated') updateClaudeOAuthStatus();
    });

    updateClaudeOAuthStatus();
    // Refresh status periodically
    setInterval(updateClaudeOAuthStatus, 60000);
}

function updateClaudeOAuthStatus() {
    var provider = getProviderById(currentProvider);
    if (!provider || !provider.isClaudeOAuth) return;

    chrome.runtime.sendMessage({ type: 'claude-oauth-status' }, function(response) {
        if (chrome.runtime.lastError || !response) {
            setLLMConnectionStatus('disconnected');
            return;
        }
        if (response.loggedIn && !response.expired) {
            setLLMConnectionStatus('connected');
        } else {
            setLLMConnectionStatus('disconnected');
        }
    });
}

function updateModelDisplay() {
    var provider = getProviderById(currentProvider);
    var modelNameEl = document.getElementById('model-name');
    var homeModelNameEl = document.getElementById('home-model-name');
    if (modelNameEl && provider) {
        var textEl = modelNameEl.querySelector('.model-name-text');
        if (textEl) textEl.textContent = provider.name;
        modelNameEl.style.display = '';
    }
    if (homeModelNameEl && provider) {
        var homeTextEl = homeModelNameEl.querySelector('.model-name-text');
        if (homeTextEl) homeTextEl.textContent = provider.name;
    }
    // Re-check OAuth status when model changes
    if (provider && provider.isClaudeOAuth) {
        updateClaudeOAuthStatus();
    } else {
        // Non-OAuth providers: assume connected if API key is set
        setLLMConnectionStatus(provider && provider.apiKey ? 'connected' : 'disconnected');
    }
}

function updateModelConnectionDot() {
    var dots = [document.getElementById('model-status-dot'), document.getElementById('home-model-status-dot')];
    dots.forEach(function(dot) {
        if (!dot) return;
        dot.className = 'model-status-dot ' + llmConnectionStatus;
    });
    var provider = getProviderById(currentProvider);
    var isOAuth = provider && provider.isClaudeOAuth;
    var isDisconnected = llmConnectionStatus === 'disconnected' || llmConnectionStatus === 'unknown';
    var els = [document.getElementById('model-name'), document.getElementById('home-model-name')];
    var loginIcons = [document.getElementById('model-login-icon'), document.getElementById('home-model-login-icon')];

    els.forEach(function(el, idx) {
        if (!el) return;
        var textEl = el.querySelector('.model-name-text');
        var name = textEl ? textEl.textContent : '';
        // Set pill class for connected/disconnected coloring
        el.className = 'model-name ' + llmConnectionStatus;
        if (llmConnectionStatus === 'connected') {
            el.title = name + (isOAuth ? ' — Connected. Click to logout.' : ' — Connected');
        } else if (isOAuth && isDisconnected) {
            el.title = name + ' — Click to login';
        } else {
            el.title = name;
        }
        // Show/hide login icon
        var loginIcon = loginIcons[idx];
        if (loginIcon) {
            if (isOAuth && isDisconnected) {
                loginIcon.style.display = '';
                loginIcon.innerHTML = UI_ICONS.arrowRight;
            } else {
                loginIcon.style.display = 'none';
            }
        }
    });
}

function handleModelNameClick() {
    var provider = getProviderById(currentProvider);
    if (provider && provider.isClaudeOAuth) {
        if (llmConnectionStatus === 'connected') {
            // Connected: logout
            chrome.runtime.sendMessage({ type: 'claude-oauth-logout' }, function() {
                updateClaudeOAuthStatus();
                showSnackbar('Logged out from Claude', 'info');
            });
        } else {
            // Disconnected: login
            showSnackbar('Logging in to Claude...', 'info');
            chrome.runtime.sendMessage({ type: 'claude-oauth-login' }, function(response) {
                if (chrome.runtime.lastError) {
                    showSnackbar('OAuth error: ' + chrome.runtime.lastError.message, 'error');
                } else if (response && response.error) {
                    showSnackbar('OAuth error: ' + response.error, 'error');
                } else {
                    showSnackbar('Logged in to Claude via OAuth', 'success');
                }
                updateClaudeOAuthStatus();
            });
        }
    } else {
        // Non-OAuth: open settings
        toggleSettingsPanel();
    }
}

function setLLMConnectionStatus(status) {
    llmConnectionStatus = status;
    updateModelConnectionDot();
}
