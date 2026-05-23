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

function navigateIframe(url) {
    currentIframeUrl = url;
    appStorage.setItem('browserUrl', url);
    var browserUrl = document.getElementById('browser-url-input');
    if (browserUrl) browserUrl.value = url;

    var resolvedUrl = Platform.resolveUrl(url);
    Platform.sendBrowserAction('navigate', { url: resolvedUrl }).catch(function(e) {
        console.warn('Navigation error:', e.message);
    });
}
