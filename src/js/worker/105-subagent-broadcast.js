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

    // rAF-coalesce bursts. The registry calls _notifyListeners on a
    // throttled (~1s) tool-call heartbeat in onToolCallInSubAgent, plus on
    // every state transition — multiple notifies per frame are routine when
    // 2-4 subs are active. Collapse to at most one broadcast per
    // animation frame (same shape as src/js/ui/175-sub-agent-ui.js
    // around line 299; setTimeout fallback when rAF is unavailable,
    // which can happen in the SW context).
    var _scheduled = false;
    function _broadcastNow() {
        _scheduled = false;
        if (_agentSubscribers.size === 0) return;
        // PR: don't ship an UNHYDRATED snapshot. Right after an MV3 SW restart
        // a refreshed panel can subscribe before loadAllSubAgents drains IDB,
        // so listAll() returns [] transiently. The page's applySubAgentSnapshot
        // is a FULL-REPLACE, so a records:[] broadcast would WIPE the mirror the
        // page just rehydrated from its own IDB and blank the workers strip
        // (intermittent). Same gate as the hello envelope in 130-port-bridge.js;
        // once loadAll completes it fires _notifyListeners and we broadcast the
        // real set.
        if (typeof SubAgents.isLoaded === 'function' && !SubAgents.isLoaded()) return;
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

    // RES-6: SW-side runCrashed → sub-agent settle. The equivalent handler in
    // app/036-agent-event-handlers-page.js is PAGE-ONLY — it runs against the
    // page's read-only registry mirror, where the spawn deferreds don't exist.
    // In the SW (which hosts every sub-agent loop) NOTHING settled a sub whose
    // runAgent threw uncaught: the parent's spawn handle hung forever with no
    // diagnostic. Drive onSubAgentRunFinished in the authoritative context.
    // Safe on double-delivery: the hook is idempotent on settled subs (the
    // _spawnDeferreds + terminal-state guards return early). The errored
    // reason also routes the crash through the RES-6 transient auto-retry /
    // structured-error / parent-notification machinery.
    if (typeof AgentEvents !== 'undefined' && AgentEvents.on) {
        AgentEvents.on('runCrashed', function(e) {
            try {
                if (e && e.chatId && typeof chats !== 'undefined' && chats[e.chatId]
                    && chats[e.chatId].isSubAgent && SubAgents.onSubAgentRunFinished) {
                    // PR384-FIX-1: this emit fires SYNCHRONOUSLY, but _drainPool's
                    // `.catch → _markErrored(aid, 'agent loop crashed: '+err.message)`
                    // carries the REAL error one MICROTASK later. Settling here
                    // immediately preempts it: _markErrored then no-ops on the
                    // terminal-state guard, so the parent gets this generic message
                    // and transient-crash classification is always false (no
                    // auto-retry). DEFER one macrotask so _markErrored (accurate
                    // message, earlier microtask) wins, and SKIP at fire time if the
                    // record is already terminal — this handler is a fallback only
                    // for crashes that bypass the pool catch. Use e.error when the
                    // emitter supplied one, else the generic message.
                    var _crashErr = (e && e.error)
                        ? e.error
                        : { message: 'sub-agent loop crashed (uncaught throw, no terminal report)' };
                    var _crashChatId = e.chatId;
                    setTimeout(function() {
                        try {
                            var _rec = (typeof chats !== 'undefined' && chats[_crashChatId]
                                && chats[_crashChatId].subAgentId && SubAgents.getById)
                                ? SubAgents.getById(chats[_crashChatId].subAgentId) : null;
                            // Already settled terminal by _markErrored (real message,
                            // earlier microtask) — stand down. Terminal states in
                            // 097 are 'stopped' | 'errored'.
                            if (_rec && (_rec.state === 'stopped' || _rec.state === 'errored')) return;
                            // REG391-3: _markErrored now owns the transient single-
                            // retry (pool-crash path). For a THROTTLE-class crash it
                            // re-queues behind an ~8s back-off timer: the slot is
                            // released and the record is 'running' with
                            // _retry_delayed_until stamped, but nothing is in the pool
                            // yet — so neither the terminal guard above nor the
                            // runningChatIds guard in onSubAgentRunFinished would catch
                            // it, and we'd synthesize a terminal error report that
                            // clobbers the scheduled retry. Stand down while a retry is
                            // pending. (The non-throttle retry hands off via the
                            // runningChatIds guard once its replacement loop starts.)
                            if (_rec && _rec._retry_delayed_until && _rec._retry_delayed_until > Date.now()) return;
                            // REG391-3: _markErrored may have CONSUMED the crash by
                            // queueing the single transient retry (state stays
                            // 'running', sub re-queued or in the ~8s throttle
                            // back-off). Falling through to onSubAgentRunFinished
                            // now would reach auto_report and settle the spawn
                            // handle terminal while the retry is still pending —
                            // stand down. The 30s window bounds the guard so a
                            // STALE retried last_error (latch from an earlier,
                            // recovered crash) can't suppress settling a genuinely
                            // new crash on the rare non-pool path this handler
                            // exists for.
                            if (_rec && _rec.state === 'running' && _rec.last_error
                                && _rec.last_error.transient && _rec.last_error.retried
                                && (Date.now() - (_rec.last_error.at || 0)) < 30000) return;
                            if (SubAgents.onSubAgentRunFinished) {
                                SubAgents.onSubAgentRunFinished(_crashChatId, {
                                    reason: 'errored',
                                    error: _crashErr
                                });
                            }
                        } catch (err2) { console.warn('[sw] runCrashed deferred settle threw', err2); }
                    }, 0);
                }
            } catch (err) { console.warn('[sw] runCrashed sub-agent settle threw', err); }
        });
    }
})();
