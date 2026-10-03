// C2-tools/020: skeleton-safe answer-card hook tools + PR-merged card flip
// (cold-chat message eviction). A skeleton is `_messagesEvicted:true` with
// NO `messages` key. Covers: set_tldr / set_links / set_caveat dispatch
// hydrates a cold chat first (twin hydrated vs skeleton), a hydrate miss
// fails closed (clear error, no save, no `messages` written), the hydrated
// path never calls ensureChatPayloads, wsNotifyPrMerged hydrates + flips a
// cold pr_opened chat (miss = no flip), mergeChatAutoLinks keeps the queue on
// a skeleton. Evaluates the REAL function texts cut out of the source (same
// pattern as test/chat-eviction-store.test.js).

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

// The real set_tldr / set_links / set_caveat dispatcher branches, wrapped in
// a mini async dispatcher.
function _cutDispatch(src) {
    var a = src.indexOf("} else if (name === 'set_tldr') {");
    var endMark = 'return executeSetCaveat(args, options);';
    var b = src.indexOf(endMark, a);
    if (a === -1 || b === -1) throw new Error('hook dispatch branches not found');
    return 'async function _dispatch(name, args, options) {\n    if (false) {\n    ' + src.slice(a, b + endMark.length) + '\n    }\n}\n';
}

var FNS = ['findHookAnswerSpan', 'findHookAnswerTarget', 'attachAnswerCard', 'relocateAnswerCard',
    '_hookToolColdChatId', '_hydrateColdHookChat', '_hookChatMissingError', 'executeSetTldr',
    'sanitizeHookLinks', 'extractPrUrls', '_prLinkTitle', '_autoLinkTargetChat', 'mergeChatAutoLinks',
    'executeSetLinks', 'executeSetCaveat', 'wsNotifyPrMerged', '_wsChatProgressState'];

// env: { chats, rows: {chatId: messages} } — ensureChatPayloads restores
// from `rows` (a miss leaves the skeleton), like core/130.
async function _env(env) {
    var src = await loadFile('src/js/tools/020-tool-execution.js');
    var log = { ensure: [], saves: 0, emits: [] };
    var chats = env.chats;
    var rows = env.rows || {};
    var ensure = async function(id) {
        log.ensure.push(id);
        await Promise.resolve();
        var c = chats[id];
        if (!c || !c._messagesEvicted || Array.isArray(c.messages)) return;
        if (!rows[id]) return; // miss: flags kept, resolves
        c.messages = rows[id];
        delete c._messagesEvicted;
        delete c._msgCount;
    };
    var body = _cutFns(src, FNS) + '\n' + _cutDispatch(src) + '\n'
        + 'return { dispatch: _dispatch, wsNotifyPrMerged: wsNotifyPrMerged, mergeChatAutoLinks: mergeChatAutoLinks,'
        + ' _wsChatProgressState: _wsChatProgressState, findHookAnswerSpan: findHookAnswerSpan };';
    var f = new Function('chats', 'activeStreamingChatId', 'currentChatId', 'ensureChatPayloads',
        'saveChatsToStorage', 'AgentEvents', body);
    var api = f(chats, null, null, env.noEnsure ? undefined : ensure,
        function() { log.saves++; },
        { emit: function(n, p) { log.emits.push(n); } });
    api.log = log;
    return api;
}

function _answerMsgs() {
    return [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'the answer' }];
}
function _prMsgs() {
    return [{ role: 'user', content: 'q' },
        { role: 'assistant', content: 'pushing', tool_calls: [{ id: 'tc1', function: { name: 'update_action_state',
            arguments: JSON.stringify({ state: 'pr_opened', output: 'https://github.com/o/r/pull/7' }) } }] },
        { role: 'tool', tool_call_id: 'tc1', content: '{"success":true}' },
        { role: 'assistant', content: 'done' }];
}
function _skel(id, n) { return { id: id, _messagesEvicted: true, _payloadsEvicted: true, _msgCount: n }; }
function _ticks() { return new Promise(function(r) { setTimeout(r, 0); }).then(function() { return new Promise(function(r) { setTimeout(r, 0); }); }); }

