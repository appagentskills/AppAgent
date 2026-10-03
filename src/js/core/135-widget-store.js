// Canonical saved widgets. Chat/dashboard rows are compatibility projections,
// never authorities after migration. One IDB readwrite transaction performs CAS,
// retry dedup and append; publish only AFTER commit. No title/HTML identity matching.
var WidgetStore = (function() {
    var records = Object.create(null);
    var ready = null;
    var channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('appagent-widget-versions-' + dbName) : null;
    function snapshot(widget) {
        return { title: widget.title || 'Widget', html: widget.html || '',
            width: typeof widget.width === 'string' ? widget.width : '400px',
            height: typeof widget.height === 'string' ? widget.height : '400px' };
    }
    function latest(record) { return record.versions[record.versions.length - 1]; }
    // Delete tombstones: ids removed via remove(). Stale chat/dashboard
    // projections (an SW chat snapshot re-put after the delete, an evicted
    // chat row) must never re-migrate them in load()/read(). localStorage
    // (page-only, per-origin, survives reload); capped. A delete is permanent
    // (no undo): commit() refuses a tombstoned id and only importRecords()
    // clears one. Missing/throwing localStorage = in-memory only, so a failed
    // read keeps this tab's list instead of wiping it.
    var TOMBSTONE_KEY = 'appagent-widget-tombstones-' + dbName, MAX_TOMBSTONES = 500;
    // Tombstone ops (id -> on/off) whose localStorage write failed (quota,
    // denied storage): re-applied over every fresh read and retried by the
    // next write, so a failed setItem never drops a delete in this tab.
    var pendingTombstones = Object.create(null);
    function withPending(list) {
        Object.keys(pendingTombstones).forEach(function(id) {
            var i = list.indexOf(id);
            if (pendingTombstones[id] && i === -1) list.push(id);
            else if (!pendingTombstones[id] && i !== -1) list.splice(i, 1);
        });
        return list;
    }
    function readTombstones() {
        try { var v = JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || '[]'); return withPending(Array.isArray(v) ? v : []); } catch (e) { return tombstones || []; }
    }
    var tombstones = readTombstones();
    function writeTombstones() {
        if (tombstones.length > MAX_TOMBSTONES) tombstones.splice(0, tombstones.length - MAX_TOMBSTONES);
        try { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(tombstones)); pendingTombstones = Object.create(null); }
        catch (e) { console.warn('Widget tombstones: localStorage write failed; kept in memory and retried on the next write', e); }
    }
    function isTombstoned(id) { return tombstones.indexOf(id) !== -1; }
    // Fresh check for every read-modify-write that could (re)create a row:
    // this tab's copy is refreshed only on its own writes and channel
    // notices, so another tab's delete may be missing from it (lost or late
    // notice, or a remove() still in flight with the row not yet gone).
    function tombstonedNow(id) { tombstones = readTombstones(); return isTombstoned(id); }
    function setTombstone(id, on) {
        tombstones = readTombstones();
        var i = tombstones.indexOf(id);
        if (on && i === -1) tombstones.push(id);
        else if (!on && i !== -1) tombstones.splice(i, 1);
        else return;
        pendingTombstones[id] = !!on;
        writeTombstones();
    }
    // Tell the SW (authoritative chats[*].widgets) to drop the id; no-op when
    // the bus is down — panel-hello re-sends every tombstone on reconnect.
    function notifyWorkerRemoved(ids) {
        try {
            if (ids.length && typeof _agentBusPort !== 'undefined' && _agentBusPort) _agentBusPort.postMessage({ type: 'widget-remove', widgetIds: ids });
        } catch (e) { console.warn('Widget delete: worker notify failed', e); }
    }
    // Retained revisions per widget. Older ones are pruned on commit inside the
    // same transaction; the latest version is always the last element and is
    // never pruned. Unbounded histories stored every saved HTML forever.
    var MAX_WIDGET_VERSIONS = 25;
    // Cheap content fingerprint (FNV-1a 32-bit x2 seeds over the snapshot JSON).
    // Legacy rows stored the full JSON string as the fingerprint — a second copy
    // of the HTML per version — so hashes start with 'h' to stay distinguishable.
    function fingerprintOf(payload) {
        var str = JSON.stringify(payload);
        function fnv32(seed) {
            var h = (0x811c9dc5 ^ seed) >>> 0;
            for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
            return ('00000000' + h.toString(16)).slice(-8);
        }
        return 'h' + fnv32(0) + fnv32(0x9e3779b9) + str.length.toString(16);
    }
    function sameContent(version, fingerprint, payload) {
        if (version.fingerprint === fingerprint) return true;
        // Legacy JSON fingerprint: compare against the snapshot JSON directly.
        return typeof version.fingerprint === 'string' && version.fingerprint.charAt(0) === '{' && version.fingerprint === JSON.stringify(payload);
    }
    // Boot cache: keep every version's metadata (picker, dedupe, counters) but
    // drop non-latest HTML from RAM. read(id) rehydrates the full record from
    // IDB on demand (tools and the version picker do that before using html).
    // Never persisted: transact() always mutates the row it just read from IDB.
    function compactForBoot(record) {
        for (var i = 0; i < record.versions.length - 1; i++) {
            if (typeof record.versions[i].html !== 'string') continue;
            var v = Object.assign({}, record.versions[i]);
            delete v.html;
            v.htmlEvicted = true;
            record.versions[i] = v;
        }
        return record;
    }
    function view(id, version) {
        var r = records[id];
        if (!r) return null;
        var v = version ? r.versions.find(function(v) { return v.version === Number(version); }) : latest(r);
        return v ? Object.assign({}, r.origin, v, { id: id, contentVersion: v.version, latestVersion: latest(r).version }) : null;
    }
    function transact(id, mutate) {
        return openDatabase().then(function(database) {
            return new Promise(function(resolve, reject) {
                var tx = database.transaction([widgetStoreName], 'readwrite');
                var store = tx.objectStore(widgetStoreName), outcome;
                var request = store.get(id);
                request.onsuccess = function() {
                    try {
                        outcome = mutate(request.result || null);
                        if (outcome.record) store.put(outcome.record);
                    } catch (e) { outcome = { error: e }; tx.abort(); }
                };
                tx.oncomplete = function() {
                    if (outcome.record) records[id] = outcome.record;
                    resolve(outcome.result);
                };
                tx.onabort = tx.onerror = function() { reject(outcome && outcome.error || tx.error || new Error('Widget transaction failed')); };
            });
        });
    }
    // Readonly point read; refreshes the cache with the full (uncompacted) row.
    function fetchRecord(id) {
        return openDatabase().then(function(database) {
            return new Promise(function(resolve, reject) {
                var tx = database.transaction([widgetStoreName], 'readonly'), row = null;
                var request = tx.objectStore(widgetStoreName).get(id);
                request.onsuccess = function() { row = request.result || null; };
                tx.oncomplete = function() { if (row) records[id] = row; resolve(row); };
                tx.onabort = tx.onerror = function() { reject(tx.error || new Error('Widget read failed')); };
            });
        });
    }
    // gen: the legacy pass generation (migrateLegacy only). A clearCache()
    // since the pass started orphans it: nothing collected before the reset
    // is written into the cleared store.
    function migrate(candidates, gen) {
        return candidates.reduce(function(chain, group) {
            return chain.then(function() { return transact(group.id, function(existing) {
                if (gen !== undefined && gen !== legacyGen) return { result: null };
                // Deleted after the candidates were collected (remove() landing
                // mid deferred pass / mid read(), in this tab or in another one
                // whose notice never arrived, or still in flight with the row
                // present): the tombstone wins, so the widget is never written
                // back or re-cached.
                if (tombstonedNow(group.id)) return { result: null };
                if (existing) return { record: existing, result: existing };
                var versions = [], seen = new Set(), maxVersion = 0;
                group.items.forEach(function(w) {
                    maxVersion = Math.max(maxVersion, Number(w.contentVersion) || 0);
                    var entries = (w.history || []).concat([w]);
                    entries.forEach(function(entry) {
                        var data = snapshot(Object.assign({}, w, entry));
                        var key = JSON.stringify(data);
                        // Only identical snapshots of THIS exact legacy ID collapse.
                        if (seen.has(key)) return;
                        seen.add(key);
                        versions.push(Object.assign(data, { version: versions.length + 1,
                            createdAt: entry.timestamp || entry.updatedAt || entry.createdAt || Date.now(), source: 'migration' }));
                    });
                });
                if (!versions.length) return { result: null };
                // Preserve every distinct candidate, but pick a deterministic HEAD:
                // highest legacy counter, then timestamp, then dashboard on a tie.
                var head = group.items.slice().sort(function(a, b) {
                    return (Number(a.contentVersion) || 0) - (Number(b.contentVersion) || 0)
                        || (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0);
                }).pop();
                var headKey = JSON.stringify(snapshot(head));
                var headIndex = versions.findIndex(function(v) { return JSON.stringify(snapshot(v)) === headKey; });
                if (headIndex >= 0) versions.push(versions.splice(headIndex, 1)[0]);
                versions.forEach(function(v, i) { v.version = i + 1; });
                // Existing screenshot/mirror version counters must never go backwards.
                versions[versions.length - 1].version = Math.max(versions.length, maxVersion);
                var first = group.items[0];
                var record = { id: group.id, origin: { chatId: first.chatId, msgIndex: first.msgIndex, createdAt: first.createdAt }, versions: versions };
                return { record: record, result: record };
            }); });
        }, Promise.resolve());
    }
    // BOOT-MEM: legacy chat `widgets` projections come from the page's
    // in-memory `chats` map, NOT from a cursor over the chats store, which
    // deserialised every full chat record (+1.2-1.4 GB heap on big
    // histories) on every boot just to find ids add() then skipped.
    // loadChatsFromStorage (ui/070) keeps only chats with messages.length > 0
    // (stripChatPayloadsInPlace, core/130, never touches `widgets`), so the
    // legacy widgets of a chat with NO messages are not migrated (a dashboard
    // row for the same id still is). Never read `messages` here: cold chats
    // may drop them after load but keep `widgets`. The map must be FULLY loaded:
    //  - chat load settled + hydrated -> scan inline (part of `ready`);
    //  - chat load in flight (_chatsLoadInFlight, e.g. boot deadline hit) ->
    //    defer the scan until it settles; boot never waits for it, so list()
    //    omits not-yet-migrated legacy ids until the deferred pass finishes;
    //  - chat load failed (_chatsHydrated false) -> skip; next init() retries.
    // Chats are visited by ascending id (= the old cursor's key order), so the
    // origin.chatId of an id shared by several chats is unchanged.
    // legacyGen: bumped by clearCache(); a pass started under an older value
    // is orphaned (writes nothing, leaves the legacy flags to the new pass).
    var legacyDone = false, legacyDeferred = null, legacyDashRows = [], legacyGen = 0;
    function chatsReady() { return typeof _chatsHydrated === 'undefined' || _chatsHydrated === true; }
    function migrateLegacy(gen) {
        if (gen !== legacyGen || !chatsReady()) return Promise.resolve(null);
        var groups = Object.create(null);
        function add(w, chatId) {
            if (!w || !w.id || records[w.id] || isTombstoned(w.id)) return;
            if (!groups[w.id]) groups[w.id] = { id: w.id, items: [] };
            groups[w.id].items.push(Object.assign({}, w, { chatId: w.chatId || chatId }));
        }
        // Same candidate order as before: chat projections, then dashboard rows.
        Object.keys(chats).sort().forEach(function(cid) {
            var c = chats[cid];
            if (c && Array.isArray(c.widgets)) c.widgets.forEach(function(w) { add(w, cid); });
        });
        legacyDashRows.forEach(function(w) { add(w, w.chatId); });
        var list = Object.values(groups);
        return migrate(list, gen).then(function() {
            if (gen !== legacyGen) return null;
            legacyDone = true;
            // The getAll copy (history HTML included) is only needed until a
            // pass completes; skipped/failed passes keep it for the retry.
            legacyDashRows = [];
            return list.map(function(g) { return g.id; });
        });
    }
    function scheduleLegacy() {
        if (legacyDone || legacyDeferred) return Promise.resolve();
        var gen = legacyGen;
        var inflight = typeof _chatsLoadInFlight !== 'undefined' ? _chatsLoadInFlight : null;
        if (!inflight) return migrateLegacy(gen);
        legacyDeferred = Promise.resolve(inflight).catch(function() {}).then(function() { return migrateLegacy(gen); })
            .then(function(ids) { (ids || []).forEach(project); }, function(e) { console.warn('Legacy widget migration failed', e); })
            .then(function() { if (gen === legacyGen) legacyDeferred = null; });
        return Promise.resolve();
    }
    async function load() {
        legacyDone = false;
        var database = await openDatabase();
        var data = await new Promise(function(resolve, reject) {
            var tx = database.transaction([widgetStoreName, dashboardWidgetsStoreName], 'readonly');
            var result = {};
            [widgetStoreName, dashboardWidgetsStoreName].forEach(function(name) {
                var req = tx.objectStore(name).getAll();
                req.onsuccess = function() { result[name] = req.result || []; };
            });
            tx.oncomplete = function() { resolve(result); };
            tx.onerror = tx.onabort = function() { reject(tx.error || new Error('Widget load failed')); };
        });
        data[widgetStoreName].forEach(function(r) { records[r.id] = compactForBoot(r); });
        // Dashboard placement rows keep their legacy history[] in memory:
        // saveDashboardWidgetImpl persists the whole in-memory row, so
        // stripping it here would silently drop it from IDB on the next save.
        legacyDashRows = data[dashboardWidgetsStoreName];
        data = null;
        await scheduleLegacy();
    }
    function init() {
        if (!ready) ready = load().catch(function(e) { ready = null; throw e; });
        // Retry a skipped/failed legacy pass (chat load failed earlier) and
        // project what it migrated, like the deferred path does.
        return ready.then(function() {
            if (!legacyDone && !legacyDeferred) return scheduleLegacy().then(function(ids) { (ids || []).forEach(project); })
                .catch(function(e) { console.warn('Legacy widget migration failed', e); });
        });
    }
    async function read(id) {
        await init();
        var record = await fetchRecord(id);
        // Fresh check: a stale tab must not re-migrate a widget another tab
        // deleted (migrate() re-checks inside its transaction as well).
        if (!record && !tombstonedNow(id)) {
            var items = [];
            Object.keys(chats).forEach(function(cid) { (chats[cid].widgets || []).forEach(function(w) { if (w.id === id) items.push(Object.assign({}, w, { chatId: w.chatId || cid })); }); });
            if (dashboardWidgets[id]) items.push(dashboardWidgets[id]);
            if (items.length) {
                await migrate([{ id: id, items: items }]);
                record = await fetchRecord(id);
            }
        }
        return record;
    }
    async function commit(id, data, expectedVersion, operationId, origin) {
        await init();
        var payload = snapshot(data), fingerprint = fingerprintOf(payload);
        var result = await transact(id, function(record) {
            // Delete is permanent (no undo): a replayed create (same
            // operation-derived id, expected_version 0), an edit, or a save
            // racing remove() never resurrects the id, from any tab. Only
            // importRecords() revives a deleted id.
            if (tombstonedNow(id)) return { result: { success: false, code: 'WIDGET_DELETED', error: 'Widget was deleted and cannot be saved again: ' + id + '. Create a new widget instead (with a new operation_id: reusing this one derives the same deleted id).' } };
            if (record) {
                var retry = record.versions.find(function(v) { return v.operationId === operationId; });
                if (retry) return { record: record, result: sameContent(retry, fingerprint, payload)
                    ? { success: true, id: id, version: retry.version, latest_version: latest(record).version, deduplicated: true }
                    : { success: false, code: 'OPERATION_CONFLICT', error: 'operation_id was already used with different content' } };
                if (expectedVersion !== latest(record).version) return { record: record, result: { success: false, code: 'VERSION_CONFLICT', error: 'Read the latest widget, reconcile changes, then retry with expected_version.', latest_version: latest(record).version } };
            } else if (expectedVersion !== 0) {
                return { result: { success: false, code: 'WIDGET_NOT_FOUND', error: 'Widget not found: ' + id } };
            }
            record = record || { id: id, origin: origin || {}, versions: [] };
            var version = record.versions.length ? latest(record).version + 1 : 1;
            record.versions.push(Object.assign(payload, { version: version, createdAt: Date.now(), operationId: operationId, fingerprint: fingerprint, source: 'save' }));
            // Lazy migration: legacy JSON fingerprints (full HTML copy) → hash.
            record.versions.forEach(function(v) {
                if (typeof v.fingerprint === 'string' && v.fingerprint.charAt(0) === '{') v.fingerprint = fingerprintOf(JSON.parse(v.fingerprint));
            });
            if (record.versions.length > MAX_WIDGET_VERSIONS) record.versions.splice(0, record.versions.length - MAX_WIDGET_VERSIONS);
            return { record: record, result: { success: true, id: id, version: version, latest_version: version } };
        });
        if (result.success) {
            if (channel) channel.postMessage({ id: id });
            project(id);
        }
        return result;
    }
    function project(id) {
        var w = view(id);
        if (!w) return;
        Object.keys(chats).forEach(function(cid) {
            var c = chats[cid];
            if (!Array.isArray(c.widgets)) return;
            var seen = false;
            c.widgets = c.widgets.filter(function(old) { if (old.id !== id) return true; if (seen) return false; seen = true; return true; });
            c.widgets = c.widgets.map(function(old) { return old.id === id ? Object.assign({}, old, w, { msgIndex: old.msgIndex, chatId: old.chatId || cid }) : old; });
            chatWidgets[cid] = c.widgets;
        });
        if (dashboardWidgets[id]) {
            // Placement dimensions are numeric grid spans, not saved CSS dimensions.
            ['html', 'title', 'contentVersion', 'updatedAt'].forEach(function(k) { dashboardWidgets[id][k] = w[k]; });
        }
        if (typeof refreshWidgetVersionViews === 'function') refreshWidgetVersionViews(id);
        if (typeof refreshWidgetLibraryEntry === 'function') refreshWidgetLibraryEntry(id);
    }
    // Drop every in-memory trace of a deleted widget: cache, chat/sidebar
    // projections (so read() cannot re-migrate it), placement, live frames.
    function forget(id) {
        delete records[id];
        var touchedChats = false;
        Object.keys(chats).forEach(function(cid) {
            var c = chats[cid];
            if (Array.isArray(c.widgets) && c.widgets.some(function(w) { return w.id === id; })) {
                c.widgets = c.widgets.filter(function(w) { return w.id !== id; });
                touchedChats = true;
            }
            if (Array.isArray(chatWidgets[cid])) chatWidgets[cid] = chatWidgets[cid].filter(function(w) { return w.id !== id; });
        });
        widgetVersionFrames().forEach(function(iframe) {
            if (iframe.dataset.savedWidgetId !== id) return;
            if (iframe.__widgetCleanup) { try { iframe.__widgetCleanup(); } catch (e) {} }
            if (iframe.__versionPicker) iframe.__versionPicker.remove();
            iframe.remove();
        });
        if (typeof refreshWidgetLibraryEntry === 'function') refreshWidgetLibraryEntry(id);
        return touchedChats;
    }
    // Permanent delete of a saved widget: IDB 'widgets' row, dashboard placement
    // (removeWidgetFromDashboard -> deleteDashboardWidget + grid DOM), chat
    // projections (persisted via saveChatsToStorage) and other tabs (channel).
    // Write-site ratchet (RFC Flux Phase 1): the objectStore.delete and
    // saveChatsToStorage sites below are intentional and baselined for this
    // file in build/write-site-ratchet.json — Phase 1 has no sanctioned
    // widget-row delete helper (deleteChatRow is chats-only) and the chat
    // `widgets` projection is not a chat-meta lane field (dispatchChatMeta),
    // so the row persister is the only path, same as tools/080-widget-tools.js.
    async function remove(id) {
        await init();
        // Tombstone BEFORE the delete commits: a concurrent read() can't remigrate.
        setTombstone(id, true);
        var database = await openDatabase();
        try {
            await new Promise(function(resolve, reject) {
                var tx = database.transaction([widgetStoreName], 'readwrite');
                tx.objectStore(widgetStoreName).delete(id);
                tx.oncomplete = function() { resolve(); };
                tx.onerror = tx.onabort = function() { reject(tx.error || new Error('Widget delete failed')); };
            });
        } catch (e) { setTombstone(id, false); throw e; }
        if (dashboardWidgets[id]) {
            if (typeof removeWidgetFromDashboard === 'function') await removeWidgetFromDashboard(id);
            else await deleteDashboardWidget(id);
        }
        // SW first: its chats[*].widgets snapshot is authoritative for membership.
        notifyWorkerRemoved([id]);
        var touchedChats = forget(id);
        if (touchedChats && typeof saveChatsToStorage === 'function') {
            try { await saveChatsToStorage(); } catch (e) { console.warn('Widget delete: chat projection save failed', e); }
        }
        if (channel) channel.postMessage({ removed: id });
        return { success: true, id: id };
    }
    if (channel) channel.onmessage = function(event) {
        if (!event.data) return;
        tombstones = readTombstones();
        if (event.data.reset) { clearCache(false); return; }
        if (event.data.removed) { forget(event.data.removed); return; }
        if (event.data.reload) {
            records = Object.create(null); ready = null;
            init().then(function() { Object.keys(records).forEach(project); }).catch(function(e) { console.error('Widget reload failed', e); });
            return;
        }
        if (!event.data.id) return;
        read(event.data.id).then(function() { project(event.data.id); }).catch(function(e) { console.error('Widget version refresh failed', e); });
    };
    async function exportRecords() {
        await init();
        var database = await openDatabase();
        return new Promise(function(resolve, reject) {
            var tx = database.transaction([widgetStoreName], 'readonly'), rows;
            var req = tx.objectStore(widgetStoreName).getAll();
            req.onsuccess = function() { rows = req.result || []; };
            tx.oncomplete = function() { resolve(rows); };
            tx.onerror = tx.onabort = function() { reject(tx.error || new Error('Widget export failed')); };
        });
    }
    function validateRecords(rows) {
        if (!Array.isArray(rows)) throw new Error('Invalid widget backup');
        var ids = new Set();
        rows.forEach(function(r) {
            if (!r || typeof r.id !== 'string' || !/^widget_[a-zA-Z0-9_-]+$/.test(r.id) || ids.has(r.id) || !Array.isArray(r.versions) || !r.versions.length) throw new Error('Invalid widget backup record');
            ids.add(r.id);
            var previous = 0;
            r.versions.forEach(function(v) {
                if (!v || !Number.isInteger(v.version) || v.version <= previous || typeof v.html !== 'string' || typeof v.title !== 'string') throw new Error('Invalid widget backup revision');
                previous = v.version;
            });
        });
    }
    // All imported stores share the conflict-check transaction. A late conflict,
    // clone failure or quota abort rolls back chats/settings/placements as well.
    async function importRecords(rows, otherStores) {
        validateRecords(rows);
        otherStores = otherStores || {};
        var database = await openDatabase();
        await new Promise(function(resolve, reject) {
            var names = [widgetStoreName].concat(Object.keys(otherStores));
            var tx = database.transaction(names, 'readwrite'), failure;
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = function() { reject(failure || tx.error || new Error('Widget import failed')); };
            var store = tx.objectStore(widgetStoreName);
            try {
                rows.forEach(function(row) {
                    var req = store.get(row.id);
                    req.onsuccess = function() {
                        try {
                            var old = req.result;
                            if (old) {
                                var short = old.versions.length < row.versions.length ? old : row;
                                var long = short === old ? row : old;
                                // Match by version number, not index: pruned histories
                                // (MAX_WIDGET_VERSIONS) drop the oldest rows, so an older
                                // full backup must still be recognised as compatible.
                                var byVersion = Object.create(null);
                                long.versions.forEach(function(v) { byVersion[v.version] = v; });
                                var compatible = short.versions.every(function(v) {
                                    var other = byVersion[v.version];
                                    return !other || JSON.stringify(snapshot(other)) === JSON.stringify(snapshot(v));
                                });
                                if (!compatible) throw new Error('Widget backup conflicts with retained history: ' + row.id);
                                // Keep whichever history has the newer HEAD, not the longer one:
                                // a pruned live row (25 versions, head v34) must not be replaced
                                // by a longer pre-cap backup whose head is older (v30).
                                if (latest(old).version >= latest(row).version) return;
                            }
                            store.put(row);
                        } catch (e) { failure = e; tx.abort(); }
                    };
                });
                Object.keys(otherStores).forEach(function(name) {
                    otherStores[name].forEach(function(row) { tx.objectStore(name).put(row); });
                });
            } catch (e) { failure = e; tx.abort(); }
        });
        rows.forEach(function(row) { setTombstone(row.id, false); });
        records = Object.create(null);
        ready = null;
        await init();
        Object.keys(records).forEach(project);
        if (channel) channel.postMessage({ reload: true });
    }
    function clearCache(broadcast) {
        records = Object.create(null);
        ready = null;
        // Orphan a pending deferred legacy pass (its pre-reset dashboard rows
        // must not be written back into the cleared store) and let the next
        // init() schedule a fresh one. Re-read the tombstones too: another
        // tab's delete may be missing from this copy.
        legacyGen++;
        legacyDone = false;
        legacyDeferred = null;
        legacyDashRows = [];
        tombstones = readTombstones();
        // Drop compatibility projections too: read() must not remigrate deleted
        // widgets from a still-open panel after a successful full reset.
        Object.keys(chats).forEach(function(cid) {
            var c = chats[cid];
            if (c.widgets) c.widgets = [];
        });
        Object.keys(chatWidgets).forEach(function(cid) { delete chatWidgets[cid]; });
        Object.keys(dashboardWidgets).forEach(function(id) { delete dashboardWidgets[id]; });
        widgetVersionFrames().forEach(function(iframe) {
            if (iframe.__widgetCleanup) iframe.__widgetCleanup();
            if (iframe.__versionPicker) iframe.__versionPicker.remove();
            iframe.remove();
        });
        if (broadcast && channel) channel.postMessage({ reset: true });
    }
    return { init: init, read: read, commit: commit, view: view, project: project, remove: remove,
        isDeleted: function(id) { return isTombstoned(id); },
        resendDeletes: function() { tombstones = readTombstones(); notifyWorkerRemoved(tombstones.slice()); }, migrate: migrate, exportRecords: exportRecords, importRecords: importRecords, validateRecords: validateRecords, clearCache: clearCache,
        list: function() { return Object.values(records).map(function(r) { return { id: r.id, title: latest(r).title, latest_version: latest(r).version, versions: r.versions.length }; }); },
        versions: function(id) { return records[id] ? records[id].versions.map(function(v) { return { version: v.version, createdAt: v.createdAt, source: v.source }; }) : []; } };
})();

