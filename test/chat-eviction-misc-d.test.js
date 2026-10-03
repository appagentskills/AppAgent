// C2-core-misc part D: skeleton-safe sites in app/020, app/050, tools/120
// (History quick-search late re-render) and tools/140.
// A skeleton = { id, _messagesEvicted, _payloadsEvicted, _msgCount } with no
// `messages` array (full row in IndexedDB). Evaluates the REAL function texts
// cut out of the source (same pattern as test/chat-eviction-store.test.js).

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

var NOOP_CONSOLE = { warn: function() {}, error: function() {}, log: function() {} };
function _tick() { return new Promise(function(r) { setTimeout(r, 0); }); }

function _approvalMsgs() {
    return [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
        { role: 'approval', status: 'pending', toolCallId: 't1' }];
}

// env: { chats, pending, ensureChatPayloads (or null) }
async function _approvalEnv(env) {
    var src = await loadFile('src/js/app/020-api-messages.js');
    var log = { saves: 0, resolved: [] };
    var body = _cutFns(src, ['rejectPendingApprovalsForChat', '_denySkeletonApprovalRows'])
        + '\nreturn { reject: rejectPendingApprovalsForChat, denySkel: _denySkeletonApprovalRows };';
    var f = new Function('chats', 'pendingToolApprovals', 'saveChatsToStorage', 'ensureChatPayloads', 'console', body);
    var m = f(env.chats, env.pending, function() { log.saves++; }, env.ensureChatPayloads, NOOP_CONSOLE);
    m.log = log;
    return m;
}
function _pending(chatId, log) {
    return { k1: { chatId: chatId, approvalIndex: 2, resolve: function(v) { log.push(v); } } };
}

