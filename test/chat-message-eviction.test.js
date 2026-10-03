// MSG-EVICT (memory round 2, fix C1): whole-message eviction core + save
// guards. Evaluates the REAL function texts cut out of the source files
// (same pattern as test/sw-chat-load) with in-memory stand-ins for IDB.

function _cutFns(src, names) {
    return names.map(function(name) {
        var re = new RegExp('^(async )?function ' + name + '\\(', 'm');
        var m = re.exec(src);
        if (!m) throw new Error('function not found: ' + name);
        // Top-level functions close with a column-0 '}' (repo style); a brace
        // counter would trip over regex literals like /\{/ in the bodies.
        var end = src.indexOf('\n}\n', m.index);
        if (end === -1) throw new Error('function end not found: ' + name);
        return src.slice(m.index, end + 2);
    }).join('\n');
}

var CORE_FNS = ['chatMessageCount', 'markChatMessagesDurable', 'chatMessagesDurable', 'evictChatMessagesInPlace',
    '_restoreEvictedChatMessages', 'stripChatPayloadsInPlace', 'chatPayloadRecencyTs', 'chatHasEvictableBodies',
    'sweepColdChatPayloads', 'ensureChatPayloads', '_chatRowPutHandledFields', '_sameChatMsgIdentity',
    '_mergeChatMessagesForPut', '_mergeWidgetIntentsForPut', '_unionChatDisplaysForPut', '_mergeChatRowForPut'];

async function _env(opts) {
    var src = await loadFile('src/js/core/130-indexeddb.js');
    var page = await loadFile('src/js/ui/070-dashboard-ui.js');
    var body = 'var CHAT_MESSAGE_EVICTION_ENABLED = ' + (opts.flag ? 'true' : 'false') + ';\n'
        + 'var CHAT_BODY_EVICT_MIN_CHARS = 512, CHAT_KEEP_HYDRATED = 8;\n'
        + 'var _durableChatMsgArrays = new WeakMap(), _chatHydrationPromises = {};\n'
        + 'var chatStoreName = "chats", chatPayloadsStoreName = "chat_payloads";\n'
        + 'var CHAT_META_TS_FIELDS = [], CHAT_META_FLAG_FIELDS = [];\n'
        + _cutFns(src, CORE_FNS) + '\n' + _cutFns(page, ['_evictChatSeedingFileSum', '_bootMsgWindowOffer']) + '\n'
        + 'return { chatMessageCount: chatMessageCount, markChatMessagesDurable: markChatMessagesDurable,'
        + ' chatMessagesDurable: chatMessagesDurable, evictChatMessagesInPlace: evictChatMessagesInPlace,'
        + ' sweepColdChatPayloads: sweepColdChatPayloads, ensureChatPayloads: ensureChatPayloads,'
        + ' _mergeChatRowForPut: _mergeChatRowForPut, _bootMsgWindowOffer: _bootMsgWindowOffer };';
    var env = opts.env;
    var f = new Function('chats', 'currentChatId', '_chatsHydrated', 'loadChatRowFromDB', 'withStore', 'console', body);
    return f(env.chats, env.currentChatId || null, true, env.loadChatRowFromDB, env.withStore,
        { warn: function() {}, error: function() {}, log: function() {} });
}

function _rows() { return [{ role: 'user', content: 'hi', timestamp: 1 }, { role: 'assistant', content: 'yo', timestamp: 2 }]; }

function _fakeIdb(rows, counter) {
    return {
        loadChatRowFromDB: async function(id) { counter.loads++; await sleep(5); return rows[id] ? JSON.parse(JSON.stringify(rows[id])) : null; },
        withStore: function(stores, mode, fn) {
            return fn({ objectStore: function(name) { return { get: function(id) {
                var req = {};
                setTimeout(function() { req.result = name === 'chats' && rows[id] ? JSON.parse(JSON.stringify(rows[id])) : null; if (req.onsuccess) req.onsuccess(); }, 0);
                return req;
            } }; } });
        }
    };
}

