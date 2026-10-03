// Keyboard shortcuts: central registry, pure matcher/formatter, one global
// keydown dispatcher, Esc-to-pause (capture phase) and the shortcuts help modal
// (#keyboard-shortcuts-modal). Wired once from core/120-init.js through
// initKeyboardShortcuts(); nothing here runs at load time.
//
// Cmd/Ctrl+K (search) and Alt+Left (back) keep their own listeners in
// core/120-init.js. They are listed here as display-only rows (info:true), so
// the dispatcher never handles them twice. The Esc ladder in core/120-init.js is
// untouched: the modal is a .modal-overlay.show whose backdrop onclick closes it,
// so ladder step 3 closes it on Escape.
//
// Keys: 'Mod' = Cmd on macOS, Ctrl elsewhere. An entry may carry keysMac to
// override keys on macOS (see kbdKeysFor). Chrome-reserved combos are never
// bound: Mod+T/N/W/Q/L/R/D/Tab, Mod+Shift+T/N/W/B/Delete, F-keys, Shift+Esc
// (Task Manager on Windows/Linux), Ctrl+Shift+C/I/J (DevTools) and Cmd+Shift+C
// (DevTools inspect on macOS), which is why "Copy last response" is Alt+Shift+C
// on every platform (shown as ⌥⇧C on macOS; matched by e.code because
// Option+Shift+C types 'Ç' in e.key). Held keys never re-fire toggle shortcuts
// (e.repeat); only entries marked repeatable (Alt+Up/Down) do. Mod+Shift+O is kept: the page
// receives it before the bookmark manager (ChatGPT and Claude bind it too).
// Single printable keys (? and /) never fire inside text fields and can be turned
// off with the "Single-key shortcuts" switch in the modal (WCAG 2.1.4).

var KBD_SINGLE_KEY_PREF = 'kbdSingleKeyShortcuts';

var KBD_GROUPS = [
    { id: 'general', label: N_('General') },
    { id: 'chat', label: N_('Chat') },
    { id: 'composer', label: N_('Composer') },
    { id: 'navigation', label: N_('Navigation') }
];

var KBD_SHORTCUTS = [
    { id: 'help', group: 'general', label: N_('Show keyboard shortcuts'), keys: ['Mod+/', '?'], allowInInputs: true,
        run: function() { toggleShortcutsModal(); } },
    { id: 'settings', group: 'general', label: N_('Open settings'), keys: ['Mod+,'], allowInInputs: true,
        available: function() { return typeof openSettingsPageView === 'function'; },
        run: function() { openSettingsPageView(); } },
    { id: 'sidebar', group: 'general', label: N_('Toggle sidebar'), keys: ['Mod+Shift+S'], allowInInputs: true,
        targets: '#sidebar-toggle-btn, #toggle-sidebar-btn, #floating-sidebar-toggle',
        available: function() { return typeof toggleSidebar === 'function'; },
        run: function() { toggleSidebar(); } },
    { id: 'close', group: 'general', label: N_('Close dialog or menu'), keys: ['Escape'], info: true },
    { id: 'new-chat', group: 'chat', label: N_('New Chat'), keys: ['Mod+Shift+O'], allowInInputs: true,
        targets: '#new-chat-nav-btn',
        available: function() { return typeof startNewChat === 'function'; },
        run: function() { startNewChat(); } },
    { id: 'copy-last', group: 'chat', label: N_('Copy last response'), keys: ['Alt+Shift+C'], allowInInputs: true,
        available: function() { return typeof copyAiMessage === 'function'; },
        run: function() { kbdCopyLastResponse(); } },
    { id: 'pause', group: 'chat', label: N_('Pause the agent'), keys: ['Escape'], capture: true, allowInInputs: true,
        available: function() { return typeof togglePause === 'function' && typeof _chatControlsState === 'function'; },
        when: function() { return kbdCanPause(); },
        run: function() { togglePause(); } },
    { id: 'focus-input', group: 'composer', label: N_('Focus message input'), keys: ['/'],
        targets: '#message-input, #home-message-input',
        // On the Documents page "/" focuses the page search (tools/110 sdocFocusPageSearch);
        // only this shortcut is routed there, focus-restore paths keep using kbdFocusComposer.
        run: function() { if (typeof sdocFocusPageSearch === 'function' && sdocFocusPageSearch()) return; kbdFocusComposer(); } },
    { id: 'send', group: 'composer', label: N_('Send message'), keys: ['Enter'], info: true },
    { id: 'newline', group: 'composer', label: N_('New line'), keys: ['Shift+Enter'], info: true },
    { id: 'search', group: 'navigation', label: N_('Search chats'), keys: ['Mod+K'], info: true },
    { id: 'prev-chat', group: 'navigation', label: N_('Previous chat'), keys: ['Alt+ArrowUp'], allowInInputs: 'empty', repeatable: true,
        available: function() { return typeof selectChat === 'function'; },
        run: function() { kbdStepChat(-1); } },
    { id: 'next-chat', group: 'navigation', label: N_('Next chat'), keys: ['Alt+ArrowDown'], allowInInputs: 'empty', repeatable: true,
        available: function() { return typeof selectChat === 'function'; },
        run: function() { kbdStepChat(1); } },
    { id: 'back', group: 'navigation', label: N_('Go back'), keys: ['Alt+ArrowLeft'], info: true },
    // Documents page only: cycle Group by (tools/110 sdocCycleGroupBy).
    { id: 'docs-group-by', group: 'navigation', label: N_('Change document grouping'), keys: ['g'],
        when: function() { return typeof currentView !== 'undefined' && currentView === 'documents' && typeof sdocCycleGroupBy === 'function'; },
        run: function() { sdocCycleGroupBy(); } },
    // Documents page only: bulk selection (tools/110 sdocKbdCan guards view, overlay and state).
    // "s" toggles selection mode; "x" and Mod+A enter it on their own.
    { id: 'docs-sel-mode', group: 'navigation', label: N_('Toggle selection mode'), keys: ['s'],
        when: function() { return typeof sdocKbdCan === 'function' && sdocKbdCan('mode'); },
        run: function() { sdocToggleSelMode(); } },
    { id: 'docs-sel-toggle', group: 'navigation', label: N_('Toggle selection'), keys: ['x'],
        when: function() { return typeof sdocKbdCan === 'function' && sdocKbdCan('toggle'); },
        run: function() { sdocSelToggleFocused(); } },
    { id: 'docs-sel-all', group: 'navigation', label: N_('Select all'), keys: ['Mod+A'],
        when: function() { return typeof sdocKbdCan === 'function' && sdocKbdCan('all'); },
        run: function() { sdocSelectAllVisible(); } },
    { id: 'docs-sel-delete', group: 'navigation', label: N_('Delete selected items'), keys: ['Delete'], keysMac: ['Backspace', 'Delete'],
        when: function() { return typeof sdocKbdCan === 'function' && sdocKbdCan('delete'); },
        run: function() { sdocBulkDelete(); } },
    { id: 'docs-sel-clear', group: 'navigation', label: N_('Exit selection mode'), keys: ['Escape'],
        when: function() { return typeof sdocKbdCan === 'function' && sdocKbdCan('clear'); },
        run: function() { sdocSelClear(); } }
];

