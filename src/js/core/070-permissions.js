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
    'list_instances'
];

// Modifying: default 'auto'
// (except web_fetch → 'ask', get_cookie → 'allow', workspace:push → 'allow')
var GLOBAL_WRITE_KEYS = [
    'js_eval',
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
    'update_action_state',
    'show_action_button',
    'github_setup',
    'runtime_inspect',
    'start_chat'
];

var GLOBAL_PERMISSION_KEYS = GLOBAL_READ_KEYS.concat(GLOBAL_WRITE_KEYS);

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
    if ((toolName === 'manage_skill' || toolName === 'workspace' || toolName === 'document') && methodOrAction) {
        return toolName + ':' + methodOrAction;
    }
    // Direct match for global tools
    return toolName;
}

// Check if a permission key is instance-scoped
function isInstancePermissionKey(key) {
    return INSTANCE_PERMISSION_KEYS.indexOf(key) !== -1;
}

// Check if a permission key is a read operation
function isReadPermissionKey(key) {
    return INSTANCE_READ_KEYS.indexOf(key) !== -1 || GLOBAL_READ_KEYS.indexOf(key) !== -1;
}
