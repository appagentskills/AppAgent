// C2-ui approvals: skeleton-safe approval / notification / worker-strip sites
// (cold-chat message eviction). A skeleton has no `messages` array
// (`_messagesEvicted` + `_msgCount`); the full row is in IndexedDB.
//  - ui/160: showToolApprovalPrompt(+Batch) and handleApproval hydrate a
//    skeleton via ensureChatPayloads, re-read chats[id], and fail closed on a
//    restore miss (pre-fix: TypeError on chat.messages.length / .push, or a
//    silent no-op in handleApproval). chatHasPendingApproval/Prompt answer
//    from the stored row through skeletonScanValue.
//  - ui/220: approveFromNotification / approveAllFromNotification never read
//    a skeleton's messages and never kick runAgent for it.
//  - ui/175: _subContextInfo / _subWorkStats / _reconstructSubsFromMessages
//    use the REAL ui/120 skeletonScanValue memo over the stored row.

function rec() { var f = function() { f.calls.push([].slice.call(arguments)); }; f.calls = []; return f; }
async function ticks(n) { for (var i = 0; i < (n || 30); i++) await Promise.resolve(); }

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

function skeleton(id, n) { return { id: id, title: 'Cold ' + id, _messagesEvicted: true, _msgCount: n || 2, updatedAt: 5 }; }

describe('C2-ui ui/160 approvals on an evicted skeleton', function() {
    async function load(chats, ensure, extra) {
        var pend = {};
        var g = {
            window: fakeWindow(), chats: chats, currentChatId: 'other', currentView: 'dashboard',
            pendingToolApprovals: pend, sessionPermissions: {}, console: NOOP_CONSOLE,
            saveChatsToStorage: rec(), renderMessages: rec(), renderChatList: rec(), runAgent: rec(),
            showApprovalNotification: rec(), setTimeout: function() { return 0; },
            chatPermKey: function(r, k) { return r + '::' + k; }, setToolPermissionByKey: rec(),
            ensureChatPayloads: ensure
        };
        Object.keys(extra || {}).forEach(function(k) { g[k] = extra[k]; });
        var m = await loadModules(['src/js/ui/160-notifications.js'], { lenient: true, globals: g });
        return { m: m, pend: pend, g: g };
    }
    function restorer(chats, rows) {
        var f = function(id) {
            f.calls.push(id);
            var c = chats[id];
            if (rows) { c.messages = rows; delete c._messagesEvicted; delete c._msgCount; }
            return Promise.resolve();
        };
        f.calls = [];
        return f;
    }

    test('showToolApprovalPrompt hydrates first, then appends the row at the restored length', async function() {
        var chats = { c1: skeleton('c1') };
        var ensure = restorer(chats, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]);
        var t = await load(chats, ensure);
        t.m.showToolApprovalPrompt('Web Fetch', {}, 'web_fetch', 'tc1', 'web_fetch', 'c1');
        await ticks();
        assert.deepStrictEqual(ensure.calls, ['c1']);
        assert.strictEqual(chats.c1.messages.length, 3);
        assert.strictEqual(chats.c1.messages[2].role, 'approval');
        assert.strictEqual(chats.c1.messages[2].status, 'pending');
        assert.ok(t.pend['c1:2'], 'resolver keyed at the hydrated index');
    });

    test('showToolApprovalPrompt fails closed on a restore miss (deny, no row, no TypeError)', async function() {
        var chats = { c1: skeleton('c1') };
        var opts = {};
        var t = await load(chats, restorer(chats, null));
        var v = await t.m.showToolApprovalPrompt('Web Fetch', {}, 'web_fetch', 'tc1', 'web_fetch', 'c1', opts);
        assert.strictEqual(v, false);
        assert.strictEqual(opts._gaveUp, true);
        assert.ok(!('messages' in chats.c1), 'never writes messages:[] onto the skeleton');
        assert.strictEqual(Object.keys(t.pend).length, 0);
    });

    test('showToolApprovalPromptBatch dedupes against the HYDRATED rows', async function() {
        var chats = { c1: skeleton('c1') };
        var t = await load(chats, restorer(chats, [{ role: 'approval', status: 'denied', toolCallId: 'tcX' }]));
        var v = await t.m.showToolApprovalPromptBatch('Web Fetch', {}, 'web_fetch', 'tcX', 'web_fetch', 'c1');
        assert.strictEqual(v, false);
        assert.strictEqual(chats.c1.messages.length, 1, 'no duplicate row appended');
    });

    test('showToolApprovalPromptBatch restore miss resolves false without throwing', async function() {
        var chats = { c1: skeleton('c1') };
        var t = await load(chats, restorer(chats, null));
        var v = await t.m.showToolApprovalPromptBatch('Web Fetch', {}, 'web_fetch', 'tcY', 'web_fetch', 'c1');
        assert.strictEqual(v, false);
        assert.ok(!('messages' in chats.c1));
    });

    test('handleApproval on a skeleton hydrates and applies the verdict', async function() {
        var chats = { c1: skeleton('c1') };
        var t = await load(chats, restorer(chats, [{ role: 'user', content: 'hi' },
            { role: 'approval', status: 'pending', toolCallId: 'tc1', toolName: 'Web Fetch' }]));
        var resolve = rec();
        t.pend['c1:1'] = { resolve: resolve, approvalIndex: 1, chatId: 'c1', toolCallId: 'tc1' };
        await t.m.handleApproval(1, 'allow', true, 'c1');
        assert.strictEqual(resolve.calls.length, 1);
        assert.strictEqual(resolve.calls[0][0], true);
        assert.notStrictEqual(chats.c1.messages[1].status, 'pending');
    });

    test('handleApproval restore miss is a no-op (no resolve, no TypeError, skeleton intact)', async function() {
        var chats = { c1: skeleton('c1') };
        var t = await load(chats, restorer(chats, null));
        var resolve = rec();
        t.pend['c1:1'] = { resolve: resolve, approvalIndex: 1, chatId: 'c1', toolCallId: 'tc1' };
        await t.m.handleApproval(1, 'allow', true, 'c1');
        assert.strictEqual(resolve.calls.length, 0);
        assert.ok(!('messages' in chats.c1));
        assert.ok(t.pend['c1:1'], 'pending entry kept for a later retry');
    });

    test('hydrated chats never call ensureChatPayloads (behaviour-identical)', async function() {
        var chats = { c1: { id: 'c1', messages: [{ role: 'user', content: 'hi' }] } };
        var ensure = restorer(chats, null);
        var t = await load(chats, ensure);
        t.m.showToolApprovalPrompt('Web Fetch', {}, 'web_fetch', 'tc1', 'web_fetch', 'c1');
        assert.strictEqual(chats.c1.messages.length, 2, 'row appended synchronously as before');
        await t.m.handleApproval(1, 'deny', true, 'c1');
        assert.strictEqual(ensure.calls.length, 0);
    });

    test('chatHasPendingApproval / Prompt answer a skeleton from the stored row', async function() {
        var chats = { c1: skeleton('c1'), c2: { id: 'c2', messages: [{ role: 'prompt_user', status: 'pending' }] } };
        var stored = [{ role: 'approval', status: 'pending' }];
        var slots = [];
        var t = await load(chats, restorer(chats, null), {
            skeletonScanValue: function(slot, id, chat, fn, fallback, rerender) {
                slots.push(slot); assert.strictEqual(typeof rerender, 'function');
                return fn({ messages: stored });
            }
        });
        assert.strictEqual(t.m.chatHasPendingApproval('c1'), true);
        assert.strictEqual(t.m.chatHasPendingPrompt('c1'), false);
        assert.deepStrictEqual(slots, ['pendingApproval', 'pendingPrompt']);
        assert.strictEqual(t.m.chatHasPendingPrompt('c2'), true, 'hydrated chat scanned live');
        assert.strictEqual(slots.length, 2, 'hydrated chat bypasses the skeleton scan');
    });
});

