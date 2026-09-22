// #12 — `workspace status` must return the same LEAN `prs` projection as `list`
// (capped merged PRs) unless include_prs:'full'. dirty_files stays intact.
describe('workspace status slim prs (020-tool-execution.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        return M;
    }
    function fakePrs() {
        var prs = [];
        for (var i = 1; i <= 6; i++) {
            prs.push({ number: i, title: 'PR ' + i, state: 'merged', url: 'u' + i, branch: 'b' + i, merged_at: '2026-09-0' + i + 'T00:00:00Z', chatId: 'c', files: [{ path: 'a.js', old_sha: 'o', new_sha: 'n' }] });
        }
        prs.push({ number: 7, title: 'open', state: 'open', url: 'u7', branch: 'b7', chatId: 'c', files: [{ path: 'a.js', old_sha: 'o', new_sha: 'n' }] });
        return prs;
    }
    function wire(m) {
        m.__scope.getWorkspaceMeta = async function() { return { branch: 'main', github_repo: 'o/r', prs: fakePrs(), pinned: true }; };
        m.__scope.getAllWorkspaceFiles = async function() { return [{ path: 'a.js', dirty: true, content: 'x', original_content: 'y', pushed_pr: { number: 7 }, last_modified_by_chat_id: 'c1' }]; };
        m.__scope.wsGetIgnoreFilter = async function() { return function() { return false; }; };
        m.__scope.loadGitHubSettings = async function() { throw new Error('offline'); };
        m.__scope.githubApi = async function() { throw new Error('offline'); };
    }
    test('_wsLeanPrs: lean projection, open PRs kept, merged capped to 3 most recent', async function() {
        var m = await load();
        assert.strictEqual(typeof m._wsLeanPrs, 'function', '_wsLeanPrs helper must exist');
        var r = m._wsLeanPrs(fakePrs());
        assert.strictEqual(r.merged_omitted, 3);
        assert.strictEqual(r.prs.length, 4);
        var nums = r.prs.map(function(p) { return p.number; }).sort();
        assert.deepStrictEqual(nums, [4, 5, 6, 7]);
        r.prs.forEach(function(p) {
            assert.deepStrictEqual(Object.keys(p).sort(), p.merged_at ? ['branch', 'merged_at', 'number', 'state', 'title', 'url'] : ['branch', 'number', 'state', 'title', 'url'], JSON.stringify(p));
        });
        assert.deepStrictEqual(m._wsLeanPrs(null), { prs: [], merged_omitted: 0 });
    });
    test('wsStatus default: lean prs + merged_prs_omitted; dirty_files keep pushed_pr', async function() {
        var m = await load(); wire(m);
        var r = await m.wsStatus('o/r::main', false, 'c1');
        assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 300));
        assert.strictEqual(r.prs.length, 4);
        assert.strictEqual(r.merged_prs_omitted, 3);
        r.prs.forEach(function(p) { assert.strictEqual(p.files, undefined, 'no files[] in lean prs'); assert.strictEqual(p.chatId, undefined); });
        assert.strictEqual(r.dirty_files.length, 1);
        assert.deepStrictEqual(r.dirty_files[0].pushed_pr, { number: 7 });
    });
    test("wsStatus include_prs:'full': every PR with files[]; no merged_prs_omitted", async function() {
        var m = await load(); wire(m);
        var r = await m.wsStatus('o/r::main', false, 'c1', 'full');
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.prs.length, 7);
        assert.strictEqual(r.prs[0].files.length, 1);
        assert.strictEqual(r.merged_prs_omitted, undefined);
    });
});
