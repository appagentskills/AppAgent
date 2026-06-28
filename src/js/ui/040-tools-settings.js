// Tool Inspector Modal — view a tool's JSON schema and implementation source.
// Used from Settings page Tool Permissions section and from search.
function showToolInspector(toolName, skillId) {
    var existing = document.getElementById('tool-inspector-modal');
    if (existing) existing.remove();

    var schema, source, displayName, description;

    if (skillId && typeof skillTools !== 'undefined' && skillTools[skillId] && skillTools[skillId][toolName]) {
        var info = skillTools[skillId][toolName];
        schema = info.definition;
        source = info.code || null;
        displayName = toolName;
        description = (info.definition && info.definition.function && info.definition.function.description) || '';
    } else {
        var tool = TOOLS.find(function(t) { return t.function.name === toolName; });
        if (!tool) return;
        schema = tool;
        source = getToolFunctionSource(toolName);
        displayName = TOOL_DISPLAY_NAMES[toolName] || toolName;
        description = tool.function.description || '';
    }

    var schemaJson = JSON.stringify(schema.function || schema, null, 2);

    var overlay = document.createElement('div');
    overlay.id = 'tool-inspector-modal';
    overlay.className = 'modal-overlay show';
    overlay.onclick = function(e) { if (e.target === overlay) closeToolInspectorModal(); };

    overlay.innerHTML =
        '<div class="modal-dialog" style="max-width:720px;width:90vw;">' +
            '<div class="modal-header">' + escapeHtml(displayName) + '</div>' +
            '<div class="modal-body" style="display:flex;flex-direction:column;gap:var(--space-6);max-height:70vh;overflow-y:auto;">' +
                (description ? '<div style="font-size:var(--text-body-sm);color:var(--text-muted);">' + escapeHtml(description) + '</div>' : '') +
                '<div class="tool-code-section">' +
                    '<div class="tool-code-header">' +
                        '<strong style="font-size:var(--text-caption);color:var(--text-muted);">Tool Definition (JSON Schema)</strong>' +
                        '<button class="tool-code-copy-btn" onclick="copyInspectorContent(\'schema\')" title="Copy Schema">' + UI_ICONS.copy + '</button>' +
                    '</div>' +
                    '<pre class="tool-code-content" id="tool-inspector-schema">' + escapeHtml(schemaJson) + '</pre>' +
                '</div>' +
                (source ? '<div class="tool-code-section">' +
                    '<div class="tool-code-header">' +
                        '<strong style="font-size:var(--text-caption);color:var(--text-muted);">Implementation Source</strong>' +
                        '<button class="tool-code-copy-btn" onclick="copyInspectorContent(\'source\')" title="Copy Source">' + UI_ICONS.copy + '</button>' +
                    '</div>' +
                    '<pre class="tool-code-content" id="tool-inspector-source" style="max-height:400px;">' + escapeHtml(source) + '</pre>' +
                '</div>' : '') +
            '</div>' +
            '<div class="modal-actions">' +
                '<button class="modal-btn primary" onclick="closeToolInspectorModal()">Close</button>' +
            '</div>' +
        '</div>';

    document.body.appendChild(overlay);
}

function closeToolInspectorModal() {
    var modal = document.getElementById('tool-inspector-modal');
    if (modal) modal.remove();
}

function copyInspectorContent(type) {
    var el = document.getElementById('tool-inspector-' + type);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(function() {
        showSnackbar((type === 'source' ? 'Source' : 'Schema') + ' copied!', 'success');
    }).catch(function() {
        showSnackbar('Failed to copy', 'error');
    });
}

// Helper: render a small "view source" icon button for use in Settings rows / group titles.
function _toolSourceBtn(toolName, skillId) {
    var skillArg = skillId ? ', \'' + escapeJsString(skillId) + '\'' : '';
    return '<button class="tool-source-btn" onclick="event.stopPropagation(); showToolInspector(\'' +
        escapeJsString(toolName) + '\'' + skillArg + ')" title="View source: ' +
        escapeHtml(toolName) + '">' + UI_ICONS.code + '</button>';
}

function getToolFunctionSource(toolName) {
    // Map tool names to their implementation functions
    var toolFunctions = {
        'js_eval': 'executeTool (js_eval branch)',
        'servicenow_api': 'executeTool (servicenow_api branch)',
        'servicenow_diff_edit': executeDiffEdit,
        'iframe_tool': executeIframeTool,
        'set_chat_title': executeSetChatTitle,
        'set_tldr': executeSetTldr,
        'get_skill': executeGetSkill,
        'manage_skill': executeManageSkill,
        'html_widget': executeHtmlWidget
    };
    
    var fn = toolFunctions[toolName];
    if (typeof fn === 'function') {
        return fn.toString();
    } else if (typeof fn === 'string') {
        // For inline implementations, show the executeTool function
        return 'Implementation is inline in executeTool function.\nSee: ' + fn;
    }
    return null;
}


// Settings View Management
function toggleSettingsView() {
    if (currentView === 'settings-page') return;
    openSettingsPageView();
}

function openSettingsPageView() {
    currentView = 'settings-page';
    appStorage.setItem('currentView', 'settings-page');
    // SWM2-F3: left the chat view — clear this panel's focus entry so the SW
    // sub-agent GC doesn't keep the previously-viewed chat pinned (port-keyed).
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(null);
    hideAllPanels();
    var settingsPanel = document.getElementById('settings-page-panel');
    if (settingsPanel) { settingsPanel.style.display = 'flex'; renderSettingsPage(); }
    updateAllButtonStates();
    renderChatList();
    // Push browser history state
    pushHistoryState('settings-page', null);
}

function closeSettingsPageView() {
    currentView = 'chat';
    appStorage.setItem('currentView', 'chat');
    var settingsPanel = document.getElementById('settings-page-panel');
    if (settingsPanel) settingsPanel.style.display = 'none';
    showChatView();
    updateAllButtonStates();
}

function renderSettingsPage() {
    var container = document.getElementById('settings-page-content');
    if (!container) return;
    
    container.innerHTML =
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.git + ' GitHub</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Connect a GitHub account to clone repos, edit files, and push PRs from the workspace tool.</div>' +
            '<div id="github-settings-container"></div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title" style="display:flex;align-items:center;justify-content:space-between;">' +
                '<span>' + UI_ICONS.api + ' API Providers</span>' +
                '<button class="skills-action-btn" onclick="showAddApiProviderModal()" style="padding: var(--space-2) var(--space-5);font-size:var(--text-body-sm);">' + UI_ICONS.plus + ' Add</button>' +
            '</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Configure API providers. These are persisted and exported with your data.</div>' +
            '<div id="custom-api-providers-list"></div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.scope + ' Application Scope</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Current Scope</div><div class="settings-page-row-hint">Scope for creating new records</div></div>' +
                '<div id="settings-page-scope-container" class="settings-page-dropdown-container"></div>' +
            '</div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.display + ' Display</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Theme</div><div class="settings-page-row-hint">Choose light, dark, or follow your system preference</div></div>' +
                '<select onchange="setAppTheme(this.value)" style="padding: var(--space-2) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-body-sm);">' +
                    '<option value="system"' + (appTheme === 'system' ? ' selected' : '') + '>System</option>' +
                    '<option value="light"' + (appTheme === 'light' ? ' selected' : '') + '>Light</option>' +
                    '<option value="dark"' + (appTheme === 'dark' ? ' selected' : '') + '>Dark</option>' +
                '</select>' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Show API Statistics</div><div class="settings-page-row-hint">Display token usage and cost after API calls</div></div>' +
                '<input type="checkbox" ' + (showApiStats ? 'checked' : '') + ' onchange="toggleApiStats()">' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Compact Tool Calls</div><div class="settings-page-row-hint">Collapse all tool calls in a single area</div></div>' +
                '<input type="checkbox" ' + (compactToolCalls ? 'checked' : '') + ' onchange="toggleCompactToolCalls()">' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Keep Display Awake</div><div class="settings-page-row-hint">Prevent the screen from sleeping while the agent is actively running a task, and after 5 minutes of inactivity in AppAgent. Released when the task ends or the page is closed.</div></div>' +
                '<input type="checkbox" id="settings-keep-awake" ' + ((typeof window.getKeepAwakeForeverDisabled === 'function' && window.getKeepAwakeForeverDisabled()) ? '' : 'checked') + ' onchange="toggleKeepAwake(this.checked)">' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Screenshot Method</div><div class="settings-page-row-hint">Method used by the Agent to capture screenshots</div></div>' +
                '<select onchange="setScreenshotMethod(this.value)" style="padding: var(--space-2) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-body-sm);">' +
                    '<option value="html-to-image"' + (screenshotMethod === 'html-to-image' ? ' selected' : '') + '>html-to-image</option>' +
                    '<option value="display-media"' + (screenshotMethod === 'display-media' ? ' selected' : '') + '>Browser Display Media</option>' +
                '</select>' +
            '</div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.hook + ' Hooks</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Hooks run automatically after certain events.</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Auto-generate Chat Title</div><div class="settings-page-row-hint">Automatically generate a title after agent completes</div></div>' +
                '<input type="checkbox" ' + (hooksEnabled.autoTitle ? 'checked' : '') + ' onchange="toggleHook(\'autoTitle\')">' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Answer TL;DR Card</div><div class="settings-page-row-hint">Ask the agent for a short TL;DR after each answer, shown as a card at the end of the answer</div></div>' +
                '<input type="checkbox" ' + (hooksEnabled.autoTldr ? 'checked' : '') + ' onchange="toggleHook(\'autoTldr\')">' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Show Hook Messages</div><div class="settings-page-row-hint">Display hook messages and responses in chat</div></div>' +
                '<input type="checkbox" ' + (hooksEnabled.showHookMessages ? 'checked' : '') + ' onchange="toggleHook(\'showHookMessages\')">' +
            '</div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.cache + ' Large Content Caching</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Large results are automatically cached so the Agent can browse them without overwhelming the conversation. Default: 4K tokens.</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Cache Threshold</div><div class="settings-page-row-hint">Results larger than this are cached</div></div>' +
                '<div class="settings-input-group">' +
                    '<input type="number" id="settings-page-cache-limit" class="settings-number-input" min="1" max="100" value="' + Math.round(cacheTokenLimit / 1000) + '" onchange="updateCacheTokenLimitFromK(this.value)" />' +
                    '<span class="settings-input-suffix">K tokens</span>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.chat + ' System Prompt</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Customize the system prompt sent to the AI. Use placeholders like <code>{{SCOPE_CONTEXT}}</code>, <code>{{DISABLED_TOOLS}}</code>, <code>{{SKILLS_SUMMARY}}</code> which get replaced with actual values.</div>' +
            '<div id="system-prompt-editor-container"></div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.tool + ' Tool Permissions</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Control which tools can run automatically, require approval, or are disabled. Instance tools are per-instance, global tools apply everywhere.</div>' +
            '<div id="settings-tool-permissions"></div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.database + ' Data Management</div>' +
            '<div class="settings-page-row">' +
                '<button class="skills-action-btn" onclick="exportAllData()">' + UI_ICONS.download + ' Export Data</button>' +
                '<button class="skills-action-btn" onclick="importAllData()">' + UI_ICONS.upload + ' Import Data</button>' +
                '<button class="skills-action-btn danger" onclick="deleteAllData()">' + UI_ICONS.trash + ' Delete All</button>' +
            '</div>' +
        '</div>' +
        '<div class="settings-page-section" style="text-align:center;color:var(--text-muted);font-size:var(--text-body-sm);">' +
            '<div><strong>Version:</strong> v__VERSION__</div>' +
            '<div style="margin-top: var(--space-2);"><strong>License:</strong> Private and Commercial use. Internal modification permitted. Distribution and resale prohibited. All rights reserved.</div>' +
        '</div>';
    
    // Render scope dropdown - fetch scopes async
    fetchAndPopulateSettingsPageScopeDropdown();

    // Render tool permissions in settings
    renderSettingsToolPermissions();

    // Render system prompt editor
    renderSystemPromptEditor();

    // Render API providers list
    renderApiProvidersList();

    // Render GitHub settings
    renderGitHubSettings();
}

