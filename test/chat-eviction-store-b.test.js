// C2-store part B: worker/120 `.messages` sites are skeleton-safe (hydrate
// first, never seed `[]` onto a message-evicted chat), and deleteChatRow's
// survivor loop skips null/undefined slots explicitly instead of relying on a
// caught TypeError. Evaluates the REAL function texts cut out of the source
// (same pattern as test/chat-eviction-store.test.js) with in-memory stubs.

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
function _tick() { return new Promise(function(r) { setTimeout(r, 0); }); }
async function _flush() { for (var i = 0; i < 5; i++) await _tick(); }

var NOOP_CONSOLE = { warn: function() {}, error: function() {}, log: function() {} };
var W120_FNS = ['_sw120IsMsgSkeleton', '_sw120HydrateThen', '_swSeedPromptRow', '_swSettleRemotePrompt',
    '_swIsStopPhrase', '_swAnswerPendingPromptViaChat', '_swSeedApprovalRow', '_swSettleApprovalRow',
    'abandonPendingUIToolCall', '_abandonSkeletonRow'];

// env: { chats, stored: {id: messages[]}, hydrateFails, pending, parked }
async function _w120(env) {
    var src = await loadFile('src/js/worker/120-tool-routing.js');
    var st = { saves: 0, emits: [], hydrates: [], resolved: [] };
    var chats = env.chats;
    var body = 'var _SW_STOP_PHRASE_RE = /^\\s*(?:stop|cancel|no)\\s*[.!,]*\\s*$/i;\n'
        + _cutFns(src, W120_FNS) + '\n'
        + 'return { seedPrompt: _swSeedPromptRow, settleRemote: _swSettleRemotePrompt, answerViaChat: _swAnswerPendingPromptViaChat,'
        + ' seedApproval: _swSeedApprovalRow, settleApproval: _swSettleApprovalRow, abandon: abandonPendingUIToolCall };';
    var f = new Function('chats', 'ensureChatPayloads', 'saveChatsToStorage', 'AgentEvents', '_pendingUIToolCalls',
        'parkedToolCallsByChatId', 'resolvePendingUIToolCall', 'cancelParkedToolCall', '_swCancelApprovalsFor',
        'scheduleAdoptedEviction', 'console', body);
    var api = f(chats,
        function(id) {
            st.hydrates.push(id);
            return Promise.resolve().then(function() {
                var c = chats[id];
                if (env.hydrateFails || !c || Array.isArray(c.messages)) return;
                c.messages = (env.stored && env.stored[id]) || [];
                delete c._messagesEvicted; delete c._msgCount; delete c._evictedPayloadRefs;
            });
        },
        function() { st.saves++; },
        { emit: function(t, p) { st.emits.push(t + ':' + (p && (p.reason || p.status))); } },
        env.pending || {}, env.parked || {},
        function(id, r) { st.resolved.push(id); },
        function() {}, function() {}, function() {}, NOOP_CONSOLE);
    api.st = st;
    return api;
}
function _skel(id) { return { id: id, title: 'T', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 2 }; }
function _hist() { return [{ role: 'user', content: 'q' }, { role: 'tool', tool_call_id: 'tc1', content: '' }]; }

