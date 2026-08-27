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
// PR 4 (RFC addendum §5): the wipe-guard-2/3 per-boot delete caps and the
// SW-side known-chat-id set are RETIRED — dead since PR 3 made saves
// upsert-only (no delete-pass consumed them any more). The hydration
// save-gate below is a DIFFERENT guard and stays.

// WIPE-GUARD: mirrors the page-side flag in ui/070-dashboard-ui.js. Saves are
// forbidden until this worker context has successfully hydrated `chats` from
// IDB — otherwise a save from an empty/unhydrated `chats` global would erase
// every stored chat (the SW boot's safe() wrapper swallows load failures, so
// without this gate a broken boot silently wipes the store on first save).
var _chatsHydrated = false;

// SAVE-DROP RESCUE (runaway-spawn incident): single-flight per chat. When the
// evicted-put guard below skips a chat that was MUTATED while evicted
// (chat._dirtyWhileEvicted — stamped by recordToolResult in
// app/030-agent-loop.js), hydrate its payloads back (clears _payloadsEvicted)
// and re-run a save so the mutation becomes durable instead of silently
// dropped — a dropped tool_result left the tool_use permanently "pending" and
// the pending-tool replay re-executed it on every restart. Never rejects.
var _evictedRescueInFlight = {};
function _rescueDirtyEvictedChat(id) {
    if (_evictedRescueInFlight[id]) return;
    if (typeof ensureChatPayloads !== 'function') return;
    _evictedRescueInFlight[id] = true;
    console.warn('[worker-storage] evicted chat ' + id + ' has unsaved mutations — hydrating to persist them');
    Promise.resolve().then(function() { return ensureChatPayloads(id); })
        .then(function() {
            var c = (typeof chats !== 'undefined') ? chats[id] : null;
            if (c) delete c._dirtyWhileEvicted;
            return saveChatsToStorage();
        })
        .catch(function(e) { console.warn('[worker-storage] evicted-chat rescue failed for ' + id, e); })
        .then(function() { delete _evictedRescueInFlight[id]; });
}