// ─── Pure helpers (unit-tested in test/keyboard-shortcuts.test.js) ───────────

// The combos that apply on this platform: keysMac on macOS when present, else keys.
function kbdKeysFor(s, isMac) {
    if (!s) return [];
    if (isMac && s.keysMac && s.keysMac.length) return s.keysMac;
    return s.keys || [];
}

function kbdIsMac() {
    try {
        var nav = typeof navigator !== 'undefined' ? navigator : null;
        if (!nav) return false;
        var p = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '';
        return /mac|iphone|ipad|ipod/i.test(String(p));
    } catch (e) { return false; }
}

function kbdParseCombo(combo) {
    var parts = String(combo || '').split('+');
    var key = parts.pop();
    if (key === '' && parts.length) { parts.pop(); key = '+'; }
    var c = { key: key, mod: false, shift: false, alt: false, ctrl: false, meta: false };
    parts.forEach(function(p) { var n = p.toLowerCase(); if (n in c && n !== 'key') c[n] = true; });
    return c;
}

// A single printable key with no Mod/Ctrl/Alt/Meta (Shift may be needed to type it).
function kbdIsSingleKey(combo) {
    var c = kbdParseCombo(combo);
    return !c.mod && !c.ctrl && !c.alt && !c.meta && c.key.length === 1;
}

function kbdIsTextField(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    var type = String(el.type || (el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
    return ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].indexOf(type) < 0;
}

function kbdFieldIsEmpty(el) {
    if (!el) return true;
    if (el.isContentEditable) return !String(el.textContent || '').trim();
    return !String(el.value == null ? '' : el.value);
}

// Symbols that need Shift on at least one common layout (US ?, German/Nordic /
// = Shift+7, ...). Only these ignore the Shift state; other symbols such as
// , . ; - = are unshifted on common layouts, so Mod+Shift+, must not match Mod+,.
var KBD_SHIFT_TOLERANT_SYMBOLS = '?/!@#$%^&*()_+{}|:"<>~';

function kbdShiftTolerantSymbol(key) {
    return typeof key === 'string' && key.length === 1 && KBD_SHIFT_TOLERANT_SYMBOLS.indexOf(key) >= 0;
}

function kbdComboMatches(e, combo, isMac) {
    if (!e) return false;
    var c = kbdParseCombo(combo);
    var wantMeta = c.meta || (c.mod && !!isMac);
    var wantCtrl = c.ctrl || (c.mod && !isMac);
    if (!!e.metaKey !== wantMeta || !!e.ctrlKey !== wantCtrl || !!e.altKey !== c.alt) return false;
    var k = String(e.key == null ? '' : e.key);
    // Symbols such as ? or / need Shift on some layouts, so Shift is not checked
    // for them; every other key (letters, digits, , . ; ...) checks Shift strictly.
    var symbol = kbdShiftTolerantSymbol(c.key);
    if (!symbol && !!e.shiftKey !== c.shift) return false;
    if (symbol && c.shift && !e.shiftKey) return false;
    if (c.key === 'Escape') return k === 'Escape' || k === 'Esc';
    if (k.toLowerCase() === c.key.toLowerCase()) return true;
    // Non-Latin layouts (e.g. Cyrillic) and Option/Alt-modified letters (macOS
    // Option+Shift+C types 'Ç'): fall back to the physical letter key.
    if (/^[a-z]$/i.test(c.key) && (c.alt || !/^[a-z]$/i.test(k)) && e.code === 'Key' + c.key.toUpperCase()) return true;
    return false;
}

// Returns the registry entry the event triggers, or null. Pure: it reads only the
// event (and opts.target, defaulting to e.target). when()/available() are checked
// by the dispatcher. opts: { shortcuts, singleKey (default true), phase: 'bubble'|'capture', target }.
function matchShortcut(e, isMac, opts) {
    opts = opts || {};
    if (!e || e.isComposing || e.keyCode === 229) return null;
    var list = opts.shortcuts || KBD_SHORTCUTS;
    var capture = opts.phase === 'capture';
    var target = opts.target !== undefined ? opts.target : e.target;
    var inField = kbdIsTextField(target);
    for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || s.info || typeof s.run !== 'function') continue;
        if (!!s.capture !== capture) continue;
        var keys = kbdKeysFor(s, isMac);
        for (var j = 0; j < keys.length; j++) {
            if (!kbdComboMatches(e, keys[j], isMac)) continue;
            if (kbdIsSingleKey(keys[j])) {
                if (opts.singleKey === false || inField) continue;
            } else if (inField) {
                if (!s.allowInInputs) continue;
                if (s.allowInInputs === 'empty' && !kbdFieldIsEmpty(target)) continue;
            }
            return s;
        }
    }
    return null;
}

