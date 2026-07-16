// =============================================================
// AppAgent offscreen runtime — chat storage helpers.
//
// The page bundle's loadChatsFromStorage / saveChatsToStorage live
// in src/js/ui/070-dashboard-ui.js (DOM-touching — calls
// updateStorageIndicator on save). The worker bundle needs its own
// versions that read/write the SAME IDB chats store but don't touch
// the DOM.
//
// Load order: 115 = post-shared so the shared bundle's openDatabase
// (in core/130-indexeddb.js) and rebuildFileIndexAll (in
// tools/040-file-store.js) are defined. The agent loop only calls
// saveChatsToStorage at runtime from inside functions, so a 1xx
// post-shared declaration is in scope by the time it's invoked.
// =============================================================

// Single-flight save: collapse rapid bursts (e.g. the agent loop's
// saveChatsToStorage call after every tool result) into one IDB
// transaction. Mirrors page-side dashboard-ui.js semantics so the
// behavior is identical from the chat-data POV.
var _workerSavePending = false;
var _workerSavePendingAgain = false;
// WS-1 (B18): callers that AWAIT a save (e.g. _handlePanelSendMessage at
// port-bridge:~391 before runAgent, edit_html before a screenshot) must know
// their mutation is committed before proceeding. The page copy parks awaiters on
// a waiters list; the SW copy dropped it (returned undefined on single-flight),
// so an awaited save resolved BEFORE a capturing save committed — a lost user
// message on SW eviction / a stale edit_html→screenshot read. Restored here.
var _workerSaveWaiters = [];

// WIPE-GUARD: mirrors the page-side flag in ui/070-dashboard-ui.js. Saves are
// forbidden until this worker context has successfully hydrated `chats` from
// IDB — otherwise a save from an empty/unhydrated `chats` global would erase
// every stored chat (the SW boot's safe() wrapper swallows load failures, so
// without this gate a broken boot silently wipes the store on first save).
var _chatsHydrated = false;

async function saveChatsToStorage() {
    // Park this caller on a waiter resolved only after a save capturing the
    // CURRENT state commits — never resolved by an in-flight save that started
    // before this caller's mutation. Mirrors page-side dashboard-ui.js (minus the
    // DOM storage indicator, which the worker must not touch).
    // WIPE-GUARD: never persist before a successful hydration. Callers get a
    // resolved promise and proceed; persistence is skipped, loudly.
    if (!_chatsHydrated) {
        console.error('[worker-storage] saveChatsToStorage blocked: chats not hydrated — refusing to persist to avoid wiping stored chats');
        return;
    }
    var _commit = new Promise(function(res) { _workerSaveWaiters.push(res); });
    if (_workerSavePending) {
        _workerSavePendingAgain = true;
        return _commit;
    }
    _workerSavePending = true;
    try {
        // withStore (core/130-indexeddb.js, shared into this bundle): retries
        // ONCE on a fresh connection if the cached one was force-closed by
        // the browser. Safe to retry: the diff-save re-derives everything
        // from in-memory state.
        // PAYLOAD-STORE: the tx spans chat_payloads too — each hydrated chat
        // is put as a payload-STRIPPED record (extractChatPayloadsForPut) and
        // its new payloads become blob rows in the same atomic transaction,
        // so a record never commits without its payloads being durable.
        await withStore([chatStoreName, chatPayloadsStoreName], 'readwrite', function(transaction) {
        var store = transaction.objectStore(chatStoreName);
        // WIPE-GUARD: diff save — no store.clear(). Delete only ids that
        // vanished from memory, upsert the rest.
        var keysRequest = store.getAllKeys();
        return new Promise(function(_resolve) {
            // WS-1 (B16/B17): settle-guard so the commit promise resolves EXACTLY
            // once and can't wedge. A put-error can ABORT the whole txn; without the
            // onabort safety-net AND a zero-crossing resolve on the put-error path,
            // `pending` never reaches 0, the await hangs forever, _workerSavePending
            // stays true and the parked _workerSaveWaiters never drain — silently
            // killing ALL SW persistence (this runs after every tool result) and
            // hanging the awaited caller. onerror resolves are OPTIMISTIC: a
            // rolled-back write is repaired by the next full save.
            var _settled = false;
            function resolve() { if (_settled) return; _settled = true; _resolve(); }
            transaction.onabort = function() { resolve(); };
            keysRequest.onsuccess = function() {
                var existingKeys = keysRequest.result || [];
                // PAYLOAD-STORE: refresh the known-durable blob id cache once per
                // realm (key-only read) so unchanged payloads aren't re-put.
                primeChatPayloadIdCache(transaction, function() {
                var desired = {};
                Object.keys(chats).forEach(function(id) {
                    var c = chats[id];
                    if (c && c.messages && c.messages.length > 0) desired[id] = c;
                });
                var pending = 0;
                // B16 semantics preserved: every request (delete or put, success or
                // error) settles through here so a final errored request still
                // resolves — else the await hangs and wedges every future save.
                function settleOne() {
                    pending--;
                    if (pending === 0) resolve();
                }
                existingKeys.forEach(function(key) {
                    if (!Object.prototype.hasOwnProperty.call(desired, key)) {
                        pending++;
                        var delRequest = store.delete(key);
                        delRequest.onsuccess = settleOne;
                        delRequest.onerror = settleOne;
                    }
                });
                Object.keys(desired).forEach(function(id) {
                    // MEMFIX: NEVER put a payload-evicted chat. Post-PAYLOAD-STORE
                    // this protects legacy records whose payloads are still inline
                    // (never migrated / imported) and skips pure write
                    // amplification (an evicted chat's record hasn't changed).
                    // It stays in `desired` so the delete-pass above cannot
                    // remove its record either.
                    if (desired[id]._payloadsEvicted) return;
                    // PAYLOAD-STORE: strip payloads into blob rows; the record
                    // put carries flags instead of base64. All requests are
                    // issued synchronously here, so `pending` cannot zero-cross
                    // before the loop finishes.
                    var extracted = extractChatPayloadsForPut(desired[id]);
                    pending += queueChatPayloadPuts(transaction, extracted.payloads, settleOne);
                    pending++;
                    var putRequest = store.put(extracted.record);
                    putRequest.onsuccess = settleOne;
                    putRequest.onerror = settleOne;
                });
                if (pending === 0) resolve();
                }); // end primeChatPayloadIdCache
            };
            keysRequest.onerror = function() { resolve(); };
        });
        }); // end withStore fn
    } catch (e) {
        console.error('[worker-storage] save failed', e);
    } finally {
        _workerSavePending = false;
        // If another save was requested mid-write, run it now — IT captures the
        // newest state and drains the accumulated waiters when it completes, so do
        // NOT drain here (a stale save must not resolve a later caller's waiter).
        if (_workerSavePendingAgain) {
            _workerSavePendingAgain = false;
            saveChatsToStorage();
        } else {
            var _w = _workerSaveWaiters;
            _workerSaveWaiters = [];
            _w.forEach(function(r) { try { r(); } catch (e) {} });
        }
    }
}

