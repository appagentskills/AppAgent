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

    // MANDATORY FREE-TEXT ESCAPE HATCH: every user panel question must let the PM
    // answer in their own words, regardless of the constrained fields the agent
    // defined. If no open text/textarea field is present, append one so that
    // predefined select / multi-select / boolean / number / date choices are
    // never the ONLY way to respond.
    var _hasFreeText = fields.some(function(f) {
        return f && (f.type === 'text' || f.type === 'textarea');
    });
    if (!_hasFreeText) {
        fields = fields.concat([{
            name: 'free_text_response',
            type: 'textarea',
            label: 'Your answer (free text)',
            placeholder: 'Type your own answer here if none of the options above fit…',
            required: false
        }]);
    }

    var chatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
    var chat = chats[chatId];
    if (!chat) return { success: false, error: 'No active chat' };

    // Idempotency on reload/reconnect: when the panel reloads, the SW re-dispatches
    // a still-parked prompt_user to the reconnecting panel (see worker/120-tool-routing.js
    // 'replayed-prompt-user'), which re-invokes executePromptUser with the SAME toolCallId.
    // Without this guard each reload appends a fresh prompt_user row → the inline form
    // visibly duplicates (one extra copy per reload). Reuse the existing pending row
    // (and its promptId) instead of pushing a new one.
    var promptMsg = null;
    if (options.toolCallId) {
        for (var ei = 0; ei < chat.messages.length; ei++) {
            var em = chat.messages[ei];
            if (em && em.role === 'prompt_user' && em.toolCallId === options.toolCallId && em.status === 'pending') {
                promptMsg = em;
                break;
            }
        }
    }
    var promptId = (promptMsg && promptMsg.promptId) || ('prompt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7));

    // Add prompt message to chat (similar to approval messages) only if we did not
    // adopt an existing pending row above. Store toolCallId so we can inject a proper
    // tool_result after page reload.
    if (!promptMsg) {
        promptMsg = {
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
        // MP-1 (multi-panel): mirror the pending row to the SW's authoritative
        // copy AT DISPATCH, not only after resolve (_message_persist below).
        // Without this, SW chat snapshots sent to OTHER panels (or to a panel
        // opening this chat later) lack the row entirely — with 2+ panels the
        // executor can be a panel NOT viewing the chat (pickExecutorPort is
        // first-wins), so the viewing panel rendered only the raw tool_use
        // block + spinner and no form anywhere. The SW seeds the row before
        // the tool placeholder and broadcasts, so every panel viewing the chat
        // renders the live form (worker/120-tool-routing.js _swSeedPromptRow).
        if (typeof postPromptRowToSW === 'function') postPromptRowToSW(chatId, promptMsg);
    }

    // If this is a background Action chat, flip the action button to 'needs_input'
    // and skip inline rendering — PM will see it via the button/jobs dropdown popup.
    if (chat.isBackground && chat.actionId && typeof setActionNeedsInput === 'function') {
        setActionNeedsInput(chat.actionId, promptId);
    } else if (currentChatId === chatId && currentView === 'chat') {
        // Foreground chat — render inline as before
        renderMessages();
        scrollToBottomIfAllowed();
        // Auto-focus the first text-like field so the PM can type immediately
        setTimeout(function() {
            var formEl = document.getElementById('prompt-form-' + promptId);
            if (!formEl) return;
            var first = formEl.querySelector('input.prompt-field-input, textarea.prompt-field-input');
            if (first) first.focus();
        }, 80);
    }
    // Live needs_input badge on jobs rows / expand cards / header pill — covers
    // both the fresh push above and the adopted-row replay path.
    if (typeof _refreshWaitingBadges === 'function') { try { _refreshWaitingBadges(chatId); } catch (e) {} }

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
    var descHtml = promptDescriptionHtml(msg.description);

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
    // Parity with the inline render path: focus the first text-like field
    setTimeout(function() {
        var first = host.querySelector('input.prompt-field-input, textarea.prompt-field-input');
        if (first) first.focus();
    }, 50);
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
    // FLUX-QW1: pass the target chat EXPLICITLY instead of swapping the
    // currentChatId global around the call. The old swap had no try/finally
    // (a throw stranded the panel on the background chat) and
    // submitPromptUser's renderMessages() fired MID-SWAP, repainting the
    // visible pane with the BACKGROUND chat's transcript (the restore never
    // re-rendered, so the wrong transcript stayed up).
    var ok = submitPromptUser(promptId, chatId);
    if (ok === false) return; // validation failed — keep popup open and needs_input state intact
    // Clear needs-input flag on the action button
    var chat = chats[chatId];
    if (chat && chat.actionId && typeof clearActionNeedsInput === 'function') {
        clearActionNeedsInput(chat.actionId);
    }
    closeBackgroundPromptPopup();
}

function cancelBackgroundPromptPopup(chatId, promptId) {
    // FLUX-QW1: explicit chatId, no global swap — see submitBackgroundPromptPopup.
    cancelPromptUser(promptId, chatId);
    var chat = chats[chatId];
    if (chat && chat.actionId && typeof clearActionNeedsInput === 'function') {
        clearActionNeedsInput(chat.actionId);
    }
    closeBackgroundPromptPopup();
}

// Called when PM submits the form. `chatId` is optional: the inline
// transcript form omits it (the prompt belongs to the chat on screen); the
// background prompt popup passes the owning chat explicitly (FLUX-QW1).
function submitPromptUser(promptId, chatId) {
    var form = document.getElementById('prompt-form-' + promptId);
    // Return false (not undefined) so submitBackgroundPromptPopup's
    // `ok === false` guard holds: returning undefined would clear the
    // needs_input flag and close the popup while the prompt stays pending
    // forever with no way to reopen it.
    if (!form) return false;

    // Collect values from form fields (supports chip/pill/switch widgets)
    var values = {};
    var firstInvalid = null;
    var formFields = form.querySelectorAll('[data-field-name]');
    formFields.forEach(function(el) {
        var name = el.getAttribute('data-field-name');
        var type = el.getAttribute('data-field-type');
        var val;
        if (type === 'boolean') {
            val = el.checked;
        } else if (type === 'multi-select') {
            if (el.tagName === 'SELECT') {
                val = [].slice.call(el.selectedOptions).map(function(o) { return o.value; });
            } else {
                // Chip group or checkbox list
                val = [].slice.call(el.querySelectorAll('.prompt-chip.selected, input[type="checkbox"]:checked')).map(function(c) { return c.getAttribute('data-value'); });
            }
        } else if (type === 'select' && el.tagName !== 'SELECT') {
            var picked = el.querySelector('.prompt-chip.selected');
            val = picked ? picked.getAttribute('data-value') : '';
        } else if (type === 'number') {
            val = el.value ? parseFloat(el.value) : null;
        } else {
            val = el.value;
        }
        values[name] = val;

        // Required validation — footer buttons bypass native HTML5 validation,
        // so enforce it here and flag the field inline.
        var fieldWrap = el.closest('.prompt-field');
        var isEmpty = val == null || val === '' || (Array.isArray(val) && !val.length) || (type === 'number' && val != null && isNaN(val));
        if (el.getAttribute('data-required') === '1' && type !== 'boolean' && isEmpty) {
            if (fieldWrap) fieldWrap.classList.add('invalid');
            if (!firstInvalid) firstInvalid = fieldWrap || el;
        } else if (fieldWrap) {
            fieldWrap.classList.remove('invalid');
        }
    });
    if (firstInvalid) {
        // Visible feedback next to the Submit button (the per-field error alone
        // can be above the fold) — and instant scroll: a smooth animation makes
        // the buttons a moving target and can swallow the user's next click.
        var notice = form.querySelector('.prompt-validation-notice');
        if (!notice) {
            notice = document.createElement('div');
            notice.className = 'prompt-validation-notice';
            form.appendChild(notice);
        }
        var nInv = form.querySelectorAll('.prompt-field.invalid').length;
        notice.textContent = nInv === 1 ? '1 required field needs a value' : nInv + ' required fields need a value';
        if (firstInvalid.scrollIntoView) firstInvalid.scrollIntoView({ block: 'nearest' });
        return false;
    }
    var oldNotice = form.querySelector('.prompt-validation-notice');
    if (oldNotice) oldNotice.remove();

    // Update message status
    chatId = chatId || currentChatId;
    var chat = chats[chatId];
    if (chat) {
        for (var i = 0; i < chat.messages.length; i++) {
            if (chat.messages[i].role === 'prompt_user' && chat.messages[i].promptId === promptId) {
                chat.messages[i].status = 'submitted';
                chat.messages[i].values = values;
                break;
            }
        }
        // MEMFIX: rehydrate evicted payloads BEFORE persisting — the save
        // put-loop skips _payloadsEvicted chats (worker/115-storage.js /
        // ui/070-dashboard-ui.js), so this save would otherwise persist
        // nothing and the submitted status/values would be lost on reload.
        // Mirrors the run-agent gate in worker/130-port-bridge.js.
        // ensureChatPayloads never rejects, but chain both arms defensively.
        if (chat._payloadsEvicted && typeof ensureChatPayloads === 'function') {
            ensureChatPayloads(chatId).then(function() { saveChatsToStorage(); },
                function() { saveChatsToStorage(); });
        } else {
            saveChatsToStorage();
        }
    }

    // Resolve the blocking promise (live agent loop)
    if (pendingPromptResolvers[promptId]) {
        pendingPromptResolvers[promptId]({ success: true, values: values });
        delete pendingPromptResolvers[promptId];
    } else if (typeof _promptResultViaSW === 'function' && _promptResultViaSW(chatId, promptId, { success: true, values: values })) {
        // MP-2 (multi-panel): no LOCAL resolver, but the run is still live —
        // the blocked await lives in executePromptUser on ANOTHER panel (the
        // executor). Route the values through the SW, which forwards them to
        // the panel holding the armed resolver (or settles the call directly
        // if that panel is gone). First-submit-wins is enforced SW-side.
    } else {
        // After page reload with no live run: no resolver exists anywhere —
        // inject a proper tool_result and re-run agent
        injectPromptToolResult(chat, promptId, { success: true, values: values });
    }

    // Clear the live needs_input badge on jobs rows / header pill.
    if (typeof _refreshWaitingBadges === 'function') { try { _refreshWaitingBadges(chatId); } catch (e) {} }
    // FLUX-QW1: repaint only when the prompt belongs to the chat on screen —
    // renderMessages() always draws currentChatId, so rendering here on a
    // background chat's popup submit repainted the visible pane pointlessly
    // (and, under the old swap, with the WRONG chat's transcript).
    if (chatId === currentChatId) {
        renderMessages();
        scrollToBottomIfAllowed();
    }
    return true;
}

// Called when PM cancels the form. `chatId` optional — see submitPromptUser.
function cancelPromptUser(promptId, chatId) {
    // Update message status
    chatId = chatId || currentChatId;
    var chat = chats[chatId];
    if (chat) {
        for (var i = 0; i < chat.messages.length; i++) {
            if (chat.messages[i].role === 'prompt_user' && chat.messages[i].promptId === promptId) {
                chat.messages[i].status = 'cancelled';
                break;
            }
        }
        // MEMFIX: same as submitPromptUser — hydrate before the save or the
        // put-loop guard skips this chat and the cancellation never persists.
        if (chat._payloadsEvicted && typeof ensureChatPayloads === 'function') {
            ensureChatPayloads(chatId).then(function() { saveChatsToStorage(); },
                function() { saveChatsToStorage(); });
        } else {
            saveChatsToStorage();
        }
    }

    // Resolve with cancelled
    if (pendingPromptResolvers[promptId]) {
        pendingPromptResolvers[promptId]({ success: false, cancelled: true, message: 'User cancelled the form' });
        delete pendingPromptResolvers[promptId];
    } else if (typeof _promptResultViaSW === 'function' && _promptResultViaSW(chatId, promptId, { success: false, cancelled: true, message: 'User cancelled the form' })) {
        // MP-2: cancel from a non-executing panel — same SW route as submit.
    } else {
        // After page reload
        injectPromptToolResult(chat, promptId, { success: false, cancelled: true, message: 'User cancelled the form' });
    }

    // Clear the live needs_input badge on jobs rows / header pill.
    if (typeof _refreshWaitingBadges === 'function') { try { _refreshWaitingBadges(chatId); } catch (e) {} }
    // FLUX-QW1: same current-chat guard as submitPromptUser above.
    if (chatId === currentChatId) {
        renderMessages();
        scrollToBottomIfAllowed();
    }
}

// After page reload: write a proper tool_result matching the orphaned tool_use.
// Uses `recordToolResult` to update the existing placeholder (or any prior
// "[interrupted]" row injectInterruptedToolResults may have left) in place.
// The old implementation pushed at chat-end alongside the still-present
// placeholder, producing two `role:'tool'` rows with the same id and 400-ing
// the next API call with "multiple tool_result blocks with id …".
function injectPromptToolResult(chat, promptId, result) {
    if (!chat) return;

    // MEMFIX: the resumed run below mutates + saves this chat repeatedly; if
    // the chat is payload-evicted, EVERY one of those saves is skipped by the
    // put-loop guard (worker/115-storage.js / ui/070-dashboard-ui.js) and the
    // injected tool_result plus the whole resumed run persist NOTHING —
    // silent transcript loss on the next SW death / reload. Hydrate first
    // (mirrors the run-agent gate at worker/130-port-bridge.js), then inject
    // + resume. ensureChatPayloads never rejects; both arms chained anyway.
    if (chat._payloadsEvicted && typeof ensureChatPayloads === 'function') {
        ensureChatPayloads(chat.id || currentChatId).then(_doInject, _doInject);
        return;
    }
    _doInject();

    function _doInject() {
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
        // Resume the chat the prompt belongs to, NOT currentChatId: in the SW
        // currentChatId is permanently null (worker/130-port-bridge.js), so
        // runAgent(currentChatId) crashed on chats[null]. Handle the async
        // rejection too — this was an uncaught-promise site.
        var _resumeId = (chat && chat.id) || currentChatId;
        if (_resumeId) {
            Promise.resolve()
                .then(function() { return runAgent(_resumeId); })
                .catch(function(e) { console.error('[prompt-user] resume runAgent failed', _resumeId, e); });
        }
    }
    } // end _doInject
}

