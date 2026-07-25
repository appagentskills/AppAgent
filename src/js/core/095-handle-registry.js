// =============================================================
// Handle Registry — async tool layer (Phase 1, Sub-Agent spec §4)
//
// In-memory store of in-flight / settled handles. A handle is the receipt
// a caller gets back from a sub-agent operation (spawn_sub_agent /
// wake_sub_agent / agent_message); the work runs in the background and the
// agent collects via await_handle / await_any / await_all (registered in
// src/js/core/080-tools.js, dispatched in src/js/tools/020-tool-execution.js).
// Internal code can also poll / cancel via Handles.poll / Handles.cancel.
//
// Design notes for Phase 1:
//   • In-memory only. Handles do NOT survive page/SW reload. (Spec §8.3
//     mentions an IndexedDB backing — deferred.)
//   • Per-chat scoping: a handle issued in chat A is NOT visible from chat
//     B. This is the same scoping the spec calls out in §4.4.
//   • Cancellation is cooperative. We cannot actually abort in-flight
//     background work. Handles.cancel (used internally, e.g. by
//     stop_sub_agent) marks the entry as cancelled; the underlying promise
//     keeps running and its result is discarded on settle. The handle
//     stays in state `cancelled`.
//   • GC: settled or cancelled handles are evicted 24h after they settle.
//     A small periodic sweep runs on every Handles.* call.
//
// API summary (all functions sync unless noted):
//   Handles.start(chatId, name, args, displayName, runFn) -> { handleId, entry }
//   Handles.get(chatId, handleId) -> entry | null
//   Handles.list(chatId) -> entry[]
//   Handles.snapshot(entry) -> sanitized object (no promise/awaiters)
//   Handles.poll(chatId, handleId) -> snapshot | { error }
//   Handles.await(chatId, handleId, timeoutMs) -> Promise<snapshot>
//   Handles.awaitAny(chatId, handleIds, timeoutMs) -> Promise<{handle, snapshot}>
//   Handles.awaitAll(chatId, handleIds, timeoutMs) -> Promise<snapshot[]>
//   Handles.cancel(chatId, handleId, reason) -> { ok, status, error? }
// =============================================================

var HANDLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h after settle
var HANDLE_GC_INTERVAL_MS = 5 * 60 * 1000; // sweep at most once every 5 min

// _handles[chatId] = { [handleId]: entry }
var _handles = Object.create(null);
var _handleCounter = 0;
var _lastGcAt = 0;

function _nowMs() { return Date.now(); }

function _newHandleId() {
    _handleCounter = (_handleCounter + 1) | 0;
    // h_<base36 ts>_<counter>_<rand>
    var ts = _nowMs().toString(36);
    var rnd = Math.floor(Math.random() * 1e9).toString(36);
    return 'h_' + ts + '_' + _handleCounter + '_' + rnd;
}

function _resolvedChatId(chatId) {
    // Most callers pass a real chatId; some headless contexts may pass falsy.
    // Use a stable bucket so the agent can still issue handles in those cases.
    return chatId || '_global';
}

function _gcSweep() {
    var now = _nowMs();
    if (now - _lastGcAt < HANDLE_GC_INTERVAL_MS) return;
    _lastGcAt = now;
    for (var cid in _handles) {
        var bucket = _handles[cid];
        for (var hid in bucket) {
            var e = bucket[hid];
            if (e && e.settledAt && (now - e.settledAt) > HANDLE_TTL_MS) {
                delete bucket[hid];
            }
        }
        // prune empty buckets
        var empty = true;
        for (var _k in bucket) { empty = false; break; }
        if (empty) delete _handles[cid];
    }
}

