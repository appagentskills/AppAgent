// Platform abstraction layer
// Chrome Extension is the only supported target.
// platform-bridge.js fills in instanceUrl/sessionToken from chrome.storage
// and overrides sendNotification with the chrome.runtime bridge.
var Platform = {
    type: 'extension',
    instanceUrl: '', // Set by extension from chrome.storage (e.g. 'https://dev12345.service-now.com')

    // Resolve a relative URL to absolute against the connected SN instance
    resolveUrl: function(url) {
        if (url.startsWith('/') && Platform.instanceUrl) {
            return Platform.instanceUrl + url;
        }
        return url;
    },

    // Send a browser notification (overridden by extension bridge)
    sendNotification: function() {}
};
