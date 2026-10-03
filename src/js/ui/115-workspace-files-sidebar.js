// =============================================
// Workspace Files sidebar section
// =============================================
// Shows files edited via the `workspace` tool in the CURRENT chat as sidebar
// artifacts (mirroring the ServiceNow record "Artifacts" section): view the
// live content, diff vs the clone base, a derived version history (rebuilt
// from the chat's recorded tool calls — no extra persistence), restore a
// version, and discard uncommitted changes.
//
// Recorded calls supply history; an async ownership cache supplements the list
// for nested tool writes whose calls are not recorded individually. File bodies
// are fetched only when a modal opens.

var _wsfMutatingActions = { write: 1, edit: 1, delete: 1, copy: 1, discard: 1 };
var _wsfSectionFiles = [];   // render-time registry so onclick handlers use indexes, not escaped paths
var _wsfVersionState = null; // state backing the currently open versions modal

// --- Extraction -------------------------------------------------------------

// Scan one chat's messages for SUCCESSFUL mutating workspace tool calls.
// Returns [{action, args, path, wsKey, msgIdx, created}]
// C2-ui SKEL-SCAN: a skeleton (no messages array, _messagesEvicted) answers
// from its stored row via skeletonScanValue (slot 'wsf'), then the sidebar
// re-renders. The memo is small JSON: args slimmed to the WSF-EVICT
// {action, path, dest, workspace} stub and `pushed` carried beside the list
// (a JSON clone drops array properties). A hydrated chat scans live, as before.
function _wsfScanChat(chat) {
    if (!chat || Array.isArray(chat.messages) || !chat._messagesEvicted || typeof skeletonScanValue !== 'function') return _wsfScanChatLive(chat);
    var packed = skeletonScanValue('wsf', chat.id, chat, _wsfScanPacked, null, _wsfSkelRerender);
    var out = (packed && Array.isArray(packed.list)) ? packed.list : [];
    out.pushed = (packed && packed.pushed) || {};
    return out;
}
function _wsfScanPacked(chat) {
    var live = _wsfScanChatLive(chat);
    return {
        list: live.map(function(ch) {
            var a = ch.args || {};
            var slim = { action: a.action, path: a.path, dest: a.dest, workspace: a.workspace };
            return { action: ch.action, args: slim, path: ch.path, wsKey: ch.wsKey, msgIdx: ch.msgIdx, tcIdx: ch.tcIdx, created: !!ch.created };
        }),
        pushed: live.pushed || {}
    };
}
function _wsfSkelRerender() {
    if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
}
function _wsfScanChatLive(chat) {
    var out = [];
    if (!chat || !chat.messages) return out;
    var pending = {};
    var pushIds = {};
    // WSF-PR: path -> {url, number} of the PR a successful push carried it to.
    out.pushed = {};
    chat.messages.forEach(function(msg, idx) {
        if (msg.role === 'assistant' && msg.tool_calls) {
            msg.tool_calls.forEach(function(tc, tcIdx) {
                if (!tc.function || tc.function.name !== 'workspace' || !tc.id) return;
                var a = null;
                try { a = JSON.parse(tc.function.arguments); } catch (e) { a = null; }
                // WSF-EVICT: a cold (evicted) chat keeps only a compact
                // {action, path, dest, workspace} stub of mutating calls
                // (stripChatPayloadsInPlace, core/130-indexeddb.js).
                if (!a && tc._wsArgs) a = tc._wsArgs;
                if (a && a.action === 'push') { pushIds[tc.id] = true; return; }
                if (!a || !_wsfMutatingActions[a.action]) return;
                // copy writes to `dest`; a discard without a path is a bulk
                // discard we cannot attribute to a single file — skip it.
                var path = a.action === 'copy' ? a.dest : a.path;
                if (!path) return;
                pending[tc.id] = { action: a.action, args: a, path: path, wsKey: a.workspace || null, msgIdx: idx, tcIdx: tcIdx };
            });
        } else if (msg.role === 'tool' && msg.tool_call_id && pushIds[msg.tool_call_id]) {
            // WSF-PR: push results stay resident (PR-CHIP) and list every
            // pushed file — attribute each path to its PR.
            var pr = msg.content;
            if (typeof pr === 'string') { try { pr = JSON.parse(pr); } catch (e) { pr = null; } }
            if (pr && pr.success && pr.pr_url && Array.isArray(pr.files)) {
                pr.files.forEach(function(pf) {
                    if (!pf || !pf.path) return;
                    // Keep the legacy path slot for packed skeleton consumers; retain
                    // additional workspaces separately rather than overwriting that slot.
                    var prior = out.pushed[pf.path];
                    var pushKey = prior && prior.wsKey !== (pr.workspace || null)
                        ? JSON.stringify([pr.workspace || null, pf.path]) : pf.path;
                    out.pushed[pushKey] = { path: pf.path, url: pr.pr_url, number: pr.pr_number || null, wsKey: pr.workspace || null, isNew: !!pf.isNew, isDeleted: !!pf.isDeleted };
                });
            }
        } else if (msg.role === 'tool' && msg.tool_call_id && pending[msg.tool_call_id]) {
            var entry = pending[msg.tool_call_id];
            delete pending[msg.tool_call_id];
            var r = msg.content;
            if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = null; } }
            if (!r && msg._wsResult) r = msg._wsResult; // WSF-EVICT stub
            if (!r || !r.success) return;
            entry.wsKey = r.workspace || entry.wsKey;
            entry.created = !!(r.message && /^(Created|Restored)/.test(r.message));
            out.push(entry);
        }
    });
    return out;
}

