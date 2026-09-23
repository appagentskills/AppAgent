// Approval hardening — C1(c) handleApproval (ui/160-notifications.js),
// S1 recorded-approval binding (worker/120-tool-routing.js + ui/150-tool-approval.js),
// H2 abandon cancels approval prompts (worker/120-tool-routing.js).
// Each "must not" test FAILS on the pre-fix code:
//  - handleApproval(-1,'allow') adopted the sole pending approval (resolve(true));
//  - an unknown action computed approved = action !== 'deny' → true;
//  - a recorded 'allowed' row matched by toolCallId alone → allowed:true;
//  - abandonPendingUIToolCall looked up _pendingUIToolCalls[toolCallId] and
//    parked entries by toolCallId, missing approval entries keyed by approvalRequestId.
function rec() { var f = function() { f.calls.push([].slice.call(arguments)); }; f.calls = []; return f; }

describe('C1(c) handleApproval hardening', function() {
    async function load() {
        var resolve = rec();
        var chats = { c1: { id: 'c1', messages: [{ role: 'user', content: 'hi' }, { role: 'approval', status: 'pending', toolCallId: 'tc1', toolName: 'Web Fetch' }] } };
        var pend = { 'c1:1': { resolve: resolve, approvalIndex: 1, chatId: 'c1', toolCallId: 'tc1' } };
        var m = await loadModules(['src/js/ui/160-notifications.js'], { lenient: true, globals: {
            window: fakeWindow(), chats: chats, currentChatId: 'c1', pendingToolApprovals: pend, sessionPermissions: {},
            saveChatsToStorage: rec(), renderMessages: rec(), renderChatList: rec(), runAgent: rec(),
            setTimeout: function() { return 0; }, chatPermKey: function(r, k) { return r + '::' + k; }, setToolPermissionByKey: rec() } });
        return { m: m, resolve: resolve, row: chats.c1.messages[1], pend: pend };
    }
    test('handleApproval(-1, allow) with ONE pending approval does NOT resolve it', async function() {
        var t = await load();
        await t.m.handleApproval(-1, 'allow', false, 'c1');
        assert.strictEqual(t.resolve.calls.length, 0);
        assert.strictEqual(t.row.status, 'pending');
        await t.m.handleApproval('x', 'allow', false, 'c1');
        await t.m.handleApproval(99, 'allow', false, 'c1');
        assert.strictEqual(t.resolve.calls.length, 0);
        assert.ok(t.pend['c1:1'], 'resolver still pending');
    }, { tags: ['unit'], timeout: 3000 });
    test('unknown action never approves (default deny)', async function() {
        var t = await load();
        await t.m.handleApproval(1, 'pwn', false, 'c1');
        assert.deepStrictEqual(t.resolve.calls, [[false]]);
        assert.strictEqual(t.row.status, 'denied');
    }, { tags: ['unit'], timeout: 3000 });
    test('legit allow + merge-drift (old in-range index) still resolve true', async function() {
        var t = await load();
        await t.m.handleApproval(0, 'allow', true, 'c1');   // stale index 0, sole pending entry
        assert.deepStrictEqual(t.resolve.calls, [[true]]);
        assert.strictEqual(t.row.status, 'allowed');
    }, { tags: ['unit'], timeout: 3000 });
});

