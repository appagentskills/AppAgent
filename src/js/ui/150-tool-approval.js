// Central permission checking for all tool calls
// Options: { toolCallId, batch, chatId }
// - toolCallId: ID from actual tool call (for agent flow), auto-generated if not provided
// - batch: if true, uses showToolApprovalPromptBatch (caller must render after all prompts added)
// - chatId: target chat for approval prompt
// Returns: { allowed: true, permission, displayName, permissionKey } or { allowed: false, error, permission, displayName, permissionKey }
async function requestProgrammaticToolApproval(toolName, args, options) {
    options = options || {};
    var methodOrAction = null;
    if (toolName === 'servicenow_api' && args && args.method) {
        methodOrAction = args.method.toUpperCase();
    } else if (toolName === 'manage_skill' && args && args.action) {
        methodOrAction = args.action;
    } else if (toolName === 'iframe_tool' && args && args.action) {
        methodOrAction = args.action;
    } else if (toolName === 'workspace' && args && args.action) {
        methodOrAction = args.action;
    } else if (toolName === 'document' && args && args.action) {
        methodOrAction = args.action;
    }

    var permissionKey = resolvePermissionKey(toolName, methodOrAction);
    var permission = getToolPermission(toolName, methodOrAction);
    var displayName = getToolDisplayName(toolName, methodOrAction);

    var baseResult = { permission: permission, displayName: displayName, permissionKey: permissionKey };

    if (permission === 'disabled') {
        return Object.assign({ allowed: false, error: displayName + ' is disabled by user settings' }, baseResult);
    }

    // 'allow' — always execute silently
    if (permission === 'allow') {
        return Object.assign({ allowed: true }, baseResult);
    }

    // 'auto' — agent decides via confirm parameter
    if (permission === 'auto') {
        // If agent set confirm: true, treat as 'ask' (show prompt)
        if (args && args.confirm === true) {
            // Fall through to ask logic below
        } else {
            // Agent didn't request confirmation — auto-approve
            return Object.assign({ allowed: true }, baseResult);
        }
    }

    // permission === 'ask' OR (auto + confirm:true) - check if already approved, else prompt
    var targetChatId = options.chatId || activeStreamingChatId || currentChatId;
    var toolCallId = options.toolCallId || ('prog_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));

    // Check for existing approval for this toolCallId
    var chat = chats[targetChatId];
    if (chat && chat.messages && toolCallId) {
        for (var i = 0; i < chat.messages.length; i++) {
            var msg = chat.messages[i];
            if (msg.role === 'approval' && msg.toolCallId === toolCallId) {
                if (msg.status === 'allowed' || msg.status === 'session_allowed' || msg.status === 'always_allowed') {
                    return Object.assign({ allowed: true }, baseResult);
                } else if (msg.status === 'denied') {
                    return Object.assign({ allowed: false, error: displayName + ' was DENIED by user. STOP immediately — do NOT retry or work around this. Acknowledge the denial and ask the user how to proceed.' }, baseResult);
                }
                // status === 'pending' should not happen here (means approval in progress)
                break;
            }
        }
    }

    // Show approval prompt and wait for user response
    var promptFn = options.batch ? showToolApprovalPromptBatch : showToolApprovalPrompt;
    var approved = await promptFn(displayName, args, permissionKey, toolCallId, toolName, targetChatId, options);

    if (approved) {
        return Object.assign({ allowed: true }, baseResult);
    } else {
        return Object.assign({ allowed: false, error: displayName + ' was DENIED by user. STOP immediately — do NOT retry or work around this. Acknowledge the denial and ask the user how to proceed.' }, baseResult);
    }
}
