// Notification System
//
// TOAST QUEUE — there is exactly ONE #snackbar element and src/css/13-notifications.css
// styles it as a single fixed-position bar (no stacking rules, and
// `#snackbar.show ~ .approval-card.show` assumes one toast), so toasts are shown one
// at a time. Error/warning toasts are deliberately PINNED (no auto-dismiss — the user
// must click the X). Previously ANY later toast overwrote #snackbar.innerHTML and
// silently destroyed a pinned error nobody had read yet (a live "AI endpoint saturated"
// warning was lost exactly this way). Now a toast that arrives while a pinned toast is
// on screen is QUEUED and rendered once the pinned one is dismissed.
var snackbarTimeout = null;
var snackbarQueue = [];        // pending toasts: { message, type, duration, pinned }
var currentSnackbar = null;    // the toast currently on screen (null = none)
var snackbarDrainTimer = null; // set while waiting out the slide-out before the next toast
var SNACKBAR_QUEUE_MAX = 20;
var SNACKBAR_STALE_MS = 15000; // auto-dismissing toasts expire while queued (pinned ones never do)

// Errors and warnings never auto-dismiss (legacy boolean true === error).
function isPinnedSnackbar(type) {
    return type === 'error' || type === true || type === 'warning';
}

// A pinned toast that never makes it onto the screen must still leave a trace:
// silently dropping an unread error is the exact bug class this queue exists to
// fix, so mirror it to the console (which already holds the surrounding stack and
// is where the dropped error's context lives). Auto-dismissing status toasts are
// noise and are dropped quietly.
function _warnDroppedSnackbar(entry, why) {
    if (!entry || !entry.pinned) return;
    try {
        console.warn('[snackbar] ' + (why || 'dropped') + ' \u2014 unseen ' +
            (entry.type === true ? 'error' : entry.type) + ' toast never shown: ' + entry.message);
    } catch (e) {}
}

function showSnackbar(message, type, duration) {
    var snackbar = document.getElementById('snackbar');
    if (!snackbar) return;

    // NOTE: the tool-approval card renders into its OWN element
    // (#approval-card, see getApprovalCardEl below) — toasts here can no
    // longer displace a pending approval, so no requeue logic is needed.

    var entry = { message: message, type: type, duration: duration, pinned: isPinnedSnackbar(type), at: Date.now() };

    // A pinned toast is on screen (or one is about to be rendered from the
    // queue): do NOT clobber it — queue this one instead.
    var pinnedShowing = !!(currentSnackbar && currentSnackbar.pinned && snackbar.classList.contains('show'));
    if (pinnedShowing || snackbarDrainTimer) {
        // Collapse exact duplicates so a repeating error can't flood the queue.
        if (currentSnackbar && currentSnackbar.message === entry.message && currentSnackbar.type === entry.type) return;
        for (var i = 0; i < snackbarQueue.length; i++) {
            if (snackbarQueue[i].message === entry.message && snackbarQueue[i].type === entry.type) return;
        }
        if (snackbarQueue.length >= SNACKBAR_QUEUE_MAX) {
            // Full: sacrifice the oldest auto-dismissing entry, never a pinned one.
            var dropIdx = -1;
            for (var j = 0; j < snackbarQueue.length; j++) { if (!snackbarQueue[j].pinned) { dropIdx = j; break; } }
            if (dropIdx === -1) {
                // 20 unread pinned errors are already queued. Evicting one of THOSE to
                // make room would throw away the OLDEST failure, which in a cascade is
                // the root cause and the most diagnostic — and the screen can show
                // nothing new until the user has clicked X twenty times anyway, so
                // promoting the newcomer buys no visibility. The newcomer still loses
                // the race, but it is no longer lost SILENTLY: it goes to the console.
                _warnDroppedSnackbar(entry, 'queue full (' + SNACKBAR_QUEUE_MAX + ' pinned toasts unread)');
                return;
            }
            snackbarQueue.splice(dropIdx, 1);
        }
        snackbarQueue.push(entry);
        return;
    }

    // Nothing pinned on screen — render now. An auto-dismissing toast is still
    // replaceable, which keeps chatty status toasts snappy (unchanged behaviour).
    renderSnackbar(entry);
}

