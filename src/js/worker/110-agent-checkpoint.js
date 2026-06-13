// =============================================================
// AppAgent offscreen runtime — Layer C checkpoint persistence.
//
// At every tool-call boundary the agent loop emits `toolCallResult`.
// We use that emission as the durable checkpoint: a chat's full
// message list is snapshotted to the agent_runs store. If the
// offscreen doc is killed (Chrome SW idle-timer, browser restart,
// etc.) and re-spawned, 080-agent-resume.js reads checkpoints from
// IDB and re-enters the loop from the saved state.
//
// IMPORTANT: the in-flight assistant message (the one currently
// streaming when the doc died) is NOT durable — its content lives
// only in chat.messages until persisted via saveChatsToStorage().
// The checkpoint captures messages immediately AFTER a tool result
// is appended, so on resume the last tool result IS present and
// the model emits a fresh call.
//
// Schema (keyPath: chatId):
//   {
//     chatId: string,
//     turn: number,                      // lastUserMsgIndex
//     callNumber: number,                // current API call index
//     messagesSnapshot: Array,           // full chat.messages
//     aggregateMetrics: { ... },         // metrics rollup
//     lastEventAt: number (ms),          // last checkpoint time
//     status: 'running' | 'parked' | 'finished' | 'errored',
//     parkedToolCalls: [ {toolCallId, name, input, parkedAt}, ... ]
//   }
// =============================================================

function _agentRunsStore(mode) {
    return openDatabase().then(function(db) {
        var tx = db.transaction([agentRunsStoreName], mode || 'readonly');
        return tx.objectStore(agentRunsStoreName);
    });
}

function writeAgentCheckpoint(chatId, snapshot) {
    if (!chatId) return Promise.resolve();
    return _agentRunsStore('readwrite').then(function(store) {
        return new Promise(function(resolve) {
            var record = Object.assign({}, snapshot, {
                chatId: chatId,
                lastEventAt: Date.now()
            });
            var req = store.put(record);
            req.onsuccess = function() { resolve(); };
            req.onerror = function() {
                // Checkpoint failure is non-fatal — log and continue.
                console.error('[checkpoint] write failed for chat ' + chatId, req.error);
                resolve();
            };
        });
    }).catch(function(e) {
        console.error('[checkpoint] tx open failed', e);
    });
}

function readAgentCheckpoint(chatId) {
    return _agentRunsStore('readonly').then(function(store) {
        return new Promise(function(resolve) {
            var req = store.get(chatId);
            req.onsuccess = function() { resolve(req.result || null); };
            req.onerror = function() { resolve(null); };
        });
    });
}

function deleteAgentCheckpoint(chatId) {
    return _agentRunsStore('readwrite').then(function(store) {
        return new Promise(function(resolve) {
            var req = store.delete(chatId);
            req.onsuccess = function() { resolve(); };
            req.onerror = function() { resolve(); };
        });
    });
}

// Boot-time reaper. Deletes every checkpoint record that is not a LIVE
// run ('running'/'parked' are never touched) and is either explicitly
// 'finished' (legacy records written before delete-on-finish landed) or
// stale: lastEventAt missing or older than 24h. Cursor-based so we never
// materialize the (potentially huge) records and never store.clear().
function sweepFinishedAgentCheckpoints() {
    var cutoff = Date.now() - (24 * 60 * 60 * 1000);
    return _agentRunsStore('readwrite').then(function(store) {
        return new Promise(function(resolve) {
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
    });
}

function listRunningAgentCheckpoints() {
    return _agentRunsStore('readonly').then(function(store) {
        return new Promise(function(resolve) {
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
// DELETES the checkpoint outright (each record holds a full
// messagesSnapshot — keeping them bloats IDB unboundedly). 'errored'
// and 'paused' records are kept for diagnostics / resume-by-user and
// reaped by sweepFinishedAgentCheckpoints after 24h on SW boot.
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
        messagesSnapshot: chat.messages ? chat.messages.slice() : [],
        aggregateMetrics: null, // recomputed from message metrics on resume
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
    writeAgentCheckpoint(e.chatId, snap);
});