// Group the current chat's workspace changes by file.
// Returns [{path, wsKey, changes: [...], isNew, isDeleted, isDiscarded}]
// Persist only lightweight ownership metadata in this page cache, never file bodies.
var _wsfOwnedRows = null;
var _wsfOwnedLoading = null;
var _wsfOwnedRerun = false;
function _wsfRefreshOwnedRows() {
    if (_wsfOwnedLoading) { _wsfOwnedRerun = true; return _wsfOwnedLoading; }
    if (typeof getWorkspaceOwnedFileSummaries !== 'function') return Promise.resolve();
    _wsfOwnedLoading = Promise.resolve().then(async function() {
        do {
            _wsfOwnedRerun = false;
            try {
                var rows = await getWorkspaceOwnedFileSummaries();
                if (!Array.isArray(rows)) throw new Error('Workspace ownership snapshot unavailable');
                var changed = JSON.stringify(rows) !== JSON.stringify(_wsfOwnedRows);
                _wsfOwnedRows = rows;
                if (changed && typeof renderVersionSidebar === 'function') renderVersionSidebar();
            } catch (e) { /* Retain the last good cache on a failed or partial read. */ }
        } while (_wsfOwnedRerun);
    }).finally(function() { _wsfOwnedLoading = null; });
    return _wsfOwnedLoading;
}
function _wsfOwnedForChat(chat) {
    if (_wsfOwnedRows === null && !_wsfOwnedLoading) _wsfRefreshOwnedRows();
    return (_wsfOwnedRows || []).filter(function(r) { return chat && chat.id && r.owner === chat.id; });
}
function getWsEditedFilesForChat(chat) {
    var changes = _wsfScanChat(chat);
    var owned = typeof _wsfOwnedForChat === 'function' ? _wsfOwnedForChat(chat) : [];
    var pushed = changes.pushed || {};
    var pushes = Object.keys(pushed).map(function(k) {
        return Object.assign({ path: k }, pushed[k]);
    });
    var candidates = changes.concat(owned, pushes);
    // An omitted workspace can only be backfilled when the evidence is unique.
    function workspaceFor(item) {
        if (item.wsKey) return item.wsKey;
        var keys = [];
        candidates.forEach(function(c) {
            if (c.path === item.path && c.wsKey && keys.indexOf(c.wsKey) < 0) keys.push(c.wsKey);
        });
        return keys.length === 1 ? keys[0] : null;
    }
    var byKey = Object.create(null), order = [];
    function entry(item) {
        var wk = workspaceFor(item), key = JSON.stringify([wk, item.path]);
        if (!byKey[key]) {
            byKey[key] = { path: item.path, wsKey: wk, changes: [] };
            order.push(key);
        }
        return byKey[key];
    }
    changes.forEach(function(ch) { entry(ch).changes.push(ch); });
    pushes.forEach(function(pp) {
        var f = entry(pp);
        f.pushOnly = !f.changes.length;
        f.pushedPr = { url: pp.url, number: pp.number };
        f.isNew = !!pp.isNew;
        f.isDeleted = !!pp.isDeleted;
    });
    order.forEach(function(key) {
        var f = byKey[key], last = f.changes[f.changes.length - 1];
        f.isNew = !!f.isNew || f.changes.some(function(c) { return c.created; });
        if (last) f.isDeleted = last.action === 'delete';
        f.isDiscarded = !!last && last.action === 'discard';
    });
    owned.forEach(function(row) {
        var f = entry(row);
        // Ownership is file-list evidence, NOT a recorded edit/version.
        f.isNew = row.isNew;
        f.isDeleted = row.isDeleted;
        f.isDiscarded = false;
        if (row.pushedPr) f.pushedPr = row.pushedPr;
    });
    return order.map(function(key) { return byKey[key]; });
}

// --- Merged-PR diff snapshots -------------------------------------------------

// Durable per-file snapshots of merged PRs (meta.prs[].files — written by
// wsPush, stamped state:'merged' by wsMaybeAutoDeleteMerged / wsSyncWithRemote;
// see 020-tool-execution.js). They let the sidebar badge a file as MERGED and
// show the ORIGINAL pre-merge diff even after the fork workspace was
// auto-deleted on merge. Old PR entries without a files array are simply
// never matched — behavior is unchanged for them.

// Build path → [{pr, file, repo}] from all workspace metas. Candidates keep
// the owning meta's repo so a same-path file in a DIFFERENT repo can never
// match a wsKey-scoped lookup (see _wsfPickSnap).
function _wsfCollectMergedSnaps(metas) {
    var byPath = {};
    (metas || []).forEach(function(m) {
        var prs = (m && Array.isArray(m.prs)) ? m.prs : [];
        var repo = m ? (m.github_repo || (typeof parseWsKey === 'function' && m.repo ? parseWsKey(m.repo).repo : null)) : null;
        prs.forEach(function(pr) {
            if (!pr || pr.state !== 'merged' || !Array.isArray(pr.files)) return;
            pr.files.forEach(function(pf) {
                if (!pf || !pf.path) return;
                if (!byPath[pf.path]) byPath[pf.path] = [];
                byPath[pf.path].push({ pr: pr, file: pf, repo: repo });
            });
        });
    });
    return byPath;
}

// Pick the snapshot for a sidebar entry from its per-path candidate list:
// when the entry carries a wsKey, ONLY snapshots from that wsKey's repo
// match; without one, any repo. Several merged PRs may have touched the
// path — the most recently merged wins.
function _wsfPickSnap(list, wsKey) {
    if (!Array.isArray(list) || !list.length) return null;
    var cands = list;
    if (wsKey && typeof parseWsKey === 'function') {
        var repo = parseWsKey(wsKey).repo;
        cands = list.filter(function(s) { return s && s.repo === repo; });
    }
    var best = null;
    cands.forEach(function(s) {
        if (s && (!best || (s.pr.merged_at || '') > (best.pr.merged_at || ''))) best = s;
    });
    return best;
}