function renderSnackbar(entry) {
    var snackbar = document.getElementById('snackbar');
    if (!snackbar) return;
    currentSnackbar = entry;

    // Handle both string type ('error'/'success'/'warning') and legacy boolean isError
    var isError = entry.type === 'error' || entry.type === true;
    var isWarning = entry.type === 'warning';
    var typeClass = isError ? ' error' : (isWarning ? ' warning' : ' success');

    // Build snackbar content with close button for errors and warnings
    var closeBtn = (isError || isWarning) ? '<button class="snackbar-close" onclick="dismissSnackbar()">' + UI_ICONS.close + '</button>' : '';
    // OAuth "not logged in" errors carry a Log in action so the user can fix
    // the failure from the toast itself (same flows as the pill's Connect
    // button — startClaudeOAuthLogin / startChatGPTOAuthLogin in
    // ui/160-notifications.js).
    var loginProvider = isError ? _snackbarLoginProvider(entry.message) : null;
    var loginBtn = loginProvider
        ? '<button class="snackbar-action" onclick="snackbarLoginClick(\'' + loginProvider + '\')">Log in</button>'
        : '';
    snackbar.innerHTML = '<span class="snackbar-message">' + escapeHtml(entry.message) + '</span>' + loginBtn + closeBtn;
    snackbar.className = 'snackbar show' + typeClass;

    if (snackbarTimeout) { clearTimeout(snackbarTimeout); snackbarTimeout = null; }

    // Don't auto-close errors or warnings - user must dismiss manually
    if (!entry.pinned) {
        snackbarTimeout = setTimeout(function() {
            snackbarTimeout = null;
            snackbar.classList.remove('show');
            currentSnackbar = null;
            drainSnackbarQueue();
        }, entry.duration || 3000);
    }
}

// Detect the OAuth auth-failure error strings emitted by background.js
// ('Not logged in to Claude. Click the login button.', 'Not logged in to
// ChatGPT. Use "Log in" in the model menu.', and the token-refresh variant
// 'Log in to ChatGPT again from the model menu.') so the error toast can
// offer the fix inline. Returns 'claude' | 'chatgpt' | null.
function _snackbarLoginProvider(message) {
    var m = String(message || '');
    if (/not logged in to claude/i.test(m)) return 'claude';
    if (/not logged in to chatgpt|log in to chatgpt/i.test(m)) return 'chatgpt';
    return null;
}

// Log in action on a not-logged-in error toast — dismiss the toast (the user
// has acted on it) and start the matching OAuth login flow.
function snackbarLoginClick(provider) {
    dismissSnackbar();
    if (provider === 'claude' && typeof startClaudeOAuthLogin === 'function') startClaudeOAuthLogin();
    else if (provider === 'chatgpt' && typeof startChatGPTOAuthLogin === 'function') startChatGPTOAuthLogin();
}

// Render the next queued toast after a short beat so the outgoing toast gets to
// slide out (the .snackbar transition in 13-notifications.css is 0.3s).
function drainSnackbarQueue() {
    if (snackbarDrainTimer || !snackbarQueue.length) return;
    snackbarDrainTimer = setTimeout(function() {
        snackbarDrainTimer = null;
        var next = null;
        while (snackbarQueue.length) {
            var cand = snackbarQueue.shift();
            // Drop stale status toasts — a "Saving…" queued behind a pinned error
            // is noise once the user finally dismisses it. Pinned toasts never expire.
            if (!cand.pinned && (Date.now() - cand.at) > SNACKBAR_STALE_MS) continue;
            next = cand;
            break;
        }
        if (next) renderSnackbar(next);
    }, 320);
}

