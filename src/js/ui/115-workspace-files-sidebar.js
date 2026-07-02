// =============================================
// Workspace Files sidebar section
// =============================================
// Shows files edited via the `workspace` tool in the CURRENT chat as sidebar
// artifacts (mirroring the ServiceNow record "Artifacts" section): view the
// live content, diff vs the clone base, a derived version history (rebuilt
// from the chat's recorded tool calls — no extra persistence), restore a
// version, and discard uncommitted changes.
//
// The file LIST is derived synchronously from chat.messages (same retroactive
// pattern as getPushedPRsForChat), so it works for old chats and survives
// push/discard. Live workspace state (dirty/deleted/content) is only fetched
// when a modal opens.

var _wsfMutatingActions = { write: 1, edit: 1, delete: 1, copy: 1, discard: 1 };
var _wsfSectionFiles = [];   // render-time registry so onclick handlers use indexes, not escaped paths
var _wsfVersionState = null; // state backing the currently open versions modal

// --- Extraction -------------------------------------------------------------

// Scan one chat's messages for SUCCESSFUL mutating workspace tool calls.
// Returns [{action, args, path, wsKey, msgIdx, created}]
function _wsfScanChat(chat) {
    var out = [];
    if (!chat || !chat.messages) return out;
    var pending = {};
    chat.messages.forEach(function(msg, idx) {
        if (msg.role === 'assistant' && msg.tool_calls) {
            msg.tool_calls.forEach(function(tc) {
                if (!tc.function || tc.function.name !== 'workspace' || !tc.id) return;
                var a;
                try { a = JSON.parse(tc.function.arguments); } catch (e) { return; }
                if (!a || !_wsfMutatingActions[a.action]) return;
                // copy writes to `dest`; a discard without a path is a bulk
                // discard we cannot attribute to a single file — skip it.
                var path = a.action === 'copy' ? a.dest : a.path;
                if (!path) return;
                pending[tc.id] = { action: a.action, args: a, path: path, wsKey: a.workspace || null, msgIdx: idx };
            });
        } else if (msg.role === 'tool' && msg.tool_call_id && pending[msg.tool_call_id]) {
            var entry = pending[msg.tool_call_id];
            delete pending[msg.tool_call_id];
            var r = msg.content;
            if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = null; } }
            if (!r || !r.success) return;
            entry.created = !!(r.message && /^(Created|Restored)/.test(r.message));
            out.push(entry);
        }
    });
    return out;
}

// Group the current chat's workspace changes by file.
// Returns [{path, wsKey, changes: [...], isNew, isDeleted, isDiscarded}]
function getWsEditedFilesForChat(chat) {
    var changes = _wsfScanChat(chat);
    var byKey = {};
    var order = [];
    changes.forEach(function(ch) {
        // Group by PATH only: the same file is often addressed both with and
        // without an explicit `workspace` arg within one chat — one card each
        // would be confusing. The first explicit wsKey seen is backfilled.
        var key = '::' + ch.path;
        if (!byKey[key]) {
            byKey[key] = { path: ch.path, wsKey: ch.wsKey, changes: [] };
            order.push(key);
        }
        if (ch.wsKey && !byKey[key].wsKey) byKey[key].wsKey = ch.wsKey;
        byKey[key].changes.push(ch);
    });
    return order.map(function(key) {
        var f = byKey[key];
        var last = f.changes[f.changes.length - 1];
        f.isNew = f.changes.some(function(c) { return c.created; });
        f.isDeleted = last.action === 'delete';
        f.isDiscarded = last.action === 'discard';
        return f;
    });
}

// --- Sidebar section renderer (called from renderVersionSidebar) ------------

