// Dashboard responsive More menu
function toggleDashboardMoreMenu(e) {
    e.stopPropagation();
    var dropdown = document.getElementById('dashboard-more-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('show');
        if (dropdown.classList.contains('show')) {
            // Close on click outside
            setTimeout(function() {
                document.addEventListener('click', closeDashboardMoreMenu, { once: true });
            }, 0);
        }
    }
}

function closeDashboardMoreMenu() {
    var dropdown = document.getElementById('dashboard-more-dropdown');
    if (dropdown) dropdown.classList.remove('show');
}

// Check if dashboard actions should collapse
function checkDashboardActionsOverflow() {
    var container = document.getElementById('dashboard-actions');
    if (!container) return;

    // Temporarily uncollapse to measure
    container.classList.remove('collapsed');

    // Check if content overflows (with some buffer)
    var header = container.closest('.dashboard-header');
    if (header) {
        var availableWidth = header.clientWidth - 200; // Reserve space for sidebar btn + title
        var actionsWidth = container.scrollWidth;

        if (actionsWidth > availableWidth - 20) {
            container.classList.add('collapsed');
        }
    }
}

// Setup dashboard responsive observer
var dashboardResizeObserver = null;
function setupDashboardResponsive() {
    var header = document.querySelector('.dashboard-header');
    if (!header || dashboardResizeObserver) return;

    dashboardResizeObserver = new ResizeObserver(function() {
        checkDashboardActionsOverflow();
    });
    dashboardResizeObserver.observe(header);
    checkDashboardActionsOverflow();
}

// Expand widget to fullscreen
function expandDashboardWidget(widgetId) {
    var widget = dashboardWidgets[widgetId];
    if (!widget) return;
    
    expandedWidgetId = widgetId;
    
    var overlay = document.createElement('div');
    overlay.className = 'widget-fullscreen-overlay';
    overlay.id = 'widget-fullscreen-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) closeExpandedWidget(); };
    
    var modal = document.createElement('div');
    modal.className = 'widget-fullscreen-modal';
    
    var header = document.createElement('div');
    header.className = 'widget-fullscreen-header';
    header.innerHTML = '<span class="widget-icon">' + UI_ICONS.widget + '</span>' +
        '<span class="widget-title">' + escapeHtml(widget.title || 'Untitled') + '</span>' +
        '<div class="widget-modal-controls">' +
        '<button class="widget-modal-btn widget-stop-btn" data-widget-id="' + widgetId + '" onclick="toggleWidgetRunning(\'' + widgetId + '\', event);closeExpandedWidget()" title="' + (widget.deactivated ? 'Activate Widget' : 'Deactivate Widget') + '">' + (widget.deactivated ? UI_ICONS.play : UI_ICONS.stop) + '</button>' +
        (widget.history && widget.history.length > 0 ? '<button class="widget-modal-btn" onclick="closeExpandedWidget();showWidgetHistory(\'' + widgetId + '\')" title="History (' + widget.history.length + ')">' + UI_ICONS.history + '</button>' : '') +
        '<button class="widget-modal-btn" onclick="screenshotWidget(\'' + widgetId + '\')" title="Screenshot">' + UI_ICONS.camera + '</button>' +
        '<button class="widget-modal-btn widget-edit-btn" data-widget-id="' + widgetId + '" onclick="editWidgetWithAgent(\'' + widgetId + '\', event)" title="Edit">' + UI_ICONS.edit + '</button>' +
        // Dashboard twin of the chat toolbar's manual code editor
        // (tools/080-widget-tools.js:429). Distinct from the "Edit" button above:
        // that one hands the widget to the agent in a fresh chat, this one opens
        // the raw HTML editor. Same title/icon pair the chat fullscreen uses, so
        // the two surfaces stay learnable.
        '<button class="widget-modal-btn widget-code-btn" data-widget-id="' + widgetId + '" onclick="editDashboardWidgetCode(\'' + widgetId + '\', event)" title="Edit code">' + UI_ICONS.code + '</button>' +
        '<button class="widget-modal-btn danger" onclick="closeExpandedWidget();confirmDeleteDashboardWidget(\'' + widgetId + '\')" title="Delete">' + UI_ICONS.trash + '</button>' +
        '<button class="widget-close-btn" onclick="closeExpandedWidget()" title="Close">' + UI_ICONS.close + '</button>' +
        '</div>';
    
    var content = document.createElement('div');
    content.className = 'widget-fullscreen-content';
    content.id = 'widget-fullscreen-content';
    
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    // Render widget in fullscreen
    if (widget.html) {
        var iframe = document.createElement('iframe');
        iframe.className = 'widget-iframe';
        iframe.style.cssText = 'width:100%;height:100%;border:none;background:var(--bg-white);';
        iframe.sandbox = 'allow-scripts allow-same-origin allow-forms';
        content.appendChild(iframe);
        writeWidgetHtml(iframe, injectWidgetBridge(widget.html, widget.title, widget.id));
    }
}

function closeExpandedWidget() {
    expandedWidgetId = null;
    var overlay = document.getElementById('widget-fullscreen-overlay');
    if (overlay) overlay.remove();
}

// ── Dashboard → manual code editor ───────────────────────────────────────────
// Dashboard-pinned widgets had NO route to the code editor: editWidgetCode
// (tools/080-widget-tools.js:535) was reachable from exactly ONE call site,
// the CHAT fullscreen toolbar (tools/080-widget-tools.js:429), and the
// dashboard modal built by expandDashboardWidget above never goes through
// openWidgetFullscreen. PR #734 also deleted the old editDashboardWidget
// bridge that used to walk the user back to the source chat, so a pinned
// widget's code was simply unreachable. This is the dashboard twin.
//
// The editor overlay is surface-agnostic (it appends its own
// #widget-edit-overlay to document.body) and the shared save is dashboard-safe
// at the ROOT: getWidgetById falls back to dashboardWidgets
// (tools/080-widget-tools.js:199) so a dashboard-only widget resolves, and
// saveDashboardWidget MERGES content onto the existing record instead of
// replacing it (ui/020-dashboard.js) so grid placement survives. This is
// therefore a pure route — close, then hand off. No dashboard-side save fork.
function editDashboardWidgetCode(widgetId, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (!dashboardWidgets[widgetId]) { showSnackbar('Widget not found', 'error'); return; }
    if (typeof editWidgetCode !== 'function') { showSnackbar('Code editor unavailable', 'error'); return; }
    // Close the dashboard fullscreen FIRST — load-bearing, not cosmetic: it is a
    // .widget-fullscreen-overlay at --z-fullscreen (10003) while the editor is a
    // .widget-modal-overlay at --z-widget-modal (10002) (css/00-tokens.css:174-175),
    // so leaving it up buries the editor behind this backdrop and desyncs the
    // global Escape order (core/120-init.js:209-211 checks #widget-fullscreen-overlay
    // first). Same reason the chat-side button calls closeWidgetFullscreen() first.
    closeExpandedWidget();
    editWidgetCode(widgetId);
}

// Grid occupancy and collision detection functions
function initGridOccupancy(dashboard) {
    gridState.occupancy = {};
    dashboardWidgetsFor(dashboard).forEach(function(widget) {
        if (widget.gridX !== undefined && widget.gridY !== undefined) {
            markOccupied(widget.id, widget.gridX, widget.gridY, widget.width || 4, widget.height || 4);
        }
    });
}

function markOccupied(widgetId, x, y, w, h) {
    for (var row = y; row < y + h; row++) {
        for (var col = x; col < x + w; col++) {
            var key = row + ',' + col;
            gridState.occupancy[key] = widgetId;
        }
    }
}

function checkCollision(x, y, w, h, excludeWidgetId) {
    var collisions = [];
    for (var row = y; row < y + h; row++) {
        for (var col = x; col < x + w; col++) {
            if (col < 0 || col >= 12) continue; // Out of grid bounds
            var key = row + ',' + col;
            var occupant = gridState.occupancy[key];
            if (occupant && occupant !== excludeWidgetId && collisions.indexOf(occupant) === -1) {
                collisions.push(occupant);
            }
        }
    }
    return collisions;
}

function updateWidgetPosition(widgetId) {
    var widget = dashboardWidgets[widgetId];
    var el = document.querySelector('.dashboard-widget[data-widget-id="' + widgetId + '"]');
    if (!widget || !el) return;

    var width = widget.width || 4;
    var height = widget.height || 4;
    var zIndex = widget.zIndex || 1;

    el.style.gridColumn = (widget.gridX + 1) + ' / span ' + width;
    el.style.gridRow = (widget.gridY + 1) + ' / span ' + height;
    el.style.zIndex = zIndex;
}

function findNextAvailablePosition(w, h) {
    // Scan grid row by row to find first available position
    for (var y = 0; y < 1000; y++) {
        for (var x = 0; x <= 12 - w; x++) {
            var collisions = checkCollision(x, y, w, h, null);
            if (collisions.length === 0) {
                return { gridX: x, gridY: y };
            }
        }
    }
    return { gridX: 0, gridY: 0 }; // Fallback
}

function migrateWidgetPositions(dashboard) {
    var widgets = dashboardWidgetsFor(dashboard)
        .filter(function(w) { return w.gridX === undefined || w.gridY === undefined; })
        .sort(function(a, b) { return (a.order || 0) - (b.order || 0); });

    if (widgets.length === 0) return;

    // Initialize occupancy for already migrated widgets (same dashboard only)
    initGridOccupancy(dashboard);

    widgets.forEach(function(widget) {
        var w = widget.width || 4;
        var h = widget.height || 4;
        var pos = findNextAvailablePosition(w, h);
        widget.gridX = pos.gridX;
        widget.gridY = pos.gridY;
        markOccupied(widget.id, pos.gridX, pos.gridY, w, h);
        saveDashboardWidget(widget);
    });
}

// Drag and drop with grid-based positioning
var currentDragWidgetId = null;

function handleWidgetDragStart(event, widgetId) {
    var widget = dashboardWidgets[widgetId];
    if (!widget) return;

    currentDragWidgetId = widgetId;
    gridState.draggedWidgetId = widgetId;

    // Disable pointer events on all widget content to prevent iframe capturing mouse
    var allWidgetContents = document.querySelectorAll('.dashboard-widget-content');
    allWidgetContents.forEach(function(el) {
        el.style.pointerEvents = 'none';
    });

    // Store where user grabbed the widget (offset from widget's top-left)
    var widgetEl = event.target.closest('.dashboard-widget');
    if (widgetEl) {
        var rect = widgetEl.getBoundingClientRect();
        gridState.dragOffset = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        };
        widgetEl.classList.add('dragging');
    }

    event.dataTransfer.setData('text/plain', widgetId);
    event.dataTransfer.effectAllowed = 'move';
}

function handleWidgetDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
}

// Both dashboards render into a .dashboard-grid, but the two surfaces do NOT
// share a padding: the main page grid uses var(--space-8) = 16px
// (css/19-dashboard.css:15) while .home-dashboard-grid overrides it to
// var(--space-4) = 8px (css/19-dashboard.css:95, and the home grid carries BOTH
// classes - ui/030-home-view.js:598). The snap maths below used to hard-code the
// main grid's 16px, which on the Home surface biased every drop ~8px up/left and
// under-computed cellWidth by ~1.33px per column (a 16px error spread over 12
// columns) - enough to land a drop near the right/bottom edge one cell off.
// Read the real padding off the element instead. The 16px fallbacks only apply
// when there is no element or no getComputedStyle (non-DOM contexts).
function gridPaddingOf(grid) {
    var pad = { left: 16, right: 16, top: 16 };
    if (!grid || typeof window === 'undefined' || !window.getComputedStyle) return pad;
    var cs = null;
    try { cs = window.getComputedStyle(grid); } catch (e) { return pad; }
    if (!cs) return pad;
    var l = parseFloat(cs.paddingLeft);
    var r = parseFloat(cs.paddingRight);
    var t = parseFloat(cs.paddingTop);
    if (!isNaN(l)) pad.left = l;
    if (!isNaN(r)) pad.right = r;
    if (!isNaN(t)) pad.top = t;
    return pad;
}

function handleWidgetDrop(event) {
    event.preventDefault();

    if (!gridState.draggedWidgetId) return;

    var widget = dashboardWidgets[gridState.draggedWidgetId];
    if (!widget) return;

    // Calculate drop position accounting for grab offset — resolve the grid
    // the widget lives in ('main' page grid or the home grid).
    var grid = dashboardGridEl(widgetDashboardOf(widget));
    if (!grid) return;

    var gridRect = grid.getBoundingClientRect();
    var scrollTop = grid.scrollTop;

    // Adjust mouse position by grab offset to get widget's top-left position
    var offsetX = gridState.dragOffset ? gridState.dragOffset.x : 0;
    var offsetY = gridState.dragOffset ? gridState.dragOffset.y : 0;

    var widgetLeft = event.clientX - offsetX - gridRect.left;
    var widgetTop = event.clientY - offsetY - gridRect.top + scrollTop;

    // Calculate grid cell dimensions from THIS grid's real padding (main 16px /
    // home 8px) instead of the old hard-coded 32 / 16 literals - see gridPaddingOf.
    var pad = gridPaddingOf(grid);
    var cellWidth = (gridRect.width - pad.left - pad.right - (11 * gridState.gap)) / 12;
    var cellHeight = gridState.rowHeight + gridState.gap;

    // Snap to grid
    var gridX = Math.round((widgetLeft - pad.left) / (cellWidth + gridState.gap));
    var gridY = Math.round((widgetTop - pad.top) / cellHeight);

    // Clamp to bounds
    var w = widget.width || 4;
    gridX = Math.max(0, Math.min(12 - w, gridX));
    gridY = Math.max(0, gridY);

    // Update position and bring to front
    widget.gridX = gridX;
    widget.gridY = gridY;
    gridState.maxZIndex++;
    widget.zIndex = gridState.maxZIndex;

    // Update visual and save
    updateWidgetPosition(widget.id);
    saveDashboardWidget(widget);

    // Clean up
    gridState.draggedWidgetId = null;
    gridState.dragOffset = null;
    currentDragWidgetId = null;
}

function handleWidgetDragEnd(event) {
    var widgetEl = event.target.closest('.dashboard-widget');
    if (widgetEl) widgetEl.classList.remove('dragging');

    // Restore pointer events on all widget content
    var allWidgetContents = document.querySelectorAll('.dashboard-widget-content');
    allWidgetContents.forEach(function(el) {
        el.style.pointerEvents = '';
    });

    // Clean up
    gridState.draggedWidgetId = null;
    gridState.dragOffset = null;
    currentDragWidgetId = null;
}

