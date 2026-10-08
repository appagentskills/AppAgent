// Run: run_tests { pattern: 'haiku-5-5' }. Claude Haiku 5.5 (2026-10-07).
// Real source slices from 030-config.js / 130-indexeddb.js / background.js /
// 010-llm-streaming.js (same fixture approach as sonnet-5-5.test.js).
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
        '\nreturn { defaults: DEFAULT_API_PROVIDERS, renames: PROVIDER_RENAMES, tiers: DEFAULT_TIER_ALIASES, current: currentProvider };')();
}
async function _regexes() {
    var cfg = await _cfgSrc();
    return new Function(_cut(cfg, 'var DEFAULT_MAX_TOKENS = 64000;', 'var MAX_TOKENS_SETTING_KEY') +
        _cut(cfg, 'function getDefaultMaxTokensForModel', '// THE accessors') +
        _cut(cfg, 'var ADAPTIVE_ONLY_CLAUDE_RE', 'var currentProvider = ') +
        '\nreturn { isH55: isHaiku55Plus, isS55: isSonnet55Plus, isBinding: isThinkingBindingModel, isAdaptiveOnly: isAdaptiveOnlyClaude, off: thinkingOffShapeFor, maxTok: getDefaultMaxTokensForModel };')();
}
async function _transform() {
    var bg = await loadFile('src/platform/extension/background.js');
    var cfg = await _cfgSrc();
    var deps = 'var DEFAULT_THINKING_BUDGET = 32000; function transformMessageToAnthropic(m) { return { role: m.role, content: m.content }; }';
    return new Function(_cut(cfg, 'var ADAPTIVE_ONLY_CLAUDE_RE', 'var currentProvider = ') + deps +
        _cut(bg, 'var ANTHROPIC_BASE_BETAS', 'function transformMessageToAnthropic(') +
        '\nreturn { transform: transformToAnthropic, betas: getAnthropicBetas };')();
}
async function _buildBody(provider, globalBudget) {
    var llm = await loadFile('src/js/app/010-llm-streaming.js');
    var cfg = await _cfgSrc();
    var body = _cut(llm, '    var requestBody = {', '\tif (provider.provider) {');
    var fn = new Function('provider', 'modelLower', 'isAnthropic', 'systemMessage', 'messagesWithCache', 'chatId', 'requestTools',
        'getEnabledTools', 'getGlobalMaxTokens', 'getGlobalThinkingBudget',
        _cut(cfg, 'var ADAPTIVE_ONLY_CLAUDE_RE', 'var currentProvider = ') + body + '\nreturn requestBody;');
    var lower = provider.model.toLowerCase();
    return fn(provider, lower, lower.indexOf('claude') >= 0, { role: 'system', content: 's' }, [], null, [],
        function() { return []; }, function() { return 64000; }, function() { return globalBudget; });
}
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
var EP = 'https://api.anthropic.com/v1/messages', OR = 'https://openrouter.ai/api/v1/chat/completions';
var MSGS = [{ role: 'user', content: 'hi' }];
var TOOLS = [{ type: 'function', function: { name: 't', description: '', parameters: { type: 'object', properties: {} } } }];
var BOUND = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };

describe('Haiku 5.5: seeds, defaults, migrations untouched', function() {
    test('OAuth + OpenRouter seeds added; default provider + small tier unchanged; haiku-4.5 not redirected', async function() {
        var c = await _config();
        var by = {}; c.defaults.forEach(function(d) { by[d.name] = d; });
        assert.deepStrictEqual(by['Haiku 5.5'], { name: 'Haiku 5.5', model: 'claude-haiku-5-5', endpoint: EP, apiKey: 'oauth', effort: 'medium', isClaudeOAuth: true });
        assert.deepStrictEqual(by['haiku-5.5'], { name: 'haiku-5.5', model: 'anthropic/claude-haiku-5.5', endpoint: OR, apiKey: '', effort: 'medium' });
        assert.strictEqual(c.current, 'Opus 5.5');
        assert.strictEqual(c.tiers.small, 'Sonnet 5.5');
        assert.strictEqual(c.renames['haiku-4.5'], 'Opus 5.5', 'old haiku rename unchanged');
        Object.keys(c.renames).forEach(function(k) { assert.ok(!/haiku/i.test(c.renames[k]), 'nothing renames to Haiku: ' + k); });
    }, { tags: ['unit'] });

    test('loadApiProviders: untouched haiku-4.5 still dropped (not migrated to Haiku 5.5); Haiku 5.5 seeds are stable', async function() {
        var run = await _migrator();
        var old = { name: 'haiku-4.5', apiKey: '', model: 'anthropic/claude-haiku-4.5', endpoint: OR, context_length: 200000, maxTokens: 64000, thinkingBudget: 32000 };
        var r = run([Object.assign({}, old)], 'haiku-4.5');
        assert.strictEqual(r.providers.length, 0);
        assert.notStrictEqual(r.stored, 'Haiku 5.5'); assert.notStrictEqual(r.stored, 'haiku-5.5');
        var c = await _config();
        var seeds = c.defaults.filter(function(d) { return /haiku/.test(d.name.toLowerCase()); }).map(function(d) { return Object.assign({}, d); });
        var again = run(seeds, 'Haiku 5.5');
        assert.strictEqual(again.changed, false);
        assert.strictEqual(again.stored, 'Haiku 5.5');
    }, { tags: ['unit'] });
});

