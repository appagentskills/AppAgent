// TAKE SCREENSHOT TOOL - Capture real PNG screenshots for AI vision
// =============================================

// Overlay a coordinate grid on a screenshot for identifying click/fill coordinates.
// Labels show viewport CSS pixel values matching elementFromPoint coordinates.
async function overlayGrid(base64Data, viewportWidth, viewportHeight) {
    var img = new Image();
    await new Promise(function(resolve, reject) {
        img.onload = resolve;
        img.onerror = reject;
        img.src = base64Data;
    });
    // Use actual image dimensions (may be scaled by devicePixelRatio)
    var imgW = img.naturalWidth;
    var imgH = img.naturalHeight;

    var canvas = document.createElement('canvas');
    canvas.width = imgW;
    canvas.height = imgH;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    img.src = '';

    var scaleX = imgW / viewportWidth;
    var scaleY = imgH / viewportHeight;
    var step = viewportWidth > 2000 ? 200 : viewportWidth < 500 ? 50 : 100;
    var fontSize = Math.max(10, Math.round(12 * scaleX));
    ctx.font = fontSize + 'px monospace';
    ctx.textBaseline = 'top';

    // Draw grid lines and labels
    function drawLabel(text, lx, ly) {
        var tw = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(lx - 2, ly - 2, tw + 4, fontSize + 4);
        ctx.fillStyle = '#ff0000';
        ctx.fillText(text, lx, ly);
    }

    ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)';
    ctx.lineWidth = 1;

    for (var vx = step; vx < viewportWidth; vx += step) {
        var px = Math.round(vx * scaleX);
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, imgH); ctx.stroke();
        var label = String(vx);
        drawLabel(label, px - ctx.measureText(label).width / 2, 0);
    }

    for (var vy = step; vy < viewportHeight; vy += step) {
        var py = Math.round(vy * scaleY);
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(imgW, py); ctx.stroke();
        drawLabel(String(vy), 0, py - fontSize / 2);
    }

    var result = canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;
    return result;
}

