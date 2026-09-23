// B2c-1 — SW boot-time permission-map wipe.
// Before the fix, a panel 'permissions-update' DELTA that landed while the SW's
// boot-time loadToolPermissionsInWorker (worker/020-page-stubs.js) was still
// awaiting its getSetting reads was merged onto the empty boot maps, persisted
// as a 1-key map, rebroadcast, and — via the _swPermsDirty flag — made the late
// load SKIP the stored map: every stored Always-allow / disabled entry and
// per-host override was lost. The handler (worker/130-port-bridge.js) now
// queues updates behind self._swPermsLoadP (worker/190-entry.js).
// Message shape mirrors app/045-agent-port-bridge-page.js pushPermissionsToOffscreen.
describe('B2c-1 permission boot race (worker/130 permissions-update vs worker/020 load)', function() {
    function flush(n) {
        var p = Promise.resolve();
        for (var i = 0; i < (n || 5); i++) p = p.then(function() { return new Promise(function(r) { setTimeout(r, 0); }); });
        return p;
    }
    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    async function fixture() {
        var win = fakeWindow();
        var rel = {}, rej = {}, reads = [], sets = [], posted = [];
        var g = {
            window: win,
            chrome: fakeChrome({ alarms: { onAlarm: { addListener: function() {} }, create: function() {}, clear: function() {} } }),
            toolPermissions: {}, instancePermissions: {}, sessionPermissions: {},
            getSetting: function(k) { reads.push(k); return new Promise(function(r, j) { rel[k] = r; rej[k] = j; }); },
            setSetting: async function(k, v) { sets.push([k, clone(v)]); },
            persistSessionPermissionsInWorker: function() {}
        };
        var m = await loadModules(['src/js/worker/020-page-stubs.js', 'src/js/worker/130-port-bridge.js'], { lenient: true, globals: g });
        var port = { name: 'agent-bus', postMessage: function(x) { posted.push(clone(x)); } };
        m.__scope._swPanelPorts.add(port);
        return { m: m, s: m.__scope, win: win, rel: rel, rej: rej, reads: reads, sets: sets, posted: posted, port: port };
    }
    function msg(extra) {
        return Object.assign({ type: 'permissions-update', toolPermissions: null, instancePermissions: null, sessionPermissions: null }, extra);
    }
    // Resolve both boot reads in order (the loader awaits them sequentially).
    async function resolveReads(f, tp, ip) {
        await flush(1);
        f.rel.toolPermissions(tp);
        await flush(2);
        f.rel.instancePermissions(ip);
        await flush(6);
    }

    test('a delta dispatched during the boot load MERGES onto the stored maps (persist + rebroadcast carry the merged maps)', async function() {
        var f = await fixture();
        var load = f.m.loadToolPermissionsInWorker();
        f.win._swPermsLoadP = load;   // what worker/190-entry.js publishes (safe()-wrapped there)
        f.m._handlePanelMessage(f.port, msg({
            toolPermissionsDelta: { set: { c: 'allow' }, del: ['b'] },
            instancePermissionsDelta: { set: { h2: { tier: 'manual' } } }
        }));
        await flush(2);
        assert.deepStrictEqual(f.s.toolPermissions, {}, 'not applied onto the empty boot map');
        assert.strictEqual(f.sets.length, 0, 'nothing persisted before the load settles');
        await resolveReads(f, { a: 'allow', b: 'disabled' }, { h1: { tier: 'auto' } });
        await load;
        await flush(4);
        assert.deepStrictEqual(f.s.toolPermissions, { a: 'allow', c: 'allow' });
        assert.deepStrictEqual(f.s.instancePermissions, { h1: { tier: 'auto' }, h2: { tier: 'manual' } });
        var persistedTp = f.sets.filter(function(x) { return x[0] === 'toolPermissions'; });
        var persistedIp = f.sets.filter(function(x) { return x[0] === 'instancePermissions'; });
        assert.deepStrictEqual(persistedTp.map(function(x) { return x[1]; }), [{ a: 'allow', c: 'allow' }], 'persisted merged tool map');
        assert.deepStrictEqual(persistedIp.map(function(x) { return x[1]; }), [{ h1: { tier: 'auto' }, h2: { tier: 'manual' } }], 'persisted merged instance map');
        assert.strictEqual(f.posted.length, 1);
        assert.strictEqual(f.posted[0].type, 'permissions-changed');
        assert.deepStrictEqual(f.posted[0].toolPermissions, { a: 'allow', c: 'allow' });
        assert.deepStrictEqual(f.posted[0].instancePermissions, { h1: { tier: 'auto' }, h2: { tier: 'manual' } });
        assert.strictEqual(f.s._swPermsDirty.toolPermissions, true, 'dirty flag still raised by the apply');
    }, { tags: ['unit'], timeout: 20000 });

    test('queued updates apply in arrival order; afterwards updates apply synchronously again', async function() {
        var f = await fixture();
        var load = f.m.loadToolPermissionsInWorker();
        f.win._swPermsLoadP = load;
        f.m._handlePanelMessage(f.port, msg({ toolPermissionsDelta: { set: { c: 'allow' } } }));
        f.m._handlePanelMessage(f.port, msg({ toolPermissionsDelta: { set: { c: 'disabled', d: 'allow' }, del: ['a'] } }));
        await resolveReads(f, { a: 'allow', b: 'disabled' }, {});
        await load; await flush(4);
        assert.deepStrictEqual(f.s.toolPermissions, { b: 'disabled', c: 'disabled', d: 'allow' });
        assert.strictEqual(f.posted.length, 2, 'one rebroadcast per update');
        assert.deepStrictEqual(f.posted[0].toolPermissions, { a: 'allow', b: 'disabled', c: 'allow' }, 'first update applied first');
        // Load settled + queue drained → fast (synchronous) path, as before the fix.
        f.m._handlePanelMessage(f.port, msg({ toolPermissionsDelta: { set: { e: 'allow' } } }));
        assert.strictEqual(f.s.toolPermissions.e, 'allow', 'applied synchronously post-boot');
        assert.strictEqual(f.posted.length, 3);
    }, { tags: ['unit'], timeout: 20000 });

    test('a FULL map during boot still replaces (applied after the load, full map wins)', async function() {
        var f = await fixture();
        var load = f.m.loadToolPermissionsInWorker();
        f.win._swPermsLoadP = load;
        f.m._handlePanelMessage(f.port, msg({ toolPermissions: { x: 'allow' } }));
        await resolveReads(f, { a: 'allow', b: 'disabled' }, { h1: { tier: 'auto' } });
        await load; await flush(4);
        assert.deepStrictEqual(f.s.toolPermissions, { x: 'allow' }, 'full-map replace semantics unchanged');
        assert.deepStrictEqual(f.s.instancePermissions, { h1: { tier: 'auto' } }, 'untouched slot keeps the stored map');
        assert.deepStrictEqual(f.sets, [['toolPermissions', { x: 'allow' }]]);
        assert.deepStrictEqual(f.posted[0].toolPermissions, { x: 'allow' });
        assert.strictEqual(f.posted[0].instancePermissions, undefined, 'only changed slots rebroadcast');
    }, { tags: ['unit'], timeout: 20000 });

    test('a rejected load promise never wedges the chain; no published promise → legacy synchronous apply', async function() {
        var f = await fixture();
        var rp = Promise.reject(new Error('idb wedged')); rp.catch(function() {});
        f.win._swPermsLoadP = rp;
        f.m._handlePanelMessage(f.port, msg({ toolPermissionsDelta: { set: { a: 'allow' } } }));
        f.m._handlePanelMessage(f.port, msg({ toolPermissionsDelta: { set: { b: 'allow' } } }));
        await flush(6);
        assert.deepStrictEqual(f.s.toolPermissions, { a: 'allow', b: 'allow' }, 'both edits applied despite the rejection');
        var g = await fixture();
        g.m._handlePanelMessage(g.port, msg({ toolPermissionsDelta: { set: { z: 'allow' } } }));
        assert.deepStrictEqual(g.s.toolPermissions, { z: 'allow' }, 'no self._swPermsLoadP → synchronous');
    }, { tags: ['unit'], timeout: 20000 });

    test('degraded: load TIMEOUT (safe() → null) then a delta — no destructive save; the late read merges under memory', async function() {
        var f = await fixture();
        var load = f.m.loadToolPermissionsInWorker();   // real reads stay in flight
        f.win._swPermsLoadP = Promise.resolve(null);      // what safe() yields at the 20s deadline
        f.m._handlePanelMessage(f.port, msg({ toolPermissionsDelta: { set: { a: 'disabled', c: 'allow' }, del: ['b'] } }));
        await flush(4);
        assert.deepStrictEqual(f.s.toolPermissions, { a: 'disabled', c: 'allow' }, 'delta applied in memory');
        assert.strictEqual(f.sets.length, 0, 'no setSetting of the partial map');
        assert.strictEqual(f.posted.length, 0, 'partial map not rebroadcast');
        assert.strictEqual(f.s._swPermsDirty.toolPermissionsDelta, true);
        assert.strictEqual(f.s._swPermsDirty.toolPermissions, undefined, 'replace flag NOT raised (it would skip the stored map)');
        assert.deepStrictEqual(f.s._swPermsDirty.toolPermissionsDeleted, { b: true });
        assert.deepStrictEqual(f.reads, ['toolPermissions'], 're-read deduped against the in-flight loader read');
        // Late read lands: stored merged UNDER memory, deletion honoured.
        await resolveReads(f, { a: 'allow', b: 'disabled', d: 'ask' }, { h1: { tier: 'auto' } });
        await load; await flush(4);
        assert.deepStrictEqual(f.s.toolPermissions, { a: 'disabled', c: 'allow', d: 'ask' }, 'memory wins, b stays deleted, d restored');
        assert.deepStrictEqual(f.s.instancePermissions, { h1: { tier: 'auto' } }, 'untouched slot hydrated normally');
        assert.deepStrictEqual(f.sets, [['toolPermissions', { a: 'disabled', c: 'allow', d: 'ask' }]], 'one save of the merged map');
        assert.strictEqual(f.posted.length, 1);
        assert.deepStrictEqual(f.posted[0], { type: 'permissions-changed', toolPermissions: { a: 'disabled', c: 'allow', d: 'ask' } });
        assert.strictEqual(f.s._swPermsDirty.toolPermissionsDelta, undefined, 'delta flag cleared after merge');
        assert.strictEqual(f.win._swPermsLoaded.toolPermissions, true);
        // Hydrated now → a later delta persists synchronously again.
        f.m._handlePanelMessage(f.port, msg({ toolPermissionsDelta: { set: { e: 'allow' } } }));
        await flush(2);
        assert.deepStrictEqual(f.sets[1], ['toolPermissions', { a: 'disabled', c: 'allow', d: 'ask', e: 'allow' }]);
    }, { tags: ['unit'], timeout: 20000 });

    test('degraded: a FULL map after a timeout still replaces + saves; the late read is skipped', async function() {
        var f = await fixture();
        var load = f.m.loadToolPermissionsInWorker();
        f.win._swPermsLoadP = Promise.resolve(null);
        f.m._handlePanelMessage(f.port, msg({ toolPermissions: { x: 'allow' } }));
        await flush(4);
        assert.deepStrictEqual(f.sets, [['toolPermissions', { x: 'allow' }]], 'full map persisted immediately');
        await resolveReads(f, { a: 'allow' }, {});
        await load; await flush(4);
        assert.deepStrictEqual(f.s.toolPermissions, { x: 'allow' }, 'stale stored map skipped');
        assert.strictEqual(f.sets.length, 1);
    }, { tags: ['unit'], timeout: 20000 });

    test('degraded: a REJECTED getSetting leaves the slot unhydrated — delta kept in memory, re-read merges + saves', async function() {
        var f = await fixture();
        var load = f.m.loadToolPermissionsInWorker();
        f.win._swPermsLoadP = load;
        await flush(1);
        f.rej.toolPermissions(new Error('idb read failed'));
        await flush(2);
        f.rel.instancePermissions({ h1: { tier: 'auto' } });
        var st = await load;
        assert.deepStrictEqual(st, { toolPermissions: false, instancePermissions: true }, 'per-slot success reported');
        f.m._handlePanelMessage(f.port, msg({
            toolPermissionsDelta: { set: { c: 'allow' }, del: ['b'] },
            instancePermissionsDelta: { set: { h2: { tier: 'manual' } } }
        }));
        await flush(4);
        assert.deepStrictEqual(f.s.toolPermissions, { c: 'allow' });
        assert.deepStrictEqual(f.sets, [['instancePermissions', { h1: { tier: 'auto' }, h2: { tier: 'manual' } }]], 'hydrated slot saved; unhydrated slot NOT saved');
        assert.strictEqual(f.posted.length, 1);
        assert.strictEqual(f.posted[0].toolPermissions, undefined, 'partial tool map not rebroadcast');
        assert.deepStrictEqual(f.reads, ['toolPermissions', 'instancePermissions', 'toolPermissions'], 're-read kicked off for the failed slot');
        f.rel.toolPermissions({ a: 'allow', b: 'disabled' });
        await flush(4);
        assert.deepStrictEqual(f.s.toolPermissions, { a: 'allow', c: 'allow' });
        assert.deepStrictEqual(f.sets[1], ['toolPermissions', { a: 'allow', c: 'allow' }], 'merged map persisted');
        assert.deepStrictEqual(f.posted[1], { type: 'permissions-changed', toolPermissions: { a: 'allow', c: 'allow' } });
    }, { tags: ['unit'], timeout: 20000 });

    test('wiring: 190-entry publishes the safe()-bounded load promise and the boot gate awaits it', async function() {
        var src = await loadFile('src/js/worker/190-entry.js');
        assert.match(src, /self\._swPermsLoadP = safe\(loadPerms, 'toolPermissions'\);/);
        var gate = src.indexOf('Promise.all([');
        var pub = src.indexOf('self._swPermsLoadP = safe(');
        assert.ok(pub > 0 && gate > pub, 'published before the boot gate');
        assert.ok(src.indexOf('self._swPermsLoadP,', gate) > gate, 'boot gate awaits the same promise');
        var bridge = await loadFile('src/js/worker/130-port-bridge.js');
        var c = bridge.indexOf("case 'permissions-update':");
        var next = bridge.indexOf("case 'chat-meta-update':", c);
        assert.ok(c > 0 && next > c && bridge.slice(c, next).indexOf('_swQueuePermissionsUpdate(msg);') > 0, 'case routes through the queue');
    }, { tags: ['unit'], timeout: 5000 });
});
