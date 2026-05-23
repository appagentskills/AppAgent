// IndexedDB for all app data (much larger capacity than localStorage)
// Use prefix for iframe isolation (separate database for iframe vs standalone)
var dbName = STORAGE_PREFIX + 'AppAgentDB';
var dbVersion = 10;
var workspaceMetaStoreName = 'workspace_meta';
var workspaceFilesStoreName = 'workspace_files';
var chatStoreName = 'chats';
var settingsStoreName = 'settings';
var skillsStoreName = 'skills';
var dashboardWidgetsStoreName = 'dashboardWidgets';
var apiProvidersStoreName = 'apiProviders';
var documentsStoreName = 'documents';
var actionStateStoreName = 'action_state';
var db = null;
var skills = {};
var EMBEDDED_SKILLS = /*EMBEDDED_SKILLS_START*/[]/*EMBEDDED_SKILLS_END*/;
var currentView = 'chat';
var currentEditingSkill = null;

// Dashboard state
var dashboardWidgets = {}; // { widgetId: { id, title, prompt, html, conversation, width, height, order, createdAt, updatedAt, error, isLoading, isStreaming } }
var currentEditingWidget = null;
var dashboardRefreshing = false;
var activeWidgetStreamingId = null; // Track which widget has active streaming
var showDashboardHeaders = false; // Toggle for showing widget headers
var pendingWidgetRegeneration = null; // LEGACY single-slot — kept for any external readers; do NOT use in new code.
// B-B2: per-chat map of regeneration intents. Key is the chatId the regen agent
// loop is running in; value is the dashboard widget id whose HTML should be
// replaced when that loop calls html_widget. Two parallel regenerations no
// longer stomp on each other because they live in different chats.
var pendingWidgetRegenerationByChatId = {};
function setPendingWidgetRegeneration(chatId, widgetId) {
    if (!chatId || !widgetId) return;
    pendingWidgetRegenerationByChatId[chatId] = widgetId;
    pendingWidgetRegeneration = widgetId; // mirror legacy global for any external readers
}
function consumePendingWidgetRegeneration(chatId) {
    if (!chatId) return null;
    var widgetId = pendingWidgetRegenerationByChatId[chatId] || null;
    if (widgetId) {
        delete pendingWidgetRegenerationByChatId[chatId];
        // Only clear the legacy global if it still points at the entry we consumed,
        // otherwise we'd clobber a different concurrent regen's mirror.
        if (pendingWidgetRegeneration === widgetId) pendingWidgetRegeneration = null;
    }
    return widgetId;
}
function clearPendingWidgetRegeneration(chatId) {
    if (!chatId) return;
    delete pendingWidgetRegenerationByChatId[chatId];
}
var widgetDragState = null; // { widgetId, startX, startY, dragType: 'move'|'resize', startWidth, startHeight }
var expandedWidgetId = null; // Track expanded widget

// Grid-based positioning state
var gridState = {
    columns: 12,
    rowHeight: 50,
    gap: 16,
    occupancy: {},           // Sparse grid: "row,col" -> widgetId (for new widget placement)
    draggedWidgetId: null,
    dragOffset: null,        // { x, y } offset within widget where drag started
    maxZIndex: 1             // Track highest z-index for bringing widgets to front
};

