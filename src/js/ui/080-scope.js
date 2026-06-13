// Load local scope override from localStorage
function loadLocalScopeOverride() {
    var stored = appStorage.getItem('appagent_local_scope');
    if (stored) {
        var data = JSON.parse(stored);
        localScopeOverride = data.scope;
        platformScope = data.platformScope || 'global';
    }
}

// Save local scope override to localStorage
function saveLocalScopeOverride() {
    if (localScopeOverride !== null) {
        appStorage.setItem('appagent_local_scope', JSON.stringify({
            scope: localScopeOverride,
            platformScope: platformScope
        }));
    } else {
        appStorage.removeItem('appagent_local_scope');
    }
}

// Fetch current scope from platform (lazy loaded when POST tool needs it)
// Detects if platform scope changed and resets local override if so
async function fetchCurrentScope() {
    var headers = { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' };
    try {
        // Use cached user sys_id if available
        var userId = cachedUserSysId;
        if (!userId) {
            var userResp = await fetch('/api/now/table/sys_user?sysparm_query=user_name=' + encodeURIComponent(window.NOW?.user_name || 'admin') + '&sysparm_fields=sys_id&sysparm_limit=1', { headers: headers });
            var userData = await userResp.json();
            userId = userData.result && userData.result[0] ? userData.result[0].sys_id : null;
            if (userId) cachedUserSysId = userId;
        }

        var fetchedPlatformScope = 'global';
        if (userId) {
            var prefResp = await fetch('/api/now/table/sys_user_preference?sysparm_query=user=' + userId + '^name=apps.current_app&sysparm_fields=value&sysparm_limit=1', { headers: headers });
            var prefData = await prefResp.json();
            if (prefData.result && prefData.result[0] && prefData.result[0].value) {
                fetchedPlatformScope = prefData.result[0].value;
            }
        }
        
        // Check if platform scope changed from what we knew
        if (platformScope !== fetchedPlatformScope) {
            platformScope = fetchedPlatformScope;
            // Reset local override when platform scope changes
            localScopeOverride = null;
            saveLocalScopeOverride();
        }
        
        // Use local override if set, otherwise use platform scope
        currentScope = localScopeOverride !== null ? localScopeOverride : platformScope;
        
        // Fetch scope name for display in settings panel
        if (currentScope && currentScope !== 'global') {
            var scopeNameResp = await fetch('/api/now/table/sys_scope?sysparm_query=sys_id=' + currentScope + '&sysparm_fields=name&sysparm_limit=1', { headers: headers });
            var scopeNameData = await scopeNameResp.json();
            if (scopeNameData.result && scopeNameData.result[0]) {
                window.currentScopeName = scopeNameData.result[0].name;
            }
        } else {
            window.currentScopeName = 'Global';
        }
        scopeFetched = true;
    } catch (e) {
        console.error('Failed to fetch current scope:', e);
    }
}

async function fetchAndPopulateScopeDropdown() {
    var container = document.getElementById('settings-scope-container');
    if (!container) return;
    
    // Show loading state immediately
    var currentSelectedScope = localScopeOverride !== null ? localScopeOverride : platformScope;
    var currentLabel = 'Loading...';
    if (currentSelectedScope === 'global') {
        currentLabel = 'Global';
    } else if (window.currentScopeName) {
        currentLabel = window.currentScopeName;
    }
    
    // Show loading state with a loading indicator
    container.innerHTML = '<div class="custom-dropdown-loading"><span class="dropdown-label">' + currentLabel + '</span><span class="dropdown-loading-spinner"></span></div>';
    
    var headers = { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' };
    
    try {
        // Fetch all application scopes that can be edited in studio
        var scopesResp = await fetch('/api/now/table/sys_scope?sysparm_fields=sys_id,scope,name&sysparm_query=can_edit_in_studio=true^ORDERBYname&sysparm_limit=200', { headers: headers });
        var scopesData = await scopesResp.json();
        
        // Determine which scope to show as selected (local override or platform)
        var selectedScope = localScopeOverride !== null ? localScopeOverride : platformScope;
        
        // Build options array
        var options = [{ value: 'global', label: 'Global' }];
        
        // Add all scopes
        if (scopesData.result) {
            scopesData.result.forEach(function(scope) {
                var label = scope.name || scope.scope;
                options.push({ value: scope.sys_id, label: label });
                if (selectedScope === scope.sys_id) {
                    window.currentScopeName = label;
                }
            });
        }
        
        // Render custom dropdown with search (scopes typically > 5)
        renderCustomSelect('settings-scope-container', options, selectedScope, changeScope, 'Select scope...');
    } catch (e) {
        console.error('Failed to fetch scopes:', e);
        renderCustomSelect('settings-scope-container', [{ value: 'global', label: 'Global' }], 'global', changeScope, 'Select scope...');
    }
}

// Change scope locally only - does NOT update platform
function changeScope(scopeId) {
    // If selecting the same as platform scope, clear local override
    if (scopeId === platformScope) {
        localScopeOverride = null;
    } else {
        localScopeOverride = scopeId;
    }
    currentScope = scopeId;
    scopeFetched = true; // User manually set scope
    saveLocalScopeOverride();
}
var changeLocalScope = changeScope; // Alias for settings page

function saveToolPermissions() {
    setSetting('toolPermissions', toolPermissions);
    // Mirror to the SW: the agent loop in offscreen has its own
    // `toolPermissions` global hydrated from IDB at boot; without this push,
    // post-boot mutations ("Always allow" from an approval prompt, reset to
    // defaults, settings-panel edits) would only take effect on the next SW
    // restart, so the prompt would keep firing.
    if (typeof pushPermissionsToOffscreen === 'function') {
        pushPermissionsToOffscreen({ toolPermissions: toolPermissions });
    }
}

function saveInstancePermissions() {
    setSetting('instancePermissions', instancePermissions);
    if (typeof pushPermissionsToOffscreen === 'function') {
        pushPermissionsToOffscreen({ instancePermissions: instancePermissions });
    }
    // Keep the header tier pill in sync with EVERY mutation path (settings
    // panel, instance-picker toggle, data import) — some callers don't call
    // updateSnStatus themselves, leaving a stale 'Manual'/'Auto' label.
    if (typeof updateSnStatus === 'function') updateSnStatus();
}
