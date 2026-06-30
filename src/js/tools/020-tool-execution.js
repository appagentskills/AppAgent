// =============================================================
// Image utilities — base64 compress / resize.
//
// In the page bundle, these use Image() + <canvas> + canvas.toDataURL.
// In the SW context (no DOM), they use OffscreenCanvas + createImageBitmap
// + canvas.convertToBlob and a manual base64 encode (no FileReader in SW).
// Same external contract: compressBase64Image / resizeImageIfNeeded
// return promises with the same shape.
// =============================================================

// Convert a base64 data URL (data:image/...;base64,XXXX) to a Blob.
function _b64DataUrlToBlob(dataUrl) {
    var commaIdx = dataUrl.indexOf(',');
    var meta = commaIdx >= 0 ? dataUrl.substring(0, commaIdx) : '';
    var b64 = commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : dataUrl;
    var mime = 'application/octet-stream';
    var m = meta.match(/^data:([^;]+);base64/i);
    if (m) mime = m[1];
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

// Convert a Blob to a base64 data URL. Works without FileReader.
async function _blobToBase64DataUrl(blob) {
    var buf = await blob.arrayBuffer();
    var bytes = new Uint8Array(buf);
    // Chunked binary-string accumulation — large images blow the call stack
    // if we use String.fromCharCode.apply(null, bytes) directly.
    var binary = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(binary);
}

// Compress a base64 image if its decoded size exceeds maxBytes.
// Re-encodes as JPEG with decreasing quality until under limit.
// Returns the original base64 if already under limit.
async function compressBase64Image(base64, maxBytes) {
    maxBytes = maxBytes || 4718592; // 4.5MB default (safe margin under 5MB API limit)
    var commaIdx = base64.indexOf(',');
    var b64Part = commaIdx >= 0 ? base64.substring(commaIdx + 1) : base64;
    var decodedSize = Math.floor(b64Part.length * 3 / 4);
    if (b64Part.endsWith('==')) decodedSize -= 2;
    else if (b64Part.endsWith('=')) decodedSize -= 1;
    if (decodedSize <= maxBytes) return base64;

    var blob = _b64DataUrlToBlob(base64);
    var bitmap = await createImageBitmap(blob);
    var canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    var ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    var result = base64;
    var qualities = [0.85, 0.7, 0.5, 0.3];
    for (var i = 0; i < qualities.length; i++) {
        var outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: qualities[i] });
        if (outBlob.size <= maxBytes || i === qualities.length - 1) {
            result = await _blobToBase64DataUrl(outBlob);
            break;
        }
    }
    return result;
}

// Resize a base64 image so neither dimension exceeds maxDim.
// Also compresses if the result exceeds 5MB API limit.
// Returns Promise<{ base64, width, height }>. No-op if already within limits.
async function resizeImageIfNeeded(base64, maxDim) {
    maxDim = maxDim || 1600;
    try {
        var blob = _b64DataUrlToBlob(base64);
        var bitmap = await createImageBitmap(blob);
        var w = bitmap.width;
        var h = bitmap.height;
        if (w <= maxDim && h <= maxDim) {
            bitmap.close();
            var compressed = await compressBase64Image(base64);
            return { base64: compressed, width: w, height: h };
        }
        var scale = Math.min(maxDim / w, maxDim / h);
        var newW = Math.round(w * scale);
        var newH = Math.round(h * scale);
        var canvas = new OffscreenCanvas(newW, newH);
        var ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, newW, newH);
        bitmap.close();
        var resizedBlob = await canvas.convertToBlob({ type: 'image/png' });
        var resizedDataUrl = await _blobToBase64DataUrl(resizedBlob);
        var compressed = await compressBase64Image(resizedDataUrl);
        return { base64: compressed, width: newW, height: newH };
    } catch (e) {
        return { base64: base64, width: 0, height: 0 };
    }
}

// Execute set_chat_title tool
// SW context: currentChatId is always null (page-only global). Threading the
// chatId through options lets the agent loop tell us which chat to title;
// activeStreamingChatId is the page-bundle fallback.
function executeSetChatTitle(args, options) {
    if (!args.title || typeof args.title !== 'string') {
        return { success: false, error: 'Title is required' };
    }

    var title = args.title.trim().substring(0, 60);
    if (title.length === 0) {
        return { success: false, error: 'Title cannot be empty' };
    }

    var targetChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
    var chat = chats[targetChatId];
    if (!chat) {
        return { success: false, error: 'No active chat' };
    }

    chat.title = title;
    // A model-set title is authoritative — clear the provisional flag set by
    // updateChatTitle so the auto-title hook stops re-firing for this chat.
    delete chat.titleProvisional;
    saveChatsToStorage();
    // set_chat_title is a HEADLESS tool — it normally runs in the SW where the
    // page-only UI fns (renderChatList/updateChatTitleHeader) don't exist and
    // the page's `chats` mirror is stale. Emit a sync event (mirrors
    // documentChanged / recordMutated / workspaceMutated) so the page hydrates
    // its mirror and refreshes the header + chat list IMMEDIATELY. The SW
    // broadcast bridge forwards the event to every connected panel; in a
    // page-only context the local bus fires the same handler. Falls back to
    // direct calls only if the event bus isn't available.
    if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
        AgentEvents.emit('chatTitleChanged', { chatId: targetChatId, title: title });
    } else {
        if (typeof renderChatList === 'function') renderChatList();
        if (typeof updateChatTitleHeader === 'function') updateChatTitleHeader();
    }

    return { success: true, message: 'Chat title updated to: ' + title };
}

// Execute set_tldr tool (TLDR hook). Headless — runs in the SW. Attaches the
// TLDR to the final-answer assistant message of the last REAL (non-hook) turn.
function executeSetTldr(args, options) {
    if (!args.tldr || typeof args.tldr !== 'string') return { success: false, error: 'tldr is required' };
    var text = args.tldr.trim().substring(0, 300);
    if (!text) return { success: false, error: 'tldr cannot be empty' };
    var targetChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
    var chat = chats[targetChatId];
    if (!chat || !chat.messages) return { success: false, error: 'No active chat' };
    // Find last non-hook user message, then the last assistant message with
    // content after it (the final answer of the real turn).
    var lastUserIdx = -1;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m.role === 'user' && !m.isHookMessage) { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return { success: false, error: 'No user turn found' };
    // Anchor the search span to the REAL turn: stop before the first hook
    // user message after the last real user message — prose replies to hook
    // runs must never become TLDR targets.
    var endIdx = chat.messages.length - 1;
    for (var h = lastUserIdx + 1; h < chat.messages.length; h++) {
        if (chat.messages[h].role === 'user' && chat.messages[h].isHookMessage) { endIdx = h - 1; break; }
    }
    function hasSetTldrCall(am) {
        return !!(am.tool_calls && am.tool_calls.some(function(tc) {
            return tc.function && tc.function.name === 'set_tldr';
        }));
    }
    var target = null;
    for (var j = endIdx; j > lastUserIdx; j--) {
        var am = chat.messages[j];
        if (am.role === 'assistant' && am.content && !am.isStreaming) {
            // Never attach to a message carrying a set_tldr tool call,
            // regardless of its content. (A spontaneous set_chat_title call
            // alongside the answer text is fine — still a valid target.)
            if (hasSetTldrCall(am)) continue;
            target = am; break;
        }
    }
    if (!target) {
        // Fall back to last assistant message with any content (same
        // real-turn span, still skipping set_tldr-carrying messages)
        for (var k = endIdx; k > lastUserIdx; k--) {
            if (chat.messages[k].role === 'assistant' && chat.messages[k].content && !hasSetTldrCall(chat.messages[k])) { target = chat.messages[k]; break; }
        }
    }
    if (!target) return { success: false, error: 'No answer message found to attach TLDR' };
    // Clear any earlier TL;DR inside the same turn span so a spontaneous
    // mid-run set_tldr followed by the afterResponse hook never leaves two
    // TL;DR cards on one answer (TLDR-3).
    for (var c = lastUserIdx + 1; c <= endIdx; c++) {
        if (chat.messages[c] !== target && chat.messages[c].tldr) delete chat.messages[c].tldr;
    }
    target.tldr = text;
    // Success — reset the per-turn TLDR hook retry cap (mirrors how a
    // successful set_chat_title clears titleProvisional).
    chat._tldrHookTries = 0;
    saveChatsToStorage();
    // Sync page mirror + re-render (mirrors chatTitleChanged pattern)
    if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
        AgentEvents.emit('tldrChanged', { chatId: targetChatId, tldr: text });
    } else if (typeof renderMessages === 'function') {
        renderMessages();
    }
    return { success: true, message: 'TLDR set' };
}

// Apply search-and-replace edits to content (no line numbers needed)
function applySearchReplaceEdits(content, edits) {
    var errors = [];
    var modifiedContent = content;
    var appliedEdits = [];

    for (var i = 0; i < edits.length; i++) {
        var edit = edits[i];

        // Validate edit is an object
        if (!edit || typeof edit !== 'object') {
            errors.push('Edit ' + i + ': Expected object with {find, replace}, got: ' + JSON.stringify(edit));
            continue;
        }

        // Support common alternative property names (LLMs sometimes use these)
        var findText = edit.find !== undefined ? edit.find :
                       edit.old_string !== undefined ? edit.old_string :
                       edit.search !== undefined ? edit.search :
                       edit.old !== undefined ? edit.old :
                       edit.text !== undefined ? edit.text : undefined;
        var replaceText = edit.replace !== undefined ? edit.replace :
                          edit.new_string !== undefined ? edit.new_string :
                          edit.replacement !== undefined ? edit.replacement :
                          edit.new !== undefined ? edit.new : undefined;

        // Validate required fields - show what keys were actually provided
        if (findText === undefined || findText === null) {
            var receivedKeys = Object.keys(edit).join(', ') || 'none';
            errors.push('Edit ' + i + ': Missing "find" property. Received keys: [' + receivedKeys + ']. Expected: {find: "...", replace: "..."}');
            continue;
        }
        if (replaceText === undefined || replaceText === null) {
            var receivedKeys = Object.keys(edit).join(', ') || 'none';
            errors.push('Edit ' + i + ': Missing "replace" property. Received keys: [' + receivedKeys + ']. Expected: {find: "...", replace: "..."}');
            continue;
        }

        // Count occurrences
        var occurrences = 0;
        var searchPos = 0;
        var foundIndex = -1;
        while ((searchPos = modifiedContent.indexOf(findText, searchPos)) !== -1) {
            if (occurrences === 0) foundIndex = searchPos;
            occurrences++;
            searchPos += 1;
        }

        if (occurrences === 0) {
            errors.push('Edit ' + i + ': Text not found: "' + findText.substring(0, 80) + (findText.length > 80 ? '...' : '') + '"');
            continue;
        }

        if (occurrences > 1) {
            // Find all occurrence positions and show context
            var positions = [];
            var lines = modifiedContent.split('\n');
            var charCount = 0;
            for (var lineNum = 0; lineNum < lines.length; lineNum++) {
                var lineStart = charCount;
                var lineEnd = charCount + lines[lineNum].length;
                var pos = modifiedContent.indexOf(findText, lineStart);
                while (pos !== -1 && pos < lineEnd + findText.length) {
                    if (pos >= lineStart) {
                        positions.push('line ' + (lineNum + 1) + ' (char ' + pos + ')');
                    }
                    pos = modifiedContent.indexOf(findText, pos + 1);
                }
                charCount = lineEnd + 1; // +1 for newline
            }
            errors.push('Edit ' + i + ': Text found ' + occurrences + ' times at: ' + positions.join(', ') + '. Add more surrounding context to make it unique. Text: "' + findText.substring(0, 50) + '..."');
            continue;
        }

        // Apply the edit
        modifiedContent = modifiedContent.substring(0, foundIndex) + replaceText + modifiedContent.substring(foundIndex + findText.length);
        appliedEdits.push({ index: i, action: 'replace', at: foundIndex, removed: findText.length, added: replaceText.length });
    }

    if (errors.length > 0) {
        // If some edits succeeded, return partial success with the modified content
        if (appliedEdits.length > 0) {
            return { error: false, partialSuccess: true, content: modifiedContent, appliedEdits: appliedEdits, failedEdits: errors };
        }
        // All edits failed - return error without any content changes
        return { error: true, messages: errors, partialEdits: [] };
    }

    return { error: false, content: modifiedContent, appliedEdits: appliedEdits };
}

// Execute diff edit tool (search-and-replace based)
// =============================================================
// Record-mutation tracking (version history / chat "Artifacts")
// The versionHistory entry MUST be written into chats[chatId] by the
// tier that EXECUTED the tool. Post-SW-move the service worker owns the
// authoritative chat object; relying on the page's recordMutated event
// handler alone is broken: recordMutated is NOT a chat-inlined
// broadcast, so the next chat-inlined event (toolCallResult fires right
// after) replaces the page's chats[chatId] mirror with the SW snapshot
// that never had the entry — wiping the artifact card moments after it
// was added (and the SW's saveChatsToStorage clobbered it in IDB too).
// This file is in WORKER_SHARED_FILES, so pushing here lands the entry
// in the authoritative chat; chat-inlined broadcasts then carry it to
// the page automatically. The page handler (app/036) dedupes by entryId.
function trackRecordMutation(evt) {
    var entry = {
        id: 'vh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        chatId: evt.chatId,
        timestamp: Date.now(),
        table: evt.table,
        sysId: evt.sysId,
        field: evt.field || undefined,
        displayName: evt.displayName,
        action: evt.action,
        statusMessage: evt.statusMessage || null,
        // NOTE: not `messageIndex || -1` — index 0 is a legitimate value.
        messageIndex: (typeof evt.messageIndex === 'number' && evt.messageIndex >= 0) ? evt.messageIndex : -1,
        beforeVersion: evt.beforeVersion || null,
        afterVersion: evt.afterVersion || null
    };
    try {
        if (evt.chatId && typeof chats !== 'undefined' && chats[evt.chatId]) {
            var trmChat = chats[evt.chatId];
            if (!Array.isArray(trmChat.versionHistory)) trmChat.versionHistory = [];
            trmChat.versionHistory.push(entry);
            if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        }
    } catch (e) { /* tracking must never break the tool result */ }
    evt.entryId = entry.id;
    evt.messageIndex = entry.messageIndex;
    AgentEvents.emit('recordMutated', evt);
}

async function executeDiffEdit(args, messageIndex, options) {
    if (!(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.table))) {
        return { success: false, error: 'Invalid table name: must be alphanumeric/underscores only' };
    }
    if (args.sys_id && args.sys_id !== '-1' && !(/^[0-9a-fA-F]{32}$/.test(args.sys_id))) {
        return { success: false, error: 'Invalid sys_id: must be a 32-character hex string or -1' };
    }
    try {
        var currentContent;

        // Resolve target instance
        var _diffInstanceUrl = null;
        var _diffToken = null;
        if (args.instance) {
            _diffInstanceUrl = Platform.resolveInstanceUrl(args.instance);
            if (!_diffInstanceUrl) {
                return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
            }
            _diffToken = await Platform.getTokenForInstance(_diffInstanceUrl);
            if (!_diffToken) {
                return { success: false, error: 'No token available for instance "' + args.instance + '" (' + _diffInstanceUrl + '). Ensure a tab is open for that instance.' };
            }
        }
        var _diffApiToken = _diffToken || Platform.getSessionToken() || '';

        // Capture version before the change (skip for cross-instance)
        var versionBefore = null;
        var beforeVersion = null;
        if (!_diffInstanceUrl) {
            versionBefore = await getRecordVersion(args.table, args.sys_id);
            beforeVersion = versionBefore ? versionBefore.sys_id : null;
        }

        // Always fetch the full content from the server to ensure we have the complete field
        var getUrl = '/api/now/table/' + args.table + '/' + args.sys_id + '?sysparm_fields=' + args.field;
        if (_diffInstanceUrl) getUrl = _diffInstanceUrl + getUrl;
        var getOpts = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserToken': _diffApiToken
            }
        };
        var getRes = await fetch(getUrl, getOpts);

        if (!getRes.ok) {
            var errText = await getRes.text();
            var errData = {};
            try { errData = JSON.parse(errText); } catch(e) { /* non-JSON error response */ }
            return { success: false, error: 'Failed to fetch record: ' + (errData.error?.message || 'HTTP ' + getRes.status) };
        }

        var getData = await getRes.json();
        if (!getData.result) {
            return { success: false, error: 'Record not found or empty response for ' + args.table + '/' + args.sys_id };
        }
        currentContent = getData.result[args.field] || '';

        var originalLength = currentContent.length;

        // Apply search-and-replace edits
        var editResult = applySearchReplaceEdits(currentContent, args.edits);
        
        // Check for validation errors - only fail if ALL edits failed
        if (editResult.error) {
            return { 
                success: false, 
                error: 'All edits failed validation', 
                validationErrors: editResult.messages,
                hint: 'Ensure find text is unique and exists in the document. Include more context lines if needed.'
            };
        }

        var newContent = editResult.content;
        var failedEdits = editResult.failedEdits || [];
        var isPartialSuccess = editResult.partialSuccess || false;

        // PUT the updated content using record's scope
        var putUrl = '/api/now/table/' + args.table + '/' + args.sys_id;
        var recordScope = _diffInstanceUrl ? null : await getRecordScope(args.table, args.sys_id);
        if (recordScope) {
            putUrl += '?sysparm_record_scope=' + encodeURIComponent(recordScope);
        }
        if (_diffInstanceUrl) putUrl = _diffInstanceUrl + putUrl;
        var putData = {};
        putData[args.field] = newContent;

        var putOpts = {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserToken': _diffApiToken
            },
            body: JSON.stringify(putData)
        };
        var putRes = await fetch(putUrl, putOpts);

        if (!putRes.ok) {
            var errText = await putRes.text();
            var errData = {};
            try { errData = JSON.parse(errText); } catch(e) { /* non-JSON error response */ }
            return { success: false, error: 'Failed to update record: ' + (errData.error?.message || 'HTTP ' + putRes.status) };
        }

        // Capture version after the change and track it (skip for cross-instance)
        if (!_diffInstanceUrl) {
            await new Promise(function(r) { setTimeout(r, 200); });
            var versionAfter = await getRecordVersion(args.table, args.sys_id);
            var afterVersion = versionAfter ? versionAfter.sys_id : null;
            var displayName = await getRecordDisplayValue(args.table, args.sys_id);
            trackRecordMutation({
                chatId: (options && options.chatId) || activeStreamingChatId || currentChatId,
                table: args.table,
                sysId: args.sys_id,
                field: args.field,
                displayName: displayName,
                action: 'EDIT',
                statusMessage: args.status_message || null,
                messageIndex: messageIndex,
                beforeVersion: beforeVersion,
                afterVersion: afterVersion
            });
        }

        var result = {
            success: true,
            originalLength: originalLength,
            newLength: newContent.length,
            editsApplied: editResult.appliedEdits
        };
        if (_diffInstanceUrl) result.instance = args.instance;
        
        if (isPartialSuccess) {
            result.message = 'Partially applied ' + editResult.appliedEdits.length + ' of ' + args.edits.length + ' edit(s) to ' + args.field;
            result.partialSuccess = true;
            result.failedEdits = failedEdits;
            result.warning = 'Some edits failed validation but successful edits were saved. Review failedEdits for details.';
        } else {
            result.message = 'Successfully applied ' + args.edits.length + ' edit(s) to ' + args.field;
        }
        
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Single entry point for all tool execution - always checks permissions
// options: { batch, toolCallId, chatId } - passed through to requestProgrammaticToolApproval
//
// Async tool layer (Sub-Agent spec §4):
//   • If `args.await === false` AND the tool is not in Handles.ALWAYS_SYNC_TOOLS
//     AND we are not already wrapping (`options._asyncWrapping`), this call
//     returns IMMEDIATELY with `{ success: true, handle: 'h_...', status: 'pending', tool: name }`.
//     The underlying tool runs in the background; the agent retrieves the
//     real result by calling `await_handle` / `poll_handle` / `await_all` / `await_any`.
//   • If `args.await` is true or undefined → existing synchronous behavior
//     (the caller's await on the returned Promise blocks until the real result).
//   • The `await` meta-key is stripped from `args` ONCE up front so per-tool
//     branches and the handle entry never see a stray `await` property.
//   • Approval runs INSIDE the background promise (after the wrap), so a slow
//     user prompt doesn't block the agent loop — that's the whole point of
//     `await: false`. The trade-off: the handle stays `pending` while the
//     user decides, indistinguishable from "tool actively running". A future
//     `status_message` channel can surface "awaiting approval" to the UI.

// ---------- Pool-deadlock prevention helpers (Phase 5) ----------
// If the caller is a sub-agent and the target handle is a spawn handle owned
// by its own chat (i.e. it's awaiting a descendant sub), release the sub's
// pool slot for the duration of the await. The unpark side of this lives at
// the `finally` clause of each await arm.
function _maybeParkForChildAwait(chatIdH, handleId) {
    try {
        if (!chatIdH || typeof chats === 'undefined' || !chats[chatIdH] || !chats[chatIdH].isSubAgent) return null;
        if (typeof SubAgents === 'undefined' || !SubAgents.parkForAwait || !SubAgents.getById) return null;
        var callerRec = SubAgents.getById(chats[chatIdH].subAgentId);
        if (!callerRec) return null;
        var entry = (typeof Handles !== 'undefined' && Handles.get) ? Handles.get(chatIdH, handleId) : null;
        if (!entry || entry.name !== 'spawn_sub_agent') return null;
        return SubAgents.parkForAwait(callerRec.agent_id) ? callerRec.agent_id : null;
    } catch (_) { return null; }
}
function _maybeParkForChildAwaitMulti(chatIdH, handleIds) {
    // For await_any / await_all: park if ANY of the handles is a spawn handle
    // in the caller chat. One park per call — unparkAfterAwait is idempotent
    // in the no-park case.
    if (!Array.isArray(handleIds)) return null;
    for (var i = 0; i < handleIds.length; i++) {
        var aid = _maybeParkForChildAwait(chatIdH, handleIds[i]);
        if (aid) return aid; // first match wins; we only ever park once per arm
    }
    return null;
}

// js_eval inactivity watchdog: chatId -> timestamp of the most recent inner
// sandbox tool call (options.fromSandbox). The js_eval timeout races below are
// INACTIVITY-based, not a hard cap: a long orchestration that keeps making
// tool calls stays alive indefinitely (pre-#379 behavior), while a sandbox
// that goes silent for 5 minutes is killed. Shared by the page path (inner
// calls re-enter executeTool directly) and the SW path (inner calls arrive
// via the offscreen 'sw-exec-tool' relay, which also calls executeTool with
// fromSandbox:true — see platform/extension/background.js).
var _sandboxActivity = {};

// RES-1: inner sandbox tool calls currently in flight, per chatId. While the
// counter is > 0 the js_eval inactivity watchdogs below SKIP the timeout — a
// single inner call legitimately running > 5 minutes (canonical: await_handle
// with timeout_ms 0) must not get the sandbox killed as "inactive" while it
// is busy awaiting that call. Cleaned up alongside _sandboxActivity.
var _sandboxPending = {};

// PR383-F1: number of js_eval invocations currently LIVE per chatId. js_eval
// is not in ALWAYS_SYNC_TOOLS, so two evals can overlap in one chat (await:false
// fan-out, nested sandbox eval). The per-chat watchdog maps above must only be
// torn down when the LAST eval for the chat finishes — a per-invocation delete
// stripped a sibling sandbox's in-flight protection (the exact regression RES-1
// fixed). _sandboxGen invalidates orphaned decrements that settle after a
// wholesale cleanup (see the fromSandbox wrapper in executeTool).
var _sandboxEvalCount = {};
var _sandboxGen = {};

// PR383-F2: max time the watchdogs honor a _sandboxPending hold without any
// fresh activity. The page bridge already posts a 30s timeout error back to
// the sandbox while the underlying tool promise keeps running — a wedged
// orphan (unanswered approval, never-settling handle) must not disable the
// inactivity kill switch permanently.
var _SANDBOX_HOLD_MAX_MS = 60 * 60 * 1000;

function _sandboxEvalCleanup(chatId) {
    if (!chatId) return;
    if (_sandboxEvalCount[chatId] > 1) {
        _sandboxEvalCount[chatId] -= 1;
        return; // a sibling js_eval is still live — keep the chat's maps intact
    }
    delete _sandboxEvalCount[chatId];
    delete _sandboxActivity[chatId];
    delete _sandboxPending[chatId];
    // Invalidate decrements from inner calls counted before this cleanup
    // so a late settle can't corrupt a future eval's pending counter.
    _sandboxGen[chatId] = (_sandboxGen[chatId] || 0) + 1;
}

async function executeTool(name, args, messageIndex, options) {
    // Record inner-sandbox activity FIRST so the js_eval watchdogs see it
    // even if this call later parks on an approval or a slow network call.
    if (options && options.fromSandbox) {
        var _saChatId = options.chatId
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        if (_saChatId) {
            // PR383-F1: only stamp/count while a js_eval for this chat is
            // actually live — an orphaned inner call settling after js_eval
            // cleanup must not resurrect the per-chat maps (permanent leak),
            // and its decrement must not strip a LATER eval's hold (generation
            // check below).
            var _saLive = _sandboxEvalCount[_saChatId] > 0;
            var _saGen = _sandboxGen[_saChatId] || 0;
            var _saCounted = false;
            if (_saLive) {
                _sandboxActivity[_saChatId] = Date.now();
                // RES-1: count this inner call as pending so the watchdogs hold
                // the inactivity clock while the sandbox awaits it. The finally
                // covers every return/throw path of the inner execution exactly
                // once (no double-decrement).
                _sandboxPending[_saChatId] = (_sandboxPending[_saChatId] || 0) + 1;
                _saCounted = true;
            }
            try {
                return await _executeToolInner(name, args, messageIndex, options);
            } finally {
                if (_saCounted && (_sandboxGen[_saChatId] || 0) === _saGen) {
                    if (_sandboxPending[_saChatId] > 1) _sandboxPending[_saChatId] -= 1;
                    else delete _sandboxPending[_saChatId];
                }
                if (_sandboxEvalCount[_saChatId] > 0) _sandboxActivity[_saChatId] = Date.now();
            }
        }
    }
    return _executeToolInner(name, args, messageIndex, options);
}