// Render a prompt description as a readable markdown card. Reuses the chat
// markdown pipeline (formatContent in ui/250-message-render.js: escapes HTML
// internally, preserves blank-line paragraphs, lists, inline/fenced code,
// links) inside a .markdown-body container so 07-markdown.css block rules
// apply. Fallback keeps escaping + newlines if formatContent is unavailable.
// Used by BOTH the inline chat form (renderPromptUserMessage) and the
// background prompt popup (openBackgroundPromptPopup).
function promptDescriptionHtml(description) {
    if (!description) return '';
    var inner = (typeof formatContent === 'function')
        ? formatContent(String(description))
        : escapeHtml(String(description)).replace(/\n/g, '<br>');
    return '<div class="prompt-user-desc markdown-body">' + inner + '</div>';
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
    // Title: INLINE markdown only (code spans + bold) — block markdown would
    // break the one-line <summary> row. Escaped first, same regexes as
    // formatContent's inline passes.
    html += escapeHtml(msg.title || 'Input needed')
        .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    if (isSubmitted) html += ' <span class="tool-approval-status allowed">Submitted</span>';
    if (isCancelled) html += ' <span class="tool-approval-status denied">' + (msg.abandoned ? 'Abandoned' : 'Cancelled') + '</span>';
    html += '</summary>';

    // Body
    html += '<div class="tool-approval-body">';
    html += promptDescriptionHtml(msg.description);

    if (isPending) {
        // RES-5: capture drafts on every input/change (events bubble to the
        // form) so a full transcript rebuild re-mounts the form with the
        // user's partially-entered values — see promptCaptureDraft below.
        html += '<form id="prompt-form-' + promptId + '" oninput="promptCaptureDraft(this)" onchange="promptCaptureDraft(this)" onsubmit="event.preventDefault();submitPromptUser(\'' + promptId + '\')">';
        (msg.fields || []).forEach(function(field) {
            html += renderPromptField(field, promptId);
        });
        html += '</form>';
    } else if (isSubmitted && msg.values) {
        // Show submitted values as read-only: one block per field — the label
        // on its own muted line, the answer below it. Newlines the user typed
        // (textareas) survive via .prompt-value-text's white-space: pre-wrap;
        // arrays render as one chip per entry; empty answers show an em dash.
        html += '<div class="prompt-submitted-values">';
        (msg.fields || []).forEach(function(field) {
            html += '<div class="prompt-value-row">';
            html += '<div class="prompt-value-label">' + escapeHtml(field.label || field.name) + '</div>';
            html += promptSubmittedValueHtml(field, msg.values[field.name]);
            html += '</div>';
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

// Map a raw submitted value back to its option LABEL — select/multi-select
// store option values, but the label is what the user actually clicked.
// Falls back to the raw value when no option matches (free-text, stale opts).
function promptOptionLabel(field, val) {
    var options = (field && field.options) || [];
    for (var i = 0; i < options.length; i++) {
        var opt = options[i];
        var ov = typeof opt === 'object' ? opt.value : opt;
        if (String(ov) === String(val)) {
            return String(typeof opt === 'object' ? (opt.label || opt.value) : opt);
        }
    }
    return String(val);
}

// Render ONE submitted answer as a display block (submitted/read-only state).
// All user content goes through escapeHtml — do not weaken this (XSS).
// Empty (null/undefined/''/[]) → muted em dash; arrays → chips; booleans →
// Yes/No; numbers/strings → pre-wrap text (newlines preserved by CSS).
function promptSubmittedValueHtml(field, val) {
    if (val == null || val === '' || (Array.isArray(val) && !val.length)) {
        return '<div class="prompt-value-text prompt-value-empty">&mdash;</div>';
    }
    if (Array.isArray(val)) {
        var chips = val.map(function(v) {
            return '<span class="prompt-value-chip">' + escapeHtml(promptOptionLabel(field, v)) + '</span>';
        }).join('');
        return '<div class="prompt-value-chips">' + chips + '</div>';
    }
    if (typeof val === 'boolean') {
        return '<div class="prompt-value-text">' + (val ? 'Yes' : 'No') + '</div>';
    }
    var text = (field && field.type === 'select') ? promptOptionLabel(field, val) : String(val);
    return '<div class="prompt-value-text">' + escapeHtml(text) + '</div>';
}

function renderPromptField(field, promptId) {
    var name = field.name || '';
    var label = field.label || name;
    var type = field.type || 'text';
    var value = field.value != null ? field.value : '';
    var required = field.required ? ' required' : '';
    var reqAttr = field.required ? ' data-required="1"' : '';
    var reqMark = field.required ? '<span class="prompt-field-required" title="Required">*</span>' : '';
    var clearInvalid = ' oninput="promptClearInvalid(this)"';
    var placeholder = field.placeholder ? ' placeholder="' + escapeHtml(field.placeholder) + '"' : '';
    var options = field.options || [];

    var html = '<div class="prompt-field">';
    if (type !== 'boolean') {
        html += '<label class="prompt-field-label">' + escapeHtml(label) + reqMark + '</label>';
    }

    if (type === 'textarea') {
        html += '<textarea class="prompt-field-input prompt-field-textarea" data-field-name="' + escapeHtml(name) + '" data-field-type="' + type + '"' + required + reqAttr + clearInvalid + placeholder + '>' + escapeHtml(String(value)) + '</textarea>';
    } else if (type === 'select') {
        if (options.length && options.length <= 6) {
            // Few options: one-click pill group (no dropdown to open)
            html += '<div class="prompt-chip-group" role="radiogroup" data-field-name="' + escapeHtml(name) + '" data-field-type="select"' + reqAttr + '>';
            options.forEach(function(opt) {
                var optVal = typeof opt === 'object' ? opt.value : opt;
                var optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                var selected = value !== '' && String(optVal) === String(value) ? ' selected' : '';
                html += '<button type="button" role="radio" class="prompt-chip' + selected + '" data-value="' + escapeHtml(String(optVal)) + '" onclick="promptPickPill(this)">' + escapeHtml(String(optLabel)) + '</button>';
            });
            html += '</div>';
        } else {
            var hasDefault = value !== '' && options.some(function(opt) {
                var ov = typeof opt === 'object' ? opt.value : opt;
                return String(ov) === String(value);
            });
            html += '<select class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="' + type + '"' + required + (options.length ? reqAttr : '') + ' onchange="promptClearInvalid(this)">';
            // Required + no default: placeholder option so the browser can't silently submit the first option
            if (field.required && !hasDefault) html += '<option value="" disabled selected hidden>Select…</option>';
            options.forEach(function(opt) {
                var optVal = typeof opt === 'object' ? opt.value : opt;
                var optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                var selected = String(optVal) === String(value) ? ' selected' : '';
                html += '<option value="' + escapeHtml(String(optVal)) + '"' + selected + '>' + escapeHtml(String(optLabel)) + '</option>';
            });
            html += '</select>';
        }
    } else if (type === 'multi-select') {
        var selectedValues = (Array.isArray(value) ? value : (value === '' || value == null ? [] : [value])).map(String);
        if (field.widget === 'checkboxes' || field.style === 'checkboxes') {
            // Vertical checkbox list — opt-in, better for long option labels
            html += '<div class="prompt-checklist" data-field-name="' + escapeHtml(name) + '" data-field-type="multi-select"' + (options.length ? reqAttr : '') + '>';
            options.forEach(function(opt) {
                var optVal = typeof opt === 'object' ? opt.value : opt;
                var optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                var checked = selectedValues.indexOf(String(optVal)) >= 0 ? ' checked' : '';
                html += '<label class="prompt-field-checkbox"><input type="checkbox" class="prompt-field-check" data-value="' + escapeHtml(String(optVal)) + '"' + checked + ' onchange="promptClearInvalid(this)"> <span>' + escapeHtml(String(optLabel)) + '</span></label>';
            });
            html += '</div>';
        } else {
            // Checkbox chips — one click per toggle (replaces ctrl-click native multi-select)
            html += '<div class="prompt-chip-group" data-field-name="' + escapeHtml(name) + '" data-field-type="multi-select"' + (options.length ? reqAttr : '') + '>';
            options.forEach(function(opt) {
                var optVal = typeof opt === 'object' ? opt.value : opt;
                var optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                var selected = selectedValues.indexOf(String(optVal)) >= 0 ? ' selected' : '';
                html += '<button type="button" class="prompt-chip prompt-chip-multi' + selected + '" data-value="' + escapeHtml(String(optVal)) + '" onclick="promptToggleChip(this)">' + escapeHtml(String(optLabel)) + '</button>';
            });
            html += '</div>';
        }
    } else if (type === 'boolean') {
        // Toggle switch — single click, label rendered once
        html += '<label class="prompt-switch-row"><span class="prompt-switch-label">' + escapeHtml(label) + '</span>' +
            '<span class="prompt-switch"><input type="checkbox" data-field-name="' + escapeHtml(name) + '" data-field-type="boolean"' + (value ? ' checked' : '') + '>' +
            '<span class="prompt-switch-track"><span class="prompt-switch-thumb"></span></span></span></label>';
    } else if (type === 'number') {
        html += '<input type="number" class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="number" value="' + escapeHtml(String(value)) + '"' + required + reqAttr + clearInvalid + placeholder + '>';
    } else if (type === 'date') {
        html += '<input type="date" class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="date" value="' + escapeHtml(String(value)) + '"' + required + reqAttr + clearInvalid + '>';
    } else {
        // text (default)
        html += '<input type="text" class="prompt-field-input" data-field-name="' + escapeHtml(name) + '" data-field-type="text" value="' + escapeHtml(String(value)) + '"' + required + reqAttr + clearInvalid + placeholder + '>';
    }

    html += '<div class="prompt-field-error">This field is required</div></div>';
    return html;
}

// ─── Chip / pill / validation helpers ───
function promptPickPill(btn) {
    var group = btn.closest('.prompt-chip-group');
    if (!group) return;
    group.querySelectorAll('.prompt-chip').forEach(function(c) { c.classList.remove('selected'); });
    btn.classList.add('selected');
    promptClearInvalid(btn);
    promptCaptureDraft(btn); // RES-5: chip clicks don't fire input/change on the form
}

function promptToggleChip(btn) {
    btn.classList.toggle('selected');
    promptClearInvalid(btn);
    promptCaptureDraft(btn); // RES-5: chip clicks don't fire input/change on the form
}

// ─── RES-5: draft persistence across re-renders ───
// renderMessages() rebuilds the transcript from chat state — a FULL innerHTML
// rebuild whenever any non-tail row changes (e.g. a sub-agent's live
// sub_report card updating ABOVE a pending form; the R1 incremental fast path
// in 250-message-render.js only covers tail changes/appends). The pending
// form's DOM is recreated from msg.fields, so anything the user had typed
// would be lost. Capture the live form values back onto msg.fields[].value on
// every input/change (and chip/pill click) — renderPromptField already
// initializes every field type from field.value, so any re-render re-mounts
// the form with the draft intact. Collection mirrors submitPromptUser's
// per-type logic, minus validation. Works for the inline form and the
// background popup (both build fields via renderPromptField). No-ops once the
// prompt is no longer pending.
function promptCaptureDraft(el) {
    var form = (el && el.tagName === 'FORM') ? el : (el && el.closest ? el.closest('form') : null);
    if (!form || !form.id || form.id.indexOf('prompt-form-') !== 0) return;
    var promptId = form.id.slice('prompt-form-'.length);
    var msg = null;
    var chat = chats[currentChatId];
    if (chat && chat.messages) {
        for (var i = 0; i < chat.messages.length; i++) {
            if (chat.messages[i].role === 'prompt_user' && chat.messages[i].promptId === promptId) { msg = chat.messages[i]; break; }
        }
    }
    if (!msg) {
        // Background-popup case: the form belongs to a non-current chat.
        for (var cid in chats) {
            var c = chats[cid];
            if (!c || !c.messages) continue;
            for (var j = 0; j < c.messages.length; j++) {
                if (c.messages[j].role === 'prompt_user' && c.messages[j].promptId === promptId) { msg = c.messages[j]; break; }
            }
            if (msg) break;
        }
    }
    if (!msg || msg.status !== 'pending' || !Array.isArray(msg.fields)) return;
    var drafts = {};
    form.querySelectorAll('[data-field-name]').forEach(function(fel) {
        var type = fel.getAttribute('data-field-type');
        var val;
        if (type === 'boolean') {
            val = fel.checked;
        } else if (type === 'multi-select') {
            if (fel.tagName === 'SELECT') {
                val = [].slice.call(fel.selectedOptions).map(function(o) { return o.value; });
            } else {
                val = [].slice.call(fel.querySelectorAll('.prompt-chip.selected, input[type="checkbox"]:checked')).map(function(c) { return c.getAttribute('data-value'); });
            }
        } else if (type === 'select' && fel.tagName !== 'SELECT') {
            var picked = fel.querySelector('.prompt-chip.selected');
            val = picked ? picked.getAttribute('data-value') : '';
        } else {
            val = fel.value;
        }
        drafts[fel.getAttribute('data-field-name')] = val;
    });
    msg.fields.forEach(function(f) {
        if (f && f.name && Object.prototype.hasOwnProperty.call(drafts, f.name)) f.value = drafts[f.name];
    });
}

function promptClearInvalid(el) {
    var wrap = el.closest('.prompt-field');
    if (wrap) wrap.classList.remove('invalid');
    // Hide the form-level notice once no invalid fields remain
    var form = el.closest('form');
    if (form && !form.querySelector('.prompt-field.invalid')) {
        var notice = form.querySelector('.prompt-validation-notice');
        if (notice) notice.remove();
    }
}
