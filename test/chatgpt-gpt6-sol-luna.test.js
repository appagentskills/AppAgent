// Run: run_tests { pattern: 'gpt6-sol-luna' }. GPT-6 Sol/Luna upgrade + GPT-5.6 Terra removal (2026-09-22).
// Synthetic fixtures only: real source slices from config / indexeddb / background, no network.
'use strict';
function _slice(source, start, end) {
    var a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
    return source.slice(a, b);
}
async function _sources() {
    return {
        cfg: await loadFile('src/js/core/030-config.js'),
        idb: await loadFile('src/js/core/130-indexeddb.js'),
        bg: await loadFile('src/platform/extension/background.js')
    };
}
function _config(s) {
    return new Function(_slice(s.cfg, 'var DEFAULT_API_PROVIDERS = [', '// ─── Per-spawn model selection') +
        '\nreturn { defaults: DEFAULT_API_PROVIDERS, renames: PROVIDER_RENAMES, solLuna: isChatGPTGpt6SolLunaModel, extended: chatGPTSupportsExtendedEffort };')();
}
// The REAL loadApiProviders migration block, run against an in-memory provider list.
function _migrate(s, cfg, providers, selected) {
    var body = _slice(s.idb, 'var migratedDefaults = false;', '                    if (migratedDefaults) await saveAllApiProviders();');
    var store = { v: selected };
    var appStorage = { getItem: function() { return store.v; }, setItem: function(k, v) { store.v = v; } };
    var fn = new Function('apiProviders', 'currentProvider', 'appStorage', 'DEFAULT_API_PROVIDERS', body + '\nreturn { providers: apiProviders, current: currentProvider, changed: migratedDefaults };');
    var out = fn(providers, selected, appStorage, cfg.defaults);
    out.stored = store.v;
    return out;
}
var OLD = {
    sol: { name: 'GPT-5.6 Sol (ChatGPT)', model: 'gpt-5.6-sol', endpoint: 'https://chatgpt.com/backend-api/codex/responses', apiKey: 'oauth', effort: 'high', isChatGPTOAuth: true },
    terra: { name: 'GPT-5.6 Terra (ChatGPT)', model: 'gpt-5.6-terra', endpoint: 'https://chatgpt.com/backend-api/codex/responses', apiKey: 'oauth', effort: 'medium', isChatGPTOAuth: true },
    luna: { name: 'GPT-5.6 Luna (ChatGPT)', model: 'gpt-5.6-luna', endpoint: 'https://chatgpt.com/backend-api/codex/responses', apiKey: 'oauth', effort: 'medium', isChatGPTOAuth: true },
    orSol: { name: 'gpt-5.6-sol', model: 'openai/gpt-5.6-sol', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'sk-or-user', effort: 'low' }
};
function _copy(o) { return Object.assign({}, o); }

describe('GPT-6 Sol/Luna presets', function() {
    test('seeds GPT-6 Sol/Luna, drops Terra and every GPT-5.6 ChatGPT seed', async function() {
        var cfg = _config(await _sources());
        var byName = {}; cfg.defaults.forEach(function(d) { byName[d.name] = d; });
        assert.strictEqual(byName['GPT-6 Sol (ChatGPT)'].model, 'gpt-6-sol');
        assert.strictEqual(byName['GPT-6 Luna (ChatGPT)'].model, 'gpt-6-luna');
        assert.strictEqual(byName['GPT-6 Sol (ChatGPT)'].isChatGPTOAuth, true);
        assert.strictEqual(byName['gpt-6-sol'].model, 'openai/gpt-6-sol');
        assert.deepStrictEqual(cfg.defaults.filter(function(d) { return /5\.6|terra/i.test(d.name + ' ' + d.model); }), []);
    }, { tags: ['unit'] });
    test('every PROVIDER_RENAMES target exists; 5.6 names map to GPT-6', async function() {
        var cfg = _config(await _sources());
        var names = cfg.defaults.map(function(d) { return d.name; });
        Object.keys(cfg.renames).forEach(function(k) { assert.ok(names.indexOf(cfg.renames[k]) >= 0, k + ' -> ' + cfg.renames[k]); });
        assert.strictEqual(cfg.renames['GPT-5.6 Terra (ChatGPT)'], 'GPT-6 Sol (ChatGPT)');
        assert.strictEqual(cfg.renames['GPT-5.6 Sol (ChatGPT)'], 'GPT-6 Sol (ChatGPT)');
        assert.strictEqual(cfg.renames['GPT-5.6 Luna (ChatGPT)'], 'GPT-6 Luna (ChatGPT)');
        assert.strictEqual(cfg.renames['GPT-5.1'], 'GPT-6 Sol (ChatGPT)');
        assert.strictEqual(cfg.renames['gpt-5.6-sol'], 'gpt-6-sol');
    }, { tags: ['unit'] });
    test('capability predicates are exact-slug', async function() {
        var cfg = _config(await _sources());
        ['gpt-6-sol', 'gpt-6-luna', 'openai/gpt-6-sol'].forEach(function(m) { assert.strictEqual(cfg.solLuna(m), true, m); });
        ['gpt-6-sol-pro', 'gpt-5.6-sol', 'gpt-6-astra', '', null].forEach(function(m) { assert.strictEqual(cfg.solLuna(m), false, String(m)); });
        assert.strictEqual(cfg.extended('gpt-6-astra'), true);
        assert.strictEqual(cfg.extended('gpt-5.6-luna'), false);
    }, { tags: ['unit'] });
});

