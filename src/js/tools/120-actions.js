// =============================================
// ACTIONS SYSTEM — Engine
// =============================================
// Actions are one-click buttons that trigger agent workflows in background
// chats. The PM clicks a button, sees live progress, and interacts via popups.
//
// Data model:
//   skills[skillId].actions = [ { name, icon, show: ['home','header',...] } ]
//   activeActions[actionId] = {
//     actionId, skillId, skillName, actionName, originalIcon, originalLabel,
//     chatId, sourceChatId,
//     state, icon, label, tasks, startedAt, updatedAt,
//     needsInputPromptId, needsApprovalMessageId
//   }

var activeActions = {};                // actionId -> live state (in-memory + IDB)
var actionStateListeners = [];         // functions to notify on state change
var ACTION_STATES = ['idle', 'running', 'stuck', 'needs_input', 'needs_permission', 'done', 'error', 'stopped'];
// Icons the agent is allowed to set via update_action_state (matches the tool def enum).
// Used to coerce unknown values down to 'spinner' instead of silently rendering an off-list icon.
var ALLOWED_ACTION_ICONS = ['search','shield','eye','play','check','close','spinner','lock','pause','stop','bell','code','database','stats','zap','alert','list','clipboard','rocket','bug'];

// ---------- ID helpers ----------

function getActionId(skillId, actionName) {
    return 'action_' + skillId + '__' + (actionName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// Escape a value for safe embedding inside a JS string literal in an inline
// onclick="..." attribute. escapeHtml is wrong here because it converts ' to
// &#39; — which the HTML parser decodes back to ' and then breaks the JS string.
// We escape backslashes + quotes + html-special chars using JS escape sequences,
// so the result is safe in BOTH the HTML attribute parser and the JS parser.
function escapeJsString(s) {
    return String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\x22')
        .replace(/</g, '\\x3c')
        .replace(/>/g, '\\x3e')
        .replace(/&/g, '\\x26')
        .replace(/\r?\n/g, '\\n');
}

// ---------- Persistence (IndexedDB) ----------

async function persistActionState(actionId) {
    try {
        var a = activeActions[actionId];
        if (!a) return;
        var database = await openDatabase();
        var tx = database.transaction([actionStateStoreName], 'readwrite');
        tx.objectStore(actionStateStoreName).put(a);
        broadcastActionChange('update', actionId, a.chatId);
    } catch (e) { /* non-fatal */ }
}

async function deleteActionStateFromDB(actionId) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([actionStateStoreName], 'readwrite');
        tx.objectStore(actionStateStoreName).delete(actionId);
        broadcastActionChange('delete', actionId, null);
    } catch (e) { /* non-fatal */ }
}

async function loadAllActionStates() {
    try {
        var database = await openDatabase();
        var tx = database.transaction([actionStateStoreName], 'readonly');
        var store = tx.objectStore(actionStateStoreName);
        var req = store.getAll();
        var toResume = [];
        await new Promise(function(resolve) {
            req.onsuccess = function() {
                var list = req.result || [];
                list.forEach(function(a) {
                    // Stale setTimeout handle from a previous session — the timer is gone but
                    // the number was persisted. Clear so future logic doesn't think a timer is armed.
                    a._dismissTimer = null;
                    // Keep state, icon, label, tasks as-is. Mark as interrupted so the button
                    // shows a paused appearance and clicking offers "resume".
                    if (a.state === 'running') {
                        a.reloadInterrupted = true;
                        // Don't auto-resume on page reload. The original streaming agent
                        // loop is dead, and silently re-kicking it leaves the UI showing a
                        // Pause button while no real progress happens. Instead, show the
                        // Continue button (in chat view) and the Resume affordance on the
                        // action button so the user explicitly resumes.
                        if (a._isPaused && a.chatId) {
                            // Mirror the explicit-pause flag into pausedChats so any
                            // BroadcastChannel-driven resume bails until the user clicks Resume.
                            pausedChats[a.chatId] = true;
                        }
                    }
                    activeActions[a.actionId] = a;
                });
                resolve();
            };
            req.onerror = function() { resolve(); };
        });
        // No auto-resume on page reload. The previous agent loop died with the page,
        // so silently re-kicking runAgent here was unreliable — it produced a stuck
        // "Pause" button while no real progress happened. The user resumes explicitly
        // via the Continue button (in chat view) or Resume on the action button.
        // The unused `toResume` array is kept above for clarity, but is intentionally
        // not iterated here.
        void toResume;
    } catch (e) { /* non-fatal */ }
}

// ---------- Multi-tab coordination ----------
// Two tabs hosting the extension each keep their own in-memory activeActions map.
// We bridge them with a BroadcastChannel for visual state sync. (There is no
// boot-time auto-resume — see loadAllActionStates above. The agent loop is
// per-tab and re-kicked explicitly by resumeAction when the user clicks Resume.)

var _actionsBC = null;
try { _actionsBC = new BroadcastChannel('appagent-actions'); } catch (e) {}

function broadcastActionChange(type, actionId, chatId) {
    if (!_actionsBC) return;
    try { _actionsBC.postMessage({ type: type, actionId: actionId, chatId: chatId || null }); } catch (e) {}
}

// Re-sync the chat-page Pause/Continue UI when a chat's pause state flipped
// outside of `togglePause`/`continueAgent` — e.g. via the action popover
// (pauseAction/resumeAction/stopAction/dismissAction) or via BroadcastChannel
// from another tab. Only touches UI when the affected chat is the one the user
// is currently viewing; otherwise the next navigation into that chat will sync
// it via selectChat / openChatFromHistory / popstate.
function _syncChatPagePauseUIForChat(chatId) {
    if (!chatId || typeof currentChatId === 'undefined' || chatId !== currentChatId) return;
    if (typeof syncPauseButtonUI === 'function') syncPauseButtonUI(chatId);
}

async function _reloadActionFromDB(actionId) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([actionStateStoreName], 'readonly');
        var req = tx.objectStore(actionStateStoreName).get(actionId);
        await new Promise(function(resolve) {
            req.onsuccess = function() {
                if (req.result) activeActions[actionId] = req.result;
                else delete activeActions[actionId];
                resolve();
            };
            req.onerror = function() { resolve(); };
        });
        notifyActionStateChanged(actionId);
    } catch (e) {}
}

if (_actionsBC) {
    _actionsBC.onmessage = function(ev) {
        var msg = ev.data || {};
        if (!msg.actionId && msg.type !== 'pauseChat' && msg.type !== 'resumeChat') return;
        switch (msg.type) {
            case 'update':
                // Another tab persisted a state change — re-hydrate just that record
                _reloadActionFromDB(msg.actionId);
                break;
            case 'delete':
                var existing = activeActions[msg.actionId];
                if (existing && existing.chatId) {
                    var deletedChatId = existing.chatId;
                    pausedChats[deletedChatId] = true;
                    // Halt any in-flight loop on this chat — then drop the flag so
                    // pausedChats doesn't grow forever as actions are dismissed.
                    setTimeout(function() { delete pausedChats[deletedChatId]; }, 5000);
                    // Mirror dismissAction's reveal so the orphaned background chat
                    // surfaces in this tab's chat list. Without this, the chat is
                    // hidden (isBackground && !_revealed) until the tab reloads.
                    if (chats[deletedChatId] && chats[deletedChatId].isBackground && !chats[deletedChatId]._revealed) {
                        chats[deletedChatId]._revealed = true;
                        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
                    }
                    _syncChatPagePauseUIForChat(deletedChatId);
                }
                delete activeActions[msg.actionId];
                notifyActionStateChanged(msg.actionId);
                break;
            case 'pauseChat':
                // PM paused/stopped from another tab — halt any local agent loop on this chat
                if (msg.chatId) {
                    pausedChats[msg.chatId] = true;
                    // B-A2 (cross-tab): unblock any approval the local loop is parked on,
                    // otherwise the cross-tab pause is silently a no-op for this chat.
                    if (typeof rejectPendingApprovalsForChat === 'function') {
                        rejectPendingApprovalsForChat(msg.chatId);
                    }
                    _syncChatPagePauseUIForChat(msg.chatId);
                }
                break;
            case 'resumeChat':
                if (msg.chatId) {
                    pausedChats[msg.chatId] = false;
                    _syncChatPagePauseUIForChat(msg.chatId);
                }
                break;
        }
    };
}

// (Removed: claimAndResumeAction. Auto-resume on reload was disabled — see
// loadAllActionStates above and the comment around `void toResume`. Resume is
// now an explicit user action via the Resume button on the action popover,
// which calls resumeAction → runAgent.)

// ---------- State change notifications ----------

function onActionStateChange(fn) { actionStateListeners.push(fn); }
function notifyActionStateChanged(actionId) {
    actionStateListeners.forEach(function(fn) { try { fn(actionId); } catch (e) {} });
}

// ---------- Collect actions from active skills ----------

// Returns [{ skillId, skillName, action }] for everything visible on `placement`.
function collectActionsForPlacement(placement) {
    var out = [];
    if (typeof skills !== 'object' || !skills) return out;
    Object.keys(skills).forEach(function(skillId) {
        var skill = skills[skillId];
        if (!skill) return;
        // Active state is tracked in the activeSkills map, not on the skill object
        if (typeof activeSkills === 'object' && !activeSkills[skillId]) return;
        if (!Array.isArray(skill.actions)) return;
        skill.actions.forEach(function(a) {
            if (!a || !a.name) return;
            var showList = Array.isArray(a.show) ? a.show : [a.show];
            if (showList.indexOf(placement) >= 0) {
                out.push({ skillId: skillId, skillName: skill.name || skillId, action: a });
            }
        });
    });
    return out;
}

// ---------- update_action_state tool implementation ----------

async function executeUpdateActionState(args, options) {
    // Resolve the target chat. options.chatId (set by executeTool in the agent loop)
    // is authoritative per-invocation and is the only lookup that behaves correctly
    // under concurrent background actions. Fall back to activeStreamingChatId for
    // legacy callers, then currentChatId so foreground chats can also report progress.
    var chatId = (options && options.chatId) ||
                 activeStreamingChatId ||
                 currentChatId;
    var chat = chatId ? chats[chatId] : null;
    if (!chat) {
        return { success: false, error: 'No active chat to update.' };
    }

    // Normalize args once — used for both the action button (background) and the
    // sidebar timeline (any chat). Timeline reads args directly from chat.tool_calls,
    // so we don't need to persist anything extra here for foreground chats.
    var rawState = args.state;
    var state = rawState || 'running';
    // Accept "success" / "failed" as aliases for done/error (friendlier for agents)
    if (state === 'success') state = 'done';
    if (state === 'failed') state = 'error';
    // Reject off-list states explicitly rather than silently coercing to 'running'.
    // Internal states (idle/paused/needs_input/needs_permission/stopped) are set by
    // user controls (pause button, prompt response, manual stop), not by the tool —
    // an agent passing one of those is a bug we want to surface, not hide.
    if (['running','stuck','done','error'].indexOf(state) < 0) {
        return { success: false, error: 'Invalid state: \'' + rawState + '\'. Must be one of: running, stuck, done, error (aliases: success, failed).' };
    }
    var icon = args.icon || 'spinner';
    // Coerce off-list icons to spinner so the agent can't sneak in icons outside the tool def enum.
    if (ALLOWED_ACTION_ICONS.indexOf(icon) < 0) icon = 'spinner';
    var label = (args.label || '').substring(0, 60);
    // Normalize the task list ONCE — shared by the Action-button branch and the
    // sub-agent mirroring below. Cap the length so a runaway agent can't
    // overflow the popover / tooltip / parent card. Validate each status
    // against the documented enum and fall back to 'pending' for anything
    // off-list — otherwise the CSS selector (.task-row.status-…) silently
    // fails to match and the row renders unstyled.
    var VALID_TASK_STATUSES = ['pending', 'running', 'done', 'error'];
    var normTasks = Array.isArray(args.tasks)
        ? args.tasks.slice(0, 20).map(function(t) {
            var status = t && VALID_TASK_STATUSES.indexOf(t.status) >= 0 ? t.status : 'pending';
            return { label: String((t && t.label) || '').substring(0, 80), status: status };
        })
        : null;

    // Background chat hooked up to an Action button: drive the live button state.
    // Foreground chats just contribute to the sidebar timeline via their tool_calls.
    if (chat.isBackground && chat.actionId) {
        var actionId = chat.actionId;
        var a = activeActions[actionId];
        if (!a) {
            return { success: false, error: 'Active action not found for this chat.' };
        }
        var prevState = a.state;
        a.state = state;
        a.icon = icon;
        a.label = label;
        if (normTasks) a.tasks = normTasks;
        // Accept null as an explicit "clear the output" signal. Without this, an agent
        // sending output:null to clear the result panel would silently leave the previous
        // output sitting there (typeof null === 'object').
        if (typeof args.output === 'string') a.output = args.output.substring(0, 4000);
        else if (args.output === null) a.output = '';
        // auto_dismiss_ms is REMEMBERED on the action so it survives across update calls.
        // Agents commonly set it on an early `running` update and only later transition to `done`.
        if (typeof args.auto_dismiss_ms === 'number') {
            // Clamp to [500ms, 60s]: anything <=0 disables auto-dismiss, anything between
            // 1 and 499 ms would make the button blink done and vanish before it renders.
            a.autoDismissMs = args.auto_dismiss_ms > 0
                ? Math.min(Math.max(args.auto_dismiss_ms, 500), 60000)
                : 0;
        }
        // Cancel any in-flight dismiss timer when:
        //   (a) the action has moved back out of done/error (agent decided to keep working
        //       after a premature `done`) — otherwise the button would silently disappear mid-run; or
        //   (b) the action transitioned between two different terminal states (e.g. done -> error
        //       after a late verification step failed). Without this, the timer would fire on the
        //       original `done` deadline and hide the error before the user notices.
        var nowTerminal = state === 'done' || state === 'error';
        var prevTerminal = prevState === 'done' || prevState === 'error';
        if (a._dismissTimer && (!nowTerminal || (prevTerminal && state !== prevState))) {
            clearTimeout(a._dismissTimer);
            a._dismissTimer = null;
        }
        // Arm the dismiss timer whenever we're in a terminal state with a remembered delay,
        // regardless of whether auto_dismiss_ms was supplied on THIS specific call.
        if ((state === 'done' || state === 'error') && a.autoDismissMs > 0 && !a._dismissTimer) {
            a._dismissTimer = setTimeout(function() { dismissAction(actionId); }, a.autoDismissMs);
        }
        a.updatedAt = Date.now();
        await persistActionState(actionId);
        notifyActionStateChanged(actionId);
        return { success: true };
    }

    // Foreground chat: nothing to mutate in activeActions — the timeline renderer
    // (renderActionUpdatesSection) reads update_action_state calls straight from
    // chat.tool_calls. Trigger a sidebar refresh and a title-bar update so the
    // new state shows up everywhere (inline pill next to chat title is always visible).
    // The sidebar refresh goes through the event bus per architecture-events.md;
    // the page subscriber calls renderVersionSidebar.
    AgentEvents.emit('actionStateChanged', {
        chatId: (options && options.chatId) || activeStreamingChatId || currentChatId,
        actionId: null,
        status: args && args.state || null
    });
    // Pass the in-flight tool_call_id so the pill renderer counts THIS update
    // as completed even though its role:'tool' result row hasn't been pushed
    // yet (the agent loop pushes that row only after this function returns).
    var _inFlightToolCallId = options && options.toolCallId;
    if (typeof updateChatTitleHeader === 'function') {
        try { updateChatTitleHeader(_inFlightToolCallId); } catch (e) {}
    }
    // Keep the chat-progress popover (opened via the title state pill) in sync
    // when the agent posts a new update_action_state call. Without this, the
    // popover would freeze on the snapshot it had at click-time.
    try { _refreshOpenChatProgressPopover(_inFlightToolCallId); } catch (e) {}
    // Sub-agent chat: mirror this progress card onto the parent chat's live
    // sub_report card + the registry record. This tool executes on the PAGE
    // (non-headless), where the chats / SubAgents globals are read-only
    // mirrors of the SW's authoritative state — so attach the normalized
    // snapshot to the RESULT and let the SW tool-routing layer
    // (worker/120-tool-routing.js) persist it via SubAgents.recordActionState.
    // That repaints the parent transcript (tasks checklist on the sub_report
    // card) and exposes the card to the parent agent via agent_status.
    // `tasks: null` means "not provided, keep previous"; output uses an
    // explicit clearOutput marker for the output:null "clear" signal so the
    // merge in recordSubActionState can tell clear apart from absent.
    var _uasResult = { success: true };
    if (chat.isSubAgent) {
        _uasResult._sub_action_state = {
            state: state,
            icon: icon,
            label: label,
            tasks: normTasks,
            output: (typeof args.output === 'string') ? args.output.substring(0, 4000) : null,
            clearOutput: args.output === null,
            at: Date.now()
        };
    }
    return _uasResult;
}

// show_action_button tool — embed an action button inline in the current chat
function executeShowActionButton(args, messageIndex, options) {
    args = args || {};
    var skillId = args.skill;
    var actionName = args.action;
    if (!skillId || !actionName) return { success: false, error: 'Both skill and action are required.' };
    var skill = skills[skillId];
    if (!skill) return { success: false, error: 'Skill not found: ' + skillId };
    var action = (skill.actions || []).filter(function(a){ return a.name === actionName; })[0];
    if (!action) return { success: false, error: 'Action not found on skill: ' + actionName };
    var chatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
    var chat = chats[chatId];
    if (!chat) return { success: false, error: 'No active chat' };
    // Push a special message that renders as an inline action button
    var actionBtnMsg = {
        role: 'action_button',
        skillId: skillId,
        actionName: actionName,
        label: args.label || actionName,
        context: args.context || '',
        createdAt: Date.now()
    };
    chat.messages.push(actionBtnMsg);
    saveChatsToStorage();
    if (currentChatId === chatId && currentView === 'chat') {
        renderMessages();
        scrollToBottomIfAllowed();
    }
    // Mirror to SW so the next agent-event snapshot doesn't wipe the button
    // message from chat.messages. tool-routing.js splices it before the
    // tool_result slot for this toolCallId.
    return { success: true, _message_persist: actionBtnMsg };
}

// ---------- Lifecycle: start / stop / finish / dismiss ----------

// Start a fresh action run. Called when PM clicks an idle button.
// `extraContext` (optional): extra text the agent should see — used by show_action_button
// to pass context from the source chat to the background action chat.
async function startAction(skillId, actionName, extraContext) {
    var skill = skills[skillId];
    if (!skill) return;
    var action = (skill.actions || []).filter(function(a){ return a.name === actionName; })[0];
    if (!action) return;

    var actionId = getActionId(skillId, actionName);
    // If there's already a live run, just surface it — don't start a second.
    var existing = activeActions[actionId];
    if (existing && (existing.state === 'running' || existing.state === 'stuck' || existing.state === 'needs_input' || existing.state === 'needs_permission')) {
        notifyActionStateChanged(actionId);
        return;
    }
    // If there's a completed-but-not-dismissed action, clear it first so the new run can start
    if (existing) {
        await dismissAction(actionId);
    }

    // Create the background chat
    var sourceChatId = currentChatId;
    var bgChatId = 'chat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    chats[bgChatId] = {
        id: bgChatId,
        title: (skill.name || skillId) + ' — ' + actionName,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isBackground: true,
        sourceChatId: sourceChatId || null,
        actionId: actionId,
        skillId: skillId,
        actionName: actionName
    };

    // Record the active action
    activeActions[actionId] = {
        actionId: actionId,
        skillId: skillId,
        skillName: skill.name || skillId,
        actionName: actionName,
        originalIcon: action.icon || 'play',
        originalLabel: actionName,
        chatId: bgChatId,
        sourceChatId: sourceChatId || null,
        state: 'running',
        icon: 'spinner',
        label: 'Starting…',
        tasks: [],
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    await persistActionState(actionId);

    // Inject a synthetic user message so the agent knows what to run
    var userMsg = 'Run action: **' + actionName + '**\n\n' +
        'This is a background Action from the skill "' + (skill.name || skillId) + '". ' +
        'Look up the "Action Lifecycle: ' + actionName + '" section in the skill body and execute it. ' +
        'The PM never sees this chat — they only see the action button. You MUST call `update_action_state` frequently (running/stuck/done/error) with a `tasks` todo list and a final `output` summary so they can track progress and see the result.';
    if (extraContext && typeof extraContext === 'string') {
        userMsg += '\n\n**Context from the caller:**\n' + extraContext;
    }
    chats[bgChatId].messages.push({ role: 'user', content: userMsg });
    saveChatsToStorage();

    notifyActionStateChanged(actionId);

    // Start the agent loop on the background chat
    runAgent(bgChatId);
}

// Pause / resume an action's background chat without dropping its state.
async function pauseAction(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    pausedChats[a.chatId] = true;
    // B9: the agent loop now runs in the service worker, which reads its OWN
    // pausedChats copy — setting only the page copy never halts it. Mirror the
    // pause + interrupt into the SW (as togglePause does) so Pause actually stops
    // the background loop instead of letting it stream to completion.
    if (typeof pushPauseToggleToOffscreen === 'function') pushPauseToggleToOffscreen(a.chatId, true);
    if (typeof pushInterruptToOffscreen === 'function') pushInterruptToOffscreen(a.chatId, false);
    a._isPaused = true;
    a.updatedAt = Date.now();
    await persistActionState(actionId);
    broadcastActionChange('pauseChat', actionId, a.chatId);
    // B-C1: re-hydrate other tabs so they see _isPaused/updatedAt.
    broadcastActionChange('update', actionId, a.chatId);
    // B-A2: unblock any approval the loop is parked on, otherwise pause is a no-op.
    if (typeof rejectPendingApprovalsForChat === 'function') {
        rejectPendingApprovalsForChat(a.chatId);
    }
    notifyActionStateChanged(actionId);
    // If the user is viewing this background chat, flip the chat-page Pause
    // button label to "Resume" — otherwise the label lags until the next
    // navigation into the chat re-syncs it.
    _syncChatPagePauseUIForChat(a.chatId);
}
async function resumeAction(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    pausedChats[a.chatId] = false;
    a._isPaused = false;
    a.reloadInterrupted = false;
    a.updatedAt = Date.now();
    await persistActionState(actionId);
    broadcastActionChange('resumeChat', actionId, a.chatId);
    // B-C1: re-hydrate other tabs.
    broadcastActionChange('update', actionId, a.chatId);
    notifyActionStateChanged(actionId);
    _syncChatPagePauseUIForChat(a.chatId);
    // SWM14-F2: clear the SW-side pause copy too, mirroring togglePause
    // (020-api-messages.js:200-202). resumeAction only cleared the page's
    // pausedChats; the SW keeps its own copy (set on pause via
    // pushPauseToggleToOffscreen). Because the page runAgent early-returns while
    // runningChatIds is set, a still-running SW loop would never get un-paused —
    // its `while (!isChatPaused)` gate stays tripped. Push the cleared flag BEFORE
    // the runAgent re-kick so the loop resumes whether or not it re-enters here.
    if (typeof pushPauseToggleToOffscreen === 'function') pushPauseToggleToOffscreen(a.chatId, false);
    // SWM-T5: bump the interrupt generation too, so a stale interrupt(false) retry
    // chain armed during a port-down window can't survive resume and abort the run.
    if (typeof _supersedeInterruptToggle === 'function') _supersedeInterruptToggle(a.chatId);
    // Re-kick the agent loop if it's not already running in THIS tab. Other
    // tabs were unpaused via the broadcast above; if any of them was already
    // running the loop, it just resumes there. Tabs that weren't running rely
    // on the user clicking Resume in their own tab to re-kick locally.
    if (!runningChatIds[a.chatId]) runAgent(a.chatId);
}

