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

// Check if a chat has a pending prompt_user form the user hasn't answered.
// Mirror of chatHasPendingApproval — prompt rows are persisted chat.messages
// entries pushed by executePromptUser (tools/100-prompt-user.js) and flipped
// to 'submitted' / 'cancelled' by submitPromptUser / cancelPromptUser.
function chatHasPendingPrompt(chatId) {
    var chat = chats[chatId];
    if (!chat || !chat.messages) return false;
    return chat.messages.some(function(m) {
        return m.role === 'prompt_user' && m.status === 'pending';
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

    // Explicit navigation to the chat re-surfaces even user-dismissed cards —
    // clear the dismissal marks so the watchdog can manage them again.
    if (typeof _dismissedApprovalKeys !== 'undefined') {
        for (var dk in _dismissedApprovalKeys) {
            if (dk.indexOf(chatId + ':') === 0) delete _dismissedApprovalKeys[dk];
        }
    }

    // If currently showing notifications for this chat, clear them
    if (Array.isArray(currentApprovalNotification) &&
        currentApprovalNotification.length > 0 &&
        currentApprovalNotification[0].chatId === chatId) {
        currentApprovalNotification = null;
        isShowingApprovalNotification = false;
        var approvalCard = typeof getApprovalCardEl === 'function' ? getApprovalCardEl() : document.getElementById('approval-card');
        if (approvalCard) approvalCard.classList.remove('show');
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

// BOOT-RACE FIX: the SW replays parked exec-approval-prompt calls on panel
// hello (worker/130-port-bridge.js → replayParkedToolCalls) and they can reach
// the page BEFORE loadChatsFromStorage has hydrated the `chats` map. The old
// `if (!chat) resolve(false)` silently auto-denied those. Wait briefly for
// hydration before deciding; only give up once the map is loaded (grace
// period) or after a hard timeout, when the chat is genuinely absent.
function _retryApprovalWhenChatLoads(chatId, retryFn, giveUpFn) {
    var waited = 0;
    var timer = setInterval(function() {
        waited += 250;
        if (chats[chatId]) {
            clearInterval(timer);
            retryFn();
            return;
        }
        var hydrated = (typeof _chatsHydrated === 'undefined') || _chatsHydrated;
        if ((hydrated && waited >= 3000) || waited >= 15000) {
            clearInterval(timer);
            console.warn('[approval] chat ' + chatId + ' not found after ' + waited + 'ms — denying tool approval');
            giveUpFn();
        }
    }, 250);
}

function showToolApprovalPrompt(displayName, args, permissionKey, toolCallId, actualToolName, targetChatId, options) {
    options = options || {};
    return new Promise(function(resolve) {
        // Use targetChatId if provided (for background streaming), otherwise currentChatId
        var chatId = targetChatId || currentChatId;
        var chat = chats[chatId];
        // Unknown chatId: likely the boot replay race (chats not hydrated
        // yet) — retry briefly instead of silently auto-denying. Only a chat
        // still absent AFTER hydration is treated as deleted → denial.
        if (!chat) {
            _retryApprovalWhenChatLoads(chatId, function() {
                showToolApprovalPrompt(displayName, args, permissionKey, toolCallId, actualToolName, chatId, options).then(resolve);
            }, function() {
                // AB: mark the give-up on the caller-shared options object so
                // _handleApprovalPromptFromOffscreen (app/045) can suppress a
                // non-primary panel's auto-deny — with the prompt broadcast to
                // every panel, only the PRIMARY may deny for everyone.
                options._gaveUp = true;
                resolve(false);
            });
            return;
        }

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
            // AB: with the SW seeding the approval row BEFORE the prompt
            // envelope (per-port FIFO), EVERY panel takes THIS reuse branch —
            // the push branch below never runs, so its Action-button lock and
            // waiting-badge refresh must fire here too (mirrors :191/:229).
            if (chat.isBackground && chat.actionId && typeof setActionNeedsPermission === 'function') {
                setActionNeedsPermission(chat.actionId, { approvalIndex: existingRow.index });
            }
            if (typeof _refreshWaitingBadges === 'function') { try { _refreshWaitingBadges(chatId); } catch (e) {} }
            var reuseTitle = (toolCallId && toolCallId.startsWith('prog_'))
                ? (options.widgetName || chat.title || 'Background task')
                : (chat.title || 'A chat');
            var reuseStatusMessage = (args && args.status_message) ? args.status_message : null;
            showApprovalNotification(reuseTitle, displayName, chatId, reuseStatusMessage, existingRow.index, args, options);
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
            showApprovalNotification(notificationTitle, displayName, chatId, statusMessage, approvalIndex, args, options);
        } else if (currentChatId === chatId && currentView === 'chat') {
            // For agent tool calls on current chat, show notification popup instead of inline
            var chatTitle = chat.title || 'A chat';
            var statusMessage = (args && args.status_message) ? args.status_message : null;
            showApprovalNotification(chatTitle, displayName, chatId, statusMessage, approvalIndex, args, options);
            renderMessages(); // Still render to update chat but notification handles approval
            scrollToBottomIfAllowed();
        } else {
            // Show notification when user is on a different chat or different view
            var chatTitle = chat.title || 'A chat';
            var statusMessage = (args && args.status_message) ? args.status_message : null;
            showApprovalNotification(chatTitle, displayName, chatId, statusMessage, approvalIndex, args, options);
        }
        // Always update chat list to show attention indicator
        renderChatList();
        // Live needs_permission badge on jobs rows / expand cards / header pill.
        if (typeof _refreshWaitingBadges === 'function') { try { _refreshWaitingBadges(chatId); } catch (e) {} }
    });
}

// Batch version: adds approval message without rendering/notifying immediately
// Used when adding multiple approvals at once - caller handles render and notifications after all are added
function showToolApprovalPromptBatch(displayName, args, permissionKey, toolCallId, actualToolName, targetChatId, options) {
    options = options || {};
    return new Promise(function(resolve) {
        var chatId = targetChatId || currentChatId;
        var chat = chats[chatId];
        // Same guard as showToolApprovalPrompt: wait for chat hydration
        // before denying (boot replay race), deny only if genuinely absent.
        if (!chat) {
            _retryApprovalWhenChatLoads(chatId, function() {
                showToolApprovalPromptBatch(displayName, args, permissionKey, toolCallId, actualToolName, chatId, options).then(resolve);
            }, function() { resolve(false); });
            return;
        }

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
        // Live needs_permission badge (batch path — caller renders messages/
        // notifications later, but the badge surfaces refresh here).
        if (typeof _refreshWaitingBadges === 'function') { try { _refreshWaitingBadges(chatId); } catch (e) {} }

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

    // Stop the hidden-tab title flash if this was the last pending approval
    // (deferred so the resolver delete / queue clear below happen first).
    setTimeout(function() {
        if (typeof syncApprovalTitleFlash === 'function') { try { syncApprovalTitleFlash(); } catch (e) {} }
    }, 0);

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
    // Clear the live needs_permission badge on jobs rows / header pill.
    if (typeof _refreshWaitingBadges === 'function') { try { _refreshWaitingBadges(chatId); } catch (e) {} }

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
        // The approval was still PENDING when the original loop died, so the
        // gated request was never issued. Clear any dispatch marker so the
        // approved-replay guard runs it instead of treating it as indeterminate.
        if (msg.toolCallId && chat.messages) {
            for (var _pi = chat.messages.length - 1; _pi >= 0; _pi--) {
                var _pm = chat.messages[_pi];
                if (_pm.role === 'tool' && _pm.tool_call_id === msg.toolCallId) {
                    if (_pm._placeholder) delete _pm._dispatched;
                    break;
                }
            }
        }
        await runAgent(chatId);
    }
}

function saveProviderToStorage() {
    appStorage.setItem('appagent_provider', currentProvider);
}

function changeProvider(providerId) {
    if (getProviderById(providerId)) {
        var previousProviderObj = getProviderById(currentProvider);
        if (typeof invalidateCreditsRequests === 'function') invalidateCreditsRequests();
        currentProvider = providerId;
        // ALWAYS tell the authoritative worker about the new global selection.
        // The SW keeps its own `currentProvider` copy (worker/000-runtime-
        // globals.js) and cannot read localStorage; before this it only
        // learned the provider from run-agent posts, so a switch made while
        // idle (or between send-message-driven runs) left the SW resolving
        // every un-pinned chat against the PREVIOUS model until the next
        // run-agent. The SW 'provider-change' handler (worker/130-port-
        // bridge.js) just sets currentProvider when no chatId is given.
        //
        // Abort semantics are unchanged and stay gated: only when the
        // PREVIOUS provider was ChatGPT-OAuth and the foreground main chat is
        // running do we also name that chat, so the worker aborts the issued
        // ChatGPT request/backoff without marking a user send.
        var foregroundChatId = (typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId)
            ? activeStreamingChatId : ((typeof currentChatId !== 'undefined') ? currentChatId : null);
        var foregroundChat = (foregroundChatId && typeof chats !== 'undefined') ? chats[foregroundChatId] : null;
        var abortChatId = (previousProviderObj && previousProviderObj.isChatGPTOAuth
            && foregroundChatId && (!foregroundChat || !foregroundChat.isSubAgent)
            && typeof runningChatIds !== 'undefined' && runningChatIds[foregroundChatId])
            ? foregroundChatId : null;
        if (typeof pushProviderChangeToOffscreen === 'function') {
            pushProviderChangeToOffscreen(providerId, abortChatId);
        }
        saveProviderToStorage();
        updateModelDisplay();
        // Immediately repaint from the selected provider's scoped cache (or its
        // loading state) and start that provider's refresh. Stale completions are
        // rejected by fetchCredits' generation + provider guard.
        if (typeof fetchCredits === 'function') fetchCredits();
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

var _oauthStatusGeneration = 0;
function _oauthStatusStillCurrent(generation, providerName, providerFlag) {
    var current = getProviderById(currentProvider);
    return generation === _oauthStatusGeneration && !!current && current.name === providerName && !!current[providerFlag];
}

function updateClaudeOAuthStatus() {
    var provider = getProviderById(currentProvider);
    if (!provider || !provider.isClaudeOAuth) return;
    var generation = ++_oauthStatusGeneration;
    var providerName = provider.name;

    chrome.runtime.sendMessage({ type: 'claude-oauth-status' }, function(response) {
        if (!_oauthStatusStillCurrent(generation, providerName, 'isClaudeOAuth')) return;
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

// --- ChatGPT (OpenAI) OAuth UI ---
// Same shape as the Claude pair above. The 'openai-oauth-updated' broadcast is
// fired by saveChatGPTOAuthCreds / the logout + device-poll failure paths in
// background.js, so the dot flips as soon as the device code is approved.
function initChatGPTOAuth() {
    chrome.runtime.onMessage.addListener(function(msg) {
        if (msg.type === 'openai-oauth-updated') {
            updateChatGPTOAuthStatus();
            if (msg.error) {
                closeChatGPTDeviceCodeModal();
                try { showSnackbar('ChatGPT login failed: ' + msg.error, 'error'); } catch (e) {}
            } else if (msg.openaiOAuth) {
                closeChatGPTDeviceCodeModal();
                try { showSnackbar('Logged in to ChatGPT', 'success'); } catch (e) {}
            } else {
                // Logout/credential removal: no pending code remains valid.
                closeChatGPTDeviceCodeModal();
            }
        }
    });

    updateChatGPTOAuthStatus();
    setInterval(updateChatGPTOAuthStatus, 60000);
}

function updateChatGPTOAuthStatus() {
    var provider = getProviderById(currentProvider);
    if (!provider || !provider.isChatGPTOAuth) return;
    var generation = ++_oauthStatusGeneration;
    var providerName = provider.name;

    chrome.runtime.sendMessage({ type: 'openai-oauth-status' }, function(response) {
        if (!_oauthStatusStillCurrent(generation, providerName, 'isChatGPTOAuth')) return;
        if (chrome.runtime.lastError || !response) {
            setLLMConnectionStatus('disconnected');
            return;
        }
        if (response.loggedIn && !response.expired) setLLMConnectionStatus('connected');
        else if (response.pending) setLLMConnectionStatus('pending');
        else if (response.error) setLLMConnectionStatus('error');
        else setLLMConnectionStatus('disconnected');
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
    // Invalidate every older async OAuth callback and synchronously reset the
    // visible state before querying the newly selected provider.
    _oauthStatusGeneration++;
    setLLMConnectionStatus('unknown');
    // Re-check OAuth status when model changes
    if (provider && provider.isChatGPTOAuth) {
        updateChatGPTOAuthStatus();
    } else if (provider && provider.isClaudeOAuth) {
        updateClaudeOAuthStatus();
    } else {
        // Non-OAuth providers use their inline API key.
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
    var isOAuth = provider && (provider.isClaudeOAuth || provider.isChatGPTOAuth);
    var isDisconnected = llmConnectionStatus === 'disconnected' || llmConnectionStatus === 'unknown';
    var els = [document.getElementById('model-name'), document.getElementById('home-model-name')];
    var loginButtons = [document.getElementById('model-login-btn'), document.getElementById('home-model-login-btn')];

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
        // Claude + ChatGPT OAuth providers get a compact login action inside
        // the same model pill when they are not connected.
        var loginButton = loginButtons[idx];
        if (loginButton) {
            // Login-only control (Connect / Waiting… / Retry). NEVER a logout
            // on the pill — logging out lives in the pill dropdown's
            // subscription section (modelMenuOAuthToggle /
            // modelMenuChatGPTOAuthToggle) and is only offered while connected.
            var showButton = isOAuth && llmConnectionStatus !== 'connected';
            loginButton.style.display = showButton ? '' : 'none';
            if (showButton) {
                loginButton.classList.toggle('pending', llmConnectionStatus === 'pending');
                loginButton.disabled = llmConnectionStatus === 'pending';
                loginButton.textContent = llmConnectionStatus === 'pending' ? 'Waiting…' : (llmConnectionStatus === 'error' ? 'Retry' : 'Connect');
                loginButton.setAttribute('aria-label', loginButton.textContent + ' ' + (provider.isClaudeOAuth ? 'Claude' : 'ChatGPT') + ' subscription');
            }
        }
    });
}

// Resolve the connection route for a provider from its endpoint. The row icon
// is intentionally a single consistent glyph (the same `model` icon shown in
// the header pill) rather than a per-vendor guess — guessed vendor icons read
// as arbitrary and inconsistent.
function _modelRowMeta(p) {
    var ep = (p && p.endpoint ? p.endpoint : '').toLowerCase();
    var conn = '';
    if (ep.indexOf('openrouter') >= 0) conn = 'OpenRouter';
    else if (ep.indexOf('localhost') >= 0 || ep.indexOf('127.0.0.1') >= 0) conn = 'Proxy';
    else if (ep.indexOf('anthropic.com') >= 0) conn = 'Anthropic';
    return { conn: conn };
}

function _modelMenuRowHtml(p) {
    var meta = _modelRowMeta(p);
    var sel = p.name === currentProvider;
    var badges = (p.isClaudeOAuth || p.isChatGPTOAuth) ? '<span class="model-row-badge oauth">Subscription</span>' : '';
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
            '<div class="model-row-title"><span class="model-row-name" title="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + '</span>' + badges + '</div>' +
            (sub ? '<div class="model-row-sub">' + sub + '</div>' : '') +
        '</div>' +
        '<button class="model-row-edit" title="Edit model" aria-label="Edit model" onclick="event.stopPropagation();editModelFromMenu(\'' + escapeJsString(p.name) + '\')">' + UI_ICONS.edit + '</button>' +
        check +
    '</div>';
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

// Discrete reasoning-effort levels — same values the settings page's provider
// modal writes (provider.effort via saveApiProvider); slider index = position.
var _EFFORT_LEVELS = [
    { v: 'low', label: 'Low' },
    { v: 'medium', label: 'Medium' },
    { v: 'high', label: 'High' },
    { v: 'xhigh', label: 'X-High' },
    { v: 'max', label: 'Max' }
];

// Dynamic label under the effort slider: level name + 'default' badge when
// the level equals the provider's seed default.
function _effortSliderLabelHtml(idx) {
    var e = _EFFORT_LEVELS[idx] || _EFFORT_LEVELS[2];
    var provider = getProviderById(currentProvider);
    var isDef = e.v === _providerDefaultEffort(provider);
    // ChatGPT OAuth: transformToResponses (background.js) clamps xhigh/max to
    // 'high' (the Responses API rejects them) — say so instead of silently lying.
    var clampedOnChatGPT = !!(provider && provider.isChatGPTOAuth && (e.v === 'xhigh' || e.v === 'max'));
    return '<span class="model-menu-effort-name">' + e.label + '</span>' +
        (isDef ? '<span class="model-row-badge">default</span>' : '') +
        (clampedOnChatGPT ? '<span class="model-row-badge">sent as high on ChatGPT</span>' : '');
}

// Live refresh while dragging (does not persist): label text, level circles
// (filled up to the current one, the current one shrinks under the disc) and
// the morphing disc — --pos on the track drives the disc glide + track fill
// (CSS transitions), and re-adding .is-morph restarts the squash-stretch
// keyframes. _lastIdx guards against a no-move restart (e.g. the change
// event re-running the same index after release).
function onEffortSliderInput(v) {
    var idx = parseInt(v, 10);
    var el = document.getElementById('model-menu-effort-label');
    if (el) el.innerHTML = _effortSliderLabelHtml(idx);
    var track = document.querySelector('#model-menu .model-menu-effort-track');
    if (track) track.style.setProperty('--pos', String(idx / 4));
    document.querySelectorAll('#model-menu .effort-dot').forEach(function(d, i) {
        d.classList.toggle('active', i <= idx);
        d.classList.toggle('current', i === idx);
    });
    var disc = document.getElementById('model-menu-effort-disc');
    if (disc && disc._lastIdx !== idx) {
        disc._lastIdx = idx;
        disc.classList.remove('is-morph');
        void disc.offsetWidth; // reflow so the keyframe animation restarts
        disc.classList.add('is-morph');
    }
}

// Commit: persist provider.effort (same storage as before — saveApiProvider).
// Menu stays open, like the tier selects.
async function commitEffortSlider(v) {
    var idx = parseInt(v, 10);
    var e = _EFFORT_LEVELS[idx];
    var provider = getProviderById(currentProvider);
    if (!e || !provider || typeof saveApiProvider !== 'function') return;
    var previousEffort = provider.effort;
    var updated = Object.assign({}, provider, { effort: e.v });
    try {
        await saveApiProvider(updated);
        onEffortSliderInput(idx);
        showSnackbar('Reasoning effort: ' + e.label, 'info');
    } catch (err) {
        provider.effort = previousEffort;
        var restored = _EFFORT_LEVELS.map(function(level) { return level.v; }).indexOf(previousEffort || _providerDefaultEffort(provider));
        onEffortSliderInput(restored < 0 ? 2 : restored);
        showSnackbar('Could not save reasoning effort: ' + (err && err.message), 'error');
    }
}

// Sub-agent tier rows for the model pill menu. Mirrors the settings page's
// Sub-Agent Model Tiers section (renderTierAliasSettings in
// ui/040-tools-settings.js): same alias map (getTierAliasMap / setTierAlias →
// IDB key subagentTierAliases) and same provider option list (apiProviders),
// so both UIs stay consistent.
function _tierMenuRowsHtml() {
    var map = (typeof getTierAliasMap === 'function') ? getTierAliasMap() : {};
    var html = '';
    ['large', 'medium', 'small'].forEach(function(tier) {
        var current = map[tier];
        // "Same" pseudo-option (TIER_ALIAS_SAME, core/030-config.js): the tier
        // follows the spawning agent's current model dynamically — identical
        // behavior to an explicit tier:'same' spawn. Mirrors the Settings page.
        var isSame = (typeof TIER_ALIAS_SAME !== 'undefined' && current === TIER_ALIAS_SAME);
        var options = '<option value="' + TIER_ALIAS_SAME + '"' + (isSame ? ' selected' : '') + '>Same</option>';
        var found = isSame;
        (apiProviders || []).forEach(function(p) {
            if (p.name === current) found = true;
            options += '<option value="' + escapeHtml(p.name) + '"' + (p.name === current ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
        });
        // Mapped provider no longer exists (deleted/renamed) — keep it
        // visible + selected so the user sees the stale mapping.
        if (!found && current) {
            options = '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + ' (missing)</option>' + options;
        }
        html += '<div class="model-menu-tier-row">' +
            '<span class="model-menu-tier-label">' + tier + '</span>' +
            '<select class="model-menu-tier-select" data-tier="' + tier + '" onchange="setTierAliasFromMenu(\'' + tier + '\', this.value)">' + options + '</select>' +
        '</div>';
    });
    return html;
}

// Persist a tier → provider mapping picked from the model pill menu.
// setTierAlias (ui/040-tools-settings.js) writes the same IDB setting the
// settings page uses. Menu stays open so several tiers can be set at once.
function setTierAliasFromMenu(tier, providerName) {
    if (typeof setTierAlias === 'function') setTierAlias(tier, providerName);
    var _tierLabel = (typeof TIER_ALIAS_SAME !== 'undefined' && providerName === TIER_ALIAS_SAME)
        ? 'Same (follows current model)' : providerName;
    showSnackbar('Sub-agent ' + tier + ' tier: ' + _tierLabel, 'info');
}

// Session-scoped collapse state for the pill menu's model sections — kept
// separate from the Settings list's _modelSectionCollapsed
// (ui/040-tools-settings.js) so the two UIs fold independently. Missing key =
// collapsed unless the section holds the current model.
var _menuModelSectionCollapsed = {};
function toggleMenuModelSection(hdr) {
    var sec = hdr && hdr.closest ? hdr.closest('.model-section') : null;
    if (!sec) return;
    var collapsed = sec.classList.toggle('collapsed');
    _menuModelSectionCollapsed[sec.getAttribute('data-section-key')] = collapsed;
    hdr.setAttribute('aria-expanded', String(!collapsed));
}

// Pill click now opens a dropdown (reasoning effort + model picker + sub-agent
// tier mapping + optional OAuth login/logout row). It NO LONGER logs in/out on
// a single click.
function toggleModelMenu(event) {
    if (event && event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    if (event && event.target && event.target.closest && event.target.closest('.model-login-btn')) return;
    if (event) { event.stopPropagation(); event.preventDefault(); }
    var existing = document.getElementById('model-menu');
    if (existing) { existing.remove(); document.removeEventListener('click', _closeModelMenuOnOutside); return; }
    // Only one header dropdown open at a time
    if (typeof closeAllHeaderMenus === 'function') closeAllHeaderMenus('model');

    var anchor = (event && event.currentTarget) || document.getElementById('model-name') || document.getElementById('home-model-name');
    var provider = getProviderById(currentProvider);
    var menu = document.createElement('div');
    menu.id = 'model-menu';
    menu.className = 'header-menu model-menu';

    var html = '<div class="model-menu-section-title menu-section-title"><span class="section-icon">' + UI_ICONS.sparkle + '</span>Reasoning effort</div>';
    var defEffort = _providerDefaultEffort(provider);
    var curEffort = (provider && provider.effort) || defEffort;
    var effortIdx = _EFFORT_LEVELS.map(function(e) { return e.v; }).indexOf(curEffort);
    if (effortIdx < 0) effortIdx = 2; // unknown stored value — show High
    var effortDots = '';
    for (var di = 0; di < 5; di++) {
        effortDots += '<span class="effort-dot' + (di <= effortIdx ? ' active' : '') + (di === effortIdx ? ' current' : '') + '" data-level="' + (di + 1) + '"></span>';
    }
    html += '<div class="model-menu-effort">' +
        '<div class="model-menu-effort-track" style="--pos: ' + (effortIdx / 4) + '">' + effortDots +
            '<span class="effort-track-fill"></span>' +
            '<input type="range" class="model-menu-effort-slider" id="model-menu-effort-slider" min="0" max="4" step="1" value="' + effortIdx + '" aria-label="Reasoning effort" oninput="onEffortSliderInput(this.value)" onchange="commitEffortSlider(this.value)">' +
            '<span class="effort-disc" id="model-menu-effort-disc"></span>' +
        '</div>' +
        '<div class="model-menu-effort-label" id="model-menu-effort-label">' + _effortSliderLabelHtml(effortIdx) + '</div>' +
    '</div>';
    html += '<div class="model-menu-section-title menu-section-title"><span class="section-icon">' + UI_ICONS.model + '</span><span>Model</span>' +
        '<button class="menu-title-btn" title="Add model" aria-label="Add model" onclick="addModelFromMenu(event)">' + UI_ICONS.plus + '</button></div>';
    // Folded per-source sections — same grouping as the Settings model list
    // (groupProvidersIntoSections, ui/040-tools-settings.js). Sections start
    // collapsed except the one holding the current model; manual toggles are
    // remembered for the session in _menuModelSectionCollapsed.
    groupProvidersIntoSections(getAllProviders()).forEach(function(sec) {
        var key = sec.meta.key;
        var hasCurrent = sec.rows.some(function(p) { return p.name === currentProvider; });
        var collapsed = Object.prototype.hasOwnProperty.call(_menuModelSectionCollapsed, key)
            ? !!_menuModelSectionCollapsed[key] : !hasCurrent;
        html += '<div class="model-section' + (collapsed ? ' collapsed' : '') + '" data-section-key="' + escapeHtml(key) + '">' +
            '<div class="model-section-header" role="button" tabindex="0" aria-expanded="' + !collapsed + '"' +
                ' onclick="toggleMenuModelSection(this)"' +
                ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();toggleMenuModelSection(this);}">' +
                '<span class="model-section-chevron">' + UI_ICONS.chevronDown + '</span>' +
                '<span class="model-section-icon">' + sec.meta.icon + '</span>' +
                '<span class="model-section-title">' + escapeHtml(sec.meta.label) + '</span>' +
                '<span class="model-section-count">' + sec.rows.length + '</span>' +
            '</div>' +
            '<div class="model-section-body">' + sec.rows.map(function(p) { return _modelMenuRowHtml(p); }).join('') + '</div>' +
        '</div>';
    });
    html += '<div class="model-menu-section-title menu-section-title"><span class="section-icon">' + UI_ICONS.bot + '</span>Sub-Agent Tiers</div>';
    html += _tierMenuRowsHtml();
    if (provider && provider.isClaudeOAuth) {
        html += '<div class="model-menu-section-title menu-section-title"><span class="section-icon">' + UI_ICONS.lock + '</span>Claude Subscription</div>';
        var oauthLabel = llmConnectionStatus === 'connected' ? 'Log out' : 'Log in';
        html += '<div class="custom-dropdown-option" onclick="modelMenuOAuthToggle()">' + oauthLabel + '</div>';
    } else if (provider && provider.isChatGPTOAuth) {
        html += '<div class="model-menu-section-title menu-section-title"><span class="section-icon">' + UI_ICONS.lock + '</span>ChatGPT Subscription</div>';
        var gptOauthLabel = llmConnectionStatus === 'connected' ? 'Log out' : 'Log in';
        html += '<div class="custom-dropdown-option" onclick="modelMenuChatGPTOAuthToggle()">' + gptOauthLabel + '</div>';
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);

    // Tier aliases hydrate lazily from IDB (subAgentTierAliases === null until
    // loadTierAliases runs). First open: kick hydration, then refresh the tier
    // selects in place if the menu is still up.
    if (typeof subAgentTierAliases !== 'undefined' && subAgentTierAliases === null && typeof loadTierAliases === 'function') {
        loadTierAliases().then(function(map) {
            var m = document.getElementById('model-menu');
            if (!m || !map) return;
            m.querySelectorAll('.model-menu-tier-select').forEach(function(sel) {
                var t = sel.getAttribute('data-tier');
                var v = map[t];
                if (!v) return;
                sel.value = v;
                if (sel.value !== v) {
                    // Stored alias not in the provider list — surface it as missing.
                    var opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = v + ' (missing)';
                    sel.insertBefore(opt, sel.firstChild);
                    sel.value = v;
                }
            });
        });
    }

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

function selectModelFromMenu(name) {
    changeProvider(name);
    _closeModelMenu();
}

// Pencil on a model row — reuse the settings page's edit flow
// (editApiProvider → showAddApiProviderModal, ui/040-tools-settings.js).
// The modal overlays document.body, so it works from any view.
function editModelFromMenu(name) {
    _closeModelMenu();
    if (typeof editApiProvider === 'function') editApiProvider(name);
}

// Plus next to the Model section title — reuse the settings page's add flow.
function addModelFromMenu(event) {
    if (event) event.stopPropagation();
    _closeModelMenu();
    if (typeof showAddApiProviderModal === 'function') showAddApiProviderModal();
}

function modelMenuOAuthToggle() {
    _closeModelMenu();
    if (llmConnectionStatus === 'connected') {
        chrome.runtime.sendMessage({ type: 'claude-oauth-logout' }, function() {
            updateClaudeOAuthStatus();
            showSnackbar('Logged out from Claude', 'info');
        });
    } else {
        startClaudeOAuthLogin();
    }
}

// Login-only Claude OAuth flow — used by the model menu's "Log in" row, the
// pill's Connect button (modelPillLoginClick) and the not-logged-in error
// toast's Log in action (snackbarLoginClick, ui/220-notification-system.js).
// The pill dot refreshes via updateClaudeOAuthStatus in the callback.
function startClaudeOAuthLogin() {
    showSnackbar('Logging in to Claude...', 'info');
    chrome.runtime.sendMessage({ type: 'claude-oauth-login' }, function(response) {
        if (chrome.runtime.lastError) { showSnackbar('Sign-in error: ' + chrome.runtime.lastError.message, 'error'); }
        else if (response && response.error) { showSnackbar('Sign-in error: ' + response.error, 'error'); }
        else { showSnackbar('Logged in to Claude Subscription', 'success'); }
        updateClaudeOAuthStatus();
    });
}

// Compact Connect button inside the model pill (#model-login-btn /
// #home-model-login-btn, src/html/body.html) — dispatch to the login flow of
// whichever OAuth provider is currently selected.
function modelPillLoginClick() {
    var provider = getProviderById(currentProvider);
    if (provider && provider.isClaudeOAuth) startClaudeOAuthLogin();
    else if (provider && provider.isChatGPTOAuth) startChatGPTOAuthLogin();
}

// Device-code login: the response comes back PENDING with the one-time code the
// user has to type on https://auth.openai.com/codex/device (opened OR focused by
// the background handler on every attempt, reused code included). Completion
// arrives later via 'openai-oauth-updated'.
function modelMenuChatGPTOAuthToggle() {
    var returnFocus = document.activeElement;
    _closeModelMenu();
    if (llmConnectionStatus === 'connected') {
        chrome.runtime.sendMessage({ type: 'openai-oauth-logout' }, function() {
            closeChatGPTDeviceCodeModal();
            updateChatGPTOAuthStatus();
            showSnackbar('Logged out from ChatGPT', 'info');
        });
    } else {
        startChatGPTOAuthLogin(returnFocus);
    }
}

// Login-only ChatGPT OAuth flow — used by the model menu's "Log in" row, the
// pill's Connect button (modelPillLoginClick) and the not-logged-in error
// toast's Log in action (snackbarLoginClick, ui/220-notification-system.js).
// The pill dot refreshes via updateChatGPTOAuthStatus / the
// 'openai-oauth-updated' broadcast once the device code is approved.
function startChatGPTOAuthLogin(returnFocusEl) {
    _chatGPTDeviceReturnFocus = returnFocusEl || document.activeElement;
    // Only flip the visible pill status when the ChatGPT provider is the one
    // selected — the button can also be clicked from an error toast.
    var p = getProviderById(currentProvider);
    if (p && p.isChatGPTOAuth) setLLMConnectionStatus('pending');
    chrome.runtime.sendMessage({ type: 'openai-oauth-login' }, function(response) {
        if (chrome.runtime.lastError) { closeChatGPTDeviceCodeModal(); showSnackbar('Sign-in error: ' + chrome.runtime.lastError.message, 'error'); }
        else if (response && response.error) { closeChatGPTDeviceCodeModal(); showSnackbar('Sign-in error: ' + response.error, 'error'); }
        else if (response && response.userCode) { showChatGPTDeviceCodeModal(response); }
        else { showSnackbar('Starting ChatGPT device login\u2026', 'info'); }
        updateChatGPTOAuthStatus();
    });
}

var _chatGPTDeviceExpiryTimer = null;
var _chatGPTDeviceReturnFocus = null;
var _chatGPTDeviceKeyHandler = null;
function closeChatGPTDeviceCodeModal(options) {
    options = options || {};
    if (_chatGPTDeviceExpiryTimer) { clearInterval(_chatGPTDeviceExpiryTimer); _chatGPTDeviceExpiryTimer = null; }
    if (_chatGPTDeviceKeyHandler) { document.removeEventListener('keydown', _chatGPTDeviceKeyHandler); _chatGPTDeviceKeyHandler = null; }
    var modal = document.getElementById('chatgpt-device-modal');
    if (modal) modal.remove();
    if (options.restoreFocus !== false && _chatGPTDeviceReturnFocus && document.contains(_chatGPTDeviceReturnFocus)) {
        try { _chatGPTDeviceReturnFocus.focus(); } catch (e) {}
    }
    _chatGPTDeviceReturnFocus = null;
}

function copyChatGPTDeviceCode() {
    var codeEl = document.getElementById('chatgpt-device-code');
    var feedback = document.getElementById('chatgpt-device-copy-feedback');
    var code = codeEl ? codeEl.textContent : '';
    function done(ok) {
        if (!feedback) return;
        feedback.textContent = ok ? 'Copied' : 'Copy failed — select the code manually';
        feedback.classList.toggle('error', !ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function() { done(true); }, function() { done(false); });
    } else {
        try {
            var range = document.createRange();
            range.selectNodeContents(codeEl);
            var selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            done(document.execCommand('copy'));
        } catch (e) { done(false); }
    }
}

function openChatGPTDevicePage() {
    chrome.runtime.sendMessage({ type: 'openai-oauth-open-verify' }, function(res) {
        if (chrome.runtime.lastError || !res || !res.tabOpened) showSnackbar('Could not open the approval page — use the link shown in the dialog', 'error');
    });
}

// Persistent, accessible device-code dialog. The code is intentionally large,
// copyable, and remains visible while browser approval continues in background.
function showChatGPTDeviceCodeModal(info) {
    var existing = document.getElementById('chatgpt-device-modal');
    if (existing) return; // one pending authorization owns one dialog
    var returnFocus = _chatGPTDeviceReturnFocus || document.activeElement;
    closeChatGPTDeviceCodeModal({ restoreFocus: false });
    _chatGPTDeviceReturnFocus = returnFocus;
    var url = (info && info.verificationUrl) || 'https://auth.openai.com/codex/device';
    var code = (info && info.userCode) || '';
    var expiresAt = Number(info && info.expiresAt) || (Date.now() + 15 * 60 * 1000);
    var opened = !info || info.tabOpened !== false;
    var overlay = document.createElement('div');
    overlay.id = 'chatgpt-device-modal';
    overlay.className = 'modal-overlay show chatgpt-device-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'chatgpt-device-title');
    overlay.setAttribute('aria-describedby', 'chatgpt-device-description chatgpt-device-expiry');
    overlay.innerHTML = '<div class="modal-dialog">' +
        '<div class="modal-header" id="chatgpt-device-title">Finish the ChatGPT login</div>' +
        '<div class="modal-body">' +
            '<p class="chatgpt-device-intro" id="chatgpt-device-description">' + (opened ? 'The OpenAI approval page is open in another tab.' : 'Open the OpenAI approval page to continue.') + '</p>' +
            '<div class="chatgpt-device-url" aria-label="Approval page address">' + escapeHtml(url) + '</div>' +
            '<div class="chatgpt-device-code-row"><code id="chatgpt-device-code" class="chatgpt-device-code" aria-label="One-time device code">' + escapeHtml(code) + '</code><button type="button" class="modal-btn secondary chatgpt-device-copy" onclick="copyChatGPTDeviceCode()" aria-describedby="chatgpt-device-code">Copy code</button></div>' +
            '<div id="chatgpt-device-copy-feedback" class="chatgpt-device-feedback" role="status" aria-live="polite"></div>' +
            '<p id="chatgpt-device-expiry" class="chatgpt-device-expiry" role="status" aria-live="polite"></p>' +
            '<p>Waiting for approval. You may close this dialog; login continues in the background.</p>' +
        '</div>' +
        '<div class="modal-actions"><button type="button" class="modal-btn secondary chatgpt-device-open" onclick="openChatGPTDevicePage()">Open approval page</button><button type="button" class="modal-btn primary" onclick="closeChatGPTDeviceCodeModal()">Close</button></div>' +
    '</div>';
    document.body.appendChild(overlay);
    function updateExpiry() {
        var el = document.getElementById('chatgpt-device-expiry');
        if (!el) return;
        var seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        if (!seconds) {
            el.textContent = 'This code has expired. Close this dialog and choose Retry.';
            el.classList.add('expired');
            overlay.querySelectorAll('.chatgpt-device-copy, .chatgpt-device-open').forEach(function(button) { button.disabled = true; });
            var codeNode = document.getElementById('chatgpt-device-code');
            if (codeNode) codeNode.setAttribute('aria-label', 'Expired one-time device code');
            clearInterval(_chatGPTDeviceExpiryTimer);
            _chatGPTDeviceExpiryTimer = null;
        } else {
            el.textContent = 'Code expires in ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + '.';
        }
    }
    updateExpiry();
    _chatGPTDeviceExpiryTimer = setInterval(updateExpiry, 1000);
    overlay.addEventListener('click', function(event) { if (event.target === overlay) closeChatGPTDeviceCodeModal(); });
    _chatGPTDeviceKeyHandler = function(event) {
        if (!document.getElementById('chatgpt-device-modal')) return;
        if (event.key === 'Escape') { event.preventDefault(); closeChatGPTDeviceCodeModal(); return; }
        if (event.key !== 'Tab') return;
        var focusable = Array.prototype.slice.call(overlay.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
        if (!focusable.length) { event.preventDefault(); return; }
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', _chatGPTDeviceKeyHandler);
    var copyButton = overlay.querySelector('.chatgpt-device-copy');
    if (copyButton) copyButton.focus();
}

function setLLMConnectionStatus(status) {
    llmConnectionStatus = status;
    updateModelConnectionDot();
}
