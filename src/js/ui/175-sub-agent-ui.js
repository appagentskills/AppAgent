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
var SUB_REPORT_STATUSES = { done: 1, error: 1, partial: 1, need_input: 1, cancelled: 1, running: 1, waiting: 1 };

// Review-state badge palette (Orchestrator §3 deliverable review flow).
// Keys = the review_state values the registry persists on a sub record:
// 'pending' (auto on every report_to_parent) → 'accepted' /
// 'revision_requested' (parent verdict via wake_sub_agent's review_state
// arg) / 'cross_checked' (independent reviewer sub aimed at it). Unknown or
// missing values render no badge. Inline styles keep the badge
// self-contained (no companion CSS edit needed).
var SUB_REVIEW_BADGES = {
    pending:            { label: 'review pending',     bg: '#5c4d10', fg: '#ffe289' },
    accepted:           { label: 'accepted',           bg: '#1d5c2e', fg: '#a9f5c1' },
    revision_requested: { label: 'revision requested', bg: '#6b271d', fg: '#ffbfae' },
    cross_checked:      { label: 'cross-checked',      bg: '#1d3f6b', fg: '#aecdf5' }
};

// User open/collapse choices for sub-report cards, keyed by a stable
// per-card key. renderMessages rebuilds the chat
// innerHTML on every repaint (each progress append / live-state change),
// which would otherwise snap a user-collapsed live card back open and shut
// a user-opened data panel. Session-scoped on purpose — defaults win again
// after a reload.
var _subReportOpenPref = Object.create(null);

// −/+ string-collapse and ⤢ full-height choices for the input/output
// panels INSIDE a sub-report card, keyed 'str:'/'exp:' + cardKey +
// ':in'/':out'. Live cards repaint on every progress append; with the
// per-render Math.random() ids formatJsonValue mints, every repaint
// forgot the user's toggle and snapped the panel back to its default.
// Stable keys + this map make the choice survive repaints. Session-
// scoped on purpose, like _subReportOpenPref above.
var _subPanelPref = Object.create(null);

// storeRawCopy() (200-ui-interactions.js) appends a NEW _rawCopyStore
// entry on every call. A live sub card re-renders on every progress
// event and used to push two fresh entries per repaint, growing the
// store without bound for the lifetime of the page. Write under a
// STABLE per-card key and overwrite instead — one entry per panel per
// card, however often it repaints.
function _storeSubRawCopy(key, content) {
    if (typeof window !== 'undefined') {
        window._rawCopyStore = window._rawCopyStore || {};
        window._rawCopyStore[key] = content;
    }
    return key;
}

// Same −/+ long-string collapse affordance as formatJsonValue's string
// case (190-json-format.js), but with a STABLE DOM id + pref key instead
// of a random per-render id, so the toggle state survives the card's
// progress repaints. Toggling is handled by the delegated click listener
// below (data-sub-collapse) — no inline onclick, same XSS rationale as
// the chip / open-chat buttons.
function _renderSubCollapsibleText(text, prefKey, domId) {
    var escaped = escapeHtml(text);
    var lines = text.split('\n');
    var lineCount = lines.length;
    if (lineCount <= 1 && text.length <= 80) {
        return '<span class="json-str">' + escaped + '</span>';
    }
    var firstLine = lines[0];
    if (firstLine.length > 80) firstLine = firstLine.substring(0, 77) + '...';
    var preview = escapeHtml(firstLine);
    if (lineCount > 1) {
        preview += '<span class="json-preview"> +' + (lineCount - 1) + ' line' + (lineCount > 2 ? 's' : '') + '</span>';
    }
    var collapsed = !!_subPanelPref['str:' + prefKey];
    return '<span class="json-collapse" data-sub-collapse="' + escapeHtml(prefKey) + '" data-sub-collapse-id="' + escapeHtml(domId) + '">' + (collapsed ? '+' : '−') + '</span>' +
        '<span id="' + escapeHtml(domId) + '" class="json-collapsible json-str"' + (collapsed ? ' style="display:none"' : '') + '>' + escaped + '</span>' +
        '<span id="' + escapeHtml(domId) + '-collapsed" class="json-collapsed json-str"' + (collapsed ? '' : ' style="display:none"') + '>' + preview + '</span>';
}

