// Widget Library: alternate view of the dashboard page that lists EVERY saved
// widget (WidgetStore.list(), pinned or not) as lazily rendered, scaled-down
// thumbnails in a rows or gallery layout. Both the page mode (dashboard vs
// library) and the layout persist in appStorage so the page reopens where the
// user left it. Nothing here runs at load time: renderDashboard('main')
// (ui/060-docs-view.js) calls syncDashboardPageMode() and everything else is
// user-driven, so calls into ui/070-dashboard-ui.js and tools/080-widget-tools.js
// (which load after this file) are safe at runtime.
var WIDGET_LIBRARY_MODE_KEY = 'dashboardPageMode';     // 'dashboard' | 'library'
var WIDGET_LIBRARY_LAYOUT_KEY = 'widgetLibraryLayout'; // 'rows' | 'gallery'
var WIDGET_LIBRARY_GRID_ICON = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
var widgetLibraryState = { query: '', observer: null, bound: null, searchTimer: null };

function getDashboardPageMode() {
    // Standalone dashboard tab has no toolbar to switch back with — always grid.
    if (document.body.classList.contains('standalone-dashboard')) return 'dashboard';
    return appStorage.getItem(WIDGET_LIBRARY_MODE_KEY) === 'library' ? 'library' : 'dashboard';
}
function getWidgetLibraryLayout() {
    return appStorage.getItem(WIDGET_LIBRARY_LAYOUT_KEY) === 'gallery' ? 'gallery' : 'rows';
}

// Called by renderDashboard('main') before it renders the grid. Shows the
// grid or the library from the persisted mode and returns true when the
// library owns the page (the caller then skips the grid render; switching
// back re-renders the grid, so pin/delete changes made here are reflected).
function syncDashboardPageMode() {
    var grid = document.getElementById('dashboard-grid');
    var lib = document.getElementById('widget-library');
    if (!grid || !lib) return false;
    var mode = getDashboardPageMode();
    var library = mode === 'library';
    grid.style.display = library ? 'none' : '';
    lib.style.display = library ? 'flex' : 'none';
    // Library search/toggle only apply in "All widgets" mode; the empty slot still spaces the toolbar.
    var slot = document.getElementById('dashboard-toolbar-slot');
    if (slot) slot.classList.toggle('slot-idle', !library);
    document.querySelectorAll('#dashboard-actions .dashboard-mode-btn').forEach(function(btn) {
        var on = btn.dataset.mode === mode;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (library) renderWidgetLibrary();
    else teardownWidgetLibraryThumbs();
    return library;
}

function setDashboardPageMode(mode) {
    appStorage.setItem(WIDGET_LIBRARY_MODE_KEY, mode === 'library' ? 'library' : 'dashboard');
    // renderDashboard consults syncDashboardPageMode() itself: one call either
    // shows + renders the grid, or shows + renders the library.
    if (typeof renderDashboard === 'function') renderDashboard('main');
}

function setWidgetLibraryLayout(layout) {
    appStorage.setItem(WIDGET_LIBRARY_LAYOUT_KEY, layout === 'gallery' ? 'gallery' : 'rows');
    renderWidgetLibrary();
}

// ---- data ----
function widgetLibraryEntry(id) {
    var v = WidgetStore.view(id);
    if (!v) return null;
    var versions = WidgetStore.versions(id);
    var last = versions.length ? versions[versions.length - 1] : null;
    var placement = (typeof dashboardWidgets !== 'undefined') ? dashboardWidgets[id] : null;
    return {
        id: id,
        title: v.title || 'Widget',
        chatId: v.chatId || null,
        latestVersion: v.latestVersion || (last ? last.version : 1),
        versionCount: versions.length,
        createdAt: (last && last.createdAt) || v.createdAt || 0,
        pinned: placement ? widgetDashboardOf(placement) : null
    };
}

function widgetLibraryEntries() {
    var q = widgetLibraryState.query;
    return WidgetStore.list()
        .map(function(w) { return widgetLibraryEntry(w.id); })
        .filter(function(e) { return e && (!q || e.title.toLowerCase().indexOf(q) !== -1); })
        .sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
}

function widgetLibraryRelativeTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + 'd ago';
    return new Date(ts).toLocaleDateString();
}

function onWidgetLibraryKeydown(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('widget-library-thumb')) {
        e.preventDefault();
        onWidgetLibraryClick(e);
    }
}

