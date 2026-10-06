// Instance-touching permission keys (stored per-instance)
// Read: default 'allow' — always allowed unless user overrides
var INSTANCE_READ_KEYS = [
    'sn:read',           // servicenow_api GET
    'browser:read'       // iframe_tool: navigate, get_visible_text, get_dom, get_console_logs,
                         //   get_network_requests, scroll, resize, get_properties, set_style,
                         //   get_page_info, open_widget, close, edit_html, wait_for
];

// iframe_tool actions that map to browser:read
var BROWSER_READ_ACTIONS = [
    'navigate', 'get_visible_text', 'get_dom', 'get_console_logs', 'get_network_requests',
    'scroll', 'resize', 'get_properties', 'set_style', 'get_page_info', 'open_widget', 'close', 'edit_html',
    'wait_for'
];

// Write: default 'ask' in Manual tier, 'auto' in Auto tier
var INSTANCE_WRITE_KEYS = [
    'sn:create',         // servicenow_api POST + attachments
    'sn:update',         // servicenow_api PUT/PATCH + servicenow_diff_edit
    'sn:delete',         // servicenow_api DELETE
    'sn:run_script',     // servicenow_run_script — server-side script execution via sys.scripts.do
    'browser:click',
    'browser:fill',
    'browser:type',      // iframe_tool per-character typing — writes into instance forms like fill
    'browser:impersonate',
    'browser:dispatch_event',
    'browser:select_option'
];

var INSTANCE_PERMISSION_KEYS = INSTANCE_READ_KEYS.concat(INSTANCE_WRITE_KEYS);

// Global (non-instance) permission keys
// Read/Display: default 'allow'
var GLOBAL_READ_KEYS = [
    'cached_content_outline',
    'cached_content_search',
    'cached_content_read',
    'get_skill',
    'widget_eval:list',
    'get_tool_schema',
    'display',
    'prompt_user',
    'take_screenshot',
    'screenshot_by_id',
    'get_file',
    'read_attached_file',
    'workspace:ls',
    'workspace:list',
    'workspace:read',
    'workspace:grep',
    'workspace:status',
    'workspace:diff',
    'document:read',
    'document:list',
    'document:list_versions',
    'document:read_version',
    'list_instances',
    'local_folder:list',
    'local_folder:ls',
    'local_folder:read',
    'local_folder:grep',
    'local_folder:request'
];

// Modifying: default 'auto'
// (except web_fetch → 'ask', get_cookie → 'allow', workspace:push → 'allow')
var GLOBAL_WRITE_KEYS = [
    'js_eval',
    // run_js_file / run_tests execute workspace code inside the js_eval sandbox — same tier as js_eval.
    'run_js_file',
    'run_tests',
    'widget_eval',
    'html_widget',
    'pin_widget',
    'web_fetch',
    // get_cookie is ALLOWED by default (runs silently, no prompt) — same
    // treatment as workspace:push below. Membership here is only so it shows up
    // in Settings > Tool permissions and can be lowered to 'ask'/'Off'; the
    // generic write default 'auto' is overridden by an explicit 'allow' special
    // case in every place the default is computed:
    // worker/025-permissions-helpers.js getToolPermission, ui/140-dropdowns.js
    // getToolPermission + renderToolPermissions, and ui/070-dashboard-ui.js
    // initDefaultToolPermissions / _getGlobalDefault /
    // resetAllPermissionsToDefaults. Note the values it returns ARE session
    // credentials.
    'get_cookie',
    'set_chat_title',
    'set_tldr',
    'set_links',
    'set_caveat',
    'manage_skill:create',
    'manage_skill:update',
    'manage_skill:edit',
    'manage_skill:add_file',
    'manage_skill:update_file',
    'manage_skill:delete_file',
    'manage_skill:activate',
    'manage_skill:deactivate',
    'manage_skill:delete',
    'workspace:clone',
    'workspace:write',
    'workspace:edit',
    'workspace:delete',
    'workspace:copy',
    'workspace:discard',
    'workspace:push',
    'workspace:deploy',
    'document:create',
    'document:update',
    'document:edit',
    'document:delete',
    'local_folder:write',
    'local_folder:mkdir',
    'local_folder:delete',
    'local_folder:write_local',
    'update_action_state',
    'show_action_button',
    'github_setup',
    'runtime_inspect',
    'start_chat'
];

