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
    // Controllable stand-in for AbortSignal.timeout(ms): fire() aborts it.
    function fakeSignal(ms) {
        var s = { ms: ms, aborted: false, listeners: [] };
        s.addEventListener = function(t, fn) { if (t === 'abort') s.listeners.push(fn); };
        s.removeEventListener = function() {};
        s.fire = function() { s.aborted = true; s.listeners.splice(0).forEach(function(fn) { fn(); }); };
        return s;
    }
    // opts.failSet(obj) -> true makes chrome.storage.local.set reject for that write;
    // opts.realConstants evaluates the production CLAUDE_OAUTH block too.
    async function oauthHarness(seed, opts) {
        opts = opts || {};
        var bg = await loadFile('src/platform/extension/background.js');
        var src = between(bg, 'var claudeOAuthEpoch = 0;', '// --- Claude OAuth Streaming Proxy ---');
        if (opts.realConstants) src = between(bg, 'var CLAUDE_OAUTH = {', '// Guard for silent auto-login') + '\n' + src;
        // opts.realOrg evaluates the production resolveActiveOrg (cookies via opts.cookies).
        if (opts.realOrg) src = between(bg, 'async function resolveActiveOrg(sessionKey) {', '// Live-refresh Claude usage') + '\n' + src;
        var h = { store: seed || {}, broadcasts: [], fetches: [], listener: null, signals: [], logs: [] };
        var chrome = {
            storage: { local: {
                get: function(keys, cb) {
                    var out = {};
                    [].concat(keys).forEach(function(k) { if (k in h.store) out[k] = clone(h.store[k]); });
                    Promise.resolve().then(function() { cb(out); });
                },
                set: function(obj) {
                    if (opts.failSet && opts.failSet(obj)) return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
                    Object.keys(obj).forEach(function(k) { h.store[k] = clone(obj[k]); });
                    return Promise.resolve();
                },
                remove: function(keys) { [].concat(keys).forEach(function(k) { delete h.store[k]; }); return Promise.resolve(); }
            } },
            runtime: {
                sendMessage: function(msg) { h.broadcasts.push(clone(msg)); return Promise.resolve(); },
                onMessage: { addListener: function(fn) { h.listener = fn; } }
            }
        };
        var deps = {
            chrome: chrome,
            // Honours opts.signal like the real fetch: an abort rejects with TimeoutError.
            fetch: function(url, o) {
                return new Promise(function(resolve, reject) {
                    h.fetches.push({ url: url, method: o.method, headers: clone(o.headers), body: o.body ? JSON.parse(o.body) : undefined,
                        signal: o.signal, resolve: resolve, reject: reject });
                    var sig = o.signal;
                    if (sig) {
                        var abort = function() { var e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; reject(e); };
                        if (sig.aborted) abort(); else sig.addEventListener('abort', abort);
                    }
                });
            },
            AbortSignal: { timeout: function(ms) { var s = fakeSignal(ms); h.signals.push(s); return s; } },
            CLAUDE_OAUTH: { apiHost: 'https://fixture.invalid', clientId: 'cid', redirectUri: 'https://fixture.invalid/cb', scopes: 'user:inference' },
            getClaudeCookie: function(name) {
                return Promise.resolve(opts.cookies && name in opts.cookies ? opts.cookies[name] : 'sk-fixture');
            },
            resolveActiveOrg: function() { return Promise.resolve('org-1'); },
            makePkce: function() { return Promise.resolve({ state: 'st', verifier: 'ver', challenge: 'chal' }); },
            console: ['log', 'info', 'warn', 'error'].reduce(function(c, lvl) {
                c[lvl] = function() { h.logs.push([lvl].concat([].slice.call(arguments)).join(' ')); };
                return c;
            }, {})
        };
        var names = Object.keys(deps);
        // Exposes the SW internals the stream paths use (renewClaudeToken) and
        // the single-flight / back-off state for assertions.
        h.bg = new Function(names.join(','), 'var claudeAutoLoginInFlight = false;\n' + src +
            '\nreturn { renewClaudeToken: renewClaudeToken, CLAUDE_OAUTH: CLAUDE_OAUTH,' +
            ' inFlight: function() { return claudeRenewInFlight; },' +
            ' ageLastFailure: function(ms) { claudeRenewLastFailure.at -= ms; },' +
            ' lastFailure: function() { return claudeRenewLastFailure; } };')
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

    function errJson(status, body) {
        return { ok: false, status: status, json: function() { return Promise.resolve(clone(body)); },
            text: function() { return Promise.resolve(JSON.stringify(body)); } };
    }

    test('CLI client: concurrent renewals share ONE refresh and persist the rotated refresh token', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var a = h.post({ type: 'claude-oauth-refresh' });
        var b = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        for (var i = 0; i < 50; i++) await Promise.resolve();
        assert.strictEqual(h.fetches.length, 1, 'single-flight: one refresh for two callers');
        assert.strictEqual(h.fetches[0].body.grant_type, 'refresh_token');
        assert.strictEqual(h.fetches[0].body.refresh_token, 'rt-1');
        h.fetches[0].resolve(okJson({ access_token: 'fresh', refresh_token: 'rt-2', expires_in: 28800 }));
        var ra = await a.wait(), rb = await b.wait();
        assert.strictEqual(ra.success, true);
        assert.strictEqual(rb.success, true);
        assert.strictEqual(h.store.claudeOAuth.accessToken, 'fresh');
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-2', 'rotated refresh token persisted');
        assert.ok(h.store.claudeOAuth.expiresAt - Date.now() > 28000 * 1000, 'expires_in 28800 honoured');
        assert.strictEqual(h.credsBroadcasts().length, 1);

        // A later renew uses the ROTATED token, never the stale snapshot.
        h.store.claudeOAuth.expiresAt = 1;
        var c = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(2);
        assert.strictEqual(h.fetches[1].body.refresh_token, 'rt-2');
        h.fetches[1].resolve(okJson({ access_token: 'fresh2', expires_in: 28800 }));
        assert.strictEqual((await c.wait()).success, true);
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-2', 'kept when the response has none');
    }, { tags: ['unit'], timeout: 2000 });

    test('CLI client: invalid_grant falls back to cookie authorize; Desktop creds (no refresh token) go straight to authorize', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var r = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        h.fetches[0].resolve(errJson(400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }));
        await h.fetched(2);
        assert.match(h.fetches[1].url, /\/v1\/oauth\/org-1\/authorize$/);
        h.fetches[1].resolve(okJson(AUTH_OK));
        await h.fetched(3);
        assert.strictEqual(h.fetches[2].body.grant_type, 'authorization_code');
        h.fetches[2].resolve(okJson({ access_token: 'via-cookie', refresh_token: 'rt-new', expires_in: 28800 }));
        assert.strictEqual((await r.wait()).success, true);
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-new');

        var g = await oauthHarness({ claudeOAuth: { accessToken: 'desktop', expiresAt: 1 } });
        var m = g.post({ type: 'claude-oauth-refresh' });
        await g.fetched(1);
        assert.match(g.fetches[0].url, /authorize$/, 'migration: no refresh token -> cookie authorize');
        g.fetches[0].resolve(okJson(AUTH_OK));
        await g.fetched(2);
        g.fetches[1].resolve(okJson({ access_token: 'cli', refresh_token: 'rt-cli', expires_in: 28800 }));
        assert.strictEqual((await m.wait()).success, true);
        assert.strictEqual(g.store.claudeOAuth.refreshToken, 'rt-cli', 'first renewal upgrades to a refresh-token login');
    }, { tags: ['unit'], timeout: 2000 });

    test('CLI client: session_stale_relogin surfaces only after refresh AND authorize fail; the status poll then backs off', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var r = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        h.fetches[0].resolve(errJson(400, { error: 'invalid_grant' }));
        await h.fetched(2);
        h.fetches[1].resolve(errJson(403, { error: { type: 'permission_error', details: { error_code: 'session_stale_relogin' } } }));
        var reply = await r.wait();
        assert.match(reply.error, /session_stale_relogin/);
        assert.match(reply.error, /fresh sign-in/);
        assert.ok(!/refresh token also rejected/.test(reply.error), 'stale-session message stays clean');
        assert.strictEqual(h.store.claudeOAuth.accessToken, 'old', 'creds untouched on failure');

        var poll = h.post({ type: 'claude-oauth-status' });
        var pr = await poll.wait();
        assert.deepStrictEqual([pr.loggedIn, pr.expired, pr.expiresAt], [true, true, 1]);
        assert.strictEqual(pr.lastRenew.path, 'failed');
        assert.strictEqual(h.fetches.length, 2, 'poll backoff: no new refresh/authorize right after a failure');
    }, { tags: ['unit'], timeout: 2000 });

    test('CLI client: an old-epoch renew never consumes the new session refresh token nor replaces the in-flight promise', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var oldCall = h.post({ type: 'claude-oauth-refresh' }); // captures epoch 0
        h.listener({ type: 'claude-oauth-logout' }, {}, function() {}); // epoch -> 1, same tick
        h.store.claudeOAuth = { accessToken: 'relogin', refreshToken: 'rt-new', expiresAt: 1 }; // re-login
        var b = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        var c = h.post({ type: 'claude-oauth-refresh' });
        for (var i = 0; i < 50; i++) await Promise.resolve();
        assert.strictEqual(h.fetches.length, 1, 'old-epoch call made no fetch; c shares b');
        assert.strictEqual(h.fetches[0].body.refresh_token, 'rt-new');
        h.fetches[0].resolve(okJson({ access_token: 'new', refresh_token: 'rt-new-2', expires_in: 28800 }));
        assert.match((await oldCall.wait()).error, /cancelled by a logout/);
        assert.strictEqual((await b.wait()).success, true);
        assert.strictEqual((await c.wait()).success, true);
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-new-2');
    }, { tags: ['unit'], timeout: 2000 });

    test('CLI client: the code exchange omits scope', async function() {
        var h = await oauthHarness({ claudeOAuth: { accessToken: 'd', expiresAt: 1 } });
        var r = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        h.fetches[0].resolve(okJson(AUTH_OK));
        await h.fetched(2);
        assert.strictEqual('scope' in h.fetches[1].body, false);
        h.fetches[1].resolve(okJson({ access_token: 'x', expires_in: 28800 }));
        assert.strictEqual((await r.wait()).success, true);
    }, { tags: ['unit'], timeout: 2000 });

    test('CLI client: the status poll does not refresh a token that is not near expiry', async function() {
        var exp = Date.now() + 3600 * 1000;
        var h = await oauthHarness({ claudeOAuth: { accessToken: 'ok', refreshToken: 'rt-1', expiresAt: exp } });
        assert.deepStrictEqual(await h.post({ type: 'claude-oauth-status' }).wait(), { loggedIn: true, expired: false, expiresAt: exp, lastRenew: null });
        assert.strictEqual(h.fetches.length, 0);
    }, { tags: ['unit'], timeout: 2000 });

    // ---- Hardening (PR #1212 follow-up) ----
    function tick(n) { var p = Promise.resolve(); for (var i = 0; i < (n || 50); i++) p = p.then(function() {}); return p; }
    function settle(p) { return p.then(function(v) { return { ok: v }; }, function(e) { return { err: e }; }); }
    var CLI_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
    var JSON_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

    test('hardening: a hung token fetch aborts at 30s, the renewal rejects, the slot clears, the next call starts fresh', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var r = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        assert.strictEqual(h.fetches[0].body.grant_type, 'refresh_token');
        assert.strictEqual(h.fetches[0].signal.ms, 30000, 'refresh bounded by a 30s timeout signal');
        h.fetches[0].signal.fire();
        await h.fetched(2);
        assert.match(h.fetches[1].url, /authorize$/, 'timeout falls back to cookie authorize');
        assert.strictEqual(h.fetches[1].signal.ms, 30000, 'authorize is bounded too');
        h.fetches[1].signal.fire();
        var reply = await r.wait();
        assert.match(reply.error, /Claude authorize timed out after 30s/);
        assert.match(reply.error, /Claude token refresh timed out after 30s/);
        assert.strictEqual(h.bg.inFlight(), null, 'in-flight entry cleared');
        assert.strictEqual(h.store.claudeOAuth.accessToken, 'old');
        var again = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(3);
        assert.strictEqual(h.fetches[2].body.grant_type, 'refresh_token', 'a fresh renewal, not the dead promise');
        h.fetches[2].resolve(okJson({ access_token: 'fresh', refresh_token: 'rt-2', expires_in: 28800 }));
        assert.strictEqual((await again.wait()).success, true);
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-2');
    }, { tags: ['unit'], timeout: 2000 });

    test('hardening: a storage set failure rejects, broadcasts nothing, skips the cookie fallback and clears the slot', async function() {
        var h = await oauthHarness(expiredWithRefresh(), { failSet: function(o) { return 'claudeOAuth' in o; } });
        var r = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        h.fetches[0].resolve(okJson({ access_token: 'fresh', refresh_token: 'rt-2', expires_in: 28800 }));
        var reply = await r.wait();
        assert.strictEqual(reply.success, undefined, 'no success reported');
        assert.match(reply.error, /Could not save the renewed Claude token: QUOTA_BYTES/);
        await tick();
        assert.strictEqual(h.fetches.length, 1, 'no pointless cookie authorize after a save failure');
        assert.deepStrictEqual(h.credsBroadcasts(), [], 'nothing broadcast');
        assert.strictEqual(h.store.claudeOAuth.accessToken, 'old');
        assert.strictEqual(h.bg.inFlight(), null);
        assert.strictEqual(h.store.claudeOAuthLastRenew.path, 'failed');
        assert.ok(!/fresh|rt-2|rt-1/.test(JSON.stringify(h.store.claudeOAuthLastRenew)), 'diagnostics hold no tokens');
    }, { tags: ['unit'], timeout: 2000 });

    test('hardening: response handling - no refresh_token keeps the old, no expires_in gives 28800, no access_token throws', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var p = h.bg.renewClaudeToken(h.store.claudeOAuth);
        await h.fetched(1);
        h.fetches[0].resolve(okJson({ access_token: 'a1' }));
        var c = await p;
        assert.strictEqual(c.refreshToken, 'rt-1', 'old refresh token kept');
        var life = c.expiresAt - Date.now();
        assert.ok(life > 28800 * 1000 - 5000 && life <= 28800 * 1000, 'default lifetime 28800s, got ' + life);
        assert.ok(h.logs.some(function(l) { return /no expires_in; assuming 28800s/.test(l); }), 'missing expires_in is logged');

        h.store.claudeOAuth.expiresAt = 1;
        var p2 = settle(h.bg.renewClaudeToken(h.store.claudeOAuth));
        await h.fetched(2);
        h.fetches[1].resolve(okJson({ refresh_token: 'rt-x', expires_in: 100 }));
        await h.fetched(3);
        assert.match(h.fetches[2].url, /authorize$/);
        h.fetches[2].resolve(errJson(500, { error: 'boom' }));
        var out = await p2;
        assert.ok(out.err, 'renewal rejects');
        assert.match(out.err.message, /Authorize failed: 500/);
        assert.match(out.err.message, /no access_token/);
        assert.strictEqual(h.store.claudeOAuth.accessToken, 'a1', 'creds untouched');
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-1');
    }, { tags: ['unit'], timeout: 2000 });

    test('hardening: 5 concurrent callers share 1 refresh and 1 result; a failure reaches all 5', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var calls = [0, 1, 2, 3, 4].map(function() { return h.bg.renewClaudeToken({ accessToken: 'old', refreshToken: 'rt-1', expiresAt: 1 }); });
        await h.fetched(1);
        await tick();
        assert.strictEqual(h.fetches.length, 1, 'exactly one refresh fetch');
        h.fetches[0].resolve(okJson({ access_token: 'fresh', refresh_token: 'rt-2', expires_in: 28800 }));
        var res = await Promise.all(calls);
        res.forEach(function(c) { assert.strictEqual(c, res[0], 'same result object for every caller'); });
        assert.strictEqual(res[0].accessToken, 'fresh');
        assert.strictEqual(h.credsBroadcasts().length, 1);

        h.store.claudeOAuth.expiresAt = 1;
        var cur = h.store.claudeOAuth;
        var fails = [0, 1, 2, 3, 4].map(function() { return settle(h.bg.renewClaudeToken(cur)); });
        await h.fetched(2);
        assert.strictEqual(h.fetches[1].body.refresh_token, 'rt-2');
        h.fetches[1].resolve(errJson(400, { error: 'invalid_grant' }));
        await h.fetched(3);
        h.fetches[2].resolve(errJson(403, { error: { details: { error_code: 'session_stale_relogin' } } }));
        var outs = await Promise.all(fails);
        outs.forEach(function(o) { assert.ok(o.err && o.err === outs[0].err, 'same error for every caller'); });
        assert.strictEqual(outs[0].err.claudeSessionStale, true);
        assert.strictEqual(h.fetches.length, 3, 'one refresh + one authorize for 5 callers');
    }, { tags: ['unit'], timeout: 2000 });

    test('hardening: logout during an in-flight refresh fences its result; the next login is unaffected', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var renew = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        await h.logout();
        var login = h.post({ type: 'claude-oauth-login' });
        await h.fetched(2);
        assert.match(h.fetches[1].url, /authorize$/, 'login does not wait on the fenced renewal');
        h.fetches[0].resolve(okJson({ access_token: 'late', refresh_token: 'rt-late', expires_in: 28800 }));
        assert.match((await renew.wait()).error, /cancelled by a logout/);
        assert.strictEqual('claudeOAuth' in h.store, false, 'late refresh not saved');
        h.fetches[1].resolve(okJson(AUTH_OK));
        await h.fetched(3);
        h.fetches[2].resolve(okJson({ access_token: 'mine', refresh_token: 'rt-mine', expires_in: 28800 }));
        assert.strictEqual((await login.wait()).success, true);
        assert.strictEqual(h.store.claudeOAuth.accessToken, 'mine');
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-mine');
        assert.deepStrictEqual(h.credsBroadcasts().map(function(m) { return m.claudeOAuth.accessToken; }), ['mine']);
        assert.deepStrictEqual([h.store.claudeOAuthLastRenew.path, h.store.claudeOAuthLastRenew.via], ['authorize', 'login']);
    }, { tags: ['unit'], timeout: 2000 });

    test('hardening: the login button waits for an in-flight renewal, then supersedes it; later renewals join the login', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var renew = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        var login = h.post({ type: 'claude-oauth-login' });
        await tick();
        assert.strictEqual(h.fetches.length, 1, 'login does not race the in-flight refresh');
        var joiner = h.bg.renewClaudeToken(h.store.claudeOAuth);
        h.fetches[0].resolve(okJson({ access_token: 'bg', refresh_token: 'rt-2', expires_in: 28800 }));
        assert.strictEqual((await renew.wait()).success, true);
        await h.fetched(2);
        assert.match(h.fetches[1].url, /authorize$/);
        h.fetches[1].resolve(okJson(AUTH_OK));
        await h.fetched(3);
        h.fetches[2].resolve(okJson({ access_token: 'mine', refresh_token: 'rt-mine', expires_in: 28800 }));
        assert.strictEqual((await login.wait()).claudeOAuth.accessToken, 'mine');
        assert.strictEqual((await joiner).accessToken, 'mine', 'a renewal started during the login shares it');
        assert.strictEqual(h.fetches.length, 3);
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-mine');
    }, { tags: ['unit'], timeout: 2000 });

    test('hardening: invalid_grant -> authorize -> 403 session_stale_relogin; clean error; poll backs off 5 min; stream path still retries', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var poll = h.post({ type: 'claude-oauth-status' });
        await h.fetched(1);
        h.fetches[0].resolve(errJson(400, { error: 'invalid_grant' }));
        await h.fetched(2);
        assert.match(h.fetches[1].url, /authorize$/);
        h.fetches[1].resolve(errJson(403, { error: { details: { error_code: 'session_stale_relogin' } } }));
        var pr = await poll.wait();
        assert.deepStrictEqual([pr.loggedIn, pr.expired], [true, true]);
        assert.deepStrictEqual([pr.lastRenew.path, pr.lastRenew.via], ['failed', 'renew']);
        assert.match(pr.lastRenew.error, /session_stale_relogin/);

        await h.post({ type: 'claude-oauth-status' }).wait();
        assert.strictEqual(h.fetches.length, 2, 'poll backs off right after a failure');

        // Stream paths call renewClaudeToken directly: no back-off.
        var s = settle(h.bg.renewClaudeToken(h.store.claudeOAuth));
        await h.fetched(3);
        h.fetches[2].resolve(errJson(400, { error: 'invalid_grant' }));
        await h.fetched(4);
        h.fetches[3].resolve(errJson(403, { error: { details: { error_code: 'session_stale_relogin' } } }));
        var se = (await s).err;
        assert.strictEqual(se.claudeSessionStale, true);
        assert.strictEqual(se.message, 'Your claude.ai session needs a fresh sign-in (session_stale_relogin). Sign out of https://claude.ai and back in, then retry.');

        h.bg.ageLastFailure(5 * 60 * 1000 + 1);
        var later = h.post({ type: 'claude-oauth-status' });
        await h.fetched(5);
        assert.strictEqual(h.fetches[4].body.grant_type, 'refresh_token', 'after 5 min the poll renews again');
        h.fetches[4].resolve(okJson({ access_token: 'back', refresh_token: 'rt-9', expires_in: 28800 }));
        var lr = await later.wait();
        assert.strictEqual(lr.expired, false);
        assert.strictEqual(lr.lastRenew.path, 'refresh');
    }, { tags: ['unit'], timeout: 2000 });

    test('hardening: exact request shape (real CLAUDE_OAUTH) for refresh, authorize and code exchange', async function() {
        var h = await oauthHarness(expiredWithRefresh(), { realConstants: true });
        assert.strictEqual(h.bg.CLAUDE_OAUTH.clientId, CLI_ID);
        var r = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        var f = h.fetches[0];
        assert.deepStrictEqual([f.url, f.method], ['https://api.anthropic.com/v1/oauth/token', 'POST']);
        assert.deepStrictEqual(f.headers, JSON_HEADERS, 'no Authorization header on the token endpoint');
        assert.deepStrictEqual(f.body, { grant_type: 'refresh_token', client_id: CLI_ID, refresh_token: 'rt-1' });
        f.resolve(errJson(400, { error: 'invalid_grant' }));
        await h.fetched(2);
        var a = h.fetches[1];
        assert.strictEqual(a.url, 'https://api.anthropic.com/v1/oauth/org-1/authorize');
        assert.strictEqual(a.headers.Authorization, 'Bearer sk-fixture');
        assert.strictEqual(a.body.client_id, CLI_ID);
        assert.strictEqual(a.body.redirect_uri, 'https://platform.claude.com/oauth/code/callback');
        a.resolve(okJson({ redirect_uri: 'https://platform.claude.com/oauth/code/callback?code=c1&state=st' }));
        await h.fetched(3);
        var x = h.fetches[2];
        assert.deepStrictEqual([x.url, x.method], ['https://api.anthropic.com/v1/oauth/token', 'POST']);
        assert.deepStrictEqual(x.headers, JSON_HEADERS);
        assert.deepStrictEqual(x.body, { grant_type: 'authorization_code', client_id: CLI_ID, code: 'c1',
            redirect_uri: 'https://platform.claude.com/oauth/code/callback', code_verifier: 'ver', state: 'st' });
        x.resolve(okJson({ access_token: 'cli', refresh_token: 'rt-cli', expires_in: 28800 }));
        assert.strictEqual((await r.wait()).success, true);
    }, { tags: ['unit'], timeout: 2000 });

    test('review: a hung org lookup (real resolveActiveOrg) times out, the renewal rejects, the slot clears', async function() {
        var h = await oauthHarness({ claudeOAuth: { accessToken: 'd', expiresAt: 1 } }, { realOrg: true, cookies: { lastActiveOrg: null } });
        var r = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        assert.match(h.fetches[0].url, /\/api\/organizations$/);
        assert.strictEqual(h.fetches[0].signal.ms, 30000, 'org lookup bounded');
        h.fetches[0].signal.fire();
        assert.match((await r.wait()).error, /Claude org lookup timed out after 30s/);
        assert.strictEqual(h.bg.inFlight(), null, 'slot cleared');
    }, { tags: ['unit'], timeout: 2000 });

    test('review: renew in flight -> login queued -> logout -> renew settles: login is stale, no authorize', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var renew = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        var login = h.post({ type: 'claude-oauth-login' });
        await tick();
        await h.logout();
        h.fetches[0].resolve(okJson({ access_token: 'late', expires_in: 100 }));
        assert.match((await login.wait()).error, /cancelled by a logout/);
        assert.match((await renew.wait()).error, /cancelled by a logout/);
        await tick();
        assert.strictEqual(h.fetches.length, 1, 'no authorize after the logout');
        assertLoggedOut(h, 'queued login');
    }, { tags: ['unit'], timeout: 2000 });

    test('review: diagnostics error is redacted and capped; logout clears it; auto-login records lastRenew', async function() {
        var h = await oauthHarness({ claudeOAuth: { accessToken: 'd', expiresAt: 1 } });
        var r = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        h.fetches[0].resolve(errJson(500, { error: 'bad sk-ant-oat01-SECRET_abc-123', pad: new Array(400).join('x') }));
        assert.ok((await r.wait()).error);
        var e = h.store.claudeOAuthLastRenew.error;
        assert.ok(!/SECRET/.test(e), 'token redacted: ' + e);
        assert.match(e, /\[redacted\]/);
        assert.ok(e.length <= 200, 'capped: ' + e.length);
        await h.logout();
        assert.strictEqual('claudeOAuthLastRenew' in h.store, false, 'logout clears the stored record');
        h.store.claudeOAuth = { accessToken: 'n', expiresAt: Date.now() + 3600 * 1000 };
        assert.strictEqual((await h.post({ type: 'claude-oauth-status' }).wait()).lastRenew, null, 'and the in-memory one');

        var g = await oauthHarness({});
        var auto = g.post({ type: 'claude-oauth-status' });
        await g.fetched(1);
        g.fetches[0].resolve(okJson(AUTH_OK));
        await g.fetched(2);
        g.fetches[1].resolve(okJson({ access_token: 'auto', refresh_token: 'rt-a', expires_in: 28800 }));
        var ar = await auto.wait();
        assert.strictEqual(ar.loggedIn, true);
        assert.deepStrictEqual([ar.lastRenew.path, ar.lastRenew.via], ['authorize', 'auto-login']);
    }, { tags: ['unit'], timeout: 2000 });

    test('hardening: restart after an unsaved rotation - stored refresh token is dead, renewal recovers via authorize', async function() {
        // A previous SW rotated rt-1 server-side and died before saving; this fresh
        // harness is the restarted SW (epoch 0, empty in-flight) with rt-1 on disk.
        var h = await oauthHarness(expiredWithRefresh());
        var poll = h.post({ type: 'claude-oauth-status' });
        await h.fetched(1);
        assert.strictEqual(h.fetches[0].body.refresh_token, 'rt-1');
        h.fetches[0].resolve(errJson(400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }));
        await h.fetched(2);
        assert.match(h.fetches[1].url, /authorize$/);
        h.fetches[1].resolve(okJson(AUTH_OK));
        await h.fetched(3);
        h.fetches[2].resolve(okJson({ access_token: 'recovered', refresh_token: 'rt-3', expires_in: 28800 }));
        var reply = await poll.wait();
        assert.deepStrictEqual([reply.loggedIn, reply.expired], [true, false]);
        assert.deepStrictEqual([reply.lastRenew.path, reply.lastRenew.via], ['authorize', 'renew']);
        assert.strictEqual(h.store.claudeOAuth.refreshToken, 'rt-3');
        assert.strictEqual(h.store.claudeOAuthLastRenew.path, 'authorize', 'persisted for SW restarts');
        assert.ok(!/recovered|rt-\d/.test(JSON.stringify(h.store.claudeOAuthLastRenew)), 'no tokens in diagnostics');
        assert.ok(h.logs.some(function(l) { return /^info .*renew succeeded via authorize/.test(l); }), 'console.info log');
    }, { tags: ['unit'], timeout: 2000 });

    test('nit: renew started before a logout that then times out records no diagnostics and no back-off', async function() {
        var h = await oauthHarness({ claudeOAuth: { accessToken: 'old', expiresAt: 1 } });
        var renew = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        assert.match(h.fetches[0].url, /authorize$/);
        await h.logout();
        h.fetches[0].signal.fire();
        assert.match((await renew.wait()).error, /timed out/);
        await tick();
        assert.strictEqual('claudeOAuthLastRenew' in h.store, false, 'no diagnostics re-created after logout');
        assert.strictEqual(h.bg.lastFailure(), null, 'no back-off set after logout');
        assert.ok(!h.logs.some(function(l) { return /renew failed/.test(l); }), 'no failure log for the fenced run');
        assertLoggedOut(h, 'timed-out renew');
    }, { tags: ['unit'], timeout: 2000 });

    test('nit: refresh-failed fallback warn redacts sk-ant- secrets and is capped', async function() {
        var h = await oauthHarness(expiredWithRefresh());
        var renew = h.post({ type: 'claude-oauth-refresh' });
        await h.fetched(1);
        assert.strictEqual(h.fetches[0].body.grant_type, 'refresh_token');
        h.fetches[0].resolve(errJson(400, { error: 'invalid_grant sk-ant-ort01-SECRET_abc-123', pad: new Array(400).join('y') }));
        await h.fetched(2);
        var warn = h.logs.filter(function(l) { return /falling back to cookie authorize/.test(l); });
        assert.strictEqual(warn.length, 1, 'fallback warn logged');
        assert.ok(/^warn /.test(warn[0]), 'logged at warn level');
        assert.ok(!/sk-ant-|SECRET/.test(warn[0]), 'no secret in warn: ' + warn[0]);
        assert.match(warn[0], /\[redacted\]/);
        assert.ok(warn[0].length < 300, 'capped: ' + warn[0].length);
        h.fetches[1].resolve(okJson(AUTH_OK));
        await h.fetched(3);
        h.fetches[2].resolve(okJson({ access_token: 'a2', refresh_token: 'rt-2', expires_in: 3600 }));
        assert.strictEqual((await renew.wait()).success, true);
    }, { tags: ['unit'], timeout: 2000 });
});
