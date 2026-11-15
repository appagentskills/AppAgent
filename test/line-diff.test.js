// Shared line diff (src/js/core/152-line-diff.js lineDiffOps): linear-space Myers
// with a step budget + patience fallback. Used by ui/090 computeDiff,
// tools/020 _wsPrFileLineCounts (SW) and tools/110 _sdocLineDiffArr.
// Run: run_tests { files: ['test/line-diff.test.js'] }
describe('core/152 lineDiffOps', function() {
    var L = null;
    async function load() {
        if (!L) {
            var src = await loadFile('src/js/core/152-line-diff.js');
            L = new Function(src + '\nreturn { lineDiffOps: lineDiffOps, BUDGET: LINE_DIFF_STEP_BUDGET };')();
        }
        return L;
    }
    // Rebuilds a and b from the ops, checks same rows really match, and that no
    // remove directly follows an add (removes precede adds in every block).
    function verify(a, b, ops) {
        var ra = [], rb = [], same = 0;
        ops.forEach(function(op, i) {
            if (op.type !== 'add') ra.push(a[op.oldIndex]);
            if (op.type !== 'remove') rb.push(b[op.newIndex]);
            if (op.type === 'same') { same++; assert.strictEqual(a[op.oldIndex], b[op.newIndex], 'same row matches'); }
            if (i > 0 && op.type === 'remove') assert.notStrictEqual(ops[i - 1].type, 'add', 'remove after add at ' + i);
        });
        assert.deepStrictEqual(ra, a, 'ops reconstruct a');
        assert.deepStrictEqual(rb, b, 'ops reconstruct b');
        return same;
    }
    function sig(ops) { return ops.map(function(o) { return o.type[0]; }).join(''); }
    function lcs(a, b) {
        var n = a.length, m = b.length, T = [], i, j;
        for (i = 0; i <= n; i++) T.push(new Array(m + 1).fill(0));
        for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) T[i][j] = a[i] === b[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
        return T[0][0];
    }

    test('insert, delete, replace', async function() {
        var m = await load();
        var ins = m.lineDiffOps(['a', 'b'], ['a', 'x', 'b']);
        assert.strictEqual(sig(ins), 'sas'); assert.deepStrictEqual(ins[1], { type: 'add', oldIndex: null, newIndex: 1 });
        var del = m.lineDiffOps(['a', 'x', 'b'], ['a', 'b']);
        assert.strictEqual(sig(del), 'srs'); assert.deepStrictEqual(del[1], { type: 'remove', oldIndex: 1, newIndex: null });
        var rep = m.lineDiffOps(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd']);
        assert.strictEqual(sig(rep), 'srraas', 'removes grouped before adds');
        verify(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd'], rep);
    }, { tags: ['unit'] });

    test('moved block keeps the larger common part', async function() {
        var m = await load();
        var a = ['h', 'm1', 'm2', 'x1', 'x2', 'x3', 'x4', 't'], b = ['h', 'x1', 'x2', 'x3', 'x4', 'm1', 'm2', 't'];
        var ops = m.lineDiffOps(a, b);
        assert.strictEqual(verify(a, b, ops), lcs(a, b));
        assert.strictEqual(ops.filter(function(o) { return o.type !== 'same'; }).length, 4, 'only the 2-line block moves');
    }, { tags: ['unit'] });

    test('empty and identical inputs, trailing newline', async function() {
        var m = await load();
        assert.deepStrictEqual(m.lineDiffOps([], []), []);
        assert.deepStrictEqual(m.lineDiffOps(null, undefined), []);
        assert.strictEqual(sig(m.lineDiffOps([], ['a', 'b'])), 'aa');
        assert.strictEqual(sig(m.lineDiffOps(['a', 'b'], [])), 'rr');
        assert.strictEqual(sig(m.lineDiffOps(['a', 'b', 'c'], ['a', 'b', 'c'])), 'sss');
        var a = 'x\ny'.split('\n'), b = 'x\ny\n'.split('\n');
        var ops = m.lineDiffOps(a, b);
        assert.strictEqual(sig(ops), 'ssa'); verify(a, b, ops);
    }, { tags: ['unit'] });

    test('minimal on small random inputs (vs brute-force LCS)', async function() {
        var m = await load(), seed = 12345;
        function rnd(k) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; }
        function gen() { var n = rnd(14), out = []; for (var i = 0; i < n; i++) out.push('abcde'[rnd(5)]); return out; }
        for (var t = 0; t < 1500; t++) {
            var a = gen(), b = gen();
            assert.strictEqual(verify(a, b, m.lineDiffOps(a, b)), lcs(a, b), JSON.stringify([a, b]));
        }
    }, { tags: ['unit'] });

    test('budget exhausted -> patience fallback still yields a valid diff', async function() {
        var m = await load(), seed = 7;
        function rnd(k) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; }
        for (var t = 0; t < 300; t++) {
            var a = [], b = [], n = rnd(40), k = rnd(40), i;
            for (i = 0; i < n; i++) a.push('l' + rnd(15));
            for (i = 0; i < k; i++) b.push('l' + rnd(15));
            verify(a, b, m.lineDiffOps(a, b, { budget: 1 }));
        }
        // unique anchors are kept by the fallback
        var a2 = ['u1', 'p', 'u2', 'q', 'u3'], b2 = ['u1', 'r', 'u2', 's', 'u3'];
        assert.strictEqual(verify(a2, b2, m.lineDiffOps(a2, b2, { budget: 1 })), 3);
    }, { tags: ['unit'] });

    test('large inputs stay fast (scattered edits, full rewrite)', async function() {
        var m = await load(), a = [], b, i;
        for (i = 0; i < 20000; i++) a.push('line ' + i);
        b = a.slice(); for (i = 0; i < 20000; i += 50) b[i] = 'changed ' + i;
        var t0 = Date.now(), ops = m.lineDiffOps(a, b);
        assert.strictEqual(verify(a, b, ops), 19600, 'only the 400 edited lines differ');
        var x = [], y = []; for (i = 0; i < 6000; i++) { x.push('a' + i); y.push('b' + i); }
        var r = m.lineDiffOps(x, y);
        assert.strictEqual(sig(r), new Array(6001).join('r') + new Array(6001).join('a'), 'rewrite = delete + insert');
        assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + 'ms');
    }, { tags: ['unit'] });

    test('in both service-worker build lists; callers use it', async function() {
        var b1 = await loadFile('build/build.js'), b2 = await loadFile('skills/extension-dev/build.js');
        assert.ok(b1.indexOf("'js/core/150-record-helpers.js',") < b1.indexOf("'js/core/152-line-diff.js'") && b1.indexOf("'js/core/152-line-diff.js'") < b1.indexOf("'js/tools/110-smart-documents.js'"), 'build/build.js');
        assert.ok(b2.indexOf("'src/js/core/152-line-diff.js'") !== -1 && b2.indexOf("'src/js/core/152-line-diff.js'") < b2.indexOf("'src/js/tools/110-smart-documents.js'"), 'skills/extension-dev/build.js');
        assert.ok(/function computeDiff\([^)]*\) \{[\s\S]{0,400}lineDiffOps\(/.test(await loadFile('src/js/ui/090-version-history.js')), 'computeDiff');
        assert.ok(/function _wsPrFileLineCounts\([^)]*\) \{[\s\S]{0,400}lineDiffOps\(/.test(await loadFile('src/js/tools/020-tool-execution.js')), '_wsPrFileLineCounts');
        assert.ok(/function _sdocLineDiffArr\([^)]*\) \{[\s\S]{0,400}lineDiffOps\(/.test(await loadFile('src/js/tools/110-smart-documents.js')), '_sdocLineDiffArr');
    }, { tags: ['unit'] });

    test('PR diff CSS: horizontal scroll, sdoc code diff does not wrap', async function() {
        var ws = await loadFile('src/css/25-ws-files.css'), sd = await loadFile('src/css/29-documents-page.css');
        assert.ok(/\.wsf-pr-file-body \{[^}]*overflow-x: auto/.test(ws), '.wsf-pr-file-body scrolls');
        assert.ok(/\.wsf-pr-file-body \.diff-lines \{[^}]*minmax\(max-content, 1fr\)/.test(ws), 'rows span the scroll width');
        assert.ok(/pre\.sdoc-diff \{[^}]*overflow-x: auto/.test(sd) && /pre\.sdoc-diff \.sdoc-diff-line \{ white-space: pre; \}/.test(sd), 'sdoc pre diff');
    }, { tags: ['unit'] });
});
