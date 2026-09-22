// Unit tests for workspace helpers in the REAL src/js/tools/020-tool-execution.js
// (#14 edit replace_all/occurrence, #13 grep (?i)/binary stubs, #20 workflow hint).
describe('workspace helpers (020-tool-execution.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        return M;
    }
    test('applySearchReplaceEdits: ambiguous find lists line numbers and suggests replace_all/occurrence', async function() {
        var m = await load();
        var r = m.applySearchReplaceEdits('foo\nbar\nfoo\n', [{ find: 'foo', replace: 'X' }]);
        assert.strictEqual(r.error, true);
        assert.match(r.messages[0], /found 2 times at: line 1 .*line 3/);
        assert.match(r.messages[0], /replace_all:true \/ occurrence:<n>/);
    });
    test('applySearchReplaceEdits: replace_all replaces every occurrence', async function() {
        var m = await load();
        var r = m.applySearchReplaceEdits('foo\nbar\nfoo\n', [{ find: 'foo', replace: 'X', replace_all: true }]);
        assert.strictEqual(r.error, false);
        assert.strictEqual(r.content, 'X\nbar\nX\n');
        assert.strictEqual(r.appliedEdits[0].action, 'replace_all');
        assert.strictEqual(r.appliedEdits[0].count, 2);
    });
    test('applySearchReplaceEdits: occurrence:n targets the n-th match; out of range / invalid → error', async function() {
        var m = await load();
        var r = m.applySearchReplaceEdits('foo foo foo', [{ find: 'foo', replace: 'X', occurrence: 2 }]);
        assert.strictEqual(r.content, 'foo X foo');
        var bad = m.applySearchReplaceEdits('foo foo', [{ find: 'foo', replace: 'X', occurrence: 3 }]);
        assert.strictEqual(bad.error, true); assert.match(bad.messages[0], /occurrence 3 requested but the text was found only 2/);
        var bad2 = m.applySearchReplaceEdits('foo foo', [{ find: 'foo', replace: 'X', occurrence: 0 }]);
        assert.match(bad2.messages[0], /positive integer/);
    });
    test('applySearchReplaceEdits: unique find still works unchanged', async function() {
        var m = await load();
        var r = m.applySearchReplaceEdits('a b c', [{ find: 'b', replace: 'B' }]);
        assert.strictEqual(r.content, 'a B c'); assert.strictEqual(r.appliedEdits[0].action, 'replace');
    });
    test('applySearchReplaceEdits: replace_all count is non-overlapping (matches what split/join replaced)', async function() {
        var m = await load();
        var r = m.applySearchReplaceEdits('aaa', [{ find: 'aa', replace: 'b', replace_all: true }]);
        assert.strictEqual(r.content, 'ba');
        assert.strictEqual(r.appliedEdits[0].count, 1, 'count must equal the number of replacements actually made');
        assert.strictEqual(r.appliedEdits[0].removed, 2);
    });
    test("applySearchReplaceEdits: replace_all:'true' (string) is accepted; replace_all + occurrence together → error", async function() {
        var m = await load();
        var r = m.applySearchReplaceEdits('foo foo', [{ find: 'foo', replace: 'X', replace_all: 'true' }]);
        assert.strictEqual(r.error, false); assert.strictEqual(r.content, 'X X');
        var both = m.applySearchReplaceEdits('foo foo', [{ find: 'foo', replace: 'X', replace_all: true, occurrence: 1 }]);
        assert.strictEqual(both.error, true); assert.match(both.messages[0], /mutually exclusive/);
        assert.strictEqual(both.partialEdits.length, 0);
    });
    test('_wsLikelyBinaryPath: media/font extensions are binary-ish; source AND text-ish svg/lock are not', async function() {
        var m = await load();
        ['a.png', 'f.woff2', 'p.psd', 's.heic', 'm.flac', 'v.ogg', 'i.avif', 'd.sketch', 'x.ai'].forEach(function(p) { assert.strictEqual(m._wsLikelyBinaryPath(p), true, p); });
        ['a.js', 'b.md', 'c.json', 'd.html', 'x/y.svg', 'yarn.lock', 'Cargo.lock'].forEach(function(p) { assert.strictEqual(m._wsLikelyBinaryPath(p), false, p); });
    });
    test('wsPush: new branch needs explicit pr_title even with a nonblank commit message', async function() {
        var m = await load();
        var calls = [];
        m.__scope.getWorkspaceMeta = async function() { return { branch: 'main', github_repo: 'o/r', head_sha: 'h', tree_sha: 't' }; };
        m.__scope.loadGitHubSettings = async function() { return { token: 'tok' }; };
        m.__scope.getAllWorkspaceFiles = async function() { return [{ path: 'a.js', dirty: true, content: 'x', original_content: 'y' }]; };
        m.__scope.wsGetIgnoreFilter = async function() { return function() { return false; }; };
        m.__scope._wsCheckCrossChatConflict = function() { return null; };
        var mainReads = 0;
        m.__scope.githubApi = async function(method, url) {
            calls.push(method + ' ' + url);
            if (method === 'GET' && /git\/ref\/heads\/main$/.test(url)) {
                mainReads++;
                // First lookup drives real wsSyncWithRemote. A second lookup
                // proves an explicit title crossed the gate into base resolution.
                if (mainReads === 1) return { ok: true, body: { object: { sha: 'h' } } };
                return { ok: false, status: 404, body: { message: 'base deleted after sync' } };
            }
            if (method === 'GET' && /git\/ref\/heads\/feat$/.test(url)) return { ok: false, status: 404, body: {} };
            throw new Error('unexpected call in test: ' + method + ' ' + url);
        };
        var args = { branch_name: 'feat', commit_message: 'Fix thing\n\nbody' };
        var r = await m.wsPush('o/r::main', args, 'c1', 'chat');
        assert.strictEqual(r.success, false);
        assert.match(r.error, /pr_title is required/);
        assert.match(r.error, /the branch does not exist yet/);
        assert.strictEqual(args.pr_title, undefined, 'commit message must not silently become a PR title');
        assert.strictEqual(mainReads, 1, 'missing title stops before base resolution');
        assert.deepStrictEqual(calls.filter(function(c) { return !/^GET /.test(c); }), [], 'missing title must not mutate the remote');

        mainReads = 0; calls.length = 0;
        args.pr_title = 'Explicit review title';
        var titled = await m.wsPush('o/r::main', args, 'c1', 'chat');
        assert.strictEqual(titled.success, false);
        assert.match(titled.error, /Base branch "main" does not exist on the remote/);
        assert.strictEqual(mainReads, 2, 'explicit title passes the title gate; subsequent base guard still fails closed');
        assert.strictEqual(args.pr_title, 'Explicit review title');
        assert.deepStrictEqual(calls.filter(function(c) { return !/^GET /.test(c); }), [], 'missing base must not mutate the remote either');
    });
    test('wsPush: stale branch without explicit title hard-fails BEFORE any remote mutation (no force-reset orphan)', async function() {
        var m = await load();
        var calls = [];
        m.__scope.getWorkspaceMeta = async function() { return { branch: 'main', github_repo: 'o/r', head_sha: 'h', tree_sha: 't' }; };
        m.__scope.loadGitHubSettings = async function() { return { token: 'tok' }; };
        // wsSyncWithRemote is defined in 020 itself (not overridable via __scope) — drive it through githubApi instead: remote main head === meta.head_sha → not behind.
        m.__scope.getAllWorkspaceFiles = async function() { return [{ path: 'a.js', dirty: true, content: 'x', original_content: 'y' }]; };
        m.__scope.wsGetIgnoreFilter = async function() { return function() { return false; }; };
        m.__scope._wsCheckCrossChatConflict = function() { return null; };
        m.__scope.githubApi = async function(method, url) {
            calls.push(method + ' ' + url);
            if (method === 'GET' && /git\/ref\/heads\/main$/.test(url)) return { ok: true, body: { object: { sha: 'h' } } };
            if (method === 'GET' && /git\/ref\/heads\/feat$/.test(url)) return { ok: true, body: { object: { sha: 'abc' } } };
            if (method === 'GET' && /pulls\?state=open/.test(url)) return { ok: true, body: [] };
            return { ok: false, body: { message: 'unexpected call in test: ' + method + ' ' + url } };
        };
        var r = await m.wsPush('o/r::main', { branch_name: 'feat', commit_message: '\n  \n' }, 'c1', 'chat');
        assert.strictEqual(r.success, false, JSON.stringify(r).slice(0, 300));
        assert.match(r.error, /branch "feat" exists remotely but has no open PR/);
        assert.match(r.error, /pushing would force-reset it/);
        assert.match(r.error, /Pass pr_title/);
        assert.match(r.error, /Nothing was pushed/);
        var nonblank = await m.wsPush('o/r::main', { branch_name: 'feat', commit_message: 'A valid commit title' }, 'c1', 'chat');
        assert.strictEqual(nonblank.success, false);
        assert.strictEqual(nonblank.error, r.error, 'a nonblank commit is not consent to recreate a stale branch');
        assert.deepStrictEqual(calls.filter(function(c) { return !/^GET /.test(c); }), [], 'no PATCH/POST before explicit stale-branch reset intent');
    });
    test('wsWrite: non-string content is rejected (no mocks needed — guard runs before meta lookup)', async function() {
        var m = await load();
        var r = await m.wsWrite('o/r::main', 'x.json', { a: 1 }, 'c1', 'chat', false);
        assert.strictEqual(r.success, false); assert.match(r.error, /content must be a string \(got object\)/);
        var r2 = await m.wsWrite('o/r::main', 'x.json', null, 'c1', 'chat', false);
        assert.match(r2.error, /content is required/);
    });
    test('_wsWorkflowScopeHint: only for 404/422/403 AND a .github/workflows/ path', async function() {
        var m = await load();
        var wf = [{ path: '.github/workflows/test.yml' }];
        assert.match(m._wsWorkflowScopeHint({ status: 404 }, wf), /workflow. scope/);
        assert.match(m._wsWorkflowScopeHint({ status: 422 }, wf), /workflow. scope/);
        assert.strictEqual(m._wsWorkflowScopeHint({ status: 500 }, wf), '');
        assert.strictEqual(m._wsWorkflowScopeHint({ status: 422 }, [{ path: 'src/a.js' }]), '');
        assert.strictEqual(m._wsWorkflowScopeHint(null, wf), '');
    });
    test('wsGrep: leading (?i) is stripped; ignore_case:false is case-sensitive; binary stubs excluded from slow-guard', async function() {
        var m = await load();
        var files = [
            { path: 'src/a.js', content: 'Hello World\nhello again', dirty: false },
            { path: 'media/big.png', stub: true, content: null, size: 500000000 },
            { path: 'media/big2.mp4', stub: true, content: null, size: 500000000 }
        ];
        var hyd = [];
        m.__scope.getWorkspaceMeta = async function() { return { branch: 'main' }; };
        m.__scope.getAllWorkspaceFiles = async function() { return files; };
        m.__scope.wsGetIgnoreFilter = async function() { return function() { return false; }; };
        m.__scope.wsHydrate = async function(repo, scope) { files.forEach(function(f) { if (f.stub && scope(f.path)) hyd.push(f.path); }); return { hydrated: 0 }; };
        m.__scope._wsCheckCrossChatConflict = function() { return null; };
        var r = await m.wsGrep('o/r::main', '(?i)hello', null, false, false, 'c1', 10);
        assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 300));
        assert.strictEqual(r.matches.length, 2, 'case-insensitive: both lines');
        assert.strictEqual(r.slow_grep, undefined, 'binary stubs must not trigger slow_grep');
        assert.deepStrictEqual(hyd, [], 'binary stubs are not hydrated');
        assert.strictEqual(r.unscanned_files, undefined, 'binary stubs are NOT counted as unscanned (B1)');
        assert.strictEqual(r.warning, undefined, 'no false "Incomplete search" warning (B1)');
        // A TEXT stub whose hydration failed IS still reported as unscanned.
        files.push({ path: 'src/b.js', stub: true, content: null, size: 10 });
        var inc = await m.wsGrep('o/r::main', 'hello', null, false, false, 'c1', 10);
        assert.strictEqual(inc.unscanned_files, 1, 'failed text stub counted');
        assert.match(inc.warning, /Incomplete search: 1 in-scope/);
        files.pop();
        var cs = await m.wsGrep('o/r::main', 'hello', null, false, false, 'c1', 10, false);
        assert.strictEqual(cs.matches.length, 1, 'ignore_case:false → only the lowercase line');
    });
});
