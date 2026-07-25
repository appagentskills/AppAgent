// HTML WIDGET TOOL - Display interactive widgets inline
// =============================================

async function executeHtmlWidget(args, messageIndex, options) {
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

    // Resolve the index where THIS tool's tool_result will land. With the
    // atomic-placeholder seeding the SW does before dispatching the first
    // tool of an assistant turn, `chat.messages` already contains a
    // `role:'tool'` placeholder for our toolCallId — `recordToolResult`
    // overwrites it in place, so the final tool_result index equals the
    // placeholder's current index, NOT `chat.messages.length`. Using the
    // length here would write a `msgIndex` past every placeholder; then
    // `getWidgetHtmlForMessage(actualToolResultIdx)` would filter to zero
    // widgets, the `widget-inline` div would never be rendered, and
    // `getWidgetIframe` would always return null on later iframe_tool calls
    // (the bug that surfaced as "Widget not found" for click/fill/get_dom
    // immediately after html_widget created the widget).
    var chat = chats[widgetChatId];
    if (!chat) {
        return { success: false, error: 'No active chat' };
    }
    var toolResultMsgIndex = -1;
    var widgetToolCallId = options && options.toolCallId;
    // Eager-render path: when html_widget is invoked via executeTool from INSIDE a
    // sandbox (js_eval / skill tool / widget bridge), html_widget has no
    // placeholder of its own — the OUTER js_eval owns the tool_result slot, and
    // `options.toolCallId` is either absent (page DOM sandbox path) or a synthetic
    // exec-tool id with no message (SW/offscreen path). Resolve to the PARENT
    // tool's result slot so the renderer mounts the widget alongside that result —
    // the exact same contract executeDisplay uses. Without this the widget's
    // msgIndex falls through to chat.messages.length, getWidgetHtmlForMessage
    // filters it to zero, and the call returns success+widgetId but the widget
    // never mounts (a follow-up take_screenshot fails with "Widget not found").
    // Top-level html_widget calls (no fromSandbox) keep their own-result behavior.
    var fromSandbox = !!(options && options.fromSandbox);
    var parentToolCallId = options && options.parentToolCallId;
    var resolveToolCallId = (fromSandbox && parentToolCallId)
        ? parentToolCallId
        : widgetToolCallId;
    if (chat && chat.messages && resolveToolCallId) {
        for (var ti = chat.messages.length - 1; ti >= 0; ti--) {
            var tim = chat.messages[ti];
            if (tim.role === 'tool' && tim.tool_call_id === resolveToolCallId) {
                toolResultMsgIndex = ti;
                break;
            }
        }
    }
    // Fallback for callers without a toolCallId or in code paths where the
    // placeholder hasn't been seeded yet — matches the pre-atomic-placeholder
    // behavior (push at end-of-array).
    if (toolResultMsgIndex === -1) {
        toolResultMsgIndex = chat ? chat.messages.length : -1;
    }
    
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
    // MEMFIX: rehydrate evicted payloads BEFORE persisting — both realms' save
    // put-loops skip a _payloadsEvicted chat (ui/070-dashboard-ui.js:2035,
    // worker/115-storage.js:178) and the page loader flags every chat outside the
    // newest KEEP_HYDRATED chats (ui/070-dashboard-ui.js:1828-1839), so a widget
    // created into a non-recent chat (sub-agent / background run) is dropped from
    // disk and gone on reload. Hydrate AFTER the push above and immediately BEFORE
    // the save. Same pattern as tools/100-prompt-user.js; ensureChatPayloads never
    // rejects and is a no-op when the flag is clear (core/130-indexeddb.js:1075).
    // Never `delete chat._payloadsEvicted` by hand — extractChatPayloadsForPut
    // would then put a payload-STRIPPED record and destroy a legacy-inline row's
    // only durable base64 (core/130-indexeddb.js:887-937).
    if (chat._payloadsEvicted && typeof ensureChatPayloads === 'function') {
        try { await ensureChatPayloads(widgetChatId); } catch (e) {}
    }
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

    // Optional pin-at-creation: pin === 'main' (dashboard page) or 'home' (home page).
    var pinnedTo = null;
    var pinError = null;
    if (args.pin === 'main' || args.pin === 'home') {
        try {
            // addWidgetToDashboard returns the dashboard record on success and
            // undefined on its soft-fail paths (widget lookup / no-content guards).
            var pinResult = await addWidgetToDashboard(widgetId, null, args.pin);
            pinnedTo = pinResult ? args.pin : null;
            if (!pinResult) pinError = 'Pin failed: widget could not be added to the dashboard';
        } catch (e) {
            pinError = e.message;
        }
    }

    return {
        success: true,
        message: 'Widget "' + title + '" created successfully' + (pinnedTo ? ' and pinned to the ' + (pinnedTo === 'home' ? 'home dashboard' : 'dashboard page') : ''),
        pinned: pinnedTo,
        pin_error: pinError || undefined,
        // Normalized: `id` matches display / take_screenshot conventions.
        // `widgetId` kept for any caller still relying on it.
        id: widgetId,
        widgetId: widgetId,
        _debug_hint: 'To debug this widget, use iframe_tool with widget_id="' + widgetId + '". Actions: get_visible_text (extract text), get_dom (get HTML), click (click elements), fill (fill inputs). For visual analysis, use take_screenshot tool.',
        // SW-side wrapper reads this to persist chat.widgets on its own chat
        // object. Without it, the SW's chat snapshot wipes the page-side
        // mutation on the next save and the widget is lost on reload.
        _widget_persist: widget
    };
}

