// Notification System
var snackbarTimeout = null;
function showSnackbar(message, type, duration) {
    var snackbar = document.getElementById('snackbar');
    if (!snackbar) return;

    // NOTE: the tool-approval card renders into its OWN element
    // (#approval-card, see getApprovalCardEl below) — toasts here can no
    // longer displace a pending approval, so no requeue logic is needed.

    // Handle both string type ('error'/'success'/'warning') and legacy boolean isError
    var isError = type === 'error' || type === true;
    var isWarning = type === 'warning';
    var typeClass = isError ? ' error' : (isWarning ? ' warning' : ' success');

    // Build snackbar content with close button for errors and warnings
    var closeBtn = (isError || isWarning) ? '<button class="snackbar-close" onclick="hideSnackbar()">' + UI_ICONS.close + '</button>' : '';
    snackbar.innerHTML = '<span class="snackbar-message">' + escapeHtml(message) + '</span>' + closeBtn;
    snackbar.className = 'snackbar show' + typeClass;

    if (snackbarTimeout) clearTimeout(snackbarTimeout);

    // Don't auto-close errors or warnings - user must dismiss manually
    if (!isError && !isWarning) {
        snackbarTimeout = setTimeout(function() {
            snackbar.classList.remove('show');
        }, duration || 3000);
    }
}

function hideSnackbar() {
    var snackbar = document.getElementById('snackbar');
    if (snackbar) snackbar.classList.remove('show');
    if (snackbarTimeout) clearTimeout(snackbarTimeout);
    // Note: hideSnackbar only affects toasts — the approval card lives in its
    // own #approval-card element and is only hidden by its own dismiss/approve
    // paths (dismissApprovalNotification / approveFromNotification / etc).
}

// Notification queue for tool approvals
var approvalNotificationQueue = [];
var isShowingApprovalNotification = false;
var currentApprovalNotification = null; // Track which notification is currently showing
var _dismissedApprovalKeys = {}; // chatId:approvalIndex -> true when the user X-ed the card (resurface watchdog skips these; cleared on chat navigation)

// Dedicated DOM element for the approval card (#approval-card in
// src/html/body.html). Separate from #snackbar so toasts, hideSnackbar and
// pinned error toasts can NEVER displace a pending approval prompt.
function getApprovalCardEl() {
    return document.getElementById('approval-card');
}