// CLEAR the toast surface. Every caller means "the toast on screen belongs to a
// context the user just left": newChat (170:670), selectChat (170:772),
// openChatFromHistory (050:380), retryLastCall / retryChat / continueAgent
// (020-api-messages.js:270/329/353) and the transport-countdown expiry
// (036-agent-event-handlers-page.js:477). So this must leave the bar EMPTY — which
// means killing the drain already in flight (it used to survive the hide and repaint
// a toast ~320ms later, on top of the freshly cleared context, and it also made the
// drainSnackbarQueue() call below a silent no-op via its own timer guard) and
// discarding what is queued behind it rather than promoting it into the new context.
// Unread pinned entries are logged, never dropped in silence.
// The X button does NOT come here — see dismissSnackbar().
function hideSnackbar() {
    var snackbar = document.getElementById('snackbar');
    if (snackbar) snackbar.classList.remove('show');
    if (snackbarTimeout) { clearTimeout(snackbarTimeout); snackbarTimeout = null; }
    if (snackbarDrainTimer) { clearTimeout(snackbarDrainTimer); snackbarDrainTimer = null; }
    for (var i = 0; i < snackbarQueue.length; i++) _warnDroppedSnackbar(snackbarQueue[i], 'toast area cleared');
    snackbarQueue = [];
    currentSnackbar = null;
    // Note: hideSnackbar only affects toasts — the approval card lives in its
    // own #approval-card element and is only hidden by its own dismiss/approve
    // paths (dismissApprovalNotification / approveFromNotification / etc).
}