describe('MSG-EVICT core (fix C1)', function() {
    test('flag is ON in source (C2-final)', async function() {
        var src = await loadFile('src/js/core/130-indexeddb.js');
        assert.match(src, /^var CHAT_MESSAGE_EVICTION_ENABLED = true;$/m);
    }, { tags: ['unit'] });

    test('put-merge guard keeps stored messages when the record has none (shared page+SW merge)', async function() {
        var m = await _env({ flag: false, env: { chats: {} } });
        var stored = { id: 'c1', messages: _rows(), title: 'T' };
        var rec = { id: 'c1', title: 'T2', widgets: { w: 1 } };
        var out = m._mergeChatRowForPut(rec, stored);
        assert.strictEqual(out.messages, stored.messages);
        assert.strictEqual(out.title, 'T2');
        assert.strictEqual(rec.messages, undefined, 'never mutates the record in place');
        var full = { id: 'c1', messages: [_rows()[0]] };
        assert.strictEqual(m._mergeChatRowForPut(full, { id: 'c1', messages: [] }).messages.length, 1, 'a record WITH messages still wins');
    }, { tags: ['unit'] });

    test('chatMessageCount works on full chats and skeletons', async function() {
        var m = await _env({ flag: true, env: { chats: {} } });
        assert.strictEqual(m.chatMessageCount({ messages: _rows() }), 2);
        assert.strictEqual(m.chatMessageCount({ _messagesEvicted: true, _msgCount: 7 }), 7);
        assert.strictEqual(m.chatMessageCount({}), 0);
        assert.strictEqual(m.chatMessageCount(null), 0);
    }, { tags: ['unit'] });

    test('flag OFF: eviction and sweep leave messages untouched', async function() {
        var chats = { a: { id: 'a', messages: _rows(), updatedAt: 1 } };
        var m = await _env({ flag: false, env: { chats: chats } });
        m.markChatMessagesDurable(chats.a);
        assert.strictEqual(m.evictChatMessagesInPlace(chats.a), false);
        m.sweepColdChatPayloads(0, true);
        assert.strictEqual(chats.a.messages.length, 2);
        assert.strictEqual(chats.a._messagesEvicted, undefined);
    }, { tags: ['unit'] });

    test('flag ON: sweep evicts proven cold chats, keeps chat-level fields + widgets + _msgCount (copy-on-evict)', async function() {
        var orig = { id: 'a', messages: _rows(), title: 'T', widgets: { w1: { id: 'w1' } }, updatedAt: 1, screenshots: { s: { base64: 'xx' } } };
        var chats = { a: orig, b: { id: 'b', messages: _rows(), updatedAt: 2 }, t: { id: 't', isTemporary: true, messages: _rows() } };
        var m = await _env({ flag: true, env: { chats: chats } });
        m.markChatMessagesDurable(orig);
        m.markChatMessagesDurable(chats.t);
        m.sweepColdChatPayloads(0, true);
        var a = chats.a;
        assert.notStrictEqual(a, orig, 'swapped copy');
        assert.strictEqual(Array.isArray(orig.messages), true, 'original object (maybe a pending put record) keeps its messages');
        assert.strictEqual(a.messages, undefined);
        assert.strictEqual(a._messagesEvicted, true);
        assert.strictEqual(a._payloadsEvicted, true);
        assert.strictEqual(a._msgCount, 2);
        assert.strictEqual(a.title, 'T');
        assert.deepStrictEqual(a.widgets, { w1: { id: 'w1' } });
        assert.strictEqual(chats.b.messages.length, 2, 'no durability proof => never evicted');
        assert.strictEqual(chats.t.messages.length, 2, 'temporary chat never evicted');
    }, { tags: ['unit'] });

    test('flag ON: SW bodyGuard proof also allows eviction; current chat is never evicted', async function() {
        var chats = { a: { id: 'a', messages: _rows(), updatedAt: 1 }, cur: { id: 'cur', messages: _rows(), updatedAt: 0 } };
        chats.cur.__dummy = 1;
        var m = await _env({ flag: true, env: { chats: chats, currentChatId: 'cur' } });
        m.sweepColdChatPayloads(0, true, function() { return true; });
        assert.strictEqual(chats.a._messagesEvicted, true);
        assert.strictEqual(chats.cur.messages.length, 2);
    }, { tags: ['unit'] });

    test('ensureChatPayloads restores messages, de-duplicates, never rejects', async function() {
        var rows = { a: { id: 'a', rev: 3, messages: _rows(), title: 'disk' } };
        var counter = { loads: 0 };
        var io = _fakeIdb(rows, counter);
        var chats = { a: { id: 'a', rev: 3, title: 'mem', _messagesEvicted: true, _msgCount: 2, _payloadsEvicted: true } };
        var m = await _env({ flag: true, env: { chats: chats, loadChatRowFromDB: io.loadChatRowFromDB, withStore: io.withStore } });
        var p1 = m.ensureChatPayloads('a'), p2 = m.ensureChatPayloads('a');
        await Promise.all([p1, p2]);
        assert.strictEqual(counter.loads, 1, 'single-flight: one stored-row read for two callers');
        assert.strictEqual(chats.a.messages.length, 2);
        assert.strictEqual(chats.a._messagesEvicted, undefined);
        assert.strictEqual(chats.a._msgCount, undefined);
        assert.strictEqual(chats.a._payloadsEvicted, undefined);
        assert.strictEqual(chats.a.title, 'mem', 'in-memory chat-level field never regressed');
        assert.strictEqual(m.chatMessagesDurable(chats.a), true, 'restored array carries the proof');
        chats.z = { id: 'z', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 4 };
        await m.ensureChatPayloads('z'); // miss: resolves, keeps flags
        assert.strictEqual(chats.z._messagesEvicted, true);
        assert.strictEqual(chats.z._payloadsEvicted, true);
    }, { tags: ['unit'] });

    test('ensureChatPayloads: a NEWER stored rev fills gaps and wins rev, defined memory fields stay', async function() {
        var rows = { a: { id: 'a', rev: 9, messages: _rows(), title: 'disk', pinned: true } };
        var io = _fakeIdb(rows, { loads: 0 });
        var chats = { a: { id: 'a', rev: 4, title: 'mem', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 1 } };
        var m = await _env({ flag: true, env: { chats: chats, loadChatRowFromDB: io.loadChatRowFromDB, withStore: io.withStore } });
        await m.ensureChatPayloads('a');
        assert.strictEqual(chats.a.messages.length, 2);
        assert.strictEqual(chats.a.rev, 9);
        assert.strictEqual(chats.a.pinned, true);
        assert.strictEqual(chats.a.title, 'mem');
    }, { tags: ['unit'] });

    test('boot window keeps the newest K + current resident and evicts the rest', async function() {
        var chats = {};
        var m = await _env({ flag: true, env: { chats: chats, currentChatId: 'cur' } });
        var win = [], all = [];
        for (var i = 0; i < 12; i++) { var c = { id: 'c' + i, messages: _rows(), updatedAt: i }; all.push(c); m._bootMsgWindowOffer(win, c); }
        var cur = { id: 'cur', messages: _rows(), updatedAt: -1 }; m._bootMsgWindowOffer(win, cur);
        var resident = all.filter(function(c) { return Array.isArray(c.messages); }).map(function(c) { return c.id; });
        assert.deepStrictEqual(resident.sort(), ['c10', 'c11', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
        assert.strictEqual(all[0]._msgCount, 2);
        assert.strictEqual(cur.messages.length, 2);
    }, { tags: ['unit'] });

    test('page blind-put fallback and SW rescue carry the guards (source wiring)', async function() {
        var page = await loadFile('src/js/ui/070-dashboard-ui.js');
        var sw = await loadFile('src/js/worker/115-storage.js');
        assert.match(page, /_metaGet\.onerror = function\(\) \{\s*try \{[\s\S]{0,400}!Array\.isArray\(_putRec\.messages\) \|\| _putRec\.messages\.length === 0\)/);
        assert.match(sw, /else if \(c && c\._messagesEvicted && c\._dirtyWhileEvicted\) _rescueDirtyEvictedChat\(id\);/);
    }, { tags: ['unit'] });
});