// FLUX-4C (chat-meta lane, put-time backstop): these seven fields are
// SW-CANONICAL. Panels no longer write them — every page writer dispatches
// 'chat-meta-update' (dispatchChatMeta, app/045-agent-port-bridge-page.js) and
// the SW's lane handler (worker/130-port-bridge.js 'chat-meta-update') is the
// single applier + persister: it applies to chats[id] (timestamps max-wins,
// flags last-dispatch-wins) and saves, or — for a chat this SW does not hold —
// read-merge-writes the stored record directly (_swChatMetaRMW) and buffers the
// fields in _swChatMetaPendingByChatId until an adopt/update-chat/send-message
// overlay (_swOverlayChatMeta) folds them into the in-memory record.
// This function is the put-time backstop for the one thing the lane cannot see:
// a record on disk that is NEWER or MORE DEFINED than the copy being put — the
// SW's in-memory record may predate a lane RMW that landed on disk while the
// chat was not held, or predate another SW generation's writes.
//   • Timestamps: keep the NEWEST of the two (monotonic; updatedAt is
//     legitimately stamped by the SW at run finish too, so a fresher in-memory
//     stamp still wins).
//   • Flags: the stored value is used ONLY to fill a record-side gap
//     (undefined) — a DEFINED value on the record being put is a lane-applied
//     decision, including deliberate defined-null / explicit-false clears, and
//     must beat disk. That is why every path where a page snapshot replaces
//     chats[id] has to run _swOverlayChatMeta first: without it a stale defined
//     flag laundered in from a panel replica would win here (F3).
// Returns the record to put; NEVER mutates `record` in place — it may BE the
// live chats[id] object (extractChatPayloadsForPut returns the live object
// when nothing needed stripping).
// CHAT_META_TS_FIELDS / CHAT_META_FLAG_FIELDS are declared ONCE in
// core/030-config.js (WORKER_SHARED_FILES loads it ahead of this 1xx worker
// file; flux audit: layering — the per-realm twin copies were collapsed, and
// the build fails on any re-declaration).
function _preservePageChatFields(record, stored) {
    if (!record || !stored) return record;
    var out = record;
    function claim() { if (out === record) out = Object.assign({}, record); return out; }
    // FLUX-T1 (title lane): `title` is a VALUE riding its paired
    // `titleUpdatedAt` stamp (in CHAT_META_TS_FIELDS, so the TS loop below
    // advances the stamp itself). The stored pair wins only when STRICTLY
    // newer — an equal stamp is the same lane generation and the in-memory
    // record is the lane-applied arbiter decision. `titleProvisional` rides
    // the winning pair: true → set, absent → cleared. Runs BEFORE the TS
    // loop so the compare reads the record's pre-merge stamp.
    if (typeof stored.titleUpdatedAt === 'number' && isFinite(stored.titleUpdatedAt)
        && typeof stored.title === 'string' && stored.title
        && stored.titleUpdatedAt > (out.titleUpdatedAt || 0)) {
        claim().title = stored.title;
        if (stored.titleProvisional === true) claim().titleProvisional = true;
        else if (out.titleProvisional !== undefined) delete claim().titleProvisional;
    }
    CHAT_META_TS_FIELDS.forEach(function(f) {
        // FLUX-6 (#799 review, defensive): pair atomicity — never advance
        // titleUpdatedAt from a stored row carrying a bare stamp without its
        // title value (a bare stamp would make every later legit rename with
        // an older stamp lose the compare forever).
        if (f === 'titleUpdatedAt' && !(typeof stored.title === 'string' && stored.title)) return;
        var sv = stored[f] || 0;
        if (sv && sv > (out[f] || 0)) claim()[f] = sv;
    });
    CHAT_META_FLAG_FIELDS.forEach(function(f) {
        if (out[f] === undefined && stored[f] !== undefined) claim()[f] = stored[f];
    });
    // FLUX-QW7 → FLUX-6: the displays per-id union moved into the SHARED
    // non-lane put merge (_mergeChatRowForPut, core/130-indexeddb.js), which
    // the put site below chains after this lane preserver — one
    // implementation for both realms instead of an SW-only inline block.
    return out;
}

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
        // UPSERT-ONLY (RFC addendum Invariant D, PR 3): the save NEVER deletes.
        // The absence-diff delete-pass that used to live here — "stored key ∉
        // in-memory `chats` ⇒ delete the row" — was the root cause of the
        // chat-deletion data-loss class: neither realm's map is authoritative
        // over the store, so "I never knew about this chat" was
        // indistinguishable from "this chat was deleted" (observed live: store
        // count 904 → 900). Rows now leave the store ONLY through deleteChatRow
        // (core/130-indexeddb.js) presenting an explicit reason + on-disk
        // precondition: user deletes via the _pendingDeletes retry lane below,
        // sub-agent GC via core/097-sub-agent-registry.js, 0-message rows via
        // gcEmptyChatRows at SW boot (worker/190-entry.js), wipe-all via
        // ui/130-data-management.js. Absence from memory means NOTHING.
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
            // PAYLOAD-STORE: refresh the known-durable blob id cache once per
            // realm (key-only read) so unchanged payloads aren't re-put. Its
            // getAllKeys request is issued SYNCHRONOUSLY here, so the fresh
            // transaction has a pending request and cannot auto-commit before
            // the put loop below queues its own.
            primeChatPayloadIdCache(transaction, function() {
                var desired = {};
                Object.keys(chats).forEach(function(id) {
                    var c = chats[id];
                    if (c && c.messages && c.messages.length > 0) desired[id] = c;
                });
                var pending = 0;
                // B16 semantics preserved: every request (success or error)
                // settles through here so a final errored request still
                // resolves — else the await hangs and wedges every future save.
                function settleOne() {
                    pending--;
                    if (pending === 0) resolve();
                }
                // PR 3: the absence-diff delete-pass that lived here is GONE
                // (PR 4 retired its caps and known-id sets). Explicit user
                // deletes are handled the moment the tombstone arrives, by
                // scheduleChatRowDelete below — not at save time.
                Object.keys(desired).forEach(function(id) {
                    // MEMFIX: NEVER put a payload-evicted chat. Post-PAYLOAD-STORE
                    // this protects legacy records whose payloads are still inline
                    // (never migrated / imported) and skips pure write
                    // amplification (an evicted chat's record hasn't changed).
                    // It stays in `desired` so the delete-pass above cannot
                    // remove its record either.
                    if (desired[id]._payloadsEvicted) {
                        // SAVE-DROP RESCUE: the skip below is correct for THIS
                        // transaction (putting a stripped record would clobber
                        // inline payloads), but if the chat was mutated while
                        // evicted the write would be silently lost — queue an
                        // out-of-band hydrate→save so it lands durably.
                        if (desired[id]._dirtyWhileEvicted) _rescueDirtyEvictedChat(id);
                        return;
                    }
                    // PAYLOAD-STORE: strip payloads into blob rows; the record
                    // put carries flags instead of base64. The blob puts and
                    // the record GET are issued synchronously in this loop;
                    // the record put is issued from the get's handler, which
                    // bumps `pending` BEFORE settling the get's own slot — so
                    // `pending` cannot zero-cross before the loop finishes.
                    var extracted = extractChatPayloadsForPut(desired[id]);
                    var _nBlobs = queueChatPayloadPuts(transaction, extracted.payloads, settleOne);
                    pending += _nBlobs;
                    _putBlobs += _nBlobs;
                    // FLUX-QW3: read-merge-write — preserve the page-owned
                    // whitelist from the stored record instead of a blind
                    // full-record put (_preservePageChatFields above). A
                    // failed get falls back to putting the un-merged record
                    // (preventDefault contains the request error so it can't
                    // abort the whole tx).
                    pending++;
                    _putRecords++;
                    (function(_rec, _getReq) {
                        function _issuePut(stored) {
                            // FLUX-4/5b (stale-put resurrection window): this
                            // put is issued ASYNC from the get's callback — the
                            // chat that was live when `desired` was captured
                            // may have been DELETED while the get was in
                            // flight (page deleteChatRow committed → this
                            // get returned undefined → the old unconditional
                            // put re-created the deleted row from the SW's
                            // hydrated copy; a tombstone re-delete self-healed
                            // ONLY if this SW survived). Consult the delete
                            // authority NOW and DROP the put when the id is
                            // deleted: a tombstone (parked in chats[] by the
                            // 'update-chat' branch, or on-disk), an armed
                            // _pendingDeletes retry entry, or a granted
                            // user-delete ledger entry
                            // (_chatDeleteLedgerGranted, core/130-indexeddb.js
                            // — covers the post-verified-gone window after the
                            // parked tombstone is dropped).
                            var _delNow = false;
                            try {
                                var _liveNow = chats[id];
                                _delNow = (_liveNow && _liveNow._deleted === true)
                                    || (stored && stored._deleted === true)
                                    || !!_pendingDeletes[id]
                                    || (typeof _chatDeleteLedgerGranted === 'function' && _chatDeleteLedgerGranted(id));
                            } catch (eDel) {}
                            if (_delNow) {
                                console.warn('[worker-storage] dropping put of chat ' + id + ' — deleted while the save was in flight');
                                settleOne(); // settle the get's slot; no put issued
                                return;
                            }
                            pending++;
                            // FLUX-6: chain the SHARED non-lane merge (messages
                            // append-tail preservation, displays union, future-
                            // field fill-gap — core/130-indexeddb.js) after the
                            // lane preserver, against the SAME stored row.
                            var putRequest = store.put(_mergeChatRowForPut(_preservePageChatFields(_rec, stored), stored));
                            putRequest.onsuccess = settleOne;
                            putRequest.onerror = settleOne;
                            settleOne(); // settle the get's slot
                        }
                        if (!_getReq) { _issuePut(null); return; }
                        _getReq.onsuccess = function() { _issuePut(_getReq.result); };
                        _getReq.onerror = function(ev) {
                            if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
                            _issuePut(null);
                        };
                    })(extracted.record, (function() { try { return store.get(id); } catch (eGet) { return null; } })());
                });
                if (pending === 0) resolve();
            }); // end primeChatPayloadIdCache
        });
        }); // end withStore fn
        // Committed: clear any armed backoff and surface slow-but-successful
        // saves so future congestion is diagnosable (which realm, how big).
        _workerSaveBackoffUntil = 0;
        // MEMFIX runtime sweep: the commit above made every non-evicted
        // chat's record + payload blobs durable, so re-strip cold chats
        // now (K=0, mirroring this realm's boot strip) — without this,
        // run-adopted hydrated chats stayed hydrated for the SW's whole
        // lifetime. Running chats / cleanup-window chats are skipped
        // inside the sweep (core/130-indexeddb.js).
        try { if (typeof sweepColdChatPayloads === 'function') sweepColdChatPayloads(0); } catch (eSweep) {}
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

