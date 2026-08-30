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
        // The run evaporated WITHOUT a terminal runFinished event (SW restart /
        // reconnect flap). The grace reconcile already re-checked that the chat is
        // no longer running, so stamp it finished now — otherwise it never enters
        // the 5-minute linger and drops out of Active Chats the instant the SW
        // flaps. (No-op for background/sub chats, which markChatRecentlyFinished
        // intentionally skips.)
        if (typeof markChatRecentlyFinished === 'function') { try { markChatRecentlyFinished(chatId); } catch (e) {} }
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
    // runtime_inspect dev-mode handshake: (re)push the dev-mode flag on every
    // bus (re)connect so a restarted SW relearns it — the SW keeps it only in
    // memory (tools/140-runtime-inspect.js).
    try { if (typeof _pushDevModeToSW === 'function') _pushDevModeToSW(); } catch (e2) { /* non-fatal */ }
}

// WSM-RELAY: page-local `workspaceMutated` emits (user-clicked restore/discard
// in the files sidebar run executeWorkspaceTool in THIS page bundle) only fire
// on this panel's local bus — other open panels (side panel + tab) never hear
// them and keep a stale header badge / files sidebar. Relay them to the SW,
// which re-emits on its bus; the worker/100 broadcast patch then forwards to
// every connected panel. Guards: _relayed (stamped by the SW re-emit) and
// _fromBus (stamped by the passthrough re-emit in _handleAgentBusMessage)
// prevent ping-pong for events that originated in the SW or already made a
// relay round-trip.
var _wsRelayHooked = false;
function _hookLocalWorkspaceRelay() {
    if (_wsRelayHooked) return;
    if (typeof AgentEvents === 'undefined' || !AgentEvents || !AgentEvents.on) return;
    _wsRelayHooked = true;
    AgentEvents.on('workspaceMutated', function(ev) {
        if (!ev || ev._relayed || ev._fromBus) return;
        try {
            if (_agentBusPort) _agentBusPort.postMessage({ type: 'relay-agent-event', eventType: 'workspaceMutated', detail: ev });
        } catch (e) { /* stale port — the reconnect path reopens the bus */ }
    });
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
    _hookLocalWorkspaceRelay();
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
    // F6 (flux single-writer): panels NEVER push permission state at hello.
    // The SW is the permissions authority — it hydrates tool/instance maps
    // from IDB at its own boot (loadToolPermissionsInWorker, worker/190-entry)
    // and ships its in-memory session map DOWN in the 'hello' envelope. The
    // old boot-time mirror push here was the QW9 wipe bug: a fresh panel's
    // `{}` sessionPermissions passed the typeof guard, the SW applied it as
    // a change, and the rebroadcast revoked "Allow for session" grants in
    // EVERY panel. The only thing sent on (re)connect now is a queued EDIT
    // that failed while the port was down (pushPermissionsToOffscreen's
    // queue) — an explicit user action, never a boot-state mirror.
    _flushPendingPermPatch();
    _flushPendingChatMetaPatches();
}

// RES-5: preserve page-only PENDING interactive rows across SW chat-snapshot
// replaces. Page-side tools push `prompt_user` (and the approval prompt pushes
// `approval`) rows into the PAGE mirror only — they are mirrored into the SW's
// authoritative copy AFTER they resolve (result._message_persist for
// prompt_user; the decision write-back for approvals). Any snapshot that
// arrives while one is still pending — e.g. a sub-agent progress repaint
// (recordSubActionState → _repaintParent → messagesAppended, which
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
        if (dup) {
            // MP-4 (multi-panel): the SW snapshot now CONTAINS prompt_user rows
            // (seeded at dispatch — see _swSeedPromptRow). When both copies are
            // still pending, keep the PAGE's own object: object identity matters
            // (executePromptUser holds it for result._message_persist and
            // submitPromptUser mutates it) and it carries promptCaptureDraft's
            // draft values. When the snapshot copy is RESOLVED (remote panel
            // submitted/cancelled first, or abandon cleanup), the snapshot wins
            // so the local form dismisses/reconciles to read-only.
            if (rm.role === 'prompt_user' && rn && rn.status === 'pending') {
                inChat.messages[rj] = rm;
            }
            continue;
        }
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