function openDatabase() {
    return new Promise(function(resolve, reject) {
        if (db) { resolve(db); return; }
        var request = indexedDB.open(dbName, dbVersion);
        request.onerror = function() { reject(request.error); };
        request.onsuccess = function() { db = request.result; resolve(db); };
        request.onupgradeneeded = function(e) {
            var database = e.target.result;
            if (!database.objectStoreNames.contains(chatStoreName)) {
                database.createObjectStore(chatStoreName, { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains(settingsStoreName)) {
                database.createObjectStore(settingsStoreName, { keyPath: 'key' });
            }
            if (!database.objectStoreNames.contains(skillsStoreName)) {
                database.createObjectStore(skillsStoreName, { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains(skillAssetsStoreName)) {
                database.createObjectStore(skillAssetsStoreName, { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains(dashboardWidgetsStoreName)) {
                database.createObjectStore(dashboardWidgetsStoreName, { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains(apiProvidersStoreName)) {
                database.createObjectStore(apiProvidersStoreName, { keyPath: 'name' });
            }
            if (!database.objectStoreNames.contains(workspaceMetaStoreName)) {
                database.createObjectStore(workspaceMetaStoreName, { keyPath: 'repo' });
            }
            if (!database.objectStoreNames.contains(workspaceFilesStoreName)) {
                var wsStore = database.createObjectStore(workspaceFilesStoreName, { keyPath: 'id' });
                wsStore.createIndex('repo', 'repo', { unique: false });
                wsStore.createIndex('repo_path', ['repo', 'path'], { unique: true });
            }
            if (!database.objectStoreNames.contains(documentsStoreName)) {
                database.createObjectStore(documentsStoreName, { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains(actionStateStoreName)) {
                database.createObjectStore(actionStateStoreName, { keyPath: 'actionId' });
            }
        };
    });
}

// Generic settings get/set for IndexedDB
async function getSetting(key, defaultValue) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([settingsStoreName], 'readonly');
        var store = transaction.objectStore(settingsStoreName);
        var request = store.get(key);
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                resolve(request.result ? request.result.value : defaultValue);
            };
            request.onerror = function() { resolve(defaultValue); };
        });
    } catch (e) {
        return defaultValue;
    }
}

async function setSetting(key, value) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([settingsStoreName], 'readwrite');
        var store = transaction.objectStore(settingsStoreName);
        store.put({ key: key, value: value });
    } catch (e) {
        console.error('Failed to save setting:', key, e);
    }
}

// Helper function to get provider by name
function getProviderByName(providerName) {
    return apiProviders.find(function(p) { return p.name === providerName; }) || null;
}

// Alias for backward compatibility
var getProviderById = getProviderByName;

// Get all providers
function getAllProviders() {
    return apiProviders;
}

// API Providers Management
async function loadApiProviders() {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([apiProvidersStoreName], 'readonly');
        var store = transaction.objectStore(apiProvidersStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var loaded = request.result || [];
                if (loaded.length === 0) {
                    // First load - initialize with defaults
                    apiProviders = DEFAULT_API_PROVIDERS.slice();
                    // Save defaults to IndexedDB
                    saveAllApiProviders();
                } else {
                    apiProviders = loaded;
                    // Merge any new default providers not yet in IndexedDB
                    var added = false;
                    DEFAULT_API_PROVIDERS.forEach(function(def) {
                        var exists = apiProviders.some(function(p) { return p.name === def.name; });
                        if (!exists) {
                            apiProviders.push(Object.assign({}, def));
                            added = true;
                        }
                    });
                    if (added) saveAllApiProviders();
                    // Migrate: switch OAuth providers from thinkingBudget to effort
                    var migrated = false;
                    apiProviders.forEach(function(p) {
                        if (p.isClaudeOAuth && p.thinkingBudget && !p.effort) {
                            p.effort = 'high';
                            delete p.thinkingBudget;
                            migrated = true;
                        }
                    });
                    if (migrated) saveAllApiProviders();
                }
                resolve();
            };
            request.onerror = function() {
                console.error('Failed to load API providers:', request.error);
                apiProviders = DEFAULT_API_PROVIDERS.slice();
                resolve();
            };
        });
    } catch (e) {
        console.error('IndexedDB error loading API providers:', e);
        apiProviders = DEFAULT_API_PROVIDERS.slice();
        return Promise.resolve();
    }
}

async function saveAllApiProviders() {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([apiProvidersStoreName], 'readwrite');
        var store = transaction.objectStore(apiProvidersStoreName);
        // Clear and re-add all
        store.clear();
        apiProviders.forEach(function(p) { store.put(p); });
    } catch (e) {
        console.error('Failed to save all API providers:', e);
    }
}

async function saveApiProvider(provider) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([apiProvidersStoreName], 'readwrite');
        var store = transaction.objectStore(apiProvidersStoreName);
        store.put(provider);
        // Update in-memory array
        var existingIndex = apiProviders.findIndex(function(p) { return p.name === provider.name; });
        if (existingIndex >= 0) {
            apiProviders[existingIndex] = provider;
        } else {
            apiProviders.push(provider);
        }
    } catch (e) {
        console.error('Failed to save API provider:', e);
    }
}

