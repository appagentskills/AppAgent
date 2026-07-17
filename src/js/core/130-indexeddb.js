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
// Bumped to 15 for the `pending_wakes` store: durable sub-agent parent
// wakes (WAKE-DUR — see core/097-sub-agent-registry.js). Volatile
// pendingInjectionsByChatId entries died with the MV3 service worker,
// stalling parents waiting on sub reports until the user typed.
// Bumped to 16 for the `chat_payloads` store (PAYLOAD-STORE): inline
// base64 file/screenshot payloads move OUT of chats records into
// immutable per-id blob rows, so per-tool-boundary chat saves stop
// rewriting every payload. The upgrade itself only creates the store —
// row migration is LAZY, at save time (see the note in onupgradeneeded:
// an eager in-upgrade migration crashed the browser on large stores).
var dbVersion = 16;
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
// Schema: { chatId, turn, callNumber, lastEventAt,
//           status: 'running'|'parked'|'finished'|'errored',
//           parkedToolCalls: [{toolCallId, name, input, parkedAt}, ...] }
// NOTE: records deliberately carry NO transcript. Legacy records also
// held messagesSnapshot (full chat.messages, inline base64 included) —
// a multi-MB structured-clone write per tool boundary that no reader
// ever consumed (resume re-runs from the chats record; the registry
// reads only cp.status). See 110-agent-checkpoint.js.
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
// pending_wakes: durable sub-agent parent wakes (WAKE-DUR). Written by
// _wakeParentOnReport / the end-of-run drain when a wake's delivery is
// deferred (queued in the volatile pendingInjectionsByChatId, or a run
// start that can be lost with the SW). Drained user-independently by
// drainPendingWakes (core/097) on the 30s agent-heartbeat alarm
// (background.js). Keyed by the PARENT chatId. Schema:
//   { parentChatId, notices: [{ text|null, sub_id, at }],
//     attempts, lastEventAt }
// A null-text notice is a "run-only" wake: the notice row is already in
// the transcript, only the runAgent start needs to be (re)tried.
var pendingWakesStoreName = 'pending_wakes';
// chat_payloads (PAYLOAD-STORE): durable home of every chat file/screenshot
// payload. Rows are { id, base64, at } keyed by the message's
// file_id/screenshot_id — ids are unique per capture and their content is
// immutable, so a payload is written to disk ONCE, not re-serialized by
// every chat save at every tool boundary (the write amplification behind
// the recurring 30s transaction timeouts). Chats records persist with
// payload-bearing messages stripped and flagged (_b64Evicted on the
// message/screenshot entry, _payloadsEvicted on the record — see
// extractChatPayloadsForPut); hydration back into memory is
// ensureChatPayloads. `at` (write time) is indexed for the boot-time
// orphan sweep (sweepOrphanChatPayloads).
var chatPayloadsStoreName = 'chat_payloads';
var db = null;
// Dedupe concurrent openDatabase() calls: all callers racing while no live
// connection is cached share ONE in-flight open request. Cleared on failure
// (error / blocked timeout) so a later call can retry, and on success (the
// cached `db` takes over as the fast path).
var _dbOpenPromise = null;
// Module ref to the in-flight open watchdog timer so closeDatabase() can
// cancel a pending open before a context teardown (reload / pagehide).
var _dbOpenWatchdogTimer = null;
// SLEEP-WEDGE: watchdog for a SILENTLY hung indexedDB.open() — after a long
// suspend Chrome's IDB backend can wedge such that the open request fires
// NONE of onsuccess/onerror/onblocked. Without an unconditional timer the
// promise above stays pending forever and poisons the realm (every caller
// dedupes onto it). See openDatabase().
var DB_OPEN_WATCHDOG_MS = 15000;
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

// RELOAD-DB latch: timestamp of the last closeDatabase() call. closeDatabase
// only runs on teardown paths (reloadExtension 'prepare-reload', page
// pagehide, SW onSuspend), all of which precede an abrupt context teardown.
// While the latch is FRESH (< DB_RELOAD_LATCH_MS) openDatabase() refuses to
// start a new open and an already-in-flight open's onsuccess closes its
// connection instead of caching it — otherwise a racer inside
// _prepareRealmsForReload's ~250ms settle window re-establishes a live
// connection that chrome.runtime.reload() then abandons un-closed,
// re-creating the exact IDB wedge closeDatabase() exists to prevent. The
// latch is time-boxed and cleared by the next openDatabase() call after the
// window, so if the teardown never actually happened (reload aborted,
// bfcache restore) normal reopening self-heals.
var DB_RELOAD_LATCH_MS = 2000;
var _dbClosingForReload = 0;