// dashboard: 'main' (default) or 'home'. Home cards NEVER render the widget
// header — the home section has no headers toggle; the floating hover control
// below supplies expand + drag there.
function buildWidgetHtml(widget, dashboard) {
    var isHome = dashboard === 'home';
    // Grid-based positioning
    var width = Math.max(3, widget.width || 4);
    var height = Math.max(2, widget.height || 4);
    var gridX = widget.gridX !== undefined ? widget.gridX : 0;
    var gridY = widget.gridY !== undefined ? widget.gridY : 0;
    var zIndex = widget.zIndex || 1;

    // Track max z-index for new widgets
    if (zIndex > gridState.maxZIndex) {
        gridState.maxZIndex = zIndex;
    }

    // Build grid position style
    var gridColStyle = (gridX + 1) + ' / span ' + width;
    var gridRowStyle = (gridY + 1) + ' / span ' + height;

    var errorClass = widget.error ? ' widget-error' : '';
    var loadingClass = widget.isLoading ? ' widget-loading' : '';
    var errorBadge = widget.error ? '<span class="widget-error-badge" title="' + escapeHtml(widget.error) + '">Error</span>' : '';
    var loadingOverlay = widget.isLoading ? '<div class="widget-loading-overlay"><div class="widget-spinner"></div><span>Generating...</span></div>' : '';

    var html = '<div class="dashboard-widget' + errorClass + loadingClass + '" data-widget-id="' + widget.id + '" draggable="true" ';
    html += 'ondragstart="handleWidgetDragStart(event, \'' + widget.id + '\')" ';
    html += 'ondragover="handleWidgetDragOver(event)" ';
    html += 'ondrop="handleWidgetDrop(event)" ';
    html += 'ondragend="handleWidgetDragEnd(event)" ';
    html += 'style="grid-column: ' + gridColStyle + '; grid-row: ' + gridRowStyle + '; z-index: ' + zIndex + ';">';
    if (!isHome) {
    html += '<div class="dashboard-widget-header">';
    html += '<span class="dashboard-widget-icon drag-handle">' + UI_ICONS.widget + '</span>';
    html += '<span class="dashboard-widget-title">' + escapeHtml(widget.title || 'Untitled') + '</span>';
    html += errorBadge;
    html += '<div class="dashboard-widget-controls">';
    html += '<button class="dashboard-widget-btn" onclick="event.stopPropagation();expandDashboardWidget(\'' + widget.id + '\')" title="Expand">' + UI_ICONS.maximize + '</button>';
    html += '</div>';
    html += '</div>';
    }
    // #732/#730: the header — which carries the Expand button and the only usable
    // grab surface (the content iframe swallows mouse events) — is display:none
    // permanently (headers retired: #749/#752 removed the toggles; the orphaned
    // showDashboardHeaders setting is purged in loadDashboardWidgets), which
    // would leave the card inert: no expand, no drag. This small floating
    // hover-only control provides both: click runs the SAME expandDashboardWidget
    // action as the (hidden) header button, and it is draggable through the SAME
    // handleWidgetDragStart the card root uses (stopPropagation so the root's
    // bubbled ondragstart doesn't run it twice).
    html += '<button class="dashboard-widget-hover-btn" draggable="true" ';
    html += 'ondragstart="event.stopPropagation();handleWidgetDragStart(event, \'' + widget.id + '\')" ';
    html += 'onclick="event.stopPropagation();expandDashboardWidget(\'' + widget.id + '\')" ';
    html += 'title="Expand · drag to move">' + UI_ICONS.maximize + '</button>';
    html += '<div class="dashboard-widget-content" id="dashboard-widget-content-' + widget.id + '">' + loadingOverlay + '</div>';
    html += '<div class="dashboard-widget-resize-handle" onmousedown="startWidgetResize(event, \'' + widget.id + '\')"></div>';
    html += '</div>';
    return html;
}

// Corner resize handling with grid snapping
function startWidgetResize(event, widgetId) {
    event.preventDefault();
    event.stopPropagation();

    var widget = dashboardWidgets[widgetId];
    if (!widget) return;

    var widgetEl = document.querySelector('.dashboard-widget[data-widget-id="' + widgetId + '"]');
    if (!widgetEl) return;

    // Disable pointer events on all widget content to prevent iframe capturing mouse
    var allWidgetContents = document.querySelectorAll('.dashboard-widget-content');
    allWidgetContents.forEach(function(el) {
        el.style.pointerEvents = 'none';
    });

    widgetDragState = {
        widgetId: widgetId,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: widget.width || 4,
        startHeight: widget.height || 4,
        gridX: widget.gridX,
        gridY: widget.gridY
    };

    document.addEventListener('mousemove', handleWidgetResizeMove);
    document.addEventListener('mouseup', handleWidgetResizeEnd);
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
}

function handleWidgetResizeMove(event) {
    if (!widgetDragState) return;

    var widgetEl = document.querySelector('.dashboard-widget[data-widget-id="' + widgetDragState.widgetId + '"]');
    if (!widgetEl) return;

    // Get the grid this widget is rendered in for calculating units
    var grid = widgetEl.closest('.dashboard-grid') || document.getElementById('dashboard-grid');
    if (!grid) return;

    var gridRect = grid.getBoundingClientRect();
    // Padding-aware cell width, same as handleWidgetDrop: the home grid's 8px
    // padding (css/19-dashboard.css:95) is half the main grid's 16px, so the old
    // hard-coded 32 under-computed cellWidth by ~1.33px per column on Home.
    var pad = gridPaddingOf(grid);
    var cellWidth = (gridRect.width - pad.left - pad.right - (11 * gridState.gap)) / 12;
    var cellHeight = gridState.rowHeight;

    // Calculate new size based on mouse position
    var dx = event.clientX - widgetDragState.startX;
    var dy = event.clientY - widgetDragState.startY;

    // Calculate new dimensions in grid units
    var startPixelWidth = widgetDragState.startWidth * cellWidth + (widgetDragState.startWidth - 1) * gridState.gap;
    var startPixelHeight = widgetDragState.startHeight * cellHeight + (widgetDragState.startHeight - 1) * gridState.gap;

    var newPixelWidth = startPixelWidth + dx;
    var newPixelHeight = startPixelHeight + dy;

    // Snap to grid units
    var newWidthUnits = Math.max(3, Math.round(newPixelWidth / (cellWidth + gridState.gap)));
    var newHeightUnits = Math.max(2, Math.round(newPixelHeight / (cellHeight + gridState.gap)));

    // Clamp width so widget doesn't go off right edge
    var maxWidth = 12 - widgetDragState.gridX;
    newWidthUnits = Math.min(newWidthUnits, maxWidth);

    // Apply size using grid span
    widgetEl.style.gridColumn = (widgetDragState.gridX + 1) + ' / span ' + newWidthUnits;
    widgetEl.style.gridRow = (widgetDragState.gridY + 1) + ' / span ' + newHeightUnits;

    // Store the new units for saving
    widgetDragState.newWidth = newWidthUnits;
    widgetDragState.newHeight = newHeightUnits;
}

