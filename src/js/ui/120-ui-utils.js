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
    // m12: the inline onclick sits on the whole <details>, so clicks INSIDE
    // the body (text selection, links, nested tool cards) bubble here too.
    // Only a click on THIS details' own <summary> toggles it — anything else
    // must not flip the stored state (the card would collapse on re-render).
    var _ev = (typeof window !== 'undefined' && window.event) || null;
    if (_ev && _ev.type === 'click' && details && _ev.target && typeof _ev.target.closest === 'function') {
        var _sum = _ev.target.closest('summary');
        if (!_sum || _sum.parentNode !== details) return;
    }
    if (!msg.toolCallsExpanded) msg.toolCallsExpanded = {};
    // onclick fires before browser toggle - use opposite of PREVIOUS stored state,
    // or of the current (pre-toggle) open state when nothing is stored yet
    var wasOpen = msg.toolCallsExpanded.hasOwnProperty(tcIdx) ? msg.toolCallsExpanded[tcIdx] : details.open;
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
    
    // MEMWIN: expand the message window first so msg-<idx> exists in the DOM.
    if (typeof ensureMessageInWindow === 'function') ensureMessageInWindow(msgIdx);
    
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

// RIGHT chat/version sidebar (#version-sidebar) manual-hide state — driven by
// openVersionSidebar()/closeVersionSidebar(), persisted as appStorage key
// 'versionSidebarHidden' (do NOT rename the key — existing users' saved prefs).
// NOT the LEFT nav rail — that is sidebarCollapsed in core/030-config.js.
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

// ═══ C2-ui SKEL-SCAN: skeleton-safe message scans for UI consumers ═══
// With CHAT_MESSAGE_EVICTION_ENABLED on, a cold chat in `chats` can be a
// SKELETON: no `messages` key, `_messagesEvicted` + `_msgCount` kept
// (core/130 MSG-EVICT). Lists, badges, previews and stats must give the same
// answer for a skeleton as for the hydrated chat WITHOUT hydrating every chat
// into the live map. skeletonScanValue(slot, chatId, chat, fn, fallback,
// rerender): a hydrated chat is scanned live by fn(chat), exactly as before
// (and drops any memo, so a later re-eviction re-reads). A skeleton returns
// the memoized fn(stored row) for its signature; on a miss it queues ONE
// transient read of the stored row (loadChatRowFromDB: a structured clone,
// never attached to chats[]), runs every slot wanted for that chat, keeps
// only the small JSON results, and calls the requesters' re-render hooks once
// (debounced). Until then the caller gets `fallback`. A missing row memoizes
// fn over [] (no retry loop until the signature changes).
var _skelScanMemo = {};   // chatId -> { sig, vals: { slot: value } }
var _skelScanWant = {};   // chatId -> { slot: fn }
var _skelScanQueue = [];
var _skelScanBusy = false;
var _skelScanRerenders = []; // hooks to call after the queue drains
var _skelScanTimer = null;
function _isSkeletonChat(chat) {
    return !!chat && !Array.isArray(chat.messages) && !!chat._messagesEvicted;
}
function _skelScanSig(chat) {
    var n = (typeof chatMessageCount === 'function') ? chatMessageCount(chat) : (chat._msgCount || 0);
    return n + ':' + (chat.rev != null ? chat.rev : '-') + ':' + (chat.updatedAt != null ? chat.updatedAt : '-');
}
function _skelClone(v) {
    return (v === null || typeof v !== 'object') ? v : JSON.parse(JSON.stringify(v));
}
function skeletonScanValue(slot, chatId, chat, fn, fallback, rerender) {
    if (!_isSkeletonChat(chat)) {
        if (chatId && _skelScanMemo[chatId]) delete _skelScanMemo[chatId];
        return fn(chat);
    }
    var m = _skelScanMemo[chatId];
    if (m && m.sig === _skelScanSig(chat) && Object.prototype.hasOwnProperty.call(m.vals, slot)) {
        var v = m.vals[slot];
        return (v === null || v === undefined) ? fallback : _skelClone(v);
    }
    // Callers often pass a fresh closure per call: dedupe by identity OR
    // source so N same-tick requests still cause ONE re-render.
    if (typeof rerender === 'function' && !_skelScanRerenders.some(function(h) {
        return h === rerender || String(h) === String(rerender);
    })) _skelScanRerenders.push(rerender);
    // Same-tick dedupe: a read for this chat (same signature) is already in
    // flight — join its slot set instead of queueing a second row read.
    var fl = _skelScanPump._inflight && _skelScanPump._inflight[chatId];
    if (fl && fl.sig === _skelScanSig(chat)) {
        if (!fl.want[slot]) fl.want[slot] = fn;
        return fallback;
    }
    var want = _skelScanWant[chatId];
    if (!want) { want = _skelScanWant[chatId] = {}; _skelScanQueue.push(chatId); }
    want[slot] = fn;
    if (!_skelScanBusy) _skelScanPump();
    return fallback;
}
async function _skelScanPump() {
    _skelScanBusy = true;
    try {
        while (_skelScanQueue.length) {
            var id = _skelScanQueue.shift();
            var want = _skelScanWant[id];
            delete _skelScanWant[id];
            var chat = (typeof chats !== 'undefined' && chats) ? chats[id] : null;
            if (!want || !_isSkeletonChat(chat)) continue; // hydrated/deleted meanwhile: live scans apply
            var sig = _skelScanSig(chat);
            // Slots answered by an earlier read for this signature need no re-read.
            var m0 = _skelScanMemo[id];
            if (m0 && m0.sig === sig) Object.keys(want).forEach(function(s) {
                if (Object.prototype.hasOwnProperty.call(m0.vals, s)) delete want[s];
            });
            if (!Object.keys(want).length) continue;
            var inflight = _skelScanPump._inflight || (_skelScanPump._inflight = {});
            inflight[id] = { sig: sig, want: want }; // later requests join `want` (see skeletonScanValue)
            var row = null;
            try { row = (typeof loadChatRowFromDB === 'function') ? await loadChatRowFromDB(id) : null; } catch (e) { row = null; }
            finally { if (inflight[id] && inflight[id].want === want) delete inflight[id]; }
            chat = chats[id];
            if (!_isSkeletonChat(chat)) continue;
            // Chat-level fields come from the in-memory skeleton (never
            // regressed by disk); only the messages come from the row.
            var like = {};
            Object.keys(chat).forEach(function(k) { like[k] = chat[k]; });
            like.messages = (row && Array.isArray(row.messages)) ? row.messages : [];
            var m = _skelScanMemo[id];
            if (!m || m.sig !== sig) m = _skelScanMemo[id] = { sig: sig, vals: {} };
            Object.keys(want).forEach(function(slot) {
                try { m.vals[slot] = _skelClone(want[slot](like)); } catch (e) { m.vals[slot] = null; }
            });
            row = null; like = null;
        }
    } finally {
        _skelScanBusy = false;
    }
    if (_skelScanTimer) clearTimeout(_skelScanTimer);
    _skelScanTimer = setTimeout(function() {
        _skelScanTimer = null;
        var hooks = _skelScanRerenders.splice(0);
        hooks.forEach(function(h) { try { h(); } catch (e) {} });
    }, 120);
}