// SW-IDLE-CLOSE (empty-chat-list root fix): in the SERVICE-WORKER realm the
// cached IDB connection must not outlive active work. A parked tool call (see
// worker/120-tool-routing.js) keeps the SW warm for its whole lifetime; if the
// SW is then abruptly killed or the OS sleeps, an un-closed connection is
// abandoned mid-teardown and Chromium can wedge the origin's IDB backing store
// — the next reload's open() hangs and the app renders an empty chat list until
// a full Chrome restart. onSuspend is best-effort and does NOT fire on OS sleep
// / process kill, so we proactively drop the cached SW connection once it has
// been idle for DB_SW_IDLE_CLOSE_MS. Driven by the 30s heartbeat alarm
// (background.js) — an MV3-durable timer, unlike setTimeout in a SW — plus an
// explicit release on run-park (worker/110-agent-checkpoint.js) and on
// parked-call expiry (worker/120-tool-routing.js). The next
// withStore()/openDatabase() reopens transparently. The PAGE realm keeps its
// connection (pagehide -> closeDatabase covers its teardown); only the SW is
// bounded here. Last-access time is the activity signal: an active run
// checkpoints/saves often enough to stay warm; a parked/idle SW lapses.
var DB_SW_IDLE_CLOSE_MS = 15000;
var _dbLastAccessAt = 0;
// SW realm == no document (the panel page AND the offscreen doc both have a
// document; the service worker does not). Computed once; gates the idle-close so
// it never fights the page's long-lived connection.
var _dbIsWorkerRealm = (typeof document === 'undefined');

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
    // RELOAD-DB latch (see _dbClosingForReload above): while a for-reload
    // close is pending, fail fast instead of opening a doomed connection.
    // Past the window, clear the latch so this (intentional) call reopens
    // normally.
    if (_dbClosingForReload) {
        if (Date.now() - _dbClosingForReload < DB_RELOAD_LATCH_MS) {
            return Promise.reject(new Error('IndexedDB is closed for an imminent extension reload'));
        }
        _dbClosingForReload = 0;
    }
    // Fast path: cached connection — but verify it's still alive so every
    // `await openDatabase()` call site (~60 across the bundles, in three
    // realms: panel page, service worker, offscreen doc) gets a usable
    // handle without needing individual connection-loss retry logic. This
    // is the shared transaction-creation choke point.
    if (db) {
        if (_isDbConnectionAlive(db)) { _dbLastAccessAt = Date.now(); return Promise.resolve(db); }
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
        // SLEEP-WEDGE: unconditional open watchdog, armed at request creation
        // (the onblocked timer below only covers ANNOUNCED blocks — a
        // post-suspend wedged backend fires no event at all). On expiry:
        // identity-guarded clear of the dedupe slot + reject, so the NEXT
        // caller retries a fresh open instead of sharing a dead promise
        // forever. If the open later succeeds anyway, onsuccess still caches
        // the connection for the next caller.
        var openWatchdogTimer = _dbOpenWatchdogTimer = setTimeout(function() {
            openWatchdogTimer = null;
            if (settled) return;
            console.warn('[indexeddb] open of ' + dbName + ' hung for ' + DB_OPEN_WATCHDOG_MS + 'ms with no success/error/blocked event — rejecting so callers can retry');
            if (_dbOpenPromise === myOpenPromise) _dbOpenPromise = null; // let a later call retry
            settle(reject, new Error('IndexedDB open timed out after ' + DB_OPEN_WATCHDOG_MS + 'ms — storage backend may be wedged. Try restarting Chrome if this persists.'));
        }, DB_OPEN_WATCHDOG_MS);
        function settle(fn, arg) {
            if (settled) return;
            settled = true;
            if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
            if (openWatchdogTimer) { clearTimeout(openWatchdogTimer); openWatchdogTimer = null; }
            _dbOpenWatchdogTimer = null;
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
            // RELOAD-DB latch: closeDatabase() ran while THIS open was in
            // flight — the realm is about to be torn down. Close the fresh
            // connection instead of caching it (caching would re-create the
            // abandoned-connection wedge the close was preventing) and reject
            // so racing callers fail fast. settle() clears the watchdog and
            // blocked timers, so nothing leaks.
            if (_dbClosingForReload) {
                try { result.close(); } catch (e) {}
                if (_dbOpenPromise === myOpenPromise) _dbOpenPromise = null;
                settle(reject, new Error('IndexedDB open abandoned: closed for an imminent extension reload'));
                return;
            }
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
            _dbLastAccessAt = Date.now(); // SW-IDLE-CLOSE activity stamp
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
            if (!database.objectStoreNames.contains(pendingWakesStoreName)) {
                database.createObjectStore(pendingWakesStoreName, { keyPath: 'parentChatId' });
            }
            if (!database.objectStoreNames.contains(chatPayloadsStoreName)) {
                var cpStore = database.createObjectStore(chatPayloadsStoreName, { keyPath: 'id' });
                // `at` (write time) drives the orphan sweep's age gate — key
                // cursors on this index never materialize the base64 values.
                cpStore.createIndex('at', 'at', { unique: false });
            }
            // v16 deliberately has NO eager row migration. Moving every chat's
            // payloads inside the single versionchange transaction buffered the
            // whole uncommitted journal (potentially GBs of base64 across all
            // chats) in memory at once and CRASHED the browser on large stores.
            // Migration is lazy instead: legacy records keep their inline
            // base64 (ensureChatPayloads reads it as a fallback source) until
            // the chat is next hydrated and saved — saveChatsToStorage's
            // extractChatPayloadsForPut then moves its payloads into
            // chat_payloads one chat per ordinary transaction. Untouched old
            // chats stay legacy-inline forever, which is harmless: they are
            // payload-evicted in memory, the save guard never re-puts them,
            // and every read path handles both shapes.
        };
    });
    _dbOpenPromise = myOpenPromise;
    return myOpenPromise;
}

// Cleanly close the cached IDB connection and reset all open state. Safe to
// call repeatedly and when nothing was ever opened. Called before a full
// extension reload (reloadExtension -> 'prepare-reload') and on page pagehide
// so a live connection is never abandoned when the context is torn down: an
// un-closed connection killed mid-reload can make Chrome force-close the
// origin's IndexedDB backing store, wedging the DB (open() hangs / throws
// UnknownError) until a full browser restart. Shared into the page + worker
// (SW) bundles via WORKER_SHARED_FILES, so both realms expose it.
function closeDatabase() {
    // Arm the RELOAD-DB latch (see _dbClosingForReload) so an in-flight or
    // freshly-started openDatabase() inside the pre-reload settle window
    // cannot re-establish a live connection the reload would then abandon.
    _dbClosingForReload = Date.now();
    if (_dbOpenWatchdogTimer) {
        try { clearTimeout(_dbOpenWatchdogTimer); } catch (e) {}
        _dbOpenWatchdogTimer = null;
    }
    // Drop the in-flight dedupe promise so the next openDatabase() starts a
    // fresh open instead of handing out a promise for a connection we closed.
    _dbOpenPromise = null;
    if (db) {
        try { db.close(); } catch (e) {}
        db = null;
    }
}

