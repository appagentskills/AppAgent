// IndexedDB for all app data (much larger capacity than localStorage)
// Use prefix for iframe isolation (separate database for iframe vs standalone)
var dbName = STORAGE_PREFIX + 'AppAgentDB';
// Bumped to 13 for the content-addressed `workspace_blobs` store: file
// content is stored ONCE per git SHA and workspace_files rows become
// lightweight refs (path, sha, flags) + dirty overlay content only.
// v13 also runs an eager row migration inside the versionchange
// transaction (see onupgradeneeded).
// Bumped to 14 for the `llmEndpoints` store: named endpoint objects
// { id, name, url, apiKey } that providers reference by endpointId.
var dbVersion = 14;
var workspaceMetaStoreName = 'workspace_meta';
var workspaceFilesStoreName = 'workspace_files';
// Content-addressed blob store: { sha, content }. Shared across all
// workspaces — git blobs are immutable, same sha == same bytes.
var workspaceBlobsStoreName = 'workspace_blobs';
var chatStoreName = 'chats';
var settingsStoreName = 'settings';
var skillsStoreName = 'skills';
var dashboardWidgetsStoreName = 'dashboardWidgets';
var apiProvidersStoreName = 'apiProviders';
var llmEndpointsStoreName = 'llmEndpoints';
var documentsStoreName = 'documents';
var actionStateStoreName = 'action_state';
// agent_runs: per-chat run state for the offscreen runtime. Written
// at every tool boundary by 110-agent-checkpoint.js so a crashed/idle
// offscreen doc can resume by re-entering the loop from the latest
// checkpoint. Key is chatId.
// Schema: { chatId, turn, callNumber, messagesSnapshot, aggregateMetrics,
//           lastEventAt, status: 'running'|'parked'|'finished'|'errored',
//           parkedToolCalls: [{toolCallId, name, input, parkedAt}, ...] }
var agentRunsStoreName = 'agent_runs';
// sub_agents: persistent per-sub-agent runtime state. Keyed by agent_id.
// Survives page/SW reload so the worker pool can resume orphaned subs and
// `agent_status` can report on every spawned sub. Schema:
//   { agent_id, chat_id, parent_chat_id, parent_agent_id?, name,
//     state: 'running'|'sleeping'|'stopped'|'errored',
//     spawn_args, spawn_handle_id, tool_roster,
//     created_at, last_activity_at, tool_calls_used,
//     last_report?, inbox: [...], pending_handles: [...],
//     auto_report, max_tool_calls, summary_cap_bytes }
var subAgentsStoreName = 'sub_agents';
var db = null;
// Dedupe concurrent openDatabase() calls: all callers racing while no live
// connection is cached share ONE in-flight open request. Cleared on failure
// (error / blocked timeout) so a later call can retry, and on success (the
// cached `db` takes over as the fast path).
var _dbOpenPromise = null;
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

// Liveness probe for a cached connection. Chrome can force-close an IDB
// connection at any time (long sessions, IDB backend crash/restart) and the
// dead handle then throws InvalidStateError on EVERY transaction() forever.
// A no-op readonly transaction detects this synchronously; an unused
// transaction just auto-commits empty, so the probe is cheap.
function _isDbConnectionAlive(database) {
    try {
        database.transaction([settingsStoreName], 'readonly');
        return true;
    } catch (e) {
        return false;
    }
}