var KBD_MAC_MODS = { mod: '\u2318', meta: '\u2318', ctrl: '\u2303', alt: '\u2325', shift: '\u21E7' };
var KBD_PC_MODS = { mod: 'Ctrl', meta: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
var KBD_KEY_NAMES = { Escape: 'Esc', Enter: 'Enter', ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192', ' ': 'Space', Tab: 'Tab' };

function _kbdFormatCombo(combo, isMac) {
    var c = kbdParseCombo(combo), names = isMac ? KBD_MAC_MODS : KBD_PC_MODS, out = [];
    // macOS order: Ctrl Option Shift Cmd; elsewhere: Ctrl Alt Shift.
    var order = isMac ? ['ctrl', 'alt', 'shift', 'mod', 'meta'] : ['mod', 'ctrl', 'meta', 'alt', 'shift'];
    var seen = {};
    order.forEach(function(m) {
        if (!c[m]) return;
        var n = names[m];
        if (seen[n]) return;
        seen[n] = true; out.push(n);
    });
    var k = KBD_KEY_NAMES[c.key] || (c.key.length === 1 ? c.key.toUpperCase() : c.key);
    out.push(k);
    return out;
}

// formatKeys('Mod+Shift+O', true) -> ['⇧','⌘','O']; an array of combos -> an array of part arrays.
function formatKeys(keys, isMac) {
    if (Array.isArray(keys)) return keys.map(function(k) { return _kbdFormatCombo(k, isMac); });
    return _kbdFormatCombo(keys, isMac);
}

// Compact text form for tooltips: '⇧⌘O' on macOS, 'Ctrl+Shift+O' elsewhere.
function kbdComboText(combo, isMac) {
    return formatKeys(combo, isMac).join(isMac ? '' : '+');
}

// aria-keyshortcuts value (WAI-ARIA key names).
function kbdAriaKeys(combo, isMac) {
    var c = kbdParseCombo(combo), out = [];
    if (c.ctrl || (c.mod && !isMac)) out.push('Control');
    if (c.meta || (c.mod && isMac)) out.push('Meta');
    if (c.alt) out.push('Alt');
    if (c.shift) out.push('Shift');
    out.push(c.key === ' ' ? 'Space' : c.key);
    return out.join('+');
}

// Spoken form for screen readers (the key-caps themselves are aria-hidden).
function kbdSpokenCombo(combo, isMac) {
    var c = kbdParseCombo(combo), out = [];
    var spoken = { Escape: 'Escape', ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow', ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow', '/': 'Slash', ',': 'Comma', '?': 'Question mark' };
    if (c.ctrl || (c.mod && !isMac)) out.push('Control');
    if (c.alt) out.push(isMac ? 'Option' : 'Alt');
    if (c.shift) out.push('Shift');
    if (c.meta || (c.mod && isMac)) out.push('Command');
    out.push(spoken[c.key] || (c.key.length === 1 ? c.key.toUpperCase() : c.key));
    return out.join('+');
}

function kbdGroupLabel(groupId) {
    for (var i = 0; i < KBD_GROUPS.length; i++) if (KBD_GROUPS[i].id === groupId) return KBD_GROUPS[i].label;
    return groupId;
}

function _kbdT(s) { try { return typeof t === 'function' ? t(s) : s; } catch (e) { return s; } }

// Live filter: every whitespace-separated token must appear in the translated
// label, the group name, the key-cap text or the raw combo.
function filterShortcuts(list, query, isMac) {
    list = list || KBD_SHORTCUTS;
    var tokens = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return list.slice();
    return list.filter(function(s) {
        var hay = [_kbdT(s.label), s.label, _kbdT(kbdGroupLabel(s.group))];
        kbdKeysFor(s, isMac).forEach(function(k) {
            hay.push(k, formatKeys(k, isMac).join(' '), kbdComboText(k, isMac), kbdSpokenCombo(k, isMac));
        });
        var text = hay.join(' ').toLowerCase();
        return tokens.every(function(tok) { return text.indexOf(tok) >= 0; });
    });
}

// Tab trap: the node to move focus to, or null to let the browser move it.
function kbdTrapTarget(nodes, active, shift) {
    if (!nodes || !nodes.length) return null;
    var i = nodes.indexOf(active);
    if (i < 0) return shift ? nodes[nodes.length - 1] : nodes[0];
    if (shift && i === 0) return nodes[nodes.length - 1];
    if (!shift && i === nodes.length - 1) return nodes[0];
    return null;
}

function kbdFindShortcut(id) {
    for (var i = 0; i < KBD_SHORTCUTS.length; i++) if (KBD_SHORTCUTS[i].id === id) return KBD_SHORTCUTS[i];
    return null;
}

// ' (⇧⌘S)' for tooltips, '' when the shortcut is unknown.
function kbdHintSuffix(id) {
    var isMac = kbdIsMac(), keys = kbdKeysFor(kbdFindShortcut(id), isMac);
    return keys.length ? ' (' + kbdComboText(keys[0], isMac) + ')' : '';
}

// ─── Preferences ─────────────────────────────────────────────────────────────

function kbdSingleKeyEnabled() {
    try { return typeof appStorage === 'undefined' || appStorage.getItem(KBD_SINGLE_KEY_PREF) !== 'false'; } catch (e) { return true; }
}

function setKbdSingleKeyEnabled(on) {
    try { if (typeof appStorage !== 'undefined') appStorage.setItem(KBD_SINGLE_KEY_PREF, on ? 'true' : 'false'); } catch (e) {}
    _kbdRenderFooterHint();
}

// ─── Runtime state probes ───────────────────────────────────────────────────

var KBD_OVERLAY_SELECTOR = '.modal-overlay.show, .sdoc-preview-overlay, .widget-fullscreen-overlay, ' +
    '.widget-modal-overlay, .wsf-overlay, .modal-backdrop, .action-result-popover, #diff-viewer-overlay, ' +
    '#jobs-expand-overlay, #widget-fullscreen-overlay, #widget-edit-overlay, #widget-modal-overlay, #widget-pin-menu';

function kbdOverlayOpen() {
    try { return !!document.querySelector(KBD_OVERLAY_SELECTOR); } catch (e) { return false; }
}

function kbdMenuOpen() {
    try {
        if (document.querySelector('.sn-dropdown.open, .chat-dropdown.open, .custom-dropdown.open')) return true;
        var menus = document.querySelectorAll('.header-menu');
        for (var i = 0; i < menus.length; i++) {
            if (window.getComputedStyle(menus[i]).display !== 'none') return true;
        }
    } catch (e) {}
    return false;
}

function kbdCanPause() {
    if (typeof togglePause !== 'function' || typeof _chatControlsState !== 'function') return false;
    if (typeof currentChatId === 'undefined' || !currentChatId) return false;
    if (kbdOverlayOpen() || kbdMenuOpen()) return false;
    var a = document.activeElement;
    // Esc in another field (search, settings) keeps its own meaning.
    if (kbdIsTextField(a) && a.id !== 'message-input' && a.id !== 'home-message-input') return false;
    return _chatControlsState(currentChatId) === 'pause';
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function _kbdVisible(el) { return !!el && el.offsetParent !== null && !el.disabled; }

function kbdFocusComposer() {
    var el = document.getElementById('message-input');
    if (!_kbdVisible(el)) el = document.getElementById('home-message-input');
    if (!_kbdVisible(el)) return false;
    el.focus();
    try { var n = String(el.value || '').length; el.setSelectionRange(n, n); } catch (e) {}
    return true;
}

function kbdCopyLastResponse() {
    var chat = (typeof chats !== 'undefined' && chats && typeof currentChatId !== 'undefined') ? chats[currentChatId] : null;
    // C2 skeleton (messages evicted to IDB): hydrate once, then retry; a miss
    // fails closed with a toast instead of claiming there is no response.
    if (chat && !Array.isArray(chat.messages) && chat._messagesEvicted && typeof ensureChatPayloads === 'function') {
        var kid = currentChatId;
        Promise.resolve().then(function() { return ensureChatPayloads(kid); }).catch(function() {}).then(function() {
            if (kid !== currentChatId) return;
            var c = chats[kid];
            if (c && Array.isArray(c.messages)) kbdCopyLastResponse();
            else if (typeof showSnackbar === 'function') showSnackbar(t('Copy failed'), 'error');
        });
        return true;
    }
    var msgs = (chat && chat.messages) || [];
    var last = -1;
    for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === 'assistant' && (msgs[i].content || (msgs[i].tool_calls && msgs[i].tool_calls.length))) { last = i; break; }
    }
    if (last < 0) {
        if (typeof showSnackbar === 'function') showSnackbar(t('No response to copy yet'), 'info', undefined, { transient: true });
        return false;
    }
    var userIdx = -1;
    for (var j = last - 1; j >= 0; j--) { if (msgs[j] && msgs[j].role === 'user') { userIdx = j; break; } }
    copyAiMessage(userIdx); // shows the "Response copied" / "Copy failed" toast
    return true;
}

function _kbdChatListIds(list) {
    var ids = [];
    Array.prototype.forEach.call(list.querySelectorAll('.chat-item[data-chat-id]'), function(r) {
        var id = r.getAttribute('data-chat-id');
        if (id && ids.indexOf(id) < 0) ids.push(id);
    });
    return ids;
}

function kbdStepChat(dir) {
    var list = document.getElementById('chat-list');
    if (!list || typeof selectChat !== 'function') return false;
    var ids = _kbdChatListIds(list);
    if (!ids.length) return false;
    var cur = typeof currentChatId !== 'undefined' ? currentChatId : null;
    var i = ids.indexOf(cur);
    var next = i < 0 ? (dir > 0 ? 0 : ids.length - 1) : i + dir;
    // The sidebar renders a capped page (ui/180-search.js). Stepping down past
    // the last rendered row grows it by one page ("View more") and continues.
    // The active chat may be appended after the cap, so re-resolve and loop
    // (bounded) until the next row exists or nothing more is hidden.
    for (var guard = 0; dir > 0 && next >= ids.length && guard < 200; guard++) {
        if (!list.querySelector('.chat-list-more') || typeof showMoreChatListItems !== 'function') break;
        var before = ids.length;
        showMoreChatListItems();
        ids = _kbdChatListIds(list);
        if (ids.length <= before) break;
        i = ids.indexOf(cur);
        next = i < 0 ? 0 : i + dir;
    }
    if (next < 0 || next >= ids.length) return false; // no wrap
    selectChat(ids[next]);
    try {
        Array.prototype.forEach.call(list.querySelectorAll('.chat-item[data-chat-id]'), function(r) {
            if (r.getAttribute('data-chat-id') === ids[next] && typeof r.scrollIntoView === 'function') r.scrollIntoView({ block: 'nearest' });
        });
    } catch (e) {}
    return true;
}

// ─── Dispatchers ─────────────────────────────────────────────────────────────

function _kbdIsAvailable(s) { try { return !s.available || !!s.available(); } catch (e) { return false; } }

function kbdHandleKeydown(e) {
    if (!e || e.defaultPrevented) return;
    var s = matchShortcut(e, kbdIsMac(), { singleKey: kbdSingleKeyEnabled() });
    if (!s || !_kbdIsAvailable(s)) return;
    if (document.getElementById('keyboard-shortcuts-modal')) {
        if (s.id !== 'help') return; // only the help toggle works over its own modal
    } else if (kbdOverlayOpen()) {
        return; // never act underneath another dialog
    }
    if (s.when && !s.when(e)) return;
    e.preventDefault();
    if (e.repeat && !s.repeatable) return; // a held toggle key must not flicker
    try { s.run(e); } catch (err) { if (typeof console !== 'undefined') console.warn('[shortcuts]', s.id, err); }
}

// Capture phase so Esc-to-pause sees the state BEFORE the Esc ladder closes a
// menu: when anything is open, kbdCanPause() is false and the ladder owns Esc.
function kbdHandleKeydownCapture(e) {
    if (!e || e.defaultPrevented || (e.key !== 'Escape' && e.key !== 'Esc')) return;
    var s = matchShortcut(e, kbdIsMac(), { phase: 'capture' });
    if (!s || !_kbdIsAvailable(s)) return;
    if (s.when && !s.when(e)) return;
    e.preventDefault();
    if (e.repeat && !s.repeatable) return; // holding Esc must not pause/resume repeatedly
    try { s.run(e); } catch (err) { if (typeof console !== 'undefined') console.warn('[shortcuts]', s.id, err); }
}

// ─── Shortcuts modal ────────────────────────────────────────────────────────

var _kbdModalOpener = null;

function _kbdEsc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s));
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _kbdIcon(name) { return (typeof UI_ICONS !== 'undefined' && UI_ICONS && UI_ICONS[name]) || ''; }

