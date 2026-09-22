// Widget versioning: PRODUCTION WidgetStore / html_widget / edit_html / data-management
// sources against a serialized in-memory IndexedDB adapter (the js_eval sandbox denies
// indexedDB.open with a SecurityError, so the adapter is ALWAYS supplied).
// Run: run_tests { pattern: 'widget-versioning' }   (js_eval sandbox; see test/harness.js)
/* Minimal IndexedDB stand-in for sandboxes where the real API is denied
 * (SecurityError). Serializes transactions per database like IDB does, so the
 * compare-and-set race test still exercises real serialization semantics.
 */
function createMemoryIdb() {
    var dbs = {}, failCommit = false;
    return { failNextCommit: function() { failCommit = true; }, open: function(name) {
        var req = { result: null, error: null };
        var data = dbs[name] || (dbs[name] = { stores: {}, queue: Promise.resolve() });
        var fresh = !Object.keys(data.stores).length;
        req.result = {
            objectStoreNames: { contains: function(n) { return !!data.stores[n]; } },
            createObjectStore: function(n) { data.stores[n] = {}; return {}; },
            transaction: function(names, mode) {
                var tx = { error: null, mode: mode || 'readonly', _ops: [], _aborted: false,
                    abort: function() { this._aborted = true; },
                    objectStore: function(n) {
                        if (!data.stores[n]) throw new Error('unknown store ' + n);
                        return {
                            get: function(key) { var r = {}; tx._ops.push(function() { r.result = data.stores[n][key] ? JSON.parse(JSON.stringify(data.stores[n][key])) : undefined; if (r.onsuccess) r.onsuccess(); }); return r; },
                            getAll: function() { var r = {}; tx._ops.push(function() { r.result = Object.values(data.stores[n]).map(function(v) { return JSON.parse(JSON.stringify(v)); }); if (r.onsuccess) r.onsuccess(); }); return r; },
                            put: function(row) { var r = {}; tx._ops.push(function() { data.stores[n][row.id || row.key || row.name] = JSON.parse(JSON.stringify(row)); if (r.onsuccess) r.onsuccess(); }); return r; },
                            clear: function() { var r = {}; tx._ops.push(function() { data.stores[n] = {}; if (r.onsuccess) r.onsuccess(); }); return r; }
                        };
                    } };
                data.queue = data.queue.then(function() {
                    return new Promise(function(resolve) {
                        setTimeout(function() {
                            var pending = data.stores, backup = JSON.parse(JSON.stringify(pending));
                            for (var i = 0; i < tx._ops.length && !tx._aborted; i++) tx._ops[i]();
                            if (failCommit && tx.mode === 'readwrite') { failCommit = false; tx._aborted = true; tx.error = new Error('Injected commit abort'); }
                            if (tx._aborted) { data.stores = backup; if (tx.onabort) tx.onabort(); }
                            else if (tx.oncomplete) tx.oncomplete();
                            resolve();
                        }, 0);
                    });
                });
                return tx;
            }
        };
        setTimeout(function() {
            if (fresh && req.onupgradeneeded) req.onupgradeneeded();
            if (req.onsuccess) req.onsuccess();
        }, 0);
        return req;
    } };
}
/* Run in the tool sandbox: await runWidgetVersioningTests(sourceMap, indexedDB).
 * Exercises the PRODUCTION WidgetStore / html_widget / edit_html sources against
 * real IndexedDB when available, otherwise the explicitly supplied serialized
 * memory adapter above. Production store/tool code is never re-implemented.
 */
