// Run: run_tests { files: ['test/summarize-summary-flag.test.js'] } (js_eval sandbox; no Node).
// A2B3-01: the summarize reply's isSummary flag is stamped in the SW realm by
// runAgent's finish (_stampSummaryReply), and the page-side
// completeSummaryAndCreateNewChat accepts an already-stamped reply.
// Source-derived excerpts + a private fake env (with (env)). Never imports the
// page bundle, dispatches to the service worker, or reads/writes a live chat or setting.
'use strict';

// The 170 excerpt calls t(): its with (env) sandbox gets the REAL i18n core first
// (no catalog set = English identity, like the harness auto-include in test/harness.js).
var SSF_I18N = 'src/js/core/025-i18n.js';
var SSF_PATHS = [SSF_I18N, 'src/js/app/030-agent-loop.js', 'src/js/ui/170-chat-management.js'];
var _ssfSources = null;
async function ssfSources() { return _ssfSources || (_ssfSources = await loadSources(SSF_PATHS)); }

// These production declarations use column-zero closing braces. Fail loudly
// if that convention changes instead of silently testing a different excerpt.
function ssfDeclaration(source, name, prefix) {
    var start = source.indexOf((prefix || '') + 'function ' + name + '(');
    var end = source.indexOf('\n}', start);
    if (!(start >= 0 && end > start)) throw new Error('Missing declaration: ' + name);
    return source.slice(start, end + 2);
}
function ssfI18n(sources) {
    var core = sources[SSF_I18N];
    if (typeof core !== 'string' || core.indexOf('function t(') < 0) throw new Error('missing i18n core source: ' + SSF_I18N);
    return core;
}
async function ssfStampFn() {
    var src = (await ssfSources())['src/js/app/030-agent-loop.js'];
    return new Function(ssfDeclaration(src, '_stampSummaryReply') + '\nreturn _stampSummaryReply;')();
}

