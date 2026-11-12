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
// WSF-SCOPE: the Workspace Files section lists ONLY files that belong to no
// PR (uncommitted modified / new / deleted, incl. edits made after a push).
// Pushed files are listed under their PR in the Pull Requests section
// (PR modal Files tab, see _wsfPrFilesTabHtml). _wsfWsFiles is the section's
// own display list; _wsfSectionFiles is the list the open modal navigates
// (the WS list, or one PR's file list — _wsfNavSource says which).
var _wsfWsFiles = [];
var _wsfNavSource = 'ws';
// One change-kind glyph per row (VS Code SCM style); colors in 25-ws-files.css.
var _wsfLetters = { modified: 'M', 'new': 'A', deleted: 'D' };

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
                rows = await _wsfDropIgnoredRows(rows);
                var changed = JSON.stringify(rows) !== JSON.stringify(_wsfOwnedRows);
                _wsfOwnedRows = rows;
                if (changed && typeof renderVersionSidebar === 'function') renderVersionSidebar();
            } catch (e) { /* Retain the last good cache on a failed or partial read. */ }
        } while (_wsfOwnedRerun);
    }).finally(function() { _wsfOwnedLoading = null; });
    return _wsfOwnedLoading;
}
// Gitignored paths (e.g. dist/ build output written by Reload/extension_build)
// are not chat work: `workspace status` hides them by default and the cross-
// chat lock exempts them. Apply the same local .gitignore filter
// (wsGetIgnoreFilterLocal — never hydrates, no network) per workspace.
async function _wsfDropIgnoredRows(rows) {
    if (!Array.isArray(rows) || !rows.length || typeof wsGetIgnoreFilterLocal !== 'function') return rows;
    var filters = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
        var wk = rows[i].wsKey;
        if (wk && !filters[wk]) {
            try { filters[wk] = await wsGetIgnoreFilterLocal(wk); } catch (e) { filters[wk] = null; }
        }
    }
    return rows.filter(function(r) {
        var isIgnored = r.wsKey && filters[r.wsKey];
        return !(typeof isIgnored === 'function' && isIgnored(r.path));
    });
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
        // WSF-STATUS: live row state (the workspace store is the source of
        // truth for dirty vs pushed vs merged; chat history is not).
        f.live = { dirty: row.dirty !== false, prMerged: !!row.prMerged, changedSincePush: !!row.changedSincePush };
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
var _wsfMergedSnapsRerun = false;
// WSF-STATUS: repo + '#' + PR number -> 'open' | 'merged' | 'closed', from
// every workspace meta.prs entry (the same durable record the Pull Requests
// section reads). One PR state for every file pushed to it, so files of the
// same PR can no longer disagree (MERGED vs MODIFIED).
var _wsfPrStates = {};
// WSF-KIND: repo + '#' + PR number -> { path -> pushed file entry } for EVERY
// tracked PR (open / merged / closed). Gives pushed rows their change kind
// (A/D/M) and a diff source when the live record is clean after the push.
var _wsfPrFiles = {};
// WSF-PRMODAL: repo + '#' + PR number -> { url, number, title, body, branch,
// base, state } from the durable meta.prs records (title/body stored by
// wsPush). Feeds the PR modal header / description and the diff-modal chip.
var _wsfPrInfos = {};

function _wsfCollectPrInfos(metas) {
    var out = {};
    (metas || []).forEach(function(m) {
        var wk = (m && m.repo && typeof parseWsKey === 'function') ? parseWsKey(m.repo) : null;
        var repo = m ? (m.github_repo || (wk ? wk.repo : null)) : null;
        ((m && Array.isArray(m.prs)) ? m.prs : []).forEach(function(pr) {
            if (!pr || !pr.number) return;
            var k = (repo || '') + '#' + pr.number;
            var cur = out[k] || (out[k] = { url: pr.url || null, number: pr.number });
            if (pr.title && !cur.title) cur.title = pr.title;
            if (typeof pr.body === 'string' && pr.body && !cur.body) cur.body = pr.body;
            if (pr.branch && !cur.branch) cur.branch = pr.branch;
            // Stored at push time (wsPush prInfo.base); legacy: the ws branch.
            if (pr.base && !cur.base) cur.base = pr.base;
            if (!cur.base && wk && wk.branch && wk.branch !== pr.branch) cur.base = wk.branch;
            if (pr.state && !cur.state) cur.state = pr.state;
            if (pr.url && !cur.url) cur.url = pr.url;
        });
    });
    return out;
}

// Install freshly collected meta.prs infos. Stored data must win over an
// OLDER GitHub fetch: when a PR's stored title/body changed (e.g. a push with
// a new pr_title / pr_body) and differs from the cached live detail, drop
// that cached detail and its live-check TTL entry so the next open shows the
// stored values and re-checks GitHub. A write-back of the live detail itself
// (_wsfPersistPrDetail) stores the cached values, so it keeps the cache.
function _wsfApplyPrInfos(next) {
    var prev = _wsfPrInfos || {};
    Object.keys(next || {}).forEach(function(k) {
        var n = next[k], p = prev[k] || {};
        var url = n && n.url;
        if (!url || (n.title === p.title && n.body === p.body)) return;
        var det = _wsfPrDetailCache[url];
        if (det && (n.title || '') === (det.title || '') && (n.body || '') === (det.body || '')) return;
        delete _wsfPrDetailCache[url];
        delete _wsfPrLive[url];
    });
    _wsfPrInfos = next || {};
}

function _wsfCollectPrFiles(metas) {
    var out = {};
    (metas || []).forEach(function(m) {
        var repo = m ? (m.github_repo || (typeof parseWsKey === 'function' && m.repo ? parseWsKey(m.repo).repo : null)) : null;
        ((m && Array.isArray(m.prs)) ? m.prs : []).forEach(function(pr) {
            if (!pr || !pr.number || !Array.isArray(pr.files)) return;
            var k = (repo || '') + '#' + pr.number;
            if (!out[k]) out[k] = {};
            pr.files.forEach(function(pf) { if (pf && pf.path) out[k][pf.path] = pf; });
        });
    });
    return out;
}

// Pushed file entry of f's PR (or null).
function _wsfPrFileOf(f, prNumber, prUrl) {
    if (!prNumber) return null;
    var repo = null;
    var m = prUrl && /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(prUrl);
    if (m) repo = m[1];
    else if (f.wsKey && typeof parseWsKey === 'function') repo = parseWsKey(f.wsKey).repo;
    var byPath = _wsfPrFiles[(repo || '') + '#' + prNumber];
    return (byPath && byPath[f.path]) || null;
}

function _wsfCollectPrStates(metas) {
    var out = {};
    (metas || []).forEach(function(m) {
        var repo = m ? (m.github_repo || (typeof parseWsKey === 'function' && m.repo ? parseWsKey(m.repo).repo : null)) : null;
        ((m && Array.isArray(m.prs)) ? m.prs : []).forEach(function(pr) {
            if (!pr || !pr.number) return;
            var st = pr.state === 'merged' ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open');
            var k = (repo || '') + '#' + pr.number;
            // merged beats closed beats open when several metas track the PR
            var rank = { open: 0, closed: 1, merged: 2 };
            if (!out[k] || rank[st] > rank[out[k]]) out[k] = st;
        });
    });
    return out;
}