function kbdCapsHtml(combo, isMac) {
    var caps = formatKeys(combo, isMac).map(function(p) { return '<kbd class="kbd-cap">' + _kbdEsc(p) + '</kbd>'; });
    return '<span class="kbd-combo"><span class="kbd-sr">' + _kbdEsc(kbdSpokenCombo(combo, isMac)) + '</span>' +
        '<span class="kbd-combo-caps" aria-hidden="true">' + caps.join(isMac ? '' : '<span class="kbd-plus">+</span>') + '</span></span>';
}

function _kbdRowHtml(s, isMac) {
    var keys = kbdKeysFor(s, isMac).map(function(k) { return kbdCapsHtml(k, isMac); })
        .join('<span class="kbd-or">' + _kbdEsc(t('or')) + '</span>');
    return '<li class="kbd-row" data-kbd-id="' + _kbdEsc(s.id) + '"><span class="kbd-label">' + _kbdEsc(_kbdT(s.label)) + '</span>' +
        '<span class="kbd-keys">' + keys + '</span></li>';
}

function _kbdFillKey(text, capsHtml) {
    var parts = String(text).split('{key}');
    return parts.map(_kbdEsc).join(capsHtml);
}

function _kbdRenderFooterHint() {
    var el = document.getElementById('kbd-footer-hint');
    if (!el) return;
    var isMac = kbdIsMac();
    var helpCombo = kbdSingleKeyEnabled() ? '?' : 'Mod+/';
    el.innerHTML = '<span>' + _kbdFillKey(t('Press {key} anytime'), kbdCapsHtml(helpCombo, isMac)) + '</span>' +
        '<span class="kbd-dot" aria-hidden="true">\u00B7</span>' +
        '<span>' + _kbdFillKey(t('{key} to close'), kbdCapsHtml('Escape', isMac)) + '</span>';
}