// GitHub settings UI
async function renderGitHubSettings() {
    var container = document.getElementById('github-settings-container');
    if (!container) return;
    var gh = await loadGitHubSettings();
    if (gh.user && gh.token) {
        // Connected state
        container.innerHTML =
            '<div class="settings-page-row" style="align-items:center;">' +
                '<div style="display:flex;align-items:center;gap:var(--space-4);">' +
                    (gh.user.avatar_url ? '<img src="' + escapeHtml(gh.user.avatar_url) + '&s=32" style="width:32px;height:32px;border-radius:50%;" />' : '') +
                    '<div>' +
                        '<div class="settings-page-row-label">' + escapeHtml(gh.user.login) + '</div>' +
                        '<div class="settings-page-row-hint">' + escapeHtml(gh.instanceUrl || 'https://github.com') + '</div>' +
                    '</div>' +
                '</div>' +
                '<button class="skills-action-btn danger" onclick="disconnectGitHub()">Disconnect</button>' +
            '</div>' +
            '<div style="margin-top:var(--space-8);">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">' +
                    '<div class="settings-page-row-label">Repositories</div>' +
                '</div>' +
                '<div id="github-repos-list" style="margin-bottom:var(--space-4);"></div>' +
                '<div style="display:flex;gap:var(--space-4);align-items:center;">' +
                    '<input type="text" id="github-add-repo-input" placeholder="owner/repo" style="flex:1;padding:var(--space-2) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-body-sm);background:var(--bg-secondary);color:var(--text-primary);" onkeydown="if(event.key===\'Enter\')cloneGitHubRepo()" />' +
                    '<input type="text" id="github-add-branch-input" placeholder="branch (optional)" style="width:130px;padding:var(--space-2) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-body-sm);background:var(--bg-secondary);color:var(--text-primary);" onkeydown="if(event.key===\'Enter\')cloneGitHubRepo()" />' +
                    '<button class="skills-action-btn" onclick="cloneGitHubRepo()">Clone</button>' +
                '</div>' +
                '<div id="github-clone-status" style="font-size:var(--text-body-sm);margin-top:var(--space-2);"></div>' +
            '</div>' +
            '<div class="settings-page-row" style="margin-top:var(--space-8);align-items:center;">' +
                '<div><div class="settings-page-row-label">Extension Deploy Folder</div><div class="settings-page-row-hint">Point to your unpacked extension directory. Find it at <code>chrome://extensions</code> → your extension → the path shown under "ID".</div></div>' +
                '<button class="skills-action-btn" id="deploy-dir-btn" onclick="connectDeployDir()">Connect Folder</button>' +
            '</div>';
        renderGitHubReposList();
        updateDeployDirButton();
    } else {
        // Not connected — show form
        var instanceVal = gh.instanceUrl || 'https://github.com';
        container.innerHTML =
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Instance URL</div><div class="settings-page-row-hint">Use https://github.com for public GitHub</div></div>' +
                '<input type="text" id="github-instance-url" value="' + escapeHtml(instanceVal) + '" placeholder="https://github.com" style="width:260px;padding:var(--space-2) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-body-sm);background:var(--bg-secondary);color:var(--text-primary);" />' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Personal Access Token</div><div class="settings-page-row-hint">Requires <code>repo</code> scope</div></div>' +
                '<input type="password" id="github-pat-input" placeholder="ghp_..." style="width:260px;padding:var(--space-2) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-body-sm);background:var(--bg-secondary);color:var(--text-primary);" />' +
            '</div>' +
            '<div class="settings-page-row" style="justify-content:flex-end;gap:var(--space-4);">' +
                '<a id="github-generate-link" href="#" target="_blank" onclick="openGitHubTokenPage(event)" style="font-size:var(--text-body-sm);color:var(--accent);">Generate token</a>' +
                '<button class="skills-action-btn" id="github-connect-btn" onclick="connectGitHub()">Connect</button>' +
            '</div>' +
            '<div id="github-status-msg" style="font-size:var(--text-body-sm);margin-top:var(--space-2);"></div>';
    }
}

function openGitHubTokenPage(e) {
    e.preventDefault();
    var instanceInput = document.getElementById('github-instance-url');
    var instanceUrl = (instanceInput && instanceInput.value.trim()) || 'https://github.com';
    var url = instanceUrl.replace(/\/$/, '') + '/settings/tokens/new?scopes=repo&description=AppAgent';
    window.open(url, '_blank');
}

async function connectGitHub() {
    var btn = document.getElementById('github-connect-btn');
    var statusMsg = document.getElementById('github-status-msg');
    var tokenInput = document.getElementById('github-pat-input');
    var instanceInput = document.getElementById('github-instance-url');
    if (!tokenInput || !tokenInput.value.trim()) {
        if (statusMsg) { statusMsg.style.color = 'var(--danger)'; statusMsg.textContent = 'Please enter a token'; }
        return;
    }
    var token = tokenInput.value.trim();
    var instanceUrl = (instanceInput && instanceInput.value.trim()) || 'https://github.com';
    if (btn) btn.disabled = true;
    if (statusMsg) { statusMsg.style.color = 'var(--text-muted)'; statusMsg.textContent = 'Validating...'; }
    var result = await validateGitHubToken(token, instanceUrl);
    if (result.ok) {
        await saveGitHubSettings(token, instanceUrl, { login: result.login, avatar_url: result.avatar_url, name: result.name });
        renderGitHubSettings();
    } else {
        if (btn) btn.disabled = false;
        if (statusMsg) { statusMsg.style.color = 'var(--danger)'; statusMsg.textContent = result.error || 'Connection failed'; }
    }
}

async function disconnectGitHub() {
    await clearGitHubSettings();
    renderGitHubSettings();
}

async function connectDeployDir() {
    var handle = await pickDeployDir();
    if (handle) {
        updateDeployDirButton();
        // The Reload button is only meaningful in extension-dev mode — reveal it now
        // that a deploy folder is connected.
        if (typeof updateReloadBtnVisibility === 'function') updateReloadBtnVisibility();
    }
}

async function updateDeployDirButton() {
    var btn = document.getElementById('deploy-dir-btn');
    if (!btn) return;
    var handle = await getDeployDirHandle();
    if (handle) {
        btn.textContent = handle.name;
        btn.classList.add('connected');
    } else {
        btn.textContent = 'Connect Folder';
        btn.classList.remove('connected');
    }
}

