// Run: run_tests { pattern: 'anthropic-cache-breakpoints' } (js_eval sandbox; no Node).
// Anthropic prompt-cache breakpoints: hard budget of 4 markers per request
// (a 5th is a 400), 1h TTL on the stable prefix (tools + system) only, and
// the Claude OAuth transform carrying the tools marker through. Evaluates the
// REAL sources (core/030-config, app/010, background.js).
'use strict';

function _cb_cutFn(source, name) {
    var start = 'function ' + name + '(';
    var a = source.indexOf(start);
    if (a < 0) throw new Error('Source extraction failed: ' + name);
    var b = source.indexOf('\n}\n', a);
    if (b < 0) throw new Error('Source extraction failed (end): ' + name);
    return source.slice(a, b + 3);
}
function _cb_cutVar(source, name) {
    var re = new RegExp('^var ' + name + ' = [^\\n]*$', 'm');
    var mm = re.exec(source);
    if (!mm) throw new Error('Source extraction failed (var): ' + name);
    return mm[0] + '\n';
}
async function loadPolicy() {
    var cfg = await loadFile('src/js/core/030-config.js');
    var src = _cb_cutVar(cfg, 'ANTHROPIC_MAX_CACHE_BREAKPOINTS') + _cb_cutVar(cfg, 'ANTHROPIC_STABLE_PREFIX_CACHE_TTL') +
        _cb_cutFn(cfg, 'anthropicCacheControl');
    return new Function(src + '\nreturn { max: ANTHROPIC_MAX_CACHE_BREAKPOINTS, ttl: ANTHROPIC_STABLE_PREFIX_CACHE_TTL, cc: anthropicCacheControl };')();
}

function countMarkers(v) {
    var n = 0;
    (function walk(x) {
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (x && typeof x === 'object') {
            Object.keys(x).forEach(function(k) { if (k === 'cache_control') n++; else walk(x[k]); });
        }
    })(v);
    return n;
}
// Every marker in prefix order (tools -> system/messages), for TTL ordering.
function markersInOrder(body, systemKey) {
    var out = [];
    (function walk(x) {
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (x && typeof x === 'object') {
            if (x.cache_control) out.push(x.cache_control);
            Object.keys(x).forEach(function(k) { if (k !== 'cache_control') walk(x[k]); });
        }
    })([body.tools, systemKey ? body[systemKey] : null, body.messages]);
    return out;
}

var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
var T = { tags: ['unit'], timeout: 10000 };

// Tool loop: last message is role:'tool' (the case that produced 5 markers).
var TOOL_LOOP = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'result 1' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'a', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't2', content: 'result 2' }
];

describe('anthropic cache breakpoints: request builder (app/010)', function() {
    async function send(model, messages, tools) {
        var pol = await loadPolicy();
        var m = await loadModules(['src/js/app/010-llm-streaming.js'], { lenient: true, globals: {
            getProviderById: function() { return { model: model, endpoint: 'https://example.test/v1', apiKey: 'k' }; },
            lastRequestMetrics: {}, getSystemPromptWithContext: function() { return 'sys'; },
            getEnabledTools: function() { return JSON.parse(JSON.stringify(tools)); },
            getGlobalMaxTokens: function() { return 1000; }, getGlobalThinkingBudget: function() { return 0; },
            isAdaptiveOnlyClaude: function() { return false; }, isThinkingBindingModel: function() { return false; },
            setLLMConnectionStatus: function() {}, updateModelDisplayWithProvider: function() {},
            ANTHROPIC_MAX_CACHE_BREAKPOINTS: pol.max, anthropicCacheControl: pol.cc,
            Platform: { getReferer: function() { return 'r'; } }, console: quiet,
            fetch: function() {
                var done = false;
                return Promise.resolve({ ok: true, status: 200, body: { getReader: function() { return { read: function() {
                    if (done) return Promise.resolve({ done: true, value: undefined });
                    done = true; return Promise.resolve({ done: false, value: new TextEncoder().encode('data: [DONE]\n') });
                } }; } } });
            }
        }});
        var metrics = {}; function noop() {}
        await m.callOpenRouterStreaming('p', messages, noop, noop, noop, noop, null, null, 'c1', metrics);
        assert.ok(metrics.requestBody, 'request was built');
        return metrics.requestBody;
    }
    var TOOLS = [
        { type: 'function', function: { name: 'a', parameters: {} } },
        { type: 'function', function: { name: 'b', parameters: {} }, cache_control: { type: 'ephemeral' } }
    ];

    test('tool loop with tools: <= 4 markers; tools+system 1h, messages 5m, 1h before 5m', async function() {
        var body = await send('anthropic/claude-opus-5', TOOL_LOOP, TOOLS);
        assert.strictEqual(countMarkers(body), 4, 'exactly the 4-marker budget');
        assert.deepStrictEqual(body.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' });
        assert.strictEqual(body.tools[0].cache_control, undefined);
        assert.deepStrictEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' }, 'system 1h');
        var last = body.messages[body.messages.length - 1];
        assert.deepStrictEqual(last.content[last.content.length - 1].cache_control, { type: 'ephemeral' }, 'last (tool) message 5m');
        var u2 = body.messages[5]; // 'second question' (index +1 for system)
        assert.deepStrictEqual(u2.content[0].cache_control, { type: 'ephemeral' }, 'most recent user marked');
        var u1 = body.messages[1];
        assert.strictEqual(u1.content[0].cache_control, undefined, 'older user dropped (budget)');
        var seq = markersInOrder(body, null), seenShort = false;
        seq.forEach(function(cc) { if (cc.ttl === '1h') assert.strictEqual(seenShort, false, '1h after 5m'); else seenShort = true; });
    }, T);

    test('no tools: budget gives 3 message markers (last + 2 most recent users)', async function() {
        var body = await send('anthropic/claude-opus-5', TOOL_LOOP, []);
        assert.strictEqual(countMarkers(body), 4);
        assert.ok(body.messages[1].content[0].cache_control, 'older user now marked');
    }, T);

    test('stale stored markers on messages are stripped before budgeting', async function() {
        var msgs = TOOL_LOOP.map(function(m) { return Object.assign({}, m); });
        msgs[3] = { role: 'assistant', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] };
        var body = await send('anthropic/claude-opus-5', msgs, TOOLS);
        assert.strictEqual(countMarkers(body), 4);
    }, T);

    test('non-Anthropic provider: tools and messages untouched (legacy shape)', async function() {
        var body = await send('openai/gpt-5', TOOL_LOOP, TOOLS);
        assert.deepStrictEqual(body.tools, TOOLS, 'tools byte-identical');
        assert.strictEqual(typeof body.messages[0].content, 'string');
        assert.strictEqual(countMarkers(body.messages), 0);
    }, T);
});

