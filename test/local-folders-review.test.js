// Connected folders review fixes (follow-up to #1055):
// 1 write_local / delete approval keys + ask defaults at both gates,
// 2 source reads gated by local_folder:read, 3 read vs readwrite permission
// mode, 4 File System Access error mapping, 7 web_fetch conflicting bodies.

function rvFile(bytes) {
    return { size: bytes.length, type: '', lastModified: 1, arrayBuffer: async function() { return bytes.slice().buffer; } };
}
function rvErr(name, msg) { var e = new Error(msg || name); e.name = name; return e; }
// Fake directory handle. opts.perm(mode) → permission state; opts.fail = {name → Error}.
function rvDir(name, opts) {
    opts = opts || {};
    var kids = {};
    var d = {
        kind: 'directory', name: name, _kids: kids, _queried: [],
        queryPermission: async function(o) { d._queried.push(o && o.mode); return opts.perm ? opts.perm(o && o.mode) : 'granted'; },
        requestPermission: async function() { return 'granted'; },
        getDirectoryHandle: async function(n, o) {
            if (opts.fail && opts.fail[n]) throw opts.fail[n];
            if (kids[n] && kids[n].kind !== 'directory') throw rvErr('TypeMismatchError');
            if (!kids[n]) { if (!(o && o.create)) throw rvErr('NotFoundError'); kids[n] = rvDir(n, { fail: opts.fail }); }
            return kids[n];
        },
        getFileHandle: async function(n, o) {
            if (opts.fail && opts.fail[n]) throw opts.fail[n];
            if (kids[n] && kids[n].kind !== 'file') throw rvErr('TypeMismatchError');
            if (!kids[n]) {
                if (!(o && o.create)) throw rvErr('NotFoundError');
                var fh = { kind: 'file', name: n, _bytes: new Uint8Array(0) };
                fh.getFile = async function() { return rvFile(fh._bytes); };
                fh.createWritable = async function() { var buf; return { write: async function(b) { buf = new Uint8Array(b); }, close: async function() { fh._bytes = buf; } }; };
                kids[n] = fh;
            }
            return kids[n];
        },
        removeEntry: async function(n) { delete kids[n]; },
        values: async function*() { for (var k in kids) yield kids[k]; }
    };
    return d;
}