function renderWorkspaceFilesSection(chat) {
    var files = getWsEditedFilesForChat(chat);
    _wsfSectionFiles = files;
    if (files.length === 0) return '';

    var html = '<div class="version-wsfiles-section">';
    html += '<div class="version-section-title">Workspace Files (' + files.length + ')</div>';
    html += '<div class="version-files-list">';
    files.forEach(function(f, i) {
        var name = f.path.split('/').pop();
        var dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
        var badge;
        if (f.isDeleted) badge = '<span class="sn-status-badge sn-status-deleted">DELETED</span>';
        else if (f.isDiscarded) badge = '<span class="sn-status-badge sn-status-reverted">DISCARDED</span>';
        else if (f.isNew) badge = '<span class="sn-status-badge sn-status-new">NEW</span>';
        else badge = '<span class="sn-status-badge sn-status-modified">MODIFIED</span>';
        var changesBadge = f.changes.length > 1 ? '<span class="sn-changes-badge">' + f.changes.length + ' changes</span>' : '';
        var wsLabel = f.wsKey ? escapeHtml(f.wsKey.split('/').pop()) : '';

        // Diff-first: the most useful view of an edited file is what changed.
        html += '<div class="sn-artifact-card sidebar-card wsf-card" onclick="wsfOpenDiff(' + i + ')" title="' + escapeHtml(f.path) + '">';
        html += '<div class="sn-artifact-content">';
        html += '<div class="sn-artifact-name">' + escapeHtml(name) + '</div>';
        html += '<div class="sn-artifact-meta">' + (dir ? '<span class="wsf-dir">' + escapeHtml(dir) + '</span>' : '') + (wsLabel ? '<span class="wsf-ws">' + wsLabel + '</span>' : '') + badge + changesBadge + '</div>';
        html += '</div>';
        html += '</div>';
    });
    html += '</div>';
    html += '</div>';
    return html;
}

// --- Live file resolution ----------------------------------------------------