// GitHub repos list in settings
async function renderGitHubReposList() {
    var container = document.getElementById('github-repos-list');
    if (!container) return;
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceMetaStoreName], 'readonly');
        var store = tx.objectStore(workspaceMetaStoreName);
        var request = store.getAll();
        var repos = await new Promise(function(r) { request.onsuccess = function() { r(request.result || []); }; request.onerror = function() { r([]); }; });

        if (repos.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:var(--text-body-sm);padding:var(--space-4) 0;">No repositories cloned yet.</div>';
            return;
        }

        // Check remote HEAD for each repo (non-blocking — render first, update after)
        var html = '';
        var repoData = [];
        for (var i = 0; i < repos.length; i++) {
            var meta = repos[i];
            var wk = meta.repo; // workspace key (owner/repo::branch)
            var githubRepo = meta.github_repo || parseWsKey(wk).repo;
            var files = await getAllWorkspaceFiles(wk);
            var totalFiles = files.length;
            var isIgnored = await wsGetIgnoreFilter(wk);
            var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
            var dirtyCount = dirtyFiles.length;
            var totalSize = 0;
            files.forEach(function(f) { totalSize += (f.content || '').length; });
            var sizeStr = totalSize > 1048576 ? (totalSize / 1048576).toFixed(1) + ' MB' : totalSize > 1024 ? (totalSize / 1024).toFixed(0) + ' KB' : totalSize + ' B';

            // Determine status label and PR info
            var pushedPrs = {};
            dirtyFiles.forEach(function(f) {
                if (f.pushed_pr && f.pushed_pr.url) {
                    var key = f.pushed_pr.url;
                    if (!pushedPrs[key]) pushedPrs[key] = { pr: f.pushed_pr, files: [] };
                    pushedPrs[key].files.push(f.path);
                }
            });
            var prLinks = Object.keys(pushedPrs).map(function(key) { return pushedPrs[key]; });

            // Count files that are dirty but NOT pushed to any PR (truly local-only changes)
            var unpushedDirty = dirtyFiles.filter(function(f) { return !f.pushed_pr; });

            repoData.push({ meta: meta, wk: wk, githubRepo: githubRepo, totalFiles: totalFiles, dirtyFiles: dirtyFiles, dirtyCount: dirtyCount, sizeStr: sizeStr, prLinks: prLinks, unpushedDirty: unpushedDirty });
        }

        for (var ri = 0; ri < repoData.length; ri++) {
            var rd = repoData[ri];

            // Remote sync status — always checked async
            var syncSpanId = 'repo-sync-' + ri;

            // Dirty count for header line
            var dirtyLabel = rd.dirtyCount > 0 ? '<span style="color:var(--warning);">' + rd.dirtyCount + ' modified</span>' : '';

            // File rows (same style as header dropdown)
            var detailHtml = '<div id="repo-detail-' + ri + '" style="margin-top:var(--space-2);">';
            if (rd.dirtyCount > 0) {
                detailHtml += rd.dirtyFiles.map(function(f) {
                    var badge = f.deleted ? '<span class="ws-file-badge deleted">deleted</span>' :
                        (!f.sha && !f.deleted) ? '<span class="ws-file-badge new">new</span>' :
                        '<span class="ws-file-badge modified">modified</span>';
                    var prLink = '';
                    if (f.pushed_pr && f.pushed_pr.url) {
                        prLink = '<a class="ws-file-pr" href="' + escapeHtml(f.pushed_pr.url) + '" target="_blank">PR #' + f.pushed_pr.number + '</a>';
                    }
                    return '<div class="ws-file-row">' +
                        '<span class="ws-file-path" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span>' +
                        badge + prLink + '</div>';
                }).join('');
            }
            detailHtml += '</div>';

            html += '<div class="settings-page-row" style="padding:var(--space-4) 0;border-bottom:1px solid var(--border);align-items:flex-start;">' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="display:flex;align-items:center;gap:var(--space-4);">' +
                        '<div class="settings-page-row-label" style="margin:0;">' + escapeHtml(rd.githubRepo) + '</div>' +
                        '<span style="font-size:var(--text-caption);color:var(--text-muted);background:var(--bg-tertiary);padding:1px var(--space-3);border-radius:var(--radius-sm);">' + escapeHtml(rd.meta.branch) + '</span>' +
                    '</div>' +
                    '<div style="font-size:var(--text-caption);color:var(--text-muted);margin-top:var(--space-2);display:flex;gap:var(--space-6);flex-wrap:wrap;">' +
                        '<span>' + rd.totalFiles + ' files</span>' +
                        '<span>' + rd.sizeStr + '</span>' +
                        '<span id="' + syncSpanId + '" style="color:var(--text-muted);">checking...</span>' +
                        '<span id="repo-dirty-' + ri + '">' + dirtyLabel + '</span>' +
                    '</div>' +
                    detailHtml +
                '</div>' +
                '<div style="display:flex;gap:var(--space-3);align-items:center;flex-shrink:0;">' +
                    '<button class="skills-action-btn" onclick="_toggleWorkspacePinFromUi(\'' + escapeJsString(rd.wk) + '\')" title="' + (rd.meta.pinned ? 'Pinned — Reload and default resolution use this workspace. Click to unpin.' : 'Pin this workspace (Reload + default resolution will use it)') + '" style="padding:var(--space-1) var(--space-4);font-size:var(--text-caption);' + (rd.meta.pinned ? '' : 'opacity:0.4;filter:grayscale(1);') + '">\uD83D\uDCCC</button>' +
                    '<button class="skills-action-btn" onclick="recloneGitHubRepo(\'' + escapeJsString(rd.githubRepo) + '\', \'' + escapeJsString(rd.meta.branch) + '\')" title="Re-clone (fetch latest)" style="padding:var(--space-1) var(--space-4);font-size:var(--text-caption);">' + UI_ICONS.refresh + '</button>' +
                    '<button class="skills-action-btn danger" onclick="deleteGitHubRepo(\'' + escapeJsString(rd.wk) + '\')" title="Delete local clone" style="padding:var(--space-1) var(--space-4);font-size:var(--text-caption);">' + UI_ICONS.trash + '</button>' +
                '</div>' +
            '</div>';
        }
        container.innerHTML = html;

        // Smart sync for ALL repos (async, update in place)
        for (var ci = 0; ci < repoData.length; ci++) {
            (function(idx, rd) {
                var el = document.getElementById('repo-sync-' + idx);
                if (!el) return;
                wsSyncWithRemote(rd.wk).then(function(syncResult) {
                    if (!el || !el.parentNode) return;
                    if (syncResult && syncResult.deleted) {
                        // Workspace auto-removed (merged head branch) — drop its row.
                        var _rowEl = el.closest('.settings-page-row');
                        if (_rowEl) _rowEl.remove();
                        // The auto-delete pulled the BASE workspace internally — its
                        // racing sibling sync may have painted a stale "behind".
                        _refreshBaseRowAfterAutoDelete(syncResult, repoData);
                        return;
                    }
                    if (!syncResult) {
                        el.style.color = 'var(--text-muted)'; el.textContent = 'offline';
                        return;
                    }
                    var parts = [];
                    if (syncResult.behind) {
                        el.style.color = 'var(--warning)';
                        if (syncResult.behindFiles && syncResult.behindFiles.length > 0)
                            parts.push(syncResult.behindFiles.length + ' behind');
                        if (syncResult.conflictFiles && syncResult.conflictFiles.length > 0)
                            parts.push(syncResult.conflictFiles.length + ' conflict');
                        el.textContent = parts.length > 0 ? parts.join(' · ') : 'behind remote';
                    } else {
                        el.style.color = 'var(--success)';
                        el.textContent = 'up to date';
                    }
                    // Re-render file list after sync
                    wsGetIgnoreFilter(rd.wk).then(function(isIgnored) {
                        getAllWorkspaceFiles(rd.wk).then(function(freshFiles) {
                            var freshDirty = freshFiles.filter(function(f) { return f.dirty && !isIgnored(f.path); });
                            var countEl = document.getElementById('repo-dirty-' + idx);
                            if (countEl) {
                                countEl.innerHTML = freshDirty.length > 0 ? '<span style="color:var(--warning);">' + freshDirty.length + ' modified</span>' : '';
                            }
                            var detailEl = document.getElementById('repo-detail-' + idx);
                            if (detailEl) {
                                var rows = freshDirty.map(function(f) {
                                    var badge = f.deleted ? '<span class="ws-file-badge deleted">deleted</span>' :
                                        (!f.sha && !f.deleted) ? '<span class="ws-file-badge new">new</span>' :
                                        '<span class="ws-file-badge modified">modified</span>';
                                    var prLink = f.pushed_pr && f.pushed_pr.url ?
                                        '<a class="ws-file-pr" href="' + escapeHtml(f.pushed_pr.url) + '" target="_blank">PR #' + f.pushed_pr.number + '</a>' : '';
                                    return '<div class="ws-file-row">' +
                                        '<span class="ws-file-path" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span>' +
                                        badge + prLink + '</div>';
                                }).join('');
                                // Add behind/conflict files
                                if (syncResult.behindFiles) {
                                    rows += syncResult.behindFiles.map(function(bf) {
                                        var label = bf.remoteDeleted ? 'deleted on remote' : bf.isNew ? 'new on remote' : 'behind';
                                        return '<div class="ws-file-row"><span class="ws-file-path" title="' + escapeHtml(bf.path) + '">' + escapeHtml(bf.path) + '</span><span class="ws-file-badge behind">' + label + '</span></div>';
                                    }).join('');
                                }
                                if (syncResult.conflictFiles) {
                                    rows += syncResult.conflictFiles.map(function(cf) {
                                        return '<div class="ws-file-row"><span class="ws-file-path" title="' + escapeHtml(cf.path) + '">' + escapeHtml(cf.path) + '</span><span class="ws-file-badge conflict">conflict</span></div>';
                                    }).join('');
                                }
                                detailEl.innerHTML = rows;
                            }
                        });
                    });
                }).catch(function() {
                    if (el && el.parentNode) { el.style.color = 'var(--text-muted)'; el.textContent = 'offline'; }
                });
            })(ci, repoData[ci]);
        }
    } catch (e) {
        container.innerHTML = '<div style="color:var(--danger);font-size:var(--text-body-sm);">Error loading repos: ' + escapeHtml(e.message) + '</div>';
    }
}

// After a merge-lifecycle auto-delete, the engine has already synced+pulled
// the BASE workspace — repaint its (possibly stale) row in the settings list
// so the user doesn't see a lingering "N behind" badge.
function _refreshBaseRowAfterAutoDelete(syncResult, repoData) {
    if (!syncResult || !syncResult.base_synced || !syncResult.base_workspace) return;
    for (var bi = 0; bi < repoData.length; bi++) {
        if (repoData[bi].wk !== syncResult.base_workspace) continue;
        var bEl = document.getElementById('repo-sync-' + bi);
        if (bEl) { bEl.style.color = 'var(--success)'; bEl.textContent = 'up to date'; }
        var bDetail = document.getElementById('repo-detail-' + bi);
        if (bDetail) {
            var staleBadges = bDetail.querySelectorAll('.ws-file-badge.behind');
            for (var sj = staleBadges.length - 1; sj >= 0; sj--) {
                var staleRow = staleBadges[sj].closest('.ws-file-row');
                if (staleRow) staleRow.remove();
            }
        }
        break;
    }
}

async function cloneGitHubRepo() {
    var repoInput = document.getElementById('github-add-repo-input');
    var branchInput = document.getElementById('github-add-branch-input');
    var statusEl = document.getElementById('github-clone-status');
    if (!repoInput || !repoInput.value.trim()) {
        if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = 'Enter a repo (owner/repo)'; }
        return;
    }
    var repo = repoInput.value.trim();
    var branch = (branchInput && branchInput.value.trim()) || undefined;
    if (repo.indexOf('/') === -1) {
        if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = 'Format: owner/repo'; }
        return;
    }
    if (statusEl) { statusEl.style.color = 'var(--text-muted)'; statusEl.textContent = 'Cloning ' + repo + '...'; }
    try {
        var result = await wsClone(repo, branch);
        if (result.success) {
            if (statusEl) { statusEl.style.color = 'var(--success)'; statusEl.textContent = result.message; }
            repoInput.value = '';
            if (branchInput) branchInput.value = '';
            renderGitHubReposList();
        } else {
            if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = result.error; }
        }
    } catch (e) {
        if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = e.message; }
    }
}

async function recloneGitHubRepo(repo, branch) {
    var statusEl = document.getElementById('github-clone-status');
    if (statusEl) { statusEl.style.color = 'var(--text-muted)'; statusEl.textContent = 'Re-cloning ' + repo + '...'; }
    try {
        var result = await wsClone(repo, branch);
        if (result.success) {
            if (statusEl) { statusEl.style.color = 'var(--success)'; statusEl.textContent = result.message; }
            renderGitHubReposList();
        } else {
            if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = result.error; }
        }
    } catch (e) {
        if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = e.message; }
    }
}

async function deleteGitHubRepo(repo) {
    await deleteWorkspaceFiles(repo);
    await deleteWorkspaceMeta(repo);
    try { gcWorkspaceBlobs(); } catch (e) {}
    refreshWorkspaceContext();
    updateWorkspaceHeaderStatus();
    renderGitHubReposList();
}

