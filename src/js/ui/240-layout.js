// Copy message functions
function copyMessageText(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages[msgIndex]) return;
    var msg = chat.messages[msgIndex];
    navigator.clipboard.writeText(msg.content).then(function() {
        showSnackbar(t('Message copied'), 'success', undefined, { transient: true });
    }).catch(function() {
        // Bug-sweep F3: clipboard write can reject (no focus / permission denied).
        showSnackbar(t('Copy failed'), 'error');
    });
}

function copyAiMessage(userMsgIdx) {
    var chat = chats[currentChatId];
    if (!chat) return;
    
    // Find the range of messages for this response (from userMsgIdx to next user message)
    var nextUserIdx = chat.messages.length;
    for (var i = userMsgIdx + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserIdx = i;
            break;
        }
    }
    
    // Collect all assistant content and tool calls in this range
    var content = [];
    for (var j = userMsgIdx + 1; j < nextUserIdx; j++) {
        var msg = chat.messages[j];
        if (msg.role === 'assistant') {
            if (msg.content) content.push(msg.content);
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                msg.tool_calls.forEach(function(tc) {
                    var toolName = TOOL_DISPLAY_NAMES[tc.function.name] || tc.function.name;
                    content.push('[Tool: ' + toolName + ']\n' + tc.function.arguments);
                });
            }
        }
    }
    
    navigator.clipboard.writeText(content.join('\n\n')).then(function() {
        showSnackbar(t('Response copied'), 'success', undefined, { transient: true });
    }).catch(function() {
        // Bug-sweep F3: clipboard write can reject (no focus / permission denied).
        showSnackbar(t('Copy failed'), 'error');
    });
}

// Toggle API stats display
// A8B-01: both twins (gear #show-api-stats, Settings-page
// #settings-show-api-stats) pass this.checked, so the value follows the box
// that was clicked (no-arg calls keep the flip), and both boxes are synced.
function toggleApiStats(checked) {
    showApiStats = (typeof checked === 'boolean') ? checked : !showApiStats;
    appStorage.setItem('showApiStats', showApiStats);
    syncApiStatsCheckboxes();
    renderMessages();
}
function syncApiStatsCheckboxes() {
    ['show-api-stats', 'settings-show-api-stats'].forEach(function(id) {
        var cb = document.getElementById(id);
        if (cb) cb.checked = showApiStats;
    });
}

// Notifications pill (Silent / Notify / With sound). Default 'notify'. The
// single store is chrome.storage.local.notificationMode because the service
// worker (background.js appagentCreateNotification, the central gate) reads it
// and cannot reach appStorage/IndexedDB. Header pills (#header-notif-mode,
// #home-header-notif-mode, static in body.html between the Active chats pill
// and the gear) are icon-only (state in title + aria-label); clicking opens #notif-mode-menu,
// which reuses the model menu component (.header-menu.model-menu rows, icon,
// check; fixed, end-aligned 4px under the pill) and joins closeAllHeaderMenus /
// syncHeaderMenuExpanded. The Settings page row is a native <select>
// (notificationModeSwitchHtml). All copies stay in sync via
// syncNotificationModeControls.
var NOTIFICATION_MODE_VALUES = ['silent', 'notify', 'sound'];
var NOTIFICATION_MODE_LABELS = { silent: 'Silent', notify: 'Notify', sound: 'With sound' };
var notificationMode = 'notify';
// Extractor markers (build/i18n-extract.js sees N_ literals; tr() is a local alias).
var _NM_I18N_KEYS = typeof N_ === 'function' ? [N_('Silent'), N_('Notify'), N_('With sound'), N_('Blocked by Chrome'),
    N_('Open Chrome settings to allow notifications'), N_('Notifications are blocked by Chrome — click to see how to enable them')] : null;