async function deleteApiProvider(providerName) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([apiProvidersStoreName], 'readwrite');
        var store = transaction.objectStore(apiProvidersStoreName);
        store.delete(providerName);
        // Remove from in-memory array
        apiProviders = apiProviders.filter(function(p) { return p.name !== providerName; });
    } catch (e) {
        console.error('Failed to delete API provider:', e);
    }
}

function generateSkillId(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'skill_' + Date.now();
}

async function loadSkillsFromStorage() {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([skillsStoreName], 'readonly');
        var store = transaction.objectStore(skillsStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var results = request.result || [];
                skills = {};
                results.forEach(function(skill) {
                    skills[skill.id] = skill;
                });
                resolve();
            };
            request.onerror = function() {
                console.error('Failed to load skills:', request.error);
                resolve();
            };
        });
    } catch (e) {
        console.error('IndexedDB error loading skills:', e);
        return Promise.resolve();
    }
}

async function importEmbeddedSkills() {
    if (!EMBEDDED_SKILLS || !EMBEDDED_SKILLS.length) return;
    try {
        var needsSaveActive = false;
        for (var i = 0; i < EMBEDDED_SKILLS.length; i++) {
            var embedded = EMBEDDED_SKILLS[i];
            var existing = skills[embedded.id];

            // If user has modified this skill, don't overwrite — their version takes precedence
            if (existing && existing.userModified) continue;

            var hashMatch = existing && existing.embeddedHash === embedded.hash;

            // Content unchanged — just ensure it's active
            if (hashMatch) {
                if (!activeSkills[embedded.id]) {
                    activeSkills[embedded.id] = { xmlBackups: {}, activatedAt: Date.now() };
                    needsSaveActive = true;
                    await loadSkillTools(embedded.id);
                }
                // Backfill: users who installed via an older build that dropped
                // actions entirely have stored actions=[]. Even though the hash
                // matches, refresh from the embedded frontmatter so their
                // action buttons appear after upgrade. Only backfills when the
                // stored list is empty AND the embedded build provides actions —
                // we don't want to clobber legitimately-empty user edits.
                if (existing && (!Array.isArray(existing.actions) || existing.actions.length === 0) && embedded.frontmatter && !existing.userModified) {
                    try {
                        var fmDecodedBackfill = atob(embedded.frontmatter);
                        var parsedBackfill = _parseFrontmatter(fmDecodedBackfill);
                        var backfilled = (parsedBackfill.actions || []).map(sanitizeAction).filter(function(a){ return a; });
                        if (backfilled.length) {
                            existing.actions = backfilled;
                            existing.updatedAt = Date.now();
                            await saveSkill(existing);
                        }
                    } catch (e) { /* non-fatal */ }
                }
                continue;
            }

            // New or updated content — save/update skill
            if (existing) await deleteSkillAssets(embedded.id);
            var decodedBody = atob(embedded.body);
            // Parse actions from the raw frontmatter if provided by the build
            var embeddedActions = [];
            if (embedded.frontmatter) {
                try {
                    var fmDecoded = atob(embedded.frontmatter);
                    var parsed = _parseFrontmatter(fmDecoded);
                    embeddedActions = (parsed.actions || []).map(sanitizeAction).filter(function(a){ return a; });
                } catch (e) { /* non-fatal */ }
            } else if (Array.isArray(embedded.actions)) {
                embeddedActions = embedded.actions.map(sanitizeAction).filter(function(a){ return a; });
            }
            await saveSkill({
                id: embedded.id,
                name: embedded.name,
                description: embedded.description,
                body: decodedBody,
                actions: embeddedActions,
                embeddedHash: embedded.hash,
                createdAt: existing ? existing.createdAt : Date.now(),
                updatedAt: Date.now()
            });
            var assets = embedded.assets || [];
            for (var j = 0; j < assets.length; j++) {
                await saveSkillAsset(embedded.id, assets[j].filename, assets[j].type, atob(assets[j].content));
            }
            // Activate if not already active
            if (!activeSkills[embedded.id]) {
                activeSkills[embedded.id] = { xmlBackups: {}, activatedAt: Date.now() };
                needsSaveActive = true;
            }
            await loadSkillTools(embedded.id);
        }
        if (needsSaveActive) await saveActiveSkills();
    } catch (e) {
        console.error('Failed to import embedded skills:', e);
    }
}

