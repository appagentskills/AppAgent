// DISPLAY TEMPLATES - Structured output rendered inline in chat
// =============================================
// Templates render as native HTML in the message content (not iframes).
// They inherit the app's CSS variables for theme-aware styling.
// A display attached to a tool_result slot (its own top-level call, or the
// parent tool when made inside a sandbox) renders there eagerly
// (getDisplayHtmlForMessage); one with no slot renders only via placeholder. If the agent ALSO writes <!--display:ID--> in
// any assistant message, formatContent renders it at that spot instead and
// the eager copy is skipped, so a display never shows twice.

var _displayIdCounter = 0;
var _displayStore = {}; // displayId -> { template, args, html }

function executeDisplay(args, messageIndex, options) {
    var template = args.template;
    if (!template) return { success: false, error: 'template is required' };

    var generator = DISPLAY_GENERATORS[template];
    if (!generator) return { success: false, error: 'Unknown template: ' + template + '. Available: ' + Object.keys(DISPLAY_GENERATORS).join(', ') };

    // Which chat owns the display. An explicit options.chatId always wins. A
    // NESTED call (fromSandbox / fromWidget / parentToolCallId) must never guess
    // from activeStreamingChatId / currentChatId: with a sub-agent running next
    // to a foreground chat those name the WRONG chat. Fail closed, same as
    // executeHtmlWidget (tools/080-widget-tools.js). Top-level calls keep the
    // legacy fallback.
    var _nestedDisplayCall = !!(options && (options.fromSandbox || options.fromWidget || options.parentToolCallId));
    var chatId = (options && options.chatId) || (_nestedDisplayCall ? null
        : ((typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null))) || null;
    if (!chatId && _nestedDisplayCall) {
        return { success: false, code: 'CHAT_UNRESOLVED', error: 'display: the calling chat could not be identified (nested call without chatId); the display was not created to avoid attaching it to another chat.' };
    }

    // FLUX-QW7: allocate the id BEFORE generating so stateful templates
    // (checklist) can embed it and address their persisted state later.
    var displayId = 'dsp_' + (++_displayIdCounter) + '_' + Date.now();
    var html = generator(args, displayId);
    if (!html) return { success: false, error: 'Template generator returned empty HTML' };

    _displayStore[displayId] = { template: template, args: args, html: html };

    // Persist on chat for re-render
    var chat = chats[chatId];
    // Eager-render path: attach the display to a tool_result slot so the
    // renderer emits it alongside that result (same shape as html_widget),
    // whether or not the agent ever writes the placeholder. Only the FINAL
    // assistant message is shown by default, so a placeholder-only display
    // was silently lost whenever the model forgot it there.
    //  - inside a sandbox (js_eval / skill tool / widget bridge): the PARENT
    //    tool's slot (parentToolCallId) — the agent never sees a placeholder;
    //  - top level: this call's own slot (options.toolCallId = the tool_use id,
    //    forwarded agent loop -> SW routing -> page exec-tool).
    // toolCallId is persisted so the SW (whose authoritative chat always has
    // the seeded slot) can resolve msgIndex when this page mirror lacks it, and
    // so the renderer matches the slot by id rather than a bare index.
    // No slot at all (widget-bridge and other non-agent callers, whose id the
    // SW mints as 'ui_...'; a sandbox with no parent tool): nothing can render
    // eagerly, so the placeholder contract below applies.
    var fromSandbox = !!(options && options.fromSandbox);
    var slotId = fromSandbox ? (options && options.parentToolCallId) : (options && options.toolCallId);
    var attachToolCallId = _displayIsSlotId(slotId) ? slotId : null;
    var eagerMsgIndex = _displayFindToolSlot(chat, attachToolCallId);
    if (chat) {
        if (!chat.displays) chat.displays = {};
        var entry = { template: template, args: args };
        if (attachToolCallId) entry.toolCallId = attachToolCallId;
        if (eagerMsgIndex >= 0) {
            entry.msgIndex = eagerMsgIndex;
            entry.eager = true;
        }
        chat.displays[displayId] = entry;
        saveChatsToStorage();
    }

    var title = args.title || (template.charAt(0).toUpperCase() + template.slice(1));
    var placeholder = '<!--display:' + displayId + '-->';
    // Slot: sandbox -> no hint (the agent cannot place a placeholder there);
    // top level -> already rendered, the placeholder only MOVES it (optional).
    // No slot: the placeholder is the only way it renders (pre-eager wording).
    var message = !attachToolCallId
        ? title + ' ready. Include ' + placeholder + ' in your response to render it inline.'
        : fromSandbox
            ? title + ' rendered.'
            : title + ' rendered inline. Optionally include ' + placeholder + ' in your final response to position it there instead.';
    var returnedPlaceholder = (fromSandbox && attachToolCallId) ? null : placeholder;

    var persistEntry = { displayId: displayId, template: template, args: args };
    if (attachToolCallId) persistEntry.toolCallId = attachToolCallId;
    if (eagerMsgIndex >= 0) {
        persistEntry.msgIndex = eagerMsgIndex;
        persistEntry.eager = true;
    }

    return {
        success: true,
        // Normalized: `id` matches html_widget / take_screenshot conventions.
        // `displayId` kept for any caller still relying on it.
        id: displayId,
        displayId: displayId,
        // Normalized: `placeholder` matches the placeholder-based render
        // contract; null for sandbox calls with a parent slot (the agent cannot
        // place it there). Top level: optional — it only repositions the display.
        placeholder: returnedPlaceholder,
        message: message,
        _display_placeholder: returnedPlaceholder,
        // SW-side wrapper reads this to persist chat.displays on its own chat
        // object. Without it, the SW's chat snapshot (which is broadcast back
        // to the panel) wipes the page-side mutation on the next save.
        _display_persist: persistEntry
    };
}

