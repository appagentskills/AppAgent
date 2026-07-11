// PR1: sendMessage moved here from 030-agent-loop.js. It's the user-input
// entry point — reads the message-input field, mutates the chat, and kicks
// off runAgent. Lives with the other send-message helpers; behavior is
// unchanged.
async function sendMessage() {
    var input = document.getElementById('message-input');
    var message = input.value.trim();

    // Allow sending if we have a message OR pending images
    if (!message && pendingImageAttachments.length === 0) return;

    // During streaming: queue message and images to inject after current tool results.
    // Gate on the PER-CHAT running flag, not the global `isRunning`. The global tracks
    // foreground UI state and can be incidentally true (e.g. after revealing a background
    // action chat then navigating away) even when the chat the user is currently typing
    // in has no active stream. Queueing in that case sends the message into the wrong chat.
    if (runningChatIds[currentChatId]) {
        // Build user message content with attachment labels (same as normal path)
        var injImageCount = pendingImageAttachments.filter(function(a) { return !a.fileType || a.fileType === 'image'; }).length;
        var injPdfCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'pdf'; }).length;
        var injFileCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'file'; }).length;
        var injDocCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'document'; }).length;
        var injAttachLabel = '';
        if (injImageCount > 0 || injPdfCount > 0 || injFileCount > 0 || injDocCount > 0) {
            var injParts = [];
            if (injImageCount > 0) injParts.push(injImageCount + ' image(s)');
            if (injPdfCount > 0) injParts.push(injPdfCount + ' PDF(s)');
            if (injFileCount > 0) injParts.push(injFileCount + ' file(s)');
            if (injDocCount > 0) injParts.push(injDocCount + ' document(s)');
            injAttachLabel = '[User attached ' + injParts.join(' and ') + ']';
        }
        // Concatenate with any existing queued message for THIS chat — never overwrite.
        // Without this, sending a second message during the abort/restart window silently
        // dropped the first one (the per-chat entry was a flat replace).
        var _newText = message || injAttachLabel;
        var _newImages = pendingImageAttachments.length > 0 ? pendingImageAttachments.slice() : [];
        var _existing = pendingInjectionsByChatId[currentChatId];
        var _mergedText, _mergedImages;
        if (_existing) {
            _mergedText = _existing.text || '';
            if (_newText) _mergedText = _mergedText ? (_mergedText + '\n\n' + _newText) : _newText;
            _mergedImages = (_existing.images || []).concat(_newImages);
        } else {
            _mergedText = _newText;
            _mergedImages = _newImages;
        }
        pendingInjection = _mergedText || null;
        pendingInjectionImages = _mergedImages.length > 0 ? _mergedImages : null;
        // Key the per-chat map by the chat the user is actually typing in — not by
        // activeStreamingChatId, which may point to a different (background) chat.
        pendingInjectionsByChatId[currentChatId] = { text: pendingInjection, images: pendingInjectionImages };
        clearPendingImages();
        input.value = '';
        input.style.height = 'auto';
        // Clear the persisted draft too — mirrors the idle path below. Without
        // this, the draft saved by the input listener survives in chatPendingTexts
        // and the next restorePendingTextForContext (chat switch / reopen / boot)
        // re-paints the already-sent message into the input box.
        delete chatPendingTexts[getCurrentPendingContext()];
        persistPendingTextsToStorage();

        // Interrupt the current step so the message is sent instantly:
        //  • If LLM is mid-stream — abort the fetch (partial response is dropped).
        //  • If we're mid tool execution — fire the interrupt resolver so the race
        //    promise resolves _immediately_ (no polling delay). Orphan tool keeps
        //    running in the background; its result is discarded.
        //
        // POST-OFFSCREEN-RELOCATION: the abort controllers / interrupt resolvers
        // live in the offscreen runtime. The local calls below are no-ops in the
        // page bundle (empty maps) but we keep them as a safety net AND push the
        // queued message + interrupt over the bus so offscreen does the real work.
        userInterruptedChats[currentChatId] = true;
        var ac = currentStreamAbortControllers[currentChatId];
        if (ac && typeof ac.abort === 'function') {
            try { ac.abort(); } catch (e) {}
        }
        var interruptFn = interruptResolversByChatId[currentChatId];
        if (typeof interruptFn === 'function') {
            try { interruptFn(); } catch (e) {}
        }
        // Push the queued message + interrupt to offscreen. Offscreen will
        // append the user message to its chats[chatId].messages, set its own
        // pendingInjectionsByChatId, fire its interrupt resolver, and abort
        // its in-flight stream. The next agent-event broadcast updates the
        // page mirror so the queued bubble appears.
        // SWM-T6: the send-message post is best-effort; when _agentBusPort is
        // falsy (the ~250ms+ window while _openAgentBus reconnects after a SW
        // eviction) the queued injection was silently dropped and never reached
        // offscreen. Retry on a short timer (mirrors runAgent's attempt() loop /
        // pushInterruptToOffscreen) and force-reopen the bus so the injection
        // reliably lands.
        (function _sendMessageToOffscreen(_chatId, _text, _images, _retries) {
            if (typeof _agentBusPort === 'undefined' || !_agentBusPort) {
                if ((_retries || 0) < 20) { setTimeout(function() { _sendMessageToOffscreen(_chatId, _text, _images, (_retries || 0) + 1); }, 50); }
                else { if (typeof _openAgentBus === 'function') { try { _openAgentBus(); } catch (e) {} } setTimeout(function() { _sendMessageToOffscreen(_chatId, _text, _images, 0); }, 250); }
                return;
            }
            try {
                _agentBusPort.postMessage({
                    type: 'send-message',
                    chatId: _chatId,
                    // SWM14-T7: inline the chat snapshot (mirrors run-agent's post @045:405).
                    // During the SW cold-boot window chats={} in the SW; _handlePanelSendMessage
                    // seeds chats[chatId]=msg.chat ONLY when the chat is absent (never clobbers a
                    // live one), so a mid-boot send no longer lands on a skeleton chat whose save
                    // would store.clear()+rewrite away every sibling chat.
                    chat: chats[_chatId],
                    text: _text,
                    images: _images
                });
            } catch (e) {
                if ((_retries || 0) < 20) { setTimeout(function() { _sendMessageToOffscreen(_chatId, _text, _images, (_retries || 0) + 1); }, 50); }
                else { if (typeof _openAgentBus === 'function') { try { _openAgentBus(); } catch (e2) {} } setTimeout(function() { _sendMessageToOffscreen(_chatId, _text, _images, 0); }, 250); }
            }
        })(currentChatId, _newText, _newImages, 0);

        // SWM-T4: supersede any pause(true)/interrupt(false) retry chain armed during a port-down window so it can't re-pause or abort this fresh send on reconnect.
        if (currentChatId && typeof pushPauseToggleToOffscreen === 'function') pushPauseToggleToOffscreen(currentChatId, false);
        if (currentChatId && typeof _supersedeInterruptToggle === 'function') _supersedeInterruptToggle(currentChatId);
        // SILENT-HOOK-QUEUE-FIX: if THIS chat is mid silent after-response hook
        // (set_chat_title / set_tldr — mirrored from the SW into the per-chat
        // _silentHookChats map via the silentHookState event), BOTH showSpinner()
        // (ui/240-layout.js) and renderMessages() (ui/250-message-render.js)
        // early-return on that flag — the anti-flash gate. So the two calls just
        // below would be no-ops and the "Queued" bubble + "Interrupting…" spinner
        // would stay hidden until the hook finishes: the user perceives a long
        // delay before their just-sent message shows. The user is explicitly
        // interrupting that hook, so the suppression no longer applies — clear
        // this chat's mirror entry now. Safe: silentHookState{active:true} is
        // emitted ONCE at hook start (already past), and the loop-reset's
        // {active:false} later just re-confirms the cleared state. Hook TEXT
        // stays hidden regardless via the isHookMessage / _hiddenHookTurn
        // filters (core/050-streaming.js).
        if (typeof _silentHookChats !== 'undefined' && _silentHookChats[currentChatId]) {
            delete _silentHookChats[currentChatId];
        }
        // Update spinner immediately so the user sees instant acknowledgement.
        showSpinner('Interrupting…', currentChatId);
        // Re-render so the queued bubble appears immediately under the chat.
        renderMessages();
        showSnackbar('Message sent — interrupting current step.');
        return;
    }

    // Clear any stale injection from a previous paused run — this new message supersedes it
    pendingInjection = null;
    pendingInjectionImages = null;

    // Check if we're in widget editing mode
    if (currentEditingWidget) {
        await sendWidgetMessage(message);
        return;
    }

    // Re-stick when the user sends a new message (single stick-to-bottom mechanism)
    stickToBottom = true;

    // Clear pending input since we're sending it
    delete chatPendingTexts[getCurrentPendingContext()];
    persistPendingTextsToStorage();

    var chat = chats[currentChatId];

    // Add user message (even if empty when attachments present, provide context)
    var imageCount = pendingImageAttachments.filter(function(a) { return !a.fileType || a.fileType === 'image'; }).length;
    var pdfCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'pdf'; }).length;
    var fileCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'file'; }).length;
    var docAttachments = pendingImageAttachments.filter(function(a) { return a.fileType === 'document'; });
    var attachLabel = '';
    if (imageCount > 0 || pdfCount > 0 || fileCount > 0 || docAttachments.length > 0) {
        var parts = [];
        if (imageCount > 0) parts.push(imageCount + ' image(s)');
        if (pdfCount > 0) parts.push(pdfCount + ' PDF(s)');
        if (fileCount > 0) parts.push(fileCount + ' file(s)');
        if (docAttachments.length > 0) parts.push(docAttachments.length + ' document(s)');
        attachLabel = '[User attached ' + parts.join(' and ') + ']';
    }
    var userMessageContent = message || attachLabel;

    // Inject placeholder results for any interrupted tool calls before adding user message
    if (injectInterruptedToolResults(chat)) {
        // Tool calls were interrupted - clean up UI state
        activeStreamingChatId = null;
        isRunning = false;
        paused = false;
        // User is sending a new message — clear any per-chat pause flag too,
        // otherwise the next runAgent's `while (!isChatPaused(currentChatId))`
        // gate fails immediately and the message is silently dropped.
        if (currentChatId && pausedChats) pausedChats[currentChatId] = false;
        // SWM14-T1: a bare flag clear doesn't bump _pauseToggleGen, so a pause(true) retry chain armed during a prior port-down window is still 'current' and re-posts true after this send lands, re-pausing/dropping the run. Supersede it.
        if (currentChatId && typeof pushPauseToggleToOffscreen === 'function') pushPauseToggleToOffscreen(currentChatId, false);
        // SWM14-T3: symmetrically supersede any armed interrupt(false) retry chain so it can't abort the freshly-sent stream + delete the just-queued pendingInjection on reconnect.
        if (currentChatId && typeof _supersedeInterruptToggle === 'function') _supersedeInterruptToggle(currentChatId);
        hideSpinner(currentChatId);
        hidePauseButton();
        saveChatsToStorage();
        renderMessages();
    }

    chat.messages.push({ role: 'user', content: userMessageContent });

    // Add pending attachments as screenshot/pdf/file/document messages
    if (pendingImageAttachments.length > 0) {
        pendingImageAttachments.forEach(function(img) {
            if (img.fileType === 'document') {
                // Document reference — inject context message with doc ID for the agent to read
                var docTitle = img.name || 'Untitled';
                var docId = img.sdocId;
                chat.messages.push({
                    role: 'context',
                    content: '[User referenced Smart Document "' + docTitle + '" (doc_id: ' + docId + '). Use the document tool with action "read" and this doc_id to access its content.]'
                });
                return;
            }
            var _fid = img.file_id || newFileId();
            if (img.fileType === 'pdf') {
                chat.messages.push({
                    role: 'pdf',
                    base64: img.base64,
                    name: img.name,
                    description: 'User attached PDF',
                    timestamp: Date.now(),
                    file_id: _fid
                });
            } else if (img.fileType === 'file') {
                chat.messages.push({
                    role: 'file',
                    content: img.content,
                    name: img.name,
                    mimeType: img.mimeType,
                    size: img.size,
                    description: 'User attached file',
                    timestamp: Date.now(),
                    file_id: _fid
                });
            } else {
                chat.messages.push({
                    role: 'screenshot',
                    base64: img.base64,
                    name: img.name,
                    description: 'User attached image',
                    timestamp: Date.now(),
                    width: img.width,
                    height: img.height,
                    file_id: _fid
                });
            }
            registerFile(_fid, { type: 'chat', chatId: chat.id, msgIndex: chat.messages.length - 1 });
        });
        // Clear pending attachments after adding to messages
        clearPendingImages();
    }

    updateChatTitle(chat);

    delete chat.isTemporary;
    saveChatsToStorage();

    renderMessages();
    renderChatList();
    input.value = '';
    input.style.height = 'auto';
    paused = false;
    // Clear the per-chat pause flag too — without this, runAgent's outer
    // `while (!isChatPaused(currentChatId))` gate trips immediately and the
    // user's freshly-sent message is silently dropped on a previously-paused chat.
    if (currentChatId && pausedChats) pausedChats[currentChatId] = false;
    // SWM14-T1: a bare flag clear doesn't bump _pauseToggleGen, so a pause(true) retry chain armed during a prior port-down window is still 'current' and re-posts true after this send lands, re-pausing/dropping the run. Supersede it.
    if (currentChatId && typeof pushPauseToggleToOffscreen === 'function') pushPauseToggleToOffscreen(currentChatId, false);
    // SWM14-T3: symmetrically supersede any armed interrupt(false) retry chain so it can't abort the freshly-sent stream + delete the just-queued pendingInjection on reconnect.
    if (currentChatId && typeof _supersedeInterruptToggle === 'function') _supersedeInterruptToggle(currentChatId);
    // Sync the button label off the (now-cleared) per-chat state instead of
    // hard-coding it — keeps a single source of truth for the label.
    if (typeof syncPauseButtonUI === 'function') {
        syncPauseButtonUI(currentChatId);
    } else {
        document.getElementById('pause-btn').innerHTML = '<span class="btn-icon">' + UI_ICONS.pause + '</span>Pause';
    }

    await runAgent();
}

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