function _wsfRefreshMergedSnaps() {
    // A refresh requested mid-load (e.g. the push / pr_merged event) used to
    // be DROPPED, leaving stale badges until some unrelated mutation.
    if (_wsfMergedSnapsLoading) { _wsfMergedSnapsRerun = true; return; }
    if (typeof getAllWorkspaceMetas !== 'function') return;
    _wsfMergedSnapsLoading = true;
    _wsfMergedSnapsRerun = false;
    getAllWorkspaceMetas().then(function(metas) {
        var byPath = _wsfCollectMergedSnaps(metas);
        var states = _wsfCollectPrStates(metas);
        function sig(map) {
            if (!map) return 'null';
            return JSON.stringify(Object.keys(map).sort().map(function(p) {
                return [p].concat(map[p].map(function(s) { return [s.repo, s.file.old_sha, s.file.new_sha, s.pr.number]; }));
            }));
        }
        var prFiles = _wsfCollectPrFiles(metas);
        var changed = sig(byPath) !== sig(_wsfMergedSnaps) || JSON.stringify(states) !== JSON.stringify(_wsfPrStates) || JSON.stringify(prFiles) !== JSON.stringify(_wsfPrFiles);
        _wsfMergedSnaps = byPath;
        _wsfPrStates = states;
        _wsfPrFiles = prFiles;
        _wsfApplyPrInfos(_wsfCollectPrInfos(metas));
        _wsfMergedSnapsLoading = false;
        if (changed && typeof renderVersionSidebar === 'function') renderVersionSidebar();
        if (_wsfMergedSnapsRerun) _wsfRefreshMergedSnaps();
    }).catch(function() {
        _wsfMergedSnapsLoading = false;
        if (_wsfMergedSnapsRerun) _wsfRefreshMergedSnaps();
    });
}

// Live PR state for a file's PR ref: the Pull Requests section's in-memory
// GitHub state (_sidebarPRState, 120-ui-utils.js) wins, then meta.prs.
// Returns null when the PR states are loaded but no workspace record knows
// this PR (e.g. dropped with a deleted workspace) - the caller decides; while
// the states are still loading it assumes 'open' (no flicker).
function _wsfPrState(pr, wsKey) {
    if (!pr) return null;
    var live = (pr.url && typeof _sidebarPRState !== 'undefined' && _sidebarPRState) ? _sidebarPRState[pr.url] : null;
    if (live === 'merged' || live === 'closed' || live === 'open') return live;
    var repo = null;
    var m = pr.url && /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url);
    if (m) repo = m[1];
    else if (wsKey && typeof parseWsKey === 'function') repo = parseWsKey(wsKey).repo;
    var st = pr.number ? _wsfPrStates[(repo || '') + '#' + pr.number] : null;
    if (st) return st;
    return _wsfMergedSnaps === null ? 'open' : null;
}

// Single source of truth for a row's status. Precedence:
//   1. explicit later local action: DELETED / DISCARDED
//   2. live workspace row is dirty with edits NOT in a PR (or edited since
//      the push - even when that PR has since merged) -> MODIFIED / NEW
//   3. pushed to a PR -> that PR's state: MERGED / CLOSED / IN PR (open)
//      (a dirty row stamped pushed_pr_merged is merged work whose base has
//      not synced yet -> MERGED)
//   4. no PR evidence: a merged-PR snapshot touching the path -> MERGED,
//      but only when the live row is not dirty
//   5. fallback MODIFIED / NEW
// Returns {key, label, title, pr, prNumber, prUrl} (prNumber/prUrl: the PR
// shown as the row's #chip — the pushed PR, or a merged snapshot's PR).
function _wsfStatusOf(f) {
    var s = _wsfStatusOfRaw(f);
    if (s.prNumber === undefined) s.prNumber = (s.pr && s.pr.number) || null;
    if (s.prUrl === undefined) s.prUrl = (s.pr && s.pr.url) || null;
    return s;
}
function _wsfStatusOfRaw(f) {
    var live = f.live || null;
    var pr = f.pushedPr && (f.pushedPr.url || f.pushedPr.number) ? f.pushedPr : null;
    function edited() {
        return f.isNew ? { key: 'new', label: t('NEW'), title: t('Uncommitted changes'), pr: pr }
            : { key: 'modified', label: t('MODIFIED'), title: t('Uncommitted changes'), pr: pr };
    }
    if (f.isDeleted) return { key: 'deleted', label: t('DELETED'), title: '', pr: pr };
    if (f.isDiscarded) return { key: 'discarded', label: t('DISCARDED'), title: '', pr: null };
    // Edits after the push win over the merged marker: reconcile keeps
    // pushed_pr_merged on dirty rows and later write/edit set
    // changed_since_push, so the content is NOT what merged.
    if (live && live.dirty && live.changedSincePush) return edited();
    if (live && live.dirty && live.prMerged) {
        return { key: 'merged', label: t('MERGED'), title: t('Merged in PR #{number}', { number: (pr && pr.number) || '' }), pr: pr };
    }
    if (live && live.dirty && !pr) return edited();
    if (pr) {
        var st = _wsfPrState(pr, f.wsKey);
        // PR unknown to every workspace record: a dirty row is just edited.
        if (!st && live && live.dirty) return edited();
        if (st === 'merged') return { key: 'merged', label: t('MERGED'), title: t('Merged in PR #{number}', { number: pr.number || '' }), pr: pr };
        if (st === 'closed') return { key: 'closed', label: t('CLOSED'), title: t('PR #{number}', { number: pr.number || '' }), pr: pr };
        return { key: 'pr', label: t('IN PR'), title: t('PR #{number}', { number: pr.number || '' }), pr: pr };
    }
    if (!(live && live.dirty)) {
        var snap = _wsfMergedSnapFor(f.path, f.wsKey);
        if (snap) return { key: 'merged', label: t('MERGED'), title: t('Merged in PR #{number}', { number: snap.pr.number }), pr: null, prNumber: snap.pr.number || null, prUrl: snap.pr.url || null, snapFile: snap.file };
    }
    return edited();
}

// Sync lookup for render time; kicks the first load when never loaded.
function _wsfMergedSnapFor(path, wsKey) {
    if (_wsfMergedSnaps === null) { _wsfRefreshMergedSnaps(); return null; }
    return _wsfPickSnap(_wsfMergedSnaps[path], wsKey);
}

