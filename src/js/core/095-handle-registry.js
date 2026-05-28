// =============================================================
// Handle Registry — async tool layer (Phase 1, Sub-Agent spec §4)
//
// In-memory store of in-flight / settled tool handles. A handle is the
// receipt a caller gets back when they invoke a tool with `await: false`.
// The actual tool execution runs as a background promise; the agent can
// poll, await, await_any/all, or cancel via the helper tools registered
// in src/js/core/080-tools.js and dispatched in src/js/tools/020-tool-execution.js.
//
// Design notes for Phase 1:
//   • In-memory only. Handles do NOT survive page/SW reload. (Spec §8.3
//     mentions an IndexedDB backing — deferred.)
//   • Per-chat scoping: a handle issued in chat A is NOT visible from chat
//     B. This is the same scoping the spec calls out in §4.4.
//   • Cancellation is cooperative. We cannot actually abort an in-flight
//     fetch / GlideRecord / iframe interaction. cancel_handle marks the
//     entry as cancelled; the underlying promise keeps running and its
//     result is discarded on settle. The handle stays in state `cancelled`.
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
        // long, cancel_handle is the right move. Cleared automatically
        // once the user responds (or denies, which settles the handle).
        awaitingApproval: !!entry.awaitingApproval
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

    // Fire-and-forget. Capture both branches so a thrown synchronous error
    // inside runFn still settles the handle.
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

    return { handleId: handleId, entry: entry };
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
        return Promise.resolve({ error: 'await_any requires a non-empty handles array' });
    }
    return new Promise(function(resolve) {
        var settled = false;
        function pick(snap, handleId) {
            if (settled) return;
            settled = true;
            resolve({ handle: handleId, snapshot: snap, timeout: false });
        }
        for (var i = 0; i < handleIds.length; i++) {
            (function(hid) {
                _await(chatId, hid, timeoutMs).then(function(snap) {
                    // Only "win" if this handle actually settled. Pending
                    // snapshots from timeout fire-throughs shouldn't race.
                    if (snap && snap.status && snap.status !== 'pending') {
                        pick(snap, hid);
                    }
                });
            })(handleIds[i]);
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
        return Promise.resolve({ error: 'await_all requires a non-empty handles array' });
    }
    var promises = handleIds.map(function(h) { return _await(chatId, h, timeoutMs); });
    return Promise.all(promises).then(function(snaps) {
        return { snapshots: snaps };
    });
}

// Out-of-band error settlement. Used by the sub-agent registry when a sub
// reports status:'error' (explicit report, auto_report crash fallback, or
// budget_exhausted) so that snapshot.status === 'error' lines up with the
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
    // settledAt is set when the underlying promise actually finishes — until
    // then the work is still running in the background. We surface "cancelled"
    // immediately to the caller though.
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
    markAwaitingApproval: _markAwaitingApproval,
    // Tools that should NEVER be wrapped in a handle, even if the caller
    // passes `await: false`. Three buckets:
    //   1. The handle helpers themselves (wrapping deadlocks).
    //   2. Cheap reads — no point in async-wrapping.
    //   3. Tools with eager UI side effects bound to the calling
    //      tool_result slot (display, html_widget). The async wrap
    //      severs the slot binding (the agent gets a handle ID instead
    //      of the placeholder / widgetId it needs to emit in its reply
    //      text), and the underlying render fires through a separate
    //      channel so the handle ends up carrying no useful payload.
    //      Result: silently broken behavior the user can't easily
    //      diagnose. Force these synchronous.
    ALWAYS_SYNC_TOOLS: {
        await_handle: true,
        poll_handle: true,
        await_any: true,
        await_all: true,
        cancel_handle: true,
        // Cheap reads — no point in async-wrapping.
        list_instances: true,
        set_chat_title: true,
        // Cache navigators are pure in-memory reads.
        cached_content_outline: true,
        cached_content_read: true,
        cached_content_search: true,
        // Eager-render tools — see comment above.
        display: true,
        html_widget: true,
        // Sub-agent runtime tools — cheap registry ops. Their *result* is
        // the spawn handle / status payload, not the tool execution time;
        // async-wrapping them adds a hop without buying anything.
        spawn_sub_agent: true,
        report_to_parent: true,
        agent_status: true,
        wake_sub_agent: true,
        stop_sub_agent: true,
        sleep_self: true,
        agent_message: true
    }
};

// Expose for SW context too (worker bundle runs as a module/script).
if (typeof self !== 'undefined') { self.Handles = Handles; }