// SW-IDLE-CLOSE soft release: drop the cached connection WITHOUT arming the
// RELOAD-DB latch. closeDatabase() sets _dbClosingForReload, which makes the
// next openDatabase() REJECT for DB_RELOAD_LATCH_MS — correct before a reload,
// but wrong for a routine idle release where the very next access must reopen
// immediately. This is the idle-path twin: close + null the cache so the next
// openDatabase() starts a fresh open, nothing else. Safe with an in-flight
// transaction: IDB's db.close() defers the actual close until pending
// transactions commit; it only blocks NEW ones.
function releaseIdleDbConnection() {
    // Never yank the connection out from under an in-flight open — let that
    // open finish; the next idle check releases the resulting connection.
    if (_dbOpenPromise) return;
    if (db) {
        try { db.close(); } catch (e) {}
        db = null;
    }
}

// Called from the SW heartbeat alarm (background.js, every 30s). Releases the
// cached SW connection once it has been idle >= DB_SW_IDLE_CLOSE_MS. No-op in
// the page realm, when nothing is cached, or while an open is in flight.
function maybeReleaseIdleDbConnection() {
    if (!_dbIsWorkerRealm) return;
    if (!db || _dbOpenPromise) return;
    if (!_dbLastAccessAt || (Date.now() - _dbLastAccessAt) < DB_SW_IDLE_CLOSE_MS) return;
    releaseIdleDbConnection();
}

// True for the DOMException shapes a dead / force-closed connection throws:
// InvalidStateError, or the "database connection is closing" message some
// Chrome versions raise while teardown is in progress.
function _isDbConnectionError(e) {
    if (!e) return false;
    if (e.name === 'InvalidStateError') return true;
    // SLEEP-WEDGE: post-suspend backend failures also surface as UnknownError
    // (internal IDB error), AbortError (our transaction deadline aborts the
    // wedged transaction), or the deadline sentinel itself — all mean "drop
    // this connection and retry on a fresh one".
    if (e.name === 'UnknownError' || e.name === 'AbortError') return true;
    // Deadline sentinel from a WEDGED backend (the liveness probe also failed).
    // Deliberately NOT a bare name==='TimeoutError' check any more: the
    // BUSY-sentinel (_dbTxSlow — backend responsive, transaction just slow /
    // queued behind large writes) also carries name TimeoutError but must NOT
    // trigger the close-reopen-retry path, which would abort a progressing
    // write and re-do it from scratch — a livelock under write congestion.
    if (e._dbTxTimeout) return true;
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
// SLEEP-WEDGE: deadline for a single withStore transaction body. A
// post-suspend wedged backend accepts transaction()/getAll() calls whose
// callbacks then NEVER fire — nothing throws, so without a deadline the
// retry path never engages and the caller awaits forever. For READONLY
// transactions (and for READWRITE ones whose liveness probe also fails —
// see _probeBackendAlive) the deadline turns the silent hang into a
// connection-shaped error (TimeoutError + _dbTxTimeout, see
// _isDbConnectionError) so withStore drops the dead connection, reopens and
// retries once. A READWRITE transaction that blows the deadline while the
// backend still answers the probe is merely CONGESTED: it is left to commit
// in the background and the caller gets a non-connection error instead
// (TimeoutError + _dbTxSlow) — no abort, no retry, no livelock.
var DB_TX_DEADLINE_READ_MS = 15000;
var DB_TX_DEADLINE_WRITE_MS = 30000;

// BUSY-vs-WEDGE probe budget: when a READWRITE transaction blows its deadline,
// a tiny bounded readonly count() on the settings store decides whether the
// backend is actually wedged (probe hangs/errors → abort + connection-shaped
// sentinel → withStore reopens and retries) or merely CONGESTED — queued
// behind other transactions / a slow disk. A congested transaction is left
// running to commit in the background and the caller gets a NON-connection
// error, because the old unconditional abort+reopen+retry rolled back a
// progressing write only to re-issue it from scratch while new writes kept
// arriving: a livelock that kept resurfacing as recurring 30s timeouts on
// [chats]/[agent_runs] no matter how the connection lifecycle was hardened.
var DB_TX_PROBE_TIMEOUT_MS = 5000;
function _probeStoreAlive(database, storeName, cb) {
    var done = false;
    var timer = setTimeout(function() { finish(false); }, DB_TX_PROBE_TIMEOUT_MS);
    function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cb(ok);
    }
    try {
        var tx = database.transaction([storeName], 'readonly');
        var req = tx.objectStore(storeName).count();
        req.onsuccess = function() { finish(true); };
        req.onerror = function() { finish(false); };
    } catch (e) {
        finish(false);
    }
}
function _probeBackendAlive(database, cb) {
    _probeStoreAlive(database, settingsStoreName, cb);
}

// SCOPE-PROBE: the settings-store probe above answers "is the backend
// process alive?" — it says NOTHING about the stalled transaction's OWN
// store scope, because IDB queues are per-scope. A wedged [chats,
// chat_payloads] scope (zombie transaction from a killed realm — reload
// button, OS sleep, MV3 reap) therefore passed the probe and was classified
// "congestion, not a wedge" FOREVER: no recovery ever engaged and the
// extension froze until a Chrome restart. Track consecutive deadline
// blowouts where the scope itself also refuses to answer a tiny readonly
// probe; two in a row (≥60s of a scope that answers nothing) is treated as
// a wedge → connection-shaped error → withStore drops the connection and
// retries once on a fresh one, which clears connection-tied wedges
// automatically. Streaks reset on ANY completed transaction for the scope,
// so a genuinely long-but-progressing write can never be misclassified
// twice in a row.
var _scopeBlockStreak = {};