// Collect PRs pushed from this chat (workspace push tool calls + their results).
// Returns [{url, number, title, branch, base}] deduped by URL. A later push to the
// same PR (append) replaces the tracked entry, but only overwrites the title
// when the later push actually passed a pr_title (it is optional on append).
function getPushedPRsForChat(chat) {
    if (!chat) return [];
    // C2-ui SKEL-SCAN: a skeleton (sub-agent roll-up, cold chat) answers
    // from its stored row, then the sidebar re-renders.
    return skeletonScanValue('prs', chat.id, chat, _getPushedPRsLive, [], function() {
        if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
    });
}
function _getPushedPRsLive(chat) {
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
    prs.forEach(function(pr) { if (!pr.title) pr.title = pr.branch || t('PR #{number}', { number: pr.number }); });
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

// ---- Orphaned sub-agent PR backfill (sidebar meta.prs fallback) ----
// A meta.prs entry pushed by a sub-agent chat is stamped with the SUB's
// chatId (and, for new pushes, a durable root_chat_id — see wsPush in
// tools/020-tool-execution.js). Sub-agent chats are reaped ~1h after they
// settle (SUBAGENT_TOMBSTONE_TTL_MS, core/097-sub-agent-registry.js), so a
// LEGACY entry (no root_chat_id) loses every sidebar path once the sub's
// chat row is gone: the sub's own message scan (chat deleted), the parent's
// sub-agent aggregation (getSubAgentChatsForChat skips vanished rows), and
// the strict meta.prs owner gate below. Backfill: attribute such an entry to
// the CURRENT chat only when the current chat's own transcript provably
// references the PR URL — in a retained sub-agent report (sub_report
// message) or an answer links card. Strictly scoped to explicit URL
// presence in THIS chat's messages, so it cannot reintroduce the cross-chat
// leak fixed in PR #564 (unattributed PRs rendered in every chat).
// ACCEPTED TRADEOFF: a chat that merely DISCUSSES the PR URL in one of its
// own sub-agent reports (e.g. a regression sweep reviewing that PR) could
// claim the orphaned card. That requires the URL to appear verbatim in THIS
// chat's retained sub reports/links — a strong signal of involvement — and
// is partly mitigated by the merged/closed skip above (stale history never
// resurfaces). Preferred over the alternative failure mode: the pushing
// chat losing its own PR card entirely.
// Cheap: only invoked when the strict owner gate already failed, and only
// for chat_sub_* owners whose chat row no longer exists.
// Returns null (no claim) or { name } — the GC'd worker's display name
// recovered from the matching sub_report message (null when the match came
// from a links card, which carries no worker attribution).
function _orphanedSubPrBelongsHere(pr, ownerChatId) {
    if (!pr || !pr.url || !ownerChatId) return null;
    if (String(ownerChatId).indexOf('chat_sub_') !== 0) return null; // only sub-agent pushers
    if (typeof chats === 'undefined' || !chats) return null;
    if (chats[ownerChatId]) return null; // sub chat still alive — the strict gates decide
    var cur = chats[currentChatId];
    if (!cur || !Array.isArray(cur.messages)) return null;
    // PR-number prefix guard: ".../pull/76" must NOT match a report that
    // mentions ".../pull/764". Escape the URL for regex use and require a
    // non-digit (or end of string) immediately after it. The links scan
    // below keeps exact === matching and needs no boundary.
    var _urlRe;
    try { _urlRe = new RegExp(pr.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])'); } catch (e) { return null; }
    for (var i = 0; i < cur.messages.length; i++) {
        var m = cur.messages[i];
        if (!m) continue;
        // Sub-agent report copy retained on the parent transcript — the PR URL
        // typically lives in report.data.pr_url or the report summary.
        if (m.role === 'sub_report' && m.report) {
            try { if (_urlRe.test(JSON.stringify(m.report))) return { name: m.subAgentName || null }; } catch (e) { /* unserializable — skip */ }
        }
        // Answer links card ([{title, url}] — see queueChatAutoLinks/set_links).
        if (Array.isArray(m.links)) {
            for (var j = 0; j < m.links.length; j++) {
                if (m.links[j] && m.links[j].url === pr.url) return { name: null };
            }
        }
    }
    return null;
}

// ---- Sidebar PR durable fallback (workspace meta.prs) ----
// The message scan above misses a PR when its push tool-result never made it
// into the chat (e.g. the push created the PR on GitHub but the local
// persistence failed and the result carried no pr_url, or the message was
// truncated/lost). wsPush durably tracks every PR in workspace meta.prs
// ({url, number, branch, title}), so the sidebar merges those in as a fallback
// and can show the real PR title (not just the branch) in other chats.
// PR-CHIP (PR-2): the list is the UNION of every workspace's meta.prs, deduped
// by URL (_sidebarMetaPRsUnion). It used to read only the DEFAULT workspace
// (pin > MRU), so a PR tracked in any other meta — a push to another repo, a
// web_fetch-created PR (_wfMaybeTrackGitHubPr files it under the PR's own
// repo), a branch fork's meta — never reached the sidebar once the message
// scan missed it. That no longer dumps every workspace's history into every
// chat: renderVersionSidebar's per-chat owner gate (chatId stamp / live sub /
// root_chat_id / orphan backfill) scopes each entry.
// renderVersionSidebar is synchronous and meta lives in IDB, so the list is
// cached here and refreshed async (lazily on first render + on every
// workspaceMutated event); a refresh that changes the list re-renders once.
var _sidebarMetaPRs = null; // null = never loaded; [] = loaded, none
var _sidebarMetaPRsLoading = false;
// PR-CHIP (S-1): a refresh requested while a load is in flight (e.g. the
// workspaceMutated burst of one push) used to be DROPPED, so a PR written
// after the in-flight read stayed hidden until some later mutation. It now
// marks the cache dirty and the load re-runs once when it settles.
var _sidebarMetaPRsDirty = false;

// Union of every workspace meta's prs, deduped by URL. Pinned metas first,
// then most recently used — per repo that is the meta the trackers write to
// (wsPush, _wfMaybeTrackGitHubPr: pinned wins, else MRU) — and the first
// copy of a URL wins. A later duplicate (e.g. a fork's meta and its base's)
// only lends a merged/closed state the kept copy lacks, so the Merged chip
// still seeds from the durable meta. Meta objects are never mutated.
function _sidebarMetaPRsUnion(all) {
    var metas = (all || []).filter(function(m) { return m && m.repo && Array.isArray(m.prs); });
    metas.sort(function(a, b) {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (b.last_used_at || b.cloned_at || 0) - (a.last_used_at || a.cloned_at || 0);
    });
    var out = [];
    var byUrl = {};
    metas.forEach(function(m) {
        m.prs.forEach(function(p) {
            if (!p || !p.url) return;
            if (byUrl[p.url] === undefined) { byUrl[p.url] = out.length; out.push(p); return; }
            var kept = out[byUrl[p.url]];
            if (!kept.state && (p.state === 'merged' || p.state === 'closed')) {
                kept = out[byUrl[p.url]] = Object.assign({}, kept, { state: p.state });
            }
            // Carry the merge timestamp from any duplicate (the header PR list
            // shows merged PRs only when merged today).
            if (!kept.merged_at && p.merged_at) {
                out[byUrl[p.url]] = Object.assign({}, kept, { merged_at: p.merged_at });
            }
        });
    });
    return out;
}

function _refreshSidebarMetaPRs() {
    if (_sidebarMetaPRsLoading) { _sidebarMetaPRsDirty = true; return; }
    if (typeof getAllWorkspaceMetas !== 'function') return;
    _sidebarMetaPRsLoading = true;
    _sidebarMetaPRsDirty = false; // this load satisfies any earlier request
    getAllWorkspaceMetas().then(function(all) {
        var prs = _sidebarMetaPRsUnion(all);
        var changed = JSON.stringify(prs) !== JSON.stringify(_sidebarMetaPRs);
        _sidebarMetaPRs = prs;
        _sidebarMetaPRsLoading = false;
        if (changed) renderVersionSidebar();
    }).catch(function() { _sidebarMetaPRsLoading = false; }).then(function() {
        if (_sidebarMetaPRsDirty && !_sidebarMetaPRsLoading) {
            _sidebarMetaPRsDirty = false;
            _refreshSidebarMetaPRs();
        }
    });
}

// Keep the cache warm: meta.prs changes on push / PR tracking / sync, and the
// set of workspaces changes on clone/pin/branch/delete. AgentEvents (app tier) may load after
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
// url -> ISO merged_at learned live (GitHub GET /pulls/N or the merge button).
// Read by the header dropdown PR filter (merged today only, 040-tools-settings.js).
var _sidebarPRMergedAt = {};

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
                if (st === 'merged' && !_sidebarPRMergedAt[pr.url]) _sidebarPRMergedAt[pr.url] = res.body.merged_at || new Date().toISOString();
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
    if (!info) { showSnackbar(t('Could not parse PR URL: {url}', { url: url }), 'error'); return; }
    var ok = await showConfirmModal(t('Merge PR #{number}', { number: info.number }),
        t('Merge pull request #{number} ({repo}) on GitHub and sync the local workspace?', { number: info.number, repo: escapeHtml(info.repo) }), 'warning');
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
            if (!_sidebarPRMergedAt[url]) _sidebarPRMergedAt[url] = preBody.merged_at || new Date().toISOString();
            showSnackbar(t('PR #{number} was already merged \u2014 syncing workspace\u2026', { number: info.number }), 'success');
        } else if (preBody && preBody.state === 'closed') {
            _sidebarPRState[url] = 'closed';
            renderVersionSidebar();
            showSnackbar(t('PR #{number} is closed and cannot be merged', { number: info.number }), 'error');
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
                // PUT /merge returns {sha, merged, message} — no merged_at; it merged just now.
                _sidebarPRMergedAt[url] = new Date().toISOString();
                showSnackbar(t('PR #{number} merged \u2014 syncing workspace\u2026', { number: info.number }), 'success');
            } else {
                var msg = (res && res.body && res.body.message) ? res.body.message
                    : (res && res.error) ? res.error : ('HTTP ' + (res && res.status));
                _sidebarPRState[url] = 'open';
                renderVersionSidebar();
                showSnackbar(t('Merge failed: {error}', { error: msg }), 'error');
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
            } else if (typeof _wsSyncOnce === 'function' && typeof getAllWorkspaceMetas === 'function') {
                var metas = await getAllWorkspaceMetas();
                await Promise.all(metas.filter(function(m) {
                    return (m.github_repo || parseWsKey(m.repo).repo) === info.repo;
                }).map(function(m) { return _wsSyncOnce(m.repo).catch(function() {}); }));
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
                showSnackbar(t('PR merged, but workspace sync could not reach GitHub \u2014 it will retry on the next sync'), 'error');
            } else {
                showSnackbar(t('Workspace synced'), 'success');
            }
        } catch (syncErr) {
            showSnackbar(t('PR merged, but workspace sync failed: {error}', { error: (syncErr && syncErr.message ? syncErr.message : syncErr) }), 'error');
        }
    } catch (e) {
        _sidebarPRState[url] = 'open';
        renderVersionSidebar();
        showSnackbar(t('Merge failed: {error}', { error: (e && e.message ? e.message : e) }), 'error');
    }
}