function openDatabase() {
    // Fast path: cached connection — but verify it's still alive so every
    // `await openDatabase()` call site (~60 across the bundles, in three
    // realms: panel page, service worker, offscreen doc) gets a usable
    // handle without needing individual connection-loss retry logic. This
    // is the shared transaction-creation choke point.
    if (db) {
        if (_isDbConnectionAlive(db)) return Promise.resolve(db);
        try { db.close(); } catch (e) {}
        db = null;
    }
    if (_dbOpenPromise) return _dbOpenPromise;
    // Identity guard: capture the promise created for THIS open attempt so a
    // late-settling old request (e.g. after the onblocked timeout rejected and
    // a retry created a NEW _dbOpenPromise) can't clobber the newer in-flight
    // dedupe promise or cache a stale connection over a live one.
    var myOpenPromise = new Promise(function(resolve, reject) {
        var request = indexedDB.open(dbName, dbVersion);
        var settled = false;
        var blockedTimer = null;
        function settle(fn, arg) {
            if (settled) return;
            settled = true;
            if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
            fn(arg);
        }
        request.onerror = function() {
            if (_dbOpenPromise === myOpenPromise) _dbOpenPromise = null; // let a later call retry
            settle(reject, request.error);
        };
        // Another connection (old realm/tab) still holds an older version and
        // hasn't closed. Without this handler the open request stays pending
        // FOREVER and wedges init (core/120-init.js awaits the first load).
        // Warn, give the other side 10s to comply (our own onversionchange
        // handler below closes promptly), then reject so callers fail visibly
        // instead of hanging. If the open later succeeds anyway, onsuccess
        // still caches the connection for the next caller.
        request.onblocked = function() {
            console.warn('[indexeddb] open of ' + dbName + ' is blocked by another connection holding an older version — waiting up to 10s');
            if (blockedTimer) return;
            blockedTimer = setTimeout(function() {
                if (_dbOpenPromise === myOpenPromise) _dbOpenPromise = null; // let a later call retry
                settle(reject, new Error('IndexedDB open blocked by another connection that did not close. Close other extension views or restart Chrome.'));
            }, 10000);
        };
        request.onsuccess = function() {
            var result = request.result;
            // Stale attempt: a newer open superseded us (our blocked-timeout
            // rejection already cleared _dbOpenPromise and a retry replaced
            // it) AND a different live connection is already cached. Close
            // our connection instead of caching over the live one.
            if (_dbOpenPromise !== myOpenPromise && db && db !== result) {
                try { result.close(); } catch (e) {}
                settle(resolve, result);
                return;
            }
            // Lifecycle: the browser force-closed this connection (storage
            // pressure, IDB backend crash). Drop the cache so the NEXT
            // openDatabase() reopens instead of handing out a dead handle
            // (which would throw InvalidStateError in this realm forever,
            // until a full Chrome restart).
            result.onclose = function() {
                console.warn('[indexeddb] connection to ' + dbName + ' was closed by the browser — will reopen on next access');
                if (db === result) db = null;
            };
            // Lifecycle: another realm is opening with a NEWER version and
            // needs us to close. Comply immediately (so its open is not
            // blocked) and drop the cache so we reopen at the new version.
            result.onversionchange = function() {
                console.warn('[indexeddb] versionchange on ' + dbName + ' — closing this connection so the upgrade can proceed');
                try { result.close(); } catch (e) {}
                if (db === result) db = null;
            };
            db = result;
            if (_dbOpenPromise === myOpenPromise) _dbOpenPromise = null;
            settle(resolve, result);
        };
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
            if (!database.objectStoreNames.contains(llmEndpointsStoreName)) {
                database.createObjectStore(llmEndpointsStoreName, { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains(workspaceMetaStoreName)) {
                database.createObjectStore(workspaceMetaStoreName, { keyPath: 'repo' });
            }
            if (!database.objectStoreNames.contains(workspaceFilesStoreName)) {
                var wsStore = database.createObjectStore(workspaceFilesStoreName, { keyPath: 'id' });
                wsStore.createIndex('repo', 'repo', { unique: false });
                wsStore.createIndex('repo_path', ['repo', 'path'], { unique: true });
            }
            if (!database.objectStoreNames.contains(workspaceBlobsStoreName)) {
                database.createObjectStore(workspaceBlobsStoreName, { keyPath: 'sha' });
            }
            // v13 migration: move pristine content out of workspace_files rows
            // into the content-addressed blob store. Runs eagerly inside the
            // versionchange transaction so rows and blobs commit atomically.
            if (e.oldVersion < 13 && database.objectStoreNames.contains(workspaceFilesStoreName)) {
                try {
                    var migrationTx = e.target.transaction || request.transaction;
                    var filesStore = migrationTx.objectStore(workspaceFilesStoreName);
                    var blobStore = migrationTx.objectStore(workspaceBlobsStoreName);
                    // Diagnostics: if the versionchange tx aborts for ANY reason the open
                    // request rejects and the DB stays unusable — surface the cause instead
                    // of a silent brick.
                    migrationTx.onabort = function() { console.error('workspace_blobs v13 migration tx aborted:', migrationTx.error); };
                    // Serialized cursor walk: advance ONLY from each per-row blob put's
                    // callbacks. This (a) lets a single put failure be contained with
                    // preventDefault so it can't abort the whole upgrade and brick the DB,
                    // and (b) defers stripping a row's inline content until its blob is
                    // durably written, so a failed put leaves the row fully intact.
                    filesStore.openCursor().onsuccess = function(ev) {
                        var cursor = ev.target.result;
                        if (!cursor) return; // exhausted — tx auto-commits
                        var row = cursor.value;
                        if (!(row && row.sha && row.original_content != null)) { cursor.continue(); return; }
                        var putReq;
                        try {
                            putReq = blobStore.put({ sha: row.sha, content: row.original_content });
                        } catch (putErr) {
                            // Synchronous throw — leave row inline, keep going.
                            console.error('workspace_blobs v13 put threw (row left inline):', putErr);
                            cursor.continue();
                            return;
                        }
                        putReq.onsuccess = function() {
                            try {
                                delete row.original_content;
                                // Clean rows read their content from the blob;
                                // dirty rows keep their overlay content inline.
                                if (!row.dirty) delete row.content;
                                cursor.update(row);
                            } catch (uErr) { console.error('workspace_blobs v13 row update failed:', uErr); }
                            cursor.continue();
                        };
                        putReq.onerror = function(putEv) {
                            // A single blob write failing (e.g. quota/IO) must NOT abort the
                            // versionchange transaction — preventDefault stops the error from
                            // bubbling to the tx (which would roll back the upgrade and leave
                            // openDatabase permanently rejecting). Leave the row fully inline
                            // (original_content intact); it migrates on a later normal write.
                            if (putEv && typeof putEv.preventDefault === 'function') putEv.preventDefault();
                            console.error('workspace_blobs v13 blob put failed (row left inline):', putReq.error);
                            cursor.continue();
                        };
                    };
                } catch (migErr) { console.error('workspace_blobs v13 migration failed:', migErr); }
            }
            if (!database.objectStoreNames.contains(documentsStoreName)) {
                database.createObjectStore(documentsStoreName, { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains(actionStateStoreName)) {
                database.createObjectStore(actionStateStoreName, { keyPath: 'actionId' });
            }
            if (!database.objectStoreNames.contains(agentRunsStoreName)) {
                database.createObjectStore(agentRunsStoreName, { keyPath: 'chatId' });
            }
            if (!database.objectStoreNames.contains(subAgentsStoreName)) {
                var saStore = database.createObjectStore(subAgentsStoreName, { keyPath: 'agent_id' });
                // Index by parent_chat_id so `agent_status` and the Workers strip
                // can enumerate every sub owned by a given parent chat without
                // scanning the whole store.
                saStore.createIndex('parent_chat_id', 'parent_chat_id', { unique: false });
                saStore.createIndex('state', 'state', { unique: false });
            }
        };
    });
    _dbOpenPromise = myOpenPromise;
    return myOpenPromise;
}

// True for the DOMException shapes a dead / force-closed connection throws:
// InvalidStateError, or the "database connection is closing" message some
// Chrome versions raise while teardown is in progress.
function _isDbConnectionError(e) {
    if (!e) return false;
    if (e.name === 'InvalidStateError') return true;
    return typeof e.message === 'string' && e.message.toLowerCase().indexOf('database connection is closing') !== -1;
}

// Retry-once transaction wrapper for the high-traffic read/write paths
// (settings get/set, chat load/save in page + worker realms). `fn` receives
// a freshly created transaction and returns a value or promise. If the
// transaction fails because the connection died (see _isDbConnectionError)
// — e.g. Chrome force-closed it in the window between openDatabase()'s
// liveness probe and the transaction() call here — the dead connection is
// dropped and `fn` is retried EXACTLY once on a fresh connection. NOTE:
// `_dbOpenPromise` is deliberately NOT cleared here: if one is in flight it
// already refers to a NEW connection attempt (not the dead handle), and
// clearing it would fork duplicate opens. Only pass idempotent bodies (all
// current callers are: get/getAll reads, and diff-saves re-derived from
// in-memory state).
async function withStore(storeNames, mode, fn) {
    var database = await openDatabase();
    try {
        return await Promise.resolve(fn(database.transaction(storeNames, mode)));
    } catch (e) {
        if (!_isDbConnectionError(e)) throw e;
        console.warn('[indexeddb] transaction on ' + storeNames + ' hit a dead connection — reopening and retrying once', e);
        try { database.close(); } catch (e2) {}
        if (db === database) db = null;
        database = await openDatabase();
        return await Promise.resolve(fn(database.transaction(storeNames, mode)));
    }
}

// Generic settings get/set for IndexedDB
async function getSetting(key, defaultValue) {
    try {
        return await withStore([settingsStoreName], 'readonly', function(transaction) {
            var store = transaction.objectStore(settingsStoreName);
            var request = store.get(key);
            return new Promise(function(resolve) {
                request.onsuccess = function() {
                    resolve(request.result ? request.result.value : defaultValue);
                };
                request.onerror = function() { resolve(defaultValue); };
            });
        });
    } catch (e) {
        // Post-retry failure — log loudly instead of silently defaulting so a
        // storage outage is diagnosable from the console.
        console.error('getSetting failed (returning default):', key, e);
        return defaultValue;
    }
}

async function setSetting(key, value) {
    try {
        await withStore([settingsStoreName], 'readwrite', function(transaction) {
            var store = transaction.objectStore(settingsStoreName);
            store.put({ key: key, value: value });
        });
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

// WIPE-GUARD: mirrors the chats-store flag. saveAllLlmEndpoints is forbidden
// until a load has SUCCEEDED — an unhydrated save would overwrite the user's
// stored endpoints (API keys!) with the empty/default in-memory array. Set
// ONLY in the loadLlmEndpoints onsuccess below.
var _llmEndpointsHydrated = false;

// LLM Endpoints Management (mirrors the provider functions below).
// Safe to call twice (page + SW realm): once hydrated, a re-call just
// refreshes from the store and never re-seeds over in-memory entries.
async function loadLlmEndpoints() {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([llmEndpointsStoreName], 'readonly');
        var store = transaction.objectStore(llmEndpointsStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var loaded = request.result || [];
                // Hydration succeeded — unblock saves BEFORE the seeding/merge
                // branches below, which legitimately save.
                _llmEndpointsHydrated = true;
                if (loaded.length === 0) {
                    if (llmEndpoints.length === 0) {
                        // First load — seed with COPIES of the defaults (the
                        // migration below may donate a key into an entry; the
                        // pristine DEFAULT_LLM_ENDPOINTS must stay untouched).
                        llmEndpoints = DEFAULT_LLM_ENDPOINTS.map(function(d) { return Object.assign({}, d); });
                        saveAllLlmEndpoints();
                    }
                    // else: in-memory entries exist but the store is empty
                    // (save still in flight) — keep them, never re-seed.
                } else {
                    llmEndpoints = loaded;
                    // Merge any new default endpoints not yet in IndexedDB
                    var added = false;
                    DEFAULT_LLM_ENDPOINTS.forEach(function(def) {
                        var exists = llmEndpoints.some(function(ep) { return ep.id === def.id; });
                        if (!exists) {
                            llmEndpoints.push(Object.assign({}, def));
                            added = true;
                        }
                    });
                    if (added) saveAllLlmEndpoints();
                }
                resolve();
            };
            request.onerror = function() {
                console.error('Failed to load LLM endpoints:', request.error);
                // Never clobber hydrated in-memory state on a failed RE-load.
                if (!_llmEndpointsHydrated && llmEndpoints.length === 0) {
                    llmEndpoints = DEFAULT_LLM_ENDPOINTS.map(function(d) { return Object.assign({}, d); });
                }
                resolve();
            };
        });
    } catch (e) {
        console.error('IndexedDB error loading LLM endpoints:', e);
        if (!_llmEndpointsHydrated && llmEndpoints.length === 0) {
            llmEndpoints = DEFAULT_LLM_ENDPOINTS.map(function(d) { return Object.assign({}, d); });
        }
        return Promise.resolve();
    }
}

async function saveAllLlmEndpoints() {
    // WIPE-GUARD: never persist before a successful hydration (see flag above).
    if (!_llmEndpointsHydrated) {
        console.error('saveAllLlmEndpoints blocked: endpoints not hydrated — refusing to overwrite stored endpoints');
        return;
    }
    try {
        var database = await openDatabase();
        var transaction = database.transaction([llmEndpointsStoreName], 'readwrite');
        var store = transaction.objectStore(llmEndpointsStoreName);
        // WIPE-GUARD: diff save — no store.clear(). Delete only ids that
        // vanished from memory, upsert the rest.
        var keysRequest = store.getAllKeys();
        keysRequest.onerror = function() {
            console.error('saveAllLlmEndpoints: getAllKeys failed — save skipped', keysRequest.error);
        };
        transaction.onabort = function() {
            console.error('saveAllLlmEndpoints: transaction aborted — save lost', transaction.error);
        };
        keysRequest.onsuccess = function() {
            var existingKeys = keysRequest.result || [];
            var desiredIds = {};
            llmEndpoints.forEach(function(ep) { if (ep && ep.id) desiredIds[ep.id] = true; });
            existingKeys.forEach(function(key) {
                if (!Object.prototype.hasOwnProperty.call(desiredIds, key)) {
                    try { store.delete(key); } catch (e) { console.error('saveAllLlmEndpoints: delete failed', key, e); }
                }
            });
            llmEndpoints.forEach(function(ep) {
                if (!ep || !ep.id) { console.warn('saveAllLlmEndpoints: skipping endpoint without an id', ep); return; }
                try { store.put(ep); } catch (e) { console.error('saveAllLlmEndpoints: put failed', ep.id, e); }
            });
        };
    } catch (e) {
        console.error('Failed to save all LLM endpoints:', e);
    }
}

async function saveLlmEndpoint(endpoint) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([llmEndpointsStoreName], 'readwrite');
        var store = transaction.objectStore(llmEndpointsStoreName);
        store.put(endpoint);
        // Update in-memory array
        var existingIndex = llmEndpoints.findIndex(function(ep) { return ep.id === endpoint.id; });
        if (existingIndex >= 0) {
            llmEndpoints[existingIndex] = endpoint;
        } else {
            llmEndpoints.push(endpoint);
        }
    } catch (e) {
        console.error('Failed to save LLM endpoint:', e);
    }
}