// Only explicit, durable widget intent supplies an omitted target. A new distinct
// artifact remains possible via create_new; never infer equivalence by title/HTML.
function widgetEditTarget(chat) {
    var messages = chat && chat.messages || [];
    for (var i = messages.length - 1; i >= 0; i--) {
        // Assistant/tool/attachment rows belong to the same request, but an
        // ordinary user turn ends earlier widget intent. Never replay old intent.
        if (messages[i].role === 'user') return messages[i].isWidgetRequest && messages[i].widgetId || null;
    }
    return null;
}

// Composer intent is one-shot UI state, not a permanent chat field. If the
// user replaces the prefill, the ordinary request must not edit that widget.
function consumeWidgetComposerTarget(input, message) {
    var id = input.dataset.widgetEditTarget;
    delete input.dataset.widgetEditTarget;
    return id && message.indexOf('Edit widget ' + id + ':') === 0 ? id : null;
}

async function widgetOperationId(args, options) {
    var id = args.operation_id || options && options.toolCallId;
    return String(options && options.chatId || currentChatId || 'widget') + ':' + (id || crypto.randomUUID());
}
async function widgetIdForOperation(operationId) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationId));
    return 'widget_' + Array.from(new Uint8Array(digest)).map(function(n) { return n.toString(16).padStart(2, '0'); }).join('');
}

