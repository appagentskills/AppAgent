// Data Management Functions

// PAYLOAD-STORE: chats records persist with base64 payloads stripped into the
// chat_payloads store (see extractChatPayloadsForPut in core/130-indexeddb.js).
// A backup must be self-contained, so re-inline each record's payloads and
// drop the eviction flags before writing it out. The resulting legacy-shape
// chat round-trips through the import path unchanged: imported records keep
// payloads inline, hydration falls back to record-inline base64, and the next
// save re-extracts them into chat_payloads. Mutates and returns `chat`, which
// is always a throwaway copy fetched from IDB — never the in-memory object.
async function inlineChatPayloadsForExport(database, chat, stats) {
    if (!chat || !chat._payloadsEvicted) return chat;
    var ids = {};
    if (Array.isArray(chat.messages)) {
        chat.messages.forEach(function(m) {
            if (m && m._b64Evicted) {
                var mid = m.file_id || m.screenshot_id;
                if (mid) ids[mid] = true;
            }
        });
    }
    if (chat.screenshots) {
        Object.keys(chat.screenshots).forEach(function(k) {
            if (chat.screenshots[k] && chat.screenshots[k]._b64Evicted) ids[k] = true;
        });
    }
    var idList = Object.keys(ids);
    if (idList.length) {
        var byId = {};
        // S0B-07: each id counts as missing until its payload is found, so a
        // failed get or a throw (the caller logs it and exports the chat as-is)
        // is reported in the export result instead of a plain success.
        if (stats) stats.missing += idList.length;
        var tx = database.transaction([chatPayloadsStoreName], 'readonly');
        var store = tx.objectStore(chatPayloadsStoreName);
        await Promise.all(idList.map(function(id) {
            return new Promise(function(resolve) {
                var req = store.get(id);
                req.onsuccess = function() {
                    if (req.result && req.result.base64) { byId[id] = req.result.base64; if (stats) stats.missing--; }
                    resolve();
                };
                req.onerror = function(ev) {
                    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
                    resolve();
                };
            });
        }));
        if (Array.isArray(chat.messages)) {
            chat.messages.forEach(function(m) {
                if (!m || !m._b64Evicted) return;
                var mid = m.file_id || m.screenshot_id;
                if (mid && byId[mid]) m.base64 = byId[mid];
                delete m._b64Evicted;
            });
        }
        if (chat.screenshots) {
            Object.keys(chat.screenshots).forEach(function(k) {
                var s = chat.screenshots[k];
                if (!s || !s._b64Evicted) return;
                if (byId[k]) s.base64 = byId[k];
                delete s._b64Evicted;
            });
        }
    }
    delete chat._payloadsEvicted;
    return chat;
}

// S0B-06: API keys are stored in plaintext, so a backup leaves them out unless
// the user opts in. Each provider row / settings llmEndpoints entry then gets
// apiKey:'' plus _apiKeyRedacted, and importing it keeps that device's own key
// (importAllData). The 'oauth' apiKey marker is not a secret and is kept; OAuth,
// GitHub and instance tokens live in chrome.storage.local and are not exported.
function _redactApiKey(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.apiKey === 'oauth') return row;
    var out = Object.assign({}, row);
    out.apiKey = '';
    out._apiKeyRedacted = true;
    return out;
}

// S0B3-03: device-local settings never leave or enter a backup. A
// FileSystemDirectoryHandle serializes to {}, and an old backup's value:{} must
// not replace this device's live deploy-folder handle. S0B3-01: deployDirForeignOk
// is that folder's foreign-folder consent, so it is device-local too.
var DEVICE_LOCAL_SETTING_KEYS = { deployDirHandle: 1, deployDirForeignOk: 1 };
function _isDeviceLocalSetting(row) {
    return !!row && typeof row === 'object' && typeof row.key === 'string' &&
        Object.prototype.hasOwnProperty.call(DEVICE_LOCAL_SETTING_KEYS, row.key);
}

