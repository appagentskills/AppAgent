// ============================================
// SPLIT VIEW: pin one widget next to the chat for interactive editing.
// ============================================
// The `split_view` tool (open / replace / close / status) splits the chat
// screen and shows ONE saved html_widget in an <aside id="split-widget-pane">
// beside the conversation. The user can close it with the × button.
//
// State lives in chrome.storage.local under SPLIT_VIEW_STORAGE_KEY, keyed by
// the ROOT chat id (splitViewRootChatId: a parent chat and its sub-agents
// share ONE split view), so BOTH realms see it: the panel page renders the pane and the
// service worker (which owns the agent loop) pushes a tail context row
// (maybePushSplitViewTailContext, called from app/030-agent-loop.js; NOT the
// system prompt, so the prompt cache survives split changes). A user close is recorded as {closed:true} so
// the agent is told the pane was closed rather than silently losing it.
//
// The split_view schema lives in the TOOLS registry (core/080-tools.js).
// This file holds the runtime: state, executor, prompt context and pane UI.
// It is in WORKER_SHARED_FILES (numeric order) because the SW builds the
// tail context row (maybePushSplitViewTailContext) and must read the same
// chrome.storage state; executeSplitView itself runs
// on the page (headless: false) and the DOM helpers no-op in the SW.

var SPLIT_VIEW_STORAGE_KEY = 'appagent_split_views';
var _splitViews = {};