function handleWidgetResizeEnd(event) {
    // Re-enable pointer events on all widget content
    var allWidgetContents = document.querySelectorAll('.dashboard-widget-content');
    allWidgetContents.forEach(function(el) {
        el.style.pointerEvents = '';
    });

    if (widgetDragState) {
        var widget = dashboardWidgets[widgetDragState.widgetId];

        if (widget && widgetDragState.newWidth !== undefined && widgetDragState.newHeight !== undefined) {
            widget.width = widgetDragState.newWidth;
            widget.height = widgetDragState.newHeight;
            saveDashboardWidget(widget);

            // Update position in DOM
            updateWidgetPosition(widget.id);
        }
    }

    widgetDragState = null;
    document.removeEventListener('mousemove', handleWidgetResizeMove);
    document.removeEventListener('mouseup', handleWidgetResizeEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
}

// Inject executeTool bridge into widget HTML before </head> tag
// `widgetId` (optional) is exposed to the widget as window._widgetId and is
// also what the start_chat tool uses to identify the CALLING widget — see the
// widgetToolCall handler below, which resolves it authoritatively from the DOM
// rather than trusting the shim.
function injectWidgetBridge(html, widgetTitle, widgetId) {
    // escapeJsString escapes \ first, then quotes/</>/& as JS hex sequences —
    // a title containing \ or </script> can no longer corrupt the script block.
    var safeTitle = escapeJsString(widgetTitle || 'Widget');
    var safeId = escapeJsString(widgetId || '');
    var bridgeScript = '<script>' +
        'window._widgetTitle="' + safeTitle + '";' +
        'window._widgetId="' + safeId + '";' +
        // executeTool bridge - allows widgets to call agent tools via postMessage
        'window._toolCallbacks={};' +
        'window._toolCallId=0;' +
        'window.executeTool=function(name,args){' +
            'return new Promise(function(resolve,reject){' +
                'var id="tc_"+(++window._toolCallId)+"_"+Date.now();' +
                'window._toolCallbacks[id]={resolve:resolve,reject:reject};' +
                'window.parent.postMessage({type:"widgetToolCall",id:id,name:name,args:args,widgetName:window._widgetTitle},"*");' +
            '});' +
        '};' +
        'window.addEventListener("message",function(e){' +
            'if(e.source!==window.parent)return;' +
            'if(e.data&&e.data.type==="widgetToolResult"&&window._toolCallbacks[e.data.id]){' +
                'var cb=window._toolCallbacks[e.data.id];' +
                'delete window._toolCallbacks[e.data.id];' +
                'if(e.data.error)cb.reject(new Error(e.data.error));' +
                'else cb.resolve(e.data.result);' +
            '}' +
            'if(e.data&&e.data.type==="widgetPrint"){window.print();}' +
            // Widget query handler - allows parent to inspect/interact with widget DOM via postMessage
            'if(e.data&&e.data.type==="widgetQuery"){' +
                'var _wqId=e.data.id,_wqAct=e.data.action,_wqArgs=e.data.args||{},_wqR;' +
                'try{' +
                    'if(_wqAct==="get_dom"){' +
                        'var _h=document.documentElement.outerHTML;' +
                        'var _ml=(typeof _wqArgs.max_length==="number"?_wqArgs.max_length:200000);' +
                        'if(_h.length>_ml)_h=_h.substring(0,_ml)+"... [truncated, total: "+_h.length+" chars]";' +
                        '_wqR={success:true,html:_h,note:"DOM retrieved (from widget)"};' +
                    '}else if(_wqAct==="get_visible_text"){' +
                        'var _vis=[];' +
                        'var _skip={"SCRIPT":1,"STYLE":1,"NOSCRIPT":1,"TEMPLATE":1,"META":1,"LINK":1,"HEAD":1};' +
                        'var _deep=_wqArgs.deep;' +
                        'function _wk(n){' +
                            'if(!n||(n.nodeType!==1&&n.nodeType!==9&&n.nodeType!==11))return;' +
                            'if(n.nodeType===1){' +
                                'if(_skip[n.tagName])return;' +
                                'var cs=window.getComputedStyle(n);' +
                                'if(cs.display==="none"||cs.visibility==="hidden"||cs.opacity==="0")return;' +
                                'var rc=n.getBoundingClientRect();if(rc.width===0&&rc.height===0)return;' +
                                'var ii=["INPUT","SELECT","TEXTAREA","BUTTON","A"].indexOf(n.tagName)!==-1;' +
                                'var im=n.tagName==="IMG"||n.tagName==="VIDEO"||n.tagName==="SVG";' +
                                'var ih=["H1","H2","H3","H4","H5","H6"].indexOf(n.tagName)!==-1;' +
                                'var il=n.tagName==="LABEL"||n.tagName==="LEGEND";' +
                                'var dt="";for(var i=0;i<n.childNodes.length;i++)if(n.childNodes[i].nodeType===3)dt+=n.childNodes[i].textContent.trim();' +
                                'if(dt||ii||im||ih||il){' +
                                    'var tv=n.tagName==="INPUT"?(n.value||n.placeholder||""):n.tagName==="TEXTAREA"?(n.value||""):n.tagName==="IMG"?(n.alt||n.title||""):dt;' +
                                    'if(tv.trim()||ii){' +
                                        'var tp=ih?"heading":ii?(n.tagName==="A"?"link":n.tagName==="BUTTON"?"button":"input"):im?"media":il?"label":"text";' +
                                        'var ed={tag:n.tagName.toLowerCase(),type:tp,text:tv.trim().substring(0,500)};' +
                                        'if(_deep){ed.id=n.id||null;ed.ariaLabel=n.getAttribute("aria-label")||null;' +
                                            'ed.selector=n.id?"#"+n.id:(n.className&&typeof n.className==="string"?"."+n.className.split(" ")[0]:n.tagName.toLowerCase());' +
                                            'ed.rect={x:Math.round(rc.x),y:Math.round(rc.y),w:Math.round(rc.width),h:Math.round(rc.height)};' +
                                        '}' +
                                        '_vis.push(ed);' +
                                    '}' +
                                '}' +
                            '}' +
                            'var ch=n.children||[];for(var j=0;j<ch.length;j++)_wk(ch[j]);' +
                            'if(n.shadowRoot)_wk(n.shadowRoot);' +
                        '}' +
                        '_wk(document);' +
                        '_wqR={success:true,visibleElements:_vis.slice(0,1000),note:"Visible elements from widget"};' +
                    '}else if(_wqAct==="click"){' +
                        'var _el=_wqArgs.selector?document.querySelector(_wqArgs.selector):' +
                            '(_wqArgs.x!==undefined?document.elementFromPoint(_wqArgs.x,_wqArgs.y):null);' +
                        'if(!_el){_wqR={success:false,error:"Element not found: "+(_wqArgs.selector||_wqArgs.x+","+_wqArgs.y)};}' +
                        'else{_el.click();var _ci=_el.tagName.toLowerCase();if(_el.id)_ci+="#"+_el.id;' +
                            '_wqR={success:true,message:"Clicked "+_ci+" in widget"};}' +
                    '}else if(_wqAct==="fill"){' +
                        'var _el=_wqArgs.selector?document.querySelector(_wqArgs.selector):' +
                            '(_wqArgs.x!==undefined?document.elementFromPoint(_wqArgs.x,_wqArgs.y):null);' +
                        'if(!_el){_wqR={success:false,error:"Element not found: "+(_wqArgs.selector||_wqArgs.x+","+_wqArgs.y)};}' +
                        'else{_el.value=_wqArgs.value;_el.dispatchEvent(new Event("input",{bubbles:true}));' +
                            '_el.dispatchEvent(new Event("change",{bubbles:true}));' +
                            'var _fi=_el.tagName.toLowerCase();if(_el.id)_fi+="#"+_el.id;' +
                            '_wqR={success:true,message:"Filled "+_fi+" in widget"};}' +
                    '}else if(_wqAct==="type"){' +
                        'var _el=_wqArgs.selector?document.querySelector(_wqArgs.selector):' +
                            '(_wqArgs.x!==undefined?document.elementFromPoint(_wqArgs.x,_wqArgs.y):null);' +
                        'if(!_el){_wqR={success:false,error:"Element not found: "+(_wqArgs.selector||_wqArgs.x+","+_wqArgs.y)};}' +
                        'else{_el.focus();var _tv=String(_wqArgs.value==null?"":_wqArgs.value);' +
                            'var _cur=_wqArgs.append?(_el.value||""):"";' +
                            'for(var _k=0;_k<_tv.length;_k++){var _ch=_tv.charAt(_k);' +
                                'try{_el.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:_ch}));}catch(_e1){}' +
                                '_cur+=_ch;_el.value=_cur;' +
                                '_el.dispatchEvent(new Event("input",{bubbles:true}));' +
                                'try{_el.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true,key:_ch}));}catch(_e2){}' +
                            '}' +
                            '_el.dispatchEvent(new Event("change",{bubbles:true}));' +
                            'var _ty=_el.tagName.toLowerCase();if(_el.id)_ty+="#"+_el.id;' +
                            '_wqR={success:true,message:"Typed into "+_ty+" in widget"};}' +
                    '}else{_wqR={success:false,error:"Unknown widget query action: "+_wqAct};}' +
                '}catch(_wqErr){_wqR={success:false,error:_wqErr.message};}' +
                'window.parent.postMessage({type:"widgetQueryResult",id:_wqId,result:_wqR},"*");' +
            '}' +
            // Serialize-for-capture handler. take_screenshot (060) asks the LIVE
            // sandbox to snapshot its CURRENT DOM so the capture preserves interactive
            // state (counters, loaded data) instead of re-running scripts from scratch.
            // Tiny + defensive; does not touch the executeTool bridge or height reporter.
            'if(e.data&&e.data.type==="__appagentSerializeForCapture"){' +
                'try{' +
                    'var _scH="<!doctype html>"+document.documentElement.outerHTML;' +
                    'var _scW=document.documentElement.scrollWidth;' +
                    'var _scHt=(document.body?document.body.scrollHeight:document.documentElement.scrollHeight);' +
                    'window.parent.postMessage({type:"__appagentSerializedDom",reqId:e.data.reqId,html:_scH,width:_scW,height:_scHt},"*");' +
                '}catch(_scErr){' +
                    'try{window.parent.postMessage({type:"__appagentSerializedDom",reqId:e.data.reqId,html:null,error:_scErr.message},"*");}catch(_scE2){}' +
                '}' +
            '}' +
        '});' +
    '<\/script>';
    var result = html.replace(/<\/head>/i, bridgeScript + '</head>');
    if (result === html) {
        result = bridgeScript + html;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Design tokens for widgets
// ---------------------------------------------------------------------------
// Widgets render inside widget-sandbox.html via document.write, so they start
// from a BLANK document with none of the app's stylesheets. These three blocks
// mirror the REAL values from src/css/00-tokens.css (light) and
// src/css/01-dark-theme.css (dark) so a widget can use var(--primary),
// var(--space-8), var(--font-sans)... exactly like the app does. Keep them in
// sync if a token value changes in those files.
//
// Deliberately NOT emitted: color-scheme. Setting it would flip UA defaults
// (form controls, scrollbars, default canvas background) inside every widget
// and make the many existing widgets that hardcode light colors unreadable in
// dark mode. Widgets opt in by painting with the tokens instead.
var WIDGET_TOKENS_STATIC =
    '--space-2:4px;--space-4:8px;--space-6:12px;--space-8:16px;--space-10:24px;' +
    '--text-caption:11px;--text-body-sm:12px;--text-body:13px;--text-body-lg:14px;--text-xl:16px;--text-2xl:18px;' +
    '--radius-sm:4px;--radius-md:6px;--radius-lg:8px;--radius-xl:12px;' +
    '--shadow-sm:0 1px 3px rgba(0,0,0,0.08);--shadow-md:0 2px 8px rgba(0,0,0,0.1);' +
    "--font-sans:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;" +
    "--font-mono:'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, 'Courier New', monospace;";

var WIDGET_TOKENS_LIGHT =
    '--primary:#293E6B;--primary-hover:#1e2f52;--primary-light:#e8f0fa;--accent:#0891b2;' +
    '--success:#059669;--warning:#d97706;--danger:#dc2626;--info:#3b82f6;' +
    '--border:#e5e7eb;--border-light:#f0f0f0;' +
    '--text-primary:#1f2937;--text-secondary:#6b7280;--text-muted:#9ca3af;--text-heading:#111827;--text-link:#2563eb;' +
    '--bg-main:#fff;--bg-light:#f9fafb;--bg-hover:#f3f4f6;--bg-code:#f5f5f5;--bg-secondary:#f3f4f6;';

// Only the tokens that actually differ under :root[data-theme="dark"] in
// 01-dark-theme.css. --shadow-sm/--shadow-md sit in the static block for their
// light values but DO have dark overrides, so they repeat here.
var WIDGET_TOKENS_DARK =
    '--primary:#6b8bc4;--primary-hover:#85a1d4;--primary-light:#1e2a42;--accent:#22d3ee;' +
    '--success:#34d399;--warning:#fbbf24;--danger:#f87171;--info:#60a5fa;' +
    '--border:#2e3138;--border-light:#252830;' +
    '--text-primary:#e5e7eb;--text-secondary:#9ca3af;--text-muted:#6b7280;--text-heading:#f3f4f6;--text-link:#60a5fa;' +
    '--bg-main:#111317;--bg-light:#181a1f;--bg-hover:#1f2228;--bg-code:#1a1d24;--bg-secondary:#1a1d24;' +
    '--shadow-sm:0 1px 3px rgba(0,0,0,0.3);--shadow-md:0 2px 8px rgba(0,0,0,0.4);';

// Prepend the token <style> so every widget inherits the app's design language.
// BOTH selectors are wrapped in :where(), which zeroes their specificity to
// (0,0,0). That is what actually lets a widget override a token: a bare
// :root[data-appagent-theme="dark"]{} is (0,2,0) and would beat the widget's own
// :root{} (0,1,0) no matter the document order, so in dark mode NOTHING could be
// overridden. At (0,0,0) every widget rule wins on specificity (:root{}, body{},
// .cls{}, inline style=""), while dark still beats light because it comes later
// inside this same sheet. The block is still injected FIRST so that even a
// widget rule with equally-zero specificity (:where(:root){}, *{}) wins on
// document order.
// The dark half keys off <html data-appagent-theme="dark">, which the sandbox
// sets from the loadWidget payload and flips again on every themeChange
// broadcast (see widget-sandbox.html + broadcastWidgetTheme in ui/240-layout.js).
// Idempotent: the &snap=1 capture path re-writes an ALREADY-injected serialized
// DOM back through writeWidgetHtml, and a second block would just be dead weight
// baked into every screenshot. The guard matches the <style> TAG, not the bare
// marker string, so a widget that merely MENTIONS data-appagent-tokens in its own
// copy (the widget-best-practices table does, verbatim) still gets tokens.
function injectWidgetTokens(html) {
    if (!html || typeof html !== 'string') return html;
    if (/<style[^>]*data-appagent-tokens/i.test(html)) return html;
    var style = '<style data-appagent-tokens="1">' +
        ':where(:root){' + WIDGET_TOKENS_STATIC + WIDGET_TOKENS_LIGHT + '}' +
        ':where(:root[data-appagent-theme="dark"]){' + WIDGET_TOKENS_DARK + '}' +
        '</style>';
    // Function replacement (not a string) so $-sequences in the CSS can never be
    // read as replacement patterns. The \s in the head pattern is load-bearing:
    // /<head[^>]*>/ ALSO matches <header ...>, which would drop the block into the
    // body of any head-less fragment that happens to open with a <header>.
    var result = html.replace(/<head(\s[^>]*)?>/i, function(m) { return m + style; });
    if (result === html) {
        // No <head> (widgets are often bare fragments): prepend and let the
        // parser hoist the <style> into the head it synthesizes.
        result = style + html;
    }
    return result;
}

// Write widget HTML to iframe via the manifest-sandboxed widget page
// CSP blocks inline scripts in the extension page, so we route through widget-sandbox.html
function writeWidgetHtml(iframe, html) {
    // Inject once, before the handshake, so the same string is posted no matter
    // how many ready messages arrive.
    var _html = injectWidgetTokens(html);
    function onMsg(e) {
        if (e.source !== iframe.contentWindow) return;
        if (e.data && e.data.type === 'widgetSandboxReady') {
            window.removeEventListener('message', onMsg);
            // Resolve the theme at POST time (not at call time) so a flip during
            // the handshake can't ship a stale value.
            iframe.contentWindow.postMessage({
                type: 'loadWidget',
                html: _html,
                theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
            }, '*');
        }
    }
    window.addEventListener('message', onMsg);
    iframe.src = 'widget-sandbox.html';
}

// Resolve a message source to the known widget IFRAME element it came from,
// or null when the source is not a widget. This is the authoritative identity
// check for widget→page postMessage traffic: the widget shim can claim any
// title/id it likes, but it cannot forge event.source.
function _resolveWidgetSource(source) {
    if (!source) return null;
    // Check light DOM iframes (inline chat widgets)
    var iframes = document.querySelectorAll('iframe.widget-iframe');
    for (var i = 0; i < iframes.length; i++) {
        try { if (iframes[i].contentWindow === source) return iframes[i]; } catch(e) {}
    }
    // Check shadow DOM iframes (dashboard widgets use shadow hosts)
    var hosts = document.querySelectorAll('.widget-shadow-host');
    for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
            var shadowIframes = hosts[i].shadowRoot.querySelectorAll('iframe.widget-iframe');
            for (var j = 0; j < shadowIframes.length; j++) {
                try { if (shadowIframes[j].contentWindow === source) return shadowIframes[j]; } catch(e) {}
            }
        }
    }
    return null;
}

// Validate that a message source is a known widget iframe's contentWindow.
// Kept as a thin wrapper — it has other callers (the widgetDownload handler
// below and the widgetToolCall handler).
function _isWidgetSource(source) {
    return !!_resolveWidgetSource(source);
}

// The widget id that owns a resolved widget iframe, or null.
// Inverse of getWidgetIframe (ui/300-iframe-management.js:12-25):
//   • inline chat widget  → .widget-inline[data-widget-id]
//   • dashboard widget    → the iframe lives inside a shadow root, so .closest()
//     cannot escape it; hop out via getRootNode().host (.widget-shadow-host,
//     appended into #dashboard-widget-content-<id>) and continue from there up
//     to .dashboard-widget[data-widget-id].
function _widgetIdForIframe(iframe) {
    if (!iframe) return null;
    try {
        var el = iframe.closest ? iframe.closest('[data-widget-id]') : null;
        if (!el) {
            var root = iframe.getRootNode ? iframe.getRootNode() : null;
            var host = (root && root.host) ? root.host : null;
            if (host && host.closest) el = host.closest('[data-widget-id]');
        }
        if (el) {
            var id = el.getAttribute('data-widget-id');
            if (id) return id;
        }
    } catch (e) {}
    return null;
}

// Listen for download requests from widgets (sandbox can't trigger downloads directly)
window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'widgetDownload') {
        if (!_isWidgetSource(event.source)) return;
        var fileId = event.data.fileId;
        var name = event.data.name || 'download';
        // Open file-download page in a new tab (not sandboxed, can trigger download)
        var url = chrome.runtime.getURL('file-download.html?id=' + encodeURIComponent(fileId) + '&name=' + encodeURIComponent(name));
        chrome.tabs.create({ url: url });
    }
});

// Listen for tool calls from widgets via postMessage (embedded widgets)
window.addEventListener('message', async function(event) {
    if (event.data && event.data.type === 'widgetToolCall') {
        // Security: only accept tool calls from known widget iframes
        var _srcIframe = _resolveWidgetSource(event.source);
        if (!_srcIframe) return;
        var id = event.data.id;
        var name = event.data.name;
        var args = event.data.args || {};
        var widgetName = event.data.widgetName || 'Widget';
        // The shim only forwards widgetName (the widget TITLE, which is not
        // unique). Derive the real widget id from the DOM instead, so tools like
        // start_chat can default to the CALLING widget without trusting the
        // widget's own claim. null when the iframe has no data-widget-id
        // ancestor (e.g. a preview/fullscreen container) — never fabricated.
        var _srcWidgetId = _widgetIdForIframe(_srcIframe);

        try {
            // executeTool checks permissions via requestProgrammaticToolApproval
            // For programmatic calls, approval uses notifications (not renderMessages) to preserve widget iframe
            // fromWidget: user-driven widget calls are not LLM-turn tool calls —
            // the sub-agent dispatch gates (tools/020-tool-execution.js,
            // worker/120-tool-routing.js) exempt them from the display-only
            // tool-call counter.
            var result = await executeTool(name, args, null, { chatId: currentChatId, widgetName: widgetName, widgetId: _srcWidgetId, fromWidget: true });

            // Persist screenshot to chat.screenshots map so screenshot_by_id can find it after reload
            // (NOT chat.messages — inserting there breaks tool_use/tool_result ordering for the API)
            if (result && result._screenshotMessage) {
                var ssMsg = result._screenshotMessage;
                if (ssMsg.screenshot_id) {
                    var ssChat = chats[currentChatId];
                    if (ssChat) {
                        if (!ssChat.screenshots) ssChat.screenshots = {};
                        ssChat.screenshots[ssMsg.screenshot_id] = { base64: ssMsg.base64, name: ssMsg.name, width: ssMsg.width, height: ssMsg.height, timestamp: ssMsg.timestamp, description: ssMsg.description };
                        if (ssMsg.file_id) registerFile(ssMsg.file_id, { type: 'screenshots_map', chatId: currentChatId });
                        saveChatsToStorage();
                    }
                }
                result.base64 = ssMsg.base64;
                result.width = ssMsg.width;
                result.height = ssMsg.height;
                result.screenshot_id = ssMsg.screenshot_id || result.screenshot_id;
                delete result._screenshotMessage;
            }

            if (result && result.success === false && result.error) {
                event.source.postMessage({ type: 'widgetToolResult', id: id, error: result.error }, '*');
            } else {
                event.source.postMessage({ type: 'widgetToolResult', id: id, result: result }, '*');
            }
        } catch (e) {
            event.source.postMessage({ type: 'widgetToolResult', id: id, error: e.message }, '*');
        }
    }
});

