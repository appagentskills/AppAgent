// Search chats by title and content (including tool calls and results)
// Uses indexOf for fast matching - returns true on first match (early exit)
function chatMatchesSearch(chat, query) {
    if (!query || query.length < 2) return true; // Require at least 2 chars
    var q = query.toLowerCase();
    // Check title first (fast check)
    if (chat.title && chat.title.toLowerCase().indexOf(q) !== -1) return true;
    // Check all messages for complete results
    if (chat.messages) {
        for (var i = 0; i < chat.messages.length; i++) {
            var msg = chat.messages[i];
            // Check message content
            if (msg.content && msg.content.toLowerCase().indexOf(q) !== -1) return true;
            // Check tool calls
            if (msg.tool_calls) {
                for (var j = 0; j < msg.tool_calls.length; j++) {
                    var tc = msg.tool_calls[j];
                    if (tc.function && tc.function.name && tc.function.name.toLowerCase().indexOf(q) !== -1) return true;
                    if (tc.function && tc.function.arguments && tc.function.arguments.toLowerCase().indexOf(q) !== -1) return true;
                }
            }
            // Check tool results
            if (msg.role === 'tool' && msg.content) {
                var resultContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                if (resultContent.toLowerCase().indexOf(q) !== -1) return true;
            }
        }
    }
    return false;
}

var chatSearchDebounceTimer = null;
var lastSearchQuery = ''; // Cache to avoid redundant searches

// Global search - searches chats, skills, tools, widgets
function handleGlobalSearch(e) {
    var value = e.target.value;
    var sidebar = document.getElementById('sidebar');
    
    // Update sidebar class immediately for responsive UI
    if (sidebar) {
        if (value) {
            sidebar.classList.add('searching');
        } else {
            sidebar.classList.remove('searching');
        }
    }
    
    // Skip if query hasn't changed
    if (value === lastSearchQuery) return;
    
    // Debounce the actual search
    if (chatSearchDebounceTimer) {
        clearTimeout(chatSearchDebounceTimer);
    }
    
    chatSearchDebounceTimer = setTimeout(function() {
        lastSearchQuery = value;
        chatSearchQuery = value;
        searchMatchesCache = {}; // Clear cache on new search
        renderChatList();
    }, 250); // 250ms debounce for better typing experience
}

function clearGlobalSearch() {
    chatSearchQuery = '';
    lastSearchQuery = ''; // Reset cache
    var input = document.getElementById('chat-search-input');
    if (input) input.value = '';
    var sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('searching');
    searchMatchesCache = {}; // Clear cache
    window.currentSearchHighlight = null; // Remove highlights
    renderChatList();
    renderMessages(); // Re-render to remove highlights
}

