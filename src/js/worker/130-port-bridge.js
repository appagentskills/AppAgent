// =============================================================
// AppAgent SW runtime — direct panel ↔ SW port bridge.
//
// In the SW-hosted architecture there is NO relay: panels open a
// long-lived 'agent-bus' port directly to the SW. The SW IS the
// runtime, so it acts on incoming messages immediately and broadcasts
// AgentEvents to every subscribed panel without an extra hop.
//
// Outbound (SW → panel) message types:
//   • { type: 'agent-event', eventType, detail }  — bus broadcast
//   • { type: 'hello', chatsSnapshot, runningChatIds } — on connect
//   • { type: 'chat-snapshot', chatId, chat }     — pull response
//   • { type: 'exec-tool', toolCallId, ... }      — UI tool routing
//   • { type: 'exec-approval-prompt', ... }       — approval request
//
// Inbound (panel → SW) message types:
//   • 'run-agent'           — start a chat run
//   • 'send-message'        — queue user injection mid-run + interrupt
//   • 'interrupt'           — user interrupt without a new message
//   • 'toggle-pause'        — pause / resume
//   • 'pull-chat'           — request a fresh chat snapshot
//   • 'update-chat'         — panel-side mutation (title rename, etc.)
//   • 'exec-tool-result'    — UI tool result coming back from panel
//   • 'exec-approval-prompt-result' — approval decision from panel
// =============================================================

// Set of currently-connected panel ports. Each entry serves as both
// an event subscriber (via _agentSubscribers) and a UI-tool executor.
// We keep them deduplicated against _agentSubscribers so a single
// panel = one subscription = one executor candidate.
var _swPanelPorts = new Set();

// REG-AUDIT-2: resume-scan settle signal. The page's hello-grace reconcile
// (app/045-agent-port-bridge-page.js) settles orphaned pending runAgents after
// a fixed grace window, but resumeRunningCheckpoints' gate chain
// (_swBootReady → _swResumeGate → Platform.ready → loadApiProviders) is
// unbounded — on a slow cold boot the page timer could win and finalize a
// still-resuming run. Once the SW knows the resume scan is decided (no
// checkpoints, or all checkpoints re-armed, or the gate chain failed), it
// flips this flag and notifies every connected panel so the page can stop
// extending its grace window.
var _swResumeScanSettled = false;
function _settleResumeScan() {
    if (_swResumeScanSettled) return;
    _swResumeScanSettled = true;
    _swPanelPorts.forEach(function(p) { try { p.postMessage({ type: 'resume-scan-done' }); } catch (e) {} });
}
self._settleResumeScan = _settleResumeScan;

// ZR1-R1 (follow-up): registry-side orphan sweep for boot-claimed,
// never-resumed subs. The boot decision in 097 claims a pool slot for every
// checkpoint-resumable sub BEFORE the resume scan runs; any settle path that
// fires without runAgent having started those loops (gate-chain failure,
// listRunningAgentCheckpoints rejecting or returning a PARTIAL list in
// 190-entry.js) must orphan them, or the records stay fake-'running' with a
// claimed slot + pending rehydrated handle for the whole SW session (no
// sweeper covers 'running'; two leaks block the 2-slot pool). Registry-side
// (not checkpoint-side) so it also works when the checkpoint list itself is
// what failed. Selection: state 'running' + pool slot CLAIMED + loop not in
// runningChatIds — exactly the boot-claimed-unresumed shape. Subs started
// this session are excluded by the runningChatIds guard (a drain's
// claim→runAgent pair is atomic w.r.t. other tasks' microtasks, so the
// claimed-but-not-yet-running window cannot interleave with this sweep);
// queued subs and throttle-backoff retries hold no slot and are skipped.
// Failure path — guard every step.
function _orphanUnresumedSubs(reason) {
    try {
        if (typeof SubAgents === 'undefined' || !SubAgents.listAll || !SubAgents.markOrphaned) return;
        if (typeof _subPool === 'undefined' || !_subPool.running) return;
        SubAgents.listAll().forEach(function(rec) {
            try {
                if (!rec || rec.state !== 'running') return;
                if (!_subPool.running[rec.agent_id]) return;
                if (typeof runningChatIds !== 'undefined' && runningChatIds[rec.chat_id]) return;
                SubAgents.markOrphaned(rec.agent_id, reason);
            } catch (e2) { /* per-record best-effort */ }
        });
    } catch (e3) { /* never block the caller's settle */ }
}
self._orphanUnresumedSubs = _orphanUnresumedSubs;

// Lazy id stamping for routing UI-tool replies back to the right
// panel.
var _swPanelIds = new WeakMap();
var _swPanelIdSeq = 0;
function _panelId(port) {
    if (_swPanelIds.has(port)) return _swPanelIds.get(port);
    var id = 'panel_' + (++_swPanelIdSeq);
    _swPanelIds.set(port, id);
    return id;
}

function _serializeChatsSnapshot() {
    var out = {};
    Object.keys(chats).forEach(function(cid) {
        if (runningChatIds[cid] || (parkedToolCallsByChatId[cid] && parkedToolCallsByChatId[cid].length)) {
            out[cid] = chats[cid];
        }
    });
    return out;
}

function _registerPanel(port) {
    if (_swPanelPorts.has(port)) return;
    _swPanelPorts.add(port);
    // Decorate the port so the routing code in 120-tool-routing.js can
    // identify it. _agentSubscribers stores port-like handles; the real
    // port works directly because it already has .postMessage.
    port._panelId = _panelId(port);
    _agentSubscribers.add(port);
    // Greet with running-chats snapshot + replay parked tool calls.
    try {
        port.postMessage({
            type: 'hello',
            chatsSnapshot: _serializeChatsSnapshot(),
            runningChatIds: Object.keys(runningChatIds).filter(function(c) { return runningChatIds[c]; }),
            // REG-AUDIT-2: tell the panel whether the boot resume scan has
            // already settled, so the hello-grace reconcile doesn't wait for a
            // 'resume-scan-done' that was posted before this panel connected.
            resumeScanSettled: _swResumeScanSettled,
            // Initial sub-agent snapshot. The page's own loadAllSubAgents
            // (which skips the orphan-rewrite per PR #244) populated the
            // page mirror from IDB at panel boot — the SW is authoritative
            // and overwrites that view here via SubAgents.applySnapshot in
            // the page-side hello handler. After this, live updates flow
            // via the `subagent-snapshot` envelope from
            // src/js/worker/105-subagent-broadcast.js.
            // GATED on SubAgents.isLoaded(): right after an MV3 SW restart
            // this hello can fire BEFORE the boot's async SubAgents.loadAll
            // (190-entry.js) has drained IDB — the registry is empty, and
            // shipping [] here made the page's full-replace
            // applySubAgentSnapshot WIPE its correctly IDB-loaded mirror.
            // Send null instead (the page handler skips falsy); once loadAll
            // completes it fires _notifyListeners and the broadcast bridge
            // (105) pushes the real snapshot to every connected panel.
            subAgentRecords: (typeof SubAgents !== 'undefined' && SubAgents.listAll
                && (typeof SubAgents.isLoaded !== 'function' || SubAgents.isLoaded()))
                ? SubAgents.listAll() : null
        });
        replayParkedToolCalls(port);
    } catch (e) {
        console.error('[port-bridge] hello/replay failed', e);
    }
}

