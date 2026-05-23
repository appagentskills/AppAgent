// Map of chatId -> bool: true if the document was hidden at any point during the
// chat's current agent run. Drives the "Agent finished" browser notification so
// it still fires when the user came back to read the streaming reply right
// before the loop ended. Populated at run-start + on every visibilitychange,
// cleared when the finish-notification check consumes it.
var _hiddenDuringRun = {};
function _markAllRunningHidden() {
    if (typeof runningChatIds !== 'object' || !runningChatIds) return;
    for (var _cid in runningChatIds) {
        if (runningChatIds[_cid]) _hiddenDuringRun[_cid] = true;
    }
}
if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) _markAllRunningHidden();
    });
}
// Chrome side panels stay document-visible when the user switches windows, so
// also treat "window lost focus" as away. document.hasFocus() is checked at
// run-start too (below).
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('blur', _markAllRunningHidden);
}

// Race executeTool against the user-interrupt flag so a long-running tool can be
// abandoned the instant the user sends a new message. The orphan promise keeps
// running in the background and its result is discarded — the agent loop pushes
// a placeholder tool_result and moves on with the user's queued message.
function executeToolWithInterrupt(streamingChatId, toolName, args, assistantMsgIndex, opts) {
    var toolPromise = executeTool(toolName, args, assistantMsgIndex, opts);
    if (!streamingChatId) return toolPromise;
    return new Promise(function(resolve, reject) {
        var settled = false;
        // Event-driven interrupt: sendMessage() will call this resolver directly,
        // so the agent loop unblocks the moment the user presses send (no polling delay).
        var resolverFn = function() {
            if (settled) return;
            settled = true;
            if (interruptResolversByChatId[streamingChatId] === resolverFn) {
                delete interruptResolversByChatId[streamingChatId];
            }
            resolve({ _interrupted: true });
        };
        interruptResolversByChatId[streamingChatId] = resolverFn;
        // Defensive: in case the flag was already set before we registered (race), check now.
        if (userInterruptedChats[streamingChatId]) {
            var fn = interruptResolversByChatId[streamingChatId];
            if (fn) fn();
            return;
        }
        toolPromise.then(function(r) {
            if (settled) return;
            settled = true;
            delete interruptResolversByChatId[streamingChatId];
            resolve(r);
        }, function(e) {
            if (settled) return;
            settled = true;
            delete interruptResolversByChatId[streamingChatId];
            reject(e);
        });
    });
}

// Inject placeholder results for any tool calls that were interrupted (orphan tool_use without tool_result)
function injectInterruptedToolResults(chat) {
    if (!chat || !chat.messages) return false;

    var injected = false;
    for (var i = 0; i < chat.messages.length; i++) {
        var msg = chat.messages[i];
        if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue;

        for (var j = 0; j < msg.tool_calls.length; j++) {
            var tc = msg.tool_calls[j];
            var hasResult = false;

            // Look for matching tool result after this message
            for (var k = i + 1; k < chat.messages.length; k++) {
                if (chat.messages[k].role === 'tool' && chat.messages[k].tool_call_id === tc.id) {
                    hasResult = true;
                    break;
                }
            }

            if (!hasResult) {
                // Skip tool calls that have a pending prompt_user (user hasn't submitted yet)
                var hasPendingPrompt = false;
                for (var p = 0; p < chat.messages.length; p++) {
                    if (chat.messages[p].role === 'prompt_user' && chat.messages[p].toolCallId === tc.id && chat.messages[p].status === 'pending') {
                        hasPendingPrompt = true;
                        break;
                    }
                }
                if (hasPendingPrompt) continue;

                // Inject placeholder result for this orphan tool call
                chat.messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: tc.function ? tc.function.name : 'unknown',
                    content: '[Tool call interrupted by user - no result available]'
                });
                // Clear streaming state on the interrupted message
                msg.isStreaming = false;
                injected = true;
            }
        }
    }
    return injected;
}

