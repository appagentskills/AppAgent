// =============================================
// Sub-Agent UI — sidebar breadcrumb, Workers strip, sub_report rendering.
// =============================================
// The runtime lives in src/js/core/097-sub-agent-registry.js; this file
// is the rendering layer. Three surfaces:
//
//   1. sub_report messages — rendered as a styled callout inline in the
//      parent chat history (called from 250-message-render.js).
//   2. Sidebar breadcrumb — a "↳ parent: …" pill on sub-agent chat list
//      rows so the user knows the chat is a delegated worker.
//   3. Workers strip — a compact chip row above the chat input in any
//      chat that owns live sub-agents. Each chip = one sub, with state
//      pill and a click-through into the sub's chat.
//
// Listener: every render path re-derives state from SubAgents.listAll() +
// SubAgents.poolSnapshot(). The registry calls notify on every mutation
// (spawn/report/stop/sleep/wake), and we subscribe via SubAgents.addListener.

// ---------- sub_report renderer (called from 250-message-render.js) ----------

// Whitelist of accepted statuses for class-name interpolation. Defense-in-
// depth: report.status is server-validated, but if any future code path
// pushes a sub_report row with an unsanitized status the class attribute
// stays safe.
var SUB_REPORT_STATUSES = { done: 1, error: 1, partial: 1, need_input: 1, cancelled: 1 };