// --- Per-row +/- line counts (WSF-COUNTS) -----------------------------------
// renderWorkspaceFilesSection is synchronous; contents live in IndexedDB. So
// counts are computed async and cached per wsKey+path: render reads the cache
// (a stale value stays visible until the refresh lands) and queues a load for
// rows never loaded or invalidated since (workspaceMutated bumps
// _wsfCountsGen). One batched async pass per render; it re-renders ONCE and
// only when a row's visible counts changed, and each entry is stamped with the
// generation it was loaded at so the follow-up render queues nothing (no loop).
// Each entry also keeps a content signature (lengths + cheap hash) so an
// unchanged file skips computeDiff on re-validation.
// Entry: { gen, sig, adds, dels } — adds/dels null = no counts (stub, too big,
// unresolvable, or no diff source).
var _wsfCounts = Object.create(null);
var _wsfCountsGen = 0;
var _wsfCountsQueue = [];
var _wsfCountsRunning = false;
var _WSF_COUNT_MAX = 200 * 1024; // skip counting files larger than this (chars)

// PR-file entries (f.prKey) count the PR's pushed diff, not the live one, so
// they get their own cache slot.
function _wsfCountKey(f) { return (f.prKey ? 'pr:' + f.prKey + '\u0000' : '') + String(f.wsKey || '') + '\u0000' + f.path; }

function _wsfHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ':' + (h >>> 0).toString(36);
}

function _wsfLineCount(s) {
    if (!s) return 0;
    var n = s.split('\n').length;
    return s.charAt(s.length - 1) === '\n' ? n - 1 : n;
}

function _wsfInvalidateCounts() { _wsfCountsGen++; }

// Sync render-time lookup; queues an async load when missing or stale.
function _wsfCountsFor(f) {
    var k = _wsfCountKey(f);
    var e = _wsfCounts[k];
    if ((!e || e.gen !== _wsfCountsGen) && !_wsfCountsQueue.some(function(q) { return q.k === k; })) {
        _wsfCountsQueue.push({ k: k, f: f });
    }
    return e || null;
}

// Diff source for a row, mirroring wsfOpenDiff: a dirty live record wins,
// else the merged-PR snapshot (fork auto-deleted / synced past the merge),
// else the (clean) live record. Returns {oldText, newText} or null.
async function _wsfCountSource(f) {
    // PR-file entry: the PR's pushed snapshot (base → pushed blob) wins.
    if (f.prFile) {
        var ps = await _wsfPrSnapTexts(f.prFile);
        if (ps) return ps;
    }
    if (typeof getWorkspaceFile !== 'function' && typeof getAllWorkspaceMetas !== 'function') return null;
    var res = await _wsfResolve(f);
    var rec = res && res.rec;
    if (rec && rec.dirty) {
        if (rec.stub && rec.content == null) return null;
        return { oldText: rec.original_content != null ? rec.original_content : '', newText: rec.deleted ? '' : (rec.content || '') };
    }
    // Clean live record (pushed then synced, or fork gone): the row's own PR
    // file entry (open / merged / closed), else a merged-PR snapshot.
    if (typeof getWorkspaceBlobsBySha === 'function') {
        var st = f._status || {};
        var pf = _wsfPrFileOf(f, st.prNumber, st.prUrl);
        if (!(pf && (pf.old_sha || pf.new_sha)) && _wsfMergedSnaps) {
            var snap = _wsfPickSnap(_wsfMergedSnaps[f.path], f.wsKey);
            pf = snap ? snap.file : null;
        }
        if (pf && (pf.old_sha || pf.new_sha)) {
            var shas = [];
            if (pf.old_sha) shas.push(pf.old_sha);
            if (pf.new_sha) shas.push(pf.new_sha);
            var blobs = await getWorkspaceBlobsBySha(shas);
            if (!(pf.old_sha && blobs[pf.old_sha] == null) && !(pf.new_sha && blobs[pf.new_sha] == null)) {
                return { oldText: pf.old_sha ? blobs[pf.old_sha] : '', newText: pf.new_sha ? blobs[pf.new_sha] : '' };
            }
        }
    }
    if (rec && !(rec.stub && rec.content == null)) {
        return { oldText: rec.original_content != null ? rec.original_content : (rec.content || ''), newText: rec.deleted ? '' : (rec.content || '') };
    }
    return null;
}

async function _wsfRunCountQueue() {
    if (_wsfCountsRunning || !_wsfCountsQueue.length) return;
    _wsfCountsRunning = true;
    var changed = false;
    try {
        while (_wsfCountsQueue.length) {
            var job = _wsfCountsQueue.shift();
            var gen = _wsfCountsGen;
            var prev = _wsfCounts[job.k] || null;
            var next = { gen: gen, sig: null, adds: null, dels: null };
            try {
                var src = await _wsfCountSource(job.f);
                var o = src ? String(src.oldText == null ? '' : src.oldText) : '';
                var n = src ? String(src.newText == null ? '' : src.newText) : '';
                if (src && o.length <= _WSF_COUNT_MAX && n.length <= _WSF_COUNT_MAX && typeof computeDiff === 'function') {
                    next.sig = _wsfHash(o) + '|' + _wsfHash(n);
                    if (prev && prev.sig === next.sig && prev.adds != null) {
                        next.adds = prev.adds; next.dels = prev.dels;
                    } else if (o === '' || n === '') {
                        // New / deleted file: computeDiff('' , x) also reports
                        // the empty side's lone '' line as a change — count lines.
                        next.adds = _wsfLineCount(n); next.dels = _wsfLineCount(o);
                    } else {
                        var adds = 0, dels = 0;
                        computeDiff(o, n).forEach(function(d) {
                            if (d.type === 'add') adds++;
                            else if (d.type === 'remove') dels++;
                        });
                        next.adds = adds; next.dels = dels;
                    }
                }
            } catch (e) { /* no counts for this row */ }
            _wsfCounts[job.k] = next;
            if (!prev || prev.adds !== next.adds || prev.dels !== next.dels) changed = true;
        }
    } finally {
        _wsfCountsRunning = false;
    }
    if (changed && typeof renderVersionSidebar === 'function') renderVersionSidebar();
}

// Snapshot texts for a pushed PR file entry ({old_sha, new_sha}); null when
// the entry has no shas or a referenced blob is gone.
async function _wsfPrSnapTexts(pf) {
    if (!pf || !(pf.old_sha || pf.new_sha) || typeof getWorkspaceBlobsBySha !== 'function') return null;
    var shas = [];
    if (pf.old_sha) shas.push(pf.old_sha);
    if (pf.new_sha) shas.push(pf.new_sha);
    var blobs = await getWorkspaceBlobsBySha(shas);
    if (pf.old_sha && blobs[pf.old_sha] == null) return null;
    if (pf.new_sha && blobs[pf.new_sha] == null) return null;
    return { oldText: pf.old_sha ? blobs[pf.old_sha] : '', newText: pf.new_sha ? blobs[pf.new_sha] : '' };
}

// Kick the batched async count pass for entries queued by _wsfCountsFor.
function _wsfKickCounts() {
    if (_wsfCountsQueue.length && !_wsfCountsRunning) {
        try { setTimeout(function() { _wsfRunCountQueue(); }, 0); } catch (e) { /* not fatal */ }
    }
}