// ---- rendering ----
function renderWidgetLibrary() {
    var lib = document.getElementById('widget-library');
    if (!lib) return;
    // Search/count/layout sit in the dashboard page toolbar slot, next to the
    // page actions (ui/045-page-layout.js); fall back to the library itself.
    var slot = typeof pageLayoutToggleHtml === 'function' ? document.getElementById('dashboard-toolbar-slot') : null;
    var host = slot || lib;
    if (slot && !slot.querySelector('.widget-library-header')) {
        widgetLibraryState.bound = null;
        slot.innerHTML = '<div class="widget-library-header">' +
            '<label class="widget-library-search">' + UI_ICONS.search +
                '<input type="search" class="widget-library-search-input" placeholder="Search widgets\u2026" aria-label="Search widgets">' +
            '</label>' +
            '<span class="widget-library-count" id="widget-library-count"></span>' +
            pageLayoutToggleHtml('setWidgetLibraryLayout') +
        '</div>';
    }
    if (slot && !document.getElementById('widget-library-items')) {
        lib.innerHTML = '<div class="widget-library-items" id="widget-library-items"></div>';
    }
    if (!host.querySelector('.widget-library-header')) {
        widgetLibraryState.bound = null; // header rebuilt → child listeners must be re-bound
        lib.innerHTML = '<div class="widget-library-header">' +
            '<label class="widget-library-search">' + UI_ICONS.search +
                '<input type="search" class="widget-library-search-input" placeholder="Search widgets\u2026" aria-label="Search widgets">' +
            '</label>' +
            '<span class="widget-library-count" id="widget-library-count"></span>' +
            '<div class="segmented-toggle widget-library-layout" role="group" aria-label="Layout">' +
                '<button type="button" class="widget-library-layout-btn" data-layout="rows" title="Rows">' + UI_ICONS.list + '<span>Rows</span></button>' +
                '<button type="button" class="widget-library-layout-btn" data-layout="gallery" title="Gallery">' + WIDGET_LIBRARY_GRID_ICON + '<span>Gallery</span></button>' +
            '</div>' +
        '</div>' +
        '<div class="widget-library-items" id="widget-library-items"></div>';
    }
    // `bound` is the element the listeners were attached to, not a boolean:
    // a re-created #widget-library (or a rebuilt header) must be re-bound.
    if (widgetLibraryState.bound !== lib) {
        widgetLibraryState.bound = lib;
        // Debounced like the chat search (ui/180-search.js, 250ms): every
        // render tears down and re-mounts thumbnail iframes, so per-keystroke
        // rendering thrashed the library on long queries.
        host.querySelector('.widget-library-search-input').addEventListener('input', function(e) {
            var value = (e.target.value || '').trim().toLowerCase();
            if (widgetLibraryState.searchTimer) clearTimeout(widgetLibraryState.searchTimer);
            widgetLibraryState.searchTimer = setTimeout(function() {
                widgetLibraryState.searchTimer = null;
                widgetLibraryState.query = value;
                renderWidgetLibraryItems();
            }, 250);
        });
        if (!slot) lib.querySelectorAll('.widget-library-layout-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { setWidgetLibraryLayout(btn.dataset.layout); });
        });
        // Named references: re-binding the SAME element after a header rebuild
        // must not stack a second click/keydown listener (addEventListener
        // dedupes identical function references, not fresh closures).
        lib.addEventListener('click', onWidgetLibraryClick);
        lib.addEventListener('keydown', onWidgetLibraryKeydown);
    }
    var layout = getWidgetLibraryLayout();
    host.querySelectorAll('.widget-library-layout-btn').forEach(function(btn) {
        var on = btn.dataset.layout === layout;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var input = host.querySelector('.widget-library-search-input');
    if (input && input.value.trim().toLowerCase() !== widgetLibraryState.query) input.value = widgetLibraryState.query;
    renderWidgetLibraryItems();
}

function renderWidgetLibraryItems() {
    var list = document.getElementById('widget-library-items');
    if (!list) return;
    teardownWidgetLibraryThumbs();
    var layout = getWidgetLibraryLayout();
    list.className = 'widget-library-items layout-' + layout;
    var entries = widgetLibraryEntries();
    var total = WidgetStore.list().length;
    var count = document.getElementById('widget-library-count');
    if (count) count.textContent = widgetLibraryState.query ? entries.length + ' of ' + total : total + (total === 1 ? ' widget' : ' widgets');
    if (!entries.length) {
        list.innerHTML = '<div class="widget-library-empty">' + UI_ICONS.widget +
            (total === 0
                ? '<p>No saved widgets yet</p><p class="widget-library-empty-hint">Widgets created in any chat show up here, pinned or not.</p>'
                : '<p>No widgets match \u201c' + escapeHtml(widgetLibraryState.query) + '\u201d</p>') +
            '</div>';
        return;
    }
    list.innerHTML = entries.map(buildWidgetLibraryItem).join('');
    // Lazy thumbnails: only widgets scrolled (near) into view get an iframe.
    var observer = widgetLibraryState.observer = new IntersectionObserver(function(hits) {
        hits.forEach(function(hit) {
            if (!hit.isIntersecting) return;
            observer.unobserve(hit.target);
            renderWidgetLibraryThumb(hit.target);
        });
    }, { root: list, rootMargin: '200px' });
    list.querySelectorAll('.widget-library-thumb').forEach(function(t) { observer.observe(t); });
}

function widgetLibraryPinBadgeHtml(e) {
    var label = e.pinned === 'home' ? 'Home' : (e.pinned === 'main' ? 'Main' : 'Not pinned');
    return '<span class="widget-library-badge pin-badge' + (e.pinned ? ' pinned' : '') + '">' + (e.pinned ? UI_ICONS.pinFilled : UI_ICONS.pin) + label + '</span>';
}
function widgetLibraryPinBtnHtml(e) {
    return '<button type="button" class="widget-library-btn widget-library-pin-btn' + (e.pinned ? ' on-dashboard' : '') + '" data-action="pin" title="' + (e.pinned ? 'Pinned \u2014 click to change' : 'Pin to dashboard\u2026') + '">' + (e.pinned ? UI_ICONS.pinFilled : UI_ICONS.pin) + '<span>Pin \u25be</span></button>';
}

function buildWidgetLibraryItem(e) {
    var chat = e.chatId && typeof chats !== 'undefined' ? chats[e.chatId] : null;
    var chatTitle = chat ? (chat.title || 'Untitled Chat') : 'Unknown chat';
    var when = e.createdAt ? new Date(e.createdAt).toLocaleString() : '';
    return '<div class="widget-library-item" data-widget-id="' + escapeHtml(e.id) + '">' +
        '<div class="widget-library-thumb" data-action="open" role="button" tabindex="0" title="Open ' + escapeHtml(e.title) + '">' +
            '<div class="widget-library-thumb-placeholder">' + UI_ICONS.widget + '</div>' +
            '<div class="widget-library-overlay">' +
                '<button type="button" class="widget-library-btn" data-action="open">' + UI_ICONS.maximize + '<span>Open</span></button>' +
                widgetLibraryPinBtnHtml(e) +
            '</div>' +
        '</div>' +
        '<div class="widget-library-info">' +
            '<div class="widget-library-title" title="' + escapeHtml(e.title) + '">' + escapeHtml(e.title) + '</div>' +
            '<div class="widget-library-meta">' + widgetLibraryPinBadgeHtml(e) +
                '<span class="widget-library-badge version-badge">v' + e.latestVersion + '</span>' +
                '<span class="widget-library-date" title="' + escapeHtml(when) + '">' + widgetLibraryRelativeTime(e.createdAt) + '</span>' +
            '</div>' +
            '<div class="widget-library-chat" title="' + escapeHtml(chatTitle) + '">' + UI_ICONS.chat + '<span>' + escapeHtml(chatTitle) + '</span></div>' +
        '</div>' +
        '<div class="widget-library-actions">' +
            '<button type="button" class="widget-library-btn" data-action="open" title="Open fullscreen">' + UI_ICONS.maximize + '<span>Open</span></button>' +
            '<button type="button" class="widget-library-btn" data-action="newtab" title="Open in new tab">' + UI_ICONS.externalLink + '</button>' +
            widgetLibraryPinBtnHtml(e) +
            '<button type="button" class="widget-library-btn" data-action="chat" title="Go to source chat"' + (chat ? '' : ' disabled') + '>' + UI_ICONS.chat + '<span>Chat</span></button>' +
            '<button type="button" class="widget-library-btn" data-action="agent" title="Edit with agent">' + UI_ICONS.edit + '<span>Edit</span></button>' +
            '<button type="button" class="widget-library-btn" data-action="code" title="Edit code">' + UI_ICONS.code + '</button>' +
            '<button type="button" class="widget-library-btn version-count" data-action="versions" title="Versions (opens fullscreen with the version picker)">' + UI_ICONS.history + '<span>' + e.versionCount + '</span></button>' +
            '<button type="button" class="widget-library-btn danger" data-action="delete" title="Delete widget">' + UI_ICONS.trash + '</button>' +
        '</div>' +
    '</div>';
}

// Reuses the chat thumbnail path: renderWidgetInContainer (tools/080-widget-tools.js)
// treats a .widget-library-thumb container like .widgets-container — scaled
// iframe (transform:scale(.4), 250% box, no height reporter) through the
// injectWidgetBridge -> writeWidgetHtml -> injectWidgetTokens chain.
function renderWidgetLibraryThumb(thumbEl) {
    if (thumbEl.dataset.rendered) return;
    var item = thumbEl.closest('.widget-library-item');
    var widget = item ? WidgetStore.view(item.dataset.widgetId) : null;
    if (!widget) return;
    thumbEl.dataset.rendered = '1';
    var placeholder = thumbEl.querySelector('.widget-library-thumb-placeholder');
    if (placeholder) placeholder.remove();
    var iframe = renderWidgetInContainer(widget, thumbEl);
    if (iframe) { iframe.setAttribute('tabindex', '-1'); iframe.setAttribute('aria-hidden', 'true'); }
}

function teardownWidgetLibraryThumbs() {
    if (widgetLibraryState.observer) { widgetLibraryState.observer.disconnect(); widgetLibraryState.observer = null; }
    var list = document.getElementById('widget-library-items');
    if (!list) return;
    list.querySelectorAll('.widget-library-thumb iframe').forEach(function(f) {
        if (f.__widgetCleanup) { try { f.__widgetCleanup(); } catch (e) {} }
        if (f.__versionPicker) f.__versionPicker.remove();
        f.remove();
    });
}

// In-place refresh of one row/card (pin badge + pin buttons + title/version).
// Hooked from updateWidgetPinButtons (ui/070-dashboard-ui.js) and
// WidgetStore.project / remove (core/135-widget-store.js). A widget that is
// new to the list, or gone, triggers a full item re-render instead.
function refreshWidgetLibraryEntry(widgetId) {
    var lib = document.getElementById('widget-library');
    if (!lib || lib.style.display === 'none') return;
    var list = document.getElementById('widget-library-items');
    var item = list ? list.querySelector('.widget-library-item[data-widget-id="' + widgetId + '"]') : null;
    var e = widgetLibraryEntry(widgetId);
    if (!item || !e) { renderWidgetLibraryItems(); return; }
    item.querySelectorAll('.pin-badge').forEach(function(b) { b.outerHTML = widgetLibraryPinBadgeHtml(e); });
    item.querySelectorAll('.widget-library-pin-btn').forEach(function(b) { b.outerHTML = widgetLibraryPinBtnHtml(e); });
    var title = item.querySelector('.widget-library-title');
    if (title) { title.textContent = e.title; title.title = e.title; }
    var ver = item.querySelector('.version-badge');
    if (ver) ver.textContent = 'v' + e.latestVersion;
    var cnt = item.querySelector('.version-count span');
    if (cnt) cnt.textContent = String(e.versionCount);
}

// ---- actions (single delegated listener on #widget-library) ----
function onWidgetLibraryClick(e) {
    var actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    var item = actionEl.closest('.widget-library-item');
    var id = item && item.dataset.widgetId;
    if (!id) return;
    e.stopPropagation();
    switch (actionEl.dataset.action) {
        case 'open':
        case 'versions': openWidgetFullscreen(id, e); break;
        case 'newtab': openWidgetLink(id); break;
        case 'pin': showWidgetPinMenu(id, e); break;
        case 'chat': widgetLibraryGoToChat(id); break;
        case 'agent': editWidgetWithAgent(id, e); break;
        case 'code': editWidgetCode(id); break;
        case 'delete': confirmDeleteLibraryWidget(id); break;
        default: break;
    }
}

function widgetLibraryGoToChat(widgetId) {
    var w = WidgetStore.view(widgetId);
    var chatId = w && w.chatId;
    if (!chatId || typeof chats === 'undefined' || !chats[chatId]) { showSnackbar('Source chat not found', 'error'); return; }
    selectChat(chatId);
    // selectChat renders messages synchronously but inline widgets mount on
    // the next frame; scrollToWidget falls back to the modal if not found.
    setTimeout(function() { scrollToWidget(widgetId); }, 250);
}

// Permanent delete: canonical record + placement + chat projections
// (WidgetStore.remove). Distinct from confirmDeleteDashboardWidget, which
// only unpins.
async function confirmDeleteLibraryWidget(widgetId) {
    var w = WidgetStore.view(widgetId);
    if (!w) return;
    var n = WidgetStore.versions(widgetId).length;
    var ok = await showConfirmModal('Delete Widget',
        'Permanently delete \u201c' + escapeHtml(w.title) + '\u201d and its ' + n + ' saved version' + (n === 1 ? '' : 's') + '? It will also be unpinned from any dashboard. This cannot be undone.',
        'danger');
    if (!ok) return;
    try {
        await WidgetStore.remove(widgetId);
    } catch (err) {
        console.error('Widget delete failed', err);
        showSnackbar('Failed to delete widget: ' + (err && err.message || err), 'error');
        return;
    }
    if (typeof currentEditingWidget !== 'undefined' && currentEditingWidget === widgetId) currentEditingWidget = null;
    if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
    renderWidgetLibraryItems();
    showSnackbar('Widget deleted', 'success');
}
