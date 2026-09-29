// History View Management

// HIST-RECENCY: single source of truth for a chat's "last touched" stamp, used
// by the history page (sort + card date) and the sidebar chat list (sort).
// `updatedAt` was a DEAD FIELD (read here, written nowhere) until it was wired
// to the two lastResponseAt writers (worker/100-agent-event-broadcast.js
// _swStampChatFinished, tools/120-actions.js markChatRecentlyFinished);
// lastActivityAt covers mid-run activity on unfocused chats (markChatActivity).
function chatActivityTs(c) {
    // Recency = real activity stamps with createdAt floor. EXCLUDES lastViewedAt (P696-1: viewing ≠ activity).
    return Math.max(c.updatedAt || 0, c.lastResponseAt || 0, c.lastActivityAt || 0, c.createdAt || 0);
}

function toggleHistoryView() {
    if (currentView === 'history') return;
    openHistoryView();
}

function openHistoryView() {
    currentView = 'history';
    appStorage.setItem('currentView', 'history');
    // SWM2-F3: left the chat view — clear this panel's focus entry so the SW
    // sub-agent GC doesn't keep the previously-viewed chat pinned (port-keyed).
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(null);
    hideAllPanels();
    var historyPanel = document.getElementById('history-panel');
    if (historyPanel) { historyPanel.style.display = 'flex'; renderHistoryPage(); }
    updateAllButtonStates();
    renderChatList();
    pushHistoryState('history', null);
}

// Rows/Gallery layout for the history page (shared helpers: ui/045-page-layout.js).
var HISTORY_PAGE_LAYOUT_KEY = 'historyPageLayout'; // 'rows' | 'gallery'
function historySetPageLayout(layout) {
    pageLayoutSet(HISTORY_PAGE_LAYOUT_KEY, layout);
    renderHistoryPage();
}

function _historyChatVisible(c) {
    if (!c || c.isSubAgent || c.isTemporary) return false; // A7B-01
    return !(c.isBackground && !c._revealed);
}

