// =============================================================
// Sub-Agent Registry — Phase 2 of the Sub-Agent Architecture spec.
//
// A sub-agent is a background chat (chat.isSubAgent = true) running its own
// agent loop in service of a parent chat. The parent spawns it with
// `spawn_sub_agent`, gets a handle back, and either awaits the result
// (`await_handle`) or fires-and-forgets. The sub does its work in isolation
// (its own context window) and pushes a distilled summary back via
// `report_to_parent`, which resolves the spawn handle.
//
// What lives in this file:
//   • SubAgents.spawn / get / list / stop / sleep / wake / message
//   • report_to_parent dispatch (sub → parent inbox + handle resolution)
//   • Worker pool — a shared 2-slot scheduler that caps concurrent sub
//     `runAgent` invocations. Excess spawns are queued.
//   • Inbox semantics — pending messages drain into the sub's next user
//     turn when it wakes.
//   • IndexedDB persistence — every state mutation re-puts the record so
//     crash/reload recovery is possible.
//
// What lives elsewhere:
//   • The 7 sub-agent tool definitions: src/js/core/080-tools.js
//   • Tool dispatch arms (server-side): src/js/tools/020-tool-execution.js
//   • System-prompt preamble appending: src/js/core/110-system-prompt.js
//     (preamble lives here as SUB_AGENT_PREAMBLE; the prompt module reads it.)
//   • Spawn-handle settlement on natural runAgent end: src/js/app/030-agent-loop.js
//   • Sidebar breadcrumb / Workers strip: src/js/ui/170-chat-management.js
//
// Pool behavior:
//   • Pool size = 2 concurrent running sub-agents (SUBAGENT_POOL_SIZE).
//     Conservatively low: Anthropic enforces an account-level concurrent-
//     request cap above us, and 4 parallel sub loops reliably trips 429 on
//     fresh tiers. Two is the empirical safe default.
//   • spawn_sub_agent always creates the record + chat immediately. If
//     there is a free slot, it kicks runAgent(chatId) now; otherwise the
//     sub stays in `running` state but its loop has not been started — it
//     is in the pool's pending queue, waiting for a slot.
//   • When a slot frees (sub goes sleeping/stopped/errored), the next
//     queued sub's runAgent fires.
//   • The pool is shared across all parent chats (round-robin parent
//     selection) so one chatty parent can't monopolize.
//
// Inbox semantics:
//   • Messages sent to a *running* sub are appended to chat.messages as a
//     synthetic user message immediately — the live runAgent loop picks
//     them up on its next turn.
//   • Messages sent to a *sleeping* sub queue in `inbox` and are drained
//     into a single combined user message on wake.
//   • Reports sent to a parent are NOT queued — they land directly in the
//     parent chat's messages as a `sub_report` row (a new message role,
//     rendered as a styled callout). Parent reads them as transcript
//     history; the spawn handle carries the structured payload.
// =============================================================

// ---------- Constants ----------

var SUBAGENT_POOL_SIZE          = 2;
var SUBAGENT_DEFAULT_MAX_TOOLS  = 200;
var SUBAGENT_DEFAULT_SUMMARY_KB = 4;
var SUBAGENT_MAX_ARTIFACTS      = 32;
// Soft cap on the inbox queue (sleeping sub). Older messages are dropped
// with a synthetic marker so a noisy parent/sibling can't grow the inbox
// without bound (every push persists to IDB).
var SUBAGENT_INBOX_CAP          = 50;
// Sweep frequency for the tombstone-GC pass (stopped/errored subs are
// kept SUBAGENT_TOMBSTONE_TTL_MS so the UI can show last_report, then
// deleted).
var SUBAGENT_IDLE_SWEEP_MS      = 60 * 1000;        // sweep frequency
// Settled-sub records GC: stopped/errored subs are kept around for this
// long so the UI can show "last_report" and the user can inspect the
// chat. After the grace period the record is deleted from IDB.
var SUBAGENT_TOMBSTONE_TTL_MS   = 60 * 60 * 1000; // 1h

// Default-denied nested-delegation tools. Sub-agents cannot spawn /
// stop / wake other subs unless the caller passes `allow_nested:true`
// at spawn time. Spec §8.4 "fork-bomb prevention" + Phase 5 ACL hardening.
var SUBAGENT_NESTED_DELEGATION_TOOLS = ['spawn_sub_agent', 'stop_sub_agent', 'wake_sub_agent'];
// Maximum allowed nesting depth. Hard ceiling on tree depth, independent of
// per-sub `max_tool_calls` budgets. Default 5 levels (root → 5 descendants).
var SUBAGENT_MAX_DEPTH = 5;

// ---------- Sub-agent preamble (appended to parent system prompt) ----------
// Used by src/js/core/110-system-prompt.js when the active chat is a sub-agent.
// Keep this short — every sub spends tokens on it.
var SUB_AGENT_PREAMBLE = [
    '',
    '------',
    '',
    'YOU ARE A SUB-AGENT.',
    '',
    'You were spawned by a parent agent to do focused, context-heavy work without polluting the parent\'s context window. Your task is in the first user message.',
    '',
    'CRITICAL RULES for sub-agents:',
    '  • DO NOT echo raw tool outputs back to the parent. Summarize.',
    '  • When the work is complete, call `report_to_parent` with a concise distilled result (≤ 4 KB summary). This is what the parent sees — it never reads your transcript.',
    '  • If you need parent input mid-task, call `report_to_parent({status:"need_input", ...})`. That settles the parent\'s handle and parks you — the parent will wake you with new instructions.',
    '  • If you are idle and waiting, call `sleep_self` to free the worker pool slot.',
    '  • Use `artifacts: [doc_id, file_id, ...]` in your report for larger payloads — never inline a long list/dump into `summary`.',
    '  • Do NOT spawn nested sub-agents unless explicitly authorized — `spawn_sub_agent`, `stop_sub_agent`, and `wake_sub_agent` are denied by default. The parent must pass `allow_nested:true` at spawn time to grant nested delegation.',
    '  • You may only `stop`/`wake`/`message` sub-agents that are your own descendants (the ACL is enforced server-side; calls against siblings or ancestors fail).',
    '',
    'The parent agent is awaiting your `report_to_parent` call to unblock its own work. Be focused, be brief, and return early with `status:done` once the task is genuinely complete.'
].join('\n');

// ---------- Module state ----------

// In-memory mirror of the IDB store. Keyed by agent_id. Single source of
// truth during a session; persisted to IDB on every mutation.
var _subAgents = Object.create(null);

// Worker pool: { running: Set<agent_id>, queue: agent_id[] }. running tracks
// which subs currently have an active runAgent loop. queue holds subs whose
// records were created but who haven't been started yet because the pool was
// full at spawn time.
var _subPool = { running: Object.create(null), queue: [] };

// Listeners notified on any sub-agent state change. UI components register
// here to re-render the Workers strip / sidebar breadcrumb.
var _subAgentListeners = [];

// ---------- Persistence ----------

function _subAgentsPersist(record) {
    if (typeof openDatabase !== 'function') return Promise.resolve();
    return openDatabase().then(function(database) {
        try {
            var tx = database.transaction(['sub_agents'], 'readwrite');
            tx.objectStore('sub_agents').put(record);
        } catch (e) { /* non-fatal */ }
    }).catch(function() { /* non-fatal */ });
}

function _subAgentsDeleteFromDB(agentId) {
    if (typeof openDatabase !== 'function') return Promise.resolve();
    return openDatabase().then(function(database) {
        try {
            var tx = database.transaction(['sub_agents'], 'readwrite');
            tx.objectStore('sub_agents').delete(agentId);
        } catch (e) { /* non-fatal */ }
    }).catch(function() { /* non-fatal */ });
}

