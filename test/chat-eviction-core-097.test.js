// C2 cold-chat eviction, core/097 part A: skeleton-safe helpers and the
// pending-wake / passive-notice write sites. Evaluates the REAL function
// texts cut out of src/js/core/097-sub-agent-registry.js with stand-ins.

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

var FNS = ['_subIsSkeleton', '_subHydrateChat', '_subWithChat', '_subAppendRows', '_pushPendingWakeRows', '_drainOnePendingWake'];

// env: { chats, stored: {id: messages[]}, onBump?: fn }
async function _env(env) {
    var src = await loadFile('src/js/core/097-sub-agent-registry.js');
    var work = _asyncWork();
    var log = { saves: 0, cleared: [], runs: [], exhausted: [], hydrates: 0 };
    var pending = env.pending || {};
    var stubs = {
        Promise: work.Promise,
        chats: env.chats,
        pendingInjectionsByChatId: pending,
        runningChatIds: {},
        _subPool: { running: {} },
        _amDebounceTimers: {},
        PENDING_WAKE_MAX_ATTEMPTS: 5,
        PENDING_WAKE_EXHAUST_TTL_MS: 1000,
        isChatPaused: function() { return false; },
        _notePendingWakePaused: function() { return Promise.resolve(); },
        _cancelAgentMessageWake: function() {},
        clearPendingWake: function(id) { log.cleared.push(id); return Promise.resolve(); },
        _bumpPendingWakeAttempts: function() { if (env.onBump) env.onBump(); return Promise.resolve(); },
        _markPendingWakeExhausted: function(id) { log.exhausted.push(id); return Promise.resolve(); },
        _wakeSubAgentImpl: function() { return { success: true }; },
        runAgent: function(id) { log.runs.push(id); return Promise.resolve(); },
        saveChatsToStorage: function() { log.saves++; return Promise.resolve(); },
        _noticeRow: function(t) { return { role: 'user', content: t }; },
        ensureChatPayloads: function(id) {
            log.hydrates++;
            return work.hydrate(function() {
                var c = env.chats[id];
                if (c && c._messagesEvicted && env.stored && env.stored[id]) {
                    c.messages = JSON.parse(JSON.stringify(env.stored[id]));
                    delete c._messagesEvicted; delete c._payloadsEvicted;
                }
            });
        },
        console: { warn: function() {}, error: function() {}, log: function() {} }
    };
    var names = Object.keys(stubs);
    var body = 'var _subChatOpQueue = {};\n' + _cutFns(src, FNS) + '\nreturn {' + FNS.map(function(n) { return n + ': ' + n; }).join(', ') + '};';
    var f = new Function(names.join(','), body);
    var api = f.apply(null, names.map(function(n) { return stubs[n]; }));
    api.log = log;
    api.finish = work.finish;
    api.pending = pending;
    return api;
}

function _skel(extra) {
    var c = { id: 'p', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 2 };
    Object.keys(extra || {}).forEach(function(k) { c[k] = extra[k]; });
    return c;
}

