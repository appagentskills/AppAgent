// C2-xctx-sw (cold-chat eviction): SW worker/* skeleton safety.
// Evaluates the REAL function texts cut out of worker/130, worker/100 and
// core/130 (same pattern as test/chat-message-eviction.test.js) with an
// in-memory disk map standing in for IDB.

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

var W130_FNS = ['_swIsMsgSkeleton', '_swHydrateSkeleton', '_swEmitRunCrashedIfIdle', '_swGraftSkeletonAdopt',
    '_swRunAgentAdopt', '_swRunAgentFlapRecover', '_swRunAgentAdoptDeferred', '_swRunAgentAfterGate',
    '_swRunAgentStart', '_swResumeRunAgent', '_swPullChatReply', '_swSendTargetDeleted'];
var CORE_FNS = ['chatMessageCount', 'markChatMessagesDurable', 'evictChatMessagesInPlace', '_restoreEvictedChatMessages'];
var W100_FNS = ['_slimHeavyMap', '_buildChatDelta'];

function _clone(o) { return JSON.parse(JSON.stringify(o)); }
var _quiet = { warn: function() {}, error: function() {}, log: function() {} };

async function _env(flag) {
    var w130 = await loadFile('src/js/worker/130-port-bridge.js');
    var core = await loadFile('src/js/core/130-indexeddb.js');
    var w100 = await loadFile('src/js/worker/100-agent-event-broadcast.js');
    var S = { ensures: 0, miss: 0, disk: {}, runs: [], crashed: [], flap: 0, onEnsure: null };
    var chats = {}, running = {}, guard = {};
    var body = 'var CHAT_MESSAGE_EVICTION_ENABLED = ' + (flag ? 'true' : 'false') + ';\n'
        + 'var _durableChatMsgArrays = new WeakMap(); var _chatDeltaSync = {};\n'
        + 'function ensureChatPayloads(id) { S.ensures++; return new Promise(function(r) { setTimeout(r, 1); }).then(function() {'
        + ' if (S.onEnsure) S.onEnsure(id);'
        + ' if (S.miss > 0) { S.miss--; return; }'
        + ' var c = chats[id]; if (c && !Array.isArray(c.messages) && S.disk[id]) _restoreEvictedChatMessages(c, JSON.parse(JSON.stringify(S.disk[id]))); }); }\n'
        + _cutFns(core, CORE_FNS) + '\n' + _cutFns(w100, W100_FNS) + '\n' + _cutFns(w130, W130_FNS) + '\n'
        + 'return { markChatMessagesDurable: markChatMessagesDurable, evictChatMessagesInPlace: evictChatMessagesInPlace,'
        + ' setSync: function(id, v) { _chatDeltaSync[id] = v; }, _buildChatDelta: _buildChatDelta,'
        + ' _swIsMsgSkeleton: _swIsMsgSkeleton, _swHydrateSkeleton: _swHydrateSkeleton, _swGraftSkeletonAdopt: _swGraftSkeletonAdopt,'
        + ' _swRunAgentAdopt: _swRunAgentAdopt, _swRunAgentAdoptDeferred: _swRunAgentAdoptDeferred,'
        + ' _swRunAgentAfterGate: _swRunAgentAfterGate, _swResumeRunAgent: _swResumeRunAgent, _swPullChatReply: _swPullChatReply };';
    var f = new Function('S', 'chats', 'runningChatIds', '_runCleanupGuard', 'loadChatRowFromDB', 'runAgent', 'AgentEvents',
        'console', '_swOverlayChatMeta', '_swChatMetaPendingByChatId', '_extractUnseenTrailingUserInput',
        '_swDispatchPanelSendMessage', 'pendingInjectionsByChatId', body);
    var api = f(S, chats, running, guard,
        async function(id) { await sleep(1); return S.disk[id] ? _clone(S.disk[id]) : null; },
        function(id) { S.runs.push(id); return Promise.resolve(); },
        { emit: function(t, d) { if (t === 'runCrashed') S.crashed.push(d.chatId); } },
        _quiet, function() {}, {},
        function() { S.flap++; return null; }, function() {}, {});
    return { api: api, S: S, chats: chats, running: running, guard: guard };
}

