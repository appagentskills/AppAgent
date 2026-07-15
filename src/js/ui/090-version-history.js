// Version History Functions
// getRecordScope / getRecordVersion / getRecordDisplayValue moved to
// js/core/150-record-helpers.js so both the page bundle AND the SW
// share one DOM-free implementation. Imports/usages below resolve to
// the new helpers at runtime via global hoisting.

// Common helper function for sys_upload.do with scope support
async function uploadXml(xml, table, sysId) {
    if (!xml) return { success: false, error: 'No XML provided' };
    
    try {
        // Get the record's scope for cross-scope operations
        var recordScope = sysId ? await getRecordScope(table, sysId) : null;
        
        var form = new FormData();
        var blob = new Blob([xml], { type: 'application/xml' });
        form.append('file', blob, 'import.xml');
        form.append('sysparm_referring_url', table + '_list.do');
        form.append('sysparm_target', table);
        
        // Build URL with scope as query parameter (like REST API calls)
        var uploadUrl = '/sys_upload.do';
        if (recordScope) {
            uploadUrl += '?sysparm_record_scope=' + encodeURIComponent(recordScope);
        }
        
        var res = await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'X-UserToken': window.sessionToken },
            body: form
        });
        
        var responseText = await res.text();
        
        // Check for actual import success - sys_upload.do returns HTML
        var importFailed = responseText.includes('Import failed') || 
                          responseText.includes('Error during import') ||
                          responseText.includes('class="error"') ||
                          (responseText.includes('outputmsg_error') && !responseText.includes('outputmsg_success'));
        
        if (res.ok && !importFailed) {
            return { success: true };
        } else {
            console.error('Upload failed. Response:', responseText);
            return { success: false, error: importFailed ? 'Import failed' : 'HTTP ' + res.status, response: responseText };
        }
    } catch (e) {
        console.error('Upload exception:', e);
        return { success: false, error: e.message };
    }
}

async function getVersionXml(versionSysId) {
    if (!versionSysId || !_recValidSysId.test(versionSysId)) return null;
    try {
        var headers = { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' };
        var res = await fetch('/api/now/table/sys_update_version/' + versionSysId + '?sysparm_fields=payload', { headers: headers });
        var data = await res.json();
        if (data.result && data.result.payload) {
            return data.result.payload;
        }
    } catch (e) {
        console.error('Failed to get version XML:', e);
    }
    return null;
}

// Latest XML for a record, for download/preview. Prefers the newest
// chat-tracked sys_update_version payload, then any live version on the
// instance, then falls back to the <table>.do?XML export — data tables
// (incident, sys_user, …) are not update-set tracked and have NO versions,
// so without the export fallback download/preview dead-ends with
// "No version to download".
async function getLatestRecordXml(table, sysId) {
    try {
        var latestAfterVersion = (typeof getLatestAfterVersion === 'function')
            ? getLatestAfterVersion(table, sysId) : null;
        var xml = latestAfterVersion ? await getVersionXml(latestAfterVersion) : null;
        if (!xml) {
            var liveVersion = await getRecordVersion(table, sysId);
            if (liveVersion) xml = await getVersionXml(liveVersion.sys_id);
        }
        if (!xml) {
            if (!_recValidTable.test(table) || !_recValidSysId.test(sysId)) return null;
            var res = await fetch('/' + table + '.do?XML&sys_id=' + sysId, {
                headers: { 'X-UserToken': window.sessionToken }
            });
            if (res.ok) xml = await res.text();
        }
        return xml || null;
    } catch (e) {
        console.error('Failed to get record XML:', e);
        return null;
    }
}

function addVersionHistoryEntry(entry) {
    versionHistory.push(entry);
    saveVersionHistory();
    renderVersionSidebar();
    updateVersionSidebarVisibility();
    // Re-render messages to show inline changes
    renderMessages();
}

// Variant used by the recordMutated event handler. The event carries the
// chatId that mutated the record, which may not be the chat the user is
// currently viewing (background chats, multi-agent). Write to the target
// chat's persisted history directly; only refresh UI when it's the active
// chat (since versionHistory is the active-chat mirror).
function addVersionHistoryEntryForChat(chatId, entry) {
    if (!chatId) return;
    var chat = chats[chatId];
    if (!chat) return;
    if (!Array.isArray(chat.versionHistory)) chat.versionHistory = [];
    // Dedupe by id: the executing tier (trackRecordMutation in
    // tools/020-tool-execution.js) already appended this entry to the
    // authoritative chat, and it may have reached the page mirror via a
    // chat-inlined broadcast before this event handler ran.
    var already = entry && entry.id && chat.versionHistory.some(function(v) { return v && v.id === entry.id; });
    if (!already) chat.versionHistory.push(entry);
    if (chatId === currentChatId) {
        versionHistory = chat.versionHistory;
        renderVersionSidebar();
        updateVersionSidebarVisibility();
        renderMessages();
    }
    saveChatsToStorage();
}

// Get changes for a specific user message (all changes until next user message)
function getChangesForUserMessage(userMsgIndex) {
    var chat = chats[currentChatId];
    if (!chat) return [];
    
    // Find the next user message index
    var nextUserMsgIndex = chat.messages.length;
    for (var i = userMsgIndex + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserMsgIndex = i;
            break;
        }
    }
    
    // Get all version history entries for this message range (exclude reverted/invalidated)
    return versionHistory.filter(function(v) {
        return v.chatId === currentChatId && 
               v.messageIndex >= userMsgIndex && 
               v.messageIndex < nextUserMsgIndex &&
               v.action !== 'REVERT' &&
               !v.invalidated;
    });
}

// Get the first version (before chat started) for a record
function getFirstVersionForRecord(table, sysId) {
    var entries = versionHistory.filter(function(v) {
        return v.chatId === currentChatId && 
               v.table === table && 
               v.sysId === sysId &&
               v.action !== 'REVERT' &&
               !v.invalidated;
    });
    if (entries.length > 0) {
        // Sort by timestamp and return the beforeVersion of the first change
        entries.sort(function(a, b) { return a.timestamp - b.timestamp; });
        return entries[0].beforeVersion;
    }
    return null;
}

