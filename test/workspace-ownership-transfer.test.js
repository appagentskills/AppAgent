// #7 — workspace ownership transfer. When a sub-agent is parked / stopped /
// errored, dirty workspace files it stamped (last_modified_by_chat_id = sub
// chat id) are re-stamped with the ROOT chat id so the orchestrator (and its
// later subs) keep same-lineage ownership even after the sub's registry record
// is GC'd (otherwise _wsRootChatId(subId) degrades to subId → false
// cross_chat_conflict against a dead chat).
describe('#7 _wsTransferOwnership (tools/020-tool-execution.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/tools/020-tool-execution.js'],
            { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M._wsTransferOwnership, 'function', '_wsTransferOwnership must exist');
        assert.strictEqual(typeof M._wsRootChatId, 'function', 'real _wsRootChatId must be loaded');
        return M;
    }
    // `files` plays the IDB store: getAllWorkspaceFilesAllRepos returns the
    // RAW rows (no content), getWorkspaceFile re-reads a row by (repo, path).
    // opts.between(path) runs between the enumeration and the re-read of that
    // path — simulates a concurrent write from another chat.
    function arm(m, files, opts) {
        opts = opts || {};
        var writes = [];
        m.__scope.getAllWorkspaceFilesAllRepos = async function() {
            return files.map(function(f) { var raw = Object.assign({}, f); delete raw.content; return raw; });
        };
        m.__scope.getWorkspaceFile = async function(repo, path) {
            if (typeof opts.between === 'function') opts.between(path);
            for (var i = 0; i < files.length; i++) if (files[i].repo === repo && files[i].path === path) return files[i];
            return null;
        };
        m.__scope.setWorkspaceFile = async function(f) { writes.push(f.path); if (opts.stored) opts.stored.push(Object.assign({}, f)); };
        m.__scope.getAllWorkspaceFiles = async function() { throw new Error('legacy per-repo enumeration must not be used (resolves every blob)'); };
        m.__scope.getAllWorkspaceMetas = async function() { throw new Error('meta enumeration no longer needed'); };
        m.__scope.chats = opts.chats || { root1: { id: 'root1', title: 'Root chat' }, sub1: { id: 'sub1', title: 'sub one', isSubAgent: true } };
        m.__scope.SubAgents = opts.SubAgents || { getByChatId: function(id) { return id === 'sub1' ? { chat_id: 'sub1', root_chat_id: 'root1', parent_chat_id: 'root1' } : null; } };
        return writes;
    }
    function file(repo, path, owner, dirty) { return { repo: repo, path: path, dirty: dirty !== false, content: 'v1 of ' + path, last_modified_by_chat_id: owner, last_modified_by_chat_title: owner ? 'title of ' + owner : null, last_modified_at: owner ? 123 : null }; }

    test('explicit target: only files stamped by `from` are re-stamped (id + title), persisted, count returned', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1'), file('o/r::main', 'b.js', 'other'), file('o/r::main', 'c.js', null), file('o/r::feat', 'd.js', 'sub1')];
        var writes = arm(m, files);
        var n = await m._wsTransferOwnership('sub1', 'root1');
        assert.strictEqual(n, 2);
        assert.deepStrictEqual(writes.sort(), ['a.js', 'd.js']);
        assert.strictEqual(files[0].last_modified_by_chat_id, 'root1');
        assert.strictEqual(files[0].last_modified_by_chat_title, 'Root chat');
        assert.strictEqual(files[0].last_modified_at, 123, 'timestamp is preserved (transfer is not an edit)');
        assert.strictEqual(files[3].last_modified_by_chat_id, 'root1');
        assert.strictEqual(files[1].last_modified_by_chat_id, 'other', 'foreign owner untouched');
        assert.strictEqual(files[2].last_modified_by_chat_id, null, 'unstamped untouched');
    });
    test('clean (non-dirty) rows stamped by `from` are not touched — ownership only matters for uncommitted changes', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1', false), file('o/r::main', 'b.js', 'sub1')];
        var writes = arm(m, files);
        assert.strictEqual(await m._wsTransferOwnership('sub1', 'root1'), 1);
        assert.deepStrictEqual(writes, ['b.js']);
        assert.strictEqual(files[0].last_modified_by_chat_id, 'sub1', 'clean row keeps its stamp');
    });
    test('race (a): content edited by the parent between enumeration and put is PRESERVED — only the stamp fields are written onto the fresh row', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1')];
        var stored = [];
        // Same-lineage parent edit that keeps the sub's stamp (e.g. a plain
        // content write racing the transfer): content changes, owner does not.
        var writes = arm(m, files, { stored: stored, between: function(path) { if (path === 'a.js') files[0].content = 'v2 parent edit'; } });
        assert.strictEqual(await m._wsTransferOwnership('sub1', 'root1'), 1);
        assert.deepStrictEqual(writes, ['a.js']);
        assert.strictEqual(stored[0].content, 'v2 parent edit', 'persisted row carries the CONCURRENT content, not the enumerated snapshot');
        assert.strictEqual(stored[0].last_modified_by_chat_id, 'root1');
        assert.strictEqual(stored[0].last_modified_by_chat_title, 'Root chat');
        assert.strictEqual(stored[0].last_modified_at, 123, 'timestamp still preserved');
    });
    test('race (b): row re-owned by another chat (or deleted) between enumeration and put → untouched, not counted', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1'), file('o/r::main', 'gone.js', 'sub1'), file('o/r::main', 'ok.js', 'sub1')];
        var stored = [];
        var writes = arm(m, files, { stored: stored, between: function(path) {
            if (path === 'a.js') { files[0].last_modified_by_chat_id = 'other'; files[0].last_modified_by_chat_title = 'title of other'; files[0].content = 'v2 other'; }
            if (path === 'gone.js') files.splice(1, 1); // discarded / workspace deleted
        } });
        assert.strictEqual(await m._wsTransferOwnership('sub1', 'root1'), 1);
        assert.deepStrictEqual(writes, ['ok.js']);
        assert.strictEqual(files[0].last_modified_by_chat_id, 'other', 'new owner kept');
        assert.strictEqual(files[0].last_modified_by_chat_title, 'title of other');
        assert.strictEqual(stored.length, 1);
    });
    test('re-read failure (getWorkspaceFile throws / enumeration throws) is swallowed → 0, nothing written', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1')];
        var writes = arm(m, files);
        m.__scope.getWorkspaceFile = async function() { throw new Error('idb closed'); };
        assert.strictEqual(await m._wsTransferOwnership('sub1', 'root1'), 0);
        m.__scope.getAllWorkspaceFilesAllRepos = async function() { throw new Error('idb closed'); };
        assert.strictEqual(await m._wsTransferOwnership('sub1', 'root1'), 0);
        assert.strictEqual(writes.length, 0);
        assert.strictEqual(files[0].last_modified_by_chat_id, 'sub1');
    });
    test('no explicit target → root chat id via the registry (rec.root_chat_id)', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1')];
        arm(m, files);
        assert.strictEqual(await m._wsTransferOwnership('sub1'), 1);
        assert.strictEqual(files[0].last_modified_by_chat_id, 'root1');
    });
    test('root walk via parent_chat_id when root_chat_id is missing (legacy record)', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1')];
        arm(m, files, { SubAgents: { getByChatId: function(id) { return id === 'sub1' ? { chat_id: 'sub1', parent_chat_id: 'root1' } : null; } } });
        assert.strictEqual(await m._wsTransferOwnership('sub1', null), 1);
        assert.strictEqual(files[0].last_modified_by_chat_id, 'root1');
    });
    test('no-ops: missing from, unresolvable root (== from), same from/to → 0 writes', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1')];
        var writes = arm(m, files, { SubAgents: { getByChatId: function() { return null; } } });
        assert.strictEqual(await m._wsTransferOwnership(null, 'root1'), 0);
        assert.strictEqual(await m._wsTransferOwnership('sub1'), 0, 'registry miss → root resolves to sub1 itself → nothing to do');
        assert.strictEqual(await m._wsTransferOwnership('sub1', 'sub1'), 0);
        assert.strictEqual(writes.length, 0);
        assert.strictEqual(files[0].last_modified_by_chat_id, 'sub1');
    });
    test('unknown target chat → title cleared (never stale sub title on a root id); store failure swallowed', async function() {
        var m = await load();
        var files = [file('o/r::main', 'a.js', 'sub1')];
        arm(m, files, { chats: {} });
        m.__scope.setWorkspaceFile = async function() { throw new Error('idb closed'); };
        var n = await m._wsTransferOwnership('sub1', 'root1');
        assert.strictEqual(n, 0, 'failed persist is not counted');
        assert.strictEqual(files[0].last_modified_by_chat_id, 'root1');
        assert.strictEqual(files[0].last_modified_by_chat_title, null);
    });
    test('wiring: sub-agent registry releases ownership on park / stop / error / boot-orphan (best-effort)', async function() {
        var reg = await loadFile('src/js/core/097-sub-agent-registry.js');
        assert.ok(/function _subReleaseWorkspaceOwnership\(rec\)/.test(reg), 'helper must exist');
        assert.ok(/typeof _wsTransferOwnership === 'function'/.test(reg), 'typeof-guarded');
        function bodyOf(name) {
            var i = reg.indexOf('function ' + name + '(');
            assert.ok(i > 0, name + ' must exist');
            return reg.slice(i, i + 2500);
        }
        assert.ok(/_subReleaseWorkspaceOwnership\(rec\)/.test(bodyOf('_parkSubAgent')), '_parkSubAgent');
        assert.ok(/_subReleaseWorkspaceOwnership\(rec\)/.test(bodyOf('_orphanErrorSubAtBoot')), '_orphanErrorSubAtBoot');
        var stop = bodyOf('_stopSubAgentImpl');
        var st = stop.indexOf("rec.state = 'stopped'");
        assert.ok(st > 0 && stop.slice(st).indexOf('_subReleaseWorkspaceOwnership(rec)') > 0, '_stopSubAgentImpl after state=stopped');
        var errSites = reg.split("rec.state = 'errored'").length - 1;
        assert.ok(errSites >= 3, 'errored sites still present');
    });
});