// Resolve the live workspace file record for a section entry. When the tool
// call omitted `workspace`, probe all local workspaces (pinned first).
// Returns { wsKey, rec } or null.
async function _wsfResolve(f) {
    try {
        if (f.wsKey) {
            var rec = await getWorkspaceFile(f.wsKey, f.path);
            return rec ? { wsKey: f.wsKey, rec: rec } : null;
        }
        var metas = await getAllWorkspaceMetas();
        metas.sort(function(a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
        for (var i = 0; i < metas.length; i++) {
            var r = await getWorkspaceFile(metas[i].repo, f.path);
            if (r) return { wsKey: metas[i].repo, rec: r };
        }
    } catch (e) {
        console.error('wsf resolve failed', e);
    }
    return null;
}

function _wsfFmtSize(s) {
    var n = (s || '').length;
    if (n < 1024) return n + ' B';
    return (n / 1024).toFixed(1) + ' KB';
}

// --- Overlay helper ----------------------------------------------------------

// opts: { fileIndex, active } — when fileIndex is set, the header shows the
// SAME file action icons on every modal (view / diff / versions / discard),
// with the current one highlighted; clicking one switches modals.
function _wsfOverlay(titleHtml, bodyHtml, opts) {
    var actionsHtml = '';
    var navHtml = '';
    if (opts && opts.fileIndex != null && opts.fileIndex >= 0) {
        // Prev/next file navigation (same pattern as the screenshot modal):
        // keeps the current view (view/diff/versions) while switching files.
        if (_wsfSectionFiles.length > 1) {
            var fi = opts.fileIndex;
            var act = opts.active || 'view';
            navHtml = '<div class="wsf-modal-nav">'
                + '<button class="sn-artifact-icon-btn" onclick="wsfNavFile(' + (fi - 1) + ',\'' + act + '\')" title="Previous file (\u2190)"' + (fi <= 0 ? ' disabled' : '') + '>' + UI_ICONS.chevronLeft + '</button>'
                + '<span class="wsf-nav-counter">' + (fi + 1) + ' / ' + _wsfSectionFiles.length + '</span>'
                + '<button class="sn-artifact-icon-btn" onclick="wsfNavFile(' + (fi + 1) + ',\'' + act + '\')" title="Next file (\u2192)"' + (fi >= _wsfSectionFiles.length - 1 ? ' disabled' : '') + '>' + UI_ICONS.chevronRight + '</button>'
                + '</div>';
        }
        var acts = [
            { id: 'view', icon: UI_ICONS.eye, title: 'View file' },
            { id: 'diff', icon: UI_ICONS.diff, title: 'Diff vs base' },
            { id: 'versions', icon: UI_ICONS.history, title: 'Version history' },
            { id: 'discard', icon: UI_ICONS.undo, title: 'Discard uncommitted changes', danger: true }
        ];
        actionsHtml = '<div class="wsf-modal-actions">' + acts.map(function(a) {
            var cls = 'sn-artifact-icon-btn' + (a.danger ? ' danger' : '') + (opts.active === a.id ? ' active' : '');
            return '<button class="' + cls + '" onclick="wsfHeaderAction(' + opts.fileIndex + ',\'' + a.id + '\')" title="' + a.title + '">' + a.icon + '</button>';
        }).join('') + '</div>';
    }
    var overlay = document.createElement('div');
    overlay.className = 'wsf-overlay';
    overlay.innerHTML = '<div class="wsf-modal">'
        + '<div class="wsf-modal-header"><div class="wsf-modal-title">' + titleHtml + '</div>'
        + navHtml
        + actionsHtml
        + '<button class="wsf-modal-close" title="Close">' + UI_ICONS.close + '</button></div>'
        + '<div class="wsf-modal-body">' + bodyHtml + '</div></div>';
    function onKey(e) {
        // Overlays stack (viewer/diff opened from the versions modal): only the
        // TOPMOST one may react to keys, otherwise one keypress closes all.
        var all = document.querySelectorAll('.wsf-overlay');
        if (!all.length || all[all.length - 1] !== overlay) return;
        if (e.key === 'Escape') { close(); return; }
        // Left/right arrows switch files (like the screenshot modal).
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && opts && opts.fileIndex != null && opts.fileIndex >= 0 && _wsfSectionFiles.length > 1) {
            var t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            e.preventDefault();
            wsfNavFile(opts.fileIndex + (e.key === 'ArrowRight' ? 1 : -1), (opts.active || 'view'));
        }
    }
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
    overlay.querySelector('.wsf-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    // Expose the real closer so bulk removals (wsfGoToVersionMsg, restore)
    // detach the document keydown listener instead of leaking it.
    overlay._wsfClose = close;
    document.body.appendChild(overlay);
    return overlay;
}

function _wsfNotFoundMsg(f) {
    showSnackbar('"' + f.path + '" not found in any local workspace (deleted new file, synced away, or repo re-cloned)', 'warning');
}

// Prev/next navigation between the chat's edited files, keeping the current
// view (view / diff / versions) — wired to the header chevrons + arrow keys.
function wsfNavFile(i, act) {
    if (i < 0 || i >= _wsfSectionFiles.length) return;
    wsfHeaderAction(i, act === 'discard' ? 'view' : act);
}

// Modal header action icons / prev-next nav: switch modals in place.
// The open functions are ASYNC (they await IndexedDB before building the new
// overlay), so the old overlay is closed only AFTER the replacement has
// mounted — closing it first left a gap with no modal at all, which made the
// dialog visibly flash (close + reopen) on every header icon / next click.
function wsfHeaderAction(i, act) {
    var old = Array.prototype.slice.call(document.querySelectorAll('.wsf-overlay'));
    function closeOld() { old.forEach(function(o) { o._wsfClose ? o._wsfClose() : o.remove(); }); }
    if (act === 'discard') {
        // Discard opens a confirm dialog, not a replacement wsf modal — close
        // the overlays up front like before.
        closeOld();
        wsfDiscardFile(i);
        return;
    }
    var p = act === 'diff' ? wsfOpenDiff(i) : act === 'versions' ? wsfOpenVersions(i) : wsfOpenViewer(i);
    // Close the old overlay(s) once the new one is in the DOM (the promise
    // resolves after _wsfOverlay appended it). New overlays stack on top, so
    // the swap is seamless. On failure (file not found) close them too —
    // matching the previous end state (snackbar, no modal).
    if (p && typeof p.then === 'function') p.then(closeOld, closeOld);
    else closeOld();
}

// --- Viewer ------------------------------------------------------------------

async function wsfOpenViewer(i) {
    var f = _wsfSectionFiles[i];
    if (!f) return;
    var res = await _wsfResolve(f);
    if (!res) { _wsfNotFoundMsg(f); return; }
    var rec = res.rec;
    var status = rec.deleted ? 'Deleted' : (rec.dirty ? 'Modified (uncommitted)' : 'Clean (matches base)');
    var body = '<div class="wsf-file-meta">' + escapeHtml(res.wsKey) + ' \u00b7 ' + status + ' \u00b7 ' + _wsfFmtSize(rec.content) + '</div>';
    if (rec.stub && rec.content == null) {
        body += '<div class="wsf-empty">Content not loaded locally (lazy clone stub).</div>';
    } else {
        body += '<pre class="wsf-code">' + escapeHtml(rec.content || '') + '</pre>';
    }
    _wsfOverlay(escapeHtml(f.path), body, { fileIndex: i, active: 'view' });
}

// --- Diff --------------------------------------------------------------------

// Compact generic line-diff renderer reusing 16-diff.css classes.
// computeDiff() (090-version-history.js) is a generic line LCS.
function _wsfRenderDiffHtml(oldText, newText) {
    var diff = computeDiff(oldText || '', newText || '');
    var adds = 0, dels = 0;
    diff.forEach(function(d) {
        if (d.type === 'add') adds++;
        else if (d.type === 'remove') dels++;
    });
    if (adds === 0 && dels === 0) {
        return '<div class="wsf-empty">No differences</div>';
    }
    // Visibility: keep 3 context lines around every change, collapse the rest.
    var CONTEXT = 3;
    var visible = new Array(diff.length);
    diff.forEach(function(d, idx) {
        if (d.type === 'same') return;
        for (var j = Math.max(0, idx - CONTEXT); j <= Math.min(diff.length - 1, idx + CONTEXT); j++) visible[j] = true;
    });
    var html = '<div class="wsf-diff-stats"><span class="wsf-diff-add">+' + adds + '</span><span class="wsf-diff-del">\u2212' + dels + '</span></div>';
    html += '<div class="diff-container"><div class="diff-lines">';
    var hiddenRun = 0;
    function flushHidden() {
        if (hiddenRun > 0) {
            html += '<div class="diff-separator"><span class="diff-separator-text">\u22ef ' + hiddenRun + ' unchanged line' + (hiddenRun === 1 ? '' : 's') + '</span></div>';
            hiddenRun = 0;
        }
    }
    diff.forEach(function(d, idx) {
        if (!visible[idx] && d.type === 'same') { hiddenRun++; return; }
        flushHidden();
        var cls = d.type === 'add' ? ' diff-add' : (d.type === 'remove' ? ' diff-remove' : '');
        var prefix = d.type === 'add' ? '+' : (d.type === 'remove' ? '\u2212' : ' ');
        html += '<div class="diff-line' + cls + '">'
            + '<span class="diff-line-num old">' + (d.oldLine || '') + '</span>'
            + '<span class="diff-line-num new">' + (d.newLine || '') + '</span>'
            + '<span class="diff-prefix">' + prefix + '</span>'
            + '<span class="diff-text">' + escapeHtml(d.text) + '</span>'
            + '</div>';
    });
    flushHidden();
    html += '</div></div>';
    return html;
}

async function wsfOpenDiff(i) {
    var f = _wsfSectionFiles[i];
    if (!f) return;
    var res = await _wsfResolve(f);
    if (!res) { _wsfNotFoundMsg(f); return; }
    var rec = res.rec;
    var oldText = rec.original_content != null ? rec.original_content : '';
    var newText = rec.deleted ? '' : (rec.content || '');
    var note = rec.dirty ? '' : '<div class="wsf-file-meta">File has no uncommitted changes \u2014 it matches its base.</div>';
    _wsfOverlay(escapeHtml(f.path) + ' <span class="wsf-title-sub">base \u2192 current</span>', note + _wsfRenderDiffHtml(oldText, newText), { fileIndex: i, active: 'diff' });
}

// --- Versions ---------------------------------------------------------------

// Derived version history: every recorded mutating workspace tool call for
// this path (across ALL chats, badged per chat) becomes a version point.
// Contents are reconstructed by replaying the recorded args on top of the
// clone base: write => full content, edit => apply find/replace, delete =>
// empty, discard => back to base. Replays that cannot be reproduced (edit on
// unknown content, copy, write-from-file_id, missing base) mark versions as
// non-reconstructable until the next full write/discard.
async function wsfOpenVersions(i) {
    var f = _wsfSectionFiles[i];
    if (!f) return;
    var res = await _wsfResolve(f);

    // Gather changes for this path across all chats.
    var entries = [];
    Object.keys(chats).forEach(function(cid) {
        _wsfScanChat(chats[cid]).forEach(function(ch) {
            if (ch.path !== f.path) return;
            if (ch.wsKey && f.wsKey && ch.wsKey !== f.wsKey) return;
            ch.chatId = cid;
            ch.chatTitle = chats[cid].title || 'Untitled chat';
            entries.push(ch);
        });
    });
    // Order: chats by their creation timestamp (embedded in the id), then
    // message order within a chat. Cross-chat interleaving within the same
    // period is approximated.
    function chatTs(cid) {
        var m = /^chat_(?:sub_)?[a-z0-9]*?(\d{9,})/.exec(cid);
        return m ? parseInt(m[1], 10) : 0;
    }
    entries.sort(function(a, b) {
        return chatTs(a.chatId) - chatTs(b.chatId) || (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0) || a.msgIdx - b.msgIdx;
    });

    var base = res && res.rec && res.rec.original_content != null ? res.rec.original_content : null;
    var versions = [];
    versions.push({ action: 'base', label: 'Base (clone)', content: base, ok: base != null });
    var cur = base;
    var reliable = base != null;
    entries.forEach(function(ch) {
        var v = { action: ch.action, chatId: ch.chatId, chatTitle: ch.chatTitle, msgIdx: ch.msgIdx, args: ch.args };
        if (ch.action === 'write') {
            if (typeof ch.args.content === 'string') { cur = ch.args.content; reliable = true; }
            else { cur = null; reliable = false; } // write from file_id — content not in the transcript
        } else if (ch.action === 'edit') {
            if (reliable && Array.isArray(ch.args.edits)) {
                for (var k = 0; k < ch.args.edits.length; k++) {
                    var e = ch.args.edits[k];
                    var at = (cur || '').indexOf(e.find);
                    if (at < 0) { reliable = false; cur = null; break; }
                    cur = cur.slice(0, at) + e.replace + cur.slice(at + e.find.length);
                }
            } else { reliable = false; cur = null; }
        } else if (ch.action === 'delete') {
            cur = ''; reliable = true;
        } else if (ch.action === 'discard') {
            cur = base; reliable = base != null;
        } else if (ch.action === 'copy') {
            cur = null; reliable = false; // source content unknown at that point in time
        }
        v.content = reliable ? cur : null;
        v.ok = reliable;
        versions.push(v);
    });
    if (res && res.rec) {
        versions.push({ action: 'current', label: 'Current', content: res.rec.deleted ? '' : res.rec.content, ok: res.rec.content != null });
    }

    _wsfVersionState = { file: f, fileIndex: i, wsKey: res ? res.wsKey : f.wsKey, versions: versions };

    var icons = { base: UI_ICONS.gitBranch, write: UI_ICONS.edit, edit: UI_ICONS.edit, 'delete': UI_ICONS.trash, discard: UI_ICONS.undo, copy: UI_ICONS.copy, current: UI_ICONS.check };
    var body = '<div class="wsf-versions-list">';
    versions.forEach(function(v, vi) {
        var label = v.label || (v.action.charAt(0).toUpperCase() + v.action.slice(1));
        var isThisChat = v.chatId && v.chatId === currentChatId;
        var chatChip = v.chatId
            ? '<span class="wsf-ver-chat' + (isThisChat ? ' this-chat' : '') + '"' + (isThisChat ? ' onclick="wsfGoToVersionMsg(' + vi + ')" title="Show in chat"' : ' title="' + escapeHtml(v.chatTitle) + '"') + '>' + UI_ICONS.chat + ' ' + escapeHtml(isThisChat ? 'this chat' : (v.chatTitle.length > 28 ? v.chatTitle.slice(0, 28) + '\u2026' : v.chatTitle)) + '</span>'
            : '';
        body += '<div class="wsf-ver-row' + (v.ok ? '' : ' unreliable') + '">';
        body += '<span class="wsf-ver-num">v' + vi + '</span>';
        body += '<span class="wsf-ver-icon">' + (icons[v.action] || UI_ICONS.file) + '</span>';
        body += '<span class="wsf-ver-label">' + escapeHtml(label) + '</span>';
        body += chatChip;
        if (!v.ok && v.action !== 'base') body += '<span class="wsf-ver-note" title="Content could not be rebuilt from the recorded tool calls">not reconstructable</span>';
        body += '<span class="wsf-ver-actions">';
        if (v.content != null) {
            body += '<button class="sn-artifact-icon-btn" onclick="wsfViewVersion(' + vi + ')" title="View this version">' + UI_ICONS.eye + '</button>';
        }
        if (vi > 0) {
            body += '<button class="sn-artifact-icon-btn" onclick="wsfDiffVersion(' + vi + ')" title="Diff vs previous version">' + UI_ICONS.diff + '</button>';
        }
        if (v.content != null && v.action !== 'current') {
            body += '<button class="sn-artifact-icon-btn" onclick="wsfRestoreVersion(' + vi + ')" title="Restore this version into the workspace">' + UI_ICONS.undo + '</button>';
        }
        body += '</span>';
        body += '</div>';
    });
    body += '</div>';
    if (!res) body += '<div class="wsf-file-meta">File no longer exists in a local workspace \u2014 base and current content unavailable.</div>';
    _wsfOverlay(escapeHtml(f.path) + ' <span class="wsf-title-sub">' + (versions.length) + ' versions</span>', body, { fileIndex: i, active: 'versions' });
}

function wsfGoToVersionMsg(vi) {
    var st = _wsfVersionState;
    if (!st || !st.versions[vi]) return;
    document.querySelectorAll('.wsf-overlay').forEach(function(o) { o._wsfClose ? o._wsfClose() : o.remove(); });
    scrollToMessage(st.versions[vi].msgIdx);
}

function wsfViewVersion(vi) {
    var st = _wsfVersionState;
    if (!st || !st.versions[vi] || st.versions[vi].content == null) return;
    var v = st.versions[vi];
    _wsfOverlay(escapeHtml(st.file.path) + ' <span class="wsf-title-sub">v' + vi + '</span>',
        '<div class="wsf-file-meta">' + _wsfFmtSize(v.content) + '</div><pre class="wsf-code">' + escapeHtml(v.content) + '</pre>',
        { fileIndex: st.fileIndex, active: 'versions' });
}

function wsfDiffVersion(vi) {
    var st = _wsfVersionState;
    if (!st || !st.versions[vi]) return;
    var v = st.versions[vi];
    var prev = st.versions[vi - 1];
    var body;
    if (v.content != null && prev && prev.content != null) {
        body = _wsfRenderDiffHtml(prev.content, v.content);
    } else if (v.action === 'edit' && v.args && Array.isArray(v.args.edits)) {
        // Fallback when replay failed: show the recorded find/replace hunks.
        body = '<div class="wsf-file-meta">Exact version content could not be rebuilt \u2014 showing the recorded search &amp; replace operations of this change.</div>';
        v.args.edits.forEach(function(e, k) {
            body += '<div class="wsf-edit-hunk-title">Edit ' + (k + 1) + '</div>' + _wsfRenderDiffHtml(e.find, e.replace);
        });
    } else {
        body = '<div class="wsf-empty">Not enough recorded data to build this diff.</div>';
    }
    _wsfOverlay(escapeHtml(st.file.path) + ' <span class="wsf-title-sub">v' + (vi - 1) + ' \u2192 v' + vi + '</span>', body, { fileIndex: st.fileIndex, active: 'versions' });
}

async function wsfRestoreVersion(vi) {
    var st = _wsfVersionState;
    if (!st || !st.versions[vi] || st.versions[vi].content == null) return;
    var v = st.versions[vi];
    if (!await showConfirmModal('Restore Version', 'Restore "' + st.file.path + '" to v' + vi + '? This overwrites the current workspace content as a new uncommitted change.')) return;
    try {
        showSpinner('Restoring v' + vi + '...');
        var args;
        if (v.action === 'base') {
            args = { action: 'discard', path: st.file.path };
        } else {
            args = { action: 'write', path: st.file.path, content: v.content };
        }
        if (st.wsKey) args.workspace = st.wsKey;
        var r = await executeWorkspaceTool(args, { chatId: currentChatId });
        hideSpinner();
        if (r && r.success) {
            showSnackbar('Restored "' + st.file.path + '" to v' + vi, 'success');
            document.querySelectorAll('.wsf-overlay').forEach(function(o) { o._wsfClose ? o._wsfClose() : o.remove(); });
            renderVersionSidebar();
        } else {
            showSnackbar('Restore failed: ' + ((r && r.error) || 'unknown error'), 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar('Restore failed: ' + e.message, 'error');
    }
}

// --- Discard ----------------------------------------------------------------

async function wsfDiscardFile(i) {
    var f = _wsfSectionFiles[i];
    if (!f) return;
    var res = await _wsfResolve(f);
    if (!res) { _wsfNotFoundMsg(f); return; }
    if (!res.rec.dirty) {
        showSnackbar('"' + f.path + '" has no uncommitted changes', 'warning');
        return;
    }
    if (!await showConfirmModal('Discard Changes', 'Discard uncommitted changes to "' + f.path + '"? The file is reset to its cloned base content. This cannot be undone.', 'danger')) return;
    try {
        showSpinner('Discarding...');
        var args = { action: 'discard', path: f.path, workspace: res.wsKey };
        var r = await executeWorkspaceTool(args, { chatId: currentChatId });
        hideSpinner();
        if (r && r.success) {
            showSnackbar('Discarded changes to "' + f.path + '"', 'success');
            renderVersionSidebar();
        } else {
            showSnackbar('Discard failed: ' + ((r && r.error) || 'unknown error'), 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar('Discard failed: ' + e.message, 'error');
    }
}

// --- Live refresh -----------------------------------------------------------

// Re-render the sidebar when the agent mutates the workspace mid-run so the
// section stays live. AgentEvents may load after this file — retry briefly.
(function _wsfHookMutations() {
    var tries = 0;
    function hook() {
        if (typeof AgentEvents === 'undefined' || !AgentEvents || !AgentEvents.on) {
            if (++tries < 15) setTimeout(hook, 2000);
            return;
        }
        AgentEvents.on('workspaceMutated', function(ev) {
            try {
                // Workspace state is GLOBAL (shared across chats and panels):
                // refresh on ANY mutation. The old ev.chatId === currentChatId
                // gate silently dropped (a) the chatId-less workspace-level
                // emits (clone / pin / push / auto_delete_merged — so a push
                // never live-refreshed this sidebar) and (b) mutations made by
                // background chats or relayed from other panels — leaving the
                // sidebar stale exactly when someone else changed the workspace.
                if (!ev) return;
                if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
            } catch (e) { /* sidebar not ready */ }
        });
    }
    setTimeout(hook, 0);
})();
