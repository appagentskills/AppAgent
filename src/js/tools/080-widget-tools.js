// HTML WIDGET TOOL - Display interactive widgets inline
// =============================================

function executeHtmlWidget(args, messageIndex, options) {
    var title = args.title || 'Widget';
    var html = args.html || '';
    var height = args.height || '400px';
    var width = args.width || '400px';
    
    if (!html) {
        return { success: false, error: 'html content is required' };
    }
    
    // Use activeStreamingChatId if available (preserves correct chat during navigation)
    // Otherwise fall back to currentChatId
    var widgetChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
    
    // Create widget object
    // The tool result message will be added at the current messages length after this returns
    var chat = chats[widgetChatId];
    var toolResultMsgIndex = chat ? chat.messages.length : -1;
    
    var widgetId = 'widget_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    var widget = {
        id: widgetId,
        title: title,
        html: html,
        height: height,
        width: width,
        createdAt: Date.now(),
        msgIndex: toolResultMsgIndex,
        chatId: widgetChatId
    };

    // Store widget in chat object for persistence
    if (!chat.widgets) {
        chat.widgets = [];
    }
    chat.widgets.push(widget);
    
    // Sync in-memory cache with chat.widgets (they should be the same reference)
    chatWidgets[widgetChatId] = chat.widgets;
    
    // Ensure chat is saved with the widget (remove temporary flag if present)
    delete chat.isTemporary;
    saveChatsToStorage();
    
    // If this is a regeneration, update the dashboard widget with new HTML.
    // B-B2: pendingWidgetRegeneration was a single-slot global that two parallel
    // regenerations could stomp on. It's now a Set keyed by the widget id of the
    // most recent prior incarnation, populated by the regeneration code path. We
    // pop the matching entry by source-chat lookup so concurrent regenerations
    // don't claim each other's results.
    var regenSourceId = consumePendingWidgetRegeneration(widgetChatId);
    if (regenSourceId && dashboardWidgets[regenSourceId]) {
        var dashWidget = dashboardWidgets[regenSourceId];
        dashWidget.html = html;
        dashWidget.title = title;
        dashWidget.chatId = widgetChatId;
        dashWidget.msgIndex = toolResultMsgIndex;
        dashWidget.error = null;
        saveDashboardWidget(dashWidget);
    }
    
    // Update sidebar widget list
    renderWidgetSidebar();
    
    return { 
        success: true, 
        message: 'Widget "' + title + '" created successfully',
        widgetId: widgetId,
        _debug_hint: 'To debug this widget, use iframe_tool with widget_id="' + widgetId + '". Actions: get_visible_text (extract text), get_dom (get HTML), click (click elements), fill (fill inputs). For visual analysis, use take_screenshot tool.'
    };
}

function getWidgetsForChat(chatId) {
    // First check in-memory cache
    if (chatWidgets[chatId] && chatWidgets[chatId].length > 0) {
        return chatWidgets[chatId];
    }
    // Fall back to chat object (persisted widgets)
    var chat = chats[chatId];
    if (chat && chat.widgets && chat.widgets.length > 0) {
        // Populate cache from persisted data
        chatWidgets[chatId] = chat.widgets;
        return chat.widgets;
    }
    return [];
}

function getWidgetById(widgetId) {
    // First check in-memory cache
    var allCachedWidgets = Object.values(chatWidgets).flat();
    var found = allCachedWidgets.find(function(w) { return w.id === widgetId; });
    if (found) return found;
    
    // Fall back to searching persisted widgets in all chats
    var chatIds = Object.keys(chats);
    for (var i = 0; i < chatIds.length; i++) {
        var chat = chats[chatIds[i]];
        if (chat.widgets) {
            var widget = chat.widgets.find(function(w) { return w.id === widgetId; });
            if (widget) {
                // Populate cache
                if (!chatWidgets[chatIds[i]]) chatWidgets[chatIds[i]] = [];
                if (!chatWidgets[chatIds[i]].find(function(w) { return w.id === widgetId; })) {
                    chatWidgets[chatIds[i]] = chat.widgets;
                }
                return widget;
            }
        }
    }
    return null;
}