function _msgs() { return [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }]; }
// Persist a full chat to the fake disk and leave a skeleton in chats[id].
function _skeleton(e, row) {
    e.S.disk[row.id] = _clone(row);
    var c = _clone(row);
    e.api.markChatMessagesDurable(c);
    assert.ok(e.api.evictChatMessagesInPlace(c), 'evicted');
    e.chats[row.id] = c;
    return c;
}
function _port() { var p = { posted: [], postMessage: function(m) { p.posted.push(m); } }; return p; }

describe('C2-xctx-sw: SW worker skeleton safety', function() {
    test('_buildChatDelta: skeleton => null (slim fallback); hydrated twin => normal delta; flag off identical', async function() {
        for (var flag of [true, false]) {
            var e = await _env(flag);
            var c = { id: 'c1', messages: _msgs() };
            e.api.setSync('c1', { len: 1, lastRef: c.messages[0] });
            var d = e.api._buildChatDelta(c, null);
            assert.ok(d && d.fromIndex === 1 && d.tail.length === 1 && d.meta.messages === undefined, 'normal delta (flag ' + flag + ')');
        }
        var e2 = await _env(true);
        var s = _skeleton(e2, { id: 'c2', messages: _msgs() });
        e2.api.setSync('c2', { len: 0, lastRef: null });
        assert.strictEqual(e2.api._buildChatDelta(s, null), null, 'skeleton never ships an empty-tail delta');
    }, { tags: ['unit'] });

    test('broadcast watermark is dropped for a skeleton envelope (source)', async function() {
        var src = await loadFile('src/js/worker/100-agent-event-broadcast.js');
        assert.ok(/if \(_chat\._messagesEvicted && !Array\.isArray\(_chat\.messages\)\) \{\s*delete _chatDeltaSync\[_chat\.id\];/.test(src));
    }, { tags: ['unit'] });

    test('graft: a skeleton incoming never wipes a hydrated prev; hydrated incoming untouched', async function() {
        var e = await _env(true);
        var prev = { id: 'c1', messages: _msgs(), _dirtyWhileEvicted: true };
        var inc = _skeleton(e, { id: 'c1', messages: _msgs(), title: 'T' });
        assert.strictEqual(e.api._swGraftSkeletonAdopt(prev, inc), true);
        assert.strictEqual(inc.messages, prev.messages);
        assert.ok(!inc._messagesEvicted && inc._msgCount === undefined && inc._dirtyWhileEvicted === true);
        var full = { id: 'c1', messages: [] };
        assert.strictEqual(e.api._swGraftSkeletonAdopt(prev, full), false);
        assert.strictEqual(full.messages.length, 0);
    }, { tags: ['unit'] });

    test('deferred run-agent adopt carries injected rows exactly like a hydrated prev', async function() {
        var inj = { role: 'user', content: 'INJ', injected: true };
        var stored = { id: 'c1', messages: _msgs().concat([inj]) };
        var incoming = function() { return { id: 'c1', messages: _msgs().concat([{ role: 'user', content: 'USER' }]) }; };
        var h = await _env(true);
        h.chats.c1 = _clone(stored);
        var mh = { chatId: 'c1', chat: incoming() };
        h.api._swRunAgentAdopt(mh);
        var e = await _env(true);
        _skeleton(e, stored);
        var m = { chatId: 'c1', chat: incoming() };
        await e.api._swRunAgentAdoptDeferred(m);
        assert.strictEqual(e.chats.c1, m.chat, 'adopted');
        assert.deepStrictEqual(_clone(e.chats.c1.messages), _clone(h.chats.c1.messages));
        assert.strictEqual(e.chats.c1.messages[e.chats.c1.messages.length - 1].content, 'INJ');
    }, { tags: ['unit'] });

    test('deferred adopt: a run that went live during hydration routes to flap recovery', async function() {
        var e = await _env(true);
        var s = _skeleton(e, { id: 'c1', messages: _msgs() });
        e.S.onEnsure = function(id) { e.running[id] = true; };
        await e.api._swRunAgentAdoptDeferred({ chatId: 'c1', chat: { id: 'c1', messages: [] } });
        assert.strictEqual(e.chats.c1, s, 'live chat not replaced');
        assert.strictEqual(e.S.flap, 1);
    }, { tags: ['unit'] });

    test('run-agent after-gate: miss => runCrashed, no runAgent; hit => runAgent; hydrated => sync runAgent', async function() {
        var e = await _env(true);
        _skeleton(e, { id: 'c1', messages: _msgs() });
        e.S.miss = 99;
        await e.api._swRunAgentAfterGate('c1');
        assert.deepStrictEqual(e.S.runs, []);
        assert.deepStrictEqual(e.S.crashed, ['c1']);
        e.S.miss = 1;
        await e.api._swRunAgentAfterGate('c1');
        assert.deepStrictEqual(e.S.runs, ['c1'], 'second try hydrates');
        var off = await _env(false);
        off.chats.c2 = { id: 'c2', messages: _msgs() };
        off.api._swRunAgentAfterGate('c2');
        assert.deepStrictEqual(off.S.runs, ['c2'], 'no extra tick when nothing is evicted');
    }, { tags: ['unit'] });

    test('checkpoint resume: miss rejects without runAgent', async function() {
        var e = await _env(true);
        _skeleton(e, { id: 'c1', messages: _msgs() });
        e.S.miss = 99;
        var err = null;
        try { await e.api._swResumeRunAgent('c1'); } catch (x) { err = x; }
        assert.ok(err && e.S.runs.length === 0);
    }, { tags: ['unit'] });

    test('pull-chat: skeleton => hydrated reply with SW fields; miss => disk messages under SW fields, not adopted', async function() {
        var e = await _env(true);
        var row = { id: 'c1', messages: _msgs(), title: 'disk title', rev: 3 };
        var s = _skeleton(e, row);
        s.title = 'SW title'; s.rev = 5;
        var p = _port();
        await e.api._swPullChatReply(p, 'c1', false);
        assert.strictEqual(p.posted.length, 1);
        assert.strictEqual(p.posted[0].chat.messages.length, 2);
        assert.strictEqual(p.posted[0].chat.title, 'SW title');
        assert.strictEqual(p.posted[0].chat.rev, 5);
        var e2 = await _env(true);
        var s2 = _skeleton(e2, row);
        s2.title = 'SW title'; s2.rev = 5;
        e2.S.miss = 99;
        var p2 = _port();
        await e2.api._swPullChatReply(p2, 'c1', false);
        assert.strictEqual(p2.posted.length, 1);
        var r = p2.posted[0].chat;
        assert.ok(r.messages.length === 2 && r.title === 'SW title' && r.rev === 5 && r._payloadsEvicted === true);
        assert.ok(e2.chats.c1 === s2 && !Array.isArray(s2.messages), 'reply never adopted into the SW map');
        var off = await _env(false);
        off.chats.c3 = { id: 'c3', messages: _msgs() };
        var p3 = _port();
        off.api._swPullChatReply(p3, 'c3', false);
        assert.strictEqual(p3.posted.length, 1, 'hydrated chat replies synchronously');
        assert.strictEqual(p3.posted[0].chat, off.chats.c3);
    }, { tags: ['unit'] });

    test('send-message: skeleton snapshot is kept; idle miss bails before any write (source order)', async function() {
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        assert.ok(/if \(!Array\.isArray\(_smChat\.messages\) && !_swIsMsgSkeleton\(_smChat\)\) _smChat\.messages = \[\];/.test(src));
        var body = src.slice(src.indexOf('async function _handlePanelSendMessage('));
        var aw = body.indexOf('await ensureChatPayloads(chatId)');
        var guard = body.indexOf('if (_swIsMsgSkeleton(chats[chatId])) {', aw);
        var push = body.indexOf("chats[chatId].messages.push({ role: 'user'", aw);
        assert.ok(aw > 0 && guard > aw && push > guard, 'guard sits between hydrate and push');
        var e = await _env(true);
        _skeleton(e, { id: 'c1', messages: _msgs() });
        e.S.miss = 99;
        assert.strictEqual(await e.api._swHydrateSkeleton('c1'), false);
        assert.strictEqual(e.chats.c1.messages, undefined, 'never stands in messages: []');
    }, { tags: ['unit'] });
});
