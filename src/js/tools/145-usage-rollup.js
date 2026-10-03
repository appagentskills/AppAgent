// =============================================================
// riUsageRollup — DEV-ONLY read-only token-usage rollup helper.
//
// Aggregates LLM usage across the ENTIRE IndexedDB `chats` store
// in one readonly cursor pass. Intended to be invoked via
// runtime_inspect {action:'call', path:'riUsageRollup', args:[{page, pageSize}]}
// (the call action awaits async functions — tools/140-runtime-inspect.js).
//
// Counting rules (mirror the metrics pill / history-view semantics):
//   • only role:'assistant' messages with a metrics object
//   • metrics.isAggregate === true rows are SKIPPED (turn rollups —
//     counting them would double-count, see app/030-agent-loop.js)
//   • rows with neither input_tokens nor output_tokens are skipped
//   • cache_write = cache_write_tokens + cache_creation_tokens
//
// Output is compact and paged so it always fits the runtime_inspect
// safe-serializer caps (100 array items / 64KB total): per-chat rows
// are sorted by input tokens desc and returned pageSize (<=60) at a
// time; global / per-model / monthly rollups ride on every page.
//
// TIME SERIES (opts.series: 'hourly'|'daily'|'monthly'): additionally
// returns { series: [buckets], series_kind, ts_coverage }.
//   • bucket = { t, input, cache_read, cache_write, output, calls,
//               cost, chats_created, chats_active } with UTC keys
//     t = '2026-07-24T13' | '2026-07-24' | '2026-07'
//   • hourly = last 72 hours max, daily = last 100 days max,
//     monthly = all months. Empty buckets in range are zero-filled
//     (contiguous from first activity to now) so charts are continuous.
//   • per-call timestamp source: metrics.endTime || metrics.startTime
//     (epoch ms, present on real LLM-call messages) || m.timestamp,
//     falling back to chat.updatedAt/createdAt. ts_coverage = fraction
//     of counted calls that had a REAL per-message timestamp.
//   • chats_created buckets chat.createdAt; chats_active = distinct
//     chats with usage in that bucket.
//   • by_model:true (series mode only): each bucket gains bm =
//     { modelName: [input, output, calls] } limited to the top 7
//     all-time-input models (everything else folded into 'other');
//     models with all-zero triples are omitted per bucket. Response
//     gains models = ordered name list (+ 'other' if used) and the
//     chats page is trimmed to 0 rows. If the serialized series
//     would near the 64KB serializer cap, degrades to top 5 + other.
//
// READ-ONLY: opens a 'readonly' transaction, never writes anything.
// This file is page-bundle only (tools tier), same context as
// runtime-inspect, so openDatabase() is in scope.
// =============================================================

