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
        if (Array.isArray(args.tasks)) {
            // Cap task list length so a runaway agent can't overflow the popover
            // / tooltip. Validate each status against the documented enum and fall
            // back to 'pending' for anything off-list — otherwise the CSS selector
            // (.task-row.status-…) silently fails to match and the row renders unstyled.
            var VALID_TASK_STATUSES = ['pending', 'running', 'done', 'error'];
            a.tasks = args.tasks.slice(0, 20).map(function(t) {
                var status = t && VALID_TASK_STATUSES.indexOf(t.status) >= 0 ? t.status : 'pending';
                return { label: String((t && t.label) || '').substring(0, 80), status: status };
            });
        }
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
    return { success: true };
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
            setTimeout(function() { delete pausedChats[dchat]; }, 5000);
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
    // Only auto-finalize if the agent didn't explicitly set done/error.
    if (a.state === 'running') {
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
    var chat = chats[currentChatId];
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
function openChatProgressPopover(anchor, includeToolCallId) {
    var current = (typeof getCurrentChatProgressState === 'function') ? getCurrentChatProgressState(includeToolCallId) : null;
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
    el.dataset.chatId = currentChatId || '';
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
    // Filter orphans so the badge count matches what the user actually sees in
    // the live-pill row and the dropdown. Without this, an uninstalled-skill
    // entry left in `activeActions` would show "1" in the badge with no
    // clickable pill or dropdown row.
    var list = getActiveActionsList().filter(function(a){ return !_isOrphanActiveAction(a); });
    var count = list.length;
    var running = getRunningActionsCount();
    var agg = _getAggregateActionState();
    var titleSuffix = '';
    if (agg === 'attention')    titleSuffix = ' — needs attention';
    else if (agg === 'error')   titleSuffix = ' — has errors';
    else if (agg === 'running') titleSuffix = ' — running';
    else if (agg === 'done')    titleSuffix = ' — done';
    // Detect the running→done transition so we can fire a one-shot finish pulse.
    var justFinished = (_prevAggregateState === 'running' && (agg === 'done' || agg === 'idle'));
    _prevAggregateState = agg;
    badges.forEach(function(badge) {
        if (!count) {
            badge.style.display = 'none';
            badge.removeAttribute('data-agg');
            badge.classList.remove('pulse', 'finish-pulse');
            return;
        }
        badge.style.display = 'inline-flex';
        badge.setAttribute('data-agg', agg);
        // "pulse" is the existing infinite attention pulse; only on attention state.
        badge.classList.toggle('pulse', agg === 'attention');
        badge.title = count + ' active action' + (count === 1 ? '' : 's') + titleSuffix;
        badge.innerHTML =
            '<span class="jobs-badge-icon">' + UI_ICONS.zap + '</span>' +
            '<span class="jobs-badge-count">' + count + '</span>' +
            (running ? '<span class="jobs-badge-spinner">' + UI_ICONS.spinner + '</span>' : '');
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
    if (!list.length) {
        dropdown.innerHTML = '<div class="jobs-dropdown-empty">No active jobs</div>';
        return;
    }
    var rowsHtml = list.map(function(a) {
        var iconSvg = UI_ICONS[a.icon] || UI_ICONS.spinner;
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
    dropdown.innerHTML =
        '<div class="jobs-dropdown-header">Active Actions</div>' +
        '<div class="jobs-dropdown-list">' + rowsHtml + '</div>';
}

function onJobsDropdownRowClick(actionId) {
    var a = activeActions[actionId];
    if (!a) return;
    // Anchor the popover to the dropdown PANEL itself (not the row) so the popover
    // appears below the dropdown rather than overlapping its rows. The dropdown
    // stays open so the user can pick another action without re-opening it.
    // IMPORTANT: scope the row lookup to the OPEN dropdown. Both dropdowns
    // (chat header + home header) render the same rows; a global querySelector
    // would return the row from the hidden dropdown, whose bounding rect is zero
    // — causing _positionPopover to fall back to a viewport-centered location.
    var dropdownEl = _getOpenJobsDropdown();
    var rowEl = dropdownEl
        ? dropdownEl.querySelector('.jobs-dropdown-row[data-action-id="' + actionId + '"]')
        : document.querySelector('.jobs-dropdown-row[data-action-id="' + actionId + '"]');
    if (!dropdownEl && rowEl) dropdownEl = rowEl.closest('.jobs-dropdown');
    var anchor = dropdownEl || rowEl;
    if (a.state === 'needs_input') { openPendingPromptForAction(actionId); return; }
    if (a.state === 'needs_permission' && anchor) { openPendingApprovalForActionInline(anchor, actionId); return; }
    if (a.state === 'running' && anchor) { openRunningPopover(anchor, actionId); return; }
    if (a.state === 'stuck' && anchor) { openResultPopover(anchor, actionId); return; }
    if ((a.state === 'done' || a.state === 'error' || a.state === 'stopped') && anchor) { openResultPopover(anchor, actionId); return; }
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
    { sel: '#open-browser-btn',          priority: 40 },
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