// Get all unique files changed in this chat
function getAllChangedFiles() {
    var files = {};
    versionHistory.forEach(function(v) {
        if (v.chatId === currentChatId && v.action !== 'REVERT' && v.action !== 'USER_DELETE' && !v.invalidated) {
            var key = v.table + '_' + v.sysId;
            if (!files[key]) {
                files[key] = {
                    table: v.table,
                    sysId: v.sysId,
                    displayName: v.displayName,
                    firstBeforeVersion: v.beforeVersion,
                    changes: []
                };
            }
            files[key].changes.push(v);
        }
    });
    return Object.values(files);
}

// Get reverted files that can be redone
function getRevertedFiles() {
    var reverted = {};
    versionHistory.forEach(function(v) {
        if (v.chatId === currentChatId && v.action === 'REVERT' && v.afterVersion && v.table !== 'batch') {
            var key = v.table + '_' + v.sysId;
            // Only show if the original changes are invalidated
            var hasInvalidated = versionHistory.some(function(h) {
                return h.chatId === currentChatId && h.table === v.table && h.sysId === v.sysId && h.invalidated;
            });
            if (hasInvalidated) {
                reverted[key] = {
                    table: v.table,
                    sysId: v.sysId,
                    displayName: v.displayName,
                    revertedToVersion: v.afterVersion,
                    revertTimestamp: v.timestamp
                };
            }
        }
    });
    return Object.values(reverted);
}

// Get the latest after version for a record (to redo changes)
function getLatestAfterVersion(table, sysId) {
    var entries = versionHistory.filter(function(v) {
        return v.chatId === currentChatId && 
               v.table === table && 
               v.sysId === sysId &&
               v.action !== 'REVERT' &&
               v.action !== 'USER_DELETE' &&
               v.afterVersion;
    });
    if (entries.length > 0) {
        entries.sort(function(a, b) { return b.timestamp - a.timestamp; });
        return entries[0].afterVersion;
    }
    return null;
}

// Download XML with all changed files in current chat
async function downloadChangesXml() {
    var changedFiles = getAllChangedFiles();
    if (changedFiles.length === 0) {
        showSnackbar('No changes to download', 'warning');
        return;
    }
    
    showSpinner('Preparing XML download...');
    
    try {
        // Collect all version XMLs for the latest state of each file
        var recordXmls = [];
        
        for (var i = 0; i < changedFiles.length; i++) {
            var file = changedFiles[i];
            var latestAfterVersion = getLatestAfterVersion(file.table, file.sysId);
            
            if (latestAfterVersion) {
                var xml = await getVersionXml(latestAfterVersion);
                if (xml) {
                    recordXmls.push(xml);
                }
            }
        }
        
        if (recordXmls.length === 0) {
            hideSpinner();
            showSnackbar('Could not retrieve version data for any files', 'error');
            return;
        }
        
        // Generate file name
        var chat = chats[currentChatId];
        var chatTitle = chat && chat.title ? chat.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30) : 'chat';
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        var fileName = 'AppAgent_' + chatTitle + '_' + timestamp + '.xml';
        
        // Combine all record XMLs into one update set XML
        var combinedXml = buildUpdateSetXml(recordXmls);
        
        // Download the file
        var blob = new Blob([combinedXml], { type: 'application/xml' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        hideSpinner();
        
    } catch (e) {
        hideSpinner();
        showSnackbar('Error downloading XML: ' + e.message, 'error');
    }
}

// Build the update set XML from individual record XMLs
function buildUpdateSetXml(recordXmls) {
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<unload unload_date="' + new Date().toISOString().replace('T', ' ').substring(0, 19) + '">\n';
    
    recordXmls.forEach(function(recXml) {
        // Extract the actual record element, removing <unload> and <record_update> wrappers
        var content = recXml;
        
        // Remove XML declaration
        content = content.replace(/<\?xml[^?]*\?>/gi, '');
        
        // Extract content from <unload> if present
        var unloadMatch = content.match(/<unload[^>]*>([\s\S]*)<\/unload>/i);
        if (unloadMatch) {
            content = unloadMatch[1];
        }
        
        // Remove <record_update> wrapper if present, keeping the inner record element
        var recordUpdateMatch = content.match(/<record_update[^>]*>([\s\S]*)<\/record_update>/i);
        if (recordUpdateMatch) {
            content = recordUpdateMatch[1];
        }
        
        xml += content.trim() + '\n';
    });
    
    xml += '</unload>';
    return xml;
}

// Legacy function for compatibility
function clearUpdateSet() {
    // No longer needed but kept for compatibility
}

// Get all changes for a user message (including reverted ones for display)
function getAllChangesForUserMessage(userMsgIndex) {
    var chat = chats[currentChatId];
    if (!chat) return { active: [], reverted: [] };
    
    // Find the next user message index
    var nextUserMsgIndex = chat.messages.length;
    for (var i = userMsgIndex + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserMsgIndex = i;
            break;
        }
    }
    
    var active = [];
    var reverted = [];
    
    versionHistory.forEach(function(v) {
        if (v.chatId === currentChatId && 
            v.messageIndex >= userMsgIndex && 
            v.messageIndex < nextUserMsgIndex &&
            v.action !== 'REVERT' &&
            v.action !== 'USER_DELETE') {
            if (v.invalidated) {
                reverted.push(v);
            } else {
                active.push(v);
            }
        }
    });
    
    return { active: active, reverted: reverted };
}