var GLOBAL_PERMISSION_KEYS = GLOBAL_READ_KEYS.concat(GLOBAL_WRITE_KEYS);

// Global write keys whose DEFAULT is 'ask' (prompt every time) instead of the
// generic write default 'auto'. Single source of truth for every place that
// hardcodes defaults: worker/025-permissions-helpers.js getToolPermission,
// ui/140-dropdowns.js (render + getToolPermission), ui/070-dashboard-ui.js
// (seed, _getGlobalDefault, reset) and ui/040-tools-settings.js (render).
// local_folder:delete / local_folder:write_local touch the user's REAL disk.
var GLOBAL_ASK_DEFAULT_KEYS = [
    'web_fetch',
    'local_folder:delete',
    'local_folder:write_local'
];

// Default permission of a GLOBAL key when the user has stored nothing.
function getGlobalDefaultPermission(permKey) {
    if (isReadPermissionKey(permKey)) return 'allow';
    if (permKey === 'manage_skill:activate') return 'disabled';
    if (GLOBAL_ASK_DEFAULT_KEYS.indexOf(permKey) !== -1) return 'ask';
    // workspace:push / get_cookie run silently unless the user lowers them.
    if (permKey === 'workspace:push' || permKey === 'get_cookie') return 'allow';
    return 'auto';
}

// local_folder permission action: write/mkdir on a REAL (non-virtual) folder
// resolve to the stricter 'write_local' key (default 'ask'); the virtual
// "Agent Files" folder (folder null/''/'virtual'/'Agent Files') keeps the
// plain action key. Shared by both approval gates (ui/150-tool-approval.js,
// worker/120-tool-routing.js).
function localFolderPermissionAction(args) {
    if (!args || !args.action) return null;
    var action = args.action;
    if (action !== 'write' && action !== 'mkdir') return action;
    var f = args.folder;
    var isVirtual = f === undefined || f === null || f === '' || f === 'virtual' || f === 'Agent Files';
    return isVirtual ? action : 'write_local';
}

// Map tool name + method/action to permission key
function resolvePermissionKey(toolName, methodOrAction) {
    // ServiceNow API CRUD mapping
    if (toolName === 'servicenow_api') {
        var m = (methodOrAction || '').toUpperCase();
        if (m === 'GET') return 'sn:read';
        if (m === 'POST') return 'sn:create';
        if (m === 'PUT' || m === 'PATCH') return 'sn:update';
        if (m === 'DELETE') return 'sn:delete';
        return 'sn:read'; // fallback
    }
    // servicenow_run_script → sn:run_script
    if (toolName === 'servicenow_run_script') return 'sn:run_script';
    // servicenow_diff_edit → sn:update
    if (toolName === 'servicenow_diff_edit') return 'sn:update';
    // iframe_tool → browser:read (read actions) or browser:<action> (write actions)
    if (toolName === 'iframe_tool' && methodOrAction) {
        if (BROWSER_READ_ACTIONS.indexOf(methodOrAction) !== -1) return 'browser:read';
        return 'browser:' + methodOrAction;
    }
    // manage_skill, workspace, document → toolName:action
    if ((toolName === 'manage_skill' || toolName === 'workspace' || toolName === 'document' || toolName === 'local_folder') && methodOrAction) {
        return toolName + ':' + methodOrAction;
    }
    if (toolName === 'widget_eval' && methodOrAction === 'list') return 'widget_eval:list';
    // Direct match for global tools
    return toolName;
}