function _splitViewStorage() {
    try {
        return (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
    } catch (e) { return null; }
}

function _splitViewPersist() {
    var store = _splitViewStorage();
    if (!store) return Promise.resolve();
    var payload = {};
    payload[SPLIT_VIEW_STORAGE_KEY] = _splitViews;
    return new Promise(function(resolve) {
        try { store.set(payload, function() { resolve(); }); } catch (e) { resolve(); }
    });
}

// ONE split view per chat FAMILY: state is keyed by the ROOT chat id, so a
// parent chat and all of its sub-agent chats (any depth) share the same pane
// and the same per-turn context. resolveRootChatId lives in
// core/070-permissions.js (both bundles). Legacy per-chat entries keep
// working for top-level chats (their id IS the root); old entries recorded
// under a sub-agent chat id are simply ignored.
function splitViewRootChatId(chatId) {
    if (!chatId) return null;
    try {
        if (typeof resolveRootChatId === 'function') return resolveRootChatId(chatId) || String(chatId);
    } catch (e) {}
    return String(chatId);
}

// Raw record for a chat family (may be a {closed:true} marker).
function getSplitViewRecord(chatId) {
    var root = splitViewRootChatId(chatId);
    return (root && _splitViews[root]) || null;
}

// The widget currently SHOWN in split view for a chat, or null.
function getSplitViewState(chatId) {
    var rec = getSplitViewRecord(chatId);
    return rec && !rec.closed && rec.widgetId ? rec : null;
}

function setSplitViewState(chatId, state) {
    var root = splitViewRootChatId(chatId);
    if (!root) return Promise.resolve();
    var prev = _splitViews[root];
    // Pane closed or replaced by another widget: a pending in-place slot patch
    // for the old widget can never apply to this pane any more -> drop it.
    if (prev && prev.widgetId && (!state || state.closed || state.widgetId !== prev.widgetId)) delete _splitViewSlotPatches[prev.widgetId];
    _splitViews = Object.assign({}, _splitViews);
    if (state) _splitViews[root] = state; else delete _splitViews[root];
    return _splitViewPersist();
}

// Latest saved version of a widget, best effort (WidgetStore is page-only).
function _splitViewLatestVersion(widgetId, fallback) {
    try {
        if (typeof WidgetStore !== 'undefined' && WidgetStore && typeof WidgetStore.view === 'function') {
            var v = WidgetStore.view(widgetId);
            if (v && v.latestVersion) return v.latestVersion;
        }
    } catch (e) {}
    return fallback || null;
}

// Called from refreshWidgetVersionViews (core/135-widget-store.js) whenever a
// widget version commits: keep the recorded version (what the agent is told)
// and the pane header in step with the saved widget.
function noteSplitViewWidgetCommitted(widgetId) {
    if (!widgetId) return;
    var changed = false;
    Object.keys(_splitViews).forEach(function(chatId) {
        var rec = _splitViews[chatId];
        if (!rec || rec.closed || rec.widgetId !== widgetId) return;
        var latest = _splitViewLatestVersion(widgetId, rec.version);
        var title = rec.title;
        try {
            var w = typeof getWidgetById === 'function' ? getWidgetById(widgetId) : null;
            if (w && w.title) title = w.title;
        } catch (e) {}
        if (latest !== rec.version || title !== rec.title) {
            _splitViews = Object.assign({}, _splitViews);
            _splitViews[chatId] = Object.assign({}, rec, { version: latest, title: title });
            changed = true;
        }
    });
    if (changed) {
        _splitViewPersist();
        _splitViewUpdateHeader();
    }
}

// --- Per-turn prompt context ---
function buildSplitViewContext(chatId) {
    var rec = getSplitViewRecord(chatId);
    if (!rec) return '';
    if (rec.closed) {
        return '\n\nSplit view: closed. The user closed the split widget pane' +
            (rec.widgetId ? ' (it showed widget "' + (rec.title || rec.widgetId) + '", widget_id ' + rec.widgetId + ')' : '') +
            '. No widget is displayed in split view now; do not assume the user is looking at it. Reopen it with split_view only if the user asks or the work is interactive widget editing again.';
    }
    // No version here: WidgetStore is absent in the service worker (which
    // builds this row), so any version would be stale.
    return '\n\nSplit view — interactive widget editing: the chat screen is split and the widget "' + (rec.title || rec.widgetId) +
        '" (widget_id: ' + rec.widgetId + '; latest version: see html_widget results) is displayed in the split pane next to the chat' +
        (rec.openedBy === 'user' ? ' (the user put it there with the Split view button)' : '') + '. ' +
        'The split view is meant for interactive editing of this displayed widget:\n' +
        '- Keep working on this widget: every widget change the user asks for is an edit to it. Reuse widget_id ' + rec.widgetId +
        ' — read it first (html_widget action=read) and save with expected_version — instead of creating a new inline widget. The pane refreshes automatically on every saved version.\n' +
        '- Only if the user clearly asks for a completely different widget, build that one; if that work is interactive too, pin it to the split pane with split_view action="replace" (its widget_id) instead of only rendering it inline.\n' +
        '- The user can close the pane at any time; you will be told when they do.';
}

// C: tail context row (app/030-agent-loop.js pushes it before an LLM call).
// Returns {sig, content} or null when there is nothing to say. sig covers
// ONLY shown/closed + widget_id: version and pendingUpdate are page-realm,
// volatile state (the SW has no WidgetStore) and would churn rows / go stale.
// html_widget results and split_view status report the live version/hold.
function buildSplitViewTailContext(chatId) {
    var rec = getSplitViewRecord(chatId);
    if (!rec) return { sig: 'none', content: 'Split view: no widget is displayed in split view.' };
    if (rec.closed) return { sig: 'closed|' + (rec.widgetId || ''), content: buildSplitViewContext(chatId).replace(/^\s+/, '') };
    if (!rec.widgetId) return { sig: 'none', content: 'Split view: no widget is displayed in split view.' };
    var content = buildSplitViewContext(chatId).replace(/^\s+/, '');
    content += '\n- While the user is typing in the pane, a saved update may be held behind a "New update" pill (split_view action=status reports pending_update).';
    content += '\n- Prefer html_widget action="patch" with slots:{name: html} (elements marked data-slot="name") for small live updates: they apply in place without resetting the user\'s scroll/inputs.';
    return { sig: 'shown|' + rec.widgetId, content: content };
}

// Pushes a role:'context' _splitViewCtx row onto chat.messages when the split
// signature differs from the last such row. No record and no prior row → no-op.
function maybePushSplitViewTailContext(chat, chatId) {
    if (!chat || !Array.isArray(chat.messages)) return false;
    var ctx = null;
    try { ctx = buildSplitViewTailContext(chatId); } catch (e) { return false; }
    if (!ctx) return false;
    var last = null;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m && m._splitViewCtx) { last = m; break; }
    }
    if (!last && ctx.sig === 'none') return false;
    if (last && last._splitViewSig === ctx.sig) return false;
    chat.messages.push({ role: 'context', _splitViewCtx: true, _splitViewSig: ctx.sig, content: ctx.content, timestamp: Date.now() });
    return true;
}

// --- Tool executor (page realm) ---
function _splitViewChatId(options) {
    if (options && options.chatId) return options.chatId;
    if (typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId) return activeStreamingChatId;
    if (typeof currentChatId !== 'undefined') return currentChatId;
    return null;
}

function _splitViewDescribe(chatId) {
    var s = getSplitViewState(chatId);
    if (!s) {
        var rec = getSplitViewRecord(chatId);
        return { shown: false, closed_by_user: !!(rec && rec.closed && rec.closedBy === 'user') };
    }
    return { shown: true, widget_id: s.widgetId, title: s.title || '', version: _splitViewLatestVersion(s.widgetId, s.version), opened_by: s.openedBy || 'agent', pending_update: !!s.pendingUpdate, progress: s.progress || null, root_chat_id: splitViewRootChatId(chatId) };
}

