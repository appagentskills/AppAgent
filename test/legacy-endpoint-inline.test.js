// Run: run_tests { pattern: 'legacy-endpoint-inline' }. Regression: an edited
// LLM endpoint URL (e.g. away from http://localhost:8000/...) reverted on every
// load because inlineLegacyEndpointProviders re-inlined the frozen legacy
// 'llmEndpoints' object-store row over the provider. Real source slice from
// core/130-indexeddb.js; no IndexedDB.
'use strict';
function _cut(src, start, end) {
    var a = src.indexOf(start), b = src.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
    return src.slice(a, b);
}
async function _inline() {
    var idb = await loadFile('src/js/core/130-indexeddb.js');
    var fn = _cut(idb, 'function inlineLegacyEndpointProviders(', '\nasync function readLegacyEndpointProviders(');
    return new Function(fn + '\nreturn inlineLegacyEndpointProviders;')();
}
var OLD = 'http://localhost:8000/api/v1/chat/completions';
var NEW = 'http://localhost:11434/v1/chat/completions';

describe('inlineLegacyEndpointProviders', function() {
    test('edited live endpoint wins over the stale legacy store row', async function() {
        var inline = await _inline();
        var legacy = [{ id: 'local', name: 'Local', url: OLD, apiKey: 'old' }];
        var live = [{ id: 'local', name: 'Local', url: NEW, apiKey: 'new' }];
        var providers = [{ name: 'm', model: 'x', endpointId: 'local', endpoint: NEW, apiKey: 'new' }];
        var r = inline(providers, legacy, live);
        assert.strictEqual(r.providers[0].endpoint, NEW);
        assert.strictEqual(r.providers[0].apiKey, 'new');
        assert.strictEqual(r.providers[0].endpointId, 'local');
        assert.strictEqual(r.changed, false); // already in sync: no re-save
        assert.strictEqual(r.providers[0], providers[0]);
    }, { tags: ['unit'], timeout: 2000 });

    test('a provider already reverted to the legacy url is repaired from the live endpoint', async function() {
        var inline = await _inline();
        var r = inline([{ name: 'm', model: 'x', endpointId: 'local', endpoint: OLD, apiKey: 'old', effort: 'high' }],
            [{ id: 'local', url: OLD, apiKey: 'old' }], [{ id: 'local', name: 'Local', url: NEW, apiKey: '' }]);
        assert.strictEqual(r.changed, true);
        assert.deepStrictEqual(r.providers[0], { name: 'm', model: 'x', endpointId: 'local', endpoint: NEW, apiKey: '', effort: 'high' });
    }, { tags: ['unit'], timeout: 2000 });

    test('an endpointId hitting the legacy row by NAME resolves to the live record', async function() {
        var inline = await _inline();
        var r = inline([{ name: 'm', model: 'x', endpointId: 'Local' }],
            [{ id: 'local', name: 'Local', url: OLD, apiKey: 'old' }], [{ id: 'local', name: 'Local', url: NEW, apiKey: 'new' }]);
        assert.strictEqual(r.changed, true);
        assert.deepStrictEqual(r.providers[0], { name: 'm', model: 'x', endpointId: 'local', endpoint: NEW, apiKey: 'new' });
    }, { tags: ['unit'], timeout: 2000 });

    test('legacy-only rows (no live endpoint) still inline from the legacy store', async function() {
        var inline = await _inline();
        var r = inline([{ name: 'm', model: 'x', endpointId: 'gone' }], [{ id: 'gone', url: OLD, apiKey: 'k' }], []);
        assert.strictEqual(r.changed, true);
        assert.strictEqual(r.providers[0].endpoint, OLD);
        assert.strictEqual(r.providers[0].apiKey, 'k');
        assert.strictEqual(r.providers[0].endpointId, undefined);
    }, { tags: ['unit'], timeout: 2000 });
});

// saveLlmEndpointFromModal (ui/040-tools-settings.js) with the real
// findEndpointForProvider/_normalizeEndpointUrl; DOM + persistence stubbed.
async function _endpointSave(endpoints, providers) {
    var ui = await loadFile('src/js/ui/040-tools-settings.js');
    var src = _cut(ui, 'async function saveLlmEndpointFromModal(', '\nasync function confirmDeleteLlmEndpoint(') +
        _cut(ui, 'function _normalizeEndpointUrl(', '\n// The LLM-endpoint record backing a model.') +
        _cut(ui, 'function findEndpointForProvider(', '\n// Brand icon for an endpoint URL');
    var h = { fields: {}, persisted: null, snacks: [] };
    var api = new Function('h', 'llmEndpoints', 'apiProviders',
        'var document = { getElementById: function(id) { return { value: h.fields[id] || "" }; } };' +
        'function getLlmEndpointById(id) { return llmEndpoints.find(function(e) { return e.id === id; }) || null; }' +
        'function t(s) { return s; } function tn(n, a) { return a; }' +
        'function showSnackbar(m, k) { h.snacks.push([m, k]); }' +
        'function closeLlmEndpointModal() {} function renderLlmEndpointsList() {} function renderApiProvidersList() {}' +
        'async function persistLlmEndpointState(eps, affected) { h.persisted = { eps: eps, affected: affected }; }' +
        src + '\nreturn { save: saveLlmEndpointFromModal, state: function() { return { llmEndpoints: llmEndpoints, apiProviders: apiProviders }; } };'
    )(h, endpoints, providers);
    api.h = h;
    return api;
}