// Shared file-line markup (Workspace Files rows + PR file lists): name, dim
// dir, right-aligned GitHub-style diffstat (+N / \u2212M, a zero side is
// omitted) and the M / A / D change letter.
function _wsfFileLineHtml(f, kind, onclick, tipExtra) {
    var name = f.path.split('/').pop();
    var dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
    var kindLabel = kind === 'new' ? t('NEW') : (kind === 'deleted' ? t('DELETED') : t('MODIFIED'));
    var tip = [f.path, kindLabel].concat(tipExtra || []);
    var c = _wsfCountsFor(f);
    var hasCounts = !!(c && c.adds != null && (c.adds || c.dels));
    if (hasCounts) tip.push(t('Lines added: {added}, removed: {removed}', { added: c.adds, removed: c.dels }));
    var meta = '';
    if (hasCounts) {
        meta += '<span class="wsf-counts">'
            + (c.adds ? '<span class="wsf-diff-add">+' + c.adds + '</span>' : '')
            + (c.dels ? '<span class="wsf-diff-del">\u2212' + c.dels + '</span>' : '')
            + '</span>';
    }
    return '<div class="wsf-card wsf-st-' + kind + '" data-status="' + kind + '" role="button" tabindex="0" data-kbd-click onclick="' + onclick + '" title="' + escapeHtml(tip.join('\n')) + '">'
        + '<span class="wsf-name">' + escapeHtml(name) + '</span>'
        + (dir ? '<span class="wsf-dir">' + escapeHtml(dir) + '</span>' : '')
        + '<span class="wsf-meta">' + meta
        + '<span class="wsf-letter wsf-k-' + kind + '" aria-label="' + escapeHtml(kindLabel) + '">' + _wsfLetters[kind] + '</span></span>'
        + '</div>';
}

// True when a row belongs to no PR: uncommitted edits (incl. edits made
// after a push - changedSincePush resolves to MODIFIED / NEW), or a deletion
// that was not pushed. Pushed / merged / closed / discarded rows are out.
function _wsfIsUncommitted(f, st) {
    if (st.key === 'modified' || st.key === 'new') return true;
    if (st.key === 'deleted') return !(f.pushedPr && !(f.live && f.live.changedSincePush));
    return false;
}

// WS row click: the modal navigates the Workspace Files list.
function wsfOpenWsFile(i) {
    _wsfNavSource = 'ws';
    _wsfSectionFiles = _wsfWsFiles;
    return wsfOpenDiff(i);
}

// --- Pull Requests: per-PR file lists (WSF-PRFILES) --------------------------
// pr url -> file entries rendered in the PR modal's "Files changed" tab
// (onclick handlers use indexes).
var _wsfPrLists = Object.create(null);

function _wsfPrRepoKey(pr) {
    var m = pr && pr.url && /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr.url);
    if (m) return m[1] + '#' + m[2];
    return pr && pr.number ? '#' + pr.number : null;
}

// Files a PR contains. Sources, merged by path: (1) the durable
// meta.prs[].files snapshot written by wsPush (open, merged and closed PRs),
// (2) this chat's (and its workers') push results / ownership rows whose
// pushedPr matches. Returns null when neither knows the PR's files.
function _wsfFilesForPr(pr, chat) {
    if (_wsfMergedSnaps === null) _wsfRefreshMergedSnaps();
    var key = _wsfPrRepoKey(pr);
    var byPath = Object.create(null), order = [];
    function add(path, wsKey, pf, isNew, isDeleted) {
        if (!path) return;
        var e = byPath[path];
        if (!e) { e = byPath[path] = { path: path, wsKey: wsKey || null, prKey: key, prUrl: pr.url, prNumber: pr.number, prFile: null, isNew: false, isDeleted: false, changes: [] }; order.push(path); }
        if (pf && !e.prFile) e.prFile = pf;
        if (wsKey && !e.wsKey) e.wsKey = wsKey;
        if (isNew) e.isNew = true;
        if (isDeleted) e.isDeleted = true;
    }
    var snap = key ? _wsfPrFiles[key] : null;
    if (!snap && key && key.charAt(0) !== '#') {
        // URL-less legacy lookups keyed '#N' only.
        snap = _wsfPrFiles['#' + pr.number] || null;
    }
    if (snap) Object.keys(snap).forEach(function(p) { add(p, null, snap[p], false, false); });
    var chatsToScan = [];
    if (chat) chatsToScan.push(chat);
    if (chat && chat.id && typeof getSubAgentChatsForChat === 'function') {
        (getSubAgentChatsForChat(chat.id) || []).forEach(function(sc) { if (sc && sc.chat) chatsToScan.push(sc.chat); });
    }
    chatsToScan.forEach(function(c) {
        var list = [];
        try { list = getWsEditedFilesForChat(c) || []; } catch (e) { list = []; }
        list.forEach(function(f) {
            var p = f.pushedPr;
            if (!p) return;
            var same = (p.url && pr.url && p.url === pr.url) || (!p.url && p.number && p.number === pr.number);
            if (same) add(f.path, f.wsKey, null, !!f.isNew, !!f.isDeleted);
        });
    });
    if (!order.length) return null;
    return order.map(function(p) { return byPath[p]; });
}

function _wsfPrKindOf(f) {
    var pf = f.prFile;
    if (pf) {
        if (pf.deleted === true || pf.status === 'removed' || (pf.old_sha && !pf.new_sha)) return 'deleted';
        if (pf.is_new === true || pf.isNew === true || pf.status === 'added' || (pf.new_sha && !pf.old_sha)) return 'new';
        return 'modified';
    }
    if (f.isDeleted) return 'deleted';
    if (f.isNew) return 'new';
    return 'modified';
}

// "Files changed" tab of the PR modal: GitHub-style file headers (chevron,
// path, +N / -M diffstat, M / A / D letter). Clicking a header expands its
// diff INLINE below it (accordion) — no stacked overlay. Diffs load lazily on
// first expand (_wsfPrFileDiff) and stay loaded while the modal is open.
// CSP-polyfill-safe handlers only: fn(this, N).
function _wsfPrFilesTabHtml(pr, files) {
    _wsfPrLists[pr.url] = files || [];
    if (!files || !files.length) return '<div class="wsf-empty">' + escapeHtml(t('Files not recorded')) + '</div>';
    var html = '<div class="wsf-pr-files-bar"><button type="button" class="wsf-pr-toggle-all" aria-expanded="false" onclick="wsfPrToggleAll(this)">' + escapeHtml(t('Expand all')) + '</button></div>';
    html += '<div class="wsf-pr-file-list">';
    files.forEach(function(f, idx) {
        var kind = _wsfPrKindOf(f);
        var kindLabel = kind === 'new' ? t('NEW') : (kind === 'deleted' ? t('DELETED') : t('MODIFIED'));
        var c = _wsfStoredCounts(f) || _wsfCountsFor(f);
        html += '<div class="wsf-pr-file wsf-st-' + kind + '">'
            + '<div class="wsf-pr-file-head" role="button" tabindex="0" data-kbd-click aria-expanded="false" data-idx="' + idx + '" onclick="wsfTogglePrFileDiff(this, ' + idx + ')" title="' + escapeHtml(f.path) + '">'
            + '<span class="wsf-pr-file-chev" aria-hidden="true">' + ((typeof UI_ICONS !== 'undefined' && UI_ICONS.chevronRight) || '\u203a') + '</span>'
            + '<span class="wsf-pr-file-path">' + escapeHtml(f.path) + '</span>'
            + '<span class="wsf-meta">' + _wsfCountsHtml(c && c.adds != null ? c : null)
            + '<span class="wsf-letter wsf-k-' + kind + '" aria-label="' + escapeHtml(kindLabel) + '">' + _wsfLetters[kind] + '</span></span>'
            + '</div>'
            + '<div class="wsf-pr-file-body" hidden></div>'
            + '</div>';
    });
    html += '</div>';
    _wsfKickCounts();
    return html;
}

