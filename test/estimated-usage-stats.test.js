// Estimated usage for providers that return none (LM Studio): request
// stream_options.include_usage on local endpoints only, estimate
// est_input_tokens / est_output_tokens when usage is missing, show them with
// "~" in formatMetrics (ui/260) and the context gauge (ui/240).
// Run: run_tests { files: ['test/estimated-usage-stats.test.js'] }
var EX = await runFile('test/extract.js', { i18n: false });
function euCut(src, names) {
    var mask = EX.codeMask(src);
    return names.map(function(n) {
        var f = EX.findFunction(src, n, { mask: mask });
        if (!(f && f.end > f.start)) throw new Error('function not found: ' + n);
        return src.slice(f.start, f.end);
    }).join('\n');
}
function euReader(lines) {
    var enc = new TextEncoder(), i = 0;
    return { read: function() {
        if (i >= lines.length) return Promise.resolve({ done: true, value: undefined });
        return Promise.resolve({ done: false, value: enc.encode(lines[i++] + '\n') });
    } };
}
async function euStream(endpoint, lines) {
    var sent = null;
    var m = await loadModules(['src/js/app/010-llm-streaming.js'], { lenient: true, globals: {
        getProviderById: function() { return { model: 'qwen3-8b', endpoint: endpoint, apiKey: 'k' }; },
        lastRequestMetrics: {}, getSystemPromptWithContext: function() { return 'system prompt text'; },
        getEnabledTools: function() { return [{ type: 'function', function: { name: 'do_it', parameters: {} } }]; },
        getGlobalMaxTokens: function() { return 100; }, getGlobalThinkingBudget: function() { return 0; },
        isAdaptiveOnlyClaude: function() { return false; }, isThinkingBindingModel: function() { return false; },
        setLLMConnectionStatus: function() {}, updateModelDisplayWithProvider: function() {},
        Platform: { getReferer: function() { return 'r'; } }, console: { error: function() {}, warn: function() {}, log: function() {} },
        fetch: function(url, opts) { sent = JSON.parse(opts.body); return Promise.resolve({ ok: true, status: 200, body: { getReader: function() { return euReader(lines); } } }); }
    } });
    var metrics = {};
    var noop = function() {};
    await m.callOpenRouterStreaming('p', [{ role: 'user', content: 'hello there, how are you?' }], noop, noop, noop, noop, null, null, 'c1', metrics);
    return { body: sent, metrics: metrics, m: m };
}
var euContent = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Twelve chars' } }] });

