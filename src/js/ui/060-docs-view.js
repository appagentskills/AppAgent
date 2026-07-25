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

function _decodeDocsMarkdown() {
    var docs = _decodeB64Markdown(DOCS_MARKDOWN_B64, '__DOCS_MARKDOWN' + '_B64__');
    var readme = _decodeB64Markdown(README_MARKDOWN_B64, '__README_MARKDOWN' + '_B64__');
    if (!docs && !readme) {
        return '# Documentation\n\nThe documentation bundle was not embedded at build time.';
    }
    return mergeReadmeIntoDocs(readme, docs, { stripImages: true });
}

function _getDocsMarkdownRendered() {
    // __VERSION__ inside the markdown was already substituted at build time
    // before base64-encoding, so no runtime substitution is needed here.
    return parseDocsMarkdown(_decodeDocsMarkdown());
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
    var md = _decodeDocsMarkdown();
    var blob = new Blob([md], { type: 'text/markdown' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'appagent-documentation.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof showSnackbar === 'function') showSnackbar('Documentation downloaded', 'success');
}

function renderDocsPage() {
    var container = document.getElementById('docs-content');
    if (!container) return;

    var parsed = _getDocsMarkdownRendered();
    var iconHtml = (typeof UI_ICONS !== 'undefined' && UI_ICONS.book) ? UI_ICONS.book : '';
    var outlineHtml = buildDocsOutlineHtml(parsed.toc, iconHtml);

    container.innerHTML =
        '<div class="docs-layout">' +
            '<div class="docs-main" id="docs-main">' + parsed.html + '</div>' +
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
    // Update headers toggle button state based on loaded preference
    var headersBtn = document.getElementById('dashboard-toggle-headers-btn');
    if (headersBtn) headersBtn.classList.toggle('active', showDashboardHeaders);
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

    // Increment generation to invalidate any pending render callbacks
    dashboardRenderGeneration[dashboard]++;
    var currentGeneration = dashboardRenderGeneration[dashboard];

    var widgetList = dashboardWidgetsFor(dashboard);
    if (widgetList.length === 0) {
        // Home grid has no empty-state hint — the whole section is hidden by renderHomeDashboard.
        container.innerHTML = dashboard === 'home' ? '' : '<div class="dashboard-empty"><span class="dashboard-empty-icon">' + UI_ICONS.widget + '</span><p>No widgets yet</p><p class="dashboard-empty-hint">Add widgets to your dashboard using prompts.</p></div>';
        return;
    }

    // Migrate widgets from order-based to grid-based positioning if needed
    migrateWidgetPositions(dashboard);

    var html = '';
    widgetList.forEach(function(widget) {
        html += buildWidgetHtml(widget, dashboard);
    });

    container.innerHTML = html;

    // Apply show-headers class if enabled — MAIN dashboard only. Home cards
    // never render a header (buildWidgetHtml skips it) and have no toggle, so
    // the home grid must never get .show-headers (it would also hide the
    // floating hover expand/drag control).
    if (dashboard !== 'home' && showDashboardHeaders) {
        container.classList.add('show-headers');
    } else {
        container.classList.remove('show-headers');
    }

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