// Get context labels (instance, repo) for tool approval notifications
function getToolContextLabels(args) {
    if (!args) return '';
    var badges = '';
    var activeShort = Platform.instanceUrl ? Platform.instanceUrl.replace(/^https?:\/\//, '').split('.')[0] : '';

    // ServiceNow instance badge (tools with table or instance args)
    if (args.table || args.instance) {
        if (args.instance) {
            var inst = args.instance;
            var short = inst.indexOf('.') !== -1 ? inst.replace(/^https?:\/\//, '').split('.')[0] : inst;
            badges += '<span class="notification-instance-badge' + (short !== activeShort ? ' other-instance' : '') + '">' + escapeHtml(short) + '</span>';
        } else if (activeShort) {
            badges += '<span class="notification-instance-badge">' + escapeHtml(activeShort) + '</span>';
        }
    }

    // GitHub repo badge (workspace tools)
    if (args.workspace || args.repo) {
        var repoName = args.repo || (args.workspace ? args.workspace.split('::')[0] : '');
        if (repoName) {
            badges += '<span class="notification-context-badge">' + escapeHtml(repoName) + '</span>';
        }
    }

    if (!badges) return '';
    return '<span class="notification-context-labels">' + badges + '</span>';
}

// Show notification for tool approval with action button to go to the chat
function showApprovalNotification(chatTitle, toolName, chatId, statusMessage, approvalIndex, args) {
    // Check if this approval is already in the queue or currently showing
    var alreadyQueued = approvalNotificationQueue.some(function(n) {
        return n.chatId === chatId && n.approvalIndex === approvalIndex;
    });
    var alreadyShowing = Array.isArray(currentApprovalNotification) &&
        currentApprovalNotification.some(function(n) {
            return n.chatId === chatId && n.approvalIndex === approvalIndex;
        });
    if (alreadyQueued || alreadyShowing) {
        return;
    }

    var newNotification = { chatTitle: chatTitle, toolName: toolName, chatId: chatId, statusMessage: statusMessage, approvalIndex: approvalIndex, args: args };

    // Send browser notification when the page is hidden so user knows a tool needs approval
    if (document.hidden) {
        Platform.sendNotification({
            title: 'Tool needs approval',
            message: (statusMessage || toolName) + ' — ' + chatTitle,
            chatId: chatId
        });
        // Flash the tab title until the approval is handled or the tab
        // becomes visible (ui/225-approval-attention.js).
        if (typeof startApprovalTitleFlash === 'function') { try { startApprovalTitleFlash(); } catch (e) {} }
    }

    if (!isShowingApprovalNotification) {
        // No notification showing, start fresh
        approvalNotificationQueue.push(newNotification);
        showNextApprovalNotification();
    } else if (Array.isArray(currentApprovalNotification) && currentApprovalNotification.length > 0 && currentApprovalNotification[0].chatId === chatId) {
        // Current notification is for the SAME chat - add to it and re-render in batch mode
        currentApprovalNotification.push(newNotification);
        rerenderCurrentNotification();
    } else {
        // Different chat - add to queue and update badge
        approvalNotificationQueue.push(newNotification);
        updateNotificationQueueBadge();
    }
}

// Re-render the current notification (used when adding more tools from same chat)
function rerenderCurrentNotification() {
    if (!Array.isArray(currentApprovalNotification) || currentApprovalNotification.length === 0) return;

    var card = getApprovalCardEl();
    if (!card) return;

    var chatNotifications = currentApprovalNotification;
    var chatId = chatNotifications[0].chatId;
    var firstNotification = chatNotifications[0];
    var isCurrentChat = chatId === currentChatId;

    // Count remaining notifications from OTHER chats
    var otherChatsCount = approvalNotificationQueue.length;
    var queueBadge = otherChatsCount > 0 ? '<span class="notification-queue-badge">+' + otherChatsCount + ' from other chats</span>' : '';

    var bodyHtml = '';
    var actionsHtml = '';

    if (chatNotifications.length === 1) {
        // Single notification: show full buttons with expandable params
        var notification = chatNotifications[0];
        var contextLabels = getToolContextLabels(notification.args);
        var statusLine = notification.statusMessage
            ? '<div class="notification-status">' + escapeHtml(notification.statusMessage) + '</div>'
            : '';

        var paramsHtml = '';
        if (notification.args) {
            var argsStr = typeof notification.args === 'string' ? notification.args : JSON.stringify(notification.args, null, 2);
            paramsHtml = '<details class="notification-params">' +
                '<summary class="notification-params-toggle">' + UI_ICONS.code + ' Parameters</summary>' +
                '<div class="notification-params-content"><pre>' + formatJsonPretty(argsStr) + '</pre></div>' +
                '</details>';
        }

        bodyHtml =
            contextLabels + (isCurrentChat ? '<span class="notification-message">The agent wants to run <strong>' + escapeHtml(notification.toolName) + '</strong></span>' : '<span class="notification-message"><strong>' + escapeHtml(notification.chatTitle) + '</strong> wants to run <strong>' + escapeHtml(notification.toolName) + '</strong></span>') +
            statusLine +
            paramsHtml;

        actionsHtml =
            '<button class="tool-approval-btn allow" onclick="approveFromNotification(' + notification.approvalIndex + ', \'' + chatId + '\', \'allow\')">' + UI_ICONS.check + 'Allow</button>' +
            '<button class="tool-approval-btn session" onclick="approveFromNotification(' + notification.approvalIndex + ', \'' + chatId + '\', \'session\')">' + UI_ICONS.clock + 'Until Close</button>' +
            '<button class="tool-approval-btn deny" onclick="approveFromNotification(' + notification.approvalIndex + ', \'' + chatId + '\', \'deny\')">' + UI_ICONS.close + 'Deny</button>' +
            (isCurrentChat ? '' : '<button class="tool-approval-btn" onclick="goToApprovalChat(\'' + chatId + '\')">' + UI_ICONS.chat + 'Go to chat</button>');
    } else {
        // Multiple notifications: show grouped format with expandable params for each
        var toolsHtml = '';
        var approvalIndices = [];
        for (var j = 0; j < chatNotifications.length; j++) {
            var notif = chatNotifications[j];
            approvalIndices.push(notif.approvalIndex);
            var statusLine = notif.statusMessage
                ? '<div class="notification-tool-status">' + escapeHtml(notif.statusMessage) + '</div>'
                : '';

            var paramsHtml = '';
            if (notif.args) {
                var argsStr = typeof notif.args === 'string' ? notif.args : JSON.stringify(notif.args, null, 2);
                paramsHtml = '<details class="notification-params notification-params-compact">' +
                    '<summary class="notification-params-toggle">' + UI_ICONS.code + '</summary>' +
                    '<div class="notification-params-content"><pre>' + formatJsonPretty(argsStr) + '</pre></div>' +
                    '</details>';
            }

            toolsHtml +=
                '<div class="notification-tool-item">' +
                    '<div class="notification-tool-info">' +
                        getToolContextLabels(notif.args) + '<strong>' + escapeHtml(notif.toolName) + '</strong>' +
                        statusLine +
                    '</div>' +
                    '<div class="notification-tool-actions">' +
                        paramsHtml +
                        '<button class="tool-approval-btn allow" onclick="approveFromNotification(' + notif.approvalIndex + ', \'' + chatId + '\', \'allow\')">' + UI_ICONS.check + '</button>' +
                        '<button class="tool-approval-btn session" onclick="approveFromNotification(' + notif.approvalIndex + ', \'' + chatId + '\', \'session\')">' + UI_ICONS.clock + '</button>' +
                        '<button class="tool-approval-btn deny" onclick="approveFromNotification(' + notif.approvalIndex + ', \'' + chatId + '\', \'deny\')">' + UI_ICONS.close + '</button>' +
                    '</div>' +
                '</div>';
        }

        var indicesJson = JSON.stringify(approvalIndices).replace(/"/g, '&quot;');
        var bulkActionsHtml =
            '<div class="notification-bulk-actions">' +
                '<button class="tool-approval-btn allow" onclick="approveAllFromNotification(' + indicesJson + ', \'' + chatId + '\', \'allow\')">' + UI_ICONS.check + 'Allow All (' + chatNotifications.length + ')</button>' +
                '<button class="tool-approval-btn session" onclick="approveAllFromNotification(' + indicesJson + ', \'' + chatId + '\', \'session\')">' + UI_ICONS.clock + 'All Until Close</button>' +
                '<button class="tool-approval-btn deny" onclick="approveAllFromNotification(' + indicesJson + ', \'' + chatId + '\', \'deny\')">' + UI_ICONS.close + 'Deny All</button>' +
            '</div>';

        bodyHtml =
            (isCurrentChat ? '<span class="notification-message">The agent wants to run:</span>' : '<span class="notification-message"><strong>' + escapeHtml(firstNotification.chatTitle) + '</strong> wants to run:</span>') +
            '<div class="notification-tools-list">' + toolsHtml + '</div>' +
            bulkActionsHtml;

        actionsHtml =
            (isCurrentChat ? '' : '<button class="tool-approval-btn" onclick="goToApprovalChat(\'' + chatId + '\')">' + UI_ICONS.chat + 'Go to chat</button>');
    }

    var expandBtn = '<button class="notification-expand" onclick="toggleNotificationExpand()" title="Expand">' + UI_ICONS.expand + '</button>';
    card.innerHTML =
        '<div class="notification-header">' +
            '<span class="notification-icon">' + UI_ICONS.bell + '</span>' +
            '<span class="notification-title">Permission Required</span>' +
            queueBadge +
            expandBtn +
            '<button class="notification-close" onclick="dismissApprovalNotification()">' + UI_ICONS.close + '</button>' +
        '</div>' +
        '<div class="notification-body">' + bodyHtml + '</div>' +
        (actionsHtml ? '<div class="notification-actions">' + actionsHtml + '</div>' : '');
    // Match the show path (showNextApprovalNotification) — also drops any
    // notification-expanded state from a previous card.
    card.className = 'approval-card notification-card show';
}

function toggleNotificationExpand() {
    var card = getApprovalCardEl();
    if (!card) return;
    card.classList.toggle('notification-expanded');
    var btn = card.querySelector('.notification-expand');
    if (btn) btn.title = card.classList.contains('notification-expanded') ? 'Collapse' : 'Expand';
    // Auto-open params when expanding
    if (card.classList.contains('notification-expanded')) {
        card.querySelectorAll('.notification-params:not([open])').forEach(function(d) { d.open = true; });
    }
}

function updateNotificationQueueBadge() {
    var badge = document.querySelector('.notification-queue-badge');
    var queueCount = approvalNotificationQueue.length;
    if (queueCount > 0) {
        if (badge) {
            badge.textContent = '+' + queueCount + ' more';
        } else {
            // Add badge if it doesn't exist
            var title = document.querySelector('.notification-title');
            if (title) {
                var newBadge = document.createElement('span');
                newBadge.className = 'notification-queue-badge';
                newBadge.textContent = '+' + queueCount + ' more';
                title.insertAdjacentElement('afterend', newBadge);
            }
        }
    }
}

function showNextApprovalNotification() {
    // Don't advance the queue while a card is actively displayed — callers
    // that legitimately advance (dismiss/approve) clear
    // currentApprovalNotification first. Prevents a delayed chained call
    // (dismiss timeout vs watchdog) from double-advancing and orphaning the
    // currently shown group.
    var visibleEl = getApprovalCardEl();
    if (isShowingApprovalNotification &&
        Array.isArray(currentApprovalNotification) && currentApprovalNotification.length > 0 &&
        visibleEl && visibleEl.classList.contains('show')) {
        return;
    }
    if (approvalNotificationQueue.length === 0) {
        isShowingApprovalNotification = false;
        currentApprovalNotification = null;
        return;
    }

    isShowingApprovalNotification = true;
    // Get first notification and find all others from the same chat
    var firstNotification = approvalNotificationQueue.shift();
    var chatId = firstNotification.chatId;
    var chatNotifications = [firstNotification];

    // Collect all notifications from the same chat
    var remainingQueue = [];
    for (var i = 0; i < approvalNotificationQueue.length; i++) {
        if (approvalNotificationQueue[i].chatId === chatId) {
            chatNotifications.push(approvalNotificationQueue[i]);
        } else {
            remainingQueue.push(approvalNotificationQueue[i]);
        }
    }
    approvalNotificationQueue = remainingQueue;

    currentApprovalNotification = chatNotifications; // Store array of notifications
    var isCurrentChat = chatId === currentChatId;
    var card = getApprovalCardEl();
    if (!card) return;

    // Count remaining notifications from OTHER chats
    var otherChatsCount = approvalNotificationQueue.length;
    var queueBadge = otherChatsCount > 0 ? '<span class="notification-queue-badge">+' + otherChatsCount + ' from other chats</span>' : '';

    var bodyHtml = '';
    var actionsHtml = '';

    if (chatNotifications.length === 1) {
        // Single notification: show full buttons with expandable params
        var notification = chatNotifications[0];
        var contextLabels = getToolContextLabels(notification.args);
        var statusLine = notification.statusMessage
            ? '<div class="notification-status">' + escapeHtml(notification.statusMessage) + '</div>'
            : '';

        var paramsHtml = '';
        if (notification.args) {
            var argsStr = typeof notification.args === 'string' ? notification.args : JSON.stringify(notification.args, null, 2);
            paramsHtml = '<details class="notification-params">' +
                '<summary class="notification-params-toggle">' + UI_ICONS.code + ' Parameters</summary>' +
                '<div class="notification-params-content"><pre>' + formatJsonPretty(argsStr) + '</pre></div>' +
                '</details>';
        }

        bodyHtml =
            contextLabels + (isCurrentChat ? '<span class="notification-message">The agent wants to run <strong>' + escapeHtml(notification.toolName) + '</strong></span>' : '<span class="notification-message"><strong>' + escapeHtml(notification.chatTitle) + '</strong> wants to run <strong>' + escapeHtml(notification.toolName) + '</strong></span>') +
            statusLine +
            paramsHtml;

        actionsHtml =
            '<button class="tool-approval-btn allow" onclick="approveFromNotification(' + notification.approvalIndex + ', \'' + chatId + '\', \'allow\')">' + UI_ICONS.check + 'Allow</button>' +
            '<button class="tool-approval-btn session" onclick="approveFromNotification(' + notification.approvalIndex + ', \'' + chatId + '\', \'session\')">' + UI_ICONS.clock + 'Until Close</button>' +
            '<button class="tool-approval-btn deny" onclick="approveFromNotification(' + notification.approvalIndex + ', \'' + chatId + '\', \'deny\')">' + UI_ICONS.close + 'Deny</button>' +
            (isCurrentChat ? '' : '<button class="tool-approval-btn" onclick="goToApprovalChat(\'' + chatId + '\')">' + UI_ICONS.chat + 'Go to chat</button>');
    } else {
        // Multiple notifications: show grouped format with expandable params for each
        var toolsHtml = '';
        var approvalIndices = [];
        for (var j = 0; j < chatNotifications.length; j++) {
            var notif = chatNotifications[j];
            approvalIndices.push(notif.approvalIndex);
            var statusLine = notif.statusMessage
                ? '<div class="notification-tool-status">' + escapeHtml(notif.statusMessage) + '</div>'
                : '';

            var paramsHtml = '';
            if (notif.args) {
                var argsStr = typeof notif.args === 'string' ? notif.args : JSON.stringify(notif.args, null, 2);
                paramsHtml = '<details class="notification-params notification-params-compact">' +
                    '<summary class="notification-params-toggle">' + UI_ICONS.code + '</summary>' +
                    '<div class="notification-params-content"><pre>' + formatJsonPretty(argsStr) + '</pre></div>' +
                    '</details>';
            }

            toolsHtml +=
                '<div class="notification-tool-item">' +
                    '<div class="notification-tool-info">' +
                        getToolContextLabels(notif.args) + '<strong>' + escapeHtml(notif.toolName) + '</strong>' +
                        statusLine +
                    '</div>' +
                    '<div class="notification-tool-actions">' +
                        paramsHtml +
                        '<button class="tool-approval-btn allow" onclick="approveFromNotification(' + notif.approvalIndex + ', \'' + chatId + '\', \'allow\')">' + UI_ICONS.check + '</button>' +
                        '<button class="tool-approval-btn session" onclick="approveFromNotification(' + notif.approvalIndex + ', \'' + chatId + '\', \'session\')">' + UI_ICONS.clock + '</button>' +
                        '<button class="tool-approval-btn deny" onclick="approveFromNotification(' + notif.approvalIndex + ', \'' + chatId + '\', \'deny\')">' + UI_ICONS.close + '</button>' +
                    '</div>' +
                '</div>';
        }

        var indicesJson = JSON.stringify(approvalIndices).replace(/"/g, '&quot;');
        var bulkActionsHtml =
            '<div class="notification-bulk-actions">' +
                '<button class="tool-approval-btn allow" onclick="approveAllFromNotification(' + indicesJson + ', \'' + chatId + '\', \'allow\')">' + UI_ICONS.check + 'Allow All (' + chatNotifications.length + ')</button>' +
                '<button class="tool-approval-btn session" onclick="approveAllFromNotification(' + indicesJson + ', \'' + chatId + '\', \'session\')">' + UI_ICONS.clock + 'All Until Close</button>' +
                '<button class="tool-approval-btn deny" onclick="approveAllFromNotification(' + indicesJson + ', \'' + chatId + '\', \'deny\')">' + UI_ICONS.close + 'Deny All</button>' +
            '</div>';

        bodyHtml =
            (isCurrentChat ? '<span class="notification-message">The agent wants to run:</span>' : '<span class="notification-message"><strong>' + escapeHtml(firstNotification.chatTitle) + '</strong> wants to run:</span>') +
            '<div class="notification-tools-list">' + toolsHtml + '</div>' +
            bulkActionsHtml;

        actionsHtml =
            (isCurrentChat ? '' : '<button class="tool-approval-btn" onclick="goToApprovalChat(\'' + chatId + '\')">' + UI_ICONS.chat + 'Go to chat</button>');
    }

    var expandBtn = '<button class="notification-expand" onclick="toggleNotificationExpand()" title="Expand">' + UI_ICONS.expand + '</button>';
    card.innerHTML =
        '<div class="notification-header">' +
            '<span class="notification-icon">' + UI_ICONS.bell + '</span>' +
            '<span class="notification-title">Permission Required</span>' +
            queueBadge +
            expandBtn +
            '<button class="notification-close" onclick="dismissApprovalNotification()">' + UI_ICONS.close + '</button>' +
        '</div>' +
        '<div class="notification-body">' + bodyHtml + '</div>' +
        (actionsHtml ? '<div class="notification-actions">' + actionsHtml + '</div>' : '');
    card.className = 'approval-card notification-card show';
}

function dismissApprovalNotification() {
    // Record the dismissal so the resurface watchdog
    // (ui/225-approval-attention.js) doesn't instantly re-show what the user
    // just closed. Explicit chat navigation clears these keys.
    if (Array.isArray(currentApprovalNotification)) {
        for (var di = 0; di < currentApprovalNotification.length; di++) {
            var dn = currentApprovalNotification[di];
            _dismissedApprovalKeys[dn.chatId + ':' + dn.approvalIndex] = true;
        }
    }
    var cardEl = getApprovalCardEl();
    if (cardEl) cardEl.classList.remove('show');
    currentApprovalNotification = null;
    // Show next notification after a brief delay
    setTimeout(showNextApprovalNotification, 300);
}

// Called when an approval is handled (from chat or elsewhere) to clear related notifications
function clearApprovalNotificationsForChat(chatId) {
    // Remove any queued notifications for this chat
    approvalNotificationQueue = approvalNotificationQueue.filter(function(n) {
        return n.chatId !== chatId;
    });
    // If current notification is for this chat, dismiss and show next
    // currentApprovalNotification is now an array of notifications for the same chat
    if (Array.isArray(currentApprovalNotification) && currentApprovalNotification.length > 0 && currentApprovalNotification[0].chatId === chatId) {
        dismissApprovalNotification();
    } else {
        // Update badge count
        updateNotificationQueueBadge();
    }
}

function goToApprovalChat(chatId) {
    // Don't destroy the prompt: approval rows have NO inline rendering
    // (250-message-render.js renders them display:none), so the old
    // clear-queue + skipApprovalNotifications left a pending approval with
    // zero UI. selectChat → showPendingApprovalNotifications re-shows the
    // card in the target chat (it dedups/clears this chat's entries itself).
    selectChat(chatId);
}

// Handle approval directly from notification without navigating to chat
async function approveFromNotification(approvalIndex, chatId, action) {
    // Call the existing approval handler (skip notification clear - we handle it here)
    // handleApproval will skip runAgent when called from notification
    await handleApproval(approvalIndex, action, true, chatId);

    // Check if this was a programmatic tool call (widget/js_eval bridge)
    // Programmatic calls handle their own flow via promise resolution - don't trigger runAgent
    var chat = chats[chatId];
    var approvalMsg = chat && chat.messages[approvalIndex];
    var isProgrammatic = approvalMsg && approvalMsg.toolCallId && approvalMsg.toolCallId.startsWith('prog_');

    // Remove this notification from currentApprovalNotification array
    if (Array.isArray(currentApprovalNotification)) {
        currentApprovalNotification = currentApprovalNotification.filter(function(n) {
            return n.approvalIndex !== approvalIndex;
        });

        // If there are still notifications for this chat, just re-render
        if (currentApprovalNotification.length > 0) {
            rerenderCurrentNotification();
            // Run agent if approved and on same chat (skip for programmatic calls)
            if (action !== 'deny' && currentChatId === chatId && !isProgrammatic) {
                setTimeout(function() { runAgent(); }, 100);
            }
            return;
        }
    }

    // All notifications for this chat handled, show next from queue
    var cardEl = getApprovalCardEl();
    if (cardEl) cardEl.classList.remove('show');
    currentApprovalNotification = null;
    setTimeout(showNextApprovalNotification, 300);

    // Run agent to execute approved tool (only if on same chat, skip for programmatic calls)
    if (action !== 'deny' && currentChatId === chatId && !isProgrammatic) {
        setTimeout(function() { runAgent(); }, 100);
    }
}

async function approveAllFromNotification(approvalIndices, chatId, action) {
    // Parse JSON string if passed from onclick attribute
    if (typeof approvalIndices === 'string') {
        try { approvalIndices = JSON.parse(approvalIndices); } catch(e) { approvalIndices = []; }
    }
    if (!Array.isArray(approvalIndices)) approvalIndices = [];
    // Handle all approvals (skip notification clear - we handle it here)
    for (var i = 0; i < approvalIndices.length; i++) {
        await handleApproval(approvalIndices[i], action, true, chatId);
    }

    // Check if any of these were programmatic tool calls
    var chat = chats[chatId];
    var hasProgrammatic = approvalIndices.some(function(idx) {
        var msg = chat && chat.messages[idx];
        return msg && msg.toolCallId && msg.toolCallId.startsWith('prog_');
    });

    // Clear and show next
    var cardEl = getApprovalCardEl();
    if (cardEl) cardEl.classList.remove('show');
    currentApprovalNotification = null;
    setTimeout(showNextApprovalNotification, 300);

    // Run agent to execute approved tools (only if on same chat, skip for programmatic calls)
    if (action !== 'deny' && currentChatId === chatId && !hasProgrammatic) {
        setTimeout(function() { runAgent(); }, 100);
    }
}

// Prevent approval buttons from stealing focus from iframe page elements
// mousedown preventDefault stops the browser from moving focus to the clicked button,
// while still allowing the click event to fire normally
document.addEventListener('mousedown', function(e) {
    if (e.target.closest('.tool-approval-btn')) {
        e.preventDefault();
    }
}, true);

var modalResolve = null;
// Map a variant/color name to the canonical modal variant.
// 'danger' | 'alert' | 'red' -> danger (red), 'warning' | 'orange' -> warning (orange),
// anything else -> normal (default blue).
function normalizeModalVariant(variant) {
    if (variant === 'danger' || variant === 'alert' || variant === 'red' || variant === 'error') return 'danger';
    if (variant === 'warning' || variant === 'orange') return 'warning';
    return 'normal';
}
function showModal(title, message, buttons, variant) {
    return new Promise(function(resolve) {
        modalResolve = resolve;
        var overlay = document.getElementById('modal-overlay');
        var header = document.getElementById('modal-header');
        var body = document.getElementById('modal-body');
        var actions = document.getElementById('modal-actions');
        overlay.classList.remove('modal-variant-warning', 'modal-variant-danger');
        var v = normalizeModalVariant(variant);
        if (v !== 'normal') overlay.classList.add('modal-variant-' + v);
        header.textContent = title;
        body.innerHTML = message;
        actions.innerHTML = buttons.map(function(btn) {
            return '<button class="modal-btn ' + (btn.class || 'secondary') + '" onclick="resolveModal(\'' + escapeJsString(btn.value) + '\')">' + escapeHtml(btn.label) + '</button>';
        }).join('');
        overlay.classList.add('show');
    });
}

function closeModal() {
    var modal = document.getElementById('modal-overlay');
    modal.classList.remove('show');
    modal.classList.remove('modal-variant-warning');
    modal.classList.remove('modal-variant-danger');
    modal.classList.remove('skill-asset-modal');
    modal.classList.remove('request-body-modal');
    modal.classList.remove('screenshot-modal');
    modal.classList.remove('pdf-modal');
    modal.classList.remove('file-modal');
    modal.classList.remove('worker-chat-modal');
    // Detach the worker chat-view modal's live-refresh listener (guarded:
    // defined in ui/175-sub-agent-ui.js, a no-op when no such modal is open).
    if (typeof _teardownWorkerChatModal === 'function') _teardownWorkerChatModal();
    document.removeEventListener('keydown', screenshotModalKeyHandler);
    screenshotNav.list = [];
    screenshotNav.index = -1;
    if (modalResolve) { modalResolve(null); modalResolve = null; }
}
