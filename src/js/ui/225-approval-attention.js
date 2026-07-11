// Approval attention helpers
// 1. Tab-title flash while a tool approval is pending and the tab is hidden.
// 2. Self-healing watchdog: the approval card is the dedicated #approval-card
//    element (ui/220-notification-system.js) — if a render race or stale state
//    hides it while approvals are pending, resurface it. Cheap and idempotent
//    (showApprovalNotification dedups, and showNextApprovalNotification
//    refuses to advance past a visible card).

var _approvalTitleFlashTimer = null;
var _approvalTitleFlashOriginal = null;

// True when anything approval-shaped is pending on this page: a queued or
// currently-shown notification, or a live resolver awaiting a verdict
// (pendingToolApprovals, core/030-config.js).
function _anyApprovalAttentionPending() {
    try {
        if (approvalNotificationQueue.length > 0) return true;
        if (Array.isArray(currentApprovalNotification) && currentApprovalNotification.length > 0) return true;
        for (var k in pendingToolApprovals) {
            if (pendingToolApprovals[k]) return true;
        }
    } catch (e) { /* globals not ready during boot */ }
    return false;
}

function startApprovalTitleFlash() {
    if (_approvalTitleFlashTimer) return; // already flashing — never stack intervals
    if (!document.hidden) return;         // only flash hidden tabs
    _approvalTitleFlashOriginal = document.title;
    var flashOn = false;
    _approvalTitleFlashTimer = setInterval(function() {
        // Self-clearing: stop as soon as the tab is visible again or nothing
        // is pending (covers every resolution path within one tick).
        if (!document.hidden || !_anyApprovalAttentionPending()) {
            stopApprovalTitleFlash();
            return;
        }
        flashOn = !flashOn;
        document.title = flashOn ? '⚠ Approval needed' : _approvalTitleFlashOriginal;
    }, 1000);
}

function stopApprovalTitleFlash() {
    if (_approvalTitleFlashTimer) {
        clearInterval(_approvalTitleFlashTimer);
        _approvalTitleFlashTimer = null;
    }
    if (_approvalTitleFlashOriginal !== null) {
        document.title = _approvalTitleFlashOriginal; // restore EXACT original
        _approvalTitleFlashOriginal = null;
    }
}

// Start or stop the flash based on current state (idempotent).
function syncApprovalTitleFlash() {
    if (document.hidden && _anyApprovalAttentionPending()) {
        startApprovalTitleFlash();
    } else {
        stopApprovalTitleFlash();
    }
}

// Resurface the approval card if approvals are pending but nothing is shown.
// The card has its own #approval-card element, so toasts in #snackbar (even
// pinned error/warning ones that never auto-close) can never hide it or block
// this watchdog. Never re-shows a card the user explicitly dismissed
// (_dismissedApprovalKeys, declared in ui/220-notification-system.js, cleared
// on chat navigation by showPendingApprovalNotifications).
function resurfacePendingApprovals() {
    var card = typeof getApprovalCardEl === 'function' ? getApprovalCardEl() : document.getElementById('approval-card');
    if (!card) return;
    // Card visible: the approval UI is already on screen — nothing to heal.
    if (card.classList.contains('show')) return;
    // Stale "currently showing" state with a hidden element: requeue + reset.
    if (Array.isArray(currentApprovalNotification) && currentApprovalNotification.length > 0) {
        approvalNotificationQueue = currentApprovalNotification.concat(approvalNotificationQueue);
    }
    currentApprovalNotification = null;
    isShowingApprovalNotification = false;
    if (approvalNotificationQueue.length > 0) {
        showNextApprovalNotification();
        return;
    }
    // Nothing queued: rebuild from live resolver entries whose approval rows
    // are still pending (skipping user-dismissed ones).
    for (var key in pendingToolApprovals) {
        var entry = pendingToolApprovals[key];
        if (!entry) continue;
        if (_dismissedApprovalKeys[entry.chatId + ':' + entry.approvalIndex]) continue;
        var chat = chats[entry.chatId];
        if (!chat || !Array.isArray(chat.messages)) continue;
        var row = chat.messages[entry.approvalIndex];
        if (!row || row.role !== 'approval' || row.status !== 'pending') continue;
        showApprovalNotification(
            chat.title || 'A chat',
            row.toolName,
            entry.chatId,
            (row.args && row.args.status_message) ? row.args.status_message : null,
            entry.approvalIndex,
            row.args
        );
    }
}

// Watchdog: light interval + visibility hook. Both are no-ops when nothing is
// pending or the card/toast is already visible.
setInterval(function() {
    try {
        resurfacePendingApprovals();
        syncApprovalTitleFlash();
    } catch (e) { /* must never break the page */ }
}, 3000);

document.addEventListener('visibilitychange', function() {
    try {
        resurfacePendingApprovals();
        syncApprovalTitleFlash();
    } catch (e) {}
});