function _runTxWithDeadline(database, storeNames, mode, fn, deadlineOverrideMs) {
    return new Promise(function(resolve, reject) {
        // A sync throw here (dead connection) rejects this promise and is
        // classified by _isDbConnectionError in withStore, same as before.
        var tx = database.transaction(storeNames, mode);
        // SCOPE-PROBE: a LATE commit must also reset the wedge streak. When
        // the deadline path abandons a slow readwrite tx (rejectSlow — the tx
        // is left queued, settled=true), its eventual commit was invisible:
        // the fn-path streak reset below sits behind the settled guard, so
        // two slow-but-live saves in a row classified the scope WEDGED and
        // aborted a progressing write. A background commit proves the scope
        // is alive — register OUTSIDE the settled guard.
        try {
            tx.addEventListener('complete', function() {
                _scopeBlockStreak[storeNames.join(',')] = 0;
            });
        } catch (e) { /* defensive — the fn-path reset below still covers the settled case */ }
        // A caller may pass a shorter per-call deadline (withStore opts.deadlineMs)
        // — e.g. the boot chats hydration uses ~6s so first-try + one reopen-retry
        // (~12s) still fits under init's BOOT_HYDRATION_DEADLINE_MS budget.
        var deadlineMs = (deadlineOverrideMs > 0)
            ? deadlineOverrideMs
            : ((mode === 'readwrite') ? DB_TX_DEADLINE_WRITE_MS : DB_TX_DEADLINE_READ_MS);
        var settled = false;
        function rejectWedged() {
            // Best-effort abort — on a truly wedged backend even abort may
            // no-op, but the caller is already unblocked by the rejection.
            try { tx.abort(); } catch (e) {}
            var err = new Error('IndexedDB transaction on [' + storeNames + '] (' + mode + ') timed out after ' + deadlineMs + 'ms');
            err.name = 'TimeoutError';
            err._dbTxTimeout = true;
            reject(err);
        }
        var timer = setTimeout(function() {
            if (settled) return;
            // READONLY keeps the old fast-fail semantics: aborting a read
            // wastes no work, and the boot hydration path budgets on
            // deadline + one retry fitting under its own boot deadline.
            if (mode !== 'readwrite') {
                settled = true;
                rejectWedged();
                return;
            }
            // READWRITE: decide busy-vs-wedged before nuking the transaction.
            var scopeKey = storeNames.join(',');
            function rejectSlow(extra) {
                var slow = new Error('IndexedDB transaction on [' + storeNames + '] (' + mode + ') exceeded ' + deadlineMs + 'ms but the backend is responsive — congestion, not a wedge; the transaction was left to complete in the background' + (extra || ''));
                slow.name = 'TimeoutError';
                slow._dbTxSlow = true;
                reject(slow);
            }
            _probeBackendAlive(database, function(alive) {
                if (settled) return; // tx finished while probing
                if (!alive) { settled = true; rejectWedged(); return; }
                // SCOPE-PROBE: backend alive — but is THIS scope moving?
                // Settings answering while the stalled scope answers nothing
                // is the wedge signature the old classifier could not see.
                var scopeStore = storeNames[0];
                if (scopeStore === settingsStoreName) {
                    // Scope IS the probe store and it just answered — plain
                    // congestion, keep the old semantics.
                    settled = true;
                    _scopeBlockStreak[scopeKey] = 0;
                    rejectSlow();
                    return;
                }
                _probeStoreAlive(database, scopeStore, function(scopeAlive) {
                    if (settled) return; // tx finished while probing
                    settled = true;
                    if (scopeAlive) {
                        // Scope is serving requests — genuinely congested, not
                        // wedged. Do NOT abort — the transaction stays queued
                        // and commits in the background; error deliberately
                        // NOT connection-shaped (no _dbTxTimeout), so withStore
                        // neither drops the connection nor re-issues the write
                        // — see the livelock note on _probeBackendAlive.
                        _scopeBlockStreak[scopeKey] = 0;
                        rejectSlow();
                        return;
                    }
                    var streak = (_scopeBlockStreak[scopeKey] || 0) + 1;
                    _scopeBlockStreak[scopeKey] = streak;
                    if (streak >= 2) {
                        // Two consecutive deadline blowouts with a scope that
                        // answers nothing: treat as WEDGED. Connection-shaped
                        // rejection → withStore closes this connection and
                        // retries ONCE on a fresh one — that alone clears a
                        // connection-tied zombie (killed-realm transaction).
                        // If even the retry stalls, the caller's own backoff
                        // paces the next attempt, so this cannot livelock.
                        _scopeBlockStreak[scopeKey] = 0;
                        console.error('[indexeddb] scope [' + storeNames + '] blocked across ' + streak
                            + ' consecutive deadlines while the backend answers — WEDGED scope; dropping the connection and retrying on a fresh one. If this message repeats, storage is stuck at the browser level: restart Chrome (data on disk is safe).');
                        rejectWedged();
                        return;
                    }
                    console.warn('[indexeddb] scope [' + storeNames + '] did not answer a probe (strike ' + streak
                        + ' of 2) — leaving the transaction queued');
                    rejectSlow(' (scope probe unanswered — strike ' + streak + ' of 2 toward wedge recovery)');
                });
            });
        }, deadlineMs);
        Promise.resolve().then(function() { return fn(tx); }).then(function(value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // SCOPE-PROBE: a completed transaction proves the scope is moving.
            _scopeBlockStreak[storeNames.join(',')] = 0;
            resolve(value);
        }, function(e) {
            // Also swallows the late settlement of a body whose transaction
            // the deadline already aborted (settled guard) — no double-settle,
            // no unhandled rejection.
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
        });
    });
}

