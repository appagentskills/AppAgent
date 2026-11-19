// await_handle / await_any / await_all must never wait forever by default:
// timeout_ms 0 / omitted maps to AWAIT_HANDLE_DEFAULT_TIMEOUT_MS (120s); an
// explicit positive value (even huge) is kept.
describe('await_* default timeout cap', function() {
    async function load() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var a = src.indexOf('var AWAIT_HANDLE_DEFAULT_TIMEOUT_MS');
        var b = src.indexOf('\n}\n', a) + 3;
        return { src: src, m: new Function(src.slice(a, b) + '\nreturn { cap: AWAIT_HANDLE_DEFAULT_TIMEOUT_MS, fn: awaitTimeoutMs };')() };
    }

    test('0 / omitted / invalid map to the 120s cap; explicit values are kept', async function() {
        var m = (await load()).m;
        assert.strictEqual(m.cap, 120000);
        [undefined, null, 0, '0', -5, 'abc', NaN, Infinity].forEach(function(v) {
            assert.strictEqual(m.fn(v), 120000, 'raw ' + String(v));
        });
        assert.strictEqual(m.fn(30), 30);
        assert.strictEqual(m.fn('2500'), 2500);
        assert.strictEqual(m.fn(24 * 3600 * 1000), 24 * 3600 * 1000, 'large explicit value stays possible');
    }, { tags: ['unit'], timeout: 2000 });

    test('all three await tools route timeout_ms through awaitTimeoutMs', async function() {
        var src = (await load()).src;
        ['timeoutMsAH', 'timeoutMsAY', 'timeoutMsAA'].forEach(function(v) {
            assert.ok(src.indexOf('var ' + v + ' = awaitTimeoutMs(args.timeout_ms);') !== -1, v);
        });
        assert.ok(!/timeout_ms != null\) \? Number\(args\.timeout_ms\) : 0;/.test(src), 'no 0 = forever default left');
    }, { tags: ['unit'], timeout: 2000 });

    test('a capped await on a never-settling handle returns pending', async function() {
        var m = await loadModules(['src/js/core/095-handle-registry.js'], { lenient: true });
        var H = m.Handles;
        var st = H.start('c1', 'test', {}, 'never', function() { return new Promise(function() {}); });
        var t0 = Date.now();
        var snap = await H.await('c1', st.handleId, 40);
        assert.strictEqual(snap.status, 'pending');
        assert.ok(Date.now() - t0 < 1500);
    }, { tags: ['unit'], timeout: 3000 });
});