// Flush a pending user injection (text + images) into the chat.
// Per-chat: only consumes a queue that was actually destined for THIS chat.
// The globals (`pendingInjection` / `pendingInjectionImages`) are kept in sync
// for the foreground stream so legacy UI code keeps working, but they are NOT
// consulted when the per-chat entry is missing — otherwise a background chat's
// loop would steal the foreground chat's queued message.
function flushPendingInjection(chat) {
    var chatId = chat && chat.id;
    var entry = chatId ? pendingInjectionsByChatId[chatId] : null;
    var text, images;
    if (entry) {
        text = entry.text;
        images = entry.images;
    } else if (chatId && chatId === activeStreamingChatId) {
        // Foreground stream and no per-chat entry yet — the globals belong to it.
        text = pendingInjection;
        images = pendingInjectionImages;
    } else {
        return false;
    }
    if (!text && (!images || images.length === 0)) return false;
    if (text) {
        chat.messages.push({ role: 'user', content: text });
    }
    if (images && images.length > 0) {
        images.forEach(function(img) {
            if (img.fileType === 'document') {
                chat.messages.push({
                    role: 'context',
                    content: '[User referenced Smart Document "' + (img.name || 'Untitled') + '" (doc_id: ' + img.sdocId + '). Use the document tool with action "read" and this doc_id to access its content.]'
                });
                return;
            }
            var _fid = img.file_id || newFileId();
            if (img.fileType === 'pdf') {
                chat.messages.push({ role: 'pdf', base64: img.base64, name: img.name, description: 'User attached PDF', timestamp: Date.now(), file_id: _fid });
            } else if (img.fileType === 'file') {
                chat.messages.push({ role: 'file', content: img.content, name: img.name, mimeType: img.mimeType, size: img.size, description: 'User attached file', timestamp: Date.now(), file_id: _fid });
            } else {
                chat.messages.push({ role: 'screenshot', base64: img.base64, name: img.name, description: 'User attached image', timestamp: Date.now(), width: img.width, height: img.height, file_id: _fid });
            }
            registerFile(_fid, { type: 'chat', chatId: chat.id, msgIndex: chat.messages.length - 1 });
        });
    }
    if (chatId) delete pendingInjectionsByChatId[chatId];
    // Only clear the globals if they belong to THIS chat (foreground stream).
    // Otherwise another chat's queue is sitting in the globals — don't drop it.
    if (chatId === activeStreamingChatId || !entry) {
        pendingInjection = null;
        pendingInjectionImages = null;
    }
    return true;
}

// Execute any approved tool calls that don't have a corresponding result yet
// Normalize tool args after JSON.parse: fix string-ified arrays/objects
// The Anthropic API sometimes delivers array/object params as strings,
// with trailing XML parameter tags bleeding into the value.
function normalizeToolArgs(args) {
    if (!args || typeof args !== 'object') return args;
    var xmlTagRe = new RegExp('\\n?' + '<' + 'param' + 'eter[\\s\\S]*', 'i');
    for (var key in args) {
        if (!args.hasOwnProperty(key)) continue;
        var val = args[key];
        if (typeof val !== 'string') continue;
        var trimmed = val.trim();
        // Only attempt parse on values that look like JSON arrays or objects
        if ((trimmed[0] === '[' && trimmed.indexOf(']') > -1) || (trimmed[0] === '{' && trimmed.indexOf('}') > -1)) {
            var cleaned = val.replace(xmlTagRe, '').trim();
            try { args[key] = JSON.parse(cleaned); } catch (e) {
                // Retry with control char sanitization
                try {
                    var sanitized = cleaned.replace(/[\x00-\x1f]/g, function(ch) {
                        return ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
                    });
                    args[key] = JSON.parse(sanitized);
                } catch (e2) { /* leave as string */ }
            }
        }
    }
    return args;
}

async function executePendingApprovedTools(chat) {
    if (!chat || !chat.messages) return;
    
    // Find approved tool calls that don't have a corresponding tool result
    for (var i = 0; i < chat.messages.length; i++) {
        var msg = chat.messages[i];
        if (msg.role !== 'approval') continue;
        if (msg.status !== 'allowed' && msg.status !== 'session_allowed' && msg.status !== 'always_allowed') continue;
        // Skip programmatic tool calls (from js_eval chaining) - they're handled internally
        if (msg.toolCallId && msg.toolCallId.startsWith('prog_')) continue;
        
        // Check if there's already a tool result for this tool call
        var hasResult = false;
        for (var j = i + 1; j < chat.messages.length; j++) {
            if (chat.messages[j].role === 'tool' && chat.messages[j].tool_call_id === msg.toolCallId) {
                hasResult = true;
                break;
            }
        }
        
        if (!hasResult) {
            // Execute this pending tool
            var toolName = msg.actualToolName || msg.toolName;
            var args = msg.args;
            
            // Find the assistant message index
            var assistantMsgIndex = -1;
            for (var k = i - 1; k >= 0; k--) {
                if (chat.messages[k].role === 'assistant' && chat.messages[k].tool_calls) {
                    assistantMsgIndex = k;
                    break;
                }
            }
            
            showSpinner('Executing ' + msg.toolName + '...', chat && chat.id);
            try {
                // executeTool checks for existing approval via requestProgrammaticToolApproval
                var result = await executeTool(toolName, args, assistantMsgIndex, { toolCallId: msg.toolCallId, chatId: chat.id });
                hideSpinner(chat && chat.id);

                var processed = processToolResultForCache(chat.id, msg.toolCallId, toolName, result);
                chat.messages.push({
                    role: 'tool',
                    tool_call_id: msg.toolCallId,
                    name: toolName,
                    content: processed.content
                });
                saveChatsToStorage();
                renderMessages();
            } catch (e) {
                hideSpinner(chat && chat.id);
                chat.messages.push({
                    role: 'tool',
                    tool_call_id: msg.toolCallId,
                    name: toolName,
                    content: JSON.stringify({ success: false, error: e.message })
                });
                saveChatsToStorage();
                renderMessages();
            }
        }
    }
}