// renderWorkspaceFilesSection is synchronous and meta lives in IDB, so the
// lookup is cached here and refreshed async (lazily on first render + on
// every workspaceMutated event); a refresh that changes the map re-renders
// once. null = never loaded.
var _wsfMergedSnaps = null;
var _wsfMergedSnapsLoading = false;

function _wsfRefreshMergedSnaps() {
    if (_wsfMergedSnapsLoading) return;
    if (typeof getAllWorkspaceMetas !== 'function') return;
    _wsfMergedSnapsLoading = true;
    getAllWorkspaceMetas().then(function(metas) {
        var byPath = _wsfCollectMergedSnaps(metas);
        function sig(map) {
            if (!map) return 'null';
            return JSON.stringify(Object.keys(map).sort().map(function(p) {
                return [p].concat(map[p].map(function(s) { return [s.repo, s.file.old_sha, s.file.new_sha, s.pr.number]; }));
            }));
        }
        var changed = sig(byPath) !== sig(_wsfMergedSnaps);
        _wsfMergedSnaps = byPath;
        _wsfMergedSnapsLoading = false;
        if (changed && typeof renderVersionSidebar === 'function') renderVersionSidebar();
    }).catch(function() { _wsfMergedSnapsLoading = false; });
}

// Sync lookup for render time; kicks the first load when never loaded.
function _wsfMergedSnapFor(path, wsKey) {
    if (_wsfMergedSnaps === null) { _wsfRefreshMergedSnaps(); return null; }
    return _wsfPickSnap(_wsfMergedSnaps[path], wsKey);
}

// --- Sidebar section renderer (called from renderVersionSidebar) ------------