async function withStore(storeNames, mode, fn, opts) {
    // opts.deadlineMs (optional): override the per-transaction deadline for
    // BOTH the first attempt and the reopen-retry. Used by the boot chats
    // hydration to keep first-try + retry under the init boot deadline.
    var deadlineOverrideMs = (opts && opts.deadlineMs > 0) ? opts.deadlineMs : 0;
    var database = await openDatabase();
    try {
        return await _runTxWithDeadline(database, storeNames, mode, fn, deadlineOverrideMs);
    } catch (e) {
        if (!_isDbConnectionError(e)) throw e;
        console.warn('[indexeddb] transaction on ' + storeNames + ' hit a dead connection — reopening and retrying once', e);
        try { database.close(); } catch (e2) {}
        if (db === database) db = null;
        database = await openDatabase();
        return await _runTxWithDeadline(database, storeNames, mode, fn, deadlineOverrideMs);
    }
}

// =============================================================
// SLEEP-WEDGE resume probe.
// _isDbConnectionAlive above is a SYNC check of the renderer-side closed
// flag only — after a long suspend the browser-side backend can be wedged
// with the flag unset, so the sync probe passes while every actual request
// hangs forever. This is a REAL round-trip probe: a tiny read with its own
// deadline. On failure/hang it drops the cached connection so the next
// access reopens (itself bounded by the open watchdog). Called on page
// visibilitychange→visible (core/120-init.js) and on the SW 30s heartbeat
// alarm (src/platform/extension/background.js). Single-flight + throttled.
// =============================================================
var DB_RESUME_PROBE_TIMEOUT_MS = 5000;
var DB_RESUME_PROBE_MIN_INTERVAL_MS = 10000;
var _dbResumeProbeInFlight = false;
var _dbResumeProbeLastAt = 0;
function probeDbAfterResume() {
    if (_dbResumeProbeInFlight) return;
    var database = db;
    // Nothing cached: nothing to probe — the next openDatabase() starts a
    // fresh open, bounded by the open watchdog.
    if (!database) return;
    var now = Date.now();
    if (now - _dbResumeProbeLastAt < DB_RESUME_PROBE_MIN_INTERVAL_MS) return;
    _dbResumeProbeLastAt = now;
    _dbResumeProbeInFlight = true;
    var settled = false;
    var timer = null;
    function finish(ok, why, err) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        _dbResumeProbeInFlight = false;
        if (ok) return;
        console.warn('[indexeddb] resume probe failed (' + why + ') — dropping cached connection so the next access reopens', err || '');
        try { database.close(); } catch (e) {}
        if (db === database) db = null;
    }
    timer = setTimeout(function() { finish(false, 'timeout after ' + DB_RESUME_PROBE_TIMEOUT_MS + 'ms'); }, DB_RESUME_PROBE_TIMEOUT_MS);
    try {
        var tx = database.transaction([settingsStoreName], 'readonly');
        var req = tx.objectStore(settingsStoreName).count();
        req.onsuccess = function() { finish(true); };
        req.onerror = function() { finish(false, 'request error', req.error); };
    } catch (e) {
        finish(false, 'sync throw', e);
    }
}

// =============================================================
// MEMFIX: chat payload eviction + on-demand rehydration.
//
// Every chat used to stay FULLY hydrated in memory in BOTH realms
// (page + SW), including inline base64 screenshots/PDFs — ~150MB+
// per realm on screenshot-heavy histories. Fix: at load time each
// realm strips base64 payloads from non-recent chats (page keeps the
// newest 8 hydrated — post-PAYLOAD-STORE via an explicit hydration
// pass — the SW strips all; see loadChatsFromStorage in
// ui/070-dashboard-ui.js and worker/115-storage.js) and rehydrates
// on demand via ensureChatPayloads.
//
// PAYLOAD-STORE update: the durable copy of each payload now lives in
// the chat_payloads blob store (see extractChatPayloadsForPut); a chat
// RECORD's inline base64 survives only as a legacy fallback source
// (un-migrated rows, imported backups). The invariants below keep
// their exact shape — they now protect the legacy-inline records and
// keep saves cheap (an evicted chat's record hasn't changed, so
// re-putting it would be pure write amplification).
//
// INVARIANTS:
//   1. A chat with `_payloadsEvicted` is NEVER put back to IDB —
//      both realms' saveChatsToStorage put-loops skip it.
//   2. An evicted chat STAYS in the in-memory `chats` map — the
//      diff-save delete-pass removes IDB keys absent from `chats`,
//      so removing it from the map would delete the record.
//   3. Only messages carrying a file_id/screenshot_id are stripped —
//      anything else keeps its base64 (no id ⇒ no way to rehydrate).
//
// A missed hydration call site can only mean a temporarily missing
// image (self-heals on the next hydration), never data loss.
// =============================================================

