// PR1: visibility / window-focus tracking + _hiddenDuringRun map moved to
// src/js/app/035-agent-events.js (notifyFinish handler). The agent loop is
// DOM-free; UI side effects live in 035.

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

// Assert the Anthropic invariants before an API call. Returns null if the chat
// shape is valid; otherwise returns a description of the first violation. Used
// by the agent loop to fail-loud at the exact site rather than letting the
// model bounce a 400 back with no context about WHERE the invariant broke.
//
// `prompt_user` / `approval` / etc. are stripped by `buildAPIMessages` before
// the request goes out, so they're transparent here — we skip past them when
// looking for the tool_result slot. (Without this skip, a prompt_user inserted
// between an assistant's tool_use and its tool_result placeholder would log
// a noisy false-positive "orphan tool_use" every API call.)
var _API_VISIBLE_ROLES = { user:1, assistant:1, tool:1, screenshot:1, pdf:1, file:1, context:1, browser_context:1 };
function assertAnthropicShape(messages) {
    if (!messages || !messages.length) return null;
    var knownIds = {};
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m.role === 'assistant' && m.tool_calls) {
            for (var j = 0; j < m.tool_calls.length; j++) {
                var tc = m.tool_calls[j];
                if (tc && tc.id) knownIds[tc.id] = true;
            }
            // Locate the tool_result slot: skip any non-API roles (prompt_user,
            // approval) that buildAPIMessages will strip before the request.
            var slotStart = i + 1;
            while (slotStart < messages.length && !_API_VISIBLE_ROLES[messages[slotStart].role]) slotStart++;
            var slotEnd = slotStart;
            var slotIds = {};
            while (slotEnd < messages.length && messages[slotEnd].role === 'tool') {
                slotIds[messages[slotEnd].tool_call_id] = true;
                slotEnd++;
            }
            for (var jj = 0; jj < m.tool_calls.length; jj++) {
                var tcj = m.tool_calls[jj];
                if (!tcj || !tcj.id) continue;
                if (!slotIds[tcj.id]) {
                    var next = messages[slotStart];
                    return 'orphan tool_use ' + tcj.id + ' at msg#' + i + ' (next API-visible msg is ' + (next ? next.role : 'EOF') + ', slot ids ' + Object.keys(slotIds).join(',') + ')';
                }
            }
        }
        if (m.role === 'tool' && m.tool_call_id && !knownIds[m.tool_call_id]) {
            return 'stray tool_result ' + m.tool_call_id + ' at msg#' + i + ' (no prior assistant emitted it)';
        }
    }
    return null;
}

// Find the tool_result slot for an assistant message's tool_call_id and
// either update the existing placeholder/result in-place, or push a new one.
// Used by every tool-result write site in the agent loop so the atomic-
// placeholder invariant (every tool_use has a matching tool_result in the
// next slot, persisted before tool execution begins) is preserved across
// SW eviction.
function recordToolResult(chat, toolCallId, name, content) {
    if (!chat || !chat.messages || !toolCallId) return null;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m.role !== 'tool') continue;
        if (m.tool_call_id !== toolCallId) continue;
        m.content = content;
        if (name) m.name = name;
        delete m._placeholder;
        return m;
    }
    var newMsg = { role: 'tool', tool_call_id: toolCallId, name: name || 'unknown', content: content };
    chat.messages.push(newMsg);
    return newMsg;
}

// Atomic-placeholder seed: BEFORE we start executing this assistant turn's
// tools, push a `[pending]` `role:'tool'` message for every tool_call. This
// guarantees the persisted chat is ALWAYS a valid Anthropic shape — every
// `tool_use` block has its matching `tool_result` block in the next slot —
// even if the SW is evicted between the assistant save (line 692) and the
// per-tool save inside the execution loop. Tool execution later updates each
// placeholder in-place via `recordToolResult`; if execution is interrupted
// (SW death, pause, user-send), the placeholder content stands and the chat
// remains valid for the next API call.
//
// `_placeholder: true` is kept on the message so the next runAgent's pending-
// tool replay can detect "I started this tool but never updated the result"
// and decide whether to retry. The flag is dropped the moment a real result
// (or a real failure) replaces it.
function seedPlaceholderToolResults(chat, toolCalls) {
    if (!chat || !chat.messages || !toolCalls || toolCalls.length === 0) return;
    var seeded = [];
    for (var i = 0; i < toolCalls.length; i++) {
        var tc = toolCalls[i];
        if (!tc || !tc.id) {
            console.warn('[seed] skipping tool_call with no id', tc);
            continue;
        }
        var already = false;
        for (var j = chat.messages.length - 1; j >= 0; j--) {
            var m = chat.messages[j];
            if (m.role === 'tool' && m.tool_call_id === tc.id) { already = true; break; }
            if (m.role === 'assistant') break;
        }
        if (already) continue;
        chat.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function ? tc.function.name : 'unknown',
            content: '[Tool call pending — agent runtime restarted before result]',
            _placeholder: true
        });
        seeded.push(tc.id);
    }
    if (seeded.length) {
        console.log('[seed] placeholders for', seeded.join(','), '— chat now has', chat.messages.length, 'messages');
    }
}