function renderHistoryPage() {
    var historyList = document.getElementById('history-list');
    var layoutSlot = document.getElementById('history-layout-toggle');
    if (layoutSlot && typeof pageLayoutToggleHtml === 'function' && !layoutSlot.firstChild) {
        layoutSlot.innerHTML = pageLayoutToggleHtml('historySetPageLayout');
    } else if (layoutSlot && typeof pageLayoutRelabel === 'function') {
        pageLayoutRelabel(layoutSlot); // language switch: relabel in place
    }
    var historyLayout = typeof pageLayoutGet === 'function' ? pageLayoutGet(HISTORY_PAGE_LAYOUT_KEY) : 'rows';
    if (typeof pageLayoutSyncButtons === 'function') pageLayoutSyncButtons(layoutSlot, historyLayout);
    var historyStats = document.getElementById('history-stats');
    var historySearchIcon = document.getElementById('history-search-icon');
    var historyDownloadIcon = document.getElementById('history-download-icon');

    // Initialize icons (burger icon is in HTML)
    if (historySearchIcon) historySearchIcon.innerHTML = UI_ICONS.search;
    if (historyDownloadIcon) historyDownloadIcon.innerHTML = UI_ICONS.download;
    
    if (!historyList) return;
    
    var q = historySearchQuery ? historySearchQuery.toLowerCase().trim() : '';
    var isSearching = q && q.length >= 2;
    // Search results reuse the sidebar's compact chat rows, so they always list as rows.
    historyList.className = 'history-list widget-library-items page-list layout-' + (isSearching ? 'rows' : historyLayout);
    
    // Get filtered chat IDs
    var chatIds = filterHistoryChats(historySearchQuery);
    // Visibility predicate.
    //
    // Background ACTION chats are hidden until the user explicitly reveals
    // one (the original design — keeps short one-shot action runs out of
    // the history list).
    //
    // Sub-agent chats are ALSO `isBackground:true`. They are delegated
    // workers spawned by a parent agent, not user-facing runs, so they are
    // hidden from the history page unconditionally (regardless of the
    // _revealed flag). Background action chats keep the reveal-gate.
    function _isVisibleHistoryChat(c) { return _historyChatVisible(c); }
    var visibleChatIds = Object.keys(chats).filter(function(id) { return _isVisibleHistoryChat(chats[id]); });
    var totalChats = visibleChatIds.length;
    var filteredCount = chatIds.length;
    var pinnedCount = visibleChatIds.filter(function(id) { return chats[id].pinned; }).length;
    var totalCost = visibleChatIds.reduce(function(sum, id) {
        var chat = chats[id];
        if (!chat || !chat.messages) return sum;
        return sum + chat.messages.reduce(function(chatSum, msg) {
            return chatSum + ((msg.metrics && msg.metrics.cost) || 0);
        }, 0);
    }, 0);
    
    // Update stats
    if (historyStats) {
        if (isSearching) {
            historyStats.innerHTML = tn(filteredCount, '<strong>{count}</strong> result for "{query}"', '<strong>{count}</strong> results for "{query}"', { query: escapeHtml(q) });
        } else {
            var statsHtml = tn(totalChats, '<strong>{count}</strong> conversation', '<strong>{count}</strong> conversations');
            if (pinnedCount > 0) statsHtml += ' · ' + tn(pinnedCount, '<strong>{count}</strong> pinned', '<strong>{count}</strong> pinned');
            if (totalCost > 0) statsHtml += ' · ' + t('Total cost: <strong>{cost}</strong>', { cost: '$' + totalCost.toFixed(2) });
            historyStats.innerHTML = statsHtml;
        }
    }
    
    if (totalChats === 0 && !q) {
        historyList.innerHTML = '<div class="history-empty">' +
            '<div class="history-empty-icon">' + UI_ICONS.chat + '</div>' +
            '<div class="history-empty-title">' + escapeHtml(t('No conversations yet')) + '</div>' +
            '<div class="history-empty-text">' + escapeHtml(t('Start a new chat to begin')) + '</div>' +
            '</div>';
        return;
    }
    
    if (filteredCount === 0 && isSearching) {
        historyList.innerHTML = '<div class="history-empty">' +
            '<div class="history-empty-icon">' + UI_ICONS.search + '</div>' +
            '<div class="history-empty-title">' + escapeHtml(t('No matching chats')) + '</div>' +
            '<div class="history-empty-text">' + escapeHtml(t('Try a different search term')) + '</div>' +
            '</div>';
        return;
    }
    
    // Sort: pinned first, then by last activity (newest first) - same as sidebar.
    // chatActivityTs (not createdAt) so a chat continued today surfaces today.
    var sortedChats = chatIds.map(function(id) { return chats[id]; }).sort(function(a, b) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return chatActivityTs(b) - chatActivityTs(a);
    });
    
    // When searching, use sidebar's exact search result display (renderChatItem)
    if (isSearching) {
        // Temporarily set chatSearchQuery to use renderChatItem properly
        var oldQuery = chatSearchQuery;
        chatSearchQuery = historySearchQuery;
        historyList.innerHTML = sortedChats.map(function(c) {
            return renderChatItem(c);
        }).join('');
        chatSearchQuery = oldQuery;
    } else {
        // Normal view: use history chat cards
        historyList.innerHTML = sortedChats.map(function(c) {
            return renderHistoryChatCard(c.id);
        }).join('');
    }
}

