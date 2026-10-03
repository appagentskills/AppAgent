// Never-pushed local fork workspaces (meta.forked_from set, branch not yet on
// GitHub) must not poll `git/ref/heads/<branch>` or the merged-PR auto-delete
// lookup on every sync. Evaluates the REAL function texts cut out of
// src/js/tools/020-tool-execution.js (same pattern as
// test/chat-eviction-tools-020.test.js) with stubbed collaborators.

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

async function _env(meta) {
    var src = await loadFile('src/js/tools/020-tool-execution.js');
    var log = { api: [], autoDel: 0 };
    var body = _cutFns(src, ['_wsForkNeverPushed', 'wsSyncWithRemote']) + '\n'
        + 'return { _wsForkNeverPushed: _wsForkNeverPushed, wsSyncWithRemote: wsSyncWithRemote };';
    var f = new Function('getWorkspaceMeta', 'githubApi', 'wsMaybeAutoDeleteMerged', 'parseWsKey', body);
    var api = f(
        async function() { return meta; },
        async function(method, path) { log.api.push(method + ' ' + path); return { ok: false, status: 404 }; },
        async function() { log.autoDel++; return null; },
        function(wk) { return { repo: String(wk).split('::')[0], branch: String(wk).split('::')[1] }; }
    );
    api.log = log;
    return api;
}

describe('_wsForkNeverPushed / wsSyncWithRemote: never-pushed forks', function() {
    test('_wsForkNeverPushed truth table', async function() {
        var e = await _env(null);
        var fn = e._wsForkNeverPushed;
        assert.strictEqual(fn(null), false, 'null meta');
        assert.strictEqual(fn(undefined), false, 'undefined meta');
        assert.strictEqual(fn({ branch: 'main' }), false, 'non-fork');
        assert.strictEqual(fn({ branch: 'feat/x', forked_from: 'main' }), true, 'fork, no prs');
        assert.strictEqual(fn({ branch: 'feat/x', forked_from: 'main', prs: [] }), true, 'fork, empty prs');
        assert.strictEqual(fn({ branch: 'feat/x', forked_from: 'main', prs: [{ branch: 'feat/x', number: 1 }] }), false, 'fork pushed');
        assert.strictEqual(fn({ branch: 'feat/x', forked_from: 'main', prs: [{ branch: 'other', number: 2 }, null] }), true, 'fork, pr on other branch');
        assert.strictEqual(fn({ branch: 'feat/x', forked_from: 'main', prs: 'bogus' }), true, 'fork, non-array prs');
    }, { tags: ['unit'] });

    test('wsSyncWithRemote: unpushed fork makes no git/ref or auto-delete call (all modes)', async function() {
        var meta = { branch: 'feat/x', forked_from: 'main', base_branch: 'main', github_repo: 'o/r', prs: [] };
        var modes = [undefined, {}, { readOnly: true }, { autoPull: true }];
        for (var i = 0; i < modes.length; i++) {
            var e = await _env(meta);
            var r = await e.wsSyncWithRemote('o/r::feat/x', modes[i]);
            assert.strictEqual(r.branchGone, true);
            assert.strictEqual(r.branch, 'feat/x');
            assert.strictEqual(r.local_fork_unpushed, true);
            assert.strictEqual(e.log.api.filter(function(p) { return p.indexOf('git/ref') !== -1; }).length, 0, 'no git/ref fetch');
            assert.strictEqual(e.log.api.length, 0, 'no GitHub call at all');
            assert.strictEqual(e.log.autoDel, 0, 'no auto-delete (pulls?head=) lookup');
        }
    }, { tags: ['unit'] });

    test('wsSyncWithRemote: pushed fork still checks the remote ref', async function() {
        var meta = { branch: 'feat/x', forked_from: 'main', github_repo: 'o/r', prs: [{ branch: 'feat/x', number: 7 }] };
        var e = await _env(meta);
        var r = await e.wsSyncWithRemote('o/r::feat/x', {});
        assert.strictEqual(e.log.autoDel, 1);
        assert.strictEqual(e.log.api.length, 1);
        assert.ok(e.log.api[0].indexOf('/repos/o/r/git/ref/heads/feat%2Fx') !== -1, e.log.api[0]);
        assert.strictEqual(r.branchGone, true);
        assert.strictEqual(r.local_fork_unpushed, undefined);
    }, { tags: ['unit'] });

});

