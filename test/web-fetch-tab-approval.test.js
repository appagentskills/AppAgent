// web_fetch tab_id: the GitHub REST 'ask' -> 'auto' approval downgrade must NOT
// apply to in-tab calls (they run as the user inside a page), on both gates:
// page (ui/150-tool-approval.js) and service worker (worker/120-tool-routing.js).
// Without tab_id the downgrade still applies.

var WFTA_STUBS = {
    resolvePermissionKey: function(t, m) { return m ? t + ':' + m : t; },
    getToolPermission: function() { return 'ask'; },
    getToolDisplayName: function() { return 'Web Fetch'; }
};
var WFTA_URL = 'https://api.github.com/repos/o/r/pulls';

describe('web_fetch tab_id approval: page gate (ui/150)', function() {
    async function load(ghCalls, prompts) {
        return loadModules(['src/js/ui/150-tool-approval.js'], { lenient: true, globals: Object.assign({
            chats: { c1: { id: 'c1', messages: [] } }, activeStreamingChatId: null, currentChatId: 'c1',
            isConfiguredGitHubApiUrl: async function(u) { ghCalls.push(u); return true; },
            showToolApprovalPrompt: function(dn, a, pk, tcId) { prompts.push(tcId); return Promise.resolve(false); },
            showToolApprovalPromptBatch: function() { return Promise.resolve(false); }
        }, WFTA_STUBS) });
    }

    test('GitHub URL without tab_id: downgraded to auto (silent)', async function() {
        var gh = [], prompts = [];
        var m = await load(gh, prompts);
        var r = await m.requestProgrammaticToolApproval('web_fetch', { url: WFTA_URL }, { chatId: 'c1' });
        assert.strictEqual(r.allowed, true);
        assert.strictEqual(r.permission, 'auto');
        assert.strictEqual(gh.length, 1);
        assert.strictEqual(prompts.length, 0);
    }, { tags: ['unit'], timeout: 3000 });

    test('GitHub URL WITH tab_id (number or string): keeps ask and prompts', async function() {
        var gh = [], prompts = [];
        var m = await load(gh, prompts);
        var r = await m.requestProgrammaticToolApproval('web_fetch', { url: WFTA_URL, tab_id: 12 }, { chatId: 'c1' });
        assert.strictEqual(r.allowed, false, 'prompt declined -> not allowed');
        assert.strictEqual(r.permission, 'ask');
        assert.strictEqual(prompts.length, 1, 'user was prompted');
        var s = await m.requestProgrammaticToolApproval('web_fetch', { url: WFTA_URL, tab_id: '12' }, { chatId: 'c1' });
        assert.strictEqual(s.permission, 'ask');
        assert.strictEqual(prompts.length, 2);
        assert.strictEqual(gh.length, 0, 'GitHub matcher never consulted for tab_id calls');
        // empty-string tab_id is "no tab": downgrade still applies.
        var e = await m.requestProgrammaticToolApproval('web_fetch', { url: WFTA_URL, tab_id: '' }, { chatId: 'c1' });
        assert.strictEqual(e.permission, 'auto');
        assert.strictEqual(e.allowed, true);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('web_fetch tab_id approval: worker gate (worker/120)', function() {
    async function load(ghCalls) {
        var m = await loadModules(['src/js/worker/120-tool-routing.js'], { lenient: true, globals: Object.assign({
            window: fakeWindow(), chrome: fakeChrome(), chats: { c1: { id: 'c1', messages: [] } }, parkedToolCallsByChatId: {},
            AgentEvents: { emit: function() {} }, saveChatsToStorage: function() {}, _agentSubscribers: new Set(),
            isConfiguredGitHubApiUrl: async function(u) { ghCalls.push(u); return true; }
        }, WFTA_STUBS) });
        m.requestProgrammaticToolApproval = m.requestProgrammaticToolApproval || m.__scope.requestProgrammaticToolApproval;
        assert.strictEqual(typeof m.requestProgrammaticToolApproval, 'function');
        return m;
    }
    function settleOrPending(p) {
        return Promise.race([p, new Promise(function(r) { setTimeout(function() { r('PENDING'); }, 50); })]);
    }

    test('GitHub URL without tab_id: downgraded to auto (silent)', async function() {
        var gh = [];
        var m = await load(gh);
        var r = await m.requestProgrammaticToolApproval('web_fetch', { url: WFTA_URL }, { chatId: 'c1' });
        assert.strictEqual(r.allowed, true);
        assert.strictEqual(r.permission, 'auto');
        assert.strictEqual(gh.length, 1);
    }, { tags: ['unit'], timeout: 3000 });

    test('GitHub URL WITH tab_id: keeps ask (prompt parks), matcher not consulted', async function() {
        var gh = [];
        var m = await load(gh);
        var p = m.requestProgrammaticToolApproval('web_fetch', { url: WFTA_URL, tab_id: 12 }, { chatId: 'c1', toolCallId: 'prog_tab_1' });
        assert.strictEqual(await settleOrPending(p), 'PENDING', 'must prompt, not auto-allow');
        assert.strictEqual(gh.length, 0);
        var parked = m.__scope.parkedToolCallsByChatId.c1 || [];
        assert.strictEqual(parked.length, 1);
        m.cancelParkedToolCall('c1', parked[0].toolCallId, 'test cleanup');
        var done = await p;
        assert.strictEqual(done.allowed, false);
    }, { tags: ['unit'], timeout: 3000 });
});