describe('C2-core-misc D: skeleton-safe misc sites', function() {
    test('020: hydrated chat — row denied, resolver settled, one save (sync, unchanged)', async function() {
        var res = [];
        var chats = { a: { id: 'a', messages: _approvalMsgs() } };
        var pending = _pending('a', res);
        var called = 0;
        var m = await _approvalEnv({ chats: chats, pending: pending, ensureChatPayloads: function() { called++; return Promise.resolve(); } });
        m.reject('a');
        assert.strictEqual(chats.a.messages[2].status, 'denied');
        assert.strictEqual(chats.a.messages[2].deniedByPause, true);
        assert.deepStrictEqual(res, [false]);
        assert.strictEqual(Object.keys(pending).length, 0);
        assert.strictEqual(m.log.saves, 1);
        await _tick();
        assert.strictEqual(called, 0, 'no hydrate for a hydrated chat');
    }, { tags: ['unit'] });

    test('020: skeleton — resolver settled sync; rows denied on the re-read chat after hydrate', async function() {
        var res = [];
        var chats = { a: { id: 'a', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 3 } };
        var pending = _pending('a', res);
        var m = await _approvalEnv({ chats: chats, pending: pending, ensureChatPayloads: function(id) {
            // copy-on-restore: a NEW object lands in chats[id]
            chats[id] = { id: id, messages: _approvalMsgs() };
            return Promise.resolve();
        } });
        m.reject('a');
        assert.deepStrictEqual(res, [false]);
        assert.strictEqual(Object.keys(pending).length, 0);
        assert.strictEqual(m.log.saves, 0, 'no save before hydrate');
        assert.strictEqual(Array.isArray(chats.a.messages) ? chats.a.messages[2].status : 'skel', 'skel');
        await _tick(); await _tick();
        assert.strictEqual(chats.a.messages[2].status, 'denied');
        assert.strictEqual(chats.a.messages[2].deniedByPause, true);
        assert.strictEqual(m.log.saves, 1);
    }, { tags: ['unit'] });

    test('020: skeleton hydrate miss / reject / no helper — fail closed, no save, no throw', async function() {
        var chats = { a: { id: 'a', _messagesEvicted: true, _msgCount: 3 } };
        var miss = await _approvalEnv({ chats: chats, pending: {}, ensureChatPayloads: function() { return Promise.resolve(); } });
        assert.strictEqual(await miss.denySkel('a', [2]), false);
        assert.strictEqual(miss.log.saves, 0);
        assert.ok(!('messages' in chats.a), 'skeleton never given messages:[]');
        var boom = await _approvalEnv({ chats: chats, pending: {}, ensureChatPayloads: function() { throw new TypeError('x'); } });
        assert.strictEqual(await boom.denySkel('a', [2]), false);
        assert.strictEqual(boom.log.saves, 0);
        var none = await _approvalEnv({ chats: chats, pending: {}, ensureChatPayloads: undefined });
        assert.strictEqual(await none.denySkel('a', [2]), false);
        var res = [];
        var wrap = await _approvalEnv({ chats: chats, pending: _pending('a', res), ensureChatPayloads: undefined });
        wrap.reject('a');
        assert.deepStrictEqual(res, [false]);
        assert.strictEqual(wrap.log.saves, 0);
    }, { tags: ['unit'] });

    test('050: msgIndex handlers return quietly on a skeleton current chat', async function() {
        var src = await loadFile('src/js/app/050-image-attachments.js');
        var log = { newChat: 0, modal: 0 };
        var body = _cutFns(src, ['openFileFromMessage', 'openPdfFromMessage', 'resendMessage', 'editMessage'])
            + '\nreturn { f: openFileFromMessage, p: openPdfFromMessage, r: resendMessage, e: editMessage };';
        var f = new Function('chats', 'currentChatId', 'newChat', 'openFileModal', 'openPdfModal', 't', body);
        var chats = { c: { id: 'c', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 4 } };
        var m = f(chats, 'c', function() { log.newChat++; }, function() { log.modal++; }, function() { log.modal++; }, function(s) { return s; });
        var threw = null;
        try { m.f(0); m.p(0); m.r(0); m.e(0); } catch (err) { threw = err; }
        assert.strictEqual(threw, null);
        assert.strictEqual(log.newChat, 0);
        assert.strictEqual(log.modal, 0);
        assert.ok(!('messages' in chats.c));
        // hydrated twin: the file opener still works
        chats.c = { id: 'c', messages: [{ role: 'file', content: 'x', name: 'n' }] };
        m.f(0);
        assert.strictEqual(log.modal, 1);
    }, { tags: ['unit'] });

    test('120: History quick-search passes a late re-render that fires only for the same query', async function() {
        var src = await loadFile('src/js/tools/120-actions.js');
        var log = { late: [], rerender: [] };
        var body = 'var _jobsHistoryQuery = \"ab\";\n' + _cutFns(src, ['_renderJobsHistoryResults'])
            + '\nreturn { run: _renderJobsHistoryResults, setQ: function(q) { _jobsHistoryQuery = q; } };';
        var f = new Function('chatMatchesSearch', 'onJobsHistorySearch', '_renderJobsGroupedRows', 'escapeHtml', 't', body);
        var m = f(function(c, q, onLate) { log.late.push(onLate); return !c._messagesEvicted; },
            function(v) { log.rerender.push(v); }, function(arr) { return 'rows:' + arr.length; },
            function(s) { return s; }, function(s) { return s; });
        var out = m.run([{ id: 'h', messages: [] }, { id: 's', _messagesEvicted: true, _msgCount: 2 }]);
        assert.strictEqual(out, 'rows:1');
        assert.strictEqual(typeof log.late[1], 'function');
        log.late[1]();
        assert.deepStrictEqual(log.rerender, ['ab']);
        m.setQ('xyz');
        log.late[1]();
        assert.deepStrictEqual(log.rerender, ['ab'], 'stale query: no re-render');
    }, { tags: ['unit'] });

    test('140: runtime inspect chat rows count skeleton messages via chatMessageCount', async function() {
        var ri = await loadFile('src/js/tools/140-runtime-inspect.js');
        var idb = await loadFile('src/js/core/130-indexeddb.js');
        var body = _cutFns(idb, ['chatMessageCount']) + '\n' + _cutFns(ri, ['_riSafeSerialize', '_riUiState'])
            + '\nreturn _riUiState;';
        var win = {
            chats: {
                s: { id: 's', title: 'Cold', createdAt: 2, _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 7 },
                h: { id: 'h', title: 'Hot', createdAt: 1, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }
            },
            runningChatIds: { h: true }
        };
        var uiState = new Function('window', body)(win);
        var r = uiState();
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.state.chatCount, 2);
        assert.deepStrictEqual(r.state.chats, [
            { id: 's', title: 'Cold', msgCount: 7, running: false, isSubAgent: false },
            { id: 'h', title: 'Hot', msgCount: 2, running: true, isSubAgent: false }
        ]);
    }, { tags: ['unit'] });
});
