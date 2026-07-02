// Navigation state for diff viewer
var currentDiffChangeIndex = 0;
var diffChangeElements = [];

// Navigate to previous/next change in diff viewer
function navigateDiffChange(direction) {
    if (diffChangeElements.length === 0) return;

    currentDiffChangeIndex += direction;
    if (currentDiffChangeIndex < 0) currentDiffChangeIndex = diffChangeElements.length - 1;
    if (currentDiffChangeIndex >= diffChangeElements.length) currentDiffChangeIndex = 0;

    // Scroll to the change
    var element = diffChangeElements[currentDiffChangeIndex];
    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Update counter
        var counter = document.getElementById('diff-nav-counter');
        if (counter) counter.textContent = (currentDiffChangeIndex + 1) + ' / ' + diffChangeElements.length;
    }
}

// Toggle focus mode (show only changes ± context)
function toggleDiffFocus() {
    var container = document.querySelector('.diff-container');
    var btn = document.getElementById('diff-focus-toggle');
    if (!container) return;
    container.classList.toggle('diff-focused');
    if (btn) btn.classList.toggle('active');
}

// State for diff viewer
var currentDiffFile = null;

// Open fullscreen diff viewer
async function openDiffViewer(table, sysId, displayName) {
    var versions = getVersionsForFile(table, sysId);

    var isNew = versionHistory.some(function(v) {
        return v.chatId === currentChatId && v.table === table && v.sysId === sysId &&
               v.action === 'POST' && !v.invalidated;
    });
    var firstBeforeVersion = getFirstVersionForRecord(table, sysId);
    var latestAfterVersion = getLatestAfterVersion(table, sysId);

    // Determine if we have versions to compare (excluding the current/latest version)
    var hasComparableVersions = versions.length > 1 || (versions.length === 1 && versions[0].versionId !== latestAfterVersion);

    currentDiffFile = { table: table, sysId: sysId, displayName: displayName, versions: versions, isNew: isNew, firstBeforeVersion: firstBeforeVersion, latestAfterVersion: latestAfterVersion, hasComparableVersions: hasComparableVersions };

    // Create overlay
    var overlay = document.createElement('div');
    overlay.className = 'diff-viewer-overlay';
    overlay.id = 'diff-viewer-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) closeDiffViewer(); };

    // Create modal
    var modal = document.createElement('div');
    modal.className = 'diff-viewer-modal';

    // Header with actions
    var header = document.createElement('div');
    header.className = 'diff-viewer-header';
    header.id = 'diff-viewer-header';

    var revertBtnHtml = '';
    if (isNew) {
        revertBtnHtml = '<button class="diff-action-btn danger" onclick="revertFromDiffViewer()" title="Delete this new record">' + UI_ICONS.trash + '<span>Delete</span></button>';
    } else if (firstBeforeVersion) {
        revertBtnHtml = '<button class="diff-action-btn" onclick="revertFromDiffViewer()" title="Revert to before chat">' + UI_ICONS.undo + '<span>Revert</span></button>';
    }

    // Build compare section - either dropdown or "no earlier version" message
    var compareHtml = '';
    if (hasComparableVersions) {
        compareHtml = '<span class="diff-compare-label">Compare with:</span>' +
            '<select id="diff-compare-version" class="diff-version-select" onchange="updateDiffView()">' +
            '<option value="">Loading...</option></select>';
    } else {
        compareHtml = '<span class="diff-no-compare">No earlier version to compare against</span>';
    }

    // Open on instance URL
    var instanceUrl = (Platform.instanceUrl || '') + '/' + table + '.do?sys_id=' + sysId;

    header.innerHTML = '<div class="diff-header-left">' +
        '<span class="diff-file-name">' + escapeHtml(displayName) + '</span>' +
        compareHtml +
        '</div>' +
        '<div class="diff-header-center" id="diff-header-stats"></div>' +
        '<div class="diff-header-right">' +
        '<a class="diff-action-btn" href="' + instanceUrl + '" target="_blank" title="Open on instance">' + UI_ICONS.externalLink + '<span>Open</span></a>' +
        (table === 'sys_ui_page' ? '<button class="diff-action-btn" onclick="screenshotUIPage(\'' + escapeJsString(displayName) + '\')" title="Screenshot">' + UI_ICONS.camera + '<span>Screenshot</span></button>' : '') +
        '<button class="diff-action-btn" onclick="downloadFromDiffViewer()" title="Download XML">' + UI_ICONS.download + '<span>Download</span></button>' +
        revertBtnHtml +
        '<button class="diff-close-btn" onclick="closeDiffViewer()" title="Close">' + UI_ICONS.close + '</button>' +
        '</div>';

    // Content area
    var content = document.createElement('div');
    content.className = 'diff-viewer-content';
    content.id = 'diff-viewer-content';
    content.innerHTML = '<div class="diff-loading"><div class="spinner"></div>Loading...</div>';

    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Fetch historical versions and populate dropdown
    if (hasComparableVersions) {
        var chatVersionIds = versions.map(function(v) { return v.versionId; });
        var historicalVersions = await getHistoricalVersions(table, sysId, chatVersionIds);

        // Combine and sort all versions
        var allVersions = versions.concat(historicalVersions);
        allVersions.sort(function(a, b) { return a.timestamp - b.timestamp; });
        currentDiffFile.allVersions = allVersions;

        // Build dropdown with grouped options
        var dropdown = document.getElementById('diff-compare-version');
        if (dropdown) {
            var dropdownHtml = '';
            var chatVersions = allVersions.filter(function(v) { return v.isFromChat && v.versionId !== latestAfterVersion; });
            var histVersions = allVersions.filter(function(v) { return !v.isFromChat; });
            var currentVersion = allVersions.find(function(v) { return v.versionId === latestAfterVersion; });

            // Current version first (disabled)
            if (currentVersion) {
                dropdownHtml += '<option value="' + currentVersion.versionId + '" disabled class="diff-option-current">' + escapeHtml(currentVersion.label) + ' (Current)</option>';
            }

            // Chat versions (excluding current)
            if (chatVersions.length > 0) {
                dropdownHtml += '<optgroup label="This Chat">';
                chatVersions.forEach(function(ver, idx) {
                    var selected = idx === 0 ? ' selected' : '';
                    dropdownHtml += '<option value="' + ver.versionId + '"' + selected + '>' + escapeHtml(ver.label) + '</option>';
                });
                dropdownHtml += '</optgroup>';
            }

            // Historical versions
            if (histVersions.length > 0) {
                dropdownHtml += '<optgroup label="Earlier History">';
                var firstInGroup = chatVersions.length === 0;
                histVersions.forEach(function(ver, idx) {
                    var selected = firstInGroup && idx === 0 ? ' selected' : '';
                    dropdownHtml += '<option value="' + ver.versionId + '" class="diff-option-historical"' + selected + '>' + escapeHtml(ver.label) + '</option>';
                });
                dropdownHtml += '</optgroup>';
            }

            dropdown.innerHTML = dropdownHtml;
        }
    }

    // Load and display diff
    await updateDiffView();
}