// Stop a running action (PM clicks Stop). The streaming turn in flight finishes,
// then the loop halts at its next pause check.
async function stopAction(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    // Cancel any in-flight auto-dismiss timer — the user explicitly stopped this
    // action and expects the button to remain visible until they dismiss it.
    if (a._dismissTimer) { clearTimeout(a._dismissTimer); a._dismissTimer = null; }
    // Soft-stop: signal the loop to pause on next check (locally + in any other tab)
    pausedChats[a.chatId] = true;
    // B9: mirror the stop into the service-worker loop (which reads the SW's own
    // pausedChats). Without this the PM sees "Stopped" while the SW keeps streaming
    // and executing tools (ServiceNow writes, sub-agent spawns) to completion — the
    // "loop halts at its next pause check" comment above was false post-SW-move.
    if (typeof pushPauseToggleToOffscreen === 'function') pushPauseToggleToOffscreen(a.chatId, true);
    if (typeof pushInterruptToOffscreen === 'function') pushInterruptToOffscreen(a.chatId, false);
    a.state = 'stopped';
    a.icon = 'stop';
    a.label = 'Stopped';
    a._isPaused = false;
    a.updatedAt = Date.now();
    await persistActionState(actionId);
    broadcastActionChange('pauseChat', actionId, a.chatId);
    // B-C1: also broadcast `update` so other tabs re-hydrate the action's state
    // from IDB. Without this, the receiver only sets pausedChats[chatId]=true but
    // its local activeActions[id].state stays painted as 'running'.
    broadcastActionChange('update', actionId, a.chatId);
    // B-A2: unblock any approval the loop is parked on.
    if (typeof rejectPendingApprovalsForChat === 'function') {
        rejectPendingApprovalsForChat(a.chatId);
    }
    notifyActionStateChanged(actionId);
    _syncChatPagePauseUIForChat(a.chatId);
}

// Dismiss an action (reset to idle). Also halts any still-running loop so a
// blocked/stuck agent doesn't linger in memory waiting on a promise nobody
// will resolve.
async function dismissAction(actionId) {
    var a = activeActions[actionId];
    // B-C2: capture chatId before the local delete so we can broadcast it.
    // Previously this function never broadcast at all — the receiver's `case 'delete'`
    // arm was reachable only via a sender that didn't exist. Other tabs now drop
    // their stale activeActions entry and halt their local loop.
    var bcChatId = a && a.chatId ? a.chatId : null;
    if (a) {
        if (a._dismissTimer) { clearTimeout(a._dismissTimer); a._dismissTimer = null; }
        // Signal the agent loop to halt at its next pause check, then drop the flag
        // so pausedChats doesn't accumulate one stale entry per dismissed action.
        if (a.chatId) {
            var dchat = a.chatId;
            pausedChats[dchat] = true;
            // B9: also halt the SW-side loop (its own pausedChats copy) + abort any
            // in-flight stream/tool, else a dismissed action's background loop keeps
            // running in the service worker after the button is gone.
            if (typeof pushPauseToggleToOffscreen === 'function') pushPauseToggleToOffscreen(dchat, true);
            if (typeof pushInterruptToOffscreen === 'function') pushInterruptToOffscreen(dchat, false);
            // SWM-F5: capture the pause-toggle generation we just issued (pushPauseToggleToOffscreen
            // bumps _pauseToggleGen[chatId] synchronously on a fresh call). The 5s deferred clear
            // below must NO-OP if a NEWER pause/resume toggle for this chatId is issued in the
            // meantime — otherwise, when the chatId is reused and legitimately RE-PAUSED during
            // that window, our stale deferred resume would clobber it (resume a chat the user just
            // paused). Reuses the same latest-wins generation mechanism as the toggle retry chains.
            var _dismissPauseGen = (typeof _pauseToggleGen !== 'undefined' && _pauseToggleGen) ? _pauseToggleGen[dchat] : undefined;
            setTimeout(function() {
                // Superseded by a newer pause/resume toggle for this chatId — leave its state alone.
                if (typeof _pauseToggleGen !== 'undefined' && _pauseToggleGen && _pauseToggleGen[dchat] !== _dismissPauseGen) return;
                delete pausedChats[dchat];
                // SWM14-F3: also clear the SW-side pause copy. The push above set
                // pausedChats[dchat]=true in the SW too; the page-only delete here
                // never reaches the SW, so without this the SW keeps a stale pause
                // flag for this chatId forever and a later reuse of the same chatId
                // would start up paused.
                if (typeof pushPauseToggleToOffscreen === 'function') pushPauseToggleToOffscreen(dchat, false);
            }, 5000);
            _syncChatPagePauseUIForChat(dchat);
            // Reveal the chat in the sidebar before dismissing the action.
            // Otherwise the chat becomes orphaned: the action is gone (so it's no
            // longer in the jobs dropdown) and isBackground && !_revealed hides it
            // from the chat list, leaving no UI path to reach the transcript.
            // This matters most for auto-dismiss (autoDismissMs) where the PM may
            // never have clicked the action button.
            if (chats[dchat] && chats[dchat].isBackground && !chats[dchat]._revealed) {
                chats[dchat]._revealed = true;
                if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
            }
        }
    }
    delete activeActions[actionId];
    await deleteActionStateFromDB(actionId);
    // B-C2: broadcast deletion so other tabs converge.
    broadcastActionChange('delete', actionId, bcChatId);
    notifyActionStateChanged(actionId);
}

// Called by agent-loop when the background chat finishes its turn normally.
async function finishActionIfDone(chatId) {
    var chat = chats[chatId];
    if (!chat || !chat.isBackground || !chat.actionId) return;
    var a = activeActions[chat.actionId];
    if (!a) return;
    // Only auto-finalize if the agent didn't explicitly set done/error AND the
    // action isn't paused. SWM14-F1: pausing a running background Action exits the
    // SW loop via finish-cleanup → runFinished{paused}; the page runFinished
    // handler (036-agent-event-handlers-page.js:252) and agent-loop.js:1015 both
    // call finishActionIfDone unconditionally, which would otherwise flip the
    // just-paused action to 'Complete' and destroy resumability. Guard INSIDE
    // finishActionIfDone so every caller (page handler + loop) is covered.
    if (a.state === 'running' && !a._isPaused && !(typeof isChatPaused === 'function' && isChatPaused(a.chatId))) {
        a.state = 'done';
        a.icon = 'check';
        if (!a.label || a.label === 'Starting…') a.label = 'Complete';
        a.updatedAt = Date.now();
        await persistActionState(chat.actionId);
        notifyActionStateChanged(chat.actionId);
    }
}

// ---------- Button rendering helpers ----------

// Return the icon+label currently shown on the button for this action.
function getButtonDisplay(skillId, action) {
    var actionId = getActionId(skillId, action.name);
    var a = activeActions[actionId];
    if (!a) return { state: 'idle', icon: action.icon || 'play', label: action.name, tasks: [] };
    return {
        state: a.state,
        icon: a.icon || action.icon || 'spinner',
        label: a.label || action.name,
        tasks: a.tasks || [],
        startedAt: a.startedAt,
        actionId: actionId
    };
}

// Render a single action button.
// Design: primary icon (action's own icon) + label + status badge (state indicator).
// The status badge is a small circle containing a state-specific mini-icon. It's always
// present, but styled differently per state (idle = just the action icon, no badge).
function renderActionButton(skillId, skillName, action, extraClass) {
    var d = getButtonDisplay(skillId, action);
    var primaryIcon = UI_ICONS[action.icon || 'play'] || UI_ICONS.play;
    var stateClass = 'action-btn state-' + d.state;
    var extra = extraClass ? ' ' + extraClass : '';
    var interrupted = d.state === 'running' && activeActions[d.actionId] && activeActions[d.actionId].reloadInterrupted ? ' reload-interrupted' : '';
    var paused = activeActions[d.actionId] && activeActions[d.actionId]._isPaused ? ' is-paused' : '';
    var cls = stateClass + extra + interrupted + paused;
    var dataAttrs =
        'data-skill-id="' + escapeHtml(skillId) + '" ' +
        'data-action-name="' + escapeHtml(action.name) + '"';
    var badgeIcon = getStateBadgeIcon(d.state, paused ? 'is-paused' : '');
    var badgeHtml = badgeIcon ?
        '<span class="action-btn-badge" aria-hidden="true">' + badgeIcon + '</span>' : '';
    var label = d.state === 'idle' ? action.name : (d.label || action.name);
    // Native title → always shows the action name on hover, even when the
    // button collapses to icon-only mode in the responsive header. The richer
    // tooltip popover (label + tasks) still wins for non-idle states because
    // it shows up programmatically and we don't override the title there.
    var titleAttr = escapeHtml(action.name) + ' — ' + escapeHtml(skillName);
    return '<button type="button" class="action-btn ' + cls + '" ' + dataAttrs + ' ' +
        'title="' + titleAttr + '" ' +
        'onclick="onActionButtonClick(this)" ' +
        'onmouseenter="onActionButtonHover(this)" ' +
        'onmouseleave="onActionButtonLeave(this)" ' +
        'aria-label="' + escapeHtml(action.name) + ' — ' + escapeHtml(skillName) + ' (' + escapeHtml(d.state) + ')">' +
        '<span class="action-btn-primary" aria-hidden="true">' + primaryIcon + '</span>' +
        '<span class="action-btn-label">' + escapeHtml(label) + '</span>' +
        badgeHtml +
        '</button>';
}

// Map state → the mini-icon shown in the status badge (the "fancy" secondary icon)
function getStateBadgeIcon(state, extraFlag) {
    if (state === 'idle') return ''; // no badge when idle
    if (extraFlag === 'is-paused') return UI_ICONS.pause;
    switch (state) {
        case 'running': return UI_ICONS.spinner;
        case 'stuck': return UI_ICONS.alert;
        case 'needs_input': return UI_ICONS.bell;
        case 'needs_permission': return UI_ICONS.lock;
        case 'done': return UI_ICONS.check;
        case 'error': return UI_ICONS.close;
        case 'stopped': return UI_ICONS.stop;
        default: return UI_ICONS.play;
    }
}

// Collect + render buttons for a placement. Used by home/chat/sidebar.
// NOTE: 'header' is no longer a valid configurable placement — the top bar
// is reserved for *live* (running / not-yet-dismissed) actions and is
// rendered by `renderLiveActionPills` below, driven from `activeActions`.
function renderActionsForPlacement(placement, extraClass) {
    var entries = collectActionsForPlacement(placement);
    if (!entries.length) return '';
    return entries.map(function(e) {
        return renderActionButton(e.skillId, e.skillName, e.action, extraClass);
    }).join('');
}

// =============================================
// LIVE ACTION PILLS (header + home)
// =============================================
// Renders every entry in `activeActions` (running / stuck / needs_input /
// needs_permission / done-but-not-yet-dismissed / error / stopped) as a pill.
// The same HTML is mirrored into both #header-actions (the top bar) and
// #home-header-actions (in the home view's header) so the user can
// follow live actions from anywhere.
//
// `_isOrphanActiveAction(a)` is the single source of truth for "is this
// activeActions entry actually renderable?" — used by the pill renderer
// AND by the jobs-badge counters so they agree about what's visible. An
// entry is orphaned when its skill or action name no longer exists in
// `skills` (e.g. user uninstalled the skill while a stale IDB record kept
// the live entry around). Pre-fix, the renderer skipped orphans but the
// badge counted them, producing "badge says 1, header empty" mismatches.
function _isOrphanActiveAction(a) {
    if (!a || !a.skillId || !a.actionName) return true;
    var skill = (typeof skills === 'object' && skills) ? skills[a.skillId] : null;
    if (!skill) return true;
    var action = (skill.actions || []).filter(function(x){ return x.name === a.actionName; })[0];
    return !action;
}

function renderLiveActionPillsHtml(extraClass) {
    var list = getActiveActionsList();
    if (!list.length) return '';
    var parts = [];
    list.forEach(function(a) {
        if (!a || !a.skillId || !a.actionName) return;
        var skill = (typeof skills === 'object' && skills) ? skills[a.skillId] : null;
        if (!skill) return;
        var action = (skill.actions || []).filter(function(x){ return x.name === a.actionName; })[0];
        if (!action) return;
        parts.push(renderActionButton(a.skillId, skill.name || a.skillId, action, extraClass || 'placement-live'));
    });
    return parts.join('');
}

function renderLiveActionPills() {
    // Both the chat header and the home (new chat) header get the same pills,
    // tagged with `placement-header` so existing header CSS (icon-only mode,
    // responsive collapse, More dropdown) applies unchanged.
    var hh = renderLiveActionPillsHtml('placement-header');
    // Sub-agent chats: suppress the global live-pill row in the chat header.
    // The pills are top-level / parent-agent state — e.g. "Security scan
    // complete", "222 defects found" — and showing them in a sub-agent's
    // view alongside the "Sub-agent | sleeping | ↳ parent" banner reads as
    // "the main agent and the sub-agent are mashed together" (the
    // user-reported "main agent thing showing subagent thing" screenshot).
    // The jobs-badge dropdown stays available globally, so notifications
    // are not lost. The home view's pill row is unaffected — home is by
    // definition not inside a sub-agent.
    var _curChat = (typeof currentChatId !== 'undefined' && typeof chats !== 'undefined')
        ? chats[currentChatId] : null;
    var _suppressForSub = !!(_curChat && _curChat.isSubAgent);
    var headerHtml = _suppressForSub ? '' : hh;
    var header = document.getElementById('header-actions');
    if (header) {
        header.innerHTML = headerHtml;
        header.style.display = headerHtml ? '' : 'none';
        if (typeof applyHeaderActionsResponsive === 'function') applyHeaderActionsResponsive();
    }
    var homeHeader = document.getElementById('home-header-actions');
    if (homeHeader) {
        homeHeader.innerHTML = hh;
        homeHeader.style.display = hh ? '' : 'none';
        // The home header lives inside `.home-header` (NOT `.main-header`), so
        // applyHeaderActionsResponsive doesn't reach it. Apply the lighter
        // icon-only collapse directly when the home header would overflow.
        // We don't re-implement the full "More" stash here — just label-hide.
        applyHomeHeaderActionsResponsive();
    }
}

// Toggle `icons-only` on `#home-header-actions` based on whether the parent
// `.home-header` would overflow horizontally. The `.icons-only` CSS at
// `23-actions.css:979,982,989` already handles the visual side — it hides
// `.action-btn-label` and shrinks the button to a circle. We just need to
// decide when to add/remove the class. Called from renderLiveActionPills() and
// on window resize (debounced via requestAnimationFrame).
function applyHomeHeaderActionsResponsive() {
    var actions = document.getElementById('home-header-actions');
    if (!actions) return;
    var homeHeader = actions.closest('.home-header');
    if (!homeHeader) return;
    // Reset to label-mode first so we measure honestly. If the row was already
    // icons-only and STILL fits, we want to drop back to labels.
    actions.classList.remove('icons-only');
    if (homeHeader.scrollWidth > homeHeader.clientWidth + 1) {
        actions.classList.add('icons-only');
    }
}

var _homeHeaderResponsiveScheduled = false;
function _scheduleHomeHeaderResponsive() {
    if (_homeHeaderResponsiveScheduled) return;
    _homeHeaderResponsiveScheduled = true;
    requestAnimationFrame(function() {
        _homeHeaderResponsiveScheduled = false;
        applyHomeHeaderActionsResponsive();
    });
}
window.addEventListener('resize', _scheduleHomeHeaderResponsive);

// Render an inline action button message (show_action_button tool result).
// Wraps the standard button in a subtle message row, with the optional context
// shown as a caption.
function renderInlineActionButton(msg, index) {
    var skill = skills[msg.skillId];
    if (!skill) {
        return '<div class="message inline-action-button-err" id="msg-' + index + '">Unknown skill: ' + escapeHtml(msg.skillId || '') + '</div>';
    }
    var action = (skill.actions || []).filter(function(a){ return a.name === msg.actionName; })[0];
    if (!action) {
        // The action no longer exists on this skill — render an explicit error
        // row instead of a fake live button. Previously we fabricated a stub
        // {name, icon:'play', show:[]} which looked clickable but did nothing
        // because startAction filters by name and silently returns.
        return '<div class="message inline-action-button-err" id="msg-' + index + '">' +
            'Unknown action "' + escapeHtml(msg.actionName || '') + '" on skill "' + escapeHtml(skill.name || msg.skillId) + '"' +
        '</div>';
    }
    var buttonHtml = renderActionButton(msg.skillId, skill.name || msg.skillId, action, 'placement-inline');
    // Inline buttons need context passed on click. Patch onclick to carry the extra context.
    buttonHtml = buttonHtml.replace('onclick="onActionButtonClick(this)"',
        'onclick="onInlineActionButtonClick(this, \'' + escapeJsString(index) + '\')" data-msg-index="' + escapeHtml(index) + '"');
    // Truncate FIRST, then escape — reversing the order would chop a multi-char HTML
    // entity (e.g. &amp;) and leave broken text in the DOM.
    var caption = msg.context ?
        '<div class="inline-action-context">' + escapeHtml(String(msg.context).substring(0, 200)) + '</div>' : '';
    return '<div class="message inline-action-button" id="msg-' + index + '">' +
        '<div class="inline-action-wrap">' + buttonHtml + caption + '</div>' +
    '</div>';
}

// =============================================
// ACTION UPDATES PANEL (right sidebar)
// =============================================
// Scans the assistant messages that follow `userMsgIdx` (up to the next user message)
// and collects every `update_action_state` tool call. Renders a compact timeline that
// appears in the chat artifacts area, so the PM sees the state history when they reveal
// a background Action chat — or just track state changes in a normal chat.
function renderActionUpdatesSection(chat) {
    var updates = collectAllActionUpdates(chat);
    if (!updates.length) return '';

    // Render the LATEST update as a single in-place card (state badge, label,
    // tasks, output). Previous updates collapse into a compact history trail
    // below — same idea as Claude Code's todo tool: one mutating card, not a
    // log of historical snapshots.
    var current = updates[updates.length - 1];
    var history = updates.slice(0, -1);
    var lastState = current.state || 'running';

    var stateLabel = lastState.toUpperCase();
    var stateIcon = (function(s) {
        if (s === 'done') return UI_ICONS.check;
        if (s === 'error') return UI_ICONS.close;
        if (s === 'stuck') return UI_ICONS.alert;
        return UI_ICONS.spinner;
    })(lastState);

    var tasksHtml = '';
    if (Array.isArray(current.tasks) && current.tasks.length) {
        tasksHtml = '<ul class="action-update-tasks">' +
            current.tasks.map(function(t) {
                var taskIcon = t.status === 'done' ? UI_ICONS.check :
                               t.status === 'error' ? UI_ICONS.close :
                               t.status === 'running' ? UI_ICONS.spinner :
                               UI_ICONS.clock;
                return '<li class="action-update-task status-' + escapeHtml(t.status || 'pending') + '">' +
                    '<span class="action-update-task-icon">' + taskIcon + '</span>' +
                    '<span class="action-update-task-label">' + escapeHtml(t.label || '') + '</span>' +
                    '</li>';
            }).join('') +
            '</ul>';
    }

    var statusMsgHtml = current.status_message ?
        '<div class="action-update-statusmsg">' + escapeHtml(current.status_message) + '</div>' : '';

    var outputHtml = '';
    if (current.output && (lastState === 'done' || lastState === 'error')) {
        var normalized = String(current.output).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        var rendered = (typeof formatContent === 'function') ? formatContent(normalized) : escapeHtml(normalized);
        outputHtml = '<div class="action-update-output markdown-body">' + rendered + '</div>';
    }

    // History trail: previous updates rendered as one-liners (status_message + state).
    // Only show distinct status_messages so we don't repeat 5 "running" lines that all said the same thing.
    var historyHtml = '';
    if (history.length) {
        var seen = {};
        var trail = [];
        history.forEach(function(u) {
            var key = (u.status_message || u.label || '') + '|' + (u.state || '');
            if (seen[key]) return;
            seen[key] = true;
            trail.push(u);
        });
        if (trail.length) {
            historyHtml = '<details class="action-update-history">' +
                '<summary class="action-update-history-summary">' +
                    '<span class="action-update-history-toggle">▸</span>' +
                    'Previous steps <span class="action-update-history-count">(' + trail.length + ')</span>' +
                '</summary>' +
                '<ol class="action-update-history-list">' +
                trail.map(function(u) {
                    var s = u.state || 'running';
                    return '<li class="action-update-history-item state-' + escapeHtml(s) + '">' +
                        '<span class="action-update-history-dot" aria-hidden="true"></span>' +
                        '<span class="action-update-history-label">' +
                            escapeHtml(u.status_message || u.label || '') +
                        '</span>' +
                        '<span class="action-update-history-state">' + escapeHtml(s) + '</span>' +
                    '</li>';
                }).join('') +
                '</ol>' +
            '</details>';
        }
    }

    var html = '<div class="action-updates sidebar-card state-' + escapeHtml(lastState) + '" data-last-state="' + escapeHtml(lastState) + '">';
    html += '<div class="action-updates-header">' +
        '<span class="action-updates-icon">' + UI_ICONS.zap + '</span>' +
        '<span class="action-updates-title">Progress</span>' +
        '<span class="action-updates-state-badge state-' + escapeHtml(lastState) + '">' +
            '<span class="action-updates-state-icon" aria-hidden="true">' + stateIcon + '</span>' +
            escapeHtml(stateLabel) +
        '</span>' +
        '</div>';
    html += '<div class="action-update current">' +
        '<div class="action-update-body">' +
            (current.label ? '<div class="action-update-label-row">' + escapeHtml(current.label) + '</div>' : '') +
            statusMsgHtml +
            tasksHtml +
            outputHtml +
        '</div>' +
    '</div>';
    html += historyHtml;
    html += '</div>';
    return html;
}

// Get the latest progress state for the current chat (or null if no updates).
// Used by updateChatTitleHeader to render an inline state pill next to the title.
//
// `includeToolCallId` (optional): treat this tool_call_id as completed even if
// no role:'tool' result has been pushed yet. Required when called synchronously
// from inside executeUpdateActionState — the agent loop only pushes the result
// row AFTER the tool returns, so without this hint the pill would skip the
// just-issued state on the very call that triggered the refresh.
function getCurrentChatProgressState(includeToolCallId) {
    return getChatProgressStateFor(currentChatId, includeToolCallId);
}

