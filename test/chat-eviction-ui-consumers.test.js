// C2-ui SKEL-SCAN consumers (part 1): _wsPrChatLookup (ui/040),
// _wsfScanChat (ui/115) and chat search (ui/180) on evicted skeletons.
// Evaluates the REAL function texts cut out of the source files (same
// pattern as test/chat-message-eviction) with in-memory stand-ins for IDB.

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

async function _env(chats, rows) {
    var core = await loadFile('src/js/core/130-indexeddb.js');
    var u120 = await loadFile('src/js/ui/120-ui-utils.js');
    var u040 = await loadFile('src/js/ui/040-tools-settings.js');
    var u115 = await loadFile('src/js/ui/115-workspace-files-sidebar.js');
    var u180 = await loadFile('src/js/ui/180-search.js');
    var calls = { loads: 0, prSection: 0, sidebar: 0, chatList: 0 };
    var body = 'var _skelScanMemo = {}, _skelScanWant = {}, _skelScanQueue = [], _skelScanBusy = false, _skelScanRerenders = [], _skelScanTimer = null;\n'
        + 'var _wsPrChatIdx = null, _wsPrChatIdxAt = 0;\n'
        + 'var _wsfMutatingActions = { write: 1, edit: 1, delete: 1, copy: 1, discard: 1 };\n'
        + 'var _SKEL_SEARCH_KEEP = 3, _skelSearchQs = [], MAX_MATCHES_PER_CHAT = 50;\n'
        + 'function escapeHtml(s) { return String(s); }\n'
        + 'function _reconcileWsPrSection() { calls.prSection++; }\n'
        + 'function renderVersionSidebar() { calls.sidebar++; }\n'
        + 'function renderChatList() { calls.chatList++; }\n'
        + _cutFns(core, ['chatMessageCount']) + '\n'
        + _cutFns(u120, ['_isSkeletonChat', '_skelScanSig', '_skelClone', 'skeletonScanValue', '_skelScanPump']) + '\n'
        + _cutFns(u040, ['_wsPrChatLookup', '_wsPushedPrUrlsLive', '_wsPrChatIdxRerender']) + '\n'
        + _cutFns(u115, ['_wsfScanChat', '_wsfScanPacked', '_wsfSkelRerender', '_wsfScanChatLive', 'getWsEditedFilesForChat']) + '\n'
        + _cutFns(u180, ['chatMatchesSearch', '_isSkelSearchChat', '_skelSearchRerender', '_skelSearchValue', '_pruneSkelSearchSlots', 'findAllSearchMatches']) + '\n'
        + 'return { lookup: _wsPrChatLookup, wsf: _wsfScanChat, files: getWsEditedFilesForChat, match: chatMatchesSearch, snips: findAllSearchMatches,'
        + ' resetIdx: function() { _wsPrChatIdx = null; _wsPrChatIdxAt = 0; },'
        + ' busy: function() { return _skelScanBusy; } };';
    // Deferred loader: each row read stays pending until the test drains it,
    // so ordering is explicit (no real-time sleeps racing the pump).
    var pend = [];
    var loader = function(id) {
        calls.loads++;
        return new Promise(function(res) {
            pend.push(function() { res(rows[id] ? JSON.parse(JSON.stringify(rows[id])) : null); });
        });
    };
    var f = new Function('chats', 'calls', 'loadChatRowFromDB', 'setTimeout', 'clearTimeout', body);
    var api = f(chats, calls, loader, function(fn) { fn(); return 1; }, function() {});
    api.calls = calls;
    api.pending = function() { return pend.length; };
    // Resolve every pending row read and flush microtasks until the scan pump
    // is idle (its re-render hooks run synchronously at the end: setTimeout
    // is stubbed to call through).
    api.drain = async function() {
        for (var i = 0; i < 50; i++) {
            while (pend.length) pend.shift()();
            for (var k = 0; k < 10; k++) await Promise.resolve();
            if (!pend.length && !api.busy()) return;
        }
        throw new Error('skeleton scan pump did not drain');
    };
    return api;
}

function _msgs() {
    return [
        { role: 'user', content: 'please fix the zebra bug' },
        { role: 'assistant', content: '', tool_calls: [
            { id: 't1', function: { name: 'workspace', arguments: JSON.stringify({ action: 'write', path: 'a.js', content: 'BIG CONTENT', workspace: 'o/r::main' }) } },
            { id: 't2', function: { name: 'workspace', arguments: JSON.stringify({ action: 'push', branch_name: 'b' }) } }
        ] },
        { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ success: true, message: 'Created a.js' }) },
        { role: 'tool', tool_call_id: 't2', content: JSON.stringify({ success: true, pr_url: 'https://github.com/o/r/pull/7', pr_number: 7, files: [{ path: 'a.js', isNew: true }] }) }
    ];
}
function _skeleton(id) { return { id: id, title: 'Cold', _messagesEvicted: true, _msgCount: 4, updatedAt: 5 }; }

