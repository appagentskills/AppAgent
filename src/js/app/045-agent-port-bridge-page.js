// =============================================================
// Page-side agent-bus port + runAgent shim.
//
// Loaded ONLY in the page bundle (not WORKER_SHARED_FILES). This
// file does three things:
//
//   1. Opens a long-lived 'agent-bus' port DIRECTLY to the service
//      worker (which now hosts the agent loop). No relay layer.
//
//   2. Receives 'agent-event' envelopes from the SW and re-emits
//      them on the local AgentEvents bus so the page-side handlers
//      (app/036-agent-event-handlers-page.js) fire exactly like
//      they used to when the loop ran in the panel itself.
//
//   3. OVERRIDES the runAgent function declared in
//      src/js/app/030-agent-loop.js. Because function declarations
//      are hoisted and the LAST one in source order wins, this
//      file's `function runAgent` replaces the in-page loop entry
//      point. The original loop body (~815 LOC of helpers +
//      streaming + tool dispatch) remains in 030-agent-loop.js
//      because the SW bundle imports the same file for the agent
//      runtime. The page bundle just doesn't call it directly
//      anymore — runAgent posts a message and waits for runFinished.
//
// File load order rationale:
//   • app/035-agent-events.js (bus) loads first
//   • app/030-agent-loop.js (real runAgent + helpers) loads next
//   • app/036-agent-event-handlers-page.js loads (registers UI handlers)
//   • app/040-send-message.js loads (calls runAgent — sees the shim
//     by virtue of function-decl hoisting picking the LAST decl)
//   • app/045 (THIS file) loads (final runAgent override + port wiring)
//
// AGENT_PORT_BRIDGE_PAGE_SENTINEL — used by build-verify grep.
// =============================================================

// One port per page lifetime. Re-opened automatically on SW restart
// because chrome.runtime.connect throws synchronously if SW is dead,
// and the page would have to react — see _openAgentBus.
var _agentBusPort = null;

// Pending runAgent calls keyed by chatId so we can resolve them on
// runFinished. Value: { resolve, reject, chatId }.
var _pendingRunAgents = {};

// SWM-S2: safety timer armed by the bus onDisconnect. Pending runAgent
// promises are no longer settled at disconnect time (a transient SW flap
// would resolve callers' awaits mid-run); they settle on the next 'hello'
// against the SW's authoritative runningChatIds. If NO hello arrives within
// this window (SW never came back), resolve everything so callers can't
// hang forever.
var _busHelloSafetyTimer = null;
var BUS_HELLO_SAFETY_MS = 15000;

function _settleAllPendingRunAgents() {
    Object.keys(_pendingRunAgents).forEach(function(cid) {
        var pr = _pendingRunAgents[cid];
        delete _pendingRunAgents[cid];
        if (pr && pr.resolve) { try { pr.resolve(); } catch (e) {} }
    });
}

// REG-F1: deferred hello orphan reconcile. The SW's hello is posted
// synchronously at port connect — BEFORE resumeRunningCheckpoints re-arms
// checkpointed runs (gated on _swResumeGate ≈1.5s after the first panel-hello)
// and before a run-agent posted during the reconnect gap is processed. A chat
// can therefore be absent from hello's runningChatIds and still be running
// seconds later. Instead of settling its promise / finalizing its action /
// wiping its streaming UI at hello time, the hello handler captures the
// candidates and acts after a grace window, re-checking live state first.
// Genuinely-dead runs settle exactly as before, just HELLO_SETTLE_GRACE_MS
// later (still well inside the 15s no-hello worst case).
// REG-AUDIT-2/REG376-3: if the SW hasn't yet signalled that its checkpoint
// resume scan settled (resumeScanSettled on hello / 'resume-scan-done'
// message), the timer re-arms itself for HELLO_SETTLE_RESUME_EXTRA_MS more —
// up to HELLO_SETTLE_RESUME_MAX_REARMS times (3s + 3×9s = 30s total) — before
// reconciling, covering slow cold boots where the unbounded resume gate chain
// outlives the first grace window.
var _helloGraceTimer = null;
var _helloGraceState = null; // { orphans: { cid: pendingEntry }, cleanups: { cid: true }, rearms?: number }
var HELLO_SETTLE_GRACE_MS = 3000;
// REG-AUDIT-2: extra grace when the SW hasn't reported its resume scan as
// settled by the time the first window expires. The SW's
// resumeRunningCheckpoints gate chain (_swBootReady → _swResumeGate →
// Platform.ready → loadApiProviders) is unbounded on a slow cold boot, so the
// fixed 3s timer could win and finalize a still-resuming run.
// REG376-3: re-arm up to HELLO_SETTLE_RESUME_MAX_REARMS times (30s total),
// not once — a single 9s extension still lost to gate chains slower than 12s.
// (Note: BUS_HELLO_SAFETY_MS caps the NO-hello window only; it says nothing
// about how long the gate chain may run AFTER a hello arrived, so it is no
// upper bound here. The hard re-arm cap is what keeps a wedged SW — one that
// never settles its scan — from deferring the reconcile forever.)
var HELLO_SETTLE_RESUME_EXTRA_MS = 9000;
var HELLO_SETTLE_RESUME_MAX_REARMS = 3;
// True once the SW has signalled the resume scan is decided — via the hello
// payload's resumeScanSettled flag or a 'resume-scan-done' message.
var _swResumeScanSettledSeen = false;

function _cancelHelloGraceReconcile() {
    if (_helloGraceTimer) { try { clearTimeout(_helloGraceTimer); } catch (e) {} }
    _helloGraceTimer = null;
    _helloGraceState = null;
}