function toggleWidgetRunning(widgetId, event) {
    if (event) event.stopPropagation();
    // Find the widget object and check persisted deactivated state
    var widget = getWidgetById(widgetId);
    if (!widget && dashboardWidgets[widgetId]) widget = dashboardWidgets[widgetId];
    if (!widget) return;

    var isDeactivated = widget.deactivated;

    // Find the widget container (inline or dashboard)
    var container = document.getElementById('widget-content-' + widgetId)
        || document.getElementById('dashboard-widget-content-' + widgetId);

    if (isDeactivated) {
        // Activate: clear deactivated flag and re-render
        widget.deactivated = false;
        if (container) {
            container.innerHTML = '';
            renderWidgetInContainer(widget, container);
        }
    } else {
        // Deactivate: kill iframe and persist
        widget.deactivated = true;
        if (container) {
            var iframe = container.querySelector('iframe');
            if (iframe) {
                iframe.srcdoc = '';
                iframe.remove();
            }
            container.innerHTML = '<div style="padding: var(--space-9);color:var(--text-secondary);text-align:center;font-size:var(--text-body);">Widget deactivated.</div>';
        }
    }

    // Persist deactivated state
    saveChatsToStorage();

    // Update all toggle buttons for this widget
    var buttons = document.querySelectorAll('.widget-stop-btn[data-widget-id="' + widgetId + '"]');
    buttons.forEach(function(btn) {
        btn.innerHTML = isDeactivated ? UI_ICONS.stop : UI_ICONS.play;
        btn.title = isDeactivated ? 'Deactivate Widget' : 'Activate Widget';
    });
}

function renderWidgetInContainer(widget, container, options) {
    options = options || {};
    var isFullscreen = options.fullscreen || false;
    // Create iframe for complete CSS and script isolation
    var iframe = document.createElement('iframe');
    iframe.className = 'widget-iframe';
    iframe.style.cssText = 'width:100%; border:none; display:block; overflow:hidden;';
    iframe.setAttribute('scrolling', 'no');

    var isThumbnail = container.closest('.widgets-container') !== null;

    // Build widget HTML with bridge
    var widgetHtml = injectWidgetBridge(widget.html, widget.title);

    // Inject a height reporter for cross-origin auto-resize via postMessage
    // (widget-sandbox.html has a unique origin, so direct DOM access won't work)
    var heightScript = '<script>(function(){' +
        'function _rh(){var h=document.body?document.body.scrollHeight:0;if(h>0)window.parent.postMessage({type:"widgetResize",height:h},"*");}' +
        'window.addEventListener("load",_rh);' +
        'if(document.body){try{new MutationObserver(_rh).observe(document.body,{childList:true,subtree:true});' +
        '}catch(e){}}document.addEventListener("DOMContentLoaded",function(){' +
        'if(document.body){document.body.style.margin="0";document.body.style.overflow="hidden";' +
        'try{new MutationObserver(_rh).observe(document.body,{childList:true,subtree:true});}catch(e){}_rh();}});' +
        'setInterval(_rh,2000);' +
    '})();<\/script>';
    if (widgetHtml.match(/<\/body>/i)) {
        widgetHtml = widgetHtml.replace(/<\/body>/i, heightScript + '</body>');
    } else {
        widgetHtml += heightScript;
    }

    container.appendChild(iframe);
    writeWidgetHtml(iframe, widgetHtml);

    // Thumbnail mode: pure CSS scaled preview, no auto-resize
    if (isThumbnail) {
        iframe.style.cssText = 'position:absolute;top:0;left:0;border:none;transform:scale(0.4);transform-origin:top left;width:250%;height:250%;';
        return iframe;
    }

    // Set initial height from last known value to prevent layout shift on re-render
    if (!isFullscreen && widget.lastHeight > 0) {
        iframe.style.height = widget.lastHeight + 'px';
    }

    // Listen for height updates from the in-widget height reporter (cross-origin)
    function onWidgetResize(e) {
        if (e.source !== iframe.contentWindow) return;
        if (isFullscreen) return;
        if (e.data && e.data.type === 'widgetResize' && e.data.height > 0) {
            iframe.style.height = e.data.height + 'px';
            widget.lastHeight = e.data.height;
        }
    }
    window.addEventListener('message', onWidgetResize);

    // Store cleanup function on iframe for proper resource cleanup when removed
    iframe.__widgetCleanup = function() {
        window.removeEventListener('message', onWidgetResize);
    };
    
    // For fullscreen, fill the container
    if (isFullscreen) {
        iframe.style.height = '100%';
        iframe.style.flex = '1';
        iframe.removeAttribute('scrolling');
        iframe.style.overflow = 'auto';
    }
    
    return iframe;
}

function toggleChatWidgetExpand(widgetId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    var widgetEl = document.getElementById('widget-' + widgetId);
    if (!widgetEl) {
        console.warn('Widget element not found:', widgetId);
        return;
    }
    
    var content = widgetEl.querySelector('.widget-content');
    if (!content) {
        console.warn('Widget content not found for:', widgetId);
        return;
    }
    
    // Toggle collapsed state (widgets are expanded by default)
    var isCollapsed = content.classList.toggle('collapsed');
    widgetEl.classList.toggle('collapsed', isCollapsed);

    // Persist collapsed state on the widget object so it survives re-renders
    var widget = getWidgetById(widgetId);
    if (widget) widget.collapsed = isCollapsed;

    // Update button icon - show expand when collapsed, collapse when expanded
    var expandBtn = widgetEl.querySelector('.widget-expand-btn');
    if (expandBtn) {
        expandBtn.innerHTML = isCollapsed
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6M14 4h6v6M10 14l-7 7M21 3l-7 7"/></svg>';
        expandBtn.title = isCollapsed ? 'Expand' : 'Collapse';
    }
}

