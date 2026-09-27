// Reload pre-restart crash ("Aw, Snap!" code 5): every workspace write of the in-app Reload's
// build emits workspaceMutated (twice in the origin tab: locally + the SW rebroadcast), and the
// header listener (app/036) ran ui/040 updateWorkspaceHeaderStatus once per event with no guard.
// Each call walks every clone's full file contents (getAllWorkspaceSummaries), so the 17 parallel
// dist writes stacked up to 34 overlapping full walks and exhausted the renderer heap.
// updateWorkspaceHeaderStatus now coalesces: at most ONE local scan runs per page, and calls that
// arrive while it runs share ONE trailing scan that starts after them (freshness contract for the
// awaiting callers). This loads the REAL ui/040 and drives the real scan through its first awaited
// dependency getAllWorkspaceMetas (one deferred per scan). Function declarations inside
// loadModules' with(__scope){} block cannot be replaced through __scope; module vars can.
// Run: run_tests { files: ['test/workspace-header-status-coalesce.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var KEY = 'o/r::main';

function wshcDeferred() {
    var d = {};
    d.promise = new Promise(function(resolve, reject) { d.resolve = resolve; d.reject = reject; });
    return d;
}

async function wshcTicks(n) { for (var i = 0; i < (n || 200); i++) await Promise.resolve(); }

