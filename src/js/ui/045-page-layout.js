// Shared page layout for the full-width "library" pages — Dashboard, Documents,
// Skills, History, Settings and Help (css/19c-page-layout.css,
// css/19d-settings-help-layout.css; search in ui/046-settings-help-search.js).
//
// 1. Shared header: the home view's `.home-header` (New Chat title + the live
//    pills: instance, workspace, credits, model, jobs, settings) is a single DOM
//    node that is MOVED into whichever of these pages is showing, so every pill
//    keeps its ids / listeners / live updates with zero duplication. Mounted
//    from updateAllButtonStates() (ui/040-tools-settings.js), which every view
//    opener already calls after showing its panel.
// 2. Page toolbar: one `.page-toolbar` row per page = title + search + count +
//    Rows/Gallery toggle + the page's action buttons. pageToolbarControlsHtml()
//    builds the search/count/toggle part; the layout choice persists per page
//    in appStorage via pageLayoutGet/pageLayoutSet.
var PAGE_LAYOUT_GRID_ICON = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

var SHARED_PAGE_HEADER_PANELS = {
    home: 'home-panel',
    dashboard: 'dashboard-panel',
    documents: 'documents-panel',
    skills: 'skills-panel',
    'skill-editor': 'skills-panel',
    history: 'history-panel',
    'settings-page': 'settings-page-panel',
    docs: 'docs-panel'
};

function pageLayoutGet(key) {
    try { return appStorage.getItem(key) === 'gallery' ? 'gallery' : 'rows'; } catch (e) { return 'rows'; }
}

function pageLayoutSet(key, layout) {
    try { appStorage.setItem(key, layout === 'gallery' ? 'gallery' : 'rows'); } catch (e) {}
}

// Rows/Gallery segmented toggle. `fnName` is a global taking 'rows'|'gallery'.
function pageLayoutToggleHtml(fnName) {
    return '<div class="segmented-toggle widget-library-layout" role="group" aria-label="Layout">' +
        '<button type="button" class="widget-library-layout-btn" data-layout="rows" title="Rows" onclick="' + fnName + '(\'rows\')">' + UI_ICONS.list + '<span>Rows</span></button>' +
        '<button type="button" class="widget-library-layout-btn" data-layout="gallery" title="Gallery" onclick="' + fnName + '(\'gallery\')">' + PAGE_LAYOUT_GRID_ICON + '<span>Gallery</span></button>' +
    '</div>';
}

// Search + count + layout toggle, wrapped in `.widget-library-header` (flattened
// with display:contents inside a toolbar slot) so existing selectors keep working.
// opts: { extraClass, placeholder, label, inputClass, onInput, countId, layoutFn }
function pageToolbarControlsHtml(opts) {
    return '<div class="widget-library-header ' + (opts.extraClass || '') + '">' +
        '<label class="widget-library-search">' + UI_ICONS.search +
            '<input type="search" class="widget-library-search-input ' + (opts.inputClass || '') + '" placeholder="' + opts.placeholder + '" aria-label="' + (opts.label || opts.placeholder) + '" oninput="' + opts.onInput + '(this.value)">' +
        '</label>' +
        '<span class="widget-library-count" id="' + opts.countId + '"></span>' +
        (opts.layoutFn ? pageLayoutToggleHtml(opts.layoutFn) : '') +
    '</div>';
}

function pageLayoutSyncButtons(root, layout) {
    if (!root) return;
    root.querySelectorAll('.widget-library-layout-btn').forEach(function(btn) {
        var on = btn.dataset.layout === layout;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

// Move the shared New Chat header (with its pills) into the panel for `view`.
function mountSharedPageHeader(view) {
    var panelId = SHARED_PAGE_HEADER_PANELS[view];
    if (!panelId) return;
    if (document.body.classList.contains('standalone-dashboard')) return;
    var header = document.querySelector('.home-header');
    var panel = document.getElementById(panelId);
    if (!header || !panel) return;
    if (panelId === 'home-panel') {
        var content = document.getElementById('home-content');
        if (header.parentNode !== panel || header.nextElementSibling !== content) {
            panel.insertBefore(header, content && content.parentNode === panel ? content : null);
        }
    } else if (panel.firstElementChild !== header) {
        panel.insertBefore(header, panel.firstChild);
    }
    header.classList.toggle('shared-page-header', panelId !== 'home-panel');
    if (typeof applyHomeHeaderActionsResponsive === 'function') {
        try { applyHomeHeaderActionsResponsive(); } catch (e) {}
    }
}