describe('C2-store B: worker/120 skeleton-safe .messages sites', function() {
    test('seed prompt row on a skeleton hydrates first and splices into the restored history', async function() {
        var chats = { a: _skel('a') };
        var w = await _w120({ chats: chats, stored: { a: _hist() } });
        w.seedPrompt('a', { role: 'prompt_user', promptId: 'p1', toolCallId: 'tc1', status: 'pending' });
        assert.strictEqual(chats.a.messages, undefined, 'never seeds [] synchronously onto a skeleton');
        assert.strictEqual(w.st.saves, 0);
        await _flush();
        assert.deepStrictEqual(w.st.hydrates, ['a']);
        assert.strictEqual(chats.a.messages.length, 3);
        assert.strictEqual(chats.a.messages[1].promptId, 'p1', 'spliced before the tool placeholder');
        assert.strictEqual(w.st.saves, 1);
    }, { tags: ['unit'] });

    test('seed rows: failed hydration writes nothing (no [] history, no save)', async function() {
        var chats = { a: _skel('a') };
        var w = await _w120({ chats: chats, hydrateFails: true });
        w.seedPrompt('a', { role: 'prompt_user', promptId: 'p1', status: 'pending' });
        w.seedApproval('a', { role: 'approval', toolCallId: 'tc9', status: 'pending' });
        await _flush();
        assert.strictEqual(Object.prototype.hasOwnProperty.call(chats.a, 'messages'), false);
        assert.strictEqual(w.st.saves, 0);
        assert.deepStrictEqual(w.st.emits, []);
    }, { tags: ['unit'] });

    test('non-skeleton chats: no hydration, unchanged synchronous behaviour', async function() {
        var chats = { a: { id: 'a', messages: _hist() }, b: { id: 'b' } };
        var w = await _w120({ chats: chats });
        w.seedPrompt('a', { role: 'prompt_user', promptId: 'p1', toolCallId: 'tc1', status: 'pending' });
        assert.strictEqual(chats.a.messages[1].promptId, 'p1');
        w.seedApproval('b', { role: 'approval', toolCallId: 'tc2', status: 'pending' });
        assert.strictEqual(chats.b.messages.length, 1, 'plain chat without messages still gets a fresh array');
        w.settleApproval('a', 'tc1', 'allowed', true);
        assert.deepStrictEqual(w.st.hydrates, []);
        assert.ok(w.st.emits.indexOf('approvalSettled:allowed') >= 0);
    }, { tags: ['unit'] });

    test('seed + settle approval row on a skeleton flips the persisted row', async function() {
        var hist = _hist().concat([{ role: 'approval', toolCallId: 'tc5', status: 'pending' }]);
        var chats = { a: _skel('a') };
        var w = await _w120({ chats: chats, stored: { a: hist } });
        w.settleApproval('a', 'tc5', 'allowed', true);
        assert.deepStrictEqual(w.st.emits, [], 'deferred until hydrated');
        await _flush();
        assert.strictEqual(chats.a.messages[2].status, 'allowed');
        assert.strictEqual(w.st.saves, 1);
        assert.deepStrictEqual(w.st.emits, ['approvalSettled:allowed']);
        var chats2 = { b: _skel('b') };
        var w2 = await _w120({ chats: chats2, stored: { b: _hist() } });
        w2.seedApproval('b', { role: 'approval', toolCallId: 'tc6', status: 'pending' });
        await _flush();
        assert.strictEqual(chats2.b.messages.length, 3);
        assert.strictEqual(chats2.b.messages[2].toolCallId, 'tc6');
    }, { tags: ['unit'] });

    test('remote prompt settle on a skeleton keeps first-submit-wins on the restored row', async function() {
        var hist = [{ role: 'prompt_user', promptId: 'p1', toolCallId: 'tc1', status: 'pending' }];
        var chats = { a: _skel('a') };
        var pending = { tc1: { name: 'prompt_user' } };
        var w = await _w120({ chats: chats, stored: { a: hist }, pending: pending });
        w.settleRemote({ chatId: 'a', promptId: 'p1', result: { success: true, values: { x: 1 } } }, null);
        assert.deepStrictEqual(w.st.resolved, [], 'deferred until hydrated');
        await _flush();
        assert.strictEqual(chats.a.messages[0].status, 'submitted');
        assert.deepStrictEqual(chats.a.messages[0].values, { x: 1 });
        assert.deepStrictEqual(w.st.resolved, ['tc1']);
    }, { tags: ['unit'] });

    test('answer-via-chat on a skeleton returns false (interrupt lane) without hydrating', async function() {
        var chats = { a: _skel('a') };
        var w = await _w120({ chats: chats });
        assert.strictEqual(w.answerViaChat('a', 'yes please'), false);
        assert.deepStrictEqual(w.st.hydrates, []);
        assert.strictEqual(chats.a.messages, undefined);
    }, { tags: ['unit'] });

    test('abandon on a skeleton resolves now, then flips the row + forwards after hydrate', async function() {
        var hist = [{ role: 'prompt_user', promptId: 'p7', toolCallId: 'tc7', status: 'pending' }];
        var chats = { a: _skel('a') };
        var posted = [];
        var resolved = [];
        var pending = { tc7: { name: 'prompt_user', port: { postMessage: function(m) { posted.push(m); } },
            resolve: function(r) { resolved.push(r); } } };
        var w = await _w120({ chats: chats, stored: { a: hist }, pending: pending });
        w.abandon('a', 'tc7', 'test');
        assert.strictEqual(resolved.length, 1, 'call settled synchronously');
        assert.strictEqual(pending.tc7, undefined);
        await _flush();
        assert.strictEqual(chats.a.messages[0].status, 'cancelled');
        assert.strictEqual(chats.a.messages[0].abandoned, true);
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].promptId, 'p7');
        assert.ok(w.st.emits.indexOf('messagesAppended:prompt-user-abandoned') >= 0);
    }, { tags: ['unit'] });

    test('executeTool mirror + approval stub hydrate a skeleton before reading messages', async function() {
        var src = await loadFile('src/js/worker/120-tool-routing.js');
        var guard = src.indexOf('&& (result._message_persist || result._display_persist || result._widget_render)');
        var mirror = src.indexOf('if (result._message_persist && chats[chatId].messages)');
        assert.ok(guard > 0 && mirror > guard, 'hydrate guard precedes the _message_persist mirror');
        assert.ok(src.slice(guard, mirror).indexOf('await ensureChatPayloads(chatId)') > 0);
        var ap = src.indexOf('if (chat && Array.isArray(chat.messages) && toolCallId) {');
        assert.ok(ap > 0);
        assert.ok(src.slice(ap - 600, ap).indexOf('await ensureChatPayloads(targetChatId)') > 0);
    }, { tags: ['unit'] });
});