describe('anthropic cache breakpoints: Claude OAuth transform (background.js)', function() {
    async function loadBg() {
        var pol = await loadPolicy();
        var bg = await loadFile('src/platform/extension/background.js');
        var src = _cb_cutFn(bg, 'transformToAnthropic') + _cb_cutFn(bg, 'capAnthropicCacheBreakpoints');
        var deps = {
            ANTHROPIC_MAX_CACHE_BREAKPOINTS: pol.max,
            transformMessageToAnthropic: function(m) { return { role: m.role, content: m.content }; },
            isThinkingBindingModel: function() { return false; }, isAdaptiveOnlyClaude: function() { return false; },
            ADAPTIVE_CAPABLE_CLAUDE_RE: /^$/, thinkingOffShapeFor: function() { return null; },
            stripReplayedThinkingBeforeLastUserTurn: function() {}, LEGACY_EFFORT_BUDGET_TOKENS: {},
            getDefaultMaxTokensForModel: function() { return 64000; }
        };
        var names = Object.keys(deps);
        return new Function(names.join(','), src + '\nreturn { transform: transformToAnthropic, cap: capAnthropicCacheBreakpoints };')
            .apply(null, names.map(function(k) { return deps[k]; }));
    }

    test('tool mapping preserves the tool-level cache_control', async function() {
        var bg = await loadBg();
        var out = bg.transform({ model: 'claude-opus-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], tools: [
            { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object' } } },
            { type: 'function', function: { name: 'b' }, cache_control: { type: 'ephemeral', ttl: '1h' } }
        ] });
        assert.strictEqual(out.tools[0].cache_control, undefined);
        assert.deepStrictEqual(out.tools[1], { name: 'b', description: '', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral', ttl: '1h' } });
    }, T);

    test('safety cap: 6 markers -> 4 (stable, last message, most recent); TTL order fixed', async function() {
        var bg = await loadBg();
        function blk(t, cc) { var b = { type: 'text', text: t }; if (cc) b.cache_control = cc; return b; }
        var five = { type: 'ephemeral' }, hour = { type: 'ephemeral', ttl: '1h' };
        var body = {
            tools: [{ name: 'a', cache_control: hour }],
            system: [blk('s', hour)],
            messages: [
                { role: 'user', content: [blk('u1', five)] },
                { role: 'assistant', content: [blk('a1', hour)] }, // stray 1h after 5m
                { role: 'user', content: [blk('u2', five)] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [blk('r', five)] }] }
            ]
        };
        bg.cap(body);
        assert.strictEqual(countMarkers(body), 4);
        assert.ok(body.tools[0].cache_control && body.system[0].cache_control, 'stable prefix kept');
        assert.ok(body.messages[3].content[0].content[0].cache_control, 'last message kept');
        assert.ok(body.messages[2].content[0].cache_control, 'most recent other kept');
        assert.strictEqual(body.messages[0].content[0].cache_control, undefined, 'oldest dropped');
        assert.strictEqual(body.messages[1].content[0].cache_control, undefined, 'older dropped');
        var b2 = { system: [blk('s', five)], messages: [{ role: 'user', content: [blk('u', hour)] }] };
        bg.cap(b2);
        assert.deepStrictEqual(b2.messages[0].content[0].cache_control, { type: 'ephemeral' }, '1h after 5m downgraded');
    }, T);

    test('full transform of a 5-marker OpenRouter-shaped body ends with <= 4', async function() {
        var bg = await loadBg();
        var cc = { type: 'ephemeral' };
        var out = bg.transform({ model: 'claude-opus-5',
            messages: [
                { role: 'system', content: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
                { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: cc }] },
                { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
                { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: cc }] },
                { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
                { role: 'user', content: [{ type: 'text', text: 'r', cache_control: cc }] }
            ],
            tools: [{ type: 'function', function: { name: 't' }, cache_control: { type: 'ephemeral', ttl: '1h' } }]
        });
        assert.strictEqual(countMarkers(out), 4);
        assert.ok(out.tools[0].cache_control, 'tools marker survives');
        assert.ok(out.system[out.system.length - 1].cache_control, 'system marker survives');
    }, T);
});