async function deleteLlmEndpoint(endpointId) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([llmEndpointsStoreName], 'readwrite');
        var store = transaction.objectStore(llmEndpointsStoreName);
        store.delete(endpointId);
        // Remove from in-memory array
        llmEndpoints = llmEndpoints.filter(function(ep) { return ep.id !== endpointId; });
    } catch (e) {
        console.error('Failed to delete LLM endpoint:', e);
    }
}

// WIPE-GUARD: mirrors the chats-store flag. saveAllApiProviders is forbidden
// until a load has SUCCEEDED — the load failure paths reset `apiProviders` to
// DEFAULTS, so an unhydrated save would overwrite the user's configured
// providers (API keys!) with defaults. Set ONLY in the load onsuccess below.
var _apiProvidersHydrated = false;

// API Providers Management
async function loadApiProviders() {
    // Endpoints must be hydrated first: the endpoint migration below and
    // resolveProviderConnection() both read the llmEndpoints array.
    await loadLlmEndpoints();
    try {
        var database = await openDatabase();
        var transaction = database.transaction([apiProvidersStoreName], 'readonly');
        var store = transaction.objectStore(apiProvidersStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var loaded = request.result || [];
                // Hydration succeeded — unblock saves BEFORE the default-seeding /
                // merge / migration branches below, which legitimately save.
                _apiProvidersHydrated = true;
                if (loaded.length === 0) {
                    // First load - initialize with defaults
                    apiProviders = DEFAULT_API_PROVIDERS.slice();
                    // Save defaults to IndexedDB
                    saveAllApiProviders();
                } else {
                    apiProviders = loaded;
                    // One-shot migration for renamed/removed/retuned defaults.
                    // July 2026 alignment: Kimi K2.5 → GLM 5.2, sonnet-4.6 →
                    // sonnet-5, gpt-5.2 → gpt-5.5, Gemini 3 Flash Preview →
                    // Gemini 3.5 Flash, Sonnet 4.6 OAuth → Sonnet 5, and the
                    // ' OAuth' name suffix was dropped (Opus-4-8 OAuth → Opus-4-8,
                    // Sonnet 5 OAuth → Sonnet 5); the
                    // opus-4.8 (OpenRouter), haiku-4.5 and Proxy defaults were
                    // REMOVED (to: null deletes an untouched copy). Only
                    // UNCUSTOMIZED legacy entries (every field equal to the old
                    // default — apiKey excepted for renames, but REQUIRED to match
                    // for deletions so a keyed entry is never dropped) are touched;
                    // runs BEFORE the default-merge below so a rename prevents the
                    // duplicate from being added.
                    // KEEP the from/to names IN SYNC with PROVIDER_RENAMES
                    // (core/030-config.js) — the page-side fallback in
                    // loadProviderFromStorage relies on it when the SW runs this
                    // migration first and the appStorage rewrite below cannot fire.
                    var migratedDefaults = false;
                    [
                        // Deletions — defaults removed in the July 2026 alignment
                        // (opus-4.6 never got its 4.8 successor either: that
                        // OpenRouter entry is gone too, so untouched copies drop)
                        { to: null, from: { name: 'opus-4.6', apiKey: '', model: 'anthropic/claude-opus-4-6', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 200000, maxTokens: 64000, thinkingBudget: 40000 } },
                        { to: null, from: { name: 'opus-4.8', apiKey: '', model: 'anthropic/claude-opus-4.8', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 200000, maxTokens: 64000, effort: 'xhigh' } },
                        { to: null, from: { name: 'haiku-4.5', apiKey: '', model: 'anthropic/claude-haiku-4.5', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 200000, maxTokens: 64000, thinkingBudget: 32000 } },
                        { to: null, from: { name: 'Proxy', model: 'anthropic/claude-opus-4-8', endpoint: 'http://localhost:8000/api/v1/chat/completions', apiKey: '----', maxTokens: 100000, context_length: 200000, effort: 'xhigh' } },
                        // Renames — legacy default → its July 2026 successor
                        // (sonnet-4.5 chain-collapses straight to sonnet-5: the old
                        // sonnet-4.6 target no longer exists in the defaults)
                        { to: 'sonnet-5', from: { name: 'sonnet-4.5', apiKey: '', model: 'anthropic/claude-sonnet-4.5', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 200000, maxTokens: 64000, thinkingBudget: 40000 } },
                        { to: 'sonnet-5', from: { name: 'sonnet-4.6', apiKey: '', model: 'anthropic/claude-sonnet-4.6', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 200000, maxTokens: 64000, effort: 'high' } },
                        { to: 'GLM 5.2', from: { name: 'Kimi K2.5', apiKey: '', model: 'moonshotai/kimi-k2.5', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 262000, maxTokens: 64000, thinkingBudget: 40000, provider: 'moonshotai' } },
                        { to: 'gpt-5.5', from: { name: 'gpt-5.2', apiKey: '', model: 'openai/gpt-5.2', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 400000, maxTokens: 128000, effort: 'low' } },
                        { to: 'Gemini 3.5 Flash', from: { name: 'Gemini 3 Flash Preview', apiKey: '', model: 'google/gemini-3-flash-preview', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 1000000, maxTokens: 64000, thinkingBudget: 50000 } },
                        { to: 'Sonnet 5', from: { name: 'Sonnet 4.6 OAuth', model: 'claude-sonnet-4-6', endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'oauth', maxTokens: 100000, context_length: 200000, effort: 'high', isClaudeOAuth: true } },
                        // OAuth-suffix drop — same providers, friendlier names.
                        // Two Opus snapshots: effort was 'high' before the xhigh
                        // retune below, 'xhigh' after — match both vintages.
                        { to: 'Opus-4-8', from: { name: 'Opus-4-8 OAuth', model: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'oauth', maxTokens: 100000, context_length: 200000, effort: 'xhigh', isClaudeOAuth: true } },
                        { to: 'Opus-4-8', from: { name: 'Opus-4-8 OAuth', model: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'oauth', maxTokens: 100000, context_length: 200000, effort: 'high', isClaudeOAuth: true } },
                        { to: 'Sonnet 5', from: { name: 'Sonnet 5 OAuth', model: 'claude-sonnet-5', endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'oauth', maxTokens: 100000, context_length: 1000000, effort: 'high', isClaudeOAuth: true } }
                    ].forEach(function(mig) {
                        var idx = -1;
                        for (var i = 0; i < apiProviders.length; i++) {
                            if (apiProviders[i].name === mig.from.name) { idx = i; break; }
                        }
                        if (idx === -1) return;
                        var legacy = apiProviders[idx];
                        // Uncustomized = exact same shape/values as the old default.
                        // Renames except apiKey (it is carried over); deletions
                        // (to: null) require apiKey to equal the old default too,
                        // so an entry holding a real key is never dropped.
                        var untouched = Object.keys(mig.from).every(function(k) {
                            return (mig.to && k === 'apiKey') || legacy[k] === mig.from[k];
                        }) && Object.keys(legacy).every(function(k) {
                            return Object.prototype.hasOwnProperty.call(mig.from, k);
                        });
                        if (!untouched) return;
                        if (!mig.to) {
                            // Removed default — drop the untouched copy and repoint
                            // any persisted selection at the config default.
                            apiProviders.splice(idx, 1);
                            if (currentProvider === mig.from.name) currentProvider = 'Opus-4-8';
                            if (typeof appStorage !== 'undefined'
                                && appStorage.getItem('appagent_provider') === mig.from.name) {
                                try { appStorage.setItem('appagent_provider', 'Opus-4-8'); } catch (e) {}
                            }
                            migratedDefaults = true;
                            return;
                        }
                        var newDef = DEFAULT_API_PROVIDERS.find(function(d) { return d.name === mig.to; });
                        if (!newDef) return;
                        var existingNew = apiProviders.find(function(p) { return p.name === mig.to; });
                        if (existingNew) {
                            // New default already present (added by an earlier merge
                            // run): drop the stale legacy entry, donating its apiKey
                            // if the new entry is still keyless.
                            if (legacy.apiKey && !existingNew.apiKey) existingNew.apiKey = legacy.apiKey;
                            apiProviders.splice(idx, 1);
                        } else {
                            apiProviders[idx] = Object.assign({}, newDef, { apiKey: legacy.apiKey || '' });
                        }
                        if (currentProvider === mig.from.name) currentProvider = mig.to;
                        // Also migrate the PERSISTED selection — at this point the
                        // in-memory currentProvider may still be the config default
                        // (loadProviderFromStorage runs later and would silently
                        // drop a selection whose provider was just renamed).
                        // appStorage lives in the page bundle only (020-bootstrap is
                        // not in WORKER_SHARED_FILES) — guard for the SW context.
                        if (typeof appStorage !== 'undefined'
                            && appStorage.getItem('appagent_provider') === mig.from.name) {
                            try { appStorage.setItem('appagent_provider', mig.to); } catch (e) {}
                        }
                        migratedDefaults = true;
                    });
                    // Opus-4-8 OAuth (legacy name — untouched copies were renamed to
                    // 'Opus-4-8' with xhigh above): bump effort high → xhigh only when
                    // the entry still matches the old default shape (i.e. not user-tuned).
                    apiProviders.forEach(function(p) {
                        if (p.isClaudeOAuth && p.name === 'Opus-4-8 OAuth' && p.effort === 'high'
                            && p.model === 'claude-opus-4-8' && p.maxTokens === 100000) {
                            p.effort = 'xhigh';
                            migratedDefaults = true;
                        }
                    });
                    if (migratedDefaults) saveAllApiProviders();
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
                    // ---------------------------------------------------------
                    // One-shot endpoint migration (idempotent — it may run in
                    // BOTH the page and the SW realm; the second run finds
                    // endpointId already set and only strips leftovers).
                    // Providers historically carried inline endpoint/apiKey
                    // fields; endpoints are now first-class NAMED objects in
                    // the llmEndpoints store and providers reference them by
                    // endpointId. Each legacy provider's url+key is folded
                    // into a matching llmEndpoints entry — donating its key
                    // to a keyless endpoint with the same url (this collapses
                    // the common single-OpenRouter-key case into the seeded
                    // 'OpenRouter' entry) — or a new named endpoint is created
                    // from the url's hostname. Claude-OAuth providers are
                    // exempt: they keep inline endpoint/apiKey ('oauth') and
                    // never get an endpointId. No key is ever dropped.
                    // ---------------------------------------------------------
                    var epProvidersChanged = false;
                    var epEndpointsChanged = false;
                    var epDefaultUrl = 'https://openrouter.ai/api/v1/chat/completions';
                    apiProviders.forEach(function(p) {
                        if (!p || p.isClaudeOAuth) return;
                        if (p.endpointId && getLlmEndpointById(p.endpointId)) {
                            // Already migrated — strip any leftover inline
                            // fields (e.g. the default-rename path above
                            // copies a legacy apiKey onto the new default
                            // shape). Donate a leftover key to the referenced
                            // endpoint if it is still keyless, so no key is
                            // ever lost.
                            if (Object.prototype.hasOwnProperty.call(p, 'apiKey')) {
                                var refEp = getLlmEndpointById(p.endpointId);
                                if (p.apiKey && p.apiKey !== 'oauth' && !(refEp.apiKey || '')) {
                                    refEp.apiKey = p.apiKey;
                                    epEndpointsChanged = true;
                                }
                                delete p.apiKey;
                                epProvidersChanged = true;
                            }
                            if (Object.prototype.hasOwnProperty.call(p, 'endpoint')) {
                                delete p.endpoint;
                                epProvidersChanged = true;
                            }
                            return;
                        }
                        var epUrl = p.endpoint || epDefaultUrl;
                        var epKey = p.apiKey || '';
                        // Reuse an endpoint with the same url whose key matches
                        // (or which has no key yet — the provider donates its
                        // key into it).
                        var ep = null;
                        for (var ei = 0; ei < llmEndpoints.length; ei++) {
                            var cand = llmEndpoints[ei];
                            if (cand.url === epUrl && ((cand.apiKey || '') === epKey || (cand.apiKey || '') === '')) {
                                ep = cand;
                                break;
                            }
                        }
                        if (ep) {
                            if (!(ep.apiKey || '') && epKey) {
                                ep.apiKey = epKey;
                                epEndpointsChanged = true;
                            }
                        } else {
                            // No match — create a named endpoint from the
                            // url's hostname (unique id slug + unique name).
                            var epHost = '';
                            try { epHost = new URL(epUrl).hostname.replace(/^www\./, ''); } catch (eHost) { epHost = ''; }
                            var epBaseId = (epHost || 'endpoint').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
                            var epId = epBaseId;
                            var epIdSuffix = 2;
                            while (getLlmEndpointById(epId)) { epId = epBaseId + '-' + epIdSuffix; epIdSuffix++; }
                            var epBaseName = epHost || 'Endpoint';
                            var epName = epBaseName;
                            var epNameSuffix = 2;
                            while (llmEndpoints.some(function(x) { return x.name === epName; })) { epName = epBaseName + ' (' + epNameSuffix + ')'; epNameSuffix++; }
                            ep = { id: epId, name: epName, url: epUrl, apiKey: epKey };
                            llmEndpoints.push(ep);
                            epEndpointsChanged = true;
                        }
                        p.endpointId = ep.id;
                        delete p.endpoint;
                        delete p.apiKey;
                        epProvidersChanged = true;
                    });
                    if (epEndpointsChanged) saveAllLlmEndpoints();
                    if (epProvidersChanged) saveAllApiProviders();
                }
                resolve();
            };
            request.onerror = function() {
                console.error('Failed to load API providers:', request.error);
                // Only fall back to defaults if we NEVER hydrated — a failed
                // RE-load must not replace the user's in-memory providers with
                // defaults while saves are unblocked (silent desync + key loss).
                if (!_apiProvidersHydrated) {
                    apiProviders = DEFAULT_API_PROVIDERS.slice();
                    if (typeof showSnackbar === 'function') {
                        try { showSnackbar('Failed to load API providers — showing defaults. Your saved providers are untouched; reload to retry.', 'error'); } catch (e) {}
                    }
                }
                resolve();
            };
        });
    } catch (e) {
        console.error('IndexedDB error loading API providers:', e);
        // Same rule as request.onerror: never clobber hydrated in-memory state.
        if (!_apiProvidersHydrated) {
            apiProviders = DEFAULT_API_PROVIDERS.slice();
            if (typeof showSnackbar === 'function') {
                try { showSnackbar('Failed to load API providers — showing defaults. Your saved providers are untouched; reload to retry.', 'error'); } catch (e2) {}
            }
        }
        return Promise.resolve();
    }
}

