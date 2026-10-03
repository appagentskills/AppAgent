// importAllData (src/js/ui/130-data-management.js) driven through its real file
// picker onchange (widget-versioning driver pattern) over a small in-memory IDB.
function dmClone(v) { return JSON.parse(JSON.stringify(v)); }
function dmFakeDb(seed) {
    var data = dmClone(seed);
    var keyOf = function(row) { return row.id !== undefined ? row.id : (row.key !== undefined ? row.key : row.name); };
    return { data: data, objectStoreNames: { contains: function(n) { return !!data[n]; } },
        transaction: function() {
            var tx = {}, ops = [];
            tx.objectStore = function(n) {
                function req(fn) { var r = {}; ops.push(function() { r.result = fn(); if (r.onsuccess) r.onsuccess(); }); return r; }
                return { getAll: function() { return req(function() { return Object.values(data[n]).map(dmClone); }); },
                    getAllKeys: function() { return req(function() { return Object.keys(data[n]); }); },
                    get: function(k) { return req(function() { return data[n][k] === undefined ? undefined : dmClone(data[n][k]); }); },
                    put: function(row) { return req(function() { data[n][keyOf(row)] = dmClone(row); }); },
                    clear: function() { return req(function() { Object.keys(data[n]).forEach(function(k) { delete data[n][k]; }); }); } };
            };
            Promise.resolve().then(function() { ops.forEach(function(op) { op(); }); if (tx.oncomplete) tx.oncomplete(); });
            return tx;
        } };
}
function dmFakeStorage() {
    var s = {};
    return { data: s, getItem: function(k) { return k in s ? s[k] : null; }, setItem: function(k, v) { s[k] = String(v); }, removeItem: function(k) { delete s[k]; } };
}
async function dmHarness(seed, confirmAnswer, extra) {
    var src = await loadFile('src/js/ui/130-data-management.js');
    // ui/130 calls t()/tn()/i18nFormatNumber(): the fixture gets the REAL i18n core
    // (no catalog set = English identity, like the harness auto-include in test/harness.js).
    var i18n = new Function(await loadFile('src/js/core/025-i18n.js') +
        '\nreturn { t: t, tn: tn, N_: N_, i18nFormatNumber: i18nFormatNumber, i18nDir: i18nDir };')();
    var db = dmFakeDb(seed), input, h = { db: db, snacks: [], confirms: [], imports: [], adopted: [], reloads: 0 };
    var g = { t: i18n.t, tn: i18n.tn, N_: i18n.N_, i18nFormatNumber: i18n.i18nFormatNumber, i18nDir: i18n.i18nDir,
        chatStoreName: 'chats', settingsStoreName: 'settings', dashboardWidgetsStoreName: 'dashboardWidgets',
        apiProvidersStoreName: 'apiProviders', chatPayloadsStoreName: 'chat_payloads', chrome: undefined,
        openDatabase: async function() { return db; },
        WidgetStore: { validateRecords: function(r) { if (!Array.isArray(r)) throw new Error('Invalid widget backup'); },
            importRecords: async function(rows, other) { h.imports.push(other); Object.keys(other).forEach(function(n) { other[n].forEach(function(row) { db.data[n][row.id || row.key || row.name] = dmClone(row); }); }); },
            exportRecords: async function() { return []; }, clearCache: function() {} },
        document: { createElement: function() { input = { click: function() {} }; return input; } },
        window: { location: { reload: function() { h.reloads++; } } },
        showConfirmModal: async function(t, msg, v) { h.confirms.push({ title: t, msg: msg, variant: v }); return confirmAnswer; },
        showSnackbar: function(t, k) { h.snacks.push({ text: t, kind: k }); },
        escapeHtml: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
        stripTransientChatFieldsForPut: function(r) { return Object.assign({}, r); },
        adoptChatRow: function(row) { h.adopted.push(row); }, saveChatsToStorage: async function() {}, renderChatList: function() {},
        pushPermissionsToOffscreen: function() {}, console: { error: function() {}, warn: function() {} } };
    Object.keys(extra || {}).forEach(function(k) { g[k] = extra[k]; });
    var names = Object.keys(g);
    var mod = new Function(names, src + '\nreturn {importAllData:importAllData,exportAllData:exportAllData,consumePostImportNotice:consumePostImportNotice,deleteAllData:deleteAllData,DELETE_ALL_STORES:DELETE_ALL_STORES,DELETE_ALL_KEEP_STORES:DELETE_ALL_KEEP_STORES,DELETE_ALL_LOCAL_KEYS:DELETE_ALL_LOCAL_KEYS,hydrated:function(){return typeof _chatsHydrated==="undefined"?undefined:_chatsHydrated;}};').apply(null, names.map(function(n) { return g[n]; }));
    h.mod = mod;
    h.run = async function(data) { await mod.importAllData(); await input.onchange({ target: { files: [{ text: async function() { return JSON.stringify(data); } }] } }); };
    return h;
}
var DM_SEED = { chats: { c1: { id: 'c1', title: 'Old', messages: [] } }, settings: { theme: { key: 'theme', value: 'dark' } },
    dashboardWidgets: {}, apiProviders: { p1: { name: 'p1', apiKey: 'LOCAL' } } };
var DM_BACKUP = { version: 3, chats: [{ id: 'c1', title: 'Chat <One>', messages: [] }, { id: 'c2', title: 'New', messages: [] }],
    settings: [{ key: 'theme', value: 'light' }], apiProviders: [{ name: 'p1', apiKey: 'OLD' }], widgets: [] };

// S8D-02 Delete All: all 16 IDB stores seeded; chrome fake records sign-outs + key removals.
var DA_ALL = ['chats', 'chat_payloads', 'settings', 'widgets', 'dashboardWidgets', 'skills', 'skillAssets', 'apiProviders', 'documents',
    'action_state', 'agent_runs', 'sub_agents', 'pending_wakes', 'workspace_meta', 'workspace_files', 'workspace_blobs'];
