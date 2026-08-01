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
// JSON-safe notice injection. Tool-result content is (nearly always) a JSON
// object string — processToolResultForCache stringifies the result (or the
// _cached outline stub). Naively doing `content + '\n\n' + notice` makes the
// stored msg.content invalid JSON, silently breaking every later
// JSON.parse(msg.content) consumer (PR link extraction ui/120-ui-utils.js:286,
// doc-id tracking ui/120-ui-utils.js:860, PR chip attribution
// ui/040-tools-settings.js:1125 — all try/catch and skip, so PR chips/links
// and doc chips vanish exactly in long chats where the notices fire). When
// the content looks like a JSON object, splice the notice in as a trailing
// string field instead (no parse/re-stringify round-trip — avoids number-
// precision drift on big payloads); any other shape falls back to the plain
// string append. The model reads the notice either way — it sits at the tail
// of the result in both forms.
function appendNoticeToContent(content, notice, key) {
    if (typeof content === 'string' && content.charAt(0) === '{' && content.charAt(content.length - 1) === '}') {
        // Only splice when the content genuinely parses as JSON — a brace-
        // wrapped non-JSON string (e.g. a code snippet in a tool result) must
        // fall through to the plain append below, not get corrupted.
        var isJson = false;
        try { JSON.parse(content); isJson = true; } catch (e) {}
        if (isJson) {
            var body = content.slice(1, -1).trim();
            return '{' + (body ? body + ',' : '') + JSON.stringify(key || '_agent_notice') + ':' + JSON.stringify(notice) + '}';
        }
    }
    return content + '\n\n' + notice;
}

// Latest context occupancy for a chat: the newest non-aggregate assistant
// message's reported input_tokens — the same scan the sub-agent nudge below
// and updateContextIndicator (ui/240-layout.js) use. Returns 0 when no
// assistant message carries metrics yet (first turns) — callers treat 0 as
// "unknown, no warning".
function getChatContextTokens(chat) {
    if (!chat || !chat.messages) return 0;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m && m.role === 'assistant' && m.metrics && m.metrics.input_tokens && !m.metrics.isAggregate) {
            return m.metrics.input_tokens;
        }
    }
    return 0;
}