// Per-chat variant: latest executed update_action_state of ANY chat (used by
// the Active Chats dropdown rows + their progress popovers, which must not
// depend on which chat is currently focused).
function getChatProgressStateFor(chatId, includeToolCallId) {
    var chat = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!chat) return null;
    var updates = collectAllActionUpdates(chat, includeToolCallId);
    if (!updates.length) return null;
    return updates[updates.length - 1];
}

// Walk the messages and collect the arguments of every update_action_state tool
// call that has actually executed. Returns an array of
// {state, icon, label, tasks, output, status_message} in chronological order.
//
// IMPORTANT: a tool_call only counts as "executed" once a matching role:'tool'
// result row exists later in the chat (the agent loop pushes that row at
// `56-agent-loop.js:691, 403`). Without this guard, the pill would jump to the
// FINAL state of any multi-call batch on the first iteration, because the
// streaming step at `:513` writes the entire tool_calls array to chat.messages
// in one shot — well before any of them runs. `includeToolCallId` is the in-
// flight call (the one currently executing) which is treated as synthetically
// completed so its own state IS visible to the pill.
function collectAllActionUpdates(chat, includeToolCallId) {
    var out = [];
    if (!chat || !Array.isArray(chat.messages)) return out;

    // Pre-scan: collect every tool_call_id that has produced a result row.
    var completed = {};
    for (var i = 0; i < chat.messages.length; i++) {
        var m = chat.messages[i];
        if (m && m.role === 'tool' && m.tool_call_id) completed[m.tool_call_id] = true;
    }
    if (includeToolCallId) completed[includeToolCallId] = true;

    for (var i = 0; i < chat.messages.length; i++) {
        var m = chat.messages[i];
        if (!m || !Array.isArray(m.tool_calls)) continue;
        m.tool_calls.forEach(function(tc) {
            if (!tc || !tc.function || tc.function.name !== 'update_action_state') return;
            // Skip tool_calls that haven't executed yet. tc.id may be missing on
            // very old chats (pre-tool_call_id era) — fall back to legacy behavior
            // by including them, which is no worse than what we did before this fix.
            if (tc.id && !completed[tc.id]) return;
            var args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* partial/streaming JSON — skip */ return; }
            out.push({
                state: args.state,
                icon: args.icon,
                label: args.label,
                tasks: args.tasks,
                output: args.output,
                status_message: args.status_message
            });
        });
    }
    return out;
}

// =============================================
// CHAT TITLE STATE PILL — click handler + popover
// =============================================
// The small pill rendered next to the chat title (see updateChatTitleHeader)
// shows the current chat's progress state. Clicking it should surface the
// same details users see when clicking an action button: tasks, label,
// status_message, and (on done/error) the output.
//
// Routing:
//   1. If the current chat is a background-action chat (an entry in
//      `activeActions` has chatId === currentChatId), route to the standard
//      action popover (running / result / approval / prompt) anchored at the
//      pill. This gives the user Pause / Stop / Resume / View chat controls
//      that an action chat already supports.
//   2. Otherwise, render a lightweight "chat progress" popover built directly
//      from the latest update_action_state call in the chat (same source
//      `getCurrentChatProgressState` already uses to render the pill).
function _findActionIdForCurrentChat() {
    if (!currentChatId || typeof activeActions !== 'object') return null;
    for (var id in activeActions) {
        var a = activeActions[id];
        if (a && a.chatId === currentChatId) return id;
    }
    return null;
}

function onChatTitleStatePillClick(pillEl, e) {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    if (!pillEl) return;
    // If a popover is already open for THIS pill (chat-progress) or the matching
    // action, treat the second click as a dismiss — same UX as the action btn.
    if (_resultPopover) {
        var t = _resultPopover.dataset.popoverType;
        if (t === 'chat-progress' && _resultPopover.dataset.chatId === currentChatId) {
            closeResultPopover(); return;
        }
    }
    // Action chat: route to the live action popover (full controls).
    var actionId = _findActionIdForCurrentChat();
    if (actionId && activeActions[actionId]) {
        var a = activeActions[actionId];
        switch (a.state) {
            case 'running':
                openRunningPopover(pillEl, actionId); return;
            case 'stuck':
            case 'done':
            case 'error':
            case 'stopped':
                openResultPopover(pillEl, actionId); return;
            case 'needs_input':
                if (typeof openPendingPromptForAction === 'function') openPendingPromptForAction(actionId);
                return;
            case 'needs_permission':
                if (typeof openPendingApprovalForActionInline === 'function') openPendingApprovalForActionInline(pillEl, actionId);
                return;
        }
    }
    // Foreground / non-action chat: build a popover from the chat's progress.
    openChatProgressPopover(pillEl);
}

// Renders the latest update_action_state call as a popover anchored at `anchor`.
// Reuses the .action-result-popover styling so it visually matches the action
// button popover. State is whatever the agent passed (running/stuck/done/error).
//
// `includeToolCallId` (optional): forwarded to getCurrentChatProgressState so
// an in-flight tool call (whose result row hasn't been pushed yet) still shows
// up in the popover — keeps the popover in sync when refreshed from inside
// executeUpdateActionState.
// `chatId` (optional): show the progress of a specific chat instead of the
// current one — used by the Active Chats dropdown rows.
function openChatProgressPopover(anchor, includeToolCallId, chatId) {
    var _popChatId = chatId || currentChatId;
    var current = (typeof getChatProgressStateFor === 'function') ? getChatProgressStateFor(_popChatId, includeToolCallId) : null;
    if (!current) return;
    var anchorRect = _captureAnchorRect(anchor);
    closeResultPopover();
    if (typeof _hideTooltip === 'function') _hideTooltip();

    var s = current.state || 'running';
    var iconSvg = (current.icon && UI_ICONS[current.icon]) ||
                  (s === 'done' ? UI_ICONS.check :
                   s === 'error' ? UI_ICONS.close :
                   s === 'stuck' ? UI_ICONS.alert :
                   UI_ICONS.spinner);

    var tasksHtml = '';
    if (Array.isArray(current.tasks) && current.tasks.length) {
        tasksHtml = '<div class="action-result-tasks">' +
            current.tasks.map(function(t) {
                var icn = t.status === 'done' ? UI_ICONS.check :
                          (t.status === 'error' ? UI_ICONS.close :
                          (t.status === 'running' ? UI_ICONS.spinner : UI_ICONS.clock));
                return '<div class="action-task status-' + escapeHtml(t.status || 'pending') + '">' +
                    '<span class="action-task-icon">' + icn + '</span>' +
                    '<span class="action-task-label">' + escapeHtml(t.label || '') + '</span>' +
                    '</div>';
            }).join('') +
        '</div>';
    }

    var outputHtml = '';
    if (current.output && (s === 'done' || s === 'error')) {
        var normalized = String(current.output).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        var rendered = (typeof formatContent === 'function') ? formatContent(normalized) : escapeHtml(normalized);
        outputHtml = '<div class="action-result-output markdown-body">' + rendered + '</div>';
    }

    var nameLine = current.label
        ? '<div class="action-result-name">' + escapeHtml(current.label) + '</div>'
        : '<div class="action-result-name">Progress — ' + escapeHtml(s) + '</div>';
    var statusLine = current.status_message
        ? '<div class="action-result-label">' + escapeHtml(current.status_message) + '</div>'
        : '';

    var el = document.createElement('div');
    el.className = 'action-result-popover state-' + s;
    el.innerHTML =
        '<div class="action-result-header">' +
            '<span class="action-result-icon">' + iconSvg + '</span>' +
            '<div class="action-result-title">' +
                nameLine +
                statusLine +
            '</div>' +
            '<button class="action-result-close" aria-label="Close" onclick="closeResultPopover()">' + UI_ICONS.close + '</button>' +
        '</div>' +
        outputHtml +
        tasksHtml;
    el.dataset.popoverType = 'chat-progress';
    el.dataset.chatId = _popChatId || '';
    document.body.appendChild(el);
    _resultPopover = el;
    _positionPopover(el, anchorRect);
    setTimeout(function() { document.addEventListener('click', _resultPopoverOutside, true); }, 0);
}

// If a chat-progress popover is open for the current chat, rebuild it in
// place when a new update_action_state call comes in. Mirrors the
// _refreshOpenActionPopover behavior so the popover never goes stale.
function _refreshOpenChatProgressPopover(includeToolCallId) {
    if (!_resultPopover) return;
    if (_resultPopover.dataset.popoverType !== 'chat-progress') return;
    if (_resultPopover.dataset.chatId !== currentChatId) return;
    var anchor = document.querySelector('#header-chat-title .chat-title-state-pill');
    if (!anchor) { closeResultPopover(); return; }
    openChatProgressPopover(anchor, includeToolCallId);
}

// Called from selectChat / newChat / deleteChat: a chat-progress popover
// belongs to a specific chatId, so when the user navigates away it must be
// dismissed — otherwise it would hover over the new chat's header showing
// stale data from the previous chat.
function closeChatProgressPopoverIfStale() {
    if (!_resultPopover || !_resultPopover.dataset) return;
    if (_resultPopover.dataset.popoverType !== 'chat-progress') return;
    if (_resultPopover.dataset.chatId === currentChatId) return;
    try { closeResultPopover(); } catch (e) {}
}

// Click handler for inline-in-chat action buttons — passes through the extra context
function onInlineActionButtonClick(btn, msgIndex) {
    var skillId = btn.getAttribute('data-skill-id');
    var actionName = btn.getAttribute('data-action-name');
    if (!skillId || !actionName) return;
    var actionId = getActionId(skillId, actionName);
    var a = activeActions[actionId];
    // If the action already has a live run, route to the normal click logic
    if (a) { onActionButtonClick(btn); return; }
    // Otherwise, start it with the context from the message
    var chat = chats[currentChatId];
    var msg = chat && chat.messages ? chat.messages[parseInt(msgIndex, 10)] : null;
    var context = msg && msg.context ? msg.context : '';
    startAction(skillId, actionName, context);
}

// =============================================
// APPROVAL POPOVER (needs_permission state)
// =============================================
function openPendingApprovalForActionInline(btn, actionId) {
    // See openRunningPopover — capture rect BEFORE any DOM mutation.
    // We do NOT close the jobs dropdown here: when this popover is opened
    // from a dropdown row, keeping the dropdown open lets the user pick
    // another active action without re-opening the menu.
    var anchorRect = _captureAnchorRect(btn);
    closeResultPopover();
    _hideTooltip();
    var a = activeActions[actionId];
    if (!a) return;
    var chat = chats[a.chatId];
    if (!chat) return;
    // Find the pending approval message in the chat
    var pendingApproval = null;
    var approvalIdx = -1;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m.role === 'approval' && m.status === 'pending') {
            pendingApproval = m;
            approvalIdx = i;
            break;
        }
    }
    if (!pendingApproval) return;
    var argSummary = '';
    try {
        var args = pendingApproval.args || {};
        var keys = Object.keys(args).filter(function(k){ return k !== 'status_message' && k !== 'confirm'; });
        if (keys.length) {
            argSummary = '<pre class="action-result-args">' +
                escapeHtml(JSON.stringify(keys.reduce(function(o,k){ o[k]=args[k]; return o; }, {}), null, 2).substring(0, 600)) +
                '</pre>';
        }
    } catch (e) {}
    var el = document.createElement('div');
    el.className = 'action-result-popover state-needs_permission';
    el.innerHTML =
        '<div class="action-result-header">' +
            '<span class="action-result-icon">' + UI_ICONS.lock + '</span>' +
            '<div class="action-result-title">' +
                '<div class="action-result-name">' + escapeHtml(a.skillName) + ' — ' + escapeHtml(a.actionName) + '</div>' +
                '<div class="action-result-label">Approval needed: ' + escapeHtml(pendingApproval.toolName || 'tool call') + '</div>' +
            '</div>' +
            '<button class="action-result-close" aria-label="Close" onclick="closeResultPopover()">' + UI_ICONS.close + '</button>' +
        '</div>' +
        (pendingApproval.args && pendingApproval.args.status_message ?
            '<div class="action-result-output">' + escapeHtml(pendingApproval.args.status_message) + '</div>' : '') +
        argSummary +
        '<div class="action-result-footer">' +
            '<button class="action-result-btn danger" onclick="handleApproval(' + approvalIdx + ',\'deny\',false,\'' + escapeJsString(a.chatId) + '\');closeResultPopover()">Deny</button>' +
            '<button class="action-result-btn secondary" onclick="handleApproval(' + approvalIdx + ',\'session\',false,\'' + escapeJsString(a.chatId) + '\');closeResultPopover()">Allow Session</button>' +
            '<button class="action-result-btn primary" onclick="handleApproval(' + approvalIdx + ',\'allow\',false,\'' + escapeJsString(a.chatId) + '\');closeResultPopover()">Allow</button>' +
        '</div>';
    el.dataset.actionId = actionId;
    el.dataset.popoverType = 'approval';
    document.body.appendChild(el);
    _resultPopover = el;
    _positionPopover(el, anchorRect);
    setTimeout(function() { document.addEventListener('click', _resultPopoverOutside, true); }, 0);
}

// Capture an element's bounding rect defensively. Returns null if the element
// is missing or has zero size (e.g. it was hidden right before we measured it).
function _captureAnchorRect(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    var r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0)) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

// Position a popover anchored below `anchorRect`. Falls back to a viewport-
// centered location if the rect is null/zero so the popover never lands at (0,0)
// and looks like it's stuck on the sidebar.
function _positionPopover(el, anchorRect) {
    var popRect = el.getBoundingClientRect();
    var left, top;
    if (anchorRect) {
        left = Math.max(6, Math.min(window.innerWidth - popRect.width - 6, anchorRect.left + anchorRect.width / 2 - popRect.width / 2));
        top = anchorRect.bottom + 6;
        if (top + popRect.height > window.innerHeight - 6) top = anchorRect.top - popRect.height - 6;
        if (top < 6) top = 6;
    } else {
        // Fallback — center horizontally, anchor near the top of the viewport
        left = Math.max(6, (window.innerWidth - popRect.width) / 2);
        top = 60;
    }
    el.style.left = left + 'px';
    el.style.top = top + 'px';
}

// ---------- Click + hover handlers ----------

function onActionButtonClick(btn) {
    var skillId = btn.getAttribute('data-skill-id');
    var actionName = btn.getAttribute('data-action-name');
    if (!skillId || !actionName) return;
    var actionId = getActionId(skillId, actionName);
    var a = activeActions[actionId];

    if (!a) {
        // Idle → start (from btn — no extra context)
        startAction(skillId, actionName);
        return;
    }
    // Route based on state
    switch (a.state) {
        case 'running':
            if (a.reloadInterrupted || a._isPaused) {
                // Paused or interrupted → open popover with Resume / Stop / View chat
                openRunningPopover(btn, actionId);
            } else {
                // Running → popover with Pause / Stop / View chat (NOT immediate stop)
                openRunningPopover(btn, actionId);
            }
            return;
        case 'stuck':
            openResultPopover(btn, actionId);
            return;
        case 'needs_input':
            openPendingPromptForAction(actionId);
            return;
        case 'needs_permission':
            openPendingApprovalForActionInline(btn, actionId);
            return;
        case 'done':
        case 'error':
        case 'stopped':
            openResultPopover(btn, actionId);
            return;
    }
}

// Running-state control popover: Show chat / Pause or Resume / Stop
function openRunningPopover(btn, actionId) {
    // Capture anchor rect FIRST — required even if we don't close the dropdown,
    // since the row's rect can shift between calls. We INTENTIONALLY do NOT
    // close the jobs dropdown here so the user can pick another row directly.
    var anchorRect = _captureAnchorRect(btn);
    closeResultPopover();
    _hideTooltip();
    var a = activeActions[actionId];
    if (!a) return;
    var isPaused = a._isPaused || a.reloadInterrupted;
    var iconSvg = UI_ICONS[a.icon] || UI_ICONS.spinner;
    var tasksHtml = '';
    if (Array.isArray(a.tasks) && a.tasks.length) {
        tasksHtml = '<div class="action-result-tasks">' +
            a.tasks.map(function(t) {
                var icn = t.status === 'done' ? UI_ICONS.check : (t.status === 'error' ? UI_ICONS.close : (t.status === 'running' ? UI_ICONS.spinner : UI_ICONS.clock));
                return '<div class="action-task status-' + t.status + '">' +
                    '<span class="action-task-icon">' + icn + '</span>' +
                    '<span class="action-task-label">' + escapeHtml(t.label) + '</span>' +
                    '</div>';
            }).join('') +
        '</div>';
    }
    var elapsed = a.startedAt ? Math.max(0, Math.floor((Date.now() - a.startedAt) / 1000)) : 0;
    var el = document.createElement('div');
    el.className = 'action-result-popover state-running' + (isPaused ? ' is-paused' : '');
    el.innerHTML =
        '<div class="action-result-header">' +
            '<span class="action-result-icon">' + iconSvg + '</span>' +
            '<div class="action-result-title">' +
                '<div class="action-result-name">' + escapeHtml(a.skillName) + ' — ' + escapeHtml(a.actionName) + '</div>' +
                '<div class="action-result-label">' + escapeHtml(a.label || '') + ' • ' + elapsed + 's</div>' +
            '</div>' +
            '<button class="action-result-close" aria-label="Close" onclick="closeResultPopover()">' + UI_ICONS.close + '</button>' +
        '</div>' +
        tasksHtml +
        '<div class="action-result-footer">' +
            '<button class="action-result-btn subtle" onclick="viewActionChat(\'' + escapeJsString(actionId) + '\');closeResultPopover()" title="Show the background chat transcript">' + UI_ICONS.chat + ' Show chat</button>' +
            (isPaused
                ? '<button class="action-result-btn primary" onclick="resumeAction(\'' + escapeJsString(actionId) + '\');closeResultPopover()" title="Resume">' + UI_ICONS.play + ' Resume</button>'
                : '<button class="action-result-btn secondary" onclick="pauseAction(\'' + escapeJsString(actionId) + '\');closeResultPopover()" title="Pause">' + UI_ICONS.pause + ' Pause</button>'
            ) +
            '<button class="action-result-btn danger" onclick="stopAction(\'' + escapeJsString(actionId) + '\');closeResultPopover()" title="Stop">' + UI_ICONS.stop + ' Stop</button>' +
        '</div>';
    el.dataset.actionId = actionId;
    el.dataset.popoverType = 'running';
    document.body.appendChild(el);
    _resultPopover = el;
    _positionPopover(el, anchorRect);
    _startRunningPopoverTicker(actionId);
    setTimeout(function() { document.addEventListener('click', _resultPopoverOutside, true); }, 0);
}

// ---- Result popover ----
var _resultPopover = null;

function openResultPopover(btn, actionId) {
    // See openRunningPopover for why we capture the rect before any DOM mutation.
    // We INTENTIONALLY do NOT close the jobs dropdown here — see openRunningPopover.
    var anchorRect = _captureAnchorRect(btn);
    closeResultPopover();
    _hideTooltip();
    var a = activeActions[actionId];
    if (!a) return;
    var iconSvg = UI_ICONS[a.icon] || UI_ICONS.check;
    var tasksHtml = '';
    if (Array.isArray(a.tasks) && a.tasks.length) {
        tasksHtml = '<div class="action-result-tasks">' +
            a.tasks.map(function(t) {
                var icn = t.status === 'done' ? UI_ICONS.check : (t.status === 'error' ? UI_ICONS.close : (t.status === 'running' ? UI_ICONS.spinner : UI_ICONS.clock));
                return '<div class="action-task status-' + t.status + '">' +
                    '<span class="action-task-icon">' + icn + '</span>' +
                    '<span class="action-task-label">' + escapeHtml(t.label) + '</span>' +
                    '</div>';
            }).join('') +
        '</div>';
    }
    var outputHtml = '';
    if (a.output && typeof a.output === 'string') {
        // Defensive: some agents accidentally send literal "\n" instead of real
        // newlines (JSON double-escape). Normalize before handing to the markdown
        // renderer so the output reads cleanly either way.
        var normalized = a.output
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t');
        var rendered = (typeof formatContent === 'function') ? formatContent(normalized) : escapeHtml(normalized);
        outputHtml = '<div class="action-result-output markdown-body">' + rendered + '</div>';
    }
    var durationText = '';
    if (a.startedAt && a.updatedAt) {
        var secs = Math.max(1, Math.floor((a.updatedAt - a.startedAt) / 1000));
        durationText = '<div class="action-result-duration">Took ' + secs + 's</div>';
    }
    // For stuck state, show a Resume button
    var extraBtn = '';
    if (a.state === 'stuck') {
        extraBtn = '<button class="action-result-btn primary" onclick="resumeAction(\'' + escapeJsString(actionId) + '\');closeResultPopover()" title="Resume">' + UI_ICONS.play + ' Resume</button>';
    }
    var el = document.createElement('div');
    el.className = 'action-result-popover state-' + a.state;
    el.innerHTML =
        '<div class="action-result-header">' +
            '<span class="action-result-icon">' + iconSvg + '</span>' +
            '<div class="action-result-title">' +
                '<div class="action-result-name">' + escapeHtml(a.skillName) + ' — ' + escapeHtml(a.actionName) + '</div>' +
                '<div class="action-result-label">' + escapeHtml(a.label || '') + '</div>' +
            '</div>' +
            '<button class="action-result-close" aria-label="Close" onclick="closeResultPopover()">' + UI_ICONS.close + '</button>' +
        '</div>' +
        outputHtml +
        tasksHtml +
        durationText +
        '<div class="action-result-footer">' +
            '<button class="action-result-btn subtle" onclick="viewActionChat(\'' + escapeJsString(actionId) + '\');closeResultPopover()" title="Show the background chat transcript">' + UI_ICONS.chat + ' Show chat</button>' +
            '<button class="action-result-btn secondary" onclick="dismissAction(\'' + escapeJsString(actionId) + '\');closeResultPopover()">Dismiss</button>' +
            extraBtn +
        '</div>';
    el.dataset.actionId = actionId;
    el.dataset.popoverType = 'result';
    document.body.appendChild(el);
    _resultPopover = el;
    _positionPopover(el, anchorRect);
    setTimeout(function() {
        document.addEventListener('click', _resultPopoverOutside, true);
    }, 0);
}

function _resultPopoverOutside(e) {
    if (!_resultPopover) return;
    if (_resultPopover.contains(e.target)) return;
    // Don't close the popover when the user clicks inside an open jobs dropdown
    // — they may be picking another row, which will replace the popover anyway.
    var dropdowns = document.querySelectorAll('.jobs-dropdown');
    for (var i = 0; i < dropdowns.length; i++) {
        if (dropdowns[i].style.display === 'block' && dropdowns[i].contains(e.target)) return;
    }
    closeResultPopover();
}

