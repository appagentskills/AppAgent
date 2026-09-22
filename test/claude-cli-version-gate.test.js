// Run: run_tests { pattern: 'claude-cli-version-gate' } (js_eval sandbox; no Node).
// Evaluates the REAL background.js version-gate helpers + getAnthropicBetas /
// transformToAnthropic and the REAL 030-config.js model regexes. No network.
'use strict';

function _cut(source, start, end) {
    var a = source.indexOf(start);
    if (a < 0) throw new Error('Source extraction failed (start): ' + start);
    var b = source.indexOf(end, a + start.length);
    if (b < 0) throw new Error('Source extraction failed (end): ' + end);
    return source.slice(a, b);
}

async function loadGateModule() {
    var bg = await loadFile('src/platform/extension/background.js');
    var gate = _cut(bg, '// --- Claude CLI User-Agent version gate ---', '// --- end Claude CLI User-Agent version gate ---');
    // Drop the module-level auto-install so the test drives it explicitly.
    gate = gate.replace(/installClaudeCliUaRule\(\)\.catch\([\s\S]*?\}\);\s*$/, '');
    var store = {};
    var rules = [];
    var warnings = [];
    var chrome = {
        storage: { local: {
            get: async function(key) { var o = {}; if (key in store) o[key] = store[key]; return o; },
            set: async function(obj) { Object.keys(obj).forEach(function(k) { store[k] = obj[k]; }); }
        } },
        declarativeNetRequest: { updateDynamicRules: async function(spec) { rules.push(spec); } }
    };
    var api = new Function('chrome', 'console', gate +
        '\nreturn { compareSemver: compareSemver, parse: parseRequiredClaudeCliVersion, apply: applyClaudeCliUaRule, install: installClaudeCliUaRule, bump: bumpClaudeCliVersion, shipped: CLAUDE_CLI_VERSION, applied: function() { return _claudeCliVersionApplied; } };'
    )(chrome, { warn: function(m) { warnings.push(String(m)); }, error: function() {}, log: function() {} });
    return { api: api, store: store, rules: rules, warnings: warnings };
}

async function loadThinkingModule() {
    var bg = await loadFile('src/platform/extension/background.js');
    var cfg = await loadFile('src/js/core/030-config.js');
    var regexes = _cut(cfg, 'var ADAPTIVE_ONLY_CLAUDE_RE', "var currentProvider = ");
    var transform = _cut(bg, 'var ANTHROPIC_BASE_BETAS', 'function transformMessageToAnthropic(');
    var deps = 'var DEFAULT_THINKING_BUDGET = 32000; function transformMessageToAnthropic(m) { return { role: m.role, content: m.content }; }';
    return new Function(regexes + deps + transform +
        '\nreturn { betas: getAnthropicBetas, transform: transformToAnthropic, isBinding: isThinkingBindingModel, isFable51: isFable51Plus, isAdaptiveOnly: isAdaptiveOnlyClaude, OPUS_5_5_PLUS_RE: OPUS_5_5_PLUS_RE, THINKING_BINDING_RE: THINKING_BINDING_RE };'
    )();
}

var GATE_BODY = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', error_code: 'claude_code_version_too_old', message: 'Claude Code 2.1.257 does not support this model; version 2.1.280 or newer is required.' } });

