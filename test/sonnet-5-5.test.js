// Run: run_tests { pattern: 'sonnet-5-5' }. Sonnet 5.5 replaces Sonnet 5 (Sept 2026).
// Real source slices from 030-config.js / 130-indexeddb.js / background.js /
// 010-llm-streaming.js; synthetic fixtures only, no network.
'use strict';
function _cut(src, start, end) {
    var a = src.indexOf(start), b = src.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
    return src.slice(a, b);
}
async function _cfgSrc() { return loadFile('src/js/core/030-config.js'); }
async function _config() {
    var cfg = await _cfgSrc();
    return new Function(_cut(cfg, 'var DEFAULT_API_PROVIDERS = [', '// ─── Per-spawn model selection') +
        _cut(cfg, 'var SUBAGENT_TIER_NAMES', 'var subAgentTierAliases = null;') +
        '\nreturn { defaults: DEFAULT_API_PROVIDERS, renames: PROVIDER_RENAMES, tiers: DEFAULT_TIER_ALIASES };')();
}
async function _regexes() {
    var cfg = await _cfgSrc();
    return new Function(_cut(cfg, 'var DEFAULT_MAX_TOKENS = 64000;', 'var MAX_TOKENS_SETTING_KEY') +
        _cut(cfg, 'function getDefaultMaxTokensForModel', '// THE accessors') +
        _cut(cfg, 'var ADAPTIVE_ONLY_CLAUDE_RE', 'var currentProvider = ') +
        '\nreturn { isS55: isSonnet55Plus, isBinding: isThinkingBindingModel, isAdaptiveOnly: isAdaptiveOnlyClaude, off: thinkingOffShapeFor, maxTok: getDefaultMaxTokensForModel };')();
}
async function _transform() {
    var bg = await loadFile('src/platform/extension/background.js');
    var cfg = await _cfgSrc();
    var deps = 'var DEFAULT_THINKING_BUDGET = 32000; function transformMessageToAnthropic(m) { return { role: m.role, content: m.content }; }';
    return new Function(_cut(cfg, 'var ADAPTIVE_ONLY_CLAUDE_RE', 'var currentProvider = ') + deps +
        _cut(bg, 'var ANTHROPIC_BASE_BETAS', 'function transformMessageToAnthropic(') +
        '\nreturn { transform: transformToAnthropic, betas: getAnthropicBetas };')();
}
// The REAL callOpenRouterStreaming request-body builder (lines between the
// requestBody literal and the provider-routing block), with stubs.
async function _buildBody(provider, globalBudget) {
    var llm = await loadFile('src/js/app/010-llm-streaming.js');
    var cfg = await _cfgSrc();
    var body = _cut(llm, '    var requestBody = {', '\tif (provider.provider) {');
    var fn = new Function('provider', 'modelLower', 'isAnthropic', 'systemMessage', 'messagesWithCache', 'chatId', 'requestTools',
        'getEnabledTools', 'getGlobalMaxTokens', 'getGlobalThinkingBudget',
        _cut(cfg, 'var ADAPTIVE_ONLY_CLAUDE_RE', 'var currentProvider = ') + body + '\nreturn requestBody;');
    return fn(provider, provider.model.toLowerCase(), true, { role: 'system', content: 's' }, [], null, [],
        function() { return []; }, function() { return 64000; }, function() { return globalBudget; });
}
var EP = 'https://api.anthropic.com/v1/messages', OR = 'https://openrouter.ai/api/v1/chat/completions';
// Real loadApiProviders migration block (130-indexeddb.js) with stubs.
async function _migrator() {
    var c = await _config();
    var idb = await loadFile('src/js/core/130-indexeddb.js');
    var block = _cut(idb, 'var migratedDefaults = false;', '                    if (migratedDefaults) await saveAllApiProviders();');
    return function run(list, sel) {
        var st = { v: sel };
        var aps = { getItem: function() { return st.v; }, setItem: function(k, v) { st.v = v; } };
        var out = new Function('apiProviders', 'currentProvider', 'appStorage', 'DEFAULT_API_PROVIDERS',
            block + '\nreturn { providers: apiProviders, current: currentProvider, changed: migratedDefaults };')(list, sel, aps, c.defaults);
        out.stored = st.v; return out;
    };
}
var MSGS = [{ role: 'user', content: 'hi' }];
var TOOLS = [{ type: 'function', function: { name: 't', description: '', parameters: { type: 'object', properties: {} } } }];