function getChatStats(chatId) {
    var chat = chats[chatId];
    var stats = { toolCalls: 0, fileChanges: [], fileTables: [], widgetNames: [], hasDashboardWidget: false, model: '', cost: 0 };
    if (!chat || !chat.messages) return stats;
    
    // Get widgets from chat.widgets (persisted) or getWidgetsForChat
    var widgetList = getWidgetsForChat(chatId);
    stats.widgetNames = widgetList.map(function(w) { return w.title || w.name || t('Widget'); });
    
    // Check if any widget from this chat is on dashboard
    Object.keys(dashboardWidgets || {}).forEach(function(dwId) {
        var dw = dashboardWidgets[dwId];
        if (dw.chatId === chatId) {
            stats.hasDashboardWidget = true;
        }
    });
    
    // Get files from chat.versionHistory (persisted per chat)
    var chatVersionHistory = chat.versionHistory || [];
    var filesMap = {};
    chatVersionHistory.forEach(function(v) {
        if (v.action !== 'REVERT' && v.action !== 'USER_DELETE' && !v.invalidated) {
            var key = v.table + '_' + v.sysId;
            if (!filesMap[key]) {
                filesMap[key] = { name: v.displayName, table: v.table };
            }
        }
    });
    var filesArr = Object.values(filesMap);
    stats.fileChanges = filesArr.map(function(f) { return f.name; });
    stats.fileTables = filesArr.map(function(f) { return f.table; });
    
    // Loop through messages for tool calls, model and cost from metrics
    chat.messages.forEach(function(msg) {
        if (msg.role === 'assistant') {
            if (msg.tool_calls) {
                stats.toolCalls += msg.tool_calls.length;
            }
            // Get model and cost from metrics
            if (msg.metrics) {
                if (msg.metrics.actualModel && !stats.model) {
                    stats.model = msg.metrics.actualModel;
                }
                if (msg.metrics.cost) {
                    stats.cost += msg.metrics.cost;
                }
            }
        }
    });
    
    return stats;
}

