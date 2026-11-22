// Header instance pill picker (platform-bridge.js): an instance whose tab has
// not been seen for _INSTANCE_TAB_STALE_MS (14 days) is hidden from the picker
// until a tab is open again. Real source functions, fake chrome/Platform.
var EX = await runFile('test/extract.js', { i18n: false });

var DAY = 24 * 60 * 60 * 1000;

async function loadPicker(opts) {
    opts = opts || {};
    var src = await loadFile('src/platform/extension/platform-bridge.js');
    function constLine(name) {
        var m = src.match(new RegExp('var ' + name + ' = [^;]+;'));
        if (!m) throw new Error('constant ' + name + ' not found');
        return m[0];
    }
    var fns = EX.extractFunctions(src, [
        '_normUrl', '_isRecentlyRemoved', '_isStaleTablessInstance', '_hideStaleTablessInstances',
        '_cacheInstances', '_persistInstancesCache', '_withRetainedInstances', '_seedRenderList', '_orderInstances',
        '_retireStaleActiveInstance', '_hydrateInstancesCache', '_deadUrl', '_markDead'
    ]);
    var body = [
        'var _instancesCache = null;',
        constLine('_INSTANCES_CACHE_KEY'),
        constLine('_INSTANCE_RETENTION_MS'),
        constLine('_INSTANCE_TAB_STALE_MS'),
        'var _recentlyRemoved = {};',
        'var _staleActiveRetiringFor = \'\';',
        constLine('_REMOVED_TOMBSTONE_MS'),
        fns,
        'return {',
        '  STALE: _INSTANCE_TAB_STALE_MS,',
        '  get cache() { return _instancesCache; }, set cache(v) { _instancesCache = v; },',
        '  isStale: _isStaleTablessInstance, hide: _hideStaleTablessInstances,',
        '  cacheInstances: _cacheInstances, withRetained: _withRetainedInstances, seed: _seedRenderList,',
        '  retire: _retireStaleActiveInstance, hydrate: _hydrateInstancesCache',
        '};'
    ].join('\n');
    var stored = {};
    var sent = [];
    var statusCalls = { n: 0 };
    var chrome = {
        storage: { local: { set: function(o) { Object.assign(stored, o); } } },
        runtime: {
            lastError: null,
            // Fake background switch-sn-instance: answer async like the real one.
            sendMessage: function(msg, cb) {
                sent.push(msg);
                setTimeout(function() { cb({ success: true, token: msg.instanceUrl ? 'tok-' + msg.tabId : '' }); }, 0);
            }
        }
    };
    var Platform = { instanceUrl: opts.activeUrl === undefined ? 'https://active.service-now.com' : opts.activeUrl, instances: [] };
    var win = { sessionToken: 'old-token' };
    var m = new Function('chrome', 'Platform', 'updateSnStatus', 'window', body)(chrome, Platform, function() { statusCalls.n++; }, win);
    m.stored = stored;
    m.sent = sent;
    m.Platform = Platform;
    m.win = win;
    m.statusCalls = statusCalls;
    return m;
}

function urls(list) { return list.map(function(i) { return i.url; }).sort(); }

