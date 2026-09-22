// Run: run_tests { pattern: 'anthropic-block-order' } (js_eval sandbox; no Node).
// Opus 5.5 hardening fix 1: assistant content-block order survives replay.
// Thinking blocks are bound to everything before them (Fable 5.1+ / Opus 5.5,
// prefix_mismatch_behavior:'drop_block'), so a turn streamed as
// [thinking, text, thinking, tool_use] must replay in that order.
// SW SSE handler (background.js) → delta.anthropic_block markers → page chunk
// loop (app/010) records block_order → buildAPIMessages (app/020) → replay in
// transformMessageToAnthropic (background.js). Evaluates the REAL sources.
'use strict';

function _bo_cut(source, start, end) {
    var a = source.indexOf(start);
    if (a < 0) throw new Error('Source extraction failed (start): ' + start);
    var b = source.indexOf(end, a + start.length);
    if (b < 0) throw new Error('Source extraction failed (end): ' + end);
    return source.slice(a, b);
}
function _bo_cutFn(source, name) {
    var start = 'function ' + name + '(';
    var a = source.indexOf(start);
    if (a < 0) throw new Error('Source extraction failed: ' + name);
    var b = source.indexOf('\n}\n', a);
    if (b < 0) throw new Error('Source extraction failed (end): ' + name);
    return source.slice(a, b + 3);
}

async function loadReplay() {
    var bg = await loadFile('src/platform/extension/background.js');
    var src = _bo_cutFn(bg, 'convertContentPart') +
        _bo_cut(bg, 'function anthropicThinkingBlockFromRd(', '// --- ServiceNow session heartbeat ---');
    return new Function(src + '\nreturn { transform: transformMessageToAnthropic, ordered: buildOrderedAnthropicAssistantBlocks };')();
}

// Real SW translation: Anthropic SSE events → the OpenAI-chunk envelopes the
// page consumes.
async function runSwStream(events) {
    var bg = await loadFile('src/platform/extension/background.js');
    var fn = _bo_cut(bg, 'async function runClaudeOAuthStream(', 'chrome.runtime.onConnect.addListener(function(port) {');
    var wire = events.map(function(ev) { return 'event: ' + ev.type + '\ndata: ' + JSON.stringify(ev) + '\n\n'; }).join('');
    var sent = false;
    var res = {
        status: 200, ok: true,
        headers: { get: function() { return null; }, forEach: function() {} },
        body: { getReader: function() { return {
            read: function() {
                if (sent) return Promise.resolve({ done: true, value: undefined });
                sent = true; return Promise.resolve({ done: false, value: new TextEncoder().encode(wire) });
            },
            cancel: function() {}
        }; } }
    };
    var deps = {
        chrome: {
            storage: { local: { get: async function() { return { claudeOAuth: { accessToken: 't', expiresAt: Date.now() + 3600000 } }; }, set: function() {} } },
            runtime: { getPlatformInfo: function() {} }
        },
        fetch: async function() { return res; },
        renewClaudeToken: async function(o) { return o; },
        transformToAnthropic: function(b) { return { model: b.model }; },
        getAnthropicBetas: function() { return ''; },
        parseRequiredClaudeCliVersion: function() { return null; },
        bumpClaudeCliVersion: async function() { return false; },
        _claudeStreams: { active: 0, waiters: [] }, _claudeStreamEnded: function() {},
        _waitForFreeStreamSlot: async function() {}, _claudeAbortableDelay: async function() {},
        detectUsageExhaustion: function() { return null; }, refreshClaudeOrgUsage: async function() { return {}; },
        formatResetDelta: function() { return ''; }, conciseApiErrorBody: function(t) { return String(t); },
        setInterval: function() { return 1; }, clearInterval: function() {},
        console: { warn: function() {}, error: function() {}, log: function() {} }
    };
    var names = Object.keys(deps);
    var run = new Function(names.join(','), fn + '\nreturn runClaudeOAuthStream;').apply(null, names.map(function(k) { return deps[k]; }));
    var out = [];
    await run({ model: 'claude-opus-5-5' }, function(e) { out.push(e); }, null);
    var errs = out.filter(function(e) { return e.type === 'error'; });
    assert.strictEqual(errs.length, 0, 'SW stream errored: ' + JSON.stringify(errs));
    return out.filter(function(e) { return e.type === 'sse'; }).map(function(e) { return e.data; });
}