// Strip inline base64 payloads from a chat, in place. Returns true if
// anything was stripped. Marks each stripped message/screenshot with
// `_b64Evicted` and the chat with `_payloadsEvicted`.
function stripChatPayloadsInPlace(chat) {
    if (!chat) return false;
    var stripped = false;
    if (Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var msg = chat.messages[i];
            // NEVER strip a message lacking file_id/screenshot_id — without an
            // id there is no pointer to rehydrate it from the IDB record.
            if (msg && (msg.file_id || msg.screenshot_id) && msg.base64) {
                delete msg.base64;
                msg._b64Evicted = true;
                stripped = true;
            }
        }
    }
    if (chat.screenshots) {
        var ssIds = Object.keys(chat.screenshots);
        for (var j = 0; j < ssIds.length; j++) {
            var ss = chat.screenshots[ssIds[j]];
            if (ss && ss.base64) {
                delete ss.base64;
                ss._b64Evicted = true;
                stripped = true;
            }
        }
    }
    if (stripped) chat._payloadsEvicted = true;
    return stripped;
}

// Recency timestamp used by the page loader to pick the K most recent
// chats to keep hydrated.
function chatPayloadRecencyTs(chat) {
    if (!chat) return 0;
    return Math.max(chat.updatedAt || 0, chat.createdAt || 0, chat.lastViewedAt || 0);
}

// =============================================================
// PAYLOAD-STORE persistence helpers (used by BOTH realms'
// saveChatsToStorage — worker/115-storage.js and ui/070-dashboard-ui.js).
//
// Chats records are persisted with every identifiable base64 payload
// stripped out; the payload bytes live once, immutably, in chat_payloads.
// Records carry the same flags the MEMFIX in-memory eviction uses
// (_b64Evicted per message/screenshot entry, _payloadsEvicted on the
// record), so a loaded record is indistinguishable from an evicted chat
// and hydrates through the one existing path: ensureChatPayloads.
// =============================================================

// Session cache of blob ids known durable in chat_payloads, so a hydrated
// chat's unchanged payloads are not re-put on every save. REBUILT from
// getAllKeys inside every save transaction (primeChatPayloadIdCache): a
// once-per-realm prime went stale when the SW's orphan sweep deleted rows
// after another realm had primed — that realm then skipped the blob puts
// for a re-imported chat against rows that no longer existed, committing
// a payload-stripped record with no payloads (silent loss). Extended only
// on transaction COMMIT (see queueChatPayloadPuts).
var _persistedPayloadIds = {};

// Build the chats-store record for a chat: a clone with every payload that
// carries a file_id/screenshot_id stripped and flagged, plus the blob rows
// those payloads become. The live in-memory chat is NEVER mutated (clones
// are per-container and per-entry; base64 strings are shared by reference,
// not copied). Payloads without an id keep their base64 inline in the
// record — no id means no blob key and no way to rehydrate (same rule as
// stripChatPayloadsInPlace).
function extractChatPayloadsForPut(chat) {
    var payloads = [];
    var now = Date.now();
    var evicted = !!chat._payloadsEvicted;
    var newMsgs = null;
    if (Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var m = chat.messages[i];
            if (!m) continue;
            var pid = m.file_id || m.screenshot_id;
            if (pid && m.base64) {
                if (!newMsgs) newMsgs = chat.messages.slice();
                var mClone = Object.assign({}, m);
                delete mClone.base64;
                mClone._b64Evicted = true;
                newMsgs[i] = mClone;
                payloads.push({ id: pid, base64: m.base64, at: now });
                evicted = true;
            } else if (m._b64Evicted) {
                // Already-evicted in memory: its blob is durable (or the
                // payload was already lost) — the record just keeps the flag.
                evicted = true;
            }
        }
    }
    var newSs = null;
    if (chat.screenshots) {
        var ssIds = Object.keys(chat.screenshots);
        for (var j = 0; j < ssIds.length; j++) {
            var ss = chat.screenshots[ssIds[j]];
            if (ss && ss.base64) {
                if (!newSs) newSs = Object.assign({}, chat.screenshots);
                var ssClone = Object.assign({}, ss);
                delete ssClone.base64;
                ssClone._b64Evicted = true;
                newSs[ssIds[j]] = ssClone;
                payloads.push({ id: ssIds[j], base64: ss.base64, at: now });
                evicted = true;
            } else if (ss && ss._b64Evicted) {
                evicted = true;
            }
        }
    }
    var record = chat;
    if (newMsgs || newSs || (evicted && !chat._payloadsEvicted)) {
        record = Object.assign({}, chat);
        if (newMsgs) record.messages = newMsgs;
        if (newSs) record.screenshots = newSs;
        if (evicted) record._payloadsEvicted = true;
    }
    return { record: record, payloads: payloads };
}

// Per-save refresh of the known-durable blob id cache from the store's
// keys, inside the caller's already-open transaction (which must include
// chat_payloads). Key-only read — never materializes base64. REPLACES the
// cache wholesale so ids whose rows were deleted since the last save (the
// SW's orphan sweep — possibly a different realm) drop out and their
// payloads get re-put instead of silently skipped. Calls cb() exactly
// once, on success or failure.
function primeChatPayloadIdCache(transaction, cb) {
    var req;
    try {
        req = transaction.objectStore(chatPayloadsStoreName).getAllKeys();
    } catch (e) {
        cb();
        return;
    }
    req.onsuccess = function() {
        var keys = req.result || [];
        var fresh = {};
        for (var i = 0; i < keys.length; i++) fresh[keys[i]] = true;
        _persistedPayloadIds = fresh;
        cb();
    };
    req.onerror = function(ev) {
        // Contain: must not abort the save tx. DROP the cache rather than
        // keep trusting it — over-putting is idempotent (same id, same
        // bytes); skipping against a deleted row is silent payload loss.
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        _persistedPayloadIds = {};
        cb();
    };
}

