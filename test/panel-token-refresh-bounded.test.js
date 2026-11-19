// Panel (platform-bridge.js) _refreshToken / _openSnForLogin must settle even
// when the background never calls sendResponse (SW restarted mid-call).
describe('panel token refresh + login wait are bounded', function() {
    function slice(text, start, end) {
        var a = text.indexOf(start);
        if (a < 0) throw new Error('marker missing: ' + start);
        var b = text.indexOf(end, a + start.length);
        if (b < 0) throw new Error('marker missing: ' + end);
        return text.slice(a, b);
    }
    async function load(chrome, win, overrides) {
        var src = await loadFile('src/platform/extension/platform-bridge.js');
        var body = slice(src, 'var PB_REFRESH_TOKEN_TIMEOUT_MS', '    // Browser action proxy');
        Object.keys(overrides || {}).forEach(function(k) {
            body = body.replace(new RegExp('(' + k + ' = )\\d+'), '$1' + overrides[k]);
        });
        return new Function('chrome', 'window', body + '\nreturn { refresh: _refreshToken, login: _openSnForLogin };')(chrome, win);
    }
    function silentChrome(onMsg) {
        return { runtime: { lastError: null, sendMessage: function(m, cb) { if (onMsg) onMsg(m, cb); } } };
    }

    test('_refreshToken resolves null when sendResponse never comes', async function() {
        var m = await load(silentChrome(), { sessionToken: 'old' }, { PB_REFRESH_TOKEN_TIMEOUT_MS: 30 });
        var t0 = Date.now();
        assert.strictEqual(await m.refresh(), null);
        assert.ok(Date.now() - t0 < 1000);
    }, { tags: ['unit'], timeout: 3000 });

    test('_refreshToken still adopts a real answer', async function() {
        var win = { sessionToken: 'old' };
        var m = await load(silentChrome(function(msg, cb) { cb({ token: 'fresh' }); }), win, { PB_REFRESH_TOKEN_TIMEOUT_MS: 1000 });
        assert.strictEqual(await m.refresh(), 'fresh');
        assert.strictEqual(win.sessionToken, 'fresh');
    }, { tags: ['unit'], timeout: 3000 });

    test('_openSnForLogin: no ack and no token -> null at the overall cap', async function() {
        var m = await load(silentChrome(), { sessionToken: 'old' },
            { PB_REFRESH_TOKEN_TIMEOUT_MS: 10, PB_OPEN_LOGIN_ACK_MS: 10, PB_LOGIN_POLL_MS: 10, PB_LOGIN_WAIT_MS: 80 });
        var t0 = Date.now();
        assert.strictEqual(await m.login(), null);
        assert.ok(Date.now() - t0 < 2000, 'settled in ' + (Date.now() - t0) + 'ms');
    }, { tags: ['unit'], timeout: 4000 });

    test('_openSnForLogin: missing ack still polls and returns the new token', async function() {
        var calls = 0;
        var m = await load(silentChrome(function(msg, cb) {
            if (msg.type === 'refresh-sn-token' && ++calls >= 2) cb({ token: 'new' });
        }), { sessionToken: 'old' }, { PB_REFRESH_TOKEN_TIMEOUT_MS: 20, PB_OPEN_LOGIN_ACK_MS: 10, PB_LOGIN_POLL_MS: 10, PB_LOGIN_WAIT_MS: 2000 });
        assert.strictEqual(await m.login(), 'new');
    }, { tags: ['unit'], timeout: 4000 });
});