// JOBS-UNREAD: page-owned jobs-list metadata must survive SW chat-snapshot
// replaces. The unread/bold + linger predicates (tools/120-actions.js) read
// lastResponseAt / lastActivityAt / lastViewedAt, and the dropdown's 'remove
// from list' uses _jobsHidden — since FLUX-4C those are stamped through the
// SW-canonical chat-meta lane (dispatchChatMeta below), so the SW snapshot is
// authoritative for them and this merge no longer touches them. The wholesale `chats[chatId] = snapshot` assignment
// dropped the stamps: a jobs row went bold on markChatActivity, then the next
// inlined snapshot (e.g. the silent title/tldr hook's runStarted ~1s after
// the run finished) wiped lastResponseAt/lastActivityAt and the repaint
// un-bolded it. Keep the NEWEST value of each timestamp and preserve the
// page's _jobsHidden flag when the snapshot lacks it (deleting the flag
// page-side leaves it undefined on prev, so a re-run's un-hide sticks).
function _mergePageChatMeta(prevChat, inChat) {
    if (!prevChat || !inChat) return;
    // STUB-HEAL: `_revealed` is a PAGE-ONLY flag (revealSubAgentChat,
    // ui/175-sub-agent-ui.js) — the SW copy / disk row of a sub chat may
    // lack it (an empty revealed stub is never persisted: save loops skip
    // 0-message chats). Keep it across wholesale snapshot adopts so a
    // revealed background chat doesn't vanish from the sidebar when a
    // hello / chat-snapshot / pull-chat-heal envelope replaces the entry.
    if (prevChat._revealed && inChat._revealed === undefined) inChat._revealed = true;
    // FLUX-4C (narrow pull-forward): the seven chat-meta fields
    // (lastResponseAt/lastActivityAt/lastViewedAt/updatedAt + _jobsHidden/
    // pinned/_lastApiError) are SW-CANONICAL now — every page writer
    // dispatches 'chat-meta-update' (dispatchChatMeta below); the SW applies,
    // persists and rebroadcasts 'chat-meta-changed'. An incoming SW snapshot
    // is therefore at least as fresh as any legitimately-written page value,
    // so the old max-wins timestamp arm and undefined-wins flag arm are GONE
    // (the flag arm was the F3 laundering rule: a stale DEFINED flag from
    // another panel round-tripped through run-agent adopt → snapshot → this
    // merge → the page's blind put, defeating the SW put-side protection).
    // Only the page-only displays state below still needs preserving until
    // Phase 4a/4b event-payload completeness lands.
    // FLUX-QW7: keep the page's newer checklist-toggle state when an SW
    // snapshot replaces the chat. The page stamps entry._toggledAt on every
    // toggle (tools/090-display-templates.js); the SW only creates display
    // entries, so a mid-run snapshot would otherwise revert just-clicked
    // boxes. Union per displayId, newest _toggledAt wins.
    // FLUX-T1 (title lane): keep the page's OPTIMISTIC rename when a chat
    // snapshot generated BEFORE the SW applied the dispatch lands here —
    // pair max-wins, mirroring the lane echo that will confirm it (belt and
    // braces: without this the title flickers old→new). Strict >: an equal
    // stamp is the same lane generation and the SW snapshot wins.
    if (typeof prevChat.titleUpdatedAt === 'number' && isFinite(prevChat.titleUpdatedAt)
        && typeof prevChat.title === 'string' && prevChat.title
        && prevChat.titleUpdatedAt > (inChat.titleUpdatedAt || 0)) {
        inChat.title = prevChat.title;
        inChat.titleUpdatedAt = prevChat.titleUpdatedAt;
        if (prevChat.titleProvisional === true) inChat.titleProvisional = true;
        else delete inChat.titleProvisional;
    }
    if (prevChat.displays) {
        // FLUX-6: same per-id union the put paths use (_unionChatDisplaysForPut,
        // core/130-indexeddb.js) — one implementation, no drift: keep the
        // snapshot's entry unless the page's _toggledAt is strictly newer, add
        // page-only ids. Returns null when the snapshot already has it all.
        var _du = _unionChatDisplaysForPut(inChat.displays, prevChat.displays);
        if (_du) inChat.displays = _du;
    }
}

// MEMFIX-EVDELTA: heavy-payload graft. SW broadcasts now strip screenshot
// base64 / cachedToolResults fullContent from inlined snapshots and delta
// meta (worker/100-agent-event-broadcast.js _slimChatSnapshot). When the
// page's previous copy still holds the hydrated entry, keep it — otherwise
// the entry stays flagged (_b64Evicted/_fcEvicted) and ensureChatPayloads
// (core/130-indexeddb.js) lazy-loads it on demand, exactly like a chat
// loaded from a payload-stripped record.
function _graftHeavyMap(prevMap, inMap, field, flag) {
    if (!prevMap || !inMap) return;
    for (var id in inMap) {
        var ie = inMap[id];
        if (ie && ie[flag] && ie[field] === undefined) {
            var pe = prevMap[id];
            if (pe && pe[field] !== undefined) inMap[id] = pe;
        }
    }
}
function _mergePageHeavyPayloads(prevChat, inChat) {
    if (!prevChat || !inChat) return;
    _graftHeavyMap(prevChat.screenshots, inChat.screenshots, 'base64', '_b64Evicted');
    _graftHeavyMap(prevChat.cachedToolResults, inChat.cachedToolResults, 'fullContent', '_fcEvicted');
}

// FLUX-ADOPT (#836): staleness compare for wholesale chat-row adopts.
// Returns true when `row` must NOT replace `prev`: rev compare when BOTH
// carry the per-chat monotonic revision (stamped SW-side at the broadcast
// choke point, worker/100-agent-event-broadcast.js), else the pre-rev
// fallback heuristic — never adopt a row with FEWER messages over one with
// more. Equal rev / equal count adopts (SW snapshot wins ties, matching the
// pre-guard wholesale-assign semantics).
function _chatRowStaler(row, prev) {
    var rRev = (row && typeof row.rev === 'number' && isFinite(row.rev)) ? row.rev : null;
    var pRev = (prev && typeof prev.rev === 'number' && isFinite(prev.rev)) ? prev.rev : null;
    if (rRev !== null && pRev !== null) return rRev < pRev;
    var rN = (row && Array.isArray(row.messages)) ? row.messages.length : 0;
    var pN = (prev && Array.isArray(prev.messages)) ? prev.messages.length : 0;
    return rN < pN;
}

// FLUX-ADOPT (#836): the ONE sanctioned wholesale page-map chat adopt path.
// Every `chats[id] = <full row>` replace of a possibly-existing entry goes
// through here — the agent-event inline-snapshot lane, the hello
// chatsSnapshot loop, the 'chat-snapshot' (pull-chat reply) lane, the boot
// carry-forward (ui/070-dashboard-ui.js, via opts.map) and the import paths
// (ui/130-data-management.js / ui/210-chat-menus.js, force:true). The guard
// refuses to replace a FRESHER existing copy (see _chatRowStaler); an
// accepted adopt runs the standard page-preservation merges (RES-5 pending
// rows, JOBS-UNREAD/_-flag meta, MEMFIX-EVDELTA heavy payloads) BEFORE the
// assign so the merges can never fire for a refused row. opts:
//   chatId — key when row.id is absent/differs
//   force  — bypass the staleness guard (import/restore paths)
//   map    — adopt into an alternate map (boot's `loaded`) instead of chats
// Returns true when the row was adopted. O(1) — no IDB reads, hot-path safe.
function adoptChatRow(row, opts) {
    opts = opts || {};
    var id = opts.chatId || (row && row.id);
    if (!row || !id) return false;
    var map = opts.map || chats;
    var prev = map[id];
    if (prev && prev !== row) {
        if (!opts.force && _chatRowStaler(row, prev)) return false;
        _mergePagePendingRows(prev, row, id); // PR383-F3: chatId for approval re-key
        _mergePageChatMeta(prev, row);
        _mergePageHeavyPayloads(prev, row);
    }
    if (opts.map) { opts.map[id] = row; } else { chats[id] = row; }
    return true;
}

