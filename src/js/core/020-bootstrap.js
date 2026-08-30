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

// Provider-scoped cached-usage reader. fetchCredits (ui/170-chat-management.js)
// writes 'cachedCredits:<encoded provider>' plus the legacy 'cachedCredits' +
// 'cachedCreditsProvider' pair. Boot/restore readers must never paint one
// provider's usage for another, so the legacy scalar is accepted ONLY when its
// provider marker matches; unmarked legacy values are ignored (they could
// belong to any provider).
function getCachedCreditsForProvider(providerName) {
    if (!providerName) return null;
    var scoped = appStorage.getItem('cachedCredits:' + encodeURIComponent(providerName));
    if (scoped) return scoped;
    if (appStorage.getItem('cachedCreditsProvider') === providerName) {
        return appStorage.getItem('cachedCredits');
    }
    return null;
}

// Cached usage for the CURRENT provider at boot: loadProviderFromStorage
// (core/120-init.js) may not have run yet, so prefer the persisted selection
// ('appagent_provider') over the in-memory default.
function getBootCachedCredits() {
    var name = appStorage.getItem('appagent_provider')
        || ((typeof currentProvider !== 'undefined' && currentProvider) ? currentProvider : null);
    return getCachedCreditsForProvider(name);
}

// Show cached credits immediately on DOM ready
(function() {
    document.addEventListener('DOMContentLoaded', function() {
        var cachedCredits = getBootCachedCredits();
        if (!cachedCredits) return;
        var el = document.getElementById('credits-display');
        if (el) el.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + cachedCredits;
    });
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