function renderHistoryChatCard(chatId) {
    var chat = chats[chatId];
    if (!chat) return '';
    
    // 'New Chat' is the stored English marker; translate it only for display.
    var title = chat.title ? (chat.title === 'New Chat' ? t('New Chat') : chat.title) : t('Untitled Chat');
    var preview = getHistoryChatPreview(chat);
    var messageCount = chat.messages ? chat.messages.length : 0;
    var dateStr = formatHistoryDate(chatActivityTs(chat));
    var isActive = chatId === currentChatId;
    var stats = getChatStats(chatId);
    var contextLength = getContextLength(chat);
    
    // Badges
    var badgesHtml = '';
    if (chat.pinned) badgesHtml += '<span class="history-chat-badge pinned">' + UI_ICONS.pinFilled + escapeHtml(t('Pinned')) + '</span>';
    if (stats.hasDashboardWidget) badgesHtml += '<span class="history-chat-badge dashboard">' + UI_ICONS.widget + escapeHtml(t('Dashboard')) + '</span>';
    // Sub-agent badge — history cards previously rendered sub-agent transcripts
    // identically to top-level chats, so a user scanning the history page could
    // not tell at a glance which chats were delegated workers vs. real
    // conversations. The sidebar chat list has had this distinction via
    // `renderSubAgentBreadcrumb` for a while; this brings the history view to
    // parity. `chat.isSubAgent` is stamped at sub-agent chat creation in
    // 097-sub-agent-registry.js.
    if (chat.isSubAgent) badgesHtml += '<span class="history-chat-badge subagent" title="' + escapeHtml(t('Delegated worker chat')) + '">' + UI_ICONS.bot + escapeHtml(t('Sub-agent')) + '</span>';
    
    // Action buttons - pin button is bold when pinned
    var pinBtnClass = chat.pinned ? 'history-chat-action-btn pinned' : 'history-chat-action-btn';
    var actionsHtml = '<div class="history-chat-actions">' +
        '<button class="history-chat-action-btn" onclick="event.stopPropagation(); openRenameModal(\'' + chatId + '\')" title="' + escapeHtml(t('Rename')) + '">' + UI_ICONS.edit + '</button>' +
        '<button class="' + pinBtnClass + '" onclick="event.stopPropagation(); togglePinChat(\'' + chatId + '\'); renderHistoryPage();" title="' + escapeHtml(chat.pinned ? t('Unpin') : t('Pin')) + '">' + (chat.pinned ? UI_ICONS.pinFilled : UI_ICONS.pin) + '</button>' +
        '<button class="history-chat-action-btn" onclick="event.stopPropagation(); exportChatFromHistory(\'' + chatId + '\')" title="' + escapeHtml(t('Export')) + '">' + UI_ICONS.download + '</button>' +
        '<button class="history-chat-action-btn danger" onclick="event.stopPropagation(); deleteChat(\'' + chatId + '\', event)" title="' + escapeHtml(t('Delete')) + '">' + UI_ICONS.trash + '</button>' +
        '</div>';
    
    // Stats row with message count and tools
    var statsHtml = '<div class="history-chat-stats">';
    statsHtml += '<span class="history-chat-stat">' + UI_ICONS.chat + escapeHtml(tn(messageCount, '{count} msg', '{count} msg')) + '</span>';
    if (stats.toolCalls > 0) statsHtml += '<span class="history-chat-stat">' + UI_ICONS.tool + escapeHtml(tn(stats.toolCalls, '{count} tool', '{count} tools')) + '</span>';
    // Widget tags inline
    stats.widgetNames.slice(0, 3).forEach(function(name) {
        statsHtml += '<span class="history-chat-stat widgets">' + UI_ICONS.widget + escapeHtml(name) + '</span>';
    });
    if (stats.widgetNames.length > 3) statsHtml += '<span class="history-chat-stat widgets">+' + (stats.widgetNames.length - 3) + '</span>';
    // File tags inline with proper icons from table
    stats.fileChanges.slice(0, 3).forEach(function(name, idx) {
        var table = stats.fileTables[idx] || '';
        statsHtml += '<span class="history-chat-stat files">' + getTableIcon(table) + escapeHtml(name) + '</span>';
    });
    if (stats.fileChanges.length > 3) statsHtml += '<span class="history-chat-stat files">+' + (stats.fileChanges.length - 3) + '</span>';
    statsHtml += '</div>';
    
    // Preview with user message and Agent answer
    var previewHtml = '<div class="history-chat-preview-area">';
    if (preview.user) {
        previewHtml += '<div class="history-preview-msg user"><span class="history-preview-label">' + UI_ICONS.user + escapeHtml(t('You:')) + '</span><span class="history-preview-text">' + escapeHtml(preview.user) + '</span></div>';
    }
    if (preview.assistant) {
        previewHtml += '<div class="history-preview-msg assistant"><span class="history-preview-label">' + UI_ICONS.bot + escapeHtml(t('Agent:')) + '</span><span class="history-preview-text">' + escapeHtml(preview.assistant) + '</span></div>';
    }
    previewHtml += '</div>';
    
    // Meta row with date, context, cost, then model (inside card at bottom)
    var metaHtml = '<div class="history-chat-meta">';
    metaHtml += '<span>' + UI_ICONS.clock + escapeHtml(dateStr) + '</span>';
    if (contextLength > 0) metaHtml += '<span>' + escapeHtml(formatContextLength(contextLength)) + '</span>';
    if (stats.cost > 0) {
        var costStr = stats.cost < 0.01 ? stats.cost.toFixed(4) : stats.cost.toFixed(2);
        metaHtml += '<span class="history-meta-cost">' + UI_ICONS.money + '$' + costStr + '</span>';
    }
    if (stats.model) metaHtml += '<span class="history-meta-model">' + UI_ICONS.model + stats.model + '</span>';
    metaHtml += '</div>';
    
    // Render the parent-chain breadcrumb for sub-agent chats. The same helper
    // is used by the sidebar chat list — if it's missing (older bundle) we
    // silently skip the breadcrumb rather than crashing the card render.
    var subAgentBreadcrumb = (chat.isSubAgent && typeof renderSubAgentBreadcrumb === 'function')
        ? renderSubAgentBreadcrumb(chat) : '';
    // `history-chat-card.subagent` lets CSS tint the whole card (left-border
    // accent) so the row stands out even before the badge is read.
    var subAgentCardClass = chat.isSubAgent ? ' subagent' : '';

    // The WHOLE card is the click target (it already hover-highlights as one
    // clickable unit) — openChatCardFromHistory guards against clicks on inner
    // interactive controls (action buttons, breadcrumb links).
    return '<div class="history-chat-card' + (isActive ? ' active' : '') + subAgentCardClass + '" onclick="openChatCardFromHistory(\'' + chatId + '\', event)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openChatCardFromHistory(\'' + chatId + '\', event)}" role="button" tabindex="0" aria-label="' + escapeHtml(t('Open chat: {title}', { title: title })) + '">' +
        '<div class="history-chat-header">' +
        '<div class="history-chat-title-row">' +
        '<span class="history-chat-title">' + escapeHtml(title) + '</span>' +
        '<div class="history-chat-badges">' + badgesHtml + '</div>' +
        '</div>' + actionsHtml + '</div>' +
        subAgentBreadcrumb +
        previewHtml +
        statsHtml +
        metaHtml +
        '</div>';
}