function closeResultPopover() {
    if (_runningPopoverTimer) { clearInterval(_runningPopoverTimer); _runningPopoverTimer = null; }
    if (_resultPopover && _resultPopover.parentNode) _resultPopover.parentNode.removeChild(_resultPopover);
    _resultPopover = null;
    document.removeEventListener('click', _resultPopoverOutside, true);
}

// ---- Live-refresh open action popover when the underlying state changes ----
// Without this, clicking a running pill would freeze the popover at its initial
// snapshot — tasks, label, elapsed time, even state transitions (running→done)
// would silently go stale until the user clicked the pill twice. We tag every
// popover with data-action-id + data-popover-type at open time so the listener
// can detect a match cheaply and rebuild in place.
var _runningPopoverTimer = null;

function _findActionAnchor(actionId) {
    // Prefer a button inside the open jobs dropdown row (matches how the popover
    // was anchored originally), else any visible action button for this action.
    var dd = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
    if (dd) {
        var row = dd.querySelector('.jobs-dropdown-row[data-action-id="' + actionId + '"]');
        if (row) return row;
    }
    var a = activeActions[actionId];
    if (!a) return null;
    var btns = document.querySelectorAll('.action-btn[data-skill-id="' + a.skillId + '"][data-action-name="' + a.actionName + '"]');
    for (var i = 0; i < btns.length; i++) {
        if (btns[i].offsetParent !== null) return btns[i];
    }
    return btns[0] || null;
}

function _refreshOpenActionPopover(actionId) {
    if (!_resultPopover) return;
    if (_resultPopover.dataset.actionId !== actionId) return;
    var a = activeActions[actionId];
    if (!a) { closeResultPopover(); return; }
    // Skip needs_input — it routes to a separate prompt popup, not _resultPopover.
    if (a.state === 'needs_input') { closeResultPopover(); return; }
    var anchor = _findActionAnchor(actionId);
    // Re-open via the same routing onActionButtonClick uses. Each open*
    // function calls closeResultPopover() first, so the previous popover is
    // torn down (incl. its ticker) before the new one is built.
    if (a.state === 'running') { openRunningPopover(anchor, actionId); return; }
    if (a.state === 'needs_permission') { openPendingApprovalForActionInline(anchor, actionId); return; }
    // stuck / done / error / stopped
    openResultPopover(anchor, actionId);
}

// 1-second ticker — updates elapsed time on the running popover label without
// rebuilding the whole DOM (avoids flicker, preserves any text selection).
function _startRunningPopoverTicker(actionId) {
    if (_runningPopoverTimer) { clearInterval(_runningPopoverTimer); _runningPopoverTimer = null; }
    _runningPopoverTimer = setInterval(function() {
        if (!_resultPopover || _resultPopover.dataset.popoverType !== 'running' || _resultPopover.dataset.actionId !== actionId) {
            clearInterval(_runningPopoverTimer); _runningPopoverTimer = null; return;
        }
        var a = activeActions[actionId];
        if (!a) { clearInterval(_runningPopoverTimer); _runningPopoverTimer = null; return; }
        var labelEl = _resultPopover.querySelector('.action-result-label');
        if (labelEl) {
            var ela = a.startedAt ? Math.max(0, Math.floor((Date.now() - a.startedAt) / 1000)) : 0;
            labelEl.textContent = (a.label || '') + ' • ' + ela + 's';
        }
    }, 1000);
}

// Always close tooltip before opening a popover — avoids stacked fixed elements on the button.

function _hideTooltip() {
    if (_actionTooltipTimer) { clearInterval(_actionTooltipTimer); _actionTooltipTimer = null; }
    if (_actionTooltipEl && _actionTooltipEl.parentNode) {
        _actionTooltipEl.parentNode.removeChild(_actionTooltipEl);
        _actionTooltipEl = null;
    }
}

// Tooltip — shows label + task list + (for running) elapsed time.
var _actionTooltipEl = null;
var _actionTooltipTimer = null;

function onActionButtonHover(btn) {
    clearInterval(_actionTooltipTimer);
    showActionTooltip(btn);
    // Update tooltip every second while hovered (to animate elapsed time)
    _actionTooltipTimer = setInterval(function() { showActionTooltip(btn); }, 1000);
}

function onActionButtonLeave() {
    clearInterval(_actionTooltipTimer);
    if (_actionTooltipEl && _actionTooltipEl.parentNode) {
        _actionTooltipEl.parentNode.removeChild(_actionTooltipEl);
    }
    _actionTooltipEl = null;
}

function showActionTooltip(btn) {
    var skillId = btn.getAttribute('data-skill-id');
    var actionName = btn.getAttribute('data-action-name');
    if (!skillId || !actionName) return;
    var actionId = getActionId(skillId, actionName);
    var a = activeActions[actionId];

    // Skip tooltip when idle — the button label is already visible on the button itself.
    if (!a) return;

    var html = '';
    if (a && Array.isArray(a.tasks) && a.tasks.length) {
        html += '<div class="action-tooltip-tasks">' +
            a.tasks.map(function(t) {
                var icn = t.status === 'done' ? UI_ICONS.check :
                          t.status === 'error' ? UI_ICONS.close :
                          t.status === 'running' ? UI_ICONS.spinner :
                          UI_ICONS.clock;
                return '<div class="action-task status-' + t.status + '">' +
                    '<span class="action-task-icon">' + icn + '</span>' +
                    '<span class="action-task-label">' + escapeHtml(t.label) + '</span>' +
                    '</div>';
            }).join('') +
        '</div>';
    } else if (a.state === 'running') {
        var elapsed = Math.floor((Date.now() - a.startedAt) / 1000);
        html += '<div class="action-tooltip-label">' + escapeHtml(a.label || 'Running…') + ' • ' + elapsed + 's</div>';
    } else {
        html += '<div class="action-tooltip-label">' + escapeHtml(a.label || actionName) + '</div>';
    }

    if (!_actionTooltipEl) {
        _actionTooltipEl = document.createElement('div');
        _actionTooltipEl.className = 'action-tooltip';
        document.body.appendChild(_actionTooltipEl);
    }
    _actionTooltipEl.innerHTML = html;
    // Position below the button, clamped to viewport
    var rect = btn.getBoundingClientRect();
    var ttRect = _actionTooltipEl.getBoundingClientRect();
    var left = Math.max(6, Math.min(window.innerWidth - ttRect.width - 6, rect.left + rect.width / 2 - ttRect.width / 2));
    var top = rect.bottom + 6;
    if (top + ttRect.height > window.innerHeight - 6) {
        top = rect.top - ttRect.height - 6;
    }
    _actionTooltipEl.style.left = left + 'px';
    _actionTooltipEl.style.top = top + 'px';
}

// ---------- "Needs input" / "Needs permission" integration ----------
// These are set by prompt_user and tool-approval when they detect a
// background chat. Clicking the button opens the pending popup.

function setActionNeedsInput(actionId, promptId) {
    var a = activeActions[actionId];
    if (!a) return;
    // Stash the agent-set label/icon so we can restore them when the user
    // submits the prompt — otherwise the running state shows a generic
    // "Running…" instead of the contextual label the agent had set.
    if (a.state !== 'needs_input') {
        a._labelBeforeBlock = a.label;
        a._iconBeforeBlock = a.icon;
    }
    a.state = 'needs_input';
    a.icon = 'bell';
    a.label = 'Input needed';
    a.needsInputPromptId = promptId;
    a.updatedAt = Date.now();
    persistActionState(actionId);
    notifyActionStateChanged(actionId);
}

function clearActionNeedsInput(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    if (a.state === 'needs_input') {
        a.state = 'running';
        a.icon = a._iconBeforeBlock || 'spinner';
        a.label = a._labelBeforeBlock || 'Running…';
        delete a._labelBeforeBlock;
        delete a._iconBeforeBlock;
    }
    a.needsInputPromptId = null;
    a.updatedAt = Date.now();
    persistActionState(actionId);
    notifyActionStateChanged(actionId);
}

function setActionNeedsPermission(actionId, approvalRef) {
    var a = activeActions[actionId];
    if (!a) return;
    if (a.state !== 'needs_permission') {
        a._labelBeforeBlock = a.label;
        a._iconBeforeBlock = a.icon;
    }
    a.state = 'needs_permission';
    a.icon = 'lock';
    a.label = 'Approval needed';
    a.needsApprovalRef = approvalRef;
    a.updatedAt = Date.now();
    persistActionState(actionId);
    notifyActionStateChanged(actionId);
}

function clearActionNeedsPermission(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    if (a.state === 'needs_permission') {
        a.state = 'running';
        a.icon = a._iconBeforeBlock || 'spinner';
        a.label = a._labelBeforeBlock || 'Running…';
        delete a._labelBeforeBlock;
        delete a._iconBeforeBlock;
    }
    a.needsApprovalRef = null;
    a.updatedAt = Date.now();
    persistActionState(actionId);
    notifyActionStateChanged(actionId);
}

function openPendingPromptForAction(actionId) {
    var a = activeActions[actionId];
    if (!a || !a.needsInputPromptId) return;
    if (typeof openBackgroundPromptPopup === 'function') {
        openBackgroundPromptPopup(a.chatId, a.needsInputPromptId);
    }
}

// ---------- Results view (completed action) ----------

function openActionResults(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    // Reveal the background chat from the list and open it. DO NOT auto-dismiss —
    // PM may want the button to stay until they explicitly dismiss it from the jobs dropdown.
    if (typeof selectChat === 'function' && chats[a.chatId]) {
        chats[a.chatId]._revealed = true;
        // Persist the reveal flag in case selectChat fails or the user navigates away
        // before saveChatsToStorage is called from inside selectChat.
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        selectChat(a.chatId);
    }
    closeJobsDropdown();
}

// ---------- Jobs badge (header) ----------

function getActiveActionsList() {
    return Object.keys(activeActions).map(function(id) { return activeActions[id]; })
        .sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
}

// Currently-running chats that are NOT already represented by an active action
// row (action chats live in the 'Active Actions' section) and are NOT the chat
// the user is already focused on. Source of truth is the in-memory runningChatIds
// map (core/030-config.js), kept live in the panel by the worker->page bridge
// (045-agent-port-bridge-page.js).
// How long a chat lingers under "Active Chats" after its run stops, so a chat
// that just finished streaming doesn't vanish from the badge instantly.
var ACTIVE_CHAT_LINGER_MS = 5 * 60 * 1000; // 5 minutes
// Chats younger than this always show under "Active Chats" (recent work the
// user may want to get back to), even when idle and already seen.
var RECENT_CHAT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
// chatId -> finishedAt (ms). Populated by markChatRecentlyFinished() from the
// runFinished / runCrashed handlers (app/036-agent-event-handlers-page.js).
var _recentlyFinishedChats = {};

// True only when the user is genuinely LOOKING at this chat: it is the focused
// chat AND the chat view is the active view. On home/history/settings/dashboard
// views currentChatId still points at the last-opened chat, but the user cannot
// see its messages — activity/finishes there must count as UNSEEN (bell + bold),
// mirroring noteChatFinishedUnseen (ui/165-finished-chat-badge.js). Before this
// check, a chat finishing while the user sat on the Home view (e.g. watching the
// expanded jobs modal) was stamped 'seen' via the bare currentChatId comparison,
// so its card/row never showed the bell in real time.
function _isChatViewFocused(chatId) {
    if (typeof currentChatId === 'undefined' || chatId !== currentChatId) return false;
    return (typeof currentView === 'undefined' || currentView === 'chat');
}

// Helper for renderers: is this chat actually streaming right now (vs lingering)?
function isChatActivelyRunning(chatId) {
    return !!(typeof runningChatIds !== 'undefined' && runningChatIds && runningChatIds[chatId]);
}

// chatId -> true while that chat's AFTER-RESPONSE HOOKS (auto-title / tldr /
// links) are running as a silent hook run. Maintained by the silentHookState
// handler (app/036-agent-event-handlers-page.js). From the user's point of
// view the chat is DONE the moment its visible answer landed — the hook run
// re-sets runningChatIds for a couple of seconds, which used to keep the jobs
// rows in "Running…" (no bell) while the pill bell was already lit. Display
// predicates below subtract this so the row bell shows immediately.
var _silentHookChats = {};
function _isChatInSilentHook(chatId) {
    return !!(chatId && _silentHookChats[chatId]);
}

// True when a chat finished within the last ACTIVE_CHAT_LINGER_MS and so should
// keep showing under "Active Chats" (the running list) instead of immediately
// dropping into Completed Today the instant its run ends.
function _isChatLingering(chatId) {
    var t = _recentlyFinishedChats[chatId];
    // Fall back to the PERSISTED finish stamp (lastResponseAt) when the in-memory
    // map has no entry. That map is per-page-session, so after a panel reload — or
    // for a finish the page never received a runFinished event for (SW reconnect
    // flap) — it is empty, which is exactly why a just-finished chat sometimes
    // failed to keep showing under Active Chats. lastResponseAt is saved to storage
    // at finish time, so it survives reloads and makes the 5-minute linger reliable.
    if (!t) {
        var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
        if (c && !c.isBackground && !c.isSubAgent && c.lastResponseAt) t = c.lastResponseAt;
    }
    return !!(t && (Date.now() - t) <= ACTIVE_CHAT_LINGER_MS);
}

// True when this chat has a FINISHED response the user hasn't opened yet (an
// "unread" chat). Such a chat must keep showing under "Active Chats" no matter
// how old it is — past the 5-minute linger window, even days later — until the
// user actually views it (which sets lastViewedAt and clears the unseen flag).
// Mirrors the 'unseen' branch of _jobsChatState. Scoped to regular user chats:
// background Action chats live in their own strip and sub-agents in Workers, so
// they never qualify here (keeps them out of Active and unaffected in
// Completed Today).
function _isChatUnseen(chatId) {
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c || c.isBackground || c.isSubAgent) return false;
    // Running / approval-blocked chats are handled by isChatBusy; this predicate
    // is only about an idle chat with an unread response.
    if (typeof isChatBusy === 'function' && isChatBusy(chatId)) return false;
    var _lastAct = Math.max(c.lastResponseAt || 0, c.lastActivityAt || 0);
    return !!(_lastAct && _lastAct > (c.lastViewedAt || 0) && !_isChatViewFocused(chatId));
}

// True when the chat has ANY activity (finished response OR mid-run event —
// assistant message, tool call, error, approval request…) newer than the
// user's last view. This is the 'unread email' predicate for BOLD rows: unlike
// _isChatUnseen it deliberately ignores running/error state — a chat producing
// output while the user is away must read as unread until they open it.
function _chatHasUnseenActivity(chatId) {
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c || c.isBackground || c.isSubAgent) return false;
    if (_isChatViewFocused(chatId)) return false;
    var last = Math.max(c.lastResponseAt || 0, c.lastActivityAt || 0);
    return !!(last && last > (c.lastViewedAt || 0));
}

// Stamp user-visible activity on a chat. Called from the page-side agent event
// handlers (036-agent-event-handlers-page.js) for anything that lands on a chat:
// assistant messages, tool calls, injected user messages, errors, parked
// approvals, run starts/crashes. If the user is NOT viewing the chat, the stamp
// flips it to 'unread' (bold in the jobs lists) until they open it. The focused
// chat sees its own activity, so its lastViewedAt is refreshed instead. Silent
// after-response hooks (auto title/tldr) are invisible work, not new activity.
function markChatActivity(chatId) {
    if (!chatId) return;
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c || c.isBackground || c.isSubAgent) return;
    if (typeof _isChatInSilentHook === 'function' && _isChatInSilentHook(chatId)) return;
    var now = Date.now();
    if (_isChatViewFocused(chatId)) {
        c.lastViewedAt = now; // watching — seen as it happens
        return;
    }
    var wasUnread = _chatHasUnseenActivity(chatId);
    c.lastActivityAt = now;
    if (wasUnread) return; // already bold — no repaint/save churn per event
    try { if (typeof saveChatsToStorage === 'function') saveChatsToStorage(); } catch (e) {}
    try { if (typeof renderJobsBadge === 'function') renderJobsBadge(); } catch (e) {}
    try {
        var _jdAct = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
        if (_jdAct && typeof renderJobsDropdown === 'function') renderJobsDropdown(_jdAct);
    } catch (e) {}
}

// True when this chat (as root or direct parent) still owns a sub-agent that is
// running, even though the chat's OWN agent loop has stopped. Such a chat is not
// finished — its workers are still producing results — so it must stay under
// Active Chats and out of Recent/Done/Completed Today.
function chatHasRunningSubAgents(chatId) {
    if (!chatId || typeof _subAgents === 'undefined' || !_subAgents) return false;
    for (var _said in _subAgents) {
        var _sr = _subAgents[_said];
        if (!_sr || _sr.state !== 'running') continue;
        if (_sr.root_chat_id === chatId || _sr.parent_chat_id === chatId) return true;
    }
    return false;
}

// Broader "busy" predicate for the jobs dropdown's Active-vs-Done classification:
// a chat counts as active when its own loop is streaming, OR a sub-agent it owns
// is still running, OR it is blocked on a pending tool-approval (it needs the
// user). Used so none of those three cases is mislabelled "completed".
function isChatBusy(chatId) {
    if (isChatActivelyRunning(chatId)) return true;
    if (chatHasRunningSubAgents(chatId)) return true;
    if (typeof chatHasPendingApproval === 'function' && chatHasPendingApproval(chatId)) return true;
    return false;
}

// Called when a chat's run ends. Stamps the finish time so the chat keeps
// showing under "Active Chats" for ACTIVE_CHAT_LINGER_MS, then schedules a
// badge/dropdown refresh to drop it when the window expires.
function markChatRecentlyFinished(chatId) {
    if (!chatId) return;
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    // Only linger regular user chats. Action chats live under "Active Actions"
    // (with their own result popover) and sub-agent chats have the Workers
    // strip — lingering those would clutter the badge.
    if (c && (c.isBackground || c.isSubAgent)) return;
    // Stamp the response time — drives the 'unseen last response' rule in
    // getActiveChatsList(). If the user is currently looking at this chat the
    // response counts as seen immediately.
    if (c) {
        c.lastResponseAt = Date.now();
        // A re-run un-hides a chat the user previously removed from the jobs list.
        if (c._jobsHidden) delete c._jobsHidden;
        if (_isChatViewFocused(chatId)) c.lastViewedAt = Date.now();
        if (typeof saveChatsToStorage === 'function') { try { saveChatsToStorage(); } catch (e) {} }
    }
    _recentlyFinishedChats[chatId] = Date.now();
    setTimeout(function() {
        var t = _recentlyFinishedChats[chatId];
        if (!t) return;
        // Re-stamped by a newer finish (chat ran again) — let the newer timer win.
        if (Date.now() - t < ACTIVE_CHAT_LINGER_MS) return;
        delete _recentlyFinishedChats[chatId];
        try { if (typeof renderJobsBadge === 'function') renderJobsBadge(); } catch (e) {}
        try {
            var jd = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
            if (jd && typeof renderJobsDropdown === 'function') renderJobsDropdown(jd);
        } catch (e) {}
    }, ACTIVE_CHAT_LINGER_MS + 250);
}

function getActiveChatsList() {
    var actionChatIds = {};
    getActiveActionsList().forEach(function(a){ if (a && a.chatId) actionChatIds[a.chatId] = true; });
    var out = [];
    var seen = {};
    var now = Date.now();
    // NOTE: we intentionally DO NOT exclude currentChatId. The badge is a
    // truthful "active chats" indicator, so the chat you're currently viewing
    // shows here while it streams, and a previous chat still streaming after
    // you hit New Chat / switch away shows too. (The old exclusion hid the
    // current chat by design, which made the group look permanently empty for
    // users whose only concurrency is the chat they're in.)
    function consider(cid) {
        if (seen[cid]) return;
        if (actionChatIds[cid]) return;                 // already shown under Active Actions
        var c = (typeof chats !== 'undefined') ? chats[cid] : null;
        if (!c) return;
        // Mirror markChatRecentlyFinished()'s linger guard: Action chats live under
        // "Active Actions" and sub-agent chats live in the Workers strip, so neither
        // belongs in the "Active Chats" group. Without this, every running sub-agent
        // chat (mirrored into runningChatIds by the port bridge) double-counts the
        // badge and surfaces cryptic background/sub transcripts. Regular background
        // user chats are NOT flagged isBackground, so this does not hide them.
        if (c.isSubAgent || c.isBackground) return;
        // Honor an explicit 'remove from list' (dismissChatFromJobs) even while the
        // chat is running; pinned chats are never hidden.
        if (c._jobsHidden && !c.pinned) return;
        seen[cid] = true;
        out.push(c);
    }
    // 1) Currently-running chats.
    if (typeof runningChatIds !== 'undefined' && runningChatIds) {
        Object.keys(runningChatIds).forEach(function(cid) {
            if (runningChatIds[cid]) consider(cid);
        });
    }
    // 2) Recently-finished chats still inside the linger window. Scan ALL chats
    //    via _isChatLingering (not just the in-memory _recentlyFinishedChats map)
    //    so a finish whose in-memory stamp was lost to a panel reload — but whose
    //    persisted lastResponseAt is still within the window — keeps lingering
    //    under Active Chats instead of intermittently disappearing.
    if (typeof chats !== 'undefined' && chats) {
        Object.keys(chats).forEach(function(cid) {
            if (_isChatLingering(cid)) consider(cid);
        });
    }
    // 3) Chats the user hasn't caught up on (a response arrived after they last
    //    viewed the chat — the chat in focus is always 'seen'), and
    // 4) chats younger than RECENT_CHAT_WINDOW_MS with at least one message
    //    (empty/temporary New Chats have nothing to show).
    if (typeof chats !== 'undefined' && chats) {
        Object.keys(chats).forEach(function(cid) {
            var c = chats[cid];
            if (!c || !Array.isArray(c.messages) || !c.messages.length) return;
            var _uLast = Math.max(c.lastResponseAt || 0, c.lastActivityAt || 0);
            var unseen = !!(_uLast && _uLast > (c.lastViewedAt || 0) &&
                (typeof _isChatViewFocused !== 'function' || !_isChatViewFocused(cid)));
            var young = !!(c.createdAt && (now - c.createdAt) < RECENT_CHAT_WINDOW_MS);
            if (unseen || young) consider(cid);
        });
    }
    // 5) Chats whose own agent loop has stopped but that still own a running
    //    sub-agent — keep them under Active Chats until their workers finish.
    if (typeof _subAgents !== 'undefined' && _subAgents) {
        Object.keys(_subAgents).forEach(function(_said) {
            var _sr = _subAgents[_said];
            if (!_sr || _sr.state !== 'running') return;
            if (_sr.root_chat_id) consider(_sr.root_chat_id);
            if (_sr.parent_chat_id) consider(_sr.parent_chat_id);
        });
    }
    // 6) Chats blocked on a pending tool-approval — they need the user, so they
    //    belong under Active Chats (orange), not Recent/Done/Completed Today.
    if (typeof chats !== 'undefined' && chats && typeof chatHasPendingApproval === 'function') {
        Object.keys(chats).forEach(function(cid) {
            if (chatHasPendingApproval(cid)) consider(cid);
        });
    }
    // Order by chat creation time, MOST RECENT FIRST, so the newest active chat
    // sits at the top of the Active list.
    out.sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return out;
}