async function exportAllData() {
    var writable = null; // S0B-07: aborted in the catch so a failed export leaves no file
    try {
        // Use File System Access API for streaming large exports
        if (!window.showSaveFilePicker) {
            showSnackbar(t('Your browser does not support large exports. Use Chrome or Edge.'), 'error');
            return;
        }

        // S0B-06: ask first; the safe default leaves the keys out. The modal click
        // keeps the user activation the file picker needs. Cancel/dismiss: nothing
        // is written.
        var keyChoice = await showModal(t('Export Data'),
            t('API keys are stored in <b>plaintext</b>: anyone who gets a backup that includes them can use them.') + '<br><br>' +
            t('<b>Export without API keys</b> (recommended): importing this backup later keeps the API keys already on that device.'),
            [{ label: t('Cancel'), value: 'cancel', class: 'secondary' },
                { label: t('Export without API keys'), value: 'nokeys', class: 'primary' },
                { label: t('Include API keys (plaintext)'), value: 'keys', class: 'warning' }], 'warning');
        if (keyChoice !== 'nokeys' && keyChoice !== 'keys') return;
        var redactKeys = keyChoice !== 'keys';

        var fileHandle = await window.showSaveFilePicker({
            suggestedName: 'appagent-backup-' + new Date().toISOString().split('T')[0] + '.json',
            types: [{ description: t('JSON Files'), accept: { 'application/json': ['.json'] } }]
        });

        writable = await fileHandle.createWritable();
        var database = await openDatabase();
        var chatCount = 0;
        var exportStats = { missing: 0 }; // S0B-07: attachments that could not be inlined

        // Write header
        await writable.write('{\n  "version": 3,\n  "exportDate": "' + new Date().toISOString() + '",\n  "chats": [\n');

        // First get all chat keys (small data, won't cause memory issues)
        var chatKeys = await new Promise(function(resolve, reject) {
            var transaction = database.transaction([chatStoreName], 'readonly');
            var store = transaction.objectStore(chatStoreName);
            var request = store.getAllKeys();
            request.onsuccess = function() { resolve(request.result || []); };
            request.onerror = function() { reject(request.error); };
        });

        // Fetch and write each chat individually with pretty printing
        for (var i = 0; i < chatKeys.length; i++) {
            var chat = await new Promise(function(resolve, reject) {
                var transaction = database.transaction([chatStoreName], 'readonly');
                var store = transaction.objectStore(chatStoreName);
                var request = store.get(chatKeys[i]);
                request.onsuccess = function() { resolve(request.result); };
                request.onerror = function() { reject(request.error); };
            });

            if (chat) {
                // PAYLOAD-STORE: re-inline this record's payloads from
                // chat_payloads so the backup is self-contained.
                try { chat = await inlineChatPayloadsForExport(database, chat, exportStats); } catch (eInline) { console.error('export: payload inlining failed for', chat && chat.id, eInline); }
                if (chatCount > 0) await writable.write(',\n');
                // Pretty print each chat with 4-space indent, then add 4 spaces to each line
                var prettyChat = JSON.stringify(chat, null, 4).split('\n').map(function(line) {
                    return '    ' + line;
                }).join('\n');
                await writable.write(prettyChat);
                chatCount++;
            }
        }

        // Get and write settings
        var settingsTransaction = database.transaction([settingsStoreName], 'readonly');
        var settingsStore = settingsTransaction.objectStore(settingsStoreName);
        var settingsData = await new Promise(function(resolve) {
            var request = settingsStore.getAll();
            request.onsuccess = function() { resolve(request.result || []); };
            request.onerror = function() { resolve([]); };
        });
        settingsData = settingsData.filter(function(row) { return !_isDeviceLocalSetting(row); }); // S0B3-03
        // S0B-06: the llmEndpoints setting holds one apiKey per endpoint.
        if (redactKeys) settingsData = settingsData.map(function(row) {
            if (!row || row.key !== 'llmEndpoints' || !Array.isArray(row.value)) return row;
            return Object.assign({}, row, { value: row.value.map(_redactApiKey) });
        });

        await writable.write('\n  ],\n  "settings": ');
        await writable.write(JSON.stringify(settingsData, null, 2).split('\n').map(function(line, idx) {
            return idx === 0 ? line : '  ' + line;
        }).join('\n'));

        // Get and write dashboard widgets
        var dashboardData = [];
        if (database.objectStoreNames.contains(dashboardWidgetsStoreName)) {
            var dashboardTransaction = database.transaction([dashboardWidgetsStoreName], 'readonly');
            var dashboardStore = dashboardTransaction.objectStore(dashboardWidgetsStoreName);
            dashboardData = await new Promise(function(resolve) {
                var request = dashboardStore.getAll();
                request.onsuccess = function() { resolve(request.result || []); };
                request.onerror = function() { resolve([]); };
            });
        }

        await writable.write(',\n  "dashboardWidgets": ');
        await writable.write(JSON.stringify(dashboardData, null, 2).split('\n').map(function(line, idx) {
            return idx === 0 ? line : '  ' + line;
        }).join('\n'));

        await writable.write(',\n  "widgets": ' + JSON.stringify(await WidgetStore.exportRecords()));

        // Get and write API providers
        var apiProvidersData = [];
        if (database.objectStoreNames.contains(apiProvidersStoreName)) {
            var apiProvidersTransaction = database.transaction([apiProvidersStoreName], 'readonly');
            var apiProvidersStore = apiProvidersTransaction.objectStore(apiProvidersStoreName);
            apiProvidersData = await new Promise(function(resolve) {
                var request = apiProvidersStore.getAll();
                request.onsuccess = function() { resolve(request.result || []); };
                request.onerror = function() { resolve([]); };
            });
        }
        if (redactKeys) apiProvidersData = apiProvidersData.map(_redactApiKey);

        await writable.write(',\n  "apiProviders": ');
        await writable.write(JSON.stringify(apiProvidersData, null, 2).split('\n').map(function(line, idx) {
            return idx === 0 ? line : '  ' + line;
        }).join('\n'));

        // New exports intentionally contain only inline provider records. A
        // physically retained legacy llmEndpoints store is migration input, not
        // part of the current runtime/export architecture.
        await writable.write('\n}');

        await writable.close();

        // S0B-07: payloads that could not be re-inlined are reported, not hidden.
        // i18n: one sentence, pluralized on the attachment count; English keeps "chats" (test anchor).
        if (exportStats.missing) showSnackbar(tn(exportStats.missing, 'Exported {chats} chats; {count} attachment could not be included',
            'Exported {chats} chats; {count} attachments could not be included', { chats: i18nFormatNumber(chatCount) }), 'warning');
        else showSnackbar(tn(chatCount, 'Data exported successfully! ({count} chat)', 'Data exported successfully! ({count} chats)'), 'success');
    } catch (e) {
        // S0B-07: a failed write must not leave a (swap) file behind.
        if (writable) try { await writable.abort(); } catch (_) {}
        if (e.name === 'AbortError') return; // User cancelled file picker
        console.error('Export failed:', e);
        showSnackbar(t('Export failed: {error}', { error: e.message }), 'error');
    }
}

// S0B-04: a single-chat file must be a plain object with a messages array.
function _validateImportedChat(chat) {
    if (!chat || typeof chat !== 'object' || Array.isArray(chat) || !Array.isArray(chat.messages)) throw new Error('Invalid chat file');
    return chat;
}

// S0B-01: read-only snapshot of the rows an import would REPLACE. Runs in its own
// readonly transaction BEFORE the confirm; the write itself stays one atomic tx.
async function _readImportExisting(database, names) {
    var out = {};
    await new Promise(function(resolve, reject) {
        var tx = database.transaction(names, 'readonly');
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = function() { reject(tx.error || new Error('Import pre-check failed')); };
        names.forEach(function(n) {
            var st = tx.objectStore(n);
            var keysOnly = (n === chatStoreName || n === dashboardWidgetsStoreName) && typeof st.getAllKeys === 'function';
            var rq = keysOnly ? st.getAllKeys() : st.getAll();
            rq.onsuccess = function() { out[n] = { keysOnly: keysOnly, rows: rq.result || [] }; };
        });
    });
    return out;
}