describe('saveLlmEndpointFromModal re-sync', function() {
    test('a URL-only model (no endpointId) shown under the endpoint follows the edited URL', async function() {
        var api = await _endpointSave(
            [{ id: 'local', name: 'Local', url: OLD, apiKey: 'k' }],
            [{ name: 'Proxy', model: 'x', endpoint: OLD, apiKey: 'k' },
             { name: 'Other', model: 'y', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: '' },
             { name: 'Sub', model: 'z', endpoint: OLD, apiKey: 'oauth', isChatGPTOAuth: true }]);
        api.h.fields = { 'llm-endpoint-name': 'Local', 'llm-endpoint-url': NEW, 'llm-endpoint-apikey': 'k2' };
        await api.save('local');
        var s = api.state();
        assert.deepStrictEqual(s.apiProviders[0], { name: 'Proxy', model: 'x', endpoint: NEW, apiKey: 'k2', endpointId: 'local' });
        assert.strictEqual(s.apiProviders[1].endpoint, 'https://openrouter.ai/api/v1/chat/completions');
        assert.strictEqual(s.apiProviders[2].endpoint, OLD); // OAuth never relinked
        assert.strictEqual(s.apiProviders[2].endpointId, undefined);
        assert.strictEqual(api.h.persisted.affected.length, 1);
        assert.strictEqual(api.h.persisted.affected[0].endpoint, NEW);
        assert.strictEqual(s.llmEndpoints[0].url, NEW);
    }, { tags: ['unit'], timeout: 2000 });

    test('endpointId-linked models still re-sync; a new endpoint relinks nothing', async function() {
        var api = await _endpointSave([{ id: 'local', name: 'Local', url: OLD, apiKey: '' }],
            [{ name: 'A', model: 'x', endpointId: 'local', endpoint: OLD, apiKey: '' }]);
        api.h.fields = { 'llm-endpoint-name': 'Local', 'llm-endpoint-url': NEW, 'llm-endpoint-apikey': '' };
        await api.save('local');
        assert.strictEqual(api.state().apiProviders[0].endpoint, NEW);
        api.h.fields = { 'llm-endpoint-name': 'Second', 'llm-endpoint-url': NEW, 'llm-endpoint-apikey': '' };
        await api.save('');
        assert.strictEqual(api.h.persisted.affected.length, 0);
        assert.strictEqual(api.state().apiProviders[0].endpointId, 'local');
    }, { tags: ['unit'], timeout: 2000 });

    test('a URL-only model with its own key keeps it when the endpoint key is empty', async function() {
        var api = await _endpointSave([{ id: 'local', name: 'Local', url: OLD, apiKey: '' }],
            [{ name: 'Proxy', model: 'x', endpoint: OLD, apiKey: 'own' },
             { name: 'Bare', model: 'y', endpoint: OLD, apiKey: '' }]);
        api.h.fields = { 'llm-endpoint-name': 'Local', 'llm-endpoint-url': NEW, 'llm-endpoint-apikey': '' };
        await api.save('local');
        var s = api.state();
        assert.deepStrictEqual(s.apiProviders[0], { name: 'Proxy', model: 'x', endpoint: NEW, apiKey: 'own' });
        assert.deepStrictEqual(s.apiProviders[1], { name: 'Bare', model: 'y', endpoint: NEW, apiKey: '', endpointId: 'local' });
        assert.strictEqual(api.h.persisted.affected.length, 2);
        assert.strictEqual(api.h.persisted.affected[0].apiKey, 'own');
        // Still matched by URL on the next edit, key still intact.
        api.h.fields = { 'llm-endpoint-name': 'Local', 'llm-endpoint-url': OLD, 'llm-endpoint-apikey': '' };
        await api.save('local');
        assert.deepStrictEqual(api.state().apiProviders[0], { name: 'Proxy', model: 'x', endpoint: OLD, apiKey: 'own' });
    }, { tags: ['unit'], timeout: 2000 });

    test('a rename-only save (prefilled endpoint key) never overwrites a URL-only model\'s own key', async function() {
        var api = await _endpointSave([{ id: 'local', name: 'Local', url: OLD, apiKey: 'sk-A' }],
            [{ name: 'Proxy', model: 'x', endpoint: OLD, apiKey: 'sk-B' }]);
        api.h.fields = { 'llm-endpoint-name': 'Renamed', 'llm-endpoint-url': OLD, 'llm-endpoint-apikey': 'sk-A' };
        await api.save('local');
        var p = api.state().apiProviders[0];
        assert.strictEqual(p.apiKey, 'sk-B');
        assert.strictEqual(p.endpointId, undefined);
        assert.strictEqual(api.state().llmEndpoints[0].name, 'Renamed');
    }, { tags: ['unit'], timeout: 2000 });

    test('a deliberate endpoint key change reaches a URL-only model holding its own key', async function() {
        var OR = 'https://openrouter.ai/api/v1/chat/completions';
        var api = await _endpointSave([{ id: 'openrouter', name: 'OpenRouter', url: OR, apiKey: '' }],
            [{ name: 'Proxy', model: 'x', endpoint: OR, apiKey: 'sk-x' }]);
        api.h.fields = { 'llm-endpoint-name': 'OpenRouter', 'llm-endpoint-url': OR, 'llm-endpoint-apikey': 'sk-new' };
        await api.save('openrouter');
        var p = api.state().apiProviders[0];
        assert.strictEqual(p.apiKey, 'sk-new');
        assert.strictEqual(p.endpointId, 'openrouter');
        assert.strictEqual(api.h.persisted.affected.length, 1);
    }, { tags: ['unit'], timeout: 2000 });
});