// Real page chunk loop fed with SW envelopes (raw strings, one per read).
async function runPageStream(sseChunks, provider, messages) {
    var captured = null, i = 0;
    var m = await loadModules(['src/js/app/010-llm-streaming.js'], { lenient: true, globals: {
        getProviderById: function() { return provider; },
        lastRequestMetrics: {}, getSystemPromptWithContext: function() { return 'sys'; }, getEnabledTools: function() { return []; },
        getGlobalMaxTokens: function() { return 100; }, getGlobalThinkingBudget: function() { return 0; },
        isAdaptiveOnlyClaude: function() { return true; }, isThinkingBindingModel: function() { return true; },
        setLLMConnectionStatus: function() {}, updateModelDisplayWithProvider: function() {},
        Platform: { getReferer: function() { return 'r'; } }, console: { error: function() {}, warn: function() {}, log: function() {} },
        fetch: function(url, opts) {
            captured = JSON.parse(opts.body);
            var enc = new TextEncoder();
            return Promise.resolve({ ok: true, status: 200, body: { getReader: function() { return { read: function() {
                if (i >= sseChunks.length) return Promise.resolve({ done: true, value: undefined });
                return Promise.resolve({ done: false, value: enc.encode(sseChunks[i++]) });
            } }; } } });
        }
    } });
    var final = null;
    function noop() {}
    await m.callOpenRouterStreaming('p', messages || [{ role: 'user', content: 'q' }], noop, noop, noop, function(f) { final = f; }, null, null, 'c1', {});
    assert.ok(final, 'onDone called');
    return { final: final, sent: captured };
}

var OAUTH = { model: 'claude-opus-5-5', endpoint: 'https://example.test/v1', apiKey: 'k', isClaudeOAuth: true };

function interleavedEvents() {
    return [
        { type: 'message_start', message: { id: 'msg_1', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan A' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig0' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me ' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'check.' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'plan B' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'sig2' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' } },
        { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } },
        { type: 'content_block_stop', index: 3 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' }
    ];
}

function asMsg(final) {
    var msg = { role: 'assistant', content: final.content, tool_calls: final.tool_calls, reasoning_details: final.reasoning_details };
    if (final.block_order) msg.block_order = final.block_order;
    return msg;
}
function types(blocks) { return blocks.map(function(b) { return b.type; }); }