describe('Sonnet 5.5: seeds, renames, migration, tiers', function() {
    test('Sonnet 5 seeds replaced by Sonnet 5.5 (OpenRouter + OAuth); small tier = Sonnet 5.5', async function() {
        var c = await _config();
        var by = {}; c.defaults.forEach(function(d) { by[d.name] = d; });
        assert.strictEqual(by['sonnet-5'], undefined);
        assert.strictEqual(by['Sonnet 5'], undefined);
        assert.deepStrictEqual(by['sonnet-5.5'], { name: 'sonnet-5.5', model: 'anthropic/claude-sonnet-5.5', endpoint: OR, apiKey: '', effort: 'high' });
        assert.deepStrictEqual(by['Sonnet 5.5'], { name: 'Sonnet 5.5', model: 'claude-sonnet-5-5', endpoint: EP, apiKey: 'oauth', effort: 'high', isClaudeOAuth: true });
        assert.strictEqual(c.tiers.small, 'Sonnet 5.5');
        ['sonnet-5', 'sonnet-4.5', 'sonnet-4.6'].forEach(function(k) { assert.strictEqual(c.renames[k], 'sonnet-5.5', k); });
        ['Sonnet 5', 'Sonnet 5 OAuth', 'Sonnet 4.6 OAuth'].forEach(function(k) { assert.strictEqual(c.renames[k], 'Sonnet 5.5', k); });
    }, { tags: ['unit'] });

    test('loadApiProviders migration (real block): untouched Sonnet 5 seeds → 5.5, customized kept, idempotent', async function() {
        var c = await _config();
        var idb = await loadFile('src/js/core/130-indexeddb.js');
        var block = _cut(idb, 'var migratedDefaults = false;', '                    if (migratedDefaults) await saveAllApiProviders();');
        function run(list, sel) {
            var st = { v: sel };
            var aps = { getItem: function() { return st.v; }, setItem: function(k, v) { st.v = v; } };
            var out = new Function('apiProviders', 'currentProvider', 'appStorage', 'DEFAULT_API_PROVIDERS',
                block + '\nreturn { providers: apiProviders, current: currentProvider, changed: migratedDefaults };')(list, sel, aps, c.defaults);
            out.stored = st.v; return out;
        }
        var oauth = { name: 'Sonnet 5', model: 'claude-sonnet-5', endpoint: EP, apiKey: 'oauth', effort: 'high', isClaudeOAuth: true };
        var orr = { name: 'sonnet-5', model: 'anthropic/claude-sonnet-5', endpoint: OR, apiKey: 'sk-x', effort: 'high' };
        var r = run([Object.assign({}, oauth), Object.assign({}, orr)], 'Sonnet 5');
        var names = r.providers.map(function(p) { return p.name; }).sort();
        assert.deepStrictEqual(names, ['Sonnet 5.5', 'sonnet-5.5']);
        assert.strictEqual(r.providers.find(function(p) { return p.name === 'sonnet-5.5'; }).apiKey, 'sk-x', 'apiKey carried over');
        assert.strictEqual(r.providers.find(function(p) { return p.name === 'Sonnet 5.5'; }).model, 'claude-sonnet-5-5');
        assert.strictEqual(r.stored, 'Sonnet 5.5');
        var again = run(r.providers.map(function(p) { return Object.assign({}, p); }), r.stored);
        assert.strictEqual(again.changed, false);
        var tuned = run([Object.assign({}, oauth, { effort: 'low' })], 'Sonnet 5');
        assert.strictEqual(tuned.changed, false);
        assert.strictEqual(tuned.providers[0].model, 'claude-sonnet-5', 'customized manual Sonnet 5 kept');
    }, { tags: ['unit'] });

    test('every historical Sonnet 5 seed shape migrates (S1–S5 incl. the 3 endpointId stored forms, O1–O3); tuned variants kept', async function() {
        var run = await _migrator();
        var base = { name: 'sonnet-5', model: 'anthropic/claude-sonnet-5', effort: 'high' };
        var inl = { url: OR, endpoint: OR };
        var orShapes = {
            S1: Object.assign({ apiKey: '', endpoint: OR, context_length: 1000000, maxTokens: 64000 }, base),
            S5: Object.assign({ endpoint: OR, apiKey: '' }, base)
        };
        [['S2', { context_length: 1000000, maxTokens: 64000 }], ['S3', { maxTokens: 64000 }], ['S4', {}]].forEach(function(s) {
            var seed = Object.assign({ endpointId: 'openrouter' }, s[1], base);
            orShapes[s[0] + 'a'] = seed;
            orShapes[s[0] + 'b'] = Object.assign({}, seed, inl, { apiKey: 'sk-user' });
            var c = Object.assign({}, seed, inl, { apiKey: '' }); delete c.endpointId;
            orShapes[s[0] + 'c'] = c;
        });
        Object.keys(orShapes).forEach(function(k) {
            var r = run([Object.assign({}, orShapes[k])], 'sonnet-5');
            assert.strictEqual(r.changed, true, k);
            assert.strictEqual(r.providers.length, 1, k);
            assert.strictEqual(r.providers[0].name, 'sonnet-5.5', k);
            assert.strictEqual(r.providers[0].model, 'anthropic/claude-sonnet-5.5', k);
            assert.strictEqual(r.providers[0].endpointId, undefined, k + ' no stale endpointId');
            assert.strictEqual(r.stored, 'sonnet-5.5', k);
        });
        assert.strictEqual(run([Object.assign({}, orShapes.S2b)], null).providers[0].apiKey, 'sk-user', 'user key carried over');
        var tuned = run([Object.assign({}, orShapes.S3a, { maxTokens: 32000 })], 'sonnet-5');
        assert.strictEqual(tuned.changed, false, 'tuned endpointId seed kept');
        var extra = run([Object.assign({}, orShapes.S4c, { provider: 'anthropic' })], 'sonnet-5');
        assert.strictEqual(extra.changed, false, 'extra key → customized');
        var o = { name: 'Sonnet 5', model: 'claude-sonnet-5', endpoint: EP, apiKey: 'oauth', effort: 'high', isClaudeOAuth: true };
        [['O1', { maxTokens: 100000, context_length: 1000000 }], ['O2', { maxTokens: 100000 }], ['O3', {}]].forEach(function(s) {
            var r = run([Object.assign({}, o, s[1])], 'Sonnet 5');
            assert.strictEqual(r.changed, true, s[0]);
            assert.deepStrictEqual(r.providers.map(function(p) { return p.name; }), ['Sonnet 5.5'], s[0]);
            assert.strictEqual(r.providers[0].model, 'claude-sonnet-5-5', s[0]);
            assert.strictEqual(r.stored, 'Sonnet 5.5', s[0]);
        });
        assert.strictEqual(run([Object.assign({}, o, { maxTokens: 50000 })], 'Sonnet 5').changed, false, 'tuned O2 kept');
    }, { tags: ['unit'] });

    test('older chains land on 5.5: sonnet-4.5 / sonnet-4.6 → sonnet-5.5, Sonnet 4.6 OAuth → Sonnet 5.5', async function() {
        var run = await _migrator();
        var r45 = run([{ name: 'sonnet-4.5', apiKey: 'k', model: 'anthropic/claude-sonnet-4.5', endpoint: OR, context_length: 200000, maxTokens: 64000, thinkingBudget: 40000 }], 'sonnet-4.5');
        assert.strictEqual(r45.providers[0].name, 'sonnet-5.5'); assert.strictEqual(r45.providers[0].model, 'anthropic/claude-sonnet-5.5');
        assert.strictEqual(r45.providers[0].apiKey, 'k'); assert.strictEqual(r45.stored, 'sonnet-5.5');
        var r46 = run([{ name: 'sonnet-4.6', apiKey: '', model: 'anthropic/claude-sonnet-4.6', endpoint: OR, context_length: 200000, maxTokens: 64000, effort: 'high' }], 'sonnet-4.6');
        assert.strictEqual(r46.providers[0].name, 'sonnet-5.5'); assert.strictEqual(r46.stored, 'sonnet-5.5');
        var o46 = run([{ name: 'Sonnet 4.6 OAuth', model: 'claude-sonnet-4-6', endpoint: EP, apiKey: 'oauth', maxTokens: 100000, context_length: 200000, effort: 'high', isClaudeOAuth: true }], 'Sonnet 4.6 OAuth');
        assert.strictEqual(o46.providers[0].name, 'Sonnet 5.5'); assert.strictEqual(o46.providers[0].model, 'claude-sonnet-5-5');
        assert.strictEqual(o46.stored, 'Sonnet 5.5');
    }, { tags: ['unit'] });
});