// EXPLICIT-DELETE (chat-delete durability, mirrors ui/070-dashboard-ui.js):
// targeted single-id removal of ONE chat row. Thin wrapper over the SHARED
// delete primitive deleteChatRow (core/130-indexeddb.js — RFC addendum §2.3),
// which owns the transaction, the ON-DISK precondition check, the
// abort=failure settle discipline and the delete ledger.
// CALL SITE: the `_deleted` tombstone branch of the 'update-chat' handler in
// worker/130-port-bridge.js arms scheduleChatRowDelete (below) the moment the
// page reports a user delete, so the row leaves IDB immediately — and a
// transient failure is retried by the bounded _pendingDeletes lane. That tombstone is also parked in
// this realm's `chats` map, which is what the 'user-delete' precondition
// verifies (alongside the userInitiated signal passed below).
// BLOB CLEANUP IS PAGE-OWNED and enforced by the primitive via
// _dbIsWorkerRealm: this realm's `chats` map is run-adopted-only (never a
// complete view of the store), so it can never prove a blob unreferenced.
// The page-side twin owns chat_payloads cleanup; sweepOrphanChatPayloads
// (core/130-indexeddb.js) is the backstop.
// CALLER CONTRACT: this wrapper asserts userInitiated:true unconditionally,
// which is the operative 'user-delete' signal (core/130-indexeddb.js:1230 —
// the on-disk/parked tombstone arms above it cannot fire in this realm on the
// page-delete path). So this function is effectively "delete any chat row, no
// questions asked" INSIDE the SW (FLUX-4/5a: no longer — the arm now demands
// corroboration: hadRecord / an armed _pendingDeletes entry / a granted
// ledger entry, so a bare id does not suffice). It has exactly ONE legitimate caller: the
// _pendingDeletes retry lane below (_attemptPendingChatDelete), armed by the
// `_deleted` tombstone branch of 'update-chat' in worker/130-port-bridge.js,
// which HAS the user's tombstone. Any NEW caller must NOT reuse this function
// — add a reason + precondition to CHAT_ROW_DELETE_PRECONDITIONS
// (core/130-indexeddb.js) instead.
async function deleteChatFromDB(chatId, chatSnapshot) {
    if (!chatId) return false;
    // Surface (but never act on) payload ids a caller passes — see above.
    try {
        var _ignored = Object.keys(_chatPayloadIdsFor(chatSnapshot || (typeof chats !== 'undefined' ? chats[chatId] : null))).length;
        if (_ignored) {
            console.warn('[worker-storage] explicit delete: NOT reaping ' + _ignored
                + ' payload id(s) of chat ' + chatId
                + ' — this realm cannot prove them unreferenced; blob cleanup is page-owned');
        }
    } catch (eGate) {}
    if (typeof deleteChatRow !== 'function') {
        console.error('[worker-storage] explicit delete: deleteChatRow (core/130-indexeddb.js) unavailable — chat '
            + chatId + ' NOT deleted');
        return false;
    }
    // NOTE: no `record` in the evidence — the primitive would only use it for
    // blob reaping, which this realm must never do.
    return await deleteChatRow(chatId, 'user-delete', {
        userInitiated: true,
        via: 'sw-tombstone',
        hadRecord: !!chatSnapshot,
        // Operator hint: an aborted delete is retried by the bounded
        // _pendingDeletes lane below (PR 3 removed the save-time retry).
        retryHint: 'the _pendingDeletes retry lane (worker/115-storage.js) retries it'
    });
}

