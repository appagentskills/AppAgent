// Documentation View Management
//
// Content lives in docs/documentation.md + README.md (the project overview).
// The build scripts (build/build.js and skills/extension-dev/build.js) embed
// each as base64 by replacing __DOCS_MARKDOWN_B64__ and __README_MARKDOWN_B64__.
// The runtime decodes both, merges them via mergeReadmeIntoDocs (with the hero
// image stripped — users inside the extension are already looking at the UI),
// and parses via parseDocsMarkdown (055-docs-renderer.js).

var DOCS_MARKDOWN_B64 = '__DOCS_MARKDOWN_B64__';
var README_MARKDOWN_B64 = '__README_MARKDOWN_B64__';

function _decodeB64Markdown(b64, placeholder) {
    if (!b64 || b64 === placeholder) return '';
    try {
        // atob → percent-encoded UTF-8 → decoded UTF-8
        return decodeURIComponent(escape(atob(b64)));
    } catch (e) {
        return '';
    }
}

// ─── Translated Help page ─────────────────────────────────────────────────────────────
// Translations are NOT embedded: the builds write docs/locales/<code>/{documentation.md,
// README.md} to docs-locales/<code>/ (build/docs-placeholders.js buildDocsLocaleFiles), and
// they are fetched here like the UI catalogs (core/025-i18n.js i18nInit). Each file is cached
// once per session ('' = missing/failed) and falls back to the embedded English per file.
var DOCS_LOCALE_FILES = ['documentation.md', 'README.md'];
var _docsLocaleCache = {};
var _docsLocalePending = {};

// Active UI language when it is a translated locale, else '' (English = embedded copy).
function _docsLocaleCode() {
    var code = typeof i18nLang === 'function' ? i18nLang() : 'en';
    return code && code !== 'en' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/.test(code) ? code : '';
}

function _docsLocaleReady(code) {
    return DOCS_LOCALE_FILES.every(function(name) { return Object.prototype.hasOwnProperty.call(_docsLocaleCache, code + '/' + name); });
}

// Resolves once every file of `code` is cached; never rejects. Returns true when at
// least one translated file is available (i.e. a re-render would change the page).
function loadDocsLocale(code, fetchFn) {
    if (!code) return Promise.resolve(false);
    var doFetch = fetchFn || ((typeof fetch === 'function' && typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.getURL)
        ? function(rel) { return fetch(chrome.runtime.getURL(rel)); } : null);
    if (!_docsLocalePending[code]) {
        _docsLocalePending[code] = Promise.all(DOCS_LOCALE_FILES.map(function(name) {
            var key = code + '/' + name;
            if (Object.prototype.hasOwnProperty.call(_docsLocaleCache, key)) return null;
            if (!doFetch) { _docsLocaleCache[key] = ''; return null; }
            return Promise.resolve().then(function() { return doFetch('docs-locales/' + key); })
                .then(function(res) { return res && res.ok ? res.text() : ''; })
                .then(function(text) { _docsLocaleCache[key] = typeof text === 'string' ? text : ''; })
                .catch(function() { _docsLocaleCache[key] = ''; });
        })).then(function() { delete _docsLocalePending[code]; });
    }
    return _docsLocalePending[code].then(function() {
        return DOCS_LOCALE_FILES.some(function(name) { return !!_docsLocaleCache[code + '/' + name]; });
    });
}

// Cached translation of one file for `code` ('' when missing / not loaded yet).
function _docsLocaleText(code, name) {
    return code ? (_docsLocaleCache[code + '/' + name] || '') : '';
}

function _decodeDocsMarkdown(code) {
    var docs = _docsLocaleText(code, 'documentation.md') || _decodeB64Markdown(DOCS_MARKDOWN_B64, '__DOCS_MARKDOWN' + '_B64__');
    var readme = _docsLocaleText(code, 'README.md') || _decodeB64Markdown(README_MARKDOWN_B64, '__README_MARKDOWN' + '_B64__');
    if (!docs && !readme) {
        return '# ' + t('Documentation') + '\n\n' + t('The documentation bundle was not embedded at build time.');
    }
    return mergeReadmeIntoDocs(readme, docs, { stripImages: true });
}

function _getDocsMarkdownRendered(code) {
    // __VERSION__ / __CHANGELOG__ were already substituted at build time (both
    // the embedded English and the docs-locales/ files), so none is needed here.
    return parseDocsMarkdown(_decodeDocsMarkdown(code));
}

function toggleDocsView() {
    if (currentView === 'docs') return;
    openDocsView();
}

function openDocsView() {
    currentView = 'docs';
    appStorage.setItem('currentView', 'docs');
    // SWM2-F3: left the chat view — clear this panel's focus entry so the SW
    // sub-agent GC doesn't keep the previously-viewed chat pinned (port-keyed).
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(null);
    hideAllPanels();
    var docsPanel = document.getElementById('docs-panel');
    if (docsPanel) { docsPanel.style.display = 'flex'; renderDocsPage(); }
    updateAllButtonStates();
    renderChatList();
    pushHistoryState('docs', null);
}

