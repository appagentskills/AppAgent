// Documents page bulk selection (tools/110-smart-documents.js): selection model,
// delete/download partitioning, store-only zip + crc32, keyboard guards.
describe('documents bulk selection', function() {
    async function load() {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        return U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: {
            chats: {}, currentChatId: 'c1', currentView: 'documents',
            escDisplay: function(s) { return String(s); }, escapeHtml: function(s) { return String(s); },
            appStorage: { getItem: function() { return null; }, setItem: function() {} }
        } });
    }
    var doc = { kind: 'doc', doc: { id: 'd1', title: 'A' } };
    function file(type, kind, access) { return { kind: 'file', row: { src: { id: 's-' + type, type: type, access: access }, entry: { kind: kind, path: 'p/' + kind } } }; }

    test('toggle, select all and tri-state', async function() {
        var m = await load(), s = new Set(), keys = ['a', 'b', 'c'];
        assert.strictEqual(m.sdocSelState(s, keys), 'none');
        assert.strictEqual(m.sdocSelToggle(s, 'a'), true);
        assert.strictEqual(m.sdocSelState(s, keys), 'some');
        assert.strictEqual(m.sdocSelToggleAll(s, keys), true, 'some -> select all');
        assert.strictEqual(m.sdocSelState(s, keys), 'all');
        assert.strictEqual(m.sdocSelToggleAll(s, keys), false, 'all -> clear');
        assert.strictEqual(s.size, 0);
        assert.strictEqual(m.sdocSelToggle(s, 'x'), true);
        assert.strictEqual(m.sdocSelToggle(s, 'x'), false);
        assert.strictEqual(m.sdocSelState(s, []), 'none', 'no visible keys');
        assert.strictEqual(m.sdocSelKeyOf(doc), 'doc:d1');
        assert.strictEqual(m.sdocSelKeyOf(file('lf', 'file')), 's-lf:p/file');
        assert.strictEqual(m.sdocSelKeyOf(file('lf', 'directory')), 's-lf:p/directory/', 'folders get a distinct key');
        assert.notStrictEqual(m.sdocSelKeyFolder('s', 'a'), m.sdocSelKeyFile('s', 'a'));
    }, { tags: ['unit'], timeout: 5000 });

    test('folders: nested dedupe, zip entries, row actions', async function() {
        var m = await load();
        function ent(kind, path, srcId) { return { kind: 'file', row: { src: { id: srcId || 's1', type: 'local', access: 'readwrite' }, entry: { kind: kind, path: path, name: path.split('/').pop() } } }; }
        var top = ent('directory', 'a'), inner = ent('file', 'a/b/c.txt'), sub = ent('directory', 'a/b'), sib = ent('file', 'ab.txt'), other = ent('file', 'a/x.txt', 's2');
        assert.deepStrictEqual(m.sdocSelDedupeNested([inner, top, sub, sib, other, doc]), [top, sib, other, doc], 'children of a selected folder fold into it');
        var p = m.sdocBulkPartition([top, inner], function() { return true; });
        assert.deepStrictEqual(p.deletable, [top]);
        var listing = [{ kind: 'file', path: 'a/b/x.txt', lastModified: 5 }, { kind: 'directory', path: 'a/b/c' }, { kind: 'file', path: 'a/b/c/y.md' }, { kind: 'file', path: 'a/bz.txt' }];
        assert.deepStrictEqual(m.sdocFolderZipEntries('a/b', listing, '').map(function(e) { return e.name; }), ['b/x.txt', 'b/c/y.md'], '<folder>.zip rooted at the folder');
        assert.deepStrictEqual(m.sdocFolderZipEntries('a/b', listing, 'Src').map(function(e) { return e.path + '>' + e.name; }), ['a/b/x.txt>Src/a/b/x.txt', 'a/b/c/y.md>Src/a/b/c/y.md'], 'bulk zip keeps full relative paths');
        var row = function(src) { return { src: src, entry: { kind: 'directory', name: 'b', path: 'a/b' } }; };
        var rw = m.buildDocumentsFileItem(row({ id: 'L', type: 'local', label: 'L', access: 'readwrite', permission: 'granted' }), 0);
        assert.ok(/sdocDownloadFileRow\(0\)/.test(rw) && /sdocDeleteFileRow\(0\)/.test(rw), 'writable folder: download + delete');
        assert.ok(rw.indexOf('data-sel-key="L:a/b/"') !== -1 && rw.indexOf('sdoc-sel-check') !== -1, 'folder row is selectable');
        assert.ok(rw.indexOf('sdoc-sel') < rw.indexOf('sdoc-lib-icon'), 'checkbox precedes the icon');
        var ro = m.buildDocumentsFileItem(row({ id: 'R', type: 'local', label: 'R', access: 'read', permission: 'granted' }), 1);
        assert.ok(/sdocDownloadFileRow\(1\)/.test(ro) && !/sdocDeleteFileRow/.test(ro), 'read-only folder: no delete');
    }, { tags: ['unit'], timeout: 5000 });

    test('delete and download partitions', async function() {
        var m = await load();
        var rw = file('lf', 'file', 'readwrite'), ro = file('lf', 'file', 'read'), ws = file('ws', 'file', 'readwrite'), dir = file('lf', 'directory', 'readwrite');
        var p = m.sdocBulkPartition([doc, rw, ro, ws, dir], function(src) { return src.access === 'readwrite'; });
        assert.deepStrictEqual(p.deletable, [doc, rw, dir]);
        assert.deepStrictEqual(p.skipped, [ro, ws]);
        var roDir = file('lf', 'directory', 'read'), wsDir = file('ws', 'directory', 'readwrite');
        assert.deepStrictEqual(m.sdocBulkPartition([roDir, wsDir], function(src) { return src.access === 'readwrite'; }).skipped, [roDir, wsDir], 'read-only / workspace folders skipped');
        assert.strictEqual(m.sdocBulkPartition([rw], null).deletable.length, 0, 'no writability check -> skip');
        var d = m.sdocDownloadPartition([doc, rw, ro, ws, dir]);
        assert.deepStrictEqual(d.items, [doc, rw, ro, dir]);
        assert.deepStrictEqual(d.skipped, [ws]);
        assert.strictEqual(m.sdocBulkResultText(3, 2, 0), 'Deleted 3 items \u00B7 2 read-only items skipped');
        assert.strictEqual(m.sdocBulkResultText(1, 0, 1), 'Deleted 1 item \u00B7 1 failed');
    }, { tags: ['unit'], timeout: 5000 });

    test('crc32 and store-only zip layout', async function() {
        var m = await load(), enc = new TextEncoder();
        assert.strictEqual(m.sdocCrc32(enc.encode('123456789')), 0xCBF43926, 'standard check value');
        assert.strictEqual(m.sdocCrc32(new Uint8Array(0)), 0);
        var data = enc.encode('hello'), z = m.sdocZipStore([{ name: 'a.txt', bytes: data, date: new Date(2026, 9, 1, 12, 30, 10).getTime() }]);
        var v = new DataView(z.buffer, z.byteOffset, z.byteLength);
        assert.strictEqual(v.getUint32(0, true), 0x04034b50, 'local header');
        assert.strictEqual(v.getUint16(8, true), 0, 'stored');
        assert.strictEqual(v.getUint32(14, true), m.sdocCrc32(data));
        assert.strictEqual(v.getUint32(18, true), 5); assert.strictEqual(v.getUint32(22, true), 5);
        assert.strictEqual(new TextDecoder().decode(z.subarray(30, 35)), 'a.txt');
        assert.strictEqual(new TextDecoder().decode(z.subarray(35, 40)), 'hello');
        assert.strictEqual(v.getUint32(40, true), 0x02014b50, 'central directory after data');
        var eo = z.length - 22;
        assert.strictEqual(v.getUint32(eo, true), 0x06054b50);
        assert.strictEqual(v.getUint16(eo + 10, true), 1);
        assert.strictEqual(v.getUint32(eo + 16, true), 40, 'cd offset');
        assert.strictEqual(v.getUint32(eo + 12, true), 46 + 5, 'cd size');
        assert.strictEqual(z.length, 40 + 51 + 22);
    }, { tags: ['unit'], timeout: 5000 });

    test('zip names are safe and unique', async function() {
        var m = await load(), used = {};
        assert.strictEqual(m.sdocZipName('a.md', used), 'a.md');
        assert.strictEqual(m.sdocZipName('A.md', used), 'A (2).md');
        assert.strictEqual(m.sdocZipName('../x\\..\\y/./z', used), 'x/y/z');
        assert.strictEqual(m.sdocZipName('', used), 'file');
        assert.strictEqual(m.sdocZipName('dir.v1/noext', used), 'dir.v1/noext');
        assert.strictEqual(m.sdocZipName('dir.v1/noext', used), 'dir.v1/noext (2)');
    }, { tags: ['unit'], timeout: 5000 });

    test('keyboard guards', async function() {
        var m = await load();
        var st = { view: 'documents', focusedKey: 'doc:a', visible: 2, size: 1 };
        ['toggle', 'all', 'delete', 'clear'].forEach(function(a) { assert.strictEqual(m.sdocKbdGuard(a, st), true, a); });
        ['toggle', 'all', 'delete', 'clear'].forEach(function(a) { assert.strictEqual(m.sdocKbdGuard(a, Object.assign({}, st, { view: 'chat' })), false, a + ' off-page'); });
        assert.strictEqual(m.sdocKbdGuard('delete', Object.assign({}, st, { overlay: true })), false, 'never under a dialog');
        assert.strictEqual(m.sdocKbdGuard('toggle', Object.assign({}, st, { focusedKey: null })), false);
        assert.strictEqual(m.sdocKbdGuard('all', Object.assign({}, st, { visible: 0 })), false);
        assert.strictEqual(m.sdocKbdGuard('clear', Object.assign({}, st, { size: 0 })), false);
        assert.strictEqual(m.sdocKbdGuard('bogus', st), false);
        assert.strictEqual(m.sdocKbdGuard('mode', { view: 'documents' }), true, '"s" works with nothing selected');
        assert.strictEqual(m.sdocKbdGuard('mode', { view: 'chat' }), false);
        assert.strictEqual(m.sdocKbdGuard('mode', { view: 'documents', overlay: true }), false);
        assert.strictEqual(m.sdocKbdGuard('clear', { view: 'documents', size: 0, mode: true }), true, 'Esc exits an empty selection mode');
        assert.strictEqual(m.sdocKbdGuard('clear', { view: 'documents', size: 0, mode: false }), false, 'Esc untouched outside selection mode');
    }, { tags: ['unit'], timeout: 5000 });

    test('selection mode transitions', async function() {
        var m = await load();
        assert.strictEqual(m.sdocSelModeAfter('mode', false), true);
        assert.strictEqual(m.sdocSelModeAfter('mode', true), false);
        assert.strictEqual(m.sdocSelModeAfter('toggle', false), true, 'x enters');
        assert.strictEqual(m.sdocSelModeAfter('all', false), true, 'Mod+A enters');
        assert.strictEqual(m.sdocSelModeAfter('all', true), true);
        assert.strictEqual(m.sdocSelModeAfter('clear', true), false);
        assert.strictEqual(m.sdocSelModeAfter('exit', true), false);
        assert.strictEqual(m.sdocSelModeAfter('bogus', true), true);
    }, { tags: ['unit'], timeout: 5000 });

    test('selection mode gates checkboxes, Select all and the bulk bar', async function() {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var m = await load();
        var mnt = await U.mountDom({ css: ['src/css/19b-widget-library.css', 'src/css/29-documents-page.css'], html:
            '<div id="documents-list"><div class="sdoc-page-toolbar"><div class="segmented-toggle widget-library-layout"><button data-layout="rows">R</button></div></div>' +
            '<div id="documents-items"><div class="sdoc-lib-item" data-sel-key="doc:a" tabindex="0"><span class="sdoc-sel"><input type="checkbox" class="sdoc-sel-check" data-sel-key="doc:a"></span>A</div>' +
            '<div class="sdoc-lib-item" data-sel-key="doc:b"><span class="sdoc-sel"><input type="checkbox" class="sdoc-sel-check" data-sel-key="doc:b"></span>B</div></div></div>' });
        try {
            m.sdocSelVisible.push('doc:a', 'doc:b');
            m.sdocSyncBulkUi();
            var btn = mnt.$('.sdoc-selmode-btn'), selAll = mnt.$('.sdoc-selall'), bulk = mnt.$('#sdoc-bulk-bar');
            assert.ok(btn && selAll && bulk, 'toggle, Select all and bar inserted');
            assert.strictEqual(btn.parentNode.nextElementSibling, mnt.$('.widget-library-layout'), 'toggle sits next to the layout toggle');
            assert.strictEqual(selAll.nextElementSibling, btn.parentNode, 'Select all before the toggle');
            assert.strictEqual(btn.getAttribute('aria-pressed'), 'false');
            assert.strictEqual(U.a11y(btn).hasName, true);
            assert.strictEqual(selAll.hidden, true, 'Select all hidden until selection starts');
            assert.strictEqual(bulk.hidden, true);
            assert.strictEqual(U.css(mnt.$('.sdoc-sel'), 'display'), 'none', 'checkboxes hidden');
            U.fireInline(btn, 'click', m);
            assert.strictEqual(btn.getAttribute('aria-pressed'), 'true');
            assert.ok(btn.classList.contains('active'));
            assert.ok(mnt.$('#documents-list').classList.contains('sdoc-selecting'));
            assert.strictEqual(selAll.hidden, false);
            assert.strictEqual(bulk.hidden, false, 'bar shown in mode');
            assert.notStrictEqual(U.css(mnt.$('.sdoc-sel'), 'display'), 'none', 'checkboxes shown');
            assert.strictEqual(mnt.$('[data-bulk="delete"]').disabled, true, 'nothing to delete yet');
            assert.ok(Array.from(mnt.$$('[data-bulk]')).filter(function(b) { return b.tabIndex === 0 && !b.disabled; }).length === 1, 'one live tab stop');
            m.sdocSelectAllVisible();
            assert.strictEqual(m.sdocSelection.size, 2);
            assert.strictEqual(mnt.$('[data-bulk="delete"]').disabled, false);
            assert.ok(mnt.$('[data-sel-key="doc:a"].sdoc-lib-item').classList.contains('is-selected'));
            m.sdocBulkBarClick({ target: mnt.$('[data-bulk="clear"]') });
            assert.strictEqual(m.sdocSelection.size, 0, 'Clear empties the selection');
            assert.strictEqual(btn.getAttribute('aria-pressed'), 'false', 'Clear exits selection mode');
            assert.strictEqual(selAll.hidden, true);
            assert.strictEqual(bulk.hidden, true);
            assert.ok(!mnt.$('#documents-list').classList.contains('sdoc-selecting'));
            m.sdocSelectAllVisible();
            assert.strictEqual(btn.getAttribute('aria-pressed'), 'true', 'Mod+A auto-enters');
            m.sdocToggleSelMode();
            assert.strictEqual(m.sdocSelection.size, 0, 'toggling off clears');
            assert.strictEqual(bulk.hidden, true);
            m.sdocToggleSelMode(); m.sdocSelClear();
            assert.strictEqual(btn.getAttribute('aria-pressed'), 'false', 'Esc path (sdocSelClear) exits');
        } finally { m.sdocSetSelMode(false); mnt.cleanup(); }
    }, { tags: ['unit'], timeout: 10000 });

    test('shortcuts never fire while typing', async function() {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var k = await U.loadUi(['src/js/ui/320-keyboard-shortcuts.js'], { globals: {} });
        var input = { tagName: 'INPUT', type: 'search' }, body = { tagName: 'BODY' };
        function ev(key, o) { return Object.assign({ key: key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, o || {}); }
        function id(e, target, mac) { var s = k.matchShortcut(e, !!mac, { target: target }); return s ? s.id : null; }
        assert.strictEqual(id(ev('s'), body), 'docs-sel-mode');
        assert.strictEqual(id(ev('s'), input), null, 's while typing stays a letter');
        assert.strictEqual(id(ev('S', { shiftKey: true }), body), null);
        assert.strictEqual(id(ev('x'), body), 'docs-sel-toggle');
        assert.strictEqual(id(ev('x'), input), null);
        assert.strictEqual(id(ev('a', { ctrlKey: true }), body), 'docs-sel-all');
        assert.strictEqual(id(ev('a', { ctrlKey: true }), input), null, 'Ctrl+A in a field keeps its text select-all');
        assert.strictEqual(id(ev('a', { metaKey: true }), body, true), 'docs-sel-all');
        assert.strictEqual(id(ev('Delete'), body), 'docs-sel-delete');
        assert.strictEqual(id(ev('Delete'), input), null);
        assert.strictEqual(id(ev('Backspace'), body, true), 'docs-sel-delete');
        assert.strictEqual(id(ev('Escape'), body), 'docs-sel-clear');
        assert.strictEqual(id(ev('Escape'), input), null);
        var keys = {};
        k.KBD_SHORTCUTS.filter(function(s) { return !s.info && !s.capture; }).forEach(function(s) {
            k.kbdKeysFor(s, false).forEach(function(c) { var n = c.toLowerCase(); assert.ok(!keys[n], 'clash on ' + c + ': ' + keys[n] + ' / ' + s.id); keys[n] = s.id; });
        });
    }, { tags: ['unit'], timeout: 5000 });

    test('Select button icon comes from UI_ICONS.selectMode', async function() {
        var m = await load();
        assert.ok(m.UI_ICONS && /^<svg class="ui-icon"/.test(m.UI_ICONS.selectMode || ''), 'UI_ICONS.selectMode is an ui-icon svg');
        var html = m._sdocSelModeBtnHtml();
        assert.ok(html.indexOf(m.UI_ICONS.selectMode) !== -1, 'button embeds the shared icon');
        assert.ok(/<span>Select<\/span>/.test(html));
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        assert.ok(src.indexOf('SDOC_SELECT_ICON') === -1, 'no inline select icon left in 110');
    }, { tags: ['unit'], timeout: 10000 });

    test('drop target: virtual -> Agent Files, read & write folder -> folder, else ignored', async function() {
        var m = await load(), f = m.sdocDropTarget;
        assert.strictEqual(f({ type: 'virtual' }), 'agent');
        assert.strictEqual(f({ type: 'local', access: 'readwrite' }), 'folder');
        assert.strictEqual(f({ type: 'local', access: 'read' }), null, 'read-only folder ignored');
        assert.strictEqual(f({ type: 'github' }), null, 'other source types ignored');
        assert.strictEqual(f({ type: 'local' }), null);
        assert.strictEqual(f(null), null, 'unknown source ignored (no Agent Files fallback)');
    }, { tags: ['unit'], timeout: 10000 });

    test('search empty-state hint mentions file names and paths in all locales', async function() {
        var NEW = 'Search looks at document titles and content, plus file names and paths.', OLD = 'Search looks at document titles and content.';
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        assert.strictEqual(src.split("t('" + NEW + "')").length - 1, 2, 'both empty states use the new hint');
        assert.ok(src.indexOf(OLD) === -1, 'old hint gone');
        var locs = ['ar', 'cs', 'da', 'de', 'es', 'fi', 'fr-CA', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'nb', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ru', 'sv', 'th', 'tr', 'zh-CN', 'zh-TW'];
        for (var i = 0; i < locs.length; i++) {
            var cat = JSON.parse(await loadFile('src/locales/' + locs[i] + '.json'));
            assert.ok(cat[NEW] && cat[NEW] !== NEW, locs[i] + ' translates the new hint');
            assert.ok(!(OLD in cat), locs[i] + ' dropped the old key');
        }
    }, { tags: ['unit'], timeout: 20000 });
});
