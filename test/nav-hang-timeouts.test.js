// Hang regression (#1209): iframe_tool navigate with a relative url + instance +
// wait used to await Platform.refreshInstances() (and per-tab probes / content
// script pings) with no bound. Real src/js/tools/010-iframe-tool.js and the real
// background.js probe helpers, with NEVER-resolving stubs.
var NEVER = function() { return new Promise(function() {}); };

describe('navigate never hangs on a stuck registry refresh / tab', function() {
    async function load(opts) {
        opts = opts || {};
        var created = [], refreshes = 0;
        var platform = {
            instanceUrl: opts.instanceUrl || 'https://dev1.service-now.com',
            instances: opts.instances || [],
            resolveInstanceUrl: function(n) {
                if (!n) return this.instanceUrl;
                if (n.startsWith('http')) return n.replace(/\/$/, '');
                if (n.indexOf('.') !== -1) return 'https://' + n;
                for (var i = 0; i < this.instances.length; i++) if (this.instances[i].shortName === n) return this.instances[i].url;
                return null;
            },
            refreshInstances: function() { refreshes++; return NEVER(); },
            sendBrowserAction: opts.sendBrowserAction || NEVER
        };
        var chromeStub = {
            runtime: { getURL: function(p) { return 'chrome-extension://abc/' + (p || ''); }, sendMessage: function() {} },
            storage: { local: { get: function(k, cb) { setTimeout(function() { cb({ instanceTokens: opts.tokenCache || {} }); }, 0); } } },
            tabs: {
                get: function(id, cb) { if (cb) cb({ id: id, status: 'loading', url: 'about:blank' }); return Promise.resolve({ id: id }); },
                create: async function(o) { created.push(o.url); return { id: 42, url: o.url }; },
                update: async function(id, o) { return { id: id, url: o.url }; },
                onUpdated: { addListener: function() {}, removeListener: function() {} },   // 'complete' never fires
                onRemoved: { addListener: function() {}, removeListener: function() {} }
            }
        };
        var docStub = { body: { classList: { contains: function() { return false; } } }, getElementById: function() { return null; } };
        var m = await loadModules(['src/js/tools/010-iframe-tool.js'], { lenient: true, globals: {
            chrome: chromeStub, Platform: platform, document: docStub, chats: {}, currentChatId: undefined
        } });
        m._navTimeouts.refresh = 200; m._navTimeouts.ready = 200; m._navTimeouts.hardExtra = 200;
        return { m: m, created: created, refreshes: function() { return refreshes; } };
    }

    test('never-resolving refreshInstances: unknown short name errors within the refresh timeout', async function() {
        var x = await load();
        var t0 = Date.now();
        var r = await x.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: '/incident_list.do', instance: 'dev428560' }, {});
        assert.ok(Date.now() - t0 < 2000, 'returned in ' + (Date.now() - t0) + 'ms');
        assert.strictEqual(r.success, false);
        assert.match(r.error, /Unknown instance "dev428560"/);
        assert.match(r.error, /refresh timed out/);
        assert.strictEqual(x.refreshes(), 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('short name of the active instance / token cache resolves with NO refresh', async function() {
        var x = await load({ instanceUrl: 'https://dev428560.service-now.com' });
        var r = await x.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: '/incident_list.do', instance: 'dev428560' }, {});
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.deepStrictEqual(x.created, ['https://dev428560.service-now.com/incident_list.do']);
        var y = await load({ tokenCache: { 'https://dev777.service-now.com': { token: 't' } } });
        var r2 = await y.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: '/x.do', instance: 'dev777' }, {});
        assert.strictEqual(r2.success, true, JSON.stringify(r2));
        assert.deepStrictEqual(y.created, ['https://dev777.service-now.com/x.do']);
        assert.strictEqual(x.refreshes() + y.refreshes(), 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('wait with a tab that never completes and a content script that never answers returns loaded:false + warning', async function() {
        var x = await load({ instanceUrl: 'https://dev428560.service-now.com' });
        var t0 = Date.now();
        var r = await x.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: '/incident_list.do', instance: 'dev428560', wait: 300 }, {});
        var dt = Date.now() - t0;
        assert.ok(dt < 2500, 'returned in ' + dt + 'ms');
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.loaded, false);
        assert.match(r.warning, /did not report loaded/);
        assert.strictEqual(r.tab_id, 42);
    }, { tags: ['unit'], timeout: 5000 });

    test('each never-answering content-script ping is capped by the ready window', async function() {
        var x = await load({ instanceUrl: 'https://dev428560.service-now.com' });
        x.m._navTimeouts.ready = 400; x.m._navTimeouts.hardExtra = 100;
        var t0 = Date.now();
        var r = await x.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: '/a.do', instance: 'dev428560', wait: 100 }, {});
        assert.ok(Date.now() - t0 < 2000);
        assert.strictEqual(r.loaded, false);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('background probes are bounded (list_instances / refreshInstances)', function() {
    function extractFn(src, name) {
        var re = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(');
        var mm = re.exec(src);
        if (!mm) throw new Error('function not found: ' + name);
        var i = src.indexOf('{', mm.index), depth = 0;
        for (var j = i; j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(mm.index, j + 1); }
        }
        throw new Error('unbalanced: ' + name);
    }
    var FNS = ['snTimeoutMs', 'snWithTimeout', 'snFetchWithTimeout', 'snProbeTabTokenUser', 'snFetchUserName', 'snFetchUserRoles',
        'snCollectTabTokens', 'snResolveInstanceSession', 'snRememberInstanceToken', 'snUpdateInstanceTokens', 'snGetInstancesDetailed', 'probeTab'];
    async function build(w) {
        var src = await loadFile('src/platform/extension/background.js');
        var chrome = {
            scripting: { executeScript: function() { return w.hangTab ? NEVER() : Promise.resolve([{ result: { token: 'tok', userName: '' } }]); } },
            storage: { local: { get: function(k, cb) { setTimeout(function() { cb({ instanceTokens: w.cache || {} }); }, 0); }, set: function() {} } }
        };
        var fetch = function() { return NEVER(); };   // ignores the abort signal on purpose
        var getSnTabList = async function() { return (w.tabs || []).map(function(id) { return { id: id, origin: 'https://dev1.service-now.com', url: 'https://dev1.service-now.com/', title: 't' }; }); };
        var body = 'var _snInstanceTokensQueue = Promise.resolve();\n' + FNS.map(function(n) { return extractFn(src, n); }).join('\n') +
            '\nreturn { detailed: snGetInstancesDetailed, probeTab: probeTab };';
        return new Function('chrome', 'fetch', 'getSnTabList', 'self', body)(chrome, fetch, getSnTabList, { __snTimeouts: { tab: 150, fetch: 150 } });
    }

    test('a frozen tab (executeScript never settles) cannot hang the detailed probe', async function() {
        var a = await build({ hangTab: true, tabs: [1, 2] });
        var t0 = Date.now();
        var d = await a.detailed();
        assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + 'ms');
        assert.strictEqual(d.length, 1);
        assert.strictEqual(d[0].token, '');
        assert.strictEqual(await a.probeTab(1), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('a hung instance REST call (fetch never settles) cannot hang the detailed probe', async function() {
        var a = await build({ tabs: [1] });
        var t0 = Date.now();
        var d = await a.detailed();
        assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + 'ms');
        assert.strictEqual(d[0].token, 'tok', 'network timeout is indeterminate: token kept');
        assert.strictEqual(d[0].sessionOk, false);
    }, { tags: ['unit'], timeout: 5000 });
});