// A real tool_use / parent tool id, i.e. one that can name a chat tool_result
// slot. Synthesized ids never do: 'ui_...' (minted by SW routing for
// widget-bridge and other calls without a tool_use id) and 'prog_...'
// (nested sandbox calls).
function _displayIsSlotId(id) {
    return typeof id === 'string' && id !== '' && !/^(ui|prog)_/.test(id);
}

// Index of the role:'tool' message whose tool_call_id is `toolCallId`, or -1.
function _displayFindToolSlot(chat, toolCallId) {
    if (!toolCallId || !chat || !chat.messages) return -1;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m && m.role === 'tool' && m.tool_call_id === toolCallId) return i;
    }
    return -1;
}

// Per-render-pass index for getDisplayHtmlForMessage:
//  - placed: ids whose <!--display:ID--> placeholder appears in an assistant
//    message (reply text OR tool_call arguments, e.g. a `document` embedding
//    it). Those render where they were placed, so the eager copy is skipped.
//  - slots: tool_call_id of every tool_result message in the chat.
// Memoized for ONE render pass: renderMessages calls
// getDisplayHtmlForMessage.resetPass() first, so an in-place edit to an
// earlier message is never served stale. The signature (chat + message count
// + last-message size) guards calls made outside a pass.
var _displayPlacedCache = null;
function _displayRenderIndex(chatId, chat) {
    var msgs = (chat && chat.messages) || [];
    var last = msgs.length ? msgs[msgs.length - 1] : null;
    var lastSize = last ? String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '')).length
        + JSON.stringify(last.tool_calls || '').length : 0;
    var sig = chatId + '|' + msgs.length + '|' + lastSize;
    if (_displayPlacedCache && _displayPlacedCache.sig === sig) return _displayPlacedCache;
    var placed = {};
    var slots = {};
    var re = /<!--display:(dsp_\w+)-->/g;
    function scan(s) {
        if (s == null) return;
        if (typeof s !== 'string') s = JSON.stringify(s);
        if (s.indexOf('<!--display:') === -1) return;
        var mm;
        re.lastIndex = 0;
        while ((mm = re.exec(s)) !== null) placed[mm[1]] = true;
    }
    msgs.forEach(function(m) {
        if (!m) return;
        if (m.role === 'tool') {
            if (m.tool_call_id) slots[m.tool_call_id] = true;
            return;
        }
        if (m.role !== 'assistant') return;
        scan(m.content);
        (m.tool_calls || []).forEach(function(tc) { scan(tc && tc.function ? tc.function.arguments : tc); });
    });
    _displayPlacedCache = { sig: sig, placed: placed, slots: slots };
    return _displayPlacedCache;
}

// True when display `displayId` is attached to the tool_result at `msgIndex`.
// Precedence: toolCallId when that slot exists in the chat (robust to index
// shifts) > msgIndex (sandbox-era entries, or a toolCallId whose slot is not
// in this chat) > legacy top-level result (pre-eager saved chats: the display
// tool's own result, which names the id, never rendered when the placeholder
// was missed).
function _displayAttachedTo(entry, displayId, msg, msgIndex, slots) {
    if (!entry || !msg || msg.role !== 'tool') return false;
    if (entry.toolCallId && slots && slots[entry.toolCallId]) return msg.tool_call_id === entry.toolCallId;
    if (entry.eager) return entry.msgIndex === msgIndex;
    return msg.name === 'display' && typeof msg.content === 'string' && msg.content.indexOf(displayId) !== -1;
}

// Eager-render scan: returns concatenated HTML for every display attached to
// the tool_result at `msgIndex` (see `executeDisplay`), minus displays placed
// via placeholder in an assistant message. Called by the message renderer
// alongside `getWidgetHtmlForMessage`.
function getDisplayHtmlForMessage(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.displays) return '';
    var msg = chat.messages && chat.messages[msgIndex];
    if (!msg || msg.role !== 'tool') return '';
    var html = '';
    var index = null;
    Object.keys(chat.displays).forEach(function(displayId) {
        var entry = chat.displays[displayId];
        if (!entry) return;
        if (!index) index = _displayRenderIndex(currentChatId, chat);
        if (!_displayAttachedTo(entry, displayId, msg, msgIndex, index.slots)) return;
        if (index.placed[displayId]) return;
        // Render via the same path placeholder-in-text uses, so cache + chart
        // generator code stays single-sourced.
        var renderedHtml = renderDisplayPlaceholder(displayId);
        html += '<div class="display-inline" data-display-id="' + escDisplay(displayId) + '">' + renderedHtml + '</div>';
    });
    return html;
}
// Start of a render pass (renderMessages): drop the memoized index.
getDisplayHtmlForMessage.resetPass = function() { _displayPlacedCache = null; };

// Called from formatContent to replace <!--display:ID--> placeholders
function renderDisplayPlaceholder(displayId) {
    // Check in-memory store first
    var entry = _displayStore[displayId];
    if (entry) return entry.html;

    // Fall back to chat persisted data and regenerate
    var chatId = currentChatId;
    var chat = chats[chatId];
    if (chat && chat.displays && chat.displays[displayId]) {
        var stored = chat.displays[displayId];
        var generator = DISPLAY_GENERATORS[stored.template];
        if (generator) {
            var html = generator(stored.args, displayId);
            _displayStore[displayId] = { template: stored.template, args: stored.args, html: html };
            return html;
        }
    }
    return '<div class="display-error">' + escDisplay(t('Display not found: {id}', { id: displayId })) + '</div>';
}