// merged-mid-task (wsPush): when the branch's previous PR was merged/closed and
// the branch is recreated, the result tells the agent WHICH kind of
// disappearance it was (previous_pr_merged) and that the PR diff is clean.
describe('merged-mid-task wsPush result wiring (tools/020-tool-execution.js)', function() {
    test('previous_pr_merged is derived from the previous PR and surfaced next to previous_pr_number', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var i = src.indexOf('async function wsPush(');
        assert.ok(i > 0, 'wsPush must exist');
        var body = src.slice(i);
        assert.ok(/_previousPrMerged = !!listRes\.body\[0\]\.merged_at;/.test(body), 'flag derived from the newest PR for the head');
        assert.ok(/previous_pr_number: _previousPrNumber \|\| undefined,\s*previous_pr_merged: _previousPrNumber \? _previousPrMerged : undefined,/.test(body), 'result carries previous_pr_merged only when a previous PR exists');
        assert.ok(/this PR contains ONLY the files pushed now/.test(body), 'stale-branch message explains the clean diff');
        assert.ok(/title: args\.pr_title,/.test(body), 'new PR payload uses the explicit pr_title, not a commit-message fallback');
        assert.ok(!/_wsDefaultPrTitle\(args\.commit_message\)/.test(body), 'removed auto-title fallback must not bypass explicit reset intent');
    });
});
