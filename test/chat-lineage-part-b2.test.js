// Lineage fix part B (2/2): background-action continue (M2) and the capped
// copy growth in copyLineagePageState (O(n²) guard).
var T = { tags: ['unit'], timeout: 8000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
var EX = await runFile('test/extract.js', { i18n: false });
function cutFns(src, names) {
    var mask = EX.codeMask(src);
    return names.map(function(n) {
        var f = EX.findFunction(src, n, { mask: mask });
        if (!(f && f.end > f.start)) throw new Error('function not found: ' + n);
        return src.slice(f.start, f.end);
    }).join('\n');
}
async function loadCopy(env) {
    var src = await loadFile('src/js/ui/170-chat-management.js');
    var caps = eval('(' + src.match(/var LINEAGE_COPY_CAPS = ([^;]+);/)[1] + ')');
    return { copy: new Function('env', 'with (env) {\n' + cutFns(src, ['copyLineagePageState']) + '\nreturn copyLineagePageState; }')(env), caps: caps };
}

describe('lineage part B2', function() {
    test('M2 finishActionIfDone skips the chat whose summary is pending, stamps auto-finalize otherwise', async function() {
        var src = await loadFile('src/js/tools/120-actions.js');
        var persisted = [];
        var env = {
            chats: { O: { isBackground: true, actionId: 'a1', messages: [{ role: 'user' }, { role: 'assistant' }] } },
            activeActions: { a1: { chatId: 'O', state: 'running', label: 'Work' } },
            pendingSummaryRequest: { chatId: 'O' },
            isChatPaused: function() { return false; },
            _chatNeverStarted: function() { return false; },
            N_: function(s) { return s; },
            persistActionState: async function(id) { persisted.push(id); },
            notifyActionStateChanged: function() {}
        };
        var fin = new Function('env', 'with (env) {\n' + cutFns(src, ['finishActionIfDone']) + '\nreturn finishActionIfDone; }')(env);
        await fin('O');
        assert.strictEqual(env.activeActions.a1.state, 'running', 'summary pending: not finalized');
        assert.strictEqual(persisted.length, 0);
        env.pendingSummaryRequest = null;
        await fin('O');
        var a = env.activeActions.a1;
        assert.strictEqual(a.state, 'done');
        assert.strictEqual(a._autoFinalizedAt, a.updatedAt, 'auto-finalize stamped');
    }, T);

    test('M2 moving an auto-finalized action reopens it; an explicit later update is kept', async function() {
        var notified = [];
        var env = {
            chats: { O: { isBackground: true, actionId: 'a1' }, N: {}, P: {}, Q: {} },
            activeActions: {
                a1: { chatId: 'O', state: 'done', updatedAt: 5, _autoFinalizedAt: 5 },
                a2: { chatId: 'P', state: 'done', updatedAt: 9, _autoFinalizedAt: 5 }
            },
            persistActionState: function() {}, notifyActionStateChanged: function(id) { notified.push(id); }
        };
        var f = await loadCopy(env);
        f.copy('O', 'N', { since: 5 });
        assert.strictEqual(env.activeActions.a1.state, 'running', 'auto-complete undone: the head runs on');
        assert.strictEqual(env.activeActions.a1._autoFinalizedAt, undefined);
        assert.deepStrictEqual(notified, ['a1']);
        assert.strictEqual(env.chats.N._revealed, true, 'head stays visible in history/search');
        assert.strictEqual(env.chats.O.actionId, null);
        assert.strictEqual(env.chats.O.isBackground, null);
        f.copy('P', 'Q', { since: 1 });
        assert.strictEqual(env.activeActions.a2.state, 'done', 'later explicit update not reopened');
    }, T);

    test('M2 SW migration strips the action identity from the old skeleton', async function() {
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var chats = { O: { messages: [], isBackground: true, actionId: 'a1', skillId: 's' }, N: { messages: [] } };
        var env = { chats: chats, console: quiet, registerLineageLink: function() { return true; },
            _swCopyLineageGrants: function() { return 0; } };
        var run = new Function('env', 'with (env) {\n' + cutFns(src, ['_swContinueChatLineage']) + '\nreturn _swContinueChatLineage; }')(env);
        var out = await run('O', 'N');
        assert.strictEqual(out.actions, 'moved');
        assert.strictEqual(chats.O.actionId, null);
        assert.strictEqual(chats.O.isBackground, null);
        assert.strictEqual(chats.N.actionId, 'a1');
        assert.strictEqual(chats.N.skillId, 's');
        assert.ok(out.ok, JSON.stringify(out.errors));
    }, T);

    test('M2 summarizeAndStartNewChat re-runs the deferred finalize after the request settles', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var body = cutFns(src, ['summarizeAndStartNewChat']);
        assert.ok(/pendingSummaryRequest = null;\s*\}\s*\/\/ M2[\s\S]*?finishActionIfDone\(summaryChatId\)/.test(body), 'deferred finalize in the finally');
    }, T);

    test('O(n²) guard: a long chain keeps every successor copy bounded', async function() {
        var env = { chats: {}, persistActionState: function() {} };
        var f = await loadCopy(env);
        var O = { versionHistory: [], cachedToolResults: {}, displays: {}, widgetRenders: {} };
        for (var i = 0; i < 300; i++) {
            O.versionHistory.push({ id: 'v' + i });
            O.cachedToolResults['c' + i] = { timestamp: 1000 - i }; // newest first by insertion
            O.displays['d' + i] = { i: i };
            O.widgetRenders['w' + i] = { _toggledAt: i };
        }
        env.chats.C0 = O;
        for (var n = 1; n <= 5; n++) { env.chats['C' + n] = {}; f.copy('C' + (n - 1), 'C' + n); }
        var H = env.chats.C5;
        assert.strictEqual(H.versionHistory.length, f.caps.versionHistory);
        assert.strictEqual(H.versionHistory[H.versionHistory.length - 1].id, 'v299', 'newest artifact kept');
        assert.strictEqual(H.versionHistory[0].chatId, 'C5');
        var ck = Object.keys(H.cachedToolResults);
        assert.strictEqual(ck.length, f.caps.cachedToolResults);
        assert.ok(ck.indexOf('c0') >= 0 && ck.indexOf('c299') < 0, 'cache cap keeps the newest by timestamp');
        assert.strictEqual(Object.keys(H.displays).length, f.caps.displays);
        assert.ok(H.displays.d299 && !H.displays.d0);
        assert.strictEqual(Object.keys(H.widgetRenders).length, f.caps.widgetRenders);
        assert.ok(H.widgetRenders.w299 && !H.widgetRenders.w0);
        assert.strictEqual(Object.keys(O.displays).length, 300, 'old chat untouched');
    }, T);
});