// Render inline changes for a message block
function renderInlineChanges(userMsgIdx) {
    var allChanges = getAllChangesForUserMessage(userMsgIdx);
    
    if (allChanges.active.length === 0 && allChanges.reverted.length === 0) return '';
    
    // Group active changes by file
    var activeByFile = {};
    allChanges.active.forEach(function(c) {
        var key = c.table + '_' + c.sysId;
        if (!activeByFile[key]) {
            activeByFile[key] = { displayName: c.displayName, table: c.table, sysId: c.sysId, entries: [], beforeVersion: c.beforeVersion, isNew: false };
        }
        activeByFile[key].entries.push(c);
        activeByFile[key].afterVersion = c.afterVersion;
        if (c.action === 'POST') activeByFile[key].isNew = true;
    });
    
    // Group reverted changes by file
    var revertedByFile = {};
    allChanges.reverted.forEach(function(c) {
        var key = c.table + '_' + c.sysId;
        if (!revertedByFile[key]) {
            revertedByFile[key] = { displayName: c.displayName, table: c.table, sysId: c.sysId, entries: [], isNew: false };
        }
        revertedByFile[key].entries.push(c);
        revertedByFile[key].afterVersion = c.afterVersion;
        if (c.action === 'POST') revertedByFile[key].isNew = true;
    });
    
    var activeFiles = Object.values(activeByFile);
    var revertedFiles = Object.values(revertedByFile);
    
    var totalFiles = activeFiles.length + revertedFiles.length;
    var html = '<div class="inline-changes">';
    html += '<div class="inline-changes-header">Artifacts' + (totalFiles === 1 ? '' : ' (' + totalFiles + ')');
    // Add Revert All button if there are active files, or Redo All if there are reverted files
    if (activeFiles.length > 0) {
        html += '<button class="inline-revert-all-btn" onclick="revertAllInlineChanges(' + userMsgIdx + ')" title="Undo all changes from this response"><span class="btn-icon">' + UI_ICONS.undo + '</span>Revert All</button>';
    }
    if (revertedFiles.length > 0) {
        html += '<button class="inline-redo-all-btn" onclick="redoAllInlineChanges(' + userMsgIdx + ')" title="Redo all reverted changes from this response"><span class="btn-icon">' + UI_ICONS.redo + '</span>Redo All</button>';
    }
    html += '</div>';
    html += '<div class="inline-changes-list">';
    
    // Show active changes with icon buttons (same as sidebar)
    activeFiles.forEach(function(file, idx) {
        var beforeVer = file.beforeVersion;
        var isNew = file.isNew;
        var hasEdit = file.entries.some(function(e) { return e.action === 'PUT' || e.action === 'PATCH'; });
        var tableIcon = getTableIcon(file.table);
        var tableDisplayName = getTableDisplayName(file.table);
        var statusBadge = isNew ? '<span class="sn-status-badge sn-status-new">NEW</span>' : (hasEdit ? '<span class="sn-status-badge sn-status-modified">MODIFIED</span>' : '');

        var jsTable = escapeJsString(file.table);
        var jsSysId = escapeJsString(file.sysId);
        var jsDisplayName = escapeJsString(file.displayName);

        html += '<div class="sn-artifact-card">';
        html += '<div class="sn-artifact-icon sn-icon-' + file.table.replace(/_/g, '-') + '">' + tableIcon + '</div>';
        html += '<div class="sn-artifact-content">';
        html += '<div class="sn-artifact-name">' + escapeHtml(file.displayName) + '</div>';
        html += '<div class="sn-artifact-meta">(' + tableDisplayName + ') ' + statusBadge + '</div>';
        html += '</div>';
        html += '<div class="sn-artifact-actions-row">';
        // View diff button
        html += '<button class="sn-artifact-icon-btn" onclick="openDiffViewer(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="View changes">' + UI_ICONS.eye + '</button>';
        // Download button
        html += '<button class="sn-artifact-icon-btn" onclick="downloadSingleFile(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\')" title="Download XML">' + UI_ICONS.download + '</button>';
        // Open in browser for UI pages
        if (file.table === 'sys_ui_page') {
            html += '<button class="sn-artifact-icon-btn" onclick="openUIPageInBrowser(\'' + jsDisplayName + '\')" title="Open in Browser">' + UI_ICONS.globe + '</button>';
            html += '<button class="sn-artifact-icon-btn" onclick="screenshotUIPage(\'' + jsDisplayName + '\')" title="Screenshot">' + UI_ICONS.camera + '</button>';
        }
        // Undo/Delete button
        if (isNew) {
            html += '<button class="sn-artifact-icon-btn danger" onclick="deleteNewRecord(\'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\', ' + userMsgIdx + ')" title="Delete">' + UI_ICONS.trash + '</button>';
        } else if (beforeVer) {
            html += '<button class="sn-artifact-icon-btn" onclick="revertInlineChange(\'' + beforeVer + '\', \'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\', ' + userMsgIdx + ')" title="Undo">' + UI_ICONS.undo + '</button>';
        }
        html += '</div>';
        html += '</div>';
    });

    // Show reverted changes with icon buttons
    revertedFiles.forEach(function(file, idx) {
        var afterVer = file.afterVersion;
        var tableIcon = getTableIcon(file.table);
        var tableDisplayName = getTableDisplayName(file.table);

        var jsTable = escapeJsString(file.table);
        var jsSysId = escapeJsString(file.sysId);
        var jsDisplayName = escapeJsString(file.displayName);

        html += '<div class="sn-artifact-card reverted">';
        html += '<div class="sn-artifact-icon sn-icon-reverted">' + tableIcon + '</div>';
        html += '<div class="sn-artifact-content">';
        html += '<div class="sn-artifact-name">' + escapeHtml(file.displayName) + '</div>';
        html += '<div class="sn-artifact-meta">(' + tableDisplayName + ') <span class="sn-status-badge sn-status-reverted">REVERTED</span></div>';
        html += '</div>';
        html += '<div class="sn-artifact-actions-row">';
        if (afterVer) {
            html += '<button class="sn-artifact-icon-btn" onclick="redoInlineChange(\'' + afterVer + '\', \'' + jsTable + '\', \'' + jsSysId + '\', \'' + jsDisplayName + '\', ' + userMsgIdx + ')" title="Redo">' + UI_ICONS.redo + '</button>';
        }
        html += '</div>';
        html += '</div>';
    });
    
    html += '</div></div>';
    return html;
}

