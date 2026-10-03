// C2-store: skeleton-safe chats store (cold-chat message eviction).
// A: evictChatMessagesInPlace stamps _evictedPayloadRefs; B: restore + the
// ensureChatPayloads stale-flag branch clear it; C: chatReferencedPayloadIds
// (null = refs unknown); D: sweepOrphanChatPayloads unions the stamp and
// skips on unknown refs; E: deleteChatRow unions the stamp (record +
// survivors) and reaps nothing on unknown refs; bug 11: unmark durability.
// Evaluates the REAL function texts cut out of the source (same pattern as
// test/chat-message-eviction.test.js) with in-memory stand-ins for IDB.

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
var CORE_FNS = ['chatMessageCount', 'markChatMessagesDurable', 'chatMessagesDurable', 'unmarkChatMessagesDurable',
    'chatReferencedPayloadIds', 'evictChatMessagesInPlace', '_restoreEvictedChatMessages', 'stripChatPayloadsInPlace',
    'chatPayloadRecencyTs', 'chatHasEvictableBodies', 'sweepColdChatPayloads', 'ensureChatPayloads',
    'sweepOrphanChatPayloads', 'deleteChatRow'];

// env: { flag, chats, withStore, loadChatRowFromDB, preconditions }
async function _env(env) {
    var src = await loadFile('src/js/core/130-indexeddb.js');
    var page = await loadFile('src/js/ui/070-dashboard-ui.js');
    var body = 'var CHAT_MESSAGE_EVICTION_ENABLED = ' + (env.flag ? 'true' : 'false') + ';\n'
        + 'var CHAT_BODY_EVICT_MIN_CHARS = 512, CHAT_KEEP_HYDRATED = 8, DB_PAYLOAD_GC_MIN_AGE_MS = 1000;\n'
        + 'var _durableChatMsgArrays = new WeakMap(), _chatHydrationPromises = {}, _persistedPayloadIds = {};\n'
        + 'var chatStoreName = "chats", chatPayloadsStoreName = "chat_payloads", _dbIsWorkerRealm = false;\n'
        + 'var CHAT_META_TS_FIELDS = [], CHAT_META_FLAG_FIELDS = [];\n'
        + 'var IDBKeyRange = { upperBound: function(x) { return x; } };\n'
        + 'function _recordChatDelete() {}\nfunction _chatDeleteEvidenceDigest() { return {}; }\n'
        + _cutFns(src, CORE_FNS) + '\n' + _cutFns(page, ['_chatPayloadIdsFor']) + '\n'
        + 'return { markChatMessagesDurable: markChatMessagesDurable, chatMessagesDurable: chatMessagesDurable,'
        + ' unmarkChatMessagesDurable: unmarkChatMessagesDurable, chatReferencedPayloadIds: chatReferencedPayloadIds,'
        + ' evictChatMessagesInPlace: evictChatMessagesInPlace, _restoreEvictedChatMessages: _restoreEvictedChatMessages,'
        + ' ensureChatPayloads: ensureChatPayloads, sweepOrphanChatPayloads: sweepOrphanChatPayloads, deleteChatRow: deleteChatRow };';
    var f = new Function('chats', 'currentChatId', '_chatsHydrated', 'loadChatRowFromDB', 'withStore',
        'CHAT_ROW_DELETE_PRECONDITIONS', 'console', body);
    return f(env.chats || {}, null, true, env.loadChatRowFromDB || function() { return Promise.resolve(null); },
        env.withStore || function() { return Promise.resolve(); },
        env.preconditions || { t: function() { return null; } }, NOOP_CONSOLE);
}

function _msgs() {
    return [{ role: 'user', content: 'hi', file_id: 'f1' }, { role: 'tool', content: 'x', screenshot_id: 's1' },
        { role: 'assistant', content: 'yo' }];
}
function _sorted(o) { return Object.keys(o).sort(); }

// chat_payloads key cursor over `keys` (all older than the cutoff).
function _sweepStore(keys, log) {
    return function(names, mode, fn) {
        log.calls++;
        var tx = { objectStore: function() { return {
            index: function() { return { openKeyCursor: function() {
                var req = {}, i = 0;
                function step() {
                    setTimeout(function() {
                        if (i >= keys.length) { req.onsuccess({ target: { result: null } }); return; }
                        var k = keys[i++];
                        req.onsuccess({ target: { result: { primaryKey: k, continue: step } } });
                    }, 0);
                }
                step();
                return req;
            } }; },
            delete: function(k) { log.deleted.push(k); }
        }; } };
        return Promise.resolve(fn(tx));
    };
}

