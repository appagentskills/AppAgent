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
// CONGESTION-BACKOFF: when a save blows the 30s write deadline, withStore
// leaves the transaction queued ("congestion, not a wedge") and rejects.
// Immediately launching the follow-up save queued a NEW transaction behind
// the abandoned one — so once a single save exceeded the deadline, every
// later save timed out too and the queue never drained (writes landed
// minutes late or died with the realm; awaited saves at tool boundaries
// took 30s+ each). After a timeout, hold off before the next transaction
// so the backlog can commit.
var _workerSaveBackoffUntil = 0;
var WORKER_SAVE_TIMEOUT_BACKOFF_MS = 15000;
// WS-1 (B18): callers that AWAIT a save (e.g. _handlePanelSendMessage at
// port-bridge:~391 before runAgent, edit_html before a screenshot) must know
// their mutation is committed before proceeding. The page copy parks awaiters on
// a waiters list; the SW copy dropped it (returned undefined on single-flight),
// so an awaited save resolved BEFORE a capturing save committed — a lost user
// message on SW eviction / a stale edit_html→screenshot read. Restored here.
var _workerSaveWaiters = [];
// WIPE-GUARD-3: cumulative per-boot delete budget. The per-save cap below
// (wipe-guard-2) rate-limits rather than blocks — under a persistently
// partial in-memory map, 5 real chats would still be deleted at EVERY save
// (saves fire at every tool boundary), draining the store over a long
// incident. Budget total deletes per realm boot; once exhausted, stop
// deleting entirely until a fresh load rebuilds the map. Keep in sync with
// the page mirror in ui/070-dashboard-ui.js.
var _wipeGuardDeletedSinceLoad = 0;
var WIPE_GUARD_MAX_DELETES_PER_BOOT = 25;

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
        // CONGESTION-BACKOFF: honour the hold-off armed by a previous
        // timed-out save. Callers arriving during the wait coalesce via the
        // single-flight gate above; the save that finally runs reads `chats`
        // live inside the transaction, so it captures their mutations too.
        var _boWait = _workerSaveBackoffUntil - Date.now();
        if (_boWait > 0) await new Promise(function(r) { setTimeout(r, _boWait); });
        var _saveT0 = Date.now();
        var _putRecords = 0, _putBlobs = 0;
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
                // WIPE-GUARD-2: cap the delete-pass. A partially-hydrated map
                // (observed live: SW holding 3 chats while the store held 535
                // — run-adopted chats only) turned every save into a ~532-
                // record MASS-DELETE transaction: the 30s scope-holder AND an
                // active data-destruction mechanism, survivable only because
                // most of those transactions timed out or died uncommitted.
                // Legit flows CAN exceed a handful (sub-agent GC batches in
                // core/097-sub-agent-registry.js routinely backlog >5 chat
                // rows), so the cap must NOT skip the pass entirely — that
                // permanently disabled deletion: deleted chats resurrected on
                // reload and the store grew unbounded. Instead delete a
                // BOUNDED batch per save (first 5), so a legit backlog drains
                // over successive saves while a partial-map incident is still
                // capped at 5 rows per transaction instead of a mass-delete.
                var _delKeys = [];
                existingKeys.forEach(function(key) {
                    if (!Object.prototype.hasOwnProperty.call(desired, key)) _delKeys.push(key);
                });
                if (_delKeys.length > 5) {
                    console.warn('[worker-storage] delete-pass CAPPED (wipe-guard-2): '
                        + _delKeys.length + ' of ' + existingKeys.length
                        + ' stored chats are absent from memory (' + Object.keys(desired).length
                        + ' held) — deleting only 5 this save; a legit backlog drains over the'
                        + ' next saves, a partial in-memory map stays bounded');
                    _delKeys = _delKeys.slice(0, 5);
                }
                // WIPE-GUARD-3: enforce the per-boot cumulative budget (see
                // declaration above) — trim the batch to the budget still
                // remaining instead of dropping it wholesale, so a partial
                // budget is spent, not wasted (F2-2). When the budget is fully
                // spent the slice is empty, so deletes still halt.
                if (_delKeys.length && _wipeGuardDeletedSinceLoad + _delKeys.length > WIPE_GUARD_MAX_DELETES_PER_BOOT) {
                    console.warn('[worker-storage] delete-pass TRIMMED (wipe-guard-3): '
                        + _wipeGuardDeletedSinceLoad + ' of a ' + WIPE_GUARD_MAX_DELETES_PER_BOOT
                        + ' per-boot delete budget already used since load — trimming this save to the'
                        + ' remaining budget (a reload/full rehydration rebuilds the map)');
                    _delKeys = _delKeys.slice(0, Math.max(0, WIPE_GUARD_MAX_DELETES_PER_BOOT - _wipeGuardDeletedSinceLoad));
                }
                _wipeGuardDeletedSinceLoad += _delKeys.length;
                _delKeys.forEach(function(key) {
                    pending++;
                    var delRequest = store.delete(key);
                    delRequest.onsuccess = settleOne;
                    delRequest.onerror = settleOne;
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
                    var _nBlobs = queueChatPayloadPuts(transaction, extracted.payloads, settleOne);
                    pending += _nBlobs;
                    _putBlobs += _nBlobs;
                    pending++;
                    _putRecords++;
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
        // Committed: clear any armed backoff and surface slow-but-successful
        // saves so future congestion is diagnosable (which realm, how big).
        _workerSaveBackoffUntil = 0;
        var _saveDur = Date.now() - _saveT0;
        if (_saveDur > 2000) {
            console.warn('[worker-storage] slow save: ' + _saveDur + 'ms ('
                + _putRecords + ' records, ' + _putBlobs + ' payload blobs) — IDB congested');
        }
    } catch (e) {
        console.error('[worker-storage] save failed', e);
        // CONGESTION-BACKOFF: the timed-out transaction is still queued and
        // will commit in the background — hold the next save back so it
        // drains instead of stacking another transaction on the jam.
        if (e && e.name === 'TimeoutError') {
            _workerSaveBackoffUntil = Date.now() + WORKER_SAVE_TIMEOUT_BACKOFF_MS;
            console.warn('[worker-storage] backing off ' + (WORKER_SAVE_TIMEOUT_BACKOFF_MS / 1000)
                + 's before the next save so the queued transaction can drain');
        }
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

// PERSIST-BUSY (root-cause fix, 2026-07): consulted by background.js's
// maybeCloseOffscreenIfIdle before tearing down the offscreen keep-alive.
// Closing the offscreen doc lets Chrome reap the service worker — THIS
// realm, the one executing every IndexedDB write — about 30s later. Doing
// that while a transaction was in flight killed the write uncommitted
// (chats visibly missing from the store) and, per the SLEEP-WEDGE class,
// could wedge Chromium's IDB backend for the whole origin until a Chrome
// restart. The old idle check consulted ONLY runningChatIds, so under save
// congestion the reaper fired mid-write on every idle cycle for weeks.
// Returns a short reason string while persistence is busy, null when the
// realm is safe to reap.
function persistenceBusyReason() {
    try {
        if (_workerSavePending) return 'save in flight';
        if (_workerSavePendingAgain) return 'follow-up save queued';
        if (_workerSaveWaiters.length) return _workerSaveWaiters.length + ' save waiter(s) undrained';
        if (_workerSaveBackoffUntil > Date.now()) return 'timed-out save still draining (backoff armed)';
        if (_legacyPayloadMigrationBusy) return 'legacy payload migration in flight';
        if (typeof _ckptChannels === 'object' && _ckptChannels && Object.keys(_ckptChannels).length) return 'checkpoint write in flight';
        if (typeof _drainPendingWakesInFlight !== 'undefined' && _drainPendingWakesInFlight) return 'pending-wake drain in flight';
    } catch (e) {
        // Unreadable state — err on the side of keeping the realm alive.
        return 'busy-check threw: ' + (e && e.message || e);
    }
    return null;
}

async function loadChatsFromStorage() {
    try {
        // withStore (core/130-indexeddb.js, shared into this bundle): retries
        // ONCE on a fresh connection if the cached one was force-closed.
        var _loadT0 = Date.now();
        return await withStore([chatStoreName], 'readonly', function(transaction) {
        var store = transaction.objectStore(chatStoreName);
        var request = store.getAll();
        return new Promise(function(resolve, reject) {
            request.onsuccess = function() {
                var results = request.result || [];
                chats = {};
                // WIPE-GUARD-3 (mirrors ui/070-dashboard-ui.js): a full
                // rehydration rebuilds the chats map from IDB, so the per-boot
                // delete budget starts fresh here — without this reset the budget
                // was never replenished and all chat-row deletes silently halted
                // after WIPE_GUARD_MAX_DELETES_PER_BOOT cumulative deletes in one
                // realm lifetime (F2-1).
                _wipeGuardDeletedSinceLoad = 0;
                _legacyPayloadMigrationQueue = [];
                // STORE-ACCT: one line per boot sizing the store — record count,
                // read duration, and how much inline base64 is still riding in
                // records (the legacy tail the trickle migrator is burning down).
                // This is the number that decides whether slowness is data-size
                // or transaction-queue congestion.
                var _acctB64 = 0, _acctTopB64 = 0, _acctTopId = null;
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
                                var _cb64 = 0;
                                for (var _ai = 0; _ai < chat.messages.length; _ai++) {
                                    var _am = chat.messages[_ai];
                                    if (_am && _am.base64) _cb64 += _am.base64.length;
                                }
                                if (chat.screenshots) {
                                    for (var _ak in chat.screenshots) {
                                        var _as = chat.screenshots[_ak];
                                        if (_as && _as.base64) _cb64 += _as.base64.length;
                                    }
                                }
                                if (_cb64) {
                                    _acctB64 += _cb64;
                                    if (_cb64 > _acctTopB64) { _acctTopB64 = _cb64; _acctTopId = chat.id; }
                                }
                                if (stripChatPayloadsInPlace(chat)) _legacyPayloadMigrationQueue.push(chat.id);
                                // WRITE-AMP root fix: strip only sets
                                // _payloadsEvicted when it stripped base64, so a
                                // pure-TEXT chat (most of the store) never got the
                                // flag and the save put-loop re-wrote its UNCHANGED
                                // record on EVERY save — with hundreds of chats,
                                // tens of MB per tool boundary, the engine of the
                                // chronic [chats, chat_payloads] congestion. At
                                // load the in-memory copy is identical to the disk
                                // record by definition, so mark EVERY chat evicted
                                // ("nothing new to persist"). Every mutation path
                                // (run gate, send, wake drain, resume, migration)
                                // already calls ensureChatPayloads first, which
                                // clears the flag (single cheap get for text-only
                                // chats) and re-admits the chat to the put set.
                                chat._payloadsEvicted = true;
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
                console.log('[worker-storage] loaded ' + Object.keys(chats).length + ' chats in '
                    + (Date.now() - _loadT0) + 'ms — '
                    + (_acctB64
                        ? ('~' + Math.round(_acctB64 * 0.75 / 1048576) + 'MB inline base64 still in records ('
                            + _legacyPayloadMigrationQueue.length + ' queued for migration, largest '
                            + _acctTopId + ' ~' + Math.round(_acctTopB64 * 0.75 / 1048576) + 'MB)')
                        : 'records are v16-clean (no inline base64)'));
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
    // MIGRATION-YIELD: migrating a legacy chat hydrates its ENTIRE payload
    // set and writes every blob in ONE [chats, chat_payloads] readwrite
    // transaction — for a screenshot-heavy legacy chat that is a tens-of-MB
    // transaction on the hottest store pair in the extension. Fired from the
    // 30s heartbeat while a run was active, it queued ahead of the loop's
    // tool-boundary saves and the page's boot getAll — starving BOTH (tool
    // calls waited minutes; the panel's 6s boot reads timed out into
    // degraded mode). This is background hygiene: run it ONLY when the
    // agent is idle and the save channel is healthy.
    if (typeof runningChatIds !== 'undefined' && runningChatIds
        && Object.keys(runningChatIds).length > 0) return;
    if (_workerSaveBackoffUntil > Date.now()) return;
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