function _armHelloGraceReconcile(orphans, cleanups) {
    // One timer only — a fresh hello supersedes any pending reconcile (its
    // candidate sets are stale relative to the newer authoritative snapshot).
    _cancelHelloGraceReconcile();
    if (!Object.keys(orphans).length && !Object.keys(cleanups).length) return;
    _helloGraceState = { orphans: orphans, cleanups: cleanups };
    // REG-AUDIT-2/REG376-3: named so the callback can re-arm itself (up to
    // HELLO_SETTLE_RESUME_MAX_REARMS times) when the SW's resume scan hasn't
    // settled yet (slow cold boot). The one-timer invariant holds: re-arm
    // reuses the same _helloGraceTimer/_helloGraceState slots, and a fresh
    // hello still cancels via _cancelHelloGraceReconcile.
    function _helloGraceFire() {
        var st = _helloGraceState;
        _helloGraceTimer = null;
        _helloGraceState = null;
        if (!st) return;
        // REG-AUDIT-2/REG376-3: the SW hasn't finished (or failed) its
        // checkpoint resume scan — a chat absent from runningChatIds may
        // still come back. Extend the window (capped) instead of finalizing
        // early.
        if (!_swResumeScanSettledSeen && st && (st.rearms || 0) < HELLO_SETTLE_RESUME_MAX_REARMS) {
            st.rearms = (st.rearms || 0) + 1;
            _helloGraceState = st;
            _helloGraceTimer = setTimeout(_helloGraceFire, HELLO_SETTLE_RESUME_EXTRA_MS);
            return;
        }
        Object.keys(st.orphans).forEach(function(cid) {
            // Re-check 1: the run came back — the SW resumed it from checkpoint
            // (runStarted re-added the id) or processed a gap-posted run-agent.
            // Its promise stays pending and resolves on the real runFinished.
            if (runningChatIds[cid]) return;
            // Re-check 2: the entry already settled (runFinished arrived during
            // the grace window) or was replaced by a fresh runAgent — only
            // settle the exact entry captured at hello time.
            var cur = _pendingRunAgents[cid];
            if (!cur || cur !== st.orphans[cid]) return;
            delete _pendingRunAgents[cid];
            if (cur.resolve) { try { cur.resolve(); } catch (e) {} }
            // DRLM-B3: if this orphaned run belonged to a background ACTION
            // chat, no runFinished will ever fire its finishActionIfDone (only
            // call sites are the loop exit and the runFinished handler) — the
            // action button would stay 'running' forever. Finalize it now.
            if (typeof finishActionIfDone === 'function') {
                try { finishActionIfDone(cid); } catch (e) {}
            }
        });
        Object.keys(st.cleanups).forEach(function(cid) {
            // Skip if the run re-established itself during the grace window;
            // _cleanupStaleForegroundRun itself re-reads the live foreground
            // state (activeStreamingChatId / currentChatId) at call time.
            if (runningChatIds[cid]) return;
            _cleanupStaleForegroundRun(cid);
        });
    }
    _helloGraceTimer = setTimeout(_helloGraceFire, HELLO_SETTLE_GRACE_MS);
}

// SWM-S3: replicate the foreground cleanup the runFinished handler performs
// (app/036-agent-event-handlers-page.js, runFinished) for a chat whose run
// evaporated WITHOUT a terminal event — the SW restarted and its hello no
// longer lists the chat as running, so no runFinished/runCrashed will ever
// arrive to clear the streaming UI (stuck pause button, is-streaming class,
// stale isRunning/activeStreamingChatId).
function _cleanupStaleForegroundRun(chatId) {
    if (!chatId) return;
    try {
        if (typeof hideSpinner === 'function') { try { hideSpinner(chatId); } catch (e) {} }
        if (typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId === chatId) {
            isRunning = false;
            activeStreamingChatId = null;
        } else if (typeof currentChatId !== 'undefined' && chatId === currentChatId &&
                   typeof isRunning !== 'undefined' && isRunning) {
            isRunning = false;
        }
        if (typeof currentChatId !== 'undefined' && chatId === currentChatId) {
            var _staleMsgsEl = document.getElementById('messages');
            if (_staleMsgsEl) _staleMsgsEl.classList.remove('is-streaming');
            if (typeof hidePauseButton === 'function') { try { hidePauseButton(); } catch (e) {} }
            if (typeof refreshContinueButtonForChat === 'function') { try { refreshContinueButtonForChat(chatId); } catch (e) {} }
            if (typeof renderMessages === 'function') { try { renderMessages(); } catch (e) {} }
        }
        if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
    } catch (e) {}
}

// Tool calls the panel is currently executing on behalf of the SW. Used
// to tell a fresh SW (after restart) which tools to ADOPT rather than
// re-dispatch — otherwise the panel would run the same tool twice
// (e.g. type the text twice into a form). Keyed by toolCallId.
var _inflightToolCalls = {};   // toolCallId -> { chatId, name, startedAt }
// Completed-but-not-yet-acked results. The panel posts exec-tool-result
// over the port best-effort, but if the SW died between receiving the
// result and persisting it (chat saved with placeholder, not real
// result), the next SW would re-dispatch without this buffer. On every
// reconnect we re-declare these alongside in-flight tools. Entries
// older than COMPLETED_RESULT_TTL_MS are dropped to bound memory.
//
// Why 60s: an MV3 SW is evicted after ~30s of idle. A tool that completed,
// got persisted to IDB, and was acked by the SW won't ever be replayed —
// so the only window we need to cover is "tool completed → SW died before
// persisting → SW restart → reconnect." That round-trip is bounded by the
// MV3 eviction timer plus a small reconnect grace, so 60s is comfortably
// over. A result that lingers beyond 60s without a SW reconnect almost
// certainly means the panel itself was closed/reopened (not relevant — the
// reopened panel won't have the result in memory anyway).
var _completedToolResults = {};  // toolCallId -> { chatId, name, result, error, completedAt }
var COMPLETED_RESULT_TTL_MS = 60 * 1000;

function _pruneCompletedResults() {
    var now = Date.now();
    Object.keys(_completedToolResults).forEach(function(tcid) {
        if (now - _completedToolResults[tcid].completedAt > COMPLETED_RESULT_TTL_MS) {
            delete _completedToolResults[tcid];
        }
    });
}

function _sendPanelHello() {
    if (!_agentBusPort) return;
    _pruneCompletedResults();
    var inflight = [];
    Object.keys(_inflightToolCalls).forEach(function(tcid) {
        var it = _inflightToolCalls[tcid];
        inflight.push({ chatId: it.chatId, toolCallId: tcid, name: it.name });
    });
    var completed = [];
    Object.keys(_completedToolResults).forEach(function(tcid) {
        var c = _completedToolResults[tcid];
        completed.push({ chatId: c.chatId, toolCallId: tcid, name: c.name, result: c.result, error: c.error });
    });
    try {
        _agentBusPort.postMessage({
            type: 'panel-hello',
            inflightToolCalls: inflight,
            completedToolResults: completed
        });
    } catch (e) {
        console.error('[agent-bus] panel-hello post failed', e);
    }
}