async function loadAllSubAgents() {
    // Called at boot from src/js/core/120-init.js. Drains the IDB store
    // into the in-memory map AND restarts the pool for any sub that was
    // `running` at crash time.
    if (typeof openDatabase !== 'function') return;
    try {
        var database = await openDatabase();
        var tx = database.transaction(['sub_agents'], 'readonly');
        var req = tx.objectStore('sub_agents').getAll();
        await new Promise(function(resolve) {
            req.onsuccess = function() {
                var list = req.result || [];
                var now = Date.now();
                list.forEach(function(rec) {
                    // GC tombstoned records past TTL.
                    if ((rec.state === 'stopped' || rec.state === 'errored')
                        && rec.settled_at && (now - rec.settled_at) > SUBAGENT_TOMBSTONE_TTL_MS) {
                        _subAgentsDeleteFromDB(rec.agent_id);
                        return;
                    }
                    // Backfill Phase-5 fields for records persisted before this
                    // upgrade. A legacy record has no `depth` / `root_chat_id`.
                    // Conservatively assume depth=1 (top-level) and root = parent
                    // chat — there were no nested subs in pre-Phase-5 builds, so
                    // this is correct for every legacy record.
                    if (rec.depth == null)         rec.depth = 1;
                    if (rec.root_chat_id == null)  rec.root_chat_id = rec.parent_chat_id;
                    _subAgents[rec.agent_id] = rec;
                });
                resolve();
            };
            req.onerror = function() { resolve(); };
        });
        // Pre-offscreen architecture: any sub with state:'running' at reload was
        // orphaned because the handle map was in-memory and wiped. We marked them
        // errored so the parent's await_handle didn't hang on a vanished handle.
        //
        // Offscreen-host architecture (current): the agent loop runs in the SW
        // (sw-bundle.js, imported by background.js), which survives page reload.
        // Subs marked 'running' in IDB really ARE still running there, and their
        // spawn handles are still pending. The PAGE bundle running loadAll() must
        // NOT rewrite them — that lies about sub state in the workers strip and
        // races IDB writes with the SW's own persistence. Only the worker-runtime
        // copy of loadAll() is authorized to perform the orphan-rewrite (and only
        // on a true cold start, which it can detect via its own pool state).
        //
        // Gate: Platform.isWorker is set to true exclusively in
        // src/js/worker/000-runtime-globals.js (the first file of sw-bundle.js)
        // and is never defined in the page bundle. Same flag used by
        // 010-llm-streaming.js / 020-tool-execution.js / 140-skills-engine.js.
        var _isWorkerCtx = (typeof Platform !== 'undefined' && Platform.isWorker === true);
        if (_isWorkerCtx) {
            for (var aid in _subAgents) {
                var r = _subAgents[aid];
                if (r.state === 'running') {
                    r.state = 'errored';
                    r.settled_at = Date.now();
                    r.last_report = r.last_report || {
                        status: 'error',
                        summary: 'sub-agent orphaned by offscreen restart before completion',
                        from: r.agent_id,
                        from_name: r.name,
                        at: r.settled_at,
                        _orphaned: true
                    };
                    _subAgentsPersist(r);
                }
            }
        }
    } catch (e) { /* non-fatal */ }
    // Kick off the idle/tombstone sweeper now that the registry is loaded.
    _startIdleSweep();
}

// ---------- Pool ----------

function _poolSlotsFree() {
    var n = 0;
    for (var _k in _subPool.running) n++;
    return SUBAGENT_POOL_SIZE - n;
}

function _drainPool() {
    // Pull subs off the queue until either the queue is empty or no slots
    // remain. Each started sub kicks runAgent on its chat. runAgent is
    // expected to be a globally-available function from the agent-loop
    // module — guard the call so this file can be loaded in a context
    // where runAgent hasn't been defined yet (e.g. early boot, tests).
    //
    // Iterate with an index (not shift()) so we can SKIP subs whose
    // runAgent loop is still in flight on the same chat (wake-during-finish
    // race) without losing them. Without this, _drainPool claims a pool
    // slot, calls runAgent, runAgent early-returns because runningChatIds
    // is set, and the slot is leaked until the OLD loop finally yields.
    var i = 0;
    while (i < _subPool.queue.length && _poolSlotsFree() > 0) {
        var aid = _subPool.queue[i];
        var rec = _subAgents[aid];
        if (!rec) { _subPool.queue.splice(i, 1); continue; }
        if (rec.state !== 'running') { _subPool.queue.splice(i, 1); continue; }
        // A previous runAgent for this chat is still wrapping up (e.g.
        // sleep_self just yielded but the loop hasn't reached its finish
        // hook yet). Leave the sub in the queue — when the old loop calls
        // onSubAgentRunFinished → _releasePoolSlot → _drainPool, we'll
        // retry.
        if (typeof runningChatIds !== 'undefined' && runningChatIds[rec.chat_id]) {
            i++;
            continue;
        }
        _subPool.queue.splice(i, 1);
        _subPool.running[aid] = true;
        try {
            if (typeof runAgent === 'function') {
                // Fire-and-forget. The agent loop is its own driver; we just
                // need to make sure it starts. Slot release happens when
                // the sub goes sleeping/stopped/errored (see _releasePoolSlot).
                // CRITICAL: runAgent is async — wrap in Promise.resolve so an
                // async rejection also marks the sub errored and frees the slot.
                // Without this, an async throw inside the loop leaks the pool
                // slot AND leaves the spawn handle pending forever.
                var capturedAid = aid;
                Promise.resolve()
                    .then(function() { return runAgent(rec.chat_id); })
                    .catch(function(err) {
                        _markErrored(capturedAid, 'agent loop crashed: ' + (err && err.message || err));
                    });
            }
        } catch (e) {
            // Loop failed to start synchronously — release the slot and mark errored.
            delete _subPool.running[aid];
            _markErrored(aid, 'pool-start failed: ' + (e && e.message || e));
        }
        // Note: do NOT increment `i` after a successful claim — splice(i, 1)
        // already shifted the next item into position i.
    }
    _notifyListeners();
}

function _releasePoolSlot(agentId) {
    if (_subPool.running[agentId]) {
        delete _subPool.running[agentId];
        _drainPool();
    }
}

// ---------- Tombstone GC sweep ----------
// Runs every SUBAGENT_IDLE_SWEEP_MS while the registry is loaded. Tombstoned
// (stopped/errored) subs past SUBAGENT_TOMBSTONE_TTL_MS are deleted (record
// + background chat row). Previously this only ran at boot, so a long-lived
// tab leaked records indefinitely.

var _idleSweepInterval = null;

function _idleSweepTick() {
    var now = Date.now();
    for (var aid in _subAgents) {
        var r = _subAgents[aid];
        if (!r) continue;
        // GC tombstones first.
        if ((r.state === 'stopped' || r.state === 'errored')
            && r.settled_at && (now - r.settled_at) > SUBAGENT_TOMBSTONE_TTL_MS) {
            // Skip GC if the user is currently viewing this sub's transcript —
            // otherwise the chat row gets ripped out from under them and the
            // message list goes blank. Defer to the next sweep.
            if (typeof currentChatId !== 'undefined' && currentChatId === r.chat_id) {
                continue;
            }
            // Also delete the sub's chat record. Previously only the sub-agent
            // record was GC'd, leaving the background chat row in `chats` and
            // IDB. On long-lived tabs / restored profiles these accumulated
            // indefinitely (hidden because isBackground=true) and slowed every
            // chat-list enumeration.
            try {
                if (typeof chats !== 'undefined' && r.chat_id && chats[r.chat_id]) {
                    delete chats[r.chat_id];
                    if (typeof deleteChatFromDB === 'function') deleteChatFromDB(r.chat_id);
                    else if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
                }
            } catch (e) { console.warn('subAgent GC: failed to delete chat row', r.chat_id, e); }
            delete _subAgents[aid];
            try { _subAgentsDeleteFromDB(aid); } catch (e) { console.warn('subAgent GC: failed to delete record', aid, e); }
        }
    }
    _notifyListeners();
}

function _startIdleSweep() {
    if (_idleSweepInterval) return;
    if (typeof setInterval !== 'function') return; // headless / build context
    _idleSweepInterval = setInterval(function() {
        try { _idleSweepTick(); } catch (_) { /* never crash the sweep */ }
    }, SUBAGENT_IDLE_SWEEP_MS);
}

// ---------- Listeners (UI hookpoint) ----------

function _notifyListeners() {
    for (var i = 0; i < _subAgentListeners.length; i++) {
        try { _subAgentListeners[i](); } catch (_) { /* ignore */ }
    }
}

function addSubAgentListener(fn) {
    if (typeof fn !== 'function') return;
    _subAgentListeners.push(fn);
    // Late-binding safety: if the UI module loaded after a sub-agent had
    // already been spawned (file-ordering accident, or the registry was
    // restored from IDB before the UI rendered), `_notifyListeners` will
    // have fired into an empty listener set and the new listener would
    // miss every existing record. Fire once on attach so the freshly
    // attached listener gets to do its initial paint against current
    // state. Wrap in try so a buggy listener can't poison the rest of
    // the registry boot.
    try { fn(); } catch (_) { /* listener handles its own errors */ }
}

function removeSubAgentListener(fn) {
    _subAgentListeners = _subAgentListeners.filter(function(f) { return f !== fn; });
}

// Full-replace mirror update for the page bundle. The SW is the authority
// for sub-agent state; the page is a pure read-only mirror used by the
// workers strip + chat list. The SW broadcasts a `subagent-snapshot`
// envelope (see src/js/worker/105-subagent-broadcast.js) on every notify,
// and the page bridge (src/js/app/045-agent-port-bridge-page.js) routes it
// here. Full-replace is correct because no page-side mutation paths exist.
function applySubAgentSnapshot(records) {
    var next = Object.create(null);
    if (records && records.length) {
        for (var i = 0; i < records.length; i++) {
            var rec = records[i];
            if (rec && rec.agent_id) next[rec.agent_id] = rec;
        }
    }
    _subAgents = next;
    _notifyListeners();
}

// ---------- ID helpers ----------

function _newAgentId() {
    return 'sub_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
}

function _newSubChatId() {
    return 'chat_sub_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
}

// ---------- Tool roster computation ----------
// Apply allow/deny on top of the parent's allowed tools. Sub-only tools
// (`report_to_parent`, `sleep_self`, `agent_message`) are always injected.

var SUB_ONLY_TOOLS = ['report_to_parent', 'sleep_self', 'agent_message'];