async function wshcSetup(opts) {
    opts = opts || {};
    var m = null;
    var h = { seq: 0, version: 0, dirty: 3, fail: !!opts.fail, scans: [], calls: [], active: 0, maxActive: 0 };
    function badge() { return { style: { display: '' }, className: '', innerHTML: '' }; }
    h.badges = { 'ws-header-status': badge(), 'home-ws-header-status': badge() };
    var doc = {
        addEventListener: function() {}, removeEventListener: function() {},
        getElementById: function(id) {
            // The first badge lookup after a scan settles (success render AND error path) = scan done.
            if (id === 'ws-header-status' && h.active > 0) h.active--;
            return h.badges[id] || null;
        },
        querySelector: function() { return null; },
        querySelectorAll: function() { return []; }
    };
    var win = { document: doc, addEventListener: function() {}, removeEventListener: function() {},
        matchMedia: function() { return { matches: false, addEventListener: function() {} }; } };
    var g = {
        document: doc, window: win, navigator: { userAgent: 'ws-header-coalesce-test' },
        // First awaited dependency of the real getAllWorkspaceSummaries: one call = one scan started.
        getAllWorkspaceMetas: function() {
            var s = { id: h.scans.length + 1, startSeq: ++h.seq, d: wshcDeferred(), version: h.version,
                session: m ? m.__scope._wsRefreshSession : undefined, settled: false };
            h.scans.push(s);
            h.active++;
            if (h.active > h.maxActive) h.maxActive = h.active;
            return s.d.promise;
        },
        getAllWorkspaceFiles: function() {
            var files = [];
            for (var i = 0; i < h.dirty; i++) files.push({ path: 'src/f' + i + '.js', dirty: true });
            files.push({ path: 'src/clean.js', dirty: false });
            files.push({ path: 'dist/x.js', dirty: true }); // gitignored build output: never counted
            return Promise.resolve(files);
        },
        wsGetIgnoreFilterLocal: function() { return Promise.resolve(function(p) { return /^dist\//.test(p); }); }
    };
    m = await loadModules(['src/js/ui/040-tools-settings.js'], { workspace: WS, globals: g, lenient: true });
    assert.strictEqual(typeof m.updateWorkspaceHeaderStatus, 'function', 'real updateWorkspaceHeaderStatus loaded');
    h.m = m;
    // One workspaceMutated-driven refresh: the write bumps the data version, then the event fires.
    h.call = function() {
        h.version++;
        var rec = { callSeq: ++h.seq, settled: false, value: 'unset', error: null, seenScan: null };
        h.calls.push(rec);
        var p = m.updateWorkspaceHeaderStatus();
        p.then(function(v) {
            rec.settled = true; rec.value = v;
            var c = m.__scope._wsHeaderCaches[KEY];
            rec.seenScan = c ? c.meta.scanId : null;
        }, function(e) { rec.settled = true; rec.error = e; });
        return p;
    };
    h.settleOldest = async function() {
        var s = h.scans.filter(function(x) { return !x.settled; })[0];
        if (!s) return false;
        s.settled = true;
        if (h.fail) s.d.reject(new Error('simulated IndexedDB failure'));
        else s.d.resolve([{ repo: KEY, github_repo: 'o/r', branch: 'main', scanId: s.id, version: s.version }]);
        await wshcTicks(200);
        return true;
    };
    h.drain = async function() {
        for (var i = 0; i < 100; i++) { if (!(await h.settleOldest())) return; }
        throw new Error('drain: scans never converged (' + h.scans.length + ' started)');
    };
    return h;
}

function wshcAssertFresh(h) {
    h.calls.forEach(function(c, i) {
        assert.ok(c.settled, 'call ' + i + ' settled');
        assert.strictEqual(c.error, null, 'call ' + i + ' did not reject');
        assert.strictEqual(c.value, undefined, 'call ' + i + ' resolved to undefined');
        var s = h.scans[c.seenScan - 1];
        assert.ok(s, 'call ' + i + ' read a scan result (seenScan=' + c.seenScan + ')');
        assert.ok(s.startSeq > c.callSeq, 'call ' + i + ' (seq ' + c.callSeq + ') settled on scan #' + s.id +
            ' which started at seq ' + s.startSeq + ' - before the call');
    });
}

describe('workspace header status › coalesced local scans (Reload pre-restart OOM root cause)', function() {
    test('a burst of 34 refreshes runs at most ONE full local scan at a time (<= 2 scans total)', async function() {
        var h = await wshcSetup();
        for (var i = 0; i < 34; i++) h.call();
        await wshcTicks(50);
        await h.drain();
        assert.strictEqual(h.maxActive, 1, 'overlapping full scans: maxActive=' + h.maxActive + ' scans=' + h.scans.length);
        assert.ok(h.scans.length <= 2, 'total full scans: ' + h.scans.length);
        assert.ok(h.calls.every(function(c) { return c.settled; }), 'every call settled');
    }, { tags: ['unit'] });

    test('every caller settles only after a scan that STARTED after its call, and the final state is fresh', async function() {
        var h = await wshcSetup();
        for (var i = 0; i < 34; i++) h.call();
        await h.drain();
        wshcAssertFresh(h);
        var c = h.m.__scope._wsHeaderCaches[KEY];
        assert.ok(c, 'cache entry present');
        assert.strictEqual(c.meta.version, 34, 'final cache comes from a scan that started after the last write');
        assert.strictEqual(c.dirtyCount, 3, 'dirty count excludes the gitignored dist/ file');
        ['ws-header-status', 'home-ws-header-status'].forEach(function(id) {
            assert.match(h.badges[id].innerHTML, /3 modified/, id + ' badge text');
            assert.strictEqual(h.badges[id].style.display, '', id + ' badge visible');
        });
    }, { tags: ['unit'] });

    test('a failing scan hides both badges, resolves every call to undefined and releases the slot', async function() {
        var h = await wshcSetup({ fail: true });
        for (var i = 0; i < 10; i++) h.call();
        await h.drain();
        h.calls.forEach(function(c, k) {
            assert.ok(c.settled && c.error === null && c.value === undefined, 'call ' + k + ' resolved to undefined');
        });
        assert.strictEqual(h.badges['ws-header-status'].style.display, 'none');
        assert.strictEqual(h.badges['home-ws-header-status'].style.display, 'none');
        var before = h.scans.length;
        h.fail = false;
        h.call();
        await wshcTicks(50);
        assert.strictEqual(h.scans.length, before + 1, 'the next call starts a new scan right away (slot released)');
        await h.drain();
        var last = h.calls[h.calls.length - 1];
        assert.ok(last.settled && last.error === null, 'recovery call settled');
        assert.match(h.badges['ws-header-status'].innerHTML, /3 modified/, 'badge repainted after recovery');
        assert.strictEqual(h.badges['ws-header-status'].style.display, '', 'badge visible after recovery');
    }, { tags: ['unit'] });

    test('each scan reads _wsRefreshSession when it STARTS (a session opened after the call is honoured)', async function() {
        var h = await wshcSetup();
        for (var i = 0; i < 34; i++) h.call();
        await wshcTicks(50);
        h.m.__scope._wsRefreshSession = { deleted: { 'o/r::main': true }, covered: {}, jobs: {}, showRefreshing: false, participants: 1 };
        await h.drain();
        var last = h.scans[h.scans.length - 1];
        var expectPresent = !(last.session && last.session.deleted && last.session.deleted[KEY]);
        assert.strictEqual(KEY in h.m.__scope._wsHeaderCaches, expectPresent,
            'final cache presence follows the session read by the last scan (session ' + (last.session ? 'set' : 'null') + ')');
    }, { tags: ['unit'] });

    test('a second wave arriving during the trailing scan still settles on a scan that started after it', async function() {
        var h = await wshcSetup();
        for (var i = 0; i < 5; i++) h.call();
        await wshcTicks(50);
        await h.settleOldest(); // the first scan is done; with coalescing the trailing scan is now running
        for (var j = 0; j < 5; j++) h.call();
        await h.drain();
        wshcAssertFresh(h);
        assert.strictEqual(h.m.__scope._wsHeaderCaches[KEY].meta.version, 10, 'final cache reflects the second wave');
    }, { tags: ['unit'] });
});
