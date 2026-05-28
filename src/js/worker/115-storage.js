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

async function saveChatsToStorage() {
    if (_workerSavePending) {
        _workerSavePendingAgain = true;
        return;
    }
    _workerSavePending = true;
    try {
        var database = await openDatabase();
        var transaction = database.transaction([chatStoreName], 'readwrite');
        var store = transaction.objectStore(chatStoreName);
        var clearRequest = store.clear();
        await new Promise(function(resolve) {
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
                        addRequest.onerror = function() { pending--; };
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
        if (_workerSavePendingAgain) {
            _workerSavePendingAgain = false;
            // Run another save to catch the changes that came in mid-write.
            setTimeout(saveChatsToStorage, 0);
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
                    try { rebuildFileIndexAll(); } catch (e) {}
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
