// Run: run_tests { pattern: 'glm-gemini-presets' }. GLM 5.3 / Gemini 3.8 Flash
// replace the GLM 5.2 / Gemini 3.5 Flash OpenRouter defaults (2026-10-07).
// Real source slices from 030-config.js / 130-indexeddb.js; no network.
'use strict';
function _cut(src, start, end) {
    var a = src.indexOf(start), b = src.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
    return src.slice(a, b);
}
async function _config() {
    var cfg = await loadFile('src/js/core/030-config.js');
    return new Function(_cut(cfg, 'var DEFAULT_API_PROVIDERS = [', '// ─── Per-spawn model selection') +
        '\nreturn { defaults: DEFAULT_API_PROVIDERS, renames: PROVIDER_RENAMES };')();
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
var OR = 'https://openrouter.ai/api/v1/chat/completions';
var GLM53 = { name: 'GLM 5.3', model: 'z-ai/glm-5.3', endpoint: OR, apiKey: '', provider: 'z-ai' };
var GEM38 = { name: 'Gemini 3.8 Flash', model: 'google/gemini-3.8-flash', endpoint: OR, apiKey: '' };
var GLM_BASE = { name: 'GLM 5.2', model: 'z-ai/glm-5.2', provider: 'z-ai' };
var GEM_BASE = { name: 'Gemini 3.5 Flash', model: 'google/gemini-3.5-flash' };
// Every historical seed vintage (030-config.js git history since 2026-07-02).
function _shapes(base, tb) {
    var legacy = { context_length: 1048576, maxTokens: 64000, thinkingBudget: tb };
    var s = {
        V1: Object.assign({ apiKey: '', endpoint: OR }, legacy, base),
        V5: Object.assign({ endpoint: OR, apiKey: '' }, base)
    };
    [['V2', legacy], ['V3', { maxTokens: 64000, thinkingBudget: tb }], ['V4', {}]].forEach(function(v) {
        var seed = Object.assign({ endpointId: 'openrouter' }, v[1], base);
        s[v[0] + 'a'] = seed;
        s[v[0] + 'b'] = Object.assign({}, seed, { url: OR, endpoint: OR, apiKey: '' });
        var c = Object.assign({}, s[v[0] + 'b']); delete c.endpointId; s[v[0] + 'c'] = c;
    });
    return s;
}

describe('GLM 5.3 / Gemini 3.8 Flash presets', function() {
    test('defaults carry the new ids (z-ai pin kept); old names gone; renames point at existing targets', async function() {
        var c = await _config();
        var by = {}; c.defaults.forEach(function(d) { by[d.name] = d; });
        assert.deepStrictEqual(by['GLM 5.3'], GLM53);
        assert.deepStrictEqual(by['Gemini 3.8 Flash'], GEM38);
        assert.strictEqual(by['GLM 5.2'], undefined);
        assert.strictEqual(by['Gemini 3.5 Flash'], undefined);
        assert.strictEqual(c.renames['GLM 5.2'], 'GLM 5.3');
        assert.strictEqual(c.renames['Kimi K2.5'], 'GLM 5.3');
        assert.strictEqual(c.renames['Gemini 3.5 Flash'], 'Gemini 3.8 Flash');
        assert.strictEqual(c.renames['Gemini 3 Flash Preview'], 'Gemini 3.8 Flash');
        Object.keys(c.renames).forEach(function(k) {
            if (/GLM|Gemini|Kimi/.test(k)) assert.ok(by[c.renames[k]], k + ' → ' + c.renames[k] + ' exists');
        });
    }, { tags: ['unit'] });

    test('every untouched GLM 5.2 / Gemini 3.5 Flash seed vintage migrates; apiKey + selection carried', async function() {
        var run = await _migrator();
        [[_shapes(GLM_BASE, 40000), GLM53, 'GLM 5.2'], [_shapes(GEM_BASE, 50000), GEM38, 'Gemini 3.5 Flash']].forEach(function(t) {
            Object.keys(t[0]).forEach(function(k) {
                var r = run([Object.assign({}, t[0][k])], t[2]);
                assert.strictEqual(r.changed, true, t[2] + ' ' + k + ' migrated');
                assert.deepStrictEqual(r.providers, [t[1]], t[2] + ' ' + k);
                assert.strictEqual(r.current, t[1].name);
                assert.strictEqual(r.stored, t[1].name);
            });
            var keyed = run([Object.assign({}, t[0].V5, { apiKey: 'sk-or-user' })], 'Opus 5.5');
            assert.strictEqual(keyed.providers[0].name, t[1].name);
            assert.strictEqual(keyed.providers[0].apiKey, 'sk-or-user', 'apiKey carried over');
            assert.strictEqual(keyed.stored, 'Opus 5.5', 'unrelated selection untouched');
        });
    }, { tags: ['unit'] });

    test('user-edited copies are kept; already-present successor absorbs the legacy row; idempotent', async function() {
        var run = await _migrator();
        var tunedGlm = Object.assign({}, _shapes(GLM_BASE, 40000).V5, { provider: 'deepinfra' });
        var tunedGem = Object.assign({}, _shapes(GEM_BASE, 50000).V5, { effort: 'low' });
        var kept = run([tunedGlm, tunedGem], 'GLM 5.2');
        assert.strictEqual(kept.changed, false);
        assert.deepStrictEqual(kept.providers.map(function(p) { return p.model; }), ['z-ai/glm-5.2', 'google/gemini-3.5-flash']);
        assert.strictEqual(kept.stored, 'GLM 5.2');
        var both = run([Object.assign({}, _shapes(GLM_BASE, 40000).V5, { apiKey: 'sk-x' }), Object.assign({}, GLM53)], null);
        assert.deepStrictEqual(both.providers.map(function(p) { return p.name; }), ['GLM 5.3']);
        assert.strictEqual(both.providers[0].apiKey, 'sk-x', 'keyless successor receives the legacy key');
        var again = run(both.providers.map(function(p) { return Object.assign({}, p); }), 'GLM 5.3');
        assert.strictEqual(again.changed, false);
    }, { tags: ['unit'] });

    test('chain renames: untouched Kimi K2.5 / Gemini 3 Flash Preview land on the new defaults', async function() {
        var run = await _migrator();
        var kimi = { name: 'Kimi K2.5', apiKey: '', model: 'moonshotai/kimi-k2.5', endpoint: OR, context_length: 262000, maxTokens: 64000, thinkingBudget: 40000, provider: 'moonshotai' };
        var g3 = { name: 'Gemini 3 Flash Preview', apiKey: '', model: 'google/gemini-3-flash-preview', endpoint: OR, context_length: 1000000, maxTokens: 64000, thinkingBudget: 50000 };
        var r = run([kimi, g3], 'Kimi K2.5');
        assert.deepStrictEqual(r.providers, [GLM53, GEM38]);
        assert.strictEqual(r.stored, 'GLM 5.3');
    }, { tags: ['unit'] });
});