describe('instance picker hides instances without an open tab for 14 days', function() {
    test('threshold is a single 14-day named constant', async function() {
        var m = await loadPicker();
        assert.strictEqual(m.STALE, 14 * DAY);
    }, { tags: ['unit'], timeout: 3000 });

    test('stale tab-less hidden (active NOT exempt); open tab, fresh and legacy shown', async function() {
        var m = await loadPicker();
        var now = Date.now();
        var old = now - 15 * DAY;
        m.cache = [
            { url: 'https://stale.service-now.com', tabs: [], tabLastSeen: old },
            { url: 'https://reopened.service-now.com', tabs: [], tabLastSeen: old },
            { url: 'https://fresh.service-now.com', tabs: [], tabLastSeen: now - 13 * DAY },
            { url: 'https://active.service-now.com', tabs: [], tabLastSeen: old },
            { url: 'https://legacy.service-now.com', tabs: [] }
        ];
        var list = [
            { url: 'https://stale.service-now.com', tabs: [] },
            { url: 'https://reopened.service-now.com', tabs: [{ id: 7 }] },
            { url: 'https://fresh.service-now.com', tabs: [] },
            { url: 'https://active.service-now.com', tabs: [] },
            { url: 'https://legacy.service-now.com', tabs: [] }
        ];
        assert.deepStrictEqual(urls(m.hide(list)), [
            'https://fresh.service-now.com',
            'https://legacy.service-now.com', 'https://reopened.service-now.com'
        ], 'stale active instance is hidden too');
        assert.strictEqual(m.isStale({ url: 'https://x', tabs: [] }, now - 14 * DAY - 1, now), true);
        assert.strictEqual(m.isStale({ url: 'https://x', tabs: [] }, now - 14 * DAY + 1000, now), false);
        assert.strictEqual(m.isStale({ url: 'https://x', tabs: [{ id: 1 }] }, 1, now), false, 'open tab never hidden');
        assert.strictEqual(m.isStale({ url: 'https://x', tabs: [] }, 0, now), false, 'no stamp never hidden');
    }, { tags: ['unit'], timeout: 3000 });

    test('_cacheInstances stamps legacy, refreshes on open tab, keeps stamp when tab-less, never deletes', async function() {
        var m = await loadPicker({ activeUrl: '' });
        var now = Date.now();
        var old = now - 20 * DAY;
        m.cache = [
            { url: 'https://legacy.service-now.com', tabs: [], lastSeen: now - 1000 },
            { url: 'https://tokenonly.service-now.com', tabs: [], lastSeen: now - 1000, tabLastSeen: old },
            { url: 'https://back.service-now.com', tabs: [], lastSeen: now - 1000, tabLastSeen: old }
        ];
        // Live probe: token-only instance still connected with zero tabs; "back" has a tab again.
        m.cacheInstances([
            { url: 'https://tokenonly.service-now.com', tabs: [], token: 't1' },
            { url: 'https://back.service-now.com/', tabs: [{ id: 3 }], token: 't2' }
        ]);
        var byUrl = {};
        m.cache.forEach(function(c) { byUrl[c.url] = c; });
        assert.strictEqual(byUrl['https://legacy.service-now.com'].tabLastSeen, 0, 'legacy entry: no tab evidence -> stamp 0 (not now)');
        assert.strictEqual(byUrl['https://legacy.service-now.com'].tabSeenProvisional, true, 'legacy entry provisional');
        assert.strictEqual(byUrl['https://tokenonly.service-now.com'].tabLastSeen, old, 'tab-less probe keeps old stamp');
        assert.ok(byUrl['https://back.service-now.com'].tabLastSeen >= now, 'open tab refreshes stamp');
        assert.strictEqual(m.cache.length, 3, 'nothing deleted');
        assert.strictEqual(m.stored.snInstancesCache.length, 3, 'persisted, incl. hidden entry');

        // Render list after that probe: token-only (stale, no tab) hidden, others shown.
        var render = m.withRetained([
            { url: 'https://tokenonly.service-now.com', tabs: [], token: 't1' },
            { url: 'https://back.service-now.com', tabs: [{ id: 3 }], token: 't2' }
        ]);
        assert.deepStrictEqual(urls(render), ['https://back.service-now.com', 'https://legacy.service-now.com']);
        // Instant-open seed path applies the same rule.
        assert.deepStrictEqual(urls(m.seed(m.cache)), ['https://back.service-now.com', 'https://legacy.service-now.com']);

        // Tab reopened -> reappears and stamp refreshes.
        m.cacheInstances([{ url: 'https://tokenonly.service-now.com', tabs: [{ id: 9 }], token: 't1' }]);
        var again = m.withRetained([{ url: 'https://tokenonly.service-now.com', tabs: [{ id: 9 }], token: 't1' }]);
        assert.ok(urls(again).indexOf('https://tokenonly.service-now.com') !== -1, 'reappears with open tab');
        // ...and stays visible after the tab closes again (fresh stamp).
        m.cacheInstances([{ url: 'https://tokenonly.service-now.com', tabs: [], token: 't1' }]);
        var closed = m.withRetained([{ url: 'https://tokenonly.service-now.com', tabs: [], token: 't1' }]);
        assert.ok(urls(closed).indexOf('https://tokenonly.service-now.com') !== -1, 'fresh stamp keeps it visible');
    }, { tags: ['unit'], timeout: 3000 });
});

function tick() { return new Promise(function(r) { setTimeout(r, 5); }); }