var SPLIT_PROGRESS_STATES = ['running', 'waiting', 'stuck', 'done', 'error'];
async function _splitViewSetProgress(chatId, args) {
    var s = getSplitViewState(chatId);
    if (!s) return { success: false, error: 'No split view is shown; open one first (split_view action=open).' };
    if (args.clear) {
        var cleared = Object.assign({}, s);
        delete cleared.progress;
        await setSplitViewState(chatId, cleared);
        _splitViewUpdateHeader();
        return { success: true, split_view: _splitViewDescribe(chatId) };
    }
    var state = SPLIT_PROGRESS_STATES.indexOf(args.state) !== -1 ? args.state : 'running';
    var tasks = Array.isArray(args.tasks) ? args.tasks.slice(0, 30).map(function(t) {
        t = t || {};
        return { label: String(t.label || '').slice(0, 200), status: ['pending', 'running', 'done', 'error'].indexOf(t.status) !== -1 ? t.status : 'pending' };
    }).filter(function(t) { return t.label; }) : [];
    var progress = { state: state, label: String(args.label || '').slice(0, 120), tasks: tasks, output: args.output ? String(args.output).slice(0, 2000) : '', updatedAt: Date.now() };
    await setSplitViewState(chatId, Object.assign({}, s, { progress: progress }));
    _splitViewUpdateHeader();
    return { success: true, split_view: _splitViewDescribe(chatId) };
}

async function executeSplitView(args, options) {
    args = args || {};
    var action = args.action;
    var chatId = _splitViewChatId(options);
    if (!chatId) return { success: false, error: 'No active chat for split_view' };
    if (action === 'status') {
        var st = { success: true, split_view: _splitViewDescribe(chatId) };
        try { var tc = buildSplitViewTailContext(chatId); if (tc) st.context = tc.content; } catch (e) {}
        return st;
    }
    if (action === 'progress') return _splitViewSetProgress(chatId, args);
    if (action === 'close') {
        var had = getSplitViewState(chatId);
        await setSplitViewState(chatId, null);
        renderSplitViewPane();
        return { success: true, message: had ? 'Split view closed' : 'Split view was not open', split_view: { shown: false } };
    }
    if (action !== 'open' && action !== 'replace') {
        return { success: false, error: "action must be 'open', 'replace', 'close', 'status' or 'progress'" };
    }
    var widgetId = args.widget_id;
    if (!widgetId) return { success: false, error: 'widget_id is required for ' + action };
    var widget = typeof getWidgetById === 'function' ? getWidgetById(widgetId) : null;
    if (!widget) return { success: false, error: 'Widget not found: ' + widgetId };
    var current = getSplitViewState(chatId);
    if (action === 'open' && current && current.widgetId !== widgetId) {
        return { success: false, error: 'Split view already shows widget ' + current.widgetId + ' ("' + (current.title || '') + '"). Keep editing it, or use action "replace" only if the user wants a completely different widget.', split_view: _splitViewDescribe(chatId) };
    }
    await setSplitViewState(chatId, {
        widgetId: widgetId,
        title: widget.title || '',
        version: _splitViewLatestVersion(widgetId, widget.version),
        openedAt: Date.now()
    });
    renderSplitViewPane({ force: true });
    return {
        success: true,
        message: (action === 'replace' && current ? 'Split view now shows ' : 'Split view opened with ') + widgetId + '. Edits to this widget refresh the pane automatically.',
        split_view: _splitViewDescribe(chatId)
    };
}

// --- Pane UI (page realm only) ---
function _splitViewHasDom() {
    return typeof document !== 'undefined' && document && typeof document.querySelector === 'function' && typeof document.createElement === 'function' && typeof document.getElementById === 'function';
}

// User-initiated open ("Split view" button on any widget header): same state
// the split_view tool writes, so the agent sees it in its next turn.
function openSplitViewForWidget(widgetId, chatId, opts) {
    opts = opts || {};
    chatId = chatId || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    var widget = (widgetId && typeof getWidgetById === 'function') ? getWidgetById(widgetId) : null;
    if (!chatId || !widget) return Promise.resolve(false);
    var p = setSplitViewState(chatId, {
        widgetId: widgetId,
        title: widget.title || '',
        version: _splitViewLatestVersion(widgetId, widget.version),
        openedAt: Date.now(),
        openedBy: opts.openedBy === 'agent' ? 'agent' : 'user'
    });
    renderSplitViewPane({ force: true });
    return p.then(function() { return true; });
}

// Header/toolbar button handler: open the widget in the split pane (closing a
// fullscreen overlay first), or close the pane when it already shows it.
function toggleWidgetSplitView(widgetId, event) {
    if (event && event.stopPropagation) { event.stopPropagation(); if (event.preventDefault) event.preventDefault(); }
    var chatId = typeof currentChatId !== 'undefined' ? currentChatId : null;
    var s = getSplitViewState(chatId);
    if (s && s.widgetId === widgetId) return closeSplitView();
    if (_splitViewHasDom() && document.getElementById('widget-fullscreen-overlay') && typeof closeWidgetFullscreen === 'function') closeWidgetFullscreen();
    return openSplitViewForWidget(widgetId, chatId);
}

function isWidgetInSplitView(widgetId) {
    var s = getSplitViewState(typeof currentChatId !== 'undefined' ? currentChatId : null);
    return !!(s && widgetId && s.widgetId === widgetId);
}