// Per-chat cache (key -> { sig, calls }) so repeat calls (a pinned home
// widget polls every 60 s) skip re-walking every chat's `messages`. `calls`
// holds one compact tuple per counted LLM call, in message order:
//   [input, output, cache_read, cache_write, cost, model, m.timestamp, realTs]
// model is resolved with rec.model and the ts fallbacks are applied at replay
// time from the live record, so replaying yields byte-identical output.
// sig covers every record field the walk depends on; entries for chats no
// longer in the store are dropped after each full pass.
//
// NO-FULL-SCAN (memory): a cursor over `chats` deserializes EVERY full record
// (~1 GB with thousands of chats) on every 60 s poll, even when all are cache
// hits. So a warm call enumerates keys only (getAllKeys) and replays a chat
// from the cache when the page's in-memory row `chats[key]` still matches the
// record pre-signature captured at the last full read (_riUsagePre: rev,
// updatedAt, createdAt, model, message COUNT, title; never message bodies,
// which the page strips/evicts). A page row may be an evicted skeleton (no
// `messages` at all, count kept in `_msgCount`), so a row's count is read ONLY
// through core's chatMessageCount() — never `.messages` — and without it no
// row is trusted (exact full pass). Only mismatches, chats missing from the
// page map and re-verify picks are read with a single store.get(key).
// Stale-meta trade-off: memory AHEAD of disk (unsaved append) mismatches the
// record-derived pre, so the chat is re-read each poll until the save lands.
// Disk AHEAD of memory (a write this page never heard of) cannot be seen
// without reading, so each entry carries a trust stamp `at` and a hit is DUE
// once now - at >= RI_USAGE_REVERIFY_MS (R):
//   • due hits are re-read oldest-first, at most max(8, ceil(n*elapsed/R)) per
//     call (n = chats, elapsed = time since the last completed cached call),
//     so re-read capacity keeps pace with expiry at any poll cadence;
//   • every batch read in one call has its stamps spread evenly over the span
//     it covers (R for a full pass, min(elapsed, R) for re-verify picks), so
//     expiries never bunch (e.g. after a gap >= R that re-read everything).
// Guarantee, for a stable chat count: a served hit was read from disk less
// than R + one call interval ago. Only a burst of CHANGED chats re-read in the
// same call (stamped together) can lag behind that, and no hit is ever served
// 2R or more after its read (FIFO: the entries ahead of a due one never
// increase, and the caps summed over (due, t] are >= n*(t-due)/R).
// A cold cache, no page map, or opts.noCache:true take the original exact
// full cursor pass.
var _riUsageCache = new Map();
var RI_USAGE_REVERIFY_MS = 3600000;
var _riUsageLastCall = 0; // nowTs of the last completed cached call
// Page rows reach this only past the guarded hit check, so the `.messages`
// fallback (core not loaded: test harness) only ever counts disk records.
function _riUsageMsgCount(c) {
    return typeof chatMessageCount === 'function' ? chatMessageCount(c) : (c.messages || []).length;
}
function _riUsagePre(c) {
    return JSON.stringify([c.rev === undefined ? null : c.rev, c.updatedAt || 0, c.createdAt || 0,
        c.model || '', _riUsageMsgCount(c), String(c.title || '')]);
}
// Spread the trust stamps of `keys` (oldest first) evenly over (now - span, now].
function _riUsageStagger(keys, now, span) {
    for (var i = 0; i < keys.length; i++) {
        var e = _riUsageCache.get(keys[i]);
        if (e) e.at = now - Math.floor(span * (keys.length - 1 - i) / keys.length);
    }
}
function _riUsageSig(rec, msgs) {
    var last = msgs.length ? msgs[msgs.length - 1] : null;
    var lm = last && last.metrics;
    return [rec.updatedAt || 0, rec.createdAt || 0, rec.model || '', msgs.length,
        last ? (last.role || '') + ':' + (last.timestamp || 0) : '',
        lm ? (lm.input_tokens || 0) + ',' + (lm.output_tokens || 0) + ',' + (lm.isAggregate ? 1 : 0) + ',' + (lm.endTime || 0) : ''].join('|');
}
function _riUsageCalls(rec, msgs) {
    var calls = [];
    for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m || m.role !== 'assistant' || !m.metrics || m.metrics.isAggregate) continue;
        var t = m.metrics;
        if (!t.input_tokens && !t.output_tokens) continue;
        calls.push([t.input_tokens || 0, t.output_tokens || 0, t.cache_read_tokens || 0,
            (t.cache_write_tokens || 0) + (t.cache_creation_tokens || 0), t.cost || 0,
            t.actualModel || rec.model || 'unknown', m.timestamp, t.endTime || t.startTime || m.timestamp || 0]);
    }
    return calls;
}