describe('C2-ui skeleton-safe UI consumers (040 / 115 / 180)', function() {
    test('hydrated chats: unchanged live answers and no stored-row reads', async function() {
        var chats = { h: { id: 'h', title: 'Hot', messages: _msgs(), updatedAt: 1 } };
        var m = await _env(chats, {});
        assert.strictEqual(m.lookup('https://github.com/o/r/pull/7').chatId, 'h');
        var ch = m.wsf(chats.h);
        assert.strictEqual(ch.length, 1);
        assert.strictEqual(ch[0].args.content, 'BIG CONTENT', 'live scan keeps full args');
        assert.strictEqual(ch.pushed['a.js'].number, 7);
        assert.strictEqual(m.match(chats.h, 'zebra'), true);
        assert.strictEqual(m.match(chats.h, 'nomatchhere'), false);
        assert.ok(m.snips(chats.h, 'zebra').length >= 1);
        assert.strictEqual(m.calls.loads, 0);
    }, { tags: ['unit'] });

    test('search: a skeleton matches its stored row after ONE read, never hydrated', async function() {
        var chats = { s: _skeleton('s') };
        var m = await _env(chats, { s: { id: 's', messages: _msgs() } });
        assert.strictEqual(m.match(chats.s, 'zebra'), false, 'unknown yet: fallback');
        assert.strictEqual(m.pending(), 1, 'one row read in flight');
        await m.drain();
        assert.strictEqual(m.calls.loads, 1);
        assert.ok(m.calls.chatList >= 1, 'sidebar list re-rendered');
        assert.strictEqual(m.match(chats.s, 'zebra'), true);
        assert.ok(m.snips(chats.s, 'zebra').length >= 1, 'snippets came from the same read');
        assert.strictEqual(m.calls.loads, 1);
        assert.strictEqual(m.match(chats.s, 'cold'), true, 'title still matches without a read');
        assert.strictEqual('messages' in chats.s, false, 'skeleton never gets messages attached');
    }, { tags: ['unit'] });

    test('search: a missing stored row fails closed (no throw, no retry loop)', async function() {
        var chats = { s: _skeleton('s') };
        var m = await _env(chats, {});
        assert.strictEqual(m.match(chats.s, 'zebra'), false);
        await m.drain();
        assert.strictEqual(m.match(chats.s, 'zebra'), false);
        assert.deepStrictEqual(m.snips(chats.s, 'zebra'), []);
        await m.drain();
        assert.strictEqual(m.pending(), 0, 'no retry read queued');
        assert.strictEqual(m.calls.loads, 1);
    }, { tags: ['unit'] });

    test('_wsPrChatLookup: skeleton push attributed after its row scan', async function() {
        var chats = { s: _skeleton('s') };
        var m = await _env(chats, { s: { id: 's', messages: _msgs() } });
        assert.strictEqual(m.lookup('https://github.com/o/r/pull/7'), null);
        await m.drain();
        assert.ok(m.calls.prSection >= 1, 'PR chips re-rendered');
        var hit = m.lookup('https://github.com/o/r/pull/7');
        assert.ok(hit, 'index rebuilt after the scan landed');
        assert.strictEqual(hit.chatId, 's');
        assert.strictEqual(hit.chatTitle, 'Cold');
        assert.strictEqual('messages' in chats.s, false);
    }, { tags: ['unit'] });

    test('_wsfScanChat: skeleton memo keeps pushed + slim args', async function() {
        var chats = { s: _skeleton('s') };
        var m = await _env(chats, { s: { id: 's', messages: _msgs() } });
        var first = m.wsf(chats.s);
        assert.strictEqual(first.length, 0);
        assert.deepStrictEqual(first.pushed, {});
        await m.drain();
        assert.ok(m.calls.sidebar >= 1, 'sidebar re-rendered');
        var ch = m.wsf(chats.s);
        assert.strictEqual(ch.length, 1);
        assert.strictEqual(ch[0].path, 'a.js');
        assert.strictEqual(ch[0].created, true);
        assert.strictEqual(ch[0].args.content, undefined, 'memo holds only the stub args');
        assert.strictEqual(ch.pushed['a.js'].url, 'https://github.com/o/r/pull/7');
        var files = m.files(chats.s);
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].pushedPr.number, 7);
        assert.strictEqual(m.calls.loads, 1);
    }, { tags: ['unit'] });

    test('search memo refreshes when the skeleton signature (_skelScanSig) changes', async function() {
        var chats = { s: _skeleton('s') };
        var rows = { s: { id: 's', messages: _msgs() } };
        var m = await _env(chats, rows);
        assert.strictEqual(m.match(chats.s, 'zebra'), false);
        await m.drain();
        assert.strictEqual(m.match(chats.s, 'zebra'), true);
        assert.strictEqual(m.pending(), 0, 'same signature: answered from the memo, no re-read');
        assert.strictEqual(m.calls.loads, 1);
        // The stored row changes while evicted (rewritten turn): _msgCount bumps.
        rows.s.messages[0] = { role: 'user', content: 'please fix the giraffe bug' };
        rows.s.messages.push({ role: 'assistant', content: 'done' });
        chats.s._msgCount = 5;
        assert.strictEqual(m.match(chats.s, 'zebra'), false, 'stale memo (true) is not served: fallback while re-reading');
        assert.strictEqual(m.pending(), 1, 'signature change queues a fresh read');
        await m.drain();
        assert.strictEqual(m.calls.loads, 2);
        assert.strictEqual(m.match(chats.s, 'zebra'), false, 'new value after the refresh');
        assert.strictEqual(m.calls.loads, 2, 'refreshed memo is reused');
        assert.strictEqual('messages' in chats.s, false);
    }, { tags: ['unit'] });
});