function renderSubReport(msg, index) {
    var report = msg.report || {};
    var rawStatus = report.status || 'partial';
    var status = SUB_REPORT_STATUSES[rawStatus] ? rawStatus : 'partial';
    var statusClass = 'sub-report-' + status;
    var icon = (status === 'done') ? '✓'
             : (status === 'error') ? '✕'
             : (status === 'need_input') ? '?'
             : '…';
    var summary = report.summary || '';
    var name = msg.subAgentName || report.from_name || msg.subAgentId || 'sub-agent';
    var artifactsHtml = '';
    if (Array.isArray(report.artifacts) && report.artifacts.length) {
        var chips = report.artifacts.map(function(a) {
            return '<span class="sub-report-artifact" title="' + escapeHtml(a) + '">' + escapeHtml(a) + '</span>';
        }).join('');
        artifactsHtml = '<div class="sub-report-artifacts">artifacts: ' + chips + '</div>';
    }
    var dataHtml = '';
    if (report.data && typeof report.data === 'object') {
        try {
            var json = JSON.stringify(report.data, null, 2);
            // Soft cap on inline data display — anything bigger should be in artifacts.
            if (json.length > 800) json = json.slice(0, 800) + '\n…[truncated; see artifacts]';
            dataHtml = '<details class="sub-report-data"><summary>data</summary><pre>' + escapeHtml(json) + '</pre></details>';
        } catch (e) { /* ignore */ }
    }
    // Resolve the sub's chat for the "open transcript" link. Prefer the
    // live registry record (most accurate, follows chat_id changes), but
    // fall back to msg.subChatId persisted on the message itself — the
    // registry GCs settled sub-agent records after SUBAGENT_TOMBSTONE_TTL_MS
    // (~1h) and without this fallback every historical sub_report row
    // silently loses its navigation button once the record is purged.
    var openLink = '';
    var targetChatId = null;
    if (msg.subAgentId && typeof SubAgents !== 'undefined' && SubAgents.getById) {
        var rec = SubAgents.getById(msg.subAgentId);
        if (rec && rec.chat_id) targetChatId = rec.chat_id;
    }
    if (!targetChatId && msg.subChatId) targetChatId = msg.subChatId;
    // Verify the chat record actually still exists before offering the link.
    if (targetChatId && typeof chats !== 'undefined' && chats[targetChatId]) {
        // Use data-sub-chat-id + delegated listener (see _wireSubAgentUi)
        // instead of inline onclick. escapeHtml escapes both quote flavors
        // (see 180-search.js) so attribute interpolation is safe. Use
        // <button type="button"> so screen readers don't announce
        // "javascript:void link" and so it can't accidentally submit if
        // nested in a form.
        //
        // Label is "open chat" (not "open transcript") to match the rest of
        // the UI vocabulary — every other navigation in the app talks about
        // chats, not transcripts. The leading icon is an inline chat-bubble
        // SVG (currentColor so it inherits hover state) so the button reads
        // as a real action target rather than a text link. flex-shrink:0 +
        // white-space:nowrap on the button (CSS) keep it on one line even
        // when the preview text would otherwise push it to wrap.
        var chatIconSvg = '<svg class="sub-report-open-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        openLink = '<button type="button" class="sub-report-open" data-sub-chat-id="' + escapeHtml(targetChatId) + '" title="Open this sub-agent\u2019s chat">' + chatIconSvg + '<span class="sub-report-open-label">open chat</span></button>';
    }
    var synth = report._synthesized ? '<span class="sub-report-synth" title="No explicit report_to_parent — fallback summary from last assistant message">auto</span>' : '';
    // Phase-5 follow-up: the sub_report panel is now COLLAPSED by default —
    // a long markdown report from a sub used to dominate the scrollback the
    // moment it landed. The <summary> row stays visible (icon + name +
    // status + one-line preview + "open transcript") so the parent agent can
    // see at a glance what came back; clicking the row expands the full
    // markdown body. Native <details> handles the toggle — no extra JS.
    //
    // The summary text is now rendered through formatContent() so subs can
    // report rich markdown (headings, lists, code blocks, tables). The
    // global delegated click listener calls preventDefault() on any
    // [data-sub-chat-id] / [data-sub-agent-reveal] hit, which cancels the
    // <details> toggle as well — so clicking "open transcript" reveals
    // the sub's chat without toggling the panel.
    var summaryRendered = (typeof formatContent === 'function' && summary)
        ? formatContent(summary)
        : ('<span class="md-paragraph">' + escapeHtml(summary) + '</span>');
    // One-line preview for the collapsed header. Strip markdown noise so the
    // preview reads as plain text: leading `#` headings, list bullets, bold
    // markers, inline code backticks. Cap at 140 chars + ellipsis.
    var previewSrc = (summary.split('\n').find(function(l) { return l.trim().length > 0; }) || '')
        .replace(/^#+\s*/, '')
        .replace(/^[-*]\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
    var preview = previewSrc.length > 140 ? (previewSrc.slice(0, 140) + '…') : previewSrc;
    var previewHtml = preview ? '<span class="sub-report-preview">' + escapeHtml(preview) + '</span>' : '';
    // Auto-open reports that need the parent's attention: error reports so
    // failures aren't hidden behind a chevron, and need_input reports since
    // the parent literally cannot continue without reading them. `done`,
    // `partial`, `cancelled` stay collapsed (the preview line + status
    // badge is enough at-a-glance, and these tend to be the verbose ones).
    var defaultOpen = (status === 'error' || status === 'need_input') ? ' open' : '';
    return '<details' + defaultOpen + ' class="message sub-report ' + statusClass + '" id="msg-' + index + '">' +
        '<summary class="sub-report-header">' +
            '<span class="sub-report-chevron" aria-hidden="true"></span>' +
            '<span class="sub-report-icon" aria-hidden="true">' + icon + '</span>' +
            '<span class="sub-report-name">' + escapeHtml(name) + '</span>' +
            '<span class="sub-report-status">' + escapeHtml(status) + '</span>' +
            synth +
            previewHtml +
            openLink +
        '</summary>' +
        '<div class="sub-report-body">' +
            '<div class="sub-report-summary markdown-body">' + summaryRendered + '</div>' +
            artifactsHtml +
            dataHtml +
        '</div>' +
    '</details>';
}

// Used by the "open transcript →" link on a sub_report callout and by the
// Workers strip chips. Reveals the sub's background chat in the sidebar
// (background chats are normally hidden) and switches into it.
// Resolves a chat id from either an agent id (preferred, follows live
// registry record) or a direct chat id (used when the registry has GC'd
// the settled sub-agent record).
function revealSubAgentChat(idOrChatId) {
    if (!idOrChatId) return;
    var chatId = null;
    if (typeof SubAgents !== 'undefined' && SubAgents.getById) {
        var rec = SubAgents.getById(idOrChatId);
        if (rec && rec.chat_id) chatId = rec.chat_id;
    }
    // Direct chat-id fallback (registry-purged case, or caller passed a
    // chat id directly via data-sub-chat-id).
    if (!chatId) chatId = idOrChatId;
    var chat = (typeof chats !== 'undefined') ? chats[chatId] : null;
    // Stale-sub guard: the chat record may have been deleted (manual cleanup,
    // version drift, etc.). Bail out cleanly instead of crashing selectChat.
    if (!chat) return;
    if (chat.isBackground && !chat._revealed) {
        chat._revealed = true;
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    }
    if (typeof selectChat === 'function') selectChat(chatId);
}

// ---------- Sidebar breadcrumb (called from chat list renderer) ----------
// Returns an HTML fragment to inject into a chat list row when the chat is
// a sub-agent. The chat list renderer hooks this in by name; if the hook
// is missing (older list renderer), nothing breaks.
function renderSubAgentBreadcrumb(chat) {
    if (!chat || !chat.isSubAgent) return '';
    if (typeof chats === 'undefined') return '';
    // Phase 5: walk the parentChatId chain upward to assemble the full
    // ancestor path (root → … → immediate parent). The current chat
    // itself is the tail and isn't repeated in the breadcrumb. A hard
    // depth cap guards against accidental cycles in chat data.
    var chain = []; // ordered root-first
    var cur = chat;
    var guard = 0;
    // Cycle protection: a corrupted chat record could form a parentChatId
    // cycle (e.g. file-format drift, manual IDB edit, restore-from-backup
    // mismatch). Without `seen` the loop would walk the cycle 32 times
    // and render 32 duplicate breadcrumb entries before the depth cap
    // bailed it out. `_ancestorChain` in the registry uses the same
    // belt-and-braces pattern (cap + seen set).
    var seen = Object.create(null);
    while (cur && cur.parentChatId && guard < 32) {
        if (seen[cur.parentChatId]) break;
        seen[cur.parentChatId] = true;
        var parent = chats[cur.parentChatId];
        if (!parent) {
            // Unknown / GC'd ancestor — keep a placeholder so depth still
            // reflects the real chain length.
            chain.unshift({ id: cur.parentChatId, title: 'parent', missing: true });
            break;
        }
        chain.unshift({ id: cur.parentChatId, title: parent.title || 'parent' });
        cur = parent;
        guard++;
    }
    if (!chain.length) return '';
    var depth = chain.length;
    // Collapse the middle when depth > 3 so the row stays narrow:
    //   root › … › immediate-parent
    var rendered = (depth > 3)
        ? [chain[0], { ellipsis: true }, chain[chain.length - 1]]
        : chain.slice();
    var parts = rendered.map(function(node) {
        if (node.ellipsis) return '<span class="breadcrumb-ellipsis">\u2026</span>';
        return '<a class="breadcrumb-link" data-sub-agent-reveal="' + escapeHtml(node.id) + '" title="' + escapeHtml(node.title) + '">' + escapeHtml(node.title) + '</a>';
    });
    var tip = chain.map(function(n) { return n.title; }).join(' \u203a ');
    // `--depth` drives the CSS indent (attr() inside calc() is not portable
    // cross-browser, so we stamp the value as a custom property too).
    return '<div class="sub-agent-breadcrumb" data-depth="' + depth + '" style="--depth:' + depth + '" title="Sub-agent of: ' + escapeHtml(tip) + '">\u21b3 ' + parts.join(' \u203a ') + '</div>';
}

// ---------- Workers strip (above chat input in parent chats) ----------
// Renders chips for every live sub owned by the active chat. Click a chip
// to open the sub's transcript. State drives the pill color.

function renderWorkersStrip() {
    var stripEl = document.getElementById('workers-strip');
    if (!stripEl) return;
    if (typeof SubAgents === 'undefined' || !SubAgents.listAll) { stripEl.innerHTML = ''; stripEl.style.display = 'none'; return; }
    if (typeof currentChatId === 'undefined' || !currentChatId) { stripEl.innerHTML = ''; stripEl.style.display = 'none'; return; }
    var all = SubAgents.listAll();
    var currentChat = (typeof chats !== 'undefined') ? chats[currentChatId] : null;
    var isCurrentSub = !!(currentChat && currentChat.isSubAgent);
    // Phase 5: filter the subtree visible from currentChatId.
    //   - regular chat: every descendant in the subtree. `root_chat_id`
    //     match covers grand- and great-grand-children; `parent_chat_id`
    //     match keeps direct children visible on legacy records that
    //     pre-date Phase 5 and have no root_chat_id stamped.
    //   - sub-agent chat: only direct children + grandchildren of the
    //     sub, so drilling into a worker shows its own immediate tree
    //     rather than the entire root subtree again.
    var mine;
    if (isCurrentSub) {
        var directChildChatIds = Object.create(null);
        for (var i = 0; i < all.length; i++) {
            if (all[i].parent_chat_id === currentChatId && all[i].chat_id) {
                directChildChatIds[all[i].chat_id] = true;
            }
        }
        mine = all.filter(function(r) {
            return r.parent_chat_id === currentChatId || directChildChatIds[r.parent_chat_id];
        });
    } else {
        mine = all.filter(function(r) {
            // Legacy records (pre-Phase-5) lack root_chat_id — fall back to
            // treating parent_chat_id as the root so they're not orphaned.
            var root = r.root_chat_id || r.parent_chat_id;
            return root === currentChatId || r.parent_chat_id === currentChatId;
        });
    }
    if (!mine.length) { stripEl.innerHTML = ''; stripEl.style.display = 'none'; return; }
    // Sort: running, sleeping, then terminal (most-recent first).
    var rank = { running: 0, sleeping: 1, stopped: 2, errored: 3 };
    mine.sort(function(a, b) {
        var ra = rank[a.state] != null ? rank[a.state] : 4;
        var rb = rank[b.state] != null ? rank[b.state] : 4;
        if (ra !== rb) return ra - rb;
        return (b.last_activity_at || 0) - (a.last_activity_at || 0);
    });
    // Whitelist worker state for the class-name interpolation — same
    // defense-in-depth rationale as SUB_REPORT_STATUSES above.
    var WORKER_STATES = { running: 1, sleeping: 1, stopped: 1, errored: 1 };
    var chips = mine.map(function(r) {
        var label = r.name || r.agent_id;
        var stateClass = WORKER_STATES[r.state] ? r.state : 'unknown';
        var stateLabel = r.state;
        // Phase 5: legacy records may lack `depth` — default to 1
        // (direct child of root). Cap the rendered depth at 3 to match
        // the CSS rule ladder; deeper trees still get the level-3 indent
        // instead of marching off-screen on pathological chains.
        var depth = (typeof r.depth === 'number' && r.depth > 0) ? r.depth : 1;
        var renderDepth = Math.min(depth, 3);
        // Inline onclick removed (escapeHtml does not escape single quotes,
        // so an attacker-controlled or even unusual id could break out of
        // the JS string). Delegated click listener handles `data-sub-agent-reveal`.
        return '<button class="worker-chip worker-' + stateClass + '" ' +
            'data-sub-agent-reveal="' + escapeHtml(r.agent_id) + '" ' +
            'data-depth="' + renderDepth + '" ' +
            'title="' + escapeHtml(label) + ' \u2014 ' + escapeHtml(r.state) + ' \u2014 ' + escapeHtml(String(r.tool_calls_used || 0)) + '/' + escapeHtml(String(r.max_tool_calls || '?')) + ' tool calls \u2014 depth ' + escapeHtml(String(depth)) + '">' +
            '<span class="worker-state-dot worker-dot-' + stateClass + '"></span>' +
            '<span class="worker-name">' + escapeHtml(label) + '</span>' +
            '<span class="worker-state">' + escapeHtml(stateLabel) + '</span>' +
        '</button>';
    }).join('');
    stripEl.innerHTML = '<div class="workers-strip-label">Workers (' + mine.length + ')</div>' +
        '<div class="workers-strip-chips">' + chips + '</div>';
    stripEl.style.display = '';
}

// ---------- Boot wiring ----------
// Subscribe to registry events so the strip + chat list re-render on any
// sub-agent state change. Guarded so this file is safe to load before the
// registry module if file ordering ever changes.
(function _wireSubAgentUi() {
    // Coalesce registry notifications: every sub-agent state mutation
    // (heartbeat tick, tool-call counter, last_activity timestamp) fires
    // a listener call. Without coalescing this re-runs renderChatList +
    // renderMessages on every tick — with 4 live subs that's many fps
    // of expensive DOM churn. requestAnimationFrame collapses bursts to
    // at most one repaint per frame. The chat-list refresh is the most
    // expensive (scans every chat), so it's also gated on whether the
    // chips actually changed shape, not just on heartbeat.
    var _renderScheduled = false;
    // Cached keys are scoped by currentChatId so chat-switches don't
    // collide (chat A with 3 sub_reports → chat B with also 3 used to
    // false-match and skip renderMessages). Include the chat id in the
    // key itself instead of resetting on every selectChat hook.
    var _lastSubReportKey = null;
    var _lastChipKey = null;
    // Track chips set + chat-id together so that the chip key for chat A
    // never matches the chip key for chat B even if their workers happen
    // to be in identical states. Same scoping rationale as above.
    function _chipKey() {
        if (typeof SubAgents === 'undefined' || !SubAgents.listAll) return '';
        if (typeof currentChatId === 'undefined' || !currentChatId) return '';
        // Phase 5: include the full subtree (depth >1) in the key so a
        // grandchild's state change triggers a strip repaint. Without this,
        // the rAF-coalesced renderer would compare only direct children and
        // miss running→stopped on a nested sub. Match the visibility filter
        // used by renderWorkersStrip (root_chat_id or direct parent_chat_id
        // for regular chats; direct + grandchildren when current is a sub).
        var isSubChat = !!(typeof chats !== 'undefined' && chats[currentChatId] && chats[currentChatId].isSubAgent);
        var directChildChatIds = Object.create(null);
        if (isSubChat) {
            var all0 = SubAgents.listAll();
            for (var ii = 0; ii < all0.length; ii++) {
                if (all0[ii].parent_chat_id === currentChatId) directChildChatIds[all0[ii].chat_id] = true;
            }
        }
        var rows = SubAgents.listAll()
            .filter(function(r) {
                if (isSubChat) {
                    return r.parent_chat_id === currentChatId || directChildChatIds[r.parent_chat_id];
                }
                return r.parent_chat_id === currentChatId
                    || (r.root_chat_id || r.parent_chat_id) === currentChatId;
            })
            .map(function(r) { return r.agent_id + ':' + r.state + ':' + (r.depth || 1); });
        rows.sort();
        return currentChatId + '|' + rows.join('|');
    }
    function _subReportKey() {
        if (typeof currentChatId === 'undefined' || !currentChatId) return '';
        if (typeof chats === 'undefined' || !chats[currentChatId]) return '';
        var msgs = chats[currentChatId].messages || [];
        var n = 0;
        for (var i = 0; i < msgs.length; i++) if (msgs[i].role === 'sub_report') n++;
        return currentChatId + ':' + n;
    }
    function _doRender() {
        _renderScheduled = false;
        // Only repaint the Workers strip when chip shape/state actually
        // changed. Heartbeat ticks (tool_calls_used++, last_activity_at)
        // fire the registry listener constantly, and rebuilding the
        // <button> innerHTML on every tick restarts the `worker-pulse`
        // CSS animation on running dots, making them visibly stutter.
        // Note: the title attribute carries tool-call counters that DO
        // change between repaints; that's fine — hovering a chip mid-
        // animation is rare, and stuttering animations are the more
        // visible regression.
        try {
            var key = _chipKey();
            if (key !== _lastChipKey) {
                _lastChipKey = key;
                renderWorkersStrip();
                if (typeof renderChatList === 'function') renderChatList();
            }
        } catch (_) {}
        // Re-render messages only when a sub_report was actually appended
        // to the active chat — not on every registry tick. Key includes
        // chat id so chat-switches between chats with equal sub_report
        // counts still trigger a repaint.
        try {
            var sk = _subReportKey();
            if (sk !== _lastSubReportKey) {
                _lastSubReportKey = sk;
                if (typeof renderMessages === 'function') renderMessages();
            }
        } catch (_) {}
    }
    function onChange() {
        if (_renderScheduled) return;
        _renderScheduled = true;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(_doRender);
        } else {
            setTimeout(_doRender, 16);
        }
    }

    // Delegated click listener for [data-sub-agent-reveal] elements
    // (Workers strip chips and sub_report "open transcript" links).
    // Replaces the prior inline onclick handlers — escapeHtml does NOT
    // escape single quotes, which made the inline form an XSS surface
    // if any agent_id ever contained one.
    if (typeof document !== 'undefined') {
        document.addEventListener('click', function(evt) {
            var t = evt.target;
            while (t && t !== document) {
                if (t.getAttribute) {
                    // data-sub-agent-reveal carries an agent_id (resolved
                    // via registry); data-sub-chat-id carries a direct
                    // chat id (used for sub_report links so they keep
                    // working after the registry GCs the settled record).
                    var aid = t.getAttribute('data-sub-agent-reveal');
                    var cid = t.getAttribute('data-sub-chat-id');
                    if (aid || cid) {
                        revealSubAgentChat(aid || cid);
                        evt.preventDefault();
                        return;
                    }
                    // "Open parent" affordance on the chat-title sub-agent
                    // pill (see updateChatTitleHeader in 170-chat-management.js).
                    // Routes via selectChat so the chat list expands / scrolls
                    // / etc. just like a normal click on the sidebar row.
                    var openParent = t.getAttribute('data-open-parent-chat-id');
                    if (openParent) {
                        if (typeof selectChat === 'function') {
                            try { selectChat(openParent); } catch (_) { /* ignore */ }
                        }
                        evt.preventDefault();
                        return;
                    }
                }
                t = t.parentNode;
            }
        });
    }
    if (typeof SubAgents !== 'undefined' && SubAgents.addListener) {
        SubAgents.addListener(onChange);
    } else if (typeof window !== 'undefined') {
        // Defer until SubAgents shows up. If a sub_agent record is created
        // BEFORE the listener attaches (e.g. file ordering accidentally
        // loaded the UI module after a quick agent loop has already spawned
        // a sub), we'd miss the initial state-change notify and the chip
        // would not appear until the sub's next state transition — which
        // is usually `stopped`. That precisely matches a long-standing
        // complaint that running subs are invisible. After the late
        // attach, kick a one-shot onChange() so we pick up anything that
        // already exists in the registry.
        var tries = 0;
        var iv = setInterval(function() {
            if (typeof SubAgents !== 'undefined' && SubAgents.addListener) {
                SubAgents.addListener(onChange);
                clearInterval(iv);
                try { onChange(); } catch (_) {}
            } else if (++tries > 50) {
                clearInterval(iv);
            }
        }, 100);
    }
    // Initial paint after a tick so the DOM is ready and currentChatId is set.
    if (typeof window !== 'undefined') {
        setTimeout(function() {
            try { renderWorkersStrip(); } catch (_) {}
        }, 0);
    }
})();
