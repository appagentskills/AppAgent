// ─── Agent Files "unseen" indicators (page only; not in the SW bundle) ───
// A file in the built-in Agent Files folder is UNSEEN when the user has not
// opened it since it was last written AND it was written less than 7 days ago
// (older files are never "new", so existing files at rollout do not flood).
// Seen state: appStorage 'agentFilesSeen' = { path: lastModified-when-seen }.
// A file is marked seen when previewed in Documents (sdocPreviewFile) or
// uploaded by the user (sdocUploadToSource). Entries for deleted / aged-out
// files are pruned on every scan. Indicators: bold row + dot in the listing,
// a dot on the Agent Files rail item, and a dot on the sidebar Documents button.
var AF_UNSEEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
var AF_SEEN_STORAGE_KEY = 'agentFilesSeen';
var afUnseenState = { seen: null, unseen: {}, scan: null, again: false, timer: null, sig: '' };

// Pure: is this listing entry unseen?
function afIsUnseen(entry, seen, now) {
    if (!entry || entry.kind === 'directory' || !entry.path) return false;
    var mt = typeof entry.lastModified === 'number' ? entry.lastModified : null;
    if (!mt || !(now - mt < AF_UNSEEN_MAX_AGE_MS)) return false;
    var s = seen ? seen[entry.path] : null;
    return !(typeof s === 'number' && s >= mt);
}
// Pure: { path: true } for every unseen entry.
function afUnseenMap(entries, seen, now) {
    var out = {};
    (entries || []).forEach(function(e) { if (afIsUnseen(e, seen, now)) out[e.path] = true; });
    return out;
}
// Pure: seen map limited to files that still exist and are still young.
function afPruneSeen(seen, entries, now) {
    var live = {}, out = {};
    (entries || []).forEach(function(e) { if (e && e.kind !== 'directory' && typeof e.lastModified === 'number' && now - e.lastModified < AF_UNSEEN_MAX_AGE_MS) live[e.path] = 1; });
    Object.keys(seen || {}).forEach(function(p) { if (live[p]) out[p] = seen[p]; });
    return out;
}
// Pure: any unseen path at or under dir ('' = whole folder).
function afUnseenUnder(unseen, dir) {
    var pre = dir ? String(dir).replace(/\/+$/, '') + '/' : '';
    return Object.keys(unseen || {}).some(function(p) { return !pre || p.indexOf(pre) === 0; });
}

// Always re-read: several panels (side panel + full tab) share localStorage, so a
// cached copy would overwrite another panel's marks on the next save.
function _afSeen() {
    var m = {};
    try { var raw = typeof appStorage !== 'undefined' ? appStorage.getItem(AF_SEEN_STORAGE_KEY) : null; if (raw) m = JSON.parse(raw) || {}; } catch (e) { m = {}; }
    return (afUnseenState.seen = (m && typeof m === 'object') ? m : {});
}
function _afSaveSeen() {
    // Skip no-op writes so panels reacting to each other's 'storage' events converge.
    try {
        if (typeof appStorage === 'undefined') return;
        var s = JSON.stringify(afUnseenState.seen || {});
        if (appStorage.getItem(AF_SEEN_STORAGE_KEY) !== s) appStorage.setItem(AF_SEEN_STORAGE_KEY, s);
    } catch (e) {}
}
function afIsPathUnseen(path) { return !!afUnseenState.unseen[path]; }
function afHasUnseen(dir) { return afUnseenUnder(afUnseenState.unseen, dir || ''); }

