// Copy message functions
function copyMessageText(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages[msgIndex]) return;
    var msg = chat.messages[msgIndex];
    navigator.clipboard.writeText(msg.content).then(function() {
        showSnackbar('Message copied', 'success');
    });
}

function copyAiMessage(userMsgIdx) {
    var chat = chats[currentChatId];
    if (!chat) return;
    
    // Find the range of messages for this response (from userMsgIdx to next user message)
    var nextUserIdx = chat.messages.length;
    for (var i = userMsgIdx + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserIdx = i;
            break;
        }
    }
    
    // Collect all assistant content and tool calls in this range
    var content = [];
    for (var j = userMsgIdx + 1; j < nextUserIdx; j++) {
        var msg = chat.messages[j];
        if (msg.role === 'assistant') {
            if (msg.content) content.push(msg.content);
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                msg.tool_calls.forEach(function(tc) {
                    var toolName = TOOL_DISPLAY_NAMES[tc.function.name] || tc.function.name;
                    content.push('[Tool: ' + toolName + ']\n' + tc.function.arguments);
                });
            }
        }
    }
    
    navigator.clipboard.writeText(content.join('\n\n')).then(function() {
        showSnackbar('Response copied', 'success');
    });
}

// Toggle API stats display
function toggleApiStats() {
    showApiStats = !showApiStats;
    appStorage.setItem('showApiStats', showApiStats);
    renderMessages();
}

// Toggle compact tool calls display
function toggleCompactToolCalls() {
    compactToolCalls = !compactToolCalls;
    appStorage.setItem('compactToolCalls', compactToolCalls);
    renderMessages();
}

// Change screenshot method
function setScreenshotMethod(value) {
    screenshotMethod = value;
    appStorage.setItem('screenshotMethod', value);
}

// Apply the current theme to the document
function applyTheme() {
    var effectiveTheme = appTheme;
    if (effectiveTheme === 'system') {
        effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effectiveTheme);
}

// Change theme setting
function setAppTheme(value) {
    appTheme = value;
    appStorage.setItem('appTheme', value);
    applyTheme();
}

// Listen for OS theme changes (only matters when set to 'system')
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
    if (appTheme === 'system') applyTheme();
});

// Estimate token count (rough approximation: ~4 chars per token)
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

// Calculate current system prompt token count (includes tools and skills)
function getSystemPromptTokenCount() {
    var systemPrompt = getSystemPromptWithContext();
    var tools = getEnabledTools();
    var toolsJson = JSON.stringify(tools);
    var totalText = systemPrompt + toolsJson;
    return estimateTokens(totalText);
}

// Update context usage indicator using actual token count from API metrics
function updateContextIndicator() {
    var indicator = document.getElementById('context-indicator');
    var fill = document.getElementById('context-fill');
    if (!indicator || !fill) return;

    // Get last known input_tokens from most recent assistant message with metrics (skip aggregate totals)
    var totalTokens = 0;
    var chat = chats[currentChatId];
    if (chat && chat.messages) {
        for (var i = chat.messages.length - 1; i >= 0; i--) {
            var m = chat.messages[i];
            // Skip aggregate metrics (Total X calls) - we want the last individual call
            if (m.role === 'assistant' && m.metrics && m.metrics.input_tokens && !m.metrics.isAggregate) {
                totalTokens = m.metrics.input_tokens;
                break;
            }
        }
    }

    // Get context limit for current model (default 128k)
    var provider = (typeof currentProvider !== 'undefined' && getProviderById(currentProvider)) ? getProviderById(currentProvider) : null;
    var contextLimit = (provider && provider.context_length) || (provider && provider.maxTokens ? provider.maxTokens * 2 : 128000);

    // Hide indicator if tokens < 10k (for new/empty chats)
    if (totalTokens < 10000) {
        indicator.style.display = 'none';
        return;
    }

    // Show indicator when >= 10k tokens
    indicator.style.display = 'flex';

    var percentage = Math.min(100, Math.round((totalTokens / contextLimit) * 100));
    fill.setAttribute('stroke-dasharray', percentage + ', 100');
    indicator.setAttribute('data-percentage', percentage);

    // Set warning/danger classes
    indicator.className = 'context-indicator';
    if (percentage >= 90) indicator.classList.add('danger');
    else if (percentage >= 70) indicator.classList.add('warning');

    // Show percentage and token count in tooltip
    var tokenDisplay = totalTokens >= 1000 ? Math.round(totalTokens / 1000) + 'k' : totalTokens;
    indicator.title = percentage + '% context used (' + tokenDisplay + ' tokens)';
}