function _notificationModeStore() {
    return (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
}
function normalizeNotificationMode(d) {
    var m = d && d.notificationMode;
    if (NOTIFICATION_MODE_VALUES.indexOf(m) !== -1) return m;
    if (d && d.approvalSoundEnabled === true) return 'sound';
    return 'notify';
}
// Inline stroke icons (same 24px / stroke 2 / round-cap style as the app's icons).
var NOTIFICATION_MODE_ICONS = {
    silent: '<svg class="notif-mode-icon" data-value="silent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>',
    notify: '<svg class="notif-mode-icon" data-value="notify" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    sound: '<svg class="notif-mode-icon" data-value="sound" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/><path d="M22 8c0-2.3-.8-4.3-2-6"/></svg>'
};
// Bell with an exclamation mark: Chrome blocked the extension's notifications.
var NOTIFICATION_BLOCKED_ICON = '<svg class="notif-mode-icon" data-value="blocked" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M12 7v4"/><path d="M12 14h.01"/></svg>';
var NOTIFICATION_BLOCKED_TITLE = 'Notifications are blocked by Chrome — click to see how to enable them';
var NOTIFICATION_SETTINGS_URL = 'chrome://settings/content/notifications';
// Chrome-level permission for this extension: 'granted' | 'denied' | null
// (unknown = never shown as blocked). Read directly on the page with
// chrome.notifications.getPermissionLevel (extension page + the manifest's
// "notifications" permission; no service-worker round trip needed). Refreshed
// at startup, on window focus / visibilitychange, when the menu opens, and on
// chrome.notifications.onPermissionLevelChanged.
// NOTE: OS-level blocking (macOS Focus / Do Not Disturb, Chrome notifications
// turned off in the OS settings) is NOT detectable here: Chrome still reports
// 'granted', so the pill cannot show it.
var notificationPermissionLevel = null;
function _notificationPermissionApi() {
    var n = (typeof chrome !== 'undefined' && chrome) ? chrome.notifications : null;
    return (n && typeof n.getPermissionLevel === 'function') ? n : null;
}
function isNotificationBlocked() {
    return notificationPermissionLevel === 'denied' && notificationMode !== 'silent';
}
function _setNotificationPermissionLevel(level) {
    level = (level === 'granted' || level === 'denied') ? level : null;
    if (level === notificationPermissionLevel) return;
    notificationPermissionLevel = level;
    syncNotificationModeControls();
}
function refreshNotificationPermission() {
    var api = _notificationPermissionApi();
    if (!api) return;
    try {
        api.getPermissionLevel(function(level) {
            try { void chrome.runtime.lastError; } catch (e) {}
            _setNotificationPermissionLevel(level);
        });
    } catch (e) {}
}
var _notifPermissionWatching = false;
function _watchNotificationPermission() {
    if (_notifPermissionWatching) return;
    _notifPermissionWatching = true;
    var api = _notificationPermissionApi();
    if (api && api.onPermissionLevelChanged && typeof api.onPermissionLevelChanged.addListener === 'function') {
        try { api.onPermissionLevelChanged.addListener(function(level) { _setNotificationPermissionLevel(level); }); } catch (e) {}
    }
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') window.addEventListener('focus', refreshNotificationPermission);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible') refreshNotificationPermission(); });
    }
}
// Blocked row: opens Chrome's notification settings (extension pages may open
// chrome:// URLs via chrome.tabs.create).
function openNotificationPermissionSettings() {
    _closeNotificationModeMenu(true);
    try {
        if (typeof chrome !== 'undefined' && chrome && chrome.tabs && typeof chrome.tabs.create === 'function') chrome.tabs.create({ url: NOTIFICATION_SETTINGS_URL });
    } catch (e) {}
}
// Tooltip on every pill: "Notifications: <state>" (existing i18n keys), or the
// blocked explanation when Chrome denies the permission.
function _notificationModeTitle(tr) {
    tr = typeof tr === 'function' ? tr : (typeof t === 'function' ? t : function(s) { return s; });
    if (isNotificationBlocked()) return tr(NOTIFICATION_BLOCKED_TITLE);
    return tr('Notifications') + ': ' + tr(NOTIFICATION_MODE_LABELS[notificationMode]);
}
function _nmTr() { return typeof t === 'function' ? t : function(s) { return s; }; }
function _nmEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// Settings-page control: a native select kept in sync with the header pills.
function notificationModeSwitchHtml(id, tr) {
    tr = typeof tr === 'function' ? tr : function(s) { return s; };
    var opts = NOTIFICATION_MODE_VALUES.map(function(v) {
        return '<option value="' + v + '"' + (v === notificationMode ? ' selected' : '') + '>' + _nmEsc(tr(NOTIFICATION_MODE_LABELS[v])) + '</option>';
    }).join('');
    return '<select class="notif-mode-select" id="' + id + '" aria-label="' + _nmEsc(tr('Notifications')) + '" onchange="setNotificationMode(this.value)">' + opts + '</select>';
}
var _NM_CHECK_SVG = '<span class="model-row-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></span>';
function _notificationModeMenuRowsHtml(tr) {
    tr = tr || _nmTr();
    var blocked = isNotificationBlocked() ? '<div class="model-menu-row notif-mode-blocked-row" role="menuitem" tabindex="-1" data-value="blocked" onclick="openNotificationPermissionSettings()">' +
            '<span class="model-row-icon">' + NOTIFICATION_BLOCKED_ICON + '</span>' +
            '<span class="model-row-main"><span class="model-row-title">' + _nmEsc(tr('Blocked by Chrome')) + '</span><div class="model-row-sub">' + _nmEsc(tr('Open Chrome settings to allow notifications')) + '</div></span>' +
        '</div>' : '';
    return blocked + NOTIFICATION_MODE_VALUES.map(function(v) {
        var on = v === notificationMode;
        return '<div class="model-menu-row' + (on ? ' selected' : '') + '" role="menuitemradio" aria-checked="' + on + '" tabindex="-1" data-value="' + v + '" onclick="selectNotificationModeFromMenu(\'' + v + '\')">' +
            '<span class="model-row-icon">' + NOTIFICATION_MODE_ICONS[v] + '</span>' +
            '<span class="model-row-main"><span class="model-row-title">' + _nmEsc(tr(NOTIFICATION_MODE_LABELS[v])) + '</span></span>' +
            (on ? _NM_CHECK_SVG : '') +
        '</div>';
    }).join('');
}
function syncNotificationModeControls() {
    if (typeof document === 'undefined') return;
    var tr = _nmTr(), title = _notificationModeTitle(tr), blocked = isNotificationBlocked();
    var iconKey = blocked ? 'blocked' : notificationMode;
    var pills = document.querySelectorAll('.notif-mode-wrap');
    for (var i = 0; i < pills.length; i++) {
        var p = pills[i], prev = p.getAttribute('data-mode');
        p.setAttribute('data-mode', notificationMode);
        p.classList.toggle('notif-mode-blocked', blocked);
        p.setAttribute('title', title);
        p.setAttribute('aria-label', title);
        var slot = p.querySelector('.notif-mode-icon-slot');
        if (slot && slot.getAttribute('data-value') !== iconKey) { slot.innerHTML = blocked ? NOTIFICATION_BLOCKED_ICON : NOTIFICATION_MODE_ICONS[notificationMode]; slot.setAttribute('data-value', iconKey); }
        if (!blocked && prev && prev !== notificationMode && notificationMode === 'sound') {
            // Re-trigger the one-shot bell wiggle (CSS honours prefers-reduced-motion).
            p.classList.remove('notif-mode-ring'); void p.offsetWidth; p.classList.add('notif-mode-ring');
        }
    }
    var sels = document.querySelectorAll('.notif-mode-select');
    for (var j = 0; j < sels.length; j++) sels[j].value = notificationMode;
    var menu = document.getElementById('notif-mode-menu');
    if (menu) menu.innerHTML = _notificationModeMenuRowsHtml(tr);
}
function setNotificationMode(mode) {
    if (NOTIFICATION_MODE_VALUES.indexOf(mode) === -1) return;
    var changed = mode !== notificationMode;
    notificationMode = mode;
    syncNotificationModeControls();
    var store = _notificationModeStore();
    if (store) { try { store.set({ notificationMode: mode }); } catch (e) {} }
    // Preview: one chime when "With sound" is picked (background.js plays it
    // via the offscreen helper without the setting check).
    if (changed && mode === 'sound' && typeof chrome !== 'undefined' && chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
            chrome.runtime.sendMessage({ type: 'preview-notification-sound' }, function() { try { void chrome.runtime.lastError; } catch (e) {} });
        } catch (e) {}
    }
}
// Menu (same lifecycle as toggleModelMenu, ui/160-notifications.js).
var _notifModeMenuAnchor = null;
function _notifModeMenuItems() {
    var m = document.getElementById('notif-mode-menu');
    return m ? Array.prototype.slice.call(m.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')) : [];
}
function _focusNotifModeItem(idx) {
    var items = _notifModeMenuItems();
    if (!items.length) return;
    idx = (idx + items.length) % items.length;
    items.forEach(function(it, k) { it.setAttribute('tabindex', k === idx ? '0' : '-1'); });
    items[idx].focus();
}
function toggleNotificationModeMenu(event, focusItem) {
    if (event) { event.stopPropagation(); if (event.preventDefault) event.preventDefault(); }
    if (document.getElementById('notif-mode-menu')) { _closeNotificationModeMenu(); return; }
    if (typeof closeAllHeaderMenus === 'function') closeAllHeaderMenus('notif');
    var anchor = (event && event.currentTarget && event.currentTarget.classList && event.currentTarget.classList.contains('notif-mode-pill'))
        ? event.currentTarget : (document.getElementById('header-notif-mode') || document.getElementById('home-header-notif-mode'));
    _notifModeMenuAnchor = anchor;
    var menu = document.createElement('div');
    menu.id = 'notif-mode-menu';
    menu.className = 'header-menu model-menu notif-mode-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', _nmTr()('Notifications'));
    menu.innerHTML = _notificationModeMenuRowsHtml();
    menu.addEventListener('keydown', notificationModeMenuKeydown);
    document.body.appendChild(menu);
    if (anchor && anchor.getBoundingClientRect) {
        var r = anchor.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = (r.bottom + 4) + 'px';
        if (typeof i18nDir === 'function' && i18nDir() === 'rtl') menu.style.left = Math.max(8, r.left) + 'px';
        else menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    }
    if (typeof syncHeaderMenuExpanded === 'function') syncHeaderMenuExpanded();
    if (focusItem) _focusNotifModeItem(focusItem === 'last' ? -1 : Math.max(0, NOTIFICATION_MODE_VALUES.indexOf(notificationMode)) + (isNotificationBlocked() ? 1 : 0));
    refreshNotificationPermission();
    setTimeout(function() { document.addEventListener('click', _closeNotificationModeMenuOnOutside); }, 0);
}
function _closeNotificationModeMenuOnOutside(e) {
    var menu = document.getElementById('notif-mode-menu');
    if (menu && !menu.contains(e.target) && !(e.target.closest && e.target.closest('.notif-mode-pill'))) _closeNotificationModeMenu();
}
function _closeNotificationModeMenu(returnFocus) {
    var menu = document.getElementById('notif-mode-menu');
    if (menu) menu.remove();
    document.removeEventListener('click', _closeNotificationModeMenuOnOutside);
    if (typeof syncHeaderMenuExpanded === 'function') syncHeaderMenuExpanded();
    if (returnFocus && _notifModeMenuAnchor && _notifModeMenuAnchor.focus) _notifModeMenuAnchor.focus();
}
function selectNotificationModeFromMenu(mode) {
    setNotificationMode(mode);
    _closeNotificationModeMenu(true);
}
// Pill keys: Enter / Space / ArrowDown open on the current mode, ArrowUp on the
// last item; Esc closes. (Handled here, so the native button click is suppressed.)
function notificationModeKeydown(event) {
    var k = event && event.key;
    if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') {
        event.preventDefault();
        if (document.getElementById('notif-mode-menu')) { if (k === 'Enter' || k === ' ') _closeNotificationModeMenu(); else _focusNotifModeItem(k === 'ArrowUp' ? -1 : 0); return; }
        toggleNotificationModeMenu(event, k === 'ArrowUp' ? 'last' : 'current');
    } else if (k === 'Escape' && document.getElementById('notif-mode-menu')) {
        event.preventDefault(); event.stopPropagation();
        _closeNotificationModeMenu(true);
    }
}
// Menu keys (role=menu): Up/Down move (wrap), Home/End, Enter/Space select,
// Esc closes and returns focus to the pill, Tab closes.
function notificationModeMenuKeydown(event) {
    var k = event.key, items = _notifModeMenuItems();
    var cur = items.indexOf(document.activeElement);
    if (k === 'ArrowDown' || k === 'ArrowUp') { event.preventDefault(); _focusNotifModeItem(cur < 0 ? 0 : cur + (k === 'ArrowDown' ? 1 : -1)); }
    else if (k === 'Home') { event.preventDefault(); _focusNotifModeItem(0); }
    else if (k === 'End') { event.preventDefault(); _focusNotifModeItem(-1); }
    else if (k === 'Enter' || k === ' ') {
        event.preventDefault();
        if (cur < 0) return;
        var v = items[cur].getAttribute('data-value');
        if (v === 'blocked') openNotificationPermissionSettings(); else selectNotificationModeFromMenu(v);
    }
    else if (k === 'Escape') { event.preventDefault(); event.stopPropagation(); _closeNotificationModeMenu(true); }
    else if (k === 'Tab') { _closeNotificationModeMenu(); }
}
// Startup (core/120-init.js): loads the stored mode into the header pills.
function loadNotificationModeSetting() {
    syncNotificationModeControls();
    _watchNotificationPermission();
    refreshNotificationPermission();
    var store = _notificationModeStore();
    if (!store) return;
    try {
        store.get(['notificationMode', 'approvalSoundEnabled'], function(d) {
            notificationMode = normalizeNotificationMode(d);
            syncNotificationModeControls();
        });
    } catch (e) {}
}