// First 5 names, HTML-escaped (the confirm message is rendered as markup).
function _importConflictNames(list) {
    if (!list.length) return '';
    return ': ' + list.slice(0, 5).map(function(s) { return escapeHtml(String(s)); }).join(', ') + (list.length > 5 ? ', …' : '');
}

// S0B-02: the SW only re-reads IDB at its own boot, so after an import restart
// the WHOLE extension the way Reload does (timestamped reopenAppTab marker raced
// against a bounded timer, then chrome.runtime.reload()) - without Reload's
// rebuild step. Reload's _startReloadSequence is nested inside
// _reloadExtensionLocked (ui/270-iframe-panel.js), so it cannot be reused here.
// No extension runtime (web preview/tests) or a build still writing files:
// plain page reload, synchronously.
// True when _restartAfterImport will only reload the page (the SW survives).
function _restartIsPageOnly() {
    return typeof chrome === 'undefined' || !chrome || !chrome.runtime || typeof chrome.runtime.reload !== 'function' ||
        (typeof _reloadBuildInFlight !== 'undefined' && !!_reloadBuildInFlight);
}
async function _restartAfterImport() {
    if (_restartIsPageOnly()) {
        window.location.reload();
        return;
    }
    try { if (typeof _prepareRealmsForReload === 'function') await _prepareRealmsForReload(); } catch (e) {}
    await new Promise(function(resolve) {
        var timer = setTimeout(resolve, 1500);
        var done = function() { clearTimeout(timer); resolve(); };
        try {
            if (!chrome.storage || !chrome.storage.local) { done(); return; }
            // Timestamp (not true): background.js discards a stale marker.
            chrome.storage.local.set({ reopenAppTab: Date.now() }, function() { void chrome.runtime.lastError; done(); });
        } catch (e) { done(); }
    });
    // RELOAD-ZOMBIE (P1): app/060 appCleanReload (SW closes app tabs, then reloads; direct-reload fallback).
    var clean = null;
    try { if (typeof window.appCleanReload === 'function') clean = window.appCleanReload({ reason: 'restart-after-import' }); } catch (e) { clean = null; }
    if (clean && typeof clean.then === 'function') { try { await clean; } catch (e) {} return; }
    try { if (typeof window.keepAwakeDisarmUnload === 'function') window.keepAwakeDisarmUnload(); } catch (e) {}
    try { chrome.runtime.reload(); } catch (e) { window.location.reload(); }
}

// S0B-03: the import result survives the restart as a one-shot notice that the
// next boot shows once (core/120-init.js). A notice older than 5 minutes is
// dropped so a leftover key never resurfaces long after the import.
var POST_IMPORT_NOTICE_KEY = 'appagentPostImportNotice';
function consumePostImportNotice() {
    if (typeof appStorage === 'undefined') return;
    var raw = appStorage.getItem(POST_IMPORT_NOTICE_KEY);
    if (!raw) return;
    appStorage.removeItem(POST_IMPORT_NOTICE_KEY);
    var notice = null;
    try { notice = JSON.parse(raw); } catch (e) { return; }
    if (!notice || typeof notice.msg !== 'string' || !(Date.now() - notice.at < 5 * 60 * 1000)) return;
    showSnackbar(notice.msg, notice.type || 'success');
}

