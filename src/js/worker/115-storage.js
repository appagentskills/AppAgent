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

async function saveChatsToStorage() {
    // Park this caller on a waiter resolved only after a save capturing the
    // CURRENT state commits — never resolved by an in-flight save that started
    // before this caller's mutation. Mirrors page-side dashboard-ui.js (minus the
    // DOM storage indicator, which the worker must not touch).
    var _commit = new Promise(function(res) { _workerSaveWaiters.push(res); });
    if (_workerSavePending) {
        _workerSavePendingAgain = true;
        return _commit;
    }
    _workerSavePending = true;
    try {
        var database = await openDatabase();
        var transaction = database.transaction([chatStoreName], 'readwrite');
        var store = transaction.objectStore(chatStoreName);
        var clearRequest = store.clear();
        await new Promise(function(_resolve) {
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
            clearRequest.onsuccess = function() {
                var chatIds = Object.keys(chats);
                var pending = 0;
                for (var i = 0; i < chatIds.length; i++) {
                    var chat = chats[chatIds[i]];
                    if (chat.messages && chat.messages.length > 0) {
                        pending++;
                        var addRequest = store.put(chat);
                        addRequest.onsuccess = function() {
                            pending--;
                            if (pending === 0) resolve();
                        };
                        addRequest.onerror = function() {
                            // B16: mirror onsuccess — a final errored put must still
                            // settle, else the await hangs and wedges every future save.
                            pending--;
                            if (pending === 0) resolve();
                        };
                    }
                }
                if (pending === 0) resolve();
            };
            clearRequest.onerror = function() { resolve(); };
        });
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
        var database = await openDatabase();
        var transaction = database.transaction([chatStoreName], 'readonly');
        var store = transaction.objectStore(chatStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var results = request.result || [];
                chats = {};
                results.forEach(function(chat) {
                    if (chat.messages && chat.messages.length > 0) {
                        chats[chat.id] = chat;
                    }
                });
                if (typeof rebuildFileIndexAll === 'function') {
                    // WS-T1: surface a boot file-index rebuild failure instead of
                    // swallowing it — a silent failure here leaves file_id lookups
                    // (attachments, screenshots) broken with no diagnostic.
                    try { rebuildFileIndexAll(); } catch (e) { console.error('[worker-storage] rebuildFileIndexAll failed', e); }
                }
                resolve();
            };
            request.onerror = function() {
                console.error('[worker-storage] load failed', request.error);
                resolve();
            };
        });
    } catch (e) {
        console.error('[worker-storage] open failed', e);
    }
}

// Stub for updateStorageIndicator. The page bundle uses it to update
// a status pill; offscreen has no UI. No-op.
function updateStorageIndicator() { /* offscreen: no UI */ }