describe('summarize › isSummary flag (A2B3-01)', function() {
    test('_stampSummaryReply stamps the tool-free reply of an isSummaryRequest turn', async function() {
        var stamp = await ssfStampFn();
        var chat = { messages: [
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer' },
            { role: 'user', content: 'Please summarize this conversation', isSummaryRequest: true },
            { role: 'assistant', content: 'let me check', tool_calls: [{ id: 'tc1' }] },
            { role: 'tool', tool_call_id: 'tc1', content: '{}' },
            { role: 'assistant', content: 'THE SUMMARY' }
        ] };
        assert.strictEqual(stamp(chat), true, 'stamps and reports it (caller saves)');
        assert.strictEqual(chat.messages[5].isSummary, true, 'the final tool-free reply is marked');
        assert.strictEqual(chat.messages[3].isSummary, undefined, 'the tool_calls row is never marked');
        assert.strictEqual(chat.messages[1].isSummary, undefined, 'earlier turns are untouched');
        assert.strictEqual(stamp(chat), false, 'already stamped: no second stamp / save');
    }, { tags: ['unit'] });

    test('_stampSummaryReply is a no-op for a normal turn, a tool_calls reply and an aggregate row', async function() {
        var stamp = await ssfStampFn();
        var normal = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
        assert.strictEqual(stamp(normal), false);
        assert.strictEqual(normal.messages[1].isSummary, undefined, 'normal turn reply not marked');
        var toolCalls = { messages: [{ role: 'user', content: 'sum', isSummaryRequest: true },
            { role: 'assistant', content: 'checking first', tool_calls: [{ id: 'tc1' }] }] };
        assert.strictEqual(stamp(toolCalls), false);
        assert.strictEqual(toolCalls.messages[1].isSummary, undefined, 'tool_calls reply stays resumable (030 pending-tool scan)');
        var aggregate = { messages: [{ role: 'user', content: 'sum', isSummaryRequest: true },
            { role: 'assistant', content: 'agg', metrics: { isAggregate: true, callCount: 2 } }] };
        assert.strictEqual(stamp(aggregate), false);
        assert.strictEqual(aggregate.messages[1].isSummary, undefined, 'aggregate metric row not marked');
        assert.strictEqual(stamp({ messages: [{ role: 'user', content: 'sum', isSummaryRequest: true }] }), false, 'no reply yet');
        assert.strictEqual(stamp(null), false);
        assert.strictEqual(stamp({}), false);
    }, { tags: ['unit'] });

    test('completeSummaryAndCreateNewChat uses an already-stamped reply', async function() {
        var all = await ssfSources(), src = all['src/js/ui/170-chat-management.js'];
        var code = ssfI18n(all) + '\n' + ssfDeclaration(src, 'completeSummaryAndCreateNewChat');
        var snacks = [], runs = 0, saves = 0;
        function noop() {}
        var env = {
            pendingSummaryRequest: { chatId: 'Z', chatTitle: 'Old chat' },
            chats: { Z: { id: 'Z', messages: [
                { role: 'user', content: 'Please summarize', isSummaryRequest: true },
                { role: 'assistant', content: 'THE SUMMARY', isSummary: true }, // stamped by the SW finish
                { role: 'assistant', content: '', metrics: { isAggregate: true, callCount: 2 }, isSummary: true }
            ] } },
            currentChatId: 'Z', versionHistory: ['v1'], stickToBottom: false, paused: true,
            generateId: function() { return 'N'; },
            showSnackbar: function(m, kind) { snacks.push(kind + ':' + m); },
            appStorage: { setItem: noop }, pushFocusChatToOffscreen: noop,
            saveChatsToStorage: function() { saves++; },
            clearUpdateSet: noop, renderChatList: noop, renderMessages: noop, renderVersionSidebar: noop,
            updateChatTitleHeader: noop, renderWorkersStrip: noop, setChatPausedPersistent: noop,
            pushPauseToggleToOffscreen: noop, syncPauseButtonUI: noop,
            runAgent: function() { runs++; return Promise.resolve(); }
        };
        // Every production global used by this excerpt is supplied in env.
        var fn = new Function('env', 'with (env) {\n' + code + '\nreturn completeSummaryAndCreateNewChat;\n}')(env);
        fn();
        await Promise.resolve(); await Promise.resolve();
        assert.strictEqual(snacks.some(function(s) { return /Failed to generate summary/.test(s); }), false, 'no failure snackbar');
        assert.ok(env.chats.N, 'continued chat created');
        assert.match(env.chats.N.messages[0].content, /THE SUMMARY/);
        assert.strictEqual(env.currentChatId, 'N');
        assert.strictEqual(env.pendingSummaryRequest, null);
        assert.strictEqual(env.chats.Z.messages[1].isSummary, true, 'reply keeps its mark');
        assert.ok(saves >= 1); assert.strictEqual(runs, 1, 'continued chat auto-starts once');
    }, { tags: ['unit'] });

    test('_stampSummaryReply( comes before isAggregate: true', async function() {
        var src = (await ssfSources())['src/js/app/030-agent-loop.js'];
        var body = ssfDeclaration(src, 'runAgent', 'async ');
        var pausedAt = body.indexOf('var _exitedPaused = isChatPaused(streamingChatId);');
        var stampAt = body.indexOf('_stampSummaryReply(');
        var aggAt = body.indexOf('isAggregate: true');
        assert.ok(pausedAt >= 0 && aggAt >= 0, 'runAgent excerpt covers the finish');
        assert.ok(stampAt > pausedAt, 'stamp runs after the pause sample');
        assert.ok(stampAt < aggAt, 'stamp runs before the aggregate row is pushed');
        var line = body.slice(body.lastIndexOf('\n', stampAt) + 1, body.indexOf('\n', stampAt));
        assert.match(line, /!_exitedPaused && _stampSummaryReply\(chat\)/, 'never stamps on a pause exit');
    }, { tags: ['unit'] });
});