describe('stale ACTIVE instance leaves the header pill', function() {
    test('stale active + another instance with a tab -> switch message sent, stale one hidden', async function() {
        var m = await loadPicker();
        var old = Date.now() - 15 * DAY;
        m.cache = [{ url: 'https://active.service-now.com', tabs: [], lastSeen: Date.now(), tabLastSeen: old }];
        var probe = [
            { url: 'https://active.service-now.com', tabs: [], token: 'hb' },
            { url: 'https://zeta.service-now.com', tabs: [{ id: 22 }], token: 'z' },
            { url: 'https://beta.service-now.com', tabs: [{ id: 11 }], token: 'b' }
        ];
        m.cacheInstances(probe);
        assert.strictEqual(m.retire(), true);
        assert.strictEqual(m.retire(), false, 'no duplicate message while in flight');
        assert.strictEqual(m.sent.length, 1);
        assert.deepStrictEqual(m.sent[0], { type: 'switch-sn-instance', instanceUrl: 'https://beta.service-now.com', tabId: 11 });
        await tick();
        assert.strictEqual(m.Platform.instanceUrl, 'https://beta.service-now.com');
        assert.strictEqual(m.win.sessionToken, 'tok-11');
        assert.ok(m.statusCalls.n >= 1, 'pill re-rendered');
        assert.ok(urls(m.withRetained(probe)).indexOf('https://active.service-now.com') === -1, 'stale former active hidden');
        // New active has a tab -> no further switching (no loop).
        assert.strictEqual(m.retire(), false);
        assert.strictEqual(m.sent.length, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('stale active + no tabs anywhere -> active cleared (Not connected)', async function() {
        var m = await loadPicker();
        var old = Date.now() - 15 * DAY;
        m.cache = [
            { url: 'https://active.service-now.com', tabs: [], lastSeen: Date.now(), tabLastSeen: old },
            { url: 'https://other.service-now.com', tabs: [], lastSeen: Date.now(), tabLastSeen: Date.now() - DAY }
        ];
        m.cacheInstances([{ url: 'https://active.service-now.com', tabs: [], token: 'hb' }, { url: 'https://other.service-now.com', tabs: [], token: 'o' }]);
        assert.strictEqual(m.retire(), true);
        assert.deepStrictEqual(m.sent[0], { type: 'switch-sn-instance', instanceUrl: '', tabId: null }, 'empty instanceUrl = clear via snSetActiveInstance');
        await tick();
        assert.strictEqual(m.Platform.instanceUrl, '', 'pill shows Not connected');
        assert.strictEqual(m.win.sessionToken, '');
        assert.strictEqual(m.retire(), false, 'nothing active -> no further messages');
        assert.strictEqual(m.sent.length, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('fresh / tabbed active is left alone; unknown tab-less tokenless active is seeded and retired at once', async function() {
        var m = await loadPicker();
        m.cache = [{ url: 'https://active.service-now.com', tabs: [], lastSeen: Date.now(), tabLastSeen: Date.now() - 13 * DAY }];
        assert.strictEqual(m.retire(), false, 'fresh');
        m.cache = [{ url: 'https://active.service-now.com', tabs: [{ id: 1 }], lastSeen: Date.now(), tabLastSeen: Date.now() - 30 * DAY }];
        assert.strictEqual(m.retire(), false, 'has tab');
        m.cache = [{ url: 'https://other.service-now.com', tabs: [], lastSeen: Date.now(), tabLastSeen: 1 }];
        m.cacheInstances([]);
        var seeded = m.cache.filter(function(c) { return c.url === 'https://active.service-now.com'; })[0];
        assert.ok(seeded && seeded.tabSeenProvisional === true && seeded.tabLastSeen === 0, 'unknown active seeded provisional with stamp 0');
        assert.strictEqual(m.retire(), true, 'no tab evidence, no token -> retired immediately');
        assert.strictEqual(m.sent.length, 1);
        assert.deepStrictEqual(m.sent[0], { type: 'switch-sn-instance', instanceUrl: '', tabId: null });
    }, { tags: ['unit'], timeout: 3000 });

    test('signed-out active (missing from probe, lastSeen 2d, tabLastSeen 15d) stays cached and is retired', async function() {
        var m = await loadPicker();
        m.cache = [{ url: 'https://active.service-now.com', tabs: [], lastSeen: Date.now() - 2 * DAY, tabLastSeen: Date.now() - 15 * DAY }];
        m.cacheInstances([{ url: 'https://b.service-now.com', tabs: [{ id: 8 }], token: 'b' }]);
        var a = m.cache.filter(function(c) { return c.url === 'https://active.service-now.com'; })[0];
        assert.ok(a, 'active not evicted by the 1-day retention');
        assert.strictEqual(m.stored.snInstancesCache.length, 2);
        assert.strictEqual(urls(m.withRetained([{ url: 'https://b.service-now.com', tabs: [{ id: 8 }], token: 'b' }])).join(), 'https://b.service-now.com', 'kept-for-aging row not listed');
        assert.strictEqual(m.retire(), true);
        assert.deepStrictEqual(m.sent[0], { type: 'switch-sn-instance', instanceUrl: 'https://b.service-now.com', tabId: 8 });
        await tick();
        assert.strictEqual(m.Platform.instanceUrl, 'https://b.service-now.com');
        // Former active is no longer protected -> normal 1-day eviction resumes.
        m.cacheInstances([{ url: 'https://b.service-now.com', tabs: [{ id: 8 }], token: 'b' }]);
        assert.strictEqual(m.cache.filter(function(c) { return c.url === 'https://active.service-now.com'; }).length, 0);
    }, { tags: ['unit'], timeout: 3000 });

    test('upgrade: active missing from stored cache -> seeded with no tab evidence and retired at once', async function() {
        var m = await loadPicker();
        // Pre-PR stored cache without the (already evicted) active instance.
        m.hydrate([{ url: 'https://other.service-now.com', tabs: [], lastSeen: Date.now() - 1000 }]);
        m.cacheInstances([]);
        var a = m.cache.filter(function(c) { return c.url === 'https://active.service-now.com'; })[0];
        assert.ok(a && a.tabSeenProvisional && a.tabLastSeen === 0, 'seeded, stamp 0');
        assert.strictEqual(m.retire(), true, 'tab-less + tokenless seed retired immediately');
        assert.deepStrictEqual(m.sent[0], { type: 'switch-sn-instance', instanceUrl: '', tabId: null });
        await tick();
        assert.strictEqual(m.Platform.instanceUrl, '');
        // A genuine stored stamp arriving later still wins over the provisional seed.
        var m3 = await loadPicker();
        m3.cacheInstances([]);
        m3.hydrate([{ url: 'https://active.service-now.com', tabs: [], lastSeen: Date.now() - 2 * DAY, tabLastSeen: Date.now() - 20 * DAY }]);
        assert.strictEqual(m3.sent.length, 1, 'stored stamp wins -> retired (cleared, no tabs)');
        assert.strictEqual(m3.sent[0].instanceUrl, '');
    }, { tags: ['unit'], timeout: 3000 });

    test('reopening the tab makes the instance reappear', async function() {
        var m = await loadPicker({ activeUrl: '' });
        var old = Date.now() - 15 * DAY;
        m.cache = [{ url: 'https://active.service-now.com', tabs: [], lastSeen: Date.now(), tabLastSeen: old }];
        assert.strictEqual(urls(m.withRetained([{ url: 'https://active.service-now.com', tabs: [], token: 'hb' }])).length, 0, 'hidden while stale');
        m.cacheInstances([{ url: 'https://active.service-now.com', tabs: [{ id: 5 }], token: 't' }]);
        assert.deepStrictEqual(urls(m.withRetained([{ url: 'https://active.service-now.com', tabs: [{ id: 5 }], token: 't' }])), ['https://active.service-now.com']);
        assert.strictEqual(m.cache[0].tabSeenProvisional, false, 'real stamp');
    }, { tags: ['unit'], timeout: 3000 });

    test('stored old stamp + probe-first startup -> stays stale and active is retired', async function() {
        var m = await loadPicker();
        var old = Date.now() - 20 * DAY;
        // Probe answers before storage hydration: no history -> provisional "now" stamp.
        m.cacheInstances([{ url: 'https://active.service-now.com', tabs: [], token: 'hb' }, { url: 'https://b.service-now.com', tabs: [{ id: 4 }], token: 'b' }]);
        var act = m.cache.filter(function(c) { return c.url === 'https://active.service-now.com'; })[0];
        assert.strictEqual(act.tabSeenProvisional, true);
        assert.strictEqual(m.retire(), false, 'provisional stamp is fresh');
        // Hydration arrives with the genuine stored stamp.
        m.hydrate([{ url: 'https://active.service-now.com', tabs: [], lastSeen: Date.now() - 1000, tabLastSeen: old }]);
        assert.strictEqual(act.tabLastSeen, old, 'genuine stored stamp wins over provisional');
        assert.strictEqual(act.tabSeenProvisional, false);
        assert.strictEqual(m.sent.length, 1, 'hydration re-check retired the stale active');
        assert.strictEqual(m.sent[0].instanceUrl, 'https://b.service-now.com');
        // Persisted with the corrected stamp; a later probe keeps it.
        assert.strictEqual(m.stored.snInstancesCache.filter(function(c) { return c.url === 'https://active.service-now.com'; })[0].tabLastSeen, old);
        m.cacheInstances([{ url: 'https://active.service-now.com', tabs: [], token: 'hb' }]);
        assert.strictEqual(m.cache.filter(function(c) { return c.url === 'https://active.service-now.com'; })[0].tabLastSeen, old);
        // A stored stamp never overrides a probe that saw an open tab.
        var m2 = await loadPicker();
        m2.cacheInstances([{ url: 'https://active.service-now.com', tabs: [{ id: 1 }], token: 't' }]);
        m2.hydrate([{ url: 'https://active.service-now.com', tabs: [], tabLastSeen: old }]);
        assert.ok(m2.cache[0].tabLastSeen > old);
        assert.strictEqual(m2.sent.length, 0);
    }, { tags: ['unit'], timeout: 3000 });
});
