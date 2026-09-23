// H12 / M5 — executeCachedContentSearch (core/100-cached-results.js).
// Real source; only the config global + rehydration hook are stubbed.
describe('cached_content_search paging + (?i) (100-cached-results.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        M = await loadModules(['src/js/core/100-cached-results.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        M.__scope.cacheTokenLimit = 4000;
        M.__scope.ensureCachedContent = async function() {};
        return M;
    }
    function search(m, content, args) {
        m.__scope.chats = { c1: { cachedToolResults: { id1: { fullContent: content } } } };
        return m.executeCachedContentSearch('c1', Object.assign({ content_id: 'id1' }, args));
    }
    test('M5: leading (?i) is accepted and case-insensitive (old code: "Invalid regex pattern")', async function() {
        var m = await load();
        var r = await search(m, { a: 'say Hello\nnothing', b: 'HELLO there' }, { query: '(?i)hello' });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.totalMatches, 2);
        var plain = await search(m, { a: 'say Hello' }, { query: 'hello' });
        assert.strictEqual(plain.totalMatches, 0, 'without (?i) stays case-sensitive');
    });
    test('H12: a huge single-line string pages forward (old code: 0 matches, nextOffset === offset)', async function() {
        var m = await load();
        var big = 'x'.repeat(40000) + 'NEEDLE' + 'y'.repeat(40000);
        var content = { l1: big, l2: big, l3: big };
        var r = await search(m, content, { query: 'NEEDLE', max_matches: 20 });
        assert.strictEqual(r.success, true, r.error);
        assert.ok(r.returned >= 1, 'at least one match per page');
        assert.match(r.matches[0].context, /NEEDLE/);
        assert.ok(r.matches[0].context.length < 2000, 'context clipped: ' + r.matches[0].context.length);
        assert.match(r.matches[0].context, /chars\]/, 'truncation marker present');
        // Walk every page: offsets strictly advance and every match is reached.
        var seen = 0, offset = 0, pages = 0;
        while (pages++ < 10) {
            var p = await search(m, content, { query: 'NEEDLE', offset: offset, max_matches: 1 });
            seen += p.returned;
            if (!p.hasMore) break;
            assert.ok(p.nextOffset > offset, 'nextOffset advances');
            offset = p.nextOffset;
        }
        assert.strictEqual(seen, 3);
    });
    test('H12: an oversized entry alone still ships (neighbors clipped too)', async function() {
        var m = await load();
        var text = 'a'.repeat(30000) + '\n' + 'z'.repeat(100) + 'HIT' + '\n' + 'b'.repeat(30000);
        var r = await search(m, text, { query: 'HIT' });
        assert.strictEqual(r.returned, 1);
        assert.ok(JSON.stringify(r).length < 16000);
        assert.match(r.matches[0].context, /\[L2\] > z+HIT/);
    });
});