describe('Sonnet 5.5: model regexes + defaults', function() {
    test('SONNET_5_5_PLUS_RE / binding / adaptive-only / max tokens', async function() {
        var m = await _regexes();
        ['claude-sonnet-5-5', 'claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5', 'claude-sonnet-5-5-20261001', 'claude-sonnet-6'].forEach(function(id) {
            assert.strictEqual(m.isS55(id), true, id); assert.strictEqual(m.isBinding(id), true, id); assert.strictEqual(m.isAdaptiveOnly(id), true, id);
            assert.strictEqual(m.maxTok(id), 128000, id);
        });
        ['claude-sonnet-5-10', 'anthropic/claude-sonnet-5.10', 'claude-sonnet-5-5-20261001'].forEach(function(id) {
            assert.strictEqual(m.isS55(id), true, id); assert.strictEqual(m.isBinding(id), true, id);
        });
        ['claude-sonnet-5', 'claude-sonnet-5-20260630', 'anthropic/claude-sonnet-5', 'claude-sonnet-5-4', 'claude-sonnet-4-6', 'claude-opus-5-5',
         'claude-sonnet-5.1', 'claude-sonnet-5.2', 'claude-sonnet-5.3', 'claude-sonnet-5.4', 'anthropic/claude-sonnet-5.4', 'claude-sonnet-5-1'].forEach(function(id) {
            assert.strictEqual(m.isS55(id), false, id);
        });
        assert.strictEqual(m.isBinding('claude-sonnet-5'), false);
        assert.strictEqual(m.maxTok('claude-sonnet-5'), 64000, 'Sonnet 5 default unchanged');
        assert.strictEqual(m.off('claude-opus-5-5', null), null, 'helper is Sonnet-5.5-only');
        // Defensive guard (unreachable from the app's own builder): off + xhigh/max → adaptive
        assert.deepStrictEqual(m.off('claude-sonnet-5-5', 'xhigh'), { type: 'adaptive' });
        assert.deepStrictEqual(m.off('claude-sonnet-5-5', 'max'), { type: 'adaptive' });
        ['low', 'medium', 'high', null].forEach(function(e) { assert.deepStrictEqual(m.off('claude-sonnet-5-5', e), { type: 'between_tools' }, String(e)); });
    }, { tags: ['unit'] });
});