describe('GPT-5.6 → GPT-6 provider migration (real loadApiProviders block)', function() {
    test('untouched 5.6 seeds migrate; selection follows; Terra folds into Sol', async function() {
        var s = await _sources(), cfg = _config(s);
        var r = _migrate(s, cfg, [_copy(OLD.sol), _copy(OLD.terra), _copy(OLD.luna), _copy(OLD.orSol)], 'GPT-5.6 Terra (ChatGPT)');
        var names = r.providers.map(function(p) { return p.name; }).sort();
        assert.deepStrictEqual(names, ['GPT-6 Luna (ChatGPT)', 'GPT-6 Sol (ChatGPT)', 'gpt-6-sol']);
        assert.strictEqual(r.current, 'GPT-6 Sol (ChatGPT)');
        assert.strictEqual(r.stored, 'GPT-6 Sol (ChatGPT)');
        assert.strictEqual(r.providers.find(function(p) { return p.name === 'gpt-6-sol'; }).apiKey, 'sk-or-user');
        assert.strictEqual(r.providers.find(function(p) { return p.name === 'GPT-6 Luna (ChatGPT)'; }).model, 'gpt-6-luna');
        assert.strictEqual(r.changed, true);
    }, { tags: ['unit'] });
    test('idempotent and never touches customized entries', async function() {
        var s = await _sources(), cfg = _config(s);
        var first = _migrate(s, cfg, [_copy(OLD.luna)], 'GPT-5.6 Luna (ChatGPT)');
        var again = _migrate(s, cfg, first.providers.map(_copy), first.stored);
        assert.strictEqual(again.changed, false);
        assert.deepStrictEqual(again.providers, first.providers);
        var tuned = Object.assign(_copy(OLD.terra), { effort: 'high' });
        var kept = _migrate(s, cfg, [tuned], 'GPT-5.6 Terra (ChatGPT)');
        assert.strictEqual(kept.changed, false);
        assert.strictEqual(kept.providers[0].name, 'GPT-5.6 Terra (ChatGPT)');
    }, { tags: ['unit'] });
});

// The REAL loadTierAliases (+ its tier globals), run against a stored alias map and provider list.
async function _tierAliases(s, cfg, providers, storedAliases) {
    var body = _slice(s.cfg, '// ─── Per-spawn model selection', '// Persist an updated alias map');
    var getSetting = async function() { return JSON.parse(JSON.stringify(storedAliases)); };
    var fn = new Function('apiProviders', 'getSetting', 'PROVIDER_RENAMES', body + '\nreturn loadTierAliases().then(function() { return subAgentTierAliases; });');
    return fn(providers, getSetting, cfg.renames);
}