function renderWidgetContent(widget) {
    // Use dashboard-specific ID to avoid conflict with chat widget containers
    var container = document.getElementById('dashboard-widget-content-' + widget.id);
    if (!container) {
        console.warn('Dashboard widget container not found:', 'dashboard-widget-content-' + widget.id);
        return;
    }
    if (!widget.html) {
        console.warn('Widget has no HTML:', widget);
        container.innerHTML = '<div style="padding: var(--space-9);color:var(--text-muted);text-align:center;">No content available. Try regenerating.</div>';
        return;
    }
    
    // Create shadow DOM for isolation
    var shadowHost = document.createElement('div');
    shadowHost.className = 'widget-shadow-host';
    container.innerHTML = '';
    container.appendChild(shadowHost);
    
    var shadow = shadowHost.attachShadow({ mode: 'open' });
    var iframe = document.createElement('iframe');
    iframe.className = 'widget-iframe';
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:var(--bg-white);';
    iframe.sandbox = 'allow-scripts allow-same-origin allow-forms';

    shadow.appendChild(iframe);
    writeWidgetHtml(iframe, injectWidgetBridge(widget.html, widget.title, widget.id));
}

// Add a chat widget to a dashboard ('main' = dashboard page, 'home' = home page)
async function addWidgetToDashboard(widgetId, event, dashboard) {
    if (event) event.stopPropagation();

    // Get widget from chat widgets - try multiple sources
    var chatWidget = null;
    var chatWidgetsList = getWidgetsForChat(currentChatId);
    chatWidget = chatWidgetsList.find(function(w) { return w.id === widgetId; });

    // Also try getWidgetById as fallback
    if (!chatWidget) {
        chatWidget = getWidgetById(widgetId);
    }

    if (!chatWidget) {
        showSnackbar('Widget not found', 'error');
        return;
    }

    if (!chatWidget.html) {
        showSnackbar('Widget has no content', 'error');
        return;
    }

    // Find the prompt from the source chat
    // IMPORTANT: Always use chatWidget.chatId if it exists - this preserves the original chat reference
    var prompt = null;
    var chatId = chatWidget.chatId || currentChatId;
    var msgIndex = chatWidget.msgIndex;
    if (chatId && chats[chatId] && msgIndex !== undefined) {
        var chat = chats[chatId];
        // Find the last user message before the widget
        for (var i = msgIndex - 1; i >= 0; i--) {
            if (chat.messages[i] && chat.messages[i].role === 'user') {
                prompt = chat.messages[i].content;
                break;
            }
        }
    }
    
    dashboard = dashboard === 'home' ? 'home' : 'main';

    // Find available grid position for new widget (occupancy of the TARGET dashboard only)
    initGridOccupancy(dashboard);
    var pos = findNextAvailablePosition(4, 4);

    // Create dashboard widget from chat widget
    var dashWidget = {
        id: widgetId,
        title: chatWidget.title || 'Widget',
        prompt: prompt,
        conversation: [],
        html: chatWidget.html,
        width: 4,
        height: 4,
        gridX: pos.gridX,
        gridY: pos.gridY,
        createdAt: chatWidget.createdAt || Date.now(),
        chatId: chatId,
        msgIndex: msgIndex,
        error: null,
        isLoading: false,
        dashboard: dashboard
    };

    dashboardWidgets[widgetId] = dashWidget;
    await saveDashboardWidget(dashWidget);

    // Update pin button states + re-render whichever dashboard is visible
    updateWidgetPinButtons(widgetId);
    refreshVisibleDashboards();

    // Update sidebar to reflect dashboard state
    renderVersionSidebar();

    showSnackbar(dashboard === 'home' ? 'Widget pinned to Home' : 'Widget pinned to Dashboard', 'success');
    return dashWidget;
}

// Patch the pin buttons for a widget in place (inline chat / fullscreen spots).
// Sidebar spots re-render wholesale via renderVersionSidebar/renderWidgetSidebar.
function updateWidgetPinButtons(widgetId) {
    var pinned = !!dashboardWidgets[widgetId];
    document.querySelectorAll('.widget-dashboard-btn[data-widget-id="' + widgetId + '"]').forEach(function(btn) {
        btn.classList.toggle('on-dashboard', pinned);
        btn.innerHTML = pinned ? UI_ICONS.pinFilled : UI_ICONS.pin;
        btn.title = pinned ? 'Pinned — click to change' : 'Pin to dashboard…';
    });
}

// Small popover letting the user choose the pin target (Home / Dashboard / Unpin).
function showWidgetPinMenu(widgetId, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    closeWidgetPinMenu();
    var current = dashboardWidgets[widgetId] ? widgetDashboardOf(dashboardWidgets[widgetId]) : null;
    var menu = document.createElement('div');
    menu.className = 'widget-pin-menu';
    menu.id = 'widget-pin-menu';
    var html = '<button onclick="pinWidgetTo(\'' + widgetId + '\', \'home\')"' + (current === 'home' ? ' class="active"' : '') + '>' + UI_ICONS.pin + '<span>Pin to Home</span></button>';
    html += '<button onclick="pinWidgetTo(\'' + widgetId + '\', \'main\')"' + (current === 'main' ? ' class="active"' : '') + '>' + UI_ICONS.pin + '<span>Pin to Dashboard</span></button>';
    if (current) {
        html += '<button class="danger" onclick="pinWidgetTo(\'' + widgetId + '\', \'none\')">' + UI_ICONS.close + '<span>Unpin</span></button>';
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);
    var x = event ? event.clientX : window.innerWidth / 2;
    var y = event ? event.clientY : window.innerHeight / 2;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y + 6, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    setTimeout(function() {
        document.addEventListener('click', closeWidgetPinMenu, { once: true });
    }, 0);
}

function closeWidgetPinMenu() {
    var m = document.getElementById('widget-pin-menu');
    if (m) m.remove();
}

// Pin/move/unpin a widget. target: 'main' | 'home' | 'none'.
async function pinWidgetTo(widgetId, target) {
    closeWidgetPinMenu();
    if (target === 'none') {
        await removeWidgetFromDashboard(widgetId);
        return;
    }
    if (target !== 'home' && target !== 'main') {
        // Reject unknown targets instead of silently coercing them to 'main'.
        // Known callers pass literals only: the pin menu (:1007-1010) and
        // executePinWidget (tools/080-widget-tools.js:165, pre-validated).
        console.warn('pinWidgetTo: unknown target "' + target + '"');
        if (typeof showSnackbar === 'function') showSnackbar('Unknown pin target: ' + String(target), 'error');
        return null;
    }
    var existing = dashboardWidgets[widgetId];
    if (existing) {
        if (widgetDashboardOf(existing) !== target) {
            existing.dashboard = target;
            // Re-place in the target grid to avoid overlapping its widgets
            initGridOccupancy(target);
            var pos = findNextAvailablePosition(existing.width || 4, existing.height || 4);
            existing.gridX = pos.gridX;
            existing.gridY = pos.gridY;
            await saveDashboardWidget(existing);
            refreshVisibleDashboards();
            showSnackbar(target === 'home' ? 'Widget moved to Home' : 'Widget moved to Dashboard', 'success');
        }
        updateWidgetPinButtons(widgetId);
        renderVersionSidebar();
        return existing;
    }
    return addWidgetToDashboard(widgetId, null, target);
}

// Remove a widget from the dashboard
async function removeWidgetFromDashboard(widgetId, event) {
    if (event) event.stopPropagation();
    
    var removedFrom = dashboardWidgets[widgetId] ? widgetDashboardOf(dashboardWidgets[widgetId]) : 'main';
    if (dashboardWidgets[widgetId]) {
        await deleteDashboardWidget(widgetId);
    }
    
    // Remove the widget element from dashboard DOM if present (without re-rendering other widgets)
    var dashboardWidgetEl = document.querySelector('.dashboard-widget[data-widget-id="' + widgetId + '"]');
    if (dashboardWidgetEl) {
        // Clean up widget iframe event listeners to prevent memory leaks
        var iframe = dashboardWidgetEl.querySelector('iframe');
        if (iframe && iframe.__widgetCleanup) iframe.__widgetCleanup();
        dashboardWidgetEl.remove();
        
        // Show empty state if no widgets left on the dashboard it was removed from
        var container = dashboardGridEl(removedFrom);
        if (container && dashboardWidgetsFor(removedFrom).length === 0) {
            container.innerHTML = removedFrom === 'home' ? '' : '<div class="dashboard-empty"><span class="dashboard-empty-icon">' + UI_ICONS.widget + '</span><p>No widgets yet</p><p class="dashboard-empty-hint">Add widgets to your dashboard using prompts.</p></div>';
        }
    }
    // Hide the home section entirely when its last widget is unpinned
    if (removedFrom === 'home' && typeof renderHomeDashboard === 'function') renderHomeDashboard();
    
    // Update pin button state in chat view
    updateWidgetPinButtons(widgetId);
    // Update sidebar
    renderVersionSidebar();
}