async function saveAllApiProviders() {
    // WIPE-GUARD: never persist before a successful hydration (see flag above).
    if (!_apiProvidersHydrated) {
        console.error('saveAllApiProviders blocked: providers not hydrated — refusing to overwrite stored providers');
        return;
    }
    try {
        var database = await openDatabase();
        var transaction = database.transaction([apiProvidersStoreName], 'readwrite');
        var store = transaction.objectStore(apiProvidersStoreName);
        // WIPE-GUARD: diff save — no store.clear(). Delete only names that
        // vanished from memory, upsert the rest.
        var keysRequest = store.getAllKeys();
        keysRequest.onerror = function() {
            console.error('saveAllApiProviders: getAllKeys failed — save skipped', keysRequest.error);
        };
        transaction.onabort = function() {
            console.error('saveAllApiProviders: transaction aborted — save lost', transaction.error);
        };
        keysRequest.onsuccess = function() {
            var existingKeys = keysRequest.result || [];
            var desiredNames = {};
            apiProviders.forEach(function(p) { if (p && p.name) desiredNames[p.name] = true; });
            existingKeys.forEach(function(key) {
                if (!Object.prototype.hasOwnProperty.call(desiredNames, key)) {
                    try { store.delete(key); } catch (e) { console.error('saveAllApiProviders: delete failed', key, e); }
                }
            });
            apiProviders.forEach(function(p) {
                if (!p || !p.name) { console.warn('saveAllApiProviders: skipping provider without a name', p); return; }
                try { store.put(p); } catch (e) { console.error('saveAllApiProviders: put failed', p.name, e); }
            });
        };
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

// Base64 → UTF-8 string. Embedded skill bodies/assets are encoded as UTF-8
// bytes (btoa(unescape(encodeURIComponent(s))) in the build); a plain atob()
// decode reads those bytes as Latin-1 and mangles every multibyte char
// (e.g. "—" → "â" + control chars, "é" → "Ã©").
function _b64DecodeUtf8(b64) {
    var raw = atob(b64);
    try { return decodeURIComponent(escape(raw)); } catch (e) { return raw; }
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
                // Self-heal: older builds decoded the embedded body with plain
                // atob(), storing mojibake ("—" → "â"+controls). The build hash
                // still matches (it's computed from the clean source), so without
                // this check the corrupted copy would never be repaired.
                if (existing && !existing.userModified) {
                    var healedBody = _b64DecodeUtf8(embedded.body);
                    if (existing.body !== healedBody) {
                        existing.body = healedBody;
                        existing.updatedAt = Date.now();
                        await saveSkill(existing);
                        await deleteSkillAssets(embedded.id);
                        var healAssets = embedded.assets || [];
                        for (var hk = 0; hk < healAssets.length; hk++) {
                            await saveSkillAsset(embedded.id, healAssets[hk].filename, healAssets[hk].type, _b64DecodeUtf8(healAssets[hk].content));
                        }
                        await loadSkillTools(embedded.id);
                    }
                }
                // Backfill: users who installed via an older build that dropped
                // actions entirely have stored actions=[]. Even though the hash
                // matches, refresh from the embedded frontmatter so their
                // action buttons appear after upgrade. Only backfills when the
                // stored list is empty AND the embedded build provides actions —
                // we don't want to clobber legitimately-empty user edits.
                if (existing && (!Array.isArray(existing.actions) || existing.actions.length === 0) && embedded.frontmatter && !existing.userModified) {
                    try {
                        var fmDecodedBackfill = _b64DecodeUtf8(embedded.frontmatter);
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
            var decodedBody = _b64DecodeUtf8(embedded.body);
            // Parse actions from the raw frontmatter if provided by the build
            var embeddedActions = [];
            if (embedded.frontmatter) {
                try {
                    var fmDecoded = _b64DecodeUtf8(embedded.frontmatter);
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
                await saveSkillAsset(embedded.id, assets[j].filename, assets[j].type, _b64DecodeUtf8(assets[j].content));
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
        if (meta) {
            try { meta.last_used_at = Date.now(); setWorkspaceMeta(meta); } catch (e) {}
            return workspace;
        }
        return { error: 'Workspace "' + workspace + '" not found. Use workspace clone first.' };
    }

    // No workspace param — pick a workspace deterministically.
    try {
        var all = await getAllWorkspaceMetas();
        if (all.length === 0) return { error: 'No workspaces cloned. Use workspace clone first.' };
        // One or more workspaces: fall back to the most-recently-used (MRU) one
        // instead of erroring on ambiguity. last_used_at falls back to cloned_at.
        all.sort(function(a, b) { return (b.last_used_at || b.cloned_at || 0) - (a.last_used_at || a.cloned_at || 0); });
        var chosen = all[0];
        // Pin override: when the MRU workspace's repo has a PINNED sibling
        // workspace (at most one per owner/repo — invariant enforced by
        // setWorkspacePin), the pin wins over MRU. Explicit workspace params
        // never reach this path, so they always win.
        var chosenRepo = chosen.github_repo || parseWsKey(chosen.repo).repo;
        for (var pi = 0; pi < all.length; pi++) {
            var pm = all[pi];
            if (pm && pm.pinned && (pm.github_repo || parseWsKey(pm.repo).repo) === chosenRepo) {
                chosen = pm;
                break;
            }
        }
        try { chosen.last_used_at = Date.now(); setWorkspaceMeta(chosen); } catch (e) {}
        return chosen.repo;
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

// Normalize a stored/typed GitHub instance URL so strict-equality checks
// against the canonical 'https://github.com' work for trailing-slash and
// case variants: trim, strip trailing slashes, lowercase protocol+host (URL
// parsing does the lowercasing; path case is preserved for GHE instances
// served under a path). Empty/missing input yields the cloud default.
// Kept in sync with the inline copies in platform/extension/background.js
// (separate script, not part of this bundle).
function normalizeGitHubInstanceUrl(u) {
    var s = String(u || '').trim().replace(/\/+$/, '');
    if (!s) return 'https://github.com';
    try {
        var p = new URL(s);
        s = p.protocol + '//' + p.host + p.pathname.replace(/\/+$/, '');
    } catch (e) { /* not an absolute URL — keep the trimmed string */ }
    return s;
}

// GitHub API call helper. Calls fetch() directly from whichever context invokes
// it (SW or panel). Previously this round-tripped through background.js via
// chrome.runtime.sendMessage, but a SW cannot deliver messages to its own
// onMessage listener, so every call from a tool path (clone/push/etc.) was
// failing silently with "message port closed". Reading the stored token via
// chrome.storage.local works the same in both contexts.
async function githubApi(method, path, body) {
    try {
        var ghData = await new Promise(function(resolve) {
            chrome.storage.local.get(['githubToken', 'githubInstanceUrl'], function(d) { resolve(d || {}); });
        });
        var token = ghData.githubToken;
        var instanceUrl = normalizeGitHubInstanceUrl(ghData.githubInstanceUrl);
        if (!token) return { error: 'No GitHub token configured' };
        var apiBase = instanceUrl === 'https://github.com' ? 'https://api.github.com' : instanceUrl + '/api/v3';
        var headers = {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (body) headers['Content-Type'] = 'application/json';
        var opts = { method: method || 'GET', headers: headers, cache: 'no-store' };
        if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        var res = await fetch(apiBase + path, opts);
        var text = await res.text();
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
        return { status: res.status, ok: res.ok, body: parsed || text };
    } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
    }
}

// GitHub GraphQL API call helper. Same stored token as githubApi, but POSTs to
// the GraphQL endpoint: https://api.github.com/graphql for github.com, or
// <instanceUrl>/api/graphql for GitHub Enterprise (NOT /api/v3/graphql).
// Returns { ok, status, body } parsed the same way as githubApi.
async function githubGraphql(query) {
    try {
        var ghData = await new Promise(function(resolve) {
            chrome.storage.local.get(['githubToken', 'githubInstanceUrl'], function(d) { resolve(d || {}); });
        });
        var token = ghData.githubToken;
        var instanceUrl = normalizeGitHubInstanceUrl(ghData.githubInstanceUrl);
        if (!token) return { error: 'No GitHub token configured' };
        var gqlUrl = instanceUrl === 'https://github.com'
            ? 'https://api.github.com/graphql'
            : instanceUrl + '/api/graphql';
        var res = await fetch(gqlUrl, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            },
            cache: 'no-store',
            body: JSON.stringify({ query: query })
        });
        var text = await res.text();
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
        return { status: res.status, ok: res.ok, body: parsed || text };
    } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
    }
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

// ---- Content-addressed blob helpers (workspace_blobs store) ----

// Idempotent put: git blobs are immutable (same sha == same bytes), so a
// blind put never corrupts an existing entry. Awaits tx completion so
// callers can rely on the blob being durable before stripping rows.
// Returns true on success, false on failure (e.g. quota) so callers can
// decide not to strip inline content when the blob is not durable.
async function putWorkspaceBlob(sha, content) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceBlobsStoreName], 'readwrite');
        tx.objectStore(workspaceBlobsStoreName).put({ sha: sha, content: content });
        await new Promise(function(resolve, reject) {
            tx.oncomplete = resolve;
            tx.onerror = function() { reject(tx.error); };
            // A tx can abort with NO bubbled request error (e.g. forced close
            // during another connection's versionchange) — without this the
            // awaited Promise would hang forever and stall the write loop.
            tx.onabort = function() { reject(tx.error || new DOMException('Transaction aborted', 'AbortError')); };
        });
        return true;
    } catch (e) { console.error('Failed to save workspace blob:', e); return false; }
}

// Batch lookup: returns a map { sha: content } containing only the shas
// that exist in the blob store. Dedupes input; one readonly tx with
// parallel gets.
async function getWorkspaceBlobsBySha(shas) {
    var out = {};
    try {
        var unique = [];
        var seen = {};
        for (var i = 0; i < (shas || []).length; i++) {
            var s = shas[i];
            if (s && !seen[s]) { seen[s] = true; unique.push(s); }
        }
        if (!unique.length) return out;
        var database = await openDatabase();
        var tx = database.transaction([workspaceBlobsStoreName], 'readonly');
        var store = tx.objectStore(workspaceBlobsStoreName);
        var promises = unique.map(function(sha) {
            return new Promise(function(resolve) {
                var req = store.get(sha);
                req.onsuccess = function() {
                    if (req.result && req.result.content != null) out[sha] = req.result.content;
                    resolve();
                };
                req.onerror = function() { resolve(); };
            });
        });
        await Promise.all(promises);
    } catch (e) { /* best-effort: return what we have */ }
    return out;
}

// Garbage-collect orphaned blobs: keep every sha referenced by ANY
// workspace_files row across all repos (including stubs and dirty rows —
// stub blobs may exist from other clones and stay reusable). Returns the
// number of deleted blobs; never throws.
async function gcWorkspaceBlobs() {
    try {
        var database = await openDatabase();
        // Atomic mark-and-sweep in ONE readwrite tx spanning BOTH stores: the
        // keep-set is built by reading workspace_files INSIDE the same tx that
        // sweeps workspace_blobs. This closes the TOCTOU where a concurrent
        // setWorkspaceFile (which writes the blob BEFORE its row) could have its
        // just-written, not-yet-referenced blob swept by a mark snapshot taken a
        // moment earlier.
        var tx = database.transaction([workspaceFilesStoreName, workspaceMetaStoreName, workspaceBlobsStoreName], 'readwrite');
        var filesStore = tx.objectStore(workspaceFilesStoreName);
        var metaStore = tx.objectStore(workspaceMetaStoreName);
        var blobStore = tx.objectStore(workspaceBlobsStoreName);
        var deleted = 0;
        return await new Promise(function(resolve, reject) {
            // MARK: keep every sha referenced by ANY workspace_files row
            // (stubs and dirty rows included — their blobs stay reusable),
            // PLUS every PR diff-snapshot sha referenced from workspace_meta
            // (meta.prs[].files[].old_sha/new_sha — written by wsPush, read
            // by the sidebar's merged-PR diff). Those blobs have no
            // workspace_files row once the fork workspace is deleted on
            // merge, so sweeping by files alone would collect them.
            var keep = {};
            var metasReq = metaStore.getAll();
            metasReq.onsuccess = function() {
                var metas = metasReq.result || [];
                for (var mi = 0; mi < metas.length; mi++) {
                    var prs = metas[mi] && metas[mi].prs;
                    if (!Array.isArray(prs)) continue;
                    for (var pi = 0; pi < prs.length; pi++) {
                        var pfs = prs[pi] && prs[pi].files;
                        if (!Array.isArray(pfs)) continue;
                        for (var fi = 0; fi < pfs.length; fi++) {
                            if (!pfs[fi]) continue;
                            if (pfs[fi].old_sha) keep[pfs[fi].old_sha] = true;
                            if (pfs[fi].new_sha) keep[pfs[fi].new_sha] = true;
                        }
                    }
                }
            };
            metasReq.onerror = function() { reject(metasReq.error); };
            var filesReq = filesStore.getAll();
            filesReq.onsuccess = function() {
                var rows = filesReq.result || [];
                for (var i = 0; i < rows.length; i++) {
                    if (rows[i] && rows[i].sha) keep[rows[i].sha] = true;
                }
                // SWEEP: delete blobs not in the keep-set within the SAME tx.
                // (Request ordering guarantees the metasReq.onsuccess above ran
                // first — IDB delivers results in request-issue order — so the
                // keep-set already contains the PR snapshot shas here.)
                var cursorReq = blobStore.openCursor();
                cursorReq.onsuccess = function(ev) {
                    var cursor = ev.target.result;
                    if (!cursor) return; // exhausted — tx commits, oncomplete resolves
                    if (!keep[cursor.key]) {
                        cursor.delete();
                        deleted++;
                    }
                    cursor.continue();
                };
                cursorReq.onerror = function() { reject(cursorReq.error); };
            };
            filesReq.onerror = function() { reject(filesReq.error); };
            // Resolve only after the tx COMMITS (deletes durable) — this also
            // fixes the prior resolve-on-cursor-exhaustion that returned the
            // count before the deletes were committed.
            tx.oncomplete = function() { resolve(deleted); };
            tx.onerror = function() { reject(tx.error); };
            tx.onabort = function() { reject(tx.error || new DOMException('Transaction aborted', 'AbortError')); };
        });
    } catch (e) { return 0; }
}

// Internal: re-attach blob content to workspace_files rows fetched from
// IndexedDB so upper layers keep seeing inline original_content/content.
// Rows that are dirty keep their inline overlay content; clean rows get
// content mirrored from the blob. Deleted tombstones ARE resolved too —
// wsDiscard restores them from original_content (and they are always
// dirty, so the self-heal below can never demote them). If a blob is
// missing for a clean row (e.g. partially-failed GC), self-heal by
// reverting the row to a stub so the next read re-hydrates from GitHub
// by sha.
async function _resolveWorkspaceRows(rows) {
    var need = [];
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r && r.original_content == null && r.sha && !r.stub) need.push(r.sha);
    }
    if (!need.length) return rows;
    var blobs = await getWorkspaceBlobsBySha(need);
    for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        if (!row || row.original_content != null || !row.sha || row.stub) continue;
        var blob = blobs[row.sha];
        if (blob !== undefined) {
            row.original_content = blob;
            if (!row.dirty && row.content == null) row.content = blob;
        } else if (!row.dirty) {
            // Blob missing — self-heal: demote to stub; wsHydrate will
            // re-fetch the content from GitHub by sha on next access.
            row.stub = true;
            row.content = null;
        }
    }
    return rows;
}