describe('Haiku 5.5: model regexes', function() {
    test('HAIKU_5_5_PLUS_RE / binding / adaptive-only / max tokens; Haiku 4.x excluded', async function() {
        var m = await _regexes();
        ['claude-haiku-5-5', 'claude-haiku-5.5', 'anthropic/claude-haiku-5.5', 'claude-haiku-5-5-20261101', 'claude-haiku-5-10', 'claude-haiku-6'].forEach(function(id) {
            assert.strictEqual(m.isH55(id), true, id); assert.strictEqual(m.isBinding(id), true, id);
            assert.strictEqual(m.isAdaptiveOnly(id), true, id); assert.strictEqual(m.maxTok(id), 128000, id);
            assert.strictEqual(m.isS55(id), false, id);
        });
        ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4.5', 'claude-3-5-haiku-20241022', 'claude-haiku-5', 'claude-haiku-5-4', 'claude-haiku-5-20261001'].forEach(function(id) {
            assert.strictEqual(m.isH55(id), false, id); assert.strictEqual(m.isBinding(id), false, id);
            assert.strictEqual(m.isAdaptiveOnly(id), false, id); assert.strictEqual(m.maxTok(id), 64000, id);
        });
        ['low', 'medium', 'high', null].forEach(function(e) { assert.deepStrictEqual(m.off('claude-haiku-5-5', e), { type: 'disabled' }, String(e)); });
        assert.deepStrictEqual(m.off('claude-haiku-5-5', 'xhigh'), { type: 'adaptive' });
        assert.deepStrictEqual(m.off('claude-sonnet-5-5', null), { type: 'between_tools' }, 'Sonnet unchanged');
        assert.strictEqual(m.off('claude-haiku-4-5', null), null);
    }, { tags: ['unit'] });
});

describe('Haiku 5.5: request shaping', function() {
    test('builder: no temperature, no budget, off flag kept on both paths; effort passes through', async function() {
        var oa = await _buildBody({ model: 'claude-haiku-5-5', isClaudeOAuth: true }, 0);
        assert.strictEqual(oa.temperature, undefined); assert.strictEqual(oa.top_p, undefined); assert.strictEqual(oa.top_k, undefined);
        assert.deepStrictEqual(oa.reasoning, { enabled: false });
        assert.strictEqual(oa.max_tokens, 64000);
        var or = await _buildBody({ model: 'anthropic/claude-haiku-5.5' }, 0);
        assert.deepStrictEqual(or.reasoning, { enabled: false }, 'disabled is valid at default effort');
        var bud = await _buildBody({ model: 'anthropic/claude-haiku-5.5' }, 16000);
        assert.strictEqual(bud.reasoning, undefined, 'global budget never becomes reasoning.max_tokens');
        var legacy = await _buildBody({ model: 'claude-haiku-5-5', isClaudeOAuth: true, thinkingBudget: 8000 }, 16000);
        assert.deepStrictEqual(legacy.reasoning, { effort: 'high' });
        var eff = await _buildBody({ model: 'claude-haiku-5-5', isClaudeOAuth: true, effort: 'medium' }, 0);
        assert.deepStrictEqual(eff.reasoning, { effort: 'medium' });
        var h45 = await _buildBody({ model: 'anthropic/claude-haiku-4.5' }, 16000);
        assert.deepStrictEqual(h45.reasoning, { max_tokens: 16000 }, 'Haiku 4.5 legacy budget unchanged');
    }, { tags: ['unit'] });

    test('OAuth transform: adaptive + block_binding + betas; off → bare disabled; never budget_tokens; ends on user turn', async function() {
        var m = await _transform();
        var base = { model: 'claude-haiku-5-5', max_tokens: 64000, messages: MSGS, tools: TOOLS };
        var def = m.transform(Object.assign({}, base));
        assert.deepStrictEqual(def.thinking, BOUND); assert.strictEqual(def.output_config, undefined);
        var on = m.transform(Object.assign({}, base, { reasoning: { effort: 'medium' } }));
        assert.deepStrictEqual(on.thinking, BOUND); assert.deepStrictEqual(on.output_config, { effort: 'medium' });
        var leg = m.transform(Object.assign({}, base, { reasoning: { max_tokens: 16000 } }));
        assert.strictEqual(leg.thinking.type, 'adaptive'); assert.deepStrictEqual(leg.output_config, { effort: 'high' });
        var off = m.transform(Object.assign({}, base, { reasoning: { enabled: false } }));
        assert.deepStrictEqual(off.thinking, { type: 'disabled' }); assert.strictEqual(off.output_config, undefined);
        [def, on, leg, off].forEach(function(r) {
            assert.notStrictEqual(r.thinking.type, 'enabled'); assert.strictEqual(r.temperature, undefined);
            assert.strictEqual(r.messages[r.messages.length - 1].role, 'user');
        });
        var th = { type: 'thinking', thinking: 'a', signature: 's' };
        var conv = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: [th, { type: 'text', text: 'x' }] }, { role: 'user', content: 'q2' }];
        var off2 = m.transform({ model: 'claude-haiku-5-5', max_tokens: 64000, messages: conv, reasoning: { enabled: false } });
        assert.deepStrictEqual(off2.messages[1].content.map(function(b) { return b.type; }), ['text'], 'earlier-turn thinking stripped when disabled');
        assert.match(m.betas('claude-haiku-5-5'), /thinking-binding-controls-2026-08-01/);
        assert.strictEqual(/thinking-binding/.test(m.betas('claude-haiku-4-5')), false);
        var h45 = m.transform({ model: 'claude-haiku-4-5', max_tokens: 64000, messages: MSGS, reasoning: { max_tokens: 16000 } });
        assert.deepStrictEqual(h45.thinking, { type: 'enabled', budget_tokens: 16000 }, 'Haiku 4.5 stays legacy');
    }, { tags: ['unit'] });
});