// One readwrite tx: get(chatId) -> stored, deletes logged as 'store:id'.
function _deleteStore(stored, log) {
    return function(names, mode, fn) {
        log.names = names;
        var tx = {};
        tx.objectStore = function(name) { return {
            get: function() {
                var req = {};
                setTimeout(function() { req.result = stored; req.onsuccess(); setTimeout(function() { tx.oncomplete(); }, 0); }, 0);
                return req;
            },
            delete: function(id) { log.deleted.push(name + ':' + id); }
        }; };
        return Promise.resolve(fn(tx));
    };
}

describe('C2-store: skeleton-safe chats store', function() {
    test('A: eviction stamps the referenced payload ids; flag off leaves the chat untouched', async function() {
        var on = await _env({ flag: true });
        var c = { id: 'a', messages: _msgs() };
        assert.strictEqual(on.evictChatMessagesInPlace(c), true);
        assert.strictEqual(c.messages, undefined);
        assert.deepStrictEqual(_sorted(c._evictedPayloadRefs), ['f1', 's1']);
        assert.strictEqual(c._msgCount, 3);
        var off = await _env({ flag: false });
        var d = { id: 'b', messages: _msgs() };
        assert.strictEqual(off.evictChatMessagesInPlace(d), false);
        assert.strictEqual(d._evictedPayloadRefs, undefined);
        assert.strictEqual(d.messages.length, 3);
    }, { tags: ['unit'] });

    test('B: restore clears the stamp', async function() {
        var m = await _env({ flag: true });
        var c = { id: 'a', messages: _msgs() };
        m.evictChatMessagesInPlace(c);
        assert.strictEqual(m._restoreEvictedChatMessages(c, { id: 'a', messages: _msgs() }), true);
        assert.strictEqual(c._evictedPayloadRefs, undefined);
        assert.strictEqual(c._messagesEvicted, undefined);
        assert.strictEqual(m.chatMessagesDurable(c), true);
    }, { tags: ['unit'] });

    test('B: ensureChatPayloads stale-flag branch clears the stamp', async function() {
        var chats = { a: { id: 'a', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 3, _evictedPayloadRefs: { f1: true } } };
        var m = await _env({ flag: true, chats: chats,
            loadChatRowFromDB: async function() {
                // A fuller copy (still carrying stale flags) replaces the skeleton mid-read.
                chats.a = { id: 'a', messages: _msgs(), _messagesEvicted: true, _msgCount: 3, _evictedPayloadRefs: { f1: true } };
                return null;
            },
            withStore: function(n, mode, fn) { return fn({ objectStore: function() { return { get: function() {
                var req = {}; setTimeout(function() { req.result = null; if (req.onsuccess) req.onsuccess(); }, 0); return req;
            } }; } }); } });
        await m.ensureChatPayloads('a');
        assert.strictEqual(chats.a._evictedPayloadRefs, undefined);
        assert.strictEqual(chats.a._messagesEvicted, undefined);
        assert.strictEqual(chats.a.messages.length, 3);
    }, { tags: ['unit'] });

    test('C: chatReferencedPayloadIds unions messages, stamp and screenshots; null when unknown', async function() {
        var m = await _env({ flag: false });
        assert.deepStrictEqual(_sorted(m.chatReferencedPayloadIds({ messages: _msgs(), screenshots: { s9: {} } })), ['f1', 's1', 's9']);
        assert.deepStrictEqual(_sorted(m.chatReferencedPayloadIds({ _messagesEvicted: true, _payloadsEvicted: true, _evictedPayloadRefs: { f2: true }, screenshots: { s9: {} } })), ['f2', 's9']);
        assert.deepStrictEqual(_sorted(m.chatReferencedPayloadIds({ _messagesEvicted: true, _evictedPayloadRefs: {} })), []);
        assert.strictEqual(m.chatReferencedPayloadIds({ _messagesEvicted: true, _payloadsEvicted: true }), null);
        assert.strictEqual(m.chatReferencedPayloadIds({ _payloadsEvicted: true }), null, 'stripped skeleton copy: refs unknown');
        assert.deepStrictEqual(m.chatReferencedPayloadIds({ id: 'plain' }), {}, 'non-evicted chat without messages is known-empty');
        assert.deepStrictEqual(m.chatReferencedPayloadIds(null), {});
    }, { tags: ['unit'] });

    test('bug 11: unmarkChatMessagesDurable clears the proof after a same-length in-place edit', async function() {
        var m = await _env({ flag: true });
        var c = { id: 'a', messages: _msgs() };
        assert.strictEqual(m.markChatMessagesDurable(c), true);
        assert.strictEqual(m.chatMessagesDurable(c), true);
        c.messages[2] = { role: 'assistant', content: 'edited card' }; // same length, same array
        assert.strictEqual(m.chatMessagesDurable(c), true, 'length-only proof cannot see the edit');
        assert.strictEqual(m.unmarkChatMessagesDurable(c), true);
        assert.strictEqual(m.chatMessagesDurable(c), false);
        assert.strictEqual(m.unmarkChatMessagesDurable({ _messagesEvicted: true }), false);
        assert.strictEqual(m.unmarkChatMessagesDurable(null), false);
    }, { tags: ['unit'] });

    test('D: orphan sweep keeps blobs referenced only by a stamped skeleton', async function() {
        var log = { calls: 0, deleted: [] };
        var chats = {
            a: { id: 'a', messages: [{ role: 'user', file_id: 'f1' }] },
            b: { id: 'b', _messagesEvicted: true, _payloadsEvicted: true, _evictedPayloadRefs: { f2: true, s2: true } }
        };
        var m = await _env({ flag: true, chats: chats, withStore: _sweepStore(['f1', 'f2', 's2', 'orphan'], log) });
        var n = await m.sweepOrphanChatPayloads();
        assert.strictEqual(n, 1);
        assert.deepStrictEqual(log.deleted, ['orphan']);
    }, { tags: ['unit'] });

    test('D: orphan sweep skips the whole pass when any chat has unknown refs', async function() {
        var log = { calls: 0, deleted: [] };
        var chats = {
            a: { id: 'a', messages: [{ role: 'user', file_id: 'f1' }] },
            c: { id: 'c', _messagesEvicted: true, _payloadsEvicted: true } // unstamped skeleton
        };
        var m = await _env({ flag: true, chats: chats, withStore: _sweepStore(['f1', 'orphan'], log) });
        assert.strictEqual(await m.sweepOrphanChatPayloads(), 0);
        assert.strictEqual(log.calls, 0, 'no IDB transaction opened');
        assert.deepStrictEqual(log.deleted, []);
    }, { tags: ['unit'] });

    test('E: deleteChatRow — a skeleton survivor protects a shared blob', async function() {
        var log = { deleted: [] };
        var record = { id: 'a', messages: [{ file_id: 'f1' }, { file_id: 'f2' }] };
        var chats = { b: { id: 'b', _messagesEvicted: true, _payloadsEvicted: true, _evictedPayloadRefs: { f2: true } } };
        var m = await _env({ chats: chats, withStore: _deleteStore({ id: 'a', messages: [] }, log) });
        assert.strictEqual(await m.deleteChatRow('a', 't', { record: record }), true);
        assert.deepStrictEqual(log.deleted.sort(), ['chat_payloads:f1', 'chats:a']);
    }, { tags: ['unit'] });

    test('E: deleteChatRow — unknown survivor refs reap nothing (row still deleted)', async function() {
        var log = { deleted: [] };
        var record = { id: 'a', messages: [{ file_id: 'f1' }] };
        var chats = { c: { id: 'c', _messagesEvicted: true, _payloadsEvicted: true } };
        var m = await _env({ chats: chats, withStore: _deleteStore({ id: 'a' }, log) });
        assert.strictEqual(await m.deleteChatRow('a', 't', { record: record }), true);
        assert.deepStrictEqual(log.deleted, ['chats:a']);
    }, { tags: ['unit'] });

    test('E: deleteChatRow — skeleton record: stamp reaped, unknown refs reap nothing', async function() {
        var log = { deleted: [] };
        var m = await _env({ chats: {}, withStore: _deleteStore({ id: 'a' }, log) });
        var stamped = { id: 'a', _messagesEvicted: true, _payloadsEvicted: true, _evictedPayloadRefs: { f3: true } };
        assert.strictEqual(await m.deleteChatRow('a', 't', { record: stamped }), true);
        assert.deepStrictEqual(log.deleted.sort(), ['chat_payloads:f3', 'chats:a']);
        var log2 = { deleted: [] };
        var m2 = await _env({ chats: {}, withStore: _deleteStore({ id: 'a' }, log2) });
        var unknown = { id: 'a', _messagesEvicted: true, _payloadsEvicted: true, screenshots: { s1: {} } };
        assert.strictEqual(await m2.deleteChatRow('a', 't', { record: unknown }), true);
        assert.deepStrictEqual(log2.names, ['chats'], 'no chat_payloads store opened');
        assert.deepStrictEqual(log2.deleted, ['chats:a']);
    }, { tags: ['unit'] });

    test('F: empty-row precondition refuses a message-less row flagged _payloadsEvicted', async function() {
        var src = await loadFile('src/js/core/130-indexeddb.js');
        var i = src.indexOf("'empty-row': function(stored, evidence, chatId) {");
        assert.ok(i > 0);
        var block = src.slice(i, src.indexOf('\n    },', i));
        assert.match(block, /if \(stored\._payloadsEvicted === true\) \{\n\s+return '/);
    }, { tags: ['unit'] });
});