// Revert a single inline change (only for changes in a specific user message range)
async function revertInlineChange(versionSysId, table, sysId, displayName, userMsgIdx) {
    if (!await showConfirmModal('Undo Changes', 'Undo changes to "' + displayName + '"? This will restore the file to its state before this AI response.')) return;
    
    // Find the message range for this user message
    var chat = chats[currentChatId];
    var nextUserMsgIdx = chat.messages.length;
    for (var i = userMsgIdx + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserMsgIdx = i;
            break;
        }
    }
    
    try {
        showSpinner('Reverting ' + displayName + '...');
        
        var xml = await getVersionXml(versionSysId);
        if (!xml) {
            hideSpinner();
            showSnackbar('Could not get version data', 'error');
            return;
        }

        var result = await uploadXml(xml, table, sysId);
        hideSpinner();

        if (result.success) {
            // Only mark entries for this file within this message range as invalidated
            versionHistory.forEach(function(v, idx) {
                if (v.table === table && v.sysId === sysId && v.chatId === currentChatId &&
                    v.messageIndex >= userMsgIdx && v.messageIndex < nextUserMsgIdx &&
                    v.action !== 'REVERT') {
                    versionHistory[idx].invalidated = true;
                }
            });

            // Add revert entry with the user message index
            addVersionHistoryEntry({
                id: 'vh_' + Date.now(),
                chatId: currentChatId,
                timestamp: Date.now(),
                table: table,
                sysId: sysId,
                displayName: displayName,
                action: 'REVERT',
                messageIndex: userMsgIdx,
                revertedUserMsgIdx: userMsgIdx,
                afterVersion: versionSysId
            });

            showSnackbar('Successfully reverted "' + displayName + '"', 'success');
        } else {
            showSnackbar('Revert failed: ' + result.error, 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar('Revert failed: ' + e.message, 'error');
    }
}

// Revert all inline changes for a specific user message range
async function revertAllInlineChanges(userMsgIdx) {
    var allChanges = getAllChangesForUserMessage(userMsgIdx);
    if (allChanges.active.length === 0) {
        showSnackbar('No active changes to revert', 'warning');
        return;
    }
    
    // Group by file and track afterVersion for redo
    var filesByKey = {};
    allChanges.active.forEach(function(c) {
        var key = c.table + '_' + c.sysId;
        if (!filesByKey[key]) {
            filesByKey[key] = { table: c.table, sysId: c.sysId, displayName: c.displayName, beforeVersion: c.beforeVersion, afterVersion: c.afterVersion, isNew: c.action === 'POST' };
        }
        // Keep the latest afterVersion for redo
        if (c.afterVersion) {
            filesByKey[key].afterVersion = c.afterVersion;
        }
    });
    
    var files = Object.values(filesByKey);
    if (!await showConfirmModal('Revert All', 'Revert all ' + files.length + ' file(s) changed in this response?')) return;
    
    var chat = chats[currentChatId];
    var nextUserMsgIdx = chat.messages.length;
    for (var i = userMsgIdx + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserMsgIdx = i;
            break;
        }
    }
    
    showSpinner('Reverting ' + files.length + ' files...');
    var successCount = 0;
    var errors = [];
    
    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        try {
            if (file.isNew) {
                // Delete new records - first check if it exists
                try {
                    var checkRes = await fetch('/api/now/table/' + file.table + '/' + file.sysId + '?sysparm_fields=sys_id', { 
                        method: 'GET', 
                        headers: { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' } 
                    });
                    if (checkRes.ok) {
                        // Record exists, delete it
                        var recordScope = await getRecordScope(file.table, file.sysId);
                        var deleteUrl = '/api/now/table/' + file.table + '/' + file.sysId;
                        if (recordScope) deleteUrl += '?sysparm_record_scope=' + encodeURIComponent(recordScope);
                        var res = await fetch(deleteUrl, { method: 'DELETE', headers: { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' } });
                        if (res.ok || res.status === 204) {
                            successCount++;
                        } else {
                            errors.push(file.displayName + ': Delete failed ' + res.status);
                        }
                    } else if (checkRes.status === 404) {
                        // Record already deleted, count as success
                        successCount++;
                    } else {
                        errors.push(file.displayName + ': Check failed ' + checkRes.status);
                    }
                } catch (checkErr) {
                    errors.push(file.displayName + ': ' + checkErr.message);
                }
                // Mark as invalidated regardless
                versionHistory.forEach(function(v, idx) {
                    if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId &&
                        v.messageIndex >= userMsgIdx && v.messageIndex < nextUserMsgIdx && v.action !== 'REVERT') {
                        versionHistory[idx].invalidated = true;
                    }
                });
                // Add REVERT entry for new files so they can be redone/recreated
                var latestAfterVersionNew = null;
                versionHistory.forEach(function(v) {
                    if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId && 
                        v.afterVersion && v.action !== 'REVERT') {
                        latestAfterVersionNew = v.afterVersion;
                    }
                });
                if (latestAfterVersionNew) {
                    versionHistory.push({
                        id: 'vh_' + Date.now() + '_new_' + i,
                        chatId: currentChatId,
                        timestamp: Date.now(),
                        table: file.table,
                        sysId: file.sysId,
                        displayName: file.displayName,
                        action: 'REVERT',
                        messageIndex: userMsgIdx,
                        revertedUserMsgIdx: userMsgIdx,
                        afterVersion: latestAfterVersionNew,
                        wasNew: true
                    });
                }
            } else if (file.beforeVersion) {
                // Revert existing records
                var xml = await getVersionXml(file.beforeVersion);
                if (xml) {
                    var result = await uploadXml(xml, file.table, file.sysId);
                    if (result.success) {
                        successCount++;
                        versionHistory.forEach(function(v, idx) {
                            if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId &&
                                v.messageIndex >= userMsgIdx && v.messageIndex < nextUserMsgIdx && v.action !== 'REVERT') {
                                versionHistory[idx].invalidated = true;
                            }
                        });
                        // Add REVERT entry so file appears in "Reverted Changes" for redo
                        var latestAfterVersion = null;
                        versionHistory.forEach(function(v) {
                            if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId && 
                                v.afterVersion && v.action !== 'REVERT') {
                                latestAfterVersion = v.afterVersion;
                            }
                        });
                        if (latestAfterVersion) {
                            versionHistory.push({
                                id: 'vh_' + Date.now() + '_' + i,
                                chatId: currentChatId,
                                timestamp: Date.now(),
                                table: file.table,
                                sysId: file.sysId,
                                displayName: file.displayName,
                                action: 'REVERT',
                                messageIndex: userMsgIdx,
                                revertedUserMsgIdx: userMsgIdx,
                                afterVersion: latestAfterVersion
                            });
                        }
                    } else {
                        errors.push(file.displayName + ': ' + result.error);
                    }
                }
            }
        } catch (e) {
            errors.push(file.displayName + ': ' + e.message);
        }
    }
    
    hideSpinner();
    saveVersionHistory();
    renderVersionSidebar();
    renderMessages();
    
    if (errors.length > 0) {
        showSnackbar('Reverted ' + successCount + ' of ' + files.length + ' files.\n\nErrors:\n' + errors.join('\n'), 'warning');
    } else {
        showSnackbar('Successfully reverted ' + successCount + ' files', 'success');
    }
}

