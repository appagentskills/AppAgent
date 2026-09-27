// =============================================================
// SW boot breadcrumbs (Boot OOM fix F6, SW half).
//
// A small persisted ring of boot-phase markers, so a service worker that
// dies mid-boot (OOM while hydrating a very large chats store, a wedged
// IDB backend, ...) still leaves evidence that can be read back after the
// restart. The page realm keeps its own ring (core/015, storage key
// appagentBootCrumbs, global appBootCrumb). This one uses a separate key
// and a distinct name (swBootCrumb), so the two can never clash.
//
// Contract:
//   * chrome.storage.local['appagentBootCrumbsSW'] holds an array of
//     {bootId, ctx: 'sw', phase, t, ...extra}, newest last, at most
//     SW_BOOT_CRUMBS_MAX (40) entries. bootId is fixed per SW boot (one
//     evaluation of this bundle).
//   * At most SW_BOOT_CRUMBS_MAX_WRITES (6) crumbs per SW boot; later
//     calls are dropped.
//   * Writes are serialized on ONE module-level chain, and crumbs that
//     arrive while a flush is still queued are coalesced into it:
//     bounded get -> push -> slice(-40) -> bounded set. A get that
//     throws, rejects, hangs or answers a non-object skips the batch, so
//     the stored ring is never overwritten from a partial read.
//   * The set goes through background.js _reopenStorageSet(obj, ms), so
//     this file adds no storage write site of its own. The ms is ALWAYS
//     explicit: this file runs during importScripts('sw-bundle.js'),
//     before background.js has assigned REOPEN_APP_TAB_CALL_MS, and the
//     `ms || REOPEN_APP_TAB_CALL_MS` fallback of _reopenCall would then arm
//     setTimeout(undefined), i.e. time out at once.
//   * swBootCrumb never throws, its promise never rejects, and boot never
//     awaits it. performance.memory does not exist in the SW, so no heap
//     figures are recorded here.
// =============================================================

var SW_BOOT_CRUMBS_KEY = 'appagentBootCrumbsSW';
var SW_BOOT_CRUMBS_MAX = 40;          // entries kept in the ring, newest last
var SW_BOOT_CRUMBS_MAX_WRITES = 6;    // crumbs accepted per SW boot
var SW_BOOT_CRUMBS_STEP_MS = 3000;    // bound of each get / set (explicit ms)
var SW_BOOT_CRUMBS_EXTRA_MAX = 400;   // max chars of one crumb's stringified extra
var _swBootCrumbBootId = _swBootCrumbNewBootId();
var _swBootCrumbCount = 0;
var _swBootCrumbPending = [];
var _swBootCrumbQueued = false;
var _swBootCrumbChain = Promise.resolve();

function _swBootCrumbNewBootId() {
    try {
        return 'sw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    } catch (e) {
        return 'sw-unknown';
    }
}

function _swBootCrumbNoop() {}

// {bootId, ctx, phase, t, ...extra}. Extra keys that collide with a reserved
// key are kept as x_<key>; an extra longer than SW_BOOT_CRUMBS_EXTRA_MAX
// chars once stringified is kept as the cut JSON string (truncated: true).
function _swBootCrumbEntry(phase, extra) {
    var entry = { bootId: _swBootCrumbBootId, ctx: 'sw', phase: String(phase == null ? '' : phase).slice(0, 60), t: Date.now() };
    if (extra == null) return entry;
    var json;
    try { json = JSON.stringify(extra); } catch (e) { entry.unserializable = true; return entry; }
    if (typeof json !== 'string') return entry;
    if (json.length > SW_BOOT_CRUMBS_EXTRA_MAX) {
        entry.truncated = true;
        entry.extra = json.slice(0, SW_BOOT_CRUMBS_EXTRA_MAX);
        return entry;
    }
    var copy = JSON.parse(json);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) { entry.extra = copy; return entry; }
    Object.keys(copy).forEach(function(k) {
        var reserved = (k === 'bootId' || k === 'ctx' || k === 'phase' || k === 't');
        entry[reserved ? 'x_' + k : k] = copy[k];
    });
    return entry;
}

function _swBootCrumbStorage() {
    try {
        var local = (typeof chrome !== 'undefined' && chrome && chrome.storage) ? chrome.storage.local : null;
        return (local && typeof local.get === 'function') ? local : null;
    } catch (e) {
        return null;
    }
}

// Settles like fn(), but never later than ms: a step that throws, rejects or
// hangs rejects here instead. The timer is cleared once the step settles.
function _swBootCrumbBounded(fn, ms) {
    return new Promise(function(resolve, reject) {
        var settled = false;
        var timer = setTimeout(function() {
            if (settled) return;
            settled = true;
            reject(new Error('sw boot crumb step timed out after ' + ms + 'ms'));
        }, ms);
        function finish(ok, v) {
            if (settled) return;
            settled = true;
            try { clearTimeout(timer); } catch (e) {}
            if (ok) resolve(v); else reject(v);
        }
        Promise.resolve().then(fn).then(function(v) { finish(true, v); }, function(e) { finish(false, e); });
    });
}

// One coalesced append: takes every pending crumb, then bounded get ->
// push -> slice(-SW_BOOT_CRUMBS_MAX) -> bounded set.
function _swBootCrumbFlush() {
    var batch = _swBootCrumbPending;
    _swBootCrumbPending = [];
    _swBootCrumbQueued = false;
    if (!batch.length) return undefined;
    var local = _swBootCrumbStorage();
    if (!local || typeof _reopenStorageSet !== 'function') return undefined;
    var stepMs = SW_BOOT_CRUMBS_STEP_MS;
    return _swBootCrumbBounded(function() { return local.get(SW_BOOT_CRUMBS_KEY); }, stepMs).then(function(got) {
        if (!got || typeof got !== 'object') return undefined; // not a real read: skip, never overwrite
        var prev = got[SW_BOOT_CRUMBS_KEY];
        var ring = (Array.isArray(prev) ? prev : []).concat(batch).slice(-SW_BOOT_CRUMBS_MAX);
        var obj = {};
        obj[SW_BOOT_CRUMBS_KEY] = ring;
        // Explicit ms (see header); the outer bound also covers a replaced or
        // hanging _reopenStorageSet, so the chain always moves on.
        return _swBootCrumbBounded(function() { return _reopenStorageSet(obj, stepMs); }, stepMs + 500);
    });
}

function _swBootCrumbRun() {
    try {
        return Promise.resolve(_swBootCrumbFlush()).then(_swBootCrumbNoop, _swBootCrumbNoop);
    } catch (e) {
        return undefined;
    }
}

// Records one boot-phase crumb. Synchronous for callers and never throws;
// the returned promise settles (never rejects) once the crumb is persisted
// or dropped. Callers must not await it on the boot path.
function swBootCrumb(phase, extra) {
    try {
        if (_swBootCrumbCount >= SW_BOOT_CRUMBS_MAX_WRITES) return _swBootCrumbChain;
        _swBootCrumbCount++;
        _swBootCrumbPending.push(_swBootCrumbEntry(phase, extra));
        if (!_swBootCrumbQueued) {
            _swBootCrumbQueued = true;
            _swBootCrumbChain = _swBootCrumbChain.then(_swBootCrumbRun, _swBootCrumbRun);
        }
        return _swBootCrumbChain;
    } catch (e) {
        return Promise.resolve();
    }
}
