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

// "Your Messages" navigation section removed from the version sidebar
// (renderUserMessagesList + its append in renderVersionSidebar).

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
// Returns [{url, number, title, branch, base}] deduped by URL. A later push to the
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
                    branch: r.branch || args.branch || '',
                    base: r.base_branch || ''
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

// ---- Sub-agent chat aggregation (sidebar) ----
// Chats of the given chat's sub-agents whose chat objects still exist in the
// global `chats` map (any state — running/sleeping/stopped). Built on
// subAgentsForChatTree (175-sub-agent-ui.js, loads later in the ui tier —
// guarded by typeof at call time): for a REGULAR chat this covers the whole
// subtree (nested subs carry root_chat_id = the root chat); when VIEWING a
// sub's own chat it covers its direct children only.
// Returns [{chatId, name, chat}].
function getSubAgentChatsForChat(chatId) {
    var out = [];
    if (!chatId || typeof chats === 'undefined' || !chats) return out;
    if (typeof subAgentsForChatTree !== 'function') return out;
    var recs;
    try { recs = subAgentsForChatTree(chatId) || []; } catch (e) { return out; }
    var seen = {};
    recs.forEach(function(r) {
        if (!r || !r.chat_id || r.chat_id === chatId || seen[r.chat_id]) return;
        var c = chats[r.chat_id];
        if (!c) return;
        seen[r.chat_id] = true;
        out.push({ chatId: r.chat_id, name: r.name || r.agent_id || 'worker', chat: c });
    });
    return out;
}

// ---- Sidebar PR durable fallback (workspace meta.prs) ----
// The message scan above misses a PR when its push tool-result never made it
// into the chat (e.g. the push created the PR on GitHub but the local
// persistence failed and the result carried no pr_url, or the message was
// truncated/lost). wsPush durably tracks every PR in workspace meta.prs
// ({url, number, branch, title}), so the sidebar merges those in as a fallback
// and can show the real PR title (not just the branch) in other chats.
// Scoped to the DEFAULT workspace (pin > MRU — same resolution as
// resolveWorkspace in 130-indexeddb.js, read-only) rather than dumping every
// workspace's PR history into every chat.
// renderVersionSidebar is synchronous and meta lives in IDB, so the list is
// cached here and refreshed async (lazily on first render + on every
// workspaceMutated event); a refresh that changes the list re-renders once.
var _sidebarMetaPRs = null; // null = never loaded; [] = loaded, none
var _sidebarMetaPRsLoading = false;

function _refreshSidebarMetaPRs() {
    if (_sidebarMetaPRsLoading) return;
    if (typeof getAllWorkspaceMetas !== 'function' || typeof parseWsKey !== 'function') return;
    _sidebarMetaPRsLoading = true;
    getAllWorkspaceMetas().then(function(all) {
        // Pick the default workspace: most-recently-used, overridden by a
        // pinned sibling of the same owner/repo (mirrors resolveWorkspace,
        // but read-only — no last_used_at bump).
        var chosen = null;
        (all || []).forEach(function(m) {
            if (!m || !m.repo) return;
            if (!chosen || (m.last_used_at || m.cloned_at || 0) > (chosen.last_used_at || chosen.cloned_at || 0)) chosen = m;
        });
        if (chosen) {
            var chosenRepo = chosen.github_repo || parseWsKey(chosen.repo).repo;
            for (var i = 0; i < all.length; i++) {
                var pm = all[i];
                if (pm && pm.pinned && (pm.github_repo || parseWsKey(pm.repo).repo) === chosenRepo) { chosen = pm; break; }
            }
        }
        var prs = (chosen && chosen.prs) ? chosen.prs.filter(function(p) { return p && p.url; }) : [];
        var changed = JSON.stringify(prs) !== JSON.stringify(_sidebarMetaPRs);
        _sidebarMetaPRs = prs;
        _sidebarMetaPRsLoading = false;
        if (changed) renderVersionSidebar();
    }).catch(function() { _sidebarMetaPRsLoading = false; });
}