describe('C2-tools/020: skeleton-safe hook tools', function() {
    test('hydrated twin: set_tldr / set_links / set_caveat attach with no hydrate call', async function() {
        var chats = { h: { id: 'h', messages: _answerMsgs() } };
        var e = await _env({ chats: chats });
        var r1 = await e.dispatch('set_tldr', { tldr: 'short' }, { chatId: 'h' });
        var r2 = await e.dispatch('set_links', { links: [{ title: 'x', url: 'https://x.test' }] }, { chatId: 'h' });
        var r3 = await e.dispatch('set_caveat', { caveat: 'careful' }, { chatId: 'h' });
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r2.success, true);
        assert.strictEqual(r3.success, true);
        assert.strictEqual(chats.h.messages[1].tldr, 'short');
        assert.strictEqual(chats.h.messages[1].links.length, 1);
        assert.strictEqual(chats.h.messages[1].caveat, 'careful');
        assert.strictEqual(e.log.ensure.length, 0);
        assert.strictEqual(e.log.saves, 3);
    }, { tags: ['unit'] });

    test('skeleton twin: each hook tool hydrates the ONE target chat first, then attaches', async function() {
        var chats = { s: _skel('s', 2), other: _skel('other', 2) };
        var e = await _env({ chats: chats, rows: { s: _answerMsgs(), other: _answerMsgs() } });
        var r = await e.dispatch('set_tldr', { tldr: 'cold tldr' }, { chatId: 's' });
        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(e.log.ensure, ['s']);
        assert.strictEqual(chats.s.messages[1].tldr, 'cold tldr');
        assert.strictEqual(chats.other.messages, undefined);
        var r2 = await e.dispatch('set_caveat', { caveat: 'c' }, { chatId: 's' });
        assert.strictEqual(r2.success, true);
        assert.strictEqual(e.log.ensure.length, 1); // already hydrated: no second hydrate
        var e2 = await _env({ chats: { s2: _skel('s2', 2) }, rows: { s2: _answerMsgs() } });
        var r3 = await e2.dispatch('set_links', { links: [{ url: 'https://y.test' }] }, { chatId: 's2' });
        assert.strictEqual(r3.success, true);
        assert.deepStrictEqual(e2.log.ensure, ['s2']);
    }, { tags: ['unit'] });

    test('skeleton hydrate miss fails closed: clear error, no save, no messages written', async function() {
        var names = [['set_tldr', { tldr: 't' }], ['set_links', { links: [] }], ['set_caveat', { caveat: 'c' }]];
        for (var i = 0; i < names.length; i++) {
            var chats = { s: _skel('s', 4) };
            var e = await _env({ chats: chats, rows: {} });
            var r = await e.dispatch(names[i][0], names[i][1], { chatId: 's' });
            assert.strictEqual(r.success, false);
            assert.ok(/not loaded/.test(r.error), names[i][0] + ': ' + r.error);
            assert.strictEqual('messages' in chats.s, false);
            assert.strictEqual(chats.s._messagesEvicted, true);
            assert.strictEqual(e.log.saves, 0);
            assert.strictEqual(e.log.emits.length, 0);
        }
        // No ensureChatPayloads in the realm: still fails closed, no throw.
        var e3 = await _env({ chats: { s: _skel('s', 4) }, noEnsure: true });
        var r3 = await e3.dispatch('set_tldr', { tldr: 't' }, { chatId: 's' });
        assert.strictEqual(r3.success, false);
        // Unknown chat keeps the original error.
        var r4 = await e3.dispatch('set_tldr', { tldr: 't' }, { chatId: 'nope' });
        assert.strictEqual(r4.error, 'No active chat');
    }, { tags: ['unit'] });

    test('wsNotifyPrMerged: hydrated twin flips sync; skeleton hydrates then flips; miss = no flip', async function() {
        var hot = { h: { id: 'h', messages: _prMsgs() } };
        var eh = await _env({ chats: hot });
        eh.wsNotifyPrMerged('h', { number: 7, url: 'https://github.com/o/r/pull/7' });
        assert.strictEqual(hot.h.progressStateOverride.state, 'pr_merged');
        assert.strictEqual(eh.log.ensure.length, 0);
        assert.strictEqual(eh.log.saves, 1);

        var cold = { s: _skel('s', 4) };
        var es = await _env({ chats: cold, rows: { s: _prMsgs() } });
        es.wsNotifyPrMerged('s', { number: 7 });
        assert.strictEqual(cold.s.progressStateOverride, undefined); // async hydrate first
        await _ticks();
        assert.deepStrictEqual(es.log.ensure, ['s']);
        assert.strictEqual(cold.s.progressStateOverride.state, 'pr_merged');
        assert.strictEqual(cold.s.progressStateOverride.pr_number, 7);
        assert.strictEqual(es.log.saves, 1);

        var miss = { s: _skel('s', 4) };
        var em = await _env({ chats: miss, rows: {} });
        em.wsNotifyPrMerged('s', { number: 7 });
        await _ticks();
        assert.strictEqual(miss.s.progressStateOverride, undefined);
        assert.strictEqual('messages' in miss.s, false);
        assert.strictEqual(em.log.saves, 0);
        assert.strictEqual(em.log.emits.length, 0);
    }, { tags: ['unit'] });

    test('pure helpers on a skeleton: null / false, queue kept, no TypeError', async function() {
        var chats = { s: _skel('s', 2) };
        chats.s.autoLinkQueue = [{ title: 'PR', url: 'https://github.com/o/r/pull/1' }];
        var e = await _env({ chats: chats });
        assert.strictEqual(e.findHookAnswerSpan(chats.s), null);
        assert.strictEqual(e._wsChatProgressState(chats.s), null);
        assert.strictEqual(e.mergeChatAutoLinks(chats.s), false);
        assert.strictEqual(chats.s.autoLinkQueue.length, 1);
        assert.strictEqual('messages' in chats.s, false);
    }, { tags: ['unit'] });
});