describe('C2-ui ui/220 approve-from-notification on a skeleton', function() {
    async function env(chats, handleApproval) {
        var src = await loadFile('src/js/ui/220-notification-system.js');
        var body = 'var currentApprovalNotification = null;\n'
            + _cutFns(src, ['approveFromNotification', 'approveAllFromNotification'])
            + '\nreturn { one: approveFromNotification, all: approveAllFromNotification };';
        var runAgent = rec();
        var api = new Function('chats', 'currentChatId', 'handleApproval', 'getApprovalCardEl', 'showNextApprovalNotification',
            'rerenderCurrentNotification', 'runAgent', 'setTimeout', body)(chats, 'c1', handleApproval || async function() {}, function() { return null; },
            function() {}, function() {}, runAgent, function(fn) { fn(); return 0; });
        return { api: api, runAgent: runAgent };
    }
    test('a skeleton that stays unhydrated: no TypeError, no runAgent', async function() {
        var e = await env({ c1: skeleton('c1') });
        await e.api.one(1, 'c1', 'allow');
        await e.api.all([0, 1], 'c1', 'allow');
        assert.strictEqual(e.runAgent.calls.length, 0);
    });
    test('a skeleton still gets its verdict forwarded to handleApproval (one and all)', async function() {
        var calls = [];
        var ha = async function() { calls.push([].slice.call(arguments)); };
        var e = await env({ c1: skeleton('c1') }, ha);
        await e.api.one(1, 'c1', 'allow');
        assert.deepStrictEqual(calls, [[1, 'allow', true, 'c1']]);
        calls.length = 0;
        await e.api.all([1], 'c1', 'allow');
        assert.deepStrictEqual(calls, [[1, 'allow', true, 'c1']]);
        calls.length = 0;
        await e.api.all('[1]', 'c1', 'allow');
        assert.deepStrictEqual(calls, [[1, 'allow', true, 'c1']], 'JSON string indices from onclick');
        assert.strictEqual(e.runAgent.calls.length, 0);
    });
    test('hydrated chat keeps the old behaviour (runAgent for a non-programmatic allow)', async function() {
        var e = await env({ c1: { messages: [{ role: 'approval', toolCallId: 'tc1' }, { role: 'approval', toolCallId: 'prog_x' }] } });
        await e.api.one(0, 'c1', 'allow');
        assert.strictEqual(e.runAgent.calls.length, 1);
        await e.api.all([0, 1], 'c1', 'allow');
        assert.strictEqual(e.runAgent.calls.length, 1, 'programmatic row suppresses runAgent');
    });
});

