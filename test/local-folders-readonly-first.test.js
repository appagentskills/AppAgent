// local_folder: write/mkdir/delete on a READ-ONLY folder are refused with
// READ_ONLY before any permission query (tools/170 lfResolveFolder) and
// without an approval prompt (ui/150 + worker/120 via lfIsReadOnlyWriteTarget).

function roDir(name, perm) {
    var d = {
        kind: 'directory', name: name, _queried: 0, _requested: 0,
        queryPermission: async function() { d._queried++; return perm || 'prompt'; },
        requestPermission: async function() { d._requested++; return 'granted'; },
        getDirectoryHandle: async function() { throw new Error('should not be reached'); },
        getFileHandle: async function() { throw new Error('should not be reached'); },
        removeEntry: async function() { throw new Error('should not be reached'); },
        values: async function*() {}
    };
    return d;
}

describe('local_folder read-only folders: READ_ONLY first', function() {
    var lf, row, ro, rw, approvals;
    beforeEach(async function() {
        lf = await runFile('src/js/tools/170-local-folders.js');
        ro = roDir('ro', 'prompt');
        rw = roDir('rw', 'granted');
        row = [
            { id: 'lf_ro', label: 'Photos', access: 'read', handle: ro, addedAt: 1 },
            { id: 'lf_rw', label: 'Work', access: 'readwrite', handle: rw, addedAt: 2 }
        ];
        approvals = [];
        lf.lfSetDeps({
            readRow: async function() { return row; },
            writeRow: async function(l) { row = l; },
            getOpfsRoot: async function() { return roDir(''); },
            approve: async function(t, a) { approvals.push([t, a]); return { allowed: true }; },
            registerFile: function() {}, newFileId: function() { return 'f1'; },
            getFileAsync: async function() { return null; },
            inServiceWorker: false
        });
    });

    test('write/mkdir/delete (by id and label) return READ_ONLY and never query permission', async function() {
        var calls = [
            { action: 'write', folder: 'lf_ro', path: 'x.txt', content: 'hi' },
            { action: 'write', folder: 'lf_ro', path: 'x.txt', source: { folder: 'lf_rw', path: 'a' } },
            { action: 'mkdir', folder: 'lf_ro', path: 'd' },
            { action: 'delete', folder: 'Photos', path: 'x.txt' }
        ];
        for (var i = 0; i < calls.length; i++) {
            var r = await lf.executeLocalFolder(calls[i], {});
            assert.strictEqual(r.success, false, JSON.stringify(calls[i]));
            assert.strictEqual(r.code, 'READ_ONLY', JSON.stringify(calls[i]) + ' → ' + r.code);
        }
        assert.strictEqual(ro._queried, 0, 'queryPermission must not be called');
        assert.strictEqual(ro._requested, 0);
        assert.strictEqual(approvals.length, 0, 'write source must not be read (no read approval)');
    }, { tags: ['unit'] });

    test('reads on the read-only folder still query permission (unchanged)', async function() {
        var r = await lf.executeLocalFolder({ action: 'ls', folder: 'lf_ro' }, {});
        assert.strictEqual(r.code, 'PERMISSION_REQUIRED');
        assert.strictEqual(ro._queried, 1);
    }, { tags: ['unit'] });

    test('lfIsReadOnlyWriteTarget: true only for a registered access:read folder', async function() {
        var f = lf.lfIsReadOnlyWriteTarget;
        assert.strictEqual(await f({ action: 'write', folder: 'lf_ro' }), true);
        assert.strictEqual(await f({ action: 'mkdir', folder: 'photos' }), true);
        assert.strictEqual(await f({ action: 'delete', folder: 'lf_ro' }), true);
        assert.strictEqual(await f({ action: 'read', folder: 'lf_ro' }), false);
        assert.strictEqual(await f({ action: 'write', folder: 'lf_rw' }), false);
        assert.strictEqual(await f({ action: 'write', folder: 'lf_nope' }), false);
        var virt = [undefined, null, '', 'virtual', 'Agent Files'];
        for (var i = 0; i < virt.length; i++) assert.strictEqual(await f({ action: 'write', folder: virt[i] }), false, String(virt[i]));
        assert.strictEqual(ro._queried + rw._queried, 0);
        lf.lfSetDeps({ readRow: async function() { throw new Error('idb down'); } });
        assert.strictEqual(await f({ action: 'write', folder: 'lf_ro' }), false, 'registry failure keeps asking');
    }, { tags: ['unit'] });

    function pageGate(perm, prompts) {
        return loadModules(['src/js/core/070-permissions.js', 'src/js/ui/150-tool-approval.js'], { lenient: true, globals: {
            activeStreamingChatId: null, currentChatId: 'c1', chats: {},
            lfIsReadOnlyWriteTarget: lf.lfIsReadOnlyWriteTarget,
            getToolPermission: function() { return perm; },
            getToolDisplayName: function(t, a) { return t + ':' + a; },
            showToolApprovalPrompt: async function(d, a, k) { prompts.push(k); return true; }
        } });
    }

    test('page gate: read-only target skips the prompt; readwrite still asks; virtual stays auto', async function() {
        var prompts = [];
        var m = await pageGate('ask', prompts);
        var fn = m.requestProgrammaticToolApproval;
        var a = await fn('local_folder', { action: 'write', folder: 'lf_muo349b7wz8v_ro', path: 'x' }, {});
        assert.strictEqual(prompts.length, 1, 'unknown folder still asks');
        row.push({ id: 'lf_muo349b7wz8v_ro', label: 'RO2', access: 'read', handle: roDir('x'), addedAt: 3 });
        var ro1 = await fn('local_folder', { action: 'write', folder: 'lf_muo349b7wz8v_ro', path: 'x' }, {});
        var ro2 = await fn('local_folder', { action: 'delete', folder: 'lf_ro', path: 'x', confirm: true }, {});
        var ro3 = await fn('local_folder', { action: 'mkdir', folder: 'Photos', path: 'd' }, {});
        [ro1, ro2, ro3].forEach(function(r) { assert.strictEqual(r.allowed, true); assert.strictEqual(r.permission, 'allow'); });
        assert.strictEqual(prompts.length, 1, 'no prompt for read-only targets');
        var w = await fn('local_folder', { action: 'write', folder: 'lf_rw', path: 'x' }, {});
        assert.strictEqual(w.permission, 'ask');
        assert.deepStrictEqual(prompts, ['local_folder:write_local', 'local_folder:write_local']);
        assert.ok(a.allowed);
        var pm = await pageGate('auto', prompts);
        var v = await pm.requestProgrammaticToolApproval('local_folder', { action: 'write', path: 'x' }, {});
        assert.strictEqual(v.permissionKey, 'local_folder:write');
        assert.strictEqual(v.permission, 'auto');
        assert.strictEqual(v.allowed, true);
        assert.strictEqual(prompts.length, 2);
        var dm = await pageGate('disabled', prompts);
        var d = await dm.requestProgrammaticToolApproval('local_folder', { action: 'write', folder: 'lf_ro', path: 'x' }, {});
        assert.strictEqual(d.allowed, false, 'an explicit Off still wins');
    }, { tags: ['unit'] });

    test('worker gate: read-only target is allowed without prompting', async function() {
        var m = await loadModules(['src/js/core/070-permissions.js', 'src/js/worker/120-tool-routing.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), sessionPermissions: {}, _swPermsDirty: {}, chats: {},
            resolveRootChatId: function(id) { return id; }, persistSessionPermissionsInWorker: function() {}, parkedToolCallsByChatId: {},
            activeStreamingChatId: null,
            lfIsReadOnlyWriteTarget: lf.lfIsReadOnlyWriteTarget,
            getToolPermission: function() { return 'ask'; },
            getToolDisplayName: function(t, a) { return t + ':' + a; }
        } });
        var fn = m.requestProgrammaticToolApproval || (m.__scope && m.__scope.requestProgrammaticToolApproval);
        var r = await fn('local_folder', { action: 'write', folder: 'lf_ro', path: 'x' }, { chatId: 'c' });
        assert.strictEqual(r.allowed, true);
        assert.strictEqual(r.permission, 'allow');
        assert.strictEqual(r.permissionKey, 'local_folder:write_local');
        assert.strictEqual(await lf.lfIsReadOnlyWriteTarget({ action: 'write', folder: 'lf_rw' }), false, 'readwrite is not downgraded');
        assert.strictEqual(ro._queried, 0);
    }, { tags: ['unit'] });
});
