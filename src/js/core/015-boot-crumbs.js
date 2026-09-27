// --- F6 boot breadcrumbs, page half (Boot OOM diagnosis) ---
// A no-throw, fire-and-forget ring of boot-phase breadcrumbs kept in extension local
// storage under BOOT_CRUMBS_KEY ('appagentBootCrumbs'), newest last, capped at 40, so the
// last phase a page load reached before it died (renderer OOM / crash) outlives it and can
// be read afterwards. The service-worker half (worker/185-boot-crumbs-sw.js) does NOT share
// this key: it keeps its own ring under 'appagentBootCrumbsSW'.
//
// Entry: { bootId, ctx: 'page', phase, t, heapMB?, ...extra }
//   bootId  one per page load (one evaluation of this file)
//   heapMB  performance.memory.usedJSHeapSize in MB (1 decimal), only where it exists
//   extra   own primitive fields only (strings cut to 200 chars, at most 12 keys); it can
//           not override the fields above. 'boot-complete' auto-fills ms from
//           performance.now() (else Date.now() - t0) unless the caller passed a number.
//
// API: appBootCrumb(phase, extra) never throws and never rejects. It returns a
// Promise<boolean> (true once the entry reached storage) that callers should ignore:
// never await it on a boot path. appBootCrumbState() is a read-only diagnostic snapshot.
//
// Writes:
//   - Serialized in this context: one read-modify-write in flight at a time. Entries queued
//     meanwhile are coalesced into the next get -> push -> slice(-40) -> set, so there is no
//     lost update inside this context.
//   - Every storage get/set is bounded (~3 s). A failed, hung or empty read never writes (a
//     blind write would clobber the previous boot's crumbs, the very evidence we want); its
//     entries stay queued, in order, and are retried after 1 s (each retry spends one flush
//     of the budget below). A failed or hung set drops its batch (no duplicate re-write).
//   - At most 15 flushes, so at most 15 storage writes, per boot. The last one is reserved
//     for the batch that carries 'boot-complete', so boot-complete is always attempted;
//     entries that arrive when only the reserve is left wait in memory (<= 40) and ride
//     along with it. Once the budget is spent, new crumbs resolve false at once.
//   - The page bundle loads platform-bridge LAST, so Platform.storageGet/storageSet do not
//     exist yet while core/ui/tools/app top-level code runs: early crumbs are buffered in
//     memory and the first flush is deferred to a microtask. If Platform is still not ready
//     then, a bounded setTimeout back-off retries (no tight loop), then the buffer is dropped.
//   - Cross-context updates are best-effort: the side panel and the app tab both
//     read-modify-write this one key without coordination (the SW never touches it; it uses
//     'appagentBootCrumbsSW'), so a write from another page context that interleaves with
//     ours can drop entries. Fine for diagnostics; build no logic on it.
var BOOT_CRUMBS_KEY = 'appagentBootCrumbs';