// Render the home-page dashboard section (hidden when no 'home' widgets are pinned)
function renderHomeDashboard() {
    var section = document.getElementById('home-dashboard-section');
    if (!section) return;
    var widgets = dashboardWidgetsFor('home');
    if (widgets.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';
    var expanded = appStorage.getItem('homeDashboardExpanded') === 'true';
    section.classList.toggle('expanded', expanded);
    updateHomeDashboardExpandBtn(expanded);
    renderDashboard('home');
}

function toggleHomeDashboardExpanded() {
    var section = document.getElementById('home-dashboard-section');
    if (!section) return;
    var expanded = !section.classList.contains('expanded');
    section.classList.toggle('expanded', expanded);
    appStorage.setItem('homeDashboardExpanded', expanded);
    updateHomeDashboardExpandBtn(expanded);
}

function updateHomeDashboardExpandBtn(expanded) {
    var btn = document.getElementById('home-dashboard-expand-btn');
    if (!btn) return;
    btn.innerHTML = UI_ICONS.chevronDown || '';
    btn.classList.toggle('expanded', expanded);
    btn.title = expanded ? 'Collapse' : 'Expand';
}

// Show widget in the browser/iframe panel
function showWidgetInPanel(widgetId) {
    var widget = getWidgetById(widgetId);
    if (!widget) { showSnackbar('Widget not found', 'error'); return; }
    openWidgetInIframePanel(widgetId);
}

function openAddWidgetModal() {
    // Close dashboard panel and show chat
    var dashboardPanel = document.getElementById('dashboard-panel');
    if (dashboardPanel) dashboardPanel.style.display = 'none';
    
    showChatView();

    // Create a new chat for widget creation
    newChat();
    
    // Set a hint in the input
    var input = document.getElementById('message-input');
    if (input) {
        input.placeholder = 'Describe the widget you want to create...';
        input.focus();
    }
}

// Open widget editor using the main chat UI
function openWidgetInChatMode(widget, isNew) {
    // Hide dashboard panel
    var dashboardPanel = document.getElementById('dashboard-panel');
    if (dashboardPanel) dashboardPanel.style.display = 'none';
    
    // Show main area (it should already be visible, but ensure it)
    showChatView();

    // Show widget mode indicator in main header
    var mainHeader = document.querySelector('.main-header');
    if (mainHeader) {
        mainHeader.classList.add('widget-mode');
        mainHeader.dataset.widgetId = widget.id;
        mainHeader.dataset.widgetTitle = widget.title || 'New Widget';
    }
    
    // Update header title to show widget name
    var headerTitle = document.getElementById('header-chat-title');
    if (headerTitle) {
        headerTitle.innerHTML = '<span class="widget-mode-badge">Widget</span> ' + escapeHtml(widget.title || 'New Widget');
    }
    
    // Show back to dashboard button
    var backBtn = document.getElementById('widget-back-btn');
    if (!backBtn && mainHeader) {
        backBtn = document.createElement('button');
        backBtn.id = 'widget-back-btn';
        backBtn.className = 'skills-back-btn widget-back-btn';
        backBtn.title = 'Back to Dashboard';
        backBtn.innerHTML = '<span class="back-icon"></span>';
        backBtn.onclick = closeWidgetChatMode;
        mainHeader.insertBefore(backBtn, mainHeader.firstChild);
    }
    if (backBtn) backBtn.style.display = 'flex';
    
    // Render widget conversation in main chat
    renderWidgetInChat(widget);
    
    // Focus input
    var input = document.getElementById('message-input');
    if (input) input.focus();
}

// NAV-H3: idempotent teardown of ONLY the widget-chat-mode chrome that
// openWidgetInChatMode paints on the SHARED .main-header (widget-mode class +
// dataset, #widget-back-btn's inline display) plus the two editing pointers that
// route the composer to sendWidgetMessage (app/040-send-message.js:150). Exists so
// browser Back, which never runs closeWidgetChatMode, can clean that chrome up too
// (handlePopState in core/040-hooks-history.js calls it for every branch).
// DELIBERATELY EXCLUDES the #header-chat-title restore: popstate calls this on EVERY
// entry, and a .textContent write there would flatten the rich header that
// updateChatTitleHeader builds (sub-agent badge + clickable progress pill,
// ui/170-chat-management.js:986-990) and would write the literal 'New Chat' where that
// function writes '' (:913) — which breaks the .header-chat-title:empty rules that hide
// the rename/pin buttons (css/04-header.css:54,65). The title restore therefore stays in
// closeWidgetChatMode, the only caller that KNOWS the title holds a widget name.
// Safe to call when widget mode was never entered: every step is null-guarded.
function exitWidgetModeChrome() {
    currentEditingWidget = null;
    activeWidgetStreamingId = null;
    
    // Hide widget mode indicator
    var mainHeader = document.querySelector('.main-header');
    if (mainHeader) {
        mainHeader.classList.remove('widget-mode');
        delete mainHeader.dataset.widgetId;
        delete mainHeader.dataset.widgetTitle;
    }
    
    // Hide back button
    var backBtn = document.getElementById('widget-back-btn');
    if (backBtn) backBtn.style.display = 'none';
}

function closeWidgetChatMode() {
    var widget = dashboardWidgets[currentEditingWidget];
    
    // If it's a new widget with no content, remove it
    if (widget && !widget.html && (!widget.conversation || widget.conversation.length === 0)) {
        delete dashboardWidgets[currentEditingWidget];
    }
    
    // Clears currentEditingWidget/activeWidgetStreamingId and the .main-header chrome —
    // unchanged statements in unchanged order, now shared with browser Back.
    exitWidgetModeChrome();
    
    // Restore chat title. Stays HERE rather than in the shared helper above: this is
    // the only caller that knows #header-chat-title currently holds a widget name.
    var headerTitle = document.getElementById('header-chat-title');
    if (headerTitle && chats[currentChatId]) {
        // '' (never a literal placeholder) when the chat has no title, matching
        // updateChatTitleHeader (ui/170-chat-management.js:913) — a non-empty
        // 'New Chat' here defeated the .header-chat-title:empty rules that hide
        // the rename/pin buttons (css/04-header.css:54,65).
        headerTitle.textContent = chats[currentChatId].title || '';
    }
    
    // Show dashboard. Widget mode pushed no history entry of its own, so the current
    // entry is still the 'dashboard' one we came from — openDashboardView's
    // pushHistoryState('dashboard', null) therefore hits the isSameEntry dedupe in
    // pushHistoryState (core/040-hooks-history.js) and replaces instead of stacking a
    // forward-duplicate. No one-shot flag needed.
    openDashboardView();
}

function renderWidgetInChat(widget) {
    var container = document.getElementById('messages');
    if (!container) return;
    
    var conversation = widget ? (widget.conversation || []) : [];
    
    if (conversation.length === 0) {
        container.innerHTML = '<div class="widget-chat-empty">Describe the widget you want to create...</div>';
        return;
    }
    
    var html = '';
    conversation.forEach(function(msg, idx) {
        if (msg.role === 'user') {
            html += '<div class="message user"><div class="message-content"><span class="user-text">' + escapeHtml(msg.content) + '</span></div></div>';
        } else if (msg.role === 'assistant') {
            var content = msg.content || '';
            if (idx === conversation.length - 1 && widget && widget.isStreaming) {
                html += '<div class="message assistant streaming"><div class="message-content">' + formatContent(content) + '<span class="streaming-cursor"></span></div></div>';
            } else {
                html += '<div class="message assistant"><div class="message-content">' + formatContent(content) + '</div></div>';
            }
        }
    });
    
    if (widget && widget.isStreaming && (conversation.length === 0 || conversation[conversation.length - 1].role === 'user')) {
        html += '<div class="message assistant streaming"><div class="message-content"><span class="streaming-cursor"></span></div></div>';
    }
    
    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

function closeWidgetEditorPanel() {
    var widget = dashboardWidgets[currentEditingWidget];
    
    // If it's a new widget with no content, remove it
    if (widget && !widget.html && (!widget.conversation || widget.conversation.length === 0)) {
        delete dashboardWidgets[currentEditingWidget];
    }
    
    currentEditingWidget = null;
    activeWidgetStreamingId = null;
    
    var dashboardPanel = document.getElementById('dashboard-panel');
    if (dashboardPanel) { 
        dashboardPanel.style.display = 'flex'; 
        refreshVisibleDashboards(); 
    }
}

// Revert widget to a previous version from history
async function revertWidgetToHistory(widgetId, historyIndex) {
    var widget = dashboardWidgets[widgetId];
    if (!widget || !widget.history || !widget.history[historyIndex]) {
        showSnackbar('History version not found', 'error');
        return;
    }
    
    var historyEntry = widget.history[historyIndex];
    
    // Save current html as a safety snapshot before reverting — but only when
    // it would actually preserve something: skip when reverting to identical
    // content (no-op revert), and skip when the current html already exists
    // anywhere in history (bouncing A<->B must not stack duplicate entries).
    // saveDashboardWidget is called with skipHistory=true below, so its own
    // dedup guard and cap never run here — we enforce both ourselves.
    if (widget.html && widget.html !== historyEntry.html) {
        var alreadyPreserved = widget.history.some(function(entry) {
            return entry && entry.html === widget.html;
        });
        if (!alreadyPreserved) {
            widget.history.push({
                html: widget.html,
                timestamp: Date.now(),
                prompt: 'Auto-saved before revert'
            });
            // Keep only last 10 versions — mirrors the cap in saveDashboardWidget
            // (src/js/ui/020-dashboard.js); no shared constant exists, keep in sync.
            if (widget.history.length > 10) {
                widget.history = widget.history.slice(-10);
            }
        }
    }
    
    // Restore the old HTML
    widget.html = historyEntry.html;
    widget.error = null;
    
    await saveDashboardWidget(widget, true); // Skip history tracking since we're managing it manually
    refreshVisibleDashboards();
    showSnackbar('Widget reverted to previous version', 'success');
}

// Show widget history panel
function showWidgetHistory(widgetId) {
    var widget = dashboardWidgets[widgetId];
    if (!widget || !widget.history || widget.history.length === 0) {
        showSnackbar('No history available for this widget', 'info');
        return;
    }
    
    var html = '<div class="widget-history-modal">';
    html += '<div class="widget-history-header"><span>Widget History</span><button onclick="closeWidgetHistory()">×</button></div>';
    html += '<div class="widget-history-list">';
    
    widget.history.forEach(function(entry, idx) {
        var date = new Date(entry.timestamp);
        var timeStr = date.toLocaleString();
        html += '<div class="widget-history-item" onclick="revertWidgetToHistory(\'' + widgetId + '\', ' + idx + '); closeWidgetHistory();">';
        html += '<div class="widget-history-time">' + timeStr + '</div>';
        html += '<div class="widget-history-prompt">' + escapeHtml((entry.prompt || 'No prompt').substring(0, 100)) + '</div>';
        html += '</div>';
    });
    
    html += '</div></div>';
    
    var modal = document.createElement('div');
    modal.id = 'widget-history-modal-overlay';
    modal.className = 'modal-overlay show';
    modal.innerHTML = html;
    modal.onclick = function(e) { if (e.target === modal) closeWidgetHistory(); };
    document.body.appendChild(modal);
}

function closeWidgetHistory() {
    var modal = document.getElementById('widget-history-modal-overlay');
    if (modal) modal.remove();
}

// Run a prompt for a widget in the background (for batch regeneration)
// Creates a real chat that stays in history, similar to single widget regenerate
async function runWidgetPrompt(widget, prompt) {
    if (!widget || !prompt) return;

    // Store original context to restore after
    var originalEditingWidget = currentEditingWidget;

    // Get history from source chat if available
    var historyMessages = [];
    var sourceChatTitle = widget.title || 'Widget Regeneration';

    if (widget.chatId && chats[widget.chatId]) {
        var sourceChat = chats[widget.chatId];
        if (sourceChat.title && sourceChat.title !== 'New Chat') {
            sourceChatTitle = sourceChat.title;
        }
        // Find the last user message before the widget was created
        var msgIndex = widget.msgIndex || sourceChat.messages.length;
        var lastUserMsgIndex = -1;
        for (var i = msgIndex - 1; i >= 0; i--) {
            if (sourceChat.messages[i] && sourceChat.messages[i].role === 'user') {
                lastUserMsgIndex = i;
                break;
            }
        }
        // Copy all messages BEFORE the last user message as history
        if (lastUserMsgIndex > 0) {
            for (var i = 0; i < lastUserMsgIndex; i++) {
                var msg = sourceChat.messages[i];
                if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'system') {
                    var clonedMsg = JSON.parse(JSON.stringify(msg));
                    delete clonedMsg.isStreaming;
                    historyMessages.push(clonedMsg);
                }
            }
        }
    }

    // Create a new real chat for this regeneration
    var newChatId = generateId();
    chats[newChatId] = {
        id: newChatId,
        title: sourceChatTitle,
        messages: [],
        createdAt: Date.now(),
        isTemporary: false
    };

    // Copy cached tool results from source chat
    if (widget.chatId && chats[widget.chatId] && chats[widget.chatId].cachedToolResults) {
        chats[newChatId].cachedToolResults = Object.assign({}, chats[widget.chatId].cachedToolResults);
    }

    // Add history messages
    for (var i = 0; i < historyMessages.length; i++) {
        chats[newChatId].messages.push(historyMessages[i]);
    }

    // Add the prompt as user message
    chats[newChatId].messages.push({ role: 'user', content: prompt });

    // FLUX-QW2: do NOT swap the currentChatId global — the old swap was held
    // across `await runAgent()`, so a user who switched chats during the run
    // was clobbered back to the stale id afterwards and the next send went to
    // the wrong chat. runAgent(overrideChatId) takes the target explicitly.
    // B-B2: register against the new chat so concurrent regens don't collide.
    setPendingWidgetRegeneration(newChatId, widget.id);

    // Set widget as loading
    widget.isLoading = true;
    widget.isStreaming = true;
    activeWidgetStreamingId = widget.id;

    // Save the new chat
    saveChatsToStorage();
    renderChatList();

    // Run agent and wait for completion (explicit chat — no global swap).
    paused = false;
    await runAgent(newChatId);

    // Update widget to link to new chat
    widget.chatId = newChatId;
    widget.isLoading = false;
    widget.isStreaming = false;
    activeWidgetStreamingId = null;
    // B-B2: targeted clear in case the agent didn't call html_widget (failure / timeout).
    clearPendingWidgetRegeneration(newChatId);
    await saveDashboardWidget(widget);

    // Save chat after agent completes
    saveChatsToStorage();
    renderChatList();

    // Restore original context (currentChatId was never swapped — FLUX-QW2).
    currentEditingWidget = originalEditingWidget;
}

async function confirmDeleteDashboardWidget(widgetId) {
    var widget = dashboardWidgets[widgetId];
    if (!widget) return;
    
    var confirmed = await showConfirmModal('Delete Widget', 'Are you sure you want to delete "' + escapeHtml(widget.title) + '"?', 'danger');
    if (!confirmed) return;
    
    // Close widget editor if open for this widget
    if (currentEditingWidget === widgetId) {
        currentEditingWidget = null;
        var dashboardPanel = document.getElementById('dashboard-panel');
        if (dashboardPanel) dashboardPanel.style.display = 'flex';
    }
    
    await deleteDashboardWidget(widgetId);
    
    // Remove just this widget's DOM element instead of re-rendering all widgets
    var widgetEl = document.querySelector('.dashboard-widget[data-widget-id="' + widgetId + '"]');
    if (widgetEl) {
        // Clean up widget iframe event listeners to prevent memory leaks
        var iframe = widgetEl.querySelector('iframe');
        if (iframe && iframe.__widgetCleanup) iframe.__widgetCleanup();
        widgetEl.remove();
    }

    // Show empty state if no widgets left on this widget's dashboard
    var container = dashboardGridEl(widgetDashboardOf(widget));
    if (container && dashboardWidgetsFor(widgetDashboardOf(widget)).length === 0) {
        container.innerHTML = widgetDashboardOf(widget) === 'home' ? '' : '<div class="dashboard-empty"><span class="dashboard-empty-icon">' + UI_ICONS.widget + '</span><p>No widgets yet</p><p class="dashboard-empty-hint">Add widgets to your dashboard using prompts.</p></div>';
    }
    if (widgetDashboardOf(widget) === 'home' && typeof renderHomeDashboard === 'function') renderHomeDashboard();
    
    showSnackbar('Widget deleted', 'success');
}

function openDashboardInNewTab() {
    // Open AppAgent in standalone dashboard mode (same page, no sidebar/header)
    var widgetList = Object.values(dashboardWidgets);
    if (widgetList.length === 0) {
        showSnackbar('No widgets to display', 'error');
        return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html') + '?standalone=dashboard' });
}

function exportDashboard() {
    var widgetList = Object.values(dashboardWidgets);
    if (widgetList.length === 0) {
        showSnackbar('No widgets to export', 'error');
        return;
    }
    
    var exportData = {
        type: 'appagent-dashboard',
        version: 1,
        widgets: widgetList
    };
    
    var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'dashboard-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showSnackbar('Dashboard exported', 'success');
}

async function importDashboard() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async function(e) {
        var file = e.target.files[0];
        if (!file) return;
        
        try {
            var text = await file.text();
            var data = JSON.parse(text);
            
            var imported = 0;
            var updated = 0;
            
            if (data.type === 'appagent-dashboard-widget' && data.widget) {
                // Single widget import
                var widget = data.widget;
                if (dashboardWidgets[widget.id]) {
                    updated++;
                } else {
                    imported++;
                }
                await saveDashboardWidget(widget);
            } else if (data.type === 'appagent-dashboard' && data.widgets) {
                // Full dashboard import
                for (var i = 0; i < data.widgets.length; i++) {
                    var widget = data.widgets[i];
                    if (dashboardWidgets[widget.id]) {
                        updated++;
                    } else {
                        imported++;
                    }
                    await saveDashboardWidget(widget);
                }
            } else {
                showSnackbar('Invalid dashboard file format', 'error');
                return;
            }
            
            refreshVisibleDashboards();
            var msg = 'Imported ' + imported + ' widget(s)';
            if (updated > 0) msg += ', updated ' + updated;
            showSnackbar(msg, 'success');
        } catch (e) {
            showSnackbar('Failed to import: ' + e.message, 'error');
        }
    };
    input.click();
}

function getSkillsSummaryForPrompt() {
    var skillList = Object.values(skills);
    if (skillList.length === 0) return '';

    // Only include active skills in the system prompt — and hide devOnly
    // skills outside extension dev mode (isSkillDevHidden, core/140-skills-
    // engine.js). Keep in sync with the SW stub in worker/020-page-stubs.js.
    var activeList = skillList.filter(function(s) {
        if (!activeSkills[s.id]) return false;
        if (typeof isSkillDevHidden === 'function' && isSkillDevHidden(s.id)) return false;
        return true;
    });

    if (activeList.length === 0) return '';

    var summary = '\n\nACTIVE SKILLS:\n';
    activeList.forEach(function(skill) {
        var desc = skill.description ? ': ' + skill.description : '';
        summary += '- ' + (skill.name || skill.id) + ' (id: ' + skill.id + ')' + desc + '\n';
    });

    return summary;
}

// WIPE-GUARD: saves are forbidden until a load has SUCCEEDED. If hydration
// fails or is skipped (broken bundle, IDB error), in-memory `chats` is empty
// and a save would erase every stored chat. Set ONLY in the load onsuccess
// handler below.
var _chatsHydrated = false;

// PR 4 (RFC addendum §5): the page-side known-chat-id set and the
// wipe-guard-2/3 per-boot delete caps are RETIRED — dead since PR 3 made
// saves upsert-only (no delete-pass consumed them any more). The
// _chatsHydrated save-gate above is a DIFFERENT guard and stays.

// Post-retry storage failure: chat history genuinely could not be read in
// this realm (dead connection that survived the withStore retry, blocked
// open, quota/IO error). Surface a persistent error snackbar instead of
// silently rendering an empty chat list — the wipe-guard keeps saves blocked
// so nothing is lost, but the user must know WHY their history is missing.
function showStorageUnavailableNotice(err) {
    console.error('Chat storage unavailable:', err);
    try {
        if (typeof showSnackbar === 'function') {
            showSnackbar('Storage unavailable — chat history could not be loaded. Try restarting Chrome.', 'error');
        }
    } catch (e) { /* notice must never break init */ }
}

// =============================================================
// GRACEFUL-DEGRADATION (empty-chat-list root fix).
// IDB is the source of truth for chat history, but after a long OS suspend
// Chromium can wedge the origin's IDB backing store so open() hangs. The old
// fallback rendered a SILENTLY EMPTY chat list — the user thought their history
// was gone. Instead we (1) mirror a lightweight {id,title,updatedAt} index of
// every chat to chrome.storage.local on each successful save, and (2) on a load
// failure / boot-deadline timeout render THAT mirror as a READ-ONLY list under
// a clear banner, auto-retry opening the DB with backoff, and swap in the real
// data on recovery.
// =============================================================
var CHAT_INDEX_MIRROR_KEY = 'appagent_chat_index';
var _storageDegraded = false;          // true while IDB is unavailable
var _degradedChatIndex = null;         // cached mirror array while degraded
var _storageRetryTimer = null;
var _storageRetryDelay = 0;
var STORAGE_RETRY_BASE_MS = 2000;      // first retry after 2s
var STORAGE_RETRY_MAX_MS = 60000;      // backoff cap: 2s,4s,8s,…,60s

// Mirror a lightweight index of every persisted chat to chrome.storage.local.
// Called after each successful save. Best-effort — never throws into the save
// path. Visibility matches renderChatList (hide sub-agent + un-revealed
// background chats) so the degraded list shows the same set the user sees.
function mirrorChatIndexToLocal() {
    try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        var idx = [];
        Object.keys(chats).forEach(function(id) {
            var c = chats[id];
            if (!c || !c.messages || c.messages.length === 0) return;
            if (c.isSubAgent) return;
            if (c.isBackground && !c._revealed && !c.actionId) return;
            idx.push({
                id: id,
                title: String(c.title || 'Untitled').slice(0, 120),
                updatedAt: c.updatedAt || c.createdAt || 0,
                pinned: !!c.pinned
            });
        });
        var payload = {};
        payload[CHAT_INDEX_MIRROR_KEY] = idx;
        chrome.storage.local.set(payload);
    } catch (e) { /* mirror is best-effort — never break save */ }
}