// Queue puts for the blob rows a record extraction produced, skipping ids
// already known durable. Each request settles through `settle` (same
// optimistic semantics as the chat-record puts around it: an error bubbles,
// aborts the tx, and the tx.onabort safety-net resolves the save; the next
// save repairs). Returns the number of requests issued so the caller can
// add them to its pending count BEFORE any can settle. Ids are merged into
// the session cache only on transaction COMMIT — a request-level success
// can still be rolled back by a later abort, and caching a rolled-back id
// would skip the re-put forever (silent payload loss on eviction).
function queueChatPayloadPuts(transaction, payloads, settle) {
    if (!payloads || !payloads.length) return 0;
    var store = transaction.objectStore(chatPayloadsStoreName);
    var txIds = [];
    for (var i = 0; i < payloads.length; i++) {
        var p = payloads[i];
        if (!p || !p.id || !p.base64) continue;
        if (_persistedPayloadIds[p.id]) continue;
        var req = store.put(p);
        req.onsuccess = settle;
        req.onerror = settle;
        txIds.push(p.id);
    }
    if (txIds.length) {
        transaction.addEventListener('complete', function() {
            for (var k = 0; k < txIds.length; k++) _persistedPayloadIds[txIds[k]] = true;
        });
    }
    return txIds.length;
}

// Boot-time orphan sweep: delete chat_payloads rows referenced by NO chat.
// Reference set = every file_id/screenshot_id in every in-memory chat
// (ids survive eviction, so a stripped chat still contributes its refs) —
// which is why this runs only in a realm that has hydrated ALL chats (the
// SW; called from worker/190-entry.js after boot hydration) and is gated on
// _chatsHydrated. The 24h age gate (via the `at` index, key-cursor only —
// values never materialized) protects the cross-realm race where another
// realm commits a record+blob after this realm hydrated its chats map.
var DB_PAYLOAD_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
function sweepOrphanChatPayloads() {
    if (typeof _chatsHydrated === 'undefined' || !_chatsHydrated) return Promise.resolve(0);
    if (typeof chats === 'undefined' || !chats) return Promise.resolve(0);
    var referenced = {};
    Object.keys(chats).forEach(function(cid) {
        var c = chats[cid];
        if (!c) return;
        if (Array.isArray(c.messages)) {
            for (var i = 0; i < c.messages.length; i++) {
                var m = c.messages[i];
                if (!m) continue;
                if (m.file_id) referenced[m.file_id] = true;
                if (m.screenshot_id) referenced[m.screenshot_id] = true;
            }
        }
        if (c.screenshots) {
            Object.keys(c.screenshots).forEach(function(k) { referenced[k] = true; });
        }
    });
    var cutoff = Date.now() - DB_PAYLOAD_GC_MIN_AGE_MS;
    return withStore([chatPayloadsStoreName], 'readwrite', function(transaction) {
        return new Promise(function(resolve) {
            var store = transaction.objectStore(chatPayloadsStoreName);
            var deleted = 0;
            var cursorReq;
            try {
                cursorReq = store.index('at').openKeyCursor(IDBKeyRange.upperBound(cutoff));
            } catch (e) {
                resolve(0);
                return;
            }
            cursorReq.onsuccess = function(ev) {
                var cur = ev.target.result;
                if (!cur) { resolve(deleted); return; }
                if (!referenced[cur.primaryKey]) {
                    try {
                        store.delete(cur.primaryKey);
                        delete _persistedPayloadIds[cur.primaryKey];
                        deleted++;
                    } catch (e2) {}
                }
                cur.continue();
            };
            cursorReq.onerror = function() { resolve(deleted); };
        });
    }).catch(function(e) {
        console.warn('[indexeddb] chat_payloads orphan sweep failed', e);
        return 0;
    });
}

// Per-chatId single-flight guard: concurrent callers share one hydration.
var _chatHydrationPromises = {};