// Markdown variant of _renderSubCollapsibleText — same structure (collapse
// toggle + expanded element + collapsed preview, SAME ids/classes/data
// attributes so the delegated [data-sub-collapse] listener and _subPanelPref
// keep working), but the EXPANDED element renders the text as markdown via
// formatContent (250-message-render.js) inside a markdown-body container —
// the same pattern _subProgressHtml below already uses. The collapsed
// preview stays PLAIN TEXT (first non-empty line, markdown noise stripped —
// same regex chain as the card-header previewSrc). Falls back to the
// escaped-text variant when formatContent is unavailable.
function _renderSubCollapsibleMarkdown(text, prefKey, domId) {
    if (typeof formatContent !== 'function') {
        return _renderSubCollapsibleText(text, prefKey, domId);
    }
    var rendered;
    try {
        rendered = formatContent(text);
    } catch (_) {
        // Same fallback shape as _subProgressHtml, with newlines preserved
        // (the surrounding pre.sub-md resets white-space to normal).
        rendered = '<span class="md-paragraph">' + escapeHtml(text).replace(/\n/g, '<br>') + '</span>';
    }
    var lines = text.split('\n');
    var lineCount = lines.length;
    if (lineCount <= 1 && text.length <= 80) {
        return '<span class="json-str sub-md-inline markdown-body">' + rendered + '</span>';
    }
    // Plain-text one-line preview: first non-empty line with leading
    // header/bullet markers, **bold** and `code` stripped (same chain as
    // previewSrc in renderSubReport).
    var firstLine = (lines.find(function(l) { return l.trim().length > 0; }) || '')
        .replace(/^#+\s*/, '')
        .replace(/^[-*]\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
    if (firstLine.length > 80) firstLine = firstLine.substring(0, 77) + '...';
    var preview = escapeHtml(firstLine);
    if (lineCount > 1) {
        preview += '<span class="json-preview"> +' + (lineCount - 1) + ' line' + (lineCount > 2 ? 's' : '') + '</span>';
    }
    var collapsed = !!_subPanelPref['str:' + prefKey];
    // NOTE: the expanded element renders display:block (CSS) so the markdown
    // body sits on its own line under the −/+ toggle. toggleJsonCollapse
    // re-shows with display:'inline' — the delegated listener below restores
    // '' for .sub-md elements so the stylesheet rule applies again.
    return '<span class="json-collapse" data-sub-collapse="' + escapeHtml(prefKey) + '" data-sub-collapse-id="' + escapeHtml(domId) + '">' + (collapsed ? '+' : '−') + '</span>' +
        '<span id="' + escapeHtml(domId) + '" class="json-collapsible json-str sub-md markdown-body"' + (collapsed ? ' style="display:none"' : '') + '>' + rendered + '</span>' +
        '<span id="' + escapeHtml(domId) + '-collapsed" class="json-collapsed json-str"' + (collapsed ? '' : ' style="display:none"') + '>' + preview + '</span>';
}

// onclick shim for the ⤢ expand buttons on sub-report input/output
// panels. Delegates to toggleToolExpand (190-json-format.js) for the
// actual class flips, then records the resulting state so the next
// repaint renders the panel already expanded/collapsed. toggleToolExpand
// calls event.stopPropagation(), so the document-level delegated
// listener can never observe these clicks — hence the explicit shim.
function toggleSubReportExpand(btn, event) {
    if (typeof toggleToolExpand === 'function') toggleToolExpand(btn, event);
    try {
        var wrapper = btn.closest('.tool-args-wrapper') || btn.closest('.tool-result-wrapper');
        var key = wrapper && wrapper.getAttribute('data-sub-expand-key');
        var pre = wrapper ? (wrapper.querySelector('.tool-args') || wrapper.querySelector('pre')) : null;
        if (key && pre) _subPanelPref['exp:' + key] = pre.classList.contains('expanded');
    } catch (_) { /* ignore */ }
}

// ---------- sub progress card (update_action_state mirrored from the sub) ----------
// recordSubActionState (097-sub-agent-registry.js) stamps msg.actionState /
// phase.actionState with the sub's latest update_action_state snapshot
// ({state, icon, label, tasks, output, at}). Render it as a state pill +
// label head + tasks checklist. Class names are whitelist-interpolated —
// same defense-in-depth rationale as SUB_REPORT_STATUSES above.
var SUB_ACTION_STATES = { running: 1, stuck: 1, done: 1, error: 1 };
var SUB_ACTION_TASK_STATUSES = { pending: 1, running: 1, done: 1, error: 1 };
function _subActionStateHtml(st) {
    if (!st) return '';
    var tasks = Array.isArray(st.tasks) ? st.tasks : [];
    if (!st.label && !tasks.length) return '';
    var stClass = SUB_ACTION_STATES[st.state] ? st.state : 'running';
    var head = '';
    if (st.label) {
        head = '<div class="sub-report-action-head">' +
            '<span class="sub-report-action-pill">' + escapeHtml(stClass) + '</span>' +
            '<span class="sub-report-action-label">' + escapeHtml(String(st.label)) + '</span>' +
        '</div>';
    }
    var rows = tasks.map(function(t) {
        var ts = (t && SUB_ACTION_TASK_STATUSES[t.status]) ? t.status : 'pending';
        var glyph = (ts === 'done') ? '\u2713'
                  : (ts === 'error') ? '\u2715'
                  : (ts === 'running') ? '<span class="sub-report-spinner sub-report-task-spinner" aria-hidden="true"></span>'
                  : '\u25cb';
        return '<div class="sub-report-task sub-task-' + ts + '">' +
            '<span class="sub-report-task-icon" aria-hidden="true">' + glyph + '</span>' +
            '<span class="sub-report-task-label">' + escapeHtml(String((t && t.label) || '')) + '</span>' +
        '</div>';
    }).join('');
    return '<div class="sub-report-action-state sub-action-' + stClass + '">' + head + rows + '</div>';
}

// Resolve the status to SHOW for a sub_report card. Terminal stored statuses
// are authoritative; a non-terminal (running/partial) card reflects the LIVE
// registry state so the spinner/label tracks the worker in real time even
// between the discrete rows we persist (spawn -> progress -> final report).
function _subReportLiveStatus(msg) {
    var stored = (msg.report && msg.report.status) || 'partial';
    if (stored === 'done' || stored === 'error' || stored === 'need_input' || stored === 'cancelled') return stored;
    var live = null;
    if (msg.subAgentId && typeof SubAgents !== 'undefined' && SubAgents.getById) {
        var r = SubAgents.getById(msg.subAgentId);
        if (r) live = r.state;
    }
    if (live === 'running')  return 'running';
    if (live === 'sleeping') return 'waiting';
    if (live === 'stopped')  return 'cancelled';
    if (live === 'errored')  return 'error';
    // No live record (GC'd / not yet rehydrated) and not terminal: keep showing
    // running rather than inventing a terminal status.
    return 'running';
}

// ---------- Threaded dialogue view (Orchestrator §4) ----------
// Compact chronological parent⇄worker exchange, reconstructed ONLY from
// fields the sub_report card actually persists (097-sub-agent-registry.js):
//   • msg.spawnArgs.instructions — the spawn brief (parent→, first entry)
//   • msg.phases[] — archived wake cycles: {input (parent→ wake
//     instruction), progress[] (worker→ agent_message pushes + lifecycle
//     notices), report {status, summary, at} (worker→ report_to_parent)}
//   • msg.currentInput / msg.progress / msg.report — the live phase
// plus, when the LIVE registry record still exists, its queued inbox
// (parent→ messages a sleeping sub has not consumed yet). Nothing is
// invented: a GC'd record simply contributes no inbox entries and legacy
// rows with none of these fields render no thread at all.

// hh:mm:ss for thread rows (dates would just repeat the chat's day).
function _subThreadTime(at) {
    try {
        var d = new Date(at);
        if (isNaN(d.getTime())) return '';
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    } catch (_) { return ''; }
}

function _subThreadEntries(msg, liveRec) {
    var entries = [];
    function push(role, kind, text, at) {
        if (text == null || String(text) === '') return;
        entries.push({ role: role, kind: kind, text: String(text), at: (typeof at === 'number' ? at : null) });
    }
    function pushProgress(progArr) {
        var arr = Array.isArray(progArr) ? progArr : [];
        for (var j = 0; j < arr.length; j++) {
            var p = arr[j];
            if (p) push('worker', p.lifecycle ? 'notice' : 'update', p.text, p.at);
        }
    }
    var phases = Array.isArray(msg.phases) ? msg.phases : [];
    // Wake inputs carry no timestamp of their own — a wake fires right after
    // the previous phase's report, so that report's `at` is the closest
    // honest approximation. The very first input is stamped msg.createdAt.
    var prevAt = (typeof msg.createdAt === 'number') ? msg.createdAt : null;
    for (var i = 0; i < phases.length; i++) {
        var ph = phases[i] || {};
        // phases[0].input IS the spawn brief (the wake path archives
        // currentInput || spawnArgs.instructions) — unless earlier phases
        // were trimmed by the 10-phase cap, in which case it's a wake.
        push('parent', (i === 0 && !msg.phasesDropped) ? 'spawn' : 'wake', ph.input, prevAt);
        pushProgress(ph.progress);
        if (ph.report) {
            push('worker', 'report \u00b7 ' + (ph.report.status || 'done'), ph.report.summary || '(no summary)', ph.report.at);
            if (typeof ph.report.at === 'number') prevAt = ph.report.at;
        }
    }
    // Live phase: after a wake msg.currentInput carries the latest
    // instruction; before any wake the spawn brief is the input.
    var sa = msg.spawnArgs;
    var curInput = msg.currentInput || (sa && sa.instructions) || '';
    var curIsSpawn = !phases.length && !msg.phasesDropped && !msg.currentInput;
    push('parent', curIsSpawn ? 'spawn' : 'wake', curInput, prevAt);
    pushProgress(msg.progress);
    var rep = msg.report;
    if (rep && rep.status && rep.status !== 'running' && rep.status !== 'partial') {
        push('worker', 'report \u00b7 ' + rep.status, rep.summary || '(no summary)', rep.at);
    }
    // Queued inbox (live record only): parent→ messages waiting for the next
    // wake/drain. Sub→sub senders keep their agent_id as the role label
    // detail via the kind pill.
    if (liveRec && Array.isArray(liveRec.inbox)) {
        for (var k = 0; k < liveRec.inbox.length; k++) {
            var it = liveRec.inbox[k];
            if (!it) continue;
            push(it.from === 'parent' ? 'parent' : 'worker',
                'queued' + (it.kind && it.kind !== 'message' ? ' \u00b7 ' + it.kind : ''),
                it.content, it.at);
        }
    }
    return entries;
}

// Truncate a thread entry to one compact line (the full text already lives
// in the card's input/output panels — the thread is an overview, not a
// second copy of every payload).
function _subThreadPreview(text) {
    var s = String(text).replace(/\s+/g, ' ').trim();
    return s.length > 220 ? (s.slice(0, 220) + '\u2026') : s;
}

function _subThreadHtml(msg, liveRec, cardKey) {
    var entries;
    try { entries = _subThreadEntries(msg, liveRec); } catch (_) { entries = []; }
    if (!entries || entries.length < 2) return ''; // spawn alone ≠ a dialogue
    var rows = '';
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var isParent = (e.role === 'parent');
        var time = e.at ? _subThreadTime(e.at) : '';
        rows += '<div class="sub-thread-row sub-thread-' + (isParent ? 'parent' : 'worker') + '">' +
            '<span class="sub-thread-role">' + (isParent ? 'parent \u2192' : 'worker \u2192') + '</span>' +
            (e.kind ? '<span class="sub-thread-kind">' + escapeHtml(e.kind) + '</span>' : '') +
            '<span class="sub-thread-text">' + escapeHtml(_subThreadPreview(e.text)) + '</span>' +
            (time ? '<span class="sub-thread-time">' + escapeHtml(time) + '</span>' : '') +
        '</div>';
    }
    // Collapsed by default; the user's toggle survives repaints via the SAME
    // data-sub-report-toggle recorder the outer card uses (capture-phase
    // 'toggle' listener + _subReportOpenPref), keyed 'thread:'+cardKey.
    var prefKey = 'thread:' + cardKey;
    var pref = _subReportOpenPref[prefKey];
    var open = (pref != null) ? pref : false;
    return '<details' + (open ? ' open' : '') + ' class="sub-thread" data-sub-report-toggle="' + escapeHtml(prefKey) + '" data-rendered-open="' + (open ? '1' : '0') + '">' +
        '<summary class="sub-thread-summary">dialogue (' + entries.length + ')</summary>' +
        '<div class="sub-thread-body">' + rows + '</div>' +
    '</details>';
}

function renderSubReport(msg, index) {
    var report = msg.report || {};
    var status = _subReportLiveStatus(msg);
    if (!SUB_REPORT_STATUSES[status]) status = 'partial';
    var statusClass = 'sub-report-' + status;
    var isRunning = (status === 'running');
    var isWaiting = (status === 'waiting');
    var isLive = isRunning || isWaiting;
    var statusLabelMap = { running: 'working', waiting: 'waiting', partial: 'working',
        done: 'done', error: 'error', need_input: 'needs input', cancelled: 'cancelled' };
    var statusLabel = statusLabelMap[status] || status;
    var iconChar = (status === 'done') ? '✓'
             : (status === 'error') ? '✕'
             : (status === 'need_input') ? '?'
             : (status === 'cancelled') ? '⊘'
             : (status === 'waiting') ? '\u275a\u275a'
             : '…';
    // Running shows an animated spinner in the icon slot; everything else a glyph.
    var iconHtml = isRunning
        ? '<span class="sub-report-spinner" aria-hidden="true"></span>'
        : '<span class="sub-report-icon" aria-hidden="true">' + iconChar + '</span>';
    // ── Review-state badge (Orchestrator §3) ──
    // Live-record read only: a GC'd/expired record simply shows no badge
    // (review_state is a workflow hint, not part of the archived report).
    var reviewHtml = '';
    if (msg.subAgentId && typeof SubAgents !== 'undefined' && SubAgents.getById) {
        var _rvRec = SubAgents.getById(msg.subAgentId);
        var _rvBadge = (_rvRec && _rvRec.review_state) ? SUB_REVIEW_BADGES[_rvRec.review_state] : null;
        if (_rvBadge) {
            reviewHtml = '<span class="sub-report-review" title="deliverable review state"'
                + ' style="margin-left:6px;padding:1px 7px;border-radius:9px;font-size:10px;font-weight:600;letter-spacing:.3px;white-space:nowrap;'
                + 'background:' + _rvBadge.bg + ';color:' + _rvBadge.fg + ';">'
                + escapeHtml(_rvBadge.label) + '</span>';
        }
        // Orchestrator §6: model-provenance badge — which provider/tier
        // this worker runs on. Live-record read only (same GC
        // rationale as the review badge — provenance is shown while the
        // record exists; the archived report itself never claimed it).
        var _mdlLine = _subModelLine(_rvRec);
        if (_mdlLine) {
            reviewHtml += '<span class="sub-report-model" title="model this worker runs on \u2014 provider (tier)">'
                + escapeHtml(_mdlLine) + '</span>';
        }
        // Orchestrator §5: awaiting-approval badge — a tool call in the sub's
        // chat is parked on a permission modal (rec.awaiting_approval, stamped
        // by onSubApprovalEvent). The card repaints on the same lifecycle
        // notice that announces the park, so the badge appears immediately.
        if (_subAwaitingApproval(_rvRec)) {
            var _apTool = (_rvRec.awaiting_approval && _rvRec.awaiting_approval.tool) || 'a tool call';
            reviewHtml += '<span class="sub-report-approval" title="' + escapeHtml(_apTool) + ' is awaiting user approval in the sub\u2019s chat"'
                + ' style="margin-left:6px;padding:1px 7px;border-radius:9px;font-size:10px;font-weight:600;letter-spacing:.3px;white-space:nowrap;'
                + 'background:#5c4d10;color:#ffe289;">awaiting approval</span>';
        }
    }
    var summary = report.summary || '';
    var name = msg.subAgentName || report.from_name || msg.subAgentId || 'sub-agent';
    // Stable per-card key — drives the open/collapse pref maps and the
    // stable ids/keys for the input/output panels below. Computed up here
    // so inputsHtml/outputHtml can derive stable child keys from it.
    // Fallbacks (rare: legacy rows persisted without subAgentId) prefer
    // fields that survive history mutations — subChatId, then the row's own
    // timestamp — over the array index, which shifts whenever earlier
    // messages are inserted/removed and would silently re-key the prefs.
    var cardKey = 'card:' + (msg.subAgentId || msg.subChatId || ('t' + (msg.createdAt || msg.timestamp || index)));

    // ----- Panel builders -----
    // Same wrapper/classes/buttons as the tool-call args / inline tool result
    // panels in 250-message-render.js (tool-args-wrapper + tool-expand-btn +
    // pre.tool-args + tool-copy-btn / tool-result-section + tool-result-
    // wrapper). Content = ONLY the instructions / summary text (no JSON
    // envelope, no label) — the full spawn args are already visible on the
    // spawn_sub_agent tool call panel itself. Each panel derives a STABLE
    // pref key (cardKey + suffix) so the −/+ and ⤢ toggles survive repaints;
    // the CURRENT phase keeps the legacy ':in'/':out' suffixes so prefs
    // recorded before a wake (or persisted by older builds) still apply,
    // while archived phases get indexed suffixes (':in:0', ':out:0', …).
    function _subInputPanel(text, prefSuffix, domSuffix) {
        var taskText = String(text);
        var argsCopyId = _storeSubRawCopy('sub:' + cardKey + prefSuffix, taskText);
        // _renderSubCollapsibleMarkdown gives long/multi-line strings the
        // same −/+ collapse toggle (with one-line plain-text preview) that
        // tool arg panels have, but renders the expanded body as markdown
        // (spawn/wake instructions are written in markdown by agents).
        // Stable id/key so the toggle survives repaints. The raw markdown
        // stays in _rawCopyStore (argsCopyId above) so Copy is unaffected.
        var mdOk = (typeof formatContent === 'function');
        var taskHtml = mdOk
            ? _renderSubCollapsibleMarkdown(taskText, cardKey + prefSuffix, 'sub-str-' + index + domSuffix)
            : _renderSubCollapsibleText(taskText, cardKey + prefSuffix, 'sub-str-' + index + domSuffix);
        var inExpanded = !!_subPanelPref['exp:' + cardKey + prefSuffix];
        // KEEP the <pre> + tool-args class: toggleToolExpand queries
        // '.tool-args' and the :has(> pre.expanded) rules in 05-tools.css
        // key off them. sub-md (only when markdown rendered) resets the
        // pre's white-space/font so markdown reads naturally (24-sub-agents.css).
        return '<div class="tool-args-wrapper" data-copy-id="' + escapeHtml(argsCopyId) + '" data-sub-expand-key="' + escapeHtml(cardKey + prefSuffix) + '">' +
            '<button class="tool-expand-btn" onclick="toggleSubReportExpand(this, event)" title="' + (inExpanded ? 'Collapse' : 'Expand') + '">' + (inExpanded ? '⤡' : '⤢') + '</button>' +
            '<pre class="tool-args' + (mdOk ? ' sub-md markdown-body' : '') + (inExpanded ? ' expanded' : '') + '">' + taskHtml + '</pre>' +
            '<button class="tool-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div>';
    }
    function _subOutputPanel(text, prefSuffix, domSuffix, labelHtml) {
        var summaryText = String(text);
        var resultCopyId = _storeSubRawCopy('sub:' + cardKey + prefSuffix, summaryText);
        // Same −/+ collapse treatment as tool result panels, but the
        // expanded body renders as markdown (report_to_parent summaries are
        // written in markdown). Stable id/key so the toggle survives
        // repaints; raw markdown stays in _rawCopyStore for Copy.
        var mdOk = (typeof formatContent === 'function');
        var summaryHtml = mdOk
            ? _renderSubCollapsibleMarkdown(summaryText, cardKey + prefSuffix, 'sub-str-' + index + domSuffix)
            : _renderSubCollapsibleText(summaryText, cardKey + prefSuffix, 'sub-str-' + index + domSuffix);
        var outExpanded = !!_subPanelPref['exp:' + cardKey + prefSuffix];
        // KEEP the bare <pre>: toggleToolExpand falls back to
        // wrapper.querySelector('pre') and 05-tools.css keys off
        // :has(> pre.expanded). sub-md/markdown-body only when markdown
        // actually rendered (white-space reset would mangle plain text).
        return '<div class="tool-result-section">' + (labelHtml || '') +
            '<div class="tool-result-wrapper" data-copy-id="' + escapeHtml(resultCopyId) + '" data-sub-expand-key="' + escapeHtml(cardKey + prefSuffix) + '">' +
            '<button class="tool-result-expand-btn" onclick="toggleSubReportExpand(this, event)" title="' + (outExpanded ? 'Collapse' : 'Expand') + '">' + (outExpanded ? '⤡' : '⤢') + '</button>' +
            '<pre class="' + (mdOk ? 'sub-md markdown-body' : '') + (outExpanded ? ' expanded' : '') + '">' + summaryHtml + '</pre>' +
            '<button class="tool-copy-btn" onclick="copyCodeBlock(this, event)" title="Copy">' + UI_ICONS.copy + '</button></div></div>';
    }
    function _subProgressHtml(progArr, dropped) {
        if (!progArr.length && !dropped) return '';
        var items = progArr.map(function(p) {
            var t = (p && p.text) ? String(p.text) : '';
            var rendered = (typeof formatContent === 'function' && t)
                ? formatContent(t)
                : ('<span class="md-paragraph">' + escapeHtml(t) + '</span>');
            return '<div class="sub-report-progress-item">' +
                '<span class="sub-report-progress-dot" aria-hidden="true"></span>' +
                '<div class="sub-report-progress-text markdown-body">' + rendered + '</div>' +
            '</div>';
        }).join('');
        // agentMessage (097-sub-agent-registry.js) caps the stream at 50
        // entries and counts trimmed ones in progressDropped — surface the
        // trim as one stub line instead of silently losing history.
        if (dropped) {
            items = '<div class="sub-report-progress-item">' +
                '<span class="sub-report-progress-dot" aria-hidden="true"></span>' +
                '<div class="sub-report-progress-text">[' + (dropped | 0) + ' earlier update' + (dropped > 1 ? 's' : '') + ' truncated]</div>' +
            '</div>' + items;
        }
        return '<div class="sub-report-progress">' + items + '</div>';
    }

    // ----- Archived phases (each wake_sub_agent closes one) -----
    // The wake path (097-sub-agent-registry.js) archives the completed
    // {input, report, progress} triple onto msg.phases. Render every phase
    // as its own input panel → progress items → output panel block, with the
    // phase's terminal status as a small inline pill above the output.
    // Legacy cards persisted by older builds have no msg.phases — their old
    // archival lines simply remain in msg.progress and render as before.
    var phases = Array.isArray(msg.phases) ? msg.phases : [];
    var phasesHtml = '';
    if (msg.phasesDropped) {
        // The wake path caps msg.phases at 10 and counts trimmed ones in
        // phasesDropped — surface the trim as one stub line (same visual
        // treatment as the progressDropped stub).
        phasesHtml += '<div class="sub-report-progress"><div class="sub-report-progress-item">' +
            '<span class="sub-report-progress-dot" aria-hidden="true"></span>' +
            '<div class="sub-report-progress-text">[' + (msg.phasesDropped | 0) + ' earlier phase' + (msg.phasesDropped > 1 ? 's' : '') + ' truncated]</div>' +
        '</div></div>';
    }
    for (var pi = 0; pi < phases.length; pi++) {
        var ph = phases[pi] || {};
        // REG374-2: key panel prefs (_subPanelPref / _rawCopyStore) by the
        // stable per-phase id stamped at archive time (097-sub-agent-registry
        // wake path), not the array index — the 10-phase cap shift()s the
        // array and index-keyed prefs migrated to the wrong phase. Phases
        // persisted before this fix have no id → fall back to the index.
        var phKey = (ph.id != null) ? ph.id : pi;
        var phReport = ph.report || {};
        var phStatus = String(phReport.status || 'done');
        if (!SUB_REPORT_STATUSES[phStatus]) phStatus = 'partial';
        var phLabel = '<span class="sub-report-status sub-report-phase-status">' + escapeHtml(statusLabelMap[phStatus] || phStatus) + '</span>';
        phasesHtml += '<div class="sub-report-phase">' +
            (ph.input ? _subInputPanel(ph.input, ':in:' + phKey, '-in-' + phKey) : '') +
            _subProgressHtml(Array.isArray(ph.progress) ? ph.progress : [], ph.progressDropped | 0) +
            // The phase's archived update_action_state card (wake path stamps
            // phase.actionState before resetting the live one).
            _subActionStateHtml(ph.actionState) +
            // A summary-less phase (e.g. report_to_parent with empty summary)
            // still shows its terminal-status pill — gating the pill on the
            // summary dropped it entirely and the phase read as unlabeled.
            (phReport.summary ? _subOutputPanel(phReport.summary, ':out:' + phKey, '-out-' + phKey, phLabel)
                              : '<div class="tool-result-section">' + phLabel + '</div>') +
        '</div>';
    }
    // REG376-1: the stable per-phase ids above mint NEW _rawCopyStore /
    // _subPanelPref entries on every wake; entries for phases the 10-phase
    // cap shift()ed out of msg.phases were never overwritten or pruned
    // (storeRawCopy's GC only touches 'rc-' keys), so both stores grew
    // without bound on long-running woken subs. Prune THIS card's
    // phase-suffixed keys (':in:<id>' / ':out:<id>') whose phase id is no
    // longer in msg.phases. The current phase's suffix-less ':in'/':out'
    // keys never match the trailing-id pattern, and other cards' keys never
    // match this card's prefix (a longer cardKey leaves residue before
    // ':in:'/':out:', failing the anchored pattern) — both stay intact.
    if (phases.length && typeof window !== 'undefined' && window._rawCopyStore) {
        var _liveIds = Object.create(null);
        for (var li = 0; li < phases.length; li++) {
            var lp = phases[li] || {};
            _liveIds[(lp.id != null) ? lp.id : li] = true;
        }
        var _phaseSuffixRe = /^:(?:in|out):(.+)$/;
        var _pruneStalePhaseKeys = function(store, prefix) {
            var ks = Object.keys(store);
            for (var ki = 0; ki < ks.length; ki++) {
                if (ks[ki].indexOf(prefix) !== 0) continue;
                var m = _phaseSuffixRe.exec(ks[ki].slice(prefix.length));
                if (m && !_liveIds[m[1]]) delete store[ks[ki]];
            }
        };
        _pruneStalePhaseKeys(window._rawCopyStore, 'sub:' + cardKey);
        _pruneStalePhaseKeys(_subPanelPref, 'exp:' + cardKey);
        _pruneStalePhaseKeys(_subPanelPref, 'str:' + cardKey);
    }

    // ----- Current phase input -----
    // After a wake, msg.currentInput carries the latest wake instruction;
    // before any wake it is unset and the spawn instructions are the input.
    var sa = msg.spawnArgs;
    var currentInput = msg.currentInput || (sa && sa.instructions) || '';
    var inputsHtml = currentInput ? _subInputPanel(currentInput, ':in', '-in') : '';

    // ----- Progress stream (agent_message -> parent, accumulated in place) -----
    // After a wake this stream is reset per phase — only the CURRENT phase's
    // updates live here (archived phases carry their own in msg.phases).
    var prog = Array.isArray(msg.progress) ? msg.progress : [];
    var progressHtml = _subProgressHtml(prog, msg.progressDropped | 0);

    // ----- Live progress card (sub's update_action_state, mirrored in place) -----
    var actionStateHtml = _subActionStateHtml(msg.actionState);

    // ----- Output — styled like a tool call's result block -----
    // Content = ONLY the report summary text — data/artifacts live on the
    // spawn handle result and in the sub's own chat. (_subOutputPanel reuses
    // the exact tool-result-section markup this section used to inline.)
    var outputHtml = summary ? _subOutputPanel(summary, ':out', '-out', '') : '';
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
        openLink = '<button type="button" class="sub-report-open" data-sub-chat-id="' + escapeHtml(targetChatId) + '" title="Open this sub-agent\u2019s chat">' + chatIconSvg + '<span class="sub-report-open-label">Open chat</span></button>';
    }
    var synth = report._synthesized ? '<span class="sub-report-synth" title="No explicit report_to_parent — fallback summary from last assistant message">auto</span>' : '';
    // Phase-5 follow-up: the sub_report panel is now COLLAPSED by default —
    // a long markdown report from a sub used to dominate the scrollback the
    // moment it landed. The <summary> row stays visible (icon + name +
    // status + one-line preview + "open transcript") so the parent agent can
    // see at a glance what came back; clicking the row expands the full
    // markdown body. Native <details> handles the toggle — no extra JS.
    //
    // The report payload renders as a tool-style JSON result block (see
    // outputHtml above). The global delegated click listener calls
    // preventDefault() on any [data-sub-chat-id] / [data-sub-agent-reveal]
    // hit, which cancels the <details> toggle as well — so clicking
    // "open chat" reveals the sub's chat without toggling the panel.
    // One-line preview for the collapsed header. While the sub is live, show
    // the latest progress line (its current activity); once terminal, show the
    // final summary. Strip markdown noise so the preview reads as plain text.
    var previewBase = '';
    if (isLive && prog.length) previewBase = (prog[prog.length - 1] && prog[prog.length - 1].text) || '';
    else previewBase = summary;
    // Live card with no agent_message stream yet: fall back to the sub's
    // update_action_state label so the collapsed header still tracks activity.
    if (isLive && !previewBase && msg.actionState && msg.actionState.label) {
        previewBase = msg.actionState.label;
    }
    var previewSrc = (String(previewBase).split('\n').find(function(l) { return l.trim().length > 0; }) || '')
        .replace(/^#+\s*/, '')
        .replace(/^[-*]\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
    var preview = previewSrc.length > 140 ? (previewSrc.slice(0, 140) + '…') : previewSrc;
    var previewHtml = preview ? '<span class="sub-report-preview">' + escapeHtml(preview) + '</span>' : '';
    // Open by default while the sub is live (so the user watches inputs +
    // progress stream) and for terminal reports that need the parent's
    // attention (error / need_input). `done`, `cancelled` collapse to the
    // header (preview line + status badge is enough at a glance).
    // The user's explicit open/collapse choice (recorded by the delegated
    // click listener below) beats the computed default — otherwise every
    // repaint (progress append, live-state change) would snap a collapsed
    // live card back open. (cardKey is computed near the top of this
    // function — the input/output panels derive their stable keys from it.)
    var cardPref = _subReportOpenPref[cardKey];
    var openNow = (cardPref != null) ? cardPref : (isLive || status === 'error' || status === 'need_input');
    var defaultOpen = openNow ? ' open' : '';
    // Orchestrator §4: compact parent⇄worker dialogue thread at the top of
    // the body (collapsed by default). Live record is optional — a GC'd sub
    // still gets a thread from the persisted card fields alone.
    var threadRec = (msg.subAgentId && typeof SubAgents !== 'undefined' && SubAgents.getById)
        ? SubAgents.getById(msg.subAgentId) : null;
    var threadHtml = _subThreadHtml(msg, threadRec, cardKey);
    var bodyHtml = threadHtml + phasesHtml + inputsHtml + progressHtml + actionStateHtml + outputHtml;
    // data-rendered-open stamps the state this render PRODUCED. Chrome fires
    // a (trusted) 'toggle' event even when a <details open> is merely inserted
    // via innerHTML, so the pref recorder below compares against this stamp to
    // tell genuine user toggles apart from render echoes — recording the echo
    // would pin the computed default as a "user" pref on every repaint.
    return '<details' + defaultOpen + ' class="message sub-report ' + statusClass + '" id="msg-' + index + '" data-sub-report-toggle="' + escapeHtml(cardKey) + '" data-rendered-open="' + (openNow ? '1' : '0') + '">' +
        '<summary class="sub-report-header">' +
            '<span class="sub-report-chevron" aria-hidden="true"></span>' +
            iconHtml +
            '<span class="sub-report-name">' + escapeHtml(name) + '</span>' +
            '<span class="sub-report-status">' + escapeHtml(statusLabel) + '</span>' +
            reviewHtml +
            synth +
            previewHtml +
            openLink +
        '</summary>' +
        '<div class="sub-report-body">' +
            bodyHtml +
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

// ---------- Workers panel (in the version sidebar, like artifacts) ----------
// Renders a card for every live sub owned by the active chat. Each card shows
// a robot icon, the sub's name + state, a live tool-call counter, and a
// real-time context-length circle (mirrors the main chat's context circle —
// see updateContextIndicator in 240-layout.js). Click a card to open the
// sub's transcript. Moved here from the old above-input "Workers strip".

// Context limit for any chat: the FIXED assumed window applied to every
// model (user-editable global setting, default 200k — see
// getAssumedContextTokens in core/030-config.js). Per-model windows are no
// longer tracked; every ring measures against the same assumed window,
// matching the saturation gauges in core/097-sub-agent-registry.js.
// (chatId kept for signature compatibility with callers.)
function _subContextLimit(chatId) {
    try {
        return (typeof getAssumedContextTokens === 'function') ? getAssumedContextTokens() : 200000;
    } catch (_) { return 200000; }
}

// Derive a sub-agent's current context size from its chat. Sub-agent chats
// live in the same global `chats` map as the parent, so we read the last
// non-aggregate assistant message's input_tokens — exactly the value the main
// context circle uses. Returns { tokens, pct }.
function _subContextInfo(chatId) {
    var tokens = 0;
    var c = (chatId && typeof chats !== 'undefined') ? chats[chatId] : null;
    if (c && c.messages) {
        for (var i = c.messages.length - 1; i >= 0; i--) {
            var m = c.messages[i];
            if (m && m.role === 'assistant' && m.metrics && m.metrics.input_tokens && !m.metrics.isAggregate) {
                tokens = m.metrics.input_tokens;
                break;
            }
        }
    }
    var limit = _subContextLimit(chatId);
    var pct = (limit > 0) ? Math.min(100, Math.round((tokens / limit) * 100)) : 0;
    return { tokens: tokens, pct: pct };
}

function _fmtTokens(t) {
    t = t || 0;
    return t >= 1000 ? (Math.round(t / 1000) + 'k') : String(t);
}

// Collapsed-card work counters: files edited + PRs opened by the sub's chat.
// Derived from the SAME synchronous message-scan helpers the version sidebar
// uses — getWsEditedFilesForChat (115-workspace-files-sidebar.js) and
// getPushedPRsForChat (120-ui-utils.js) — so there is no extra persistence
// and the counts survive registry GC (sub chats live in the global `chats`
// map). Memoized on messages.length: both scans JSON.parse every workspace
// tool call, too heavy to redo on every updateSidebarWorkerMetrics heartbeat.
var _subWorkStatsCache = Object.create(null);
function _subWorkStats(chatId) {
    var c = (chatId && typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c || !Array.isArray(c.messages)) return { n: 0, files: 0, prs: 0 };
    var cached = _subWorkStatsCache[chatId];
    if (cached && cached.n === c.messages.length) return cached;
    var files = 0, prs = 0;
    try { if (typeof getWsEditedFilesForChat === 'function') files = getWsEditedFilesForChat(c).length; } catch (_) { /* count stays 0 */ }
    try { if (typeof getPushedPRsForChat === 'function') prs = getPushedPRsForChat(c).length; } catch (_) { /* count stays 0 */ }
    var out = { n: c.messages.length, files: files, prs: prs };
    _subWorkStatsCache[chatId] = out;
    return out;
}

// Singular/plural label for the collapsed-card work counters.
function _subCountLabel(n, singular, plural) {
    return n + ' ' + (n === 1 ? singular : plural);
}

// Orchestrator §5: true while the sub is parked on a permission modal
// (mirrors rec.awaiting_approval / _pending_approvals stamped by
// onSubApprovalEvent in the registry).
function _subAwaitingApproval(rec) {
    return !!(rec && (rec.awaiting_approval || (rec._pending_approvals || 0) > 0));
}

// Orchestrator §6: per-sub model provenance line for worker cards and the
// sub-report card header — 'provider (tier)'. rec.provider is the
// resolved provider NAME pinned at spawn, rec.tier the alias it was
// requested through. '' for legacy / reconstructed records that carry
// neither field (no badge rendered — GC-safe).
function _subModelLine(rec) {
    if (!rec) return '';
    var prov = rec.provider || null;
    // tier:'same' subs pin no provider — they dynamically follow their spawner.
    // Resolve the CURRENT followed model for display (best-effort; page ctx).
    if (!prov && rec.tier === 'same' && rec.same_as && typeof resolveChatProviderName === 'function') {
        try { prov = resolveChatProviderName(rec.same_as); } catch (_) { /* leave null */ }
    }
    if (!prov && !rec.tier) return '';
    var line = prov || 'inherit';
    if (rec.tier) line += ' (' + rec.tier + ')';
    return line;
}

// Lightweight per-tick refresh of the live metrics (context circle + tool-call
// counter) on already-rendered worker cards, WITHOUT rebuilding their innerHTML
// — so the running-dot pulse and the circle's stroke transition don't restart
// on every heartbeat. Full rebuilds (renderWorkersStrip) only happen when the
// worker set or a state actually changes (gated by _chipKey in _doRender).
function updateSidebarWorkerMetrics() {
    var panel = document.getElementById('sidebar-workers');
    if (!panel || panel.style.display === 'none') return;
    var cards = panel.querySelectorAll('.worker-card[data-worker-chat]');
    for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var ctx = _subContextInfo(card.getAttribute('data-worker-chat'));
        var fill = card.querySelector('[data-worker-ctx-fill]');
        if (fill) fill.setAttribute('stroke-dasharray', ctx.pct + ', 100');
        var pctEl = card.querySelector('[data-worker-ctx-pct]');
        if (pctEl) pctEl.textContent = ctx.tokens ? (ctx.pct + '%') : '\u2014';
        var ctxWrap = card.querySelector('[data-worker-ctx]');
        if (ctxWrap) {
            ctxWrap.classList.toggle('worker-ctx-danger', ctx.pct >= 90);
            ctxWrap.classList.toggle('worker-ctx-warning', ctx.pct >= 70 && ctx.pct < 90);
        }
        // Tool-call counter — authoritative live value from the registry record.
        var toolsEl = card.querySelector('[data-worker-tools]');
        if (toolsEl) {
            var aid = card.getAttribute('data-worker-toggle');
            var rec = _resolveSubRec(aid);
            if (rec) {
                var used = rec.tool_calls_used || 0;
                toolsEl.textContent = String(used) + ' tool calls';
                // Orchestrator §5: live approval badge refresh.
                var apEl = card.querySelector('[data-worker-approval]');
                if (apEl) apEl.hidden = !_subAwaitingApproval(rec);
            }
        }
        // Work counters — files edited / PRs opened by the sub's chat
        // (memoized message scan; only repainted when the count changes).
        var work = _subWorkStats(card.getAttribute('data-worker-chat'));
        var filesEl = card.querySelector('[data-worker-files]');
        if (filesEl) {
            var filesTxt = _subCountLabel(work.files, 'file', 'files');
            if (filesEl.textContent !== filesTxt) filesEl.textContent = filesTxt;
            filesEl.hidden = !work.files;
        }
        var prsEl = card.querySelector('[data-worker-prs]');
        if (prsEl) {
            var prsTxt = _subCountLabel(work.prs, 'PR', 'PRs');
            if (prsEl.textContent !== prsTxt) prsEl.textContent = prsTxt;
            prsEl.hidden = !work.prs;
        }
        // Live-refresh an expanded card's progress panel when the sub's
        // action_state advances — keyed on `at` so we rebuild only on a real
        // progress change, not on every heartbeat tick.
        var wkAid = card.getAttribute('data-worker-toggle');
        if (wkAid && _workerExpanded[wkAid]) {
            var wkProg = card.nextElementSibling;
            if (wkProg && wkProg.classList && wkProg.classList.contains('worker-card-progress')) {
                var wkRec = _resolveSubRec(wkAid);
                var wkAt = String(wkRec && wkRec.action_state ? (wkRec.action_state.at || 0) : 0);
                if (wkProg.getAttribute('data-prog-at') !== wkAt) {
                    wkProg.innerHTML = _workerProgressInner(wkRec);
                    wkProg.setAttribute('data-prog-at', wkAt);
                }
            }
        }
    }
}

// Expanded-state memory for worker cards, keyed by agent_id, so the inline
// progress panel a user opens survives strip rebuilds (renderWorkersStrip
// replaces innerHTML on every state change).
var _workerExpanded = Object.create(null);

// Build the inner HTML of a worker card's expandable progress panel from the
// sub's live update_action_state snapshot (rec.action_state). Reuses the same
// .sub-report-action-state / .sub-report-task markup the parent's sub_report
// card uses, so the checklist is already themed. Always appends an "open
// transcript" link (data-sub-agent-reveal -> revealSubAgentChat).
function _workerProgressInner(rec) {
    var inner = rec ? _subActionStateHtml(rec.action_state) : '';
    if (!inner) inner = '<div class="worker-progress-empty">No progress reported yet.</div>';
    // Open-chat affordance. Live records reveal by agent_id (follows chat_id
    // changes); reconstructed/purged records use the persisted chat_id and only
    // when that chat still exists (GC deletes the sub's chat row too).
    var openAttr = '';
    if (rec && rec._reconstructed) {
        if (rec.chat_id && typeof chats !== 'undefined' && chats[rec.chat_id]) {
            openAttr = 'data-sub-chat-id="' + escapeHtml(rec.chat_id) + '"';
        }
    } else if (rec && rec.agent_id) {
        openAttr = 'data-sub-agent-reveal="' + escapeHtml(rec.agent_id) + '"';
    }
    if (openAttr) {
        inner += '<a class="worker-progress-open" ' + openAttr + ' role="button" tabindex="0" title="Open chat">' +
            '<svg class="ui-icon worker-progress-open-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
            '<span>Open chat</span></a>';
    }
    // "Chat view" affordance — opens the sub's inline chat card (the SAME
    // renderSubReport card shown in the parent chat: inputs + progress +
    // outputs) inside the global modal overlay. Only offered when a
    // persisted sub_report card for this agent can actually be located.
    if (rec && rec.agent_id && _findSubReportMsg(rec.agent_id)) {
        inner += '<a class="worker-progress-open worker-progress-chat-view" data-worker-modal="' + escapeHtml(rec.agent_id) + '" role="button" tabindex="0" title="View this sub-agent\'s inputs and outputs in a modal">' +
            '<svg class="ui-icon worker-progress-open-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>' +
            '<span>View more</span></a>';
    }
    return inner;
}

// Toggle a worker card's inline progress panel. Re-renders the panel from the
// live registry record on open so it shows current progress even if it changed
// while the card was collapsed.
function toggleWorkerProgress(agentId, cardEl) {
    if (!cardEl) return;
    var panel = cardEl.nextElementSibling;
    if (!panel || !panel.classList || !panel.classList.contains('worker-card-progress')) return;
    var open = !_workerExpanded[agentId];
    _workerExpanded[agentId] = open;
    if (open) {
        var rec = _resolveSubRec(agentId);
        panel.innerHTML = _workerProgressInner(rec);
        panel.setAttribute('data-prog-at', String(rec && rec.action_state ? (rec.action_state.at || 0) : 0));
    }
    panel.hidden = !open;
    cardEl.classList.toggle('worker-card-expanded', open);
    cardEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ---------- Worker chat-view modal ----------
// Locate the persisted sub_report message for an agent — the SAME message
// object renderSubReport paints inline in the parent chat. Live records
// carry parent_chat_id; reconstructed records were mined from the current
// chat's messages, so currentChatId is the fallback. A last-resort scan of
// every chat covers records revealed from another chat's subtree.
function _findSubReportMsg(agentId) {
    if (!agentId || typeof chats === 'undefined') return null;
    function scan(chatId) {
        var c = chatId ? chats[chatId] : null;
        if (!c || !Array.isArray(c.messages)) return null;
        for (var i = c.messages.length - 1; i >= 0; i--) {
            var m = c.messages[i];
            if (m && m.role === 'sub_report' && m.subAgentId === agentId) return m;
        }
        return null;
    }
    var rec = _resolveSubRec(agentId);
    var msg = (rec && rec.parent_chat_id) ? scan(rec.parent_chat_id) : null;
    if (!msg && typeof currentChatId !== 'undefined') msg = scan(currentChatId);
    if (!msg) {
        for (var cid in chats) {
            msg = scan(cid);
            if (msg) break;
        }
    }
    return msg;
}

// Modal state: which agent is showing, the last-rendered content key (skip
// no-op repaints on registry heartbeat ticks), and the live listener that
// refreshes the modal body while the sub keeps running.
var _workerModalAgentId = null;
var _workerModalKey = null;
var _workerModalListener = null;
var _workerModalRefreshScheduled = false;

// Cheap change-key over everything the modal body renders — mirrors the
// _subReportKey fields (status / progress / phases / live state) plus the
// action-state timestamp and live inbox length the thread view shows.
function _workerModalContentKey(msg, rec) {
    var st = (msg.report && msg.report.status) || 'partial';
    var prog = Array.isArray(msg.progress) ? msg.progress.length : 0;
    var phn = Array.isArray(msg.phases) ? msg.phases.length : 0;
    var act = (msg.actionState && msg.actionState.at) || 0;
    var live = rec ? (rec.state + ':' + ((rec.action_state && rec.action_state.at) || 0) + ':' + (Array.isArray(rec.inbox) ? rec.inbox.length : 0)) : '';
    return st + ':' + prog + ':' + phn + ':' + (msg.phasesDropped | 0) + ':' + act + ':' + live;
}

// (Re)paint the modal body via renderSubReport — the EXACT renderer the
// inline sub_report card uses. index 'wkmodal' keeps the DOM ids
// ('msg-wkmodal', 'sub-str-wkmodal…') distinct from the inline card's
// numeric ids so getElementById-driven toggles never cross-target; the
// cardKey-derived pref/copy keys are intentionally SHARED with the inline
// card (same content, same raw-copy store, same expand prefs).
function _renderWorkerChatModalBody() {
    _workerModalRefreshScheduled = false;
    var body = document.getElementById('modal-body');
    if (!body || !_workerModalAgentId) return;
    var msg = _findSubReportMsg(_workerModalAgentId);
    if (!msg) return;
    var rec = _resolveSubRec(_workerModalAgentId);
    var key = _workerModalContentKey(msg, rec);
    if (key === _workerModalKey) return;
    _workerModalKey = key;
    var html;
    try { html = renderSubReport(msg, 'wkmodal'); }
    catch (_) { html = '<div class="worker-progress-empty">Failed to render chat view.</div>'; }
    body.innerHTML = html;
    // Force the card open inside the modal (a modal showing a collapsed
    // header is useless). Pre-stamp data-rendered-open='1' BEFORE flipping
    // .open so the capture-phase 'toggle' pref recorder sees a render echo
    // and does NOT record this as a user choice on the shared cardKey pref.
    var det = body.querySelector('details.sub-report');
    if (det && !det.open) {
        det.setAttribute('data-rendered-open', '1');
        det.open = true;
    }
}

// Open the modal for a worker's chat card. Reuses the global #modal-overlay
// scaffolding (backdrop click -> closeModal via the overlay's own onclick,
// Escape via the global handler in core/120-init.js). While open, a
// SubAgents listener live-refreshes the body exactly like the inline card.
function openWorkerChatModal(agentId) {
    var msg = _findSubReportMsg(agentId);
    if (!msg) {
        if (typeof showSnackbar === 'function') showSnackbar('No chat card found for this sub-agent', 'error');
        return;
    }
    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');
    if (!overlay || !header || !body) return;
    var name = msg.subAgentName || agentId;
    header.innerHTML = '<span class="modal-title-text">' + escapeHtml(name) + '</span>' +
        '<div class="modal-header-actions">' +
        '<button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';
    if (actions) actions.innerHTML = '';
    _workerModalAgentId = agentId;
    _workerModalKey = null; // force first paint
    _renderWorkerChatModalBody();
    overlay.classList.add('show');
    overlay.classList.add('worker-chat-modal');
    if (!_workerModalListener && typeof SubAgents !== 'undefined' && SubAgents.addListener) {
        _workerModalListener = function() {
            if (_workerModalRefreshScheduled) return;
            _workerModalRefreshScheduled = true;
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(_renderWorkerChatModalBody);
            else setTimeout(_renderWorkerChatModalBody, 16);
        };
        SubAgents.addListener(_workerModalListener);
    }
}

// Teardown hook — called by closeModal() (220-notification-system.js) on
// EVERY close path (close button, backdrop click, Escape) so the live
// listener never outlives the modal.
function _teardownWorkerChatModal() {
    if (_workerModalListener && typeof SubAgents !== 'undefined' && SubAgents.removeListener) {
        try { SubAgents.removeListener(_workerModalListener); } catch (_) {}
    }
    _workerModalListener = null;
    _workerModalAgentId = null;
    _workerModalKey = null;
    _workerModalRefreshScheduled = false;
}

// Whitelist worker state for class-name interpolation (defense-in-depth,
// same rationale as SUB_REPORT_STATUSES).
var WORKER_CARD_STATES = { running: 1, sleeping: 1, stopped: 1, errored: 1 };

// Context-length ring for a chat (sub-agent OR a normal top-level chat). Mirrors
// the main chat's .context-circle. Shared by worker cards (sidebar Workers
// panel) AND the jobs-dropdown chat rows so every surface shows the same live
// ring. `withTitle` opt-in adds a hover tooltip (worker cards keep their own
// button-level tooltip, so they pass it falsy for identical output).
function _contextCircleHtml(chatId, extraClass, withTitle) {
    var ctx = _subContextInfo(chatId);
    var ctxClass = ctx.pct >= 90 ? ' worker-ctx-danger' : (ctx.pct >= 70 ? ' worker-ctx-warning' : '');
    var titleAttr = '';
    if (withTitle) {
        var tip = ctx.tokens ? (_fmtTokens(ctx.tokens) + ' ctx tokens \u2014 ' + ctx.pct + '%') : 'context not started';
        titleAttr = ' title="' + escapeHtml(tip) + '"';
    }
    return '<span class="worker-ctx' + ctxClass + (extraClass ? ' ' + extraClass : '') + '" data-worker-ctx' + titleAttr + '>' +
        '<svg class="worker-ctx-circle" viewBox="0 0 36 36">' +
            '<path class="worker-ctx-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>' +
            '<path class="worker-ctx-fill" data-worker-ctx-fill stroke-dasharray="' + ctx.pct + ', 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>' +
        '</svg>' +
        '<span class="worker-ctx-pct" data-worker-ctx-pct>' + (ctx.tokens ? ctx.pct + '%' : '\u2014') + '</span>' +
    '</span>';
}

// Sorted list of sub-agents in a regular chat's subtree (root match, or direct
// parent match for legacy records with no root_chat_id). Same filter/sort
// renderWorkersStrip uses for a non-sub chat — reused by the jobs dropdown to
// list a chat's sub-agents inline under its progress.
function subAgentsForChatTree(chatId) {
    if (!chatId) return [];
    var all = (typeof SubAgents !== 'undefined' && SubAgents.listAll) ? SubAgents.listAll() : [];
    var mine = all.filter(function(r) {
        var root = r.root_chat_id || r.parent_chat_id;
        return root === chatId || r.parent_chat_id === chatId;
    });
    // Include GC'd subs reconstructed from persisted sub_report messages so the
    // jobs-dropdown accordion matches the sidebar Workers panel for old chats.
    _mergeReconstructedSubs(mine, chatId);
    var rank = { running: 0, sleeping: 1, stopped: 2, errored: 3 };
    mine.sort(function(a, b) {
        var ra = rank[a.state] != null ? rank[a.state] : 4;
        var rb = rank[b.state] != null ? rank[b.state] : 4;
        if (ra !== rb) return ra - rb;
        return (b.last_activity_at || 0) - (a.last_activity_at || 0);
    });
    return mine;
}

// Build a single sub-agent "worker card" (robot icon, name + state, live
// tool-call counter, context-length ring) plus its expandable inline progress
// panel. Shared by the sidebar Workers panel (renderWorkersStrip) and the jobs
// dropdown chat-row accordion so both surfaces render the identical component.
function _workerCardHtml(r) {
    var label = r.name || r.agent_id;
    var stateClass = WORKER_CARD_STATES[r.state] ? r.state : 'unknown';
    var stateLabel = r.state;
    // Phase 5: legacy records may lack `depth` — default to 1 (direct child of
    // root). Cap the rendered depth at 3 to match the CSS rule ladder.
    var depth = (typeof r.depth === 'number' && r.depth > 0) ? r.depth : 1;
    var renderDepth = Math.min(depth, 3);
    var used = (r.tool_calls_used || 0);
    var cap = r.max_tool_calls || '?';
    var ctx = _subContextInfo(r.chat_id);
    var tokTip = ctx.tokens ? (_fmtTokens(ctx.tokens) + ' ctx tokens \u2014 ' + ctx.pct + '%') : 'context not started';
    var botIcon = (typeof UI_ICONS !== 'undefined' && UI_ICONS.bot) ? UI_ICONS.bot : '';
    // Inline onclick removed (escapeHtml does not escape single quotes). The
    // document-level delegated listener handles data-worker-toggle / -reveal.
    var wkExpanded = !!_workerExpanded[r.agent_id];
    var progAt = r.action_state ? (r.action_state.at || 0) : 0;
    // Orchestrator §5: awaiting-approval badge, refreshed in place by
    // updateSidebarWorkerMetrics; inline styles keep the badge self-contained
    // (matches SUB_REVIEW_BADGES).
    var awaitingAp = _subAwaitingApproval(r);
    // Collapsed-card work counters (files edited / PRs opened) — rendered
    // only when > 0, refreshed in place by updateSidebarWorkerMetrics.
    var work = _subWorkStats(r.chat_id);
    // Orchestrator §6: the model this worker actually runs on (spawn-pinned
    // provider + tier). '' on legacy/reconstructed records → hidden.
    var modelLine = _subModelLine(r);
    return '<div class="worker-card-wrap" data-depth="' + renderDepth + '">' +
        '<button class="worker-card worker-' + stateClass + (wkExpanded ? ' worker-card-expanded' : '') + '" ' +
        'data-worker-toggle="' + escapeHtml(r.agent_id) + '" ' +
        'data-worker-chat="' + escapeHtml(r.chat_id || '') + '" ' +
        'aria-expanded="' + (wkExpanded ? 'true' : 'false') + '" ' +
        'title="' + escapeHtml(label) + ' \u2014 ' + escapeHtml(r.state) + ' \u2014 ' + escapeHtml(String(used)) + '/' + escapeHtml(String(cap)) + ' tool calls \u2014 ' + escapeHtml(tokTip) + ' \u2014 depth ' + escapeHtml(String(depth)) + '">' +
        '<span class="worker-card-icon" aria-hidden="true">' + botIcon + '</span>' +
        '<span class="worker-card-main">' +
            '<span class="worker-card-row">' +
                '<span class="worker-state-dot worker-dot-' + stateClass + '"></span>' +
                '<span class="worker-name">' + escapeHtml(label) + '</span>' +
                '<span class="worker-approval-badge" data-worker-approval title="a tool call is awaiting user approval in this sub\u2019s chat"' +
                ' style="margin-left:4px;padding:0 5px;border-radius:8px;font-size:9px;font-weight:600;white-space:nowrap;background:#5c4d10;color:#ffe289;"' +
                (awaitingAp ? '' : ' hidden') + '>approval</span>' +
            '</span>' +
            '<span class="worker-card-row worker-card-sub">' +
                '<span class="worker-state">' + escapeHtml(stateLabel) + '</span>' +
                '<span class="worker-tools" data-worker-tools>' + escapeHtml(String(used)) + ' tool calls</span>' +
                '<span class="worker-files" data-worker-files title="workspace files edited by this sub"' + (work.files ? '' : ' hidden') + '>' + escapeHtml(_subCountLabel(work.files, 'file', 'files')) + '</span>' +
                '<span class="worker-prs" data-worker-prs title="PRs opened by this sub"' + (work.prs ? '' : ' hidden') + '>' + escapeHtml(_subCountLabel(work.prs, 'PR', 'PRs')) + '</span>' +
            '</span>' +
            // Orchestrator §6: own row — the provider/tier string is long
            // and would crush the state/tools row into ellipsis.
            (modelLine
                ? '<span class="worker-card-row worker-card-sub"><span class="worker-model" data-worker-model title="model this worker runs on \u2014 provider (tier)">' + escapeHtml(modelLine) + '</span></span>'
                : '') +
        '</span>' +
        _contextCircleHtml(r.chat_id) +
        '<span class="worker-card-caret" aria-hidden="true">\u203a</span>' +
    '</button>' +
    '<div class="worker-card-progress" data-worker-progress="' + escapeHtml(r.agent_id) + '" data-prog-at="' + progAt + '"' + (wkExpanded ? '' : ' hidden') + '>' +
        (wkExpanded ? _workerProgressInner(r) : '') +
    '</div>' +
    '</div>';
}

// Synthetic worker-card records reconstructed from a finished chat's persisted
// sub_report messages (see _reconstructSubsFromMessages). Keyed by agent_id so
// toggleWorkerProgress / updateSidebarWorkerMetrics can resolve a card whose
// live registry record has already been GC'd. Rebuilt on every renderWorkersStrip.
var _reconstructedSubs = Object.create(null);

// Resolve a sub-agent record for card interactions: prefer the live registry
// record, fall back to a reconstructed-from-message record (registry-purged).
function _resolveSubRec(agentId) {
    var rec = (agentId && typeof SubAgents !== 'undefined' && SubAgents.getById) ? SubAgents.getById(agentId) : null;
    return rec || _reconstructedSubs[agentId] || null;
}

// Map a sub_report message's report.status to a worker-card lifecycle state.
function _reportStatusToWorkerState(status) {
    if (status === 'error') return 'errored';
    if (status === 'running' || status === 'need_input') return 'sleeping';
    return 'stopped'; // done / cancelled / partial / unknown -> terminal
}

// Reconstruct synthetic worker-card records from a chat's persisted sub_report
// messages. The sidebar Workers panel is normally driven by the live SubAgents
// registry, but that registry GCs settled/sleeping sub records ~1h after they
// finish (SUBAGENT_TOMBSTONE_TTL_MS). The inline sub_report cards survive in
// chat.messages, so we mine them to keep listing a finished chat's sub-agents.
// One record per sub — iterate newest-first so the latest report wins.
function _reconstructSubsFromMessages(chatId) {
    var out = [];
    var c = (chatId && typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c || !Array.isArray(c.messages)) return out;
    var seen = Object.create(null);
    for (var i = c.messages.length - 1; i >= 0; i--) {
        var m = c.messages[i];
        if (!m || m.role !== 'sub_report' || !m.subAgentId || seen[m.subAgentId]) continue;
        seen[m.subAgentId] = true;
        var report = m.report || {};
        out.push({
            agent_id: m.subAgentId,
            name: m.subAgentName || m.subAgentId,
            chat_id: m.subChatId || '',
            state: _reportStatusToWorkerState(report.status),
            action_state: m.actionState || null,
            tool_calls_used: (typeof m.toolCallsUsed === 'number') ? m.toolCallsUsed : 0,
            max_tool_calls: m.maxToolCalls || '?',
            depth: (typeof m.subDepth === 'number' && m.subDepth > 0) ? m.subDepth : 1,
            last_activity_at: report.at || m.createdAt || 0,
            _reconstructed: true
        });
    }
    return out;
}

// Merge reconstructed (message-persisted) sub records into a live list for a
// chat: for each sub in the chat's sub_report history NOT already present as a
// live record, append a synthetic record and register it in _reconstructedSubs
// so click/metrics can resolve a card whose registry record was GC'd. Live
// records always win. Mutates and returns `list`.
function _mergeReconstructedSubs(list, chatId) {
    var liveIds = Object.create(null);
    list.forEach(function(r) { if (r && r.agent_id) liveIds[r.agent_id] = true; });
    _reconstructSubsFromMessages(chatId).forEach(function(r) {
        if (!liveIds[r.agent_id]) { _reconstructedSubs[r.agent_id] = r; list.push(r); }
    });
    return list;
}

function renderWorkersStrip() {
    var stripEl = document.getElementById('sidebar-workers');
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
    // Backfill from persisted sub_report messages: once the registry GCs a
    // finished chat's settled sub records (~1h), listAll() no longer returns
    // them, so a stopped chat would show an EMPTY Workers panel even though its
    // inline sub_report cards persist. Reconstruct synthetic cards for any sub
    // not already live (a sub-agent's own chat keeps the live-subtree view).
    if (!isCurrentSub) _mergeReconstructedSubs(mine, currentChatId);
    if (!mine.length) { stripEl.innerHTML = ''; stripEl.style.display = 'none'; return; }
    // Sort: running, sleeping, then terminal (most-recent first).
    var rank = { running: 0, sleeping: 1, stopped: 2, errored: 3 };
    mine.sort(function(a, b) {
        var ra = rank[a.state] != null ? rank[a.state] : 4;
        var rb = rank[b.state] != null ? rank[b.state] : 4;
        if (ra !== rb) return ra - rb;
        return (b.last_activity_at || 0) - (a.last_activity_at || 0);
    });
    var chips = mine.map(_workerCardHtml).join('');
    stripEl.innerHTML = '<div class="sidebar-workers-header">Workers (' + mine.length + ')</div>' +
        '<div class="sidebar-workers-list">' + chips + '</div>';
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
        // Key over every sub_report card's identity + stored status + progress
        // length + (for non-terminal cards) the LIVE registry state. This makes
        // renderMessages re-run when: a card is added, progress streams in, the
        // stored status changes, or a running card's live state transitions
        // (running -> sleeping/stopped/done). tool_calls_used is deliberately
        // EXCLUDED so heartbeat ticks don't trigger a full message repaint —
        // the spinner animates via CSS, no re-render needed.
        var parts = [currentChatId];
        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            if (!m || m.role !== 'sub_report') continue;
            var st = (m.report && m.report.status) || 'partial';
            var prog = Array.isArray(m.progress) ? m.progress.length : 0;
            // Include archived-phase count (+ trim counter) so a wake —
            // which moves progress into msg.phases and resets the stream —
            // changes the key and triggers a repaint even when the lengths
            // above happen to collide with the pre-wake values.
            var phn = Array.isArray(m.phases) ? m.phases.length : 0;
            var live = '';
            if ((st === 'running' || st === 'partial')
                && m.subAgentId && typeof SubAgents !== 'undefined' && SubAgents.getById) {
                var r = SubAgents.getById(m.subAgentId);
                if (r) live = r.state;
            }
            parts.push((m.subAgentId || '') + ':' + st + ':' + prog + ':' + phn + ':' + ((m.phasesDropped | 0)) + ':' + live);
        }
        return parts.join('|');
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
            } else {
                // Worker set + states unchanged (a heartbeat tick: tool counter
                // ticked or context grew) — refresh only the live metrics so the
                // cards' pulse/circle animations don't restart on every tick.
                updateSidebarWorkerMetrics();
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
            // −/+ string-collapse toggles inside sub-report panels carry
            // data-sub-collapse (stable pref key) + data-sub-collapse-id
            // (stable DOM id). Toggle via the shared toggleJsonCollapse,
            // then record the new state so the next repaint re-renders the
            // panel exactly as the user left it.
            var colEl = (evt.target && evt.target.getAttribute) ? evt.target : null;
            var colKey = colEl ? colEl.getAttribute('data-sub-collapse') : null;
            if (colKey) {
                var colId = colEl.getAttribute('data-sub-collapse-id');
                if (colId && typeof toggleJsonCollapse === 'function') {
                    toggleJsonCollapse(colId, evt);
                    var expandedEl = document.getElementById(colId);
                    // toggleJsonCollapse re-shows with display:'inline',
                    // which pins the markdown variant (.sub-md, block
                    // content) inline next to the toggle and defeats the
                    // collapsed preview's inline-block ellipsis. Restore ''
                    // on whichever element it just re-showed so the
                    // stylesheet display rules (24-sub-agents.css) apply.
                    if (expandedEl && expandedEl.classList && expandedEl.classList.contains('sub-md')) {
                        if (expandedEl.style.display !== 'none') {
                            expandedEl.style.display = '';
                        } else {
                            var collapsedEl = document.getElementById(colId + '-collapsed');
                            if (collapsedEl && collapsedEl.style.display !== 'none') collapsedEl.style.display = '';
                        }
                    }
                    _subPanelPref['str:' + colKey] = !!(expandedEl && expandedEl.style.display === 'none');
                }
                return;
            }
            var t = evt.target;
            while (t && t !== document) {
                if (t.getAttribute) {
                    // Worker card click -> toggle its inline progress panel
                    // (update_action_state tasks). Checked before the reveal
                    // branch; the "open chat" link inside the panel carries
                    // data-sub-agent-reveal and falls through to it.
                    var wkToggle = t.getAttribute('data-worker-toggle');
                    if (wkToggle) {
                        toggleWorkerProgress(wkToggle, t);
                        evt.preventDefault();
                        return;
                    }
                    // "Chat view" link inside an expanded worker card —
                    // opens the sub's inline chat card in the global modal.
                    var wkModal = t.getAttribute('data-worker-modal');
                    if (wkModal) {
                        openWorkerChatModal(wkModal);
                        evt.preventDefault();
                        return;
                    }
                    // data-sub-agent-reveal carries an agent_id (resolved
                    // via registry); data-sub-chat-id carries a direct
                    // chat id (used for sub_report links so they keep
                    // working after the registry GCs the settled record).
                    var aid = t.getAttribute('data-sub-agent-reveal');
                    var cid = t.getAttribute('data-sub-chat-id');
                    if (aid || cid) {
                        revealSubAgentChat(aid || cid);
                        // A reveal clicked INSIDE the worker chat-view modal
                        // (the card's own "open chat" button) navigates the
                        // chat BEHIND the overlay — close the modal so the
                        // user actually sees the chat they asked for.
                        var _ovl = document.getElementById('modal-overlay');
                        if (_ovl && _ovl.classList.contains('worker-chat-modal') && _ovl.contains(t) && typeof closeModal === 'function') {
                            closeModal();
                        }
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
        // Record the user's open/collapse choice for sub-report cards so the
        // next repaint honors it. Listen for the native 'toggle' event in the
        // CAPTURE phase (toggle does not bubble) — it fires for EVERY way a
        // <details> can flip: mouse click on the summary AND keyboard
        // (Enter/Space on the focused summary), which the old click+setTimeout
        // recorder missed, so keyboard collapses were forgotten and the next
        // progress repaint snapped the card back open. This listener is the
        // SINGLE recorder (the click-path heuristic was removed — it had no
        // other side effects) so prefs can't be double-recorded.
        // Chrome also fires 'toggle' when a <details open> is inserted via
        // innerHTML (every repaint!), so compare against the data-rendered-open
        // stamp renderSubReport writes and ignore render echoes; only a state
        // that DIFFERS from what was rendered is a real user choice.
        document.addEventListener('toggle', function(evt) {
            var det = evt.target;
            if (!det || !det.getAttribute) return;
            var prefKey = det.getAttribute('data-sub-report-toggle');
            if (!prefKey) return;
            var isOpen = !!det.open;
            var rendered = det.getAttribute('data-rendered-open');
            if (rendered !== null && ((rendered === '1') === isOpen)) return; // render echo
            det.setAttribute('data-rendered-open', isOpen ? '1' : '0');
            _subReportOpenPref[prefKey] = isOpen;
        }, true);
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
