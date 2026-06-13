// =============================================================
// AppAgent offscreen runtime — permission / tool-list helpers.
//
// The page-bundle versions of these functions live in
// src/js/ui/140-dropdowns.js (UI tier, excluded from worker). They
// reference `toolPermissions`, `instancePermissions`, `sessionPermissions`,
// `hooksEnabled`, `TOOL_DISPLAY_NAMES` etc. — all globals declared
// in worker-bundled files (config / ui-constants / hooks-stub).
//
// We re-implement them here so callLLMStreaming's getEnabledTools()
// call works on the offscreen side without dragging in ui/140-dropdowns
// (which is full of DOM-touching dropdown handlers we don't need).
//
// Keep these in sync with the page-side originals. If a tool gains
// a special permission carve-out (like the iframe_tool browser:*
// check), update both copies.
//
// Load order: 025 = pre-shared, so the shared bundle (which has
// callLLMStreaming) hoists to a scope where these functions exist.
// Functions are declared so they hoist; calls during loop runtime
// find them.
// =============================================================

function getDisabledTools() {
    var disabled = [];
    INSTANCE_PERMISSION_KEYS.forEach(function(key) {
        if (getInstanceToolPermission(key) === 'disabled') disabled.push(key);
    });
    GLOBAL_PERMISSION_KEYS.forEach(function(key) {
        if (toolPermissions[key] === 'disabled') disabled.push(key);
    });
    return disabled;
}

function getEnabledTools(chatId) {
    var baseTools = TOOLS.filter(function(tool) {
        var name = tool.function.name;
        if (name === 'servicenow_api') {
            var crudKeys = ['sn:read', 'sn:create', 'sn:update', 'sn:delete'];
            return !crudKeys.every(function(k) { return getInstanceToolPermission(k) === 'disabled'; });
        }
        if (name === 'servicenow_diff_edit') {
            return getInstanceToolPermission('sn:update') !== 'disabled';
        }
        if (name === 'iframe_tool') {
            var browserKeys = INSTANCE_PERMISSION_KEYS.filter(function(k) { return k.startsWith('browser:'); });
            return !browserKeys.every(function(k) { return getInstanceToolPermission(k) === 'disabled'; });
        }
        if (name === 'set_chat_title' && !hooksEnabled.autoTitle) return false;
        if (name === 'set_tldr' && !hooksEnabled.autoTldr) return false;
        var perm = getToolPermission(name);
        return perm !== 'disabled';
    });
    var skillToolDefs = (typeof getActiveSkillTools === 'function') ? getActiveSkillTools() : [];
    // Dedupe by name, core-first: a skill tool that shadows a built-in tool's
    // name (e.g. a stale skill asset left in IDB after the tool was promoted
    // to core) would otherwise produce a duplicate entry and a hard provider
    // error ("Tool names must be unique"). Core wins — matching the dispatch
    // order in tools/020-tool-execution.js where isSkillTool is the last arm.
    var seenToolNames = {};
    baseTools.forEach(function(t) { seenToolNames[t.function.name] = true; });
    skillToolDefs = skillToolDefs.filter(function(t) {
        var n = t && t.function && t.function.name;
        if (!n || seenToolNames[n]) return false;
        seenToolNames[n] = true;
        return true;
    });
    var allTools = baseTools.concat(skillToolDefs);

    // Sub-agent / parent visibility filter — keep in sync with page-side
    // getEnabledTools in src/js/ui/140-dropdowns.js. Honors per-sub
    // tool_roster (deterministic across spawns: parent's full list minus
    // the nested-delegation trio unless allow_nested:true) and hides
    // sub-only tools from parent chats.
    if (chatId && typeof chats !== 'undefined' && chats[chatId]) {
        var _chat = chats[chatId];
        if (_chat.isSubAgent && typeof SubAgents !== 'undefined' && SubAgents.getById) {
            var _rec = SubAgents.getById(_chat.subAgentId);
            if (_rec && Array.isArray(_rec.tool_roster)) {
                var _rosterSet = Object.create(null);
                for (var _ri = 0; _ri < _rec.tool_roster.length; _ri++) _rosterSet[_rec.tool_roster[_ri]] = true;
                allTools = allTools.filter(function(t) {
                    return _rosterSet[t.function && t.function.name];
                });
            }
        } else {
            allTools = allTools.filter(function(t) {
                var n = t.function && t.function.name;
                return n !== 'report_to_parent' && n !== 'sleep_self';
            });
        }
    }

    // Cache control: anthropic-style trailing cache point so the tools
    // block hits the prompt cache. Matches the page-side getEnabledTools.
    if (allTools.length > 0) {
        var last = Object.assign({}, allTools[allTools.length - 1]);
        last.cache_control = { type: 'ephemeral' };
        allTools[allTools.length - 1] = last;
    }
    return allTools;
}

function getToolPermission(toolName, methodOrAction) {
    var permKey = resolvePermissionKey(toolName, methodOrAction);
    if (isInstancePermissionKey(permKey)) {
        return getInstanceToolPermission(permKey);
    }
    if (sessionPermissions[permKey] === 'allow') return 'allow';
    if (toolPermissions[permKey]) return toolPermissions[permKey];
    return isReadPermissionKey(permKey) ? 'allow' : 'auto';
}

function getInstanceToolPermission(permKey) {
    var host = getConnectedInstanceHost();
    if (!host) {
        return isReadPermissionKey(permKey) ? 'allow' : 'ask';
    }
    var instPerms = instancePermissions[host];
    if (!instPerms) instPerms = { tier: 'manual', tools: {} };
    if (instPerms.tier === 'auto') {
        return isReadPermissionKey(permKey) ? 'allow' : 'auto';
    }
    if (sessionPermissions[permKey] === 'allow') return 'allow';
    if (instPerms.tools && instPerms.tools[permKey]) {
        return instPerms.tools[permKey];
    }
    return isReadPermissionKey(permKey) ? 'allow' : 'ask';
}

function getConnectedInstanceHost() {
    if (typeof Platform !== 'undefined' && Platform.instanceUrl) {
        return Platform.instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    return null;
}

function getToolDisplayName(toolName, methodOrAction) {
    if (methodOrAction) {
        var specificKey = toolName + ':' + methodOrAction;
        if (typeof TOOL_DISPLAY_NAMES !== 'undefined' && TOOL_DISPLAY_NAMES[specificKey]) return TOOL_DISPLAY_NAMES[specificKey];
    }
    var permKey = resolvePermissionKey(toolName, methodOrAction);
    if (typeof TOOL_DISPLAY_NAMES !== 'undefined' && TOOL_DISPLAY_NAMES[permKey]) return TOOL_DISPLAY_NAMES[permKey];
    if (typeof TOOL_DISPLAY_NAMES !== 'undefined' && TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName];
    return toolName;
}

// We DECLARED getToolDisplayName as a no-op stub in worker/020-page-stubs.js
// (defensive). This file's function declaration hoists later than that
// `var = function` so this implementation wins at runtime. The 020 file's
// stub remains only as documentation of expected functions.
