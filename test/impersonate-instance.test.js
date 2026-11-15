// iframe_tool impersonate: explicit target instance (instance > known tab_id
// origin > active), per-instance original-user state read at call time,
// absolute urls with the target's own token, 401 re-probe (+ instance tab
// reload), awaited tab reload, real HTTP errors, outside-tool impersonation.
// Real src/js/tools/010-iframe-tool.js with stubbed chrome/Platform/fetch.
describe('iframe_tool impersonate', function() {
    var D1 = 'https://dev1.service-now.com';
    var D2 = 'https://dev2.service-now.com';
    var ME1 = 'a'.repeat(32), ME2 = 'b'.repeat(32), BOB = 'c'.repeat(32);

    function makeStore(init) {
        var data = Object.assign({}, init || {});
        return {
            getItem: function(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
            setItem: function(k, v) { data[k] = String(v); },
            removeItem: function(k) { delete data[k]; }
        };
    }

    // opts: tabs, instTabs {url: tabId}, cur {url: sys_id}, real {url: row},
    // fresh {url: token} or freshAfterReload, respond(url, method, token).
    async function load(opts) {
        opts = opts || {};
        var calls = { fetch: [], sent: [], refresh: [] };
        var tabs = opts.tabs || {};
        var tabPolls = {};
        var reloaded = false;
        var cur = Object.assign({ [D1]: ME1, [D2]: ME2 }, opts.cur || {});
        var chromeStub = {
            runtime: { getURL: function(p) { return 'chrome-extension://x/' + (p || ''); } },
            tabs: {
                get: async function(id) {
                    if (!tabs[id]) throw new Error('No tab with id: ' + id);
                    tabPolls[id] = (tabPolls[id] || 0) + 1;
                    return Object.assign({ id: id, status: tabPolls[id] === 2 ? 'loading' : 'complete' }, tabs[id]);
                },
                query: async function() { return []; }
            }
        };
        var tokens = { [D1]: 'tok1', [D2]: 'tok2' };
        var plat = {
            instanceUrl: D1,
            instances: [{ url: D1, shortName: 'dev1', tabs: [] }, { url: D2, shortName: 'dev2', tabs: [] }],
            resolveInstanceUrl: function(n) {
                if (/^https?:/.test(n)) return n.replace(/\/$/, '');
                return n === 'dev1' ? D1 : n === 'dev2' ? D2 : null;
            },
            getTokenForInstance: async function(u) { return tokens[u] || ''; },
            getTabForInstance: function(u) { return (opts.instTabs && opts.instTabs[u]) || null; },
            refreshTokenForInstance: async function(u, stale) {
                calls.refresh.push([u, stale]);
                var f = (opts.fresh && opts.fresh[u]) || (reloaded && opts.freshAfterReload && opts.freshAfterReload[u]);
                return (f && f !== stale) ? f : '';
            },
            sendBrowserAction: function(a, args, tabId) { calls.sent.push([a, tabId]); reloaded = true; tabPolls[tabId] = 0; return Promise.resolve({ success: true }); }
        };
        var respond = opts.respond || function() { return null; };
        var fetchStub = async function(url, o) {
            var tok = o.headers['X-UserToken'];
            var method = o.method || 'GET';
            calls.fetch.push({ url: url, method: method, token: tok, credentials: o.credentials });
            var base = url.slice(0, url.indexOf('/api/'));
            var q = decodeURIComponent(url);
            var custom = respond(url, method, tok);
            var status = 200, json = { result: {} };
            if (custom) { status = custom.status; json = custom.json; }
            else if (method === 'POST') { cur[base] = url.split('/').pop(); }
            else if (/getImpersonatingUserName/.test(q)) json = { result: (opts.real && opts.real[base]) ? [opts.real[base]] : [] };
            else if (/gs\.getUserID/.test(q)) json = { result: [{ sys_id: cur[base], user_name: 'u_' + cur[base].charAt(0) }] };
            else json = { result: [{ sys_id: BOB, user_name: 'bob', name: 'Bob' }] };
            return { ok: status >= 200 && status < 300, status: status,
                json: async function() { return json; }, text: async function() { return JSON.stringify(json); } };
        };
        var store = makeStore(opts.store);
        var m = await loadModules(['src/js/tools/010-iframe-tool.js'], { lenient: true, globals: {
            chrome: chromeStub, Platform: plat, chats: {}, currentChatId: undefined, appStorage: store, fetch: fetchStub
        } });
        return { m: m, calls: calls, store: store, cur: cur };
    }
    function stateOf(x) { return JSON.parse(x.store.getItem('impersonateOriginalUsers') || '{}'); }
    function posts(x) { return x.calls.fetch.filter(function(f) { return f.method === 'POST'; }).map(function(f) { return f.url; }); }
    function imp(x, args) { return x.m.executeIframeTool(Object.assign({ action: 'impersonate' }, args), {}); }

    test('target resolution: instance > known tab origin > active; mismatch/unknown instance are errors', async function() {
        var x = await load();
        assert.deepStrictEqual(x.m.resolveImpersonationTarget({ instance: 'dev2' }, null), { url: D2, source: 'instance' });
        assert.deepStrictEqual(x.m.resolveImpersonationTarget({}, { id: 5, url: D2 + '/now/nav/ui' }), { url: D2, source: 'tab' });
        assert.deepStrictEqual(x.m.resolveImpersonationTarget({}, null), { url: D1, source: 'active' });
        assert.deepStrictEqual(x.m.resolveImpersonationTarget({}, { id: 6, url: 'https://example.com/x' }), { url: D1, source: 'active' }, 'unknown tab origin falls back to active');
        assert.deepStrictEqual(x.m.resolveImpersonationTarget({ instance: 'dev2' }, { id: 6, url: 'https://example.com/x' }), { url: D2, source: 'instance' });
        assert.match(x.m.resolveImpersonationTarget({ instance: 'dev1' }, { id: 5, url: D2 + '/x' }).error, /not instance https:\/\/dev1/);
        assert.match(x.m.resolveImpersonationTarget({ instance: 'nope' }, null).error, /Unknown instance "nope"/);
    }, { tags: ['unit'], timeout: 5000 });

    test('non-active instance: absolute url + its token, per-instance state, awaited tab reload', async function() {
        var x = await load({ tabs: { 5: { url: D2 + '/now/nav/ui' } } });
        var r = await imp(x, { user: 'bob', tab_id: 5 });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.instance, D2);
        assert.strictEqual(r.tab_reloaded, true);
        x.calls.fetch.forEach(function(f) {
            assert.strictEqual(f.url.indexOf(D2 + '/api/now/'), 0, 'absolute dev2 url: ' + f.url);
            assert.strictEqual(f.token, 'tok2');
            assert.strictEqual(f.credentials, 'include');
        });
        assert.deepStrictEqual(posts(x), [D2 + '/api/now/ui/impersonate/' + BOB]);
        assert.deepStrictEqual(Object.keys(stateOf(x)), [D2]);
        assert.strictEqual(stateOf(x)[D2].sys_id, ME2);
        assert.deepStrictEqual(x.calls.sent, [['reload', 5]]);
        assert.strictEqual(x.m.getImpersonationOriginal(D1), null, 'active instance untouched');
    }, { tags: ['unit'], timeout: 8000 });

    test('chain keeps the real user; " STOP " reads state at call time and clears only that instance', async function() {
        var x = await load({ store: { impersonateOriginalUsers: JSON.stringify({ [D1]: { sys_id: ME1 } }) }, cur: { [D1]: BOB } });
        var r = await imp(x, { user: BOB, instance: 'dev2' });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.tab_reloaded, false);
        await imp(x, { user: 'bob', instance: 'dev2' });
        assert.strictEqual(stateOf(x)[D2].sys_id, ME2, 'original not overwritten by the impersonated user');
        x.store.setItem('impersonateOriginalUsers', JSON.stringify(Object.assign(stateOf(x), { [D2]: { sys_id: ME2, user_name: 'real2' } })));
        x.calls.fetch.length = 0;
        r = await imp(x, { user: ' STOP ', instance: 'dev2' });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.match(r.message, /real2/);
        assert.deepStrictEqual(posts(x), [D2 + '/api/now/ui/impersonate/' + ME2]);
        assert.deepStrictEqual(Object.keys(stateOf(x)), [D1], 'dev1 state kept');
        r = await imp(x, { user: 'stop', instance: 'dev2' });
        assert.strictEqual(r.success, false);
        assert.match(r.error, /No active impersonation recorded for https:\/\/dev2/);
    }, { tags: ['unit'], timeout: 8000 });

    test('stop retries once with a re-probed token on 401 (rotated g_ck)', async function() {
        var x = await load({
            store: { impersonateOriginalUsers: JSON.stringify({ [D1]: { sys_id: ME1 } }) }, cur: { [D1]: BOB },
            fresh: { [D1]: 'tok1b' },
            respond: function(url, method, tok) { return tok === 'tok1' ? { status: 401, json: { error: { message: 'User Not Authenticated' } } } : null; }
        });
        var r = await imp(x, { user: 'stop' });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.deepStrictEqual(x.calls.fetch.slice(0, 2).map(function(f) { return f.token; }), ['tok1', 'tok1b']);
        assert.strictEqual(x.calls.fetch[x.calls.fetch.length - 1].token, 'tok1b');
        assert.deepStrictEqual(x.calls.refresh[0], [D1, 'tok1']);
        assert.deepStrictEqual(stateOf(x), {});
    }, { tags: ['unit'], timeout: 8000 });

    test('no tab_id: 401 with nothing fresh reloads an instance tab, re-probes; finish reloads it too', async function() {
        var x = await load({
            tabs: { 11: { url: D1 + '/x' } }, instTabs: { [D1]: 11 },
            store: { impersonateOriginalUsers: JSON.stringify({ [D1]: { sys_id: ME1 } }) }, cur: { [D1]: BOB },
            freshAfterReload: { [D1]: 'tok1c' },
            respond: function(url, method, tok) { return tok === 'tok1' ? { status: 401, json: {} } : null; }
        });
        var r = await imp(x, { user: 'stop' });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(x.calls.sent[0][1], 11, 'instance tab reloaded before retry');
        assert.strictEqual(x.calls.fetch[1].token, 'tok1c');
        assert.strictEqual(r.reloaded_tab_id, 11);
        assert.strictEqual(r.tab_reloaded, true);
    }, { tags: ['unit'], timeout: 15000 });

    test('session already impersonated outside the tool: records the real (impersonating) user', async function() {
        var x = await load({ cur: { [D1]: BOB }, real: { [D1]: { sys_id: ME1, user_name: 'admin' } } });
        var r = await imp(x, { user: BOB });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.deepStrictEqual(stateOf(x)[D1], { sys_id: ME1, user_name: 'admin' });
    }, { tags: ['unit'], timeout: 5000 });

    test('impersonation ended outside the tool: stale entry is cleared (stop and impersonate)', async function() {
        var x = await load({ store: { impersonateOriginalUsers: JSON.stringify({ [D1]: { sys_id: ME1, user_name: 'stale' } }) } });
        var r = await imp(x, { user: 'bob' });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.deepStrictEqual(stateOf(x)[D1], { sys_id: ME1, user_name: 'u_a' }, 'stale entry dropped and re-recorded');
        x.store.setItem('impersonateOriginalUsers', JSON.stringify({ [D1]: { sys_id: BOB } }));
        x.calls.fetch.length = 0;
        r = await imp(x, { user: 'stop' });
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.match(r.message, /ended outside the tool/);
        assert.deepStrictEqual(posts(x), [], 'no impersonate POST');
        assert.deepStrictEqual(stateOf(x), {});
    }, { tags: ['unit'], timeout: 5000 });

    test('failures surface the real HTTP status/body and do not leave stale state', async function() {
        var x = await load({ respond: function(url, method) { return method === 'POST' ? { status: 403, json: { error: { message: 'Insufficient rights' } } } : null; } });
        var r = await imp(x, { user: 'bob' });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.status, 403);
        assert.match(r.error, /Impersonation failed on https:\/\/dev1\.service-now\.com: HTTP 403/);
        assert.match(r.body, /Insufficient rights/);
        assert.deepStrictEqual(stateOf(x), {});
    }, { tags: ['unit'], timeout: 5000 });

    test('legacy global key: migrated into the map for the active instance only', async function() {
        var x = await load({ store: { impersonateOriginalUserSysId: ME2 } });
        assert.strictEqual(x.m.getImpersonationOriginal(D2), null);
        assert.strictEqual(x.m.getImpersonationOriginal(D1).sys_id, ME2);
        assert.strictEqual(x.store.getItem('impersonateOriginalUserSysId'), null, 'legacy key removed');
        assert.strictEqual(stateOf(x)[D1].sys_id, ME2, 'migrated into the per-instance map');
    }, { tags: ['unit'], timeout: 5000 });
});
