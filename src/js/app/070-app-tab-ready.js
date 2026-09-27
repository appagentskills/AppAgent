// --- App tab ready handshake (APP-TAB-REOPEN, PR B1) ---
// After a Reload the service worker reopens the app tab and only counts it once
// this page proves it booted: send {type:'app-tab-ready', bootId, at, nav,
// prevBoot} once per page load; the SW answers {ok:true}. Exactly one retry
// after 1.5s when no {ok:true} came back (e.g. the SW was still starting).
// Registers no event handlers and writes no extension storage itself: its only
// direct write is this tab's own sessionStorage boot record (prevBoot of the next
// load). The F6 'script-start' breadcrumb is handed to appBootCrumb
// (core/015-boot-crumbs.js; typeof-guarded, fire-and-forget), which owns that ring.
(function() {
    try {
        var rt = (typeof chrome !== 'undefined' && chrome && chrome.runtime) || null;
        if (!rt || typeof rt.sendMessage !== 'function') return;
        var KEY = 'appagentPageAlive';
        var prevBoot = null;
        try {
            var raw = sessionStorage.getItem(KEY);
            prevBoot = raw ? JSON.parse(raw) : null;
        } catch (e) { prevBoot = null; }
        var at = Date.now();
        var bootId = at.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        var nav = null;
        try {
            var entries = (performance && performance.getEntriesByType) ? performance.getEntriesByType('navigation') : null;
            nav = (entries && entries[0] && entries[0].type) || null;
        } catch (e) { nav = null; }
        try { sessionStorage.setItem(KEY, JSON.stringify({ bootId: bootId, at: at, nav: nav })); } catch (e) {}
        if (typeof appBootCrumb === 'function') { try { appBootCrumb('script-start', { nav: nav, readyBootId: bootId }); } catch (e) {} }
        var msg = { type: 'app-tab-ready', bootId: bootId, at: at, nav: nav, prevBoot: prevBoot };
        var acked = false, sends = 0;
        function send() {
            sends++;
            try {
                rt.sendMessage(msg, function(res) {
                    try { void rt.lastError; } catch (e) {}
                    if (res && res.ok === true) acked = true;
                });
            } catch (e) {}
        }
        send();
        setTimeout(function() {
            try { if (!acked && sends < 2) send(); } catch (e) {}
        }, 1500);
    } catch (e) {}
})();
