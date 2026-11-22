// Run: run_tests { files: ['test/summarize-summary-flag.test.js'] } (js_eval sandbox; no Node).
// A2B3-01: the summarize reply's isSummary flag is stamped in the SW realm by
// runAgent's finish (_stampSummaryReply), and the page-side
// completeSummaryAndCreateNewChat accepts an already-stamped reply.
// Source-derived excerpts + a private fake env (with (env)). Never imports the
// page bundle, dispatches to the service worker, or reads/writes a live chat or setting.
'use strict';

// The 170 excerpt calls t(): its with (env) sandbox gets the REAL i18n core first
// (no catalog set = English identity, like the harness auto-include in test/harness.js).
var EX = await runFile('test/extract.js', { i18n: false });
var SSF_I18N = 'src/js/core/025-i18n.js';
var SSF_PATHS = [SSF_I18N, 'src/js/app/030-agent-loop.js', 'src/js/ui/170-chat-management.js'];
var _ssfSources = null;
async function ssfSources() { return _ssfSources || (_ssfSources = await loadSources(SSF_PATHS)); }

// These production declarations use column-zero closing braces. Fail loudly
// if that convention changes instead of silently testing a different excerpt.
function ssfDeclaration(source, name, prefix) {
    var f = EX.findFunction(source, name, { includeAsync: !!prefix });
    if (!(f && (!prefix || f.isAsync) && f.end > f.start)) throw new Error('Missing declaration: ' + name);
    return source.slice(f.start, f.end);
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

    test('_stampSummaryReply stamps the continue_in_new_chat call row of an isSummaryRequest turn (#1391)', async function() {
        var stamp = await ssfStampFn();
        var call = { id: 'h1', type: 'function', function: { name: 'continue_in_new_chat', arguments: '{"title":"T","summary":"S"}' } };
        var chat = { messages: [
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer', tool_calls: [{ id: 'old', function: { name: 'continue_in_new_chat', arguments: '{}' } }] },
            { role: 'user', content: 'Please summarize this conversation', isSummaryRequest: true },
            { role: 'assistant', content: '<analysis>x</analysis>', tool_calls: [call] },
            { role: 'tool', tool_call_id: 'h1', content: '{"success":true}' },
            { role: 'assistant', content: 'Handing off.' },
            { role: 'assistant', content: '', metrics: { isAggregate: true, callCount: 2 } }
        ] };
        assert.strictEqual(stamp(chat), true, 'stamps and reports it (caller saves)');
        assert.strictEqual(chat.messages[3].isSummary, true, 'the continue_in_new_chat call row is marked');
        assert.strictEqual(chat.messages[5].isSummary, true, 'the final tool-free reply is still marked');
        assert.strictEqual(chat.messages[6].isSummary, undefined, 'aggregate metric row not marked');
        assert.strictEqual(chat.messages[1].isSummary, undefined, 'a call row before the summary request is untouched');
        assert.strictEqual(chat.messages[4].isSummary, undefined, 'the tool result row is not marked');
        assert.strictEqual(stamp(chat), false, 'already stamped: no second stamp / save');
        // Call-only turn (no trailing text reply): the call row alone is stamped.
        var callOnly = { messages: [{ role: 'user', content: 'sum', isSummaryRequest: true },
            { role: 'assistant', content: '', tool_calls: [call] }] };
        assert.strictEqual(stamp(callOnly), true);
        assert.strictEqual(callOnly.messages[1].isSummary, true);
        // Same call outside a summary-request turn: never stamped.
        var normal = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', tool_calls: [call] }] };
        assert.strictEqual(stamp(normal), false);
        assert.strictEqual(normal.messages[1].isSummary, undefined);
    }, { tags: ['unit'] });

    test('_stampSummaryReply skips rows injected mid-run (worker reports, queued user text) (#1391)', async function() {
        var stamp = await ssfStampFn();
        var call = { id: 'h1', type: 'function', function: { name: 'continue_in_new_chat', arguments: '{"title":"T","summary":"S"}' } };
        var chat = { messages: [
            { role: 'user', content: 'earlier question' },
            { role: 'user', content: 'Please summarize this conversation', isSummaryRequest: true },
            { role: 'assistant', content: '', tool_calls: [call] },
            { role: 'tool', tool_call_id: 'h1', content: '{"success":true}' },
            { role: 'user', content: '[worker report]', injected: true, midRun: true },
            { role: 'assistant', content: 'Handing off.' },
            { role: 'user', content: 'typed mid-run', injected: true, midRun: true, hasUserText: true }
        ] };
        assert.strictEqual(stamp(chat), true, 'the injected rows do not hide the isSummaryRequest row');
        assert.strictEqual(chat.messages[2].isSummary, true, 'call row stamped');
        assert.strictEqual(chat.messages[5].isSummary, true, 'final text reply stamped');
        assert.strictEqual(chat.messages[4].isSummary, undefined, 'injected rows untouched');
        assert.strictEqual(chat.messages[6].isSummary, undefined);
        // An injected row after a NORMAL turn still never stamps.
        var normal = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
            { role: 'user', content: '[wake]', injected: true }, { role: 'assistant', content: 'ok' }] };
        assert.strictEqual(stamp(normal), false);
    }, { tags: ['unit'] });

    test('_stampSummaryReply: an idle-path injected row (no midRun) after the summary request ends the turn (#1391)', async function() {
        var stamp = await ssfStampFn();
        var call = { id: 'h1', type: 'function', function: { name: 'continue_in_new_chat', arguments: '{"title":"T","summary":"S"}' } };
        // Failed/abandoned handoff, then a later wake run started by an idle-path notice row.
        var chat = { messages: [
            { role: 'user', content: 'Please summarize this conversation', isSummaryRequest: true },
            { role: 'assistant', content: 'abandoned' },
            { role: 'user', content: '[sub-agent report]', injected: true },
            { role: 'assistant', content: '', tool_calls: [call] },
            { role: 'tool', tool_call_id: 'h1', content: '{"success":false}' },
            { role: 'assistant', content: 'wake run reply' }
        ] };
        assert.strictEqual(stamp(chat), false, 'the wake run is not the summary turn');
        [1, 3, 5].forEach(function(i) { assert.strictEqual(chat.messages[i].isSummary, undefined, 'row ' + i + ' not stamped'); });
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
        // Handoff helpers the excerpt calls (seed builder + summary extraction).
        var helpers = ['HANDOFF_USER_MSG_VERBATIM_MAX', 'HANDOFF_USER_MSG_HEAD'].map(function(n) {
            var m = new RegExp('\\nvar ' + n + ' = \\d+;').exec(src);
            if (!m) throw new Error('Missing declaration: ' + n);
            return m[0];
        }).join('\n') + '\n' + ['extractHandoffSummary', 'stripContinuedPrefix', 'extractHandoffTitle', 'cleanHandoffTitle', '_findHandoffToolCall', 'getHandoffResult', '_getHandoffTextResult', '_isTypedUserMessage', 'buildHandoffUserMessages', 'buildContinuationSeed']
            .map(function(n) { return ssfDeclaration(src, n); }).join('\n');
        var code = ssfI18n(all) + '\n' + helpers + '\n' + ssfDeclaration(src, 'completeSummaryAndCreateNewChat', 'async ');
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
            runAgent: function() { runs++; return Promise.resolve(); },
            // Chat lineage (#1327): the continuation pushes both chat skeletons to the SW.
            _pushChatSkeletonToSW: noop
        };
        // Every production global used by this excerpt is supplied in env.
        var fn = new Function('env', 'with (env) {\n' + code + '\nreturn completeSummaryAndCreateNewChat;\n}')(env);
        // #1327 made it async (handover block + SW lineage migration are awaited).
        await fn();
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
