// Documents page folder navigation <-> browser history (tools/110-smart-documents.js):
// folder changes push {view:'documents', docSel, docPath}; restoring an entry never
// pushes; dead sources / workspace folders fall back to the root via replaceState.
describe('documents folder history', function() {
    var H, STORE;
    function fakeHistory(initial) {
        var h = { entries: [initial || null], idx: 0, pushes: 0, replaces: 0 };
        Object.defineProperty(h, 'state', { get: function() { return h.entries[h.idx]; } });
        h.pushState = function(s) { h.entries = h.entries.slice(0, h.idx + 1); h.entries.push(JSON.parse(JSON.stringify(s))); h.idx++; h.pushes++; };
        h.replaceState = function(s) { h.entries[h.idx] = JSON.parse(JSON.stringify(s)); h.replaces++; };
        return h;
    }
    async function load(initial, extra) {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        H = fakeHistory(initial); STORE = {};
        var g = Object.assign({
            chats: {}, currentChatId: null, currentView: 'documents', isHandlingPopState: false, history: H,
            escDisplay: function(s) { return String(s); }, escapeHtml: function(s) { return String(s); },
            appStorage: { getItem: function(k) { return STORE[k] || null; }, setItem: function(k, v) { STORE[k] = v; } }
        }, extra || {});
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: g });
        // Rendering is not under test here.
        m.__scope.sdocRenderSourcesStrip = function() {};
        m.__scope.renderDocumentsPageItems = function() {};
        return m;
    }
    var lf = { id: 'lf:f1', type: 'local', folderId: 'f1', label: 'F', access: 'read', permission: 'granted' };
    var ws = { id: 'ws:o/r::main', type: 'ws', wk: 'o/r::main', label: 'o/r', access: 'read', permission: 'granted' };

    test('folder changes push entries; same folder does not duplicate', async function() {
        var m = await load({ view: 'documents', chatId: null, skillId: null });
        m.sdocSyncFolderHistory(true); // openDocumentsView stamp
        assert.strictEqual(H.pushes, 0);
        assert.deepStrictEqual([H.state.docSel, H.state.docPath], ['all', '']);
        m.sdocSelectSource('lf:f1');
        assert.strictEqual(H.pushes, 1);
        assert.deepStrictEqual([H.state.view, H.state.docSel, H.state.docPath], ['documents', 'lf:f1', '']);
        m.sdocSrcState.rendered = [{ src: lf, entry: { kind: 'directory', name: 'a', path: 'a' } }];
        m.sdocOpenFileRow(0);
        assert.deepStrictEqual([H.pushes, H.state.docPath], [2, 'a']);
        m.sdocSrcNavigate('a'); // breadcrumb on the current folder
        assert.strictEqual(H.pushes, 2, 'no duplicate entry');
        m.sdocSrcNavigate(''); // breadcrumb to root is tracked too
        assert.deepStrictEqual([H.pushes, H.state.docPath], [3, '']);
    }, { tags: ['unit'], timeout: 5000 });

    test('applying an entry restores without pushing; pops are push-free', async function() {
        var m = await load({ view: 'documents', chatId: null, skillId: null, docSel: 'lf:f1', docPath: 'a/b' });
        m.sdocSrcState.sources = [lf];
        assert.strictEqual(m.sdocApplyHistoryFolder(H.state), true);
        assert.deepStrictEqual([m.sdocSrcState.sel, m.sdocSrcState.path], ['lf:f1', 'a/b']);
        assert.strictEqual(STORE.documentsPageSource, 'lf:f1');
        assert.strictEqual(H.pushes + H.replaces, 0);
        assert.strictEqual(m.sdocApplyHistoryFolder({ view: 'documents', chatId: null, skillId: null }), false, 'plain page entry');
        m.__scope.isHandlingPopState = true;
        m.sdocSrcNavigate('a');
        assert.strictEqual(H.pushes, 0, 'no push while handling popstate');
    }, { tags: ['unit'], timeout: 5000 });

    test('dead source or workspace folder falls back to root (replace)', async function() {
        var m = await load({ view: 'documents', chatId: null, skillId: null, docSel: 'lf:gone', docPath: 'x' });
        m.sdocSrcState.sources = [lf, ws];
        m.sdocSrcState.wsRows = { 'o/r::main': [{ path: 'src/a.js' }, { path: 'old/b.js', deleted: true }] };
        m.sdocApplyHistoryFolder(H.state);
        assert.deepStrictEqual([m.sdocSrcState.sel, m.sdocSrcState.path, H.state.docSel, H.pushes], ['all', '', 'all', 0]);
        m.sdocApplyHistoryFolder({ view: 'documents', docSel: 'ws:o/r::main', docPath: 'old' });
        assert.deepStrictEqual([m.sdocSrcState.sel, m.sdocSrcState.path], ['ws:o/r::main', ''], 'deleted ws folder -> root');
        m.sdocApplyHistoryFolder({ view: 'documents', docSel: 'ws:o/r::main', docPath: 'src' });
        assert.strictEqual(m.sdocSrcState.path, 'src', 'live ws folder kept');
        m.sdocApplyHistoryFolder({ view: 'documents', docSel: 'ws:o/r::main', docPath: '#pr/7' });
        assert.strictEqual(m.sdocSrcState.path, '#pr/7', 'PR folders not validated against rows');
        assert.strictEqual(H.pushes, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('outside the documents view nothing is written', async function() {
        var m = await load({ view: 'chat', chatId: 'c1', skillId: null }, { currentView: 'chat' });
        m.sdocSelectSource('lf:f1');
        assert.strictEqual(H.pushes + H.replaces, 0);
        assert.strictEqual(H.state.view, 'chat');
    }, { tags: ['unit'], timeout: 5000 });
});
