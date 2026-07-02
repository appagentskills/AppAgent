// Toggle dashboard headers visibility
function toggleDashboardHeaders() {
    showDashboardHeaders = !showDashboardHeaders;
    appStorage.setItem('showDashboardHeaders', showDashboardHeaders);
    var grid = document.getElementById('dashboard-grid');
    var btn = document.getElementById('dashboard-toggle-headers-btn');
    if (grid) {
        grid.classList.toggle('show-headers', showDashboardHeaders);
    }
    if (btn) {
        btn.classList.toggle('active', showDashboardHeaders);
    }
}

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
        '<button class="widget-modal-btn" onclick="closeExpandedWidget();regenerateDashboardWidget(\'' + widgetId + '\')" title="Regenerate">' + UI_ICONS.refresh + '</button>' +
        '<button class="widget-modal-btn" onclick="closeExpandedWidget();editDashboardWidget(\'' + widgetId + '\')" title="Edit">' + UI_ICONS.edit + '</button>' +
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
        writeWidgetHtml(iframe, injectWidgetBridge(widget.html, widget.title));
    }
}

function closeExpandedWidget() {
    expandedWidgetId = null;
    var overlay = document.getElementById('widget-fullscreen-overlay');
    if (overlay) overlay.remove();
}

// Grid occupancy and collision detection functions
function initGridOccupancy() {
    gridState.occupancy = {};
    Object.values(dashboardWidgets).forEach(function(widget) {
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

function migrateWidgetPositions() {
    var widgets = Object.values(dashboardWidgets)
        .filter(function(w) { return w.gridX === undefined || w.gridY === undefined; })
        .sort(function(a, b) { return (a.order || 0) - (b.order || 0); });

    if (widgets.length === 0) return;

    // Initialize occupancy for already migrated widgets
    initGridOccupancy();

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

function handleWidgetDrop(event) {
    event.preventDefault();

    if (!gridState.draggedWidgetId) return;

    var widget = dashboardWidgets[gridState.draggedWidgetId];
    if (!widget) return;

    // Calculate drop position accounting for grab offset
    var grid = document.getElementById('dashboard-grid');
    if (!grid) return;

    var gridRect = grid.getBoundingClientRect();
    var scrollTop = grid.scrollTop;

    // Adjust mouse position by grab offset to get widget's top-left position
    var offsetX = gridState.dragOffset ? gridState.dragOffset.x : 0;
    var offsetY = gridState.dragOffset ? gridState.dragOffset.y : 0;

    var widgetLeft = event.clientX - offsetX - gridRect.left;
    var widgetTop = event.clientY - offsetY - gridRect.top + scrollTop;

    // Calculate grid cell dimensions
    var cellWidth = (gridRect.width - 32 - (11 * gridState.gap)) / 12;
    var cellHeight = gridState.rowHeight + gridState.gap;

    // Snap to grid
    var gridX = Math.round((widgetLeft - 16) / (cellWidth + gridState.gap));
    var gridY = Math.round((widgetTop - 16) / cellHeight);

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

function buildWidgetHtml(widget) {
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
    html += '<div class="dashboard-widget-header">';
    html += '<span class="dashboard-widget-icon drag-handle">' + UI_ICONS.widget + '</span>';
    html += '<span class="dashboard-widget-title">' + escapeHtml(widget.title || 'Untitled') + '</span>';
    html += errorBadge;
    html += '<div class="dashboard-widget-controls">';
    html += '<button class="dashboard-widget-btn widget-stop-btn" data-widget-id="' + widget.id + '" onclick="toggleWidgetRunning(\'' + widget.id + '\', event)" title="' + (widget.deactivated ? 'Activate Widget' : 'Deactivate Widget') + '">' + (widget.deactivated ? UI_ICONS.play : UI_ICONS.stop) + '</button>';
    html += '<button class="dashboard-widget-btn" onclick="event.stopPropagation();regenerateDashboardWidget(\'' + widget.id + '\')" title="Regenerate">' + UI_ICONS.refresh + '</button>';
    if (widget.history && widget.history.length > 0) {
        html += '<button class="dashboard-widget-btn" onclick="event.stopPropagation();showWidgetHistory(\'' + widget.id + '\')" title="History (' + widget.history.length + ')">' + UI_ICONS.history + '</button>';
    }
    html += '<button class="dashboard-widget-btn" onclick="event.stopPropagation();screenshotWidget(\'' + widget.id + '\')" title="Screenshot">' + UI_ICONS.camera + '</button>';
    html += '<button class="dashboard-widget-btn" onclick="event.stopPropagation();expandDashboardWidget(\'' + widget.id + '\')" title="Fullscreen">' + UI_ICONS.maximize + '</button>';
    html += '<button class="dashboard-widget-btn" onclick="event.stopPropagation();editDashboardWidget(\'' + widget.id + '\')" title="Edit">' + UI_ICONS.edit + '</button>';
    html += '<button class="dashboard-widget-btn danger" onclick="event.stopPropagation();confirmDeleteDashboardWidget(\'' + widget.id + '\')" title="Delete">' + UI_ICONS.trash + '</button>';
    html += '</div>';
    html += '</div>';
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

    // Get the dashboard grid for calculating units
    var grid = document.getElementById('dashboard-grid');
    if (!grid) return;

    var gridRect = grid.getBoundingClientRect();
    var cellWidth = (gridRect.width - 32 - (11 * gridState.gap)) / 12;
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
function injectWidgetBridge(html, widgetTitle) {
    // escapeJsString escapes \ first, then quotes/</>/& as JS hex sequences —
    // a title containing \ or </script> can no longer corrupt the script block.
    var safeTitle = escapeJsString(widgetTitle || 'Widget');
    var bridgeScript = '<script>' +
        'window._widgetTitle="' + safeTitle + '";' +
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

// Write widget HTML to iframe via the manifest-sandboxed widget page
// CSP blocks inline scripts in the extension page, so we route through widget-sandbox.html
function writeWidgetHtml(iframe, html) {
    function onMsg(e) {
        if (e.source !== iframe.contentWindow) return;
        if (e.data && e.data.type === 'widgetSandboxReady') {
            window.removeEventListener('message', onMsg);
            iframe.contentWindow.postMessage({ type: 'loadWidget', html: html }, '*');
        }
    }
    window.addEventListener('message', onMsg);
    iframe.src = 'widget-sandbox.html';
}

// Validate that a message source is a known widget iframe's contentWindow
function _isWidgetSource(source) {
    if (!source) return false;
    // Check light DOM iframes
    var iframes = document.querySelectorAll('iframe.widget-iframe');
    for (var i = 0; i < iframes.length; i++) {
        try { if (iframes[i].contentWindow === source) return true; } catch(e) {}
    }
    // Check shadow DOM iframes (dashboard widgets use shadow hosts)
    var hosts = document.querySelectorAll('.widget-shadow-host');
    for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
            var shadowIframes = hosts[i].shadowRoot.querySelectorAll('iframe.widget-iframe');
            for (var j = 0; j < shadowIframes.length; j++) {
                try { if (shadowIframes[j].contentWindow === source) return true; } catch(e) {}
            }
        }
    }
    return false;
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
        if (!_isWidgetSource(event.source)) return;
        var id = event.data.id;
        var name = event.data.name;
        var args = event.data.args || {};
        var widgetName = event.data.widgetName || 'Widget';

        try {
            // executeTool checks permissions via requestProgrammaticToolApproval
            // For programmatic calls, approval uses notifications (not renderMessages) to preserve widget iframe
            var result = await executeTool(name, args, null, { chatId: currentChatId, widgetName: widgetName });

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
    writeWidgetHtml(iframe, injectWidgetBridge(widget.html, widget.title));
}

// Add a chat widget to the dashboard
async function addWidgetToDashboard(widgetId, event) {
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
    
    // Find available grid position for new widget
    initGridOccupancy();
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
        isLoading: false
    };

    dashboardWidgets[widgetId] = dashWidget;
    await saveDashboardWidget(dashWidget);
    
    // Update button state
    var btn = document.querySelector('.widget-dashboard-btn[onclick*="' + widgetId + '"]');
    if (btn) {
        btn.classList.add('on-dashboard');
        btn.setAttribute('onclick', "removeWidgetFromDashboard('" + widgetId + "', event)");
        btn.setAttribute('title', 'Remove from Dashboard');
    }
    
    // Re-render dashboard if it's currently visible to show the new widget
    var dashboardPanel = document.getElementById('dashboard-panel');
    if (dashboardPanel && dashboardPanel.style.display === 'flex') {
        renderDashboard();
    }
    
    // Update sidebar to reflect dashboard state
    renderVersionSidebar();
    
    showSnackbar('Widget added to dashboard', 'success');
}

// Remove a widget from the dashboard
async function removeWidgetFromDashboard(widgetId, event) {
    if (event) event.stopPropagation();
    
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
        
        // Show empty state if no widgets left
        var container = document.getElementById('dashboard-grid');
        if (container && Object.keys(dashboardWidgets).length === 0) {
            container.innerHTML = '<div class="dashboard-empty"><span class="dashboard-empty-icon">' + UI_ICONS.widget + '</span><p>No widgets yet</p><p class="dashboard-empty-hint">Add widgets to your dashboard using prompts.</p></div>';
        }
    }
    
    // Update button state in chat view
    var btn = document.querySelector('.widget-dashboard-btn[onclick*="' + widgetId + '"]');
    if (btn) {
        btn.classList.remove('on-dashboard');
        btn.setAttribute('onclick', "addWidgetToDashboard('" + widgetId + "', event)");
        btn.setAttribute('title', 'Add to Dashboard');
    }
    // Update sidebar
    renderVersionSidebar();
}

// Toggle widget on/off dashboard from sidebar
async function toggleWidgetOnDashboard(widgetId) {
    if (dashboardWidgets && dashboardWidgets[widgetId]) {
        await removeWidgetFromDashboard(widgetId);
    } else {
        await addWidgetToDashboard(widgetId);
    }
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

function editDashboardWidget(widgetId) {
    var widget = dashboardWidgets[widgetId];
    if (!widget) return;

    // If widget has a source chat, open that chat
    if (widget.chatId && chats[widget.chatId]) {
        // Close dashboard view properly (updates currentView)
        closeDashboardView();
        
        // Load the source chat
        selectChat(widget.chatId);
        
        // Scroll to the widget display inside the chat
        setTimeout(function() {
            // First try to scroll to the widget element itself
            var widgetEl = document.getElementById('widget-' + widgetId);
            if (widgetEl) {
                widgetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (widget.msgIndex !== undefined) {
                // Fallback to message element if widget not found
                var msgEl = document.querySelector('[data-msg-index="' + widget.msgIndex + '"]');
                if (msgEl) msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 100);
    } else {
        console.warn('Widget has no valid source chat. chatId:', widget.chatId, 'available chats:', Object.keys(chats));
        showSnackbar('Source chat not found - widget may have been created in a deleted chat', 'warning');
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

function closeWidgetChatMode() {
    var widget = dashboardWidgets[currentEditingWidget];
    
    // If it's a new widget with no content, remove it
    if (widget && !widget.html && (!widget.conversation || widget.conversation.length === 0)) {
        delete dashboardWidgets[currentEditingWidget];
    }
    
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
    
    // Restore chat title
    var headerTitle = document.getElementById('header-chat-title');
    if (headerTitle && chats[currentChatId]) {
        headerTitle.textContent = chats[currentChatId].title || 'New Chat';
    }
    
    // Show dashboard
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
        renderDashboard(); 
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
    
    // Save current as new history entry before reverting
    if (widget.html) {
        widget.history.push({
            html: widget.html,
            timestamp: Date.now(),
            prompt: widget.lastPrompt || 'Before revert'
        });
    }
    
    // Restore the old HTML
    widget.html = historyEntry.html;
    widget.error = null;
    
    await saveDashboardWidget(widget, true); // Skip history tracking since we're managing it manually
    renderDashboard();
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

// Regenerate widget - creates a new chat with full history and runs the last prompt
async function regenerateDashboardWidget(widgetId) {
    var widget = dashboardWidgets[widgetId];
    if (!widget) {
        showSnackbar('Widget not found', 'error');
        return;
    }
    
    // Find the source chat and the prompt to regenerate
    var prompt = widget.prompt;
    var historyMessages = [];
    var lastUserMsgIndex = -1;
    var sourceChatTitle = null;
    
    // Try to get history from source chat
    if (widget.chatId && chats[widget.chatId]) {
        var sourceChat = chats[widget.chatId];
        sourceChatTitle = sourceChat.title;
        // Find the last user message before the widget was created
        var msgIndex = widget.msgIndex || sourceChat.messages.length;
        for (var i = msgIndex - 1; i >= 0; i--) {
            if (sourceChat.messages[i] && sourceChat.messages[i].role === 'user') {
                if (!prompt) prompt = sourceChat.messages[i].content;
                lastUserMsgIndex = i;
                break;
            }
        }
        
        // Copy all messages BEFORE the last user message as history
        if (lastUserMsgIndex > 0) {
            for (var i = 0; i < lastUserMsgIndex; i++) {
                var msg = sourceChat.messages[i];
                // Skip internal messages like approval, pending_tool, etc.
                if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'system') {
                    // Clone the message to avoid modifying original
                    var clonedMsg = JSON.parse(JSON.stringify(msg));
                    // Remove streaming/transient properties
                    delete clonedMsg.isStreaming;
                    historyMessages.push(clonedMsg);
                }
            }
        }
    }
    
    // Also check widget conversation for user messages if no prompt found
    if (!prompt && widget.conversation && widget.conversation.length > 0) {
        for (var i = widget.conversation.length - 1; i >= 0; i--) {
            if (widget.conversation[i].role === 'user') {
                prompt = widget.conversation[i].content;
                break;
            }
        }
    }
    
    if (!prompt) {
        showSnackbar('No prompt found to regenerate', 'error');
        return;
    }
    
    // Store the prompt for future regenerations
    widget.prompt = prompt;
    
    // Close dashboard and show chat
    closeDashboardView();
    
    // Create a new chat for regeneration
    newChat();
    
    // Copy the source chat title to the new chat
    var chat = chats[currentChatId];
    if (sourceChatTitle && sourceChatTitle !== 'New Chat') {
        chat.title = sourceChatTitle;
        chat.isTemporary = false;
        renderChatList();
        updateChatTitleHeader();
    }

    // Copy cached tool results from source chat so cached_content_* tools work
    if (widget.chatId && chats[widget.chatId] && chats[widget.chatId].cachedToolResults) {
        chat.cachedToolResults = Object.assign({}, chats[widget.chatId].cachedToolResults);
    }

    // Store which widget we're regenerating so we can update it when done.
    // B-B2: register against the new chat so concurrent regens don't collide.
    setPendingWidgetRegeneration(currentChatId, widgetId);
    
    // Add history messages first, then the prompt
    
    // Add all history messages
    for (var i = 0; i < historyMessages.length; i++) {
        chat.messages.push(historyMessages[i]);
    }
    
    // Add the prompt as the last user message
    chat.messages.push({ role: 'user', content: prompt });
    renderMessages();
    
    // Run the agent - it will create a new widget via html_widget tool
    // The widget will be linked to this new chat
    runAgent();
    
    showSnackbar('Regenerating widget with full history...', 'info');
}

// Run a prompt for a widget in the background (for batch regeneration)
// Creates a real chat that stays in history, similar to single widget regenerate
async function runWidgetPrompt(widget, prompt) {
    if (!widget || !prompt) return;

    // Store original context to restore after
    var originalChatId = currentChatId;
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

    // Switch to the new chat context for agent execution.
    // B-B2: register against the new chat so concurrent regens don't collide.
    currentChatId = newChatId;
    setPendingWidgetRegeneration(newChatId, widget.id);

    // Set widget as loading
    widget.isLoading = true;
    widget.isStreaming = true;
    activeWidgetStreamingId = widget.id;

    // Save the new chat
    saveChatsToStorage();
    renderChatList();

    // Run agent and wait for completion
    paused = false;
    await runAgent();

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

    // Restore original context
    currentChatId = originalChatId;
    currentEditingWidget = originalEditingWidget;
}

async function refreshAllDashboardWidgets() {
    var widgetList = Object.values(dashboardWidgets);
    if (widgetList.length === 0) {
        showSnackbar('No widgets to refresh', 'error');
        return;
    }
    
    if (dashboardRefreshing) {
        showSnackbar('Already refreshing...', 'warning');
        return;
    }
    
    dashboardRefreshing = true;
    var refreshBtn = document.getElementById('dashboard-refresh-all-btn');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = '<span class="action-icon">' + UI_ICONS.spinner + '</span>Regenerating...';
    }
    
    var skippedWidgets = [];
    var regeneratedCount = 0;

    for (var i = 0; i < widgetList.length; i++) {
        var widget = widgetList[i];
        var prompt = widget.prompt;

        // Try to get prompt from source chat if not directly available
        if (!prompt && widget.chatId && chats[widget.chatId]) {
            var sourceChat = chats[widget.chatId];
            var msgIndex = widget.msgIndex || sourceChat.messages.length;
            for (var j = msgIndex - 1; j >= 0; j--) {
                if (sourceChat.messages[j] && sourceChat.messages[j].role === 'user') {
                    prompt = sourceChat.messages[j].content;
                    widget.prompt = prompt; // Store for future use
                    break;
                }
            }
        }

        // Check if we can regenerate this widget
        if (!prompt) {
            var reason = 'no prompt found';
            if (widget.chatId && !chats[widget.chatId]) {
                reason = 'source chat was deleted';
            }
            skippedWidgets.push({ title: widget.title, reason: reason });
            showSnackbar('Skipping "' + widget.title + '": ' + reason, 'warning');
            continue;
        }

        showSnackbar('Regenerating ' + (regeneratedCount + 1) + '/' + widgetList.length + ': ' + widget.title, 'success');

        // Show loading on this widget
        widget.isLoading = true;
        renderDashboard();

        widget.conversation = [];
        await runWidgetPrompt(widget, prompt);

        widget.isLoading = false;
        renderDashboard();
        regeneratedCount++;
    }

    dashboardRefreshing = false;
    if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = '<span class="action-icon">' + UI_ICONS.refresh + '</span>Regenerate All';
    }

    // Show final status
    if (skippedWidgets.length > 0) {
        showSnackbar(regeneratedCount + ' widgets regenerated, ' + skippedWidgets.length + ' skipped', 'warning');
    } else {
        showSnackbar('All ' + regeneratedCount + ' widgets regenerated', 'success');
    }
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

    // Show empty state if no widgets left
    var container = document.getElementById('dashboard-grid');
    if (container && Object.keys(dashboardWidgets).length === 0) {
        container.innerHTML = '<div class="dashboard-empty"><span class="dashboard-empty-icon">' + UI_ICONS.widget + '</span><p>No widgets yet</p><p class="dashboard-empty-hint">Add widgets to your dashboard using prompts.</p></div>';
    }
    
    showSnackbar('Widget deleted', 'success');
}

function downloadDashboardWidget(widgetId) {
    var widget = dashboardWidgets[widgetId];
    if (!widget) return;
    
    var exportData = {
        type: 'appagent-dashboard-widget',
        version: 1,
        widget: widget
    };
    
    var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'widget-' + (widget.title || widget.id).replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showSnackbar('Widget downloaded', 'success');
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
            
            renderDashboard();
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

    // Only include active skills in the system prompt
    var activeList = skillList.filter(function(s) { return activeSkills[s.id]; });

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

async function loadChatsFromStorage() {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([chatStoreName], 'readonly');
        var store = transaction.objectStore(chatStoreName);
        var request = store.getAll();
        
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var results = request.result || [];
                chats = {};
                results.forEach(function(chat) {
                    if (chat.messages && chat.messages.length > 0) {
                        chats[chat.id] = chat;
                    }
                });
                // WIPE-GUARD follow-up: a throw here previously prevented
                // resolve() — wedging init() at the awaited load — and now
                // would also leave _chatsHydrated false (saves blocked all
                // session) even though `chats` hydrated fine. The file index
                // is a derived cache; its failure must not block hydration.
                try { rebuildFileIndexAll(); } catch (e) { console.error('rebuildFileIndexAll failed during hydration:', e); }
                _chatsHydrated = true;
                resolve();
            };
            request.onerror = function() {
                console.error('Failed to load chats from IndexedDB:', request.error);
                resolve();
            };
        });
    } catch (e) {
        console.error('IndexedDB error:', e);
    }
}

var saveChatsPending = false;
var saveChatsPendingAgain = false;
var _saveChatsWaiters = [];

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
        var database = await openDatabase();
        var transaction = database.transaction([chatStoreName], 'readwrite');
        var store = transaction.objectStore(chatStoreName);
        
        // WIPE-GUARD: diff save — no store.clear(). Delete only ids that
        // vanished from memory, upsert the rest. Even a buggy save can no
        // longer mass-erase the store in one transaction.
        var keysRequest = store.getAllKeys();
        
        await new Promise(function(_resolve) {
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
            keysRequest.onsuccess = function() {
                var existingKeys = keysRequest.result || [];
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
                existingKeys.forEach(function(key) {
                    if (!Object.prototype.hasOwnProperty.call(desired, key)) {
                        pending++;
                        var delRequest = store.delete(key);
                        delRequest.onsuccess = settleOne;
                        delRequest.onerror = settleOne;
                    }
                });
                Object.keys(desired).forEach(function(id) {
                    pending++;
                    var putRequest = store.put(desired[id]);
                    putRequest.onsuccess = settleOne;
                    putRequest.onerror = settleOne;
                });
                if (pending === 0) {
                    updateStorageIndicator();
                    resolve();
                }
            };
            keysRequest.onerror = function() {
                console.error('Failed to read chat store keys:', keysRequest.error);
                resolve();
            };
        });
    } catch (e) {
        console.error('Failed to save chats to IndexedDB:', e);
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
    // Mirror to SW now that IDB load is complete. initDefaultToolPermissions
    // ends in saveToolPermissions which pushes ONLY toolPermissions — so
    // without an explicit instancePermissions push, the SW never learns about
    // tier='auto' on the user's connected instance and prompts on every
    // browser:* / sn:write call. Push both sources together as the
    // authoritative post-IDB-load mirror.
    if (typeof pushPermissionsToOffscreen === 'function') {
        pushPermissionsToOffscreen({
            toolPermissions: toolPermissions,
            instancePermissions: instancePermissions
        });
    }
    // The header tier pill (updateSnStatus) typically renders BEFORE this
    // async IDB load completes, so it shows the default 'Manual' even when
    // the stored tier is 'auto' — and nothing re-renders it until the next
    // connection-state change. Re-render now that the real tiers are loaded.
    if (typeof updateSnStatus === 'function') updateSnStatus();
}

function initDefaultToolPermissions() {
    // Global read tools → allow
    GLOBAL_READ_KEYS.forEach(function(key) {
        if (!toolPermissions[key]) toolPermissions[key] = 'allow';
    });
    // Global write tools → auto (with exceptions)
    GLOBAL_WRITE_KEYS.forEach(function(key) {
        if (!toolPermissions[key]) {
            if (key === 'manage_skill:activate') {
                toolPermissions[key] = 'disabled';
            } else if (key === 'web_fetch') {
                toolPermissions[key] = 'ask';
            } else {
                toolPermissions[key] = 'auto';
            }
        }
    });
    saveToolPermissions();
}

function _getGlobalDefault(key) {
    if (GLOBAL_READ_KEYS.indexOf(key) !== -1) return 'allow';
    if (key === 'manage_skill:activate') return 'disabled';
    if (key === 'web_fetch') return 'ask';
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

    // Clear session permissions
    sessionPermissions = {};

    // Re-render
    renderToolPermissions();
    if (typeof renderSettingsToolPermissions === 'function') renderSettingsToolPermissions();
    if (typeof updateSnStatus === 'function') updateSnStatus();
    showSnackbar('All permissions reset to defaults', 'success');
}