function openWidgetFullscreen(widgetId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    var widget = getWidgetById(widgetId);
    if (!widget) return;
    
    // Remove any existing fullscreen overlay first
    closeWidgetFullscreen();
    expandedWidgetId = widgetId;

    // Create fullscreen overlay
    var overlay = document.createElement('div');
    overlay.className = 'widget-fullscreen-overlay';
    overlay.id = 'widget-fullscreen-overlay';
    
    var modal = document.createElement('div');
    modal.className = 'widget-fullscreen-modal';
    
    // Header with all control icons
    var header = document.createElement('div');
    header.className = 'widget-fullscreen-header';
    var isOnDash = dashboardWidgets[widget.id] ? true : false;
    var dashBtn = isOnDash
        ? '<button class="widget-ctrl-btn widget-dashboard-btn on-dashboard" onclick="removeWidgetFromDashboard(\'' + widget.id + '\', event);closeWidgetFullscreen()" title="Remove from Dashboard">' + UI_ICONS.pinFilled + '</button>'
        : '<button class="widget-ctrl-btn widget-dashboard-btn" onclick="addWidgetToDashboard(\'' + widget.id + '\', event);closeWidgetFullscreen()" title="Add to Dashboard">' + UI_ICONS.pin + '</button>';
    header.innerHTML = '<span class="widget-icon">' + UI_ICONS.widget + '</span>' +
        '<span class="widget-title">' + escapeHtml(widget.title) + '</span>' +
        '<div class="widget-modal-controls">' +
            '<button class="widget-ctrl-btn widget-stop-btn" onclick="toggleWidgetRunning(\'' + widget.id + '\', event);closeWidgetFullscreen()" title="' + (widget.deactivated ? 'Activate Widget' : 'Deactivate Widget') + '">' + (widget.deactivated ? UI_ICONS.play : UI_ICONS.stop) + '</button>' +
            dashBtn +
            '<button class="widget-ctrl-btn" onclick="printWidgetFullscreen()" title="Print">' + UI_ICONS.printer + '</button>' +
            '<button class="widget-ctrl-btn" onclick="screenshotWidget(\'' + widget.id + '\')" title="Screenshot">' + UI_ICONS.camera + '</button>' +
            '<button class="widget-ctrl-btn" onclick="openWidgetLink(\'' + widget.id + '\')" title="Open in New Tab">' + UI_ICONS.externalLink + '</button>' +
            '<button class="widget-ctrl-btn" onclick="closeWidgetFullscreen();editWidgetCode(\'' + widget.id + '\')" title="Edit Code">' + UI_ICONS.edit + '</button>' +
            '<button class="widget-close-btn" onclick="closeWidgetFullscreen()">' + UI_ICONS.close + '</button>' +
        '</div>';
    
    // Content
    var content = document.createElement('div');
    content.className = 'widget-fullscreen-content';
    
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    // Render widget
    renderWidgetInContainer(widget, content, { fullscreen: true });
    
    // Close on backdrop click
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeWidgetFullscreen();
    });
    
}

function closeWidgetFullscreen() {
    var overlay = document.getElementById('widget-fullscreen-overlay');
    if (overlay) overlay.remove();
    expandedWidgetId = null;
}

function openWidgetLink(widgetId) {
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html') + '?widget=' + encodeURIComponent(widgetId) });
}

function printWidgetFullscreen() {
    var widget = expandedWidgetId ? getWidgetById(expandedWidgetId) : null;
    if (!widget || !widget.html) return;
    var win = window.open('', '_blank');
    if (!win) return;
    win.document.write(widget.html);
    win.document.close();
    win.focus();
    setTimeout(function() { win.print(); }, 500);
}

