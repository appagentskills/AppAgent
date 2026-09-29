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
        if (counter) counter.textContent = t('{current} / {total}', { current: currentDiffChangeIndex + 1, total: diffChangeElements.length });
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
var _diffViewSeq = 0; // A3B3-01: bumped by every updateDiffView call and by closeDiffViewer

// Open fullscreen diff viewer
async function openDiffViewer(table, sysId, displayName) {
    var versions = getVersionsForFile(table, sysId);

    // Source-aware: the record may have been created by one of this chat's
    // sub-agents (rolled up into the sidebar) — check the active chat AND its
    // sub-agent chats (getVersionHistorySources, 090-version-history.js).
    var isNew = getVersionHistorySources().some(function(src) {
        return src.entries.some(function(v) {
            return v.chatId === src.chatId && v.table === table && v.sysId === sysId &&
                   v.action === 'POST' && !v.invalidated;
        });
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
    overlay.tabIndex = -1; // TA4-5: focus target once (re)opened
    // TA4-1: only a click whose mousedown STARTED on the backdrop closes, so a
    // text-selection drag from the modal that ends on the backdrop keeps it open
    // (same contract as ui/040-tools-settings.js showLlmEndpointModal). Synthetic
    // calls (onclick({target: overlay}) replays, programmatic .click()) are not
    // isTrusted and still close.
    var backdropPressed = false;
    overlay.addEventListener('mousedown', function(e) { backdropPressed = (e.target === overlay); });
    overlay.onclick = function(e) {
        if (!e || e.target !== overlay) return;
        if (e.isTrusted && !backdropPressed) return;
        closeDiffViewer();
    };

    // Create modal
    var modal = document.createElement('div');
    modal.className = 'diff-viewer-modal';

    // Header with actions
    var header = document.createElement('div');
    header.className = 'diff-viewer-header';
    header.id = 'diff-viewer-header';

    var revertBtnHtml = '';
    if (isNew) {
        revertBtnHtml = '<button class="diff-action-btn danger" onclick="revertFromDiffViewer()" title="' + escapeHtml(t('Delete this new record')) + '">' + UI_ICONS.trash + '<span>' + escapeHtml(t('Delete')) + '</span></button>';
    } else if (firstBeforeVersion) {
        revertBtnHtml = '<button class="diff-action-btn" onclick="revertFromDiffViewer()" title="' + escapeHtml(t('Revert to before chat')) + '">' + UI_ICONS.undo + '<span>' + escapeHtml(t('Revert')) + '</span></button>';
    }

    // Build compare section - either dropdown or "no earlier version" message
    var compareHtml = '';
    if (hasComparableVersions) {
        compareHtml = '<span class="diff-compare-label">' + escapeHtml(t('Compare with:')) + '</span>' +
            '<select id="diff-compare-version" class="diff-version-select" onchange="updateDiffView()">' +
            '<option value="">' + escapeHtml(t('Loading...')) + '</option></select>';
    } else {
        compareHtml = '<span class="diff-no-compare">' + escapeHtml(t('No earlier version to compare against')) + '</span>';
    }

    // Open on instance URL
    var instanceUrl = (Platform.instanceUrl || '') + '/' + table + '.do?sys_id=' + sysId;

    header.innerHTML = '<div class="diff-header-left">' +
        '<span class="diff-file-name">' + escapeHtml(displayName) + '</span>' +
        compareHtml +
        '</div>' +
        '<div class="diff-header-center" id="diff-header-stats"></div>' +
        '<div class="diff-header-right">' +
        '<a class="diff-action-btn" href="' + instanceUrl + '" target="_blank" title="' + escapeHtml(t('Open on instance')) + '">' + UI_ICONS.externalLink + '<span>' + escapeHtml(t('Open')) + '</span></a>' +
        (table === 'sys_ui_page' ? '<button class="diff-action-btn" onclick="screenshotUIPage(\'' + escapeJsString(displayName) + '\')" title="' + escapeHtml(t('Screenshot')) + '">' + UI_ICONS.camera + '<span>' + escapeHtml(t('Screenshot')) + '</span></button>' : '') +
        '<button class="diff-action-btn" onclick="downloadFromDiffViewer()" title="' + escapeHtml(t('Download XML')) + '">' + UI_ICONS.download + '<span>' + escapeHtml(t('Download')) + '</span></button>' +
        revertBtnHtml +
        '<button class="diff-close-btn" onclick="closeDiffViewer()" title="' + escapeHtml(t('Close')) + '">' + UI_ICONS.close + '</button>' +
        '</div>';

    // Content area
    var content = document.createElement('div');
    content.className = 'diff-viewer-content';
    content.id = 'diff-viewer-content';
    content.innerHTML = '<div class="diff-loading"><div class="spinner"></div>' + escapeHtml(t('Loading...')) + '</div>';

    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    // TA4-5: a re-open REPLACES the viewer. A stacked second #diff-viewer-overlay
    // was unreachable: getElementById (updateDiffView, closeDiffViewer) only ever
    // sees the first, stale copy. Drop every existing one, then focus the new one.
    Array.prototype.forEach.call(document.querySelectorAll('#diff-viewer-overlay'), function(o) { o.remove(); });
    document.body.appendChild(overlay);
    try { overlay.focus({ preventScroll: true }); } catch (e) {}

    // Fetch historical versions and populate dropdown
    if (hasComparableVersions) {
        var chatVersionIds = versions.map(function(v) { return v.versionId; });
        var openedFile = currentDiffFile; // RC7B1B-F1
        var historicalVersions = await getHistoricalVersions(table, sysId, chatVersionIds);
        if (currentDiffFile !== openedFile || !content.isConnected) return; // closed or reopened mid-fetch

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
                dropdownHtml += '<option value="' + currentVersion.versionId + '" disabled class="diff-option-current">' + t('{label} (Current)', { label: escapeHtml(currentVersion.label) }) + '</option>';
            }

            // Chat versions (excluding current)
            if (chatVersions.length > 0) {
                dropdownHtml += '<optgroup label="' + escapeHtml(t('This Chat')) + '">';
                chatVersions.forEach(function(ver, idx) {
                    var selected = idx === 0 ? ' selected' : '';
                    dropdownHtml += '<option value="' + ver.versionId + '"' + selected + '>' + escapeHtml(ver.label) + '</option>';
                });
                dropdownHtml += '</optgroup>';
            }

            // Historical versions
            if (histVersions.length > 0) {
                dropdownHtml += '<optgroup label="' + escapeHtml(t('Earlier History')) + '">';
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
    // A3B3-01: a newer call, a close or a reopen supersedes this call; re-check after every await.
    var seq = ++_diffViewSeq, file = currentDiffFile;
    function stale() { return seq !== _diffViewSeq || currentDiffFile !== file || !content.isConnected; }

    content.innerHTML = '<div class="diff-loading"><div class="spinner"></div>' + escapeHtml(t('Loading...')) + '</div>';
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
            if (stale()) return;
            if (!xml) {
                content.innerHTML = '<div class="diff-error">' + escapeHtml(t('Could not load record data.')) + '</div>';
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

            if (headerStats) headerStats.innerHTML = '<span class="diff-preview-label">' + escapeHtml(tn(lines.length, '{count} line', '{count} lines')) + '</span>';
        } catch (e) {
            if (stale()) return;
            content.innerHTML = '<div class="diff-error">' + t('Failed to load version data: {error}', { error: escapeHtml(e.message) }) + '</div>';
        }
        return;
    }

    // If comparing the same version, show a message
    if (compareVersionId === latestAfterVersion) {
        content.innerHTML = '<div class="diff-no-changes"><div class="diff-no-changes-icon">' + UI_ICONS.info + '</div><div class="diff-no-changes-text">' + escapeHtml(t('This is the current version. Select an earlier version to compare.')) + '</div></div>';
        if (headerStats) headerStats.innerHTML = '';
        return;
    }

    try {
        var oldXml = await getVersionXml(compareVersionId);
        var newXml = latestAfterVersion ? await getVersionXml(latestAfterVersion) : oldXml;
        if (stale()) return;

        if (!oldXml) {
            content.innerHTML = '<div class="diff-error">' + escapeHtml(t('Could not load version data. The version may have been deleted.')) + '</div>';
            return;
        }

        // Format XML for proper display with line breaks
        var oldContent = formatXmlForDiff(oldXml);
        var newContent = formatXmlForDiff(newXml);


        var diff = computeDiff(oldContent, newContent);

        // Word-level highlights for paired remove/add lines
        // (shared helper in 090-version-history.js)
        var wordDiffs = computeWordDiffsForLines(diff);

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
                statsHtml += '<button class="diff-nav-btn" onclick="navigateDiffChange(-1)" title="' + escapeHtml(t('Previous change')) + '">' + UI_ICONS.arrowUp + '</button>';
                statsHtml += '<span id="diff-nav-counter" class="diff-nav-counter">' + escapeHtml(t('{current} / {total}', { current: 1, total: totalHunks })) + '</span>';
                statsHtml += '<button class="diff-nav-btn" onclick="navigateDiffChange(1)" title="' + escapeHtml(t('Next change')) + '">' + UI_ICONS.arrowDown + '</button>';
                statsHtml += '<button id="diff-focus-toggle" class="diff-nav-btn active" onclick="toggleDiffFocus()" title="' + escapeHtml(t('Show changes only')) + '">' + UI_ICONS.collapse + '</button>';
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
        if (stale()) return;
        content.innerHTML = '<div class="diff-error">' + t('Failed to load version data: {error}', { error: escapeHtml(e.message) }) + '</div>';
    }
}

// Close diff viewer
function closeDiffViewer() {
    _diffViewSeq++; // A3B3-01: in-flight updateDiffView calls become stale
    currentDiffFile = null;
    var overlay = document.getElementById('diff-viewer-overlay');
    if (overlay) overlay.remove();
}

// Download from diff viewer
async function downloadFromDiffViewer() {
    if (!currentDiffFile) return;
    // Capture the record: closeDiffViewer() nulls currentDiffFile (and a reopen
    // swaps it) while the fetch below is in flight.
    var file = currentDiffFile;

    showSpinner(t('Downloading...'));
    try {
        // getLatestRecordXml falls back to the <table>.do?XML export for data
        // tables (no sys_update_version rows) — the old getLatestAfterVersion
        // early-return made Download dead-end with "No version to download".
        var xml = await getLatestRecordXml(file.table, file.sysId);
        if (!xml) {
            hideSpinner();
            showSnackbar(t('No version to download'), 'warning');
            return;
        }
        if (xml) {
            var prettyXml = prettyPrintXml(xml) || xml;
            var blob = new Blob([prettyXml], { type: 'application/xml' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = file.displayName.replace(/[^a-zA-Z0-9_-]/g, '_') + '.xml';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showSnackbar(t('Downloaded {name}', { name: file.displayName }), 'success');
        }
    } catch (e) {
        showSnackbar(t('Download failed: {error}', { error: e.message }), 'error');
    }
    hideSpinner();
}

// Revert from diff viewer
async function revertFromDiffViewer() {
    if (!currentDiffFile) return;

    if (currentDiffFile.isNew) {
        // Delete new record
        if (!await showConfirmModal(t('Delete Record'), t('Delete "{name}"? This will permanently delete this newly created record.', { name: escapeHtml(currentDiffFile.displayName) }), 'danger')) return;

        showSpinner(t('Deleting...'));
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
                // Mark all changes as invalidated — across the active chat
                // AND its sub-agent chats (the record may be sub-owned).
                setRecordEntriesInvalidated(currentDiffFile.table, currentDiffFile.sysId, true);
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
                showSnackbar(t('Deleted "{name}"', { name: currentDiffFile.displayName }), 'success');
                closeDiffViewer();
            } else {
                showSnackbar(t('Delete failed'), 'error');
            }
        } catch (e) {
            showSnackbar(t('Delete failed: {error}', { error: e.message }), 'error');
        }
        hideSpinner();
    } else if (currentDiffFile.firstBeforeVersion) {
        // Revert to before chat
        if (!await showConfirmModal(t('Revert Changes'), t('Revert "{name}" to its state before this chat? You can redo this later.', { name: escapeHtml(currentDiffFile.displayName) }))) return;

        showSpinner(t('Reverting...'));
        try {
            var xml = await getVersionXml(currentDiffFile.firstBeforeVersion);
            if (xml) {
                var result = await uploadXml(xml, currentDiffFile.table, currentDiffFile.sysId);
                if (result.success) {
                    // Mark all changes as invalidated — across the active chat
                    // AND its sub-agent chats (the record may be sub-owned).
                    setRecordEntriesInvalidated(currentDiffFile.table, currentDiffFile.sysId, true);
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
                    showSnackbar(t('Reverted "{name}"', { name: currentDiffFile.displayName }), 'success');
                    closeDiffViewer();
                } else {
                    showSnackbar(t('Revert failed: {error}', { error: result.error }), 'error');
                }
            }
        } catch (e) {
            showSnackbar(t('Revert failed: {error}', { error: e.message }), 'error');
        }
        hideSpinner();
    }
}