function _openAgentBus() {
    // Idempotency guard: several independent retry chains can call this
    // concurrently after a long SW outage (onDisconnect's 250ms reconnect, the
    // connect-throw 500ms retry below, and the exhaustion fallbacks in
    // pushPauseToggleToOffscreen / pushInterruptToOffscreen / 040's
    // _sendMessageToOffscreen). Without the guard each winning chain opened a
    // PARALLEL port whose _handleAgentBusMessage listener was never removed —
    // every agent-event then got processed N times (duplicate renders,
    // notifications, hello merges). A truthy _agentBusPort is always live:
    // onDisconnect nulls it synchronously when the port dies.
    if (_agentBusPort) return;
    try {
        _agentBusPort = chrome.runtime.connect({ name: 'agent-bus' });
    } catch (e) {
        console.error('[agent-bus] connect failed, retrying in 500ms', e);
        setTimeout(_openAgentBus, 500);
        return;
    }
    _agentBusPort.onMessage.addListener(_handleAgentBusMessage);
    _agentBusPort.onDisconnect.addListener(function() {
        _agentBusPort = null;
        // RETRY-F2: an SW eviction disconnects the bus WITHOUT emitting a terminal
        // runFinished/runCrashed for in-flight chats, so the page-side runningChatIds
        // (and their _pendingRunAgents promises) are left stuck "running". The runAgent
        // guard @:378 then treats Retry/Continue/Send as a no-op ("already running") and
        // silently drops the user's action. Any chat still in runningChatIds here had NO
        // terminal event by construction (runFinished/runCrashed delete it @:178), so
        // clear it; the SW's 'hello' on reconnect
        // re-populates runningChatIds for runs it actually resumed (@:206-209), and the
        // SW-side run-agent handler is idempotent (guards on its own runningChatIds @:222)
        // so a Retry that re-posts during the gap can't double-run a still-live SW loop.
        try {
            Object.keys(runningChatIds).forEach(function(cid) { delete runningChatIds[cid]; });
        } catch (e) {}
        // SWM-S2: do NOT settle _pendingRunAgents here. On a transient flap the SW
        // keeps streaming, and resolving now returns `await runAgent()` callers
        // mid-run (widget spinners die, summarize finalizes early). The promises
        // settle in the 'hello' handler against the SW's authoritative
        // runningChatIds; this timer is only the no-hello fallback so callers
        // never hang if the SW never comes back.
        // REG-F1: a disconnect invalidates any pending hello grace reconcile —
        // its candidates were computed against a hello that no longer reflects
        // the SW; the next hello re-derives them (or the 15s fallback settles).
        _cancelHelloGraceReconcile();
        if (_busHelloSafetyTimer) { try { clearTimeout(_busHelloSafetyTimer); } catch (e) {} }
        _busHelloSafetyTimer = setTimeout(function() {
            _busHelloSafetyTimer = null;
            // DRLM-B2: the SW never came back — no hello, no runFinished. Clear
            // the stale foreground streaming UI (same cleanup the hello
            // reconcile performs) before settling, or the pause button /
            // is-streaming class stay stuck forever in this path.
            try {
                if (typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId) {
                    _cleanupStaleForegroundRun(activeStreamingChatId);
                } else if (typeof isRunning !== 'undefined' && isRunning &&
                           typeof currentChatId !== 'undefined' && currentChatId) {
                    _cleanupStaleForegroundRun(currentChatId);
                }
            } catch (e) {}
            // RES-4: mirror DRLM-B3 (hello-grace path above) for the no-hello
            // fallback too — a settled pending runAgent belonging to a
            // background ACTION chat gets no runFinished ever (SW is dead), so
            // without this the action button spins forever.
            // _settleAllPendingRunAgents doesn't expose the chat ids, so
            // capture them BEFORE it clears the map.
            var _settledCids = [];
            try { _settledCids = Object.keys(_pendingRunAgents); } catch (e) {}
            _settleAllPendingRunAgents();
            _settledCids.forEach(function(cid) {
                try {
                    var _c = (typeof chats !== 'undefined') ? chats[cid] : null;
                    // PR383-F5: the SW never came back — this run DIED. The old
                    // finishActionIfDone(cid) call stamped the action button
                    // 'done'/'Complete' (wrong verdict for a dead run). Mirror the
                    // 036 runCrashed action-finalize instead: error verdict, same
                    // guards (the agent's own update_action_state result wins via
                    // the state==='running' check, pause wins via _isPaused/
                    // isChatPaused).
                    if (_c && _c.isBackground && _c.actionId
                        && typeof activeActions !== 'undefined' && activeActions[_c.actionId]) {
                        var _dAct = activeActions[_c.actionId];
                        var _dPaused = _dAct._isPaused || (typeof isChatPaused === 'function' && isChatPaused(cid));
                        if (_dAct.state === 'running' && !_dPaused) {
                            _dAct.state = 'error';
                            _dAct.icon = 'alert';
                            if (!_dAct.label || _dAct.label === 'Starting…') _dAct.label = 'Lost connection';
                            if (!_dAct.output) _dAct.output = 'The background service worker disconnected and never responded again, so this run was lost before reporting a result. Open the chat for details and re-run the action if needed.';
                            _dAct.updatedAt = Date.now();
                            if (typeof persistActionState === 'function') { try { persistActionState(_c.actionId); } catch (e2) {} }
                            if (typeof notifyActionStateChanged === 'function') { try { notifyActionStateChanged(_c.actionId); } catch (e2) {} }
                        }
                    }
                } catch (e) {}
            });
        }, BUS_HELLO_SAFETY_MS);
        // SW restart — re-open. Slight delay to avoid tight loops.
        setTimeout(_openAgentBus, 250);
    });
    // Declare any tools the panel is still executing so a fresh SW
    // adopts them instead of re-dispatching. Must run synchronously
    // after connect — the SW resume gate waits ~1.5s for this.
    _sendPanelHello();
    // SWM2-F1(B): re-post the focused chat on every bus (re)connect. After an SW
    // restart the SW's _focusedChatId / _focusedChatByPort reset (in-memory only), so
    // without this the sub-agent GC has no focus signal until the user next switches
    // chats — and a sweep firing in that window could reclaim the very transcript the
    // user is viewing. (SWM2-F1 part A defers GC when focus is unknown; this
    // re-establishes it promptly.) Mirrors the permissions + hello re-push below.
    if (typeof pushFocusChatToOffscreen === 'function') {
        // SWM2-T1: derive focus from currentView (F3's source of truth) not currentChatId —
        // view-leave sets currentView but never clears currentChatId, so keying off currentChatId
        // re-pins a stale last-viewed chat after an SW restart, protecting it from GC. Always post
        // (incl. null) so focus is treated as reported (pairs with SWM2-T2).
        var _focusNow = (typeof currentView !== 'undefined' && currentView === 'chat'
            && typeof currentChatId !== 'undefined' && currentChatId) ? currentChatId : null;
        pushFocusChatToOffscreen(_focusNow);
    }
    // Re-mirror in-memory session permissions: the SW loses these on
    // restart (in-memory only, not in IDB), so without this push the user
    // would get prompted again after a SW eviction even though they
    // already chose "Allow for session" earlier.
    //
    // tool/instancePermissions: only push if THIS PAGE has already hydrated
    // them from IDB (non-empty). _openAgentBus runs at file-load time, well
    // BEFORE loadToolPermissions() in core/120-init.js completes — pushing
    // the empty defaults on cold load would CLOBBER the SW's own IDB-loaded
    // state and strand Auto-tier instances back on 'ask' for every tool.
    // loadToolPermissions re-pushes both sources once IDB read completes,
    // covering the belt-and-suspenders case.
    if (typeof pushPermissionsToOffscreen === 'function') {
        var _hasTool = toolPermissions && typeof toolPermissions === 'object' && Object.keys(toolPermissions).length > 0;
        var _hasInst = instancePermissions && typeof instancePermissions === 'object' && Object.keys(instancePermissions).length > 0;
        pushPermissionsToOffscreen({
            sessionPermissions: typeof sessionPermissions === 'object' ? sessionPermissions : null,
            toolPermissions: _hasTool ? toolPermissions : null,
            instancePermissions: _hasInst ? instancePermissions : null
        });
    }
}

