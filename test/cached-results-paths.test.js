// #11 — cached_content_* path parsing (quoted dotted keys, indices, greedy
// fallback) and the cachedContentRead "range too large" hint.
describe('cached results paths + range hint (100-cached-results.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        var win = fakeWindow();
        M = await loadModules(['src/js/core/100-cached-results.js'], { lenient: true, globals: { window: win, chrome: fakeChrome() } });
        M.__scope.cacheTokenLimit = 4000; // config global (030-config.js) not loaded here
        M.__scope.ensureCachedContent = async function() {};
        return M;
    }
    function read(m, chatId, contentId, path, s, e) {
        return m.executeCachedContentRead(chatId, { content_id: contentId, path: path, start_line: s, end_line: e });
    }
    test('_cachePathParts: quoted brackets, indices, plain dots', async function() {
        var m = await load();
        assert.strictEqual(typeof m._cachePathParts, 'function');
        assert.deepStrictEqual(m._cachePathParts('result["server.js"].body'), ['result', 'server.js', 'body']);
        assert.deepStrictEqual(m._cachePathParts("a['k.ey'][0].c"), ['a', 'k.ey', '0', 'c']);
        assert.deepStrictEqual(m._cachePathParts('items[2].name'), ['items', '2', 'name']);
        assert.deepStrictEqual(m._cachePathParts('a.b.c'), ['a', 'b', 'c']);
        assert.deepStrictEqual(m._cachePathParts(''), []);
    });
    test('_cacheNavigate: greedy fallback joins dotted parts until a key exists; indices on arrays', async function() {
        var m = await load();
        var root = { result: { 'server.js': { body: 'B' }, list: [{ n: 1 }, { n: 2 }] } };
        assert.deepStrictEqual(m._cacheNavigate(root, ['result', 'server.js', 'body']), { found: true, value: 'B' });
        assert.deepStrictEqual(m._cacheNavigate(root, ['result', 'server', 'js', 'body']), { found: true, value: 'B' });
        assert.deepStrictEqual(m._cacheNavigate(root, ['result', 'list', '1', 'n']), { found: true, value: 2 });
        assert.strictEqual(m._cacheNavigate(root, ['result', 'nope']).found, false);
        assert.strictEqual(m._cacheNavigate(root, ['result', 'list', '1', 'n', 'deeper']).found, false);
    });
    test('cachedContentRead: quoted dotted key path resolves; unquoted dotted key falls back', async function() {
        var m = await load();
        m.__scope.chats = { c1: { cachedToolResults: { id1: { fullContent: { result: { 'server.js': 'hello' } } } } } };
        var r = await read(m, 'c1', 'id1', 'result["server.js"]');
        assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 300));
        assert.match(r.content, /hello/);
        var r2 = await read(m, 'c1', 'id1', 'result.server.js');
        assert.strictEqual(r2.success, true, JSON.stringify(r2).slice(0, 300));
    });
    test('cachedContentRead: range hint proposes an end_line that FITS (not the same rejected range); line_too_long flagged', async function() {
        var m = await load();
        var limit = m.getCacheCharLimit();
        var lines = [];
        for (var i = 0; i < 40; i++) lines.push(new Array(Math.floor(limit / 10)).join('x'));
        m.__scope.chats = { c1: { cachedToolResults: { id1: { fullContent: lines.join('\n') } } } };
        var r = await read(m, 'c1', 'id1', null, 1, 40);
        assert.strictEqual(r.success, false);
        assert.ok(r.suggested_end_line >= 1 && r.suggested_end_line < 40, 'suggested_end_line=' + r.suggested_end_line);
        assert.match(r.hint, new RegExp('end_line: ' + r.suggested_end_line));
        var ok = await read(m, 'c1', 'id1', null, 1, r.suggested_end_line);
        assert.strictEqual(ok.success, true, 'suggested range must fit: ' + JSON.stringify(ok).slice(0, 200));
        // one giant line
        m.__scope.chats = { c1: { cachedToolResults: { id1: { fullContent: 'a\n' + new Array(limit + 10).join('y') + '\nb' } } } };
        var big = await read(m, 'c1', 'id1', null, 2, 2);
        assert.strictEqual(big.success, false);
        assert.strictEqual(big.line_too_long, true);
    });
});