describe('Sub-agent tier aliases follow GPT-6 renames (real loadTierAliases)', function() {
    test('alias kept when the legacy preset still exists (customized, kept by migration)', async function() {
        var s = await _sources(), cfg = _config(s);
        var tuned = Object.assign(_copy(OLD.terra), { effort: 'high' });
        var out = await _tierAliases(s, cfg, [tuned, { name: 'GPT-6 Sol (ChatGPT)' }], { small: 'GPT-5.6 Terra (ChatGPT)', medium: 'GPT-5.6 Luna (ChatGPT)' });
        assert.strictEqual(out.small, 'GPT-5.6 Terra (ChatGPT)');
        assert.strictEqual(out.medium, 'GPT-6 Luna (ChatGPT)');
    }, { tags: ['unit'] });
    test('alias renamed when the legacy preset no longer exists', async function() {
        var s = await _sources(), cfg = _config(s);
        var out = await _tierAliases(s, cfg, [{ name: 'GPT-6 Sol (ChatGPT)' }, { name: 'GPT-6 Luna (ChatGPT)' }],
            { small: 'GPT-5.6 Terra (ChatGPT)', medium: 'GPT-5.6 Luna (ChatGPT)', large: 'GPT-5.1' });
        assert.deepStrictEqual(out, { small: 'GPT-6 Sol (ChatGPT)', medium: 'GPT-6 Luna (ChatGPT)', large: 'GPT-6 Sol (ChatGPT)' });
    }, { tags: ['unit'] });
});

describe('Codex request shaping for GPT-6 Sol/Luna', function() {
    async function api() {
        var s = await _sources();
        var predicate = _slice(s.cfg, 'function isChatGPTAstraModel(', '// API providers');
        var transform = _slice(s.bg, 'function _openaiTextOf(', '// --- ChatGPT OAuth streaming proxy ---');
        var normalize = _slice(s.bg, 'function _openaiNormalizeModelSlug(', 'self._openaiNormalizeModelSlug');
        return { bg: s.bg, convert: new Function(predicate + normalize + 'var _openaiModelQuirks = {};\n' + transform + '\nreturn transformToResponses;')() };
    }
    test('native efforts incl. xhigh/max pass through (no clamp)', async function() {
        var a = await api();
        ['gpt-6-sol', 'openai/gpt-6-luna'].forEach(function(m) {
            ['low', 'medium', 'high', 'xhigh', 'max'].forEach(function(e) {
                assert.strictEqual(a.convert({ model: m, reasoning: { effort: e } }).reasoning.effort, e, m + ' ' + e);
            });
        });
        assert.strictEqual(a.convert({ model: 'openai/gpt-6-luna' }).model, 'gpt-6-luna');
    }, { tags: ['unit'] });
    test('thinking off → none; minimal → low; unknown → high; no effort → server default', async function() {
        var a = await api();
        assert.strictEqual(a.convert({ model: 'gpt-6-sol', reasoning: { enabled: false } }).reasoning.effort, 'none');
        assert.strictEqual(a.convert({ model: 'gpt-6-luna', reasoning: { effort: 'none' } }).reasoning.effort, 'none');
        assert.strictEqual(a.convert({ model: 'gpt-6-sol', reasoning: { effort: 'minimal' } }).reasoning.effort, 'low');
        assert.strictEqual(a.convert({ model: 'gpt-6-sol', reasoning: { effort: 'turbo' } }).reasoning.effort, 'high');
        var d = a.convert({ model: 'gpt-6-sol' }).reasoning;
        assert.ok(d && !('effort' in d) && d.summary === 'auto');
        assert.strictEqual(a.convert({ model: 'gpt-5.6-sol', reasoning: { effort: 'max' } }).reasoning.effort, 'high');
        assert.strictEqual(a.convert({ model: 'gpt-6-sol-pro', reasoning: { effort: 'max' } }).reasoning.effort, 'high');
    }, { tags: ['unit'] });
    test('fallback catalog and default slug are GPT-6 only', async function() {
        var a = await api();
        var m = a.bg.match(/var OPENAI_FALLBACK_MODELS = (\[[^\]]*\]);/);
        assert.deepStrictEqual(JSON.parse(m[1].replace(/'/g, '"')), ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
        assert.strictEqual(a.convert({ messages: [] }).model, 'gpt-6-sol');
    }, { tags: ['unit'] });
});
