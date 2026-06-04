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
            // Initial sub-agent snapshot. The page's own loadAllSubAgents
            // (which skips the orphan-rewrite per PR #244) populated the
            // page mirror from IDB at panel boot — the SW is authoritative
            // and overwrites that view here via SubAgents.applySnapshot in
            // the page-side hello handler. After this, live updates flow
            // via the `subagent-snapshot` envelope from
            // src/js/worker/105-subagent-broadcast.js.
            subAgentRecords: (typeof SubAgents !== 'undefined' && SubAgents.listAll) ? SubAgents.listAll() : []
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
                if (!_adoptedResults[id]) delete _adoptedResults[id];
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
                var isRunning = !!runningChatIds[msg.chatId];
                if (msg.chat && !isRunning) chats[msg.chatId] = msg.chat;
                if (msg.currentProvider) currentProvider = msg.currentProvider;
                // SWM1F-1: a run-agent means the user intends this chat to run
                // now, so clear any stale SW-side pause flag. Post-SW-move the
                // loop's `while (!isChatPaused)` gate reads the SW's pausedChats
                // copy; the page only clears its OWN pausedChats copy on send, so
                // without this a chat that was paused then re-run trips the gate
                // immediately and the just-sent run is silently dropped
                // (runFinished{reason:'paused'}). Keep pausedChatIds in sync — we
                // are intentionally NOT removing it (SWM1F-2 deferred).
                if (!isRunning) { pausedChats[msg.chatId] = false; pausedChatIds[msg.chatId] = false; }
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
                    .then(function() {
                        if (!runningChatIds[msg.chatId]) {
                            try { runAgent(msg.chatId); }
                            catch (e) { console.error('[port-bridge] runAgent threw', e); }
                        }
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
            (self._swBootReady || Promise.resolve())
                .then(function() { return Platform.ready; })
                .then(function() { return loadApiProviders(); })
                .then(function() {
                    try { _handlePanelSendMessage(msg); }
                    catch (e) { console.error('[port-bridge] _handlePanelSendMessage threw', e); }
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
            pausedChats[msg.chatId] = !!msg.paused;
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
                try {
                    port.postMessage({ type: 'chat-snapshot', chatId: msg.chatId, chat: chats[msg.chatId] });
                } catch (e) {}
            }
            return;

        case 'update-chat':
            // Panel-side mutations OUTSIDE a run (title rename, manual edit).
            // Same authoritative-writer rule as `run-agent`: never replace
            // chats[chatId] while a run is in flight for it, otherwise we
            // clobber the SW's in-flight tool_result placeholders / partial
            // assistant message and the next save persists an orphan shape.
            if (msg.chatId && msg.chat && !runningChatIds[msg.chatId]) {
                chats[msg.chatId] = msg.chat;
            }
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
    }
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

    // B10: the user sending a message means they intend this chat to run now —
    // clear any stale SW-side pause flag (mirrors the run-agent handler @:172).
    // Without this, sending to a chat the SW still considers paused trips the
    // loop's `while (!isChatPaused)` gate immediately and silently drops the run
    // (runFinished{reason:'paused'}). Covers both the idle restart below and the
    // running-branch case where the loop is about to exit on a stale pause.
    pausedChats[chatId] = false;
    pausedChatIds[chatId] = false;

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
    if (!checkpoints || !checkpoints.length) return;
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
                if (!runningChatIds[cp.chatId]) {
                    try { runAgent(cp.chatId); }
                    catch (e) { console.error('[port-bridge] resume runAgent threw', cp.chatId, e); }
                }
            });
        });
}
self.resumeRunningCheckpoints = resumeRunningCheckpoints;