function daSeed() { var s = {}; DA_ALL.forEach(function(n) { s[n] = { r1: { id: 'r1', key: 'r1', name: 'r1', v: n } }; }); return s; }
// TA-3: the Delete All SW save lock is logged 'lock:<locked>', a sign-out 'logout:<type>'.
function daMsgLabel(msg) { return msg.type === 'delete-all-save-lock' ? 'lock:' + msg.locked : 'logout:' + msg.type; }
function daChrome(ev, opts) {
    var o = opts || {}, rt = { lastError: undefined, sendMessage: function(msg, cb) { ev.push(daMsgLabel(msg)); cb(o.logoutReply || { success: true }); } };
    return { runtime: rt, storage: { local: {
        remove: function(keys, cb) { ev.push('remove'); ev.removed = keys; if (o.removeFails) rt.lastError = { message: 'quota' }; cb(); rt.lastError = undefined; },
        clear: function() { ev.push('CLEAR'); }, set: function() { ev.push('SET'); } } } };
}
async function daHarness(answers, chromeFake, ev, more) {
    var confirms = [];
    var h = await dmHarness(daSeed(), true, Object.assign({ chrome: chromeFake,
        showConfirmModal: async function(t, msg) { confirms.push(msg); return answers.shift(); },
        window: { location: { reload: function() { ev.push('reload'); } } } }, more || {}));
    var tx = h.db.transaction;
    h.db.transaction = function() { var t = tx.apply(null, arguments), done; Object.defineProperty(t, 'oncomplete', { set: function(f) { done = function() { ev.push('commit'); f(); }; }, get: function() { return done; } }); return t; };
    h.confirms = confirms;
    return h;
}
function daCount(h, n) { return Object.keys(h.db.data[n]).length; }

describe('data management delete all (S8D-02)', function() {
    test('S8D-02 Delete All clears every listed store, keeps the workspace stores, removes secrets', async function() {
        var ev = [], h = await daHarness([true, true], daChrome(ev), ev);
        await h.mod.deleteAllData();
        assert.strictEqual(h.mod.DELETE_ALL_STORES.length, 13);
        h.mod.DELETE_ALL_STORES.forEach(function(n) { assert.strictEqual(daCount(h, n), 0, n + ' cleared'); });
        assert.deepStrictEqual(h.mod.DELETE_ALL_KEEP_STORES, ['workspace_meta', 'workspace_files', 'workspace_blobs']);
        h.mod.DELETE_ALL_KEEP_STORES.forEach(function(n) { assert.strictEqual(daCount(h, n), 1, n + ' kept'); });
        assert.deepStrictEqual(ev.slice(), ['lock:true', 'commit', 'logout:claude-oauth-logout', 'logout:openai-oauth-logout', 'remove', 'lock:false', 'reload']); // M6: page-only reload keeps the SW, so the lock is lifted first
        assert.deepStrictEqual(ev.removed, h.mod.DELETE_ALL_LOCAL_KEYS);
        ['githubToken', 'githubUser', 'sessionToken', 'instanceTokens', 'claudeOAuth', 'openaiOAuth', 'openaiPendingDeviceAuth', 'appagent_chat_index']
            .forEach(function(k) { assert.ok(ev.removed.indexOf(k) >= 0, k); });
        assert.strictEqual(h.confirms.length, 2);
        assert.match(h.confirms[0], /skills/); assert.match(h.confirms[0], /documents/); assert.match(h.confirms[0], /API keys/);
        assert.match(h.confirms[0], /sign-ins/); assert.match(h.confirms[0], /Kept:.*local repository clones, including unpushed edits/);
        assert.match(h.confirms[1], /API keys and sign-ins will be deleted\. Local repository clones are kept\./);
        assert.strictEqual(h.snacks[h.snacks.length - 1].kind, 'success');
    }, { tags: ['unit'] });

    test('S8D-02 cancel at either confirm deletes nothing', async function() {
        for (var i = 0; i < 2; i++) {
            var ev = [], h = await daHarness(i ? [true, false] : [false], daChrome(ev), ev);
            await h.mod.deleteAllData();
            assert.strictEqual(h.confirms.length, i + 1);
            DA_ALL.forEach(function(n) { assert.strictEqual(daCount(h, n), 1, n + ' untouched'); });
            assert.deepStrictEqual(ev.slice(), []);
            assert.strictEqual(h.snacks.length, 0);
        }
    }, { tags: ['unit'] });

    test('S8D-02 every created IndexedDB store is classified', async function() {
        var src = (await loadFile('src/js/core/130-indexeddb.js')) + '\n' + (await loadFile('src/js/core/030-config.js'));
        var names = {}, created = [], m, dm = await dmHarness({}, true);
        var decl = /var\s+(\w+StoreName)\s*=\s*'([^']+)'/g, mk = /createObjectStore\((\w+)/g;
        while ((m = decl.exec(src))) names[m[1]] = m[2];
        while ((m = mk.exec(src))) { assert.ok(names[m[1]], 'resolved ' + m[1]); created.push(names[m[1]]); }
        assert.strictEqual(created.length, 16);
        var del = dm.mod.DELETE_ALL_STORES, keep = dm.mod.DELETE_ALL_KEEP_STORES;
        assert.deepStrictEqual(del.concat(keep).sort(), created.slice().sort());
        assert.deepStrictEqual(del.filter(function(n) { return keep.indexOf(n) >= 0; }), []);
        assert.deepStrictEqual(keep, [names.workspaceMetaStoreName, names.workspaceFilesStoreName, names.workspaceBlobsStoreName]);
    }, { tags: ['unit'] });

    test('S8D-02 without chrome.storage the IDB is still cleared, no throw', async function() {
        var ev = [], h = await daHarness([true, true], undefined, ev);
        await h.mod.deleteAllData();
        h.mod.DELETE_ALL_STORES.forEach(function(n) { assert.strictEqual(daCount(h, n), 0, n); });
        assert.deepStrictEqual(ev.slice(), ['commit', 'reload']);
        assert.strictEqual(h.snacks[h.snacks.length - 1].kind, 'success');
    }, { tags: ['unit'] });

    test('S8D-02 a failed sign-out or key removal is reported, never claimed as success', async function() {
        var cases = [{ removeFails: true }, { logoutReply: { error: 'busy' } }];
        for (var i = 0; i < cases.length; i++) {
            var ev = [], store = dmFakeStorage(), atReload = null;
            var h = await daHarness([true, true], daChrome(ev, cases[i]), ev, { appStorage: store,
                window: { location: { reload: function() { ev.push('reload'); atReload = store.getItem('appagentPostImportNotice'); } } } });
            await h.mod.deleteAllData();
            var last = h.snacks[h.snacks.length - 1];
            assert.strictEqual(last.kind, 'error');
            assert.match(last.text, /sign-ins could not be removed/);
            assert.strictEqual(ev[ev.length - 1], 'reload');
            // S8D-02-rev: the reload wipes the snackbar, so the failure is stored BEFORE it for the next boot
            var notice = JSON.parse(atReload);
            assert.strictEqual(notice.type, 'error');
            assert.match(notice.msg, /sign-ins could not be removed/);
            h.mod.consumePostImportNotice();
            assert.deepStrictEqual(h.snacks[h.snacks.length - 1], { text: notice.msg, kind: 'error' });
        }
    }, { tags: ['unit'] });

    test('S8D-02 the Data Management hint lists what Delete All removes and keeps', async function() {
        var ts = await loadFile('src/js/ui/040-tools-settings.js');
        var hint = (ts.match(/settings-page-row-hint">([^<]*Delete All[^<]*)</) || [])[1] || '';
        assert.match(hint, /Delete All permanently removes chats, skills, widgets, documents, settings, saved API keys and sign-ins\. Local repository clones are kept\./);
    }, { tags: ['unit'] });
});