async function importAllData() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async function(e) {
        var file = e.target.files[0];
        if (!file) return;
        
        try {
            var text = await file.text();
            var importData = JSON.parse(text);
            // S0B-05: refuse files from a newer format (missing version = legacy, accepted).
            if (importData && typeof importData.version === 'number' && importData.version > 3) {
                throw new Error('Backup is from a newer version');
            }
            
            // Handle single chat import
            if (importData.exportType === 'single_chat' && importData.chat) {
                var importedChat = _validateImportedChat(importData.chat);
                var newId = 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                importedChat.id = newId;
                importedChat.title = (typeof importedChat.title === 'string' && importedChat.title.trim() ? importedChat.title : 'Imported chat') + ' (imported)';
                // The import-time name is authoritative — drop a serialized
                // provisional flag so the auto-title hook doesn't re-title the
                // chat (losing the '(imported)' marker) on its next run.
                delete importedChat.titleProvisional;
                delete importedChat._titleHookTries;
                importedChat.createdAt = Date.now();
                // FLUX-ADOPT (#836): import/restore is user-authoritative —
                // route through the sanctioned adopt path with force (newId is
                // freshly generated, so the guard is moot, but the ratchet
                // keeps all wholesale adopts on the one site).
                adoptChatRow(importedChat, { chatId: newId, force: true });
                await saveChatsToStorage();
                renderChatList();
                showSnackbar(t('Chat imported successfully'), 'success');
                return;
            }
            
            // Handle full data import
            if (!Array.isArray(importData.chats) || !Array.isArray(importData.settings)) {
                throw new Error('Invalid backup file format');
            }

            // ROW VALIDATION: every store below uses an in-line keyPath (chats
            // 'id', settings 'key', dashboardWidgets 'id', apiProviders 'name').
            // put() on a row missing its key throws a synchronous DataError,
            // which used to abort the loop mid-way and leave a PARTIAL import
            // (earlier puts committed, later rows never written). Filter the
            // invalid rows up front, count them, and report the count.
            var _impSkipped = 0;
            var _hasKey = function(row, keyField) {
                var k = (row && typeof row === 'object' && !Array.isArray(row)) ? row[keyField] : undefined;
                return typeof k === 'string' ? k.length > 0 : (typeof k === 'number' && isFinite(k));
            };
            var _validRows = function(rows, keyField, extraOk) {
                var out = [];
                if (!Array.isArray(rows)) return out;
                for (var r = 0; r < rows.length; r++) {
                    if (_hasKey(rows[r], keyField) && (!extraOk || extraOk(rows[r]))) out.push(rows[r]);
                    else _impSkipped++;
                }
                return out;
            };
            // S0B-05: a chat row without a messages array is invalid (counted as skipped).
            var _impChats = _validRows(importData.chats, 'id', function(row) { return Array.isArray(row.messages); });
            // S0B3-03: device-local rows are skipped (not invalid), so they are never
            // written and never counted as a settings conflict.
            var _impSettings = _validRows(importData.settings, 'key').filter(function(row) { return !_isDeviceLocalSetting(row); });
            var _impDashboardWidgets = _validRows(importData.dashboardWidgets, 'id');
            var _impProviders = _validRows(importData.apiProviders, 'name');
            if (_impChats.length === 0 && _impSettings.length === 0 && _impDashboardWidgets.length === 0 && _impProviders.length === 0) {
                throw new Error('Invalid backup file format (no importable rows' + (_impSkipped ? '; ' + _impSkipped + ' invalid row(s)' : '') + ')');
            }

            // Reject malformed revision backups before confirmation or any write.
            var _impWidgets = importData.widgets === undefined ? [] : importData.widgets;
            WidgetStore.validateRecords(_impWidgets);

            // S0B-01: nothing is written until the conflict confirm below.
            var database = await openDatabase();
            
            var _impStores = {};
            _impStores[chatStoreName] = _impChats.map(stripTransientChatFieldsForPut);
            _impStores[settingsStoreName] = _impSettings;
            if (database.objectStoreNames.contains(dashboardWidgetsStoreName)) _impStores[dashboardWidgetsStoreName] = _impDashboardWidgets;

            // Prepare API providers (if present). Old backups may also contain
            // llmEndpoints; inline their matched connection fields before writing
            // provider rows. The helper preserves all custom fields, credentials,
            // and unmatched endpointId providers. New exports never emit the store.
            if (_impProviders.length > 0 && database.objectStoreNames.contains(apiProvidersStoreName)) {
                var importedProviders = _impProviders;
                if (Array.isArray(importData.llmEndpoints)) {
                    // Canonical endpoint list for endpointId preservation: after the
                    // reload below, the BACKUP's own settings 'llmEndpoints' row (put
                    // above) is what loadLlmEndpoints hydrates — judging id survival
                    // against THIS device's live in-memory list keeps/drops endpointId
                    // wrongly. Prefer the imported settings row; fall back to the live
                    // global only when the backup carries none.
                    var _canonicalEndpoints = (typeof llmEndpoints !== 'undefined' && Array.isArray(llmEndpoints)) ? llmEndpoints : [];
                    for (var e3 = 0; e3 < importData.settings.length; e3++) {
                        var _eRow = importData.settings[e3] || {};
                        if (_eRow.key === 'llmEndpoints' && Array.isArray(_eRow.value)) { _canonicalEndpoints = _eRow.value; break; }
                    }
                    importedProviders = inlineLegacyEndpointProviders(importedProviders, importData.llmEndpoints,
                        _canonicalEndpoints).providers;
                }
                _impStores[apiProvidersStoreName] = [];
                for (var m = 0; m < importedProviders.length; m++) {
                    // inlineLegacyEndpointProviders may reshape rows; re-check the key so
                    // one bad row cannot abort the whole provider transaction.
                    var _pRow = importedProviders[m];
                    if (!_hasKey(_pRow, 'name')) { _impSkipped++; continue; }
                    _impStores[apiProvidersStoreName].push(_pRow);
                }

            }
            
            // S0B-01: list every same-key row the backup would REPLACE (settings:
            // only keys whose value changes) and write nothing unless confirmed.
            var _existing = await _readImportExisting(database, Object.keys(_impStores));
            // S0B-06: a backup exported without API keys flags each blanked key with
            // _apiKeyRedacted - keep this device's same-name provider / same-id
            // endpoint key (none: '') and drop the flag before any compare or write.
            var _localByKey = function(name, keyField) {
                var e = _existing[name], out = Object.create(null);
                if (e && !e.keysOnly) e.rows.forEach(function(r) { if (r && r[keyField] !== undefined && r[keyField] !== null) out[r[keyField]] = r; });
                return out;
            };
            // R1d: a local key is only ever copied onto a row that talks to the SAME
            // host (endpoint/url; none on both sides = the provider's default host).
            // R1f: same ORIGIN (scheme+host+port, so https->http never keeps a key);
            // a present but non-string or unparseable value is null = never matches.
            // R1g: an llmEndpoints entry (isEp) is used through its url only
            // (040-tools-settings ep.url), so it matches on url alone - an `endpoint`
            // field never selects or lends its key; providers keep endpoint/url.
            var _keyHost = function(r, isEp) {
                var u = r && (isEp ? r.url : (r.endpoint || r.url));
                if (!u || (typeof u === 'string' && !u.trim())) return '';
                if (typeof u !== 'string') return null;
                try { var o = new URL(u.trim()).origin; } catch (eUrl) { return null; }
                return o && o !== 'null' ? o : null;
            };
            // R1e: `locals` = candidate rows in preference order; the first one that
            // has a key for the same host wins. R1g: rowIsEp = row is an llmEndpoints
            // entry; a candidate is one when it is this device's _localEps entry.
            var _keepLocalKey = function(row, locals, rowIsEp) {
                if (!row || typeof row !== 'object' || !row._apiKeyRedacted) return row;
                var out = Object.assign({}, row);
                delete out._apiKeyRedacted;
                var host = _keyHost(row, rowIsEp);
                var local = host === null ? null : [].concat(locals).filter(function(l) { return l && typeof l.apiKey === 'string' && l.apiKey && _keyHost(l, _localEps[l.id] === l) === host; })[0];
                out.apiKey = local ? local.apiKey : '';
                return out;
            };
            var _localEpRow = _localByKey(settingsStoreName, 'key').llmEndpoints, _localEps = Object.create(null);
            if (_localEpRow && Array.isArray(_localEpRow.value)) _localEpRow.value.forEach(function(ep) { if (ep && ep.id !== undefined && ep.id !== null) _localEps[ep.id] = ep; });
            var _provFlagged = Object.create(null), _provCleared = Object.create(null), _provReplaced = Object.create(null);
            if (_impStores[apiProvidersStoreName]) {
                var _localProviders = _localByKey(apiProvidersStoreName, 'name');
                var _epIdOf = function(r) { return (r && r.endpointId !== undefined && r.endpointId !== null) ? String(r.endpointId) : ''; };
                _impStores[apiProvidersStoreName] = _impStores[apiProvidersStoreName].map(function(row) {
                    if (!row._apiKeyRedacted) return row;
                    _provFlagged[row.name] = true;
                    // R1d: prefer this device's key for the row's endpointId, then (R1e:
                    // whatever its endpointId) the same-name provider's - same host only.
                    var epId = _epIdOf(row), same = _localProviders[row.name];
                    var kept = _keepLocalKey(row, [epId && _localEps[epId], same]);
                    // R1e: a same-name key that is not carried over is cleared - report it;
                    // R1f: one REPLACED by the endpointId key is not "kept" either.
                    if (same && typeof same.apiKey === 'string' && same.apiKey && kept.apiKey !== same.apiKey) {
                        if (kept.apiKey) _provReplaced[row.name] = true; else _provCleared[row.name] = true;
                    }
                    return kept;
                });
            }
            var _epCleared = [];
            _impStores[settingsStoreName] = _impStores[settingsStoreName].map(function(row) {
                if (row.key !== 'llmEndpoints' || !Array.isArray(row.value)) return row;
                return Object.assign({}, row, { value: row.value.map(function(ep) {
                    var loc = ep && _localEps[ep.id], kept = _keepLocalKey(ep, loc, true);
                    // R1f (4): name an endpoint whose local key is cleared (other origin).
                    if (ep && ep._apiKeyRedacted && loc && typeof loc.apiKey === 'string' && loc.apiKey && !kept.apiKey) _epCleared.push(ep.name || ep.id);
                    return kept;
                }) });
            });
            var _conflicts = function(name, keyField) {
                var e = _existing[name], have = Object.create(null);
                if (!e) return [];
                e.rows.forEach(function(r) { var k = e.keysOnly ? r : (r && r[keyField]); if (k !== undefined && k !== null) have[k] = e.keysOnly ? true : r; });
                return (_impStores[name] || []).filter(function(row) {
                    if (!(row[keyField] in have)) return false;
                    return keyField !== 'key' || JSON.stringify(have[row[keyField]].value) !== JSON.stringify(row.value);
                });
            };
            var _cChats = _conflicts(chatStoreName, 'id'), _cSettings = _conflicts(settingsStoreName, 'key');
            var _cDash = _conflicts(dashboardWidgetsStoreName, 'id'), _cProviders = _conflicts(apiProvidersStoreName, 'name');
            // R1d: unflagged rows (the 'oauth' marker, or a backup made with keys)
            // take the backup value - say so instead of "local API keys kept".
            // R1e: flagged rows whose local key is cleared are named too, never "kept";
            // R1f: so are rows whose local key is replaced by the endpointId key.
            var _cProvBackup = _cProviders.filter(function(p) { return !_provFlagged[p.name]; });
            var _cProvCleared = _cProviders.filter(function(p) { return _provCleared[p.name]; });
            var _cProvReplaced = _cProviders.filter(function(p) { return _provReplaced[p.name]; });
            // i18n: {names} = the escaped list without its ': ' lead (_importConflictNames).
            var _provNames = function(list) { return _importConflictNames(list.map(function(p) { return p.name; })).slice(2); };
            var _provKeyNotes = [];
            if (_cProvBackup.length + _cProvCleared.length + _cProvReplaced.length < _cProviders.length) _provKeyNotes.push(_cProvBackup.length ? t('local API keys kept, except the backup value for {names}', { names: _provNames(_cProvBackup) }) : t('local API keys kept'));
            else if (_cProvBackup.length) _provKeyNotes.push(t('API keys revert to the backup value for {names}', { names: _provNames(_cProvBackup) }));
            if (_cProvCleared.length) _provKeyNotes.push(t('key cleared for {names} (different or invalid endpoint)', { names: _provNames(_cProvCleared) }));
            if (_cProvReplaced.length) _provKeyNotes.push(t('local key replaced for {names} (endpoint key)', { names: _provNames(_cProvReplaced) }));
            // R1g: no provider conflicts = no key note (not "0 providers (API keys revert ...)").
            var _provKeyNote = !_cProviders.length ? '' : _cProvBackup.length === _cProviders.length ? t('API keys revert to the backup value') : _provKeyNotes.join('; ');
            // i18n: the counts keep their plural-neutral English (test anchors); tn() gives
            // translators the plural categories. The escaped name lists stay appended data.
            var _histCount = i18nFormatNumber((_impWidgets && _impWidgets.length) || 0);
            var _impLines = ['<b>' + t('Rows with the same id are REPLACED by the backup version:') + '</b>',
                tn(_impChats.length, '{replaced} of {count} chats', '{replaced} of {count} chats', { replaced: i18nFormatNumber(_cChats.length) }) +
                    _importConflictNames(_cChats.map(function(c) { return (typeof c.title === 'string' && c.title) || c.id; })),
                (_epCleared.length
                    ? tn(_cSettings.length, '{count} settings ({note})', '{count} settings ({note})',
                        { note: t('key cleared for {names} (different or invalid endpoint)', { names: _importConflictNames(_epCleared).slice(2) }) })
                    : tn(_cSettings.length, '{count} settings', '{count} settings')) + _importConflictNames(_cSettings.map(function(s) { return s.key; })),
                (_provKeyNote
                    ? tn(_cProviders.length, '{count} providers ({note})', '{count} providers ({note})', { note: _provKeyNote })
                    : tn(_cProviders.length, '{count} providers', '{count} providers')) + _importConflictNames(_cProviders.map(function(p) { return p.name; })),
                tn(_cDash.length, '{count} dashboard widgets; {histories} widget histories (newest kept)',
                    '{count} dashboard widgets; {histories} widget histories (newest kept)', { histories: _histCount }),
                t('Everything else is added. This cannot be undone.')];
            if (_impSkipped) _impLines.push(tn(_impSkipped, '{count} invalid row(s) will be skipped.', '{count} invalid row(s) will be skipped.'));
            // S0B-02: the import restarts the extension (below), which stops every
            // in-flight agent run - warn in this SAME confirm (Reload's count loop).
            var _impRunning = 0;
            if (typeof runningChatIds !== 'undefined' && runningChatIds) {
                for (var _rcid in runningChatIds) { if (runningChatIds[_rcid]) _impRunning++; }
            }
            if (_impRunning) _impLines.unshift('<b>' + tn(_impRunning, '{count} agent run(s) in progress; importing restarts the extension and stops them.',
                '{count} agent run(s) in progress; importing restarts the extension and stops them.') + '</b>');
            if (!await showConfirmModal(t('Import Data – replace existing?'), _impLines.join('<br>'), 'warning')) {
                return;
            }

            // No store is changed until all widget conflicts have been checked in
            // this same transaction; publish permissions only AFTER it commits.
            await WidgetStore.importRecords(_impWidgets, _impStores);

            // F6: permission maps are SW-owned at runtime — the generic put
            // above restores the IDB rows, but a live SW (which outlives the
            // location.reload() below, often for hours under keep-awake)
            // only re-reads IDB at its own boot, so without an explicit
            // dispatch it would keep ENFORCING the pre-import maps —
            // security-relevant when the import TIGHTENS permissions. Route
            // the imported maps through the normal perms/set lane: the SW
            // applies them to its globals, re-persists (same content, no-op)
            // and rebroadcasts so any other open panel converges before this
            // panel reloads.
            if (typeof pushPermissionsToOffscreen === 'function') {
                var _impPerms = {};
                for (var p2 = 0; p2 < importData.settings.length; p2++) {
                    var _iRow = importData.settings[p2] || {};
                    if (_iRow.key === 'toolPermissions' && _iRow.value && typeof _iRow.value === 'object') _impPerms.toolPermissions = _iRow.value;
                    if (_iRow.key === 'instancePermissions' && _iRow.value && typeof _iRow.value === 'object') _impPerms.instancePermissions = _iRow.value;
                }
                if (_impPerms.toolPermissions || _impPerms.instancePermissions) {
                    pushPermissionsToOffscreen(_impPerms);
                }
            }

            // i18n: translated now - the one-shot notice below is shown after the restart as-is.
            var _impSetCount = i18nFormatNumber(_impSettings.length);
            var _impResult = _impSkipped
                ? tn(_impChats.length, 'Data imported successfully! ({count} chat, {settings} settings; {skipped} invalid row(s) skipped)',
                    'Data imported successfully! ({count} chats, {settings} settings; {skipped} invalid row(s) skipped)',
                    { settings: _impSetCount, skipped: i18nFormatNumber(_impSkipped) })
                : tn(_impChats.length, 'Data imported successfully! ({count} chat, {settings} settings)',
                    'Data imported successfully! ({count} chats, {settings} settings)', { settings: _impSetCount });
            showSnackbar(t('{result} Reloading...', { result: _impResult }), 'success');
            // S0B-03: the restart below wipes that snackbar at once - hand the result
            // to the next boot. appStorage (localStorage), not sessionStorage:
            // chrome.runtime.reload() closes this page and a NEW tab is reopened.
            try {
                if (typeof appStorage !== 'undefined') appStorage.setItem(POST_IMPORT_NOTICE_KEY, JSON.stringify({ msg: _impResult, type: 'success', at: Date.now() }));
            } catch (eNotice) { /* best-effort; never blocks the restart */ }
            await _restartAfterImport();
        } catch (e) {
            console.error('Import failed:', e);
            showSnackbar(t('Import failed: {error}', { error: e.message }), 'error');
        }
    };
    input.click();
}

