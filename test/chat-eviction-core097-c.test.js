// C2 cold-chat eviction, core/097 part C: wake_sub_agent / agent_message /
// background-notice delivery onto a SKELETON chat (messages evicted to IDB,
// `_messagesEvicted`). Evaluates the REAL function texts cut out of
// src/js/core/097-sub-agent-registry.js inside a `with` scope whose unknown
// identifiers resolve to no-op stubs (explicit stubs below win).

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

var FNS = ['_subIsSkeleton', '_subHydrateChat', '_subWithChat', '_subAppendRows', '_pushPendingWakeRows',
    '_queueNoticeInjection', '_subNoticeMeta', '_noticeRow', '_findSubAgentCard', '_wakeSubAgentImpl', 'agentMessage',
    'notifyChatOfBackgroundResult'];

var _REAL_GLOBALS = { Promise: 1, Object: 1, Array: 1, JSON: 1, Date: 1, Math: 1, String: 1, Number: 1,
    Boolean: 1, Error: 1, RegExp: 1, setTimeout: 1, clearTimeout: 1, undefined: 1, NaN: 1, Infinity: 1,
    isFinite: 1, isNaN: 1, parseInt: 1, parseFloat: 1, Symbol: 1, Map: 1, Set: 1, WeakMap: 1,
    encodeURIComponent: 1, TextEncoder: 1, eval: 1, arguments: 1 };

// Real pool start (Fix 4): cut the REAL _drainPool / _releasePoolSlot /
// _subAbortUndeliveredWakeRun instead of the _drainPool stub below.
var POOL_FNS = ['_poolGroupRunningCount', '_drainPool', '_releasePoolSlot', '_subAbortUndeliveredWakeRun'];

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

// env: { chats, stored: {id: messages[]}, subAgents, realPool?, stubs? }
async function _env(env) {
    var src = await loadFile('src/js/core/097-sub-agent-registry.js');
    var work = _asyncWork();
    var log = { saves: 0, hydrates: 0, runs: [], durable: [], drains: 0, settles: [] };
    var stubs = {
        Promise: work.Promise,
        chats: env.chats,
        _subAgents: env.subAgents || {},
        pendingInjectionsByChatId: {},
        runningChatIds: {},
        pausedChats: {},
        pausedChatIds: {},
        _subPool: { running: {}, queue: [] },
        isChatPaused: function() { return false; },
        _callerOwnsTarget: function() { return true; },
        _formatInboxDrain: function(items) { return items.map(function(it) { return it.content; }).join('\n\n'); },
        _subNoticeList: function(a, metas) { return (metas || []).filter(Boolean); },
        _subNormalizeNewlines: function(s) { return String(s); },
        _withWakeFinalReminder: function(t) { return t; },
        _mintNewSpawnHandle: function() { return 'h_new'; },
        _drainPool: function() { log.drains++; },
        persistPendingWake: function(id, text) { log.durable.push({ id: id, text: text }); return Promise.resolve(); },
        runAgent: function(id) { log.runs.push(id); return Promise.resolve(); },
        saveChatsToStorage: function() { log.saves++; return Promise.resolve(); },
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
    if (env.realPool) {
        // Spawn-handle plumbing used by _subAbortUndeliveredWakeRun. The wake
        // mints a fresh handle (as the real _mintNewSpawnHandle does) whose
        // deferred is pending, so the abort path must settle it.
        stubs._spawnDeferreds = {};
        stubs._mintNewSpawnHandle = function(rec) {
            rec.spawn_handle_id = 'h_new'; stubs._spawnDeferreds.h_new = { pending: true }; return 'h_new';
        };
        stubs._resolveSpawnHandle = function(aid, payload) { log.settles.push([aid, payload]); };
        stubs._spawnHandleHasAwaiters = function() { return true; };
        stubs._poolSlotsFree = function() { return 4 - Object.keys(stubs._subPool.running).length; };
        stubs._poolGroupFor = function() { return { key: 'g', limit: 4 }; };
        stubs._markErrored = function(aid, msg) { log.errored = [aid, msg]; };
    }
    Object.keys(env.stubs || {}).forEach(function(k) { stubs[k] = env.stubs[k]; });
    var fns = FNS.concat(env.realPool ? POOL_FNS : []);
    var scope = new Proxy(stubs, {
        has: function(t, k) { return typeof k === 'string' && (k === 'Promise' || !_REAL_GLOBALS[k]); },
        get: function(t, k) {
            if (k === Symbol.unscopables) return undefined;
            if (k in t) return t[k];
            return function() { return undefined; };
        },
        set: function(t, k, v) { t[k] = v; return true; }
    });
    var body = 'with (scope) { return (function() {\nvar _subChatOpQueue = {};\nvar _subWakeDeliverFailed = {};\n' + _cutFns(src, fns)
        + '\nreturn {' + fns.map(function(n) { return n + ': ' + n; }).join(', ')
        + ', queue: function(id) { return _subChatOpQueue[id] || null; }'
        + ', deliverFailed: function() { return _subWakeDeliverFailed; } };\n})(); }';
    var api = (new Function('scope', body))(scope);
    api.log = log;
    api.finish = work.finish;
    api.stubs = stubs;
    return api;
}

function _skel(id, extra) {
    var c = { id: id, _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 2 };
    Object.keys(extra || {}).forEach(function(k) { c[k] = extra[k]; });
    return c;
}
var HIST = [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'did step 1' }];