// Redo an inline change that was reverted
async function redoInlineChange(versionSysId, table, sysId, displayName, userMsgIdx) {
    if (!await showConfirmModal('Redo Changes', 'Redo changes to "' + displayName + '"? This will restore the AI-made changes.')) return;
    
    // Find the message range for this user message
    var chat = chats[currentChatId];
    var nextUserMsgIdx = chat.messages.length;
    for (var i = userMsgIdx + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserMsgIdx = i;
            break;
        }
    }
    
    try {
        showSpinner('Restoring ' + displayName + '...');
        
        var xml = await getVersionXml(versionSysId);
        if (!xml) {
            hideSpinner();
            showSnackbar('Could not get version data', 'error');
            return;
        }

        var result = await uploadXml(xml, table, sysId);
        hideSpinner();

        if (result.success) {
            // Un-invalidate entries for this file within this message range
            versionHistory.forEach(function(v, idx) {
                if (v.table === table && v.sysId === sysId && v.chatId === currentChatId &&
                    v.messageIndex >= userMsgIdx && v.messageIndex < nextUserMsgIdx &&
                    v.action !== 'REVERT') {
                    versionHistory[idx].invalidated = false;
                }
            });

            // Remove the revert entry for this specific user message
            versionHistory = versionHistory.filter(function(v) {
                return !(v.table === table && v.sysId === sysId && v.chatId === currentChatId &&
                         v.action === 'REVERT' && v.revertedUserMsgIdx === userMsgIdx);
            });

            saveVersionHistory();
            renderVersionSidebar();
            renderMessages();

            showSnackbar('Successfully restored "' + displayName + '"', 'success');
        } else {
            showSnackbar('Redo failed: ' + result.error, 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar('Redo failed: ' + e.message, 'error');
    }
}

// Redo all inline changes that were reverted for a specific user message
async function redoAllInlineChanges(userMsgIdx) {
    var allChanges = getAllChangesForUserMessage(userMsgIdx);
    if (allChanges.reverted.length === 0) {
        showSnackbar('No reverted changes to redo', 'warning');
        return;
    }
    
    // Group by file
    var filesByKey = {};
    allChanges.reverted.forEach(function(c) {
        var key = c.table + '_' + c.sysId;
        if (!filesByKey[key]) {
            filesByKey[key] = { table: c.table, sysId: c.sysId, displayName: c.displayName, afterVersion: c.afterVersion };
        }
        if (c.afterVersion) {
            filesByKey[key].afterVersion = c.afterVersion;
        }
    });
    
    var files = Object.values(filesByKey);
    if (!await showConfirmModal('Redo All', 'Redo all ' + files.length + ' reverted file(s) from this response?')) return;
    
    var chat = chats[currentChatId];
    var nextUserMsgIdx = chat.messages.length;
    for (var i = userMsgIdx + 1; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') {
            nextUserMsgIdx = i;
            break;
        }
    }
    
    showSpinner('Restoring ' + files.length + ' files...');
    var successCount = 0;
    var errors = [];
    
    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        try {
            // Find the latest afterVersion for this file
            var latestAfterVersion = null;
            versionHistory.forEach(function(v) {
                if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId && 
                    v.afterVersion && v.action !== 'REVERT') {
                    latestAfterVersion = v.afterVersion;
                }
            });
            
            if (!latestAfterVersion) {
                errors.push(file.displayName + ': No version to restore');
                continue;
            }
            
            var xml = await getVersionXml(latestAfterVersion);
            if (!xml) {
                errors.push(file.displayName + ': Could not get version data');
                continue;
            }
            
            var result = await uploadXml(xml, file.table, file.sysId);
            if (result.success) {
                successCount++;
                // Un-invalidate entries for this file within this message range
                versionHistory.forEach(function(v, idx) {
                    if (v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId &&
                        v.messageIndex >= userMsgIdx && v.messageIndex < nextUserMsgIdx &&
                        v.action !== 'REVERT') {
                        versionHistory[idx].invalidated = false;
                    }
                });
                // Remove REVERT entries for this file within this message range
                versionHistory = versionHistory.filter(function(v) {
                    return !(v.table === file.table && v.sysId === file.sysId && v.chatId === currentChatId && 
                             v.action === 'REVERT' && v.revertedUserMsgIdx === userMsgIdx);
                });
            } else {
                errors.push(file.displayName + ': ' + result.error);
            }
        } catch (e) {
            errors.push(file.displayName + ': ' + e.message);
        }
    }
    
    hideSpinner();
    saveVersionHistory();
    renderVersionSidebar();
    renderMessages();
    
    if (errors.length > 0) {
        showSnackbar('Restored ' + successCount + ' of ' + files.length + ' files.\n\nErrors:\n' + errors.join('\n'), 'warning');
    } else {
        showSnackbar('Successfully restored ' + successCount + ' files', 'success');
    }
}

