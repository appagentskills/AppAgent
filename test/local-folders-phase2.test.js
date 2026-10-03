// Connected folders phase 2: SW→panel fallback decision, gesture-safe
// `request` (picker opened synchronously inside the Submit hook), the
// prompt_user onSubmitSync wiring, and the Documents page folder cards
// on the rail (pane-head actions, rename, Agent Files upload path through
// lfWriteFileBytes, re-selecting keeps the selection).

function p2File(bytes) {
    return { size: bytes.length, type: '', lastModified: 1, arrayBuffer: async function() { return bytes.slice().buffer; } };
}
function p2Dir(name, opts) {
    opts = opts || {};
    var kids = {};
    return {
        kind: 'directory', name: name, _kids: kids,
        queryPermission: async function() { return opts.perm || 'granted'; },
        requestPermission: opts.requestPermission || async function() { return 'granted'; },
        getDirectoryHandle: async function(n, o) {
            if (!kids[n]) { if (!(o && o.create)) { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; } kids[n] = p2Dir(n, opts); }
            return kids[n];
        },
        getFileHandle: async function(n, o) {
            if (!kids[n]) {
                if (!(o && o.create)) { var e = new Error('nf'); e.name = 'NotFoundError'; throw e; }
                var fh = { kind: 'file', name: n, _bytes: new Uint8Array(0) };
                fh.getFile = async function() { return p2File(fh._bytes); };
                if (!opts.noWritable) fh.createWritable = async function() { var buf; return { write: async function(b) { buf = new Uint8Array(b); }, close: async function() { fh._bytes = buf; } }; };
                kids[n] = fh;
            }
            return kids[n];
        },
        removeEntry: async function(n) { delete kids[n]; },
        values: async function*() { for (var k in kids) yield kids[k]; }
    };
}
function p2Err(name, msg) { var e = new Error(msg || name); e.name = name; return e; }