// Enter degraded mode: show the mirror read-only + banner, start the retry
// loop. Idempotent — a second call while already degraded is a no-op (the retry
// loop is already running), so loadChatsFromStorage's catch can call it on every
// failed retry without resetting the backoff.
function enterStorageDegradedMode(err) {
    if (_storageDegraded) return; // idempotent — retry loop already running; fire the notice once
    _storageDegraded = true;
    showStorageUnavailableNotice(err);
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(CHAT_INDEX_MIRROR_KEY, function(res) {
                _degradedChatIndex = (res && Array.isArray(res[CHAT_INDEX_MIRROR_KEY])) ? res[CHAT_INDEX_MIRROR_KEY] : [];
                try { renderChatList(); } catch (e) {}
            });
        } else {
            _degradedChatIndex = [];
            try { renderChatList(); } catch (e) {}
        }
    } catch (e) {
        _degradedChatIndex = [];
        try { renderChatList(); } catch (e2) {}
    }
    _storageRetryDelay = STORAGE_RETRY_BASE_MS;
    _scheduleStorageRetry();
}

function _scheduleStorageRetry() {
    if (_storageRetryTimer) { try { clearTimeout(_storageRetryTimer); } catch (e) {} }
    _storageRetryTimer = setTimeout(function() {
        _storageRetryTimer = null;
        // Retry a real load. loadChatsFromStorage reopens the DB (its withStore
        // drops a dead cached handle first) and sets _chatsHydrated on success.
        Promise.resolve().then(function() { return loadChatsFromStorage(); }).then(function() {
            if (_chatsHydrated) { exitStorageDegradedMode(); return; }
            _storageRetryDelay = Math.min(_storageRetryDelay * 2, STORAGE_RETRY_MAX_MS);
            _scheduleStorageRetry();
        }).catch(function() {
            _storageRetryDelay = Math.min(_storageRetryDelay * 2, STORAGE_RETRY_MAX_MS);
            _scheduleStorageRetry();
        });
    }, _storageRetryDelay);
}

function exitStorageDegradedMode() {
    if (!_storageDegraded) return;
    _storageDegraded = false;
    _degradedChatIndex = null;
    if (_storageRetryTimer) { try { clearTimeout(_storageRetryTimer); } catch (e) {} _storageRetryTimer = null; }
    try { if (typeof showSnackbar === 'function') showSnackbar('Storage recovered — chat history restored.', 'success'); } catch (e) {}
    try { renderChatList(); } catch (e) {}
    try { if (typeof renderAllActionPlacements === 'function') renderAllActionPlacements(); } catch (e) {}
    try { if (typeof renderJobsBadge === 'function') renderJobsBadge(); } catch (e) {}
    mirrorChatIndexToLocal();
}

