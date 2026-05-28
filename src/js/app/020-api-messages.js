function buildAPIMessages(chatMessages, chatId) {
    // Clone messages to avoid mutating originals
    var cloned = chatMessages.map(function(m) { return Object.assign({}, m); });

    // Helper: substitute a cache reference for any user message content that exceeds
    // the cache limit. Mirrors how oversized tool results are cached. Mutates the
    // ORIGINAL message (not the clone) to persist the cachedContentId across renders.
    function maybeCacheUserContent(originalMsg, content) {
        if (typeof content !== 'string') return content;
        if (typeof processUserMessageForCache !== 'function') return content;
        if (!chatId) return content;
        // Already cached on a previous turn? Reuse the existing reference.
        if (originalMsg && originalMsg.cachedContentId) {
            var chat = chats[chatId];
            if (chat && chat.cachedToolResults && chat.cachedToolResults[originalMsg.cachedContentId]) {
                var existing = chat.cachedToolResults[originalMsg.cachedContentId];
                var sizeKB = Math.round((existing.size || content.length) / 1024);
                var limitKB = Math.round((typeof getCacheCharLimit === 'function' ? getCacheCharLimit() : 16000) / 1024);
                var totalLines = (existing.fullContent || content).split('\n').length;
                return '[User pasted a long message — cached]\n' + JSON.stringify({
                    _cached_user_message: {
                        message: 'USER MESSAGE CACHED: ' + sizeKB + 'KB, ' + totalLines + ' lines (limit: ' + limitKB + 'KB). Use cached_content_read/search/outline with content_id "' + originalMsg.cachedContentId + '".',
                        content_id: originalMsg.cachedContentId,
                        size: sizeKB + 'KB',
                        totalLines: totalLines
                    }
                }, null, 2);
            }
        }
        var cached = processUserMessageForCache(chatId, content);
        if (!cached) return content;
        if (originalMsg) originalMsg.cachedContentId = cached.contentId;
        // Persist the new cachedContentId on the chat
        try { if (typeof saveChatsToStorage === 'function') saveChatsToStorage(); } catch (e) {}
        return cached.apiContent;
    }

    var result = cloned.map(function(m, idx) {
        var original = chatMessages[idx];
        if (m.role === 'user') return { role: 'user', content: maybeCacheUserContent(original, m.content) };
        if (m.role === 'assistant') {
            var msg = { role: 'assistant' };
            if (m.content) msg.content = m.content;
            if (m.tool_calls) msg.tool_calls = m.tool_calls;
            // Only include reasoning_details when the NEXT message is a tool result (tool-use loop).
            // The API requires thinking blocks to be sent back unchanged during tool-use continuations,
            // but they're automatically stripped on normal user turns — sending old thinking wastes tokens.
            if (m.reasoning_details && m.reasoning_details.length > 0) {
                var myIdx = cloned.indexOf(m);
                var nextMsg = myIdx >= 0 && myIdx < cloned.length - 1 ? cloned[myIdx + 1] : null;
                if (nextMsg && nextMsg.role === 'tool') {
                    msg.reasoning_details = m.reasoning_details;
                }
            }
            // Skip empty assistant messages (streaming placeholders) - they have no content,
            // no tool_calls, and no reasoning. Sending them causes hangs with image+tool combos.
            if (!msg.content && !msg.tool_calls && !msg.reasoning_details) return null;
            return msg;
        }
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
        if (m.role === 'browser_context') return { role: 'user', content: '[Browser Context] The user is viewing a page in the embedded browser at URL: ' + m.url + '. When they ask about "this page" or "the page", they are referring to this URL.' };
        // Handle screenshot messages - convert to multimodal user message with image
        if (m.role === 'screenshot') {
            var screenshotLabel = m.name || m.description || 'screenshot';
            return {
                role: 'user',
                content: [
                    { type: 'text', text: '[Screenshot captured: ' + screenshotLabel + (m.width && m.height ? ' (' + m.width + 'x' + m.height + ')' : '') + ']\nAnalyze this image to help the user. Describe what you see and identify any issues, UI elements, or relevant details.' },
                    { type: 'image_url', image_url: { url: m.base64 } }
                ]
            };
        }
        // Handle PDF messages - send full file every time, don't rewrite history
        if (m.role === 'pdf') {
            var pdfLabel = m.name || m.description || 'document.pdf';
            var pdfFilename = pdfLabel.endsWith('.pdf') ? pdfLabel : pdfLabel + '.pdf';
            return {
                role: 'user',
                content: [
                    { type: 'text', text: '[PDF attached: ' + pdfLabel + ']' },
                    { type: 'file', file: { filename: pdfFilename, file_data: m.base64 } }
                ]
            };
        }
        // Handle file attachments (spreadsheets, etc.) - inform Agent to use read_attached_file tool
        if (m.role === 'file') {
            var fileLabel = m.name || 'file';
            var fileSize = m.size ? ' (' + formatFileSize(m.size) + ')' : '';
            var fileIdNote = m.file_id ? ' (file_id: ' + m.file_id + ')' : '';
            return {
                role: 'user',
                content: '[File attached: ' + fileLabel + fileSize + fileIdNote + ']\nUse the read_attached_file tool or get_file tool to read this file\'s content.'
            };
        }
        // Handle context messages (document references, etc.)
        if (m.role === 'context') return { role: 'user', content: maybeCacheUserContent(original, m.content) };
        // sub_report rows are a UI-only callout in the parent transcript:
        // they record what a sub-agent told the parent via report_to_parent /
        // agent_message-to-parent. The same payload reaches the parent model
        // through await_handle's tool result (terminal reports) — echoing it
        // here would double-feed and break the strict assistant↔tool turn
        // alternation when injected mid tool-result chain. Drop them.
        if (m.role === 'sub_report') return null;
        return null;
    }).filter(Boolean);

    // Anthropic invariant: no two consecutive user messages (strict role
    // alternation). Sub-agent chats can break this when (a) spawn_sub_agent
    // creates a chat with [user(task)] and the pool is full, then
    // agent_message pushes another user message before the loop ever runs,
    // or (b) wakeSubAgent drains the inbox onto a chat whose last message
    // was already a user row. Parent chats can also break it when a
    // sub_report row (dropped above) was sandwiched between two user rows.
    // Merge consecutive same-role string-content user messages into a
    // single concatenated message so the API request stays well-formed.
    var merged = [];
    for (var mi = 0; mi < result.length; mi++) {
        var cur = result[mi];
        var prev = merged.length ? merged[merged.length - 1] : null;
        if (prev && prev.role === 'user' && cur.role === 'user'
            && typeof prev.content === 'string' && typeof cur.content === 'string') {
            prev.content = prev.content + '\n\n' + cur.content;
            continue;
        }
        merged.push(cur);
    }
    return merged;
}

