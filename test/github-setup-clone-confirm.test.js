// RC16B-F1: the github_setup popup's Clone (tools/130 cloneGitHubRepoFromSetupModal) called
// wsClone straight away, and wsClone REPLACES an existing clone of the same repo::branch (every
// local row, dirty ones included). It now asks first through the REAL ui/040
// _confirmReplaceExistingClone (loaded with 130 below), which also checks repo::master for a
// 'main' branch (wsClone's master fallback). Cancel / dismiss = nothing cloned and the popup is
// left as it was (still open, Clone enabled, inputs kept).
// Run: run_tests { files: ['test/canary.test.js', 'test/github-setup-clone-confirm.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/140-dropdowns.js', 'src/js/ui/040-tools-settings.js', 'src/js/tools/120-actions.js', 'src/js/tools/130-github-setup.js'];

function parseWsKey(k) { var i = k.lastIndexOf('::'); return { repo: k.slice(0, i), branch: k.slice(i + 2) }; }
async function load(extra) {
    var s = U.stubs();
    var win = { document: document, _rawCopyStore: {}, innerWidth: 0, innerHeight: 0, open: U.recorder(),
        addEventListener: function() {}, removeEventListener: function() {}, matchMedia: function() { return { matches: false, addEventListener: function() {} }; } };
    var g = Object.assign({ document: document, DOMParser: DOMParser, window: win, navigator: { userAgent: 'ui-test' }, CSS: CSS,
        showSnackbar: s.showSnackbar, parseWsKey: parseWsKey, apiProviders: [], llmEndpoints: [], currentProvider: null,
        DEFAULT_API_PROVIDERS: [] }, extra || {});
    var m = await loadModules(FILES, { workspace: WS, globals: g, lenient: true, passthrough: U.DOM_PASSTHROUGH });
    return { m: m, g: g, win: win, snack: s.showSnackbar };
}

