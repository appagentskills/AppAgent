// Clear any existing highlights and collapse other tool panels
function clearToolHighlights() {
    document.querySelectorAll('.highlight-flash').forEach(function(el) {
        el.classList.remove('highlight-flash');
    });
}

// Track tool call expansion state
function toggleToolCallExpanded(msgIndex, tcIdx, details) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages[msgIndex]) return;
    var msg = chat.messages[msgIndex];
    if (!msg.toolCallsExpanded) msg.toolCallsExpanded = {};
    // onclick may fire before browser toggle - use opposite of PREVIOUS stored state
    var wasOpen = msg.toolCallsExpanded.hasOwnProperty(tcIdx) ? msg.toolCallsExpanded[tcIdx] : !details.open;
    msg.toolCallsExpanded[tcIdx] = !wasOpen;
}

// Track tool result expansion state
function toggleToolResultExpanded(msgIndex, details) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages[msgIndex]) return;
    // onclick may fire before browser toggle - use opposite of PREVIOUS stored state
    var wasOpen = chat.messages[msgIndex].expanded === true;
    chat.messages[msgIndex].expanded = !wasOpen;
}

// Track compact area expansion state during streaming (persists in memory only).
// B2: scope by currentChatId — handler fires from a DOM rendered for the
// foreground chat, so currentChatId IS the message's chat.
function toggleCompactAreaState(msgIndex, details) {
    var key = (currentChatId || '_') + ':' + msgIndex;
    compactAreaExpandedState[key] = details.open;
}

// Track thinking section expansion state during streaming (persists in memory only).
// B2: scope by currentChatId.
function toggleThinkingState(key, details) {
    var fullKey = (currentChatId || '_') + ':' + key;
    thinkingExpandedState[fullKey] = details.open;
}

// Toggle the expanded state of a cached (long) user message.
// B2: scope by currentChatId.
function toggleUserMsgExpanded(msgIndex) {
    var key = (currentChatId || '_') + ':' + msgIndex;
    userMsgExpandedState[key] = !userMsgExpandedState[key];
    if (typeof renderMessages === 'function') renderMessages();
}

// Collapse all tool panels except the target
function collapseOtherTools(targetEl, container) {
    var scope = container || document;
    scope.querySelectorAll('details.tool-call[open], details.tool-result[open]').forEach(function(el) {
        if (el !== targetEl) el.open = false;
    });
}

// Scroll to tool calls in a response block (from userMsgIdx to next user message)
function scrollToToolInResponse(userMsgIdx) {
    var chat = chats[currentChatId];
    if (!chat) return;
    
    clearToolHighlights();

    var container = document.getElementById('messages');
    if (!container) return;
    
    // Find next user message index
    var nextUserIdx = chat.messages.length;
    for (var i = userMsgIdx + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserIdx = i;
            break;
        }
    }
    
    // Find first assistant message with tool_calls in this range
    for (var j = userMsgIdx + 1; j < nextUserIdx; j++) {
        var msg = chat.messages[j];
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            var msgEl = isOverlayMode ? container.querySelector('.message.assistant:nth-child(' + (j + 1) + ')') : document.getElementById('msg-' + j);
            if (!msgEl && isOverlayMode) {
                // In overlay, find by searching all assistant messages
                var allMsgs = container.querySelectorAll('.message');
                if (allMsgs[j]) msgEl = allMsgs[j];
            }
            if (msgEl) {
                var toolCalls = msgEl.querySelectorAll('details.tool-call, details.tool-result');
                if (toolCalls.length > 0) {
                    collapseOtherTools(toolCalls[0], container);
                    toolCalls[0].open = true;
                    toolCalls[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    toolCalls[0].classList.add('highlight-flash');
                    setTimeout(function() { toolCalls[0].classList.remove('highlight-flash'); }, 2000);
                    return;
                }
            }
        }
    }
    
    // Fallback: search container for any tool-call or tool-result elements
    var allToolCalls = container.querySelectorAll('details.tool-call, details.tool-result');
    if (allToolCalls.length > 0) {
        var lastToolCall = allToolCalls[allToolCalls.length - 1];
        collapseOtherTools(lastToolCall, container);
        lastToolCall.open = true;
        lastToolCall.scrollIntoView({ behavior: 'smooth', block: 'center' });
        lastToolCall.classList.add('highlight-flash');
        setTimeout(function() { lastToolCall.classList.remove('highlight-flash'); }, 2000);
    }
}

