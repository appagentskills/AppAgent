// workspace action `delete_workspace` (tools/020-tool-execution.js). Evaluates
// the REAL function texts cut out of the source (same pattern as
// test/ws-fork-never-pushed.test.js) with stubbed collaborators.

function _cutFns(src, names) {
    return names.map(function(name) {
        var re = new RegExp('^(async )?function ' + name + '\\(', 'm');
        var m = re.exec(src);
        if (!m) throw new Error('function not found: ' + name);
        var end = src.indexOf('\n}\n', m.index);
        if (end === -1) throw new Error('function end not found: ' + name);
        return src.slice(m.index, end + 2);
    }).join('\n');
}

function _parseWsKey(wk) {
    var s = String(wk).split('::');
    return { repo: s[0], branch: s[1] };
}

// opts: { meta, files, filesAfter (2nd getAllWorkspaceFiles read), metas,
//   metaByWk: {wk: meta} (getWorkspaceMeta for other wks, e.g. PR-record target),
//   conflicts: {path: {hard, last_modified_by_chat_id}} (every phase),
//   recheckConflicts (final re-scan only), txConflicts / txRows (inside the
//   stubbed deleteWorkspaceIfClean transaction), keptDirty, defaultBranch,
//   apiHang (githubApi never resolves; stub timer fires), apiThrow, guard }
// log.order records 'files' (getAllWorkspaceFiles), 'metas' (getAllWorkspaceMetas),
// 'setMeta' and 'delete'. filesAfter is only served once getAllWorkspaceMetas
// has resolved (a re-scan that runs before the target lookup gets stale rows).
async function _delEnv(opts) {
    var src = await loadFile('src/js/tools/020-tool-execution.js');
    var tmo = /var _WS_PIN_LOOKUP_TIMEOUT_MS = (\d+);/.exec(src);
    if (!tmo) throw new Error('_WS_PIN_LOOKUP_TIMEOUT_MS not found');
    var log = { ifClean: [], force: [], gc: 0, unreg: [], pin: [], api: [], setMeta: [], order: [], timers: [], cleared: [], guardDuringDelete: null, timeoutMs: +tmo[1] };
    var body = _cutFns(src, ['_wsMergePrRecords', '_wsHandoffPin', '_wsPinHandoffTarget', 'wsDeleteWorkspace', '_wsDeleteScan', '_wsDeleteConflictError', '_wsDeleteWorkspaceGuarded']) + '\n'
        + 'return { wsDeleteWorkspace: wsDeleteWorkspace, _wsPinHandoffTarget: _wsPinHandoffTarget };';
    var names = ['getWorkspaceMeta', 'getAllWorkspaceFiles', 'wsGetIgnoreFilter', '_wsCheckCrossChatConflict',
        'deleteWorkspaceIfClean', 'deleteLocalWorkspaceData', 'gcWorkspaceBlobs', 'unregisterFile',
        'setWorkspacePin', 'getAllWorkspaceMetas', 'githubApi', 'parseWsKey',
        '_wsAutoDelInProgress', '_WS_PIN_LOOKUP_TIMEOUT_MS', 'setTimeout', 'clearTimeout', 'setWorkspaceMeta'];
    var f = new Function(names.join(','), body);
    var guard = opts.guard || {};
    var phase = 'scan1', filesReads = 0, metasResolved = false, servedAfter = false;
    function conflictsFor(ph) {
        if (ph === 'tx' && opts.txConflicts) return opts.txConflicts;
        if (ph === 'scan2' && opts.recheckConflicts) return opts.recheckConflicts;
        return opts.conflicts || {};
    }
    var api = f(
        async function(wk) {
            if (opts.metaThrow) throw new Error('boom');
            if (opts.metaByWk && Object.prototype.hasOwnProperty.call(opts.metaByWk, wk)) return opts.metaByWk[wk];
            return opts.meta || null;
        },
        async function() {
            filesReads++;
            log.order.push('files');
            phase = filesReads >= 2 ? 'scan2' : 'scan1';
            if (filesReads >= 2 && opts.filesAfter && metasResolved) { servedAfter = true; return opts.filesAfter; }
            return opts.files || [];
        },
        async function() { return function(p) { return p.indexOf('dist/') === 0; }; },
        function(file) { return (file && file.dirty && conflictsFor(phase)[file.path]) || null; },
        async function(wk, keepFilter) {
            log.ifClean.push(wk);
            log.order.push('delete');
            log.guardDuringDelete = !!guard[wk];
            if (opts.delThrow) throw new Error('IDB tx aborted');
            if (opts.keptDirty) return { kept: true, dirty: opts.keptDirty };
            phase = 'tx';
            var rows = opts.txRows || (servedAfter && opts.filesAfter) || opts.files || [];
            var dirty = rows.filter(function(r) { return r.dirty && !(keepFilter && keepFilter(r.path, r)); }).map(function(r) { return r.path; });
            if (dirty.length) return { kept: true, deleted: false, dirty: dirty };
            return { kept: false, deleted: true, count: rows.length };
        },
        async function(wk) { log.force.push(wk); },
        function() { log.gc++; },
        function(id) { log.unreg.push(id); },
        async function(wk, unpin) { log.pin.push({ wk: wk, unpin: unpin }); return { success: true }; },
        async function() { log.order.push('metas'); var all = opts.metas || []; metasResolved = true; return all; },
        function(method, path) {
            log.api.push(method + ' ' + path);
            if (opts.apiHang) return new Promise(function() {});
            if (opts.apiThrow) return Promise.reject(new Error('network down'));
            if (opts.defaultBranch) return Promise.resolve({ ok: true, body: { default_branch: opts.defaultBranch } });
            return Promise.resolve({ ok: false, status: 500 });
        },
        _parseWsKey,
        guard,
        log.timeoutMs,
        // Deterministic timer: fires (next microtask) only when the API hangs.
        function(fn, ms) { log.timers.push(ms); if (opts.apiHang) Promise.resolve().then(fn); return 42; },
        function(id) { log.cleared.push(id); },
        async function(m) {
            log.order.push('setMeta');
            if (opts.setMetaThrow) throw new Error('IDB write failed');
            log.setMeta.push(JSON.parse(JSON.stringify(m)));
        }
    );
    api.log = log;
    api.guard = guard;
    return api;
}