function _unregisterPanel(port) {
    if (!_swPanelPorts.has(port)) return;
    _swPanelPorts.delete(port);
    _agentSubscribers.delete(port);
    // SWM-3: if the executing panel disconnects before posting its
    // exec-tool-result, the SW loop's awaited promise would hang forever.
    // Re-park any in-flight UI tool calls that were dispatched to THIS port so
    // a freshly-connected panel replays them (replayParkedToolCalls). Both
    // _pendingUIToolCalls and parkUIToolCall are globals in the worker bundle
    // (worker/120-tool-routing.js). The key of _pendingUIToolCalls is the
    // toolCallId; PART A stored .port/.chatId/.name/.input/.sandboxCtx on each.
    try {
        Object.keys(_pendingUIToolCalls).forEach(function(id) {
            var entry = _pendingUIToolCalls[id];
            if (!entry || entry.port !== port) return;
            // Defensive: clear any redispatch backstop on the entry being torn down so
            // its timer can't later fire against a re-registered entry for the same id.
            // (Backstop entries are normally port-less and not matched here, but this
            // keeps the invariant safe if that ever changes.) (bug #3)
            if (entry._backstopTimer) { clearTimeout(entry._backstopTimer); entry._backstopTimer = null; }
            // Re-park only entries that carry enough metadata to be REPLAYED to a
            // fresh panel (a real UI tool call: name + input). Approval-prompt
            // entries record .port for disconnect-visibility but intentionally
            // omit .name: replayParkedToolCalls re-dispatches via
            // dispatchUIToolToPort as an `exec-tool`, so a parked approval would
            // be sent as a bogus exec-tool '__approval_prompt__' the panel can't
            // run. For those, honour the documented "clean rejection if re-park
            // is not possible" contract so `await approvalPromise` settles
            // instead of hanging.
            if (entry.name) {
                try {
                    // B1: pass alreadyDispatched=true — this tool was already sent to
                    // the now-disconnected panel and may have executed, so replay must
                    // reconcile rather than blindly re-dispatch (double side effect).
                    parkUIToolCall(entry.chatId, id, entry.name, entry.input, entry.resolve, entry.reject, entry.sandboxCtx, true);
                } catch (e) {
                    // Fallback: never leave the loop hanging.
                    try { entry.reject(new Error('panel disconnected before returning tool result')); } catch (e2) {}
                }
            } else {
                try { entry.reject(new Error('panel disconnected before returning tool result')); } catch (e2) {}
            }
            delete _pendingUIToolCalls[id];
        });
    } catch (e) {}
    // SWM3-F-HANG: re-parked already-dispatched entries only reconcile on a NEW connect; if the
    // executor panel dies while another panel is still connected (multi-panel) the SW loop's awaited
    // promise stalls until the 24h TTL. Drive an immediate reconcile against a surviving port.
    try { if (_swPanelPorts.size > 0) { var _altPort = pickExecutorPort(); if (_altPort) replayParkedToolCalls(_altPort); } } catch (e) {}
    // B3: also purge any post-SW-restart ADOPTION marker stamped with this dead
    // port. panel-hello sets _panelAdoptedTools[id].port BEFORE the resumed loop's
    // executeTool creates the matching _pendingUIToolCalls entry; if the adopting
    // panel disconnects in that window the pending scan above finds nothing, the
    // dead-port marker lingers, and executeTool later registers a pending entry on
    // that dead port that no future disconnect re-scans — hanging the await forever.
    try {
        Object.keys(_panelAdoptedTools).forEach(function(id) {
            if (_panelAdoptedTools[id] && _panelAdoptedTools[id].port === port) {
                // SWM3-N2: do NOT fully delete the marker. If the resumed loop later
                // reaches executeTool(id) it would otherwise find no marker and BLIND
                // RE-DISPATCH a tool this now-dead panel already ran (double side
                // effect). Downgrade to a port-less tombstone so the adoption arm
                // reconciles (registers a waiting pending entry + backstop, never
                // re-dispatches). scheduleAdoptedEviction bounds the tombstone's
                // lifetime so it can't grow unbounded.
                // F1: do NOT destroy a genuine buffered exec-tool-result. The earlier
                // version unconditionally `delete _adoptedResults[id]`; when the adopting
                // panel disconnected holding a real buffered result this wiped it, so the
                // resumed loop found no buffer, the 30s redispatch backstop REJECTED a
                // tool that already succeeded, and the model retried -> duplicate side
                // effect. Preserve a present buffer (mirroring the SWM3-T3 live-port path
                // in 120-tool-routing.js which deliberately keeps it) and rely on the
                // bounded ADOPTED_RESULT_TTL eviction below to reclaim it if it is never
                // consumed. Only drop when there's nothing valuable to keep.
                var _prevAdopt = _panelAdoptedTools[id];
                _panelAdoptedTools[id] = { dispatched: true, chatId: _prevAdopt && _prevAdopt.chatId };
                if (typeof scheduleAdoptedEviction === 'function') scheduleAdoptedEviction(id);
            }
        });
    } catch (e) {}
    // SWM2-F2: drop this panel's focus entry so a disconnected panel stops pinning
    // the chat it was viewing. The sub-agent GC guard skips a chat focused by ANY
    // LIVE panel; a dead panel's entry must be cleared or it would pin forever.
    try {
        if (typeof SubAgents !== 'undefined' && SubAgents.clearFocusedChatForPort) {
            SubAgents.clearFocusedChatForPort(_panelId(port));
        }
    } catch (e) {}
}

chrome.runtime.onConnect.addListener(function(port) {
    if (port.name !== 'agent-bus') return;
    // Ensure the offscreen helper is available — agent runs may need
    // js_eval / image processing. Best-effort: don't block on it.
    if (typeof ensureOffscreenDocument === 'function') {
        try { ensureOffscreenDocument(); } catch (e) {}
    }
    _registerPanel(port);
    port.onMessage.addListener(function(msg) {
        try { _handlePanelMessage(port, msg); }
        catch (e) { console.error('[port-bridge] handler error', msg && msg.type, e); }
    });
    port.onDisconnect.addListener(function() {
        _unregisterPanel(port);
    });
});

