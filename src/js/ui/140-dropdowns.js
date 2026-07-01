// Custom Dropdown/Radio Group Component
// Renders as radio group if options <= 3, otherwise as dropdown with search if options > 5
function renderCustomSelect(containerId, options, selectedValue, onChangeCallback, placeholder) {
    var container = document.getElementById(containerId);
    if (!container) return;
    
    placeholder = placeholder || 'Select...';
    
    // If 3 or fewer options, render as radio group
    if (options.length <= 3) {
        var html = '<div class="radio-group">';
        options.forEach(function(opt) {
            var isSelected = opt.value === selectedValue;
            html += '<div class="radio-option' + (isSelected ? ' selected' : '') + '" data-value="' + escapeHtml(opt.value) + '" ' +
                'onclick="event.stopPropagation(); selectRadioOption(\'' + containerId + '\', \'' + escapeJsString(opt.value) + '\', ' + onChangeCallback + ')">' +
                escapeHtml(opt.label) + '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
        return;
    }
    
    // Otherwise render as custom dropdown
    var selectedLabel = placeholder;
    options.forEach(function(opt) {
        if (opt.value === selectedValue) selectedLabel = opt.label;
    });
    
    var showSearch = options.length > 5;
    var dropdownId = containerId + '-dropdown';
    
    var html = '<div class="custom-dropdown" id="' + dropdownId + '">';
    html += '<div class="custom-dropdown-trigger" onclick="toggleCustomDropdown(\'' + dropdownId + '\')" tabindex="0">';
    html += '<span class="dropdown-label">' + escapeHtml(selectedLabel) + '</span>';
    html += '<span class="dropdown-arrow">' + UI_ICONS.chevronDown + '</span>';
    html += '</div>';
    html += '<div class="custom-dropdown-menu">';
    
    if (showSearch) {
        html += '<div class="custom-dropdown-search">';
        html += '<input type="text" placeholder="Search..." oninput="filterCustomDropdown(\'' + dropdownId + '\', this.value)" onclick="event.stopPropagation()">';
        html += '</div>';
    }
    
    html += '<div class="custom-dropdown-options">';
    options.forEach(function(opt) {
        var isSelected = opt.value === selectedValue;
        html += '<div class="custom-dropdown-option' + (isSelected ? ' selected' : '') + '" ' +
            'data-value="' + escapeHtml(opt.value) + '" data-label="' + escapeHtml(opt.label) + '" ' +
            'onclick="selectCustomDropdownOption(\'' + containerId + '\', \'' + dropdownId + '\', \'' + escapeJsString(opt.value) + '\', ' + onChangeCallback + ', event)">' +
            escapeHtml(opt.label) + '</div>';
    });
    html += '</div></div></div>';
    
    container.innerHTML = html;
}

function toggleCustomDropdown(dropdownId) {
    var dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    
    // Close other open dropdowns first
    document.querySelectorAll('.custom-dropdown.open').forEach(function(d) {
        if (d.id !== dropdownId) d.classList.remove('open');
    });
    
    dropdown.classList.toggle('open');
    
    // Focus search input if exists
    if (dropdown.classList.contains('open')) {
        var searchInput = dropdown.querySelector('.custom-dropdown-search input');
        if (searchInput) setTimeout(function() { searchInput.focus(); }, 50);
    }
}

function filterCustomDropdown(dropdownId, query) {
    var dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    
    var options = dropdown.querySelectorAll('.custom-dropdown-option');
    var q = query.toLowerCase();
    var hasVisible = false;
    
    options.forEach(function(opt) {
        var label = (opt.getAttribute('data-label') || '').toLowerCase();
        var match = label.indexOf(q) !== -1;
        opt.style.display = match ? 'block' : 'none';
        if (match) hasVisible = true;
    });
    
    // Show/hide empty message
    var optionsContainer = dropdown.querySelector('.custom-dropdown-options');
    var emptyMsg = dropdown.querySelector('.custom-dropdown-empty');
    if (!hasVisible && !emptyMsg) {
        optionsContainer.insertAdjacentHTML('beforeend', '<div class="custom-dropdown-empty">No matches found</div>');
    } else if (hasVisible && emptyMsg) {
        emptyMsg.remove();
    }
}

function selectCustomDropdownOption(containerId, dropdownId, value, callback, event) {
    if (event) event.stopPropagation();
    var dropdown = document.getElementById(dropdownId);
    if (dropdown) {
        dropdown.classList.remove('open');
        // Update the label. Iterate + compare instead of building an attribute
        // selector: the click-time value is the RAW string (post-#366), and a
        // value containing " or \ makes querySelector('[data-value="..."]')
        // throw a DOMException (invalid selector).
        var option = null;
        dropdown.querySelectorAll('.custom-dropdown-option').forEach(function(o) {
            if (!option && o.getAttribute('data-value') === value) option = o;
        });
        var label = option ? option.getAttribute('data-label') : value;
        var labelEl = dropdown.querySelector('.dropdown-label');
        if (labelEl) labelEl.textContent = label;
        // Update selected state
        dropdown.querySelectorAll('.custom-dropdown-option').forEach(function(o) {
            o.classList.toggle('selected', o.getAttribute('data-value') === value);
        });
    }
    if (callback) callback(value);
}

function selectRadioOption(containerId, value, callback) {
    var container = document.getElementById(containerId);
    if (container) {
        container.querySelectorAll('.radio-option').forEach(function(opt, idx) {
            // Get value from the options array via index or match text
            opt.classList.remove('selected');
        });
        // Find and select the clicked option
        container.querySelectorAll('.radio-option').forEach(function(opt) {
            if (opt.textContent.trim() === value || opt.getAttribute('data-value') === value) {
                opt.classList.add('selected');
            }
        });
    }
    if (callback) callback(value);
}

// Close custom dropdowns when clicking outside
document.addEventListener('click', function(e) {
    if (!e.target.closest('.custom-dropdown')) {
        document.querySelectorAll('.custom-dropdown.open').forEach(function(d) {
            d.classList.remove('open');
        });
    }
});

function renderToolPermissions() {
    var container = document.getElementById('tool-permissions-list');
    if (!container) return;

    var html = '';
    var host = getConnectedInstanceHost();
    var instPerms = host ? (instancePermissions[host] || { tier: 'manual', tools: {} }) : null;
    var isAutoTier = instPerms && instPerms.tier === 'auto';

    // Reset link (only when non-default)
    if (hasNonDefaultPermissions()) {
        html += '<div style="text-align:right;margin-bottom:var(--space-4);">';
        html += '<a href="#" onclick="event.preventDefault(); resetAllPermissionsToDefaults()" style="font-size:var(--text-caption);color:var(--text-muted);text-decoration:underline;">Reset to defaults</a>';
        html += '</div>';
    }

    // --- Instance section (top) ---
    var instanceTitle = host ? host.split('.')[0] : 'No instance connected';
    var disabledClass = host ? '' : ' disabled';

    html += '<div class="tool-permission-section' + disabledClass + '">';
    html += '<div class="tool-permission-section-header">';
    html += '<span class="tool-permission-section-title">' + UI_ICONS.api + ' ' + escapeHtml(instanceTitle) + '</span>';
    if (host) {
        html += '<div class="instance-tier-toggle" id="instance-tier-toggle"></div>';
    }
    html += '</div>';

    if (host) {
        // ServiceNow CRUD
        html += '<div class="tool-permission-group">';
        html += '<div class="tool-permission-group-title">ServiceNow API</div>';
        ['sn:read', 'sn:create', 'sn:update', 'sn:delete'].forEach(function(key) {
            html += _renderInstancePermItem(key, isAutoTier);
        });
        html += '</div>';

        // Browser (write actions)
        html += '<div class="tool-permission-group">';
        html += '<div class="tool-permission-group-title">Browser</div>';
        INSTANCE_PERMISSION_KEYS.filter(function(k) { return k.startsWith('browser:'); }).forEach(function(key) {
            html += _renderInstancePermItem(key, isAutoTier);
        });
        html += '</div>';
    }
    html += '</div>';

    // --- Global section (bottom) ---
    html += '<div class="tool-permission-section">';
    html += '<div class="tool-permission-section-header">';
    html += '<span class="tool-permission-section-title">' + UI_ICONS.tool + ' Global Tools</span>';
    html += '</div>';

    // Group: Manage Skills
    var manageSkillKeys = GLOBAL_PERMISSION_KEYS.filter(function(k) { return k.startsWith('manage_skill:'); });
    var workspaceKeys = GLOBAL_PERMISSION_KEYS.filter(function(k) { return k.startsWith('workspace:'); });
    var documentKeys = GLOBAL_PERMISSION_KEYS.filter(function(k) { return k.startsWith('document:'); });
    var otherGlobalKeys = GLOBAL_PERMISSION_KEYS.filter(function(k) {
        return !k.startsWith('manage_skill:') && !k.startsWith('workspace:') && !k.startsWith('document:');
    });

    // Other global tools
    otherGlobalKeys.forEach(function(key) {
        html += _renderGlobalPermItem(key);
    });

    // Manage Skill group
    html += '<div class="tool-permission-group">';
    html += '<div class="tool-permission-group-title">Manage Agent Skill</div>';
    manageSkillKeys.forEach(function(key) { html += _renderGlobalPermItem(key, true); });
    html += '</div>';

    // Workspace group
    html += '<div class="tool-permission-group">';
    html += '<div class="tool-permission-group-title">Workspace</div>';
    workspaceKeys.forEach(function(key) { html += _renderGlobalPermItem(key, true); });
    html += '</div>';

    // Document group
    html += '<div class="tool-permission-group">';
    html += '<div class="tool-permission-group-title">Smart Document</div>';
    documentKeys.forEach(function(key) { html += _renderGlobalPermItem(key, true); });
    html += '</div>';

    // Skill tools
    var skillToolKeys = [];
    var activeSkillIds = Object.keys(activeSkills);
    activeSkillIds.forEach(function(skillId) {
        var skill = skills[skillId];
        var skillToolsForSkill = skillTools[skillId] || {};
        var toolNames = Object.keys(skillToolsForSkill);
        if (toolNames.length > 0) {
            var skillName = skill ? (skill.name || skill.id) : skillId;
            html += '<div class="tool-permission-group">';
            html += '<div class="tool-permission-group-title">Skill: ' + escapeHtml(skillName) + '</div>';
            toolNames.forEach(function(toolName) {
                var permKey = 'skill:' + toolName;
                skillToolKeys.push(permKey);
                html += _renderGlobalPermItem(permKey, true);
            });
            html += '</div>';
        }
    });

    html += '</div>'; // end global section

    container.innerHTML = html;

    // Render tier toggle for instance
    if (host) {
        _renderInstanceTierToggle(instPerms ? instPerms.tier : 'manual');
    }

    // Render radio groups for instance permissions
    if (host) {
        INSTANCE_PERMISSION_KEYS.forEach(function(key) {
            var containerId = 'perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
            var perm = (instPerms && instPerms.tools && instPerms.tools[key]) ||
                (isReadPermissionKey(key) ? 'allow' : 'ask');
            _renderPermRadio(containerId, perm, key, true, isAutoTier);
        });
    }

    // Render radio groups for global permissions
    GLOBAL_PERMISSION_KEYS.concat(skillToolKeys).forEach(function(key) {
        var containerId = 'perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
        var perm = toolPermissions[key] || (isReadPermissionKey(key) ? 'allow' : 'auto');
        _renderPermRadio(containerId, perm, key, false, false);
    });
}

function _renderInstancePermItem(key, isAutoTier) {
    var displayName = TOOL_DISPLAY_NAMES[key] || key;
    var containerId = 'perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
    return '<div class="tool-permission-item tool-permission-subitem' + (isAutoTier ? ' tier-auto' : '') + '">' +
        '<span class="tool-permission-name">' + displayName + '</span>' +
        '<div class="tool-permission-control" id="' + containerId + '"></div>' +
    '</div>';
}

function _renderGlobalPermItem(key, isSubitem) {
    var displayName = TOOL_DISPLAY_NAMES[key] || key;
    var containerId = 'perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
    return '<div class="tool-permission-item' + (isSubitem ? ' tool-permission-subitem' : '') + '">' +
        '<span class="tool-permission-name">' + displayName + '</span>' +
        '<div class="tool-permission-control" id="' + containerId + '"></div>' +
    '</div>';
}

function _renderPermRadio(containerId, selectedValue, permKey, isInstance, isAutoTier) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var options = [
        { value: 'allow', label: 'Allow' },
        { value: 'auto', label: 'Auto' },
        { value: 'ask', label: 'Ask' },
        { value: 'disabled', label: 'Off' }
    ];

    var html = '<div class="radio-group radio-group-small' + (isAutoTier ? ' radio-group-disabled' : '') + '">';
    options.forEach(function(opt) {
        var isSelected = opt.value === selectedValue;
        var handler = isInstance ? 'setInstancePermFromRadio' : 'setGlobalPermFromRadio';
        html += '<div class="radio-option' + (isSelected ? ' selected' : '') + '" ' +
            'data-value="' + escapeHtml(opt.value) + '" ' +
            'onclick="event.stopPropagation(); ' + handler + '(\'' + escapeJsString(permKey) + '\', \'' + escapeJsString(opt.value) + '\', this)">' +
            escapeHtml(opt.label) + '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
}

function _renderInstanceTierToggle(currentTier) {
    var container = document.getElementById('instance-tier-toggle');
    if (!container) return;
    // Icon-only toggle with tooltips
    var manualSelected = currentTier === 'manual';
    container.innerHTML = '<div class="radio-group radio-group-small">' +
        '<div class="radio-option' + (manualSelected ? ' selected' : '') + '" title="Manual: You control each permission" ' +
            'onclick="event.stopPropagation(); setInstanceTier(\'manual\', this)">' + UI_ICONS.lock + ' Manual</div>' +
        '<div class="radio-option' + (!manualSelected ? ' selected' : '') + '" title="Auto: Agent decides for write operations" ' +
            'onclick="event.stopPropagation(); setInstanceTier(\'auto\', this)">' + UI_ICONS.sparkle + ' Auto</div>' +
    '</div>';
}

function setInstanceTier(tier, element) {
    var host = getConnectedInstanceHost();
    if (!host) return;
    if (!instancePermissions[host]) instancePermissions[host] = { tier: 'manual', tools: {} };
    instancePermissions[host].tier = tier;
    saveInstancePermissions();
    // Re-render the full permission list to update disabled state
    renderToolPermissions();
    // Update header to reflect new tier
    if (typeof updateSnStatus === 'function') updateSnStatus();
}

function setInstancePermFromRadio(permKey, value, element) {
    var parent = element.parentElement;
    parent.querySelectorAll('.radio-option').forEach(function(o) { o.classList.remove('selected'); });
    element.classList.add('selected');
    var host = getConnectedInstanceHost();
    if (!host) return;
    if (!instancePermissions[host]) instancePermissions[host] = { tier: 'manual', tools: {} };
    if (!instancePermissions[host].tools) instancePermissions[host].tools = {};
    instancePermissions[host].tools[permKey] = value;
    saveInstancePermissions();
}

function setGlobalPermFromRadio(permKey, value, element) {
    var parent = element.parentElement;
    parent.querySelectorAll('.radio-option').forEach(function(o) { o.classList.remove('selected'); });
    element.classList.add('selected');
    toolPermissions[permKey] = value;
    saveToolPermissions();
}

// Legacy compatibility
function renderPermissionRadioGroup(containerId, selectedValue, permKey) {
    _renderPermRadio(containerId, selectedValue, permKey, false, false);
}

function setToolPermissionFromRadio(permKey, value, element) {
    setGlobalPermFromRadio(permKey, value, element);
}

function getDisabledTools() {
    var disabled = [];
    // Check instance tools (direct key check)
    INSTANCE_PERMISSION_KEYS.forEach(function(key) {
        if (getInstanceToolPermission(key) === 'disabled') {
            disabled.push(key);
        }
    });
    // Check global tools
    GLOBAL_PERMISSION_KEYS.forEach(function(key) {
        if (toolPermissions[key] === 'disabled') {
            disabled.push(key);
        }
    });
    return disabled;
}

function getEnabledTools(chatId) {
    var baseTools = TOOLS.filter(function(tool) {
        var name = tool.function.name;
        // For servicenow_api, check if ALL CRUD ops are disabled
        if (name === 'servicenow_api') {
            var crudKeys = ['sn:read', 'sn:create', 'sn:update', 'sn:delete'];
            return !crudKeys.every(function(k) { return getInstanceToolPermission(k) === 'disabled'; });
        }
        // servicenow_diff_edit maps to sn:update
        if (name === 'servicenow_diff_edit') {
            return getInstanceToolPermission('sn:update') !== 'disabled';
        }
        // For iframe_tool, check if ALL browser keys are disabled
        if (name === 'iframe_tool') {
            var browserKeys = INSTANCE_PERMISSION_KEYS.filter(function(k) { return k.startsWith('browser:'); });
            return !browserKeys.every(function(k) { return getInstanceToolPermission(k) === 'disabled'; });
        }
        // Hide set_chat_title when autoTitle hook is disabled
        if (name === 'set_chat_title' && !hooksEnabled.autoTitle) return false;
        // Hide set_tldr when autoTldr hook is disabled
        if (name === 'set_tldr' && !hooksEnabled.autoTldr) return false;
        // Hide set_links when autoLinks hook is disabled
        if (name === 'set_links' && !hooksEnabled.autoLinks) return false;
        var perm = getToolPermission(name);
        return perm !== 'disabled';
    });
    
    // Add active skill tools
    var skillToolDefs = getActiveSkillTools();
    // Dedupe by name, core-first — keep in sync with worker-side
    // getEnabledTools in src/js/worker/025-permissions-helpers.js. A skill
    // tool shadowing a built-in name (e.g. stale IDB asset after a tool was
    // promoted to core) would otherwise cause "Tool names must be unique".
    var seenToolNames = {};
    baseTools.forEach(function(t) { seenToolNames[t.function.name] = true; });
    skillToolDefs = skillToolDefs.filter(function(t) {
        var n = t && t.function && t.function.name;
        if (!n || seenToolNames[n]) return false;
        seenToolNames[n] = true;
        return true;
    });
    var allTools = baseTools.concat(skillToolDefs);

    // Sub-agent / parent visibility filter. Honors the per-sub tool_roster
    // (which is now deterministic across spawns in a session — same parent
    // tool list minus the nested-delegation trio unless allow_nested:true),
    // and hides sub-only tools (report_to_parent / sleep_self) from parent
    // chats — they're useless outside a sub context and just waste tokens
    // + confuse the model. Optional chatId — when omitted (UI settings
    // preview, layout token counter), returns the unfiltered global list.
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

    // Add cache_control on the last tool so Anthropic caches the entire tools block
    if (allTools.length > 0) {
        var last = Object.assign({}, allTools[allTools.length - 1]);
        last.cache_control = { type: 'ephemeral' };
        allTools[allTools.length - 1] = last;
    }
    return allTools;
}

function getToolPermission(toolName, methodOrAction) {
    var permKey = resolvePermissionKey(toolName, methodOrAction);

    // Instance-scoped permissions
    if (isInstancePermissionKey(permKey)) {
        return getInstanceToolPermission(permKey);
    }

    // Global permissions
    // Check session permissions first (highest priority)
    if (sessionPermissions[permKey] === 'allow') return 'allow';

    // Then check stored permissions
    if (toolPermissions[permKey]) {
        return toolPermissions[permKey];
    }

    // Defaults: read → allow, write → auto
    return isReadPermissionKey(permKey) ? 'allow' : 'auto';
}

// Get effective permission for an instance-scoped tool
function getInstanceToolPermission(permKey) {
    var host = getConnectedInstanceHost();
    if (!host) {
        // No instance connected — read operations allow, write operations ask
        return isReadPermissionKey(permKey) ? 'allow' : 'ask';
    }

    var instPerms = instancePermissions[host];
    if (!instPerms) instPerms = { tier: 'manual', tools: {} };

    // Auto tier: ignore per-tool settings
    if (instPerms.tier === 'auto') {
        // Read → allow, Write → auto (agent decides via confirm)
        return isReadPermissionKey(permKey) ? 'allow' : 'auto';
    }

    // Manual tier: check session, then per-tool, then defaults
    if (sessionPermissions[permKey] === 'allow') return 'allow';
    if (instPerms.tools && instPerms.tools[permKey]) {
        return instPerms.tools[permKey];
    }

    // Manual defaults: read → allow, write → ask
    return isReadPermissionKey(permKey) ? 'allow' : 'ask';
}

// Get the connected instance hostname (e.g. 'dev12345.service-now.com')
function getConnectedInstanceHost() {
    if (typeof Platform !== 'undefined' && Platform.instanceUrl) {
        return Platform.instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    return null;
}

function getToolDisplayName(toolName, methodOrAction) {
    // Try specific tool:action first (for individual action names in UI)
    if (methodOrAction) {
        var specificKey = toolName + ':' + methodOrAction;
        if (TOOL_DISPLAY_NAMES[specificKey]) return TOOL_DISPLAY_NAMES[specificKey];
    }
    // Then try permission key (for CRUD display names like sn:read)
    var permKey = resolvePermissionKey(toolName, methodOrAction);
    if (TOOL_DISPLAY_NAMES[permKey]) return TOOL_DISPLAY_NAMES[permKey];
    return TOOL_DISPLAY_NAMES[toolName] || toolName;
}