// Public snapshot — safe to return to the agent. Strips the live promise
// and awaiters array.
function _snapshot(entry) {
    if (!entry) return null;
    var out = {
        handle: entry.handleId,
        tool: entry.name,
        displayName: entry.displayName || entry.name,
        status: entry.status,
        createdAt: entry.createdAt,
        settledAt: entry.settledAt || null,
        cancelled: !!entry.cancelled,
        // True while the inner tool call is blocked on a user-approval
        // modal. Lets the agent distinguish "running slowly" from "user
        // hasn't clicked yet" — if awaitingApproval stays true for too
        // long, cancelling (Handles.cancel) is the right move. Cleared automatically
        // once the user responds (or denies, which settles the handle).
        //
        // Force false once the handle has settled: the flag was set by
        // _markAwaitingApproval while pending but was never reset on any
        // settle path (done / error / user-denial / cancel), so a terminal
        // snapshot could still claim the tool was blocked on the approval
        // modal. It is only meaningful while status === 'pending'.
        awaitingApproval: (entry.status === 'pending') && !!entry.awaitingApproval
    };
    if (entry.status === 'done') {
        out.result = entry.result;
    } else if (entry.status === 'error') {
        out.error = entry.error;
        // Some error settlements (notably sub-agent reports with
        // status:'error') attach a structured payload. Surface it on the
        // snapshot so the agent can still read the full report — the
        // string `error` alone is just the headline summary.
        if (entry.result != null) out.result = entry.result;
    } else if (entry.status === 'cancelled') {
        out.error = entry.error || (entry.cancelReason || 'cancelled');
    }
    return out;
}

// Arm an entry with its background work. `runFn` MUST return a promise.
// Fire-and-forget — we never await it here. Capture both branches so a
// thrown synchronous error inside runFn still settles the handle.
//
// Out-of-band settlement: some callers (notably the sub-agent registry)
// flip the entry to a terminal status BEFORE the deferred returned by
// runFn ever resolves — e.g. `Handles.cancel` for stop_sub_agent, and
// `Handles.errorWith` for sub-agent reports with status:'error'. In
// those cases the entry is already settled (status ≠ 'pending'), and
// the subsequent runFn settlement must NOT overwrite. We guard both
// branches on `entry.status === 'pending'` so any pre-settled entry
// is preserved verbatim (we still bump settledAt for cancellation as a
// record of when the underlying work actually finished).
//
// Shared by _startHandle (fresh handles) and _restoreHandle (handles
// rehydrated from a persisted sub-agent record after an MV3 SW restart).
function _armRunFn(entry, runFn) {
    entry.promise = Promise.resolve().then(runFn).then(function(result) {
        if (entry.status !== 'pending') {
            entry.settledAt = entry.settledAt || _nowMs();
        } else {
            entry.status = 'done';
            entry.result = result;
            entry.settledAt = _nowMs();
        }
        _drainAwaiters(entry);
    }, function(err) {
        if (entry.status !== 'pending') {
            entry.settledAt = entry.settledAt || _nowMs();
        } else {
            entry.status = 'error';
            entry.error = (err && err.message) ? err.message : String(err);
            entry.settledAt = _nowMs();
        }
        _drainAwaiters(entry);
    });
}

// Register a new handle and kick off the work. `runFn` MUST return a promise.
// We never await it here — the caller gets the handle id back immediately.
function _startHandle(chatId, name, args, displayName, runFn) {
    _gcSweep();
    chatId = _resolvedChatId(chatId);
    if (!_handles[chatId]) _handles[chatId] = Object.create(null);
    var handleId = _newHandleId();
    var entry = {
        handleId: handleId,
        chatId: chatId,
        name: name,
        displayName: displayName || name,
        args: args,
        status: 'pending',
        createdAt: _nowMs(),
        settledAt: null,
        result: null,
        error: null,
        cancelled: false,
        cancelReason: null,
        promise: null,
        awaiters: []
    };
    _handles[chatId][handleId] = entry;
    _armRunFn(entry, runFn);
    return { handleId: handleId, entry: entry };
}