async function screenshotWidget(widgetId) {
    var widget = getWidgetById(widgetId);
    if (!widget || !widget.html) { showSnackbar('Widget not found', 'error'); return; }
    var iframe = getWidgetIframe(widgetId);
    if (!iframe) { showSnackbar('Widget not visible', 'error'); return; }

    var base64Data;
    var canAccessDOM = false;
    try { canAccessDOM = !!iframe.contentDocument; } catch(e) {}

    if (canAccessDOM) {
        var doc = iframe.contentDocument;
        var el = doc.body || doc.documentElement;
        var w = iframe.clientWidth || el.scrollWidth;
        var h = el.scrollHeight || iframe.clientHeight;
        var ratio = window.devicePixelRatio || 1;
        var opts = { width: w, height: h, pixelRatio: ratio, filter: screenshotFilter };
        if (_htiFontCache != null) opts.fontEmbedCSS = _htiFontCache;
        var svgUrl = await _htiToSvg(el, opts);
        base64Data = await svgToPng(sanitizeSvgDataUrl(svgUrl), w, h, ratio);
    } else {
        var url = chrome.runtime.getURL('app.html') + '?widget=' + encodeURIComponent(widgetId);
        var tab = await chrome.tabs.create({ url: url, active: false });
        await new Promise(function(resolve) {
            function onUpdated(tabId, info) {
                if (tabId === tab.id && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    clearTimeout(fb);
                    setTimeout(resolve, 200);
                }
            }
            chrome.tabs.onUpdated.addListener(onUpdated);
            var fb = setTimeout(function() { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 5000);
        });
        var chat = chats[currentChatId];
        var origTabId = chat && chat.targetTabId;
        if (chat) chat.targetTabId = tab.id;
        var result = await Platform.sendBrowserAction('take_screenshot', {});
        if (chat) chat.targetTabId = origTabId;
        try { chrome.tabs.remove(tab.id); } catch(e) {}
        if (result.error) { showSnackbar('Screenshot failed', 'error'); return; }
        base64Data = result.base64;
    }

    var link = document.createElement('a');
    link.href = base64Data;
    link.download = (widget.title || 'widget').replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Edit widget code manually
function editWidgetCode(widgetId) {
    var widget = getWidgetById(widgetId);
    if (!widget) { showSnackbar('Widget not found', 'error'); return; }
    
    // Create modal for editing
    var overlay = document.createElement('div');
    overlay.className = 'widget-modal-overlay';
    overlay.id = 'widget-edit-overlay';
    
    var modal = document.createElement('div');
    modal.className = 'widget-modal';
    modal.style.width = '80vw';
    modal.style.height = '80vh';
    
    var header = document.createElement('div');
    header.className = 'widget-modal-header';
    header.innerHTML = '<span class="widget-icon">' + UI_ICONS.edit + '</span>' +
        '<span class="widget-title">Edit Widget: ' + escapeHtml(widget.title) + '</span>' +
        '<div class="widget-modal-controls">' +
            '<button class="widget-ctrl-btn primary" onclick="saveWidgetCodeEdit(\'' + widget.id + '\')" title="Save">' + UI_ICONS.save + '</button>' +
            '<button class="widget-close-btn" onclick="closeWidgetCodeEdit()">' + UI_ICONS.close + '</button>' +
        '</div>';
    
    var content = document.createElement('div');
    content.className = 'widget-modal-content';
    content.style.height = 'calc(100% - 50px)';
    content.innerHTML = '<textarea id="widget-code-editor" style="width:100%;height:100%;font-family:var(--font-mono);font-size:var(--text-body);padding: var(--space-6);border:none;resize:none;box-sizing:border-box;">' + escapeHtml(widget.html || '') + '</textarea>';
    
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    // Focus editor
    setTimeout(function() {
        var editor = document.getElementById('widget-code-editor');
        if (editor) editor.focus();
    }, 100);
    
    // Close on backdrop click
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeWidgetCodeEdit();
    });
}

function closeWidgetCodeEdit() {
    var overlay = document.getElementById('widget-edit-overlay');
    if (overlay) overlay.remove();
}

async function saveWidgetCodeEdit(widgetId) {
    var editor = document.getElementById('widget-code-editor');
    if (!editor) return;
    
    var widget = getWidgetById(widgetId);
    if (!widget) { showSnackbar('Widget not found', 'error'); return; }
    
    widget.html = editor.value;
    widget.updatedAt = Date.now();
    
    // Save to appropriate store.
    // B-B3: write to the widget's *owning* chat, not the foreground chat. Editing
    // a widget that lives in chat A from a UI route that fires while the user is
    // viewing chat B previously updated chat B's array (or no-op'd if B had no
    // widget array of its own).
    if (dashboardWidgets[widgetId]) {
        await saveDashboardWidget(widget);
    }
    var owningChatId = widget.chatId || currentChatId;
    if (chatWidgets[owningChatId]) {
        var idx = chatWidgets[owningChatId].findIndex(function(w) { return w.id === widgetId; });
        if (idx >= 0) {
            chatWidgets[owningChatId][idx] = widget;
            await saveChatsToStorage();
        }
    }
    
    closeWidgetCodeEdit();
    renderMessages();
    renderDashboard();
    showSnackbar('Widget saved', 'success');
}