// Keep the cache warm: meta.prs changes on push, and the default workspace
// changes on clone/pin/branch/delete. AgentEvents (app tier) may load after
// this file — retry briefly, same pattern as _wsfHookMutations
// (115-workspace-files-sidebar.js). The re-render itself is triggered by
// _refreshSidebarMetaPRs when the list actually changed.
(function _sidebarMetaPRsHook() {
    var tries = 0;
    function hook() {
        if (typeof AgentEvents === 'undefined' || !AgentEvents || !AgentEvents.on) {
            if (++tries < 15) setTimeout(hook, 2000);
            return;
        }
        AgentEvents.on('workspaceMutated', function(ev) {
            try { _refreshSidebarMetaPRs(); } catch (e) { /* sidebar not ready */ }
        });
    }
    setTimeout(hook, 0);
})();

// ---- Sidebar PR merge support ----
// In-memory PR state per URL: 'open' | 'merging' | 'merged' | 'closed'.
// Not persisted — _refreshSidebarPRStates() re-derives merged/closed from
// GitHub in the background, so state survives reloads without extra storage.
var _sidebarPRState = {};
var _sidebarPRCheckedAt = {}; // url -> last background state check (throttle)

// Parse "https://<host>/owner/repo/pull/123" (github.com and GHE) into
// { repo: 'owner/repo', number: 123 }. Returns null on anything else.
function parsePrUrl(url) {
    try {
        var u = new URL(url);
        var m = u.pathname.match(/^\/(.+?\/.+?)\/pull\/(\d+)(\/|$)/);
        if (!m) return null;
        return { repo: m[1], number: parseInt(m[2], 10) };
    } catch (e) { return null; }
}

// Background: fetch real PR state from GitHub for sidebar PRs whose state we
// don't know yet (or knew as open >60s ago), then re-render once if changed.
// Keeps the merge button honest across reloads and external merges.
function _refreshSidebarPRStates(prs) {
    if (typeof githubApi !== 'function') return;
    var now = Date.now();
    var toCheck = (prs || []).filter(function(pr) {
        var st = _sidebarPRState[pr.url];
        if (st === 'merged' || st === 'merging' || st === 'closed') return false;
        return (now - (_sidebarPRCheckedAt[pr.url] || 0)) > 60000;
    });
    if (toCheck.length === 0) return;
    var changed = false;
    Promise.all(toCheck.map(function(pr) {
        var info = parsePrUrl(pr.url);
        if (!info) return Promise.resolve();
        _sidebarPRCheckedAt[pr.url] = now;
        return githubApi('GET', '/repos/' + info.repo + '/pulls/' + info.number).then(function(res) {
            // Re-check CURRENT state before writing: a merge may have started/
            // finished while this GET was in flight — never downgrade
            // 'merging'/'merged' with a stale response.
            var cur = _sidebarPRState[pr.url];
            if (cur === 'merging' || cur === 'merged') return;
            if (res && res.ok && res.body && typeof res.body === 'object') {
                var st = res.body.merged ? 'merged' : (res.body.state === 'closed' ? 'closed' : 'open');
                if (_sidebarPRState[pr.url] !== st) { _sidebarPRState[pr.url] = st; changed = true; }
            }
        }).catch(function() {});
    })).then(function() {
        if (changed) renderVersionSidebar();
    });
}

