// Real registry; only time and timers are simulated. No production helper overrides.
describe('handle registry behavior', function() {
    var m, timers, now;
    beforeEach(async function() {
        timers = []; now = 1000000;
        m = await loadModules(['src/js/core/095-handle-registry.js'], { globals: {
            self: {}, Date: { now: function() { return now; } },
            setTimeout: function(fn) { timers.push(fn); return timers.length; }
        }});
    });
    function pending(chat) {
        var resolve, reject;
        var work = new Promise(function(a, b) { resolve = a; reject = b; });
        var h = m.Handles.start(chat, 'work', {}, 'Review task', function() { return work; });
        return { h: h, resolve: resolve, reject: reject };
    }
    test('foreign chats cannot read, await, cancel, or error a handle', async function() {
        var p = pending('a'), id = p.h.handleId;
        assert.strictEqual(m.Handles.get('b', id), null);
        assert.deepStrictEqual(m.Handles.list('b'), []);
        assert.strictEqual((await m.Handles.await('b', id)).status, 'unknown');
        assert.strictEqual(m.Handles.cancel('b', id).ok, false);
        assert.strictEqual(m.Handles.errorWith('b', id, 'bad').ok, false);
        assert.strictEqual(m.Handles.pendingCount('a'), 1);
        p.resolve('ok'); await p.h.entry.promise;
        assert.strictEqual(m.Handles.poll('a', id).result, 'ok');
    });
    test('cancellation drains multiple waiters and survives late rejection', async function() {
        var p = pending('a'), id = p.h.handleId;
        m.Handles.markAwaitingApproval('a', id, true);
        assert.strictEqual(m.Handles.poll('a', id).awaitingApproval, true);
        var waits = [m.Handles.await('a', id), m.Handles.await('a', id)];
        m.Handles.cancel('a', id, 'stop');
        var snaps = await Promise.all(waits);
        assert.deepStrictEqual(snaps.map(function(s) { return [s.status, s.awaitingApproval, s.error]; }), [['cancelled', false, 'stop'], ['cancelled', false, 'stop']]);
        p.reject(new Error('late')); await p.h.entry.promise;
        assert.strictEqual(m.Handles.poll('a', id).error, 'stop');
        assert.strictEqual(m.Handles.cancel('a', id).ok, false);
        assert.strictEqual(p.h.entry.awaiters.length, 0);
    });
    test('structured error wins over late successful work and restore cannot clobber it', async function() {
        var p = pending('a'), id = p.h.handleId, payload = { detail: 'failed report' };
        m.Handles.errorWith('a', id, 'failed', payload);
        p.resolve('late'); await p.h.entry.promise;
        assert.strictEqual(m.Handles.restore('a', id, { status: 'done', result: 'replacement' }).existed, true);
        var s = m.Handles.poll('a', id);
        assert.strictEqual(s.status, 'error'); assert.deepStrictEqual(s.result, payload);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(s, 'promise'), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(s, 'awaiters'), false);
    });
    test('awaitAny ignores stale IDs while a real handle can settle', async function() {
        var p = pending('a');
        var race = m.Handles.awaitAny('a', ['stale', p.h.handleId], 100);
        p.resolve(7); await p.h.entry.promise;
        var won = await race;
        assert.strictEqual(won.handle, p.h.handleId); assert.strictEqual(won.snapshot.result, 7);
        assert.strictEqual(won.timeout, false);
        assert.strictEqual((await m.Handles.awaitAny('a', ['x', 'y'])).allUnknown, true);
        assert.deepStrictEqual(await m.Handles.awaitAny('a', []), {handle:null,snapshot:null,timeout:false,error:'await_any requires a non-empty handles array'});
    });
    test('timeout is a pending snapshot rather than cancellation and awaitAll preserves order', async function() {
        var p = pending('a');
        m.Handles.restore('a', 'done', {status:'done', result:1});
        var all = m.Handles.awaitAll('a', ['done', p.h.handleId, 'missing'], 10);
        timers.splice(0).forEach(function(fn) { fn(); });
        var r = await all;
        assert.deepStrictEqual(r.snapshots.map(function(s) { return s.status; }), ['done','pending','unknown']);
        assert.strictEqual(r.timedOut, true);
        p.resolve(2); await p.h.entry.promise;
        assert.strictEqual((await m.Handles.await('a', p.h.handleId)).result, 2);
    });
    test('awaitAny timeout reports pending and unknown without choosing either', async function() {
        var p = pending('a'), race = m.Handles.awaitAny('a', ['missing', p.h.handleId], 10);
        timers.splice(0).forEach(function(fn) { fn(); });
        var r = await race;
        assert.strictEqual(r.timeout, true); assert.strictEqual(r.handle, null);
        assert.deepStrictEqual(r.pendingSnapshots.map(function(s) { return s.status; }), ['unknown', 'pending']);
        m.Handles.cancel('a', p.h.handleId);
    });
    test('GC evicts cancelled never-finishing work but preserves pending entries', function() {
        var gone = pending('a'), live = pending('a');
        m.Handles.cancel('a', gone.h.handleId);
        now += m.HANDLE_TTL_MS + m.HANDLE_GC_INTERVAL_MS + 1;
        assert.strictEqual(m.Handles.poll('a', gone.h.handleId).status, 'unknown');
        assert.strictEqual(m.Handles.poll('a', live.h.handleId).status, 'pending');
        assert.strictEqual(m.Handles.pendingCount('a'), 1);
    });
    test('restored pending work re-arms and synchronous throws become error snapshots', async function() {
        var h = m.Handles.restore('a', 'persisted', {runFn:function() { throw new Error('boom'); }});
        await h.entry.promise;
        assert.strictEqual((await m.Handles.await('a','persisted')).error, 'boom');
        assert.strictEqual(m.Handles.restore('a', '').entry, null);
    });
});
