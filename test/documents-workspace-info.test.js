// Documents page: workspace status info (same data as the chat header pill),
// per-file change marks and colored line diffs (tools/110-smart-documents.js).
describe('documents workspace info + diffs', function() {
    async function load(g) {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        // The pill's own merged-PR rule (040-tools-settings.js), reused rather than duplicated.
        var src = await loadFile('src/js/ui/040-tools-settings.js');
        var a = src.indexOf('function _wsPushedPrMerged('), b = src.indexOf('\nfunction _dirtyFileRow(');
        if (a < 0 || b < 0) throw new Error('_wsPushedPrMerged not found in 040-tools-settings.js');
        var merged = new Function(src.slice(a, b) + '\nreturn _wsPushedPrMerged;')();
        var esc = function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        var globals = Object.assign({
            chats: {}, currentChatId: 'c1', currentView: 'documents', _wsPushedPrMerged: merged,
            escDisplay: esc, escapeHtml: esc,
            appStorage: { getItem: function() { return null; }, setItem: function() {} }
        }, g || {});
        return U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: globals });
    }
    var PR = { number: 7, url: 'https://github.com/o/r/pull/7' };

    test('per-file change status mirrors the pill badges', async function() {
        var m = await load();
        assert.strictEqual(m.sdocWsFileChange(null), '');
        assert.strictEqual(m.sdocWsFileChange({ path: 'a', sha: 'x' }), '', 'clean');
        assert.strictEqual(m.sdocWsFileChange({ path: 'a', sha: 'x', dirty: true }), 'modified');
        assert.strictEqual(m.sdocWsFileChange({ path: 'a', dirty: true }), 'new', 'no sha = added');
        assert.strictEqual(m.sdocWsFileChange({ path: 'a', sha: 'x', dirty: true, deleted: true }), 'deleted');
        var b = m.sdocWsChangeBadgeHtml('deleted');
        assert.ok(/sdoc-ws-change--deleted/.test(b) && />deleted</.test(b), 'colored + text label: ' + b);
        assert.strictEqual(m.sdocWsChangeBadgeHtml(''), '');
    }, { tags: ['unit'], timeout: 5000 });

    test('info summary from workspace status', async function() {
        var m = await load();
        var meta = { repo: 'o/r::main', pinned: true };
        var files = [
            { path: 'a.js', sha: '1', dirty: true, pushed_pr: PR, changed_since_push: true },
            { path: 'b.js', dirty: true },
            { path: 'c.js', sha: '3', dirty: true, deleted: true },
            { path: 'd.js', sha: '4' },
            { path: 'dist/x.js', sha: '5', dirty: true }
        ];
        var info = m.sdocWsInfoSummary(meta, files, function(p) { return p.indexOf('dist/') === 0; });
        assert.strictEqual(info.branch, 'main');
        assert.strictEqual(info.changed, 3, 'ignored + clean rows excluded');
        assert.deepStrictEqual(info.counts, { 'new': 1, modified: 1, deleted: 1 });
        assert.strictEqual(info.pinned, true);
        assert.deepStrictEqual(info.pr, { number: 7, url: PR.url, state: 'open', changedSincePush: true });
        var merged = m.sdocWsInfoSummary({ repo: 'o/r::dev', prs: [{ number: 7, state: 'merged' }] }, [{ path: 'a', sha: '1', dirty: true, pushed_pr: PR }]);
        assert.strictEqual(merged.pr.state, 'merged', 'meta.prs merged marker');
        assert.strictEqual(merged.pr.changedSincePush, false);
        assert.strictEqual(merged.pinned, false);
        var clean = m.sdocWsInfoSummary({ repo: 'o/r::main' }, []);
        assert.strictEqual(clean.changed, 0); assert.strictEqual(clean.pr, null);
        var txt = m.sdocWsInfoText(info);
        assert.ok(/main/.test(txt) && /3 changed files/.test(txt) && /PR #7/.test(txt) && /changed since push/.test(txt) && /Pinned/.test(txt), txt);
        var full = m.sdocWsInfoHtml(info, false), compact = m.sdocWsInfoHtml(info, true);
        assert.ok(/<a class="[^"]*sdoc-ws-pr--changed"/.test(full), 'header PR is a link');
        assert.ok(!/<a /.test(compact), 'rail (inside a button) has no link');
        assert.ok(/sdoc-ws-pinned/.test(full) && /sdoc-ws-branch/.test(full));
        assert.ok(/clean/.test(m.sdocWsInfoHtml(clean, false)) && !/clean/.test(m.sdocWsInfoHtml(clean, true)));
    }, { tags: ['unit'], timeout: 5000 });

    test('line diff to colored segments', async function() {
        var m = await load();
        var segs = m.sdocLineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
        assert.deepStrictEqual(segs, [
            { type: 'eq', lines: ['a'] }, { type: 'del', lines: ['b'] }, { type: 'add', lines: ['B'] },
            { type: 'eq', lines: ['c', 'd'] }, { type: 'add', lines: ['e'] }
        ]);
        assert.deepStrictEqual(m.sdocDiffStats(segs), { added: 2, removed: 1 });
        assert.deepStrictEqual(m.sdocLineDiff('', 'x\ny'), [{ type: 'add', lines: ['x', 'y'] }], 'new file');
        assert.deepStrictEqual(m.sdocLineDiff('x', ''), [{ type: 'del', lines: ['x'] }], 'deleted file');
        assert.deepStrictEqual(m.sdocLineDiff('same', 'same'), [{ type: 'eq', lines: ['same'] }]);
        var html = m.sdocDiffHtml(m.sdocLineDiff('<a>', '<b>'));
        assert.ok(/<del class="sdoc-diff-line sdoc-diff-del"><span class="sdoc-diff-sign">-<\/span>&lt;a&gt;<\/del>/.test(html), html);
        assert.ok(/<ins class="sdoc-diff-line sdoc-diff-add"><span class="sdoc-diff-sign">\+<\/span>&lt;b&gt;<\/ins>/.test(html), html);
        var view = m.sdocWsDiffViewHtml('a', 'b');
        assert.ok(/data-view="diff" aria-pressed="true"/.test(view) && /data-view="file" aria-pressed="false"/.test(view));
        assert.ok(/data-pane="file" hidden/.test(view), 'file pane starts hidden');
        assert.strictEqual(m.sdocWsDiffViewHtml(null, 'b'), '', 'no base: no diff');
        assert.strictEqual(m.sdocWsDiffViewHtml('::binary::AA', 'x'), '', 'binary: no diff');
    }, { tags: ['unit'], timeout: 5000 });
});