// Normalise an instance URL/host to the instancePermissions key shape
// ('dev1.service-now.com'): lowercase, no scheme, path, query or trailing slash.
function normalizeInstanceHost(urlOrHost) {
    if (!urlOrHost || typeof urlOrHost !== 'string') return null;
    var h = urlOrHost.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[\/?#].*$/, '');
    return h || null;
}

// The instance a call ACTUALLY targets, for the instance-tier permission
// lookup. Tools resolve args.instance via Platform.resolveInstanceUrl (both
// the page Platform in platform-bridge.js and the SW stub in
// worker/010-platform-stub.js — same short-name lookup over
// Platform.instances), so the gate must use the same host — otherwise a Dev
// mark on the ACTIVE instance would leak onto calls to another instance, and
// a Dev-marked target would prompt while a non-Dev instance is active.
// Returns the target host string, or null when args.instance is given but
// cannot be resolved (fail safe: null → no-instance defaults, writes ask;
// NEVER the active instance's tier). No args.instance → undefined, which
// getInstanceToolPermission treats as "the connected host".
// Shared by both gates (ui/150-tool-approval.js, worker/120-tool-routing.js).
function resolvePermissionTargetHost(args) {
    var inst = args && args.instance;
    if (inst === undefined || inst === null || inst === '') return undefined;
    if (typeof inst !== 'string') return null;
    var url = null;
    try {
        if (typeof Platform !== 'undefined' && Platform && typeof Platform.resolveInstanceUrl === 'function') {
            url = Platform.resolveInstanceUrl(inst.trim());
        }
    } catch (e) { url = null; }
    return normalizeInstanceHost(url);
}

// A host the instance-tier table can meaningfully key on: has a stored
// tier, is a known Platform instance, or is a *.service-now.com host.
function _permIsKnownInstanceHost(h) {
    if (!h) return false;
    if (getInstancePermissionsForHost(h)) return true;
    if (/\.service-now\.com$/.test(h)) return true;
    var list = (typeof Platform !== 'undefined' && Platform && Array.isArray(Platform.instances)) ? Platform.instances : [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && normalizeInstanceHost(list[i].url) === h) return true;
    }
    return false;
}

// One SW round trip for the facts iframe_tool routing depends on, resolved
// by background.js exactly as the tool resolves them: the tab (explicit id,
// or the ACTIVE tab via getActiveTabId — currentWindow of the SW) and the
// stored instanceUrl (sidepanel relative navigate, background.js
// handleNavigate). The offscreen worker has no chrome.tabs, so the message is
// the only path there; the page falls back to chrome.tabs/storage directly.
// Returns {tab:{url,pendingUrl}|null, instanceUrl} — null fields mean UNKNOWN.
function _permSendMessage(msg) {
    return new Promise(function(resolve) {
        try {
            chrome.runtime.sendMessage(msg, function(resp) {
                try { void chrome.runtime.lastError; } catch (e) {}
                resolve(resp || null);
            });
        } catch (e) { resolve(null); }
    });
}
async function _permTargetInfo(tabId, wantTab) {
    var hasChrome = typeof chrome !== 'undefined' && chrome;
    if (hasChrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        var r = await _permSendMessage({ type: 'perm-target-info', tabId: tabId, activeTab: !!wantTab });
        if (r && r.ok) return { tab: r.tab || null, instanceUrl: r.instanceUrl || null };
    }
    var out = { tab: null, instanceUrl: null };
    if (!hasChrome) return out;
    try {
        if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
            var d = await chrome.storage.local.get('instanceUrl');
            out.instanceUrl = (d && d.instanceUrl) || null;
        }
    } catch (e) { /* unknown */ }
    if (wantTab && chrome.tabs) {
        try {
            var tab = null;
            if (tabId != null) tab = await chrome.tabs.get(tabId);
            else {
                var ts = await chrome.tabs.query({ active: true, currentWindow: true });
                tab = ts && ts[0];
            }
            if (tab) out.tab = { url: tab.url || null, pendingUrl: tab.pendingUrl || null };
        } catch (e) { /* closed / unknown tab → unknown */ }
    }
    return out;
}

// Host for the tier lookup, or null (manual) when it is not a known instance.
function _permKnownHostOrNull(urlOrHost) {
    var h = normalizeInstanceHost(urlOrHost);
    return _permIsKnownInstanceHost(h) ? h : null;
}

// Which iframe_tool routing applies here: 'sidepanel' (body class, set by
// core/120-init.js), 'tab' (?mode=tab full-tab page), or null when unknown —
// e.g. the offscreen worker gate, where the call is later run by whichever
// panel/tab executes it — and then BOTH modes' candidates are considered.
function _permIframeMode() {
    try {
        if (typeof document !== 'undefined' && document && document.body && document.body.classList &&
            document.body.classList.contains('sidepanel-mode')) return 'sidepanel';
        if (typeof location !== 'undefined' && location && /[?&]mode=tab(&|$)/.test(location.search || '')) return 'tab';
    } catch (e) {}
    return null;
}

var _PERM_SN_INSTANCE_TOOLS = ['servicenow_api', 'servicenow_run_script', 'servicenow_diff_edit'];