// EXPLICIT-DELETE RETRY (RFC addendum §2.4, PR 3): _pendingDeletes drives a
// bounded retry of the targeted tombstone delete. Before PR 3, a tombstone
// whose targeted delete failed was retried by the explicit-delete arm of
// EVERY subsequent save's delete-pass; saves are upsert-only now, so this
// ledger is what makes a user delete durable against a transient IDB failure
// (congestion, force-closed connection, aborted tx).
//   • The tombstone stays PARKED in `chats` until the row is VERIFIED gone:
//     every SW read of chats[id] keeps seeing "deleted", and the chat-meta
//     lane's memory guard (worker/130-port-bridge.js `_cmChat._deleted`)
//     keeps refusing RMW writes for it (RFC addendum §4.1).
//   • On verified-gone (deleteChatRow resolved true — includes the idempotent
//     already-absent case): drop the ledger entry AND the parked tombstone.
//   • On final failure: log LOUDLY and keep the tombstone parked — reads in
//     this SW generation still see "deleted", but the row is still on disk
//     and resurfaces after an SW restart unless the page-side bounded re-run
//     (ui/170-chat-management.js) lands it. PR 5's persisted ledger is the
//     permanent fix.
//   • Lost on MV3 eviction like the tombstone itself — same recovery story.
var _pendingDeletes = Object.create(null); // chatId -> { reason, tries, at }
var PENDING_CHAT_DELETE_MAX_TRIES = 3;
var PENDING_CHAT_DELETE_BACKOFF_MS = 2000; // doubles per retry: 2s, 4s