function _handlePanelMessage(port, msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
        case 'run-agent':
            // Panel sent a fresh chat snapshot + currentProvider. Adopt
            // them, refresh providers from IDB so a key change made in
            // the panel takes effect, and kick off the loop.
            //
            // CRITICAL: never replace chats[chatId] while a run is in flight
            // for that chat. The SW is the authoritative writer during a run
            // (it pushes the assistantMsg, seeds placeholder tool_results,
            // updates them as tools complete). The panel's snapshot lags
            // behind every save inside the loop. The replace race is the
            // root cause of orphan `tool_use` blocks: a hook re-fires the
            // next iteration synchronously on the SW (clearing/re-setting
            // runningChatIds in a tight window), but the panel briefly
            // observes the chat as "not running" between its runFinished
            // and runStarted notifications, posts run-agent with a stale
            // chat that's missing every in-flight tool_result placeholder,
            // and the SW used to clobber its in-memory chat with that copy.
            // The next save then persisted the stale shape to IDB.
            if (msg.chatId) {
                // Treat the brief finish→hook-rerun cleanup window as "running"
                // too. During it runningChatIds is transiently cleared, but the
                // SW is still the authoritative writer (about to push the hook's
                // assistant + tool_result). A panel run-agent that lands here
                // carries a stale snapshot — honoring _runCleanupGuard stops it
                // from clobbering chats[id] AND from starting a parallel loop.
                var isRunning = !!runningChatIds[msg.chatId]
                    || !!(typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard[msg.chatId]);
                // PR383-R4 (loss window 2): _notifySubLifecycle's idle branch
                // pushes injected user rows (lifecycle notices) straight into
                // the SW's chats copy. A panel's run-agent for an idle chat
                // adopts the incoming snapshot wholesale below — a stale panel
                // snapshot taken BEFORE the notice broadcast would silently
                // clobber those rows. Carry over injected:true user rows that
                // exist in the SW copy but not in the incoming snapshot
                // (append at the end when their original index is gone — the
                // run starts on a user turn either way). Content-equality
                // dedup keeps rows the panel already has from duplicating.
                if (msg.chat && !isRunning) {
                    try {
                        var _swPrev = chats[msg.chatId];
                        if (_swPrev && Array.isArray(_swPrev.messages) && Array.isArray(msg.chat.messages)) {
                            var _incomingMsgs = msg.chat.messages;
                            // PR384-FIX-7: COUNT-BASED dedup. The old matcher treated
                            // ONE content match as full presence, so a second
                            // byte-identical lifecycle notice (e.g. the same sub
                            // crashing twice with the same headline) was silently
                            // dropped. Consume each incoming copy at most once so
                            // surplus SW copies are carried over instead of collapsed.
                            var _consumed = {};
                            for (var _ci = 0; _ci < _swPrev.messages.length; _ci++) {
                                var _cm = _swPrev.messages[_ci];
                                if (!_cm || _cm.role !== 'user' || !_cm.injected || typeof _cm.content !== 'string') continue;
                                var _present = false;
                                for (var _cj = 0; _cj < _incomingMsgs.length; _cj++) {
                                    if (_consumed[_cj]) continue; // already matched by an earlier SW row
                                    var _im = _incomingMsgs[_cj];
                                    if (_im && _im.role === 'user' && _im.injected && _im.content === _cm.content) { _consumed[_cj] = true; _present = true; break; }
                                }
                                if (!_present) _incomingMsgs.push(_cm);
                            }
                        }
                    } catch (e) { console.warn('[port-bridge] injected-row carry-over failed', msg.chatId, e); }
                    chats[msg.chatId] = msg.chat;
                }
                // SWM-S1 (flap message loss): a run-agent for a chat the SW is STILL
                // running means the page took its IDLE send path during a port-flap
                // window (the bus onDisconnect cleared the page's runningChatIds), so
                // the user's freshly-typed message lives ONLY in this discarded
                // snapshot — the guard below skips the run and the next agent-event
                // broadcast overwrites the page mirror, silently dropping it. Recover:
                // extract trailing user-role messages (and their attachment rows)
                // present in msg.chat but absent from the SW's own copy, and route
                // them through the existing mid-run injection path exactly as if the
                // page had posted send-message to a running chat.
                if (msg.chat && isRunning) {
                    try {
                        // REG376-1: also dedup against the un-flushed pending
                        // injection queue (third arg) — a second flap arriving
                        // BEFORE the loop's flushPendingInjection consumed a
                        // previous flap's recovery re-extracted the same block
                        // (it is absent from the SW chat rows) and the merge
                        // below / in _handlePanelSendMessage concatenated a
                        // duplicate of the user's text.
                        var _unseen = _extractUnseenTrailingUserInput(msg.chat, chats[msg.chatId], pendingInjectionsByChatId[msg.chatId]);
                        if (_unseen) {
                            console.warn('[port-bridge] run-agent arrived for running chat', msg.chatId,
                                '— recovering', _unseen.count, 'unseen trailing user message(s) via mid-run injection');
                            if (runningChatIds[msg.chatId]) {
                                // Running branch of _handlePanelSendMessage: merge into
                                // pendingInjectionsByChatId + interrupt/abort — the loop's
                                // flushPendingInjection pushes it next iteration.
                                _handlePanelSendMessage({ chatId: msg.chatId, text: _unseen.text, images: _unseen.images });
                            } else {
                                // _runCleanupGuard window (finish→hook-rerun): the loop is
                                // between iterations — queue the injection WITHOUT firing an
                                // interrupt (same merge semantics as _handlePanelSendMessage's
                                // running branch); the re-run's flushPendingInjection flushes it.
                                var _exInj = pendingInjectionsByChatId[msg.chatId];
                                if (_exInj) {
                                    var _mTxt;
                                    if (_exInj.text && _unseen.text) _mTxt = _exInj.text + '\n\n' + _unseen.text;
                                    else _mTxt = _exInj.text || _unseen.text || null;
                                    var _mImgs;
                                    if (_exInj.images && _unseen.images) _mImgs = _exInj.images.concat(_unseen.images);
                                    else _mImgs = _exInj.images || _unseen.images || null;
                                    pendingInjectionsByChatId[msg.chatId] = { text: _mTxt, images: _mImgs };
                                } else {
                                    pendingInjectionsByChatId[msg.chatId] = { text: _unseen.text, images: _unseen.images };
                                }
                            }
                        }
                    } catch (e) { console.error('[port-bridge] flap-recovery injection failed', msg.chatId, e); }
                }
                if (msg.currentProvider) currentProvider = msg.currentProvider;
                // SWM1F-1: a run-agent means the user intends this chat to run
                // now, so clear any stale SW-side pause flag. Post-SW-move the
                // loop's `while (!isChatPaused)` gate reads the SW's pausedChats
                // copy; the page only clears its OWN pausedChats copy on send, so
                // without this a chat that was paused then re-run trips the gate
                // immediately and the just-sent run is silently dropped
                // (runFinished{reason:'paused'}). Keep pausedChatIds in sync — we
                // are intentionally NOT removing it (SWM1F-2 deferred).
                if (!isRunning) { setChatPausedPersistent(msg.chatId, false); pausedChatIds[msg.chatId] = false; }
                // Same gate order as resumeRunningCheckpoints: chats/providers
                // loaded, Platform session/instance ready, providers refreshed.
                // The panel inlines the chat snapshot above so chats[chatId]
                // is populated even pre-_swBootReady, but Platform.instanceUrl
                // and the session token aren't — without these gates a panel
                // posting run-agent during a cold-boot race could fire the
                // loop before ServiceNow tools have an authenticated session.
                (self._swBootReady || Promise.resolve())
                    .then(function() { return Platform.ready; })
                    .then(function() { return loadApiProviders(); })
                    // Orchestrator §1: refresh the sub-agent tier-alias map
                    // (small|medium|large → provider name) so a spawn_sub_agent
                    // with `tier` during this run resolves against the user's
                    // latest settings. Non-fatal — resolveTierAlias falls back
                    // to DEFAULT_TIER_ALIASES until hydrated.
                    .then(function() { return (typeof loadTierAliases === 'function') ? loadTierAliases() : null; })
                    // Refresh the assumed-context-window setting the same way,
                    // so a Settings change reaches an already-booted SW before
                    // the next run's context warnings / saturation gauges.
                    .then(function() { return (typeof loadAssumedContextTokens === 'function') ? loadAssumedContextTokens() : null; })
                    // MEMFIX: the SW loader evicts inline base64 payloads from
                    // every chat (worker/115-storage.js) and a panel snapshot
                    // adopted above may itself be payload-evicted (the page
                    // strips non-recent chats too). Rehydrate BEFORE runAgent so
                    // (a) buildApiMessages can inline vision blocks and (b) the
                    // loop's saves aren't skipped by the evicted-put guard — a
                    // skipped put here would lose the run's new messages on SW
                    // death. ensureChatPayloads never rejects.
                    .then(function() { return (typeof ensureChatPayloads === 'function') ? ensureChatPayloads(msg.chatId) : null; })
                    .then(function() {
                        if (!runningChatIds[msg.chatId]) {
                            try { runAgent(msg.chatId); }
                            catch (e) { console.error('[port-bridge] runAgent threw', e); }
                        }
                    })
                    .catch(function(e) {
                        // A gate failure (IDB/provider load) must surface — without
                        // this the user's run is silently dropped with no diagnostic.
                        console.error('[port-bridge] run-agent gate chain failed', msg.chatId, e);
                        // Emit the terminal event too: the panel showed a spinner and
                        // parked an _pendingRunAgents promise the moment it posted
                        // run-agent. A console line alone leaves that spinner live and
                        // every `await runAgent()` caller hanging until the 15s
                        // no-hello fallback (or forever on a healthy port) — the exact
                        // hang class the runCrashed settle in 045 closes. runCrashed
                        // is safe for a run that never started: the 036 handler's
                        // cleanup is no-op-tolerant and 045's settle just resolves.
                        // RES-2: this gate chain ALSO runs for run-agent posts on
                        // chats that are already live (port-flap re-post, SWM-S1
                        // above) — the .then deliberately skips runAgent for them.
                        // A transient gate rejection must not crash that healthy
                        // run: only emit runCrashed when the chat is NOT live
                        // (same liveness check as `isRunning` above).
                        try {
                            if (msg.chatId && typeof AgentEvents !== 'undefined' && AgentEvents.emit
                                && !runningChatIds[msg.chatId]
                                && !(typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard && _runCleanupGuard[msg.chatId])) {
                                AgentEvents.emit('runCrashed', { chatId: msg.chatId });
                            }
                        } catch (e2) {}
                    });
            }
            return;

        case 'send-message':
            // SWM14-T7: gate the send-message dispatch on the SW boot (and the same
            // Platform.ready + providers chain run-agent uses @:218). Without the boot
            // gate, a send arriving during the SW cold-boot window runs
            // _handlePanelSendMessage while `chats` is still {} — its idle branch then
            // pushes the user message onto a skeleton chat and saveChatsToStorage()'s
            // store.clear()+rewrite WIPES every other chat from IDB. Gating until
            // _swBootReady guarantees `chats` is hydrated first (the page now also
            // inlines a chat snapshot — app/040-send-message.js — so a brand-new chat
            // not yet persisted to IDB still seeds correctly without clobbering siblings).
            // QUEUE-SYNC-FIX: a send to a RUNNING chat must be handled SYNCHRONOUSLY.
            // The running branch only touches in-memory maps (pendingInjectionsByChatId /
            // userInterruptedChats / interrupt resolver / stream abort) — it needs neither
            // chats hydration nor providers. Deferring it behind the async boot chain broke
            // the single-port FIFO ordering the interrupt path depends on (SWM-SW-NOGEN-NOTE):
            // the abort must land while the stream/tool it targets is still the current step,
            // otherwise the resolver/abort fire as no-ops in the between-steps gap and the
            // queued message only flushes at the end of the run. The SWM14-T7 wipe risk only
            // applies to the IDLE branch (which writes chats + IDB); during the cold-boot
            // window runningChatIds is empty, so this fast path can never take that branch.
            if (msg.chatId && runningChatIds[msg.chatId]) {
                try { _handlePanelSendMessage(msg); }
                catch (e) { console.error('[port-bridge] _handlePanelSendMessage threw', e); }
                return;
            }
            (self._swBootReady || Promise.resolve())
                .then(function() { return Platform.ready; })
                .then(function() { return loadApiProviders(); })
                .then(function() {
                    try { _handlePanelSendMessage(msg); }
                    catch (e) { console.error('[port-bridge] _handlePanelSendMessage threw', e); }
                })
                .catch(function(e) {
                    // A gate failure (IDB/provider load) must surface — without
                    // this the user's message is silently dropped with no diagnostic.
                    console.error('[port-bridge] send-message gate chain failed', msg.chatId, e);
                    // Same rationale as the run-agent catch above: unstick the
                    // panel's spinner/streaming UI and settle any pending runAgent
                    // promise for this chat instead of leaving them hanging.
                    try {
                        // PR384-FIX-3: guard the emit with the SAME liveness check
                        // as the run-agent gate catch above. FIX-1's handler now
                        // routes runCrashed into a terminal sub settle, so an
                        // unguarded emit here (this gate chain also runs for sends
                        // on chats that are already live) could error a HEALTHY sub.
                        if (msg.chatId && typeof AgentEvents !== 'undefined' && AgentEvents.emit
                            && !runningChatIds[msg.chatId]
                            && !(typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard && _runCleanupGuard[msg.chatId])) {
                            AgentEvents.emit('runCrashed', { chatId: msg.chatId });
                        }
                    } catch (e2) {}
                });
            return;

        // SWM-SW-NOGEN-NOTE: the 'interrupt' and 'toggle-pause' handlers below apply
        // msg.paused / msg.fromUserMessage with NO generation / run-id guard. This is
        // correct ONLY because of single-port FIFO message ordering plus page-side
        // latest-wins reconciliation: messages from a given panel arrive in send order,
        // and the page resolves any stale paused/interrupt state on the next snapshot.
        // If multi-port or out-of-order delivery is ever introduced, these handlers will
        // need an explicit generation guard. Documentation only -- no logic change.
        case 'interrupt':
            var icid = msg.chatId;
            if (icid) {
                if (msg.fromUserMessage) userInterruptedChats[icid] = true;
                // A bare interrupt (panel's stop button, not a send-message) means
                // the user is cancelling, not deferring. Drop any pending injection
                // queued by an earlier send-message — otherwise the next runAgent
                // would silently flush stale text the user thought they aborted.
                // send-message takes the running branch with its own assignment, so
                // this delete won't race with that path.
                //
                // SWM14-F4 (DELIBERATE — documented, not a bug): Pause, Stop and
                // Dismiss all push fromUserMessage=false (pushInterruptToOffscreen(
                // chatId, false) from togglePause / stopAction / dismissAction), so
                // they take THIS branch and discard any un-flushed queued injection.
                // This is intentional: a non-user-message interrupt drops the queued
                // message to keep interrupt semantics simple. For PAUSE specifically
                // it means a not-yet-sent queued message is discarded by design (the
                // user must re-send after Resume). If a future change wants Pause to
                // PRESERVE the queued injection, gate this delete on the interrupt
                // kind rather than the fromUserMessage flag.
                if (!msg.fromUserMessage && pendingInjectionsByChatId[icid]) {
                    delete pendingInjectionsByChatId[icid];
                }
                if (interruptResolversByChatId[icid]) {
                    try { interruptResolversByChatId[icid](); } catch (e) {}
                }
                if (currentStreamAbortControllers[icid]) {
                    try { currentStreamAbortControllers[icid].abort(); } catch (e) {}
                }
            }
            return;

        case 'toggle-pause':
            // Set the flag FIRST. Main never emitted 'paused' here — the snackbar
            // fires either from the loop's pending-tool early-return emit, or
            // from the runFinished handler's isPaused branch after the stream
            // aborts. Emitting here would double-fire the snackbar.
            pausedChatIds[msg.chatId] = !!msg.paused;
            // CRITICAL (Pause regression): the SW agent loop's isChatPaused()
            // resolves to core/030-config.js's implementation — it is in
            // WORKER_SHARED_FILES and its function declaration is hoisted over
            // worker/020-page-stubs.js's pausedChatIds-reading fallback — so the
            // loop actually reads pausedChats, NOT pausedChatIds. Without the
            // mirror below, `while (!isChatPaused(chatId))` never trips: Pause
            // aborts the in-flight step, the loop catches the AbortError and
            // `continue`s straight into a fresh LLM call. Mirror into pausedChats.
            // setChatPausedPersistent also stamps chat.pausedByUser on the SW's
            // chat copy — both realms do full-record puts to the chats store, so
            // the SW's next post-tool-result save must carry the flag or it would
            // clobber the page-side write (pause survives a panel reload).
            setChatPausedPersistent(msg.chatId, !!msg.paused);
            // POST-SW-RELOCATION FIX: the in-flight LLM stream's AbortController and
            // the tool interrupt resolver live HERE in the SW now, not on the panel.
            // The panel-side togglePause still calls abort()/resolver() but its copies
            // of those maps are empty no-ops after the loop moved to the SW — so
            // without the lines below, Pause never aborts the current call. It would
            // only take effect at the next loop-iteration boundary (after the whole
            // streaming turn AND its tool batch finish), which reads to the user as
            // "Pause does nothing". Mirror the `interrupt` handler so Pause aborts the
            // in-flight stream / running tool immediately, as documented.
            //
            // We do this only when PAUSING (not on resume), and we must NOT set
            // userInterruptedChats: that flag makes the loop label abandoned tools as
            // "user sent a new message". Leaving it false makes the loop record the
            // correct "abandoned — paused by user" placeholder (030-agent-loop.js:879).
            // The stream catch sees an AbortError, drops the partial assistant msg,
            // and `continue`s — the while-gate then exits because the flag is set.
            if (msg.paused && msg.chatId) {
                if (interruptResolversByChatId[msg.chatId]) {
                    try { interruptResolversByChatId[msg.chatId](); } catch (e) {}
                }
                if (currentStreamAbortControllers[msg.chatId]) {
                    try { currentStreamAbortControllers[msg.chatId].abort(); } catch (e) {}
                }
            }
            return;

        case 'pull-chat':
            if (msg.chatId && chats[msg.chatId]) {
                // MEMFIX: the SW's copy may be payload-evicted (worker loader
                // strips all chats). The page assigns this snapshot WHOLESALE
                // (app/045), which would clobber a hydrated page copy with an
                // evicted one — rehydrate before replying. ensureChatPayloads
                // never rejects and is a fast no-op for hydrated chats.
                var _pcSend = function() {
                    if (!chats[msg.chatId]) return;
                    try {
                        port.postMessage({ type: 'chat-snapshot', chatId: msg.chatId, chat: chats[msg.chatId] });
                    } catch (e) {}
                };
                if (chats[msg.chatId]._payloadsEvicted && typeof ensureChatPayloads === 'function') {
                    ensureChatPayloads(msg.chatId).then(_pcSend);
                } else {
                    _pcSend();
                }
            }
            return;

        case 'dev-mode':
            // runtime_inspect dev-mode flag. Pushed by the page's
            // _pushDevModeToSW (tools/140-runtime-inspect.js) on bus connect
            // and whenever updateReloadBtnVisibility recomputes the gate.
            // Consumed by getEnabledTools (worker/025-permissions-helpers.js)
            // and the devOnly skill gate (_devModeActiveSync).
            self._swDevModeActive = !!msg.active;
            return;

        case 'pull-debug-state':
            // runtime_inspect action:'sw_state' — reply with a summary of the
            // SW's live run/tool state. Every global is typeof-guarded: this
            // handler must never throw on a partially-initialized SW.
            try {
                var _dbgParked = {};
                if (typeof parkedToolCallsByChatId !== 'undefined') {
                    Object.keys(parkedToolCallsByChatId).forEach(function(cid) {
                        var _pArr = parkedToolCallsByChatId[cid];
                        if (_pArr && _pArr.length) _dbgParked[cid] = _pArr.length;
                    });
                }
                var _dbgPending = [];
                if (typeof _pendingUIToolCalls !== 'undefined') {
                    Object.keys(_pendingUIToolCalls).forEach(function(tcid) {
                        var _pe = _pendingUIToolCalls[tcid];
                        _dbgPending.push({ toolCallId: tcid, startedAt: (_pe && _pe.startedAt) || null });
                    });
                }
                port.postMessage({ type: 'debug-state', requestId: msg.requestId, state: {
                    runningChatIds: (typeof runningChatIds !== 'undefined') ? Object.keys(runningChatIds).filter(function(c) { return runningChatIds[c]; }) : [],
                    pendingUIToolCalls: _dbgPending,
                    parkedToolCalls: _dbgParked,
                    connectedPorts: (typeof _swPanelPorts !== 'undefined') ? _swPanelPorts.size : null,
                    resumeScanSettled: (typeof _swResumeScanSettled !== 'undefined') ? !!_swResumeScanSettled : null,
                    devMode: !!self._swDevModeActive
                } });
            } catch (e) { /* port died — the page side times out after 5s */ }
            return;

        case 'update-chat':
            // Panel-side mutations OUTSIDE a run (title rename, manual edit).
            // Same authoritative-writer rule as `run-agent`: never replace
            // chats[chatId] while a run is in flight for it, otherwise we
            // clobber the SW's in-flight tool_result placeholders / partial
            // assistant message and the next save persists an orphan shape.
            if (msg.chatId && msg.chat && !runningChatIds[msg.chatId]
                && !(typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard[msg.chatId])) {
                chats[msg.chatId] = msg.chat;
            }
            return;

        case 'record-mutation':
            // A PAGE-TIER tool execution (widget executeTool in
            // ui/070-dashboard-ui.js runs servicenow_api / servicenow_diff_edit
            // in the panel) appended a versionHistory entry to the page's
            // NON-authoritative chats mirror only (trackRecordMutation in
            // tools/020-tool-execution.js). The SW owns chats[chatId], so
            // without this append the next chat-inlined snapshot broadcast /
            // SW saveChatsToStorage drops the entry and the record vanishes
            // from the sidebar Artifacts list. Append it to the authoritative
            // copy — deduped by entry.id, because the page may also round-trip
            // the same entry back inside a run-agent / update-chat snapshot —
            // and persist. Gated on the boot promise so a cold-boot arrival
            // doesn't touch an un-hydrated `chats` (same rationale as the
            // 'send-message' gate above; a missing chat after boot means the
            // SW never saw it — the page's own IDB save already carries the
            // entry in that case).
            (self._swBootReady || Promise.resolve()).then(function() {
                try {
                    var rmEntry = msg.entry;
                    var rmChat = msg.chatId ? chats[msg.chatId] : null;
                    if (!rmChat || !rmEntry || !rmEntry.id) return;
                    if (!Array.isArray(rmChat.versionHistory)) rmChat.versionHistory = [];
                    var rmDup = rmChat.versionHistory.some(function(v) { return v && v.id === rmEntry.id; });
                    if (rmDup) return;
                    rmChat.versionHistory.push(rmEntry);
                    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
                } catch (e) { console.error('[port-bridge] record-mutation append failed', msg.chatId, e); }
            });
            return;

        case 'exec-tool-result':
            resolvePendingUIToolCall(msg.toolCallId, msg.result, msg.error);
            return;

        case 'exec-approval-prompt-result':
            resolvePendingUIToolCall(msg.approvalRequestId,
                { allowed: !!msg.allowed }, msg.error || null);
            return;

        case 'hooks-settings':
            // Panel toggled a hook (auto-title / showHookMessages). Mirror the
            // new value so the SW's executeAfterResponseHooks + getEnabledTools
            // observe it immediately, without waiting for SW restart.
            if (msg.hooksEnabled && typeof msg.hooksEnabled === 'object') {
                hooksEnabled = msg.hooksEnabled;
            }
            return;

        case 'deferred-tools-setting':
            // Panel toggled deferred tool loading (Settings). Mirror so the
            // SW's getEnabledTools / getToolCatalogForPrompt observe it
            // immediately, without waiting for SW restart — same pattern as
            // 'hooks-settings'. The global lives in core/030-config.js
            // (WORKER_SHARED_FILES); pushed by
            // pushDeferredToolsSettingToOffscreen (045-agent-port-bridge-page.js).
            deferredToolsEnabled = !!msg.enabled;
            return;

        case 'permissions-update':
            // Panel mutated a permission source. Three independent slots:
            //   • toolPermissions   — "Always allow" + settings-page edits
            //   • instancePermissions — per-host overrides
            //   • sessionPermissions — "Allow for session" (in-memory only)
            // Each is sent individually (null when unchanged) so the panel can
            // push just the slot that moved. Without this, the SW's
            // getToolPermission keeps returning 'ask' after the user picks
            // "Allow for session" / "Always allow", and the approval prompt
            // keeps firing on every tool call.
            if (msg.toolPermissions && typeof msg.toolPermissions === 'object') {
                toolPermissions = msg.toolPermissions;
            }
            if (msg.instancePermissions && typeof msg.instancePermissions === 'object') {
                instancePermissions = msg.instancePermissions;
            }
            if (msg.sessionPermissions && typeof msg.sessionPermissions === 'object') {
                sessionPermissions = msg.sessionPermissions;
            }
            return;

        case 'focus-chat':
            // SAGF-1: the page tells us which chat the user is now viewing so
            // the sub-agent GC paths (_idleSweepTick / loadAllSubAgents) don't
            // reclaim a tombstone/abandoned-sleep transcript mid-read. In the SW
            // currentChatId is permanently null, so this is the only focus signal.
            if (typeof SubAgents !== 'undefined' && SubAgents.setFocusedChat) {
                // SWM2-F2: pass a stable per-panel key so multiple panels each viewing
                // a different chat don't clobber each other's focus (last-writer-wins
                // would GC the other panel's viewed transcript). One panel → one key →
                // identical to the pre-F2 single-focus behavior. A null msg.chatId
                // (user left the chat view) clears just THIS port's entry.
                SubAgents.setFocusedChat(msg.chatId, _panelId(port));
            }
            return;

        case 'panel-hello':
            // Panel declares which tool executions it's still running AND
            // which it finished but whose result may not have been
            // persisted (in case the previous SW died right after the
            // dispatch). tool-routing.js marks both as adopted so the
            // executeTool wrapper short-circuits to the buffered result
            // instead of dispatching a duplicate exec-tool.
            if (typeof self._swAdoptPanelInflight === 'function') {
                // SWM3F-1: pass the connecting port so adopted in-flight tools
                // record the adopting panel's port — lets _unregisterPanel see
                // (and clean-reject) them if that panel later disconnects.
                self._swAdoptPanelInflight({
                    inflightToolCalls: msg.inflightToolCalls || [],
                    completedToolResults: msg.completedToolResults || []
                }, port);
            }
            return;

        case 'relay-agent-event':
            // WSM-RELAY: a panel relays a PAGE-LOCAL emit here so it reaches
            // the other panels — re-emitting on the SW bus hands it to the
            // worker/100 broadcast patch, which forwards it to every connected
            // panel (including the origin; its handlers are idempotent
            // renders). The _relayed stamp stops the origin's relay hook from
            // bouncing it back. Whitelisted event types only — this is a
            // broadcast amplifier, keep it to workspace-level events.
            if (msg.eventType === 'workspaceMutated' && msg.detail &&
                typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
                try {
                    AgentEvents.emit('workspaceMutated', Object.assign({}, msg.detail, { _relayed: true }));
                } catch (e) {}
            }
            return;

        case 'prepare-reload':
            // RELOAD-DB: the panel is about to call chrome.runtime.reload(). Close
            // THIS service worker's cached IDB connection cleanly before the abrupt
            // context teardown -- an abandoned open connection can make Chrome
            // force-close the origin's IndexedDB backing store, wedging the DB
            // (open() hangs / UnknownError) until a full browser restart. Also close
            // the offscreen doc (best-effort) so it isn't torn down mid-flight.
            try { if (typeof closeDatabase === 'function') closeDatabase(); } catch (e) {}
            try {
                if (typeof chrome !== 'undefined' && chrome.offscreen && chrome.offscreen.closeDocument) {
                    Promise.resolve(
                        chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : true
                    ).then(function(has) {
                        if (has) { try { chrome.offscreen.closeDocument(); } catch (e) {} }
                    }).catch(function() {});
                }
            } catch (e) {}
            return;
    }
}