// Escalating context-occupancy warning appended to EVERY tool result once
// the chat is past 50% of the assumed context window (user-editable global
// setting — getAssumedContextTokens, core/030-config.js). Three tiers:
// >=50% warns (main: delegate to sub-agents; sub: wrap up + report_to_parent
// suggesting a fresh successor); >=60% is the FINAL WARNING (the agent has
// ignored the 50% tier — stop all work and report/wrap up IMMEDIATELY);
// >=100% has NO hard stop but maximum urgency
// (stop and report NOW). Exactly ONE tier fires per tool result (highest
// matching wins — no double warnings). No one-shot/re-arm logic — fires on every tool
// result while over threshold, goes quiet if occupancy drops. Wording is
// deliberately PERCENTAGE-ONLY (never absolute token counts — the model
// must not reason about real window sizes). Applied at all three
// tool-result write sites via appendNoticeToContent.
function appendContextNotice(chat, content) {
    try {
        var limit = (typeof getAssumedContextTokens === 'function') ? getAssumedContextTokens() : 200000;
        var tokens = getChatContextTokens(chat);
        if (!limit || !tokens) return content;
        var pct = Math.round(100 * tokens / limit);
        if (pct < 50) return content;
        var isSub = !!(chat && chat.isSubAgent);
        var notice;
        if (pct >= 100) {
            notice = isSub
                ? '\u26d4 [CONTEXT EXCEEDED] Your context window is full (~' + pct + '%). STOP immediately and call report_to_parent NOW with everything you have, recommending a handoff to a fresh sub-agent for the remainder.'
                : '\u26d4 [CONTEXT EXCEEDED] Your context window is full (~' + pct + '%). Stop working now: give the user your conclusion/report immediately with what you have. Delegate anything unfinished to a sub-agent.';
        } else if (pct >= 60) {
            notice = isSub
                ? '\u26d4 [CONTEXT \u2014 FINAL WARNING] You are past 60% of your context window (~' + pct + '%). You have ignored previous warnings. STOP all work NOW and call report_to_parent immediately with what you have; the parent must hand remaining work to a fresh sub-agent.'
                : '\u26d4 [CONTEXT \u2014 FINAL WARNING] You are past 60% of your context window (~' + pct + '%). You have ignored previous warnings. STOP taking on new work NOW: wrap up and give the user your conclusion this turn, and delegate anything unfinished to sub-agents (spawn_sub_agent).';
        } else {
            notice = isSub
                ? '\u26a0\ufe0f [CONTEXT] You are past 50% of your context window (~' + pct + '%). Stop taking on new work: wrap up your current step NOW and call report_to_parent with your findings so far, recommending the parent hand any remaining work to a fresh sub-agent.'
                : '\u26a0\ufe0f [CONTEXT] You are past 50% of your context window (~' + pct + '%). Model quality degrades from here. Delegate ALL remaining heavy or verbose work to sub-agents (spawn_sub_agent) and keep this thread lean \u2014 orchestrate, don\'t do.';
        }
        return appendNoticeToContent(content, notice, '_context_notice');
    } catch (_) { return content; }
}

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
        // REG376-2: stamp injection-built user rows. This push can JOIN several
        // queued texts (and context pointers) into one row via '\n\n', so the
        // port-bridge flap dedup (_seenInSwTail, worker/130-port-bridge.js)
        // applies paragraph-boundary containment — but ONLY to rows carrying
        // this stamp. Organic user rows keep exact-equality dedup, or a
        // genuinely-new re-send equal to a paragraph of an earlier
        // multi-paragraph message would be silently dropped. The flag survives
        // IDB persistence (structured clone) and port postMessage.
        chat.messages.push({ role: 'user', content: text, injected: true });
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
    // WAKE-DUR: drop the durable mirror of any wake notice contained in the
    // text just flushed into chat.messages (checkpointed at the next tool
    // boundary). Targeted clear — notices persisted AFTER an SW death wiped
    // this in-memory queue are NOT in this flush and must survive for the
    // heartbeat drain (drainPendingWakes, core/097-sub-agent-registry.js).
    if (chatId && text && typeof clearDeliveredPendingWakes === 'function') {
        try { clearDeliveredPendingWakes(chatId, text); } catch (e) { /* best-effort */ }
    }
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
                processed.content = appendContextNotice(chat, processed.content);
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
    // PR390-FU-1: the uncaught throw that lands us in the finally's crash arm,
    // captured by the catch below. The runCrashed emit forwards it so the SW
    // handler (105-subagent-broadcast.js) and onSubAgentRunFinished can report
    // the REAL message and run transient-crash classification (auto-retry) —
    // with a bare {chatId} emit, that consumer's `e.error` branch was dead and
    // fallback-path crashes were never classified transient.
    var _loopCrashError = null;
    // try/finally guarantees the per-chat running flag is cleared even if the
    // body throws — without this, an uncaught error would leave the streaming
    // dot spinning forever AND block future sends via the early-return at top.
    try {
    chat = chats[streamingChatId];
    // CKPT-POISON guard: refuse to start a run for a chat that is not loaded.
    // This MUST happen before the runStarted emit below — the checkpoint
    // listener (worker/110-agent-checkpoint.js) reacts to runStarted by
    // writing a durable {status:'running'} record, and for a missing chat
    // that record is a poison pill: the 30s agent-heartbeat resume scan
    // re-runs it, crashes here again, and the crash's own runStarted
    // refreshes the record forever (the recurring "Cannot read properties
    // of undefined (reading 'messages')" class). Throwing routes through
    // the catch/finally below: runningChatIds is cleared and runCrashed
    // carries the real message, so pool/resume/wake callers still settle
    // their records exactly as they do for any other loop crash.
    // TOMBSTONE (last line of defence): a `_deleted` entry is the tombstone the
    // 'update-chat' explicit-delete lane parks in `chats`
    // (worker/130-port-bridge.js) when the user deletes a chat. It is TRUTHY, so
    // the !chat guard alone lets a run start on a deleted chat — and that run's
    // assistant message would give the tombstone messages.length > 0, re-admitting
    // it to `desired` (worker/115-storage.js:116), dropping it out of the
    // unbudgeted explicit-delete lane and RE-PUTTING the row (resurrection).
    // Every caller (checkpoint resume, after-response hook, send-message) funnels
    // through here, so refuse it here too.
    if (!chat || chat._deleted) {
        throw new Error('runAgent: chat ' + streamingChatId + ' is '
            + (chat ? 'deleted (tombstone)' : 'not loaded in this context')
            + ' — refusing to start');
    }
    isBackgroundRun = !!(chat && chat.isBackground);
    // Clear any stale API error left from a PREVIOUS run of THIS chat so the
    // finish path below can't misreport a fresh successful run as errored.
    // Another chat's error is left alone — the finish decisions are keyed on
    // chatId via _runApiError (see the finish section).
    if (lastApiError && lastApiError.chatId === streamingChatId) lastApiError = null;
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

            if (!result) result = { success: false, error: 'Tool returned no result' };
            delete result._denied;
            var screenshotMsg = result._screenshotMessage;
            var screenshotMsgs = result._screenshotMessages;
            delete result._screenshotMessage;
            delete result._screenshotMessages;
            var processed = processToolResultForCache(streamingChatId, tc.id, toolName, result);
            processed.content = appendContextNotice(chat, processed.content);
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
            // handler owns the isRunning write. Do NOT bare-
            // return here: that skipped runFinished entirely, so the finally
            // emitted a spurious runCrashed, the checkpoint stayed 'running'
            // (the resume scan then re-armed a user-paused chat after SW
            // restart — pause flags are in-memory only), and the page's
            // `await runAgent()` promise (resolved only by runFinished) hung.
            // Emit 'paused' and fall through: the while-gate below fails on
            // the same flag, so the normal finish path runs and emits
            // runFinished{isPaused:true}, mirroring the mid-loop pause break.
            AgentEvents.emit('paused', { chatId: streamingChatId });
        }
    }

    // THROTTLE-RETRY (main chats): budget for in-loop retries of transient
    // shed-load stream errors — see the classifier in the catch below. Reset
    // after every successful stream so a long run isn't capped by blips that
    // happened dozens of calls ago; the budget only guards against a
    // persistently saturated endpoint.
    var throttleRetries = 0;
    var AGENT_THROTTLE_MAX_RETRIES = 4;

    while (!isChatPaused(streamingChatId)) {
        // QUEUE-SYNC-FIX (defense-in-depth): a user send can land in the gap
        // between loop steps — no stream controller registered (deleted in
        // callLLMStreaming's finally) and no tool resolver armed — so the
        // resolver/abort fired by _handlePanelSendMessage are no-ops and only
        // the userInterruptedChats flag survives. Consume it and flush the
        // queued message NOW instead of streaming a whole extra turn first.
        if (userInterruptedChats[streamingChatId]) {
            userInterruptedChats[streamingChatId] = false;
            if (flushPendingInjection(chat)) {
                saveChatsToStorage();
                AgentEvents.emit('userInjected', { chatId: streamingChatId });
            }
        }
        AgentEvents.emit('turnStarted', { chatId: streamingChatId, turn: lastUserMsgIndex, callNumber: callNumber + 1 });
        callNumber++;

        // Reset metrics and start timing for this request. Provider is
        // resolved per-chat (chat.provider — sub-agents pinned at spawn —
        // else the global currentProvider), matching callLLMStreaming.
        var currentProviderObj = getProviderById(resolveChatProviderName(streamingChatId));
        // PER-CALL metrics object: the SW runs multiple chats concurrently and the
        // old shared `lastRequestMetrics` global got clobbered across interleaved
        // streams (chat A's usage landing on chat B's assistant message — which
        // also corrupted the sub-agent nudge's token reading). Each turn now owns
        // its object and threads it into callLLMStreaming; the global is kept
        // pointing at the most recent request purely for debugging.
        var reqMetrics = { startTime: Date.now(), callNumber: callNumber, providerName: currentProviderObj ? currentProviderObj.name : 'Unknown' };
        lastRequestMetrics = reqMetrics;

        // Sub-agent nudge: when the running context crosses the threshold, append a
        // reminder to delegate heavy/verbose work to sub-agents (model quality
        // degrades at long context). Pushed as a trailing `context` message
        // so buildAPIMessages merges it onto the END of the last user turn — it comes
        // LAST and sits AFTER the prompt-cache breakpoints, so the cached prefix is
        // never invalidated (only this short tail is uncached). It is deliberately
        // NOT placed in the system prompt (that would bust the whole cache every
        // turn). Skipped for sub-agent chats. RE-ARMING: after firing at N tokens it
        // fires again once the context grows past N + SUBAGENT_NUDGE_REARM_TOKENS
        // (each firing is a fresh appended message — history is never mutated, so
        // the prompt cache is unaffected). chat._ctxSubAgentNudgedAt records the
        // token count at the last firing; the legacy one-shot boolean
        // _ctxSubAgentNudgeSent (persisted on older chats) is treated as "nudged
        // at the threshold".
        if (!chat.isSubAgent &&
            typeof SUBAGENT_NUDGE_TOKEN_THRESHOLD === 'number' && SUBAGENT_NUDGE_TOKEN_THRESHOLD > 0) {
            var _ctxTokens = getChatContextTokens(chat);
            // Context-size surfacing: store the estimate on the chat row so
            // the page header can render the context-budget chip (see
            // updateContextIndicator in ui/240-layout.js). Updated once per
            // LLM call, persisted with the next saveChatsToStorage — no
            // timers, no extra events.
            chat._ctxTokens = _ctxTokens;
            var _nudgedAt = (typeof chat._ctxSubAgentNudgedAt === 'number') ? chat._ctxSubAgentNudgedAt
                : (chat._ctxSubAgentNudgeSent ? SUBAGENT_NUDGE_TOKEN_THRESHOLD : 0);
            var _rearmStep = (typeof SUBAGENT_NUDGE_REARM_TOKENS === 'number' && SUBAGENT_NUDGE_REARM_TOKENS > 0)
                ? SUBAGENT_NUDGE_REARM_TOKENS : Infinity;
            var _nudgeDue = (_nudgedAt > 0) ? (_nudgedAt + _rearmStep) : SUBAGENT_NUDGE_TOKEN_THRESHOLD;
            if (_ctxTokens >= _nudgeDue) {
                chat.messages.push({
                    role: 'context',
                    content: '[Context is now ~' + Math.round(_ctxTokens / 1000) + 'k tokens. Model performance degrades as context grows — strongly prefer delegating heavy or verbose work (file/grep dumps, multi-record audits, deep log scans, iterative debugging) to sub-agents via spawn_sub_agent so their raw output stays out of this conversation. Keep this context lean.]'
                });
                chat._ctxSubAgentNudgedAt = _ctxTokens;
            }
        }

        // Progress-card nudge: the PROGRESS UPDATES policy asks for an
        // update_action_state card once a run exceeds ~3 tool calls, but that
        // static system-prompt paragraph gets ignored on long runs (background
        // Action chats comply because startAction() injects an explicit "You
        // MUST" user instruction — foreground chats have no such enforcement,
        // hence cards appearing inconsistently despite a multi-step plan).
        // Mirror the sub-agent nudge above: when this user turn has accumulated
        // PROGRESS_NUDGE_TOOL_CALLS tool calls with NO update_action_state among
        // them, ride a one-line `context` reminder along with the NEXT scheduled
        // LLM call (buildAPIMessages merges trailing context onto the end of the
        // last user turn — after the prompt-cache breakpoints, so the cached
        // prefix stays valid and NO extra endpoint round trip is spent). Re-arms
        // every PROGRESS_NUDGE_REARM_CALLS further calls while the model still
        // has not created a card; goes quiet for the rest of the turn the moment
        // it has. Firings are counted statelessly by scanning for the tagged
        // `_progressNudge` rows in this turn's history — no separate persisted
        // counter to drift across SW restarts. Answer-card hook calls
        // (set_chat_title/set_tldr/set_links) are excluded from the count so a
        // failed-hook retry pass at the very end can never trip a useless nudge.
        if (typeof PROGRESS_NUDGE_TOOL_CALLS === 'number' && PROGRESS_NUDGE_TOOL_CALLS > 0) {
            var _pnToolCalls = 0, _pnHasCard = false, _pnNudges = 0;
            var _pnSkip = { set_chat_title: true, set_tldr: true, set_links: true, set_caveat: true };
            for (var _pi = chat.messages.length - 1; _pi >= 0; _pi--) {
                var _pm = chat.messages[_pi];
                if (!_pm) continue;
                if (_pm.role === 'user') break; // start of this turn
                if (_pm.role === 'context' && _pm._progressNudge) _pnNudges++;
                if (_pm.role === 'assistant' && _pm.tool_calls && _pm.tool_calls.length) {
                    for (var _pj = 0; _pj < _pm.tool_calls.length; _pj++) {
                        var _ptn = _pm.tool_calls[_pj] && _pm.tool_calls[_pj].function
                            && _pm.tool_calls[_pj].function.name;
                        if (_ptn === 'update_action_state') { _pnHasCard = true; break; }
                        if (!_pnSkip[_ptn]) _pnToolCalls++;
                    }
                    if (_pnHasCard) break;
                }
            }
            var _pnRearm = (typeof PROGRESS_NUDGE_REARM_CALLS === 'number' && PROGRESS_NUDGE_REARM_CALLS > 0)
                ? PROGRESS_NUDGE_REARM_CALLS : Infinity;
            // _pnNudges > 0 guard: 0 * Infinity is NaN, which would poison the
            // comparison and silently disable the very first firing when the
            // re-arm is configured off.
            var _pnDue = PROGRESS_NUDGE_TOOL_CALLS + (_pnNudges > 0 ? _pnNudges * _pnRearm : 0);
            if (!_pnHasCard && _pnToolCalls >= _pnDue) {
                chat.messages.push({
                    role: 'context',
                    _progressNudge: true,
                    content: '[Progress check: ' + _pnToolCalls + ' tool calls this turn and no update_action_state progress card yet. Per the PROGRESS UPDATES policy, create one NOW — batch the update_action_state call ALONGSIDE your next tool call(s) in the same response (never spend a standalone response on it), passing the full tasks array with completed steps backfilled as done. If the work is finishing instead, include a final state:"done" update (with an output summary) together with your answer-card hook calls.]'
                });
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
            // R9: track what the last interval tick saw so we can skip the emit
            // entirely when nothing changed — the per-kind deltas (thinking/text/
            // tool_input) already fire on every real change, so an unchanged tick
            // is pure render noise.
            var _ivLastContentLen = -1;
            var _ivLastThinkingLen = -1;
            var _ivLastTcCount = -1;
            var _ivLastArgsLen = -1;
            streamUpdateInterval = setInterval(function() {
                // Force UI update while streaming to show activity
                if (assistantMsg.isStreaming) {
                    var _ivContentLen = assistantMsg.content ? assistantMsg.content.length : 0;
                    var _ivThinkingLen = assistantMsg.thinking ? assistantMsg.thinking.length : 0;
                    var _ivTcCount = assistantMsg.tool_calls ? assistantMsg.tool_calls.length : 0;
                    var _ivArgsLen = 0;
                    if (assistantMsg.tool_calls) {
                        for (var _ivi = 0; _ivi < assistantMsg.tool_calls.length; _ivi++) {
                            var _ivTc = assistantMsg.tool_calls[_ivi];
                            if (_ivTc && _ivTc.function && _ivTc.function.arguments) {
                                _ivArgsLen += _ivTc.function.arguments.length;
                            }
                        }
                    }
                    if (_ivContentLen === _ivLastContentLen &&
                        _ivThinkingLen === _ivLastThinkingLen &&
                        _ivTcCount === _ivLastTcCount &&
                        _ivArgsLen === _ivLastArgsLen) {
                        return; // R9: nothing changed since last tick — skip the emit
                    }
                    _ivLastContentLen = _ivContentLen;
                    _ivLastThinkingLen = _ivThinkingLen;
                    _ivLastTcCount = _ivTcCount;
                    _ivLastArgsLen = _ivArgsLen;
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
                    assistantMsg.content = final.content || '';
                    assistantMsg.tool_calls = final.tool_calls;
                    assistantMsg.reasoning_details = final.reasoning_details; // Preserve for OpenRouter API continuity
                    assistantMsg.isStreaming = false;
                },
                function(status, count) {
                    // Stream status callback - model is processing
                },
                chat.id,
                reqMetrics
            );

            clearInterval(streamUpdateInterval);
            throttleRetries = 0; // THROTTLE-RETRY: successful stream refills the budget
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

            // THROTTLE-RETRY: Anthropic sheds load two ways — an HTTP 529
            // BEFORE the stream (already retried with backoff at the transport,
            // runClaudeOAuthStream in background.js) and an SSE error event
            // MID-stream on an HTTP 200 ("Overloaded"), which reaches this
            // catch and used to KILL the run on the first hit. Sub-agents
            // survive this class via 097's throttle re-queue; this gives main
            // chats parity. Retry in-loop with jittered exponential backoff:
            // the partial assistant message is dropped first, so the request
            // prefix is unchanged and the retry mostly re-hits the prompt
            // cache. After the wait, `continue` re-enters through the loop
            // head + while-gate, so a pause/stop/send during the backoff
            // behaves exactly like one between turns. Non-OAuth providers
            // benefit too (OpenRouter 429/502/503 bodies match the same
            // classifier). Budget exhausted → fall through to the normal
            // error path below.
            // Numeric codes are anchored to a status/http/code/error/failed
            // prefix (or start-of-string) — a bare \b(429|...)\b matched ANY
            // standalone number in an error body (e.g. "row 502 not found")
            // and burned retries on non-throttle errors. `failed` covers our
            // own transport shape "API request failed: 502 Bad Gateway"
            // (app/010-llm-streaming.js).
            // F5-1: an HTML-bodied 5xx from the proxy reaches here as a generic
            // "API request failed: <html…>" message the anchored numeric regex
            // can't match, so trust the HTTP status stamped by
            // app/010-llm-streaming.js FIRST, then fall back to the message
            // regex. The regex is deliberately NOT loosened (its anchor kills
            // false positives like "row 502 not found").
            var _throttleStatus = e && e._httpStatus;
            var _throttleClass = (_throttleStatus === 429 || _throttleStatus === 502 || _throttleStatus === 503 || _throttleStatus === 529)
                || /overloaded|rate.?limit|too many requests|temporarily unavailable|(?:^|\b(?:status|http|code|error|failed)\s*[:=]?\s*)(?:429|502|503|529)\b/i
                .test(String((e && e.message) || e));
            if (_throttleClass && throttleRetries < AGENT_THROTTLE_MAX_RETRIES) {
                throttleRetries++;
                if (chat.messages[chat.messages.length - 1] === assistantMsg) {
                    chat.messages.pop();
                }
                var _waitMs = Math.min(4000 * Math.pow(2, throttleRetries - 1), 30000);
                // Jitter: concurrent chats shed at the same instant must not
                // retry in lockstep (same rationale as the transport backoff).
                _waitMs = Math.round(_waitMs * (0.7 + Math.random() * 0.6));
                console.warn('[agent-loop] throttle-class stream error for chat ' + streamingChatId
                    + ' ("' + String((e && e.message) || e).slice(0, 120) + '") — retry '
                    + throttleRetries + '/' + AGENT_THROTTLE_MAX_RETRIES + ' in ' + _waitMs + 'ms');
                // Same event shape as the transport-level backoff status, so the
                // page renders the live "retrying in Ns" countdown in the chat's
                // status row instead of a dead spinner.
                AgentEvents.emit('llmTransportStatus', {
                    message: 'AI endpoint saturated — retrying (' + throttleRetries + '/' + AGENT_THROTTLE_MAX_RETRIES + ')',
                    status: 'backoff',
                    reason: 'overloaded',
                    waitMs: _waitMs,
                    chatId: streamingChatId
                });
                await new Promise(function(r) { setTimeout(r, _waitMs); });
                continue;
            }

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
            // If this chat is a background Action, the PM only sees the action
            // button — a silent crash leaves it spinning forever with no result.
            // Best-effort: flag the card as errored so the user is told that the
            // run died (and, if no tool calls happened, that nothing ran at all).
            if (chat && chat.actionId) {
                try {
                    executeTool('update_action_state', {
                        state: 'error',
                        icon: 'alert',
                        label: ('Crashed: ' + (errEnv.message || 'unknown error')).slice(0, 60),
                        status_message: 'Agent loop crashed — marking action as errored',
                        output: '⚠️ **The agent crashed before completing this action.**\n\nError: `' + String(errEnv.message || 'unknown').slice(0, 300) + '`\n\nNo final result was produced. Open the action chat to see how far it got — if there are no tool calls in the transcript, nothing was executed on the instance.'
                    }, null, { chatId: streamingChatId }).catch(function() { /* no panel attached — nothing to paint */ });
                } catch (e3) { /* best-effort only */ }
            }
            break;
        }

        assistantMsg.isStreaming = false;
        if (assistantMsg.thinking) {
            assistantMsg.thinkingCollapsed = true;
        }

        // Capture performance metrics (per-call object — see reqMetrics above;
        // never read the shared global here, concurrent chats clobber it)
        if (reqMetrics) {
            reqMetrics.endTime = Date.now();
            reqMetrics.duration = reqMetrics.endTime - reqMetrics.startTime;
            
            // Accumulate to aggregate metrics
            aggregateMetrics.callCount++;
            aggregateMetrics.duration += reqMetrics.duration || 0;
            aggregateMetrics.input_tokens += reqMetrics.input_tokens || 0;
            aggregateMetrics.output_tokens += reqMetrics.output_tokens || 0;
            aggregateMetrics.cache_read_tokens += reqMetrics.cache_read_tokens || 0;
            aggregateMetrics.cache_creation_tokens += reqMetrics.cache_creation_tokens || 0;
            aggregateMetrics.cache_write_tokens += reqMetrics.cache_write_tokens || 0;
            aggregateMetrics.reasoning_tokens += reqMetrics.reasoning_tokens || 0;
            aggregateMetrics.cost += reqMetrics.cost || 0;
            
            // Copy metrics but exclude requestBody to prevent memory bloat
            // (requestBody contains full conversation history with base64 images)
            var metricsToStore = Object.assign({}, reqMetrics);
            delete metricsToStore.requestBody;
            assistantMsg.metrics = metricsToStore;

            // Orchestrator §5: roll this call's usage onto the sub-agent
            // record ({calls, input/output tokens, cost, by_provider}) so
            // agent_status and the Workers-strip card can show per-sub cost
            // without reading the transcript. One call per LLM request —
            // this block runs exactly once per finished stream.
            if (chat.isSubAgent && typeof SubAgents !== 'undefined' && SubAgents.recordLLMUsage) {
                try { SubAgents.recordLLMUsage(streamingChatId, reqMetrics); }
                catch (e) { console.warn('recordLLMUsage hook threw', e); }
            }
        }

        if (!assistantMsg.thinking) delete assistantMsg.thinking;
        if (!assistantMsg.content) assistantMsg.content = '';

        // agent_status live-output pointer: stamp the sub record with this
        // turn's finalized assistant text (cheap pointer on the record, no
        // transcript reads) so the parent's agent_status can show what the
        // sub last SAID while it is still running / before it reports.
        // Empty content (tool-call-only turn) is skipped inside the hook.
        if (chat.isSubAgent && assistantMsg.content && typeof SubAgents !== 'undefined' && SubAgents.recordAssistantMessage) {
            try { SubAgents.recordAssistantMessage(streamingChatId, assistantMsg.content); }
            catch (e) { console.warn('recordAssistantMessage hook threw', e); }
        }

        // Track model and accumulate cost on chat
        chat.model = currentProvider;
        chat.totalCost = (chat.totalCost || 0) + (reqMetrics.cost || 0);

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
        // Answer-card hook tools (set_chat_title / set_tldr / set_links) are
        // fire-and-forget: their results carry no information the model needs.
        // When EVERY tool call in this turn is one of them and all succeed,
        // the run ends after executing them instead of sending the results
        // back to the LLM for one more (pure-waste) round-trip — see the
        // `_answerCardOnlyTurn` break below. Any failure clears the flag so
        // the model still sees the error and can retry.
        var ANSWER_CARD_TOOLS = { set_chat_title: true, set_tldr: true, set_links: true, set_caveat: true };
        // update_action_state is fire-and-forget too ({success:true} carries
        // nothing the model needs), so a FINAL progress-card update batched with
        // the answer-card hooks must not force an extra LLM pass: the turn also
        // counts as answer-card-only when every call is a hook OR
        // update_action_state AND at least one true hook is present. The
        // hook-presence guard keeps mid-run turns that call ONLY
        // update_action_state on today's path (results echoed, run continues) —
        // ending the run there would abort unfinished work.
        var _acSawHook = false;
        var _answerCardOnlyTurn = assistantMsg.tool_calls.every(function(_ac) {
            var _acn = _ac.function && _ac.function.name;
            if (ANSWER_CARD_TOOLS[_acn]) { _acSawHook = true; return true; }
            return _acn === 'update_action_state';
        }) && _acSawHook;
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
                _answerCardOnlyTurn = false; // let the model see the parse error
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

            if (!result) result = { success: false, error: 'Tool returned no result' };
            if (result.success === false) _answerCardOnlyTurn = false; // failed hook call → model gets a retry pass
            delete result._denied;
            var screenshotMsg = result._screenshotMessage;
            var screenshotMsgs = result._screenshotMessages;
            delete result._screenshotMessage;
            delete result._screenshotMessages;
            var processed = processToolResultForCache(streamingChatId, tc.id, toolName, result);
            processed.content = appendContextNotice(chat, processed.content);
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
        var _injectedDuringTools = false;
        if (!isChatPaused(streamingChatId) && flushPendingInjection(chat)) {
            _injectedDuringTools = true;
            saveChatsToStorage();
            AgentEvents.emit('userInjected', { chatId: streamingChatId });
        }

        if (isChatPaused(streamingChatId)) break;
        // Answer-card-only turn: every tool call was set_chat_title / set_tldr /
        // set_links, all succeeded, and no user message arrived mid-turn — end
        // the run here; the results are recorded in the transcript but no extra
        // LLM round-trip is made just to acknowledge them.
        // Guard: only skip the round-trip on an after-response HOOK turn, or
        // when the assistant already streamed visible text. A user-requested
        // rename answered with a lone content-less set_chat_title call must
        // still round-trip so the user gets a verbal reply.
        if (_answerCardOnlyTurn && !_injectedDuringTools) {
            var _acHasText = typeof assistantMsg.content === 'string' && assistantMsg.content.trim().length > 0;
            var _acHookTurn = false;
            for (var _hi = chat.messages.length - 1; _hi >= 0; _hi--) {
                if (chat.messages[_hi].role === 'user') { _acHookTurn = !!chat.messages[_hi].isHookMessage; break; }
            }
            if (_acHookTurn || _acHasText) break;
        }
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
    // This run's error ONLY: the global lastApiError can hold another chat's
    // error (the SW runs chats concurrently) or a stale one from an earlier
    // run — keying the finish decisions below on it misreported successful
    // runs as errored, suppressed hooks, and fed parents false sub errors.
    var _runApiError = (lastApiError && lastApiError.chatId === streamingChatId) ? lastApiError : null;
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
        // PR383-R4 (loss window 1): also preserve the entry for a PARENT chat
        // that has spawned sub-agents. _notifySubLifecycle (core/097) stashes
        // model-visible lifecycle notices into pendingInjectionsByChatId while
        // this loop is live; one stashed after the loop's last
        // flushPendingInjection would be destroyed by the delete below (sub
        // chats already had the onSubAgentRunFinished re-queue backstop —
        // parent chats had none). A preserved entry is consumed by the next
        // run's flushPendingInjection. Deliberately includes TERMINAL subs:
        // a force-stop/crash notice fires right as the sub turns terminal,
        // which is exactly this loss window (tombstones GC after ~1h, so the
        // preservation is bounded to sub-spawning chats).
        var _hasOwnSubs = false;
        try {
            if (typeof SubAgents !== 'undefined' && SubAgents.listAll) {
                _hasOwnSubs = SubAgents.listAll().some(function(r) {
                    return r && r.parent_chat_id === streamingChatId;
                });
            }
        } catch (e) { /* best-effort — fall back to legacy delete */ }
        if (!(chat && chat.isSubAgent) && !_hasOwnSubs) {
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
        var _finishReason = _runApiError ? 'errored' : 'completed';
        try { SubAgents.onSubAgentRunFinished(streamingChatId, { reason: _finishReason, error: _runApiError || null }); } catch (e) { console.warn('onSubAgentRunFinished hook threw', e); }
    }
    // Reset THIS chat's silent hook flag before the UI handler runs the final
    // render so messages are properly displayed. Per-chat map, not a global
    // boolean: chats run concurrently in the SW, and the old shared flag let
    // one chat's finish steal another chat's silent-hook window — a NORMAL
    // run finishing during another chat's hook got wasSilentHook=true (its
    // notification + unseen bell were suppressed) while the hook chat itself
    // then never emitted {active:false}.
    var _hadSilentHookFlag = !!(typeof _silentHookRunningByChat !== 'undefined' && _silentHookRunningByChat[streamingChatId]);
    if (_hadSilentHookFlag) delete _silentHookRunningByChat[streamingChatId];
    // wasSilentHook additionally requires the turn we just answered to STILL
    // be the hook instruction: when a user's interrupting send merges a REAL
    // message into the hook run, the answer the user is actually waiting for
    // would otherwise finish under the hook flag and its notification /
    // unseen bell would be wrongly suppressed (036:notifyFinish gates).
    var _lastUserMsgForHook = null;
    if (chat && chat.messages) {
        for (var _hui = chat.messages.length - 1; _hui >= 0; _hui--) {
            if (chat.messages[_hui].role === 'user') { _lastUserMsgForHook = chat.messages[_hui]; break; }
        }
    }
    var wasSilentHook = _hadSilentHookFlag && !!(_lastUserMsgForHook && _lastUserMsgForHook.isHookMessage);
    // If a silent hook was running for THIS chat, tell the page to clear its
    // mirrored per-chat flag so the upcoming runFinished render shows the real
    // final state. Emitted BEFORE runFinished so the port preserves ordering
    // and the page flag is clear by the time renderMessages runs. Keyed on the
    // raw flag (not wasSilentHook) so an interrupted hook still cleans up.
    if (_hadSilentHookFlag && typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
        AgentEvents.emit('silentHookState', { active: false, chatId: streamingChatId });
    }

    // === Finish: emit UI cleanup ===
    // Handler in 035-agent-events.js does: hideSpinner, renderChatList,
    // remove is-streaming class, renderMessages, updateContextIndicator,
    // and the paused-vs-finished pause-button branch.
    AgentEvents.emit('runFinished', {
        chatId: streamingChatId,
        reason: _runApiError ? 'errored' : (isChatPaused(streamingChatId) ? 'paused' : 'completed'),
        isPaused: isChatPaused(streamingChatId),
        hasError: !!_runApiError
    });

    // Execute after-response hooks (only if not paused and no error occurred)
    // Per-chat pause check: a paused background chat must not gate hooks for the
    // chat that just finished.
    // Sub-agent chats are invisible to the human and run in service of a parent;
    // PM-facing hooks (auto-title, etc.) would burn tokens and surface nothing.
    if (!isChatPaused(streamingChatId) && !_runApiError && !(chat && chat.isSubAgent)) {
        // typeof guard: the page bundle no longer carries a (dead) copy of
        // executeAfterResponseHooks — only the SW bundle defines it
        // (worker/020-page-stubs.js), and only the SW runs this loop.
        if (typeof executeAfterResponseHooks === 'function') executeAfterResponseHooks(streamingChatId);
    }
    // Hook decision made: executeAfterResponseHooks' recursive runAgent (if it
    // fired) has already synchronously re-set runningChatIds[streamingChatId].
    // Because _ranNormalCleanup is now true, the finally below will NOT clear
    // that re-set flag, so it survives and the chat stays observably running
    // for the rerun — dropping the guard here therefore leaves no idle gap. If
    // no hook fired the chat is genuinely idle and a future run-agent proceeds.
    delete _runCleanupGuard[streamingChatId];

    // REG391-2: end-of-run wake-on-report race. A sub can call report_to_parent
    // in the window between this loop's last flushPendingInjection (line 1085)
    // and the cleanup above. _wakeParentOnReport sees the parent loop still
    // `live` (runningChatIds set until line 1127), so it only QUEUES the notice
    // into pendingInjectionsByChatId and starts no run. The preserve-for-parent
    // logic above (PR383-R4) keeps that entry instead of deleting it — but for
    // a TOP-LEVEL parent nothing ever consumes it: sub-agent chats get the
    // onSubAgentRunFinished re-queue backstop, top-level chats had none, so the
    // report stalled until the user's next message (the exact symptom PR #389
    // set out to fix). Drain it here: if this non-sub chat finished cleanly,
    // is not paused, no hook already restarted it, and a pending injection is
    // still parked, start a follow-up run so the parent actually sees the
    // report. Mirrors _wakeParentOnReport's idle top-level arm.
    try {
        if (chat && !chat.isSubAgent
            && typeof pendingInjectionsByChatId !== 'undefined') {
            var _pendFollow = pendingInjectionsByChatId[streamingChatId];
            var _pendHas = !!(_pendFollow && (_pendFollow.text || (_pendFollow.images && _pendFollow.images.length)));
            if (_pendHas && !_runApiError
                && !isChatPaused(streamingChatId)
                && !runningChatIds[streamingChatId]
                && typeof runAgent === 'function') {
                Promise.resolve()
                    .then(function() { return runAgent(streamingChatId); })
                    .catch(function(err) { console.warn('[agent-loop] follow-up run for parked report failed', streamingChatId, err); });
            } else if (_pendHas && _pendFollow.text
                && (_runApiError || isChatPaused(streamingChatId))
                && typeof persistPendingWake === 'function') {
                // WAKE-DUR (Mode B): a run that ended in an API error (429/
                // overload) or paused skips the follow-up run above — the
                // queued report would sit in volatile SW memory until the
                // user's next message (or die with the SW). Persist it
                // durably; the agent-heartbeat drain (drainPendingWakes,
                // core/097) delivers it once the chat is idle/unpaused.
                // persistPendingWake dedupes by text containment against the
                // copy the live-parent branch already persisted (Mode A).
                persistPendingWake(streamingChatId, _pendFollow.text, null);
            }
        }
    } catch (e) { console.warn('[agent-loop] end-of-run report drain check threw', e); }

    // Refresh credits after API calls complete
    fetchCredits();
    // Also pull fresh usage from claude.ai (throttled ~60s inside
    // refreshClaudeOAuthUsage) so extra-usage-only subscriptions update the pill
    // on each answer, not just on init/visibility. No-op for non-Claude providers
    // and while on cooldown.
    if (typeof refreshClaudeOAuthUsage === 'function') refreshClaudeOAuthUsage();

    // Send browser notification when agent finishes in the background.
    // notifyFinish handler decides based on document.hidden / hasFocus +
    // the wasHidden-during-run flag tracked in 035. Kept distinct from
    // runFinished so it fires AFTER hooks + fetchCredits, matching the
    // original ordering.
    AgentEvents.emit('notifyFinish', {
        chatId: streamingChatId,
        isPaused: isChatPaused(streamingChatId),
        wasSilentHook: wasSilentHook,
        hasError: !!_runApiError
    });
    } catch (_loopErr) {
        // PR390-FU-1: stash for the finally's runCrashed emit, then rethrow
        // UNCHANGED — callers (e.g. _drainPool's .catch → _markErrored) still
        // see the original error; this catch adds no behavior of its own.
        _loopCrashError = _loopErr;
        throw _loopErr;
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
            // PR390-FU-1: carry the real error (when we have one) so the SW
            // sub-agent crash handler reports an accurate message and can
            // classify transient errors for the single auto-retry. Consumers
            // fall back to a generic message when error is null.
            AgentEvents.emit('runCrashed', {
                chatId: streamingChatId,
                error: _loopCrashError
                    ? { message: (_loopCrashError && _loopCrashError.message) ? _loopCrashError.message : String(_loopCrashError) }
                    : null
            });
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
