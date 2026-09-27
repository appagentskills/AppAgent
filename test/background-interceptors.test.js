// S0C4-06 — background.js injectInterceptors: the MAIN-world console interceptor
// posts 'appagent-console' on the page window. A page 'message' listener that logs
// what it receives re-entered capture() and looped forever. Runs the REAL
// injectInterceptors slice against a fake chrome.scripting, then the injected func
// against a fake page window whose postMessage queue is drained like the browser's
// (one message event per post; window.event is set while it is dispatched).
describe('S0C4-06: console interceptor does not loop (background.js injectInterceptors)', function() {
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + start);
        return text.slice(a, b);
    }
    async function injectedFunc() {
        var bg = await loadFile('src/platform/extension/background.js');
        var src = between(bg, 'async function injectInterceptors(tabId) {', '// --- Dynamic header rules ---');
        var calls = [];
        var chrome = { scripting: { executeScript: function(o) { calls.push(o); return Promise.resolve([]); } } };
        var inject = new Function('chrome', src + '\nreturn injectInterceptors;')(chrome);
        await inject(7);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].world, 'MAIN');
        assert.strictEqual(typeof calls[0].func, 'function');
        return calls[0].func.toString();
    }
    function fakePage(funcSrc) {
        var w = { posts: [], queue: [], listeners: [], event: undefined };
        w.postMessage = function(data) { w.posts.push(data); w.queue.push(data); };
        w.addEventListener = function(type, fn) { if (type === 'message') w.listeners.push(fn); };
        w.fetch = function() { return Promise.resolve({ status: 200 }); };
        w.XMLHttpRequest = function FakeXHR() {};
        var con = { log: function() {}, warn: function() {}, error: function() {} };
        new Function('window', 'console', 'return (' + funcSrc + ');')(w, con)();
        w.drain = function(max) {
            var n = 0;
            while (w.queue.length && n < max) {
                var ev = { type: 'message', data: w.queue.shift(), source: w };
                n++;
                w.event = ev;
                try { w.listeners.forEach(function(fn) { fn(ev); }); } finally { w.event = undefined; }
            }
            return n;
        };
        return { w: w, console: con };
    }

    test('console capture does not loop through a logging message listener (S0C4-06)', async function() {
        var p = fakePage(await injectedFunc());
        p.w.addEventListener('message', function(e) { p.console.log('page got', e.data); });
        p.console.log('hello');
        p.w.drain(50);
        assert.strictEqual(p.w.posts.length, 1);
        assert.strictEqual(p.w.posts[0].type, 'appagent-console');
        assert.strictEqual(p.w.posts[0].level, 'log');
        assert.strictEqual(p.w.posts[0].message, 'hello');
        assert.strictEqual(p.w.queue.length, 0);
    }, { tags: ['unit'], timeout: 2000 });

    test('logs made while handling the page\'s own messages are still captured (S0C4-06)', async function() {
        var p = fakePage(await injectedFunc());
        p.w.addEventListener('message', function(e) { p.console.warn('page got', e.data); });
        p.w.postMessage({ type: 'page-ping' });
        p.w.drain(50);
        assert.strictEqual(p.w.posts.length, 2);
        assert.strictEqual(p.w.posts[1].type, 'appagent-console');
        assert.strictEqual(p.w.posts[1].level, 'warn');
        assert.strictEqual(p.w.posts[1].message, 'page got {"type":"page-ping"}');
        assert.strictEqual(p.w.queue.length, 0);
    }, { tags: ['unit'], timeout: 2000 });

    // TA3-4: window.event is unset for a log made in a later task (setTimeout) or by another
    // realm's listener, so the S0C4-06 guard alone let such a listener re-post forever. Each
    // round is one drain (window.event set) followed by the queued later tasks (window.event unset).
    function rounds(p, later, n) {
        for (var r = 0; r < n; r++) { p.w.drain(50); later.splice(0).forEach(function(fn) { fn(); }); }
    }
    test('TA3-4: a setTimeout-logging listener gives bounded posts (payload, event and JSON forms)', async function() {
        var src = await injectedFunc();
        var forms = [
            function(e) { return ['page got', e.data]; },
            function(e) { return [e]; },
            function(e) { return ['page got ' + JSON.stringify(e.data)]; }
        ];
        forms.forEach(function(form, i) {
            var p = fakePage(src), later = [];
            p.w.addEventListener('message', function(e) { later.push(function() { p.console.log.apply(p.console, form(e)); }); });
            p.console.log('hello');
            rounds(p, later, 20);
            assert.strictEqual(p.w.posts.length, 1, 'form ' + i + ' re-posted: ' + p.w.posts.length + ' posts');
            assert.strictEqual(p.w.posts[0].message, 'hello');
            assert.strictEqual(p.w.queue.length, 0);
        });
        // a later-task log of the page's OWN message is still captured, exactly once
        var q = fakePage(src), qLater = [];
        q.w.addEventListener('message', function(e) { qLater.push(function() { q.console.warn('page got', e.data); }); });
        q.w.postMessage({ type: 'page-ping' });
        rounds(q, qLater, 20);
        assert.strictEqual(q.w.posts.length, 2, 'posts: ' + q.w.posts.length);
        assert.strictEqual(q.w.posts[1].type, 'appagent-console');
        assert.strictEqual(q.w.posts[1].message, 'page got {"type":"page-ping"}');
    }, { tags: ['unit'], timeout: 2000 });

    test('TA3-4: a cross-realm listener (our window.event unset) logging the event cannot loop capture', async function() {
        var p = fakePage(await injectedFunc());
        p.console.log('hello');
        var n = 0;
        while (p.w.queue.length && n < 50) { n++; p.console.error({ type: 'message', data: p.w.queue.shift() }); }
        assert.strictEqual(p.w.posts.length, 1, 'posts: ' + p.w.posts.length);
        assert.strictEqual(p.w.queue.length, 0);
    }, { tags: ['unit'], timeout: 2000 });

    // S0C4-10: network capture. A reused XHR re-posted for every earlier send (one new
    // 'load' listener per send), failed/aborted XHRs were never posted, and
    // fetch(new Request(...)) was logged as GET '[object Request]'.
    function netPage(funcSrc, pageRequest) {
        var w = { posts: [], addEventListener: function() {} };
        w.postMessage = function(data) { if (data && data.type === 'appagent-network') w.posts.push(data); };
        w.fetchResult = { status: 201 };
        w.fetch = function() { return Promise.resolve(w.fetchResult); };
        function FakeXHR() { this.listeners = {}; this.status = 0; }
        FakeXHR.prototype.addEventListener = function(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
        FakeXHR.prototype.open = function() {};
        FakeXHR.prototype.send = function() {};
        FakeXHR.prototype.fire = function(types, status) {
            var x = this;
            x.status = status;
            types.forEach(function(t) { (x.listeners[t] || []).forEach(function(fn) { fn.call(x, { type: t }); }); });
        };
        w.XMLHttpRequest = FakeXHR;
        var Req = typeof Request === 'function' ? Request
            : function FakeRequest(u, o) { this.url = u; this.method = (o && o.method) || 'GET'; };
        var con = { log: function() {}, warn: function() {}, error: function() {} };
        new Function('window', 'console', 'Request', 'return (' + funcSrc + ');')(w, con, arguments.length > 1 ? pageRequest : Req)();
        return { w: w, Request: Req };
    }
    function net(post) { return [post.method, post.url, post.status]; }
    // Native fetch never throws synchronously; the wrapped one must return its promise/value.
    async function fetchNoThrow(p, args, label) {
        var promise, syncErr = null;
        try { promise = p.w.fetch.apply(p.w, args); } catch (e) { syncErr = e; }
        assert.strictEqual(syncErr && String(syncErr), null, label + ': fetch() must not throw synchronously');
        assert.strictEqual(await promise, p.w.fetchResult, label + ': resolves the native fetch value');
    }
    // Request whose accessors brand-check the receiver like WebIDL (real one when available).
    function brandedRequest() {
        if (typeof Request === 'function') return Request;
        var real = new WeakSet();
        function BrandedRequest(u, o) { real.add(this); this._v = { url: u, method: (o && o.method) || 'GET' }; }
        ['url', 'method'].forEach(function(k) {
            Object.defineProperty(BrandedRequest.prototype, k, { get: function() {
                if (!real.has(this)) throw new TypeError('Illegal invocation');
                return this._v[k];
            } });
        });
        return BrandedRequest;
    }

    test('network capture: reused XHR once per send, failures logged, Request method/url (S0C4-10)', async function() {
        var p = netPage(await injectedFunc());
        var x = new p.w.XMLHttpRequest();
        x.open('GET', '/api/a'); x.send(); x.fire(['load', 'loadend'], 200);
        x.open('POST', '/api/b'); x.send(); x.fire(['load', 'loadend'], 204);
        assert.strictEqual(p.w.posts.length, 2, 'a reused XHR posts once per send');
        assert.deepStrictEqual(net(p.w.posts[0]), ['GET', '/api/a', 200]);
        assert.deepStrictEqual(net(p.w.posts[1]), ['POST', '/api/b', 204]);
        var y = new p.w.XMLHttpRequest();
        y.open('GET', '/api/down'); y.send(); y.fire(['error', 'loadend'], 0);
        assert.strictEqual(p.w.posts.length, 3, 'a failed XHR is posted once');
        assert.deepStrictEqual(net(p.w.posts[2]), ['GET', '/api/down', 0]);
        var res = await p.w.fetch(new p.Request('https://fixture.invalid/y', { method: 'POST' }));
        assert.strictEqual(res.status, 201);
        assert.strictEqual(p.w.posts.length, 4);
        assert.deepStrictEqual(net(p.w.posts[3]), ['POST', 'https://fixture.invalid/y', 201]);
    }, { tags: ['unit'], timeout: 2000 });

    // S0C4-10 follow-up B1: the Request probe ran outside the try, so a page whose global
    // Request is not callable made EVERY fetch() throw ('instanceof' is not callable), and a
    // Proxy / Object.create(Request.prototype) input threw 'Illegal invocation'.
    test('fetch capture survives a non-callable page Request global (S0C4-10 B1)', async function() {
        var funcSrc = await injectedFunc();
        var globals = [{}, null];
        for (var i = 0; i < globals.length; i++) {
            var label = 'Request = ' + JSON.stringify(globals[i]);
            var p = netPage(funcSrc, globals[i]);
            await fetchNoThrow(p, ['https://fixture.invalid/s', { method: 'PUT' }], label);
            await fetchNoThrow(p, ['/api/plain'], label);
            assert.strictEqual(p.w.posts.length, 2, label + ': each fetch is still posted');
            assert.deepStrictEqual(net(p.w.posts[0]), ['PUT', 'https://fixture.invalid/s', 201]);
            assert.deepStrictEqual(net(p.w.posts[1]), ['GET', '/api/plain', 201]);
        }
    }, { tags: ['unit'], timeout: 2000 });

    test('fetch capture survives Proxy / Object.create(Request.prototype) inputs (S0C4-10 B1)', async function() {
        var R = brandedRequest();
        var p = netPage(await injectedFunc(), R);
        var inputs = [
            ['Proxy of a Request', new Proxy(new R('https://fixture.invalid/p', { method: 'POST' }), {})],
            ['Object.create(Request.prototype)', Object.create(R.prototype)]
        ];
        for (var i = 0; i < inputs.length; i++) {
            var label = inputs[i][0], input = inputs[i][1];
            assert.strictEqual(input instanceof R, true, label + ' precondition: passes instanceof');
            assert.throws(function() { return input.method; }, TypeError, label + ' precondition: accessor throws');
            await fetchNoThrow(p, [input], label);
            assert.strictEqual(p.w.posts.length, i + 1, label + ': the fetch is still posted');
            assert.deepStrictEqual(net(p.w.posts[i]), ['GET', '', 201]);
        }
        await fetchNoThrow(p, [inputs[0][1], { method: 'DELETE' }], 'Proxy + init.method');
        assert.deepStrictEqual(net(p.w.posts[2]), ['DELETE', '', 201]);
    }, { tags: ['unit'], timeout: 2000 });

    // TA4-8: the XHR start stamp lived only in the per-instance send wrapper, so a page that
    // sends via XMLHttpRequest.prototype.send.call(xhr) posted Date.now() - null (a null start)
    // or the stamp of an earlier send (a stale start). Date.now is pinned (synchronously, restored
    // in finally) so the durations are exact; a real async send fires loadstart inside send().
    test('XHR via prototype.send.call posts a sane or null duration, never a null/stale start (TA4-8)', async function() {
        var p = netPage(await injectedFunc());
        var XHR = p.w.XMLHttpRequest, protoSend = XHR.prototype.send;
        var realNow = Date.now, t = 0;
        Date.now = function() { return t; };
        try {
            var x = new XHR(); // one reused XHR: a wrapped send, then two prototype sends
            t = 1000; x.open('GET', '/api/wrapped'); x.send(); x.fire(['loadstart']);
            t = 1250; x.fire(['load', 'loadend'], 200);
            t = 5000; x.open('GET', '/api/sync', false); protoSend.call(x); // sync: no loadstart
            t = 5040; x.fire(['load', 'loadend'], 200);
            t = 9000; x.open('GET', '/api/async'); protoSend.call(x); x.fire(['loadstart']);
            t = 9075; x.fire(['load', 'loadend'], 200);
            var y = new XHR(); // fresh XHRs: async (failed) and sync prototype sends
            t = 20000; y.open('GET', '/api/fresh'); protoSend.call(y); y.fire(['loadstart']);
            t = 20030; y.fire(['error', 'loadend'], 0);
            var z = new XHR();
            t = 30000; z.open('GET', '/api/fresh-sync', false); protoSend.call(z);
            t = 30020; z.fire(['load', 'loadend'], 200);
            var s = new XHR(); // a wrapped sync send (no loadstart) is still timed
            t = 40000; s.open('GET', '/api/wrapped-sync', false); s.send();
            t = 40015; s.fire(['load', 'loadend'], 200);
        } finally { Date.now = realNow; }
        assert.deepStrictEqual(p.w.posts.map(function(q) { return net(q); }), [
            ['GET', '/api/wrapped', 200], ['GET', '/api/sync', 200], ['GET', '/api/async', 200],
            ['GET', '/api/fresh', 0], ['GET', '/api/fresh-sync', 200], ['GET', '/api/wrapped-sync', 200]
        ], 'one post per send');
        assert.deepStrictEqual(p.w.posts.map(function(q) { return q.duration; }), [250, null, 75, 30, null, 15],
            'duration is timed from the send/loadstart it belongs to, or null when none was seen');
    }, { tags: ['unit'], timeout: 2000 });
});