async function runAgent(overrideChatId) {
    // If an override chatId is provided (e.g. background Action chat), run the loop on that chat
    // WITHOUT navigating the PM away from their current chat.
    var streamingChatId = overrideChatId || currentChatId;
    // Per-chat concurrency: block only if THIS chat is already running.
    if (runningChatIds[streamingChatId]) return;
    runningChatIds[streamingChatId] = true;
    // Track whether the document was hidden at any point during this run, so the
    // "Agent finished" notification still fires if the user came back to read the
    // streaming reply right before the loop ended. document.hidden at finish-time
    // alone is too narrow — the approval popup wins this race because it fires
    // immediately, while finish fires after the user has likely returned.
    _hiddenDuringRun[streamingChatId] = !!document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
    // Refresh chat list so the streaming indicator appears immediately on this chat.
    if (typeof renderChatList === 'function') renderChatList();
    // try/finally guarantees the per-chat running flag is cleared even if the
    // body throws — without this, an uncaught error would leave the streaming
    // dot spinning forever AND block future sends via the early-return at top.
    try {
    var chat = chats[streamingChatId];
    var isBackgroundRun = !!(chat && chat.isBackground);

    // UI-state globals only apply when the currently-viewed chat is the one streaming
    if (!isBackgroundRun || streamingChatId === currentChatId) {
        isRunning = true;
        isFollowingStreamingScroll = true; // Reset scroll tracking
        lastApiError = null; // Clear any previous error
        hideRetryButton(); // Hide retry button when starting new run
        hideContinueButton(); // Hide continue button when actually running
        showPauseButton();
        var messagesEl = document.getElementById('messages');
        if (messagesEl) messagesEl.classList.add('is-streaming');
        activeStreamingChatId = streamingChatId; // Set focused-stream tracker for navigation handling
    } else {
        // Background chat running while PM views a different chat — don't touch foreground UI flags
        lastApiError = null;
    }

    // Execute any approved tool calls that don't have results yet
    await executePendingApprovedTools(chat);
    
    // Track aggregate metrics across all API calls in this run
    // Initialize from existing messages to preserve stats across page reloads
    var callNumber = 0;
    var aggregateMetrics = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        cost: 0,
        duration: 0,
        callCount: 0
    };
    
    // Find the last user message index to determine current conversation turn
    var lastUserMsgIndex = -1;
    for (var mi = chat.messages.length - 1; mi >= 0; mi--) {
        if (chat.messages[mi].role === 'user') {
            lastUserMsgIndex = mi;
            break;
        }
    }
    
    // Accumulate metrics from assistant messages in this turn (after last user message)
    // This preserves stats when continuing after page reload
    if (lastUserMsgIndex >= 0) {
        for (var mi = lastUserMsgIndex + 1; mi < chat.messages.length; mi++) {
            var m = chat.messages[mi];
            if (m.role === 'assistant' && m.metrics && !m.isSummary) {
                aggregateMetrics.callCount++;
                aggregateMetrics.input_tokens += m.metrics.input_tokens || 0;
                aggregateMetrics.output_tokens += m.metrics.output_tokens || 0;
                aggregateMetrics.cache_read_tokens += m.metrics.cache_read_tokens || 0;
                aggregateMetrics.cache_creation_tokens += m.metrics.cache_creation_tokens || 0;
                aggregateMetrics.cache_write_tokens += m.metrics.cache_write_tokens || 0;
                aggregateMetrics.reasoning_tokens += m.metrics.reasoning_tokens || 0;
                aggregateMetrics.cost += m.metrics.cost || 0;
                aggregateMetrics.duration += m.metrics.duration || 0;
                callNumber = Math.max(callNumber, m.metrics.callNumber || 0);
            }
        }
    }

    // Initialize scroll flag based on current position before streaming starts
    isFollowingScroll = isNearBottom();
    
    // Check if there are unprocessed tool calls from a previous pause
    // Find the last assistant message with tool_calls and check which ones need processing
    var pendingToolCalls = null;
    var pendingAssistantMsgIndex = -1;
    for (var pi = chat.messages.length - 1; pi >= 0; pi--) {
        var pm = chat.messages[pi];
        if (pm.role === 'user') break; // Stop at last user message
        if (pm.role === 'assistant' && pm.tool_calls && pm.tool_calls.length > 0 && !pm.isSummary) {
            // Check which tool calls don't have results yet
            var unprocessed = [];
            for (var pti = 0; pti < pm.tool_calls.length; pti++) {
                var ptc = pm.tool_calls[pti];
                var hasResult = false;
                for (var pri = pi + 1; pri < chat.messages.length; pri++) {
                    if (chat.messages[pri].role === 'tool' && chat.messages[pri].tool_call_id === ptc.id) {
                        hasResult = true;
                        break;
                    }
                }
                if (!hasResult) {
                    unprocessed.push({ tc: ptc, index: pti });
                }
            }
            if (unprocessed.length > 0) {
                pendingToolCalls = unprocessed;
                pendingAssistantMsgIndex = pi;
            }
            break;
        }
    }
    
    // Process pending tool calls from previous pause first
    if (pendingToolCalls && pendingToolCalls.length > 0) {
        var assistantMsgIndex = pendingAssistantMsgIndex;
        var deferredScreenshots = [];

        for (var pci = 0; pci < pendingToolCalls.length; pci++) {
            if (isChatPaused(streamingChatId)) break;
            var tc = pendingToolCalls[pci].tc;
            var toolName = tc.function.name;
            var args;
            try {
                args = JSON.parse(tc.function.arguments || '{}');
                args = normalizeToolArgs(args);
            } catch (parseErr) {
                console.error('Failed to parse tool arguments:', tc.function.arguments, parseErr);
                chat.messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: toolName,
                    content: JSON.stringify({ success: false, error: 'Invalid tool arguments: ' + parseErr.message })
                });
                saveChatsToStorage();
                if (currentChatId === streamingChatId) renderMessages();
                continue;
            }

            var displayName = getToolDisplayName(toolName, args.method || args.action);
            showSpinner('Executing ' + displayName + '...', streamingChatId);
            var result = await executeToolWithInterrupt(streamingChatId, toolName, args, assistantMsgIndex, { toolCallId: tc.id, chatId: streamingChatId });
            hideSpinner(streamingChatId);

            // User-interrupt during pending-tool replay — abandon and exit.
            if (result && result._interrupted) {
                for (var rj = pci; rj < pendingToolCalls.length; rj++) {
                    var rjtc = pendingToolCalls[rj].tc;
                    chat.messages.push({
                        role: 'tool',
                        tool_call_id: rjtc.id,
                        name: rjtc.function ? rjtc.function.name : 'unknown',
                        content: '[Tool call abandoned — user sent a new message]'
                    });
                }
                userInterruptedChats[streamingChatId] = false;
                saveChatsToStorage();
                if (currentChatId === streamingChatId) renderMessages();
                break;
            }

            delete result._denied;
            var screenshotMsg = result._screenshotMessage;
            var screenshotMsgs = result._screenshotMessages;
            delete result._screenshotMessage;
            delete result._screenshotMessages;
            var processed = processToolResultForCache(streamingChatId, tc.id, toolName, result);
            chat.messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: toolName,
                content: processed.content
            });
            // Defer screenshot messages so they don't interleave between tool results
            if (screenshotMsg) deferredScreenshots.push(screenshotMsg);
            if (screenshotMsgs) screenshotMsgs.forEach(function(sm) { deferredScreenshots.push(sm); });
            saveChatsToStorage();
            if (currentChatId === streamingChatId) renderMessages();
        }
        // Push all screenshot messages after all tool results
        if (deferredScreenshots.length > 0) {
            deferredScreenshots.forEach(function(sm) {
                chat.messages.push(sm);
                var _fid = sm.file_id || sm.screenshot_id;
                if (_fid) registerFile(_fid, { type: 'chat', chatId: streamingChatId, msgIndex: chat.messages.length - 1 });
            });
            saveChatsToStorage();
            if (currentChatId === streamingChatId) renderMessages();
        }

        // Flush any user message/images injected during tool execution
        // Skip if paused — tool results may be incomplete (orphaned tool_use blocks)
        // The injection will be flushed after resuming and all pending tools complete
        // Per-chat pause check: don't consult global `paused` here, it would block
        // injection on chat A just because chat B is paused.
        if (!isChatPaused(streamingChatId) && flushPendingInjection(chat)) {
            saveChatsToStorage();
            if (currentChatId === streamingChatId) renderMessages();
        }

        if (isChatPaused(streamingChatId)) {
            // Paused during pending tool processing - exit cleanly
            hideSpinner(streamingChatId);
            isRunning = false;
            showSnackbar('Agent paused. Click Resume to continue.');
            isFollowingScroll = true;
            fetchCredits();
            return;
        }
    }

    while (!isChatPaused(streamingChatId)) {
        showSpinner('Waiting for response...', streamingChatId);
        callNumber++;

        // Reset metrics and start timing for this request
        var currentProviderObj = getProviderById(currentProvider);
        lastRequestMetrics = { startTime: Date.now(), callNumber: callNumber, providerName: currentProviderObj ? currentProviderObj.name : 'Unknown' };

        var assistantMsg = {
            role: 'assistant',
            content: '',
            thinking: '',
            tool_calls: null,
            isStreaming: true,
            thinkingCollapsed: false
        };
        var msgIndex = chat.messages.length;
        chat.messages.push(assistantMsg);
        if (currentChatId === streamingChatId) renderMessages();
        hideSpinner(streamingChatId);

        // Declare BEFORE try so the catch block's clearInterval is always safe even
        // if setInterval itself throws (defensive — extremely unlikely but cheap).
        var streamUpdateInterval = null;
        try {
            streamUpdateInterval = setInterval(function() {
                // Force UI update while streaming to show activity
                if (assistantMsg.isStreaming) {
                    try {
                        updateStreamingMessage(msgIndex, assistantMsg, streamingChatId);
                    } catch (e) {
                        console.error('Stream interval update error:', e);
                    }
                }
            }, 1000);
            
            await callLLMStreaming(
                chat.messages,
                function(thinking) {
                    assistantMsg.thinking = thinking;
                    try {
                        updateStreamingMessage(msgIndex, assistantMsg, streamingChatId);
                    } catch (e) {
                        console.error('Thinking update error:', e);
                    }
                },
                function(content) {
                    assistantMsg.content = content;
                    try {
                        updateStreamingMessage(msgIndex, assistantMsg, streamingChatId);
                    } catch (e) {
                        console.error('Content update error:', e);
                    }
                },
                function(toolCalls) {
                    assistantMsg.tool_calls = toolCalls;
                    try {
                        updateStreamingMessage(msgIndex, assistantMsg, streamingChatId);
                    } catch (e) {
                        console.error('Tool calls update error:', e);
                    }
                },
                function(final) {
                    assistantMsg.thinking = final.thinking || '';
                    assistantMsg.thinkingSignature = final.thinkingSignature || null; // Preserve for Anthropic multi-turn
                    assistantMsg.content = final.content || '';
                    assistantMsg.tool_calls = final.tool_calls;
                    assistantMsg.reasoning_details = final.reasoning_details; // Preserve for OpenRouter API continuity
                    assistantMsg.isStreaming = false;
                },
                function(status, count) {
                    // Stream status callback - model is processing
                },
                chat.id
            );
            
            clearInterval(streamUpdateInterval);
        } catch (e) {
            clearInterval(streamUpdateInterval);

            // User-initiated abort: drop the partial assistant message, flush their queued
            // message, and let the loop continue with their input.
            var isUserAbort = (e && (e.name === 'AbortError' || e.isUserAbort)) || userInterruptedChats[streamingChatId];
            if (isUserAbort) {
                userInterruptedChats[streamingChatId] = false;
                // Drop the partial in-flight assistant message entirely — we never use it.
                if (chat.messages[chat.messages.length - 1] === assistantMsg) {
                    chat.messages.pop();
                }
                if (flushPendingInjection(chat)) {
                    saveChatsToStorage();
                    if (currentChatId === streamingChatId) renderMessages();
                }
                hideSpinner(streamingChatId);
                continue; // Restart the loop with the user's queued message in context
            }

            isFollowingScroll = true; // Reset scroll flag on error
            lastApiError = { message: e.message, chatId: streamingChatId, timestamp: Date.now() };
            showSnackbar('API Error: ' + e.message, 'error');
            chat.messages.pop();
            if (currentChatId === streamingChatId) renderMessages();
            showRetryButton(); // Show retry button for network errors
            break;
        }

        assistantMsg.isStreaming = false;
        if (assistantMsg.thinking) {
            assistantMsg.thinkingCollapsed = true;
        }

        // Capture performance metrics
        if (lastRequestMetrics) {
            lastRequestMetrics.endTime = Date.now();
            lastRequestMetrics.duration = lastRequestMetrics.endTime - lastRequestMetrics.startTime;
            
            // Accumulate to aggregate metrics
            aggregateMetrics.callCount++;
            aggregateMetrics.duration += lastRequestMetrics.duration || 0;
            aggregateMetrics.input_tokens += lastRequestMetrics.input_tokens || 0;
            aggregateMetrics.output_tokens += lastRequestMetrics.output_tokens || 0;
            aggregateMetrics.cache_read_tokens += lastRequestMetrics.cache_read_tokens || 0;
            aggregateMetrics.cache_creation_tokens += lastRequestMetrics.cache_creation_tokens || 0;
            aggregateMetrics.cache_write_tokens += lastRequestMetrics.cache_write_tokens || 0;
            aggregateMetrics.reasoning_tokens += lastRequestMetrics.reasoning_tokens || 0;
            aggregateMetrics.cost += lastRequestMetrics.cost || 0;
            
            // Copy metrics but exclude requestBody to prevent memory bloat
            // (requestBody contains full conversation history with base64 images)
            var metricsToStore = Object.assign({}, lastRequestMetrics);
            delete metricsToStore.requestBody;
            assistantMsg.metrics = metricsToStore;
        }

        if (!assistantMsg.thinking) delete assistantMsg.thinking;
        if (!assistantMsg.content) assistantMsg.content = '';

        // Track model and accumulate cost on chat
        chat.model = currentProvider;
        chat.totalCost = (chat.totalCost || 0) + (lastRequestMetrics.cost || 0);
        
        delete chat.isTemporary;
        saveChatsToStorage();
        if (currentChatId === streamingChatId) renderMessages();
        renderChatList();
        updateContextIndicator(); // Update after each API call, not just at the end

        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
            // If there's a pending injection, push it and continue the loop
            // so the agent sees the user's message in the next API call
            if (flushPendingInjection(chat)) {
                saveChatsToStorage();
                if (currentChatId === streamingChatId) renderMessages();
                continue; // Next iteration calls callLLMStreaming with the injected message
            }
            break;
        }

        // Calculate assistant message index
        var assistantMsgIndex = chat.messages.length - 1;

        var deferredScreenshots = [];
        for (var i = 0; i < assistantMsg.tool_calls.length; i++) {
            if (isChatPaused(streamingChatId)) break;
            // User pressed send mid-tool-batch — inject placeholder results for ALL
            // remaining tool calls (including this one) and exit the loop. The pending
            // user message will be flushed below and the next iteration will run with it.
            if (userInterruptedChats[streamingChatId]) {
                for (var ri = i; ri < assistantMsg.tool_calls.length; ri++) {
                    var rtc = assistantMsg.tool_calls[ri];
                    chat.messages.push({
                        role: 'tool',
                        tool_call_id: rtc.id,
                        name: rtc.function ? rtc.function.name : 'unknown',
                        content: '[Tool call interrupted by user — user sent a new message]'
                    });
                }
                userInterruptedChats[streamingChatId] = false;
                saveChatsToStorage();
                if (currentChatId === streamingChatId) renderMessages();
                break;
            }
            var tc = assistantMsg.tool_calls[i];
            var toolName = tc.function.name;
            var args;
            try {
                args = JSON.parse(tc.function.arguments || '{}');
                args = normalizeToolArgs(args);
            } catch (parseErr) {
                console.error('Failed to parse tool arguments:', tc.function.arguments, parseErr);
                chat.messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: toolName,
                    content: JSON.stringify({ success: false, error: 'Invalid tool arguments: ' + parseErr.message })
                });
                saveChatsToStorage();
                if (currentChatId === streamingChatId) renderMessages();
                continue;
            }

            var displayName = getToolDisplayName(toolName, args.method || args.action);
            showSpinner('Executing ' + displayName + '...', streamingChatId);
            var result = await executeToolWithInterrupt(streamingChatId, toolName, args, assistantMsgIndex, { toolCallId: tc.id, chatId: streamingChatId });
            hideSpinner(streamingChatId);

            // Interrupt landed while this tool was running — abandon it (orphan
            // promise resolves later and its result is discarded), inject placeholder
            // results for this and all remaining tool calls, and exit so the queued
            // user message (or pause cleanup) is handled below.
            //
            // Two distinct triggers share this branch:
            //   1. sendMessage (`:884`) — sets `userInterruptedChats[chatId] = true`
            //      then fires the interrupt resolver. Placeholder text reflects "new message".
            //   2. togglePause (`55-api-messages.js:147`) — fires the resolver only.
            //      The placeholder must NOT claim a new message was sent; that's a lie
            //      to the agent on the next API call and confusing in the transcript.
            if (result && result._interrupted) {
                var _wasUserMessage = !!userInterruptedChats[streamingChatId];
                var _placeholder = _wasUserMessage
                    ? '[Tool call abandoned — user sent a new message]'
                    : '[Tool call abandoned — paused by user]';
                for (var ri2 = i; ri2 < assistantMsg.tool_calls.length; ri2++) {
                    var rtc2 = assistantMsg.tool_calls[ri2];
                    chat.messages.push({
                        role: 'tool',
                        tool_call_id: rtc2.id,
                        name: rtc2.function ? rtc2.function.name : 'unknown',
                        content: _placeholder
                    });
                }
                userInterruptedChats[streamingChatId] = false;
                saveChatsToStorage();
                if (currentChatId === streamingChatId) renderMessages();
                break;
            }

            delete result._denied;
            var screenshotMsg = result._screenshotMessage;
            var screenshotMsgs = result._screenshotMessages;
            delete result._screenshotMessage;
            delete result._screenshotMessages;
            var processed = processToolResultForCache(streamingChatId, tc.id, toolName, result);
            var toolResultIdx = chat.messages.length;
            chat.messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: toolName,
                content: processed.content
            });
            // Correct widget msgIndex if approval messages shifted it
            if (result.widgetId) {
                var wList = getWidgetsForChat(streamingChatId);
                for (var wi = 0; wi < wList.length; wi++) {
                    if (wList[wi].id === result.widgetId) { wList[wi].msgIndex = toolResultIdx; break; }
                }
            }
            // Defer screenshot messages so they don't interleave between tool results
            if (screenshotMsg) deferredScreenshots.push(screenshotMsg);
            if (screenshotMsgs) screenshotMsgs.forEach(function(sm) { deferredScreenshots.push(sm); });
            saveChatsToStorage();
            if (currentChatId === streamingChatId) renderMessages();

        }
        // Push all screenshot messages after all tool results
        if (deferredScreenshots.length > 0) {
            deferredScreenshots.forEach(function(sm) {
                chat.messages.push(sm);
                var _fid = sm.file_id || sm.screenshot_id;
                if (_fid) registerFile(_fid, { type: 'chat', chatId: streamingChatId, msgIndex: chat.messages.length - 1 });
            });
            saveChatsToStorage();
            if (currentChatId === streamingChatId) renderMessages();
        }

        // Flush any user message/images injected during tool execution
        // Skip if paused — tool results may be incomplete (orphaned tool_use blocks)
        if (!isChatPaused(streamingChatId) && flushPendingInjection(chat)) {
            saveChatsToStorage();
            if (currentChatId === streamingChatId) renderMessages();
        }

        if (isChatPaused(streamingChatId)) break;
    }

    // Show aggregate summary if there were multiple API calls
    if (aggregateMetrics.callCount > 1) {
        var summaryMetrics = {
            input_tokens: aggregateMetrics.input_tokens,
            output_tokens: aggregateMetrics.output_tokens,
            cache_read_tokens: aggregateMetrics.cache_read_tokens || undefined,
            cache_creation_tokens: aggregateMetrics.cache_creation_tokens || undefined,
            cache_write_tokens: aggregateMetrics.cache_write_tokens || undefined,
            reasoning_tokens: aggregateMetrics.reasoning_tokens || undefined,
            cost: aggregateMetrics.cost || undefined,
            duration: aggregateMetrics.duration,
            isAggregate: true,
            callCount: aggregateMetrics.callCount
        };
        chat.messages.push({
            role: 'assistant',
            content: '',
            metrics: summaryMetrics,
            isSummary: true
        });
        saveChatsToStorage();
        if (currentChatId === streamingChatId) renderMessages();
    }

    hideSpinner(streamingChatId);
    // Clear per-chat running flag
    delete runningChatIds[streamingChatId];
    // Refresh chat list so the streaming indicator disappears for this chat.
    if (typeof renderChatList === 'function') renderChatList();
    // Only clear global foreground UI flags if this chat was the foreground one
    if (activeStreamingChatId === streamingChatId) {
        isRunning = false;
        activeStreamingChatId = null; // Clear streaming tracker
    }
    // Preserve injection data when paused — it will be flushed after resume completes pending tools
    if (!isChatPaused(streamingChatId)) {
        pendingInjection = null;
        pendingInjectionImages = null;
        delete pendingInjectionsByChatId[streamingChatId];
    }
    // Clear any leftover interrupt flag so the next run starts clean.
    userInterruptedChats[streamingChatId] = false;
    // If this was a background Action chat, notify the actions engine so the button can finalize.
    if (chat && chat.isBackground && chat.actionId && typeof finishActionIfDone === 'function') {
        try { await finishActionIfDone(streamingChatId); } catch (e) {}
    }
    var messagesEl = document.getElementById('messages');
    if (messagesEl) {
        messagesEl.classList.remove('is-streaming');
    }
    // Reset silent hook flag before final render so messages are properly displayed
    var wasSilentHook = _silentHookRunning;
    _silentHookRunning = false;
    if (currentChatId === streamingChatId) renderMessages();
    updateContextIndicator(); // Update now that streaming is done

    // Only hide pause button if not paused - keep visible so user can resume
    if (isChatPaused(streamingChatId)) {
        // Make sure the button label reflects the actual paused state — covers any
        // race where togglePause set it but a later UI sync clobbered it back to "Pause".
        if (typeof syncPauseButtonUI === 'function') syncPauseButtonUI(streamingChatId);
        showSnackbar('Agent paused. Click Resume to continue.');
    } else {
        hidePauseButton();
        // If the run ended but the chat still looks interrupted (e.g. error mid-tool),
        // surface the Continue button so the user can resume manually.
        if (currentChatId === streamingChatId) {
            refreshContinueButtonForChat(streamingChatId);
        }
    }
    isFollowingScroll = true; // Reset scroll flag when agent run fully completes
    
    // Execute after-response hooks (only if not paused and no error occurred)
    // Per-chat pause check: a paused background chat must not gate hooks for the
    // chat that just finished.
    if (!isChatPaused(streamingChatId) && !lastApiError) {
        executeAfterResponseHooks(streamingChatId);
    }
    
    // Refresh credits after API calls complete
    fetchCredits();

    // Send browser notification when agent finishes in the background.
    // Fire if the document is hidden NOW *or* was hidden at any point during the
    // run — covers the common case where the user switched away while the agent
    // was working and switched back just as it finished.
    // Per-chat pause check: a paused different chat must not suppress this chat's notification.
    var _wasHidden = !!_hiddenDuringRun[streamingChatId];
    delete _hiddenDuringRun[streamingChatId];
    var _awayNow = document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
    if (!isChatPaused(streamingChatId) && !wasSilentHook && (_awayNow || _wasHidden)) {
        var _nc = chats[streamingChatId];
        var title = _nc && _nc.title ? _nc.title : 'Chat';
        var hasError = !!lastApiError;
        Platform.sendNotification({
            title: hasError ? 'Agent stopped — error' : 'Agent finished',
            message: title,
            chatId: streamingChatId
        });
    }
    } finally {
        // Safety net for uncaught throws inside the agent loop body. The
        // normal-path cleanup above already deletes this flag (and re-renders
        // the chat list); this only fires when the body threw before reaching
        // it. Without the guard, the streaming dot would spin forever and
        // future sends would be blocked by the early-return at function top.
        if (runningChatIds[streamingChatId]) {
            delete runningChatIds[streamingChatId];
            if (typeof renderChatList === 'function') renderChatList();
        }
    }
}

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

        // Interrupt the current step so the message is sent instantly:
        //  • If LLM is mid-stream — abort the fetch (partial response is dropped).
        //  • If we're mid tool execution — fire the interrupt resolver so the race
        //    promise resolves _immediately_ (no polling delay). Orphan tool keeps
        //    running in the background; its result is discarded.
        userInterruptedChats[currentChatId] = true;
        var ac = currentStreamAbortControllers[currentChatId];
        if (ac && typeof ac.abort === 'function') {
            try { ac.abort(); } catch (e) {}
        }
        var interruptFn = interruptResolversByChatId[currentChatId];
        if (typeof interruptFn === 'function') {
            try { interruptFn(); } catch (e) {}
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

    // Reset scroll flag when user sends a new message
    isFollowingScroll = true;

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
    // Sync the button label off the (now-cleared) per-chat state instead of
    // hard-coding it — keeps a single source of truth for the label.
    if (typeof syncPauseButtonUI === 'function') {
        syncPauseButtonUI(currentChatId);
    } else {
        document.getElementById('pause-btn').innerHTML = '<span class="btn-icon">' + UI_ICONS.pause + '</span>Pause';
    }

    await runAgent();
}
