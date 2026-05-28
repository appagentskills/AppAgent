// PROMPT USER TOOL - Blocking form for structured input
// =============================================
// Renders an inline form styled like the tool approval prompt.
// The agent waits until the PM submits or cancels.

var pendingPromptResolvers = {}; // promptId -> resolve function

async function executePromptUser(args, options) {
    options = options || {};
    var fields = args.fields || [];
    var title = args.title || 'Input needed';
    if (!fields.length) return { success: false, error: 'fields array is required' };

    var chatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
    var chat = chats[chatId];
    if (!chat) return { success: false, error: 'No active chat' };

    var promptId = 'prompt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    // Add prompt message to chat (similar to approval messages)
    // Store toolCallId so we can inject a proper tool_result after page reload
    var promptMsg = {
        role: 'prompt_user',
        promptId: promptId,
        toolCallId: options.toolCallId || null,
        title: title,
        description: args.description || '',
        fields: fields,
        status: 'pending'
    };
    chat.messages.push(promptMsg);
    saveChatsToStorage();

    // If this is a background Action chat, flip the action button to 'needs_input'
    // and skip inline rendering — PM will see it via the button/jobs dropdown popup.
    if (chat.isBackground && chat.actionId && typeof setActionNeedsInput === 'function') {
        setActionNeedsInput(chat.actionId, promptId);
    } else if (currentChatId === chatId && currentView === 'chat') {
        // Foreground chat — render inline as before
        renderMessages();
        scrollToBottomIfAllowed();
    }

    // Block until PM submits or cancels
    var result = await new Promise(function(resolve) {
        pendingPromptResolvers[promptId] = resolve;
    });

    // Mirror the prompt message to the SW so its chat snapshot doesn't wipe
    // it on the next agent-event. submitPromptUser/cancelPromptUser mutated
    // promptMsg in place (status + values), so the reference captures the
    // final state. The SW splices it before the matching tool_result slot
    // in chat.messages — same position the page-side push placed it in.
    result._message_persist = promptMsg;
    return result;
}

// =============================================
// BACKGROUND PROMPT POPUP
// =============================================
// When an action button shows "needs_input" (bell), clicking it calls this
// to open a modal with the same form. Submit/cancel resolve the blocking promise.

function openBackgroundPromptPopup(chatId, promptId) {
    var chat = chats[chatId];
    if (!chat) return;
    var msg = null;
    for (var i = 0; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'prompt_user' && chat.messages[i].promptId === promptId) {
            msg = chat.messages[i]; break;
        }
    }
    if (!msg || msg.status !== 'pending') return;

    var fieldsHtml = (msg.fields || []).map(function(f) { return renderPromptField(f, promptId); }).join('');
    var descHtml = msg.description ?
        '<div class="bg-popup-desc">' + escapeHtml(msg.description) + '</div>' : '';

    var host = document.createElement('div');
    host.id = 'bg-popup-host';
    host.innerHTML =
        '<div class="modal-backdrop bg-popup-backdrop" onclick="closeBackgroundPromptPopup(event)">' +
            '<div class="modal bg-popup-modal" onclick="event.stopPropagation()">' +
                '<div class="modal-header">' +
                    '<span class="modal-title-text">' + escapeHtml(msg.title || 'Input needed') + '</span>' +
                    '<button class="modal-close-icon" onclick="closeBackgroundPromptPopup()" aria-label="Close">' + UI_ICONS.close + '</button>' +
                '</div>' +
                '<div class="bg-popup-body">' +
                    descHtml +
                    '<form id="prompt-form-' + promptId + '" onsubmit="event.preventDefault();submitBackgroundPromptPopup(\'' + chatId + '\',\'' + promptId + '\')">' +
                        fieldsHtml +
                    '</form>' +
                '</div>' +
                '<div class="bg-popup-footer">' +
                    '<button class="bg-popup-btn secondary" onclick="cancelBackgroundPromptPopup(\'' + chatId + '\',\'' + promptId + '\')">Cancel</button>' +
                    '<button class="bg-popup-btn primary" onclick="submitBackgroundPromptPopup(\'' + chatId + '\',\'' + promptId + '\')">Submit</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    document.body.appendChild(host);
}

function closeBackgroundPromptPopup(e) {
    if (e && e.target && !e.target.classList.contains('bg-popup-backdrop') && e.type === 'click') {
        if (e.currentTarget !== e.target) return;
    }
    var host = document.getElementById('bg-popup-host');
    if (host) host.remove();
}