// Single source of truth for the pause button's visible label. Read pause state
// for the given chat and set the button HTML accordingly. Idempotent — safe to
// call from any cleanup or render site without thinking about previous state.
function syncPauseButtonUI(chatId) {
    var pauseBtn = document.getElementById('pause-btn');
    if (!pauseBtn) return;
    var id = chatId || currentChatId;
    // Per-chat: do NOT consult global `paused` — it would mislabel the button on a
    // chat that was never paused, just because some other chat was paused earlier.
    var isPaused = !!(id && pausedChats[id] === true);
    pauseBtn.innerHTML = isPaused
        ? '<span class="btn-icon">' + UI_ICONS.play + '</span>Resume'
        : '<span class="btn-icon">' + UI_ICONS.pause + '</span>Pause';
}

function togglePause() {
    // Per-chat pause: only halts the chat the user is currently looking at, not
    // every running chat (background Action chats stay running). The global `paused`
    // is kept in sync with the foreground chat for legacy UI bits that still read it.
    var chatId = currentChatId;
    if (!chatId) return;
    // Per-chat ONLY. Do NOT read the legacy global `paused` here — if another chat
    // was paused earlier, this chat would inherit that flag and Resume would fire
    // a fresh runAgent() the user never asked for (B-2).
    var wasPaused = pausedChats[chatId] === true;
    var nowPaused = !wasPaused;
    pausedChats[chatId] = nowPaused;
    // Mirror foreground state into the legacy global so legacy reads (after-response
    // hooks, browser-notification gate) reflect the focused chat. Background chats
    // that pause/resume independently do NOT touch the global — their loops only
    // consult `pausedChats[chatId]` via `isChatPaused`.
    paused = nowPaused;
    syncPauseButtonUI(chatId);

    if (nowPaused) {
        // Stop the in-flight stream / tool immediately so Pause feels responsive.
        // The agent loop catches the AbortError as a user-abort, drops the partial
        // assistant message, then exits cleanly because pausedChats[chatId] is now true
        // (the loop's `while (!isChatPaused(chatId))` condition fails next iteration).
        // POST-OFFSCREEN-RELOCATION: the stream / interrupt resolvers live in the
        // offscreen runtime, not on this page — the maps below are empty in the
        // page bundle. We still call them defensively (no-ops) AND push the
        // pause state over the bus so offscreen aborts on its side.
        var ac = currentStreamAbortControllers[chatId];
        if (ac && typeof ac.abort === 'function') {
            try { ac.abort(); } catch (e) {}
        }
        var interruptFn = interruptResolversByChatId[chatId];
        if (typeof interruptFn === 'function') {
            try { interruptFn(); } catch (e) {}
        }
        if (typeof pushPauseToggleToOffscreen === 'function') {
            pushPauseToggleToOffscreen(chatId, true);
        }
        if (typeof pushInterruptToOffscreen === 'function') {
            pushInterruptToOffscreen(chatId, false);
        }
        // B-A2: also unblock any approval the loop is parked on. Without this,
        // pausing a chat that's awaiting tool approval is a no-op — the loop stays
        // parked on the resolver promise, and Resume can't re-enter because the
        // original loop never exited (early-return in runAgent on runningChatIds).
        // Resolve with `false` (denied) so the loop falls through to its next pause
        // check and exits cleanly. Inline approval messages remain `pending` in the
        // transcript so the user can re-approve after Resume.
        rejectPendingApprovalsForChat(chatId);
        return;
    }

    // Resuming: tell offscreen the pause flag is cleared, then kick off
    // a fresh run via the shim if this chat isn't already known-running.
    if (typeof pushPauseToggleToOffscreen === 'function') {
        pushPauseToggleToOffscreen(chatId, false);
    }
    if (wasPaused && !nowPaused && !runningChatIds[chatId]) {
        runAgent();
    }
}

