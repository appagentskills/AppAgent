// Settings + Help (docs) page toolbars: debounced search that filters the
// rendered settings sections/rows or help topics in place (no re-render, so
// every setting control keeps its element, listeners and saved value).
// Toolbar markup comes from pageToolbarControlsHtml (ui/045-page-layout.js);
// hidden nodes get `.page-search-hidden` (css/19d-settings-help-layout.css).
var PAGE_SEARCH_DEBOUNCE_MS = 150;
var settingsPageSearchState = { query: '', timer: null };
var docsPageSearchState = { query: '', timer: null };

function _pageSearchNorm(v) { return String(v || '').trim().toLowerCase(); }
function _pageSearchText(el) { return el ? String(el.textContent || '').toLowerCase() : ''; }
function _pageSearchHide(el, hide) { if (el) el.classList.toggle('page-search-hidden', !!hide); }

// Shows/removes an empty-state card as the first child of `host`.
function _pageSearchEmptyState(host, show, q, hint) {
    if (!host) return;
    var el = host.querySelector(':scope > .page-search-empty');
    if (!show) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement('div');
        el.className = 'page-search-empty skills-empty';
        host.insertBefore(el, host.firstChild);
    }
    var icon = (typeof UI_ICONS !== 'undefined' && UI_ICONS.search) ? UI_ICONS.search : '';
    var safe = typeof escapeHtml === 'function' ? escapeHtml(q) : String(q).replace(/[&<>"']/g, '');
    el.innerHTML = '<span class="skills-empty-icon">' + icon + '</span><p>Nothing matches \u201c' + safe + '\u201d</p><p class="skills-empty-hint">' + hint + '</p>';
}

function _pageSearchSetCount(slot, text) {
    var countEl = slot ? slot.querySelector('.widget-library-count') : null;
    if (countEl) countEl.textContent = text;
}

// Settings: a section whose title matches shows whole; otherwise only its
// matching rows show; a section whose other content (async lists, hints)
// matches shows whole. Returns { shown, total } in sections.
function filterSettingsPage(root, query) {
    var q = _pageSearchNorm(query);
    var sections = root ? Array.prototype.slice.call(root.querySelectorAll('.settings-page-section')) : [];
    var shown = 0;
    sections.forEach(function(sec) {
        var rows = Array.prototype.slice.call(sec.querySelectorAll('.settings-page-row'));
        rows.forEach(function(r) { _pageSearchHide(r, false); });
        if (!q) { _pageSearchHide(sec, false); shown++; return; }
        var titleHit = _pageSearchText(sec.querySelector('.settings-page-section-title')).indexOf(q) !== -1;
        var rowHits = rows.filter(function(r) { return _pageSearchText(r).indexOf(q) !== -1; });
        var visible = titleHit || rowHits.length > 0 || _pageSearchText(sec).indexOf(q) !== -1;
        if (visible && !titleHit && rowHits.length > 0) {
            rows.forEach(function(r) { _pageSearchHide(r, rowHits.indexOf(r) === -1); });
        }
        _pageSearchHide(sec, !visible);
        if (visible) shown++;
    });
    _pageSearchEmptyState(root, !!q && sections.length > 0 && shown === 0, q, 'Search looks at section titles, setting names and descriptions.');
    return { shown: shown, total: sections.length };
}

function applySettingsPageSearch() {
    var root = document.getElementById('settings-page-content');
    var res = filterSettingsPage(root, settingsPageSearchState.query);
    _pageSearchSetCount(document.getElementById('settings-toolbar-slot'),
        settingsPageSearchState.query ? res.shown + ' of ' + res.total : res.total + (res.total === 1 ? ' section' : ' sections'));
    return res;
}

function settingsOnSearchInput(value) {
    settingsPageSearchState.query = _pageSearchNorm(value);
    if (settingsPageSearchState.timer) clearTimeout(settingsPageSearchState.timer);
    settingsPageSearchState.timer = setTimeout(function() {
        settingsPageSearchState.timer = null;
        applySettingsPageSearch();
    }, PAGE_SEARCH_DEBOUNCE_MS);
}

// Clear the query (e.g. before a deep-link scroll to a section).
function clearSettingsPageSearch() {
    settingsPageSearchState.query = '';
    var slot = document.getElementById('settings-toolbar-slot');
    var input = slot ? slot.querySelector('input') : null;
    if (input) input.value = '';
    applySettingsPageSearch();
}

// Help/docs: sections are flat siblings (h1 .docs-section, then its h2
// .docs-subsection s). A top section stays visible when one of its
// subsections matches, so results keep their chapter heading. Outline entries
// follow their section. Returns { shown, total } in sections.
function filterDocsPage(root, query) {
    var q = _pageSearchNorm(query);
    var main = root ? (root.querySelector('.docs-main') || root) : null;
    var sections = main ? Array.prototype.slice.call(main.querySelectorAll('.docs-section')) : [];
    var vis = {}, shown = 0, top = null;
    sections.forEach(function(sec) {
        var isSub = sec.classList.contains('docs-subsection');
        var hit = !q || _pageSearchText(sec).indexOf(q) !== -1;
        if (!isSub) top = sec;
        vis[sec.id] = hit;
        if (hit && isSub && top) vis[top.id] = true;
    });
    sections.forEach(function(sec) { _pageSearchHide(sec, !vis[sec.id]); if (vis[sec.id]) shown++; });
    if (main) Array.prototype.forEach.call(main.querySelectorAll('.docs-hr'), function(hr) { _pageSearchHide(hr, !!q); });
    if (root) Array.prototype.forEach.call(root.querySelectorAll('[data-docs-anchor]'), function(a) {
        var id = a.getAttribute('data-docs-anchor');
        _pageSearchHide(a, !!q && id in vis && !vis[id]);
    });
    _pageSearchEmptyState(main, !!q && sections.length > 0 && shown === 0, q, 'Search looks at help topic titles and text.');
    return { shown: shown, total: sections.length };
}

function applyDocsPageSearch() {
    var res = filterDocsPage(document.getElementById('docs-content'), docsPageSearchState.query);
    _pageSearchSetCount(document.getElementById('docs-toolbar-slot'),
        docsPageSearchState.query ? res.shown + ' of ' + res.total : res.total + (res.total === 1 ? ' topic' : ' topics'));
    return res;
}

function docsOnSearchInput(value) {
    docsPageSearchState.query = _pageSearchNorm(value);
    if (docsPageSearchState.timer) clearTimeout(docsPageSearchState.timer);
    docsPageSearchState.timer = setTimeout(function() {
        docsPageSearchState.timer = null;
        applyDocsPageSearch();
    }, PAGE_SEARCH_DEBOUNCE_MS);
}

// Fill a page's toolbar slot once (search + count), like Skills/Documents.
function ensurePageSearchToolbar(slotId, opts) {
    var slot = document.getElementById(slotId);
    if (slot && !slot.firstChild && typeof pageToolbarControlsHtml === 'function') {
        slot.innerHTML = pageToolbarControlsHtml(opts);
    }
    return slot;
}
