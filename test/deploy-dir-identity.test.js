// S0B3-01 — deploy/Reload must not write into a connected folder that is not
// an AppAgent build. Real core/130 checkDeployDirIdentity + pickDeployDir +
// clearDeployDirHandle, real tools/020 wsDeploy and real ui/130
// DEVICE_LOCAL_SETTING_KEYS; the folder handle, picker, IDB and confirm modal
// are simulated.
describe('deploy dir identity (S0B3-01)', function() {
    var OWN_NAME = 'AppAgent for ServiceNow';
    var m, rows, own, chromeObj, confirms, confirmAnswer, win, W = null, st;
    function nf(n) { var e = new Error('NotFoundError: ' + n); e.name = 'NotFoundError'; return e; }
    // Fake FileSystemDirectoryHandle: counts writes/removes, records reads.
    // R-C4d #5: like the real API, a created subfolder becomes an entry of its
    // parent and written content is kept.
    function dir(files, name) {
        var subs = {};
        var d = { name: name || 'dest', kind: 'directory', reads: [], writes: 0, removes: 0, files: files, subs: subs,
            queryPermission: async function() { return 'granted'; },
            entries: async function*() { for (var k of Object.keys(files)) yield [k, { kind: 'file', name: k }]; for (var s of Object.keys(subs)) yield [s, subs[s]]; },
            values: async function*() { for (var k of Object.keys(files)) yield { kind: 'file', name: k }; for (var s of Object.keys(subs)) yield subs[s]; },
            getFileHandle: async function(n, o) {
                if (!Object.prototype.hasOwnProperty.call(files, n)) { if (o && o.create) { d.writes++; files[n] = ''; } else throw nf(n); }
                return { kind: 'file', name: n,
                    getFile: async function() { d.reads.push(n); return { size: files[n].length, text: async function() { return files[n]; } }; },
                    createWritable: async function() { d.writes++; return { write: async function(v) { files[n] = String(v); }, close: async function() {} }; } };
            },
            getDirectoryHandle: async function(n, o) { if (subs[n]) return subs[n]; if (o && o.create) { d.writes++; return (subs[n] = dir({}, n)); } throw nf(n); },
            removeEntry: async function(n) { d.removes++; delete files[n]; }
        };
        return d;
    }
    function manifest(o) { return JSON.stringify(o); }
    beforeEach(async function() {
        rows = {}; own = { name: OWN_NAME }; confirms = []; confirmAnswer = false; win = {};
        chromeObj = { runtime: { getManifest: function() { return own; } } };
        st = { handle: null, ok: undefined, filesCalls: 0, files: [] };
        // Fake IDB (as deploy-dir-handle.test.js): 'complete' once requests settle.
        var database = { close: function() {}, transaction: function() {
            var listeners = {}, pending = 0, done = false, tx;
            function fire(t) { (listeners[t] || []).forEach(function(l) { l({}); }); }
            function settled() { pending--; queueMicrotask(function() { if (done || pending > 0) return; done = true; fire('complete'); }); }
            function request(fill) { var r = {}; pending++; queueMicrotask(function() { fill(r); settled(); }); return r; }
            pending++; queueMicrotask(settled);
            tx = { addEventListener: function(t, f) { (listeners[t] = listeners[t] || []).push(f); }, abort: function() {}, error: null, objectStore: function() { return {
                get: function(k) { return request(function(r) { r.result = rows[k]; r.onsuccess && r.onsuccess(); }); },
                put: function(row) { rows[row.key] = row; return request(function(r) { r.onsuccess && r.onsuccess(); }); },
                delete: function(k) { delete rows[k]; return request(function(r) { r.onsuccess && r.onsuccess(); }); }
            }; } };
            return tx;
        } };
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js', 'src/js/core/130-indexeddb.js'], { globals: {
            STORAGE_PREFIX: 'test_', self: {}, window: win, chrome: chromeObj,
            showConfirmModal: async function(t, msg, v) { confirms.push({ title: t, msg: msg, variant: v }); return confirmAnswer; },
            indexedDB: { open: function() { var r = { result: database }; queueMicrotask(function() { r.onsuccess(); }); return r; } },
            chats: {}, activeStreamingChatId: null, currentChatId: null,
            console: { error: function() {}, warn: function() {}, log: function() {} }
        } });
    });
    // Real 020 wsDeploy wired to the real (current) 130 identity probe.
    async function load020() {
        if (!W) W = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(),
            getDeployDirHandle: async function() { return st.handle; },
            getAllWorkspaceFiles: async function() { st.filesCalls++; return st.files; },
            getWorkspaceMeta: async function() { return { branch: 'main', github_repo: 'example-org/AppAgent' }; },
            getSetting: async function(k, dflt) { return k === 'deployDirForeignOk' ? st.ok : dflt; },
            setSetting: async function(k, v) { if (k === 'deployDirForeignOk') st.ok = v; },
            checkDeployDirIdentity: function(h, i) { return m.checkDeployDirIdentity(h, i); }
        } });
        return W;
    }

    test('S0B3-01 identity is unknown without the handle or manifest API', async function() {
        assert.strictEqual(await m.checkDeployDirIdentity({ name: 'old-stub', queryPermission: async function() { return 'granted'; } }), 'unknown');
        chromeObj.runtime.getManifest = undefined;
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'x.txt': 'x' })), 'unknown');
    }, { tags: ['unit'] });

    test('S0B3-01 empty folder is empty; same manifest name matches (reads only manifest.json)', async function() {
        assert.strictEqual(await m.checkDeployDirIdentity(dir({})), 'empty');
        var d = dir({ 'manifest.json': manifest({ name: OWN_NAME }), 'app.js': 'x' }), info = {};
        assert.strictEqual(await m.checkDeployDirIdentity(d, info), 'match');
        assert.strictEqual(info.name, OWN_NAME);
        assert.deepStrictEqual(d.reads, ['manifest.json']);
        assert.strictEqual(d.writes + d.removes, 0);
    }, { tags: ['unit'] });

    test('S0B3-01 manifest key decides over name and build markers', async function() {
        own = { name: OWN_NAME, key: 'K1' };
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'manifest.json': manifest({ name: OWN_NAME, key: 'K2' }), 'sw-bundle.js': 'x', 'app.html': 'y' })), 'foreign');
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'manifest.json': manifest({ name: 'Renamed', key: 'K1' }) })), 'match');
    }, { tags: ['unit'] });

    test('S0B3-01 build markers match without a usable manifest and are never read', async function() {
        var d = dir({ 'sw-bundle.js': 'x', 'app.html': 'y', 'manifest.json': '{not json' });
        assert.strictEqual(await m.checkDeployDirIdentity(d), 'match');
        assert.deepStrictEqual(d.reads, ['manifest.json']);
        var d2 = dir({ 'app.html': 'y', 'notes.txt': 'z' });
        assert.strictEqual(await m.checkDeployDirIdentity(d2), 'foreign');
        assert.deepStrictEqual(d2.reads, []);
    }, { tags: ['unit'] });

    test('S0B3-01 wsDeploy refuses a foreign folder before any write or prune; consent lets it proceed', async function() {
        var w = await load020();
        var d = dir({ 'manifest.json': manifest({ name: 'Other Extension' }), 'app.js': 'keep', 'icons': 'keep' });
        st.handle = d;
        var r = await w.wsDeploy('example-org/AppAgent::main');
        assert.strictEqual(r.success, false);
        assert.match(r.error, /does not look like an AppAgent build \(manifest "Other Extension"\)/);
        assert.strictEqual(st.filesCalls, 0, 'refused before reading workspace files');
        assert.strictEqual(d.writes, 0); assert.strictEqual(d.removes, 0);
        st.ok = true;
        r = await w.wsDeploy('example-org/AppAgent::main');
        assert.strictEqual(st.filesCalls, 1);
        assert.match(r.error, /No files in workspace/);
    }, { tags: ['unit'], timeout: 20000 });

    test('S0B3-01 wsDeploy proceeds for an empty or matching folder', async function() {
        var w = await load020();
        st.handle = dir({});
        await w.wsDeploy('example-org/AppAgent::main');
        assert.strictEqual(st.filesCalls, 1);
        assert.strictEqual(st.ok, true, 'R-C4d #1: empty-folder consent persisted before the first write');
        st.ok = undefined;
        st.handle = dir({ 'manifest.json': manifest({ name: OWN_NAME }) });
        await w.wsDeploy('example-org/AppAgent::main');
        assert.strictEqual(st.filesCalls, 2);
        assert.strictEqual(st.ok, undefined, 'a matching folder records no consent');
    }, { tags: ['unit'], timeout: 20000 });

    test('S0B3-01 R-C4d#1 first build into ONE empty folder: icons (dest) deploy then root deploy both succeed; a foreign folder is still refused', async function() {
        var w = await load020();
        var d = dir({}, 'fresh');
        st.handle = d; // a handle saved before the fix: no consent row
        st.files = [
            { path: 'src/platform/extension/icons/icon16.png', content: 'png16' },
            { path: 'dist/extension/manifest.json', content: manifest({ name: OWN_NAME }) },
            { path: 'dist/extension/app.html', content: '<html></html>' }
        ];
        var r1 = await w.wsDeploy('example-org/AppAgent::main', 'src/platform/extension/icons', 'icons');
        assert.strictEqual(r1.success, true, r1.error);
        assert.strictEqual(st.ok, true, 'consent persisted before the first write');
        assert.strictEqual(d.subs.icons.files['icon16.png'], 'png16');
        assert.strictEqual(await m.checkDeployDirIdentity(d), 'foreign', 'icons/ alone reads as foreign');
        var r2 = await w.wsDeploy('example-org/AppAgent::main');
        assert.strictEqual(r2.success, true, r2.error);
        assert.strictEqual(d.files['manifest.json'], manifest({ name: OWN_NAME }));
        assert.strictEqual(await m.checkDeployDirIdentity(d), 'match');
        var f = dir({ 'manifest.json': manifest({ name: 'Other Extension' }), 'notes.txt': 'mine' }, 'other');
        st.handle = f; st.ok = undefined;
        var r3 = await w.wsDeploy('example-org/AppAgent::main', 'src/platform/extension/icons', 'icons');
        var r4 = await w.wsDeploy('example-org/AppAgent::main');
        assert.strictEqual(r3.success, false);
        assert.strictEqual(r4.success, false);
        assert.match(r4.error, /does not look like an AppAgent build/);
        assert.strictEqual(st.ok, undefined, 'no consent recorded for a foreign folder');
        assert.strictEqual(f.writes + f.removes, 0);
    }, { tags: ['unit'], timeout: 20000 });

    test('S0B3-01 R-C4d#1 connecting an EMPTY folder records consent without a prompt', async function() {
        var d = dir({}, 'fresh');
        win.showDirectoryPicker = async function() { return d; };
        assert.strictEqual(await m.pickDeployDir(), d);
        assert.strictEqual(confirms.length, 0);
        assert.strictEqual(rows.deployDirHandle.value, d);
        assert.strictEqual(rows.deployDirForeignOk.value, true);
    }, { tags: ['unit'] });

    test('S0B3-01 R-C4d#2 build markers never override an explicit manifest-name mismatch', async function() {
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'manifest.json': manifest({ name: 'Other Extension' }), 'sw-bundle.js': 'x', 'app.html': 'y' })), 'foreign');
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'manifest.json': manifest({ version: '1.0' }), 'sw-bundle.js': 'x', 'app.html': 'y' })), 'match');
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'sw-bundle.js': 'x', 'app.html': 'y' })), 'match');
    }, { tags: ['unit'] });

    // chrome.i18n manifests (#1047): "name": "__MSG_extName__" + default_locale.
    var MSG_NAME = '__MSG_extName__';
    function i18nDir(files, msgs, loc) {
        var d = dir(files);
        if (msgs) {
            var l = d.subs._locales = dir({}, '_locales');
            l.subs[loc || 'en'] = dir({ 'messages.json': JSON.stringify(msgs) }, loc || 'en');
        }
        return d;
    }

    test('i18n: raw __MSG_ name on disk vs a localized running name', async function() {
        own = { name: OWN_NAME };
        // Resolves from the folder's _locales/<default_locale>/messages.json (key is case-insensitive like Chrome).
        var d = i18nDir({ 'manifest.json': manifest({ name: MSG_NAME, default_locale: 'en' }) }, { extname: { message: OWN_NAME } }), info = {};
        assert.strictEqual(await m.checkDeployDirIdentity(d, info), 'match');
        assert.strictEqual(info.name, OWN_NAME, 'info.name is the resolved name');
        assert.strictEqual(d.writes + d.removes, 0, 'read-only');
        // Unresolvable placeholder (no _locales): not foreign by name -> build markers decide.
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'manifest.json': manifest({ name: MSG_NAME, default_locale: 'en' }), 'sw-bundle.js': 'x', 'app.html': 'y' })), 'match');
        // Placeholder resolving to a different name still falls through to the markers (transition: old ext running, new manifest on disk).
        assert.strictEqual(await m.checkDeployDirIdentity(i18nDir({ 'manifest.json': manifest({ name: MSG_NAME, default_locale: 'en' }), 'sw-bundle.js': 'x', 'app.html': 'y' }, { extName: { message: 'AppAgent pour ServiceNow' } })), 'match');
        // No name match and no build markers -> still 'foreign' (existing fallback).
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'manifest.json': manifest({ name: MSG_NAME, default_locale: 'en' }), 'notes.txt': 'z' })), 'foreign');
        // A bogus default_locale is never used as a path.
        assert.strictEqual(await m.checkDeployDirIdentity(i18nDir({ 'manifest.json': manifest({ name: MSG_NAME, default_locale: '../x' }) }, { extName: { message: OWN_NAME } }, '../x')), 'foreign');
    }, { tags: ['unit'] });

    test('i18n: __MSG_ name on both sides (and running side unlocalized)', async function() {
        own = { name: MSG_NAME, default_locale: 'en' };
        var d = dir({ 'manifest.json': manifest({ name: MSG_NAME, default_locale: 'en' }) });
        assert.strictEqual(await m.checkDeployDirIdentity(d), 'match', 'identical placeholders match');
        assert.deepStrictEqual(d.reads, ['manifest.json']);
        // Running placeholder resolved via chrome.i18n.getMessage vs a plain name on disk.
        chromeObj.i18n = { getMessage: function(k) { return k === 'extName' ? OWN_NAME : ''; } };
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'manifest.json': manifest({ name: OWN_NAME }) })), 'match');
        // Different placeholder keys, both resolving to the same name.
        assert.strictEqual(await m.checkDeployDirIdentity(i18nDir({ 'manifest.json': manifest({ name: '__MSG_appName__', default_locale: 'en' }) }, { appName: { message: OWN_NAME } })), 'match');
        // Running placeholder unresolvable: a plain mismatch is not decided by name -> markers.
        chromeObj.i18n = undefined;
        assert.strictEqual(await m.checkDeployDirIdentity(dir({ 'manifest.json': manifest({ name: 'Old Name' }), 'sw-bundle.js': 'x', 'app.html': 'y' })), 'match');
    }, { tags: ['unit'] });

    test('i18n: a real foreign plain name is still foreign (markers and _locales do not override)', async function() {
        own = { name: OWN_NAME };
        var d = i18nDir({ 'manifest.json': manifest({ name: 'Other Extension', default_locale: 'en' }), 'sw-bundle.js': 'x', 'app.html': 'y' }, { extName: { message: OWN_NAME } }), info = {};
        assert.strictEqual(await m.checkDeployDirIdentity(d, info), 'foreign');
        assert.strictEqual(info.name, 'Other Extension');
        assert.deepStrictEqual(d.reads, ['manifest.json'], 'plain names never read _locales');
        // A foreign __MSG_ manifest resolving to another name, without build markers.
        assert.strictEqual(await m.checkDeployDirIdentity(i18nDir({ 'manifest.json': manifest({ name: MSG_NAME, default_locale: 'en' }), 'notes.txt': 'z' }, { extName: { message: 'Other Extension' } })), 'foreign');
    }, { tags: ['unit'] });

    test('i18n: wsDeploy proceeds into a folder whose manifest name is __MSG_extName__', async function() {
        var w = await load020();
        own = { name: OWN_NAME };
        st.handle = i18nDir({ 'manifest.json': manifest({ name: MSG_NAME, default_locale: 'en' }) }, { extName: { message: OWN_NAME } });
        var r = await w.wsDeploy('example-org/AppAgent::main');
        assert.strictEqual(st.filesCalls, 1, 'not refused as foreign');
        assert.match(r.error, /No files in workspace/);
        assert.strictEqual(st.ok, undefined, 'a matching folder records no consent');
    }, { tags: ['unit'], timeout: 20000 });

    test('S0B3-01 R-C4d#3 the confirm escapes the folder and manifest names', async function() {
        var d = dir({ 'manifest.json': manifest({ name: '<template>x</template>' }) }, '<b>Docs</b>');
        win.showDirectoryPicker = async function() { return d; };
        assert.strictEqual(await m.pickDeployDir(), null);
        var msg = confirms[0].msg;
        assert.ok(!/<template>|<b>/.test(msg), msg);
        assert.match(msg, /(&#60;|&lt;)template(&#62;|&gt;)x/);
        assert.match(msg, /(&#60;|&lt;)b(&#62;|&gt;)Docs/);
    }, { tags: ['unit'] });

    test('S0B3-01 pickDeployDir: a foreign folder needs a danger confirm; cancel stores nothing', async function() {
        var d = dir({ 'manifest.json': manifest({ name: 'Other Extension' }) }, 'Documents');
        win.showDirectoryPicker = async function() { return d; };
        assert.strictEqual(await m.pickDeployDir(), null);
        assert.strictEqual(confirms.length, 1);
        assert.strictEqual(confirms[0].variant, 'danger');
        assert.match(confirms[0].msg, /Other Extension/);
        assert.strictEqual(rows.deployDirHandle, undefined);
        assert.strictEqual(rows.deployDirForeignOk, undefined);
        confirmAnswer = true;
        assert.strictEqual(await m.pickDeployDir(), d);
        assert.strictEqual(rows.deployDirHandle.value, d);
        assert.strictEqual(rows.deployDirForeignOk.value, true);
        assert.strictEqual(d.writes + d.removes, 0);
    }, { tags: ['unit'] });

    test('S0B3-01 pickDeployDir: a matching folder connects without a prompt and resets consent; disconnect clears both rows', async function() {
        rows.deployDirForeignOk = { key: 'deployDirForeignOk', value: true };
        var d = dir({ 'manifest.json': manifest({ name: OWN_NAME }) });
        win.showDirectoryPicker = async function() { return d; };
        assert.strictEqual(await m.pickDeployDir(), d);
        assert.strictEqual(confirms.length, 0);
        assert.strictEqual(rows.deployDirForeignOk.value, false);
        await m.clearDeployDirHandle();
        assert.strictEqual(rows.deployDirHandle, undefined);
        assert.strictEqual(rows.deployDirForeignOk, undefined);
    }, { tags: ['unit'] });

    test('S0B3-01 deployDirForeignOk is device-local (never exported or imported)', async function() {
        var dm = await loadModules(['src/js/ui/130-data-management.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(dm._isDeviceLocalSetting({ key: 'deployDirForeignOk', value: true }), true);
        assert.strictEqual(dm._isDeviceLocalSetting({ key: 'deployDirHandle', value: {} }), true);
        assert.strictEqual(dm._isDeviceLocalSetting({ key: 'theme', value: 'dark' }), false);
    }, { tags: ['unit'] });
});