// RES-5: preserve page-only PENDING interactive rows across SW chat-snapshot
// replaces. Page-side tools push `prompt_user` (and the approval prompt pushes
// `approval`) rows into the PAGE mirror only — they are mirrored into the SW's
// authoritative copy AFTER they resolve (result._message_persist for
// prompt_user; the decision write-back for approvals). Any snapshot that
// arrives while one is still pending — e.g. a sub-agent progress repaint
// (recordSubActionState → _repaintParent → messagesAppended force:true, which
// inlines the SW's parent-chat copy) — lacks the row, so the wholesale
// `chats[chatId] = snapshot` assignment dropped it and the handler's
// renderMessages() wiped the live form out from under the user. Splice each
// missing pending row back at its original page index: approvals are
// index-keyed (pendingToolApprovals[chatId + ':' + approvalIndex]), so
// position matters, and ascending iteration keeps later indexes correct.
// Re-inserting the PAGE's own message object also preserves any draft values
// promptCaptureDraft stashed on msg.fields (see tools/100-prompt-user.js).
// Resolved rows (status no longer 'pending') are deliberately NOT preserved —
// the SW snapshot owns them from resolution onward, so a submitted/cancelled
// form stays dismissed on every later re-render.
function _mergePagePendingRows(prevChat, inChat, chatId) {
    if (!prevChat || !inChat || !Array.isArray(prevChat.messages) || !Array.isArray(inChat.messages)) return;
    for (var ri = 0; ri < prevChat.messages.length; ri++) {
        var rm = prevChat.messages[ri];
        if (!rm || rm.status !== 'pending') continue;
        if (rm.role !== 'prompt_user' && rm.role !== 'approval') continue;
        var dup = false;
        for (var rj = 0; rj < inChat.messages.length; rj++) {
            var rn = inChat.messages[rj];
            if (!rn || rn.role !== rm.role) continue;
            if (rm.role === 'prompt_user' ? (rn.promptId === rm.promptId)
                                          : (rn.toolCallId === rm.toolCallId && rn.toolCallId)) { dup = true; break; }
        }
        if (dup) continue;
        var _pos = Math.min(ri, inChat.messages.length);
        inChat.messages.splice(_pos, 0, rm);
        // PR383-F3: approvals are resolved strictly by index — handleApproval
        // (ui/160-notifications.js) reads chat.messages[approvalIndex] and
        // silently no-ops on a mismatch. When the incoming snapshot is SHORTER
        // than the row's original page index, the row lands at a clamped
        // position != ri, so the pendingToolApprovals entry (keyed
        // chatId+':'+index) points at the wrong slot — Allow/Deny would no-op
        // forever and the parked SW tool call hangs. Re-key the entry to the
        // actual insertion index. Prefer locating the entry by toolCallId
        // (robust to drift from earlier merges); fall back to the
        // original-index key.
        if (rm.role === 'approval' && _pos !== ri && chatId &&
            typeof pendingToolApprovals !== 'undefined' && pendingToolApprovals) {
            var _entKey = null;
            if (rm.toolCallId) {
                for (var _ak in pendingToolApprovals) {
                    var _pe = pendingToolApprovals[_ak];
                    if (_pe && _pe.chatId === chatId && _pe.toolCallId === rm.toolCallId) { _entKey = _ak; break; }
                }
            }
            if (!_entKey && pendingToolApprovals[chatId + ':' + ri]) _entKey = chatId + ':' + ri;
            if (_entKey) {
                var _newKey = chatId + ':' + _pos;
                if (_newKey !== _entKey && !pendingToolApprovals[_newKey]) {
                    var _ent = pendingToolApprovals[_entKey];
                    delete pendingToolApprovals[_entKey];
                    _ent.approvalIndex = _pos;
                    pendingToolApprovals[_newKey] = _ent;
                }
            }
        }
    }
}