describe('Sonnet 5.5: request shaping', function() {
    test('OAuth transform: thinking OFF → between_tools; provider effort (incl. xhigh/max) → bound adaptive; never disabled/budget', async function() {
        var m = await _transform();
        var base = { model: 'claude-sonnet-5-5', max_tokens: 64000, messages: MSGS, tools: TOOLS };
        var off = m.transform(Object.assign({}, base, { reasoning: { enabled: false } }));
        assert.deepStrictEqual(off.thinking, { type: 'between_tools' });
        assert.strictEqual(off.output_config, undefined);
        // End-to-end with the bodies the REAL builder produces
        var built = await _buildBody({ model: 'claude-sonnet-5-5', isClaudeOAuth: true }, 0);
        assert.deepStrictEqual(built.reasoning, { enabled: false });
        assert.deepStrictEqual(m.transform(Object.assign({}, built, { messages: MSGS, tools: TOOLS })).thinking, { type: 'between_tools' });
        for (var e of ['low', 'high', 'xhigh', 'max']) {
            var b = await _buildBody({ model: 'claude-sonnet-5-5', isClaudeOAuth: true, effort: e }, 0);
            assert.deepStrictEqual(b.reasoning, { effort: e }, 'provider effort wins over the off switch: ' + e);
            var t = m.transform(Object.assign({}, b, { messages: MSGS, tools: TOOLS }));
            assert.deepStrictEqual(t.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, e);
            assert.deepStrictEqual(t.output_config, { effort: e }, e);
        }
        var on = m.transform(Object.assign({}, base, { reasoning: { effort: 'high' } }));
        assert.deepStrictEqual(on.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
        assert.deepStrictEqual(on.output_config, { effort: 'high' });
        var legacy = m.transform(Object.assign({}, base, { reasoning: { max_tokens: 16000 } }));
        assert.strictEqual(legacy.thinking.type, 'adaptive', 'budget never becomes budget_tokens');
        [off, on, legacy].forEach(function(r) {
            assert.notStrictEqual(r.thinking.type, 'disabled'); assert.notStrictEqual(r.thinking.type, 'enabled');
            assert.deepStrictEqual(r.tool_choice, { type: 'auto' });
        });
        assert.match(m.betas('claude-sonnet-5-5'), /thinking-binding-controls-2026-08-01/);
        // Sonnet 5 (manual config) unchanged: off → no thinking, no binding betas
        assert.strictEqual(m.transform({ model: 'claude-sonnet-5', max_tokens: 64000, messages: MSGS, reasoning: { enabled: false } }).thinking, undefined);
        assert.strictEqual(/thinking-binding/.test(m.betas('claude-sonnet-5')), false);
    }, { tags: ['unit'] });

    test('between_tools strips replayed thinking only before the last genuine user turn; in-flight tool loop kept', async function() {
        var m = await _transform();
        var th = function(s) { return { type: 'thinking', thinking: s, signature: 'sig' + s }; };
        var red = { type: 'redacted_thinking', data: 'xx' };
        var conv = function() { return [
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: [th('a'), red, { type: 'tool_use', id: 't1', name: 't', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
            { role: 'assistant', content: [th('b'), { type: 'text', text: 'done1' }] },
            { role: 'assistant', content: [th('only')] },
            { role: 'user', content: [{ type: 'text', text: 'q2' }] },
            { role: 'assistant', content: [th('c'), { type: 'tool_use', id: 't2', name: 't', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }] }
        ]; };
        var src = conv();
        var off = m.transform({ model: 'claude-sonnet-5-5', max_tokens: 64000, messages: src, tools: TOOLS, reasoning: { enabled: false } });
        assert.deepStrictEqual(off.thinking, { type: 'between_tools' });
        var types = off.messages.map(function(x) { return Array.isArray(x.content) ? x.content.map(function(b) { return b.type; }) : x.content; });
        assert.deepStrictEqual(types[1], ['tool_use'], 'earlier-turn thinking + redacted stripped');
        assert.deepStrictEqual(types[3], ['text'], 'earlier-turn thinking stripped');
        assert.ok(off.messages.some(function(x) { return x.role === 'assistant' && x.content.length === 1 && x.content[0].thinking === 'only'; }), 'would-be-empty assistant left unchanged');
        var last = off.messages.filter(function(x) { return x.role === 'assistant'; }).pop();
        assert.deepStrictEqual(last.content.map(function(b) { return b.type; }), ['thinking', 'tool_use'], 'in-flight tool loop keeps its thinking');
        assert.deepStrictEqual(src[1].content.map(function(b) { return b.type; }), ['thinking', 'redacted_thinking', 'tool_use'], 'caller messages not mutated');
        // Prefix-stable: the next request in the same tool loop strips the same prefix
        var next = conv().concat([{ role: 'assistant', content: [th('d'), { type: 'text', text: 'end' }] }]);
        var off2 = m.transform({ model: 'claude-sonnet-5-5', max_tokens: 64000, messages: next, tools: TOOLS, reasoning: { enabled: false } });
        assert.deepStrictEqual(JSON.stringify(off2.messages.slice(0, off.messages.length - 1)), JSON.stringify(off.messages.slice(0, off.messages.length - 1)));
        // Not stripped when thinking is ON, nor for other bound models
        var on = m.transform({ model: 'claude-sonnet-5-5', max_tokens: 64000, messages: conv(), tools: TOOLS, reasoning: { effort: 'high' } });
        assert.strictEqual(on.messages[1].content[0].type, 'thinking');
        var opus = m.transform({ model: 'claude-opus-5-5', max_tokens: 64000, messages: conv(), tools: TOOLS, reasoning: { enabled: false } });
        assert.strictEqual(opus.messages[1].content[0].type, 'thinking');
    }, { tags: ['unit'] });

    test('shared OAuth predicate: routing + off-signal both key on isClaudeOAuth only', async function() {
        var llm = await loadFile('src/js/app/010-llm-streaming.js');
        assert.match(llm, /var routesToClaudeOAuth = !!provider\.isClaudeOAuth;/);
        assert.match(llm, /\(routesToClaudeOAuth && typeof isSonnet55Plus === 'function'/);
        assert.match(llm, /if \(\(routesToClaudeOAuth \|\| provider\.isChatGPTOAuth\) && typeof chrome/);
        // apiKey 'oauth' without the flag does not route to OAuth → treated as OpenRouter (no off flag)
        var noFlag = await _buildBody({ model: 'claude-sonnet-5-5', apiKey: 'oauth' }, 0);
        assert.strictEqual(noFlag.reasoning, undefined);
        var orOff = await _buildBody({ model: 'anthropic/claude-sonnet-5.5' }, 0);
        assert.strictEqual(orOff.reasoning, undefined, 'OpenRouter unchanged');
    }, { tags: ['unit'] });

    test('request builder: OpenRouter never sends reasoning.enabled:false for Sonnet 5.5; OAuth keeps the off flag; tool_choice auto', async function() {
        var orOff = await _buildBody({ model: 'anthropic/claude-sonnet-5.5' }, 0);
        assert.strictEqual(orOff.reasoning, undefined);
        assert.strictEqual(orOff.tool_choice, 'auto');
        var orEff = await _buildBody({ model: 'anthropic/claude-sonnet-5.5', effort: 'high' }, 0);
        assert.deepStrictEqual(orEff.reasoning, { effort: 'high' });
        var oaOff = await _buildBody({ model: 'claude-sonnet-5-5', isClaudeOAuth: true }, 0);
        assert.deepStrictEqual(oaOff.reasoning, { enabled: false });
        var s5 = await _buildBody({ model: 'anthropic/claude-sonnet-5' }, 0);
        assert.deepStrictEqual(s5.reasoning, { enabled: false }, 'Sonnet 5 behaviour unchanged');
        var o55 = await _buildBody({ model: 'claude-opus-5-5', isClaudeOAuth: true }, 0);
        assert.strictEqual(o55.reasoning, undefined, 'Opus 5.5 behaviour unchanged');
    }, { tags: ['unit'] });
});
