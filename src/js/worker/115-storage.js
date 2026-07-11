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
        await withStore([chatStoreName], 'readwrite', function(transaction) {
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
                    // MEMFIX: NEVER put a payload-evicted chat — its in-memory
                    // copy is missing base64 blobs and putting it would overwrite
                    // the only durable copy in IDB. It stays in `desired` so the
                    // delete-pass above cannot remove its record either.
                    if (desired[id]._payloadsEvicted) return;
                    pending++;
                    var putRequest = store.put(desired[id]);
                    putRequest.onsuccess = settleOne;
                    putRequest.onerror = settleOne;
                });
                if (pending === 0) resolve();
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
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var results = request.result || [];
                chats = {};
                results.forEach(function(chat) {
                    if (chat.messages && chat.messages.length > 0) {
                        // MEMFIX: the SW strips inline base64 payloads from EVERY
                        // chat at load (K=0 — the SW has no UI; run entry points
                        // rehydrate via ensureChatPayloads in core/130-indexeddb.js
                        // before a chat is run/persisted). Evicted chats stay in
                        // `chats` (delete-pass safety) and are skipped by the
                        // put-loop in saveChatsToStorage above (put safety).
                        if (typeof stripChatPayloadsInPlace === 'function') {
                            try { stripChatPayloadsInPlace(chat); } catch (e) {}
                        }
                        chats[chat.id] = chat;
                    }
                });
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
                console.error('[worker-storage] load failed', request.error);
                resolve();
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