function _handleAgentBusMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
        case 'agent-event':
            // Mutating events inline the chat snapshot so the page mirror
            // stays in sync without async pull-chat round-trips. Assign
            // BEFORE re-emitting so the handlers (which read chats[chatId])
            // see the updated state.
            if (msg.detail && msg.detail.chat && msg.detail.chatId) {
                var _inChat = msg.detail.chat;
                var _prevChat = chats[msg.detail.chatId];
                // Merge versionHistory instead of letting the wholesale chat
                // replace drop entries. The page owns some entries/flags the SW
                // snapshot can't know about: entries appended for page-bridged
                // tools, revert entries, and `invalidated` flags set by undo/redo.
                // Rule: prefer the PAGE copy when ids match (richer flags), and
                // append page-only entries the snapshot lacks.
                if (_prevChat && Array.isArray(_prevChat.versionHistory) && _prevChat.versionHistory.length) {
                    var _prevById = {};
                    _prevChat.versionHistory.forEach(function(v) { if (v && v.id) _prevById[v.id] = v; });
                    var _inVH = Array.isArray(_inChat.versionHistory) ? _inChat.versionHistory : [];
                    var _inSeen = {};
                    var _mergedVH = _inVH.map(function(v) {
                        if (v && v.id) {
                            _inSeen[v.id] = true;
                            if (_prevById[v.id]) return _prevById[v.id];
                        }
                        return v;
                    });
                    _prevChat.versionHistory.forEach(function(v) {
                        if (v && (!v.id || !_inSeen[v.id])) _mergedVH.push(v);
                    });
                    _mergedVH.sort(function(a, b) { return (a && a.timestamp || 0) - (b && b.timestamp || 0); });
                    _inChat.versionHistory = _mergedVH;
                }
                // RES-5: keep pending prompt_user / approval rows the SW
                // snapshot can't know about (see _mergePagePendingRows).
                _mergePagePendingRows(_prevChat, _inChat, msg.detail.chatId); // PR383-F3: chatId for approval re-key
                chats[msg.detail.chatId] = _inChat;
                // Re-point the active-chat versionHistory mirror: it referenced
                // the replaced chat object's array, so sidebar/inline renders
                // would otherwise read (and write flags into) a dangling copy.
                if (msg.detail.chatId === currentChatId && typeof versionHistory !== 'undefined') {
                    if (!Array.isArray(_inChat.versionHistory)) _inChat.versionHistory = [];
                    versionHistory = _inChat.versionHistory;
                }
            }
            // Track running state locally so the chat list pill / pause button
            // sync with offscreen without each handler having to deal with it.
            // The worker loop deletes its OWN runningChatIds[chatId] BEFORE
            // emitting runFinished (see agent-loop.js); the page mirror has
            // to do the same so renderChatList sees the cleared state.
            if (msg.eventType === 'runStarted' && msg.detail && msg.detail.chatId) {
                runningChatIds[msg.detail.chatId] = true;
            }
            if ((msg.eventType === 'runFinished' || msg.eventType === 'runCrashed') &&
                msg.detail && msg.detail.chatId) {
                delete runningChatIds[msg.detail.chatId];
                // SWM14-F5 cleanup: prune the per-chat pause/interrupt latest-wins token
                // maps on terminal run end so they don't grow unbounded across many chats.
                // Skip a pause-induced finish (reason 'paused') — a pushPauseToggleToOffscreen
                // retry chain for that very pause may still be in flight and keys off these
                // maps; they're pruned on the eventual non-paused finish (or chat delete).
                // SWM-TOKENLEAK: a 'paused' finish deliberately skips this prune (a
                // pushPauseToggleToOffscreen retry chain may still key off these maps).
                // RESIDUAL LEAK: a chat paused-and-never-resumed then DELETED never gets
                // a non-paused terminal event, so its 4 token-map entries leak forever.
                // The clean fix is to call _pruneChatPauseTokens(chatId) from the page
                // delete path deleteChat() in src/js/ui/170-chat-management.js (not owned
                // by this change). The helper is exported below for that wiring; this
                // non-paused terminal prune remains the fallback for resumed-then-finished
                // chats.
                // RES-3: the prune itself moved BELOW the AgentEvents.emit
                // re-dispatch — 036's runFinished handler reads
                // _pauseToggleDesired[chatId] synchronously during that emit
                // to build _pausePending (SWM-PAUSE-FINALIZE gate); pruning
                // here first made that gate permanently false (dead gate).
            }
            // Re-emit on the local bus so app/036 handlers fire as if
            // the loop ran in this page.
            try {
                AgentEvents.emit(msg.eventType, msg.detail || {});
            } catch (e) {
                console.error('[agent-bus] re-emit failed', msg.eventType, e);
            }
            // RES-3: prune the pause/interrupt token maps AFTER the re-emit so
            // 036's handlers saw the live values (same condition and keys as
            // the original pre-emit prune — see SWM14-F5 / SWM-TOKENLEAK above).
            if ((msg.eventType === 'runFinished' || msg.eventType === 'runCrashed') &&
                msg.detail && msg.detail.chatId && msg.detail.reason !== 'paused') {
                var _doneCid = msg.detail.chatId;
                delete _pauseToggleGen[_doneCid];
                delete _pauseToggleDesired[_doneCid];
                delete _interruptGen[_doneCid];
                delete _interruptDesired[_doneCid];
            }
            // Resolve any pending runAgent promises waiting on a terminal
            // event. runCrashed is terminal too — the SW loop's finally emits
            // it INSTEAD of runFinished on an uncaught throw, so without
            // settling here every `await runAgent()` caller would hang until
            // the next port flap's hello reconcile (or forever on a healthy
            // port).
            if ((msg.eventType === 'runFinished' || msg.eventType === 'runCrashed') && msg.detail && msg.detail.chatId) {
                var pr = _pendingRunAgents[msg.detail.chatId];
                if (pr) {
                    delete _pendingRunAgents[msg.detail.chatId];
                    try { pr.resolve(); } catch (e) {}
                }
            }
            return;

        case 'hello':
            // SWM-S2: hello ends the disconnect grace window — cancel the
            // no-hello safety timer; pending runAgent promises are settled
            // below against the authoritative runningChatIds instead.
            if (_busHelloSafetyTimer) {
                try { clearTimeout(_busHelloSafetyTimer); } catch (e) {}
                _busHelloSafetyTimer = null;
            }
            // REG-AUDIT-2: record whether the SW's resume scan already settled
            // BEFORE arming the grace reconcile below, so the timer knows
            // whether it may need its one-shot extension.
            _swResumeScanSettledSeen = !!msg.resumeScanSettled;
            // Offscreen sent us the running-chats snapshot + the list of
            // running chat ids. Merge into local state so the panel UI
            // reflects ongoing background runs immediately on connect.
            if (msg.chatsSnapshot) {
                var _helloRerenderCurrent = false;
                Object.keys(msg.chatsSnapshot).forEach(function(cid) {
                    // PR383-F6: same pending prompt_user/approval row preservation
                    // as the agent-event inline-snapshot and chat-snapshot paths
                    // (RES-5 / _mergePagePendingRows) — the wholesale replace here
                    // wiped page-only pending rows on every reconnect hello.
                    _mergePagePendingRows(chats[cid], msg.chatsSnapshot[cid], cid);
                    chats[cid] = msg.chatsSnapshot[cid];
                    if (typeof currentChatId !== 'undefined' && cid === currentChatId) _helloRerenderCurrent = true;
                });
                // PR383-F6: mirror the chat-snapshot path's re-render so a
                // preserved pending form/approval on the focused chat is painted
                // from the merged copy instead of a stale DOM.
                if (_helloRerenderCurrent && typeof renderMessages === 'function') {
                    try { renderMessages(); } catch (e) {}
                }
            }
            // REG-F1: cids whose page-side running flag is dropped by the
            // reconcile-DOWN loop below — their foreground-UI cleanup is
            // deferred to the grace reconcile rather than run synchronously.
            var _helloStaleCleanupCids = [];
            if (msg.runningChatIds) {
                // SWM-RETRYF2: reconcile-DOWN. The bus onDisconnect (RETRY-F2 @:110)
                // clears ALL runningChatIds on ANY disconnect — including a transient
                // flap while the SW keeps streaming — so the page can be left with a
                // runningChatId the SW is NOT actually running (pending runAgent
                // promises now survive the flap and settle below — SWM-S2). The proper
                // debounce / reconcile redesign is a deferred design change (see
                // changelog); this is the SAFE half: treat the hello snapshot as
                // authoritative and DROP any page-side runningChatId ABSENT from it, so
                // the UI self-heals after a flap. (The UP direction — adding ids the SW
                // resumed — is the loop below.)
                var _helloRunning = Object.create(null);
                msg.runningChatIds.forEach(function(cid) { _helloRunning[cid] = true; });
                Object.keys(runningChatIds).forEach(function(cid) {
                    if (!_helloRunning[cid]) {
                        delete runningChatIds[cid];
                        // SWM-S3/REG-F1: no runFinished may ever come for this chat —
                        // but the SW may equally be about to resume it from checkpoint
                        // or process a run-agent we just re-posted. Don't wipe the
                        // foreground streaming UI synchronously; queue it for the
                        // deferred grace reconcile, which re-checks live state.
                        _helloStaleCleanupCids.push(cid);
                    }
                });
                msg.runningChatIds.forEach(function(cid) {
                    runningChatIds[cid] = true;
                });
                if (typeof renderChatList === 'function') renderChatList();
                // Reopening the panel while a background chat runs must also
                // surface it in the jobs badge/dropdown. renderChatList alone
                // refreshes the sidebar but not the badge (whose Active Chats
                // group reads getActiveChatsList()).
                if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
                // ...and re-render an already-open jobs dropdown so a newly
                // discovered background run shows without needing a reopen.
                if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') {
                    try { var _jdHello = _getOpenJobsDropdown(); if (_jdHello) renderJobsDropdown(_jdHello); } catch (e) {}
                }
            }
            // SWM-S2/REG-F1: settle pending runAgent promises ONLY for chats the
            // SW does NOT report as running — but NOT synchronously. This hello
            // was posted BEFORE resumeRunningCheckpoints re-arms checkpointed
            // runs and before any run-agent posted during the reconnect gap was
            // processed, so a chat can be missing from _helloLive yet come back
            // seconds later. Settling here finalized actions and wiped streaming
            // UI for those runs. Capture the orphan candidates (entry identity
            // included) and defer the reconcile via _armHelloGraceReconcile,
            // which re-checks live state before acting.
            // SWM-S3 (companion): stale foreground streaming-UI cleanup for
            // chats the SW isn't running rides the same grace timer.
            var _helloLive = Object.create(null);
            (msg.runningChatIds || []).forEach(function(cid) { _helloLive[cid] = true; });
            var _helloOrphans = {};
            Object.keys(_pendingRunAgents).forEach(function(cid) {
                if (!_helloLive[cid]) _helloOrphans[cid] = _pendingRunAgents[cid];
            });
            var _helloCleanups = {};
            _helloStaleCleanupCids.forEach(function(cid) { _helloCleanups[cid] = true; });
            if (typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId && !_helloLive[activeStreamingChatId]) {
                _helloCleanups[activeStreamingChatId] = true;
            } else if (typeof isRunning !== 'undefined' && isRunning &&
                       typeof currentChatId !== 'undefined' && currentChatId && !_helloLive[currentChatId]) {
                _helloCleanups[currentChatId] = true;
            }
            _armHelloGraceReconcile(_helloOrphans, _helloCleanups);
            // Install initial sub-agent snapshot. The page's own
            // loadAllSubAgents at boot rehydrates from IDB so the strip
            // can paint before the SW connects, but the SW is the
            // authority during a session — overwrite the page mirror
            // with the SW's view as soon as we hear from it. After this,
            // live updates flow via the `subagent-snapshot` case below.
            if (msg.subAgentRecords && typeof SubAgents !== 'undefined' && SubAgents.applySnapshot) {
                SubAgents.applySnapshot(msg.subAgentRecords);
            }
            return;

        case 'resume-scan-done':
            // REG-AUDIT-2: the SW's checkpoint resume scan is decided. Just
            // record it — do NOT run the reconcile early; the grace timer
            // (or its one-shot extension) fires on schedule and re-checks
            // live state then.
            _swResumeScanSettledSeen = true;
            return;

        case 'subagent-snapshot':
            // SW pushed a registry snapshot. Full-replace via the
            // registry helper, which fires the page's _notifyListeners
            // so the workers strip + chat list re-render.
            if (typeof SubAgents !== 'undefined' && SubAgents.applySnapshot) {
                SubAgents.applySnapshot(msg.records || []);
            }
            return;

        case 'chat-snapshot':
            if (msg.chatId && msg.chat) {
                // RES-5: same pending-row preservation as the agent-event
                // inline-snapshot path above.
                _mergePagePendingRows(chats[msg.chatId], msg.chat, msg.chatId); // PR383-F3: chatId for approval re-key
                chats[msg.chatId] = msg.chat;
                if (msg.chatId === currentChatId && typeof renderMessages === 'function') {
                    renderMessages();
                }
            }
            return;

        case 'exec-tool':
            // Offscreen wants this panel to run a UI-required tool.
            // Use the existing executeTool (which is defined in
            // tools/020-tool-execution.js and dispatches every tool).
            _handleExecToolFromOffscreen(msg);
            return;

        case 'exec-approval-prompt':
            // Offscreen needs an approval for an 'ask' permission.
            _handleApprovalPromptFromOffscreen(msg);
            return;
    }
}