// ============================================
// Workspace header status indicator + dropdown
// ============================================
var _wsDropdown = null;
var _wsHeaderCaches = {}; // map of wk -> { wk, meta, dirtyCount, dirtyFiles, syncStatus, behindFiles, conflictFiles }
// True only in extension-dev mode (the extension_build skill tool is loaded AND a deploy
// folder is connected) — the same gate the Reload button uses. Resolved (async) when the
// dropdown opens and then read synchronously by _renderDropdownSection to decide whether
// to show the per-repo pin button.
var _wsExtDevMode = false;

// Helper: get summary for all workspaces (local only, no remote sync)
async function getAllWorkspaceSummaries() {
    var all = await getAllWorkspaceMetas();
    var summaries = [];
    for (var i = 0; i < all.length; i++) {
        var meta = all[i];
        var wk = meta.repo;
        var files = await getAllWorkspaceFiles(wk);
        var isIgnored = await wsGetIgnoreFilter(wk);
        var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
        var prev = _wsHeaderCaches[wk];
        summaries.push({
            wk: wk,
            meta: meta,
            dirtyCount: dirtyFiles.length,
            dirtyFiles: dirtyFiles,
            syncStatus: prev ? prev.syncStatus : 'unknown',
            behindFiles: prev ? prev.behindFiles || [] : [],
            conflictFiles: prev ? prev.conflictFiles || [] : []
        });
    }
    return summaries;
}

// The merge auto-delete synced+pulled the base workspace inside the FORK's
// sync — reset the base's cached sync state so a stale "behind" (painted by
// a racing sibling sync) doesn't linger on the header badge/dropdown.
function _resetBaseCacheAfterAutoDelete(syncResult) {
    var bw = syncResult && syncResult.base_workspace;
    if (!bw || !syncResult.base_synced || !_wsHeaderCaches[bw]) return;
    _wsHeaderCaches[bw].syncStatus = 'up-to-date';
    _wsHeaderCaches[bw].behindFiles = [];
    _wsHeaderCaches[bw].conflictFiles = [];
}

// Render header badge text from caches
function _renderWsHeaderBadge() {
    var els = [document.getElementById('ws-header-status'), document.getElementById('home-ws-header-status')];
    if (!els[0] && !els[1]) return;
    var gitBranch = typeof UI_ICONS !== 'undefined' ? UI_ICONS.gitBranch : '';

    var keys = Object.keys(_wsHeaderCaches);
    if (keys.length === 0) {
        els.forEach(function(el) { if (el) el.style.display = 'none'; });
        return;
    }

    var totalDirty = 0;
    var reposWithChanges = 0;
    var anyBehind = false;
    keys.forEach(function(k) {
        var c = _wsHeaderCaches[k];
        totalDirty += c.dirtyCount;
        if (c.dirtyCount > 0) reposWithChanges++;
        if (c.syncStatus === 'behind') anyBehind = true;
    });

    els.forEach(function(el) {
        if (!el) return;
        if (anyBehind) {
            el.className = 'ws-header-status modified';
            el.innerHTML = '<span class="ws-icon">' + gitBranch + '</span>behind';
        } else if (totalDirty > 0) {
            el.className = 'ws-header-status modified';
            var label = reposWithChanges > 1
                ? reposWithChanges + ' repos · ' + totalDirty + ' modified'
                : totalDirty + ' modified';
            el.innerHTML = '<span class="ws-icon">' + gitBranch + '</span>' + label;
        } else {
            el.className = 'ws-header-status synced';
            el.innerHTML = '<span class="ws-icon">' + gitBranch + '</span>clean';
        }
        el.style.display = '';
    });
}

// Quick local-only header update (no remote sync, fire-and-forget safe)
async function updateWorkspaceHeaderStatus() {
    try {
        var summaries = await getAllWorkspaceSummaries();
        _wsHeaderCaches = {};
        summaries.forEach(function(s) { _wsHeaderCaches[s.wk] = s; });
        _renderWsHeaderBadge();
    } catch (e) {
        var els = [document.getElementById('ws-header-status'), document.getElementById('home-ws-header-status')];
        els.forEach(function(el) { if (el) el.style.display = 'none'; });
    }
}

// Full sync with remote for all workspaces + update header (awaitable)
async function syncAndUpdateWorkspaceHeader() {
    try {
        var summaries = await getAllWorkspaceSummaries();
        _wsHeaderCaches = {};
        summaries.forEach(function(s) { _wsHeaderCaches[s.wk] = s; });
        _renderWsHeaderBadge();

        // Sync all repos in parallel
        await Promise.all(summaries.map(function(s) {
            return wsSyncWithRemote(s.wk).then(async function(syncResult) {
                if (syncResult && syncResult.deleted) {
                    // Workspace auto-removed (merged head branch) — drop from caches.
                    delete _wsHeaderCaches[s.wk];
                    _resetBaseCacheAfterAutoDelete(syncResult);
                    _renderWsHeaderBadge();
                    return;
                }
                var syncStatus = !syncResult ? 'offline' : syncResult.behind ? 'behind' : (syncResult.dirty_remaining > 0 ? 'modified' : 'up-to-date');
                // Re-read after sync (files may have been cleaned)
                var meta = await getWorkspaceMeta(s.wk);
                var isIgnored = await wsGetIgnoreFilter(s.wk);
                var files = await getAllWorkspaceFiles(s.wk);
                var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
                _wsHeaderCaches[s.wk] = {
                    wk: s.wk, meta: meta, dirtyCount: dirtyFiles.length, dirtyFiles: dirtyFiles,
                    syncStatus: syncStatus,
                    behindFiles: syncResult ? syncResult.behindFiles || [] : [],
                    conflictFiles: syncResult ? syncResult.conflictFiles || [] : []
                };
                _renderWsHeaderBadge();
            }).catch(function() {
                _wsHeaderCaches[s.wk].syncStatus = 'offline';
            });
        }));
    } catch (e) {
        var els = [document.getElementById('ws-header-status'), document.getElementById('home-ws-header-status')];
        els.forEach(function(el) { if (el) el.style.display = 'none'; });
    }
}

async function toggleWorkspaceDropdown() {
    if (_wsDropdown) { hideWorkspaceDropdown(); return; }
    // Resolve extension-dev mode once (async) so the synchronous section render can gate
    // the pin button on it — same condition the Reload button is shown under.
    try { _wsExtDevMode = (typeof _reloadRebuildsFromWorkspace === 'function') ? await _reloadRebuildsFromWorkspace() : false; }
    catch (e) { _wsExtDevMode = false; }
    // Show dropdown immediately with cached/local data, then sync in background
    await updateWorkspaceHeaderStatus();
    showWorkspaceDropdown();
    // Background sync — update dropdown sections progressively
    _syncDropdownInBackground();
}

async function _syncDropdownInBackground() {
    var keys = Object.keys(_wsHeaderCaches);
    await Promise.all(keys.map(function(wk) {
        return wsSyncWithRemote(wk).then(async function(syncResult) {
            if (syncResult && syncResult.deleted) {
                // Workspace auto-removed (merged head branch). Drop it from the
                // dropdown + caches and refresh the badge.
                delete _wsHeaderCaches[wk];
                if (_wsDropdown) {
                    var _goneSection = _wsDropdown.querySelector('[data-ws="' + CSS.escape(wk) + '"]');
                    if (_goneSection) _goneSection.remove();
                }
                _resetBaseCacheAfterAutoDelete(syncResult);
                if (_wsDropdown && syncResult.base_workspace && _wsHeaderCaches[syncResult.base_workspace]) {
                    var _bSection = _wsDropdown.querySelector('[data-ws="' + CSS.escape(syncResult.base_workspace) + '"]');
                    if (_bSection) _renderDropdownSection(_bSection, _wsHeaderCaches[syncResult.base_workspace]);
                }
                _renderWsHeaderBadge();
                return;
            }
            var syncStatus = !syncResult ? 'offline' : syncResult.behind ? 'behind' : (syncResult.dirty_remaining > 0 ? 'modified' : 'up-to-date');
            var meta = await getWorkspaceMeta(wk);
            var isIgnored = await wsGetIgnoreFilter(wk);
            var files = await getAllWorkspaceFiles(wk);
            var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
            _wsHeaderCaches[wk] = {
                wk: wk, meta: meta, dirtyCount: dirtyFiles.length, dirtyFiles: dirtyFiles,
                syncStatus: syncStatus,
                behindFiles: syncResult ? syncResult.behindFiles || [] : [],
                conflictFiles: syncResult ? syncResult.conflictFiles || [] : []
            };
            _renderWsHeaderBadge();
            // Re-render dropdown section for this repo if still open
            if (_wsDropdown) {
                var section = _wsDropdown.querySelector('[data-ws="' + CSS.escape(wk) + '"]');
                if (section) _renderDropdownSection(section, _wsHeaderCaches[wk]);
            }
        }).catch(function() {
            if (_wsHeaderCaches[wk]) _wsHeaderCaches[wk].syncStatus = 'offline';
            if (_wsDropdown) {
                var section = _wsDropdown.querySelector('[data-ws="' + CSS.escape(wk) + '"]');
                if (section) _renderDropdownSection(section, _wsHeaderCaches[wk]);
            }
        });
    }));
}

function hideWorkspaceDropdown() {
    if (_wsDropdown) {
        _wsDropdown.remove();
        _wsDropdown = null;
        document.removeEventListener('click', _onClickOutsideWsDropdown, true);
    }
}

function _onClickOutsideWsDropdown(e) {
    if (_wsDropdown && !_wsDropdown.contains(e.target) && !e.target.closest('#ws-header-status') && !e.target.closest('#home-ws-header-status')) {
        hideWorkspaceDropdown();
    }
}

function _getSyncLabel(syncStatus) {
    return syncStatus === 'up-to-date' ? '<span class="ws-sync up-to-date">✓ synced</span>' :
        syncStatus === 'behind' ? '<span class="ws-sync behind">behind remote</span>' :
        syncStatus === 'modified' ? '<span class="ws-sync behind">local changes</span>' :
        syncStatus === 'offline' ? '<span class="ws-sync">offline</span>' :
        '<span class="ws-sync">syncing…</span>';
}