// Recursive scan of Agent Files -> recompute the unseen set, prune, repaint.
function afRefreshUnseen() {
    // A write that lands mid-scan may be missed by it: queue exactly one re-scan.
    if (afUnseenState.scan) { afUnseenState.again = true; return afUnseenState.scan; }
    if (typeof lfListDir !== 'function') return Promise.resolve();
    var vid = typeof LOCAL_FOLDER_VIRTUAL_ID !== 'undefined' ? LOCAL_FOLDER_VIRTUAL_ID : 'virtual';
    var p = Promise.resolve().then(function() { return lfListDir(vid, '', { recursive: true }); }).then(function(res) {
        var entries = (res && res.entries) || [], now = Date.now();
        // A truncated listing does not prove absence: prune only on a complete one.
        afUnseenState.seen = res && res.truncated ? _afSeen() : afPruneSeen(_afSeen(), entries, now);
        if (!(res && res.truncated)) _afSaveSeen();
        afUnseenState.unseen = afUnseenMap(entries, afUnseenState.seen, now);
        afRenderIndicators();
    }, function() {}).then(function() {
        afUnseenState.scan = null;
        if (afUnseenState.again) { afUnseenState.again = false; afScheduleRefresh(); }
    });
    afUnseenState.scan = p;
    return p;
}
function afScheduleRefresh(ms) {
    if (afUnseenState.timer) clearTimeout(afUnseenState.timer);
    afUnseenState.timer = setTimeout(function() { afUnseenState.timer = null; afRefreshUnseen(); }, ms == null ? 400 : ms);
}
// The user viewed (or uploaded) this file: remember the version they saw.
function afMarkSeen(path, mtime) {
    if (!path) return;
    var seen = _afSeen(), v = typeof mtime === 'number' && mtime > 0 ? mtime : Date.now();
    seen[path] = Math.max(v, seen[path] || 0);
    _afSaveSeen();
    if (afUnseenState.unseen[path]) { delete afUnseenState.unseen[path]; afRenderIndicators(); }
}
// Sidebar Documents dot + (when Documents is open) rail / rows. Repaints only on change.
function afRenderIndicators() {
    if (typeof document === 'undefined') return;
    var keys = Object.keys(afUnseenState.unseen).sort(), has = keys.length > 0;
    var btn = document.getElementById('documents-btn');
    if (btn) {
        var dot = btn.querySelector('.af-unseen-dot');
        if (!dot && has) {
            dot = document.createElement('span');
            dot.className = 'af-unseen-dot';
            dot.setAttribute('aria-hidden', 'true');
            btn.appendChild(dot);
        }
        if (dot) dot.style.display = has ? '' : 'none';
        btn.classList.toggle('af-has-unseen', has);
        var lbl = (typeof t === 'function' ? t('new') : 'new') + ': ' + (typeof LOCAL_FOLDER_VIRTUAL_LABEL !== 'undefined' ? LOCAL_FOLDER_VIRTUAL_LABEL : 'Agent Files');
        if (has) btn.setAttribute('aria-description', lbl); else btn.removeAttribute('aria-description');
    }
    var sig = keys.join('\n');
    if (sig === afUnseenState.sig) return;
    afUnseenState.sig = sig;
    if (typeof currentView !== 'undefined' && currentView === 'documents') {
        if (typeof sdocRenderSourcesStrip === 'function') sdocRenderSourcesStrip();
        if (typeof renderDocumentsPageItems === 'function') renderDocumentsPageItems();
    }
}

// Live updates: agent writes/deletes go through local_folder (directly or from js_eval).
// AgentEvents lives in the app tier (loaded after tools), so subscribe on DOMContentLoaded.
function afInitUnseen() {
    if (typeof AgentEvents !== 'undefined' && AgentEvents && typeof AgentEvents.on === 'function') {
        AgentEvents.on('toolCallResult', function(e) { if (e && (e.name === 'local_folder' || e.name === 'js_eval' || e.name === 'run_js_file')) afScheduleRefresh(); });
        AgentEvents.on('runFinished', function() { afScheduleRefresh(800); });
    }
    // Another panel marked a file seen (or pruned): repaint from the shared map.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function(ev) {
            if (ev && typeof ev.key === 'string' && ev.key.slice(-AF_SEEN_STORAGE_KEY.length) === AF_SEEN_STORAGE_KEY) afScheduleRefresh(0);
        });
    }
    afScheduleRefresh(1500);
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', afInitUnseen);
}
