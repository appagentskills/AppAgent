// DISPLAY TEMPLATES - Structured output rendered inline in chat
// =============================================
// Templates render as native HTML in the message content (not iframes).
// They inherit the app's CSS variables for theme-aware styling.
// The agent includes <!--display:ID--> in its text; formatContent replaces it.

var _displayIdCounter = 0;
var _displayStore = {}; // displayId -> { template, args, html }

function executeDisplay(args, messageIndex, options) {
    var template = args.template;
    if (!template) return { success: false, error: 'template is required' };

    var generator = DISPLAY_GENERATORS[template];
    if (!generator) return { success: false, error: 'Unknown template: ' + template + '. Available: ' + Object.keys(DISPLAY_GENERATORS).join(', ') };

    // FLUX-QW7: allocate the id BEFORE generating so stateful templates
    // (checklist) can embed it and address their persisted state later.
    var displayId = 'dsp_' + (++_displayIdCounter) + '_' + Date.now();
    var html = generator(args, displayId);
    if (!html) return { success: false, error: 'Template generator returned empty HTML' };

    _displayStore[displayId] = { template: template, args: args, html: html };

    // Persist on chat for re-render
    var chatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
    var chat = chats[chatId];
    // Eager-render path: when display is called from inside a sandbox (js_eval
    // / skill tool / widget bridge), the agent never sees a placeholder string
    // to emit in its reply text, so the placeholder-in-text render path is
    // unreachable. Attach the display to the PARENT tool's tool_result slot
    // so the renderer emits it eagerly alongside that result (same shape as
    // html_widget). For top-level display calls (no parentToolCallId) the old
    // behavior — placeholder in agent text triggers render — is preserved.
    var fromSandbox = !!(options && options.fromSandbox);
    var parentToolCallId = options && options.parentToolCallId;
    var eagerMsgIndex = -1;
    if (fromSandbox && parentToolCallId && chat && chat.messages) {
        for (var pi = chat.messages.length - 1; pi >= 0; pi--) {
            var pm = chat.messages[pi];
            if (pm.role === 'tool' && pm.tool_call_id === parentToolCallId) {
                eagerMsgIndex = pi;
                break;
            }
        }
    }
    if (chat) {
        if (!chat.displays) chat.displays = {};
        var entry = { template: template, args: args };
        if (eagerMsgIndex >= 0) {
            entry.msgIndex = eagerMsgIndex;
            entry.eager = true;
        }
        chat.displays[displayId] = entry;
        saveChatsToStorage();
    }

    var title = args.title || (template.charAt(0).toUpperCase() + template.slice(1));
    var placeholder = '<!--display:' + displayId + '-->';
    // Suppress the "include this in your reply" hint when we'll render eagerly
    // anyway — the agent has no way to do that from inside a sandbox, and the
    // hint would be misleading.
    var message = eagerMsgIndex >= 0
        ? title + ' rendered.'
        : title + ' ready. Include ' + placeholder + ' in your response to render it inline.';

    var persistEntry = { displayId: displayId, template: template, args: args };
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
        // contract; null when eager-rendered (caller doesn't need to emit it).
        placeholder: eagerMsgIndex >= 0 ? null : placeholder,
        message: message,
        _display_placeholder: eagerMsgIndex >= 0 ? null : placeholder,
        // SW-side wrapper reads this to persist chat.displays on its own chat
        // object. Without it, the SW's chat snapshot (which is broadcast back
        // to the panel) wipes the page-side mutation on the next save.
        _display_persist: persistEntry
    };
}

// Eager-render scan: returns concatenated HTML for every display attached to
// `msgIndex` (set when the display was created from inside a sandbox — see
// `executeDisplay`). Called by the message renderer alongside `getWidgetHtmlForMessage`.
function getDisplayHtmlForMessage(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.displays) return '';
    var html = '';
    Object.keys(chat.displays).forEach(function(displayId) {
        var entry = chat.displays[displayId];
        if (!entry || !entry.eager || entry.msgIndex !== msgIndex) return;
        // Render via the same path placeholder-in-text uses, so cache + chart
        // generator code stays single-sourced.
        var renderedHtml = renderDisplayPlaceholder(displayId);
        html += '<div class="display-inline" data-display-id="' + escDisplay(displayId) + '">' + renderedHtml + '</div>';
    });
    return html;
}

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
    return '<div class="display-error">Display not found: ' + escDisplay(displayId) + '</div>';
}

