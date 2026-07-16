(function() {
    var params = new URLSearchParams(location.search);
    var fileId = params.get('id');
    var fileName = params.get('name') || 'download';
    var card = document.getElementById('card');
    var log = [];

    if (!fileId) return show('No file ID provided.', true);

    var dbNames = ['AppAgentDB', 'iframe_AppAgentDB'];

    tryDatabases(dbNames, 0);

    function tryDatabases(names, idx) {
        if (idx >= names.length) {
            return show('File not found: ' + fileId + '<div class="debug">' + log.join('\n') + '</div>', true);
        }
        var dbName = names[idx];
        log.push('Trying DB: ' + dbName);
        tryDatabase(dbName).then(function(file) {
            if (file) {
                triggerDownload(file.data, file.mime, fileName);
                show('Downloaded: <span class="filename">' + esc(fileName) + '</span>');
            } else {
                tryDatabases(names, idx + 1);
            }
        }).catch(function(e) {
            log.push('Error on ' + dbName + ': ' + e.message);
            tryDatabases(names, idx + 1);
        });
    }

    function tryDatabase(dbName) {
        return openDB(dbName).then(function(db) {
            var stores = Array.from(db.objectStoreNames);
            log.push('  Stores: ' + stores.join(', '));
            return findInWorkspaceFiles(db, fileId)
                .then(function(result) {
                    if (result) log.push('  Found in workspace_files');
                    return result || findInChats(db, fileId);
                })
                .then(function(result) {
                    if (result) log.push('  Found in chats');
                    db.close();
                    return result;
                });
        });
    }

    function openDB(name) {
        return new Promise(function(resolve, reject) {
            // No explicit version: a read-only consumer must attach to whatever
            // version exists. Pinning a stale version throws VersionError once the
            // app DB migrates past it, which broke every download.
            var req = indexedDB.open(name);
            req.onerror = function() { reject(new Error('DB open failed: ' + (req.error || 'unknown'))); };
            req.onsuccess = function() { resolve(req.result); };
            req.onupgradeneeded = function(e) {
                log.push('  onupgradeneeded fired (v' + e.oldVersion + ' -> v' + e.newVersion + ')');
                e.target.transaction.abort();
            };
        });
    }

    function findInWorkspaceFiles(db, fid) {
        if (!db.objectStoreNames.contains('workspace_files')) {
            log.push('  No workspace_files store');
            return Promise.resolve(null);
        }
        return new Promise(function(resolve) {
            var tx = db.transaction(['workspace_files'], 'readonly');
            var store = tx.objectStore('workspace_files');
            var count = 0;
            var cursor = store.openCursor();
            cursor.onsuccess = function() {
                var c = cursor.result;
                if (!c) { log.push('  Scanned ' + count + ' workspace files'); return resolve(null); }
                count++;
                if (c.value.file_id === fid) {
                    var content = c.value.content || '';
                    var mime = guessMime(c.value.path || fileName);
                    if (content.indexOf('::binary::') === 0) {
                        return resolve({ data: 'data:' + mime + ';base64,' + content.substring(10), mime: mime });
                    }
                    return resolve({ data: content, mime: mime });
                }
                c.continue();
            };
            cursor.onerror = function() { log.push('  Cursor error'); resolve(null); };
        });
    }

    // PAYLOAD-STORE: post-v16, chats records persist with base64 payloads
    // stripped into the chat_payloads store ({ id, base64 } keyed by
    // file_id/screenshot_id). Direct keyed get — no cursor scan needed.
    function getChatPayload(db, fid) {
        if (!db.objectStoreNames.contains('chat_payloads')) return Promise.resolve(null);
        return new Promise(function(resolve) {
            var tx = db.transaction(['chat_payloads'], 'readonly');
            var req = tx.objectStore('chat_payloads').get(fid);
            req.onsuccess = function() { resolve((req.result && req.result.base64) || null); };
            req.onerror = function() { resolve(null); };
        });
    }

    function findInChats(db, fid) {
        if (!db.objectStoreNames.contains('chats')) {
            log.push('  No chats store');
            return Promise.resolve(null);
        }
        return new Promise(function(resolve) {
            var tx = db.transaction(['chats'], 'readonly');
            var store = tx.objectStore('chats');
            var count = 0;
            var cursor = store.openCursor();
            // The chats scan supplies the message METADATA (mime type); the
            // bytes themselves may live in chat_payloads (records stripped by
            // PAYLOAD-STORE) — fall back to a keyed blob get when the matched
            // message carries no inline base64.
            function resolveWithPayload(inline, mime) {
                if (inline) return resolve({ data: inline, mime: mime });
                getChatPayload(db, fid).then(function(b64) {
                    if (b64) log.push('  Found payload in chat_payloads');
                    resolve(b64 ? { data: b64, mime: mime } : null);
                });
            }
            cursor.onsuccess = function() {
                var c = cursor.result;
                if (!c) { log.push('  Scanned ' + count + ' chats'); return resolve(null); }
                count++;
                var chat = c.value;
                if (chat.messages) {
                    for (var i = 0; i < chat.messages.length; i++) {
                        var msg = chat.messages[i];
                        if (msg.file_id === fid || msg.screenshot_id === fid) {
                            return resolveWithPayload(
                                msg.base64 || msg.content,
                                msg.mimeType || (msg.role === 'screenshot' ? 'image/png' : 'application/octet-stream')
                            );
                        }
                    }
                }
                if (chat.screenshots && chat.screenshots[fid]) {
                    return resolveWithPayload(chat.screenshots[fid].base64, 'image/png');
                }
                c.continue();
            };
            cursor.onerror = function() { log.push('  Chat cursor error'); resolve(null); };
        });
    }

    function triggerDownload(data, mime, name) {
        var blob;
        if (typeof data === 'string' && data.indexOf('data:') === 0) {
            var b64 = data.split(',')[1];
            var bytes = atob(b64);
            var arr = new Uint8Array(bytes.length);
            for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
            blob = new Blob([arr], { type: mime });
        } else {
            blob = new Blob([data || ''], { type: mime });
        }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function guessMime(name) {
        var ext = (name || '').split('.').pop().toLowerCase();
        var m = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', svg:'image/svg+xml',
            pdf:'application/pdf', json:'application/json', xml:'application/xml', js:'text/javascript',
            css:'text/css', html:'text/html', md:'text/markdown', txt:'text/plain', csv:'text/csv' };
        return m[ext] || 'application/octet-stream';
    }

    function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function show(html, isError) {
        card.innerHTML = (isError ? '<p class="error">' : '<p>') + html + '</p>';
    }
})();
