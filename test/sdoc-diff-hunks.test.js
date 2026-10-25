// Smart Documents version diff is GitHub-style: only changed hunks with 3 lines of
// context, @@ headers, old/new line-number gutters and click-to-expand
// "N unchanged lines" folds (tools/110-smart-documents.js sdocDiffHunks /
// sdocRenderDiff / sdocDiffExpand). The `diff` display template's old_text/new_text
// mode (tools/090-display-templates.js generateDiff) reuses the same hunk model.
// Run: run_tests { files: ['test/sdoc-diff-hunks.test.js'] }
var WS = args.workspace;
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var SD_FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/250-message-render.js', 'src/js/tools/090-display-templates.js',
    'src/js/tools/110-smart-documents.js'];

function nums(n, from) { var a = []; for (var i = 0; i < n; i++) a.push('line ' + ((from || 1) + i)); return a; }
async function load() {
    var s = U.stubs();
    return U.loadUi(SD_FILES, { globals: { chats: {}, currentChatId: 'c1', activeStreamingChatId: null, showSnackbar: s.showSnackbar,
        saveChatsToStorage: s.saveChatsToStorage, appStorage: { getItem: function() { return null; }, setItem: function() {}, removeItem: function() {} } } });
}
async function mount(html) { return U.mountDom({ html: '<div class="sdoc"><div class="sdoc-diff">' + html + '</div></div>', css: ['src/css/00-tokens.css'] }); }
function texts(els) { return Array.prototype.map.call(els, function(e) { return e.textContent; }); }