// Scroll to first tool call in a specific message (for sidebar clicks)
function scrollToFirstToolCall(msgIdx) {
    if (msgIdx < 0) return;
    var chat = chats[currentChatId];
    if (!chat) return;
    
    clearToolHighlights();
    
    // Try the given index first
    var msgEl = document.getElementById('msg-' + msgIdx);
    if (msgEl) {
        var toolCalls = msgEl.querySelectorAll('details.tool-call, details.tool-result');
        if (toolCalls.length > 0) {
            collapseOtherTools(toolCalls[0]);
            toolCalls[0].open = true;
            toolCalls[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            toolCalls[0].classList.add('highlight-flash');
            setTimeout(function() { toolCalls[0].classList.remove('highlight-flash'); }, 2000);
            return;
        }
    }
    
    // Fallback: search nearby messages (msgIdx might point to approval message)
    // Search backwards and forwards a few messages to find tool calls
    for (var offset = 1; offset <= 3; offset++) {
        // Try before
        if (msgIdx - offset >= 0) {
            var prevEl = document.getElementById('msg-' + (msgIdx - offset));
            if (prevEl) {
                var prevTcs = prevEl.querySelectorAll('details.tool-call, details.tool-result');
                if (prevTcs.length > 0) {
                    collapseOtherTools(prevTcs[0]);
                    prevTcs[0].open = true;
                    prevTcs[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    prevTcs[0].classList.add('highlight-flash');
                    setTimeout(function() { prevTcs[0].classList.remove('highlight-flash'); }, 2000);
                    return;
                }
            }
        }
    }
    
    // Last fallback: scroll to original message
    if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgEl.classList.add('highlight-flash');
        setTimeout(function() { msgEl.classList.remove('highlight-flash'); }, 2000);
    }
}

function scrollToBottom() {
    var container = document.getElementById('messages');
    if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    }
}

function toggleFileChanges(fileKey) {
    var el = document.getElementById('changes-' + fileKey);
    if (!el) return;
    var isExpanded = el.style.display !== 'none';
    el.style.display = isExpanded ? 'none' : 'block';
    // Update expand icon
    var icon = document.getElementById('icon-' + fileKey);
    if (icon) {
        icon.textContent = isExpanded ? '\u25b6' : '\u25bc';
    }
}

var versionSidebarManuallyHidden = false;

function loadVersionSidebarState() {
    var saved = appStorage.getItem('versionSidebarHidden');
    // Default to open (false) if not set
    versionSidebarManuallyHidden = saved === 'true';
}

function saveVersionSidebarState() {
    appStorage.setItem('versionSidebarHidden', versionSidebarManuallyHidden ? 'true' : 'false');
}

function updateVersionSidebarVisibility() {
    var sidebar = document.getElementById('version-sidebar');
    var openBtn = document.getElementById('version-sidebar-open');
    if (!sidebar) return;
    
    // Always show sidebar based on user preference, regardless of content
    if (!versionSidebarManuallyHidden) {
        sidebar.classList.add('visible');
        if (openBtn) openBtn.classList.remove('visible');
    } else {
        sidebar.classList.remove('visible');
        if (openBtn) openBtn.classList.add('visible');
    }
}

function closeVersionSidebar() {
    versionSidebarManuallyHidden = true;
    saveVersionSidebarState();
    updateVersionSidebarVisibility();
    resizeAllWidgets();
}

function openVersionSidebar() {
    versionSidebarManuallyHidden = false;
    saveVersionSidebarState();
    updateVersionSidebarVisibility();
    resizeAllWidgets();
}

// Render user messages list for navigation
function renderUserMessagesList() {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages) return '';

    var userMessages = [];
    chat.messages.forEach(function(msg, idx) {
        // Skip hook messages (like auto-title) unless showHookMessages is enabled
        if (msg.role === 'user' && !(msg.isHookMessage && !hooksEnabled.showHookMessages)) {
            userMessages.push({ index: idx, content: msg.content });
        }
    });
    
    if (userMessages.length === 0) return '';
    
    var html = '<div class="user-messages-section">';
    html += '<div class="user-messages-header">Your Messages (' + userMessages.length + ')</div>';
    html += '<div class="user-messages-list">';
    
    userMessages.forEach(function(msg, i) {
        var preview = msg.content.substring(0, 60) + (msg.content.length > 60 ? '...' : '');
        html += '<div class="user-message-item" onclick="scrollToMessage(' + msg.index + ')" title="' + escapeHtml(msg.content.substring(0, 200)) + '">';
        html += '<span class="user-message-num">' + (i + 1) + '</span>';
        html += '<span class="user-message-preview">' + escapeHtml(preview) + '</span>';
        html += '</div>';
    });
    
    html += '</div>';
    html += '<button class="scroll-to-bottom-btn" onclick="scrollToBottom()"><span class="btn-icon">' + UI_ICONS.chevronDown + '</span>Scroll to Bottom</button>';
    html += '</div>';
    return html;
}