// Auto-resize textarea
function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

// Trigger resize on all widget iframes
function resizeAllWidgets() {
    if (window.__widgetResizeFns) {
        window.__widgetResizeFns.forEach(function(fn) {
            setTimeout(fn, 50);
            setTimeout(fn, 350);
        });
    }
}

// Toggle sidebar
function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    appStorage.setItem('sidebarCollapsed', sidebarCollapsed ? 'true' : 'false');
    var sidebar = document.getElementById('sidebar');
    if (sidebarCollapsed) {
        sidebar.classList.remove('expanded');
    } else {
        sidebar.classList.add('expanded');
    }
    updateSidebarToggleIcon();
    updateMobileSidebarOverlay();
    resizeAllWidgets();
}

// Manage clickable overlay for mobile sidebar
function updateMobileSidebarOverlay() {
    var existing = document.getElementById('sidebar-overlay');
    if (!sidebarCollapsed && window.innerWidth <= 480) {
        if (!existing) {
            var overlay = document.createElement('div');
            overlay.id = 'sidebar-overlay';
            overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:999;background:var(--bg-overlay);';
            overlay.onclick = function() { toggleSidebar(); };
            document.body.appendChild(overlay);
        }
    } else if (existing) {
        existing.remove();
    }
}

// Update sidebar toggle button icon based on collapsed state
function updateSidebarToggleIcon() {
    var btn = document.getElementById('sidebar-toggle-btn');
    if (btn) {
        if (sidebarCollapsed) {
            btn.innerHTML = UI_ICONS.panelLeftOpen;
            btn.title = 'Expand sidebar';
        } else {
            btn.innerHTML = UI_ICONS.panelLeftClose;
            btn.title = 'Collapse sidebar';
        }
    }
}

// Toggle history section expand/collapse
function toggleHistorySection() {
    historyExpanded = !historyExpanded;
    appStorage.setItem('historyExpanded', historyExpanded ? 'true' : 'false');
    var chatList = document.getElementById('chat-list');
    var historyBtn = document.getElementById('history-toggle-btn');
    if (chatList) {
        if (historyExpanded) {
            chatList.classList.remove('collapsed');
        } else {
            chatList.classList.add('collapsed');
        }
    }
    if (historyBtn) {
        if (historyExpanded) {
            historyBtn.classList.add('expanded');
        } else {
            historyBtn.classList.remove('expanded');
        }
    }
}

// Update input position based on messages
function updateInputPosition() {
    var chat = chats[currentChatId];
    var inputArea = document.getElementById('input-area');
    var messages = document.getElementById('messages');
    if (!inputArea || !messages) return;

    if (!chat || chat.messages.length === 0) {
        inputArea.classList.add('centered');
        messages.classList.add('centered');
    } else {
        inputArea.classList.remove('centered');
        messages.classList.remove('centered');
    }
}

function showSpinner(text, chatId) {
    // In compact mode, skip the spinner - the collapsible area shows status
    if (compactToolCalls) return;
    // Skip spinner during silent hook runs
    if (_silentHookRunning) return;
    // Per-chat scoping: callers running in a background chat (chatId !== currentChatId)
    // must NOT inject their spinner into the foreground container. Without this guard,
    // a background `runAgent` calling showSpinner('Waiting for response...') would
    // overwrite the foreground chat's spinner text every loop iteration.
    if (chatId && chatId !== currentChatId) return;
    var container = document.getElementById('messages');
    var spinnerHtml = '<div class="spinner-container" id="loading-spinner">' +
        '<div class="spinner"></div>' +
        '<span class="spinner-text">' + escapeHtml(text || 'Thinking...') + '</span>' +
        '</div>';
    hideSpinner();
    container.insertAdjacentHTML('beforeend', spinnerHtml);
    scrollToBottomIfAllowed(container);
}

function hideSpinner(chatId) {
    // Per-chat scoping (dual of showSpinner): a background `runAgent` finishing a
    // tool call must NOT clear the foreground chat's spinner. Without this guard,
    // the foreground spinner flickers off every time a background chat returns from
    // a tool / hits a paused-exit / errors out. Foreground callers (legacy UI in
    // 24/25/26/27) omit chatId and behave as before.
    if (chatId && chatId !== currentChatId) return;
    var spinner = document.getElementById('loading-spinner');
    if (spinner) spinner.remove();
}
