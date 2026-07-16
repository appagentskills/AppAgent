// Data Management Functions

// PAYLOAD-STORE: chats records persist with base64 payloads stripped into the
// chat_payloads store (see extractChatPayloadsForPut in core/130-indexeddb.js).
// A backup must be self-contained, so re-inline each record's payloads and
// drop the eviction flags before writing it out. The resulting legacy-shape
// chat round-trips through the import path unchanged: imported records keep
// payloads inline, hydration falls back to record-inline base64, and the next
// save re-extracts them into chat_payloads. Mutates and returns `chat`, which
// is always a throwaway copy fetched from IDB — never the in-memory object.
async function inlineChatPayloadsForExport(database, chat) {
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
        var tx = database.transaction([chatPayloadsStoreName], 'readonly');
        var store = tx.objectStore(chatPayloadsStoreName);
        await Promise.all(idList.map(function(id) {
            return new Promise(function(resolve) {
                var req = store.get(id);
                req.onsuccess = function() {
                    if (req.result && req.result.base64) byId[id] = req.result.base64;
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

async function exportAllData() {
    try {
        // Use File System Access API for streaming large exports
        if (!window.showSaveFilePicker) {
            showSnackbar('Your browser does not support large exports. Use Chrome or Edge.', 'error');
            return;
        }

        var fileHandle = await window.showSaveFilePicker({
            suggestedName: 'appagent-backup-' + new Date().toISOString().split('T')[0] + '.json',
            types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }]
        });

        var writable = await fileHandle.createWritable();
        var database = await openDatabase();
        var chatCount = 0;

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
                try { chat = await inlineChatPayloadsForExport(database, chat); } catch (eInline) { console.error('export: payload inlining failed for', chat && chat.id, eInline); }
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

        await writable.write(',\n  "apiProviders": ');
        await writable.write(JSON.stringify(apiProvidersData, null, 2).split('\n').map(function(line, idx) {
            return idx === 0 ? line : '  ' + line;
        }).join('\n'));

        // Get and write LLM endpoints
        var llmEndpointsData = [];
        if (database.objectStoreNames.contains(llmEndpointsStoreName)) {
            var llmEndpointsTransaction = database.transaction([llmEndpointsStoreName], 'readonly');
            var llmEndpointsStore = llmEndpointsTransaction.objectStore(llmEndpointsStoreName);
            llmEndpointsData = await new Promise(function(resolve) {
                var request = llmEndpointsStore.getAll();
                request.onsuccess = function() { resolve(request.result || []); };
                request.onerror = function() { resolve([]); };
            });
        }

        await writable.write(',\n  "llmEndpoints": ');
        await writable.write(JSON.stringify(llmEndpointsData, null, 2).split('\n').map(function(line, idx) {
            return idx === 0 ? line : '  ' + line;
        }).join('\n'));
        await writable.write('\n}');

        await writable.close();

        showSnackbar('Data exported successfully! (' + chatCount + ' chats)', 'success');
    } catch (e) {
        if (e.name === 'AbortError') return; // User cancelled file picker
        console.error('Export failed:', e);
        showSnackbar('Export failed: ' + e.message, 'error');
    }
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
            
            // Handle single chat import
            if (importData.exportType === 'single_chat' && importData.chat) {
                var importedChat = importData.chat;
                var newId = 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                importedChat.id = newId;
                importedChat.title = importedChat.title + ' (imported)';
                // The import-time name is authoritative — drop a serialized
                // provisional flag so the auto-title hook doesn't re-title the
                // chat (losing the '(imported)' marker) on its next run.
                delete importedChat.titleProvisional;
                delete importedChat._titleHookTries;
                importedChat.createdAt = Date.now();
                chats[newId] = importedChat;
                await saveChatsToStorage();
                renderChatList();
                showSnackbar('Chat imported successfully', 'success');
                return;
            }
            
            // Handle full data import
            if (!importData.chats || !importData.settings) {
                throw new Error('Invalid backup file format');
            }
            
            if (!await showConfirmModal('Import Data', 'This will merge imported data with existing data. Continue?')) {
                return;
            }
            
            var database = await openDatabase();
            
            // Import chats
            var chatTransaction = database.transaction([chatStoreName], 'readwrite');
            var chatStore = chatTransaction.objectStore(chatStoreName);
            for (var i = 0; i < importData.chats.length; i++) {
                chatStore.put(importData.chats[i]);
            }
            
            // Import settings
            var settingsTransaction = database.transaction([settingsStoreName], 'readwrite');
            var settingsStore = settingsTransaction.objectStore(settingsStoreName);
            for (var j = 0; j < importData.settings.length; j++) {
                settingsStore.put(importData.settings[j]);
            }
            
            // Import dashboard widgets (if present)
            if (importData.dashboardWidgets && importData.dashboardWidgets.length > 0 && database.objectStoreNames.contains(dashboardWidgetsStoreName)) {
                var dashboardTransaction = database.transaction([dashboardWidgetsStoreName], 'readwrite');
                var dashboardStore = dashboardTransaction.objectStore(dashboardWidgetsStoreName);
                for (var k = 0; k < importData.dashboardWidgets.length; k++) {
                    dashboardStore.put(importData.dashboardWidgets[k]);
                }
            }
            
            // Import API providers (if present)
            if (importData.apiProviders && importData.apiProviders.length > 0 && database.objectStoreNames.contains(apiProvidersStoreName)) {
                var apiProvidersTransaction = database.transaction([apiProvidersStoreName], 'readwrite');
                var apiProvidersStore = apiProvidersTransaction.objectStore(apiProvidersStoreName);
                for (var m = 0; m < importData.apiProviders.length; m++) {
                    apiProvidersStore.put(importData.apiProviders[m]);
                }
            }
            
            // Import LLM endpoints (if present) — providers reference these by
            // endpointId, so they round-trip together with apiProviders.
            if (importData.llmEndpoints && importData.llmEndpoints.length > 0 && database.objectStoreNames.contains(llmEndpointsStoreName)) {
                var llmEndpointsTransaction = database.transaction([llmEndpointsStoreName], 'readwrite');
                var llmEndpointsStore = llmEndpointsTransaction.objectStore(llmEndpointsStoreName);
                for (var n = 0; n < importData.llmEndpoints.length; n++) {
                    llmEndpointsStore.put(importData.llmEndpoints[n]);
                }
            }
            
            showSnackbar('Data imported successfully! Reloading...', 'success');
            window.location.reload();
        } catch (e) {
            console.error('Import failed:', e);
            showSnackbar('Import failed: ' + e.message, 'error');
        }
    };
    input.click();
}

async function deleteAllData() {
    if (!await showConfirmModal('Delete All Data', 'Are you sure you want to delete ALL data? This cannot be undone!', 'danger')) {
        return;
    }
    if (!await showConfirmModal('Confirm Delete', 'This will delete all chats, settings, and preferences. Are you REALLY sure?', 'danger')) {
        return;
    }

    try {
        var database = await openDatabase();

        // Clear chats (and their payload blobs — chat_payloads holds the
        // base64 content the records reference; orphaning it here would
        // leave the heaviest data behind after "delete ALL data")
        var chatTransaction = database.transaction([chatStoreName, chatPayloadsStoreName], 'readwrite');
        chatTransaction.objectStore(chatStoreName).clear();
        chatTransaction.objectStore(chatPayloadsStoreName).clear();

        // Clear settings
        var settingsTransaction = database.transaction([settingsStoreName], 'readwrite');
        settingsTransaction.objectStore(settingsStoreName).clear();

        // Clear dashboard widgets
        if (database.objectStoreNames.contains(dashboardWidgetsStoreName)) {
            var dashboardTransaction = database.transaction([dashboardWidgetsStoreName], 'readwrite');
            dashboardTransaction.objectStore(dashboardWidgetsStoreName).clear();
        }

        showSnackbar('All data deleted! Reloading...', 'success');
        window.location.reload();
    } catch (e) {
        console.error('Delete failed:', e);
        showSnackbar('Delete failed: ' + e.message, 'error');
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
            panel.style.right = (window.innerWidth - rect.right) + 'px';
        }
        panel.classList.add('visible');
        // Sync the theme segmented control with the persisted pref (same
        // mechanism as the settings page: appTheme + setAppTheme).
        if (typeof syncSettingsPanelTheme === 'function') syncSettingsPanelTheme();
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
    if (panel) panel.classList.remove('visible');
    document.removeEventListener('click', closeSettingsPanelOnOutsideClick);
}
