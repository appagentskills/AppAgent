// MSG-EVICT (C2 core-files): file lookups on skeleton chats
// (_messagesEvicted, no messages key) in tools/040 get_file / getFileAsync,
// tools/070 screenshot_by_id and tools/050 read_attached_file. Twin cases:
// skeleton vs hydrated. The cold pass reads one row per skeleton and never
// hydrates a chat; only the resolved chat is restored via ensureChatPayloads.

function _fakeFilesIdb() {
    var rows = {};
    return { rows: rows,
        get: async function(id) { return rows[id] || null; },
        put: async function(r) { rows[r.id] = r; },
        del: async function(id) { delete rows[id]; },
        all: async function() { return Object.keys(rows).map(function(k) { return rows[k]; }); } };
}

function _clone(o) { return JSON.parse(JSON.stringify(o)); }

var PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
var PNG_H = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNh';
var PNG_M = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNm';

async function _coreEnv(opts) {
    opts = opts || {};
    var rows = {
        s1: { id: 's1', messages: [
            { role: 'user', content: 'hi' },
            { role: 'screenshot', screenshot_id: 'ss_A', base64: PNG_A },
            { role: 'file', name: 'a.csv', file_id: 'f_A', content: 'x,y' }
        ] },
        s2: { id: 's2', messages: [{ role: 'file', name: 'b.txt', file_id: 'f_B', content: 'bee' }] }
    };
    var hydrated = { id: 'h1', messages: [{ role: 'screenshot', screenshot_id: 'ss_H', base64: PNG_H }] };
    var chatsG = { h1: hydrated };
    function skel(id, extra) {
        return Object.assign({ id: id, title: id, _messagesEvicted: true, _payloadsEvicted: true, _msgCount: rows[id].messages.length }, extra || {});
    }
    if (opts.allHydrated) {
        chatsG.s1 = { id: 's1', messages: _clone(rows.s1.messages) };
        chatsG.s2 = { id: 's2', messages: _clone(rows.s2.messages), screenshots: { ssm_1: { base64: PNG_M } } };
    } else {
        chatsG.s1 = skel('s1');
        chatsG.s2 = skel('s2', { screenshots: { ssm_1: { base64: PNG_M } } });
    }
    var counter = { reads: 0, hydrations: [] };
    var M = await loadModules(['src/js/tools/040-file-store.js', 'src/js/tools/070-screenshot-by-id.js', 'src/js/tools/050-file-tools.js'], {
        lenient: true,
        globals: {
            chats: chatsG, activeStreamingChatId: null, currentChatId: null,
            loadChatRowFromDB: opts.loader
                ? function(id) { counter.reads++; return opts.loader(id, rows); }
                : async function(id) { counter.reads++; await Promise.resolve(); return rows[id] ? _clone(rows[id]) : null; },
            ensureChatPayloads: async function(id) {
                var c = chatsG[id];
                if (!c || (!c._messagesEvicted && !c._payloadsEvicted)) return;
                counter.hydrations.push(id);
                if (rows[id]) c.messages = _clone(rows[id].messages);
                delete c._messagesEvicted; delete c._payloadsEvicted;
            }
        }
    });
    M.ufsSetDeps({ idb: _fakeFilesIdb() });
    return { M: M, chats: chatsG, rows: rows, counter: counter };
}