describe('smart documents › GitHub-style version diff', function() {
    afterEach(function() { U.cleanupAll(); });

    test('one change in a 100-line doc: one hunk, 3 context lines each side, folds around', async function() {
        var m = await load(), a = nums(100), b = a.slice(); b[49] = 'CHANGED';
        var model = m.sdocDiffHunks(m.sdocComputeDiff(a, b), 3);
        assert.strictEqual(model.added, 1); assert.strictEqual(model.removed, 1);
        assert.strictEqual(model.hunks.length, 1);
        var h = model.hunks[0];
        assert.deepStrictEqual([h.oldStart, h.oldCount, h.newStart, h.newCount], [47, 7, 47, 7]);
        assert.strictEqual(h.end - h.start, 8, '3 ctx + del + add + 3 ctx');
        var dom = await mount(m.sdocRenderDiff(a, b, 'v1', 'v2'));
        var vis = Array.prototype.filter.call(dom.$$('.sdoc-diff-line'), function(l) { return !l.closest('.sdoc-diff-fold'); });
        assert.strictEqual(vis.length, 8, 'only the hunk is visible, not the 100-line document');
        assert.deepStrictEqual(texts(dom.$$('.sdoc-diff-hunk')), ['@@ -47,7 +47,7 @@']);
        assert.deepStrictEqual(texts(dom.$$('.sdoc-diff-expand')), ['\u22ef 46 unchanged lines', '\u22ef 47 unchanged lines']);
        assert.deepStrictEqual(texts(vis[0].querySelectorAll('.sdoc-diff-num')), ['47', '47'], 'old/new gutters');
        var del = dom.$('.sdoc-line-del'), add = dom.$('.sdoc-line-add');
        assert.deepStrictEqual(texts(del.querySelectorAll('.sdoc-diff-num')), ['50', '']);
        assert.deepStrictEqual(texts(add.querySelectorAll('.sdoc-diff-num')), ['', '50']);
        assert.strictEqual(dom.$('.sdoc-diff-stat-add').textContent, '+1'); assert.strictEqual(dom.$('.sdoc-diff-stat-del').textContent, '-1');
        dom.$$('.sdoc-diff-fold').forEach(function(f) { assert.strictEqual(f.hidden, true); });
    }, { tags: ['unit'] });

    test('expanding a fold reveals its unchanged lines and removes the gap row', async function() {
        var m = await load(), a = nums(30), b = a.slice(); b[0] = 'first';
        var dom = await mount(m.sdocRenderDiff(a, b, 'v1', 'v2'));
        var btn = dom.$('button.sdoc-diff-expand');
        assert.strictEqual(btn.textContent, '\u22ef 26 unchanged lines');
        U.fireInline(btn, 'click', m);
        assert.strictEqual(dom.$('.sdoc-diff-gap'), null);
        var fold = dom.$('.sdoc-diff-fold');
        assert.strictEqual(fold.hidden, false);
        assert.strictEqual(fold.querySelectorAll('.sdoc-diff-line').length, 26);
        assert.strictEqual(fold.querySelector('.sdoc-diff-text').textContent, 'line 5');
    }, { tags: ['unit'] });

    test('nearby changes merge into one hunk; far ones split', async function() {
        var m = await load(), a = nums(40), b = a.slice();
        b[5] = 'x'; b[12] = 'y';             // 6 unchanged rows between -> merged (<= 2*3)
        assert.strictEqual(m.sdocDiffHunks(m.sdocComputeDiff(a, b), 3).hunks.length, 1);
        b = a.slice(); b[5] = 'x'; b[13] = 'y'; // 7 between -> split with a 1-line fold
        var model = m.sdocDiffHunks(m.sdocComputeDiff(a, b), 3);
        assert.strictEqual(model.hunks.length, 2);
        assert.strictEqual(model.hunks[1].start - model.hunks[0].end, 1);
        var dom = await mount(m.sdocRenderDiff(a, b, 'v1', 'v2'));
        assert.ok(texts(dom.$$('.sdoc-diff-expand')).indexOf('\u22ef 1 unchanged line') >= 0);
    }, { tags: ['unit'] });

    test('identical, empty and whole-rewrite versions', async function() {
        var m = await load(), a = nums(50);
        var same = await mount(m.sdocRenderDiff(a, a.slice(), 'v1', 'v2'));
        assert.strictEqual(same.$$('.sdoc-diff-line').length, 0, 'identical docs render no lines');
        assert.strictEqual(same.$('.sdoc-diff-empty').textContent, 'No differences');
        U.cleanupAll();
        var empty = m.sdocDiffHunks(m.sdocComputeDiff([], ['a', 'b']), 3);
        assert.deepStrictEqual([empty.hunks.length, empty.added, empty.removed], [1, 2, 0]);
        assert.deepStrictEqual([empty.hunks[0].oldStart, empty.hunks[0].oldCount, empty.hunks[0].newStart, empty.hunks[0].newCount], [0, 0, 1, 2]);
        assert.strictEqual(m._sdocDiffSplit('').length, 0, 'an empty version has no lines');
        assert.deepStrictEqual(m.sdocDiffHunks(m.sdocComputeDiff([], []), 3).hunks, []);
        var rw = m.sdocDiffHunks(m.sdocComputeDiff(nums(5), nums(5, 100)), 3);
        assert.deepStrictEqual([rw.hunks.length, rw.added, rw.removed], [1, 5, 5]);
        assert.strictEqual(rw.rows.slice(0, 5).every(function(r) { return r.type === 'del'; }), true, 'deletions before additions');
    }, { tags: ['unit'] });

    test('large docs stay fast and collapse huge unchanged runs without putting them in the DOM', async function() {
        var m = await load(), a = nums(30000), b = a.slice(); b[15000] = 'mid';
        var t0 = Date.now(), html = m.sdocRenderDiff(a, b, 'v1', 'v2'), ms = Date.now() - t0;
        assert.ok(ms < 3000, 'rendered in ' + ms + 'ms');
        var dom = await mount(html);
        assert.strictEqual(dom.$$('.sdoc-diff-line').length, 8);
        assert.strictEqual(dom.$$('button.sdoc-diff-expand').length, 0, 'runs past SDOC_DIFF_FOLD_MAX are not expandable');
        assert.strictEqual(dom.$$('span.sdoc-diff-expand').length, 2);
        var big = m.sdocDiffHunks(m.sdocComputeDiff(nums(2500), nums(2500, 9000)), 3); // n*m > SDOC_DIFF_MAX_CELLS fallback
        assert.deepStrictEqual([big.added, big.removed, big.hunks.length], [2500, 2500, 1]);
    }, { tags: ['unit'] });

    test('diff display template old_text/new_text shows hunks only; explicit changes unchanged', async function() {
        var m = await load(), a = nums(40), b = a.slice(); b[20] = 'new 21';
        var dom = await mount(m.generateDiff({ old_text: a.join('\n'), new_text: b.join('\n') }));
        var vis = Array.prototype.filter.call(dom.$$('.display-diff-line'), function(l) { return !l.closest('.display-diff-fold'); });
        assert.strictEqual(vis.length, 8);
        assert.deepStrictEqual(texts(dom.$$('.display-diff-hunk')), ['@@ -18,7 +18,7 @@']);
        assert.strictEqual(dom.$('.display-diff-stat-add').textContent, '+1');
        U.fireInline(dom.$('button.display-diff-expand'), 'click', m);
        assert.strictEqual(dom.$('.display-diff-fold').hidden, false);
        U.cleanupAll();
        var d2 = await mount(m.generateDiff({ old_text: 'a\nb', new_text: 'a\nc\nd' }));
        assert.deepStrictEqual(texts(d2.$$('.display-diff-content')), ['  a', '- b', '+ c', '+ d']);
        U.cleanupAll();
        var d3 = await mount(m.generateDiff({ changes: ['same', '+added', '-removed'] }));
        assert.strictEqual(d3.$$('.display-diff-line').length, 3, 'explicit changes render as given');
        assert.strictEqual(d3.$('.display-diff-hunk'), null);
        U.cleanupAll();
        var d4 = await mount(m.generateDiff({ old_text: 'x\ny', new_text: 'x\ny' }));
        assert.strictEqual(d4.$('.display-diff-empty').textContent, 'No differences');
    }, { tags: ['unit'] });
});
