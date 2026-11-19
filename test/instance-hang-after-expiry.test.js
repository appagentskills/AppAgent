// Hang paths behind "agent can't reconnect after the SN session expired until
// a browser restart" (v1.1.43): shim login wait, sys.scripts.do queue, and the
// connect_instance single-flight. Each test drives the REAL source slice with a
// promise that never settles and asserts the caller is released.
describe('instance hang after session expiry', function() {
    function between(text, start, end) {
        var a = text.indexOf(start);
        if (a < 0) throw new Error('marker missing: ' + start);
        var b = end ? text.indexOf(end, a + start.length) : text.length;
        if (b < 0) throw new Error('marker missing: ' + end);
        return text.slice(a, b);
    }
    var never = function() { return new Promise(function() {}); };

    async function shim(selfObj) {
        var src = between(await loadFile('src/js/worker/010-platform-stub.js'), '// --- Shim login wait');
        return new Function('self', src + '\nreturn { wait: _awaitLoginBounded, expired: _sessionExpiredResponse, waits: _shimLoginWaits };')(selfObj);
    }

    test('shim login wait fails fast instead of waiting 4 min, and is shared', async function() {
        var calls = 0;
        var s = { __snShimLoginWaitMs: 30, snOpenForLoginAndWait: function() { calls++; return never(); } };
        var m = await shim(s);
        var r = await Promise.all([m.wait('https://x.service-now.com', 'dead'), m.wait('https://x.service-now.com', 'dead')]);
        assert.strictEqual(r[0].timedOut, true);
        assert.strictEqual(r[1].timedOut, true);
        assert.strictEqual(calls, 1, 'concurrent 401s share ONE login wait (no reload storm)');
        var res = m.expired(null, 'https://x.service-now.com');
        assert.strictEqual(res.status, 401);
        var body = await res.json();
        assert.ok(/session expired/i.test(body.error.message));
    }, { tags: ['unit'], timeout: 2000 });

    test('relative-URL 401 returns session-expired within ~5s (real caps); login keeps going', async function() {
        var stub = await loadFile('src/js/worker/010-platform-stub.js');
        var src = between(stub, 'var SN_TOKEN_PROBE_DEADLINE_MS', 'Platform.refreshTokenAfter401 =') +
            between(stub, 'function _freshTokenAfter401');
        var logins = 0, hits = [];
        var s = {
            fetch: function(u, o) { hits.push(o.headers['X-UserToken']); return Promise.resolve(new Response('{}', { status: 401 })); },
            snGetTokenForInstance: never,            // token re-probe hangs (frozen tabs)
            snOpenForLoginAndWait: function() { logins++; return never(); }   // user never logs in
        };
        var P = { instanceUrl: 'https://x.service-now.com', instances: [] };
        var held = new Function('self', 'Platform', 'var _workerSessionToken = "dead"; function _adoptWorkerToken(t) { _workerSessionToken = t; }\n' +
            'function _dropWorkerToken(t) { if (t && t === _workerSessionToken) _workerSessionToken = ""; }\n' + src + '\nreturn function() { return _workerSessionToken; };')(s, P);
        var t0 = Date.now();
        var res = await s.fetch('/api/now/table/incident');
        var ms = Date.now() - t0;
        assert.ok(ms < 6000, '401 path returned in ' + ms + 'ms');
        assert.strictEqual(res.status, 401);
        var body = await res.json();
        assert.ok(/session expired/i.test(body.error.message) && /log in to https:\/\/x\.service-now\.com/i.test(body.error.message), body.error.message);
        assert.strictEqual(logins, 1, 'login tab flow started and left running in the background');
        assert.strictEqual(held(), '', 'the dead token is dropped after the shim timed out');
    }, { tags: ['unit'], timeout: 9000 });

    test('getRecordVersion + main request share ONE connection budget (no stacked waits)', async function() {
        var stub = await loadFile('src/js/worker/010-platform-stub.js');
        var src = between(stub, 'var SN_TOKEN_PROBE_DEADLINE_MS', 'Platform.refreshTokenAfter401 =') +
            between(stub, 'function _freshTokenAfter401');
        var logins = 0, sent = [];
        var s = {
            fetch: function(u, o) { sent.push(o); return Promise.resolve(new Response('{}', { status: 401 })); },
            snGetTokenForInstance: never,
            snOpenForLoginAndWait: function() { logins++; return never(); }
        };
        var P = { instanceUrl: 'https://x.service-now.com', instances: [] };
        new Function('self', 'Platform', 'var _workerSessionToken = "dead"; function _adoptWorkerToken(t) { _workerSessionToken = t; }\n' +
            'function _dropWorkerToken(t) { if (t && t === _workerSessionToken) _workerSessionToken = ""; }\n' + src)(s, P);
        var t0 = Date.now(), dl = t0 + 1500;
        var r1 = await s.fetch('/api/now/table/sys_update_version', { _snDeadlineAt: dl });   // getRecordVersion
        var t1 = Date.now() - t0;
        var r2 = await s.fetch('/api/now/table/incident', { _snDeadlineAt: dl });             // main request
        var t2 = Date.now() - t0;
        assert.strictEqual(r1.status, 401);
        assert.ok(t1 < 2500, 'first 401 honored the 1.5s budget, not the 5s cap: ' + t1 + 'ms');
        assert.ok(t2 - t1 < 500, 'second 401 hit the fast path: ' + (t2 - t1) + 'ms');
        var body = await r2.json();
        assert.ok(/session expired/i.test(body.error.message), body.error.message);
        assert.strictEqual(logins, 1, 'one shared login wait');
        assert.ok(sent.every(function(o) { return !('_snDeadlineAt' in o); }), 'budget marker never sent on the wire');
    }, { tags: ['unit'], timeout: 5000 });

    test('shim login wait adopts the token when login finishes late', async function() {
        var adopted = null;
        var src = between(await loadFile('src/js/worker/010-platform-stub.js'), '// --- Shim login wait');
        var m = new Function('self', 'Platform', '__a', 'function _adoptWorkerToken(t) { __a(t); }\n' + src +
            '\nreturn { wait: _awaitLoginBounded };')(
            { __snShimLoginWaitMs: 20, snOpenForLoginAndWait: function() { return freshTimeout(60).then(function() { return 'late'; }); } },
            { instanceUrl: 'https://w.service-now.com' }, function(t) { adopted = t; });
        var r = await m.wait('https://w.service-now.com', 'dead');
        assert.strictEqual(r.timedOut, true);
        await freshTimeout(100);
        assert.strictEqual(adopted, 'late');
    }, { tags: ['unit'], timeout: 2000 });

    test('shim login wait rejects as soon as the tool aborts', async function() {
        var m = await shim({ __snShimLoginWaitMs: 60000, snOpenForLoginAndWait: never });
        var ac = new AbortController();
        var p = m.wait('https://y.service-now.com', 'dead', ac.signal);
        setTimeout(function() { ac.abort(); }, 10);
        var err = null;
        try { await p; } catch (e) { err = e; }
        assert.ok(err, 'aborted wait must reject');
    }, { tags: ['unit'], timeout: 2000 });

    test('shim returns the fresh login token when login completes in time', async function() {
        var m = await shim({ __snShimLoginWaitMs: 1000, snOpenForLoginAndWait: function() { return Promise.resolve('fresh'); } });
        var r = await m.wait('https://z.service-now.com', 'dead');
        assert.strictEqual(r.token, 'fresh');
        await new Promise(function(r2) { setTimeout(r2, 0); });
        assert.strictEqual(Object.keys(m.waits).length, 0, 'settled wait is released');
    }, { tags: ['unit'], timeout: 2000 });

    test('a stuck sys.scripts.do run no longer blocks the queue forever', async function() {
        var t = await loadFile('src/js/tools/020-tool-execution.js');
        var src = between(t, 'var _sysScriptsQueues = {};', '\n}\n') + '\n}\n';
        var q = new Function('self', src + '\nreturn _enqueueSysScripts;')({ __sysScriptsSlotCapMs: 30 });
        q('i', never);
        var v = await q('i', function() { return 'second ran'; });
        assert.strictEqual(v, 'second ran');
    }, { tags: ['unit'], timeout: 2000 });

    test('connect_instance single-flight is released when a login run hangs', async function() {
        var bg = await loadFile('src/platform/extension/background.js');
        var helpers = between(bg, '// Whole-run cap for one auto-login', 'function snAutoLoginSleep(ms)');
        var login = between(bg, 'async function snAutoLogin(origin, creds, opts) {', 'async function snAutoLoginRun(');
        var runs = 0;
        var f = new Function('snAutoLoginRun', 'var _snAutoLoginInflight = {}, _snAutoLoginOriginTail = {}, SN_AUTO_LOGIN_MAX_FAILS = 2;\n' +
            'function snAutoLoginId(o, u) { return o + "|" + u; }\nfunction snAutoLoginFailState() { return Promise.resolve(null); }\n' +
            helpers + login + '\nreturn { login: snAutoLogin, inflight: _snAutoLoginInflight, tail: _snAutoLoginOriginTail };');
        var m = f(function() { runs++; return runs === 1 ? never() : Promise.resolve({ success: true }); });
        var o = 'https://x.service-now.com';
        var r1 = await m.login(o, { username: 'a', password: 'p' }, { hardCapMs: 30 });
        assert.strictEqual(r1.success, false);
        assert.strictEqual(r1.reason, 'timeout');
        assert.strictEqual(Object.keys(m.inflight).length, 0, 'inflight entry released');
        assert.strictEqual(Object.keys(m.tail).length, 0, 'origin tail released');
        var r2 = await m.login(o, { username: 'a', password: 'p' }, { hardCapMs: 30 });
        assert.strictEqual(r2.success, true, 'a retry runs a fresh login');
    }, { tags: ['unit'], timeout: 2000 });
});