// Shared "Split view" button markup (inline chat card + fullscreen header).
function splitViewButtonHtml(widgetId, btnClass) {
    var esc = typeof escapeHtml === 'function' ? escapeHtml : function(s) { return String(s == null ? '' : s); };
    var tr = typeof t === 'function' ? t : function(s) { return s; };
    var on = isWidgetInSplitView(widgetId);
    var label = on ? tr('Close split view') : tr('Split view');
    var icon = (typeof UI_ICONS !== 'undefined' && UI_ICONS && UI_ICONS.panelRight) || '';
    return '<button type="button" class="' + (btnClass || 'widget-ctrl-btn') + ' widget-split-btn' + (on ? ' is-active' : '') + '" data-widget-id="' + esc(widgetId) + '" aria-pressed="' + (on ? 'true' : 'false') + '" onclick="toggleWidgetSplitView(\'' + esc(widgetId) + '\', event)" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + icon + '</button>';
}

// Keep every rendered split button's active state / tooltip in sync.
function _splitViewSyncButtons() {
    if (!_splitViewHasDom() || typeof document.querySelectorAll !== 'function') return;
    var tr = typeof t === 'function' ? t : function(s) { return s; };
    document.querySelectorAll('.widget-split-btn[data-widget-id]').forEach(function(btn) {
        var on = isWidgetInSplitView(btn.getAttribute('data-widget-id'));
        var label = on ? tr('Close split view') : tr('Split view');
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.title = label;
        btn.setAttribute('aria-label', label);
    });
}

function refreshSplitViewPane() { renderSplitViewPane({ force: true }); }

// User-initiated close (× button): record the close so the agent is told.
function closeSplitView() {
    var chatId = typeof currentChatId !== 'undefined' ? currentChatId : null;
    var s = getSplitViewState(chatId);
    var p = setSplitViewState(chatId, s ? { closed: true, closedBy: 'user', widgetId: s.widgetId, title: s.title || '', closedAt: Date.now() } : null);
    renderSplitViewPane();
    return p;
}

function _splitViewSyncVisibility() {
    if (!_splitViewHasDom()) return;
    var pane = document.getElementById('split-widget-pane');
    var main = document.getElementById('main-area');
    var hidden = !main || main.style.display === 'none';
    if (pane) pane.hidden = hidden;
    var active = !!pane && !hidden;
    if (document.body) document.body.classList.toggle('split-view-active', active);
    // Drag-to-resize divider (ui/242-panel-resize.js); re-added after every
    // innerHTML rewrite and re-applies the persisted pane width.
    if (active && typeof ensureSplitPaneResizeHandle === 'function') { try { ensureSplitPaneResizeHandle(pane); } catch (e) {} }
    // F: the right sidebar follows the GLOBAL split-mode key while the pane is
    // visible and the normal key otherwise (ui/120-ui-utils.js).
    if (typeof applyVersionSidebarMode === 'function') { try { applyVersionSidebarMode(active); } catch (e) {} }
}

function _splitViewUpdateHeader() {
    if (!_splitViewHasDom()) return;
    var pane = document.getElementById('split-widget-pane');
    if (!pane) return;
    var s = getSplitViewState(pane.dataset.chatId);
    if (!s) return;
    // Version is shown by the header's picker (attachWidgetVersionPicker).
    var titleEl = pane.querySelector('.split-widget-header .widget-title');
    if (titleEl) titleEl.textContent = s.title || s.widgetId;
    _splitViewRenderProgress(pane, s);
}

// B: compact progress card under the pane header (state dot + label, a
// collapsible task list and optional output). Stored on the split record.
function _splitViewRenderProgress(pane, s) {
    var header = pane.querySelector('.split-widget-header');
    var box = pane.querySelector('.split-widget-progress');
    var p = s && s.progress;
    if (!p || !header) { if (box) box.remove(); return; }
    var esc = typeof escapeHtml === 'function' ? escapeHtml : function(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function(c) { return '&#' + c.charCodeAt(0) + ';'; }); };
    var tr = typeof t === 'function' ? t : function(x) { return x; };
    var wasOpen = box ? box.open : false;
    if (!box) {
        box = document.createElement('details');
        box.className = 'split-widget-progress';
        header.parentNode.insertBefore(box, header.nextSibling);
    }
    var tasks = Array.isArray(p.tasks) ? p.tasks : [];
    var doneCount = tasks.filter(function(x) { return x.status === 'done'; }).length;
    box.setAttribute('data-state', p.state || 'running');
    box.innerHTML = '<summary class="split-progress-summary"><span class="split-progress-dot" aria-hidden="true"></span>' +
        '<span class="split-progress-label">' + esc(p.label || tr('Working')) + '</span>' +
        (tasks.length ? '<span class="split-progress-count">' + doneCount + '/' + tasks.length + '</span>' : '') + '</summary>' +
        (tasks.length ? '<ul class="split-progress-tasks">' + tasks.map(function(x) {
            return '<li class="split-progress-task" data-status="' + esc(x.status) + '">' + esc(x.label) + '</li>';
        }).join('') + '</ul>' : '') +
        (p.output ? '<div class="split-progress-output">' + esc(p.output) + '</div>' : '');
    box.open = wasOpen;
}