// +/- counts stored by wsPush on the PR file entry (meta.prs[].files[].adds /
// .dels) so the PR view renders them immediately; null for legacy entries or
// files too large to count at push time.
function _wsfStoredCounts(f) {
    var pf = f && f.prFile;
    if (!pf || typeof pf.adds !== 'number' || typeof pf.dels !== 'number') return null;
    return { adds: pf.adds, dels: pf.dels };
}

// Compact GitHub-style diffstat (+N \u2212M, a zero side omitted); an empty
// .wsf-counts placeholder when unknown (filled once the diff loads).
function _wsfCountsHtml(c) {
    if (!c || !(c.adds || c.dels)) return '<span class="wsf-counts"></span>';
    return '<span class="wsf-counts">'
        + (c.adds ? '<span class="wsf-diff-add">+' + c.adds + '</span>' : '')
        + (c.dels ? '<span class="wsf-diff-del">\u2212' + c.dels + '</span>' : '')
        + '</span>';
}

// Diff for a PR file entry. Sources, in order: the PR's pushed snapshot
// (base -> pushed blobs), the merged-PR snapshot when the live record is gone
// or clean, then the live workspace record. Resolves { html, adds, dels } or
// null when nothing resolves.
async function _wsfPrFileDiff(f) {
    var tx = null, note = '';
    try { if (f.prFile) tx = await _wsfPrSnapTexts(f.prFile); } catch (e) { tx = null; }
    if (!tx) {
        var res = await _wsfResolve(f);
        if (!res || !(res.rec && res.rec.dirty)) {
            try { tx = await _wsfMergedSnapTexts(f); } catch (e) { tx = null; }
        }
        if (!tx && res && res.rec) {
            tx = { oldText: res.rec.original_content != null ? res.rec.original_content : '', newText: res.rec.deleted ? '' : (res.rec.content || '') };
            if (!res.rec.dirty) note = '<div class="wsf-file-meta">' + t('File has no uncommitted changes \u2014 it matches its base.') + '</div>';
        }
    }
    if (!tx) return null;
    var out = {};
    var html = note + _wsfRenderDiffHtml(tx.oldText, tx.newText, out);
    return { html: html, adds: out.adds || 0, dels: out.dels || 0 };
}

var _WSF_SPINNER_DELAY_MS = 300;

// Lazy-load one file's inline diff (once per modal; the promise is cached on
// the .wsf-pr-file element). Resolves true when a diff rendered.
function _wsfLoadPrFileDiff(item, f) {
    if (item._wsfLoad) return item._wsfLoad;
    var body = item.querySelector('.wsf-pr-file-body');
    // Local blobs resolve in a few ms: show "Loading..." only if the diff is
    // still pending after a short delay (no spinner flash on open).
    var settled = false, spin = null;
    try {
        spin = setTimeout(function() { if (!settled) body.innerHTML = '<div class="wsf-empty">' + escapeHtml(t('Loading...')) + '</div>'; }, _WSF_SPINNER_DELAY_MS);
    } catch (e) { spin = null; }
    function done() { settled = true; if (spin) { try { clearTimeout(spin); } catch (e) {} } }
    item._wsfLoad = Promise.resolve().then(function() { return _wsfPrFileDiff(f); }).then(function(d) {
        done();
        if (!d) {
            body.innerHTML = '<div class="wsf-empty">' + escapeHtml(_wsfNotFoundText(f)) + '</div>';
            return false;
        }
        body.innerHTML = d.html;
        var counts = item.querySelector('.wsf-pr-file-head .wsf-counts');
        if (counts && counts.parentNode) counts.outerHTML = _wsfCountsHtml(d);
        return true;
    }).catch(function(e) {
        done();
        item._wsfLoad = null; // allow a retry on the next expand
        body.innerHTML = '<div class="wsf-empty">' + escapeHtml((e && e.message) || String(e)) + '</div>';
        return false;
    });
    return item._wsfLoad;
}

// Header click: expand/collapse the file's diff in place. el = the
// .wsf-pr-file-head. Resolves the new expanded state.
function wsfTogglePrFileDiff(el, idx) {
    el = el && el.closest ? el.closest('.wsf-pr-file-head') : null;
    var item = el ? el.parentNode : null;
    var host = el ? el.closest('.wsf-pr-modal-files') : null;
    var url = host ? host.getAttribute('data-pr-url') : null;
    var f = url && _wsfPrLists[url] ? _wsfPrLists[url][idx] : null;
    var body = item && item.querySelector ? item.querySelector('.wsf-pr-file-body') : null;
    if (!f || !body) return Promise.resolve(false);
    var open = el.getAttribute('aria-expanded') !== 'true';
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
    item.classList.toggle('open', open);
    body.hidden = !open;
    if (!open) return Promise.resolve(false);
    return _wsfLoadPrFileDiff(item, f).then(function() { return true; });
}

// "Expand all" / "Collapse all": expands every file when any is collapsed,
// else collapses all. btn = the .wsf-pr-toggle-all button.
function wsfPrToggleAll(btn) {
    btn = btn && btn.closest ? btn.closest('.wsf-pr-toggle-all') : null;
    var host = btn ? btn.closest('.wsf-pr-modal-files') : null;
    if (!host) return false;
    var heads = Array.prototype.slice.call(host.querySelectorAll('.wsf-pr-file-head'));
    var expand = heads.some(function(h) { return h.getAttribute('aria-expanded') !== 'true'; });
    heads.forEach(function(h) {
        if ((h.getAttribute('aria-expanded') === 'true') !== expand) wsfTogglePrFileDiff(h, parseInt(h.getAttribute('data-idx'), 10));
    });
    btn.textContent = expand ? t('Collapse all') : t('Expand all');
    btn.setAttribute('aria-expanded', expand ? 'true' : 'false');
    return expand;
}

// --- PR modal (WSF-PRMODAL): GitHub-style title / state / branches header,
// Conversation (markdown description) + Files changed tabs. Reuses the
// standard _wsfOverlay modal; file diffs expand inline (_wsfPrFilesTabHtml).
var _wsfPrDetailCache = Object.create(null); // pr url -> fetched detail