// Build the read-only degraded chat-list markup (banner + mirror rows). Called
// by renderChatList while _storageDegraded. Rows are non-interactive (no
// selectChat / dropdown wiring) — history is view-only until the DB recovers.
function buildDegradedChatListHtml() {
    var banner =
        '<div class="storage-degraded-banner" style="padding:12px;margin:8px;border-radius:8px;background:rgba(230,150,30,0.12);border:1px solid rgba(230,150,30,0.4);color:var(--text-primary,inherit);font-size:var(--text-sm,13px);line-height:1.4;">' +
            '<div style="font-weight:600;margin-bottom:4px;">Storage unavailable — your history is safe, retrying…</div>' +
            '<div style="color:var(--text-muted,#999);">Your chats are shown read-only below. If this persists, restart Chrome to clear the storage wedge.</div>' +
        '</div>';
    var rows = '';
    var items = (_degradedChatIndex || []).slice().sort(function(a, b) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    if (items.length === 0) {
        rows = '<div class="empty-state" style="padding:16px;color:var(--text-muted,#999);">Checking storage…</div>';
    } else {
        items.forEach(function(it) {
            rows += '<div class="chat-item chat-item-degraded" style="opacity:0.6;cursor:default;padding:8px 12px;border-radius:6px;" title="Read-only until storage recovers">' +
                escapeHtml(it.title || 'Untitled') +
            '</div>';
        });
    }
    return banner + rows;
}

// BOOT-RACE: read the chats store in bounded batches — each its own short-
// deadline transaction — instead of one getAll() over the whole store. A
// single getAll() of a large / screenshot-heavy history can legitimately
// exceed the tx deadline on cold disk and trip withStore's false "dead
// connection" retry; batching keeps every transaction well under the
// deadline. The per-call deadline is shortened (BOOT_CHATS_TX_DEADLINE_MS)
// so first-try + one reopen-retry (~12s) still fits under init's
// BOOT_HYDRATION_DEADLINE_MS, rather than racing a single 15s timeout.
var CHATS_LOAD_CHUNK_SIZE = 25;       // records per read transaction
var BOOT_CHATS_TX_DEADLINE_MS = 6000; // per-tx deadline override for the boot read

var _chatsLoadInFlight = null;
async function loadChatsFromStorage() {
    // FIX (693-R1): single-flight guard -- a boot load, a degraded-mode
    // retry, and a manual refresh can all call this concurrently; share ONE
    // in-flight load instead of racing separate withStore transactions
    // against the same store.
    if (_chatsLoadInFlight) return _chatsLoadInFlight;
    _chatsLoadInFlight = _loadChatsFromStorageImpl().finally(function() {
        _chatsLoadInFlight = null;
    });
    return _chatsLoadInFlight;
}

async function _loadChatsFromStorageImpl() {
    try {
        // Phase 1 — keys only (cheap, no payloads). Bounds a wedged backend to
        // the short deadline before we pull a single byte of chat data. withStore
        // (core/130-indexeddb.js) still reopens + retries ONCE on a dead
        // connection, now under the shortened per-call deadline.
        var allKeys = await withStore([chatStoreName], 'readonly', function(transaction) {
            var store = transaction.objectStore(chatStoreName);
            var req = store.getAllKeys();
            return new Promise(function(resolve, reject) {
                req.onsuccess = function() { resolve(req.result || []); };
                // SLEEP-WEDGE: REJECT (do not resolve-empty) so withStore's
                // connection-error retry engages on a fresh connection.
                req.onerror = function() { reject(req.error || new Error('chats getAllKeys failed')); };
            });
        }, { deadlineMs: BOOT_CHATS_TX_DEADLINE_MS });

        // Phase 2 — fetch records in bounded, disjoint key-range batches.
        // getAllKeys() returns keys in ascending order, so consecutive slices map
        // to non-overlapping IDBKeyRange.bound(first, last) windows. Build into a
        // local map and swap `chats` in ONE assignment at the end (the same atomic
        // reassignment the old single getAll did) so no reader sees a half-loaded
        // map, and init's late-merge snapshot stays valid.
        var loaded = {};
        // STORE-ACCT: size what we actually read — record count, duration, and
        // inline base64 still riding in records (the legacy tail). Decides
        // whether boot slowness is data-size or transaction-queue starvation
        // (a keys-only Phase 1 timing out = starvation, records can't be big).
        var _loadT0 = Date.now();
        var _acctB64 = 0, _acctTopB64 = 0, _acctTopId = null;
        for (var _start = 0; _start < allKeys.length; _start += CHATS_LOAD_CHUNK_SIZE) {
            var batchKeys = allKeys.slice(_start, _start + CHATS_LOAD_CHUNK_SIZE);
            var range = IDBKeyRange.bound(batchKeys[0], batchKeys[batchKeys.length - 1]);
            var batch = await withStore([chatStoreName], 'readonly', (function(_range) {
                return function(transaction) {
                    var store = transaction.objectStore(chatStoreName);
                    var req = store.getAll(_range);
                    return new Promise(function(resolve, reject) {
                        req.onsuccess = function() { resolve(req.result || []); };
                        req.onerror = function() { reject(req.error || new Error('chats getAll batch failed')); };
                    });
                };
            })(range), { deadlineMs: BOOT_CHATS_TX_DEADLINE_MS });
            for (var _bi = 0; _bi < batch.length; _bi++) {
                var chat = batch[_bi];
                if (chat && chat.messages && chat.messages.length > 0) {
                    loaded[chat.id] = chat;
                    var _cb64 = 0;
                    for (var _ci = 0; _ci < chat.messages.length; _ci++) {
                        if (chat.messages[_ci] && chat.messages[_ci].base64) _cb64 += chat.messages[_ci].base64.length;
                    }
                    if (chat.screenshots) {
                        for (var _ck in chat.screenshots) {
                            if (chat.screenshots[_ck] && chat.screenshots[_ck].base64) _cb64 += chat.screenshots[_ck].base64.length;
                        }
                    }
                    if (_cb64) {
                        _acctB64 += _cb64;
                        if (_cb64 > _acctTopB64) { _acctTopB64 = _cb64; _acctTopId = chat.id; }
                    }
                }
            }
        }
        // FIX (691-R1): an unconditional swap drops any in-memory temp/
        // degraded chat that never made it to disk (isTemporary chats,
        // chats kept alive under _storageDegraded, or the chat currently
        // being viewed) when this load is a fast-fail recovery pass. Carry
        // those forward into `loaded` before the atomic swap.
        Object.keys(chats).forEach(function(id){
            var c = chats[id];
            if (!c) return;
            if (!loaded[id]) {
                if (c.isTemporary || (_storageDegraded && c.messages && c.messages.length) || id === currentChatId) loaded[id] = c;
                return;
            }
            // FLUX-ADOPT (#836): guarded boot carry-forward. When a chat we
            // already hold in memory was ALSO loaded from disk, adopt the
            // in-memory copy into `loaded` through the sanctioned guard
            // (adoptChatRow, app/045-agent-port-bridge-page.js): a staler
            // in-memory copy is refused (disk row wins, as before), while a
            // FRESHER in-memory copy (higher rev / more messages) survives a
            // recovery re-load instead of being regressed by an older disk row.
            adoptChatRow(c, { chatId: id, map: loaded });
        });
        chats = loaded;
        console.log('[storage] loaded ' + Object.keys(loaded).length + ' chats in '
            + (Date.now() - _loadT0) + 'ms — '
            + (_acctB64
                ? ('~' + Math.round(_acctB64 * 0.75 / 1048576) + 'MB inline base64 still in records (largest '
                    + _acctTopId + ' ~' + Math.round(_acctTopB64 * 0.75 / 1048576) + 'MB)')
                : 'records are v16-clean (no inline base64)'));

        // Rehydrate per-chat pause flags from the persisted record field
        // (chat.pausedByUser, stamped by setChatPausedPersistent) so a
        // user-paused chat still reads as paused after a panel reload —
        // Pause button shows Resume, jobs rows keep the amber Paused state.
        try {
            if (typeof pausedChats !== 'undefined') {
                Object.keys(chats).forEach(function(_pcid) {
                    if (chats[_pcid] && chats[_pcid].pausedByUser === true) pausedChats[_pcid] = true;
                });
            }
        } catch (e) { /* rehydration is best-effort */ }
        // MEMFIX: keep the newest K chats fully hydrated, strip inline
        // base64 payloads from the rest (rehydrated on demand by
        // ensureChatPayloads — see core/130-indexeddb.js). Evicted
        // chats stay in `chats` (delete-pass safety) and are skipped
        // by the put-loop in saveChatsToStorage (put safety).
        // PAYLOAD-STORE: records saved since v16 arrive ALREADY stripped
        // (payloads live in chat_payloads) — the strip loop below is a no-op
        // for them and still bites on legacy-inline records (chats not yet
        // re-saved since v16, imported backups; migration is lazy, at save
        // time). "Keep the newest K hydrated" therefore needs the explicit
        // hydration pass at the bottom — sequential and fire-and-forget; view
        // call sites (switchToChat, history view) also hydrate on demand,
        // this just front-loads the common case.
        try {
            var KEEP_HYDRATED = CHAT_KEEP_HYDRATED;
            if (typeof stripChatPayloadsInPlace === 'function') {
                var _ids = Object.keys(chats);
                _ids.sort(function(a, b) { return chatPayloadRecencyTs(chats[b]) - chatPayloadRecencyTs(chats[a]); });
                for (var _si = KEEP_HYDRATED; _si < _ids.length; _si++) {
                    // MEMFIX-BODY (Fix A): evictBodies=true — the page also
                    // drops heavy message text (tool results, thinking,
                    // tool_calls args) of non-recent chats at boot; restored
                    // with the payloads by ensureChatPayloads on open.
                    stripChatPayloadsInPlace(chats[_ids[_si]], true);
                    // WRITE-AMP root fix (mirrors worker/115-storage.js): strip
                    // only flags chats it stripped base64 from, so pure-TEXT
                    // chats stayed in the put set and the page re-wrote every
                    // one of their unchanged records on every save — hundreds
                    // of records, tens of MB, per save. Mark all non-recent
                    // chats evicted; view/mutation sites hydrate on demand via
                    // ensureChatPayloads (a single cheap get for text-only
                    // chats), which clears the flag and re-admits the chat to
                    // the put set.
                    chats[_ids[_si]]._payloadsEvicted = true;
                }
                if (typeof ensureChatPayloads === 'function') {
                    (function _hydrateRecent(recentIds) {
                        var _hi = 0;
                        (function _next() {
                            if (_hi >= recentIds.length) return;
                            var _hid = recentIds[_hi++];
                            var _hp = (chats[_hid] && chats[_hid]._payloadsEvicted)
                                ? ensureChatPayloads(_hid) : Promise.resolve();
                            Promise.resolve(_hp).then(function() {
                                // Repaint once the CURRENT chat's images arrive —
                                // the boot render may have shown placeholders.
                                if (typeof currentChatId !== 'undefined' && currentChatId === _hid
                                    && typeof renderMessages === 'function') {
                                    try { renderMessages(); } catch (e) {}
                                }
                                _next();
                            }, _next);
                        })();
                    })(_ids.slice(0, KEEP_HYDRATED));
                }
            }
        } catch (e) { console.error('chat payload eviction failed during hydration:', e); }
        // MEMFIX runtime sweep, periodic leg: the page regrows outside saves
        // too — every SW event assigns full hydrated chat snapshots into
        // `chats` (app/045-agent-port-bridge-page.js) and the SW owns their
        // persistence, so a backgrounded page may not save (= not sweep) for
        // hours. A 60s tick re-strips cold chats; registered once (guarded)
        // even if this loader re-runs on a recovery pass.
        try {
            if (!_coldSweepTimer && typeof sweepColdChatPayloads === 'function') {
                _coldSweepTimer = setInterval(function() {
                    try { sweepColdChatPayloads(CHAT_KEEP_HYDRATED, true); } catch (e) {}
                }, 60000);
            }
        } catch (e) {}
        // WIPE-GUARD follow-up: the file index is a derived cache; its failure
        // must not block hydration or leave _chatsHydrated false (which would
        // block saves all session even though `chats` hydrated fine).
        try { rebuildFileIndexAll(); } catch (e) { console.error('rebuildFileIndexAll failed during hydration:', e); }
        _chatsHydrated = true;
    } catch (e) {
        // GRACEFUL-DEGRADATION: a post-retry load failure (dead connection that
        // survived withStore's retry, blocked/wedged open, quota/IO error) must
        // NOT fall through to a silently-empty chat list. Enter degraded mode:
        // render the chrome.storage.local mirror read-only under a banner and
        // auto-retry opening the DB. Covers the FAST-failure path (open watchdog
        // rejects before the init boot-deadline); the slow-timeout path is
        // covered by core/120-init.js. Idempotent, so the retry loop's own
        // failed loads re-enter harmlessly.
        enterStorageDegradedMode(e);
    }
}

var saveChatsPending = false;
var saveChatsPendingAgain = false;
var _saveChatsWaiters = [];
// CONGESTION-BACKOFF (mirrors worker/115-storage.js): after a save blows the
// 30s write deadline, withStore leaves the transaction queued and rejects.
// Relaunching immediately queued the follow-up behind the abandoned one, so
// every later save timed out too and the [chats, chat_payloads] queue never
// drained — cross-realm too, since the SW's saves share the same store
// scope. Hold off after a timeout so the backlog commits.
var _saveChatsBackoffUntil = 0;
var SAVE_CHATS_TIMEOUT_BACKOFF_MS = 15000;

// ── FLUX-4C (narrow pull-forward): SW-owned chat-meta fields ────────────
// These seven fields are canonical in the SERVICE WORKER — every page writer
// dispatches them over the 'chat-meta-update' lane (dispatchChatMeta,
// app/045-agent-port-bridge-page.js) and the SW persists them. The page put
// below must therefore never write a page value for them: for each field the
// STORED record's state passes through unchanged (defined or absent). The
// ONE exception is a chat with no stored row yet (first save): the page is
// the creator and its values are the only truth, so they're kept.
// CHAT_META_TS_FIELDS / CHAT_META_FLAG_FIELDS — the lane vocabulary this
// preserver iterates — are declared ONCE in core/030-config.js (shared into
// both bundles; flux audit: layering — the twin per-realm copies were
// collapsed, and the build fails on any re-declaration).
function _preserveSwOwnedChatMeta(record, stored) {
    if (!record || !stored) return record;
    var out = record;
    function claim() { if (out === record) out = Object.assign({}, record); return out; }
    // FLUX-T1 (title lane): `title` + its `titleProvisional` rider are
    // SW-canonical too (the pair's stamp, titleUpdatedAt, is already in the
    // TS list) — the stored state passes through the page put unchanged,
    // same rule as the other lane fields. First save (no stored row) keeps
    // the page creator values via the null-guard above.
    // FLUX-6 (#799 review, defensive): pair atomicity — a stored row carrying
    // a bare titleUpdatedAt stamp WITHOUT a title value must not propagate
    // through this put (it would delete the record's title and freeze the
    // stamp compare against every later legit rename). Keep the record's own
    // pair fields in that corrupt case; all other lane fields still pass
    // through from the stored row unchanged.
    var _storedBareStamp = (stored.titleUpdatedAt !== undefined)
        && !(typeof stored.title === 'string' && stored.title);
    CHAT_META_TS_FIELDS.concat(CHAT_META_FLAG_FIELDS, ['title', 'titleProvisional']).forEach(function(f) {
        if (_storedBareStamp && (f === 'titleUpdatedAt' || f === 'title' || f === 'titleProvisional')) return;
        if (stored[f] === undefined) {
            if (out[f] !== undefined) delete claim()[f];
        } else if (out[f] !== stored[f]) {
            claim()[f] = stored[f];
        }
    });
    return out;
}

async function saveChatsToStorage() {
    // Prevent concurrent saves which can cause data loss. Callers that AWAIT
    // this (edit_html must know its widget-html mutation is committed before
    // take_screenshot deep-links the temp tab) are parked on _saveChatsWaiters
    // and resolved only after a save capturing the CURRENT state has committed.
    // WIPE-GUARD: never persist before a successful hydration — `chats` may
    // be empty and a save would erase the store (the wipe class behind the
    // 2026-06 data loss). Callers get a resolved promise and proceed;
    // persistence is skipped for this session, loudly.
    if (!_chatsHydrated) {
        console.error('saveChatsToStorage blocked: chats not hydrated — refusing to persist to avoid wiping stored chats');
        return;
    }
    var _commit = new Promise(function(res) { _saveChatsWaiters.push(res); });
    if (saveChatsPending) {
        saveChatsPendingAgain = true;
        return _commit;
    }
    saveChatsPending = true;

    try {
        // CONGESTION-BACKOFF: honour the hold-off armed by a previous
        // timed-out save. Callers arriving during the wait coalesce via the
        // single-flight gate above; the save that finally runs reads `chats`
        // live inside the transaction, so it captures their mutations too.
        var _boWait = _saveChatsBackoffUntil - Date.now();
        if (_boWait > 0) await new Promise(function(r) { setTimeout(r, _boWait); });
        var _saveT0 = Date.now();
        var _putRecords = 0, _putBlobs = 0;
        // withStore (core/130-indexeddb.js): retries ONCE on a fresh
        // connection if the cached one was force-closed by the browser. Safe
        // to retry: the diff-save re-derives everything from in-memory state.
        // PAYLOAD-STORE: the tx spans chat_payloads too — each hydrated chat
        // is put as a payload-STRIPPED record (extractChatPayloadsForPut) and
        // its new payloads become blob rows in the same atomic transaction,
        // so a record never commits without its payloads being durable.
        await withStore([chatStoreName, chatPayloadsStoreName], 'readwrite', function(transaction) {
        var store = transaction.objectStore(chatStoreName);

        // UPSERT-ONLY (RFC addendum Invariant D, PR 3 — mirrors
        // worker/115-storage.js): the save NEVER deletes. The absence-diff
        // delete-pass that used to live here — "stored key ∉ in-memory
        // `chats` ⇒ delete the row" — was the root cause of the chat-deletion
        // data-loss class: the page map is NOT a superset of the store (it
        // only learns foreign chats through SW pushes), so rows imported or
        // created by another panel were silently destroyed (observed live:
        // 904 → 903 → 902 across two page saves). Rows now leave the store
        // ONLY through deleteChatRow (core/130-indexeddb.js) presenting an
        // explicit reason + on-disk precondition — for this realm that is
        // deleteChatFromDB below ('user-delete', called by deleteChat in
        // ui/170-chat-management.js). Absence from memory means NOTHING.
        return new Promise(function(_resolve) {
            // WS1F-1: settle-guard so the commit promise resolves EXACTLY once and
            // can't wedge if the transaction aborts. A put-error can abort the whole
            // txn; if that happens before a zero-crossing resolve() fires, `pending`
            // never reaches 0, the `await` hangs forever, saveChatsPending stays true
            // and the parked _saveChatsWaiters never drain. Routing every settle
            // through this guarded resolve() makes each existing zero-crossing
            // resolve set _settled first, and the transaction.onabort below is the
            // safety-net. NOTE: the onerror resolves are OPTIMISTIC — a rolled-back
            // write is repaired by the next full re-serialised save
            // (saveChatsPendingAgain / the next caller). Do NOT switch these to
            // reject/resolve(false): callers only await that a commit was attempted.
            var _settled = false;
            function resolve() { if (_settled) return; _settled = true; _resolve(); }
            transaction.onabort = function() {
                if (!_settled) { updateStorageIndicator(); resolve(); }
            };
            // PAYLOAD-STORE: refresh the known-durable blob id cache once per
            // realm (key-only read) so unchanged payloads aren't re-put. Its
            // getAllKeys request is issued SYNCHRONOUSLY here, so the fresh
            // transaction has a pending request and cannot auto-commit before
            // the put loop below queues its own.
            primeChatPayloadIdCache(transaction, function() {
                // Persistable snapshot — same filter as before (drop 0-message chats)
                var desired = {};
                Object.keys(chats).forEach(function(id) {
                    var c = chats[id];
                    if (c && c.messages && c.messages.length > 0) desired[id] = c;
                });
                var pending = 0;
                // WS-1 semantics preserved: EVERY request (delete or put, success
                // or error) settles through here so a final errored request still
                // resolves — otherwise the await hangs, saveChatsPending stays
                // true and the parked _saveChatsWaiters never drain. The onerror
                // settles are OPTIMISTIC: a rolled-back write is repaired by the
                // next full save.
                function settleOne() {
                    pending--;
                    if (pending === 0) {
                        updateStorageIndicator();
                        resolve();
                    }
                }
                // PR 3: the absence-diff delete-pass that lived here is GONE
                // (PR 4 retired its caps and known-id sets) — see the
                // UPSERT-ONLY header above. Explicit user deletes take the
                // targeted deleteChatFromDB lane below; they never depended
                // on this save.
                Object.keys(desired).forEach(function(id) {
                    // MEMFIX: NEVER put a payload-evicted chat. Post-PAYLOAD-STORE
                    // this protects legacy records whose payloads are still inline
                    // (never migrated / imported) and skips pure write
                    // amplification (an evicted chat's record hasn't changed).
                    // It stays in `desired` so the delete-pass above cannot
                    // remove its record either.
                    if (desired[id]._payloadsEvicted) return;
                    // PAYLOAD-STORE: strip payloads into blob rows; the record
                    // put carries flags instead of base64. `pending` is
                    // INCREMENTED synchronously for every record in this loop
                    // (the FLUX-4C put itself is issued async, after its get),
                    // so `pending` cannot zero-cross before the loop finishes.
                    var extracted = extractChatPayloadsForPut(desired[id]);
                    var _nBlobs = queueChatPayloadPuts(transaction, extracted.payloads, settleOne);
                    pending += _nBlobs;
                    _putBlobs += _nBlobs;
                    pending++;
                    _putRecords++;
                    // FLUX-4C (F2 close): get-then-put inside the same txn so
                    // the stored record's SW-owned chat-meta fields pass
                    // through this put untouched — a panel's stale replica can
                    // NEVER clobber the lane's persisted state (the old blind
                    // put was panel↔panel last-writer-wins on pin / error /
                    // hidden / timestamps). Mirrors the SW's own put-side
                    // merge (worker/115-storage.js). A get error degrades to
                    // the blind put for this one save.
                    (function(_putRec, _putId) {
                        // Both callbacks settle even when put() throws
                        // SYNCHRONOUSLY (DataCloneError): unlike the old
                        // sync loop-body put (whose throw surfaced to the
                        // caller), a throw inside an IDB event handler only
                        // aborts the txn — without the catch this record's
                        // settleOne never fires and the save lock hangs.
                        var _metaGet = store.get(_putId);
                        _metaGet.onsuccess = function() {
                            try {
                                // FLUX-6: tombstone put-drop (mirrors the SW's
                                // deleted-while-in-flight guard, PR #800) — never
                                // re-put a row another panel's delete tombstoned
                                // while this save's get was in flight.
                                if (_metaGet.result && _metaGet.result._deleted === true) { settleOne(); return; }
                                // FLUX-6: chain the SHARED non-lane merge (messages
                                // append-tail preservation, displays union, future-
                                // field fill-gap — core/130-indexeddb.js) after the
                                // lane preserver, against the SAME stored row.
                                var putRequest = store.put(_mergeChatRowForPut(_preserveSwOwnedChatMeta(_putRec, _metaGet.result), _metaGet.result));
                                putRequest.onsuccess = settleOne;
                                putRequest.onerror = settleOne;
                            } catch (e) { console.warn('[storage] chat put failed (post-get)', _putId, e); settleOne(); }
                        };
                        _metaGet.onerror = function() {
                            try {
                                var putRequest = store.put(_putRec);
                                putRequest.onsuccess = settleOne;
                                putRequest.onerror = settleOne;
                            } catch (e) { console.warn('[storage] chat put failed (get-error fallback)', _putId, e); settleOne(); }
                        };
                    })(extracted.record, id);
                });
                if (pending === 0) {
                    updateStorageIndicator();
                    resolve();
                }
            }); // end primeChatPayloadIdCache
        });
        }); // end withStore fn
        // Committed: clear any armed backoff and surface slow-but-successful
        // saves so future congestion is diagnosable (which realm, how big).
        _saveChatsBackoffUntil = 0;
        // MEMFIX runtime sweep: the commit above made every non-evicted
        // chat's record + payload blobs durable, so re-strip cold chats now
        // (same K as the boot pass; current/running chats are skipped inside
        // the sweep — core/130-indexeddb.js). Without this, chats hydrated
        // since boot (snapshot adoption, viewed-then-left chats) stayed
        // hydrated for the page's whole lifetime.
        try { if (typeof sweepColdChatPayloads === 'function') sweepColdChatPayloads(CHAT_KEEP_HYDRATED); } catch (eSweep) {}
        var _saveDur = Date.now() - _saveT0;
        if (_saveDur > 2000) {
            console.warn('[storage] slow save: ' + _saveDur + 'ms ('
                + _putRecords + ' records, ' + _putBlobs + ' payload blobs) — IDB congested');
        }
        // GRACEFUL-DEGRADATION: refresh the chrome.storage.local chat index
        // mirror after a successful commit so the boot path has a recent
        // read-only snapshot to show if IDB later wedges. Best-effort.
        mirrorChatIndexToLocal();
    } catch (e) {
        console.error('Failed to save chats to IndexedDB:', e);
        // CONGESTION-BACKOFF: the timed-out transaction is still queued and
        // will commit in the background — hold the next save back so it
        // drains instead of stacking another transaction on the jam.
        if (e && e.name === 'TimeoutError') {
            _saveChatsBackoffUntil = Date.now() + SAVE_CHATS_TIMEOUT_BACKOFF_MS;
            console.warn('[storage] backing off ' + (SAVE_CHATS_TIMEOUT_BACKOFF_MS / 1000)
                + 's before the next save so the queued transaction can drain');
        }
    } finally {
        saveChatsPending = false;
        // If another save was requested while we were saving, do it now. That
        // follow-up save captures the newest state and will drain the accumulated
        // _saveChatsWaiters when IT completes — so do NOT drain here.
        if (saveChatsPendingAgain) {
            saveChatsPendingAgain = false;
            saveChatsToStorage();
        } else {
            // No follow-up: this save committed the current state. Resolve every
            // awaiting caller (edit_html etc.) now so its await unblocks.
            var _w = _saveChatsWaiters;
            _saveChatsWaiters = [];
            _w.forEach(function(r) { try { r(); } catch (e) {} });
        }
    }
}

// EXPLICIT-DELETE (chat-delete durability): targeted, single-id removal of ONE
// chat row (plus the payload blob rows only that chat referenced).
// Thin wrapper over the SHARED delete primitive deleteChatRow
// (core/130-indexeddb.js — RFC addendum §2.3 "the one delete primitive").
// The primitive owns the transaction, the ON-DISK precondition check (a row
// leaves the store only for a named reason whose precondition holds against
// the record as it exists on disk, verified INSIDE the deleting
// transaction), the abort=failure settle discipline, the page-realm blob
// reaping (hydration gate + survivor-reference subtraction, moved there
// verbatim) and the delete ledger. This wrapper supplies the SIGNAL
// ('user-delete'), the pre-delete record, and the degraded-mode index mirror.
// It deliberately does NOT go through the diff-save above: that pass is a
// bulk reconciliation, rate-limited and budgeted; an explicit user delete is
// one known id requested by the user and must never be capped or deferred.
// `chatSnapshot` is the record as it was BEFORE the caller dropped it from
// `chats` (deleteChat in ui/170-chat-management.js captures it) — used to
// find this chat's payload ids, and as the caller's proof that it holds the
// pre-delete record.
// Resolves true when the delete transaction completed (or the row was
// already gone — the primitive is idempotent), false on refusal/abort/failure.
async function deleteChatFromDB(chatId, chatSnapshot) {
    if (!chatId) return false;
    if (typeof deleteChatRow !== 'function') {
        console.error('[storage] explicit delete: deleteChatRow (core/130-indexeddb.js) unavailable — chat '
            + chatId + ' NOT deleted');
        return false;
    }
    var ok = await deleteChatRow(chatId, 'user-delete', {
        userInitiated: true,
        via: 'page-delete',
        hadRecord: !!chatSnapshot,
        record: chatSnapshot || null
    });
    if (ok) {
        // Keep the degraded-mode chrome.storage.local index in step with the
        // store, exactly as a committed save does.
        try { mirrorChatIndexToLocal(); } catch (e) {}
    }
    return ok;
}

// Payload ids (file_id / screenshot_id) a chat record references. Ids survive
// payload eviction, so a stripped record still reports them.
function _chatPayloadIdsFor(chat) {
    var ids = {};
    if (!chat) return ids;
    if (Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var m = chat.messages[i];
            if (!m) continue;
            if (m.file_id) ids[m.file_id] = true;
            if (m.screenshot_id) ids[m.screenshot_id] = true;
        }
    }
    if (chat.screenshots) Object.keys(chat.screenshots).forEach(function(k) { ids[k] = true; });
    return ids;
}