// Merge button click handler (sidebar PR item). Confirms, merges the PR via
// the GitHub API, then syncs local workspaces — the merged head-branch
// workspace auto-deletes (wsMaybeAutoDeleteMerged) and its base pulls the
// merged commits, exactly like the header sync path.
async function mergeSidebarPR(event, btn) {
    event.preventDefault();
    event.stopPropagation();
    var url = btn.getAttribute('data-pr-url');
    var info = parsePrUrl(url);
    if (!info) { showSnackbar('Could not parse PR URL: ' + url, 'error'); return; }
    var ok = await showConfirmModal('Merge PR #' + info.number,
        'Merge pull request #' + info.number + ' (' + info.repo + ') on GitHub and sync the local workspace?', 'warning');
    if (!ok) return;
    _sidebarPRState[url] = 'merging';
    renderVersionSidebar();
    var finalState = 'open';
    try {
        // Pre-check: may already be merged (or closed) since last state refresh.
        var pre = await githubApi('GET', '/repos/' + info.repo + '/pulls/' + info.number);
        var preBody = (pre && pre.ok && pre.body && typeof pre.body === 'object') ? pre.body : null;
        if (preBody && preBody.merged) {
            finalState = 'merged';
            showSnackbar('PR #' + info.number + ' was already merged \u2014 syncing workspace\u2026', 'success');
        } else if (preBody && preBody.state === 'closed') {
            _sidebarPRState[url] = 'closed';
            renderVersionSidebar();
            showSnackbar('PR #' + info.number + ' is closed and cannot be merged', 'error');
            return;
        } else {
            // Squash-merge with the PR title as the commit title: the whole PR
            // lands as ONE clean commit on the base branch (simplest history for
            // non-technical users). Fall back to a regular merge commit if the
            // repo has squash merging disabled (GitHub returns 405).
            var mergePayload = { merge_method: 'squash' };
            if (preBody && preBody.title) {
                mergePayload.commit_title = preBody.title + ' (#' + info.number + ')';
            }
            var res = await githubApi('PUT', '/repos/' + info.repo + '/pulls/' + info.number + '/merge', mergePayload);
            if (res && res.status === 405 && res.body && /not (allowed|enabled)/i.test(res.body.message || '')) {
                // Squash disabled on this repo — retry as a plain merge commit,
                // still titled after the PR.
                mergePayload.merge_method = 'merge';
                res = await githubApi('PUT', '/repos/' + info.repo + '/pulls/' + info.number + '/merge', mergePayload);
            }
            if (res && res.ok && res.body && res.body.merged) {
                finalState = 'merged';
                showSnackbar('PR #' + info.number + ' merged \u2014 syncing workspace\u2026', 'success');
            } else {
                var msg = (res && res.body && res.body.message) ? res.body.message
                    : (res && res.error) ? res.error : ('HTTP ' + (res && res.status));
                _sidebarPRState[url] = 'open';
                renderVersionSidebar();
                showSnackbar('Merge failed: ' + msg, 'error');
                return;
            }
        }
        _sidebarPRState[url] = finalState;
        renderVersionSidebar();
        // Sync workspaces so the merged changes land locally. Prefer the full
        // header sync (updates badge/caches + handles auto-deleted forks);
        // fall back to targeted per-repo sync.
        try {
            if (typeof syncAndUpdateWorkspaceHeader === 'function') {
                await syncAndUpdateWorkspaceHeader();
            } else if (typeof wsSyncWithRemote === 'function' && typeof getAllWorkspaceMetas === 'function') {
                var metas = await getAllWorkspaceMetas();
                await Promise.all(metas.filter(function(m) {
                    return (m.github_repo || parseWsKey(m.repo).repo) === info.repo;
                }).map(function(m) { return wsSyncWithRemote(m.repo).catch(function() {}); }));
            }
            // syncAndUpdateWorkspaceHeader swallows errors (marks repos 'offline'
            // in _wsHeaderCaches instead) — check the cache before claiming success.
            var _syncOffline = false;
            try {
                if (typeof _wsHeaderCaches === 'object' && _wsHeaderCaches) {
                    _syncOffline = Object.keys(_wsHeaderCaches).some(function(k) {
                        var c = _wsHeaderCaches[k];
                        var repoOf = (c && c.meta && c.meta.github_repo) || parseWsKey(k).repo;
                        return repoOf === info.repo && c && c.syncStatus === 'offline';
                    });
                }
            } catch (e) { /* cache unavailable — assume synced */ }
            if (_syncOffline) {
                showSnackbar('PR merged, but workspace sync could not reach GitHub \u2014 it will retry on the next sync', 'error');
            } else {
                showSnackbar('Workspace synced', 'success');
            }
        } catch (syncErr) {
            showSnackbar('PR merged, but workspace sync failed: ' + (syncErr && syncErr.message ? syncErr.message : syncErr), 'error');
        }
    } catch (e) {
        _sidebarPRState[url] = 'open';
        renderVersionSidebar();
        showSnackbar('Merge failed: ' + (e && e.message ? e.message : e), 'error');
    }
}