function scheduleChatRowDelete(chatId, chatSnapshot) {
    if (!chatId) return Promise.resolve(false);
    if (_pendingDeletes[chatId]) {
        // A retry chain is already driving this id — let it finish (the
        // duplicate tombstone changes nothing: same id, same reason).
        return Promise.resolve(false);
    }
    _pendingDeletes[chatId] = { reason: 'user-delete', tries: 0, at: Date.now() };
    return _attemptPendingChatDelete(chatId, chatSnapshot);
}

function _attemptPendingChatDelete(chatId, chatSnapshot) {
    var entry = _pendingDeletes[chatId];
    if (!entry) return Promise.resolve(false);
    entry.tries++;
    entry.at = Date.now();
    function _finish(ok) {
        if (ok) {
            delete _pendingDeletes[chatId];
            // Row verified gone → drop the parked tombstone (§2.4). Guarded:
            // only a TOMBSTONE may be dropped — never a live record that
            // re-adopted this id while the delete was in flight.
            try {
                if (typeof chats !== 'undefined' && chats && chats[chatId] && chats[chatId]._deleted === true) {
                    delete chats[chatId];
                }
            } catch (eDrop) {}
            return true;
        }
        if (entry.tries >= PENDING_CHAT_DELETE_MAX_TRIES) {
            delete _pendingDeletes[chatId];
            console.error('[chat-delete] tombstone delete of chat ' + chatId + ' FAILED after '
                + entry.tries + ' attempts — the row is STILL ON DISK. The tombstone stays parked in'
                + ' memory (this SW generation keeps treating the chat as deleted), but the row will'
                + ' resurface after an SW restart unless the page-side retry'
                + ' (ui/170-chat-management.js) lands it. Inspect dumpChatDeleteLedger().');
            return false;
        }
        var _delay = PENDING_CHAT_DELETE_BACKOFF_MS * Math.pow(2, entry.tries - 1);
        console.warn('[chat-delete] tombstone delete of chat ' + chatId + ' did not complete (attempt '
            + entry.tries + '/' + PENDING_CHAT_DELETE_MAX_TRIES + ') — retrying in ' + _delay + 'ms');
        setTimeout(function() { _attemptPendingChatDelete(chatId, chatSnapshot); }, _delay);
        return false;
    }
    try {
        return Promise.resolve(deleteChatFromDB(chatId, chatSnapshot)).then(_finish, function(e) {
            console.error('[chat-delete] tombstone delete threw for chat ' + chatId, e);
            return _finish(false);
        });
    } catch (eSync) {
        console.error('[chat-delete] tombstone delete threw for chat ' + chatId, eSync);
        return Promise.resolve(_finish(false));
    }
}