describe('local folders review: permission keys and defaults (fix 1)', function() {
    test('localFolderPermissionAction: write/mkdir on a real folder → write_local; virtual keeps the action', async function() {
        var m = await runFile('src/js/core/070-permissions.js');
        [undefined, null, '', 'virtual', 'Agent Files'].forEach(function(f) {
            assert.strictEqual(m.localFolderPermissionAction({ action: 'write', folder: f }), 'write', String(f));
            assert.strictEqual(m.localFolderPermissionAction({ action: 'mkdir', folder: f }), 'mkdir', String(f));
        });
        assert.strictEqual(m.localFolderPermissionAction({ action: 'write', folder: 'lf_a' }), 'write_local');
        assert.strictEqual(m.localFolderPermissionAction({ action: 'mkdir', folder: 'Photos' }), 'write_local');
        assert.strictEqual(m.localFolderPermissionAction({ action: 'delete', folder: 'lf_a' }), 'delete');
        assert.strictEqual(m.localFolderPermissionAction({ action: 'read', folder: 'lf_a' }), 'read');
        assert.strictEqual(m.localFolderPermissionAction({}), null);
        assert.strictEqual(m.resolvePermissionKey('local_folder', 'write_local'), 'local_folder:write_local');
        assert.ok(m.GLOBAL_WRITE_KEYS.indexOf('local_folder:write_local') !== -1);
    }, { tags: ['unit'] });

    test('defaults: delete/write_local ask, write/mkdir auto, reads allow', async function() {
        var m = await runFile('src/js/core/070-permissions.js');
        assert.strictEqual(m.getGlobalDefaultPermission('local_folder:delete'), 'ask');
        assert.strictEqual(m.getGlobalDefaultPermission('local_folder:write_local'), 'ask');
        assert.strictEqual(m.getGlobalDefaultPermission('local_folder:write'), 'auto');
        assert.strictEqual(m.getGlobalDefaultPermission('local_folder:mkdir'), 'auto');
        ['list', 'ls', 'read', 'grep', 'request'].forEach(function(a) {
            assert.strictEqual(m.getGlobalDefaultPermission('local_folder:' + a), 'allow', a);
        });
        assert.strictEqual(m.getGlobalDefaultPermission('web_fetch'), 'ask');
        assert.strictEqual(m.getGlobalDefaultPermission('workspace:push'), 'allow');
        assert.strictEqual(m.getGlobalDefaultPermission('get_cookie'), 'allow');
        assert.strictEqual(m.getGlobalDefaultPermission('manage_skill:activate'), 'disabled');
    }, { tags: ['unit'] });

    function twinGlobals() {
        return { document: { addEventListener: function() {} }, window: {}, self: {},
            Platform: { instanceUrl: 'https://example.test/' }, toolPermissions: {}, instancePermissions: {},
            sessionPermissions: {}, chats: {}, hooksEnabled: {}, activeSkills: {}, skills: {}, TOOL_DISPLAY_NAMES: {}, console: console };
    }
    test('both getToolPermission twins resolve the new ask defaults', async function() {
        for (var w = 0; w < 2; w++) {
            var m = await loadModules(['src/js/core/070-permissions.js', 'src/js/core/078-tool-profiles.js',
                'src/js/core/080-tools.js', 'src/js/core/140-skills-engine.js',
                w ? 'src/js/worker/025-permissions-helpers.js' : 'src/js/ui/140-dropdowns.js'], { globals: twinGlobals() });
            var who = w ? 'worker' : 'page';
            assert.strictEqual(m.getToolPermission('local_folder', 'delete'), 'ask', who);
            assert.strictEqual(m.getToolPermission('local_folder', 'write_local'), 'ask', who);
            assert.strictEqual(m.getToolPermission('local_folder', 'write'), 'auto', who);
            assert.strictEqual(m.getToolPermission('local_folder', 'read'), 'allow', who);
        }
    }, { tags: ['unit'] });

    test('page gate (ui/150) asks for write_local on a real folder, write on the virtual one', async function() {
        var seen = [];
        var m = await loadModules(['src/js/core/070-permissions.js', 'src/js/ui/150-tool-approval.js'], { lenient: true, globals: {
            activeStreamingChatId: null, currentChatId: 'c1',
            getToolPermission: function(t, a) { seen.push(t + ':' + a); return 'allow'; },
            getToolDisplayName: function(t, a) { return t + ':' + a; }
        } });
        var r1 = await m.requestProgrammaticToolApproval('local_folder', { action: 'write', folder: 'lf_a', path: 'x' }, {});
        assert.strictEqual(r1.permissionKey, 'local_folder:write_local');
        var r2 = await m.requestProgrammaticToolApproval('local_folder', { action: 'write', path: 'x' }, {});
        assert.strictEqual(r2.permissionKey, 'local_folder:write');
        var r3 = await m.requestProgrammaticToolApproval('local_folder', { action: 'delete', folder: 'virtual', path: 'x' }, {});
        assert.strictEqual(r3.permissionKey, 'local_folder:delete');
        assert.deepStrictEqual(seen, ['local_folder:write_local', 'local_folder:write', 'local_folder:delete']);
    }, { tags: ['unit'] });

    test('worker gate (worker/120) resolves the same write_local key', async function() {
        var seen = [];
        var m = await loadModules(['src/js/core/070-permissions.js', 'src/js/worker/120-tool-routing.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), sessionPermissions: {}, _swPermsDirty: {}, chats: {},
            resolveRootChatId: function(id) { return id; }, persistSessionPermissionsInWorker: function() {}, parkedToolCallsByChatId: {},
            activeStreamingChatId: null,
            getToolPermission: function(t, a) { seen.push(t + ':' + a); return 'allow'; },
            getToolDisplayName: function(t, a) { return t + ':' + a; }
        } });
        var fn = m.requestProgrammaticToolApproval || (m.__scope && m.__scope.requestProgrammaticToolApproval);
        assert.strictEqual(typeof fn, 'function');
        var r = await fn('local_folder', { action: 'mkdir', folder: 'lf_a', path: 'd' }, { chatId: 'c' });
        assert.strictEqual(r.permissionKey, 'local_folder:write_local');
        var v = await fn('local_folder', { action: 'mkdir', folder: 'Agent Files', path: 'd' }, { chatId: 'c' });
        assert.strictEqual(v.permissionKey, 'local_folder:mkdir');
        assert.deepStrictEqual(seen, ['local_folder:write_local', 'local_folder:mkdir']);
    }, { tags: ['unit'] });

    test('local_folder schema exposes confirm', async function() {
        var m = await loadModules(['src/js/core/080-tools.js'], { lenient: true, globals: {} });
        var tools = m.TOOLS || (m.__scope && m.__scope.TOOLS);
        var lf = tools.filter(function(t) { return t.function && t.function.name === 'local_folder'; })[0];
        assert.strictEqual(lf.function.parameters.properties.confirm.type, 'boolean');
    }, { tags: ['unit'] });
});