async function loadChatsFromStorage() {
    try {
        // withStore (core/130-indexeddb.js, shared into this bundle): retries
        // ONCE on a fresh connection if the cached one was force-closed.
        return await withStore([chatStoreName], 'readonly', function(transaction) {
        var store = transaction.objectStore(chatStoreName);
        var request = store.getAll();
        return new Promise(function(resolve, reject) {
            request.onsuccess = function() {
                var results = request.result || [];
                chats = {};
                _legacyPayloadMigrationQueue = [];
                results.forEach(function(chat) {
                    if (chat.messages && chat.messages.length > 0) {
                        // MEMFIX: the SW strips inline base64 payloads from EVERY
                        // chat at load (K=0 — the SW has no UI; run entry points
                        // rehydrate via ensureChatPayloads in core/130-indexeddb.js
                        // before a chat is run/persisted). Evicted chats stay in
                        // `chats` (delete-pass safety) and are skipped by the
                        // put-loop in saveChatsToStorage above (put safety).
                        // LEGACY-MIGRATE: strip returning true means the RECORD
                        // itself still held inline base64 — a legacy-inline row
                        // (pre-v16 or an imported backup). Queue it for the
                        // heartbeat trickle migrator below so the store converges
                        // to the v16 shape instead of re-materializing these
                        // payloads in this getAll on every SW boot.
                        if (typeof stripChatPayloadsInPlace === 'function') {
                            try {
                                if (stripChatPayloadsInPlace(chat)) _legacyPayloadMigrationQueue.push(chat.id);
                            } catch (e) {}
                        }
                        chats[chat.id] = chat;
                    }
                });
                // Rehydrate per-chat pause flags from the persisted record field
                // (chat.pausedByUser — see setChatPausedPersistent in
                // core/030-config.js) so a user-paused chat stays paused across an
                // SW restart: the loop's `while (!isChatPaused)` gate reads THIS
                // realm's pausedChats copy. Cleared on resume/toggle-pause(false),
                // on run-agent for an idle chat, and on a fresh user send.
                try {
                    if (typeof pausedChats !== 'undefined') {
                        Object.keys(chats).forEach(function(_pcid) {
                            if (chats[_pcid] && chats[_pcid].pausedByUser === true) pausedChats[_pcid] = true;
                        });
                    }
                } catch (e) { /* rehydration is best-effort */ }
                if (typeof rebuildFileIndexAll === 'function') {
                    // WS-T1: surface a boot file-index rebuild failure instead of
                    // swallowing it — a silent failure here leaves file_id lookups
                    // (attachments, screenshots) broken with no diagnostic.
                    try { rebuildFileIndexAll(); } catch (e) { console.error('[worker-storage] rebuildFileIndexAll failed', e); }
                }
                _chatsHydrated = true;
                resolve();
            };
            request.onerror = function() {
                // SLEEP-WEDGE: REJECT (do not resolve-empty) so withStore's
                // connection-error retry engages on a fresh connection. The
                // outer catch below logs only after the retry has also failed.
                reject(request.error || new Error('chats getAll failed'));
            };
        });
        }); // end withStore fn
    } catch (e) {
        // Post-retry failure — no DOM in this realm, so log loudly; the page
        // realm surfaces its own user-visible notice, and the wipe-guard
        // (_chatsHydrated stays false) keeps saves blocked so nothing is lost.
        console.error('[worker-storage] open failed (post-retry) — chat storage unavailable in the worker realm', e);
    }
}