describe('github_setup popup › Clone never silently replaces an existing clone (RC16B-F1)', function() {
    afterEach(function() { U.cleanupAll(); var p = document.getElementById('github-setup-modal'); if (p) p.remove(); });
    var DIRTY = [{ path: 'a.js', dirty: true, content: 'x' }, { path: 'ignored.log', dirty: true }, { path: 'b.js', content: 'y' }];
    var MAIN = { 'o/r::main': { repo: 'o/r::main', github_repo: 'o/r', branch: 'main' } };
    async function open(metas, files, confirmResult) {
        var log = [];
        var L = await load({
            getAllWorkspaceFiles: U.recorder(function() { return Promise.resolve(files); }),
            wsGetIgnoreFilterLocal: function() { return Promise.resolve(function(p) { return p === 'ignored.log'; }); },
            getWorkspaceMeta: U.recorder(function(wk) { return Promise.resolve(metas[wk] || null); }),
            showConfirmModal: U.recorder(function() { log.push('confirm'); return Promise.resolve(!!confirmResult); }),
            wsClone: U.recorder(function() { log.push('clone'); return Promise.resolve({ success: true, message: 'Cloned' }); })
        });
        L.m.__scope._wsHeaderCaches = {};
        L.log = log;
        L.m.showGitHubSetupModal({ connected: true, repo: 'o/r', branch: 'main', instanceUrl: 'https://github.com' });
        L.$ = function(sel) { return document.querySelector('#github-setup-modal ' + sel); };
        return L;
    }
    async function settle() { await U.flush(); await U.flush(); }
    test('Clone on an already-cloned dirty repo asks first; cancel clones nothing and leaves the popup as it was', async function() {
        var L = await open(MAIN, DIRTY, false);
        U.fireInline(L.$('#ghsetup-clone-btn'), 'click', L.m); await settle();
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1, 'asked before replacing the clone');
        assert.strictEqual(c[0][0], 'Replace existing clone?');
        assert.match(c[0][1], /o\/r \(main\)<\/strong>: <strong>permanently discards 1 uncommitted local change<\/strong>/);
        assert.strictEqual(c[0][2], 'danger');
        assert.strictEqual(L.g.wsClone.calls.length, 0, 'cancel: nothing cloned or replaced');
        assert.ok(document.getElementById('github-setup-modal'), 'popup still open');
        assert.strictEqual(L.$('#ghsetup-clone-btn').disabled, false, 'Clone button re-usable');
        assert.strictEqual(L.$('#ghsetup-repo').value, 'o/r');
        assert.strictEqual(L.$('#ghsetup-branch').value, 'main');
        assert.strictEqual(L.$('#ghsetup-clone-status').textContent, '');
    }, { tags: ['unit'] });
    test('confirming clones once, after the confirm, and reports the result', async function() {
        var L = await open(MAIN, [], true);
        fireEnter(L);
        await settle();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1);
        assert.match(L.g.showConfirmModal.calls[0][1], /no uncommitted local changes found/);
        assert.deepStrictEqual(L.g.wsClone.calls, [['o/r', 'main']]);
        assert.deepStrictEqual(L.log, ['confirm', 'clone']);
        assert.strictEqual(L.$('#ghsetup-clone-status').textContent, 'Cloned');
    }, { tags: ['unit'] });
    test('a repo that is not cloned yet clones without a prompt (no over-prompting)', async function() {
        var L = await open({}, [], false);
        U.fireInline(L.$('#ghsetup-clone-btn'), 'click', L.m); await settle();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 0);
        assert.deepStrictEqual(L.g.wsClone.calls, [['o/r', 'main']]);
    }, { tags: ['unit'] });
    // RC16B-F1 revision: the prefilled / typed 'main' makes wsClone fall back to (and replace)
    // repo::master when the remote has no main, so a master-only clone must be asked about too.
    var MASTER = { 'o/r::master': { repo: 'o/r::master', github_repo: 'o/r', branch: 'master' } };
    test('prefilled main with only a dirty master clone asks first (names o/r (master)); cancel leaves the popup as it was', async function() {
        var L = await open(MASTER, DIRTY, false);
        U.fireInline(L.$('#ghsetup-clone-btn'), 'click', L.m); await settle();
        var keys = L.g.getWorkspaceMeta.calls.map(function(a) { return a[0]; });
        assert.ok(keys.indexOf('o/r::main') >= 0 && keys.indexOf('o/r::master') >= 0, 'checked: ' + keys.join(','));
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1, 'asked before wsClone falls back to and replaces o/r::master');
        assert.match(c[0][1], /o\/r \(master\)<\/strong>: <strong>permanently discards 1 uncommitted local change<\/strong>/);
        assert.ok(!/o\/r \(main\)/.test(c[0][1]), 'main is not cloned, so not listed');
        assert.match(c[0][1], /main is cloned, or master if the remote has no main/);
        assert.ok(!/No branch entered/.test(c[0][1]));
        assert.strictEqual(c[0][2], 'danger');
        assert.strictEqual(L.g.wsClone.calls.length, 0, 'cancel: nothing cloned or replaced');
        assert.ok(document.getElementById('github-setup-modal'), 'popup still open');
        assert.strictEqual(L.$('#ghsetup-clone-btn').disabled, false);
        assert.strictEqual(L.$('#ghsetup-branch').value, 'main');
        assert.strictEqual(L.$('#ghsetup-clone-status').textContent, '');
    }, { tags: ['unit'] });
    test('typed main (trimmed) with only a clean master clone still asks; cancel clones nothing', async function() {
        var L = await open(MASTER, [], false);
        U.input(L.$('#ghsetup-branch'), ' main ');
        fireEnter(L); await settle();
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1, 'a clean master clone is still replaced, so still asked');
        assert.match(c[0][1], /o\/r \(master\)<\/strong>: no uncommitted local changes found/);
        assert.strictEqual(c[0][2], 'danger');
        assert.strictEqual(L.g.wsClone.calls.length, 0, 'cancel: nothing cloned or replaced');
        assert.strictEqual(L.$('#ghsetup-clone-btn').disabled, false);
        assert.strictEqual(L.$('#ghsetup-clone-status').textContent, '');
    }, { tags: ['unit'] });
    test('prefilled main with only a clean master clone: confirming clones once, after the confirm', async function() {
        var L = await open(MASTER, [], true);
        U.fireInline(L.$('#ghsetup-clone-btn'), 'click', L.m); await settle();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1);
        assert.match(L.g.showConfirmModal.calls[0][1], /o\/r \(master\)<\/strong>/);
        assert.deepStrictEqual(L.g.wsClone.calls, [['o/r', 'main']]);
        assert.deepStrictEqual(L.log, ['confirm', 'clone']);
        assert.strictEqual(L.$('#ghsetup-clone-status').textContent, 'Cloned');
    }, { tags: ['unit'] });
    // Enter in the branch input takes the same path (130 onkeydown).
    function fireEnter(L) { U.fireInline(L.$('#ghsetup-branch'), 'keydown', L.m, { key: 'Enter' }); }
});