// ── deleteChatRow survivor loop ──
var CORE_FNS = ['chatReferencedPayloadIds', 'deleteChatRow'];
async function _core(env) {
    var src = await loadFile('src/js/core/130-indexeddb.js');
    var page = await loadFile('src/js/ui/070-dashboard-ui.js');
    var body = 'var chatStoreName = "chats", chatPayloadsStoreName = "chat_payloads", _dbIsWorkerRealm = false;\n'
        + 'function _recordChatDelete() {}\nfunction _chatDeleteEvidenceDigest() { return {}; }\n'
        + _cutFns(src, CORE_FNS) + '\n' + _cutFns(page, ['_chatPayloadIdsFor']) + '\n'
        + 'return { deleteChatRow: deleteChatRow };';
    var f = new Function('chats', '_chatsHydrated', 'withStore', 'CHAT_ROW_DELETE_PRECONDITIONS', 'console', body);
    return f(env.chats, true, env.withStore, { t: function() { return null; } }, NOOP_CONSOLE);
}
function _deleteStore(stored, log) {
    return function(names, mode, fn) {
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

describe('C2-store B: deleteChatRow survivor loop', function() {
    test('null/undefined survivor slots are skipped; real survivors still protect their blobs', async function() {
        var log = { deleted: [] };
        var record = { id: 'a', messages: [{ file_id: 'f1' }, { file_id: 'f2' }, { screenshot_id: 's3' }] };
        var chats = { n: null, u: undefined,
            b: { id: 'b', messages: [{ file_id: 'f2' }] },
            c: { id: 'c', _messagesEvicted: true, _payloadsEvicted: true, _evictedPayloadRefs: { s3: true } } };
        var m = await _core({ chats: chats, withStore: _deleteStore({ id: 'a', messages: [] }, log) });
        var ok;
        try { ok = await m.deleteChatRow('a', 't', { record: record }); }
        catch (e) { assert.fail('deleteChatRow threw: ' + e.message); }
        assert.strictEqual(ok, true);
        assert.deepStrictEqual(log.deleted.sort(), ['chat_payloads:f1', 'chats:a'],
            'only the unshared blob is reaped; f2 (plain survivor) and s3 (skeleton survivor) kept');
    }, { tags: ['unit'] });

    test('a survivor with unknown refs still reaps nothing alongside null slots', async function() {
        var log = { deleted: [] };
        var record = { id: 'a', messages: [{ file_id: 'f1' }] };
        var chats = { n: null, c: { id: 'c', _messagesEvicted: true, _payloadsEvicted: true } };
        var m = await _core({ chats: chats, withStore: _deleteStore({ id: 'a' }, log) });
        assert.strictEqual(await m.deleteChatRow('a', 't', { record: record }), true);
        assert.deepStrictEqual(log.deleted, ['chats:a']);
    }, { tags: ['unit'] });
});

// ── sweepColdChatPayloads skips chats with hydration in flight ──
var SWEEP_FNS = ['chatMessageCount', 'markChatMessagesDurable', 'chatMessagesDurable', 'chatReferencedPayloadIds',
    'evictChatMessagesInPlace', 'stripChatPayloadsInPlace', 'chatPayloadRecencyTs', 'chatHasEvictableBodies',
    'sweepColdChatPayloads'];
async function _sweepEnv(chats) {
    var src = await loadFile('src/js/core/130-indexeddb.js');
    var body = 'var CHAT_MESSAGE_EVICTION_ENABLED = true;\n'
        + 'var CHAT_BODY_EVICT_MIN_CHARS = 512, CHAT_KEEP_HYDRATED = 8;\n'
        + 'var _durableChatMsgArrays = new WeakMap(), _chatHydrationPromises = {}, _persistedPayloadIds = {};\n'
        + 'var _subChatOpQueue = {};\n' // core/097 per-chat op FIFO stand-in
        + _cutFns(src, SWEEP_FNS) + '\n'
        + 'return { sweep: sweepColdChatPayloads, mark: markChatMessagesDurable, hydrating: _chatHydrationPromises, queued: _subChatOpQueue };';
    var f = new Function('chats', 'currentChatId', '_chatsHydrated', 'console', body);
    return f(chats, null, true, NOOP_CONSOLE);
}

describe('C2-store B: cold sweep vs in-flight hydration', function() {
    test('an unproven chat asks bodyGuard exactly once across message and body legs', async function() {
        var chat = { id: 'a', title: 'T', updatedAt: 1,
            messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'x'.repeat(1024) }] };
        var before = JSON.parse(JSON.stringify(chat));
        var chats = { a: chat };
        var m = await _sweepEnv(chats);
        var calls = [];
        // Deliberately NOT marked durable: the message leg must request proof,
        // and the body leg must reuse that false verdict, not invoke us twice.
        var swept = m.sweep(0, true, function(id, c) {
            calls.push({ id: id, sameChat: c === chat, snapshot: JSON.parse(JSON.stringify(c)) });
            return false;
        });
        assert.strictEqual(calls.length, 1, 'one guard call for the entire sweep');
        assert.deepStrictEqual(calls, [{ id: 'a', sameChat: true, snapshot: before }]);
        assert.strictEqual(swept, 0, 'no payload was eligible for the b64/CTR fallback');
        assert.strictEqual(chats.a, chat, 'refused eviction preserves the live chat identity');
        assert.deepStrictEqual(chats, { a: before }, 'unproven history and heavy body stay intact');
    }, { tags: ['unit'] });

    test('pending ensureChatPayloads keeps the chat resident; evictable once the promise settles', async function() {
        var chats = { a: { id: 'a', title: 'T', updatedAt: 1,
            messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] } };
        var m = await _sweepEnv(chats);
        assert.strictEqual(m.mark(chats.a), true, 'messages proven durable (restore stamp)');
        var settle;
        var p = new Promise(function(r) { settle = r; }).then(function() { delete m.hydrating.a; });
        m.hydrating.a = p;
        assert.strictEqual(m.sweep(0, true), 0, 'nothing swept while hydration is in flight');
        assert.ok(Array.isArray(chats.a.messages) && chats.a.messages.length === 2, 'messages still resident');
        assert.notStrictEqual(chats.a._messagesEvicted, true);
        settle();
        await p;
        assert.strictEqual(m.hydrating.a, undefined);
        assert.strictEqual(m.sweep(0, true), 1, 'evicted once hydration settled');
        assert.strictEqual(chats.a._messagesEvicted, true);
        assert.ok(!Array.isArray(chats.a.messages), 'skeleton after the post-settle sweep');
    }, { tags: ['unit'] });

    test('a queued sub-agent chat op (_subChatOpQueue) keeps the chat resident; evictable once cleared', async function() {
        var chats = { a: { id: 'a', title: 'T', updatedAt: 1,
            messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] } };
        var m = await _sweepEnv(chats);
        assert.strictEqual(m.mark(chats.a), true, 'messages proven durable (restore stamp)');
        var live = chats.a;
        m.queued.a = Promise.resolve();
        assert.strictEqual(m.sweep(0, true), 0, 'nothing swept while a sub op is queued');
        assert.strictEqual(chats.a, live, 'chats[id] not swapped under the queued op');
        assert.ok(Array.isArray(chats.a.messages) && chats.a.messages.length === 2, 'messages still resident');
        delete m.queued.a;
        assert.strictEqual(m.sweep(0, true), 1, 'evicted once the queue entry is cleared');
        assert.strictEqual(chats.a._messagesEvicted, true);
        assert.ok(!Array.isArray(chats.a.messages), 'skeleton after the post-clear sweep');
    }, { tags: ['unit'] });
});