// Pin button HTML — filled (full opacity) for the pinned workspace, dimmed
// for the rest. Clicks are handled by the dropdown's delegated listener
// (showWorkspaceDropdown) via the data-pin-ws attribute.
function _wsPinBtnHtml(wk, pinned) {
    return '<button class="ws-pin-btn" data-pin-ws="' + escapeHtml(wk) + '" title="' +
        (pinned ? 'Pinned — Reload and default workspace resolution use this workspace. Click to unpin.' : 'Pin this workspace — Reload and default workspace resolution will use it.') +
        '" style="background:none;border:none;cursor:pointer;padding:0 var(--space-2);font-size:12px;line-height:1;vertical-align:middle;' +
        (pinned ? '' : 'opacity:0.3;filter:grayscale(1);') + '">\uD83D\uDCCC</button>';
}

// Re-clone (fetch latest) button for a repo+branch. Clicks are handled by the dropdown's
// delegated listener (showWorkspaceDropdown) via the data-clone-* attributes.
function _wsCloneBtnHtml(repo, branch) {
    var icon = (typeof UI_ICONS !== 'undefined' && UI_ICONS.refresh) ? UI_ICONS.refresh : '\u21BB';
    return '<button class="ws-clone-btn" data-clone-repo="' + escapeHtml(repo) + '" data-clone-branch="' + escapeHtml(branch) +
        '" title="Re-clone this repo (fetch the latest from remote)" style="background:none;border:none;cursor:pointer;padding:0 var(--space-2);line-height:1;vertical-align:middle;color:var(--text-secondary);">' + icon + '</button>';
}

// Re-clone a repo from the workspace dropdown. Re-cloning replaces the local clone, so
// guard against silently discarding uncommitted changes, then report via snackbar (the
// settings #github-clone-status element used by recloneGitHubRepo isn't present here).
async function _recloneWorkspaceFromDropdown(repo, branch) {
    var wk = repo + '::' + branch;
    var c = _wsHeaderCaches[wk];
    if (c && c.dirtyCount > 0) {
        var ok = await showConfirmModal('Re-clone ' + repo + '?',
            'Re-cloning ' + escapeHtml(repo) + ' (' + escapeHtml(branch) + ') fetches the latest from remote and <strong>discards ' +
            c.dirtyCount + ' local change' + (c.dirtyCount > 1 ? 's' : '') + '</strong>. Continue?');
        if (!ok) return;
    }
    if (typeof showSnackbar === 'function') showSnackbar('Re-cloning ' + repo + '\u2026');
    try {
        var result = await wsClone(repo, branch);
        if (result && result.success) {
            if (typeof showSnackbar === 'function') showSnackbar('Re-cloned ' + repo + ' (' + branch + ')');
            if (typeof renderGitHubReposList === 'function') renderGitHubReposList();
            if (typeof updateWorkspaceHeaderStatus === 'function') await updateWorkspaceHeaderStatus();
        } else if (typeof showSnackbar === 'function') {
            showSnackbar('Re-clone failed: ' + ((result && result.error) || 'unknown error'), 'error');
        }
    } catch (e) {
        if (typeof showSnackbar === 'function') showSnackbar('Re-clone failed: ' + (e && e.message ? e.message : String(e)), 'error');
    }
}

// Toggle a workspace pin from the UI — shared logic lives in setWorkspacePin
// (020-tool-execution.js), same code path as the `pin` workspace action.
async function _toggleWorkspacePinFromUi(wk) {
    try {
        var meta = await getWorkspaceMeta(wk);
        if (!meta) return;
        await setWorkspacePin(wk, !!meta.pinned); // toggle
        // Refresh cached metas + re-render every open dropdown section (a pin
        // elsewhere may have been cleared by the single-pin invariant).
        var all = await getAllWorkspaceMetas();
        all.forEach(function(m) { if (_wsHeaderCaches[m.repo]) _wsHeaderCaches[m.repo].meta = m; });
        if (_wsDropdown) {
            Object.keys(_wsHeaderCaches).forEach(function(k) {
                var section = _wsDropdown.querySelector('[data-ws="' + CSS.escape(k) + '"]');
                if (section) _renderDropdownSection(section, _wsHeaderCaches[k]);
            });
        }
        renderGitHubReposList();
    } catch (e) {}
}

// Total number of change rows shown for a workspace section (local dirty +
// conflicts + behind). Drives both the header count chip and the
// "> 5 changes" collapse-by-default rule for the top 3 workspaces.
function _wsSectionChangeCount(cache) {
    if (!cache) return 0;
    var d = cache.dirtyFiles ? cache.dirtyFiles.length : 0;
    var c = cache.conflictFiles ? cache.conflictFiles.length : 0;
    var b = cache.behindFiles ? cache.behindFiles.length : 0;
    return d + c + b;
}

function _renderDropdownSection(section, cache) {
    var parsed = parseWsKey(cache.wk);
    var header = section.querySelector('.ws-dropdown-header');
    if (header) {
        // Clone button is always available; pin button only in extension-dev mode
        // (deploy folder connected), matching the Reload button's visibility gate.
        var cloneBtn = _wsCloneBtnHtml(parsed.repo, parsed.branch);
        var pinBtn = _wsExtDevMode ? _wsPinBtnHtml(cache.wk, !!(cache.meta && cache.meta.pinned)) : '';
        var chevron = '<span class="ws-collapse-chevron" aria-hidden="true">' + ((typeof UI_ICONS !== 'undefined' && UI_ICONS.chevronRight) ? UI_ICONS.chevronRight : '') + '</span>';
        var changeCount = _wsSectionChangeCount(cache);
        var countChip = changeCount > 0 ? '<span class="ws-change-count" title="' + changeCount + ' change' + (changeCount > 1 ? 's' : '') + '">' + changeCount + '</span>' : '';
        header.innerHTML = '<span class="ws-dd-title">' + chevron + escapeHtml(parsed.repo) + ' <span class="ws-branch">' + escapeHtml(parsed.branch) + '</span>' + countChip + cloneBtn + pinBtn + '</span>' + _getSyncLabel(cache.syncStatus);
    }
    var body = section.querySelector('.ws-dropdown-body');
    if (!body) return;
    body.innerHTML = '';

    // Dirty files
    if (cache.dirtyFiles && cache.dirtyFiles.length > 0) {
        cache.dirtyFiles.forEach(function(f) {
            var badge = f.deleted ? '<span class="ws-file-badge deleted">deleted</span>' :
                (!f.sha && !f.deleted) ? '<span class="ws-file-badge new">new</span>' :
                '<span class="ws-file-badge modified">modified</span>';
            var prLink = '';
            if (f.pushed_pr && f.pushed_pr.url) {
                prLink = '<a class="ws-file-pr" href="' + escapeHtml(f.pushed_pr.url) + '" target="_blank" onclick="event.stopPropagation()">PR #' + f.pushed_pr.number + '</a>';
            }
            var row = document.createElement('div');
            row.className = 'ws-file-row';
            row.innerHTML = '<span class="ws-file-path" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span>' + badge + prLink;
            body.appendChild(row);
        });
    }

    // Conflict files
    if (cache.conflictFiles && cache.conflictFiles.length > 0) {
        cache.conflictFiles.forEach(function(cf) {
            var row = document.createElement('div');
            row.className = 'ws-file-row';
            row.innerHTML = '<span class="ws-file-path" title="' + escapeHtml(cf.path) + '">' + escapeHtml(cf.path) + '</span><span class="ws-file-badge conflict">conflict</span>';
            body.appendChild(row);
        });
    }

    // Behind files
    if (cache.behindFiles && cache.behindFiles.length > 0) {
        cache.behindFiles.forEach(function(bf) {
            var label = bf.remoteDeleted ? 'deleted on remote' : bf.isNew ? 'new on remote' : 'behind';
            var row = document.createElement('div');
            row.className = 'ws-file-row';
            row.innerHTML = '<span class="ws-file-path" title="' + escapeHtml(bf.path) + '">' + escapeHtml(bf.path) + '</span><span class="ws-file-badge behind">' + label + '</span>';
            body.appendChild(row);
        });

        var pullRow = document.createElement('div');
        pullRow.style.cssText = 'padding:var(--space-3) var(--space-5);text-align:right;';
        var pullBtn = document.createElement('button');
        pullBtn.className = 'skills-action-btn';
        pullBtn.style.cssText = 'font-size:var(--text-caption);padding:var(--space-2) var(--space-5);';
        pullBtn.textContent = 'Pull ' + cache.behindFiles.length + ' file' + (cache.behindFiles.length > 1 ? 's' : '') + ' from remote';
        pullBtn.addEventListener('click', async function() {
            pullBtn.disabled = true;
            pullBtn.textContent = 'Pulling...';
            await wsPull(cache.wk);
            hideWorkspaceDropdown();
            await syncAndUpdateWorkspaceHeader();
        });
        pullRow.appendChild(pullBtn);
        body.appendChild(pullRow);
    }

    // Empty state
    if ((!cache.dirtyFiles || cache.dirtyFiles.length === 0) &&
        (!cache.behindFiles || cache.behindFiles.length === 0) &&
        (!cache.conflictFiles || cache.conflictFiles.length === 0)) {
        var empty = document.createElement('div');
        empty.className = 'ws-dropdown-empty';
        empty.textContent = 'All files match remote';
        body.appendChild(empty);
    }
}