function showPauseButton(chatId) {
    var pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.classList.add('visible');
    // Always sync the label when revealing — prevents stale "Pause" leaking in when
    // the chat is actually paused (e.g. cross-tab navigation back to a paused chat).
    // Forward the explicit chatId so callers that haven't yet updated `currentChatId`
    // (e.g. selectChat reveals the new chat's pause state BEFORE assigning currentChatId)
    // get the correct label. Without this, syncPauseButtonUI's `chatId || currentChatId`
    // fallback reads the stale-previous chat's pausedChats flag and mislabels the button.
    syncPauseButtonUI(chatId);
    // Pause and Continue are mutually exclusive — only one can be shown at a time.
    hideContinueButton();
}

function hidePauseButton() {
    var pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.classList.remove('visible');
}

function showRetryButton() {
    var retryBtn = document.getElementById('retry-btn');
    if (retryBtn) retryBtn.classList.add('visible');
}

function hideRetryButton() {
    var retryBtn = document.getElementById('retry-btn');
    if (retryBtn) retryBtn.classList.remove('visible');
}

function showContinueButton() {
    var btn = document.getElementById('continue-btn');
    if (btn) btn.classList.add('visible');
    // Pause and Continue are mutually exclusive.
    hidePauseButton();
}

function hideContinueButton() {
    var btn = document.getElementById('continue-btn');
    if (btn) btn.classList.remove('visible');
}

function retryLastCall() {
    if (!lastApiError) return;
    // Target the chat that actually errored, not whatever the user is
    // currently looking at. Without this, retrying a 429 after the user
    // switched chats kicks runAgent on the wrong chat (no-op for the
    // error context, surprise loop on the other).
    var targetChatId = lastApiError.chatId || currentChatId;
    hideRetryButton();
    // Continue and Retry can both be visible after an errored runFinished
    // (the handler shows Continue when the chat is interrupted). If Retry
    // doesn't dismiss Continue, the user clicks Retry, sees nothing change
    // (Continue still sitting there, no spinner), and clicks Continue
    // assuming Retry was broken. Mirror continueAgent: hide both.
    hideContinueButton();
    lastApiError = null;
    // Defensive paused-state reset — matches continueAgent. A 429 itself
    // doesn't set pausedChats, but if a stale pause flag survives from
    // earlier in the session, runAgent's `while (!isChatPaused)` gate
    // trips immediately and the retry silently no-ops. This is the
    // single difference that made Continue "work" where Retry didn't.
    paused = false;
    if (targetChatId && typeof pausedChats !== 'undefined') {
        pausedChats[targetChatId] = false;
    }
    if (typeof syncPauseButtonUI === 'function') {
        syncPauseButtonUI(targetChatId);
    }
    // Fire immediately. The previous 1000ms setTimeout gave no visible
    // feedback and made Retry feel dead — by the time the loop kicked
    // off, the user had already clicked Continue. The SW-side run-agent
    // handler is idempotent (early-returns when runningChatIds[chat] is
    // set), so there's no double-loop risk if the user double-clicks.
    runAgent(targetChatId);
}