function downloadDocsAsMarkdown() {
    var code = _docsLocaleCode();
    var md = _decodeDocsMarkdown(_docsLocaleReady(code) ? code : '');
    var blob = new Blob([md], { type: 'text/markdown' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'appagent-documentation.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof showSnackbar === 'function') showSnackbar(t('Documentation downloaded'), 'success');
}

function renderDocsPage() {
    var container = document.getElementById('docs-content');
    if (!container) return;

    // Sync render: the cached translation when loaded, else English. A locale not
    // loaded yet is fetched once, then re-rendered only if the language is still
    // the same, the Help page is still open and a translation actually exists.
    var code = _docsLocaleCode();
    if (code && !_docsLocaleReady(code)) {
        loadDocsLocale(code).then(function(changed) {
            if (!changed || _docsLocaleCode() !== code) return;
            if (typeof currentView !== 'undefined' && currentView !== 'docs') return;
            renderDocsPage();
        });
    }
    var translated = !!(code && (_docsLocaleText(code, 'documentation.md') || _docsLocaleText(code, 'README.md')));
    var parsed = _getDocsMarkdownRendered(code);
    var iconHtml = (typeof UI_ICONS !== 'undefined' && UI_ICONS.book) ? UI_ICONS.book : '';
    var outlineHtml = buildDocsOutlineHtml(parsed.toc, iconHtml, { title: t('Contents'), ariaLabel: t('Documentation sections') });
    // English fallback inside an RTL/other-language UI keeps its own lang/dir.
    var mainAttrs = translated ? ' lang="' + code + '"' : ' lang="en" dir="ltr"';

    container.innerHTML =
        '<div class="docs-layout">' +
            '<div class="docs-main" id="docs-main"' + mainAttrs + '>' + parsed.html + '</div>' +
            outlineHtml +
        '</div>';

    // Wire up nav anchors, in-content anchor links, and app-action links.
    // Inline onclick attributes are forbidden by MV3 CSP — bind here instead.
    container.querySelectorAll('[data-docs-anchor]').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.preventDefault();
            scrollToDocSection(el.getAttribute('data-docs-anchor'));
        });
    });
    container.querySelectorAll('[data-app-action]').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.preventDefault();
            var fn = el.getAttribute('data-app-action');
            if (fn && typeof window[fn] === 'function') window[fn]();
        });
    });

    // Toolbar search (ui/046-settings-help-search.js): fill the slot once and
    // re-apply any active query to the freshly rendered topics.
    if (typeof ensurePageSearchToolbar === 'function') {
        ensurePageSearchToolbar('docs-toolbar-slot', { placeholder: t('Search help\u2026'), label: t('Search help'), inputClass: 'docs-search-input', onInput: 'docsOnSearchInput', countId: 'docs-search-count' });
        applyDocsPageSearch();
    }
}

function scrollToDocSection(id) {
    var el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return false;
}

function openDashboardView() {
    currentView = 'dashboard';
    appStorage.setItem('currentView', 'dashboard');
    // SWM2-F3: left the chat view — clear this panel's focus entry so the SW
    // sub-agent GC doesn't keep the previously-viewed chat pinned (port-keyed).
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(null);
    currentEditingWidget = null;
    hideAllPanels();
    var dashboardPanel = document.getElementById('dashboard-panel');
    if (dashboardPanel) { dashboardPanel.style.display = 'flex'; renderDashboard(); }
    updateAllButtonStates();
    renderChatList(); // Update sidebar to deselect chat
    // Push browser history state
    pushHistoryState('dashboard', null);
    // Setup responsive actions
    setupDashboardResponsive();
}

function closeDashboardView() {
    currentView = 'chat';
    appStorage.setItem('currentView', 'chat');
    currentEditingWidget = null;
    activeWidgetStreamingId = null;
    var dashboardPanel = document.getElementById('dashboard-panel');
    showChatView();
    if (dashboardPanel) dashboardPanel.style.display = 'none';
    updateDashboardButtonState();
    if (activeStreamingChatId && currentChatId === activeStreamingChatId) {
        renderMessages();
    }
}

function updateDashboardButtonState() {
    var dashboardPanel = document.getElementById('dashboard-panel');
    var btn = document.getElementById('dashboard-btn');
    var isOpen = dashboardPanel && dashboardPanel.style.display === 'flex';
    if (btn) btn.classList.toggle('active', isOpen);
}

var dashboardRenderGeneration = { main: 0, home: 0 }; // Per-dashboard render generation to cancel stale callbacks

// dashboard: 'main' (dashboard page, default) or 'home' (home page grid)
function renderDashboard(dashboard) {
    dashboard = dashboard === 'home' ? 'home' : 'main';
    var container = dashboardGridEl(dashboard);
    if (!container) return;

    // Widget Library (ui/065-widget-library.js) may own the dashboard page: it
    // shows #widget-library instead of #dashboard-grid from the persisted mode
    // and renders itself; switching back calls renderDashboard again, so the
    // grid picks up pin/delete changes made from the library.
    if (dashboard === 'main' && typeof syncDashboardPageMode === 'function' && syncDashboardPageMode()) return;

    // Increment generation to invalidate any pending render callbacks
    dashboardRenderGeneration[dashboard]++;
    var currentGeneration = dashboardRenderGeneration[dashboard];

    var widgetList = dashboardWidgetsFor(dashboard);
    if (widgetList.length === 0) {
        // Home grid has no empty-state hint — the whole section is hidden by renderHomeDashboard.
        container.innerHTML = dashboard === 'home' ? '' : '<div class="dashboard-empty"><span class="dashboard-empty-icon">' + UI_ICONS.widget + '</span><p>' + escapeHtml(t('No widgets yet')) + '</p><p class="dashboard-empty-hint">' + escapeHtml(t('Add widgets to your dashboard using prompts.')) + '</p></div>';
        return;
    }

    // Migrate widgets from order-based to grid-based positioning if needed
    migrateWidgetPositions(dashboard);

    var html = '';
    widgetList.forEach(function(widget) {
        html += buildWidgetHtml(widget, dashboard);
    });

    container.innerHTML = html;

    // Render widget content synchronously using requestAnimationFrame for proper timing
    requestAnimationFrame(function() {
        // Check if this render is still current
        if (currentGeneration !== dashboardRenderGeneration[dashboard]) return;

        widgetList.forEach(function(widget) {
            if (!widget.isLoading) {
                renderWidgetContent(widget);
            }
        });
    });
}
