// #15 — spawn arg `summary_cap_kb` → rec.summary_cap_bytes (clamped 1–16 KB,
// default SUBAGENT_DEFAULT_SUMMARY_KB = 4). Tests the clamp helper on the REAL
// registry module; the spawn wiring is a one-line call verified by grep.
describe('sub-agent summary_cap_kb clamp (097-sub-agent-registry.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof M._subSummaryCapBytes, 'function', '_subSummaryCapBytes helper must exist');
        return M;
    }
    test('default when omitted / non-numeric', async function() {
        var m = await load();
        assert.strictEqual(m._subSummaryCapBytes(undefined), 4 * 1024);
        assert.strictEqual(m._subSummaryCapBytes(null), 4 * 1024);
        assert.strictEqual(m._subSummaryCapBytes('abc'), 4 * 1024);
        assert.strictEqual(m._subSummaryCapBytes(NaN), 4 * 1024);
    });
    test('integer within range is honoured; strings coerced; fractions floored', async function() {
        var m = await load();
        assert.strictEqual(m._subSummaryCapBytes(8), 8 * 1024);
        assert.strictEqual(m._subSummaryCapBytes('12'), 12 * 1024);
        assert.strictEqual(m._subSummaryCapBytes(2.9), 2 * 1024);
    });
    test('clamped to [1, 16]', async function() {
        var m = await load();
        assert.strictEqual(m._subSummaryCapBytes(0), 1 * 1024);
        assert.strictEqual(m._subSummaryCapBytes(-5), 1 * 1024);
        assert.strictEqual(m._subSummaryCapBytes(64), 16 * 1024);
        assert.strictEqual(m._subSummaryCapBytes(Infinity), 4 * 1024, 'Infinity is not finite → default');
    });
    test('schema: spawn_sub_agent exposes summary_cap_kb (080-tools.js)', async function() {
        var src = await loadFile('src/js/core/080-tools.js');
        assert.ok(/summary_cap_kb:\s*\{\s*type:\s*'integer'/.test(src), 'summary_cap_kb integer property in spawn schema');
        var reg = await loadFile('src/js/core/097-sub-agent-registry.js');
        assert.ok(/summary_cap_bytes:\s*_subSummaryCapBytes\(args\.summary_cap_kb\)/.test(reg), 'spawn rec wires args.summary_cap_kb');
    });
});
