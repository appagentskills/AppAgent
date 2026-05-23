// History View Management
function toggleHistoryView() {
    if (currentView === 'history') return;
    openHistoryView();
}

function openHistoryView() {
    currentView = 'history';
    appStorage.setItem('currentView', 'history');
    hideAllPanels();
    var historyPanel = document.getElementById('history-panel');
    if (historyPanel) { historyPanel.style.display = 'flex'; renderHistoryPage(); }
    updateAllButtonStates();
    renderChatList();
    pushHistoryState('history', null);
}

function renderHistoryPage() {
    var historyList = document.getElementById('history-list');
    var historyStats = document.getElementById('history-stats');
    var historySearchIcon = document.getElementById('history-search-icon');
    var historyDownloadIcon = document.getElementById('history-download-icon');

    // Initialize icons (burger icon is in HTML)
    if (historySearchIcon) historySearchIcon.innerHTML = UI_ICONS.search;
    if (historyDownloadIcon) historyDownloadIcon.innerHTML = UI_ICONS.download;
    
    if (!historyList) return;
    
    var q = historySearchQuery ? historySearchQuery.toLowerCase().trim() : '';
    var isSearching = q && q.length >= 2;
    
    // Get filtered chat IDs
    var chatIds = filterHistoryChats(historySearchQuery);
    var totalChats = Object.keys(chats).length;
    var filteredCount = chatIds.length;
    var pinnedCount = Object.keys(chats).filter(function(id) { return chats[id].pinned; }).length;
    var totalCost = Object.keys(chats).reduce(function(sum, id) {
        var chat = chats[id];
        if (!chat || !chat.messages) return sum;
        return sum + chat.messages.reduce(function(chatSum, msg) {
            return chatSum + ((msg.metrics && msg.metrics.cost) || 0);
        }, 0);
    }, 0);
    
    // Update stats
    if (historyStats) {
        if (isSearching) {
            historyStats.innerHTML = '<strong>' + filteredCount + '</strong> result' + (filteredCount !== 1 ? 's' : '') + ' for "' + escapeHtml(q) + '"';
        } else {
            var statsHtml = '<strong>' + totalChats + '</strong> conversation' + (totalChats !== 1 ? 's' : '');
            if (pinnedCount > 0) statsHtml += ' · <strong>' + pinnedCount + '</strong> pinned';
            if (totalCost > 0) statsHtml += ' · Total cost: <strong>$' + totalCost.toFixed(2) + '</strong>';
            historyStats.innerHTML = statsHtml;
        }
    }
    
    if (totalChats === 0 && !q) {
        historyList.innerHTML = '<div class="history-empty">' +
            '<div class="history-empty-icon">' + UI_ICONS.chat + '</div>' +
            '<div class="history-empty-title">No conversations yet</div>' +
            '<div class="history-empty-text">Start a new chat to begin</div>' +
            '</div>';
        return;
    }
    
    if (filteredCount === 0 && isSearching) {
        historyList.innerHTML = '<div class="history-empty">' +
            '<div class="history-empty-icon">' + UI_ICONS.search + '</div>' +
            '<div class="history-empty-title">No matching chats</div>' +
            '<div class="history-empty-text">Try a different search term</div>' +
            '</div>';
        return;
    }
    
    // Sort: pinned first, then by date (newest first) - same as sidebar
    var sortedChats = chatIds.map(function(id) { return chats[id]; }).sort(function(a, b) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.createdAt - a.createdAt;
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
    stats.widgetNames = widgetList.map(function(w) { return w.title || w.name || 'Widget'; });
    
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
    
    var title = chat.title || 'Untitled Chat';
    var preview = getHistoryChatPreview(chat);
    var messageCount = chat.messages ? chat.messages.length : 0;
    var dateStr = formatHistoryDate(chat.updatedAt || chat.createdAt);
    var isActive = chatId === currentChatId;
    var stats = getChatStats(chatId);
    var contextLength = getContextLength(chat);
    
    // Badges
    var badgesHtml = '';
    if (chat.pinned) badgesHtml += '<span class="history-chat-badge pinned">' + UI_ICONS.pinFilled + 'Pinned</span>';
    if (stats.hasDashboardWidget) badgesHtml += '<span class="history-chat-badge dashboard">' + UI_ICONS.widget + 'Dashboard</span>';
    
    // Action buttons - pin button is bold when pinned
    var pinBtnClass = chat.pinned ? 'history-chat-action-btn pinned' : 'history-chat-action-btn';
    var actionsHtml = '<div class="history-chat-actions">' +
        '<button class="history-chat-action-btn" onclick="event.stopPropagation(); openRenameModal(\'' + chatId + '\')" title="Rename">' + UI_ICONS.edit + '</button>' +
        '<button class="' + pinBtnClass + '" onclick="event.stopPropagation(); togglePinChat(\'' + chatId + '\'); renderHistoryPage();" title="' + (chat.pinned ? 'Unpin' : 'Pin') + '">' + (chat.pinned ? UI_ICONS.pinFilled : UI_ICONS.pin) + '</button>' +
        '<button class="history-chat-action-btn" onclick="event.stopPropagation(); exportChatFromHistory(\'' + chatId + '\')" title="Export">' + UI_ICONS.download + '</button>' +
        '<button class="history-chat-action-btn danger" onclick="event.stopPropagation(); deleteChat(\'' + chatId + '\', event)" title="Delete">' + UI_ICONS.trash + '</button>' +
        '</div>';
    
    // Stats row with message count and tools
    var statsHtml = '<div class="history-chat-stats">';
    statsHtml += '<span class="history-chat-stat">' + UI_ICONS.chat + messageCount + ' msg</span>';
    if (stats.toolCalls > 0) statsHtml += '<span class="history-chat-stat">' + UI_ICONS.tool + stats.toolCalls + ' tools</span>';
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
    var previewHtml = '<div class="history-chat-preview-area" onclick="openChatFromHistory(\'' + chatId + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \')openChatFromHistory(\'' + chatId + '\')" role="button" tabindex="0" aria-label="Open chat: ' + escapeHtml(title) + '">';
    if (preview.user) {
        previewHtml += '<div class="history-preview-msg user"><span class="history-preview-label">' + UI_ICONS.user + 'You:</span><span class="history-preview-text">' + escapeHtml(preview.user) + '</span></div>';
    }
    if (preview.assistant) {
        previewHtml += '<div class="history-preview-msg assistant"><span class="history-preview-label">' + UI_ICONS.bot + 'Agent:</span><span class="history-preview-text">' + escapeHtml(preview.assistant) + '</span></div>';
    }
    previewHtml += '</div>';
    
    // Meta row with date, context, cost, then model (inside card at bottom)
    var metaHtml = '<div class="history-chat-meta">';
    metaHtml += '<span>' + UI_ICONS.clock + dateStr + '</span>';
    if (contextLength > 0) metaHtml += '<span>' + formatContextLength(contextLength) + '</span>';
    if (stats.cost > 0) {
        var costStr = stats.cost < 0.01 ? stats.cost.toFixed(4) : stats.cost.toFixed(2);
        metaHtml += '<span class="history-meta-cost">' + UI_ICONS.money + '$' + costStr + '</span>';
    }
    if (stats.model) metaHtml += '<span class="history-meta-model">' + UI_ICONS.model + stats.model + '</span>';
    metaHtml += '</div>';
    
    return '<div class="history-chat-card' + (isActive ? ' active' : '') + '">' +
        '<div class="history-chat-header">' +
        '<div class="history-chat-title-row" onclick="openChatFromHistory(\'' + chatId + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \')openChatFromHistory(\'' + chatId + '\')" role="button" tabindex="0">' +
        '<span class="history-chat-title">' + escapeHtml(title) + '</span>' +
        '<div class="history-chat-badges">' + badgesHtml + '</div>' +
        '</div>' + actionsHtml + '</div>' +
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
    if (tokens < 1000) return tokens + ' tokens';
    if (tokens < 1000000) return (tokens / 1000).toFixed(1) + 'K tokens';
    return (tokens / 1000000).toFixed(2) + 'M tokens';
}

function formatHistoryDate(timestamp) {
    if (!timestamp) return 'Unknown';
    var date = new Date(timestamp);
    var now = new Date();
    var diffMs = now - date;
    var diffMins = Math.floor(diffMs / 60000);
    var diffHours = Math.floor(diffMs / 3600000);
    var diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return diffMins + 'm ago';
    if (diffHours < 24) return diffHours + 'h ago';
    if (diffDays < 7) return diffDays + 'd ago';
    return date.toLocaleDateString();
}

function openChatFromHistory(chatId) {
    if (!chats[chatId]) return;
    currentChatId = chatId;
    appStorage.setItem('currentChatId', chatId);
    appStorage.setItem('lastChatId', chatId);
    currentView = 'chat';
    appStorage.setItem('currentView', 'chat');
    hideAllPanels();
    showChatView();
    clearUpdateSet();
    loadVersionHistory();
    renderMessages();
    updateInputPosition();
    updateChatTitleHeader();
    updateAllButtonStates();
    renderChatList();
    pushHistoryState('chat', chatId);
    // Sync Pause/Continue button state for the target chat. Without this, the
    // Pause button could leak in from a previously-viewed streaming chat because
    // this entry point bypasses selectChat.
    if (typeof runningChatIds !== 'undefined' && runningChatIds[chatId]) {
        isRunning = true;
        activeStreamingChatId = chatId;
        showPauseButton(chatId);
        if (typeof hideContinueButton === 'function') hideContinueButton();
    } else {
        isRunning = false;
        activeStreamingChatId = null;
        hidePauseButton();
        if (typeof refreshContinueButtonForChat === 'function') refreshContinueButtonForChat(chatId);
    }
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
    if (!q || q.length < 2) return Object.keys(chats);
    
    return Object.keys(chats).filter(function(id) {
        var chat = chats[id];
        return chatMatchesSearch(chat, q);
    });
}

function clearHistorySearch() {
    historySearchQuery = '';
    var input = document.getElementById('history-search-input');
    if (input) {
        input.value = '';
    }
    renderHistoryPage();
}

function exportChatFromHistory(chatId) {
    var chat = chats[chatId];
    if (!chat) return;
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
    showSnackbar('Chat exported', 'success');
}

function downloadChatHistory() {
    var exportData = {
        exportedAt: new Date().toISOString(),
        totalChats: Object.keys(chats).length,
        chats: {}
    };
    Object.keys(chats).forEach(function(chatId) {
        var chat = chats[chatId];
        exportData.chats[chatId] = {
            title: chat.title || 'Untitled Chat',
            messages: chat.messages || [],
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            model: chat.model,
            totalCost: chat.totalCost,
            pinned: chat.pinned
        };
    });
    var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'appagent_chat_history_' + new Date().toISOString().split('T')[0] + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showSnackbar('Chat history exported (' + Object.keys(chats).length + ' chats)', 'success');
}