async function getWorkspaceFile(repo, path) {
    try {
        var database = await openDatabase();
        var tx = database.transaction([workspaceFilesStoreName], 'readonly');
        var store = tx.objectStore(workspaceFilesStoreName);
        var index = store.index('repo_path');
        var request = index.get([repo, path]);
        var row = await new Promise(function(resolve) {
            request.onsuccess = function() { resolve(request.result || null); };
            request.onerror = function() { resolve(null); };
        });
        if (!row) return null;
        await _resolveWorkspaceRows([row]);
        return row;
    } catch (e) { return null; }
}

async function setWorkspaceFile(file) {
    try {
        // Content-addressed storage: persist pristine content ONCE per sha in
        // the blob store, then strip it from the row. Persist a CLONE so the
        // caller's in-memory object keeps its inline content.
        var toStore = file;
        if (file && file.sha && file.original_content != null) {
            var blobOk = await putWorkspaceBlob(file.sha, file.original_content);
            if (blobOk) {
                toStore = Object.assign({}, file);
                delete toStore.original_content;
                if (!file.dirty && file.content === file.original_content) delete toStore.content;
            }
            // blob put failed (e.g. quota) — keep inline content rather than
            // stripping a row whose blob is not durable.
        }
        var database = await openDatabase();
        var tx = database.transaction([workspaceFilesStoreName], 'readwrite');
        tx.objectStore(workspaceFilesStoreName).put(toStore);
        await new Promise(function(resolve, reject) {
            tx.oncomplete = resolve;
            tx.onerror = function() { reject(tx.error); };
            // A tx can abort with NO bubbled request error (e.g. forced close
            // during another connection's versionchange) — without this the
            // awaited Promise would hang forever and stall the write loop.
            tx.onabort = function() { reject(tx.error || new DOMException('Transaction aborted', 'AbortError')); };
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
        var rows = await new Promise(function(resolve) {
            request.onsuccess = function() { resolve(request.result || []); };
            request.onerror = function() { resolve([]); };
        });
        return await _resolveWorkspaceRows(rows);
    } catch (e) { return []; }
}

// Returns RAW rows for every workspace file across all clones — post-v13
// these usually lack inline content (it lives in workspace_blobs). Used by
// clone's legacy-row scan.
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