function openWidgetModal(widgetId) {
    var widget = getWidgetById(widgetId);
    if (!widget) return;
    
    // Create modal overlay
    var overlay = document.createElement('div');
    overlay.className = 'widget-modal-overlay';
    overlay.id = 'widget-modal-overlay';
    
    var modal = document.createElement('div');
    modal.className = 'widget-modal';
    modal.style.width = widget.width === '100%' ? '80%' : widget.width;
    
    // Header
    var header = document.createElement('div');
    header.className = 'widget-modal-header';
    header.innerHTML = '<span class="widget-icon">' + UI_ICONS.widget + '</span>' +
        '<span class="widget-title">' + escapeHtml(widget.title) + '</span>' +
        '<div class="widget-modal-controls">' +
            '<button class="widget-ctrl-btn" onclick="screenshotWidget(\'' + widget.id + '\')" title="Screenshot">' + UI_ICONS.camera + '</button>' +
            '<button class="widget-ctrl-btn" onclick="closeWidgetModal();openWidgetFullscreen(\'' + widget.id + '\')" title="Fullscreen">' + UI_ICONS.maximize + '</button>' +
            '<button class="widget-close-btn" onclick="closeWidgetModal()">' + UI_ICONS.close + '</button>' +
        '</div>';
    
    // Content
    var content = document.createElement('div');
    content.className = 'widget-modal-content';
    content.style.height = widget.height || '300px';
    
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    // Render widget
    renderWidgetInContainer(widget, content);
    
    // Close on backdrop click
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeWidgetModal();
    });
}

function closeWidgetModal() {
    var overlay = document.getElementById('widget-modal-overlay');
    if (overlay) overlay.remove();
}

function renderWidgetSidebar() {
    var widgets = getWidgetsForChat(currentChatId);
    var container = document.getElementById('widget-sidebar-list');
    if (!container) return;
    
    if (widgets.length === 0) {
        container.innerHTML = '<div class="widget-sidebar-empty">No widgets yet</div>';
        return;
    }
    
    var html = '';
    widgets.forEach(function(widget) {
        var isOnDashboard = dashboardWidgets && dashboardWidgets[widget.id];
        var dashboardBtnClass = isOnDashboard ? 'widget-sidebar-btn on-dashboard' : 'widget-sidebar-btn';
        var dashboardBtnTitle = isOnDashboard ? 'Remove from Dashboard' : 'Add to Dashboard';
        var dashboardBtnIcon = isOnDashboard ? UI_ICONS.pinFilled : UI_ICONS.pin;
        html += '<div class="widget-sidebar-item" onclick="scrollToWidget(\'' + widget.id + '\')">' +
            '<span class="widget-sidebar-icon">' + UI_ICONS.widget + '</span>' +
            '<span class="widget-sidebar-title">' + escapeHtml(widget.title) + '</span>' +
            '<div class="widget-sidebar-actions">' +
            '<button class="widget-sidebar-btn" onclick="event.stopPropagation();showWidgetInPanel(\'' + widget.id + '\')" title="Show in Panel">' + UI_ICONS.panelRight + '</button>' +
            '<button class="' + dashboardBtnClass + '" onclick="event.stopPropagation();toggleWidgetOnDashboard(\'' + widget.id + '\')" title="' + dashboardBtnTitle + '">' + dashboardBtnIcon + '</button>' +
            '<button class="widget-sidebar-btn" onclick="event.stopPropagation();openWidgetFullscreen(\'' + widget.id + '\')" title="Fullscreen">' + UI_ICONS.maximize + '</button>' +
            '</div>' +
        '</div>';
    });
    
    container.innerHTML = html;
}

function scrollToWidget(widgetId) {
    var widgetEl = document.getElementById('widget-' + widgetId);
    if (widgetEl) {
        widgetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Briefly highlight the widget
        widgetEl.classList.add('highlight');
        setTimeout(function() {
            widgetEl.classList.remove('highlight');
        }, 1500);
    } else {
        // Widget not in view, open modal instead
        openWidgetModal(widgetId);
    }
}

