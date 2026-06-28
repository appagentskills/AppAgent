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

// Double-approval guard: locate an existing approval row for this exact tool
// call (matched on the STABLE prog_<parent>_<callId> toolCallId) in the target
// chat. Used to stop a SECOND prompt when the outer js_eval / skill is
// re-dispatched (MV3 service-worker respawn, agent-loop replay) and the inner
// call is re-issued with the same id. Scans newest-first so the most recent
// row wins. Returns { index, msg } or null.
function findExistingApprovalRow(chat, toolCallId) {
    if (!chat || !Array.isArray(chat.messages) || !toolCallId) return null;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m && m.role === 'approval' && m.toolCallId === toolCallId) {
            return { index: i, msg: m };
        }
    }
    return null;
}

function showToolApprovalPrompt(displayName, args, permissionKey, toolCallId, actualToolName, targetChatId, options) {
    options = options || {};
    return new Promise(function(resolve) {
        // Use targetChatId if provided (for background streaming), otherwise currentChatId
        var chatId = targetChatId || currentChatId;
        var chat = chats[chatId];
        // Unknown/deleted chatId: degrade to a denial instead of throwing an
        // uncaught TypeError inside the Promise (which would hang the caller).
        if (!chat) { resolve(false); return; }

        // DOUBLE-APPROVAL FIX: if a prior dispatch of this exact call already
        // created an approval row, do NOT append a second prompt. A terminal
        // verdict resolves this caller immediately (covers the race where the
        // user already answered on the page but the re-dispatching service
        // worker still saw 'pending'); a still-pending row is REUSED — we rebind
        // THIS call's resolver to it and re-surface the (already-deduped)
        // notification so the user sees exactly one prompt and the live caller
        // gets the verdict.
        var existingRow = findExistingApprovalRow(chat, toolCallId);
        if (existingRow) {
            var existingStatus = existingRow.msg.status;
            if (existingStatus === 'allowed' || existingStatus === 'session_allowed' || existingStatus === 'always_allowed') {
                resolve(true); return;
            }
            if (existingStatus === 'denied') {
                resolve(false); return;
            }
            // Non-terminal (pending): reuse the existing row, rebinding the
            // resolver to this (live) caller so the verdict reaches it.
            var reuseKey = chatId + ':' + existingRow.index;
            pendingToolApprovals[reuseKey] = { resolve: resolve, approvalIndex: existingRow.index, chatId: chatId, toolCallId: toolCallId };
            var reuseTitle = (toolCallId && toolCallId.startsWith('prog_'))
                ? (options.widgetName || chat.title || 'Background task')
                : (chat.title || 'A chat');
            var reuseStatusMessage = (args && args.status_message) ? args.status_message : null;
            showApprovalNotification(reuseTitle, displayName, chatId, reuseStatusMessage, existingRow.index, args);
            renderChatList();
            return;
        }
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
        // PR383-F3: carry toolCallId so the entry/row can be re-matched after a
        // snapshot merge shifts the row's index (see _mergePagePendingRows).
        var approvalKey = chatId + ':' + approvalIndex;
        pendingToolApprovals[approvalKey] = { resolve: resolve, approvalIndex: approvalIndex, chatId: chatId, toolCallId: toolCallId };

        // For programmatic tool calls (from widgets/js_eval), always use notification
        // This avoids calling renderMessages() which would destroy widget iframes
        // Notifications work everywhere: chat view, dashboard, any view
        var isProgrammaticCall = toolCallId && toolCallId.startsWith('prog_');
        if (isProgrammaticCall) {
            // Use widget name if provided (from widget tool calls); programmatic
            // calls also come from js_eval chains and other chats routed via the
            // worker, so fall back to the originating chat's title before the
            // generic label — "Widget" was misleading for non-widget callers.
            var notificationTitle = options.widgetName || chat.title || 'Background task';
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
        // Same guard as showToolApprovalPrompt: degrade to denial, don't throw.
        if (!chat) { resolve(false); return; }

        // DOUBLE-APPROVAL FIX (batch mirror): reuse/short-circuit an existing
        // approval row for this toolCallId instead of appending a duplicate.
        var existingRowB = findExistingApprovalRow(chat, toolCallId);
        if (existingRowB) {
            var existingStatusB = existingRowB.msg.status;
            if (existingStatusB === 'allowed' || existingStatusB === 'session_allowed' || existingStatusB === 'always_allowed') {
                resolve(true); return;
            }
            if (existingStatusB === 'denied') {
                resolve(false); return;
            }
            var reuseKeyB = chatId + ':' + existingRowB.index;
            pendingToolApprovals[reuseKeyB] = { resolve: resolve, approvalIndex: existingRowB.index, chatId: chatId, toolCallId: toolCallId };
            var isProgB = toolCallId && toolCallId.startsWith('prog_');
            var reuseTitleB = isProgB ? (options.widgetName || chat.title || 'Background task') : (chat.title || 'A chat');
            var reuseStatusMessageB = (args && args.status_message) ? args.status_message : null;
            showApprovalNotification(reuseTitleB, displayName, chatId, reuseStatusMessageB, existingRowB.index, args);
            return;
        }
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
        // PR383-F3: carry toolCallId (same rationale as showToolApprovalPrompt).
        var approvalKey = chatId + ':' + approvalIndex;
        pendingToolApprovals[approvalKey] = { resolve: resolve, approvalIndex: approvalIndex, chatId: chatId, toolCallId: toolCallId };

        // Queue notification (will be shown after all approvals are added)
        // Always show notification popup (not just when on different chat/view)
        var isProgrammaticCall = toolCallId && toolCallId.startsWith('prog_');
        var notificationTitle = isProgrammaticCall ? (options.widgetName || chat.title || 'Background task') : (chat.title || 'A chat');
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
        } else {
            // PR384-FIX-4: the direct key ALSO misses when the clicked approval
            // was already RESOLVED (stale popover / lingering notification). The
            // sole-entry fallback below would then resolve a DIFFERENT pending
            // approval — approving a tool the user never reviewed. Guard it: if
            // the caller's index points at an approval row that is no longer
            // pending, this click is STALE → no-op. Only fall through to the
            // sole-entry fallback when the index points at nothing / a shifted
            // row (the merge-drift case the fallback actually targets).
            var _staleChat = chats[targetChatId];
            var _staleRow = (_staleChat && Array.isArray(_staleChat.messages))
                ? _staleChat.messages[approvalIndex] : null;
            if (_staleRow && _staleRow.role === 'approval' && _staleRow.status !== 'pending') {
                return;
            }
            // PR383-F3: a snapshot merge may have re-keyed this chat's pending
            // entry to the row's new index (_mergePagePendingRows), so a
            // notification/onclick carrying the OLD index misses the direct key.
            // If the chat has exactly ONE pending entry it is unambiguously the
            // one being answered; with several we refuse to guess (old no-op).
            var _soleKey = null, _multi = false;
            for (var _pk in pendingToolApprovals) {
                if (pendingToolApprovals[_pk] && pendingToolApprovals[_pk].chatId === targetChatId) {
                    if (_soleKey) { _multi = true; break; }
                    _soleKey = _pk;
                }
            }
            if (_soleKey && !_multi) {
                approvalKey = _soleKey;
                chatId = targetChatId;
            }
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
    if (!chat || !Array.isArray(chat.messages)) return;

    // PR383-F3: the pending entry holds the authoritative row index (kept
    // current by _mergePagePendingRows' re-key); a caller-supplied index from a
    // stale notification or pre-merge onclick may lag. Trust the entry's index.
    if (approvalKey && pendingToolApprovals[approvalKey] &&
        typeof pendingToolApprovals[approvalKey].approvalIndex === 'number') {
        approvalIndex = pendingToolApprovals[approvalKey].approvalIndex;
    }
    var msg = chat.messages[approvalIndex];
    // PR383-F3 (defense in depth): if the index lookup still misses (row drifted
    // in a snapshot merge without a re-key), locate the pending approval row by
    // the entry's toolCallId — approval rows carry it from creation.
    if ((!msg || msg.role !== 'approval' || msg.status !== 'pending') &&
        approvalKey && pendingToolApprovals[approvalKey] && pendingToolApprovals[approvalKey].toolCallId) {
        var _wantTc = pendingToolApprovals[approvalKey].toolCallId;
        for (var _fi = 0; _fi < chat.messages.length; _fi++) {
            var _fm = chat.messages[_fi];
            if (_fm && _fm.role === 'approval' && _fm.status === 'pending' && _fm.toolCallId === _wantTc) {
                approvalIndex = _fi;
                msg = _fm;
                break;
            }
        }
    }
    if (!msg || msg.role !== 'approval' || msg.status !== 'pending') return;

    var approved = action !== 'deny';

    // Update status based on action
    if (action === 'allow') {
        msg.status = 'allowed';
    } else if (action === 'session') {
        msg.status = 'session_allowed';
        if (msg.permissionKey) {
            sessionPermissions[msg.permissionKey] = 'allow';
            // Session-only permission: not persisted to IDB, so the SW
            // boot-time `loadToolPermissionsInWorker` won't pick it up. Push
            // it to the SW now so the next tool call from the SW's agent
            // loop sees 'allow' instead of falling through to 'ask'.
            if (typeof pushPermissionsToOffscreen === 'function') {
                pushPermissionsToOffscreen({ sessionPermissions: sessionPermissions });
            }
        }
    } else if (action === 'auto') {
        msg.status = 'always_allowed';
        if (msg.permissionKey) {
            // setToolPermissionByKey → saveToolPermissions / saveInstance-
            // Permissions → pushPermissionsToOffscreen, so the SW mirror is
            // updated transitively. No extra push needed here.
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
            // Clicking the pill opens the model menu (reasoning effort + model picker +
            // optional OAuth login/logout row) — it does NOT log out on a single click,
            // so don't advertise "Click to logout" here.
            el.title = name + ' — Connected';
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

// Resolve the connection route for a provider from its endpoint. The row icon
// is intentionally a single consistent glyph (the same `model` icon shown in
// the header pill) rather than a per-vendor guess — guessed vendor icons read
// as arbitrary and inconsistent.
function _modelRowMeta(p) {
    var ep = ((p && p.endpoint) || '').toLowerCase();
    var conn = '';
    if (ep.indexOf('openrouter') >= 0) conn = 'OpenRouter';
    else if (ep.indexOf('localhost') >= 0 || ep.indexOf('127.0.0.1') >= 0) conn = 'Proxy';
    else if (ep.indexOf('anthropic.com') >= 0) conn = 'Direct';
    return { conn: conn };
}

function _modelMenuRowHtml(p) {
    var meta = _modelRowMeta(p);
    var sel = p.name === currentProvider;
    var badges = p.isClaudeOAuth ? '<span class="model-row-badge oauth">OAuth</span>' : '';
    var subBits = [];
    if (p.model) subBits.push(escapeHtml(p.model));
    if (meta.conn) subBits.push(escapeHtml(meta.conn));
    var sub = subBits.join(' \u00b7 ');
    var check = sel
        ? '<span class="model-row-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>'
        : '';
    return '<div class="model-menu-row' + (sel ? ' selected' : '') + '" onclick="selectModelFromMenu(\'' + escapeJsString(p.name) + '\')">' +
        '<span class="model-row-icon">' + UI_ICONS.model + '</span>' +
        '<div class="model-row-main">' +
            '<div class="model-row-title">' + escapeHtml(p.name) + badges + '</div>' +
            (sub ? '<div class="model-row-sub">' + sub + '</div>' : '') +
        '</div>' +
        check +
    '</div>';
}

// Reasoning-effort level meter (signal-bar style) — fills `level` of 5 bars so
// the dropdown conveys intensity at a glance instead of plain text.
function _effortMeterIcon(level) {
    var heights = [5, 8, 11, 14, 17];
    var bars = '';
    for (var i = 0; i < 5; i++) {
        var x = 2.5 + i * 4.2;
        var h = heights[i];
        var op = i < level ? '1' : '0.22';
        bars += '<rect x="' + x + '" y="' + (21 - h) + '" width="2.8" height="' + h + '" rx="1" fill="currentColor" opacity="' + op + '"/>';
    }
    return '<svg viewBox="0 0 24 24">' + bars + '</svg>';
}

// The effort the system applies for a provider when nothing is overridden.
// Pulled from the seed config by name; falls back to 'high' (the server-side
// default used when no reasoning.effort is sent).
function _providerDefaultEffort(p) {
    var def = '';
    if (p && typeof DEFAULT_API_PROVIDERS !== 'undefined') {
        var d = DEFAULT_API_PROVIDERS.filter(function(x){ return x.name === p.name; })[0];
        if (d && d.effort) def = d.effort;
    }
    return def || 'high';
}

var _MODEL_CHECK_SVG = '<span class="model-row-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';

function _effortRowHtml(e, curEffort, defEffort) {
    var sel = curEffort === e.v;
    var isDef = defEffort === e.v;
    return '<div class="model-menu-row effort' + (sel ? ' selected' : '') + '" onclick="setProviderEffort(\'' + e.v + '\')">' +
        '<span class="model-row-icon">' + _effortMeterIcon(e.level) + '</span>' +
        '<div class="model-row-main"><div class="model-row-title">' + e.label +
            (isDef ? '<span class="model-row-badge">default</span>' : '') +
        '</div></div>' +
        (sel ? _MODEL_CHECK_SVG : '') +
    '</div>';
}

// Pill click now opens a dropdown (reasoning effort + model picker + optional
// OAuth login/logout row). It NO LONGER logs in/out on a single click.
function toggleModelMenu(event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    var existing = document.getElementById('model-menu');
    if (existing) { existing.remove(); document.removeEventListener('click', _closeModelMenuOnOutside); return; }

    var anchor = (event && event.currentTarget) || document.getElementById('model-name') || document.getElementById('home-model-name');
    var provider = getProviderById(currentProvider);
    var menu = document.createElement('div');
    menu.id = 'model-menu';
    menu.className = 'model-menu';

    var html = '<div class="model-menu-section-title">Reasoning effort</div>';
    var defEffort = _providerDefaultEffort(provider);
    var curEffort = (provider && provider.effort) || defEffort;
    [
        { v: 'low', label: 'Low', level: 1 },
        { v: 'medium', label: 'Medium', level: 2 },
        { v: 'high', label: 'High', level: 3 },
        { v: 'xhigh', label: 'X-High', level: 4 },
        { v: 'max', label: 'Max', level: 5 }
    ].forEach(function(e) { html += _effortRowHtml(e, curEffort, defEffort); });
    html += '<div class="model-menu-section-title">Model</div>';
    getAllProviders().forEach(function(p) { html += _modelMenuRowHtml(p); });
    if (provider && provider.isClaudeOAuth) {
        html += '<div class="model-menu-section-title">Claude OAuth</div>';
        var oauthLabel = llmConnectionStatus === 'connected' ? 'Log out' : 'Log in';
        html += '<div class="custom-dropdown-option" onclick="modelMenuOAuthToggle()">' + oauthLabel + '</div>';
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);

    var r = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    setTimeout(function() { document.addEventListener('click', _closeModelMenuOnOutside); }, 0);
}

function _closeModelMenuOnOutside(e) {
    var menu = document.getElementById('model-menu');
    if (menu && !menu.contains(e.target) && !e.target.closest('.model-name')) {
        menu.remove();
        document.removeEventListener('click', _closeModelMenuOnOutside);
    }
}

function _closeModelMenu() {
    var menu = document.getElementById('model-menu');
    if (menu) menu.remove();
    document.removeEventListener('click', _closeModelMenuOnOutside);
}

function setProviderEffort(value) {
    var provider = getProviderById(currentProvider);
    if (!provider) return;
    if (value) { provider.effort = value; } else { delete provider.effort; }
    if (typeof saveApiProvider === 'function') saveApiProvider(provider);
    _closeModelMenu();
    showSnackbar('Reasoning effort: ' + (value || 'default'), 'info');
}

function selectModelFromMenu(name) {
    changeProvider(name);
    _closeModelMenu();
}

function modelMenuOAuthToggle() {
    _closeModelMenu();
    if (llmConnectionStatus === 'connected') {
        chrome.runtime.sendMessage({ type: 'claude-oauth-logout' }, function() {
            updateClaudeOAuthStatus();
            showSnackbar('Logged out from Claude', 'info');
        });
    } else {
        showSnackbar('Logging in to Claude...', 'info');
        chrome.runtime.sendMessage({ type: 'claude-oauth-login' }, function(response) {
            if (chrome.runtime.lastError) { showSnackbar('OAuth error: ' + chrome.runtime.lastError.message, 'error'); }
            else if (response && response.error) { showSnackbar('OAuth error: ' + response.error, 'error'); }
            else { showSnackbar('Logged in to Claude via OAuth', 'success'); }
            updateClaudeOAuthStatus();
        });
    }
}

function setLLMConnectionStatus(status) {
    llmConnectionStatus = status;
    updateModelConnectionDot();
}