describe('local folders review: 170 module fixes', function() {
    var m, opfs, row, store;
    function deps(extra) {
        var n = 0;
        return Object.assign({
            getOpfsRoot: async function() { return opfs; },
            readRow: async function() { return row; },
            writeRow: async function(l) { row = l; },
            newFileId: function() { return 'file_r' + (++n); },
            registerFile: function(id, p) { store[id] = p; },
            getFileAsync: async function(id) { var p = store[id]; return p ? { id: id, name: p.name, mime: p.mime, data: p.data } : null; },
            inServiceWorker: false
        }, extra || {});
    }
    beforeEach(async function() {
        m = await runFile('src/js/tools/170-local-folders.js');
        opfs = rvDir('');
        row = [];
        store = {};
        m.lfSetDeps(deps());
    });

    // ── fix 2 ──
    test('source reads call the local_folder:read approval with the calling options', async function() {
        var local = rvDir('docs');
        var fh = await local.getFileHandle('a.bin', { create: true }); fh._bytes = new Uint8Array([1, 2, 3]);
        row = [{ id: 'lf_a', label: 'Docs', access: 'read', handle: local, addedAt: 1 }];
        var calls = [];
        m.lfSetDeps(deps({ approve: async function(t, a, o) { calls.push([t, a, o]); return { allowed: true }; } }));
        var r = await m.lfResolveBinaryInput({ source: { folder: 'lf_a', path: 'a.bin' } }, { chatId: 'chat_x' });
        assert.deepStrictEqual(Array.from(r.bytes), [1, 2, 3]);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0][0], 'local_folder');
        assert.deepStrictEqual(calls[0][1], { action: 'read', folder: 'lf_a', path: 'a.bin' });
        assert.strictEqual(calls[0][2].chatId, 'chat_x');
        // web_fetch body_source goes through the same gate
        await m.lfBuildFetchBody({ body_source: { folder: 'lf_a', path: 'a.bin' } }, { chatId: 'chat_y' });
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[1][2].chatId, 'chat_y');
        // file_id / base64 inputs are not folder reads → no approval
        await m.lfResolveBinaryInput({ base64: 'AQI=' }, {});
        assert.strictEqual(calls.length, 2);
    }, { tags: ['unit'] });

    test('source read refused when approval is denied / permission Off / Ask without a prompt', async function() {
        var fh = await opfs.getDirectoryHandle(m.LOCAL_FOLDER_OPFS_DIR, { create: true });
        await (await fh.getFileHandle('s.txt', { create: true }));
        m.lfSetDeps(deps({ approve: async function() { return { allowed: false, error: 'Local folder read is disabled by user settings' }; } }));
        await assert.rejects(m.lfResolveBinaryInput({ source: { folder: 'virtual', path: 's.txt' } }, {}), function(e) { return e.code === 'PERMISSION_DENIED' && /disabled by user settings/.test(e.message); });
        m.lfSetDeps(deps({ getToolPermission: function() { return 'disabled'; } }));
        await assert.rejects(m.lfResolveBinaryInput({ source: { folder: 'virtual', path: 's.txt' } }, {}), function(e) { return e.code === 'PERMISSION_DENIED' && /Off/.test(e.message); });
        m.lfSetDeps(deps({ getToolPermission: function() { return 'ask'; } }));
        await assert.rejects(m.lfResolveBinaryInput({ source: { folder: 'virtual', path: 's.txt' } }, {}), function(e) { return e.code === 'PERMISSION_DENIED' && /approval/.test(e.message); });
        m.lfSetDeps(deps({ getToolPermission: function() { return 'allow'; } }));
        var ok = await m.lfResolveBinaryInput({ source: { folder: 'virtual', path: 's.txt' } }, {});
        assert.strictEqual(ok.bytes.length, 0);
    }, { tags: ['unit'] });

    // ── fix 3 ──
    test('read ops query "read" permission; write/mkdir/delete query "readwrite"', async function() {
        var local = rvDir('proj', { perm: function(mode) { return mode === 'read' ? 'granted' : 'prompt'; } });
        row = [{ id: 'lf_rw', label: 'Proj', access: 'readwrite', handle: local, addedAt: 1 }];
        local._kids['a.txt'] = { kind: 'file', name: 'a.txt', getFile: async function() { return rvFile(new TextEncoder().encode('hi')); } };
        var ls = await m.executeLocalFolder({ action: 'ls', folder: 'lf_rw' });
        assert.strictEqual(ls.success, true, JSON.stringify(ls));
        var rd = await m.executeLocalFolder({ action: 'read', folder: 'lf_rw', path: 'a.txt' });
        assert.strictEqual(rd.content, 'hi');
        var gr = await m.executeLocalFolder({ action: 'grep', folder: 'lf_rw', pattern: 'h' });
        assert.strictEqual(gr.success, true, JSON.stringify(gr));
        assert.ok(local._queried.every(function(q) { return q === 'read'; }), JSON.stringify(local._queried));
        local._queried.length = 0;
        var w = await m.executeLocalFolder({ action: 'write', folder: 'lf_rw', path: 'b.txt', content: 'x' });
        assert.strictEqual(w.code, 'PERMISSION_REQUIRED', JSON.stringify(w));
        var mk = await m.executeLocalFolder({ action: 'mkdir', folder: 'lf_rw', path: 'd' });
        assert.strictEqual(mk.code, 'PERMISSION_REQUIRED');
        var del = await m.executeLocalFolder({ action: 'delete', folder: 'lf_rw', path: 'a.txt' });
        assert.strictEqual(del.code, 'PERMISSION_REQUIRED');
        assert.deepStrictEqual(local._queried, ['readwrite', 'readwrite', 'readwrite']);
    }, { tags: ['unit'] });

    // ── fix 4 ──
    test('error mapping: TypeMismatch → NOT_A_DIRECTORY/NOT_A_FILE, NotFound → NOT_FOUND, NotAllowed → PERMISSION_REQUIRED (page)', async function() {
        var root = rvDir('');
        await root.getFileHandle('f.txt', { create: true });
        await root.getDirectoryHandle('sub', { create: true });
        await assert.rejects(m._lfDirAt(root, ['f.txt'], false), function(e) { return e.code === 'NOT_A_DIRECTORY'; });
        await assert.rejects(m._lfFileAt(root, ['sub'], false), function(e) { return e.code === 'NOT_A_FILE'; });
        await assert.rejects(m._lfFileAt(root, ['nope.txt'], false), function(e) { return e.code === 'NOT_FOUND'; });
        await assert.rejects(m._lfDirAt(root, ['nope'], false), function(e) { return e.code === 'NOT_FOUND'; });
        var denied = rvDir('', { fail: { x: rvErr('NotAllowedError') } });
        await assert.rejects(m._lfFileAt(denied, ['x'], false), function(e) { return e.code === 'PERMISSION_REQUIRED'; });
        await assert.rejects(m._lfDirAt(denied, ['x'], false), function(e) { return e.code === 'PERMISSION_REQUIRED'; });
    }, { tags: ['unit'] });

    test('error mapping keeps SecurityError / "not a function" raw, and NotAllowedError raw in the SW (panel fallback)', async function() {
        var sec = rvErr('SecurityError');
        var nf = new TypeError('d.getFileHandle is not a function');
        var na = rvErr('NotAllowedError');
        var root = rvDir('', { fail: { s: sec, n: nf, a: na } });
        await assert.rejects(m._lfFileAt(root, ['s'], false), function(e) { return e === sec; });
        await assert.rejects(m._lfDirAt(root, ['n'], false), function(e) { return e === nf; });
        assert.strictEqual(m.lfMapHandleError(na, 'file', 'a').code, 'PERMISSION_REQUIRED', 'page maps NotAllowedError');
        assert.strictEqual(m.lfMapHandleError(sec, 'file', 's'), sec, 'SecurityError stays raw on the page too');
        m.lfSetDeps(deps({ inServiceWorker: true }));
        await assert.rejects(m._lfFileAt(root, ['a'], false), function(e) { return e === na; });
        assert.strictEqual(m.lfShouldRouteToPanel(na, { inServiceWorker: true, action: 'read' }), true);
        // End to end: the SW routes a NotAllowedError read to the panel; the panel maps it.
        row = [{ id: 'lf_a', label: 'A', access: 'read', handle: root, addedAt: 1 }];
        var sw = await m.executeLocalFolder({ action: 'read', folder: 'lf_a', path: 'a' });
        assert.strictEqual(sw._route_to_panel, true, JSON.stringify(sw));
        m.lfSetDeps(deps({ inServiceWorker: false }));
        var page = await m.executeLocalFolder({ action: 'read', folder: 'lf_a', path: 'a', _lf_panel_fallback: true });
        assert.strictEqual(page.code, 'PERMISSION_REQUIRED', JSON.stringify(page));
    }, { tags: ['unit'] });

    // ── fixes 5/6 (cheap coverage) ──
    test('lfIsBinary: multi-byte char cut at the 8000-byte sample is text; invalid UTF-8 is binary', async function() {
        var s = 'a'.repeat(7999) + '\u00e9' + 'tail';
        assert.strictEqual(m.lfIsBinary('x.unknownext', new TextEncoder().encode(s)), false);
        assert.strictEqual(m.lfIsBinary('x.unknownext', new Uint8Array([0x41, 0xff, 0xfe, 0x41])), true);
    }, { tags: ['unit'] });

    test('read encoding:base64 omits data_url above ~1 MB and points to file_id', async function() {
        var dir = await opfs.getDirectoryHandle(m.LOCAL_FOLDER_OPFS_DIR, { create: true });
        var big = await dir.getFileHandle('big.bin', { create: true }); big._bytes = new Uint8Array(900 * 1024);
        var small = await dir.getFileHandle('small.bin', { create: true }); small._bytes = new Uint8Array(10);
        var rb = await m.executeLocalFolder({ action: 'read', path: 'big.bin', encoding: 'base64' });
        assert.strictEqual(rb.data_url, undefined);
        assert.strictEqual(rb.data_url_omitted, true);
        assert.ok(rb.file_id && /file_id/.test(rb.note), JSON.stringify(Object.keys(rb)));
        var rs = await m.executeLocalFolder({ action: 'read', path: 'small.bin', encoding: 'base64' });
        assert.match(rs.data_url, /^data:/);
    }, { tags: ['unit'] });

    // ── fix 7 ──
    test('lfFetchBodyConflict: form/body_* with GET/DELETE or with body is a clear error', async function() {
        assert.strictEqual(m.lfFetchBodyConflict({ method: 'POST', body: 'x' }), null);
        assert.strictEqual(m.lfFetchBodyConflict({ method: 'GET' }), null);
        assert.strictEqual(m.lfFetchBodyConflict({ method: 'POST', body_file_id: 'f' }), null);
        assert.strictEqual(m.lfFetchBodyConflict({ method: 'put', form: { a: '1' } }), null);
        assert.match(m.lfFetchBodyConflict({ body_file_id: 'f' }), /needs method POST, PUT or PATCH \(got GET\)/);
        assert.match(m.lfFetchBodyConflict({ method: 'DELETE', form: { a: 1 } }), /form needs method/);
        assert.match(m.lfFetchBodyConflict({ method: 'POST', body: 'x', body_base64: 'AA==' }), /either body OR body_base64/);
        assert.match(m.lfFetchBodyConflict({ method: 'POST', form: { a: 1 }, body_source: { folder: 'v', path: 'p' } }), /only one of form, body_source/);
    }, { tags: ['unit'] });
});