function renderWorkspaceFilesSection(chat) {
    var files = getWsEditedFilesForChat(chat);
    // Sub-agent aggregation: files edited from this chat's sub-agent chats
    // surface in the parent sidebar too, attributed with a worker-name chip
    // (f.workers). De-duped by workspace and path — when both the parent and a worker
    // touched the same workspace/path the change lists are merged (change-count badge
    // includes both) but the parent's status flags win: cross-chat ordering
    // is not derivable from per-chat message indexes. Uses the global
    // currentChatId (renderVersionSidebar always passes chats[currentChatId]);
    // getSubAgentChatsForChat (120-ui-utils.js) never returns siblings, so
    // sibling chats cannot leak into each other.
    var _subChats = (chat && typeof getSubAgentChatsForChat === 'function')
        ? getSubAgentChatsForChat(chat.id) : [];
    // Registry records outlive evicted/missing chat bodies; keep their owned files visible.
    if (chat && typeof subAgentsForChatTree === 'function') {
        (subAgentsForChatTree(chat.id) || []).forEach(function(r) {
            if (!r.chat_id || r.chat_id === chat.id || _subChats.some(function(sc) { return sc.chatId === r.chat_id; })) return;
            _subChats.push({ chatId: r.chat_id, name: r.name || r.agent_id || 'worker', chat: { id: r.chat_id } });
        });
    }
    if (_subChats.length) {
        var _byPath = Object.create(null);
        files.forEach(function(f) { _byPath[JSON.stringify([f.wsKey, f.path])] = f; });
        _subChats.forEach(function(sc) {
            getWsEditedFilesForChat(sc.chat).forEach(function(sf) {
                var own = _byPath[JSON.stringify([sf.wsKey, sf.path])];
                if (own) {
                    own.changes = own.changes.concat(sf.changes);
                    if (sf.isNew) own.isNew = true;
                    if (sf.pushedPr && !own.pushedPr) own.pushedPr = sf.pushedPr;
                    if (!own.workers) own.workers = [];
                    if (own.workers.indexOf(sc.name) === -1) own.workers.push(sc.name);
                } else {
                    sf.workers = [sc.name];
                    _byPath[JSON.stringify([sf.wsKey, sf.path])] = sf;
                    files.push(sf);
                }
            });
        });
    }
    _wsfSectionFiles = files;
    if (files.length === 0) return '';

    var html = '<div class="version-wsfiles-section">';
    html += '<div class="version-section-title">' + t('Workspace Files ({count})', { count: files.length }) + '</div>';
    html += '<div class="version-files-list">';
    files.forEach(function(f, i) {
        var name = f.path.split('/').pop();
        var dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
        var badge;
        // A merged-PR snapshot overrides MODIFIED/NEW (the edit landed — that
        // is the more useful state), but never DELETED/DISCARDED which reflect
        // an explicit later local action.
        var mergedSnap = (!f.isDeleted && !f.isDiscarded) ? _wsfMergedSnapFor(f.path, f.wsKey) : null;
        if (f.isDeleted) badge = '<span class="sn-status-badge sn-status-deleted">' + t('DELETED') + '</span>';
        else if (f.isDiscarded) badge = '<span class="sn-status-badge sn-status-reverted">' + t('DISCARDED') + '</span>';
        else if (mergedSnap) badge = '<span class="sn-status-badge sn-status-merged" title="' + escapeHtml(t('Merged in PR #{number}', { number: mergedSnap.pr.number })) + '">' + t('MERGED') + '</span>';
        else if (f.isNew) badge = '<span class="sn-status-badge sn-status-new">' + t('NEW') + '</span>';
        else badge = '<span class="sn-status-badge sn-status-modified">' + t('MODIFIED') + '</span>';
        var changesBadge = f.changes.length > 1 ? '<span class="sn-changes-badge">' + tn(f.changes.length, '{count} change', '{count} changes') + '</span>' : '';
        var wsLabel = f.wsKey ? escapeHtml(f.wsKey.split('/').pop()) : '';
        var workerChips = (f.workers && f.workers.length)
            ? f.workers.map(function(w) { return '<span class="wsf-ws" title="' + escapeHtml(t('Edited by worker {name}', { name: w })) + '">' + escapeHtml(w) + '</span>'; }).join('')
            : '';

        // Diff-first: the most useful view of an edited file is what changed.
        html += '<div class="sn-artifact-card sidebar-card wsf-card" role="button" tabindex="0" data-kbd-click onclick="wsfOpenDiff(' + i + ')" title="' + escapeHtml(f.path) + '">';
        html += '<div class="sn-artifact-content">';
        html += '<div class="sn-artifact-name">' + escapeHtml(name) + '</div>';
        // WSF-PR: link the PR the file was pushed to (own or worker push).
        var prChip = (f.pushedPr && f.pushedPr.url)
            ? '<a class="wsf-ws wsf-pr" href="' + escapeHtml(f.pushedPr.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="' + escapeHtml(t('PR #{number}', { number: f.pushedPr.number || '' })) + '">' + escapeHtml('#' + (f.pushedPr.number || 'PR')) + '</a>'
            : '';
        html += '<div class="sn-artifact-meta">' + (dir ? '<span class="wsf-dir">' + escapeHtml(dir) + '</span>' : '') + (wsLabel ? '<span class="wsf-ws">' + wsLabel + '</span>' : '') + workerChips + badge + prChip + changesBadge + '</div>';
        html += '</div>';
        html += '</div>';
    });
    html += '</div>';
    html += '</div>';
    return html;
}

// --- Live file resolution ----------------------------------------------------

// Resolve the live workspace file record for a section entry. When the tool
// call omitted `workspace`, accept only a unique local match (never guess a branch).
// Returns { wsKey, rec } or null.
async function _wsfResolve(f) {
    try {
        if (f.wsKey) {
            var rec = await getWorkspaceFile(f.wsKey, f.path);
            return rec ? { wsKey: f.wsKey, rec: rec } : null;
        }
        var metas = await getAllWorkspaceMetas();
        var match = null;
        for (var i = 0; i < metas.length; i++) {
            var r = await getWorkspaceFile(metas[i].repo, f.path);
            if (!r) continue;
            if (match) return null; // ambiguous legacy call: fail closed
            match = { wsKey: metas[i].repo, rec: r };
        }
        return match;
    } catch (e) {
        console.error('wsf resolve failed', e);
    }
    return null;
}

function _wsfFmtSize(s) {
    var n = (s || '').length;
    if (n < 1024) return t('{size} B', { size: i18nFormatNumber(n, { useGrouping: false }) });
    return t('{size} KB', { size: i18nFormatNumber(n / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) });
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
                + '<button class="sn-artifact-icon-btn" onclick="wsfNavFile(' + (fi - 1) + ',\'' + act + '\')" title="' + escapeHtml(t('Previous file (\u2190)')) + '"' + (fi <= 0 ? ' disabled' : '') + '>' + UI_ICONS.chevronLeft + '</button>'
                + '<span class="wsf-nav-counter">' + (fi + 1) + ' / ' + _wsfSectionFiles.length + '</span>'
                + '<button class="sn-artifact-icon-btn" onclick="wsfNavFile(' + (fi + 1) + ',\'' + act + '\')" title="' + escapeHtml(t('Next file (\u2192)')) + '"' + (fi >= _wsfSectionFiles.length - 1 ? ' disabled' : '') + '>' + UI_ICONS.chevronRight + '</button>'
                + '</div>';
        }
        var acts = [
            { id: 'view', icon: UI_ICONS.eye, title: t('View file') },
            { id: 'diff', icon: UI_ICONS.diff, title: t('Diff vs base') },
            { id: 'versions', icon: UI_ICONS.history, title: t('Version history') },
            { id: 'discard', icon: UI_ICONS.undo, title: t('Discard uncommitted changes'), danger: true }
        ];
        actionsHtml = '<div class="wsf-modal-actions">' + acts.map(function(a) {
            var cls = 'sn-artifact-icon-btn' + (a.danger ? ' danger' : '') + (opts.active === a.id ? ' active' : '');
            return '<button class="' + cls + '" onclick="wsfHeaderAction(' + opts.fileIndex + ',\'' + a.id + '\')" title="' + escapeHtml(a.title) + '">' + a.icon + '</button>';
        }).join('') + '</div>';
    }
    var overlay = document.createElement('div');
    overlay.className = 'wsf-overlay';
    overlay.innerHTML = '<div class="wsf-modal">'
        + '<div class="wsf-modal-header"><div class="wsf-modal-title">' + titleHtml + '</div>'
        + navHtml
        + actionsHtml
        + '<button class="wsf-modal-close" title="' + escapeHtml(t('Close')) + '">' + UI_ICONS.close + '</button></div>'
        + '<div class="wsf-modal-body">' + bodyHtml + '</div></div>';
    function onKey(e) {
        // Capture phase (see addEventListener below): runs before the bubble-phase
        // Esc ladder, so an open Restore/Discard confirm is still visible here.
        if (document.querySelector('.modal-overlay.show')) return; // the modal owns the keys; the global ladder closes it
        // Overlays stack (viewer/diff opened from the versions modal): only the
        // TOPMOST one may react to keys, otherwise one keypress closes all.
        var all = document.querySelectorAll('.wsf-overlay');
        if (!all.length || all[all.length - 1] !== overlay) return;
        if (e.key === 'Escape') { close(); return; }
        // Left/right arrows switch files (like the screenshot modal).
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && opts && opts.fileIndex != null && opts.fileIndex >= 0 && _wsfSectionFiles.length > 1) {
            var tgt = e.target;
            if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
            e.preventDefault();
            wsfNavFile(opts.fileIndex + (e.key === 'ArrowRight' ? 1 : -1), (opts.active || 'view'));
        }
    }
    var closed = false;
    function close() {
        if (closed) return;
        closed = true;
        overlay.remove(); document.removeEventListener('keydown', onKey, true);
        // opts.onClose: release resources (the Documents page revokes its blob: URLs).
        if (opts && typeof opts.onClose === 'function') { try { opts.onClose(); } catch (_) {} }
        // opts.returnFocus (element, or fn -> element): hand focus back to the opener.
        if (opts && opts.returnFocus) {
            var rf = typeof opts.returnFocus === 'function' ? opts.returnFocus() : opts.returnFocus;
            if (rf && rf.isConnected !== false && typeof rf.focus === 'function') rf.focus();
        }
    }
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
    overlay.querySelector('.wsf-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey, true); // capture: runs before the Esc ladder (see onKey)
    // Expose the real closer so bulk removals (wsfGoToVersionMsg, restore)
    // detach the document keydown listener instead of leaking it.
    overlay._wsfClose = close;
    document.body.appendChild(overlay);
    // Opt-in (callers that pass returnFocus): announce as a modal dialog and
    // move focus into it; close() returns focus to the opener.
    if (opts && opts.returnFocus) {
        var dlg = overlay.querySelector('.wsf-modal');
        dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
        var cb = overlay.querySelector('.wsf-modal-close');
        if (cb && typeof cb.focus === 'function') cb.focus();
    }
    return overlay;
}