// --- A: live update of the pane iframe (page realm) ---
var SPLIT_VIEW_HOLD_MS = 5000;
// editableFocused: the sandbox reported focusin on an input/textarea/select/
// contenteditable (widget-sandbox.html widgetReportActivity `editable`). Mere
// focus on the pane iframe (e.g. after clicking a chart) does NOT hold.
var _splitViewActivity = { lastInputAt: 0, editableFocused: false };
var _splitViewSlotPatches = {};

// Record a slot patch (html_widget action=patch) so the pane can apply it in
// place when it is still showing the patch's base content version. Must be
// called BEFORE WidgetStore.commit: commit -> project -> refreshWidgetVersionViews
// -> splitViewApplyUpdate runs synchronously inside commit, so a note made
// after commit is always too late (the pane would full-reload). `version` is
// the EXPECTED new version (expected_version + 1); `html` is the exact html
// this commit stores (widgetApplySlotsToHtml output). splitViewApplyUpdate
// only uses the patch when BOTH match the committed latest version: a
// concurrent writer that commits the same version number first (different
// html) must never get our slots applied over its content -> reload instead.
function splitViewNoteSlotPatch(widgetId, baseContentVersion, version, slots, html) {
    if (!widgetId) return;
    _splitViewSlotPatches[widgetId] = { base: String(baseContentVersion == null ? '' : baseContentVersion), version: version, slots: slots, html: typeof html === 'string' ? html : null };
}

// Settle a pre-commit slot patch once the commit returned. Failed commit (or
// a different committed version): drop it. Successful commit: the synchronous
// project() already consumed it if the pane showed the base; keep a leftover
// ONLY while the pane still shows this widget at an older version (update held
// by user interaction -> the pill's Show can still apply it in place).
function splitViewSettleSlotPatch(widgetId, version, committedOk) {
    var patch = _splitViewSlotPatches[widgetId];
    if (!patch || patch.version !== version) return false;
    if (committedOk) {
        var f = _splitViewPaneFrame();
        if (f && f.dataset && f.dataset.savedWidgetId === widgetId && f.dataset.savedWidgetVersion === patch.base) return true;
    }
    delete _splitViewSlotPatches[widgetId];
    return false;
}

// True when the iframe is mounted inside #split-widget-pane (light DOM or a
// shadow root inside it).
function splitViewFrameInPane(iframe) {
    var node = iframe;
    while (node) {
        if (node.id === 'split-widget-pane') return true;
        node = node.parentNode || node.host || null;
    }
    return false;
}

function _splitViewPaneFrame() {
    if (!_splitViewHasDom()) return null;
    var pane = document.getElementById('split-widget-pane');
    if (!pane) return null;
    var f = pane.querySelector('iframe');
    if (f) return f;
    var hosts = pane.querySelectorAll('.widget-shadow-host');
    for (var i = 0; i < hosts.length; i++) if (hosts[i].shadowRoot && (f = hosts[i].shadowRoot.querySelector('iframe'))) return f;
    return null;
}

// Hold an update only while an EDITABLE element inside the pane is focused,
// or there was user activity in the last SPLIT_VIEW_HOLD_MS. Focus on the
// iframe alone never holds (it would hold updates forever).
function _splitViewIsInteracting(iframe) {
    if (_splitViewHasDom() && _splitViewActivity.editableFocused) {
        var ae = document.activeElement;
        var inFrame = ae === iframe || !!(ae && ae.shadowRoot && ae.shadowRoot.activeElement === iframe);
        // Focus left the frame (page activeElement is authoritative): the
        // sandbox's editable-focus report no longer counts.
        if (!inFrame && ae && ae !== document.body) _splitViewActivity.editableFocused = false;
    }
    if (_splitViewActivity.editableFocused) return true;
    return Date.now() - _splitViewActivity.lastInputAt < SPLIT_VIEW_HOLD_MS;
}

function _splitViewSetPending(widgetId, pending) {
    var changed = false;
    Object.keys(_splitViews).forEach(function(cid) {
        var rec = _splitViews[cid];
        if (!rec || rec.closed || rec.widgetId !== widgetId || !!rec.pendingUpdate === !!pending) return;
        _splitViews = Object.assign({}, _splitViews);
        var next = Object.assign({}, rec);
        if (pending) next.pendingUpdate = true; else delete next.pendingUpdate;
        _splitViews[cid] = next;
        changed = true;
    });
    if (changed) _splitViewPersist();
}