function _wsfIcon(name) { return (typeof UI_ICONS !== 'undefined' && UI_ICONS && UI_ICONS[name]) || ''; }

function _wsfPrInfoOf(pr) {
    var key = _wsfPrRepoKey(pr);
    var info = (key && _wsfPrInfos[key]) || {};
    var det = (pr && pr.url && _wsfPrDetailCache[pr.url]) || {};
    var live = (typeof _sidebarPRState !== 'undefined' && pr && pr.url) ? _sidebarPRState[pr.url] : null;
    var st = (live === 'merged' || live === 'closed' || live === 'open') ? live : (det.state || info.state || (key && _wsfPrStates[key]) || (pr && pr.state) || 'open');
    return { url: pr.url || info.url || null, number: pr.number || info.number || null, title: det.title || info.title || pr.title || '', body: typeof det.body === 'string' ? det.body : (info.body || null), head: det.head || info.branch || null, base: det.base || info.base || null, state: st };
}

function _wsfPrStateBadgeHtml(state) {
    var st = state === 'merged' ? 'merged' : (state === 'closed' ? 'closed' : 'open');
    var icon = st === 'merged' ? _wsfIcon('gitMerge') : (st === 'closed' ? _wsfIcon('close') : _wsfIcon('gitBranch'));
    var label = st === 'merged' ? t('MERGED') : (st === 'closed' ? t('CLOSED') : t('OPEN'));
    return '<span class="wsf-pr-state wsf-pr-state-' + st + '">' + icon + '<span>' + escapeHtml(label) + '</span></span>';
}

// Diff/view modal PR reference: a button-styled chip (icon + title + muted
// #N + state badge) that opens the PR modal. extra: optional muted suffix.
function _wsfPrChipLineHtml(pr, extra) {
    var info = _wsfPrInfoOf(pr || {});
    var title = info.title || t('Pull request');
    return '<div class="wsf-file-meta wsf-pr-chip-line"><button type="button" class="wsf-pr-chip" data-pr-url="' + escapeHtml(info.url || '') + '" data-pr-number="' + escapeHtml(String(info.number || '')) + '" onclick="wsfOpenPrModal(this, event)" title="' + escapeHtml(t('Open pull request #{number}', { number: info.number || '' })) + '">'
        + '<span class="wsf-pr-chip-icon">' + _wsfIcon('gitBranch') + '</span>'
        + '<span class="wsf-pr-chip-title">' + escapeHtml(title) + '</span>'
        + '<span class="wsf-pr-chip-num">#' + escapeHtml(String(info.number || '')) + '</span>'
        + _wsfPrStateBadgeHtml(info.state) + '</button>'
        + (extra ? '<span class="wsf-pr-chip-extra">' + escapeHtml(extra) + '</span>' : '') + '</div>';
}