function _wsfNotFoundText(f) {
    return t('"{path}" not found in any local workspace (deleted new file, synced away, or repo re-cloned)', { path: f.path });
}
function _wsfNotFoundMsg(f) {
    showSnackbar(_wsfNotFoundText(f), 'warning');
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
    // resolves true after _wsfOverlay appended it). New overlays stack on top,
    // so the swap is seamless. File not found (false; the open fn showed the
    // snackbar): swap in a "not found" placeholder that keeps the prev/next nav
    // and header icons, so navigation can step past it — unless the user closed
    // the overlay meanwhile. On an error keep the current overlay.
    if (p && typeof p.then === 'function') p.then(function(ok) {
        if (ok) return closeOld();
        var f = _wsfSectionFiles[i];
        if (!f || !old.some(function(o) { return o.isConnected; })) return; // user closed meanwhile
        _wsfOverlay(escapeHtml(f.path) + ' <span class="wsf-title-sub">' + t('not found') + '</span>',
            '<div class="wsf-empty">' + escapeHtml(_wsfNotFoundText(f)) + '</div>', { fileIndex: i, active: act });
        closeOld();
    }, function() { /* keep the current overlay */ });
    else closeOld();
}

// --- Viewer ------------------------------------------------------------------

async function wsfOpenViewer(i) {
    var f = _wsfSectionFiles[i];
    if (!f) return false;
    var res = await _wsfResolve(f);
    if (!res) {
        // Live record gone (fork auto-deleted on merge, repo re-cloned) —
        // show the merged PR's pushed content when a snapshot exists.
        if (await _wsfOpenMergedView(f, i)) return true;
        _wsfNotFoundMsg(f); return false;
    }
    var rec = res.rec;
    var status = rec.deleted ? t('Deleted') : (rec.dirty ? t('Modified (uncommitted)') : t('Clean (matches base)'));
    var body = '<div class="wsf-file-meta">' + escapeHtml(res.wsKey) + ' \u00b7 ' + status + ' \u00b7 ' + _wsfFmtSize(rec.content) + '</div>';
    if (rec.stub && rec.content == null) {
        body += '<div class="wsf-empty">' + t('Content not loaded locally (lazy clone stub).') + '</div>';
    } else {
        body += '<pre class="wsf-code">' + escapeHtml(rec.content || '') + '</pre>';
    }
    _wsfOverlay(escapeHtml(f.path), body, { fileIndex: i, active: 'view' });
    return true;
}

// --- Diff --------------------------------------------------------------------

// Compact generic line-diff renderer reusing 16-diff.css classes.
// computeDiff() (090-version-history.js) is a generic line LCS;
// computeWordDiffsForLines() (same file) adds word-level (intra-line)
// highlights on paired remove/add lines, like the record diff viewer.
function _wsfRenderDiffHtml(oldText, newText) {
    var diff = computeDiff(oldText || '', newText || '');
    var wordDiffs = computeWordDiffsForLines(diff);
    var adds = 0, dels = 0;
    diff.forEach(function(d) {
        if (d.type === 'add') adds++;
        else if (d.type === 'remove') dels++;
    });
    if (adds === 0 && dels === 0) {
        return '<div class="wsf-empty">' + t('No differences') + '</div>';
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
            html += '<div class="diff-separator"><span class="diff-separator-text">\u22ef ' + tn(hiddenRun, '{count} unchanged line', '{count} unchanged lines') + '</span></div>';
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
            + '<span class="diff-text">' + (wordDiffs[idx] || escapeHtml(d.text)) + '</span>'
            + '</div>';
    });
    flushHidden();
    html += '</div></div>';
    return html;
}

async function wsfOpenDiff(i) {
    var f = _wsfSectionFiles[i];
    if (!f) return false;
    var res = await _wsfResolve(f);
    // Fall back to the durable merged-PR snapshot (pre-merge base → pushed
    // content) when the live record is GONE (fork auto-deleted on merge) or
    // resolves CLEAN (workspace synced past the merge — the live diff would
    // show "No differences"). A genuinely dirty live record still wins: those
    // are newer, uncommitted edits.
    if (!res || !(res.rec && res.rec.dirty)) {
        if (await _wsfOpenMergedDiff(f, i)) return true;
    }
    if (!res) { _wsfNotFoundMsg(f); return false; }
    var rec = res.rec;
    var oldText = rec.original_content != null ? rec.original_content : '';
    var newText = rec.deleted ? '' : (rec.content || '');
    var note = rec.dirty ? '' : '<div class="wsf-file-meta">' + t('File has no uncommitted changes \u2014 it matches its base.') + '</div>';
    _wsfOverlay(escapeHtml(f.path) + ' <span class="wsf-title-sub">' + t('base \u2192 current') + '</span>', note + _wsfRenderDiffHtml(oldText, newText), { fileIndex: i, active: 'diff' });
    return true;
}