function kbdModalHtml(isMac) {
    var groups = KBD_GROUPS.map(function(g) {
        var rows = KBD_SHORTCUTS.filter(function(s) { return s.group === g.id && _kbdIsAvailable(s); });
        if (!rows.length) return '';
        return '<section class="kbd-group" data-kbd-group="' + g.id + '" aria-labelledby="kbd-group-' + g.id + '">' +
            '<h3 class="kbd-group-title" id="kbd-group-' + g.id + '">' + _kbdEsc(_kbdT(g.label)) + '</h3>' +
            '<ul class="kbd-list">' + rows.map(function(s) { return _kbdRowHtml(s, isMac); }).join('') + '</ul></section>';
    }).join('');
    return '<div class="kbd-dialog" role="dialog" aria-modal="true" aria-labelledby="kbd-title" aria-describedby="kbd-subtitle">' +
        '<header class="kbd-header">' +
            '<span class="kbd-header-icon" aria-hidden="true">' + _kbdIcon('keyboard') + '</span>' +
            '<div class="kbd-header-text"><h2 class="kbd-title" id="kbd-title">' + _kbdEsc(t('Keyboard shortcuts')) + '</h2>' +
            '<p class="kbd-subtitle" id="kbd-subtitle">' + _kbdEsc(t('Work faster without leaving the keyboard.')) + '</p></div>' +
            '<button type="button" class="kbd-close" id="kbd-close-btn" aria-label="' + _kbdEsc(t('Close')) + '" title="' + _kbdEsc(t('Close')) + '">' +
                '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button>' +
        '</header>' +
        '<div class="kbd-search">' +
            '<span class="kbd-search-icon" aria-hidden="true"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg></span>' +
            '<input type="search" class="kbd-filter" id="kbd-filter" autocomplete="off" spellcheck="false" aria-controls="kbd-groups" ' +
                'placeholder="' + _kbdEsc(t('Search shortcuts')) + '" aria-label="' + _kbdEsc(t('Search shortcuts')) + '">' +
        '</div>' +
        '<div class="kbd-body" id="kbd-groups" role="region" tabindex="0" aria-label="' + _kbdEsc(t('Keyboard shortcuts')) + '">' + groups +
            // Always rendered (a live region must exist before it changes); kbdApplyFilter
            // swaps its content, and CSS .kbd-empty:empty hides it visually.
            '<div class="kbd-empty" id="kbd-empty" role="status"></div>' +
        '</div>' +
        '<footer class="kbd-footer">' +
            '<label class="kbd-switch">' +
                '<input type="checkbox" role="switch" id="kbd-single-key-toggle"' + (kbdSingleKeyEnabled() ? ' checked' : '') + ' aria-describedby="kbd-single-key-desc">' +
                '<span class="kbd-switch-track" aria-hidden="true"><span class="kbd-switch-thumb"></span></span>' +
                '<span class="kbd-switch-text"><span class="kbd-switch-label">' + _kbdEsc(t('Single-key shortcuts')) + '</span>' +
                '<span class="kbd-switch-desc" id="kbd-single-key-desc">' + _kbdEsc(t('Use ? and / when you are not typing in a field')) + '</span></span>' +
            '</label>' +
            '<span class="kbd-footer-hint" id="kbd-footer-hint"></span>' +
        '</footer>' +
    '</div>';
}

function kbdApplyFilter(query) {
    var ov = document.getElementById('keyboard-shortcuts-modal');
    if (!ov) return 0;
    var shown = {};
    filterShortcuts(KBD_SHORTCUTS, query, kbdIsMac()).forEach(function(s) { shown[s.id] = true; });
    var total = 0;
    Array.prototype.forEach.call(ov.querySelectorAll('.kbd-group'), function(sec) {
        var n = 0;
        Array.prototype.forEach.call(sec.querySelectorAll('.kbd-row'), function(row) {
            var on = !!shown[row.getAttribute('data-kbd-id')];
            row.hidden = !on;
            if (on) n++;
        });
        sec.hidden = n === 0;
        total += n;
    });
    var empty = document.getElementById('kbd-empty');
    if (empty) {
        var html = total > 0 ? '' : kbdEmptyHtml();
        if (empty.innerHTML !== html) empty.innerHTML = html;
    }
    return total;
}

function kbdEmptyHtml() {
    return '<span class="kbd-empty-icon" aria-hidden="true">' + _kbdIcon('keyboard') + '</span>' +
        '<span class="kbd-empty-title">' + _kbdEsc(t('No shortcuts found')) + '</span>' +
        '<span class="kbd-empty-hint">' + _kbdEsc(t('Try another word, like \u201Cchat\u201D or \u201CEsc\u201D.')) + '</span>';
}

function _kbdFocusables(root) {
    if (!root) return [];
    return Array.prototype.filter.call(
        root.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'),
        function(el) { return el.offsetParent !== null || el.getClientRects().length > 0 || (el.type === 'checkbox'); });
}

var _kbdModalKeydownBound = false;