// Candidate hosts whose tier governs this call; the STRICTEST wins
// (getTargetedToolPermission), so Dev applies only when EVERY candidate is a
// Dev instance. null = unknown host / failed lookup → manual defaults.
// servicenow_api / run_script / diff_edit route by args.instance, so that
// host alone decides. iframe_tool (every action) unions everything it might
// touch, resolved the way tools/010-iframe-tool.js + background.js route:
//  - the active instance host;
//  - the tab it drives — full-tab: tab_id → chat-pinned targetTabId → active
//    tab; sidepanel: tab_id is IGNORED (010:113-115, 177-178), pinned → active
//    tab (platform-bridge.js sendBrowserAction, background.js getActiveTabId);
//    both tab.url and tab.pendingUrl; unknown mode → both modes' candidates;
//  - navigate: an absolute URL's host; a relative URL's base (full-tab:
//    args.instance or the active instance; sidepanel: the STORED instanceUrl,
//    background.js handleNavigate, which ignores args.instance);
//  - args.instance when given (it can only add strictness here).
// Pins of BOTH the gate's chat and currentChatId are considered: the tool
// falls back to currentChatId when options.chatId is unknown (010:109-111),
// while the gate may have used activeStreamingChatId.
async function resolvePermissionTargetHosts(toolName, args, chatId) {
    var connected = (typeof getConnectedInstanceHost === 'function') ? getConnectedInstanceHost() : null;
    var explicit = resolvePermissionTargetHost(args); // undefined | host | null
    if (_PERM_SN_INSTANCE_TOOLS.indexOf(toolName) !== -1) return [explicit === undefined ? connected : explicit];
    if (toolName !== 'iframe_tool' || !args) return explicit === undefined ? [connected] : [connected, explicit];
    var hosts = [connected ? normalizeInstanceHost(connected) : null];
    if (explicit !== undefined) hosts.push(explicit);
    var mode = _permIframeMode();
    var isNav = args.action === 'navigate';
    var navUrl = isNav && typeof args.url === 'string' ? args.url : null;
    var relNav = !!(navUrl && navUrl.charAt(0) === '/');
    if (isNav && !relNav) hosts.push(navUrl && /^https?:\/\//i.test(navUrl) ? _permKnownHostOrNull(navUrl) : null);
    // Tabs the action may drive (null entry = the active tab).
    var tabIds = [];
    if (!args.widget_id) {
        if (args.tab_id != null && mode !== 'sidepanel') tabIds.push(args.tab_id);
        if (args.tab_id == null || mode !== 'tab') {
            var chatIds = [chatId];
            if (typeof currentChatId !== 'undefined' && currentChatId && currentChatId !== chatId) chatIds.push(currentChatId);
            for (var ci = 0; ci < chatIds.length; ci++) {
                var c = (typeof chats !== 'undefined' && chats && chatIds[ci]) ? chats[chatIds[ci]] : null;
                var pin = c && c.targetTabId != null ? c.targetTabId : null;
                if (tabIds.indexOf(pin) === -1) tabIds.push(pin);
            }
        }
    }
    var needStored = relNav && mode !== 'tab';
    if (!tabIds.length && needStored) tabIds.push(undefined); // storage only
    for (var ti = 0; ti < tabIds.length; ti++) {
        var wantTab = tabIds[ti] !== undefined;
        var info = await _permTargetInfo(wantTab ? tabIds[ti] : null, wantTab);
        if (wantTab) {
            var t = info.tab;
            if (!t || (!t.url && !t.pendingUrl)) hosts.push(null);
            else {
                if (t.url) hosts.push(_permKnownHostOrNull(t.url));
                if (t.pendingUrl) hosts.push(_permKnownHostOrNull(t.pendingUrl));
            }
        }
        if (needStored && ti === 0) hosts.push(info.instanceUrl ? _permKnownHostOrNull(info.instanceUrl) : null);
    }
    return hosts;
}

var _PERM_RANK = { allow: 0, auto: 1, ask: 2, disabled: 3 };
// Gate entry point (ui/150, worker/120): {permission, host} where host is the
// concrete instance host whose tier decided (stamped on approval rows so
// "Always allow" saves there). Non-instance keys: plain getToolPermission.
async function getTargetedToolPermission(toolName, methodOrAction, chatId, args) {
    var permKey = resolvePermissionKey(toolName, methodOrAction);
    if (!isInstancePermissionKey(permKey)) {
        return { permission: getToolPermission(toolName, methodOrAction, chatId), host: undefined };
    }
    var hosts = await resolvePermissionTargetHosts(toolName, args, chatId);
    var best = null;
    for (var i = 0; i < hosts.length; i++) {
        var p = getToolPermission(toolName, methodOrAction, chatId, hosts[i]);
        var r = Object.prototype.hasOwnProperty.call(_PERM_RANK, p) ? _PERM_RANK[p] : 2;
        // Ties prefer a null host: "Always allow" can't save there (L2) and
        // saving to a sibling host would not stop the next prompt anyway.
        if (!best || r > best.rank || (r === best.rank && hosts[i] === null && best.host !== null)) best = { permission: p, host: hosts[i], rank: r };
    }
    return { permission: best.permission, host: best.host };
}

// instancePermissions entry for a host; keys are stored un-lowercased by
// setInstanceTier (getConnectedInstanceHost), so fall back to a
// case-insensitive match.
function getInstancePermissionsForHost(host) {
    if (!host || typeof instancePermissions === 'undefined' || !instancePermissions) return null;
    if (instancePermissions[host]) return instancePermissions[host];
    var lc = String(host).toLowerCase();
    for (var k in instancePermissions) {
        if (Object.prototype.hasOwnProperty.call(instancePermissions, k) && String(k).toLowerCase() === lc) return instancePermissions[k];
    }
    return null;
}

// ── "Allow for this chat" grants (sessionPermissions) ─────────────────────
// sessionPermissions is keyed by ROOT chat + permission key:
//   chatPermKey(rootChatId, permKey) === rootChatId + '::' + permKey
// A grant made in a chat covers that chat AND every sub-agent spawned under
// it (any nesting depth) — sub chats resolve to the same root via the
// sub-agent registry. A start_chat background chat is its own root (no
// inheritance). Shared by both twins (worker/025-permissions-helpers.js and
// ui/140-dropdowns.js) — this file is in WORKER_SHARED_FILES.
function chatPermKey(rootChatId, permKey) {
    return String(rootChatId) + '::' + String(permKey);
}

// Walk a (possibly sub-agent) chat id up to its top-level root chat id.
// Primary source: the sub-agent registry record for the chat
// (SubAgents.getByChatId → root_chat_id / parent_chat_id, both twins load
// core/097). Fallback: chats[id].parentChatId when the registry has no
// record. Bounded + cycle-guarded; returns the input when it is not a sub.
function resolveRootChatId(chatId) {
    if (!chatId) return null;
    var cur = String(chatId);
    var seen = {};
    for (var i = 0; i < 16; i++) {
        seen[cur] = true;
        var next = null;
        try {
            var rec = (typeof SubAgents !== 'undefined' && SubAgents && SubAgents.getByChatId)
                ? SubAgents.getByChatId(cur) : null;
            if (rec) next = rec.root_chat_id || rec.parent_chat_id || null;
            else if (typeof chats !== 'undefined' && chats && chats[cur] && chats[cur].parentChatId) next = chats[cur].parentChatId;
        } catch (e) { next = null; }
        if (!next || next === cur || seen[next]) break;
        cur = String(next);
    }
    return cur;
}

// True when the chat (or its root) holds an "Allow for this chat" grant for
// permKey. Tolerates a missing chatId (→ false) so callers that cannot
// identify the chat fall through to the tier/instance/default rules.
function hasChatPermissionGrant(permKey, chatId) {
    if (!chatId || !permKey) return false;
    if (typeof sessionPermissions === 'undefined' || !sessionPermissions) return false;
    var root = resolveRootChatId(chatId);
    if (!root) return false;
    return sessionPermissions[chatPermKey(root, permKey)] === 'allow';
}

// Check if a permission key is instance-scoped
function isInstancePermissionKey(key) {
    return INSTANCE_PERMISSION_KEYS.indexOf(key) !== -1;
}

// Check if a permission key is a read operation
function isReadPermissionKey(key) {
    return INSTANCE_READ_KEYS.indexOf(key) !== -1 || GLOBAL_READ_KEYS.indexOf(key) !== -1;
}