// All durable HTML writers use this; widget_eval deliberately does not.
async function saveWidgetRevision(widget, html, expectedVersion, operationId) {
    var result = await WidgetStore.commit(widget.id, Object.assign({}, widget, { html: html }), expectedVersion, operationId);
    if (!result.success) return result;
    var saved = WidgetStore.view(widget.id);
    try {
        if (typeof _agentBusPort !== 'undefined' && _agentBusPort && saved.chatId) {
            _agentBusPort.postMessage({ type: 'widget-persist', chatId: saved.chatId, widget: saved });
        }
    } catch (e) { console.warn('Widget mirror unavailable; canonical revision is committed', e); }
    return Object.assign(result, { widget_id: saved.id, widgetId: saved.id, _widget_persist: saved });
}

// PER-TURN RENDERS: every agent save renders inline in the ISSUING chat at the
// turn of that save (even for a widget owned by another chat), pinned to the
// version that save produced. chat.widgetRenders holds REFS only, keyed
// `<toolCallId>:<widgetId>` (several saves in one tool call collapse to the
// last); the HTML stays in WidgetStore. `_toggledAt` lets the shared per-id
// union (_unionChatDisplaysForPut) keep the newest ref across stale snapshots.
// Saves without a tool call (code editor, widget bridge) record nothing: they
// own no turn. The SW mirrors the returned ref (worker/120-tool-routing.js).
function recordWidgetRender(chatId, widgetId, version, options) {
    options = options || {};
    var chat = typeof chats !== 'undefined' ? chats[chatId] : null;
    var toolCallId = (options.fromSandbox && options.parentToolCallId) ? options.parentToolCallId : options.toolCallId;
    if (!chat || !widgetId || !toolCallId || !Number.isInteger(Number(version)) || !Number(version)) return null;
    var msgIndex = -1, messages = Array.isArray(chat.messages) ? chat.messages : [];
    for (var i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === 'tool' && messages[i].tool_call_id === toolCallId) { msgIndex = i; break; }
    }
    if (msgIndex === -1) msgIndex = Number.isInteger(options.msgIndex) && options.msgIndex >= 0 ? options.msgIndex : messages.length;
    var ref = { id: widgetId, version: Number(version), msgIndex: msgIndex, toolCallId: toolCallId, _toggledAt: Date.now() };
    if (!chat.widgetRenders) chat.widgetRenders = {};
    chat.widgetRenders[toolCallId + ':' + widgetId] = ref;
    delete chat.isTemporary;
    return Object.assign({ key: toolCallId + ':' + widgetId }, ref);
}
// User-facing (translated) text for a failed saveWidgetRevision result, for
// the code editor's snackbar. result.error stays English: it is the tool
// result the model reads.
function widgetSaveErrorText(result) {
    var code = result && result.code;
    if (code === 'WIDGET_DELETED') return t('This widget was deleted and cannot be saved again.');
    if (code === 'VERSION_CONFLICT') return t('This widget changed since the editor opened. Reopen the editor and try again.');
    return t('Widget save failed: {error}', { error: (result && result.error) || t('unknown error') });
}

