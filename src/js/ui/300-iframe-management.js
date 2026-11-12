// Iframe lookups and navigation
// Browser navigation now drives a real Chrome tab via the background service worker —
// the in-page <iframe> embed used by the old ServiceNow UI Page is gone.

function getWidgetIframe(widgetId) {
    // Find a widget iframe by widget_id - checks inline (chat) and dashboard widgets

    var widget = getWidgetById(widgetId);
    if (!widget && dashboardWidgets[widgetId]) widget = dashboardWidgets[widgetId];
    if (widget && widget.deactivated) return null;

    var inlineWidget = document.querySelector('.widget-inline[data-widget-id="' + widgetId + '"] iframe.widget-iframe');
    if (inlineWidget) return inlineWidget;

    var dashboardWidget = document.querySelector('.dashboard-widget[data-widget-id="' + widgetId + '"]');
    if (dashboardWidget) {
        // Dashboard widgets use shadow DOM
        var shadowHost = dashboardWidget.querySelector('.widget-shadow-host');
        if (shadowHost && shadowHost.shadowRoot) {
            var iframe = shadowHost.shadowRoot.querySelector('iframe');
            if (iframe) return iframe;
        }
        var directIframe = dashboardWidget.querySelector('iframe');
        if (directIframe) return directIframe;
    }

    return null;
}

// Origin of a known instance that `url` targets when it differs from the
// active tab's origin; null for relative URLs, same-origin or unknown hosts.
function navigateTargetInstanceOrigin(url, activeTabUrl) {
    var origin;
    try { if (!/^https?:\/\//i.test(url)) return null; origin = new URL(url).origin; } catch (e) { return null; }
    var actOrigin = '';
    try { actOrigin = activeTabUrl ? new URL(activeTabUrl).origin : ''; } catch (e) {}
    if (origin === actOrigin) return null;
    var insts = (typeof Platform !== 'undefined' && Array.isArray(Platform.instances)) ? Platform.instances : [];
    for (var i = 0; i < insts.length; i++) {
        var u = insts[i] && insts[i].url;
        if (u && u.replace(/\/$/, '') === origin) return u;
    }
    return null;
}

// Exact page identity for tab reuse: origin + path (trailing slash ignored) +
// query. A path-only match (e.g. any incident.do form) is NOT the same page.
function navigateSameUrl(a, b) {
    try {
        var ua = new URL(a), ub = new URL(b);
        return ua.origin === ub.origin && ua.search === ub.search &&
            ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '');
    } catch (e) { return false; }
}

// Cross-instance navigate without clobbering a tab the user is working in.
// Reuse a cached tab of `instanceUrl` ONLY when it is still open and already
// shows exactly `url` (focus it, no reload); otherwise open a new tab. The
// cached tab list (Platform.instances[].tabs) refreshes every ~2 min, so the
// live tab is re-checked via chrome.tabs.get — a closed/moved tab falls back
// to a new tab instead of failing silently.
async function navigateCrossInstance(instanceUrl, url) {
    var insts = (typeof Platform !== 'undefined' && Array.isArray(Platform.instances)) ? Platform.instances : [];
    for (var i = 0; i < insts.length; i++) {
        if (!insts[i] || insts[i].url !== instanceUrl || !Array.isArray(insts[i].tabs)) continue;
        var tabs = insts[i].tabs;
        for (var j = 0; j < tabs.length; j++) {
            if (!tabs[j] || tabs[j].id == null || !navigateSameUrl(tabs[j].url, url)) continue;
            try {
                var live = await chrome.tabs.get(tabs[j].id);
                if (!live || !navigateSameUrl(live.url, url)) continue;
                await chrome.tabs.update(live.id, { active: true });
                if (live.windowId != null && chrome.windows && chrome.windows.update) {
                    try { await chrome.windows.update(live.windowId, { focused: true }); } catch (e) {}
                }
                return { tabId: live.id, reused: true };
            } catch (e) { /* stale cached tab (closed) — try next / create */ }
        }
    }
    var created = await chrome.tabs.create({ url: url, active: true });
    return { tabId: created && created.id, created: true };
}

function navigateIframe(url) {
    currentIframeUrl = url;
    appStorage.setItem('browserUrl', url);
    var browserUrl = document.getElementById('browser-url-input');
    if (browserUrl) browserUrl.value = url;

    var resolvedUrl = Platform.resolveUrl(url);
    // User-driven (sidepanel URL bar): target the tab the user is looking at,
    // resolved here explicitly — background.js no longer falls back to it.
    (async function() {
        var _tabId = null;
        var _actUrl = '';
        try {
            var _act = await chrome.tabs.query({ active: true, currentWindow: true });
            if (_act && _act[0]) { _tabId = _act[0].id; _actUrl = _act[0].url || ''; }
        } catch (e) {}
        // Cross-instance: an absolute URL on a KNOWN instance other than the
        // active tab's must not hijack the active tab, nor any other tab of
        // that instance — focus a tab already on exactly that URL, else open
        // a new one. Same-instance / relative URLs unchanged.
        var _target = navigateTargetInstanceOrigin(resolvedUrl, _actUrl);
        if (_target) {
            try { await navigateCrossInstance(_target, resolvedUrl); }
            catch (e) { console.warn('Navigation error:', e && e.message); }
            return;
        }
        if (_tabId == null) { console.warn('Navigation error: no active tab'); return; }
        var _r = await Platform.sendBrowserAction('navigate', { url: resolvedUrl }, _tabId);
        if (_r && _r.error) console.warn('Navigation error:', _r.error);
    })().catch(function(e) {
        console.warn('Navigation error:', e && e.message);
    });
}
