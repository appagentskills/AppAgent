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

// opts.includeDeferred: return the FULL enabled list even when deferred
// tool loading is ON — same contract as the page twin (ui/140-dropdowns.js).
function getEnabledTools(chatId, opts) {
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
        if (name === 'set_links' && !hooksEnabled.autoLinks) return false;
        if (name === 'set_caveat' && !hooksEnabled.autoCaveat) return false;
        // runtime_inspect is dev-mode-only: hidden from the LLM unless the
        // panel pushed dev-mode active ('dev-mode' case in 130-port-bridge.js).
        // Keep in sync with the page twin in src/js/ui/140-dropdowns.js.
        if (name === 'runtime_inspect' && !self._swDevModeActive) return false;
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
    // Deterministic order (prompt-cache / thinking-binding stability):
    // getActiveSkillTools follows activeSkills insertion order, which varies
    // with activation order and SW rehydration, so sort skill tools by name.
    // Core TOOLS keep their static order. Keep in sync with the page twin.
    skillToolDefs.sort(function(a, b) {
        var x = a.function.name, y = b.function.name;
        return x < y ? -1 : (x > y ? 1 : 0);
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
            // Tool Profiles (core/078-tool-profiles.js): non-sub chats load
            // only core + orchestrator + code + servicenow REGISTRY tools;
            // skill-provided tools keep legacy always-on behavior. Keep in
            // sync with the page twin in src/js/ui/140-dropdowns.js.
            var _regSet = Object.create(null);
            baseTools.forEach(function(t) { _regSet[t.function.name] = true; });
            var _mainSet = null;
            if (typeof getToolNamesForProfiles === 'function') {
                _mainSet = Object.create(null);
                getToolNamesForProfiles(['orchestrator', 'code', 'servicenow']).forEach(function(n) { _mainSet[n] = true; });
            }
            allTools = allTools.filter(function(t) {
                var n = t.function && t.function.name;
                if (n === 'report_to_parent' || n === 'sleep_self') return false;
                if (_mainSet && _regSet[n] && !_mainSet[n]) return false;
                return true;
            });
        }
    }

    // Deferred tool loading: SHARED split + strip helpers from
    // core/080-tools.js (WORKER_SHARED_FILES) — do NOT fork the logic here.
    // Matches the page-side getEnabledTools in src/js/ui/140-dropdowns.js.
    var _deferredActive = (typeof isDeferredToolsActive === 'function') && isDeferredToolsActive();
    if (_deferredActive && !(opts && opts.includeDeferred)) {
        allTools = getDeferredSplit(allTools).core;
    }
    // Strip non-wire fields: `short` always, `headless` only in deferred
    // mode (flag OFF stays byte-identical to the legacy wire shape).
    if (typeof prepareToolsForRequest === 'function') {
        allTools = prepareToolsForRequest(allTools, _deferredActive);
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

// `chatId` (optional): the calling chat — "Allow for this chat" grants are
// keyed by ROOT chat (core/070-permissions.js chatPermKey) and checked FIRST.
function getToolPermission(toolName, methodOrAction, chatId) {
    var permKey = resolvePermissionKey(toolName, methodOrAction);
    if (isInstancePermissionKey(permKey)) {
        return getInstanceToolPermission(permKey, chatId);
    }
    // An explicit 'disabled' (Settings > Tool permissions) is the user's hard
    // stop and wins over any "Allow for this chat" grant — the grant may have
    // been made BEFORE the user disabled the tool. Mirrors ui/140-dropdowns.js.
    if (toolPermissions[permKey] === 'disabled') return 'disabled';
    if (hasChatPermissionGrant(permKey, chatId)) return 'allow';
    if (toolPermissions[permKey]) return toolPermissions[permKey];
    // workspace:push defaults to 'allow' — PR pushes never prompt unless overridden
    if (permKey === 'workspace:push') return 'allow';
    // get_cookie defaults to 'allow' — cookie reads run silently and are never
    // prompted, exactly like workspace:push above. It stays in
    // GLOBAL_WRITE_KEYS so it still appears in Settings > Tool permissions and
    // can be lowered to 'ask'/'Off', but the generic write default 'auto' is
    // overridden here so a fresh profile, or a profile whose stored value was
    // cleared, resolves to 'allow'. The values returned ARE session
    // credentials. Keep this in sync with ui/140-dropdowns.js
    // getToolPermission and ui/070-dashboard-ui.js _getGlobalDefault.
    if (permKey === 'get_cookie') return 'allow';
    return isReadPermissionKey(permKey) ? 'allow' : 'auto';
}

function getInstanceToolPermission(permKey, chatId) {
    var host = getConnectedInstanceHost();
    var instPerms = host ? instancePermissions[host] : null;
    if (!instPerms) instPerms = { tier: 'manual', tools: {} };
    // Dev tier: EVERY instance-scoped call is 'allow' — no prompt, confirm:true
    // ignored (requestProgrammaticToolApproval returns on 'allow' before the
    // confirm check), per-tool settings incl. 'disabled' ignored exactly like
    // the auto tier ignores them. Mirrors ui/140-dropdowns.js.
    if (host && instPerms.tier === 'dev') return 'allow';
    // Explicit per-tool 'disabled' on the connected instance (manual tier) is
    // the user's hard stop and wins over any chat grant — mirrors
    // ui/140-dropdowns.js. The auto tier ignores per-tool settings entirely.
    if (host && instPerms.tier !== 'auto' && instPerms.tools && instPerms.tools[permKey] === 'disabled') return 'disabled';
    // "Allow for this chat" beats every fallback below (no-instance 'ask',
    // auto tier, per-tool, defaults).
    if (hasChatPermissionGrant(permKey, chatId)) return 'allow';
    if (!host) {
        return isReadPermissionKey(permKey) ? 'allow' : 'ask';
    }
    if (instPerms.tier === 'auto') {
        return isReadPermissionKey(permKey) ? 'allow' : 'auto';
    }
    if (instPerms.tools && instPerms.tools[permKey]) {
        return instPerms.tools[permKey];
    }
    return isReadPermissionKey(permKey) ? 'allow' : 'ask';
}

// ── "Allow for this chat" grant persistence (SW-owned) ─────────────────
// sessionPermissions (root-chat-scoped grants, core/070-permissions.js) is
// mirrored to chrome.storage.session so it survives MV3 SW eviction and an
// extension Reload within the browser session (storage.session is cleared
// when the browser closes — the intended lifetime). Guarded for contexts
// without chrome.storage.session (tests / non-extension hosts): there the
// map stays in-memory only, exactly the pre-persistence behaviour.
var SW_CHAT_GRANTS_STORAGE_KEY = 'appagent_chatPermissionGrants';
function persistSessionPermissionsInWorker() {
    try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;
        var payload = {};
        payload[SW_CHAT_GRANTS_STORAGE_KEY] = (sessionPermissions && typeof sessionPermissions === 'object') ? sessionPermissions : {};
        var p = chrome.storage.session.set(payload);
        if (p && typeof p.catch === 'function') p.catch(function(e) { console.warn('[sw-runtime] chat-grant persist failed', e); });
    } catch (e) { console.warn('[sw-runtime] chat-grant persist threw', e); }
}
// Boot hydration — runs next to loadToolPermissionsInWorker (worker/190-entry).
// Honours the _swPermsDirty boot-race guard (worker/020-page-stubs.js), which
// distinguishes two kinds of in-flight edit:
//   • sessionPermissions (FULL-MAP REPLACE: panel push / reset-all,
//     worker/130 'permissions-update') — the stored map is stale by
//     definition (a reset-all wiped it on purpose), so it is SKIPPED.
//   • sessionPermissionsAdditive (single "Allow for this chat" grant,
//     swGrantChatPermission in worker/120) — the grant landed on an EMPTY
//     boot map and was persisted as a 1-entry map, so skipping would drop
//     every earlier grant. Merge stored ∪ memory (memory wins) and
//     re-persist so storage regains the union.
async function loadSessionPermissionsInWorker() {
    try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;
        var got = await chrome.storage.session.get(SW_CHAT_GRANTS_STORAGE_KEY);
        var saved = got && got[SW_CHAT_GRANTS_STORAGE_KEY];
        if (!saved || typeof saved !== 'object') return;
        var dirty = (typeof _swPermsDirty !== 'undefined' && _swPermsDirty) ? _swPermsDirty : {};
        if (dirty.sessionPermissions) return;
        // sessionPermissionsDelta: a per-key {set,del} delta ('permissions-update'
        // with sessionPermissionsDelta, e.g. the deleteChat grant prune in
        // ui/170) landed during the boot window. Like the additive grant it
        // must MERGE the stored map (other chats' grants) — but keys it
        // explicitly deleted (dirty.sessionPermissionsDeleted) must NOT be
        // resurrected from storage.
        if (dirty.sessionPermissionsAdditive || dirty.sessionPermissionsDelta) {
            if (!sessionPermissions || typeof sessionPermissions !== 'object') sessionPermissions = {};
            var mem = sessionPermissions;
            var deleted = (dirty.sessionPermissionsDeleted && typeof dirty.sessionPermissionsDeleted === 'object') ? dirty.sessionPermissionsDeleted : {};
            var added = false;
            Object.keys(saved).forEach(function(k) {
                if (deleted[k]) return;
                if (!Object.prototype.hasOwnProperty.call(mem, k)) { mem[k] = saved[k]; added = true; }
            });
            if (added) {
                persistSessionPermissionsInWorker();
                if (typeof _swPanelPorts !== 'undefined' && _swPanelPorts && typeof _swPanelPorts.forEach === 'function') {
                    var _pc = { type: 'permissions-changed', sessionPermissions: mem };
                    _swPanelPorts.forEach(function(p) { try { p.postMessage(_pc); } catch (e) { /* dead port */ } });
                }
            }
            return;
        }
        sessionPermissions = saved;
    } catch (e) { console.warn('[sw-runtime] chat-grant hydrate failed', e); }
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