describe('fix 1: assistant content-block order preserved on replay', function() {
    test('SW → page → replay: [thinking, text, thinking, tool_use] keeps its order', async function() {
        var chunks = await runSwStream(interleavedEvents());
        var r = await runPageStream(chunks, OAUTH);
        assert.deepStrictEqual(r.final.block_order, [
            { t: 'r', i: 0 }, { t: 'x', s: 0, e: 13 }, { t: 'r', i: 2 }, { t: 'u', id: 'toolu_1' }
        ]);
        assert.strictEqual(r.final.content, 'Let me check.');
        var rep = await loadReplay();
        var out = rep.transform(asMsg(r.final));
        assert.deepStrictEqual(types(out.content), ['thinking', 'text', 'thinking', 'tool_use']);
        assert.deepStrictEqual(out.content[0], { type: 'thinking', thinking: 'plan A', signature: 'sig0' });
        assert.deepStrictEqual(out.content[1], { type: 'text', text: 'Let me check.' });
        assert.deepStrictEqual(out.content[2], { type: 'thinking', thinking: 'plan B', signature: 'sig2' });
        assert.deepStrictEqual(out.content[3], { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 1 } });
    }, { tags: ['unit'], timeout: 10000 });

    test('multiple text blocks stay separate; cache_control lands on the LAST text piece', async function() {
        var rep = await loadReplay();
        var msg = {
            role: 'assistant',
            // pre-normalized by callOpenRouterStreaming's cache pass
            content: [{ type: 'text', text: 'First.Second.', cache_control: { type: 'ephemeral' } }],
            reasoning_details: [{ index: 1, thinking: 'mid', signature: 's1' }],
            tool_calls: [{ id: 'toolu_9', type: 'function', function: { name: 'x', arguments: '{}' } }],
            block_order: [{ t: 'x', s: 0, e: 6 }, { t: 'r', i: 1 }, { t: 'x', s: 6, e: 13 }, { t: 'u', id: 'toolu_9' }]
        };
        var out = rep.transform(msg).content;
        assert.deepStrictEqual(types(out), ['text', 'thinking', 'text', 'tool_use']);
        assert.deepStrictEqual(out[0], { type: 'text', text: 'First.' });
        assert.deepStrictEqual(out[2], { type: 'text', text: 'Second.', cache_control: { type: 'ephemeral' } });
        assert.ok(!out[3].cache_control, 'cache_control not moved onto tool_use');
    }, { tags: ['unit'], timeout: 5000 });

    test('legacy message without block_order: exact current layout', async function() {
        var rep = await loadReplay();
        var msg = {
            role: 'assistant', content: 'Hello',
            reasoning_details: [{ index: 0, thinking: 'a', signature: 's0' }, { index: 2, thinking: 'b', signature: 's2' }, { index: 3, thinking: 'unsigned' }],
            tool_calls: [{ id: 't1', function: { name: 'n', arguments: '{"a":2}' } }]
        };
        var out = rep.transform(msg).content;
        assert.deepStrictEqual(out, [
            { type: 'thinking', thinking: 'a', signature: 's0' },
            { type: 'thinking', thinking: 'b', signature: 's2' },
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 't1', name: 'n', input: { a: 2 } }
        ]);
        assert.strictEqual(rep.ordered(msg), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('mismatches fall back to the legacy layout', async function() {
        var rep = await loadReplay();
        var base = function() { return {
            role: 'assistant', content: 'Let me check.',
            reasoning_details: [{ index: 0, thinking: 'A', signature: 's0' }, { index: 2, thinking: 'B', signature: 's2' }],
            tool_calls: [{ id: 'toolu_1', function: { name: 'lookup', arguments: '{}' } }],
            block_order: [{ t: 'r', i: 0 }, { t: 'x', s: 0, e: 13 }, { t: 'r', i: 2 }, { t: 'u', id: 'toolu_1' }]
        }; };
        var legacy = ['thinking', 'thinking', 'text', 'tool_use'];
        assert.deepStrictEqual(types(rep.transform(base()).content), ['thinking', 'text', 'thinking', 'tool_use'], 'control');
        var cases = {
            'content edited (length)': function(m) { m.content = 'Let me check. [edited]'; },
            'tool call id changed': function(m) { m.tool_calls[0].id = 'toolu_X'; },
            'extra tool call': function(m) { m.tool_calls.push({ id: 'toolu_2', function: { name: 'z', arguments: '{}' } }); },
            'reasoning entry missing': function(m) { m.reasoning_details.pop(); },
            'extra reasoning entry': function(m) { m.reasoning_details.push({ index: 5, thinking: 'C', signature: 's5' }); },
            'duplicate thinking ref (no index from model)': function(m) { m.block_order[2] = { t: 'r', i: 0 }; },
            'unknown block type': function(m) { m.block_order.push({ t: '?', type: 'server_tool_use' }); },
            'content array not a single text part': function(m) { m.content = [{ type: 'text', text: 'Let me ' }, { type: 'text', text: 'check.' }]; }
        };
        Object.keys(cases).forEach(function(name) {
            var m = base();
            cases[name](m);
            assert.strictEqual(rep.ordered(m), null, name + ': ordered replay must refuse');
            var got = types(rep.transform(m).content);
            var expectLegacy = legacy.slice();
            if (name === 'reasoning entry missing') expectLegacy = ['thinking', 'text', 'tool_use'];
            if (name === 'extra reasoning entry') expectLegacy = ['thinking', 'thinking', 'thinking', 'text', 'tool_use'];
            if (name === 'extra tool call') expectLegacy = legacy.concat(['tool_use']);
            if (name === 'content array not a single text part') expectLegacy = ['thinking', 'thinking', 'text', 'text', 'tool_use'];
            assert.deepStrictEqual(got, expectLegacy, name + ': legacy layout');
        });
    }, { tags: ['unit'], timeout: 5000 });

    test('tool-only / no-text turn, redacted + unsigned thinking handled as before', async function() {
        var rep = await loadReplay();
        var out = rep.transform({
            role: 'assistant',
            reasoning_details: [{ index: 0, type: 'redacted_thinking', data: 'opaque' }, { index: 1, thinking: 'partial, no sig' }],
            tool_calls: [{ id: 'toolu_1', function: { name: 'n', arguments: '{}' } }],
            block_order: [{ t: 'r', i: 0 }, { t: 'r', i: 1 }, { t: 'u', id: 'toolu_1' }]
        }).content;
        assert.deepStrictEqual(out, [
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'tool_use', id: 'toolu_1', name: 'n', input: {} }
        ]);
    }, { tags: ['unit'], timeout: 5000 });

    test('SW refusal note gets its own trailing text entry (no tiling break)', async function() {
        var ev = interleavedEvents().slice(0, 13); // thinking, text, thinking — no tool
        ev.push({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: {} });
        ev.push({ type: 'message_stop' });
        var r = await runPageStream(await runSwStream(ev), OAUTH);
        var bo = r.final.block_order;
        assert.strictEqual(bo.length, 4, JSON.stringify(bo));
        assert.deepStrictEqual(bo.slice(0, 3), [{ t: 'r', i: 0 }, { t: 'x', s: 0, e: 13 }, { t: 'r', i: 2 }]);
        assert.deepStrictEqual(bo[3], { t: 'x', s: 13, e: r.final.content.length });
        assert.ok(/Request declined/.test(r.final.content));
        var rep = await loadReplay();
        assert.deepStrictEqual(types(rep.transform(asMsg(r.final)).content), ['thinking', 'text', 'thinking', 'text']);
    }, { tags: ['unit'], timeout: 10000 });

    test('non-Anthropic streams (no markers) produce no block_order', async function() {
        var line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\ndata: [DONE]\n\n';
        var r = await runPageStream([line], { model: 'openai/gpt-x', endpoint: 'https://example.test/v1', apiKey: 'k' });
        assert.strictEqual(r.final.content, 'hi');
        assert.strictEqual(r.final.block_order, null);
    }, { tags: ['unit'], timeout: 10000 });

    test('block_order is stripped from requests to non-Claude-OAuth providers, kept for Claude OAuth', async function() {
        var hist = [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a', block_order: [{ t: 'x', s: 0, e: 1 }] },
            { role: 'user', content: 'q2' }
        ];
        var done = 'data: [DONE]\n\n';
        var or = await runPageStream([done], { model: 'anthropic/claude-opus-5-5', endpoint: 'https://example.test/v1', apiKey: 'k' }, hist);
        or.sent.messages.forEach(function(m, i) { assert.ok(!('block_order' in m), 'OpenRouter message #' + i + ' leaked block_order'); });
        var gpt = await runPageStream([done], { model: 'openai/gpt-x', endpoint: 'https://example.test/v1', apiKey: 'k' }, hist);
        gpt.sent.messages.forEach(function(m, i) { assert.ok(!('block_order' in m), 'non-Claude message #' + i + ' leaked block_order'); });
        var oa = await runPageStream([done], OAUTH, hist);
        var asst = oa.sent.messages.filter(function(m) { return m.role === 'assistant'; })[0];
        assert.deepStrictEqual(asst.block_order, [{ t: 'x', s: 0, e: 1 }]);
        assert.ok(Array.isArray(asst.content) && asst.content[0].text === 'a', 'still normalized for cache pass');
        assert.ok('block_order' in hist[1], 'caller history not mutated');
    }, { tags: ['unit'], timeout: 10000 });

    test('buildAPIMessages passes block_order through only with content/tool_calls', async function() {
        var src = await loadFile('src/js/app/020-api-messages.js');
        var fn = _bo_cutFn(src, 'buildAPIMessages');
        assert.ok(/msg\.block_order = m\.block_order/.test(fn), 'buildAPIMessages must forward block_order');
        var agent = await loadFile('src/js/app/030-agent-loop.js');
        assert.ok(/assistantMsg\.block_order = final\.block_order/.test(agent), 'onDone must persist block_order');
    }, { tags: ['unit'], timeout: 5000 });
});
