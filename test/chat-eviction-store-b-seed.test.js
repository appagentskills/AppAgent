// C2-store B (cold-chat eviction): file-sum seeding before eviction
// (ui/070 _evictChatSeedingFileSum, worker/115 _swEvictChatSeedingFileSum)
// and the bug-11 save edit sentinel (worker/115 _swRevertSaveSentinels +
// bodyGuard). Evaluates the REAL function texts cut out of the sources (same
// pattern as test/chat-eviction-xctx-sw.test.js).

function _cutFns(src, names) {
    return names.map(function(name) {
        var re = new RegExp('^(async )?function ' + name + '\\(', 'm');
        var m = re.exec(src);
        if (!m) throw new Error('function not found: ' + name);
        var end = src.indexOf('\n}\n', m.index);
        if (end === -1) throw new Error('function end not found: ' + name);
        return src.slice(m.index, end + 2);
    }).join('\n');
}

var CORE_FNS = ['markChatMessagesDurable', 'chatMessagesDurable', 'unmarkChatMessagesDurable', 'evictChatMessagesInPlace'];

async function _env(flag) {
    var core = await loadFile('src/js/core/130-indexeddb.js');
    var ui = await loadFile('src/js/ui/070-dashboard-ui.js');
    var sw = await loadFile('src/js/worker/115-storage.js');
    var log = { order: [], indexed: [] };
    var body = 'var CHAT_MESSAGE_EVICTION_ENABLED = ' + (flag ? 'true' : 'false') + ';\n'
        + 'var _durableChatMsgArrays = new WeakMap(); var CHAT_KEEP_HYDRATED = 1; var currentChatId = null;\n'
        + 'var _skelFileSums = new Map(); var _realSet = _skelFileSums.set.bind(_skelFileSums);\n'
        + '_skelFileSums.set = function(k, v) { log.order.push("seed:" + k); return _realSet(k, v); };\n'
        + 'function chatPayloadRecencyTs(c) { return c.ts || 0; }\n'
        + 'function _indexSkelSummary(id) { log.indexed.push(id); }\n'
        + _cutFns(core, CORE_FNS) + '\n'
        + 'var _coreEvict = evictChatMessagesInPlace;\n'
        + 'evictChatMessagesInPlace = function(c) { log.order.push("evict:" + c.id); return _coreEvict(c); };\n'
        + _cutFns(ui, ['_evictChatSeedingFileSum', '_bootMsgWindowOffer']) + '\n'
        + _cutFns(sw, ['_swEvictChatSeedingFileSum', '_swRevertSaveSentinels']) + '\n'
        + 'return { sums: _skelFileSums, mark: markChatMessagesDurable, durable: chatMessagesDurable,'
        + ' unmark: unmarkChatMessagesDurable, uiSeed: _evictChatSeedingFileSum, swSeed: _swEvictChatSeedingFileSum,'
        + ' offer: _bootMsgWindowOffer, revert: _swRevertSaveSentinels };';
    var chats = {};
    var api = new Function('log', 'chats', body)(log, chats);
    return { api: api, log: log, chats: chats };
}

function _chat(id, ts) {
    return { id: id, ts: ts || 0, messages: [
        { role: 'user', content: 'hi' },
        { role: 'screenshot', screenshot_id: 'ss_' + id },
        { role: 'assistant', content: 'x', file_id: 'f_' + id }] };
}

