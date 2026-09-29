(function() {
    var params = new URLSearchParams(location.search);
    var fileId = params.get('id');
    var fileName = params.get('name') || 'download';
    var card = document.getElementById('card');
    var log = [];

    var dbNames = ['AppAgentDB', 'iframe_AppAgentDB'];

    // i18n: this standalone page is not part of the app bundle (no core/025-i18n.js),
    // so it carries a minimal gettext-style lookup over the same catalog. The app
    // mirrors the RESOLVED UI language to localStorage 'uiLanguage' + 'uiLanguageDir'
    // (ui/245-i18n-dom.js; 'iframe_' prefix when embedded) and the build copies
    // src/locales/<code>.json to locales/<code>.json. English is the identity.
    var i18nCatalog = {};
    var hasOwn = Object.prototype.hasOwnProperty;

    loadCatalog().then(start, start);

    function start() {
        applyStaticI18n();
        if (!fileId) return show(t('No file ID provided.'), true);
        tryDatabases(dbNames, 0);
    }

    // Same lookup as core/025-i18n.js t(): own keys only, '' counts as missing,
    // a plural (tn) object falls back to its 'other' form, and a missing or
    // null/undefined param keeps its {placeholder} verbatim. Never throws.
    function t(source, vars) {
        var key = toStr(source);
        try {
            var v = hasOwn.call(i18nCatalog, key) ? i18nCatalog[key] : null;
            if (!isForm(v) && isPlainObject(v) && hasOwn.call(v, 'other')) v = v.other;
            var s = isForm(v) ? v : key;
            if (vars === null || vars === undefined || Object(vars) !== vars) return s;
            return s.replace(/\{(\w+)\}/g, function(m, k) {
                return hasOwn.call(vars, k) && vars[k] !== null && vars[k] !== undefined ? toStr(vars[k]) : m;
            });
        } catch (e) {
            return key;
        }
    }

    function toStr(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    function isForm(v) { return typeof v === 'string' && v !== ''; }

    function isPlainObject(v) { return Object.prototype.toString.call(v) === '[object Object]'; }

    // The panel's key rule (i18nNormalizeKey in ui/245-i18n-dom.js).
    function normalizeKey(s) { return toStr(s).replace(/\s+/g, ' ').trim(); }

    function mirrored(key) {
        try { return localStorage.getItem(key) || localStorage.getItem('iframe_' + key) || ''; } catch (e) { return ''; }
    }

    function setLangDir(code, dir) {
        try {
            document.documentElement.setAttribute('lang', code);
            document.documentElement.setAttribute('dir', dir);
        } catch (e) {}
    }

    // <html lang dir> names the language actually shown: en/ltr until a catalog
    // is in, and on every English fallback (bad or missing code, no fetch, 404,
    // network error, bad JSON, timeout). A catalog that lands after the timeout
    // is ignored, so the page never mixes English and translated text.
    function loadCatalog() {
        var code = mirrored('uiLanguage');
        setLangDir('en', 'ltr');
        if (!code || code === 'en' || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(code) || typeof fetch !== 'function') return Promise.resolve();
        var dir = mirrored('uiLanguageDir') === 'rtl' ? 'rtl' : 'ltr';
        var settled = false;
        function settle(obj) {
            if (settled) return;
            settled = true;
            if (obj) { i18nCatalog = obj; setLangDir(code, dir); }
        }
        var load = Promise.resolve()
            .then(function() { return fetch('locales/' + code + '.json'); })
            .then(function(res) { return res && res.ok ? res.json() : null; })
            .then(function(obj) { settle(isPlainObject(obj) ? obj : null); })
            .catch(function() { settle(null); });
        // Never let a slow catalog hold the download back for long.
        return Promise.race([load, new Promise(function(resolve) {
            setTimeout(function() { settle(null); resolve(); }, 1000);
        })]);
    }

    // The panel's applyI18n rule (ui/245-i18n-dom.js): translate each [data-i18n]
    // element's own non-whitespace text nodes, keyed by normalizeKey(text),
    // keeping child elements and the surrounding whitespace. Untranslated text
    // is left untouched.
    function applyStaticI18n() {
        var els = document.querySelectorAll('[data-i18n]');
        for (var i = 0; i < els.length; i++) {
            for (var n = els[i].firstChild; n; n = n.nextSibling) {
                if (n.nodeType !== 3 || !/\S/.test(n.nodeValue)) continue;
                var orig = n.nodeValue, key = normalizeKey(orig), tr = t(key);
                if (tr !== key) n.nodeValue = orig.match(/^\s*/)[0] + tr + orig.match(/\s*$/)[0];
            }
        }
    }

    function tryDatabases(names, idx) {
        if (idx >= names.length) {
            // fileId comes from the URL and the log carries error text: both are escaped before innerHTML.
            return show(t('File not found: {id}', { id: esc(fileId) }) + '<div class="debug">' + esc(log.join('\n')) + '</div>', true);
        }
        var dbName = names[idx];
        log.push('Trying DB: ' + dbName);
        tryDatabase(dbName).then(function(file) {
            if (file) {
                triggerDownload(file.data, file.mime, fileName);
                show(t('Downloaded: {name}', { name: '<span class="filename">' + esc(fileName) + '</span>' }));
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