// MEMFIX-EVDELTA: rebuild a full chat snapshot locally from a chatDelta
// envelope (worker/100-agent-event-broadcast.js _buildChatDelta): slim meta
// over the page's previous copy, previous messages up to fromIndex, the
// appended tail, then the known-mutable row updates (matched by role+key,
// index as a hint). Returns null when the page mirror can't absorb the delta
// (chat unseen, fewer messages than fromIndex, or an update row that can't
// be located) — the caller then falls back to a 'pull-chat' full resync.
function _locateDeltaRow(msgs, up) {
    var m = up.message;
    var keyField = m.role === 'prompt_user' ? 'promptId'
                 : m.role === 'sub_report' ? 'subAgentId'
                 : (m.role === 'approval' || m.role === 'tool') ? 'toolCallId' : null;
    var cand = (up.index >= 0 && up.index < msgs.length) ? msgs[up.index] : null;
    if (cand && cand.role === m.role && (!keyField || !m[keyField] || cand[keyField] === m[keyField])) return up.index;
    if (keyField && m[keyField]) {
        for (var i = msgs.length - 1; i >= 0; i--) {
            var c = msgs[i];
            if (c && c.role === m.role && c[keyField] === m[keyField]) return i;
        }
    }
    return -1;
}
function _synthesizeChatFromDelta(chatId, delta) {
    var prev = chats[chatId];
    if (!prev || prev._deleted || !Array.isArray(prev.messages)) return null;
    if (!delta || typeof delta.fromIndex !== 'number' || delta.fromIndex < 0) return null;
    if (prev.messages.length < delta.fromIndex) return null;
    var msgs = prev.messages.slice(0, delta.fromIndex);
    var tail = Array.isArray(delta.tail) ? delta.tail : [];
    for (var i = 0; i < tail.length; i++) msgs.push(tail[i]);
    if (Array.isArray(delta.updates)) {
        for (var u = 0; u < delta.updates.length; u++) {
            var up = delta.updates[u];
            if (!up || !up.message || typeof up.index !== 'number') continue;
            var idx = _locateDeltaRow(msgs, up);
            if (idx < 0) return null;
            msgs[idx] = up.message;
        }
    }
    var inChat = Object.assign({}, prev, delta.meta || {});
    inChat.messages = msgs;
    return inChat;
}

// MEMFIX-EVDELTA: full-resync fallback when a delta can't be applied. Uses
// the existing 'pull-chat' lane (worker/130-port-bridge.js), whose reply is
// the 'chat-snapshot' case below. Debounced per chat — several deltas can
// arrive before the snapshot lands.
var _pendingChatPulls = {};
function _requestChatPull(chatId) {
    if (!chatId || !_agentBusPort) return;
    var now = Date.now();
    if (_pendingChatPulls[chatId] && (now - _pendingChatPulls[chatId]) < 2000) return;
    _pendingChatPulls[chatId] = now;
    try { _agentBusPort.postMessage({ type: 'pull-chat', chatId: chatId }); } catch (e) {}
}