describe('MSG-EVICT core files (040/050/070)', function() {
    test('getFileAsync resolves a file in a skeleton chat; only that chat is hydrated', async function() {
        var e = await _coreEnv();
        var f = await e.M.getFileAsync('f_A');
        assert.ok(f, 'resolved');
        assert.strictEqual(f.data, 'x,y');
        assert.ok(e.counter.reads <= 2, 'at most one row read per skeleton: ' + e.counter.reads);
        assert.deepStrictEqual(e.counter.hydrations, ['s1']);
        assert.ok(Array.isArray(e.chats.s1.messages), 's1 restored');
        assert.strictEqual(e.chats.s2.messages, undefined, 's2 stays a skeleton');
        assert.strictEqual(e.chats.s2._messagesEvicted, true);
    }, { tags: ['unit'] });

    test('screenshot in a skeleton chat resolves (twin: hydrated chat needs no reads)', async function() {
        var e = await _coreEnv();
        var s = await e.M.executeScreenshotById({ id: 'ss_A' });
        assert.strictEqual(s.success, true);
        assert.ok(s.base64.indexOf('base64,iVBOR') > -1);
        var h = await e.M.executeScreenshotById({ id: 'ss_H' });
        assert.strictEqual(h.success, true);
        var t = await _coreEnv({ allHydrated: true });
        var a = await t.M.executeScreenshotById({ id: 'ss_A' });
        assert.strictEqual(a.success, true);
        assert.strictEqual(t.counter.reads, 0, 'no row reads without skeletons');
        assert.deepStrictEqual(t.counter.hydrations, []);
    }, { tags: ['unit'] });

    test('get_file miss lists ids of skeleton chats, identical to the hydrated twin', async function() {
        var e = await _coreEnv();
        var r = await e.M.executeGetFile({ id: 'nope' });
        var expected = 'File not found: nope. Available file IDs: ss_H, ss_A, f_A, f_B';
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error, expected);
        assert.strictEqual(e.counter.reads, 2);
        assert.deepStrictEqual(e.counter.hydrations, [], 'the cold pass hydrates no chat');
        assert.strictEqual(e.chats.s1.messages, undefined);
        var r2 = await e.M.executeGetFile({ id: 'nope2' });
        assert.ok(/f_A, f_B$/.test(r2.error));
        assert.strictEqual(e.counter.reads, 2, 'summaries are cached while fresh');
        var t = await _coreEnv({ allHydrated: true });
        var tr = await t.M.executeGetFile({ id: 'nope' });
        assert.strictEqual(tr.error, expected);
        assert.strictEqual(t.counter.reads, 0);
    }, { tags: ['unit'] });

    test('screenshot_by_id miss lists skeleton screenshot ids, identical to the hydrated twin', async function() {
        var expected = 'Screenshot not found: nope. Available screenshot IDs: ss_H, ss_A, ssm_1';
        var e = await _coreEnv();
        var r = await e.M.executeScreenshotById({ id: 'nope' });
        assert.strictEqual(r.error, expected);
        assert.deepStrictEqual(e.counter.hydrations, []);
        var t = await _coreEnv({ allHydrated: true });
        assert.strictEqual((await t.M.executeScreenshotById({ id: 'nope' })).error, expected);
    }, { tags: ['unit'] });

    test('read_attached_file restores a skeleton chat instead of "No active chat found"', async function() {
        var e = await _coreEnv();
        var a = await e.M.executeReadAttachedFile({ filename: 'a.csv' }, { chatId: 's1' });
        assert.strictEqual(a.content, 'x,y');
        assert.deepStrictEqual(e.counter.hydrations, ['s1']);
        var t = await _coreEnv({ allHydrated: true });
        var b = await t.M.executeReadAttachedFile({ filename: 'a.csv' }, { chatId: 's1' });
        assert.strictEqual(b.content, 'x,y');
        assert.deepStrictEqual(t.counter.hydrations, []);
    }, { tags: ['unit'] });

    test('missing row / deleted chat fail closed', async function() {
        var e = await _coreEnv();
        delete e.rows.s2;
        assert.strictEqual(await e.M.getFileAsync('f_B'), null);
        assert.strictEqual(e.chats.s2.messages, undefined, 'never writes messages over a skeleton');
        delete e.chats.s1;
        var r = await e.M.executeGetFile({ id: 'nope' });
        assert.strictEqual(r.error, 'File not found: nope. Available file IDs: ss_H');
    }, { tags: ['unit'] });

    test('concurrent misses share one cold pass', async function() {
        var e = await _coreEnv();
        await Promise.all([e.M.executeGetFile({ id: 'x1' }), e.M.executeGetFile({ id: 'x2' }), e.M.executeScreenshotById({ id: 'x3' })]);
        assert.strictEqual(e.counter.reads, 2);
    }, { tags: ['unit'] });

    // Deferred-free immediate loader (one microtask, no timers).
    function _rowLoader(id, rows) { return Promise.resolve(rows[id] ? _clone(rows[id]) : null); }
    function _deferred() { var d = {}; d.promise = new Promise(function(r, j) { d.resolve = r; d.reject = j; }); return d; }

    test('summary is re-read when a skeleton _msgCount changes (040 _skelSumFresh mc check)', async function() {
        var e = await _coreEnv({ loader: _rowLoader });
        var r = await e.M.executeGetFile({ id: 'nope' });
        assert.strictEqual(r.error, 'File not found: nope. Available file IDs: ss_H, ss_A, f_A, f_B');
        assert.strictEqual(e.counter.reads, 2);
        // s1 grows on disk: new message with a new file id, count bumped.
        e.rows.s1.messages.push({ role: 'file', name: 'n.txt', file_id: 'f_N', content: 'new' });
        e.chats.s1._msgCount = 4;
        var f = await e.M.getFileAsync('f_N');
        assert.ok(f, 'f_N resolved after the summary refresh');
        assert.strictEqual(f.data, 'new');
        assert.strictEqual(e.counter.reads, 3, 'only the stale s1 summary is re-read');
        assert.deepStrictEqual(e.counter.hydrations, ['s1']);
    }, { tags: ['unit'] });

    test('a _msgCount change during the row read discards that row (040 c._msgCount !== mc)', async function() {
        var called = _deferred(), gate = _deferred();
        var e = await _coreEnv({ loader: function(id, rows) {
            if (id === 's1') { called.resolve(); return gate.promise.then(function() { return _clone(rows.s1); }); }
            return _rowLoader(id, rows);
        } });
        var p = e.M.getFileAsync('f_A');
        await called.promise;
        e.chats.s1._msgCount = 9; // a run appended while the row was in flight
        gate.resolve();
        assert.strictEqual(await p, null, 'stale row not indexed');
        assert.deepStrictEqual(e.counter.hydrations, [], 'nothing hydrated');
        assert.strictEqual(e.chats.s1.messages, undefined);
        assert.strictEqual(e.counter.reads, 2);
    }, { tags: ['unit'] });

    test('a throwing row loader yields null without rejecting; later skeletons still scanned (040 loader catch)', async function() {
        var e = await _coreEnv({ loader: function(id, rows) {
            if (id === 's1') throw new Error('idb boom');
            return _rowLoader(id, rows);
        } });
        var outcome = await e.M.getFileAsync('f_A').then(function(v) { return { ok: true, v: v }; }, function(err) { return { ok: false, err: err }; });
        assert.deepStrictEqual(outcome, { ok: true, v: null });
        var b = await e.M.getFileAsync('f_B');
        assert.ok(b, 's2 scanned past the throwing s1');
        assert.strictEqual(b.data, 'bee');
        assert.deepStrictEqual(e.counter.hydrations, ['s2']);
        assert.strictEqual(e.chats.s1.messages, undefined, 's1 stays a skeleton');
    }, { tags: ['unit'] });
});
