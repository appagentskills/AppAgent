// =============================================================
// AppAgent offscreen runtime — Layer C checkpoint persistence.
//
// At every tool-call boundary the agent loop emits `toolCallResult`.
// We use that emission as the durable checkpoint marker. If the
// offscreen doc is killed (Chrome SW idle-timer, browser restart,
// etc.) and re-spawned, the boot resume scan reads checkpoints from
// IDB and re-enters the loop for every 'running'/'parked' record.
//
// CKPT-SLIM: records deliberately carry NO transcript. The transcript's
// durability is the chats store's job — the agent loop calls
// saveChatsToStorage() at the same tool boundaries that trigger these
// checkpoints, and resume re-runs from the chats record
// (resumeRunningCheckpoints → runAgent(chatId) reads chats[chatId]).
// Records used to also carry messagesSnapshot (full chat.messages,
// inline base64 screenshots included) that NO reader ever consumed —
// making every tool boundary a multi-MB structured-clone readwrite
// transaction on agent_runs. Under a screenshot-heavy run (or several
// concurrent sub-agents) those queued up past the 30s transaction
// deadline and surfaced as the recurring
// "[checkpoint] write failed ... TimeoutError" spam.
//
// CKPT-COALESCE: writes are also single-flighted per chat with
// latest-wins coalescing (a burst of runStarted/toolCallResult/
// assistantMessage events collapses into at most one in-flight put +
// one queued put). Deletes flow through the SAME per-chat channel so
// a runFinished delete can never be overtaken by a still-queued
// earlier write resurrecting the record ('running' zombie → bogus
// boot resume).
//
// Schema (keyPath: chatId):
//   {
//     chatId: string,
//     turn: number,                      // lastUserMsgIndex
//     callNumber: number,                // current API call index
//     lastEventAt: number (ms),          // last checkpoint time
//     status: 'running' | 'parked' | 'finished' | 'errored',
//     parkedToolCalls: [ {toolCallId, name, input, parkedAt}, ... ]
//   }
// =============================================================

// CKPT-COALESCE channels: chatId -> { op, draining, waiters }.
//   op:      the NEXT operation to run ({ type: 'put', record } |
//            { type: 'delete' }) — replaced in place by newer calls
//            (latest wins) until the drain picks it up.
//   waiters: resolvers for every caller whose op is represented by the
//            current `op`; popped together with it, resolved when THAT
//            operation settles. Callers arriving mid-flight go to the
//            fresh waiters list and resolve on the next drain pass.
var _ckptChannels = {};

function _ckptEnqueue(chatId, op) {
    var ch = _ckptChannels[chatId] || (_ckptChannels[chatId] = { op: null, draining: false, waiters: [] });
    ch.op = op; // latest wins — a queued-but-unwritten older op is superseded
    var done = new Promise(function(res) { ch.waiters.push(res); });
    if (!ch.draining) {
        ch.draining = true;
        _ckptDrain(chatId, ch);
    }
    return done;
}

function _ckptDrain(chatId, ch) {
    var op = ch.op;
    ch.op = null;
    var waiters = ch.waiters;
    ch.waiters = [];
    var run = (op.type === 'delete') ? _ckptDeleteNow(chatId) : _ckptPutNow(chatId, op.record);
    // Both ops honour the never-reject contract, so this then() always runs.
    run.then(function() {
        for (var i = 0; i < waiters.length; i++) {
            try { waiters[i](); } catch (e) {}
        }
        if (ch.op) {
            _ckptDrain(chatId, ch);
        } else {
            ch.draining = false;
            delete _ckptChannels[chatId];
        }
    });
}

function _ckptPutNow(chatId, record) {
    // SW-IDLE-CLOSE hardening: route through withStore() instead of holding
    // the DB handle directly (as core/097-sub-agent-registry.js's
    // _pendingWakesStore still does). Checkpoint writes can
    // race the idle connection release (releaseIdleDbConnection, fired from
    // ANOTHER chat's parked-checkpoint path or the 30s heartbeat) — a bare
    // db.transaction() would then throw InvalidStateError and the checkpoint
    // would be dropped. withStore classifies that via _isDbConnectionError,
    // reopens a fresh connection and retries the put EXACTLY once (put is
    // idempotent on keyPath chatId, so a retry is safe). We still honour the
    // never-reject contract — a checkpoint miss must never break the run — but
    // a failure that survives the retry is now logged LOUDLY instead of being
    // dropped silently.
    return withStore([agentRunsStoreName], 'readwrite', function(tx) {
        return new Promise(function(resolve, reject) {
            var req = tx.objectStore(agentRunsStoreName).put(record);
            req.onsuccess = function() { resolve(); };
            // Reject so withStore can classify a connection-shaped error and
            // drive its reopen-and-retry-once path.
            req.onerror = function() { reject(req.error); };
        });
    }).catch(function(e) {
        console.warn('[checkpoint] write failed for chat ' + chatId + ' (dropped after connection-error retry)', e);
    });
}