describe('estimated usage stats', function() {
    test('local endpoint: include_usage requested; hosted endpoint: body unchanged', async function() {
        var local = await euStream('http://localhost:1234/v1/chat/completions', [euContent, 'data: [DONE]']);
        assert.deepStrictEqual(local.body.stream_options, { include_usage: true });
        var hosted = await euStream('https://openrouter.ai/api/v1/chat/completions', [euContent, 'data: [DONE]']);
        assert.strictEqual(hosted.body.stream_options, undefined);
        assert.strictEqual(local.m.isLocalLLMEndpoint('http://192.168.1.5:1234/v1'), true);
        assert.strictEqual(local.m.isLocalLLMEndpoint('https://api.openai.com/v1'), false);
    }, { tags: ['unit'] });

    test('no usage returned: estimates filled, firstTokenTime stamped, real fields untouched', async function() {
        var r = await euStream('http://localhost:1234/v1/chat/completions', [euContent, 'data: [DONE]']);
        assert.ok(r.metrics.est_input_tokens > 0, 'est_input_tokens');
        assert.strictEqual(r.metrics.est_output_tokens, 3); // 12 chars / 4
        assert.strictEqual(r.metrics.input_tokens, undefined);
        assert.ok(r.metrics.firstTokenTime > 0);
    }, { tags: ['unit'] });

    test('real usage returned: no estimates (real numbers win)', async function() {
        var usage = 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } });
        var r = await euStream('http://localhost:1234/v1/chat/completions', [euContent, usage, 'data: [DONE]']);
        assert.strictEqual(r.metrics.input_tokens, 500);
        assert.strictEqual(r.metrics.output_tokens, 20);
        assert.strictEqual(r.metrics.est_input_tokens, undefined);
        assert.strictEqual(r.metrics.est_output_tokens, undefined);
    }, { tags: ['unit'] });

    test('formatMetrics shows ~In/~Out and ~tok/s from the first token; real path unchanged', async function() {
        var i18n = await loadFile('src/js/core/025-i18n.js');
        var src = await loadFile('src/js/ui/260-content-format.js');
        var env = { UI_ICONS: { model: '', stats: '', cache: '', money: '', timer: '' }, escapeHtml: function(s) { return String(s); } };
        var fm = new Function('env', 'with (env) {\n' + i18n + '\n' + euCut(src, ['formatMetrics']) + '\nreturn formatMetrics;\n}')(env);
        var est = fm({ est_input_tokens: 12000, est_output_tokens: 100, startTime: 0, firstTokenTime: 1000, endTime: 3000, duration: 3000 });
        assert.match(est, /In: ~12,000/);
        assert.match(est, /Out: ~100/);
        assert.match(est, /~50\.0 tok\/s/); // 100 tokens / 2 s since first token
        var real = fm({ input_tokens: 12000, output_tokens: 100, est_output_tokens: 7, duration: 2000 });
        assert.ok(real.indexOf('~') === -1, 'real usage shows no estimate');
        assert.match(real, /50\.0 tok\/s/);
    }, { tags: ['unit'] });

    test('getChatContextTokens: real input_tokens first, else est_input_tokens', async function() {
        var src = await loadFile('src/js/app/030-agent-loop.js');
        var fn = new Function(euCut(src, ['getChatContextTokens']) + '\nreturn getChatContextTokens;')();
        assert.strictEqual(fn({ messages: [{ role: 'assistant', metrics: { input_tokens: 0, est_input_tokens: 9000 } }] }), 9000);
        assert.strictEqual(fn({ messages: [{ role: 'assistant', metrics: { input_tokens: 500, est_input_tokens: 9000 } }] }), 500);
        assert.strictEqual(fn({ messages: [{ role: 'assistant', metrics: { isAggregate: true, est_input_tokens: 9000 } }] }), 0);
    }, { tags: ['unit'] });

    test('resume rebuild of the aggregate re-adds est_* from earlier rows', async function() {
        var src = await loadFile('src/js/app/030-agent-loop.js');
        var init = /var aggregateMetrics = \{[\s\S]*?\};/.exec(src)[0];
        var a = src.indexOf('    if (lastUserMsgIndex >= 0) {\n        for (var mi = lastUserMsgIndex + 1;');
        assert.ok(a > 0, 'resume rebuild block found');
        var loop = src.slice(a, src.indexOf('\n    }\n', a) + 6);
        var run = new Function('chat', 'lastUserMsgIndex', 'var callNumber = 0;\n' + init + '\n' + loop + '\nreturn aggregateMetrics;');
        var agg = run({ messages: [{ role: 'user' }, { role: 'assistant', metrics: { est_input_tokens: 100, est_output_tokens: 10 } }, { role: 'assistant', metrics: { est_input_tokens: 200, est_output_tokens: 20 } }] }, 0);
        assert.strictEqual(agg.callCount, 2);
        assert.strictEqual(agg.est_input_tokens, 300);
        assert.strictEqual(agg.est_output_tokens, 30);
    }, { tags: ['unit'] });

    test('context gauge renders from est_input_tokens with a ~ tooltip', async function() {
        var i18n = await loadFile('src/js/core/025-i18n.js');
        var src = await loadFile('src/js/ui/240-layout.js');
        var th = /\nvar CONTEXT_CONTINUE_THRESHOLD = \d+;/.exec(src)[0];
        function el() { var cls = {}; return { style: {}, attrs: {}, title: '', setAttribute: function(k, v) { this.attrs[k] = String(v); },
            set className(v) { cls = {}; }, get className() { return Object.keys(cls).join(' '); },
            classList: { add: function(c) { cls[c] = 1; }, contains: function(c) { return !!cls[c]; } } }; }
        var els = { 'context-indicator': el(), 'context-fill': el(), 'context-label': el(), 'context-pct': el(), 'context-label-short': el(), 'message-input': { value: '' } };
        var env = { document: { getElementById: function(id) { return els[id] || null; } },
            chats: { c1: { messages: [{ role: 'assistant', content: 'x', metrics: { input_tokens: 0, est_input_tokens: 40000 } }] } },
            currentChatId: 'c1', getAssumedContextTokens: function() { return 200000; }, composerDraftTokens: function() { return 0; } };
        var fn = new Function('env', 'with (env) {\n' + i18n + '\n' + th + '\n' + euCut(src, ['updateContextIndicator']) + '\nreturn updateContextIndicator;\n}')(env);
        fn();
        assert.strictEqual(els['context-indicator'].style.display, 'flex');
        assert.strictEqual(els['context-indicator'].attrs['data-percentage'], '20');
        assert.match(els['context-indicator'].title, /\(~40k tokens\)/);
    }, { tags: ['unit'] });
});