// Re-register a handle under a SPECIFIC, previously-issued id. Handles are
// in-memory by design (see header), so an MV3 service-worker restart wipes
// `_handles` — but sub-agent records persist `spawn_handle_id` + `last_report`
// in IDB. SYMPTOM this fixes: after a SW restart the parent's `await_handle`
// against a persisted spawn handle returned `unknown handle`,
// so a sub's report was unreachable even though the record still carried it.
// The sub-agent registry calls this at boot (loadAllSubAgents) to rebuild:
//   • settled subs   → a PRE-SETTLED entry (opts.status done/error/cancelled,
//     with result/error built from last_report) the parent can still collect;
//   • running subs   → a PENDING entry re-armed with a fresh deferred
//     (opts.runFn), settled later by the registry's normal push paths.
// No-op (existed:true) when the id is already registered — loadAll can run
// concurrently with live spawns and must never clobber a live entry.
function _restoreHandle(chatId, handleId, opts) {
    opts = opts || {};
    _gcSweep();
    chatId = _resolvedChatId(chatId);
    if (!handleId) return { handleId: null, entry: null, existed: false };
    if (!_handles[chatId]) _handles[chatId] = Object.create(null);
    var existing = _handles[chatId][handleId];
    if (existing) return { handleId: handleId, entry: existing, existed: true };
    var status = opts.status || 'pending';
    var entry = {
        handleId: handleId,
        chatId: chatId,
        name: opts.name || 'spawn_sub_agent',
        displayName: opts.displayName || opts.name || 'restored handle',
        args: opts.args || null,
        status: status,
        createdAt: opts.createdAt || _nowMs(),
        settledAt: (status === 'pending') ? null : (opts.settledAt || _nowMs()),
        result: (opts.result != null) ? opts.result : null,
        error: (opts.error != null) ? opts.error : null,
        cancelled: status === 'cancelled',
        cancelReason: (status === 'cancelled') ? (opts.error || 'cancelled') : null,
        promise: null,
        awaiters: [],
        restored: true
    };
    _handles[chatId][handleId] = entry;
    if (status === 'pending' && typeof opts.runFn === 'function') {
        _armRunFn(entry, opts.runFn);
    }
    return { handleId: handleId, entry: entry, existed: false };
}

function _drainAwaiters(entry) {
    var aws = entry.awaiters;
    entry.awaiters = [];
    for (var i = 0; i < aws.length; i++) {
        try { aws[i](_snapshot(entry)); } catch (_) { /* ignore */ }
    }
}

function _getEntry(chatId, handleId) {
    chatId = _resolvedChatId(chatId);
    var bucket = _handles[chatId];
    if (!bucket) return null;
    return bucket[handleId] || null;
}

function _listEntries(chatId) {
    _gcSweep();
    chatId = _resolvedChatId(chatId);
    var bucket = _handles[chatId];
    if (!bucket) return [];
    var out = [];
    for (var hid in bucket) out.push(_snapshot(bucket[hid]));
    return out;
}

function _poll(chatId, handleId) {
    _gcSweep();
    var e = _getEntry(chatId, handleId);
    // System prompt promises callers can read `snapshot.status`. For unknown
    // handles we now return a complete snapshot-shaped object so the agent
    // doesn't read `undefined` and crash its own logic.
    if (!e) return { handle: handleId, status: 'unknown', error: 'unknown handle: ' + handleId };
    return _snapshot(e);
}

// Returns a promise that resolves with the snapshot when the handle settles,
// or when the timeout elapses (snapshot will still show status:'pending' in
// that case). The caller decides whether timeout is an error.
function _await(chatId, handleId, timeoutMs) {
    _gcSweep();
    var e = _getEntry(chatId, handleId);
    if (!e) {
        return Promise.resolve({ handle: handleId, status: 'unknown', error: 'unknown handle: ' + handleId });
    }
    if (e.status !== 'pending') {
        return Promise.resolve(_snapshot(e));
    }
    return new Promise(function(resolve) {
        var settled = false;
        function done(snap) {
            if (settled) return;
            settled = true;
            resolve(snap);
        }
        e.awaiters.push(done);
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            setTimeout(function() {
                if (settled) return;
                // Don't remove from awaiters — the underlying promise might
                // still settle later and that's fine. Just resolve with the
                // current (pending) snapshot.
                done(_snapshot(e));
            }, timeoutMs);
        }
    });
}