// Capture both possible scroll containers. The flex layout currently makes
// .version-sidebar-content the scroll owner, but #version-history-list also has
// overflow-y:auto and can own scrolling if the layout changes.
function _captureVersionSidebarScroll(container) {
    var content = container.querySelector('.version-sidebar-content');
    function capture(el) {
        if (!el) return null;
        var maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        return {
            top: el.scrollTop,
            // Preserve an intentional follow-to-bottom position when new sidebar
            // content grows; don't treat a non-scrollable empty rail as bottom.
            atBottom: maxScrollTop > 0 && el.scrollTop >= maxScrollTop - 2
        };
    }
    return { list: capture(container), content: capture(content) };
}

function _restoreVersionSidebarScroll(container, state) {
    if (!container || !state) return;
    var content = container.querySelector('.version-sidebar-content');
    function restore(el, saved) {
        if (!el || !saved) return;
        var maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = saved.atBottom && maxScrollTop > 0
            ? maxScrollTop
            : Math.min(Math.max(0, saved.top), maxScrollTop);
    }
    restore(container, state.list);
    restore(content, state.content);
}

function renderVersionSidebar() {
    var container = document.getElementById('version-history-list');
    if (!container) return;
    var savedSidebarScroll = _captureVersionSidebarScroll(container);
    
    var changedFiles = getAllChangedFiles();
    var revertedFiles = getRevertedFiles();
    var lastBrowserUrl = getLastBrowserUrl();
    // A sub-agent's OWN progress is rendered inside the worker self-card below
    // (updateSubAgentSelfCard, 175-sub-agent-ui.js), styled like the parent's
    // Workers-panel card. Skip the generic in-place progress section here for
    // sub-agent chats so the same action-state / todo list is not shown twice.
    var _vsCurChat = (typeof chats !== 'undefined' && typeof currentChatId !== 'undefined') ? chats[currentChatId] : null;
    var actionUpdatesHtml = (_vsCurChat && _vsCurChat.isSubAgent)
        ? ''
        : ((typeof renderActionUpdatesSection === 'function') ? renderActionUpdatesSection(chats[currentChatId]) : '');
    
    var html = '<div class="version-sidebar-content">';

    // Sub-agent "Back to parent" button host — pinned to the VERY TOP of the
    // sidebar (above PRs/artifacts) so it is always the topmost control in a
    // sub-agent chat. Placeholder only: populated by updateSubAgentSelfCard()
    // (175-sub-agent-ui.js), re-invoked at the end of this function (this
    // innerHTML rebuild wipes it). Hidden for regular chats.
    html += '<div class="sub-self-parent-host" id="sub-self-parent-host" style="display:none" aria-label="' + t('Back to parent chat') + '"></div>';
    
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
    // Durable fallback: append PRs tracked in any workspace's meta.prs (the
    // union cached by _refreshSidebarMetaPRs) that the message scan missed. Message-scan
    // entries win (they also carry base); meta entries now carry a title too, so
    // other chats show the real PR title. Entries are deduped by URL and skipped
    // once known merged/closed — the fallback surfaces actionable PRs, not the
    // workspace's whole PR history.
    if (_sidebarMetaPRs === null) _refreshSidebarMetaPRs();
    (_sidebarMetaPRs || []).forEach(function(pr) {
        // Seed the in-memory state cache from the durable meta stamp (written
        // by sync and the web_fetch REST merge hook) BEFORE the dedup return,
        // so a known-merged PR renders its Merged chip immediately on a fresh
        // session (message-scan entries included) instead of flashing a stale
        // merge button until the background GitHub GET resolves. Never
        // overwrites a live in-memory state (e.g. 'merging' mid-flight).
        if (pr.state === 'merged' && !_sidebarPRState[pr.url]) _sidebarPRState[pr.url] = 'merged';
        if (_prSeenUrls[pr.url]) return;
        var st = _sidebarPRState[pr.url];
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
        // Accept, in order: the owning chat itself; a live sub-agent of this
        // chat (worker chip); a durable root_chat_id stamp naming this chat
        // (survives sub-agent GC — see wsPush); else the conservative
        // orphaned-sub backfill (PR URL present in THIS chat's transcript —
        // which also recovers the GC'd worker's name for the chip).
        var _orphanHit = null;
        if (_ownerChatId !== currentChatId && !_subChatNames[_ownerChatId]) {
            // Sweep 753-773 (764-worker-chip-asymmetry): run the transcript scan
            // even when the durable root_chat_id stamp already vouches for the
            // entry — for stamped rows it is purely worker-NAME recovery, so a
            // GC'd sub renders the same chip on stamped and legacy entries
            // alike. Gate semantics unchanged: stamped rows always render;
            // unstamped rows still need a transcript hit.
            _orphanHit = _orphanedSubPrBelongsHere(pr, _ownerChatId);
            if (!_orphanHit && pr.root_chat_id !== currentChatId) return;
        }
        // Merged/closed skip — moved AFTER ownership resolution and narrowed
        // to WEAK claims (rows accepted solely via the orphan transcript
        // match, with no vouching stamp). It used to run before ownership and
        // hid merged PRs from their OWNING chat too, while the message-scan
        // path kept showing that chat's merged PRs with a Merged chip — that
        // asymmetry made a REST-opened (meta-only) PR vanish on merge while a
        // workspace-pushed one stayed visible. STRONG rows — owned by this
        // chat, by a live sub of it, or by a durable root_chat_id stamp
        // naming this chat — now render with the state chip, exactly like
        // message-scan entries. Weak rows keep the skip so stale history
        // never resurfaces in merely-discussing chats (the accepted tradeoff
        // documented on _orphanedSubPrBelongsHere).
        var _strongPrOwner = _ownerChatId === currentChatId || !!_subChatNames[_ownerChatId] || pr.root_chat_id === currentChatId;
        if ((st === 'merged' || st === 'closed') && !_strongPrOwner) return;
        _prSeenUrls[pr.url] = true;
        pushedPRs.push({
            url: pr.url,
            number: pr.number,
            title: pr.title || pr.branch || ('PR #' + pr.number),
            branch: pr.branch || '',
            base: '',
            worker: _ownerChatId !== currentChatId ? (_subChatNames[_ownerChatId] || (_orphanHit && _orphanHit.name) || null) : null
        });
    });
    if (pushedPRs.length > 0) {
        html += '<div class="version-prs-section">';
        html += '<div class="version-section-title">' + UI_ICONS.gitBranch + ' ' + t('Pull Requests ({count})', { count: pushedPRs.length }) + '</div>';
        html += '<div class="pr-sidebar-list">';
        pushedPRs.forEach(function(pr) {
            var prState = _sidebarPRState[pr.url] || 'open';
            html += '<a class="pr-sidebar-item" href="' + escapeHtml(pr.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(pr.url) + '">';
            html += '<span class="pr-sidebar-icon">' + UI_ICONS.gitBranch + '</span>';
            html += '<span class="pr-sidebar-info">';
            html += '<span class="pr-sidebar-title">' + escapeHtml(pr.title) + '</span>';
            html += '<span class="pr-sidebar-meta">#' + escapeHtml(String(pr.number)) + (pr.base ? ' \u00b7 \u2192 ' + escapeHtml(pr.base) : '') + (pr.worker ? ' <span class="wsf-ws" title="' + t('Pushed by worker {worker}', { worker: escapeHtml(pr.worker) }) + '">' + escapeHtml(pr.worker) + '</span>' : '') + '</span>';
            html += '</span>';
            if (prState === 'merged') {
                html += '<span class="pr-sidebar-state merged" title="' + t('Merged') + '">' + UI_ICONS.gitMerge + ' ' + t('Merged') + '</span>';
            } else if (prState === 'merging') {
                html += '<span class="pr-sidebar-state merging" title="' + t('Merging\u2026') + '">' + UI_ICONS.spinner + '</span>';
            } else if (prState === 'closed') {
                html += '<span class="pr-sidebar-state closed" title="' + t('Closed without merging') + '">' + UI_ICONS.close + ' ' + t('Closed') + '</span>';
            } else {
                html += '<button class="pr-sidebar-merge-btn" data-pr-url="' + escapeHtml(pr.url) + '" onclick="mergeSidebarPR(event, this)" title="' + t('Merge PR #{number} and sync workspace', { number: escapeHtml(String(pr.number)) }) + '">' + UI_ICONS.gitMerge + '</button>';
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
    
    // Sub-agent self card host — when the OPEN chat is a sub-agent chat, the
    // SAME live worker card the parent chat shows (progress + "View more") is
    // mirrored here, immediately below the Progress (action updates) card,
    // ("Back to parent" now lives in its own top host). Placeholder: populated
    // by updateSubAgentSelfCard() (175-sub-agent-ui.js), re-invoked at the
    // end of this function because this innerHTML rebuild wipes it (same
    // pattern as the Workers panel below). Hidden for regular chats.
    html += '<div class="sub-self-card-host" id="sub-self-card-host" style="display:none" aria-label="' + t('Sub-agent status') + '"></div>';
    
    // Workers panel placeholder — populated by renderWorkersStrip()
    // (175-sub-agent-ui.js). Lives INSIDE the scrolling sidebar content (below
    // PRs and progress) so all sections share one scrollbar. Because this
    // innerHTML rebuild wipes it, renderWorkersStrip() is re-invoked at the
    // end of this function.
    html += '<div class="sidebar-workers" id="sidebar-workers" style="display:none;" aria-label="' + t('Active sub-agents') + '"></div>';
    
    // Actions Section - Group all action buttons together
    var hasActions = lastBrowserUrl || changedFiles.length > 0;
    if (hasActions) {
        html += '<div class="version-actions-section">';
        html += '<div class="version-section-title">' + t('Actions') + '</div>';
        html += '<div class="version-actions-list">';
        
        // Open Browser button
        if (lastBrowserUrl) {
            html += '<button class="version-action-btn" onclick="reopenBrowser()" title="' + escapeHtml(lastBrowserUrl) + '">';
            html += '<span class="action-icon">' + UI_ICONS.globe + '</span>' + t('Open Browser');
            html += '</button>';
        }
        
        // Download XML button
        if (changedFiles.length > 0) {
            html += '<button class="version-action-btn" onclick="downloadChangesXml()" title="' + t('Export all changes as one XML file') + '">';
            html += '<span class="action-icon">' + UI_ICONS.download + '</span>' + t('Download All');
            html += '</button>';
            
            // Revert All button
            html += '<button class="version-action-btn danger" onclick="revertAllChanges()">';
            html += '<span class="action-icon">' + UI_ICONS.undo + '</span>' + t('Revert All');
            html += '</button>';
            html += '<div class="version-action-hint">' + tn(changedFiles.length, '{count} file changed', '{count} files changed') + '</div>';
        }
        
        html += '</div>';
        html += '</div>';
    }
    
    // Current chat's widgets only (core/135-widget-store.js getSidebarWidgets);
    // all saved widgets live in the dashboard Widget Library.
    var widgets = getSidebarWidgets();
    if (widgets.length > 0) {
        html += '<div class="version-widgets-section">';
        html += '<div class="version-section-title">' + UI_ICONS.widget + ' ' + t('Widgets ({count})', { count: widgets.length }) + '</div>';
        html += '<div id="widget-sidebar-list" class="widget-sidebar-list">';
        widgets.forEach(function(widget) {
            var isOnDashboard = dashboardWidgets && dashboardWidgets[widget.id];
            var dashboardBtnClass = isOnDashboard ? 'widget-sidebar-btn widget-dashboard-btn on-dashboard' : 'widget-sidebar-btn widget-dashboard-btn';
            var dashboardBtnTitle = isOnDashboard ? t('Pinned \u2014 click to change') : t('Pin to dashboard\u2026');
            var dashboardBtnIcon = isOnDashboard ? UI_ICONS.pinFilled : UI_ICONS.pin;
            html += '<div class="widget-sidebar-item" role="button" tabindex="0" data-kbd-click onclick="scrollToWidget(\'' + widget.id + '\')">' +
                '<span class="widget-sidebar-icon">' + UI_ICONS.widget + '</span>' +
                '<span class="widget-sidebar-title">' + escapeHtml(widget.title) + '</span>' +
                '<div class="widget-sidebar-actions">' +
                '<button class="widget-sidebar-btn" onclick="event.stopPropagation();showWidgetInPanel(\'' + widget.id + '\')" title="' + t('Open in new tab') + '">' + UI_ICONS.externalLink + '</button>' +
                '<button class="' + dashboardBtnClass + '" data-widget-id="' + widget.id + '" onclick="showWidgetPinMenu(\'' + widget.id + '\', event)" title="' + dashboardBtnTitle + '">' + dashboardBtnIcon + '</button>' +
                '<button class="widget-sidebar-btn" onclick="event.stopPropagation();openWidgetFullscreen(\'' + widget.id + '\')" title="' + t('Fullscreen') + '">' + UI_ICONS.maximize + '</button>' +
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
        html += '<div class="version-section-title">' + UI_ICONS.eye + ' ' + t('Attachments ({count})', { count: attachTotalCount }) + '</div>';
        html += '<div class="screenshot-sidebar-list">';
        // Row a11y: the row itself is NOT a button (it would nest the thumb button).
        // The .screenshot-sidebar-info block is the keyboard "go to message" button;
        // it has no onclick of its own, so Enter/Space (kbdHandleActivation -> click())
        // and mouse clicks both bubble to the row's scrollToMessage exactly once.
        screenshots.forEach(function(item, i) {
            var screenshot = item.msg;
            var screenshotName = screenshot.name || screenshot.description || t('Screenshot {n}', { n: i + 1 });
            html += '<div class="screenshot-sidebar-item" onclick="scrollToMessage(' + item.idx + ')">' +
                '<img class="screenshot-sidebar-thumb" role="button" tabindex="0" data-kbd-click src="' + screenshot.base64 + '" alt="' + escapeHtml(screenshotName) + '" onclick="event.stopPropagation();openScreenshotModal(this.src, \'' + escapeJsString(screenshotName) + '\')" />' +
                '<div class="screenshot-sidebar-info" role="button" tabindex="0" data-kbd-click>' +
                '<span class="screenshot-sidebar-title">' + escapeHtml(screenshotName) + '</span>' +
                '<span class="screenshot-sidebar-size">' + screenshot.width + '×' + screenshot.height + '</span>' +
                '</div>' +
                '<button class="screenshot-sidebar-btn" onclick="event.stopPropagation();downloadScreenshotFromSidebar(\'' + i + '\')" title="' + t('Download') + '">' + UI_ICONS.download + '</button>' +
            '</div>';
        });
        pdfAttachments.forEach(function(item, i) {
            var pdfMsg = item.msg;
            var pdfName = pdfMsg.name || pdfMsg.description || t('Document {n}', { n: i + 1 });
            html += '<div class="screenshot-sidebar-item" onclick="scrollToMessage(' + item.idx + ')">' +
                '<div class="screenshot-sidebar-thumb pdf-sidebar-thumb" role="button" tabindex="0" data-kbd-click aria-label="' + escapeHtml(t('View file')) + '" onclick="event.stopPropagation();openPdfFromMessage(' + item.idx + ')">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
                '</div>' +
                '<div class="screenshot-sidebar-info" role="button" tabindex="0" data-kbd-click>' +
                '<span class="screenshot-sidebar-title">' + escapeHtml(pdfName) + '</span>' +
                '<span class="screenshot-sidebar-size">PDF</span>' +
                '</div>' +
                '<button class="screenshot-sidebar-btn" onclick="event.stopPropagation();downloadPdfFromSidebar(' + i + ')" title="' + t('Download') + '">' + UI_ICONS.download + '</button>' +
            '</div>';
        });
        fileAttachments.forEach(function(item, i) {
            var fileMsg = item.msg;
            var fileName = fileMsg.name || t('File {n}', { n: i + 1 });
            var fileExt = fileName.split('.').pop().toUpperCase();
            var fileSize = fileMsg.size ? formatFileSize(fileMsg.size) : '';
            html += '<div class="screenshot-sidebar-item" onclick="scrollToMessage(' + item.idx + ')">' +
                '<div class="screenshot-sidebar-thumb" style="background:var(--secondary-lighter);border:1px solid var(--secondary-border);color:var(--success);display:flex;align-items:center;justify-content:center;cursor:pointer;" role="button" tabindex="0" data-kbd-click aria-label="' + escapeHtml(t('View file')) + '" onclick="event.stopPropagation();openFileFromMessage(' + item.idx + ')">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
                '</div>' +
                '<div class="screenshot-sidebar-info" role="button" tabindex="0" data-kbd-click>' +
                '<span class="screenshot-sidebar-title">' + escapeHtml(fileName) + '</span>' +
                '<span class="screenshot-sidebar-size">' + fileExt + (fileSize ? ' · ' + fileSize : '') + '</span>' +
                '</div>' +
                '<button class="screenshot-sidebar-btn" onclick="event.stopPropagation();downloadFileFromSidebar(' + i + ')" title="' + t('Download') + '">' + UI_ICONS.download + '</button>' +
            '</div>';
        });
        html += '</div>';
        html += '</div>';
    }

    // Show active changes section
    if (changedFiles.length > 0) {
        // Workspace Artifacts header
        html += '<div class="version-artifacts-header">' + (changedFiles.length === 1 ? t('Artifacts') : t('Artifacts ({count})', { count: changedFiles.length })) + '</div>';

        // List each changed file with icon buttons
        html += '<div class="version-files-list">';
        changedFiles.forEach(function(file, fileIdx) {
            var isNew = file.changes.some(function(c) { return c.action === 'POST'; });
            var hasEdit = file.changes.some(function(c) { return c.action === 'PUT' || c.action === 'PATCH'; });
            var changeCount = file.changes.length;

            var firstBeforeVersion = getFirstVersionForRecord(file.table, file.sysId);
            var tableIcon = getTableIcon(file.table);
            var tableDisplayName = t(getTableDisplayName(file.table));
            var statusBadge = isNew ? '<span class="sn-status-badge sn-status-new">' + t('NEW') + '</span>' : (hasEdit ? '<span class="sn-status-badge sn-status-modified">' + t('MODIFIED') + '</span>' : '');
            var changesBadge = changeCount > 1 ? '<span class="sn-changes-badge">' + tn(changeCount, '{count} change', '{count} changes') + '</span>' : '';

            // Escape values for JS
            var jsTable = escapeJsString(file.table);
            var jsSysId = escapeJsString(file.sysId);
            var jsDisplayName = escapeJsString(file.displayName);

            html += '<div class="sn-artifact-card sidebar-card">';
            html += '<div class="sn-artifact-icon sn-icon-' + file.table.replace(/_/g, '-') + '">' + tableIcon + '</div>';
            html += '<div class="sn-artifact-content">';
            html += '<div class="sn-artifact-name">' + escapeHtml(file.displayName) + '</div>';
            html += '<div class="sn-artifact-meta">(' + tableDisplayName + ') ' + statusBadge + changesBadge + (file.worker ? ' <span class="wsf-ws" title="' + t('Edited by worker {worker}', { worker: escapeHtml(file.worker) }) + '">' + escapeHtml(file.worker) + '</span>' : '') + '</div>';
            html += '</div>';
            html += '<div class="sn-artifact-actions-row">';
            // View diff button
            html += '<button class="sn-artifact-icon-btn" onclick="openDiffViewer(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="' + t('View changes') + '">' + UI_ICONS.eye + '</button>';
            // Download button
            html += '<button class="sn-artifact-icon-btn" onclick="downloadSingleFile(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="' + t('Download XML') + '">' + UI_ICONS.download + '</button>';
            // Open in browser for UI pages
            if (file.table === 'sys_ui_page') {
                html += '<button class="sn-artifact-icon-btn" onclick="openUIPageInBrowser(\'' + jsDisplayName + '\')" title="' + t('Open in Browser') + '">' + UI_ICONS.globe + '</button>';
                html += '<button class="sn-artifact-icon-btn" onclick="screenshotUIPage(\'' + jsDisplayName + '\')" title="' + t('Screenshot') + '">' + UI_ICONS.camera + '</button>';
            }
            // Revert button (or delete for new files)
            if (isNew) {
                html += '<button class="sn-artifact-icon-btn danger" onclick="deleteNewRecordFromSidebar(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="' + t('Delete') + '">' + UI_ICONS.trash + '</button>';
            } else if (firstBeforeVersion) {
                html += '<button class="sn-artifact-icon-btn" onclick="revertFileToBeforeChat(\'' + firstBeforeVersion + '\', \'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="' + t('Revert') + '">' + UI_ICONS.undo + '</button>';
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
            // Accept legacy (doc_<epoch>_<rand>) AND human-readable slug doc ids.
            var dre = /<!--document:([A-Za-z0-9_-]+)-->/g;
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
        html += '<div class="version-section-title">' + UI_ICONS.file + ' ' + t('Documents ({count})', { count: chatDocs.length }) + '</div>';
        html += '<div class="documents-sidebar-list">';
        chatDocs.forEach(function(doc) {
            html += '<div class="sdoc-sidebar-item" role="button" tabindex="0" data-kbd-click onclick="sdocOpenPreview(\'' + escapeJsString(doc.id) + '\')" title="' + escapeHtml(doc.title) + '">';
            html += '<span class="sdoc-sidebar-icon">' + UI_ICONS.file + '</span>';
            html += '<span class="sdoc-sidebar-name">' + escapeHtml(doc.title) + '</span>';
            html += '<span class="sdoc-sidebar-ver">' + t('v{version}', { version: doc.currentVersion }) + '</span>';
            html += '</div>';
        });
        html += '</div>';
        html += '</div>';
    }

    html += '</div>'; // end version-sidebar-content
    
    // Skip the rebuild when the markup is unchanged and our root is still in
    // place: replacing identical nodes under the pointer restarts hover
    // transitions and makes the PR chip flash on every message render.
    // Compared against the generated html (before the workers strip / self
    // card refills below mutate the live DOM).
    var _vsUnchanged = container.__lastHtml === html && !!container.querySelector('.version-sidebar-content');
    if (!_vsUnchanged) {
        container.innerHTML = html;
        container.__lastHtml = html;
    }

    // Brand-new chat: no PRs, progress, changes, widgets, screenshots or
    // documents yet — only the hidden placeholder hosts are present. Show a
    // friendly empty state instead of a blank rail.
    var _vsc = container.querySelector('.version-sidebar-content');
    if (!_vsUnchanged && _vsc && !_vsc.querySelector(':scope > :not(#sub-self-parent-host):not(#sub-self-card-host):not(#sidebar-workers)')) {
        var _vsEmpty = document.createElement('div');
        _vsEmpty.className = 'version-sidebar-empty';
        _vsEmpty.textContent = t('Changes, pull requests and artifacts from this chat will appear here.');
        _vsc.appendChild(_vsEmpty);
    }
    
    // The Workers placeholder was just recreated empty by the innerHTML
    // rebuild above — repopulate it from the live sub-agent registry.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
    // Same deal for the sub-agent self card host (sub-agent chats only):
    // the rebuild recreated it empty + hidden, repopulate it.
    if (typeof updateSubAgentSelfCard === 'function') {
        try { updateSubAgentSelfCard(); } catch (e) {}
    }

    // Reapply the user's position after the rebuilt content and live worker
    // cards are back in the DOM. Restore both candidates so this remains safe
    // if the flex layout changes which node owns overflow scrolling.
    _restoreVersionSidebarScroll(container, savedSidebarScroll);
}

// Redo changes that were previously reverted
async function redoFileChanges(versionSysId, table, sysId, displayName) {
    if (!await showConfirmModal(t('Redo Changes'), t('Redo changes to "{name}"? This will restore the AI-made changes.', { name: escapeHtml(displayName) }))) return;
    
    try {
        showSpinner(t('Restoring {name}...', { name: displayName }));
        
        var xml = await getVersionXml(versionSysId);
        if (!xml) {
            hideSpinner();
            showSnackbar(t('Could not get version data'), 'error');
            return;
        }

        var result = await uploadXml(xml, table, sysId);
        hideSpinner();

        if (result.success) {
            // Un-invalidate the original changes and drop the REVERT entry —
            // across the active chat AND its sub-agent chats (the entries may
            // be owned by a sub chat, see getVersionHistorySources).
            setRecordEntriesInvalidated(table, sysId, false);
            removeRevertEntriesForRecord(table, sysId);

            saveVersionHistory();
            renderVersionSidebar();
            renderMessages();

            showSnackbar(t('Successfully restored "{name}"', { name: displayName }), 'success');
        } else {
            showSnackbar(t('Redo failed: {error}', { error: result.error }), 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar(t('Redo failed: {error}', { error: e.message }), 'error');
    }
}

// Redo all reverted changes
async function redoAllChanges() {
    var revertedFiles = getRevertedFiles();
    if (revertedFiles.length === 0) {
        showSnackbar(t('No reverted changes to redo'), 'warning');
        return;
    }
    
    if (!await showConfirmModal(t('Redo All'), tn(revertedFiles.length, 'Redo {count} reverted file? This will restore all AI-made changes.', 'Redo all {count} reverted files? This will restore all AI-made changes.'))) return;
    
    showSpinner(tn(revertedFiles.length, 'Restoring {count} file...', 'Restoring {count} files...'));
    var successCount = 0;
    var errors = [];
    
    for (var i = 0; i < revertedFiles.length; i++) {
        var file = revertedFiles[i];
        try {
            var latestAfterVersion = getLatestAfterVersion(file.table, file.sysId);
            if (!latestAfterVersion) {
                errors.push(t('{name}: No version to restore', { name: file.displayName }));
                continue;
            }
            
            var xml = await getVersionXml(latestAfterVersion);
            if (!xml) {
                errors.push(t('{name}: Could not get version data', { name: file.displayName }));
                continue;
            }
            
            var result = await uploadXml(xml, file.table, file.sysId);
            if (result.success) {
                successCount++;
                // Un-invalidate entries + drop REVERT markers for this file —
                // across the active chat and its sub-agent chats.
                setRecordEntriesInvalidated(file.table, file.sysId, false);
                removeRevertEntriesForRecord(file.table, file.sysId);
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
        showSnackbar(tn(revertedFiles.length, 'Restored {success} of {count} file.', 'Restored {success} of {count} files.', { success: i18nFormatNumber(successCount) }) + '\n\n' + t('Errors:') + '\n' + errors.join('\n'), 'warning');
    } else {
        showSnackbar(tn(successCount, 'Successfully restored {count} file', 'Successfully restored {count} files'), 'success');
    }
}

// Revert a single file to its state before this chat
async function revertFileToBeforeChat(versionSysId, table, sysId, displayName) {
    if (!await showConfirmModal(t('Undo All Changes'), t('Undo all changes to "{name}"? This will restore the file to how it was before this chat session.', { name: escapeHtml(displayName) }))) return;
    
    try {
        showSpinner(t('Reverting {name}...', { name: displayName }));
        
        var xml = await getVersionXml(versionSysId);
        if (!xml) {
            hideSpinner();
            showSnackbar(t('Could not get version data'), 'error');
            return;
        }
        
        var result = await uploadXml(xml, table, sysId);
        hideSpinner();
        
        if (result.success) {
            // Mark all entries for this file as invalidated — across the
            // active chat and its sub-agent chats (the owning chat may be a
            // sub chat whose artifact rolled up into this sidebar).
            setRecordEntriesInvalidated(table, sysId, true);
            
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
            
            showSnackbar(t('Successfully reverted "{name}"', { name: displayName }), 'success');
        } else {
            showSnackbar(t('Revert failed: {error}', { error: result.error }), 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar(t('Revert failed: {error}', { error: e.message }), 'error');
    }
}

// Revert all changes in this chat
async function revertAllChanges() {
    var changedFiles = getAllChangedFiles();
    if (changedFiles.length === 0) {
        showSnackbar(t('No changes to revert'), 'warning');
        return;
    }
    
    var fileNames = changedFiles.map(function(f) { return escapeHtml(f.displayName); }).join(', ');
    if (!await showConfirmModal(t('Undo All Changes'), t('Undo ALL changes made in this chat? This will revert: {files}. You can always redo these changes later.', { files: fileNames }))) return;
    
    var successCount = 0;
    var failCount = 0;
    
    showSpinner(t('Reverting all changes...'));
    
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
                    setRecordEntriesInvalidated(file.table, file.sysId, true);
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
                    setRecordEntriesInvalidated(file.table, file.sysId, true);
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
        showSnackbar(tn(successCount, 'Successfully reverted {count} file', 'Successfully reverted all {count} files'), 'success');
    } else {
        showSnackbar(tn(successCount, 'Reverted {count} file, {failed} failed', 'Reverted {count} files, {failed} failed', { failed: i18nFormatNumber(failCount) }), 'warning');
    }
}