// Stub for updateStorageIndicator. The page bundle uses it to update
// a status pill; offscreen has no UI. No-op.
function updateStorageIndicator() { /* offscreen: no UI */ }

// =============================================================
// LEGACY-MIGRATE: heartbeat-driven trickle migration of legacy-inline
// chat records (payload base64 still inside the chats record — pre-v16
// rows and imported backups).
//
// The v16 migration is lazy-at-save, so a chat the user never reopens
// keeps its inline payloads in its record forever — and this realm's
// boot getAll() above re-materializes ALL of that base64 on EVERY SW
// start (MV3 restarts the SW constantly): a permanent per-boot memory
// spike proportional to the legacy tail, the same class of blow-up that
// crashed the abandoned eager in-upgrade migration. This migrator makes
// the store converge instead: called from the 30s 'agent-heartbeat'
// alarm (background.js), it migrates ONE chat per tick — hydrate
// (ensureChatPayloads) → save (extracts payloads into chat_payloads and
// puts the record stripped, one ordinary transaction) → re-evict — so
// peak memory is one chat's payloads and every transaction stays small.
// =============================================================
var _legacyPayloadMigrationQueue = [];
var _legacyPayloadMigrationBusy = false;
var _legacyPayloadMigrationRetries = {};
var LEGACY_PAYLOAD_MIGRATION_MAX_RETRIES = 3;

async function migrateNextLegacyChatPayloads() {
    if (_legacyPayloadMigrationBusy) return;
    if (!_chatsHydrated || !_legacyPayloadMigrationQueue.length) return;
    _legacyPayloadMigrationBusy = true;
    try {
        var chatId = _legacyPayloadMigrationQueue.shift();
        var chat = chats[chatId];
        // Deleted since boot — nothing to migrate.
        if (!chat) return;
        // Hydrated by a run since boot: its own at-boundary saves already
        // migrate it (the put-loop extracts any non-evicted chat) — drop it.
        if (!chat._payloadsEvicted) return;
        // Never hydrate-then-re-evict under an active run — the loop needs
        // the payloads it hydrated at run entry to stay in memory. Re-queue
        // for a later tick.
        if ((typeof isChatRunning === 'function' && isChatRunning(chatId))
            || (typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard[chatId])) {
            _legacyPayloadMigrationQueue.push(chatId);
            return;
        }
        await ensureChatPayloads(chatId);
        chat = chats[chatId];
        if (!chat) return;
        if (chat._payloadsEvicted) {
            // Hydration failed (flags kept) — retry on a later tick, capped so
            // a permanently unreadable chat can't wedge the queue forever.
            var n = (_legacyPayloadMigrationRetries[chatId] || 0) + 1;
            if (n <= LEGACY_PAYLOAD_MIGRATION_MAX_RETRIES) {
                _legacyPayloadMigrationRetries[chatId] = n;
                _legacyPayloadMigrationQueue.push(chatId);
            } else {
                console.warn('[worker-storage] legacy payload migration gave up on chat', chatId);
            }
            return;
        }
        // The actual migration: the save extracts this chat's payloads into
        // chat_payloads blob rows and puts its record STRIPPED, atomically.
        await saveChatsToStorage();
        // Re-evict (K=0 in this realm) — unless a run started on it while the
        // save was in flight, in which case it must stay hydrated for the loop.
        if (!((typeof isChatRunning === 'function' && isChatRunning(chatId))
              || (typeof _runCleanupGuard !== 'undefined' && _runCleanupGuard[chatId]))) {
            try { stripChatPayloadsInPlace(chats[chatId]); } catch (e) {}
        }
        console.log('[worker-storage] migrated legacy inline payloads for chat ' + chatId
            + ' (' + _legacyPayloadMigrationQueue.length + ' left)');
    } catch (e) {
        console.warn('[worker-storage] legacy payload migration tick failed', e);
    } finally {
        _legacyPayloadMigrationBusy = false;
    }
}