// S8D-01: the extension-restart path of Delete All (fake chrome.runtime.reload +
// reopenAppTab marker, stubbed _prepareRealmsForReload, perms push and notice store).
function daRestart(ev, runs, more) {
    var fc = daChrome(ev), store = dmFakeStorage(), pushes = [];
    fc.runtime.reload = function() { ev.push('runtime.reload'); };
    fc.storage.local.set = function(items, cb) { ev.push('reopen:' + typeof items.reopenAppTab); cb(); };
    return { chrome: fc, store: store, pushes: pushes, globals: Object.assign({ runningChatIds: runs, appStorage: store,
        _prepareRealmsForReload: async function() { ev.push('prepare'); },
        pushPermissionsToOffscreen: function(p) { ev.push('perms'); pushes.push(p); } }, more || {}) };
}
describe('data management delete all restart (S8D-01)', function() {
    test('S8D-01 Delete All warns about runs, restarts the extension, leaves a notice', async function() {
        var ev = [], r = daRestart(ev, { a: true, b: true, c: false });
        var h = await daHarness([true, true], r.chrome, ev, r.globals);
        await h.mod.deleteAllData();
        assert.match(h.confirms[0], /^<b>2 agent run\(s\) in progress; deleting restarts the extension and stops them\.<\/b><br><br>This permanently deletes/);
        assert.match(h.confirms[1], /Local repository clones are kept\. Then the extension restarts, which closes every open AppAgent panel\./);
        h.mod.DELETE_ALL_STORES.forEach(function(n) { assert.strictEqual(daCount(h, n), 0, n + ' cleared'); });
        h.mod.DELETE_ALL_KEEP_STORES.forEach(function(n) { assert.strictEqual(daCount(h, n), 1, n + ' kept'); });
        // SW saves locked BEFORE the clear; delete committed + secrets removed BEFORE the perms push and the restart; no page reload
        assert.deepStrictEqual(ev.slice(), ['lock:true', 'commit', 'logout:claude-oauth-logout', 'logout:openai-oauth-logout', 'remove', 'perms', 'prepare', 'reopen:number', 'runtime.reload']);
        assert.deepStrictEqual(r.pushes, [{ toolPermissions: {}, instancePermissions: {} }]);
        var notice = JSON.parse(r.store.getItem('appagentPostImportNotice'));
        assert.strictEqual(notice.msg, 'All data deleted');
        assert.strictEqual(notice.type, 'success');
        assert.strictEqual(typeof notice.at, 'number');
        assert.deepStrictEqual(h.snacks[h.snacks.length - 1], { text: 'All data deleted. Restarting...', kind: 'success' });
    }, { tags: ['unit'] });

    test('S8D-01 cancel at either confirm: nothing cleared, no perms push, no notice, no restart', async function() {
        for (var i = 0; i < 2; i++) {
            var ev = [], r = daRestart(ev, { a: true });
            var h = await daHarness(i ? [true, false] : [false], r.chrome, ev, r.globals);
            await h.mod.deleteAllData();
            assert.strictEqual(h.confirms.length, i + 1);
            assert.match(h.confirms[0], /^<b>1 agent run\(s\) in progress; deleting restarts/);
            DA_ALL.forEach(function(n) { assert.strictEqual(daCount(h, n), 1, n + ' untouched'); });
            assert.deepStrictEqual(ev.slice(), []);
            assert.strictEqual(r.store.getItem('appagentPostImportNotice'), null);
            assert.strictEqual(h.snacks.length, 0);
        }
    }, { tags: ['unit'] });

    test('S8D-01 no runs: no warning; a failed sign-out is carried into the notice; a failed delete never restarts', async function() {
        var ev = [], r = daRestart(ev, {});
        r.chrome.runtime.sendMessage = function(msg, cb) { ev.push('logout:' + msg.type); cb({ error: 'busy' }); };
        var h = await daHarness([true, true], r.chrome, ev, r.globals);
        await h.mod.deleteAllData();
        assert.strictEqual(/in progress/.test(h.confirms[0]), false);
        assert.match(h.confirms[0], /^This permanently deletes/);
        var notice = JSON.parse(r.store.getItem('appagentPostImportNotice'));
        assert.strictEqual(notice.type, 'error');
        assert.match(notice.msg, /^All data deleted, but some saved sign-ins could not be removed$/);
        assert.strictEqual(ev[ev.length - 1], 'runtime.reload');

        var ev2 = [], r2 = daRestart(ev2, { a: true }, { openDatabase: async function() { throw new Error('blocked'); } });
        var h2 = await daHarness([true, true], r2.chrome, ev2, r2.globals);
        await h2.mod.deleteAllData();
        DA_ALL.forEach(function(n) { assert.strictEqual(daCount(h2, n), 1, n + ' untouched'); });
        assert.deepStrictEqual(ev2.slice(), []);
        assert.strictEqual(r2.store.getItem('appagentPostImportNotice'), null);
        assert.deepStrictEqual(h2.snacks, [{ text: 'Delete failed: blocked', kind: 'error' }]);
    }, { tags: ['unit'] });
});

