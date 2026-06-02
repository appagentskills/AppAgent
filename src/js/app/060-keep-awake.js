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
    var lockActive = false;            // OS lock currently asserted (mirror of computeDesired)
    var idleActivated = false;         // idle threshold fired -> idle-based desire to stay awake
    var runningChats = {};             // chatId -> true while an agent run is in progress
    var sessionDisabled = false;       // "Disable for this session" (idle path only)
    var foreverDisabled = false;       // persisted master setting (disables everything)
    var noticeEl = null;
    var noticeDismissed = false;       // user closed the notice but lock still on
    var noticeFadeTimer = null;        // grace period before hiding notice after activity
    var DEBUG = false;                 // ship with logging off (window.keepAwakeStatus() still works for diagnostics)
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

    function anyRunActive() {
        for (var k in runningChats) { if (runningChats[k]) return true; }
        return false;
    }

    // Single source of truth for whether the OS display lock should be held.
    // PRIMARY trigger: an agent run is in progress (long tasks must keep the
    // screen on even with zero mouse/keyboard activity). SECONDARY trigger:
    // the user has been idle for IDLE_MS while just reading. The master
    // setting (foreverDisabled) turns the whole feature off; the per-session
    // opt-out only suppresses the idle path, never an active run.
    function computeDesired() {
        if (foreverDisabled) return false;
        if (anyRunActive()) return true;
        if (sessionDisabled) return false;
        return idleActivated;
    }

    // Assert or release the OS lock so it matches computeDesired(). Idempotent —
    // safe to call on every state change. Heartbeat re-asserts while held.
    function syncLock() {
        var want = computeDesired();
        if (want && !lockActive) {
            lockActive = true;
            log('LOCK ON — ' + (anyRunActive() ? 'agent run active' : 'idle threshold'));
            sendKeepAwake(true);
            startHeartbeat();
        } else if (!want && lockActive) {
            lockActive = false;
            log('LOCK OFF — no run + idle cleared/disabled');
            sendKeepAwake(false);
            stopHeartbeat();
        }
    }

    // Idle threshold reached. Flag the idle desire and (only for the idle path,
    // and only when no run is already holding the lock) show the inline notice.
    function activateLock() {
        if (foreverDisabled || sessionDisabled) return;
        if (document.hidden) return;
        if (noticeFadeTimer) { clearTimeout(noticeFadeTimer); noticeFadeTimer = null; }
        var hadRunLock = anyRunActive();
        idleActivated = true;
        log('idle threshold hit');
        syncLock();
        if (!noticeDismissed && !hadRunLock) showNotice();
    }

    // Drop the idle-based desire (user is active again). Any active-run lock is
    // preserved by syncLock(). `immediate` hides the notice now vs. after a grace period.
    function clearIdle(immediate) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (idleActivated) { idleActivated = false; log('idle cleared'); }
        syncLock();
        if (immediate) {
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

    // Full teardown on page unload — release the OS lock regardless of run state.
    function forceRelease() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        stopHeartbeat();
        if (lockActive) { lockActive = false; sendKeepAwake(false); }
        if (noticeFadeTimer) { clearTimeout(noticeFadeTimer); noticeFadeTimer = null; }
        hideNotice();
    }

    function resetIdleTimer(evt) {
        // Activity inside the notice itself — user is reading/clicking buttons. Ignore.
        if (evt && evt.target && noticeEl && noticeEl.contains && noticeEl.contains(evt.target)) return;
        // Any user activity: drop the idle desire (a run lock, if any, persists).
        clearIdle(false);
        if (sessionDisabled || foreverDisabled || document.hidden) return;
        // Reset notice-dismissed flag so a fresh idle period shows the notice again.
        noticeDismissed = false;
        idleTimer = setTimeout(activateLock, IDLE_MS);
    }

    // ---------- Agent-run tracking (primary keep-awake trigger) ----------
    function attachRunListeners() {
        if (typeof AgentEvents === 'undefined' || !AgentEvents.on) {
            log('AgentEvents unavailable — run-based keep-awake disabled');
            return;
        }
        AgentEvents.on('runStarted', function (e) {
            if (e && e.chatId) { runningChats[e.chatId] = true; log('runStarted ' + e.chatId); syncLock(); }
        });
        function runEnded(e) {
            if (e && e.chatId && runningChats[e.chatId]) {
                delete runningChats[e.chatId];
                log('runEnded ' + e.chatId);
                syncLock();
            }
        }
        AgentEvents.on('runFinished', runEnded);
        AgentEvents.on('runCrashed', runEnded);
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
            // Idle-path opt-out only. An active agent run keeps holding the lock.
            sessionDisabled = true;
            clearIdle(true);
        });
        el.querySelector('.ka-forever').addEventListener('click', function () {
            foreverDisabled = true;
            try { if (typeof setSetting === 'function') setSetting('keepAwakeForeverDisabled', true); } catch (e) {}
            try {
                var cb = document.getElementById('keep-awake-checkbox');
                if (cb) cb.checked = false;
            } catch (e) {}
            clearIdle(true);
        });
        el.querySelector('.ka-close').addEventListener('click', function () {
            noticeDismissed = true;
            hideNotice();
            // NOTE: lock stays active; user just hid the message.
        });
        noticeEl = el;
        // Clicking/tapping anywhere outside the panel dismisses it too (same as ×).
        // pointerdown is capture-phase so it lands before the global activity
        // 'click' handler, closing the panel immediately rather than after a grace period.
        document.addEventListener('pointerdown', onOutsidePointerDown, true);
    }

    function hideNotice() {
        if (!noticeEl) return;
        document.removeEventListener('pointerdown', onOutsidePointerDown, true);
        noticeEl.classList.remove('show');
        var el = noticeEl;
        noticeEl = null;
        setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 250);
    }

    // Dismiss the notice when the user interacts anywhere outside it. The OS lock
    // is governed separately by computeDesired()/the activity handler — this only
    // hides the message, mirroring the × button.
    function onOutsidePointerDown(evt) {
        if (!noticeEl) return;
        if (noticeEl.contains && noticeEl.contains(evt.target)) return;
        noticeDismissed = true;
        hideNotice();
    }

    // ---------- Lifecycle ----------
    function onActivity(evt) { resetIdleTimer(evt); }

    function attachListeners() {
        var events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click', 'wheel'];
        for (var i = 0; i < events.length; i++) {
            window.addEventListener(events[i], onActivity, { passive: true, capture: true });
        }
        document.addEventListener('visibilitychange', function () {
            // Hiding the panel drops the idle desire but NOT an active-run lock
            // (chrome.power is machine-global, so the screen should stay awake
            // while a run streams even if this document is backgrounded).
            if (document.hidden) clearIdle(true);
            else resetIdleTimer();
        });
        window.addEventListener('pagehide', function () { forceRelease(); });
        window.addEventListener('beforeunload', function () { forceRelease(); });
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
        attachRunListeners();
        // A run may already be in flight when this panel (re)loads — e.g. a
        // background chat streaming. runStarted fired before we attached, so
        // seed from the per-tab running map if it exists.
        try {
            if (typeof runningChatIds !== 'undefined' && runningChatIds) {
                for (var cid in runningChatIds) { if (runningChatIds[cid]) runningChats[cid] = true; }
            }
        } catch (e) {}
        resetIdleTimer();
        syncLock();
    }

    // Expose a tiny API the settings UI can call to re-enable.
    window.setKeepAwakeForeverDisabled = function (disabled) {
        foreverDisabled = !!disabled;
        try { if (typeof setSetting === 'function') setSetting('keepAwakeForeverDisabled', foreverDisabled); } catch (e) {}
        if (foreverDisabled) { hideNotice(); syncLock(); }
        else resetIdleTimer();
    };
    window.getKeepAwakeForeverDisabled = function () { return foreverDisabled; };
    // Diagnostics — call window.keepAwakeStatus() in DevTools to see current state.
    window.keepAwakeStatus = function () {
        var s = {
            lockActive: lockActive,
            idleActivated: idleActivated,
            runActive: anyRunActive(),
            runningChats: Object.keys(runningChats),
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