// SWM-S1: extract the trailing user-input block of an incoming chat snapshot
// that the SW's own copy does NOT have. Used by the run-agent handler's
// flap-recovery path above. Walks the snapshot tail collecting user-input
// rows (user text + screenshot/pdf/file attachment rows — the shapes the
// page's idle send path pushes), then drops any row already present in the
// SW copy's tail under a CONSERVATIVE identity check (exact role + content /
// base64 + name match) — preferring a skipped recovery over a double-inject.
// REG376-1: pendInj (optional) is the chat's un-flushed pendingInjectionsByChatId
// entry — candidates already queued there are 'seen' too, or a second flap
// inside the queue→flush window re-recovered and duplicated them.
// Returns { text, images, count } or null when nothing unseen remains.
function _extractUnseenTrailingUserInput(inChat, swChat, pendInj) {
    var inMsgs = (inChat && inChat.messages) || [];
    var swMsgs = (swChat && swChat.messages) || [];
    // REG-F4: include 'context' — the page's idle send path pushes a
    // role:'context' row AFTER the user row for Smart Document references
    // (app/040-send-message.js); without it the backward walk broke at the
    // context row and recovered NOTHING for a doc-referencing send.
    var TRAIL_ROLES = { user: 1, screenshot: 1, pdf: 1, file: 1, context: 1 };
    var block = [];
    for (var i = inMsgs.length - 1; i >= 0; i--) {
        var m = inMsgs[i];
        if (!m || !TRAIL_ROLES[m.role]) break;
        block.unshift(m);
    }
    if (!block.length) return null;
    // REG-F2 (revised): scan everything the SW added BEYOND the shared
    // prefix, not the entire SW copy. The page mirror is exactly
    // <shared prefix> + <trailing block>, so the prefix occupies SW indexes
    // 0..(inMsgs.length - block.length - 1) and anything the SW appended
    // while the port was down — including the tool-heavy 20+-row tails the
    // original bounded (+20) scan missed — sits at index >= that boundary.
    // Scanning from the boundary keeps REG-F2's guarantee (an already-
    // processed message arbitrarily deep in the SW tail is still found, no
    // double-inject + interrupt of a healthy stream) WITHOUT the full-scan
    // regression: with tailStart 0, a genuinely-new re-send whose text
    // equals ANY older row in the shared history ("yes", "ok", "continue")
    // dedup-matched the OLD occurrence and the recovery was silently
    // dropped.
    var tailStart = Math.max(0, inMsgs.length - block.length);
    function _seenInSwTail(cand) {
        // REG376-1: a cand already sitting in the un-flushed pending injection
        // (a previous flap's recovery the loop hasn't consumed yet) is seen —
        // it lives in NO chat row yet, so the SW-tail scan below cannot find
        // it. Text cands match whole or as a '\n\n'-boundary segment (pendInj
        // text is itself a '\n\n' join — same anchoring as the REG-AUDIT-1 row
        // check); attachment cands match on content/base64 + name.
        if (pendInj) {
            if ((cand.role === 'user' || cand.role === 'context') &&
                typeof cand.content === 'string' && cand.content &&
                typeof pendInj.text === 'string' && pendInj.text &&
                (pendInj.text === cand.content ||
                 ('\n\n' + pendInj.text + '\n\n').indexOf('\n\n' + cand.content + '\n\n') !== -1)) return true;
            if (cand.role !== 'user' && cand.role !== 'context' && pendInj.images && pendInj.images.length) {
                for (var k = 0; k < pendInj.images.length; k++) {
                    var pImg = pendInj.images[k];
                    if (cand.role === 'file') {
                        if (pImg.fileType === 'file' && pImg.content === cand.content && pImg.name === cand.name) return true;
                    } else if (pImg.base64 && pImg.base64 === cand.base64 && pImg.name === cand.name) return true;
                }
            }
        }
        for (var j = swMsgs.length - 1; j >= tailStart; j--) {
            var s = swMsgs[j];
            if (!s) continue;
            // REG-F4: a recovered context row is re-injected JOINED into a
            // single user row by flushPendingInjection (its content is appended
            // to the injected text), so dedup must also treat a user row
            // CONTAINING the context pointer as 'seen'. The bracketed pointer
            // carries a unique doc_id, so containment cannot false-positive
            // the way generic user text would.
            if (cand.role === 'context' && s.role === 'user' &&
                typeof s.content === 'string' && typeof cand.content === 'string' &&
                cand.content && s.content.indexOf(cand.content) !== -1) return true;
            if (s.role !== cand.role) continue;
            if (cand.role === 'user' || cand.role === 'context') {
                if (s.content === cand.content) return true;
                // REG-AUDIT-1: a recovered multi-row block (user text + context
                // rows) is re-injected by flushPendingInjection as ONE user row
                // whose content is texts.join('\n\n'). Exact equality alone
                // misses the original user cand inside that joined SW row
                // ("M2\n\nC" never === "M2") → a second port flap duplicated
                // the user's text. Treat the cand as seen when an SW user row
                // contains it as a '\n\n'-boundary-delimited segment; the
                // boundary anchoring (and multi-paragraph cands matching as a
                // whole) avoids generic substring false positives, and the
                // tailStart-bounded loop preserves #375's bounded-scan
                // guarantee.
                // REG376-2: containment applies ONLY to rows stamped
                // injected:true by flushPendingInjection (the only writer of
                // joined rows). Matching ANY user row dropped a genuinely-new
                // re-send whose text equaled a '\n\n'-paragraph of an earlier
                // organic multi-paragraph message. (Joined rows persisted
                // before the stamp existed lose containment dedup, but that
                // exposure is transient — only flap windows on already-running
                // chats are scanned.)
                if (s.role === 'user' && s.injected === true &&
                    typeof s.content === 'string' && typeof cand.content === 'string' && cand.content &&
                    s.content !== cand.content &&
                    ('\n\n' + s.content + '\n\n').indexOf('\n\n' + cand.content + '\n\n') !== -1) return true;
            } else if (cand.role === 'file') {
                if (s.content === cand.content && s.name === cand.name) return true;
            } else {
                if (s.base64 === cand.base64 && s.name === cand.name) return true;
            }
        }
        return false;
    }
    var texts = [];
    var images = [];
    // REG-F4: unseen context rows ride along inline in block order — their
    // content is already a self-describing bracketed pointer ("[User
    // referenced Smart Document ...]") so joining them into the injected text
    // preserves the doc_id for the model. They never count as recoverable user
    // input on their own: the page always pushes the user row first, so a
    // context-only unseen block means there is nothing genuinely new to
    // recover.
    var hasUserInput = false;
    block.forEach(function(m) {
        if (_seenInSwTail(m)) return;
        if (m.role === 'user') {
            if (typeof m.content === 'string' && m.content) { texts.push(m.content); hasUserInput = true; }
        } else if (m.role === 'context') {
            if (typeof m.content === 'string' && m.content) texts.push(m.content);
        } else if (m.role === 'pdf') {
            images.push({ fileType: 'pdf', base64: m.base64, name: m.name, file_id: m.file_id });
            hasUserInput = true;
        } else if (m.role === 'file') {
            images.push({ fileType: 'file', content: m.content, name: m.name, mimeType: m.mimeType, size: m.size, file_id: m.file_id });
            hasUserInput = true;
        } else {
            images.push({ fileType: 'image', base64: m.base64, name: m.name, width: m.width, height: m.height, file_id: m.file_id });
            hasUserInput = true;
        }
    });
    // REG-F4: context-only (or empty) recovery ⇒ nothing to recover.
    if (!hasUserInput) return null;
    return {
        text: texts.length ? texts.join('\n\n') : null,
        images: images.length ? images : null,
        count: texts.length + images.length
    };
}