// Mount-local history selection: nothing is written when viewing a revision.
// Rewriting a saved version invalidates the old widget_eval instance through the
// existing cleanup/registration lifecycle. Latest views follow committed saves.
function attachWidgetVersionPicker(iframe, widgetId) {
    var versions = WidgetStore.versions(widgetId);
    if (!versions.length || !iframe.parentNode) return;
    iframe.dataset.savedWidgetId = widgetId;
    iframe.dataset.savedWidgetVersion = String((WidgetStore.view(widgetId, iframe.dataset.selectedWidgetVersion) || {}).contentVersion || '');
    // Previews (scaled thumbnails) are non-interactive: no picker.
    if (iframe.__versionPreview) return;
    var picker = iframe.__versionPicker;
    if (!picker) {
        var slot = widgetVersionSlot(iframe);
        if (!slot) return;
        picker = document.createElement('select');
        picker.className = 'widget-version-picker';
        picker.setAttribute('aria-label', t('Widget version'));
        picker.title = t('Widget version');
        slot.insertBefore(picker, slot.firstChild);
        iframe.__versionPicker = picker;
        picker.addEventListener('change', function() { selectWidgetRenderVersion(iframe, picker.value); });
        // Header clicks/drags (dashboard card drag, thumbnail open) must not fire.
        ['click', 'mousedown'].forEach(function(type) { picker.addEventListener(type, function(e) { if (e && e.stopPropagation) e.stopPropagation(); }); });
    }
    picker.replaceChildren();
    var latest = document.createElement('option');
    latest.value = ''; latest.textContent = t('Latest (v{version})', { version: versions[versions.length - 1].version }); picker.appendChild(latest);
    versions.slice().reverse().forEach(function(v) {
        var option = document.createElement('option'); option.value = String(v.version);
        option.textContent = t('v{version} · {date}', { version: v.version, date: i18nFormatDateTime(new Date(v.createdAt)) }); picker.appendChild(option);
    });
    picker.value = iframe.dataset.selectedWidgetVersion || '';
    updateWidgetVersionBadge(iframe, widgetId, versions[versions.length - 1].version);
}
// Pinned per-turn render badge: "vN (latest)" or "vN · latest is vM" plus a
// per-view "Show latest" (mount-local, nothing persisted). Only renders
// pinned by a per-turn ref (dataset.pinnedWidgetVersion) get one; legacy
// follow-latest renders, dashboard cards and previews never do.
function updateWidgetVersionBadge(iframe, widgetId, latestVersion) {
    var badge = iframe.__versionBadge;
    if (!iframe.dataset.pinnedWidgetVersion) { if (badge) badge.remove(); iframe.__versionBadge = null; return; }
    if (!badge) {
        var slot = iframe.__versionPicker && iframe.__versionPicker.parentNode;
        if (!slot) return;
        badge = document.createElement('span');
        badge.className = 'widget-version-badge';
        slot.insertBefore(badge, iframe.__versionPicker);
        iframe.__versionBadge = badge;
        ['click', 'mousedown'].forEach(function(type) { badge.addEventListener(type, function(e) { if (e && e.stopPropagation) e.stopPropagation(); }); });
    }
    var shown = Number(iframe.dataset.selectedWidgetVersion) || latestVersion;
    badge.replaceChildren();
    var label = document.createElement('span');
    label.className = 'widget-version-badge-label';
    badge.appendChild(label);
    if (shown === latestVersion) {
        badge.classList.remove('is-stale');
        label.textContent = t('v{version} (latest)', { version: shown });
        return;
    }
    badge.classList.add('is-stale');
    label.textContent = t('v{version} · latest is v{latest}', { version: shown, latest: latestVersion });
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'widget-version-show-latest';
    btn.textContent = t('Show latest');
    btn.addEventListener('click', function() { selectWidgetRenderVersion(iframe, ''); });
    badge.appendChild(btn);
}
function selectWidgetRenderVersion(iframe, version, hydrated) {
    var id = iframe.dataset.savedWidgetId;
    var saved = WidgetStore.view(id, version);
    if (!saved || !iframe.parentNode) return;
    // Non-latest HTML is evicted from the boot cache; pull the full row once.
    if (typeof saved.html !== 'string' && !hydrated) {
        WidgetStore.read(id).then(function() { selectWidgetRenderVersion(iframe, version, true); })
            .catch(function(e) { console.error('Widget version load failed', e); });
        return;
    }
    // Replace the render, not the saved widget. Preserve surface dimensions.
    var fresh = iframe.cloneNode(false);
    fresh.removeAttribute('src');
    fresh.dataset.selectedWidgetVersion = version || '';
    fresh.__versionSuffix = iframe.__versionSuffix || '';
    fresh.__versionFullscreen = iframe.__versionFullscreen;
    fresh.__versionPreview = iframe.__versionPreview;
    if (iframe.__widgetCleanup) iframe.__widgetCleanup();
    if (iframe.__versionPicker) iframe.__versionPicker.remove();
    if (iframe.__versionBadge) iframe.__versionBadge.remove();
    iframe.replaceWith(fresh);
    var html = injectWidgetBridge(saved.html, saved.title, id);
    if (fresh.__versionSuffix) html = _appendWidgetScript(html, fresh.__versionSuffix);
    writeWidgetHtml(fresh, html, id);
    if (fresh.__versionSuffix) bindWidgetVersionResize(fresh, saved, fresh.__versionFullscreen);
}
// The dashboard mounts in open shadow roots (.widget-shadow-host, the only
// attachShadow site — ui/070-dashboard-ui.js renderWidgetContent); document
// selectors alone miss it. Query hosts directly instead of walking every node.
function widgetVersionFrames(root) {
    if (!root) root = typeof document === 'undefined' ? null : document;
    if (!root) return [];
    var frames = Array.from(root.querySelectorAll('iframe[data-saved-widget-id]'));
    root.querySelectorAll('.widget-shadow-host').forEach(function(host) {
        if (host.shadowRoot) frames = frames.concat(Array.from(host.shadowRoot.querySelectorAll('iframe[data-saved-widget-id]')));
    });
    return frames;
}
function refreshWidgetVersionViews(widgetId) {
    widgetVersionFrames().forEach(function(iframe) {
        if (iframe.dataset.savedWidgetId !== widgetId) return;
        if (iframe.dataset.selectedWidgetVersion) { attachWidgetVersionPicker(iframe, widgetId); return; }
        var latest = WidgetStore.view(widgetId);
        if (latest && iframe.dataset.savedWidgetVersion !== String(latest.contentVersion)) selectWidgetRenderVersion(iframe, '');
        else attachWidgetVersionPicker(iframe, widgetId);
    });
}