describe('workspace delete_workspace: dispatcher', function() {
    async function dispatcherEnv(delResult) {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var log = { del: [], resolve: 0, emits: [] };
        var body = _cutFns(src, ['executeWorkspaceTool']) + '\nreturn executeWorkspaceTool;';
        var f = new Function('_wsResolveChat', 'wsDeleteWorkspace', 'resolveWorkspace', 'AgentEvents', 'parseWsKey', body);
        var fn = f(
            function() { return { chatId: 'chat_A', chatTitle: 'A' }; },
            async function(wk, chatId, force) { log.del.push({ wk: wk, chatId: chatId, force: force }); return delResult !== undefined ? delResult : { success: true, deleted: wk, pin_moved_to: null }; },
            async function() { log.resolve++; return 'o/r::main'; },
            { emit: function(n, e) { log.emits.push({ n: n, e: e }); } },
            _parseWsKey
        );
        return { fn: fn, log: log };
    }

    test('missing workspace arg -> error, no default/pinned fallback', async function() {
        var d = await dispatcherEnv();
        var r = await d.fn({ action: 'delete_workspace' }, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error, 'delete_workspace requires an explicit workspace (owner/repo::branch)');
        assert.strictEqual(d.log.resolve, 0, 'resolveWorkspace never called');
        assert.strictEqual(d.log.del.length, 0);
    }, { tags: ['unit'] });

    test('explicit workspace -> wsDeleteWorkspace(wk, chatId, force) + workspaceMutated emit', async function() {
        var d = await dispatcherEnv();
        var r = await d.fn({ action: 'delete_workspace', workspace: 'o/r::feat/x', force: true }, {});
        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(d.log.del, [{ wk: 'o/r::feat/x', chatId: 'chat_A', force: true }]);
        assert.strictEqual(d.log.resolve, 0);
        assert.strictEqual(d.log.emits.length, 1);
        assert.strictEqual(d.log.emits[0].n, 'workspaceMutated');
        assert.strictEqual(d.log.emits[0].e.action, 'delete_workspace');
        assert.strictEqual(d.log.emits[0].e.repo, 'o/r::feat/x');
    }, { tags: ['unit'] });

    test('failed / empty wsDeleteWorkspace result -> returned as-is, NO workspaceMutated emit', async function() {
        var fail = { success: false, dirty: ['a.js'], error: 'Refusing to delete workspace o/r::feat/x' };
        var d = await dispatcherEnv(fail);
        var r = await d.fn({ action: 'delete_workspace', workspace: 'o/r::feat/x' }, {});
        assert.strictEqual(r, fail);
        assert.strictEqual(d.log.del.length, 1);
        assert.strictEqual(d.log.emits.length, 0, 'no emit on failure');

        var d2 = await dispatcherEnv(null);
        var r2 = await d2.fn({ action: 'delete_workspace', workspace: 'o/r::feat/x' }, {});
        assert.strictEqual(r2, null);
        assert.strictEqual(d2.log.emits.length, 0, 'no emit on null result');
    }, { tags: ['unit'] });

    test('schema: workspace action enum includes delete_workspace (core/080-tools.js)', async function() {
        var src = await loadFile('src/js/core/080-tools.js');
        var at = src.indexOf("name: 'workspace'");
        assert.ok(at !== -1, 'workspace tool schema present');
        var m = /action:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]*)\]/.exec(src.slice(at));
        assert.ok(m, 'action enum found');
        var actions = m[1].split(',').map(function(s) { return s.trim().replace(/^'|'$/g, ''); });
        assert.ok(actions.indexOf('delete_workspace') !== -1, 'delete_workspace in enum: ' + actions.join(','));
        assert.ok(actions.indexOf('delete') !== -1, 'file delete still present');
    }, { tags: ['unit'] });
});