function getWidgetHtmlForMessage(msgIndex) {
    var widgets = getWidgetsForChat(currentChatId);
    var msgWidgets = widgets.filter(function(w) { return w.msgIndex === msgIndex; });
    
    if (msgWidgets.length === 0) return '';
    
    var html = '';
    msgWidgets.forEach(function(widget) {
        var isOnDashboard = dashboardWidgets[widget.id] ? true : false;
        var dashboardBtn = isOnDashboard 
            ? '<button class="widget-ctrl-btn widget-dashboard-btn on-dashboard" onclick="removeWidgetFromDashboard(\'' + widget.id + '\', event)" title="Remove from Dashboard">' + UI_ICONS.pinFilled + '</button>'
            : '<button class="widget-ctrl-btn widget-dashboard-btn" onclick="addWidgetToDashboard(\'' + widget.id + '\', event)" title="Add to Dashboard">' + UI_ICONS.pin + '</button>';
        
        var isCollapsed = widget.collapsed;
        var collapsedClass = isCollapsed ? ' collapsed' : '';
        var expandIcon = isCollapsed
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6M14 4h6v6M10 14l-7 7M21 3l-7 7"/></svg>';
        var expandTitle = isCollapsed ? 'Expand' : 'Collapse';
        html += '<div class="widget-inline' + collapsedClass + '" id="widget-' + widget.id + '" data-widget-id="' + widget.id + '">' +
            '<div class="widget-header">' +
                '<span class="widget-icon">' + UI_ICONS.widget + '</span>' +
                '<span class="widget-title">' + escapeHtml(widget.title) + '</span>' +
                '<div class="widget-controls">' +
                    dashboardBtn +
                    '<button class="widget-ctrl-btn widget-stop-btn" data-widget-id="' + widget.id + '" onclick="toggleWidgetRunning(\'' + widget.id + '\', event)" title="' + (widget.deactivated ? 'Activate Widget' : 'Deactivate Widget') + '">' +
                        (widget.deactivated ? UI_ICONS.play : UI_ICONS.stop) +
                    '</button>' +
                    '<button class="widget-ctrl-btn widget-edit-btn" onclick="editWidgetCode(\'' + widget.id + '\')" title="Edit Code">' +
                        UI_ICONS.edit +
                    '</button>' +
                    '<button class="widget-ctrl-btn" onclick="screenshotWidget(\'' + widget.id + '\')" title="Screenshot">' +
                        UI_ICONS.camera +
                    '</button>' +
                    '<button class="widget-ctrl-btn widget-panel-btn" onclick="openWidgetInIframePanel(\'' + widget.id + '\')" title="Open in New Tab">' +
                        UI_ICONS.panelRight +
                    '</button>' +
                    '<button class="widget-ctrl-btn widget-expand-btn" onclick="toggleChatWidgetExpand(\'' + widget.id + '\', event)" title="' + expandTitle + '">' +
                        expandIcon +
                    '</button>' +
                    '<button class="widget-ctrl-btn widget-fullscreen-btn" onclick="openWidgetFullscreen(\'' + widget.id + '\', event)" title="Fullscreen">' +
                        UI_ICONS.maximize +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="widget-content' + collapsedClass + '" id="widget-content-' + widget.id + '"></div>' +
        '</div>';
    });
    
    return html;
}

function initializeWidgetsInView() {
    var widgets = getWidgetsForChat(currentChatId);
    widgets.forEach(function(widget) {
        var container = document.getElementById('widget-content-' + widget.id);
        if (container && !container.hasChildNodes()) {
            if (widget.deactivated) {
                container.innerHTML = '<div style="padding: var(--space-9);color:var(--text-secondary);text-align:center;font-size:var(--text-body);">Widget deactivated.</div>';
            } else {
                renderWidgetInContainer(widget, container);
            }
        }
    });
}

async function executeGetSkill(args) {
    var skillId = args.skill_id;
    var action = args.action || 'get';
    
    if (!skillId) return { success: false, error: 'skill_id is required' };
    var skill = skills[skillId];
    if (!skill) return { success: false, error: 'Skill not found: ' + skillId };
    
    if (action === 'read_file') {
        var filename = args.filename;
        if (!filename) return { success: false, error: 'filename is required for read_file action' };
        var asset = await getSkillAsset(skillId, filename);
        if (!asset) return { success: false, error: 'File not found: ' + filename };
        return { success: true, filename: asset.filename, type: asset.type, content: asset.content };
    }
    
    // Default action: get skill with file list
    var assets = await getSkillAssets(skillId);
    var fileList = assets.map(function(a) { return { filename: a.filename, type: a.type }; });
    
    return { 
        success: true, 
        skill: { 
            id: skill.id, 
            title: skill.title, 
            content: skill.body, 
            tags: skill.tags || [],
            is_active: !!activeSkills[skillId]
        },
        files: fileList,
        hint: fileList.length > 0 ? 'Use get_skill with action="read_file" and filename to read specific files' : null
    };
}