// "New update — show" pill at the top of the pane (same button pattern as
// the version badge's Show latest, core/135-widget-store.js).
function _splitViewShowPill(iframe, widgetId) {
    var pane = _splitViewHasDom() && document.getElementById('split-widget-pane');
    if (!pane) return;
    var pill = pane.querySelector('.split-widget-update-pill');
    if (!pill) {
        var tr = typeof t === 'function' ? t : function(x) { return x; };
        pill = document.createElement('div');
        pill.className = 'split-widget-update-pill';
        pill.setAttribute('role', 'status');
        var label = document.createElement('span');
        label.textContent = tr('New update');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'widget-version-show-latest split-widget-update-show';
        btn.textContent = tr('Show');
        btn.addEventListener('click', function(e) {
            if (e && e.stopPropagation) e.stopPropagation();
            var f = _splitViewPaneFrame();
            if (f) splitViewApplyUpdate(f, f.dataset.savedWidgetId || widgetId, { force: true });
        });
        pill.appendChild(label);
        pill.appendChild(btn);
        var content = pane.querySelector('.split-widget-content');
        pane.insertBefore(pill, content || null);
    }
}

function _splitViewHidePill() {
    var pane = _splitViewHasDom() && document.getElementById('split-widget-pane');
    var pill = pane && pane.querySelector('.split-widget-update-pill');
    if (pill) pill.remove();
}

// Ask the sandbox for its UI state snapshot (scroll, inputs, details, focus,
// [data-keep-state]); resolves null after a short timeout.
// Request/reply to the pane sandbox. Preferred route: the document-owned
// MessagePort (widgetPortRequest, tools/085-widget-eval.js), bound to the exact
// render. Fallback (port not bound yet: before the first render finished, or
// during a probe): window postMessage, which the sandbox only accepts from
// window.parent and we only accept from this iframe's contentWindow.
function _splitViewSandboxRequest(iframe, message, replyType, timeoutMs) {
    var viaPort = typeof widgetPortRequest === 'function' ? widgetPortRequest(iframe, message, replyType, timeoutMs) : null;
    if (viaPort) return viaPort;
    return new Promise(function(resolve) {
        var win = iframe.contentWindow;
        if (!win) return resolve(null);
        var reqId = 'sv_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        var done = false;
        var finish = function(v) { if (done) return; done = true; window.removeEventListener('message', onMsg); resolve(v || null); };
        function onMsg(e) {
            if (e.source !== win || !e.data || e.data.type !== replyType || e.data.request_id !== reqId) return;
            finish(e.data);
        }
        window.addEventListener('message', onMsg);
        setTimeout(function() { finish(null); }, timeoutMs);
        try { win.postMessage(Object.assign({}, message, { request_id: reqId }), '*'); } catch (e) { finish(null); }
    });
}

function _splitViewCaptureState(iframe) {
    return _splitViewSandboxRequest(iframe, { type: 'widgetCaptureState' }, 'widgetStateSnapshot', 400)
        .then(function(reply) { return (reply && reply.state) || null; });
}

// Resolves once the reloaded sandbox posts widgetContentLoaded (or after a cap).
function _splitViewAwaitLoaded(iframe, capMs) {
    return new Promise(function(resolve) {
        var done = false, timer = null;
        var finish = function() { if (done) return; done = true; if (timer) clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(); };
        function onMsg(e) { if (e.source === iframe.contentWindow && e.data && e.data.type === 'widgetContentLoaded') finish(); }
        window.addEventListener('message', onMsg);
        timer = setTimeout(finish, capMs);
    });
}

// Per-iframe in-flight flag (fix: rapid saves used to start one reload each,
// tearing down a document that was still loading). While a slot apply or a
// reload is in flight, further updates only mark the frame queued; when it
// settles, ONE follow-up update runs against the latest version (if newer).
function _splitViewEndFlight(iframe, widgetId, shownVersion) {
    iframe.__splitViewInFlight = false;
    var queued = iframe.__splitViewQueued;
    iframe.__splitViewQueued = null;
    if (!queued || !iframe.isConnected || typeof WidgetStore === 'undefined') return;
    var latest = WidgetStore.view(widgetId);
    if (latest && String(latest.contentVersion) !== String(shownVersion)) splitViewApplyUpdate(iframe, widgetId, queued);
}

function _splitViewReload(iframe, widgetId) {
    iframe.__splitViewInFlight = true;
    return _splitViewCaptureState(iframe).then(function(state) {
        var cur = WidgetStore.view(widgetId);
        if (!cur || typeof cur.html !== 'string' || !iframe.isConnected) { _splitViewEndFlight(iframe, widgetId, iframe.dataset.savedWidgetVersion); return; }
        iframe.__restoreWidgetState = state;
        var html = typeof injectWidgetBridge === 'function' ? injectWidgetBridge(cur.html, cur.title, widgetId) : cur.html;
        if (iframe.__versionSuffix && typeof _appendWidgetScript === 'function') html = _appendWidgetScript(html, iframe.__versionSuffix);
        var loaded = _splitViewAwaitLoaded(iframe, 3000);
        if (typeof writeWidgetHtml === 'function') writeWidgetHtml(iframe, html, widgetId);
        return loaded.then(function() { _splitViewEndFlight(iframe, widgetId, cur.contentVersion); });
    }).catch(function() { _splitViewEndFlight(iframe, widgetId, iframe.dataset.savedWidgetVersion); });
}