describe('local folders phase 2', function() {
    var m, opfs, row, store;
    function deps(extra) {
        var n = 0;
        return Object.assign({
            getOpfsRoot: async function() { return opfs; },
            readRow: async function() { return row; },
            writeRow: async function(l) { row = l; },
            newFileId: function() { return 'file_p' + (++n); },
            registerFile: function(id, p) { store[id] = p; },
            getFileAsync: async function(id) { var p = store[id]; return p ? { id: id, name: p.name, mime: p.mime, data: p.data } : null; }
        }, extra || {});
    }
    beforeEach(async function() {
        m = await runFile('src/js/tools/170-local-folders.js');
        opfs = p2Dir('');
        row = [];
        store = {};
        m.lfSetDeps(deps());
    });

    test('lfShouldRouteToPanel: only API-unavailable errors, only in the SW, only once', async function() {
        var sw = { inServiceWorker: true, action: 'write' };
        assert.strictEqual(m.lfShouldRouteToPanel(p2Err('SecurityError'), sw), true);
        assert.strictEqual(m.lfShouldRouteToPanel(p2Err('NotAllowedError'), sw), true);
        assert.strictEqual(m.lfShouldRouteToPanel(new TypeError('x'), sw), true);
        assert.strictEqual(m.lfShouldRouteToPanel(new Error('h.createWritable is not a function'), sw), true);
        var coded = new Error('no'); coded.code = 'NO_WRITE_API';
        assert.strictEqual(m.lfShouldRouteToPanel(coded, sw), true);
        ['READ_ONLY', 'NOT_FOUND', 'PATH_ESCAPE', 'PERMISSION_REQUIRED'].forEach(function(c) {
            var e = new Error(c); e.code = c;
            assert.strictEqual(m.lfShouldRouteToPanel(e, sw), false, c + ' is a real answer');
        });
        assert.strictEqual(m.lfShouldRouteToPanel(p2Err('SecurityError'), { inServiceWorker: false, action: 'write' }), false, 'page never reroutes');
        assert.strictEqual(m.lfShouldRouteToPanel(p2Err('SecurityError'), { inServiceWorker: true, action: 'write', alreadyRouted: true }), false, 'no loop');
        assert.strictEqual(m.lfShouldRouteToPanel(p2Err('SecurityError'), { inServiceWorker: true, action: 'list' }), false);
        assert.strictEqual(m.lfShouldRouteToPanel(null, sw), false);
    }, { tags: ['unit'] });

    test('SW: OPFS write without createWritable returns _route_to_panel; panel run returns a plain error', async function() {
        opfs = p2Dir('', { noWritable: true });
        m.lfSetDeps(deps({ inServiceWorker: true }));
        var r = await m.executeLocalFolder({ action: 'write', path: 'a.txt', content: 'x' });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r._route_to_panel, true, JSON.stringify(r));
        assert.strictEqual(r.code, 'NO_WRITE_API');
        var again = await m.executeLocalFolder({ action: 'write', path: 'a.txt', content: 'x', _lf_panel_fallback: true });
        assert.strictEqual(again._route_to_panel, undefined);
        assert.strictEqual(again.code, 'NO_WRITE_API');
        m.lfSetDeps(deps({ inServiceWorker: false }));
        var page = await m.executeLocalFolder({ action: 'write', path: 'a.txt', content: 'x' });
        assert.strictEqual(page._route_to_panel, undefined);
    }, { tags: ['unit'] });

    test('SW: local handle whose getFile throws SecurityError is routed; READ_ONLY is not', async function() {
        var local = p2Dir('pics');
        var fh = await local.getFileHandle('p.png', { create: true });
        fh.getFile = async function() { throw p2Err('SecurityError'); };
        row = [{ id: 'lf_a', label: 'Pics', access: 'read', handle: local, addedAt: 1 }];
        m.lfSetDeps(deps({ inServiceWorker: true }));
        var r = await m.executeLocalFolder({ action: 'read', folder: 'lf_a', path: 'p.png' });
        assert.strictEqual(r._route_to_panel, true, JSON.stringify(r));
        var w = await m.executeLocalFolder({ action: 'write', folder: 'lf_a', path: 'x.txt', content: 'no' });
        assert.strictEqual(w.code, 'READ_ONLY');
        assert.strictEqual(w._route_to_panel, undefined);
        var qp = p2Dir('q'); qp.queryPermission = async function() { throw p2Err('NotAllowedError'); };
        row.push({ id: 'lf_q', label: 'Q', access: 'read', handle: qp, addedAt: 2 });
        assert.strictEqual((await m.executeLocalFolder({ action: 'ls', folder: 'lf_q' }))._route_to_panel, true);
    }, { tags: ['unit'] });

    test('panel fallback read carries _file_pointer; lfAdoptPanelFallbackResult re-registers the same file_id', async function() {
        await m.executeLocalFolder({ action: 'write', path: 'i.png', base64: 'data:image/png;base64,iVBORw0KGgo=' });
        var r = await m.executeLocalFolder({ action: 'read', path: 'i.png', _lf_panel_fallback: true });
        // Unified store: the panel persists a Blob copy to the IndexedDB `files`
        // store shared with the SW, so no _file_pointer hand-off is needed.
        assert.ok(r.file_id && r._file_pointer === undefined);
        r._file_pointer = { type: 'memory', data: 'data:image/png;base64,AA==', name: 'x.png', mime: 'image/png' }; // legacy hand-off still adopted
        var swStore = {};
        m.lfSetDeps(deps({ registerFile: function(id, p) { swStore[id] = p; } }));
        var adopted = m.lfAdoptPanelFallbackResult(r);
        assert.strictEqual(adopted._file_pointer, undefined);
        assert.strictEqual(adopted.ran_in, 'panel');
        assert.strictEqual(swStore[r.file_id].mime, 'image/png');
        var plain = await m.executeLocalFolder({ action: 'read', path: 'i.png' });
        assert.strictEqual(plain._file_pointer, undefined);
    }, { tags: ['unit'] });

    test('request: picker opens synchronously inside the Submit hook (before any await)', async function() {
        var pickerCalled = false, calledDuringHook = null;
        m.lfSetDeps(deps({
            showDirectoryPicker: function(o) { pickerCalled = o.mode; return Promise.resolve(p2Dir('chosen')); },
            promptUser: async function(args, options) {
                assert.strictEqual(typeof options.onSubmitSync, 'function');
                pickerCalled = false;
                var g = options.onSubmitSync({ access: 'readwrite', label: 'Shots' });
                calledDuringHook = pickerCalled; // synchronous — no await in between
                return { success: true, values: { access: 'readwrite', label: 'Shots' }, gesture: g };
            }
        }));
        var r = await m.executeLocalFolder({ action: 'request', reason: 'need screenshots' }, { chatId: 'c' });
        assert.strictEqual(calledDuringHook, 'readwrite', 'picker called in the hook');
        assert.strictEqual(r.success, true, JSON.stringify(r));
        // No label field any more: the folder is named after its directory handle.
        assert.strictEqual(r.folder.label, 'chosen');
        assert.strictEqual(r.folder.access, 'readwrite');
        assert.strictEqual(row.length, 1);
    }, { tags: ['unit'] });

    test('request: picker failure points to the Documents page; re-grant runs requestPermission in the hook', async function() {
        m.lfSetDeps(deps({
            showDirectoryPicker: function() { return Promise.reject(p2Err('SecurityError', 'Must be handling a user gesture')); },
            promptUser: async function(a, o) { return { success: true, values: {}, gesture: o.onSubmitSync({}) }; }
        }));
        var r = await m.executeLocalFolder({ action: 'request' });
        assert.strictEqual(r.success, false);
        assert.ok(/Documents page/.test(r.error), r.error);
        var asked = 0, h = p2Dir('lapsed', { perm: 'prompt', requestPermission: function(o) { asked++; assert.strictEqual(o.mode, 'readwrite'); return Promise.resolve('granted'); } });
        row = [{ id: 'lf_l', label: 'Lapsed', access: 'readwrite', handle: h, addedAt: 1 }];
        var hookRan = false;
        m.lfSetDeps(deps({ promptUser: async function(a, o) { var g = o.onSubmitSync({}); hookRan = asked === 1; return { success: true, values: {}, gesture: g }; } }));
        var rg = await m.executeLocalFolder({ action: 'request', folder: 'lf_l' });
        assert.strictEqual(hookRan, true, 'requestPermission called synchronously in hook');
        assert.strictEqual(rg.success, true, JSON.stringify(rg));
        assert.strictEqual(rg.permission, 'granted');
    }, { tags: ['unit'] });

    test('prompt_user + routing + tools are wired for the hook and the fallback', async function() {
        var pu = await loadFile('src/js/tools/100-prompt-user.js');
        assert.ok(/promptSubmitHooks\[promptId\] = options\.onSubmitSync/.test(pu));
        assert.ok(/submitResult\.gesture = hook\(values\)/.test(pu));
        assert.ok(pu.indexOf('var hook = promptSubmitHooks[promptId]') < pu.indexOf('pendingPromptResolvers[promptId](submitResult)'), 'hook runs before resolve');
        var rt = await loadFile('src/js/worker/120-tool-routing.js');
        assert.ok(/_headlessResult\._route_to_panel/.test(rt));
        assert.ok(/_lf_panel_fallback: true/.test(rt));
        assert.ok(/lfAdoptPanelFallbackResult\(r\)/.test(rt));
        var tools = await loadFile('src/js/core/080-tools.js');
        assert.ok(/name === 'local_folder' && args && args\._lf_panel_fallback\) return false/.test(tools));
    }, { tags: ['unit'] });

    test('Documents page rail: folder actions in the pane head, Agent Files upload path, re-selecting keeps the selection (Settings section removed)', async function() {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var written = [], updates = [], snacks = [];
        var esc = function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
        var folders = [{ id: 'virtual', kind: 'virtual', label: 'Agent Files', name: 'agent-files', access: 'readwrite', permission: 'granted' },
            { id: 'lf_1', kind: 'local', label: 'Pics', name: 'pics', access: 'read', permission: 'prompt' },
            { id: 'lf_2', kind: 'local', label: 'Code', name: 'code', access: 'readwrite', permission: 'granted' }];
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: {
            chats: {}, currentChatId: 'c1', currentView: 'documents', LOCAL_FOLDER_VIRTUAL_ID: 'virtual',
            // Real escDisplay lives in 090-display-templates.js (not loaded here).
            escDisplay: esc, escapeHtml: esc,
            appStorage: { getItem: function() { return null; }, setItem: function() {} },
            showSnackbar: function(msg, kind) { snacks.push([kind, msg]); },
            listLocalFolders: async function() { return folders; },
            lfWriteFileBytes: async function(folder, path, bytes) { written.push([folder, path, bytes.length]); if (path === 'bad.bin') throw new Error('quota'); return { path: path }; },
            updateLocalFolder: async function(id, patch) { updates.push([id, patch]); },
            showPromptModal: async function(title, msg, def) { assert.strictEqual(def, 'Pics'); return '  Photos  '; },
            pickLocalFolder: function() { return Promise.resolve(null); }
        } });
        // Rail layout (same mount as test/documents-sources.test.js): rail + pane (title bar, then the items).
        await U.mountDom({ html: '<div id="documents-list" class="sdoc-rail-layout"><nav class="sdoc-rail" id="documents-sources"></nav>' +
            '<div class="sdoc-pane" id="sdoc-pane"><div class="sdoc-pane-head" id="sdoc-pane-head"></div><span id="documents-count"></span><div id="documents-items"></div></div></div>' });
        function item(id) { return document.querySelector('#documents-sources .sdoc-rail-item[data-src-id="' + id + '"]'); }
        function acts() { return Array.prototype.map.call(document.querySelectorAll('#sdoc-pane-head .sdoc-pane-acts [data-fk]'), function(b) { return b.getAttribute('data-fk'); }); }
        function paneBtn(fk) { return document.querySelector('#sdoc-pane-head .sdoc-pane-acts [data-fk="' + fk + '"]'); }
        function selected() {
            var out = {};
            Array.prototype.forEach.call(document.querySelectorAll('#documents-sources .sdoc-rail-item'), function(b) {
                var a = b.classList.contains('active'), c = b.getAttribute('aria-current');
                if (a || c) out[b.getAttribute('data-src-id')] = (a ? 'active' : '') + '|' + (c || '');
            });
            return out;
        }
        try {
            await m.sdocRefreshSources();
            assert.ok(m.sdocSrcById('lf:virtual') && m.sdocSrcById('lf:lf_1') && m.sdocSrcById('lf:lf_2'), 'sources loaded');
            m.sdocRenderSourcesStrip();
            assert.ok(item('lf:virtual') && item('lf:lf_1') && item('lf:lf_2'), 'one rail item per source');
            assert.strictEqual(item('lf:virtual').getAttribute('data-fk'), 'sel:lf:virtual');
            assert.ok(item('lf:virtual').classList.contains('sdoc-src-drop'), 'Agent Files rail item is a drop target');
            assert.deepStrictEqual(selected(), { all: 'active|true' });
            // Agent Files: Upload only (drop target pane); no access toggle / rename / disconnect.
            m.sdocSelectSource('lf:virtual');
            assert.strictEqual(m.sdocSrcState.sel, 'lf:virtual');
            assert.deepStrictEqual(selected(), { 'lf:virtual': 'active|true' }, 'selected item is .active + aria-current');
            assert.deepStrictEqual(acts(), ['upload:lf:virtual'], 'Agent Files pane: Upload only');
            assert.ok(/sdocAgentFilesPickUpload\(\)/.test(paneBtn('upload:lf:virtual').getAttribute('onclick')));
            assert.ok(document.getElementById('sdoc-pane').classList.contains('sdoc-src-drop'), 'Agent Files pane is a drop target');
            assert.strictEqual(document.querySelector('#sdoc-pane-head .sdoc-access-radio'), null, 'no access radio on Agent Files');
            assert.strictEqual(document.getElementById('sdoc-pane-head').innerHTML.indexOf('sdocSrcRename'), -1, 'Agent Files is not renamable');
            // Local folder, not granted: Re-grant, access toggle, Rename, Disconnect.
            m.sdocSelectSource('lf:lf_1');
            assert.deepStrictEqual(selected(), { 'lf:lf_1': 'active|true' });
            assert.deepStrictEqual(acts(), ['regrant:lf:lf_1', 'access:lf:lf_1', 'ren:lf:lf_1', 'disc:lf:lf_1']);
            assert.ok(/sdocSrcRegrant\('lf_1'\)/.test(paneBtn('regrant:lf:lf_1').getAttribute('onclick')));
            assert.ok(/sdocSrcSetAccess\('lf_1','readwrite'\)/.test(paneBtn('access:lf:lf_1').getAttribute('onclick')), 'read-only folder offers Allow writing');
            assert.ok(paneBtn('ren:lf:lf_1').getAttribute('onclick').indexOf("sdocSrcRename('lf_1')") !== -1);
            assert.ok(paneBtn('disc:lf:lf_1').getAttribute('onclick').indexOf("sdocSrcDisconnect('lf_1')") !== -1);
            assert.ok(!document.getElementById('sdoc-pane').classList.contains('sdoc-src-drop'), 'local folder pane is not the Agent Files drop target');
            // Granted local folder: no Re-grant; read-write offers Make read only.
            m.sdocSelectSource('lf:lf_2');
            assert.deepStrictEqual(acts(), ['upload:lf:lf_2', 'access:lf:lf_2', 'ren:lf:lf_2', 'disc:lf:lf_2'], 'no Re-grant when granted; read & write offers Upload');
            assert.ok(/sdocFolderPickUpload\('lf:lf_2'\)/.test(paneBtn('upload:lf:lf_2').getAttribute('onclick')));
            assert.ok(document.getElementById('sdoc-pane').classList.contains('sdoc-src-drop'), 'read & write folder pane is a drop target');
            assert.ok(item('lf:lf_2').classList.contains('sdoc-src-drop'), 'read & write folder rail item is a drop target');
            assert.ok(!item('lf:lf_1').classList.contains('sdoc-src-drop'), 'read-only folder is not a drop target');
            assert.ok(/sdocSrcSetAccess\('lf_2','read'\)/.test(paneBtn('access:lf:lf_2').getAttribute('onclick')));
            // Rename (through the real pane button) goes through updateLocalFolder with the trimmed label.
            m.sdocSelectSource('lf:lf_1');
            await U.fireInline(paneBtn('ren:lf:lf_1'), 'click', m).result;
            assert.deepStrictEqual(updates, [['lf_1', { label: 'Photos' }]]);
            // Upload path: same OPFS helper the agent uses.
            var res = await m.sdocUploadToAgentFiles([
                { name: 'a.png', arrayBuffer: async function() { return new Uint8Array([1, 2, 3]).buffer; } },
                { name: 'bad.bin', arrayBuffer: async function() { return new Uint8Array([1]).buffer; } }
            ]);
            assert.deepStrictEqual(written, [['virtual', 'a.png', 3], ['virtual', 'bad.bin', 1]]);
            assert.strictEqual(res.uploaded, 1);
            assert.strictEqual(res.failed.length, 1);
            assert.ok(snacks.some(function(s) { return s[0] === 'success'; }) && snacks.some(function(s) { return s[0] === 'error'; }));
            // Selecting the selected source again keeps it (no toggle-off: "All sources" is its own item).
            m.sdocSelectSource('lf:virtual');
            U.fireInline(item('lf:virtual'), 'click', m);
            assert.strictEqual(m.sdocSrcState.sel, 'lf:virtual', 'pressing the selected item again keeps the selection');
            assert.deepStrictEqual(selected(), { 'lf:virtual': 'active|true' });
            U.fireInline(item('all'), 'click', m);
            assert.strictEqual(m.sdocSrcState.sel, 'all');
            assert.deepStrictEqual(selected(), { all: 'active|true' });
        } finally { U.cleanupAll(); }
        // The Settings section is gone; its entry points now live on the Documents page.
        var st = await loadFile('src/js/ui/040-tools-settings.js');
        assert.ok(!/local-folders-settings-container/.test(st) && !/renderLocalFoldersSettings/.test(st));
        var sd = await loadFile('src/js/tools/110-smart-documents.js');
        assert.ok(!/sdocRenderPills|documents-pills|sdocToggleSourcesStrip|sdocOpenFolderSettings|_sdocSrcCardHtml|sdocToggleSource\(/.test(sd), 'pills / hide / settings link / cards removed');
    }, { tags: ['unit'] });
});
