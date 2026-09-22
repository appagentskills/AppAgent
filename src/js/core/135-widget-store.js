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
    function migrate(candidates) {
        return candidates.reduce(function(chain, group) {
            return chain.then(function() { return transact(group.id, function(existing) {
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
    async function load() {
        var database = await openDatabase();
        var data = await new Promise(function(resolve, reject) {
            var tx = database.transaction([widgetStoreName, chatStoreName, dashboardWidgetsStoreName], 'readonly');
            var result = {};
            [widgetStoreName, chatStoreName, dashboardWidgetsStoreName].forEach(function(name) {
                var req = tx.objectStore(name).getAll();
                req.onsuccess = function() { result[name] = req.result || []; };
            });
            tx.oncomplete = function() { resolve(result); };
            tx.onerror = tx.onabort = function() { reject(tx.error || new Error('Widget load failed')); };
        });
        data[widgetStoreName].forEach(function(r) { records[r.id] = compactForBoot(r); });
        var groups = Object.create(null);
        function add(w, chatId) {
            if (!w || !w.id || records[w.id]) return;
            if (!groups[w.id]) groups[w.id] = { id: w.id, items: [] };
            groups[w.id].items.push(Object.assign({}, w, { chatId: w.chatId || chatId }));
        }
        data[chatStoreName].forEach(function(c) { (c.widgets || []).forEach(function(w) { add(w, c.id); }); });
        data[dashboardWidgetsStoreName].forEach(function(w) { add(w, w.chatId); });
        await migrate(Object.values(groups));
    }
    function init() {
        if (!ready) ready = load().catch(function(e) { ready = null; throw e; });
        return ready;
    }
    async function read(id) {
        await init();
        var record = await fetchRecord(id);
        if (!record) {
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
        var database = await openDatabase();
        await new Promise(function(resolve, reject) {
            var tx = database.transaction([widgetStoreName], 'readwrite');
            tx.objectStore(widgetStoreName).delete(id);
            tx.oncomplete = function() { resolve(); };
            tx.onerror = tx.onabort = function() { reject(tx.error || new Error('Widget delete failed')); };
        });
        if (dashboardWidgets[id]) {
            if (typeof removeWidgetFromDashboard === 'function') await removeWidgetFromDashboard(id);
            else await deleteDashboardWidget(id);
        }
        var touchedChats = forget(id);
        if (touchedChats && typeof saveChatsToStorage === 'function') {
            try { await saveChatsToStorage(); } catch (e) { console.warn('Widget delete: chat projection save failed', e); }
        }
        if (channel) channel.postMessage({ removed: id });
        return { success: true, id: id };
    }
    if (channel) channel.onmessage = function(event) {
        if (!event.data) return;
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
        records = Object.create(null);
        ready = null;
        await init();
        Object.keys(records).forEach(project);
        if (channel) channel.postMessage({ reload: true });
    }
    function clearCache(broadcast) {
        records = Object.create(null);
        ready = null;
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
    return { init: init, read: read, commit: commit, view: view, project: project, remove: remove, migrate: migrate, exportRecords: exportRecords, importRecords: importRecords, validateRecords: validateRecords, clearCache: clearCache,
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

// Mount-local history selection: nothing is written when viewing a revision.
// Rewriting a saved version invalidates the old widget_eval instance through the
// existing cleanup/registration lifecycle. Latest views follow committed saves.
function attachWidgetVersionPicker(iframe, widgetId) {
    var versions = WidgetStore.versions(widgetId);
    if (!versions.length || !iframe.parentNode) return;
    var root = iframe.getRootNode();
    if (root.host && !root.querySelector('style[data-widget-version-style]')) {
        var style = document.createElement('style');
        style.setAttribute('data-widget-version-style', '');
        style.textContent = ':host{display:flex;flex-direction:column;height:100%} iframe{flex:1;min-height:0} .widget-version-picker{display:block;max-width:100%;margin:4px;padding:3px 6px;font:inherit;font-size:11px;color:var(--text-primary);background:var(--bg-main);border:1px solid var(--border);border-radius:4px;position:relative;z-index:1}';
        root.appendChild(style);
    }
    iframe.dataset.savedWidgetId = widgetId;
    iframe.dataset.savedWidgetVersion = String((WidgetStore.view(widgetId, iframe.dataset.selectedWidgetVersion) || {}).contentVersion || '');
    var picker = iframe.__versionPicker;
    if (!picker) {
        picker = document.createElement('select');
        picker.className = 'widget-version-picker';
        picker.setAttribute('aria-label', 'Widget version');
        iframe.parentNode.insertBefore(picker, iframe);
        iframe.__versionPicker = picker;
        picker.addEventListener('change', function() { selectWidgetRenderVersion(iframe, picker.value); });
    }
    picker.replaceChildren();
    var latest = document.createElement('option');
    latest.value = ''; latest.textContent = 'Latest (v' + versions[versions.length - 1].version + ')'; picker.appendChild(latest);
    versions.slice().reverse().forEach(function(v) {
        var option = document.createElement('option'); option.value = String(v.version);
        option.textContent = 'v' + v.version + ' · ' + new Date(v.createdAt).toLocaleString(); picker.appendChild(option);
    });
    picker.value = iframe.dataset.selectedWidgetVersion || '';
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
    if (iframe.__widgetCleanup) iframe.__widgetCleanup();
    if (iframe.__versionPicker) iframe.__versionPicker.remove();
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
