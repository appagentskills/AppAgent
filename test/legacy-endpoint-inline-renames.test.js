// Run: run_tests { pattern: 'legacy-endpoint-inline-renames' }. Regression for
// PR #1394: endpointId-era OpenRouter seeds (sonnet-5 / GLM 5.2 / Gemini 3.5
// Flash) now hit the LIVE branch of inlineLegacyEndpointProviders ('openrouter'
// is in DEFAULT_LLM_ENDPOINTS) and are stored as seed + endpoint/apiKey with NO
// url key. The default-rename table must still recognise that shape. Runs the
// real inline step, then the real migration block, as loadApiProviders does.
'use strict';
function _cut(src, start, end) {
    var a = src.indexOf(start), b = src.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
    return src.slice(a, b);
}
async function _pipeline() {
    var cfg = await loadFile('src/js/core/030-config.js');
    var c = new Function(_cut(cfg, 'var DEFAULT_API_PROVIDERS = [', '// ─── Per-spawn model selection') +
        '\nreturn { defaults: DEFAULT_API_PROVIDERS, endpoints: DEFAULT_LLM_ENDPOINTS };')();
    var idb = await loadFile('src/js/core/130-indexeddb.js');
    var inline = new Function(_cut(idb, 'function inlineLegacyEndpointProviders(', '\nasync function readLegacyEndpointProviders(') +
        '\nreturn inlineLegacyEndpointProviders;')();
    var block = _cut(idb, 'var migratedDefaults = false;', '                    if (migratedDefaults) await saveAllApiProviders();');
    return {
        defaults: c.defaults,
        endpoints: c.endpoints,
        run: function(list, legacyStore, liveEndpoints) {
            var inl = inline(list, legacyStore, liveEndpoints || c.endpoints);
            var aps = { getItem: function() { return null; }, setItem: function() {} };
            var out = new Function('apiProviders', 'currentProvider', 'appStorage', 'DEFAULT_API_PROVIDERS',
                block + '\nreturn { providers: apiProviders, changed: migratedDefaults };')(inl.providers, 'x', aps, c.defaults);
            out.inlined = inl.providers;
            return out;
        }
    };
}
var OR = 'https://openrouter.ai/api/v1/chat/completions';
var LEGACY_STORE = [{ id: 'openrouter', name: 'OpenRouter', url: OR, apiKey: '' }];
var MODELS = [
    ['sonnet-5.5', { name: 'sonnet-5', model: 'anthropic/claude-sonnet-5', effort: 'high' }, { context_length: 1000000, maxTokens: 64000 }, { maxTokens: 64000 }],
    ['GLM 5.3', { name: 'GLM 5.2', model: 'z-ai/glm-5.2', provider: 'z-ai' }, { context_length: 1048576, maxTokens: 64000, thinkingBudget: 40000 }, { maxTokens: 64000, thinkingBudget: 40000 }],
    ['Gemini 4 Neon', { name: 'Gemini 3.5 Flash', model: 'google/gemini-3.5-flash' }, { context_length: 1048576, maxTokens: 64000, thinkingBudget: 50000 }, { maxTokens: 64000, thinkingBudget: 50000 }]
];
function _seeds() {
    var out = [];
    MODELS.forEach(function(m) {
        [m[2], m[3], {}].forEach(function(extra, v) {
            out.push({ to: m[0], label: m[1].name + ' V' + (v + 2), seed: Object.assign({ endpointId: 'openrouter' }, extra, m[1]) });
        });
    });
    return out;
}

describe('endpointId-era seeds still rename after live endpoint sync', function() {
    [['without legacy store', []], ['with legacy store', LEGACY_STORE]].forEach(function(sc) {
        test('sonnet-5 / GLM 5.2 / Gemini 3.5 Flash rename ' + sc[0], async function() {
            var p = await _pipeline();
            assert.ok(p.endpoints.some(function(e) { return e.id === 'openrouter' && e.url === OR; }), 'openrouter is a live default endpoint');
            _seeds().forEach(function(s) {
                var out = p.run([Object.assign({}, s.seed)], sc[1].map(function(e) { return Object.assign({}, e); }));
                // Live branch: endpoint/apiKey synced, no url key (shape (d)).
                assert.strictEqual(out.inlined[0].endpoint, OR, s.label);
                assert.strictEqual(Object.prototype.hasOwnProperty.call(out.inlined[0], 'url'), false, s.label);
                assert.strictEqual(out.changed, true, s.label + ' renamed');
                var def = p.defaults.find(function(d) { return d.name === s.to; });
                assert.deepStrictEqual(out.providers, [Object.assign({}, def, { apiKey: '' })], s.label);
            });
        }, { tags: ['unit'], timeout: 4000 });
    });

    test('a key set on the live openrouter endpoint is carried over by the rename', async function() {
        var p = await _pipeline();
        var live = p.endpoints.map(function(e) { return e.id === 'openrouter' ? Object.assign({}, e, { apiKey: 'sk-or' }) : e; });
        var out = p.run([{ name: 'GLM 5.2', model: 'z-ai/glm-5.2', endpointId: 'openrouter', provider: 'z-ai' }], [], live);
        assert.strictEqual(out.providers[0].name, 'GLM 5.3');
        assert.strictEqual(out.providers[0].apiKey, 'sk-or');
    }, { tags: ['unit'], timeout: 4000 });

    test('a customized live-synced seed is not renamed', async function() {
        var p = await _pipeline();
        var out = p.run([{ name: 'sonnet-5', model: 'anthropic/claude-sonnet-5', endpointId: 'openrouter', effort: 'low' }], []);
        assert.strictEqual(out.changed, false);
        assert.strictEqual(out.providers[0].name, 'sonnet-5');
    }, { tags: ['unit'], timeout: 4000 });
});