async function executeTakeScreenshot(args) {
    var target = args.target;
    var widgetId = args.widget_id;
    var selector = args.selector;
    var maxWidth = args.max_width || 1600;

    if (!target) {
        return { success: false, error: 'target is required. Use "browser", "widget", or "element"' };
    }

    try {
        var elementToCapture = null;
        var captureDescription = '';

        if (target === 'browser') {
            // Use Chrome Debugger API via background service worker
            var ssResult = await Platform.sendBrowserAction('take_screenshot', {});
            if (ssResult.error) {
                return { success: false, error: ssResult.error };
            }
            var ssId = newFileId();
            var ssBase64 = ssResult.base64;
            var ssUrl = ssResult.url || currentIframeUrl || '/';
            if (ssResult.url) currentIframeUrl = ssResult.url;

            // Get actual image dimensions and resize if needed
            // captureVisibleTab captures at device pixel ratio, so a 1440px tab on 2x display = 2880px image
            // Anthropic limits images to 2000px per dimension for many-image requests
            var ssImg = new Image();
            await new Promise(function(resolve, reject) { ssImg.onload = resolve; ssImg.onerror = reject; ssImg.src = ssBase64; });
            var ssWidth = ssImg.naturalWidth;
            var ssHeight = ssImg.naturalHeight;
            if (ssWidth > maxWidth || ssHeight > maxWidth) {
                var ssScale = Math.min(maxWidth / ssWidth, maxWidth / ssHeight);
                var newW = Math.round(ssWidth * ssScale);
                var newH = Math.round(ssHeight * ssScale);
                var ssCanvas = document.createElement('canvas');
                ssCanvas.width = newW;
                ssCanvas.height = newH;
                var ssCtx = ssCanvas.getContext('2d');
                ssCtx.drawImage(ssImg, 0, 0, newW, newH);
                ssBase64 = ssCanvas.toDataURL('image/png');
                ssWidth = newW;
                ssHeight = newH;
                ssCanvas.width = 0;
                ssCanvas.height = 0;
            }
            ssImg.src = '';

            // If CSS viewport emulation is active (mobile resize), crop to emulated width
            var _emVp = window._emulatedViewport;
            if (_emVp && _emVp.width && ssResult.width && _emVp.width < ssResult.width) {
                var _emScale = ssWidth / ssResult.width;
                var _emCropW = Math.round(_emVp.width * _emScale);
                var _emCropX = Math.round((ssWidth - _emCropW) / 2);
                var _emCanvas = document.createElement('canvas');
                _emCanvas.width = _emCropW;
                _emCanvas.height = ssHeight;
                var _emCtx = _emCanvas.getContext('2d');
                var _emImg = new Image();
                await new Promise(function(res, rej) { _emImg.onload = res; _emImg.onerror = rej; _emImg.src = ssBase64; });
                _emCtx.drawImage(_emImg, _emCropX, 0, _emCropW, ssHeight, 0, 0, _emCropW, ssHeight);
                ssBase64 = _emCanvas.toDataURL('image/png');
                ssWidth = _emCropW;
                _emImg.src = '';
                _emCanvas.width = 0;
                _emCanvas.height = 0;
            }

            if (args.grid) {
                // Use real viewport dims from background (not scaled image dims)
                // so grid labels match click/fill viewport coordinates
                // If emulated, use emulated dims (content was cropped above)
                var _gridVpW = (_emVp && _emVp.width) ? _emVp.width : (ssResult.width || ssWidth);
                var _gridVpH = (_emVp && _emVp.height) ? _emVp.height : (ssResult.height || ssHeight);
                ssBase64 = await overlayGrid(ssBase64, _gridVpW, _gridVpH);
            }
            // Compress if over 5MB API limit
            ssBase64 = await compressBase64Image(ssBase64);
            return {
                success: true,
                screenshot_id: ssId,
                url: ssUrl,
                message: 'Screenshot captured: browser tab at ' + ssUrl,
                dimensions: ssWidth + 'x' + ssHeight,
                size_bytes: Math.round(ssBase64.length * 0.75),
                note: 'The screenshot image is now attached to this conversation. I can see it and will analyze the visual content. Use screenshot_id "' + ssId + '" with screenshot_by_id tool to retrieve the image data.',
                _screenshotMessage: {
                    role: 'screenshot',
                    base64: ssBase64,
                    name: args.name || null,
                    description: 'browser tab at ' + ssUrl,
                    url: ssUrl,
                    timestamp: Date.now(),
                    width: ssWidth,
                    height: ssHeight,
                    screenshot_id: ssId,
                    file_id: ssId
                }
            };
        } else if (target === 'widget') {
            if (!widgetId) {
                return { success: false, error: 'widget_id is required when target is "widget"' };
            }
            var _ssWidget = getWidgetById(widgetId);
            if (!_ssWidget && dashboardWidgets[widgetId]) _ssWidget = dashboardWidgets[widgetId];
            if (_ssWidget && _ssWidget.deactivated) {
                return { success: false, error: 'Widget "' + (_ssWidget.title || widgetId) + '" is deactivated. The user has deactivated this widget. Ask the user to activate it first, or proceed differently.' };
            }
            var widgetIframe = getWidgetIframe(widgetId);
            if (!widgetIframe) {
                if (_ssWidget) {
                    return { success: false, error: 'Widget "' + (_ssWidget.title || widgetId) + '" (' + widgetId + ') exists but is not rendered in a live panel in the current chat context, so it cannot be captured via the live DOM. This typically happens in a background/non-foreground chat where the widget is not mounted in the visible DOM. Re-run the screenshot in a foreground chat where the widget is rendered.' };
                }
                return { success: false, error: 'Widget not found: ' + widgetId + '. Make sure the widget is visible in the chat or dashboard.' };
            }
            var _widgetCrossOrigin = false;
            try {
                var widgetDoc = widgetIframe.contentDocument || widgetIframe.contentWindow.document;
                elementToCapture = widgetDoc.body || widgetDoc.documentElement;
                captureDescription = 'widget ' + widgetId;
            } catch (e) {
                _widgetCrossOrigin = true;
            }
            // Cross-origin widget (extension sandbox): open widget in a
            // temporary tab via ?widget= deep link, screenshot it, then close
            if (_widgetCrossOrigin) {
                // Cache-bust the deep link so the temp tab always performs a fresh
                // navigation reflecting the CURRENT widget content. Keying on the
                // widget's contentVersion (bumped by iframe_tool edit_html) plus a
                // timestamp prevents a stale rasterization being reused after the
                // widget HTML changes — the bug where post-edit widget screenshots
                // kept returning the identical pre-edit image.
                var _wssCv = (_ssWidget && _ssWidget.contentVersion) || 0;
                // Per-request nonce. Passed to the temp tab as &_ts= and echoed back in
                // the render-complete record so the capturer accepts ONLY the signal from
                // THIS request's fresh render — a leftover record from a prior capture of
                // the same widget/version can never satisfy the wait (no stale frame).
                var _wssTs = Date.now();
                var _wssUrl = chrome.runtime.getURL('app.html') + '?widget=' + encodeURIComponent(widgetId)
                    + '&_cv=' + _wssCv + '&_ts=' + _wssTs;
                // --- LIVE DOM SNAPSHOT (preserve interactive widget state) ---
                // The widget runs in a cross-origin sandbox iframe, so we can't read its
                // contentDocument from here. Instead ask the LIVE iframe (via the bridge's
                // __appagentSerializeForCapture handler) to serialize its CURRENT DOM. If it
                // answers within ~1.5s, we stash it in chrome.storage.local so the temp tab
                // can render that static snapshot (scripts neutralized) -> counters/loaded
                // data are preserved. On timeout/null we fall back to the fresh-render path
                // below, unchanged.
                var _WSS_SNAP_KEY = '__appagent_widget_snapshot__';
                var _wssSnapshot = null;
                try {
                    _wssSnapshot = await new Promise(function(resolve) {
                        var _snDone = false;
                        var _snTimer = setTimeout(function(){
                            if (_snDone) return; _snDone = true;
                            try { window.removeEventListener('message', _onSnap); } catch (e) {}
                            resolve(null);
                        }, 1500);
                        function _onSnap(ev) {
                            var d = ev && ev.data;
                            if (!d || d.type !== '__appagentSerializedDom' || String(d.reqId) !== String(_wssTs)) return;
                            if (_snDone) return; _snDone = true;
                            clearTimeout(_snTimer);
                            try { window.removeEventListener('message', _onSnap); } catch (e) {}
                            resolve(d.html ? { html: d.html, width: d.width, height: d.height } : null);
                        }
                        window.addEventListener('message', _onSnap);
                        try {
                            widgetIframe.contentWindow.postMessage({ type: '__appagentSerializeForCapture', reqId: _wssTs }, '*');
                        } catch (e) { /* fall through to timeout -> fresh render */ }
                    });
                } catch (e) { _wssSnapshot = null; }
                if (_wssSnapshot && _wssSnapshot.html) {
                    try {
                        await chrome.storage.local.set({ '__appagent_widget_snapshot__': {
                            widgetId: widgetId,
                            html: _wssSnapshot.html,
                            width: _wssSnapshot.width,
                            height: _wssSnapshot.height,
                            sig: _wssTs
                        } });
                        _wssUrl += '&snap=1';
                    } catch (e) { _wssSnapshot = null; /* couldn't stash -> fresh render */ }
                }
                var _wssTab = null;
                // DETERMINISTIC render-complete wait (replaces the old fixed-delay
                // race). The temp tab's deep-link wrapper (120-init.js) broadcasts
                // 'widgetRenderComplete' over a same-origin BroadcastChannel once the
                // cross-origin sandbox has mounted AND laid out the content (the
                // sandbox fires 'widgetContentLoaded' after document.write + double
                // rAF + fonts.ready). We resolve ONLY when the broadcast's
                // contentVersion matches the _cv we requested, so a late signal from
                // a PRIOR edit can never satisfy this wait -> never a stale capture.
                // The listener is armed BEFORE the tab is created so an early
                // broadcast can't be missed.
                var _wssRenderedViaSignal = false;
                var _wssSignalPath = null; // which transport actually delivered the signal
                var _wssChan = null;
                var _wssRuntimeListener = null;
                var _wssStorageListener = null;
                // Cross-context bus key. chrome.storage change events are delivered to
                // EVERY extension context that can read the area — including this Chrome
                // side panel — which is exactly the boundary that chrome.runtime.sendMessage
                // fan-out (PR #274) and BroadcastChannel (separate partitions) both failed
                // to cross. The temp tab (120-init.js) writes a render-complete record
                // here once the widget has actually painted; we observe it via
                // storage.onChanged. The value also persists, so there is no
                // arm-before-fire race even if the paint beats this listener.
                var _WSS_BUS_KEY = '__appagent_widget_render__';
                var _wssRenderPromise = new Promise(function(resolve) {
                    var _settled = false;
                    var _wssMaxWait;
                    // Accept a record ONLY when it is for this widget, reports the
                    // requested contentVersion, AND carries this request's nonce (_wssTs).
                    // The nonce guarantees the record came from THIS temp tab's fresh
                    // render — a leftover record from a prior capture (even at the same
                    // version) can never satisfy the wait, so we never grab a stale frame.
                    var _wssMatches = function(d) {
                        return d && d.type === 'widgetRenderComplete'
                            && d.widgetId === widgetId
                            && String(d.contentVersion) === String(_wssCv)
                            && String(d.sig) === String(_wssTs);
                    };
                    var finish = function(viaSignal, path) {
                        if (_settled) return;
                        _settled = true;
                        _wssRenderedViaSignal = viaSignal;
                        _wssSignalPath = path || null;
                        clearTimeout(_wssMaxWait);
                        if (_wssChan) { try { _wssChan.close(); } catch (e) {} _wssChan = null; }
                        if (_wssRuntimeListener) {
                            try { chrome.runtime.onMessage.removeListener(_wssRuntimeListener); } catch (e) {}
                            _wssRuntimeListener = null;
                        }
                        if (_wssStorageListener) {
                            try { chrome.storage.onChanged.removeListener(_wssStorageListener); } catch (e) {}
                            _wssStorageListener = null;
                        }
                        resolve();
                    };
                    // PRIMARY signal path: chrome.storage bus. The deep-link temp TAB
                    // (where 120-init writes the record) and THIS capturing context (the
                    // side-panel page) are separate top-level extension contexts. A Chrome
                    // side panel does NOT share a BroadcastChannel with a tab (separate
                    // partitions) and — empirically (PR #274) — also did not receive the
                    // tab's chrome.runtime.sendMessage fan-out, so both old handshakes
                    // timed out on EVERY capture. chrome.storage.onChanged IS dispatched to
                    // every extension context that can read the area, so it crosses that
                    // exact boundary. Armed BEFORE the temp tab is created.
                    try {
                        _wssStorageListener = function(changes, area) {
                            if (area !== 'local' || !changes || !changes[_WSS_BUS_KEY]) return;
                            if (_wssMatches(changes[_WSS_BUS_KEY].newValue)) finish(true, 'storage');
                        };
                        chrome.storage.onChanged.addListener(_wssStorageListener);
                    } catch (e) { /* storage events unavailable -> runtime/BC/safety-net */ }
                    // Secondary path: chrome.runtime fan-out (works in some Chrome builds).
                    try {
                        _wssRuntimeListener = function(msg) { if (_wssMatches(msg)) finish(true, 'runtime'); };
                        chrome.runtime.onMessage.addListener(_wssRuntimeListener);
                    } catch (e) { /* runtime messaging unavailable */ }
                    // Tertiary path: BroadcastChannel (same-partition contexts only).
                    try {
                        _wssChan = new BroadcastChannel('appagent-widget-render');
                        _wssChan.onmessage = function(ev) { if (_wssMatches(ev && ev.data)) finish(true, 'broadcast'); };
                    } catch (e) { /* BroadcastChannel unavailable -> safety-net governs */ }
                    // Safety net ONLY (never the primary path): cap the wait so a
                    // missing signal can't hang the capture. Falls through to
                    // capture-anyway and is surfaced in the result via render_wait.
                    _wssMaxWait = setTimeout(function() { finish(false, 'timeout'); }, 8000);
                });
                try {
                    _wssTab = await chrome.tabs.create({ url: _wssUrl, active: false });
                    // Block until the post-edit widget is actually painted (matching
                    // contentVersion), or until the safety-net max-wait elapses.
                    await _wssRenderPromise;
                    // Fallback-only settle: when the deterministic render-complete
                    // signal never arrived (safety-net timeout), give a near-miss
                    // paint a little extra time to land before capturing so we don't
                    // grab a pre-paint frame. Skipped entirely when the signal arrived.
                    if (!_wssRenderedViaSignal) {
                        await new Promise(function(r){ setTimeout(r, 700); });
                    }
                    // Temporarily point sendBrowserAction at the widget tab
                    var _wssChat = chats[currentChatId];
                    var _wssOrigTabId = _wssChat && _wssChat.targetTabId;
                    if (_wssChat) _wssChat.targetTabId = _wssTab.id;
                    var _wssResult = await Platform.sendBrowserAction('take_screenshot', {});
                    if (_wssChat) _wssChat.targetTabId = _wssOrigTabId;
                    if (_wssResult.error) {
                        return { success: false, error: 'Widget screenshot failed: ' + _wssResult.error };
                    }
                    var _wssId = newFileId();
                    var _wssBase64 = _wssResult.base64;
                    var _wssW = _wssResult.width || 800;
                    var _wssH = _wssResult.height || 600;
                    // When a live-DOM snapshot was rendered, the temp tab still rasterizes a
                    // full-viewport frame, so crop the raster down to the widget's real
                    // content size and report widget-sized dimensions (not the viewport).
                    if (_wssSnapshot && _wssSnapshot.html && _wssSnapshot.width && _wssSnapshot.height) {
                        try {
                            var _snImg = new Image();
                            await new Promise(function(res, rej){ _snImg.onload = res; _snImg.onerror = rej; _snImg.src = _wssBase64; });
                            var _snDpr = _snImg.naturalWidth / _wssW;
                            var _snCw = Math.min(Math.round(_wssSnapshot.width * _snDpr), _snImg.naturalWidth);
                            var _snCh = Math.min(Math.round(_wssSnapshot.height * _snDpr), _snImg.naturalHeight);
                            if (_snCw > 0 && _snCh > 0) {
                                var _snCanvas = document.createElement('canvas');
                                _snCanvas.width = _snCw; _snCanvas.height = _snCh;
                                _snCanvas.getContext('2d').drawImage(_snImg, 0, 0, _snCw, _snCh, 0, 0, _snCw, _snCh);
                                _wssBase64 = _snCanvas.toDataURL('image/png');
                                _wssW = Math.round(_snCw / _snDpr);
                                _wssH = Math.round(_snCh / _snDpr);
                                _snCanvas.width = 0; _snCanvas.height = 0;
                            }
                            _snImg.src = '';
                        } catch (e) { /* keep full-viewport capture on crop failure */ }
                    }
                    if (args.grid) {
                        _wssBase64 = await overlayGrid(_wssBase64, _wssW, _wssH);
                    }
                    // Compress if over 5MB API limit
                    _wssBase64 = await compressBase64Image(_wssBase64);
                    captureDescription = 'widget ' + widgetId;
                    return {
                        success: true,
                        screenshot_id: _wssId,
                        message: 'Screenshot captured: ' + captureDescription,
                        dimensions: _wssW + 'x' + _wssH,
                        size_bytes: Math.round(_wssBase64.length * 0.75),
                        // Surfaces whether we captured on the deterministic
                        // render-complete signal or fell through the safety-net wait.
                        render_wait: _wssRenderedViaSignal ? 'deterministic-signal' : 'timeout-fallback',
                        // Which transport delivered the signal: 'storage' (primary),
                        // 'runtime', 'broadcast', or 'timeout' (safety-net fallback).
                        render_signal_path: _wssSignalPath,
                        note: 'The screenshot image is now attached to this conversation. I can see it and will analyze the visual content.' + (_wssRenderedViaSignal ? '' : ' (Note: the widget render-complete signal did not arrive within the max wait; captured on fallback — the image may not reflect the very latest edit.)') + ' Use screenshot_id "' + _wssId + '" with screenshot_by_id tool to retrieve the image data.',
                        _screenshotMessage: {
                            role: 'screenshot',
                            base64: _wssBase64,
                            name: args.name || null,
                            description: captureDescription,
                            url: null,
                            timestamp: Date.now(),
                            width: _wssW,
                            height: _wssH,
                            screenshot_id: _wssId,
                            file_id: _wssId
                        }
                    };
                } finally {
                    if (_wssTab) try { chrome.tabs.remove(_wssTab.id); } catch(e) {}
                    // Housekeeping: drop the render-complete bus record so a stale
                    // key doesn't linger in chrome.storage.local after the capture.
                    // (Matching is nonce-guarded so residue is harmless, but we keep
                    // the area clean.)
                    try { chrome.storage.local.remove(_WSS_BUS_KEY); } catch (e) {}
                    // Drop the live-DOM snapshot record so it can't be reused by a later capture.
                    try { chrome.storage.local.remove(_WSS_SNAP_KEY); } catch (e) {}
                }
            }
        } else if (target === 'element') {
            if (!selector) {
                return { success: false, error: 'selector is required when target is "element"' };
            }

            // Get element rect from tab, take full screenshot, then crop
            var elProps = await Platform.sendBrowserAction('get_properties', { selector: selector });
            if (elProps.error) {
                return { success: false, error: 'Element not found: ' + selector };
            }
            var elRect = elProps.properties && elProps.properties.rect;
            if (!elRect || elRect.width === 0 || elRect.height === 0) {
                return { success: false, error: 'Element has no visible dimensions: ' + selector };
            }

            // Take full page screenshot
            var fullSs = await Platform.sendBrowserAction('take_screenshot', {});
            if (fullSs.error) {
                return { success: false, error: fullSs.error };
            }
            var fullWidth = fullSs.width || 1280;
            var fullHeight = fullSs.height || 900;

            // Crop to element rect
            var cropImg = new Image();
            await new Promise(function(resolve, reject) {
                cropImg.onload = resolve;
                cropImg.onerror = reject;
                cropImg.src = fullSs.base64;
            });
            var dpr = cropImg.naturalWidth / fullWidth;
            var cropCanvas = document.createElement('canvas');
            var cx = Math.round(elRect.left * dpr);
            var cy = Math.round(elRect.top * dpr);
            var cw = Math.round(elRect.width * dpr);
            var ch = Math.round(elRect.height * dpr);
            // Clamp to image bounds
            cx = Math.max(0, Math.min(cx, cropImg.naturalWidth - 1));
            cy = Math.max(0, Math.min(cy, cropImg.naturalHeight - 1));
            cw = Math.min(cw, cropImg.naturalWidth - cx);
            ch = Math.min(ch, cropImg.naturalHeight - cy);
            cropCanvas.width = cw;
            cropCanvas.height = ch;
            var cropCtx = cropCanvas.getContext('2d');
            cropCtx.drawImage(cropImg, cx, cy, cw, ch, 0, 0, cw, ch);
            cropImg.src = '';

            var cropBase64 = cropCanvas.toDataURL('image/png');
            var cropW = Math.round(cw / dpr);
            var cropH = Math.round(ch / dpr);
            cropCanvas.width = 0; cropCanvas.height = 0;

            var elSsId = newFileId();
            var elUrl = fullSs.url || currentIframeUrl || '/';
            if (args.grid) {
                cropBase64 = await overlayGrid(cropBase64, cropW, cropH);
            }
            // Compress if over 5MB API limit
            cropBase64 = await compressBase64Image(cropBase64);
            return {
                success: true,
                screenshot_id: elSsId,
                url: elUrl,
                message: 'Screenshot captured: element ' + selector,
                dimensions: cropW + 'x' + cropH,
                size_bytes: Math.round(cropBase64.length * 0.75),
                note: 'The screenshot image is now attached to this conversation. I can see it and will analyze the visual content. Use screenshot_id "' + elSsId + '" with screenshot_by_id tool to retrieve the image data.',
                _screenshotMessage: {
                    role: 'screenshot',
                    base64: cropBase64,
                    name: args.name || null,
                    description: 'element ' + selector + ' at ' + elUrl,
                    url: elUrl,
                    timestamp: Date.now(),
                    width: cropW,
                    height: cropH,
                    screenshot_id: elSsId,
                    file_id: elSsId
                }
            };
        } else {
            return { success: false, error: 'Invalid target. Use "browser", "widget", or "element"' };
        }

        if (!elementToCapture) {
            return { success: false, error: 'Could not find element to capture' };
        }

        var base64Data;
        var finalWidth, finalHeight;

        if (screenshotMethod === 'display-media') {
            // Browser Display Media capture (requires user permission dialog)
            var canvas = await captureElementToCanvas(elementToCapture);
            var finalCanvas = canvas;
            if (canvas.width > maxWidth || canvas.height > maxWidth) {
                var scale = Math.min(maxWidth / canvas.width, maxWidth / canvas.height);
                var resizedCanvas = document.createElement('canvas');
                resizedCanvas.width = Math.round(canvas.width * scale);
                resizedCanvas.height = Math.round(canvas.height * scale);
                var ctx = resizedCanvas.getContext('2d');
                ctx.drawImage(canvas, 0, 0, resizedCanvas.width, resizedCanvas.height);
                finalCanvas = resizedCanvas;
                // Release original canvas memory
                canvas.width = 0;
                canvas.height = 0;
            }
            base64Data = finalCanvas.toDataURL('image/png');
            finalWidth = finalCanvas.width;
            finalHeight = finalCanvas.height;
            // Release final canvas memory
            finalCanvas.width = 0;
            finalCanvas.height = 0;
        } else {
            // html-to-image capture (default, no permission dialog)
            var containerEl = elementToCapture;
            // For body/html, find the containing iframe for dimensions
            var iframeEl = null;
            if (containerEl.tagName === 'BODY' || containerEl.tagName === 'HTML') {
                var win = containerEl.ownerDocument.defaultView;
                if (win && win.frameElement) iframeEl = win.frameElement;
            }
            var w = iframeEl ? iframeEl.clientWidth : containerEl.scrollWidth;
            var h = iframeEl ? iframeEl.clientHeight : containerEl.scrollHeight;
            var ratio = window.devicePixelRatio || 1;
            var htiOpts = {
                width: w, height: h, pixelRatio: ratio,
                filter: screenshotFilter
            };
            if (_htiFontCache != null) htiOpts.fontEmbedCSS = _htiFontCache;
            var restoreGCS = patchScrollStyles(containerEl);

            // Fix margin rendering: convert parents of inline spans (containing block children) to flex layout.
            // See comment in captureScreenshot() for full explanation of WHY and how TO REVERT TO ALL SPANS.
            var restoreMarginFix = [];
            try {
                var doc = containerEl.ownerDocument || containerEl;
                var widgetSpans = doc.querySelectorAll('span[ng-switch-default][ng-repeat*="rectangle"], span[ng-repeat*="widget"]');
                var processed = new Set();
                widgetSpans.forEach(function(span) {
                    var parent = span.parentElement;
                    if (!parent || processed.has(parent)) return;
                    processed.add(parent);
                    var origDisplay = parent.style.display;
                    var origFlexDir = parent.style.flexDirection;
                    parent.style.setProperty('display', 'flex', 'important');
                    parent.style.setProperty('flex-direction', 'column', 'important');
                    restoreMarginFix.push({ el: parent, display: origDisplay, flexDir: origFlexDir });
                });
            } catch (e) { /* ignore */ }

            try {
                var svgDataUrl = await _htiToSvg(containerEl, htiOpts);
                base64Data = await svgToPng(sanitizeSvgDataUrl(svgDataUrl), w, h, ratio);
            } finally {
                restoreGCS();
                restoreMarginFix.forEach(function(item) {
                    if (item.display) item.el.style.display = item.display;
                    else item.el.style.removeProperty('display');
                    if (item.flexDir) item.el.style.flexDirection = item.flexDir;
                    else item.el.style.removeProperty('flex-direction');
                });
            }
            // Resize if either dimension exceeds maxWidth
            // (Anthropic limits to 2000px per dimension for many-image requests)
            finalWidth = Math.round(w * ratio);
            finalHeight = Math.round(h * ratio);
            if (finalWidth > maxWidth || finalHeight > maxWidth) {
                var resizeScale = Math.min(maxWidth / finalWidth, maxWidth / finalHeight);
                var resizedCanvas = document.createElement('canvas');
                resizedCanvas.width = Math.round(finalWidth * resizeScale);
                resizedCanvas.height = Math.round(finalHeight * resizeScale);
                var rctx = resizedCanvas.getContext('2d');
                var img = new Image();
                await new Promise(function(resolve, reject) {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = base64Data;
                });
                rctx.drawImage(img, 0, 0, resizedCanvas.width, resizedCanvas.height);
                base64Data = resizedCanvas.toDataURL('image/png');
                finalWidth = resizedCanvas.width;
                finalHeight = resizedCanvas.height;
                // Release memory
                resizedCanvas.width = 0;
                resizedCanvas.height = 0;
                img.src = '';
            }
        }

        // Apply grid overlay if requested (viewport coords for click/fill)
        if (args.grid) {
            // w/h are viewport dims (CSS pixels); for display-media path they aren't set
            var vpW = (typeof w !== 'undefined') ? w : finalWidth;
            var vpH = (typeof h !== 'undefined') ? h : finalHeight;
            base64Data = await overlayGrid(base64Data, vpW, vpH);
        }

        // Compress if over 5MB API limit
        base64Data = await compressBase64Image(base64Data);

        // Generate unique ID for later retrieval via screenshot_by_id (data persisted in chat messages)
        var screenshotId = newFileId();
        var screenshotName = args.name || null;
        var screenshotTimestamp = Date.now();

        return {
            success: true,
            screenshot_id: screenshotId,
            message: 'Screenshot captured: ' + captureDescription,
            dimensions: finalWidth + 'x' + finalHeight,
            size_bytes: Math.round(base64Data.length * 0.75),
            note: 'The screenshot image is now attached to this conversation. I can see it and will analyze the visual content. Use screenshot_id "' + screenshotId + '" with screenshot_by_id tool or executeTool("screenshot_by_id", {id: "' + screenshotId + '"}) in widgets/js_eval to retrieve the image data.',
            _screenshotMessage: {
                role: 'screenshot',
                base64: base64Data,
                name: screenshotName,
                description: captureDescription,
                url: (target === 'browser' ? currentIframeUrl : null) || null,
                timestamp: screenshotTimestamp,
                width: finalWidth,
                height: finalHeight,
                screenshot_id: screenshotId,
                file_id: screenshotId
            }
        };

    } catch (e) {
        return { success: false, error: 'Screenshot capture failed: ' + e.message };
    }
}

// =============================================