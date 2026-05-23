// Send message in widget editing mode - uses main agent chat
async function sendWidgetMessage(message) {
    var input = document.getElementById('message-input');
    var widget = dashboardWidgets[currentEditingWidget];
    if (!widget) return;
    
    // Update title if it's still default
    if (widget.title === 'New Widget' || !widget.title) {
        widget.title = message.substring(0, 50) + (message.length > 50 ? '...' : '');
        var headerTitle = document.getElementById('header-chat-title');
        if (headerTitle) {
            headerTitle.innerHTML = '<span class="widget-mode-badge">Widget</span> ' + escapeHtml(widget.title);
        }
    }
    
    // Set prompt if not set
    if (!widget.prompt) {
        widget.prompt = message;
    }
    
    // Store widget conversation for context
    widget.conversation = widget.conversation || [];
    widget.conversation.push({ role: 'user', content: message });
    
    // Build widget context message for main agent
    var widgetContext = '[WIDGET MODE] You are editing widget "' + widget.title + '" (ID: ' + widget.id + '). ' +
        'Use the html_widget tool with widget_id="' + widget.id + '" to update this widget. ' +
        'Create a complete, self-contained HTML widget with styles and scripts. ' +
        'For ServiceNow API calls, use: await executeTool("servicenow_api", {method:"GET", table:"...", ...})\n\n' +
        'User request: ' + message;
    
    var chat = chats[currentChatId];
    chat.messages.push({ role: 'user', content: widgetContext, isWidgetRequest: true, widgetId: widget.id });
    
    input.value = '';
    input.style.height = 'auto';
    
    // Show widget as loading
    widget.isLoading = true;
    widget.isStreaming = true;
    activeWidgetStreamingId = widget.id;
    await saveDashboardWidget(widget);
    
    // Render loading state
    renderWidgetInChat(widget);
    
    updateChatTitle(chat);
    delete chat.isTemporary;
    saveChatsToStorage();
    renderMessages();
    renderChatList();
    
    paused = false;
    document.getElementById('pause-btn').innerHTML = '<span class="btn-icon">' + UI_ICONS.pause + '</span>Pause';
    
    // Run main agent
    await runAgent();
    
    // After agent completes, update widget state
    widget.isLoading = false;
    widget.isStreaming = false;
    activeWidgetStreamingId = null;
    await saveDashboardWidget(widget);
    
    input.focus();
    renderWidgetInChat(widget);
}

function handleKeyDown(e) {
    // Skip Enter while user is composing IME input (CJK languages send keyCode 229 / isComposing=true).
    // Without this, pressing Enter to commit an IME candidate prematurely sends the message.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        sendMessage();
    }
}

// =============================================