describe('C2 core/097 part C: wake / agent_message / notices on skeleton chats', function() {
    test('wake_sub_agent on a skeleton sub hydrates first and KEEPS the prior history', async function() {
        var chats = { root: { id: 'root', messages: [] }, s: _skel('s', { isSubAgent: true, subAgentId: 'a1' }) };
        var rec = { agent_id: 'a1', chat_id: 's', parent_chat_id: 'root', state: 'sleeping', inbox: [{ kind: 'message', from: 'parent', content: 'M1' }] };
        var m = await _env({ chats: chats, subAgents: { a1: rec }, stored: { s: HIST } });
        var res = m._wakeSubAgentImpl({ agent_id: 'a1', instruction: 'continue' }, { chatId: 'root' }, true);
        assert.strictEqual(res.success, true, 'sync result preserved');
        assert.strictEqual(chats.s.messages, undefined, 'no messages=[] seeded onto the skeleton');
        assert.ok(m.queue('s'), 'delivery deferred behind the hydrate (pool start waits on it)');
        await m.finish();
        assert.strictEqual(m.log.hydrates, 1);
        assert.strictEqual(chats.s.messages.length, 3, 'history restored + one drain row');
        assert.deepStrictEqual(chats.s.messages.slice(0, 2), HIST);
        assert.ok(/M1/.test(chats.s.messages[2].content) && /continue/.test(chats.s.messages[2].content));
        assert.deepStrictEqual(rec.inbox, []);
    }, { tags: ['unit'] });

    test('wake on a skeleton with a hydrate MISS puts the drained inbox back (nothing lost)', async function() {
        var chats = { root: { id: 'root', messages: [] }, s: _skel('s', { isSubAgent: true, subAgentId: 'a1' }) };
        var rec = { agent_id: 'a1', chat_id: 's', parent_chat_id: 'root', state: 'sleeping', inbox: [{ kind: 'message', from: 'parent', content: 'M1' }] };
        var m = await _env({ chats: chats, subAgents: { a1: rec }, stored: {} });
        m._wakeSubAgentImpl({ agent_id: 'a1' }, { chatId: 'root' }, true);
        await m.finish();
        assert.strictEqual(chats.s.messages, undefined, 'still a skeleton, never a 1-row array');
        assert.strictEqual(chats.s._messagesEvicted, true);
        assert.strictEqual(rec.inbox.length, 1);
        assert.strictEqual(rec.inbox[0].content, 'M1');
    }, { tags: ['unit'] });

    test('Fix 4: a wake whose delivery MISSES does not start a run: sub parks sleeping, inbox kept, handle settles need_input', async function() {
        var chats = { root: { id: 'root', messages: [] }, s: _skel('s', { isSubAgent: true, subAgentId: 'a1' }) };
        var rec = { agent_id: 'a1', chat_id: 's', parent_chat_id: 'root', state: 'sleeping', name: 'w',
            inbox: [{ kind: 'message', from: 'parent', content: 'M1' }] };
        var m = await _env({ chats: chats, subAgents: { a1: rec }, stored: {}, realPool: true });
        var res = m._wakeSubAgentImpl({ agent_id: 'a1', instruction: 'continue' }, { chatId: 'root' }, true);
        assert.strictEqual(res.success, true);
        assert.strictEqual(rec.state, 'running', 'wake marks running synchronously');
        assert.strictEqual(m.stubs._subPool.running.a1, 'g', 'real _drainPool claimed the slot');
        await m.finish();
        assert.deepStrictEqual(m.log.runs, [], 'runAgent never called on an undelivered wake');
        assert.strictEqual(rec.state, 'sleeping');
        assert.strictEqual(m.stubs.pausedChats.s, true, 'parked like sleep_self');
        assert.deepStrictEqual(rec.inbox.map(function(it) { return it.content; }), ['M1', 'continue'],
            'inbox (incl. the wake instruction) kept for the next wake');
        assert.strictEqual(chats.s.messages, undefined, 'still a skeleton');
        assert.strictEqual(m.log.settles.length, 1, 'spawn handle settled exactly once');
        assert.strictEqual(m.log.settles[0][0], 'a1');
        assert.strictEqual(m.log.settles[0][1].status, 'need_input');
        assert.strictEqual(m.log.settles[0][1]._synthesized, true);
        assert.strictEqual(rec.last_report.status, 'need_input');
        assert.strictEqual(rec.report_collected, false);
        assert.deepStrictEqual(m.stubs._subPool.running, {}, 'pool slot released');
        assert.strictEqual(m.deliverFailed().a1, undefined, 'flag consumed');
        assert.strictEqual(m.log.errored, undefined, 'not marked errored');
    }, { tags: ['unit'] });

    test('Fix 4 control: the same wake with a hydrate HIT runs the sub with the delivered message', async function() {
        var chats = { root: { id: 'root', messages: [] }, s: _skel('s', { isSubAgent: true, subAgentId: 'a1' }) };
        var rec = { agent_id: 'a1', chat_id: 's', parent_chat_id: 'root', state: 'sleeping', name: 'w',
            inbox: [{ kind: 'message', from: 'parent', content: 'M1' }] };
        var m = await _env({ chats: chats, subAgents: { a1: rec }, stored: { s: HIST }, realPool: true });
        m._wakeSubAgentImpl({ agent_id: 'a1', instruction: 'continue' }, { chatId: 'root' }, true);
        await m.finish();
        assert.deepStrictEqual(m.log.runs, ['s']);
        assert.deepStrictEqual(m.log.settles, []);
        assert.strictEqual(rec.state, 'running');
        assert.deepStrictEqual(rec.inbox, []);
        assert.strictEqual(chats.s.messages.length, 3, 'drain row landed before runAgent');
    }, { tags: ['unit'] });

    test('wake on a hot sub is unchanged: synchronous push, no hydrate, no queue', async function() {
        var chats = { root: { id: 'root', messages: [] }, s: { id: 's', isSubAgent: true, subAgentId: 'a1', messages: HIST.slice() } };
        var rec = { agent_id: 'a1', chat_id: 's', parent_chat_id: 'root', state: 'sleeping', inbox: [{ kind: 'message', from: 'parent', content: 'M1' }] };
        var m = await _env({ chats: chats, subAgents: { a1: rec } });
        m._wakeSubAgentImpl({ agent_id: 'a1' }, { chatId: 'root' }, true);
        assert.strictEqual(chats.s.messages.length, 3, 'pushed synchronously');
        assert.strictEqual(m.queue('s'), null);
        assert.strictEqual(m.log.hydrates, 0);
    }, { tags: ['unit'] });

    test('agent_message to a queued sub whose chat is a skeleton appends AFTER the restored history', async function() {
        var chats = { root: { id: 'root', messages: [] }, s: _skel('s', { isSubAgent: true, subAgentId: 'a1' }) };
        var dst = { agent_id: 'a1', chat_id: 's', parent_chat_id: 'root', state: 'running', inbox: [] };
        var m = await _env({ chats: chats, subAgents: { a1: dst }, stored: { s: HIST } });
        var res = m.agentMessage({ to: 'a1', content: 'hello' }, { chatId: 'root' });
        assert.strictEqual(res.success, true);
        assert.strictEqual(chats.s.messages, undefined, 'skeleton untouched synchronously');
        await m.finish();
        assert.strictEqual(chats.s.messages.length, 3);
        assert.deepStrictEqual(chats.s.messages.slice(0, 2), HIST);
        assert.ok(/hello/.test(chats.s.messages[2].content));
    }, { tags: ['unit'] });

    test('agent_message(parent) onto a skeleton parent updates the card after hydration', async function() {
        var card = { role: 'sub_report', subAgentId: 'a1', progress: [], report: { status: 'running' } };
        var chats = { p: _skel('p'), s: { id: 's', isSubAgent: true, subAgentId: 'a1', messages: [] } };
        var rec = { agent_id: 'a1', chat_id: 's', parent_chat_id: 'p', state: 'running', wake_parent: false };
        var m = await _env({ chats: chats, subAgents: { a1: rec }, stored: { p: [{ role: 'user', content: 'go' }, card] } });
        var res = m.agentMessage({ to: 'parent', content: 'progress 1' }, { chatId: 's' });
        assert.strictEqual(res.success, true);
        await m.finish();
        assert.strictEqual(chats.p.messages.length, 3, 'history + sub_msg row');
        assert.strictEqual(chats.p.messages[1].progress.length, 1, 'card progress entry landed on the restored card');
        assert.strictEqual(chats.p.messages[2].role, 'sub_msg');
    }, { tags: ['unit'] });

    test('background notice onto a skeleton: hydrate hit pushes + runs; miss keeps it durable, no run', async function() {
        var chatsHit = { p: _skel('p') };
        var hit = await _env({ chats: chatsHit, stored: { p: HIST } });
        hit.notifyChatOfBackgroundResult('p', 'BG done', 'x');
        await hit.finish();
        assert.strictEqual(chatsHit.p.messages.length, 3);
        assert.strictEqual(chatsHit.p.messages[2].content, 'BG done');
        assert.deepStrictEqual(hit.log.runs, ['p']);

        var chatsMiss = { p: _skel('p') };
        var miss = await _env({ chats: chatsMiss, stored: {} });
        miss.notifyChatOfBackgroundResult('p', 'BG done', 'x');
        // Includes the detached hydrate retry and any trailing run continuation.
        await miss.finish();
        assert.strictEqual(chatsMiss.p.messages, undefined, 'never a 1-row array over the stored transcript');
        assert.ok(miss.log.durable.some(function(d) { return d.id === 'p' && d.text === 'BG done'; }), 'notice kept durable');
        assert.deepStrictEqual(miss.log.runs, [], 'no run on a skeleton');
        assert.strictEqual(miss.log.hydrates, 2, 'one retry hydrate');
    }, { tags: ['unit'] });

    test('background notice onto a hot chat is unchanged (sync push + run)', async function() {
        var chats = { p: { id: 'p', messages: HIST.slice() } };
        var m = await _env({ chats: chats });
        m.notifyChatOfBackgroundResult('p', 'BG done', 'x');
        assert.strictEqual(chats.p.messages.length, 3, 'pushed synchronously');
        assert.strictEqual(m.log.hydrates, 0);
        await m.finish();
        assert.deepStrictEqual(m.log.runs, ['p']);
    }, { tags: ['unit'] });

    test('source pins: pool start waits on the op queue; finish hook defers on skeleton', async function() {
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        assert.ok(/_subChatOpQueue\[capturedChatId\]/.test(src), 'pool start consults the op queue');
        assert.ok(/_c2Deferred/.test(src), 'onSubAgentRunFinished re-enters once after hydration');
        assert.ok(/_subWithChat\(rec\.chat_id, function\(_trc\)/.test(src), '_queueTransientRetry routes through _subWithChat');
    }, { tags: ['unit'] });
});

describe('parent-message delivery identity and ordering', function() {
    [false,true].forEach(function(cold) {
        test('shared unique identity and UI-before-notice, cold=' + cold, async function() {
            var chats={p:cold?_skel('p'):{id:'p',messages:[]},s:{id:'s',isSubAgent:true,subAgentId:'a1',messages:[]}};
            var rec={agent_id:'a1',chat_id:'s',parent_chat_id:'p',state:'running'};
            var m=await _env({chats:chats,subAgents:{a1:rec},stored:{p:[]}});
            m.agentMessage({to:'parent',content:'same'},{chatId:'s'});
            m.agentMessage({to:'parent',content:'same'},{chatId:'s'});
            await m.finish();
            var rows=chats.p.messages, subs=rows.filter(function(r){return r.role==='sub_msg';}), notices=rows.filter(function(r){return r.injected;});
            assert.strictEqual(subs.length,2);assert.strictEqual(notices.length,2);
            assert.ok(subs[0].deliveryId && subs[0].deliveryId!==subs[1].deliveryId);
            notices.forEach(function(n,i){assert.strictEqual(n.subNotices[0].deliveryId,subs[i].deliveryId);assert.ok(rows.indexOf(subs[i])<rows.indexOf(n));});
        });
    });
    test('wake_parent:false creates only UI row and never durable wake',async function(){
        var chats={p:_skel('p'),s:{id:'s',isSubAgent:true,subAgentId:'a1',messages:[]}};
        var rec={agent_id:'a1',chat_id:'s',parent_chat_id:'p',state:'running',wake_parent:false};
        var m=await _env({chats:chats,subAgents:{a1:rec},stored:{p:[]}});
        m.agentMessage({to:'parent',content:'quiet'},{chatId:'s'});await m.finish();
        assert.strictEqual(chats.p.messages.filter(function(r){return r.role==='sub_msg';}).length,1);
        assert.strictEqual(chats.p.messages.filter(function(r){return r.injected;}).length,0);
        assert.strictEqual(m.log.durable.length,0);assert.strictEqual(m.log.runs.length,0);
    });
    test('rejected parent hydration preserves durable notice metadata without seeding skeleton',async function(){
        var chats={p:_skel('p'),s:{id:'s',isSubAgent:true,subAgentId:'a1',messages:[]}},durable=[];
        var rec={agent_id:'a1',chat_id:'s',parent_chat_id:'p',state:'running'};
        var m=await _env({chats:chats,subAgents:{a1:rec},stubs:{ensureChatPayloads:function(){return Promise.reject(new Error('hydrate unavailable'));},persistPendingWake:function(id,text,from,meta){durable.push(meta);}}});
        m.agentMessage({to:'parent',content:'retain me'},{chatId:'s'});await m.finish();
        assert.strictEqual(chats.p.messages,undefined);assert.strictEqual(durable.length,1);
        assert.strictEqual(durable[0].subNotices[0].summary,'retain me');assert.ok(durable[0].subNotices[0].deliveryId);
        assert.strictEqual(m.log.runs.length,0);
    });
});