// wsDiscard({remoteCheck}) on a fork: _dGetRemoteTree must read the BASE
// branch ref for a never-pushed fork (its own ref 404s), its own ref once pushed.
async function _discardEnv(meta, files) {
    var src = await loadFile('src/js/tools/020-tool-execution.js');
    var log = { api: [], cas: [] };
    var body = _cutFns(src, ['_wsForkNeverPushed', 'wsDiscard']) + '\nreturn wsDiscard;';
    var f = new Function('getWorkspaceMeta', 'getAllWorkspaceFiles', 'wsGetIgnoreFilter', '_wsCheckCrossChatConflict',
        '_wsCasWrite', 'unregisterFile', 'parseWsKey', 'githubApi', '_wsDecodeBlobBody', 'invalidateWorkspaceFilePointer', body);
    var fn = f(
        async function() { return meta; },
        async function() { return JSON.parse(JSON.stringify(files)); },
        async function() { return function() { return false; }; },
        function() { return null; },
        async function(wk, path, expected, next) { log.cas.push({ path: path, next: next && JSON.parse(JSON.stringify(next)) }); return { ok: true }; },
        function() {},
        function(wk) { return { repo: String(wk).split('::')[0], branch: String(wk).split('::')[1] }; },
        async function(method, path) {
            log.api.push(method + ' ' + path);
            if (/\/git\/ref\/heads\/main$/.test(path)) return { ok: true, body: { object: { sha: 'M1' } } };
            if (/\/git\/ref\/heads\/feat%2Fx$/.test(path)) return { ok: true, body: { object: { sha: 'F1' } } };
            if (/\/git\/trees\/(M1|F1)\?recursive=1$/.test(path)) return { ok: true, body: { tree: [{ path: 'a.js', type: 'blob', sha: 'S1' }] } };
            return { ok: false, status: 404 };
        },
        function(b) { return b.content; },
        function() {}
    );
    return { wsDiscard: fn, log: log };
}

describe('wsDiscard remoteCheck on forks (#1113)', function() {
    var FILES = [{ path: 'a.js', content: 'edited', original_content: 'orig', sha: 'S1', dirty: true, file_id: 'f1' }];

    test('never-pushed fork: reads git/ref/heads/<base_branch>, never its own ref, and restores the file', async function() {
        var meta = { branch: 'feat/x', forked_from: 'main', base_branch: 'main', github_repo: 'o/r', prs: [] };
        var e = await _discardEnv(meta, FILES);
        var r = await e.wsDiscard('o/r::feat/x', null, 'c', 'C', false, { remoteCheck: true });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.discarded, 1, JSON.stringify(r));
        assert.deepStrictEqual(r.files, [{ path: 'a.js', action: 'restored' }]);
        assert.strictEqual(r.unverified, undefined, 'remote was verified');
        assert.ok(e.log.api.indexOf('GET /repos/o/r/git/ref/heads/main') !== -1, e.log.api.join(' | '));
        assert.strictEqual(e.log.api.filter(function(p) { return p.indexOf('feat%2Fx') !== -1; }).length, 0, 'never GETs the unpushed fork ref: ' + e.log.api.join(' | '));
        assert.strictEqual(e.log.cas.length, 1);
        assert.strictEqual(e.log.cas[0].next.content, 'orig', 'file restored to its base');
        assert.strictEqual(e.log.cas[0].next.dirty, false);
    }, { tags: ['unit'] });

    test('pushed fork: reads its own git/ref/heads/<branch>', async function() {
        var meta = { branch: 'feat/x', forked_from: 'main', base_branch: 'main', github_repo: 'o/r', prs: [{ branch: 'feat/x', number: 9 }] };
        var e = await _discardEnv(meta, FILES);
        var r = await e.wsDiscard('o/r::feat/x', null, 'c', 'C', false, { remoteCheck: true });
        assert.strictEqual(r.discarded, 1, JSON.stringify(r));
        assert.ok(e.log.api.indexOf('GET /repos/o/r/git/ref/heads/feat%2Fx') !== -1, e.log.api.join(' | '));
        assert.strictEqual(e.log.api.filter(function(p) { return /git\/ref\/heads\/main$/.test(p); }).length, 0);
    }, { tags: ['unit'] });
});

