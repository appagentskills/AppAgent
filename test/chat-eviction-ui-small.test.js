// C2-ui small sites: skeleton-safe consumers (cold-chat message eviction).
// A skeleton has no `messages` key, `_messagesEvicted` + `_msgCount` set; the
// full row lives in IDB. Covers ui/030 getRecentUserPrompts (SKEL-SCAN slot
// 'firstPrompt' + in-place Recent strip refresh), ui/260 updateChatTitle
// (no TypeError, no title from nothing), ui/290 _sidebarPayload (hydrates a
// skeleton before picking), ui/320 kbdCopyLastResponse (hydrate + retry, fail
// closed). Evaluates the REAL function texts cut out of the sources (same
// pattern as test/chat-eviction-store.test.js) with in-memory stand-ins.

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
function _tick(n) {
    var p = Promise.resolve();
    for (var i = 0; i < (n || 6); i++) p = p.then(function() {});
    return p;
}
function _skel(extra) {
    var c = { _messagesEvicted: true, _msgCount: 2, rev: 1, updatedAt: 10 };
    Object.keys(extra || {}).forEach(function(k) { c[k] = extra[k]; });
    return c;
}

// ui/030 + the real ui/120 SKEL-SCAN helper. withScan=false drops
// skeletonScanValue (realm without ui/120): skeletons are just skipped.
async function _homeEnv(chats, rowFor, withScan) {
    var home = await loadFile('src/js/ui/030-home-view.js');
    var utils = await loadFile('src/js/ui/120-ui-utils.js');
    var s = { reads: [], sections: 0 };
    var doc = {
        querySelector: function(sel) { if (sel === '#home-content .home-search-section') s.sections++; return null; },
        getElementById: function() { return null; }
    };
    var body = 'var _skelScanMemo = {}, _skelScanWant = {}, _skelScanQueue = [], _skelScanBusy = false, _skelScanRerenders = [], _skelScanTimer = null;\n'
        + 'function chatMessageCount(c) { return !c ? 0 : Array.isArray(c.messages) ? c.messages.length : (c._msgCount || 0); }\n'
        + 'function escapeHtml(x) { return String(x); }\nfunction escapeJsString(x) { return String(x); }\nfunction t(x) { return x; }\n'
        + _cutFns(home, ['getRecentUserPrompts', '_firstUserPromptText', '_homeRecentPromptsHtml', '_refreshHomeRecentPrompts', '_insertRecentPrompt', 'truncateText']) + '\n'
        + (withScan ? _cutFns(utils, ['_isSkeletonChat', '_skelScanSig', '_skelClone', 'skeletonScanValue', '_skelScanPump']) + '\n' : '')
        + 'return { getRecentUserPrompts: getRecentUserPrompts };';
    var f = new Function('chats', 'document', 'loadChatRowFromDB', 'setTimeout', 'clearTimeout', body);
    s.m = f(chats, doc, function(id) { s.reads.push(id); return Promise.resolve(rowFor(id)); },
        function(fn) { fn(); return 1; }, function() {});
    return s;
}

describe('C2-ui small › ui/030 getRecentUserPrompts on skeletons', function() {
    test('skeleton: fallback first, ONE transient row read, strip refresh, then its prompt; never writes messages', async function() {
        var chats = {
            a: { id: 'a', createdAt: 1, messages: [{ role: 'user', content: 'old' }] },
            k: _skel({ id: 'k', createdAt: 5 })
        };
        var s = await _homeEnv(chats, function(id) {
            return id === 'k' ? { id: 'k', messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: ' cold ' }] } : null;
        }, true);
        assert.deepStrictEqual(s.m.getRecentUserPrompts(4), [{ text: 'old', chatId: 'a' }]);
        await _tick();
        assert.deepStrictEqual(s.reads, ['k']);
        assert.ok(s.sections >= 1, 'Recent strip refresh hook ran');
        assert.strictEqual('messages' in chats.k, false, 'skeleton stays a skeleton');
        assert.deepStrictEqual(s.m.getRecentUserPrompts(4), [{ text: 'cold', chatId: 'k' }, { text: 'old', chatId: 'a' }]);
        assert.deepStrictEqual(s.reads, ['k'], 'memo hit: no second read');
    }, { tags: ['unit'] });
    test('row miss: skeleton skipped, no throw, no retry loop', async function() {
        var chats = { a: { id: 'a', createdAt: 1, messages: [{ role: 'user', content: 'old' }] }, k: _skel({ id: 'k', createdAt: 5 }) };
        var s = await _homeEnv(chats, function() { return null; }, true);
        s.m.getRecentUserPrompts(4);
        await _tick();
        assert.deepStrictEqual(s.m.getRecentUserPrompts(4), [{ text: 'old', chatId: 'a' }]);
        assert.deepStrictEqual(s.reads, ['k']);
        assert.strictEqual('messages' in chats.k, false);
    }, { tags: ['unit'] });
    test('hydrated chats unchanged; no SKEL-SCAN helper -> skeleton skipped', async function() {
        var chats = {
            a: { id: 'a', createdAt: 1, messages: [{ role: 'user', content: 'old' }] },
            b: { id: 'b', createdAt: 3, messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: ' new ' }] },
            c: { id: 'c', createdAt: 2, messages: [{ role: 'user', content: 'new' }] },
            s: { id: 's', createdAt: 9, isSubAgent: true, messages: [{ role: 'user', content: 'sub' }] },
            k: _skel({ id: 'k', createdAt: 7 })
        };
        var s = await _homeEnv(chats, function() { return null; }, false);
        assert.deepStrictEqual(s.m.getRecentUserPrompts(5), [{ text: 'new', chatId: 'b' }, { text: 'old', chatId: 'a' }]);
        assert.deepStrictEqual(s.reads, []);
    }, { tags: ['unit'] });
});