// Handle a send-message from a panel.
//
// Two modes:
//   • Running chat — stash the text/images in pendingInjectionsByChatId
//     and fire the interrupt + stream abort. The loop's flushPendingInjection
//     (called from inside its catch/continue paths) pushes the user message
//     into chat.messages on the next iteration. We do NOT push here, or the
//     loop would push a duplicate.
//   • Idle chat — push the user message + attachments now, save to IDB,
//     and start a fresh run.
async function _handlePanelSendMessage(msg) {
    var chatId = msg.chatId;
    if (!chatId) return;
    if (!chats[chatId]) chats[chatId] = msg.chat || { id: chatId, messages: [] };

    // MEMFIX: rehydrate a payload-evicted chat BEFORE the idle branch pushes
    // the user's message and awaits saveChatsToStorage — the save put-loop
    // skips evicted chats, so without this the just-typed message would never
    // persist (lost on SW death). Also needed so the run that follows can
    // inline vision blocks. ensureChatPayloads never rejects.
    if (typeof ensureChatPayloads === 'function') {
        try { await ensureChatPayloads(chatId); } catch (e) {}
    }

    // B10: the user sending a message means they intend this chat to run now —
    // clear any stale SW-side pause flag (mirrors the run-agent handler @:172).
    // Without this, sending to a chat the SW still considers paused trips the
    // loop's `while (!isChatPaused)` gate immediately and silently drops the run
    // (runFinished{reason:'paused'}). Covers both the idle restart below and the
    // running-branch case where the loop is about to exit on a stale pause.
    setChatPausedPersistent(chatId, false); // also clears persisted pausedByUser
    pausedChatIds[chatId] = false;

    // RES-6: a user send into a SUB-AGENT chat is an unsolicited lifecycle
    // event — stamp user_interactions.last_user_message_at on the record and
    // push a lifecycle notice to the parent (the sub may go off-script under
    // user direction). Covers both branches below (live injection AND idle
    // restart). Best-effort: a hook failure must never block the send.
    if (chats[chatId] && chats[chatId].isSubAgent
        && typeof SubAgents !== 'undefined' && SubAgents.onUserMessageToSubChat) {
        try { SubAgents.onUserMessageToSubChat(chatId); }
        catch (e) { console.warn('[port-bridge] onUserMessageToSubChat threw', e); }
    }

    if (runningChatIds[chatId]) {
        // SWM-INJ-DROP: concatenate rather than flat-replace. Two rapid sends inside one
        // abort/restart window previously dropped the first message at the model level,
        // because the second assignment clobbered the first un-flushed injection. Merge
        // text (separator between non-empty parts) and concat image arrays, mirroring the
        // page-side merge in app/040-send-message.js:39-51.
        var _existingInj = pendingInjectionsByChatId[chatId];
        if (_existingInj) {
            var _mergedText;
            if (_existingInj.text && msg.text) _mergedText = _existingInj.text + '\n\n' + msg.text;
            else _mergedText = _existingInj.text || msg.text || null;
            var _mergedImages;
            if (_existingInj.images && msg.images) _mergedImages = _existingInj.images.concat(msg.images);
            else _mergedImages = _existingInj.images || msg.images || null;
            pendingInjectionsByChatId[chatId] = { text: _mergedText, images: _mergedImages };
        } else {
            pendingInjectionsByChatId[chatId] = {
                text: msg.text || null,
                images: msg.images || null
            };
        }
        userInterruptedChats[chatId] = true;
        if (interruptResolversByChatId[chatId]) {
            try { interruptResolversByChatId[chatId](); } catch (e) {}
        }
        if (currentStreamAbortControllers[chatId]) {
            try { currentStreamAbortControllers[chatId].abort(); } catch (e) {}
        }
        return;
    }

    // Idle — push immediately and start the loop.
    if (msg.text || (msg.images && msg.images.length)) {
        if (msg.text) chats[chatId].messages.push({ role: 'user', content: msg.text });
        if (msg.images && msg.images.length) {
            msg.images.forEach(function(img) {
                if (img.fileType === 'pdf') {
                    chats[chatId].messages.push({ role: 'pdf', base64: img.base64, name: img.name, description: 'User attached PDF', timestamp: Date.now(), file_id: img.file_id });
                } else if (img.fileType === 'file') {
                    chats[chatId].messages.push({ role: 'file', content: img.content, name: img.name, mimeType: img.mimeType, size: img.size, description: 'User attached file', timestamp: Date.now(), file_id: img.file_id });
                } else {
                    chats[chatId].messages.push({ role: 'screenshot', base64: img.base64, name: img.name, description: 'User attached image', timestamp: Date.now(), width: img.width, height: img.height, file_id: img.file_id });
                }
            });
        }
        try { await saveChatsToStorage(); } catch (e) {}
    }

    runAgent(chatId);
}