describe('C2-store B: file-sum seeding + bug-11 edit sentinel', function() {
    test('ui/070 + worker/115 helpers seed _skelFileSums BEFORE evicting', async function() {
        var e = await _env(true);
        ['uiSeed', 'swSeed'].forEach(function(fn, k) {
            var c = _chat('c' + k);
            assert.strictEqual(e.api[fn](c), true, fn + ' evicted');
            assert.ok(c._messagesEvicted && !Array.isArray(c.messages), fn + ' skeleton');
            var s = e.api.sums.get(c.id);
            assert.deepStrictEqual(s, { mc: 3, files: [['ss_' + c.id, 1, 'screenshot'], ['f_' + c.id, 2, 'assistant']] }, fn + ' sum');
            assert.strictEqual(s.mc, c._msgCount, fn + ' sum fresh vs _msgCount');
        });
        assert.deepStrictEqual(e.log.order, ['seed:c0', 'evict:c0', 'seed:c1', 'evict:c1'], 'seed precedes evict');
        assert.deepStrictEqual(e.log.indexed, ['c0'], 'page realm indexes the new summary');
    });

    test('refused eviction rolls the seed back; flag OFF never seeds', async function() {
        var e = await _env(true);
        var t = _chat('t'); t.isTemporary = true;
        assert.strictEqual(e.api.uiSeed(t), false);
        assert.strictEqual(e.api.swSeed(t), false);
        assert.strictEqual(e.api.sums.has('t'), false, 'rolled back');
        assert.ok(Array.isArray(t.messages), 'still hydrated');
        var off = await _env(false);
        var c = _chat('o');
        assert.strictEqual(off.api.uiSeed(c), false);
        assert.strictEqual(off.api.swSeed(c), false);
        assert.strictEqual(off.api.sums.size, 0, 'no seed with flag off');
        assert.deepStrictEqual(off.log.order, ['evict:o', 'evict:o'], 'plain evict call only');
    });

    test('_bootMsgWindowOffer seeds the chat that falls out of the window', async function() {
        var e = await _env(true);
        var win = [];
        e.api.offer(win, _chat('old', 1));
        e.api.offer(win, _chat('new', 2));
        assert.strictEqual(win.length, 1);
        assert.strictEqual(win[0].id, 'new');
        assert.ok(e.api.sums.has('old') && !e.api.sums.has('new'));
        assert.deepStrictEqual(e.log.order, ['seed:old', 'evict:old']);
    });

    test('eviction call sites route through the seeding helpers', async function() {
        var ui = await loadFile('src/js/ui/070-dashboard-ui.js');
        var sw = await loadFile('src/js/worker/115-storage.js');
        assert.ok(/chatMessagesDurable\(chats\[_ids\[_si\]\]\)\) _evictChatSeedingFileSum\(chats\[_ids\[_si\]\]\)/.test(ui), 'post-swap site');
        assert.ok(/if \(out\) _evictChatSeedingFileSum\(out\);/.test(ui), 'boot window site');
        assert.ok(/markChatMessagesDurable\(chat\);\s*_swEvictChatSeedingFileSum\(chat\);/.test(sw), 'SW load site');
    });

    test('bug 11: sentinel — an edit after capture blocks eviction until durable; uncommitted marks revert', async function() {
        var e = await _env(true);
        // Capture: the save marks the live array (wasDurable false).
        var a = _chat('a'), b = _chat('b'), d = _chat('d');
        e.chats.a = a; e.chats.b = b; e.chats.d = d;
        var marks = {};
        [a, b, d].forEach(function(c) { marks[c.id] = { ref: c.messages, wasDurable: e.api.durable(c) }; e.api.mark(c); });
        // Same-length in-place edit on b after capture (edit site unmarks).
        b.messages[0].content = 'edited';
        e.api.unmark(b);
        // a and b committed, d's put failed.
        var committed = { a: { ref: a.messages, len: 3 }, b: { ref: b.messages, len: 3 } };
        e.api.revert(marks, committed);
        assert.strictEqual(e.api.durable(a), true, 'committed + unedited stays proven');
        assert.strictEqual(e.api.durable(b), false, 'edited: not durable -> bodyGuard refuses');
        assert.strictEqual(e.api.durable(d), false, 'uncommitted fake mark reverted');
        // A pre-existing proof is never cleared by the revert.
        var p = _chat('p'); e.chats.p = p; e.api.mark(p);
        e.api.revert({ p: { ref: p.messages, wasDurable: true } }, null);
        assert.strictEqual(e.api.durable(p), true);
        // Next committed save re-marks the edited chat -> evictable again.
        e.api.mark(b);
        assert.strictEqual(e.api.durable(b), true);
        e.api.revert(null, null); // tolerates a missing map
    });

    test('bodyGuard source requires chatMessagesDurable for a sentinel-tracked chat', async function() {
        var sw = await loadFile('src/js/worker/115-storage.js');
        var i = sw.indexOf('sweepColdChatPayloads(0, true, function(cid, c) {');
        assert.ok(i > 0, 'bodyGuard found');
        var g = sw.slice(i, i + 900);
        assert.ok(/_saveSentinels\[cid\][\s\S]*!chatMessagesDurable\(c\)\) return false;/.test(g), 'durable check in guard');
        var cap = sw.indexOf('_saveSentinels[id] = { ref: _liveMsgs');
        var ext = sw.indexOf('var extracted = extractChatPayloadsForPut(desired[id]);');
        assert.ok(cap > 0 && ext > cap, 'marked at capture, before extraction');
        var rv = sw.indexOf('_swRevertSaveSentinels(_saveSentinels, _committedShape);');
        assert.ok(rv > 0 && rv < i, 'reverted before the post-save sweep');
        assert.ok(/CHAT_MESSAGE_EVICTION_ENABLED[\s\S]{0,200}markChatMessagesDurable === 'function'/.test(sw.slice(cap - 400, cap)), 'flag-gated');
    });
});