function _handleAgentBusMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
        case 'agent-event':
            // MEMFIX-EVDELTA: delta envelopes carry chatDelta instead of the
            // full chat. Rebuild a synthetic snapshot from the local mirror
            // and let it flow through the SAME merge path below (versionHistory
            // / widget / pending-row / meta guards all apply unchanged). A
            // failed rebuild (first sight of a background chat, gap, or row
            // divergence) requests a full snapshot instead — handlers still
            // re-emit off the stale mirror this tick and heal when the
            // 'chat-snapshot' reply lands.
            if (msg.detail && msg.detail.chatId && msg.detail.chatDelta && !msg.detail.chat) {
                // FLUX-REV (#836): gap detection. Every chat-inlining broadcast
                // bumps chat.rev exactly once (worker/100 broadcastAgentEvent),
                // so a delta whose rev is > known+1 means this panel MISSED an
                // envelope (update-only mutations can slip past the fromIndex/
                // lastRef structural checks below). Schedule the debounced
                // targeted full resync; still apply the delta best-effort so
                // the UI stays live until the snapshot lands. Rows without rev
                // (pre-#836 SW / old disk rows) skip this and behave as today.
                var _gapMeta = msg.detail.chatDelta.meta;
                var _gapPrev = chats[msg.detail.chatId];
                if (_gapMeta && typeof _gapMeta.rev === 'number' && _gapPrev
                    && typeof _gapPrev.rev === 'number' && _gapMeta.rev > _gapPrev.rev + 1) {
                    _requestChatPull(msg.detail.chatId);
                }
                var _synthChat = _synthesizeChatFromDelta(msg.detail.chatId, msg.detail.chatDelta);
                if (_synthChat) msg.detail.chat = _synthChat;
                else _requestChatPull(msg.detail.chatId);
            }
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
                // WIDGET-MERGE: a manual widget code save (saveWidgetCodeEdit in
                // tools/080-widget-tools.js) bumps contentVersion page-side and
                // mirrors to the SW over the bus ('widget-persist'), but a snapshot
                // generated BEFORE the SW processed that mirror can land here right
                // after the save — the wholesale replace below would revert the
                // page's fresh edit until the next snapshot. Keep the page copy
                // only when its contentVersion is STRICTLY greater (agent edit_html
                // bumps the page's live object first and mirrors synchronously via
                // the tool result, so a same-version tie means same content — the
                // snapshot may win it). Membership is untouched: page-only widgets
                // are NOT grafted in and snapshot-only widgets are kept (the SW
                // snapshot stays authoritative for the widget LIST).
                if (_prevChat && Array.isArray(_prevChat.widgets) && _prevChat.widgets.length
                    && Array.isArray(_inChat.widgets) && _inChat.widgets.length) {
                    var _inWIdx = {};
                    _inChat.widgets.forEach(function(w, i) { if (w && w.id) _inWIdx[w.id] = i; });
                    _prevChat.widgets.forEach(function(pw) {
                        if (!pw || !pw.id || !(pw.id in _inWIdx)) return;
                        var _iw = _inChat.widgets[_inWIdx[pw.id]];
                        if ((pw.contentVersion || 0) > ((_iw && _iw.contentVersion) || 0)) {
                            _inChat.widgets[_inWIdx[pw.id]] = pw;
                        }
                    });
                }
                // FLUX-ADOPT (#836): guarded adopt — runs the RES-5 pending-row,
                // JOBS-UNREAD meta and MEMFIX-EVDELTA heavy-payload merges, then
                // assigns. A refusal (incoming row staler than the page copy —
                // e.g. an empty SW stub after restart) keeps the mirror intact;
                // the re-emitted handlers read chats[chatId] and therefore see
                // the page's fresher copy, same as the delta-rebuild fallback.
                if (adoptChatRow(_inChat, { chatId: msg.detail.chatId })) {
                    // Re-point the active-chat versionHistory mirror: it referenced
                    // the replaced chat object's array, so sidebar/inline renders
                    // would otherwise read (and write flags into) a dangling copy.
                    if (msg.detail.chatId === currentChatId && typeof versionHistory !== 'undefined') {
                        if (!Array.isArray(_inChat.versionHistory)) _inChat.versionHistory = [];
                        versionHistory = _inChat.versionHistory;
                    }
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
                var _busDetail = msg.detail || {};
                // WSM-RELAY: mark bus-delivered workspaceMutated so the local
                // relay hook doesn't bounce it back to the SW (echo loop).
                if (msg.eventType === 'workspaceMutated') _busDetail = Object.assign({}, _busDetail, { _fromBus: true });
                AgentEvents.emit(msg.eventType, _busDetail);
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
            // F6: the hello envelope carries the SW's authoritative in-memory
            // session permission map. Overwrite — not merge — the page
            // replica: a fresh SW legitimately resets session grants (RFC
            // §4.5 phase-3 semantics), and a live SW seeds panels that
            // connect after "Allow for session" was granted elsewhere.
            if (msg.sessionPermissions && typeof msg.sessionPermissions === 'object') {
                sessionPermissions = msg.sessionPermissions;
                // FLUX-4/1: the hello map is applied SW authority — arm the
                // per-key diff baseline for the session slot too.
                if (typeof _permBaselineCapture === 'function') _permBaselineCapture('sessionPermissions', sessionPermissions);
                if (typeof renderToolPermissions === 'function') {
                    try { renderToolPermissions(); } catch (e) { /* settings view may not be mounted */ }
                }
            }
            // Offscreen sent us the running-chats snapshot + the list of
            // running chat ids. Merge into local state so the panel UI
            // reflects ongoing background runs immediately on connect.
            if (msg.chatsSnapshot) {
                var _helloRerenderCurrent = false;
                Object.keys(msg.chatsSnapshot).forEach(function(cid) {
                    // FLUX-ADOPT (#836): guarded adopt — keeps the PR383-F6
                    // pending-row, JOBS-UNREAD meta and MEMFIX-EVDELTA heavy-
                    // payload preservation, and additionally REFUSES a staler
                    // SW copy (a fresh SW's sparse map after restart must not
                    // clobber the fuller page copy on reconnect hello).
                    if (!adoptChatRow(msg.chatsSnapshot[cid], { chatId: cid })) return;
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
            // An open workspace dropdown may have painted BEFORE this hello
            // repopulated `chats` + the sub-agent mirror (post-reload race) —
            // its owning-chat chips resolved as "gone". Re-render it now that
            // both are authoritative (self-guards when no dropdown is open).
            if (typeof _reconcileDropdownSections === 'function') {
                try { _reconcileDropdownSections(); } catch (e) { /* non-fatal */ }
            }
            return;

        case 'permissions-changed':
            // QW9 (flux single-writer, step 1): the SW applied a permissions
            // delta (pushed by SOME panel via pushPermissionsToOffscreen) and
            // rebroadcast the changed slots to all panels. Overwrite this
            // panel's replicas so cross-panel edits converge without a
            // reload. Do NOT push back or persist here — the SW already
            // persisted the durable slots (F6 single writer), and re-pushing
            // would ping-pong. Boot-state mirror pushes no longer exist: the
            // hello lane only flows DOWNWARD (SW → panel), so a received map
            // is always the applied authority, never a cold panel's echo.
            if (msg.toolPermissions && typeof msg.toolPermissions === 'object') {
                toolPermissions = msg.toolPermissions;
                _permBaselineCapture('toolPermissions', toolPermissions);
            }
            if (msg.instancePermissions && typeof msg.instancePermissions === 'object') {
                instancePermissions = msg.instancePermissions;
                _permBaselineCapture('instancePermissions', instancePermissions);
            }
            if (msg.sessionPermissions && typeof msg.sessionPermissions === 'object') {
                sessionPermissions = msg.sessionPermissions;
                _permBaselineCapture('sessionPermissions', sessionPermissions);
            }
            // Refresh the settings permissions list if it's on screen.
            if (typeof renderToolPermissions === 'function') {
                try { renderToolPermissions(); } catch (e) { /* non-fatal — settings view may not be mounted */ }
            }
            return;

        case 'chat-meta-changed':
            // FLUX-4C: the SW applied a chat-meta dispatch (possibly OURS —
            // echo included, like 'permissions-changed') and rebroadcast the
            // applied fields. Idempotent apply: timestamps max-wins, flags
            // overwrite. Never re-dispatch or persist here (the SW already
            // persisted) — no loop.
            // Review fix B (repaint storm): repaint ONLY when the apply really
            // changed something. The echo to the dispatching panel is a no-op
            // there (dispatchChatMeta already applied the value optimistically),
            // and repainting on it unconditionally defeated both of
            // markChatActivity's deliberate no-render paths — the focused-chat
            // lastViewedAt stamp (tools/120-actions.js:2200-2204, zero repaints)
            // and the already-unread early return (tools/120-actions.js:2210) —
            // turning every streamed event into a full renderChatList +
            // renderJobsBadge + jobs-dropdown repaint, plus a double paint on
            // the panel that also painted itself. Panels that DID change (every
            // other panel) still repaint: echo-to-all is unchanged.
            if (msg.chatId && msg.fields && _applyChatMetaChangedFromSW(msg.chatId, msg.fields)) {
                _repaintChatMetaSurfaces();
            }
            return;

        case 'chat-meta-snapshot':
            // FLUX-H4 (reconnect anti-entropy): the SW pushed its authoritative
            // chat-meta map (7 lane fields per held chat) after its boot
            // hydration settled. Apply through the SAME idempotent path as
            // 'chat-meta-changed' above (max-wins ts, overwrite flags — flag
            // null = "store holds no opinion", reverting phantom optimistic
            // values the SW died holding), repaint ONCE if anything changed,
            // and never re-dispatch or persist — no echo loop. A queued
            // dispatch flushed on this same reconnect lands at the SW BEFORE
            // its boot gate resolves, so the snapshot already reflects it; a
            // late flush is self-healed by its own 'chat-meta-changed' echo.
            if (msg.chatMeta && typeof msg.chatMeta === 'object') {
                var _cmsChanged = false;
                Object.keys(msg.chatMeta).forEach(function(_cmsCid) {
                    try { if (_applyChatMetaChangedFromSW(_cmsCid, msg.chatMeta[_cmsCid])) _cmsChanged = true; } catch (e) {}
                });
                // FLUX-T1 (title retransmit): title has NO null=no-opinion
                // encoding in the snapshot (it is a VALUE — see
                // _serializeChatMetaSnapshot), so a phantom local pair the
                // dead SW never persisted cannot be reverted by it. Repair
                // the other way: when OUR replica holds a STRICTLY newer
                // pair than the snapshot's opinion (or the snapshot has
                // none), re-dispatch it once. This is a retransmit of a
                // lost LOCAL write, not an echo of an SW value (the apply
                // half never dispatches), so it terminates after one round
                // trip: the SW applies+persists, its echo matches our
                // replica, and no further snapshot fires.
                if (typeof chats !== 'undefined' && typeof dispatchChatMeta === 'function') {
                    Object.keys(chats).forEach(function(_cmsCid) {
                        try {
                            var _cmsLocal = chats[_cmsCid];
                            if (!_cmsLocal || _cmsLocal._deleted) return;
                            if (typeof _cmsLocal.titleUpdatedAt !== 'number' || !isFinite(_cmsLocal.titleUpdatedAt)
                                || typeof _cmsLocal.title !== 'string' || !_cmsLocal.title) return;
                            var _cmsIn = msg.chatMeta[_cmsCid];
                            if (_cmsIn && (_cmsIn.titleUpdatedAt || 0) >= _cmsLocal.titleUpdatedAt) return;
                            var _cmsPatch = { title: _cmsLocal.title, titleUpdatedAt: _cmsLocal.titleUpdatedAt };
                            if (_cmsLocal.titleProvisional === true) _cmsPatch.titleProvisional = true;
                            dispatchChatMeta(_cmsCid, _cmsPatch);
                        } catch (e) {}
                    });
                }
                if (_cmsChanged) _repaintChatMetaSurfaces();
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
                delete _pendingChatPulls[msg.chatId];
                // FLUX-ADOPT (#836): guarded adopt — same preservation merges
                // as before (RES-5 pending rows, JOBS-UNREAD meta, heavy
                // payloads), plus the staleness guard: a pull reply OLDER than
                // the page copy (SW restarted onto a stale disk row — the #835
                // class) is refused instead of regressing the mirror.
                if (adoptChatRow(msg.chat, { chatId: msg.chatId })
                    && msg.chatId === currentChatId && typeof renderMessages === 'function') {
                    renderMessages();
                }
            }
            return;

        case 'debug-state':
            // runtime_inspect action:'sw_state' reply (see the
            // 'pull-debug-state' case in worker/130-port-bridge.js). Resolver
            // lives in tools/140-runtime-inspect.js (page bundle).
            if (typeof _riResolveDebugState === 'function') _riResolveDebugState(msg);
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

        case 'prompt-user-remote-result':
            // MP-2: another panel submitted/cancelled a prompt_user form whose
            // blocked await lives HERE (this panel is the executor), or the SW
            // abandoned the call. Settle the local resolver so executePromptUser
            // returns through its normal path.
            _handleRemotePromptResult(msg);
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
        // AB (approval broadcast): the SW fans this prompt out to EVERY panel
        // (worker/120-tool-routing.js _broadcastApprovalPrompt); exactly one
        // copy is `primary`. opts is shared with showToolApprovalPrompt so its
        // missing-chat give-up can mark _gaveUp: a NON-primary panel whose
        // mirror lacks the chat bows out SILENTLY — posting allowed:false
        // would race-deny an approval other panels still show. The primary
        // keeps the give-up denial as the ultimate backstop (status quo).
        // osNotify:false suppresses duplicate OS notifications on fan-out /
        // re-delivery copies (ui/220-notification-system.js).
        var opts = {
            // Forward widgetName (set by the SW envelope when the call
            // originated from a widget) so the notification is labeled
            // with the widget's title instead of the chat title.
            widgetName: msg.widgetName || undefined,
            osNotify: msg.osNotify !== false
        };
        if (typeof showToolApprovalPrompt === 'function') {
            approved = await showToolApprovalPrompt(
                msg.displayName,
                msg.args,
                msg.permissionKey,
                msg.toolCallId,
                msg.toolName,
                msg.chatId,
                opts
            );
        }
        if (opts._gaveUp && msg.primary === false) return;
        // Thread the row's terminal status (allowed / session_allowed /
        // always_allowed / denied) + ids so the SW can flip its authoritative
        // row and broadcast 'approvalSettled' to the other panels (AB-2).
        var _rowStatus = null;
        try {
            var _abRow = (typeof findExistingApprovalRow === 'function')
                ? findExistingApprovalRow(chats[msg.chatId], msg.toolCallId) : null;
            if (_abRow && _abRow.msg && _abRow.msg.status && _abRow.msg.status !== 'pending') _rowStatus = _abRow.msg.status;
        } catch (eR) {}
        if (_agentBusPort) {
            _agentBusPort.postMessage({
                type: 'exec-approval-prompt-result',
                approvalRequestId: msg.approvalRequestId,
                allowed: !!approved,
                chatId: msg.chatId,
                toolCallId: msg.toolCallId,
                status: _rowStatus
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

// MP-1: mirror a freshly-pushed pending prompt_user row to the SW so its
// authoritative chat copy (and every snapshot broadcast to other panels)
// carries the row from dispatch time. Best-effort — on a dead port the row
// still reaches the SW after resolve via result._message_persist (status quo).
function postPromptRowToSW(chatId, row) {
    if (!_agentBusPort || !chatId || !row) return false;
    try {
        _agentBusPort.postMessage({ type: 'prompt-user-pending', chatId: chatId, row: row });
        return true;
    } catch (_) {
        return false;
    }
}

// MP-2: submit/cancel collected on a panel that does NOT hold the armed
// resolver (pendingPromptResolvers). Route the result through the SW — it
// forwards to the executing panel's resolver, or settles the pending/parked
// tool call directly when that panel is gone. Returns true only when the
// message was actually posted AND a live run can consume it; false falls
// back to the dead-run recovery path (injectPromptToolResult).
function _promptResultViaSW(chatId, promptId, result) {
    if (!_agentBusPort || !chatId || !runningChatIds[chatId]) return false;
    var chat = chats[chatId];
    var toolCallId = null;
    if (chat && Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var m = chat.messages[i];
            if (m && m.role === 'prompt_user' && m.promptId === promptId) { toolCallId = m.toolCallId || null; break; }
        }
    }
    try {
        _agentBusPort.postMessage({ type: 'prompt-user-result', chatId: chatId, promptId: promptId, toolCallId: toolCallId, result: result });
        return true;
    } catch (_) {
        return false;
    }
}

// MP-2 receiver (executor side): the SW forwarded a submit/cancel/abandon
// for a prompt whose resolver is armed on THIS panel. Mutate the local row
// first (executePromptUser's captured promptMsg reference — preserved by the
// MP-4 merge rule — must carry the final state into result._message_persist),
// then resolve. Idempotent: a row already resolved locally no-ops.
function _handleRemotePromptResult(msg) {
    if (!msg || !msg.promptId) return;
    var chat = chats[msg.chatId];
    var row = null;
    if (chat && Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var m = chat.messages[i];
            if (m && m.role === 'prompt_user' && m.promptId === msg.promptId) { row = m; break; }
        }
    }
    var result = msg.result || { success: false, cancelled: true, message: 'Prompt settled remotely' };
    if (row && row.status === 'pending') {
        row.status = result.success ? 'submitted' : 'cancelled';
        if (result.values) row.values = result.values;
        if (result.abandoned) row.abandoned = true;
    }
    var resolver = (typeof pendingPromptResolvers !== 'undefined') ? pendingPromptResolvers[msg.promptId] : null;
    if (resolver) {
        delete pendingPromptResolvers[msg.promptId];
        try { resolver(result); } catch (_) {}
    }
    if (typeof _refreshWaitingBadges === 'function') { try { _refreshWaitingBadges(msg.chatId); } catch (e) {} }
    if (typeof currentChatId !== 'undefined' && currentChatId === msg.chatId && typeof renderMessages === 'function') renderMessages();
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

// Notify the authoritative worker that the foreground provider changed.
// The worker updates its global selection and aborts only the named foreground
// run/backoff; pinned sub-agents keep resolving their chat.provider unchanged.
// Latest-wins generation counter: rapid provider switches during a port-down
// window used to stack independent immortal 50ms retry chains, each posting a
// STALE provider-change once the port returned. Each call captures its own
// generation; a superseded chain no-ops. Retries are also capped (~100 × 50ms
// = 5s) so a permanently dead port cannot leak a timer chain forever.
var _providerChangeGen = 0;
function pushProviderChangeToOffscreen(providerId, chatId) {
    if (!providerId || !chatId) return;
    _providerChangeGen++;
    var _gen = _providerChangeGen;
    var _tries = 0;
    var attemptProviderChange = function() {
        if (_gen !== _providerChangeGen) return; // superseded by a newer provider change
        if (_tries++ >= 100) return; // ~5s of retries — give up silently
        if (!_agentBusPort) { setTimeout(attemptProviderChange, 50); return; }
        try {
            _agentBusPort.postMessage({ type: 'provider-change', providerId: providerId, chatId: chatId });
        } catch (e) { setTimeout(attemptProviderChange, 50); }
    };
    attemptProviderChange();
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

// Push the deferred-tool-loading flag to the SW after the user toggles it
// in Settings — same reasoning as pushHooksSettingsToOffscreen: without
// this the SW keeps the boot-time value until the next SW restart, so the
// slim tools array / {{TOOL_CATALOG}} wouldn't apply to background runs.
// Tell the SW to re-hydrate its skill-tool registry (`skillTools`).
// WHY: the SW boots first and calls loadActiveSkills() (worker/190-entry.js
// -> core/140-skills-engine.js:635) from the PERSISTED activeSkills setting.
// A build that ships a BRAND-NEW embedded skill only gets that skill written
// to IDB later, by the page's importEmbeddedSkills() (core/130-indexeddb.js).
// The SW never re-reads, so for the whole life of that service worker the new
// skill's tools are missing from `skillTools` -> isSkillTool() is false and
// getActiveSkillTools() omits them. Pushing this after the page import closes
// the window without waiting for an SW restart.
function pushSkillToolsRefreshToOffscreen() {
    if (!_agentBusPort) return;
    try {
        _agentBusPort.postMessage({ type: 'skills-refresh' });
    } catch (e) {}
}

function pushDeferredToolsSettingToOffscreen(enabled) {
    if (!_agentBusPort) return;
    try {
        _agentBusPort.postMessage({
            type: 'deferred-tools-setting',
            enabled: !!enabled
        });
    } catch (e) {}
}

// Dispatch a permission EDIT to the SW (RFC F6 perms/set action). The SW is
// the single owner: it applies the slots to its globals, persists the
// durable ones (tool/instance) to IDB — the page never writes permission
// maps to IDB anymore — and rebroadcasts 'permissions-changed' so every
// panel's replicas converge. sessionPermissions stays in-memory in the SW
// and dies with it (same as a page reload wiping the page copy).
// Because a dropped dispatch would now lose the edit entirely (no page-side
// persist to fall back on), a patch posted while the port is down is queued
// (latest value per slot — the slots hold live map references, so the flush
// ships current state) and flushed on the next reconnect.
var _pendingPermPatch = null;
// FLUX-4/1 (per-key permissions merge): baseline = the last map this panel
// RECEIVED from the SW per slot ('permissions-changed' echo, hello session
// map). pushPermissionsToOffscreen diffs the live replica against it and
// dispatches only the changed keys plus explicitly-deleted keys, so two
// panels editing DIFFERENT keys concurrently both survive — the old
// whole-map replace made the later push clobber the earlier edit (RFC F6
// follow-up). A slot with no baseline yet (no echo received since load)
// falls back to the legacy full-map push, which the SW still accepts
// (initial sync); the SW's full-map rebroadcast is what arms the baseline.
var _permBaseline = { toolPermissions: null, instancePermissions: null, sessionPermissions: null };
function _permBaselineCapture(slot, map) {
    try { _permBaseline[slot] = JSON.parse(JSON.stringify(map || {})); } catch (e) { _permBaseline[slot] = null; }
}
// Structural per-key diff (values compared via JSON — instancePermissions
// nests one level per host, so key granularity there is the host).
// Returns { set: {k: v}, del: [k] } or null when nothing changed.
function _permDiff(base, cur) {
    var set = {}, del = [], any = false;
    Object.keys(cur || {}).forEach(function(k) {
        try {
            if (JSON.stringify(cur[k]) !== JSON.stringify(base[k])) { set[k] = cur[k]; any = true; }
        } catch (e) { set[k] = cur[k]; any = true; }
    });
    Object.keys(base || {}).forEach(function(k) {
        if (!(k in (cur || {}))) { del.push(k); any = true; }
    });
    return any ? { set: set, del: del } : null;
}
// Queue only the DURABLE slots: replaying a stale SESSION map on reconnect
// would resurrect grants a fresh SW legitimately reset (RFC §4.5 — session
// grants die with the SW). A session grant lost to a port flap re-prompts.
function _queuePermPatch(patch) {
    var q = null;
    if (patch.toolPermissions) { q = q || {}; q.toolPermissions = patch.toolPermissions; }
    if (patch.instancePermissions) { q = q || {}; q.instancePermissions = patch.instancePermissions; }
    if (q) _pendingPermPatch = Object.assign(_pendingPermPatch || {}, q);
}
function pushPermissionsToOffscreen(patch) {
    if (!patch) return;
    if (!_agentBusPort) {
        _queuePermPatch(patch);
        return;
    }
    try {
        // FLUX-4/1: per slot — send a per-key DELTA when this panel holds a
        // baseline for the slot, else the legacy full map (initial sync /
        // first push after load). Deltas carry explicit deletions too (a
        // pure per-key merge never deletes). The SW applies per-key and
        // rebroadcasts the FULL merged maps ('permissions-changed'), which
        // re-arms the baseline — so a lost echo just means the next push
        // resends the same idempotent delta.
        var _pm = { type: 'permissions-update', toolPermissions: null, instancePermissions: null, sessionPermissions: null };
        var _pmAny = false;
        ['toolPermissions', 'instancePermissions', 'sessionPermissions'].forEach(function(slot) {
            if (!patch[slot] || typeof patch[slot] !== 'object') return;
            if (_permBaseline[slot]) {
                var d = _permDiff(_permBaseline[slot], patch[slot]);
                if (d) { _pm[slot + 'Delta'] = d; _pmAny = true; }
                // no diff → replica already equals the last applied map; skip
            } else {
                _pm[slot] = patch[slot];
                _pmAny = true;
            }
        });
        if (!_pmAny) return;
        _agentBusPort.postMessage(_pm);
    } catch (e) {
        _queuePermPatch(patch);
    }
}

// Flush an edit queued while the agent bus was down. Called from
// _openAgentBus after the port (re)connects; ordering vs the SW's hello is
// harmless — the queue only ever holds explicit user edits, and the SW
// applies + rebroadcasts whatever lands last.
function _flushPendingPermPatch() {
    if (!_pendingPermPatch || !_agentBusPort) return;
    var p = _pendingPermPatch;
    _pendingPermPatch = null;
    pushPermissionsToOffscreen(p);
}

// ── FLUX-4C (narrow pull-forward): chat-meta single-writer lane ─────────
// The seven chat-meta fields (CHAT_META_TS_FIELDS + CHAT_META_FLAG_FIELDS,
// declared in ui/070-dashboard-ui.js) are SW-canonical. Page writers call
// dispatchChatMeta(chatId, fields) instead of assigning chats[id].<field> +
// saveChatsToStorage(): the value is applied to THIS panel's replica
// immediately (optimistic — reads right after the call see it), then
// dispatched; the SW applies (timestamps max-wins = any-panel-latest
// semantics, flags last-dispatch-wins), persists, and rebroadcasts
// 'chat-meta-changed' to every panel (echo INCLUDED — the apply is
// idempotent, and the echo self-heals the race where an in-flight snapshot
// reverted the optimistic value). A dispatch posted while the port is down
// is queued per-chat (latest value per field) and flushed on reconnect —
// same durability window as the permissions lane (#786), accepted as
// strictly better than the old blind-put corruption.
// Returns TRUE only when a field actually changed on `target` (review fix B):
// the 'chat-meta-changed' handler repaints only on a real mutation, so a
// no-op echo (typically this panel's OWN dispatch, already applied
// optimistically below) costs zero renders. The write conditions are
// unchanged — the added `target[f] !== fields[f]` test only skips an
// assignment that would have written the identical value. Object-valued flags
// (_lastApiError) survive the port's structured clone as a NEW identity, so an
// error SET always reads as changed (conservative: repaint rather than miss a
// red row), while an error CLEAR (defined null) compares equal and is gated.
function _applyChatMetaFields(target, fields) {
    if (!target || !fields) return false;
    var changed = false;
    // FLUX-T1 (title lane): the title VALUE rides its paired stamp. >= (not
    // strict >) + adopt-on-differ: the SW rebroadcast/snapshot is the
    // arbiter — on a tied stamp (two panels renamed in the same ms) the
    // losing panel must still converge to the SW's canonical pick, and an
    // equal-value echo is a no-op so the winner repaints nothing. The same
    // rule serves the optimistic local apply (dispatchChatMeta stamps
    // strictly above the replica's current stamp). titleProvisional rides
    // the winning pair: true → set, absent → cleared. Runs BEFORE the TS
    // loop so the compare reads the pre-merge stamp.
    if (typeof fields.titleUpdatedAt === 'number' && isFinite(fields.titleUpdatedAt)
        && typeof fields.title === 'string' && fields.title
        && fields.titleUpdatedAt >= (target.titleUpdatedAt || 0)) {
        if (target.title !== fields.title) { target.title = fields.title; changed = true; }
        var _tpIn = fields.titleProvisional === true;
        if (_tpIn !== (target.titleProvisional === true)) {
            if (_tpIn) target.titleProvisional = true; else delete target.titleProvisional;
            changed = true;
        }
        if ((target.titleUpdatedAt || 0) !== fields.titleUpdatedAt) { target.titleUpdatedAt = fields.titleUpdatedAt; }
    }
    CHAT_META_TS_FIELDS.forEach(function(f) {
        // isFinite: same guard as the SW's _swApplyChatMetaFields — an
        // Infinity must not apply optimistically when the SW will reject it.
        if (typeof fields[f] === 'number' && isFinite(fields[f]) && fields[f] > (target[f] || 0)) { target[f] = fields[f]; changed = true; }
    });
    CHAT_META_FLAG_FIELDS.forEach(function(f) {
        if (fields[f] !== undefined && target[f] !== fields[f]) { target[f] = fields[f]; changed = true; }
    });
    return changed;
}
// FLUX-H4: shared apply half of the 'chat-meta-changed' handler — also used
// by the 'chat-meta-snapshot' reconnect anti-entropy push so both go through
// ONE idempotent apply. Returns true only when a field really changed.
function _applyChatMetaChangedFromSW(chatId, fields) {
    if (!chatId || !fields || typeof chats === 'undefined' || !chats[chatId]) return false;
    // FLUX-P1: sync the derived pausedChats cache on every SW-authoritative
    // apply (echo, cross-panel change, reconnect snapshot — where a null
    // flag means "no opinion recorded" and reads as unpaused).
    if (fields.pausedByUser !== undefined && typeof pausedChats !== 'undefined') pausedChats[chatId] = fields.pausedByUser === true;
    return _applyChatMetaFields(chats[chatId], fields);
}
// FLUX-H4: shared repaint half (chat list + jobs badge + open jobs dropdown)
// — the exact surfaces the seven lane fields feed.
function _repaintChatMetaSurfaces() {
    if (typeof renderChatList === 'function') { try { renderChatList(); } catch (e) {} }
    // FLUX-T1: the title pair repaints the open-chat header too (cheap,
    // idempotent — reads chats[currentChatId].title and sets text).
    if (typeof updateChatTitleHeader === 'function') { try { updateChatTitleHeader(); } catch (e) {} }
    if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') {
        try { var _jdCM = _getOpenJobsDropdown(); if (_jdCM) renderJobsDropdown(_jdCM); } catch (e) {}
    }
}
var _pendingChatMetaPatches = {};
function _queueChatMetaPatch(chatId, fields) {
    var q = _pendingChatMetaPatches[chatId] || (_pendingChatMetaPatches[chatId] = {});
    // FLUX-T1: the title pair replaces atomically — a later pair must not
    // inherit a stale title or titleProvisional rider from an earlier
    // queued patch (per-field merge would fuse two generations).
    if (fields.titleUpdatedAt !== undefined) { delete q.title; delete q.titleProvisional; }
    Object.keys(fields).forEach(function(f) { q[f] = fields[f]; });
}
function dispatchChatMeta(chatId, fields) {
    if (!chatId || !fields) return;
    // FLUX-T1: a title write ALWAYS travels as a pair — auto-stamp a
    // monotonic titleUpdatedAt, strictly above the replica's current stamp:
    // two same-ms renames from one panel must not tie at the SW arbiter
    // (the second would lose and revert on echo).
    if (typeof fields.title === 'string' && fields.title && fields.titleUpdatedAt === undefined) {
        var _tCur = (typeof chats !== 'undefined' && chats[chatId] && chats[chatId].titleUpdatedAt) || 0;
        fields = Object.assign({}, fields, { titleUpdatedAt: Math.max(Date.now(), _tCur + 1) });
    }
    var clean = null;
    CHAT_META_TS_FIELDS.concat(CHAT_META_FLAG_FIELDS, ['title', 'titleProvisional']).forEach(function(f) {
        if (fields[f] !== undefined) { (clean = clean || {})[f] = fields[f]; }
    });
    if (!clean) return;
    if (typeof chats !== 'undefined' && chats[chatId]) _applyChatMetaFields(chats[chatId], clean);
    // FLUX-P1: pausedChats is a DERIVED cache of the lane's pausedByUser flag
    // — synced on the optimistic apply too (so the page loop gate and the
    // pause-button label see a toggle the same tick), and unconditionally on
    // chats[chatId]: the pre-lane helper updated the cache even for a record
    // this panel doesn't hold.
    if (clean.pausedByUser !== undefined && typeof pausedChats !== 'undefined') pausedChats[chatId] = clean.pausedByUser === true;
    if (!_agentBusPort) { _queueChatMetaPatch(chatId, clean); return; }
    try {
        _agentBusPort.postMessage({ type: 'chat-meta-update', chatId: chatId, fields: clean });
    } catch (e) {
        _queueChatMetaPatch(chatId, clean);
    }
}
// Flush edits queued while the bus was down. Called from _openAgentBus after
// reconnect, beside _flushPendingPermPatch — port message order guarantees
// these land BEFORE any run-agent this panel posts afterwards, so the adopt
// overlay in worker/130-port-bridge.js never sees a pre-flush stale snapshot
// win over a queued edit.
function _flushPendingChatMetaPatches() {
    if (!_agentBusPort) return;
    var q = _pendingChatMetaPatches;
    _pendingChatMetaPatches = {};
    Object.keys(q).forEach(function(cid) { dispatchChatMeta(cid, q[cid]); });
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
