// Tool Inspector Modal — view a tool's JSON schema and implementation source.
// Used from Settings page Tool Permissions section and from search.
function showToolInspector(toolName, skillId) {
    // Route through the close fn so a re-open also removes the previous
    // modal's document-level Escape listener.
    if (document.getElementById('tool-inspector-modal')) closeToolInspectorModal();

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

    // Escape to close. The global Escape handler in core/120-init.js only
    // knows the permanent #modal-overlay — this dynamic twin wires its own
    // document-level key and removes it again on close.
    overlay._escHandler = function(e) {
        if (e.key !== 'Escape') return;
        // Sweep 753-773 (F2-escape-inspector-doubleclose): defer to ANY visible
        // overlay (permanent #modal-overlay or a dynamic twin), not just the
        // permanent confirm — otherwise one Escape closes both the twin (via
        // the global ladder) and this inspector on the same keypress.
        if (document.querySelector('.modal-overlay.show:not(#tool-inspector-modal)')) return; // something on top — its own/global handler closes it
        closeToolInspectorModal();
    };
    document.addEventListener('keydown', overlay._escHandler);
}

function closeToolInspectorModal() {
    var modal = document.getElementById('tool-inspector-modal');
    if (!modal) return;
    if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
    modal.remove();
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
        'set_links': executeSetLinks,
        'set_caveat': executeSetCaveat,
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

function openSettingsPageView(scrollToId) {
    currentView = 'settings-page';
    appStorage.setItem('currentView', 'settings-page');
    // SWM2-F3: left the chat view — clear this panel's focus entry so the SW
    // sub-agent GC doesn't keep the previously-viewed chat pinned (port-keyed).
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(null);
    hideAllPanels();
    var settingsPanel = document.getElementById('settings-page-panel');
    if (settingsPanel) { settingsPanel.style.display = 'flex'; renderSettingsPage(); }
    // Optional deep-link: scroll to a section container (e.g. 'llm-endpoints-list',
    // 'settings-tool-permissions', 'system-prompt-editor-container',
    // 'github-settings-container'). Deferred a tick so the freshly rendered
    // (and partly async) sections have laid out.
    if (scrollToId && typeof scrollToId === 'string') {
        setTimeout(function() {
            var el = document.getElementById(scrollToId);
            if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
    }
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
                '<span>' + UI_ICONS.api + ' LLM Endpoints</span>' +
                '<button class="skills-action-btn" onclick="showLlmEndpointModal()" style="padding: var(--space-2) var(--space-5);font-size:var(--text-body-sm);">' + UI_ICONS.plus + ' Add Endpoint</button>' +
            '</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Named endpoint URL + API key pairs. Each endpoint-backed model below picks one — update a key here once and every model using it follows. The same URL can appear under different names with different keys.</div>' +
            '<div id="llm-endpoints-list"></div>' +
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
            '<div class="settings-page-section-title">' + UI_ICONS.api + ' Sub-Agent Model Tiers</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Map the abstract <code>small</code> / <code>medium</code> / <code>large</code> tiers to providers above, or pick <code>Same</code> to make a tier dynamically follow the spawning agent&#39;s current model. The agent uses these when spawning sub-agents with <code>tier</code> (e.g. small for cheap search fan-outs, large for heavy implementation work).</div>' +
            '<div id="tier-aliases-list"></div>' +
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
                '<div><div class="settings-page-row-label">Deferred tool loading (experimental)</div><div class="settings-page-row-hint">Declare only core tool schemas per request; every other tool is listed in a system-prompt catalog and its schema fetched on demand via get_tool_schema. Cuts input tokens per request. Default off.</div></div>' +
                '<input type="checkbox" ' + (typeof isDeferredToolsActive === 'function' && isDeferredToolsActive() ? 'checked' : '') + ' onchange="toggleDeferredTools(this.checked)">' +
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
                '<div><div class="settings-page-row-label">Answer Links Card</div><div class="settings-page-row-hint">Ask the agent for relevant links (PRs, diffs, records, docs) after each answer, shown as a card below the TL;DR</div></div>' +
                '<input type="checkbox" ' + (hooksEnabled.autoLinks ? 'checked' : '') + ' onchange="toggleHook(\'autoLinks\')">' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Caveat Warning</div><div class="settings-page-row-hint">Agent flags anything you must not miss (off-plan changes, assumptions, questions at the end) as a warning card. Optional per answer — only shown when there is something to flag.</div></div>' +
                '<input type="checkbox" ' + (hooksEnabled.autoCaveat ? 'checked' : '') + ' onchange="toggleHook(\'autoCaveat\')">' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Auto chat progress</div><div class="settings-page-row-hint">Ask the agent to finalize the chat progress card after each answer with a terminal state (finished, PR opened, finished with caveat, or failed), shown as a badge on chat cards and the header pill. Skipped for purely conversational answers.</div></div>' +
                '<input type="checkbox" ' + (hooksEnabled.autoProgress ? 'checked' : '') + ' onchange="toggleHook(\'autoProgress\')">' +
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
            '<div class="settings-page-section-title">' + UI_ICONS.stats + ' Context Window & Token Budgets</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Assumed context window for all models. At 50% usage, agents get a warning with every tool result \u2014 the main agent is nudged to delegate to sub-agents; sub-agents are nudged to wrap up and report to their parent suggesting a handoff. At 100% there is no hard stop, but the agent is urged to stop and report to the user (main agent) or to its parent (sub-agent).</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Context Window (tokens)</div><div class="settings-page-row-hint">Default: 200000</div></div>' +
                '<div class="settings-input-group">' +
                    '<input type="number" id="settings-page-context-window" class="settings-number-input" min="' + SETTINGS_NUMBER_LIMITS.contextWindow.min + '" max="' + SETTINGS_NUMBER_LIMITS.contextWindow.max + '" step="1000" value="' + getAssumedContextTokens() + '" onchange="updateAssumedContextTokensFromSettings(this.value)" />' +
                    '<span class="settings-input-suffix">tokens</span>' +
                '</div>' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Max Tokens</div><div class="settings-page-row-hint">Max output tokens per request, for all providers. Default: 64000</div></div>' +
                '<div class="settings-input-group">' +
                    '<input type="number" id="settings-page-max-tokens" class="settings-number-input" min="' + SETTINGS_NUMBER_LIMITS.maxTokens.min + '" max="' + SETTINGS_NUMBER_LIMITS.maxTokens.max + '" step="1000" value="' + getGlobalMaxTokens() + '" onchange="updateGlobalMaxTokens(this.value)" />' +
                    '<span class="settings-input-suffix">tokens</span>' +
                '</div>' +
            '</div>' +
            '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label">Thinking Budget</div><div class="settings-page-row-hint">Reasoning token budget. Ignored by adaptive-thinking Claude models (they use Effort). Default: 32000</div></div>' +
                '<div class="settings-input-group">' +
                    '<input type="number" id="settings-page-thinking-budget" class="settings-number-input" min="' + SETTINGS_NUMBER_LIMITS.thinkingBudget.min + '" max="' + SETTINGS_NUMBER_LIMITS.thinkingBudget.max + '" step="1000" value="' + getGlobalThinkingBudget() + '" onchange="updateGlobalThinkingBudget(this.value)" />' +
                    '<span class="settings-input-suffix">tokens</span>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="settings-page-section">' +
            '<div class="settings-page-section-title">' + UI_ICONS.chat + ' System Prompt</div>' +
            '<div class="settings-page-row-hint" style="margin-bottom: var(--space-6);">Customize the system prompt sent to the AI. Use placeholders like <code>{{DISABLED_TOOLS}}</code>, <code>{{SKILLS_SUMMARY}}</code> which get replaced with actual values.</div>' +
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
    
    // Render tool permissions in settings
    renderSettingsToolPermissions();

    // Render system prompt editor
    renderSystemPromptEditor();

    // Render LLM endpoints + API providers lists
    renderLlmEndpointsList();
    renderApiProvidersList();

    // Render sub-agent tier alias mapping (Orchestrator §1)
    renderTierAliasSettings();

    // Render GitHub settings
    renderGitHubSettings();
}

// Settings page onchange handlers for the global token-budget fields.
// Persist via saveGlobalMaxTokens / saveGlobalThinkingBudget
// (core/030-config.js — same IDB settings store as Context Window) and
// write the normalized value back into the input.
//
// VALIDATION CONTRACT (all the numeric settings-page fields): the raw value
// is parsed + clamped HERE, before it ever reaches save*(), so the number
// painted into the input, the in-memory global and the IDB settings row are
// always the SAME value. Previously a negative like -5 sailed through
// `parseInt(v) || DEFAULT` in core/030-config.js (it is truthy), so the store
// kept -5 while the guarded getter made the input display the default -- a
// lying UI plus bad persisted data. And there was no upper bound at all, so
// 99999999 persisted verbatim and was sent as max_tokens on EVERY request.
// Non-numeric/empty falls back to the default; a NEGATIVE value also falls back
// to the default (see _clampSettingNumber); any other out-of-range value clamps
// to the bound. Mirrors updateCacheTokenLimitFromK (ui/070-dashboard-ui.js), the
// one numeric field that already clamped.
var SETTINGS_NUMBER_LIMITS = {
    // Assumed context window. Floor is the input's existing min; ceiling 10M
    // tokens sits above the largest advertised model window (Llama 4 Scout
    // 10M, Gemini 2M), so no legitimate value is blocked while typo-scale
    // numbers are.
    contextWindow:  { min: 1000, max: 10000000 },
    // Max OUTPUT tokens per request. Ceiling 200k is comfortably above the
    // highest per-request output cap of any supported model (~128k).
    maxTokens:      { min: 1,    max: 200000 },
    // Reasoning budget -- same ceiling as maxTokens (a reasoning budget above
    // the output cap is meaningless).
    thinkingBudget: { min: 1,    max: 200000 }
};

// parseInt + finite check + clamp. Non-numeric / empty -> fallback default.
//
// NEGATIVES ARE NOT CLAMPED, THEY FALL BACK. Clamping -5 to bounds.min looks
// tidy but is the worst possible outcome for these particular settings: it
// persists maxTokens = 1, and since the clamp now also writes the value back to
// the input and to IDB, the UI and the store agree on a number that makes every
// subsequent request send `max_tokens: 1` (an empty completion). A negative is
// not a mistyped magnitude the user meant to cap -- it is nonsense input, and
// nonsense input already has a defined behaviour here: the default.
// 0 is NOT negative and keeps clamping to bounds.min (unchanged behaviour).
// The Object.is check catches -0: parseInt('-0.5', 10) is -0, which is not < 0,
// so a small negative fraction would otherwise still clamp to bounds.min.
function _clampSettingNumber(value, bounds, fallback) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    if (n < 0 || Object.is(n, -0)) return fallback;
    return Math.max(bounds.min, Math.min(bounds.max, n));
}

async function updateGlobalMaxTokens(value) {
    var clamped = _clampSettingNumber(value, SETTINGS_NUMBER_LIMITS.maxTokens, DEFAULT_MAX_TOKENS);
    var normalized = await saveGlobalMaxTokens(clamped);
    var input = document.getElementById('settings-page-max-tokens');
    if (input) input.value = normalized;
}

async function updateGlobalThinkingBudget(value) {
    var clamped = _clampSettingNumber(value, SETTINGS_NUMBER_LIMITS.thinkingBudget, DEFAULT_THINKING_BUDGET);
    var normalized = await saveGlobalThinkingBudget(clamped);
    var input = document.getElementById('settings-page-thinking-budget');
    if (input) input.value = normalized;
}

// Settings-page wrapper for the Context Window field. Clamps FIRST, then
// delegates to updateAssumedContextTokens (ui/070-dashboard-ui.js) which
// persists via saveAssumedContextTokens, repaints the input and refreshes the
// context indicator. Because the value handed over is already valid, the
// input, the `assumedContextTokens` global and the IDB row cannot diverge.
async function updateAssumedContextTokensFromSettings(value) {
    var clamped = _clampSettingNumber(value, SETTINGS_NUMBER_LIMITS.contextWindow, ASSUMED_CONTEXT_TOKENS_DEFAULT);
    if (typeof updateAssumedContextTokens === 'function') {
        return await updateAssumedContextTokens(clamped);
    }
    return clamped;
}

// Sub-agent tier alias settings (Orchestrator §1). Renders one row per
// tier (small/medium/large) with a provider dropdown over apiProviders.
// The map lives in the IDB settings store (TIER_ALIASES_SETTING_KEY, see
// core/030-config.js); the SW re-hydrates it on every run-agent gate so
// spawn-time tier resolution picks changes up on the next run.
var TIER_ALIAS_HINTS = {
    small: 'Cheap + fast — search fan-outs, summaries, doc lookups',
    medium: 'Balanced — general delegated work',
    large: 'Strongest — heavy implementation / debugging subs'
};
function renderTierAliasSettings() {
    var container = document.getElementById('tier-aliases-list');
    if (!container) return;
    var doRender = function() {
        var map = getTierAliasMap();
        var html = '';
        SUBAGENT_TIER_NAMES.forEach(function(tier) {
            var current = map[tier];
            // "Same" pseudo-option (TIER_ALIAS_SAME, core/030-config.js):
            // the tier follows the spawning agent's current model dynamically
            // — identical behavior to an explicit tier:'same' spawn.
            var isSame = (typeof TIER_ALIAS_SAME !== 'undefined' && current === TIER_ALIAS_SAME);
            var options = '<option value="' + TIER_ALIAS_SAME + '"' + (isSame ? ' selected' : '') + '>Same</option>';
            var found = isSame;
            (apiProviders || []).forEach(function(p) {
                if (p.name === current) found = true;
                options += '<option value="' + escapeHtml(p.name) + '"' + (p.name === current ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
            });
            // Mapped provider no longer exists (deleted/renamed) — keep it
            // visible + selected so the user sees the stale mapping.
            if (!found && current) {
                options = '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + ' (missing)</option>' + options;
            }
            html += '<div class="settings-page-row">' +
                '<div><div class="settings-page-row-label" style="text-transform:capitalize;">' + tier + '</div>' +
                '<div class="settings-page-row-hint">' + (TIER_ALIAS_HINTS[tier] || '') + '</div></div>' +
                '<select onchange="setTierAlias(\'' + tier + '\', this.value)" style="padding: var(--space-2) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-body-sm);">' +
                    options +
                '</select>' +
            '</div>';
        });
        container.innerHTML = html;
    };
    // First render on this page load: hydrate the stored overrides, then paint.
    if (subAgentTierAliases === null && typeof loadTierAliases === 'function') {
        loadTierAliases().then(doRender);
    } else {
        doRender();
    }
}
function setTierAlias(tier, providerName) {
    var map = getTierAliasMap();
    map[tier] = providerName;
    saveTierAliases(map);
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
    // Normalize before validate/save so the stored githubInstanceUrl is
    // canonical — trailing-slash/case variants break the strict-equality API
    // base derivations (normalizeGitHubInstanceUrl: core/130-indexeddb.js).
    var instanceUrl = normalizeGitHubInstanceUrl(instanceInput && instanceInput.value);
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

// Workspace recency is persisted as meta.last_used_at whenever resolveWorkspace
// selects an explicit/default workspace (the actual tool-use path). New clones
// initialize it too. Older rows safely fall back to cloned_at; rows with neither
// timestamp remain visible but are deferred until the pill is opened.
var _WS_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
var _WS_EAGER_REFRESH_LIMIT = 5;
var _WS_REFRESH_CONCURRENCY = 3;
var _wsRemoteSyncInFlight = {};
var _wsRemoteSyncQueue = [];
var _wsRemoteSyncActive = 0;
var _wsDropdownSyncInFlight = null;

function _wsRecencyTimestamp(meta) {
    return Number(meta && (meta.last_used_at || meta.cloned_at)) || 0;
}

function _wsEagerRefreshKeys(metas) {
    var cutoff = Date.now() - _WS_RECENT_WINDOW_MS;
    return (metas || []).filter(function(m) { return _wsRecencyTimestamp(m) >= cutoff; })
        .sort(function(a, b) { return _wsRecencyTimestamp(b) - _wsRecencyTimestamp(a); })
        .slice(0, _WS_EAGER_REFRESH_LIMIT)
        .map(function(m) { return m.repo; });
}

async function _wsRunBounded(items, limit, worker) {
    var next = 0;
    var count = Math.min(Math.max(1, limit || 1), items.length);
    var runners = [];
    for (var i = 0; i < count; i++) {
        runners.push((async function() {
            while (next < items.length) {
                var item = items[next++];
                await worker(item);
            }
        })());
    }
    await Promise.all(runners);
}

function _wsDrainRemoteSyncQueue() {
    while (_wsRemoteSyncActive < _WS_REFRESH_CONCURRENCY && _wsRemoteSyncQueue.length) {
        var job = _wsRemoteSyncQueue.shift();
        _wsRemoteSyncActive++;
        Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(function() {
            _wsRemoteSyncActive--;
            _wsDrainRemoteSyncQueue();
        });
    }
}

// One global UI scheduler owns every wsSyncWithRemote call. Settings, startup,
// focus/header refresh and dropdown batches all share these same three slots.
// The per-workspace map is populated before enqueueing, so queued and active
// requests are both single-flight.
function _wsSyncOnce(wk) {
    if (_wsRemoteSyncInFlight[wk]) return _wsRemoteSyncInFlight[wk];
    var scheduled = new Promise(function(resolve, reject) {
        _wsRemoteSyncQueue.push({
            run: function() { return wsSyncWithRemote(wk); },
            resolve: resolve,
            reject: reject
        });
        _wsDrainRemoteSyncQueue();
    });
    _wsRemoteSyncInFlight[wk] = scheduled.finally(function() { delete _wsRemoteSyncInFlight[wk]; });
    return _wsRemoteSyncInFlight[wk];
}

function _wsLoadingHtml(label) {
    return '<span class="ws-refresh-indicator"><span class="dropdown-loading-spinner" aria-hidden="true"></span>' + escapeHtml(label || 'Refreshing…') + '</span>';
}

// GitHub repos list in settings
async function renderGitHubReposList() {
    var container = document.getElementById('github-repos-list');
    if (!container) return;
    container.innerHTML = '<div class="ws-settings-loading">' + _wsLoadingHtml('Loading local workspaces…') + '</div>';
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

        // Load LOCAL details concurrently so every repository becomes visible
        // without waiting for sequential per-workspace IndexedDB reads.
        var html = '';
        var eagerKeys = _wsEagerRefreshKeys(repos);
        var eagerSet = {};
        eagerKeys.forEach(function(k) { eagerSet[k] = true; });
        var repoData = await Promise.all(repos.map(async function(meta) {
            var wk = meta.repo;
            var githubRepo = meta.github_repo || parseWsKey(wk).repo;
            var pair = await Promise.all([getAllWorkspaceFiles(wk), wsGetIgnoreFilterLocal(wk)]);
            var files = pair[0];
            var isIgnored = pair[1];
            var totalFiles = files.length;
            var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
            var dirtyCount = dirtyFiles.length;
            var totalSize = 0;
            files.forEach(function(f) { totalSize += (f.content || '').length; });
            var sizeStr = totalSize > 1048576 ? (totalSize / 1048576).toFixed(1) + ' MB' : totalSize > 1024 ? (totalSize / 1024).toFixed(0) + ' KB' : totalSize + ' B';
            var pushedPrs = {};
            dirtyFiles.forEach(function(f) {
                if (f.pushed_pr && f.pushed_pr.url) {
                    var key = f.pushed_pr.url;
                    if (!pushedPrs[key]) pushedPrs[key] = { pr: f.pushed_pr, files: [] };
                    pushedPrs[key].files.push(f.path);
                }
            });
            var prLinks = Object.keys(pushedPrs).map(function(key) { return pushedPrs[key]; });
            var unpushedDirty = dirtyFiles.filter(function(f) { return !f.pushed_pr; });
            return { meta: meta, wk: wk, githubRepo: githubRepo, totalFiles: totalFiles, dirtyFiles: dirtyFiles, dirtyCount: dirtyCount, sizeStr: sizeStr, prLinks: prLinks, unpushedDirty: unpushedDirty, eager: !!eagerSet[wk] };
        }));

        for (var ri = 0; ri < repoData.length; ri++) {
            var rd = repoData[ri];

            // Remote sync status: eager only for recent MRU workspaces; older
            // local rows stay deferred until the workspace pill is opened.
            var syncSpanId = 'repo-sync-' + ri;

            // Dirty count for header line
            var dirtyLabel = rd.dirtyCount > 0 ? '<span style="color:var(--warning);">' + rd.dirtyCount + ' modified</span>' : '';

            // File rows (same style as header dropdown)
            var detailHtml = '<div id="repo-detail-' + ri + '" style="margin-top:var(--space-2);">';
            // Rows are DOM-built after container.innerHTML below (via the shared
            // _dirtyFileRow, so the owning-chat chip + its click handler match
            // the header dropdown) — the div starts empty here.
            detailHtml += '</div>';

            html += '<div class="settings-page-row" data-wk="' + escapeHtml(rd.wk) + '" style="padding:var(--space-4) 0;border-bottom:1px solid var(--border);align-items:flex-start;">' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="display:flex;align-items:center;gap:var(--space-4);">' +
                        '<div class="settings-page-row-label" style="margin:0;">' + escapeHtml(rd.githubRepo) + '</div>' +
                        '<span style="font-size:var(--text-caption);color:var(--text-muted);background:var(--bg-tertiary);padding:1px var(--space-3);border-radius:var(--radius-sm);">' + escapeHtml(rd.meta.branch) + '</span>' +
                    '</div>' +
                    '<div style="font-size:var(--text-caption);color:var(--text-muted);margin-top:var(--space-2);display:flex;gap:var(--space-6);flex-wrap:wrap;">' +
                        '<span>' + rd.totalFiles + ' files</span>' +
                        '<span>' + rd.sizeStr + '</span>' +
                        '<span id="' + syncSpanId + '" style="color:var(--text-muted);">' + (rd.eager ? _wsLoadingHtml('Refreshing…') : 'Refreshes when workspace pill opens') + '</span>' +
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

        // Fill dirty-file rows with the shared DOM row builder (_dirtyFileRow):
        // string HTML can't carry the chat chip's click listener.
        for (var fi = 0; fi < repoData.length; fi++) {
            var fillEl = document.getElementById('repo-detail-' + fi);
            if (!fillEl) continue;
            repoData[fi].dirtyFiles.forEach(function(f) { fillEl.appendChild(_dirtyFileRow(f)); });
        }

        // Only the five most-recent workspaces used in the rolling last 7 days
        // refresh eagerly. Older rows remain visible from local data and are
        // refreshed, with bounded concurrency, when the workspace pill opens.
        var eagerJobs = [];
        for (var ci = 0; ci < repoData.length; ci++) {
            if (repoData[ci].eager) eagerJobs.push({ idx: ci, rd: repoData[ci] });
        }
        _wsRunBounded(eagerJobs, _WS_REFRESH_CONCURRENCY, function(job) {
                var idx = job.idx;
                var rd = job.rd;
                var el = document.getElementById('repo-sync-' + idx);
                if (!el) return Promise.resolve();
                return _wsSyncOnce(rd.wk).then(function(syncResult) {
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
                    wsGetIgnoreFilterLocal(rd.wk).then(function(isIgnored) {
                        getAllWorkspaceFiles(rd.wk).then(function(freshFiles) {
                            var freshDirty = freshFiles.filter(function(f) { return f.dirty && !isIgnored(f.path); });
                            var countEl = document.getElementById('repo-dirty-' + idx);
                            if (countEl) {
                                countEl.innerHTML = freshDirty.length > 0 ? '<span style="color:var(--warning);">' + freshDirty.length + ' modified</span>' : '';
                            }
                            var detailEl = document.getElementById('repo-detail-' + idx);
                            if (detailEl) {
                                // Same shared DOM row builder as the initial render —
                                // keeps the owning-chat chip on refreshed rows too.
                                detailEl.innerHTML = '';
                                freshDirty.forEach(function(f) { detailEl.appendChild(_dirtyFileRow(f)); });
                                var rows = '';
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
                                detailEl.insertAdjacentHTML('beforeend', rows);
                            }
                        });
                    });
                }).catch(function() {
                    if (el && el.parentNode) { el.style.color = 'var(--text-muted)'; el.textContent = 'offline'; }
                });
        }).catch(function() {});
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
    // Remove the workspace from every in-memory surface immediately. Persistence
    // is verified below; on failure the canonical IDB-backed renders restore it.
    delete _wsHeaderCaches[repo];
    if (_wsDropdown) {
        var section = _wsDropdown.querySelector('[data-ws="' + CSS.escape(repo) + '"]');
        if (section) section.remove();
        _reconcileThisChatSection();
        if (Object.keys(_wsHeaderCaches).length === 0) hideWorkspaceDropdown();
    }
    _renderWsHeaderBadge();

    var container = document.getElementById('github-repos-list');
    if (container) {
        var rows = container.querySelectorAll('.settings-page-row[data-wk]');
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute('data-wk') === repo) { rows[i].remove(); break; }
        }
        if (!container.querySelector('.settings-page-row[data-wk]')) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:var(--text-body-sm);padding:var(--space-4) 0;">No repositories cloned yet.</div>';
        }
    }

    try {
        await deleteLocalWorkspaceData(repo);
        var remainingMeta = await getWorkspaceMeta(repo);
        var remainingFiles = await getAllWorkspaceFiles(repo);
        if (remainingMeta || remainingFiles.length > 0) throw new Error('Local workspace data could not be fully removed');
        try { gcWorkspaceBlobs(); } catch (e) {}
        try { AgentEvents.emit('workspaceMutated', { action: 'delete_local_workspace', repo: repo }); } catch (e2) {}
        await updateWorkspaceHeaderStatus();
        _reconcileDropdownSections();
        return { success: true };
    } catch (e) {
        // Restore every surface from persistence when cleanup did not complete.
        await updateWorkspaceHeaderStatus();
        _reconcileDropdownSections();
        renderGitHubReposList();
        return { success: false, error: e && e.message ? e.message : String(e) };
    }
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
        var isIgnored = await wsGetIgnoreFilterLocal(wk);
        var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
        var prev = _wsHeaderCaches[wk];
        summaries.push({
            wk: wk,
            meta: meta,
            dirtyCount: dirtyFiles.length,
            dirtyFiles: dirtyFiles,
            syncStatus: prev ? prev.syncStatus : 'deferred',
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
    var anyRefreshing = false;
    keys.forEach(function(k) {
        var c = _wsHeaderCaches[k];
        totalDirty += c.dirtyCount;
        if (c.dirtyCount > 0) reposWithChanges++;
        if (c.syncStatus === 'behind') anyBehind = true;
        if (c.syncStatus === 'refreshing') anyRefreshing = true;
    });

    els.forEach(function(el) {
        if (!el) return;
        if (anyRefreshing) {
            el.className = 'ws-header-status modified';
            el.innerHTML = '<span class="ws-icon">' + gitBranch + '</span>' + _wsLoadingHtml('Refreshing…');
        } else if (anyBehind) {
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

// Background refresh: local state for every workspace, then remote state only
// for workspaces used in the rolling last 7 days, capped to the five MRU.
// Single-flight: concurrent callers (nav/focus/chat-switch triggers plus the
// dropdown-open overlap) share ONE in-flight run instead of interleaving
// _wsHeaderCaches wipes/writes (each run starts by resetting the cache).
var _syncHdrInFlight = null;
function syncAndUpdateWorkspaceHeader() {
    if (_syncHdrInFlight) return _syncHdrInFlight;
    _syncHdrInFlight = _syncAndUpdateWorkspaceHeaderInner().finally(function() { _syncHdrInFlight = null; });
    return _syncHdrInFlight;
}
async function _syncAndUpdateWorkspaceHeaderInner() {
    try {
        var summaries = await getAllWorkspaceSummaries();
        _wsHeaderCaches = {};
        summaries.forEach(function(s) { _wsHeaderCaches[s.wk] = s; });
        _renderWsHeaderBadge();

        var eagerKeys = _wsEagerRefreshKeys(summaries.map(function(s) { return s.meta; }));
        var eager = summaries.filter(function(s) { return eagerKeys.indexOf(s.wk) !== -1; });
        eager.forEach(function(s) { s.syncStatus = 'refreshing'; _wsHeaderCaches[s.wk].syncStatus = 'refreshing'; });
        _renderWsHeaderBadge();
        await _wsRunBounded(eager, _WS_REFRESH_CONCURRENCY, function(s) {
            return _wsSyncOnce(s.wk).then(async function(syncResult) {
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
                // A local delete may race this remote sync. `wsSyncWithRemote`
                // returns null when metadata vanished; never turn that into an
                // "offline" cache entry that exists only in the pill dropdown.
                if (!meta) {
                    delete _wsHeaderCaches[s.wk];
                    _renderWsHeaderBadge();
                    _reconcileDropdownSections();
                    return;
                }
                var isIgnored = await wsGetIgnoreFilterLocal(s.wk);
                var files = await getAllWorkspaceFiles(s.wk);
                // Final post-await existence check closes the delete-vs-sync race:
                // if deletion committed while files/ignore state loaded, do not
                // reinsert the old meta into the header cache.
                meta = await getWorkspaceMeta(s.wk);
                if (!meta) {
                    delete _wsHeaderCaches[s.wk];
                    _renderWsHeaderBadge();
                    _reconcileDropdownSections();
                    return;
                }
                var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
                _wsHeaderCaches[s.wk] = {
                    wk: s.wk, meta: meta, dirtyCount: dirtyFiles.length, dirtyFiles: dirtyFiles,
                    syncStatus: syncStatus,
                    behindFiles: syncResult ? syncResult.behindFiles || [] : [],
                    conflictFiles: syncResult ? syncResult.conflictFiles || [] : []
                };
                _renderWsHeaderBadge();
            }).catch(function() {
                if (_wsHeaderCaches[s.wk]) _wsHeaderCaches[s.wk].syncStatus = 'offline';
                _renderWsHeaderBadge();
                if (_wsDropdown) {
                    var section = _wsDropdown.querySelector('[data-ws="' + CSS.escape(s.wk) + '"]');
                    if (section && _wsHeaderCaches[s.wk]) _renderDropdownSection(section, _wsHeaderCaches[s.wk]);
                    _reconcileThisChatSection();
                }
            });
        });
    } catch (e) {
        // Never leave a "Refreshing…" badge/section stranded after a batch-level
        // failure (for example a local summary read error). Preserve existence
        // guards because deletion may have committed while the batch was active.
        Object.keys(_wsHeaderCaches).forEach(function(wk) {
            if (_wsHeaderCaches[wk] && _wsHeaderCaches[wk].syncStatus === 'refreshing') {
                _wsHeaderCaches[wk].syncStatus = 'offline';
            }
        });
        _renderWsHeaderBadge();
        if (_wsDropdown) _reconcileDropdownSections();
    }
}

async function toggleWorkspaceDropdown() {
    if (_wsDropdown) { hideWorkspaceDropdown(); return; }
    // Only one header dropdown open at a time
    if (typeof closeAllHeaderMenus === 'function') closeAllHeaderMenus('workspace');
    // Open INSTANTLY from the cached header state (_wsHeaderCaches is kept warm
    // by startup + every sync). The user mostly wants dirty files / PR links,
    // which the cache already has — everything else refreshes lazily below.
    var hadCache = Object.keys(_wsHeaderCaches).length > 0;
    if (!hadCache) {
        // First-ever open with a cold cache: one local scan so we know what exists.
        await updateWorkspaceHeaderStatus();
    }
    showWorkspaceDropdown();

    // Lazy phase 1 — resolve extension-dev mode (gates the per-repo pin button,
    // same condition the Reload button is shown under) without blocking the
    // open. The value is sticky across opens, so pins render instantly from the
    // second open on; on a change we re-render the open sections in place.
    var extDevPromise;
    try { extDevPromise = (typeof _reloadRebuildsFromWorkspace === 'function') ? Promise.resolve(_reloadRebuildsFromWorkspace()) : Promise.resolve(false); }
    catch (e) { extDevPromise = Promise.resolve(false); }
    extDevPromise.then(function(v) {
        if (!!v !== _wsExtDevMode) { _wsExtDevMode = !!v; _reconcileDropdownSections(); }
    }).catch(function() {});

    // Lazy phase 2 — refresh local dirty files / PR links from IndexedDB and
    // reconcile the open dropdown in place (preserves collapse toggles).
    if (hadCache) {
        await updateWorkspaceHeaderStatus();
        _reconcileDropdownSections();
    }

    // Opening the pill is the explicit refresh gesture for ALL locally visible
    // workspaces, including deferred/older ones. Run at most three requests at a
    // time and progressively repaint each section.
    _syncDropdownInBackground();
}

// Operation-level single-flight: repeated opens during one dropdown refresh
// share the exact batch snapshot. No workspace is added twice to that batch.
function _syncDropdownInBackground() {
    if (_wsDropdownSyncInFlight) return _wsDropdownSyncInFlight;
    _wsDropdownSyncInFlight = _syncDropdownBatch(Object.keys(_wsHeaderCaches)).finally(function() {
        _wsDropdownSyncInFlight = null;
    });
    return _wsDropdownSyncInFlight;
}

async function _syncDropdownBatch(keys) {
    keys.forEach(function(wk) {
        if (_wsHeaderCaches[wk]) _wsHeaderCaches[wk].syncStatus = 'refreshing';
        if (_wsDropdown) {
            var section = _wsDropdown.querySelector('[data-ws="' + CSS.escape(wk) + '"]');
            if (section) _renderDropdownSection(section, _wsHeaderCaches[wk]);
        }
    });
    await _wsRunBounded(keys, _WS_REFRESH_CONCURRENCY, function(wk) {
        return _wsSyncOnce(wk).then(async function(syncResult) {
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
            // The workspace can be deleted while this remote request is in
            // flight. Drop the stale cache section instead of resurrecting it.
            if (!meta) {
                delete _wsHeaderCaches[wk];
                _reconcileDropdownSections();
                _renderWsHeaderBadge();
                return;
            }
            var isIgnored = await wsGetIgnoreFilterLocal(wk);
            var files = await getAllWorkspaceFiles(wk);
            // Re-check after all awaits so a concurrent local delete cannot be
            // undone by this background renderer's stale metadata snapshot.
            meta = await getWorkspaceMeta(wk);
            if (!meta) {
                delete _wsHeaderCaches[wk];
                _reconcileDropdownSections();
                _renderWsHeaderBadge();
                return;
            }
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
                _reconcileThisChatSection();
            }
        }).catch(function() {
            if (_wsHeaderCaches[wk]) _wsHeaderCaches[wk].syncStatus = 'offline';
            if (_wsDropdown) {
                var section = _wsDropdown.querySelector('[data-ws="' + CSS.escape(wk) + '"]');
                if (section) _renderDropdownSection(section, _wsHeaderCaches[wk]);
            }
        });
    });
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
        syncStatus === 'deferred' ? '<span class="ws-sync">opens to refresh</span>' :
        '<span class="ws-sync">' + _wsLoadingHtml('Refreshing…') + '</span>';
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

function _wsDeleteBtnHtml(wk) {
    var icon = (typeof UI_ICONS !== 'undefined' && UI_ICONS.trash) ? UI_ICONS.trash : '\u00d7';
    return '<button class="ws-delete-btn" data-delete-ws="' + escapeHtml(wk) +
        '" title="Delete this local workspace" aria-label="Delete local workspace ' + escapeHtml(wk) + '">' + icon + '</button>';
}

async function _deleteWorkspaceFromDropdown(wk) {
    var parsed = parseWsKey(wk);
    var cache = _wsHeaderCaches[wk];
    var dirtyCount = cache ? cache.dirtyCount : 0;
    var dirtyWarning = dirtyCount > 0
        ? '<br><br><strong>This permanently discards ' + dirtyCount + ' uncommitted local change' + (dirtyCount === 1 ? '' : 's') + '.</strong>'
        : '';
    var confirmed = await showConfirmModal('Delete local workspace?',
        'Delete <strong>' + escapeHtml(parsed.repo) + ' (' + escapeHtml(parsed.branch) + ')</strong> from this browser?' + dirtyWarning +
        '<br><br>The GitHub repository and remote branch will not be deleted.', 'danger');
    if (!confirmed) return;

    var result = await deleteGitHubRepo(wk);
    if (typeof showSnackbar === 'function') {
        if (result && result.success) showSnackbar('Deleted local workspace ' + parsed.repo + ' (' + parsed.branch + ')');
        else showSnackbar('Delete failed: ' + ((result && result.error) || 'unknown error'), 'error');
    }
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
    // The toggle itself. A failure here USED to be swallowed by a bare
    // `catch (e) {}`, so a pin/unpin that never happened looked identical to
    // one that did. Surface it (same showSnackbar pattern as the re-clone
    // handler above). setWorkspacePin semantics are unchanged.
    try {
        var meta = await getWorkspaceMeta(wk);
        if (!meta) {
            if (typeof showSnackbar === 'function') showSnackbar('Pin failed: no local workspace metadata for ' + wk, 'error');
            return;
        }
        await setWorkspacePin(wk, !!meta.pinned); // toggle
    } catch (e) {
        if (typeof showSnackbar === 'function') showSnackbar('Pin update failed: ' + (e && e.message ? e.message : String(e)), 'error');
        return;
    }
    // Refresh cached metas + re-render every open dropdown section (a pin
    // elsewhere may have been cleared by the single-pin invariant). Kept in a
    // SEPARATE try so a re-render hiccup is never mis-reported as a pin
    // failure -- the pin already succeeded -- but is not silent either.
    try {
        var all = await getAllWorkspaceMetas();
        all.forEach(function(m) { if (_wsHeaderCaches[m.repo]) _wsHeaderCaches[m.repo].meta = m; });
        if (_wsDropdown) {
            Object.keys(_wsHeaderCaches).forEach(function(k) {
                var section = _wsDropdown.querySelector('[data-ws="' + CSS.escape(k) + '"]');
                if (section) _renderDropdownSection(section, _wsHeaderCaches[k]);
            });
        }
        renderGitHubReposList();
    } catch (e2) {
        console.warn('[workspace-pin] pin saved but UI refresh failed', e2);
    }
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

// Deterministic hue (0-359) hashed from a chat id. The same chat always gets
// the same color, across renders and reloads, with no coordination needed —
// this is how edits from MULTIPLE chats are differentiated in the workspace
// dropdown: color groups files visually, the tooltip names the chat, and
// clicking the chip jumps straight to that chat.
function _wsChatHue(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
    return h % 360;
}

// Hue for a chat id ROLLED UP to its root (main/parent) chat: a sub-agent's
// chip hashes the ROOT chat id, so all workers of one parent task share one
// color (a PR pushed by worker A with files edited by sibling worker B no
// longer renders two hues). Resolution reuses the tool-layer _wsRootChatId
// (tools/020-tool-execution.js — synchronous, in-memory sub-agent registry
// lookup with root_chat_id fast path + capped parent walk for nesting). NOT
// memoized on purpose: getByChatId is a small linear scan, and the registry
// can populate AFTER the first dropdown paint (SW hello snapshot race) — a
// cache would pin the un-rolled hue forever. Falls back to the chat's own
// hue when the resolver is unavailable or the chat is not a sub.
function _wsChatHueRoot(id) {
    var root = id;
    try {
        if (typeof _wsRootChatId === 'function') root = _wsRootChatId(id) || id;
    } catch (e) { /* resolver unavailable — use the chat's own hue */ }
    return _wsChatHue(root);
}

// Lazy PR-url → pushing-chat index, rebuilt by scanning chats' recorded push
// tool results. Retroactive fallback for dirty files pushed BEFORE the
// pushed_by_chat_id stamp existed (or whose stamp was lost). Memoized; a
// lookup miss triggers a rebuild at most once per 5s.
var _wsPrChatIdx = null;
var _wsPrChatIdxAt = 0;
function _wsPrChatLookup(prUrl) {
    if (!prUrl || typeof chats === 'undefined' || !chats) return null;
    var now = Date.now();
    // Rebuild on a miss (throttled to 5s) OR when the index is older than 60s
    // even on a hit — so renamed chats / later pushes refresh chip attribution.
    if (!_wsPrChatIdx || ((!_wsPrChatIdx[prUrl] || now - _wsPrChatIdxAt > 60000) && now - _wsPrChatIdxAt > 5000)) {
        _wsPrChatIdxAt = now;
        var idx = {};
        Object.keys(chats).forEach(function(cid) {
            var chat = chats[cid];
            if (!chat || !chat.messages) return;
            chat.messages.forEach(function(msg) {
                if (msg.role !== 'tool' || typeof msg.content !== 'string') return;
                if (msg.content.indexOf('pr_url') === -1) return; // cheap prefilter
                try {
                    var r = JSON.parse(msg.content);
                    // Later pushes overwrite — the LAST pusher owns the chip.
                    // Only actual pushes — workspace-status auto-delete results
                    // also carry pr_url/pr_number but are NOT this chat's push.
                    if (r && r.success && r.pr_url && r.pr_number && !r.auto_deleted) idx[r.pr_url] = { chatId: cid, chatTitle: chat.title || '' };
                } catch (e) { /* not JSON — skip */ }
            });
        });
        _wsPrChatIdx = idx;
    }
    return _wsPrChatIdx[prUrl] || null;
}

// Small color-coded chat chip for a dirty file row whose changes are tied to
// a chat: live uncommitted ownership (last_modified_by_chat_id, see cross-chat
// ownership in 020-tool-execution.js), or — after a push released that stamp —
// the pushing chat (pushed_by_chat_id, with a retroactive scan of recorded
// push results as last resort). Click → open that chat. No chip is rendered
// for the CURRENT chat (its files are already grouped under the "This chat"
// section); a chip for an unresolvable chat renders muted/inert.
//
// COLOR encodes the MAIN (root/parent) chat of the attributed chat's lineage,
// not the individual worker: files touched by different sub-agents of the
// same parent task share ONE hue (see _wsChatHueRoot). The tooltip keeps the
// worker's name for provenance — only the color rolls up.
//
// Chat resolution falls back to the sub-agent registry: a worker chat can be
// missing from the in-memory `chats` map (never-persisted / reaped sub, or a
// post-reload race where the dropdown paints before the SW hello snapshot
// repopulates `chats`) while its registry record still exists — those chips
// stay clickable and name the worker instead of rendering as "gone".
function _wsResolveChatRef(cid) {
    if (typeof chats !== 'undefined' && chats && chats[cid]) {
        return { title: chats[cid].title || '', isSub: !!chats[cid].isSubAgent };
    }
    try {
        if (typeof SubAgents !== 'undefined' && SubAgents && SubAgents.getByChatId) {
            var rec = SubAgents.getByChatId(cid);
            if (rec) return { title: rec.name || '', isSub: true };
        }
    } catch (e) { /* registry unavailable — treat as unknown */ }
    return null;
}

// UI-side same-lineage check (current chat ↔ its own subs / sibling subs of
// one root). Reuses the tool-layer _wsSameChatLineage when the bundle has it
// (the page bundle includes tools/020-tool-execution.js); otherwise falls
// back to exact equality.
function _wsUiSameLineage(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
        if (typeof _wsSameChatLineage === 'function') return _wsSameChatLineage(a, b);
    } catch (e) { /* fall through */ }
    return false;
}

function _wsChatChip(f) {
    var cid = f.last_modified_by_chat_id;
    var stampTitle = f.last_modified_by_chat_title;
    var pushed = false;
    if (!cid && f.pushed_by_chat_id) {
        cid = f.pushed_by_chat_id;
        stampTitle = f.pushed_by_chat_title;
        pushed = true;
    }
    if (!cid && f.pushed_pr && f.pushed_pr.url) {
        var hit = _wsPrChatLookup(f.pushed_pr.url);
        if (hit) { cid = hit.chatId; stampTitle = hit.chatTitle; pushed = true; }
    }
    if (!cid) return null;
    if (typeof currentChatId !== 'undefined' && currentChatId === cid) return null;
    var ref = _wsResolveChatRef(cid);
    var known = !!ref;
    var isWorker = !!(ref && ref.isSub);
    var title = stampTitle || (ref && ref.title) || 'Untitled chat';
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ws-file-chat' + (!known ? ' gone' : '');
    chip.style.setProperty('--chat-hue', String(_wsChatHueRoot(cid)));
    // Truthful verb: when the attributed chat is the EDITOR but a DIFFERENT
    // chat pushed the PR (pushed_pr.chatId is the actual pusher, stamped in
    // prInfo at push time), say "Edited … · pushed in PR #N" instead of the
    // misleading "Pushed by" (the editor never pushed anything).
    var who = (isWorker ? 'worker' : 'chat') + ' \u201c' + title + '\u201d';
    var prNumLabel = (f.pushed_pr && f.pushed_pr.number) ? 'PR #' + f.pushed_pr.number : '';
    var head;
    if (!pushed) {
        head = 'Edited by ' + who;
    } else if (f.pushed_pr && f.pushed_pr.chatId && f.pushed_pr.chatId !== cid) {
        head = 'Edited by ' + who + (prNumLabel ? ' \u00b7 pushed in ' + prNumLabel : ' \u00b7 pushed by another chat');
    } else {
        head = 'Pushed' + (prNumLabel ? ' (' + prNumLabel + ')' : '') + ' by ' + who;
    }
    chip.title = head + (!known ? ' \u2014 chat not loaded (may be deleted or a background worker)' : ' \u2014 click to open');
    chip.innerHTML = (typeof UI_ICONS !== 'undefined' && UI_ICONS.chat) ? UI_ICONS.chat : '\ud83d\udcac';
    chip.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (!known) return;
        if (typeof hideWorkspaceDropdown === 'function') hideWorkspaceDropdown();
        if (typeof selectChat === 'function') selectChat(cid);
    });
    return chip;
}

// Shared row builder for a dirty file (status badge + optional PR link +
// color-coded owning-chat chip).
function _dirtyFileRow(f) {
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
    var chip = _wsChatChip(f);
    if (chip) row.appendChild(chip);
    return row;
}

// Small uppercase group label used inside dropdown bodies.
function _wsGroupLabel(text) {
    var el = document.createElement('div');
    el.className = 'ws-file-group-label';
    el.textContent = text;
    return el;
}

// Aggregate dirty files whose uncommitted changes were stamped by the CURRENT
// chat OR one of its own sub-agents (same lineage — mirrors the cross-chat
// ownership rules in 020-tool-execution.js), grouped by workspace. Files
// stamped by a lineage sub still get a worker chip via _dirtyFileRow (only
// the exact current chat is chip-less). Returns [{wk, files:[...]}] in
// _wsHeaderCaches order.
function _thisChatChanges() {
    var cid = (typeof currentChatId !== 'undefined' && currentChatId) ? currentChatId : null;
    if (!cid) return [];
    var out = [];
    Object.keys(_wsHeaderCaches).forEach(function(wk) {
        var c = _wsHeaderCaches[wk];
        var files = ((c && c.dirtyFiles) || []).filter(function(f) { return _wsUiSameLineage(f.last_modified_by_chat_id, cid); });
        if (files.length > 0) out.push({ wk: wk, files: files });
    });
    return out;
}

// Create/refresh/remove the "This chat" section pinned to the TOP of the
// dropdown: lists each workspace this chat has touched with its dirty files.
// Rendered only when the current chat owns at least one uncommitted change.
function _reconcileThisChatSection() {
    if (!_wsDropdown) return;
    var groups = _thisChatChanges();
    var sec = _wsDropdown.querySelector('.ws-this-chat-section');
    if (groups.length === 0) { if (sec) sec.remove(); return; }
    if (!sec) {
        sec = document.createElement('div');
        sec.className = 'ws-dropdown-section ws-this-chat-section';
        var hdr = document.createElement('div');
        hdr.className = 'ws-dropdown-header';
        sec.appendChild(hdr);
        var bdy = document.createElement('div');
        bdy.className = 'ws-dropdown-body';
        sec.appendChild(bdy);
        // Pin below the "Repositories" title band (the band stays the first
        // child of the dropdown; "This chat" leads the section list).
        var band = _wsDropdown.querySelector('.ws-menu-title');
        _wsDropdown.insertBefore(sec, band ? band.nextSibling : _wsDropdown.firstChild);
    }
    var total = 0;
    groups.forEach(function(g) { total += g.files.length; });
    var chevron = '<span class="ws-collapse-chevron" aria-hidden="true">' + ((typeof UI_ICONS !== 'undefined' && UI_ICONS.chevronRight) ? UI_ICONS.chevronRight : '') + '</span>';
    var countChip = '<span class="ws-change-count" title="' + total + ' uncommitted change' + (total > 1 ? 's' : '') + ' by this chat">' + total + '</span>';
    var header = sec.querySelector('.ws-dropdown-header');
    var chatIcon = '<span class="section-icon">' + ((typeof UI_ICONS !== 'undefined' && UI_ICONS.chat) ? UI_ICONS.chat : '') + '</span>';
    header.innerHTML = '<span class="ws-dd-title">' + chevron + chatIcon + 'This chat' + countChip + '</span><span class="ws-sync">uncommitted</span>';
    var body = sec.querySelector('.ws-dropdown-body');
    body.innerHTML = '';
    groups.forEach(function(g) {
        var parsed = parseWsKey(g.wk);
        body.appendChild(_wsGroupLabel(parsed.repo + ' \u00b7 ' + parsed.branch));
        g.files.forEach(function(f) { body.appendChild(_dirtyFileRow(f)); });
    });
}

function _renderDropdownSection(section, cache) {
    var parsed = parseWsKey(cache.wk);
    var header = section.querySelector('.ws-dropdown-header');
    if (header) {
        // Clone button is always available; pin button only in extension-dev mode
        // (deploy folder connected), matching the Reload button's visibility gate.
        var cloneBtn = _wsCloneBtnHtml(parsed.repo, parsed.branch);
        var deleteBtn = _wsDeleteBtnHtml(cache.wk);
        var pinBtn = _wsExtDevMode ? _wsPinBtnHtml(cache.wk, !!(cache.meta && cache.meta.pinned)) : '';
        var chevron = '<span class="ws-collapse-chevron" aria-hidden="true">' + ((typeof UI_ICONS !== 'undefined' && UI_ICONS.chevronRight) ? UI_ICONS.chevronRight : '') + '</span>';
        var changeCount = _wsSectionChangeCount(cache);
        var countChip = changeCount > 0 ? '<span class="ws-change-count" title="' + changeCount + ' change' + (changeCount > 1 ? 's' : '') + '">' + changeCount + '</span>' : '';
        var repoIcon = '<span class="section-icon">' + ((typeof UI_ICONS !== 'undefined' && UI_ICONS.git) ? UI_ICONS.git : '') + '</span>';
        header.innerHTML = '<span class="ws-dd-title">' + chevron + repoIcon + escapeHtml(parsed.repo) + ' <span class="ws-branch">' + escapeHtml(parsed.branch) + '</span>' + countChip + cloneBtn + pinBtn + deleteBtn + '</span>' + _getSyncLabel(cache.syncStatus);
    }
    var body = section.querySelector('.ws-dropdown-body');
    if (!body) return;
    body.innerHTML = '';

    // Dirty files
    if (cache.dirtyFiles && cache.dirtyFiles.length > 0) {
        cache.dirtyFiles.forEach(function(f) { body.appendChild(_dirtyFileRow(f)); });
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

// Build one workspace section (header + collapsible body) from the current
// cache. Default expand state: when the CURRENT chat owns uncommitted changes
// (a "This chat" section is pinned on top), every workspace section starts
// collapsed so the this-chat files get the focus. Otherwise only the top 3
// workspaces (idx) start expanded, and even a top-3 workspace starts collapsed
// when it has more than 5 changes. User toggles and background re-renders
// preserve the class afterwards.
function _createDropdownSection(wk, idx) {
    var cache = _wsHeaderCaches[wk];
    var section = document.createElement('div');
    section.className = 'ws-dropdown-section';
    section.setAttribute('data-ws', wk);
    var thisChatHasChanges = _thisChatChanges().length > 0;
    if (thisChatHasChanges || idx >= 3 || _wsSectionChangeCount(cache) > 5) section.classList.add('collapsed');
    var header = document.createElement('div');
    header.className = 'ws-dropdown-header';
    section.appendChild(header);
    var body = document.createElement('div');
    body.className = 'ws-dropdown-body';
    section.appendChild(body);
    _renderDropdownSection(section, cache); // fills header + body
    return section;
}

// Reconcile the open dropdown with _wsHeaderCaches after a lazy refresh:
// re-render existing sections in place (preserving the user's collapse
// toggles), drop sections whose workspace vanished, and append sections for
// newly discovered workspaces.
function _reconcileDropdownSections() {
    if (!_wsDropdown) return;
    _wsDropdown.querySelectorAll('.ws-dropdown-section[data-ws]').forEach(function(sec) {
        if (!_wsHeaderCaches[sec.getAttribute('data-ws')]) sec.remove();
    });
    Object.keys(_wsHeaderCaches).forEach(function(wk) {
        var sec = _wsDropdown.querySelector('[data-ws="' + CSS.escape(wk) + '"]');
        if (sec) {
            _renderDropdownSection(sec, _wsHeaderCaches[wk]);
        } else {
            var idx = _wsDropdown.querySelectorAll('.ws-dropdown-section[data-ws]').length;
            _wsDropdown.appendChild(_createDropdownSection(wk, idx));
        }
    });
    _reconcileThisChatSection();
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
    dd.className = 'header-menu ws-dropdown';

    // Canonical section-title band (same .menu-section-title chrome as the
    // model / gear / jobs / usage / instance menus). Content-appropriate label
    // — the pill already says "workspace", the menu lists cloned repositories.
    var titleBand = document.createElement('div');
    titleBand.className = 'menu-section-title ws-menu-title';
    titleBand.innerHTML = '<span class="section-icon">' + ((typeof UI_ICONS !== 'undefined' && UI_ICONS.git) ? UI_ICONS.git : '') + '</span>Repositories';
    dd.appendChild(titleBand);

    keys.forEach(function(wk, idx) {
        dd.appendChild(_createDropdownSection(wk, idx));
    });

    // Delegated action handler — header innerHTML is re-rendered on every sync,
    // so per-button listeners would be lost; delegation survives it.
    dd.addEventListener('click', function(e) {
        var deleteBtn = e.target.closest('[data-delete-ws]');
        if (deleteBtn) {
            e.stopPropagation();
            _deleteWorkspaceFromDropdown(deleteBtn.getAttribute('data-delete-ws'));
            return;
        }
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
    _reconcileThisChatSection();

    setTimeout(function() {
        document.addEventListener('click', _onClickOutsideWsDropdown, true);
    }, 0);
}

// LLM Endpoints UI (Settings → LLM Endpoints) — restored after PR #824
// removed the section and inlined endpoints into providers. Endpoints are
// { id, name, url, apiKey }; endpoint-backed models reference one by
// endpointId and carry an inline snapshot of its url/apiKey for the request
// path.
function renderLlmEndpointsList() {
    var container = document.getElementById('llm-endpoints-list');
    if (!container) return;

    if (llmEndpoints.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:var(--text-body);padding: var(--space-4) 0;">No endpoints configured. Add one to use endpoint-backed models (subscription models don\'t need one).</div>';
        return;
    }

    var html = '';
    llmEndpoints.forEach(function(ep) {
        var domain = getEndpointDomain(ep.url);
        var domainTag = domain ? '<span class="provider-tag">' + escapeHtml(domain) + '</span>' : '';
        var keyTag = (ep.apiKey || '') ? '<span class="provider-tag">key set</span>' : '<span class="provider-tag">no key</span>';
        var useCount = apiProviders.filter(function(p) { return findEndpointForProvider(p) === ep; }).length;
        var usageTag = '<span class="provider-tag">' + useCount + ' model' + (useCount === 1 ? '' : 's') + '</span>';

        html += '<div class="api-provider-row">' +
            '<span class="api-provider-endpoint-icon">' + getEndpointIcon(ep.url) + '</span>' +
            '<span class="api-provider-name">' + escapeHtml(ep.name) + '</span>' +
            '<div class="api-provider-tags">' + domainTag + keyTag + usageTag + '</div>' +
            '<div class="api-provider-actions">' +
                '<button class="api-provider-btn" onclick="editLlmEndpoint(\'' + escapeJsString(ep.id) + '\')" title="Edit">' + UI_ICONS.edit + '</button>' +
                '<button class="api-provider-btn danger" onclick="confirmDeleteLlmEndpoint(\'' + escapeJsString(ep.id) + '\')" title="Delete">' + UI_ICONS.trash + '</button>' +
            '</div>' +
        '</div>';
    });
    container.innerHTML = html;
}

function editLlmEndpoint(endpointId) {
    var ep = getLlmEndpointById(endpointId);
    if (ep) showLlmEndpointModal(ep);
}

function showLlmEndpointModal(editingEndpoint) {
    var existingModal = document.getElementById('llm-endpoint-modal');
    if (existingModal) existingModal.remove();

    var isEditing = !!editingEndpoint;
    var ep = editingEndpoint || { id: '', name: '', url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: '' };

    var overlay = document.createElement('div');
    overlay.id = 'llm-endpoint-modal';
    overlay.className = 'modal-overlay show';
    // Same backdrop-press dismissal contract as the model modal above: only a
    // click whose mousedown STARTED on the backdrop closes; the Escape replay
    // (core/120-init.js) passes a synthetic non-isTrusted event and still closes.
    var backdropPressed = false;
    overlay.addEventListener('mousedown', function(e) { backdropPressed = (e.target === overlay); });
    overlay.onclick = function(e) {
        if (e.target !== overlay) return;
        if (e.isTrusted && !backdropPressed) return;
        closeLlmEndpointModal();
    };

    overlay.innerHTML =
        '<div class="modal-dialog" style="max-width:480px;">' +
            '<div class="modal-header">' + (isEditing ? 'Edit' : 'Add') + ' LLM Endpoint</div>' +
            '<div class="modal-body" style="display:flex;flex-direction:column;gap:var(--space-8);">' +
                '<div class="form-field">' +
                    '<label class="form-label">Name <span class="required">*</span></label>' +
                    '<input type="text" id="llm-endpoint-name" class="form-input" value="' + escapeHtml(ep.name) + '" placeholder="e.g. OpenRouter (work key)">' +
                '</div>' +
                '<div class="form-field">' +
                    '<label class="form-label">Endpoint URL <span class="required">*</span></label>' +
                    '<input type="text" id="llm-endpoint-url" class="form-input" value="' + escapeHtml(ep.url) + '" placeholder="https://openrouter.ai/api/v1/chat/completions">' +
                '</div>' +
                '<div class="form-field">' +
                    '<label class="form-label">API Key</label>' +
                    '<input type="password" id="llm-endpoint-apikey" class="form-input" value="' + escapeHtml(ep.apiKey || '') + '" placeholder="sk-or-...">' +
                '</div>' +
            '</div>' +
            '<div class="modal-actions">' +
                '<button class="modal-btn secondary" onclick="closeLlmEndpointModal()">Cancel</button>' +
                '<button class="modal-btn primary" onclick="saveLlmEndpointFromModal(\'' + escapeJsString(isEditing ? ep.id : '') + '\')">' + (isEditing ? 'Save' : 'Add') + '</button>' +
            '</div>' +
        '</div>';

    document.body.appendChild(overlay);
}

function closeLlmEndpointModal() {
    var modal = document.getElementById('llm-endpoint-modal');
    if (modal) modal.remove();
}

async function saveLlmEndpointFromModal(editingId) {
    var name = document.getElementById('llm-endpoint-name').value.trim();
    var url = document.getElementById('llm-endpoint-url').value.trim();
    var apiKey = document.getElementById('llm-endpoint-apikey').value.trim();

    if (!name || !url) {
        showSnackbar('Please fill in Name and Endpoint URL', 'error');
        return;
    }
    var nameClash = llmEndpoints.some(function(ep) { return ep.name === name && ep.id !== editingId; });
    if (nameClash) {
        showSnackbar('An endpoint with that name already exists', 'error');
        return;
    }

    // Stage detached clones. Nothing visible or global changes until the strict
    // cross-store transaction commits.
    var nextEndpoints = llmEndpoints.map(function(ep) { return Object.assign({}, ep); });
    var endpoint;
    if (editingId) {
        var existingIndex = nextEndpoints.findIndex(function(ep) { return ep.id === editingId; });
        if (existingIndex < 0) return;
        endpoint = Object.assign({}, nextEndpoints[existingIndex], { name: name, url: url, apiKey: apiKey });
        nextEndpoints[existingIndex] = endpoint;
    } else {
        var baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
        var newId = baseId;
        var suffix = 2;
        while (nextEndpoints.some(function(ep) { return ep.id === newId; })) { newId = baseId + '-' + suffix; suffix++; }
        endpoint = { id: newId, name: name, url: url, apiKey: apiKey };
        nextEndpoints.push(endpoint);
    }

    // Re-sync detached provider clones so endpoints + affected rows commit atomically.
    var touched = 0;
    var affectedProviders = [];
    var nextProviders = apiProviders.map(function(p) {
        if (p.endpointId !== endpoint.id) return p;
        touched++;
        var copy = Object.assign({}, p, { endpoint: endpoint.url, apiKey: endpoint.apiKey || '' });
        affectedProviders.push(copy);
        return copy;
    });

    try {
        await persistLlmEndpointState(nextEndpoints, affectedProviders);
    } catch (e) {
        console.error('Failed to save LLM endpoint:', e);
        showSnackbar('Could not save endpoint: ' + (e && e.message), 'error');
        return;
    }
    llmEndpoints = nextEndpoints;
    apiProviders = nextProviders;
    closeLlmEndpointModal();
    renderLlmEndpointsList();
    renderApiProvidersList();
    showSnackbar(editingId ? 'Endpoint updated' + (touched ? ' (' + touched + ' model' + (touched === 1 ? '' : 's') + ' re-synced)' : '') : 'Endpoint added', 'success');
}

async function confirmDeleteLlmEndpoint(endpointId) {
    var ep = getLlmEndpointById(endpointId);
    if (!ep) return;
    var useCount = apiProviders.filter(function(p) { return findEndpointForProvider(p) === ep; }).length;
    var msg = 'Delete endpoint "' + ep.name + '"?' + (useCount ? ' ' + useCount + ' model' + (useCount === 1 ? '' : 's') + ' reference it and will keep the current URL/key until re-saved.' : '') + ' This cannot be undone.';
    if (await showConfirmModal('Delete Endpoint', msg, 'danger')) {
        var nextEndpoints = llmEndpoints.filter(function(e) { return e.id !== endpointId; }).map(function(e) { return Object.assign({}, e); });
        try {
            await persistLlmEndpointState(nextEndpoints, []);
        } catch (e) {
            console.error('Failed to delete LLM endpoint:', e);
            showSnackbar('Could not delete endpoint: ' + (e && e.message), 'error');
            return;
        }
        llmEndpoints = nextEndpoints;
        renderLlmEndpointsList();
        showSnackbar('Endpoint deleted', 'success');
    }
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

// Canonical form of an endpoint URL for cross-record matching: lowercased,
// trailing slashes stripped, then common API path suffixes
// (/chat/completions, /completions, /responses, /messages) and a trailing
// /v1 removed — so 'https://openrouter.ai/api/v1/chat/completions' and
// 'https://OpenRouter.ai/api/v1/' compare equal.
function _normalizeEndpointUrl(url) {
    var u = (url || '').trim().toLowerCase();
    u = u.replace(/\/+$/, '');
    u = u.replace(/\/(chat\/completions|completions|responses|messages)$/, '');
    u = u.replace(/\/v1$/, '');
    return u.replace(/\/+$/, '');
}

// The LLM-endpoint record backing a model. Prefers the explicit endpointId
// reference; models saved before endpointId existed (PR #824 era — only an
// inline endpoint URL) fall back to a normalized-URL match, so legacy models
// still count toward / fold under their endpoint. Subscription models never
// match (their endpoint field is the OAuth backend URL, not a configured
// endpoint).
function findEndpointForProvider(provider) {
    if (!provider || provider.isChatGPTOAuth || provider.isClaudeOAuth) return null;
    if (provider.endpointId) {
        var byId = getLlmEndpointById(provider.endpointId);
        if (byId) return byId;
    }
    var norm = _normalizeEndpointUrl(provider.endpoint || '');
    if (!norm) return null;
    return llmEndpoints.find(function(ep) { return _normalizeEndpointUrl(ep.url) === norm; }) || null;
}

// Brand icon for an endpoint URL: OpenRouter mark for openrouter.ai, a
// monitor for local/LAN hosts, a globe for everything else.
function getEndpointIcon(url) {
    var host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) {}
    if (host.indexOf('openrouter') !== -1) return UI_ICONS.brandOpenRouter;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || /^192\.168\./.test(host) || /^10\./.test(host) || /\.local$/.test(host)) return UI_ICONS.brandLocalhost;
    return UI_ICONS.brandEndpoint;
}

// Auto display name from a model id: strip the vendor prefix before '/',
// split on - _ : and whitespace (dots only outside version numbers like 3.5),
// then title-case each word. Known acronyms keep their casing; tokens
// containing a digit ('4o', '3.5', 'v2') pass through verbatim.
var _MODEL_NAME_CASINGS = { gpt: 'GPT', chatgpt: 'ChatGPT', ai: 'AI', oss: 'OSS', glm: 'GLM', deepseek: 'DeepSeek', xai: 'xAI', llm: 'LLM' };
function autoNameFromModelId(modelId) {
    var id = (modelId || '').trim();
    if (!id) return '';
    var slash = id.lastIndexOf('/');
    if (slash !== -1) id = id.slice(slash + 1);
    var out = [];
    id.split(/[-_:@\s]+/).filter(Boolean).forEach(function(w) {
        var parts = /^\d+(\.\d+)*[a-z]*$/i.test(w) ? [w] : w.split('.').filter(Boolean);
        parts.forEach(function(t) {
            var lower = t.toLowerCase();
            if (_MODEL_NAME_CASINGS[lower]) out.push(_MODEL_NAME_CASINGS[lower]);
            else if (/\d/.test(t)) out.push(t);
            else out.push(t.charAt(0).toUpperCase() + t.slice(1));
        });
    });
    return out.join(' ');
}

// Display Name mirrors the Model ID while untouched; a manual edit sets the
// dirty flag and stops the mirroring (clearing the field re-arms it).
var _modelNameDirty = false;
function onModelIdInput(value) {
    if (_modelNameDirty) return;
    var nameField = document.getElementById('provider-name');
    if (nameField) nameField.value = autoNameFromModelId(value);
}
function onModelNameInput(value) {
    _modelNameDirty = value.trim() !== '';
}

// Endpoint radio group in the model modal — mirrors selectModelAuthKind and
// writes the chosen id to the hidden #provider-endpoint-select input that
// saveApiProviderFromModal reads.
function selectModelEndpoint(endpointId) {
    var group = document.getElementById('provider-endpoint-group');
    if (group) {
        group.querySelectorAll('.radio-option').forEach(function(opt) {
            var on = opt.getAttribute('data-value') === endpointId;
            opt.classList.toggle('selected', on);
            opt.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }
    var hidden = document.getElementById('provider-endpoint-select');
    if (hidden) hidden.value = endpointId;
}

// Reasoning-effort slider in the model modal: the pill-menu control
// (_EFFORT_LEVELS, ui/160-notifications.js) plus a TRAILING 'Default' stop at
// the high end — same semantics as the old select's empty option
// (provider.effort unset; saved value stays ''). Default sits at the top end
// because the server-side default effort is high (_providerDefaultEffort,
// ui/160-notifications.js), so displaying it below Low misread as minimal.
var _MODAL_EFFORT_LEVELS = [
    { v: 'low', label: 'Low' },
    { v: 'medium', label: 'Medium' },
    { v: 'high', label: 'High' },
    { v: 'xhigh', label: 'X-High' },
    { v: 'max', label: 'Max' },
    { v: '', label: 'Default' }
];
var _MODAL_EFFORT_DEFAULT_IDX = _MODAL_EFFORT_LEVELS.length - 1;
function _modalEffortLabelHtml(idx) {
    var e = _MODAL_EFFORT_LEVELS[idx] || _MODAL_EFFORT_LEVELS[_MODAL_EFFORT_DEFAULT_IDX];
    return '<span class="model-menu-effort-name">' + e.label + '</span>' +
        (e.v === '' ? '<span class="model-row-badge">server decides</span>' : '');
}
function onModalEffortSliderInput(v) {
    var idx = parseInt(v, 10);
    if (isNaN(idx) || idx < 0 || idx > 5) idx = _MODAL_EFFORT_DEFAULT_IDX;
    var hidden = document.getElementById('provider-effort');
    if (hidden) hidden.value = _MODAL_EFFORT_LEVELS[idx].v;
    var label = document.getElementById('modal-effort-label');
    if (label) label.innerHTML = _modalEffortLabelHtml(idx);
    var track = document.getElementById('modal-effort-track');
    if (track) track.style.setProperty('--pos', String(idx / 5));
    document.querySelectorAll('#modal-effort-track .effort-dot').forEach(function(d, i) {
        d.classList.toggle('active', i <= idx);
        d.classList.toggle('current', i === idx);
    });
    var disc = document.getElementById('modal-effort-disc');
    if (disc && disc._lastIdx !== idx) {
        disc._lastIdx = idx;
        disc.classList.remove('is-morph');
        void disc.offsetWidth; // reflow so the keyframe animation restarts
        disc.classList.add('is-morph');
    }
}

// Collapsed state of the Settings model-list sections — in-memory only
// (resets on reload; default expanded), keyed by section key.
var _modelSectionCollapsed = {};
function _modelSectionFor(provider) {
    if (provider.isChatGPTOAuth) return { key: 'chatgpt', label: 'ChatGPT Subscription', icon: UI_ICONS.brandOpenAI };
    if (provider.isClaudeOAuth) return { key: 'claude', label: 'Claude Subscription', icon: UI_ICONS.brandClaude };
    var ep = findEndpointForProvider(provider);
    if (ep) return { key: 'ep:' + ep.id, label: ep.name, icon: getEndpointIcon(ep.url) };
    var domain = getEndpointDomain(provider.endpoint) || 'Other';
    return { key: 'url:' + domain, label: domain, icon: getEndpointIcon(provider.endpoint || '') };
}
function toggleModelSection(key) {
    _modelSectionCollapsed[key] = !_modelSectionCollapsed[key];
    renderApiProvidersList();
}

// Shared section grouping for model lists — used by BOTH the Settings model
// list (renderApiProvidersList) and the header model-pill menu
// (toggleModelMenu, ui/160-notifications.js): subscriptions first, then one
// section per configured endpoint (llmEndpoints order), then inline-url
// fallback groups (models whose endpoint can't be resolved) last.
function groupProvidersIntoSections(providers) {
    var sections = [];
    var byKey = {};
    (providers || []).forEach(function(provider) {
        var meta = _modelSectionFor(provider);
        var sec = byKey[meta.key];
        if (!sec) { sec = { meta: meta, rows: [] }; byKey[meta.key] = sec; sections.push(sec); }
        sec.rows.push(provider);
    });
    var order = ['chatgpt', 'claude'].concat(llmEndpoints.map(function(ep) { return 'ep:' + ep.id; }));
    sections.forEach(function(sec, i) {
        var idx = order.indexOf(sec.meta.key);
        sec._rank = idx < 0 ? order.length + i : idx;
    });
    sections.sort(function(a, b) { return a._rank - b._rank; });
    return sections;
}

function renderApiProvidersList() {
    var container = document.getElementById('custom-api-providers-list');
    if (!container) return;
    
    if (apiProviders.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:var(--text-body);padding: var(--space-4) 0;">No providers configured.</div>';
        return;
    }
    
    // Foldable sections — shared grouping with the model-pill menu
    // (groupProvidersIntoSections above).
    var sections = groupProvidersIntoSections(apiProviders);

    var html = '';
    sections.forEach(function(sec) {
        var collapsed = !!_modelSectionCollapsed[sec.meta.key];
        var rowsHtml = '';
        sec.rows.forEach(function(provider) {
        var isCustomized = isProviderCustomized(provider);
        var isNew = !DEFAULT_API_PROVIDERS.find(function(d) { return d.name === provider.name; });
        var isActive = provider.name === currentProvider;
        var statusBadge = isNew ? '<span class="provider-badge new">custom</span>' : (isCustomized ? '<span class="provider-badge">modified</span>' : '');
        var activeTag = isActive ? '<span class="provider-tag active">Active</span>' : '';
        var endpointLabel = getEndpointDomain(provider.endpoint);
        var domainTag = endpointLabel ? '<span class="provider-tag">' + escapeHtml(endpointLabel) + '</span>' : '';
        var providerTag = provider.provider ? '<span class="provider-tag">' + escapeHtml(provider.provider) + '</span>' : '';
        
        rowsHtml += '<div class="api-provider-row' + (isActive ? ' active' : '') + '">' +
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
        html += '<div class="model-section' + (collapsed ? ' collapsed' : '') + '">' +
            '<div class="model-section-header" role="button" tabindex="0" aria-expanded="' + !collapsed + '"' +
                ' onclick="toggleModelSection(\'' + escapeJsString(sec.meta.key) + '\')"' +
                ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();toggleModelSection(\'' + escapeJsString(sec.meta.key) + '\');}">' +
                '<span class="model-section-chevron">' + UI_ICONS.chevronDown + '</span>' +
                '<span class="model-section-icon">' + sec.meta.icon + '</span>' +
                '<span class="model-section-title">' + escapeHtml(sec.meta.label) + '</span>' +
                '<span class="model-section-count">' + sec.rows.length + '</span>' +
            '</div>' +
            '<div class="model-section-body">' + rowsHtml + '</div>' +
        '</div>';
    });
    container.innerHTML = html;
}

function selectApiProvider(providerName) {
    changeProvider(providerName);
    renderApiProvidersList();
}

function showAddApiProviderModal(editingProvider) {
    // Remove any existing modal first
    var existingModal = document.getElementById('api-provider-modal');
    if (existingModal) existingModal.remove();
    
    var isEditing = !!editingProvider;
    var originalName = isEditing ? editingProvider.name : '';
    var provider = editingProvider || {
        name: '',
        model: '',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        provider: ''
    };
    // Which auth backs this model: 'chatgpt' / 'claude' subscription, or a
    // custom 'endpoint'. Editing preselects the saved kind; new models start
    // on the first radio (ChatGPT Subscription).
    
    var authKind = provider.isChatGPTOAuth ? 'chatgpt'
        : (provider.isClaudeOAuth ? 'claude'
        : (isEditing ? 'endpoint' : 'chatgpt'));

    // Endpoint picker: one radio per endpoint configured in Settings → LLM
    // Endpoints, each with its brand icon. A hidden input keeps the
    // 'provider-endpoint-select' contract with saveApiProviderFromModal.
    // Preselect the model's endpoint, else the seeded 'openrouter', else the
    // first configured endpoint.
    var _providerEp = findEndpointForProvider(provider);
    var selectedEndpointId = _providerEp ? _providerEp.id
        : (getLlmEndpointById('openrouter') ? 'openrouter' : (llmEndpoints.length > 0 ? llmEndpoints[0].id : ''));
    var endpointFieldInner = llmEndpoints.length > 0
        ? '<div class="radio-group radio-group-vertical" id="provider-endpoint-group" role="radiogroup" aria-label="Endpoint">' +
            llmEndpoints.map(function(ep) {
                var on = ep.id === selectedEndpointId;
                var epDomain = getEndpointDomain(ep.url);
                return '<div class="radio-option endpoint-radio' + (on ? ' selected' : '') + '" data-value="' + escapeHtml(ep.id) + '" role="radio" aria-checked="' + on + '" tabindex="0"' +
                    ' onclick="selectModelEndpoint(\'' + escapeJsString(ep.id) + '\')"' +
                    ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();selectModelEndpoint(\'' + escapeJsString(ep.id) + '\');}">' +
                    '<span class="radio-option-icon">' + getEndpointIcon(ep.url) + '</span>' +
                    '<span class="endpoint-radio-name">' + escapeHtml(ep.name) + '</span>' +
                    (epDomain ? '<span class="endpoint-radio-domain">' + escapeHtml(epDomain) + '</span>' : '') +
                '</div>';
            }).join('') +
          '</div>' +
          '<input type="hidden" id="provider-endpoint-select" value="' + escapeHtml(selectedEndpointId) + '">'
        : '<div class="settings-page-row-hint">No LLM endpoints configured — add one in the LLM Endpoints section of Settings first (subscription models don\'t need one).</div>';

    // Reasoning-effort slider (same control as the model pill menu, plus a
    // trailing 'Default' stop at the high end = the old select's empty option).
    var effortIdx = _MODAL_EFFORT_LEVELS.map(function(e) { return e.v; }).indexOf(provider.effort || '');
    if (effortIdx < 0) effortIdx = _MODAL_EFFORT_DEFAULT_IDX;
    var effortDots = '';
    for (var di = 0; di < 6; di++) {
        effortDots += '<span class="effort-dot' + (di <= effortIdx ? ' active' : '') + (di === effortIdx ? ' current' : '') + '" data-level="' + (di + 1) + '"></span>';
    }

    // Display-name autofill is armed only while the name matches what the
    // Model ID would generate (or is empty) — an existing custom name stays.
    _modelNameDirty = !!(provider.name && provider.name !== autoNameFromModelId(provider.model));

    var overlay = document.createElement('div');
    overlay.id = 'api-provider-modal';
    // .model-modal (09-settings.css) fixes the dialog to one LARGE constant
    // size — switching API-Access radios shows/hides fields, and the modal
    // must not resize with them. The body scrolls between the fixed
    // header/footer instead.
    overlay.className = 'modal-overlay show model-modal';
    // Dismiss only when the mouse press STARTED on the backdrop — selecting
    // text inside the dialog and releasing over the backdrop must NOT close
    // the modal. The Escape handler (core/120-init.js:267-271) replays a
    // SYNTHETIC {target: overlay} click object with no isTrusted flag and no
    // preceding mousedown, so it bypasses the press check and still closes.
    var backdropPressed = false;
    overlay.addEventListener('mousedown', function(e) { backdropPressed = (e.target === overlay); });
    overlay.onclick = function(e) {
        if (e.target !== overlay) return;
        if (e.isTrusted && !backdropPressed) return;
        closeApiProviderModal();
    };
    
    overlay.innerHTML = 
        '<div class="modal-dialog">' +
            '<div class="modal-header">' + (isEditing ? 'Edit' : 'Add') + ' Model</div>' +
            '<div class="modal-body" style="display:flex;flex-direction:column;gap:var(--space-8);">' +
                '<div class="form-field">' +
                    '<label class="form-label">API Access</label>' +
                    '<div class="radio-group" id="provider-auth-kind" role="radiogroup" aria-label="API access">' +
                        [['chatgpt', 'ChatGPT Subscription', UI_ICONS.brandOpenAI], ['claude', 'Claude Subscription', UI_ICONS.brandClaude], ['endpoint', 'Endpoint', UI_ICONS.brandEndpoint]].map(function(opt) {
                            var on = authKind === opt[0];
                            return '<div class="radio-option' + (on ? ' selected' : '') + '" data-value="' + opt[0] + '" role="radio" aria-checked="' + on + '" tabindex="0"' +
                                ' onclick="selectModelAuthKind(\'' + opt[0] + '\')"' +
                                ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();selectModelAuthKind(\'' + opt[0] + '\');}">' +
                                '<span class="radio-option-icon">' + opt[2] + '</span>' + opt[1] + '</div>';
                        }).join('') +
                    '</div>' +
                '</div>' +
                '<div class="form-field">' +
                    '<label class="form-label">Model ID <span class="required">*</span></label>' +
                    '<input type="text" id="provider-model" class="form-input" list="provider-model-datalist" value="' + escapeHtml(provider.model) + '" placeholder="e.g. anthropic/claude-sonnet-4" oninput="onModelIdInput(this.value)">' +
                    '<datalist id="provider-model-datalist"></datalist>' +
                    '<div class="settings-page-row-hint" id="provider-model-catalog-hint" style="display:none"></div>' +
                '</div>' +
                '<div class="form-field">' +
                    '<label class="form-label">Display Name <span class="required">*</span></label>' +
                    '<input type="text" id="provider-name" class="form-input" value="' + escapeHtml(provider.name) + '" placeholder="Auto-filled from Model ID" oninput="onModelNameInput(this.value)">' +
                '</div>' +
                '<div id="provider-custom-fields" style="' + (authKind === 'endpoint' ? 'display:flex;flex-direction:column;gap:var(--space-8)' : 'display:none') + '">' +
                    '<div class="form-field">' +
                        '<label class="form-label">Endpoint <span class="required">*</span></label>' +
                        endpointFieldInner +
                    '</div>' +
                    '<div class="form-field" id="provider-provider-field">' +
                        '<label class="form-label">Provider (Optional)</label>' +
                        '<input type="text" id="provider-provider" class="form-input" value="' + escapeHtml(provider.provider || '') + '" placeholder="e.g. anthropic or novita/bf16">' +
                    '</div>' +
                '</div>' +
                '<div class="form-field">' +
                    '<label class="form-label">Reasoning Effort</label>' +
                    '<div class="model-menu-effort modal-effort">' +
                        '<div class="model-menu-effort-track" id="modal-effort-track" style="--pos: ' + (effortIdx / 5) + '">' + effortDots +
                            '<span class="effort-track-fill"></span>' +
                            '<input type="range" class="model-menu-effort-slider" id="modal-effort-slider" min="0" max="5" step="1" value="' + effortIdx + '" aria-label="Reasoning effort" oninput="onModalEffortSliderInput(this.value)">' +
                            '<span class="effort-disc" id="modal-effort-disc"></span>' +
                        '</div>' +
                        '<div class="model-menu-effort-label" id="modal-effort-label">' + _modalEffortLabelHtml(effortIdx) + '</div>' +
                    '</div>' +
                    '<input type="hidden" id="provider-effort" value="' + escapeHtml(provider.effort || '') + '">' +
                '</div>' +
            '</div>' +
            '<div class="modal-actions">' +
                (isEditing ? '<button class="modal-btn danger" style="margin-right:auto" onclick="deleteApiProviderFromModal(\'' + escapeJsString(originalName) + '\')">Delete</button>' : '') +
                '<button class="modal-btn secondary" onclick="closeApiProviderModal()">Cancel</button>' +
                '<button class="modal-btn primary" onclick="saveApiProviderFromModal(\'' + escapeJsString(originalName) + '\')">' + (isEditing ? 'Save' : 'Add') + '</button>' +
            '</div>' +
        '</div>';
    
    document.body.appendChild(overlay);
    // Offer the live ChatGPT/Codex catalog when the ChatGPT Subscription radio
    // is preselected (async, race-guarded — see refreshCodexModelOptions).
    refreshCodexModelOptions();
}

// Live ChatGPT/Codex model catalog for the Add/Edit-Model modal. When the
// ChatGPT Subscription radio is selected, ask the SW for the live catalog
// ('openai-oauth-models' in background.js — fetchChatGPTModelCatalog, falling
// back to OPENAI_FALLBACK_MODELS with live:false when signed out or the fetch
// fails) and offer the slugs as datalist suggestions under the Model ID input.
// Best-effort and non-blocking: free-form typing always works. The generation
// token plus element/auth-kind re-checks in the callback guard the
// modal-closed and auth-kind-changed races.
var _codexCatalogGeneration = 0;
function refreshCodexModelOptions() {
    var generation = ++_codexCatalogGeneration;
    var dl = document.getElementById('provider-model-datalist');
    var hint = document.getElementById('provider-model-catalog-hint');
    if (!dl) return;
    if (_selectedModelAuthKind() !== 'chatgpt') {
        dl.innerHTML = '';
        if (hint) hint.style.display = 'none';
        return;
    }
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
        chrome.runtime.sendMessage({ type: 'openai-oauth-models' }, function(response) {
            if (chrome.runtime.lastError) return; // SW unreachable — keep free-form input
            if (generation !== _codexCatalogGeneration) return; // superseded by a newer refresh
            var dlNow = document.getElementById('provider-model-datalist');
            if (!dlNow) return; // modal closed while the fetch was in flight
            if (_selectedModelAuthKind() !== 'chatgpt') return; // auth kind changed mid-flight
            var models = (response && Array.isArray(response.models)) ? response.models : [];
            dlNow.innerHTML = models.map(function(slug) {
                return '<option value="' + escapeHtml(String(slug)) + '"></option>';
            }).join('');
            var hintNow = document.getElementById('provider-model-catalog-hint');
            if (!hintNow) return;
            if (!models.length) { hintNow.style.display = 'none'; return; }
            hintNow.textContent = (response.success && response.live)
                ? (models.length + ' model' + (models.length === 1 ? '' : 's') + ' available on your ChatGPT subscription')
                : 'Live catalog unavailable — showing known Codex models';
            hintNow.style.display = '';
        });
    } catch (e) { /* catalog is best-effort — never block the modal */ }
}

// Radio group in the add/edit-model modal: 'chatgpt' | 'claude' | 'endpoint'.
// Selecting 'endpoint' reveals the endpoint / API-key / provider fields.
function selectModelAuthKind(kind) {
    var group = document.getElementById('provider-auth-kind');
    if (group) {
        group.querySelectorAll('.radio-option').forEach(function(opt) {
            var on = opt.getAttribute('data-value') === kind;
            opt.classList.toggle('selected', on);
            opt.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }
    var custom = document.getElementById('provider-custom-fields');
    if (custom) custom.style.cssText = kind === 'endpoint' ? 'display:flex;flex-direction:column;gap:var(--space-8)' : 'display:none';
    // Populate (chatgpt) or clear (claude/endpoint) the Model ID suggestions.
    refreshCodexModelOptions();
}

function _selectedModelAuthKind() {
    var sel = document.querySelector('#provider-auth-kind .radio-option.selected');
    // Defensive fallback: 'endpoint' fails loudly (endpoint validation) rather
    // than silently minting a subscription provider.
    return sel ? sel.getAttribute('data-value') : 'endpoint';
}

function closeApiProviderModal() {
    var modal = document.getElementById('api-provider-modal');
    if (modal) modal.remove();
}

async function saveApiProviderFromModal(originalName) {
    var name = document.getElementById('provider-name').value.trim();
    var model = document.getElementById('provider-model').value.trim();
    var providerField = document.getElementById('provider-provider').value.trim();
    // The selected radio is the single source of truth for how this model
    // authenticates — for NEW and EDITED models alike. (PR #824 regression:
    // isOAuth was derived as `!existingProvider || …`, which forced every NEW
    // model onto the subscription path and ignored the typed endpoint.)
    var authKind = _selectedModelAuthKind();
    var isOAuth = authKind === 'chatgpt' || authKind === 'claude';
    var endpointSelect = document.getElementById('provider-endpoint-select');
    var selectedEp = !isOAuth ? getLlmEndpointById(endpointSelect ? endpointSelect.value : '') : null;
    var effortField = document.getElementById('provider-effort');
    var effort = effortField ? effortField.value : '';

    if (!name || !model) {
        showSnackbar('Please fill in all required fields (Name, Model ID)', 'error');
        return;
    }
    if (!isOAuth && !selectedEp) {
        showSnackbar('Please select an Endpoint — add one in Settings → LLM Endpoints first', 'error');
        return;
    }
    
    var renamingCurrent = !!(originalName && originalName !== name && currentProvider === originalName);
    
    // No maxTokens / thinkingBudget on the saved provider — token budgets
    // are GLOBAL settings (core/030-config.js), pure-global design.
    var provider = {
        name: name,
        model: model
    };
    if (isOAuth) {
        provider.apiKey = 'oauth';
        if (authKind === 'chatgpt') {
            provider.endpoint = 'https://chatgpt.com/backend-api/codex/responses';
            provider.isChatGPTOAuth = true;
        } else {
            provider.endpoint = 'https://api.anthropic.com/v1/messages';
            provider.isClaudeOAuth = true;
        }
    } else {
        // Reference the configured endpoint AND snapshot its url/key inline —
        // the request path (app/010-llm-streaming.js, background.js) reads
        // provider.endpoint / provider.apiKey directly.
        provider.endpointId = selectedEp.id;
        provider.endpoint = selectedEp.url;
        provider.apiKey = selectedEp.apiKey || '';
    }
    if (providerField && !isOAuth) provider.provider = providerField;
    if (effort) provider.effort = effort;

    try {
        await saveApiProvider(provider, originalName || null);
    } catch (e) {
        console.error('Failed to save API provider:', e);
        showSnackbar('Could not save provider: ' + (e && e.message), 'error');
        return; // keep modal open with the user's input intact
    }
    if (renamingCurrent) {
        currentProvider = name;
        saveProviderToStorage();
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

// Delete button in the EDIT-model modal footer. Same confirm + delete flow as
// the settings list's trash button; the modal only closes once the user
// confirms (cancelling the confirm keeps the edit modal open, untouched).
async function deleteApiProviderFromModal(providerName) {
    var provider = apiProviders.find(function(p) { return p.name === providerName; });
    if (!provider) return;
    if (await showConfirmModal('Delete Model', 'Delete model "' + provider.name + '"? This cannot be undone.', 'danger')) {
        closeApiProviderModal();
        await deleteApiProviderAndRefresh(providerName);
    }
}

async function confirmDeleteApiProvider(providerName) {
    var provider = apiProviders.find(function(p) { return p.name === providerName; });
    if (!provider) return;
    
    if (await showConfirmModal('Delete Provider', 'Delete provider "' + provider.name + '"? This cannot be undone.', 'danger')) {
        await deleteApiProviderAndRefresh(providerName);
    }
}

async function deleteApiProviderAndRefresh(providerName) {
    var wasCurrent = currentProvider === providerName;
    var replacement = wasCurrent
        ? (apiProviders.length > 1 ? apiProviders.find(function(p) { return p.name !== providerName; }).name : 'Opus 5')
        : currentProvider;
    try {
        await deleteApiProvider(providerName);
    } catch (e) {
        console.error('Failed to delete API provider:', e);
        showSnackbar('Could not delete provider: ' + ((e && e.message) || 'storage transaction failed'), 'error');
        return;
    }
    // Only publish selection/UI changes after deleteApiProvider confirms commit.
    if (wasCurrent) {
        currentProvider = replacement;
        saveProviderToStorage();
    }
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
            '<code>{{CURRENT_DATE}}</code> - Today\'s date, ' +
            '<code>{{ORCHESTRATOR_POLICY}}</code> - Delegation policy (main chats only; empty for sub-agents), ' +
            '<code>{{DISABLED_TOOLS}}</code> - List of disabled tools, ' +
            '<code>{{SKILLS_SUMMARY}}</code> - Available skills list, ' +
            '<code>{{TOOL_CATALOG}}</code> - Deferred-tool catalog (empty when deferred tool loading is off)' +
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

// Settings toggle for deferred tool loading (core/030-config.js). Persists
// the flag and mirrors it into a live SW so background runs pick it up
// immediately (same pattern as toggleHook → pushHooksSettingsToOffscreen).
async function toggleDeferredTools(enabled) {
    await saveDeferredToolsEnabled(!!enabled);
    if (typeof pushDeferredToolsSettingToOffscreen === 'function') {
        pushDeferredToolsSettingToOffscreen(!!enabled);
    }
    if (typeof showSnackbar === 'function') {
        showSnackbar('Deferred tool loading ' + (enabled ? 'enabled' : 'disabled'), 'success');
    }
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

// Canonical ServiceNow permission keys for the "ServiceNow API" group,
// derived from INSTANCE_PERMISSION_KEYS (core/070-permissions.js =
// INSTANCE_READ_KEYS.concat(INSTANCE_WRITE_KEYS)) so a key added there --
// e.g. 'sn:run_script', server-side script execution -- automatically gets a
// row in the UI. Both permission renderers (renderSettingsToolPermissions
// here and renderToolPermissions in ui/140-dropdowns.js) used to hardcode a
// 4-key list, which is exactly how sn:run_script ended up with a radio group
// that had no container to render into. Read keys come first, matching the
// canonical list order.
function _snPermissionKeys() {
    return INSTANCE_PERMISSION_KEYS.filter(function(k) { return k.indexOf('sn:') === 0; });
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
        html += '<div class="tool-permission-group-title">ServiceNow API ' + _toolSourceBtn('servicenow_api') + ' ' + _toolSourceBtn('servicenow_diff_edit') + ' ' + _toolSourceBtn('servicenow_run_script') + '</div>';
        _snPermissionKeys().forEach(function(key) {
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
        var perm = toolPermissions[key] || (isReadPermissionKey(key) || key === 'workspace:push' ? 'allow' : 'auto');
        _renderPermRadio(containerId, perm, key, false, false);
    });
}

// NAV-SYNC: one async remote workspace sync per page navigation (fire-and-
// forget). Guarded so at most ONE sync is in flight at a time — navigating
// rapidly while a sync is still running does NOT stack additional syncs;
// the next navigation after it settles triggers a fresh one.
var _navWsSyncInFlight = false;
function triggerNavWorkspaceSync() {
    if (_navWsSyncInFlight) return;
    if (typeof syncAndUpdateWorkspaceHeader !== 'function') return;
    _navWsSyncInFlight = true;
    Promise.resolve()
        .then(function() { return syncAndUpdateWorkspaceHeader(); })
        .catch(function() {})
        .then(function() { _navWsSyncInFlight = false; });
}

// NAV-SYNC: also sync when the user comes back to the extension tab/window
// (tab switch, window focus, side-panel re-open). Same guard — at most one
// sync in flight; returning while one runs is a no-op.
// Credits are fetched once at init and otherwise never refreshed — piggyback
// a throttled refresh here too (60s min interval so window-focus churn
// doesn't hammer the credits endpoint; the OAuth path is header-cache only).
var _creditsFocusLastFetch = 0;
function _onExtensionTabReturn() {
    try { triggerNavWorkspaceSync(); } catch (e) {}
    var now = Date.now();
    if (now - _creditsFocusLastFetch > 60000 && typeof fetchCredits === 'function') {
        _creditsFocusLastFetch = now;
        try { fetchCredits(); } catch (e) {}
    }
}
document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') _onExtensionTabReturn();
});
window.addEventListener('focus', _onExtensionTabReturn);

// Helper to hide all panels
function hideAllPanels() {
    var panels = ['main-area', 'skills-panel', 'dashboard-panel', 'home-panel', 'settings-page-panel', 'docs-panel', 'history-panel', 'documents-panel'];
    panels.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    // Most home exits funnel through here (selectChat, popstate, the view
    // toggles) WITHOUT calling closeHomeView(), which used to leave the home
    // trail-animation rAF loop + its window resize/mouse listeners running
    // against the hidden canvas. Stop it whenever home is hidden; re-entering
    // home restarts it via renderHome()'s deferred init. typeof-guarded for
    // bundles/load paths where ui/030-home-view.js isn't present.
    if (typeof stopHomeTrailAnimation === 'function') {
        try { stopHomeTrailAnimation(); } catch (e) {}
    }
    // Hide browser controls (URL input) when leaving views
    var browserControls = document.getElementById('browser-controls');
    if (browserControls) browserControls.style.display = 'none';
    var homeBrowserControls = document.getElementById('home-browser-controls');
    if (homeBrowserControls) homeBrowserControls.style.display = 'none';
    // Auto-close sidebar overlay on mobile / side panel mode
    if (!sidebarCollapsed && (document.body.classList.contains('sidepanel-mode') || window.innerWidth <= 480)) {
        toggleSidebar();
    }
    // NAV-SYNC: every page/view transition funnels through hideAllPanels —
    // kick exactly one async GitHub workspace sync (no-op if one is running).
    try { triggerNavWorkspaceSync(); } catch (e) {}
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
    // ...and stamp lastViewedAt for the same reason: the jobs rows/cards bell +
    // unread-bold predicates compare lastResponseAt/lastActivityAt against
    // lastViewedAt, and activity that landed while the user was on the home/
    // history view (where the focused chat does NOT count as viewed — see
    // _isChatViewFocused in tools/120-actions.js) must be consumed when the
    // user returns to the chat view and can actually see the messages.
    if (currentView === 'chat' && typeof currentChatId !== 'undefined' && currentChatId &&
        typeof chats !== 'undefined' && chats[currentChatId]) {
        if (typeof dispatchChatMeta === 'function') dispatchChatMeta(currentChatId, { lastViewedAt: Date.now() }); // FLUX-4C lane
        if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
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