describe('C2 core/097 part A: skeleton-safe sub-agent writes', function() {
    test('_pushPendingWakeRows refuses a skeleton: no messages array, no save, no onPushed', async function() {
        var chats = { p: _skel() };
        var m = await _env({ chats: chats });
        var called = 0;
        var res = await m._pushPendingWakeRows(chats.p, [{ text: 'N1' }], function() { called++; });
        assert.strictEqual(res, false);
        assert.strictEqual(chats.p.messages, undefined, 'never seeds messages=[] on a skeleton');
        assert.strictEqual(chats.p._messagesEvicted, true, 'stays a skeleton');
        assert.strictEqual(m.log.saves, 0);
        assert.strictEqual(called, 0);
        assert.strictEqual(m._subAppendRows(chats.p, [{ role: 'user' }]), false);
    }, { tags: ['unit'] });

    test('_pushPendingWakeRows on a hot chat is unchanged (append + save + onPushed)', async function() {
        var chats = { p: { id: 'p', messages: [] }, n: { id: 'n' } };
        var m = await _env({ chats: chats });
        var called = 0;
        var res = await m._pushPendingWakeRows(chats.p, ['legacy', { text: 'N1' }], function() { called++; });
        assert.strictEqual(res, undefined);
        assert.deepStrictEqual(chats.p.messages.map(function(r) { return r.content; }), ['legacy', 'N1']);
        assert.strictEqual(m.log.saves, 1);
        assert.strictEqual(called, 1);
        assert.strictEqual(m._subAppendRows(chats.n, [{ role: 'user' }]), true, 'non-evicted chat without messages still gets an array');
        assert.strictEqual(chats.n.messages.length, 1);
    }, { tags: ['unit'] });

    test('_subWithChat is sync for a hot chat and FIFO-deferred + hydrated for a skeleton', async function() {
        var chats = { h: { id: 'h', messages: [1] }, p: _skel() };
        var m = await _env({ chats: chats, stored: { p: [{ role: 'user', content: 'a' }] } });
        assert.strictEqual(m._subWithChat('h', function(c) { return c.messages.length; }), 1, 'sync value');
        var order = [];
        var p1 = m._subWithChat('p', function(c) { order.push('one:' + c.messages.length); return 'x'; });
        var p2 = m._subWithChat('p', function(c) { order.push('two'); });
        assert.ok(p1 && typeof p1.then === 'function', 'deferred returns a Promise');
        assert.deepStrictEqual(order, [], 'hydration gate keeps both FIFO writes pending');
        await m.finish();
        assert.strictEqual(await p1, 'x');
        await p2;
        assert.deepStrictEqual(order, ['one:1', 'two']);
        assert.strictEqual(m.log.hydrates, 1);
    }, { tags: ['unit'] });

    test('drain hydrates a skeleton BEFORE scanning: answered record cleared, no duplicate push', async function() {
        var chats = { p: _skel() };
        var stored = { p: [{ role: 'user', content: 'pre N1 post' }, { role: 'assistant', content: 'ok' }] };
        var m = await _env({ chats: chats, stored: stored });
        var drain = m._drainOnePendingWake({ parentChatId: 'p', notices: [{ text: 'N1' }] });
        await m.finish();
        await drain;
        assert.deepStrictEqual(m.log.cleared, ['p']);
        assert.strictEqual(chats.p.messages.length, 2, 'no duplicate notice row');
        assert.strictEqual(m.log.runs.length, 0);
    }, { tags: ['unit'] });

    test('drain on a skeleton with a hydrate miss keeps record, entry and skeleton', async function() {
        var chats = { p: _skel() };
        var m = await _env({ chats: chats, pending: { p: { text: 'MEM' } } });
        var drain = m._drainOnePendingWake({ parentChatId: 'p', notices: [{ text: 'N1' }] });
        await m.finish();
        await drain;
        assert.strictEqual(chats.p.messages, undefined);
        assert.deepStrictEqual(m.log.cleared, []);
        assert.strictEqual(m.log.runs.length, 0);
        assert.strictEqual(m.log.saves, 0);
        assert.deepStrictEqual(m.pending.p, { text: 'MEM' });
    }, { tags: ['unit'] });

    test('re-evicted before the push: in-memory entry is NOT consumed and no run starts', async function() {
        var chats = { p: { id: 'p', messages: [] } };
        var m = await _env({ chats: chats, pending: { p: { text: 'MEM' } }, onBump: function() {
            delete chats.p.messages; chats.p._messagesEvicted = true; chats.p._payloadsEvicted = true;
        } });
        var drain = m._drainOnePendingWake({ parentChatId: 'p', notices: [{ text: 'N1' }] });
        await m.finish();
        await drain;
        assert.deepStrictEqual(m.pending.p, { text: 'MEM' }, 'entry kept for flushPendingInjection');
        assert.strictEqual(chats.p.messages, undefined);
        assert.strictEqual(m.log.runs.length, 0);
        assert.strictEqual(m.log.saves, 0);
    }, { tags: ['unit'] });

    test('hot drain consumes the in-memory entry after the push and starts the run', async function() {
        var chats = { p: { id: 'p', messages: [] } };
        var m = await _env({ chats: chats, pending: { p: { text: 'MEM N1' } } });
        var drain = m._drainOnePendingWake({ parentChatId: 'p', notices: [{ text: 'N1' }] });
        await m.finish();
        await drain;
        assert.strictEqual(m.pending.p, undefined);
        assert.deepStrictEqual(chats.p.messages.map(function(r) { return r.content; }), ['MEM N1']);
        assert.deepStrictEqual(m.log.runs, ['p']);
    }, { tags: ['unit'] });

    test('passive notice and nested paused arm are skeleton-guarded (source pins)', async function() {
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        assert.match(src, /if \(!_subAppendRows\(pchat, \[row\]\)\) \{/);
        assert.match(src, /parentSubRec\.state === 'running' && \(Array\.isArray\(chats\[pcid\]\.messages\) \|\| _subIsSkeleton\(chats\[pcid\]\)\)/);
        assert.match(src, /if \(pushed === false\) persistPendingWake\(pcid, notice, rec\.agent_id, \{ subNotices: \[_meta\] \}\);/);
        assert.ok(!/if \(!Array\.isArray\(pchat\.messages\)\) pchat\.messages = \[\];/.test(src), 'no messages=[] seeding on pchat');
    }, { tags: ['unit'] });
});

// ---- part B: card / lifecycle / PR-link / boot sites ----
var FNS_B = ['_subIsSkeleton', '_subHydrateChat', '_subWithChat', '_subAppendRows', '_findSubAgentCard',
    '_subCardEdited', '_repaintParent', '_finalizeSubAgentCard', '_reconcileSubActionState',
    '_notifySubLifecycle', '_queuePrLinksToParent', '_subBootHydrateChats'];

// Hold hydration until the test releases it, then observe every real Promise
// continuation (including detached retry/run chains). No timer or guessed number
// of microtask turns: finish waits for quiescence, then rejects any unconsumed
// terminal failure instead of silently treating rejection as successful work.
function _asyncWork() {
    var release;
    var gate = new Promise(function(resolve) { release = resolve; });
    var pending = new Set();
    var records = new Map();
    class ObservedPromise extends Promise {
        // Native bookkeeping must not create observed children or mark a
        // rejected receiver consumed. Application-facing then wraps its child.
        static get [Symbol.species]() { return Promise; }
        constructor(executor) {
            super(executor);
            var record = { status: 'pending', consumed: false, error: undefined };
            records.set(this, record);
            var done = Promise.prototype.then.call(this, function() {
                record.status = 'fulfilled';
            }, function(error) {
                record.status = 'rejected';
                record.error = error;
            });
            pending.add(done);
            done.then(function() { pending.delete(done); });
        }
        then(onFulfilled, onRejected) {
            // Inherited catch also dispatches here. Even a handler-less then
            // forwards ownership: its returned child now owns the rejection.
            records.get(this).consumed = true;
            var next = super.then(onFulfilled, onRejected);
            return new ObservedPromise(function(resolve, reject) {
                Promise.prototype.then.call(next, resolve, reject);
            });
        }
    }
    return {
        Promise: ObservedPromise,
        hydrate: function(fn) { return ObservedPromise.resolve(gate).then(fn); },
        finish: async function() {
            release();
            while (pending.size) await Promise.all(Array.from(pending));
            records.forEach(function(record) {
                if (record.status === 'rejected' && !record.consumed) throw record.error;
            });
        }
    };
}

describe('async fixture completion: detached rejection ownership', function() {
    test('finish rejects with the exact detached throw after hydration', async function() {
        var work = _asyncWork();
        var sentinel = new Error('detached hydration sentinel');
        work.hydrate(function() {}).then(function() { throw sentinel; });
        await assert.rejects(work.finish(), function(error) { return error === sentinel; });
    }, { tags: ['unit'] });

    test('finish observes a nested detached continuation created after hydration', async function() {
        var work = _asyncWork();
        var sentinel = new Error('nested detached sentinel');
        work.hydrate(function() {
            // Intentionally NOT returned: completion must discover this child.
            work.Promise.resolve().then(function() {
                work.Promise.resolve().then(function() { throw sentinel; });
            });
        });
        await assert.rejects(work.finish(), function(error) { return error === sentinel; });
    }, { tags: ['unit'] });

    test('finish accepts intentionally caught rejection without changing native Promise', async function() {
        var nativePromise = Promise;
        var nativeThen = Promise.prototype.then;
        var nativeCatch = Promise.prototype.catch;
        var work = _asyncWork();
        var sentinel = new Error('handled sentinel');
        var caught;
        work.hydrate(function() { throw sentinel; }).catch(function(error) { caught = error; });
        await work.finish();
        assert.strictEqual(caught, sentinel, 'application catch handled the exact rejection');
        assert.strictEqual(Promise, nativePromise);
        assert.strictEqual(Promise.prototype.then, nativeThen);
        assert.strictEqual(Promise.prototype.catch, nativeCatch);
    }, { tags: ['unit'] });

    test('handler-less then forwards rejection to an unconsumed leaf', async function() {
        var work = _asyncWork();
        var sentinel = new Error('forwarded sentinel');
        work.hydrate(function() { throw sentinel; }).then().then();
        await assert.rejects(work.finish(), function(error) { return error === sentinel; });
    }, { tags: ['unit'] });
});

async function _envB(env) {
    var src = await loadFile('src/js/core/097-sub-agent-registry.js');
    var work = _asyncWork();
    var log = { saves: 0, hydrates: 0, unmarked: [], links: [], persisted: 0, durable: [] };
    var stubs = {
        Promise: work.Promise,
        chats: env.chats,
        runningChatIds: {},
        pendingInjectionsByChatId: {},
        _subAgents: {},
        _subPool: { running: {} },
        _AS_TERMINAL: { done: 1, error: 1, finished: 1, pr_opened: 1, finished_with_caveat: 1 },
        _subAgentsPersist: function() { log.persisted++; },
        _withWakeFinalReminder: function(t) { return t; },
        _subNoticeMeta: function() { return { kind: 'lifecycle' }; },
        _noticeRow: function(t) { return { role: 'user', content: t }; },
        _queueNoticeInjection: function() {},
        persistPendingWake: function() { log.durable.push(Array.prototype.slice.call(arguments)); },
        unmarkChatMessagesDurable: function(c) { log.unmarked.push(c.id); },
        saveChatsToStorage: function() { log.saves++; return Promise.resolve(); },
        extractPrUrls: function(s) { return String(s).match(/https:\/\/github\.com\/\S+\/pull\/\d+/g) || []; },
        queueChatAutoLinks: function(c, urls) { log.links.push({ id: c.id, urls: urls.slice() }); },
        ensureChatPayloads: function(id) {
            log.hydrates++;
            return work.hydrate(function() {
                var c = env.chats[id];
                if (c && c._messagesEvicted && env.stored && env.stored[id]) {
                    c.messages = JSON.parse(JSON.stringify(env.stored[id]));
                    delete c._messagesEvicted; delete c._payloadsEvicted;
                }
            });
        },
        console: { warn: function() {}, error: function() {}, log: function() {} }
    };
    var names = Object.keys(stubs);
    var body = 'var _subChatOpQueue = {};\n' + _cutFns(src, FNS_B) + '\nreturn {' + FNS_B.map(function(n) { return n + ': ' + n; }).join(', ') + '};';
    var api = new Function(names.join(','), body).apply(null, names.map(function(n) { return stubs[n]; }));
    api.log = log;
    api.finish = work.finish;
    return api;
}

function _card(status) {
    return { role: 'sub_report', subAgentId: 'a1', progress: [], report: { status: status || 'running' }, actionState: { state: 'running' } };
}
var REC_B = { agent_id: 'a1', name: 'W', chat_id: 's', parent_chat_id: 'p', state: 'running' };

describe('C2 core/097 part B: skeleton-safe card + lifecycle sites', function() {
    test('_finalizeSubAgentCard on a hot parent is sync, edits the card and clears the durable proof', async function() {
        var chats = { p: { id: 'p', messages: [{ role: 'user', content: 'x' }, _card()] } };
        var m = await _envB({ chats: chats });
        var res = m._finalizeSubAgentCard(REC_B, { status: 'done', summary: 'ok' });
        assert.strictEqual(res, true, 'sync true');
        assert.strictEqual(chats.p.messages[1].report.status, 'done');
        assert.deepStrictEqual(m.log.unmarked, ['p']);
        assert.strictEqual(m.log.hydrates, 0);
        assert.ok(m.log.saves >= 1);
    }, { tags: ['unit'] });

    test('_finalizeSubAgentCard on a skeleton parent hydrates first, then finalizes the stored card', async function() {
        var chats = { p: _skel() };
        var m = await _envB({ chats: chats, stored: { p: [{ role: 'user', content: 'x' }, _card()] } });
        var res = m._finalizeSubAgentCard(REC_B, { status: 'error', summary: 'boom' });
        assert.ok(res && typeof res.then === 'function', 'deferred');
        await m.finish();
        assert.strictEqual(await res, true);
        assert.strictEqual(chats.p.messages.length, 2, 'full transcript kept');
        assert.strictEqual(chats.p.messages[1].report.status, 'error');
        assert.deepStrictEqual(m.log.unmarked, ['p']);
    }, { tags: ['unit'] });

    test('hydrate miss: card sites never create messages on a skeleton and never save', async function() {
        var chats = { p: _skel() };
        var m = await _envB({ chats: chats });
        var finalized = m._finalizeSubAgentCard(REC_B, { status: 'done' });
        await m.finish();
        assert.strictEqual(await finalized, false);
        var rec = { agent_id: 'a1', parent_chat_id: 'p', action_state: { state: 'running' } };
        assert.strictEqual(m._reconcileSubActionState(rec, 'done'), true, 'rec part stays sync');
        assert.strictEqual(rec.action_state.state, 'done');
        await m.finish();
        assert.deepStrictEqual(m.log.durable, [], 'card sites do not write a pending wake');
        var lc = m._notifySubLifecycle(REC_B, 'crashed');
        assert.strictEqual(lc, true);
        // The durable fallback is the miss path's final step (097 _notifySubLifecycle).
        await m.finish();
        assert.deepStrictEqual(m.log.durable, [['p', '[sub-agent lifecycle] W (a1): crashed', 'a1', { subNotices: [{ kind: 'lifecycle' }] }]],
            'lifecycle notice kept durable for the heartbeat drain (not dropped)');
        assert.strictEqual(chats.p.messages, undefined, 'still a skeleton');
        assert.strictEqual(chats.p._messagesEvicted, true);
        assert.strictEqual(m.log.saves, 0);
        assert.deepStrictEqual(m.log.unmarked, []);
    }, { tags: ['unit'] });

    test('_notifySubLifecycle on a skeleton parent: card callout + notice row land after hydrate', async function() {
        var chats = { p: _skel() };
        var m = await _envB({ chats: chats, stored: { p: [{ role: 'user', content: 'x' }, _card()] } });
        var r = m._notifySubLifecycle(REC_B, 'retrying');
        assert.ok(r === true, 'returns true synchronously');
        await m.finish();
        assert.deepStrictEqual(m.log.durable, [], 'hydrate hit: no durable fallback');
        assert.strictEqual(chats.p.messages.length, 3);
        assert.match(chats.p.messages[2].content, /\[sub-agent lifecycle\] W \(a1\): retrying/);
        assert.strictEqual(chats.p.messages[1].progress.length, 1);
        assert.strictEqual(m.log.saves, 1);
    }, { tags: ['unit'] });

    test('_notifySubLifecycle on a hot parent is sync and unchanged', async function() {
        var chats = { p: { id: 'p', messages: [_card()] } };
        var m = await _envB({ chats: chats });
        assert.strictEqual(m._notifySubLifecycle(REC_B, 'stuck'), true);
        assert.strictEqual(chats.p.messages.length, 2, 'pushed synchronously');
        assert.strictEqual(m.log.hydrates, 0);
    }, { tags: ['unit'] });

    test('_queuePrLinksToParent scans a skeleton sub transcript after hydrating it', async function() {
        var url = 'https://github.com/o/r/pull/7';
        var subMsgs = [
            { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'workspace', arguments: '{"action":"push"}' } }] },
            { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ success: true, pr_url: url }) }
        ];
        var chats = { p: { id: 'p', messages: [] }, s: _skel({ id: 's' }) };
        var m = await _envB({ chats: chats, stored: { s: subMsgs } });
        m._queuePrLinksToParent(REC_B, 'no url here');
        await m.finish();
        assert.deepStrictEqual(m.log.links, [{ id: 'p', urls: [url] }]);
        // hot sub: sync, same result
        var chats2 = { p: { id: 'p', messages: [] }, s: { id: 's', messages: subMsgs } };
        var m2 = await _envB({ chats: chats2 });
        m2._queuePrLinksToParent(REC_B, '');
        assert.deepStrictEqual(m2.log.links, [{ id: 'p', urls: [url] }]);
    }, { tags: ['unit'] });

    test('_subBootHydrateChats: null (no hop) when hot, hydrates sub AND parent skeletons', async function() {
        var hot = await _envB({ chats: { p: { id: 'p', messages: [] }, s: { id: 's', messages: [] } } });
        assert.strictEqual(hot._subBootHydrateChats(REC_B), null);
        var chats = { p: _skel(), s: _skel({ id: 's' }) };
        var m = await _envB({ chats: chats, stored: { p: [_card('done')], s: [{ role: 'user', content: 'go' }] } });
        var p = m._subBootHydrateChats(REC_B);
        assert.ok(p && typeof p.then === 'function');
        await m.finish();
        await p;
        assert.strictEqual(m.log.hydrates, 2);
        assert.strictEqual(chats.s.messages.length, 1);
        assert.strictEqual(chats.p.messages.length, 1);
    }, { tags: ['unit'] });

    test('boot / spawn / report sites route through the C2 helpers (source pins)', async function() {
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        assert.ok((src.match(/_subBootHydrateChats\(rec\)/g) || []).length >= 2, 'resume + rehydrate-by-id hydrate');
        assert.match(src, /_subWithChat\(parentChatId, function\(_spc\) \{/);
        assert.match(src, /\} else if \(!_subAppendRows\(chats\[rec\.parent_chat_id\], \[\{/);
        assert.ok(!/chats\[rec\.parent_chat_id\]\.messages\.push\(\{\n\s+role: 'sub_report',\n\s+subAgentId: rec\.agent_id,\n\s+subAgentName: rec\.name,\n\s+subChatId: rec\.chat_id,\n\s+report: report,/.test(src), 'reportToParent push no longer unguarded');
    }, { tags: ['unit'] });
});
