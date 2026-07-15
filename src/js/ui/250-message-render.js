// Check if a message role is an attachment type
function isAttachmentRole(role) {
    return role === 'screenshot' || role === 'pdf' || role === 'file';
}

// Hook tools (set_chat_title / set_tldr / set_links) get special rendering
// treatment: their calls/results are hidden unless API stats are shown, and a
// hook-only tool message still counts as a final answer.
function isHookToolName(n) {
    return n === 'set_chat_title' || n === 'set_tldr' || n === 'set_links' || n === 'set_caveat';
}

// TL;DR card rendered at the end of an answer (set by the autoTldr hook via
// the set_tldr tool — see executeSetTldr in tools/020-tool-execution.js).
function renderTldrCard(msg) {
    if (!msg || !msg.tldr) return '';
    return '<div class="tldr-card"><div class="tldr-card-label">TL;DR</div><div class="tldr-card-text">' + formatContent(msg.tldr) + '</div></div>';
}

// Caveat card — a MUST-READ warning rendered ABOVE the TL;DR at the end of an
// answer (set by the autoCaveat hook via the set_caveat tool — see
// executeSetCaveat in tools/020-tool-execution.js). Amber/warning-styled so the
// user sees it first: off-plan deviations, unverified assumptions, incomplete
// work, or a trailing question/requested action the user might miss.
function renderCaveatCard(msg) {
    if (!msg || !msg.caveat) return '';
    return '<div class="caveat-card"><div class="caveat-card-label">⚠ Caveat — read this</div><div class="caveat-card-text">' + formatContent(msg.caveat) + '</div></div>';
}