// S8D-02: Delete All scope. Every IndexedDB store is in exactly one list
// (test/data-management-import-export.test.js checks the schema). These are
// the core *StoreName values as literals, so this file still loads standalone.
var DELETE_ALL_STORES = ['chats', 'chat_payloads', 'settings', 'widgets', 'dashboardWidgets',
    'skills', 'skillAssets', 'apiProviders', 'documents', 'action_state', 'agent_runs',
    'sub_agents', 'pending_wakes'];
// Kept: local repository clones (workspace tool), which may hold unpushed edits.
var DELETE_ALL_KEEP_STORES = ['workspace_meta', 'workspace_files', 'workspace_blobs'];
// chrome.storage.local keys removed by exact name (never clear() the area: it
// also holds service-worker keys): tokens, sign-ins, the chat-title mirror and
// the ServiceNow instance-picker cache (platform-bridge.js _INSTANCES_CACHE_KEY).
var DELETE_ALL_LOCAL_KEYS = ['githubToken', 'githubUser', 'githubInstanceUrl',
    'sessionToken', 'instanceUrl', 'userName', 'instanceTokens',
    'claudeOAuth', 'claudeAutoLoginFailedFor', 'openaiOAuth', 'openaiPendingDeviceAuth',
    'appagent_chat_index', 'snInstancesCache'];