async function _executeToolInner(name, args, messageIndex, options) {
    // Strip the meta-key once. Both the wrap path and the sync path operate
    // on the cleaned args from here on.
    if (args && Object.prototype.hasOwnProperty.call(args, 'await')) {
        var hadAwaitFalse = args.await === false;
        var _stripped = {};
        for (var _sk in args) { if (_sk !== 'await') _stripped[_sk] = args[_sk]; }
        args = _stripped;
        // Async-mode wrap: bounce the call into a handle and return the receipt.
        if (hadAwaitFalse
            && !(options && options._asyncWrapping)
            && typeof Handles !== 'undefined'
            && !(Handles.ALWAYS_SYNC_TOOLS && Handles.ALWAYS_SYNC_TOOLS[name])) {
            var chatIdForHandle = (options && options.chatId) || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null) || (typeof currentChatId !== 'undefined' ? currentChatId : null);
            var displayName = (typeof getToolDisplayName === 'function') ? getToolDisplayName(name, args.method || args.action) : name;
            var nextOptions = {};
            for (var _ok in (options || {})) nextOptions[_ok] = options[_ok];
            nextOptions._asyncWrapping = true;
            var asyncArgs = args; // already stripped
            var started = Handles.start(chatIdForHandle, name, asyncArgs, displayName, function() {
                return executeTool(name, asyncArgs, messageIndex, nextOptions);
            });
            // Plumb handle identity so the inner approval call can flip
            // awaitingApproval on the entry while the user-prompt modal
            // is up. See Handles.markAwaitingApproval (registry §) and
            // the requestProgrammaticToolApproval implementations.
            nextOptions._handleId = started.handleId;
            nextOptions._handleChatId = chatIdForHandle;
            // If the caller is a sub-agent, register this handle so
            // stop_sub_agent can cancel it on terminate. Without this,
            // a stopped sub's in-flight async tool calls keep running
            // and burning resources until they naturally finish.
            try {
                if (chatIdForHandle && typeof chats !== 'undefined' && chats[chatIdForHandle]
                    && chats[chatIdForHandle].isSubAgent
                    && typeof SubAgents !== 'undefined' && SubAgents.getById) {
                    var _ownerSub = SubAgents.getById(chats[chatIdForHandle].subAgentId);
                    if (_ownerSub) {
                        _ownerSub.pending_handles = _ownerSub.pending_handles || [];
                        if (_ownerSub.pending_handles.indexOf(started.handleId) === -1) {
                            _ownerSub.pending_handles.push(started.handleId);
                        }
                        // Best-effort cleanup when the handle settles — prevents
                        // pending_handles from growing without bound over the
                        // sub's lifetime.
                        if (Handles.await) {
                            Handles.await(chatIdForHandle, started.handleId, 0).then(function() {
                                var _idx = _ownerSub.pending_handles.indexOf(started.handleId);
                                if (_idx >= 0) _ownerSub.pending_handles.splice(_idx, 1);
                            });
                        }
                    }
                }
            } catch (_) { /* tracking is best-effort; don't break async wrap */ }
            return {
                success: true,
                handle: started.handleId,
                status: 'pending',
                tool: name,
                note: 'Async tool call — use await_handle("' + started.handleId + '") to collect the result.'
            };
        }
    }

    var approval = await requestProgrammaticToolApproval(name, args, options);
    if (!approval.allowed) {
        return { success: false, error: approval.error, _denied: true };
    }

    // -------- Sub-agent enforcement (roster + budget) --------
    // Two gates for sub-agent chats:
    //   1. tool_roster: the deterministic per-sub roster set at spawn. Subs
    //      inherit the parent's full tool list minus the nested-delegation
    //      tools (spawn/stop/wake_sub_agent), which are denied unless the
    //      caller passed `allow_nested:true`. The model-visible list is
    //      already filtered by getEnabledTools, but the dispatch arm is the
    //      defense-in-depth boundary — if a denied tool slips through
    //      (skill tool, cache lag, js_eval bridge), this rejects it.
    //   2. tool-call budget (SOFT cap): increment tool_calls_used; from 90%
    //      usage (and on every call past max_tool_calls) the registry stages a
    //      warning that the agent loop appends to the next tool result, so the
    //      model wraps up + report_to_parent on its own. The sub is never
    //      hard-stopped. Read-only finalization tools (agent_status /
    //      report_to_parent / sleep_self) and the handle helpers are exempt
    //      so bookkeeping never accelerates exhaustion.
    if (typeof SubAgents !== 'undefined' && SubAgents.onToolCallInSubAgent) {
        var _budgetChatId = (options && options.chatId)
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        // Roster gate. Sub-only tools (report_to_parent / sleep_self / agent_message)
        // are always allowed regardless of roster — the registry injects them as
        // SUB_ONLY_TOOLS at spawn, but a defensive check here means "a sub can
        // always finalize" even if the persisted record is somehow malformed.
        if (_budgetChatId && typeof chats !== 'undefined' && chats[_budgetChatId]
            && chats[_budgetChatId].isSubAgent && SubAgents.getById) {
            var _subRec = SubAgents.getById(chats[_budgetChatId].subAgentId);
            if (_subRec && Array.isArray(_subRec.tool_roster)) {
                var _alwaysAllowed = (name === 'report_to_parent'
                    || name === 'sleep_self'
                    || name === 'agent_message');
                if (!_alwaysAllowed && _subRec.tool_roster.indexOf(name) === -1) {
                    return { success: false, error: 'Tool "' + name + '" is not available to this sub-agent. Nested-delegation tools (spawn_sub_agent, stop_sub_agent, wake_sub_agent) require `allow_nested:true` at spawn.', _roster_denied: true };
                }
            }
        }
        // Status / lifecycle / handle-management tools don't burn budget — a
        // sub-agent pushing a `partial` update to the parent via agent_message,
        // or polling its own handles, shouldn't accelerate its own tool-budget
        // exhaustion. The cap exists to bound *productive work*, not bookkeeping.
        var _exemptBudget = (name === 'agent_status'
            || name === 'report_to_parent'
            || name === 'sleep_self'
            || name === 'agent_message'
            || name === 'poll_handle'
            || name === 'await_handle'
            || name === 'await_any'
            || name === 'await_all'
            || name === 'cancel_handle');
        if (!_exemptBudget) {
            // Soft cap: onToolCallInSubAgent counts usage and stages a budget
            // warning (>=90% / past cap) that the agent loop appends to the
            // next tool result via appendBudgetNotice. SAFETY BACKSTOP: past
            // 2x max_tool_calls the registry force-stops the runaway sub and
            // returns false — short-circuit so the stopped sub does no work.
            var _ok = SubAgents.onToolCallInSubAgent(_budgetChatId);
            if (!_ok) {
                return { success: false, error: 'Sub-agent exceeded the hard tool-call ceiling (2x max_tool_calls) after ignoring every budget warning. The sub has been force-stopped.', _budget_exhausted: true };
            }
        }
    }

    // -------- Handle helper tools (always-sync) --------
    if (name === 'await_handle' || name === 'poll_handle'
        || name === 'await_any' || name === 'await_all'
        || name === 'cancel_handle') {
        if (typeof Handles === 'undefined') {
            return { success: false, error: 'Handle registry not loaded — async tool layer unavailable.' };
        }
        var chatIdH = (options && options.chatId) || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null) || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        // P1d: when a TERMINAL snapshot for a sub-agent spawn handle is handed
        // to the caller, stamp report_collected on the sub's persisted record
        // (SubAgents.markCollected is a cheap scan; non-spawn handles simply
        // match nothing). Why: handles are in-memory, so after an MV3 SW
        // restart `report_collected:false` is the only durable signal that a
        // report was produced but never delivered — the rehydrated handle can
        // then be re-awaited/polled to replay it.
        var _stampCollected = function(snap) {
            try {
                if (snap && snap.handle && snap.status
                    && snap.status !== 'pending' && snap.status !== 'unknown'
                    && typeof SubAgents !== 'undefined' && SubAgents.markCollected) {
                    SubAgents.markCollected(chatIdH, snap.handle);
                }
            } catch (_) { /* best-effort bookkeeping */ }
        };
        if (name === 'poll_handle') {
            if (!args || !args.handle) return { success: false, error: 'poll_handle requires `handle`.' };
            var snapPH = Handles.poll(chatIdH, args.handle);
            _stampCollected(snapPH);
            return { success: true, snapshot: snapPH };
        }
        if (name === 'await_handle') {
            if (!args || !args.handle) return { success: false, error: 'await_handle requires `handle`.' };
            var timeoutMsAH = (args.timeout_ms != null) ? Number(args.timeout_ms) : 0;
            // Pool-deadlock prevention (Phase 5): if the caller is a sub-agent
            // and the target handle is a spawn handle (i.e. waiting on a
            // descendant), release the parent sub's pool slot for the duration
            // of the await. Otherwise four concurrent nested awaits = global
            // deadlock (pool size = 2, nothing free to start the grandchildren).
            var _parkedAid = _maybeParkForChildAwait(chatIdH, args.handle);
            try {
                var snapAH = await Handles.await(chatIdH, args.handle, timeoutMsAH);
                _stampCollected(snapAH); // P1d: report delivered to the parent
                return { success: true, snapshot: snapAH };
            } finally {
                if (_parkedAid && typeof SubAgents !== 'undefined' && SubAgents.unparkAfterAwait) {
                    try { SubAgents.unparkAfterAwait(_parkedAid); } catch (_) {}
                }
            }
        }
        if (name === 'await_any') {
            if (!args || !Array.isArray(args.handles) || !args.handles.length) {
                return { success: false, error: 'await_any requires a non-empty `handles` array.' };
            }
            var timeoutMsAY = (args.timeout_ms != null) ? Number(args.timeout_ms) : 0;
            var _parkedAidAY = _maybeParkForChildAwaitMulti(chatIdH, args.handles);
            try {
                var anyRes = await Handles.awaitAny(chatIdH, args.handles, timeoutMsAY);
                // anyRes is already { handle, snapshot, timeout, pendingSnapshots? }
                if (anyRes && anyRes.snapshot) _stampCollected(anyRes.snapshot); // P1d
                return Object.assign({ success: true }, anyRes);
            } finally {
                if (_parkedAidAY && typeof SubAgents !== 'undefined' && SubAgents.unparkAfterAwait) {
                    try { SubAgents.unparkAfterAwait(_parkedAidAY); } catch (_) {}
                }
            }
        }
        if (name === 'await_all') {
            if (!args || !Array.isArray(args.handles) || !args.handles.length) {
                return { success: false, error: 'await_all requires a non-empty `handles` array.' };
            }
            var timeoutMsAA = (args.timeout_ms != null) ? Number(args.timeout_ms) : 0;
            var _parkedAidAA = _maybeParkForChildAwaitMulti(chatIdH, args.handles);
            try {
                var allRes = await Handles.awaitAll(chatIdH, args.handles, timeoutMsAA);
                if (allRes && Array.isArray(allRes.snapshots)) {
                    allRes.snapshots.forEach(_stampCollected); // P1d
                }
                // allRes is { snapshots: [...], timedOut }. Forward the FULL
                // uniform shape (mirrors the await_any arm's Object.assign) so
                // the agent sees `timedOut` — the top-level partial-result flag
                // the v1.1.0 changelog promised. Hand-picking only `snapshots`
                // here silently dropped it at the dispatch boundary, defeating
                // the registry-layer fix and forcing callers to re-scan every
                // snapshot for status:'pending'.
                return Object.assign({ success: true }, allRes);
            } finally {
                if (_parkedAidAA && typeof SubAgents !== 'undefined' && SubAgents.unparkAfterAwait) {
                    try { SubAgents.unparkAfterAwait(_parkedAidAA); } catch (_) {}
                }
            }
        }
        if (name === 'cancel_handle') {
            if (!args || !args.handle) return { success: false, error: 'cancel_handle requires `handle`.' };
            // If the handle is a spawn_sub_agent handle, plain Handles.cancel
            // only flips the entry state — the sub-agent itself keeps
            // running, consuming a pool slot and tool budget, until it
            // naturally finishes (whose payload is then silently discarded).
            // Route through SubAgents.stop so the sub is actually terminated
            // and its own pending handles are cancelled.
            try {
                var _entry = Handles.get ? Handles.get(chatIdH, args.handle) : null;
                if (_entry && _entry.name === 'spawn_sub_agent'
                    && typeof SubAgents !== 'undefined' && SubAgents.listAll && SubAgents.stop) {
                    var _subs = SubAgents.listAll();
                    for (var _si = 0; _si < _subs.length; _si++) {
                        if (_subs[_si].spawn_handle_id === args.handle) {
                            // stop() will resolve the spawn handle as cancelled
                            // (via _resolveSpawnHandle → Handles.cancel) so the
                            // parent's await_handle returns status:'cancelled'.
                            // Pass ctx (with chatIdH) so the ACL check in
                            // SubAgents.stop can resolve the caller. The
                            // previous call omitted ctx — _callerChatId
                            // resolved to null, the gate silently skipped,
                            // and a chat could theoretically cancel any
                            // spawn handle it learned the id of (currently
                            // hard to exploit because handles are chat-
                            // scoped, but the boundary should hold by
                            // construction, not by accident).
                            var _stopRes = SubAgents.stop(
                                { agent_id: _subs[_si].agent_id, reason: args.reason || 'cancelled via cancel_handle' },
                                { chatId: chatIdH }
                            );
                            // Preserve the cancel_handle status contract — a caller
                            // who used cancel_handle should get back status:'cancelled',
                            // not status:'stopped' (which is what SubAgents.stop
                            // returns). Previously Object.assign was {…cancelled,
                            // _stopRes} which let _stopRes.status='stopped' clobber
                            // ours. Spread _stopRes FIRST, our base SECOND so our
                            // cancelled status wins. The handle itself already
                            // resolves with status:'cancelled' via _resolveSpawnHandle
                            // — this just makes the immediate tool return shape match.
                            return Object.assign({}, _stopRes || {}, { success: true, ok: true, status: 'cancelled' });
                        }
                    }
                }
            } catch (_) { /* fall through to plain cancel */ }
            var cancelRes = Handles.cancel(chatIdH, args.handle, args.reason);
            // cancelRes is { ok, status?, reason?, error? }. We always return
            // success:true at the tool boundary — "handle already settled" or
            // "unknown handle" is information, not a tool failure. The agent
            // reads `ok`/`status`/`error` from the flattened body.
            return Object.assign({ success: true }, cancelRes);
        }
    }

    // -------- Sub-agent runtime tools (Phase 2) --------
    // All seven dispatch to SubAgents.* in src/js/core/097-sub-agent-registry.js.
    // ctx carries the chatId so the registry can resolve parent/sub identity
    // (a sub calling report_to_parent / sleep_self uses ctx.chatId to look up
    // its own record).
    if (name === 'spawn_sub_agent'
        || name === 'report_to_parent'
        || name === 'agent_status'
        || name === 'wake_sub_agent'
        || name === 'stop_sub_agent'
        || name === 'sleep_self'
        || name === 'agent_message') {
        if (typeof SubAgents === 'undefined') {
            return { success: false, error: 'Sub-agent registry not loaded.' };
        }
        var subCtxChatId = (options && options.chatId)
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        var subCtx = { chatId: subCtxChatId };
        if (name === 'spawn_sub_agent')  return SubAgents.spawn(args, subCtx);
        if (name === 'report_to_parent') return SubAgents.report(args, subCtx);
        if (name === 'agent_status')     return SubAgents.status(args, subCtx);
        if (name === 'wake_sub_agent')   return SubAgents.wake(args, subCtx);
        if (name === 'stop_sub_agent')   return SubAgents.stop(args, subCtx);
        if (name === 'sleep_self')       return SubAgents.sleep(args, subCtx);
        if (name === 'agent_message')    return SubAgents.message(args, subCtx);
    }

    // Execute the tool
    if (name === 'js_eval') {
        try {
            var chatId = (options && options.chatId) || activeStreamingChatId || currentChatId;

            // SW context bridges js_eval to the offscreen helper which
            // hosts the real sandbox iframe. Page context falls through
            // to the existing DOM-based path further below.
            if (typeof Platform !== 'undefined' && Platform.isWorker) {
                // Same Unicode sanitization regex as the DOM path below, written
                // with \uXXXX escapes to keep both branches byte-identical and
                // immune to silent desync if an editor normalizes one branch.
                var sanitizedCodeSw = args.code
                    .replace(/[\u2018\u2019\u02BC\u02B9]/g, "'")
                    .replace(/[\u201C\u201D]/g, '"')
                    .replace(/[\u02CB\u0060\u2032\u02B4]/g, '`');
                // INACTIVITY timeout (not a hard cap): callOffscreenHelper's timeoutMs
                // only gates offscreen READINESS, not execution — race the call so a
                // HUNG sandbox can't stall the agent run forever, but reset the clock
                // on every inner sandbox tool call (_sandboxActivity, touched at the
                // top of executeTool via the 'sw-exec-tool' relay) so long multi-call
                // orchestrations (> 5 min) survive. The rejection falls through to
                // the catch below, which returns {success:false}.
                var _swEvalTimer = null;
                var swEvalResult;
                if (chatId) _sandboxEvalCount[chatId] = (_sandboxEvalCount[chatId] || 0) + 1; // PR383-F1
                try {
                    swEvalResult = await Promise.race([
                        Platform.callOffscreenHelper('helper-js-eval', {
                            code: sanitizedCodeSw,
                            chatId: chatId,
                            messageIndex: messageIndex,
                            // Plumb the js_eval toolCallId down so display calls from
                            // inside the sandbox can eager-render attached to this
                            // tool's result slot. See executeDisplay's eager-render path.
                            parentToolCallId: options && options.toolCallId,
                            globals: { lastLargeResponse: (chatId && lastLargeResponseByChatId[chatId]) || null } // CONC-FIX: this chat's own slot, not the shared global
                        }, 5 * 60 * 1000),
                        new Promise(function(_, rej) {
                            var _swLast = Date.now();
                            _swEvalTimer = setInterval(function() {
                                // RES-1: an inner tool call is still in flight —
                                // the sandbox is legitimately busy awaiting it,
                                // so hold the inactivity clock. PR383-F2: the hold
                                // is capped — a wedged orphan call (sandbox already
                                // received its 30s bridge timeout) can't disable
                                // the kill switch forever.
                                if (chatId && _sandboxPending[chatId] > 0) {
                                    var _heldSw = _sandboxActivity[chatId] || _swLast;
                                    if (Date.now() - _heldSw < _SANDBOX_HOLD_MAX_MS) return;
                                }
                                var _act = chatId && _sandboxActivity[chatId];
                                if (_act && _act > _swLast) _swLast = _act;
                                if (Date.now() - _swLast >= 5 * 60 * 1000) {
                                    rej(new Error('js_eval timed out after 5 minutes of inactivity (no tool calls or completion)'));
                                }
                            }, 15000);
                        })
                    ]);
                } finally {
                    if (_swEvalTimer) clearInterval(_swEvalTimer);
                    _sandboxEvalCleanup(chatId); // RES-1 + PR383-F1 (last-eval-out teardown)
                }
                var jsEvalResultSw = { success: true, result: swEvalResult };
                if (swEvalResult && swEvalResult._images && Array.isArray(swEvalResult._images) && swEvalResult._images.length > 0) {
                    var imgsSw = swEvalResult._images.filter(function(img) { return img && img.base64; });
                    delete swEvalResult._images;
                    var ssMsgsSw = await Promise.all(imgsSw.map(async function(img) {
                        var ssId = newFileId();
                        var imgW = img.width || null;
                        var imgH = img.height || null;
                        // Look up dimensions from screenshots stored during this js_eval execution
                        if ((!imgW || !imgH) && chatId) {
                            var jsChatSw = chats[chatId];
                            if (jsChatSw && jsChatSw.screenshots) {
                                if (img.screenshot_id && jsChatSw.screenshots[img.screenshot_id]) {
                                    var storedSw = jsChatSw.screenshots[img.screenshot_id];
                                    imgW = imgW || storedSw.width;
                                    imgH = imgH || storedSw.height;
                                } else {
                                    var b64PrefixSw = img.base64 ? img.base64.substring(0, 200) : '';
                                    for (var ssKeySw in jsChatSw.screenshots) {
                                        var ssSw = jsChatSw.screenshots[ssKeySw];
                                        if (ssSw.base64 && ssSw.base64.substring(0, 200) === b64PrefixSw) {
                                            imgW = imgW || ssSw.width;
                                            imgH = imgH || ssSw.height;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        var resized = await resizeImageIfNeeded(img.base64);
                        return {
                            role: 'screenshot',
                            base64: resized.base64,
                            name: img.name || null,
                            description: img.description || 'Image from js_eval',
                            timestamp: Date.now(),
                            width: resized.width,
                            height: resized.height,
                            screenshot_id: ssId,
                            file_id: ssId
                        };
                    }));
                    if (ssMsgsSw.length === 1) jsEvalResultSw._screenshotMessage = ssMsgsSw[0];
                    else jsEvalResultSw._screenshotMessages = ssMsgsSw;
                }
                return jsEvalResultSw;
            }

            var sandbox = document.createElement('iframe');
            sandbox.style.display = 'none';
            var sandboxMessageHandler = null;

            // Sanitize code: convert Unicode lookalike characters to ASCII equivalents
            var sanitizedCode = args.code
                .replace(/[\u2018\u2019\u02BC\u02B9]/g, "'")
                .replace(/[\u201C\u201D]/g, '"')
                .replace(/[\u02CB\u0060\u2032\u02B4]/g, '`');

            var MSG_TOOL_CALL = 'sandboxToolCall';
            var MSG_TOOL_RESULT = 'sandboxToolResult';
            var MSG_DONE = 'sandboxDone';

            // Promise to wait for result
            var resultPromise = new Promise(function(resolveMain, rejectMain) {
                function handleSandboxMessage(e) {
                    if (e.source !== sandbox.contentWindow) return;

                    // Sandbox ready -> send code to execute
                    if (e.data && e.data.type === 'sandboxReady') {
                        sandbox.contentWindow.postMessage({ type: 'sandboxExec', code: sanitizedCode, globals: { lastLargeResponse: (chatId && lastLargeResponseByChatId[chatId]) || null } }, '*'); // CONC-FIX: this chat's own slot, not the shared global
                    } else if (e.data && e.data.type === MSG_TOOL_CALL) {
                        // Pass the OUTER js_eval's toolCallId as parentToolCallId
                        // so placeholder-based tools (display) can attach their
                        // render to the parent's tool_result slot — see
                        // executeDisplay's eager-render path. Without this,
                        // displays created via `executeTool('display', ...)`
                        // from inside the sandbox silently never render
                        // (placeholder string never makes it to the agent's reply).
                        // STABLE toolCallId (double-approval fix) — mirror of the
                        // offscreen bridge in platform/extension/offscreen-helper.js.
                        // Derive a deterministic `prog_<parent>_<callCounter>` id so an
                        // inner 'ask' tool (e.g. web_fetch) that the agent loop
                        // re-dispatches (reload / replay) matches its persisted
                        // approval instead of re-prompting. Must START WITH 'prog_'
                        // so executePendingApprovedTools keeps skipping it (no
                        // double-execution) and must be a STRING (bare numeric d.id
                        // throws on .startsWith).
                        var toolPromise = executeTool(e.data.name, e.data.args, messageIndex, {
                            chatId: chatId,
                            fromSandbox: true,
                            toolCallId: 'prog_' + ((options && options.toolCallId) || 'np') + '_' + e.data.id,
                            parentToolCallId: options && options.toolCallId
                        });
                        var timeoutPromise = new Promise(function(_, rej) { setTimeout(function() { rej(new Error('Tool call timed out after 30s')); }, 30000); });
                        Promise.race([toolPromise, timeoutPromise])
                            .then(async function(result) {
                                if (result && result._screenshotMessage) {
                                    var ssMsg = result._screenshotMessage;
                                    if (ssMsg.screenshot_id) {
                                        var jsChat = chats[chatId];
                                        if (jsChat) {
                                            if (!jsChat.screenshots) jsChat.screenshots = {};
                                            jsChat.screenshots[ssMsg.screenshot_id] = { base64: ssMsg.base64, name: ssMsg.name, width: ssMsg.width, height: ssMsg.height, timestamp: ssMsg.timestamp, description: ssMsg.description };
                                            // Register in the file index so screenshot_by_id/getFile resolve it
                                            // immediately, and AWAIT the persistence write BEFORE the id is
                                            // posted back to the running js_eval code (avoids a phantom id).
                                            if (typeof registerFile === 'function') registerFile(ssMsg.screenshot_id, { type: 'screenshots_map', chatId: chatId });
                                            try { await saveChatsToStorage(); } catch (e) {}
                                        }
                                    }
                                    result.base64 = ssMsg.base64;
                                    result.width = ssMsg.width;
                                    result.height = ssMsg.height;
                                    result.screenshot_id = ssMsg.screenshot_id || result.screenshot_id;
                                    delete result._screenshotMessage;
                                }
                                sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: e.data.id, result: result }, '*');
                            })
                            .catch(function(err) {
                                sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: e.data.id, error: err.message }, '*');
                            });
                    } else if (e.data && e.data.type === MSG_DONE) {
                        window.removeEventListener('message', handleSandboxMessage);
                        sandboxMessageHandler = null;
                        if (e.data.error) rejectMain(new Error(e.data.error));
                        else resolveMain(e.data.result);
                    }
                }
                sandboxMessageHandler = handleSandboxMessage;
                window.addEventListener('message', handleSandboxMessage);

                sandbox.src = 'sandbox.html';
                document.body.appendChild(sandbox);
            });

            // INACTIVITY timeout (not a hard cap) — the clock resets on every inner
            // sandbox tool call (_sandboxActivity, touched at the top of executeTool
            // when fromSandbox:true), so long multi-call orchestrations (> 5 min)
            // survive while a sandbox that goes silent for 5 minutes is killed.
            // On timeout the rejection falls through to the catch below, which
            // removes the sandbox iframe and its message listener.
            var _jsEvalTimer = null;
            var result;
            if (chatId) _sandboxEvalCount[chatId] = (_sandboxEvalCount[chatId] || 0) + 1; // PR383-F1
            try {
                result = await Promise.race([
                    resultPromise,
                    new Promise(function(_, rej) {
                        var _pgLast = Date.now();
                        _jsEvalTimer = setInterval(function() {
                            // RES-1: hold the inactivity clock while an inner
                            // tool call is still in flight (see _sandboxPending).
                            // PR383-F2: capped hold — see _SANDBOX_HOLD_MAX_MS.
                            if (chatId && _sandboxPending[chatId] > 0) {
                                var _heldPg = _sandboxActivity[chatId] || _pgLast;
                                if (Date.now() - _heldPg < _SANDBOX_HOLD_MAX_MS) return;
                            }
                            var _act = chatId && _sandboxActivity[chatId];
                            if (_act && _act > _pgLast) _pgLast = _act;
                            if (Date.now() - _pgLast >= 5 * 60 * 1000) {
                                rej(new Error('js_eval timed out after 5 minutes of inactivity (no tool calls or completion)'));
                            }
                        }, 15000);
                    })
                ]);
            } finally {
                if (_jsEvalTimer) clearInterval(_jsEvalTimer);
                _sandboxEvalCleanup(chatId); // RES-1 + PR383-F1 (last-eval-out teardown)
            }
            document.body.removeChild(sandbox);
            var jsEvalResult = { success: true, result: result };
            // Extract _images from result: model-controlled image passing
            if (result && result._images && Array.isArray(result._images) && result._images.length > 0) {
                var imgs = result._images.filter(function(img) { return img && img.base64; });
                delete result._images;
                var screenshotMsgs = await Promise.all(imgs.map(async function(img) {
                    var ssId = newFileId();
                    var imgW = img.width || null;
                    var imgH = img.height || null;
                    // Look up dimensions from screenshots stored during this js_eval execution
                    if ((!imgW || !imgH) && chatId) {
                        var jsChat = chats[chatId];
                        if (jsChat && jsChat.screenshots) {
                            // Try matching by screenshot_id first, then by base64 prefix
                            if (img.screenshot_id && jsChat.screenshots[img.screenshot_id]) {
                                var stored = jsChat.screenshots[img.screenshot_id];
                                imgW = imgW || stored.width;
                                imgH = imgH || stored.height;
                            } else {
                                // Match by base64 prefix (first 200 chars avoids full string comparison)
                                var b64Prefix = img.base64 ? img.base64.substring(0, 200) : '';
                                for (var ssKey in jsChat.screenshots) {
                                    var ss = jsChat.screenshots[ssKey];
                                    if (ss.base64 && ss.base64.substring(0, 200) === b64Prefix) {
                                        imgW = imgW || ss.width;
                                        imgH = imgH || ss.height;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    // Resize if either dimension exceeds limit (Anthropic caps at 2000px for many-image requests)
                    var resized = await resizeImageIfNeeded(img.base64);
                    return {
                        role: 'screenshot',
                        base64: resized.base64,
                        name: img.name || null,
                        description: img.description || 'Image from js_eval',
                        timestamp: Date.now(),
                        width: resized.width,
                        height: resized.height,
                        screenshot_id: ssId,
                        file_id: ssId
                    };
                }));
                if (screenshotMsgs.length === 1) {
                    jsEvalResult._screenshotMessage = screenshotMsgs[0];
                } else {
                    jsEvalResult._screenshotMessages = screenshotMsgs;
                }
            }
            return jsEvalResult;
        } catch (e) {
            // sandbox / sandboxMessageHandler are only defined on the DOM
            // fallback path (page bundle) — they're undefined in the SW
            // worker context that bridges to offscreen.
            if (typeof sandboxMessageHandler !== 'undefined' && sandboxMessageHandler) {
                try { window.removeEventListener('message', sandboxMessageHandler); } catch (cleanupErr) {}
            }
            if (typeof sandbox !== 'undefined' && sandbox && sandbox.parentNode) {
                try { sandbox.parentNode.removeChild(sandbox); } catch (cleanupErr) {}
            }
            return { success: false, error: e.message };
        }
    } else if (name === 'list_instances') {
        // List all connected ServiceNow instances
        if (args.refresh && Platform.refreshInstances) {
            await Platform.refreshInstances();
        }
        return {
            success: true,
            instances: Platform.instances.map(function(inst) {
                return {
                    shortName: inst.shortName,
                    url: inst.url,
                    activeTabs: (inst.tabs || []).map(function(t) { return { id: t.id, title: t.title, url: t.url }; }),
                    connected: !!inst.token,
                    userName: inst.userName || '',
                    roles: inst.roles || [],
                    tabCount: (inst.tabs || []).length
                };
            }),
            activeInstance: Platform.instanceUrl ? Platform.instanceUrl.replace(/^https?:\/\//, '').split('.')[0] : ''
        };
    } else if (name === 'servicenow_api' && !(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.table))) {
        return { success: false, error: 'Invalid table name: must be alphanumeric/underscores only' };
    } else if (name === 'servicenow_api' && args.sys_id && args.sys_id !== '-1' && !(/^[0-9a-fA-F]{32}$/.test(args.sys_id))) {
        return { success: false, error: 'Invalid sys_id: must be a 32-character hex string or -1' };
    } else if (name === 'servicenow_api' && args.table === 'attachment' && args.method === 'POST' && args.attachment_data) {
        // Attachment upload via /api/now/attachment/file
        try {
            if (!args.attachment_file_name) return { success: false, error: 'attachment_file_name is required for attachment upload' };
            if (!args.attachment_table_name) return { success: false, error: 'attachment_table_name is required for attachment upload' };
            if (!args.attachment_table_sys_id) return { success: false, error: 'attachment_table_sys_id is required for attachment upload' };

            // Resolve target instance for attachments
            var _attachInstanceUrl = null;
            var _attachToken = null;
            if (args.instance) {
                _attachInstanceUrl = Platform.resolveInstanceUrl(args.instance);
                if (!_attachInstanceUrl) {
                    return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
                }
                _attachToken = await Platform.getTokenForInstance(_attachInstanceUrl);
                if (!_attachToken) {
                    return { success: false, error: 'No token available for instance "' + args.instance + '". Ensure a tab is open for that instance.' };
                }
            }

            // Detect content type from file extension if not provided
            var contentType = args.attachment_content_type;
            if (!contentType) {
                var ext = (args.attachment_file_name.split('.').pop() || '').toLowerCase();
                var mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', html: 'text/html', zip: 'application/zip', js: 'text/javascript', css: 'text/css' };
                contentType = mimeMap[ext] || 'application/octet-stream';
            }

            // Decode base64 data (handle data URL prefix)
            var base64Raw = args.attachment_data;
            if (base64Raw.indexOf(',') !== -1) {
                base64Raw = base64Raw.split(',')[1];
            }
            var binaryStr = atob(base64Raw);
            var bytes = new Uint8Array(binaryStr.length);
            for (var bi = 0; bi < binaryStr.length; bi++) {
                bytes[bi] = binaryStr.charCodeAt(bi);
            }

            var attachUrl = '/api/now/attachment/file?table_name=' + encodeURIComponent(args.attachment_table_name) +
                '&table_sys_id=' + encodeURIComponent(args.attachment_table_sys_id) +
                '&file_name=' + encodeURIComponent(args.attachment_file_name);
            if (_attachInstanceUrl) attachUrl = _attachInstanceUrl + attachUrl;
            var _attachApiToken = _attachToken || Platform.getSessionToken() || '';
            var attachOpts = {
                method: 'POST',
                headers: {
                    'Content-Type': contentType,
                    'Accept': 'application/json',
                    'X-UserToken': _attachApiToken
                },
                body: bytes.buffer
            };
            var res = await fetch(attachUrl, attachOpts);
            var _attachRespText = await res.text();
            var data;
            try { data = JSON.parse(_attachRespText); } catch(e) { data = { error: { message: 'Non-JSON response (HTTP ' + res.status + ')' } }; }
            return { success: res.ok, status: res.status, data: data };
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'servicenow_api' && args.table === 'attachment' && (args.method === 'GET' || args.method === 'DELETE')) {
        // Attachment read/delete via /api/now/attachment. The generic Table API
        // branch below would hit /api/now/table/attachment, which ServiceNow
        // rejects with HTTP 400 'Invalid table attachment'. Mirror the same
        // instance/token resolution used by the upload (POST) branch above.
        //   GET  -> /api/now/attachment (or /api/now/attachment/{sys_id})
        //   DELETE -> /api/now/attachment/{sys_id} (sys_id required)
        try {
            if (args.method === 'DELETE' && !args.sys_id) {
                return { success: false, error: 'sys_id is required to DELETE an attachment.' };
            }
            // Resolve target instance for attachments
            var _atInstanceUrl = null;
            var _atToken = null;
            if (args.instance) {
                _atInstanceUrl = Platform.resolveInstanceUrl(args.instance);
                if (!_atInstanceUrl) {
                    return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
                }
                _atToken = await Platform.getTokenForInstance(_atInstanceUrl);
                if (!_atToken) {
                    return { success: false, error: 'No token available for instance "' + args.instance + '" (' + _atInstanceUrl + '). Ensure a tab is open for that instance.' };
                }
            }

            var atUrl = '/api/now/attachment';
            if (args.sys_id) atUrl += '/' + args.sys_id;
            if (args.method === 'GET') {
                var atParams = [];
                if (args.query) atParams.push('sysparm_query=' + encodeURIComponent(args.query));
                if (args.fields) atParams.push('sysparm_fields=' + encodeURIComponent(args.fields));
                if (args.limit) atParams.push('sysparm_limit=' + args.limit);
                // BUG2-NIT: track an explicit sysparm_limit in url_params so the
                // default-cap below doesn't double-add a limit param.
                var _atHasUrlLimit = false;
                if (args.url_params && typeof args.url_params === 'object') {
                    Object.keys(args.url_params).forEach(function(key) {
                        if (key === 'sysparm_limit') _atHasUrlLimit = true;
                        atParams.push(encodeURIComponent(key) + '=' + encodeURIComponent(args.url_params[key]));
                    });
                }
                // BUG2-NIT: a bare GET on table:'attachment' with no sys_id and no
                // limit lists EVERY attachment in the instance. When neither a sys_id
                // nor any limit (args.limit or an explicit sysparm_limit in url_params)
                // is supplied, apply a default sysparm_limit=1000 to avoid an unbounded
                // dump. An explicit limit/query still wins.
                if (!args.sys_id && !args.limit && !_atHasUrlLimit) {
                    atParams.push('sysparm_limit=1000');
                }
                if (atParams.length) atUrl += '?' + atParams.join('&');
            }
            if (_atInstanceUrl) atUrl = _atInstanceUrl + atUrl;

            var _atApiToken = _atToken || Platform.getSessionToken() || '';
            var atRes = await fetch(atUrl, {
                method: args.method,
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-UserToken': _atApiToken }
            });
            var atData;
            if (atRes.status === 204) {
                atData = {};
            } else {
                var _atRespText = await atRes.text();
                try { atData = JSON.parse(_atRespText); } catch (e) { atData = { error: { message: 'Non-JSON response (HTTP ' + atRes.status + ')' } }; }
            }
            var _atResult = { success: atRes.ok, status: atRes.status, data: atData };
            if (_atInstanceUrl) _atResult.instance = args.instance;
            return _atResult;
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'servicenow_api') {
        // Resolve target instance (if specified)
        var _targetInstanceUrl = null;
        var _targetToken = null;
        if (args.instance) {
            _targetInstanceUrl = Platform.resolveInstanceUrl(args.instance);
            if (!_targetInstanceUrl) {
                return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
            }
            _targetToken = await Platform.getTokenForInstance(_targetInstanceUrl);
            if (!_targetToken) {
                return { success: false, error: 'No token available for instance "' + args.instance + '" (' + _targetInstanceUrl + '). Ensure a tab is open for that instance.' };
            }
        }

        var url = '/api/now/table/' + args.table;
        if (args.sys_id) url += '/' + args.sys_id;
        var params = [];
        if (args.query) params.push('sysparm_query=' + encodeURIComponent(args.query));
        if (args.fields) params.push('sysparm_fields=' + encodeURIComponent(args.fields));
        if (args.limit) params.push('sysparm_limit=' + args.limit);
        // Exclude reference links by default (returns just the value instead of {link, value} object)
        params.push('sysparm_exclude_reference_link=true');
        if (args.url_params && typeof args.url_params === 'object') {
            Object.keys(args.url_params).forEach(function(key) {
                params.push(encodeURIComponent(key) + '=' + encodeURIComponent(args.url_params[key]));
            });
        }
        // Handle sysparm_record_scope for modifying methods (POST, PUT, PATCH, DELETE)
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(args.method)) {
            var recordScope = args.scope || (args.data && args.data.sys_scope);
            if (!recordScope) {
                return { success: false, error: args.method + ' requests require a scope. Provide "scope" parameter or include "sys_scope" in data.' };
            }
            params.push('sysparm_record_scope=' + encodeURIComponent(recordScope));
        }
        if (params.length) url += '?' + params.join('&');

        // If targeting a different instance, prepend full URL so fetch intercept passes through
        if (_targetInstanceUrl) {
            url = _targetInstanceUrl + url;
        }

        try {
            var beforeVersion = null;
            var isModifyingRequest = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(args.method);
            if (isModifyingRequest && args.sys_id && !_targetInstanceUrl) {
                var versionBefore = await getRecordVersion(args.table, args.sys_id);
                beforeVersion = versionBefore ? versionBefore.sys_id : null;
            }

            var _apiToken = _targetToken || Platform.getSessionToken() || '';
            var opts = {
                method: args.method,
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-UserToken': _apiToken }
            };
            if (args.data && ['POST', 'PUT', 'PATCH'].includes(args.method)) {
                opts.body = JSON.stringify(args.data);
            }
            var res = await fetch(url, opts);
            var data;
            if (res.status === 204) {
                data = {};
            } else {
                var _apiRespText = await res.text();
                try { data = JSON.parse(_apiRespText); } catch(e) { data = { error: { message: 'Non-JSON response (HTTP ' + res.status + ')' } }; }
            }

            // Version history tracking (skip for cross-instance requests)
            if (res.ok && isModifyingRequest && !_targetInstanceUrl) {
                var recordSysId = args.sys_id || (data.result && data.result.sys_id);
                if (recordSysId) {
                    await new Promise(function(r) { setTimeout(r, 200); });
                    var versionAfter = await getRecordVersion(args.table, recordSysId);
                    var afterVersion = versionAfter ? versionAfter.sys_id : null;
                    var displayName = await getRecordDisplayValue(args.table, recordSysId);
                    trackRecordMutation({
                        chatId: (options && options.chatId) || activeStreamingChatId || currentChatId,
                        table: args.table,
                        sysId: recordSysId,
                        displayName: displayName,
                        action: args.method,
                        statusMessage: args.status_message || null,
                        messageIndex: messageIndex,
                        beforeVersion: beforeVersion,
                        afterVersion: afterVersion
                    });
                }
            }

            var _apiResult = { success: res.ok, status: res.status, data: data };
            if (_targetInstanceUrl) _apiResult.instance = args.instance;
            return _apiResult;
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'servicenow_run_script') {
        // Run a server-side JS snippet via /sys.scripts.do
        if (!args.script || typeof args.script !== 'string') {
            return { success: false, error: 'script is required (non-empty string)' };
        }
        // Resolve target instance (if specified)
        var _rsTargetUrl = null;
        var _rsTargetToken = null;
        if (args.instance) {
            _rsTargetUrl = Platform.resolveInstanceUrl(args.instance);
            if (!_rsTargetUrl) {
                return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
            }
            _rsTargetToken = await Platform.getTokenForInstance(_rsTargetUrl);
            if (!_rsTargetToken) {
                return { success: false, error: 'No token available for instance "' + args.instance + '".' };
            }
        }
        var _rsScope = args.scope || 'global';
        var _rsParams = [
            'script=' + encodeURIComponent(args.script),
            'sys_scope=' + encodeURIComponent(_rsScope),
            'runscript=' + encodeURIComponent('Run script')
        ];
        if (args.record_for_rollback !== false) _rsParams.push('record_for_rollback=on');
        if (args.sandbox === true) _rsParams.push('sandbox=on');
        var _rsUrl = '/sys.scripts.do?' + _rsParams.join('&');
        if (_rsTargetUrl) _rsUrl = _rsTargetUrl + _rsUrl;
        try {
            var _rsApiToken = _rsTargetToken || Platform.getSessionToken() || '';
            var _rsRes = await fetch(_rsUrl, {
                method: 'GET',
                headers: { 'Accept': 'text/html', 'X-UserToken': _rsApiToken }
            });
            var _rsText = await _rsRes.text();
            // Parse the response: extract output between <PRE>...</PRE> and execution history sys_id
            var _rsOutput = '';
            var _rsHistorySysId = null;
            var _rsCompleted = false;
            var preMatch = _rsText.match(/<PRE>([\s\S]*?)<\/PRE>/i);
            if (preMatch) {
                _rsOutput = preMatch[1].replace(/<BR\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
            }
            var histMatch = _rsText.match(/sys_script_execution_history\.do\?sys_id=([0-9a-f]{32})/i);
            if (histMatch) _rsHistorySysId = histMatch[1];
            if (/Script completed in scope/i.test(_rsText)) _rsCompleted = true;
            var _rsScopeMatch = _rsText.match(/Script completed in scope\s+([^:<\s]+)/i);
            var _rsActualScope = _rsScopeMatch ? _rsScopeMatch[1] : _rsScope;
            // Detect not authorized / errors
            if (!_rsRes.ok || /not authorized/i.test(_rsText)) {
                return {
                    success: false,
                    status: _rsRes.status,
                    error: /not authorized/i.test(_rsText) ? 'Not authorized to run scripts (check role/elevation)' : ('HTTP ' + _rsRes.status),
                    raw: _rsText.length > 2000 ? _rsText.substring(0, 2000) + '...' : _rsText
                };
            }
            // B3 fix: sys.scripts.do returns HTTP 200 (and often still prints
            // "Script completed in scope") even when the executed script THREW at
            // runtime — the Rhino/evaluator exception is rendered into the <PRE>
            // output. The old `success: _rsCompleted` therefore reported success:true
            // for a thrown script, so the caller couldn't tell a clean run from a
            // failed one. Detect an UNAMBIGUOUS evaluator/Java-exception signal in the
            // captured output and surface it. NOTE: "*** Script:" is the normal
            // gs.print log prefix, NOT an error — do not match on it.
            var _rsErrMatch = _rsOutput && _rsOutput.match(/(?:Evaluator error|Javascript compiler exception|org\.mozilla\.javascript\.[A-Za-z]*(?:Error|Exception)|java\.lang\.[A-Za-z.]*Exception)[^\n]*/i);
            var _rsScriptError = _rsErrMatch ? _rsErrMatch[0].trim() : null;
            var _rsResult = {
                // Flip success only on an unambiguous runtime-error signal; the
                // happy path (no error markers) keeps the original `_rsCompleted`.
                success: _rsCompleted && !_rsScriptError,
                status: _rsRes.status,
                output: _rsOutput,
                scope: _rsActualScope,
                executionHistorySysId: _rsHistorySysId,
                executionHistoryUrl: _rsHistorySysId ? '/sys_script_execution_history.do?sys_id=' + _rsHistorySysId : null
            };
            if (_rsScriptError) { _rsResult.hasError = true; _rsResult.script_error = _rsScriptError; }
            if (_rsTargetUrl) _rsResult.instance = args.instance;
            return _rsResult;
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'servicenow_diff_edit') {
        return await executeDiffEdit(args, messageIndex, options);
    } else if (name === 'iframe_tool') {
        return await executeIframeTool(args);
    } else if (name === 'set_chat_title') {
        return executeSetChatTitle(args, options);
    } else if (name === 'set_tldr') {
        return executeSetTldr(args, options);
    } else if (name === 'cached_content_outline') {
        var ccoChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
        return executeCachedContentOutline(ccoChatId, args);
    } else if (name === 'cached_content_search') {
        var ccsChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
        return executeCachedContentSearch(ccsChatId, args);
    } else if (name === 'cached_content_read') {
        var ccrChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
        return executeCachedContentRead(ccrChatId, args);
    } else if (name === 'get_skill') {
        return await executeGetSkill(args);
    } else if (name === 'manage_skill') {
        return await executeManageSkill(args);
    } else if (name === 'display') {
        return executeDisplay(args, messageIndex, options);
    } else if (name === 'document') {
        return await executeSmartDocument(args, messageIndex, options);
    } else if (name === 'prompt_user') {
        return await executePromptUser(args, options);
    } else if (name === 'update_action_state') {
        return await executeUpdateActionState(args, options);
    } else if (name === 'show_action_button') {
        return executeShowActionButton(args, messageIndex, options);
    } else if (name === 'html_widget') {
        return executeHtmlWidget(args, messageIndex, options);
    } else if (name === 'take_screenshot') {
        return await executeTakeScreenshot(args);
    } else if (name === 'screenshot_by_id') {
        return executeScreenshotById(args);
    } else if (name === 'get_file') {
        return await executeGetFile(args);
    } else if (name === 'read_attached_file') {
        return executeReadAttachedFile(args, options);
    } else if (name === 'web_fetch') {
        try {
            var _wfSaveFile = args.save_file;
            // Fetch directly from the SW. The Origin header is stripped by the
            // declarativeNetRequest rule scoped to initiatorDomains: [extension id],
            // so calling fetch() from this context behaves the same as the old
            // background-script round-trip. (chrome.runtime.sendMessage from a SW
            // is not delivered back to the same SW, which is why the previous
            // sendMessage-based path always failed with "message port closed".)
            var _wfOpts = {
                method: args.method || 'GET',
                // Shallow-copy so we never mutate the caller's headers object.
                headers: Object.assign({}, args.headers || {}),
                cache: 'no-store'
            };
            if (args.body && ['POST', 'PUT', 'PATCH'].includes(_wfOpts.method)) {
                _wfOpts.body = args.body;
            }
            // --- GitHub REST API auth injection -------------------------------
            // Reuse the GitHub token the workspace tool stores in chrome.storage
            // so REST calls work against PRIVATE repos. The token is attached
            // ONLY when the request targets the CONFIGURED instance's REST API
            // base (see getGitHubApiAuthForUrl below — the SAME match also makes
            // these calls confirm-governed in the approval gate). We never
            // override a caller-supplied header. No token / non-match => no-op.
            try {
                var _wfAuth = await getGitHubApiAuthForUrl(args.url);
                if (_wfAuth) {
                    // Case-insensitive presence check so caller-set headers win.
                    var _wfHasHeader = function(headerName) {
                        headerName = headerName.toLowerCase();
                        return Object.keys(_wfOpts.headers).some(function(k) { return k.toLowerCase() === headerName; });
                    };
                    if (!_wfHasHeader('authorization')) _wfOpts.headers['Authorization'] = 'Bearer ' + _wfAuth.token;
                    if (!_wfHasHeader('accept')) _wfOpts.headers['Accept'] = 'application/vnd.github+json';
                    if (!_wfHasHeader('x-github-api-version')) _wfOpts.headers['X-GitHub-Api-Version'] = '2022-11-28';
                }
            } catch (_wfGhErr) { /* malformed URL or storage read error: fall through unauthenticated (safe no-op) */ }
            // ------------------------------------------------------------------
            var _wfRes = await fetch(args.url, _wfOpts);
            var _wfCT = _wfRes.headers.get('content-type') || '';
            var _wfBody;
            if (_wfSaveFile) {
                var _wfBlob = await _wfRes.blob();
                _wfBody = await new Promise(function(resolve) {
                    var reader = new FileReader();
                    reader.onload = function() { resolve(reader.result); };
                    reader.readAsDataURL(_wfBlob);
                });
            } else {
                _wfBody = await _wfRes.text();
            }
            var _wfResult = { success: true, status: _wfRes.status, content_type: _wfCT };
            if (_wfSaveFile) {
                var _wfFileId = newFileId();
                var _wfName = args.url.split('/').pop().split('?')[0] || 'download';
                registerFile(_wfFileId, { type: 'memory', data: _wfBody, name: _wfName, mime: _wfCT || 'application/octet-stream' });
                _wfResult.file_id = _wfFileId;
                _wfResult.file_name = _wfName;
                _wfResult.file_size = _wfBody ? _wfBody.length : 0;
            } else {
                _wfResult.body = _wfBody;
            }
            return _wfResult;
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'workspace') {
        return await executeWorkspaceTool(args, options);
    } else if (name === 'eval_runner') {
        return await executeEvalRunner(args, options);
    } else if (isSkillTool(name)) {
        return await executeSkillTool(name, args, options);
    }
    return { success: false, error: 'Unknown tool' };
}

// =============================================
// GitHub REST API URL matching (shared)
// =============================================
// Single source of truth for "does this URL target the CONFIGURED GitHub REST
// API base?". Used by web_fetch token-injection (to attach the stored token)
// AND by the permission gate (to make these calls confirm-governed instead of
// always prompting). The base is derived EXACTLY like githubApi() in
// core/130-indexeddb.js:
//   - https://github.com -> https://api.github.com   (any path on host)
//   - GHE <instanceUrl>  -> <instanceUrl>/api/v3      (only /api/v3 paths)
// Matching the configured host+path guarantees we treat the RIGHT GitHub, and
// never leak the token to another host or to the GHE web UI (which shares the
// API host but not the /api/v3 path prefix).
//
// Returns { token, apiBase } when `url` matches AND a token is stored;
// otherwise null. Lives here because this file is bundled into BOTH the page
// and the worker (service-worker) bundles, so both approval gates can call it.
async function getGitHubApiAuthForUrl(url) {
    try {
        if (!url) return null;
        var gh = await new Promise(function(resolve) {
            chrome.storage.local.get(['githubToken', 'githubInstanceUrl'], function(d) { resolve(d || {}); });
        });
        var tok = gh && gh.githubToken;
        if (!tok) return null;
        var instance = gh.githubInstanceUrl || 'https://github.com';
        var apiBase = instance === 'https://github.com'
            ? 'https://api.github.com'
            : instance.replace(/\/$/, '') + '/api/v3';
        var req = new URL(url);
        var base = new URL(apiBase);
        var reqPath = req.pathname.toLowerCase();
        var basePath = base.pathname.replace(/\/$/, '').toLowerCase(); // '' for cloud, '/api/v3' for GHE
        var pathOk = basePath === '' || reqPath === basePath || reqPath.indexOf(basePath + '/') === 0;
        var hostOk = req.protocol === base.protocol
            && req.hostname.toLowerCase() === base.hostname.toLowerCase()
            && req.port === base.port;
        if (hostOk && pathOk) return { token: tok, apiBase: apiBase };
        return null;
    } catch (e) {
        return null; // malformed URL or storage read error: treat as non-match
    }
}

// Boolean convenience for the permission gate.
async function isConfiguredGitHubApiUrl(url) {
    return !!(await getGitHubApiAuthForUrl(url));
}

// =============================================
// Workspace tool implementation
// =============================================

var _wsMutatingActions = { write: 1, edit: 1, copy: 1, delete: 1, discard: 1, push: 1, branch: 1, move: 1 };

// Cross-chat conflict detection: surface a warning when one chat tries to
// mutate a file that another chat has uncommitted changes on. Each mutating
// action stamps last_modified_by_chat_id / _title / _at on the file record;
// subsequent mutations from a different chat are blocked unless force=true.
function _wsFormatAgo(ms) {
    if (!ms) return null;
    var diff = Math.max(0, Date.now() - ms);
    var s = Math.round(diff / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.round(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
}

function _wsCheckCrossChatConflict(file, chatId) {
    if (!file || !file.dirty) return null;
    var lastChat = file.last_modified_by_chat_id;
    if (!lastChat) return null;
    if (chatId && lastChat === chatId) return null;
    var otherTitle = file.last_modified_by_chat_title || '(untitled chat)';
    var when = file.last_modified_at || null;
    var ago = _wsFormatAgo(when);
    var stillRunning = (typeof isChatRunning === 'function') && isChatRunning(lastChat);
    // hard=true: other chat is actively running — block to avoid clobbering an in-flight agent.
    // hard=false: other chat is dormant/closed — surface as warning only; current chat takes over.
    var hard = !!stillRunning;
    var headline = stillRunning
        ? '\u26A0 ANOTHER AGENT IS ACTIVELY RUNNING in chat "' + otherTitle + '" (' + lastChat + ')'
        : '\u26A0 This file has uncommitted changes from another (dormant) chat "' + otherTitle + '" (' + lastChat + ')';
    if (ago) headline += ' \u2014 last edited ' + ago;
    headline += hard
        ? '. Coordinate with the other chat, or pass {"force": true} to override and clobber their work.'
        : '. The other chat is no longer running, so this mutation will silently take over ownership.';
    return {
        cross_chat_conflict: true,
        hard: hard,
        last_modified_by_chat_id: lastChat,
        last_modified_by_chat_title: otherTitle,
        last_modified_at: when,
        last_modified_ago: ago,
        last_modified_iso: when ? new Date(when).toISOString() : null,
        other_chat_running: stillRunning,
        message: headline
    };
}

// Decide whether a mutator should block on a cross-chat conflict.
// - force=true: always allow.
// - gitignored path (e.g. dist/, .env): always allow — generated artefacts shouldn't gate cross-chat work.
// - other chat dormant (hard=false): allow, surface as warning only.
// - other chat running (hard=true): block.
// Returns { block, warn } — at most one is non-null.
async function _wsConflictDecision(wk, filePath, file, chatId, force) {
    if (force) return { block: null, warn: null };
    if (filePath) {
        try {
            var isIgnored = await wsGetIgnoreFilter(wk);
            if (isIgnored(filePath)) return { block: null, warn: null };
        } catch (e) { /* ignore filter failure — fall through to normal check */ }
    }
    var conflict = _wsCheckCrossChatConflict(file, chatId);
    if (!conflict) return { block: null, warn: null };
    if (conflict.hard) return { block: conflict, warn: null };
    return { block: null, warn: conflict };
}

function _wsResolveChat(options) {
    var chatId = (options && options.chatId)
        || (typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId)
        || (typeof currentChatId !== 'undefined' && currentChatId)
        || null;
    var chatTitle = null;
    if (chatId && typeof chats !== 'undefined' && chats[chatId]) {
        chatTitle = chats[chatId].title || null;
    }
    return { chatId: chatId, chatTitle: chatTitle };
}

async function executeWorkspaceTool(args, options) {
    var action = args.action;
    var who = _wsResolveChat(options);
    var chatId = who.chatId;
    var chatTitle = who.chatTitle;
    var force = !!args.force;

    try {
        if (action === 'clone') {
            if (!args.repo) return { success: false, error: 'repo is required for clone' };
            return await wsClone(args.repo, args.branch);
        }
        if (action === 'list') {
            var allMetas = await getAllWorkspaceMetas();
            var workspaces = [];
            for (var _li = 0; _li < allMetas.length; _li++) {
                var _lm = allMetas[_li];
                var _lFiles = await getAllWorkspaceFiles(_lm.repo);
                var _lIgnored = await wsGetIgnoreFilter(_lm.repo);
                var _lDirty = _lFiles.filter(function(f) { return f.dirty && !_lIgnored(f.path); });
                workspaces.push({
                    workspace: _lm.repo,
                    repo: _lm.github_repo || parseWsKey(_lm.repo).repo,
                    branch: _lm.branch,
                    files: _lFiles.length,
                    dirty: _lDirty.length,
                    prs: _lm.prs || [],
                    pinned: !!_lm.pinned,
                    forked_from: _lm.forked_from || null
                });
            }
            return { success: true, workspaces: workspaces, total: workspaces.length };
        }
        // All other actions resolve workspace from optional workspace param or default
        var wk = await resolveWorkspace(args.workspace);
        if (wk && wk.error) return { success: false, error: wk.error };
        var result;
        var _incIgnored = !!args.include_git_ignored;
        if (action === 'ls') {
            result = await wsLs(wk, args.path || '', _incIgnored);
        } else if (action === 'read') {
            result = await wsRead(wk, args.path, args.offset, args.limit, chatId);
        } else if (action === 'write') {
            var _wsContent = args.content;
            if (args.file_id && !_wsContent) {
                var _wsFile = await getFileAsync(args.file_id);
                if (!_wsFile) _wsFile = getFile(args.file_id);
                if (!_wsFile) return { success: false, error: 'File not found: ' + args.file_id };
                _wsContent = _wsFile.data;
                // Convert data URLs to workspace binary format (::binary::<raw_base64>)
                if (typeof _wsContent === 'string' && _wsContent.indexOf('data:') === 0) {
                    var _wsComma = _wsContent.indexOf(',');
                    if (_wsComma > -1 && _wsContent.indexOf(';base64,') > -1) {
                        _wsContent = '::binary::' + _wsContent.substring(_wsComma + 1);
                    }
                }
            }
            result = await wsWrite(wk, args.path, _wsContent, chatId, chatTitle, force);
        } else if (action === 'edit') {
            result = await wsEdit(wk, args.path, args.edits, chatId, chatTitle, force);
        } else if (action === 'copy') {
            result = await wsCopy(wk, args.path, args.dest, chatId, chatTitle, force);
        } else if (action === 'delete') {
            result = await wsDelete(wk, args.path, chatId, chatTitle, force);
        } else if (action === 'grep') {
            result = await wsGrep(wk, args.pattern, args.path, _incIgnored, args.force === true);
        } else if (action === 'status') {
            result = await wsStatus(wk, _incIgnored, chatId);
        } else if (action === 'diff') {
            result = await wsDiff(wk, args.path, _incIgnored);
        } else if (action === 'push') {
            result = await wsPush(wk, args);
        } else if (action === 'deploy') {
            result = await wsDeploy(wk, args.path, args.dest);
        } else if (action === 'discard') {
            result = await wsDiscard(wk, args.path, chatId, chatTitle, force);
        } else if (action === 'pin') {
            // Pin (or unpin) a workspace. At most one pinned workspace per
            // owner/repo — setWorkspacePin clears any sibling pin. The pinned
            // workspace wins default resolution and extension_build auto-detect.
            result = await setWorkspacePin(wk, !!args.unpin);
        } else if (action === 'branch') {
            // Local fork: copy this workspace's rows into owner/repo::<branch>.
            // The remote branch is created lazily by the first push.
            result = await wsBranch(wk, args.branch, args.move_dirty !== false, chatId, chatTitle);
        } else if (action === 'move') {
            // Move dirty edits from this workspace onto another workspace.
            result = await wsMove(wk, args.to, args.files, force, chatId, chatTitle);
        } else if (action === 'hydrate') {
            // Internal-ish action: bulk-hydrate lazy stubs (optionally limited
            // to a path prefix). Used by the extension_build skill tool.
            result = await wsHydrate(wk, args.path ? function(p) { return p.indexOf(args.path) === 0; } : null);
        } else {
            return { success: false, error: 'Unknown workspace action: ' + action };
        }
        // Notify panel after mutating actions. The header refresh used to be
        // called inline (updateWorkspaceHeaderStatus); now we emit and let the
        // panel subscriber decide what to refresh.
        if (_wsMutatingActions[action] && result && result.success) {
            AgentEvents.emit('workspaceMutated', {
                chatId: chatId,
                action: action,
                repo: wk,
                branch: (wk && parseWsKey(wk).branch) || null,
                path: args.path || null
            });
        }
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Decode a REST blob API response body ({content, encoding}) into workspace
// content: UTF-8 text, or '::binary::<raw_base64>' when the bytes are not
// valid UTF-8. Shared by wsHydrate's REST fallback, wsPull and wsSyncWithRemote.
function _wsDecodeBlobBody(body) {
    if (body.encoding !== 'base64') return body.content;
    var raw = (body.content || '').replace(/\n/g, '');
    var binStr = atob(raw);
    var bytes = new Uint8Array(binStr.length);
    for (var bi = 0; bi < binStr.length; bi++) bytes[bi] = binStr.charCodeAt(bi);
    var decoded = new TextDecoder('utf-8', { fatal: true });
    try {
        return decoded.decode(bytes);
    } catch (e) {
        // Not valid UTF-8 — binary file
        return '::binary::' + raw;
    }
}

async function wsClone(repo, branch) {
    branch = branch || 'main';
    var gh = await loadGitHubSettings();
    if (!gh.token) return { success: false, error: 'GitHub not connected. Go to Settings > GitHub to add a token.' };

    var wk = wsKey(repo, branch);

    // Resolve the branch ref BEFORE wiping any existing clone. The previous
    // order deleted the existing workspace as soon as the user re-cloned the
    // same repo::branch — so a transient GitHub failure (auth expired, network
    // down) would surface as both "branch not found" AND a destroyed workspace
    // that hadn't actually been replaced. Now we only delete after the new
    // ref is confirmed live.
    var refRes = await githubApi('GET', '/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(branch));
    if (!refRes.ok) {
        // Try 'master' fallback if 'main' was default
        if (branch === 'main') {
            refRes = await githubApi('GET', '/repos/' + repo + '/git/ref/heads/master');
            if (refRes.ok) { branch = 'master'; wk = wsKey(repo, branch); }
        }
        if (!refRes.ok) {
            var _refErr = refRes && refRes.error ? refRes.error : ('HTTP ' + (refRes && refRes.status));
            return { success: false, error: 'Branch "' + branch + '" not found. ' + _refErr };
        }
    }
    var headSha = refRes.body.object.sha;

    // Get full tree
    var treeRes = await githubApi('GET', '/repos/' + repo + '/git/trees/' + headSha + '?recursive=1');
    if (!treeRes.ok) {
        var _treeErr = treeRes && treeRes.error ? treeRes.error : ('HTTP ' + (treeRes && treeRes.status));
        return { success: false, error: 'Failed to fetch tree: ' + _treeErr };
    }

    // GitHub truncates recursive trees (~100k entries / 7MB). A truncated tree
    // would produce a silently incomplete clone — refuse instead (and before
    // deleting any existing clone).
    if (treeRes.body && treeRes.body.truncated) {
        return { success: false, error: 'GitHub truncated the recursive tree for ' + repo + ' (' + branch + ') — the repo has too many files for a complete clone. Aborting to avoid an incomplete workspace.' };
    }

    // Now that we have a live tree, replace any existing clone.
    var existing = await getWorkspaceMeta(wk);
    if (existing) {
        await deleteWorkspaceFiles(wk);
        await deleteWorkspaceMeta(wk);
    }

    var tree = treeRes.body.tree.filter(function(e) { return e.type === 'blob'; });
    var fileCount = tree.length;

    // Build SHA -> content cache from blobs we already have locally.
    // Git blobs are content-addressed: same SHA == same bytes, so we can skip
    // the fetch. Primary source is the shared workspace_blobs store (one
    // batched lookup over all tree shas); a legacy scan over raw
    // workspace_files rows remains as a fallback merge for un-migrated rows
    // that still carry inline original_content.
    var shaCache = {};
    try {
        var treeShas = [];
        for (var tsi = 0; tsi < tree.length; tsi++) {
            if (tree[tsi] && tree[tsi].sha) treeShas.push(tree[tsi].sha);
        }
        var blobHits = await getWorkspaceBlobsBySha(treeShas);
        for (var bk in blobHits) {
            if (Object.prototype.hasOwnProperty.call(blobHits, bk)) shaCache[bk] = blobHits[bk];
        }
    } catch (e) { /* non-fatal — fall through to legacy scan / full fetch */ }
    try {
        var existingFiles = await getAllWorkspaceFilesAllRepos();
        for (var ei = 0; ei < existingFiles.length; ei++) {
            var ef = existingFiles[ei];
            if (ef && ef.sha && ef.original_content != null && shaCache[ef.sha] === undefined) {
                shaCache[ef.sha] = ef.original_content;
            }
        }
    } catch (e) { /* non-fatal — fall through to full fetch */ }

    // Helper: persist a single tree entry. content == null means a lazy stub —
    // the blob content is fetched on demand later by wsHydrate.
    async function _storeEntry(entry, content, isStub) {
        var _wsFileId = newFileId();
        await setWorkspaceFile({
            id: wk + '::' + entry.path,
            repo: wk,
            path: entry.path,
            sha: entry.sha,
            size: entry.size != null ? entry.size : null,
            content: content,
            original_content: content,
            stub: !!isStub,
            dirty: false,
            file_id: _wsFileId,
            pushed_pr: null,
            pushed_shas: null
        });
        registerFile(_wsFileId, { type: 'workspace', workspace: wk, path: entry.path });
    }

    // Lazy clone: store every entry as a stub (sha + size only); content is
    // hydrated on demand by wsHydrate. Entries whose sha is already cached
    // locally (any workspace) are stored hydrated for free.
    var reusedCount = 0;
    for (var ti = 0; ti < tree.length; ti++) {
        var te = tree[ti];
        if (shaCache[te.sha] !== undefined) {
            await _storeEntry(te, shaCache[te.sha], false);
            reusedCount++;
        } else {
            await _storeEntry(te, null, true);
        }
    }

    // Save metadata — carry pin state + fork lineage across a re-clone.
    // Rebuilding meta from scratch silently UNPINNED a pinned workspace, so
    // Reload/default resolution could switch to a different workspace.
    var _newMeta = {
        repo: wk,
        github_repo: repo,
        branch: branch,
        head_sha: headSha,
        tree_sha: treeRes.body.sha,
        lazy: true,
        cloned_at: Date.now()
    };
    if (existing) {
        if (existing.pinned) _newMeta.pinned = true;
        if (existing.forked_from) _newMeta.forked_from = existing.forked_from;
        if (existing.base_branch) _newMeta.base_branch = existing.base_branch;
    }
    await setWorkspaceMeta(_newMeta);

    // Eagerly hydrate the root .gitignore — wsGetIgnoreFilter needs it for
    // nearly every other workspace action.
    try { await wsHydrate(wk, ['.gitignore']); } catch (e) { /* non-fatal */ }

    refreshWorkspaceContext(); // update system prompt context
    AgentEvents.emit('workspaceMutated', { action: 'clone', repo: wk, branch: branch });
    // Best-effort orphan blob GC (fire-and-forget): the new rows are already
    // stored, so their shas are in the KEEP set.
    try { gcWorkspaceBlobs(); } catch (e) {}
    var _msg = 'Cloned ' + repo + ' (' + branch + '): ' + fileCount + ' files indexed (lazy), ' + reusedCount + ' hydrated from cache';
    return { success: true, workspace: wk, message: _msg, branch: branch, files: fileCount, reused: reusedCount };
}

// Hydrate lazy stub files (stub records have content == null) by fetching blob
// contents from GitHub.
//   matcher: null = all stubs | function(path) -> bool | array of exact paths.
// Uses ONE GraphQL call per batch (aliases b0..bN resolving Blob objects);
// falls back to REST GET /git/blobs/{sha} for binary/truncated blobs or when
// the GraphQL call itself fails. Idempotent: records already hydrated (e.g. by
// a concurrent call) are skipped, so overlapping calls are safe.
async function wsHydrate(wk, matcher) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.', hydrated: 0, failed: [] };
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;

    var stubs;
    if (Array.isArray(matcher)) {
        // Fast path: an explicit path list fetches only those records instead
        // of loading the whole workspace (incl. hydrated contents) from IDB.
        stubs = [];
        for (var _hi = 0; _hi < matcher.length; _hi++) {
            var _hf = await getWorkspaceFile(wk, matcher[_hi]);
            if (_hf && _hf.stub && _hf.content == null && !_hf.deleted) stubs.push(_hf);
        }
    } else {
        var files = await getAllWorkspaceFiles(wk);
        stubs = files.filter(function(f) {
            if (!f.stub || f.content != null || f.deleted) return false;
            if (typeof matcher === 'function') return !!matcher(f.path);
            return true;
        });
    }
    if (stubs.length === 0) return { success: true, hydrated: 0, failed: [] };

    var owner = githubRepo.split('/')[0];
    var repoName = githubRepo.split('/')[1];
    var hydrated = 0;
    var failed = [];
    var lastError = null; // cause of the most recent fetch failure (surfaced to callers)

    // Persist content onto the freshest record. Skips records hydrated in the
    // meantime (idempotency for concurrent-ish callers).
    async function _applyContent(stub, content) {
        var rec = await getWorkspaceFile(wk, stub.path);
        if (!rec) return;
        if (rec.sha !== stub.sha) {
            // Repointed mid-hydration (e.g. wsSyncWithRemote moved the stub to a
            // newer remote sha) — applying this older blob would store stale
            // content under the new sha. Drop it; the next read re-hydrates.
            failed.push(stub.path);
            lastError = 'sha repointed during hydration: ' + stub.path;
            return;
        }
        if (!rec.stub || rec.content != null) { hydrated++; return; }
        rec.content = content;
        rec.original_content = content;
        rec.stub = false;
        await setWorkspaceFile(rec);
        if (rec.file_id && !fileIndex.has(rec.file_id)) {
            registerFile(rec.file_id, { type: 'workspace', workspace: wk, path: rec.path });
        }
        hydrated++;
    }

    // REST fallback (parallel batches of 15) — same blob decode as wsPull.
    async function _restFallback(entries) {
        var BATCH_SIZE = 15;
        for (var ri = 0; ri < entries.length; ri += BATCH_SIZE) {
            var rbatch = entries.slice(ri, ri + BATCH_SIZE);
            var results = await Promise.all(rbatch.map(function(entry) {
                return githubApi('GET', '/repos/' + githubRepo + '/git/blobs/' + entry.sha);
            }));
            for (var rj = 0; rj < results.length; rj++) {
                var blobRes = results[rj];
                if (blobRes && blobRes.ok && blobRes.body && blobRes.body.content != null) {
                    await _applyContent(rbatch[rj], _wsDecodeBlobBody(blobRes.body));
                } else {
                    failed.push(rbatch[rj].path);
                    lastError = (blobRes && (blobRes.error || (blobRes.status ? 'HTTP ' + blobRes.status : null))) || 'no response';
                }
            }
        }
    }

    // Batch stubs: <=100 blobs AND <=~2MB cumulative size per GraphQL call.
    // A single file bigger than the byte cap gets its own batch (and lands on
    // the REST fallback if GraphQL truncates it).
    var MAX_BATCH_COUNT = 100;
    var MAX_BATCH_BYTES = 2000000;
    var batches = [];
    var cur = [];
    var curBytes = 0;
    for (var i = 0; i < stubs.length; i++) {
        var sz = stubs[i].size || 0;
        if (cur.length > 0 && (cur.length >= MAX_BATCH_COUNT || curBytes + sz > MAX_BATCH_BYTES)) {
            batches.push(cur);
            cur = [];
            curBytes = 0;
        }
        cur.push(stubs[i]);
        curBytes += sz;
    }
    if (cur.length > 0) batches.push(cur);

    var skipGraphql = false; // set on auth-type failures (401/403) — e.g. fine-grained PATs don't support the GraphQL API
    for (var b = 0; b < batches.length; b++) {
        var batch = batches[b];
        var gres = null;
        if (!skipGraphql) {
            var q = 'query { repository(owner: ' + JSON.stringify(owner) + ', name: ' + JSON.stringify(repoName) + ') {';
            for (var qi = 0; qi < batch.length; qi++) {
                q += ' b' + qi + ': object(oid: ' + JSON.stringify(batch[qi].sha) + ') { ... on Blob { text isBinary isTruncated byteSize } }';
            }
            q += ' } }';
            gres = await githubGraphql(q);
            if (gres && (gres.status === 401 || gres.status === 403)) skipGraphql = true;
        }
        var repoNode = gres && gres.ok && gres.body && gres.body.data && gres.body.data.repository;
        var fallbackEntries = [];
        if (!repoNode) {
            // Whole GraphQL call failed (network, auth, body.errors with no
            // data) — REST fallback for the entire batch.
            fallbackEntries = batch;
        } else {
            for (var ai = 0; ai < batch.length; ai++) {
                var node = repoNode['b' + ai];
                if (node && node.text != null && !node.isBinary && !node.isTruncated) {
                    await _applyContent(batch[ai], node.text);
                } else {
                    // Binary, truncated, or null node (bad oid / per-alias error)
                    fallbackEntries.push(batch[ai]);
                }
            }
        }
        if (fallbackEntries.length > 0) await _restFallback(fallbackEntries);
    }

    var _hRes = { success: failed.length === 0, hydrated: hydrated, failed: failed };
    if (lastError) _hRes.last_error = lastError;
    return _hRes;
}

async function wsLs(wk, dirPath, includeIgnored) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    var files = await getAllWorkspaceFiles(wk);
    // Filter out gitignored and deleted files
    var isIgnored = includeIgnored ? function() { return false; } : await wsGetIgnoreFilter(wk);
    files = files.filter(function(f) { return !f.deleted && !isIgnored(f.path); });
    // Normalize: strip leading/trailing slashes, empty or "/" means root
    var cleaned = (dirPath || '').replace(/^\/+|\/+$/g, '').replace(/^\.\/?$/, '');
    var prefix = cleaned ? cleaned + '/' : '';
    var entries = {};

    files.forEach(function(f) {
        var p = f.path;
        if (prefix && p.indexOf(prefix) !== 0) return;
        var rest = p.substring(prefix.length);
        var slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
            entries[rest] = { type: 'file', size: f.content != null ? f.content.length : (f.size || 0), dirty: f.dirty };
        } else {
            var dirName = rest.substring(0, slashIdx);
            if (!entries[dirName]) entries[dirName] = { type: 'dir', count: 0 };
            entries[dirName].count++;
        }
    });

    var listing = Object.keys(entries).sort().map(function(name) {
        var e = entries[name];
        return e.type === 'dir' ? name + '/ (' + e.count + ' files)' : name + (e.dirty ? ' *' : '');
    });

    return { success: true, path: prefix || '/', entries: listing, total: listing.length };
}

async function wsRead(repo, filePath, offset, limit, chatId) {
    if (!filePath) return { success: false, error: 'path is required for read' };
    var file = await getWorkspaceFile(repo, filePath);
    if (!file) return { success: false, error: 'File not found: ' + filePath };

    // Lazy clone: hydrate stub content on first read
    if (file.stub && file.content == null && !file.deleted) {
        var _rHyd = await wsHydrate(repo, [filePath]);
        file = await getWorkspaceFile(repo, filePath);
        if (!file) return { success: false, error: 'File not found: ' + filePath };
        if (!file.deleted && file.content == null) {
            var _rCause = _rHyd && (_rHyd.last_error || _rHyd.error);
            return { success: false, error: 'Failed to fetch file content from GitHub: ' + filePath + (_rCause ? ' (' + _rCause + ')' : ''), path: filePath };
        }
    }

    // Ensure file has a file_id (old clones may not have one) and register in memory index
    if (!file.file_id) {
        file.file_id = newFileId();
        setWorkspaceFile(file); // persist to IndexedDB
    }
    if (!fileIndex.has(file.file_id)) {
        registerFile(file.file_id, { type: 'workspace', workspace: repo, path: filePath });
    }

    if (file.deleted) return { success: false, error: 'File was deleted: ' + filePath + '. Use workspace write to recreate it.' };
    if (file.content.indexOf('::binary::') === 0) return { success: false, error: 'Binary file — cannot read as text. Use get_file to download.', file_id: file.file_id || null };

    var lines = file.content.split('\n');
    var startLine = (offset || 1) - 1;
    var endLine = limit ? startLine + limit : lines.length;
    var slice = lines.slice(startLine, endLine);
    var numbered = slice.map(function(line, i) { return (startLine + i + 1) + '\t' + line; }).join('\n');

    var resp = { success: true, path: filePath, content: numbered, total_lines: lines.length, dirty: file.dirty, file_id: file.file_id || null };
    // Surface cross-chat ownership so the agent can decide whether to coordinate before editing.
    // Skip for gitignored paths (generated artefacts) — ownership is not meaningful there.
    var _readIgnored;
    try { _readIgnored = await wsGetIgnoreFilter(repo); } catch (e) { _readIgnored = function(){return false;}; }
    var conflict = _readIgnored(filePath) ? null : _wsCheckCrossChatConflict(file, chatId);
    if (conflict) resp.cross_chat_warning = conflict;
    else if (file.dirty && file.last_modified_by_chat_id) {
        resp.last_modified_by_chat_id = file.last_modified_by_chat_id;
        resp.last_modified_by_chat_title = file.last_modified_by_chat_title || null;
        resp.last_modified_at = file.last_modified_at || null;
        resp.last_modified_ago = _wsFormatAgo(file.last_modified_at);
    }
    return resp;
}

async function wsWrite(repo, filePath, content, chatId, chatTitle, force) {
    if (!filePath) return { success: false, error: 'path is required for write' };
    if (content === undefined || content === null) return { success: false, error: 'content is required for write' };
    var meta = await getWorkspaceMeta(repo);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    var existing = await getWorkspaceFile(repo, filePath);
    // Lazy clone: hydrate a stub before overwriting so original_content is the
    // real base content (needed for the net-zero dirty calc below and for
    // later diff/discard). If hydration fails we still allow the write —
    // original_content stays null, so the file is treated as new (always dirty).
    if (existing && existing.stub && existing.content == null && !existing.deleted) {
        try { await wsHydrate(repo, [filePath]); } catch (e) { /* see comment above */ }
        existing = (await getWorkspaceFile(repo, filePath)) || existing;
    }
    var _wWriteDecision = await _wsConflictDecision(repo, filePath, existing, chatId, force);
    if (_wWriteDecision.block) {
        var blocked = _wWriteDecision.block;
        blocked.success = false;
        blocked.error = blocked.message;
        blocked.path = filePath;
        return blocked;
    }
    var wasDeleted = existing && existing.deleted;
    var _wrFileId = (existing && existing.file_id) || newFileId();
    // Net-zero edits (content matches original) should not be marked dirty.
    // A never-committed new file (original_content === null) is always dirty.
    var _origForWrite = existing ? existing.original_content : null;
    var _isDirty = (_origForWrite === null) ? true : (content !== _origForWrite);
    await setWorkspaceFile({
        id: repo + '::' + filePath,
        repo: repo,
        path: filePath,
        sha: existing ? existing.sha : null,
        content: content,
        original_content: _origForWrite,
        dirty: _isDirty,
        deleted: false,
        file_id: _wrFileId,
        pushed_pr: (existing && !wasDeleted) ? existing.pushed_pr : null,
        pushed_shas: (existing && !wasDeleted) ? existing.pushed_shas : null,
        last_modified_by_chat_id: _isDirty ? (chatId || null) : null,
        last_modified_by_chat_title: _isDirty ? (chatTitle || null) : null,
        last_modified_at: _isDirty ? Date.now() : null
    });
    registerFile(_wrFileId, { type: 'workspace', workspace: repo, path: filePath });
    var action = wasDeleted ? 'Restored' : (existing && !existing.deleted ? 'Updated' : 'Created');
    var resp = { success: true, message: action + ': ' + filePath, size: content.length, file_id: _wrFileId };
    if (_wWriteDecision.warn) resp.cross_chat_warning = _wWriteDecision.warn;
    return resp;
}

async function wsEdit(repo, filePath, edits, chatId, chatTitle, force) {
    if (!filePath) return { success: false, error: 'path is required for edit' };
    if (!edits || !edits.length) return { success: false, error: 'edits array is required' };
    var file = await getWorkspaceFile(repo, filePath);
    if (!file) return { success: false, error: 'File not found: ' + filePath };
    if (file.deleted) return { success: false, error: 'File was deleted: ' + filePath + '. Use workspace write to recreate it.' };

    // Lazy clone: hydrate stub content before applying edits
    if (file.stub && file.content == null) {
        var _eHyd = await wsHydrate(repo, [filePath]);
        file = await getWorkspaceFile(repo, filePath);
        var _eCause = _eHyd && (_eHyd.last_error || _eHyd.error);
        if (!file || file.content == null) return { success: false, error: 'Failed to fetch file content from GitHub: ' + filePath + (_eCause ? ' (' + _eCause + ')' : '') };
    }

    var _wEditDecision = await _wsConflictDecision(repo, filePath, file, chatId, force);
    if (_wEditDecision.block) {
        var blocked = _wEditDecision.block;
        blocked.success = false;
        blocked.error = blocked.message;
        blocked.path = filePath;
        return blocked;
    }

    var result = applySearchReplaceEdits(file.content, edits);
    if (result.error) return { success: false, error: 'All edits failed', validationErrors: result.messages };

    file.content = result.content;
    // Net-zero edits (content matches original after rollback) should not be marked dirty.
    // A never-committed new file (original_content === null) stays dirty.
    file.dirty = (file.original_content === null) ? true : (file.content !== file.original_content);
    if (file.dirty) {
        file.last_modified_by_chat_id = chatId || null;
        file.last_modified_by_chat_title = chatTitle || null;
        file.last_modified_at = Date.now();
    } else {
        file.last_modified_by_chat_id = null;
        file.last_modified_by_chat_title = null;
        file.last_modified_at = null;
    }
    await setWorkspaceFile(file);

    var resp = { success: true, editsApplied: result.appliedEdits };
    if (result.partialSuccess) { resp.partialSuccess = true; resp.failedEdits = result.failedEdits; }
    if (_wEditDecision.warn) resp.cross_chat_warning = _wEditDecision.warn;
    return resp;
}

async function wsCopy(wk, srcPath, destPath, chatId, chatTitle, force) {
    if (!srcPath) return { success: false, error: 'path is required for copy' };
    if (!destPath) return { success: false, error: 'dest is required for copy' };
    var file = await getWorkspaceFile(wk, srcPath);
    if (!file) return { success: false, error: 'Source file not found: ' + srcPath };
    if (file.deleted) return { success: false, error: 'Source file was deleted: ' + srcPath };
    // Lazy clone: hydrate stub content before copying
    if (file.stub && file.content == null) {
        var _cHyd = await wsHydrate(wk, [srcPath]);
        file = await getWorkspaceFile(wk, srcPath);
        var _cCause = _cHyd && (_cHyd.last_error || _cHyd.error);
        if (!file || file.content == null) return { success: false, error: 'Failed to fetch source file content from GitHub: ' + srcPath + (_cCause ? ' (' + _cCause + ')' : '') };
    }
    var existingDest = await getWorkspaceFile(wk, destPath);
    var _wCopyDecision = await _wsConflictDecision(wk, destPath, existingDest, chatId, force);
    if (_wCopyDecision.block) {
        var blocked = _wCopyDecision.block;
        blocked.success = false;
        blocked.error = blocked.message;
        blocked.path = destPath;
        return blocked;
    }
    var _cpFileId = (existingDest && existingDest.file_id) || newFileId();
    await setWorkspaceFile({
        id: wk + '::' + destPath,
        repo: wk,
        path: destPath,
        sha: null,
        content: file.content,
        original_content: null,
        dirty: true,
        deleted: false,
        file_id: _cpFileId,
        pushed_pr: null,
        pushed_shas: null,
        last_modified_by_chat_id: chatId || null,
        last_modified_by_chat_title: chatTitle || null,
        last_modified_at: Date.now()
    });
    registerFile(_cpFileId, { type: 'workspace', workspace: wk, path: destPath });
    var resp = { success: true, message: 'Copied ' + srcPath + ' → ' + destPath };
    if (_wCopyDecision.warn) resp.cross_chat_warning = _wCopyDecision.warn;
    return resp;
}

async function wsDelete(wk, filePath, chatId, chatTitle, force) {
    if (!filePath) return { success: false, error: 'path is required for delete' };
    var file = await getWorkspaceFile(wk, filePath);
    if (!file) return { success: false, error: 'File not found: ' + filePath };
    if (file.deleted) return { success: false, error: 'File already deleted: ' + filePath };

    var _wDelDecision = await _wsConflictDecision(wk, filePath, file, chatId, force);
    if (_wDelDecision.block) {
        var blocked = _wDelDecision.block;
        blocked.success = false;
        blocked.error = blocked.message;
        blocked.path = filePath;
        return blocked;
    }

    if (!file.sha) {
        // New file (never committed) — safe to remove from IndexedDB entirely
        try {
            var database = await openDatabase();
            var tx = database.transaction([workspaceFilesStoreName], 'readwrite');
            tx.objectStore(workspaceFilesStoreName).delete(file.id);
            await new Promise(function(resolve, reject) {
                tx.oncomplete = resolve;
                tx.onerror = function() { reject(tx.error); };
            });
            unregisterFile(file.file_id);
        } catch (e) {
            return { success: false, error: 'Failed to delete: ' + e.message };
        }
    } else {
        // Tracked file — mark as tombstone so push can delete from repo
        file.content = '';
        file.dirty = true;
        file.deleted = true;
        file.last_modified_by_chat_id = chatId || null;
        file.last_modified_by_chat_title = chatTitle || null;
        file.last_modified_at = Date.now();
        await setWorkspaceFile(file);
    }
    var resp = { success: true, message: 'Deleted: ' + filePath };
    if (_wDelDecision.warn) resp.cross_chat_warning = _wDelDecision.warn;
    return resp;
}

async function wsDiscard(wk, filePath, chatId, chatTitle, force) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    var files = await getAllWorkspaceFiles(wk);
    var targets = filePath
        ? files.filter(function(f) { return f.path === filePath; })
        : files.filter(function(f) { return f.dirty; });

    if (filePath && targets.length === 0) return { success: false, error: 'File not found: ' + filePath };
    if (targets.length === 0) return { success: true, message: 'No dirty files to discard', discarded: 0 };

    // Cross-chat guard — partition targets into proceedable vs blocked.
    // - force=true: all proceedable.
    // - gitignored path: proceedable (generated artefacts don't gate cross-chat work).
    // - other chat dormant (soft warn): proceedable, attach warning.
    // - other chat actively running (hard block): blocked unless force.
    // Single-file requests preserve old semantics: if the one file is blocked, return error.
    var proceedable = [];
    var blocking = [];
    var warnings = [];
    if (force) {
        proceedable = targets.slice();
    } else {
        var _disIgnored = await wsGetIgnoreFilter(wk);
        for (var ci = 0; ci < targets.length; ci++) {
            var tgt = targets[ci];
            if (_disIgnored(tgt.path)) { proceedable.push(tgt); continue; }
            var conflict = _wsCheckCrossChatConflict(tgt, chatId);
            if (conflict && conflict.hard) {
                blocking.push({ path: tgt.path, conflict: conflict });
            } else {
                if (conflict) warnings.push({ path: tgt.path, warning: conflict });
                proceedable.push(tgt);
            }
        }
    }

    if (filePath && blocking.length > 0 && proceedable.length === 0) {
        return {
            success: false,
            cross_chat_conflict: true,
            error: 'Discard blocked — file is locked by another running chat. Pass {"force": true} to override.',
            blocking_files: blocking
        };
    }

    var discarded = [];
    for (var i = 0; i < proceedable.length; i++) {
        var f = proceedable[i];
        if (!f.dirty) {
            if (filePath) return { success: false, error: 'File is not modified: ' + filePath };
            continue;
        }
        if (f.original_content === null && !(f.stub && f.sha)) {
            // New file — remove entirely
            try {
                var database = await openDatabase();
                var tx = database.transaction([workspaceFilesStoreName], 'readwrite');
                tx.objectStore(workspaceFilesStoreName).delete(f.id);
                await new Promise(function(resolve, reject) {
                    tx.oncomplete = resolve;
                    tx.onerror = function() { reject(tx.error); };
                });
                unregisterFile(f.file_id);
            } catch (e) {}
            discarded.push({ path: f.path, action: 'removed' });
        } else {
            // Modified or deleted file — restore original content. For a
            // tracked-but-never-hydrated stub (original_content null, stub +
            // sha set) this restores the stub itself: content goes back to
            // null and the blob is re-fetched on demand.
            f.content = f.original_content;
            f.dirty = false;
            f.deleted = false;
            f.pushed_pr = null;
            f.pushed_shas = null;
            f.last_modified_by_chat_id = null;
            f.last_modified_by_chat_title = null;
            f.last_modified_at = null;
            await setWorkspaceFile(f);
            discarded.push({ path: f.path, action: 'restored' });
        }
    }
    var resp = { success: true, message: 'Discarded changes to ' + discarded.length + ' file(s)', discarded: discarded.length, files: discarded };
    if (blocking.length > 0) {
        resp.skipped_files = blocking;
        resp.message += ' (' + blocking.length + ' file(s) skipped — locked by another running chat; pass {"force": true} to discard them too)';
    }
    if (warnings.length > 0) resp.cross_chat_warnings = warnings;
    return resp;
}

// =============================================
// Workspace pinning + local forks + edit moves
// =============================================

// Shared pin helper — used by the `pin` workspace action AND the workspace
// dropdown UI (040-tools-settings.js). Enforces the single-pin-per-repo
// invariant: pinning a workspace clears any other pin on workspaces of the
// same owner/repo. Pass unpin=true to clear this workspace's pin.
// The pinned workspace wins default-workspace resolution (resolveWorkspace)
// and the extension_build auto-detect, so "Reload" builds the pinned fork.
async function setWorkspacePin(wk, unpin) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Workspace "' + wk + '" not found.' };
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;
    var cleared = [];
    if (!unpin) {
        var all = await getAllWorkspaceMetas();
        for (var i = 0; i < all.length; i++) {
            var m = all[i];
            if (m && m.repo !== wk && m.pinned && (m.github_repo || parseWsKey(m.repo).repo) === githubRepo) {
                m.pinned = false;
                await setWorkspaceMeta(m);
                cleared.push(m.repo);
            }
        }
    }
    meta.pinned = !unpin;
    await setWorkspaceMeta(meta);
    try { refreshWorkspaceContext(); } catch (e) {}
    try { AgentEvents.emit('workspaceMutated', { action: 'pin', repo: wk, pinned: !unpin }); } catch (e) {}
    var res = { success: true, workspace: wk, pinned: !unpin };
    if (cleared.length) res.unpinned = cleared;
    return res;
}

// Local fork: create workspace owner/repo::<newBranch> by COPYING the source
// workspace's rows. Post-blob-store the rows are light sha refs, so the copy
// is cheap — sha/stub/size/flags are preserved, ids and file_ids are fresh,
// and pushed_pr/pushed_shas/cross-chat stamps are NOT copied. Dirty rows'
// overlay content travels to the fork (that is the point: work already
// started on the source branch moves to the fork). With moveDirty (default)
// the SOURCE's dirty files are then reverted clean (discard semantics) so
// the edits live in exactly one place; moveDirty=false keeps both.
// The REMOTE branch does not exist yet — wsPush creates the ref lazily on
// the first push, cutting it from the fork's base branch (meta.base_branch).
// The fork is pinned automatically (it is the workspace the user is about
// to work/build on).
async function wsBranch(wk, newBranch, moveDirty, chatId, chatTitle) {
    if (!newBranch || typeof newBranch !== 'string') return { success: false, error: 'branch (the new branch name) is required for the branch action' };
    newBranch = newBranch.replace(/^\s+|\s+$/g, '');
    if (!newBranch || newBranch.indexOf('::') !== -1 || /\s/.test(newBranch)) return { success: false, error: 'Invalid branch name: "' + newBranch + '"' };
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Workspace "' + wk + '" not found.' };
    if (newBranch === meta.branch) return { success: false, error: 'New branch name "' + newBranch + '" is the same as the source branch.' };
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;
    var targetWk = wsKey(githubRepo, newBranch);
    var existing = await getWorkspaceMeta(targetWk);
    if (existing) return { success: false, error: 'Workspace "' + targetWk + '" already exists. Use move to transfer edits, or delete it first.' };

    // Copy rows RAW (no blob resolution) — clean rows carry only sha refs;
    // dirty rows keep their inline overlay content, which must travel.
    var allRows = await getAllWorkspaceFilesAllRepos();
    var copied = 0;
    var dirtyCopied = [];
    for (var i = 0; i < allRows.length; i++) {
        var src = allRows[i];
        if (!src || src.repo !== wk) continue;
        var copy = Object.assign({}, src);
        copy.id = targetWk + '::' + src.path;
        copy.repo = targetWk;
        copy.file_id = newFileId();
        copy.pushed_pr = null;
        copy.pushed_shas = null;
        copy.last_modified_by_chat_id = null;
        copy.last_modified_by_chat_title = null;
        copy.last_modified_at = null;
        await setWorkspaceFile(copy);
        registerFile(copy.file_id, { type: 'workspace', workspace: targetWk, path: copy.path });
        copied++;
        if (src.dirty) dirtyCopied.push(src.path);
    }

    await setWorkspaceMeta({
        repo: targetWk,
        github_repo: githubRepo,
        branch: newBranch,
        forked_from: wk,
        base_branch: meta.branch,
        head_sha: meta.head_sha,
        tree_sha: meta.tree_sha,
        lazy: meta.lazy,
        cloned_at: Date.now(),
        last_used_at: Date.now()
    });

    // moveDirty (default): revert the SOURCE's dirty files so the edits live
    // only on the fork. force=true — the copy already preserved the edits.
    var movedOut = false;
    if (moveDirty !== false && dirtyCopied.length > 0) {
        try {
            var disc = await wsDiscard(wk, null, chatId, chatTitle, true);
            movedOut = !!(disc && disc.success);
        } catch (e) {}
    }

    var pinRes = null;
    try { pinRes = await setWorkspacePin(targetWk, false); } catch (e) {}

    try { refreshWorkspaceContext(); } catch (e) {}
    return {
        success: true,
        workspace: targetWk,
        forked_from: wk,
        branch: newBranch,
        base_branch: meta.branch,
        files: copied,
        dirty_files: dirtyCopied,
        dirty_moved: movedOut,
        pinned: !!(pinRes && pinRes.success),
        message: 'Forked "' + wk + '" → "' + targetWk + '" (' + copied + ' files, ' + dirtyCopied.length + ' dirty ' + (movedOut ? 'moved' : 'copied') + '). The remote branch does not exist yet — the first push creates it from base "' + meta.branch + '".'
    };
}

// Move dirty edits from workspace `wk` onto workspace `targetWk`.
// For each dirty source file the source's overlay content is written onto
// the target row (dirty recomputed against the TARGET's own original), then
// the source row is discarded (restored clean, or removed when it was a
// never-committed new file). Conflict policy:
//   - target row itself dirty with DIFFERENT content → the WHOLE move is
//     blocked (nothing moves) unless force, which overwrites.
//   - target base sha differs from source base sha → allowed, but reported
//     in base_diverged.
// Returns { success, moved: [...], skipped: [...], base_diverged: [...] }.
async function wsMove(wk, targetWk, paths, force, chatId, chatTitle) {
    if (!targetWk) return { success: false, error: '"to" (target workspace key) is required for move' };
    if (targetWk === wk) return { success: false, error: 'Source and target workspaces are identical.' };
    var srcMeta = await getWorkspaceMeta(wk);
    if (!srcMeta) return { success: false, error: 'Workspace "' + wk + '" not found.' };
    var tgtMeta = await getWorkspaceMeta(targetWk);
    if (!tgtMeta) return { success: false, error: 'Target workspace "' + targetWk + '" not found. Clone or branch it first.' };

    var files = await getAllWorkspaceFiles(wk);
    var dirtyRows = files.filter(function(f) { return f.dirty; });
    var skipped = [];
    var selected;
    if (Array.isArray(paths) && paths.length) {
        var byPath = {};
        dirtyRows.forEach(function(f) { byPath[f.path] = f; });
        selected = [];
        for (var i = 0; i < paths.length; i++) {
            var p = String(paths[i]).replace(/^\/+/, '');
            if (byPath[p]) selected.push(byPath[p]);
            else skipped.push({ path: p, reason: 'not dirty in source workspace' });
        }
    } else {
        selected = dirtyRows;
    }
    if (selected.length === 0) {
        return { success: true, moved: [], skipped: skipped, base_diverged: [], message: 'No dirty files to move.' };
    }

    // Pass 1 — plan + conflict detection. Any conflict blocks the WHOLE move
    // (unless force), so a half-moved state never exists.
    var plan = [];
    var conflicts = [];
    var baseDiverged = [];
    for (var si = 0; si < selected.length; si++) {
        var srcRow = selected[si];
        var tgtRow = await getWorkspaceFile(targetWk, srcRow.path);
        if (srcRow.deleted && (!tgtRow || tgtRow.deleted)) {
            // Moving a deletion needs an existing, not-already-deleted target.
            skipped.push({ path: srcRow.path, reason: tgtRow ? 'already deleted in target' : 'does not exist in target' });
            continue;
        }
        if (tgtRow && tgtRow.dirty) {
            var sameState = (!!srcRow.deleted === !!tgtRow.deleted) && (srcRow.deleted || tgtRow.content === srcRow.content);
            if (!sameState && !force) { conflicts.push(srcRow.path); continue; }
        }
        if (tgtRow && srcRow.sha && tgtRow.sha && tgtRow.sha !== srcRow.sha) baseDiverged.push(srcRow.path);
        plan.push({ src: srcRow, tgt: tgtRow });
    }
    if (conflicts.length > 0) {
        return {
            success: false,
            error: 'Move blocked — the target workspace has its own dirty changes with different content for: ' + conflicts.join(', ') + '. Pass {"force": true} to overwrite them, or move a narrower `files` list.',
            conflicts: conflicts,
            moved: [],
            skipped: skipped,
            base_diverged: []
        };
    }

    // Pass 2 — execute: write onto target, then discard the source row.
    var moved = [];
    for (var mi = 0; mi < plan.length; mi++) {
        var src = plan[mi].src;
        var tgt = plan[mi].tgt;
        if (src.deleted) {
            // Move a deletion: tombstone the target row (its own original is
            // kept for restore-on-discard).
            tgt.deleted = true;
            tgt.dirty = true;
            tgt.last_modified_by_chat_id = src.last_modified_by_chat_id || chatId || null;
            tgt.last_modified_by_chat_title = src.last_modified_by_chat_title || chatTitle || null;
            tgt.last_modified_at = Date.now();
            await setWorkspaceFile(tgt);
        } else if (tgt) {
            // Recompute dirty against the TARGET's own original.
            var clean = false;
            if (tgt.original_content != null) {
                clean = (src.content === tgt.original_content);
            } else if (tgt.sha) {
                try { clean = (await computeGitBlobSha(src.content)) === tgt.sha; } catch (e) { clean = false; }
            }
            if (clean) {
                // Content equals the target's own base — target stays/becomes clean.
                if (tgt.original_content != null) tgt.content = tgt.original_content;
                tgt.deleted = false;
                tgt.dirty = false;
                tgt.pushed_pr = null;
                tgt.pushed_shas = null;
                tgt.last_modified_by_chat_id = null;
                tgt.last_modified_by_chat_title = null;
                tgt.last_modified_at = null;
            } else {
                tgt.content = src.content;
                tgt.dirty = true;
                tgt.deleted = false;
                // A never-hydrated stub keeps stub:true (original_content is
                // unknown locally) so a later discard restores the stub itself.
                if (tgt.original_content != null) tgt.stub = false;
                tgt.last_modified_by_chat_id = src.last_modified_by_chat_id || chatId || null;
                tgt.last_modified_by_chat_title = src.last_modified_by_chat_title || chatTitle || null;
                tgt.last_modified_at = Date.now();
            }
            await setWorkspaceFile(tgt);
        } else {
            // No target row — becomes a new file in the target workspace.
            var nfId = newFileId();
            await setWorkspaceFile({
                id: targetWk + '::' + src.path,
                repo: targetWk,
                path: src.path,
                sha: null,
                size: null,
                content: src.content,
                original_content: null,
                stub: false,
                dirty: true,
                file_id: nfId,
                pushed_pr: null,
                pushed_shas: null,
                last_modified_by_chat_id: src.last_modified_by_chat_id || chatId || null,
                last_modified_by_chat_title: src.last_modified_by_chat_title || chatTitle || null,
                last_modified_at: Date.now()
            });
            registerFile(nfId, { type: 'workspace', workspace: targetWk, path: src.path });
        }
        // Discard the source row — restores clean content, releases ownership
        // stamps, removes never-committed new files (+ unregisters file_id).
        try { await wsDiscard(wk, src.path, chatId, chatTitle, true); } catch (e) {}
        moved.push(src.path);
    }

    try { refreshWorkspaceContext(); } catch (e) {}
    var result = {
        success: true,
        from: wk,
        to: targetWk,
        moved: moved,
        skipped: skipped,
        base_diverged: baseDiverged,
        message: 'Moved ' + moved.length + ' dirty file(s) from "' + wk + '" to "' + targetWk + '"' + (skipped.length ? ' (' + skipped.length + ' skipped)' : '') + '.'
    };
    if (baseDiverged.length > 0) {
        result.warning = 'Base diverged for ' + baseDiverged.length + ' file(s) — the target\'s original differs from the source\'s; review the diff in the target workspace.';
    }
    return result;
}

// Mirror of wsHydrate's batching rules — estimates request count, bytes and
// duration WITHOUT fetching. ~1.2s per GraphQL batch round-trip (measured on
// twbs/bootstrap hydrations). Used by wsGrep's slow-hydration guard.
// Heuristic: extensions GitHub's GraphQL Blob.text reports as isBinary — these
// land on the REST fallback (extra round trips the GraphQL batch count misses).
function _wsLikelyBinaryPath(p) {
    return /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|pdf|mp[34]|mov|avi|webm|wasm|exe|dll|so|dylib|class|bin)$/i.test(p);
}

function _wsEstimateHydration(stubs) {
    var MAX_BATCH_COUNT = 100;
    var MAX_BATCH_BYTES = 2000000;
    var batches = 0;
    var cur = 0, curBytes = 0, bytes = 0, binCount = 0;
    for (var i = 0; i < stubs.length; i++) {
        var sz = stubs[i].size || 0;
        bytes += sz;
        if (_wsLikelyBinaryPath(stubs[i].path)) binCount++;
        if (cur > 0 && (cur >= MAX_BATCH_COUNT || curBytes + sz > MAX_BATCH_BYTES)) {
            batches++; cur = 0; curBytes = 0;
        }
        cur++; curBytes += sz;
    }
    if (cur > 0) batches++;
    // GraphQL round trips (~1.2s each) + download time (~300 KB/s conservative)
    // + REST-fallback round trips for likely-binary blobs (batches of 15, ~1s).
    var seconds = batches * 1.2 + bytes / 300000 + Math.ceil(binCount / 15) * 1.0;
    return { batches: batches, bytes: bytes, binary_files: binCount, seconds: seconds };
}

async function wsGrep(repo, pattern, pathPrefix, includeIgnored, force) {
    if (!pattern) return { success: false, error: 'pattern is required for grep' };
    var meta = await getWorkspaceMeta(repo);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    var files = await getAllWorkspaceFiles(repo);
    var isIgnored = includeIgnored ? function() { return false; } : await wsGetIgnoreFilter(repo);
    var regex;
    try { regex = new RegExp(pattern, 'gim'); } catch (e) { return { success: false, error: 'Invalid regex: ' + e.message }; }

    // Lazy clone: hydrate all in-scope stubs (prefix + ignore filter) before scanning
    var _gScope = function(p) {
        if (pathPrefix && p.indexOf(pathPrefix) !== 0) return false;
        return !isIgnored(p);
    };

    // Slow-hydration guard: estimate the fetch cost BEFORE hydrating. A huge
    // scope (est. > 60s) is refused with a per-folder breakdown so the agent
    // can narrow the scope via `path` — or override with {"force": true}.
    if (!force) {
        var _gStubs = files.filter(function(f) {
            return f.stub && f.content == null && !f.deleted && _gScope(f.path);
        });
        if (_gStubs.length > 0) {
            var _gEst = _wsEstimateHydration(_gStubs);
            if (_gEst.seconds > 60) {
                var _gByDir = {};
                _gStubs.forEach(function(f) {
                    var rel = pathPrefix && f.path.indexOf(pathPrefix) === 0 ? f.path.substring(pathPrefix.length).replace(/^\//, '') : f.path;
                    var seg = rel.indexOf('/') === -1 ? '(files at this level)' : rel.split('/')[0] + '/';
                    if (!_gByDir[seg]) _gByDir[seg] = { files: 0, bytes: 0 };
                    _gByDir[seg].files++;
                    _gByDir[seg].bytes += f.size || 0;
                });
                var _gBreakdown = Object.keys(_gByDir).sort(function(a, b) { return _gByDir[b].files - _gByDir[a].files; }).slice(0, 15).map(function(d) {
                    return { folder: d, files: _gByDir[d].files, kb: Math.round(_gByDir[d].bytes / 1024) };
                });
                return {
                    success: false,
                    slow_grep: true,
                    error: 'Grep would first hydrate ' + _gStubs.length + ' files (' + (Math.round(_gEst.bytes / 104857.6) / 10) + ' MB, ~' + _gEst.batches + ' requests, est. ' + Math.round(_gEst.seconds) + 's > 60s). Narrow the scope with the `path` parameter (folder breakdown' + (pathPrefix ? ' relative to "' + pathPrefix + '"' : '') + ' in scope_breakdown), or pass {"force": true} to hydrate anyway.',
                    stub_files_in_scope: _gStubs.length,
                    estimated_seconds: Math.round(_gEst.seconds),
                    estimated_requests: _gEst.batches,
                    scope_breakdown: _gBreakdown
                };
            }
        }
    }

    try {
        var _gHyd = await wsHydrate(repo, _gScope);
        if (_gHyd && _gHyd.hydrated > 0) files = await getAllWorkspaceFiles(repo);
    } catch (e) { /* failed stubs are skipped in the scan loop below */ }

    var matches = [];
    var MAX_MATCHES = 100;
    var _gUnscanned = 0;
    for (var i = 0; i < files.length && matches.length < MAX_MATCHES; i++) {
        var f = files[i];
        if (f.deleted || isIgnored(f.path)) continue;
        if (f.content == null) {
            // Stub whose hydration failed — it was NOT scanned. Count it so the
            // result can say the search was incomplete.
            if (!pathPrefix || f.path.indexOf(pathPrefix) === 0) _gUnscanned++;
            continue;
        }
        if (f.content.indexOf('::binary::') === 0) continue;
        if (pathPrefix && f.path.indexOf(pathPrefix) !== 0) continue;
        var lines = f.content.split('\n');
        for (var ln = 0; ln < lines.length && matches.length < MAX_MATCHES; ln++) {
            regex.lastIndex = 0;
            if (regex.test(lines[ln])) {
                matches.push({ file: f.path, line: ln + 1, text: lines[ln].substring(0, 200) });
            }
        }
    }
    var _gRes = { success: true, pattern: pattern, matches: matches, total: matches.length, truncated: matches.length >= MAX_MATCHES };
    if (_gUnscanned > 0) {
        _gRes.unscanned_files = _gUnscanned;
        _gRes.warning = 'Incomplete search: ' + _gUnscanned + ' in-scope file(s) could not be hydrated from GitHub and were not scanned. Retry, or read them individually.';
    }
    return _gRes;
}

// Parse .gitignore and return a function that tests if a path is ignored
// Supports: negation (!pattern), anchored (/pattern), directories (pattern/),
// wildcards (* = single segment, ** = cross-directory)
function parseGitignore(content) {
    if (!content) return function() { return false; };
    var rules = [];
    content.split('\n').forEach(function(line) {
        line = line.replace(/#.*$/, '').trim();
        if (!line) return;
        var negate = false;
        if (line.charAt(0) === '!') { negate = true; line = line.substring(1); }
        var anchored = line.charAt(0) === '/';
        if (anchored) line = line.substring(1);
        // Trailing slash = directory pattern — strip it (matching logic treats it the same for files inside)
        if (line.length > 0 && line.charAt(line.length - 1) === '/') line = line.slice(0, -1);
        if (!line) return;
        var hasSlash = line.indexOf('/') !== -1;
        // Build regex: process ** before * to avoid double-conversion
        var escaped = '';
        for (var ci = 0; ci < line.length; ci++) {
            if (line[ci] === '*' && line[ci + 1] === '*') {
                if (line[ci + 2] === '/') {
                    // **/ = match any prefix (including none)
                    escaped += '(.+/)?';
                    ci += 2; // skip ** and /
                } else {
                    // /** or standalone ** = match everything
                    escaped += '.*';
                    ci += 1; // skip second *
                }
            } else if (line[ci] === '*') {
                escaped += '[^/]*'; // * matches within single path segment
            } else if ('.+^${}()|[]\\'.indexOf(line[ci]) !== -1) {
                escaped += '\\' + line[ci];
            } else {
                escaped += line[ci];
            }
        }
        rules.push({ regex: escaped, negate: negate, anchored: anchored || hasSlash });
    });
    return function(filePath) {
        var ignored = false;
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            var matched = false;
            if (r.anchored) {
                // Match from root of path only
                matched = new RegExp('^' + r.regex + '($|/)').test(filePath);
            } else {
                // Match basename or any path segment
                var basename = filePath.split('/').pop();
                matched = new RegExp('^' + r.regex + '$').test(basename) ||
                          new RegExp('(^|/)' + r.regex + '($|/)').test(filePath);
            }
            if (matched) ignored = !r.negate;
        }
        return ignored;
    };
}

async function wsGetIgnoreFilter(wk) {
    try {
        var gitignoreFile = await getWorkspaceFile(wk, '.gitignore');
        // Lazy clone: clone eagerly hydrates .gitignore, but retry here in case
        // that fetch failed. (wsHydrate never calls back into this — no recursion.)
        if (gitignoreFile && gitignoreFile.stub && gitignoreFile.content == null && !gitignoreFile.deleted) {
            try {
                await wsHydrate(wk, ['.gitignore']);
                gitignoreFile = await getWorkspaceFile(wk, '.gitignore');
            } catch (e) { /* fall through — no filter */ }
        }
        if (gitignoreFile && gitignoreFile.content) return parseGitignore(gitignoreFile.content);
    } catch (e) {}
    return function() { return false; };
}

async function wsStatus(wk, includeIgnored, chatId) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    // Sync with remote first — cleans up merged PRs, auto-deletes a merged
    // head-branch workspace whose base is cloned locally, and detects behind/
    // conflict files.
    var syncResult = null;
    try { syncResult = await wsSyncWithRemote(wk); } catch(e) {}

    // wsSyncWithRemote auto-deleted this workspace (branch merged into a locally
    // cloned base) — report that instead of normal status.
    if (syncResult && syncResult.deleted) {
        var _delRes = {
            success: true,
            workspace: wk,
            auto_deleted: true,
            branch: syncResult.branch,
            base_branch: syncResult.base_branch,
            pr_number: syncResult.pr_number,
            pr_url: syncResult.pr_url,
            moved_dirty: syncResult.moved_dirty || [],
            pin_flipped: !!syncResult.pin_flipped,
            base_synced: !!syncResult.base_synced,
            message: 'Workspace auto-deleted — branch "' + syncResult.branch + '" was merged (PR #' + syncResult.pr_number + ') into "' + syncResult.base_branch + '", which is cloned locally. The merged work remains available in the "' + syncResult.base_branch + '" workspace.'
        };
        if (syncResult.moved_dirty && syncResult.moved_dirty.length) _delRes.message += ' ' + syncResult.moved_dirty.length + ' dirty file(s) were moved to the base workspace.';
        if (syncResult.pin_flipped) _delRes.message += ' The pin now points at the base workspace.';
        if (syncResult.sync_warning) _delRes.sync_warning = syncResult.sync_warning;
        return _delRes;
    }

    // Re-read meta + files after sync (may have been updated)
    meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Workspace "' + wk + '" no longer exists.' };

    var files = await getAllWorkspaceFiles(wk);
    var isIgnored = includeIgnored ? function() { return false; } : await wsGetIgnoreFilter(wk);
    var foreignCount = 0;
    var foreignRunningCount = 0;
    var dirty = files.filter(function(f) { return f.dirty && !isIgnored(f.path); }).map(function(f) {
        var entry = { path: f.path, isNew: !f.sha && !f.deleted, isDeleted: !!f.deleted, size: f.deleted ? 0 : (f.content != null ? f.content.length : (f.size || 0)), pushed_pr: f.pushed_pr || null };
        if (f.last_modified_by_chat_id) {
            entry.last_modified_by_chat_id = f.last_modified_by_chat_id;
            entry.last_modified_by_chat_title = f.last_modified_by_chat_title || null;
            entry.last_modified_at = f.last_modified_at || null;
            entry.last_modified_ago = _wsFormatAgo(f.last_modified_at);
            // Human-readable per-file work-in-progress message so another agent
            // reading `status` immediately understands WHO is editing this file
            // (the owning chat/agent id) and that it is uncommitted WIP — instead
            // of having to infer it from the foreign_chat/other_chat_running flags.
            var _wAgo = entry.last_modified_ago ? (' (' + entry.last_modified_ago + ')') : '';
            var _wWho = entry.last_modified_by_chat_title ? (' titled "' + entry.last_modified_by_chat_title + '"') : '';
            if (chatId && f.last_modified_by_chat_id !== chatId) {
                entry.foreign_chat = true;
                if ((typeof isChatRunning === 'function') && isChatRunning(f.last_modified_by_chat_id)) {
                    entry.other_chat_running = true;
                    foreignRunningCount++;
                    entry.message = '\u26a0 WORK IN PROGRESS by another agent \u2014 chat/agent ' + f.last_modified_by_chat_id + _wWho + ' is STILL RUNNING and has uncommitted edits to this file' + _wAgo + '. Leave it alone: any mutation is blocked unless you pass {"force": true}, and forcing would clobber their unsaved work.';
                } else {
                    entry.message = 'Work in progress by another (now dormant) agent \u2014 chat/agent ' + f.last_modified_by_chat_id + _wWho + ' last edited this file' + _wAgo + '. Editing it will silently take over ownership from that agent.';
                }
                foreignCount++;
            } else {
                entry.message = 'Work in progress by THIS agent (chat/agent ' + f.last_modified_by_chat_id + ')' + _wAgo + ' \u2014 uncommitted local changes, not yet pushed.';
            }
        } else {
            entry.message = 'Work in progress \u2014 uncommitted local changes (the editing agent was not recorded for this file).';
        }
        return entry;
    });
    var activeFiles = files.filter(function(f) { return !f.deleted; });
    var result = { success: true, workspace: wk, repo: meta.github_repo || parseWsKey(wk).repo, branch: meta.branch, dirty_files: dirty, total_files: activeFiles.length, prs: meta.prs || [] };
    var _stubCount = files.filter(function(f) { return f.stub && f.content == null && !f.deleted; }).length;
    if (_stubCount > 0) result.stub_files = _stubCount;
    if (foreignCount > 0) {
        result.foreign_dirty_count = foreignCount;
        result.foreign_running_count = foreignRunningCount;
        if (foreignRunningCount > 0) {
            result.foreign_warning = foreignRunningCount + ' of ' + foreignCount + ' foreign dirty file(s) belong to a chat that is still running. Mutating those is blocked unless you pass {"force": true}. The remaining ' + (foreignCount - foreignRunningCount) + ' belong to dormant chats and will be silently taken over on next mutation.';
        } else {
            result.foreign_warning = foreignCount + ' dirty file(s) were last modified by other (now dormant) chats. Mutating any will silently take over ownership.';
        }
    }
    // Include sync info if available
    if (syncResult) {
        if (syncResult.synced > 0) result.synced = syncResult.synced;
        if (syncResult.behindFiles && syncResult.behindFiles.length > 0) result.behind_files = syncResult.behindFiles;
        if (syncResult.conflictFiles && syncResult.conflictFiles.length > 0) result.conflict_files = syncResult.conflictFiles;
        if (syncResult.merge_warning) result.merge_warning = syncResult.merge_warning;
    }
    // Pin state: expose this workspace's pin, and a short notice when a
    // SIBLING workspace of the same repo holds the pin (it — not this one —
    // wins default resolution and extension_build).
    if (meta.pinned) {
        result.pinned = true;
    } else {
        try {
            var _pinMetas = await getAllWorkspaceMetas();
            var _pinRepo = meta.github_repo || parseWsKey(wk).repo;
            for (var _pi = 0; _pi < _pinMetas.length; _pi++) {
                var _pm = _pinMetas[_pi];
                if (_pm && _pm.pinned && _pm.repo !== wk && (_pm.github_repo || parseWsKey(_pm.repo).repo) === _pinRepo) {
                    result.pin_notice = 'Note: "' + _pm.repo + '" is pinned for this repo — default workspace resolution and extension_build use it, not this workspace.';
                    break;
                }
            }
        } catch (e) {}
    }
    return result;
}

// Line-based unified diff: trims the common prefix/suffix, runs an LCS only on
// the changed middle, then emits hunks with `ctx` lines of context (@@ headers).
// Replaces the previous positional (same-index) comparison, which re-aligned the
// whole file on any insert/delete and produced massive noise anchored on repeated
// boilerplate lines (}/return;/blank). Display-only — never mutates file content.
function wsLineDiff(oldText, newText, ctx) {
    if (ctx == null) ctx = 3;
    var oldLines = String(oldText == null ? '' : oldText).split('\n');
    var newLines = String(newText == null ? '' : newText).split('\n');
    var m = oldLines.length, n = newLines.length;

    // Trim common prefix / suffix so the O(a*b) LCS only runs on the changed middle.
    var pre = 0;
    while (pre < m && pre < n && oldLines[pre] === newLines[pre]) pre++;
    var suf = 0;
    while (suf < (m - pre) && suf < (n - pre) && oldLines[m - 1 - suf] === newLines[n - 1 - suf]) suf++;

    var oldMid = oldLines.slice(pre, m - suf);
    var newMid = newLines.slice(pre, n - suf);
    var a = oldMid.length, b = newMid.length;

    // ops over the WHOLE file: { type:'same'|'add'|'remove', text, oldIdx, newIdx }
    var ops = [];
    var i, j, p;
    for (i = 0; i < pre; i++) ops.push({ type: 'same', text: oldLines[i], oldIdx: i, newIdx: i });

    if (a > 0 || b > 0) {
        var MAX_LCS_CELLS = 4000000;
        if (a * b <= MAX_LCS_CELLS) {
            var dp = [];
            for (i = 0; i <= a; i++) {
                dp[i] = [];
                for (j = 0; j <= b; j++) {
                    if (i === 0 || j === 0) dp[i][j] = 0;
                    else if (oldMid[i - 1] === newMid[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
                    else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
            var mid = [];
            i = a; j = b;
            while (i > 0 || j > 0) {
                if (i > 0 && j > 0 && oldMid[i - 1] === newMid[j - 1]) {
                    mid.unshift({ type: 'same', text: oldMid[i - 1], oldIdx: pre + i - 1, newIdx: pre + j - 1 });
                    i--; j--;
                } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                    mid.unshift({ type: 'add', text: newMid[j - 1], oldIdx: -1, newIdx: pre + j - 1 });
                    j--;
                } else {
                    mid.unshift({ type: 'remove', text: oldMid[i - 1], oldIdx: pre + i - 1, newIdx: -1 });
                    i--;
                }
            }
            ops = ops.concat(mid);
        } else {
            // Middle too large for an O(a*b) table — bounded positional fallback.
            var mx = Math.max(a, b);
            for (i = 0; i < mx; i++) {
                if (i >= a) ops.push({ type: 'add', text: newMid[i], oldIdx: -1, newIdx: pre + i });
                else if (i >= b) ops.push({ type: 'remove', text: oldMid[i], oldIdx: pre + i, newIdx: -1 });
                else if (oldMid[i] === newMid[i]) ops.push({ type: 'same', text: oldMid[i], oldIdx: pre + i, newIdx: pre + i });
                else {
                    ops.push({ type: 'remove', text: oldMid[i], oldIdx: pre + i, newIdx: -1 });
                    ops.push({ type: 'add', text: newMid[i], oldIdx: -1, newIdx: pre + i });
                }
            }
        }
    }

    for (p = 0; p < suf; p++) {
        var oi = m - suf + p, ni = n - suf + p;
        ops.push({ type: 'same', text: oldLines[oi], oldIdx: oi, newIdx: ni });
    }

    // Any real changes?
    var changed = false;
    for (p = 0; p < ops.length; p++) { if (ops[p].type !== 'same') { changed = true; break; } }
    if (!changed) return '';

    // Keep only ops within `ctx` lines of a change so long unchanged runs collapse.
    var keep = [];
    for (p = 0; p < ops.length; p++) keep[p] = false;
    for (p = 0; p < ops.length; p++) {
        if (ops[p].type !== 'same') {
            var lo = p - ctx; if (lo < 0) lo = 0;
            var hi = p + ctx; if (hi > ops.length - 1) hi = ops.length - 1;
            for (var q = lo; q <= hi; q++) keep[q] = true;
        }
    }

    // Emit hunks with @@ headers.
    var out = [];
    p = 0;
    while (p < ops.length) {
        if (!keep[p]) { p++; continue; }
        var start = p;
        while (p < ops.length && keep[p]) p++;
        var end = p; // exclusive
        var oldStart = -1, newStart = -1, oldCount = 0, newCount = 0;
        var k, o;
        for (k = start; k < end; k++) {
            o = ops[k];
            if (o.type === 'same') {
                if (oldStart < 0) oldStart = o.oldIdx;
                if (newStart < 0) newStart = o.newIdx;
                oldCount++; newCount++;
            } else if (o.type === 'remove') {
                if (oldStart < 0) oldStart = o.oldIdx;
                oldCount++;
            } else {
                if (newStart < 0) newStart = o.newIdx;
                newCount++;
            }
        }
        if (oldStart < 0) oldStart = 0;
        if (newStart < 0) newStart = 0;
        out.push('@@ -' + (oldStart + 1) + ',' + oldCount + ' +' + (newStart + 1) + ',' + newCount + ' @@');
        for (k = start; k < end; k++) {
            o = ops[k];
            out.push((o.type === 'same' ? ' ' : (o.type === 'remove' ? '-' : '+')) + o.text);
        }
    }
    return out.join('\n');
}

async function wsDiff(repo, filePath, includeIgnored) {
    var meta = await getWorkspaceMeta(repo);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    // Sync with remote first — updates original_content for dirty files whose base changed
    var _syncErr = null;
    var _diffSync = null;
    try { _diffSync = await wsSyncWithRemote(repo); } catch(e) { _syncErr = e; }
    if (_diffSync && _diffSync.deleted) {
        return { success: true, deleted: true, message: 'Workspace auto-deleted — branch "' + _diffSync.branch + '" was merged into the locally-cloned base "' + _diffSync.base_branch + '".' };
    }

    var files = await getAllWorkspaceFiles(repo);
    var isIgnored = includeIgnored ? function() { return false; } : await wsGetIgnoreFilter(repo);
    var diffs = [];

    files.forEach(function(f) {
        if (!f.dirty) return;
        if (filePath && f.path !== filePath) return;
        if (isIgnored(f.path)) return;
        if (f.deleted) {
            diffs.push({ path: f.path, status: 'deleted' });
            return;
        }
        if (f.original_content === null) {
            // New file
            diffs.push({ path: f.path, status: 'new', lines: (f.content || '').split('\n').length });
        } else {
            // Modified file — proper LCS-based unified diff (3 lines of context).
            diffs.push({ path: f.path, status: 'modified', diff: wsLineDiff(f.original_content, f.content, 3) });
        }
    });

    var result = { success: true, diffs: diffs, total: diffs.length };
    if (_syncErr) result.sync_warning = 'Remote sync failed — diffs may be against stale base';
    return result;
}

// Compute git blob SHA locally: SHA-1("blob <byte_len>\0<content_bytes>")
async function computeGitBlobSha(content) {
    var encoder = new TextEncoder();
    var isBinary = content.indexOf('::binary::') === 0;
    var contentBytes;
    if (isBinary) {
        var b64 = content.substring('::binary::'.length);
        var binStr = atob(b64);
        contentBytes = new Uint8Array(binStr.length);
        for (var i = 0; i < binStr.length; i++) contentBytes[i] = binStr.charCodeAt(i);
    } else {
        contentBytes = encoder.encode(content);
    }
    var header = encoder.encode('blob ' + contentBytes.length + '\0');
    var combined = new Uint8Array(header.length + contentBytes.length);
    combined.set(header);
    combined.set(contentBytes, header.length);
    var hashBuffer = await crypto.subtle.digest('SHA-1', combined);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// Sync local workspace with remote — compare dirty files against remote tree.
// Returns { synced: number, behind: boolean, remoteHead: string, dirty_remaining: number }
// Auto-delete this workspace when its OWN branch is the head of a MERGED pull
// request whose base (target) branch is ALSO cloned locally. In that case the
// merged work is fully recoverable from the base-branch workspace, so the
// head-branch clone is redundant and we drop it automatically.
//
// Guards (all must hold):
//   - the branch has NO still-open PR                          → work isn't ongoing
//   - a merged PR exists with head == this branch
//   - that PR's base/target branch is cloned locally           → content recoverable
// Dirty (non-ignored) edits no longer block deletion outright: they are MOVED
// to the base workspace first (wsMove, no force). If that move is blocked by
// conflicts the workspace is KEPT and { kept:true, warning } is returned.
// After the move, the base workspace is synced (sync + pull) so it actually
// contains the merged changes, and the pin follows the merge: if the deleted
// workspace was pinned (or no pin exists for the repo) the base is pinned —
// a pin pointing elsewhere is never stolen, and the flip is skipped when the
// base sync failed (never pin a stale base — Reload would build pre-merge code).
// Returns { deleted:true, moved_dirty, pin_flipped, synced, ... } when it
// removes the workspace, { kept:true, warning } when the move blocked, else null.
//
// Re-entrancy guard: step 2 syncs the BASE workspace, whose own sync runs
// THIS check for the base — a pathological pair of branches each merged into
// the other (both cloned) would otherwise recurse forever.
var _wsAutoDelInProgress = {};
async function wsMaybeAutoDeleteMerged(wk, meta) {
    if (_wsAutoDelInProgress[wk]) return null;
    _wsAutoDelInProgress[wk] = true;
    try {
        if (!meta || !meta.branch) return null;

        // Dirty edits don't short-circuit anymore (they get moved to the base
        // below), but collect them up front for the move + result payload.
        var files = await getAllWorkspaceFiles(wk);
        var isIgnored = await wsGetIgnoreFilter(wk);
        var dirty = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });

        var githubRepo = meta.github_repo || parseWsKey(wk).repo;
        var branch = meta.branch;
        var ownerName = githubRepo.split('/')[0];

        // Cheap local guard: the base must be cloned locally, so unless at least
        // one OTHER workspace of the same repo exists there's nothing to fall back
        // to — skip the remote PR lookup entirely. Keeps the common single-clone
        // case at zero extra GitHub calls.
        var _allMetas = await getAllWorkspaceMetas();
        var _sameRepoOthers = (_allMetas || []).filter(function(m) {
            return m && m.repo !== wk && (m.github_repo || parseWsKey(m.repo).repo) === githubRepo;
        });
        if (_sameRepoOthers.length === 0) return null;

        // Find PRs whose HEAD is this workspace's branch.
        var listRes = await githubApi('GET', '/repos/' + githubRepo + '/pulls?state=all&head=' + encodeURIComponent(ownerName + ':' + branch));
        if (!listRes || !listRes.ok || !Array.isArray(listRes.body) || !listRes.body.length) return null;

        var mergedPr = null, hasOpen = false;
        for (var i = 0; i < listRes.body.length; i++) {
            var pr = listRes.body[i];
            if (!pr) continue;
            if (pr.state === 'open') { hasOpen = true; break; } // ongoing work — keep it
            if (pr.merged_at) {
                if (!mergedPr || new Date(pr.merged_at) > new Date(mergedPr.merged_at)) mergedPr = pr;
            }
        }
        if (hasOpen || !mergedPr) return null;

        var baseBranch = mergedPr.base && mergedPr.base.ref;
        if (!baseBranch || baseBranch === branch) return null;

        // The PR's target (base) branch must itself be cloned locally.
        var baseWk = null;
        for (var bi = 0; bi < _sameRepoOthers.length; bi++) {
            var bm = _sameRepoOthers[bi];
            if (bm && (bm.branch || parseWsKey(bm.repo).branch) === baseBranch) { baseWk = bm.repo; break; }
        }
        if (!baseWk) return null;

        // Never auto-delete the repo's default branch (your trunk) — guards the
        // unusual reverse PR (e.g. main → release merged with `release` cloned),
        // which would otherwise match the rule and drop your main workspace.
        var repoRes = await githubApi('GET', '/repos/' + githubRepo);
        if (repoRes && repoRes.ok && repoRes.body && repoRes.body.default_branch === branch) return null;

        // 1. Move any dirty edits onto the base workspace FIRST (no force).
        //    A blocked move keeps the workspace — deletion would lose work.
        var movedDirty = [];
        if (dirty.length > 0) {
            var moveRes = null;
            // Pass the ignore-filtered paths explicitly — a bare null would make
            // wsMove select ALL dirty rows including gitignored artefacts (e.g.
            // dist/ build output), which could spuriously block the whole move.
            try { moveRes = await wsMove(wk, baseWk, dirty.map(function(f) { return f.path; }), false, null, null); } catch (e) { moveRes = { success: false, error: e && e.message }; }
            if (!moveRes || !moveRes.success) {
                return {
                    deleted: false,
                    kept: true,
                    workspace: wk,
                    branch: branch,
                    base_branch: baseBranch,
                    pr_number: mergedPr.number,
                    conflicts: (moveRes && moveRes.conflicts) || [],
                    warning: 'Branch "' + branch + '" was merged (PR #' + mergedPr.number + ') but the workspace was KEPT: its dirty file(s) could not be moved to "' + baseWk + '"' + (moveRes && moveRes.conflicts && moveRes.conflicts.length ? ' (conflicting paths: ' + moveRes.conflicts.join(', ') + ')' : (moveRes && moveRes.error ? ' (' + moveRes.error + ')' : '')) + '. Resolve the conflicts, then re-sync.'
                };
            }
            movedDirty = moveRes.moved || [];
        }

        // 2. Sync the base workspace so it contains the merged changes BEFORE
        //    any pin flip (a pull fetches behind content when sync reports it).
        var baseSynced = false;
        try {
            var baseSync = await wsSyncWithRemote(baseWk);
            if (baseSync && !baseSync.branchGone && !baseSync.deleted) {
                if (baseSync.behind) {
                    var pullRes = await wsPull(baseWk);
                    baseSynced = !!(pullRes && pullRes.success && !(pullRes.conflicts && pullRes.conflicts.length) && !(pullRes.failed && pullRes.failed.length));
                } else {
                    baseSynced = true;
                }
            }
        } catch (e) {}

        // 3. Pin follows the merge — only when this workspace held the pin or
        //    no pin exists for the repo, and only onto a successfully-synced base.
        var wasPinned = !!meta.pinned;
        var anyPin = wasPinned || _sameRepoOthers.some(function(m) { return !!(m && m.pinned); });
        var pinFlipped = false;
        if ((wasPinned || !anyPin) && baseSynced) {
            try {
                var pinRes = await setWorkspacePin(baseWk, false);
                pinFlipped = !!(pinRes && pinRes.success);
            } catch (e) {}
        }

        // 4. Safe to remove the redundant head-branch workspace.
        await deleteWorkspaceFiles(wk);
        await deleteWorkspaceMeta(wk);
        try { gcWorkspaceBlobs(); } catch (e) {}
        try { refreshWorkspaceContext(); } catch (e) {}
        try { AgentEvents.emit('workspaceMutated', { action: 'auto_delete_merged', repo: wk, branch: branch, base: baseBranch, base_workspace: baseWk, pr: mergedPr.number, moved_dirty: movedDirty, pin_flipped: pinFlipped, synced: baseSynced }); } catch (e) {}
        var delResult = { deleted: true, workspace: wk, branch: branch, base_branch: baseBranch, base_workspace: baseWk, pr_number: mergedPr.number, pr_url: mergedPr.html_url, moved_dirty: movedDirty, pin_flipped: pinFlipped, synced: baseSynced };
        if (!baseSynced) delResult.sync_warning = 'The base workspace "' + baseWk + '" could not be fully synced with the remote — pull it before building (the pin was NOT flipped onto it).';
        return delResult;
    } catch (e) {
        return null;
    } finally {
        delete _wsAutoDelInProgress[wk];
    }
}

async function wsSyncWithRemote(wk) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return null;
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;

    // Auto-delete this workspace when its branch is the head of a MERGED PR whose
    // base (target) branch is also cloned locally — the merged work is recoverable
    // there, so the head-branch clone is redundant. Runs before the HEAD-compare
    // early return because a merged head branch's own tip does not move when the
    // PR lands on the base. Dirty edits are moved to the base workspace first
    // (a blocked move keeps the workspace and surfaces merge_warning). No-op
    // for open PRs / non-local base / default branch (see wsMaybeAutoDeleteMerged).
    var _autoDel = await wsMaybeAutoDeleteMerged(wk, meta);
    if (_autoDel && _autoDel.deleted) {
        return {
            synced: 0, behind: false, deleted: true, remoteHead: null, dirty_remaining: 0,
            workspace: wk, branch: _autoDel.branch, base_branch: _autoDel.base_branch,
            base_workspace: _autoDel.base_workspace || null,
            pr_number: _autoDel.pr_number, pr_url: _autoDel.pr_url,
            moved_dirty: _autoDel.moved_dirty || [], pin_flipped: !!_autoDel.pin_flipped,
            base_synced: !!_autoDel.synced, sync_warning: _autoDel.sync_warning || null
        };
    }
    // Merged PR but the workspace was KEPT (dirty files could not be moved to
    // the base) — surface the warning on whatever this sync returns.
    var _mergeWarning = (_autoDel && _autoDel.kept) ? _autoDel.warning : null;

    // 1. Get remote HEAD
    var refRes = await githubApi('GET', '/repos/' + githubRepo + '/git/ref/heads/' + encodeURIComponent(meta.branch));
    if (!refRes.ok) {
        // 404 = the cloned branch no longer EXISTS on the remote (deleted after its
        // PR merged, etc.) — a permanent state, not a transient API failure. Return
        // a distinct shape so callers (wsPush) can tell it apart from null and
        // still allow useful work (cutting a NEW branch) instead of retry-looping.
        if (refRes.status === 404) return { branchGone: true, branch: meta.branch, merge_warning: _mergeWarning || undefined };
        return null;
    }
    var remoteHead = refRes.body.object.sha;

    // If local HEAD matches remote, no sync needed
    if (remoteHead === meta.head_sha) {
        var _upToDate = { synced: 0, behind: false, remoteHead: remoteHead, dirty_remaining: -1 };
        if (_mergeWarning) _upToDate.merge_warning = _mergeWarning;
        return _upToDate;
    }

    // 2. Get remote tree (SHA-only metadata, not file contents)
    var treeRes = await githubApi('GET', '/repos/' + githubRepo + '/git/trees/' + remoteHead + '?recursive=1');
    if (!treeRes.ok) return { synced: 0, behind: true, remoteHead: remoteHead, dirty_remaining: -1 };
    // FAIL CLOSED on a truncated recursive tree (GitHub caps at ~100k entries /
    // 7MB): the partial treeRes.body.tree would silently OMIT upstream-changed
    // paths, so the step-4 conflict/behind detection below would miss them and
    // wsPush could full-file-replace an upstream change with no prompt (data
    // loss). Mirror wsClone (refuses) / wsPush (skips its re-check when
    // truncated): return the SAME behind:true / no-conflictFiles shape the
    // !treeRes.ok guard uses so wsPush's existing
    // `behind && !Array.isArray(conflictFiles)` guard aborts the push.
    if (treeRes.body && treeRes.body.truncated) return { synced: 0, behind: true, remoteHead: remoteHead, dirty_remaining: -1, treeTruncated: true };

    // Build remote tree lookup: path → sha (+ sizes for stub repointing)
    var remoteTree = {};
    var remoteSizes = {};
    treeRes.body.tree.forEach(function(e) { if (e.type === 'blob') { remoteTree[e.path] = e.sha; remoteSizes[e.path] = e.size != null ? e.size : null; } });

    // 3. For each dirty file, compute local blob SHA and compare with remote
    var files = await getAllWorkspaceFiles(wk);
    var isIgnored = await wsGetIgnoreFilter(wk);
    var synced = 0;

    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!f.dirty || isIgnored(f.path)) continue;

        if (f.deleted) {
            // Deleted locally — if also gone from remote, sync it
            if (!remoteTree[f.path]) {
                try {
                    var _db = await openDatabase();
                    var _tx = _db.transaction([workspaceFilesStoreName], 'readwrite');
                    _tx.objectStore(workspaceFilesStoreName).delete(f.id);
                    await new Promise(function(resolve, reject) {
                        _tx.oncomplete = resolve;
                        _tx.onerror = function() { reject(_tx.error); };
                    });
                    unregisterFile(f.file_id);
                } catch (e) {}
                synced++;
            }
            continue;
        }

        // For new or modified files, compute local SHA and compare with remote
        if (f.content == null) continue; // stub safety — dirty files are always hydrated
        var localSha = await computeGitBlobSha(f.content);
        if (remoteTree[f.path] && remoteTree[f.path] === localSha) {
            // File content matches remote — mark as clean, update original_content and sha,
            // and clear cross-chat ownership (no longer dirty, so no claim).
            f.original_content = f.content;
            f.sha = localSha;
            f.dirty = false;
            f.pushed_pr = null;
            f.pushed_shas = null;
            f.last_modified_by_chat_id = null;
            f.last_modified_by_chat_title = null;
            f.last_modified_at = null;
            await setWorkspaceFile(f);
            synced++;
        }
    }

    // 4. Detect behind files (remote changed, local clean) and conflicts (both changed)
    var behindFiles = [];
    var conflictFiles = [];
    for (var j = 0; j < files.length; j++) {
        var cf = files[j];
        if (isIgnored(cf.path)) continue;
        if (cf.dirty && cf.deleted) {
            // Deleted locally — if remote also changed, that's a conflict (unless we pushed the delete)
            if (remoteTree[cf.path] && cf.sha && remoteTree[cf.path] !== cf.sha) {
                var _pushedDelete = cf.pushed_shas && cf.pushed_shas.indexOf('::deleted::') !== -1;
                conflictFiles.push({ path: cf.path, remoteSha: remoteTree[cf.path], localDeleted: true, deletePushed: !!_pushedDelete });
            }
        } else if (cf.dirty && !cf.deleted) {
            // Dirty file — check if remote base also changed
            var _remoteSha = remoteTree[cf.path];
            if (_remoteSha && (!cf.sha || _remoteSha !== cf.sha)) {
                // Check if this remote sha matches one of our pushed shas (our PR was merged)
                var _isOurWork = cf.pushed_shas && cf.pushed_shas.indexOf(_remoteSha) !== -1;
                if (_isOurWork) {
                    // Our PR was merged — safe to update base pointer.
                    // Fetch remote content so original_content reflects the new base.
                    try {
                        var _blobRes = await githubApi('GET', '/repos/' + githubRepo + '/git/blobs/' + _remoteSha);
                        if (_blobRes.ok && _blobRes.body.content) {
                            var _remoteContent = _wsDecodeBlobBody(_blobRes.body);
                            cf.original_content = _remoteContent;
                            cf.sha = _remoteSha;
                            // Remove matched sha and all older ones (they're subsets of the matched content).
                            // Only keep shas pushed AFTER the match — those have newer content.
                            var _idx = cf.pushed_shas.indexOf(_remoteSha);
                            if (_idx !== -1) cf.pushed_shas = cf.pushed_shas.slice(_idx + 1);
                            if (!cf.pushed_shas.length) { cf.pushed_shas = null; cf.pushed_pr = null; }
                            await setWorkspaceFile(cf);
                            synced++;
                        } else {
                            conflictFiles.push({ path: cf.path, remoteSha: _remoteSha });
                        }
                    } catch(_e) {
                        conflictFiles.push({ path: cf.path, remoteSha: _remoteSha });
                    }
                } else {
                    // Someone else changed the file — real conflict
                    conflictFiles.push({ path: cf.path, remoteSha: _remoteSha });
                }
            }
        } else if (!cf.dirty && !cf.deleted) {
            // Clean file — check if remote changed (behind)
            if (remoteTree[cf.path] && remoteTree[cf.path] !== cf.sha) {
                if (cf.stub && cf.content == null) {
                    // Lazy stub: no local content to merge, but do NOT repoint in
                    // place — that would mix two commits in one workspace (stubs
                    // at the new head, hydrated files still at the old one).
                    // wsPull performs the repoint alongside the content pulls.
                    behindFiles.push({ path: cf.path, remoteSha: remoteTree[cf.path], stubRepoint: true, remoteSize: remoteSizes[cf.path] });
                } else {
                    behindFiles.push({ path: cf.path, remoteSha: remoteTree[cf.path] });
                }
            }
            if (!remoteTree[cf.path]) {
                behindFiles.push({ path: cf.path, remoteSha: null, remoteDeleted: true });
            }
        }
    }
    // New files on remote we don't have locally
    var localPaths = {};
    files.forEach(function(f) { localPaths[f.path] = true; });
    for (var rp in remoteTree) {
        if (!localPaths[rp]) {
            behindFiles.push({ path: rp, remoteSha: remoteTree[rp], isNew: true });
        }
    }

    var behind = behindFiles.length > 0 || conflictFiles.length > 0;

    // Late re-check: a CONCURRENT operation (e.g. a sibling fork's merge auto-
    // delete pulling this base workspace, or a parallel UI sync) may have
    // deleted this workspace or advanced its head while we were computing.
    // Without this, a racing sync repaints a stale "behind" the pull already
    // fixed, or resurrects meta/rows of a just-deleted workspace.
    var _metaNow = await getWorkspaceMeta(wk);
    if (!_metaNow) {
        // Workspace removed mid-sync — clean any rows our step-3 writes may
        // have resurrected and report as gone.
        try { await deleteWorkspaceFiles(wk); } catch (e) {}
        return null;
    }
    if (behind && _metaNow.head_sha === remoteHead) {
        // Already pulled to the remote head concurrently — our behind/conflict
        // lists were computed from a stale snapshot.
        behind = false; behindFiles = []; conflictFiles = [];
    }
    meta = _metaNow;

    // Only advance HEAD if fully in sync
    if (!behind) {
        meta.head_sha = remoteHead;
        meta.tree_sha = treeRes.body.sha;
        await setWorkspaceMeta(meta);
    }

    // Count remaining dirty files
    var remaining = (await getAllWorkspaceFiles(wk)).filter(function(f) { return f.dirty && !isIgnored(f.path); }).length;

    var _syncRet = { synced: synced, behind: behind, remoteHead: remoteHead, dirty_remaining: remaining, behindFiles: behindFiles, conflictFiles: conflictFiles, _remoteTree: remoteTree, _treeSha: treeRes.body.sha };
    if (_mergeWarning) _syncRet.merge_warning = _mergeWarning;
    return _syncRet;
}

// Pull remote changes for behind files (download new content from remote)
async function wsPull(wk) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned' };
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;

    // Re-sync to get fresh behind files list
    var syncResult = await wsSyncWithRemote(wk);
    if (syncResult && syncResult.deleted) {
        return { success: true, deleted: true, pulled: 0, message: 'Workspace auto-deleted — branch "' + syncResult.branch + '" was merged into the locally-cloned base "' + syncResult.base_branch + '".' };
    }
    if (!syncResult || !syncResult.behindFiles || syncResult.behindFiles.length === 0) {
        return { success: true, message: 'Already up to date', pulled: 0 };
    }

    var pulled = 0;
    var failedPulls = [];
    var BATCH_SIZE = 15;
    var behindFiles = syncResult.behindFiles;

    for (var i = 0; i < behindFiles.length; i += BATCH_SIZE) {
        var batch = behindFiles.slice(i, i + BATCH_SIZE);
        var results = await Promise.all(batch.map(function(bf) {
            if (bf.remoteDeleted) return Promise.resolve({ bf: bf, ok: true, deleted: true });
            if (bf.stubRepoint) return Promise.resolve({ bf: bf, ok: true, stubRepoint: true });
            return githubApi('GET', '/repos/' + githubRepo + '/git/blobs/' + bf.remoteSha)
                .then(function(res) { return { bf: bf, ok: res.ok, body: res.body }; });
        }));

        for (var j = 0; j < results.length; j++) {
            var r = results[j];
            if (r.deleted) {
                // Remote deleted this file — delete locally
                var delFile = await getWorkspaceFile(wk, r.bf.path);
                if (delFile) {
                    try {
                        var _db = await openDatabase();
                        var _tx = _db.transaction([workspaceFilesStoreName], 'readwrite');
                        _tx.objectStore(workspaceFilesStoreName).delete(delFile.id);
                        await new Promise(function(resolve, reject) {
                            _tx.oncomplete = resolve;
                            _tx.onerror = function() { reject(_tx.error); };
                        });
                        unregisterFile(delFile.file_id);
                    } catch (e) {}
                }
                pulled++;
                continue;
            }
            if (r.stubRepoint) {
                // Never-hydrated lazy stub — repoint sha/size and stay a stub;
                // content is fetched on demand at the new sha.
                var _stubFile = await getWorkspaceFile(wk, r.bf.path);
                if (_stubFile && _stubFile.stub && _stubFile.content == null) {
                    _stubFile.sha = r.bf.remoteSha;
                    if (r.bf.remoteSize != null) _stubFile.size = r.bf.remoteSize;
                    await setWorkspaceFile(_stubFile);
                    pulled++;
                } else {
                    // Hydrated (or mutated) between sync and pull — its content is
                    // at the old sha. Don't repoint and don't advance HEAD; the
                    // next sync/pull cycle fetches it as a regular behind file.
                    failedPulls.push(r.bf.path);
                }
                continue;
            }
            if (!r.ok) { failedPulls.push(r.bf.path); continue; }
            var content = _wsDecodeBlobBody(r.body);

            if (r.bf.isNew) {
                // New file from remote — no local owner
                var _existingPull = await getWorkspaceFile(wk, r.bf.path);
                var _pullFileId = (_existingPull && _existingPull.file_id) || newFileId();
                await setWorkspaceFile({
                    id: wk + '::' + r.bf.path,
                    repo: wk,
                    path: r.bf.path,
                    sha: r.bf.remoteSha,
                    content: content,
                    original_content: content,
                    dirty: false,
                    file_id: _pullFileId,
                    pushed_pr: null,
                    pushed_shas: null,
                    last_modified_by_chat_id: null,
                    last_modified_by_chat_title: null,
                    last_modified_at: null
                });
                registerFile(_pullFileId, { type: 'workspace', workspace: wk, path: r.bf.path });
            } else {
                // Updated file — replace local copy with remote, drop any chat-id stamp
                var existing = await getWorkspaceFile(wk, r.bf.path);
                if (existing) {
                    existing.content = content;
                    existing.original_content = content;
                    existing.stub = false; // pulled content — no longer a lazy stub
                    existing.sha = r.bf.remoteSha;
                    existing.dirty = false;
                    existing.pushed_pr = null;
                    existing.pushed_shas = null;
                    existing.last_modified_by_chat_id = null;
                    existing.last_modified_by_chat_title = null;
                    existing.last_modified_at = null;
                    await setWorkspaceFile(existing);
                }
            }
            pulled++;
        }
    }

    // Only advance HEAD if no conflicts and no failed downloads remain
    var conflicts = syncResult.conflictFiles || [];
    if (conflicts.length === 0 && failedPulls.length === 0) {
        meta = await getWorkspaceMeta(wk);
        meta.head_sha = syncResult.remoteHead;
        meta.tree_sha = syncResult._treeSha;
        await setWorkspaceMeta(meta);
    }

    refreshWorkspaceContext();
    var result = { success: true, message: 'Pulled ' + pulled + ' file(s) from remote', pulled: pulled };
    if (conflicts.length > 0) result.conflicts = conflicts;
    if (failedPulls.length > 0) result.failed = failedPulls;
    return result;
}

async function wsPush(wk, args) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };
    // A local fork (created via the `branch` action) defaults branch_name to
    // its own branch — the remote ref is created lazily below on first push.
    if (!args.branch_name && meta.forked_from) args.branch_name = meta.branch;
    if (!args.branch_name) return { success: false, error: 'branch_name is required' };
    if (!args.commit_message) return { success: false, error: 'commit_message is required' };
    // pr_title is validated LATER (after we resolve whether an OPEN PR already
    // exists for this branch). It is REQUIRED only when this push will OPEN A NEW
    // PR; when appending to an existing open PR we keep that PR's current title,
    // so pr_title is optional there. See the deferred gate after openPrForBranch.
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;
    var gh = await loadGitHubSettings();
    if (!gh.token) return { success: false, error: 'GitHub not connected' };

    // Sync with remote first — advance HEAD if PRs were merged
    var syncResult = await wsSyncWithRemote(wk);
    if (syncResult && syncResult.conflictFiles && syncResult.conflictFiles.length > 0) {
        return { success: false, error: 'Cannot push — ' + syncResult.conflictFiles.length + ' file(s) have conflicting remote changes. Pull or discard first.', conflict_files: syncResult.conflictFiles };
    }
    // FAIL CLOSED: pushing is only safe when conflict detection actually RAN.
    // wsSyncWithRemote returns null when the remote ref fetch failed, and a
    // behind:true result WITHOUT a conflictFiles array when the remote tree
    // fetch failed (line ~2766) — in both cases nothing was compared, so a
    // push could silently clobber upstream changes. Abort instead.
    if (!syncResult) {
        return { success: false, error: 'Could not sync with remote (GitHub API error while resolving the remote head) — aborting push because conflict detection did not run. Retry shortly.' };
    }
    if (syncResult.deleted) {
        return { success: false, error: 'This workspace was auto-deleted during sync (its branch was merged into a locally-cloned base). Re-clone before pushing.' };
    }
    // A local fork's branch does not exist on the remote until its FIRST push
    // — branchGone is the EXPECTED state there, not an error. The ref is
    // created below from the fork's base branch (meta.base_branch), exactly
    // like any other new branch_name: cut from the current base head.
    var _lazyFork = !!(syncResult.branchGone && meta.forked_from && meta.base_branch);
    // The cloned branch was DELETED on the remote (permanent — "retry shortly"
    // would be wrong). Conflict detection vs a deleted branch is meaningless, so
    // a push that cuts a NEW branch with an explicit different base_branch may
    // proceed as if there were no conflicts. Blocked: pushing the dead branch
    // itself, and any push whose PR base would DEFAULT to the dead branch.
    if (syncResult.branchGone && !_lazyFork) {
        if (args.branch_name === meta.branch) {
            return { success: false, error: 'The cloned branch "' + meta.branch + '" no longer exists on the remote (deleted after its PR merged?). Re-clone the repo, or push to a NEW branch_name.' };
        }
        // Without an explicit override the PR base DEFAULTS to the dead cloned
        // branch (meta.source_branch is never assigned), so the push is doomed
        // to fail LATE: the branch ref gets created, then PR creation 422s on
        // the missing base — leaving an orphan remote branch and a branch_name
        // that wedges on retry. Abort before any remote mutation instead. An
        // explicit different base_branch proceeds (it also unblocks appending
        // to an existing PR branch, whose base comes from the PR itself).
        if (!(args.base_branch && args.base_branch !== meta.branch)) {
            return { success: false, error: 'The cloned base branch "' + meta.branch + '" no longer exists on the remote, so it cannot be the PR base. Re-clone the workspace, or pass an explicit base_branch.' };
        }
    }
    if (syncResult.behind && !Array.isArray(syncResult.conflictFiles)) {
        return { success: false, error: 'Could not fetch the remote tree to check for conflicts (GitHub API error) — aborting push because conflict detection did not run. Retry shortly.' };
    }
    // Re-read meta after sync (head_sha may have advanced)
    meta = await getWorkspaceMeta(wk);

    // Base is always the source/cloned branch unless explicitly overridden.
    // A local fork's base is the branch it was forked FROM (meta.base_branch)
    // — its own branch may not exist on the remote yet.
    var baseBranch = args.base_branch || meta.source_branch || meta.base_branch || meta.branch;
    // Pushing to a branch_name equal to the base is ONLY valid as an APPEND to an
    // already-open PR whose head IS that branch — i.e. the common "I cloned a PR's
    // branch and want to add another commit to that same PR" case. In that case we
    // never open a new PR (head===base would 422 on GitHub); we just fast-forward
    // the branch so its open PR picks up the new commit. Confirm such a PR exists
    // BEFORE mutating anything — otherwise the fast-forward below would push a
    // commit straight onto the base branch (e.g. main) with no PR. When no open PR
    // exists this really is an invalid self-PR, so error out (the original guard).
    var branchIsBase = (args.branch_name === baseBranch);
    if (branchIsBase) {
        var _ownerForCheck = githubRepo.split('/')[0];
        var _openPrCheck = await githubApi('GET', '/repos/' + githubRepo + '/pulls?state=open&head=' + encodeURIComponent(_ownerForCheck + ':' + args.branch_name));
        var _hasOpenPrForBranch = !!(_openPrCheck && _openPrCheck.ok && Array.isArray(_openPrCheck.body) && _openPrCheck.body.length > 0);
        if (!_hasOpenPrForBranch) {
            return { success: false, error: 'branch_name "' + args.branch_name + '" is the same as the base branch "' + baseBranch + '" and has no open PR to append to. To open a NEW PR, choose a different branch_name (a PR cannot be opened from a branch onto itself).' };
        }
        // An open PR exists for this branch → valid append. Fall through: the
        // branch-exists / PR-reuse logic below fast-forwards it and reuses the PR.
        // (Verified end-to-end: clone a PR's branch, edit, push the same branch_name.)
    }

    var files = await getAllWorkspaceFiles(wk);
    var isIgnored = await wsGetIgnoreFilter(wk);
    var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
    if (dirtyFiles.length === 0) return { success: false, error: 'No modified files to push (all files match remote after sync)' };

    // Optional scoped push: args.files limits the commit to an explicit list of
    // paths. Unlisted dirty files stay dirty locally and are NOT committed, so
    // unrelated work (e.g. from another chat) doesn't leak into the PR.
    var _filesSkipped = 0;
    if (Array.isArray(args.files) && args.files.length) {
        var _requested = {};
        args.files.forEach(function(p) { _requested[String(p).replace(/^\/+/, '')] = true; });
        var _matched = dirtyFiles.filter(function(f) { return _requested[f.path]; });
        var _matchedPaths = {};
        _matched.forEach(function(f) { _matchedPaths[f.path] = true; });
        var _missing = Object.keys(_requested).filter(function(p) { return !_matchedPaths[p]; });
        if (_missing.length) {
            return { success: false, error: 'Some requested files are not modified (or not in the workspace): ' + _missing.join(', ') + '. Use workspace status to list dirty files; only dirty files can be pushed.' };
        }
        _filesSkipped = dirtyFiles.length - _matched.length;
        dirtyFiles = _matched;
    }

    // Separate modified/new files from deleted files
    var modifiedFiles = dirtyFiles.filter(function(f) { return !f.deleted; });
    var deletedFiles = dirtyFiles.filter(function(f) { return !!f.deleted; });

    // 0. Resolve the push target BEFORE building the tree. The local clone's
    //    head_sha/tree_sha are frozen at clone/last-sync time, so two stale cases
    //    must be handled here:
    //    - A leftover branch from an already-MERGED (or closed) PR must NOT be
    //      appended to: its old commits would drag every previously-merged file
    //      into the next PR's diff. Only a branch with an OPEN PR is an append
    //      target; otherwise the branch is recreated from the current base head.
    //    - A new (or recreated) branch must be cut from the CURRENT remote head
    //      of the base branch, not the stale clone snapshot, so the PR diff
    //      contains ONLY the files pushed here.
    var ownerName = githubRepo.split('/')[0];
    var existingRef = await githubApi('GET', '/repos/' + githubRepo + '/git/ref/heads/' + encodeURIComponent(args.branch_name));
    var branchExists = !!(existingRef && existingRef.ok && existingRef.body && existingRef.body.object && existingRef.body.object.sha);
    var staleBranchRecreated = false;
    var openPrForBranch = null;
    if (branchExists) {
        var prOpenRes = await githubApi('GET', '/repos/' + githubRepo + '/pulls?state=open&head=' + encodeURIComponent(ownerName + ':' + args.branch_name));
        // FAIL CLOSED: a failed query is NOT the same as "no open PR". githubApi
        // never throws — on network/rate-limit failure it returns ok:false (or
        // just {error}). Treating that as "no open PR" would force-reset a
        // branch that may have a live open PR, dropping its prior commits from
        // the PR (and in the branchIsBase case could even rewind the base
        // branch). Abort before mutating anything.
        if (!(prOpenRes && prOpenRes.ok && Array.isArray(prOpenRes.body))) {
            return { success: false, error: 'Could not verify open PRs for branch "' + args.branch_name + '" (GitHub API error: ' + JSON.stringify((prOpenRes && (prOpenRes.body || prOpenRes.error)) || 'no response') + '). Aborting to avoid resetting a branch that may have an open PR. Retry shortly.' };
        }
        if (prOpenRes.body.length > 0) {
            openPrForBranch = prOpenRes.body[0];
        }
        // No open PR for this branch (its PR was merged or closed, or it never
        // had one) → treat as a fresh push: reset the branch onto the current
        // base head below.
        if (!openPrForBranch) {
            // Belt-and-braces: when branch_name === baseBranch the guard at the
            // top of wsPush verified an open PR exists — if it vanished between
            // the two queries (closed/merged in the window), abort rather than
            // ever force-resetting the base branch itself.
            if (branchIsBase) {
                return { success: false, error: 'The open PR for base-branch "' + args.branch_name + '" disappeared mid-push (merged or closed concurrently). Aborting: a base branch is never force-reset. Re-sync and retry.' };
            }
            staleBranchRecreated = true;
        }
    }

    // pr_title gate (deferred from the top of wsPush): if an OPEN PR already
    // exists for this branch we will APPEND to it and keep its current title, so
    // pr_title is optional. In every other case this push opens a new PR (or
    // reopens a closed one), which needs a title — require it now, BEFORE any
    // remote mutation, so a missing title never leaves an orphan branch/commit.
    if (!openPrForBranch && !args.pr_title) {
        return { success: false, error: 'pr_title is required (no open PR exists for branch "' + args.branch_name + '" to append to)' };
    }

    // Base for NEW branches (including recreated stale ones): the CURRENT remote
    // head of the base branch. NOTE: workspace file contents are still from the
    // (possibly stale) clone — a pushed file fully replaces the upstream version
    // (the existing full-file-replace semantic, kept on purpose). Conflicts are
    // caught twice: wsSyncWithRemote above (vs the cloned branch head) and the
    // baseAdvanced re-check below (vs the freshly resolved base head).
    var baseCommitSha = meta.head_sha;
    var baseTreeSha = meta.tree_sha;
    var baseAdvanced = false;
    var _baseOverrideWarning = null;
    if (!branchExists || staleBranchRecreated) {
        var baseRefRes = await githubApi('GET', '/repos/' + githubRepo + '/git/ref/heads/' + encodeURIComponent(baseBranch));
        var _baseRefOk = !!(baseRefRes && baseRefRes.ok && baseRefRes.body && baseRefRes.body.object && baseRefRes.body.object.sha);
        // The base branch does not EXIST on the remote (404 — deleted cloned
        // branch, or a bad explicit base_branch). A PERMANENT state, not a
        // transient API failure: falling back to the stale snapshot would
        // create the branch ref and then 422 on PR creation (invalid base),
        // leaving an orphan remote branch. Abort BEFORE any mutation — for
        // brand-new and recreated branches alike. Transient failures (no
        // status / non-404) keep the per-case handling below.
        if (!_baseRefOk && baseRefRes && baseRefRes.status === 404) {
            return { success: false, error: 'Base branch "' + baseBranch + '" does not exist on the remote' + (baseBranch === meta.branch ? ' (the cloned branch was deleted — after its PR merged?). Re-clone the workspace, or pass an explicit existing base_branch.' : '. Pass an existing base_branch.') };
        }
        // FAIL CLOSED for force-resets: recreating a stale branch on a base head
        // we could not resolve would force-push a commit built on the stale
        // clone snapshot — silently rewinding the branch. Only a brand-new
        // branch may fall back to the clone snapshot (old behavior, harmless:
        // the PR diff is computed against the merge-base either way).
        if (!_baseRefOk && staleBranchRecreated) {
            return { success: false, error: 'Could not resolve the current head of base branch "' + baseBranch + '" (GitHub API error) — aborting instead of force-resetting branch "' + args.branch_name + '" onto a stale snapshot. Retry shortly.' };
        }
        if (_baseRefOk && baseRefRes.body.object.sha !== meta.head_sha) {
            var _currentBaseSha = baseRefRes.body.object.sha;
            var baseCommitRes = await githubApi('GET', '/repos/' + githubRepo + '/git/commits/' + _currentBaseSha);
            if (baseCommitRes && baseCommitRes.ok && baseCommitRes.body && baseCommitRes.body.tree && baseCommitRes.body.tree.sha) {
                baseCommitSha = _currentBaseSha;
                baseTreeSha = baseCommitRes.body.tree.sha;
                baseAdvanced = true;
            } else if (staleBranchRecreated) {
                return { success: false, error: 'Could not resolve the tree of the current "' + baseBranch + '" head (GitHub API error) — aborting instead of force-resetting branch "' + args.branch_name + '" onto a stale snapshot. Retry shortly.' };
            }
            // New-branch-only fallback to the clone snapshot (old behavior).
        }
    } else {
        // APPEND path: base the new tree on the branch TIP's tree, not the clone
        // snapshot. With the snapshot, a scoped second push (args.files) — or any
        // append where a previously-pushed file is no longer dirty — built a tree
        // that silently REVERTED the earlier pushed files to base content at the
        // branch tip, removing them from the PR. The tip tree preserves them;
        // files pushed now still fully replace their tip versions.
        var _tipCommitRes = await githubApi('GET', '/repos/' + githubRepo + '/git/commits/' + existingRef.body.object.sha);
        if (!(_tipCommitRes && _tipCommitRes.ok && _tipCommitRes.body && _tipCommitRes.body.tree && _tipCommitRes.body.tree.sha)) {
            return { success: false, error: 'Could not resolve the tip tree of branch "' + args.branch_name + '" (GitHub API error) — aborting append. Retry shortly.' };
        }
        baseTreeSha = _tipCommitRes.body.tree.sha;
        // A file deleted+pushed in an EARLIER append stays dirty locally, but the
        // tip tree (now our base_tree) no longer contains its path — GitHub 422s a
        // sha:null entry for a path absent from base_tree, failing the whole push.
        // Drop delete entries already absent at the tip (the deletion is already
        // on the branch). Best-effort: if the tip tree can't be fetched or is
        // truncated, keep all entries (old behavior — the 422 is the rarer case).
        if (deletedFiles.length > 0) {
            var _tipTreeRes = await githubApi('GET', '/repos/' + githubRepo + '/git/trees/' + baseTreeSha + '?recursive=1');
            if (_tipTreeRes && _tipTreeRes.ok && _tipTreeRes.body && Array.isArray(_tipTreeRes.body.tree) && !_tipTreeRes.body.truncated) {
                var _tipPaths = {};
                _tipTreeRes.body.tree.forEach(function(e) { if (e.type === 'blob') _tipPaths[e.path] = true; });
                deletedFiles = deletedFiles.filter(function(f) { return !!_tipPaths[f.path]; });
                if (modifiedFiles.length === 0 && deletedFiles.length === 0) {
                    return { success: false, error: 'Nothing to commit — the only selected changes are deletions already present on the tip of branch "' + args.branch_name + '".' };
                }
                // Rebuild the commit set so post-push bookkeeping (pushed_pr/
                // pushed_shas stamping, ownership release, files_pushed and the
                // success message) covers ONLY entries actually in this commit.
                // Dropped deletes stay dirty ON PURPOSE: their deletion lives on
                // the PUSH branch tip, not on the CLONED branch — wsSyncWithRemote
                // clears the local delete record only once the cloned branch's
                // remote tree loses the path (i.e. the PR merges). Deleting the
                // record here would silently forget the deletion if the PR never
                // merges. Their earlier push already stamped pushed_pr/'::deleted::'
                // and released ownership, so skipping the stamp loop loses nothing.
                dirtyFiles = modifiedFiles.concat(deletedFiles);
            }
        }
    }

    // RE-CHECK conflicts against the freshly resolved base head when it differs
    // from what wsSyncWithRemote compared against (base advanced since clone-sync,
    // or args.base_branch targets a branch sync never looked at). Without this,
    // a dirty file changed upstream on the NEW base head would be full-file
    // replaced with stale local content, silently discarding the upstream change.
    if (baseAdvanced) {
        var _freshTreeRes = await githubApi('GET', '/repos/' + githubRepo + '/git/trees/' + baseTreeSha + '?recursive=1');
        if (!(_freshTreeRes && _freshTreeRes.ok && _freshTreeRes.body && Array.isArray(_freshTreeRes.body.tree))) {
            return { success: false, error: 'Could not fetch the current "' + baseBranch + '" tree to check for conflicts (GitHub API error) — aborting push. Retry shortly.' };
        }
        if (!_freshTreeRes.body.truncated) {
            var _freshTree = {};
            _freshTreeRes.body.tree.forEach(function(e) { if (e.type === 'blob') _freshTree[e.path] = e.sha; });
            var _newConflicts = [];
            dirtyFiles.forEach(function(f) {
                var _rs = _freshTree[f.path];
                // Mirrors wsSyncWithRemote step 4: remote has the file with a sha
                // that is neither our clone-time base nor something we pushed.
                if (_rs && (!f.sha || _rs !== f.sha) && (!f.pushed_shas || f.pushed_shas.indexOf(_rs) === -1)) {
                    _newConflicts.push(f.path);
                }
            });
            if (_newConflicts.length > 0) {
                // An EXPLICIT args.base_branch override ALWAYS trips baseAdvanced
                // (another branch's head never equals the cloned branch's head_sha)
                // and f.sha values are clone-branch base shas — a mismatch vs the
                // override base usually means the branches legitimately differ, not
                // that someone edited our files upstream. Full-file replace onto the
                // chosen base is exactly what such a push asks for: WARN instead of
                // aborting. The hard abort stays for a genuinely advanced cloned base.
                if (args.base_branch && args.base_branch !== meta.branch) {
                    _baseOverrideWarning = _newConflicts.length + ' file(s) differ between the cloned branch and base "' + baseBranch + '" and are fully replaced by this push: ' + _newConflicts.join(', ');
                } else {
                    return { success: false, error: 'Cannot push — ' + _newConflicts.length + ' file(s) changed upstream on "' + baseBranch + '" since the workspace was synced: ' + _newConflicts.join(', ') + '. Pull or discard first.', conflict_files: _newConflicts };
                }
            }
        }
        // (truncated recursive tree: repo too large for the check — proceed as before)
    }

    // 1. Create blobs for modified files (skip deleted)
    var blobShas = {};
    for (var i = 0; i < modifiedFiles.length; i++) {
        var f = modifiedFiles[i];
        if (f.content == null) {
            // Should be impossible (dirty files are always hydrated) — fail loudly
            // rather than silently pushing an empty blob over real remote content.
            return { success: false, error: 'Internal: dirty file has no content (un-hydrated stub): ' + f.path + '. Read or discard the file, then retry the push.' };
        }
        var isBinary = f.content.indexOf('::binary::') === 0;
        var blobContent = isBinary ? f.content.substring('::binary::'.length) : btoa(unescape(encodeURIComponent(f.content)));
        var blobRes = await githubApi('POST', '/repos/' + githubRepo + '/git/blobs', { content: blobContent, encoding: 'base64' });
        if (!blobRes.ok) return { success: false, error: 'Failed to create blob for ' + f.path + ': ' + JSON.stringify(blobRes.body) };
        blobShas[f.path] = blobRes.body.sha;
    }

    // 2. Create tree (modified files get new blobs, deleted files get sha:null to remove)
    var treeEntries = modifiedFiles.map(function(f) {
        return { path: f.path, mode: '100644', type: 'blob', sha: blobShas[f.path] };
    });
    deletedFiles.forEach(function(f) {
        treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
    });
    var treeRes = await githubApi('POST', '/repos/' + githubRepo + '/git/trees', { base_tree: baseTreeSha, tree: treeEntries });
    if (!treeRes.ok) return { success: false, error: 'Failed to create tree: ' + JSON.stringify(treeRes.body) };

    // 3. Determine the parent commit. Append on the branch tip ONLY when the
    //    branch still has an open PR (a previous push to the same PR). For a
    //    brand-new branch — or a stale branch being recreated because its PR
    //    was merged/closed — build on the current base head resolved above.
    var parentSha = (branchExists && !staleBranchRecreated) ? existingRef.body.object.sha : baseCommitSha;

    // Create commit on top of the chosen parent
    var commitRes = await githubApi('POST', '/repos/' + githubRepo + '/git/commits', {
        message: args.commit_message,
        tree: treeRes.body.sha,
        parents: [parentSha]
    });
    if (!commitRes.ok) return { success: false, error: 'Failed to create commit: ' + JSON.stringify(commitRes.body) };

    // 4. Create the branch ref (new branch) or fast-forward it (existing PR branch).
    //    force:false so a concurrent push to the same branch is NOT clobbered —
    //    GitHub rejects a non-fast-forward update and we ask the user to sync.
    if (branchExists && !staleBranchRecreated) {
        var updRes = await githubApi('PATCH', '/repos/' + githubRepo + '/git/refs/heads/' + encodeURIComponent(args.branch_name), {
            sha: commitRes.body.sha,
            force: false
        });
        if (!updRes.ok) {
            var _ffMsg = (updRes && updRes.body && /fast.?forward/i.test(JSON.stringify(updRes.body)))
                ? 'Branch "' + args.branch_name + '" moved on the remote since this workspace last synced (a concurrent push?). Pull/sync the branch and push again.'
                : 'Failed to update branch "' + args.branch_name + '": ' + JSON.stringify(updRes.body);
            return { success: false, error: _ffMsg };
        }
    } else if (staleBranchRecreated) {
        // The branch exists but its PR was merged/closed — reset it onto the new
        // commit (which sits on the current base head), discarding the old
        // already-merged commits so the next PR's diff is clean.
        var resetRes = await githubApi('PATCH', '/repos/' + githubRepo + '/git/refs/heads/' + encodeURIComponent(args.branch_name), {
            sha: commitRes.body.sha,
            force: true
        });
        if (!resetRes.ok) return { success: false, error: 'Failed to recreate stale branch "' + args.branch_name + '": ' + JSON.stringify(resetRes.body) };
    } else {
        var refRes = await githubApi('POST', '/repos/' + githubRepo + '/git/refs', {
            ref: 'refs/heads/' + args.branch_name,
            sha: commitRes.body.sha
        });
        if (!refRes.ok) return { success: false, error: 'Failed to create branch "' + args.branch_name + '": ' + JSON.stringify(refRes.body) };
    }

    // 5. Resolve the PR for this branch. An open PR (found in step 0) is reused
    //    as-is (append). Otherwise, if the only PR(s) are closed-but-never-merged,
    //    reopen and reuse one — safe now because the branch was reset onto the
    //    current base head, so the reopened PR shows only this push's diff.
    //    A MERGED PR is never reused: a fresh PR is opened instead.
    //    (Blindly POSTing when a closed PR exists for the head 422s.)
    var prUrl, prNumber, prReused = false;
    var existingPr = null;
    if (openPrForBranch) {
        existingPr = openPrForBranch;
    } else if (branchExists) {
        var listRes = await githubApi('GET', '/repos/' + githubRepo + '/pulls?state=all&head=' + encodeURIComponent(ownerName + ':' + args.branch_name));
        if (listRes && listRes.ok && Array.isArray(listRes.body) && listRes.body.length > 0) {
            var _openPr = null, _reopenable = null;
            for (var _i = 0; _i < listRes.body.length; _i++) {
                var _candidate = listRes.body[_i];
                if (_candidate.state === 'open') { _openPr = _candidate; break; }
                // closed but never merged → can be reopened and reused
                if (!_candidate.merged_at && !_reopenable) _reopenable = _candidate;
            }
            if (_openPr) {
                existingPr = _openPr;
            } else if (_reopenable) {
                var reopenRes = await githubApi('PATCH', '/repos/' + githubRepo + '/pulls/' + _reopenable.number, { state: 'open' });
                if (reopenRes && reopenRes.ok) existingPr = reopenRes.body;
            }
        }
    }
    if (existingPr) {
        prReused = true;
        prNumber = existingPr.number;
        prUrl = existingPr.html_url;
        // Refresh the PR title ONLY when a pr_title was passed (it is optional when
        // appending to an existing open PR) and the body ONLY when a non-empty body
        // was passed — otherwise we'd wipe the existing PR title/description on append.
        var _prPatch = {};
        if (typeof args.pr_title === 'string' && args.pr_title !== '') _prPatch.title = args.pr_title;
        if (typeof args.pr_body === 'string' && args.pr_body !== '') _prPatch.body = args.pr_body;
        if (Object.keys(_prPatch).length > 0) {
            await githubApi('PATCH', '/repos/' + githubRepo + '/pulls/' + prNumber, _prPatch);
        }
    } else {
        var prRes = await githubApi('POST', '/repos/' + githubRepo + '/pulls', {
            title: args.pr_title,
            body: args.pr_body || '',
            head: args.branch_name,
            base: baseBranch
        });
        if (!prRes.ok) return { success: false, error: 'Failed to create PR: ' + JSON.stringify(prRes.body) };
        prUrl = prRes.body.html_url;
        prNumber = prRes.body.number;
    }

    // 6. Track PR on dirty files and in workspace meta — files stay dirty locally,
    //    but cross-chat ownership is released since the work has been published to a PR.
    //    Without this, the pusher's chat would keep blocking other chats from editing
    //    the same files until sync replaces them with merged remote content.
    var prInfo = { url: prUrl, number: prNumber, branch: args.branch_name };
    for (var k = 0; k < dirtyFiles.length; k++) {
        dirtyFiles[k].pushed_pr = prInfo;
        // Track pushed blob shas so sync can distinguish "my PR merged" from "someone else changed it"
        // For deleted files, track '::deleted::' sentinel since no blob is created
        if (!dirtyFiles[k].pushed_shas) dirtyFiles[k].pushed_shas = [];
        var _pushSha = blobShas[dirtyFiles[k].path] || (dirtyFiles[k].deleted ? '::deleted::' : null);
        if (_pushSha && dirtyFiles[k].pushed_shas.indexOf(_pushSha) === -1) {
            dirtyFiles[k].pushed_shas.push(_pushSha);
            // Keep only the last 20 pushed shas — older ones are unlikely to match
            if (dirtyFiles[k].pushed_shas.length > 20) dirtyFiles[k].pushed_shas = dirtyFiles[k].pushed_shas.slice(-20);
        }
        // Release cross-chat ownership now that the work is in a PR
        dirtyFiles[k].last_modified_by_chat_id = null;
        dirtyFiles[k].last_modified_by_chat_title = null;
        dirtyFiles[k].last_modified_at = null;
        await setWorkspaceFile(dirtyFiles[k]);
    }

    // Add (or refresh) the PR in the workspace meta prs list. When we appended to an
    // existing PR branch we update the tracked entry instead of pushing a duplicate.
    if (!meta.prs) meta.prs = [];
    var _trackedIdx = -1;
    for (var _p = 0; _p < meta.prs.length; _p++) {
        if (meta.prs[_p] && (meta.prs[_p].number === prNumber || meta.prs[_p].branch === args.branch_name)) { _trackedIdx = _p; break; }
    }
    if (_trackedIdx >= 0) meta.prs[_trackedIdx] = prInfo; else meta.prs.push(prInfo);
    await setWorkspaceMeta(meta);

    refreshWorkspaceContext();
    AgentEvents.emit('workspaceMutated', { action: 'push', repo: wk, branch: args.branch_name });
    return {
        success: true,
        workspace: wk,
        pr_url: prUrl,
        pr_number: prNumber,
        files_pushed: dirtyFiles.length,
        files_skipped: _filesSkipped,
        branch: args.branch_name,
        base_branch: (prReused && existingPr && existingPr.base && existingPr.base.ref) ? existingPr.base.ref : baseBranch,
        pr_reused: prReused,
        stale_branch_recreated: staleBranchRecreated,
        base_advanced: baseAdvanced,
        base_override_warning: _baseOverrideWarning || undefined,
        message: prReused
            ? ('Added a commit (' + dirtyFiles.length + ' file(s)) to existing PR #' + prNumber + (_filesSkipped ? '; ' + _filesSkipped + ' other dirty file(s) left out per args.files' : ''))
            : ('Opened PR #' + prNumber + ' with ' + dirtyFiles.length + ' file(s)' + (_filesSkipped ? '; ' + _filesSkipped + ' other dirty file(s) left out per args.files' : ''))
    };
}

// Default workspace path the built extension lives at. Deploys to the
// connected folder ROOT are restricted to this path ONLY — any other
// srcPath (including the icons source below) is only honored when a
// destSubdir is given.
// This keeps the protection that previously came from hardcoding the path:
// an arbitrary prefix can never spray files across the deploy folder root.
var DEPLOY_PATH = 'dist/extension';
// Icons deploy straight from source (workspace read/write corrupts binary
// blobs). NOT root-whitelisted: icons must be deployed with an explicit
// dest subfolder (e.g. dest: 'icons'), enforced by the refusal in wsDeploy.
var DEPLOY_ICONS_PATH = 'src/platform/extension/icons';
// Files the ROOT deploy is allowed to garbage-collect when they disappear
// from the workspace. Mirrors the output set of the extension_build skill
// tool (bundles, html shells, platform files) — KEEP IN SYNC with
// skills/extension-dev/build.js outputFiles/extFiles. Anything else at the
// folder root is presumed user-owned and is never deleted.
var DEPLOY_ROOT_MANAGED = ['app.html', 'app.js', 'app.css', 'sw-bundle.js', 'theme-init.js', 'view-init.js', 'manifest.json', 'background.js', 'content-script.js', 'rules.json', 'sandbox.html', 'widget-sandbox.html', 'file-download.html', 'file-download.js', 'offscreen.html', 'offscreen-helper.js'];

// Deploy workspace files to the connected disk folder.
// srcPath: workspace path prefix to deploy (default DEPLOY_PATH). destSubdir:
// optional subfolder inside the deploy dir to write into (e.g. 'icons').
// Performance: createWritable()/close() is expensive in Chrome (~100ms+ per
// file: swap file + safe-write). So files whose on-disk content already
// matches are SKIPPED (cheap getFile()+compare), and the remaining writes
// run in PARALLEL. A no-op deploy returns files_written: 0 with the skip
// count in files_skipped — callers gating on success should use the sum.
async function wsDeploy(wk, srcPath, destSubdir) {
    var handle = await getDeployDirHandle();
    if (!handle) return { success: false, error: 'No deploy folder connected. Go to Settings > GitHub > Connect Folder.' };

    var files = await getAllWorkspaceFiles(wk);
    if (files.length === 0) return { success: false, error: 'No files in workspace. Clone first.' };
    var srcNorm = (srcPath || DEPLOY_PATH).replace(/\/+$/, '');
    var prefix = srcNorm + '/';
    var dest = (destSubdir || '').replace(/^\/+|\/+$/g, '');
    // srcPath whitelist: deploys to the folder ROOT (no destSubdir) are only
    // allowed from DEPLOY_PATH. Any other prefix (including icons) must target
    // an explicit dest subfolder — a root icons deploy would spray PNGs at the
    // folder root AND trigger the root stale-GC below to delete every
    // DEPLOY_ROOT_MANAGED file (none of them are in an icons-only target set).
    if (!dest && srcNorm !== DEPLOY_PATH) {
        return { success: false, error: 'Refusing to deploy "' + srcNorm + '" to the deploy folder root. Only "' + DEPLOY_PATH + '" may deploy to the root; pass dest to write any other path into a subfolder (e.g. dest: "icons" for "' + DEPLOY_ICONS_PATH + '").' };
    }
    // Lazy clone: hydrate any stubs under the deploy path before writing to disk
    var hydrateFailed = [];
    try {
        var _dHyd = await wsHydrate(wk, function(p) { return p.indexOf(prefix) === 0; });
        if (_dHyd && _dHyd.failed && _dHyd.failed.length) hydrateFailed = _dHyd.failed;
        if (_dHyd && _dHyd.hydrated > 0) files = await getAllWorkspaceFiles(wk);
    } catch (e) { hydrateFailed.push('(hydrate error: ' + (e && e.message ? e.message : String(e)) + ')'); }

    // Collect deploy targets
    var targets = [];
    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (f.deleted) continue; // Skip deleted files
        if (f.path.indexOf(prefix) !== 0) continue;
        if (f.content == null) continue; // stub that failed hydration
        var rel = f.path.substring(prefix.length);
        if (!rel) continue;
        targets.push({ outPath: dest ? dest + '/' + rel : rel, content: f.content });
    }

    // A deploy matching nothing is almost always a typo'd/renamed srcPath or
    // a failed hydration — never let it silently no-op as a success.
    if (targets.length === 0) {
        var _zeroMsg = 'No deployable files found under "' + prefix + '"' + (hydrateFailed.length ? ' (' + hydrateFailed.length + ' file(s) failed hydration)' : '') + '.';
        return {
            success: false,
            error: _zeroMsg + (srcPath ? ' Check the path (renamed/typo?) and retry.' : ' Run a build first so ' + DEPLOY_PATH + ' exists.'),
            hydrate_failed: hydrateFailed.length ? hydrateFailed : undefined
        };
    }

    // Directory handle cache (promise-memoized so parallel writes don't race
    // on creating the same directory).
    var dirPromises = { '': Promise.resolve(handle) };
    function getDir(rel) {
        if (dirPromises[rel] !== undefined) return dirPromises[rel];
        var idx = rel.lastIndexOf('/');
        var parentRel = idx >= 0 ? rel.substring(0, idx) : '';
        var name = idx >= 0 ? rel.substring(idx + 1) : rel;
        dirPromises[rel] = getDir(parentRel).then(function(d) { return d.getDirectoryHandle(name, { create: true }); });
        return dirPromises[rel];
    }

    async function writeOne(t) {
        var parts = t.outPath.split('/');
        var dirHandle = await getDir(parts.slice(0, -1).join('/'));
        var fileName = parts[parts.length - 1];
        var isBinary = t.content.indexOf('::binary::') === 0;
        var bytes = null;
        if (isBinary) {
            var binStr = atob(t.content.substring('::binary::'.length));
            bytes = new Uint8Array(binStr.length);
            for (var b = 0; b < binStr.length; b++) bytes[b] = binStr.charCodeAt(b);
        }

        // Skip when the on-disk content is already identical — reading is far
        // cheaper than Chrome's safe-write cycle.
        try {
            var existingFh = await dirHandle.getFileHandle(fileName);
            var existing = await existingFh.getFile();
            if (isBinary) {
                if (existing.size === bytes.length) {
                    var old = new Uint8Array(await existing.arrayBuffer());
                    var same = true;
                    for (var c = 0; c < old.length; c++) { if (old[c] !== bytes[c]) { same = false; break; } }
                    if (same) return 'skipped';
                }
            } else {
                if (existing.size === new Blob([t.content]).size && (await existing.text()) === t.content) return 'skipped';
            }
        } catch (e) { /* file doesn't exist yet — write it */ }

        var fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
        var writable = await fileHandle.createWritable();
        await writable.write(isBinary ? bytes : t.content);
        await writable.close();
        return 'written';
    }

    // allSettled (not all): a single rejected write must not leave its
    // siblings running untracked, and per-file errors must reach the caller.
    var outcomes = await Promise.allSettled(targets.map(writeOne));
    var written = 0, skipped = 0, failedWrites = [];
    for (var oi = 0; oi < outcomes.length; oi++) {
        if (outcomes[oi].status === 'fulfilled') {
            if (outcomes[oi].value === 'written') written++; else skipped++;
        } else {
            var _rsn = outcomes[oi].reason;
            failedWrites.push({ path: targets[oi].outPath, error: (_rsn && _rsn.message) ? _rsn.message : String(_rsn) });
        }
    }

    var meta = await getWorkspaceMeta(wk);
    var branchName = meta ? meta.branch : parseWsKey(wk).branch;

    if (failedWrites.length > 0) {
        return {
            success: false,
            error: 'Deploy incomplete: ' + failedWrites.length + ' of ' + targets.length + ' file write(s) failed.',
            files_written: written,
            files_skipped: skipped,
            failed: failedWrites,
            branch: branchName
        };
    }

    // Stale-file cleanup — files deleted/renamed in the workspace would
    // otherwise live forever on disk. Scoping is deliberately CONSERVATIVE:
    //  - destSubdir deploys (e.g. icons/): the subdir is fully deploy-managed,
    //    so any file inside it that is not in the current target set is
    //    removed (recursively). Nothing outside the subdir is ever touched.
    //  - root deploys: the folder root may contain user files we do not own,
    //    so only TOP-LEVEL files whose names are in DEPLOY_ROOT_MANAGED (the
    //    build's known output set) and absent from the current target set are
    //    removed. Nested paths and unknown filenames are left alone.
    //  - skipped entirely when hydration failures made the target set
    //    incomplete (a failed-hydration file is indistinguishable from a
    //    deleted one — deleting it from disk would be wrong).
    var staleRemoved = [];
    var staleSkipped = null;
    var staleError = null;
    if (hydrateFailed.length > 0) {
        staleSkipped = 'stale-file cleanup skipped: ' + hydrateFailed.length + ' hydration failure(s) made the target set incomplete';
    } else {
        try {
            var targetSet = {};
            for (var ti = 0; ti < targets.length; ti++) targetSet[targets[ti].outPath] = true;
            if (dest) {
                var staleCandidates = [];
                async function collectFiles(dirHandle, rel) {
                    for await (var entry of dirHandle.values()) {
                        var childRel = rel + '/' + entry.name;
                        if (entry.kind === 'file') staleCandidates.push({ dir: dirHandle, name: entry.name, rel: childRel });
                        else await collectFiles(entry, childRel);
                    }
                }
                await collectFiles(await getDir(dest), dest);
                for (var sc = 0; sc < staleCandidates.length; sc++) {
                    if (!targetSet[staleCandidates[sc].rel]) {
                        await staleCandidates[sc].dir.removeEntry(staleCandidates[sc].name);
                        staleRemoved.push(staleCandidates[sc].rel);
                    }
                }
            } else if (srcNorm === DEPLOY_PATH) {
                // Root stale-GC only ever runs for a full DEPLOY_PATH deploy:
                // any other source would have a target set missing the managed
                // root files and wrongly delete them all.
                for await (var rootEntry of handle.values()) {
                    if (rootEntry.kind !== 'file') continue;
                    if (DEPLOY_ROOT_MANAGED.indexOf(rootEntry.name) < 0) continue;
                    if (!targetSet[rootEntry.name]) {
                        await handle.removeEntry(rootEntry.name);
                        staleRemoved.push(rootEntry.name);
                    }
                }
            }
        } catch (e) {
            staleError = e && e.message ? e.message : String(e);
        }
    }

    var result = { success: true, message: 'Deployed ' + written + ' files (' + skipped + ' unchanged) from ' + branchName + ' to ' + handle.name, files_written: written, files_skipped: skipped, branch: branchName };
    if (staleRemoved.length) {
        result.stale_removed = staleRemoved;
        result.message += '; removed ' + staleRemoved.length + ' stale file(s)';
    }
    if (staleSkipped) result.stale_skipped = staleSkipped;
    if (staleError) result.stale_cleanup_error = staleError;
    if (hydrateFailed.length) {
        result.warning = hydrateFailed.length + ' file(s) under "' + prefix + '" failed hydration and were NOT deployed: ' + hydrateFailed.slice(0, 10).join(', ') + (hydrateFailed.length > 10 ? ', …' : '');
        result.hydrate_failed = hydrateFailed;
    }
    return result;
}

// =============================================