function _computeToolRoster(allowNested) {
    // Subs inherit the parent's full tool roster. The only filter is the
    // nested-delegation gate: spawn/stop/wake_sub_agent are denied unless
    // the caller passed `allow_nested:true` at spawn time. This keeps the
    // sub's tools-cache slot byte-identical across every default spawn in
    // a session (no per-sub whitelist churn), so Anthropic's prompt cache
    // reuses it.
    var allNames = [];
    if (typeof TOOLS !== 'undefined' && Array.isArray(TOOLS)) {
        for (var i = 0; i < TOOLS.length; i++) {
            if (TOOLS[i] && TOOLS[i].function && TOOLS[i].function.name) {
                allNames.push(TOOLS[i].function.name);
            }
        }
    }
    // Include any active-skill tools so a sub spawned from a chat that has
    // a skill loaded can still use those tools. Defensive guard if the
    // skill subsystem hasn't loaded.
    try {
        if (typeof getActiveSkillTools === 'function') {
            var skillTools = getActiveSkillTools() || [];
            for (var si = 0; si < skillTools.length; si++) {
                var sName = skillTools[si] && skillTools[si].function && skillTools[si].function.name;
                if (sName && allNames.indexOf(sName) === -1) allNames.push(sName);
            }
        }
    } catch (_) { /* skill subsystem unavailable — fall through */ }

    var denySet = Object.create(null);
    if (!allowNested) {
        for (var di = 0; di < SUBAGENT_NESTED_DELEGATION_TOOLS.length; di++) {
            denySet[SUBAGENT_NESTED_DELEGATION_TOOLS[di]] = true;
        }
    }

    var out = [];
    for (var j = 0; j < allNames.length; j++) {
        var n = allNames[j];
        if (denySet[n]) continue;
        out.push(n);
    }
    // Always inject sub-only tools (how the sub talks back to the parent
    // and parks itself). Position-stable: append at end — they're not in
    // the parent's TOOLS list so adding them here doesn't perturb order.
    for (var k = 0; k < SUB_ONLY_TOOLS.length; k++) {
        if (out.indexOf(SUB_ONLY_TOOLS[k]) === -1) out.push(SUB_ONLY_TOOLS[k]);
    }
    return out;
}

// ---------- Core API: spawn ----------