// Delete a newly created record
async function deleteNewRecord(table, sysId, displayName, userMsgIdx) {
    if (!await showConfirmModal('Delete Record', 'Delete "' + displayName + '"? This will permanently delete this newly created record.', 'danger')) return;

    try {
        showSpinner('Deleting ' + displayName + '...');

        var headers = { 
            'X-UserToken': window.sessionToken, 
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
        
        // Get record's scope for delete request
        var recordScope = await getRecordScope(table, sysId);
        var deleteUrl = '/api/now/table/' + table + '/' + sysId;
        if (recordScope) {
            deleteUrl += '?sysparm_record_scope=' + encodeURIComponent(recordScope);
        }

        var res = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: headers
        });

        hideSpinner();

        if (res.ok || res.status === 204) {
            // Find the message range for this user message
            var chat = chats[currentChatId];
            var nextUserMsgIdx = chat.messages.length;
            for (var i = userMsgIdx + 1; i < chat.messages.length; i++) {
                if (chat.messages[i].role === 'user') {
                    nextUserMsgIdx = i;
                    break;
                }
            }

            // Mark entries for this file within this message range as invalidated
            versionHistory.forEach(function(v, idx) {
                if (v.table === table && v.sysId === sysId && v.chatId === currentChatId &&
                    v.messageIndex >= userMsgIdx && v.messageIndex < nextUserMsgIdx &&
                    v.action !== 'REVERT') {
                    versionHistory[idx].invalidated = true;
                }
            });

            // Add delete entry
            addVersionHistoryEntry({
                id: 'vh_' + Date.now(),
                chatId: currentChatId,
                timestamp: Date.now(),
                table: table,
                sysId: sysId,
                displayName: displayName,
                action: 'USER_DELETE',
                messageIndex: userMsgIdx
            });

            showSnackbar('Successfully deleted "' + displayName + '"', 'success');
        } else {
            var errData = await res.json().catch(function() { return {}; });
            showSnackbar('Delete failed: ' + (errData.error?.message || res.status), 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar('Delete failed: ' + e.message, 'error');
    }
}

function saveVersionHistory() {
    if (currentChatId && chats[currentChatId]) {
        chats[currentChatId].versionHistory = versionHistory;
        saveChatsToStorage();
    }
}

function loadVersionHistory() {
    if (currentChatId && chats[currentChatId] && chats[currentChatId].versionHistory) {
        versionHistory = chats[currentChatId].versionHistory;
    } else {
        versionHistory = [];
    }
    renderVersionSidebar();
    updateVersionSidebarVisibility();
}

// Get all versions for a specific file in this chat
function getVersionsForFile(table, sysId) {
    var versions = [];
    versionHistory.forEach(function(v) {
        if (v.chatId === currentChatId && v.table === table && v.sysId === sysId &&
            v.action !== 'REVERT' && v.action !== 'USER_DELETE' && !v.invalidated) {
            if (v.beforeVersion) {
                var exists = versions.some(function(ver) { return ver.versionId === v.beforeVersion; });
                if (!exists) {
                    versions.push({
                        versionId: v.beforeVersion,
                        timestamp: v.timestamp,
                        label: new Date(v.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) + ' - Original',
                        isBefore: true,
                        isFromChat: true
                    });
                }
            }
            if (v.afterVersion) {
                var statusMsg = v.statusMessage;
                var actionLabel = statusMsg || (v.action === 'POST' ? 'Created' : (v.action === 'PUT' || v.action === 'PATCH' || v.action === 'EDIT' ? 'Updated' : v.action));
                versions.push({
                    versionId: v.afterVersion,
                    timestamp: v.timestamp,
                    label: new Date(v.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) + ' - ' + actionLabel,
                    isBefore: false,
                    isFromChat: true
                });
            }
        }
    });
    // Sort by timestamp
    versions.sort(function(a, b) { return a.timestamp - b.timestamp; });
    return versions;
}

// Fetch historical versions for a record from sys_update_version (before the chat)
async function getHistoricalVersions(table, sysId, excludeVersionIds) {
    try {
        var headers = { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' };
        var res = await fetch('/api/now/table/sys_update_version?sysparm_query=name=' + table + '_' + sysId + '^ORDERBYDESCsys_created_on&sysparm_fields=sys_id,sys_created_on,sys_created_by&sysparm_limit=10', { headers: headers });
        var data = await res.json();
        if (data.result && data.result.length > 0) {
            return data.result
                .filter(function(v) { return !excludeVersionIds.includes(v.sys_id); })
                .map(function(v) {
                    var ts = new Date(v.sys_created_on).getTime();
                    return {
                        versionId: v.sys_id,
                        timestamp: ts,
                        label: new Date(ts).toLocaleDateString([], {month: 'short', day: 'numeric'}) + ' ' + new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) + ' - ' + (v.sys_created_by || 'Unknown'),
                        isBefore: true,
                        isFromChat: false
                    };
                });
        }
    } catch (e) {
        console.error('Failed to get historical versions:', e);
    }
    return [];
}

// Normalize line endings to \n for consistent diff
function normalizeLineEndings(text) {
    if (!text) return '';
    // Replace \r\n (Windows) and \r (old Mac) with \n (Unix)
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Pretty-print XML using DOMParser tree walk (preserves CDATA sections)
function prettyPrintXml(xmlString) {
    if (!xmlString) return null;
    try {
        var doc = new DOMParser().parseFromString(xmlString, 'application/xml');
        if (doc.querySelector('parsererror')) return null;

        var cOpen = '<!' + '[CDATA[', cClose = ']' + ']>';
        var parts = [];
        function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

        function walk(node, depth) {
            var pad = '  '.repeat(depth), i;
            switch (node.nodeType) {
                case Node.DOCUMENT_NODE:
                    for (i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], 0);
                    return;
                case Node.PROCESSING_INSTRUCTION_NODE: parts.push('<?' + node.target + ' ' + node.data + '?>\n'); return;
                case Node.COMMENT_NODE: parts.push(pad + '<!--' + node.data + '-->\n'); return;
                case Node.TEXT_NODE: if (node.textContent.trim()) parts.push(esc(node.textContent)); return;
                case Node.CDATA_SECTION_NODE: parts.push(cOpen + node.data + cClose); return;
                case Node.ELEMENT_NODE:
                    var tag = pad + '<' + node.tagName;
                    for (i = 0; i < node.attributes.length; i++)
                        tag += ' ' + node.attributes[i].name + '="' + esc(node.attributes[i].value) + '"';
                    if (!node.childNodes.length) { parts.push(tag + '/>\n'); return; }
                    parts.push(tag + '>');
                    var hasChild = false;
                    for (i = 0; i < node.childNodes.length; i++)
                        if (node.childNodes[i].nodeType === Node.ELEMENT_NODE) { hasChild = true; break; }
                    if (hasChild) {
                        parts.push('\n');
                        for (i = 0; i < node.childNodes.length; i++) {
                            if (node.childNodes[i].nodeType === Node.TEXT_NODE && !node.childNodes[i].textContent.trim()) continue;
                            walk(node.childNodes[i], depth + 1);
                        }
                        parts.push(pad);
                    } else {
                        for (i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], depth + 1);
                    }
                    parts.push('</' + node.tagName + '>\n');
                    return;
            }
        }

        // Preserve XML declaration (DOMParser drops it)
        var decl = xmlString.match(/^<\?xml[^?]*\?>/);
        if (decl) parts.push(decl[0] + '\n');

        walk(doc, 0);
        return parts.join('').trimEnd();
    } catch (e) {
        return null;
    }
}

