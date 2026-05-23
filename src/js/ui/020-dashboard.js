// DASHBOARD WIDGET MANAGEMENT
// =============================================

async function loadDashboardWidgets() {
    try {
        // Load header visibility state from localStorage
        var savedHeaderState = appStorage.getItem('showDashboardHeaders');
        if (savedHeaderState !== null) {
            showDashboardHeaders = savedHeaderState === 'true';
        }
        
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

async function saveDashboardWidget(widget, skipHistory) {
    try {
        widget.updatedAt = Date.now();
        
        // Track HTML history (max 10 versions)
        if (!skipHistory && widget.html) {
            var oldWidget = dashboardWidgets[widget.id];
            if (oldWidget && oldWidget.html && oldWidget.html !== widget.html) {
                if (!widget.history) widget.history = [];
                widget.history.push({
                    html: oldWidget.html,
                    timestamp: Date.now(),
                    prompt: oldWidget.lastPrompt || ''
                });
                // Keep only last 10 versions
                if (widget.history.length > 10) {
                    widget.history = widget.history.slice(-10);
                }
            }
        }
        widget.lastPrompt = widget.prompt;
        
        dashboardWidgets[widget.id] = widget;
        
        // Create a copy without transient state for storage
        var widgetToSave = Object.assign({}, widget);
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

function generateWidgetId() {
    return 'widget_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Dashboard View Management
function toggleDashboardView() {
    // If already open, do nothing (behave like clicking on a chat)
    if (currentView === 'dashboard') return;
    openDashboardView();
}