// Return shape is uniform: always `{ handle, snapshot, timeout, pendingSnapshots? }`.
//   • Win: `{ handle: 'h_xxx', snapshot: {...settled...}, timeout: false }`
//   • Timeout: `{ handle: null, snapshot: null, timeout: true, pendingSnapshots: [...] }`
// The agent only has to check one field (`timeout`) to branch.
function _awaitAny(chatId, handleIds, timeoutMs) {
    if (!Array.isArray(handleIds) || handleIds.length === 0) {
        // Uniform shape: callers branch on `timeout`, so always include it
        // (and handle/snapshot) even on the invalid-input path.
        return Promise.resolve({ handle: null, snapshot: null, timeout: false, error: 'await_any requires a non-empty handles array' });
    }
    // Partition known vs unknown handles up front. An `unknown` handle (bogus
    // id, or one wiped by a service-worker restart) resolves SYNCHRONOUSLY
    // through _await, and the old win-condition (`status !== 'pending'`)
    // treated that as a winner — so a single stale handle in the set would
    // instantly "win" the race and mask handles that were genuinely still
    // pending. Only race the known handles, and only let a TERMINAL status
    // win. But if EVERY handle is unknown there is nothing to wait for, so
    // resolve immediately with the first unknown snapshot rather than hanging
    // until the timeout (or forever, if none was given).
    var known = [];
    for (var ki = 0; ki < handleIds.length; ki++) {
        if (_getEntry(chatId, handleIds[ki])) known.push(handleIds[ki]);
    }
    if (known.length === 0) {
        return Promise.resolve({ handle: handleIds[0], snapshot: _poll(chatId, handleIds[0]), timeout: false, allUnknown: true });
    }
    return new Promise(function(resolve) {
        var settled = false;
        function pick(snap, handleId) {
            if (settled) return;
            settled = true;
            resolve({ handle: handleId, snapshot: snap, timeout: false });
        }
        for (var i = 0; i < known.length; i++) {
            (function(hid) {
                _await(chatId, hid, timeoutMs).then(function(snap) {
                    // Only "win" on a genuinely terminal status. Pending
                    // snapshots (timeout fire-throughs) and unknown snapshots
                    // (raced GC) must not win while a real handle is pending.
                    if (snap && snap.status && snap.status !== 'pending' && snap.status !== 'unknown') {
                        pick(snap, hid);
                    }
                });
            })(known[i]);
        }
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            setTimeout(function() {
                if (settled) return;
                settled = true;
                var snaps = handleIds.map(function(h) { return _poll(chatId, h); });
                resolve({ handle: null, snapshot: null, timeout: true, pendingSnapshots: snaps });
            }, timeoutMs);
        }
    });
}

function _awaitAll(chatId, handleIds, timeoutMs) {
    if (!Array.isArray(handleIds) || handleIds.length === 0) {
        return Promise.resolve({ snapshots: [], timedOut: false, error: 'await_all requires a non-empty handles array' });
    }
    var promises = handleIds.map(function(h) { return _await(chatId, h, timeoutMs); });
    return Promise.all(promises).then(function(snaps) {
        // timedOut: at least one handle never settled within timeoutMs (its
        // snapshot is still status:'pending'). Lets a caller detect a partial
        // result with a single field instead of scanning every snapshot —
        // mirrors the `timeout` flag await_any already returns.
        var timedOut = false;
        for (var i = 0; i < snaps.length; i++) {
            if (snaps[i] && snaps[i].status === 'pending') { timedOut = true; break; }
        }
        return { snapshots: snaps, timedOut: timedOut };
    });
}