describe('C2-ui small › ui/260 updateChatTitle', function() {
    async function env() {
        var src = await loadFile('src/js/ui/260-content-format.js');
        var s = { meta: [], lists: 0 };
        var f = new Function('dispatchChatMeta', 'renderChatList', 'updateChatTitleHeader', 'saveChatsToStorage',
            _cutFns(src, ['updateChatTitle']) + '\nreturn updateChatTitle;');
        s.fn = f(function(id, m) { s.meta.push([id, m]); }, function() { s.lists++; }, function() {}, function() {});
        return s;
    }
    test('skeleton with New Chat title: no TypeError, no provisional title', async function() {
        var s = await env();
        var k = _skel({ id: 'k', title: 'New Chat' });
        var threw = null;
        try { s.fn(k); } catch (e) { threw = e; }
        assert.strictEqual(threw, null);
        assert.deepStrictEqual(s.meta, []);
        assert.strictEqual(k.title, 'New Chat');
        assert.strictEqual('messages' in k, false);
    }, { tags: ['unit'] });
    test('hydrated new chat still gets the provisional title', async function() {
        var s = await env();
        s.fn({ id: 'h', title: 'New Chat', messages: [{ role: 'user', content: ' hello  world ' }] });
        assert.deepStrictEqual(s.meta, [['h', { title: 'hello world', titleProvisional: true }]]);
        assert.strictEqual(s.lists, 1);
    }, { tags: ['unit'] });
});

describe('C2-ui small › ui/290 _sidebarPayload', function() {
    async function env(chats, onEnsure) {
        var src = await loadFile('src/js/ui/290-screenshot-ui.js');
        var s = { ensures: [], snacks: [] };
        var f = new Function('chats', 'currentChatId', 'ensureChatPayloads', 'showSnackbar', 't',
            _cutFns(src, ['_sidebarPayload', 'getScreenshotList']) + '\nreturn { p: _sidebarPayload, list: getScreenshotList };');
        s.m = f(chats, 'c1', async function(id) { s.ensures.push(id); await Promise.resolve(); if (onEnsure) onEnsure(id); },
            function(msg, type) { s.snacks.push([msg, type]); }, function(x) { return x; });
        return s;
    }
    test('skeleton: hydrates first, then picks the restored payload', async function() {
        var chats = { c1: _skel({ id: 'c1' }) };
        var s = await env(chats, function(id) {
            chats[id] = { id: id, messages: [{ role: 'screenshot', base64: 'data:image/png;base64,AA' }] };
        });
        assert.deepStrictEqual(s.m.list(), [], 'skeleton list is empty, no throw');
        var m = await s.m.p('screenshot', '0', 'base64');
        assert.deepStrictEqual(s.ensures, ['c1']);
        assert.strictEqual(m && m.base64, 'data:image/png;base64,AA');
        assert.deepStrictEqual(s.snacks, []);
    }, { tags: ['unit'] });
    test('skeleton hydrate miss: warning, null, messages never written', async function() {
        var chats = { c1: _skel({ id: 'c1' }) };
        var s = await env(chats, null);
        var m = await s.m.p('screenshot', '0', 'base64');
        assert.strictEqual(m, null);
        assert.deepStrictEqual(s.snacks, [['Attachment not available (still loading or removed)', 'warning']]);
        assert.strictEqual('messages' in chats.c1, false);
    }, { tags: ['unit'] });
    test('hydrated chat without the row: unchanged (no hydrate call)', async function() {
        var s = await env({ c1: { id: 'c1', messages: [] } }, null);
        assert.strictEqual(await s.m.p('screenshot', '0', 'base64'), null);
        assert.deepStrictEqual(s.ensures, []);
    }, { tags: ['unit'] });
});