async function saveSkill(skill) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([skillsStoreName], 'readwrite');
        var store = transaction.objectStore(skillsStoreName);
        store.put(skill);
        skills[skill.id] = skill;
    } catch (e) {
        console.error('Failed to save skill:', e);
    }
}

async function deleteSkill(skillId) {
    try {
        // Deactivate first to revert XML files
        if (activeSkills[skillId]) {
            await deactivateSkill(skillId);
        }
        // Delete all assets for this skill
        await deleteSkillAssets(skillId);
        // Delete skill from IndexedDB
        var database = await openDatabase();
        var transaction = database.transaction([skillsStoreName], 'readwrite');
        var store = transaction.objectStore(skillsStoreName);
        store.delete(skillId);
        delete skills[skillId];
    } catch (e) {
        console.error('Failed to delete skill:', e);
    }
}

// =============================================
// Workspace IndexedDB helpers
// =============================================

// Workspace key: "owner/repo::branch" — each branch is a separate workspace
function wsKey(repo, branch) {
    return repo + '::' + branch;
}

function parseWsKey(key) {
    var parts = key.split('::');
    return { repo: parts[0], branch: parts[1] || 'main' };
}

// Resolve workspace key from optional workspace param.
// If workspace provided, validates it exists. If not, falls back to single workspace or errors on ambiguity.
// Returns string key on success, or { error: "..." } if not found.
async function resolveWorkspace(workspace) {
    if (workspace) {
        var meta = await getWorkspaceMeta(workspace);
        if (meta) return workspace;
        return { error: 'Workspace "' + workspace + '" not found. Use workspace clone first.' };
    }

    // No workspace param — check if there's exactly one workspace
    try {
        var all = await getAllWorkspaceMetas();
        if (all.length === 0) return { error: 'No workspaces cloned. Use workspace clone first.' };
        if (all.length === 1) return all[0].repo;
        var keys = all.map(function(m) { return m.repo; });
        return { error: 'Multiple workspaces cloned: ' + keys.join(', ') + '. Specify which workspace to use.' };
    } catch (e) {
        return { error: 'Failed to resolve workspace: ' + e.message };
    }
}

// Clean up old-format workspace entries (no :: in key) — stale from pre-refactor code
async function cleanupStaleWorkspaces() {
    try {
        var all = await getAllWorkspaceMetas();
        for (var i = 0; i < all.length; i++) {
            var m = all[i];
            if (m.repo && m.repo.indexOf('::') === -1) {
                console.log('Cleaning up old-format workspace:', m.repo);
                await deleteWorkspaceFiles(m.repo);
                await deleteWorkspaceMeta(m.repo);

            }
        }
    } catch (e) {}
}

// Get all workspace metas
async function getAllWorkspaceMetas() {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceMetaStoreName], 'readonly');
        var store = tx.objectStore(workspaceMetaStoreName);
        var request = store.getAll();
        return new Promise(function(r) { request.onsuccess = function() { r(request.result || []); }; request.onerror = function() { r([]); }; });
    } catch (e) { return []; }
}

// GitHub API call helper — routes through background.js
function githubApi(method, path, body) {
    return new Promise(function(resolve) {
        var msg = { type: 'github-api', method: method, path: path };
        if (body) { msg.body = body; msg.contentType = 'application/json'; }
        chrome.runtime.sendMessage(msg, function(response) {
            if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message }); return; }
            resolve(response || { error: 'No response' });
        });
    });
}

async function getWorkspaceMeta(repo) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceMetaStoreName], 'readonly');
        var store = tx.objectStore(workspaceMetaStoreName);
        var request = store.get(repo);
        return new Promise(function(resolve) {
            request.onsuccess = function() { resolve(request.result || null); };
            request.onerror = function() { resolve(null); };
        });
    } catch (e) { return null; }
}

async function setWorkspaceMeta(meta) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceMetaStoreName], 'readwrite');
        tx.objectStore(workspaceMetaStoreName).put(meta);
    } catch (e) { console.error('Failed to save workspace meta:', e); }
}

async function getWorkspaceFile(repo, path) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceFilesStoreName], 'readonly');
        var store = tx.objectStore(workspaceFilesStoreName);
        var index = store.index('repo_path');
        var request = index.get([repo, path]);
        return new Promise(function(resolve) {
            request.onsuccess = function() { resolve(request.result || null); };
            request.onerror = function() { resolve(null); };
        });
    } catch (e) { return null; }
}