// Refresh the split pane iframe IN PLACE. Returns 'held' | 'slots' | 'reload'
// | 'current'. Held while the user interacts (pill shown, record
// pendingUpdate); opts.force applies regardless (pill click).
function splitViewApplyUpdate(iframe, widgetId, opts) {
    opts = opts || {};
    if (!iframe || typeof WidgetStore === 'undefined') return 'current';
    var latest = WidgetStore.view(widgetId);
    if (!latest) return 'current';
    if (iframe.__splitViewInFlight) {
        // Coalesce: the in-flight apply re-checks the latest version when done.
        var q = iframe.__splitViewQueued || {};
        iframe.__splitViewQueued = { force: !!(q.force || opts.force) };
        return 'queued';
    }
    if (iframe.dataset.savedWidgetVersion === String(latest.contentVersion)) {
        _splitViewHidePill(); _splitViewSetPending(widgetId, false);
        if (typeof attachWidgetVersionPicker === 'function') attachWidgetVersionPicker(iframe, widgetId);
        return 'current';
    }
    if (!opts.force && _splitViewIsInteracting(iframe)) {
        _splitViewShowPill(iframe, widgetId);
        _splitViewSetPending(widgetId, true);
        if (typeof attachWidgetVersionPicker === 'function') { var keep = iframe.dataset.savedWidgetVersion; attachWidgetVersionPicker(iframe, widgetId); iframe.dataset.savedWidgetVersion = keep; }
        return 'held';
    }
    _splitViewHidePill();
    _splitViewSetPending(widgetId, false);
    var patch = _splitViewSlotPatches[widgetId];
    // A patch noted for a version that has not been committed yet (the note
    // precedes commit) stays for the commit's own apply; anything else is
    // consumed or stale and dropped here.
    if (!(patch && patch.version > latest.latestVersion)) delete _splitViewSlotPatches[widgetId];
    // Bound to THIS exact commit: same version number AND the same stored html
    // (another writer's same-numbered version has different html -> reload).
    var patchMatches = !!(patch && patch.version === latest.latestVersion && typeof patch.html === 'string' && patch.html === latest.html);
    if (patchMatches && patch.base === iframe.dataset.savedWidgetVersion && iframe.contentWindow) {
        iframe.__splitViewInFlight = true;
        var slotVersion = latest.contentVersion;
        _splitViewSandboxRequest(iframe, { type: 'applySlots', slots: patch.slots }, 'widgetSlotsApplied', 1000).then(function(reply) {
            // Consume the reply: a missing slot (or no reply at all) means the
            // in-place patch did not land -> capture state + reload instead.
            if (!reply || (Array.isArray(reply.missing) && reply.missing.length)) {
                if (!iframe.isConnected) { _splitViewEndFlight(iframe, widgetId, slotVersion); return; }
                return _splitViewReload(iframe, widgetId);
            }
            if (typeof attachWidgetVersionPicker === 'function') attachWidgetVersionPicker(iframe, widgetId);
            _splitViewEndFlight(iframe, widgetId, slotVersion);
        });
        return 'slots';
    }
    _splitViewReload(iframe, widgetId);
    return 'reload';
}

// Sandbox → page activity reports (widget-sandbox.html widgetReportActivity),
// only from the split pane's iframe.
function _splitViewOnActivity(e) {
    if (!e || !e.data || e.data.type !== 'widgetUserActivity') return;
    var f = _splitViewPaneFrame();
    if (!f || e.source !== f.contentWindow) return;
    if (e.data.kind === 'focus') _splitViewActivity.editableFocused = !!e.data.editable;
    else if (e.data.kind === 'blur') _splitViewActivity.editableFocused = false;
    _splitViewActivity.lastInputAt = Date.now();
}