describe('C2-ui small › ui/320 kbdCopyLastResponse', function() {
    async function env(chats, onEnsure) {
        var src = await loadFile('src/js/ui/320-keyboard-shortcuts.js');
        var s = { ensures: [], snacks: [], copies: [] };
        var f = new Function('chats', 'currentChatId', 'ensureChatPayloads', 'showSnackbar', 't', 'copyAiMessage',
            _cutFns(src, ['kbdCopyLastResponse']) + '\nreturn kbdCopyLastResponse;');
        s.fn = f(chats, 'c1', async function(id) { s.ensures.push(id); await Promise.resolve(); if (onEnsure) onEnsure(id); },
            function(msg, type) { s.snacks.push([msg, type]); }, function(x) { return x; }, function(i) { s.copies.push(i); });
        return s;
    }
    var MSGS = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
    test('skeleton: hydrates, then copies the last response', async function() {
        var chats = { c1: _skel({ id: 'c1' }) };
        var s = await env(chats, function(id) { chats[id] = { id: id, messages: MSGS.slice() }; });
        assert.strictEqual(s.fn(), true);
        await _tick(10);
        assert.deepStrictEqual(s.ensures, ['c1']);
        assert.deepStrictEqual(s.copies, [0]);
        assert.deepStrictEqual(s.snacks, []);
    }, { tags: ['unit'] });
    test('skeleton hydrate miss: Copy failed toast, no copy, no messages written', async function() {
        var chats = { c1: _skel({ id: 'c1' }) };
        var s = await env(chats, null);
        assert.strictEqual(s.fn(), true);
        await _tick(10);
        assert.deepStrictEqual(s.copies, []);
        assert.deepStrictEqual(s.snacks, [['Copy failed', 'error']]);
        assert.strictEqual('messages' in chats.c1, false);
    }, { tags: ['unit'] });
    test('rejecting hydrate emits exactly Copy failed/error without copying', async function() {
        function deferred() { var d = {}; d.promise = new Promise(function(r, j) { d.resolve = r; d.reject = j; }); return d; }
        var gate = deferred(), entered = deferred(), tail;
        var chats = { c1: _skel({ id: 'c1' }) }, snacks = [], copies = [], ensures = [];
        // Observe the real fire-and-forget chain rather than guessing microtask
        // counts. Native Promise.catch delegates to the observed then method.
        function track(p) {
            p.then = function(ok, fail) { tail = track(Promise.prototype.then.call(p, ok, fail)); return tail; };
            return p;
        }
        var src = await loadFile('src/js/ui/320-keyboard-shortcuts.js');
        var fn = new Function('chats', 'currentChatId', 'ensureChatPayloads', 'showSnackbar', 't', 'copyAiMessage', 'Promise',
            _cutFns(src, ['kbdCopyLastResponse']) + '\nreturn kbdCopyLastResponse;')(
                chats, 'c1', function(id) { ensures.push(id); entered.resolve(); return gate.promise; },
                function(msg, kind) { snacks.push([msg, kind]); }, function(x) { return x; },
                function(i) { copies.push(i); }, { resolve: function() { return track(Promise.resolve()); } });
        assert.strictEqual(fn(), true);
        var completed = tail;
        await entered.promise;
        assert.deepStrictEqual(snacks, []);
        gate.reject(new Error('idb boom'));
        await completed;
        assert.deepStrictEqual(ensures, ['c1']);
        assert.deepStrictEqual(snacks, [['Copy failed', 'error']]);
        assert.deepStrictEqual(copies, []);
        assert.strictEqual(chats.c1.messages, undefined);
    }, { tags: ['unit'] });
    test('hydrated chat: synchronous copy as before; empty chat says no response', async function() {
        var s = await env({ c1: { id: 'c1', messages: MSGS.slice() } }, null);
        assert.strictEqual(s.fn(), true);
        assert.deepStrictEqual(s.copies, [0]);
        assert.deepStrictEqual(s.ensures, []);
        var e = await env({ c1: { id: 'c1', messages: [] } }, null);
        assert.strictEqual(e.fn(), false);
        assert.strictEqual(e.snacks[0][0], 'No response to copy yet');
    }, { tags: ['unit'] });
});