// Render the merged-PR snapshot diff for a section entry. Returns true when a
// snapshot existed (with durable blobs) and the modal was shown; false falls
// through to the caller's default behavior (old chats / PRs pushed before
// snapshots existed, or snapshot blobs lost).
async function _wsfOpenMergedDiff(f, i) {
    try {
        if (typeof getAllWorkspaceMetas !== 'function' || typeof getWorkspaceBlobsBySha !== 'function') return false;
        var snap = _wsfPickSnap(_wsfCollectMergedSnaps(await getAllWorkspaceMetas())[f.path], f.wsKey);
        if (!snap) return false;
        var shas = [];
        if (snap.file.old_sha) shas.push(snap.file.old_sha);
        if (snap.file.new_sha) shas.push(snap.file.new_sha);
        var blobs = await getWorkspaceBlobsBySha(shas);
        // A referenced blob may be gone (pre-fix GC, quota failure at push
        // time) — fall through rather than render a half-empty diff that
        // pretends the file was created or deleted.
        if (snap.file.old_sha && blobs[snap.file.old_sha] == null) return false;
        if (snap.file.new_sha && blobs[snap.file.new_sha] == null) return false;
        var oldText = snap.file.old_sha ? blobs[snap.file.old_sha] : '';
        var newText = snap.file.new_sha ? blobs[snap.file.new_sha] : '';
        var prLink = '<a href="' + escapeHtml(snap.pr.url || '#') + '" target="_blank" rel="noopener">' + t('PR #{number}', { number: snap.pr.number }) + '</a>';
        var note = '<div class="wsf-file-meta"><span class="sn-status-badge sn-status-merged">' + t('MERGED') + '</span> '
            + (snap.pr.merged_at
                ? t('Merged in {pr} \u00b7 {date} \u2014 original edited diff (pre-merge base \u2192 pushed content).', { pr: prLink, date: escapeHtml(String(snap.pr.merged_at).slice(0, 10)) })
                : t('Merged in {pr} \u2014 original edited diff (pre-merge base \u2192 pushed content).', { pr: prLink }))
            + '</div>';
        _wsfOverlay(escapeHtml(f.path) + ' <span class="wsf-title-sub">' + t('merged \u00b7 PR #{number}', { number: snap.pr.number }) + '</span>', note + _wsfRenderDiffHtml(oldText, newText), { fileIndex: i, active: 'diff' });
        return true;
    } catch (e) {
        console.error('wsf merged snapshot diff failed', e);
        return false;
    }
}