function submitBackgroundPromptPopup(chatId, promptId) {
    var form = document.getElementById('prompt-form-' + promptId);
    if (!form) return;
    // Reuse the existing collection logic by temporarily swapping currentChatId
    var prev = currentChatId;
    currentChatId = chatId; // so status updates target the right chat
    submitPromptUser(promptId);
    currentChatId = prev;
    // Clear needs-input flag on the action button
    var chat = chats[chatId];
    if (chat && chat.actionId && typeof clearActionNeedsInput === 'function') {
        clearActionNeedsInput(chat.actionId);
    }
    closeBackgroundPromptPopup();
}

function cancelBackgroundPromptPopup(chatId, promptId) {
    var prev = currentChatId;
    currentChatId = chatId;
    cancelPromptUser(promptId);
    currentChatId = prev;
    var chat = chats[chatId];
    if (chat && chat.actionId && typeof clearActionNeedsInput === 'function') {
        clearActionNeedsInput(chat.actionId);
    }
    closeBackgroundPromptPopup();
}

// Called when PM submits the form
function submitPromptUser(promptId) {
    var form = document.getElementById('prompt-form-' + promptId);
    if (!form) return;

    // Collect values from form fields
    var values = {};
    var formFields = form.querySelectorAll('[data-field-name]');
    formFields.forEach(function(el) {
        var name = el.getAttribute('data-field-name');
        var type = el.getAttribute('data-field-type');
        if (type === 'boolean') {
            values[name] = el.checked;
        } else if (type === 'multi-select') {
            values[name] = [].slice.call(el.selectedOptions).map(function(o) { return o.value; });
        } else if (type === 'number') {
            values[name] = el.value ? parseFloat(el.value) : null;
        } else {
            values[name] = el.value;
        }
    });

    // Update message status
    var chatId = currentChatId;
    var chat = chats[chatId];
    if (chat) {
        for (var i = 0; i < chat.messages.length; i++) {
            if (chat.messages[i].role === 'prompt_user' && chat.messages[i].promptId === promptId) {
                chat.messages[i].status = 'submitted';
                chat.messages[i].values = values;
                break;
            }
        }
        saveChatsToStorage();
    }

    // Resolve the blocking promise (live agent loop)
    if (pendingPromptResolvers[promptId]) {
        pendingPromptResolvers[promptId]({ success: true, values: values });
        delete pendingPromptResolvers[promptId];
    } else {
        // After page reload: no resolver exists — inject a proper tool_result and re-run agent
        injectPromptToolResult(chat, promptId, { success: true, values: values });
    }

    renderMessages();
    scrollToBottomIfAllowed();
}

// Called when PM cancels the form
function cancelPromptUser(promptId) {
    // Update message status
    var chatId = currentChatId;
    var chat = chats[chatId];
    if (chat) {
        for (var i = 0; i < chat.messages.length; i++) {
            if (chat.messages[i].role === 'prompt_user' && chat.messages[i].promptId === promptId) {
                chat.messages[i].status = 'cancelled';
                break;
            }
        }
        saveChatsToStorage();
    }

    // Resolve with cancelled
    if (pendingPromptResolvers[promptId]) {
        pendingPromptResolvers[promptId]({ success: false, cancelled: true, message: 'User cancelled the form' });
        delete pendingPromptResolvers[promptId];
    } else {
        // After page reload
        injectPromptToolResult(chat, promptId, { success: false, cancelled: true, message: 'User cancelled the form' });
    }

    renderMessages();
    scrollToBottomIfAllowed();
}

// After page reload: write a proper tool_result matching the orphaned tool_use.
// Uses `recordToolResult` to update the existing placeholder (or any prior
// "[interrupted]" row injectInterruptedToolResults may have left) in place.
// The old implementation pushed at chat-end alongside the still-present
// placeholder, producing two `role:'tool'` rows with the same id and 400-ing
// the next API call with "multiple tool_result blocks with id …".
function injectPromptToolResult(chat, promptId, result) {
    if (!chat) return;

    var toolCallId = null;
    for (var i = 0; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'prompt_user' && chat.messages[i].promptId === promptId) {
            toolCallId = chat.messages[i].toolCallId;
            break;
        }
    }

    if (toolCallId && typeof recordToolResult === 'function') {
        recordToolResult(chat, toolCallId, 'prompt_user', JSON.stringify(result));
        saveChatsToStorage();
        renderMessages();
        scrollToBottomIfAllowed();
        runAgent(currentChatId);
    }
}

