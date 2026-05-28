// =============================================================
// Agent loop event bus — shared between the page bundle and the
// offscreen worker bundle.
//
// This file ONLY defines the AgentEvents object. The page-side UI
// handlers (renderMessages / spinner / snackbar / notification) live
// in src/js/ui/095-agent-event-handlers.js and are loaded ONLY in
// the page bundle. The offscreen-side port broadcast bridge lives in
// src/js/worker/100-agent-event-broadcast.js and is loaded ONLY in
// the worker bundle. Both bundles share THIS file so emits made by
// the agent loop reach their respective subscribers without changing
// the loop's emit call sites.
//
// PR2 (this PR) flow:
//   • Offscreen: loop emits → bus delivers locally to the worker-side
//     broadcast handler → that handler posts each event to every
//     connected panel port.
//   • Page (panel): port.onMessage receives an event → re-emits on
//     the page's AgentEvents bus → 095-handlers fire as before.
//
// PR2 TODO — events listed in the spec but intentionally NOT emitted
// in PR1 because they have no current UI side effect:
//   • `toolApprovalNeeded` — today the approval flow is driven directly
//     by showApprovalNotification in ui/160-notifications.js when an
//     approval message is created.
//   • `resumed` — today togglePause just calls runAgent() which fires
//     `runStarted`. A panel attaching to a worker run mid-resume would
//     need an explicit signal that the loop is resuming (vs. starting).
//
// AGENT_EVENTS_PR1_SENTINEL — used by build-verify grep.
// =============================================================

var AgentEvents = (function() {
    var listeners = {};
    return {
        on: function(type, handler) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(handler);
            return handler;
        },
        off: function(type, handler) {
            var arr = listeners[type];
            if (!arr) return;
            var idx = arr.indexOf(handler);
            if (idx >= 0) arr.splice(idx, 1);
        },
        // Synchronous dispatch. Each handler is wrapped in try/catch so a
        // throwing UI handler does NOT propagate back to the emit caller
        // (typically the agent loop) and does not stop dispatch to other
        // subscribers. Errors are logged with the event type so they're
        // discoverable in DevTools.
        //
        // Zero-listener case: silent no-op. The agent loop must be safe
        // to run with no panel attached — emitting an event nobody is
        // listening to is by design.
        emit: function(type, detail) {
            var arr = listeners[type];
            if (!arr || arr.length === 0) return;
            // Snapshot so a handler that subscribes/unsubscribes during
            // dispatch doesn't disturb this iteration.
            var snapshot = arr.slice();
            for (var i = 0; i < snapshot.length; i++) {
                try {
                    snapshot[i](detail || {});
                } catch (e) {
                    console.error('[AgentEvents] handler for "' + type + '" threw:', e);
                }
            }
        },
        // Internal accessor used by the offscreen-side broadcast bridge
        // to enumerate registered listener types (e.g. for diagnostics).
        // Not part of the public contract — do not use in handler code.
        _types: function() { return Object.keys(listeners); }
    };
})();