// =============================================================
// Re-entry point for the alarm-driven resume scan in background.js.
// Called when the SW alarm finds running checkpoints AND the SW
// runtime is back up. Idempotent — already-running chats are
// skipped by the runningChatIds guard inside runAgent.
// =============================================================
function resumeRunningCheckpoints(checkpoints) {
    // REG-AUDIT-2: nothing to resume — the scan is decided; settle so the
    // page's hello-grace reconcile doesn't keep extending its grace window.
    if (!checkpoints || !checkpoints.length) { _settleResumeScan(); return; }
    // Three gates, in order:
    //   1. _swBootReady — `chats` and providers are loaded. background.js's
    //      onStartup/heartbeat path calls this function independently of
    //      entry.js's boot, and would otherwise see an empty `chats` global
    //      and crash on `chats[streamingChatId].messages`.
    //   2. _swResumeGate — at least one panel-hello has arrived (or 1.5s
    //      fallback). Required so the agent loop's executeTool wrapper can
    //      see panel-declared in-flight tools and adopt them instead of
    //      redispatching (would cause double execution — typing text twice).
    //   3. Platform.ready + loadApiProviders — same as before.
    (self._swBootReady || Promise.resolve())
        .then(function() { return self._swResumeGate || Promise.resolve(); })
        .then(function() { return Platform.ready; })
        .then(function() { return loadApiProviders(); })
        // MEMFIX: the SW loader evicts inline base64 payloads from every chat
        // (worker/115-storage.js). Rehydrate each checkpoint's chat BEFORE
        // runAgent so the resumed loop can inline vision blocks and its saves
        // aren't skipped by the evicted-put guard. ensureChatPayloads never
        // rejects, so this can't fail the gate chain.
        .then(function() {
            if (typeof ensureChatPayloads !== 'function') return;
            return Promise.all(checkpoints.map(function(cp) {
                return ensureChatPayloads(cp.chatId);
            }));
        })
        .then(function() {
            checkpoints.forEach(function(cp) {
                // Do NOT repopulate parkedToolCallsByChatId here. The persisted
                // entries' resolve/reject are gone (the original agent loop died
                // with the SW). If we restored them with no-op stubs, the next
                // panel connect would dispatchUIToolToPort and execute the parked
                // tool a second time — meanwhile injectInterruptedToolResults has
                // already filled the orphan tool_use with a placeholder result, so
                // the model on resume will either accept the placeholder or issue
                // a fresh tool_use (which the panel would also execute). Either
                // way the replayed call's result is discarded. Cleaner to skip.
                // ZR-1: SUB-AGENT chats resume only when the registry still
                // says 'running' — loadAllSubAgents (awaited by 190-entry's
                // boot Promise.all BEFORE this scan runs) keeps checkpoint-
                // resumable subs 'running' and claims their pool slot, and
                // orphan-errors the rest. Resuming a terminal/missing record
                // would restart the loop as a ZOMBIE: tokens burned outside
                // the pool cap, report_to_parent rejected against an already-
                // settled record + handle. Reap the stale checkpoint so the
                // alarm-driven path (background.js → this function) can't
                // revive it later either.
                var _chatRow = (typeof chats !== 'undefined') ? chats[cp.chatId] : null;
                var _looksSub = ((cp.chatId || '').indexOf('chat_sub_') === 0)
                    || !!(_chatRow && _chatRow.isSubAgent);
                if (_looksSub) {
                    var _subRec = (typeof SubAgents !== 'undefined' && SubAgents.getByChatId)
                        ? SubAgents.getByChatId(cp.chatId) : null;
                    if (!_subRec) {
                        // ZR1 follow-up: a missing record means EITHER the
                        // record was GC'd (stale checkpoint — reap) OR the
                        // registry never hydrated this boot (loadAll failed;
                        // 097 swallows the drain error and isLoaded() stays
                        // false). Reaping on a failed hydration irreversibly
                        // loses a resumable sub — skip (no resume, no reap)
                        // and let the alarm-driven path retry after a
                        // successful hydration.
                        if (typeof SubAgents !== 'undefined' && SubAgents.isLoaded && SubAgents.isLoaded()) {
                            try { deleteAgentCheckpoint(cp.chatId); } catch (e) {}
                        }
                        return;
                    }
                    if (_subRec.state !== 'running') {
                        // Record already terminal/sleeping — stale checkpoint,
                        // never restart. (The record EXISTS and is
                        // authoritative, so the reap is correct regardless of
                        // hydration state.)
                        try { deleteAgentCheckpoint(cp.chatId); } catch (e) {}
                        return;
                    }
                    if (!_chatRow) {
                        // Running record but the chat transcript vanished from
                        // the chats store (runAgent would crash; the boot
                        // decision in 097 deliberately skipped this check — it
                        // races loadChatsFromStorage there, but here the boot
                        // Promise.all has settled so absence is real). Settle
                        // everything (record + rehydrated pending handle +
                        // pool slot + parent notice) via markOrphaned.
                        try {
                            if (SubAgents.markOrphaned) SubAgents.markOrphaned(_subRec.agent_id);
                        } catch (e) {}
                        try { deleteAgentCheckpoint(cp.chatId); } catch (e) {}
                        return;
                    }
                }
                if (!runningChatIds[cp.chatId]) {
                    if (_looksSub && _subRec) {
                        // ZR1-R1: the boot decision in 097 already claimed this
                        // sub's pool slot; a runAgent failure here (sync throw OR
                        // async rejection before the loop's runFinished/runCrashed
                        // events exist) would otherwise leave the record fake-
                        // 'running' with a claimed slot + pending handle forever
                        // (no sweeper covers 'running'). Same wrapper pattern as
                        // _drainPool: settle record/slot/handle via markOrphaned,
                        // then reap the checkpoint ONLY if the record went
                        // terminal (see the conditional reap in the catch — a
                        // transient crash keeps the sub alive via the retry latch).
                        Promise.resolve()
                            .then(function() { return runAgent(cp.chatId); })
                            .catch(function(err) {
                                console.error('[port-bridge] resume runAgent failed for sub chat', cp.chatId, err);
                                try {
                                    if (typeof SubAgents !== 'undefined' && SubAgents.markOrphaned) {
                                        SubAgents.markOrphaned(_subRec.agent_id, 'resume failed: ' + (err && err.message || err));
                                    }
                                } catch (e2) {}
                                // ZR1-R1 (follow-up): markOrphaned routes a
                                // TRANSIENT-class failure with an unused retry
                                // latch into _queueTransientRetry — the sub is
                                // still ALIVE (state stays 'running', re-queued
                                // or in the ~8s throttle back-off) and its next
                                // runStarted re-writes the checkpoint. Reaping
                                // unconditionally here left the live retry with
                                // no durable checkpoint until then — an SW death
                                // in that window orphaned a sub that should have
                                // resumed. Only reap when the record actually
                                // went terminal (or is gone): a still-'running'
                                // record means the retry owns the checkpoint.
                                try {
                                    var _postRec = (typeof SubAgents !== 'undefined' && SubAgents.getByChatId)
                                        ? SubAgents.getByChatId(cp.chatId) : null;
                                    if (!_postRec || _postRec.state !== 'running') {
                                        try { deleteAgentCheckpoint(cp.chatId); } catch (e2) {}
                                    }
                                } catch (e2) {}
                            });
                    } else {
                        try { runAgent(cp.chatId); }
                        catch (e) { console.error('[port-bridge] resume runAgent threw', cp.chatId, e); }
                    }
                }
            });
            // REG-AUDIT-2: every checkpoint has been re-armed (runAgent fires
            // runStarted synchronously enough for the page's grace re-check) —
            // the resume scan is settled.
            _settleResumeScan();
        })
        .catch(function(e) {
            // REG-AUDIT-2: a gate failure must still settle, or the page would
            // burn its extended grace window for nothing.
            console.error('[port-bridge] resume gate chain failed', e);
            // ZR1-R1: nothing was resumed, but the boot decision in 097 already
            // claimed pool slots for checkpoint-resumable subs. Without runAgent
            // those records stay fake-'running' (claimed slot, pending handle)
            // for the whole SW session and block the 2-slot pool. Orphan them so
            // record + slot + handle + parent card all settle — shared registry-
            // side sweep (also used by 190-entry's outer boot .catch).
            _orphanUnresumedSubs('resume aborted: boot gate chain failed: ' + (e && e.message || e));
            _settleResumeScan();
        });
}
self.resumeRunningCheckpoints = resumeRunningCheckpoints;
