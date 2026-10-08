// Sidebar "Workspace Files" must not count gitignored build output (dist/
// written by Reload / extension_build) as chat work, and wsWrite must not stamp
// chat ownership on gitignored paths. Both reuse the REAL parseGitignore.
describe('gitignored workspace files are not chat-owned', function() {
    var GITIGNORE = 'node_modules/\ndist/\n.env\n';
    var T = null;
    async function tools() {
        if (T) return T;
        T = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        return T;
    }

    test('sidebar owned rows drop gitignored paths using the workspace .gitignore', async function() {
        var m = await tools();
        var src = await loadFile('src/js/ui/115-workspace-files-sidebar.js');
        var filterCalls = [];
        var rows = [
            { path: 'src/platform/extension/background.js', wsKey: 'o/r::main', owner: 'c1', isNew: false, isDeleted: false, pushedPr: null },
            { path: 'dist/extension/manifest.json', wsKey: 'o/r::main', owner: 'c1', isNew: true, isDeleted: false, pushedPr: null },
            { path: 'dist/extension/_locales/fr/messages.json', wsKey: 'o/r::main', owner: 'c1', isNew: true, isDeleted: false, pushedPr: null },
            { path: 'dist/out.js', wsKey: 'o/noignore::main', owner: 'c1', isNew: true, isDeleted: false, pushedPr: null }
        ];
        var api = new Function('getWorkspaceOwnedFileSummaries', 'wsGetIgnoreFilterLocal', 'renderVersionSidebar', 'AgentEvents',
            src + '\nreturn { refresh: _wsfRefreshOwnedRows, owned: _wsfOwnedForChat };')(
            async function() { return rows; },
            async function(wk) { filterCalls.push(wk); return m.parseGitignore(wk === 'o/r::main' ? GITIGNORE : ''); },
            function() {},
            { on: function() {} }
        );
        await api.refresh();
        var owned = api.owned({ id: 'c1' }).map(function(r) { return r.wsKey + ':' + r.path; });
        assert.deepStrictEqual(owned, ['o/r::main:src/platform/extension/background.js', 'o/noignore::main:dist/out.js']);
        assert.deepStrictEqual(filterCalls, ['o/r::main', 'o/noignore::main'], 'one local filter load per workspace');
    }, { tags: ['unit'], timeout: 5000 });

    test('wsWrite leaves gitignored rows unstamped but stamps tracked paths', async function() {
        var m = await tools();
        // Real wsGetIgnoreFilter reads .gitignore through getWorkspaceFile.
        var stored = { '.gitignore': { path: '.gitignore', content: GITIGNORE, original_content: GITIGNORE, sha: 'g', dirty: false } };
        m.__scope.getWorkspaceMeta = async function() { return { repo: 'o/r::main' }; };
        m.__scope.getWorkspaceFile = async function(repo, p) { return stored[p] || null; };
        m.__scope.setWorkspaceFileIf = async function(repo, p, expected, row) { stored[p] = row; return { ok: true }; };
        m.__scope.registerFile = function() {};
        m.__scope.newFileId = function() { return 'file_x'; };
        m.__scope.isChatRunning = function() { return false; };
        var d = await m.wsWrite('o/r::main', 'dist/extension/app.js', 'built', 'chatA', 'Chat A');
        var s = await m.wsWrite('o/r::main', 'src/js/a.js', 'edit', 'chatA', 'Chat A');
        assert.strictEqual(d.success, true);
        assert.strictEqual(s.success, true);
        assert.strictEqual(stored['dist/extension/app.js'].dirty, true, 'build output still written dirty');
        assert.strictEqual(stored['dist/extension/app.js'].last_modified_by_chat_id, null);
        assert.strictEqual(stored['dist/extension/app.js'].last_modified_by_chat_title, null);
        assert.strictEqual(stored['src/js/a.js'].last_modified_by_chat_id, 'chatA');
        assert.strictEqual(stored['src/js/a.js'].last_modified_by_chat_title, 'Chat A');
    }, { tags: ['unit'], timeout: 5000 });
});