describe('workspace delete_workspace: wsDeleteWorkspace', function() {
    var WK = 'o/r::feat/x';

    test('workspace not found -> error', async function() {
        var e = await _delEnv({ meta: null });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error, 'Workspace not found: ' + WK);
        assert.strictEqual(e.log.ifClean.length + e.log.force.length, 0);
    }, { tags: ['unit'] });

    test('dirty without force -> refused, paths listed, nothing deleted', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x' }, files: [
            { path: 'a.js', dirty: true }, { path: 'b.js', dirty: false }, { path: 'dist/x.js', dirty: true }
        ] });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, false);
        assert.deepStrictEqual(r.dirty, ['a.js'], 'ignored dist/ excluded');
        assert.ok(r.error.indexOf('a.js') !== -1 && r.error.indexOf('force:true') !== -1, r.error);
        assert.strictEqual(e.log.ifClean.length, 0);
        assert.strictEqual(e.log.force.length, 0);
        assert.strictEqual(e.log.gc, 0);
    }, { tags: ['unit'] });

    test('hard cross-chat conflict -> refused even with force', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x' },
            files: [{ path: 'a.js', dirty: true }, { path: 'c.js', dirty: true }],
            conflicts: { 'a.js': { hard: true, last_modified_by_chat_id: 'chat_B' }, 'c.js': { hard: false, last_modified_by_chat_id: 'chat_C' } } });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', true);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.cross_chat_conflict, true);
        assert.deepStrictEqual(r.conflicts, [{ path: 'a.js', chat: 'chat_B' }]);
        assert.strictEqual(e.log.force.length + e.log.ifClean.length, 0, 'nothing deleted');
    }, { tags: ['unit'] });

    test('clean -> deleteWorkspaceIfClean + gcWorkspaceBlobs + unregisterFile', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x' },
            files: [{ path: 'a.js', dirty: false, file_id: 'file_1' }, { path: 'b.js', dirty: false }] });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.deleted, WK);
        assert.deepStrictEqual(r.files_discarded, []);
        assert.strictEqual(r.pin_moved_to, null);
        assert.ok(/GitHub branch/.test(r.note));
        assert.deepStrictEqual(e.log.ifClean, [WK]);
        assert.strictEqual(e.log.force.length, 0);
        assert.strictEqual(e.log.gc, 1);
        assert.deepStrictEqual(e.log.unreg, ['file_1']);
        assert.strictEqual(e.log.pin.length, 0, 'unpinned: no pin handoff');
    }, { tags: ['unit'] });

    test('deleteWorkspaceIfClean keeps (late dirty) -> error, no gc', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x' }, files: [], keptDirty: ['late.js'] });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, false);
        assert.deepStrictEqual(r.dirty, ['late.js']);
        assert.strictEqual(e.log.gc, 0);
    }, { tags: ['unit'] });

    test('force with dirty files -> deleteLocalWorkspaceData, files_discarded listed', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x' },
            files: [{ path: 'a.js', dirty: true }, { path: 'b.js', dirty: true }],
            conflicts: { 'b.js': { hard: false, last_modified_by_chat_id: 'chat_dormant' } } });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', true);
        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(e.log.ifClean, [WK], 'force goes through the atomic in-tx delete');
        assert.strictEqual(e.log.force.length, 0, 'unconditional deleteLocalWorkspaceData no longer used');
        assert.strictEqual(e.log.gc, 1);
        assert.deepStrictEqual(r.files_discarded, ['a.js', 'b.js']);
    }, { tags: ['unit'] });

    test('pinned fork -> pin handed to forked_from workspace', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true, forked_from: 'o/r::dev' },
            metas: [{ repo: WK, branch: 'feat/x' }, { repo: 'o/r::main', branch: 'main' }, { repo: 'o/r::dev', branch: 'dev' }, { repo: 'z/q::main', branch: 'main' }] });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(e.log.pin, [{ wk: 'o/r::dev', unpin: false }]);
        assert.strictEqual(r.pin_moved_to, 'o/r::dev');
        assert.strictEqual(e.log.api.length, 0, 'no default-branch lookup when forked_from is cloned');
    }, { tags: ['unit'] });

    test('pinned, no forked_from -> default branch workspace, else any same-repo, else none', async function() {
        var metas = [{ repo: WK, branch: 'feat/x' }, { repo: 'o/r::wip', branch: 'wip' }, { repo: 'o/r::trunk', branch: 'trunk' }, { repo: 'z/q::trunk', branch: 'trunk' }];
        var e1 = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true }, metas: metas, defaultBranch: 'trunk' });
        var r1 = await e1.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.deepStrictEqual(e1.log.pin, [{ wk: 'o/r::trunk', unpin: false }]);
        assert.strictEqual(r1.pin_moved_to, 'o/r::trunk');

        var e2 = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true, forked_from: 'o/r::gone' }, metas: [{ repo: WK }, { repo: 'o/r::wip', branch: 'wip' }] });
        var r2 = await e2.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r2.pin_moved_to, 'o/r::wip');

        var e3 = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true }, metas: [{ repo: WK }, { repo: 'z/q::main', branch: 'main' }] });
        var r3 = await e3.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r3.success, true);
        assert.strictEqual(r3.pin_moved_to, null);
        assert.strictEqual(e3.log.pin.length, 0);
    }, { tags: ['unit'] });
});