// Render a prompt_user message inline (called from renderMessages)
function renderPromptUserMessage(msg, index) {
    var promptId = msg.promptId;
    var isPending = msg.status === 'pending';
    var isSubmitted = msg.status === 'submitted';
    var isCancelled = msg.status === 'cancelled';

    var statusClass = isPending ? '' : (isSubmitted ? ' approved' : ' denied');
    var html = '<div class="message prompt-user" id="msg-' + index + '">';
    html += '<details class="tool-approval-prompt' + statusClass + '"' + (isPending ? ' open' : '') + '>';

    // Header
    var headerColor = isPending ? '' : (isSubmitted ? '' : '');
    html += '<summary class="tool-approval-header">';
    html += escapeHtml(msg.title || 'Input needed');
    if (isSubmitted) html += ' <span class="tool-approval-status allowed">Submitted</span>';
    if (isCancelled) html += ' <span class="tool-approval-status denied">Cancelled</span>';
    html += '</summary>';

    // Body
    html += '<div class="tool-approval-body">';
    if (msg.description) {
        html += '<div style="margin-bottom:var(--space-6);color:var(--text-secondary);font-size:var(--text-body-sm)">' + escapeHtml(msg.description) + '</div>';
    }

    if (isPending) {
        html += '<form id="prompt-form-' + promptId + '" onsubmit="event.preventDefault();submitPromptUser(\'' + promptId + '\')">';
        (msg.fields || []).forEach(function(field) {
            html += renderPromptField(field, promptId);
        });
        html += '</form>';
    } else if (isSubmitted && msg.values) {
        // Show submitted values as read-only
        html += '<div class="prompt-submitted-values">';
        (msg.fields || []).forEach(function(field) {
            var val = msg.values[field.name];
            var displayVal = Array.isArray(val) ? val.join(', ') : (val === true ? 'Yes' : val === false ? 'No' : String(val || ''));
            html += '<div class="prompt-value-row"><span class="prompt-value-label">' + escapeHtml(field.label || field.name) + ':</span> <span class="prompt-value-text">' + escapeHtml(displayVal) + '</span></div>';
        });
        html += '</div>';
    }
    html += '</div>';

    // Actions (only when pending)
    if (isPending) {
        html += '<div class="tool-approval-actions">';
        html += '<button class="tool-approval-btn deny" onclick="cancelPromptUser(\'' + promptId + '\')">' + UI_ICONS.close + ' Cancel</button>';
        html += '<button class="tool-approval-btn allow" onclick="submitPromptUser(\'' + promptId + '\')">' + UI_ICONS.check + ' Submit</button>';
        html += '</div>';
    }

    html += '</details></div>';
    return html;
}

function renderPromptField(field, promptId) {
    var name = field.name || '';
    var label = field.label || name;
    var type = field.type || 'text';
    var value = field.value != null ? field.value : '';
    var required = field.required ? ' required' : '';
    var placeholder = field.placeholder ? ' placeholder="' + escapeHtml(field.placeholder) + '"' : '';

    var html = '<div class="prompt-field">';
    html += '<label class="prompt-field-label">' + escapeHtml(label) + '</label>';

    if (type === 'textarea') {
        html += '<textarea class="prompt-field-input prompt-field-textarea" data-field-name="' + escapeHtml(name) + '" data-field-type="' + type + '"' + required + placeholder + '>' + escapeHtml(String(value)) + '</textarea>';
    } else if (type === 'select') {
        html += '<select class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="' + type + '"' + required + '>';
        (field.options || []).forEach(function(opt) {
            var optVal = typeof opt === 'object' ? opt.value : opt;
            var optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
            var selected = String(optVal) === String(value) ? ' selected' : '';
            html += '<option value="' + escapeHtml(String(optVal)) + '"' + selected + '>' + escapeHtml(String(optLabel)) + '</option>';
        });
        html += '</select>';
    } else if (type === 'multi-select') {
        html += '<select class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="' + type + '" multiple' + required + '>';
        var selectedValues = Array.isArray(value) ? value : [];
        (field.options || []).forEach(function(opt) {
            var optVal = typeof opt === 'object' ? opt.value : opt;
            var optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
            var selected = selectedValues.indexOf(optVal) >= 0 ? ' selected' : '';
            html += '<option value="' + escapeHtml(String(optVal)) + '"' + selected + '>' + escapeHtml(String(optLabel)) + '</option>';
        });
        html += '</select>';
    } else if (type === 'boolean') {
        html += '<label class="prompt-field-checkbox"><input type="checkbox" class="prompt-field-check" data-field-name="' + escapeHtml(name) + '" data-field-type="boolean"' + (value ? ' checked' : '') + '> ' + escapeHtml(label) + '</label>';
    } else if (type === 'number') {
        html += '<input type="number" class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="number" value="' + escapeHtml(String(value)) + '"' + required + placeholder + '>';
    } else if (type === 'date') {
        html += '<input type="date" class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="date" value="' + escapeHtml(String(value)) + '"' + required + '>';
    } else {
        // text (default)
        html += '<input type="text" class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="text" value="' + escapeHtml(String(value)) + '"' + required + placeholder + '>';
    }

    html += '</div>';
    return html;
}