function renderSplitViewPane(opts) {
    if (!_splitViewHasDom()) return;
    opts = opts || {};
    // Keyed by the ROOT chat: moving between a parent chat and its sub-agent
    // chats keeps the same pane (no re-render).
    var chatId = splitViewRootChatId(typeof currentChatId !== 'undefined' ? currentChatId : null);
    var state = getSplitViewState(chatId);
    var pane = document.getElementById('split-widget-pane');
    if (!state) {
        if (pane) {
            var oldFrame = pane.querySelector('iframe');
            if (oldFrame && oldFrame.__widgetCleanup) { try { oldFrame.__widgetCleanup(); } catch (e) {} }
            if (pane.parentNode) pane.parentNode.removeChild(pane);
        }
        _splitViewSyncVisibility();
        _splitViewSyncButtons();
        return;
    }
    var wrapper = document.querySelector('.main-wrapper');
    var main = document.getElementById('main-area');
    if (!wrapper && !main) return;
    if (!opts.force && pane && pane.dataset.chatId === chatId && pane.dataset.widgetId === state.widgetId) {
        _splitViewUpdateHeader();
        _splitViewSyncVisibility();
        _splitViewSyncButtons();
        return;
    }
    if (pane) {
        var prevFrame = pane.querySelector('iframe');
        if (prevFrame && prevFrame.__widgetCleanup) { try { prevFrame.__widgetCleanup(); } catch (e) {} }
    }
    if (!pane) {
        pane = document.createElement('aside');
        pane.id = 'split-widget-pane';
        pane.className = 'split-widget-pane';
        pane.setAttribute('aria-label', 'Split widget view');
        // Mounted INSIDE #main-area (after the composer): in split mode the
        // chat area becomes a grid (css/15b-split-view.css) whose first row is
        // the full-width .main-header, so only the area BELOW the header is
        // split between chat and pane.
        if (main) main.appendChild(pane);
        else wrapper.appendChild(pane);
    }
    pane.dataset.chatId = chatId;
    pane.dataset.widgetId = state.widgetId;
    // A full (re)mount shows the latest version: nothing is held any more.
    _splitViewActivity.editableFocused = false;
    if (state.pendingUpdate) _splitViewSetPending(state.widgetId, false);
    var esc = typeof escapeHtml === 'function' ? escapeHtml : function(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return '&#' + c.charCodeAt(0) + ';'; }); };
    var tr = typeof t === 'function' ? t : function(s) { return s; };
    var closeIcon = (typeof UI_ICONS !== 'undefined' && UI_ICONS && UI_ICONS.close) || '&times;';
    var widgetIcon = (typeof UI_ICONS !== 'undefined' && UI_ICONS && UI_ICONS.widget) || '';
    var widget = typeof getWidgetById === 'function' ? getWidgetById(state.widgetId) : null;
    // SAME header as the chat fullscreen view (buildWidgetViewHeaderHtml in
    // tools/080-widget-tools.js, surface 'split': × closes the pane, a
    // Fullscreen button replaces the split toggle). Fallback only when the
    // page header builder is unavailable or the widget is gone.
    var headerInner = (widget && typeof buildWidgetViewHeaderHtml === 'function')
        ? buildWidgetViewHeaderHtml(widget, 'split')
        : '<span class="widget-icon">' + widgetIcon + '</span>' +
          '<span class="widget-title"></span>' +
          '<div class="widget-modal-controls">' +
              '<button type="button" class="widget-close-btn split-widget-close" onclick="closeSplitView()" title="' + esc(tr('Close split view')) + '" aria-label="' + esc(tr('Close split view')) + '">' + closeIcon + '</button>' +
          '</div>';
    pane.innerHTML = '<div class="widget-fullscreen-header split-widget-header">' + headerInner + '</div>' +
        '<div class="split-widget-content"></div>';
    _splitViewUpdateHeader();
    var content = pane.querySelector('.split-widget-content');
    if (!widget) {
        content.innerHTML = '<div class="split-widget-empty">' + esc(tr('Widget not found.')) + '</div>';
    } else if (typeof isWidgetDeactivated === 'function' && isWidgetDeactivated(widget.id)) {
        content.innerHTML = '<div class="split-widget-empty">' + esc(tr('Widget deactivated.')) + '</div>';
    } else if (typeof renderWidgetInContainer === 'function') {
        renderWidgetInContainer(widget, content, { fullscreen: true });
    }
    _splitViewSyncVisibility();
    _splitViewSyncButtons();
}

function _initSplitView() {
    var store = _splitViewStorage();
    if (store) {
        try {
            store.get(SPLIT_VIEW_STORAGE_KEY, function(res) {
                var v = res && res[SPLIT_VIEW_STORAGE_KEY];
                if (v && typeof v === 'object') _splitViews = v;
                renderSplitViewPane();
            });
        } catch (e) {}
    }
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function(changes, area) {
                if (area !== 'local' || !changes || !changes[SPLIT_VIEW_STORAGE_KEY]) return;
                var nv = changes[SPLIT_VIEW_STORAGE_KEY].newValue;
                _splitViews = (nv && typeof nv === 'object') ? nv : {};
                renderSplitViewPane();
            });
        }
    } catch (e) {}
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && _splitViewHasDom()) window.addEventListener('message', _splitViewOnActivity);
    // Hide the pane with the chat view (other views set #main-area display:none).
    if (_splitViewHasDom() && typeof MutationObserver === 'function') {
        var observe = function() {
            var main = document.getElementById('main-area');
            if (!main) return;
            new MutationObserver(_splitViewSyncVisibility).observe(main, { attributes: true, attributeFilter: ['style'] });
            _splitViewSyncVisibility();
        };
        if (document.readyState === 'loading' && typeof document.addEventListener === 'function') document.addEventListener('DOMContentLoaded', observe);
        else observe();
    }
}
_initSplitView();