// Links card rendered just below the TL;DR at the end of an answer (set by the
// autoLinks hook via the set_links tool — see executeSetLinks in
// tools/020-tool-execution.js). Each entry is a {title, url} the user may want
// to look into (PR, diff, ServiceNow record, doc page); opens in a new tab.
function renderLinksCard(msg) {
    if (!msg || !Array.isArray(msg.links) || !msg.links.length) return '';
    var items = msg.links.map(function(l) {
        // Defense in depth: executeSetLinks only stores http(s) urls, but old
        // or hand-edited chat data flows through here too — never emit a
        // clickable href for any other scheme (javascript:, data:, ...).
        if (!l || !l.url || !/^https?:\/\//i.test(l.url)) return '';
        var title = escapeHtml((l.title || l.url).toString());
        var href = escapeHtml(l.url.toString());
        return '<li class="links-card-item"><a class="links-card-link" href="' + href + '" target="_blank" rel="noopener noreferrer">' +
            '<span class="links-card-icon">' + UI_ICONS.externalLink + '</span>' +
            '<span class="links-card-title">' + title + '</span></a></li>';
    }).join('');
    if (!items) return '';
    return '<div class="links-card"><div class="links-card-label">LINKS</div><ul class="links-card-list">' + items + '</ul></div>';
}

// Render just the inner content of a single attachment (no group wrapper)
function renderAttachmentContent(msg, index) {
    if (msg.role === 'screenshot') {
        var screenshotName = msg.name || msg.description || 'Capture';
        // Resolve base64: try msg directly, fallback to chat.screenshots map
        var base64 = msg.base64;
        if (!base64 && msg.screenshot_id) {
            var ssChat = chats[currentChatId];
            if (ssChat && ssChat.screenshots && ssChat.screenshots[msg.screenshot_id]) {
                base64 = ssChat.screenshots[msg.screenshot_id].base64;
            }
        }
        var h = '<div class="message screenshot" id="msg-' + index + '">';
        h += '<div class="screenshot-container">';
        h += '<div class="screenshot-header" title="' + escapeHtml(screenshotName) + '"><span class="screenshot-icon">' + UI_ICONS.eye + '</span> ' + escapeHtml(screenshotName) + '</div>';
        if (base64) {
            h += '<img class="screenshot-thumbnail" src="' + escapeHtml(base64) + '" alt="Screenshot" onclick="openScreenshotModal(this.src, \'' + escapeJsString(screenshotName) + '\', ' + (msg.width || 0) + ', ' + (msg.height || 0) + ', \'' + escapeJsString(msg.url || '') + '\')" />';
        } else {
            h += '<div class="screenshot-thumbnail" style="display:flex;align-items:center;justify-content:center;height:80px;background:var(--bg-tertiary);color:var(--text-muted);font-size:var(--text-caption);border-radius:var(--radius-sm);">Screenshot unavailable</div>';
        }
        h += '</div></div>';
        return h;
    } else if (msg.role === 'pdf') {
        var pdfName = msg.name || msg.description || 'Document';
        var h = '<div class="message screenshot" id="msg-' + index + '">';
        h += '<div class="screenshot-container pdf-attachment-container">';
        h += '<div class="screenshot-header"><span class="screenshot-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span> PDF: ' + escapeHtml(pdfName) + '</div>';
        h += '<div class="pdf-attachment-preview" onclick="openPdfFromMessage(' + index + ')">';
        h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="width:40px;height:40px;opacity:0.5;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
        h += '<span style="font-size:var(--text-caption);color:var(--text-muted);margin-top: var(--space-2);">Click to preview</span>';
        h += '</div>';
        h += '</div></div>';
        return h;
    } else if (msg.role === 'file') {
        var fileName = msg.name || 'File';
        var fileExt = fileName.split('.').pop().toUpperCase();
        var fileSize = msg.size ? ' (' + formatFileSize(msg.size) + ')' : '';
        var h = '<div class="message screenshot" id="msg-' + index + '">';
        h += '<div class="screenshot-container file-attachment-container">';
        h += '<div class="screenshot-header"><span class="screenshot-icon" style="color:var(--success);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span> ' + escapeHtml(fileExt) + ': ' + escapeHtml(fileName) + fileSize + '</div>';
        h += '<div class="file-attachment-preview" onclick="openFileFromMessage(' + index + ')">';
        h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="width:40px;height:40px;opacity:0.5;color:var(--success);"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
        h += '<span style="font-size:var(--text-caption);color:var(--text-muted);margin-top: var(--space-2);">Click to preview</span>';
        h += '</div>';
        h += '</div></div>';
        return h;
    }
    return '';
}

// Find the previous/next attachment (skip everything except user messages which break groups)
function findAdjacentForAttachmentGroup(messages, index, direction) {
    var i = index + direction;
    while (i >= 0 && i < messages.length) {
        var role = messages[i].role;
        // User messages break the group
        if (role === 'user') {
            return { role: 'user' }; // Return a non-attachment to break group
        }
        // Found another attachment - group continues
        if (isAttachmentRole(role)) {
            return messages[i];
        }
        // Skip everything else (assistant, tool, approval, etc.)
        i += direction;
    }
    return null;
}

// R1: incremental render fast-path state. sigs[i] is the normalized HTML that
// the last completed render produced for chat.messages[i]. Normalized = the
// per-render rc-N copy nonces minted by storeRawCopy() are stripped, otherwise
// identical content would never compare equal across renders (gcRawCopyStore
// sweeps the discarded nonces afterwards — it keeps whatever the DOM still
// references, so untouched nodes keep working copy buttons).
var _lastRenderState = { chatId: null, count: 0, sigs: [] };

function _renderSig(part) {
    return part.replace(/ data-copy-id="rc-[0-9]+"/g, '');
}

// Shared by the full render and the R1 fast path: right-edge fade shadow for
// horizontally scrollable attachment/widget rows.
function _attachRowScrollShadow(row) {
    function updateShadow() {
        var hasOverflow = row.scrollWidth > row.clientWidth + 1;
        var notAtEnd = row.scrollLeft < row.scrollWidth - row.clientWidth - 5;
        row.classList.toggle('has-right-shadow', hasOverflow && notAtEnd);
    }
    updateShadow();
    row.addEventListener('scroll', updateShadow);
}

// R1: conservative incremental fast path for renderMessages(). Applies ONLY
// when we previously rendered this same chat and at most the LAST previously
// rendered message changed and/or new messages were appended. Patches just
// those nodes (outerHTML swap + append) instead of rebuilding the whole
// container, then runs the post-render side effects scoped to the touched
// subtree. Returns true when the patch was applied; false = caller must do
// the full rebuild. Every structural assumption is verified against the live
// DOM before mutating — any surprise falls back to the full render.
function _tryIncrementalRender(container, isRunning, mappedParts, newSigs, savedScrollTop) {
    var prev = _lastRenderState;
    var newCount = mappedParts.length;
    var oldCount = prev.count;

    // Same chat, nothing removed, and a previous render to diff against.
    if (prev.chatId !== currentChatId) return false;
    if (oldCount < 1 || newCount < oldCount) return false;

    // #streaming-text presence must match the current run state; a transition
    // in either direction needs the full render (it creates/removes the node).
    var streamingElNow = document.getElementById('streaming-text');
    if (!!streamingElNow !== !!isRunning) return false;

    // Locate the root holding the mapped message nodes. The full render puts
    // them in #messages-inner while streaming, directly in container otherwise.
    var root;
    if (streamingElNow) {
        root = container.querySelector('#messages-inner');
        if (!root) return false; // first streaming render hasn't built the wrapper yet
    } else {
        if (container.querySelector('#messages-inner')) return false; // stale streaming wrapper
        root = container;
    }

    // Any non-tail signature change forces the full render.
    for (var i = 0; i < oldCount - 1; i++) {
        if (newSigs[i] !== prev.sigs[i]) return false;
    }
    var tailIdx = oldCount - 1;
    var tailChanged = newSigs[tailIdx] !== prev.sigs[tailIdx];

    // Widget markup in the touched range → full render so the existing
    // moveBefore iframe-preservation logic owns it.
    var touchedHtml = tailChanged ? (prev.sigs[tailIdx] + mappedParts[tailIdx]) : '';
    for (var ai = oldCount; ai < newCount; ai++) touchedHtml += mappedParts[ai];
    if (touchedHtml.indexOf('widgets-container') !== -1 || touchedHtml.indexOf('widget-inline') !== -1) return false;

    // The old tail node must be an id-addressable DIRECT child of root. This
    // anchors both the patch and the append, and doubles as a DOM integrity
    // check (e.g. the widget editor swapped out #messages content earlier).
    var tailEl = document.getElementById('msg-' + tailIdx);
    if (!tailEl || tailEl.parentNode !== root) return false;

    var newTailEl = tailEl;
    if (tailChanged) {
        // The replacement must be exactly ONE element carrying the same id.
        var probe = document.createElement('div');
        probe.innerHTML = mappedParts[tailIdx];
        if (probe.children.length !== 1 || probe.childNodes.length !== 1) return false;
        if (probe.firstElementChild.id !== ('msg-' + tailIdx)) return false;
        tailEl.outerHTML = mappedParts[tailIdx];
        newTailEl = document.getElementById('msg-' + tailIdx);
        if (!newTailEl) return false; // defensive — should be unreachable
    }

    // Append new messages right AFTER the tail node (not beforeend) so a
    // trailing queued-user bubble can't end up in front of them.
    var appendedNodes = [];
    if (newCount > oldCount) {
        var appendHtml = '';
        for (var ni = oldCount; ni < newCount; ni++) appendHtml += mappedParts[ni];
        if (appendHtml) {
            var stopAt = newTailEl.nextElementSibling; // first pre-existing node after tail (or null)
            newTailEl.insertAdjacentHTML('afterend', appendHtml);
            var walk = newTailEl.nextElementSibling;
            while (walk && walk !== stopAt) {
                appendedNodes.push(walk);
                walk = walk.nextElementSibling;
            }
        }
    }

    // Post-render side effects, scoped to the touched nodes.
    var touched = tailChanged ? [newTailEl].concat(appendedNodes) : appendedNodes;
    for (var ti = 0; ti < touched.length; ti++) {
        var tn = touched[ti];
        if (!tn.querySelectorAll) continue;
        var stickies = tn.querySelectorAll('details.tool-call.expanded, details.tool-result.expanded');
        for (var si = 0; si < stickies.length; si++) setupStickyObserver(stickies[si]);
        var rows = tn.querySelectorAll('.attachments-row, .widgets-container');
        for (var ri = 0; ri < rows.length; ri++) _attachRowScrollShadow(rows[ri]);
    }

    // Global side effects that are cheap and idempotent (mirrors the tail of
    // the full render path).
    renderQueuedUserBubble(container);
    updateVersionSidebarVisibility();
    renderVersionSidebar();
    initializeWidgetsInView();
    renderWidgetSidebar();
    initDisplayChecklists();

    // Scroll restore — single stick-to-bottom mechanism (see 050-streaming.js):
    // sticking users are pinned via the one choke point; everyone else keeps
    // their absolute position. CLAMP-ESCAPE: the tail swap / appends above can
    // transiently clamp container.scrollTop while the DOM is mid-mutation, so
    // sticking users ALSO get a same-task seeding pin (see the full render's
    // scroll-restore comment for the mechanism) before the rAF re-pin.
    if (stickToBottom) {
        pinToBottom(container);
        scrollToBottomIfAllowed();
    } else {
        restoreChatScrollTop(container, savedScrollTop);
    }

    if (typeof gcRawCopyStore === 'function') gcRawCopyStore();
    return true;
}

function renderMessages() {
    // Skip DOM rebuilds while the CURRENT chat's silent hooks run (prevents
    // flash) — per-chat gate (_isChatInSilentHook, tools/120-actions.js), so
    // another chat's hidden title/tldr/links turn never blocks re-renders of
    // the chat the user is viewing. Still only bail when the container
    // already shows the current chat: a chat SWITCH (detected by
    // _lastRenderState.chatId !== currentChatId) must always rebuild — safe
    // against hook flash, because the full render path filters hook messages
    // and their responses (isHookMessage checks below).
    if (typeof _isChatInSilentHook === 'function' && _isChatInSilentHook(currentChatId) && _lastRenderState.chatId === currentChatId) return;

    // B-B1: widget chat mode (the dashboard widget editor running inline) reuses
    // the #messages container via renderWidgetInChat. If a background agent loop
    // for the same chat (or widget chat mode opened *over* a streaming chat)
    // calls renderMessages, it would clobber the widget editor UI mid-edit.
    // Skip the rebuild while widget mode is active — closeWidgetChatMode triggers
    // a normal render when the user exits.
    if (typeof currentEditingWidget !== 'undefined' && currentEditingWidget) return;

    // Shadow the global `isRunning`: treat as streaming only if THIS chat is the
    // active streaming chat. The global flag is true whenever ANY chat is streaming,
    // including background action chats — but for rendering, we only care about the
    // chat the user is currently viewing. Without this scope, switching to a chat
    // while a background action streams would hide that chat's final assistant
    // message (because branches like `!(isRunning && block.isLastBlock)` falsely
    // assumed the visible chat was still streaming).
    var isRunning = window.isRunning && activeStreamingChatId === currentChatId;

    var container = document.getElementById('messages');
    var chat = chats[currentChatId];

    // Update context indicator
    updateContextIndicator();

    updateInputPosition();
    
    if (!container) return; // Guard against null container

    if (!chat || chat.messages.length === 0) {
        container.innerHTML = '';
        _lastRenderState = { chatId: currentChatId, count: 0, sigs: [] }; // R1: container wiped
        // Show empty state in input area
        var inputArea = document.getElementById('input-area');
        if (inputArea && !inputArea.querySelector('.empty-state')) {
            var emptyDiv = document.createElement('div');
            emptyDiv.className = 'empty-state';
            emptyDiv.textContent = 'Start a conversation';
            inputArea.insertBefore(emptyDiv, inputArea.firstChild);
        }
        return;
    } else {
        // Remove empty state from input area if present
        var inputArea = document.getElementById('input-area');
        if (inputArea) {
            var existingEmpty = inputArea.querySelector('.empty-state');
            if (existingEmpty) existingEmpty.remove();
        }
    }
    
    // Find user message indices to know where to insert inline changes
    var userMsgIndices = [];
    chat.messages.forEach(function(msg, idx) {
        if (msg.role === 'user') userMsgIndices.push(idx);
    });
    
    // In compact mode, collect everything grouped by response block (between user messages)
    var responseBlocks = [];
    var lastUserMsgIdx = -1;
    if (compactToolCalls) {
        // Find the last user message index to determine the "last" response block
        for (var i = chat.messages.length - 1; i >= 0; i--) {
            if (chat.messages[i].role === 'user' && !(chat.messages[i].isHookMessage && !hooksEnabled.showHookMessages)) {
                lastUserMsgIdx = i;
                break;
            }
        }
        
        // Group everything by response block
        var currentBlock = null;
        chat.messages.forEach(function(msg, msgIdx) {
            if (msg.role === 'user' && !(msg.isHookMessage && !hooksEnabled.showHookMessages)) {
                // Start a new block after each user message
                if (currentBlock) {
                    responseBlocks.push(currentBlock);
                }
                currentBlock = {
                    userMsgIdx: msgIdx,
                    toolCalls: [],
                    toolResults: [],
                    metrics: [],
                    assistantMsgs: [],
                    timeline: [], // Chronological list of thinking and tool calls
                    isStreaming: false,
                    lastToolName: null,
                    lastStatusMessage: null, // Human-friendly status message from last tool call
                    firstAssistantIdx: -1,
                    hasFinalAnswer: false // True when agent has sent final answer (not streaming)
                };
            } else if (msg.role === 'assistant' && currentBlock) {
                // Skip assistant responses to hook messages (don't add to block)
                var isHookResponse = false;
                if (!hooksEnabled.showHookMessages) {
                    for (var pi = msgIdx - 1; pi >= 0; pi--) {
                        if (chat.messages[pi].role === 'user') { 
                            if (chat.messages[pi].isHookMessage) isHookResponse = true;
                            break; 
                        }
                    }
                }
                if (isHookResponse) return; // Skip this message entirely
                if (currentBlock.firstAssistantIdx === -1) currentBlock.firstAssistantIdx = msgIdx;
                if (msg.isStreaming) currentBlock.isStreaming = true;
                if (msg.metrics) currentBlock.metrics.push(msg.metrics);
                currentBlock.assistantMsgs.push({ msg: msg, msgIdx: msgIdx });
                // Check if this is a final answer (content without tool_calls and not streaming)
                if (msg.content && !msg.tool_calls && !msg.isStreaming) {
                    currentBlock.hasFinalAnswer = true;
                }
                // Add thinking to timeline
                if (msg.thinking) {
                    currentBlock.timeline.push({ type: 'thinking', thinking: msg.thinking, msgIdx: msgIdx });
                }
                // Add intermediate content to timeline ONLY if this message also has tool_calls
                // (meaning it's truly intermediate, not the final answer)
                if (msg.content && msg.content.trim() && msg.tool_calls) {
                    currentBlock.timeline.push({ type: 'content', content: msg.content, msgIdx: msgIdx });
                    currentBlock.lastIntermediateContent = msg.content; // Track for display outside collapsible
                }
                if (msg.tool_calls) {
                    var hasSetChatTitleCompleted = false;
                    msg.tool_calls.forEach(function(tc, tcIdx) {
                        // Check if a hook tool call (set_chat_title / set_tldr) has completed (has a result)
                        if (isHookToolName(tc.function.name)) {
                            for (var ri = msgIdx + 1; ri < chat.messages.length; ri++) {
                                var rm = chat.messages[ri];
                                if (rm.role === 'tool' && rm.tool_call_id === tc.id) {
                                    hasSetChatTitleCompleted = true;
                                    break;
                                }
                                if (rm.role === 'user') break;
                            }
                            if (!showApiStats) return; // Skip adding to timeline but still tracked completion
                        }
                        // Find the result for this tool call
                        var resultContent = '';
                        var hasResult = false;
                        var resultMsgIdx = -1;
                        for (var ri = msgIdx + 1; ri < chat.messages.length; ri++) {
                            var rm = chat.messages[ri];
                            if (rm.role === 'tool' && rm.tool_call_id === tc.id) {
                                // Atomic-placeholder seeded by seedPlaceholderToolResults before
                                // execution — NOT a real result yet. Leave hasResult=false so the
                                // spinner stays and the literal "[Tool call pending — agent runtime
                                // restarted…]" text never leaks into the UI during a healthy run.
                                // The row will get a real result via recordToolResult, which clears
                                // _placeholder, and the next render will pick it up normally.
                                if (rm._placeholder) break;
                                resultContent = typeof rm.content === 'string' ? rm.content : JSON.stringify(rm.content);
                                hasResult = true;
                                resultMsgIdx = ri;
                                break;
                            }
                            if (rm.role === 'user') break;
                        }
                        // Find pending approval for this tool call (match by toolCallId only to avoid
                        // one approval matching multiple tool calls with the same name)
                        var approval = null;
                        for (var ai = msgIdx + 1; ai < chat.messages.length; ai++) {
                            var am = chat.messages[ai];
                            if (am.role === 'approval' && am.toolCallId === tc.id) {
                                approval = { msg: am, approvalIdx: ai, tcIdx: tcIdx, msgIdx: msgIdx };
                                break;
                            }
                            if (am.role === 'user') break;
                        }
                        // Check if this is an html_widget tool
                        var isWidget = tc.function.name === 'html_widget';
                        var toolItem = { tc: tc, result: resultContent, hasResult: hasResult, msgIdx: msgIdx, resultMsgIdx: resultMsgIdx, tcIdx: tcIdx, approval: approval, isWidget: isWidget };
                        currentBlock.toolCalls.push(toolItem);
                        // Add tool call to timeline
                        currentBlock.timeline.push({ type: 'tool', item: toolItem });
                        currentBlock.lastToolName = TOOL_DISPLAY_NAMES[tc.function.name] || tc.function.name;
                        // Extract status_message for display in collapsible header (works with partial JSON during streaming)
                        var blockStatusMsg = extractStatusMessage(tc.function.arguments);
                        if (blockStatusMsg) {
                            currentBlock.lastStatusMessage = blockStatusMsg;
                        }
                    });
                    // If ALL tool calls were hook tools (set_chat_title / set_tldr) and
                    // completion was tracked, mark as final answer
                    var allHookTools = msg.tool_calls.every(function(tc) { return isHookToolName(tc.function.name); });
                    if (hasSetChatTitleCompleted && msg.tool_calls.length > 0 && allHookTools) {
                        currentBlock.hasFinalAnswer = true;
                    }
                }
                // Add metrics to timeline after this message's tool calls (so it shows in correct location)
                if (msg.metrics && showApiStats) {
                    currentBlock.timeline.push({ type: 'metrics', metrics: msg.metrics, msgIdx: msgIdx });
                }
            } else if (msg.role === 'tool' && currentBlock) {
                // Skip tool results for hook responses
                if (!hooksEnabled.showHookMessages) {
                    // Find the assistant message that made this tool call
                    for (var ti = msgIdx - 1; ti >= 0; ti--) {
                        if (chat.messages[ti].role === 'assistant' && chat.messages[ti].tool_calls) {
                            // Check if this assistant message was a hook response
                            for (var pi = ti - 1; pi >= 0; pi--) {
                                if (chat.messages[pi].role === 'user') {
                                    if (chat.messages[pi].isHookMessage) return; // Skip this tool result
                                    break;
                                }
                            }
                            break;
                        }
                    }
                }
                currentBlock.toolResults.push({ msg: msg, msgIdx: msgIdx });
            }
        });
        // Push the last block
        if (currentBlock) {
            responseBlocks.push(currentBlock);
        }
    }

    // Map response blocks by their userMsgIdx for quick lookup
    var blocksByUserIdx = {};
    responseBlocks.forEach(function(block, blockIdx) {
        block.isLastBlock = (blockIdx === responseBlocks.length - 1);
        blocksByUserIdx[block.userMsgIdx] = block;
    });
    
    // Save scroll position before DOM rebuild - widgets will temporarily lose height
    var savedScrollTop = container.scrollTop;

    // Save collapsed state of attachment groups so re-render doesn't re-expand them
    var closedAttachmentGroups = {};
    container.querySelectorAll('details.attachments-details').forEach(function(d) {
        if (!d.open) closedAttachmentGroups[d.dataset.groupIdx] = true;
    });
    var closedWidgetGroups = {};
    container.querySelectorAll('details.widgets-details').forEach(function(d) {
        if (!d.open) closedWidgetGroups[d.dataset.widgetGroupIdx] = true;
    });

    // Track attachments already rendered as part of a group
    var processedAttachments = {};

    var mappedParts = chat.messages.map(function(msg, index) {
        var html = '';

        // Check for attachment grouping (screenshot, pdf, file should wrap together)
        // Skip hidden messages (tool, approval, browser_context) when checking adjacency
        var isAttachment = isAttachmentRole(msg.role);

        // If this attachment was already rendered as part of a group, return hidden placeholder
        if (isAttachment && processedAttachments[index]) {
            return '<div class="message ' + msg.role + '" id="msg-' + index + '" style="display:none;"></div>';
        }

        var prevVisibleMsg = findAdjacentForAttachmentGroup(chat.messages, index, -1);
        var prevIsAttachment = prevVisibleMsg && isAttachmentRole(prevVisibleMsg.role);

        // Render entire attachment group at the first attachment's position
        // This prevents non-attachment messages between group members from being nested inside the wrapper
        if (isAttachment && !prevIsAttachment) {
            // Collect all attachments in this group
            var groupIndices = [index];
            var j = index + 1;
            while (j < chat.messages.length) {
                if (chat.messages[j].role === 'user') break;
                if (isAttachmentRole(chat.messages[j].role)) groupIndices.push(j);
                j++;
            }
            var attachCount = groupIndices.length;
            // Label reflects what the group actually contains: roles are
            // 'screenshot' | 'pdf' | 'file' (see isAttachmentRole).
            var screenshotCount = groupIndices.filter(function(gIdx) {
                return chat.messages[gIdx].role === 'screenshot';
            }).length;
            var groupNoun = screenshotCount === attachCount ? 'Screenshots'
                : (screenshotCount === 0 ? 'Files' : 'Attachments');
            var groupLabel = groupNoun + (attachCount > 1 ? ' (' + attachCount + ')' : '');
            var groupOpen = closedAttachmentGroups[index] ? '' : ' open';
            html += '<details class="attachments-details" data-group-idx="' + index + '"' + groupOpen + '><summary class="attachments-summary"><span class="screenshot-icon">' + UI_ICONS.eye + '</span> ' + groupLabel + '</summary><div class="attachments-row">';
            // Render all attachments in the group and close the wrapper
            for (var gi = 0; gi < groupIndices.length; gi++) {
                html += renderAttachmentContent(chat.messages[groupIndices[gi]], groupIndices[gi]);
                if (gi > 0) processedAttachments[groupIndices[gi]] = true;
            }
            html += '</div></details>';
            return html;
        }

        // Check if this is the last message before a user message (or end of chat)
        // If so, render inline changes for the previous user's request
        var isLastBeforeNextUser = false;
        var prevUserMsgIdx = -1;
        for (var i = userMsgIndices.length - 1; i >= 0; i--) {
            if (userMsgIndices[i] < index) {
                prevUserMsgIdx = userMsgIndices[i];
                var nextUserIdx = userMsgIndices[i + 1] || chat.messages.length;
                if (index === nextUserIdx - 1) {
                    isLastBeforeNextUser = true;
                }
                break;
            }
        }
        
        if (msg.role === 'user') {
            // Hide hook messages unless showHookMessages is enabled
            if (msg.isHookMessage && !hooksEnabled.showHookMessages) {
                return '<div class="message user" id="msg-' + index + '" style="display:none;"></div>';
            }
            // Before rendering user message, check if we need to show changes from previous block
            // If the message was cached (long paste), show a collapsed scrollable preview with an expand toggle.
            var userBodyHtml;
            var isSubNoticeRow = false;
            if (msg.cachedContentId) {
                var sizeKB = Math.round((msg.content || '').length / 1024);
                var lines = (msg.content || '').split('\n').length;
                var expanded = !!userMsgExpandedState[(currentChatId || '_') + ':' + index];
                var badge = '<div class="user-cached-badge" title="This long message is cached. The agent reads it via cached_content_read/search/outline (content_id: ' + escapeHtml(msg.cachedContentId) + ').">' + UI_ICONS.cache + ' Cached · ' + sizeKB + 'KB · ' + lines + ' lines</div>';
                var toggleLabel = expanded ? 'Collapse' : 'Expand';
                var toggleClass = 'user-cached-toggle' + (expanded ? ' expanded' : '');
                var toggleBtn = '<button class="' + toggleClass + '" onclick="toggleUserMsgExpanded(' + index + ')" title="' + toggleLabel + ' full message">' + UI_ICONS.chevronDown + ' ' + toggleLabel + '</button>';
                var bodyClass = 'user-text user-text-cached' + (expanded ? ' expanded' : '');
                userBodyHtml = badge + '<div class="' + bodyClass + '">' + escapeHtml(msg.content) + '</div>' + toggleBtn;
            } else {
                // Render user messages as markdown (same pipeline as assistant
                // content). formatContent() escapes HTML before applying
                // markdown, so this is safe for arbitrary user input. Block
                // elements (headers, lists, code blocks) need a div, not a span.
                // Sub-agent task messages ("## Task") benefit directly.
                var rawUser = (typeof msg.content === 'string') ? msg.content : String(msg.content == null ? '' : msg.content);
                // Agent-communication notices — sub→parent final reports
                // (_wakeParentOnReport), mid-flight lifecycle updates
                // (_notifySubLifecycle) and parent→sub inbox drains
                // (_formatInboxDrain), all core/097 — render as designed
                // callout cards (final / progress / inbound variants) via
                // renderSubReportNotices (175-sub-agent-ui.js). Gated on
                // msg.injected so a USER quoting a notice keeps the normal
                // bubble; mixed injected rows (notice coalesced with other
                // queued text) keep non-notice segments on the normal path.
                var subNoticeHtml = (msg.injected && typeof renderSubReportNotices === 'function')
                    ? renderSubReportNotices(rawUser) : null;
                if (subNoticeHtml != null) {
                    isSubNoticeRow = true;
                    userBodyHtml = subNoticeHtml;
                } else {
                    userBodyHtml = '<div class="user-text user-text-md">' + formatContent(rawUser) + '</div>';
                }
            }
            return '<div class="message user' + (isSubNoticeRow ? ' sub-notice-msg' : '') + '" id="msg-' + index + '"><div class="msg-actions"><button class="edit-msg-btn" onclick="editMessage(' + index + ')" title="Edit and branch">' + UI_ICONS.edit + '</button><button class="copy-msg-btn" onclick="copyMessageText(' + index + ')" title="Copy message">' + UI_ICONS.copy + '</button></div><div class="message-content">' + userBodyHtml + '</div></div>';
        } else if (msg.role === 'assistant') {
            // Hide assistant responses to hook messages unless showHookMessages is enabled
            if (!hooksEnabled.showHookMessages) {
                var prevUserMsg = null;
                for (var pi = index - 1; pi >= 0; pi--) {
                    if (chat.messages[pi].role === 'user') { prevUserMsg = chat.messages[pi]; break; }
                }
                if (prevUserMsg && prevUserMsg.isHookMessage) {
                    return '<div class="message assistant" id="msg-' + index + '" style="display:none;"></div>';
                }
            }
            
            // Compact mode: render collapsible area with thinking + tools at the TOP on first assistant msg
            if (compactToolCalls) {
                // Find the response block for this assistant message
                var blockUserIdx = -1;
                for (var bi = index - 1; bi >= 0; bi--) {
                    if (chat.messages[bi].role === 'user' && !(chat.messages[bi].isHookMessage && !hooksEnabled.showHookMessages)) {
                        blockUserIdx = bi;
                        break;
                    }
                }
                var block = blocksByUserIdx[blockUserIdx];
                
                // Check if this is the first assistant message in the block
                var isFirstAssistant = block && block.firstAssistantIdx === index;
                
                // Check if this is the last assistant message with content (final answer)
                // First try: last assistant message with content but NO tool_calls (pure content response)
                // Fallback: last assistant message with content (even if it also has tool_calls)
                var isLastAssistant = false;
                var lastAssistantIdx = -1;
                var lastAssistantWithContentIdx = -1;
                if (block) {
                    for (var lai = block.assistantMsgs.length - 1; lai >= 0; lai--) {
                        var amsg = block.assistantMsgs[lai].msg;
                        // Track last assistant with any content
                        if ((amsg.content || amsg.isStreaming) && lastAssistantWithContentIdx === -1) {
                            lastAssistantWithContentIdx = block.assistantMsgs[lai].msgIdx;
                        }
                        // Prefer one with content but NO tool_calls (pure content response)
                        if ((amsg.content || amsg.isStreaming) && !amsg.tool_calls) {
                            lastAssistantIdx = block.assistantMsgs[lai].msgIdx;
                            break;
                        }
                    }
                    // If no pure content message found, use the last with any content
                    if (lastAssistantIdx === -1) lastAssistantIdx = lastAssistantWithContentIdx;
                    isLastAssistant = (index === lastAssistantIdx);
                }
                
                var isIntermediate = !isFirstAssistant && !isLastAssistant;
                // In compact mode, intermediate assistants never render content (tools go on first,
                // content on last). Hide them to prevent empty divs creating gaps.
                if (isIntermediate) {
                    return '<div class="message assistant" id="msg-' + index + '" style="display:none;"></div>';
                }
                // During streaming, non-first assistant content is in #streaming-text, not message divs
                if (isRunning && !isFirstAssistant && block && block.isStreaming) {
                    return '<div class="message assistant" id="msg-' + index + '" style="display:none;"></div>';
                }
                var html = '<div class="message assistant" id="msg-' + index + '">';
                
                // On FIRST assistant message, render the collapsible area with thinking + all tools
                // Also show when streaming (even if timeline is empty) so user sees immediate feedback
                if (isFirstAssistant && block && (block.timeline.length > 0 || block.isStreaming)) {
                    // Use stored state to preserve expanded state during streaming updates
                    // Fall back to DOM check for backwards compatibility, then default to collapsed
                    // B2: read with the same chatId-scoped key the toggle handler writes.
                    var compactKey = (currentChatId || '_') + ':' + index;
                    var isExpanded = compactAreaExpandedState[compactKey];
                    if (isExpanded === undefined) {
                        var compactAreaEl = document.querySelector('#msg-' + index + ' .compact-tools-area');
                        isExpanded = compactAreaEl ? compactAreaEl.open : false;
                    }
                    // Show tool count only when agent has finished (hasFinalAnswer), otherwise show status message or tool name
                    // Non-last blocks are always done (conversation moved past them, e.g. after message injection)
                    //
                    // BUG FIX: the spinner used to spin forever on any chat whose last block ended on
                    // a tool call without a trailing assistant-text message. Two cases hit this hard:
                    //   1. Sub-agent chats end with `report_to_parent` — there is no final answer
                    //      that follows, so `hasFinalAnswer` is never set and the spinner kept
                    //      spinning every time you opened the transcript.
                    //   2. Any chat that was interrupted (browser closed mid-run, network drop)
                    //      can be persisted with no final-answer message and stale isStreaming flags.
                    // Gate on `isChatRunning` so the spinner is only ever drawn for a chat that
                    // genuinely has a live agent loop. If the chat is dormant, there is nothing
                    // to spin for — done is done.
                    var chatActuallyRunning = (typeof isChatRunning === 'function') && isChatRunning(currentChatId);
                    var agentDone = !chatActuallyRunning || !block.isLastBlock || (block.hasFinalAnswer && !block.isStreaming);
                    // Pre-tool-call placeholder: when the model is still streaming with no
                    // status_message and no tool name yet, three concurrent chats would all
                    // show the same generic 'Processing...' — looks like a leak even though
                    // each panel is reading its own block. Pick a phase-specific label so
                    // the user can tell what stage each chat is in.
                    var streamingPlaceholder;
                    if (block.timeline.some(function(t) { return t.type === 'thinking'; })) {
                        streamingPlaceholder = 'Thinking…';
                    } else {
                        streamingPlaceholder = 'Awaiting response…';
                    }
                    // Live transport-level status (429/529 backoff, concurrents
                    // park) takes precedence over the generic placeholder while
                    // the run is live — without this, a re-render during backoff
                    // reset the status line to a bare "Thinking…" and the user
                    // stared at a silent spinner for the whole retry window.
                    var liveTransport = (!agentDone && typeof _transportStatusText === 'function') ? _transportStatusText(currentChatId) : null;
                    var statusText = agentDone ? (block.toolCalls.length + ' tool call' + (block.toolCalls.length > 1 ? 's' : '')) : (liveTransport || block.lastStatusMessage || block.lastToolName || streamingPlaceholder);
                    var spinnerClass = agentDone ? '' : ' streaming';

                    html += '<details class="compact-tools-area' + spinnerClass + '"' + (isExpanded ? ' open' : '') + ' ontoggle="toggleCompactAreaState(' + index + ', this)">';
                    html += '<summary class="compact-tools-summary">';
                    if (agentDone) {
                        html += '<span class="compact-tools-icon">' + UI_ICONS.tool + '</span>';
                    } else {
                        html += '<span class="compact-tools-spinner"></span>';
                    }
                    html += '<span class="compact-tools-status">' + escapeHtml(statusText) + '</span>';
                    html += '<span class="compact-tools-chevron">' + UI_ICONS.chevronDown + '</span>';
                    html += '</summary>';
                    html += '<div class="compact-tools-content">';
                    
                    // Render timeline items in chronological order (thinking interleaved with tools)
                    // Use EXACT same rendering as non-compact mode
                    block.timeline.forEach(function(timelineItem, tlIdx) {
                        if (timelineItem.type === 'thinking') {
                            // B2: scope thinking expand-state by chatId to avoid cross-chat collisions.
                            // The onclick handler still receives `thinkingKey` (msgIdx-tlIdx) and prepends chatId.
                            var thinkingKey = index + '-' + tlIdx;
                            var thinkingFullKey = (currentChatId || '_') + ':' + thinkingKey;
                            var thinkingExpanded = thinkingExpandedState[thinkingFullKey];
                            if (thinkingExpanded === undefined) {
                                var thinkingEl = document.querySelector('#msg-' + index + ' .thinking[data-tl-idx="' + tlIdx + '"]');
                                thinkingExpanded = thinkingEl ? thinkingEl.open : false;
                            }
                            html += '<details class="thinking" data-tl-idx="' + tlIdx + '"' + (thinkingExpanded ? ' open' : '') + ' ontoggle="toggleThinkingState(\'' + thinkingKey + '\', this)">';
                            html += '<summary><span class="thinking-status">Thought process</span></summary>';
                            html += '<div class="thinking-content">' + escapeHtml(timelineItem.thinking) + '</div></details>';
                        } else if (timelineItem.type === 'content') {
                            // Show intermediate content in their chronological location
                            // Skip last assistant content (shown in its own message div after screenshots)
                            if (timelineItem.msgIdx !== lastAssistantIdx) {
                                html += '<div class="message-content">' + formatContent(timelineItem.content) + '</div>';
                            }
                        } else if (timelineItem.type === 'tool') {
                            var item = timelineItem.item;
                            var tc = item.tc;
                            var tcKey = 'tc-' + item.msgIdx + '-' + item.tcIdx;
                            var tcEl = document.getElementById(tcKey);
                            var tcOpen = tcEl ? tcEl.open : false;
                            var tcFullHeight = false;

                            // Extract status_message from tool arguments (works with partial JSON during streaming)
                            var compactStatusMessage = extractStatusMessage(tc.function.arguments);

                            html += '<details class="tool-call' + (item.hasResult ? ' has-result' : '') + '" id="' + tcKey + '"' + (tcOpen ? ' open' : '') + ' onclick="toggleToolCallExpanded(' + item.msgIdx + ', ' + item.tcIdx + ', this)">';
                            html += '<summary>';
                            if (compactStatusMessage) {
                                html += '<span class="tool-status-message">' + escapeHtml(compactStatusMessage) + '</span>';
                            }
                            html += '<span class="tool-name">' + getToolIcon(tc.function.name) + ' ' + escapeHtml(TOOL_DISPLAY_NAMES[tc.function.name] || tc.function.name) + '</span>';
                            if (item.hasResult) {
                                html += '<span class="tool-result-badge">' + UI_ICONS.check + '</span>';
                            }
                            html += '</summary>';
                            var argsCopyId = storeRawCopy(tc.function.arguments);
                            html += '<div class="tool-args-wrapper" data-copy-id="' + argsCopyId + '">';
                            html += '<button class="tool-expand-btn" onclick="toggleToolExpand(this, event)" title="Expand">⤢</button>';
                            html += '<pre class="tool-args">' + formatJsonPretty(tc.function.arguments) + '</pre>';
                            html += '<button class="tool-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div>';

                            // Render tool result inline within the same panel
                            if (item.hasResult) {
                                var resultContent = formatJsonPretty(item.result);
                                var resultCopyId = storeRawCopy(item.result);
                                html += '<div class="tool-result-section"><div class="tool-result-wrapper" data-copy-id="' + resultCopyId + '">';
                                html += '<button class="tool-result-expand-btn" onclick="toggleToolExpand(this, event)" title="Expand">⤢</button>';
                                html += '<pre>' + resultContent + '</pre>';
                                html += '<button class="tool-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div></div>';
                            }
                            html += '</details>';
                        } else if (timelineItem.type === 'metrics') {
                            // Render metrics in chronological location
                            html += formatMetrics(timelineItem.metrics);
                        }
                    });
                    
                    html += '</div></details>';

                    // Render widgets OUTSIDE the collapsible in a grouped container
                    var blockWidgetHtml = '';
                    var blockDisplayHtml = '';
                    block.toolCalls.forEach(function(item) {
                        if (item.hasResult && item.resultMsgIdx >= 0) {
                            blockWidgetHtml += getWidgetHtmlForMessage(item.resultMsgIdx);
                            // Eager-render displays attached to this tool's result slot
                            // (created via executeTool('display', ...) from inside js_eval
                            // / skill / widget sandboxes — see executeDisplay).
                            if (typeof getDisplayHtmlForMessage === 'function') {
                                blockDisplayHtml += getDisplayHtmlForMessage(item.resultMsgIdx);
                            }
                        }
                    });
                    if (blockWidgetHtml) {
                        var wCount = (blockWidgetHtml.match(/class="widget-inline/g) || []).length;
                        var wLabel = 'Widgets' + (wCount > 1 ? ' (' + wCount + ')' : '');
                        var wGroupOpen = closedWidgetGroups[index] ? '' : ' open';
                        html += '<details class="widgets-details" data-widget-group-idx="' + index + '"' + wGroupOpen + '><summary class="widgets-summary"><span class="widget-icon">' + UI_ICONS.widget + '</span> ' + wLabel + '</summary><div class="widgets-container">' + blockWidgetHtml + '</div></details>';
                    }
                    if (blockDisplayHtml) {
                        html += '<div class="displays-container">' + blockDisplayHtml + '</div>';
                    }
                    
                    // Intermediate content is always shown inside the collapsible timeline
                    // to prevent text appearing between the tools area and screenshots
                    
                }
                
                // During streaming, content for the current block goes to #streaming-text (not message divs)
                // Old completed blocks always render their content normally
                if (msg.content && !msg.isStreaming && isLastAssistant && !(isRunning && block && block.isLastBlock)) {
                    html += '<div class="message-content">' + formatContent(msg.content) + '</div>';
                    if (msg.caveat) html += renderCaveatCard(msg);
                    if (msg.tldr) html += renderTldrCard(msg);
                    if (msg.links) html += renderLinksCard(msg);
                }
                
                // Add metrics for non-tool messages
                if (msg.metrics && showApiStats && (!block || block.toolCalls.length === 0)) {
                    html += formatMetrics(msg.metrics);
                }
                
                // Show Copy Answer when agent is done
                // Non-last blocks are always done (conversation moved past them)
                var agentDone = block && (!block.isLastBlock || (block.hasFinalAnswer && !block.isStreaming));
                if (isLastAssistant && agentDone && prevUserMsgIdx >= 0) {
                    html += renderInlineChanges(prevUserMsgIdx);
                    html += '<div class="assistant-actions visible"><button class="copy-ai-btn" onclick="copyAiMessage(' + prevUserMsgIdx + ')">' + UI_ICONS.copy + ' Copy Answer</button></div>';
                }
                
                html += '</div>';
                return html;
            }
            
            // Standard mode (non-compact)
            var html = '<div class="message assistant" id="msg-' + index + '">';
            if (msg.thinking || msg.isStreaming) {
                var isStreaming = msg.isStreaming === true;
                var hasThinking = msg.thinking && msg.thinking.length > 0;
                var isCollapsed = msg.thinkingCollapsed === true && !isStreaming;
                var openAttr = isCollapsed ? '' : 'open';
                var statusClass = isStreaming ? 'active' : (isCollapsed ? 'collapsed' : '');
                var statusText = isStreaming ? (hasThinking ? 'Thinking...' : 'Processing...') : (isCollapsed ? 'Thought process (click to expand)' : 'Thought process');
                var contentClass = isStreaming ? 'thinking-content streaming' : 'thinking-content';
                var thinkingContent = hasThinking ? escapeHtml(msg.thinking) : (isStreaming ? '<span class="processing-indicator">Waiting for model response...</span>' : '');
                html += '<details class="thinking ' + statusClass + '" ' + openAttr + '>' +
                    '<summary><span class="thinking-status">' + statusText + '</span>' +
                    (isStreaming ? '<span class="thinking-indicator"></span>' : '') +
                    '</summary>' +
                    '<div class="' + contentClass + '">' + thinkingContent + '</div></details>';
            }
            if (msg.content && !msg.isStreaming && !isRunning) {
                html += '<div class="message-content">' + formatContent(msg.content) + '</div>';
                if (msg.caveat) html += renderCaveatCard(msg);
                if (msg.tldr) html += renderTldrCard(msg);
                if (msg.links) html += renderLinksCard(msg);
            }
            if (msg.tool_calls) {
                // Standard mode: render each tool call separately
                msg.tool_calls.forEach(function(tc, tcIdx) {
                    // Hide hook tool calls (set_chat_title / set_tldr) unless showing API stats
                    if (isHookToolName(tc.function.name) && !showApiStats) {
                        return; // Skip rendering this tool call
                    }
                    var tcKey = 'tc-' + index + '-' + tcIdx;
                    // Check if user explicitly toggled this tool call
                    var hasExplicitPref = msg.toolCallsExpanded && msg.toolCallsExpanded.hasOwnProperty(tcIdx);
                    var tcOpen;
                    if (hasExplicitPref) {
                        // Respect user's explicit choice
                        tcOpen = msg.toolCallsExpanded[tcIdx];
                    } else {
                        // Default: closed (only open during streaming via updateStreamingMessage)
                        tcOpen = false;
                    }
                    
                    // Find associated approval message for this tool call
                    var approval = null;
                    var tcToolName = tc.function.name;
                    var tcDisplayName = TOOL_DISPLAY_NAMES[tcToolName] || tcToolName;
                    // For servicenow_api or iframe_tool, also get the action-specific display name
                    var tcActionDisplayName = null;
                    // Extract status_message (works with partial JSON during streaming)
                    var tcStatusMessage = extractStatusMessage(tc.function.arguments);
                    try {
                        var tcArgs = JSON.parse(tc.function.arguments);
                        if (tcToolName === 'servicenow_api' && tcArgs.method) {
                            tcActionDisplayName = TOOL_DISPLAY_NAMES['servicenow_api:' + tcArgs.method];
                        } else if (tcToolName === 'iframe_tool' && tcArgs.action) {
                            tcActionDisplayName = TOOL_DISPLAY_NAMES['iframe_tool:' + tcArgs.action];
                        }
                    } catch (e) {
                        // Ignore JSON parse errors during streaming (incomplete JSON)
                    }
                    for (var ai = index + 1; ai < chat.messages.length; ai++) {
                        var am = chat.messages[ai];
                        if (am.role === 'approval') {
                            // Match by toolCallId if available, otherwise by tool name (both original, display, and action-specific display name)
                            if (am.toolCallId === tc.id || 
                                (!am.toolCallId && (am.toolName === tcToolName || am.toolName === tcDisplayName || (tcActionDisplayName && am.toolName === tcActionDisplayName)))) {
                                approval = { msg: am, index: ai };
                                break;
                            }
                        }
                        if (am.role === 'user') break;
                    }
                    
                    var statusClass = approval ? (approval.msg.status === 'allowed' || approval.msg.status === 'always_allowed' || approval.msg.status === 'session_allowed' ? ' approved' : (approval.msg.status === 'denied' ? ' denied' : (approval.msg.status === 'pending' ? ' pending' : ''))) : '';
                    var needsApproval = approval && approval.msg.status === 'pending';
                    if (needsApproval) tcOpen = true;
                    
                    // Check for full-height expanded state
                    var tcFullHeight = msg.toolCallsFullHeight && msg.toolCallsFullHeight[tcIdx];
                    var expandedClass = tcFullHeight ? ' expanded' : '';
                    
                    html += '<details class="tool-call' + statusClass + expandedClass + '" id="' + tcKey + '" onclick="toggleToolCallExpanded(' + index + ', ' + tcIdx + ', this)"' + (tcOpen ? ' open' : '') + '>';
                    html += '<summary><span class="tool-name">' + getToolIcon(tc.function.name) + ' ' + escapeHtml(TOOL_DISPLAY_NAMES[tc.function.name] || tc.function.name) + '</span>';
                    if (tcStatusMessage) {
                        html += '<span class="tool-status-message">' + escapeHtml(tcStatusMessage) + '</span>';
                    }
                    if (approval) {
                        var statusLabel = approval.msg.status === 'pending' ? 'Pending' : (approval.msg.status === 'allowed' ? 'Allowed' : (approval.msg.status === 'always_allowed' ? 'Always' : (approval.msg.status === 'session_allowed' ? 'Session' : 'Denied')));
                        html += '<span class="tool-status ' + approval.msg.status + '">' + statusLabel + '</span>';
                    }
                    html += '</summary>';
                    var copyId = storeRawCopy(tc.function.arguments);
                    html += '<div class="tool-args-wrapper" data-copy-id="' + copyId + '">';
                    html += '<button class="tool-expand-btn" onclick="toggleToolExpand(this, event)" title="' + (tcFullHeight ? 'Collapse' : 'Expand') + '">' + (tcFullHeight ? '⤡' : '⤢') + '</button>';
                    html += '<pre class="tool-args' + (tcFullHeight ? ' expanded' : '') + '">' + formatJsonPretty(tc.function.arguments) + '</pre>';
                    html += '<button class="tool-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div>';
                    html += '</details>';
                });
            }
            // Add metrics display if available and setting enabled
            if (msg.metrics && showApiStats) {
                html += formatMetrics(msg.metrics);
            }
            
            // Add inline changes if this is the last message before next user message or end of chat
            if (isLastBeforeNextUser && prevUserMsgIdx >= 0) {
                html += renderInlineChanges(prevUserMsgIdx);
                // Add copy button once at end of complete response
                html += '<div class="assistant-actions visible"><button class="copy-ai-btn" onclick="copyAiMessage(' + prevUserMsgIdx + ')">' + UI_ICONS.copy + ' Copy Answer</button></div>';
            }
            
            html += '</div>';
            return html;
        } else if (msg.role === 'tool') {
            // Hide tool results in compact mode (they're shown inline with tool calls)
            if (compactToolCalls) {
                return '<div class="message tool" id="msg-' + index + '" style="display:none;"></div>';
            }
            // Atomic-placeholder row (seeded before tool execution to keep the
            // persisted Anthropic shape valid across SW eviction). Not a real
            // result — hide it; the row will re-render with real content once
            // recordToolResult overwrites it and clears _placeholder.
            if (msg._placeholder) {
                return '<div class="message tool" id="msg-' + index + '" style="display:none;"></div>';
            }
            // Hide hook tool results (set_chat_title / set_tldr) unless showing API stats
            if (isHookToolName(msg.name) && !showApiStats) {
                return '<div class="message tool" id="msg-' + index + '" style="display:none;"></div>';
            }
            var content = typeof msg.content === 'string' ? formatJsonPretty(msg.content) : formatJsonValue(msg.content, 0);
            var contentHtml = content;
            if (window.currentSearchHighlight) {
                contentHtml = applySearchHighlight(contentHtml, window.currentSearchHighlight);
            }
            // Check DOM state for tool result expansion
            var toolResultEl = document.querySelector('#msg-' + index + ' .tool-result');
            var toolResultOpen = msg.expanded === true || (toolResultEl && toolResultEl.open);
            var toolResultFullHeight = msg.fullHeight === true;
            var rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
            var resultCopyId = storeRawCopy(rawContent);
            var toolHtml = '<div class="message tool" id="msg-' + index + '"><details class="tool-result' + (toolResultFullHeight ? ' expanded' : '') + '" onclick="toggleToolResultExpanded(' + index + ', this)"' + (toolResultOpen ? ' open' : '') + '>' +
                '<summary><span class="tool-label">' + getToolIcon(msg.name) + ' ' + escapeHtml(TOOL_DISPLAY_NAMES[msg.name] || msg.name) + ' result</span></summary>' +
                '<div class="tool-result-wrapper" data-copy-id="' + resultCopyId + '">' +
                '<button class="tool-result-expand-btn" onclick="toggleToolExpand(this, event)" title="' + (toolResultFullHeight ? 'Collapse' : 'Expand') + '">' + (toolResultFullHeight ? '⤡' : '⤢') + '</button>' +
                '<pre' + (toolResultFullHeight ? ' class="expanded"' : '') + '>' + contentHtml + '</pre>' +
                '<button class="tool-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div>' +
            '</details>';
            
            // Add widgets in a grouped container (matches html_widget results and tools like js_eval/skill tools that create widgets internally)
            var msgWidgetHtml = getWidgetHtmlForMessage(index);
            if (msgWidgetHtml) {
                var mwCount = (msgWidgetHtml.match(/class="widget-inline/g) || []).length;
                var mwLabel = 'Widgets' + (mwCount > 1 ? ' (' + mwCount + ')' : '');
                var mwGroupOpen = closedWidgetGroups[index] ? '' : ' open';
                toolHtml += '<details class="widgets-details" data-widget-group-idx="' + index + '"' + mwGroupOpen + '><summary class="widgets-summary"><span class="widget-icon">' + UI_ICONS.widget + '</span> ' + mwLabel + '</summary><div class="widgets-container">' + msgWidgetHtml + '</div></details>';
            }
            // Eager-rendered displays for this tool result (created via
            // executeTool('display', ...) from inside js_eval / skill / widget
            // sandboxes — see executeDisplay).
            if (typeof getDisplayHtmlForMessage === 'function') {
                var msgDisplayHtml = getDisplayHtmlForMessage(index);
                if (msgDisplayHtml) {
                    toolHtml += '<div class="displays-container">' + msgDisplayHtml + '</div>';
                }
            }
            
            // Add inline changes if this is the last message before next user message or end of chat
            if (isLastBeforeNextUser && prevUserMsgIdx >= 0) {
                toolHtml += renderInlineChanges(prevUserMsgIdx);
            }
            
            toolHtml += '</div>';
            return toolHtml;
        } else if (msg.role === 'approval') {
            // Approval messages have no inline rendering here — pending approvals
            // surface via the snackbar (160-notifications); standard mode shows a
            // status pill on the matching tool-call summary.
            return '<div class="message approval" id="msg-' + index + '" style="display:none;"></div>';
        } else if (msg.role === 'prompt_user') {
            return renderPromptUserMessage(msg, index);
        } else if (msg.role === 'action_button') {
            return renderInlineActionButton(msg, index);
        } else if (msg.role === 'sub_report') {
            return renderSubReport(msg, index);
        } else if (msg.role === 'sub_msg') {
            // Standalone mid-flight sub→parent message callout (UI-only row
            // pushed by agentMessage(to:'parent'), core/097). Renderer lives
            // in 175-sub-agent-ui.js next to the other .sub-notice cards.
            return renderSubAgentMessage(msg, index);
        } else if (msg.role === 'browser_context' || msg.role === 'context') {
            // Context messages are hidden from UI - they're only for API context
            // But we still need the ID for scrolling to work correctly
            return '<div class="message browser-context" id="msg-' + index + '" style="display:none;"></div>';
        } else if (msg.role === 'parked_tool') {
            // Parked-tool indicator (pushed by 036-agent-event-handlers-page.js
            // toolParked handler, after a 750ms grace window). A UI-required tool
            // is waiting because no panel is currently connected; it auto-resumes
            // when one is opened. The handler removes this row on toolUnparked,
            // so this only ever renders in the genuinely panel-less case (not
            // during a brief SW-restart reconnect flicker).
            var parkedContent = (typeof msg.content === 'string' && msg.content) ? msg.content : '📌 Tool waiting for a panel — auto-resumes when you open one.';
            return '<div class="message parked-tool" id="msg-' + index + '">' + escapeHtml(parkedContent) + '</div>';
        }
        return '';
    });
    var mappedHtml = mappedParts.join('');

    // R1: compute per-message signatures and try the incremental fast path
    // before falling through to the full innerHTML rebuild below.
    var newSigs = new Array(mappedParts.length);
    for (var sgi = 0; sgi < mappedParts.length; sgi++) newSigs[sgi] = _renderSig(mappedParts[sgi]);
    if (_tryIncrementalRender(container, isRunning, mappedParts, newSigs, savedScrollTop)) {
        _lastRenderState = { chatId: currentChatId, count: mappedParts.length, sigs: newSigs };
        return;
    }

    // During streaming, keep #streaming-text in the DOM to preserve its scroll position.
    // All other content goes inside a #messages-inner wrapper - a single innerHTML swap.
    var existingStreamingEl = isRunning ? document.getElementById('streaming-text') : null;

    // SC-1: the preserved element must belong to THIS chat. When the user
    // switches between two RUNNING chats, selectChat sets isRunning=true and
    // activeStreamingChatId=<target chat> BEFORE calling renderMessages, so
    // the lookup above finds the PREVIOUS chat's #streaming-text and the
    // preserve branch below would rebuild #messages-inner AROUND it — keeping
    // the old chat's streamed text (and any embedded smart-document card,
    // which sdocReRenderAll keeps refreshing via a document-wide selector)
    // under the new chat's tools panel indefinitely. Its .streaming-entry
    // rows are keyed by data-msg-idx only, so the new chat's deltas merely
    // overwrite colliding indices and never clear the rest. Treat a foreign
    // (or unstamped) element as stale: drop it and take the fresh-element
    // branch, whose REG-F4 repopulation rebuilds the tail from THIS chat's
    // own messages.
    if (existingStreamingEl && existingStreamingEl.dataset.chatId !== currentChatId) {
        existingStreamingEl.remove();
        existingStreamingEl = null;
    }

    // Preserve live widget iframes across innerHTML rebuild using moveBefore().
    // moveBefore() (Chrome 124+, Firefox 131+) is the ONLY DOM API that moves
    // nodes without resetting iframe content. appendChild/replaceChild/insertBefore
    // all destroy iframe state per HTML spec.
    // We park widgets on document.body (hidden) so both container.innerHTML and
    // inner.innerHTML paths are safe, then moveBefore them back to their placeholders.
    var savedWidgets = {};
    var canMoveBefore = typeof Element.prototype.moveBefore === 'function';
    if (canMoveBefore) {
        var searchRoot = container.querySelector('#messages-inner') || container;
        var liveWidgets = searchRoot.querySelectorAll('.widget-inline[data-widget-id]');
        liveWidgets.forEach(function(wi) {
            var wid = wi.getAttribute('data-widget-id');
            if (wid && wi.querySelector('iframe.widget-iframe')) {
                wi.style.display = 'none';
                document.body.moveBefore(wi, null); // park on body — iframe stays alive
                savedWidgets[wid] = wi;
            }
        });
    }

    if (existingStreamingEl) {
        var inner = container.querySelector('#messages-inner');
        if (!inner) {
            inner = document.createElement('div');
            inner.id = 'messages-inner';
            var child = container.firstChild;
            while (child) {
                var next = child.nextSibling;
                if (child !== existingStreamingEl) child.remove();
                child = next;
            }
            container.insertBefore(inner, existingStreamingEl);
        }
        inner.innerHTML = mappedHtml;
    } else {
        container.innerHTML = mappedHtml;
        if (isRunning) {
            container.appendChild(createStreamingTextEl());
            // REG-F4: the fresh streaming container is EMPTY and is only ever
            // filled by updateStreamingText via a streamDelta. With the R9
            // interval skip there is no guaranteed 1s repaint anymore — if the
            // user switches back to this chat during a token stall, the
            // streaming area would stay blank until the next chunk. Repopulate
            // immediately from the mirror when the tail is mid-stream.
            var _f4TailIdx = chat.messages.length - 1;
            var _f4Tail = chat.messages[_f4TailIdx];
            // SC-2: no `&& _f4Tail.content` — a tail that is mid-stream but has
            // no text yet (thinking / tool_input phase) still needs the call:
            // updateStreamingText repaints EVERY finalized .streaming-entry of
            // the current turn (earlier between-tool-call text), not just the
            // streaming tail. Requiring content here left the whole turn's
            // streamed text hidden when the user switched back during that
            // window. updateStreamingText itself skips content-less messages.
            if (_f4Tail && _f4Tail.role === 'assistant' && _f4Tail.isStreaming === true) {
                updateStreamingText(_f4Tail, _f4TailIdx, currentChatId);
            } else if (typeof _flushFinalizedStreamingText === 'function') {
                // FLUSH-TAIL companion (see 036-agent-event-handlers-page.js):
                // mid-run the tail can be a FINALIZED assistant message sitting
                // behind `[pending]` placeholder tool rows (long-blocking tool
                // call in flight). The strict tail check above misses it, so
                // switching back to the chat showed a blank/partial answer
                // until the run ended. Repopulate from the last assistant
                // message — isStreaming=false makes getDisplayContent return
                // the full text.
                _flushFinalizedStreamingText(currentChatId);
            }
        }
    }

    // Move preserved widgets back from body to their placeholder positions
    var savedWidgetIds = Object.keys(savedWidgets);
    if (savedWidgetIds.length > 0) {
        var rebuildRoot = container.querySelector('#messages-inner') || container;
        for (var swi = 0; swi < savedWidgetIds.length; swi++) {
            var swid = savedWidgetIds[swi];
            var placeholder = rebuildRoot.querySelector('.widget-inline[data-widget-id="' + swid + '"]');
            if (placeholder && canMoveBefore) {
                savedWidgets[swid].style.display = '';
                placeholder.parentNode.moveBefore(savedWidgets[swid], placeholder);
                placeholder.remove();
            } else {
                savedWidgets[swid].querySelectorAll('.widget-iframe').forEach(function(iframe) {
                    if (iframe.__widgetCleanup) iframe.__widgetCleanup();
                });
                savedWidgets[swid].remove();
            }
        }
    }

    // Scope post-render queries to the rebuilt content area only
    var contentRoot = container.querySelector('#messages-inner') || container;

    // Set up sticky observers for any expanded tool panels
    contentRoot.querySelectorAll('details.tool-call.expanded, details.tool-result.expanded').forEach(function(details) {
        setupStickyObserver(details);
    });

    // Click-to-fullscreen for widget thumbnails inside .widgets-container
    contentRoot.querySelectorAll('.widgets-container .widget-inline').forEach(function(wi) {
        // R4: widget nodes survive re-renders via moveBefore — without this guard
        // every render stacked ANOTHER click listener on the same node.
        if (wi.dataset.fsBound) return;
        wi.dataset.fsBound = '1';
        wi.addEventListener('click', function(e) {
            if (e.target.closest('.widget-controls')) return;
            var wid = wi.getAttribute('data-widget-id');
            if (wid) openWidgetFullscreen(wid);
        });
    });

    // Set up scroll shadow for attachments rows and widget rows (right fade when more content is hidden)
    contentRoot.querySelectorAll('.attachments-row, .widgets-container').forEach(function(row) {
        _attachRowScrollShadow(row);
    });
    
    // Render a "queued" user bubble at the very end if the user typed a message during
    // streaming. This makes their message visible immediately rather than disappearing
    // until the agent loop flushes it.
    renderQueuedUserBubble(container);

    // Update version sidebar to show user messages list
    updateVersionSidebarVisibility();
    renderVersionSidebar();
    
    // Initialize only NEW widgets (preserved ones already have iframes, so hasChildNodes() is true)
    initializeWidgetsInView();
    renderWidgetSidebar();

    // Initialize display template checklists (update summaries after innerHTML)
    initDisplayChecklists();

    // Restore scroll after the rebuild — single stick-to-bottom mechanism (see
    // 050-streaming.js): sticking users are pinned via the one choke point;
    // everyone else keeps their absolute position.
    // CLAMP-ESCAPE FIX: sticking users need a SYNCHRONOUS same-task pin here,
    // not just the rAF-deferred one. The innerHTML rebuild above runs while
    // the new DOM is momentarily SHORT (live widgets parked on document.body,
    // iframes/images not yet sized) — any forced layout in that window clamps
    // container.scrollTop toward 0, and the content then grows back leaving
    // scrollTop stranded low. Scroll events are dispatched in the rendering
    // steps BEFORE animation-frame callbacks, so with only the rAF pin the
    // coalesced scroll event fires FIRST, at the clamped-low position, with
    // _agLastScrollTop still holding the pre-rebuild value: handleChatScroll
    // misreads it as a user scroll-up (top < last, above bottom), releases
    // stickToBottom, and the rAF pin then refuses to run — the chat is left
    // at the TOP. pinToBottom is a seeding write (sets _agLastScrollTop), so
    // the clamp + pin coalesce into ONE event that lands AT the bottom and
    // keeps the stick; the rAF pin then corrects for any post-layout growth
    // (streaming maxHeight, async widget sizing). This mirrors what the
    // released branch always did synchronously via restoreChatScrollTop.
    if (stickToBottom) {
        pinToBottom(container);
        scrollToBottomIfAllowed();
    } else {
        restoreChatScrollTop(container, savedScrollTop);
    }

    // R1: record what this full render produced so the next render can diff.
    _lastRenderState = { chatId: currentChatId, count: mappedParts.length, sigs: newSigs };

    // The rebuild above minted fresh rc-N rawCopyStore entries for every
    // tool panel / code fence and orphaned the previous render's keys —
    // sweep the orphans now (see gcRawCopyStore in 200-ui-interactions.js
    // for why a sweep, not a reset).
    if (typeof gcRawCopyStore === 'function') gcRawCopyStore();
}

// R3: coalesce per-SSE-chunk streaming updates into at most one DOM update per
// animation frame. The streamDelta handler (036-agent-event-handlers-page.js)
// calls updateStreamingMessage synchronously for EVERY chunk, and the
// content path re-runs full markdown formatting + innerHTML each time — at
// high token rates that starves the main thread. We keep only the LATEST
// args; the rAF callback re-reads current state and drops the update if the
// user navigated away or the message already finalized (the finalize path is
// a full renderMessages() via the 'assistantMessage' event, which stays
// synchronous and never goes through this wrapper — grep-verified: the only
// caller of updateStreamingMessage is the streamDelta handler).
var _usmScheduled = false;
var _usmLatest = null;

function updateStreamingMessage(index, msg, streamingChatId) {
    // DRLM-B1: background-chat deltas must not claim the single latest-args
    // slot — 036's streamDelta handler calls this for ALL chats, and a fast
    // background run could overwrite an unpainted foreground delta (the frame
    // guard would then drop it, leaving the foreground stream stale until the
    // next delta). Mirrors the pre-R3 synchronous no-op for background chats.
    if (streamingChatId && currentChatId !== streamingChatId) return;
    _usmLatest = { index: index, msg: msg, streamingChatId: streamingChatId };
    if (_usmScheduled) return;
    _usmScheduled = true;
    var raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : function(cb) { return setTimeout(cb, 16); };
    raf(function() {
        _usmScheduled = false;
        var a = _usmLatest;
        _usmLatest = null;
        if (!a) return;
        // Re-check state at frame time: chat still current?
        if (a.streamingChatId && currentChatId !== a.streamingChatId) return;
        // REG-F1: a.msg can be a structured clone from the port bridge
        // (045-agent-port-bridge-page.js re-emits postMessage envelopes), and a
        // clone's isStreaming NEVER flips false — so gating on it missed
        // finalize/abort that landed between scheduling and this frame, letting
        // a stale streaming patch dirty the finalized DOM (or a flushed user
        // bubble recycled into the same index). Re-read the LIVE message from
        // the page mirror; fall back to the captured clone only when the
        // mirror lookup fails (same-context emitters, partial mirrors).
        var _f1Chat = (typeof chats !== 'undefined') ? chats[a.streamingChatId || currentChatId] : null;
        var _f1Live = (_f1Chat && _f1Chat.messages) ? _f1Chat.messages[a.index] : null;
        var _f1Msg = _f1Live || a.msg;
        // Still streaming? If the message finalized between scheduling and the
        // frame, the assistantMessage event already did a full render — a late
        // streaming patch would dirty the finalized DOM.
        if (!_f1Msg || _f1Msg.isStreaming !== true) return;
        _updateStreamingMessageNow(a.index, _f1Msg, a.streamingChatId);
    });
}

function _updateStreamingMessageNow(index, msg, streamingChatId) {
    // If we navigated away from the streaming chat, skip DOM updates but let streaming continue
    if (streamingChatId && currentChatId !== streamingChatId) {
        return; // Streaming continues in background, data is saved to correct chat
    }

    // If skills view is open, skip DOM updates (elements are hidden)
    if (currentView === 'skills') {
        return; // Streaming continues in background
    }

    // Skip DOM updates while THIS chat's silent hook runs. Per-chat gate:
    // the old global flag froze the foreground stream whenever ANY
    // background chat ran its hidden hook turn. The guard above already
    // ensures streamingChatId is falsy or === currentChatId, so gating on
    // currentChatId covers the streaming chat.
    if (typeof _isChatInSilentHook === 'function' && _isChatInSilentHook(currentChatId)) return;
    
    var msgEl = document.getElementById('msg-' + index);
    if (!msgEl) {
        // Only re-render if we're still on the same chat
        if (!streamingChatId || currentChatId === streamingChatId) {
            renderMessages();
        }
        return;
    }

    // REG-F2: defense-in-depth — only assistant message nodes may receive
    // streaming markup. After an abort flushes a queued user message into the
    // recycled index, a stale delta would otherwise clobber the user's bubble
    // with thinking/tool-call HTML (and the R1 signature fast path would never
    // repair it, since the message DATA at that index is unchanged).
    if (msgEl.classList && !msgEl.classList.contains('assistant')) return;

    // Optimization: try to do incremental update for tool call arguments during streaming
    // This avoids rebuilding the entire HTML when only the tool args are changing
    if (msg.isStreaming && msg.tool_calls && msg.tool_calls.length > 0) {
        var lastTcIdx = msg.tool_calls.length - 1;
        var lastTc = msg.tool_calls[lastTcIdx];
        var tcKey = 'tc-' + index + '-' + lastTcIdx;
        var existingTcEl = document.getElementById(tcKey);

        // If the tool call element already exists, just update the args text and status message
        if (existingTcEl) {
            var argsEl = existingTcEl.querySelector('.tool-args');
            if (argsEl) {
                var argsText = lastTc.function.arguments || '';
                // Show streaming placeholder if args are empty (API sends args in one chunk at the end)
                if (argsText.length === 0) {
                    argsEl.innerHTML = '<span class="tool-args-streaming">Generating arguments...</span>';
                } else {
                    argsEl.textContent = argsText;
                }

                // Update status message in header if present (extract from partial JSON)
                var streamingStatusMsg = extractStatusMessage(argsText);
                var statusMsgEl = existingTcEl.querySelector('.tool-status-message');
                if (streamingStatusMsg) {
                    if (statusMsgEl) {
                        statusMsgEl.textContent = streamingStatusMsg;
                    } else {
                        // Create status message element if it doesn't exist
                        var summaryEl = existingTcEl.querySelector('summary');
                        if (summaryEl) {
                            var newStatusEl = document.createElement('span');
                            newStatusEl.className = 'tool-status-message';
                            newStatusEl.textContent = streamingStatusMsg;
                            // Insert after tool-name span
                            var toolNameEl = summaryEl.querySelector('.tool-name');
                            if (toolNameEl && toolNameEl.nextSibling) {
                                summaryEl.insertBefore(newStatusEl, toolNameEl.nextSibling);
                            } else {
                                summaryEl.appendChild(newStatusEl);
                            }
                        }
                    }
                }

                // Also update compact mode collapsible header if present.
                // Pick the LAST streaming compact area in the DOM — if a chat ever
                // has multiple streaming blocks (e.g. message-injected mid-tool-call),
                // we want the most recent one, not the first.
                var streamingCompactStatusEls = document.querySelectorAll('.compact-tools-area.streaming .compact-tools-status');
                var compactStatusEl = streamingCompactStatusEls.length ? streamingCompactStatusEls[streamingCompactStatusEls.length - 1] : null;
                if (compactStatusEl && streamingStatusMsg) {
                    compactStatusEl.textContent = streamingStatusMsg;
                }

                scrollToBottomIfAllowed();
                return; // Skip full rebuild
            }
        }
    }

    var html = '';
    var isStreaming = msg.isStreaming === true;
    var hasThinking = msg.thinking && msg.thinking.length > 0;
    var hasContent = msg.content && msg.content.length > 0;
    var hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    
    // In compact mode, do incremental content update to prevent flashing
    if (compactToolCalls) {
        // During streaming in compact mode, try incremental updates to avoid spinner freeze
        if (isStreaming) {
            var compactArea = msgEl.querySelector('.compact-tools-area');

            // If compact area doesn't exist in this message, the compact area is on the
            // first assistant message. This message's div is hidden during streaming.
            // Update streaming text and the first assistant's compact area directly - never call renderMessages().
            if (!compactArea) {
                if (hasContent) {
                    updateStreamingText(msg, index);
                }
                // Update the first assistant's compact area status text directly
                if (hasToolCalls || hasThinking) {
                    // Same scoping rule as above: prefer the LAST streaming compact area.
                    var streamingCompactStatusEls2 = document.querySelectorAll('.compact-tools-area.streaming .compact-tools-status');
                    var compactStatusEl = streamingCompactStatusEls2.length ? streamingCompactStatusEls2[streamingCompactStatusEls2.length - 1] : null;
                    if (compactStatusEl) {
                        var lastTc = hasToolCalls ? msg.tool_calls[msg.tool_calls.length - 1] : null;
                        var statusMsg = lastTc ? (extractStatusMessage(lastTc.function.arguments) || TOOL_DISPLAY_NAMES[lastTc.function.name] || lastTc.function.name) : 'Thinking...';
                        compactStatusEl.textContent = statusMsg;
                    } else {
                        // No compact area spinner yet - need one full rebuild, then incremental
                        renderMessages();
                        return;
                    }
                }
                scrollToBottomIfAllowed();
                return;
            }

            // Handle thinking-only streaming (no tool calls yet)
            if (compactArea && !hasToolCalls) {
                // Update thinking content inside the compact area
                var thinkingEl = compactArea.querySelector('.thinking-content');
                if (hasThinking) {
                    if (thinkingEl) {
                        // Update existing thinking element
                        thinkingEl.textContent = msg.thinking;
                    } else {
                        // Create thinking element if it doesn't exist yet
                        var compactContent = compactArea.querySelector('.compact-tools-content');
                        if (compactContent) {
                            var thinkingKey = index + '-0';
                            var thinkingHtml = '<details class="thinking" data-tl-idx="0" open ontoggle="toggleThinkingState(\'' + thinkingKey + '\', this)">';
                            thinkingHtml += '<summary><span class="thinking-status">Thought process</span></summary>';
                            thinkingHtml += '<div class="thinking-content">' + escapeHtml(msg.thinking) + '</div></details>';
                            compactContent.insertAdjacentHTML('beforeend', thinkingHtml);
                        }
                    }
                }
                // All streaming content goes to #streaming-text
                if (hasContent) {
                    updateStreamingText(msg, index);
                }
                scrollToBottomIfAllowed();
                return; // Skip full rebuild - spinner continues spinning
            }

            // Incremental update: update status text and tool args without rebuilding DOM
            if (compactArea && hasToolCalls) {
                // Also update thinking if present (may continue streaming alongside tool calls)
                if (hasThinking) {
                    var thinkingEl = compactArea.querySelector('.thinking-content');
                    if (thinkingEl) {
                        thinkingEl.textContent = msg.thinking;
                    } else {
                        // Create thinking element if it doesn't exist yet
                        var compactContentForThinking = compactArea.querySelector('.compact-tools-content');
                        if (compactContentForThinking) {
                            var thinkingKey = index + '-0';
                            var thinkingHtml = '<details class="thinking" data-tl-idx="0" open ontoggle="toggleThinkingState(\'' + thinkingKey + '\', this)">';
                            thinkingHtml += '<summary><span class="thinking-status">Thought process</span></summary>';
                            thinkingHtml += '<div class="thinking-content">' + escapeHtml(msg.thinking) + '</div></details>';
                            compactContentForThinking.insertAdjacentHTML('afterbegin', thinkingHtml);
                        }
                    }
                }

                // All streaming content goes to #streaming-text
                if (hasContent) {
                    updateStreamingText(msg, index);
                }

                var lastTc = msg.tool_calls[msg.tool_calls.length - 1];
                var lastTcIdx = msg.tool_calls.length - 1;
                var tcKey = 'tc-' + index + '-' + lastTcIdx;
                var tcEl = document.getElementById(tcKey);

                // Update the collapsible header status
                var statusEl = compactArea.querySelector('.compact-tools-status');
                if (statusEl) {
                    var streamingStatusMsg = extractStatusMessage(lastTc.function.arguments);
                    var newStatus = streamingStatusMsg || TOOL_DISPLAY_NAMES[lastTc.function.name] || lastTc.function.name || 'Processing...';
                    statusEl.textContent = newStatus;
                }

                // If tool call element exists, update its args
                if (tcEl) {
                    var argsEl = tcEl.querySelector('.tool-args');
                    if (argsEl) {
                        var argsText = lastTc.function.arguments || '';
                        if (argsText.length === 0) {
                            argsEl.innerHTML = '<span class="tool-args-streaming">Generating arguments...</span>';
                        } else {
                            argsEl.textContent = argsText;
                        }
                    }

                    // Update status message in tool call header
                    var tcStatusMsg = extractStatusMessage(lastTc.function.arguments);
                    var tcStatusEl = tcEl.querySelector('.tool-status-message');
                    if (tcStatusMsg) {
                        if (tcStatusEl) {
                            tcStatusEl.textContent = tcStatusMsg;
                        } else {
                            var summaryEl = tcEl.querySelector('summary');
                            if (summaryEl) {
                                var newStatusEl = document.createElement('span');
                                newStatusEl.className = 'tool-status-message';
                                newStatusEl.textContent = tcStatusMsg;
                                var toolNameEl = summaryEl.querySelector('.tool-name');
                                if (toolNameEl && toolNameEl.nextSibling) {
                                    summaryEl.insertBefore(newStatusEl, toolNameEl.nextSibling);
                                } else {
                                    summaryEl.appendChild(newStatusEl);
                                }
                            }
                        }
                    }

                    scrollToBottomIfAllowed();
                    return; // Skip full rebuild
                }

                // Tool call element doesn't exist yet - add it incrementally to avoid spinner freeze
                var compactContent = compactArea.querySelector('.compact-tools-content');
                if (compactContent) {
                    var tcStatusMsg = extractStatusMessage(lastTc.function.arguments);
                    var statusMsgHtml = tcStatusMsg ? '<span class="tool-status-message">' + escapeHtml(tcStatusMsg) + '</span>' : '';
                    var newTcHtml = '<details class="tool-call" id="' + tcKey + '" open onclick="toggleToolCallExpanded(' + index + ', ' + lastTcIdx + ', this)">';
                    newTcHtml += '<summary><span class="tool-name">' + getToolIcon(lastTc.function.name) + ' ' + escapeHtml(TOOL_DISPLAY_NAMES[lastTc.function.name] || lastTc.function.name) + '</span>' + statusMsgHtml + '</summary>';
                    newTcHtml += '<div class="tool-args-wrapper">';
                    newTcHtml += '<button class="tool-expand-btn" onclick="toggleToolExpand(this, event)" title="Expand">⤢</button>';
                    var argsText = lastTc.function.arguments || '';
                    if (argsText.length === 0) {
                        newTcHtml += '<pre class="tool-args"><span class="tool-args-streaming">Generating arguments...</span></pre>';
                    } else {
                        newTcHtml += '<pre class="tool-args">' + escapeHtml(argsText) + '</pre>';
                    }
                    newTcHtml += '<button class="tool-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div>';
                    newTcHtml += '</details>';

                    // Insert the new tool call at the end of the content
                    compactContent.insertAdjacentHTML('beforeend', newTcHtml);
                    scrollToBottomIfAllowed();
                    return; // Skip full rebuild
                }

                // compactContent not found - just scroll and return, never rebuild during streaming
                scrollToBottomIfAllowed();
                return;
            }

            // compactArea exists but no tool calls - just return to prevent spinner restart
            scrollToBottomIfAllowed();
            return;
        }
        // Try incremental update for content (non-streaming)
        // During streaming (isRunning), content goes to #streaming-text, not message divs
        if (hasContent && !isRunning) {
            var existingContent = msgEl.querySelector('.message-content');
            if (existingContent) {
                existingContent.innerHTML = formatContent(msg.content);
                scrollToBottomIfAllowed();
                return;
            }
            html += '<div class="message-content">' + formatContent(msg.content) + '</div>';
        }
    } else {
        // Standard mode (non-compact)
        if (msg.thinking || msg.isStreaming) {
            var isCollapsed = msg.thinkingCollapsed === true && !isStreaming;
            var openAttr = isCollapsed ? '' : 'open';
            var statusClass = isStreaming ? 'active' : (isCollapsed ? 'collapsed' : '');
            var statusText;
            if (isStreaming) {
                if (hasThinking) statusText = 'Thinking...';
                else if (hasToolCalls) statusText = 'Preparing tool call...';
                else statusText = 'Waiting for response...';
            } else {
                statusText = isCollapsed ? 'Thought process (click to expand)' : 'Thought process';
            }
            var contentClass = isStreaming ? 'thinking-content streaming' : 'thinking-content';
            var thinkingContent = hasThinking ? escapeHtml(msg.thinking) : (isStreaming && !hasToolCalls ? '<span class="processing-indicator"><span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right: var(--space-4);"></span>Model is processing...</span>' : '');
            var showThinkingIndicator = isStreaming && !hasToolCalls;
            html += '<details class="thinking ' + statusClass + '" ' + openAttr + '>' +
                '<summary><span class="thinking-status">' + statusText + '</span>' +
                (showThinkingIndicator ? '<span class="thinking-indicator"></span>' : '') +
                '</summary>' +
                '<div class="' + contentClass + '">' + thinkingContent + '</div></details>';
        }
        if (msg.content && !msg.isStreaming && !isRunning) {
            html += '<div class="message-content">' + formatContent(msg.content) + '</div>';
        }
        if (msg.content && msg.isStreaming) {
            updateStreamingText(msg, index);
        }
        if (msg.tool_calls) {
            // Standard mode: render each tool call separately
            msg.tool_calls.forEach(function(tc, tcIdx) {
                var tcKey = 'tc-' + index + '-' + tcIdx;
                var tcEl = document.getElementById(tcKey);
                // Check if user explicitly toggled this tool call
                var hasExplicitPref = msg.toolCallsExpanded && msg.toolCallsExpanded.hasOwnProperty(tcIdx);
                var tcOpen;
                if (hasExplicitPref) {
                    // Respect user's explicit choice
                    tcOpen = msg.toolCallsExpanded[tcIdx];
                } else if (tcEl) {
                    // Use current DOM state
                    tcOpen = tcEl.open;
                } else {
                    // Default: open during streaming, closed otherwise
                    tcOpen = msg.isStreaming;
                }
                // Check for full-height expanded state
                var tcFullHeight = msg.toolCallsFullHeight && msg.toolCallsFullHeight[tcIdx];
                var expandedClass = tcFullHeight ? ' expanded' : '';
                
                // Add streaming class to tool call if it's the last one and we're streaming
                var isLastToolCall = tcIdx === msg.tool_calls.length - 1;
                var streamingClass = (msg.isStreaming && isLastToolCall) ? ' streaming' : '';
                html += '<details class="tool-call' + expandedClass + streamingClass + '" id="' + tcKey + '" onclick="toggleToolCallExpanded(' + index + ', ' + tcIdx + ', this)"' + (tcOpen ? ' open' : '') + '>';
                // Extract status message from tool arguments (works with partial JSON during streaming)
                var streamingTcStatusMsg = extractStatusMessage(tc.function.arguments);
                // Add spinner to summary if this tool call is streaming
                var toolSpinner = (msg.isStreaming && isLastToolCall) ? '<span class="tool-streaming-indicator"></span>' : '';
                var statusMsgHtml = streamingTcStatusMsg ? '<span class="tool-status-message">' + escapeHtml(streamingTcStatusMsg) + '</span>' : '';
                html += '<summary><span class="tool-name">' + getToolIcon(tc.function.name) + ' ' + escapeHtml(TOOL_DISPLAY_NAMES[tc.function.name] || tc.function.name) + '</span>' + statusMsgHtml + toolSpinner + '</summary>';
                var argsCopyId = storeRawCopy(tc.function.arguments);
                html += '<div class="tool-args-wrapper" data-copy-id="' + argsCopyId + '">';
                html += '<button class="tool-expand-btn" onclick="toggleToolExpand(this, event)" title="' + (tcFullHeight ? 'Collapse' : 'Expand') + '">' + (tcFullHeight ? '⤡' : '⤢') + '</button>';
                var argsHtml = formatJsonPretty(tc.function.arguments);
                if (window.currentSearchHighlight) {
                    argsHtml = applySearchHighlight(argsHtml, window.currentSearchHighlight);
                }
                html += '<pre class="tool-args' + (tcFullHeight ? ' expanded' : '') + '">' + argsHtml + '</pre>';
                html += '<button class="tool-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div></details>';
            });
        }
    }

    // Preserve scroll position if user has scrolled away - browser may auto-scroll when details elements expand
    var container = document.getElementById('messages');
    var savedScrollTop = (!stickToBottom && container) ? container.scrollTop : null;
    
    msgEl.innerHTML = html;
    
    // Restore scroll position if user had scrolled away (prevents browser auto-scroll on details expansion)
    if (savedScrollTop !== null && container) {
        restoreChatScrollTop(container, savedScrollTop);
    } else if (container && stickToBottom) {
        // CLAMP-ESCAPE: same-task seeding pin for sticking users — the
        // innerHTML swap above can clamp container.scrollTop if the row
        // transiently shrinks; without a seeding write the clamp's scroll
        // event (dispatched before rAF callbacks) is misread as a user
        // scroll-up and releases the stick (see renderMessages' restore).
        pinToBottom(container);
    }
    
    // Set up sticky observers for any expanded tool panels
    msgEl.querySelectorAll('details.tool-call.expanded').forEach(function(details) {
        setupStickyObserver(details);
    });
    
    scrollToBottomIfAllowed();
}

function highlightJS(code) {
    var esc = function(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    var tokens = [];
    var i = 0;
    while (i < code.length) {
        // Single-line comment
        if (code[i] === '/' && code[i+1] === '/') {
            var end = code.indexOf('\n', i);
            if (end === -1) end = code.length;
            tokens.push('<span class="sh-comment">' + esc(code.slice(i, end)) + '</span>');
            i = end;
        }
        // Multi-line comment
        else if (code[i] === '/' && code[i+1] === '*') {
            var end = code.indexOf('*/', i + 2);
            if (end === -1) end = code.length; else end += 2;
            tokens.push('<span class="sh-comment">' + esc(code.slice(i, end)) + '</span>');
            i = end;
        }
        // String (double quote)
        else if (code[i] === '"') {
            var j = i + 1;
            while (j < code.length && code[j] !== '"') { if (code[j] === '\\') j++; j++; }
            tokens.push('<span class="sh-string">' + esc(code.slice(i, j + 1)) + '</span>');
            i = j + 1;
        }
        // String (single quote)
        else if (code[i] === "'") {
            var j = i + 1;
            while (j < code.length && code[j] !== "'") { if (code[j] === '\\') j++; j++; }
            tokens.push('<span class="sh-string">' + esc(code.slice(i, j + 1)) + '</span>');
            i = j + 1;
        }
        // Template literal
        else if (code[i] === '`') {
            var j = i + 1;
            while (j < code.length && code[j] !== '`') { if (code[j] === '\\') j++; j++; }
            tokens.push('<span class="sh-string">' + esc(code.slice(i, j + 1)) + '</span>');
            i = j + 1;
        }
        // Number
        else if (/[0-9]/.test(code[i]) && (i === 0 || !/[a-zA-Z_$]/.test(code[i-1]))) {
            var j = i;
            while (j < code.length && /[0-9.xXa-fA-F]/.test(code[j])) j++;
            tokens.push('<span class="sh-number">' + esc(code.slice(i, j)) + '</span>');
            i = j;
        }
        // Word (keyword, identifier, etc)
        else if (/[a-zA-Z_$]/.test(code[i])) {
            var j = i;
            while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
            var word = code.slice(i, j);
            var keywords = ['var','let','const','function','return','if','else','for','while','do','switch','case','break','continue','new','this','class','extends','import','export','default','try','catch','finally','throw','async','await','yield','typeof','instanceof','in','of','delete','void','null','undefined','true','false'];
            if (keywords.indexOf(word) !== -1) {
                tokens.push('<span class="sh-keyword">' + word + '</span>');
            } else {
                tokens.push(word);
            }
            i = j;
        }
        // Other characters (preserve whitespace and special chars)
        else {
            tokens.push(esc(code[i]));
            i++;
        }
    }
    return tokens.join('');
}

function formatContent(content) {
    // Extract document placeholders BEFORE escaping
    var documentBlocks = [];
    var html = content.replace(/<!--document:(doc_\w+)-->/g, function(match, docId) {
        var rendered = typeof renderDocumentPlaceholder === 'function' ? renderDocumentPlaceholder(docId) : '<div class="sdoc-error">Document: ' + docId + '</div>';
        documentBlocks.push(rendered);
        return '%%DOCUMENT' + (documentBlocks.length - 1) + '%%';
    });

    // Extract display template placeholders BEFORE escaping
    var displayBlocks = [];
    html = html.replace(/<!--display:(dsp_\w+)-->/g, function(match, displayId) {
        var rendered = renderDisplayPlaceholder(displayId);
        displayBlocks.push(rendered);
        return '%%DISPLAY' + (displayBlocks.length - 1) + '%%';
    });

    // Extract code blocks BEFORE escaping
    var codeBlocks = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
        var codeCopyId = storeRawCopy(code);
        var isJS = !lang || lang === 'js' || lang === 'javascript';
        var highlightedCode = isJS ? highlightJS(code) : escapeHtml(code);
        var blockHtml = '<div class="code-block-wrapper" data-copy-id="' + codeCopyId + '">' +
            '<button class="code-block-expand-btn" onclick="toggleCodeBlockExpand(this, event)" title="Expand">⤢</button>' +
            '<pre class="code-block collapsed"><code>' + highlightedCode + '</code></pre>' +
            '<button class="code-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div>';
        codeBlocks.push(blockHtml);
        return '%%CODEBLOCK' + (codeBlocks.length - 1) + '%%';
    });
    
    // Now escape the rest of the HTML
    html = escapeHtml(html);
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Markdown links [text](url) — supports http(s) and chrome-extension:// URLs
    html = html.replace(/\[([^\]]+)\]\(((?:https?|chrome-extension):\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Auto-linkify BARE URLs (http/https) so links are clickable even when the
    // agent did not use markdown link syntax. We first stash any already-formed
    // anchors (from the markdown-link pass above) and inline <code> spans so the
    // autolinker can't nest a link inside an existing <a> or turn a URL that was
    // deliberately shown as inline code into a link. Restored immediately after.
    var _protectedSpans = [];
    html = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<code\b[^>]*>[\s\S]*?<\/code>/g, function(m) {
        _protectedSpans.push(m);
        return '\u0000P' + (_protectedSpans.length - 1) + '\u0000';
    });
    html = html.replace(/\bhttps?:\/\/[^\s<\u0000]+/g, function(url) {
        // Don't swallow trailing sentence punctuation (e.g. "see https://x.com.").
        var trail = '';
        var tm = url.match(/[.,;:!?)\]]+$/);
        if (tm) { trail = tm[0]; url = url.slice(0, url.length - trail.length); }
        return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>' + trail;
    });
    for (var _pi = 0; _pi < _protectedSpans.length; _pi++) {
        (function(span, idx) {
            html = html.replace('\u0000P' + idx + '\u0000', function() { return span; });
        })(_protectedSpans[_pi], _pi);
    }

    // Headers (process in order from most # to fewest)
    html = html.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    
    // Process line by line for tables, lists, and blockquotes
    var lines = html.split('\n');
    var out = [];
    var inTable = false;
    var inList = false;
    var inBlockquote = false;

    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var trimmedLn = ln.trim();

        // Check if this is a list item (starts with - or number.)
        var isListItem = /^- .+/.test(trimmedLn) || /^\d+\. .+/.test(trimmedLn);
        // Check if this is a blockquote line. NOTE: > has already been escaped to &gt; above.
        // Match `&gt;` followed by either whitespace or end-of-line (so a bare `>` line is
        // treated as an empty blockquote paragraph separator).
        var isBlockquote = /^&gt;(\s|$)/.test(trimmedLn);
        // Check next non-empty line for list/blockquote continuation.
        var nextIsListItem = false;
        var nextIsBlockquote = false;
        for (var j = i + 1; j < lines.length; j++) {
            var nextTrimmed = lines[j].trim();
            if (nextTrimmed === '') continue;
            nextIsListItem = /^- .+/.test(nextTrimmed) || /^\d+\. .+/.test(nextTrimmed);
            nextIsBlockquote = /^&gt;(\s|$)/.test(nextTrimmed);
            break;
        }

        if (ln.match(/^\|.+\|$/)) {
            if (inList) { out.push('</ul>'); inList = false; }
            if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
            if (!inTable) {
                while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
                inTable = true;
                out.push('<table class="md-table">');
            }
            if (ln.match(/^\|[\s\-:|]+\|$/)) continue;
            var cells = ln.split('|').slice(1, -1);
            out.push('<tr>' + cells.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>');
        } else if (isBlockquote) {
            if (inTable) { out.push('</table>'); inTable = false; }
            if (inList) { out.push('</ul>'); inList = false; }
            if (!inBlockquote) { out.push('<blockquote class="md-blockquote">'); inBlockquote = true; }
            // Strip the leading `&gt;` plus optional single space; everything after is
            // pushed as a normal line so the paragraph pass below wraps it.
            var bqContent = trimmedLn.replace(/^&gt;\s?/, '');
            out.push(bqContent);
        } else if (isListItem) {
            if (inTable) { out.push('</table>'); inTable = false; }
            if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
            if (!inList) { out.push('<ul>'); inList = true; }
            // Convert to li tag
            var liContent = trimmedLn.replace(/^- /, '').replace(/^\d+\. /, '');
            out.push('<li>' + liContent + '</li>');
        } else if (trimmedLn === '' && inList && nextIsListItem) {
            // Empty line between list items - keep list open
            continue;
        } else if (trimmedLn === '' && inBlockquote && nextIsBlockquote) {
            // Empty line within a blockquote - keep blockquote open and emit
            // an empty line so the paragraph pass starts a new paragraph inside.
            out.push('');
            continue;
        } else if (trimmedLn === '') {
            // Skip empty lines entirely - they cause spacing issues
            continue;
        } else {
            if (inTable) { out.push('</table>'); inTable = false; }
            if (inList) { out.push('</ul>'); inList = false; }
            if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
            out.push(ln);
        }
    }
    if (inTable) out.push('</table>');
    if (inList) out.push('</ul>');
    if (inBlockquote) out.push('</blockquote>');
    
    // Join and clean up - remove newlines between list items
    html = out.join('\n');
    html = html.replace(/<\/li>\s*\n\s*<li>/g, '</li><li>');
    html = html.replace(/<ul>\s*\n\s*<li>/g, '<ul><li>');
    html = html.replace(/<\/li>\s*\n\s*<\/ul>/g, '</li></ul>');
    
    // Process remaining content - group consecutive non-block lines into paragraphs
    var finalLines = html.split('\n');
    var result = [];
    var paragraphBuffer = [];
    
    function flushParagraph() {
        if (paragraphBuffer.length > 0) {
            var content = paragraphBuffer.join('<br>').trim();
            if (content && content !== '<br>') {
                result.push('<span class="md-paragraph">' + content + '</span>');
            }
            paragraphBuffer = [];
        }
    }
    
    for (var i = 0; i < finalLines.length; i++) {
        var line = finalLines[i];
        var trimmed = line.trim();
        
        // Check if this is a block element (including table parts, list items, blockquotes)
        if (trimmed.match(/^<(h[234]|pre|table|tbody|tr|td|th|ul|ol|li|div|blockquote|\/)/) || trimmed.match(/^%%(DOCUMENT|DISPLAY)\d+%%$/)) {
            flushParagraph();
            result.push(trimmed);
        } else if (trimmed === '') {
            // Empty line - flush paragraph if we have content
            if (paragraphBuffer.length > 0) {
                flushParagraph();
            }
        } else {
            paragraphBuffer.push(trimmed);
        }
    }
    flushParagraph();
    
    html = result.join('');
    
    // Aggressive cleanup of spacing issues (BEFORE restoring code blocks)
    html = html.replace(/>\s+</g, '><');
    // Remove empty paragraphs (with optional whitespace/br inside)
    html = html.replace(/<span class="md-paragraph">(\s|<br>)*<\/span>/g, '');
    // Remove multiple consecutive br tags (keep just one if needed)
    html = html.replace(/(<br>\s*){2,}/g, '<br>');
    // Remove anything between closing header and opening table/list/blockquote
    html = html.replace(/(<\/h[234]>)(\s|<br>|<span[^>]*>(\s|<br>)*<\/span>)*(<table|<ul|<ol|<blockquote)/g, '$1$4');
    // Remove br/empty content right before any block element
    html = html.replace(/(\s|<br>|<span class="md-paragraph">(\s|<br>)*<\/span>)+(<table|<ul|<ol|<h[234]|<div|<pre|<blockquote)/g, '$3');
    // Remove br tags right after block elements
    html = html.replace(/(<\/table>|<\/ul>|<\/ol>|<\/h[234]>|<\/div>|<\/pre>|<\/blockquote>)(\s|<br>)+/g, '$1');
    
    // Restore code blocks AFTER cleanup to preserve their whitespace.
    // Function replacement (not a string) so $-patterns ($$, $&, $`, $') in
    // the restored HTML are NOT interpreted by String.replace — same rationale
    // as the protected-span restore above. Safe with `var i` because replace
    // runs synchronously within the same iteration.
    for (var i = 0; i < codeBlocks.length; i++) {
        html = html.replace('%%CODEBLOCK' + i + '%%', function() { return codeBlocks[i]; });
    }

    // Restore display template blocks
    for (var i = 0; i < displayBlocks.length; i++) {
        html = html.replace('%%DISPLAY' + i + '%%', function() { return displayBlocks[i]; });
    }

    // Restore document blocks
    for (var i = 0; i < documentBlocks.length; i++) {
        html = html.replace('%%DOCUMENT' + i + '%%', function() { return documentBlocks[i]; });
    }
    
    // Apply search highlighting if active
    if (window.currentSearchHighlight) {
        html = applySearchHighlight(html, window.currentSearchHighlight);
    }
    
    return html;
}

// Render a transient "queued" user bubble at the bottom of the chat for the message
// the user typed during streaming. The bubble is purely visual — the actual message
// lives in pendingInjectionsByChatId until flushPendingInjection moves it into the
// real chat history. This avoids the previous "message disappears" UX.
function renderQueuedUserBubble(container) {
    if (!container) return;
    // Always remove any previous queued bubble first — idempotent.
    var existing = container.querySelector('.message.user.queued');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    if (!currentChatId) return;
    var entry = pendingInjectionsByChatId[currentChatId];
    if (!entry) return;
    // QUEUE-SYNC-FIX: self-healing retirement of a stale mirror entry. This map
    // entry is page-side optimistic UI; the authoritative copy lives in the SW
    // and is consumed by flushPendingInjection, which broadcasts 'userInjected'
    // so we delete our mirror. If that ONE broadcast is lost or races (SW
    // restart, port blip), nothing else retires the entry and the "Queued"
    // badge re-paints forever. Detect the flush directly instead: if the LAST
    // user message in the mirrored transcript equals the queued text, the
    // injection has landed — retire the bubble. Likewise if the run has ended
    // un-paused (the SW drops un-flushed injections at loop exit), the entry
    // can never flush — it's stale.
    var _qChat = chats[currentChatId];
    if (_qChat && _qChat.messages && entry.text) {
        for (var _qi = _qChat.messages.length - 1; _qi >= 0; _qi--) {
            var _qm = _qChat.messages[_qi];
            if (_qm && _qm.role === 'user' && typeof _qm.content === 'string') {
                if (_qm.content === entry.text) {
                    delete pendingInjectionsByChatId[currentChatId];
                    return;
                }
                break; // only the LAST user message can be the flushed injection
            }
        }
    }
    if (!runningChatIds[currentChatId] && !(typeof pausedChats !== 'undefined' && pausedChats[currentChatId])) {
        // Not running and not paused: a paused chat keeps its SW-side injection
        // (flushed on resume), so its bubble stays. Anything else is a leftover.
        delete pendingInjectionsByChatId[currentChatId];
        return;
    }
    var text = entry.text || '';
    var images = entry.images || [];
    if (!text && (!images || images.length === 0)) return;

    var bubble = document.createElement('div');
    // Styled as a NORMAL user bubble (no "Queued" badge) — the send is
    // effectively instant (interrupt + flush), so the optimistic bubble must
    // be visually indistinguishable from the real message that replaces it.
    // The 'queued' class is kept purely as the selector for the idempotent
    // removal above; it no longer carries any special styling.
    // A queued injection can BE a sub-agent report notice (mid-run notices
    // ride pendingInjectionsByChatId) — give the optimistic bubble the same
    // designed-callout treatment as the flushed row so it doesn't flash
    // plain-blob first (renderSubReportNotices, 175-sub-agent-ui.js).
    var _qNoticeHtml = (text && typeof renderSubReportNotices === 'function') ? renderSubReportNotices(text) : null;
    bubble.className = 'message user queued' + (_qNoticeHtml != null ? ' sub-notice-msg' : '');
    var inner = '<div class="message-content">';
    if (text) {
        inner += (_qNoticeHtml != null) ? _qNoticeHtml
            : '<div class="user-text user-text-md">' + (typeof formatContent === 'function' ? formatContent(text) : escapeHtml(text)) + '</div>';
    }
    if (images && images.length > 0) {
        inner += '<div class="queued-attachments">' + images.length + ' attachment' + (images.length === 1 ? '' : 's') + '</div>';
    }
    inner += '</div>';
    bubble.innerHTML = inner;

    // Append at the very end of the messages container. INT-B2: during
    // streaming the container is [#messages-inner][#streaming-text] and the
    // old target (#messages-inner) put the optimistic bubble ABOVE the live
    // streaming text — so for the whole Enter→userInjected window the
    // pre-interrupt stream appeared visually AFTER the user's new message.
    // Place the bubble AFTER a same-chat #streaming-text instead (true end).
    // Removal stays idempotent — the selector at the top of this function
    // finds it regardless of parent. A foreign-chat streaming el is already
    // dropped by SC-1 before we get here; the dataset check is just defense.
    var _qStreamEl = document.getElementById('streaming-text');
    if (_qStreamEl && _qStreamEl.parentNode === container && _qStreamEl.dataset.chatId === currentChatId) {
        container.insertBefore(bubble, _qStreamEl.nextSibling);
    } else {
        var inner2 = container.querySelector('#messages-inner') || container;
        inner2.appendChild(bubble);
    }
}
