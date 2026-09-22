// #5 normalizeToolArgs must not JSON-parse content-bearing string params.
describe('normalizeToolArgs (030-agent-loop.js)', function() {
    async function load() {
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof m.normalizeToolArgs, 'function');
        return m;
    }
    test('content that is a JSON document stays a string (was coerced to object → f.content.indexOf crash)', async function() {
        var m = await load();
        var a = m.normalizeToolArgs({ path: 'x.json', content: '{"a":1}', code: '[1,2]', html: '{"h":1}', pr_body: '{"b":2}', message: '[m]', text: '{"t":1}' });
        ['content', 'code', 'html', 'pr_body', 'message', 'text'].forEach(function(k) { assert.strictEqual(typeof a[k], 'string', k + ' must stay a string'); });
    });
    test('array-as-string repair still applies to structural params (edits, files)', async function() {
        var m = await load();
        var a = m.normalizeToolArgs({ edits: '[{"find":"a","replace":"b"}]', files: '["x.js"]', plain: 'hello' });
        assert.deepStrictEqual(a.edits, [{ find: 'a', replace: 'b' }]);
        assert.deepStrictEqual(a.files, ['x.js']);
        assert.strictEqual(a.plain, 'hello');
    });
    test('non-object args and non-string values pass through', async function() {
        var m = await load();
        assert.strictEqual(m.normalizeToolArgs(null), null);
        var a = m.normalizeToolArgs({ n: 3, o: { k: 1 } });
        assert.strictEqual(a.n, 3); assert.deepStrictEqual(a.o, { k: 1 });
    });
});