// ─── Helper ───
function escDisplay(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Shared named-color map (status cards, chart bars, etc.)
var DISPLAY_COLOR_MAP = { green: 'var(--success)', red: 'var(--danger)', orange: 'var(--warning)', yellow: 'var(--warning)', blue: 'var(--primary)', purple: '#8b5cf6', gray: 'var(--secondary)' };

// Sanitize a caller-supplied CSS color before interpolating into a style attribute
// (prevents attribute breakout / on* handler injection via crafted color strings)
function displaySafeColor(c) {
    c = String(c == null ? '' : c);
    return /^[#a-zA-Z0-9(),.%\s-]+$/.test(c) ? c : '';
}

// Sanitize a caller-supplied color *name* used as a CSS class suffix.
// Class attributes are built by string concatenation — a crafted value
// (e.g. 'blue" onmouseover="...') would break out of the attribute.
// Allow one bare identifier token, else fall back.
function displaySafeToken(c, fallback) {
    c = String(c == null ? '' : c);
    return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c) ? c : fallback;
}

var DISPLAY_COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

// ─── Table Template ───
function generateTable(args) {
    var columns = args.columns || [];
    var rows = (args.rows || []).map(function(r) { return r == null ? [] : r; });
    if (!columns.length) return null;

    var tableId = 'dtbl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

    // Detect numeric columns for right alignment
    var numericCols = columns.map(function(col, ci) {
        var seen = false;
        for (var r = 0; r < rows.length; r++) {
            var v = Array.isArray(rows[r]) ? rows[r][ci] : rows[r][col];
            if (v == null || v === '') continue;
            if (typeof v === 'boolean' || typeof v === 'object') return false;
            if (isNaN(parseFloat(v)) || !isFinite(v)) return false;
            seen = true;
        }
        return seen;
    });

    var html = '<div class="display-template display-table" id="' + tableId + '">';
    if (rows.length > 5) {
        html += '<input class="display-search" placeholder="' + escDisplay(t('Search...')) + '" oninput="displayFilterTable(\'' + tableId + '\', this.value)">';
        html += '<div class="display-row-count" id="' + tableId + '-count">' + escDisplay(tn(rows.length, '{count} row', '{count} rows')) + '</div>';
    }
    html += '<div class="display-table-wrap"><table><thead><tr>';
    columns.forEach(function(col, i) {
        html += '<th' + (numericCols[i] ? ' class="num"' : '') + ' tabindex="0" onclick="displaySortTable(\'' + tableId + '\', ' + i + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();displaySortTable(\'' + tableId + '\', ' + i + ')}">' + escDisplay(col) + '<span class="display-sort-arrow">&#9650;</span></th>';
    });
    html += '</tr></thead><tbody>';
    rows.forEach(function(row) {
        html += '<tr>';
        columns.forEach(function(col, i) {
            var v = Array.isArray(row) ? row[i] : row[col];
            html += '<td' + (numericCols[i] ? ' class="num"' : '') + '>' + displayFormatCell(v) + '</td>';
        });
        html += '</tr>';
    });
    html += '</tbody></table><div class="display-table-empty" style="display:none">' + escDisplay(t('No matching rows')) + '</div></div></div>';
    return html;
}

function displayFormatCell(val) {
    if (val == null) return '<span class="display-muted">&mdash;</span>';
    if (typeof val === 'boolean') return val ? '<span class="display-badge display-badge-green">' + escDisplay(t('Yes')) + '</span>' : '<span class="display-badge display-badge-red">' + escDisplay(t('No')) + '</span>';
    if (typeof val === 'object' && val.badge) return '<span class="display-badge display-badge-' + displaySafeToken(val.color, 'blue') + '">' + escDisplay(val.badge) + '</span>';
    return escDisplay(val);
}

// Table interactivity (global functions called from inline handlers)
function displaySortTable(tableId, colIdx) {
    var wrap = document.getElementById(tableId);
    if (!wrap) return;
    var tbody = wrap.querySelector('tbody');
    var rows = [].slice.call(tbody.rows);
    var state = wrap._sortState || { col: -1, asc: true };
    if (state.col === colIdx) state.asc = !state.asc;
    else { state.col = colIdx; state.asc = true; }
    wrap._sortState = state;
    rows.sort(function(a, b) {
        var x = (a.cells[colIdx] || {}).textContent || '', y = (b.cells[colIdx] || {}).textContent || '';
        var xn = parseFloat(x), yn = parseFloat(y);
        if (!isNaN(xn) && !isNaN(yn)) return state.asc ? xn - yn : yn - xn;
        return state.asc ? x.localeCompare(y) : y.localeCompare(x);
    });
    rows.forEach(function(r) { tbody.appendChild(r); });
    wrap.querySelectorAll('th').forEach(function(th, j) {
        th.classList.toggle('sorted', j === colIdx);
        th.querySelector('.display-sort-arrow').innerHTML = j === colIdx ? (state.asc ? '&#9650;' : '&#9660;') : '&#9650;';
    });
}

function displayFilterTable(tableId, query) {
    var wrap = document.getElementById(tableId);
    if (!wrap) return;
    var q = query.toLowerCase();
    var rows = wrap.querySelectorAll('tbody tr');
    var count = 0;
    rows.forEach(function(r) {
        var match = r.textContent.toLowerCase().indexOf(q) >= 0;
        r.style.display = match ? '' : 'none';
        if (match) count++;
    });
    var countEl = document.getElementById(tableId + '-count');
    if (countEl) countEl.textContent = tn(rows.length, '{shown} of {count} row', '{shown} of {count} rows', { shown: i18nFormatNumber(count) });
    var emptyEl = wrap.querySelector('.display-table-empty');
    if (emptyEl) emptyEl.style.display = count === 0 ? '' : 'none';
}

// ─── Card List Template ───
function generateCardList(args) {
    var cards = args.cards || [];
    if (!cards.length) return null;

    var html = '<div class="display-template display-card-list">';
    if (cards.length > 6) {
        html += '<input class="display-search" placeholder="' + escDisplay(t('Search cards...')) + '" oninput="displayFilterCards(this)">';
    }
    html += '<div class="display-cards">';
    cards.forEach(function(card) {
        var hasDetail = !!card.detail;
        html += '<div class="display-card' + (hasDetail ? ' has-detail' : '') + '"' + (hasDetail ? ' role="button" tabindex="0" onclick="displayToggleExpand(this)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();displayToggleExpand(this)}"' : '') + '>';
        html += '<div class="display-card-header">';
        html += '<div class="display-card-header-content">';
        if (card.icon) html += '<div class="display-card-icon">' + escDisplay(card.icon) + '</div>';
        html += '<div class="display-card-title">' + escDisplay(card.title || '') + '</div>';
        if (card.subtitle) html += '<div class="display-card-subtitle">' + escDisplay(card.subtitle) + '</div>';
        if (card.badge) html += '<span class="display-badge display-badge-' + displaySafeToken(card.badge_color, 'blue') + '" style="margin-top:6px">' + escDisplay(card.badge) + '</span>';
        html += '</div>';
        if (hasDetail) html += '<div class="display-card-chevron">&#9662;</div>';
        html += '</div>';
        if (card.detail) html += '<div class="display-card-detail">' + escDisplay(card.detail) + '</div>';
        html += '</div>';
    });
    html += '</div></div>';
    return html;
}

function displayFilterCards(input) {
    var q = input.value.toLowerCase();
    var wrap = input.closest('.display-card-list');
    if (!wrap) return;
    wrap.querySelectorAll('.display-card').forEach(function(c) {
        c.style.display = c.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
    });
}

// ─── Checklist Template ───
function generateChecklist(args, displayId) {
    var items = args.items || [];
    if (!items.length) return null;

    // FLUX-QW7: stable DOM id derived from the displayId so toggle handlers
    // can find the owning display entry; random fallback only for direct
    // callers that pass no id (none in-tree today).
    var listId = displayId ? ('dcl_' + displayId) : ('dcl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5));

    var html = '<div class="display-template display-checklist" id="' + listId + '"' + (displayId ? ' data-display-id="' + escDisplay(displayId) + '"' : '') + '>';
    html += '<div class="display-check-summary" id="' + listId + '-summary">';
    html += '<div class="display-check-progress"><div class="display-check-progress-fill" id="' + listId + '-bar"></div></div>';
    html += '<span class="display-check-summary-text" id="' + listId + '-text"></span></div>';
    items.forEach(function(item, i) {
        var label = typeof item === 'string' ? item : (item.label || item.text || '');
        var desc = typeof item === 'object' ? (item.description || '') : '';
        var checked = typeof item === 'object' && item.checked;
        html += '<div class="display-check-item' + (checked ? ' checked' : '') + '" role="checkbox" aria-checked="' + (checked ? 'true' : 'false') + '" tabindex="0" onclick="displayToggleCheck(\'' + listId + '\', this)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();displayToggleCheck(\'' + listId + '\', this)}">';
        html += '<div class="display-check-box"></div>';
        html += '<div class="display-check-content"><div class="display-check-label">' + escDisplay(label) + '</div>';
        if (desc) html += '<div class="display-check-desc">' + escDisplay(desc) + '</div>';
        html += '</div></div>';
    });
    html += '</div>';
    // Summary is initialized by renderMessages after innerHTML via initDisplayChecklists()
    return html;
}

function displayToggleCheck(listId, el) {
    el.classList.toggle('checked');
    el.setAttribute('aria-checked', el.classList.contains('checked') ? 'true' : 'false');
    displayUpdateCheckSummary(listId);
    // FLUX-QW7: persist the toggle onto the owning display entry
    // (chat.displays[displayId].args.items[i].checked) through the standard
    // save path. Before this, the checked state lived ONLY in the DOM class,
    // so any re-render (renderMessages regenerates from args) reset every
    // box the user had clicked.
    var wrap = document.getElementById(listId);
    var displayId = wrap && wrap.getAttribute('data-display-id');
    if (!displayId) return; // legacy markup rendered before QW7 — DOM-only as before
    var chat = (typeof chats !== 'undefined' && chats) ? chats[currentChatId] : null;
    var entry = chat && chat.displays && chat.displays[displayId];
    if (!entry || !entry.args || !entry.args.items) return;
    var idx = [].indexOf.call(wrap.querySelectorAll('.display-check-item'), el);
    if (idx < 0 || idx >= entry.args.items.length) return;
    var item = entry.args.items[idx];
    if (typeof item !== 'object' || item === null) {
        item = { label: String(item == null ? '' : item) };
        entry.args.items[idx] = item;
    }
    item.checked = el.classList.contains('checked');
    // Newest-wins stamp read by the two replica merge helpers
    // (_preservePageChatFields, _mergePageChatMeta) so an in-flight SW save /
    // snapshot can't revert a just-clicked box.
    entry._toggledAt = Date.now();
    // Refresh the in-memory HTML cache — renderDisplayPlaceholder serves
    // _displayStore[displayId].html first, which now embeds stale classes.
    if (_displayStore[displayId]) _displayStore[displayId].html = generateChecklist(entry.args, displayId);
    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
}

function displayUpdateCheckSummary(listId) {
    var wrap = document.getElementById(listId);
    if (!wrap) return;
    var items = wrap.querySelectorAll('.display-check-item');
    var done = [].filter.call(items, function(i) { return i.classList.contains('checked'); }).length;
    var text = document.getElementById(listId + '-text');
    if (text) text.textContent = t('{done} of {total} completed', { done: i18nFormatNumber(done), total: i18nFormatNumber(items.length) });
    var bar = document.getElementById(listId + '-bar');
    if (bar) bar.style.width = (items.length ? Math.round(done / items.length * 100) : 0) + '%';
    var summary = document.getElementById(listId + '-summary');
    if (summary) summary.classList.toggle('all-done', items.length > 0 && done === items.length);
}

// ─── Status Summary Template ───
function generateStatusSummary(args) {
    var items = args.items || [];
    if (!items.length) return null;

    var html = '<div class="display-template display-status-grid">';
    items.forEach(function(item) {
        var accent = DISPLAY_COLOR_MAP[item.color] || displaySafeColor(item.color);
        var color = accent || 'var(--text-primary)';
        html += '<div class="display-status-card"' + (accent ? ' style="--status-accent:' + accent + '"' : '') + '>';
        if (item.icon) html += '<div class="display-status-icon">' + escDisplay(item.icon) + '</div>';
        html += '<div class="display-status-count" style="color:' + color + '">' + escDisplay(item.count != null ? item.count : item.value) + '</div>';
        html += '<div class="display-status-label">' + escDisplay(item.label) + '</div>';
        html += '</div>';
    });
    html += '</div>';
    return html;
}

// ─── Code Template ───
var _displayCodeSeq = 0; // makes codeId unique when two blocks render in the same millisecond
function generateCode(args) {
    var code = args.code || '';
    var language = args.language || '';
    if (!code) return null;

    var codeId = 'dcode_' + Date.now() + '_' + (++_displayCodeSeq);

    var html = '<div class="display-template display-code-wrap">';
    html += '<div class="display-code-header"><span class="display-code-lang">' + escDisplay(language) + '</span><button class="display-code-copy" onclick="displayCopyCode(\'' + codeId + '\', this)">' + DISPLAY_COPY_ICON + '<span>' + escDisplay(t('Copy')) + '</span></button></div>';
    html += '<pre class="display-code-pre" id="' + codeId + '">';
    code.split('\n').forEach(function(line, i) {
        html += '<span class="display-line-num">' + (i + 1) + '</span>' + escDisplay(line) + '\n';
    });
    html += '</pre></div>';
    return html;
}

function displayCopyCode(codeId, btn) {
    var pre = document.getElementById(codeId);
    if (!pre) return;
    // Strip line numbers structurally — a regex on textContent can't tell a
    // line number from code: it left the number glued to unindented lines
    // ("3return x;") and ate one space of indentation on indented ones.
    var clone = pre.cloneNode(true);
    clone.querySelectorAll('.display-line-num').forEach(function(n) { n.remove(); });
    var text = clone.textContent.replace(/\n$/, '');
    navigator.clipboard.writeText(text).then(function() {
        var span = btn.querySelector('span');
        btn.classList.add('copied');
        if (span) span.textContent = t('Copied!');
        setTimeout(function() {
            btn.classList.remove('copied');
            if (span) span.textContent = t('Copy');
        }, 1500);
    }).catch(function() {
        // Clipboard write can reject (no focus / permission denied) — same feedback as copyCodeBlock.
        if (typeof showSnackbar === 'function') showSnackbar(t('Copy failed'), 'error');
    });
}

// ─── Timeline Template ───
function generateTimeline(args) {
    var events = args.events || [];
    if (!events.length) return null;

    var html = '<div class="display-template display-timeline">';
    events.forEach(function(evt) {
        var tlColor = displaySafeToken(evt.color, '');
        var colorClass = tlColor ? ' display-tl-' + tlColor : '';
        var detail = evt.detail || evt.description;
        html += '<div class="display-tl-event' + colorClass + (detail ? ' has-detail' : '') + '"' + (detail ? ' role="button" tabindex="0" onclick="displayToggleExpand(this)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();displayToggleExpand(this)}"' : '') + '>';
        if (evt.time || evt.date || evt.timestamp) html += '<div class="display-tl-time">' + escDisplay(evt.time || evt.date || evt.timestamp) + '</div>';
        html += '<div class="display-tl-title">' + escDisplay(evt.title || evt.label || '') + (detail ? '<span class="display-tl-chevron">&#9662;</span>' : '') + '</div>';
        if (detail) html += '<div class="display-tl-detail">' + escDisplay(detail) + '</div>';
        html += '</div>';
    });
    html += '</div>';
    return html;
}

// ─── Chart Template ───
function generateChart(args) {
    var type = args.chart_type || 'bar';
    var data = args.data || [];
    var labels = args.labels || data.map(function(d) { return d.label || ''; });
    var values = args.values || data.map(function(d) { return d.value || 0; });
    if (!values.length) return null;

    var max = Math.max.apply(null, values);
    var total = values.reduce(function(a, b) { return a + b; }, 0);

    var html = '<div class="display-template display-chart">';

    if (type === 'bar') {
        html += '<div class="display-bar-chart">';
        values.forEach(function(val, i) {
            var pct = max > 0 ? (val / max * 100) : 0;
            var custom = data[i] && data[i].color ? (DISPLAY_COLOR_MAP[data[i].color] || displaySafeColor(data[i].color)) : '';
            html += '<div class="display-bar-row"><div class="display-bar-label" title="' + escDisplay(labels[i]) + '">' + escDisplay(labels[i]) + '</div>';
            html += '<div class="display-bar-track"><div class="display-bar-fill" style="width:' + pct + '%' + (custom ? ';background:' + custom : '') + '"></div></div>';
            html += '<div class="display-bar-value">' + escDisplay(val) + '</div></div>';
        });
        html += '</div>';
    } else if (type === 'pie') {
        var pieColors = ['var(--primary)', 'var(--success)', 'var(--danger)', 'var(--warning)', 'var(--accent)', '#c77dff', '#5bc0de', '#ff7eb3', '#8dd1e1', '#a4de6c'];
        var gradientParts = [];
        var angle = 0;
        values.forEach(function(val, i) {
            var slice = total > 0 ? (val / total * 360) : 0;
            gradientParts.push(pieColors[i % pieColors.length] + ' ' + angle + 'deg ' + (angle + slice) + 'deg');
            angle += slice;
        });
        html += '<div class="display-pie-wrap">';
        html += '<div class="display-pie" style="background:conic-gradient(' + gradientParts.join(',') + ')">';
        html += '<div class="display-pie-hole"><div class="display-pie-total">' + escDisplay(total) + '</div><div class="display-pie-total-label">' + escDisplay(t('total')) + '</div></div></div>';
        html += '<ul class="display-pie-legend">';
        labels.forEach(function(label, i) {
            var pct = total > 0 ? (values[i] / total * 100).toFixed(1) : 0;
            html += '<li><span class="display-pie-swatch" style="background:' + pieColors[i % pieColors.length] + '"></span>' + escDisplay(label) + ' &mdash; ' + escDisplay(values[i]) + ' (' + pct + '%)</li>';
        });
        html += '</ul></div>';
    }

    html += '</div>';
    return html;
}

// ─── Diff Template ───
function generateDiff(args) {
    var changes = args.changes || [];
    var oldText = args.old_text || args.old || '';
    var newText = args.new_text || args.new || '';

    var addCount = 0, delCount = 0;
    var body = '';

    if (changes.length) {
        var lineNum = 0;
        changes.forEach(function(line) {
            // B10: skip null / non-string / non-object entries instead of throwing
            // (typeof null === 'object' reached `.type` and a number reached
            // `.charAt`, both TypeErrors that killed the whole template).
            if (line == null) return;
            var type = 'ctx', text = line;
            // Constrain caller-supplied type to the known set: it is concatenated into a
            // class attribute (display-diff-add/del/ctx), so an arbitrary string like
            // 'add" onmouseover="...' would break out of the attribute. Unknown → ctx.
            if (typeof line === 'object') { type = (line.type === 'add' || line.type === 'del') ? line.type : 'ctx'; text = String(line.text || line.content || ''); }
            else if (typeof line !== 'string') return;
            else if (line.charAt(0) === '+') { type = 'add'; text = line.substring(1); }
            else if (line.charAt(0) === '-') { type = 'del'; text = line.substring(1); }
            if (type === 'add') addCount++;
            if (type === 'del') delCount++;
            if (type !== 'del') lineNum++;
            body += '<div class="display-diff-line display-diff-' + type + '"><span class="display-diff-num">' + (type === 'del' ? '' : lineNum) + '</span><span class="display-diff-content">' + (type === 'add' ? '+ ' : type === 'del' ? '- ' : '  ') + escDisplay(text) + '</span></div>';
        });
    } else if ((oldText || newText) && typeof sdocDiffHunks === 'function' && typeof sdocComputeDiff === 'function') {
        // GitHub-style: LCS line diff, only the changed hunks with 3 lines of context and
        // expandable "N unchanged lines" folds (shared with the Smart Documents version diff).
        var split = function(s) { s = String(s); return s ? s.split('\n') : []; };
        var model = sdocDiffHunks(sdocComputeDiff(split(oldText), split(newText)), 3);
        addCount = model.added; delCount = model.removed;
        body = sdocDiffBodyHtml(model, 'display-diff', function(r) {
            return '<div class="display-diff-line display-diff-' + r.type + '"><span class="display-diff-num">' + (r.type === 'del' ? '' : r.newNo) + '</span><span class="display-diff-content">' + (r.type === 'add' ? '+ ' : r.type === 'del' ? '- ' : '  ') + escDisplay(r.text) + '</span></div>';
        });
    } else if (oldText || newText) {
        // Fallback when the Smart Documents diff helpers are not loaded (positional compare).
        var oldLines = oldText.split('\n');
        var newLines = newText.split('\n');
        oldLines.forEach(function(line, i) {
            if (i < newLines.length && line === newLines[i]) {
                body += '<div class="display-diff-line display-diff-ctx"><span class="display-diff-num">' + (i + 1) + '</span><span class="display-diff-content">  ' + escDisplay(line) + '</span></div>';
            } else {
                delCount++;
                body += '<div class="display-diff-line display-diff-del"><span class="display-diff-num"></span><span class="display-diff-content">- ' + escDisplay(line) + '</span></div>';
            }
        });
        newLines.forEach(function(line, i) {
            if (i >= oldLines.length || line !== oldLines[i]) {
                addCount++;
                body += '<div class="display-diff-line display-diff-add"><span class="display-diff-num">' + (i + 1) + '</span><span class="display-diff-content">+ ' + escDisplay(line) + '</span></div>';
            }
        });
    } else {
        return null;
    }

    var html = '<div class="display-template display-diff">';
    html += '<div class="display-diff-header"><span class="display-diff-file">' + escDisplay(args.file || args.header || t('Changes')) + '</span>';
    html += '<span class="display-diff-stats"><span class="display-diff-stat-add">+' + addCount + '</span><span class="display-diff-stat-del">&minus;' + delCount + '</span></span></div>';
    html += body + '</div>';
    return html;
}

function displayToggleExpand(el) {
    el.classList.toggle('expanded');
}

// ─── File Template (Agent Files download cards) ───
// args.files: [{path?, file_id?, name?, description?}] (or path strings).
// resolveDisplayFiles (async, page-only) enriches each entry BEFORE
// executeDisplay stores the args, so persisted args re-render synchronously:
// {file_id, name, mime, size, modified, thumb} or {error}.
var DISPLAY_FILE_MAX = 20;
// Thumbnails decode the whole image: skip them above this size.
var DISPLAY_THUMB_MAX_BYTES = 10 * 1024 * 1024;
var DISPLAY_FILE_KINDS = [
    ['pdf', /^pdf$/],
    ['doc', /^(docx?|odt|rtf|pages)$/],
    ['sheet', /^(xlsx?|xlsm|csv|tsv|ods|numbers)$/],
    ['slides', /^(pptx?|odp|key)$/],
    ['archive', /^(zip|gz|tgz|tar|7z|rar|bz2|xz|crx)$/],
    ['image', /^(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|tiff?)$/],
    ['video', /^(mp4|mov|webm|mkv|avi|m4v)$/],
    ['audio', /^(mp3|wav|ogg|flac|m4a|aac)$/],
    ['code', /^(js|mjs|ts|tsx|jsx|py|java|rb|go|rs|c|cpp|h|cs|php|sh|json|xml|html?|css|scss|ya?ml|sql|md)$/],
    ['text', /^(txt|log|ini|cfg|conf)$/]
];
function displayFileExt(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
}
function displayFileKind(ext, mime) {
    for (var i = 0; i < DISPLAY_FILE_KINDS.length; i++) if (DISPLAY_FILE_KINDS[i][1].test(ext)) return DISPLAY_FILE_KINDS[i][0];
    mime = String(mime || '');
    if (/^image\//.test(mime)) return 'image';
    if (/^video\//.test(mime)) return 'video';
    if (/^audio\//.test(mime)) return 'audio';
    if (/pdf/.test(mime)) return 'pdf';
    if (/^text\//.test(mime)) return 'text';
    return 'file';
}
function displayFileSize(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return t('{size} B', { size: n });
    if (n < 1024 * 1024) return t('{size} KB', { size: (n / 1024).toFixed(n < 10240 ? 1 : 0) });
    return t('{size} MB', { size: (n / 1048576).toFixed(n < 10485760 ? 1 : 0) });
}
function displayFileDate(ms) {
    var d = new Date(Number(ms));
    if (!ms || isNaN(d.getTime())) return '';
    try { return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
}
function displayFileList(args) {
    return Array.isArray(args.files) ? args.files : ((args.path || args.file_id) ? [{ path: args.path, file_id: args.file_id, name: args.name, description: args.description }] : []);
}
// Entries dropped by the DISPLAY_FILE_MAX cap (reported in the tool result).
function displayFileOverflow(args) {
    return Math.max(0, displayFileList(args || {}).length - DISPLAY_FILE_MAX);
}
function displayFileEntries(args) {
    return displayFileList(args).slice(0, DISPLAY_FILE_MAX).map(function(f) { return typeof f === 'string' ? { path: f } : (f && typeof f === 'object' ? f : { error: 'invalid file entry' }); });
}
function displayFileBaseName(f) {
    var n = f.name || (f.path ? String(f.path).split('/').pop() : '') || f.file_id || '';
    return String(n);
}
var DISPLAY_DOWNLOAD_ICON = '<svg class="display-file-dl-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
var DISPLAY_FILE_WARN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>';

function generateFile(args) {
    var files = displayFileEntries(args || {});
    if (!files.length) return null;
    var ready = files.filter(function(f) { return f.file_id && !f.error; }).length;
    var multi = files.length > 1;
    var html = '<div class="display-template display-files' + (multi ? ' display-files-multi' : '') + '" role="group" aria-label="' + escDisplay(args.title || (multi ? t('Files') : t('File'))) + '">';
    if (multi || args.title) {
        html += '<div class="display-files-header"><div class="display-files-heading">';
        html += '<span class="display-files-title">' + escDisplay(args.title || t('Files')) + '</span>';
        if (multi) html += '<span class="display-files-count">' + escDisplay(t('{count} files', { count: files.length })) + '</span>';
        html += '</div>';
        if (ready > 1) html += '<button type="button" class="display-files-all" onclick="displayFileDownloadAll(this)">' + DISPLAY_DOWNLOAD_ICON + '<span>' + escDisplay(t('Download All')) + '</span></button>';
        html += '</div>';
    }
    html += '<ul class="display-files-list">';
    files.forEach(function(f) {
        var name = displayFileBaseName(f);
        var ok = !!f.file_id && !f.error;
        var ext = displayFileExt(name);
        var kind = ok ? displayFileKind(ext, f.mime) : 'missing';
        html += '<li class="display-file display-file--' + kind + (ok ? '' : ' display-file-error') + '">';
        html += '<div class="display-file-icon" aria-hidden="true">';
        if (!ok) html += DISPLAY_FILE_WARN_ICON;
        else if (f.thumb && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(String(f.thumb))) html += '<img class="display-file-thumb" src="' + escDisplay(f.thumb) + '" alt="">';
        else html += '<span class="display-file-ext">' + escDisplay((ext || kind).slice(0, 4).toUpperCase()) + '</span>';
        html += '</div><div class="display-file-body">';
        html += '<div class="display-file-name" title="' + escDisplay(f.path || name) + '">' + escDisplay(name || t('Unknown')) + '</div>';
        var meta = [];
        if (ok) {
            var sz = displayFileSize(f.size); if (sz) meta.push(sz);
            meta.push(ext ? ext.toUpperCase() : (f.mime || t('File')));
            var dt = displayFileDate(f.modified); if (dt) meta.push(dt);
        } else {
            meta.push(t('File not found'));
        }
        html += '<div class="display-file-meta">' + meta.map(function(x) { return '<span>' + escDisplay(x) + '</span>'; }).join('<span class="display-file-dot" aria-hidden="true">\u00b7</span>') + '</div>';
        if (!ok && f.error) html += '<div class="display-file-errmsg">' + escDisplay(f.error) + '</div>';
        if (f.description) html += '<div class="display-file-desc">' + escDisplay(f.description) + '</div>';
        html += '</div>';
        if (ok) {
            html += '<button type="button" class="display-file-dl" data-file-id="' + escDisplay(f.file_id) + '" data-name="' + escDisplay(name) + '" aria-label="' + escDisplay(t('Download') + ': ' + name) + '" onclick="displayFileDownload(this)">';
            html += DISPLAY_DOWNLOAD_ICON + '<span class="display-file-dl-label" aria-live="polite">' + escDisplay(t('Download')) + '</span></button>';
        }
        html += '</li>';
    });
    html += '</ul></div>';
    return html;
}

// Button states: idle -> Opening... -> Opened (resets) | Failed, retry.
function displayFileDownload(btn) {
    if (!btn || btn.classList.contains('is-busy')) return Promise.resolve(false);
    var label = btn.querySelector('.display-file-dl-label');
    var set = function(state, text) {
        btn.classList.remove('is-busy', 'is-done', 'is-failed');
        if (state) btn.classList.add(state);
        if (label) label.textContent = text;
    };
    set('is-busy', t('Opening...'));
    var fileId = btn.getAttribute('data-file-id');
    var name = btn.getAttribute('data-name') || 'download';
    var opener = typeof openFileDownloadTab === 'function' ? openFileDownloadTab : function() { return Promise.reject(new Error('download unavailable')); };
    return Promise.resolve().then(function() { return opener(fileId, name); }).then(function() {
        set('is-done', t('Opened'));
        setTimeout(function() { if (btn.classList.contains('is-done')) set('', t('Download')); }, 2500);
        return true;
    }, function(e) {
        set('is-failed', t('Failed, retry'));
        if (typeof showSnackbar === 'function') showSnackbar(t('Download failed: {error}', { error: String((e && e.message) || e) }), 'error');
        return false;
    });
}
async function displayFileDownloadAll(btn) {
    var root = btn && btn.closest ? btn.closest('.display-files') : null;
    if (!root) return 0;
    var n = 0;
    var btns = root.querySelectorAll('.display-file-dl');
    for (var i = 0; i < btns.length; i++) if (await displayFileDownload(btns[i])) n++;
    return n;
}

// Page-only: resolve each entry against Agent Files / a connected folder /
// the file store. Never throws; a failing entry carries {error} and renders
// as a missing card.
//  - Agent Files path: a folder-pointer file_id (lfShareFile).
//  - connected-folder path: a blob snapshot (lfSnapshotFile) — the download
//    page can only read Agent Files pointers, so a pointer would not download.
//    The snapshot reads bytes on the caller's behalf, so it is gated by
//    lfAuthorizeSourceRead (local_folder:read Off → refused, Ask → prompt)
//    exactly like servicenow_api attachment_source / web_fetch body_source;
//    a denied read becomes that card's error (fail closed if the gate is
//    not loaded).
//  - file_id: metadata only (resolveFileMeta: no byte read for folder
//    pointers); bytes are loaded only for a capped image thumbnail.
async function resolveDisplayFiles(args, options) {
    var out = Object.assign({}, args);
    var folder = args.folder || 'virtual';
    var isVirtual = typeof lfIsVirtualFolderRef === 'function' ? lfIsVirtualFolderRef(folder) : folder === 'virtual';
    var omitted = displayFileOverflow(args);
    if (omitted) out.files_omitted = omitted;
    var isImg = function(m) { return /^image\//.test(m || ''); };
    var thumbable = function(e) { return isImg(e.mime) && !(Number(e.size) > DISPLAY_THUMB_MAX_BYTES); };
    out.files = await Promise.all(displayFileEntries(args).map(async function(f) {
        var e = Object.assign({}, f);
        if (e.error) return e;
        try {
            var blob = null;
            if (e.path && !isVirtual) {
                if (typeof lfAuthorizeSourceRead !== 'function') throw new Error('Reading "' + e.path + '" is not permitted: the local_folder:read permission gate is unavailable here.');
                await lfAuthorizeSourceRead(folder, e.path, options);
                var sn = await lfSnapshotFile(folder, e.path);
                e.file_id = sn.file_id; e.name = e.name || sn.name; e.mime = sn.mime; e.size = sn.size; e.modified = sn.lastModified;
                if (thumbable(e) && sn.bytes) blob = new Blob([sn.bytes], { type: sn.mime });
            } else if (e.path) {
                var sh = await lfShareFile(folder, e.path, { card: false });
                e.file_id = sh.file_id; e.name = e.name || sh.name; e.mime = sh.mime; e.size = sh.size;
                try { var st = await lfStatFile(folder, e.path, 32); e.modified = st.lastModified; } catch (x) {}
                if (thumbable(e) && typeof lfGetFile === 'function') { try { blob = (await lfGetFile(folder, e.path)).file; } catch (x) {} }
            } else if (e.file_id) {
                var r = typeof resolveFileMeta === 'function' ? await resolveFileMeta(e.file_id) : await resolveFile(e.file_id);
                if (!r) return Object.assign(e, { error: t('File not found: {id}', { id: e.file_id }) });
                // A pointer into a connected (non-virtual) folder is not
                // downloadable (file-download only serves virtual pointers):
                // snapshot it like a connected-folder path, behind the same gate.
                if (r.kind === 'folder' && r.folder && !(typeof lfIsVirtualFolderRef === 'function' ? lfIsVirtualFolderRef(r.folder) : r.folder === 'virtual')) {
                    if (typeof lfAuthorizeSourceRead !== 'function') throw new Error('Reading "' + r.path + '" is not permitted: the local_folder:read permission gate is unavailable here.');
                    await lfAuthorizeSourceRead(r.folder, r.path, options);
                    var fsn = await lfSnapshotFile(r.folder, r.path);
                    e.file_id = fsn.file_id; e.name = e.name || fsn.name; e.mime = fsn.mime; e.size = fsn.size; e.modified = fsn.lastModified;
                    if (thumbable(e) && fsn.bytes) blob = new Blob([fsn.bytes], { type: fsn.mime });
                } else {
                e.name = e.name || r.name; e.mime = r.mime; e.size = r.size;
                if (r.lastModified) e.modified = r.lastModified;
                if (thumbable(e)) {
                    blob = r.blob || null;
                    if (!blob && r.kind === 'folder') { try { var full = await resolveFile(e.file_id); blob = full && full.blob; } catch (x) {} }
                }
                }
            } else {
                return Object.assign(e, { error: 'path or file_id is required' });
            }
            if (blob && /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(e.mime || '') && typeof fileStoreThumbnail === 'function') {
                var th = await fileStoreThumbnail(blob, e.mime, 96);
                if (th && th.data_url) e.thumb = th.data_url;
            }
        } catch (err) {
            e.error = String((err && err.message) || err);
            delete e.file_id;
        }
        return e;
    }));
    return out;
}

// ─── Post-render init ───
// Called after renderMessages innerHTML to initialize checklist summaries
function initDisplayChecklists() {
    document.querySelectorAll('.display-checklist').forEach(function(el) {
        displayUpdateCheckSummary(el.id);
    });
}

// ─── Generator Registry ───
var DISPLAY_GENERATORS = {
    table: generateTable,
    card_list: generateCardList,
    checklist: generateChecklist,
    status_summary: generateStatusSummary,
    code: generateCode,
    timeline: generateTimeline,
    chart: generateChart,
    diff: generateDiff,
    file: generateFile
};