describe('workspace delete_workspace: hardening', function() {
    var WK = 'o/r::feat/x';

    test('refuses while _wsAutoDelInProgress[wk] is set (guard left intact)', async function() {
        var g = {}; g[WK] = true;
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x' }, guard: g });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', true);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.auto_delete_in_progress, true);
        assert.ok(/auto-delete in progress/.test(r.error), r.error);
        assert.strictEqual(e.log.ifClean.length + e.log.force.length, 0);
        assert.strictEqual(g[WK], true, 'the auto-delete owner keeps its guard');
    }, { tags: ['unit'] });

    test('guard is set during the delete and cleared after success, error and throw', async function() {
        var ok = await _delEnv({ meta: { repo: WK, branch: 'feat/x' } });
        var r1 = await ok.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r1.success, true);
        assert.strictEqual(ok.log.guardDuringDelete, true, 'guard held across the delete');
        assert.ok(!ok.guard[WK], 'cleared after success');

        var nf = await _delEnv({ meta: null });
        var r2 = await nf.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r2.success, false);
        assert.ok(!nf.guard[WK], 'cleared after error result');

        var th = await _delEnv({ metaThrow: true });
        var threw = false;
        try { await th.wsDeleteWorkspace(WK, 'chat_A', false); } catch (e) { threw = true; }
        assert.ok(threw);
        assert.ok(!th.guard[WK], 'cleared after throw');
    }, { tags: ['unit'] });

    test('re-check: hard conflict appearing at the final scan blocks a force delete', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true },
            metas: [{ repo: WK }, { repo: 'o/r::main', branch: 'main' }],
            files: [{ path: 'a.js', dirty: true }],
            recheckConflicts: { 'a.js': { hard: true, last_modified_by_chat_id: 'chat_B' } } });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', true);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.cross_chat_conflict, true);
        assert.deepStrictEqual(r.conflicts, [{ path: 'a.js', chat: 'chat_B' }]);
        assert.strictEqual(e.log.ifClean.length + e.log.force.length, 0, 'nothing deleted');
        assert.strictEqual(e.log.pin.length, 0, 'no pin handoff');
    }, { tags: ['unit'] });

    test('re-check: a running chat write landing during the pin lookup blocks a force delete', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true },
            metas: [{ repo: WK }, { repo: 'o/r::main', branch: 'main' }],
            files: [{ path: 'a.js', dirty: true }],
            filesAfter: [{ path: 'a.js', dirty: true }, { path: 'new.js', dirty: true }],
            conflicts: { 'new.js': { hard: true, last_modified_by_chat_id: 'chat_B' } } });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', true);
        assert.strictEqual(r.success, false);
        assert.deepStrictEqual(r.conflicts, [{ path: 'new.js', chat: 'chat_B' }]);
        assert.strictEqual(e.log.ifClean.length + e.log.force.length, 0);
    }, { tags: ['unit'] });

    test('force delete refuses inside the transaction a row owned by a running chat', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x' },
            files: [{ path: 'a.js', dirty: true }],
            txRows: [{ path: 'a.js', dirty: true }, { path: 'dist/b.js', dirty: true }, { path: 'late.js', dirty: true, last_modified_by_chat_id: 'chat_B' }],
            txConflicts: { 'late.js': { hard: true, last_modified_by_chat_id: 'chat_B' }, 'dist/b.js': { hard: true } } });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', true);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.cross_chat_conflict, true);
        assert.deepStrictEqual(r.conflicts, [{ path: 'late.js', chat: 'chat_B' }], 'ignored + own rows deletable; owner recorded in-tx');
        assert.strictEqual(e.log.gc, 0);
    }, { tags: ['unit'] });

    test('deleteWorkspaceIfClean throws -> {success:false, error}, guard cleared, no gc', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x' }, delThrow: true });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', true);
        assert.strictEqual(r.success, false);
        assert.ok(/IDB tx aborted/.test(r.error), r.error);
        assert.strictEqual(e.log.gc, 0);
        assert.ok(!e.guard[WK], 'guard cleared');
    }, { tags: ['unit'] });

    test('pin lookup prefers a local ::main / ::master without calling githubApi', async function() {
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true }, defaultBranch: 'trunk',
            metas: [{ repo: WK }, { repo: 'o/r::trunk', branch: 'trunk' }, { repo: 'o/r::main', branch: 'main' }] });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.pin_moved_to, 'o/r::main');
        assert.strictEqual(e.log.api.length, 0, 'no network');

        var e2 = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true },
            metas: [{ repo: WK }, { repo: 'o/r::wip', branch: 'wip' }, { repo: 'o/r::master', branch: 'master' }] });
        var r2 = await e2.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r2.pin_moved_to, 'o/r::master');
        assert.strictEqual(e2.log.api.length, 0);
    }, { tags: ['unit'] });

    test('pin lookup: hung / failing githubApi times out to any same-repo workspace', async function() {
        var metas = [{ repo: WK }, { repo: 'o/r::wip', branch: 'wip' }, { repo: 'o/r::trunk', branch: 'trunk' }];
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true }, metas: metas, apiHang: true });
        assert.ok(e.log.timeoutMs > 0 && e.log.timeoutMs <= 10000, 'timeout ~5s: ' + e.log.timeoutMs);
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.pin_moved_to, 'o/r::wip');
        assert.strictEqual(e.log.api.length, 1);
        assert.deepStrictEqual(e.log.timers, [e.log.timeoutMs]);
        assert.deepStrictEqual(e.log.cleared, [42], 'timer cleared');

        var e2 = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true }, metas: metas, apiThrow: true });
        var r2 = await e2.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r2.pin_moved_to, 'o/r::wip');
    }, { tags: ['unit'] });

    test('pin lookup: timer cleared with its id on the success AND apiThrow paths', async function() {
        var metas = [{ repo: WK }, { repo: 'o/r::wip', branch: 'wip' }, { repo: 'o/r::trunk', branch: 'trunk' }];
        var ok = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true }, metas: metas, defaultBranch: 'trunk' });
        var r = await ok.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.pin_moved_to, 'o/r::trunk', 'default branch resolved');
        assert.deepStrictEqual(ok.log.timers, [ok.log.timeoutMs]);
        assert.deepStrictEqual(ok.log.cleared, [42], 'success path clears the timer');

        var thr = await _delEnv({ meta: { repo: WK, branch: 'feat/x', pinned: true }, metas: metas, apiThrow: true });
        var r2 = await thr.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r2.success, true);
        assert.strictEqual(thr.log.api.length, 1);
        assert.deepStrictEqual(thr.log.timers, [thr.log.timeoutMs]);
        assert.deepStrictEqual(thr.log.cleared, [42], 'apiThrow path clears the timer');
    }, { tags: ['unit'] });

    test('_wsMergePrRecords throwing -> delete still succeeds with prs_dropped, no prs_carried_to', async function() {
        var prs = [{ number: 5, url: 'u5', branch: 'feat/x' }, { number: 3, url: 'u3', branch: 'feat/x' }];
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x', prs: prs }, setMetaThrow: true,
            metas: [{ repo: WK }, { repo: 'o/r::main', branch: 'main' }],
            metaByWk: { 'o/r::main': { repo: 'o/r::main', prs: [] } } });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.prs_dropped, 2);
        assert.strictEqual(r.prs_carried_to, undefined);
        assert.ok(e.log.order.indexOf('setMeta') !== -1, 'carry was attempted');
        assert.deepStrictEqual(e.log.ifClean, [WK], 'workspace deleted anyway');
        assert.deepStrictEqual(e.guard, {}, 'guard cleared');
    }, { tags: ['unit'] });

    test('PR records are carried over to the target; prs_dropped when none', async function() {
        var prs = [{ number: 5, url: 'u5', branch: 'feat/x', files: [{ path: 'a.js' }] }, { number: 3, url: 'u3', branch: 'feat/x' }];
        var e = await _delEnv({ meta: { repo: WK, branch: 'feat/x', prs: prs },
            metas: [{ repo: WK }, { repo: 'o/r::main', branch: 'main' }],
            metaByWk: { 'o/r::main': { repo: 'o/r::main', prs: [{ number: 3, url: 'u3', files: [{ path: 'keep.js' }] }, { number: 1, url: 'u1' }] } } });
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.prs_carried_to, 'o/r::main');
        assert.strictEqual(r.prs_dropped, undefined);
        assert.strictEqual(r.pin_moved_to, null, 'unpinned: carry-over does not move a pin');
        assert.strictEqual(e.log.pin.length, 0);
        assert.strictEqual(e.log.setMeta.length, 1);
        assert.deepStrictEqual(e.log.order.filter(function(o) { return o === 'setMeta' || o === 'delete'; }), ['setMeta', 'delete'], 'records copied BEFORE the delete');
        var saved = e.log.setMeta[0];
        assert.strictEqual(saved.repo, 'o/r::main');
        assert.deepStrictEqual(saved.prs.map(function(p) { return p.number; }), [3, 1, 5]);
        assert.deepStrictEqual(saved.prs[0].files, [{ path: 'keep.js' }], 'richer files snapshot kept on dedupe');
        assert.deepStrictEqual(saved.prs[2].files, [{ path: 'a.js' }]);

        var e2 = await _delEnv({ meta: { repo: WK, branch: 'feat/x', prs: prs }, metas: [{ repo: WK }, { repo: 'z/q::main', branch: 'main' }] });
        var r2 = await e2.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r2.success, true);
        assert.strictEqual(r2.prs_dropped, 2);
        assert.strictEqual(e2.log.setMeta.length, 0);
    }, { tags: ['unit'] });

    function _carryEnv() {
        return _delEnv({ meta: { repo: WK, branch: 'feat/x', prs: [{ number: 5, url: 'u5', branch: 'feat/x' }] },
            metas: [{ repo: WK }, { repo: 'o/r::main', branch: 'main' }],
            metaByWk: { 'o/r::main': { repo: 'o/r::main', prs: [] } },
            files: [],
            filesAfter: [{ path: 'late.js', dirty: true }] });
    }

    // Guards #1113 TOCTOU fix: the final re-scan must run AFTER the (possibly
    // networked) target lookup + carry, with no await between it and the delete.
    test('TOCTOU order: scan -> target lookup -> carry -> FINAL re-scan -> delete', async function() {
        var e = await _carryEnv();
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', true);
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.deepStrictEqual(e.log.order, ['files', 'metas', 'setMeta', 'files', 'delete']);
        assert.deepStrictEqual(r.files_discarded, ['late.js'], 're-scan saw the row written during the lookup');
        assert.strictEqual(r.prs_carried_to, 'o/r::main');
    }, { tags: ['unit'] });

    // Locks in #1114 semantics: records are COPIED to the target before the
    // delete, so a delete refused at the final re-scan still leaves them there.
    test('refused at the final re-scan (late dirty, no force): PR records already carried BEFORE the delete', async function() {
        var e = await _carryEnv();
        var r = await e.wsDeleteWorkspace(WK, 'chat_A', false);
        assert.strictEqual(r.success, false, JSON.stringify(r));
        assert.deepStrictEqual(r.dirty, ['late.js']);
        assert.strictEqual(e.log.setMeta.length, 1, 'carried before the delete was refused');
        assert.strictEqual(e.log.setMeta[0].repo, 'o/r::main');
        assert.deepStrictEqual(e.log.setMeta[0].prs.map(function(p) { return p.number; }), [5]);
        assert.strictEqual(e.log.ifClean.length + e.log.force.length, 0, 'nothing deleted');
        assert.deepStrictEqual(e.log.order, ['files', 'metas', 'setMeta', 'files']);
    }, { tags: ['unit'] });
});