async function runWidgetVersioningTests(sources, idb) {
    idb = idb || createMemoryIdb();
    var passed = [];
    function check(name, value) { if (!value) throw new Error('FAILED: ' + name); passed.push(name); }
    var dbName = 'widget-versioning-test-' + Date.now();
    var stores = { chats: 'chats', dashboardWidgets: 'dashboardWidgets', widgets: 'widgets', settings: 'settings', apiProviders: 'apiProviders', chat_payloads: 'chat_payloads' };
    var chats = {}, chatWidgets = {}, dashboardWidgets = {}, saves = 0, mirrored = [], broadcasts = [], channels = [];
    function openDatabase() {
        return new Promise(function(resolve, reject) {
            var req = idb.open(dbName, 1);
            req.onupgradeneeded = function() {
                Object.values(stores).forEach(function(name) {
                    if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: name === 'settings' ? 'key' : name === 'apiProviders' ? 'name' : 'id' });
                });
            };
            req.onsuccess = function() { resolve(req.result); };
            req.onerror = function() { reject(req.error); };
        });
    }
    function put(store, row) {
        return openDatabase().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction([store], 'readwrite');
                tx.objectStore(store).put(row);
                tx.oncomplete = resolve; tx.onerror = function() { reject(tx.error); };
            });
        });
    }
    // Legacy rows written BEFORE the canonical store exists: one chat widget with
    // capped history and a higher legacy contentVersion, one dashboard-only widget.
    await put('chats', { id: 'chat_a', messages: [], widgets: [{ id: 'widget_legacy', title: 'Legacy', html: '<p>v3</p>', width: '300px', height: '200px', contentVersion: 7, chatId: 'chat_a', msgIndex: 4, history: [{ html: '<p>v1</p>', timestamp: 1 }, { html: '<p>v2</p>', timestamp: 2 }] }] });
    await put('dashboardWidgets', { id: 'widget_dashonly', title: 'Dash', html: '<p>d1</p>', gridX: 2, gridY: 3, width: 4, height: 4, dashboard: 'home' });

    var globals = {
        dbName: dbName, widgetStoreName: stores.widgets, chatStoreName: stores.chats,
        dashboardWidgetsStoreName: stores.dashboardWidgets, openDatabase: openDatabase,
        chats: chats, chatWidgets: chatWidgets, dashboardWidgets: dashboardWidgets,
        currentChatId: 'chat_a', activeStreamingChatId: null, crypto: crypto,
        BroadcastChannel: function() { this.postMessage = function(value) { broadcasts.push(value); }; channels.push(this); }, chrome: undefined, document: undefined,
        _agentBusPort: { postMessage: function(m) { mirrored.push(m); } },
        saveChatsToStorage: function() { saves++; return Promise.resolve(); },
        ensureChatPayloads: function() { return Promise.resolve(); },
        consumePendingWidgetRegeneration: function() { return null; },
        renderWidgetSidebar: function() {}, addWidgetToDashboard: function() {},
        refreshWidgetVersionViews: function() {}, saveDashboardWidget: function() {},
        applySearchReplaceEdits: function(html, edits) {
            var out = html, applied = [];
            for (var i = 0; i < edits.length; i++) {
                if (out.indexOf(edits[i].find) === -1) return { error: true, messages: ['not found: ' + edits[i].find] };
                out = out.replace(edits[i].find, edits[i].replace); applied.push(edits[i]);
            }
            return { content: out, appliedEdits: applied };
        },
        UI_ICONS: {}, escapeHtml: function(s) { return s; }
    };
    function load(body, exports) {
        var names = Object.keys(globals);
        return new Function(names, body + '\nreturn {' + exports.map(function(n) { return n + ':' + n; }).join(',') + '};')
            .apply(null, names.map(function(n) { return globals[n]; }));
    }
    var storeApi = load(sources['src/js/core/135-widget-store.js'],
        ['WidgetStore', 'widgetEditTarget', 'consumeWidgetComposerTarget', 'widgetOperationId', 'widgetIdForOperation', 'saveWidgetRevision', 'getSidebarWidgets']);
    Object.assign(globals, storeApi);
    var toolSource = sources['src/js/tools/080-widget-tools.js'];
    var widgetTool = toolSource.slice(toolSource.indexOf('async function executeHtmlWidget('), toolSource.indexOf('// pin_widget tool'));
    var lookupSource = toolSource.slice(toolSource.indexOf('function getWidgetsForChat('), toolSource.indexOf('function toggleWidgetRunning('));
    var toolApi = load(widgetTool + lookupSource, ['executeHtmlWidget', 'getWidgetsForChat', 'getWidgetById']);
    Object.assign(globals, toolApi);
    var iframeSource = sources['src/js/tools/010-iframe-tool.js'];
    var editArm = iframeSource.slice(iframeSource.indexOf("            case 'edit_html':"), iframeSource.indexOf('            // Hidden actions'));
    var editHtml = load('async function editWidgetHtml(args, options) { var widgetId = args.widget_id; switch (args.action) {\n' + editArm + '\n}\n}',
        ['editWidgetHtml']);
    Object.assign(globals, editHtml);
    var store = globals.WidgetStore;

    // --- migration of pre-existing data -------------------------------------
    chats.chat_a = { id: 'chat_a', messages: [], widgets: [] };
    await store.init();
    var legacy = store.versions('widget_legacy');
    check('legacy history migrated in order under the SAME id', legacy.length === 3 && legacy[0].version === 1);
    check('legacy content-version counter never goes backwards', store.view('widget_legacy').contentVersion === 7);
    check('legacy head html is preserved as the latest revision', store.view('widget_legacy').html === '<p>v3</p>');
    check('historical read returns the old html without restoring it', store.view('widget_legacy', 1).html === '<p>v1</p>' && store.view('widget_legacy').html === '<p>v3</p>');
    check('dashboard-only widget survives with its own identity', store.versions('widget_dashonly').length === 1);
    check('migration is idempotent across boots', (await store.read('widget_legacy')).versions.length === 3);

    // --- creation ------------------------------------------------------------
    var created = await globals.executeHtmlWidget({ title: 'Report', html: '<b>1</b>' }, 0, { chatId: 'chat_a', toolCallId: 'call_1' });
    check('creation succeeds and reports version 1', created.success && created.version === 1 && created.latest_version === 1);
    check('creation keeps a permanent widget id', /^widget_[0-9a-f]{64}$/.test(created.widget_id));
    check('creation appends exactly one chat card', chats.chat_a.widgets.filter(function(w) { return w.id === created.widget_id; }).length === 1);
    var id = created.widget_id;

    // --- retried operation ---------------------------------------------------
    var retry = await globals.executeHtmlWidget({ title: 'Report', html: '<b>1</b>' }, 0, { chatId: 'chat_a', toolCallId: 'call_1' });
    check('identical retry is deduplicated instead of duplicating a widget', retry.success && retry.deduplicated && retry.version === 1);
    check('retry does not add a second card', chats.chat_a.widgets.filter(function(w) { return w.id === id; }).length === 1);
    check('retry adds no revision', store.versions(id).length === 1);
    var reused = await globals.executeHtmlWidget({ widget_id: id, expected_version: 1, html: '<b>other</b>' }, 0, { chatId: 'chat_a', toolCallId: 'call_1' });
    check('same operation_id with different content is refused', !reused.success && reused.code === 'OPERATION_CONFLICT');

    // --- iteration on an existing widget ------------------------------------
    var missingVersion = await globals.executeHtmlWidget({ widget_id: id, html: '<b>2</b>' }, 0, { chatId: 'chat_a', toolCallId: 'call_2' });
    check('update without expected_version is refused with the latest version', !missingVersion.success && missingVersion.code === 'VERSION_REQUIRED' && missingVersion.latest_version === 1);
    var v2 = await globals.executeHtmlWidget({ widget_id: id, expected_version: 1, html: '<b>2</b>' }, 0, { chatId: 'chat_a', toolCallId: 'call_2' });
    check('iteration appends version 2 to the same widget', v2.success && v2.version === 2 && v2.widget_id === id);
    check('iteration does not create a second widget', store.list().filter(function(w) { return w.id === id; }).length === 1 && chats.chat_a.widgets.filter(function(w) { return w.id === id; }).length === 1);
    check('original card position is preserved', chats.chat_a.widgets.find(function(w) { return w.id === id; }).msgIndex === created._widget_persist.msgIndex);
    check('title carries over when omitted', store.view(id).title === 'Report');
    check('both versions remain selectable', store.view(id, 1).html === '<b>1</b>' && store.view(id, 2).html === '<b>2</b>');

    // --- conflicting concurrent edits ---------------------------------------
    var stale = await globals.executeHtmlWidget({ widget_id: id, expected_version: 1, html: '<b>stale</b>' }, 0, { chatId: 'chat_a', toolCallId: 'call_3' });
    check('stale concurrent edit conflicts instead of overwriting', !stale.success && stale.code === 'VERSION_CONFLICT' && stale.latest_version === 2);
    check('conflict wrote nothing', store.versions(id).length === 2 && store.view(id).html === '<b>2</b>');
    var racing = await Promise.all([
        globals.executeHtmlWidget({ widget_id: id, expected_version: 2, html: '<b>a</b>' }, 0, { chatId: 'chat_a', toolCallId: 'race_a' }),
        globals.executeHtmlWidget({ widget_id: id, expected_version: 2, html: '<b>b</b>' }, 0, { chatId: 'chat_a', toolCallId: 'race_b' })
    ]);
    check('two simultaneous saves from the same base: exactly one wins', racing.filter(function(r) { return r.success; }).length === 1 && racing.filter(function(r) { return r.code === 'VERSION_CONFLICT'; }).length === 1);
    check('the losing save left no extra revision', store.versions(id).length === 3);

    // --- explicit targeting rules -------------------------------------------
    chats.chat_a.messages = [{ role: 'user', content: 'fix it', isWidgetRequest: true, widgetId: id }];
    check('durable transcript target resolves the edit target', globals.widgetEditTarget(chats.chat_a) === id);
    var implicit = await globals.executeHtmlWidget({ html: '<b>4</b>', expected_version: 3 }, 0, { chatId: 'chat_a', toolCallId: 'call_4' });
    check('omitted widget_id follows the durable target instead of minting', implicit.success && implicit.widget_id === id && implicit.version === 4);
    var fresh = await globals.executeHtmlWidget({ html: '<b>new</b>', title: 'Second', create_new: true }, 0, { chatId: 'chat_a', toolCallId: 'call_5' });
    check('create_new still produces a distinct widget', fresh.success && fresh.widget_id !== id && fresh.version === 1);
    check('a distinct widget never inherits the other history', store.versions(fresh.widget_id).length === 1);
    var both = await globals.executeHtmlWidget({ html: '<b>x</b>', widget_id: id, create_new: true }, 0, { chatId: 'chat_a', toolCallId: 'call_6' });
    check('widget_id plus create_new is rejected', !both.success);
    var unknown = await globals.executeHtmlWidget({ widget_id: 'widget_nope', expected_version: 1, html: '<b>x</b>' }, 0, { chatId: 'chat_a', toolCallId: 'call_7' });
    check('unknown widget_id fails instead of silently creating one', !unknown.success && unknown.code === 'WIDGET_NOT_FOUND');
    check('same title and html do NOT merge unrelated widgets', (await globals.executeHtmlWidget({ html: '<b>new</b>', title: 'Second', create_new: true }, 0, { chatId: 'chat_a', toolCallId: 'call_8' })).widget_id !== fresh.widget_id);

    chats.chat_a.messages.push({ role: 'assistant', content: 'Updated' }, { role: 'tool', content: 'done' });
    check('assistant and tool rows keep current request target', globals.widgetEditTarget(chats.chat_a) === id);
    chats.chat_a.messages.push({ role: 'user', content: 'Create an unrelated weather widget.' });
    check('ordinary next user turn ends previous widget intent', globals.widgetEditTarget(chats.chat_a) === null);
    var weather = await globals.executeHtmlWidget({ title: 'Weather', html: '<p>Sunny</p>' }, 0, { chatId: 'chat_a', toolCallId: 'weather' });
    check('next unrelated request creates distinct widget without create_new', weather.success && weather.widget_id !== id && weather.version === 1 && store.versions(id).length === 4);
    var input = { dataset: { widgetEditTarget: id } };
    check('composer edit target consumed exactly once', globals.consumeWidgetComposerTarget(input, 'Edit widget ' + id + ':\nImprove it') === id && !input.dataset.widgetEditTarget);
    check('next composer send has no residual target', globals.consumeWidgetComposerTarget(input, 'Create weather') === null);
    input.dataset.widgetEditTarget = id;
    check('replacing composer prefill discards old edit intent', globals.consumeWidgetComposerTarget(input, 'Create unrelated weather') === null && !input.dataset.widgetEditTarget);
    check('no user turn means no implicit target', globals.widgetEditTarget({ messages: [] }) === null);

    // --- read / list ---------------------------------------------------------
    var read = await globals.executeHtmlWidget({ action: 'read', widget_id: id }, 0, { chatId: 'chat_a' });
    check('read returns latest html plus full version list', read.success && read.widget.html === '<b>4</b>' && read.versions.length === 4 && read.latest_version === 4);
    check('read of an explicit version returns history', (await globals.executeHtmlWidget({ action: 'read', widget_id: id, version: 2 }, 0, { chatId: 'chat_a' })).widget.html === '<b>2</b>');
    var list = await globals.executeHtmlWidget({ action: 'list' }, 0, { chatId: 'chat_a' });
    check('list exposes retained identities including dashboard-only ones', list.success && list.widgets.some(function(w) { return w.id === 'widget_dashonly'; }));

    // --- durable saved edits from the other writers --------------------------
    var edited = await globals.editWidgetHtml({ action: 'edit_html', widget_id: id, expected_version: 4, edits: [{ find: '<b>4</b>', replace: '<b>5</b>' }] }, { chatId: 'chat_a', toolCallId: 'call_9' });
    check('edit_html appends a version to the same widget', edited.success && edited.version === 5 && edited.widget_id === id);
    check('edit_html mirrors the canonical widget to the worker', mirrored.some(function(m) { return m.type === 'widget-persist' && m.widget.id === id && m.widget.contentVersion === 5; }));
    var staleEdit = await globals.editWidgetHtml({ action: 'edit_html', widget_id: id, expected_version: 4, edits: [{ find: '<b>4</b>', replace: '<b>9</b>' }] }, { chatId: 'chat_a', toolCallId: 'call_10' });
    check('edit_html on a stale base conflicts', !staleEdit.success && staleEdit.code === 'VERSION_CONFLICT');
    var noVersion = await globals.editWidgetHtml({ action: 'edit_html', widget_id: id, edits: [] }, { chatId: 'chat_a' });
    check('edit_html demands expected_version', !noVersion.success && noVersion.code === 'VERSION_REQUIRED');
    var manual = await globals.saveWidgetRevision(store.view(id), '<b>manual</b>', 5, 'manual:1');
    check('manual code save appends a version', manual.success && manual.version === 6);
    check('manual save retry with identical content dedupes', (await globals.saveWidgetRevision(store.view(id), '<b>manual</b>', 5, 'manual:1')).deduplicated);
    var storedRow = await store.read(id);
    check('fingerprint is a compact hash, not a second copy of the HTML', storedRow.versions.every(function(v) { return typeof v.fingerprint !== 'string' || v.fingerprint.charAt(0) !== '{'; }) && storedRow.versions[storedRow.versions.length - 1].fingerprint.length < 40);
    // Legacy fingerprint (full snapshot JSON) still dedupes an identical retry.
    storedRow.versions[storedRow.versions.length - 1].fingerprint = JSON.stringify({ title: 'Report', html: '<b>manual</b>', width: storedRow.versions[storedRow.versions.length - 1].width, height: storedRow.versions[storedRow.versions.length - 1].height });
    await put('widgets', storedRow);
    check('legacy JSON fingerprint still dedupes an identical retry', (await globals.saveWidgetRevision(store.view(id), '<b>manual</b>', 5, 'manual:1')).deduplicated);
    // Cap: histories are pruned to the newest 25 revisions; latest is never dropped.
    var capped = await globals.executeHtmlWidget({ title: 'Cap', html: '<i>0</i>', create_new: true }, 0, { chatId: 'chat_a', toolCallId: 'cap_0' });
    for (var ci = 1; ci <= 30; ci++) await globals.executeHtmlWidget({ widget_id: capped.widget_id, expected_version: ci, html: '<i>' + ci + '</i>' }, 0, { chatId: 'chat_a', toolCallId: 'cap_' + ci });
    check('versions are capped at 25 and the latest survives', store.versions(capped.widget_id).length === 25 && store.view(capped.widget_id).contentVersion === 31 && store.view(capped.widget_id).html === '<i>30</i>' && store.versions(capped.widget_id)[0].version === 7);

    // --- projections are compatibility only ---------------------------------
    dashboardWidgets[id] = { id: id, html: '<b>ancient</b>', title: 'Report', gridX: 1, gridY: 1, width: 4, height: 4, dashboard: 'home', contentVersion: 1 };
    store.project(id);
    check('dashboard projection takes canonical content', dashboardWidgets[id].html === '<b>manual</b>' && dashboardWidgets[id].contentVersion === 6);
    check('dashboard placement survives projection', dashboardWidgets[id].gridX === 1 && dashboardWidgets[id].width === 4 && dashboardWidgets[id].dashboard === 'home');
    chats.chat_a.widgets.push({ id: id, html: '<b>dupe</b>', msgIndex: 99 });
    store.project(id);
    check('duplicate chat cards collapse to the original position', chats.chat_a.widgets.filter(function(w) { return w.id === id; }).length === 1 && chats.chat_a.widgets.find(function(w) { return w.id === id; }).msgIndex !== 99);
    check('chat projection serves canonical html', globals.getWidgetsForChat('chat_a').find(function(w) { return w.id === id; }).html === '<b>manual</b>');
    check('lookup of a chatless widget still resolves', globals.getWidgetById('widget_dashonly').html === '<p>d1</p>');

    // --- history survives losing every surface ------------------------------
    delete dashboardWidgets['widget_dashonly'];
    delete chats.chat_a;
    chatWidgets.chat_a = undefined;
    check('history survives unpin and chat deletion', store.versions(id).length === 6 && store.versions('widget_dashonly').length === 1);
    var reboot = load(sources['src/js/core/135-widget-store.js'], ['WidgetStore']).WidgetStore;
    await reboot.init();
    check('a fresh boot reloads canonical history from disk', reboot.versions(id).length === 6 && reboot.view(id).html === '<b>manual</b>');
    check('boot cache evicts non-latest html but keeps version metadata', typeof reboot.view(id, 1).html !== 'string' && reboot.view(id, 1).htmlEvicted === true && reboot.view(id, 1).contentVersion === 1);
    await reboot.read(id);
    check('read() rehydrates historical html on demand', reboot.view(id, 1).html === '<b>1</b>');
    check('a fresh boot keeps the migrated legacy history', reboot.versions('widget_legacy').length === 3);

    // --- backup round trip ---------------------------------------------------
    var exported = await reboot.exportRecords();
    check('export carries every widget identity', exported.length >= 3);
    await reboot.importRecords(exported);
    check('re-importing the same backup is safe', reboot.versions(id).length === 6);
    var rejected = false;
    try { await reboot.importRecords([{ id: id, versions: [{ version: 1, html: '<b>forged</b>', title: 'x' }] }]); } catch (e) { rejected = true; }
    await reboot.read(id);
    check('an import that contradicts retained history is rejected', rejected && reboot.view(id, 1).html === '<b>1</b>');
    var malformed = false;
    try { await reboot.importRecords([{ id: 'not-a-widget', versions: [] }]); } catch (e) { malformed = true; }
    check('malformed backup records are rejected', malformed);

    // --- full restore is atomic across canonical and compatibility stores ----
    async function disk(name) {
        var database = await openDatabase();
        return new Promise(function(resolve, reject) {
            var tx = database.transaction([name], 'readonly'), rows;
            var req = tx.objectStore(name).getAll(); req.onsuccess = function() { rows = req.result; };
            tx.oncomplete = function() { resolve(rows); }; tx.onerror = tx.onabort = function() { reject(tx.error); };
        });
    }
    await put('settings', { key: 'theme', value: 'old' });
    var originalDiskChats = JSON.stringify(await disk('chats'));
    var originalSettings = JSON.stringify(await disk('settings'));
    var backup = { chats: [{ id: 'chat_restore', messages: [], title: 'Restored' }], settings: [{ key: 'theme', value: 'new' }], widgets: exported, dashboardWidgets: [{ id: 'widget_dashonly', width: 3 }], apiProviders: [{ name: 'provider', model: 'test' }] };
    var messages = [], reloads = 0, permissionPushes = 0, fileInput, confirmCount = 0;
    var uiGlobals = Object.assign({}, globals, { WidgetStore: reboot, settingsStoreName: 'settings', apiProvidersStoreName: 'apiProviders', chatPayloadsStoreName: 'chat_payloads',
        document: { createElement: function() { fileInput = { click: function() {} }; return fileInput; } },
        window: { location: { reload: function() { reloads++; } } },
        showConfirmModal: async function() { confirmCount++; return true; },
        showSnackbar: function(text, kind) { messages.push({ text: text, kind: kind }); },
        pushPermissionsToOffscreen: function() { permissionPushes++; },
        stripTransientChatFieldsForPut: function(row) { return Object.assign({}, row); },
        console: { error: function() {} }
    });
    var uiNames = Object.keys(uiGlobals);
    var ui = new Function(uiNames, sources['src/js/ui/130-data-management.js'] + '\nreturn {importAllData:importAllData,deleteAllData:deleteAllData};').apply(null, uiNames.map(function(n) { return uiGlobals[n]; }));
    async function restore(data) { await ui.importAllData(); await fileInput.onchange({ target: { files: [{ text: async function() { return JSON.stringify(data); } }] } }); }
    var malformedBackup = Object.assign({}, backup, { widgets: [{ id: 'bad', versions: [] }] });
    await restore(malformedBackup);
    check('full restore rejects malformed widgets before confirmation', confirmCount === 0 && reloads === 0 && messages[messages.length - 1].kind === 'error');
    check('malformed restore writes neither chats nor settings', JSON.stringify(await disk('chats')) === originalDiskChats && JSON.stringify(await disk('settings')) === originalSettings);
    var conflicting = Object.assign({}, backup, { widgets: [{ id: id, versions: [{ version: 1, title: 'forged', html: 'forged' }] }], settings: [{ key: 'toolPermissions', value: { html_widget: 'disabled' } }] });
    await restore(conflicting);
    check('conflicting restore rolls back chats/settings and sends no permissions', JSON.stringify(await disk('chats')) === originalDiskChats && JSON.stringify(await disk('settings')) === originalSettings && permissionPushes === 0 && reloads === 0);
    check('conflicting restore reports actual history conflict', messages[messages.length - 1].text.includes('conflicts with retained history'));
    var duplicateRejected = false;
    try { reboot.validateRecords([exported[0], exported[0]]); } catch (e) { duplicateRejected = true; }
    check('duplicate backup IDs rejected before transaction', duplicateRejected);
    await restore(backup);
    check('valid restore commits all stores before success/reload', reloads === 1 && (await disk('chats')).some(function(c) { return c.id === 'chat_restore'; }) && (await disk('settings')).some(function(s) { return s.value === 'new'; }) && (await disk('apiProviders')).some(function(p) { return p.name === 'provider'; }));
    check('valid restore preserves immutable canonical history', (await reboot.read(id)).versions.length === 6);
    if (idb.failNextCommit) {
        idb.failNextCommit();
        await restore(Object.assign({}, backup, { settings: [{ key: 'theme', value: 'aborted' }] }));
        check('transaction abort rolls back all imported store writes', (await disk('settings')).find(function(s) { return s.key === 'theme'; }).value === 'new' && reloads === 1 && messages[messages.length - 1].kind === 'error');
        idb.failNextCommit();
        await ui.deleteAllData();
        check('reset abort reports failure without success/reload or clearing cache', reloads === 1 && messages[messages.length - 1].kind === 'error' && (await disk('widgets')).length > 0 && reboot.list().length > 0);
    }
    chats.chat_cache = { widgets: [{ id: id, html: 'stale' }] }; chatWidgets.chat_cache = chats.chat_cache.widgets;
    dashboardWidgets[id] = { id: id, html: 'stale' };
    await ui.deleteAllData();
    check('successful reset waits for all stores to clear before reload', reloads === 2 && (await disk('widgets')).length === 0 && (await disk('chats')).length === 0 && (await disk('settings')).length === 0 && (await disk('dashboardWidgets')).length === 0);
    check('reset drops canonical and compatibility caches', reboot.list().length === 0 && chats.chat_cache.widgets.length === 0 && !chatWidgets.chat_cache && !dashboardWidgets[id]);
    check('reset cannot remigrate deleted widget from stale projection', await reboot.read(id) === null);
    check('successful reset broadcasts invalidation after commit', broadcasts[broadcasts.length - 1].reset === true);
    channels[0].onmessage({ data: { reset: true } });
    check('another open panel invalidates its canonical cache on reset broadcast', store.list().length === 0 && await store.read(id) === null);
    return { passed: passed.length, tests: passed, idb: idb.failNextCommit ? 'serialized memory adapter' : 'provided IndexedDB' };
}

// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/core/135-widget-store.js", "src/js/tools/080-widget-tools.js", "src/js/tools/010-iframe-tool.js", "src/js/ui/130-data-management.js"];
await registerRunner('widget-versioning', async function() { return runWidgetVersioningTests(await loadSources(PATHS), createMemoryIdb()); });
