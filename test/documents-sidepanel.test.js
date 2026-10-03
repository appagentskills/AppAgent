// Documents page in the narrow side panel (tools/110-smart-documents.js + css/21c, css/29):
// PRs are top-level siblings right after their workspace (rail, narrow <select>, All view),
// pr:<wk>#<n> routes to the workspace at '#pr/<n>', and file/folder rows carry the type classes
// the CSS tints in both rows and gallery. Real modules; only storage/network are stubbed.
describe('documents side panel: PR folders + type icons', function() {
    var MODS = ['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'];
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    var WS = { id: 'ws:o/r::main', type: 'ws', wk: 'o/r::main', label: 'o/r', branch: 'main', count: 2, access: 'read', permission: 'granted',
        prs: [{ number: 12, title: 'Open one', state: 'open', branch: 'b12' }, { number: 9, title: 'Merged one', state: 'merged', branch: 'b9' }] };
    var LF = { id: 'lf:1', type: 'local', folderId: '1', label: 'Docs', access: 'readwrite', permission: 'granted' };
    async function load() {
        var W = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: W }, W);
        var m = await U.loadUi(MODS, { globals: {
            chats: {}, currentChatId: 'c1', currentView: 'documents', LOCAL_FOLDER_VIRTUAL_ID: 'virtual',
            escDisplay: esc, escapeHtml: esc,
            appStorage: { getItem: function() { return null; }, setItem: function() {} },
            lfListDir: async function() { return { entries: [
                { name: 'sub', path: 'sub', kind: 'directory' },
                { name: 'a.js', path: 'a.js', kind: 'file', size: 10, lastModified: Date.now() - 60000 },
                { name: 'b.pdf', path: 'b.pdf', kind: 'file', size: 20 }] }; },
            githubApi: function() { return Promise.resolve({ error: 'no stub' }); }
        } });
        var mount = await U.mountDom({ html: '<div id="documents-list" class="sdoc-rail-layout"><nav class="sdoc-rail" id="documents-sources"></nav>' +
            '<div class="sdoc-pane" id="sdoc-pane"><div class="sdoc-pane-head" id="sdoc-pane-head"></div><span id="documents-count"></span><div id="documents-items"></div></div></div>' });
        m.sdocSrcState.sources = [LF, WS];
        m.sdocSrcState.wsRows = { 'o/r::main': [] };
        return { m: m, U: U, mount: mount };
    }
    async function render(e) { e.m.sdocRenderSourcesStrip(); e.m.renderDocumentsPageItems(); await e.U.flush(); await e.U.flush(); e.m.renderDocumentsPageItems(); }
    function rows() { return Array.prototype.slice.call(document.querySelectorAll('#documents-items > .sdoc-file-item')); }

    test('All view: workspace row directly followed by its 2 PR folders, no heading', async function() {
        var e = await load();
        try {
            e.m.sdocSrcState.sel = 'all';
            await render(e);
            var r = rows(), i = r.findIndex(function(x) { return x.classList.contains('sdoc-ws-folder'); });
            assert.ok(i >= 0, 'workspace folder row in All view without a query');
            assert.ok(r[i].classList.contains('is-folder'));
            assert.ok(r[i + 1].classList.contains('sdoc-pr-folder') && r[i + 1].getAttribute('data-path') === '#pr/12', 'PR #12 right after');
            assert.ok(r[i + 2].classList.contains('sdoc-pr-folder') && r[i + 2].getAttribute('data-path') === '#pr/9', 'PR #9 next');
            var items = document.getElementById('documents-items');
            assert.ok(items.innerHTML.indexOf('Pull requests') === -1 && !items.querySelector('.sdoc-pr-folders-head'), 'no heading');
            // Local folder rows carry type + folder classes.
            assert.ok(items.querySelector('.sdoc-file-item.is-folder .sdoc-file-icon.sdoc-ft-folder'), 'folder row');
            assert.ok(items.querySelector('.sdoc-file-icon.sdoc-ft-code') && items.querySelector('.sdoc-file-icon.sdoc-ft-pdf'), 'file kinds');
            assert.ok(items.querySelector('.sdoc-lib-stat.sdoc-file-mtime'), 'mtime is its own stat');
        } finally { await e.U.cleanupAll(); }
    }, { tags: ['unit'], timeout: 8000 });

    test('rail + narrow select list PR entries after their workspace; pr: routes to #pr/<n>', async function() {
        var e = await load();
        try {
            e.m.sdocSrcState.sel = 'all';
            await render(e);
            var vals = Array.prototype.map.call(document.querySelectorAll('.sdoc-rail-select option'), function(o) { return o.value; });
            var w = vals.indexOf('ws:o/r::main');
            assert.ok(w >= 0);
            assert.deepStrictEqual(vals.slice(w + 1, w + 3), ['pr:o/r::main#12', 'pr:o/r::main#9'], 'select options follow the workspace');
            assert.ok(/\u21B3/.test(document.querySelector('.sdoc-rail-select option[value="pr:o/r::main#12"]').textContent), 'indented');
            var btns = Array.prototype.map.call(document.querySelectorAll('.sdoc-rail-groups .sdoc-rail-item'), function(b) { return b.getAttribute('data-src-id'); });
            var bw = btns.indexOf('ws:o/r::main');
            assert.deepStrictEqual(btns.slice(bw + 1, bw + 3), ['pr:o/r::main#12', 'pr:o/r::main#9'], 'rail entries follow the workspace');
            assert.ok(document.querySelector('.sdoc-rail-item.sdoc-rail-pr--open[data-src-id="pr:o/r::main#12"]'), 'state class');
            e.m.sdocSelectSource('pr:o/r::main#9');
            assert.strictEqual(e.m.sdocSrcState.sel, 'ws:o/r::main');
            assert.strictEqual(e.m.sdocSrcState.path, '#pr/9');
            assert.ok(document.querySelector('.sdoc-rail-item.active[data-src-id="pr:o/r::main#9"]'), 'PR rail entry is the active one');
            assert.strictEqual(document.querySelector('.sdoc-rail-select').value, 'pr:o/r::main#9');
            // Workspace root no longer nests the PR folders (no duplicates).
            e.m.sdocSelectSource('ws:o/r::main');
            assert.ok(!document.querySelector('#documents-items .sdoc-pr-folder'), 'not nested in the workspace root');
        } finally { await e.U.cleanupAll(); }
    }, { tags: ['unit'], timeout: 8000 });

    test('file rows carry sdoc-ft-<kind> in rows and gallery; folders is-folder', async function() {
        var e = await load();
        try {
            e.m.sdocSrcState.sel = 'lf:1';
            ['rows', 'gallery'].forEach(function() {});
            await render(e);
            var items = document.getElementById('documents-items');
            ['layout-rows', 'layout-gallery'].forEach(function(cls) {
                items.className = 'widget-library-items page-list ' + cls;
                assert.ok(items.querySelector('.sdoc-file-item.is-folder .sdoc-ft-folder'), cls + ' folder');
                assert.ok(items.querySelector('.sdoc-file-item:not(.is-folder) .sdoc-ft-code'), cls + ' code');
            });
            var html = e.m.buildDocumentsFileItem({ src: LF, entry: { name: 'x.yml', path: 'x.yml', kind: 'file', size: 1 } }, 0);
            assert.ok(/sdoc-ft-config/.test(html));
        } finally { await e.U.cleanupAll(); }
    }, { tags: ['unit'], timeout: 8000 });

    test('CSS: gallery icon override and --ft per major kind', async function() {
        var css = (await loadFile('src/css/21c-smart-documents.css')) + '\n' + (await loadFile('src/css/29-documents-page.css'));
        assert.match(css, /\.layout-gallery \.sdoc-lib-icon \{ display: none; \}/, '21c still hides doc icons');
        assert.match(css, /\.layout-gallery \.sdoc-file-item \.sdoc-lib-icon \{ display: flex; \}/, 'file/folder icons re-shown in gallery');
        ['code', 'data', 'config', 'text', 'archive', 'image', 'video', 'audio', 'pdf', 'file'].forEach(function(k) {
            assert.ok(new RegExp('\\.sdoc-file-icon\\.sdoc-ft-' + k + ' \\{ --ft: ').test(css), '--ft for ' + k);
        });
        assert.match(css, /\.sdoc-file-icon \{ --ft: [^;]+; background: color-mix\(in srgb, var\(--ft\) 14%, transparent\); color: var\(--ft\); \}/);
        assert.match(css, /\.sdoc-file-item \.sdoc-file-icon\.sdoc-ft-folder \{ --ft: var\(--sdoc-folder-color\)/, 'folder rule (0,3,0)');
        var narrow = css.slice(css.indexOf('@container (max-width: 559px)'));
        assert.match(narrow, /\.layout-rows \.sdoc-file-item \.sdoc-lib-actions \{ opacity: 1; \}/, 'actions visible in the side panel');
    }, { tags: ['unit'], timeout: 5000 });
});