describe('Approval row reuse: cancelled is terminal', function() {
    async function loadWith(status) {
        var chats = { c1: { id: 'c1', title: 'T', messages: [{ role: 'user', content: 'hi' }, { role: 'approval', status: status, toolCallId: 'tcX', toolName: 'Web Fetch' }] } };
        var pend = {};
        var notified = rec();
        var m = await loadModules(['src/js/ui/160-notifications.js'], { lenient: true, globals: {
            window: fakeWindow(), chats: chats, currentChatId: 'c1', currentView: 'chat', pendingToolApprovals: pend, sessionPermissions: {},
            saveChatsToStorage: rec(), renderMessages: rec(), renderChatList: rec(), runAgent: rec(), scrollToBottomIfAllowed: rec(),
            setTimeout: function() { return 0; } } });
        m.__scope.showApprovalNotification = notified;
        return { m: m, pend: pend, chats: chats, notified: notified };
    }
    function settle(p) {
        return Promise.race([p.then(function(v) { return { v: v }; }), new Promise(function(r) { sleep(300).then(function() { r('hung'); }); })]);
    }
    // OLD: 'cancelled' fell through to the pending-reuse branch → resolver
    // rebound to a row nobody will answer → the caller hung forever.
    test('showToolApprovalPrompt: existing cancelled row resolves false, no rebind', async function() {
        var t = await loadWith('cancelled');
        var r = await settle(t.m.showToolApprovalPrompt('Web Fetch', {}, 'web_fetch', 'tcX', 'web_fetch', 'c1'));
        assert.deepStrictEqual(r, { v: false });
        assert.deepStrictEqual(Object.keys(t.pend), [], 'no resolver rebound');
        assert.strictEqual(t.chats.c1.messages.length, 2, 'no duplicate row');
    }, { tags: ['unit'], timeout: 3000 });
    test('showToolApprovalPromptBatch: existing cancelled row resolves false, no rebind', async function() {
        var t = await loadWith('cancelled');
        var r = await settle(t.m.showToolApprovalPromptBatch('Web Fetch', {}, 'web_fetch', 'tcX', 'web_fetch', 'c1'));
        assert.deepStrictEqual(r, { v: false });
        assert.deepStrictEqual(Object.keys(t.pend), []);
        assert.strictEqual(t.chats.c1.messages.length, 2);
    }, { tags: ['unit'], timeout: 3000 });
    test('still-pending row is reused (no regression)', async function() {
        var t = await loadWith('pending');
        t.m.showToolApprovalPrompt('Web Fetch', {}, 'web_fetch', 'tcX', 'web_fetch', 'c1');
        assert.deepStrictEqual(Object.keys(t.pend), ['c1:1']);
        assert.strictEqual(t.chats.c1.messages.length, 2);
    }, { tags: ['unit'], timeout: 3000 });
});

function approvalRow(tool, args, status) {
    return { role: 'approval', toolCallId: 'prog_js1_1', toolName: tool === 'web_fetch' ? 'Web Fetch' : 'ServiceNow API', actualToolName: tool,
        permissionKey: tool === 'web_fetch' ? 'web_fetch' : 'servicenow_api:DELETE', args: args, status: status || 'allowed' };
}
var PERM_STUBS = {
    resolvePermissionKey: function(t, m) { return m ? t + ':' + m : t; },
    getToolPermission: function() { return 'ask'; },
    getToolDisplayName: function(t) { return t === 'web_fetch' ? 'Web Fetch' : 'ServiceNow API'; }
};
var SN_ARGS = { method: 'DELETE', path: '/api/now/table/incident/1' };
var WF_ARGS = { url: 'https://example.com' };