function getRunningActionsCount() {
    var n = 0;
    Object.keys(activeActions).forEach(function(id) {
        var a = activeActions[id];
        // Paused actions are still state:'running' but no work is happening — don't
        // count them in the badge's "running" tally.
        if (a._isPaused) return;
        // Orphan entries (skill/action gone) are not rendered as pills, so they
        // mustn't be counted in the badge — otherwise the badge says "1" while
        // the header has nothing clickable.
        if (_isOrphanActiveAction(a)) return;
        var s = a.state;
        if (s === 'running' || s === 'needs_input' || s === 'needs_permission') n++;
    });
    return n;
}

function hasActionsNeedingAttention() {
    return Object.keys(activeActions).some(function(id) {
        var a = activeActions[id];
        // Skip orphans — nothing visible to draw attention to.
        if (_isOrphanActiveAction(a)) return false;
        var s = a.state;
        // 'stuck' is documented as needing attention (spec §4 Button States) — should
        // pulse amber alongside needs_input/needs_permission.
        return s === 'needs_input' || s === 'needs_permission' || s === 'stuck';
    });
}

// Compute the aggregate state of all active actions. Drives the badge color.
// Priority (most urgent wins):
//   attention  — anything is waiting for input or permission
//   error      — at least one action errored
//   running    — at least one is in flight (with spinner)
//   done       — nothing running, at least one finished cleanly
//   idle       — fallback (stopped-only, etc.)
function _getAggregateActionState() {
    // Filter orphans so the aggregate (which drives badge color) agrees with
    // what the user actually sees in the pill row.
    var list = getActiveActionsList().filter(function(a){ return !_isOrphanActiveAction(a); });
    if (!list.length) return 'empty';
    var hasAttention = false, hasError = false, hasRunning = false, hasDone = false;
    for (var i = 0; i < list.length; i++) {
        var s = list[i].state;
        if (s === 'needs_input' || s === 'needs_permission' || s === 'stuck') hasAttention = true;
        else if (s === 'error') hasError = true;
        else if (s === 'running') hasRunning = true;
        else if (s === 'done') hasDone = true;
    }
    if (hasAttention) return 'attention';
    if (hasError)     return 'error';
    if (hasRunning)   return 'running';
    if (hasDone)      return 'done';
    return 'idle';
}

// Tracks the previous aggregate state so we can fire a one-shot "finish pulse"
// when running actions transition to all-done.
var _prevAggregateState = 'empty';

// Render every visible jobs badge in the DOM (header + home etc.) so they
// stay in sync. Each .jobs-badge element shares the same data.
function renderJobsBadge() {
    var badges = document.querySelectorAll('.jobs-badge');
    if (!badges.length) return;
    // Keep the full-screen Expand modal (if open) live alongside the badge.
    if (typeof _refreshJobsExpandModal === 'function') _refreshJobsExpandModal();
    // Filter orphans so the badge count matches what the user actually sees in
    // the live-pill row and the dropdown. Without this, an uninstalled-skill
    // entry left in `activeActions` would show "1" in the badge with no
    // clickable pill or dropdown row.
    var list = getActiveActionsList().filter(function(a){ return !_isOrphanActiveAction(a); });
    var chatList = (typeof getActiveChatsList === 'function') ? getActiveChatsList() : [];
    // Lingering (recently-finished) chats count toward the visible total but must
    // NOT add a spinner or force a 'running' colour — only actively-streaming
    // chats do.
    var runningChats = 0;
    // Silent-hook window: rows already show the finished bell (PR #486) — the
    // badge must not keep a running spinner for the same chat.
    chatList.forEach(function(c){
        if ((isChatActivelyRunning(c.id) || chatHasRunningSubAgents(c.id)) &&
            !(typeof _isChatInSilentHook === 'function' && _isChatInSilentHook(c.id))) runningChats++;
    });
    var count = list.length + chatList.length;
    var running = getRunningActionsCount() + runningChats;
    var agg = _getAggregateActionState();
    // Chats with no actions still need a coloured badge: 'running' if any chat is
    // actively streaming, else 'done' (a lingering finished chat).
    // An actively-streaming chat must also win the colour over a *finished* action
    // that is still lingering (agg==='done'/'idle'), otherwise the badge paints a
    // green "done" with a spinner — and fires a premature finish-pulse — while a
    // chat is still running. attention/error still outrank a running chat.
    if (runningChats && agg !== 'attention' && agg !== 'error') agg = 'running';
    else if (agg === 'empty' && chatList.length) agg = runningChats ? 'running' : 'done';
    // B15: surface an unfocused chat's API error on the badge. A chat that errored
    // (chats[id]._lastApiError, set by R-1) but isn't actively streaming should
    // colour the badge 'error' so the failure isn't silent. Ranks below 'attention'
    // (a pending approval is more urgent) but above running/done.
    var erroredChats = 0;
    chatList.forEach(function(c){ if (!isChatActivelyRunning(c.id) && typeof chats !== 'undefined' && chats[c.id] && chats[c.id]._lastApiError) erroredChats++; });
    if (erroredChats && agg !== 'attention') agg = 'error';
    // A chat blocked on a pending tool-approval needs the user — surface it as
    // 'attention' (orange) on the badge, outranking running/done/error.
    var approvalChats = 0;
    chatList.forEach(function(c){ if (typeof chatHasPendingApproval === 'function' && chatHasPendingApproval(c.id)) approvalChats++; });
    if (approvalChats) agg = 'attention';
    // Finished-while-elsewhere bell segment (ui/165-finished-chat-badge.js):
    // chats that finished while the user was viewing another chat/view and
    // hasn't opened since. Rendered inside this same pill, after the count.
    var unseen = (typeof getUnseenFinishedChatsInfo === 'function') ? getUnseenFinishedChatsInfo() : { count: 0, hasError: false };
    var titleSuffix = '';
    if (agg === 'attention')    titleSuffix = ' — needs attention';
    else if (agg === 'error')   titleSuffix = ' — has errors';
    else if (agg === 'running') titleSuffix = ' — running';
    else if (agg === 'done')    titleSuffix = ' — done';
    // Detect the running→done transition so we can fire a one-shot finish pulse.
    var justFinished = (_prevAggregateState === 'running' && (agg === 'done' || agg === 'idle'));
    _prevAggregateState = agg;
    badges.forEach(function(badge) {
        // The jobs badge is ALWAYS visible: it is the launcher for the
        // Active / Recent / Done chats popup, so it must stay reachable even
        // when nothing is running and there is nothing to review.
        badge.style.display = 'inline-flex';
        // Only genuinely running jobs (running actions + actively-running chats)
        // count as "Active". Pinned / completed-today / lingering-finished chats
        // stay visible in the dropdown but must NOT inflate the pill. Idle =
        // nothing running, nothing to review, nothing needing attention.
        if (!running && !unseen.count && agg !== 'attention' && agg !== 'error') {
            // Idle: no active jobs, nothing unseen. The pill is the launcher for
            // the Active/Recent/History chats popup, so it keeps the "Active chats"
            // label even when nothing is running, instead of collapsing to a lone
            // icon. data-agg='idle' is styled with the SAME primary pill look as
            // the running/active state (see 23-actions.css) so it never greys out.
            badge.setAttribute('data-agg', 'idle');
            badge.classList.remove('pulse', 'finish-pulse');
            badge.title = 'Active chats';
            badge.innerHTML = '<span class="jobs-badge-icon">' + (UI_ICONS.chat || UI_ICONS.history || UI_ICONS.zap) + '</span>' +
                '<span class="jobs-badge-label">Active chats</span>';
            return;
        }
        badge.setAttribute('data-agg', agg);
        // "pulse" is the existing infinite attention pulse; only on attention state.
        badge.classList.toggle('pulse', agg === 'attention');
        // The pill counts only genuinely-running jobs ("Active N"). A finished
        // chat needing review shows the bell; an attention/error state with
        // nothing running shows an alert icon so the coloured pill isn't empty.
        badge.title = (running ? running + ' active job' + (running === 1 ? '' : 's') + titleSuffix : '') +
            (unseen.count ? (running ? ' — ' : '') + unseen.count + ' finished chat' + (unseen.count === 1 ? '' : 's') + ' to review' : '');
        badge.innerHTML =
            (running ? '<span class="jobs-badge-icon">' + UI_ICONS.chat + '</span>' +
                '<span class="jobs-badge-label">Active</span>' +
                '<span class="jobs-badge-count">' + running + '</span>' +
                '<span class="jobs-badge-spinner">' + UI_ICONS.spinner + '</span>' : '') +
            (!running && (agg === 'attention' || agg === 'error') ?
                '<span class="jobs-badge-icon">' + (UI_ICONS.alert || UI_ICONS.bell || UI_ICONS.chat) + '</span>' : '') +
            (unseen.count ? '<span class="jobs-badge-bell' + (unseen.hasError ? ' err' : '') + '">' + (UI_ICONS.bell_filled || UI_ICONS.bell) +
                (unseen.count > 1 ? '<span class="jobs-badge-bell-count">' + unseen.count + '</span>' : '') + '</span>' : '') +
            // Nothing is actively running, so the pill is still the "Active chats"
            // launcher: keep the text label. The bell (or alert) rendered above
            // stands in for the icon — the bell replaces the icon, the text stays.
            (!running ? '<span class="jobs-badge-label">Active chats</span>' : '');
        if (justFinished) {
            // Restart the one-shot animation by toggling the class.
            badge.classList.remove('finish-pulse');
            // Force a reflow so the animation re-triggers when re-added.
            void badge.offsetWidth;
            badge.classList.add('finish-pulse');
            setTimeout(function() { badge.classList.remove('finish-pulse'); }, 1400);
        }
    });
}

// Find the currently-visible jobs dropdown (the one inside a visible panel).
// Falls back to the first dropdown if none have a visible offsetParent.
function _getVisibleJobsDropdown() {
    var dropdowns = document.querySelectorAll('.jobs-dropdown');
    for (var i = 0; i < dropdowns.length; i++) {
        if (dropdowns[i].offsetParent !== null) return dropdowns[i];
        // Even if the dropdown itself is display:none, check if its wrapper is visible
        var wrapper = dropdowns[i].closest('.jobs-badge-wrapper');
        if (wrapper && wrapper.offsetParent !== null) return dropdowns[i];
    }
    return dropdowns[0] || null;
}

// Find an open jobs dropdown (display:block), if any.
function _getOpenJobsDropdown() {
    var dropdowns = document.querySelectorAll('.jobs-dropdown');
    for (var i = 0; i < dropdowns.length; i++) {
        if (dropdowns[i].style.display === 'block') return dropdowns[i];
    }
    return null;
}

// `badgeEl` is the .jobs-badge that was clicked. Toggle its sibling dropdown
// and close any others (only one open at a time).
function toggleJobsDropdown(badgeEl) {
    var wrapper = badgeEl ? badgeEl.closest('.jobs-badge-wrapper') : null;
    var dropdown = wrapper ? wrapper.querySelector('.jobs-dropdown') : _getVisibleJobsDropdown();
    if (!dropdown) return;
    var willShow = dropdown.style.display !== 'block';
    // Close any other open dropdowns first
    document.querySelectorAll('.jobs-dropdown').forEach(function(d) {
        if (d !== dropdown) d.style.display = 'none';
    });
    dropdown.style.display = willShow ? 'block' : 'none';
    if (willShow) renderJobsDropdown(dropdown);
}

function closeJobsDropdown() {
    document.querySelectorAll('.jobs-dropdown').forEach(function(d) {
        d.style.display = 'none';
    });
}

// Render the rows for `dropdown` (or all dropdowns if omitted).
function renderJobsDropdown(dropdown) {
    if (!dropdown) {
        document.querySelectorAll('.jobs-dropdown').forEach(renderJobsDropdown);
        return;
    }
    // Filter orphans — dropdown rows clicking through to a missing skill/action
    // would just no-op (onJobsDropdownRowClick reads activeActions[id] but every
    // sub-action requires a real skill+action to render the popover).
    var list = getActiveActionsList().filter(function(a){ return !_isOrphanActiveAction(a); });
    var chatList = (typeof getActiveChatsList === 'function') ? getActiveChatsList() : [];
    // Tabs (Recent/Done/Pinned) source from the full chat map, not just the
    // active list, so the panel must stay reachable even when nothing is active
    // but there ARE finished/pinned chats to show. Only fall back to the empty
    // state when there is genuinely nothing anywhere.
    var _hasTabContent = (typeof getRecentChatsList === 'function' && getRecentChatsList().length) ||
        (typeof getDoneChatsList === 'function' && getDoneChatsList().length) ||
        (typeof getPinnedChatsList === 'function' && getPinnedChatsList().length);
    if (!list.length && !chatList.length && !_hasTabContent) {
        dropdown.innerHTML = '<div class="jobs-dropdown-empty">No active jobs</div>';
        return;
    }
    var rowsHtml = list.map(function(a) {
        // Use the action's own configured icon (same one its button/pill shows),
        // not the transient update_action_state icon — the row identifies the action.
        var iconSvg = UI_ICONS[a.originalIcon] || UI_ICONS[a.icon] || UI_ICONS.play;
        var showViewChat = (a.state !== 'running');
        return '<div class="jobs-dropdown-row state-' + a.state + '" ' +
            'data-action-id="' + escapeHtml(a.actionId) + '" ' +
            'onclick="onJobsDropdownRowClick(\'' + escapeJsString(a.actionId) + '\')">' +
            '<span class="jobs-row-icon">' + iconSvg + '</span>' +
            '<div class="jobs-row-main">' +
                '<div class="jobs-row-title">' + escapeHtml(a.skillName) + ' — ' + escapeHtml(a.actionName) + '</div>' +
                '<div class="jobs-row-label">' + escapeHtml(a.label || '') + '</div>' +
            '</div>' +
            (showViewChat ?
                '<button class="jobs-row-btn" title="Show chat" onclick="event.stopPropagation();viewActionChat(\'' + escapeJsString(a.actionId) + '\')">' + UI_ICONS.chat + '</button>' +
                '<button class="jobs-row-btn danger" title="Dismiss" onclick="event.stopPropagation();dismissAction(\'' + escapeJsString(a.actionId) + '\')">' + UI_ICONS.close + '</button>'
                :
                '<button class="jobs-row-btn" title="Show chat" onclick="event.stopPropagation();viewActionChat(\'' + escapeJsString(a.actionId) + '\')">' + UI_ICONS.chat + '</button>' +
                '<button class="jobs-row-btn danger" title="Stop" onclick="event.stopPropagation();stopAction(\'' + escapeJsString(a.actionId) + '\')">' + UI_ICONS.stop + '</button>'
            ) +
        '</div>';
    }).join('');
    // Active list = chats running right now, OR still inside the post-finish
    // linger window, OR with an UNREAD finished response. A just-finished chat
    // lingers here (bold if unseen) for ACTIVE_CHAT_LINGER_MS; once that window
    // passes it KEEPS showing — regardless of age, even days old — as long as the
    // user still hasn't opened it (_isChatUnseen). It only leaves Active when the
    // user views it (clearing unseen) or removes it.
    var runningChats = chatList.filter(function(_rc) { return isChatBusy(_rc.id) || _isChatLingering(_rc.id) || _isChatUnseen(_rc.id); });
    var chatRowsHtml = runningChats.map(function(c) {
        // Silent after-response hooks (auto-title/tldr) keep runningChatIds set
        // for a few seconds after the visible answer — don't show "Running…"
        // (and suppress the unseen bell) for that window; the chat is done.
        var _cRunning = (isChatActivelyRunning(c.id) && !_isChatInSilentHook(c.id)) || chatHasRunningSubAgents(c.id);
        // B15: an errored, non-running chat shows an explicit error row (icon + msg)
        // and a Retry button instead of a green "Finished".
        var _cErr = !_cRunning && typeof chats !== 'undefined' && chats[c.id] && chats[c.id]._lastApiError;
        var _cApproval = (typeof chatHasPendingApproval === 'function') && chatHasPendingApproval(c.id);
        var _cState = _cApproval ? 'attention' : (_cRunning ? 'running' : (_cErr ? 'error' : 'done'));
        var _cIcon = '<span class="jobs-row-dot state-' + _cState + '"></span>';
        // Show the chat's current progress task under its title (latest
        // update_action_state: the running task label, falling back to the
        // progress label / status_message). Generic 'Running…' only when the
        // chat has reported no progress at all.
        var _cProg = (typeof getChatProgressStateFor === 'function') ? getChatProgressStateFor(c.id) : null;
        var _cTask = null;
        if (_cProg && Array.isArray(_cProg.tasks)) {
            for (var _ti = 0; _ti < _cProg.tasks.length; _ti++) {
                var _t = _cProg.tasks[_ti];
                if (_t && _t.status === 'running') { _cTask = _t.label; break; }
            }
        }
        var _cProgText = _cTask || (_cProg && (_cProg.label || _cProg.status_message)) || null;
        // Unseen: the chat got a response after the user last viewed it (the
        // focused chat is always seen) — flag it so the user knows to catch up.
        var _cUnseen = !_cRunning && !_cErr && c.lastResponseAt &&
            c.lastResponseAt > (c.lastViewedAt || 0) && !_isChatViewFocused(c.id);
        // Unread (bold) is BROADER than the bell: ANY activity — including on a
        // still-running or errored chat — the user hasn't viewed yet counts.
        var _cUnread = _cUnseen || _chatHasUnseenActivity(c.id);
        var _cLabel = _cApproval ? 'Awaiting approval' : (_cRunning ? (_cProgText ? escapeHtml(_cProgText) : 'Running\u2026') : (_cErr ? ('Error: ' + escapeHtml((chats[c.id]._lastApiError && chats[c.id]._lastApiError.message) || 'API error')) : (_cUnseen ? 'New response' : 'Finished')));
        if (_cUnseen) _cIcon = '<span class="jobs-row-bell">' + (UI_ICONS.bell || '') + '</span>';
        var _cCur = (typeof currentChatId !== 'undefined' && c.id === currentChatId) ? ' is-current' : '';
        // Unseen finished response → bold the title like an unread email (the
        // .jobs-unread CSS rule), until the user opens the chat.
        return '<div class="jobs-dropdown-row state-' + _cState + _cCur + (_cUnread ? ' jobs-unread' : '') + '" ' +
            'data-chat-id="' + escapeHtml(c.id) + '" ' +
            'onclick="toggleJobsRowAccordion(\'' + escapeJsString(c.id) + '\')">' +
            '<span class="jobs-row-icon">' + _cIcon + '</span>' +
            '<div class="jobs-row-main">' +
                '<div class="jobs-row-title">' + escapeHtml(c.title || 'New Chat') + '</div>' +
                '<div class="jobs-row-label">' + _cLabel + '</div>' +
            '</div>' +
            _jobsPinBtnHtml(c) +
            (typeof _contextCircleHtml === 'function' ? _contextCircleHtml(c.id, 'jobs-row-ctx', true) : '') +
            (_cErr ? '<button class="jobs-row-btn" title="Retry" onclick="event.stopPropagation();retryChat(\'' + escapeJsString(c.id) + '\')">' + (UI_ICONS.refresh || UI_ICONS.zap) + '</button>' : '') +
            _jobsRowButtons(c, _cUnseen || _cErr) +
        '</div>';
    }).join('');
    var html = '';
    // Active actions are treated like chats: they live in the same Active tab/list
    // (carrying their own action icon) rather than a separate "Active Actions"
    // section. Render them above the running chats and count them toward Active.
    // Tabbed chat panel: Active (running now) / Recent (24h) / Done (finished).
    html += _renderJobsChatTabs(rowsHtml + chatRowsHtml, runningChats.length + list.length);
    // The badge is always-on, so it can be opened with nothing to show (no
    // actions, no chats yet) — render a friendly empty state, not a blank box.
    if (!html) html = '<div class="jobs-dropdown-empty">No active or recent chats</div>';
    // Preserve any open inline progress accordions across this full re-render, so a
    // running action/chat the user expanded doesn't snap shut on every state tick
    // (and the restored body reflects the latest progress).
    var _openAccIds = [];
    try {
        dropdown.querySelectorAll('.jobs-row-accordion[data-acc-for]').forEach(function(el) {
            _openAccIds.push(el.getAttribute('data-acc-for'));
        });
    } catch (e) {}
    // Wrap in an inner flex column: the dropdown itself is toggled to inline
    // display:block when opened, which overrides the CSS flex container, so the
    // scroll panel needs its own flex parent with a bounded (100%) height.
    dropdown.innerHTML = '<div class="jobs-dd-inner">' + html + '</div>';
    _reopenJobsAccordions(dropdown, _openAccIds);
}
// Re-insert inline progress accordions for the given row ids after a full
// renderJobsDropdown (which wipes them via innerHTML). A chat row is keyed by
// data-chat-id, an action row by data-action-id — rebuild the matching body so
// the restored accordion also reflects the latest state.
function _reopenJobsAccordions(dropdown, ids) {
    if (!dropdown || !ids || !ids.length) return;
    ids.forEach(function(id) {
        var esc = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
        var isAction = false;
        var row = dropdown.querySelector('.jobs-dropdown-row[data-chat-id="' + esc + '"]');
        if (!row) { row = dropdown.querySelector('.jobs-dropdown-row[data-action-id="' + esc + '"]'); isAction = !!row; }
        if (!row) return;
        if (row.nextElementSibling && row.nextElementSibling.classList.contains('jobs-row-accordion')) return;
        var acc = document.createElement('div');
        acc.className = 'jobs-row-accordion';
        acc.setAttribute('data-acc-for', id);
        acc.innerHTML = isAction ? _jobsActionAccordionContentHtml(id) : _jobsAccordionContentHtml(id);
        row.parentNode.insertBefore(acc, row.nextSibling);
        row.classList.add('acc-open');
    });
}