// ─── Helper ───
function escDisplay(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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
    var rows = args.rows || [];
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
        html += '<input class="display-search" placeholder="Search..." oninput="displayFilterTable(\'' + tableId + '\', this.value)">';
        html += '<div class="display-row-count" id="' + tableId + '-count">' + rows.length + ' rows</div>';
    }
    html += '<div class="display-table-wrap"><table><thead><tr>';
    columns.forEach(function(col, i) {
        html += '<th' + (numericCols[i] ? ' class="num"' : '') + ' onclick="displaySortTable(\'' + tableId + '\', ' + i + ')">' + escDisplay(col) + '<span class="display-sort-arrow">&#9650;</span></th>';
    });
    html += '</tr></thead><tbody>';
    rows.forEach(function(row) {
        html += '<tr>';
        if (Array.isArray(row)) {
            row.forEach(function(cell, i) { html += '<td' + (numericCols[i] ? ' class="num"' : '') + '>' + displayFormatCell(cell) + '</td>'; });
        } else {
            columns.forEach(function(col, i) { html += '<td' + (numericCols[i] ? ' class="num"' : '') + '>' + displayFormatCell(row[col]) + '</td>'; });
        }
        html += '</tr>';
    });
    html += '</tbody></table><div class="display-table-empty" style="display:none">No matching rows</div></div></div>';
    return html;
}

function displayFormatCell(val) {
    if (val == null) return '<span class="display-muted">&mdash;</span>';
    if (typeof val === 'boolean') return val ? '<span class="display-badge display-badge-green">Yes</span>' : '<span class="display-badge display-badge-red">No</span>';
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
        var x = a.cells[colIdx].textContent, y = b.cells[colIdx].textContent;
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
    if (countEl) countEl.textContent = count + ' of ' + rows.length + ' rows';
    var emptyEl = wrap.querySelector('.display-table-empty');
    if (emptyEl) emptyEl.style.display = count === 0 ? '' : 'none';
}

// ─── Card List Template ───
function generateCardList(args) {
    var cards = args.cards || [];
    if (!cards.length) return null;

    var html = '<div class="display-template display-card-list">';
    if (cards.length > 6) {
        html += '<input class="display-search" placeholder="Search cards..." oninput="displayFilterCards(this)">';
    }
    html += '<div class="display-cards">';
    cards.forEach(function(card) {
        var hasDetail = !!card.detail;
        html += '<div class="display-card' + (hasDetail ? ' has-detail' : '') + '"' + (hasDetail ? ' onclick="displayToggleExpand(this)"' : '') + '>';
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
        html += '<div class="display-check-item' + (checked ? ' checked' : '') + '" onclick="displayToggleCheck(\'' + listId + '\', this)">';
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
    if (text) text.textContent = done + ' of ' + items.length + ' completed';
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
function generateCode(args) {
    var code = args.code || '';
    var language = args.language || '';
    if (!code) return null;

    var codeId = 'dcode_' + Date.now();

    var html = '<div class="display-template display-code-wrap">';
    html += '<div class="display-code-header"><span class="display-code-lang">' + escDisplay(language) + '</span><button class="display-code-copy" onclick="displayCopyCode(\'' + codeId + '\', this)">' + DISPLAY_COPY_ICON + '<span>Copy</span></button></div>';
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
        if (span) span.textContent = 'Copied!';
        setTimeout(function() {
            btn.classList.remove('copied');
            if (span) span.textContent = 'Copy';
        }, 1500);
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
        html += '<div class="display-tl-event' + colorClass + (detail ? ' has-detail' : '') + '"' + (detail ? ' onclick="displayToggleExpand(this)"' : '') + '>';
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
        html += '<div class="display-pie-hole"><div class="display-pie-total">' + escDisplay(total) + '</div><div class="display-pie-total-label">total</div></div></div>';
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
            var type = 'ctx', text = line;
            if (typeof line === 'object') { type = line.type || 'ctx'; text = line.text || line.content || ''; }
            else if (line.charAt(0) === '+') { type = 'add'; text = line.substring(1); }
            else if (line.charAt(0) === '-') { type = 'del'; text = line.substring(1); }
            if (type === 'add') addCount++;
            if (type === 'del') delCount++;
            if (type !== 'del') lineNum++;
            body += '<div class="display-diff-line display-diff-' + type + '"><span class="display-diff-num">' + (type === 'del' ? '' : lineNum) + '</span><span class="display-diff-content">' + (type === 'add' ? '+ ' : type === 'del' ? '- ' : '  ') + escDisplay(text) + '</span></div>';
        });
    } else if (oldText || newText) {
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
    html += '<div class="display-diff-header"><span class="display-diff-file">' + escDisplay(args.file || args.header || 'Changes') + '</span>';
    html += '<span class="display-diff-stats"><span class="display-diff-stat-add">+' + addCount + '</span><span class="display-diff-stat-del">&minus;' + delCount + '</span></span></div>';
    html += body + '</div>';
    return html;
}

function displayToggleExpand(el) {
    el.classList.toggle('expanded');
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
    diff: generateDiff
};