describe('S1 recorded approval is bound to the tool + args (worker stub)', function() {
    async function load(rows) {
        var m = await loadModules(['src/js/worker/120-tool-routing.js'], { lenient: true, globals: Object.assign({
            window: fakeWindow(), chrome: fakeChrome(), chats: { c1: { id: 'c1', messages: rows } }, parkedToolCallsByChatId: {},
            AgentEvents: { emit: function() {} }, saveChatsToStorage: function() {}, _agentSubscribers: new Set() }, PERM_STUBS) });
        // no panel connected (real pickExecutorPort over an empty subscriber set) → the prompt parks
        // the SW stub is assigned (not declared) at load → lives on the module scope
        m.requestProgrammaticToolApproval = m.requestProgrammaticToolApproval || m.__scope.requestProgrammaticToolApproval;
        assert.strictEqual(typeof m.requestProgrammaticToolApproval, 'function', 'real SW approval stub loaded');
        return m;
    }
    async function settleOrPending(p) {
        return Promise.race([p, new Promise(function(r) { setTimeout(function() { r('PENDING'); }, 50); })]);
    }
    test('web_fetch approval does NOT authorize servicenow_api with the same toolCallId', async function() {
        var m = await load([approvalRow('web_fetch', WF_ARGS)]);
        var p = m.requestProgrammaticToolApproval('servicenow_api', SN_ARGS, { toolCallId: 'prog_js1_1', chatId: 'c1' });
        var r = await settleOrPending(p);
        assert.strictEqual(r, 'PENDING', 'must prompt fresh, not reuse the web_fetch verdict');
        var parked = m.__scope.parkedToolCallsByChatId.c1 || [];
        assert.strictEqual(parked.length, 1);
        assert.notStrictEqual(parked[0].input.toolCallId, 'prog_js1_1', 'fresh id so the new row is seeded');
        m.cancelParkedToolCall('c1', parked[0].toolCallId, 'test cleanup');
        var done = await p;
        assert.strictEqual(done.allowed, false);
    }, { tags: ['unit'], timeout: 3000 });
    test('same tool, different args → not reused; same tool+args → reused (dedup kept)', async function() {
        var m = await load([approvalRow('web_fetch', WF_ARGS)]);
        var p = m.requestProgrammaticToolApproval('web_fetch', { url: 'https://evil.example' }, { toolCallId: 'prog_js1_1', chatId: 'c1' });
        assert.strictEqual(await settleOrPending(p), 'PENDING');
        m.cancelParkedToolCall('c1', m.__scope.parkedToolCallsByChatId.c1[0].toolCallId, 'cleanup'); await p;
        var ok = await m.requestProgrammaticToolApproval('web_fetch', { url: 'https://example.com' }, { toolCallId: 'prog_js1_1', chatId: 'c1' });
        assert.strictEqual(ok.allowed, true);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('S1 recorded approval is bound to the tool + args (page)', function() {
    test('page requestProgrammaticToolApproval re-prompts on a cross-tool id collision', async function() {
        var prompts = [];
        var chats = { c1: { id: 'c1', messages: [approvalRow('web_fetch', WF_ARGS)] } };
        var m = await loadModules(['src/js/ui/150-tool-approval.js'], { lenient: true, globals: Object.assign({
            chats: chats, activeStreamingChatId: null, currentChatId: 'c1',
            showToolApprovalPrompt: function(dn, a, pk, tcId) { prompts.push(tcId); return Promise.resolve(false); },
            showToolApprovalPromptBatch: function() { return Promise.resolve(false); } }, PERM_STUBS) });
        var r = await m.requestProgrammaticToolApproval('servicenow_api', SN_ARGS, { toolCallId: 'prog_js1_1', chatId: 'c1' });
        assert.strictEqual(r.allowed, false);
        assert.strictEqual(prompts.length, 1, 'user is prompted');
        assert.notStrictEqual(prompts[0], 'prog_js1_1');
        var same = await m.requestProgrammaticToolApproval('web_fetch', { url: 'https://example.com' }, { toolCallId: 'prog_js1_1', chatId: 'c1' });
        assert.strictEqual(same.allowed, true);
        assert.strictEqual(prompts.length, 1, 'matching call reuses the verdict without prompting');
    }, { tags: ['unit'], timeout: 3000 });
});

describe('H2 abandon cancels live + parked approval prompts', function() {
    test('abandonPendingUIToolCall resolves approval entries keyed by approvalRequestId', async function() {
        var events = [];
        var rows = [{ role: 'approval', toolCallId: 'tc1', status: 'pending' }, { role: 'approval', toolCallId: 'prog_tc1_1', status: 'pending' },
            { role: 'approval', toolCallId: 'tc_other', status: 'pending' }];
        var m = await loadModules(['src/js/worker/120-tool-routing.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), chats: { c1: { id: 'c1', messages: rows } }, parkedToolCallsByChatId: {},
            AgentEvents: { emit: function(n, p) { events.push([n, p]); } }, saveChatsToStorage: function() {} } });
        var live = rec(), parked = rec(), other = rec();
        var pend = m._pendingUIToolCalls;
        Object.keys(pend).forEach(function(k) { delete pend[k]; });
        pend.approval_A = { resolve: live, reject: function() {}, isApproval: true, toolCallId: 'tc1', chatId: 'c1', port: { postMessage: function() {} } };
        pend.approval_C = { resolve: other, reject: function() {}, isApproval: true, toolCallId: 'tc_other', chatId: 'c1', port: { postMessage: function() {} } };
        m.__scope.parkedToolCallsByChatId.c1 = [{ toolCallId: 'approval_B', name: '__approval_prompt__', input: { toolCallId: 'prog_tc1_1' }, resolve: parked, reject: function() {} }];
        m.abandonPendingUIToolCall('c1', 'tc1', 'user sent a new message');
        assert.strictEqual(live.calls.length, 1);
        assert.strictEqual(live.calls[0][0].allowed, false);
        assert.strictEqual(live.calls[0][0].cancelled, true);
        assert.strictEqual(parked.calls.length, 1);
        assert.strictEqual(parked.calls[0][0].allowed, false);
        assert.ok(!pend.approval_A, 'live entry removed');
        assert.strictEqual(m.__scope.parkedToolCallsByChatId.c1.length, 0, 'parked entry removed');
        assert.strictEqual(rows[0].status, 'cancelled');
        assert.strictEqual(rows[1].status, 'cancelled');
        assert.strictEqual(other.calls.length, 0, 'unrelated approval untouched');
        assert.ok(pend.approval_C);
        assert.strictEqual(rows[2].status, 'pending');
        assert.ok(events.some(function(e) { return e[0] === 'approvalSettled' && e[1].toolCallId === 'tc1'; }), 'panels told to drop the card');
    }, { tags: ['unit'], timeout: 3000 });
});