async function showWorkspaceDropdown() {
    hideWorkspaceDropdown();
    var anchor = document.getElementById('ws-header-status');
    if (!anchor || anchor.style.display === 'none' || !anchor.offsetParent) anchor = document.getElementById('home-ws-header-status');
    if (!anchor) return;

    var keys = Object.keys(_wsHeaderCaches);
    if (keys.length === 0) return;

    // Most-recently-used workspaces first (last_used_at, falling back to
    // cloned_at), so the workspace you touched last sits on top.
    keys.sort(function(a, b) {
        var ma = _wsHeaderCaches[a] && _wsHeaderCaches[a].meta;
        var mb = _wsHeaderCaches[b] && _wsHeaderCaches[b].meta;
        var ta = (ma && (ma.last_used_at || ma.cloned_at)) || 0;
        var tb = (mb && (mb.last_used_at || mb.cloned_at)) || 0;
        return tb - ta;
    });

    var dd = document.createElement('div');
    dd.className = 'ws-dropdown';

    keys.forEach(function(wk, idx) {
        var cache = _wsHeaderCaches[wk];
        var parsed = parseWsKey(wk);

        var section = document.createElement('div');
        section.className = 'ws-dropdown-section';
        section.setAttribute('data-ws', wk);

        // Default expand state: only the top 3 workspaces start expanded, and
        // even a top-3 workspace starts collapsed when it has more than 5
        // changes. Everything past the top 3 starts collapsed. User toggles and
        // background re-renders preserve this class afterwards.
        if (idx >= 3 || _wsSectionChangeCount(cache) > 5) section.classList.add('collapsed');

        // Section header
        var header = document.createElement('div');
        header.className = 'ws-dropdown-header';
        header.innerHTML = '<span>' + escapeHtml(parsed.repo) + ' <span class="ws-branch">' + escapeHtml(parsed.branch) + '</span></span>' + _getSyncLabel(cache.syncStatus);
        section.appendChild(header);

        // Section body (collapsible file list)
        var body = document.createElement('div');
        body.className = 'ws-dropdown-body';
        section.appendChild(body);
        _renderDropdownSection(section, cache);

        dd.appendChild(section);
    });

    // Delegated pin-toggle handler — header innerHTML is re-rendered on every
    // sync, so a per-button listener would be lost; delegation survives it.
    dd.addEventListener('click', function(e) {
        var cloneBtn = e.target.closest('[data-clone-repo]');
        if (cloneBtn) {
            e.stopPropagation();
            var repo = cloneBtn.getAttribute('data-clone-repo');
            var branch = cloneBtn.getAttribute('data-clone-branch');
            hideWorkspaceDropdown();
            _recloneWorkspaceFromDropdown(repo, branch);
            return;
        }
        var pinBtn = e.target.closest('[data-pin-ws]');
        if (pinBtn) {
            e.stopPropagation();
            _toggleWorkspacePinFromUi(pinBtn.getAttribute('data-pin-ws'));
            return;
        }
        // Clicking anywhere else on a section header toggles its file list.
        var hdr = e.target.closest('.ws-dropdown-header');
        if (hdr) {
            var sec = hdr.closest('.ws-dropdown-section');
            if (sec) sec.classList.toggle('collapsed');
        }
    });

    var rect = anchor.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.right = (window.innerWidth - rect.right) + 'px';
    document.body.appendChild(dd);
    _wsDropdown = dd;

    setTimeout(function() {
        document.addEventListener('click', _onClickOutsideWsDropdown, true);
    }, 0);
}

// API Providers UI Functions
function isProviderCustomized(provider) {
    var defaultProvider = DEFAULT_API_PROVIDERS.find(function(d) { return d.name === provider.name; });
    if (!defaultProvider) return false; // It's a new custom provider, not customized
    return JSON.stringify(defaultProvider) !== JSON.stringify(provider);
}

function getEndpointDomain(endpoint) {
    try {
        var url = new URL(endpoint);
        return url.hostname.replace('www.', '');
    } catch (e) {
        return '';
    }
}

function renderApiProvidersList() {
    var container = document.getElementById('custom-api-providers-list');
    if (!container) return;
    
    if (apiProviders.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:var(--text-body);padding: var(--space-4) 0;">No providers configured.</div>';
        return;
    }
    
    var html = '';
    apiProviders.forEach(function(provider) {
        var isCustomized = isProviderCustomized(provider);
        var isNew = !DEFAULT_API_PROVIDERS.find(function(d) { return d.name === provider.name; });
        var isActive = provider.name === currentProvider;
        var statusBadge = isNew ? '<span class="provider-badge new">custom</span>' : (isCustomized ? '<span class="provider-badge">modified</span>' : '');
        var activeTag = isActive ? '<span class="provider-tag active">Active</span>' : '';
        var domain = getEndpointDomain(provider.endpoint);
        var domainTag = domain ? '<span class="provider-tag">' + escapeHtml(domain) + '</span>' : '';
        var providerTag = provider.provider ? '<span class="provider-tag">' + escapeHtml(provider.provider) + '</span>' : '';
        
        html += '<div class="api-provider-row' + (isActive ? ' active' : '') + '">' +
            '<span class="api-provider-name">' + escapeHtml(provider.name) + '</span>' +
            statusBadge +
            '<div class="api-provider-tags">' + activeTag + domainTag + providerTag + '</div>' +
            '<div class="api-provider-actions">' +
                '<button class="api-provider-btn' + (isActive ? ' selected' : '') + '" onclick="selectApiProvider(\'' + escapeJsString(provider.name) + '\')" title="' + (isActive ? 'Active' : 'Use this model') + '">' + UI_ICONS.check + '</button>' +
                '<button class="api-provider-btn" onclick="editApiProvider(\'' + escapeJsString(provider.name) + '\')" title="Edit">' + UI_ICONS.edit + '</button>' +
                '<button class="api-provider-btn danger" onclick="confirmDeleteApiProvider(\'' + escapeJsString(provider.name) + '\')" title="Delete">' + UI_ICONS.trash + '</button>' +
            '</div>' +
        '</div>';
    });
    container.innerHTML = html;
}

function selectApiProvider(providerName) {
    changeProvider(providerName);
    renderApiProvidersList();
}

function getDefaultApiKey() {
    // Get API key from first default provider or existing providers
    if (apiProviders.length > 0 && apiProviders[0].apiKey) return apiProviders[0].apiKey;
    if (DEFAULT_API_PROVIDERS.length > 0) return DEFAULT_API_PROVIDERS[0].apiKey;
    return '';
}

function showAddApiProviderModal(editingProvider) {
    // Remove any existing modal first
    var existingModal = document.getElementById('api-provider-modal');
    if (existingModal) existingModal.remove();
    
    var isEditing = !!editingProvider;
    var originalName = isEditing ? editingProvider.name : '';
    var defaultApiKey = getDefaultApiKey();
    var provider = editingProvider || { 
        name: '', 
        model: '', 
        endpoint: 'https://openrouter.ai/api/v1/chat/completions', 
        apiKey: defaultApiKey, 
        maxTokens: 64000, 
        context_length: 200000,
        provider: ''
    };
    
    var overlay = document.createElement('div');
    overlay.id = 'api-provider-modal';
    overlay.className = 'modal-overlay show';
    overlay.onclick = function(e) { if (e.target === overlay) closeApiProviderModal(); };
    
    overlay.innerHTML = 
        '<div class="modal-dialog" style="max-width:480px;">' +
            '<div class="modal-header">' + (isEditing ? 'Edit' : 'Add') + ' API Provider</div>' +
            '<div class="modal-body" style="display:flex;flex-direction:column;gap:var(--space-8);">' +
                '<div class="form-field">' +
                    '<label class="form-label">Display Name <span class="required">*</span></label>' +
                    '<input type="text" id="provider-name" class="form-input" value="' + escapeHtml(provider.name) + '" placeholder="e.g. Claude 4 Sonnet">' +
                '</div>' +
                '<div class="form-field">' +
                    '<label class="form-label">Model ID <span class="required">*</span></label>' +
                    '<input type="text" id="provider-model" class="form-input" value="' + escapeHtml(provider.model) + '" placeholder="e.g. anthropic/claude-sonnet-4">' +
                '</div>' +
                '<div class="form-field" id="provider-provider-field"' + (provider.isClaudeOAuth ? ' style="display:none"' : '') + '>' +
                    '<label class="form-label">Provider (Optional)</label>' +
                    '<input type="text" id="provider-provider" class="form-input" value="' + escapeHtml(provider.provider || '') + '" placeholder="e.g. anthropic or novita/bf16">' +
                '</div>' +
                '<label class="settings-checkbox" style="margin-bottom:var(--space-4);">' +
                    '<input type="checkbox" id="provider-oauth"' + (provider.isClaudeOAuth ? ' checked' : '') + ' onchange="toggleOAuthProvider(this.checked)">' +
                    '<span>Use Claude OAuth (no API key needed)</span>' +
                '</label>' +
                '<div class="form-field" id="provider-endpoint-field"' + (provider.isClaudeOAuth ? ' style="display:none"' : '') + '>' +
                    '<label class="form-label">API Endpoint</label>' +
                    '<input type="text" id="provider-endpoint" class="form-input" value="' + escapeHtml(provider.endpoint) + '" placeholder="https://openrouter.ai/api/v1/chat/completions">' +
                '</div>' +
                '<div class="form-field" id="provider-apikey-field"' + (provider.isClaudeOAuth ? ' style="display:none"' : '') + '>' +
                    '<label class="form-label">API Key <span class="required">*</span></label>' +
                    '<input type="password" id="provider-apikey" class="form-input" value="' + escapeHtml(provider.apiKey) + '" placeholder="sk-or-...">' +
                '</div>' +
                '<div style="display:flex;gap:var(--space-6);">' +
                    '<div class="form-field" style="flex:1;">' +
                        '<label class="form-label">Max Tokens</label>' +
                        '<input type="number" id="provider-maxtokens" class="form-input" value="' + (provider.maxTokens || 16000) + '">' +
                    '</div>' +
                    '<div class="form-field" style="flex:1;">' +
                        '<label class="form-label">Context Length</label>' +
                        '<input type="number" id="provider-context" class="form-input" value="' + (provider.context_length || 200000) + '">' +
                    '</div>' +
                '</div>' +
                '<div class="form-field">' +
                    '<label class="form-label">Reasoning Effort</label>' +
                    '<select id="provider-effort" class="form-input">' +
                        ['', 'low', 'medium', 'high', 'xhigh', 'max'].map(function(v) {
                            var label = v === '' ? '(default — let server decide)' : v;
                            var selected = (provider.effort || '') === v ? ' selected' : '';
                            return '<option value="' + v + '"' + selected + '>' + label + '</option>';
                        }).join('') +
                    '</select>' +
                '</div>' +
            '</div>' +
            '<div class="modal-actions">' +
                '<button class="modal-btn secondary" onclick="closeApiProviderModal()">Cancel</button>' +
                '<button class="modal-btn primary" onclick="saveApiProviderFromModal(\'' + escapeJsString(originalName) + '\')">' + (isEditing ? 'Save' : 'Add') + '</button>' +
            '</div>' +
        '</div>';
    
    document.body.appendChild(overlay);
}

function toggleOAuthProvider(checked) {
    ['provider-endpoint-field', 'provider-apikey-field', 'provider-provider-field'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = checked ? 'none' : '';
    });
}

function closeApiProviderModal() {
    var modal = document.getElementById('api-provider-modal');
    if (modal) modal.remove();
}