// wsPush on a never-pushed fork takes the _lazyFork path: the pre-push sync
// makes no GitHub call (no git/ref/heads/<fork> poll), branchGone is accepted,
// and the new ref is cut from the CURRENT head of meta.base_branch.
async function _pushEnv(meta, files) {
    var src = await loadFile('src/js/tools/020-tool-execution.js');
    var STOP = new Error('STOP_AT_PR_CREATE');
    var log = { api: [], phase: 'pre' };
    function parseWsKey(wk) { return { repo: String(wk).split('::')[0], branch: String(wk).split('::')[1] }; }
    async function githubApi(method, path, body) {
        log.api.push({ phase: log.phase, method: method, path: path, body: body ? JSON.parse(JSON.stringify(body)) : null });
        if (method === 'GET' && /\/git\/ref\/heads\/feat%2Fx$/.test(path)) return { ok: false, status: 404, body: {} };
        if (method === 'GET' && /\/git\/ref\/heads\/main$/.test(path)) return { ok: true, status: 200, body: { object: { sha: 'M1' } } };
        if (method === 'GET' && /\/git\/commits\/M1$/.test(path)) return { ok: true, body: { tree: { sha: 'TM' } } };
        if (method === 'GET' && /\/git\/trees\//.test(path)) return { ok: true, body: { tree: [{ path: 'a.js', type: 'blob', sha: 'S1' }] } };
        if (method === 'POST' && /\/git\/blobs$/.test(path)) return { ok: true, body: { sha: 'B1' } };
        if (method === 'POST' && /\/git\/trees$/.test(path)) return { ok: true, body: { sha: 'T1' } };
        if (method === 'POST' && /\/git\/commits$/.test(path)) return { ok: true, body: { sha: 'C1' } };
        if (method === 'POST' && /\/git\/refs$/.test(path)) return { ok: true, body: { ref: 'refs/heads/feat/x' } };
        throw STOP; // PR creation (or anything later): stop the run here.
    }
    async function getWorkspaceMeta() { return JSON.parse(JSON.stringify(meta)); }
    var sync = new Function('getWorkspaceMeta', 'githubApi', 'wsMaybeAutoDeleteMerged', 'parseWsKey',
        _cutFns(src, ['_wsForkNeverPushed', 'wsSyncWithRemote']) + '\nreturn wsSyncWithRemote;')(
        getWorkspaceMeta, githubApi, async function() { log.autoDel = (log.autoDel || 0) + 1; return null; }, parseWsKey);
    var names = ['getWorkspaceMeta', 'parseWsKey', 'loadGitHubSettings', 'wsSyncWithRemote', 'githubApi', 'getAllWorkspaceFiles',
        'wsGetIgnoreFilter', '_wsCheckCrossChatConflict', '_wsWorkflowScopeHint', '_wsRootChatId', '_wsFormatAgo',
        '_wsForeignOwnership', '_wsCasWrite', 'computeGitBlobSha', 'putWorkspaceBlob', 'setWorkspaceMeta', 'emit'];
    var wsPush = new Function(names.join(','), _cutFns(src, ['wsPush']) + '\nreturn wsPush;')(
        getWorkspaceMeta, parseWsKey, async function() { return { token: 't' }; },
        async function(wk, o) { log.phase = 'sync'; var r = await sync(wk, o); log.syncResult = r; log.phase = 'push'; return r; },
        githubApi, async function() { return JSON.parse(JSON.stringify(files)); },
        async function() { return function() { return false; }; }, function() { return null; },
        function() { return ''; }, function() { return null; }, function() { return ''; }, function() { return null; },
        async function() { return { ok: true }; }, async function() { return 'X'; }, async function() {}, async function() {}, function() {});
    return { wsPush: wsPush, log: log, STOP: STOP };
}

describe('wsPush on a never-pushed fork: _lazyFork path (#1113)', function() {
    test('sync makes no fork-ref request; new ref + PR are cut from base_branch', async function() {
        var meta = { branch: 'feat/x', forked_from: 'main', base_branch: 'main', github_repo: 'o/r', prs: [], head_sha: 'H0', tree_sha: 'T0' };
        var e = await _pushEnv(meta, [{ path: 'a.js', content: 'new', original_content: 'old', sha: 'S1', dirty: true, file_id: 'f1' }]);
        var res = null, err = null;
        try { res = await e.wsPush('o/r::feat/x', { commit_message: 'm', pr_title: 't' }, 'c', 'C'); } catch (x) { err = x; }
        assert.strictEqual(err, e.STOP, 'push must reach PR creation; got ' + JSON.stringify(res) + ' / ' + (err && err.message));
        assert.strictEqual(e.log.syncResult.local_fork_unpushed, true);
        assert.strictEqual(e.log.syncResult.branchGone, true);
        assert.strictEqual(e.log.autoDel, undefined, 'no merged-PR auto-delete lookup');
        var syncCalls = e.log.api.filter(function(c) { return c.phase !== 'push'; });
        assert.strictEqual(syncCalls.length, 0, 'no GitHub call before the push phase: ' + JSON.stringify(syncCalls));
        var forkRefGets = e.log.api.filter(function(c) { return c.method === 'GET' && /git\/ref\/heads\/feat%2Fx$/.test(c.path); });
        assert.strictEqual(forkRefGets.length, 1, 'only the push-phase existence probe of the fork ref');
        assert.ok(e.log.api.some(function(c) { return c.method === 'GET' && c.path === '/repos/o/r/git/ref/heads/main'; }), 'base ref resolved');
        var commit = e.log.api.filter(function(c) { return c.method === 'POST' && /\/git\/commits$/.test(c.path); })[0];
        assert.deepStrictEqual(commit.body.parents, ['M1'], 'commit parented on the CURRENT base_branch head');
        var ref = e.log.api.filter(function(c) { return c.method === 'POST' && /\/git\/refs$/.test(c.path); });
        assert.strictEqual(ref.length, 1, 'branch ref created lazily');
        assert.deepStrictEqual(ref[0].body, { ref: 'refs/heads/feat/x', sha: 'C1' });
        assert.strictEqual(e.log.api.filter(function(c) { return c.method === 'PATCH'; }).length, 0, 'no force-reset');
        var pr = e.log.api.filter(function(c) { return c.method === 'POST' && /\/pulls$/.test(c.path); })[0];
        assert.ok(pr, 'PR creation attempted');
        assert.strictEqual(pr.body.base, 'main');
        assert.strictEqual(pr.body.head, 'feat/x');
    }, { tags: ['unit'] });
});
