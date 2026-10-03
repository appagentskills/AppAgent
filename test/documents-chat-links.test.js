// Documents page chat links (tools/110-smart-documents.js): provenance
// resolution per source, "Open chat" / "Start chat" row buttons, navigation +
// missing-chat snackbar, and the agent-facing reference text.
describe('documents chat links', function() {
    var CHATS, NAV, SNACK;
    async function load() {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        CHATS = { c_live: { id: 'c_live' } }; NAV = []; SNACK = [];
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: {
            chats: CHATS, currentChatId: 'c1', currentView: 'documents',
            openChatFromHistory: function(id) { NAV.push(id); }, showSnackbar: function(msg, kind) { SNACK.push([msg, kind]); },
            escDisplay: function(s) { return String(s); }, escapeHtml: function(s) { return String(s); },
            appStorage: { getItem: function() { return null; }, setItem: function() {} }
        } });
        m.__U = U;
        return m;
    }
    function parse(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }
    var wsSrc = { id: 'ws:o/r::main', type: 'ws', wk: 'o/r::main', label: 'o/r', branch: 'main' };
    var lfSrc = { id: 'lf:f1', type: 'local', folderId: 'f1', label: 'My Folder', access: 'readwrite', permission: 'granted' };

    test('doc provenance: latest chat-stamped version, else creator', async function() {
        var m = await load();
        assert.strictEqual(m.sdocDocSourceChatId({ ownerChatId: 'c0', versions: [{ chatId: 'c0' }, { chatId: 'c2' }] }), 'c2');
        assert.strictEqual(m.sdocDocSourceChatId({ ownerChatId: 'c0', versions: [{ chatId: 'c2' }, { author: 'user' }] }), 'c2', 'page edits skipped');
        assert.strictEqual(m.sdocDocSourceChatId({ ownerChatId: 'c0', versions: [{ author: 'agent' }] }), 'c0', 'legacy versions -> creator');
        assert.strictEqual(m.sdocDocSourceChatId({ versions: [] }), null);
        assert.strictEqual(m.sdocDocSourceChatId(null), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('file provenance: workspace stamp only', async function() {
        var m = await load();
        var ents = m._sdocWsEntries([{ path: 'a.js', dirty: true, last_modified_by_chat_id: 'c_live' }, { path: 'b.js' }, { path: 'd/x.js' }], '', false);
        var a = ents.filter(function(e) { return e.path === 'a.js'; })[0], b = ents.filter(function(e) { return e.path === 'b.js'; })[0];
        assert.strictEqual(m.sdocFileSourceChatId(wsSrc, a), 'c_live');
        assert.strictEqual(m.sdocFileSourceChatId(wsSrc, b), null, 'clean file has no stamp');
        assert.strictEqual(m.sdocFileSourceChatId(wsSrc, { kind: 'directory', path: 'd', chatId: 'x' }), null, 'folders have none');
        assert.strictEqual(m.sdocFileSourceChatId(lfSrc, { kind: 'file', path: 'a', chatId: 'x' }), null, 'connected folders keep no provenance');
        assert.strictEqual(m.sdocFileSourceChatId({ type: 'virtual' }, { kind: 'file', path: 'a' }), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('row buttons: Start chat always, Open chat only with provenance', async function() {
        var m = await load();
        m.sdocSrcState.rendered = [{ src: wsSrc, entry: { kind: 'file', name: 'a.js', path: 'a.js', chatId: 'c_live' } },
            { src: lfSrc, entry: { kind: 'directory', name: 'docs', path: 'docs' } }];
        var r0 = parse(m.buildDocumentsFileItem(m.sdocSrcState.rendered[0], 0)), r1 = parse(m.buildDocumentsFileItem(m.sdocSrcState.rendered[1], 1));
        var open = r0.querySelector('.sdoc-lib-actions .sdoc-open-chat-btn'), start = r0.querySelector('.sdoc-lib-actions .sdoc-start-chat-btn');
        assert.ok(open && start, 'ws file with stamp has both');
        assert.strictEqual(open.tagName, 'BUTTON'); assert.strictEqual(open.getAttribute('type'), 'button');
        assert.strictEqual(open.getAttribute('aria-label'), 'Open the chat that edited a.js');
        assert.strictEqual(start.getAttribute('aria-label'), 'Start a chat about a.js');
        assert.match(open.getAttribute('onclick'), /^event\.stopPropagation\(\); sdocOpenFileRowChat\(0\)/);
        assert.match(start.getAttribute('onclick'), /^event\.stopPropagation\(\); sdocStartChatForFile\(0\)/);
        assert.strictEqual(r1.querySelector('.sdoc-open-chat-btn'), null, 'folder: no provenance');
        assert.ok(r1.querySelector('.sdoc-start-chat-btn[aria-label="Start a chat about docs"]'), 'folder gets Start chat');
        var d1 = parse(m.buildDocumentsPageItem({ id: 'd1', title: 'Plan', currentVersion: 1, versions: [{ version: 1, author: 'agent', chatId: 'c_live' }], ownerChatId: 'c_live' }));
        assert.match(d1.querySelector('.sdoc-open-chat-btn').getAttribute('onclick'), /sdocOpenSourceChat\('c_live'\)/);
        assert.match(d1.querySelector('.sdoc-start-chat-btn').getAttribute('onclick'), /^event\.stopPropagation\(\); sdocStartChat\('d1'\)/);
        var d2 = parse(m.buildDocumentsPageItem({ id: 'd2', title: 'Old', currentVersion: 1, versions: [{ version: 1, author: 'user' }] }));
        assert.strictEqual(d2.querySelector('.sdoc-open-chat-btn'), null, 'doc without provenance');
        assert.ok(d2.querySelector('.sdoc-start-chat-btn'));
    }, { tags: ['unit'], timeout: 5000 });

    test('navigation and missing-chat snackbar', async function() {
        var m = await load();
        assert.strictEqual(m.sdocOpenSourceChat('c_live'), true);
        assert.deepStrictEqual(NAV, ['c_live']);
        assert.strictEqual(m.sdocOpenSourceChat('c_gone'), false);
        assert.deepStrictEqual(SNACK, [['That chat no longer exists', 'error']]);
        assert.strictEqual(NAV.length, 1, 'no navigation for a deleted chat');
        m.sdocSrcState.rendered = [{ src: wsSrc, entry: { kind: 'file', name: 'a.js', path: 'a.js', chatId: 'c_live' } }];
        assert.strictEqual(m.sdocOpenFileRowChat(0), true);
        assert.strictEqual(m.sdocOpenFileRowChat(5), false, 'stale index');
    }, { tags: ['unit'], timeout: 5000 });

    test('reference text for doc, folder and workspace file', async function() {
        var m = await load();
        assert.strictEqual(m.sdocDocRefText({ id: 'plan_1', title: 'My\n plan' }),
            'Context: smart document plan_1 ("My plan") \u2014 read it with the document tool (action "read", doc_id "plan_1").');
        assert.strictEqual(m.sdocFileRefText(wsSrc, { kind: 'file', path: 'src/a.js' }),
            'Context: workspace file src/a.js in workspace o/r::main \u2014 read it with the workspace tool (action "read", workspace "o/r::main", path "src/a.js").');
        assert.strictEqual(m.sdocFileRefText(lfSrc, { kind: 'directory', path: 'docs' }),
            'Context: folder docs in connected folder "My Folder" (folder id f1) \u2014 list it with local_folder (action "ls", folder "f1", path "docs").');
        assert.strictEqual(m.sdocFileRefText(lfSrc, { kind: 'file', path: 'n.txt' }),
            'Context: file n.txt in connected folder "My Folder" (folder id f1) \u2014 read it with local_folder (action "read", folder "f1", path "n.txt").');
    }, { tags: ['unit'], timeout: 5000 });
});