function _wsfPrHeadHtml(info) {
    var br = (info.head || info.base) ? '<span class="wsf-pr-branches">' + (info.head ? '<code>' + escapeHtml(info.head) + '</code>' : '') + (info.base ? ' \u2192 <code>' + escapeHtml(info.base) + '</code>' : '') + '</span>' : '';
    return '<div class="wsf-pr-head"><div class="wsf-pr-title-row"><span class="wsf-pr-title">' + escapeHtml(info.title || t('Pull request')) + '</span> <span class="wsf-pr-num">#' + escapeHtml(String(info.number || '')) + '</span></div>'
        + '<div class="wsf-pr-sub">' + _wsfPrStateBadgeHtml(info.state) + br
        + (info.url ? '<a class="sn-artifact-icon-btn wsf-pr-gh" href="' + escapeHtml(info.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(t('Open on GitHub')) + '" aria-label="' + escapeHtml(t('Open on GitHub')) + '">' + _wsfIcon('externalLink') + '</a>' : '')
        + '</div></div>';
}

function _wsfPrDescHtml(body) {
    if (!body || !String(body).trim()) return '<div class="wsf-empty">' + escapeHtml(t('No description provided.')) + '</div>';
    var html = typeof fvRenderMarkdown === 'function' ? fvRenderMarkdown(String(body)) : '<pre class="wsf-code">' + escapeHtml(String(body)) + '</pre>';
    return '<div class="wsf-pr-desc fv-md message-content">' + html + '</div>';
}

// Description: stored meta.prs body first, else GitHub GET /pulls/N (cached
// per url on success). Resolves the detail object or null.
async function _wsfFetchPrDetail(pr) {
    var info = _wsfPrInfoOf(pr);
    if (info.body != null) return info;
    var parsed = typeof parsePrUrl === 'function' && pr.url ? parsePrUrl(pr.url) : null;
    if (!parsed || typeof githubApi !== 'function') return info;
    var res = await githubApi('GET', '/repos/' + parsed.repo + '/pulls/' + parsed.number);
    if (!res || !res.ok || !res.body || typeof res.body !== 'object') throw new Error((res && (res.error || res.status)) || 'request failed');
    var b = res.body;
    _wsfPrDetailCache[pr.url] = { title: b.title || '', body: b.body || '', state: b.merged ? 'merged' : (b.state === 'closed' ? 'closed' : 'open'), head: b.head && b.head.ref, base: b.base && b.base.ref };
    return _wsfPrInfoOf(pr);
}

// PR reference from a clicked element (sidebar row / chip): {url, number,
// title} or null. el carries data-pr-url / data-pr-number or sits inside an
// element that does (.pr-sidebar-entry).
function _wsfPrFromEl(el) {
    var src = el && el.getAttribute && el.getAttribute('data-pr-url') ? el : (el && el.closest ? el.closest('[data-pr-url]') : null);
    var url = src ? src.getAttribute('data-pr-url') : null;
    if (!url) return null;
    var titleEl = src.querySelector ? src.querySelector('.pr-sidebar-title') : null;
    return { url: url, number: parseInt(src.getAttribute('data-pr-number'), 10) || _wsfPrNumberOfUrl(url), title: titleEl ? titleEl.textContent : '' };
}

function _wsfPrNumberOfUrl(url) {
    var m = url && /\/pull\/(\d+)/.exec(url);
    return m ? parseInt(m[1], 10) : null;
}

// PR modal body: Conversation + Files changed
// tabs. Renders synchronously from stored data (meta.prs: title, body,
// head/base, files with shas and +/- counts).
function _wsfPrViewParts(pr) {
    var info = _wsfPrInfoOf(pr);
    var chat = (typeof chats !== 'undefined' && typeof currentChatId !== 'undefined') ? chats[currentChatId] : null;
    var files = _wsfFilesForPr(pr, chat);
    var filesHtml = '<div class="wsf-pr-modal-files" data-pr-url="' + escapeHtml(pr.url) + '">' + _wsfPrFilesTabHtml(pr, files) + '</div>';
    var body = '<div class="wsf-pr-tabs" role="tablist">'
        + '<button type="button" role="tab" class="wsf-pr-tab active" aria-selected="true" data-tab="conv" onclick="wsfPrModalTab(this, \'conv\')">' + escapeHtml(t('Conversation')) + '</button>'
        + '<button type="button" role="tab" class="wsf-pr-tab" aria-selected="false" data-tab="files" onclick="wsfPrModalTab(this, \'files\')">' + escapeHtml(t('Files changed')) + ' <span class="wsf-pr-count">' + (files ? files.length : 0) + '</span></button></div>'
        + '<div class="wsf-pr-pane" data-pane="conv" role="tabpanel">' + (info.body != null ? _wsfPrDescHtml(info.body) : '<div class="wsf-empty">' + escapeHtml(t('Loading...')) + '</div>') + '</div>'
        + '<div class="wsf-pr-pane" data-pane="files" role="tabpanel" hidden>' + filesHtml + '</div>';
    return { info: info, headHtml: _wsfPrHeadHtml(info), bodyHtml: body };
}

// After render: legacy PRs (no stored body) fetch with a visible loading
// state; PRs with stored data get a SILENT live check (_wsfPrLiveCheck).
// root = the PR modal overlay.
function _wsfPrAfterRender(root, pr, info) {
    if (info.body == null) {
        _wsfFetchPrDetail(pr).then(function(d) {
            var pane = root.querySelector('[data-pane="conv"]');
            if (pane) pane.innerHTML = _wsfPrDescHtml(d.body);
            var head = root.querySelector('.wsf-pr-head');
            if (head) head.outerHTML = _wsfPrHeadHtml(d);
        }).catch(function(e) {
            var pane = root.querySelector('[data-pane="conv"]');
            if (pane) pane.innerHTML = '<div class="wsf-empty">' + escapeHtml(t('Could not load the PR description: {error}', { error: (e && e.message) || String(e) })) + '</div>';
        });
        return null;
    }
    return _wsfPrLiveCheck(root, pr, info);
}

// --- Silent live check (stored data shown first) ---------------------------
// GET /pulls/N at most once per url per _WSF_PR_LIVE_TTL_MS (deduped while in
// flight). Only REAL changes are applied, in place: the state badge, the
// title text and the description node. Never re-renders the view, so
// expanded diffs, scroll position and the active tab are kept. Failures are
// silent (the stored data stays).
var _WSF_PR_LIVE_TTL_MS = 60000;
var _wsfPrLive = Object.create(null); // url -> { at, promise }

function _wsfPrLiveFetch(pr) {
    var url = pr && pr.url;
    var parsed = url && typeof parsePrUrl === 'function' ? parsePrUrl(url) : null;
    if (!parsed || typeof githubApi !== 'function') return Promise.resolve(null);
    var e = _wsfPrLive[url];
    var now = Date.now();
    if (e && (e.inflight || now - e.at < _WSF_PR_LIVE_TTL_MS)) return e.promise;
    e = _wsfPrLive[url] = { at: now, inflight: true, promise: null };
    e.promise = Promise.resolve().then(function() {
        return githubApi('GET', '/repos/' + parsed.repo + '/pulls/' + parsed.number);
    }).then(function(res) {
        e.inflight = false;
        if (!res || !res.ok || !res.body || typeof res.body !== 'object') return null;
        var b = res.body;
        var det = { title: b.title || '', body: b.body || '', state: b.merged ? 'merged' : (b.state === 'closed' ? 'closed' : 'open'), head: b.head && b.head.ref, base: b.base && b.base.ref };
        // Invalidated meanwhile (_wsfApplyPrInfos): don't resurrect the cache.
        if (_wsfPrLive[url] === e) _wsfPrDetailCache[url] = det;
        return det;
    }, function() { e.inflight = false; return null; });
    return e.promise;
}

function _wsfPrLiveCheck(root, pr, shown) {
    return _wsfPrLiveFetch(pr).then(function(det) {
        if (!det || !root) return { changed: [] };
        var changed = [];
        if (det.state && det.state !== shown.state) {
            var badge = root.querySelector('.wsf-pr-head .wsf-pr-state');
            if (badge) { badge.outerHTML = _wsfPrStateBadgeHtml(det.state); changed.push('state'); }
        }
        if (det.title && det.title !== shown.title) {
            var te = root.querySelector('.wsf-pr-head .wsf-pr-title');
            if (te) { te.textContent = det.title; changed.push('title'); }
        }
        if (typeof det.body === 'string' && det.body !== (shown.body || '')) {
            var conv = root.querySelector('[data-pane="conv"]');
            if (conv) { conv.innerHTML = _wsfPrDescHtml(det.body); changed.push('body'); }
        }
        if (changed.length) {
            shown.state = det.state || shown.state;
            shown.title = det.title || shown.title;
            shown.body = det.body;
            _wsfPersistPrDetail(pr, det);
        }
        return { changed: changed };
    }).catch(function() { return { changed: [] }; }); // silent: stored data stays
}

// Best effort: write a changed title / body back to the meta.prs entries of
// that PR (state is left to the sidebar's merge lifecycle).
function _wsfPersistPrDetail(pr, det) {
    if (typeof getAllWorkspaceMetas !== 'function' || typeof patchWorkspaceMeta !== 'function') return;
    try {
        getAllWorkspaceMetas().then(function(metas) {
            (metas || []).forEach(function(m) {
                var hit = (m && Array.isArray(m.prs)) && m.prs.some(function(p) { return p && p.url === pr.url; });
                if (!hit) return;
                patchWorkspaceMeta(m.repo, function(cur) {
                    var dirty = false;
                    (cur.prs || []).forEach(function(p) {
                        if (!p || p.url !== pr.url) return;
                        if (det.title && p.title !== det.title) { p.title = det.title; dirty = true; }
                        if (typeof det.body === 'string' && p.body !== det.body) { p.body = det.body.slice(0, 20000); dirty = true; }
                    });
                    return dirty ? undefined : false;
                }).catch(function() {});
            });
        }).catch(function() {});
    } catch (e) { /* not fatal */ }
}

// Entry point (sidebar PR rows, diff-modal PR chip): the GitHub-style PR
// modal, rendered from stored data then silently live-checked. CSP-
// polyfill-safe handler: onclick="wsfOpenPrModal(this, event)".
function wsfOpenPrModal(el, ev) {
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    var pr = _wsfPrFromEl(el);
    if (!pr) return null;
    var url = pr.url;
    // Already open (e.g. the PR chip of a diff modal): bring it to the top
    // and focus it instead of stacking a second PR modal.
    var existing = _wsfFindPrOverlay(url);
    if (existing) {
        document.body.appendChild(existing);
        var cb = existing.querySelector('.wsf-modal-close');
        if (cb && typeof cb.focus === 'function') cb.focus();
        return existing;
    }
    var parts = _wsfPrViewParts(pr);
    var overlay = _wsfOverlay(parts.headHtml, parts.bodyHtml, { returnFocus: el && el.focus ? el : null });
    overlay.classList.add('wsf-pr-overlay');
    overlay.setAttribute('data-pr-url', url);
    _wsfPrAfterRender(overlay, pr, parts.info);
    return overlay;
}

function _wsfFindPrOverlay(url) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return null;
    var all = document.querySelectorAll('.wsf-pr-overlay');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-pr-url') === url) return all[i];
    return null;
}