async function loadProviderFromStorage() {
    var stored = appStorage.getItem('appagent_provider');
    if (stored && getProviderById(stored)) {
        currentProvider = stored;
    } else if (stored && typeof PROVIDER_RENAMES !== 'undefined' && PROVIDER_RENAMES[stored]
        && getProviderById(PROVIDER_RENAMES[stored])) {
        // The stored selection carries a legacy default-provider name that the
        // IDB rename migration (core/130-indexeddb.js) already migrated — but
        // that migration only rewrites this localStorage key when it runs in
        // the PAGE (the SW's appStorage shim is inert). If the SW migrated
        // first, the legacy IDB entry is gone by the time the page loads and
        // the rewrite never fires. Recover via the PROVIDER_RENAMES map
        // (core/030-config.js) and persist the new name so this is one-shot.
        currentProvider = PROVIDER_RENAMES[stored];
        try { appStorage.setItem('appagent_provider', currentProvider); } catch (e) {}
    }
}

async function loadCacheTokenLimit() {
    cacheTokenLimit = await getSetting('cacheTokenLimit', 4000);
}

async function saveCacheTokenLimit() {
    await setSetting('cacheTokenLimit', cacheTokenLimit);
}

async function updateCacheTokenLimit(value) {
    cacheTokenLimit = parseInt(value) || 4000;
    await saveCacheTokenLimit();
}

// Settings page onchange handler for the assumed-context-window field.
// Persists via saveAssumedContextTokens (core/030-config.js) and writes the
// normalized value back into the input (bad input snaps to the default).
async function updateAssumedContextTokens(value) {
    var normalized = await saveAssumedContextTokens(value);
    var input = document.getElementById('settings-page-context-window');
    if (input) input.value = normalized;
    if (typeof updateContextIndicator === 'function') updateContextIndicator();
}

async function updateCacheTokenLimitFromK(valueInK) {
    var k = parseInt(valueInK) || 4;
    k = Math.max(1, Math.min(100, k)); // Clamp between 1K and 100K
    cacheTokenLimit = k * 1000;
    await saveCacheTokenLimit();
    // Sync the settings-page input if it exists
    var pageInput = document.getElementById('settings-page-cache-limit');
    if (pageInput) pageInput.value = k;
}

async function loadToolPermissions() {
    toolPermissions = await getSetting('toolPermissions', {});
    instancePermissions = await getSetting('instancePermissions', {});

    // Reset to new defaults (clean slate for new permission system)
    initDefaultToolPermissions();

    // One-time migration: earlier builds seeded workspace:push's default as
    // 'auto'; the baked-in default is now 'allow' (PR pushes never prompt
    // unless the user overrides). Flip a stored 'auto' → 'allow' exactly once,
    // guarded by a persisted permMigrations flag so a user who later
    // deliberately re-selects 'auto' is never re-migrated. saveToolPermissions
    // persists to IDB and mirrors to the SW.
    var permMigrations = await getSetting('permMigrations', {});
    if (!permMigrations.workspacePushAllow) {
        if (toolPermissions['workspace:push'] === 'auto') {
            toolPermissions['workspace:push'] = 'allow';
            saveToolPermissions();
        }
        permMigrations.workspacePushAllow = true;
        setSetting('permMigrations', permMigrations);
    }

    // One-time migration: pre-release builds of get_cookie seeded its default
    // as 'auto' (the generic GLOBAL_WRITE_KEYS default) and then as 'ask'; the
    // baked-in default is now 'allow' — cookie reads run silently, like
    // workspace:push. initDefaultToolPermissions PERSISTS whichever default was
    // current the first time it ran, and a stored value always shadows the
    // baked-in default, so those installs would never pick up 'allow'. Flip a
    // stored 'auto' OR 'ask' → 'allow' exactly once, guarded by a persisted
    // permMigrations flag, so a user who afterwards deliberately picks
    // 'ask'/'auto'/'off' is never re-migrated.
    // 'ask' is migrated too (not just 'auto') on purpose: get_cookie has never
    // shipped in a release with an 'ask' default — it only existed on the
    // unmerged feature branch — so a stored 'ask' can only be a seeded
    // pre-release default, not a considered user choice.
    if (!permMigrations.getCookieAllow) {
        if (toolPermissions['get_cookie'] === 'auto' || toolPermissions['get_cookie'] === 'ask') {
            toolPermissions['get_cookie'] = 'allow';
            saveToolPermissions();
        }
        permMigrations.getCookieAllow = true;
        setSetting('permMigrations', permMigrations);
    }

    // F6: no post-load mirror push to the SW. The SW hydrates tool/instance
    // maps from the SAME IDB at its own boot (loadToolPermissionsInWorker),
    // and under single-writer the page never writes them, so both realms read
    // an identical source — a full-map push here was pure staleness risk
    // (panel A booting could clobber an edit panel B dispatched moments
    // earlier). Genuine boot-time MUTATIONS (seeded defaults, migrations
    // above) still dispatch through saveToolPermissions.
    // The header tier pill (updateSnStatus) typically renders BEFORE this
    // async IDB load completes, so it shows the default 'Manual' even when
    // the stored tier is 'auto' — and nothing re-renders it until the next
    // connection-state change. Re-render now that the real tiers are loaded.
    if (typeof updateSnStatus === 'function') updateSnStatus();
}

function initDefaultToolPermissions() {
    var changed = false;
    // Global read tools → allow
    GLOBAL_READ_KEYS.forEach(function(key) {
        if (!toolPermissions[key]) { toolPermissions[key] = 'allow'; changed = true; }
    });
    // Global write tools → auto (with exceptions)
    GLOBAL_WRITE_KEYS.forEach(function(key) {
        if (!toolPermissions[key]) {
            if (key === 'manage_skill:activate') {
                toolPermissions[key] = 'disabled';
            } else if (key === 'web_fetch') {
                toolPermissions[key] = 'ask';
            } else if (key === 'workspace:push' || key === 'get_cookie') {
                // get_cookie runs silently by default; the user can lower it
                // to 'ask'/'Off' in Settings > Tool permissions.
                toolPermissions[key] = 'allow';
            } else {
                toolPermissions[key] = 'auto';
            }
            changed = true;
        }
    });
    // F6: dispatch only when a default was actually seeded. The old
    // unconditional save re-shipped the full (unchanged) map to the SW on
    // every panel boot — harmless when single-panel, but a stale-clobber
    // lane when another panel had just edited a permission.
    if (changed) saveToolPermissions();
}

function _getGlobalDefault(key) {
    if (GLOBAL_READ_KEYS.indexOf(key) !== -1) return 'allow';
    if (key === 'manage_skill:activate') return 'disabled';
    if (key === 'web_fetch') return 'ask';
    if (key === 'workspace:push' || key === 'get_cookie') return 'allow';
    return 'auto';
}

function hasNonDefaultPermissions() {
    // Check global
    for (var i = 0; i < GLOBAL_PERMISSION_KEYS.length; i++) {
        var key = GLOBAL_PERMISSION_KEYS[i];
        var stored = toolPermissions[key];
        if (stored && stored !== _getGlobalDefault(key)) return true;
    }
    // Check instance
    var host = getConnectedInstanceHost();
    if (host && instancePermissions[host]) {
        var inst = instancePermissions[host];
        if (inst.tier && inst.tier !== 'manual') return true;
        if (inst.tools) {
            var keys = Object.keys(inst.tools);
            for (var j = 0; j < keys.length; j++) {
                var k = keys[j];
                var def = isReadPermissionKey(k) ? 'allow' : 'ask';
                if (inst.tools[k] !== def) return true;
            }
        }
    }
    return false;
}

function resetAllPermissionsToDefaults() {
    // Reset global permissions
    toolPermissions = {};
    GLOBAL_READ_KEYS.forEach(function(key) {
        toolPermissions[key] = 'allow';
    });
    GLOBAL_WRITE_KEYS.forEach(function(key) {
        if (key === 'manage_skill:activate') {
            toolPermissions[key] = 'disabled';
        } else if (key === 'web_fetch') {
            toolPermissions[key] = 'ask';
        } else if (key === 'workspace:push' || key === 'get_cookie') {
            toolPermissions[key] = 'allow';
        } else {
            toolPermissions[key] = 'auto';
        }
    });
    saveToolPermissions();

    // Reset instance permissions for connected instance
    var host = getConnectedInstanceHost();
    if (host) {
        instancePermissions[host] = { tier: 'manual', tools: {} };
        // Instance read → allow, write → ask
        INSTANCE_READ_KEYS.forEach(function(key) {
            instancePermissions[host].tools[key] = 'allow';
        });
        INSTANCE_WRITE_KEYS.forEach(function(key) {
            instancePermissions[host].tools[key] = 'ask';
        });
        saveInstancePermissions();
    }

    // Clear session permissions — and dispatch the clear to the SW (F6):
    // the SW owns the authoritative session map, so a page-local wipe alone
    // would be resurrected by the next hello/rebroadcast, and other panels
    // would keep their grants. This is the ONLY place an empty session map
    // is legitimately pushed — it is an explicit user action, unlike the
    // removed boot-time hello mirror (the QW9 wipe bug).
    sessionPermissions = {};
    if (typeof pushPermissionsToOffscreen === 'function') {
        pushPermissionsToOffscreen({ sessionPermissions: sessionPermissions });
    }

    // Re-render
    renderToolPermissions();
    if (typeof renderSettingsToolPermissions === 'function') renderSettingsToolPermissions();
    if (typeof updateSnStatus === 'function') updateSnStatus();
    showSnackbar('All permissions reset to defaults', 'success');
}