// Bound on document (not the overlay) so Tab is trapped even when focus sits on
// <body> (the overlay is data-kbd-self-focus, so kbdModalTabTrap skips it).
// One document listener only, so the handler cannot double-fire.
function _kbdModalKeydown(e) {
    if (!e || e.key !== 'Tab' || e.defaultPrevented) return;
    var ov = document.getElementById('keyboard-shortcuts-modal');
    if (!ov) return;
    var dlg = ov.querySelector('.kbd-dialog');
    if (!dlg) return;
    var target = kbdTrapTarget(_kbdFocusables(dlg), document.activeElement, !!e.shiftKey);
    if (target) { e.preventDefault(); target.focus(); }
}

function openShortcutsModal() {
    var existing = document.getElementById('keyboard-shortcuts-modal');
    if (existing) { var f0 = document.getElementById('kbd-filter'); if (f0) f0.focus(); return existing; }
    var a = document.activeElement;
    _kbdModalOpener = a && a !== document.body ? a : null;
    var ov = document.createElement('div');
    ov.className = 'modal-overlay show kbd-overlay';
    ov.id = 'keyboard-shortcuts-modal';
    ov.setAttribute('data-kbd-self-focus', ''); // own trap + restore (generic manager skips it)
    ov.innerHTML = kbdModalHtml(kbdIsMac());
    // Backdrop click closes; core/120-init.js Esc ladder step 3 replays this onclick.
    ov.onclick = function(ev) { if (ev && ev.target === ov) closeShortcutsModal(); };
    if (!_kbdModalKeydownBound) { document.addEventListener('keydown', _kbdModalKeydown); _kbdModalKeydownBound = true; }
    document.body.appendChild(ov);
    var closeBtn = document.getElementById('kbd-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', function() { closeShortcutsModal(); });
    var filter = document.getElementById('kbd-filter');
    if (filter) filter.addEventListener('input', function() { kbdApplyFilter(filter.value); });
    var toggle = document.getElementById('kbd-single-key-toggle');
    if (toggle) toggle.addEventListener('change', function() { setKbdSingleKeyEnabled(!!toggle.checked); });
    _kbdRenderFooterHint();
    if (filter) filter.focus();
    return ov;
}

function closeShortcutsModal() {
    var ov = document.getElementById('keyboard-shortcuts-modal');
    if (_kbdModalKeydownBound) { document.removeEventListener('keydown', _kbdModalKeydown); _kbdModalKeydownBound = false; }
    if (!ov) return;
    ov.remove();
    var opener = _kbdModalOpener;
    _kbdModalOpener = null;
    kbdRestoreModalFocus(opener);
}

// Focus restore after the shortcuts dialog closes: the opener if it is still
// connected and focusable, else the composer, else a visible gear, else body.
// Returns which target got focus ('opener' | 'composer' | 'gear' | 'body').
function kbdRestoreModalFocus(opener) {
    if (opener && opener.isConnected && typeof opener.focus === 'function' && opener.offsetParent !== null && !opener.disabled) {
        opener.focus();
        return 'opener';
    }
    if (kbdFocusComposer()) return 'composer';
    var gears = document.querySelectorAll('.settings-btn');
    for (var i = 0; i < gears.length; i++) { if (gears[i].offsetParent !== null) { gears[i].focus(); return 'gear'; } }
    // Nothing focusable: drop focus to <body> (blur whatever still holds it).
    var a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
    return 'body';
}

function toggleShortcutsModal() {
    if (document.getElementById('keyboard-shortcuts-modal')) closeShortcutsModal(); else openShortcutsModal();
}

// ─── Init ────────────────────────────────────────────────────────────────────

var _kbdInitDone = false;

function kbdDecorateTargets() {
    var isMac = kbdIsMac();
    KBD_SHORTCUTS.forEach(function(s) {
        var keys = kbdKeysFor(s, isMac);
        if (!s.targets || !keys.length) return;
        Array.prototype.forEach.call(document.querySelectorAll(s.targets), function(el) {
            el.setAttribute('aria-keyshortcuts', keys.map(function(k) { return kbdAriaKeys(k, isMac); }).join(' '));
            el.setAttribute('data-kbd-hint', kbdComboText(keys[0], isMac));
        });
    });
    var row = document.getElementById('settings-keyboard-shortcuts');
    if (row) row.setAttribute('aria-keyshortcuts', kbdAriaKeys('Mod+/', isMac));
    var cap = document.getElementById('settings-link-kbd-shortcuts');
    if (cap) cap.innerHTML = formatKeys('Mod+/', isMac).map(function(p) { return '<kbd class="kbd-cap">' + _kbdEsc(p) + '</kbd>'; }).join('');
    if (typeof updateSidebarToggleIcon === 'function') { try { updateSidebarToggleIcon(); } catch (e) {} }
}

// ─── Phase B: Enter/Space activation delegate ────────────────────────────────────
// Non-button controls marked [data-kbd-click] (or role=button that isn't a real
// <button>) activate on Enter/Space. Elements with their own Enter/Space handler
// call preventDefault, so defaultPrevented events are skipped (no double fire).
var KBD_CLICK_SELECTOR = '[data-kbd-click], [role="button"]:not(button)';

// Pure: should this keydown activate `el`? Returns 'click' or null.
function kbdActivationFor(e, el) {
    if (!e || !el || e.defaultPrevented || e.isComposing || e.repeat) return null;
    if (e.key !== 'Enter' && e.key !== ' ') return null;
    if (e.altKey || e.ctrlKey || e.metaKey) return null;
    if (e.target !== el) return null;
    if (!el.matches || !el.matches(KBD_CLICK_SELECTOR)) return null;
    if (el.getAttribute('aria-disabled') === 'true' || kbdIsTextField(el)) return null;
    return 'click';
}

function kbdHandleActivation(e) {
    var el = e && e.target;
    if (kbdActivationFor(e, el) !== 'click') return;
    e.preventDefault(); // Space must not scroll; Enter must not submit
    el.click();
}

// Pure (APG radiogroup): index the arrow key moves to in a group of `len` radios
// from `cur`, wrapping at both ends; -1 for keys it does not handle. Down/Right
// go forward, Up/Left back; in RTL the horizontal pair is mirrored.
function kbdRadioNextIndex(len, cur, key, rtl) {
    if (!(len > 0) || !(cur >= 0) || cur >= len) return -1;
    var fwd = key === 'ArrowDown' || key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    var back = key === 'ArrowUp' || key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    if (fwd) return (cur + 1) % len;
    if (back) return (cur - 1 + len) % len;
    return -1;
}