// B3 post-reload: TA4-4 (the instance-picker cache is a Delete All key) and TA-4
// (every Delete All chrome call is raced against a 3 s timer). Fake timers shadow
// the globals through the daHarness `more` param; waits are microtask-bounded,
// so a hang fails fast instead of timing out.
function daFakeTimers() {
    var t = { list: [], cleared: [] };
    t.setTimeout = function(fn, ms) { var rec = { id: t.list.length + 1, fn: fn, ms: ms, fired: false }; t.list.push(rec); return rec.id; };
    t.clearTimeout = function(id) { t.cleared.push(id); };
    t.calls = function() { return t.list.filter(function(rec) { return rec.ms === 3000; }); };
    return t;
}
async function daTicks(cond) { for (var i = 0; i < 500 && !cond(); i++) await Promise.resolve(); }
describe('data management delete all (TA4-4, TA-4)', function() {
    test('TA4-4 Delete All also removes the ServiceNow instance-picker cache and says so', async function() {
        var pb = await loadFile('src/platform/extension/platform-bridge.js');
        var key = (pb.match(/_INSTANCES_CACHE_KEY\s*=\s*'([^']+)'/) || [])[1];
        assert.strictEqual(typeof key, 'string', 'platform-bridge.js declares _INSTANCES_CACHE_KEY');
        var ev = [], h = await daHarness([true, true], daChrome(ev), ev);
        await h.mod.deleteAllData();
        assert.ok(ev.removed.indexOf(key) >= 0, key + ' removed');
        assert.match(h.confirms[0], /instance list/);
        assert.strictEqual(h.snacks[h.snacks.length - 1].kind, 'success');
    }, { tags: ['unit'] });

    test('TA-4 a chrome call that never calls back times out; Delete All still restarts with an error notice', async function() {
        var silent = ['sendMessage', 'remove'];
        for (var i = 0; i < silent.length; i++) {
            var ev = [], t = daFakeTimers(), r = daRestart(ev, {}, { setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
            if (silent[i] === 'sendMessage') r.chrome.runtime.sendMessage = function(msg) { ev.push(daMsgLabel(msg)); };
            else r.chrome.storage.local.remove = function() { ev.push('remove'); };
            var h = await daHarness([true, true], r.chrome, ev, r.globals), settled = false;
            var fire = function() { t.calls().forEach(function(rec) { if (t.cleared.indexOf(rec.id) < 0 && !rec.fired) { rec.fired = true; rec.fn(); } }); };
            h.mod.deleteAllData().then(function() { settled = true; });
            if (silent[i] === 'sendMessage') {
                // TA-3: the SW save lock is the first bounded call; a silent SW fails it open
                await daTicks(function() { return t.calls().length >= 1; });
                assert.strictEqual(t.calls().length, 1, 'sendMessage: the lock call is raced against a 3000 ms timer');
                assert.strictEqual(settled, false, 'sendMessage: still waiting on the silent lock call');
                fire();
            }
            var armed = silent[i] === 'sendMessage' ? 3 : 4;
            await daTicks(function() { return t.calls().length >= armed; });
            assert.strictEqual(t.calls().length, armed, silent[i] + ': each chrome call is raced against a 3000 ms timer');
            assert.strictEqual(settled, false, silent[i] + ': still waiting on the silent call');
            fire();
            await daTicks(function() { return settled; });
            assert.strictEqual(settled, true, silent[i] + ': Delete All finished after the timeout');
            assert.deepStrictEqual(ev.slice(), ['lock:true', 'commit', 'logout:claude-oauth-logout', 'logout:openai-oauth-logout', 'remove', 'perms', 'prepare', 'reopen:number', 'runtime.reload']);
            var notice = JSON.parse(r.store.getItem('appagentPostImportNotice'));
            assert.strictEqual(notice.type, 'error');
            assert.match(notice.msg, /sign-ins could not be removed/);
            assert.strictEqual(t.calls().length, 4, silent[i] + ': lock + 2 sign-outs + key removal, each bounded');
            assert.strictEqual(t.calls().filter(function(rec) { return rec.fired; }).length, silent[i] === 'sendMessage' ? 3 : 1);
            // a call that answered clears its timer once the race settles
            t.calls().forEach(function(rec) { if (!rec.fired) assert.ok(t.cleared.indexOf(rec.id) >= 0, silent[i] + ': timer ' + rec.id + ' cleared'); });
        }
    }, { tags: ['unit'] });
});

// B3 post-reload TA-3: Delete All fences every chat save before its clear: it
// stops the runs, locks the SW saves ('delete-all-save-lock') and closes the
// page wipe guard (_chatsHydrated). The fences are lifted only when the clear
// did not commit.
function daFences(ev, hydrated) {
    return { _chatsHydrated: hydrated, pushInterruptToOffscreen: function(id, fromUser) { ev.push('interrupt:' + id + ':' + fromUser); } };
}
describe('data management delete all save fences (TA-3)', function() {
    test('TA-3 the runs are stopped and the SW saves locked before the clear commits; the wipe guard stays closed', async function() {
        var ev = [], r = daRestart(ev, { a: true, b: false, c: true }, daFences(ev, true));
        var h = await daHarness([true, true], r.chrome, ev, r.globals), tx = h.db.transaction;
        h.db.transaction = function() { ev.push('hydrated:' + h.mod.hydrated()); return tx.apply(null, arguments); };
        await h.mod.deleteAllData();
        assert.deepStrictEqual(ev.slice(), ['interrupt:a:false', 'interrupt:c:false', 'lock:true', 'hydrated:false', 'commit',
            'logout:claude-oauth-logout', 'logout:openai-oauth-logout', 'remove', 'perms', 'prepare', 'reopen:number', 'runtime.reload']);
        assert.strictEqual(h.mod.hydrated(), false, 'the page wipe guard stays closed until the restart');
        h.mod.DELETE_ALL_STORES.forEach(function(n) { assert.strictEqual(daCount(h, n), 0, n + ' cleared'); });
    }, { tags: ['unit'] });

    test('TA-3 a clear that throws lifts the fences: SW unlocked, previous wipe guard restored, no restart', async function() {
        var prevs = [true, false];
        for (var i = 0; i < prevs.length; i++) {
            var ev = [], r = daRestart(ev, { a: true }, daFences(ev, prevs[i]));
            var h = await daHarness([true, true], r.chrome, ev, r.globals);
            h.db.transaction = function() { ev.push('tx'); throw new Error('tx boom'); };
            await h.mod.deleteAllData();
            assert.deepStrictEqual(ev.slice(), ['interrupt:a:false', 'lock:true', 'tx', 'lock:false']);
            assert.strictEqual(h.mod.hydrated(), prevs[i], 'wipe guard restored to ' + prevs[i]);
            DA_ALL.forEach(function(n) { assert.strictEqual(daCount(h, n), 1, n + ' untouched'); });
            assert.strictEqual(r.store.getItem('appagentPostImportNotice'), null);
            assert.deepStrictEqual(h.snacks, [{ text: 'Delete failed: tx boom', kind: 'error' }]);
        }
    }, { tags: ['unit'] });
});

describe('data management import (S0B-01/04/05)', function() {
    test('S0B-01 confirm lists replaced rows per store; cancel writes nothing', async function() {
        var h = await dmHarness(DM_SEED, false);
        await h.run(DM_BACKUP);
        assert.strictEqual(h.confirms.length, 1);
        var msg = h.confirms[0].msg;
        assert.match(msg, /REPLACED/);
        assert.match(msg, /1 of 2 chats: Chat &lt;One&gt;/);
        assert.match(msg, /1 settings: theme/);
        assert.match(msg, /1 providers \(API keys revert to the backup value\): p1/);
        assert.strictEqual(h.imports.length, 0);
        assert.strictEqual(h.reloads, 0);
        assert.deepStrictEqual(h.db.data, DM_SEED);
    }, { tags: ['unit'] });
    test('S0B-01 confirmed import writes once and reloads', async function() {
        var h = await dmHarness(DM_SEED, true);
        await h.run(DM_BACKUP);
        assert.strictEqual(h.imports.length, 1);
        assert.strictEqual(h.db.data.chats.c2.title, 'New');
        assert.strictEqual(h.reloads, 1);
    }, { tags: ['unit'] });
    test('S0B-05 version 99 rejected before confirm; chat without messages counted as skipped', async function() {
        var h = await dmHarness(DM_SEED, false);
        await h.run(Object.assign({}, DM_BACKUP, { version: 99 }));
        assert.strictEqual(h.confirms.length, 0);
        assert.strictEqual(h.snacks[h.snacks.length - 1].kind, 'error');
        assert.match(h.snacks[h.snacks.length - 1].text, /newer version/);
        await h.run({ chats: [{ id: 'c3', title: 'x' }, { id: 'c4', messages: [] }], settings: [], widgets: [] });
        assert.strictEqual(h.confirms.length, 1);
        assert.match(h.confirms[0].msg, /0 of 1 chats/);
        assert.match(h.confirms[0].msg, /1 invalid row\(s\) will be skipped/);
        assert.strictEqual(h.imports.length, 0);
    }, { tags: ['unit'] });
    test('S0B-04 single_chat without messages is rejected; missing title falls back', async function() {
        var h = await dmHarness(DM_SEED, true);
        await h.run({ exportType: 'single_chat', chat: { title: 'x' } });
        assert.strictEqual(h.adopted.length, 0);
        assert.strictEqual(h.snacks[h.snacks.length - 1].kind, 'error');
        assert.match(h.snacks[h.snacks.length - 1].text, /Invalid chat file/);
        await h.run({ exportType: 'single_chat', chat: { messages: [] } });
        assert.strictEqual(h.adopted.length, 1);
        assert.strictEqual(h.adopted[0].title, 'Imported chat (imported)');
    }, { tags: ['unit'] });
});

describe('data management import restart + result notice (S0B-02/03)', function() {
    test('S0B-02 running agent runs are warned in the same confirm; cancel writes nothing', async function() {
        var h = await dmHarness(DM_SEED, false, { runningChatIds: { a: true, b: false, c: true } });
        await h.run(DM_BACKUP);
        assert.strictEqual(h.confirms.length, 1);
        assert.match(h.confirms[0].msg, /2 agent run\(s\) in progress; importing restarts the extension and stops them/);
        assert.match(h.confirms[0].msg, /REPLACED/);
        assert.strictEqual(h.imports.length, 0);
        assert.strictEqual(h.reloads, 0);
        assert.deepStrictEqual(h.db.data, DM_SEED);
    }, { tags: ['unit'] });
    test('S0B-02 confirmed import restarts the whole extension (timestamped reopenAppTab, no page reload)', async function() {
        var calls = [];
        var fakeChrome = { runtime: { reload: function() { calls.push('runtime.reload'); } },
            storage: { local: { set: function(items, cb) { calls.push(items); cb(); } } } };
        var h = await dmHarness(DM_SEED, true, { chrome: fakeChrome, runningChatIds: { a: false },
            _prepareRealmsForReload: async function() { calls.push('prepare'); } });
        await h.run(DM_BACKUP);
        assert.strictEqual(/agent run/.test(h.confirms[0].msg), false);
        assert.strictEqual(h.imports.length, 1);
        assert.strictEqual(calls.length, 3);
        assert.strictEqual(calls[0], 'prepare');
        assert.strictEqual(typeof calls[1].reopenAppTab, 'number');
        assert.strictEqual(calls[2], 'runtime.reload');
        assert.strictEqual(h.reloads, 0);
    }, { tags: ['unit'] });
    test('S0B-03 result notice is stored before the reload and shown once by the next boot', async function() {
        var store = dmFakeStorage(), atReload = 'not reloaded';
        var h = await dmHarness(DM_SEED, true, { appStorage: store,
            window: { location: { reload: function() { atReload = store.getItem('appagentPostImportNotice'); } } } });
        await h.run(Object.assign({}, DM_BACKUP, { settings: [{ key: 'theme', value: 'light' }, { value: 'no key' }] }));
        assert.strictEqual(typeof atReload, 'string');
        var notice = JSON.parse(atReload);
        assert.match(notice.msg, /1 invalid row\(s\) skipped/);
        assert.strictEqual(typeof notice.at, 'number');
        var before = h.snacks.length;
        h.mod.consumePostImportNotice();
        h.mod.consumePostImportNotice();
        assert.strictEqual(h.snacks.length, before + 1);
        assert.strictEqual(h.snacks[before].text, notice.msg);
        assert.strictEqual(store.getItem('appagentPostImportNotice'), null);
    }, { tags: ['unit'] });
    test('S0B-03 a stale notice is dropped without a snackbar', async function() {
        var store = dmFakeStorage();
        store.setItem('appagentPostImportNotice', JSON.stringify({ msg: 'old', type: 'success', at: Date.now() - 10 * 60 * 1000 }));
        var h = await dmHarness(DM_SEED, true, { appStorage: store });
        h.mod.consumePostImportNotice();
        assert.strictEqual(h.snacks.length, 0);
        assert.strictEqual(store.getItem('appagentPostImportNotice'), null);
    }, { tags: ['unit'] });
});

// exportAllData driven through a fake save picker + writable that collect the output.
function dmWritable(failOnWrite) {
    var w = { chunks: [], writes: 0, closed: false, aborted: false };
    w.write = async function(s) { w.writes++; if (w.writes === failOnWrite) throw new Error('disk full'); w.chunks.push(s); };
    w.close = async function() { w.closed = true; };
    w.abort = async function() { w.aborted = true; };
    return w;
}
async function dmExport(seed, choice, opts) {
    opts = opts || {};
    var w = dmWritable(opts.failOnWrite), order = [], modals = [];
    var h = await dmHarness(seed, true, Object.assign({
        window: { location: { reload: function() {} }, showSaveFilePicker: async function() { order.push('picker'); return { createWritable: async function() { return w; } }; } },
        showModal: async function(t, msg, buttons, v) { order.push('modal'); modals.push({ title: t, msg: msg, buttons: buttons, variant: v }); return choice; }
    }, opts.globals || {}));
    await h.mod.exportAllData();
    h.writable = w; h.order = order; h.modals = modals;
    h.out = w.closed ? JSON.parse(w.chunks.join('')) : null;
    return h;
}
function dmApiKeys(v, out) {
    if (Array.isArray(v)) v.forEach(function(x) { dmApiKeys(x, out); });
    else if (v && typeof v === 'object') Object.keys(v).forEach(function(k) { if (k === 'apiKey') out.push(v[k]); else dmApiKeys(v[k], out); });
    return out;
}
function dmByKey(rows, field, value) { return rows.filter(function(r) { return r[field] === value; })[0]; }
var DM_KEYS_SEED = { chats: { c1: { id: 'c1', title: 'One', messages: [] } }, dashboardWidgets: {}, chat_payloads: {},
    settings: { theme: { key: 'theme', value: 'dark' }, deployDirHandle: { key: 'deployDirHandle', value: { kind: 'directory', name: 'deploy' } }, llmEndpoints: { key: 'llmEndpoints', value: [
        { id: 'e1', name: 'E1', url: 'https://e1', apiKey: 'sk-E1' }, { id: 'e2', name: 'E2', url: 'https://e2', apiKey: 'oauth' }] } },
    apiProviders: { p1: { name: 'p1', apiKey: 'LOCAL' }, p2: { name: 'p2', apiKey: 'oauth' }, p3: { name: 'p3', apiKey: 'sk-P3' }, p4: { name: 'p4', apiKey: '' } } };

describe('data management export (S0B-06/07, S0B3-03)', function() {
    test('S0B-06 export asks first; "without API keys" (primary) leaves no key but the oauth marker', async function() {
        var h = await dmExport(DM_KEYS_SEED, 'nokeys');
        assert.deepStrictEqual(h.order, ['modal', 'picker']);
        assert.match(h.modals[0].msg, /plaintext/);
        assert.deepStrictEqual(h.modals[0].buttons.map(function(b) { return b.value; }), ['cancel', 'nokeys', 'keys']);
        assert.strictEqual(h.modals[0].buttons[1].class, 'primary');
        assert.strictEqual(h.writable.closed, true);
        var keys = dmApiKeys(h.out, []);
        assert.strictEqual(keys.length, 6);
        keys.forEach(function(k) { assert.ok(k === '' || k === 'oauth', 'unexpected apiKey ' + k); });
        assert.strictEqual(dmByKey(h.out.apiProviders, 'name', 'p1')._apiKeyRedacted, true);
        // R1d (1): an empty source key is flagged too, so importing never blanks a target's key.
        assert.strictEqual(dmByKey(h.out.apiProviders, 'name', 'p4')._apiKeyRedacted, true);
        assert.strictEqual(dmByKey(h.out.apiProviders, 'name', 'p2').apiKey, 'oauth');
        assert.strictEqual('_apiKeyRedacted' in dmByKey(h.out.apiProviders, 'name', 'p2'), false);
        var eps = dmByKey(h.out.settings, 'key', 'llmEndpoints').value;
        assert.deepStrictEqual([eps[0].apiKey, eps[0]._apiKeyRedacted, eps[1].apiKey], ['', true, 'oauth']);
        assert.strictEqual(h.snacks[h.snacks.length - 1].kind, 'success');
    }, { tags: ['unit'] });
    test('S0B-06 "Include API keys" keeps them; Cancel or dismiss writes nothing', async function() {
        var h = await dmExport(DM_KEYS_SEED, 'keys');
        assert.strictEqual(dmByKey(h.out.apiProviders, 'name', 'p1').apiKey, 'LOCAL');
        assert.strictEqual('_apiKeyRedacted' in dmByKey(h.out.apiProviders, 'name', 'p1'), false);
        assert.strictEqual(dmByKey(h.out.settings, 'key', 'llmEndpoints').value[0].apiKey, 'sk-E1');
        for (var choice of ['cancel', null]) {
            var c = await dmExport(DM_KEYS_SEED, choice);
            assert.deepStrictEqual(c.order, ['modal']);
            assert.strictEqual(c.writable.writes, 0);
            assert.strictEqual(c.snacks.length, 0);
        }
    }, { tags: ['unit'] });
    test('S0B-06 importing a keyless backup keeps the local keys', async function() {
        var ex = await dmExport(DM_KEYS_SEED, 'nokeys');
        var target = dmClone(DM_KEYS_SEED);
        delete target.apiProviders.p3;
        target.apiProviders.p1.apiKey = 'TARGET';
        target.settings.llmEndpoints.value[0].apiKey = 'sk-TARGET';
        target.apiProviders.p4.apiKey = 'sk-P4';
        var h = await dmHarness(target, true);
        await h.run(ex.out);
        assert.match(h.confirms[0].msg, /3 providers \(local API keys kept, except the backup value for p2\): p1, p2, p4/);
        assert.match(h.confirms[0].msg, /0 settings/);
        assert.strictEqual(h.imports.length, 1);
        var p = h.db.data.apiProviders;
        assert.deepStrictEqual([p.p1.apiKey, p.p2.apiKey, p.p3.apiKey, p.p4.apiKey], ['TARGET', 'oauth', '', 'sk-P4']);
        assert.strictEqual('_apiKeyRedacted' in p.p1 || '_apiKeyRedacted' in p.p3, false);
        var eps = h.db.data.settings.llmEndpoints.value;
        assert.deepStrictEqual([eps[0].apiKey, eps[1].apiKey, '_apiKeyRedacted' in eps[0]], ['sk-TARGET', 'oauth', false]);
    }, { tags: ['unit'] });
    test('S0B-06 (R1d) a redacted provider takes its endpointId key, never a key for another host', async function() {
        var h = await dmHarness(DM_KEYS_SEED, true);
        await h.run({ version: 3, chats: [], widgets: [],
            settings: [{ key: 'llmEndpoints', value: [{ id: 'e1', name: 'E1', url: 'https://e1', apiKey: '', _apiKeyRedacted: true }] }],
            apiProviders: [{ name: 'p1', endpoint: 'https://other.example/v1', apiKey: '', _apiKeyRedacted: true },
                { name: 'p3', endpointId: 'e1', endpoint: 'https://E1/v1', apiKey: '', _apiKeyRedacted: true }] });
        assert.strictEqual(h.imports.length, 1);
        var p = h.db.data.apiProviders;
        assert.strictEqual(p.p1.apiKey, '');
        assert.strictEqual(p.p3.apiKey, 'sk-E1');
        assert.strictEqual(h.db.data.settings.llmEndpoints.value[0].apiKey, 'sk-E1');
        // R1e (1): p1's key is cleared (different host), so the confirm must not call it kept;
        // R1f (1): nor p3's, whose local sk-P3 is replaced by the e1 key (sk-E1).
        assert.match(h.confirms[0].msg, /2 providers \(key cleared for p1 \(different or invalid endpoint\); local key replaced for p3 \(endpoint key\)\): p1, p3/);
        assert.strictEqual(/API keys kept/.test(h.confirms[0].msg), false);
    }, { tags: ['unit'] });
    test('S0B-06 (R1e) the same-name key is kept on the same host whatever the endpointId; a cleared key is never reported as kept', async function() {
        var seed = dmClone(DM_KEYS_SEED);
        seed.apiProviders.pa = { name: 'pa', endpointId: 'anthropic', endpoint: 'https://api.anthropic.com/v1', apiKey: 'sk-ANT' };
        seed.apiProviders.pb = { name: 'pb', endpoint: 'https://api.b.example', apiKey: 'sk-B' };
        var h = await dmHarness(seed, true);
        await h.run({ version: 3, chats: [], widgets: [], settings: [],
            apiProviders: [{ name: 'pa', endpointId: 'anthropic-2', endpoint: 'https://API.anthropic.com', apiKey: '', _apiKeyRedacted: true },
                // e1 exists here but for another host: fall back to the same-name key on this host
                { name: 'pb', endpointId: 'e1', endpoint: 'https://api.b.example/v2', apiKey: '', _apiKeyRedacted: true },
                { name: 'p2', apiKey: 'oauth' },
                { name: 'p3', endpoint: 'https://p3.other', apiKey: '', _apiKeyRedacted: true }] });
        var p = h.db.data.apiProviders;
        assert.deepStrictEqual([p.pa.apiKey, p.pb.apiKey, p.p2.apiKey, p.p3.apiKey], ['sk-ANT', 'sk-B', 'oauth', '']);
        assert.match(h.confirms[0].msg, /4 providers \(local API keys kept, except the backup value for p2; key cleared for p3 \(different or invalid endpoint\)\): pa, pb, p2, p3/);
        var c = await dmHarness(DM_KEYS_SEED, false);
        await c.run({ version: 3, chats: [], widgets: [], settings: [],
            apiProviders: [{ name: 'p2', apiKey: 'oauth' }, { name: 'p1', endpoint: 'https://other.example', apiKey: '', _apiKeyRedacted: true }] });
        assert.match(c.confirms[0].msg, /2 providers \(API keys revert to the backup value for p2; key cleared for p1 \(different or invalid endpoint\)\): p2, p1/);
        assert.strictEqual(c.imports.length, 0);
    }, { tags: ['unit'] });
    test('S0B-06 (R1e) a redacted llmEndpoints entry never takes the same-id key of another host', async function() {
        var h = await dmHarness(DM_KEYS_SEED, true);
        await h.run({ version: 3, chats: [], widgets: [], apiProviders: [],
            settings: [{ key: 'llmEndpoints', value: [{ id: 'e1', name: 'E1', url: 'https://evil.example/v1', apiKey: '', _apiKeyRedacted: true },
                { id: 'e2', name: 'E2', url: 'https://e2', apiKey: 'oauth' }] }] });
        assert.strictEqual(h.imports.length, 1);
        var eps = h.db.data.settings.llmEndpoints.value;
        assert.deepStrictEqual([eps[0].url, eps[0].apiKey, '_apiKeyRedacted' in eps[0], eps[1].apiKey], ['https://evil.example/v1', '', false, 'oauth']);
    }, { tags: ['unit'] });
    test('S0B-06 (R1f) a key is kept only for the same origin; a non-string or unparseable endpoint never matches', async function() {
        var seed = dmClone(DM_KEYS_SEED);
        seed.apiProviders.pb = { name: 'pb', endpoint: 'https://api.b.example', apiKey: 'sk-B' };
        seed.apiProviders.pc = { name: 'pc', endpoint: 'https://api.c.example', apiKey: 'sk-C' };
        seed.apiProviders.pd = { name: 'pd', endpoint: 'not a url', apiKey: 'sk-D' };
        var h = await dmHarness(seed, true);
        await h.run({ version: 3, chats: [], widgets: [],
            settings: [{ key: 'llmEndpoints', value: [{ id: 'e1', name: 'E1', url: 'http://e1', apiKey: '', _apiKeyRedacted: true }] }],
            // p1: fetch(String(array)) would still reach evil.example; pb: same host but
            // plaintext http; pc: same origin with the default port spelled out.
            apiProviders: [{ name: 'p1', endpoint: ['https://evil.example/v1'], apiKey: '', _apiKeyRedacted: true },
                { name: 'pb', endpoint: 'http://api.b.example/v1', apiKey: '', _apiKeyRedacted: true },
                { name: 'pc', endpoint: 'https://API.c.example:443/v1', apiKey: '', _apiKeyRedacted: true },
                { name: 'pd', endpoint: 'not a url', apiKey: '', _apiKeyRedacted: true }] });
        assert.strictEqual(h.imports.length, 1);
        var p = h.db.data.apiProviders;
        assert.deepStrictEqual([p.p1.apiKey, p.pb.apiKey, p.pc.apiKey, p.pd.apiKey], ['', '', 'sk-C', '']);
        assert.strictEqual(h.db.data.settings.llmEndpoints.value[0].apiKey, '');
        assert.match(h.confirms[0].msg, /4 providers \(local API keys kept; key cleared for p1, pb, pd \(different or invalid endpoint\)\): p1, pb, pc, pd/);
        // R1f (4): a cleared endpoint key is named on the settings line too.
        assert.match(h.confirms[0].msg, /1 settings \(key cleared for E1 \(different or invalid endpoint\)\): llmEndpoints/);
    }, { tags: ['unit'] });
    test('S0B-06 (R1f) an endpointId entry without a key never blanks the same-name key on the same host', async function() {
        var seed = dmClone(DM_KEYS_SEED);
        seed.settings.llmEndpoints.value.push({ id: 'e3', name: 'E3', url: 'https://e3', apiKey: '' });
        seed.apiProviders.pc = { name: 'pc', endpoint: 'https://e3', apiKey: 'sk-C' };
        var h = await dmHarness(seed, true);
        await h.run({ version: 3, chats: [], widgets: [], settings: [],
            apiProviders: [{ name: 'pc', endpointId: 'e3', endpoint: 'https://e3/v1', apiKey: '', _apiKeyRedacted: true }] });
        assert.strictEqual(h.imports.length, 1);
        assert.strictEqual(h.db.data.apiProviders.pc.apiKey, 'sk-C');
        assert.match(h.confirms[0].msg, /1 providers \(local API keys kept\): pc/);
        assert.strictEqual(/key cleared|key replaced/.test(h.confirms[0].msg), false);
    }, { tags: ['unit'] });
    test('S0B-06 (R1g) an llmEndpoints entry matches on its url only; an endpoint field never takes or lends a key', async function() {
        // The runtime uses ep.url: a backup entry naming e1 only in `endpoint` gets no local key.
        var h = await dmHarness(DM_KEYS_SEED, true);
        await h.run({ version: 3, chats: [], widgets: [], apiProviders: [],
            settings: [{ key: 'llmEndpoints', value: [{ id: 'e1', name: 'E1', url: 'https://evil.example/v1', endpoint: 'https://e1', apiKey: '', _apiKeyRedacted: true }] }] });
        assert.strictEqual(h.imports.length, 1);
        var ep = h.db.data.settings.llmEndpoints.value[0];
        assert.deepStrictEqual([ep.url, ep.apiKey, '_apiKeyRedacted' in ep], ['https://evil.example/v1', '', false]);
        assert.match(h.confirms[0].msg, /1 settings \(key cleared for E1 \(different or invalid endpoint\)\): llmEndpoints/);
        // R1g-4: no provider conflicts = no "(API keys revert ...)" note.
        assert.match(h.confirms[0].msg, /<br>0 providers<br>/);
        // Nor does a local entry lend its key through `endpoint`: its url (evil) is where that key goes.
        var seed = dmClone(DM_KEYS_SEED);
        seed.settings.llmEndpoints.value[0] = { id: 'e1', name: 'E1', url: 'https://evil.example/v1', endpoint: 'https://e1', apiKey: 'sk-E1' };
        var b = await dmHarness(seed, true);
        await b.run({ version: 3, chats: [], widgets: [],
            settings: [{ key: 'llmEndpoints', value: [{ id: 'e1', name: 'E1', url: 'https://e1', apiKey: '', _apiKeyRedacted: true }] }],
            apiProviders: [{ name: 'p3', endpointId: 'e1', endpoint: 'https://e1/v1', apiKey: '', _apiKeyRedacted: true }] });
        assert.strictEqual(b.imports.length, 1);
        assert.deepStrictEqual([b.db.data.settings.llmEndpoints.value[0].apiKey, b.db.data.apiProviders.p3.apiKey], ['', '']);
        assert.match(b.confirms[0].msg, /1 providers \(key cleared for p3 \(different or invalid endpoint\)\): p3/);
    }, { tags: ['unit'] });
    test('S0B3-03 export omits deployDirHandle; a pre-fix backup never replaces or counts it', async function() {
        var ex = await dmExport(DM_KEYS_SEED, 'keys');
        assert.strictEqual(dmByKey(ex.out.settings, 'key', 'deployDirHandle'), undefined);
        assert.strictEqual(dmByKey(ex.out.settings, 'key', 'theme').value, 'dark');
        var h = await dmHarness(DM_KEYS_SEED, true);
        await h.run({ version: 3, chats: [], widgets: [], settings: [{ key: 'deployDirHandle', value: {} }, { key: 'theme', value: 'light' }] });
        assert.match(h.confirms[0].msg, /1 settings: theme/);
        assert.strictEqual(/deployDirHandle|invalid row/.test(h.confirms[0].msg), false);
        assert.strictEqual(h.imports.length, 1);
        assert.strictEqual(h.imports[0].settings.some(function(r) { return r.key === 'deployDirHandle'; }), false);
        assert.deepStrictEqual(h.db.data.settings.deployDirHandle, DM_KEYS_SEED.settings.deployDirHandle);
        assert.strictEqual(h.db.data.settings.theme.value, 'light');
    }, { tags: ['unit'] });
    test('S0B-07 a failed write aborts the writable and shows an error', async function() {
        var h = await dmExport(DM_KEYS_SEED, 'nokeys', { failOnWrite: 2 });
        assert.strictEqual(h.writable.aborted, true);
        assert.strictEqual(h.writable.closed, false);
        var last = h.snacks[h.snacks.length - 1];
        assert.strictEqual(last.kind, 'error');
        assert.match(last.text, /Export failed: disk full/);
    }, { tags: ['unit'] });
    test('S0B-07 attachments that cannot be re-inlined turn the result into a warning', async function() {
        var seed = dmClone(DM_KEYS_SEED);
        seed.chats.c1 = { id: 'c1', title: 'One', _payloadsEvicted: true, screenshots: { s1: { _b64Evicted: true } },
            messages: [{ file_id: 'f1', _b64Evicted: true }, { file_id: 'f2', _b64Evicted: true }] };
        seed.chat_payloads = { f1: { id: 'f1', base64: 'AAAA' } };
        var h = await dmExport(seed, 'nokeys');
        assert.strictEqual(h.writable.closed, true);
        assert.strictEqual(h.out.chats[0].messages[0].base64, 'AAAA');
        var last = h.snacks[h.snacks.length - 1];
        assert.strictEqual(last.kind, 'warning');
        assert.strictEqual(last.text, 'Exported 1 chats; 2 attachments could not be included');
    }, { tags: ['unit'] });
});