function renderChatList() {
    var list = document.getElementById('chat-list');
    if (!list) return;
    
    var html = '';
    var q = chatSearchQuery ? chatSearchQuery.toLowerCase() : '';
    
    // If searching, show matching skills, tools, widgets first
    if (q && q.length >= 2) {
        // Search skills
        var matchingSkills = Object.values(skills).filter(function(s) {
            var name = (s.name || s.id || '').toLowerCase();
            var desc = (s.description || '').toLowerCase();
            return name.indexOf(q) !== -1 || desc.indexOf(q) !== -1;
        });
        if (matchingSkills.length > 0) {
            html += '<div class="search-section-header">' + UI_ICONS.skill + ' Skills</div>';
            matchingSkills.forEach(function(s) {
                html += '<div class="search-result-item" onclick="toggleSkillsView();setTimeout(function(){openSkillEditor(\'' + escapeHtml(s.id) + '\')},100)">' +
                    '<span class="search-result-icon">' + UI_ICONS.skill + '</span>' +
                    '<span class="search-result-text">' + escapeHtml(s.name || s.id) + '</span>' +
                '</div>';
            });
        }
        
        // Search tools
        var matchingTools = TOOLS.filter(function(t) {
            var name = (t.function.name || '').toLowerCase();
            var displayName = (TOOL_DISPLAY_NAMES[t.function.name] || '').toLowerCase();
            var desc = (t.function.description || '').toLowerCase();
            return name.indexOf(q) !== -1 || displayName.indexOf(q) !== -1 || desc.indexOf(q) !== -1;
        });
        if (matchingTools.length > 0) {
            html += '<div class="search-section-header">' + UI_ICONS.tool + ' Tools</div>';
            matchingTools.forEach(function(t) {
                var displayName = TOOL_DISPLAY_NAMES[t.function.name] || t.function.name;
                html += '<div class="search-result-item" onclick="showToolInspector(\'' + escapeHtml(t.function.name).replace(/'/g, "\\'") + '\')">' +
                    '<span class="search-result-icon">' + getToolIcon(t.function.name) + '</span>' +
                    '<span class="search-result-text">' + escapeHtml(displayName) + '</span>' +
                '</div>';
            });
        }
        
        // Search widgets
        var matchingWidgets = Object.values(dashboardWidgets).filter(function(w) {
            var title = (w.title || '').toLowerCase();
            return title.indexOf(q) !== -1;
        });
        if (matchingWidgets.length > 0) {
            html += '<div class="search-section-header">' + UI_ICONS.widget + ' Widgets</div>';
            matchingWidgets.forEach(function(w) {
                html += '<div class="search-result-item" onclick="toggleDashboardView()">' +
                    '<span class="search-result-icon">' + UI_ICONS.widget + '</span>' +
                    '<span class="search-result-text">' + escapeHtml(w.title) + '</span>' +
                '</div>';
            });
        }
        
        // Add chats header if we have other results
        if (matchingSkills.length > 0 || matchingTools.length > 0 || matchingWidgets.length > 0) {
            html += '<div class="search-section-header">' + UI_ICONS.chat + ' Chats</div>';
        }
    }
    
    // Only show non-empty chats, filtered by search.
    // Background action chats are hidden from the main chat list unless the
    // PM explicitly revealed one via the jobs dropdown (chat._revealed = true).
    // Sub-agent chats follow the same rule (they ARE background chats), so
    // they only appear after revealSubAgentChat() flips _revealed.
    var sorted = Object.values(chats)
        .filter(function(c) { return c.messages && c.messages.length > 0 && chatMatchesSearch(c, chatSearchQuery) && !(c.isBackground && !c._revealed); })
        .sort(function(a, b) {
            // Pinned chats first, then by date
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.createdAt - a.createdAt;
        });

    // Separate pinned and unpinned for divider
    var pinned = sorted.filter(function(c) { return c.pinned; });
    var unpinned = sorted.filter(function(c) { return !c.pinned; });
    
    // Render pinned chats
    pinned.forEach(function(c) {
        html += renderChatItem(c);
    });
    
    // Add divider if both pinned and unpinned exist
    if (pinned.length > 0 && unpinned.length > 0) {
        html += '<div class="chat-list-divider"></div>';
    }
    
    // Render unpinned chats
    unpinned.forEach(function(c) {
        html += renderChatItem(c);
    });
    
    list.innerHTML = html;

    // Documents now rendered in version sidebar (right sidebar)
}

// Find ALL search matches in a chat with metadata for navigation
var MAX_MATCHES_PER_CHAT = 50; // Limit displayed matches per chat
function findAllSearchMatches(chat, query) {
    if (!query || query.length < 2) return []; // Require at least 2 chars
    var q = query.toLowerCase();
    var snippetLength = 40; // chars before and after match
    var matches = [];
    
    // Helper to create a snippet with bolded match
    function createSnippet(text, matchIdx, queryLen) {
        var start = Math.max(0, matchIdx - snippetLength);
        var end = Math.min(text.length, matchIdx + queryLen + snippetLength);
        var snippet = text.substring(start, end);
        var prefix = start > 0 ? '...' : '';
        var suffix = end < text.length ? '...' : '';
        var localMatchStart = matchIdx - start;
        var before = escapeHtml(snippet.substring(0, localMatchStart));
        var match = escapeHtml(snippet.substring(localMatchStart, localMatchStart + queryLen));
        var after = escapeHtml(snippet.substring(localMatchStart + queryLen));
        return prefix + before + '<strong>' + match + '</strong>' + after + suffix;
    }
    
    // Search in messages content and tool calls
    if (chat.messages) {
        for (var i = 0; i < chat.messages.length; i++) {
            var msg = chat.messages[i];
            
            // Check message content (user/assistant messages)
            if (msg.content && (msg.role === 'user' || msg.role === 'assistant')) {
                var contentLower = msg.content.toLowerCase();
                var searchPos = 0;
                var idx;
                var occurrenceInContent = 0;
                while ((idx = contentLower.indexOf(q, searchPos)) !== -1) {
                    if (matches.length >= MAX_MATCHES_PER_CHAT) break;
                    matches.push({
                        type: 'content',
                        msgIndex: i,
                        role: msg.role,
                        occurrenceIndex: occurrenceInContent,
                        snippet: createSnippet(msg.content, idx, query.length)
                    });
                    occurrenceInContent++;
                    searchPos = idx + 1;
                }
            }
            if (matches.length >= MAX_MATCHES_PER_CHAT) break;
            
            // Check tool calls
            if (msg.tool_calls && matches.length < MAX_MATCHES_PER_CHAT) {
                for (var j = 0; j < msg.tool_calls.length && matches.length < MAX_MATCHES_PER_CHAT; j++) {
                    var tc = msg.tool_calls[j];
                    if (tc.function && tc.function.arguments) {
                        var argsLower = tc.function.arguments.toLowerCase();
                        var argSearchPos = 0;
                        var argIdx;
                        var occurrenceInToolCall = 0;
                        while ((argIdx = argsLower.indexOf(q, argSearchPos)) !== -1) {
                            if (matches.length >= MAX_MATCHES_PER_CHAT) break;
                            matches.push({
                                type: 'tool_call',
                                msgIndex: i,
                                toolCallIndex: j,
                                toolName: tc.function.name,
                                occurrenceIndex: occurrenceInToolCall,
                                snippet: createSnippet(tc.function.arguments, argIdx, query.length)
                            });
                            occurrenceInToolCall++;
                            argSearchPos = argIdx + 1;
                        }
                    }
                }
            }
            
            // Check tool results
            if (msg.role === 'tool' && msg.content && matches.length < MAX_MATCHES_PER_CHAT) {
                var resultContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                var resultLower = resultContent.toLowerCase();
                var resultSearchPos = 0;
                var resultIdx;
                var occurrenceInResult = 0;
                while ((resultIdx = resultLower.indexOf(q, resultSearchPos)) !== -1) {
                    if (matches.length >= MAX_MATCHES_PER_CHAT) break;
                    matches.push({
                        type: 'tool_result',
                        msgIndex: i,
                        toolName: msg.name,
                        occurrenceIndex: occurrenceInResult,
                        snippet: createSnippet(resultContent, resultIdx, query.length)
                    });
                    occurrenceInResult++;
                    resultSearchPos = resultIdx + 1;
                }
            }
        }
    }
    
    return matches;
}

// Navigate to a search match
function navigateToSearchMatch(chatId, match) {
    // Select the chat first
    if (currentChatId !== chatId) {
        selectChat(chatId);
    }
    
    // First enable highlighting
    window.currentSearchHighlight = chatSearchQuery;
    renderMessages();
    
    // Helper to get the nth highlight element
    function getNthHighlight(container, n) {
        var highlights = container.querySelectorAll('mark.search-highlight');
        return highlights[n] || highlights[0];
    }
    
    // Wait for render, then scroll to the exact match
    setTimeout(function() {
        var msgEl = document.getElementById('msg-' + match.msgIndex);
        if (!msgEl) return;
        
        var occIdx = match.occurrenceIndex || 0;
        
        // If it's a tool call, expand and scroll to it
        if (match.type === 'tool_call') {
            // Find the details element for this tool call
            var allDetails = msgEl.querySelectorAll('details.tool-call');
            var tcEl = allDetails[match.toolCallIndex];
            if (tcEl) {
                tcEl.open = true;
                // Wait for expansion, then scroll to the specific highlight
                setTimeout(function() {
                    var highlight = getNthHighlight(tcEl, occIdx);
                    if (highlight) {
                        highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlight.classList.add('search-highlight-current');
                        setTimeout(function() { highlight.classList.remove('search-highlight-current'); }, 3000);
                    } else {
                        tcEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 50);
            }
        } else if (match.type === 'tool_result') {
            // Find the tool result details
            var resultDetails = msgEl.querySelector('details.tool-result');
            if (resultDetails) {
                resultDetails.open = true;
                setTimeout(function() {
                    var highlight = getNthHighlight(resultDetails, occIdx);
                    if (highlight) {
                        highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlight.classList.add('search-highlight-current');
                        setTimeout(function() { highlight.classList.remove('search-highlight-current'); }, 3000);
                    } else {
                        resultDetails.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 50);
            }
        } else {
            // Regular content - find the nth highlight in this message content
            var contentEl = msgEl.querySelector('.message-content');
            var highlight = contentEl ? getNthHighlight(contentEl, occIdx) : getNthHighlight(msgEl, occIdx);
            if (highlight) {
                highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                highlight.classList.add('search-highlight-current');
                setTimeout(function() { highlight.classList.remove('search-highlight-current'); }, 3000);
            } else {
                msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
        
        // Flash the message
        msgEl.classList.add('highlight-flash');
        setTimeout(function() { msgEl.classList.remove('highlight-flash'); }, 2000);
    }, 100);
}

// Highlight search terms in messages
function highlightSearchTerms(query) {
    if (!query) {
        removeSearchHighlights();
        return;
    }
    // Store the query for rendering
    window.currentSearchHighlight = query;
    renderMessages();
}

// Remove search highlights
function removeSearchHighlights() {
    window.currentSearchHighlight = null;
    renderMessages();
}

// Store matches for click handling
var searchMatchesCache = {};

function renderChatItem(c) {
    // Don't highlight any chat as active when Dashboard or Skills is open
    var active = (currentView === 'chat' && c.id === currentChatId) ? 'active' : '';
    var pinIcon = c.pinned ? '<span class="pin-icon" title="Pinned">' + UI_ICONS.pinFilled + '</span>' : '';
    var pinLabel = c.pinned ? 'Unpin Chat' : 'Pin Chat';
    var dropdownId = 'chat-dropdown-' + c.id;
    
    // Show all snippets when searching, otherwise show title.
    // NOTE: search-mode rendering deliberately omits the streaming/pending/attention
    // dots — the search result list is dense (multi-line snippets per row) and the
    // title row is wrapped in a different layout that doesn't have a slot for them.
    // Live status indicators are visible the moment the user clears the search box
    // and the sidebar reverts to the normal renderer below.
    var displayContent;
    if (chatSearchQuery) {
        var matches = findAllSearchMatches(c, chatSearchQuery);
        searchMatchesCache[c.id] = matches; // Cache for click handling
        
        var snippetsHtml = '';
        matches.forEach(function(match, idx) {
            var typeIcon = match.type === 'content' ? (match.role === 'user' ? '<span class="snippet-icon">' + UI_ICONS.user + '</span>' : '<span class="snippet-icon">' + UI_ICONS.bot + '</span>') : 
                          (match.type === 'tool_call' ? '<span class="snippet-icon">' + getToolIcon(match.toolName) + '</span>' : '<span class="snippet-icon">' + UI_ICONS.result + '</span>');
            var typeLabel = match.type === 'content' ? (match.role === 'user' ? 'You' : 'AI') :
                           (match.type === 'tool_call' ? (TOOL_DISPLAY_NAMES[match.toolName] || match.toolName) : 
                           (TOOL_DISPLAY_NAMES[match.toolName] || match.toolName) + ' result');
            snippetsHtml += '<div class="chat-result-snippet-item" onclick="event.stopPropagation(); handleSearchSnippetClick(\'' + c.id + '\', ' + idx + ')">' +
                '<span class="snippet-type">' + typeIcon + ' ' + typeLabel + '</span>' +
                '<span class="snippet-text">' + match.snippet + '</span>' +
            '</div>';
        });
        
        // Title row with menu button
        var titleRow = '<div class="chat-result-title-row">' +
            pinIcon +
            '<div class="chat-result-title">' + escapeHtml(c.title) + ' <span class="match-count">(' + matches.length + ' match' + (matches.length !== 1 ? 'es' : '') + ')</span></div>' +
            '<div class="chat-menu-wrapper">' +
            '<button class="chat-menu-btn" onclick="event.stopPropagation(); toggleChatDropdown(\'' + dropdownId + '\')" title="More options">···</button>' +
            '<div class="chat-dropdown" id="' + dropdownId + '">' +
            '<button class="chat-dropdown-item" onclick="event.stopPropagation(); closeChatDropdowns(); openRenameModal(\'' + c.id + '\')"><span class="dropdown-icon">' + UI_ICONS.edit + '</span>Rename</button>' +
            '<button class="chat-dropdown-item" onclick="event.stopPropagation(); closeChatDropdowns(); downloadChat(\'' + c.id + '\')"><span class="dropdown-icon">' + UI_ICONS.download + '</span>Download</button>' +
            '<button class="chat-dropdown-item" onclick="event.stopPropagation(); closeChatDropdowns(); togglePinChat(\'' + c.id + '\')"><span class="dropdown-icon">' + (c.pinned ? UI_ICONS.pinFilled : UI_ICONS.pin) + '</span>' + pinLabel + '</button>' +
            '<div class="chat-dropdown-divider"></div>' +
            '<button class="chat-dropdown-item danger" onclick="event.stopPropagation(); closeChatDropdowns(); deleteChat(\'' + c.id + '\', event)"><span class="dropdown-icon">' + UI_ICONS.trash + '</span>Delete</button>' +
            '</div>' +
            '</div>' +
        '</div>';
        
        // Sub-agent breadcrumb shown in search results too — otherwise a
        // sub-agent chat that matches a search query looks like a normal
        // top-level chat. (Without this the breadcrumb only appears in the
        // non-search branch below.)
        var searchSubAgentBreadcrumb = (c.isSubAgent && typeof renderSubAgentBreadcrumb === 'function')
            ? renderSubAgentBreadcrumb(c) : '';
        displayContent = '<div class="chat-search-result">' +
            titleRow +
            searchSubAgentBreadcrumb +
            '<div class="chat-result-snippets">' + snippetsHtml + '</div>' +
        '</div>';
        
        return '<div class="chat-item ' + active + ' searching">' + displayContent + '</div>';
    } else {
        var hasApproval = chatHasPendingApproval(c.id);
        var attentionIndicator = hasApproval ? '<span class="chat-attention-dot" title="Requires permission"></span>' : '';
        // Show streaming indicator while the agent is actively running on this chat,
        // unless the chat is already showing the permission attention dot (avoid stacking)
        // OR the chat is paused (paused chats keep `runningChatIds[id]=true` because the
        // loop is awaiting user input — the dot would visually lie about "running" work).
        var chatPaused = typeof isChatPaused === 'function' ? isChatPaused(c.id) : false;
        var streamingIndicator = (!hasApproval && !chatPaused && typeof isChatRunning === 'function' && isChatRunning(c.id)) ? '<span class="chat-streaming-dot" title="Agent is running"></span>' : '';
        var pendingIndicator = chatHasPendingItems(c.id) ? '<span class="chat-pending-dot" title="Has pending draft"></span>' : '';
        // Sub-agent breadcrumb: "↳ parent-title" pill so the user can see
        // at a glance that this chat is a delegated worker, not a top-level
        // conversation. Rendered AFTER the title so the dots stay first.
        var subAgentBreadcrumb = (c.isSubAgent && typeof renderSubAgentBreadcrumb === 'function')
            ? renderSubAgentBreadcrumb(c) : '';
        displayContent = attentionIndicator + streamingIndicator + pendingIndicator + '<span class="chat-title">' + escapeHtml(c.title) + '</span>' + subAgentBreadcrumb;
    }

    return '<div class="chat-item ' + active + '" onclick="selectChat(\'' + c.id + '\')">'+
        pinIcon +
        displayContent +
        '<div class="chat-menu-wrapper">' +
        '<button class="chat-menu-btn" onclick="event.stopPropagation(); toggleChatDropdown(\'' + dropdownId + '\')" title="More options">···</button>' +
        '<div class="chat-dropdown" id="' + dropdownId + '">' +
        '<button class="chat-dropdown-item" onclick="event.stopPropagation(); closeChatDropdowns(); openRenameModal(\'' + c.id + '\')"><span class="dropdown-icon">' + UI_ICONS.edit + '</span>Rename</button>' +
        '<button class="chat-dropdown-item" onclick="event.stopPropagation(); closeChatDropdowns(); downloadChat(\'' + c.id + '\')"><span class="dropdown-icon">' + UI_ICONS.download + '</span>Download</button>' +
        '<button class="chat-dropdown-item" onclick="event.stopPropagation(); closeChatDropdowns(); togglePinChat(\'' + c.id + '\')"><span class="dropdown-icon">' + (c.pinned ? UI_ICONS.pinFilled : UI_ICONS.pin) + '</span>' + pinLabel + '</button>' +
        '<div class="chat-dropdown-divider"></div>' +
        '<button class="chat-dropdown-item danger" onclick="event.stopPropagation(); closeChatDropdowns(); deleteChat(\'' + c.id + '\', event)"><span class="dropdown-icon">' + UI_ICONS.trash + '</span>Delete</button>' +
        '</div>' +
        '</div>' +
    '</div>';
}

// Handle click on search snippet
function handleSearchSnippetClick(chatId, matchIndex) {
    var matches = searchMatchesCache[chatId];
    if (!matches || !matches[matchIndex]) return;
    navigateToSearchMatch(chatId, matches[matchIndex]);
}

function escapeHtml(t) {
    // Explicit per-char replace — covers BOTH text-content and attribute
    // contexts. The previous textContent/innerHTML trick correctly escaped
    // <, >, & but left " and ' untouched, making it unsafe for callers
    // that interpolate the result into attribute values (title="...",
    // data-x="...", etc.). 100+ call sites; switching to a stricter
    // implementation is additive — text-content contexts are unaffected.
    if (t == null) return '';
    return String(t)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
