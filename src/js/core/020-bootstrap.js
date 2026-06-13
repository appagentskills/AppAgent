//Start
// Storage wrapper to isolate iframe data from standalone data
var isInIframe = (function() {
    try { return window.self !== window.top; } catch (e) { return true; }
})();
var STORAGE_PREFIX = isInIframe ? 'iframe_' : '';
var appStorage = {
    getItem: function(key) { return window.localStorage.getItem(STORAGE_PREFIX + key); },
    setItem: function(key, value) { window.localStorage.setItem(STORAGE_PREFIX + key, value); },
    removeItem: function(key) { window.localStorage.removeItem(STORAGE_PREFIX + key); }
};

// Show cached credits immediately on DOM ready
(function() {
    var cachedCredits = appStorage.getItem('cachedCredits');
    if (cachedCredits) {
        document.addEventListener('DOMContentLoaded', function() {
            var el = document.getElementById('credits-display');
            if (el) el.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + cachedCredits;
        });
    }
})();

// Prevent pinch-to-zoom on Safari iOS (Safari ignores user-scalable=no since iOS 10)
document.addEventListener('gesturestart', function(e) { e.preventDefault(); }, { passive: false });
document.addEventListener('gesturechange', function(e) { e.preventDefault(); }, { passive: false });
document.addEventListener('gestureend', function(e) { e.preventDefault(); }, { passive: false });
document.addEventListener('touchmove', function(e) {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// Session token is injected by the build system:
// - ServiceNow: window.sessionToken = "$[gs.getSessionToken()]" (GSP template)
// - Extension: set from chrome.storage via platform-bridge.js