// Rehydrate a payload-evicted chat. Idempotent — no-op unless
// chats[chatId]._payloadsEvicted. NEVER rejects: a failed hydration logs,
// keeps the eviction flags set (so the save guard keeps skipping this chat)
// and resolves; the next caller retries.
// PAYLOAD-STORE: the primary source is the chat_payloads blob store
// (one get per flagged id, single readonly tx). The chat RECORD's inline
// base64 remains the fallback for legacy records — chats never re-saved
// since v16 (migration is lazy, at save time) or imported from a backup.
async function ensureChatPayloads(chatId) {
    var chat = (typeof chats !== 'undefined' && chats) ? chats[chatId] : null;
    if (!chat || !chat._payloadsEvicted) return;
    if (_chatHydrationPromises[chatId]) return _chatHydrationPromises[chatId];
    var p = (async function() {
        try {
            // Collect the flagged payload ids BEFORE the async fetch, from the
            // live chat object (ids are stable across realms; message indexes
            // can drift during a run).
            var wantIds = {};
            if (Array.isArray(chat.messages)) {
                for (var wi = 0; wi < chat.messages.length; wi++) {
                    var wm = chat.messages[wi];
                    if (wm && wm._b64Evicted) {
                        var wid = wm.file_id || wm.screenshot_id;
                        if (wid) wantIds[wid] = true;
                    }
                }
            }
            if (chat.screenshots) {
                Object.keys(chat.screenshots).forEach(function(wk) {
                    if (chat.screenshots[wk] && chat.screenshots[wk]._b64Evicted) wantIds[wk] = true;
                });
            }
            var record = null;
            var blobById = {};
            // Ids whose blob GET errored (contained below): the row may well
            // exist, so their flags must be KEPT for a later retry —
            // "errored" is not "absent".
            var failedIds = {};
            await withStore([chatStoreName, chatPayloadsStoreName], 'readonly', function(transaction) {
                return new Promise(function(resolve, reject) {
                    var pending = 1; // the record get
                    function done() { if (--pending === 0) resolve(); }
                    var request = transaction.objectStore(chatStoreName).get(chatId);
                    request.onsuccess = function() { record = request.result || null; done(); };
                    request.onerror = function() { reject(request.error); };
                    var blobStore = transaction.objectStore(chatPayloadsStoreName);
                    Object.keys(wantIds).forEach(function(id) {
                        pending++;
                        var breq = blobStore.get(id);
                        breq.onsuccess = function() {
                            if (breq.result && breq.result.base64) blobById[id] = breq.result.base64;
                            done();
                        };
                        breq.onerror = function(bev) {
                            // Best-effort per blob: contain the error so it can't
                            // abort the tx; the record-inline fallback may still
                            // cover this id. Remember the failure so the flag
                            // handling below keeps this id retryable.
                            if (bev && typeof bev.preventDefault === 'function') bev.preventDefault();
                            failedIds[id] = true;
                            done();
                        };
                    });
                });
            });
            // Re-read the live object — it may have been replaced (e.g. the SW
            // adopted a panel snapshot) while the IDB reads were in flight.
            chat = chats[chatId];
            if (!chat) return;
            // Legacy fallback: index the record's remaining INLINE payloads by
            // id, then let blob rows win.
            var byId = {};
            if (record && Array.isArray(record.messages)) {
                for (var ri = 0; ri < record.messages.length; ri++) {
                    var rm = record.messages[ri];
                    if (!rm || !rm.base64) continue;
                    var rid = rm.file_id || rm.screenshot_id;
                    if (rid) byId[rid] = rm.base64;
                }
            }
            Object.keys(blobById).forEach(function(bid) { byId[bid] = blobById[bid]; });
            // Set when an id's flag is deliberately KEPT (its blob get
            // errored): the chat must then stay _payloadsEvicted so the save
            // guard keeps skipping it and the next hydration retries.
            var keptAny = false;
            if (Array.isArray(chat.messages)) {
                for (var mi = 0; mi < chat.messages.length; mi++) {
                    var m = chat.messages[mi];
                    if (!m || !m._b64Evicted) continue;
                    var fid = m.file_id || m.screenshot_id;
                    if (fid && byId[fid]) {
                        m.base64 = byId[fid];
                    } else if (record && record.messages && record.messages[mi]
                               && record.messages[mi].base64
                               && (record.messages[mi].file_id || record.messages[mi].screenshot_id) === fid) {
                        // Fallback: same index, same id (defensive — byId
                        // should already have matched).
                        m.base64 = record.messages[mi].base64;
                    } else if (fid && failedIds[fid]) {
                        // The blob GET errored — the row may exist. Keep the
                        // flag so a later hydration retries; clearing it here
                        // stranded the payload forever (nothing rehydrates an
                        // unflagged message).
                        keptAny = true;
                        continue;
                    } else if (fid && !wantIds[fid]) {
                        // NEVER-FETCHED: the live chat object was replaced
                        // while the reads were in flight (e.g. the SW adopted
                        // a panel snapshot) and this id was not in the
                        // pre-await wantIds set — no GET was even attempted
                        // for it. Clearing here would strand the payload
                        // forever; keep the flag (and, via keptAny, the
                        // chat-level _payloadsEvicted) so the next hydration
                        // pass fetches it.
                        keptAny = true;
                        continue;
                    }
                    // Clear the flag otherwise: if neither the blob store nor
                    // the record has a payload for this id AND the reads did
                    // not error, the durable copy never had it — keeping the
                    // flag would only block persistence forever.
                    delete m._b64Evicted;
                }
            }
            if (chat.screenshots) {
                var sIds = Object.keys(chat.screenshots);
                for (var si = 0; si < sIds.length; si++) {
                    var cs = chat.screenshots[sIds[si]];
                    if (!cs || !cs._b64Evicted) continue;
                    var rs = (record && record.screenshots) ? record.screenshots[sIds[si]] : null;
                    var sb64 = blobById[sIds[si]] || (rs && rs.base64);
                    if (sb64) {
                        cs.base64 = sb64;
                    } else if (failedIds[sIds[si]]) {
                        // Same as above: errored ≠ absent — keep it retryable.
                        keptAny = true;
                        continue;
                    } else if (!wantIds[sIds[si]]) {
                        // NEVER-FETCHED (live chat replaced mid-await): this
                        // id was not attempted this pass — keep the flag so
                        // the next hydration fetches it.
                        keptAny = true;
                        continue;
                    }
                    delete cs._b64Evicted;
                }
            }
            // Hydrated (or nothing durable to hydrate from) — clear the flag so
            // the chat persists again; the next save re-extracts its payloads.
            // If any id was kept retryable, the chat stays evicted: durable
            // copies stay intact, the save guard keeps skipping it, and the
            // next ensureChatPayloads call retries just the flagged ids.
            if (!keptAny) delete chat._payloadsEvicted;
        } catch (e) {
            // Keep the flags: the save guard keeps skipping this chat, the
            // durable copies stay intact, and the next call retries.
            console.error('[indexeddb] ensureChatPayloads failed for', chatId, e);
        } finally {
            delete _chatHydrationPromises[chatId];
        }
    })();
    _chatHydrationPromises[chatId] = p;
    return p;
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
                    // sonnet-5, gpt-5.2 → gpt-5.6-sol (chain-collapsed through the
                    // retired gpt-5.5 default), Gemini 3 Flash Preview →
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
                        { to: 'gpt-5.6-sol', from: { name: 'gpt-5.2', apiKey: '', model: 'openai/gpt-5.2', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 400000, maxTokens: 128000, effort: 'low' } },
                        { to: 'gpt-5.6-sol', from: { name: 'gpt-5.5', apiKey: '', model: 'openai/gpt-5.5', endpointId: 'openrouter', effort: 'low' } },
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
