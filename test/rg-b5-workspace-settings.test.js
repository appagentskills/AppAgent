// RG-B5 (ZZTEST-RG): part 1 = TA-1 and TA-2; part 2 = TA-5 and TB-4; part 3 = TA-7 and TB-7b.
// TA-1: a scheme-less GitHub instance URL ('ghe.x') was kept as-is, so every token
//   link / API base built from it was RELATIVE. normalizeGitHubInstanceUrl
//   (core/130-indexeddb.js) now defaults the scheme to https://, and the raw
//   token-link sites use it: Settings openGitHubTokenPage (ui/040) and the
//   github_setup tool + popup (tools/130 executeGitHubSetup, openGitHubSetupTokenPage).
// TA-2: a re-clone (tools/020 wsClone) rebuilt the workspace meta without `prs`, so
//   the workspace forgot its PR tracking. It is carried now (like the pin), and the
//   replace-clone confirm (ui/040) says it is kept.
// TA-5: the boot cleanup (core/130 cleanupStaleWorkspaces) deleted EVERY `::`-less
//   (pre-refactor) workspace, dirty or not. It now removes only EMPTY ones, as the
//   boot call site (core/120-init.js) says, via _countWorkspaceFileRows, which
//   fails closed (an IDB error keeps the workspace).
// TB-4: a null getDeployDirHandle() means both "no folder" and "grant lapsed".
//   wsDeploy (tools/020) and the Settings button (ui/040) now tell them apart via
//   getDeployDirStatus(): a stored folder in 'prompt' OR 'denied' reads "Grant access".
// TA-7: a failed tier-alias read (core/130 getSetting) answered the default, so
//   loadTierAliases (core/030-config.js) hydrated {} and setTierAlias (ui/040) saved a
//   1-key map over the stored overrides. getSetting takes {strict:true} now (a failed
//   read rejects), loadTierAliases keeps the last good map and flags the failure, and
//   setTierAlias refuses (error snackbar) while the map is still unhydrated.
// TB-7b: saveSkill (core/130) logged and swallowed an IDB throw; it rethrows now.
// Real function sources sliced from the files and run with fakes (DOM, window.open,
// GitHub API, IDB). No live GitHub, IDB, setting or workspace.
// Run: run_tests { files: ['test/rg-b5-workspace-settings.test.js'] }
var WS = args.workspace;
var TOKEN_PATH = '/settings/tokens/new?scopes=repo&description=AppAgent';

// Slice a top-level function (it closes at the first column-0 brace) and build it
// over the given deps, so every global it touches is a fake passed in here.
async function fnFrom(file, sig, name, deps) {
    var src = await loadFile(file, WS);
    var i = src.indexOf(sig);
    assert.ok(i >= 0, file + ': ' + sig + ' must exist');
    var m = /\n\}\r?\n/.exec(src.slice(i));
    assert.ok(m, file + ': ' + name + ' must close at column 0');
    var code = src.slice(i, i + m.index + 2);
    var names = Object.keys(deps || {});
    return new Function(names.join(','), code + '\nreturn ' + name + ';').apply(null, names.map(function(k) { return deps[k]; }));
}
function normalizer() {
    return fnFrom('src/js/core/130-indexeddb.js', 'function normalizeGitHubInstanceUrl(u) {', 'normalizeGitHubInstanceUrl', {});
}
function spy(impl) {
    var f = function() { f.calls.push(Array.prototype.slice.call(arguments)); return impl ? impl.apply(null, arguments) : undefined; };
    f.calls = [];
    return f;
}
function fakeDoc(id, value) {
    return { getElementById: function(x) { return x === id && value !== null ? { value: value } : null; } };
}