// ---- Tabbed jobs dropdown helpers (Active / Recent / Done) ----------------
// All user (non-sub-agent, non-background) chats that have at least one message.
function _jobsAllUserChats() {
    var arr = [];
    if (typeof chats === 'undefined' || !chats) return arr;
    Object.keys(chats).forEach(function(cid) {
        var c = chats[cid];
        // Sub-agent transcripts live in the Workers strip — never here. Background
        // Action chats ARE included so finished Actions show under Completed Today /
        // Recent / Done (the user's "I completed others" case). A chat the user
        // removed from the list (_jobsHidden) is skipped unless it's pinned.
        if (!c || c.isSubAgent) return;
        if (c._jobsHidden && !c.pinned) return;
        if (!Array.isArray(c.messages) || !c.messages.length) return;
        arr.push(c);
    });
    return arr;
}
function _jobsChatTs(c) { return (c && (c.updatedAt || c.lastResponseAt || c.createdAt)) || 0; }
// Canonical row state: orange ('attention') when a tool-call approval is pending,
// green while actively running (not paused), red on error, 'unseen' (bell) for an
// unviewed finished response, else 'done'.
function _jobsChatState(chatId) {
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (typeof chatHasPendingApproval === 'function' && chatHasPendingApproval(chatId)) return 'attention';
    // A run that only executes silent after-response hooks counts as finished
    // for display — the user's answer is already there (see _silentHookChats).
    var running = (typeof isChatActivelyRunning === 'function') &&
        ((isChatActivelyRunning(chatId) && !_isChatInSilentHook(chatId)) || chatHasRunningSubAgents(chatId));
    var paused = (typeof isChatPaused === 'function') ? isChatPaused(chatId) : false;
    if (running && !paused) return 'running';
    if (c && c._lastApiError) return 'error';
    var _stLast = c ? Math.max(c.lastResponseAt || 0, c.lastActivityAt || 0) : 0;
    if (_stLast && _stLast > (c.lastViewedAt || 0) && !_isChatViewFocused(chatId)) return 'unseen';
    return 'done';
}
// Recent = non-empty chats touched in the last week (7 days), newest first,
// capped at 10.
function getRecentChatsList() {
    var now = Date.now(), win = 7 * 24 * 60 * 60 * 1000;
    return _jobsAllUserChats()
        .filter(function(c) { return (now - _jobsChatTs(c)) < win; })
        .sort(function(a, b) { return _jobsChatTs(b) - _jobsChatTs(a); })
        .slice(0, 10);
}
// Done = every finished (not currently running) non-empty chat, newest first.
function getDoneChatsList() {
    return _jobsAllUserChats()
        .filter(function(c) { return !isChatBusy(c.id); })
        .sort(function(a, b) { return _jobsChatTs(b) - _jobsChatTs(a); });
}
// Completed today = finished (not-running) chats whose last activity (updatedAt,
// falling back to lastResponseAt/createdAt) is since midnight. Using the same
// timestamp as Recent/Done so a chat that finished today is never missed because
// lastResponseAt happened to be unset.
function getCompletedTodayChats() {
    var start = new Date(); start.setHours(0, 0, 0, 0);
    var t0 = start.getTime();
    return _jobsAllUserChats()
        .filter(function(c) { return !isChatBusy(c.id) && !_isChatLingering(c.id) && !_isChatUnseen(c.id) && !c.pinned && _jobsChatTs(c) >= t0; })
        .sort(function(a, b) { return _jobsChatTs(b) - _jobsChatTs(a); });
}
// Pinned = chats the user pinned (chat.pinned), newest first. They surface in
// their own section (above Completed Today) regardless of age or state.
function getPinnedChatsList() {
    return _jobsAllUserChats()
        .filter(function(c) { return !!c.pinned; })
        .sort(function(a, b) { return _jobsChatTs(b) - _jobsChatTs(a); });
}
// Shared trailing button cluster for a chat row: pin toggle, optional
// dismiss-notification (only when the row carries an unseen/error flag),
// open-chat, and — for non-pinned rows — remove-from-list. Buttons stop
// propagation so the row's own click (accordion) doesn't also fire.
// Pin toggle button for a chat row — rendered separately, BEFORE the context
// circle, so rows read: pin → context spinner → trailing buttons.
function _jobsPinBtnHtml(c) {
    var idJs = escapeJsString(c.id);
    var pinned = !!c.pinned;
    return '<button class="jobs-row-btn jobs-pin-btn' + (pinned ? ' pinned' : '') + '" title="' + (pinned ? 'Unpin chat' : 'Pin chat') + '" onclick="event.stopPropagation();toggleJobsPin(\'' + idJs + '\')">' + (pinned ? UI_ICONS.pinFilled : UI_ICONS.pin) + '</button>';
}
function _jobsRowButtons(c, hasNotif, noDismiss) {
    var idJs = escapeJsString(c.id);
    var pinned = !!c.pinned;
    var h = '';
    if (hasNotif) {
        h += '<button class="jobs-row-btn" title="Dismiss notification" onclick="event.stopPropagation();dismissChatNotifications(\'' + idJs + '\')">' + (UI_ICONS.check || UI_ICONS.close) + '</button>';
    }
    h += '<button class="jobs-row-btn jobs-open-btn" title="Open chat" onclick="event.stopPropagation();openChatFromJobsDropdown(\'' + idJs + '\')">' + UI_ICONS.chat + '</button>';
    if (!pinned && !noDismiss) {
        h += '<button class="jobs-row-btn danger" title="Remove from list" onclick="event.stopPropagation();dismissChatFromJobs(\'' + idJs + '\')">' + UI_ICONS.close + '</button>';
    }
    return h;
}
// Trailing buttons for a 'Completed Today' row: pin toggle (hover-only) +
// open-chat (always visible). No dismiss/remove icon — Today rows aren't
// individually dismissable; they roll off on their own once no longer "today".
function _jobsTodayRowButtons(c) {
    var idJs = escapeJsString(c.id);
    var h = '';
    h += '<button class="jobs-row-btn jobs-open-btn" title="Open chat" onclick="event.stopPropagation();openChatFromJobsDropdown(\'' + idJs + '\')">' + UI_ICONS.chat + '</button>';
    return h;
}
// Time string for a Pinned / History / Recent row (relative time or short date).
function _jobsHistTimeStr(c) {
    var when = _jobsChatTs(c);
    return (when && typeof formatHistoryDate === 'function') ? formatHistoryDate(when) : '';
}
// Time string for a Completed-Today row ('Today, h:mm AM').
function _jobsTodayTimeStr(c) {
    var when = _jobsChatTs(c);
    if (!when) return '';
    try { return 'Today, ' + new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return ''; }
}
// Width (px) of the widest time string in a SECTION, so every row in that
// section shares one time-column width (no global static width) and the icons
// to the left of the time line up within the section. 0 when no times.
var _jobsTimeMeasureCtx = null;
function _jobsTimeColWidth(timeStrings) {
    var any = false, i;
    for (i = 0; i < timeStrings.length; i++) { if (timeStrings[i]) { any = true; break; } }
    if (!any) return 0;
    if (!_jobsTimeMeasureCtx) {
        try { _jobsTimeMeasureCtx = document.createElement('canvas').getContext('2d'); }
        catch (e) { _jobsTimeMeasureCtx = null; }
    }
    var ctx = _jobsTimeMeasureCtx, fam = 'sans-serif';
    try { fam = getComputedStyle(document.body).fontFamily || fam; } catch (e2) {}
    if (ctx) ctx.font = '11px ' + fam;
    var max = 0;
    for (i = 0; i < timeStrings.length; i++) {
        var s = timeStrings[i];
        if (!s) continue;
        var w = ctx ? ctx.measureText(s).width : s.length * 6.2;
        if (w > max) max = w;
    }
    // +2px guard: measureText ignores tabular-nums, which renders a hair wider.
    return max ? (Math.ceil(max) + 2) : 0;
}
// A '.jobs-row-time' span, optionally pinned to a section width (px).
function _jobsTimeSpan(timeStr, timeW) {
    if (!timeStr) return '';
    var style = (timeW && timeW > 0) ? ' style="width:' + timeW + 'px"' : '';
    return '<span class="jobs-row-time"' + style + '>' + escapeHtml(timeStr) + '</span>';
}
// A pinned chat row (Pinned section): pin indicator + title + time; row click
// expands the inline progress accordion (the bubble button opens the chat).
function _jobsPinnedRowHtml(c, timeW) {
    var st = _jobsChatState(c.id);
    var timeStr = _jobsHistTimeStr(c);
    var indicator = (st === 'unseen')
        ? '<span class="jobs-row-bell">' + (UI_ICONS.bell || '') + '</span>'
        : '<span class="jobs-row-pin-dot">' + UI_ICONS.pinFilled + '</span>';
    var cur = (typeof currentChatId !== 'undefined' && c.id === currentChatId) ? ' is-current' : '';
    return '<div class="jobs-dropdown-row jobs-chat-row jobs-pinned-row' + cur + ((st === 'unseen' || _chatHasUnseenActivity(c.id)) ? ' jobs-unread' : '') + '" ' +
        'data-chat-id="' + escapeHtml(c.id) + '" onclick="toggleJobsRowAccordion(\'' + escapeJsString(c.id) + '\')">' +
        indicator +
        '<div class="jobs-row-main"><div class="jobs-row-title">' + escapeHtml(c.title || 'New Chat') + '</div></div>' +
        _jobsPinBtnHtml(c) +
        (typeof _contextCircleHtml === 'function' ? _contextCircleHtml(c.id, 'jobs-row-ctx', true) : '') +
        _jobsRowButtons(c, st === 'unseen' || st === 'error') +
        _jobsTimeSpan(timeStr, timeW) +
    '</div>';
}
// A single Recent/Done chat row: status indicator + title + relative time + open
// btn. Indicator is a BELL for an unseen finished response, else a status dot
// (green running, orange awaiting a tool-call approval, red error, grey done).
function _jobsChatRowHtml(c, mode, timeW) {
    var st = _jobsChatState(c.id);
    var timeStr = _jobsHistTimeStr(c);
    var indicator = (st === 'unseen')
        ? '<span class="jobs-row-bell">' + (UI_ICONS.bell || '') + '</span>'
        : '<span class="jobs-row-dot state-' + st + '"></span>';
    var cur = (typeof currentChatId !== 'undefined' && c.id === currentChatId) ? ' is-current' : '';
    // No per-state row tint on Recent/Done rows — the status dot already conveys
    // state; only the current chat gets a highlight (.is-current).
    return '<div class="jobs-dropdown-row jobs-chat-row' + cur + ((st === 'unseen' || _chatHasUnseenActivity(c.id)) ? ' jobs-unread' : '') + '" ' +
        'data-chat-id="' + escapeHtml(c.id) + '" onclick="toggleJobsRowAccordion(\'' + escapeJsString(c.id) + '\')">' +
        indicator +
        '<div class="jobs-row-main">' +
            '<div class="jobs-row-title">' + escapeHtml(c.title || 'New Chat') + '</div>' +
        '</div>' +
        _jobsPinBtnHtml(c) +
        (typeof _contextCircleHtml === 'function' ? _contextCircleHtml(c.id, 'jobs-row-ctx', true) : '') +
        _jobsRowButtons(c, st === 'unseen' || st === 'error', true) +
        _jobsTimeSpan(timeStr, timeW) +
    '</div>';
}
// A 'Completed Today' row: check icon + title + 'Today, h:mm AM'.
function _jobsTodayRowHtml(c, timeW) {
    var timeStr = _jobsTodayTimeStr(c);
    var st = _jobsChatState(c.id);
    // Unread = a finished response the user hasn't opened yet. Show a bell + bold
    // title (like an unread email) until they view the chat; otherwise a green check.
    var _unread = (st === 'unseen') || _chatHasUnseenActivity(c.id);
    var _todayIndicator = _unread
        ? '<span class="jobs-row-bell">' + (UI_ICONS.bell || '') + '</span>'
        : '<span class="jobs-row-check">' + (UI_ICONS.check || '') + '</span>';
    // Highlight the row for the chat the user is currently viewing (.is-current),
    // matching the Active / Pinned / Recent / History rows.
    var cur = (typeof currentChatId !== 'undefined' && c.id === currentChatId) ? ' is-current' : '';
    return '<div class="jobs-dropdown-row jobs-today-row' + cur + (_unread ? ' jobs-unread' : '') + '" ' +
        'data-chat-id="' + escapeHtml(c.id) + '" onclick="toggleJobsRowAccordion(\'' + escapeJsString(c.id) + '\')">' +
        _todayIndicator +
        '<div class="jobs-row-main">' +
            '<div class="jobs-row-title">' + escapeHtml(c.title || 'New Chat') + '</div>' +
        '</div>' +
        _jobsPinBtnHtml(c) +
        (typeof _contextCircleHtml === 'function' ? _contextCircleHtml(c.id, 'jobs-row-ctx', true) : '') +
        _jobsTodayRowButtons(c) +
        _jobsTimeSpan(timeStr, timeW) +
    '</div>';
}
// Build the header + Active/Recent/Done tabs + panels + footer. Returns '' when
// there are no chats to show at all (keeps the dropdown clean for action-only runs).
function _renderJobsChatTabs(activeRowsHtml, activeCount) {
    var doneChats = getDoneChatsList();
    var todayChats = getCompletedTodayChats();
    var pinnedChats = getPinnedChatsList();
    if (!activeCount && !doneChats.length && !pinnedChats.length) return '';
    var activePanel = (activeRowsHtml && activeRowsHtml.length) ? activeRowsHtml
        : '<div class="jobs-tab-empty">No chats running right now</div>';
    var pinnedHtml = '';
    // Don't duplicate a pinned chat that is ALSO in the Active list above — it
    // already shows there (with a filled pin button). The Active list now keeps
    // busy, lingering AND unread chats, so mirror that exact predicate here.
    var pinnedToShow = pinnedChats.filter(function(c) { return !isChatBusy(c.id) && !_isChatLingering(c.id) && !_isChatUnseen(c.id); });
    if (pinnedToShow.length) {
        var _pinW = _jobsTimeColWidth(pinnedToShow.map(_jobsHistTimeStr));
        pinnedHtml = '<div class="jobs-subhead jobs-subhead-pinned">Pinned</div>' +
            pinnedToShow.map(function(c) { return _jobsPinnedRowHtml(c, _pinW); }).join('');
    }
    var todayHtml = '';
    if (todayChats.length) {
        var _todayW = _jobsTimeColWidth(todayChats.map(_jobsTodayTimeStr));
        todayHtml = '<div class="jobs-subhead">Completed Today</div>' +
            todayChats.map(function(c) { return _jobsTodayRowHtml(c, _todayW); }).join('');
    }
    var h = '';
    h += '<div class="jobs-panel-head">' +
            '<span class="jobs-panel-title">Active Chats</span>' +
            '<span class="jobs-panel-expand" onclick="expandJobsDropdown()" title="Expand to full screen">Expand <svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></span>' +
        '</div>';
    h += '<div class="jobs-tabs" role="tablist">' +
            '<button class="jobs-tab active" data-tab="active" onclick="switchJobsTab(\'active\')">Active<span class="jobs-tab-count">' + activeCount + '</span></button>' +
            '<button class="jobs-tab" data-tab="done" onclick="switchJobsTab(\'done\')">History<span class="jobs-tab-count">' + doneChats.length + '</span></button>' +
        '</div>';
    h += '<div class="jobs-tab-panel jobs-dropdown-list" data-tab-panel="active">' + activePanel + pinnedHtml + todayHtml + '</div>';
    h += '<div class="jobs-tab-panel jobs-dropdown-list" data-tab-panel="done" style="display:none">' +
            _renderJobsHistoryPanel(doneChats) + '</div>';
    return h;
}
// ---- History panel: quick-search + Today/This Week/This Month grouping ------
// History (formerly 'Done') panel: a quick-search box above the finished chats,
// which are grouped under Today / This Week / This Month / Older subheads. The
// search mirrors the full History view (matches title + message/tool content via
// chatMatchesSearch) but filters only these History rows.
var _jobsHistoryQuery = '';
function _renderJobsHistoryPanel(doneChats) {
    _ensureJobsHistorySearchBound();
    var searchVal = escapeHtml(_jobsHistoryQuery || '');
    var bar = '<div class="jobs-history-search">' +
        '<span class="jobs-history-search-icon">' + (UI_ICONS.search || '') + '</span>' +
        '<input type="text" id="jobs-history-search-input" class="jobs-history-search-input" ' +
            'placeholder="Search history\u2026" value="' + searchVal + '" ' +
            'autocomplete="off" aria-label="Search history chats" />' +
        (searchVal ? '<button type="button" class="jobs-history-search-clear" title="Clear search" aria-label="Clear search">\u00d7</button>' : '') +
    '</div>';
    return bar + '<div class="jobs-history-results">' + _renderJobsHistoryResults(doneChats) + '</div>';
}
// Bind (once) the History quick-search via event delegation on document. The
// search input + clear button are re-created on every dropdown render, so a
// delegated listener is more reliable than per-element inline handlers.
var _jobsHistorySearchBound = false;
function _ensureJobsHistorySearchBound() {
    if (_jobsHistorySearchBound) return;
    _jobsHistorySearchBound = true;
    document.addEventListener('input', function(e) {
        var t = e.target;
        if (t && t.id === 'jobs-history-search-input') onJobsHistorySearch(t.value);
    });
    document.addEventListener('click', function(e) {
        var t = e.target;
        if (t && t.closest && t.closest('.jobs-history-search-clear')) {
            e.stopPropagation();
            e.preventDefault();
            clearJobsHistorySearch();
        }
    });
}
// Build the grouped (Today / This Week / This Month / Older) History rows,
// honoring the current quick-search query. doneChats is optional — recomputed
// from getDoneChatsList() when omitted (e.g. on a search-only re-render).
function _renderJobsHistoryResults(doneChats) {
    var chatsArr = doneChats || (typeof getDoneChatsList === 'function' ? getDoneChatsList() : []);
    var q = (_jobsHistoryQuery || '').trim();
    if (q.length >= 2 && typeof chatMatchesSearch === 'function') {
        chatsArr = chatsArr.filter(function(c) { return chatMatchesSearch(c, q); });
    }
    if (!chatsArr.length) {
        return '<div class="jobs-tab-empty">' + (q ? 'No matching chats' : 'No finished chats') + '</div>';
    }
    return _renderJobsGroupedRows(chatsArr, 'history');
}
// Group chat rows under date subheads. mode 'history' => Today / This Week /
// This Month / Older; mode 'recent' => Today / This Week (everything not-today
// folds into This Week, since the Recent list is already capped to ~1 week).
// Rolling windows relative to midnight today, so "This Week" is never empty by
// construction the way a Monday-anchored calendar week would be.
function _renderJobsGroupedRows(chatsArr, mode) {
    if (!chatsArr || !chatsArr.length) return '';
    var t0 = new Date(); t0.setHours(0, 0, 0, 0); t0 = t0.getTime();
    var weekAgo = t0 - 7 * 86400000;
    var monthAgo = t0 - 30 * 86400000;
    var groups, order;
    if (mode === 'recent') {
        groups = { today: [], week: [] };
        chatsArr.forEach(function(c) {
            if (_jobsChatTs(c) >= t0) groups.today.push(c); else groups.week.push(c);
        });
        order = [['today', 'Today'], ['week', 'This Week']];
    } else {
        groups = { today: [], week: [], month: [], older: [] };
        chatsArr.forEach(function(c) {
            var ts = _jobsChatTs(c);
            if (ts >= t0) groups.today.push(c);
            else if (ts >= weekAgo) groups.week.push(c);
            else if (ts >= monthAgo) groups.month.push(c);
            else groups.older.push(c);
        });
        order = [['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['older', 'Older']];
    }
    var h = '';
    order.forEach(function(g) {
        var arr = groups[g[0]];
        if (!arr.length) return;
        var _gw = _jobsTimeColWidth(arr.map(_jobsHistTimeStr));
        h += '<div class="jobs-subhead">' + g[1] + '</div>' +
            arr.map(function(c) { return _jobsChatRowHtml(c, 'list', _gw); }).join('');
    });
    return h;
}
// Quick-search input handler: re-render ONLY the results list so the input keeps
// focus while the user types.
function onJobsHistorySearch(val) {
    _jobsHistoryQuery = val || '';
    var dd = (typeof _getOpenJobsDropdown === 'function' && _getOpenJobsDropdown()) ||
             (typeof _getVisibleJobsDropdown === 'function' && _getVisibleJobsDropdown());
    if (!dd) return;
    var results = dd.querySelector('.jobs-history-results');
    if (results) results.innerHTML = _renderJobsHistoryResults();
    var bar = dd.querySelector('.jobs-history-search');
    if (!bar) return;
    var clearBtn = bar.querySelector('.jobs-history-search-clear');
    if (_jobsHistoryQuery && !clearBtn) {
        clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'jobs-history-search-clear';
        clearBtn.title = 'Clear search';
        clearBtn.setAttribute('aria-label', 'Clear search');
        clearBtn.textContent = '\u00d7';
        bar.appendChild(clearBtn);
    } else if (!_jobsHistoryQuery && clearBtn) {
        clearBtn.parentNode.removeChild(clearBtn);
    }
}
function clearJobsHistorySearch() {
    _jobsHistoryQuery = '';
    var dd = (typeof _getOpenJobsDropdown === 'function' && _getOpenJobsDropdown()) ||
             (typeof _getVisibleJobsDropdown === 'function' && _getVisibleJobsDropdown());
    if (!dd) return;
    var input = dd.querySelector('#jobs-history-search-input');
    if (input) { input.value = ''; input.focus(); }
    var results = dd.querySelector('.jobs-history-results');
    if (results) results.innerHTML = _renderJobsHistoryResults();
    var bar = dd.querySelector('.jobs-history-search');
    var clearBtn = bar && bar.querySelector('.jobs-history-search-clear');
    if (clearBtn) clearBtn.parentNode.removeChild(clearBtn);
}
// Switch the visible tab panel within the open jobs dropdown.
function switchJobsTab(tabName) {
    var dd = (typeof _getOpenJobsDropdown === 'function' && _getOpenJobsDropdown()) ||
             (typeof _getVisibleJobsDropdown === 'function' && _getVisibleJobsDropdown());
    if (!dd) return;
    var tabs = dd.querySelectorAll('.jobs-tab');
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tabName);
    }
    var panels = dd.querySelectorAll('.jobs-tab-panel');
    for (var j = 0; j < panels.length; j++) {
        panels[j].style.display = (panels[j].getAttribute('data-tab-panel') === tabName) ? '' : 'none';
    }
}
// 'View all' / footer: jump to the full History view.
function openHistoryFromJobsDropdown() {
    if (typeof closeJobsDropdown === 'function') closeJobsDropdown();
    if (typeof openHistoryView === 'function') openHistoryView();
}