// The picker lives in the surface's HEADER button group, never as a row in the
// content. Scope = the card/modal that owns both the header and the mount
// (.widget-inline chat card, .widget-modal, .widget-fullscreen-modal chat +
// dashboard expand, .dashboard-widget main card whose header is display:none,
// so the picker hides with it). Headerless mounts (home cards, deep-link tab /
// side panel, bare containers) find no slot and get NO picker. Walks out of
// open shadow roots (dashboard cards mount the iframe in .widget-shadow-host).
var WIDGET_VERSION_SCOPE = '.widget-inline, .widget-modal, .widget-fullscreen-modal, .dashboard-widget';
var WIDGET_VERSION_SLOT = '.widget-controls, .widget-modal-controls, .dashboard-widget-controls';
function widgetVersionSlot(iframe) {
    var node = iframe;
    while (node) {
        var scope = node.closest ? node.closest(WIDGET_VERSION_SCOPE) : null;
        if (scope) return scope.querySelector(WIDGET_VERSION_SLOT);
        var root = node.getRootNode ? node.getRootNode() : null;
        node = root && root.host ? root.host : null;
    }
    return null;
}

// Chat sidebar widget list (renderWidgetSidebar in tools/080-widget-tools.js
// and the Widgets section of the version panel in ui/120-ui-utils.js): ONLY
// the current chat's widgets. getWidgetsForChat already merges the chat's
// projection with saved WidgetStore records whose chatId matches. Every OTHER
// saved widget (other chats, orphans whose chat was deleted, unpinned) is
// browsable from the dashboard page's Widget Library (ui/065-widget-library.js)
// — do NOT append WidgetStore.list() here, that made every chat's sidebar show
// every widget in the store.
function getSidebarWidgets() {
    return getWidgetsForChat(currentChatId);
}