// ─── Phase B: generic modal focus manager ─────────────────────────────────────
// Covers #modal-overlay and every dynamic .modal-overlay twin: they are opened
// by toggling .show or by appending/removing the overlay, from many code paths,
// so a MutationObserver watches instead of hooking each open/close function.
// Overlays that manage focus themselves opt out with [data-kbd-self-focus]
// (shortcuts modal, tool inspector, ChatGPT device/browser, GitHub setup).
// Escape is NOT handled here: the core/120-init.js ladder keeps closing modals.
var KBD_FOCUSABLE_SELECTOR = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

function _kbdSelfFocus(el) { return !!(el && el.hasAttribute && el.hasAttribute('data-kbd-self-focus')); }
function _kbdInOverlay(el) { return !!(el && el.closest && el.closest('.modal-overlay')); }
function _kbdHasBox(el) { return !!(el && el.isConnected && el.getClientRects && el.getClientRects().length > 0); }

// Open overlays, bottom to top. #modal-overlay paints above every dynamic twin
// (css/14-modals.css: z-index --z-modal + 1), so when shown it is the topmost.
function kbdOpenOverlays() {
    var list = Array.prototype.slice.call(document.querySelectorAll('.modal-overlay.show'));
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === 'modal-overlay') { list.push(list.splice(i, 1)[0]); break; }
    }
    return list;
}

function kbdFocusablesIn(root) {
    if (!root) return [];
    return Array.prototype.filter.call(root.querySelectorAll(KBD_FOCUSABLE_SELECTOR), function(el) {
        return _kbdHasBox(el) && !(el.closest && el.closest('[inert]'));
    });
}

// Pure: what to do after the set of open overlays changed.
// s.top: null | {selfFocus, isNew, hasFocus} for the topmost open overlay;
// s.wasEmpty: nothing was open before; s.closed: managed (non-opt-out) overlays
// that closed this tick; s.focusLost: see kbdFocusWasLost (focus really fell out,
// NOT merely activeElement===body); s.openerUsable: the remembered opener is
// connected + visible.
// Returns {action: 'none'|'focus-inside'|'restore-opener'|'restore-composer', remember}.
function kbdModalFocusPlan(s) {
    s = s || {};
    var top = s.top || null;
    var remember = !!(top && s.wasEmpty);
    if (top) {
        if (top.selfFocus || top.hasFocus) return { action: 'none', remember: remember };
        // Never yank focus back for unrelated mutations (e.g. a snackbar after the
        // user clicked text): only on open, or when focus really fell out (the
        // focused element was removed/hidden, or its stacked modal closed).
        if (top.isNew || s.focusLost) return { action: 'focus-inside', remember: remember };
        return { action: 'none', remember: remember };
    }
    // Close: restore only when focus was lost, so modals that restore focus
    // themselves (or a user who already moved on) are left alone.
    if (s.closed > 0 && s.focusLost) return { action: s.openerUsable ? 'restore-opener' : 'restore-composer', remember: false };
    return { action: 'none', remember: false };
}

// Pure-ish: was focus actually LOST? True when activeElement is inside an overlay
// that just closed, or when it sits on body/null/detached AND the last element
// that had focus was removed or hidden. A user clicking plain text also leaves
// activeElement===body, but lastFocused is still connected and visible, so a
// later body mutation (snackbar, toast) must not count as focus loss.
function kbdFocusWasLost(active, lastFocused, closed, body, hasBox) {
    hasBox = hasBox || _kbdHasBox;
    closed = closed || [];
    if (active && active !== body && active.isConnected !== false) {
        return closed.some(function(ov) { return ov.contains(active); });
    }
    if (!lastFocused || lastFocused === body) return false;
    if (closed.some(function(ov) { return ov.contains(lastFocused); })) return true;
    return !hasBox(lastFocused);
}

var _kbdMf = { open: [], opener: null, lastOutside: null, lastFocused: null, watched: null, attrObs: null };

function _kbdMfFocusIn(e) {
    var el = e && e.target;
    if (!el || el.nodeType !== 1 || el === document.body) return;
    _kbdMf.lastFocused = el;
    if (!_kbdInOverlay(el)) _kbdMf.lastOutside = el;
}

function _kbdMfFocusInside(ov) {
    var nodes = kbdFocusablesIn(ov);
    if (nodes.length) { nodes[0].focus(); return; }
    var dlg = ov.querySelector('.modal-dialog, [role="dialog"]') || ov;
    if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1');
    try { dlg.focus({ preventScroll: true }); } catch (e) { dlg.focus(); }
}

function kbdModalSync() {
    if (_kbdMf.attrObs) {
        Array.prototype.forEach.call(document.querySelectorAll('.modal-overlay'), function(ov) {
            if (_kbdMf.watched.has(ov)) return;
            _kbdMf.watched.add(ov);
            _kbdMf.attrObs.observe(ov, { attributes: true, attributeFilter: ['class'] });
        });
    }
    var prev = _kbdMf.open, open = kbdOpenOverlays();
    var top = open.length ? open[open.length - 1] : null;
    var active = document.activeElement;
    var closed = prev.filter(function(ov) { return open.indexOf(ov) < 0; });
    var focusLost = kbdFocusWasLost(active, _kbdMf.lastFocused, closed, document.body);
    var opener = _kbdMf.opener;
    var plan = kbdModalFocusPlan({
        wasEmpty: !prev.length,
        top: top ? { selfFocus: _kbdSelfFocus(top), isNew: prev.indexOf(top) < 0, hasFocus: !!(active && top.contains(active)) } : null,
        closed: closed.filter(function(ov) { return !_kbdSelfFocus(ov); }).length,
        focusLost: focusLost,
        openerUsable: _kbdHasBox(opener)
    });
    _kbdMf.open = open;
    if (plan.remember) {
        // Autofocusing modals already moved focus inside: fall back to the tracker.
        _kbdMf.opener = active && active !== document.body && !_kbdInOverlay(active) ? active : _kbdMf.lastOutside;
    }
    if (!open.length) _kbdMf.opener = null;
    if (plan.action === 'focus-inside') _kbdMfFocusInside(top);
    else if (plan.action === 'restore-opener') { opener.focus(); if (document.activeElement !== opener) kbdFocusComposer(); }
    else if (plan.action === 'restore-composer') kbdFocusComposer();
    return plan;
}

