// DASHBOARD WIDGET MANAGEMENT
// =============================================

async function loadDashboardWidgets() {
    try {
        // Headers feature retired: #749 removed home headers, #752 removed the
        // main-dashboard toggle (toggleDashboardHeaders) — leaving this key
        // orphaned with NO writer. A persisted 'true' from a pre-#752 build kept
        // headers forever ON and hid the floating hover expand/drag control
        // (.show-headers hid .dashboard-widget-hover-btn), with no UI left to
        // turn it off. One-time purge; dashboards are always headerless now.
        appStorage.removeItem('showDashboardHeaders');
        
        var database = await openDatabase();
        var transaction = database.transaction([dashboardWidgetsStoreName], 'readonly');
        var store = transaction.objectStore(dashboardWidgetsStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var results = request.result || [];
                dashboardWidgets = {};
                results.forEach(function(widget) {
                    dashboardWidgets[widget.id] = widget;
                });
                resolve();
            };
            request.onerror = function() {
                console.error('Failed to load dashboard widgets:', request.error);
                resolve();
            };
        });
    } catch (e) {
        console.error('IndexedDB error loading dashboard widgets:', e);
        return Promise.resolve();
    }
}

// Content fields a caller may push onto an EXISTING dashboard record. Anything
// NOT listed here — gridX, gridY, width, height, zIndex, order, dashboard,
// prompt, conversation, history, createdAt — is dashboard-owned PLACEMENT and
// must survive the write. saveWidgetCodeEdit (tools/080-widget-tools.js:585)
// hands us the CHAT copy of a pinned widget, which has no grid placement at all
// and stores width/height as CSS strings ('100%' / '400px') rather than grid
// spans; the old `dashboardWidgets[widget.id] = widget` replaced the record
// wholesale, which relocated Home-pinned widgets to the Dashboard page and
// produced 'grid-column: NaN / span 100%'.
var DASHBOARD_CONTENT_FIELDS = ['html', 'title', 'error', 'chatId', 'msgIndex', 'contentVersion', 'deactivated'];

// prevHtml (optional): the pre-edit HTML, for callers that mutate the dashboard
// record IN PLACE before saving — the history diff below compares against the
// stored record, which in that case already holds the NEW html.
async function saveDashboardWidget(widget, skipHistory, prevHtml) {
    try {
        var existing = dashboardWidgets[widget.id];
        var basisHtml = (prevHtml === undefined || prevHtml === null)
            ? (existing ? existing.html : null)
            : prevHtml;
        // MERGE, don't replace (see DASHBOARD_CONTENT_FIELDS above).
        var target = widget;
        if (existing && existing !== widget) {
            DASHBOARD_CONTENT_FIELDS.forEach(function(k) {
                if (widget[k] !== undefined) existing[k] = widget[k];
            });
            target = existing;
        }
        target.updatedAt = Date.now();
        
        // Track HTML history (max 10 versions)
        if (!skipHistory && target.html) {
            if (basisHtml && basisHtml !== target.html) {
                if (!target.history) target.history = [];
                target.history.push({
                    html: basisHtml,
                    timestamp: Date.now(),
                    prompt: target.lastPrompt || ''
                });
                // Keep only last 10 versions
                if (target.history.length > 10) {
                    target.history = target.history.slice(-10);
                }
            }
        }
        target.lastPrompt = target.prompt;
        
        dashboardWidgets[target.id] = target;
        
        // Create a copy without transient state for storage
        var widgetToSave = Object.assign({}, target);
        delete widgetToSave.isLoading;
        delete widgetToSave.isStreaming;

        var database = await openDatabase();
        var transaction = database.transaction([dashboardWidgetsStoreName], 'readwrite');
        var store = transaction.objectStore(dashboardWidgetsStoreName);

        // Wait for the write to complete
        return new Promise(function(resolve, reject) {
            var request = store.put(widgetToSave);
            request.onsuccess = function() {
                resolve();
            };
            request.onerror = function() {
                console.error('Failed to save widget:', request.error);
                reject(request.error);
            };
        });
    } catch (e) {
        console.error('Failed to save dashboard widget:', e);
    }
}

async function deleteDashboardWidget(widgetId) {
    try {
        delete dashboardWidgets[widgetId];
        var database = await openDatabase();
        var transaction = database.transaction([dashboardWidgetsStoreName], 'readwrite');
        var store = transaction.objectStore(dashboardWidgetsStoreName);
        store.delete(widgetId);
    } catch (e) {
        console.error('Failed to delete dashboard widget:', e);
    }
}

// --- Multi-dashboard helpers ('main' = dashboard page, 'home' = home page) ---
// Records without a `dashboard` field are legacy → 'main' (no migration needed).
function widgetDashboardOf(widget) {
    return (widget && widget.dashboard === 'home') ? 'home' : 'main';
}

function dashboardWidgetsFor(dashboard) {
    var target = dashboard === 'home' ? 'home' : 'main';
    return Object.values(dashboardWidgets).filter(function(w) { return widgetDashboardOf(w) === target; });
}

function dashboardGridEl(dashboard) {
    return document.getElementById(dashboard === 'home' ? 'home-dashboard-grid' : 'dashboard-grid');
}

// Re-render whichever dashboard surfaces are currently visible.
function refreshVisibleDashboards() {
    var dashboardPanel = document.getElementById('dashboard-panel');
    if (dashboardPanel && dashboardPanel.style.display === 'flex') renderDashboard('main');
    var homePanel = document.getElementById('home-panel');
    if (homePanel && homePanel.style.display !== 'none' && typeof renderHomeDashboard === 'function') renderHomeDashboard();
}

function generateWidgetId() {
    return 'widget_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Dashboard View Management
function toggleDashboardView() {
    // If already open, do nothing (behave like clicking on a chat)
    if (currentView === 'dashboard') return;
    openDashboardView();
}