function getLastBrowserUrl() {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages) return null;
    
    var lastUrl = null;
    // Check browser_context messages and tool calls for iframe_tool navigate
    chat.messages.forEach(function(msg) {
        if (msg.role === 'browser_context' && msg.url) {
            lastUrl = msg.url;
        }
        // Also check tool calls for iframe_tool navigate actions
        if (msg.tool_calls) {
            msg.tool_calls.forEach(function(tc) {
                if (tc.function && tc.function.name === 'iframe_tool') {
                    try {
                        var args = JSON.parse(tc.function.arguments);
                        if (args.action === 'navigate' && args.url) {
                            lastUrl = args.url;
                        }
                    } catch (e) {
                        // Ignore JSON parse errors for malformed tool call arguments
                    }
                }
            });
        }
    });
    return lastUrl;
}

function reopenBrowser() {
    var url = getLastBrowserUrl();
    if (url) {
        openIframePanel();
        navigateIframe(url);
    }
}

// Collect PRs pushed from this chat (workspace push tool calls + their results).
// Returns [{url, number, title, branch}] deduped by URL. A later push to the
// same PR (append) replaces the tracked entry, but only overwrites the title
// when the later push actually passed a pr_title (it is optional on append).
function getPushedPRsForChat(chat) {
    if (!chat || !chat.messages) return [];
    var pushArgs = {}; // tool_call_id -> { title, branch }
    var prs = [];
    var byUrl = {};
    chat.messages.forEach(function(msg) {
        if (msg.role === 'assistant' && msg.tool_calls) {
            msg.tool_calls.forEach(function(tc) {
                if (tc.function && tc.function.name === 'workspace') {
                    try {
                        var a = JSON.parse(tc.function.arguments);
                        if (a.action === 'push') pushArgs[tc.id] = { title: a.pr_title || '', branch: a.branch_name || '' };
                    } catch (e) { /* malformed args — skip */ }
                }
            });
        }
        if (msg.role === 'tool' && msg.tool_call_id && pushArgs[msg.tool_call_id] && msg.content) {
            var r = null;
            try { r = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content; } catch (e) { /* not JSON — skip */ }
            if (r && r.success && r.pr_url) {
                var args = pushArgs[msg.tool_call_id];
                var entry = {
                    url: r.pr_url,
                    number: r.pr_number,
                    title: args.title,
                    branch: r.branch || args.branch || ''
                };
                if (byUrl[entry.url] !== undefined) {
                    var prev = prs[byUrl[entry.url]];
                    if (!entry.title) entry.title = prev.title; // append without pr_title keeps prior title
                    prs[byUrl[entry.url]] = entry;
                } else {
                    byUrl[entry.url] = prs.length;
                    prs.push(entry);
                }
            }
        }
    });
    // Fallback title when no pr_title was ever passed
    prs.forEach(function(pr) { if (!pr.title) pr.title = pr.branch || ('PR #' + pr.number); });
    return prs;
}