// Tab / Shift+Tab stay inside the TOPMOST open managed overlay. Opt-out
// overlays run their own trap (and preventDefault, which is honoured here).
function kbdModalTabTrap(e) {
    if (!e || e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var open = kbdOpenOverlays(), top = open[open.length - 1];
    if (!top || _kbdSelfFocus(top)) return;
    var nodes = kbdFocusablesIn(top);
    if (!nodes.length) { e.preventDefault(); return; }
    var target = kbdTrapTarget(nodes, document.activeElement, !!e.shiftKey);
    if (target) { e.preventDefault(); target.focus(); }
}

function kbdInitModalFocusManager() {
    document.addEventListener('focusin', _kbdMfFocusIn, true);
    document.addEventListener('keydown', kbdModalTabTrap);
    if (typeof MutationObserver !== 'function' || !document.body) return;
    _kbdMf.watched = typeof WeakSet === 'function' ? new WeakSet() : { has: function() { return true; }, add: function() {} };
    _kbdMf.attrObs = new MutationObserver(kbdModalSync);
    new MutationObserver(kbdModalSync).observe(document.body, { childList: true });
    kbdModalSync();
}

// ─── Phase B: arrow roving (chat list, header menus, gear panel) ─────────────────
// Pure: index an arrow/Home/End key moves to in a list of `len` items from `cur`
// (wrapping); from outside the list (cur -1) Down enters at the top, Up at the
// bottom. -1 for keys it does not handle.
function kbdRovingIndex(len, cur, key) {
    if (!(len > 0)) return -1;
    var inList = cur >= 0 && cur < len;
    if (key === 'Home') return 0;
    if (key === 'End') return len - 1;
    if (key === 'ArrowDown') return inList ? (cur + 1) % len : 0;
    if (key === 'ArrowUp') return inList ? (cur - 1 + len) % len : len - 1;
    return -1;
}

// Controls that keep their own arrow keys: text fields, selects, sliders, the
// theme radiogroup (settingsPanelThemeKeydown) and listbox options (ui/140).
var KBD_ROVING_SKIP = 'input:not([type="checkbox"]):not([type="button"]):not([type="submit"]), select, textarea, ' +
    '[contenteditable="true"], [role="radio"], [role="radiogroup"] *, [role="option"], [role="listbox"] *';

function _kbdOpenHeaderMenu() {
    var menus = document.querySelectorAll('.header-menu');
    for (var i = 0; i < menus.length; i++) {
        if (window.getComputedStyle(menus[i]).display !== 'none' && _kbdHasBox(menus[i])) return menus[i];
    }
    return null;
}

function _kbdMenuItems(menu) {
    return kbdFocusablesIn(menu).filter(function(el) { return !el.matches(KBD_ROVING_SKIP); });
}

// The roving list `el` belongs to, or null. Chat rows are already one Tab stop
// each (role=button tabindex=0, Enter/Space via chatItemKeydown, ui/180), so
// arrows just move focus between them.
function kbdRovingItems(el) {
    if (!el || el.nodeType !== 1 || !el.closest) return null;
    if (el.classList.contains('chat-item') && el.closest('#chat-list')) {
        return Array.prototype.filter.call(el.closest('#chat-list').querySelectorAll('.chat-item'), _kbdHasBox);
    }
    var menu = el.closest('.header-menu');
    if (!menu || el.matches(KBD_ROVING_SKIP) || window.getComputedStyle(menu).display === 'none') return null;
    return _kbdMenuItems(menu);
}

function kbdHandleRoving(e) {
    if (!e || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Home' && e.key !== 'End') return;
    var items = kbdRovingItems(e.target);
    var cur = items ? items.indexOf(e.target) : -1;
    if (cur < 0) return;
    var next = kbdRovingIndex(items.length, cur, e.key);
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
}

// A header-menu trigger opened from the keyboard (click with detail 0: Enter/
// Space on a button, or the Enter/Space delegate's el.click()) moves focus to
// the first menu item, unless the menu already moved it.
function kbdMenuTriggerClick(e) {
    if (!e || e.detail !== 0) return;
    var trig = e.target && e.target.closest && e.target.closest('[aria-haspopup]');
    if (!trig || trig.classList.contains('custom-dropdown-trigger')) return; // ui/140 focuses its own options
    setTimeout(function() {
        if (trig.getAttribute('aria-expanded') !== 'true' || document.activeElement !== trig) return;
        var menu = _kbdOpenHeaderMenu();
        var items = menu ? _kbdMenuItems(menu) : [];
        if (items.length) items[0].focus();
    }, 0);
}

// Esc closes the menu via the core/120-init.js ladder (step 7); afterwards
// return focus to the trigger when it was left on body or the hidden menu.
function kbdMenuEscCapture(e) {
    if (!e || e.key !== 'Escape' || e.isComposing || kbdOverlayOpen() || !kbdMenuOpen()) return;
    var triggers = document.querySelectorAll('[aria-haspopup][aria-expanded="true"]'), trig = null;
    for (var i = 0; i < triggers.length && !trig; i++) if (_kbdHasBox(triggers[i])) trig = triggers[i];
    if (!trig) return;
    setTimeout(function() {
        if (!_kbdHasBox(trig) || trig.getAttribute('aria-expanded') === 'true') return;
        var a = document.activeElement;
        if (!a || a === document.body || !_kbdHasBox(a) || (a.closest && a.closest('.header-menu'))) trig.focus();
    }, 0);
}

function initKeyboardShortcuts() {
    if (_kbdInitDone) return;
    _kbdInitDone = true;
    document.addEventListener('keydown', kbdHandleActivation);
    document.addEventListener('keydown', kbdHandleRoving);
    document.addEventListener('keydown', kbdMenuEscCapture, true);
    document.addEventListener('click', kbdMenuTriggerClick);
    try { kbdInitModalFocusManager(); } catch (e) {}
    document.addEventListener('keydown', kbdHandleKeydownCapture, true);
    document.addEventListener('keydown', kbdHandleKeydown);
    try { kbdDecorateTargets(); } catch (e) {}
}