var _bootCrumbs = (function() {
    var CAP = 40, MAX_WRITES = 15, RESERVE = 1, IO_MS = 3000, RETRY_MS = 1000;
    var PLATFORM_WAITS = [10, 100, 500, 1000, 2000, 4000];
    var RESERVED = { bootId: 1, ctx: 1, phase: 1, t: 1, heapMB: 1 };
    var t0 = 0, bootId = 'boot';
    try { t0 = Date.now(); bootId = t0.toString(36) + '-' + Math.random().toString(36).slice(2, 10); } catch (e) {}
    var queue = [];     // pending [{ e: entry, r: resolve }], oldest first
    var busy = false, pumpPending = false, completeSeen = false;
    var spent = 0, written = 0, dropped = 0, waits = 0;

    function heapMB() {
        try {
            var mem = (typeof performance !== 'undefined' && performance) ? performance.memory : null;
            if (mem && typeof mem.usedJSHeapSize === 'number') return Math.round(mem.usedJSHeapSize / 104857.6) / 10;
        } catch (e) {}
        return undefined;
    }

    function sinceStart() {
        try {
            if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
                var p = performance.now();
                if (typeof p === 'number' && p >= 0 && p < 1e11) return Math.round(p);
            }
        } catch (e) {}
        try { return Date.now() - t0; } catch (e) { return null; }
    }

    function build(phase, extra) {
        var entry = { bootId: bootId, ctx: 'page', phase: String(phase == null ? '' : phase).slice(0, 64), t: Date.now() };
        var h = heapMB();
        if (h !== undefined) entry.heapMB = h;
        try {
            if (extra && typeof extra === 'object') {
                var keys = Object.keys(extra), n = 0;
                for (var i = 0; i < keys.length && n < 12; i++) {
                    var k = keys[i];
                    if (RESERVED[k] === 1) continue;
                    var v = extra[k];
                    if (typeof v === 'string') v = v.slice(0, 200);
                    else if (!(v === null || typeof v === 'number' || typeof v === 'boolean')) continue;
                    entry[k] = v;
                    n++;
                }
            }
        } catch (e) {}
        if (entry.phase === 'boot-complete' && typeof entry.ms !== 'number') entry.ms = sinceStart();
        return entry;
    }

    function isComplete(item) { return !!(item && item.e && item.e.phase === 'boot-complete'); }

    function settle(items, ok) {
        for (var i = 0; i < items.length; i++) { try { items[i].r(ok); } catch (e) {} }
    }

    function dropAll() {
        var items = queue.splice(0, queue.length);
        dropped += items.length;
        settle(items, false);
    }

    function trim() {
        if (queue.length <= CAP) return;
        var old = queue.splice(0, queue.length - CAP);
        dropped += old.length;
        settle(old, false);
    }

    function platform() {
        try {
            if (typeof Platform !== 'undefined' && Platform &&
                typeof Platform.storageGet === 'function' && typeof Platform.storageSet === 'function') return Platform;
        } catch (e) {}
        return null;
    }

    // Resolves { ok, v } within IO_MS; never rejects (a throw, a rejection or a hang is ok:false).
    function bounded(fn) {
        return new Promise(function(resolve) {
            var done = false, timer = null;
            function fin(r) {
                if (done) return;
                done = true;
                if (timer !== null) { try { clearTimeout(timer); } catch (e) {} }
                resolve(r);
            }
            try { timer = setTimeout(function() { fin({ ok: false }); }, IO_MS); } catch (e) {}
            try {
                Promise.resolve(fn()).then(function(v) { fin({ ok: true, v: v }); }, function() { fin({ ok: false }); });
            } catch (e) { fin({ ok: false }); }
        });
    }

    // One pending pump at a time: a microtask for ms 0, else a single timer (never a loop).
    function schedule(ms) {
        if (pumpPending) return;
        pumpPending = true;
        try {
            if (!ms) Promise.resolve().then(pump);
            else setTimeout(pump, ms);
        } catch (e) { pumpPending = false; }
    }

    // Keep the last write for the batch carrying 'boot-complete' until one was attempted.
    function canFlush() {
        if (spent >= MAX_WRITES) return false;
        if (completeSeen || spent < MAX_WRITES - RESERVE) return true;
        for (var i = 0; i < queue.length; i++) { if (isComplete(queue[i])) return true; }
        return false;
    }

    function pump() {
        pumpPending = false;
        try {
            if (busy || !queue.length) return;
            if (spent >= MAX_WRITES) { dropAll(); return; }
            var P = platform();
            if (!P) {
                if (waits < PLATFORM_WAITS.length) schedule(PLATFORM_WAITS[waits++]);
                else dropAll();
                return;
            }
            if (canFlush()) flush(P);
        } catch (e) {}
    }

    function finish(batch, outcome) {
        busy = false;
        try {
            if (outcome === 'ok') { written += batch.length; settle(batch, true); }
            else if (outcome === 'unread') { queue = batch.concat(queue); trim(); }
            else { dropped += batch.length; settle(batch, false); }
            if (queue.length) schedule(outcome === 'unread' ? RETRY_MS : 0);
        } catch (e) {}
    }

    function flush(P) {
        busy = true;
        spent++;
        var batch = queue.splice(0, queue.length);
        for (var i = 0; i < batch.length; i++) { if (isComplete(batch[i])) completeSeen = true; }
        bounded(function() { return P.storageGet([BOOT_CRUMBS_KEY]); }).then(function(got) {
            var stored = got.ok ? got.v : null;
            if (!stored || typeof stored !== 'object') return 'unread';
            var cur = stored[BOOT_CRUMBS_KEY];
            var ring = Array.isArray(cur) ? cur.slice() : [];
            for (var j = 0; j < batch.length; j++) ring.push(batch[j].e);
            if (ring.length > CAP) ring = ring.slice(-CAP);
            var data = {};
            data[BOOT_CRUMBS_KEY] = ring;
            return bounded(function() { return P.storageSet(data); }).then(function(put) { return put.ok ? 'ok' : 'unwritten'; });
        }).then(function(outcome) { finish(batch, outcome); }, function() { finish(batch, 'unwritten'); });
    }

    function add(phase, extra) {
        var entry;
        try { entry = build(phase, extra); } catch (e) { return Promise.resolve(false); }
        return new Promise(function(resolve) {
            try {
                if (spent >= MAX_WRITES) { dropped++; resolve(false); return; }
                queue.push({ e: entry, r: resolve });
                trim();
                schedule(0);
            } catch (e) { resolve(false); }
        });
    }

    function state() {
        return { bootId: bootId, t0: t0, queued: queue.length, busy: busy, spent: spent, written: written,
            dropped: dropped, waits: waits, completeSeen: completeSeen, cap: CAP, maxWrites: MAX_WRITES };
    }

    return { add: add, state: state };
})();

function appBootCrumb(phase, extra) {
    try { return _bootCrumbs.add(phase, extra); } catch (e) { return Promise.resolve(false); }
}

function appBootCrumbState() {
    try { return _bootCrumbs.state(); } catch (e) { return null; }
}
