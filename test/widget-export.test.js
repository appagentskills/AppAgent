// Widget "Export to HTML" pure helpers (src/js/tools/082-widget-export.js).
describe('widget export helpers (tools/082-widget-export.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/tools/082-widget-export.js'], { lenient: true, globals: {
            WIDGET_TOKENS_STATIC: '--space-2:4px;', WIDGET_TOKENS_LIGHT: '--primary:#293E6B;', WIDGET_TOKENS_DARK: '--primary:#6b8bc4;'
        } });
        return M;
    }

    it('extracts literal get_file / screenshot_by_id ids, dynamic calls and other tools', async function() {
        var m = await load();
        var src = '<script>executeTool("get_file", {id: "file_1_abc", thumbnail:{max:256}});' +
            "executeTool('screenshot_by_id',{ id:'ss_2_x' });" +
            'executeTool("get_file", {id: ids[i]});' +
            'executeTool(`get_file`, {id: `file_${n}`});' +
            'executeTool("servicenow_api", {method:"GET"});' +
            'executeTool("get_file", {id: "file_1_abc"});</script>';
        var r = m.widgetExportExtractAssetCalls(src);
        assert.deepStrictEqual(r.ids, [{ tool: 'get_file', id: 'file_1_abc' }, { tool: 'screenshot_by_id', id: 'ss_2_x' }]);
        assert.strictEqual(r.dynamic, 2);
        assert.deepStrictEqual(r.otherTools, ['servicenow_api']);
        assert.ok(r.candidateIds.indexOf('file_1_abc') !== -1);
        assert.ok(r.candidateIds.indexOf('ss_2_x') !== -1);
    });

    it('collects candidate id literals for dynamically-indexed arrays', async function() {
        var m = await load();
        var r = m.widgetExportExtractAssetCalls('var ids=["file_9_a","file_9_b"];ids.forEach(function(x){executeTool("get_file",{id:x})});');
        assert.strictEqual(r.ids.length, 0);
        assert.strictEqual(r.dynamic, 1);
        assert.deepStrictEqual(r.candidateIds, ['file_9_a', 'file_9_b']);
    });

    it('handles empty / non-string input', async function() {
        var m = await load();
        var r = m.widgetExportExtractAssetCalls(null);
        assert.deepStrictEqual(r, { ids: [], dynamic: 0, otherTools: [], candidateIds: [], localFolder: [], localDynamic: 0, localDynamicFolders: [], pathCandidates: [] });
    });

    it('extracts literal local_folder reads, counts computed ones, flags write actions', async function() {
        var m = await load();
        var src = 'executeTool("local_folder", {action:"read", folder:"Story", path:"story-characters/a.png", thumbnail:{max:256}});' +
            "executeTool('local_folder', { path: 'story-characters/a.png', folder: 'Story', action: 'read' });" +
            'executeTool("local_folder", {action:"read", folder:"Story", path: dir + "/" + name + ".png"});' +
            'executeTool("local_folder", {action:"ls", path:"story-characters"});' +
            'executeTool("local_folder", {action:"write", path:"x.txt", content:"hi"});';
        var r = m.widgetExportExtractAssetCalls(src);
        assert.deepStrictEqual(r.localFolder, [
            { action: 'read', folder: 'Story', path: 'story-characters/a.png' },
            { action: 'ls', path: 'story-characters' }
        ]);
        assert.strictEqual(r.localDynamic, 1);
        assert.deepStrictEqual(r.otherTools, ['local_folder']);
    });

    it('canonical call keys ignore argument key order and undefined members', async function() {
        var m = await load();
        var a = m.widgetExportCallKey('local_folder', { action: 'read', folder: 'Story', path: 'p.png', thumbnail: { max: 1, q: 2 } });
        var b = m.widgetExportCallKey('local_folder', { thumbnail: { q: 2, max: 1 }, path: 'p.png', extra: undefined, folder: 'Story', action: 'read' });
        assert.strictEqual(a, b);
        assert.notStrictEqual(a, m.widgetExportCallKey('local_folder', { action: 'read', folder: 'Story', path: 'q.png' }));
        assert.strictEqual(m.widgetExportLocalReadKey({ path: './a//b.png' }), 'virtual|a/b.png');
        // The shim's ES5 copies must agree with the page-side helpers.
        var win = {};
        (new Function('window', m.widgetExportBuildShim({}, {})))(win);
        [{ action: 'read', folder: 'S', path: 'p', n: [1, null, { z: 1, a: 'x"y' }], f: false }, {}, { b: undefined, a: 2.5 }].forEach(function(args) {
            assert.strictEqual(win.__appagentExportKey('local_folder', args), m.widgetExportCallKey('local_folder', args));
        });
        ['./a//b.png', '/x/y/', 'a\\b.png', ''].forEach(function(p) {
            assert.strictEqual(win.__appagentExportReadKey({ folder: 'Story', path: p }), m.widgetExportLocalReadKey({ folder: 'Story', path: p }));
        });
    });

    it('only read-only calls are recordable (no writes, no servicenow_api)', async function() {
        var m = await load();
        assert.ok(m.widgetExportIsRecordable('local_folder', { action: 'read' }));
        assert.ok(m.widgetExportIsRecordable('local_folder', { action: 'ls' }));
        assert.ok(m.widgetExportIsRecordable('local_folder', { action: 'list' }));
        assert.ok(m.widgetExportIsRecordable('get_file', { id: 'file_1' }));
        assert.ok(m.widgetExportIsRecordable('screenshot_by_id', { id: 'ss_1' }));
        ['write', 'delete', 'mkdir', 'request', 'grep'].forEach(function(act) {
            assert.ok(!m.widgetExportIsRecordable('local_folder', { action: act }), act);
        });
        assert.ok(!m.widgetExportIsRecordable('servicenow_api', { method: 'GET' }));
        var rec = m.widgetExportCreateRecorder(1e6);
        assert.strictEqual(rec.record('w1', 'local_folder', { action: 'write', path: 'x' }, { success: true }), false);
        assert.strictEqual(rec.record('w1', 'servicenow_api', { method: 'GET' }, { success: true }), false);
        assert.strictEqual(rec.record('w1', 'local_folder', { action: 'read', path: 'x' }, { success: false, error: 'nope' }), false);
        assert.strictEqual(rec.size(), 0);
    });

    it('recorder caps total bytes (LRU), touches on read, clears per widget', async function() {
        var m = await load();
        var rec = m.widgetExportCreateRecorder(3500); // ~1 KB entries: 3 fit
        var big = function(c) { return { success: true, data_url: 'data:image/png;base64,' + new Array(900).join(c) }; };
        assert.ok(rec.record('w1', 'local_folder', { action: 'read', path: 'a' }, big('a')));
        assert.ok(rec.record('w1', 'local_folder', { action: 'read', path: 'b' }, big('b')));
        rec.entries('w1', true); // a, b now most recently used (a first)
        assert.ok(rec.record('w2', 'local_folder', { action: 'read', path: 'c' }, big('c')));
        assert.ok(rec.record('w2', 'local_folder', { action: 'read', path: 'd' }, big('d')));
        assert.ok(rec.totalBytes() <= 3500);
        assert.strictEqual(rec.size(), 3);
        var w1 = Object.keys(rec.entries('w1'));
        assert.strictEqual(w1.length, 1, 'oldest-used entry evicted');
        assert.strictEqual(w1[0], m.widgetExportCallKey('local_folder', { action: 'read', path: 'b' }));
        assert.strictEqual(rec.record('w3', 'get_file', { id: 'f' }, { success: true, data: new Array(4000).join('x') }), false, 'single entry over cap is skipped');
        rec.clear('w2');
        assert.strictEqual(Object.keys(rec.entries('w2')).length, 0);
        assert.strictEqual(Object.keys(rec.entries('w1')).length, 1);
        rec.note('w1', true);
        assert.strictEqual(rec.activity('w1').inflight, 1);
        rec.note('w1', false);
        assert.strictEqual(rec.activity('w1').inflight, 0);
    });

    it('shim replays recorded calls by canonical key and matches local_folder reads ignoring encoding/thumbnail', async function() {
        var m = await load();
        var img = 'data:image/png;base64,' + new Array(2000).join('Q');
        var readArgs = { action: 'read', folder: 'Story', path: 'story-characters/hero.png', encoding: 'base64' };
        var lsArgs = { action: 'ls', folder: 'Story', path: 'story-characters' };
        var calls = {};
        calls[m.widgetExportCallKey('local_folder', readArgs)] = { name: 'local_folder', args: readArgs, result: { success: true, path: readArgs.path, data_url: img, file_id: 'file_7' } };
        calls[m.widgetExportCallKey('local_folder', lsArgs)] = { name: 'local_folder', args: lsArgs, result: { success: true, entries: [{ name: 'hero.png' }] } };
        var code = m.widgetExportBuildShim({ file_7: img }, calls);
        var win = {};
        (new Function('window', code))(win);
        var exact = await win.executeTool('local_folder', { encoding: 'base64', path: 'story-characters/hero.png', action: 'read', folder: 'Story' });
        assert.strictEqual(exact.data_url, img);
        var ls = await win.executeTool('local_folder', { path: 'story-characters', folder: 'Story', action: 'ls' });
        assert.strictEqual(ls.entries[0].name, 'hero.png');
        var plain = await win.executeTool('local_folder', { action: 'read', folder: 'Story', path: 'story-characters/hero.png' });
        assert.strictEqual(plain.data_url, img);
        var thumb = await win.executeTool('local_folder', { action: 'read', folder: 'Story', path: 'story-characters/hero.png', thumbnail: { max: 128 } });
        assert.strictEqual(thumb.thumbnail.data_url, img);
        var gf = await win.executeTool('get_file', { id: 'file_7' });
        assert.strictEqual(gf.data, img);
        var miss = null;
        try { await win.executeTool('local_folder', { action: 'read', folder: 'Story', path: 'other.png' }); } catch (e) { miss = e; }
        assert.ok(miss, 'unknown path rejects');
        var wr = null;
        try { await win.executeTool('local_folder', { action: 'write', folder: 'Story', path: 'story-characters/hero.png' }); } catch (e) { wr = e; }
        assert.ok(wr && /Not available in exported HTML/.test(wr.message), 'writes never replay');
        assert.strictEqual(code.split(new Array(2000).join('Q')).length - 1, 1, 'large string embedded once');
    });

    it('lists and rewrites CSS url() references, leaving data:/fragments/unmapped alone', async function() {
        var m = await load();
        var css = '.a{background:url("https://x/a.png")} .b{background:url(\'b.svg\')} .c{background:url(data:image/png;base64,AA)} .d{mask:url(#m)} .e{background:url( https://x/a.png )}';
        assert.deepStrictEqual(m.widgetExportCssUrls(css), ['https://x/a.png', 'b.svg']);
        var out = m.widgetExportRewriteCssUrls(css, { 'https://x/a.png': 'data:image/png;base64,ZZ' });
        assert.strictEqual(out.split('url("data:image/png;base64,ZZ")').length - 1, 2);
        assert.ok(out.indexOf("url('b.svg')") !== -1);
        assert.ok(out.indexOf('url(data:image/png;base64,AA)') !== -1);
        assert.ok(out.indexOf('url(#m)') !== -1);
    });

    it('shim answers get_file (incl. thumbnail) and screenshot_by_id, rejects the rest', async function() {
        var m = await load();
        var code = m.widgetExportBuildShim({ file_1: 'data:image/png;base64,QQ', ss_1: 'data:image/png;base64,</script>' });
        assert.ok(code.indexOf('</script>') === -1, 'must escape < so the data cannot close the script');
        var win = {};
        (new Function('window', code))(win);
        var r1 = await win.executeTool('get_file', { id: 'file_1', thumbnail: { max: 256 } });
        assert.strictEqual(r1.data, 'data:image/png;base64,QQ');
        assert.strictEqual(r1.thumbnail.data_url, 'data:image/png;base64,QQ');
        var r2 = await win.executeTool('screenshot_by_id', { id: 'ss_1' });
        assert.strictEqual(r2.base64, 'data:image/png;base64,</script>');
        var rejected = null;
        try { await win.executeTool('servicenow_api', {}); } catch (e) { rejected = e; }
        assert.ok(rejected && /Not available in exported HTML/.test(rejected.message));
        var missing = null;
        try { await win.executeTool('get_file', { id: 'file_unknown' }); } catch (e) { missing = e; }
        assert.ok(missing, 'unknown id rejects');
    });

    it('computed-path gallery reads: unopened tabs pre-resolve from path literals and chain get_file by file_id', async function() {
        var m = await load();
        var src = 'var SQ=[["Original","x","sq/original.png"],["Casual","y","sq/casual.jpg"]];var u="https://x/a.png";' +
            'executeTool("local_folder",{action:"read",folder:"lf_1",path:q[2]}).then(function(f){return executeTool("get_file",{id:f.file_id,thumbnail:{max:1400}});});';
        var r = m.widgetExportExtractAssetCalls(src);
        assert.strictEqual(r.localDynamic, 1);
        assert.deepStrictEqual(r.localDynamicFolders, ['lf_1']);
        assert.deepStrictEqual(r.pathCandidates, ['sq/original.png', 'sq/casual.jpg']);
        var lf = await loadModules(['src/js/tools/082-widget-export.js'], { lenient: true, globals: {
            executeLocalFolder: async function(a) {
                if (a.path !== 'sq/original.png') return { success: false, error: 'not found' };
                return { success: true, folder: a.folder, path: a.path, binary: true, file_id: 'file_9', data_url: 'data:image/png;base64,MARK' + 'Q'.repeat(2000) };
            }
        } });
        var replay = { calls: {}, embedded: 0, unresolved: 0 }, assets = {};
        await lf._wexStaticLocalFolder([{ action: 'read', folder: 'lf_1', path: 'sq/original.png' }, { action: 'read', folder: 'lf_1', path: 'sq/casual.jpg' }], replay, assets, true);
        assert.strictEqual(replay.unresolved, 0, 'optional candidates never count as unresolved');
        assert.strictEqual(Object.keys(replay.calls).length, 1);
        assert.ok(/^data:image\/png/.test(assets.file_9), 'file_id of a read is served to get_file');
        var code = lf.widgetExportBuildShim(assets, replay.calls);
        assert.strictEqual(code.split('MARK').length, 2, 'data URL embedded once');
        var win = {};
        (new Function('window', code))(win);
        var f = await win.executeTool('local_folder', { action: 'read', folder: 'lf_1', path: 'sq/original.png' });
        var t = await win.executeTool('get_file', { id: f.file_id, thumbnail: { max: 1400 } });
        assert.ok(/^data:image\/png/.test(t.thumbnail.data_url));
    });

    it('size warning only above 20 MB', async function() {
        var m = await load();
        assert.strictEqual(m.widgetExportSizeWarning(20 * 1024 * 1024), null);
        assert.strictEqual(m.widgetExportSizeWarning(1000), null);
        assert.ok(/21\.0 MB/.test(m.widgetExportSizeWarning(21 * 1024 * 1024)));
        assert.ok(m.widgetExportSizeWarning(2000, 1000));
    });

    it('slug, theme tokens and bridge detection', async function() {
        var m = await load();
        assert.strictEqual(m.widgetExportSlug('My Gallery: Q3!'), 'my-gallery-q3');
        assert.strictEqual(m.widgetExportSlug(''), 'widget');
        assert.ok(m.widgetExportTokenCss(true).indexOf('#6b8bc4') !== -1);
        assert.ok(m.widgetExportTokenCss(false).indexOf('#293E6B') !== -1);
        assert.ok(m.widgetExportIsBridgeScript('window._toolCallbacks={};'));
        assert.ok(!m.widgetExportIsBridgeScript('console.log(1)'));
    });
});