// TA4-3: Claude OAuth logout fence (startClaudeOAuth / renewClaudeToken /
// saveOAuthCreds + the OAuth message listener). A renew or cookie re-auth in flight
// when the user logged out resolved later and saveOAuthCreds re-wrote claudeOAuth
// (and broadcast it), silently logging the user back in. Runs the REAL slice from
// the epoch declaration through the listener against fake chrome.storage/runtime
// and a deferred fetch.
describe('TA4-3: Claude OAuth logout fences an in-flight login/renew (background.js)', function() {
    function between(text, start, end) {
        var a = text.indexOf(start), b = text.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Production extraction marker missing: ' + start);
        return text.slice(a, b);
    }
    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    function okJson(body) {
        return { ok: true, status: 200, json: function() { return Promise.resolve(clone(body)); },
            text: function() { return Promise.resolve(JSON.stringify(body)); } };
    }
    var AUTH_OK = { redirect_uri: 'https://fixture.invalid/cb?code=c1&state=st' };
    function expiredWithRefresh() { return { claudeOAuth: { accessToken: 'old', refreshToken: 'rt-1', expiresAt: 1 } }; }
    async function oauthHarness(seed) {
        var bg = await loadFile('src/platform/extension/background.js');
        var src = between(bg, 'var claudeOAuthEpoch = 0;', '// --- Claude OAuth Streaming Proxy ---');
        var h = { store: seed || {}, broadcasts: [], fetches: [], listener: null };
        var chrome = {
            storage: { local: {
                get: function(keys, cb) {
                    var out = {};
                    [].concat(keys).forEach(function(k) { if (k in h.store) out[k] = clone(h.store[k]); });
                    Promise.resolve().then(function() { cb(out); });
                },
                set: function(obj) { Object.keys(obj).forEach(function(k) { h.store[k] = clone(obj[k]); }); return Promise.resolve(); },
                remove: function(keys) { [].concat(keys).forEach(function(k) { delete h.store[k]; }); return Promise.resolve(); }
            } },
            runtime: {
                sendMessage: function(msg) { h.broadcasts.push(clone(msg)); return Promise.resolve(); },
                onMessage: { addListener: function(fn) { h.listener = fn; } }
            }
        };
        var deps = {
            chrome: chrome,
            fetch: function(url, opts) {
                return new Promise(function(resolve) { h.fetches.push({ url: url, body: JSON.parse(opts.body), resolve: resolve }); });
            },
            CLAUDE_OAUTH: { apiHost: 'https://fixture.invalid', clientId: 'cid', redirectUri: 'https://fixture.invalid/cb', scopes: 'user:inference' },
            getClaudeCookie: function() { return Promise.resolve('sk-fixture'); },
            resolveActiveOrg: function() { return Promise.resolve('org-1'); },
            makePkce: function() { return Promise.resolve({ state: 'st', verifier: 'ver', challenge: 'chal' }); },
            console: { log: function() {}, warn: function() {}, error: function() {} }
        };
        var names = Object.keys(deps);
        new Function(names.join(','), 'var claudeAutoLoginInFlight = false;\n' + src)
            .apply(null, names.map(function(n) { return deps[n]; }));
        assert.strictEqual(typeof h.listener, 'function', 'the OAuth listener is registered');
        h.until = async function(pred, label) {
            for (var i = 0; i < 500; i++) { if (pred()) return; await Promise.resolve(); }
            throw new Error('never reached: ' + label);
        };
        // Sends a message; wait() resolves with its sendResponse reply (fails fast if none).
        h.post = function(message) {
            var box = { done: false, reply: undefined };
            h.listener(message, {}, function(r) { box.reply = r; box.done = true; });
            box.wait = async function() { await h.until(function() { return box.done; }, message.type + ' reply'); return box.reply; };
            return box;
        };
        h.fetched = function(n) { return h.until(function() { return h.fetches.length >= n; }, 'fetch #' + n); };
        h.logout = async function() {
            assert.deepStrictEqual(await h.post({ type: 'claude-oauth-logout' }).wait(), { success: true });
        };
        h.credsBroadcasts = function() {
            return h.broadcasts.filter(function(m) { return m.type === 'claude-oauth-updated' && m.claudeOAuth; });
        };
        return h;
    }
    function assertLoggedOut(h, label) {
        assert.strictEqual('claudeOAuth' in h.store, false, label + ': no claudeOAuth re-written');
        assert.strictEqual(h.store.claudeOAuthSuppressAutoLogin, true, label + ': the logout stuck');
        assert.deepStrictEqual(h.credsBroadcasts(), [], label + ': no creds broadcast');
        assert.ok(h.broadcasts.some(function(m) { return m.type === 'claude-oauth-updated' && m.claudeOAuth === null; }), label + ': logout broadcast');
    }

    test('refresh-token renew, then logout, then resolve: no claudeOAuth, no creds broadcast (TA4-3)', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var renew = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        assert.strictEqual(h.fetches[0].body.grant_type, 'refresh_token');
        await h.logout();
        h.fetches[0].resolve(okJson({ access_token: 'late', expires_in: 3600 }));
        var r = await renew.wait();
        assert.strictEqual(r.success, undefined);
        assert.match(r.error, /cancelled by a logout/);
        assertLoggedOut(h, 'refresh-token renew');
        assert.strictEqual(h.fetches.length, 1, 'a fenced renew does not fall back to cookie re-auth');
    }, { tags: ['unit'], timeout: 2000 });

    test('cookie re-auth renew, then logout, then resolve: no claudeOAuth, no creds broadcast (TA4-3)', async function() {
        var h = await oauthHarness({ claudeOAuth: { accessToken: 'old', expiresAt: 1 } });
        var renew = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        assert.match(h.fetches[0].url, /\/v1\/oauth\/org-1\/authorize$/);
        h.fetches[0].resolve(okJson(AUTH_OK));
        await h.fetched(2);
        assert.strictEqual(h.fetches[1].body.grant_type, 'authorization_code');
        await h.logout();
        h.fetches[1].resolve(okJson({ access_token: 'late', expires_in: 3600 }));
        var r = await renew.wait();
        assert.match(r.error, /cancelled by a logout/);
        assertLoggedOut(h, 'cookie re-auth');
    }, { tags: ['unit'], timeout: 2000 });

    test('control: a renew with no logout writes, and a login after a logout writes (TA4-3)', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var renew = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        h.fetches[0].resolve(okJson({ access_token: 'fresh', expires_in: 3600 }));
        var r = await renew.wait();
        assert.strictEqual(r.success, true);
        assert.strictEqual(h.store.claudeOAuth.accessToken, 'fresh');
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-1');
        assert.strictEqual(h.credsBroadcasts().length, 1);

        var g = await oauthHarness({});
        await g.logout();
        var login = g.post({ type: 'claude-oauth-login' });
        await g.fetched(1);
        g.fetches[0].resolve(okJson(AUTH_OK));
        await g.fetched(2);
        g.fetches[1].resolve(okJson({ access_token: 'after-logout', expires_in: 3600 }));
        var lr = await login.wait();
        assert.strictEqual(lr.success, true);
        assert.strictEqual(g.store.claudeOAuth.accessToken, 'after-logout');
        assert.strictEqual('claudeOAuthSuppressAutoLogin' in g.store, false, 'a manual login re-enables auto-login');
        assert.strictEqual(g.credsBroadcasts().length, 1);
    }, { tags: ['unit'], timeout: 2000 });

    test('a status-poll renew (and auto-login) is fenced and replies loggedIn:false (TA4-3)', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var poll = h.post({ type: 'claude-oauth-status' });
        await h.fetched(1);
        await h.logout();
        h.fetches[0].resolve(okJson({ access_token: 'late', expires_in: 3600 }));
        assert.deepStrictEqual(await poll.wait(), { loggedIn: false });
        assertLoggedOut(h, 'status renew');

        var g = await oauthHarness({});
        var auto = g.post({ type: 'claude-oauth-status' });
        await g.fetched(1);
        await g.logout();
        g.fetches[0].resolve(okJson(AUTH_OK));
        await g.fetched(2);
        g.fetches[1].resolve(okJson({ access_token: 'late', expires_in: 3600 }));
        assert.deepStrictEqual(await auto.wait(), { loggedIn: false });
        assertLoggedOut(g, 'status auto-login');
        assert.strictEqual('claudeAutoLoginFailedFor' in g.store, false, 'a fenced auto-login does not mark the cookie failed');
    }, { tags: ['unit'], timeout: 2000 });
});
