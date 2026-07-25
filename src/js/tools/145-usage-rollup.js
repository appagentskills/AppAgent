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

async function riUsageRollup(opts) {
    opts = opts || {};
    var db = await openDatabase();
    var tx = db.transaction(['chats'], 'readonly');
    var store = tx.objectStore('chats');
    var g = { chats: 0, chats_with_usage: 0, llm_calls: 0, input: 0, output: 0,
              cache_read: 0, cache_write: 0, cost: 0 };
    var perModel = {}, monthly = {}, perChat = [];
    var seriesKind = (opts.series === 'hourly' || opts.series === 'daily' || opts.series === 'monthly') ? opts.series : null;
    var HOUR_MS = 3600000, DAY_MS = 86400000;
    var nowTs = Date.now();
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
    await new Promise(function (resolve, reject) {
        var rq = store.openCursor();
        rq.onerror = function () { reject(rq.error || new Error('IDB cursor failed')); };
        rq.onsuccess = function () {
            var cur = rq.result;
            if (!cur) { resolve(); return; }
            var rec = cur.value || {};
            var msgs = rec.messages || [];
            var row = { key: String(cur.key), title: String(rec.title || '').slice(0, 80),
                        updatedAt: rec.updatedAt || rec.createdAt || 0, msgs: msgs.length,
                        calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0,
                        cost: 0, models: {} };
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i];
                if (!m || m.role !== 'assistant' || !m.metrics || m.metrics.isAggregate) continue;
                var t = m.metrics;
                if (!t.input_tokens && !t.output_tokens) continue;
                row.calls++;
                row.input += t.input_tokens || 0;
                row.output += t.output_tokens || 0;
                row.cache_read += t.cache_read_tokens || 0;
                row.cache_write += (t.cache_write_tokens || 0) + (t.cache_creation_tokens || 0);
                row.cost += t.cost || 0;
                var model = t.actualModel || rec.model || 'unknown';
                row.models[model] = (row.models[model] || 0) + 1;
                var pm = perModel[model] || (perModel[model] = { calls: 0, input: 0, output: 0, cost: 0 });
                pm.calls++; pm.input += t.input_tokens || 0; pm.output += t.output_tokens || 0; pm.cost += t.cost || 0;
                var ts = m.timestamp || rec.updatedAt || rec.createdAt;
                var mo = ts ? new Date(ts).toISOString().slice(0, 7) : 'unknown';
                var mb = monthly[mo] || (monthly[mo] = { calls: 0, input: 0, output: 0, cost: 0 });
                mb.calls++; mb.input += t.input_tokens || 0; mb.output += t.output_tokens || 0; mb.cost += t.cost || 0;
                if (seriesKind) {
                    var realTs = t.endTime || t.startTime || m.timestamp || 0;
                    tsTotal++;
                    if (realTs) tsReal++;
                    var sts = realTs || rec.updatedAt || rec.createdAt || 0;
                    if (sts && sts >= seriesCutoff && sts <= seriesMax) {
                        var bk = bucketAt(sts);
                        bk.calls++;
                        bk.input += t.input_tokens || 0;
                        bk.output += t.output_tokens || 0;
                        bk.cache_read += t.cache_read_tokens || 0;
                        bk.cache_write += (t.cache_write_tokens || 0) + (t.cache_creation_tokens || 0);
                        bk.cost += t.cost || 0;
                        bucketChats[bucketKey(sts)][String(cur.key)] = 1;
                        if (byModel) {
                            var bmk = bucketKey(sts);
                            var bmRow = bucketModels[bmk] || (bucketModels[bmk] = {});
                            var bmCell = bmRow[model] || (bmRow[model] = [0, 0, 0]);
                            bmCell[0] += t.input_tokens || 0;
                            bmCell[1] += t.output_tokens || 0;
                            bmCell[2]++;
                        }
                    }
                }
            }
            if (seriesKind && rec.createdAt && rec.createdAt >= seriesCutoff && rec.createdAt <= seriesMax) {
                bucketAt(rec.createdAt).chats_created++;
            }
            g.chats++;
            if (row.calls > 0) {
                g.chats_with_usage++;
                g.llm_calls += row.calls; g.input += row.input; g.output += row.output;
                g.cache_read += row.cache_read; g.cache_write += row.cache_write; g.cost += row.cost;
                row.models = Object.keys(row.models);
                perChat.push(row);
            }
            cur.continue();
        };
    });
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