// The X on a pinned error/warning. Unlike hideSnackbar this is the user saying "I
// have read this one", so the toasts queued BEHIND it get their turn: this is the
// only release valve for a queue held up by a pinned toast. A drain already in
// flight is deliberately left alone — drainSnackbarQueue's guard makes the call a
// no-op and the pending timer renders the same next entry (re-entrant safe).
function dismissSnackbar() {
    var snackbar = document.getElementById('snackbar');
    if (snackbar) snackbar.classList.remove('show');
    if (snackbarTimeout) { clearTimeout(snackbarTimeout); snackbarTimeout = null; }
    currentSnackbar = null;
    drainSnackbarQueue();
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
function showApprovalNotification(chatTitle, toolName, chatId, statusMessage, approvalIndex, args, opts) {
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

    // PR776-FIX: stamp the approval row's toolCallId on the notification at
    // queue time. A snapshot merge can SHIFT row indexes after a card is
    // queued, so the approvalSettled purge (app/036-agent-event-handlers-
    // page.js) matches primarily by toolCallId and only falls back to
    // approvalIndex for entries without one. Derived here — the single
    // creation site of queue entries — because not every caller (ui/160,
    // ui/225) has the approval row handy.
    var toolCallId = null;
    try {
        var apChat = (typeof chats === 'object' && chats) ? chats[chatId] : null;
        var apRow = (apChat && Array.isArray(apChat.messages)) ? apChat.messages[approvalIndex] : null;
        if (apRow && apRow.role === 'approval' && apRow.toolCallId) toolCallId = apRow.toolCallId;
    } catch (eTci) { toolCallId = null; }
    var newNotification = { chatTitle: chatTitle, toolName: toolName, chatId: chatId, statusMessage: statusMessage, approvalIndex: approvalIndex, toolCallId: toolCallId, args: args };

    // Send browser notification when the page is hidden so user knows a tool needs approval
    if (document.hidden) {
        // AB (OS-notification dedup): the SW broadcasts approval prompts to
        // EVERY panel — only the PRIMARY copy may fire the OS notification
        // (opts.osNotify === false on fan-out / re-delivery / rebind copies),
        // otherwise N hidden panels fire N duplicates. Callers that pass no
        // opts (chat-open resurface, watchdog, page-local approvals) keep
        // today's behavior. The tab-title flash below stays per-panel: each
        // hidden tab flashing its own title is signal, not noise.
        if (!(opts && opts.osNotify === false)) {
            Platform.sendNotification({
                title: 'Tool needs approval',
                message: (statusMessage || toolName) + ' — ' + chatTitle,
                chatId: chatId
            });
        }
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
    card.className = 'approval-card show';
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
    card.className = 'approval-card show';
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
// ALLOW-list of elements a modal message may keep. Everything else is UNWRAPPED
// (element dropped, its text kept) or, for the opaque set below, dropped whole.
//
// An allow-list, not a deny-list: a deny-list only stops the tags someone thought
// of, and the previous one already missed <img src=https://evil> (MV3's default CSP
// leaves img-src open, so a record-controlled chat name became a remote beacon),
// <a href>, srcset, ping, <audio>/<video> and <input> UI-spoofing.
// Kept deliberately tight: a grep of all 34 showModal/showConfirmModal call sites
// found exactly three that pass markup, and they only use <br> and <strong>
// (ui/170-chat-management.js:1069-1071, ui/040-tools-settings.js:1104-1106,
// ui/270-iframe-panel.js:173/175). The rest are inline text formatters kept as
// headroom so a future caller degrades gracefully rather than losing its text.
var MODAL_ALLOWED_TAGS = { BR:1, STRONG:1, B:1, EM:1, I:1, CODE:1, SPAN:1, P:1, UL:1, OL:1, LI:1 };

// Not-allowed elements whose CHILDREN must go too. Everything else is unwrapped so
// no legitimate text is lost, but these hold raw source (script/CSS) or content that
// is never meant to render, and unwrapping them would paint that source as text.
// .toUpperCase() matters: SVG/MathML-namespaced elements report a lowercase tagName.
var MODAL_OPAQUE_TAGS = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, IFRAME:1, FRAME:1,
    FRAMESET:1, OBJECT:1, EMBED:1, HEAD:1, TITLE:1, XMP:1, PLAINTEXT:1 };

// ALLOW-list of attributes. Intentionally EMPTY: none of the three markup callers
// carries an attribute, and an empty list is what kills the whole attribute class at
// once — on*="…" / data-_ev-*="…" (the CSP polyfill's bound form), href/src/srcset/
// ping, and `style` (CSS exfil via background:url(), plus a position:fixed;inset:0
// overlay that click-jacks the modal's Confirm button). Add a name here ONLY if a
// caller truly needs it; the copy loop below still runs the on*/URL-scheme guards.
var MODAL_ALLOWED_ATTRS = {};
var MODAL_URL_ATTRS = { href:1, src:1, action:1, formaction:1, 'xlink:href':1, background:1, poster:1, srcset:1, ping:1, data:1, codebase:1 };
var MODAL_MAX_DEPTH = 24; // nesting cap — a modal message is one paragraph, not a document

// True when a URL-ish attribute value carries a script-capable scheme.
// The value is tested with ALL whitespace/control characters removed first: the URL
// parser strips ASCII tab/LF/CR from anywhere in a URL (and leading C0/space) before
// it reads the scheme, so href="java&#9;script:alert(1)" — which DOMParser decodes to
// "java\tscript:alert(1)" — is live in the browser even though a ^-anchored regex on
// the raw value does not match it.
function isUnsafeModalUrl(value) {
    var u = String(value == null ? '' : value).replace(/[\u0000-\u0020\u007f]+/g, '');
    return /^(javascript|data|vbscript):/i.test(u);
}

// Defence-in-depth sanitizer for the showModal message sink.
//
// The message is intentionally NOT blanket-escaped: three callers pass small
// TRUSTED markup (ui/170-chat-management.js:1069-1071 uses <br>/<strong>,
// ui/040-tools-settings.js:1104-1106 uses <strong>, ui/270-iframe-panel.js:173/175
// uses <br>), and they already escapeHtml() their untrusted interpolations. Callers
// MUST keep doing that. This pass is the safety net for the ~10 that forget: it
// parses the markup INERT via DOMParser (no script execution, no sub-resource loads)
// and REBUILDS it from an allow-list before the nodes touch the live document.
//
// Rebuild, not strip: every kept element is re-created with document.createElement
// and its children re-parented, so an attribute can only exist if it was explicitly
// copied. Nothing survives by being un-enumerated.
//
// Returning NODES rather than a string matters and MUST stay that way: assigning
// innerHTML would run the MV3 inline-handler polyfill (platform/extension/
// csp-polyfill.js:37/53/71/79, which patches innerHTML/outerHTML/insertAdjacentHTML/
// setAttribute), and it rewrites on*="…" into data-_ev-*="…" then re-binds it with
// addEventListener — the exact reason <img src=x onerror=…> executed here despite
// MV3's script-src 'self'. There is no innerHTML/outerHTML/insertAdjacentHTML in
// this function, and the only setAttribute call is gated on MODAL_ALLOWED_ATTRS
// (empty) plus an explicit on*/data-_ev-* reject, so no handler can ever be bound.
function sanitizeModalMessage(message) {
    var frag = document.createDocumentFragment();
    if (message == null) return frag;
    var doc = null;
    try { doc = new DOMParser().parseFromString(String(message), 'text/html'); } catch (e) { doc = null; }
    if (!doc || !doc.body) { frag.appendChild(document.createTextNode(String(message))); return frag; }

    // Iterative (not recursive — hostile input can nest arbitrarily deep) depth-first
    // copy. Stack items are [sourceNode, destinationParent, depth]; children are
    // pushed in reverse so they pop back in document order.
    var stack = [];
    var roots = doc.body.childNodes;
    for (var r = roots.length - 1; r >= 0; r--) stack.push([roots[r], frag, 0]);

    while (stack.length) {
        var item = stack.pop();
        var node = item[0], dest = item[1], depth = item[2];

        if (node.nodeType === 3) { dest.appendChild(document.createTextNode(node.nodeValue)); continue; } // text
        if (node.nodeType !== 1) continue; // comments, CDATA, PIs, doctypes: dropped

        var tag = String(node.tagName).toUpperCase();
        if (MODAL_OPAQUE_TAGS[tag]) continue; // drop the element AND its subtree

        var target = dest;
        if (MODAL_ALLOWED_TAGS[tag] && depth < MODAL_MAX_DEPTH) {
            // Fresh element, HTML namespace, zero attributes carried over. `tag` came
            // from the allow-list, so createElement can never be fed hostile input.
            target = document.createElement(tag.toLowerCase());
            var attrs = node.attributes;
            for (var j = 0; j < attrs.length; j++) {
                var lower = String(attrs[j].name).toLowerCase();
                if (!MODAL_ALLOWED_ATTRS[lower]) continue;
                // Belt and braces if the allow-list is ever widened: an event handler
                // in either spelling must never reach the patched setAttribute, and a
                // URL attribute must survive the scheme check first.
                if (lower.indexOf('on') === 0 || lower.indexOf('data-_ev-') === 0) continue;
                if (MODAL_URL_ATTRS[lower] && isUnsafeModalUrl(attrs[j].value)) continue;
                target.setAttribute(lower, attrs[j].value);
            }
            dest.appendChild(target);
        }
        // else: UNWRAP — the element itself is discarded but its children are copied
        // into `dest`, so an unexpected <div>/<h1>/<a> loses its markup, never its text.

        var kids = node.childNodes;
        for (var k = kids.length - 1; k >= 0; k--) stack.push([kids[k], target, depth + 1]);
    }
    return frag;
}

// Bug-sweep F1: modalResolve is a single global slot. Opening a second generic
// modal while one is still pending used to overwrite the first resolver, so the
// first caller's `await showModal(...)` hung forever. Settle the previous one as
// cancelled (null) before installing the new resolver. Shared by showModal and
// showPromptModal (ui/230-modals.js).
function settlePendingModalResolve() {
    if (!modalResolve) return;
    var prev = modalResolve;
    modalResolve = null;
    try { prev(null); } catch (e) {}
}

function showModal(title, message, buttons, variant) {
    return new Promise(function(resolve) {
        settlePendingModalResolve();
        modalResolve = resolve;
        var overlay = document.getElementById('modal-overlay');
        var header = document.getElementById('modal-header');
        var body = document.getElementById('modal-body');
        var actions = document.getElementById('modal-actions');
        overlay.classList.remove('modal-variant-warning', 'modal-variant-danger');
        var v = normalizeModalVariant(variant);
        if (v !== 'normal') overlay.classList.add('modal-variant-' + v);
        header.textContent = title;
        // Sanitized nodes, never innerHTML — see sanitizeModalMessage above.
        body.textContent = '';
        body.appendChild(sanitizeModalMessage(message));
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