// Out-of-band error settlement. Used by the sub-agent registry when a sub
// reports status:'error' (explicit report or auto_report crash fallback) so
// that snapshot.status === 'error' lines up with the
// report payload — instead of the previous behavior where the outer handle
// stayed `done` while result.status was 'error', which was easy to miss.
//
// errMsg becomes snapshot.error (the headline string). payload (optional)
// becomes snapshot.result so the structured report (summary, data,
// _synthesized, etc.) is still reachable.
//
// Idempotent: returns ok:false if the handle is already settled. No-op on
// unknown handles. After settlement the .then guard in `_startHandle`
// preserves this state when the deferred eventually resolves.
function _settleError(chatId, handleId, errMsg, payload) {
    var e = _getEntry(chatId, handleId);
    if (!e) return { ok: false, status: 'unknown', error: 'unknown handle: ' + handleId };
    if (e.status !== 'pending') {
        return { ok: false, status: e.status, error: 'handle already settled' };
    }
    e.status = 'error';
    e.error = String(errMsg || 'error');
    if (payload != null) e.result = payload;
    e.settledAt = _nowMs();
    _drainAwaiters(e);
    return { ok: true, status: 'error' };
}

function _cancel(chatId, handleId, reason) {
    var e = _getEntry(chatId, handleId);
    if (!e) return { ok: false, status: 'unknown', error: 'unknown handle: ' + handleId };
    if (e.status !== 'pending') {
        return { ok: false, status: e.status, error: 'handle already settled' };
    }
    e.cancelled = true;
    e.cancelReason = reason || 'cancelled by caller';
    e.status = 'cancelled';
    e.error = e.cancelReason;
    // Stamp settledAt NOW so the GC sweep can eventually evict this entry.
    // Previously settledAt was left null until the underlying promise finished
    // ("the work is still running in the background"), but a cancelled handle
    // whose background work NEVER settles — a hung fetch / iframe interaction —
    // would then live in the registry forever: an unbounded leak in the
    // long-lived service worker. The status !== 'pending' guard in
    // _startHandle preserves this cancelled state if the work does later
    // resolve (it only refreshes settledAt via `|| _nowMs()`, never the status).
    e.settledAt = _nowMs();
    _drainAwaiters(e);
    return { ok: true, status: 'cancelled', reason: e.cancelReason };
}

// Active count of pending handles for a chat. Used by `agent_status` (future
// Phase 2) and could be surfaced in UI as a "Workers" strip.
function _pendingCount(chatId) {
    chatId = _resolvedChatId(chatId);
    var bucket = _handles[chatId];
    if (!bucket) return 0;
    var n = 0;
    for (var hid in bucket) {
        if (bucket[hid] && bucket[hid].status === 'pending') n++;
    }
    return n;
}

// Mark / clear the "waiting on user approval" flag on a pending handle.
// Called by the approval functions (page-side ui/150-tool-approval.js and
// SW-side worker/120-tool-routing.js) before/after the modal prompt so the
// agent can distinguish "tool is actually running" from "tool is blocked
// waiting on the user to click a button". No-op if the handle is missing
// or already settled.
function _markAwaitingApproval(chatId, handleId, awaiting) {
    var e = _getEntry(chatId, handleId);
    if (!e || e.status !== 'pending') return;
    e.awaitingApproval = !!awaiting;
}

var Handles = {
    start: _startHandle,
    restore: _restoreHandle,
    get: _getEntry,
    list: _listEntries,
    snapshot: _snapshot,
    poll: _poll,
    await: _await,
    awaitAny: _awaitAny,
    awaitAll: _awaitAll,
    cancel: _cancel,
    errorWith: _settleError,
    pendingCount: _pendingCount,
    markAwaitingApproval: _markAwaitingApproval
};

// Expose for SW context too (worker bundle runs as a module/script).
if (typeof self !== 'undefined') { self.Handles = Handles; }