function getHistoryChatPreview(chat) {
    if (!chat.messages || chat.messages.length === 0) return { user: '', assistant: '' };
    
    var userMsg = '';
    var assistantMsg = '';
    
    // Find first user message
    for (var i = 0; i < chat.messages.length; i++) {
        var msg = chat.messages[i];
        if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
            userMsg = msg.content;
            break;
        }
    }
    
    // Find first assistant message after user message
    for (var j = 0; j < chat.messages.length; j++) {
        var msg = chat.messages[j];
        if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
            assistantMsg = msg.content;
            break;
        }
    }
    
    return { user: userMsg, assistant: assistantMsg };
}

function getContextLength(chat) {
    if (!chat.messages) return 0;
    var total = 0;
    chat.messages.forEach(function(msg) {
        if (typeof msg.content === 'string') total += estimateTokens(msg.content);
        if (msg.tool_calls) {
            msg.tool_calls.forEach(function(tc) {
                if (tc.function && tc.function.arguments) total += estimateTokens(tc.function.arguments);
            });
        }
    });
    return total;
}

function formatContextLength(tokens) {
    if (tokens < 1000) return tn(tokens, '{count} token', '{count} tokens');
    if (tokens < 1000000) return t('{value}K tokens', { value: i18nFormatNumber(tokens / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
    return t('{value}M tokens', { value: i18nFormatNumber(tokens / 1000000, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
}

function formatHistoryDate(timestamp) {
    if (!timestamp) return t('Unknown');
    var date = new Date(timestamp);
    var now = new Date();
    var diffMs = now - date;
    var diffDays = Math.floor(diffMs / 86400000);
    
    // Under a week: locale relative text (narrow: "now", "5m ago", "2h ago",
    // "3d ago" in English). A future stamp from clock skew reads as now, like
    // the old 'Just now'. Older: a locale date.
    if (diffDays < 7) return i18nFormatRelative(Math.min(date.getTime(), now.getTime()), { now: now.getTime(), style: 'narrow' });
    return i18nFormatDate(date);
}

// Whole-card click target for history cards (see renderHistoryChatCard). The
// inner action buttons and breadcrumb links stopPropagation() themselves; the
// closest() guard is a second belt so a click on any inner interactive control
// (or a future one that forgets stopPropagation) never hijacks navigation.
function openChatCardFromHistory(chatId, event) {
    if (event && event.target && event.target.closest &&
        event.target.closest('button, a, .history-chat-actions')) return;
    openChatFromHistory(chatId);
}

function openChatFromHistory(chatId) {
    if (!chats[chatId]) return;
    // Save the outgoing context's pending draft (text + images) and restore the
    // target chat's draft. This entry point used to mutate `currentChatId`
    // directly, which silently dropped whatever the user had typed/attached on
    // the previous chat AND left the target chat's pending state un-restored.
    // selectChat() does this dance for the sidebar; the history-card path needs
    // the same treatment or the user loses unsent work every time they bounce
    // through the history page.
    if (typeof getCurrentPendingContext === 'function' && typeof savePendingTextForContext === 'function') {
        try {
            var _prevCtx = getCurrentPendingContext();
            savePendingTextForContext(_prevCtx);
            if (typeof savePendingImagesForContext === 'function') savePendingImagesForContext(_prevCtx);
        } catch (e) { /* non-fatal */ }
    }
    currentChatId = chatId;
    appStorage.setItem('currentChatId', chatId);
    appStorage.setItem('lastChatId', chatId);
    // SAGF-1: tell the SW which chat is focused so its sub-agent GC paths don't
    // reclaim a transcript the user is now viewing (SW currentChatId is null).
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(currentChatId);
    currentView = 'chat';
    appStorage.setItem('currentView', 'chat');
    hideAllPanels();
    showChatView();
    clearUpdateSet();
    loadVersionHistory();
    // Clear the foreground API-error banner so a stale error from a
    // previously-streaming chat doesn't bleed into the chat we're about to
    // render. selectChat does this on line 434; this entry-point bypasses
    // selectChat so it has to do it itself.
    if (typeof lastApiError !== 'undefined') lastApiError = null;
    // R-2: also hide the stale error snackbar (selectChat's counterpart does the
    // same) and restore lastApiError from this chat's persisted _lastApiError so a
    // previously-unfocused errored chat stays recoverable when opened from history.
    // Retry itself is painted by the syncChatControlsUI derive at the end.
    if (typeof hideSnackbar === 'function') hideSnackbar();
    var _histErr = chats[chatId] && chats[chatId]._lastApiError;
    if (_histErr) lastApiError = _histErr;
    // Re-sync the messages container's `is-streaming` class to the target
    // chat's actual run state. Without this, the class would carry over from
    // whichever chat was last viewed — a streaming chat would visually
    // un-stream when opened from history, and a dormant chat would inherit
    // streaming layout (extra bottom padding, scroll-pinning) from the
    // previously-streaming foreground.
    var _openHistMessagesEl = document.getElementById('messages');
    if (_openHistMessagesEl) {
        if (typeof runningChatIds !== 'undefined' && runningChatIds[chatId]) {
            _openHistMessagesEl.classList.add('is-streaming');
        } else {
            _openHistMessagesEl.classList.remove('is-streaming');
        }
    }
    renderMessages();
    updateInputPosition();
    updateChatTitleHeader();
    updateAllButtonStates();
    renderChatList();
    // Refresh Workers strip — see selectChat() in 170-chat-management.js
    // for the same call. openChatFromHistory bypasses selectChat, so the
    // strip needs an explicit kick or it shows the previous chat's chips.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
    // Restore the target chat's pending draft (companion to the save above).
    if (typeof restorePendingTextForContext === 'function') {
        try { restorePendingTextForContext(chatId); } catch (e) { /* non-fatal */ }
    }
    if (typeof restorePendingImagesForContext === 'function') {
        try { restorePendingImagesForContext(chatId); } catch (e) { /* non-fatal */ }
    }
    pushHistoryState('chat', chatId);
    // Sync the streaming state for the target chat, then let the CHAT-CONTROLS SSOT
    // (syncChatControlsUI, app/020-api-messages.js) paint exactly one of Pause/Resume,
    // Retry or Continue. It runs last, after the view, the displayed chat and
    // lastApiError are settled. Without it, Pause could leak in from a
    // previously-viewed streaming chat because this entry point bypasses selectChat.
    if (typeof runningChatIds !== 'undefined' && runningChatIds[chatId]) {
        isRunning = true;
        activeStreamingChatId = chatId;
    } else {
        isRunning = false;
        activeStreamingChatId = null;
    }
    if (typeof syncChatControlsUI === 'function') syncChatControlsUI(chatId);
    // B-D1: surface any pending approval notifications for this chat. selectChat
    // does this; this entry-point bypasses selectChat so it has to do it itself.
    if (typeof showPendingApprovalNotifications === 'function') {
        showPendingApprovalNotifications(chatId);
    }
    // B-A1: refresh any showing snackbar so its copy matches the new currentChatId.
    if (typeof rerenderCurrentNotification === 'function') {
        rerenderCurrentNotification();
    }
}

var historySearchQuery = '';
var historySearchDebounceTimer = null;

function handleHistorySearch(e) {
    var value = e.target.value;
    
    // Debounce the search
    if (historySearchDebounceTimer) {
        clearTimeout(historySearchDebounceTimer);
    }
    
    historySearchDebounceTimer = setTimeout(function() {
        historySearchQuery = value;
        renderHistoryPage();
    }, 250);
}

function filterHistoryChats(query) {
    var q = (query || '').toLowerCase().trim();
    // Always apply the visibility predicate — see renderHistoryPage for the
    // long-form rationale. Sub-agent chats are hidden from history
    // unconditionally, action chats stay reveal-gated.
    function _vis(c) { return _historyChatVisible(c); }
    if (!q || q.length < 2) {
        return Object.keys(chats).filter(function(id) { return _vis(chats[id]); });
    }
    return Object.keys(chats).filter(function(id) {
        var chat = chats[id];
        return _vis(chat) && chatMatchesSearch(chat, q);
    });
}

function clearHistorySearch() {
    // Cancel the in-flight debounce FIRST. handleHistorySearch schedules a 250ms
    // timer that closes over the OLD input value and re-assigns it to
    // historySearchQuery + re-renders; without this cancel the cleared state was
    // silently overwritten by the stale query a quarter second later (input
    // empty, stats line still "N results for <old query>").
    if (historySearchDebounceTimer) {
        clearTimeout(historySearchDebounceTimer);
        historySearchDebounceTimer = null;
    }
    historySearchQuery = '';
    var input = document.getElementById('history-search-input');
    if (input) {
        input.value = '';
    }
    renderHistoryPage();
}

async function exportChatFromHistory(chatId) {
    var chat = chats[chatId];
    if (!chat) return;
    // S0B2-07: report any failure (rehydration, serialisation, Blob/URL) as an
    // error snackbar; an async throw from the inline onclick would otherwise be
    // an unhandled rejection with no feedback.
    try {
        // MEMFIX: rehydrate evicted base64 payloads so the export contains the
        // full messages, not stripped ones. Never rejects.
        var payloadsOk = true;
        if (typeof ensureChatPayloads === 'function') {
            try { await ensureChatPayloads(chatId); } catch (e) { payloadsOk = false; }
        }
        if (chat._payloadsEvicted) payloadsOk = false; // A7B2-01
        var exportData = {
            title: chat.title || 'Untitled Chat',
            messages: chat.messages || [],
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            model: chat.model,
            totalCost: chat.totalCost
        };
        var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (chat.title || 'chat').replace(/[^a-z0-9]/gi, '_') + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (payloadsOk) showSnackbar(t('Chat exported'), 'success');
        else showSnackbar(t('Chat exported (some attachments could not be restored)'), 'warning');
    } catch (e) {
        showSnackbar(t('Chat export failed: {error}', { error: String((e && e.message) || e) }), 'error');
    }
}

async function downloadChatHistory() {
    // S0B2-07: rehydrate and serialise ONE chat at a time into Blob parts (no
    // Promise.all over every chat, no single giant pretty-printed string that
    // can exceed V8's max string length), count chats left incomplete, and
    // report failures instead of always claiming success.
    try {
        var ids = Object.keys(chats), parts = [''], n = 0, bad = 0;
        for (var i = 0; i < ids.length; i++) {
            // MEMFIX: rehydrate evicted base64 payloads so the export contains
            // full messages, not stripped ones. ensureChatPayloads never rejects
            // and clears chat._payloadsEvicted only on a full restore, so a chat
            // still flagged afterwards is exported incomplete.
            var failed = false;
            if (typeof ensureChatPayloads === 'function') {
                try { await ensureChatPayloads(ids[i]); } catch (e) { failed = true; }
            }
            var c = chats[ids[i]];
            if (!c) continue; // deleted while exporting
            if (failed || c._payloadsEvicted) bad++;
            parts.push((n ? ',' : '') + JSON.stringify(ids[i]) + ':' + JSON.stringify({
                title: c.title || 'Untitled Chat',
                messages: c.messages || [],
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
                model: c.model,
                totalCost: c.totalCost,
                pinned: c.pinned
            }));
            n++;
        }
        // Header last, from the exported count, so a chat deleted mid-export
        // does not skew totalChats.
        parts[0] = '{"exportedAt":' + JSON.stringify(new Date().toISOString()) + ',"totalChats":' + n + ',"chats":{';
        parts.push('}}');
        var blob = new Blob(parts, { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'appagent_chat_history_' + new Date().toISOString().split('T')[0] + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showSnackbar(bad
            ? tn(n, 'Chat history exported ({count} chat, {bad} incomplete)', 'Chat history exported ({count} chats, {bad} incomplete)', { bad: i18nFormatNumber(bad) })
            : tn(n, 'Chat history exported ({count} chat)', 'Chat history exported ({count} chats)'), bad ? 'warning' : 'success');
    } catch (e) {
        showSnackbar(t('Chat history export failed: {error}', { error: String((e && e.message) || e) }), 'error');
    }
}