// The service worker's own sign-out handlers: they set the *SuppressAutoLogin
// flags (the ChatGPT one also stops an in-flight token renewal), so the claude.ai / ChatGPT
// browser session is not silently re-used after the delete.
var DELETE_ALL_LOGOUT_MESSAGES = ['claude-oauth-logout', 'openai-oauth-logout'];

// TA-4: every Delete All chrome call is bounded. A service worker that never
// answers (asleep, crashed, mid-update) must not hang the delete before its
// restart: after DELETE_ALL_CALL_TIMEOUT_MS the call counts as failed.
var DELETE_ALL_CALL_TIMEOUT_MS = 3000;
// Runs fn(done); resolves true only when done fires with no
// chrome.runtime.lastError and no resp.error, false on a throw or on timeout.
// Never rejects; the timer is cleared once the race settles.
function _deleteAllCall(fn) {
    var c = typeof chrome !== 'undefined' ? chrome : null;
    var runtime = c && c.runtime, timer = null;
    var op = new Promise(function(resolve) {
        try { fn(function(resp) { resolve(!(runtime && runtime.lastError) && !(resp && resp.error)); }); }
        catch (e) { resolve(false); }
    });
    var timeout = new Promise(function(resolve) {
        timer = setTimeout(function() { resolve(false); }, DELETE_ALL_CALL_TIMEOUT_MS);
    });
    return Promise.race([op, timeout]).then(function(ok) { clearTimeout(timer); return ok; });
}