// Migration helper for chats created before the atomic-placeholder design,
// AND recovery helper for chats whose tool execution was interrupted (SW
// eviction mid-loop OR user-send that aborts the current stream while a
// tool is mid-flight). In both cases the assistant `tool_use` block in the
// next slot may be matched only by a `_placeholder: true` row — not a real
// result. The pending-replay scan at line ~462 correctly treats a
// placeholder as unresolved and re-runs the tool, but for user-interrupt
// re-running is wrong: an `await_handle` waiting on a long sub would
// re-block on the same handle the user already meant to abandon.
//
// This function runs on every runAgent entry and resolves orphan slots:
//   • A tool_call with NO matching `role:'tool'` row → splice in a new
//     interrupted-marker row (legacy path; new chats should never hit this
//     because `seedPlaceholderToolResults` populates the slot eagerly).
//   • A tool_call whose only matching row is a `_placeholder: true` row →
//     overwrite its content in-place with the same interrupted marker and
//     drop `_placeholder`, so the pending-replay scan sees a real result.
//   • A misplaced REAL row (correct tool_call_id but landed after the slot)
//     is moved into the slot unchanged.
function injectInterruptedToolResults(chat) {
    if (!chat || !chat.messages) return false;
    var injected = false;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var msg = chat.messages[i];
        if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue;
        var slotStart = i + 1;
        var slotEnd = slotStart;
        while (slotEnd < chat.messages.length && chat.messages[slotEnd].role === 'tool') {
            slotEnd++;
        }
        // Only NON-placeholder rows count as "present". Placeholders are
        // unresolved slot fillers — they exist solely to keep the chat a
        // valid Anthropic shape while the tool is in-flight. Treating them
        // as real results here lets an orphan placeholder survive runAgent
        // forever; the line-462 replay scan then re-runs the tool on every
        // turn (the `await_handle` re-block loop described in PR #244).
        var presentIds = {};
        var placeholderIdxById = {};
        for (var rj = slotStart; rj < slotEnd; rj++) {
            var row = chat.messages[rj];
            if (row._placeholder) {
                placeholderIdxById[row.tool_call_id] = rj;
            } else {
                presentIds[row.tool_call_id] = true;
            }
        }
        for (var j = 0; j < msg.tool_calls.length; j++) {
            var tc = msg.tool_calls[j];
            if (!tc || !tc.id) continue;
            if (presentIds[tc.id]) continue;
            var hasPendingPrompt = false;
            for (var p = 0; p < chat.messages.length; p++) {
                if (chat.messages[p].role === 'prompt_user' && chat.messages[p].toolCallId === tc.id && chat.messages[p].status === 'pending') {
                    hasPendingPrompt = true;
                    break;
                }
            }
            if (hasPendingPrompt) continue;
            // Placeholder branch: overwrite in-place, drop the flag. No
            // splice — the slot length doesn't change, so slotEnd stays
            // correct for subsequent iterations.
            var placeholderIdx = placeholderIdxById[tc.id];
            if (typeof placeholderIdx === 'number') {
                var ph = chat.messages[placeholderIdx];
                ph.content = '[Tool call interrupted by user - no result available]';
                if (!ph.name) ph.name = tc.function ? tc.function.name : 'unknown';
                delete ph._placeholder;
                presentIds[tc.id] = true;
                delete placeholderIdxById[tc.id];
                msg.isStreaming = false;
                injected = true;
                continue;
            }
            var misplacedIdx = -1;
            for (var k = slotEnd; k < chat.messages.length; k++) {
                if (chat.messages[k].role === 'tool' && chat.messages[k].tool_call_id === tc.id) {
                    misplacedIdx = k;
                    break;
                }
            }
            if (misplacedIdx !== -1) {
                var moved = chat.messages.splice(misplacedIdx, 1)[0];
                chat.messages.splice(slotEnd, 0, moved);
            } else {
                chat.messages.splice(slotEnd, 0, {
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: tc.function ? tc.function.name : 'unknown',
                    content: '[Tool call interrupted by user - no result available]'
                });
            }
            slotEnd++;
            presentIds[tc.id] = true;
            msg.isStreaming = false;
            injected = true;
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
            
            var _chatId = chat && chat.id;
            AgentEvents.emit('toolCallStarted', { chatId: _chatId, toolCallId: msg.toolCallId, name: toolName, displayName: msg.toolName, input: args });
            try {
                // executeTool checks for existing approval via requestProgrammaticToolApproval
                var result = await executeTool(toolName, args, assistantMsgIndex, { toolCallId: msg.toolCallId, chatId: chat.id });

                var processed = processToolResultForCache(chat.id, msg.toolCallId, toolName, result);
                // recordToolResult overwrites the seeded placeholder in-place. Main's
                // push-to-end was correct because end-of-array == slot-after-assistant
                // (no placeholders). With approval messages + atomic placeholders
                // separating the assistant from the end, pushing here would land the
                // result after the approval row — invalid Anthropic shape. In-place
                // update produces the same final shape main did: one tool_result row
                // in the slot immediately after the assistant.
                recordToolResult(chat, msg.toolCallId, toolName, processed.content);
                saveChatsToStorage();
                // force: true — main called renderMessages() unconditionally here
                // (no currentChatId gate). The flag tells the handler to match.
                AgentEvents.emit('toolCallResult', { chatId: _chatId, toolCallId: msg.toolCallId, name: toolName, result: result, force: true });
            } catch (e) {
                recordToolResult(chat, msg.toolCallId, toolName, JSON.stringify({ success: false, error: e.message }));
                saveChatsToStorage();
                AgentEvents.emit('toolCallResult', { chatId: _chatId, toolCallId: msg.toolCallId, name: toolName, error: e, force: true });
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
    // PR1: runStarted handler (035-agent-events.js) owns the foreground UI
    // setup (pause button, is-streaming class, retry/continue cleanup) AND
    // captures the initial document.hidden / hasFocus state for the
    // finish-notification heuristic. The loop just emits.
    //
    // The emit is INSIDE the try so the finally still runs and clears
    // runningChatIds even if a UI handler throws — same safety net the
    // original had when the foreground-UI block lived inside the try.
    var chat;
    var isBackgroundRun;
    // Set true once the normal finish/cleanup path has run (right after the
    // per-chat running flag is cleared below). The finally uses it to tell a
    // genuine pre-cleanup crash (flag still false, runningChatIds still ours)
    // apart from the auto-title hook having re-set runningChatIds for its
    // nested run — in the latter case the finally must NOT clear that flag or
    // emit runCrashed, or it would clobber the rerun and reopen the race.
    var _ranNormalCleanup = false;
    // try/finally guarantees the per-chat running flag is cleared even if the
    // body throws — without this, an uncaught error would leave the streaming
    // dot spinning forever AND block future sends via the early-return at top.
    try {
    chat = chats[streamingChatId];
    isBackgroundRun = !!(chat && chat.isBackground);
    AgentEvents.emit('runStarted', { chatId: streamingChatId, turn: -1 });

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
            // Check which tool calls don't have results yet. Seeded
            // placeholders (role:'tool' with _placeholder:true) count as
            // UNPROCESSED — they exist only to satisfy the Anthropic shape
            // invariant during execution; on resume we still need to
            // actually run the tool, otherwise the model sees the
            // "[Tool call pending …]" placeholder text as the real result.
            var unprocessed = [];
            for (var pti = 0; pti < pm.tool_calls.length; pti++) {
                var ptc = pm.tool_calls[pti];
                var hasResult = false;
                for (var pri = pi + 1; pri < chat.messages.length; pri++) {
                    var prm = chat.messages[pri];
                    if (prm.role === 'tool' && prm.tool_call_id === ptc.id && !prm._placeholder) {
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
                recordToolResult(chat, tc.id, toolName, JSON.stringify({ success: false, error: 'Invalid tool arguments: ' + parseErr.message }));
                saveChatsToStorage();
                AgentEvents.emit('toolCallResult', { chatId: streamingChatId, toolCallId: tc.id, name: toolName, error: parseErr });
                continue;
            }

            var displayName = getToolDisplayName(toolName, args.method || args.action);
            AgentEvents.emit('toolCallStarted', { chatId: streamingChatId, toolCallId: tc.id, name: toolName, displayName: displayName, input: args });
            // Match main: tool throws propagate to the outer try/finally → runCrashed.
            // Before re-throwing we drop the _placeholder marker on this and every
            // subsequent unrun tool (record a real result), otherwise the next
            // runAgent's pending-replay sees them as unprocessed placeholders and
            // re-runs them — looping forever on a deterministic throw. Main got
            // this for free because there were no placeholders; sendMessage's
            // injectInterruptedToolResults later filled the orphans with the same
            // "[interrupted]" content these recordToolResult calls write here.
            var result;
            try {
                result = await executeToolWithInterrupt(streamingChatId, toolName, args, assistantMsgIndex, { toolCallId: tc.id, chatId: streamingChatId });
            } catch (toolErr) {
                console.error('[agent-loop] tool execution threw during pending-replay for ' + toolName, toolErr);
                recordToolResult(chat, tc.id, toolName, JSON.stringify({ success: false, error: (toolErr && toolErr.message) ? toolErr.message : String(toolErr) }));
                for (var prj = pci + 1; prj < pendingToolCalls.length; prj++) {
                    var prjtc = pendingToolCalls[prj].tc;
                    recordToolResult(chat, prjtc.id, prjtc.function ? prjtc.function.name : 'unknown', '[Tool call interrupted by user - no result available]');
                }
                saveChatsToStorage();
                throw toolErr;
            }

            // User-interrupt during pending-tool replay — abandon remaining tools.
            // Their placeholders stay in chat.messages so the Anthropic shape is
            // valid; we just overwrite the placeholder content with an explanatory
            // note so the model knows on the next turn.
            if (result && result._interrupted) {
                for (var rj = pci; rj < pendingToolCalls.length; rj++) {
                    var rjtc = pendingToolCalls[rj].tc;
                    recordToolResult(chat, rjtc.id, rjtc.function ? rjtc.function.name : 'unknown', '[Tool call abandoned — user sent a new message]');
                }
                userInterruptedChats[streamingChatId] = false;
                saveChatsToStorage();
                AgentEvents.emit('toolCallCancelled', { chatId: streamingChatId, toolCallId: tc.id, reason: 'user_message' });
                break;
            }

            delete result._denied;
            var screenshotMsg = result._screenshotMessage;
            var screenshotMsgs = result._screenshotMessages;
            delete result._screenshotMessage;
            delete result._screenshotMessages;
            var processed = processToolResultForCache(streamingChatId, tc.id, toolName, result);
            recordToolResult(chat, tc.id, toolName, processed.content);
            // Defer screenshot messages so they don't interleave between tool results
            if (screenshotMsg) deferredScreenshots.push(screenshotMsg);
            if (screenshotMsgs) screenshotMsgs.forEach(function(sm) { deferredScreenshots.push(sm); });
            saveChatsToStorage();
            AgentEvents.emit('toolCallResult', { chatId: streamingChatId, toolCallId: tc.id, name: toolName, result: result });
        }
        // Push all screenshot messages after all tool results
        if (deferredScreenshots.length > 0) {
            deferredScreenshots.forEach(function(sm) {
                chat.messages.push(sm);
                var _fid = sm.file_id || sm.screenshot_id;
                if (_fid) registerFile(_fid, { type: 'chat', chatId: streamingChatId, msgIndex: chat.messages.length - 1 });
            });
            saveChatsToStorage();
            AgentEvents.emit('messagesAppended', { chatId: streamingChatId, reason: 'deferred_screenshots' });
        }

        // Flush any user message/images injected during tool execution
        // Skip if paused — tool results may be incomplete (orphaned tool_use blocks)
        // The injection will be flushed after resuming and all pending tools complete
        // Per-chat pause check: don't consult global `paused` here, it would block
        // injection on chat A just because chat B is paused.
        if (!isChatPaused(streamingChatId) && flushPendingInjection(chat)) {
            saveChatsToStorage();
            AgentEvents.emit('userInjected', { chatId: streamingChatId });
        }

        if (isChatPaused(streamingChatId)) {
            // Paused during pending tool processing - exit cleanly. The 'paused'
            // handler owns isRunning / isFollowingScroll writes.
            AgentEvents.emit('paused', { chatId: streamingChatId });
            fetchCredits();
            return;
        }
    }

    while (!isChatPaused(streamingChatId)) {
        AgentEvents.emit('turnStarted', { chatId: streamingChatId, turn: lastUserMsgIndex, callNumber: callNumber + 1 });
        callNumber++;

        // Reset metrics and start timing for this request
        var currentProviderObj = getProviderById(currentProvider);
        lastRequestMetrics = { startTime: Date.now(), callNumber: callNumber, providerName: currentProviderObj ? currentProviderObj.name : 'Unknown' };

        // Sub-agent nudge: when the running context crosses the threshold, append a
        // ONE-SHOT reminder to delegate heavy/verbose work to sub-agents (model
        // quality degrades at long context). Pushed as a trailing `context` message
        // so buildAPIMessages merges it onto the END of the last user turn — it comes
        // LAST and sits AFTER the prompt-cache breakpoints, so the cached prefix is
        // never invalidated (only this short tail is uncached). It is deliberately
        // NOT placed in the system prompt (that would bust the whole cache every
        // turn). Skipped for sub-agent chats; fires at most once per chat.
        if (!chat.isSubAgent && !chat._ctxSubAgentNudgeSent &&
            typeof SUBAGENT_NUDGE_TOKEN_THRESHOLD === 'number' && SUBAGENT_NUDGE_TOKEN_THRESHOLD > 0) {
            var _ctxTokens = 0;
            for (var _ci = chat.messages.length - 1; _ci >= 0; _ci--) {
                var _cm = chat.messages[_ci];
                if (_cm && _cm.role === 'assistant' && _cm.metrics && _cm.metrics.input_tokens && !_cm.metrics.isAggregate) {
                    _ctxTokens = _cm.metrics.input_tokens;
                    break;
                }
            }
            if (_ctxTokens >= SUBAGENT_NUDGE_TOKEN_THRESHOLD) {
                chat.messages.push({
                    role: 'context',
                    content: '[Context is now ~' + Math.round(_ctxTokens / 1000) + 'k tokens. Model performance degrades as context grows — strongly prefer delegating heavy or verbose work (file/grep dumps, multi-record audits, deep log scans, iterative debugging) to sub-agents via spawn_sub_agent so their raw output stays out of this conversation. Keep this context lean.]'
                });
                chat._ctxSubAgentNudgeSent = true;
            }
        }

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
        AgentEvents.emit('assistantMessageStarted', { chatId: streamingChatId, turn: lastUserMsgIndex, msgIndex: msgIndex, message: assistantMsg });

        // Declare BEFORE try so the catch block's clearInterval is always safe even
        // if setInterval itself throws (defensive — extremely unlikely but cheap).
        var streamUpdateInterval = null;
        try {
            streamUpdateInterval = setInterval(function() {
                // Force UI update while streaming to show activity
                if (assistantMsg.isStreaming) {
                    AgentEvents.emit('streamDelta', { chatId: streamingChatId, turn: lastUserMsgIndex, msgIndex: msgIndex, message: assistantMsg, kind: 'interval' });
                }
            }, 1000);
            
            // Diagnostic: if the chat shape would 400 Anthropic, log a precise
            // breakdown before the API call. We let the call go through so the
            // server's exact rejection still surfaces — but the SW console now
            // tells us WHICH message and WHICH tool_call_id is at fault.
            var _shapeViolation = assertAnthropicShape(chat.messages);
            if (_shapeViolation) {
                console.error('[agent-loop] pre-API invariant violation: ' + _shapeViolation, {
                    chatId: streamingChatId,
                    msgs: chat.messages.map(function(m, idx) {
                        return idx + ':' + m.role +
                            (m.tool_calls ? '[' + m.tool_calls.map(function(t) { return t && t.id; }).join(',') + ']' : '') +
                            (m.tool_call_id ? '(' + m.tool_call_id + ')' : '') +
                            (m._placeholder ? '*' : '');
                    })
                });
            }

            await callLLMStreaming(
                chat.messages,
                function(thinking) {
                    assistantMsg.thinking = thinking;
                    AgentEvents.emit('streamDelta', { chatId: streamingChatId, turn: lastUserMsgIndex, msgIndex: msgIndex, message: assistantMsg, kind: 'thinking', delta: thinking });
                },
                function(content) {
                    assistantMsg.content = content;
                    AgentEvents.emit('streamDelta', { chatId: streamingChatId, turn: lastUserMsgIndex, msgIndex: msgIndex, message: assistantMsg, kind: 'text', delta: content });
                },
                function(toolCalls) {
                    assistantMsg.tool_calls = toolCalls;
                    AgentEvents.emit('streamDelta', { chatId: streamingChatId, turn: lastUserMsgIndex, msgIndex: msgIndex, message: assistantMsg, kind: 'tool_input', delta: toolCalls });
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
                    AgentEvents.emit('userInjected', { chatId: streamingChatId });
                }
                AgentEvents.emit('streamAborted', { chatId: streamingChatId });
                continue; // Restart the loop with the user's queued message in context
            }

            // Match main verbatim: isFollowingScroll=true is set BEFORE lastApiError
            // (main line 577, before line 578). Keeping it in the loop body — instead
            // of folding it into the 'error' handler — preserves the original write
            // order of state vs. lastApiError around the emit.
            isFollowingScroll = true;
            console.error('[agent-loop] caught during stream for chat ' + streamingChatId + ':', e);
            // Build a safe error envelope: structured clone strips non-Error
            // properties, so capture message/name/stack into a plain object
            // that survives the postMessage to panels.
            var errEnv;
            if (e instanceof Error) {
                errEnv = { name: e.name, message: e.message, stack: e.stack };
            } else if (typeof e === 'string') {
                errEnv = { message: e };
            } else if (e && typeof e === 'object') {
                errEnv = { name: e.name || 'Error', message: e.message || JSON.stringify(e), raw: e };
            } else {
                errEnv = { message: String(e) };
            }
            lastApiError = { message: errEnv.message, chatId: streamingChatId, timestamp: Date.now() };
            chat.messages.pop();
            AgentEvents.emit('error', { chatId: streamingChatId, error: errEnv, recoverable: true });
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

        // Atomic-placeholder seeding: BEFORE the first save that persists the
        // assistant message with its tool_calls, push a `[pending]` tool_result
        // placeholder for every tool_call. From this save onward, the persisted
        // chat is ALWAYS a valid Anthropic shape — every tool_use has its
        // tool_result in the next slot. SW eviction between this point and the
        // per-tool save inside the execution loop can't strand an orphan because
        // the placeholder satisfies the invariant; the actual tool result just
        // overwrites the placeholder content in-place when it completes.
        seedPlaceholderToolResults(chat, assistantMsg.tool_calls);

        saveChatsToStorage();
        AgentEvents.emit('assistantMessage', { chatId: streamingChatId, turn: lastUserMsgIndex, message: assistantMsg, metrics: assistantMsg.metrics });

        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
            // If there's a pending injection, push it and continue the loop
            // so the agent sees the user's message in the next API call
            if (flushPendingInjection(chat)) {
                saveChatsToStorage();
                AgentEvents.emit('userInjected', { chatId: streamingChatId });
                continue; // Next iteration calls callLLMStreaming with the injected message
            }
            break;
        }

        // Assistant message index: with atomic placeholders seeded, chat.messages
        // length now sits past the placeholders, so find the assistantMsg's
        // actual position. (Used by tool implementations and widget bookkeeping.)
        var assistantMsgIndex = chat.messages.indexOf(assistantMsg);

        var deferredScreenshots = [];
        for (var i = 0; i < assistantMsg.tool_calls.length; i++) {
            if (isChatPaused(streamingChatId)) break;
            // User pressed send mid-tool-batch — inject placeholder results for ALL
            // remaining tool calls (including this one) and exit the loop. The pending
            // user message will be flushed below and the next iteration will run with it.
            if (userInterruptedChats[streamingChatId]) {
                for (var ri = i; ri < assistantMsg.tool_calls.length; ri++) {
                    var rtc = assistantMsg.tool_calls[ri];
                    recordToolResult(chat, rtc.id, rtc.function ? rtc.function.name : 'unknown', '[Tool call interrupted by user — user sent a new message]');
                }
                userInterruptedChats[streamingChatId] = false;
                saveChatsToStorage();
                AgentEvents.emit('toolCallCancelled', { chatId: streamingChatId, reason: 'user_message' });
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
                recordToolResult(chat, tc.id, toolName, JSON.stringify({ success: false, error: 'Invalid tool arguments: ' + parseErr.message }));
                saveChatsToStorage();
                AgentEvents.emit('toolCallResult', { chatId: streamingChatId, toolCallId: tc.id, name: toolName, error: parseErr });
                continue;
            }

            var displayName = getToolDisplayName(toolName, args.method || args.action);
            AgentEvents.emit('toolCallStarted', { chatId: streamingChatId, toolCallId: tc.id, name: toolName, displayName: displayName, input: args });
            // Every tool_use already has a placeholder tool_result (seeded by
            // `seedPlaceholderToolResults` when the assistant turn was finalized).
            // `recordToolResult` overwrites that placeholder in-place; the chat
            // remains in a valid Anthropic shape at every save point, so SW
            // eviction between here and the per-tool save can never strand an
            // orphan `tool_use`.
            //
            // Match main: tool throws propagate to the outer try/finally → runCrashed.
            // Before re-throwing we drop the _placeholder marker on this and every
            // subsequent unrun tool (record a real result), otherwise the next
            // runAgent's pending-replay sees them as unprocessed placeholders and
            // re-runs them — looping forever on a deterministic throw. Main got
            // this for free because there were no placeholders; sendMessage's
            // injectInterruptedToolResults later filled the orphans with the same
            // "[interrupted]" content these recordToolResult calls write here.
            var result;
            try {
                result = await executeToolWithInterrupt(streamingChatId, toolName, args, assistantMsgIndex, { toolCallId: tc.id, chatId: streamingChatId });
            } catch (toolErr) {
                console.error('[agent-loop] tool execution threw for ' + toolName, toolErr);
                recordToolResult(chat, tc.id, toolName, JSON.stringify({ success: false, error: (toolErr && toolErr.message) ? toolErr.message : String(toolErr) }));
                for (var rti = i + 1; rti < assistantMsg.tool_calls.length; rti++) {
                    var rttc = assistantMsg.tool_calls[rti];
                    recordToolResult(chat, rttc.id, rttc.function ? rttc.function.name : 'unknown', '[Tool call interrupted by user - no result available]');
                }
                saveChatsToStorage();
                throw toolErr;
            }

            // Interrupt landed while this tool was running — abandon it (orphan
            // promise resolves later and its result is discarded), update
            // placeholders for this and all remaining tool calls with an
            // abandon-reason note, and exit so the queued user message (or pause
            // cleanup) is handled below.
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
                    recordToolResult(chat, rtc2.id, rtc2.function ? rtc2.function.name : 'unknown', _placeholder);
                }
                userInterruptedChats[streamingChatId] = false;
                saveChatsToStorage();
                AgentEvents.emit('toolCallCancelled', { chatId: streamingChatId, toolCallId: tc.id, reason: _wasUserMessage ? 'user_message' : 'paused' });
                break;
            }

            delete result._denied;
            var screenshotMsg = result._screenshotMessage;
            var screenshotMsgs = result._screenshotMessages;
            delete result._screenshotMessage;
            delete result._screenshotMessages;
            var processed = processToolResultForCache(streamingChatId, tc.id, toolName, result);
            var resultMsg = recordToolResult(chat, tc.id, toolName, processed.content);
            var toolResultIdx = chat.messages.indexOf(resultMsg);
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
            AgentEvents.emit('toolCallResult', { chatId: streamingChatId, toolCallId: tc.id, name: toolName, result: result });

        }
        // Push all screenshot messages after all tool results
        if (deferredScreenshots.length > 0) {
            deferredScreenshots.forEach(function(sm) {
                chat.messages.push(sm);
                var _fid = sm.file_id || sm.screenshot_id;
                if (_fid) registerFile(_fid, { type: 'chat', chatId: streamingChatId, msgIndex: chat.messages.length - 1 });
            });
            saveChatsToStorage();
            AgentEvents.emit('messagesAppended', { chatId: streamingChatId, reason: 'deferred_screenshots' });
        }

        // Flush any user message/images injected during tool execution
        // Skip if paused — tool results may be incomplete (orphaned tool_use blocks)
        if (!isChatPaused(streamingChatId) && flushPendingInjection(chat)) {
            saveChatsToStorage();
            AgentEvents.emit('userInjected', { chatId: streamingChatId });
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
        AgentEvents.emit('messagesAppended', { chatId: streamingChatId, reason: 'aggregate_summary' });
    }

    // === Finish: non-UI state cleanup ===
    // Clear per-chat running flag BEFORE emitting runFinished so the
    // handler's renderChatList sees the indicator should be hidden.
    // Atomically (same sync tick) raise the cleanup guard: from here until the
    // auto-title hook's recursive runAgent re-sets runningChatIds (or we decide
    // no hook fires), an await below (finishActionIfDone) can yield and let a
    // stale panel `run-agent` slip in. Without the guard it would read
    // runningChatIds as false, replace chats[id] with its stale snapshot AND
    // start a second loop — the root cause of interleaved/orphan tool_use blocks.
    _runCleanupGuard[streamingChatId] = true;
    delete runningChatIds[streamingChatId];
    // From here on, any throw is POST-cleanup: runningChatIds is already
    // cleared and runFinished is (about to be) emitted, so the finally's
    // crash path must not fire. Critically this also fences off the auto-title
    // hook below — when it re-sets runningChatIds for its nested run, the
    // finally sees _ranNormalCleanup === true and leaves that flag intact, so
    // the chat stays observably "running" for the whole rerun (closing the
    // window a stale panel run-agent used to slip a second loop into).
    _ranNormalCleanup = true;
    // Only clear global foreground UI flags if this chat was the foreground one
    if (activeStreamingChatId === streamingChatId) {
        isRunning = false;
        activeStreamingChatId = null; // Clear streaming tracker
    }
    // Preserve injection data when paused — it will be flushed after resume completes pending tools.
    // Sub-agent finish race: agent_message can arrive between the last
    // flushPendingInjection (line 757 / 893) and this cleanup, setting
    // pendingInjectionsByChatId AFTER the loop already decided to exit.
    // SubAgents.onSubAgentRunFinished's backstop (097-sub-agent-registry.js)
    // re-queues the sub when it sees a pendingInjection — wiping it here
    // would lose the parent's message. Keep the entry around for sub-agent
    // chats so the backstop can act on it.
    if (!isChatPaused(streamingChatId)) {
        pendingInjection = null;
        pendingInjectionImages = null;
        if (!(chat && chat.isSubAgent)) {
            delete pendingInjectionsByChatId[streamingChatId];
        }
    }
    // Clear any leftover interrupt flag so the next run starts clean.
    userInterruptedChats[streamingChatId] = false;
    // If this was a background Action chat, notify the actions engine so the button can finalize.
    if (chat && chat.isBackground && chat.actionId && typeof finishActionIfDone === 'function') {
        try { await finishActionIfDone(streamingChatId); } catch (e) {}
    }
    // If this was a sub-agent chat, settle the parent's spawn handle (if the
    // sub finished naturally without calling report_to_parent) and park the
    // sub. Without this, the parent's `await_handle` would hang forever on a
    // sub that just returned a final assistant text without explicitly
    // reporting. See SubAgents.onSubAgentRunFinished.
    if (chat && chat.isSubAgent && typeof SubAgents !== 'undefined' && SubAgents.onSubAgentRunFinished) {
        // Pass an explicit reason so the hook can distinguish a run that
        // ended in an API error from one that simply finished without
        // calling report_to_parent. Without this signal, auto_report
        // synthesizes status:'done' over an errored run and the parent
        // unblocks with a false-positive success.
        var _finishReason = lastApiError ? 'errored' : 'completed';
        try { SubAgents.onSubAgentRunFinished(streamingChatId, { reason: _finishReason, error: lastApiError || null }); } catch (e) { console.warn('onSubAgentRunFinished hook threw', e); }
    }
    // Reset silent hook flag before the UI handler runs the final render so
    // messages are properly displayed. Capture the pre-reset value for the
    // notification gate (notifyFinish below).
    var wasSilentHook = _silentHookRunning;
    _silentHookRunning = false;
    // If a silent hook just finished streaming, tell the page to clear its
    // mirrored flag so the upcoming runFinished render shows the real final
    // state. Emitted BEFORE runFinished so the port preserves ordering and the
    // page flag is false by the time renderMessages runs.
    if (wasSilentHook && typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
        AgentEvents.emit('silentHookState', { active: false, chatId: streamingChatId });
    }

    // === Finish: emit UI cleanup ===
    // Handler in 035-agent-events.js does: hideSpinner, renderChatList,
    // remove is-streaming class, renderMessages, updateContextIndicator,
    // and the paused-vs-finished pause-button branch.
    // The 'runFinished' handler owns the isFollowingScroll reset now (matching
    // main's ordering: after the pause-vs-finish UI branch, before hooks).
    AgentEvents.emit('runFinished', {
        chatId: streamingChatId,
        reason: lastApiError ? 'errored' : (isChatPaused(streamingChatId) ? 'paused' : 'completed'),
        isPaused: isChatPaused(streamingChatId),
        hasError: !!lastApiError
    });

    // Execute after-response hooks (only if not paused and no error occurred)
    // Per-chat pause check: a paused background chat must not gate hooks for the
    // chat that just finished.
    // Sub-agent chats are invisible to the human and run in service of a parent;
    // PM-facing hooks (auto-title, etc.) would burn tokens and surface nothing.
    if (!isChatPaused(streamingChatId) && !lastApiError && !(chat && chat.isSubAgent)) {
        executeAfterResponseHooks(streamingChatId);
    }
    // Hook decision made: executeAfterResponseHooks' recursive runAgent (if it
    // fired) has already synchronously re-set runningChatIds[streamingChatId].
    // Because _ranNormalCleanup is now true, the finally below will NOT clear
    // that re-set flag, so it survives and the chat stays observably running
    // for the rerun — dropping the guard here therefore leaves no idle gap. If
    // no hook fired the chat is genuinely idle and a future run-agent proceeds.
    delete _runCleanupGuard[streamingChatId];

    // Refresh credits after API calls complete
    fetchCredits();

    // Send browser notification when agent finishes in the background.
    // notifyFinish handler decides based on document.hidden / hasFocus +
    // the wasHidden-during-run flag tracked in 035. Kept distinct from
    // runFinished so it fires AFTER hooks + fetchCredits, matching the
    // original ordering.
    AgentEvents.emit('notifyFinish', {
        chatId: streamingChatId,
        isPaused: isChatPaused(streamingChatId),
        wasSilentHook: wasSilentHook,
        hasError: !!lastApiError
    });
    } finally {
        // Safety net for uncaught throws inside the agent loop body. This only
        // fires when the body threw BEFORE the normal finish cleanup ran (so
        // _ranNormalCleanup is still false and runningChatIds is still this
        // run's). Without it the streaming dot would spin forever and future
        // sends would be blocked by the early-return at function top. The
        // runCrashed event keeps the loop fully emit-only — handler in
        // 035-agent-events.js owns the chat list refresh.
        //
        // The _ranNormalCleanup gate is essential: once normal cleanup ran we
        // must NOT touch runningChatIds here. The auto-title hook re-sets it
        // for its nested run, and the old unconditional `if (runningChatIds)`
        // deleted that fresh flag + emitted a spurious runCrashed — leaving the
        // rerun with runningChatIds AND _runCleanupGuard both false, i.e. the
        // exact orphan-tool_use race this guard was meant to close.
        if (!_ranNormalCleanup && runningChatIds[streamingChatId]) {
            delete runningChatIds[streamingChatId];
            AgentEvents.emit('runCrashed', { chatId: streamingChatId });
        }
        // Never leak the cleanup guard: a throw between raising it and the
        // post-hook clear would otherwise permanently mark the chat "busy" to
        // the run-agent handler, wedging all future runs for that chat.
        delete _runCleanupGuard[streamingChatId];
    }
}

// PR1: sendMessage() (the user-input handler) moved to
// src/js/app/040-send-message.js. It's a UI entry point — reads the input
// field, shows snackbars, owns the queued-injection plumbing — so it lives
// with the other send-message helpers, not in the agent-loop file. Behavior
// is unchanged.
