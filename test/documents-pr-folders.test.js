// Documents page PR folders (tools/110-smart-documents.js): workspace PRs listed as
// read-only virtual folders, changed-file status mapping, GitHub files paging +
// cache, full-file diff from contents and the unified-patch fallback.
describe('documents PR folders', function() {
    async function load(gh) {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        return U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: {
            chats: {}, currentChatId: 'c1', currentView: 'documents',
            escDisplay: function(s) { return String(s); }, escapeHtml: function(s) { return String(s); },
            appStorage: { getItem: function() { return null; }, setItem: function() {} },
            githubApi: gh || function() { return Promise.resolve({ error: 'no stub' }); }
        } });
    }
    // Stub GitHub REST: routes by path, records every call.
    function ghStub(routes, calls) {
        return function(method, path) {
            calls.push(path);
            for (var k in routes) if (path.indexOf(k) === 0) {
                var v = typeof routes[k] === 'function' ? routes[k](path) : routes[k];
                return Promise.resolve(v && v.status ? v : { ok: true, status: 200, body: v });
            }
            return Promise.resolve({ ok: false, status: 404, body: { message: 'Not Found' } });
        };
    }

    test('PR folder entries: dedupe, open first then newest, capped at 10', async function() {
        var m = await load(), prs = [];
        for (var i = 1; i <= 14; i++) prs.push({ number: i, title: 'T' + i, state: i % 2 ? 'merged' : 'open', branch: 'b' + i });
        prs[0].merged_at = '2026-01-01'; prs.push({ number: 4, title: 'dup' }); prs.push({ number: 99, state: 'closed' }); prs.push(null, { title: 'no number' });
        var f = m.sdocWsPrFolders(prs);
        assert.strictEqual(f.length, 10, 'capped');
        assert.deepStrictEqual(f.map(function(p) { return p.number; }), [14, 12, 10, 8, 6, 4, 2, 99, 13, 11], 'open first, then newest');
        assert.strictEqual(f[5].title, 'T4', 'first copy wins on duplicates');
        assert.strictEqual(f[7].state, 'closed');
        assert.strictEqual(m.sdocWsPrFolders([{ number: 7, merged_at: 'x' }])[0].state, 'merged', 'merged_at means merged');
        assert.deepStrictEqual(m.sdocWsPrFolders(undefined), []);
        assert.strictEqual(m.sdocPrPathNumber('#pr/1133'), 1133);
        assert.strictEqual(m.sdocPrPathNumber('src/#pr/1'), 0);
        var html = m.sdocPrFoldersHtml({ id: 'ws:o/r::main', type: 'ws', label: 'o/r', prs: f.slice(0, 2) });
        assert.ok(html.indexOf('Pull requests') === -1 && /sdocSelectSource\('pr:o\/r::main#14'\)/.test(html), 'no heading; folder selects pr:<wk>#<n>');
        assert.ok(html.indexOf('sdoc-ws-pr--open') !== -1 && html.indexOf('PR #14') !== -1);
        assert.strictEqual(m.sdocPrFoldersHtml({ prs: [] }), '');
    }, { tags: ['unit'], timeout: 5000 });

    test('changed-file status mapping, entries and read-only rows', async function() {
        var m = await load();
        var map = { added: 'A', modified: 'M', removed: 'D', renamed: 'R', copied: 'A', changed: 'M', weird: 'M' };
        Object.keys(map).forEach(function(s) { assert.strictEqual(m.sdocPrFileStatus(s).code, map[s], s); });
        assert.strictEqual(m.sdocPrFileStatus('removed').kind, 'deleted');
        assert.strictEqual(m.sdocPrFileStatus('added').kind, 'new');
        assert.strictEqual(m.sdocPrFileStatus('renamed').kind, 'renamed');
        var ents = m.sdocPrFileEntries([{ filename: 'src/b.js', status: 'removed' }, { filename: 'a.md', status: 'added' }, { filename: 'src/x/c.css', status: 'renamed', previous_filename: 'src/c.css' }, {}], 5);
        assert.deepStrictEqual(ents.map(function(e) { return e.path + ':' + e.prStatus + ':' + e.dir; }), ['a.md:A:', 'src/b.js:D:src', 'src/x/c.css:R:src/x']);
        assert.strictEqual(m.sdocSelKeyOf({ kind: 'file', row: { src: { id: 's' }, entry: ents[0] } }), '', 'not selectable');
        var row = m.buildDocumentsFileItem({ src: { id: 'ws:o/r::main', type: 'ws', label: 'o/r', branch: 'main' }, entry: ents[2] }, 3);
        assert.ok(/sdocOpenFileRow\(3\)/.test(row), 'opens the diff');
        assert.ok(!/sdocDownloadFileRow|sdocDeleteFileRow|sdoc-sel-check|sdocStartChatForFile/.test(row), 'no select / download / delete');
        assert.ok(row.indexOf('sdoc-ws-change--renamed') !== -1 && row.indexOf('>R</span>') !== -1, 'R badge');
        assert.ok(row.indexOf('renamed from src/c.css') !== -1);
    }, { tags: ['unit'], timeout: 5000 });

    test('files: paged + cached per head sha; full-file diff from contents', async function() {
        var calls = [], page = function(n, k) { var a = []; for (var i = 0; i < n; i++) a.push({ filename: 'f' + k + '_' + i + '.js', status: 'modified' }); return a; };
        var m = await load(ghStub({
            '/repos/o/r/pulls/7/files?per_page=100&page=1': page(100, 1), '/repos/o/r/pulls/7/files?per_page=100&page=2': page(3, 2),
            '/repos/o/r/pulls/7': { base: { sha: 'B' }, head: { sha: 'H' }, updated_at: 'u' },
            '/repos/o/r/contents/a.txt?ref=B': { encoding: 'base64', size: 4, content: btoa('one\ntwo') },
            '/repos/o/r/contents/a.txt?ref=H': { encoding: 'base64', size: 4, content: btoa('one\nTWO') }
        }, calls));
        var files = await m.sdocPrLoadFiles('o/r', 7);
        assert.strictEqual(files.length, 103);
        assert.strictEqual(files.truncated, false);
        var n = calls.length;
        await m.sdocPrLoadFiles('o/r', 7);
        assert.strictEqual(calls.length, n, 'second load is served from cache');
        var h = await m.sdocPrFileDiffHtml('o/r', 7, { filename: 'a.txt', status: 'modified', patch: '@@ -1 +1 @@' });
        assert.ok(h.indexOf('sdoc-diff-wrap') !== -1 && h.indexOf('data-pane="file"') !== -1, 'Diff / File viewer');
        assert.ok(/<ins[^>]*>.*TWO/.test(h) && /<del[^>]*>.*two/.test(h));
    }, { tags: ['unit'], timeout: 5000 });

    test('patch fallback: missing/binary contents and direct rendering', async function() {
        var calls = [];
        var m = await load(ghStub({
            '/repos/o/r/pulls/8': { base: { sha: 'B' }, head: { sha: 'H' } },
            '/repos/o/r/contents/big.txt?ref=H': { encoding: 'none', size: 5000000, content: '' }
        }, calls));
        var patch = '@@ -1,2 +1,2 @@\n ctx\n-old <b>\n+new\n\\ No newline at end of file';
        var h = await m.sdocPrFileDiffHtml('o/r', 8, { filename: 'big.txt', status: 'modified', patch: patch });
        assert.ok(h.indexOf('sdoc-pr-patch') !== -1, 'falls back to the patch');
        assert.ok(/<ins class="sdoc-diff-line sdoc-diff-add">.*new<\/ins>/.test(h), '+ line green');
        assert.ok(/<del class="sdoc-diff-line sdoc-diff-del"><span class="sdoc-diff-sign">-<\/span>old /.test(h), '- line red, sign split off');
        assert.ok(h.indexOf('sdoc-diff-hunk') !== -1 && h.indexOf('+1</span>') !== -1 && h.indexOf('-1</span>') !== -1, 'hunk + stats');
        var img = await m.sdocPrFileDiffHtml('o/r', 8, { filename: 'logo.png', status: 'added' });
        assert.ok(img.indexOf('No text diff available') !== -1 && !calls.some(function(c) { return c.indexOf('logo.png') !== -1; }), 'binary kinds skip contents');
        var add = await m.sdocPrFileDiffHtml('o/r', 8, { filename: 'new.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+x' });
        assert.ok(add.indexOf('sdoc-pr-patch') !== -1, 'head fetch 404 -> patch');
        var err = await m.sdocPrLoadFiles('o/r', 9).then(function() { return ''; }, function(e) { return e.message; });
        assert.strictEqual(err, 'Not Found', 'API error message surfaces');
    }, { tags: ['unit'], timeout: 5000 });
});
