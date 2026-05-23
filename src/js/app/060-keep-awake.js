// ============================================================
// Keep-Awake feature
// ------------------------------------------------------------
// When the AppAgent chat page is open AND the user has been idle
// for IDLE_MS, request the OS keep the display awake. Show an
// inline notice with "Disable for this session" and "Disable
// forever" buttons. Release the lock on any user activity, tab
// hide, or unload.
//
// All logic lives in this single file to keep the change surgical.
// ============================================================
(function () {
    // Only run inside the browser extension build (chrome.runtime.sendMessage available).
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

    var IDLE_MS = 5 * 60 * 1000;       // 5 minutes
    var HEARTBEAT_MS = 20 * 1000;      // 20s — must be < MV3 service-worker idle timeout (~30s)
    var idleTimer = null;
    var heartbeatTimer = null;
    var lockActive = false;
    var sessionDisabled = false;       // "Disable for this session"
    var foreverDisabled = false;       // persisted setting
    var noticeEl = null;
    var noticeDismissed = false;       // user closed the notice but lock still on
    var noticeFadeTimer = null;        // grace period before hiding notice after activity
    var DEBUG = true;                  // log to console so we can verify it's running
    function log() {
        if (!DEBUG) return;
        try {
            var args = ['[keep-awake]'].concat(Array.prototype.slice.call(arguments));
            console.log.apply(console, args);
        } catch (e) {}
    }

    function sendKeepAwake(enabled) {
        try {
            chrome.runtime.sendMessage({ type: 'keep-awake-set', enabled: !!enabled }, function (resp) {
                if (chrome.runtime.lastError) {
                    log('sendMessage error:', chrome.runtime.lastError.message);
                } else {
                    log('SW responded:', resp);
                }
            });
        } catch (e) { log('sendMessage threw:', e); }
    }

    // The MV3 service worker dies after ~30s of inactivity, which releases the
    // chrome.power lock. Re-assert it every 20s while we want to be awake.
    function startHeartbeat() {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(function () {
            if (!lockActive) { stopHeartbeat(); return; }
            log('heartbeat — re-asserting lock');
            sendKeepAwake(true);
        }, HEARTBEAT_MS);
    }
    function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    function activateLock() {
        if (lockActive || sessionDisabled || foreverDisabled) return;
        if (document.hidden) return;
        // Cancel any pending notice fade — we want it to stay.
        if (noticeFadeTimer) { clearTimeout(noticeFadeTimer); noticeFadeTimer = null; }
        lockActive = true;
        log('ACTIVATE — idle threshold hit, requesting keep-awake');
        sendKeepAwake(true);
        startHeartbeat();
        if (!noticeDismissed) showNotice();
    }

    function releaseLock(immediate) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        stopHeartbeat();
        if (lockActive) {
            lockActive = false;
            log('RELEASE — releasing keep-awake');
            sendKeepAwake(false);
        }
        if (immediate) {
            // Caller wants the notice gone right now (page hide, explicit disable).
            if (noticeFadeTimer) { clearTimeout(noticeFadeTimer); noticeFadeTimer = null; }
            hideNotice();
        } else if (noticeEl && !noticeFadeTimer) {
            // Grace period: keep the notice visible 10s so user can click Disable.
            noticeFadeTimer = setTimeout(function () {
                noticeFadeTimer = null;
                hideNotice();
            }, 10000);
        }
    }

    function resetIdleTimer(evt) {
        // Activity inside the notice itself — user is reading/clicking buttons. Ignore.
        if (evt && evt.target && noticeEl && noticeEl.contains && noticeEl.contains(evt.target)) return;
        if (idleTimer) clearTimeout(idleTimer);
        // Any user activity: release the lock but keep the notice visible briefly.
        if (lockActive) releaseLock(false);
        if (sessionDisabled || foreverDisabled || document.hidden) return;
        // Reset notice-dismissed flag so a fresh idle period shows the notice again.
        noticeDismissed = false;
        idleTimer = setTimeout(activateLock, IDLE_MS);
    }

    // ---------- Inline notice UI ----------
    function ensureStyles() {
        if (document.getElementById('keep-awake-styles')) return;
        var style = document.createElement('style');
        style.id = 'keep-awake-styles';
        style.textContent =
            '.keep-awake-notice{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);' +
            'background:var(--surface,#1f2937);color:var(--text,#e5e7eb);border:1px solid var(--border,#374151);' +
            'border-radius:8px;padding:12px 16px;box-shadow:0 8px 24px rgba(0,0,0,0.25);z-index:99999;' +
            'display:flex;align-items:center;gap:12px;max-width:520px;font-size:13px;opacity:0;' +
            'transition:opacity .2s ease,transform .2s ease;pointer-events:none;}' +
            '.keep-awake-notice.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto;}' +
            '.keep-awake-notice .ka-msg{flex:1;line-height:1.4;}' +
            '.keep-awake-notice button{background:transparent;border:1px solid var(--border,#374151);' +
            'color:inherit;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;white-space:nowrap;}' +
            '.keep-awake-notice button:hover{background:rgba(255,255,255,0.06);}' +
            '.keep-awake-notice .ka-close{border:none;padding:4px 6px;font-size:16px;line-height:1;opacity:.6;}' +
            '.keep-awake-notice .ka-close:hover{opacity:1;background:transparent;}';
        document.head.appendChild(style);
    }

    function showNotice() {
        ensureStyles();
        if (noticeEl) { noticeEl.classList.add('show'); return; }
        var el = document.createElement('div');
        el.className = 'keep-awake-notice';
        el.innerHTML =
            '<span class="ka-msg">\u2600\ufe0f AppAgent is keeping your display awake.</span>' +
            '<button class="ka-session" type="button">Disable this session</button>' +
            '<button class="ka-forever" type="button">Disable forever</button>' +
            '<button class="ka-close" type="button" title="Dismiss">\u00d7</button>';
        document.body.appendChild(el);
        // Force reflow so the transition kicks in.
        void el.offsetWidth;
        el.classList.add('show');
        el.querySelector('.ka-session').addEventListener('click', function () {
            sessionDisabled = true;
            releaseLock(true);
        });
        el.querySelector('.ka-forever').addEventListener('click', function () {
            foreverDisabled = true;
            try { if (typeof setSetting === 'function') setSetting('keepAwakeForeverDisabled', true); } catch (e) {}
            try {
                var cb = document.getElementById('keep-awake-checkbox');
                if (cb) cb.checked = false;
            } catch (e) {}
            releaseLock(true);
        });
        el.querySelector('.ka-close').addEventListener('click', function () {
            noticeDismissed = true;
            hideNotice();
            // NOTE: lock stays active; user just hid the message.
        });
        noticeEl = el;
    }

    function hideNotice() {
        if (!noticeEl) return;
        noticeEl.classList.remove('show');
        var el = noticeEl;
        noticeEl = null;
        setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 250);
    }

    // ---------- Lifecycle ----------
    function onActivity(evt) { resetIdleTimer(evt); }

    function attachListeners() {
        var events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click', 'wheel'];
        for (var i = 0; i < events.length; i++) {
            window.addEventListener(events[i], onActivity, { passive: true, capture: true });
        }
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) releaseLock(true);
            else resetIdleTimer();
        });
        window.addEventListener('pagehide', function () { releaseLock(true); });
        window.addEventListener('beforeunload', function () { releaseLock(true); });
    }

    async function init() {
        try {
            if (typeof getSetting === 'function') {
                foreverDisabled = !!(await getSetting('keepAwakeForeverDisabled', false));
            }
        } catch (e) { /* getSetting not ready yet; default to enabled */ }
        log('init — foreverDisabled=' + foreverDisabled + ' idleMs=' + IDLE_MS);
        // Sync any checkbox in the UI now that the saved setting is loaded.
        try {
            var cb = document.getElementById('keep-awake-checkbox');
            if (cb) cb.checked = !foreverDisabled;
        } catch (e) {}
        attachListeners();
        resetIdleTimer();
    }

    // Expose a tiny API the settings UI can call to re-enable.
    window.setKeepAwakeForeverDisabled = function (disabled) {
        foreverDisabled = !!disabled;
        try { if (typeof setSetting === 'function') setSetting('keepAwakeForeverDisabled', foreverDisabled); } catch (e) {}
        if (foreverDisabled) releaseLock();
        else resetIdleTimer();
    };
    window.getKeepAwakeForeverDisabled = function () { return foreverDisabled; };
    // Diagnostics — call window.keepAwakeStatus() in DevTools to see current state.
    window.keepAwakeStatus = function () {
        var s = {
            lockActive: lockActive,
            sessionDisabled: sessionDisabled,
            foreverDisabled: foreverDisabled,
            idleTimerArmed: !!idleTimer,
            heartbeatRunning: !!heartbeatTimer,
            idleMs: IDLE_MS,
            heartbeatMs: HEARTBEAT_MS,
            documentHidden: document.hidden
        };
        console.table(s);
        return s;
    };
    // Manual force-on for testing — bypasses the 5-min wait.
    window.keepAwakeForceOn = function () {
        log('FORCE ON (testing)');
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        activateLock();
    };
    // Settings page toggle handler. checked = enabled (i.e. NOT forever-disabled).
    window.toggleKeepAwake = function (checked) {
        window.setKeepAwakeForeverDisabled(!checked);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
        init();
    }
})();