// Resolves true when every sign-out and key removal succeeded; never rejects.
function _deleteAllLocalSecrets() {
    var c = typeof chrome !== 'undefined' ? chrome : null;
    var runtime = c && c.runtime, local = c && c.storage && c.storage.local;
    var logouts = (runtime && typeof runtime.sendMessage === 'function')
        ? DELETE_ALL_LOGOUT_MESSAGES.map(function(type) { return _deleteAllCall(function(done) { runtime.sendMessage({ type: type }, done); }); })
        : [];
    return Promise.all(logouts).then(function(results) {
        var ok = results.every(Boolean);
        if (!local || typeof local.remove !== 'function') return ok;
        return _deleteAllCall(function(done) { local.remove(DELETE_ALL_LOCAL_KEYS, done); }).then(function(removed) { return ok && removed; });
    });
}

// Rm7 (#1007): remove every appStorage key (window.localStorage entries under
// STORAGE_PREFIX) except the post-restart notice slot. Best-effort, never throws.
function _deleteAllAppStorage() {
    try {
        var ls = (typeof window !== 'undefined' && window.localStorage) || null;
        if (!ls) return 0;
        var prefix = (typeof STORAGE_PREFIX === 'string') ? STORAGE_PREFIX : '';
        if (!prefix) return 0; // Never erase unrelated origin data without an app namespace.
        var keep = prefix + POST_IMPORT_NOTICE_KEY, doomed = [];
        for (var i = 0; i < ls.length; i++) {
            var k = ls.key(i);
            if (k != null && k !== keep && k.indexOf(prefix) === 0) doomed.push(k);
        }
        doomed.forEach(function(k) { try { ls.removeItem(k); } catch (e) {} });
        return doomed.length;
    } catch (e) { return 0; }
}

async function deleteAllData() {
    // S8D-01: Delete All restarts the whole extension (below), which stops every
    // in-flight agent run - warn in the FIRST confirm (import's count loop).
    var _delRunning = 0;
    if (typeof runningChatIds !== 'undefined' && runningChatIds) {
        for (var _drcid in runningChatIds) { if (runningChatIds[_drcid]) _delRunning++; }
    }
    var _delWarn = _delRunning ? '<b>' + tn(_delRunning, '{count} agent run(s) in progress; deleting restarts the extension and stops them.',
        '{count} agent run(s) in progress; deleting restarts the extension and stops them.') + '</b><br><br>' : '';
    if (!await showConfirmModal(t('Delete All Data'), _delWarn +
            t('This permanently deletes <strong>all chats and their agent runs, skills (built-in skills are restored), widgets, documents, settings and permissions, saved API keys and sign-ins (GitHub, ServiceNow, Claude, ChatGPT) and the cached ServiceNow instance list</strong>.') + '<br><br>' +
            t('<strong>Kept:</strong> local repository clones, including unpushed edits. This cannot be undone.'), 'danger')) {
        return;
    }
    if (!await showConfirmModal(t('Confirm Delete'), t('All chats, skills, widgets, documents, settings, saved API keys and sign-ins will be deleted. Local repository clones are kept. Then the extension restarts, which closes every open AppAgent panel. Are you REALLY sure?'), 'danger')) {
        return;
    }

    // TA-3: the save fences set below; lifted again only when the clear did not commit.
    var _delRt = null, _delLockSent = false, _delCleared = false, _delHydratedSet = false, _delPrevHydrated;
    try {
        var database = await openDatabase();

        // TA-3: fence every chat save before the clear, so a late save cannot
        // re-write a chat row into the emptied stores. Stop the runs, lock the
        // SW saves (bounded by _deleteAllCall and fail-open: a silent SW never
        // blocks the delete), then close the page wipe guard (ui/070 save).
        if (typeof runningChatIds !== 'undefined' && runningChatIds && typeof pushInterruptToOffscreen === 'function') {
            for (var _dicid in runningChatIds) {
                if (!runningChatIds[_dicid]) continue;
                try { pushInterruptToOffscreen(_dicid, false); } catch (eInt) { /* best-effort; the restart stops it too */ }
            }
        }
        _delRt = (typeof chrome !== 'undefined' && chrome && chrome.runtime) || null;
        if (_delRt && typeof _delRt.sendMessage === 'function') {
            _delLockSent = true;
            await _deleteAllCall(function(done) { _delRt.sendMessage({ type: 'delete-all-save-lock', locked: true }, done); });
        }
        if (typeof _chatsHydrated !== 'undefined') {
            _delPrevHydrated = _chatsHydrated;
            _delHydratedSet = true;
            _chatsHydrated = false;
        }

        // Clear every Delete All store together and wait for durable completion.
        var resetStores = DELETE_ALL_STORES
            .filter(function(name) { return database.objectStoreNames.contains(name); });
        await new Promise(function(resolve, reject) {
            var tx = database.transaction(resetStores, 'readwrite'), failure;
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = function() { reject(failure || tx.error || new Error('Reset transaction failed')); };
            try { resetStores.forEach(function(name) { tx.objectStore(name).clear(); }); }
            catch (e) { failure = e; tx.abort(); }
        });
        _delCleared = true;
        WidgetStore.clearCache(true);
        // Sign-ins and tokens live in chrome.storage.local: removed only after the commit.
        var secretsRemoved = await _deleteAllLocalSecrets();
        // Rm7 (#1007): UI prefs live in appStorage (localStorage, STORAGE_PREFIX)
        // - the dialog promises settings are deleted, so clear them too.
        _deleteAllAppStorage();

        // S8D-01: the SW keeps enforcing its in-memory permission maps and writes
        // them back to IDB on the next delta - hand it the cleared (empty) maps.
        if (typeof pushPermissionsToOffscreen === 'function') {
            try { pushPermissionsToOffscreen({ toolPermissions: {}, instancePermissions: {} }); } catch (ePerm) { /* the restart below re-reads IDB */ }
        }
        // Translated here: the next boot shows the stored notice text as-is (S0B-03).
        var _delResult = secretsRemoved ? t('All data deleted') : t('All data deleted, but some saved sign-ins could not be removed');
        var _delKind = secretsRemoved ? 'success' : 'error';
        showSnackbar(t('{result}. Restarting...', { result: _delResult }), _delKind);
        // The restart wipes that snackbar: hand the result to the next boot (S0B-03).
        try {
            if (typeof appStorage !== 'undefined') appStorage.setItem(POST_IMPORT_NOTICE_KEY, JSON.stringify({ msg: _delResult, type: _delKind, at: Date.now() }));
        } catch (eNotice) { /* best-effort; never blocks the restart */ }
        // M6: a page-only reload keeps the SW (and its in-memory save lock)
        // alive - lift the lock first or every later chat save throws until
        // the SW restarts. The runs were interrupted above and the page wipe
        // guard stays closed until the reload.
        if (_delLockSent && _restartIsPageOnly()) {
            await _deleteAllCall(function(done) { _delRt.sendMessage({ type: 'delete-all-save-lock', locked: false }, done); });
        }
        // Only now, with the delete committed: restart the SW too, like import.
        await _restartAfterImport();
    } catch (e) {
        // TA-3: nothing was cleared - lift the fences again. Restore the PREVIOUS
        // wipe-guard value (never a literal true: a degraded page stays guarded)
        // and unlock the SW saves (bounded, never rejects).
        if (!_delCleared) {
            if (_delHydratedSet) _chatsHydrated = _delPrevHydrated;
            if (_delLockSent) await _deleteAllCall(function(done) { _delRt.sendMessage({ type: 'delete-all-save-lock', locked: false }, done); });
        }
        console.error('Delete failed:', e);
        showSnackbar(t('Delete failed: {error}', { error: e.message }), 'error');
    }
}