// Toggle compact tool calls display
function toggleCompactToolCalls() {
    compactToolCalls = !compactToolCalls;
    appStorage.setItem('compactToolCalls', compactToolCalls);
    renderMessages();
}

// Change screenshot method
function setScreenshotMethod(value) {
    screenshotMethod = value;
    appStorage.setItem('screenshotMethod', value);
}

// Apply the current theme to the document
function applyTheme() {
    var effectiveTheme = appTheme;
    if (effectiveTheme === 'system') {
        effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    broadcastWidgetTheme(effectiveTheme);
}

// Push the active theme into every live widget iframe. Widgets render inside
// widget-sandbox.html — a separate document that gets none of our CSS — so the
// design tokens injected by injectWidgetTokens (ui/070-dashboard-ui.js) switch on
// <html data-appagent-theme>. This message flips that attribute IN PLACE: no
// re-render, so widget state (counters, fetched data, scroll) survives a theme
// change. Mirrors the iframe enumeration in _isWidgetSource
// (ui/070-dashboard-ui.js): chat/inline widgets sit in the light DOM, dashboard
// tiles inside .widget-shadow-host shadow roots. applyTheme also runs at startup
// (core/120-init.js) when there are zero widgets, so every step is guarded and an
// empty document is a silent no-op.
function broadcastWidgetTheme(theme) {
    var msg = { type: 'themeChange', theme: theme === 'dark' ? 'dark' : 'light' };
    function postAll(frames) {
        for (var i = 0; i < frames.length; i++) {
            try {
                if (frames[i].contentWindow) frames[i].contentWindow.postMessage(msg, '*');
            } catch (e) { /* cross-origin or torn-down iframe */ }
        }
    }
    try {
        postAll(document.querySelectorAll('iframe.widget-iframe'));
        var hosts = document.querySelectorAll('.widget-shadow-host');
        for (var h = 0; h < hosts.length; h++) {
            if (hosts[h].shadowRoot) postAll(hosts[h].shadowRoot.querySelectorAll('iframe.widget-iframe'));
        }
    } catch (e) { /* never let a theme switch break on widget plumbing */ }
}

// Change theme setting
function setAppTheme(value) {
    appTheme = value;
    appStorage.setItem('appTheme', value);
    applyTheme();
}

// Mutual exclusion for the header pill dropdowns: gear settings panel, model
// menu, jobs dropdown, workspace dropdown, usage (credits pill) dropdown and
// the ServiceNow instance picker. Every toggle calls this with its own name
// before opening, so opening any one closes all the others.
// NOTE: hideInstancePicker lives in platform-bridge.js (extension-only IIFE)
// and is exposed on window there; the typeof guards keep every closer optional.
function closeAllHeaderMenus(except) {
    if (except !== 'settings' && typeof closeSettingsPanel === 'function') closeSettingsPanel();
    if (except !== 'model' && typeof _closeModelMenu === 'function') _closeModelMenu();
    if (except !== 'jobs' && typeof closeJobsDropdown === 'function') closeJobsDropdown();
    if (except !== 'workspace' && typeof hideWorkspaceDropdown === 'function') hideWorkspaceDropdown();
    if (except !== 'usage' && typeof hideUsageTooltipNow === 'function') hideUsageTooltipNow();
    if (except !== 'instances' && typeof window.hideInstancePicker === 'function') window.hideInstancePicker();
    if (except !== 'notif' && typeof _closeNotificationModeMenu === 'function') _closeNotificationModeMenu();
    if (typeof syncHeaderMenuExpanded === 'function') syncHeaderMenuExpanded();
}

// A11y: mirror each header menu's open state onto its trigger(s) as
// aria-expanded (the triggers carry aria-haspopup in body.html). Reads the DOM,
// so any open/close path can call it: gear panel (.visible), model menu
// (#model-menu exists), workspace dropdown (_wsDropdown), jobs (display:block).
function syncHeaderMenuExpanded() {
    function set(sel, open) {
        document.querySelectorAll(sel).forEach(function(el) { el.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    }
    var panel = document.getElementById('settings-panel');
    set('.settings-btn', !!(panel && panel.classList.contains('visible')));
    set('#model-name, #home-model-name', !!document.getElementById('model-menu'));
    set('#ws-header-status, #home-ws-header-status', typeof _wsDropdown !== 'undefined' && !!_wsDropdown);
    set('.notif-mode-pill', !!document.getElementById('notif-mode-menu'));
    document.querySelectorAll('.jobs-badge').forEach(function(b) {
        var w = b.closest('.jobs-badge-wrapper');
        var dd = w && w.querySelector('.jobs-dropdown');
        b.setAttribute('aria-expanded', dd && dd.style.display === 'block' ? 'true' : 'false');
    });
}

// Gear-dropdown theme toggle — same mechanism as the settings page
// (setAppTheme persists appTheme); this just refreshes the segmented control.
function setAppThemeFromPanel(value) {
    setAppTheme(value);
    syncSettingsPanelTheme();
}

// Reflect the persisted appTheme onto the gear-dropdown radio group
// (#settings-panel-theme in body.html). Called on panel open so the control
// stays in sync with changes made from the settings page.
function syncSettingsPanelTheme() {
    var group = document.getElementById('settings-panel-theme');
    if (!group) return;
    group.querySelectorAll('.radio-option').forEach(function(o) {
        var on = o.getAttribute('data-value') === appTheme;
        o.classList.toggle('selected', on);
        o.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    // APG radiogroup: roving tabindex, so Tab stops only on the checked radio
    // (the first one when nothing is checked); arrows move between them.
    var opts = group.querySelectorAll('.radio-option');
    var sel = group.querySelector('.radio-option.selected') || opts[0];
    opts.forEach(function(o) { o.setAttribute('tabindex', o === sel ? '0' : '-1'); });
}

// Arrow keys on #settings-panel-theme move focus AND selection (APG radiogroup);
// Enter/Space stay on each radio's own onkeydown. kbdRadioNextIndex: ui/320.
function settingsPanelThemeKeydown(e) {
    if (!e || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var group = document.getElementById('settings-panel-theme');
    if (!group || typeof kbdRadioNextIndex !== 'function') return;
    var opts = Array.prototype.slice.call(group.querySelectorAll('.radio-option'));
    var cur = opts.indexOf(e.target && e.target.closest ? e.target.closest('.radio-option') : null);
    if (cur < 0) return;
    var rtl = typeof i18nDir === 'function' && i18nDir() === 'rtl';
    var next = kbdRadioNextIndex(opts.length, cur, e.key, rtl);
    if (next < 0) return;
    e.preventDefault();
    setAppThemeFromPanel(opts[next].getAttribute('data-value'));
    opts[next].focus();
}

// Listen for OS theme changes (only matters when set to 'system')
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
    if (appTheme === 'system') applyTheme();
});

// Estimate token count (rough approximation: ~4 chars per token)
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

// Calculate current system prompt token count (includes tools and skills)
// MEMORY: the tool list JSON is large (hundreds of KB with skill tools) and
// was re-serialized on every home render. Its length is memoized on a cheap
// signature (tool count + names) and recomputed only when the tool set changes.
var _toolsJsonLenCache = { sig: null, len: 0 };
function _getToolsJsonLength(tools) {
    tools = tools || [];
    var names = [];
    for (var i = 0; i < tools.length; i++) {
        var fn = tools[i] && tools[i].function;
        names.push(fn && fn.name ? fn.name : (tools[i] && tools[i].name) || '');
    }
    var sig = tools.length + ':' + names.join(',');
    if (_toolsJsonLenCache.sig !== sig) {
        _toolsJsonLenCache = { sig: sig, len: JSON.stringify(tools).length };
    }
    return _toolsJsonLenCache.len;
}

function getSystemPromptTokenCount() {
    var systemPrompt = getSystemPromptWithContext() || '';
    var totalLen = systemPrompt.length + _getToolsJsonLength(getEnabledTools());
    return totalLen > 0 ? Math.ceil(totalLen / 4) : 0;
}

// Context % above which the ring expands into the labeled
// "Continue in a new chat" pill (strictly greater than).
var CONTEXT_CONTINUE_THRESHOLD = 50;

// Update context usage indicator using actual token count from API metrics
function updateContextIndicator() {
    var indicator = document.getElementById('context-indicator');
    var fill = document.getElementById('context-fill');
    if (!indicator || !fill) return;

    // Get last known input_tokens from most recent assistant message with metrics (skip aggregate totals)
    var totalTokens = 0;
    var chat = chats[currentChatId];
    if (chat && chat.messages) {
        for (var i = chat.messages.length - 1; i >= 0; i--) {
            var m = chat.messages[i];
            // Skip aggregate metrics (Total X calls) - we want the last individual call
            if (m.role === 'assistant' && m.metrics && m.metrics.input_tokens && !m.metrics.isAggregate) {
                totalTokens = m.metrics.input_tokens;
                break;
            }
        }
    }

    // Fall back to the per-call estimate the agent loop stores on the chat
    // row (app/030-agent-loop.js) — covers chats whose metrics rows were
    // trimmed but whose _ctxTokens survived the last run.
    if (!totalTokens && chat && typeof chat._ctxTokens === 'number') {
        totalTokens = chat._ctxTokens;
    }

    // Fixed assumed context window for ALL models — user-editable global
    // setting, default 200k (getAssumedContextTokens in core/030-config.js).
    // Per-model windows are no longer tracked.
    var contextLimit = (typeof getAssumedContextTokens === 'function') ? getAssumedContextTokens() : 200000;

    // Item 8: the unsent draft counts toward the next request.
    var draftInput = document.getElementById('message-input');
    var draftTokens = (typeof composerDraftTokens === 'function' && draftInput) ? composerDraftTokens(draftInput.value) : 0;
    totalTokens += draftTokens;

    // Hide indicator if tokens < 10k (for new/empty chats)
    if (totalTokens < 10000) {
        indicator.style.display = 'none';
        return;
    }

    // Show indicator when >= 10k tokens
    indicator.style.display = 'flex';

    var percentage = Math.min(100, Math.round((totalTokens / contextLimit) * 100));
    fill.setAttribute('stroke-dasharray', percentage + ', 100');
    indicator.setAttribute('data-percentage', percentage);

    // Set warning/danger classes
    indicator.className = 'context-indicator';
    if (percentage >= 90) indicator.classList.add('danger');
    else if (percentage >= 70) indicator.classList.add('warning');

    // Past CONTEXT_CONTINUE_THRESHOLD % the icon-only ring grows into a labeled
    // "Continue in a new chat" pill (same click/Enter/Space handler →
    // summarizeAndStartNewChat). At or below it: ring only, as before.
    var showContinue = percentage > CONTEXT_CONTINUE_THRESHOLD;
    var label = document.getElementById('context-label');
    var continueText = t('Continue in a new chat');
    if (showContinue) indicator.classList.add('continue-cta');
    if (label) {
        label.textContent = showContinue ? continueText : '';
        label.hidden = !showContinue;
    }
    // Pill mode shows the % as plain text (no hover overlay) and, on narrow
    // widths, a short "New chat" label instead of the full one (CSS swaps them).
    var pct = document.getElementById('context-pct');
    if (pct) {
        pct.textContent = showContinue ? percentage + '%' : '';
        pct.hidden = !showContinue;
    }
    var shortLabel = document.getElementById('context-label-short');
    if (shortLabel) {
        shortLabel.textContent = showContinue ? t('New chat') : '';
        shortLabel.hidden = !showContinue;
    }
    indicator.setAttribute('aria-label', showContinue ? continueText : t('Summarize and start new chat'));

    // Show percentage and token count in tooltip
    var tokenDisplay = totalTokens >= 1000 ? Math.round(totalTokens / 1000) + 'k' : totalTokens;
    if (draftTokens > 0) {
        var draftDisplay = draftTokens >= 1000 ? Math.round(draftTokens / 1000) + 'k' : draftTokens;
        indicator.title = t('{percent}% context used ({tokens} tokens, incl. ~{draft} in draft)', { percent: percentage, tokens: tokenDisplay, draft: draftDisplay });
    } else {
        indicator.title = t('{percent}% context used ({tokens} tokens)', { percent: percentage, tokens: tokenDisplay });
    }
}

// Re-fit a composer when its WIDTH changes (panel resize, sidebar toggle):
// one ResizeObserver, rAF-throttled per textarea. Textareas are observed lazily
// on their first autoResizeTextarea call, so a re-rendered home composer is
// picked up too.
var _composerResizeObserver = null;
var _composerObserved = (typeof WeakSet === 'function') ? new WeakSet() : null;
function _observeComposerWidth(textarea) {
    if (!_composerObserved || typeof ResizeObserver !== 'function' || _composerObserved.has(textarea)) return;
    if (!_composerResizeObserver) {
        _composerResizeObserver = new ResizeObserver(function(entries) {
            entries.forEach(function(entry) {
                var el = entry.target;
                // A re-rendered home composer leaves its old textarea detached:
                // stop observing it instead of keeping it alive in the observer.
                if (!el.isConnected) {
                    _composerResizeObserver.unobserve(el);
                    if (_composerObserved) _composerObserved.delete(el);
                    return;
                }
                var w = entry.contentRect ? entry.contentRect.width : el.clientWidth;
                if (el._autoResizeWidth === w) return;
                el._autoResizeWidth = w;
                if (el._autoResizeRaf) return;
                el._autoResizeRaf = requestAnimationFrame(function() {
                    el._autoResizeRaf = 0;
                    if (el.isConnected) autoResizeTextarea(el);
                });
            });
        });
    }
    _composerObserved.add(textarea);
    _composerResizeObserver.observe(textarea);
}

// Auto-resize textarea. ONE cap: the CSS max-height (06-input.css,
// min(40vh, 320px)) is read here instead of a hard-coded JS limit.
function autoResizeTextarea(textarea) {
    if (!textarea) return;
    _observeComposerWidth(textarea);
    var cs = (typeof getComputedStyle === 'function') ? getComputedStyle(textarea) : null;
    var cap = cs ? parseFloat(cs.maxHeight) : NaN;
    var prevScroll = textarea.scrollTop;
    textarea.style.height = 'auto';
    var full = textarea.scrollHeight;
    var capped = isFinite(cap) && cap > 0 && full > cap;
    textarea.style.height = (capped ? cap : full) + 'px';
    if (capped) {
        // At the cap the box scrolls: keep the caret visible. Typing at the end
        // follows the bottom; otherwise keep the previous scroll position.
        var atEnd = textarea.selectionEnd === textarea.value.length;
        textarea.scrollTop = atEnd ? textarea.scrollHeight : prevScroll;
    }
    if (typeof syncSendButton === 'function') syncSendButton();
    // Item 8: draft-size hint + (debounced) context ring, ui/246-composer.js.
    if (typeof composerSyncDraftSize === 'function') composerSyncDraftSize(textarea);
}

// Trigger resize on all widget iframes
function resizeAllWidgets() {
    if (window.__widgetResizeFns) {
        window.__widgetResizeFns.forEach(function(fn) {
            setTimeout(fn, 50);
            setTimeout(fn, 350);
        });
    }
}

// Toggle sidebar
function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    appStorage.setItem('sidebarCollapsed', sidebarCollapsed ? 'true' : 'false');
    var sidebar = document.getElementById('sidebar');
    if (sidebarCollapsed) {
        sidebar.classList.remove('expanded');
    } else {
        sidebar.classList.add('expanded');
        // Refresh the chat list on expand. While collapsed the list is
        // display:none (.sidebar:not(.expanded) .chat-list, 02-layout.css) and
        // only event-driven renderChatList() calls keep it current — any state
        // change that missed an event (or a programmatic toggle right after a
        // mutation) would surface a stale list the moment it becomes visible.
        // Collapse needs no render: the list is hidden anyway.
        if (typeof renderChatList === 'function') renderChatList();
    }
    updateSidebarToggleIcon();
    updateMobileSidebarOverlay();
    resizeAllWidgets();
}

// Manage clickable overlay for mobile sidebar
function updateMobileSidebarOverlay() {
    var existing = document.getElementById('sidebar-overlay');
    if (!sidebarCollapsed && window.innerWidth <= 480) {
        if (!existing) {
            var overlay = document.createElement('div');
            overlay.id = 'sidebar-overlay';
            overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:999;background:var(--bg-overlay);';
            overlay.onclick = function() { toggleSidebar(); };
            document.body.appendChild(overlay);
        }
    } else if (existing) {
        existing.remove();
    }
}

// Update sidebar toggle button icon based on collapsed state
function updateSidebarToggleIcon() {
    var btn = document.getElementById('sidebar-toggle-btn');
    if (btn) {
        if (sidebarCollapsed) {
            btn.innerHTML = UI_ICONS.panelLeftOpen;
            btn.title = t('Expand sidebar') + (typeof kbdHintSuffix === 'function' ? kbdHintSuffix('sidebar') : '');
        } else {
            btn.innerHTML = UI_ICONS.panelLeftClose;
            btn.title = t('Collapse sidebar') + (typeof kbdHintSuffix === 'function' ? kbdHintSuffix('sidebar') : '');
        }
    }
}

// Toggle history section expand/collapse
function toggleHistorySection() {
    historyExpanded = !historyExpanded;
    appStorage.setItem('historyExpanded', historyExpanded ? 'true' : 'false');
    var chatList = document.getElementById('chat-list');
    var historyBtn = document.getElementById('history-toggle-btn');
    if (chatList) {
        if (historyExpanded) {
            chatList.classList.remove('collapsed');
        } else {
            chatList.classList.add('collapsed');
        }
    }
    if (historyBtn) {
        if (historyExpanded) {
            historyBtn.classList.add('expanded');
        } else {
            historyBtn.classList.remove('expanded');
        }
    }
}

// Update input position based on messages
function updateInputPosition() {
    var chat = chats[currentChatId];
    var inputArea = document.getElementById('input-area');
    var messages = document.getElementById('messages');
    if (!inputArea || !messages) return;

    // C2-ui MSG-EVICT: an evicted skeleton has no `messages` array (core/130);
    // chatMessageCount reads its stamped _msgCount, so a skeleton is laid out
    // like the non-empty chat it is instead of throwing here.
    var _ipCount = (typeof chatMessageCount === 'function') ? chatMessageCount(chat)
        : ((chat && Array.isArray(chat.messages)) ? chat.messages.length : 0);
    if (!chat || _ipCount === 0) {
        inputArea.classList.add('centered');
        messages.classList.add('centered');
    } else {
        inputArea.classList.remove('centered');
        messages.classList.remove('centered');
    }
}

function showSpinner(text, chatId, opts) {
    // In compact mode, skip the spinner - the collapsible area shows status
    if (compactToolCalls) return;
    // Skip spinner while the TARGET chat's silent after-response hook runs.
    // Per-chat (tools/120-actions.js _silentHookChats): a background chat's
    // hook must not suppress the foreground chat's spinner — the old global
    // flag hid the visible chat's "Thinking…" whenever ANY chat ran its
    // hidden title/tldr/links turn.
    var _spTarget = chatId || currentChatId;
    if (typeof _isChatInSilentHook === 'function' && _isChatInSilentHook(_spTarget)) return;
    // Per-chat scoping: callers running in a background chat (chatId !== currentChatId)
    // must NOT inject their spinner into the foreground container. Without this guard,
    // a background `runAgent` calling showSpinner('Waiting for response...') would
    // overwrite the foreground chat's spinner text every loop iteration.
    if (chatId && chatId !== currentChatId) return;
    var container = document.getElementById('messages');
    // ACTIVITY: opts (from app/036-agent-event-handlers-page.js) picks the
    // leading glyph — {phase:'tool', tool:'<raw name>'} shows that tool's icon
    // (getToolIcon), {phase:'thinking'} shows the pulsing thinking icon. Every
    // other caller (downloads, reverts, … pass no opts) keeps the generic
    // spinner circle exactly as before.
    var glyph = '<div class="spinner"></div>';
    if (opts && opts.phase === 'tool' && opts.tool && typeof getToolIcon === 'function') {
        glyph = '<span class="spinner-activity spinner-activity-tool" aria-hidden="true">' + getToolIcon(opts.tool) + '</span>';
    } else if (opts && opts.phase === 'thinking' && typeof UI_ICONS !== 'undefined' && UI_ICONS.thinking) {
        glyph = '<span class="spinner-activity spinner-activity-thinking" aria-hidden="true">' + UI_ICONS.thinking + '</span>';
    }
    var spinnerHtml = '<div class="spinner-container" id="loading-spinner">' +
        glyph +
        '<span class="spinner-text">' + escapeHtml(text || t('Thinking...')) + '</span>' +
        '</div>';
    hideSpinner();
    container.insertAdjacentHTML('beforeend', spinnerHtml);
    scrollToBottomIfAllowed();
}

function hideSpinner(chatId) {
    // Per-chat scoping (dual of showSpinner): a background `runAgent` finishing a
    // tool call must NOT clear the foreground chat's spinner. Without this guard,
    // the foreground spinner flickers off every time a background chat returns from
    // a tool / hits a paused-exit / errors out. Foreground callers (legacy UI in
    // 24/25/26/27) omit chatId and behave as before.
    if (chatId && chatId !== currentChatId) return;
    var spinner = document.getElementById('loading-spinner');
    if (spinner) spinner.remove();
}