// Continue an interrupted run (e.g. after a page reload mid-stream).
// Behaves the same as retryLastCall but doesn't depend on lastApiError —
// the agent loop's own interrupted-tool-call logic stitches the conversation
// back together.
function continueAgent() {
    hideContinueButton();
    hideRetryButton();
    lastApiError = null;
    paused = false;
    // Defensive: skip if no chat is selected. (`pausedChats` is module-level and
    // always defined — the previous `&& pausedChats` guard was dead code.)
    if (!currentChatId) return;
    pausedChats[currentChatId] = false;
    // Use the single source of truth for the label rather than a manual innerHTML
    // write — keeps every render path consistent (e.g. if syncPauseButtonUI is
    // ever extended with extra state, continueAgent picks it up for free).
    syncPauseButtonUI(currentChatId);
    runAgent();
}

// B-A2: resolve any pending approval promise for the given chat with `false` so
// a parked agent loop can exit cleanly when the user pauses. The approval message
// in the transcript is mutated to `denied` so the inline render and the resulting
// tool_result are consistent (otherwise the inline block stays `pending` while
// the agent sees a denial — confusing for the user). The inline block keeps the
// approval as part of the conversation history so the user has a record of what
// was queued and abandoned.
function rejectPendingApprovalsForChat(chatId) {
    if (!chatId || typeof pendingToolApprovals !== 'object') return;
    var keys = Object.keys(pendingToolApprovals);
    var chat = chats[chatId];
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var entry = pendingToolApprovals[k];
        if (!entry || entry.chatId !== chatId) continue;
        // Mark the inline message denied (with a marker so we can distinguish
        // pause-driven denials from explicit user denials in future code).
        if (chat && chat.messages && chat.messages[entry.approvalIndex]) {
            var m = chat.messages[entry.approvalIndex];
            if (m && m.role === 'approval' && m.status === 'pending') {
                m.status = 'denied';
                m.deniedByPause = true;
                changed = true;
            }
        }
        try { entry.resolve(false); } catch (e) {}
        delete pendingToolApprovals[k];
    }
    if (changed && typeof saveChatsToStorage === 'function') {
        try { saveChatsToStorage(); } catch (e) {}
    }
}

// Detect whether a chat looks like it was interrupted mid-stream.
// True when: there's no active agent loop for this chat AND the conversation
// ends in a state that needs the agent to take another turn (streaming flag
// still set, dangling tool calls, trailing user/tool message, etc.).
//
// Auxiliary attachment roles (screenshot/pdf/file/context/browser_context) are
// transcript-only — they're appended after a user/tool/assistant turn and don't
// themselves indicate a turn boundary. The deferredScreenshots batch in
// `runAgent` (`56-agent-loop.js:701-708`) pushes them AFTER tool results, so an
// interrupted run can leave the chat ending on an aux role. Walk backward past
// aux roles to find the last "real" message, then apply the standard logic.
var _AUX_ROLES_FOR_INTERRUPTION = ['screenshot', 'pdf', 'file', 'context', 'browser_context'];
function isChatInterrupted(chat) {
    if (!chat || !chat.id || !Array.isArray(chat.messages) || chat.messages.length === 0) return false;
    if (typeof runningChatIds !== 'undefined' && runningChatIds[chat.id]) return false;
    var msgs = chat.messages;
    // Walk back past auxiliary attachment roles. If the chat is entirely aux
    // (impossible in practice — always preceded by a user msg — but defensive),
    // treat as not interrupted.
    var lastIdx = msgs.length - 1;
    while (lastIdx >= 0 && _AUX_ROLES_FOR_INTERRUPTION.indexOf(msgs[lastIdx].role) >= 0) lastIdx--;
    if (lastIdx < 0) return false;
    var last = msgs[lastIdx];
    if (last.role === 'user') return true;
    if (last.role === 'tool') return true;
    if (last.role === 'assistant') {
        if (last.isStreaming) return true;
        if (last.tool_calls && last.tool_calls.length > 0) {
            // Any tool_call without a matching tool result after this assistant message
            // means the loop didn't finish processing tools.
            for (var i = 0; i < last.tool_calls.length; i++) {
                var tcId = last.tool_calls[i].id;
                var found = false;
                // Search the range AFTER the assistant message for a matching tool result.
                // (Aux messages between lastIdx and msgs.length-1 are skipped naturally
                // because they have role !== 'tool'.)
                for (var j = msgs.length - 1; j > lastIdx; j--) {
                    var m = msgs[j];
                    if (m.role === 'tool' && m.tool_call_id === tcId) { found = true; break; }
                }
                if (!found) return true;
            }
        }
    }
    return false;
}

// Show the Continue button if the chat is interrupted, otherwise hide it.
// Call this when entering a chat or after init to surface the Continue affordance.
function refreshContinueButtonForChat(chatId) {
    if (!chatId || typeof chats === 'undefined' || !chats[chatId]) {
        hideContinueButton();
        return;
    }
    if (isChatInterrupted(chats[chatId])) {
        showContinueButton();
    } else {
        hideContinueButton();
    }
}