async function riUsageRollup(opts) {
    opts = opts || {};
    var useCache = opts.noCache !== true, seenKeys = useCache ? new Set() : null, completed = false;
    var fullPass = false, picks = null;
    var db = await openDatabase();
    var tx = db.transaction(['chats'], 'readonly');
    var store = tx.objectStore('chats');
    var g = { chats: 0, chats_with_usage: 0, llm_calls: 0, input: 0, output: 0,
              cache_read: 0, cache_write: 0, cost: 0 };
    var perModel = {}, monthly = {}, perChat = [];
    var seriesKind = (opts.series === 'hourly' || opts.series === 'daily' || opts.series === 'monthly') ? opts.series : null;
    var HOUR_MS = 3600000, DAY_MS = 86400000;
    var nowTs = Date.now();
    var elapsed = nowTs - _riUsageLastCall;
    var seriesCutoff = seriesKind === 'hourly' ? nowTs - 72 * HOUR_MS :
                       seriesKind === 'daily'  ? nowTs - 100 * DAY_MS : 0;
    var seriesMax = nowTs + HOUR_MS; // ignore clock-skewed future stamps
    var buckets = {}, bucketChats = {}, tsReal = 0, tsTotal = 0, minSeriesTs = nowTs;
    var byModel = !!(seriesKind && opts.by_model);
    var bucketModels = {};
    function zeroBucket(t) {
        return { t: t, input: 0, cache_read: 0, cache_write: 0, output: 0,
                 calls: 0, cost: 0, chats_created: 0, chats_active: 0 };
    }
    function bucketKey(ts) {
        var iso = new Date(ts).toISOString();
        return seriesKind === 'hourly' ? iso.slice(0, 13) :
               seriesKind === 'daily'  ? iso.slice(0, 10) : iso.slice(0, 7);
    }
    function bucketAt(ts) {
        var k = bucketKey(ts);
        if (!buckets[k]) { buckets[k] = zeroBucket(k); bucketChats[k] = {}; }
        if (ts < minSeriesTs) minSeriesTs = ts;
        return buckets[k];
    }
    // Aggregate one chat. `info` holds the only record fields the rollup
    // reads besides messages: { title (80-char slice), msgs, u, c } (raw
    // updatedAt / createdAt), so a cache replay needs no record.
    function addChat(ck, info, calls) {
            var row = { key: ck, title: info.title,
                        updatedAt: info.u || info.c || 0, msgs: info.msgs,
                        calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0,
                        cost: 0, models: {} };
            for (var i = 0; i < calls.length; i++) {
                var c = calls[i];
                row.calls++;
                row.input += c[0];
                row.output += c[1];
                row.cache_read += c[2];
                row.cache_write += c[3];
                row.cost += c[4];
                var model = c[5];
                row.models[model] = (row.models[model] || 0) + 1;
                var pm = perModel[model] || (perModel[model] = { calls: 0, input: 0, output: 0, cost: 0 });
                pm.calls++; pm.input += c[0]; pm.output += c[1]; pm.cost += c[4];
                var ts = c[6] || info.u || info.c;
                var mo = ts ? new Date(ts).toISOString().slice(0, 7) : 'unknown';
                var mb = monthly[mo] || (monthly[mo] = { calls: 0, input: 0, output: 0, cost: 0 });
                mb.calls++; mb.input += c[0]; mb.output += c[1]; mb.cost += c[4];
                if (seriesKind) {
                    var realTs = c[7];
                    tsTotal++;
                    if (realTs) tsReal++;
                    var sts = realTs || info.u || info.c || 0;
                    if (sts && sts >= seriesCutoff && sts <= seriesMax) {
                        var bk = bucketAt(sts);
                        bk.calls++;
                        bk.input += c[0];
                        bk.output += c[1];
                        bk.cache_read += c[2];
                        bk.cache_write += c[3];
                        bk.cost += c[4];
                        bucketChats[bucketKey(sts)][ck] = 1;
                        if (byModel) {
                            var bmk = bucketKey(sts);
                            var bmRow = bucketModels[bmk] || (bucketModels[bmk] = {});
                            var bmCell = bmRow[model] || (bmRow[model] = [0, 0, 0]);
                            bmCell[0] += c[0];
                            bmCell[1] += c[1];
                            bmCell[2]++;
                        }
                    }
                }
            }
            if (seriesKind && info.c && info.c >= seriesCutoff && info.c <= seriesMax) {
                bucketAt(info.c).chats_created++;
            }
            g.chats++;
            if (row.calls > 0) {
                g.chats_with_usage++;
                g.llm_calls += row.calls; g.input += row.input; g.output += row.output;
                g.cache_read += row.cache_read; g.cache_write += row.cache_write; g.cost += row.cost;
                row.models = Object.keys(row.models);
                perChat.push(row);
            }
    }
    // Full record -> calls (exact sig check as before) -> aggregate; with the
    // cache on, (re)stamps the entry with the record pre-signature + read time
    // (a bulk re-read is spread afterwards, see _riUsageStagger).
    function addRecord(ck, rec) {
        var msgs = rec.messages || [], calls;
        var info = { title: String(rec.title || '').slice(0, 80), msgs: msgs.length, u: rec.updatedAt, c: rec.createdAt };
        if (useCache) {
            var sig = _riUsageSig(rec, msgs), hit = _riUsageCache.get(ck);
            calls = (hit && hit.sig === sig) ? hit.calls : _riUsageCalls(rec, msgs);
            _riUsageCache.set(ck, { sig: sig, calls: calls, pre: _riUsagePre(rec), at: nowTs, info: info });
        } else {
            calls = _riUsageCalls(rec, msgs);
        }
        addChat(ck, info, calls);
    }
    var meta = (useCache && typeof chats === 'object' && chats) ? chats : null;
    await new Promise(function (resolve, reject) {
        function fail(rq, what) { return function () { reject(rq.error || new Error('IDB ' + what + ' failed')); }; }
        function fullScan() {
            fullPass = true;
            var rq = store.openCursor();
            rq.onerror = fail(rq, 'cursor');
            rq.onsuccess = function () {
                var cur = rq.result;
                if (!cur) { completed = true; resolve(); return; }
                var ck = String(cur.key);
                if (useCache) seenKeys.add(ck);
                addRecord(ck, cur.value || {});
                cur.continue();
            };
        }
        if (!meta || typeof store.getAllKeys !== 'function') { fullScan(); return; }
        var kq = store.getAllKeys();
        kq.onerror = fail(kq, 'getAllKeys');
        kq.onsuccess = function () {
            var keys = kq.result || [], hits = new Array(keys.length), nHit = 0, due = [];
            for (var i = 0; i < keys.length; i++) {
                var ck = String(keys[i]), e = _riUsageCache.get(ck);
                seenKeys.add(ck);
                var m = Object.prototype.hasOwnProperty.call(meta, ck) ? meta[ck] : null;
                if (e && m && typeof chatMessageCount === 'function' && _riUsagePre(m) === e.pre) {
                    hits[i] = e; nHit++;
                    if (nowTs - e.at >= RI_USAGE_REVERIFY_MS) due.push(i);
                }
            }
            if (!nHit) { fullScan(); return; } // cold cache: one cursor pass
            due.sort(function (a, b) { return (hits[a].at - hits[b].at) || (a - b); });
            picks = due.slice(0, Math.max(8, Math.ceil(keys.length * elapsed / RI_USAGE_REVERIFY_MS)))
                .map(function (j) { hits[j] = null; return String(keys[j]); });
            var idx = 0;
            // Key order == cursor order, so rows/series/models aggregate in the
            // same order; misses are read one at a time (one record live).
            (function next() {
                while (idx < keys.length && hits[idx]) { addChat(String(keys[idx]), hits[idx].info, hits[idx].calls); idx++; }
                if (idx >= keys.length) { completed = true; resolve(); return; }
                var k = keys[idx++], gq = store.get(k);
                gq.onerror = fail(gq, 'get');
                gq.onsuccess = function () {
                    if (gq.result) addRecord(String(k), gq.result); else _riUsageCache.delete(String(k));
                    next();
                };
            })();
        };
    });
    if (useCache && completed) {
        _riUsageCache.forEach(function (_, k) { if (!seenKeys.has(k)) _riUsageCache.delete(k); });
        if (fullPass) _riUsageStagger(Array.from(seenKeys), nowTs, RI_USAGE_REVERIFY_MS);
        else if (picks && picks.length) _riUsageStagger(picks, nowTs, Math.max(0, Math.min(elapsed, RI_USAGE_REVERIFY_MS)));
        _riUsageLastCall = nowTs;
    }
    perChat.sort(function (a, b) { return b.input - a.input; });
    var page = (typeof opts.page === 'number' && opts.page > 0) ? Math.floor(opts.page) : 0;
    var size = (typeof opts.pageSize === 'number' && opts.pageSize > 0) ? Math.min(Math.floor(opts.pageSize), 60) : 40;
    var series = null;
    if (seriesKind) {
        Object.keys(bucketChats).forEach(function (k) {
            buckets[k].chats_active = Object.keys(bucketChats[k]).length;
        });
        series = [];
        var startTs = Math.max(minSeriesTs, seriesCutoff);
        if (seriesKind === 'monthly') {
            var sd = new Date(startTs), y = sd.getUTCFullYear(), mo = sd.getUTCMonth();
            var ed = new Date(nowTs), ey = ed.getUTCFullYear(), em = ed.getUTCMonth();
            while (y < ey || (y === ey && mo <= em)) {
                var mk = y + '-' + ('0' + (mo + 1)).slice(-2);
                series.push(buckets[mk] || zeroBucket(mk));
                mo++; if (mo > 11) { mo = 0; y++; }
            }
        } else {
            var stepMs = seriesKind === 'hourly' ? HOUR_MS : DAY_MS;
            var curTs = Math.floor(startTs / stepMs) * stepMs;
            var endTs = Math.floor(nowTs / stepMs) * stepMs;
            for (; curTs <= endTs; curTs += stepMs) {
                var bkKey = bucketKey(curTs);
                series.push(buckets[bkKey] || zeroBucket(bkKey));
            }
            var cap = seriesKind === 'hourly' ? 72 : 100;
            if (series.length > cap) series = series.slice(-cap);
        }
    }
    var out = {
        global: g,
        per_model: perModel,
        monthly: monthly,
        chat_rows: perChat.length,
        page: page,
        page_size: size,
        chats: perChat.slice(page * size, page * size + size)
    };
    if (seriesKind) {
        out.series_kind = seriesKind;
        out.series = series;
        out.ts_coverage = tsTotal ? Math.round((tsReal / tsTotal) * 10000) / 10000 : 0;
        // keep well under the 64KB serializer cap: series callers rarely
        // need the per-chat page too — trim it unless explicitly paged
        if (typeof opts.pageSize !== 'number' && typeof opts.page !== 'number') out.chats = out.chats.slice(0, 10);
        if (byModel) {
            var attachBm = function (topN) {
                var names = Object.keys(perModel).sort(function (a, b) {
                    return (perModel[b].input || 0) - (perModel[a].input || 0);
                });
                var top = names.slice(0, topN);
                var otherUsed = false;
                series.forEach(function (b) {
                    var raw = bucketModels[b.t], bm = {};
                    if (raw) Object.keys(raw).forEach(function (mn) {
                        var v = raw[mn];
                        if (!v[0] && !v[1] && !v[2]) return;
                        var key = top.indexOf(mn) >= 0 ? mn : 'other';
                        if (key === 'other') otherUsed = true;
                        var agg = bm[key] || (bm[key] = [0, 0, 0]);
                        agg[0] += v[0]; agg[1] += v[1]; agg[2] += v[2];
                    });
                    b.bm = bm;
                });
                return otherUsed ? top.concat(['other']) : top;
            };
            var modelList = attachBm(7);
            // stay comfortably under the 64KB serializer cap: degrade to
            // top 5 (+ other) rather than shortening model names
            if (JSON.stringify(series).length > 45000) modelList = attachBm(5);
            out.models = modelList;
            out.chats = [];
        }
    }
    return out;
}