describe('claude-cli version gate helpers', function() {
    test('compareSemver orders numerically, not lexically', async function() {
        var m = (await loadGateModule()).api;
        assert.strictEqual(m.compareSemver('2.1.280', '2.1.257'), 1);
        assert.strictEqual(m.compareSemver('2.1.257', '2.1.280'), -1);
        assert.strictEqual(m.compareSemver('2.1.280', '2.1.280'), 0);
        assert.strictEqual(m.compareSemver('2.1.9', '2.1.10'), -1);
        assert.strictEqual(m.compareSemver('2.2.0', '2.1.999'), 1);
        assert.strictEqual(m.compareSemver('2.1', '2.1.1'), -1);
        assert.strictEqual(m.compareSemver('3.0.0', '2.9.9'), 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('parseRequiredClaudeCliVersion extracts the demanded version from the API error body', async function() {
        var m = (await loadGateModule()).api;
        assert.strictEqual(m.parse(GATE_BODY), '2.1.280');
        assert.strictEqual(m.parse('Claude Code 2.1.257 does not support this model; VERSION 3.0.1 OR NEWER IS REQUIRED'), '3.0.1');
        assert.strictEqual(m.parse(JSON.stringify({ error: { message: 'thinking.type.disabled is not supported for this model' } })), null);
        assert.strictEqual(m.parse(''), null);
        assert.strictEqual(m.parse(null), null);
        assert.strictEqual(m.parse('not json at all'), null);
    }, { tags: ['unit'], timeout: 5000 });

    test('error_code without a parsable version is a null (logged) — nothing to bump to', async function() {
        var g = await loadGateModule();
        var body = JSON.stringify({ error: { error_code: 'claude_code_version_too_old', message: 'too old' } });
        assert.strictEqual(g.api.parse(body), null);
        assert.strictEqual(g.warnings.length, 1);
        assert.match(g.warnings[0], /claude_code_version_too_old/);
    }, { tags: ['unit'], timeout: 5000 });

    test('applyClaudeCliUaRule installs DNR rule 3000 with the claude-cli UA and rejects bad versions', async function() {
        var g = await loadGateModule();
        await g.api.apply('2.1.300');
        assert.strictEqual(g.rules.length, 1);
        assert.deepStrictEqual(g.rules[0].removeRuleIds, [3000]);
        var rule = g.rules[0].addRules[0];
        assert.strictEqual(rule.id, 3000);
        assert.strictEqual(rule.action.requestHeaders[0].header, 'User-Agent');
        assert.strictEqual(rule.action.requestHeaders[0].value, 'claude-cli/2.1.300 (external, cli)');
        assert.strictEqual(rule.condition.urlFilter, 'api.anthropic.com/*');
        assert.strictEqual(g.api.applied(), '2.1.300');
        await assert.rejects(g.api.apply('2.1'), /invalid version/);
        await assert.rejects(g.api.apply('<script>'), /invalid version/);
        assert.strictEqual(g.rules.length, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('installClaudeCliUaRule applies max(shipped floor, stored override)', async function() {
        var g = await loadGateModule();
        assert.strictEqual(g.api.shipped, '2.1.280');
        // no override → shipped floor
        assert.strictEqual(await g.api.install(), '2.1.280');
        assert.strictEqual(g.rules[0].addRules[0].action.requestHeaders[0].value, 'claude-cli/2.1.280 (external, cli)');
        // override BELOW the floor → floor still wins
        g.store.claudeCliVersionOverride = '2.1.100';
        assert.strictEqual(await g.api.install(), '2.1.280');
        // override ABOVE the floor → override wins
        g.store.claudeCliVersionOverride = '2.1.310';
        assert.strictEqual(await g.api.install(), '2.1.310');
        assert.strictEqual(g.rules[2].addRules[0].action.requestHeaders[0].value, 'claude-cli/2.1.310 (external, cli)');
        // garbage override → ignored
        g.store.claudeCliVersionOverride = 'latest';
        assert.strictEqual(await g.api.install(), '2.1.280');
    }, { tags: ['unit'], timeout: 5000 });

    test('bumpClaudeCliVersion persists + installs only when the demanded version is above the applied one', async function() {
        var g = await loadGateModule();
        await g.api.install();
        assert.strictEqual(await g.api.bump('2.1.280'), false, 'equal → no bump');
        assert.strictEqual(await g.api.bump('2.1.100'), false, 'lower → no bump');
        assert.strictEqual(await g.api.bump('x.y.z'), false, 'garbage → no bump');
        assert.strictEqual(g.rules.length, 1);
        assert.strictEqual(g.store.claudeCliVersionOverride, undefined);
        assert.strictEqual(await g.api.bump('2.1.295'), true);
        assert.strictEqual(g.store.claudeCliVersionOverride, '2.1.295');
        assert.strictEqual(g.api.applied(), '2.1.295');
        assert.strictEqual(g.rules[1].addRules[0].action.requestHeaders[0].value, 'claude-cli/2.1.295 (external, cli)');
        // second identical demand is a no-op (the retry-once guard's backstop)
        assert.strictEqual(await g.api.bump('2.1.295'), false);
        assert.strictEqual(g.rules.length, 2);
    }, { tags: ['unit'], timeout: 5000 });
});

describe('Opus 5.5 thinking binding (betas + thinking object)', function() {
    test('THINKING_BINDING_RE covers Fable/Mythos 5.1+ and Opus 5.5+, excludes Opus 5.0-5.4 and dated 5.0 ids', async function() {
        var m = await loadThinkingModule();
        var yes = ['claude-opus-5-5', 'claude-opus-5.5', 'claude-opus-5-5-20260915', 'claude-opus-5-10', 'claude-opus-6', 'claude-opus-10', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5-1-20260901'];
        var no = ['claude-opus-5', 'claude-opus-5-20260701', 'claude-opus-5-1', 'claude-opus-5-4', 'claude-opus-4-8', 'claude-fable-5', 'claude-fable-5-20260501', 'claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-6-astra'];
        yes.forEach(function(id) { assert.strictEqual(m.isBinding(id), true, id + ' should bind'); });
        no.forEach(function(id) { assert.strictEqual(m.isBinding(id), false, id + ' should NOT bind'); });
        // Opus 5.5 is also adaptive-only (existing regex, no change needed)
        assert.strictEqual(m.isAdaptiveOnly('claude-opus-5-5'), true);
        assert.strictEqual(m.isFable51('claude-opus-5-5'), false, 'Fable predicate stays Fable-only');
    }, { tags: ['unit'], timeout: 5000 });

    test('getAnthropicBetas adds the two thinking betas for Opus 5.5 / Fable 5.1 only', async function() {
        var m = await loadThinkingModule();
        var base = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05';
        var extra = ',thinking-binding-controls-2026-08-01,thinking-display-updates-2026-08-18';
        assert.strictEqual(m.betas('claude-opus-5-5'), base + extra);
        assert.strictEqual(m.betas('claude-fable-5-1'), base + extra);
        assert.strictEqual(m.betas('claude-opus-5'), base);
        assert.strictEqual(m.betas('claude-sonnet-5'), base);
        assert.strictEqual(m.betas('claude-opus-4-8'), base);
    }, { tags: ['unit'], timeout: 5000 });

    test('Opus 5.5 always gets adaptive + summarized + drop_block; never enabled/disabled; tool_choice auto', async function() {
        var m = await loadThinkingModule();
        var expected = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
        var tools = [{ type: 'function', function: { name: 't', description: '', parameters: { type: 'object', properties: {} } } }];
        var base = { model: 'claude-opus-5-5', max_tokens: 64000, messages: [{ role: 'user', content: 'hi' }], tools: tools };
        // effort configured
        var r1 = m.transform(Object.assign({}, base, { reasoning: { effort: 'xhigh' } }));
        assert.deepStrictEqual(r1.thinking, expected);
        assert.deepStrictEqual(r1.output_config, { effort: 'xhigh' });
        assert.deepStrictEqual(r1.tool_choice, { type: 'auto' });
        // thinking OFF (budget 0) — still adaptive, no output_config
        var r2 = m.transform(Object.assign({}, base, { reasoning: { enabled: false } }));
        assert.deepStrictEqual(r2.thinking, expected);
        assert.strictEqual(r2.output_config, undefined);
        // legacy budget — must NOT become budget_tokens
        var r3 = m.transform(Object.assign({}, base, { reasoning: { max_tokens: 16000 } }));
        assert.deepStrictEqual(r3.thinking, expected);
        assert.deepStrictEqual(r3.output_config, { effort: 'high' });
        // no reasoning at all — still adaptive (model default effort)
        var r4 = m.transform(Object.assign({}, base));
        assert.deepStrictEqual(r4.thinking, expected);
        assert.strictEqual(r4.output_config, undefined);
    }, { tags: ['unit'], timeout: 5000 });

    test('regression: Opus 5 / Sonnet 5 / legacy Claude thinking shapes are unchanged', async function() {
        var m = await loadThinkingModule();
        var msgs = [{ role: 'user', content: 'hi' }];
        var o5 = m.transform({ model: 'claude-opus-5', max_tokens: 64000, messages: msgs, reasoning: { effort: 'xhigh' } });
        assert.deepStrictEqual(o5.thinking, { type: 'adaptive', display: 'summarized' });
        assert.deepStrictEqual(o5.output_config, { effort: 'xhigh' });
        var o5off = m.transform({ model: 'claude-opus-5', max_tokens: 64000, messages: msgs, reasoning: { enabled: false } });
        assert.strictEqual(o5off.thinking, undefined);
        var f51 = m.transform({ model: 'claude-fable-5-1', max_tokens: 64000, messages: msgs, reasoning: { effort: 'high' } });
        assert.deepStrictEqual(f51.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
        var legacy = m.transform({ model: 'claude-sonnet-4-5', max_tokens: 64000, messages: msgs, reasoning: { effort: 'medium' } });
        assert.deepStrictEqual(legacy.thinking, { type: 'enabled', budget_tokens: 16000 });
        assert.strictEqual(legacy.output_config, undefined);
    }, { tags: ['unit'], timeout: 5000 });
});