// Viewer counterpart: show the merged PR's PUSHED content when the live
// record is unresolvable. Deletions have no pushed content — return false
// (the diff view covers them).
async function _wsfOpenMergedView(f, i) {
    try {
        if (typeof getAllWorkspaceMetas !== 'function' || typeof getWorkspaceBlobsBySha !== 'function') return false;
        var snap = _wsfPickSnap(_wsfCollectMergedSnaps(await getAllWorkspaceMetas())[f.path], f.wsKey);
        if (!snap || !snap.file.new_sha) return false;
        var blobs = await getWorkspaceBlobsBySha([snap.file.new_sha]);
        var content = blobs[snap.file.new_sha];
        if (content == null) return false;
        var body = '<div class="wsf-file-meta"><span class="sn-status-badge sn-status-merged">' + t('MERGED') + '</span> ' + t('PR #{number} \u00b7 pushed content \u00b7 {size}', { number: snap.pr.number, size: _wsfFmtSize(content) }) + '</div>'
            + '<pre class="wsf-code">' + escapeHtml(content) + '</pre>';
        _wsfOverlay(escapeHtml(f.path) + ' <span class="wsf-title-sub">' + t('merged \u00b7 PR #{number}', { number: snap.pr.number }) + '</span>', body, { fileIndex: i, active: 'view' });
        return true;
    } catch (e) { return false; }
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
    if (!f) return false;
    var res = await _wsfResolve(f);

    // Gather changes for this path across all chats.
    // C2-ui SKEL-SCAN: replay needs the FULL recorded args, which a skeleton's
    // slim memo does not keep — scan the stored row of each skeleton that may
    // touch this path, one transient read at a time (never attached to chats).
    var _skelFull = {};
    var _cids = Object.keys(chats);
    for (var _ci = 0; _ci < _cids.length; _ci++) {
        var _sc = chats[_cids[_ci]];
        if (!_sc || Array.isArray(_sc.messages) || !_sc._messagesEvicted || typeof loadChatRowFromDB !== 'function') continue;
        // A known memo without this path skips the read; unknown (null) reads.
        var _pk = (typeof skeletonScanValue === 'function') ? skeletonScanValue('wsf', _cids[_ci], _sc, _wsfScanPacked, null, _wsfSkelRerender) : null;
        if (_pk && Array.isArray(_pk.list) && !_pk.list.some(function(ch) { return ch.path === f.path; })) continue;
        var _row = null;
        try { _row = await loadChatRowFromDB(_cids[_ci]); } catch (e) { _row = null; }
        if (_row && Array.isArray(_row.messages)) _skelFull[_cids[_ci]] = _wsfScanChatLive(_row);
        _row = null;
    }
    var entries = [];
    Object.keys(chats).forEach(function(cid) {
        if (!chats[cid]) return;
        (_skelFull[cid] || _wsfScanChat(chats[cid])).forEach(function(ch) {
            if (ch.path !== f.path) return;
            if (ch.wsKey && f.wsKey && ch.wsKey !== f.wsKey) return;
            ch.chatId = cid;
            var ttl = chats[cid].title;
            ch.chatTitle = ttl ? (ttl === 'New Chat' ? t('New Chat') : ttl) : t('Untitled chat');
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
    versions.push({ action: 'base', label: t('Base (clone)'), content: base, ok: base != null });
    var cur = base;
    var reliable = base != null;
    entries.forEach(function(ch) {
        var v = { action: ch.action, chatId: ch.chatId, chatTitle: ch.chatTitle, msgIdx: ch.msgIdx, tcIdx: ch.tcIdx, args: ch.args };
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
        versions.push({ action: 'current', label: t('Current'), content: res.rec.deleted ? '' : res.rec.content, ok: res.rec.content != null });
    }

    _wsfVersionState = { file: f, fileIndex: i, wsKey: res ? res.wsKey : f.wsKey, versions: versions };

    var icons = { base: UI_ICONS.gitBranch, write: UI_ICONS.edit, edit: UI_ICONS.edit, 'delete': UI_ICONS.trash, discard: UI_ICONS.undo, copy: UI_ICONS.copy, current: UI_ICONS.check };
    var actionLabels = { write: t('Write'), edit: t('Edit'), 'delete': t('Delete'), copy: t('Copy'), discard: t('Discard') };
    var body = '<div class="wsf-versions-list">';
    versions.forEach(function(v, vi) {
        var label = v.label || actionLabels[v.action] || (v.action.charAt(0).toUpperCase() + v.action.slice(1));
        var isThisChat = v.chatId && v.chatId === currentChatId;
        var chatChip = v.chatId
            ? '<span class="wsf-ver-chat' + (isThisChat ? ' this-chat' : '') + '"' + (isThisChat ? ' role="button" tabindex="0" data-kbd-click onclick="wsfGoToVersionMsg(' + vi + ')" title="' + escapeHtml(t('Show in chat')) + '"' : ' title="' + escapeHtml(v.chatTitle) + '"') + '>' + UI_ICONS.chat + ' ' + escapeHtml(isThisChat ? t('this chat') : (v.chatTitle.length > 28 ? v.chatTitle.slice(0, 28) + '\u2026' : v.chatTitle)) + '</span>'
            : '';
        body += '<div class="wsf-ver-row' + (v.ok ? '' : ' unreliable') + '">';
        body += '<span class="wsf-ver-num">v' + vi + '</span>';
        body += '<span class="wsf-ver-icon">' + (icons[v.action] || UI_ICONS.file) + '</span>';
        body += '<span class="wsf-ver-label">' + escapeHtml(label) + '</span>';
        body += chatChip;
        if (!v.ok && v.action !== 'base') body += '<span class="wsf-ver-note" title="' + escapeHtml(t('Content could not be rebuilt from the recorded tool calls')) + '">' + t('not reconstructable') + '</span>';
        body += '<span class="wsf-ver-actions">';
        if (v.content != null) {
            body += '<button class="sn-artifact-icon-btn" onclick="wsfViewVersion(' + vi + ')" title="' + escapeHtml(t('View this version')) + '">' + UI_ICONS.eye + '</button>';
        }
        if (vi > 0) {
            body += '<button class="sn-artifact-icon-btn" onclick="wsfDiffVersion(' + vi + ')" title="' + escapeHtml(t('Diff vs previous version')) + '">' + UI_ICONS.diff + '</button>';
        }
        // A3C2-03: no Restore without a known target workspace (never fall back to the default one).
        if (v.content != null && v.action !== 'current' && _wsfVersionState.wsKey) {
            body += '<button class="sn-artifact-icon-btn" onclick="wsfRestoreVersion(' + vi + ')" title="' + escapeHtml(t('Restore this version into the workspace')) + '">' + UI_ICONS.undo + '</button>';
        }
        body += '</span>';
        body += '</div>';
    });
    body += '</div>';
    if (!res) body += '<div class="wsf-file-meta">' + t('File no longer exists in a local workspace \u2014 base and current content unavailable.') + (_wsfVersionState.wsKey ? '' : ' ' + t('Restore is unavailable: no local workspace is known for this file.')) + '</div>';
    _wsfOverlay(escapeHtml(f.path) + ' <span class="wsf-title-sub">' + tn(versions.length, '{count} version', '{count} versions') + '</span>', body, { fileIndex: i, active: 'versions' });
    return true;
}

// A3C2-01: "Show in chat" must reveal the exact tool call that produced the
// version. scrollToMessage (110) opens only the FIRST tool call of
// #msg-<idx>, and in compact mode a run of tool-call messages renders into
// #msg-<first> (each call as #tc-<origMsgIdx>-<tcIdx>), leaving #msg-<idx>
// an empty placeholder. Returns false (the caller falls back to
// scrollToMessage) when that tool-call node is not rendered.
function _wsfRevealToolCall(msgIdx, tcIdx) {
    if (tcIdx == null || msgIdx == null || msgIdx < 0) return false;
    if (typeof clearToolHighlights === 'function') clearToolHighlights();
    // MEMWIN: render the window that holds the target first (no-op when in window).
    if (typeof ensureMessageInWindow === 'function') ensureMessageInWindow(msgIdx);
    var tcEl = document.getElementById('tc-' + msgIdx + '-' + tcIdx);
    if (!tcEl) return false;
    for (var d = tcEl.parentElement; d; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true; // compact group
    if (typeof collapseOtherTools === 'function') collapseOtherTools(tcEl);
    tcEl.open = true;
    tcEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    tcEl.classList.add('highlight-flash');
    setTimeout(function() { tcEl.classList.remove('highlight-flash'); }, 2000);
    return true;
}

function wsfGoToVersionMsg(vi) {
    var st = _wsfVersionState;
    if (!st || !st.versions[vi]) return;
    document.querySelectorAll('.wsf-overlay').forEach(function(o) { o._wsfClose ? o._wsfClose() : o.remove(); });
    var v = st.versions[vi];
    if (!_wsfRevealToolCall(v.msgIdx, v.tcIdx)) scrollToMessage(v.msgIdx, v.tcIdx);
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
        body = '<div class="wsf-file-meta">' + escapeHtml(t('Exact version content could not be rebuilt \u2014 showing the recorded search & replace operations of this change.')) + '</div>';
        v.args.edits.forEach(function(e, k) {
            body += '<div class="wsf-edit-hunk-title">' + t('Edit {number}', { number: k + 1 }) + '</div>' + _wsfRenderDiffHtml(e.find, e.replace);
        });
    } else {
        body = '<div class="wsf-empty">' + t('Not enough recorded data to build this diff.') + '</div>';
    }
    _wsfOverlay(escapeHtml(st.file.path) + ' <span class="wsf-title-sub">v' + (vi - 1) + ' \u2192 v' + vi + '</span>', body, { fileIndex: st.fileIndex, active: 'versions' });
}

async function wsfRestoreVersion(vi) {
    var st = _wsfVersionState;
    if (!st || !st.versions[vi] || st.versions[vi].content == null) return;
    var v = st.versions[vi];
    if (!st.wsKey) { showSnackbar(t('Cannot restore "{path}": no local workspace is known for it', { path: st.file.path }), 'warning'); return; }
    if (!await showConfirmModal(t('Restore Version'), t('Restore "{path}" to v{version} in {workspace}? This overwrites the current workspace content as a new uncommitted change.', { path: escapeHtml(st.file.path), version: vi, workspace: escapeHtml(st.wsKey) }))) return;
    try {
        showSpinner(t('Restoring v{version}...', { version: vi }));
        var args;
        if (v.action === 'base') {
            args = { action: 'discard', path: st.file.path };
        } else {
            args = { action: 'write', path: st.file.path, content: v.content };
        }
        args.workspace = st.wsKey;
        var r = await executeWorkspaceTool(args, { chatId: currentChatId });
        hideSpinner();
        if (r && r.success) {
            showSnackbar(t('Restored "{path}" to v{version}', { path: st.file.path, version: vi }), 'success');
            document.querySelectorAll('.wsf-overlay').forEach(function(o) { o._wsfClose ? o._wsfClose() : o.remove(); });
            renderVersionSidebar();
        } else {
            showSnackbar(t('Restore failed: {error}', { error: (r && r.error) || t('unknown error') }), 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar(t('Restore failed: {error}', { error: e.message }), 'error');
    }
}

// --- Discard ----------------------------------------------------------------

async function wsfDiscardFile(i) {
    var f = _wsfSectionFiles[i];
    if (!f) return;
    var res = await _wsfResolve(f);
    if (!res) { _wsfNotFoundMsg(f); return; }
    if (!res.rec.dirty) {
        showSnackbar(t('"{path}" has no uncommitted changes', { path: f.path }), 'warning');
        return;
    }
    if (!await showConfirmModal(t('Discard Changes'), t('Discard uncommitted changes to "{path}"? The file is reset to its cloned base content. This cannot be undone.', { path: escapeHtml(f.path) }), 'danger')) return;
    try {
        showSpinner(t('Discarding...'));
        var args = { action: 'discard', path: f.path, workspace: res.wsKey };
        var r = await executeWorkspaceTool(args, { chatId: currentChatId });
        hideSpinner();
        if (r && r.success) {
            showSnackbar(t('Discarded changes to "{path}"', { path: f.path }), 'success');
            renderVersionSidebar();
        } else {
            showSnackbar(t('Discard failed: {error}', { error: (r && r.error) || t('unknown error') }), 'error');
        }
    } catch (e) {
        hideSpinner();
        showSnackbar(t('Discard failed: {error}', { error: e.message }), 'error');
    }
}

// --- Live refresh -----------------------------------------------------------

// Re-render the sidebar when the agent mutates the workspace mid-run so the
// section stays live. AgentEvents may load after this file — retry briefly.
var _wsfSubRenderTimer = null;
function _wsfOnSubMessages(ev) {
    if (!ev || !ev.chatId || typeof currentChatId === 'undefined' || ev.chatId === currentChatId) return false;
    if (typeof getSubAgentChatsForChat !== 'function') return false;
    var isSub = getSubAgentChatsForChat(currentChatId).some(function(sc) { return sc.chatId === ev.chatId; });
    if (!isSub) return false;
    if (_wsfSubRenderTimer) clearTimeout(_wsfSubRenderTimer);
    _wsfSubRenderTimer = setTimeout(function() {
        _wsfSubRenderTimer = null;
        if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
    }, 400);
    return true;
}

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
                // Keep the merged-PR snapshot cache fresh (push adds snapshots,
                // sync/merge stamps state:'merged'). Async — the render below
                // uses the current cache; a refresh that changes the map
                // re-renders once more by itself.
                try { _wsfRefreshOwnedRows(); _wsfRefreshMergedSnaps(); } catch (e2) { /* not fatal */ }
                if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
            } catch (e) { /* sidebar not ready */ }
        });
        // WSF-SUBREFRESH: workspaceMutated fires when the tool finishes —
        // BEFORE the sub-agent's tool-result row lands in its chat replica,
        // and messagesAppended only repaints the CURRENT chat. A worker's
        // edit therefore stayed hidden in the parent's sidebar until some
        // unrelated parent render. Re-render (debounced) when a descendant
        // sub-agent chat of the current chat grows.
        AgentEvents.on('messagesAppended', function(ev) {
            try { _wsfOnSubMessages(ev); } catch (e) { /* sidebar not ready */ }
        });
    }
    setTimeout(hook, 0);
})();