async function setWorkspaceFile(file) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceFilesStoreName], 'readwrite');
        tx.objectStore(workspaceFilesStoreName).put(file);
        await new Promise(function(resolve, reject) {
            tx.oncomplete = resolve;
            tx.onerror = function() { reject(tx.error); };
        });
    } catch (e) { console.error('Failed to save workspace file:', e); }
}

async function getAllWorkspaceFiles(repo) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceFilesStoreName], 'readonly');
        var store = tx.objectStore(workspaceFilesStoreName);
        var index = store.index('repo');
        var request = index.getAll(repo);
        return new Promise(function(resolve) {
            request.onsuccess = function() { resolve(request.result || []); };
            request.onerror = function() { resolve([]); };
        });
    } catch (e) { return []; }
}

// Returns every workspace file across all clones. Used by clone for blob dedup.
async function getAllWorkspaceFilesAllRepos() {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceFilesStoreName], 'readonly');
        var store = tx.objectStore(workspaceFilesStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() { resolve(request.result || []); };
            request.onerror = function() { resolve([]); };
        });
    } catch (e) { return []; }
}

async function deleteWorkspaceFiles(repo) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceFilesStoreName], 'readwrite');
        var store = tx.objectStore(workspaceFilesStoreName);
        var index = store.index('repo');
        var request = index.getAllKeys(repo);
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var keys = request.result || [];
                keys.forEach(function(k) { store.delete(k); });
                resolve(keys.length);
            };
            request.onerror = function() { resolve(0); };
        });
    } catch (e) { return 0; }
}

async function deleteWorkspaceMeta(repo) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceMetaStoreName], 'readwrite');
        tx.objectStore(workspaceMetaStoreName).delete(repo);
    } catch (e) {}
}

// GitHub settings helpers
var _githubUser = null; // cached { login, avatar_url, name }

async function loadGitHubSettings() {
    var data = await new Promise(function(r) { chrome.storage.local.get(['githubToken', 'githubInstanceUrl', 'githubUser'], r); });
    _githubUser = data.githubUser || null;
    return { token: data.githubToken || '', instanceUrl: data.githubInstanceUrl || 'https://github.com', user: _githubUser };
}

async function saveGitHubSettings(token, instanceUrl, user) {
    _githubUser = user;
    await new Promise(function(r) { chrome.storage.local.set({ githubToken: token, githubInstanceUrl: instanceUrl, githubUser: user }, r); });
}

async function clearGitHubSettings() {
    _githubUser = null;
    await new Promise(function(r) { chrome.storage.local.remove(['githubToken', 'githubInstanceUrl', 'githubUser'], r); });
}

function validateGitHubToken(token, instanceUrl) {
    return new Promise(function(resolve) {
        chrome.runtime.sendMessage({ type: 'github-validate-token', token: token, instanceUrl: instanceUrl }, function(response) {
            if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
            resolve(response || { ok: false, error: 'No response' });
        });
    });
}

// Deploy directory handle (File System Access API, extension only)
var _deployDirHandle = null;

async function getDeployDirHandle() {
    if (_deployDirHandle) return _deployDirHandle;
    try {
        var database = await openDatabase();
        var tx = database.transaction([settingsStoreName], 'readonly');
        var store = tx.objectStore(settingsStoreName);
        var request = store.get('deployDirHandle');
        var result = await new Promise(function(r) { request.onsuccess = function() { r(request.result); }; request.onerror = function() { r(null); }; });
        if (result && result.value) {
            var perm = await result.value.requestPermission({ mode: 'readwrite' });
            if (perm === 'granted') { _deployDirHandle = result.value; return _deployDirHandle; }
        }
    } catch (e) {}
    return null;
}

async function setDeployDirHandle(handle) {
    _deployDirHandle = handle;
    await setSetting('deployDirHandle', handle);
}

async function pickDeployDir() {
    try {
        var handle = await window.showDirectoryPicker({ id: 'appagent-deploy-dir', mode: 'readwrite' });
        await setDeployDirHandle(handle);
        return handle;
    } catch (e) { return null; }
}