function setToolPermission(toolName, permission) {
    toolPermissions[toolName] = permission;
    saveToolPermissions();
    renderToolPermissions();
}

// Set permission by resolved key — routes to instance or global storage
function setToolPermissionByKey(permKey, value) {
    if (isInstancePermissionKey(permKey)) {
        var host = getConnectedInstanceHost();
        if (host) {
            if (!instancePermissions[host]) instancePermissions[host] = { tier: 'manual', tools: {} };
            if (!instancePermissions[host].tools) instancePermissions[host].tools = {};
            instancePermissions[host].tools[permKey] = value;
            saveInstancePermissions();
        }
    } else {
        toolPermissions[permKey] = value;
        saveToolPermissions();
    }
    renderToolPermissions();
}

function toggleSettingsPanel(e) {
    if (e) e.stopPropagation();
    settingsPanelOpen = !settingsPanelOpen;
    var panel = document.getElementById('settings-panel');
    if (settingsPanelOpen) {
        // Only one header dropdown open at a time
        if (typeof closeAllHeaderMenus === 'function') closeAllHeaderMenus('settings');
        settingsPanelOpen = true; // closeAllHeaderMenus('settings') skips this panel, but keep state explicit
        // Position panel under the clicked button
        var btn = e ? e.target.closest('.settings-btn') : document.querySelector('.settings-btn');
        if (btn) {
            var rect = btn.getBoundingClientRect();
            panel.style.top = (rect.bottom + 4) + 'px';
            // Rule 10: align the panel's END edge with the button's (right in LTR,
            // left in RTL); clear the other side, left over from a language switch.
            if (typeof i18nDir === 'function' && i18nDir() === 'rtl') {
                panel.style.right = '';
                panel.style.left = rect.left + 'px';
            } else {
                panel.style.left = '';
                panel.style.right = (window.innerWidth - rect.right) + 'px';
            }
        }
        panel.classList.add('visible');
        // Sync the theme segmented control with the persisted pref (same
        // mechanism as the settings page: appTheme + setAppTheme).
        if (typeof syncSettingsPanelTheme === 'function') syncSettingsPanelTheme();
        // Same for the Language picker (ui/245: shared option list + preference
        // with Settings > Language; onchange = setAppLanguage).
        if (typeof syncSettingsPanelLanguage === 'function') syncSettingsPanelLanguage();
        // "Connect GitHub" item: only shown when GitHub is NOT connected — same
        // connected test as the settings page GitHub section (user + token).
        var ghItem = document.getElementById('settings-github-connect');
        if (ghItem && typeof loadGitHubSettings === 'function') {
            loadGitHubSettings().then(function(gh) {
                ghItem.style.display = (gh && gh.user && gh.token) ? 'none' : 'block';
            }).catch(function() {});
        }
        // Close on outside click
        setTimeout(function() {
            document.addEventListener('click', closeSettingsPanelOnOutsideClick);
        }, 0);
    } else {
        panel.classList.remove('visible');
        document.removeEventListener('click', closeSettingsPanelOnOutsideClick);
    }
    if (typeof syncHeaderMenuExpanded === 'function') syncHeaderMenuExpanded();
}

function closeSettingsPanelOnOutsideClick(e) {
    var panel = document.getElementById('settings-panel');
    var btns = document.querySelectorAll('.settings-btn');
    var clickedOnBtn = false;
    btns.forEach(function(btn) { if (btn.contains(e.target)) clickedOnBtn = true; });
    if (panel && !panel.contains(e.target) && !clickedOnBtn) {
        closeSettingsPanel();
    }
}

function closeSettingsPanel() {
    settingsPanelOpen = false;
    var panel = document.getElementById('settings-panel');
    // T2b: focus inside the panel (Esc, a link item) goes back to the VISIBLE gear
    // instead of falling to <body>; offsetParent skips the hidden header/home twin.
    var ae = document.activeElement;
    var refocus = !!(panel && ae && panel.contains(ae));
    if (panel) panel.classList.remove('visible');
    document.removeEventListener('click', closeSettingsPanelOnOutsideClick);
    if (typeof syncHeaderMenuExpanded === 'function') syncHeaderMenuExpanded();
    if (refocus) {
        var gears = document.querySelectorAll('.settings-btn');
        for (var i = 0; i < gears.length; i++) {
            if (gears[i].offsetParent !== null) { gears[i].focus(); break; }
        }
    }
}
