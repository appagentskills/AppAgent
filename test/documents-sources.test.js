// Documents page sources module (tools/110-smart-documents.js, design C sidebar rail):
// the rail (All + one button per source, .active + aria-current, persisted
// selection, Up/Down/Home/End), the narrow <select>, the pane head actions
// (access toggle with rollback on a refused permission, Agent Files upload,
// folder rename), the "Add source" popover (access radio, Esc / Cancel) and
// the "/" shortcut (ui/320 focus-input -> sdocFocusPageSearch). Everything runs
// through the real module functions and the real inline handlers
// (U.fireInline) on the real rendered markup; only the folder store
// (tools/170), appStorage, snackbars and prompt modals are stubbed.

describe('documents page sources', function() {
    var MODS = ['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/320-keyboard-shortcuts.js', 'src/js/tools/110-smart-documents.js'];
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

    // o: { prompt, regrant, updateFail(patch) -> Error|null, writeFail: name }
    async function load(o) {
        o = o || {};
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var rec = { updates: [], regrants: [], written: [], snacks: [], prompts: [], stored: [], picks: [] };
        var folders = [
            { id: 'virtual', kind: 'virtual', label: 'Agent Files', name: 'agent-files', access: 'readwrite', permission: 'granted' },
            { id: 'lf_1', kind: 'local', label: 'Pics', name: 'pics', access: 'read', permission: 'granted' },
            { id: 'lf_2', kind: 'local', label: 'Code', name: 'code', access: 'readwrite', permission: 'granted' }
        ];
        var m = await U.loadUi(MODS, { globals: {
            chats: {}, currentChatId: 'c1', currentView: 'documents', LOCAL_FOLDER_VIRTUAL_ID: 'virtual',
            escDisplay: esc, escapeHtml: esc,
            appStorage: { getItem: function() { return null; }, setItem: function(k, v) { rec.stored.push([k, v]); } },
            showSnackbar: function(msg, kind) { rec.snacks.push([kind, msg]); },
            listLocalFolders: async function() { return folders.map(function(f) { return Object.assign({}, f); }); },
            updateLocalFolder: async function(id, patch) {
                rec.updates.push([id, patch]);
                var err = o.updateFail && o.updateFail(patch);
                if (err) throw err;
                folders.forEach(function(f) { if (f.id === id) Object.assign(f, patch); });
            },
            regrantLocalFolder: async function(id) { rec.regrants.push(id); return o.regrant || 'granted'; },
            lfWriteFileBytes: async function(folder, path, bytes) {
                rec.written.push([folder, path, bytes.length]);
                if (path === o.writeFail) throw new Error('quota');
                return { path: path };
            },
            showPromptModal: async function(title, msg, def) { rec.prompts.push([title, msg, def]); return o.prompt; },
            pickLocalFolder: function(access) { rec.picks.push(access); return Promise.resolve(null); }
        }, allowUnstubbed: o.allowUnstubbed });
        // Rail layout: the sources rail + the pane (title bar with the selected source's actions, then the items).
        var mount = await U.mountDom({ html: '<div id="documents-list" class="sdoc-rail-layout"><nav class="sdoc-rail" id="documents-sources"></nav>' +
            '<div class="sdoc-pane" id="sdoc-pane"><div class="sdoc-pane-head" id="sdoc-pane-head"></div><span id="documents-count"></span><div id="documents-items"></div></div></div>' });
        await m.sdocRefreshSources();
        return { m: m, U: U, rec: rec, folders: folders, mount: mount };
    }
    function item(id) { return document.querySelector('#documents-sources .sdoc-rail-item[data-src-id="' + id + '"]'); }
    function items() { return Array.prototype.slice.call(document.querySelectorAll('#documents-sources .sdoc-rail-item')); }
    function railIds() { return items().map(function(b) { return b.getAttribute('data-src-id'); }); }
    // { id: 'active|current' } for the selected rail item(s) only.
    function selected() {
        var out = {};
        items().forEach(function(b) {
            var a = b.classList.contains('active'), c = b.getAttribute('aria-current');
            if (a || c) out[b.getAttribute('data-src-id')] = (a ? 'active' : '') + '|' + (c || '');
        });
        return out;
    }
    function railSelect() { return document.querySelector('#documents-sources select.sdoc-rail-select[data-fk="rail:select"]'); }
    function head(sel) { return document.querySelector('#sdoc-pane-head ' + sel); }
    function paneBtn(fk) { return head('.sdoc-pane-acts [data-fk="' + fk + '"]'); }
    function paneTitle() { var h = head('.sdoc-pane-title'); return h && h.textContent; }
    function addRadio() { return document.querySelector('#sdoc-add-pop .sdoc-access-radio[data-folder-id=""]'); }
    function checkedIn(group) { var o = group.querySelector('.radio-option[aria-checked="true"]'); return o && o.getAttribute('data-value'); }
    function lastStored(rec) { var s = rec.stored.filter(function(x) { return x[0] === 'documentsPageSource'; }); return s.length ? s[s.length - 1][1] : undefined; }
    async function settle(U) { await U.flush(); await U.flush(); }
    // The test frame is hidden (focus() does not move activeElement): spy on it.
    function spyFocus() {
        var orig = HTMLElement.prototype.focus, seen = [];
        HTMLElement.prototype.focus = function() { seen.push(this); };
        seen.restore = function() { HTMLElement.prototype.focus = orig; };
        return seen;
    }

    test('rail: All + every source; a press selects it (.active + aria-current, persisted, no toggle-off); the narrow select stays in sync', async function() {
        var e = await load(), m = e.m;
        try {
            assert.deepStrictEqual(railIds(), ['all', 'sdocs', 'lf:virtual', 'lf:lf_1', 'lf:lf_2'], 'All first, then Built-in, then Local folders');
            var groups = Array.prototype.map.call(document.querySelectorAll('#sdoc-rail-groups .sdoc-rail-group'), function(g) {
                var id = g.getAttribute('aria-labelledby');
                return [id, document.getElementById(id).textContent, Array.prototype.map.call(g.querySelectorAll('.sdoc-rail-item'), function(b) { return b.getAttribute('data-src-id'); })];
            });
            assert.deepStrictEqual(groups, [['sdoc-rail-g-builtin', 'Built-in', ['sdocs', 'lf:virtual']], ['sdoc-rail-g-local', 'Local folders', ['lf:lf_1', 'lf:lf_2']]], 'labelled groups; no empty GitHub group');
            assert.strictEqual(m.sdocSrcState.sel, 'all');
            assert.deepStrictEqual(selected(), { all: 'active|true' }, 'All selected');
            assert.strictEqual(item('lf:lf_1').querySelector('.sdoc-rail-name').textContent, 'Pics');
            assert.ok(item('lf:lf_1').querySelector('.sdoc-type-tile.t-local') && item('lf:virtual').querySelector('.sdoc-type-tile.t-files') && item('sdocs').querySelector('.sdoc-type-tile.t-sdocs'), 'type tiles');
            assert.strictEqual(item('lf:lf_1').getAttribute('data-fk'), 'sel:lf:lf_1');
            assert.ok(item('lf:virtual').classList.contains('sdoc-src-drop'), 'Agent Files item is a drop zone');
            assert.strictEqual(paneTitle(), 'All sources');
            var sel = railSelect();
            assert.deepStrictEqual(Array.prototype.map.call(sel.options, function(op) { return op.value; }), ['all', 'sdocs', 'lf:virtual', 'lf:lf_1', 'lf:lf_2']);
            assert.strictEqual(sel.value, 'all');

            e.U.fireInline(item('lf:lf_1'), 'click', m);
            assert.strictEqual(m.sdocSrcState.sel, 'lf:lf_1');
            assert.deepStrictEqual(selected(), { 'lf:lf_1': 'active|true' }, 'only the pressed item is active + aria-current');
            assert.strictEqual(lastStored(e.rec), 'lf:lf_1', 'selection persisted');
            assert.strictEqual(railSelect().value, 'lf:lf_1', 'select in sync');
            assert.strictEqual(paneTitle(), 'Pics');
            e.U.fireInline(item('lf:lf_1'), 'click', m);
            assert.strictEqual(m.sdocSrcState.sel, 'lf:lf_1', 'pressing the selected item again keeps it (no toggle-off)');
            assert.deepStrictEqual(selected(), { 'lf:lf_1': 'active|true' });
            e.U.fireInline(item('lf:virtual'), 'click', m);
            assert.deepStrictEqual(selected(), { 'lf:virtual': 'active|true' }, 'another item switches the selection');
            assert.ok(document.getElementById('sdoc-pane').classList.contains('sdoc-src-drop'), 'Agent Files pane is a drop zone');

            // Narrow layout: the select drives the same selection.
            sel = railSelect(); sel.value = 'sdocs';
            e.U.fireInline(sel, 'change', m);
            assert.strictEqual(m.sdocSrcState.sel, 'sdocs');
            assert.deepStrictEqual(selected(), { sdocs: 'active|true' });
            assert.strictEqual(lastStored(e.rec), 'sdocs');
            assert.strictEqual(railSelect().value, 'sdocs');
            assert.ok(!document.getElementById('sdoc-pane').classList.contains('sdoc-src-drop'));
            e.U.fireInline(item('all'), 'click', m);
            assert.strictEqual(m.sdocSrcState.sel, 'all');
            assert.strictEqual(railSelect().value, 'all', 'All item resets the select');
            assert.strictEqual(lastStored(e.rec), 'all');
        } finally { e.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('sdocRailKeydown: Up/Down wrap, Home/End; other keys, modifiers and non-item targets are ignored', async function() {
        var e = await load(), m = e.m, seen = spyFocus();
        try {
            var host = document.getElementById('sdoc-rail-groups');
            var btns = items();
            assert.strictEqual(btns.length, 5);
            var r = e.U.fireInline(host, 'keydown', m, { key: 'ArrowDown', target: btns[0] });
            assert.strictEqual(r.prevented, true);
            assert.strictEqual(seen[seen.length - 1], btns[1], 'Down -> next');
            e.U.fireInline(host, 'keydown', m, { key: 'ArrowUp', target: btns[0] });
            assert.strictEqual(seen[seen.length - 1], btns[4], 'Up from the first wraps to the last');
            e.U.fireInline(host, 'keydown', m, { key: 'ArrowDown', target: btns[4] });
            assert.strictEqual(seen[seen.length - 1], btns[0], 'Down from the last wraps to the first');
            e.U.fireInline(host, 'keydown', m, { key: 'ArrowUp', target: btns[3] });
            assert.strictEqual(seen[seen.length - 1], btns[2], 'Up -> previous (across groups)');
            e.U.fireInline(host, 'keydown', m, { key: 'End', target: btns[1] });
            assert.strictEqual(seen[seen.length - 1], btns[4], 'End');
            e.U.fireInline(host, 'keydown', m, { key: 'Home', target: btns[2] });
            assert.strictEqual(seen[seen.length - 1], btns[0], 'Home');
            var n = seen.length;
            assert.strictEqual(e.U.fireInline(host, 'keydown', m, { key: 'a', target: btns[0] }).prevented, false);
            assert.strictEqual(e.U.fireInline(host, 'keydown', m, { key: 'ArrowRight', target: btns[0] }).prevented, false, 'vertical list: Right is not handled');
            assert.strictEqual(e.U.fireInline(host, 'keydown', m, { key: 'ArrowDown', shiftKey: true, target: btns[0] }).prevented, false);
            assert.strictEqual(e.U.fireInline(host, 'keydown', m, { key: 'ArrowDown', target: host.querySelector('.sdoc-rail-label') }).prevented, false, 'group label is not an item');
            assert.strictEqual(seen.length, n, 'no focus moves for ignored keys');
            assert.strictEqual(m.sdocSrcState.sel, 'all', 'moving focus does not select');
        } finally { seen.restore(); e.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('pane head access button: a refused write permission rolls the stored access back to read', async function() {
        var e = await load({ regrant: 'denied' }), m = e.m;
        try {
            m.sdocSelectSource('lf:lf_1');
            var btn = paneBtn('access:lf:lf_1');
            assert.strictEqual(btn.textContent, 'Allow writing');
            assert.strictEqual(head('.sdoc-pane-badge').textContent, 'Read only');
            var info = e.U.fireInline(btn, 'click', m);
            assert.strictEqual(info.stopped, true);
            assert.deepStrictEqual(e.rec.updates, [['lf_1', { access: 'readwrite' }]], 'upgrade stored synchronously inside the gesture');
            await settle(e.U);
            assert.deepStrictEqual(e.rec.updates, [['lf_1', { access: 'readwrite' }], ['lf_1', { access: 'read' }]], 'upgrade then rollback');
            assert.deepStrictEqual(e.rec.regrants, ['lf_1'], 'the browser was asked for readwrite');
            assert.strictEqual(e.folders[1].access, 'read', 'stored access rolled back');
            assert.strictEqual(paneBtn('access:lf:lf_1').textContent, 'Allow writing', 'the re-rendered pane head shows the previous access');
            assert.strictEqual(head('.sdoc-pane-badge').textContent, 'Read only');
            assert.strictEqual(m.sdocSrcState.sel, 'lf:lf_1', 'selection kept');
            assert.ok(e.rec.snacks.some(function(s) { return s[0] === 'error' && /Write access was not granted \(denied\)/.test(s[1]); }), JSON.stringify(e.rec.snacks));
        } finally { e.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('pane head access button: upgrade when granted, downgrade never asks, failed update rolls back; popover access radio only remembers', async function() {
        var e = await load(), m = e.m, seen = spyFocus();
        try {
            m.sdocSelectSource('lf:lf_1');
            e.U.fireInline(paneBtn('access:lf:lf_1'), 'click', m);
            await settle(e.U);
            assert.deepStrictEqual(e.rec.updates, [['lf_1', { access: 'readwrite' }]], 'no rollback when granted');
            assert.strictEqual(paneBtn('access:lf:lf_1').textContent, 'Make read only');
            assert.strictEqual(head('.sdoc-pane-badge').textContent, 'Read & write');
            assert.ok(e.rec.snacks.some(function(s) { return s[0] === 'success' && /Pics is now read & write/.test(s[1]); }), JSON.stringify(e.rec.snacks));
            e.U.fireInline(paneBtn('access:lf:lf_1'), 'click', m);
            await settle(e.U);
            assert.deepStrictEqual(e.rec.updates[1], ['lf_1', { access: 'read' }]);
            assert.deepStrictEqual(e.rec.regrants, ['lf_1'], 'a downgrade never asks for permission');
            assert.strictEqual(paneBtn('access:lf:lf_1').textContent, 'Allow writing');

            // "Add source" popover (folder mode): the access radio is remembered, nothing is stored.
            m.sdocAddToggle();
            var group = addRadio();
            assert.ok(group, 'popover access radio');
            assert.strictEqual(checkedIn(group), 'read');
            var r = e.U.fireInline(group, 'keydown', m, { key: 'ArrowRight', target: group.querySelector('[data-value="read"]') });
            assert.strictEqual(r.prevented, true);
            assert.strictEqual(seen[seen.length - 1], group.querySelector('[data-value="readwrite"]'), 'focus follows the arrow');
            assert.strictEqual(m.sdocSrcState.addAccess, 'readwrite');
            assert.strictEqual(checkedIn(group), 'readwrite');
            assert.strictEqual(e.rec.updates.length, 2, 'nothing stored');
            m.sdocRenderSourcesStrip();
            assert.strictEqual(checkedIn(addRadio()), 'readwrite', 'remembered across re-renders');
            await e.U.fireInline(document.querySelector('#sdoc-add-pop [data-fk="connect"]'), 'click', m).result;
            assert.deepStrictEqual(e.rec.picks, ['readwrite'], 'Choose folder uses the remembered access');
            e.U.fireInline(addRadio().querySelector('[data-value="read"]'), 'click', m);
            assert.strictEqual(m.sdocSrcState.addAccess, 'read');
            assert.strictEqual(e.rec.updates.length, 2);
        } finally { seen.restore(); e.U.cleanupAll(); }

        var f = await load({ updateFail: function(p) { return p.access === 'read' ? new Error('locked') : null; } });
        try {
            f.m.sdocSelectSource('lf:lf_2');
            var b = paneBtn('access:lf:lf_2');
            assert.strictEqual(b.textContent, 'Make read only');
            f.U.fireInline(b, 'click', f.m);
            await settle(f.U);
            assert.deepStrictEqual(f.rec.updates, [['lf_2', { access: 'read' }], ['lf_2', { access: 'readwrite' }]], 'failed write: the previous access is re-stored');
            assert.strictEqual(paneBtn('access:lf:lf_2').textContent, 'Make read only', 're-render shows the stored value');
            assert.ok(f.rec.snacks.some(function(s) { return s[0] === 'error' && /Could not change access: locked/.test(s[1]); }), JSON.stringify(f.rec.snacks));
            assert.deepStrictEqual(f.rec.regrants, [], 'a downgrade never asks for permission');
        } finally { f.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('Add source popover: + toggles it, Esc closes (not when already handled), Cancel closes; focus returns to +', async function() {
        var e = await load(), m = e.m, seen = spyFocus();
        try {
            var add = document.querySelector('#documents-sources button.sdoc-rail-add[data-fk="add"]');
            assert.strictEqual(add.getAttribute('aria-expanded'), 'false');
            assert.strictEqual(add.getAttribute('aria-label'), 'Add source');
            assert.ok(!document.getElementById('sdoc-add-pop'));
            e.U.fireInline(add, 'click', m);
            var pop = document.getElementById('sdoc-add-pop');
            assert.ok(pop && pop.getAttribute('role') === 'dialog', 'popover open');
            assert.strictEqual(document.querySelector('.sdoc-rail-add').getAttribute('aria-expanded'), 'true');
            assert.ok(pop.contains(seen[seen.length - 1]), 'focus moves into the popover');
            // Not Escape: stays open.
            assert.strictEqual(e.U.fireInline(pop, 'keydown', m, { key: 'Enter', target: pop.querySelector('[data-fk="connect"]') }).prevented, false);
            assert.ok(document.getElementById('sdoc-add-pop'));
            // An Escape already consumed inside (e.g. the repo combobox closing its list) is skipped.
            var ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
            ev.preventDefault();
            m.sdocAddKeydown(ev);
            assert.ok(document.getElementById('sdoc-add-pop') && m.sdocSrcState.addOpen, 'defaultPrevented Escape ignored');
            var r = e.U.fireInline(document.getElementById('sdoc-add-pop'), 'keydown', m, { key: 'Escape' });
            assert.ok(r.prevented && r.stopped, 'Escape consumed');
            assert.ok(!document.getElementById('sdoc-add-pop') && !m.sdocSrcState.addOpen, 'Escape closes');
            assert.strictEqual(document.querySelector('.sdoc-rail-add').getAttribute('aria-expanded'), 'false');
            assert.strictEqual(seen[seen.length - 1], document.querySelector('.sdoc-rail-add'), 'focus back on +');

            e.U.fireInline(document.querySelector('.sdoc-rail-add'), 'click', m);
            var cancel = document.querySelector('#sdoc-add-pop [data-fk="add:cancel"]');
            assert.strictEqual(cancel.textContent, 'Cancel');
            e.U.fireInline(cancel, 'click', m);
            assert.ok(!document.getElementById('sdoc-add-pop'), 'Cancel closes');
            assert.strictEqual(seen[seen.length - 1], document.querySelector('.sdoc-rail-add'), 'focus back on +');
            e.U.fireInline(document.querySelector('.sdoc-rail-add'), 'click', m);
            assert.ok(document.getElementById('sdoc-add-pop'));
            e.U.fireInline(document.querySelector('.sdoc-rail-add'), 'click', m);
            assert.ok(!document.getElementById('sdoc-add-pop'), '+ toggles it shut');
            assert.strictEqual(m.sdocSrcState.sel, 'all', 'the popover never changes the selection');
        } finally { seen.restore(); e.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('Agent Files upload: pane head Upload button input, success count and the failure message', async function() {
        var e = await load({ writeFail: 'bad.bin' }), m = e.m;
        var inp = null;
        try {
            m.sdocSelectSource('lf:lf_1');
            assert.strictEqual(paneBtn('upload:lf:virtual'), null, 'Upload only for Agent Files');
            m.sdocSelectSource('lf:virtual');
            var up = paneBtn('upload:lf:virtual');
            assert.strictEqual(up.getAttribute('aria-label'), 'Upload files to Agent Files');
            var info = e.U.fireInline(up, 'click', m);
            assert.strictEqual(info.stopped, true);
            assert.strictEqual(m.sdocSrcState.sel, 'lf:virtual', 'selection kept');
            inp = document.getElementById('sdoc-upload-input');
            assert.ok(inp && inp.type === 'file' && inp.multiple && inp.hidden && inp.parentNode === document.body, 'hidden multi-file input on <body>');
            m.sdocSrcState.listings['lf:virtual#'] = { entries: [] };
            var dt = new DataTransfer();
            dt.items.add(new File(['abc'], 'a.txt'));
            dt.items.add(new File(['hello'], 'b.md'));
            inp.files = dt.files;
            inp.dispatchEvent(new Event('change'));
            for (var i = 0; i < 100 && !e.rec.snacks.length; i++) await e.U.flush(); // File.arrayBuffer is real async I/O
            assert.deepStrictEqual(e.rec.written, [['virtual', 'a.txt', 3], ['virtual', 'b.md', 5]]);
            assert.deepStrictEqual(e.rec.snacks, [['success', 'Uploaded 2 files to Agent Files']]);
            assert.strictEqual(inp.value, '', 'input reset so the same file can be picked again');
            assert.ok(paneBtn('upload:lf:virtual'), 'pane head re-rendered with Upload');

            e.rec.snacks.length = 0;
            var res = await m.sdocUploadToAgentFiles([new File(['x'], 'ok.png'), new File(['yy'], 'bad.bin')]);
            assert.strictEqual(res.uploaded, 1);
            assert.deepStrictEqual(res.failed, ['bad.bin (quota)']);
            assert.deepStrictEqual(e.rec.snacks, [['success', 'Uploaded 1 file to Agent Files'], ['error', 'Upload failed: bad.bin (quota)']]);
        } finally { if (inp) inp.remove(); e.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('folder rename: pane head Rename re-renders the rail item, cancel/unchanged are no-ops, failure shows Rename failed', async function() {
        var e = await load({ prompt: '  Photos  ' }), m = e.m;
        try {
            m.sdocSelectSource('lf:lf_1');
            var ren = paneBtn('ren:lf:lf_1');
            assert.strictEqual(ren.getAttribute('aria-label'), 'Rename Pics');
            var info = e.U.fireInline(ren, 'click', m);
            assert.strictEqual(info.stopped, true);
            await settle(e.U);
            assert.deepStrictEqual(e.rec.prompts, [['Rename folder', 'New label', 'Pics']]);
            assert.deepStrictEqual(e.rec.updates, [['lf_1', { label: 'Photos' }]], 'trimmed label stored');
            assert.strictEqual(item('lf:lf_1').querySelector('.sdoc-rail-name').textContent, 'Photos', 'rail item re-rendered with the new label');
            assert.strictEqual(paneTitle(), 'Photos', 'pane title too');
            assert.strictEqual(m.sdocSrcState.sel, 'lf:lf_1', 'selection kept');
            m.sdocSelectSource('lf:virtual');
            assert.strictEqual(head('[data-fk^="ren:"]'), null, 'Agent Files has no Rename');
        } finally { e.U.cleanupAll(); }

        var c = await load({ prompt: null });
        try {
            assert.strictEqual(await c.m.sdocSrcRename('lf_1'), null, 'cancel');
            assert.deepStrictEqual(c.rec.updates, []);
        } finally { c.U.cleanupAll(); }
        var s = await load({ prompt: ' Pics ' });
        try {
            assert.strictEqual(await s.m.sdocSrcRename('lf_1'), null, 'unchanged label');
            assert.deepStrictEqual(s.rec.updates, []);
        } finally { s.U.cleanupAll(); }

        var f = await load({ prompt: 'Photos', updateFail: function(p) { return p.label ? new Error('disk full') : null; } });
        try {
            await f.m.sdocSrcRename('lf_1');
            assert.deepStrictEqual(f.rec.updates, [['lf_1', { label: 'Photos' }]]);
            assert.deepStrictEqual(f.rec.snacks, [['error', 'Rename failed: disk full']]);
            assert.strictEqual(item('lf:lf_1').querySelector('.sdoc-rail-name').textContent, 'Pics', 'label unchanged after the failure');
        } finally { f.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('"/" focuses the Documents search, not while typing in an input; hidden search falls back to the composer', async function() {
        var e = await load(), m = e.m, seen = spyFocus();
        var onKey = function(ev) { m.kbdHandleKeydown(ev); };
        document.addEventListener('keydown', onKey);
        try {
            var mt = await e.U.mountDom({ html: '<div id="documents-panel"><input type="search" class="sdoc-page-search-input" value="abc"><input type="text" id="sdoc-t-other"></div><textarea id="message-input"></textarea>' });
            var search = mt.$('.sdoc-page-search-input'), other = mt.$('#sdoc-t-other'), composer = mt.$('#message-input');
            // The frame has no layout: make the fields "visible" to offsetParent checks.
            var searchVisible = true;
            Object.defineProperty(search, 'offsetParent', { get: function() { return searchVisible ? document.body : null; } });
            Object.defineProperty(composer, 'offsetParent', { get: function() { return document.body; } });

            var ev = e.U.key(document.body, '/');
            assert.strictEqual(ev.defaultPrevented, true, '"/" handled');
            assert.strictEqual(seen.length, 1, 'one focus call');
            assert.strictEqual(seen[0], search, 'search focused, composer untouched');

            ev = e.U.key(other, '/');
            assert.strictEqual(ev.defaultPrevented, false, 'typing "/" in an input is left alone');
            ev = e.U.key(search, '/');
            assert.strictEqual(ev.defaultPrevented, false, 'nor in the search field itself');
            assert.strictEqual(seen.length, 1, 'no focus change while typing');

            searchVisible = false;
            assert.strictEqual(m.sdocFocusPageSearch(), false, 'hidden search is not focused');
            e.U.key(document.body, '/');
            assert.strictEqual(seen[seen.length - 1], composer, 'falls back to the composer');
        } finally { document.removeEventListener('keydown', onKey); seen.restore(); e.U.cleanupAll(); }
    }, { tags: ['unit'] });

    test('Settings "Keyboard shortcuts" row: kbdDecorateTargets fills #settings-link-kbd-shortcuts in body.html', async function() {
        var e = await load(), m = e.m;
        try {
            var mt = await e.U.mountDom({ body: true });
            var row = mt.$('#settings-keyboard-shortcuts'), cap = mt.$('#settings-link-kbd-shortcuts');
            assert.ok(row && cap && row.contains(cap), 'the key-cap span lives inside the Settings row');
            assert.strictEqual(cap.innerHTML, '');
            m.kbdDecorateTargets();
            assert.ok(cap.querySelectorAll('kbd.kbd-cap').length >= 2, 'key-caps rendered: ' + cap.innerHTML);
            assert.ok(/\//.test(cap.textContent));
            assert.ok(/\//.test(row.getAttribute('aria-keyshortcuts')));
        } finally { e.U.cleanupAll(); }
    }, { tags: ['unit'] });
});