// Update diff view when comparison version changes
async function updateDiffView() {
    if (!currentDiffFile) return;

    var content = document.getElementById('diff-viewer-content');
    var headerStats = document.getElementById('diff-header-stats');
    if (!content) return;

    content.innerHTML = '<div class="diff-loading"><div class="spinner"></div>Loading...</div>';
    if (headerStats) headerStats.innerHTML = '';

    var latestAfterVersion = getLatestAfterVersion(currentDiffFile.table, currentDiffFile.sysId);
    var isPreviewOnly = !currentDiffFile.hasComparableVersions;

    // Get compare version from dropdown if available
    var compareVersionId = null;
    var dropdown = document.getElementById('diff-compare-version');
    if (dropdown) {
        compareVersionId = dropdown.value;
    }

    // If preview only mode, just show the current version
    if (isPreviewOnly) {
        try {
            // Shared helper (ui/090-version-history.js): chat version → live
            // version → <table>.do?XML export fallback for data tables.
            var xml = await getLatestRecordXml(currentDiffFile.table, currentDiffFile.sysId);
            if (!xml) {
                content.innerHTML = '<div class="diff-error">Could not load record data.</div>';
                return;
            }
            var formattedXml = formatXmlForDiff(xml);
            var lines = formattedXml.split('\n');

            var html = '<div class="diff-container diff-preview">';
            html += '<div class="diff-lines">';
            lines.forEach(function(line, idx) {
                html += '<div class="diff-line">';
                html += '<span class="diff-line-num">' + (idx + 1) + '</span>';
                html += '<span class="diff-text">' + highlightXmlLine(line) + '</span>';
                html += '</div>';
            });
            html += '</div></div>';
            content.innerHTML = html;

            if (headerStats) headerStats.innerHTML = '<span class="diff-preview-label">' + lines.length + ' lines</span>';
        } catch (e) {
            content.innerHTML = '<div class="diff-error">Failed to load version data: ' + escapeHtml(e.message) + '</div>';
        }
        return;
    }

    // If comparing the same version, show a message
    if (compareVersionId === latestAfterVersion) {
        content.innerHTML = '<div class="diff-no-changes"><div class="diff-no-changes-icon">' + UI_ICONS.info + '</div><div class="diff-no-changes-text">This is the current version. Select an earlier version to compare.</div></div>';
        if (headerStats) headerStats.innerHTML = '';
        return;
    }

    try {
        var oldXml = await getVersionXml(compareVersionId);
        var newXml = latestAfterVersion ? await getVersionXml(latestAfterVersion) : oldXml;

        if (!oldXml) {
            content.innerHTML = '<div class="diff-error">Could not load version data. The version may have been deleted.</div>';
            return;
        }

        // Format XML for proper display with line breaks
        var oldContent = formatXmlForDiff(oldXml);
        var newContent = formatXmlForDiff(newXml);

        console.log('Diff comparison:', { compareVersionId: compareVersionId, latestAfterVersion: latestAfterVersion, oldLength: oldContent ? oldContent.length : 0, newLength: newContent ? newContent.length : 0 });

        var diff = computeDiff(oldContent, newContent);

        // Find pairs of adjacent remove/add lines for word-level diff
        var wordDiffs = {};
        for (var i = 0; i < diff.length - 1; i++) {
            if (diff[i].type === 'remove' && diff[i+1].type === 'add') {
                var wordDiff = computeWordDiff(diff[i].text, diff[i+1].text);
                wordDiffs[i] = wordDiff.oldHtml;
                wordDiffs[i+1] = wordDiff.newHtml;
            }
        }

        // Build context set - which "same" lines are within ±5 of a change
        var CONTEXT_LINES = 5;
        var contextSet = {};
        diff.forEach(function(line, idx) {
            if (line.type !== 'same') {
                for (var c = Math.max(0, idx - CONTEXT_LINES); c <= Math.min(diff.length - 1, idx + CONTEXT_LINES); c++) {
                    contextSet[c] = true;
                }
            }
        });

        // Render diff - group consecutive changes into hunks
        var html = '<div class="diff-container diff-focused">';
        html += '<div class="diff-gutter-old"></div>';
        html += '<div class="diff-gutter-new"></div>';
        html += '<div class="diff-lines">';

        var hunkIndex = -1;
        var inHunk = false;
        var lastWasHidden = false;
        diff.forEach(function(line, idx) {
            var lineClass = 'diff-line';
            var oldLineNum = line.oldLine !== null ? line.oldLine : '';
            var newLineNum = line.newLine !== null ? line.newLine : '';
            var prefix = ' ';
            var textContent = escapeHtml(line.text);
            var isChange = line.type !== 'same';
            var hunkStartAttr = '';
            var isHidden = line.type === 'same' && !contextSet[idx];

            // Track hunks - a hunk is a group of consecutive changed lines
            if (isChange && !inHunk) {
                // Starting a new hunk
                hunkIndex++;
                inHunk = true;
                hunkStartAttr = ' data-hunk-start="' + hunkIndex + '"';
            } else if (!isChange && inHunk) {
                // Ending a hunk
                inHunk = false;
            }

            // Insert separator before first visible line after hidden lines
            if (lastWasHidden && !isHidden) {
                html += '<div class="diff-separator"><span class="diff-separator-text">...</span></div>';
            }
            lastWasHidden = isHidden;

            if (line.type === 'add') {
                lineClass += ' diff-add diff-change';
                prefix = '+';
                if (wordDiffs[idx]) textContent = wordDiffs[idx];
            } else if (line.type === 'remove') {
                lineClass += ' diff-remove diff-change';
                prefix = '-';
                if (wordDiffs[idx]) textContent = wordDiffs[idx];
            }

            if (isHidden) lineClass += ' diff-hidden';

            html += '<div class="' + lineClass + '"' + hunkStartAttr + '>';
            html += '<span class="diff-line-num old">' + oldLineNum + '</span>';
            html += '<span class="diff-line-num new">' + newLineNum + '</span>';
            html += '<span class="diff-prefix">' + prefix + '</span>';
            html += '<span class="diff-text">' + textContent + '</span>';
            html += '</div>';
        });

        html += '</div></div>';

        content.innerHTML = html;

        // Update header stats with navigation
        var addCount = diff.filter(function(l) { return l.type === 'add'; }).length;
        var removeCount = diff.filter(function(l) { return l.type === 'remove'; }).length;
        var totalHunks = hunkIndex + 1;

        if (headerStats) {
            var statsHtml = '<span class="diff-stat add">+' + addCount + '</span>';
            statsHtml += '<span class="diff-stat remove">-' + removeCount + '</span>';
            if (totalHunks > 0) {
                statsHtml += '<div class="diff-nav">';
                statsHtml += '<button class="diff-nav-btn" onclick="navigateDiffChange(-1)" title="Previous change">' + UI_ICONS.arrowUp + '</button>';
                statsHtml += '<span id="diff-nav-counter" class="diff-nav-counter">1 / ' + totalHunks + '</span>';
                statsHtml += '<button class="diff-nav-btn" onclick="navigateDiffChange(1)" title="Next change">' + UI_ICONS.arrowDown + '</button>';
                statsHtml += '<button id="diff-focus-toggle" class="diff-nav-btn active" onclick="toggleDiffFocus()" title="Show changes only">' + UI_ICONS.collapse + '</button>';
                statsHtml += '</div>';
            }
            headerStats.innerHTML = statsHtml;
        }

        // Initialize navigation - select hunk start elements only
        diffChangeElements = content.querySelectorAll('[data-hunk-start]');
        currentDiffChangeIndex = 0;

        // Auto-scroll to first change
        if (diffChangeElements.length > 0) {
            diffChangeElements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

    } catch (e) {
        content.innerHTML = '<div class="diff-error">Failed to load version data: ' + escapeHtml(e.message) + '</div>';
    }
}

// Close diff viewer
function closeDiffViewer() {
    currentDiffFile = null;
    var overlay = document.getElementById('diff-viewer-overlay');
    if (overlay) overlay.remove();
}

// Download from diff viewer
async function downloadFromDiffViewer() {
    if (!currentDiffFile) return;

    showSpinner('Downloading...');
    try {
        // getLatestRecordXml falls back to the <table>.do?XML export for data
        // tables (no sys_update_version rows) — the old getLatestAfterVersion
        // early-return made Download dead-end with "No version to download".
        var xml = await getLatestRecordXml(currentDiffFile.table, currentDiffFile.sysId);
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
            a.download = currentDiffFile.displayName.replace(/[^a-zA-Z0-9_-]/g, '_') + '.xml';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showSnackbar('Downloaded ' + currentDiffFile.displayName, 'success');
        }
    } catch (e) {
        showSnackbar('Download failed: ' + e.message, 'error');
    }
    hideSpinner();
}