// Payload ids (file_id / screenshot_id) a chat record references. Ids survive
// payload eviction, so a stripped record still reports them.
function _chatPayloadIdsFor(chat) {
    var ids = {};
    if (!chat) return ids;
    if (Array.isArray(chat.messages)) {
        for (var i = 0; i < chat.messages.length; i++) {
            var m = chat.messages[i];
            if (!m) continue;
            if (m.file_id) ids[m.file_id] = true;
            if (m.screenshot_id) ids[m.screenshot_id] = true;
        }
    }
    if (chat.screenshots) Object.keys(chat.screenshots).forEach(function(k) { ids[k] = true; });
    return ids;
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
                // FLUX-H2 (boot-adopt preservation): do NOT wholesale-replace
                // `chats`. This loader runs once per SW life (worker/190-entry.js)
                // and `chats` starts {}, so any entry present here is a panel
                // snapshot adopted while this getAll was in flight (the pre-gate
                // run-agent adopt, the ungated update-chat put, or a parked
                // tombstone — worker/130-port-bridge.js). The old `chats = {}`
                // replace dropped those adopts, losing the freshly-typed user
                // turn the snapshot carried. Disk rows fill in around them below;
                // on id collision the adopted record wins and disk-only meta is
                // pulled forward via _swOverlayChatMeta (same prev=SW-copy
                // semantics as a post-boot adopt overlay).
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
                        // `chats` (they are live chats; saves are upsert-only) and are skipped by the
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
                        var _rowId = chat.id;
                        var _adoptedPreBoot = chats[_rowId];
                        if (_adoptedPreBoot) {
                            // FLUX-H2: keep the fresher adopted record and replay
                            // the post-boot adopt ordering — overlay the DISK
                            // copy as `prev` (timestamps max-wins, disk DEFINED
                            // flags win; boot-window dispatches are re-asserted
                            // by the pending fold below, keeping last-dispatch-
                            // wins intact). A parked tombstone is kept untouched:
                            // the delete lane owns it and its meta must never be
                            // resurrected from the doomed disk row.
                            if (!_adoptedPreBoot._deleted && typeof _swOverlayChatMeta === 'function') {
                                try { _swOverlayChatMeta(chat, _adoptedPreBoot); } catch (eOv) { /* best-effort — adopt stays */ }
                            }
                            chat = _adoptedPreBoot;
                        }
                        chats[_rowId] = chat;
                    }
                });
                // FLUX-H3 (boot-window lane fold): fold chat-meta dispatches
                // buffered in _swChatMetaPendingByChatId into the hydrated
                // records, with the lane's own merge (_swApplyChatMetaFields:
                // ts max-wins, flags last-wins). getAll is a SNAPSHOT — a
                // 'chat-meta-update' landing mid-window RMWed the STORED row
                // (durable) and buffered its fields, but the rows read above
                // can predate that RMW; without this fold the stale disk value
                // wins in memory, a later adopt's `chats[id] || pending` prefers
                // the stale held record and deletes the pending entry unfolded,
                // and the next save writes the stale flag back over the RMWed
                // row (_preservePageChatFields lets a DEFINED record flag beat
                // disk). Entries are NOT deleted here: adopt sites still
                // consume them for never-held chats, and the serialized RMW
                // chain reads the map at execution time — re-folding is
                // idempotent (same values, max-wins/last-wins).
                try {
                    if (typeof _swChatMetaPendingByChatId === 'object' && _swChatMetaPendingByChatId
                        && typeof _swApplyChatMetaFields === 'function') {
                        Object.keys(_swChatMetaPendingByChatId).forEach(function(_pmCid) {
                            if (chats[_pmCid] && !chats[_pmCid]._deleted) {
                                _swApplyChatMetaFields(chats[_pmCid], _swChatMetaPendingByChatId[_pmCid]);
                            }
                        });
                    }
                } catch (eFold) { /* fold is best-effort — the RMW already persisted the fields */ }
                // Rehydrate per-chat pause flags from the persisted record field
                // (chat.pausedByUser — see setChatPausedPersistent in
                // core/030-config.js) so a user-paused chat stays paused across an
                // SW restart: the loop's `while (!isChatPaused)` gate reads THIS
                // realm's pausedChats copy. Cleared on resume/toggle-pause(false),
                // on run-agent for an idle chat, and on a fresh user send.
                try {
                    if (typeof pausedChats !== 'undefined') {
                        Object.keys(chats).forEach(function(_pcid) {
                            if (chats[_pcid] && chats[_pcid].pausedByUser === true) {
                                pausedChats[_pcid] = true;
                                // FLUX-P1: pausedChatIds is a derived cache of the
                                // lane's pausedByUser flag — fold it here too so the
                                // worker/020-page-stubs.js isChatPaused fallback
                                // agrees after an SW restart.
                                if (typeof pausedChatIds !== 'undefined') pausedChatIds[_pcid] = true;
                            }
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