function _ckptDeleteNow(chatId) {
    return withStore([agentRunsStoreName], 'readwrite', function(tx) {
        return new Promise(function(resolve) {
            var req = tx.objectStore(agentRunsStoreName).delete(chatId);
            req.onsuccess = function() { resolve(); };
            req.onerror = function() { resolve(); };
        });
    }).catch(function(e) {
        console.warn('[checkpoint] delete failed for chat ' + chatId, e);
    });
}

function writeAgentCheckpoint(chatId, snapshot) {
    if (!chatId) return Promise.resolve();
    var record = Object.assign({}, snapshot, {
        chatId: chatId,
        lastEventAt: Date.now()
    });
    return _ckptEnqueue(chatId, { type: 'put', record: record });
}

function readAgentCheckpoint(chatId) {
    // FIX (691-R2): route through withStore (like _ckptPutNow) instead of a
    // bare db.transaction — a read racing the idle connection release
    // (releaseIdleDbConnection, fired from another chat's parked-checkpoint
    // path or the 30s heartbeat) threw InvalidStateError with no retry.
    // withStore reopens + retries once and we still honour the
    // never-reject contract on top of it.
    return withStore([agentRunsStoreName], 'readonly', function(tx) {
        return new Promise(function(resolve, reject) {
            var req = tx.objectStore(agentRunsStoreName).get(chatId);
            req.onsuccess = function() { resolve(req.result || null); };
            req.onerror = function() { reject(req.error); };
        });
    }).catch(function(e) {
        console.warn('[checkpoint] read failed for chat ' + chatId, e);
        return null;
    });
}

function deleteAgentCheckpoint(chatId) {
    if (!chatId) return Promise.resolve();
    // Through the per-chat channel (NOT a direct delete): ordering with any
    // queued/in-flight write must be preserved — see CKPT-COALESCE above.
    return _ckptEnqueue(chatId, { type: 'delete' });
}

// Boot-time reaper. Deletes every checkpoint record that is not a LIVE
// run ('running'/'parked' are never touched) and is either explicitly
// 'finished' (legacy records written before delete-on-finish landed) or
// stale: lastEventAt missing or older than 24h. Cursor-based so we never
// materialize the (potentially huge) records and never store.clear().
function sweepFinishedAgentCheckpoints() {
    var cutoff = Date.now() - (24 * 60 * 60 * 1000);
    // FIX (691-R2): route through withStore — same idle-connection-release
    // race as readAgentCheckpoint, plus a never-reject catch so a boot
    // reaper failure cannot break boot.
    return withStore([agentRunsStoreName], 'readwrite', function(tx) {
        return new Promise(function(resolve) {
            var store = tx.objectStore(agentRunsStoreName);
            var deleted = 0;
            var req = store.openCursor();
            req.onsuccess = function(e) {
                var cur = e.target.result;
                if (!cur) { resolve(deleted); return; }
                var rec = cur.value || {};
                var isLive = (rec.status === 'running' || rec.status === 'parked');
                var isStale = (typeof rec.lastEventAt !== 'number') || (rec.lastEventAt < cutoff);
                if (!isLive && (rec.status === 'finished' || isStale)) {
                    try { cur.delete(); deleted++; } catch (e2) {}
                }
                cur.continue();
            };
            req.onerror = function() { resolve(deleted); };
        });
    }).catch(function(e) {
        console.warn('[checkpoint] sweep failed', e);
        return 0;
    });
}

function listRunningAgentCheckpoints() {
    // FIX (691-R2): route through withStore — same idle-connection-release
    // race as readAgentCheckpoint, plus a never-reject catch (boot resume
    // scan must never throw and abort boot).
    return withStore([agentRunsStoreName], 'readonly', function(tx) {
        return new Promise(function(resolve) {
            var store = tx.objectStore(agentRunsStoreName);
            var out = [];
            var req = store.openCursor();
            req.onsuccess = function(e) {
                var cur = e.target.result;
                if (!cur) { resolve(out); return; }
                if (cur.value && (cur.value.status === 'running' || cur.value.status === 'parked')) {
                    out.push(cur.value);
                }
                cur.continue();
            };
            req.onerror = function() { resolve(out); };
        });
    }).catch(function(e) {
        console.warn('[checkpoint] list failed', e);
        return [];
    });
}