// ---- Expand: centered modal of active chats as live progress cards --------
// The jobs dropdown's 'Expand' control opens a centered modal that mirrors the
// dropdown's Active view as three fixed columns — Active, Completed Today and
// Pinned — each stacking its chats as cards showing title + live progress. Kept real-time
// by a 1s polling refresh (diffed, so it only repaints on change) plus the
// renderJobsBadge -> _refreshJobsExpandModal event hook.
var _jobsExpandTimer = null;
function expandJobsDropdown() {
    // Drop the small dropdown — the modal replaces it.
    if (typeof closeJobsDropdown === 'function') { try { closeJobsDropdown(); } catch (e) {} }
    if (document.getElementById('jobs-expand-overlay')) { renderJobsExpandModal(); return; }
    var overlay = document.createElement('div');
    overlay.id = 'jobs-expand-overlay';
    overlay.className = 'jobs-expand-overlay';
    // Click on the backdrop (not the modal) closes it.
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeJobsExpandModal(); });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', _jobsExpandEscHandler, true);
    renderJobsExpandModal();
    // Real-time progress: poll while the modal is open. renderJobsExpandModal
    // diffs its HTML and only repaints on change, so this stays cheap + flicker-free.
    if (_jobsExpandTimer) clearInterval(_jobsExpandTimer);
    _jobsExpandTimer = setInterval(function() {
        if (!document.getElementById('jobs-expand-overlay')) { clearInterval(_jobsExpandTimer); _jobsExpandTimer = null; return; }
        try { renderJobsExpandModal(); } catch (e) {}
    }, 1000);
}
// Layout preference for the expand modal: 'columns' (kanban, like the
// dropdown) or 'sections' (stacked sections — Active first with all its cards
// in a 2-per-row grid, then the next section). Persisted across sessions.
function _getJobsExpandLayout() {
    try { if (localStorage.getItem('jobs_expand_layout') === 'sections') return 'sections'; } catch (e) {}
    return 'columns';
}
function setJobsExpandLayout(mode) {
    try { localStorage.setItem('jobs_expand_layout', mode === 'sections' ? 'sections' : 'columns'); } catch (e) {}
    renderJobsExpandModal();
}
function _jobsExpandEscHandler(e) {
    if (e && e.key === 'Escape') { e.stopPropagation(); closeJobsExpandModal(); }
}
function closeJobsExpandModal() {
    var overlay = document.getElementById('jobs-expand-overlay');
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener('keydown', _jobsExpandEscHandler, true);
    if (_jobsExpandTimer) { clearInterval(_jobsExpandTimer); _jobsExpandTimer = null; }
}
// Re-render the open expand modal in place (preserving scroll) so progress
// content stays live while chats run. No-op when the modal isn't open.
function _refreshJobsExpandModal() {
    if (document.getElementById('jobs-expand-overlay')) {
        try { renderJobsExpandModal(); } catch (e) {}
    }
}
function renderJobsExpandModal() {
    var overlay = document.getElementById('jobs-expand-overlay');
    if (!overlay) return;
    var prevBody = overlay.querySelector('.jobs-expand-body');
    var prevScroll = prevBody ? prevBody.scrollTop : 0;
    // Each column scrolls on its own now, so snapshot per-column scroll (by
    // index — column order is stable) to restore it after the live repaint.
    var prevColScroll = [];
    overlay.querySelectorAll('.jobs-expand-col-cards').forEach(function(el, i) { prevColScroll[i] = el.scrollTop; });
    // Card bodies scroll too (progress content, max-height capped). Snapshot
    // their scrollTop keyed by chat id so a live repaint doesn't yank the user
    // back to the top of the card they were reading.
    var prevCardScroll = {};
    overlay.querySelectorAll('.jobs-expand-card').forEach(function(cardEl) {
        var cid = cardEl.getAttribute('data-chat-id');
        var bodyEl = cardEl.querySelector('.jobs-expand-card-body');
        if (cid && bodyEl && bodyEl.scrollTop) prevCardScroll[cid] = bodyEl.scrollTop;
    });
    var chatList = (typeof getActiveChatsList === 'function') ? getActiveChatsList() : [];
    // Source the same three buckets as the dropdown's Active view. Dedupe so a
    // pinned-but-lingering chat only shows once (under Active). The modal then
    // renders them as columns in the order Active → Completed Today → Pinned.
    var activeChats = chatList.filter(function(c) { return isChatBusy(c.id) || _isChatLingering(c.id) || _isChatUnseen(c.id); });
    var activeIds = {};
    activeChats.forEach(function(c) { activeIds[c.id] = true; });
    var pinnedChats = (typeof getPinnedChatsList === 'function' ? getPinnedChatsList() : [])
        .filter(function(c) { return !isChatBusy(c.id) && !activeIds[c.id]; });
    var todayChats = (typeof getCompletedTodayChats === 'function') ? getCompletedTodayChats() : [];
    var total = activeChats.length + pinnedChats.length + todayChats.length;
    var closeIcon = UI_ICONS.close || '\u00d7';
    var layout = _getJobsExpandLayout();
    // Three fixed columns side by side — Active, then Completed Today, then
    // Pinned (kanban-style). Each column keeps its own header and stacks its
    // cards vertically. Empty columns still render (with a placeholder) so the
    // layout stays stable as chats move between buckets.
    function column(label, arr) {
        var cards = arr.length
            ? arr.map(function(c) { return _jobsExpandCardHtml(c); }).join('')
            : '<div class="jobs-expand-col-empty">None</div>';
        return '<div class="jobs-expand-column">' +
            '<div class="jobs-expand-subhead">' + escapeHtml(label) +
                ' <span class="jobs-expand-col-count">' + arr.length + '</span></div>' +
            '<div class="jobs-expand-col-cards">' + cards + '</div>' +
        '</div>';
    }
    // Sections layout: each bucket becomes a full-width section (Active first),
    // its cards laid out in a grid of at most two per row. Empty sections are
    // skipped — the section list flows vertically and the whole body scrolls.
    function section(label, arr) {
        if (!arr.length) return '';
        return '<div class="jobs-expand-section">' +
            '<div class="jobs-expand-subhead">' + escapeHtml(label) +
                ' <span class="jobs-expand-col-count">' + arr.length + '</span></div>' +
            '<div class="jobs-expand-section-cards">' +
                arr.map(function(c) { return _jobsExpandCardHtml(c); }).join('') +
            '</div>' +
        '</div>';
    }
    var body;
    if (!total) {
        body = '<div class="jobs-expand-empty">No active chats right now</div>';
    } else if (layout === 'sections') {
        body = '<div class="jobs-expand-sections">' +
            section('Active', activeChats) +
            section('Completed Today', todayChats) +
            section('Pinned', pinnedChats) +
        '</div>';
    } else {
        body = '<div class="jobs-expand-columns">' +
            column('Active', activeChats) +
            column('Completed Today', todayChats) +
            column('Pinned', pinnedChats) +
        '</div>';
    }
    // Header toggle: switch between the kanban columns view and the stacked
    // sections view. Rendered as a two-button segmented control.
    var colIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="5" height="16" rx="1"></rect><rect x="9.5" y="4" width="5" height="16" rx="1"></rect><rect x="16" y="4" width="5" height="16" rx="1"></rect></svg>';
    var secIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1"></rect><rect x="3" y="14" width="18" height="7" rx="1"></rect></svg>';
    var layoutToggle = '<div class="jobs-expand-layout-toggle" role="group" aria-label="Card layout">' +
        '<button class="jobs-expand-layout-btn' + (layout === 'columns' ? ' active' : '') + '" title="Column view" aria-label="Column view" onclick="setJobsExpandLayout(\'columns\')">' + colIcon + '</button>' +
        '<button class="jobs-expand-layout-btn' + (layout === 'sections' ? ' active' : '') + '" title="Section view" aria-label="Section view" onclick="setJobsExpandLayout(\'sections\')">' + secIcon + '</button>' +
    '</div>';
    var html =
        '<div class="jobs-expand-modal" role="dialog" aria-label="Active chats">' +
            '<div class="jobs-expand-head">' +
                '<span class="jobs-expand-title">Active Chats</span>' +
                '<span class="jobs-expand-count">' + total + '</span>' +
                layoutToggle +
                '<button class="jobs-expand-close" aria-label="Close" onclick="closeJobsExpandModal()">' + closeIcon + '</button>' +
            '</div>' +
            '<div class="jobs-expand-body' + (layout === 'sections' ? ' layout-sections' : '') + '">' + body + '</div>' +
        '</div>';
    // Diff: skip the repaint (and its flicker) when nothing changed.
    if (overlay._jobsLastHtml === html) {
        if (prevBody) prevBody.scrollTop = prevScroll;
        return;
    }
    overlay._jobsLastHtml = html;
    overlay.innerHTML = html;
    var newBody = overlay.querySelector('.jobs-expand-body');
    if (newBody) newBody.scrollTop = prevScroll;
    overlay.querySelectorAll('.jobs-expand-col-cards').forEach(function(el, i) {
        if (prevColScroll[i] != null) el.scrollTop = prevColScroll[i];
    });
    overlay.querySelectorAll('.jobs-expand-card').forEach(function(cardEl) {
        var cid = cardEl.getAttribute('data-chat-id');
        if (cid && prevCardScroll[cid] != null) {
            var bodyEl = cardEl.querySelector('.jobs-expand-card-body');
            if (bodyEl) bodyEl.scrollTop = prevCardScroll[cid];
        }
    });
}
// One active chat as a card: status indicator + title + open button, with the
// chat's progress content (label / status / tasks / output) as the card body.
function _jobsExpandCardHtml(c) {
    var st = (typeof _jobsChatState === 'function') ? _jobsChatState(c.id) : 'done';
    var indicator = (st === 'unseen')
        ? '<span class="jobs-row-bell">' + (UI_ICONS.bell || '') + '</span>'
        : '<span class="jobs-row-dot state-' + st + '"></span>';
    var cur = (typeof currentChatId !== 'undefined' && c.id === currentChatId) ? ' is-current' : '';
    var idJs = escapeJsString(c.id);
    // Progress only in the scrollable body — sub-agent rows live in a drawer
    // docked INSIDE the card but BELOW the body scroll, so they stay visible
    // while the progress scrolls, and expand on their own via the delegated
    // data-worker-toggle listener.
    var prog = (typeof getChatProgressStateFor === 'function') ? getChatProgressStateFor(c.id) : null;
    var workers = (typeof _jobsAccWorkersHtml === 'function') ? _jobsAccWorkersHtml(c.id) : '';
    return '<div class="jobs-expand-card' + cur + ((st === 'unseen' || _chatHasUnseenActivity(c.id)) ? ' jobs-unread' : '') + '" data-chat-id="' + escapeHtml(c.id) + '">' +
        '<div class="jobs-expand-card-head">' +
            indicator +
            '<div class="jobs-expand-card-title">' + escapeHtml(c.title || 'New Chat') + '</div>' +
            (typeof _contextCircleHtml === 'function' ? _contextCircleHtml(c.id, 'jobs-row-ctx', true) : '') +
            '<button class="jobs-row-btn" title="Open chat" onclick="event.stopPropagation();openChatFromExpand(\'' + idJs + '\')">' + UI_ICONS.chat + '</button>' +
        '</div>' +
        '<div class="jobs-expand-card-body">' + _jobsAccordionBodyHtml(prog) + '</div>' +
        (workers ? '<div class="jobs-expand-card-workers" data-workers-for="' + escapeHtml(c.id) + '">' + workers + '</div>' : '') +
    '</div>';
}
// Open a chat from an expand-modal card: close the modal, then navigate (which
// also marks the chat seen, clearing its unread/bold state).
function openChatFromExpand(chatId) {
    closeJobsExpandModal();
    if (typeof openChatFromJobsDropdown === 'function') openChatFromJobsDropdown(chatId);
}
// Accordion: toggle an inline progress panel right under the clicked chat row
// (inside the dropdown) instead of a floating popover. One open at a time;
// clicking the same row again collapses it. The chat-icon button still opens
// the chat (it stops propagation so this row handler doesn't fire).
function toggleJobsRowAccordion(chatId) {
    var dd = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
    if (!dd) return;
    var sel = (window.CSS && CSS.escape) ? CSS.escape(chatId) : chatId;
    var rows = dd.querySelectorAll('.jobs-dropdown-row[data-chat-id="' + sel + '"]');
    var row = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].offsetParent !== null) { row = rows[i]; break; }
    }
    if (!row) row = rows[0];
    if (!row) return;
    // Toggle off if this row's accordion is already open.
    var nx = row.nextElementSibling;
    if (nx && nx.classList.contains('jobs-row-accordion') && nx.getAttribute('data-acc-for') === chatId) {
        nx.parentNode.removeChild(nx);
        row.classList.remove('acc-open');
        return;
    }
    // Multiple accordions may stay open at once — each row toggles only its own.
    var acc = document.createElement('div');
    acc.className = 'jobs-row-accordion';
    acc.setAttribute('data-acc-for', chatId);
    acc.innerHTML = _jobsAccordionContentHtml(chatId);
    row.parentNode.insertBefore(acc, row.nextSibling);
    row.classList.add('acc-open');
}
// Action-row variant of toggleJobsRowAccordion: toggles an inline progress
// accordion directly below the action row (keyed on data-action-id) so an action
// behaves like a chat row instead of opening a popover.
function toggleJobsActionAccordion(actionId) {
    var dd = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
    if (!dd) return;
    var sel = (window.CSS && CSS.escape) ? CSS.escape(actionId) : actionId;
    var rows = dd.querySelectorAll('.jobs-dropdown-row[data-action-id="' + sel + '"]');
    var row = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].offsetParent !== null) { row = rows[i]; break; }
    }
    if (!row) row = rows[0];
    if (!row) return;
    // Toggle off if this row's accordion is already open.
    var nx = row.nextElementSibling;
    if (nx && nx.classList.contains('jobs-row-accordion') && nx.getAttribute('data-acc-for') === actionId) {
        nx.parentNode.removeChild(nx);
        row.classList.remove('acc-open');
        return;
    }
    var acc = document.createElement('div');
    acc.className = 'jobs-row-accordion';
    acc.setAttribute('data-acc-for', actionId);
    acc.innerHTML = _jobsActionAccordionContentHtml(actionId);
    row.parentNode.insertBefore(acc, row.nextSibling);
    row.classList.add('acc-open');
}
// Build the inline progress content for a chat's accordion (label, status,
// done/error output, task checklist) — mirrors the progress popover body.
function _jobsAccordionContentHtml(chatId) {
    var current = (typeof getChatProgressStateFor === 'function') ? getChatProgressStateFor(chatId) : null;
    var html = _jobsAccordionBodyHtml(current);
    // After the chat's own progress, list its sub-agents using the SAME worker
    // card component the parent-chat sidebar Workers panel uses (robot icon,
    // live tool-call counter, context ring). Each card is click-to-expand to
    // reveal that sub's progress — the document-level delegated listener in
    // 175-sub-agent-ui.js (data-worker-toggle) drives it here too.
    var workers = _jobsAccWorkersHtml(chatId);
    if (workers) html += '<div class="jobs-acc-workers">' + workers + '</div>';
    return html;
}
// Sub-agents header + worker-card list for a chat, or '' when it has none.
// Shared by the dropdown accordion (inline, inside .jobs-acc-workers) and the
// expand modal (as a docked drawer under the card).
function _jobsAccWorkersHtml(chatId) {
    if (typeof subAgentsForChatTree !== 'function' || typeof _workerCardHtml !== 'function') return '';
    var subs = subAgentsForChatTree(chatId);
    if (!subs.length) return '';
    return '<div class="jobs-acc-workers-header">Sub-agents (' + subs.length + ')</div>' +
        '<div class="jobs-acc-workers-list">' + subs.map(_workerCardHtml).join('') + '</div>';
}
// Inline progress for an action row's accordion — mirrors a chat row. Prefers the
// live update_action_state progress from the action's background chat, falling
// back to the action's own mirrored fields (a just-started action whose chat has
// not executed an update yet).
function _jobsActionAccordionContentHtml(actionId) {
    var a = (typeof activeActions !== 'undefined') ? activeActions[actionId] : null;
    if (!a) return '<div class="jobs-acc-empty">No progress reported yet</div>';
    var current = (a.chatId && typeof getChatProgressStateFor === 'function') ? getChatProgressStateFor(a.chatId) : null;
    if (!current) {
        current = { state: a.state, label: a.label, status_message: a.status_message, tasks: a.tasks, output: a.output };
    }
    return _jobsAccordionBodyHtml(current);
}
// Shared inline-progress body for chat-row and action-row accordions. `current`
// is a {state,label,status_message,tasks,output} snapshot or null.
function _jobsAccordionBodyHtml(current) {
    if (!current) return '<div class="jobs-acc-empty">No progress reported yet</div>';
    var s = current.state || 'running';
    var headHtml = current.label ? '<div class="jobs-acc-label">' + escapeHtml(current.label) + '</div>' : '';
    var statusHtml = current.status_message ? '<div class="jobs-acc-status">' + escapeHtml(current.status_message) + '</div>' : '';
    var tasksHtml = '';
    if (Array.isArray(current.tasks) && current.tasks.length) {
        tasksHtml = '<div class="action-result-tasks">' +
            current.tasks.map(function(t) {
                var icn = t.status === 'done' ? UI_ICONS.check :
                          (t.status === 'error' ? UI_ICONS.close :
                          (t.status === 'running' ? UI_ICONS.spinner : UI_ICONS.clock));
                return '<div class="action-task status-' + escapeHtml(t.status || 'pending') + '">' +
                    '<span class="action-task-icon">' + icn + '</span>' +
                    '<span class="action-task-label">' + escapeHtml(t.label || '') + '</span>' +
                '</div>';
            }).join('') +
        '</div>';
    }
    var outputHtml = '';
    if (current.output && (s === 'done' || s === 'error')) {
        var bs = String.fromCharCode(92);
        var normalized = String(current.output).split(bs + 'n').join('\n').split(bs + 't').join('\t');
        var rendered = (typeof formatContent === 'function') ? formatContent(normalized) : escapeHtml(normalized);
        outputHtml = '<div class="action-result-output markdown-body">' + rendered + '</div>';
    }
    if (!headHtml && !statusHtml && !tasksHtml && !outputHtml) {
        return '<div class="jobs-acc-empty">No progress reported yet</div>';
    }
    return headHtml + statusHtml + outputHtml + tasksHtml;
}

function onJobsDropdownRowClick(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    // Prompt / approval states keep their dedicated interactive popovers — an
    // inline accordion can't host the response UI.
    if (a.state === 'needs_input') { openPendingPromptForAction(actionId); return; }
    if (a.state === 'needs_permission') {
        var ddEl = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
        var rowEl = ddEl
            ? ddEl.querySelector('.jobs-dropdown-row[data-action-id="' + actionId + '"]')
            : document.querySelector('.jobs-dropdown-row[data-action-id="' + actionId + '"]');
        var anchor = ddEl || rowEl;
        if (anchor) openPendingApprovalForActionInline(anchor, actionId);
        return;
    }
    // Progress states (running / stuck / done / error / stopped): toggle an inline
    // accordion below the row showing the action's progress — just like a chat row.
    toggleJobsActionAccordion(actionId);
}

// Keep the old function name for backward compat with any lingering callers
function openPendingApprovalForAction(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    var btn = document.querySelector('.action-btn[data-skill-id="' + a.skillId + '"][data-action-name="' + a.actionName + '"]');
    if (btn) openPendingApprovalForActionInline(btn, actionId);
}

function viewActionChat(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    if (typeof selectChat === 'function' && chats[a.chatId]) {
        chats[a.chatId]._revealed = true;
        // Persist the reveal flag immediately — don't rely on selectChat to save it.
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        selectChat(a.chatId);
    }
    closeJobsDropdown();
}

// Click handler for an 'Active Chats' dropdown row: show that chat's progress
// in a popover anchored to the open dropdown WITHOUT navigating away from the
// current page. If the chat has no update_action_state progress yet, show a
// 'No progress' popover instead. Only the chat-bubble button
// (openChatFromJobsDropdown) opens the chat.
function onJobsDropdownChatRowClick(chatId) {
    var dropdownEl = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
    var rowEl = dropdownEl
        ? dropdownEl.querySelector('.jobs-dropdown-row[data-chat-id="' + chatId + '"]')
        : document.querySelector('.jobs-dropdown-row[data-chat-id="' + chatId + '"]');
    var anchor = dropdownEl || rowEl;
    if (!anchor) return;
    // Toggle: a second click on the same row dismisses its open popover.
    // (_resultPopoverOutside ignores clicks inside the open dropdown, so the
    // popover is still open when this onclick runs.)
    if (_resultPopover && _resultPopover.dataset.popoverType === 'chat-progress' &&
        _resultPopover.dataset.chatId === chatId) {
        closeResultPopover();
        return;
    }
    var progress = (typeof getChatProgressStateFor === 'function') ? getChatProgressStateFor(chatId) : null;
    if (progress) {
        try { openChatProgressPopover(anchor, null, chatId); }
        catch (e) { closeResultPopover(); }
    } else {
        openNoProgressPopover(anchor, chatId);
    }
}

// 'No progress' popover for an Active Chats row whose chat never called
// update_action_state. Same styling + dataset tags as the chat-progress
// popover so the row-click toggle and outside-click dismissal behave the same.
function openNoProgressPopover(anchor, chatId) {
    var anchorRect = _captureAnchorRect(anchor);
    closeResultPopover();
    if (typeof _hideTooltip === 'function') _hideTooltip();
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    var el = document.createElement('div');
    el.className = 'action-result-popover state-running';
    el.innerHTML =
        '<div class="action-result-header">' +
            '<span class="action-result-icon">' + (UI_ICONS.list || UI_ICONS.chat || '') + '</span>' +
            '<div class="action-result-title">' +
                '<div class="action-result-name">' + escapeHtml((c && c.title) || 'New Chat') + '</div>' +
                '<div class="action-result-label">No progress reported yet</div>' +
            '</div>' +
            '<button class="action-result-close" aria-label="Close" onclick="closeResultPopover()">' + UI_ICONS.close + '</button>' +
        '</div>';
    el.dataset.popoverType = 'chat-progress';
    el.dataset.chatId = chatId || '';
    document.body.appendChild(el);
    _resultPopover = el;
    _positionPopover(el, anchorRect);
    setTimeout(function() { document.addEventListener('click', _resultPopoverOutside, true); }, 0);
}

// Open (navigate to) a chat from its Active Chats dropdown row — triggered by
// the chat-bubble button only. Mirrors viewActionChat.
function openChatFromJobsDropdown(chatId) {
    if (typeof selectChat === 'function' && typeof chats !== 'undefined' && chats[chatId]) {
        if (chats[chatId].isBackground) chats[chatId]._revealed = true;
        // Opening a chat you previously removed from the list brings it back.
        if (chats[chatId]._jobsHidden) delete chats[chatId]._jobsHidden;
        // Persist the reveal flag immediately — don't rely on selectChat to save it.
        if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        selectChat(chatId);
    }
    closeJobsDropdown();
}

// ---------- Pin / dismiss / notification controls (jobs dropdown rows) -------

function _rerenderOpenJobsDropdown() {
    try {
        var dd = (typeof _getOpenJobsDropdown === 'function') ? _getOpenJobsDropdown() : null;
        if (dd && typeof renderJobsDropdown === 'function') renderJobsDropdown(dd);
    } catch (e) {}
}

// Pin/unpin a chat from a jobs row. Pinning un-hides a previously removed chat
// (pinned always wins). Reuses togglePinChat so History + sidebar stay in sync.
function toggleJobsPin(chatId) {
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c) return;
    if (!c.pinned && c._jobsHidden) delete c._jobsHidden;
    if (typeof togglePinChat === 'function') {
        togglePinChat(chatId);
    } else {
        c.pinned = !c.pinned;
        if (typeof saveChatsToStorage === 'function') { try { saveChatsToStorage(); } catch (e) {} }
    }
    if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
    _rerenderOpenJobsDropdown();
}