// Format XML content for display (pretty print)
// Lightweight per-line XML syntax highlighter for the diff-viewer preview.
// Returns HTML (all raw content escaped). Standard scheme: brackets muted,
// tag names blue, attribute names purple, attribute values green, text
// default, comments/declarations muted italic. Per-line by design (the
// preview renders line by line); a tag/comment spanning lines degrades
// gracefully to plain text — cosmetic only.
function highlightXmlLine(rawLine) {
    var out = '';
    var re = /<[^>]*>?/g;
    var last = 0, m;
    while ((m = re.exec(rawLine)) !== null) {
        if (m.index > last) out += '<span class="xml-text">' + escapeHtml(rawLine.slice(last, m.index)) + '</span>';
        out += _highlightXmlTag(m[0]);
        last = m.index + m[0].length;
    }
    if (last < rawLine.length) out += '<span class="xml-text">' + escapeHtml(rawLine.slice(last)) + '</span>';
    return out;
}

function _highlightXmlTag(tag) {
    if (/^<!--/.test(tag)) return '<span class="xml-comment">' + escapeHtml(tag) + '</span>';
    // <?xml ... ?>, <!DOCTYPE ...>, CDATA openers, etc.
    if (/^<[!?]/.test(tag)) return '<span class="xml-decl">' + escapeHtml(tag) + '</span>';
    var m = tag.match(/^(<\/?)([\w:.-]+)([\s\S]*?)(\/?>?)$/);
    if (!m) return '<span class="xml-text">' + escapeHtml(tag) + '</span>';
    var html = '<span class="xml-bracket">' + escapeHtml(m[1]) + '</span>' +
               '<span class="xml-tag">' + escapeHtml(m[2]) + '</span>';
    html += m[3].replace(/([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')|(\s+)|([^\s]+)/g, function(a, name, eq, val, ws, lone) {
        if (ws) return ws;
        if (name) {
            return '<span class="xml-attr">' + escapeHtml(name) + '</span>' +
                   '<span class="xml-bracket">' + escapeHtml(eq) + '</span>' +
                   '<span class="xml-attr-value">' + escapeHtml(val) + '</span>';
        }
        return '<span class="xml-text">' + escapeHtml(lone) + '</span>';
    });
    html += '<span class="xml-bracket">' + escapeHtml(m[4]) + '</span>';
    return html;
}

function formatXmlForDiff(xml) {
    if (!xml) return '';
    xml = normalizeLineEndings(xml);
    // Try proper XML pretty-print first
    var pretty = prettyPrintXml(xml);
    if (pretty) return pretty;
    // Fallback: basic formatting for invalid XML
    var lines = xml.split('\n');
    if (lines.length <= 3 && xml.length > 500) {
        return xml.replace(/>\s*</g, '>\n<').replace(/(<[^\/][^>]*[^\/]>)([^<]+)(<\/)/g, '$1\n$2\n$3');
    }
    return xml;
}

// Compute diff between two strings (line-based diff with prefix/suffix optimization)
function computeDiff(oldText, newText) {
    var oldNormalized = normalizeLineEndings(oldText || '');
    var newNormalized = normalizeLineEndings(newText || '');
    var oldLines = oldNormalized.split('\n');
    var newLines = newNormalized.split('\n');
    var m = oldLines.length, n = newLines.length;

    // Trim common prefix
    var prefix = 0;
    while (prefix < m && prefix < n && oldLines[prefix] === newLines[prefix]) prefix++;

    // Trim common suffix
    var suffix = 0;
    while (suffix < m - prefix && suffix < n - prefix && oldLines[m - 1 - suffix] === newLines[n - 1 - suffix]) suffix++;

    // Build result: common prefix
    var result = [];
    for (var i = 0; i < prefix; i++)
        result.push({ type: 'same', oldLine: i + 1, newLine: i + 1, text: oldLines[i] });

    // Middle section - only this needs LCS
    var oldMid = oldLines.slice(prefix, m - suffix);
    var newMid = newLines.slice(prefix, n - suffix);
    var mMid = oldMid.length, nMid = newMid.length;

    if (mMid > 0 || nMid > 0) {
        var MAX_LCS_CELLS = 4000000;
        if (mMid * nMid <= MAX_LCS_CELLS) {
            // LCS diff on the middle
            var lcs = [];
            for (var i = 0; i <= mMid; i++) {
                lcs[i] = [];
                for (var j = 0; j <= nMid; j++) {
                    if (i === 0 || j === 0) lcs[i][j] = 0;
                    else if (oldMid[i-1] === newMid[j-1]) lcs[i][j] = lcs[i-1][j-1] + 1;
                    else lcs[i][j] = Math.max(lcs[i-1][j], lcs[i][j-1]);
                }
            }
            var diff = [];
            var ii = mMid, jj = nMid;
            while (ii > 0 || jj > 0) {
                if (ii > 0 && jj > 0 && oldMid[ii-1] === newMid[jj-1]) {
                    diff.unshift({ type: 'same', oldLine: prefix + ii, newLine: prefix + jj, text: oldMid[ii-1] });
                    ii--; jj--;
                } else if (jj > 0 && (ii === 0 || lcs[ii][jj-1] >= lcs[ii-1][jj])) {
                    diff.unshift({ type: 'add', oldLine: null, newLine: prefix + jj, text: newMid[jj-1] });
                    jj--;
                } else {
                    diff.unshift({ type: 'remove', oldLine: prefix + ii, newLine: null, text: oldMid[ii-1] });
                    ii--;
                }
            }
            result = result.concat(diff);
        } else {
            // Too large for LCS - simple line-by-line comparison
            var max = Math.max(mMid, nMid);
            for (var i = 0; i < max; i++) {
                if (i >= mMid) {
                    result.push({ type: 'add', oldLine: null, newLine: prefix + i + 1, text: newMid[i] });
                } else if (i >= nMid) {
                    result.push({ type: 'remove', oldLine: prefix + i + 1, newLine: null, text: oldMid[i] });
                } else if (oldMid[i] === newMid[i]) {
                    result.push({ type: 'same', oldLine: prefix + i + 1, newLine: prefix + i + 1, text: oldMid[i] });
                } else {
                    result.push({ type: 'remove', oldLine: prefix + i + 1, newLine: null, text: oldMid[i] });
                    result.push({ type: 'add', oldLine: null, newLine: prefix + i + 1, text: newMid[i] });
                }
            }
        }
    }

    // Common suffix
    for (var i = 0; i < suffix; i++)
        result.push({ type: 'same', oldLine: m - suffix + i + 1, newLine: n - suffix + i + 1, text: oldLines[m - suffix + i] });

    return result;
}

// Compute word-level diff between two lines (for highlighting changed words)
function computeWordDiff(oldText, newText) {
    if (!oldText || !newText) return { oldHtml: escapeHtml(oldText || ''), newHtml: escapeHtml(newText || '') };

    // Split into words (preserving whitespace and punctuation as separate tokens)
    function tokenize(text) {
        return text.match(/\S+|\s+/g) || [];
    }

    var oldWords = tokenize(oldText);
    var newWords = tokenize(newText);
    var m = oldWords.length;
    var n = newWords.length;

    // For very long lines, skip word diff
    if (m > 200 || n > 200) {
        return { oldHtml: escapeHtml(oldText), newHtml: escapeHtml(newText) };
    }

    // Build LCS table for words
    var lcs = [];
    for (var i = 0; i <= m; i++) {
        lcs[i] = [];
        for (var j = 0; j <= n; j++) {
            if (i === 0 || j === 0) {
                lcs[i][j] = 0;
            } else if (oldWords[i-1] === newWords[j-1]) {
                lcs[i][j] = lcs[i-1][j-1] + 1;
            } else {
                lcs[i][j] = Math.max(lcs[i-1][j], lcs[i][j-1]);
            }
        }
    }

    // Backtrack to find word-level changes
    var oldResult = [];
    var newResult = [];
    i = m;
    var j = n;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldWords[i-1] === newWords[j-1]) {
            oldResult.unshift({ word: oldWords[i-1], changed: false });
            newResult.unshift({ word: newWords[j-1], changed: false });
            i--; j--;
        } else if (j > 0 && (i === 0 || lcs[i][j-1] >= lcs[i-1][j])) {
            newResult.unshift({ word: newWords[j-1], changed: true });
            j--;
        } else {
            oldResult.unshift({ word: oldWords[i-1], changed: true });
            i--;
        }
    }

    // Similarity gating (GitHub-like): only emit intra-line highlights when
    // the paired lines share at least half of their non-whitespace tokens.
    // Dissimilar pairs (rewritten lines, unbalanced-run pairings) fall back to
    // plain line-level coloring instead of boxing nearly every word.
    var oldNonWs = 0, newNonWs = 0, sameNonWs = 0;
    oldResult.forEach(function(it) { if (/\S/.test(it.word)) { oldNonWs++; if (!it.changed) sameNonWs++; } });
    newResult.forEach(function(it) { if (/\S/.test(it.word)) newNonWs++; });
    var denom = Math.max(oldNonWs, newNonWs);
    if (denom > 0 && sameNonWs / denom < 0.5) {
        return { oldHtml: escapeHtml(oldText), newHtml: escapeHtml(newText) };
    }

    // Merge highlight runs: an unchanged whitespace token sitting BETWEEN two
    // changed tokens joins the highlight, so consecutive changed words render
    // as ONE contiguous span (like GitHub) instead of separate boxes.
    function bridgeWhitespace(result) {
        for (var k = 1; k < result.length - 1; k++) {
            if (!result[k].changed && !/\S/.test(result[k].word) && result[k-1].changed && result[k+1].changed) {
                result[k].changed = true;
            }
        }
    }
    bridgeWhitespace(oldResult);
    bridgeWhitespace(newResult);

    // Build HTML with highlights (whole words highlighted)
    function buildHtml(result, highlightClass) {
        var html = '';
        var inHighlight = false;
        result.forEach(function(item) {
            if (item.changed && !inHighlight) {
                html += '<span class="' + highlightClass + '">';
                inHighlight = true;
            } else if (!item.changed && inHighlight) {
                html += '</span>';
                inHighlight = false;
            }
            html += escapeHtml(item.word);
        });
        if (inHighlight) html += '</span>';
        return html;
    }

    return {
        oldHtml: buildHtml(oldResult, 'diff-word-remove'),
        newHtml: buildHtml(newResult, 'diff-word-add')
    };
}

// Pair up remove/add runs in a line diff (computeDiff output) and compute
// word-level highlight HTML for each paired line. The k-th removed line of a
// remove-run is paired with the k-th added line of the immediately following
// add-run. Returns a map of diff-index -> already-escaped HTML for lines that
// received an intra-line (word-level) highlight. Shared by the record diff
// viewer (100-diff-viewer.js) and the workspace files diff
// (115-workspace-files-sidebar.js).
function computeWordDiffsForLines(diff) {
    var wordDiffs = {};
    var i = 0;
    while (i < diff.length) {
        if (diff[i].type === 'remove') {
            var removeStart = i;
            while (i < diff.length && diff[i].type === 'remove') i++;
            var addStart = i;
            while (i < diff.length && diff[i].type === 'add') i++;
            var pairs = Math.min(addStart - removeStart, i - addStart);
            for (var k = 0; k < pairs; k++) {
                var wd = computeWordDiff(diff[removeStart + k].text, diff[addStart + k].text);
                wordDiffs[removeStart + k] = wd.oldHtml;
                wordDiffs[addStart + k] = wd.newHtml;
            }
        } else {
            i++;
        }
    }
    return wordDiffs;
}