// =============================================================
// Wire the checkpoint to the bus. AgentEvents is shared between
// the page bundle and the worker bundle, but THIS subscriber is
// only registered in the worker bundle (because this file lives
// in src/js/worker/ which is excluded from the page bundle by the
// build's tier list). So checkpoints are written exactly once per
// emit — by the offscreen authoritative writer.
// =============================================================

// Triggered events that warrant a checkpoint write. Tool boundaries
// are the durable points (per spec). We also checkpoint at
// `assistantMessage` (after a complete API call's metrics are stored)
// so a resume can pick up token/duration totals.
//
// `runFinished` is the natural commit-and-clear point: a clean finish
// DELETES the checkpoint outright (dead records are pure clutter for the
// resume scan, and LEGACY records still carry a full messagesSnapshot).
// 'errored' and 'paused' records are kept for diagnostics /
// resume-by-user and reaped by sweepFinishedAgentCheckpoints after 24h
// on SW boot.
function _buildCheckpointSnapshotFor(chatId) {
    var chat = chats[chatId];
    if (!chat) return null;
    return {
        chatId: chatId,
        turn: (function() {
            // Find last user msg — duplicate of agent-loop logic; cheap to
            // recompute here so we don't have to thread `lastUserMsgIndex`
            // through events.
            if (!chat.messages) return -1;
            for (var i = chat.messages.length - 1; i >= 0; i--) {
                if (chat.messages[i].role === 'user') return i;
            }
            return -1;
        })(),
        callNumber: 0, // best-effort — recomputed on resume from message metrics
        // CKPT-SLIM: no messagesSnapshot / aggregateMetrics — the transcript is
        // durable in the chats store (saveChatsToStorage runs at the same tool
        // boundaries) and resume re-runs from there; see the header comment.
        status: 'running',
        parkedToolCalls: (parkedToolCallsByChatId[chatId] || []).map(function(p) {
            return { toolCallId: p.toolCallId, name: p.name, input: p.input, parkedAt: p.parkedAt };
        })
    };
}

AgentEvents.on('runStarted', function(e) {
    writeAgentCheckpoint(e.chatId, _buildCheckpointSnapshotFor(e.chatId) || { chatId: e.chatId, status: 'running' });
});

AgentEvents.on('toolCallResult', function(e) {
    writeAgentCheckpoint(e.chatId, _buildCheckpointSnapshotFor(e.chatId) || { chatId: e.chatId, status: 'running' });
});

AgentEvents.on('toolCallCancelled', function(e) {
    writeAgentCheckpoint(e.chatId, _buildCheckpointSnapshotFor(e.chatId) || { chatId: e.chatId, status: 'running' });
});

AgentEvents.on('assistantMessage', function(e) {
    writeAgentCheckpoint(e.chatId, _buildCheckpointSnapshotFor(e.chatId) || { chatId: e.chatId, status: 'running' });
});

AgentEvents.on('runFinished', function(e) {
    if (!e.hasError && !e.isPaused) {
        // Clean finish — the checkpoint has served its purpose. The resume
        // scanner only ever looks at 'running'/'parked' records, so a
        // 'finished' record is dead weight (with a full messagesSnapshot
        // inside). Delete instead of writing status:'finished'.
        deleteAgentCheckpoint(e.chatId);
        return;
    }
    var snap = _buildCheckpointSnapshotFor(e.chatId) || { chatId: e.chatId };
    snap.status = e.hasError ? 'errored' : 'paused';
    writeAgentCheckpoint(e.chatId, snap);
});

AgentEvents.on('toolParked', function(e) {
    var snap = _buildCheckpointSnapshotFor(e.chatId) || { chatId: e.chatId };
    snap.status = 'parked';
    // SW-IDLE-CLOSE (empty-chat-list root fix): a parked run waits — possibly for
    // the whole park lifetime — with no further DB writes. Release the SW's
    // cached IDB connection right after the parked checkpoint commits so it is
    // not held (and later abandoned by an abrupt SW kill / OS sleep, wedging the
    // backing store). The heartbeat alarm would release it within ~30s anyway;
    // this just does it promptly at the natural idle boundary. The panel's
    // reconnect/replay reopens transparently.
    writeAgentCheckpoint(e.chatId, snap).then(function() {
        try { if (typeof releaseIdleDbConnection === 'function') releaseIdleDbConnection(); } catch (err) {}
    });
});