describe('C2-ui ui/175 worker-strip scans on a skeleton', function() {
    async function env(chats, rows) {
        var u = await loadFile('src/js/ui/120-ui-utils.js');
        var s = await loadFile('src/js/ui/175-sub-agent-ui.js');
        var body = 'var _skelScanMemo = {}, _skelScanWant = {}, _skelScanQueue = [], _skelScanBusy = false, _skelScanRerenders = [], _skelScanTimer = null;\n'
            + 'var _subWorkStatsCache = Object.create(null);\n'
            + 'function _subContextLimit() { return 1000; }\n'
            + 'function chatMessageCount(c) { return Array.isArray(c.messages) ? c.messages.length : (c._msgCount || 0); }\n'
            + _cutFns(u, ['_isSkeletonChat', '_skelScanSig', '_skelClone', 'skeletonScanValue', '_skelScanPump']) + '\n'
            + _cutFns(s, ['_subUiIsSkeleton', '_subSkelRerender', '_subLastInputTokens', '_subContextInfo', '_subWorkStats',
                '_reportStatusToWorkerState', '_reconstructSubsFromMessages', '_reconstructSubsFromChat'])
            + '\nreturn { ctx: _subContextInfo, stats: _subWorkStats, subs: _reconstructSubsFromMessages };';
        var reads = [], strip = rec();
        var api = new Function('chats', 'loadChatRowFromDB', 'renderWorkersStrip', 'getPushedPRsForChat', 'setTimeout', 'clearTimeout', body)(
            chats, function(id) { reads.push(id); return Promise.resolve(rows[id] || null); }, strip,
            function(c) { return c.messages.filter(function(m) { return m.role === 'pr'; }); },
            function(fn) { fn(); return 1; }, function() {});
        return { api: api, reads: reads, strip: strip };
    }
    var ROW = { messages: [
        { role: 'assistant', metrics: { input_tokens: 400 } },
        { role: 'pr' },
        { role: 'sub_report', subAgentId: 'sub_1', subAgentName: 'W1', subChatId: 'k1', report: { status: 'done', at: 9 } }
    ] };
    test('skeleton: fallback first, stored-row read, then memoized values + one re-render', async function() {
        var chats = { s: skeleton('s', 3) };
        var e = await env(chats, { s: ROW });
        assert.strictEqual(e.api.ctx('s').tokens, 0);
        assert.deepStrictEqual(e.api.stats('s'), { n: 3, files: 0, prs: 0 });
        assert.deepStrictEqual(e.api.subs('s'), []);
        await ticks();
        assert.ok(e.reads.length >= 1 && e.reads.every(function(id) { return id === 's'; }), 'stored-row reads only');
        assert.strictEqual(e.strip.calls.length, 1);
        assert.deepStrictEqual(e.api.ctx('s'), { tokens: 400, pct: 40 });
        assert.deepStrictEqual(e.api.stats('s'), { n: 3, files: 0, prs: 1 });
        var subs = e.api.subs('s');
        assert.strictEqual(subs.length, 1);
        assert.strictEqual(subs[0].agent_id, 'sub_1');
        assert.ok(!('messages' in chats.s), 'the skeleton is never re-attached');
    });
    test('skeleton with no stored row: fallbacks, no TypeError', async function() {
        var chats = { s: skeleton('s', 3) };
        var e = await env(chats, {});
        e.api.ctx('s'); e.api.stats('s'); e.api.subs('s');
        await ticks();
        assert.strictEqual(e.api.ctx('s').tokens, 0);
        assert.deepStrictEqual(e.api.subs('s'), []);
    });
    test('hydrated chat: live scan, no stored-row read', async function() {
        var chats = { h: { id: 'h', messages: ROW.messages.slice() } };
        var e = await env(chats, {});
        assert.strictEqual(e.api.ctx('h').tokens, 400);
        assert.strictEqual(e.api.stats('h').prs, 1);
        assert.strictEqual(e.api.subs('h').length, 1);
        await ticks();
        assert.strictEqual(e.reads.length, 0);
    });
});
