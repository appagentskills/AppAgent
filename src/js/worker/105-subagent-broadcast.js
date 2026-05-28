// =============================================================
// AppAgent SW runtime — sub-agent registry broadcast bridge.
//
// Loaded AFTER 100-agent-event-broadcast.js so `_agentSubscribers`
// (the per-panel port Set) is in scope. Loaded BEFORE 130-port-
// bridge.js, so panels that connect after this file installs its
// listener will get live updates AND the hello-bundled initial
// snapshot. Either ordering is fine — the snapshot envelope is
// idempotent (full-replace via SubAgents.applySnapshot).
//
// Job: keep the page bundle's `_subAgents` mirror in sync with the
// SW's authoritative registry. The SW mutates the registry on every
// spawn / state transition / heartbeat tick and fires its listeners
// via `_notifyListeners` — but those listeners only run in-process.
// Without a bridge, new spawns / state changes are invisible to the
// workers strip and chat list until the user reloads the panel.
//
// Pattern mirrors 100-agent-event-broadcast.js (per-panel port set,
// dead-port cleanup) and the workers strip's own rAF coalescer in
// src/js/ui/175-sub-agent-ui.js — every registry tick (tool-call
// heartbeat, last_activity stamp) fires a notify, so unthrottled
// this would flood the bus.
// =============================================================

(function() {
    // Defensive guard: this file lives under src/js/worker/ so it
    // only ships in the SW bundle, but match 100-agent-event-broadcast
    // style and bail cleanly in any other context.
    if (typeof Platform === 'undefined' || Platform.isWorker !== true) {
        return;
    }
    if (typeof SubAgents === 'undefined' || !SubAgents.addListener) {
        console.error('[sw] SubAgents registry not loaded — sub-agent broadcast bridge inert');
        return;
    }
    if (typeof _agentSubscribers === 'undefined') {
        console.error('[sw] _agentSubscribers not in scope — sub-agent broadcast bridge inert (load after 100-agent-event-broadcast.js)');
        return;
    }

    // rAF-coalesce bursts. The registry calls _notifyListeners on
    // every tool-call heartbeat in onToolCallInSubAgent, plus on every
    // state transition — multiple notifies per frame are routine when
    // 2-4 subs are active. Collapse to at most one broadcast per
    // animation frame (same shape as src/js/ui/175-sub-agent-ui.js
    // around line 299; setTimeout fallback when rAF is unavailable,
    // which can happen in the SW context).
    var _scheduled = false;
    function _broadcastNow() {
        _scheduled = false;
        if (_agentSubscribers.size === 0) return;
        var records;
        try {
            records = SubAgents.listAll();
        } catch (e) {
            console.error('[sw] SubAgents.listAll failed:', e);
            return;
        }
        var pool = null;
        if (typeof SubAgents.poolSnapshot === 'function') {
            try { pool = SubAgents.poolSnapshot(); } catch (_) { pool = null; }
        }
        var envelope = { type: 'subagent-snapshot', records: records, pool: pool };
        var dead = [];
        _agentSubscribers.forEach(function(port) {
            try {
                port.postMessage(envelope);
            } catch (e) {
                dead.push(port);
            }
        });
        if (dead.length) dead.forEach(function(p) { _agentSubscribers.delete(p); });
    }
    function _schedule() {
        if (_scheduled) return;
        _scheduled = true;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(_broadcastNow);
        } else {
            setTimeout(_broadcastNow, 16);
        }
    }

    SubAgents.addListener(_schedule);

    // Diagnostic sentinel — read by tests to confirm the bridge is in place.
    SubAgents._broadcastInstalled = true;
})();