function spawnSubAgent(args, ctx) {
    // ctx provides the parent chatId. Falls back to the streaming chat
    // (so a sub-agent calling spawn_sub_agent, if allowed, gets correct
    // parentage even when js_eval is the immediate caller).
    args = args || {};
    var parentChatId = (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    if (!parentChatId) {
        return { success: false, error: 'spawn_sub_agent: no parent chat context' };
    }
    var instructions = args.instructions;
    if (!instructions || typeof instructions !== 'string') {
        return { success: false, error: 'spawn_sub_agent: `instructions` is required (string).' };
    }

    var agent_id = _newAgentId();
    var chat_id  = _newSubChatId();

    // Determine if the *spawner* is itself a sub-agent — used for
    // breadcrumbing and to enforce the no-nested-spawn default.
    var parentAgentId = null;
    if (typeof chats !== 'undefined' && chats[parentChatId] && chats[parentChatId].isSubAgent) {
        parentAgentId = chats[parentChatId].subAgentId || null;
    }

    // Compute tree-position metadata (Phase 5). For a top-level sub spawned by
    // a regular chat: depth=1, root_chat_id = parent_chat_id. For a nested sub:
    // inherit depth+1 and root_chat_id from the spawning sub's record.
    var depth = 1;
    var rootChatId = parentChatId;
    if (parentAgentId) {
        var parentRec = _subAgents[parentAgentId];
        if (parentRec) {
            depth = (parentRec.depth || 1) + 1;
            rootChatId = parentRec.root_chat_id || parentRec.parent_chat_id;
        }
    }
    if (depth > SUBAGENT_MAX_DEPTH) {
        return { success: false, error: 'spawn_sub_agent: nesting depth ' + depth + ' exceeds SUBAGENT_MAX_DEPTH (' + SUBAGENT_MAX_DEPTH + '). Refusing to spawn — if you genuinely need deeper trees, raise the constant.' };
    }

    var toolRoster = _computeToolRoster(args.allow_nested === true);

    // Allocate the spawn handle now. The agent loop / report_to_parent will
    // settle it later. The handle is owned by the PARENT chat (so the
    // parent's await_handle finds it in its own bucket).
    if (typeof Handles === 'undefined') {
        return { success: false, error: 'spawn_sub_agent: Handle registry unavailable.' };
    }
    var displayName = 'spawn_sub_agent: ' + (args.name || (instructions.slice(0, 40) + '…'));
    // We use Handles.start with a runFn that simply waits for a deferred
    // promise the registry exposes — i.e. the handle resolves out-of-band
    // from report_to_parent / stop_sub_agent. The "runFn" never throws on
    // its own; settlement is push-driven via _resolveSpawnHandle.
    var _spawnDeferred = _makeDeferred();
    var started = Handles.start(parentChatId, 'spawn_sub_agent', args, displayName, function() {
        return _spawnDeferred.promise;
    });
    var spawn_handle_id = started.handleId;

    var now = Date.now();
    var record = {
        agent_id: agent_id,
        chat_id: chat_id,
        parent_chat_id: parentChatId,
        parent_agent_id: parentAgentId,
        depth: depth,
        root_chat_id: rootChatId,
        name: args.name || ('sub_' + agent_id.slice(-6)),
        state: 'running',
        spawn_args: args,
        spawn_handle_id: spawn_handle_id,
        tool_roster: toolRoster,
        auto_report: (args.auto_report === false) ? false : true,
        max_tool_calls: (typeof args.max_tool_calls === 'number' && args.max_tool_calls > 0)
            ? Math.floor(args.max_tool_calls) : SUBAGENT_DEFAULT_MAX_TOOLS,
        summary_cap_bytes: SUBAGENT_DEFAULT_SUMMARY_KB * 1024,
        created_at: now,
        last_activity_at: now,
        tool_calls_used: 0,
        last_report: null,
        inbox: [],
        pending_handles: [spawn_handle_id],
        settled_at: null
    };
    _subAgents[agent_id] = record;
    // Store deferred outside the persisted record (functions aren't IDB-safe).
    _spawnDeferreds[spawn_handle_id] = _spawnDeferred;
    _subAgentsPersist(record);

    // Create the sub's chat. The agent loop reads `chats[chatId]` so this
    // must exist before runAgent fires. We mark it isBackground so it
    // doesn't pop into the foreground UI, AND isSubAgent so the system
    // prompt module appends the preamble.
    if (typeof chats === 'undefined') {
        return { success: false, error: 'spawn_sub_agent: chats map unavailable.' };
    }
    chats[chat_id] = {
        id: chat_id,
        title: record.name,
        messages: [],
        createdAt: now,
        updatedAt: now,
        isBackground: true,
        isSubAgent: true,
        subAgentId: agent_id,
        parentChatId: parentChatId,
        // sub-agents don't inherit the parent's pause state; they manage
        // their own lifecycle via sleep_self / wake_sub_agent / stop_sub_agent.
    };

    // First user message = the task + optional context seed. Wrap in tags
    // for clarity (the model parses these reliably).
    var firstMsg = '<task>\n' + instructions + '\n</task>';
    if (args.context_seed != null) {
        var seedStr;
        try { seedStr = (typeof args.context_seed === 'string') ? args.context_seed : JSON.stringify(args.context_seed, null, 2); }
        catch (e) { seedStr = String(args.context_seed); }
        firstMsg += '\n\n<context_seed>\n' + seedStr + '\n</context_seed>';
    }
    chats[chat_id].messages.push({ role: 'user', content: firstMsg });
    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();

    // Queue for the pool. If there's a slot free, runAgent fires immediately.
    _subPool.queue.push(agent_id);
    _drainPool();

    return {
        success: true,
        agent_id: agent_id,
        chat_id: chat_id,
        handle: spawn_handle_id,
        note: 'Sub-agent spawned. Use `await_handle("' + spawn_handle_id + '")` to collect the result, or `agent_status` for live state.'
    };
}

// ---------- Spawn-handle settlement ----------
// The spawn handle resolves when the sub reports done/error, is stopped,
// or exhausts its tool budget. We use a per-handle deferred (in-memory
// only — handles themselves are in-memory per spec §8.3) so the resolution
// is push-driven.

var _spawnDeferreds = Object.create(null);

// ---------- Tree-walk helpers (Phase 5 — nested delegation) ----------

// Walk the parent_agent_id chain from `agentId` upward. Returns an array of
// agent_ids (oldest → self). Cycle-safe (max SUBAGENT_MAX_DEPTH iterations).
function _ancestorChain(agentId) {
    var out = [];
    var seen = Object.create(null);
    var cur = agentId;
    for (var i = 0; i < SUBAGENT_MAX_DEPTH + 2 && cur; i++) {
        if (seen[cur]) break; // cycle guard
        seen[cur] = true;
        out.unshift(cur);
        var rec = _subAgents[cur];
        cur = rec && rec.parent_agent_id;
    }
    return out;
}

// Direct children of `agentId`.
function _children(agentId) {
    var out = [];
    for (var aid in _subAgents) {
        if (_subAgents[aid].parent_agent_id === agentId) out.push(aid);
    }
    return out;
}

// All descendants of `agentId` (DFS, deepest first — useful for cascade-stop
// so we settle leaves before their parents). Cycle-safe via depth cap.
function _descendants(agentId) {
    var out = [];
    var stack = _children(agentId).slice();
    var seen = Object.create(null);
    while (stack.length) {
        var cur = stack.pop();
        if (seen[cur]) continue;
        seen[cur] = true;
        out.push(cur);
        var kids = _children(cur);
        for (var i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    // Deepest first (leaves before internal nodes). _children does breadth
    // order; we want depth ordering for cascade-stop. Sort by depth desc.
    out.sort(function(a, b) {
        var da = (_subAgents[a] && _subAgents[a].depth) || 0;
        var db = (_subAgents[b] && _subAgents[b].depth) || 0;
        return db - da;
    });
    return out;
}

// ACL: is `callerAgentId` an ancestor of `targetAgentId`? Used to gate
// stop / wake / message so a sub can only touch its own subtree.
// `callerAgentId = null` (i.e. caller is the human parent chat) is allowed
// iff target's root_chat_id === callerChatId.
function _callerOwnsTarget(callerChatId, callerAgentId, targetRec) {
    if (!targetRec) return false;
    if (callerAgentId) {
        // Sub caller: target must be a strict descendant of caller.
        var chain = _ancestorChain(targetRec.agent_id);
        // chain includes targetRec.agent_id at the end — caller must appear
        // strictly before it.
        for (var i = 0; i < chain.length - 1; i++) {
            if (chain[i] === callerAgentId) return true;
        }
        return false;
    }
    // Top-level (non-sub) caller: must own the root chat.
    return (targetRec.root_chat_id === callerChatId)
        || (targetRec.parent_chat_id === callerChatId);
}

function _makeDeferred() {
    var resolve, reject;
    var p = new Promise(function(res, rej) { resolve = res; reject = rej; });
    return { promise: p, resolve: resolve, reject: reject };
}

function _resolveSpawnHandle(agentId, payload) {
    var rec = _subAgents[agentId];
    if (!rec) return;
    var hid = rec.spawn_handle_id;
    var d = _spawnDeferreds[hid];
    if (!d) return; // already resolved
    delete _spawnDeferreds[hid];
    // Prune the spawn handle from rec.pending_handles. Subs are initialized
    // with pending_handles:[spawn_handle_id] and that entry was never being
    // cleared on settlement — so agent_status() kept returning
    // pending_handles:1 forever on settled subs, which looked like a leak
    // ("sub is sleeping but still has 1 pending handle?"). The handle IS
    // settled at this point (we just resolved the deferred), so the rec
    // should reflect that.
    if (Array.isArray(rec.pending_handles)) {
        var _phIdx = rec.pending_handles.indexOf(hid);
        if (_phIdx >= 0) rec.pending_handles.splice(_phIdx, 1);
    }
    // Map the report's logical status onto the outer handle's lifecycle
    // status so the parent's `await_handle` snapshot is self-describing.
    // Without these branches the handle would always settle as `done`
    // (success) even when the embedded report was a crash, which was easy
    // for callers to miss — `if (snap.status==='done') useResult` would
    // happily consume an error report.
    //
    //   cancelled  → Handles.cancel — snapshot.status='cancelled', error=reason
    //   error      → Handles.errorWith — snapshot.status='error',
    //                  error=summary, result=full payload
    //   done/need_input → plain d.resolve — snapshot.status='done',
    //                  result=payload (status field carries done|need_input)
    //
    // The .then guard in Handles._startHandle (status !== 'pending' check)
    // preserves the pre-settled state when the deferred eventually resolves.
    if (payload && payload.status === 'cancelled') {
        if (typeof Handles !== 'undefined' && Handles.cancel) {
            try {
                Handles.cancel(rec.parent_chat_id, hid,
                    (payload.summary || payload.error || 'sub-agent stopped'));
            } catch (_) { /* ignore — best effort */ }
        }
    } else if (payload && payload.status === 'error') {
        if (typeof Handles !== 'undefined' && Handles.errorWith) {
            try {
                Handles.errorWith(rec.parent_chat_id, hid,
                    (payload.summary || payload.error || 'sub-agent reported error'),
                    payload);
            } catch (_) { /* ignore — best effort */ }
        }
    }
    d.resolve(payload);
}

// ---------- report_to_parent ----------

function reportToParent(args, ctx) {
    args = args || {};
    var subChatId = (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    if (!subChatId || typeof chats === 'undefined' || !chats[subChatId] || !chats[subChatId].isSubAgent) {
        return { success: false, error: 'report_to_parent can only be called from inside a sub-agent chat.' };
    }
    var rec = _subAgents[chats[subChatId].subAgentId];
    if (!rec) {
        return { success: false, error: 'report_to_parent: sub-agent record missing.' };
    }

    var status = args.status;
    // `status` is informational only — every call settles the handle and parks
    // the sub. We still validate the enum so the UI badge has a known value.
    // `partial` is no longer accepted (use agent_message(to:"parent") for
    // mid-flight updates that should NOT settle the handle).
    if (['done', 'error', 'need_input'].indexOf(status) === -1) {
        return { success: false, error: 'report_to_parent: `status` must be one of done|error|need_input. For mid-flight updates that should not settle the handle, use agent_message(to:"parent").' };
    }
    if (rec.state === 'stopped' || rec.state === 'errored') {
        return { success: false, error: 'report_to_parent: sub is already terminal (' + rec.state + '); cannot report again.', already_settled: true };
    }
    var summary = String(args.summary || '');
    if (summary.length > rec.summary_cap_bytes) {
        // Soft-truncate with marker so the parent still sees a usable report.
        summary = summary.slice(0, rec.summary_cap_bytes - 100) + '\n…[truncated by registry: summary exceeded ' + rec.summary_cap_bytes + ' bytes]';
    }
    var artifacts = Array.isArray(args.artifacts) ? args.artifacts.slice(0, SUBAGENT_MAX_ARTIFACTS) : [];
    var data = (args.data && typeof args.data === 'object') ? args.data : null;

    var report = {
        status: status,
        summary: summary,
        data: data,
        artifacts: artifacts,
        from: rec.agent_id,
        from_name: rec.name,
        at: Date.now()
    };
    rec.last_report = report;
    rec.last_activity_at = Date.now();
    _subAgentsPersist(rec);

    // Push a styled callout row into the parent chat so the human reading
    // the parent transcript can see the report inline.
    if (chats[rec.parent_chat_id]) {
        // subChatId is persisted on the message so the UI "open transcript →"
        // link keeps working even after the registry GCs the settled
        // sub-agent record (SUBAGENT_TOMBSTONE_TTL_MS, ~1h). Without it the
        // link silently disappears from every historical sub_report row.
        chats[rec.parent_chat_id].messages.push({
            role: 'sub_report',
            subAgentId: rec.agent_id,
            subAgentName: rec.name,
            subChatId: rec.chat_id,
            report: report,
            createdAt: report.at
        });
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        // Re-render the parent chat if it's currently in view.
        try {
            if (typeof currentChatId !== 'undefined' && currentChatId === rec.parent_chat_id
                && typeof renderMessages === 'function') {
                renderMessages();
            }
        } catch (_) { /* ignore */ }
        // Also emit an agent event so background subscribers / other tabs
        // know the parent chat has new content.
        try {
            if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
                AgentEvents.emit('messageAppended', { chatId: rec.parent_chat_id, force: true });
            }
        } catch (_) { /* ignore */ }
    }

    // Every report settles the spawn handle (if still pending) and parks the
    // sub. _resolveSpawnHandle is a no-op on subsequent calls after a wake
    // (the deferred is consumed on first resolution). The status field is
    // carried in the payload so the parent's await_handle snapshot reflects
    // what the sub said.
    _resolveSpawnHandle(rec.agent_id, {
        status: status,
        summary: summary,
        data: data,
        artifacts: artifacts,
        from: rec.agent_id
    });
    _parkSubAgent(rec);
    _notifyListeners();
    return { success: true, ok: true };
}

// After any report_to_parent (or a bare sleep_self), a sub becomes dormant:
// state=sleeping, pool slot released, loop paused. Terminating a sub is a
// separate operation (stop_sub_agent) — there is no "stop" idle policy.
// No-ops on already-terminal subs (stopped/errored) so we don't clobber a
// crashed sub's state with 'sleeping' on the auto_report tail.
function _parkSubAgent(rec) {
    if (rec.state === 'stopped' || rec.state === 'errored') {
        if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
        _releasePoolSlot(rec.agent_id);
        _subAgentsPersist(rec);
        return;
    }
    rec.state = 'sleeping';
    if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
    _releasePoolSlot(rec.agent_id);
    _subAgentsPersist(rec);
}

// ---------- sleep_self / wake_sub_agent ----------

function sleepSelf(args, ctx) {
    args = args || {};
    var subChatId = (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    if (!subChatId || typeof chats === 'undefined' || !chats[subChatId] || !chats[subChatId].isSubAgent) {
        return { success: false, error: 'sleep_self can only be called from inside a sub-agent chat.' };
    }
    var rec = _subAgents[chats[subChatId].subAgentId];
    if (!rec) return { success: false, error: 'sleep_self: record missing.' };
    if (rec.state === 'stopped' || rec.state === 'errored') {
        return { success: false, error: 'sleep_self: sub is already terminal (' + rec.state + ').' };
    }
    rec.state = 'sleeping';
    rec.last_activity_at = Date.now();
    if (args.reason) rec.last_sleep_reason = String(args.reason).slice(0, 200);
    // Signal the in-flight agent loop to stop after the current turn by
    // mirroring the action-engine's pause pattern: set pausedChats so
    // the loop yields at its next pause check. Without this, the loop
    // would just keep running until naturally done.
    if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
    // If the spawn handle is still pending (sub called sleep_self WITHOUT
    // first calling report_to_parent), settle it now with a synthetic
    // need_input status. Without this, the parent's await_handle hangs
    // indefinitely while the sub sits dormant.
    if (_spawnDeferreds[rec.spawn_handle_id]) {
        var _reason = (args.reason ? String(args.reason).slice(0, 200) : 'sub-agent parked via sleep_self without report_to_parent');
        rec.last_report = rec.last_report || {
            status: 'need_input',
            summary: _reason,
            from: rec.agent_id,
            from_name: rec.name,
            at: Date.now(),
            _synthesized: true
        };
        _resolveSpawnHandle(rec.agent_id, {
            status: rec.last_report.status,
            summary: rec.last_report.summary,
            from: rec.agent_id,
            _synthesized: true
        });
    }
    _subAgentsPersist(rec);
    _releasePoolSlot(rec.agent_id);
    _notifyListeners();
    return { success: true, ok: true, state: 'sleeping' };
}

function wakeSubAgent(args, ctx) {
    return _wakeSubAgentImpl(args, ctx, false);
}

// Internal cascade entry point — used by agentMessage's auto-wake. The third
// arg (`isInternalCascade`) is a positional flag the model cannot reach: it
// is NEVER read from the user-facing tool args. The previous design read a
// `_internal_cascade` flag off `args`, but `args` comes verbatim from the
// model's tool call — so a hostile sub could pass `_internal_cascade: true`
// and bypass the subtree-ownership ACL entirely. Routing the flag through a
// distinct positional parameter closes that escalation.
function _wakeSubAgentImpl(args, ctx, isInternalCascade) {
    args = args || {};
    var rec = _subAgents[args.agent_id];
    if (!rec) return { success: false, error: 'wake_sub_agent: unknown agent_id ' + args.agent_id };
    if (rec.state === 'stopped' || rec.state === 'errored') {
        return { success: false, error: 'wake_sub_agent: cannot wake terminal sub (' + rec.state + ').' };
    }
    // ACL gate (Phase 5). Non-internal callers must own the subtree. The
    // gate is unconditional unless the caller is the registry itself.
    if (!isInternalCascade) {
        var _wakeCallerChatId = (ctx && ctx.chatId) || null;
        var _wakeCallerAgentId = (_wakeCallerChatId && typeof chats !== 'undefined'
            && chats[_wakeCallerChatId] && chats[_wakeCallerChatId].isSubAgent)
            ? chats[_wakeCallerChatId].subAgentId : null;
        if (_wakeCallerChatId && !_callerOwnsTarget(_wakeCallerChatId, _wakeCallerAgentId, rec)) {
            return { success: false, error: 'wake_sub_agent: ACL denied — caller does not own this sub-agent\'s subtree.', _acl_denied: true };
        }
    }
    // Honor the documented no-op-if-already-running contract. Without this,
    // calling wake on a live sub would clear pausedChats (potentially fighting
    // a legitimate user-pause), re-queue the loop, and drain the inbox into
    // an extra user message even though the live loop is already consuming it.
    if (rec.state === 'running' && !args.instruction && !(rec.inbox && rec.inbox.length)) {
        return { success: true, ok: true, state: 'running', note: 'already running' };
    }

    // If the wake carries an instruction, push it onto chat.messages.
    // Otherwise drain the inbox into a single combined message.
    var pendingMsgs = (rec.inbox || []).slice();
    rec.inbox = [];
    if (args.instruction) {
        pendingMsgs.push({ kind: 'instruction', from: 'parent', content: String(args.instruction), at: Date.now() });
    }
    if (pendingMsgs.length > 0 && chats[rec.chat_id]) {
        var combined = _formatInboxDrain(pendingMsgs);
        chats[rec.chat_id].messages.push({ role: 'user', content: combined });
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    }

    rec.state = 'running';
    rec.last_activity_at = Date.now();
    if (typeof pausedChats !== 'undefined') delete pausedChats[rec.chat_id];
    _subAgentsPersist(rec);

    // Re-queue. The pool will start runAgent if there's a slot.
    // Dedupe against the queue too — without this, repeated wakes (e.g. on
    // every inbox auto-wake from agent_message) would stack duplicates and
    // the pool drain could fire two loops on the same chat.
    if (!_subPool.running[rec.agent_id] && _subPool.queue.indexOf(rec.agent_id) === -1) {
        _subPool.queue.push(rec.agent_id);
    }
    _drainPool();

    // Mint a fresh spawn handle if the previous one already settled, so the
    // caller can `await_handle` the next report. For internal cascades (the
    // agentMessage auto-wake path) we still mint — the sub→parent agent_message
    // arm reads the new handle off the record and returns it on the parent's
    // call. Either way the parent ends up with an awaitable handle for the
    // resumed run, fixing the "wake_sub_agent returns no handle, must poll"
    // limitation.
    var newHandleId = _mintNewSpawnHandle(rec);
    _notifyListeners();
    return { success: true, ok: true, state: 'running', handle: newHandleId };
}

// Mint a fresh spawn handle for a sub that has already settled its previous
// handle (typical case: sub called report_to_parent, parent collected the
// result, parent now wakes the sub with a follow-up). Without this, the parent
// has no handle to `await_handle` on the next report — it would have to poll
// `agent_status` for `last_report` to change. Returns the new handle id, or
// the existing one if it's still pending (no need to mint a second one).
//
// Idempotent and side-effect-light: persists the updated record so a crash
// before the next report doesn't orphan the handle.
function _mintNewSpawnHandle(rec) {
    if (!rec) return null;
    // Existing handle still pending? Reuse it.
    if (_spawnDeferreds[rec.spawn_handle_id]) return rec.spawn_handle_id;
    if (typeof Handles === 'undefined' || !Handles.start) return rec.spawn_handle_id;
    var newDeferred = _makeDeferred();
    var displayName = 'spawn_sub_agent: ' + (rec.name || rec.agent_id) + ' (resumed)';
    var started = Handles.start(
        rec.parent_chat_id,
        'spawn_sub_agent',
        rec.spawn_args || {},
        displayName,
        function() { return newDeferred.promise; }
    );
    var newHid = started.handleId;
    _spawnDeferreds[newHid] = newDeferred;
    rec.spawn_handle_id = newHid;
    _subAgentsPersist(rec);
    return newHid;
}

function _formatInboxDrain(items) {
    var lines = ['[' + items.length + ' message(s) from parent / inbox]'];
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var label = it.kind === 'instruction' ? 'instruction' : (it.kind || 'message');
        lines.push('- (' + label + ') ' + (it.content || ''));
    }
    return lines.join('\n');
}

// ---------- agent_message ----------

function agentMessage(args, ctx) {
    args = args || {};
    var to = args.to;
    var content = String(args.content || '');
    if (!to || !content) {
        return { success: false, error: 'agent_message: `to` and `content` are required.' };
    }
    var fromChatId = (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    var fromIsSub = !!(typeof chats !== 'undefined' && chats[fromChatId] && chats[fromChatId].isSubAgent);

    // Resolve recipient. 'parent' from a sub means push to that sub's parent chat
    // (as a sub_report-lite — kind=status update, not terminal). Otherwise `to`
    // is an agent_id.
    if (to === 'parent') {
        if (!fromIsSub) return { success: false, error: 'agent_message: only sub-agents can send to "parent".' };
        var rec = _subAgents[chats[fromChatId].subAgentId];
        if (!rec) return { success: false, error: 'agent_message: sub record missing.' };
        if (chats[rec.parent_chat_id]) {
            // See terminal-report path above: subChatId is persisted on the
            // row so the "open transcript" link survives registry GC.
            chats[rec.parent_chat_id].messages.push({
                role: 'sub_report',
                subAgentId: rec.agent_id,
                subAgentName: rec.name,
                subChatId: rec.chat_id,
                report: { status: 'partial', summary: content, from: rec.agent_id, from_name: rec.name, at: Date.now() },
                createdAt: Date.now()
            });
            if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
            try {
                if (typeof currentChatId !== 'undefined' && currentChatId === rec.parent_chat_id
                    && typeof renderMessages === 'function') renderMessages();
            } catch (_) { /* ignore */ }
            // BUG FIX (live partial-report delivery): without this emit, the
            // sub_report row landed in chats[parent].messages and persisted to
            // storage, but the parent's UI only repainted on the next user-
            // driven render (e.g. when the user typed something). The terminal
            // report_to_parent path emits messageAppended for exactly this
            // reason — mirror it here so mid-flight updates stream live.
            try {
                if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
                    AgentEvents.emit('messageAppended', { chatId: rec.parent_chat_id, force: true });
                }
            } catch (_) { /* ignore */ }
        }
        rec.last_activity_at = Date.now();
        _subAgentsPersist(rec);
        _notifyListeners();
        return { success: true, ok: true };
    }

    // Recipient is a specific agent_id (parent → sub OR sibling → sibling
    // via the parent's authority).
    var dst = _subAgents[to];
    if (!dst) return { success: false, error: 'agent_message: unknown recipient agent_id ' + to };
    if (dst.state === 'stopped' || dst.state === 'errored') {
        return { success: false, error: 'agent_message: recipient is ' + dst.state + '.' };
    }
    // ACL gate (Phase 5). Caller may only message subs in its own subtree.
    var _msgCallerAgentId = fromIsSub ? chats[fromChatId].subAgentId : null;
    if (!_callerOwnsTarget(fromChatId, _msgCallerAgentId, dst)) {
        return { success: false, error: 'agent_message: ACL denied — caller does not own recipient\'s subtree.', _acl_denied: true };
    }

    var wake = (args.wake === false) ? false : true;
    var item = { kind: 'message', from: fromIsSub ? chats[fromChatId].subAgentId : 'parent', content: content, at: Date.now() };

    // Cap the inbox so a runaway parent/sibling can't OOM the registry.
    // Applies on the sleeping-recipient branch below. (For 'running'
    // recipients we push directly to chat.messages and the model context
    // window is the natural backstop.)
    if (dst.state === 'running') {
        // Sub is in `running` state, but the agent loop may or may not be
        // alive: it could be (a) actively running mid-turn (in _subPool.running
        // or with runningChatIds set), or (b) queued waiting for a pool slot.
        //
        // BUG FIX (Anthropic 400s): a naive push to chat.messages mid-turn
        // (when the last assistant emitted `tool_calls` and tool_result
        // placeholders are mid-execution) breaks Anthropic’s strict
        // assistant→tool_result alternation — the request 400s before the
        // sub can finish. Route through pendingInjectionsByChatId so the
        // running loop’s flushPendingInjection picks it up at a SAFE point
        // (post tool_result batch, pre next API call). For the queued /
        // queued/idle cases the loop isn’t running yet, so a direct
        // chat.messages push is fine.
        var live = !!(_subPool.running[dst.agent_id]
            || (typeof runningChatIds !== 'undefined' && runningChatIds[dst.chat_id]));
        var combined = _formatInboxDrain([item]);
        if (live) {
            // Merge with existing pending text if any (multiple agent_messages
            // arriving back-to-back coalesce into a single user turn).
            try {
                if (typeof pendingInjectionsByChatId !== 'undefined') {
                    var existing = pendingInjectionsByChatId[dst.chat_id];
                    var prevText = (existing && existing.text) ? existing.text + '\n\n' : '';
                    pendingInjectionsByChatId[dst.chat_id] = {
                        text: prevText + combined,
                        images: (existing && existing.images) ? existing.images : []
                    };
                }
            } catch (_) { /* fall through to direct push */ }
        } else {
            // No live loop — queued or idle. Direct push is safe.
            if (chats[dst.chat_id]) {
                chats[dst.chat_id].messages.push({ role: 'user', content: combined });
                if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
            }
        }
        // Always queue (dedup) so the pool starts a loop if none is running.
        // BUG FIX (message-drop race): previously the alreadyLive branch did NOT
        // queue. If the live loop happened to exit naturally between the
        // push and our queue check, onSubAgentRunFinished would auto_report
        // the old assistant text and the parent’s message would silently
        // disappear. Queuing here is harmless when alreadyLive (_drainPool
        // skips subs whose runningChatIds is set); when the loop later
        // releases the slot, drain picks up our entry and a fresh runAgent
        // sees the pendingInjection / unconsumed user message.
        if (!_subPool.running[dst.agent_id] && _subPool.queue.indexOf(dst.agent_id) === -1) {
            _subPool.queue.push(dst.agent_id);
        }
    } else {
        // Sleeping — enqueue. wake_sub_agent (or auto-wake below) drains it.
        dst.inbox = dst.inbox || [];
        dst.inbox.push(item);
        // Cap with oldest-dropped marker so the wake-drain stays bounded.
        if (dst.inbox.length > SUBAGENT_INBOX_CAP) {
            var dropCount = dst.inbox.length - SUBAGENT_INBOX_CAP + 1;
            dst.inbox = dst.inbox.slice(dropCount);
            dst.inbox.unshift({
                kind: 'dropped',
                from: 'registry',
                content: '[' + dropCount + ' earlier message(s) dropped — inbox cap (' + SUBAGENT_INBOX_CAP + ') reached]',
                at: Date.now()
            });
        }
    }
    dst.last_activity_at = Date.now();
    _subAgentsPersist(dst);

    var _newHandle = null;
    if (dst.state === 'sleeping' && wake) {
        // Auto-wake. Drain the inbox into a combined user message and
        // re-queue. We reuse wakeSubAgent so the bookkeeping is identical.
        // Internal auto-wake on inbox push — bypass ACL since we already
        // verified the caller owns the target above.
        var _wakeRes = _wakeSubAgentImpl({ agent_id: dst.agent_id }, ctx, true);
        // _wakeSubAgentImpl mints a fresh spawn handle if the previous one
        // had settled. Surface it so the parent's agent_message call returns
        // an awaitable handle for the resumed run — same convenience as
        // calling wake_sub_agent directly. If the previous handle is still
        // pending, we surface its id too so the caller has a single field
        // to await regardless of state.
        _newHandle = (_wakeRes && _wakeRes.handle) || dst.spawn_handle_id || null;
    } else if (dst.state === 'running') {
        _drainPool();
    }
    _notifyListeners();
    var out = { success: true, ok: true };
    if (_newHandle) out.handle = _newHandle;
    return out;
}

// ---------- stop_sub_agent ----------

function stopSubAgent(args, ctx) {
    return _stopSubAgentImpl(args, ctx, false);
}

// Internal cascade entry point — see _wakeSubAgentImpl above for the
// rationale. The positional `isInternalCascade` flag replaces the previous
// `args._internal_cascade` mechanism, which was reachable by the model.
function _stopSubAgentImpl(args, ctx, isInternalCascade) {
    args = args || {};
    var rec = _subAgents[args.agent_id];
    if (!rec) return { success: false, error: 'stop_sub_agent: unknown agent_id ' + args.agent_id };
    if (rec.state === 'stopped' || rec.state === 'errored') {
        return { success: true, ok: true, status: rec.state, note: 'already terminal' };
    }
    // ACL gate (Phase 5). A sub can only stop its own descendants; a regular
    // chat can only stop subs whose root_chat_id is itself.
    if (!isInternalCascade) {
        var _callerChatId = (ctx && ctx.chatId) || null;
        var _callerAgentId = (_callerChatId && typeof chats !== 'undefined'
            && chats[_callerChatId] && chats[_callerChatId].isSubAgent)
            ? chats[_callerChatId].subAgentId : null;
        if (_callerChatId && !_callerOwnsTarget(_callerChatId, _callerAgentId, rec)) {
            return { success: false, error: 'stop_sub_agent: ACL denied — caller does not own this sub-agent\'s subtree.', _acl_denied: true };
        }
    }
    // Cascade-stop descendants first (leaves before internal nodes via
    // _descendants ordering). Without this, grandchildren orphan when their
    // parent sub is stopped: they keep burning pool slots, their reports go
    // to a dead chat, and their handles never settle.
    var _kids = _descendants(rec.agent_id);
    for (var _ki = 0; _ki < _kids.length; _ki++) {
        var _kidRec = _subAgents[_kids[_ki]];
        if (!_kidRec || _kidRec.state === 'stopped' || _kidRec.state === 'errored') continue;
        try {
            _stopSubAgentImpl({
                agent_id: _kids[_ki],
                reason: 'parent sub-agent stopped: ' + (args.reason || rec.name)
            }, ctx, true);
        } catch (e) { console.warn('stop cascade: failed for', _kids[_ki], e); }
    }
    var reason = args.reason || 'stopped by parent';
    rec.state = 'stopped';
    rec.settled_at = Date.now();
    rec.last_activity_at = rec.settled_at;
    if (!rec.last_report) {
        rec.last_report = { status: 'error', summary: reason, from: rec.agent_id, from_name: rec.name, at: rec.settled_at };
    }
    _subAgentsPersist(rec);

    // Cancel every pending handle owned by the sub's chat. Previously this
    // iterated `rec.pending_handles`, which is initialized to [spawn_handle_id]
    // and never appended to — so the loop body's `continue` skipped the only
    // entry and no handle was ever cancelled. Background fetches / iframe
    // calls would survive stop_sub_agent and their results would still land
    // in the registry. The correct source of truth is the Handles registry
    // itself, scoped to the sub's chat id.
    if (typeof Handles !== 'undefined' && typeof Handles.list === 'function') {
        try {
            var live = Handles.list(rec.chat_id) || [];
            for (var i = 0; i < live.length; i++) {
                var h = live[i];
                if (!h || h.status !== 'pending') continue;
                if (h.handle === rec.spawn_handle_id) continue; // resolved separately, see below
                try { Handles.cancel(rec.chat_id, h.handle, reason); } catch (e) { console.warn('stop_sub_agent: cancel failed for', h.handle, e); }
            }
        } catch (e) { console.warn('stop_sub_agent: Handles.list failed', e); }
    }
    // Resolve the spawn handle with `cancelled`.
    _resolveSpawnHandle(rec.agent_id, { status: 'cancelled', summary: reason, from: rec.agent_id });

    // Signal the live runAgent loop to halt at its next pause check.
    if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
    _releasePoolSlot(rec.agent_id);
    _notifyListeners();
    return { success: true, ok: true, status: 'stopped', reason: reason };
}

// ---------- Pool-deadlock prevention (Phase 5) ----------
//
// A sub-agent that calls `await_handle` on a spawn handle for one of its
// own descendants will block its own runAgent loop while still occupying a
// pool slot. With pool size = 2, two concurrent nested awaits = global
// deadlock (no slot free for the grandchildren to actually start).
//
// The dispatch arm in tools/020-tool-execution.js calls `parkForAwait`
// before `Handles.await` and `unparkAfterAwait` after. Park releases the
// pool slot (kicking the drain so a queued sub can start) without changing
// the sub's state — from the UI's perspective the sub is still 'running',
// just temporarily blocked on I/O. Unpark re-admits to the pool, even if
// at-cap (soft over-cap), so the awaiting sub can immediately resume
// processing its tool result.
function parkForAwait(agentId) {
    var rec = _subAgents[agentId];
    if (!rec) return false;
    if (!_subPool.running[agentId]) return false; // not in pool, nothing to park
    delete _subPool.running[agentId];
    rec._parked_for_await = (rec._parked_for_await || 0) + 1;
    // Drain so any queued sub can take our slot. _drainPool already calls
    // _notifyListeners on its own — but explicitly fire too so the
    // `in_pool_running` / `parked_for_await` snapshots flip in the UI
    // even if _drainPool finds nothing queued and short-circuits.
    _drainPool();
    _notifyListeners();
    return true;
}

function unparkAfterAwait(agentId) {
    var rec = _subAgents[agentId];
    if (!rec) return false;
    if (!rec._parked_for_await) return false;
    rec._parked_for_await -= 1;
    if (rec._parked_for_await <= 0) delete rec._parked_for_await;
    // Only re-admit if the sub is still in `running`. A 'sleeping' sub
    // shouldn't be parked in the first place (its loop is blocked on
    // Handles.await, which by definition keeps state='running') — but if
    // some future edge path lands here with state='sleeping' we must NOT
    // re-occupy a pool slot for it, because the loop isn't actually
    // executing. Terminal states (stopped/errored) are also ignored.
    if (rec.state === 'running') {
        _subPool.running[agentId] = true; // soft over-cap on resume — by design
    }
    _notifyListeners();
    return true;
}

function _markErrored(agentId, errMsg) {
    var rec = _subAgents[agentId];
    if (!rec) return;
    if (rec.state === 'stopped' || rec.state === 'errored') return;
    rec.state = 'errored';
    rec.settled_at = Date.now();
    rec.last_report = rec.last_report || {
        status: 'error', summary: errMsg, from: rec.agent_id, from_name: rec.name, at: rec.settled_at
    };
    _subAgentsPersist(rec);
    _resolveSpawnHandle(agentId, { status: 'error', error: errMsg, summary: errMsg, from: rec.agent_id });
    _releasePoolSlot(agentId);
    _notifyListeners();
}

// ---------- agent_status ----------

function agentStatus(args, ctx) {
    args = args || {};
    function snap(rec) {
        return {
            agent_id: rec.agent_id,
            chat_id: rec.chat_id,
            parent_chat_id: rec.parent_chat_id,
            parent_agent_id: rec.parent_agent_id,
            depth: rec.depth || 1,
            root_chat_id: rec.root_chat_id || rec.parent_chat_id,
            name: rec.name,
            state: rec.state,
            created_at: rec.created_at,
            last_activity_at: rec.last_activity_at,
            settled_at: rec.settled_at || null,
            tool_calls_used: rec.tool_calls_used || 0,
            max_tool_calls: rec.max_tool_calls,
            pending_handles: (rec.pending_handles || []).length,
            inbox_size: (rec.inbox || []).length,
            in_pool_running: !!_subPool.running[rec.agent_id],
            in_pool_queue: _subPool.queue.indexOf(rec.agent_id) >= 0,
            parked_for_await: !!rec._parked_for_await,
            last_report: rec.last_report || null
        };
    }
    if (args.agent_id) {
        var rec = _subAgents[args.agent_id];
        if (!rec) return { success: false, error: 'unknown agent_id: ' + args.agent_id };
        return { success: true, agent: snap(rec) };
    }
    // List — optionally filter by parent_chat_id so the parent sees its own subs.
    // Explicit '*' returns every sub on the instance. Otherwise default to the
    // caller's own chat — if we can't resolve one and no explicit value was
    // given, return an empty list rather than leaking every sub.
    // Prefer the dispatcher-supplied ctx.chatId so worker / js_eval / nested
    // contexts (where activeStreamingChatId may diverge from the caller's
    // actual chat) get correctly scoped. Fall back to streaming / current.
    var parentChatId = args.parent_chat_id
        || (ctx && ctx.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    if (args.parent_chat_id !== '*' && !parentChatId) {
        return { success: true, agents: [], pool: { running: Object.keys(_subPool.running).length, queued: _subPool.queue.length, size: SUBAGENT_POOL_SIZE }, note: 'no parent chat context resolvable; pass parent_chat_id explicitly or "*" for all' };
    }
    var out = [];
    for (var aid in _subAgents) {
        var r = _subAgents[aid];
        // Phase 5 follow-up: return the FULL subtree (every descendant whose
        // root chat is the caller), not just direct children. Without this,
        // `agent_status({include_tree:true})` from a root chat hides every
        // grandchild — the documented "cross-level tree" the system prompt
        // advertises was empty in practice. Pass `parent_chat_id:'*'` for
        // the everything-on-the-instance escape hatch (unchanged).
        if (args.parent_chat_id !== '*') {
            var rRoot = r.root_chat_id || r.parent_chat_id;
            if (rRoot !== parentChatId && r.parent_chat_id !== parentChatId) continue;
        }
        out.push(snap(r));
    }
    // Sort: running first, then sleeping, then terminal; newest within group.
    var rank = { running: 0, sleeping: 1, stopped: 2, errored: 3 };
    out.sort(function(a, b) {
        var ra = rank[a.state] != null ? rank[a.state] : 4;
        var rb = rank[b.state] != null ? rank[b.state] : 4;
        if (ra !== rb) return ra - rb;
        return b.last_activity_at - a.last_activity_at;
    });
    var resp = { success: true, agents: out, pool: { running: Object.keys(_subPool.running).length, queued: _subPool.queue.length, size: SUBAGENT_POOL_SIZE } };
    // Optional tree assembly (Phase 5). When `include_tree:true`, attach a
    // parent_agent_id-keyed map of children agent_ids so callers can render
    // a hierarchy without re-walking the flat list. Top-level roots are
    // keyed under their `parent_chat_id` (no parent_agent_id).
    if (args.include_tree) {
        var tree = Object.create(null);
        for (var ti = 0; ti < out.length; ti++) {
            var key = out[ti].parent_agent_id || out[ti].parent_chat_id;
            if (!tree[key]) tree[key] = [];
            tree[key].push(out[ti].agent_id);
        }
        resp.tree = tree;
    }
    return resp;
}

// ---------- Hooks called by the agent loop ----------

// Called by 030-agent-loop.js whenever a tool call is dispatched inside a
// sub-agent chat. Increments the budget counter; if the cap is exceeded,
// terminates the sub with budget_exhausted. Returns false if the loop
// should halt immediately.
function onToolCallInSubAgent(chatId) {
    if (typeof chats === 'undefined' || !chats[chatId] || !chats[chatId].isSubAgent) return true;
    var rec = _subAgents[chats[chatId].subAgentId];
    if (!rec) return true;
    rec.tool_calls_used = (rec.tool_calls_used || 0) + 1;
    rec.last_activity_at = Date.now();
    if (rec.tool_calls_used > rec.max_tool_calls) {
        var msg = 'Sub-agent ' + rec.name + ' exceeded max_tool_calls (' + rec.max_tool_calls + ').';
        rec.state = 'stopped';
        rec.settled_at = Date.now();
        rec.last_report = rec.last_report || { status: 'error', summary: msg, from: rec.agent_id, from_name: rec.name, at: rec.settled_at };
        _subAgentsPersist(rec);
        // Resolve with status:'error' — _resolveSpawnHandle returns a
        // payload the outer handle entry stamps as `result`, so
        // snapshot.result.status will be 'error' and the agent can branch.
        _resolveSpawnHandle(rec.agent_id, { status: 'error', error: 'budget_exhausted', summary: msg, from: rec.agent_id });
        if (typeof pausedChats !== 'undefined') pausedChats[rec.chat_id] = true;
        _releasePoolSlot(rec.agent_id);
        _notifyListeners();
        return false;
    }
    _subAgentsPersist(rec);
    return true;
}

// Called by 030-agent-loop.js when runAgent finishes naturally (the model
// produced a final assistant message with no further tool calls). If the
// sub never called report_to_parent + auto_report is on, synthesize a
// fallback report from the last assistant message so the parent's handle
// always settles.
function onSubAgentRunFinished(chatId, finishCtx) {
    if (typeof chats === 'undefined' || !chats[chatId] || !chats[chatId].isSubAgent) return;
    var rec = _subAgents[chats[chatId].subAgentId];
    if (!rec) return;
    // finishCtx (optional, supplied by agent-loop) signals whether the run
    // ended in an API/loop error. If so, the auto_report fallback below
    // synthesizes status:'error' instead of status:'done' to avoid lying
    // to the parent.
    var _runErrored = !!(finishCtx && finishCtx.reason === 'errored');
    var _runErrorMsg = (finishCtx && finishCtx.error && (finishCtx.error.message || String(finishCtx.error))) || '';
    // CRITICAL: do NOT release the pool slot up-front. The wake-during-
    // finish race can install a NEW runAgent loop for the same agent_id
    // in the window between runningChatIds being cleared by the agent
    // loop (030-agent-loop.js:928) and this hook running (line 952).
    // In that case _subPool.running[aid] is true, owned by the new loop;
    // releasing it here would leak the slot (over-release decrements to
    // zero while the new loop is still running). Instead, gate every
    // exit branch on (a) deferred still present, (b) no replacement
    // loop already claimed, and release the slot only where appropriate.
    if (!_spawnDeferreds[rec.spawn_handle_id]) {
        // Already settled (report_to_parent done/error or stop). Release
        // our slot — a non-racy case because state is terminal.
        _releasePoolSlot(rec.agent_id);
        return;
    }
    if (_subPool.running[rec.agent_id] && (typeof runningChatIds !== 'undefined' && runningChatIds[chatId])) {
        // A replacement loop is actively running for this same sub. We
        // are the OLD loop's finish hook — stand down silently. Don't
        // touch the slot, don't synthesize a report.
        return;
    }
    // NOTE: Previously had a second guard here on `_subPool.running[aid]` alone
    // that bailed if the slot was claimed but runningChatIds was not yet set.
    // That guard was unreachable for a real race — drain claims the slot AND
    // schedules runAgent via Promise.resolve().then(), and microtasks cannot
    // run during this hook's synchronous execution. The only path that hit it
    // was the natural-finish path (slot still owned by us, the just-exited
    // loop), where it caused auto_report to never run and the parent's
    // spawn handle to hang forever. The line-1063 queue check below covers
    // the genuine wake-during-finish-pre-drain case.

    // sleep_self path: the sub explicitly paused itself. Don't synthesize
    // a `done` over a sleeping sub — the parent is expected to either
    // wake it (new instructions) or stop it. Without this guard the
    // parent's spawn handle resolves with a misleading auto-`done` even
    // though the sub never produced a terminal report.
    if (rec.state === 'sleeping') {
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        _notifyListeners();
        return;
    }

    // Wake-during-finish (queued, not yet claimed): a parent/sibling called
    // wake_sub_agent while the old loop was wrapping up, the wake re-
    // queued the sub with state='running', and _drainPool hasn't picked
    // it up yet (could be a microtask away). Stand down and re-drain so
    // the new loop actually fires.
    if (rec.state === 'running' && _subPool.queue.indexOf(rec.agent_id) >= 0) {
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        _drainPool();
        _notifyListeners();
        return;
    }

    // BUG FIX (message-drop race): an agent_message arriving while the
    // loop was on its final no-tool-call turn would push a user message
    // (or stash pendingInjection) AFTER the loop had already decided to
    // exit. Without this guard the auto_report below would synthesize a
    // `done` from the stale last assistant turn and the parent’s message
    // would never be consumed. Detect both cases (unconsumed trailing
    // user message OR a non-empty pendingInjection) and re-queue the
    // sub instead of settling, so the pool starts a fresh turn that
    // actually reads the new input.
    var _msgs = (chats[chatId] && chats[chatId].messages) || [];
    var _lastMsg = _msgs.length ? _msgs[_msgs.length - 1] : null;
    var _hasTrailingUser = !!(_lastMsg && _lastMsg.role === 'user');
    var _hasPendingInj = false;
    try {
        if (typeof pendingInjectionsByChatId !== 'undefined') {
            var _pi = pendingInjectionsByChatId[chatId];
            _hasPendingInj = !!(_pi && (_pi.text || (_pi.images && _pi.images.length)));
        }
    } catch (_) { /* ignore */ }
    if ((_hasTrailingUser || _hasPendingInj) && !_runErrored) {
        rec.state = 'running';
        if (typeof pausedChats !== 'undefined') delete pausedChats[rec.chat_id];
        rec.last_activity_at = Date.now();
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        if (_subPool.queue.indexOf(rec.agent_id) === -1) _subPool.queue.push(rec.agent_id);
        _drainPool();
        _notifyListeners();
        return;
    }

    if (rec.auto_report) {
        // Pull the last assistant text as a fallback summary.
        var fallback = '';
        var msgs = chats[chatId].messages || [];
        for (var i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant' && msgs[i].content) {
                fallback = (typeof msgs[i].content === 'string')
                    ? msgs[i].content
                    : JSON.stringify(msgs[i].content);
                break;
            }
        }
        if (fallback.length > rec.summary_cap_bytes) {
            fallback = fallback.slice(0, rec.summary_cap_bytes - 100) + '\n…[truncated]';
        }
        // Synthesize error vs done based on the agent-loop's finish reason.
        // Without this, a crashed sub still reports back as success.
        var _synthStatus = _runErrored ? 'error' : 'done';
        var _synthSummary = fallback
            || (_runErrored
                ? ('(sub-agent crashed without an explicit report_to_parent call' + (_runErrorMsg ? ': ' + _runErrorMsg : '') + ')')
                : '(sub-agent finished without an explicit report_to_parent call)');
        rec.last_report = {
            status: _synthStatus,
            summary: _synthSummary,
            from: rec.agent_id,
            from_name: rec.name,
            at: Date.now(),
            _synthesized: true
        };
        if (_runErrored) rec.state = 'errored';
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        _resolveSpawnHandle(rec.agent_id, {
            status: _synthStatus,
            summary: rec.last_report.summary,
            from: rec.agent_id,
            _synthesized: true,
            error: _runErrored ? (_runErrorMsg || 'sub-agent run errored') : undefined
        });
    } else {
        // auto_report:false means the caller opted into manual settlement.
        // The sub finished without calling report_to_parent — the parent's
        // await_handle would hang forever. Settle with an explicit `error`
        // so the parent unblocks with a clear diagnostic instead.
        var errMsg = 'sub-agent finished without calling report_to_parent (auto_report disabled).';
        rec.last_report = rec.last_report || {
            status: 'error',
            summary: errMsg,
            from: rec.agent_id,
            from_name: rec.name,
            at: Date.now(),
            _no_report: true
        };
        _subAgentsPersist(rec);
        _releasePoolSlot(rec.agent_id);
        _resolveSpawnHandle(rec.agent_id, {
            status: 'error',
            error: 'no_report',
            summary: errMsg,
            from: rec.agent_id
        });
    }
    _parkSubAgent(rec);
    _notifyListeners();
}

// ---------- Exported API ----------

var SubAgents = {
    // Tool implementations (called from tools/020-tool-execution.js dispatch arms)
    spawn:   spawnSubAgent,
    report:  reportToParent,
    sleep:   sleepSelf,
    wake:    wakeSubAgent,
    stop:    stopSubAgent,
    message: agentMessage,
    status:  agentStatus,
    // Agent-loop hooks
    onToolCallInSubAgent: onToolCallInSubAgent,
    onSubAgentRunFinished: onSubAgentRunFinished,
    // UI hooks
    addListener:    addSubAgentListener,
    removeListener: removeSubAgentListener,
    // Boot
    loadAll: loadAllSubAgents,
    // Page-mirror sync — install a full snapshot from the authoritative
    // SW registry. Called by the page-side port bridge on `hello` and on
    // every `subagent-snapshot` envelope.
    applySnapshot: applySubAgentSnapshot,
    // Read-only access for UI components
    getById: function(agentId) { return _subAgents[agentId] || null; },
    listAll: function() {
        var out = []; for (var aid in _subAgents) out.push(_subAgents[aid]); return out;
    },
    poolSnapshot: function() {
        return {
            running: Object.keys(_subPool.running).length,
            queued:  _subPool.queue.length,
            size:    SUBAGENT_POOL_SIZE
        };
    },
    // Pool-deadlock prevention hooks (Phase 5). Called by the await_handle
    // dispatch arm when a sub awaits one of its own descendants' spawn handles.
    parkForAwait:      parkForAwait,
    unparkAfterAwait:  unparkAfterAwait,
    // Tree-walk helpers exposed for UI / tools that need to render hierarchy
    // or enforce ACL outside this module.
    ancestorChain:     _ancestorChain,
    children:          _children,
    descendants:       _descendants,
    // Constants the system prompt module reads
    PREAMBLE: SUB_AGENT_PREAMBLE
};

// Expose for SW context (worker bundle runs as a module/script).
if (typeof self !== 'undefined') { self.SubAgents = SubAgents; }