describe('TA-1 a scheme-less GitHub instance URL gets https:// (no relative links)', function() {
    test('normalizeGitHubInstanceUrl defaults a missing scheme to https://', async function() {
        var norm = await normalizer();
        assert.strictEqual(norm('ghe.x'), 'https://ghe.x');
        assert.strictEqual(norm(' GHE.X/ '), 'https://ghe.x');
        assert.strictEqual(norm('ghe.x/api/'), 'https://ghe.x/api');
        assert.strictEqual(norm('localhost:8080'), 'https://localhost:8080', 'host:port is not a scheme');
        assert.strictEqual(norm('//ghe.x'), 'https://ghe.x', 'protocol-relative input');
    }, { tags: ['unit'], timeout: 5000 });

    test('controls: an empty input is the cloud default; an explicit http(s) scheme is kept', async function() {
        var norm = await normalizer();
        assert.strictEqual(norm(''), 'https://github.com');
        assert.strictEqual(norm(undefined), 'https://github.com');
        assert.strictEqual(norm('  / '), 'https://github.com');
        assert.strictEqual(norm('https://github.com/'), 'https://github.com');
        assert.strictEqual(norm('HTTPS://GitHub.com//'), 'https://github.com');
        assert.strictEqual(norm('http://ghe.local'), 'http://ghe.local');
        assert.strictEqual(norm('https://ghe.x/Api/'), 'https://ghe.x/Api', 'path case kept');
    }, { tags: ['unit'], timeout: 5000 });

    async function settingsLink(value) {
        var win = { open: spy() }, ev = { preventDefault: spy() };
        var open = await fnFrom('src/js/ui/040-tools-settings.js', 'function openGitHubTokenPage(e) {', 'openGitHubTokenPage',
            { document: fakeDoc('github-instance-url', value), window: win, normalizeGitHubInstanceUrl: await normalizer() });
        open(ev);
        assert.strictEqual(ev.preventDefault.calls.length, 1);
        assert.strictEqual(win.open.calls.length, 1, 'one tab opened');
        assert.strictEqual(win.open.calls[0][1], '_blank');
        return win.open.calls[0][0];
    }
    test('Settings > GitHub token link is absolute for a scheme-less instance (ui/040 openGitHubTokenPage)', async function() {
        assert.strictEqual(await settingsLink('ghe.x'), 'https://ghe.x' + TOKEN_PATH);
        assert.strictEqual(await settingsLink(' ghe.x/ '), 'https://ghe.x' + TOKEN_PATH);
    }, { tags: ['unit'], timeout: 5000 });

    test('controls: an empty / missing input, github.com and http:// links are unchanged', async function() {
        assert.strictEqual(await settingsLink(''), 'https://github.com' + TOKEN_PATH);
        assert.strictEqual(await settingsLink(null), 'https://github.com' + TOKEN_PATH);
        assert.strictEqual(await settingsLink('https://github.com/'), 'https://github.com' + TOKEN_PATH);
        assert.strictEqual(await settingsLink('http://ghe.local'), 'http://ghe.local' + TOKEN_PATH);
    }, { tags: ['unit'], timeout: 5000 });

    async function setupTool(stored) {
        var env = { win: { open: spy() }, modal: spy() };
        env.run = await fnFrom('src/js/tools/130-github-setup.js', 'async function executeGitHubSetup(args) {', 'executeGitHubSetup', {
            window: env.win, showGitHubSetupModal: env.modal, normalizeGitHubInstanceUrl: await normalizer(),
            loadGitHubSettings: function() { return Promise.resolve(stored || {}); }
        });
        return env;
    }
    async function popupLink(value) {
        var win = { open: spy() };
        var open = await fnFrom('src/js/tools/130-github-setup.js', 'function openGitHubSetupTokenPage(e) {', 'openGitHubSetupTokenPage',
            { document: fakeDoc('ghsetup-instance', value), window: win, normalizeGitHubInstanceUrl: await normalizer() });
        open({ preventDefault: function() {} });
        assert.strictEqual(win.open.calls.length, 1, 'one tab opened');
        return win.open.calls[0][0];
    }
    test('github_setup tool + popup token links are absolute for a scheme-less instance (tools/130)', async function() {
        var t = await setupTool({});
        var r = await t.run({ instance_url: 'ghe.x', open_token_page: true });
        assert.strictEqual(t.modal.calls[0][0].instanceUrl, 'https://ghe.x', 'popup prefilled with the normalized URL');
        assert.strictEqual(r.token_page_url, 'https://ghe.x' + TOKEN_PATH);
        assert.deepStrictEqual(t.win.open.calls, [['https://ghe.x' + TOKEN_PATH, '_blank']]);
        var legacy = await setupTool({ instanceUrl: 'ghe.x' }); // a scheme-less value stored before TA-1
        assert.strictEqual((await legacy.run({})).token_page_url, 'https://ghe.x' + TOKEN_PATH);
        assert.strictEqual(await popupLink('ghe.x'), 'https://ghe.x' + TOKEN_PATH);
    }, { tags: ['unit'], timeout: 5000 });

    test('controls: no instance = github.com; a stored https:// URL and the connected case are unchanged', async function() {
        var t = await setupTool({});
        var r = await t.run({});
        assert.strictEqual(r.token_page_url, 'https://github.com' + TOKEN_PATH);
        assert.strictEqual(t.modal.calls[0][0].instanceUrl, 'https://github.com');
        assert.strictEqual(t.win.open.calls.length, 0, 'no open_token_page: nothing opened');
        var t2 = await setupTool({ instanceUrl: 'https://ghe.x/' });
        assert.strictEqual((await t2.run({})).token_page_url, 'https://ghe.x' + TOKEN_PATH);
        var t3 = await setupTool({ instanceUrl: 'https://ghe.x', user: { login: 'octo' }, token: 't' });
        var r3 = await t3.run({ open_token_page: true });
        assert.strictEqual(r3.connected, true);
        assert.strictEqual(r3.token_page_url, undefined);
        assert.strictEqual(t3.win.open.calls.length, 0, 'connected: the token page is not opened');
        assert.strictEqual(await popupLink(''), 'https://github.com' + TOKEN_PATH);
        assert.strictEqual(await popupLink('http://ghe.local/'), 'http://ghe.local' + TOKEN_PATH);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('TA-2 a re-clone keeps the workspace PR tracking (meta.prs)', function() {
    var PRS = [{ number: 7, title: 'Fix x', state: 'open', url: 'https://github.com/o/r/pull/7', branch: 'fix/x', files: [{ path: 'a.js' }] }];
    async function clone(metas, opts) {
        opts = opts || {};
        var ok = function() { return Promise.resolve(); };
        var env = { setMeta: spy(ok), delMeta: spy(ok), delFiles: spy(ok), files: [] };
        var wsClone = await fnFrom('src/js/tools/020-tool-execution.js', 'async function wsClone(repo, branch) {', 'wsClone', {
            loadGitHubSettings: function() { return Promise.resolve({ token: 't' }); },
            wsKey: function(repo, branch) { return repo + '::' + branch; },
            githubApi: function(method, path) {
                if (path.indexOf('/git/ref/heads/') >= 0) {
                    var b = decodeURIComponent(path.split('/git/ref/heads/')[1]);
                    return Promise.resolve(opts.noMain && b === 'main' ? { ok: false, status: 404 } : { ok: true, body: { object: { sha: 'head-' + b } } });
                }
                if (path.indexOf('/git/trees/') >= 0) {
                    return Promise.resolve({ ok: true, body: { sha: 'tree1', truncated: false,
                        tree: [{ path: 'a.js', type: 'blob', sha: 's1', size: 3 }, { path: 'src', type: 'tree', sha: 't2' }] } });
                }
                return Promise.resolve({ ok: false, status: 404 });
            },
            getWorkspaceMeta: function(wk) { return Promise.resolve(metas[wk] || null); },
            deleteWorkspaceFiles: env.delFiles,
            deleteWorkspaceMeta: env.delMeta,
            getWorkspaceBlobsBySha: function() { return Promise.resolve({}); },
            getAllWorkspaceFilesAllRepos: function() { return Promise.resolve([]); },
            newFileId: function() { return 'f' + env.files.length; },
            setWorkspaceFile: function(row) { env.files.push(row); return Promise.resolve(); },
            registerFile: function() {},
            setWorkspaceMeta: env.setMeta,
            wsHydrate: function() { return Promise.resolve(); },
            AgentEvents: { emit: function() {} },
            gcWorkspaceBlobs: function() {}
        });
        env.result = await wsClone('o/r', opts.branch);
        assert.strictEqual(env.result.success, true, JSON.stringify(env.result));
        assert.strictEqual(env.setMeta.calls.length, 1, 'meta written once');
        env.meta = env.setMeta.calls[0][0];
        return env;
    }

    test('a re-clone keeps meta.prs (and the pin + fork lineage) of the clone it replaces', async function() {
        var env = await clone({ 'o/r::main': { repo: 'o/r::main', github_repo: 'o/r', branch: 'main', pinned: true,
            forked_from: 'o/r::dev', base_branch: 'dev', prs: PRS } });
        assert.strictEqual(env.delMeta.calls.length, 1, 'the existing clone was replaced');
        assert.deepStrictEqual(env.meta.prs, PRS, 'PR tracking carried across the re-clone');
        assert.strictEqual(env.meta.pinned, true);
        assert.strictEqual(env.meta.forked_from, 'o/r::dev');
        assert.strictEqual(env.meta.base_branch, 'dev');
        assert.strictEqual(env.meta.repo, 'o/r::main');
        assert.strictEqual(env.meta.head_sha, 'head-main', 'the rest of the meta is rebuilt');
    }, { tags: ['unit'], timeout: 5000 });

    test('the main -> master fallback carries the prs of the master clone it replaces', async function() {
        var env = await clone({ 'o/r::main': { repo: 'o/r::main', prs: [{ number: 1 }] },
            'o/r::master': { repo: 'o/r::master', branch: 'master', prs: PRS } }, { noMain: true });
        assert.strictEqual(env.result.workspace, 'o/r::master');
        assert.strictEqual(env.meta.repo, 'o/r::master');
        assert.deepStrictEqual(env.meta.prs, PRS, 'the master clone\u2019s own PR list, not main\u2019s');
    }, { tags: ['unit'], timeout: 5000 });

    test('control: a first clone has no prs, pin or lineage and deletes nothing', async function() {
        var env = await clone({});
        assert.strictEqual(env.delMeta.calls.length, 0);
        assert.strictEqual(env.delFiles.calls.length, 0);
        assert.ok(!('prs' in env.meta) && !('pinned' in env.meta) && !('forked_from' in env.meta), JSON.stringify(Object.keys(env.meta)));
        assert.strictEqual(env.files.length, 1, 'only the blob entry is stored');
    }, { tags: ['unit'], timeout: 5000 });

    test('the replace-clone confirm says the PR tracking is kept (ui/040 _confirmReplaceExistingClone)', async function() {
        var confirm = spy(function() { return Promise.resolve(true); });
        var fn = await fnFrom('src/js/ui/040-tools-settings.js', 'async function _confirmReplaceExistingClone(repo, branch) {', '_confirmReplaceExistingClone', {
            _wsHeaderCaches: {},
            getWorkspaceMeta: function(wk) { return Promise.resolve(wk === 'o/r::dev' ? { repo: wk } : null); },
            _wsDirtyCountFresh: function() { return Promise.resolve(0); },
            escapeHtml: function(t) { return String(t); },
            showConfirmModal: confirm
        });
        assert.strictEqual(await fn('o/r', 'dev'), true);
        assert.strictEqual(confirm.calls.length, 1, 'an existing clone asks first');
        var body = confirm.calls[0][1];
        assert.match(body, /Gitignored files \(not counted\) are lost too; the workspace\u2019s PR tracking is kept\. Continue\?/);
        assert.ok(!/PR tracking (are|is) (lost|replaced|deleted)/.test(body), 'no longer claims the tracking is lost');
    }, { tags: ['unit'], timeout: 5000 });
});

// ---- RG-B5 part 2 (RG-F28): TA-5 and TB-4 ----
var C130 = 'src/js/core/130-indexeddb.js';
var U040 = 'src/js/ui/040-tools-settings.js';
function legacyCleanup(metas, countImpl) {
    var deleted = [];
    return fnFrom(C130, 'async function cleanupStaleWorkspaces() {', 'cleanupStaleWorkspaces', {
        getAllWorkspaceMetas: function() { return Promise.resolve(metas); },
        _countWorkspaceFileRows: countImpl,
        deleteWorkspaceFiles: function(r) { deleted.push('files:' + r); return Promise.resolve(); },
        deleteWorkspaceMeta: function(r) { deleted.push('meta:' + r); return Promise.resolve(); },
        console: { log: function() {}, warn: function() {} }
    }).then(function(fn) { return { run: fn, deleted: deleted }; });
}
// Fake IDB for the row count: index('repo').count(repo) answers asynchronously.
function fakeFilesDb(counts, failRepo, log) {
    return { transaction: function(stores, mode) {
        log.push('tx:' + stores.join(',') + ':' + mode);
        return { objectStore: function(n) { return { index: function(ix) {
            log.push('index:' + n + '.' + ix);
            return { count: function(repo) {
                var req = {};
                Promise.resolve().then(function() {
                    if (repo === failRepo) { req.error = new Error('count boom'); if (req.onerror) req.onerror(); }
                    else { req.result = counts[repo] || 0; if (req.onsuccess) req.onsuccess(); }
                });
                return req;
            } };
        } }; } };
    } };
}

describe('TA-5 the boot cleanup keeps legacy (::-less) workspaces that still hold files', function() {
    test('a dirty (or clean, non-empty) legacy workspace survives; only the empty one is removed', async function() {
        var counted = [];
        var c = await legacyCleanup([{ repo: 'o/legacy-dirty' }, { repo: 'o/legacy-clean' }, { repo: 'o/legacy-empty' }, { repo: 'o/r::main' }],
            function(r) { counted.push(r); return Promise.resolve({ 'o/legacy-dirty': 3, 'o/legacy-clean': 1 }[r] || 0); });
        await c.run();
        assert.deepStrictEqual(c.deleted, ['files:o/legacy-empty', 'meta:o/legacy-empty']);
        assert.deepStrictEqual(counted, ['o/legacy-dirty', 'o/legacy-clean', 'o/legacy-empty'], 'only ::-less metas are counted');
    }, { tags: ['unit'], timeout: 5000 });
    test('the row count fails closed: an IDB error rejects (never reads as empty) and the workspace is kept', async function() {
        var log = [];
        var count = await fnFrom(C130, 'function _countWorkspaceFileRows(repo) {', '_countWorkspaceFileRows', {
            openDatabase: function() { return Promise.resolve(fakeFilesDb({ 'o/legacy-dirty': 2 }, 'o/legacy-broken', log)); },
            workspaceFilesStoreName: 'workspace_files'
        });
        assert.strictEqual(await count('o/legacy-dirty'), 2);
        assert.strictEqual(await count('o/legacy-empty'), 0);
        var err = null;
        try { await count('o/legacy-broken'); } catch (e) { err = e; }
        assert.ok(err && /count boom/.test(err.message), 'a failed count rejects with the IDB error');
        assert.ok(log.indexOf('tx:workspace_files:readonly') >= 0 && log.indexOf('index:workspace_files.repo') >= 0, 'counts the repo index, read-only');
        var c = await legacyCleanup([{ repo: 'o/legacy-broken' }, { repo: 'o/legacy-empty' }], count);
        await c.run();
        assert.deepStrictEqual(c.deleted, ['files:o/legacy-empty', 'meta:o/legacy-empty'], 'a failed count keeps the workspace');
    }, { tags: ['unit'], timeout: 5000 });
    test('control: new-format (::) workspaces are never counted or deleted', async function() {
        var counted = [];
        var c = await legacyCleanup([{ repo: 'o/r::main' }, { repo: 'o/r::dev' }, {}], function(r) { counted.push(r); return Promise.resolve(0); });
        await c.run();
        assert.deepStrictEqual(c.deleted, []);
        assert.deepStrictEqual(counted, []);
    }, { tags: ['unit'], timeout: 5000 });
});

function fakeDeployDom() {
    var cls = {};
    var btn = { textContent: 'Connect Folder', dataset: {}, style: {},
        classList: { add: function(c) { cls[c] = 1; }, remove: function(c) { delete cls[c]; }, contains: function(c) { return !!cls[c]; } } };
    var disc = { style: { display: 'none' } };
    return { btn: btn, disc: disc, getElementById: function(id) { return id === 'deploy-dir-btn' ? btn : id === 'deploy-dir-disconnect-btn' ? disc : null; } };
}
async function deployButton(status) {
    var dom = fakeDeployDom(), handle = spy(function() { return Promise.resolve(null); });
    var update = await fnFrom(U040, 'async function updateDeployDirButton() {', 'updateDeployDirButton', {
        document: dom, getDeployDirStatus: function() { return Promise.resolve(status); }, getDeployDirHandle: handle
    });
    await update();
    return { btn: dom.btn, disc: dom.disc, handle: handle };
}
async function deployNoHandle(status) {
    var deploy = await fnFrom('src/js/tools/020-tool-execution.js', 'async function wsDeploy(wk, srcPath, destSubdir, opts) {', 'wsDeploy', {
        getDeployDirHandle: function() { return Promise.resolve(null); },
        getDeployDirStatus: typeof status === 'function' ? status : function() { return Promise.resolve(status); }
    });
    return deploy('o/r::main');
}

describe('TB-4 a stored folder whose grant lapsed (prompt OR denied) reads "Grant access"', function() {
    test('Settings: stored + denied -> "Grant access" (not "Connect Folder"), Disconnect shown, passive', async function() {
        var r = await deployButton({ state: 'denied', name: 'my-ext' });
        assert.strictEqual(r.btn.textContent, 'Grant access');
        assert.strictEqual(r.btn.dataset.state, 'denied');
        assert.ok(!r.btn.classList.contains('connected'));
        assert.strictEqual(r.disc.style.display, '', 'a stored folder offers Disconnect');
        assert.strictEqual(r.handle.calls.length, 0, 'status only, never the handle getter');
    }, { tags: ['unit'], timeout: 5000 });
    test('control: none -> "Connect Folder" (no Disconnect); prompt -> "Grant access"; granted -> the folder name', async function() {
        var none = await deployButton({ state: 'none' });
        assert.strictEqual(none.btn.textContent, 'Connect Folder');
        assert.strictEqual(none.disc.style.display, 'none');
        assert.strictEqual((await deployButton({ state: 'prompt', name: 'my-ext' })).btn.textContent, 'Grant access');
        var ok = await deployButton({ state: 'granted', name: 'my-ext' });
        assert.strictEqual(ok.btn.textContent, 'my-ext');
        assert.ok(ok.btn.classList.contains('connected'));
    }, { tags: ['unit'], timeout: 5000 });
    test('control: the click re-grants only a prompt grant; a denied one re-picks the folder', async function() {
        async function click(state) {
            var dom = fakeDeployDom();
            dom.btn.dataset.state = state;
            var deps = { document: dom,
                getDeployDirHandle: spy(function() { return Promise.resolve({ name: 'my-ext' }); }),
                pickDeployDir: spy(function() { return Promise.resolve({ name: 'my-ext' }); }),
                updateDeployDirButton: spy(function() { return Promise.resolve(); }),
                updateReloadBtnVisibility: spy(function() {}),
                showSnackbar: spy(function() {}) };
            var connect = await fnFrom(U040, 'async function connectDeployDir() {', 'connectDeployDir', deps);
            await connect();
            return deps;
        }
        var d = await click('denied');
        assert.strictEqual(d.pickDeployDir.calls.length, 1, 'denied: requestPermission cannot prompt, so the folder is re-picked');
        assert.strictEqual(d.getDeployDirHandle.calls.length, 0);
        var p = await click('prompt');
        assert.deepStrictEqual(p.getDeployDirHandle.calls, [[{ interactive: true }]]);
        assert.strictEqual(p.pickDeployDir.calls.length, 0);
    }, { tags: ['unit'], timeout: 5000 });
    test('wsDeploy: stored + denied/prompt -> the error names "Grant access", not "No deploy folder connected"', async function() {
        var den = await deployNoHandle({ state: 'denied', name: 'my-ext' });
        assert.strictEqual(den.success, false);
        assert.match(den.error, /Grant access/);
        assert.match(den.error, /"my-ext"/);
        assert.ok(!/No deploy folder connected/.test(den.error));
        assert.match((await deployNoHandle({ state: 'prompt', name: 'my-ext' })).error, /Grant access/);
    }, { tags: ['unit'], timeout: 5000 });
    test('control: wsDeploy with no stored folder (or a failing status read) keeps "Connect Folder"', async function() {
        var OLD = 'No deploy folder connected. Go to Settings > GitHub > Connect Folder.';
        assert.deepStrictEqual(await deployNoHandle({ state: 'none' }), { success: false, error: OLD });
        assert.deepStrictEqual(await deployNoHandle(function() { return Promise.reject(new Error('idb gone')); }), { success: false, error: OLD });
    }, { tags: ['unit'], timeout: 5000 });
});

// ---- RG-B5 part 3 (RG-F30): TA-7 and TB-7b ----
var C030 = 'src/js/core/030-config.js';
// fnFrom's slice, returned as code, so several real functions share ONE scope.
async function fnSrc(file, sig) {
    var src = await loadFile(file, WS);
    var i = src.indexOf(sig);
    assert.ok(i >= 0, file + ': ' + sig + ' must exist');
    var m = /\n\}\r?\n/.exec(src.slice(i));
    assert.ok(m, file + ': ' + sig + ' must close at column 0');
    return src.slice(i, i + m.index + 2);
}
// Fake settings IDB (withStore + store.get/put). Fault 'reqerror' fails the get
// request (onerror); 'throw' rejects a readonly withStore. Faults hit READS only, so
// a clobbering write still lands (as it would live).
function fakeSettingsIdb() {
    var db = { rows: {}, puts: [], fault: null };
    db.withStore = function(stores, mode, fn) {
        if (db.fault === 'throw' && mode === 'readonly') return Promise.reject(new Error('idb gone'));
        var tx = { objectStore: function() { return {
            get: function(key) {
                var req = {};
                Promise.resolve().then(function() {
                    if (db.fault === 'reqerror') { req.error = new Error('get boom'); if (req.onerror) req.onerror(); }
                    else { req.result = db.rows[key] ? JSON.parse(JSON.stringify(db.rows[key])) : undefined; if (req.onsuccess) req.onsuccess(); }
                });
                return req;
            },
            put: function(r) { r = JSON.parse(JSON.stringify(r)); db.puts.push(r); db.rows[r.key] = r; }
        }; } };
        return Promise.resolve().then(function() { return fn(tx); });
    };
    return db;
}
// The REAL tier-alias chain in ONE scope: the core/030 region the other tier tests
// slice (it declares the map and, since TA-7, the read-failed flag) + saveTierAliases,
// core/130 getSetting/setSetting and ui/040 setTierAlias.
async function tierScope(stored) {
    var cfg = await loadFile(C030, WS);
    var from = cfg.indexOf('// ─── Per-spawn model selection'), to = cfg.indexOf('// Persist an updated alias map', from);
    assert.ok(from >= 0 && to > from, 'core/030 tier region must exist');
    var code = [cfg.slice(from, to), await fnSrc(C030, 'async function saveTierAliases(map) {'),
        await fnSrc(C130, 'async function getSetting(key, defaultValue'), await fnSrc(C130, 'async function setSetting(key, value) {'),
        await fnSrc(U040, 'async function setTierAlias(tier, providerName) {')].join('\n');
    var db = fakeSettingsIdb(), snack = spy(), con = { log: function() {}, warn: spy(), error: spy() };
    var names = ['withStore', 'settingsStoreName', 'TIER_ALIASES_SETTING_KEY', 'apiProviders', 'PROVIDER_RENAMES', 'showSnackbar', 'console'];
    var s = new Function(names.join(','), code + '\nreturn { load: loadTierAliases, set: setTierAlias, getSetting: getSetting, key: TIER_ALIASES_SETTING_KEY,' +
        ' state: function() { return { map: subAgentTierAliases, failed: typeof subAgentTierAliasesReadFailed === "undefined" ? "undeclared" : subAgentTierAliasesReadFailed }; } };')
        .apply(null, [db.withStore, 'settings', 'TK', [], {}, snack, con]);
    s.db = db; s.snack = snack; s.con = con;
    if (stored !== undefined) db.rows[s.key] = { key: s.key, value: stored };
    return s;
}
function storedRow(s) { return s.db.rows[s.key] ? s.db.rows[s.key].value : undefined; }

describe('TA-7 a failed tier-alias read never clobbers the stored overrides', function() {
    test('a get request error: setTierAlias refuses (row unchanged, 0 puts, error snackbar, false)', async function() {
        var s = await tierScope({ small: 'A', large: 'B' });
        s.db.fault = 'reqerror';
        assert.strictEqual(await s.set('medium', 'C'), false);
        assert.strictEqual(s.db.puts.length, 0, 'nothing written');
        assert.deepStrictEqual(storedRow(s), { small: 'A', large: 'B' });
        assert.strictEqual(s.snack.calls.length, 1);
        assert.strictEqual(s.snack.calls[0][1], 'error');
        assert.match(s.snack.calls[0][0], /not saved/);
        assert.deepStrictEqual(s.state(), { map: null, failed: true }, 'still unhydrated, and flagged');
    }, { tags: ['unit'], timeout: 5000 });
    test('a rejected withStore read: the same refusal', async function() {
        var s = await tierScope({ small: 'A', large: 'B' });
        s.db.fault = 'throw';
        assert.strictEqual(await s.set('medium', 'C'), false);
        assert.strictEqual(s.db.puts.length, 0);
        assert.deepStrictEqual(storedRow(s), { small: 'A', large: 'B' });
        assert.strictEqual(s.snack.calls.length, 1);
        assert.strictEqual(s.snack.calls[0][1], 'error');
    }, { tags: ['unit'], timeout: 5000 });
    test('retry: once the read works again the change merges into the stored map', async function() {
        var s = await tierScope({ small: 'A', large: 'B' });
        s.db.fault = 'reqerror';
        assert.strictEqual(await s.set('medium', 'C'), false);
        s.db.fault = null;
        await s.set('medium', 'C');
        assert.deepStrictEqual(storedRow(s), { small: 'A', large: 'B', medium: 'C' });
        assert.strictEqual(s.db.puts.length, 1);
        assert.strictEqual(s.state().failed, false, 'the good read clears the flag');
    }, { tags: ['unit'], timeout: 5000 });
    test('SW gate: a failing re-read keeps the last good map (not {})', async function() {
        var s = await tierScope({ small: 'A', large: 'B' });
        assert.strictEqual((await s.load()).small, 'A');
        s.db.fault = 'reqerror';
        var map = await s.load();
        assert.strictEqual(map.small, 'A', 'resolution keeps the stored small override');
        assert.strictEqual(map.large, 'B');
        assert.deepStrictEqual(s.state(), { map: { small: 'A', large: 'B' }, failed: true });
        await s.set('medium', 'C');
        assert.deepStrictEqual(storedRow(s), { small: 'A', large: 'B', medium: 'C' }, 'a map from a good read still merges');
    }, { tags: ['unit'], timeout: 5000 });
    test('control: a normal hydrate + save merges into the stored overrides', async function() {
        var s = await tierScope({ small: 'A' });
        await s.set('large', 'B');
        assert.deepStrictEqual(storedRow(s), { small: 'A', large: 'B' });
        assert.strictEqual(s.db.puts.length, 1);
        assert.strictEqual(s.snack.calls.length, 0);
    }, { tags: ['unit'], timeout: 5000 });
    test('control: a missing key still hydrates {} and saves the single override', async function() {
        var s = await tierScope();
        await s.set('small', 'X');
        assert.deepStrictEqual(storedRow(s), { small: 'X' });
        assert.strictEqual(s.snack.calls.length, 0);
    }, { tags: ['unit'], timeout: 5000 });
    test('control: non-strict getSetting still answers the default on a read error', async function() {
        var s = await tierScope({ small: 'A' });
        s.db.fault = 'reqerror';
        assert.strictEqual(await s.getSetting(s.key, 'dflt'), 'dflt');
        s.db.fault = 'throw';
        assert.strictEqual(await s.getSetting(s.key, 'dflt'), 'dflt');
        s.db.fault = null;
        assert.deepStrictEqual(await s.getSetting(s.key, 'dflt'), { small: 'A' });
        assert.strictEqual(await s.getSetting('nope', 'dflt'), 'dflt');
    }, { tags: ['unit'], timeout: 5000 });
});

describe('TB-7b saveSkill rejects when the IDB write throws (no silent success)', function() {
    function skillSaver(openDb, mem, con) {
        return fnFrom(C130, 'async function saveSkill(skill) {', 'saveSkill',
            { openDatabase: openDb, skillsStoreName: 'skills', skills: mem, console: con || { error: function() {} } });
    }
    async function rejection(p) { try { await p; } catch (e) { return e; } return null; }
    test('openDatabase rejects -> saveSkill rejects; memory unchanged', async function() {
        var prev = { id: 's1', v: 1 }, mem = { s1: prev }, err = new Error('idb blocked'), con = { error: spy() };
        var save = await skillSaver(function() { return Promise.reject(err); }, mem, con);
        assert.strictEqual(await rejection(save({ id: 's1', v: 2 })), err);
        assert.strictEqual(mem.s1, prev, 'memory keeps the last saved copy');
        assert.strictEqual(con.error.calls.length, 1, 'still logged');
    }, { tags: ['unit'], timeout: 5000 });
    test('put throws (DataCloneError) -> saveSkill rejects; memory unchanged', async function() {
        var err = new Error('could not be cloned'); err.name = 'DataCloneError';
        var mem = {}, db = { transaction: function() { return { objectStore: function() { return { put: function() { throw err; } }; } }; } };
        var save = await skillSaver(function() { return Promise.resolve(db); }, mem);
        assert.strictEqual(await rejection(save({ id: 's2' })), err);
        assert.strictEqual('s2' in mem, false);
    }, { tags: ['unit'], timeout: 5000 });
    test('control: a good save resolves, writes one row and updates memory', async function() {
        var log = [], mem = {}, sk = { id: 's3' };
        var db = { transaction: function(stores, mode) { log.push(stores.join(',') + ':' + mode);
            return { objectStore: function(n) { return { put: function(r) { log.push('put:' + n + ':' + r.id); } }; } }; } };
        var save = await skillSaver(function() { return Promise.resolve(db); }, mem);
        assert.strictEqual(await rejection(save(sk)), null, 'resolves');
        assert.deepStrictEqual(log, ['skills:readwrite', 'put:skills:s3']);
        assert.strictEqual(mem.s3, sk);
    }, { tags: ['unit'], timeout: 5000 });
});