// Revert from diff viewer
async function revertFromDiffViewer() {
    if (!currentDiffFile) return;

    if (currentDiffFile.isNew) {
        // Delete new record
        if (!await showConfirmModal('Delete Record', 'Delete "' + currentDiffFile.displayName + '"? This will permanently delete this newly created record.', 'danger')) return;

        showSpinner('Deleting...');
        try {
            var recordScope = await getRecordScope(currentDiffFile.table, currentDiffFile.sysId);
            var deleteUrl = '/api/now/table/' + currentDiffFile.table + '/' + currentDiffFile.sysId;
            if (recordScope) {
                deleteUrl += '?sysparm_record_scope=' + encodeURIComponent(recordScope);
            }

            var res = await fetch(deleteUrl, {
                method: 'DELETE',
                headers: { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' }
            });

            if (res.ok || res.status === 204) {
                // Mark all changes as invalidated
                versionHistory.forEach(function(v, idx) {
                    if (v.table === currentDiffFile.table && v.sysId === currentDiffFile.sysId && v.chatId === currentChatId) {
                        versionHistory[idx].invalidated = true;
                    }
                });
                addVersionHistoryEntry({
                    id: 'vh_' + Date.now(),
                    chatId: currentChatId,
                    timestamp: Date.now(),
                    table: currentDiffFile.table,
                    sysId: currentDiffFile.sysId,
                    displayName: currentDiffFile.displayName,
                    action: 'USER_DELETE',
                    messageIndex: -1
                });
                showSnackbar('Deleted "' + currentDiffFile.displayName + '"', 'success');
                closeDiffViewer();
            } else {
                showSnackbar('Delete failed', 'error');
            }
        } catch (e) {
            showSnackbar('Delete failed: ' + e.message, 'error');
        }
        hideSpinner();
    } else if (currentDiffFile.firstBeforeVersion) {
        // Revert to before chat
        if (!await showConfirmModal('Revert Changes', 'Revert "' + currentDiffFile.displayName + '" to its state before this chat? You can redo this later.')) return;

        showSpinner('Reverting...');
        try {
            var xml = await getVersionXml(currentDiffFile.firstBeforeVersion);
            if (xml) {
                var result = await uploadXml(xml, currentDiffFile.table, currentDiffFile.sysId);
                if (result.success) {
                    // Mark all changes as invalidated
                    versionHistory.forEach(function(v, idx) {
                        if (v.table === currentDiffFile.table && v.sysId === currentDiffFile.sysId && v.chatId === currentChatId) {
                            versionHistory[idx].invalidated = true;
                        }
                    });
                    addVersionHistoryEntry({
                        id: 'vh_' + Date.now(),
                        chatId: currentChatId,
                        timestamp: Date.now(),
                        table: currentDiffFile.table,
                        sysId: currentDiffFile.sysId,
                        displayName: currentDiffFile.displayName,
                        action: 'REVERT',
                        messageIndex: -1,
                        afterVersion: currentDiffFile.firstBeforeVersion
                    });
                    showSnackbar('Reverted "' + currentDiffFile.displayName + '"', 'success');
                    closeDiffViewer();
                } else {
                    showSnackbar('Revert failed: ' + result.error, 'error');
                }
            }
        } catch (e) {
            showSnackbar('Revert failed: ' + e.message, 'error');
        }
        hideSpinner();
    }
}