// Best-effort post on the bus port. The port reference can flip to null
// between the existence check and the actual postMessage call (Chrome fires
// onDisconnect synchronously inside that very window if the SW dies
// mid-call), and postMessage on a stale port throws. Wrapping isolates
// that failure from the tool result path — the buffered
// _completedToolResults entry below still lets the next SW reconcile via
// panel-hello.
//
// BUG FIX (port throw clobbers result): previously this lived inline in
// the try arm of _handleExecToolFromOffscreen. A postMessage throw would
// fall into the surrounding catch arm, which would set capturedError to
// the postMessage error and DROP the successful capturedResult. The
// reconcile then handed the SW an "error" result for a tool that
// actually succeeded.
function _postExecToolResult(envelope) {
    if (!_agentBusPort) return false;
    try {
        _agentBusPort.postMessage(envelope);
        return true;
    } catch (_) {
        return false;
    }
}

async function _handleExecToolFromOffscreen(msg) {
    _inflightToolCalls[msg.toolCallId] = {
        chatId: msg.chatId,
        name: msg.name,
        startedAt: Date.now()
    };
    var capturedResult = null;
    var capturedError = null;
    try {
        // messageIndex forwarded by the SW wrapper (via sandboxCtx → exec-tool
        // envelope) so page-executed tools stamp recordMutated entries with the
        // real assistant-message index instead of -1.
        capturedResult = await executeTool(msg.name, msg.input, (typeof msg.messageIndex === 'number' ? msg.messageIndex : undefined), {
            toolCallId: msg.toolCallId,
            chatId: msg.chatId,
            // Forwarded by the SW wrapper when this UI tool was dispatched from
            // inside a sandbox (js_eval / skill). Lets executeDisplay's
            // eager-render path attach to the parent tool_result slot.
            fromSandbox: !!msg.fromSandbox,
            parentToolCallId: msg.parentToolCallId || null
        });
    } catch (e) {
        capturedError = (e && e.message) ? e.message : String(e);
    }
    // Post AFTER the tool result is captured so a transient port-throw can
    // never clobber the result. If the post fails the buffered entry below
    // will replay via the next panel-hello.
    _postExecToolResult(capturedError
        ? { type: 'exec-tool-result', toolCallId: msg.toolCallId, error: capturedError }
        : { type: 'exec-tool-result', toolCallId: msg.toolCallId, result: capturedResult });
    delete _inflightToolCalls[msg.toolCallId];
    // Buffer the result so a reconnect after a SW restart can re-post
    // it. Without this buffer, if the SW died after dispatch but
    // before saving the result, the next SW would re-dispatch and the
    // tool (e.g. iframe_tool 'type') would execute twice.
    _completedToolResults[msg.toolCallId] = {
        chatId: msg.chatId,
        name: msg.name,
        result: capturedResult,
        error: capturedError,
        completedAt: Date.now()
    };
}