function renderVersionSidebar() {
    var container = document.getElementById('version-history-list');
    if (!container) return;
    
    var changedFiles = getAllChangedFiles();
    var revertedFiles = getRevertedFiles();
    var lastBrowserUrl = getLastBrowserUrl();
    var actionUpdatesHtml = (typeof renderActionUpdatesSection === 'function') ? renderActionUpdatesSection(chats[currentChatId]) : '';
    
    var html = '<div class="version-sidebar-content">';
    
    // Pull Requests Section — PRs pushed from this chat via workspace push.
    // Derived from the chat's tool calls/results, so it works retroactively
    // for existing chats with no extra persistence. Shown FIRST, followed by
    // progress (action updates), then the Workers panel.
    var pushedPRs = getPushedPRsForChat(chats[currentChatId]);
    var _prSeenUrls = {};
    pushedPRs.forEach(function(pr) { _prSeenUrls[pr.url] = true; });
    // Sub-agent aggregation: PRs pushed from this chat's sub-agent chats
    // surface in the parent sidebar too, attributed with the worker name
    // (pr.worker → chip in the item meta). De-duped by URL — the parent's
    // own message-scan entry wins (no worker chip).
    var _subChats = getSubAgentChatsForChat(currentChatId);
    var _subChatNames = {};
    _subChats.forEach(function(sc) {
        _subChatNames[sc.chatId] = sc.name;
        getPushedPRsForChat(sc.chat).forEach(function(pr) {
            if (_prSeenUrls[pr.url]) return;
            _prSeenUrls[pr.url] = true;
            pr.worker = sc.name;
            pushedPRs.push(pr);
        });
    });
    // Durable fallback: append PRs tracked in the default workspace's meta.prs
    // that the message scan missed (see _refreshSidebarMetaPRs). Message-scan
    // entries win (they also carry base); meta entries now carry a title too, so
    // other chats show the real PR title. Entries are deduped by URL and skipped
    // once known merged/closed — the fallback surfaces actionable PRs, not the
    // workspace's whole PR history.
    if (_sidebarMetaPRs === null) _refreshSidebarMetaPRs();
    (_sidebarMetaPRs || []).forEach(function(pr) {
        if (_prSeenUrls[pr.url]) return;
        var st = _sidebarPRState[pr.url];
        if (st === 'merged' || st === 'closed') return;
        // Scope the durable meta.prs fallback to the current chat OR one of its
        // sub-agent chats (the parent sidebar aggregates its workers' PRs).
        // Resolve the owner: explicit chatId stamp (see wsPush -> prInfo), else
        // the legacy message-scan lookup. UNATTRIBUTED entries (no stamp AND no
        // lookup hit) are skipped — rendering them in EVERY chat was the
        // cross-chat leak; they remain visible in the per-repo workspace/settings
        // views, which are intentionally unscoped.
        var _ownerChatId = pr.chatId || null;
        if (!_ownerChatId && typeof _wsPrChatLookup === 'function') {
            var _o = _wsPrChatLookup(pr.url);
            if (_o && _o.chatId) _ownerChatId = _o.chatId;
        }
        if (!_ownerChatId) return; // unattributed — no per-chat sidebar shows it
        if (_ownerChatId !== currentChatId && !_subChatNames[_ownerChatId]) return;
        _prSeenUrls[pr.url] = true;
        pushedPRs.push({
            url: pr.url,
            number: pr.number,
            title: pr.title || pr.branch || ('PR #' + pr.number),
            branch: pr.branch || '',
            base: '',
            worker: _ownerChatId !== currentChatId ? _subChatNames[_ownerChatId] : null
        });
    });
    if (pushedPRs.length > 0) {
        html += '<div class="version-prs-section">';
        html += '<div class="version-section-title">' + UI_ICONS.gitBranch + ' Pull Requests (' + pushedPRs.length + ')</div>';
        html += '<div class="pr-sidebar-list">';
        pushedPRs.forEach(function(pr) {
            var prState = _sidebarPRState[pr.url] || 'open';
            html += '<a class="pr-sidebar-item" href="' + escapeHtml(pr.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(pr.url) + '">';
            html += '<span class="pr-sidebar-icon">' + UI_ICONS.gitBranch + '</span>';
            html += '<span class="pr-sidebar-info">';
            html += '<span class="pr-sidebar-title">' + escapeHtml(pr.title) + '</span>';
            html += '<span class="pr-sidebar-meta">#' + escapeHtml(String(pr.number)) + (pr.base ? ' \u00b7 \u2192 ' + escapeHtml(pr.base) : '') + (pr.worker ? ' <span class="wsf-ws" title="Pushed by worker ' + escapeHtml(pr.worker) + '">' + escapeHtml(pr.worker) + '</span>' : '') + '</span>';
            html += '</span>';
            if (prState === 'merged') {
                html += '<span class="pr-sidebar-state merged" title="Merged">' + UI_ICONS.gitMerge + ' Merged</span>';
            } else if (prState === 'merging') {
                html += '<span class="pr-sidebar-state merging" title="Merging\u2026">' + UI_ICONS.spinner + '</span>';
            } else if (prState === 'closed') {
                html += '<span class="pr-sidebar-state closed" title="Closed without merging">' + UI_ICONS.close + ' Closed</span>';
            } else {
                html += '<button class="pr-sidebar-merge-btn" data-pr-url="' + escapeHtml(pr.url) + '" onclick="mergeSidebarPR(event, this)" title="Merge PR #' + escapeHtml(String(pr.number)) + ' and sync workspace">' + UI_ICONS.gitMerge + '</button>';
            }
            html += '<span class="pr-sidebar-open">' + UI_ICONS.externalLink + '</span>';
            html += '</a>';
        });
        html += '</div>';
        html += '</div>';
        // Fire-and-forget: reconcile shown merge buttons with real GitHub PR
        // state (merged in a previous session / externally). Re-renders once
        // if anything changed; throttled per URL inside.
        _refreshSidebarPRStates(pushedPRs);
    }
    
    // Action Updates (progress) Section — below PRs so the PM sees
    // background Action progress/results at a glance. Empty string when the
    // chat has no update_action_state calls.
    if (actionUpdatesHtml) {
        html += '<div class="version-action-updates-section">' + actionUpdatesHtml + '</div>';
    }
    
    // Workers panel placeholder — populated by renderWorkersStrip()
    // (175-sub-agent-ui.js). Lives INSIDE the scrolling sidebar content (below
    // PRs and progress) so all sections share one scrollbar. Because this
    // innerHTML rebuild wipes it, renderWorkersStrip() is re-invoked at the
    // end of this function.
    html += '<div class="sidebar-workers" id="sidebar-workers" style="display:none;" aria-label="Active sub-agents"></div>';
    
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
    
    // Workspace Files Section — files edited via the workspace tool in this
    // chat, shown as artifacts (view / diff / versions / discard). Rendered by
    // ui/115-workspace-files-sidebar.js from the chat's recorded tool calls.
    if (typeof renderWorkspaceFilesSection === 'function') {
        try { html += renderWorkspaceFilesSection(chat); } catch (e) { console.error('workspace files section failed', e); }
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
    
    container.innerHTML = html;
    
    // The Workers placeholder was just recreated empty by the innerHTML
    // rebuild above — repopulate it from the live sub-agent registry.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
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