function wsfPrModalTab(btn, which) {
    var modal = btn && btn.closest ? btn.closest('.wsf-modal') : null;
    if (!modal) return;
    modal.querySelectorAll('.wsf-pr-tab').forEach(function(b) { var on = b.getAttribute('data-tab') === which; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    modal.querySelectorAll('.wsf-pr-pane').forEach(function(p) { p.hidden = p.getAttribute('data-pane') !== which; });
}

// --- Sidebar section renderer (called from renderVersionSidebar) ------------

function renderWorkspaceFilesSection(chat) {
    var files = getWsEditedFilesForChat(chat);
    // Sub-agent aggregation: files edited from this chat's sub-agent chats
    // surface in the parent sidebar too, attributed to the worker in the row
    // tooltip (f.workers). De-duped by workspace and path — when both the parent and a worker
    // touched the same workspace/path the change lists are merged but the parent's status flags win: cross-chat ordering
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
                    if (sf.live && !own.live) own.live = sf.live;
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
    if (files.length === 0) { _wsfWsFiles = []; if (_wsfNavSource !== 'pr') _wsfSectionFiles = []; return ''; }

    // WSF-SCOPE: only files that belong to no PR (see _wsfIsUncommitted).
    if (_wsfMergedSnaps === null) _wsfRefreshMergedSnaps(); // status needs PR states + live rows
    var groups = [], byWs = Object.create(null), shown = [];
    files.forEach(function(f) {
        f._status = _wsfStatusOf(f);
        if (!_wsfIsUncommitted(f, f._status)) return;
        var g = String(f.wsKey || '');
        if (!byWs[g]) { byWs[g] = { wsKey: f.wsKey || null, files: [] }; groups.push(byWs[g]); }
        byWs[g].files.push(f);
    });
    groups.forEach(function(g) { shown = shown.concat(g.files); });
    _wsfWsFiles = shown;
    // Keep an open PR-file modal's navigation list across re-renders.
    var prModalOpen = _wsfNavSource === 'pr' && typeof document !== 'undefined' && document.querySelector && document.querySelector('.wsf-overlay');
    if (!prModalOpen) { _wsfNavSource = 'ws'; _wsfSectionFiles = shown; }
    if (!shown.length) return '';

    var i = -1;
    function row(f) {
        i++;
        var tipExtra = [];
        if (f.wsKey) tipExtra.push(f.wsKey);
        (f.workers || []).forEach(function(w) { tipExtra.push(t('Edited by worker {name}', { name: w })); });
        return _wsfFileLineHtml(f, f._status.key, 'wsfOpenWsFile(' + i + ')', tipExtra);
    }

    var html = '<div class="version-wsfiles-section">';
    html += '<div class="version-section-title">' + t('Workspace Files ({count})', { count: shown.length }) + '</div>';
    // Label groups only when >1 KNOWN workspace has files (rows whose call
    // omitted `workspace` form an unlabelled group otherwise).
    var labelled = groups.filter(function(g) { return g.wsKey; }).length > 1;
    groups.forEach(function(g) {
        if (labelled) {
            html += '<div class="wsf-group-label"' + (g.wsKey ? ' title="' + escapeHtml(g.wsKey) + '">' + escapeHtml(g.wsKey.split('/').pop()) : '>' + escapeHtml(t('workspace'))) + '</div>';
        }
        html += '<div class="wsf-list">';
        g.files.forEach(function(f) { html += row(f); });
        html += '</div>';
    });
    html += '</div>';
    _wsfKickCounts();
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
    // The PR modal (.wsf-pr-overlay) under a stacked diff stays open.
    var old = Array.prototype.slice.call(document.querySelectorAll('.wsf-overlay:not(.wsf-pr-overlay)'));
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
        // show the PR entry's pushed snapshot, else the merged PR's pushed
        // content when a snapshot exists.
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
// out (optional): receives { adds, dels }.
function _wsfRenderDiffHtml(oldText, newText, out) {
    var diff = computeDiff(oldText || '', newText || '');
    var wordDiffs = computeWordDiffsForLines(diff);
    var adds = 0, dels = 0;
    diff.forEach(function(d) {
        if (d.type === 'add') adds++;
        else if (d.type === 'remove') dels++;
    });
    if (out) { out.adds = adds; out.dels = dels; }
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
    // GitHub-style: omit the zero side (+12, not +12 \u22120).
    var html = '<div class="wsf-diff-stats">' + (adds ? '<span class="wsf-diff-add">+' + adds + '</span>' : '') + (dels ? '<span class="wsf-diff-del">\u2212' + dels + '</span>' : '') + '</div>';
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
// Merged-PR snapshot texts for a section entry: { oldText, newText, snap }
// or null (no snapshot, or a referenced blob is gone — pre-fix GC, quota
// failure at push time; never render a half-empty diff that pretends the
// file was created or deleted).
async function _wsfMergedSnapTexts(f) {
    if (typeof getAllWorkspaceMetas !== 'function' || typeof getWorkspaceBlobsBySha !== 'function') return null;
    var snap = _wsfPickSnap(_wsfCollectMergedSnaps(await getAllWorkspaceMetas())[f.path], f.wsKey);
    if (!snap) return null;
    var tx = await _wsfPrSnapTexts(snap.file);
    if (!tx && (snap.file.old_sha || snap.file.new_sha)) return null;
    return { oldText: tx ? tx.oldText : '', newText: tx ? tx.newText : '', snap: snap };
}

async function _wsfOpenMergedDiff(f, i) {
    try {
        var m = await _wsfMergedSnapTexts(f);
        if (!m) return false;
        var snap = m.snap, oldText = m.oldText, newText = m.newText;
        var extra = (snap.pr.merged_at ? String(snap.pr.merged_at).slice(0, 10) + ' \u00b7 ' : '') + t('original edited diff (pre-merge base \u2192 pushed content)');
        var note = _wsfPrChipLineHtml({ url: snap.pr.url, number: snap.pr.number, title: snap.pr.title, state: 'merged' }, extra);
        _wsfOverlay(escapeHtml(f.path), note + _wsfRenderDiffHtml(oldText, newText), { fileIndex: i, active: 'diff' });
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
        var body = _wsfPrChipLineHtml({ url: snap.pr.url, number: snap.pr.number, title: snap.pr.title, state: 'merged' }, t('pushed content \u00b7 {size}', { size: _wsfFmtSize(content) }))
            + '<pre class="wsf-code">' + escapeHtml(content) + '</pre>';
        _wsfOverlay(escapeHtml(f.path), body, { fileIndex: i, active: 'view' });
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
    if (typeof releaseChatFollow === 'function') releaseChatFollow(tcEl);
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
                try { _wsfInvalidateCounts(); _wsfRefreshOwnedRows(); _wsfRefreshMergedSnaps(); } catch (e2) { /* not fatal */ }
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