async function _handleApprovalPromptFromOffscreen(msg) {
    try {
        // The page-side approval prompt lives in ui/160-notifications.js
        // (showToolApprovalPrompt). It's bound to the chat's UI and pushes
        // an `approval` message that the user clicks. Returns true/false.
        var approved = false;
        if (typeof showToolApprovalPrompt === 'function') {
            approved = await showToolApprovalPrompt(
                msg.displayName,
                msg.args,
                msg.permissionKey,
                msg.toolCallId,
                msg.toolName,
                msg.chatId,
                // Forward widgetName (set by the SW envelope when the call
                // originated from a widget) so the notification is labeled
                // with the widget's title instead of the chat title.
                { widgetName: msg.widgetName || undefined }
            );
        }
        if (_agentBusPort) {
            _agentBusPort.postMessage({
                type: 'exec-approval-prompt-result',
                approvalRequestId: msg.approvalRequestId,
                allowed: !!approved
            });
        }
    } catch (e) {
        if (_agentBusPort) {
            _agentBusPort.postMessage({
                type: 'exec-approval-prompt-result',
                approvalRequestId: msg.approvalRequestId,
                allowed: false,
                error: (e && e.message) ? e.message : String(e)
            });
        }
    }
}

// =============================================================
// runAgent shim — overrides the in-page implementation from
// app/030-agent-loop.js (last function declaration wins).
//
// Signature MUST match the original (async function runAgent(overrideChatId))
// because there are ~15 call sites across the page bundle that
// `await` it. The Promise resolves when the offscreen runtime emits
// `runFinished` for the requested chat.
// =============================================================
async function runAgent(overrideChatId) {
    var chatId = overrideChatId || currentChatId;
    if (!chatId) return;
    if (runningChatIds[chatId]) {
        // Match in-page semantics: don't start a second loop for a chat
        // that's already running. Caller's await still completes when
        // the existing run does.
        if (_pendingRunAgents[chatId]) return _pendingRunAgents[chatId].promise;
        return;
    }
    // Mark running locally so the UI (chat list pill, pause button) reflects
    // it immediately. Offscreen will emit runStarted soon, which will set
    // the foreground state via the page handlers.
    runningChatIds[chatId] = true;

    // SWM-S2: reuse an existing pending entry instead of overwriting it. With
    // pending promises now surviving a port flap (settled on hello, not on
    // disconnect), a Retry/Send during the gap lands here with runningChatIds
    // cleared but the old promise still pending — a fresh entry would orphan
    // the earlier caller's await forever (its resolve fn is dropped).
    var _pendingEntry = _pendingRunAgents[chatId];
    if (!_pendingEntry) {
        var resolveFn;
        var p = new Promise(function(resolve) { resolveFn = resolve; });
        _pendingEntry = { resolve: resolveFn, promise: p };
        _pendingRunAgents[chatId] = _pendingEntry;
    }

    // Make sure the port is open. The async retry in _openAgentBus
    // means it may not be there yet at boot; queue and try shortly.
    var attempt = function() {
        if (!_agentBusPort) {
            setTimeout(attempt, 50);
            return;
        }
        try {
            _agentBusPort.postMessage({
                type: 'run-agent',
                chatId: chatId,
                chat: chats[chatId],
                // Offscreen has no UI / settings DOM — currentProvider on its
                // side is empty until we tell it which provider to use. Send
                // the active provider on every run-agent so offscreen picks
                // the same model the user has selected.
                currentProvider: (typeof currentProvider !== 'undefined') ? currentProvider : ''
            });
        } catch (e) {
            // Port died between check and post — retry.
            setTimeout(attempt, 50);
        }
    };
    attempt();
    return _pendingEntry.promise;
}

// Push a chat update to offscreen (used by panel-side mutations
// outside an agent run, e.g. title rename, manual message edit).
function pushChatUpdateToOffscreen(chatId) {
    if (!_agentBusPort || !chatId || !chats[chatId]) return;
    try {
        _agentBusPort.postMessage({
            type: 'update-chat',
            chatId: chatId,
            chat: chats[chatId]
        });
    } catch (e) {}
}

// Toggle pause from the page side (the existing togglePause UI calls
// into this and pushes the new state to offscreen).
// SWM14-F5: per-chat latest-wins tokens for pause toggles. A rapid Pause→Resume
// during a port-down window spawns two independent retry chains (paused=true then
// paused=false); without these they can post out of order and leave the SW in the
// WRONG final pause state. Each fresh (non-retry) call bumps the chat's generation
// and records the latest desired value; a retry carries its generation and no-ops if
// a newer toggle superseded it, and always posts the CURRENT latest desired value.
var _pauseToggleGen = Object.create(null);
var _pauseToggleDesired = Object.create(null);

function pushPauseToggleToOffscreen(chatId, paused, _retries, _gen) {
    if (!chatId) return;
    // SWM14-F5: allocate/refresh the generation on a fresh call; drop a superseded
    // stale chain; always act on the CURRENT latest desired value for this chat.
    if (_gen === undefined) {
        _gen = (_pauseToggleGen[chatId] || 0) + 1;
        _pauseToggleGen[chatId] = _gen;
        _pauseToggleDesired[chatId] = !!paused;
    } else if (_gen !== _pauseToggleGen[chatId]) {
        return; // a newer Pause/Resume for this chat superseded this chain — drop it
    }
    var _desired = _pauseToggleDesired[chatId];
    // Don't silently drop the toggle during the ~250ms+ window while
    // _openAgentBus re-connects after a SW eviction — a dropped pause means the
    // SW never aborts and the run keeps going. Retry briefly (mirrors runAgent's
    // attempt() loop) so the pause reliably reaches the SW.
    if (!_agentBusPort) {
        // SWM4F-1: don't give up after the bounded ~1s retry. On a slow SW
        // reconnect a bare return left the UI showing "paused" while the SW
        // kept streaming. On exhaustion force-reopen the bus and keep trying
        // with a reset counter so the toggle eventually lands.
        if ((_retries || 0) < 20) { setTimeout(function() { pushPauseToggleToOffscreen(chatId, _desired, (_retries || 0) + 1, _gen); }, 50); }
        else { try { _openAgentBus(); } catch (e) {} setTimeout(function() { pushPauseToggleToOffscreen(chatId, _desired, 0, _gen); }, 250); }
        return;
    }
    try {
        _agentBusPort.postMessage({
            type: 'toggle-pause',
            chatId: chatId,
            paused: !!_desired
        });
    } catch (e) {
        // SWM4F-1: same exhaustion fallback as the no-port guard above.
        if ((_retries || 0) < 20) { setTimeout(function() { pushPauseToggleToOffscreen(chatId, _desired, (_retries || 0) + 1, _gen); }, 50); }
        else { try { _openAgentBus(); } catch (e2) {} setTimeout(function() { pushPauseToggleToOffscreen(chatId, _desired, 0, _gen); }, 250); }
    }
}

