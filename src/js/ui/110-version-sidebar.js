// Download single file from sidebar
async function downloadSingleFile(table, sysId, displayName) {
    showSpinner('Downloading...');
    try {
        // getLatestRecordXml (ui/090-version-history.js) falls back to the
        // <table>.do?XML export for data tables with no sys_update_version rows.
        var xml = await getLatestRecordXml(table, sysId);
        if (!xml) {
            hideSpinner();
            showSnackbar('No version to download', 'warning');
            return;
        }
        if (xml) {
            var prettyXml = prettyPrintXml(xml) || xml;
            var blob = new Blob([prettyXml], { type: 'application/xml' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = displayName.replace(/[^a-zA-Z0-9_-]/g, '_') + '.xml';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showSnackbar('Downloaded ' + displayName, 'success');
        }
    } catch (e) {
        showSnackbar('Download failed: ' + e.message, 'error');
    }
    hideSpinner();
}

// Delete a new record from the sidebar (simpler version without userMsgIdx)
async function deleteNewRecordFromSidebar(table, sysId, displayName) {
    if (!await showConfirmModal('Delete Record', 'Delete "' + displayName + '"? This will permanently delete this newly created record.', 'danger')) return;

    try {
        showSpinner('Deleting ' + displayName + '...');

        var recordScope = await getRecordScope(table, sysId);
        var deleteUrl = '/api/now/table/' + table + '/' + sysId;
        if (recordScope) {
            deleteUrl += '?sysparm_record_scope=' + encodeURIComponent(recordScope);
        }

        var res = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: {
                'X-UserToken': window.sessionToken,
                'Accept': 'application/json'
            }
        });

        hideSpinner();

        if (res.ok || res.status === 204) {
            // Mark all entries for this file as invalidated
            versionHistory.forEach(function(v, idx) {
                if (v.table === table && v.sysId === sysId && v.chatId === currentChatId && v.action !== 'REVERT') {
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
                messageIndex: -1
            });

            saveVersionHistory();
            renderVersionSidebar();
            renderMessages();

            showSnackbar('Successfully deleted "' + displayName + '"', 'success');
        } else {
            showSnackbar('Delete failed: ' + res.status, 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar('Delete failed: ' + e.message, 'error');
    }
}

async function revertToVersion(versionSysId, historyIndex, revertType) {
    if (!versionSysId) {
        showSnackbar('No version available to revert to', 'warning');
        return;
    }
    
    var entry = versionHistory[historyIndex];
    if (!entry) return;
    
    var confirmMsg = 'Revert ' + entry.displayName + ' to ' + (revertType === 'before' ? 'before' : 'after') + ' this change?';
    if (!await showConfirmModal('Revert Change', confirmMsg)) return;
    
    try {
        showSpinner('Fetching version XML...');
        
        // Get the XML payload from sys_update_version
        var xml = await getVersionXml(versionSysId);
        if (!xml) {
            hideSpinner();
            showSnackbar('Failed to get version XML', 'error');
            return;
        }
        
        showSpinner('Importing XML to revert...');
        
        var result = await uploadXml(xml, entry.table, entry.sysId);
        hideSpinner();
        
        if (result.success) {
            // Mark subsequent entries for the same record as invalid
            for (var i = historyIndex + 1; i < versionHistory.length; i++) {
                if (versionHistory[i].table === entry.table && versionHistory[i].sysId === entry.sysId) {
                    versionHistory[i].invalidated = true;
                }
            }
            
            // Add a revert entry to history
            var revertEntry = {
                id: 'vh_' + Date.now(),
                chatId: currentChatId,
                timestamp: Date.now(),
                table: entry.table,
                sysId: entry.sysId,
                displayName: entry.displayName,
                action: 'REVERT',
                messageIndex: -1,
                revertedFrom: historyIndex,
                revertType: revertType
            };
            versionHistory.push(revertEntry);
            
            saveVersionHistory();
            renderVersionSidebar();
            updateVersionSidebarVisibility();
            showSnackbar('Successfully reverted ' + entry.displayName, 'success');
        } else {
            showSnackbar('Failed to import XML: ' + result.error, 'error');
        }
    } catch (e) {
        hideSpinner();
        console.error('Revert failed:', e);
        showSnackbar('Revert failed: ' + e.message, 'error');
    }
}

function scrollToMessage(messageIndex) {
    if (messageIndex < 0 || messageIndex === undefined || messageIndex === null) {
        return false;
    }
    
    clearToolHighlights();
    
    var msgEl = document.getElementById('msg-' + messageIndex);
    if (msgEl) {
        // Expand any tool call details in this message and scroll to first one
        var toolCalls = msgEl.querySelectorAll('details.tool-call, details.tool-result');
        var scrollTarget = msgEl;
        if (toolCalls.length > 0) {
            collapseOtherTools(toolCalls[0]);
            toolCalls[0].open = true;
            scrollTarget = toolCalls[0];
        } else {
            // For user messages, target the message-content div
            var contentEl = msgEl.querySelector('.message-content');
            if (contentEl) scrollTarget = contentEl;
        }
        
        scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        scrollTarget.classList.add('highlight-flash');
        setTimeout(function() { scrollTarget.classList.remove('highlight-flash'); }, 2000);
        return true;
    }
    return false;
}
