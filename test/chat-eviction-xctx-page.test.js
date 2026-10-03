// C2-xctx-page: page-side adopt of message-evicted SKELETON chat rows
// (app/045-agent-port-bridge-page.js). Evaluates the REAL 045 adopt/merge/
// delta functions over the REAL core/130 eviction API (cut out of the
// workspace sources, same pattern as test/chat-message-eviction.test.js),
// with an in-memory IDB stand-in. Twin scenarios build the SW row as a clone
// and run the real evictChatMessagesInPlace: flag ON gives a skeleton, flag
// OFF is a no-op (hydrated row) — the final page transcript must match.

function _xcCutFns(src, names) {
    return names.map(function(name) {
        var re = new RegExp('^(async )?function ' + name + '\\(', 'm');
        var m = re.exec(src);
        if (!m) throw new Error('function not found: ' + name);
        var end = src.indexOf('\n}\n', m.index);
        if (end === -1) throw new Error('function end not found: ' + name);
        return src.slice(m.index, end + 2);
    }).join('\n');
}

var XC_CORE_FNS = ['chatMessageCount', 'markChatMessagesDurable', 'chatMessagesDurable', 'evictChatMessagesInPlace',
    '_restoreEvictedChatMessages', 'stripChatPayloadsInPlace', 'chatPayloadRecencyTs', 'chatHasEvictableBodies',
    'sweepColdChatPayloads', 'ensureChatPayloads', '_unionChatDisplaysForPut'];
var XC_PAGE_FNS = ['_mergePagePendingRows', '_mergePageChatMeta', '_graftHeavyMap', '_mergePageHeavyPayloads',
    '_chatRowStaler', 'adoptChatRow', '_locateDeltaRow', '_synthesizeChatFromDelta'];

async function _xcEnv(opts) {
    var core = await loadFile('src/js/core/130-indexeddb.js');
    var page = await loadFile('src/js/app/045-agent-port-bridge-page.js');
    var body = 'var CHAT_MESSAGE_EVICTION_ENABLED = ' + (opts.flag ? 'true' : 'false') + ';\n'
        + 'var CHAT_BODY_EVICT_MIN_CHARS = 512, CHAT_KEEP_HYDRATED = 8;\n'
        + 'var _durableChatMsgArrays = new WeakMap(), _chatHydrationPromises = {};\n'
        + 'var chatStoreName = "chats", chatPayloadsStoreName = "chat_payloads";\n'
        + 'var CHAT_META_TS_FIELDS = [], CHAT_META_FLAG_FIELDS = [];\n'
        + 'var _skeletonPendingRows = {};\n'
        + _xcCutFns(core, XC_CORE_FNS) + '\n' + _xcCutFns(page, XC_PAGE_FNS) + '\n'
        + 'var _xcRealEnsure = ensureChatPayloads;\n'
        + 'ensureChatPayloads = function(id) { __rec.ensure.push(id); var p = _xcRealEnsure(id); __rec.p.push(p); return p; };\n'
        + 'return { adoptChatRow: adoptChatRow, _chatRowStaler: _chatRowStaler, _synthesizeChatFromDelta: _synthesizeChatFromDelta,'
        + ' evictChatMessagesInPlace: evictChatMessagesInPlace, markChatMessagesDurable: markChatMessagesDurable,'
        + ' chatMessagesDurable: chatMessagesDurable, stash: function() { return _skeletonPendingRows; } };';
    var e = opts.env;
    var rec = { ensure: [], p: [], renders: 0, loads: 0 };
    var rows = e.disk || {};
    var f = new Function('chats', 'currentChatId', '_chatsHydrated', 'loadChatRowFromDB', 'withStore', 'console',
        'renderMessages', 'pendingToolApprovals', '__rec', body);
    var m = f(e.chats, e.currentChatId || null, true,
        async function(id) { rec.loads++; await (e.loadGate ? e.loadGate.promise : Promise.resolve()); return rows[id] ? _xcClone(rows[id]) : null; },
        function(stores, mode, fn) {
            return fn({ objectStore: function(name) { return { get: function(id) {
                var req = {};
                Promise.resolve().then(function() { req.result = name === 'chats' && rows[id] ? _xcClone(rows[id]) : null; if (req.onsuccess) req.onsuccess(); });
                return req;
            } }; } });
        },
        { warn: function() {}, error: function() {}, log: function() {} },
        function() { rec.renders++; },
        e.approvals || {}, rec);
    m.rec = rec;
    return m;
}