// pin_widget tool — pin/move/unpin an EXISTING widget. dashboard: 'main' | 'home' | 'none'.
// Page-side only (HEADLESS_TOOLS.pin_widget = false): dashboardWidgets + renderers live here.
async function executePinWidget(args) {
    var widgetId = args && args.widget_id;
    var target = args && args.dashboard;
    if (!widgetId) return { success: false, error: 'widget_id is required' };
    if (['main', 'home', 'none'].indexOf(target) === -1) {
        return { success: false, error: "dashboard must be 'main', 'home' or 'none'" };
    }
    var wasPinned = !!dashboardWidgets[widgetId];
    if (target === 'none') {
        if (!wasPinned) return { success: true, message: 'Widget was not pinned', pinned: null };
        await removeWidgetFromDashboard(widgetId);
        return { success: true, message: 'Widget unpinned', pinned: null };
    }
    if (!wasPinned && !getWidgetById(widgetId)) {
        return { success: false, error: 'Widget not found: ' + widgetId };
    }
    await pinWidgetTo(widgetId, target);
    if (!dashboardWidgets[widgetId]) {
        return { success: false, error: 'Failed to pin widget ' + widgetId };
    }
    return { success: true, message: 'Widget pinned to ' + (target === 'home' ? 'the home dashboard' : 'the dashboard page'), pinned: target };
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
    // Dashboard records live in their OWN store (dashboardWidgets, seeded by
    // loadDashboardWidgets / addWidgetToDashboard) and are a SEPARATE object from
    // the chat copy. A widget whose source chat was deleted exists ONLY here, so
    // without this fallback every getWidgetById caller (editWidgetCode:535,
    // saveWidgetCodeEdit:585, screenshotWidget:482, printWidgetFullscreen:466...)
    // reported 'Widget not found' for it. Checked LAST on purpose: while the chat
    // copy still exists it stays authoritative, because the chat surface renders
    // from chats[cid].widgets and saveWidgetCodeEdit persists into that array.
    if (typeof dashboardWidgets !== 'undefined' && dashboardWidgets[widgetId]) {
        return dashboardWidgets[widgetId];
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
                // Release the onWidgetResize 'message' listener registered by
                // renderWidgetInContainer — every other teardown path calls
                // this; skipping it here leaked a listener per deactivation.
                if (iframe.__widgetCleanup) { try { iframe.__widgetCleanup(); } catch (e) {} }
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

// FIX4b helper: append an injected script before </body> (or at the end when
// the widget HTML has no body close tag) — shared by the thumbnail style
// shim and the full height-reporter injection below.
function _appendWidgetScript(widgetHtml, script) {
    if (widgetHtml.match(/<\/body>/i)) {
        return widgetHtml.replace(/<\/body>/i, script + '</body>');
    }
    return widgetHtml + script;
}

function renderWidgetInContainer(widget, container, options) {
    options = options || {};
    var isFullscreen = options.fullscreen || false;
    // Create iframe for complete CSS and script isolation
    var iframe = document.createElement('iframe');
    iframe.className = 'widget-iframe';
    iframe.style.cssText = 'width:100%; border:none; display:block;';
    iframe.setAttribute('scrolling', 'no');

    var isThumbnail = container.closest('.widgets-container') !== null;

    // Build widget HTML with bridge
    var widgetHtml = injectWidgetBridge(widget.html, widget.title, widget.id);

    if (isThumbnail) {
        // FIX4b: thumbnails are fixed-size, CSS-scaled previews — the height
        // reporter below (2 MutationObservers + a 2s interval) used to be
        // injected into them anyway and ran forever per thumbnail, for zero
        // benefit: the early thumbnail return below never attaches
        // onWidgetResize, so every report was ignored. Inject only the body
        // style normalization the reporter script used to apply.
        widgetHtml = _appendWidgetScript(widgetHtml,
            '<script>document.addEventListener("DOMContentLoaded",function(){' +
            'if(document.body){document.body.style.margin="0";document.body.style.overflow="auto";}});<\/script>');
    } else {
    // Inject a height reporter for cross-origin auto-resize via postMessage
    // (widget-sandbox.html has a unique origin, so direct DOM access won't work).
    // FIX4a: the 2s reporter interval pauses while the document is hidden
    // (panel in a background tab / minimized) and resumes — with one catch-up
    // report — on visibilitychange; _rh itself also no-ops while hidden so
    // MutationObserver-driven calls cost nothing off-screen.
    var heightScript = '<script>(function(){' +
        'var _iv=null;' +
        'function _rh(){if(document.hidden)return;var h=document.body?document.body.scrollHeight:0;if(h>0)window.parent.postMessage({type:"widgetResize",height:h},"*");}' +
        'function _start(){if(!_iv)_iv=setInterval(_rh,2000);}' +
        'function _stop(){if(_iv){clearInterval(_iv);_iv=null;}}' +
        'window.addEventListener("load",_rh);' +
        'if(document.body){try{new MutationObserver(_rh).observe(document.body,{childList:true,subtree:true});' +
        '}catch(e){}}document.addEventListener("DOMContentLoaded",function(){' +
        // overflow "auto" (NOT "hidden"): hidden made widget content unscrollable in any
        // fixed-height context (fullscreen/panel view, or inline when the auto-resize
        // height reporter lags/fails). With auto, no scrollbar shows when the iframe is
        // auto-resized to fit, but taller content can still scroll inside the iframe.
        'if(document.body){document.body.style.margin="0";document.body.style.overflow="auto";' +
        'try{new MutationObserver(_rh).observe(document.body,{childList:true,subtree:true});}catch(e){}_rh();}});' +
        'document.addEventListener("visibilitychange",function(){if(document.hidden){_stop();}else{_start();_rh();}});' +
        'if(!document.hidden)_start();' +
    '})();<\/script>';
    widgetHtml = _appendWidgetScript(widgetHtml, heightScript);
    }

    container.appendChild(iframe);
    writeWidgetHtml(iframe, widgetHtml);

    // Thumbnail mode: pure CSS scaled preview, no auto-resize
    if (isThumbnail) {
        iframe.style.cssText = 'position:absolute;top:0;left:0;border:none;transform:scale(0.4);transform-origin:top left;width:250%;height:250%;';
        return iframe;
    }

    // Non-thumbnail views (inline, modal, fullscreen/panel): allow the iframe
    // viewport to scroll. scrolling="no" force-hides the viewport scrollbar at the
    // HTML-attribute level, which (combined with the injected body overflow style)
    // made content taller than the iframe impossible to scroll in the panel view —
    // it only worked when the widget was opened in a new tab (raw HTML, no wrapper).
    iframe.removeAttribute('scrolling');

    // Set initial height from last known value to prevent layout shift on re-render
    if (!isFullscreen && widget.lastHeight > 0) {
        iframe.style.height = (widget.lastHeight + 2) + 'px';
    }

    // Listen for height updates from the in-widget height reporter (cross-origin)
    function onWidgetResize(e) {
        if (e.source !== iframe.contentWindow) return;
        if (isFullscreen) return;
        if (e.data && e.data.type === 'widgetResize' && e.data.height > 0) {
            // Skip reports within the +2px slack of the last applied height:
            // viewport-tracking content (100vh / height:100% bodies) reports
            // back the applied iframe height on every 2s reporter tick, so an
            // unconditional re-apply would grow the iframe +2px per report
            // forever (unbounded feedback loop).
            if (widget.lastHeight > 0 && Math.abs(e.data.height - widget.lastHeight) <= 2) return;
            // +2px slack: body.scrollHeight is an integer that can round BELOW
            // the real layout height (fractional zoom), and with body
            // overflow:auto a >=1px mismatch shows a scrollbar.
            iframe.style.height = (e.data.height + 2) + 'px';
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
    }
    
    return iframe;
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
    var dashBtn = '<button class="widget-ctrl-btn widget-dashboard-btn' + (isOnDash ? ' on-dashboard' : '') + '" data-widget-id="' + widget.id + '" onclick="showWidgetPinMenu(\'' + widget.id + '\', event)" title="' + (isOnDash ? 'Pinned \u2014 click to change' : 'Pin to dashboard\u2026') + '">' + (isOnDash ? UI_ICONS.pinFilled : UI_ICONS.pin) + '</button>';
    header.innerHTML = '<span class="widget-icon">' + UI_ICONS.widget + '</span>' +
        '<span class="widget-title">' + escapeHtml(widget.title) + '</span>' +
        '<div class="widget-modal-controls">' +
            // data-widget-id is the hook toggleWidgetRunning's refresh loop matches
            // on ('.widget-stop-btn[data-widget-id="..."]', :276). Without it this chat
            // fullscreen twin was the only .widget-stop-btn in the app the loop could
            // not find - the dashboard expand-modal twin (ui/070-dashboard-ui.js:97)
            // has always carried it.
            '<button class="widget-ctrl-btn widget-stop-btn" data-widget-id="' + widget.id + '" onclick="toggleWidgetRunning(\'' + widget.id + '\', event);closeWidgetFullscreen()" title="' + (widget.deactivated ? 'Activate Widget' : 'Deactivate Widget') + '">' + (widget.deactivated ? UI_ICONS.play : UI_ICONS.stop) + '</button>' +
            dashBtn +
            '<button class="widget-ctrl-btn" onclick="printWidgetFullscreen()" title="Print">' + UI_ICONS.printer + '</button>' +
            '<button class="widget-ctrl-btn" onclick="screenshotWidget(\'' + widget.id + '\')" title="Screenshot">' + UI_ICONS.camera + '</button>' +
            '<button class="widget-ctrl-btn" onclick="openWidgetLink(\'' + widget.id + '\')" title="Open in New Tab">' + UI_ICONS.externalLink + '</button>' +
            '<button class="widget-ctrl-btn widget-panel-btn" onclick="openWidgetInIframePanel(\'' + widget.id + '\')" title="Open in Side Panel">' + UI_ICONS.panelRight + '</button>' +
            '<button class="widget-ctrl-btn widget-edit-btn" onclick="editWidgetWithAgent(\'' + widget.id + '\', event)" title="Edit">' + UI_ICONS.edit + '</button>' +
            // Manual code editor (editWidgetCode -> saveWidgetCodeEdit), alongside the
            // agent-edit button. closeWidgetFullscreen() FIRST is load-bearing, not
            // cosmetic: the editor overlay is a .widget-modal-overlay at
            // --z-widget-modal (10002) while this one sits at --z-fullscreen (10003)
            // (css/00-tokens.css:174-175), so leaving it open would bury the editor
            // behind this backdrop and desync the Escape order (core/120-init.js:209-211).
            '<button class="widget-ctrl-btn widget-code-btn" onclick="closeWidgetFullscreen();editWidgetCode(\'' + widget.id + '\')" title="Edit code">' + UI_ICONS.code + '</button>' +
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
    if (overlay) {
        var iframe = overlay.querySelector('iframe');
        if (iframe && iframe.__widgetCleanup) { try { iframe.__widgetCleanup(); } catch (e) {} }
        overlay.remove();
    }
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
    // Route the print window through the token injection too, otherwise every
    // var(--...) in a token-based widget resolves to nothing on paper. This is a
    // plain window.open document that never receives data-appagent-theme, so the
    // LIGHT set applies regardless of the app theme - which is what you want for
    // print. typeof-guarded because injectWidgetTokens lives in the ui tier.
    win.document.write(typeof injectWidgetTokens === 'function' ? injectWidgetTokens(widget.html) : widget.html);
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
    
    var _prevHtml = widget.html;
    widget.html = editor.value;
    // Bump the monotonic content version on every html change, exactly like the
    // AGENT edit path (tools/010-iframe-tool.js:906). take_screenshot cannot
    // rasterize the widget's sandboxed cross-origin iframe, so it re-renders the
    // widget in a temp tab via the ?widget= deep link and only accepts the frame
    // whose broadcast contentVersion matches the one it requested
    // (tools/060-take-screenshot.js:265 + :353). Without this bump a screenshot
    // taken right after a MANUAL code edit can be satisfied by a stale frame.
    // contentVersion is in DASHBOARD_CONTENT_FIELDS (ui/020-dashboard.js:45), so
    // the saveDashboardWidget merge below persists it for dashboard copies too.
    widget.contentVersion = (widget.contentVersion || 0) + 1;
    widget.updatedAt = Date.now();
    
    // Save to appropriate store.
    // B-B3: write to the widget's *owning* chat, not the foreground chat. Editing
    // a widget that lives in chat A from a UI route that fires while the user is
    // viewing chat B previously updated chat B's array (or no-op'd if B had no
    // widget array of its own).
    if (dashboardWidgets[widgetId]) {
        // PLACEMENT: saveDashboardWidget MERGES the content fields onto the
        // existing dashboard record (ui/020-dashboard.js DASHBOARD_CONTENT_FIELDS)
        // instead of replacing it, so gridX/gridY/dashboard/prompt and the NUMERIC
        // grid width/height survive even though `widget` here is usually the CHAT
        // copy, which has none of them. _prevHtml is passed because the record may
        // BE `widget` (a dashboard-only widget resolved by getWidgetById's
        // dashboard fallback at :199): the in-place edit above would otherwise
        // defeat the history diff.
        await saveDashboardWidget(widget, false, _prevHtml);
    }
    // CACHE-DETACH: write through to the owning chat's LIVE widgets array.
    // `chatWidgets` only caches the array REFERENCE (:87, :179, :201) and goes
    // DETACHED as soon as an SW chat-snapshot replaces the chat wholesale —
    // app/045-agent-port-bridge-page.js:550 `chats[chatId] = _inChat` (a
    // structured-clone with a brand-new array; its merge guards re-point
    // versionHistory and carry pending rows/meta, but NOT `widgets`). Writing only
    // into the cache therefore persisted NOTHING, because saveChatsToStorage
    // serialises `chats` (ui/070-dashboard-ui.js:1969), and the old
    // `if (chatWidgets[owningChatId])` guard skipped the save ENTIRELY when the
    // owning chat had never been visited in this panel session. The agent route
    // already writes the live array (tools/010-iframe-tool.js:913-914); this is
    // the manual "edit widget code" route.
    var owningChatId = widget.chatId || currentChatId;
    var _holdsWidget = function(c) {
        return !!(c && Array.isArray(c.widgets)
            && c.widgets.some(function(w) { return w && w.id === widgetId; }));
    };
    var _owningChat = owningChatId ? chats[owningChatId] : null;
    // widget.chatId is stamped at creation (:77), but legacy/imported widgets
    // predate it and currentChatId is null outside a chat view
    // (core/030-config.js:450) — so when the declared owner does not hold this id,
    // fall back to the live chat that actually does.
    if (!_holdsWidget(_owningChat)) {
        var _cIds = Object.keys(chats);
        for (var _ci = 0; _ci < _cIds.length; _ci++) {
            if (_holdsWidget(chats[_cIds[_ci]])) {
                owningChatId = _cIds[_ci];
                _owningChat = chats[owningChatId];
                break;
            }
        }
        // A DASHBOARD-ONLY widget (source chat deleted — resolvable only since
        // getWidgetById gained its dashboardWidgets fallback at :199) has no chat
        // home. Without this, the block below would graft it into whatever chat
        // happens to be in view (chats[currentChatId]) and it would start
        // rendering there. The dashboard write above is its durable copy.
        if (!_holdsWidget(_owningChat) && dashboardWidgets[widgetId] === widget) {
            _owningChat = null;
        }
    }
    var _savedToChat = false;
    if (_owningChat) {
        if (!Array.isArray(_owningChat.widgets)) _owningChat.widgets = [];
        var idx = _owningChat.widgets.findIndex(function(w) { return w && w.id === widgetId; });
        if (idx !== -1) _owningChat.widgets[idx] = widget;
        else _owningChat.widgets.push(widget);
        chatWidgets[owningChatId] = _owningChat.widgets;   // re-point the stale cache
        // MEMFIX: rehydrate evicted payloads BEFORE persisting — both realms' save
        // put-loops skip a _payloadsEvicted chat (ui/070-dashboard-ui.js:2035,
        // worker/115-storage.js:178) and the page loader flags every chat outside
        // the newest KEEP_HYDRATED chats, so the await below would otherwise commit
        // NOTHING and the edit would be lost on reload. Same pattern as
        // tools/100-prompt-user.js; ensureChatPayloads never rejects and is a no-op
        // when the flag is clear. Never `delete _owningChat._payloadsEvicted` by
        // hand — extractChatPayloadsForPut would put a payload-STRIPPED record and
        // destroy a legacy-inline row's only durable base64
        // (core/130-indexeddb.js:887-937).
        if (_owningChat._payloadsEvicted && typeof ensureChatPayloads === 'function') {
            try { await ensureChatPayloads(owningChatId); } catch (e) {}
        }
        await saveChatsToStorage();
        _savedToChat = true;
    } else {
        // No live chat holds this widget: the pre-fix code fell through silently and
        // still told the user "Widget saved" for an edit that was never persisted.
        console.warn('[widgets] saveWidgetCodeEdit: no owning chat for ' + widgetId
            + ' — chat edit NOT persisted (dashboard copy: '
            + !!dashboardWidgets[widgetId] + ')');
    }
    
    closeWidgetCodeEdit();
    renderMessages();
    refreshVisibleDashboards();
    if (_savedToChat || dashboardWidgets[widgetId]) {
        showSnackbar('Widget saved', 'success');
    } else {
        showSnackbar('Widget updated in memory only — no owning chat found', 'error');
    }
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
    if (overlay) {
        var iframe = overlay.querySelector('iframe');
        if (iframe && iframe.__widgetCleanup) { try { iframe.__widgetCleanup(); } catch (e) {} }
        overlay.remove();
    }
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
        var dashboardBtnClass = isOnDashboard ? 'widget-sidebar-btn widget-dashboard-btn on-dashboard' : 'widget-sidebar-btn widget-dashboard-btn';
        var dashboardBtnTitle = isOnDashboard ? 'Pinned \u2014 click to change' : 'Pin to dashboard\u2026';
        var dashboardBtnIcon = isOnDashboard ? UI_ICONS.pinFilled : UI_ICONS.pin;
        html += '<div class="widget-sidebar-item" onclick="scrollToWidget(\'' + widget.id + '\')">' +
            '<span class="widget-sidebar-icon">' + UI_ICONS.widget + '</span>' +
            '<span class="widget-sidebar-title">' + escapeHtml(widget.title) + '</span>' +
            '<div class="widget-sidebar-actions">' +
            '<button class="widget-sidebar-btn" onclick="event.stopPropagation();showWidgetInPanel(\'' + widget.id + '\')" title="Show in Panel">' + UI_ICONS.panelRight + '</button>' +
            '<button class="' + dashboardBtnClass + '" data-widget-id="' + widget.id + '" onclick="showWidgetPinMenu(\'' + widget.id + '\', event)" title="' + dashboardBtnTitle + '">' + dashboardBtnIcon + '</button>' +
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

// Open a widget from a clickable ID chip in chat text (.id-mention-widget,
// emitted by decorateIdMentions in ui/250-message-render.js). scrollToWidget is
// the right default: it scrolls+highlights the inline card when that widget is
// rendered in the message list on screen, and falls back to openWidgetModal
// (:592) otherwise — e.g. an ID the user pasted from another chat.
function openWidgetMention(widgetId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    if (!widgetId) return;
    // Resolve FIRST: scrollToWidget -> openWidgetModal silently returns on an
    // unknown id, which would look like a dead chip. Toast instead.
    var widget = getWidgetById(widgetId);
    if (!widget) {
        if (typeof showSnackbar === 'function') showSnackbar('Widget ' + widgetId + ' not found', 'error');
        else console.warn('[openWidgetMention] widget not found: ' + widgetId);
        return;
    }
    scrollToWidget(widgetId);
}

// Edit a widget with the agent: opens a FRESH chat with the composer prefilled
// with the widget id, so the user only has to type what they want changed.
// Shared by the inline chat widget (card + fullscreen modal) and the dashboard
// widget (card + fullscreen modal).
function editWidgetWithAgent(widgetId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    if (!widgetId) return;

    // The click can come from inside a modal — close any widget overlay first so
    // the chat composer is actually visible. The inline fullscreen
    // (closeWidgetFullscreen) and the dashboard fullscreen (closeExpandedWidget)
    // share #widget-fullscreen-overlay; both calls are no-ops when it is absent.
    if (typeof closeWidgetFullscreen === 'function') closeWidgetFullscreen();
    if (typeof closeExpandedWidget === 'function') closeExpandedWidget();
    if (typeof closeWidgetModal === 'function') closeWidgetModal();

    // newChat() switches away from the dashboard/home/skills/settings view
    // (closeDashboardView/closeHomeView call showChatView()) and clears
    // #message-input at the end — so the prefill MUST happen after it.
    newChat();

    var input = document.getElementById('message-input');
    if (input) {
        // Newline (not a trailing space) after the colon: the user's edit request
        // starts on line 2. autoResizeTextarea below runs AFTER the value is set so
        // the textarea grows to 2 rows, and setSelectionRange puts the caret there.
        input.value = 'Edit widget ' + widgetId + ':\n';
        if (typeof autoResizeTextarea === 'function') autoResizeTextarea(input);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
}

function getWidgetHtmlForMessage(msgIndex) {
    var widgets = getWidgetsForChat(currentChatId);
    var msgWidgets = widgets.filter(function(w) { return w.msgIndex === msgIndex; });
    
    if (msgWidgets.length === 0) return '';
    
    var html = '';
    msgWidgets.forEach(function(widget) {
        html += '<div class="widget-inline" id="widget-' + widget.id + '" data-widget-id="' + widget.id + '">' +
            '<div class="widget-header">' +
                '<span class="widget-icon">' + UI_ICONS.widget + '</span>' +
                '<span class="widget-title">' + escapeHtml(widget.title) + '</span>' +
                '<div class="widget-controls">' +
                    '<button class="widget-ctrl-btn widget-fullscreen-btn" onclick="openWidgetFullscreen(\'' + widget.id + '\', event)" title="Expand">' +
                        UI_ICONS.maximize +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="widget-content" id="widget-content-' + widget.id + '"></div>' +
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

// True when a Reload would rebuild + redeploy the extension from the workspace — the
// EXACT same gate _rebuildBeforeReload() (270-iframe-panel.js) checks, so this matches
// precisely the condition under which a manage_skill write to the ephemeral runtime copy
// gets silently overwritten on the next Reload. BOTH must hold: the extension-dev build
// tool is loaded (extension_build) AND a deploy folder is connected. Gating on the build
// tool first also avoids a spurious File System permission prompt for users who merely
// have a deploy folder persisted but aren't currently doing extension development. Fails
// open (returns false) on any error so a permission hiccup never hard-blocks a live edit.
async function _reloadRebuildsFromWorkspace() {
    // No in-browser build tool (extension-dev skill inactive) → a Reload never rebuilds.
    if (typeof isSkillTool !== 'function' || !isSkillTool('extension_build')) return false;
    // No connected deploy folder → nothing on disk for a rebuild to overwrite.
    if (typeof getDeployDirHandle !== 'function') return false;
    try { return !!(await getDeployDirHandle()); } catch (e) { return false; }
}

async function executeManageSkill(args) {
    var action = args.action;
    var skillId = args.skill_id;
    
    if (action === 'create') {
        // Extension-dev guard: with the deploy folder connected a created skill lives
        // only in the ephemeral runtime and is discarded on the next Reload — create it
        // in the cloned repo so the build embeds it.
        if (await _reloadRebuildsFromWorkspace()) {
            var _newId = (args.name || 'untitled-skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-skill';
            return {
                success: false,
                blocked_reason: 'extension_dev_mode',
                source_path: 'skills/' + _newId + '/',
                error: 'Blocked: the extension deploy folder is connected (extension-dev mode), so manage_skill would only create an ephemeral runtime skill that the next Reload discards. Create it in the cloned repo instead: add skills/' + _newId + '/SKILL.md (with frontmatter name + description, plus any tool *.js / *.md files) via the workspace tool (workspace write), then ask the user to click Reload. See the extension-dev skill.'
            };
        }
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

        // Activate the freshly created skill by default so its knowledge (and any
        // tools added afterwards) is immediately available to the agent without a
        // separate activate call.
        var activated = false;
        var activateDisabled = (typeof getDisabledTools === 'function') && getDisabledTools().indexOf('manage_skill:activate') !== -1;
        if (!activateDisabled) {
            try {
                if (typeof activateSkill === 'function') {
                    var activation = await activateSkill(id);
                    activated = !!(activation && activation.success);
                }
            } catch (e) {
                console.warn('Auto-activation of created skill failed:', e);
            }
        }

        renderSkillsList();
        if (sanitizedActions.length && typeof renderAllActionPlacements === 'function') {
            renderAllActionPlacements();
        }
        return {
            success: true,
            skill_id: id,
            activated: activated,
            message: (activateDisabled
                ? 'Skill created (left inactive — Activate Skill capability is disabled): ' + name
                : 'Skill created' + (activated ? ' and activated' : '') + ': ' + name) + (sanitizedActions.length ? ' (' + sanitizedActions.length + ' action' + (sanitizedActions.length === 1 ? '' : 's') + ')' : ''),
            actions: sanitizedActions
        };
    }
    
    if (!skillId) return { success: false, error: 'skill_id is required for action: ' + action };
    var skill = skills[skillId];
    if (!skill && action !== 'create') return { success: false, error: 'Skill not found: ' + skillId };

    // Extension-dev guard (out-of-box skills): OOB skills carry an embeddedHash and their
    // canonical source lives at skills/<id>/ in the cloned extension repo. When the deploy
    // folder is connected, a manage_skill write only mutates the ephemeral runtime copy,
    // which the next Reload rebuilds over from the workspace — so block the source-mutating
    // actions and point the agent at the workspace tool. User-created live-instance skills
    // (no embeddedHash) are unaffected; activate/deactivate stay allowed (they don't touch source).
    var SKILL_SOURCE_MUTATING_ACTIONS = ['update', 'edit', 'add_file', 'update_file', 'delete_file', 'delete'];
    if (skill && skill.embeddedHash && SKILL_SOURCE_MUTATING_ACTIONS.indexOf(action) !== -1 && await _reloadRebuildsFromWorkspace()) {
        return {
            success: false,
            blocked_reason: 'oob_skill_extension_dev',
            skill_id: skillId,
            source_path: 'skills/' + skillId + '/',
            error: 'Blocked: "' + (skill.name || skillId) + '" is a built-in (out-of-box) skill and the extension deploy folder is connected (extension-dev mode). manage_skill writes only the ephemeral runtime copy, which the next Reload rebuilds over from the workspace. Edit the source instead: skills/' + skillId + '/SKILL.md (and any *.md / tool *.js files) with the workspace tool (workspace edit / write), then ask the user to click Reload. See the extension-dev skill.'
        };
    }
    
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

    if (action === 'delete') {
        if (activeSkills[skillId]) { try { await deactivateSkill(skillId); } catch (e) {} }
        await deleteSkill(skillId);
        if (skills[skillId]) delete skills[skillId];
        if (typeof renderSkillsList === 'function') renderSkillsList();
        if (typeof renderAllActionPlacements === 'function') renderAllActionPlacements();
        return { success: true, message: 'Skill deleted: ' + skillId };
    }
    
    return { success: false, error: 'Unknown action: ' + action };
}