async function saveApiProviderFromModal(originalName) {
    var name = document.getElementById('provider-name').value.trim();
    var model = document.getElementById('provider-model').value.trim();
    var providerField = document.getElementById('provider-provider').value.trim();
    var oauthCheckbox = document.getElementById('provider-oauth');
    var isOAuth = oauthCheckbox && oauthCheckbox.checked;
    var endpoint = isOAuth ? 'https://api.anthropic.com/v1/messages' : (document.getElementById('provider-endpoint').value.trim() || 'https://openrouter.ai/api/v1/chat/completions');
    var apiKey = isOAuth ? 'oauth' : document.getElementById('provider-apikey').value.trim();
    var maxTokens = parseInt(document.getElementById('provider-maxtokens').value) || 16000;
    var contextLength = parseInt(document.getElementById('provider-context').value) || 200000;
    var effortField = document.getElementById('provider-effort');
    var effort = effortField ? effortField.value : '';

    if (!name || !model || (!isOAuth && !apiKey)) {
        showSnackbar('Please fill in all required fields (Name, Model ID' + (isOAuth ? '' : ', API Key') + ')', 'error');
        return;
    }
    
    // If renaming, handle in-place update to preserve list order
    var originalIndex = -1;
    if (originalName && originalName !== name) {
        originalIndex = apiProviders.findIndex(function(p) { return p.name === originalName; });
        // Delete old entry from IndexedDB (but don't remove from array yet)
        try {
            var database = await openDatabase();
            var transaction = database.transaction([apiProvidersStoreName], 'readwrite');
            var store = transaction.objectStore(apiProvidersStoreName);
            store.delete(originalName);
        } catch (e) {
            console.error('Failed to delete old provider entry:', e);
        }
        // Update currentProvider if it was the renamed one
        if (currentProvider === originalName) {
            currentProvider = name;
            saveProviderToStorage();
        }
    }
    
    var provider = {
        name: name,
        model: model,
        endpoint: endpoint,
        apiKey: apiKey,
        maxTokens: maxTokens,
        context_length: contextLength,
        thinkingBudget: 40000
    };
    if (providerField && !isOAuth) provider.provider = providerField;
    if (isOAuth) provider.isClaudeOAuth = true;
    if (effort) provider.effort = effort;

    // If renaming, update in-place to preserve list order
    if (originalIndex >= 0) {
        apiProviders[originalIndex] = provider;
        // Save to IndexedDB
        try {
            var database = await openDatabase();
            var transaction = database.transaction([apiProvidersStoreName], 'readwrite');
            var store = transaction.objectStore(apiProvidersStoreName);
            store.put(provider);
        } catch (e) {
            console.error('Failed to save renamed provider:', e);
        }
    } else {
        await saveApiProvider(provider);
    }
    closeApiProviderModal();
    renderApiProvidersList();
    populateProviderDropdown();
    showSnackbar(originalName ? 'Provider updated' : 'Provider added', 'success');
}

function editApiProvider(providerName) {
    var provider = apiProviders.find(function(p) { return p.name === providerName; });
    if (provider) {
        showAddApiProviderModal(provider);
    }
}

async function confirmDeleteApiProvider(providerName) {
    var provider = apiProviders.find(function(p) { return p.name === providerName; });
    if (!provider) return;
    
    if (await showConfirmModal('Delete Provider', 'Delete provider "' + provider.name + '"? This cannot be undone.')) {
        deleteApiProviderAndRefresh(providerName);
    }
}

async function deleteApiProviderAndRefresh(providerName) {
    // Check if this provider is currently selected
    if (currentProvider === providerName) {
        // Switch to first available provider
        currentProvider = apiProviders.length > 1 ? apiProviders.find(function(p) { return p.name !== providerName; }).name : 'opus-4.8';
        saveProviderToStorage();
    }
    
    await deleteApiProvider(providerName);
    renderApiProvidersList();
    populateProviderDropdown();
    updateModelDisplay();
    showSnackbar('Provider deleted', 'success');
}

// System Prompt Editor Functions
function renderSystemPromptEditor() {
    var container = document.getElementById('system-prompt-editor-container');
    if (!container) return;
    
    var isEditing = systemPromptEditMode;
    var isCustom = hasCustomSystemPrompt();
    var template = getSystemPromptTemplate();
    var expandedPrompt = expandSystemPromptPlaceholders(template);
    var tokenCount = estimateTokens(expandedPrompt);
    
    // Calculate tools token count too
    var tools = getEnabledTools();
    var toolsJson = JSON.stringify(tools);
    var toolsTokenCount = estimateTokens(toolsJson);
    var totalTokenCount = tokenCount + toolsTokenCount;
    
    var content = isEditing ? escapeHtml(template) : escapeHtml(expandedPrompt);
    
    var html = '<div class="system-prompt-editor">' +
        '<div class="system-prompt-toolbar">' +
            '<div class="system-prompt-toolbar-left">' +
                (isEditing ? 
                    '<span class="system-prompt-mode-badge editing">Editing Template</span>' :
                    '<span class="system-prompt-mode-badge preview">Preview Mode</span>') +
                (isCustom ? '<span class="system-prompt-custom-badge">Custom</span>' : '') +
            '</div>' +
            '<div class="system-prompt-toolbar-right">' +
                (isEditing ?
                    '<button class="skills-action-btn" onclick="cancelSystemPromptEdit()">' + UI_ICONS.close + ' Cancel</button>' +
                    '<button class="skills-action-btn primary" onclick="saveSystemPromptEdit()">' + UI_ICONS.save + ' Save</button>' :
                    (isCustom ? '<button class="skills-action-btn" onclick="revertSystemPromptToDefault()">' + UI_ICONS.refresh + ' Revert to Default</button>' : '') +
                    '<button class="skills-action-btn primary" onclick="startSystemPromptEdit()">' + UI_ICONS.edit + ' Edit</button>') +
            '</div>' +
        '</div>' +
        '<div class="system-prompt-content-wrapper">' +
            (isEditing ?
                '<textarea id="system-prompt-textarea" class="system-prompt-textarea" oninput="updateSystemPromptTokenCount()">' + escapeHtml(template) + '</textarea>' :
                '<pre class="system-prompt-preview">' + content + '</pre>') +
            '<div class="system-prompt-token-count">' +
                '<span id="system-prompt-token-display">' + totalTokenCount.toLocaleString() + ' tokens</span>' +
                '<span class="system-prompt-token-detail">(prompt: ' + tokenCount.toLocaleString() + ' + tools: ' + toolsTokenCount.toLocaleString() + ')</span>' +
            '</div>' +
        '</div>' +
        '<div class="system-prompt-placeholders-help">' +
            '<strong>Available Placeholders:</strong> ' +
            '<code>{{SCOPE_CONTEXT}}</code> - Current app scope info, ' +
            '<code>{{DISABLED_TOOLS}}</code> - List of disabled tools, ' +
            '<code>{{SKILLS_SUMMARY}}</code> - Available skills list' +
        '</div>' +
    '</div>';
    
    container.innerHTML = html;
}

function startSystemPromptEdit() {
    systemPromptEditMode = true;
    renderSystemPromptEditor();
    // Focus the textarea
    var textarea = document.getElementById('system-prompt-textarea');
    if (textarea) textarea.focus();
}

function cancelSystemPromptEdit() {
    systemPromptEditMode = false;
    renderSystemPromptEditor();
}

async function saveSystemPromptEdit() {
    var textarea = document.getElementById('system-prompt-textarea');
    if (!textarea) return;
    
    var newTemplate = textarea.value;
    
    // Validate that the template is not empty
    if (!newTemplate.trim()) {
        showSnackbar('System prompt cannot be empty', 'error');
        return;
    }
    
    // Save the custom prompt
    await saveCustomSystemPrompt(newTemplate);
    systemPromptEditMode = false;
    renderSystemPromptEditor();
    showSnackbar('System prompt saved', 'success');
}

async function revertSystemPromptToDefault() {
    var confirmed = await showConfirmModal('Revert to Default', 'Are you sure you want to revert to the default system prompt? Your custom prompt will be deleted.');
    if (!confirmed) return;
    
    await clearCustomSystemPrompt();
    systemPromptEditMode = false;
    renderSystemPromptEditor();
    showSnackbar('Reverted to default system prompt', 'success');
}

function updateSystemPromptTokenCount() {
    var textarea = document.getElementById('system-prompt-textarea');
    var tokenDisplay = document.getElementById('system-prompt-token-display');
    var detailDisplay = document.querySelector('.system-prompt-token-detail');
    if (!textarea || !tokenDisplay) return;
    
    var template = textarea.value;
    var expandedPrompt = expandSystemPromptPlaceholders(template);
    var tokenCount = estimateTokens(expandedPrompt);
    
    var tools = getEnabledTools();
    var toolsJson = JSON.stringify(tools);
    var toolsTokenCount = estimateTokens(toolsJson);
    var totalTokenCount = tokenCount + toolsTokenCount;
    
    tokenDisplay.textContent = totalTokenCount.toLocaleString() + ' tokens';
    if (detailDisplay) {
        detailDisplay.textContent = '(prompt: ' + tokenCount.toLocaleString() + ' + tools: ' + toolsTokenCount.toLocaleString() + ')';
    }
}

async function fetchAndPopulateSettingsPageScopeDropdown() {
    var container = document.getElementById('settings-page-scope-container');
    if (!container) return;
    
    // Show current scope from local storage immediately (no loading message)
    // Include enough options to render as dropdown, not radio buttons
    var currentSelectedScope = localScopeOverride !== null ? localScopeOverride : platformScope;
    var currentLabel = currentSelectedScope === 'global' ? 'Global' : (window.currentScopeName || currentSelectedScope);
    var initialOptions = [{ value: 'global', label: 'Global' }];
    if (currentSelectedScope !== 'global') {
        initialOptions.push({ value: currentSelectedScope, label: currentLabel });
    }
    // Add placeholder options to ensure dropdown rendering (>3 options)
    initialOptions.push({ value: '_placeholder1', label: 'Loading scopes...' });
    initialOptions.push({ value: '_placeholder2', label: '' });
    initialOptions.push({ value: '_placeholder3', label: '' });
    renderCustomSelect('settings-page-scope-container', initialOptions, currentSelectedScope, changeLocalScope, 'Select scope...');
    
    try {
        var response = await fetch('/api/now/table/sys_scope?sysparm_query=sys_class_name=sys_app^ORsys_class_name=sys_store_app&sysparm_fields=scope,name,sys_id&sysparm_limit=500', {
            headers: { 'Accept': 'application/json', 'X-UserToken': window.sessionToken }
        });
        var data = await response.json();
        
        var options = [{ value: 'global', label: 'Global' }];
        if (data.result && data.result.length > 0) {
            data.result.forEach(function(scope) {
                if (scope.scope && scope.scope !== 'global') {
                    options.push({ value: scope.scope, label: scope.name || scope.scope });
                }
            });
        }
        
        var selectedScope = localScopeOverride !== null ? localScopeOverride : platformScope;
        renderCustomSelect('settings-page-scope-container', options, selectedScope, changeLocalScope, 'Select scope...');
    } catch (e) {
        console.error('Failed to fetch scopes:', e);
        renderCustomSelect('settings-page-scope-container', [{ value: 'global', label: 'Global' }], 'global', changeLocalScope, 'Select scope...');
    }
}