// Push the new hooksEnabled to the SW after the user toggles a hook in
// settings. Without this the SW keeps the boot-time hooksEnabled until the
// next SW restart, so toggleHook from the panel wouldn't take effect on
// the agent loop (which now runs in the SW).
function pushHooksSettingsToOffscreen(hooks) {
    if (!_agentBusPort || !hooks) return;
    try {
        _agentBusPort.postMessage({
            type: 'hooks-settings',
            hooksEnabled: hooks
        });
    } catch (e) {}
}

// Push permission state changes to the SW. The page-side `getToolPermission`
// reads three sources: `toolPermissions` (IDB-persisted, "always allow"),
// `instancePermissions` (IDB-persisted per-host), and `sessionPermissions`
// (in-memory only, "allow until close"). With the agent loop relocated to
// the SW, the SW has its OWN copies of these globals — `toolPermissions` /
// `instancePermissions` are hydrated from IDB at SW boot, but session-only
// changes and any post-boot mutation must be mirrored or the SW's
// `getToolPermission` will return 'ask' and the approval prompt fires on
// every tool call even after the user picked "Allow for session" or
// "Always allow". The mirror is best-effort; if the port is down the next
// reconnect's hello flow plus the SW's IDB load will catch up the
// persisted ones (session-only choices ARE lost across SW restart, same
// as a page reload).
function pushPermissionsToOffscreen(patch) {
    if (!_agentBusPort || !patch) return;
    try {
        _agentBusPort.postMessage({
            type: 'permissions-update',
            toolPermissions: patch.toolPermissions || null,
            instancePermissions: patch.instancePermissions || null,
            sessionPermissions: patch.sessionPermissions || null
        });
    } catch (e) {}
}

// SAGF-1: tell the SW which chat the user is now viewing so the sub-agent GC
// paths (_idleSweepTick / loadAllSubAgents) don't reclaim a transcript the user
// is actively reading. Best-effort — the GC TTLs are minutes-to-hours so a
// transient miss during a bus reconnect can't realistically race a sweep, and
// the next selectChat / openChatFromHistory re-posts the focus anyway.
function pushFocusChatToOffscreen(chatId) {
    if (!_agentBusPort) return;
    try {
        _agentBusPort.postMessage({ type: 'focus-chat', chatId: chatId || null });
    } catch (e) {}
}

// Send an interrupt (user pressed send during a tool call).
// SWM14-F5: per-chat latest-wins tokens for the interrupt push — same rationale as
// the pause toggle above: rapid interrupts during a port-down window must not post
// out of order. Generation supersedes a stale retry chain; the desired
// fromUserMessage is always read fresh. (All current callers pass false, so this is
// belt-and-suspenders, but it keeps the two retry primitives symmetric.)
var _interruptGen = Object.create(null);
var _interruptDesired = Object.create(null);

function pushInterruptToOffscreen(chatId, fromUserMessage, _retries, _gen) {
    if (!chatId) return;
    if (_gen === undefined) {
        _gen = (_interruptGen[chatId] || 0) + 1;
        _interruptGen[chatId] = _gen;
        _interruptDesired[chatId] = !!fromUserMessage;
    } else if (_gen !== _interruptGen[chatId]) {
        return; // a newer interrupt for this chat superseded this chain — drop it
    }
    var _fum = _interruptDesired[chatId];
    // Don't silently drop the interrupt during the ~250ms+ window while
    // _openAgentBus re-connects after a SW eviction — a dropped interrupt means
    // the SW never aborts the in-flight tool/stream. Retry briefly (mirrors
    // runAgent's attempt() loop) so the interrupt reliably reaches the SW.
    if (!_agentBusPort) {
        // SWM4F-1: don't give up after the bounded ~1s retry. On a slow SW
        // reconnect a bare return left the UI showing the run as interrupted
        // while the SW kept streaming. On exhaustion force-reopen the bus and
        // keep trying with a reset counter so the interrupt eventually lands.
        if ((_retries || 0) < 20) { setTimeout(function() { pushInterruptToOffscreen(chatId, _fum, (_retries || 0) + 1, _gen); }, 50); }
        else { try { _openAgentBus(); } catch (e) {} setTimeout(function() { pushInterruptToOffscreen(chatId, _fum, 0, _gen); }, 250); }
        return;
    }
    try {
        _agentBusPort.postMessage({
            type: 'interrupt',
            chatId: chatId,
            fromUserMessage: !!_fum
        });
    } catch (e) {
        // SWM4F-1: same exhaustion fallback as the no-port guard above.
        if ((_retries || 0) < 20) { setTimeout(function() { pushInterruptToOffscreen(chatId, _fum, (_retries || 0) + 1, _gen); }, 50); }
        else { try { _openAgentBus(); } catch (e2) {} setTimeout(function() { pushInterruptToOffscreen(chatId, _fum, 0, _gen); }, 250); }
    }
}

// SWM14-T3: symmetric no-post supersede for the interrupt retry primitive. A stale
// interrupt(false) retry chain armed during a prior port-down window can survive a fresh
// send and, on reconnect, abort the new stream + delete the just-queued pendingInjection.
// Bumping the generation (without posting) invalidates any in-flight retry chain carrying
// an older _gen (it no-ops at the `_gen !== _interruptGen[chatId]` guard), mirroring the
// pause supersede done at the send sites (SWM14-T1).
function _supersedeInterruptToggle(chatId) {
    if (!chatId) return;
    _interruptGen[chatId] = (_interruptGen[chatId] || 0) + 1;
    _interruptDesired[chatId] = false;
}

// SWM-TOKENLEAK: prune all four per-chat pause/interrupt latest-wins token maps
// for a chat. Intended to be called from the page-side chat-delete path
// (deleteChat in src/js/ui/170-chat-management.js) so a chat paused-and-never-
// resumed then deleted doesn't leak its 4 entries forever — the runFinished
// cleanup above only prunes on a NON-paused terminal event, which a deleted
// still-paused chat never receives. Safe to call any time (idempotent).
function _pruneChatPauseTokens(chatId) {
    if (!chatId) return;
    delete _pauseToggleGen[chatId];
    delete _pauseToggleDesired[chatId];
    delete _interruptGen[chatId];
    delete _interruptDesired[chatId];
}

// Open the port now. We don't wait for Platform.ready because the
// SW is independent of session token state.
_openAgentBus();

// AGENT_PORT_BRIDGE_PAGE_SENTINEL