// Flip a chat's leftover status:'pending' tool-approval rows to a terminal
// status. Cures a 'tools-permission bell that keeps showing on a chat with
// nothing there' (a pending approval persisted from a run that no longer
// exists). Returns true if anything changed.
function _clearChatApprovalRows(c) {
    var changed = false;
    if (c && Array.isArray(c.messages)) {
        c.messages.forEach(function(m) {
            if (m && m.role === 'approval' && m.status === 'pending') {
                // 'denied' is the established terminal status the message renderer
                // and chatHasPendingApproval already understand (mirrors the
                // pause-driven deny path); the marker tags it as a user dismissal.
                m.status = 'denied';
                m.dismissedByUser = true;
                changed = true;
            }
        });
    }
    return changed;
}

// Per-chat 'dismiss notification': clears the unseen bell, the error flag, and
// any leftover pending approval (rejecting a live resolver first), then saves
// and re-renders the badge + dropdown.
function dismissChatNotifications(chatId) {
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c) return;
    if (typeof rejectPendingApprovalsForChat === 'function') {
        try { rejectPendingApprovalsForChat(chatId); } catch (e) {}
    }
    _clearChatApprovalRows(c);
    c.lastViewedAt = Date.now();
    if (c._lastApiError) delete c._lastApiError;
    if (typeof clearUnseenFinishedChat === 'function') { try { clearUnseenFinishedChat(chatId); } catch (e) {} }
    if (typeof saveChatsToStorage === 'function') { try { saveChatsToStorage(); } catch (e) {} }
    if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
    _rerenderOpenJobsDropdown();
}

// Remove a chat from the jobs-dropdown lists (Active/Recent/Done/Today) without
// deleting it from History. Pinned chats are never hidden — unpin first.
function dismissChatFromJobs(chatId) {
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c || c.pinned) return;
    c._jobsHidden = true;
    if (typeof rejectPendingApprovalsForChat === 'function') {
        try { rejectPendingApprovalsForChat(chatId); } catch (e) {}
    }
    _clearChatApprovalRows(c);
    c.lastViewedAt = Date.now();
    if (c._lastApiError) delete c._lastApiError;
    if (typeof clearUnseenFinishedChat === 'function') { try { clearUnseenFinishedChat(chatId); } catch (e) {} }
    if (typeof saveChatsToStorage === 'function') { try { saveChatsToStorage(); } catch (e) {} }
    if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
    _rerenderOpenJobsDropdown();
}

// One-shot boot reconciliation: a status:'pending' approval row that survives a
// page reload can never be answered (the requesting run's in-memory resolver is
// gone), yet it keeps a permission bell lit on a chat with 'nothing there'.
// Flip those to 'cancelled'. We only touch chats that are NOT actively running
// AND have no live resolver in pendingToolApprovals, so an in-session parked
// approval is never disturbed.
var _staleApprovalSweepDone = false;
function _chatHasLiveApprovalEntry(cid) {
    if (typeof pendingToolApprovals !== 'object' || !pendingToolApprovals) return false;
    return Object.keys(pendingToolApprovals).some(function(k) {
        var e = pendingToolApprovals[k];
        return e && e.chatId === cid;
    });
}
function reconcileStaleApprovals() {
    if (_staleApprovalSweepDone) return;
    _staleApprovalSweepDone = true;
    if (typeof chats === 'undefined' || !chats) return;
    var changed = false;
    Object.keys(chats).forEach(function(cid) {
        var c = chats[cid];
        if (!c || !Array.isArray(c.messages)) return;
        if (typeof isChatActivelyRunning === 'function' && isChatActivelyRunning(cid)) return;
        if (_chatHasLiveApprovalEntry(cid)) return;
        c.messages.forEach(function(m) {
            if (m && m.role === 'approval' && m.status === 'pending') {
                m.status = 'denied';
                m.staleSweep = true;
                changed = true;
            }
        });
    });
    if (changed) {
        if (typeof saveChatsToStorage === 'function') { try { saveChatsToStorage(); } catch (e) {} }
        if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
        _rerenderOpenJobsDropdown();
    }
}

// ---------- Re-render on state change ----------

// Update every action button in the DOM that matches this action.
function refreshActionButtons(actionId) {
    var a = activeActions[actionId];
    var buttons = document.querySelectorAll('.action-btn');
    buttons.forEach(function(btn) {
        var sid = btn.getAttribute('data-skill-id');
        var an = btn.getAttribute('data-action-name');
        if (!sid || !an) return;
        var thisActionId = getActionId(sid, an);
        if (thisActionId !== actionId) return;
        var skill = skills[sid];
        var action = skill ? (skill.actions || []).filter(function(x){ return x.name === an; })[0] : null;
        if (!action) return;
        var d = a ? {
            state: a.state,
            label: a.label || action.name
        } : { state: 'idle', label: action.name };
        // Preserve placement-* + inline- classifiers
        var placementCls = ['placement-header','placement-home','placement-chat','placement-live','placement-sidebar','placement-inline']
            .filter(function(c){ return btn.classList.contains(c); }).join(' ');
        var interruptedCls = (a && a.reloadInterrupted) ? ' reload-interrupted' : '';
        var pausedCls = (a && a._isPaused) ? ' is-paused' : '';
        btn.className = 'action-btn state-' + d.state + (placementCls ? ' ' + placementCls : '') + interruptedCls + pausedCls;
        // The primary icon stays as the action's own icon — don't swap it
        var labelEl = btn.querySelector('.action-btn-label');
        if (labelEl) labelEl.textContent = d.state === 'idle' ? action.name : d.label;
        // Update or insert the status badge
        var badge = btn.querySelector('.action-btn-badge');
        var badgeIcon = getStateBadgeIcon(d.state, pausedCls ? 'is-paused' : '');
        if (badgeIcon) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'action-btn-badge';
                badge.setAttribute('aria-hidden', 'true');
                btn.appendChild(badge);
            }
            badge.innerHTML = badgeIcon;
        } else if (badge) {
            badge.remove();
        }
    });
}

// Tracks the previous set of active action IDs so we know when to fully
// re-render the live-pill rows (membership change) vs. just refresh styles
// on the existing pills (in-place state tick).
var _prevLiveActionIdsKey = '';

// Register global state change listener
onActionStateChange(function(actionId) {
    refreshActionButtons(actionId);
    renderJobsBadge();
    // Live pills: if the SET of active actions changed (one started or was
    // dismissed), re-render the header + home live rows. State-only ticks
    // fall through to refreshActionButtons which mutates the DOM in place.
    var ids = Object.keys(activeActions).sort().join('|');
    if (ids !== _prevLiveActionIdsKey) {
        _prevLiveActionIdsKey = ids;
        renderLiveActionPills();
    }
    var openDropdown = _getOpenJobsDropdown();
    if (openDropdown) renderJobsDropdown(openDropdown);
    // If the user is staring at the popover for this action, keep its contents
    // in sync — without this, tasks/label/output frozen at the moment of click.
    _refreshOpenActionPopover(actionId);
    // Header labels may have changed length — re-evaluate overflow.
    // Use the rAF-debounced scheduler so frequent state ticks (spinner etc.)
    // don't trigger one full layout recompute per call.
    if (typeof _scheduleHeaderResponsive === 'function') _scheduleHeaderResponsive();
    else if (typeof applyHeaderActionsResponsive === 'function') applyHeaderActionsResponsive();
    // Same recompute for the home-header live row — it has its own (lighter)
    // responsive collapse that the chat-header scheduler doesn't reach.
    if (typeof _scheduleHomeHeaderResponsive === 'function') _scheduleHomeHeaderResponsive();
});

// ---------- Placement container rendering ----------
// Called on init and after skill activation changes, to populate
// home / chat / sidebar containers with buttons. The header-actions and
// home-header-actions are populated separately by renderLiveActionPills().

function renderAllActionPlacements() {
    // Sidebar (in the nav area)
    var sidebar = document.getElementById('sidebar-actions-row');
    if (sidebar) {
        var shtml = renderActionsForPlacement('sidebar', 'placement-sidebar');
        sidebar.innerHTML = shtml;
        sidebar.style.display = shtml ? '' : 'none';
    }
    // Chat (near chat input, above it)
    var chat = document.getElementById('chat-actions-row');
    if (chat) {
        var chtml = renderActionsForPlacement('chat', 'placement-chat');
        chat.innerHTML = chtml;
        chat.style.display = chtml ? '' : 'none';
    }
    // Live action pills in the header + on the home page — these are populated
    // from `activeActions` (running / not-yet-dismissed), NOT from skill
    // `show:` config. See renderLiveActionPills().
    renderLiveActionPills();
    // Home — re-rendered by renderHome() each time it's shown; if home container exists, repopulate
    var home = document.getElementById('home-actions-row');
    if (home) {
        home.innerHTML = renderActionsForPlacement('home', 'placement-home');
    }
    renderJobsBadge();
}

// =============================================
// HEADER RESPONSIVE COLLAPSE
// =============================================
// Strategy (priority-plus pattern, applied to the WHOLE header):
//   1. Render the header normally.
//   2. If the header overflows its width, collapse `.header-actions` to
//      icon-only mode (labels hidden).
//   3. If it STILL overflows, walk the children of `.header-controls` from
//      LOWEST to HIGHEST priority and stash them in a single "More" dropdown,
//      one at a time, until everything fits.
//   4. The dropdown is always positioned with position:fixed so it escapes
//      any overflow:hidden parent and is never clipped by the sidebar.
//
// Items declare their priority via getCollapsePriority() below — the lowest
// priority items collapse first. The settings button and toggle-sidebar button
// always stay visible. Action buttons collapse last (after the various status
// pills) since they're the most directly actionable.

var _headerObserver = null;
var _headerMoreOpen = false;
var _headerOriginalParents = []; // [{el, parent, nextSibling}] for restoring stashed items

// Priority table — LOWER number = collapse FIRST. Items not listed default to
// 100 so they remain visible. Selectors are matched in order; the first
// matching selector wins.
var HEADER_COLLAPSE_PRIORITY = [
    { sel: '#credits-display',           priority: 5  },
    { sel: '#storage-display',           priority: 10 },
    { sel: '#ws-header-status',          priority: 15 },
    { sel: '#active-tab-indicator',      priority: 20 },
    { sel: '#model-name',                priority: 25 },
    { sel: '#ext-sn-status',             priority: 30 },
    { sel: '#ext-expand-btn',            priority: 35 },
    { sel: '#ext-reload-btn',            priority: 45 },
    // Action buttons (one entry per child of #header-actions)
    { sel: '.header-actions > .action-btn', priority: 60 },
    { sel: '#jobs-badge-wrapper',        priority: 80 },
    // settings, toggle-sidebar, browser-controls input — not collapsible (no entry)
];

function _getCollapsePriority(el) {
    for (var i = 0; i < HEADER_COLLAPSE_PRIORITY.length; i++) {
        var entry = HEADER_COLLAPSE_PRIORITY[i];
        if (el.matches && el.matches(entry.sel)) return entry.priority;
    }
    return null; // null = not collapsible
}

// Public entrypoint. Recompute the responsive layout. Called on init,
// every action state change, every render, and on resize (debounced).
function applyHeaderActionsResponsive() {
    var header = document.querySelector('.main-header');
    var controls = header && header.querySelector('.header-controls');
    if (!header || !controls) return;

    // Don't tear down the dropdown while the user has it open. The next
    // recompute will run as soon as they close it (outside-click handler).
    if (controls.querySelector('.action-more-wrap.open')) return;

    // Short-circuit: header already fits and nothing is stashed.
    if (header.scrollWidth <= header.clientWidth + 1 &&
        _headerOriginalParents.length === 0 &&
        !controls.querySelector(':scope > .action-more-wrap')) {
        return;
    }

    // Suppress the MutationObserver while we move DOM ourselves — our own
    // restores/stashes would otherwise trigger another recompute and loop.
    _silenceMutations++;
    // Cleared on the next macrotask so any pending mutation microtasks see
    // the silence flag still set and skip themselves.
    setTimeout(function() { _silenceMutations--; }, 0);

    // Restore items to original positions, then re-collapse if needed.
    _restoreStashedHeaderItems();
    var actions = document.getElementById('header-actions');
    if (actions) actions.classList.remove('icons-only', 'has-overflow');

    _attachHeaderObserver(header);

    // ----- Step 1: fits with full labels? -----
    if (header.scrollWidth <= header.clientWidth + 1) return;

    // ----- Step 2: collapse action buttons to icon-only -----
    if (actions && actions.children.length) {
        actions.classList.add('icons-only');
    }
    if (header.scrollWidth <= header.clientWidth + 1) return;

    // ----- Step 3: stash items into the More dropdown by priority -----
    var moreWrap = _ensureHeaderMoreDropdown(controls);
    var panel = moreWrap.querySelector('.action-more-panel');
    panel.innerHTML = '';

    // Collect currently-visible items with a defined priority. Action buttons
    // are enumerated individually so they collapse one at a time.
    var collapsibles = [];
    Array.prototype.slice.call(controls.children).forEach(function(child) {
        if (child === moreWrap) return;
        if (child.id === 'header-actions') {
            Array.prototype.slice.call(child.children).forEach(function(btn) {
                if (!btn.classList || !btn.classList.contains('action-btn')) return;
                if (getComputedStyle(btn).display === 'none') return;
                var p = _getCollapsePriority(btn);
                if (p != null) collapsibles.push({ el: btn, priority: p, fromActions: true });
            });
            return;
        }
        if (getComputedStyle(child).display === 'none') return;
        var p = _getCollapsePriority(child);
        if (p != null) collapsibles.push({ el: child, priority: p, fromActions: false });
    });

    // Sort: lowest priority first (collapse first)
    collapsibles.sort(function(a, b) { return a.priority - b.priority; });

    var stashed = 0;
    for (var i = 0; i < collapsibles.length; i++) {
        if (header.scrollWidth <= header.clientWidth + 1) break;
        _stashItem(collapsibles[i].el, panel, collapsibles[i].fromActions);
        stashed++;
    }

    if (stashed === 0) {
        // Nothing was stashed this round — the wrap exists but has no items.
        // Remove it so the empty trigger doesn't dangle in the header.
        if (moreWrap.parentNode) moreWrap.parentNode.removeChild(moreWrap);
    } else if (actions && actions.children.length === 0) {
        actions.style.display = 'none';
    }
}

// Move a header item into the More dropdown panel, remembering where it came
// from so we can put it back on the next recompute.
function _stashItem(el, panel, fromActions) {
    _headerOriginalParents.push({
        el: el,
        parent: el.parentNode,
        nextSibling: el.nextSibling,
        prevDisplay: el.style.display || '',
        fromActions: !!fromActions
    });
    // Wrap each item in a row so the dropdown has consistent padding/hover.
    var row = document.createElement('div');
    row.className = 'header-more-row' + (fromActions ? ' from-actions' : '');
    panel.appendChild(row);
    row.appendChild(el);
    // The element may have been forcibly hidden by a media query (e.g.
    // .credits-display on mobile). Inside the dropdown we always want it visible.
    el.style.display = '';
}

// Move stashed items back to their original positions but DO NOT destroy the
// More wrap itself — leave it in place so its click handlers and DOM identity
// survive across recomputes. The recompute caller is responsible for removing
// the wrap at the end if it's no longer needed.
function _restoreStashedHeaderItems() {
    var actions = document.getElementById('header-actions');
    if (actions) actions.style.display = '';

    if (!_headerOriginalParents.length) return;
    _headerOriginalParents.forEach(function(rec) {
        rec.el.style.display = rec.prevDisplay;
        if (rec.parent && rec.parent.isConnected) {
            if (rec.nextSibling && rec.nextSibling.parentNode === rec.parent) {
                rec.parent.insertBefore(rec.el, rec.nextSibling);
            } else {
                rec.parent.appendChild(rec.el);
            }
        }
    });
    _headerOriginalParents = [];
    // Clear the dropdown panel contents but keep the wrap so its click
    // handlers remain wired to the same DOM node.
    var morewrap = document.querySelector('.header-controls > .action-more-wrap');
    if (morewrap) {
        var panel = morewrap.querySelector('.action-more-panel');
        if (panel) panel.innerHTML = '';
    }
}

function _ensureHeaderMoreDropdown(controls) {
    var existing = controls.querySelector(':scope > .action-more-wrap');
    if (existing) return existing;
    var wrap = _buildHeaderMoreButton();
    // Insert just before the settings button so settings always stays visible
    // on the far right.
    var settings = controls.querySelector(':scope > .settings-btn');
    if (settings) controls.insertBefore(wrap, settings);
    else controls.appendChild(wrap);
    return wrap;
}

function _buildHeaderMoreButton() {
    var wrap = document.createElement('div');
    wrap.className = 'action-more-wrap';
    wrap.innerHTML =
        '<button type="button" class="action-btn action-more-btn" aria-label="More" aria-haspopup="true" aria-expanded="false" title="More">' +
            '<span class="action-btn-primary" aria-hidden="true">' +
                '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>' +
            '</span>' +
        '</button>' +
        '<div class="action-more-panel" role="menu"></div>';
    var btn = wrap.querySelector('.action-more-btn');
    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        _toggleHeaderMore(wrap);
    });
    return wrap;
}

function _toggleHeaderMore(wrap) {
    var open = wrap.classList.toggle('open');
    _headerMoreOpen = open;
    var btn = wrap.querySelector('.action-more-btn');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) _positionHeaderMorePanel(wrap);
}

// Position the dropdown panel right under its trigger button using fixed
// coordinates. This avoids being clipped by .main-header's overflow context
// or appearing behind sidebars/other elements.
function _positionHeaderMorePanel(wrap) {
    var btn = wrap.querySelector('.action-more-btn');
    var panel = wrap.querySelector('.action-more-panel');
    if (!btn || !panel) return;
    var rect = btn.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var GAP = 6;
    var EDGE = 6;

    // Reset before measuring — otherwise stale max-height/positions skew the
    // natural size we need for clamping below.
    panel.style.position = 'fixed';
    panel.style.top = '0px';
    panel.style.left = 'auto';
    panel.style.right = '0px';
    panel.style.bottom = 'auto';
    panel.style.maxHeight = (vh - 2 * EDGE) + 'px';
    panel.style.maxWidth = (vw - 2 * EDGE) + 'px';

    // Force a layout flush so offsetWidth/offsetHeight are fresh.
    var panelW = panel.offsetWidth;
    var panelH = panel.offsetHeight;

    // ---- Vertical positioning ----
    // Prefer below the button. If not enough room AND there's more room above,
    // flip above. Always clamp inside [EDGE, vh-EDGE].
    var spaceBelow = vh - rect.bottom - GAP;
    var spaceAbove = rect.top - GAP;
    var top, maxH;
    if (panelH <= spaceBelow || spaceBelow >= spaceAbove) {
        top = rect.bottom + GAP;
        maxH = Math.max(80, vh - top - EDGE);
    } else {
        // Open above
        maxH = Math.max(80, spaceAbove - EDGE);
        top = Math.max(EDGE, rect.top - GAP - Math.min(panelH, maxH));
    }
    // Final clamp — should never start above the top of the viewport.
    if (top < EDGE) top = EDGE;
    if (top + Math.min(panelH, maxH) > vh - EDGE) {
        // Panel would still spill off bottom — shrink instead of moving up.
        maxH = vh - top - EDGE;
    }

    // ---- Horizontal positioning ----
    // Right-align under the button by default; clamp so left edge >= EDGE.
    var right = Math.max(EDGE, vw - rect.right);
    var leftIfRight = vw - right - panelW;
    if (leftIfRight < EDGE) {
        // Panel is too wide to right-align cleanly — fall back to a left-aligned
        // position that fits inside the viewport.
        panel.style.right = 'auto';
        panel.style.left = EDGE + 'px';
    } else {
        panel.style.left = 'auto';
        panel.style.right = right + 'px';
    }

    panel.style.top = top + 'px';
    panel.style.maxHeight = maxH + 'px';
}

// Close the More dropdown on outside click
document.addEventListener('click', function(e) {
    var wrap = document.querySelector('.action-more-wrap.open');
    if (!wrap) return;
    if (!wrap.contains(e.target)) {
        wrap.classList.remove('open');
        var btn = wrap.querySelector('.action-more-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }
});

// Watch the header for changes. ResizeObserver catches resizes; MutationObserver
// catches async reveals (e.g. #ext-sn-status flipping from display:none to
// visible) that don't change the box size in side-panel flex layouts.
// Both go through the same rAF-debounced scheduler.
var _headerResizeRaf = null;
var _silenceMutations = 0; // bumped while we move DOM ourselves to avoid loops

function _scheduleHeaderResponsive() {
    if (_headerResizeRaf) cancelAnimationFrame(_headerResizeRaf);
    _headerResizeRaf = requestAnimationFrame(function() {
        _headerResizeRaf = null;
        applyHeaderActionsResponsive();
    });
}

function _attachHeaderObserver(headerEl) {
    if (_headerObserver) return;
    if (typeof ResizeObserver === 'function') {
        _headerObserver = new ResizeObserver(_scheduleHeaderResponsive);
        _headerObserver.observe(headerEl);
    }
    var controls = headerEl.querySelector('.header-controls');
    if (!controls) return;
    if (_headerObserver) _headerObserver.observe(controls);
    if (typeof MutationObserver === 'function') {
        new MutationObserver(function(mutations) {
            if (_silenceMutations > 0) return;
            // Ignore mutations inside the More dropdown itself (e.g. the .open
            // class flipping when the user clicks the trigger). Those are
            // internal UI state, not changes to the header layout.
            var relevant = mutations.some(function(m) {
                return !(m.target.closest && m.target.closest('.action-more-wrap'));
            });
            if (!relevant) return;
            _scheduleHeaderResponsive();
        }).observe(controls, {
            attributes: true,
            attributeFilter: ['style', 'class', 'hidden'],
            subtree: true
        });
    }
}

window.addEventListener('resize', _scheduleHeaderResponsive);

// Reposition the More dropdown panel if it's open during a scroll/resize.
window.addEventListener('scroll', function() {
    var wrap = document.querySelector('.action-more-wrap.open');
    if (wrap) _positionHeaderMorePanel(wrap);
}, true);

// Poll for the first 5 seconds after load so async reveals (SN status, model
// name, credits, etc.) trigger a recompute even in side-panel mode where the
// observers don't always fire. The function short-circuits when there's
// nothing to do, so this is essentially free.
var _headerBootPoll = setInterval(function() {
    if (typeof applyHeaderActionsResponsive === 'function') applyHeaderActionsResponsive();
}, 250);
setTimeout(function() { clearInterval(_headerBootPoll); }, 5000);

// Close jobs dropdown when clicking outside its wrapper. Multiple dropdowns
// (header + home) coexist in the DOM — only one can be open at a time.
// Clicking inside the result popover should NOT close the dropdown either,
// since the popover is anchored to the dropdown.
document.addEventListener('click', function(e) {
    var openDropdown = _getOpenJobsDropdown();
    if (!openDropdown) return;
    var wrapper = openDropdown.closest('.jobs-badge-wrapper');
    if (wrapper && wrapper.contains(e.target)) return;
    if (_resultPopover && _resultPopover.contains(e.target)) return;
    closeJobsDropdown();
});