function renderSettingsToolPermissions() {
    var container = document.getElementById('settings-tool-permissions');
    if (!container) return;
    // Delegate to the shared renderToolPermissions logic but target the settings container
    // We temporarily swap the container ID to reuse the same render
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

    // --- Instance section ---
    var instanceTitle = host ? host.split('.')[0] : 'No instance connected';
    var disabledClass = host ? '' : ' disabled';

    html += '<div class="tool-permission-section' + disabledClass + '">';
    html += '<div class="tool-permission-section-header">';
    html += '<span class="tool-permission-section-title">' + UI_ICONS.api + ' ' + escapeHtml(instanceTitle) + '</span>';
    if (host) {
        html += '<div class="instance-tier-toggle" id="settings-instance-tier-toggle"></div>';
    }
    html += '</div>';

    if (host) {
        html += '<div class="tool-permission-group">';
        html += '<div class="tool-permission-group-title">ServiceNow API ' + _toolSourceBtn('servicenow_api') + ' ' + _toolSourceBtn('servicenow_diff_edit') + '</div>';
        ['sn:read', 'sn:create', 'sn:update', 'sn:delete'].forEach(function(key) {
            var displayName = TOOL_DISPLAY_NAMES[key] || key;
            var containerId = 'settings-perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
            html += '<div class="tool-permission-item tool-permission-subitem' + (isAutoTier ? ' tier-auto' : '') + '">' +
                '<span class="tool-permission-name">' + displayName + '</span>' +
                '<div class="tool-permission-control" id="' + containerId + '"></div>' +
            '</div>';
        });
        html += '</div>';

        html += '<div class="tool-permission-group">';
        html += '<div class="tool-permission-group-title">Browser ' + _toolSourceBtn('iframe_tool') + '</div>';
        INSTANCE_PERMISSION_KEYS.filter(function(k) { return k.startsWith('browser:'); }).forEach(function(key) {
            var displayName = TOOL_DISPLAY_NAMES[key] || key;
            var containerId = 'settings-perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
            html += '<div class="tool-permission-item tool-permission-subitem' + (isAutoTier ? ' tier-auto' : '') + '">' +
                '<span class="tool-permission-name">' + displayName + '</span>' +
                '<div class="tool-permission-control" id="' + containerId + '"></div>' +
            '</div>';
        });
        html += '</div>';
    }
    html += '</div>';

    // --- Global section ---
    html += '<div class="tool-permission-section">';
    html += '<div class="tool-permission-section-header">';
    html += '<span class="tool-permission-section-title">' + UI_ICONS.tool + ' Global Tools</span>';
    html += '</div>';

    var manageSkillKeys = GLOBAL_PERMISSION_KEYS.filter(function(k) { return k.startsWith('manage_skill:'); });
    var workspaceKeys = GLOBAL_PERMISSION_KEYS.filter(function(k) { return k.startsWith('workspace:'); });
    var documentKeys = GLOBAL_PERMISSION_KEYS.filter(function(k) { return k.startsWith('document:'); });
    var otherGlobalKeys = GLOBAL_PERMISSION_KEYS.filter(function(k) {
        return !k.startsWith('manage_skill:') && !k.startsWith('workspace:') && !k.startsWith('document:');
    });

    otherGlobalKeys.forEach(function(key) {
        var displayName = TOOL_DISPLAY_NAMES[key] || key;
        var containerId = 'settings-perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
        // For ungrouped global keys, the permission key IS the tool name, so we can show a source link.
        var hasTool = TOOLS.some(function(t) { return t.function.name === key; });
        html += '<div class="tool-permission-item">' +
            '<span class="tool-permission-name">' + displayName + (hasTool ? ' ' + _toolSourceBtn(key) : '') + '</span>' +
            '<div class="tool-permission-control" id="' + containerId + '"></div>' +
        '</div>';
    });

    html += '<div class="tool-permission-group">';
    html += '<div class="tool-permission-group-title">Manage Agent Skill ' + _toolSourceBtn('manage_skill') + '</div>';
    manageSkillKeys.forEach(function(key) {
        var displayName = TOOL_DISPLAY_NAMES[key] || key;
        var containerId = 'settings-perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
        html += '<div class="tool-permission-item tool-permission-subitem">' +
            '<span class="tool-permission-name">' + displayName + '</span>' +
            '<div class="tool-permission-control" id="' + containerId + '"></div>' +
        '</div>';
    });
    html += '</div>';

    html += '<div class="tool-permission-group">';
    html += '<div class="tool-permission-group-title">Workspace ' + _toolSourceBtn('workspace') + '</div>';
    workspaceKeys.forEach(function(key) {
        var displayName = TOOL_DISPLAY_NAMES[key] || key;
        var containerId = 'settings-perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
        html += '<div class="tool-permission-item tool-permission-subitem">' +
            '<span class="tool-permission-name">' + displayName + '</span>' +
            '<div class="tool-permission-control" id="' + containerId + '"></div>' +
        '</div>';
    });
    html += '</div>';

    html += '<div class="tool-permission-group">';
    html += '<div class="tool-permission-group-title">Smart Document ' + _toolSourceBtn('document') + '</div>';
    documentKeys.forEach(function(key) {
        var displayName = TOOL_DISPLAY_NAMES[key] || key;
        var containerId = 'settings-perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
        html += '<div class="tool-permission-item tool-permission-subitem">' +
            '<span class="tool-permission-name">' + displayName + '</span>' +
            '<div class="tool-permission-control" id="' + containerId + '"></div>' +
        '</div>';
    });
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
                var containerId = 'settings-perm-' + permKey.replace(/[^a-zA-Z0-9]/g, '-');
                skillToolKeys.push(permKey);
                html += '<div class="tool-permission-item tool-permission-subitem">' +
                    '<span class="tool-permission-name">' + escapeHtml(toolName) + ' ' + _toolSourceBtn(toolName, skillId) + '</span>' +
                    '<div class="tool-permission-control" id="' + containerId + '"></div>' +
                '</div>';
            });
            html += '</div>';
        }
    });

    html += '</div>';
    container.innerHTML = html;

    // Render tier toggle
    if (host) {
        var tierContainer = document.getElementById('settings-instance-tier-toggle');
        if (tierContainer) {
            var currentTier = instPerms ? instPerms.tier : 'manual';
            var manualSelected = currentTier === 'manual';
            tierContainer.innerHTML = '<div class="radio-group radio-group-small">' +
                '<div class="radio-option' + (manualSelected ? ' selected' : '') + '" title="Manual: You control each permission" ' +
                    'onclick="event.stopPropagation(); setInstanceTier(\'manual\', this); renderSettingsToolPermissions();">' + UI_ICONS.lock + ' Manual</div>' +
                '<div class="radio-option' + (!manualSelected ? ' selected' : '') + '" title="Auto: Agent decides for write operations" ' +
                    'onclick="event.stopPropagation(); setInstanceTier(\'auto\', this); renderSettingsToolPermissions();">' + UI_ICONS.sparkle + ' Auto</div>' +
            '</div>';
        }
    }

    // Render instance permission radios
    if (host) {
        INSTANCE_PERMISSION_KEYS.forEach(function(key) {
            var containerId = 'settings-perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
            var perm = (instPerms && instPerms.tools && instPerms.tools[key]) ||
                (isReadPermissionKey(key) ? 'allow' : 'ask');
            _renderPermRadio(containerId, perm, key, true, isAutoTier);
        });
    }

    // Render global permission radios
    GLOBAL_PERMISSION_KEYS.concat(skillToolKeys).forEach(function(key) {
        var containerId = 'settings-perm-' + key.replace(/[^a-zA-Z0-9]/g, '-');
        var perm = toolPermissions[key] || (isReadPermissionKey(key) ? 'allow' : 'auto');
        _renderPermRadio(containerId, perm, key, false, false);
    });
}

// Helper to hide all panels
function hideAllPanels() {
    var panels = ['main-area', 'skills-panel', 'dashboard-panel', 'home-panel', 'settings-page-panel', 'docs-panel', 'history-panel', 'documents-panel'];
    panels.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    // Hide browser controls (URL input) when leaving views
    var browserControls = document.getElementById('browser-controls');
    if (browserControls) browserControls.style.display = 'none';
    var homeBrowserControls = document.getElementById('home-browser-controls');
    if (homeBrowserControls) homeBrowserControls.style.display = 'none';
    // Auto-close sidebar overlay on mobile / side panel mode
    if (!sidebarCollapsed && (document.body.classList.contains('sidepanel-mode') || window.innerWidth <= 480)) {
        toggleSidebar();
    }
}

// Show chat view with browser controls
function showChatView() {
    var mainArea = document.getElementById('main-area');
    if (mainArea) mainArea.style.display = 'flex';
    // SWM2-T3: returning from a non-chat view (which posted focus-chat(null) and set
    // _focusSignalReceived=true) leaves no chat pinned as focused — the idle sweep then
    // GCs the viewed chat's transcript. Re-post focus so the viewed chat is re-pinned.
    if (currentView === 'chat' && typeof currentChatId !== 'undefined' && currentChatId && typeof pushFocusChatToOffscreen === 'function') {
        pushFocusChatToOffscreen(currentChatId);
    }
    // Returning to the chat view counts as 'seeing' the focused chat — consume
    // its finished-chat badge entry (ui/165-finished-chat-badge.js). Covers the
    // home/history → back-to-chat path, which bypasses selectChat().
    if (currentView === 'chat' && typeof currentChatId !== 'undefined' && currentChatId && typeof clearUnseenFinishedChat === 'function') {
        try { clearUnseenFinishedChat(currentChatId); } catch (e) {}
    }
}

// Update all sidebar button states
function updateAllButtonStates() {
    var buttons = {
        'new-chat-nav-btn': currentView === 'home',
        'skills-btn': currentView === 'skills',
        'dashboard-btn': currentView === 'dashboard' || currentView === 'widget-editor',
        'settings-page-btn': currentView === 'settings-page',
        'docs-btn': currentView === 'docs',
        'documents-btn': currentView === 'documents'
    };
    Object.keys(buttons).forEach(function(id) {
        var btn = document.getElementById(id);
        if (btn) btn.classList.toggle('active', buttons[id]);
    });
    // Update history button active state
    var historyRow = document.getElementById('history-toggle-btn');
    if (historyRow) historyRow.classList.toggle('active', currentView === 'history');
}