function renderVersionSidebar() {
    var container = document.getElementById('version-history-list');
    if (!container) return;
    
    var changedFiles = getAllChangedFiles();
    var revertedFiles = getRevertedFiles();
    var userMessagesHtml = renderUserMessagesList();
    var lastBrowserUrl = getLastBrowserUrl();
    var actionUpdatesHtml = (typeof renderActionUpdatesSection === 'function') ? renderActionUpdatesSection(chats[currentChatId]) : '';
    
    var html = '<div class="version-sidebar-content">';
    
    // Action Updates Section — shown above everything else so the PM sees
    // background Action progress/results at a glance. Empty string when the
    // chat has no update_action_state calls.
    if (actionUpdatesHtml) {
        html += '<div class="version-action-updates-section">' + actionUpdatesHtml + '</div>';
    }
    
    // Actions Section - Group all action buttons together
    var hasActions = lastBrowserUrl || changedFiles.length > 0;
    if (hasActions) {
        html += '<div class="version-actions-section">';
        html += '<div class="version-section-title">Actions</div>';
        html += '<div class="version-actions-list">';
        
        // Open Browser button
        if (lastBrowserUrl) {
            html += '<button class="version-action-btn" onclick="reopenBrowser()" title="' + escapeHtml(lastBrowserUrl) + '">';
            html += '<span class="action-icon">' + UI_ICONS.globe + '</span>Open Browser';
            html += '</button>';
        }
        
        // Download XML button
        if (changedFiles.length > 0) {
            html += '<button class="version-action-btn" onclick="downloadChangesXml()" title="Export all changes as one XML file">';
            html += '<span class="action-icon">' + UI_ICONS.download + '</span>Download All';
            html += '</button>';
            
            // Revert All button
            html += '<button class="version-action-btn danger" onclick="revertAllChanges()">';
            html += '<span class="action-icon">' + UI_ICONS.undo + '</span>Revert All';
            html += '</button>';
            html += '<div class="version-action-hint">' + changedFiles.length + ' file' + (changedFiles.length > 1 ? 's' : '') + ' changed</div>';
        }
        
        html += '</div>';
        html += '</div>';
    }
    
    // Pull Requests Section — PRs pushed from this chat via workspace push.
    // Derived from the chat's tool calls/results, so it works retroactively
    // for existing chats with no extra persistence.
    var pushedPRs = getPushedPRsForChat(chats[currentChatId]);
    if (pushedPRs.length > 0) {
        html += '<div class="version-prs-section">';
        html += '<div class="version-section-title">' + UI_ICONS.gitBranch + ' Pull Requests (' + pushedPRs.length + ')</div>';
        html += '<div class="pr-sidebar-list">';
        pushedPRs.forEach(function(pr) {
            html += '<a class="pr-sidebar-item" href="' + escapeHtml(pr.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(pr.url) + '">';
            html += '<span class="pr-sidebar-icon">' + UI_ICONS.gitBranch + '</span>';
            html += '<span class="pr-sidebar-info">';
            html += '<span class="pr-sidebar-title">' + escapeHtml(pr.title) + '</span>';
            html += '<span class="pr-sidebar-meta">#' + escapeHtml(String(pr.number)) + (pr.branch ? ' \u00b7 ' + escapeHtml(pr.branch) : '') + '</span>';
            html += '</span>';
            html += '<span class="pr-sidebar-open">' + UI_ICONS.externalLink + '</span>';
            html += '</a>';
        });
        html += '</div>';
        html += '</div>';
    }
    
    // Widgets Section
    var widgets = getWidgetsForChat(currentChatId);
    if (widgets.length > 0) {
        html += '<div class="version-widgets-section">';
        html += '<div class="version-section-title">' + UI_ICONS.widget + ' Widgets (' + widgets.length + ')</div>';
        html += '<div id="widget-sidebar-list" class="widget-sidebar-list">';
        widgets.forEach(function(widget) {
            var isOnDashboard = dashboardWidgets && dashboardWidgets[widget.id];
            var dashboardBtnClass = isOnDashboard ? 'widget-sidebar-btn on-dashboard' : 'widget-sidebar-btn';
            var dashboardBtnTitle = isOnDashboard ? 'Remove from Dashboard' : 'Add to Dashboard';
            var dashboardBtnIcon = isOnDashboard ? UI_ICONS.pinFilled : UI_ICONS.pin;
            html += '<div class="widget-sidebar-item" onclick="scrollToWidget(\'' + widget.id + '\')">' +
                '<span class="widget-sidebar-icon">' + UI_ICONS.widget + '</span>' +
                '<span class="widget-sidebar-title">' + escapeHtml(widget.title) + '</span>' +
                '<div class="widget-sidebar-actions">' +
                '<button class="widget-sidebar-btn" onclick="event.stopPropagation();showWidgetInPanel(\'' + widget.id + '\')" title="Show in Panel">' + UI_ICONS.panelRight + '</button>' +
                '<button class="' + dashboardBtnClass + '" onclick="event.stopPropagation();toggleWidgetOnDashboard(\'' + widget.id + '\')" title="' + dashboardBtnTitle + '">' + dashboardBtnIcon + '</button>' +
                '<button class="widget-sidebar-btn" onclick="event.stopPropagation();openWidgetFullscreen(\'' + widget.id + '\')" title="Fullscreen">' + UI_ICONS.maximize + '</button>' +
                '</div>' +
            '</div>';
        });
        html += '</div>';
        html += '</div>';
    } else {
        html += '<div id="widget-sidebar-list" style="display:none;"></div>';
    }

    // Screenshots & PDFs Section
    var chat = chats[currentChatId];
    var screenshots = [];
    var pdfAttachments = [];
    var fileAttachments = [];
    if (chat && chat.messages) {
        chat.messages.forEach(function(msg, idx) {
            if (msg.role === 'screenshot') {
                screenshots.push({ msg: msg, idx: idx });
            } else if (msg.role === 'pdf') {
                pdfAttachments.push({ msg: msg, idx: idx });
            } else if (msg.role === 'file') {
                fileAttachments.push({ msg: msg, idx: idx });
            }
        });
    }
    if (screenshots.length > 0 || pdfAttachments.length > 0 || fileAttachments.length > 0) {
        html += '<div class="version-screenshots-section">';
        var attachTotalCount = screenshots.length + pdfAttachments.length + fileAttachments.length;
        html += '<div class="version-section-title">' + UI_ICONS.eye + ' Attachments (' + attachTotalCount + ')</div>';
        html += '<div class="screenshot-sidebar-list">';
        screenshots.forEach(function(item, i) {
            var screenshot = item.msg;
            var screenshotName = screenshot.name || screenshot.description || ('Screenshot ' + (i + 1));
            html += '<div class="screenshot-sidebar-item" onclick="scrollToMessage(' + item.idx + ')">' +
                '<img class="screenshot-sidebar-thumb" src="' + screenshot.base64 + '" alt="' + escapeHtml(screenshotName) + '" onclick="event.stopPropagation();openScreenshotModal(this.src, \'' + escapeJsString(screenshotName) + '\')" />' +
                '<div class="screenshot-sidebar-info">' +
                '<span class="screenshot-sidebar-title">' + escapeHtml(screenshotName) + '</span>' +
                '<span class="screenshot-sidebar-size">' + screenshot.width + '×' + screenshot.height + '</span>' +
                '</div>' +
                '<button class="screenshot-sidebar-btn" onclick="event.stopPropagation();downloadScreenshotFromSidebar(\'' + i + '\')" title="Download">' + UI_ICONS.download + '</button>' +
            '</div>';
        });
        pdfAttachments.forEach(function(item, i) {
            var pdfMsg = item.msg;
            var pdfName = pdfMsg.name || pdfMsg.description || ('Document ' + (i + 1));
            html += '<div class="screenshot-sidebar-item" onclick="scrollToMessage(' + item.idx + ')">' +
                '<div class="screenshot-sidebar-thumb pdf-sidebar-thumb" onclick="event.stopPropagation();openPdfFromMessage(' + item.idx + ')">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
                '</div>' +
                '<div class="screenshot-sidebar-info">' +
                '<span class="screenshot-sidebar-title">' + escapeHtml(pdfName) + '</span>' +
                '<span class="screenshot-sidebar-size">PDF</span>' +
                '</div>' +
                '<button class="screenshot-sidebar-btn" onclick="event.stopPropagation();downloadPdfFromSidebar(' + i + ')" title="Download">' + UI_ICONS.download + '</button>' +
            '</div>';
        });
        fileAttachments.forEach(function(item, i) {
            var fileMsg = item.msg;
            var fileName = fileMsg.name || ('File ' + (i + 1));
            var fileExt = fileName.split('.').pop().toUpperCase();
            var fileSize = fileMsg.size ? formatFileSize(fileMsg.size) : '';
            html += '<div class="screenshot-sidebar-item" onclick="scrollToMessage(' + item.idx + ')">' +
                '<div class="screenshot-sidebar-thumb" style="background:var(--secondary-lighter);border:1px solid var(--secondary-border);color:var(--success);display:flex;align-items:center;justify-content:center;cursor:pointer;" onclick="event.stopPropagation();openFileFromMessage(' + item.idx + ')">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
                '</div>' +
                '<div class="screenshot-sidebar-info">' +
                '<span class="screenshot-sidebar-title">' + escapeHtml(fileName) + '</span>' +
                '<span class="screenshot-sidebar-size">' + fileExt + (fileSize ? ' · ' + fileSize : '') + '</span>' +
                '</div>' +
                '<button class="screenshot-sidebar-btn" onclick="event.stopPropagation();downloadFileFromSidebar(' + i + ')" title="Download">' + UI_ICONS.download + '</button>' +
            '</div>';
        });
        html += '</div>';
        html += '</div>';
    }

    // Show active changes section
    if (changedFiles.length > 0) {
        // Workspace Artifacts header
        html += '<div class="version-artifacts-header">Artifacts' + (changedFiles.length === 1 ? '' : ' (' + changedFiles.length + ')') + '</div>';

        // List each changed file with icon buttons
        html += '<div class="version-files-list">';
        changedFiles.forEach(function(file, fileIdx) {
            var isNew = file.changes.some(function(c) { return c.action === 'POST'; });
            var hasEdit = file.changes.some(function(c) { return c.action === 'PUT' || c.action === 'PATCH'; });
            var changeCount = file.changes.length;

            var firstBeforeVersion = getFirstVersionForRecord(file.table, file.sysId);
            var tableIcon = getTableIcon(file.table);
            var tableDisplayName = getTableDisplayName(file.table);
            var statusBadge = isNew ? '<span class="sn-status-badge sn-status-new">NEW</span>' : (hasEdit ? '<span class="sn-status-badge sn-status-modified">MODIFIED</span>' : '');
            var changesBadge = changeCount > 1 ? '<span class="sn-changes-badge">' + changeCount + ' changes</span>' : '';

            // Escape values for JS
            var jsTable = escapeJsString(file.table);
            var jsSysId = escapeJsString(file.sysId);
            var jsDisplayName = escapeJsString(file.displayName);

            html += '<div class="sn-artifact-card sidebar-card">';
            html += '<div class="sn-artifact-icon sn-icon-' + file.table.replace(/_/g, '-') + '">' + tableIcon + '</div>';
            html += '<div class="sn-artifact-content">';
            html += '<div class="sn-artifact-name">' + escapeHtml(file.displayName) + '</div>';
            html += '<div class="sn-artifact-meta">(' + tableDisplayName + ') ' + statusBadge + changesBadge + '</div>';
            html += '</div>';
            html += '<div class="sn-artifact-actions-row">';
            // View diff button
            html += '<button class="sn-artifact-icon-btn" onclick="openDiffViewer(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="View changes">' + UI_ICONS.eye + '</button>';
            // Download button
            html += '<button class="sn-artifact-icon-btn" onclick="downloadSingleFile(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="Download XML">' + UI_ICONS.download + '</button>';
            // Open in browser for UI pages
            if (file.table === 'sys_ui_page') {
                html += '<button class="sn-artifact-icon-btn" onclick="openUIPageInBrowser(\'' + jsDisplayName + '\')" title="Open in Browser">' + UI_ICONS.globe + '</button>';
                html += '<button class="sn-artifact-icon-btn" onclick="screenshotUIPage(\'' + jsDisplayName + '\')" title="Screenshot">' + UI_ICONS.camera + '</button>';
            }
            // Revert button (or delete for new files)
            if (isNew) {
                html += '<button class="sn-artifact-icon-btn danger" onclick="deleteNewRecordFromSidebar(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="Delete">' + UI_ICONS.trash + '</button>';
            } else if (firstBeforeVersion) {
                html += '<button class="sn-artifact-icon-btn" onclick="revertFileToBeforeChat(\'' + firstBeforeVersion + '\', \'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="Revert">' + UI_ICONS.undo + '</button>';
            }
            html += '</div>';
            html += '</div>';
        });
        html += '</div>';
    }
    
    // Documents Section (only documents referenced in current chat)
    var chatDocIds = {};
    if (chat && chat.messages) {
        chat.messages.forEach(function(msg) {
            var txt = '';
            if (msg.content) txt = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            var dre = /<!--document:(doc_\w+)-->/g;
            var dm;
            while ((dm = dre.exec(txt)) !== null) chatDocIds[dm[1]] = true;
            if (msg.tool_calls) msg.tool_calls.forEach(function(tc) {
                if (tc.function && tc.function.name === 'document') {
                    try { var a = JSON.parse(tc.function.arguments); if (a.doc_id) chatDocIds[a.doc_id] = true; } catch(e) {}
                }
            });
            if (msg.role === 'tool' && msg.content) {
                try { var r = JSON.parse(msg.content); if (r.doc_id) chatDocIds[r.doc_id] = true; } catch(e) {}
            }
        });
    }
    var chatDocs = Object.keys(chatDocIds).map(function(id) { return smartDocuments[id]; }).filter(Boolean);
    if (chatDocs.length > 0) {
        chatDocs.sort(function(a, b) { return b.updatedAt - a.updatedAt; });
        html += '<div class="version-documents-section">';
        html += '<div class="version-section-title">' + UI_ICONS.file + ' Documents (' + chatDocs.length + ')</div>';
        html += '<div class="documents-sidebar-list">';
        chatDocs.forEach(function(doc) {
            html += '<div class="sdoc-sidebar-item" onclick="sdocOpenPreview(\'' + escapeJsString(doc.id) + '\')" title="' + escapeHtml(doc.title) + '">';
            html += '<span class="sdoc-sidebar-icon">' + UI_ICONS.file + '</span>';
            html += '<span class="sdoc-sidebar-name">' + escapeHtml(doc.title) + '</span>';
            html += '<span class="sdoc-sidebar-ver">v' + doc.currentVersion + '</span>';
            html += '</div>';
        });
        html += '</div>';
        html += '</div>';
    }

    html += '</div>'; // end version-sidebar-content
    
    // Show user messages list at the bottom (always, using flexbox to push to bottom)
    if (userMessagesHtml) {
        html += userMessagesHtml;
    }
    
    container.innerHTML = html;
}

// Redo changes that were previously reverted
async function redoFileChanges(versionSysId, table, sysId, displayName) {
    if (!await showConfirmModal('Redo Changes', 'Redo changes to "' + displayName + '"? This will restore the AI-made changes.')) return;
    
    try {
        showSpinner('Restoring ' + displayName + '...');
        
        var xml = await getVersionXml(versionSysId);
        if (!xml) {
            hideSpinner();
            showSnackbar('Could not get version data', 'error');
            return;
        }

        var result = await uploadXml(xml, table, sysId);
        hideSpinner();

        if (result.success) {
            // Un-invalidate the original changes
            versionHistory.forEach(function(v, idx) {
                if (v.table === table && v.sysId === sysId && v.chatId === currentChatId && v.action !== 'REVERT') {
                    versionHistory[idx].invalidated = false;
                }
            });

            // Remove the revert entry (or mark it as undone)
            versionHistory = versionHistory.filter(function(v) {
                return !(v.table === table && v.sysId === sysId && v.chatId === currentChatId && v.action === 'REVERT');
            });

            saveVersionHistory();
            renderVersionSidebar();
            renderMessages();

            showSnackbar('Successfully restored "' + displayName + '"', 'success');
        } else {
            showSnackbar('Redo failed: ' + result.error, 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar('Redo failed: ' + e.message, 'error');
    }
}

// Redo all reverted changes
async function redoAllChanges() {
    var revertedFiles = getRevertedFiles();
    if (revertedFiles.length === 0) {
        showSnackbar('No reverted changes to redo', 'warning');
        return;
    }
    
    if (!await showConfirmModal('Redo All', 'Redo all ' + revertedFiles.length + ' reverted file(s)? This will restore all AI-made changes.')) return;
    
    showSpinner('Restoring ' + revertedFiles.length + ' files...');
    var successCount = 0;
    var errors = [];
    
    for (var i = 0; i < revertedFiles.length; i++) {
        var file = revertedFiles[i];
        try {
            var latestAfterVersion = getLatestAfterVersion(file.table, file.sysId);
            if (!latestAfterVersion) {
                errors.push(file.displayName + ': No version to restore');
                continue;
            }
            
            var xml = await getVersionXml(latestAfterVersion);
            if (!xml) {
                errors.push(file.displayName + ': Could not get version data');
                continue;
            }
            
            var result = await uploadXml(xml, file.table, file.sysId);
            if (result.success) {
                successCount++;
                // Un-invalidate entries for this file
                versionHistory.forEach(function(v, idx) {
                    if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId && v.action !== 'REVERT') {
                        versionHistory[idx].invalidated = false;
                    }
                });
                // Remove revert entries for this file
                versionHistory = versionHistory.filter(function(v) {
                    return !(v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId && v.action === 'REVERT');
                });
            } else {
                errors.push(file.displayName + ': ' + result.error);
            }
        } catch (e) {
            errors.push(file.displayName + ': ' + e.message);
        }
    }
    
    hideSpinner();
    saveVersionHistory();
    renderVersionSidebar();
    renderMessages();
    
    if (errors.length > 0) {
        showSnackbar('Restored ' + successCount + ' of ' + revertedFiles.length + ' files.\n\nErrors:\n' + errors.join('\n'), 'warning');
    } else {
        showSnackbar('Successfully restored ' + successCount + ' files', 'success');
    }
}

// Revert a single file to its state before this chat
async function revertFileToBeforeChat(versionSysId, table, sysId, displayName) {
    if (!await showConfirmModal('Undo All Changes', 'Undo all changes to "' + displayName + '"? This will restore the file to how it was before this chat session.')) return;
    
    try {
        showSpinner('Reverting ' + displayName + '...');
        
        var xml = await getVersionXml(versionSysId);
        if (!xml) {
            hideSpinner();
            showSnackbar('Could not get version data', 'error');
            return;
        }
        
        var result = await uploadXml(xml, table, sysId);
        hideSpinner();
        
        if (result.success) {
            // Mark all entries for this file as invalidated
            versionHistory.forEach(function(v, idx) {
                if (v.table === table && v.sysId === sysId && v.chatId === currentChatId) {
                    versionHistory[idx].invalidated = true;
                }
            });
            
            // Add revert entry
            addVersionHistoryEntry({
                id: 'vh_' + Date.now(),
                chatId: currentChatId,
                timestamp: Date.now(),
                table: table,
                sysId: sysId,
                displayName: displayName,
                action: 'REVERT',
                messageIndex: -1,
                afterVersion: versionSysId
            });
            
            showSnackbar('Successfully reverted "' + displayName + '"', 'success');
        } else {
            showSnackbar('Revert failed: ' + result.error, 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar('Revert failed: ' + e.message, 'error');
    }
}

// Revert all changes in this chat
async function revertAllChanges() {
    var changedFiles = getAllChangedFiles();
    if (changedFiles.length === 0) {
        showSnackbar('No changes to revert', 'warning');
        return;
    }
    
    var fileNames = changedFiles.map(function(f) { return f.displayName; }).join(', ');
    if (!await showConfirmModal('Undo All Changes', 'Undo ALL changes made in this chat? This will revert: ' + changedFiles.map(function(f) { return f.displayName; }).join(', ') + '. You can always redo these changes later.')) return;
    
    var successCount = 0;
    var failCount = 0;
    
    showSpinner('Reverting all changes...');
    
    for (var i = 0; i < changedFiles.length; i++) {
        var file = changedFiles[i];
        var isNew = file.changes.some(function(c) { return c.action === 'POST'; });
        var firstBeforeVersion = getFirstVersionForRecord(file.table, file.sysId);
        
        try {
            if (isNew) {
                // New files need to be deleted, not reverted
                var recordScope = await getRecordScope(file.table, file.sysId);
                var deleteUrl = '/api/now/table/' + file.table + '/' + file.sysId;
                if (recordScope) {
                    deleteUrl += '?sysparm_record_scope=' + encodeURIComponent(recordScope);
                }
                
                var res = await fetch(deleteUrl, {
                    method: 'DELETE',
                    headers: {
                        'X-UserToken': window.sessionToken,
                        'Accept': 'application/json'
                    }
                });
                
                if (res.ok || res.status === 204) {
                    versionHistory.forEach(function(v, idx) {
                        if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId) {
                            versionHistory[idx].invalidated = true;
                        }
                    });
                    successCount++;
                } else {
                    failCount++;
                }
            } else if (firstBeforeVersion) {
                // Existing files get reverted to before version
                var xml = await getVersionXml(firstBeforeVersion);
                if (!xml) {
                    failCount++;
                    continue;
                }
                
                var result = await uploadXml(xml, file.table, file.sysId);
                if (result.success) {
                    versionHistory.forEach(function(v, idx) {
                        if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId) {
                            versionHistory[idx].invalidated = true;
                        }
                    });
                    successCount++;
                } else {
                    failCount++;
                }
            } else {
                failCount++;
            }
        } catch (e) {
            failCount++;
        }
    }
    
    // Add a single revert entry for the batch
    if (successCount > 0) {
        addVersionHistoryEntry({
            id: 'vh_' + Date.now(),
            chatId: currentChatId,
            timestamp: Date.now(),
            table: 'batch',
            sysId: 'all',
            displayName: successCount + ' files reverted',
            action: 'REVERT',
            messageIndex: -1
        });
    }
    
    hideSpinner();
    
    if (failCount === 0) {
        showSnackbar('Successfully reverted all ' + successCount + ' file(s)', 'success');
    } else {
        showSnackbar('Reverted ' + successCount + ' file(s), ' + failCount + ' failed', 'warning');
    }
}