async function executeManageSkill(args) {
    var action = args.action;
    var skillId = args.skill_id;
    
    if (action === 'create') {
        var name = args.name || 'untitled-skill';
        var description = args.description || '';
        var body = args.body || '';
        var sanitizedActions = Array.isArray(args.actions)
            ? args.actions.map(sanitizeAction).filter(function(a){ return a; })
            : [];

        // Generate ID from name
        var id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!id) id = 'skill-' + Date.now();
        if (skills[id]) id = id + '-' + Date.now();

        await saveSkill({
            id: id,
            name: name,
            description: description,
            body: body,
            actions: sanitizedActions,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });

        renderSkillsList();
        if (sanitizedActions.length && typeof renderAllActionPlacements === 'function') {
            renderAllActionPlacements();
        }
        return {
            success: true,
            skill_id: id,
            message: 'Skill created: ' + name + (sanitizedActions.length ? ' (' + sanitizedActions.length + ' action' + (sanitizedActions.length === 1 ? '' : 's') + ')' : ''),
            actions: sanitizedActions
        };
    }
    
    if (!skillId) return { success: false, error: 'skill_id is required for action: ' + action };
    var skill = skills[skillId];
    if (!skill && action !== 'create') return { success: false, error: 'Skill not found: ' + skillId };
    
    if (action === 'update') {
        if (args.name) skill.name = args.name;
        if (args.description !== undefined) skill.description = args.description;
        if (args.body !== undefined) skill.body = args.body;
        var actionsChanged = false;
        if (Array.isArray(args.actions)) {
            var sanitized = args.actions.map(sanitizeAction).filter(function(a){ return a; });
            skill.actions = (typeof dedupeActionsByActionId === 'function')
                ? dedupeActionsByActionId(skill.name || skill.id, sanitized)
                : sanitized;
            actionsChanged = true;
        }
        skill.updatedAt = Date.now();
        skill.userModified = true;
        await saveSkill(skill);
        renderSkillsList();
        if (actionsChanged && typeof renderAllActionPlacements === 'function') {
            renderAllActionPlacements();
        }
        return {
            success: true,
            message: 'Skill updated: ' + (skill.name || skill.id),
            actions: Array.isArray(skill.actions) ? skill.actions : []
        };
    }
    
    if (action === 'edit') {
        // Search-and-replace edits on skill body or a skill file (same shape as
        // servicenow_diff_edit / workspace edit / document edit). Each edit's `find`
        // must occur exactly once in the target content; otherwise we fail safely
        // before mutating anything so the caller can disambiguate.
        var edits = args.edits;
        if (!Array.isArray(edits) || edits.length === 0) {
            return { success: false, error: 'edits array is required and must be non-empty' };
        }
        var editFilename = args.filename;
        var content;
        var assetType = null;
        if (editFilename) {
            var existingAsset = await getSkillAsset(skillId, editFilename);
            if (!existingAsset) return { success: false, error: 'File not found: ' + editFilename };
            content = existingAsset.content;
            assetType = existingAsset.type;
        } else {
            content = skill.body || '';
        }

        for (var ei = 0; ei < edits.length; ei++) {
            var edit = edits[ei];
            if (typeof edit !== 'object' || edit === null) {
                return { success: false, error: 'Edit ' + ei + ': must be an object' };
            }
            if (typeof edit.find !== 'string' || edit.find === '') {
                return { success: false, error: 'Edit ' + ei + ': find is required and must be a non-empty string' };
            }
            if (typeof edit.replace !== 'string') {
                return { success: false, error: 'Edit ' + ei + ': replace is required and must be a string' };
            }
            var idx = content.indexOf(edit.find);
            if (idx === -1) {
                return { success: false, error: 'Edit ' + ei + ': text not found: "' + edit.find.substring(0, 80) + (edit.find.length > 80 ? '…' : '') + '"' };
            }
            if (content.indexOf(edit.find, idx + 1) !== -1) {
                return { success: false, error: 'Edit ' + ei + ': text is not unique (found multiple occurrences) — add more surrounding context to disambiguate' };
            }
            content = content.substring(0, idx) + edit.replace + content.substring(idx + edit.find.length);
        }

        // Mark embedded skills as user-modified so future imports don't overwrite.
        var wasEmbedded = !!(skill.embeddedHash && !skill.userModified);

        if (editFilename) {
            await saveSkillAsset(skillId, editFilename, assetType, content);
            if (wasEmbedded) { skill.userModified = true; await saveSkill(skill); }
            // Re-parse SKILL.md frontmatter when editing it, same as add_file/update_file.
            var skillMdParsed = false;
            if (assetType === 'md' && /^skill\.md$/i.test(editFilename) && typeof parseSkillMarkdown === 'function') {
                try {
                    var parsed = parseSkillMarkdown(content, editFilename);
                    if (parsed) {
                        if (parsed.name) skill.name = parsed.name;
                        if (parsed.description) skill.description = parsed.description;
                        if (typeof parsed.body === 'string') skill.body = parsed.body;
                        if (Array.isArray(parsed.actions)) {
                            skill.actions = (typeof dedupeActionsByActionId === 'function')
                                ? dedupeActionsByActionId(skill.name || skill.id, parsed.actions)
                                : parsed.actions;
                        }
                        skill.updatedAt = Date.now();
                        skill.userModified = true;
                        await saveSkill(skill);
                        skillMdParsed = true;
                        if (typeof renderAllActionPlacements === 'function') renderAllActionPlacements();
                    }
                } catch (e) {
                    console.warn('SKILL.md frontmatter parse failed:', e);
                }
            }
            // Reload tools immediately if the edited file is a JS file on an active skill.
            if (activeSkills[skillId] && assetType === 'js') {
                await loadSkillTools(skillId);
            }
            renderSkillsList();
            var fileMsg = 'File edited: ' + editFilename + '. ' + edits.length + ' edit(s) applied.';
            if (activeSkills[skillId] && assetType === 'xml') {
                fileMsg += ' Deactivate and reactivate the skill to upload XML to instance.';
            }
            if (skillMdParsed) {
                fileMsg += ' SKILL.md frontmatter applied to skill record.';
            }
            return { success: true, message: fileMsg, edits_applied: edits.length, skill_md_parsed: skillMdParsed };
        } else {
            skill.body = content;
            skill.updatedAt = Date.now();
            skill.userModified = true;
            await saveSkill(skill);
            renderSkillsList();
            return {
                success: true,
                message: 'Skill edited: ' + (skill.name || skill.id) + '. ' + edits.length + ' edit(s) applied.',
                edits_applied: edits.length
            };
        }
    }

    if (action === 'add_file' || action === 'update_file') {
        var filename = args.filename;
        var content = args.file_content;
        if (!filename) return { success: false, error: 'filename is required' };
        if (content === undefined) return { success: false, error: 'file_content is required' };

        var ext = filename.split('.').pop().toLowerCase();
        if (!['xml', 'md', 'js'].includes(ext)) {
            return { success: false, error: 'File type must be .xml, .md, or .js' };
        }

        await saveSkillAsset(skillId, filename, ext, content);

        // Mark as user-modified so embedded import doesn't overwrite
        if (skill.embeddedHash && !skill.userModified) { skill.userModified = true; await saveSkill(skill); }

        // If the writer is updating SKILL.md, re-parse its frontmatter so any
        // declared actions / name / description propagate to the live skill record.
        var skillMdParsed = false;
        if (ext === 'md' && /^skill\.md$/i.test(filename) && typeof parseSkillMarkdown === 'function') {
            try {
                var parsed = parseSkillMarkdown(content, filename);
                if (parsed) {
                    if (parsed.name) skill.name = parsed.name;
                    if (parsed.description) skill.description = parsed.description;
                    if (typeof parsed.body === 'string') skill.body = parsed.body;
                    if (Array.isArray(parsed.actions)) {
                        skill.actions = (typeof dedupeActionsByActionId === 'function')
                            ? dedupeActionsByActionId(skill.name || skill.id, parsed.actions)
                            : parsed.actions;
                    }
                    skill.updatedAt = Date.now();
                    skill.userModified = true;
                    await saveSkill(skill);
                    skillMdParsed = true;
                    if (typeof renderAllActionPlacements === 'function') renderAllActionPlacements();
                    if (typeof renderSkillsList === 'function') renderSkillsList();
                }
            } catch (e) {
                // Frontmatter parse failures shouldn't block the file write
                console.warn('SKILL.md frontmatter parse failed:', e);
            }
        }

        // If skill is active and it's a JS file, reload tools immediately
        // XML files require reactivation to upload to instance
        if (activeSkills[skillId] && ext === 'js') {
            await loadSkillTools(skillId);
        }

        var msg = 'File ' + (action === 'add_file' ? 'added' : 'updated') + ': ' + filename;
        if (activeSkills[skillId] && ext === 'xml') {
            msg += '. Deactivate and reactivate the skill to upload XML to instance.';
        }
        if (skillMdParsed) {
            msg += '. SKILL.md frontmatter applied to skill record.';
        }

        return { success: true, message: msg, skill_md_parsed: skillMdParsed };
    }

    if (action === 'delete_file') {
        var filename = args.filename;
        if (!filename) return { success: false, error: 'filename is required' };
        var delExt = filename.split('.').pop().toLowerCase();
        await deleteSkillAsset(skillId, filename);

        // Mark as user-modified so embedded import doesn't overwrite
        if (skill.embeddedHash && !skill.userModified) { skill.userModified = true; await saveSkill(skill); }

        // Reload tools if skill is active and it was a JS file
        if (activeSkills[skillId] && delExt === 'js') {
            await loadSkillTools(skillId);
        }

        var msg = 'File deleted: ' + filename;
        if (activeSkills[skillId] && delExt === 'xml') {
            msg += '. Deactivate and reactivate the skill to revert XML changes.';
        }

        return { success: true, message: msg };
    }
    
    if (action === 'activate') {
        var result = await activateSkill(skillId);
        return result;
    }
    
    if (action === 'deactivate') {
        var result = await deactivateSkill(skillId);
        return result;
    }
    
    return { success: false, error: 'Unknown action: ' + action };
}