function _xcDeferred() { var d = {}; d.promise = new Promise(function(resolve) { d.resolve = resolve; }); return d; }
function _xcClone(o) { return JSON.parse(JSON.stringify(o)); }
function _xcMsgs(n) { var a = []; for (var i = 0; i < n; i++) a.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i, timestamp: i }); return a; }
async function _xcSettle(m) {
    for (var i = 0; i < m.rec.p.length; i++) { try { await m.rec.p[i]; } catch (e) {} }
    for (var t = 0; t < 5; t++) await Promise.resolve();
}
// SW row for a twin: clone, then the REAL eviction (no-op with the flag OFF).
function _xcSwRow(m, row) { var r = _xcClone(row); m.evictChatMessagesInPlace(r); return r; }

describe('C2-xctx-page: skeleton chat rows over the page mirror (app/045)', function() {
    test('source declares the skeleton pending-row stash', async function() {
        var page = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        assert.match(page, /^var _skeletonPendingRows = \{\};$/m);
        assert.match(page, /typeof _skeletonPendingRows !== 'undefined'/);
    }, { tags: ['unit'] });

    test('(a) empty stub over a no-rev skeleton is refused, like over its hydrated twin', async function() {
        var chats = { c: { id: 'c', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 5 } };
        var m = await _xcEnv({ flag: true, env: { chats: chats } });
        assert.strictEqual(m._chatRowStaler({ id: 'c', messages: [] }, chats.c), true);
        assert.strictEqual(m._chatRowStaler({ id: 'c', messages: [] }, { id: 'c', messages: _xcMsgs(5) }), true);
        var sk = chats.c;
        assert.strictEqual(m.adoptChatRow({ id: 'c', messages: [] }), false);
        assert.strictEqual(chats.c, sk);
        // flag-off identity: plain array compares unchanged
        assert.strictEqual(m._chatRowStaler({ messages: [1] }, { messages: [1, 2] }), true);
        assert.strictEqual(m._chatRowStaler({ messages: [1, 2] }, { messages: [1] }), false);
        assert.strictEqual(m._chatRowStaler({}, {}), false);
    }, { tags: ['unit'] });

    test('(b) equal-rev skeleton grafts the hydrated array (identity + durable stamp), no ensure', async function() {
        var out = {};
        for (var flag of [true, false]) {
            var arr = _xcMsgs(3);
            var chats = { c: { id: 'c', rev: 3, title: 'T', messages: arr } };
            var m = await _xcEnv({ flag: flag, env: { chats: chats, currentChatId: 'c' } });
            m.markChatMessagesDurable(chats.c);
            var row = _xcSwRow(m, chats.c);
            assert.strictEqual(Array.isArray(row.messages), !flag, 'twin shape');
            assert.strictEqual(m.adoptChatRow(row), true);
            assert.strictEqual(chats.c, row);
            if (flag) {
                assert.strictEqual(row.messages, arr, 'grafted the same array');
                assert.strictEqual(m.chatMessagesDurable(row), true, 'durable stamp kept');
                assert.strictEqual(row._messagesEvicted, undefined);
                assert.strictEqual(row._msgCount, undefined);
                assert.strictEqual(row._evictedPayloadRefs, undefined);
                assert.strictEqual(row._payloadsEvicted, undefined);
            }
            assert.strictEqual(m.rec.ensure.length, 0, 'no ensure for a graft');
            await _xcSettle(m);
            out[flag] = _xcClone(chats.c.messages);
        }
        assert.deepStrictEqual(out[true], out[false]);
    }, { tags: ['unit'] });

    test('(c) newer-rev skeleton stays a skeleton, ensure hydrates from disk', async function() {
        var out = {};
        for (var flag of [true, false]) {
            var disk = { c: { id: 'c', rev: 5, title: 'T', messages: _xcMsgs(4) } };
            var chats = { c: { id: 'c', rev: 3, title: 'T', messages: _xcMsgs(3) } };
            var m = await _xcEnv({ flag: flag, env: { chats: chats, disk: disk, currentChatId: 'c' } });
            var row = _xcSwRow(m, disk.c);
            assert.strictEqual(m.adoptChatRow(row), true);
            if (flag) {
                assert.strictEqual(chats.c.messages, undefined, 'never messages:[]');
                assert.strictEqual(chats.c._messagesEvicted, true);
                assert.strictEqual(chats.c._msgCount, 4);
                assert.deepStrictEqual(m.rec.ensure, ['c']);
            }
            await _xcSettle(m);
            assert.ok(Array.isArray(chats.c.messages), 'hydrated');
            if (flag) assert.ok(m.rec.renders >= 1, 'current chat repainted');
            out[flag] = _xcClone(chats.c.messages);
        }
        assert.deepStrictEqual(out[true], out[false]);
        assert.deepStrictEqual(out[true], _xcMsgs(4));
    }, { tags: ['unit'] });

    function pendingFixture() {
        var prompt = { role: 'prompt_user', status: 'pending', promptId: 'p1', fields: [{ name: 'a', value: 'draft' }] };
        var appr = { role: 'approval', status: 'pending', toolCallId: 'X' };
        var u0 = { role: 'user', content: 'm0', timestamp: 0 };
        return {
            prompt: prompt, appr: appr,
            chats: { c: { id: 'c', rev: 3, messages: [u0, prompt, { role: 'assistant', content: 'a2' }, appr] } },
            disk: { c: { id: 'c', rev: 4, messages: [_xcClone(u0)] } },
            approvals: { 'c:3': { chatId: 'c', toolCallId: 'X', approvalIndex: 3 } }
        };
    }

    test('(d) pending rows survive skeleton adopt -> hydrate at original index; approval re-keyed', async function() {
        var out = {};
        for (var flag of [true, false]) {
            var fx = pendingFixture();
            var m = await _xcEnv({ flag: flag, env: { chats: fx.chats, disk: fx.disk, approvals: fx.approvals, currentChatId: 'z' } });
            var row = _xcSwRow(m, fx.disk.c);
            assert.strictEqual(m.adoptChatRow(row), true);
            if (flag) {
                assert.strictEqual(fx.chats.c.messages, undefined);
                var st = m.stash().c;
                assert.ok(st, 'stashed');
                assert.strictEqual(st[1], fx.prompt);
                assert.strictEqual(st[3], fx.appr);
                assert.strictEqual(st[0], undefined, 'only pending rows stashed');
                assert.deepStrictEqual(m.rec.ensure, ['c'], 'stash kicks ensure even off-screen');
            }
            await _xcSettle(m);
            var msgs = fx.chats.c.messages;
            assert.strictEqual(msgs.length, 3);
            assert.strictEqual(msgs[1], fx.prompt, 'page prompt object identity');
            assert.strictEqual(msgs[2], fx.appr);
            assert.ok(fx.approvals['c:2'] && fx.approvals['c:2'].approvalIndex === 2, 're-keyed to c:2');
            assert.strictEqual(fx.approvals['c:3'], undefined);
            assert.strictEqual(m.stash().c, undefined, 'stash flushed');
            assert.strictEqual(m.rec.renders, 0, 'not current: no repaint');
            out[flag] = { msgs: _xcClone(msgs), keys: Object.keys(fx.approvals) };
        }
        assert.deepStrictEqual(out[true], out[false]);
    }, { tags: ['unit'] });

    test('(e) hydrated adopt inside the ensure window flushes the stash once (no dup)', async function() {
        var fx = pendingFixture();
        var m = await _xcEnv({ flag: true, env: { chats: fx.chats, disk: fx.disk, approvals: fx.approvals, currentChatId: 'z' } });
        assert.strictEqual(m.adoptChatRow(_xcSwRow(m, fx.disk.c)), true);
        var hyd = { id: 'c', rev: 5, messages: [{ role: 'user', content: 'm0', timestamp: 0 }, { role: 'assistant', content: 'a9' }] };
        assert.strictEqual(m.adoptChatRow(hyd), true);
        assert.strictEqual(m.stash().c, undefined);
        await _xcSettle(m);
        var msgs = fx.chats.c.messages;
        assert.strictEqual(fx.chats.c, hyd);
        assert.strictEqual(msgs.filter(function(r) { return r.role === 'prompt_user'; }).length, 1);
        assert.strictEqual(msgs.filter(function(r) { return r.role === 'approval'; }).length, 1);
        assert.strictEqual(msgs[1], fx.prompt);
        assert.strictEqual(msgs.length, 4);
        assert.strictEqual(fx.chats.c._messagesEvicted, undefined);
    }, { tags: ['unit'] });

    test('(f) a skeleton-meta delta never rebuilds messages:[]', async function() {
        var arr = _xcMsgs(3);
        var chats = { c: { id: 'c', rev: 3, messages: arr } };
        var m = await _xcEnv({ flag: true, env: { chats: chats } });
        var sk = m._synthesizeChatFromDelta('c', { fromIndex: 0, tail: [], meta: { id: 'c', rev: 4, _messagesEvicted: true, _msgCount: 3 } });
        assert.ok(sk);
        assert.strictEqual(sk.messages, undefined);
        assert.strictEqual(chats.c.messages, arr, 'prev untouched');
        assert.strictEqual(m.adoptChatRow(sk), true);
        assert.ok(!Array.isArray(chats.c.messages), 'skeleton, not an empty transcript');
        assert.strictEqual(chats.c._msgCount, 3);
        // equal-rev skeleton delta grafts the mirror's array
        var chats2 = { c: { id: 'c', rev: 3, messages: arr } };
        var m2 = await _xcEnv({ flag: true, env: { chats: chats2 } });
        var sk2 = m2._synthesizeChatFromDelta('c', { fromIndex: 0, tail: [], meta: { id: 'c', rev: 3, _messagesEvicted: true, _msgCount: 3 } });
        assert.strictEqual(m2.adoptChatRow(sk2), true);
        assert.strictEqual(chats2.c.messages, arr);
        // non-skeleton delta: unchanged behaviour
        var chats3 = { c: { id: 'c', rev: 3, messages: _xcMsgs(2) } };
        var m3 = await _xcEnv({ flag: false, env: { chats: chats3 } });
        var full = m3._synthesizeChatFromDelta('c', { fromIndex: 2, tail: [{ role: 'user', content: 'n' }], meta: { rev: 4 } });
        assert.strictEqual(full.messages.length, 3);
    }, { tags: ['unit'] });

    test('(g) boot map adopt: equal-rev skeleton grafts disk array, newer stays skeleton, never kicks/stashes', async function() {
        var chats = {};
        var m = await _xcEnv({ flag: true, env: { chats: chats, currentChatId: 't' } });
        var diskArr = _xcMsgs(3);
        var loaded = {
            s: { id: 's', rev: 2, messages: diskArr },
            t: { id: 't', rev: 2, messages: [{ role: 'user', content: 'u' }, { role: 'prompt_user', status: 'pending', promptId: 'pt' }] }
        };
        m.markChatMessagesDurable(loaded.s);
        var memS = _xcSwRow(m, { id: 's', rev: 2, messages: _xcMsgs(3) });
        var memT = _xcSwRow(m, { id: 't', rev: 4, messages: _xcMsgs(5) });
        assert.strictEqual(m.adoptChatRow(memS, { map: loaded }), true);
        assert.strictEqual(loaded.s, memS);
        assert.strictEqual(memS.messages, diskArr);
        assert.strictEqual(m.chatMessagesDurable(memS), true);
        assert.strictEqual(m.adoptChatRow(memT, { map: loaded }), true);
        assert.strictEqual(loaded.t, memT);
        assert.strictEqual(memT.messages, undefined);
        assert.strictEqual(memT._msgCount, 5);
        assert.strictEqual(m.rec.ensure.length, 0, 'no kick with opts.map');
        assert.deepStrictEqual(Object.keys(m.stash()), [], 'no boot stash');
        assert.deepStrictEqual(Object.keys(chats), [], 'global map untouched');
    }, { tags: ['unit'] });

    test('(h) hydrate miss after a stashed adopt keeps the stash, no repaint (045 !Array.isArray(live.messages))', async function() {
        var fx = pendingFixture(), gate = _xcDeferred();
        // disk:{} -> the real ensureChatPayloads row read misses and resolves
        // with the chat still a skeleton.
        var m = await _xcEnv({ flag: true, env: { chats: fx.chats, disk: {}, approvals: fx.approvals, currentChatId: 'c', loadGate: gate } });
        assert.strictEqual(m.adoptChatRow(_xcSwRow(m, fx.disk.c)), true);
        var st = m.stash().c;
        assert.strictEqual(st[1], fx.prompt);
        assert.strictEqual(st[3], fx.appr);
        assert.deepStrictEqual(m.rec.ensure, ['c']);
        assert.strictEqual(m.rec.loads, 1, 'row read waiting on explicit gate');
        gate.resolve();
        // adopt registered its synchronous completion callback before this
        // await: returning here means the stash/repaint decision has run.
        await m.rec.p[0];
        assert.strictEqual(m.rec.loads, 1, 'one row read');
        assert.strictEqual(fx.chats.c.messages, undefined, 'still a skeleton');
        assert.strictEqual(fx.chats.c._messagesEvicted, true);
        assert.strictEqual(m.stash().c, st, 'stash kept (same array)');
        assert.strictEqual(m.stash().c[1], fx.prompt);
        assert.strictEqual(m.stash().c[3], fx.appr);
        assert.strictEqual(m.rec.renders, 0, 'current chat, but no repaint on a miss');
        assert.deepStrictEqual(fx.approvals, { 'c:3': { chatId: 'c', toolCallId: 'X', approvalIndex: 3 } });
    }, { tags: ['unit'] });

    test('(i) chat deleted while the adopt-time hydrate is in flight drops the stash (045 !live)', async function() {
        var fx = pendingFixture(), gate = _xcDeferred();
        var m = await _xcEnv({ flag: true, env: { chats: fx.chats, disk: fx.disk, approvals: fx.approvals, currentChatId: 'z', loadGate: gate } });
        assert.strictEqual(m.adoptChatRow(_xcSwRow(m, fx.disk.c)), true);
        assert.strictEqual(m.stash().c[1], fx.prompt);
        assert.strictEqual(m.stash().c[3], fx.appr);
        assert.deepStrictEqual(m.rec.ensure, ['c']);
        assert.strictEqual(m.rec.loads, 1, 'row read waiting on explicit gate');
        delete fx.chats.c;
        gate.resolve();
        await m.rec.p[0];
        assert.strictEqual(fx.chats.c, undefined);
        assert.strictEqual(m.stash().c, undefined, 'stash dropped for a deleted chat');
        assert.deepStrictEqual(Object.keys(m.stash()), []);
        assert.strictEqual(m.rec.renders, 0);
    }, { tags: ['unit'] });
});
