// Run: run_tests { pattern: 'huggingface-provider' }. Hugging Face Inference
// Providers (router.huggingface.co) parity with OpenRouter: real source
// slices from 030-config.js / 130-indexeddb.js / 010-llm-streaming.js; no network.
'use strict';
function _cut(src, start, end) {
    var a = src.indexOf(start), b = src.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
    return src.slice(a, b);
}
async function _hf(fetchImpl) {
    var cfg = await loadFile('src/js/core/030-config.js');
    var seed = _cut(cfg, 'var DEFAULT_LLM_ENDPOINTS = [', 'var llmEndpoints = [];');
    var block = _cut(cfg, '// ─── Hugging Face Inference Providers', '// ─── end Hugging Face Inference Providers');
    return new Function('fetch', 'console', seed + block +
        '\nreturn { DEFAULT_LLM_ENDPOINTS: DEFAULT_LLM_ENDPOINTS, isHuggingFaceEndpoint: isHuggingFaceEndpoint, splitHuggingFaceModel: splitHuggingFaceModel,' +
        ' adaptRequestBodyForHuggingFace: adaptRequestBodyForHuggingFace, parseHuggingFaceModelCatalog: parseHuggingFaceModelCatalog,' +
        ' resolveHuggingFacePricing: resolveHuggingFacePricing, computeHuggingFaceCost: computeHuggingFaceCost, huggingFaceProviderLabel: huggingFaceProviderLabel,' +
        ' huggingFaceModelLabel: huggingFaceModelLabel, huggingFaceProviderOptions: huggingFaceProviderOptions, fetchHuggingFaceModelCatalog: fetchHuggingFaceModelCatalog,' +
        ' findHuggingFaceModel: findHuggingFaceModel, formatHfPricePerM: formatHfPricePerM, HF_MODELS_URL: HF_MODELS_URL,' +
        ' sanitizeHuggingFaceProviderName: sanitizeHuggingFaceProviderName, pickHuggingFaceToolProvider: pickHuggingFaceToolProvider,' +
        ' getCachedHuggingFaceModelCatalog: getCachedHuggingFaceModelCatalog, _hfCatalogCache: _hfCatalogCache };')(fetchImpl, { warn: function() {} });
}
var CATALOG = { object: 'list', data: [
    { id: 'Qwen/Qwen3-8B', architecture: {}, providers: [
        { provider: 'together', status: 'live', context_length: 40960, pricing: { input: 0.2, output: 0.6 }, supports_tools: true, throughput: 80 },
        { provider: 'novita', status: 'live', context_length: 131072, pricing: { input: 0.05, output: 0.25 }, supports_tools: false, throughput: 120 },
        { provider: 'hf-inference', status: 'staging' }
    ] },
    { id: 'meta-llama/Llama-3.1-8B-Instruct', providers: [{ provider: 'cerebras', status: 'live' }] },
    { bogus: true }
] };
var BODY = {
    model: 'Qwen/Qwen3-8B', stream: true, max_tokens: 1000, temperature: 1,
    usage: { include: true }, transforms: [], provider: { only: ['together'] },
    plugins: [{ id: 'file-parser' }], reasoning: { effort: 'xhigh' },
    tools: [{ type: 'function', function: { name: 'x' }, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'system', content: 's' },
        { role: 'assistant', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }], reasoning_details: [{ type: 'reasoning.text' }] }]
};

describe('Hugging Face endpoint detection + seed', function() {
    test('seeds the HF router endpoint next to OpenRouter', async function() {
        var m = await _hf();
        var hf = m.DEFAULT_LLM_ENDPOINTS.find(function(e) { return e.id === 'huggingface'; });
        assert.strictEqual(hf.url, 'https://router.huggingface.co/v1/chat/completions');
        assert.strictEqual(hf.name, 'Hugging Face');
        assert.ok(m.DEFAULT_LLM_ENDPOINTS.some(function(e) { return e.id === 'openrouter'; }));
    }, { tags: ['unit'] });
    test('isHuggingFaceEndpoint matches HF hosts only', async function() {
        var m = await _hf();
        assert.strictEqual(m.isHuggingFaceEndpoint('https://router.huggingface.co/v1/chat/completions'), true);
        assert.strictEqual(m.isHuggingFaceEndpoint('https://ROUTER.HuggingFace.co/v1/'), true);
        assert.strictEqual(m.isHuggingFaceEndpoint('https://openrouter.ai/api/v1/chat/completions'), false);
        assert.strictEqual(m.isHuggingFaceEndpoint('https://evilhuggingface.co.example.com/v1'), false);
        assert.strictEqual(m.isHuggingFaceEndpoint(''), false);
        assert.strictEqual(m.isHuggingFaceEndpoint('not a url'), false);
    }, { tags: ['unit'] });
});

describe('adaptRequestBodyForHuggingFace', function() {
    test('strips OpenRouter-only fields, adds stream_options, maps effort', async function() {
        var m = await _hf();
        var out = m.adaptRequestBodyForHuggingFace(BODY, { provider: 'together' });
        ['usage', 'transforms', 'provider', 'plugins', 'reasoning'].forEach(function(k) { assert.strictEqual(k in out, false, k); });
        assert.deepStrictEqual(out.stream_options, { include_usage: true });
        assert.strictEqual(out.reasoning_effort, 'high');
        assert.strictEqual(out.model, 'Qwen/Qwen3-8B:together');
        assert.strictEqual(out.max_tokens, 1000);
        assert.strictEqual(out.messages[1].reasoning_details, undefined);
        assert.strictEqual(out.messages[1].content[0].cache_control, undefined);
        assert.strictEqual(out.tools[0].cache_control, undefined);
        // input not mutated
        assert.ok(BODY.usage && BODY.provider && BODY.messages[1].reasoning_details && BODY.tools[0].cache_control);
    }, { tags: ['unit'] });
    test('routing policies, explicit suffix and no provider', async function() {
        var m = await _hf();
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'a/b' }, { provider: 'fastest' }).model, 'a/b:fastest');
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'a/b' }, { provider: ' cheapest ' }).model, 'a/b:cheapest');
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'a/b:groq' }, { provider: 'together' }).model, 'a/b:groq');
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'a/b' }, { provider: '' }).model, 'a/b');
        var noStream = m.adaptRequestBodyForHuggingFace({ model: 'a/b', stream: false, reasoning: { max_tokens: 5 } }, {});
        assert.strictEqual(noStream.stream_options, undefined);
        assert.strictEqual(noStream.reasoning_effort, undefined);
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'a/b', reasoning: { enabled: false } }, null).reasoning_effort, undefined);
        assert.deepStrictEqual(m.splitHuggingFaceModel('a/b:groq'), { base: 'a/b', provider: 'groq' });
        assert.deepStrictEqual(m.splitHuggingFaceModel('a/b'), { base: 'a/b', provider: '' });
    }, { tags: ['unit'] });
});

describe('catalog parsing, labels and cost', function() {
    test('parses catalog tolerant of missing pricing/context', async function() {
        var m = await _hf();
        var cat = m.parseHuggingFaceModelCatalog(CATALOG);
        assert.strictEqual(cat.length, 2);
        var q = cat[0];
        assert.strictEqual(q.cheapest.provider, 'novita');
        assert.strictEqual(q.fastest.provider, 'novita');
        assert.strictEqual(q.context_length, 131072);
        assert.strictEqual(q.supports_tools, true);
        var hfInf = q.providers[2];
        assert.strictEqual(hfInf.input, null);
        assert.strictEqual(hfInf.context_length, null);
        assert.strictEqual(cat[1].cheapest, null);
        assert.strictEqual(cat[1].context_length, null);
        assert.deepStrictEqual(m.parseHuggingFaceModelCatalog(null), []);
    }, { tags: ['unit'] });
    test('labels show $in/$out per 1M, context, tools, status', async function() {
        var m = await _hf();
        var cat = m.parseHuggingFaceModelCatalog(CATALOG);
        assert.strictEqual(m.huggingFaceProviderLabel(cat[0].providers[0]), '$0.2 in / $0.6 out per 1M · 41K ctx · tools ✓');
        assert.strictEqual(m.huggingFaceProviderLabel(cat[0].providers[2]), 'pricing n/a · staging');
        assert.match(m.huggingFaceModelLabel(cat[0]), /from \$0\.05 in \/ \$0\.25 out per 1M · 131K ctx · tools ✓ · 3 providers/);
        assert.strictEqual(m.huggingFaceModelLabel(cat[1]), '1 provider');
        var opts = m.huggingFaceProviderOptions(cat[0]).map(function(o) { return o.value; });
        assert.deepStrictEqual(opts, ['fastest', 'cheapest', 'preferred', 'together', 'novita', 'hf-inference']);
        assert.strictEqual(m.huggingFaceProviderOptions(null).length, 3);
    }, { tags: ['unit'] });
    test('pricing resolution + cost math (cost honesty)', async function() {
        var m = await _hf();
        var cat = m.parseHuggingFaceModelCatalog(CATALOG);
        var usage = { prompt_tokens: 1000000, completion_tokens: 500000 };
        var p = m.resolveHuggingFacePricing(cat, 'Qwen/Qwen3-8B:together', '', '');
        assert.strictEqual(m.computeHuggingFaceCost(usage, p), 0.5);
        // routed header wins over suffix
        assert.strictEqual(m.resolveHuggingFacePricing(cat, 'Qwen/Qwen3-8B:together', '', 'novita').provider, 'novita');
        // policies never resolve to our own guess (needs the routed header)
        assert.strictEqual(m.resolveHuggingFacePricing(cat, 'qwen/qwen3-8b', 'cheapest', ''), null);
        assert.strictEqual(m.resolveHuggingFacePricing(cat, 'Qwen/Qwen3-8B:cheapest', '', 'together').provider, 'together');
        assert.strictEqual(m.resolveHuggingFacePricing(cat, 'Qwen/Qwen3-8B', 'fastest', ''), null);
        assert.strictEqual(m.resolveHuggingFacePricing(cat, 'Qwen/Qwen3-8B', '', ''), null);
        assert.strictEqual(m.resolveHuggingFacePricing(cat, 'Qwen/Qwen3-8B:hf-inference', '', ''), null);
        assert.strictEqual(m.resolveHuggingFacePricing(cat, 'unknown/model:together', '', ''), null);
        assert.strictEqual(m.computeHuggingFaceCost(usage, null), undefined);
        assert.strictEqual(m.computeHuggingFaceCost({}, p), undefined);
        assert.strictEqual(m.formatHfPricePerM(0.05), '$0.05');
        assert.strictEqual(m.formatHfPricePerM(null), '?');
    }, { tags: ['unit'] });
    test('catalog fetch is cached and failure-tolerant', async function() {
        var calls = 0;
        var m = await _hf(function(url) {
            calls++;
            assert.strictEqual(url, 'https://router.huggingface.co/v1/models');
            return Promise.resolve({ ok: true, json: function() { return Promise.resolve(CATALOG); } });
        });
        var a = await m.fetchHuggingFaceModelCatalog();
        var b = await m.fetchHuggingFaceModelCatalog();
        assert.strictEqual(a.length, 2);
        assert.strictEqual(b, a);
        assert.strictEqual(calls, 1);
        var bad = await _hf(function() { return Promise.resolve({ ok: false, status: 500 }); });
        assert.deepStrictEqual(await bad.fetchHuggingFaceModelCatalog(), []);
    }, { tags: ['unit'] });
});

describe('review fixes (PR #1167)', function() {
    test('PDF file parts become text placeholders; empty content stays valid', async function() {
        var m = await _hf();
        var body = { model: 'a/b', messages: [
            { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'file', file: { filename: 'r.pdf', file_data: 'data:application/pdf;base64,AA' } }] },
            { role: 'user', content: [{ type: 'file', file: {} }] },
            { role: 'assistant', content: [] }] };
        var out = m.adaptRequestBodyForHuggingFace(body, {});
        assert.deepStrictEqual(out.messages[0].content[1], { type: 'text', text: '[PDF attachment "r.pdf" not supported on Hugging Face]' });
        assert.strictEqual(out.messages[1].content[0].type, 'text');
        assert.ok(!JSON.stringify(out).includes('"type":"file"'));
        assert.strictEqual(out.messages[2].content, '');
        assert.strictEqual(body.messages[0].content[1].type, 'file', 'input not mutated');
    }, { tags: ['unit'] });
    test('tools + fastest/none route to the fastest live tool-capable provider', async function() {
        var m = await _hf();
        var cat = m.parseHuggingFaceModelCatalog(CATALOG);
        var tools = [{ type: 'function', function: { name: 'x' } }];
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'Qwen/Qwen3-8B', tools: tools }, {}, cat).model, 'Qwen/Qwen3-8B:together');
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'Qwen/Qwen3-8B', tools: tools }, { provider: 'fastest' }, cat).model, 'Qwen/Qwen3-8B:together');
        // explicit provider / no tools / no catalog → unchanged behaviour
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'Qwen/Qwen3-8B', tools: tools }, { provider: 'novita' }, cat).model, 'Qwen/Qwen3-8B:novita');
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'Qwen/Qwen3-8B' }, { provider: 'fastest' }, cat).model, 'Qwen/Qwen3-8B:fastest');
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'Qwen/Qwen3-8B', tools: tools }, { provider: 'fastest' }, null).model, 'Qwen/Qwen3-8B:fastest');
        // latency fallback when no throughput is reported
        var lat = { providers: [{ provider: 'a', status: 'live', supports_tools: true, throughput: null, first_token_latency_ms: 900 },
            { provider: 'b', status: 'live', supports_tools: true, throughput: null, first_token_latency_ms: 300 },
            { provider: 'c', status: 'error', supports_tools: true, throughput: 999, first_token_latency_ms: 1 }] };
        assert.strictEqual(m.pickHuggingFaceToolProvider(lat).provider, 'b');
        assert.strictEqual(m.pickHuggingFaceToolProvider({ providers: [] }), null);
    }, { tags: ['unit'] });
    test('provider names: slash-free only, unknown dropped when catalog known', async function() {
        var m = await _hf();
        var cat = m.parseHuggingFaceModelCatalog(CATALOG);
        assert.strictEqual(m.sanitizeHuggingFaceProviderName('novita/bf16', null), '');
        assert.strictEqual(m.sanitizeHuggingFaceProviderName('anthropic', cat), '');
        assert.strictEqual(m.sanitizeHuggingFaceProviderName('anthropic', null), 'anthropic');
        assert.strictEqual(m.sanitizeHuggingFaceProviderName(' Cheapest ', cat), 'cheapest');
        assert.strictEqual(m.sanitizeHuggingFaceProviderName('cerebras', cat), 'cerebras');
        assert.strictEqual(m.adaptRequestBodyForHuggingFace({ model: 'a/b' }, { provider: 'novita/bf16' }).model, 'a/b');
    }, { tags: ['unit'] });
    test('catalog failures are negatively cached; cached read is synchronous', async function() {
        var calls = 0;
        var m = await _hf(function() { calls++; return Promise.resolve({ ok: false, status: 503 }); });
        assert.strictEqual(m.getCachedHuggingFaceModelCatalog(), null);
        await m.fetchHuggingFaceModelCatalog();
        await m.fetchHuggingFaceModelCatalog();
        assert.strictEqual(calls, 1, 'second call within 60s served from the negative cache');
        m._hfCatalogCache.failedAt = Date.now() - 61000;
        await m.fetchHuggingFaceModelCatalog();
        assert.strictEqual(calls, 2);
        var ok = await _hf(function() { return Promise.resolve({ ok: true, json: function() { return Promise.resolve(CATALOG); } }); });
        await ok.fetchHuggingFaceModelCatalog();
        assert.strictEqual(ok.getCachedHuggingFaceModelCatalog().length, 2);
    }, { tags: ['unit'] });
    test('streaming: no heartbeat for HF, no blocking catalog wait, no HF referer', async function() {
        var src = await loadFile('src/js/app/010-llm-streaming.js');
        assert.match(src, /if \(!isHuggingFace\) _stampCacheHeartbeat\(chatId, requestBody, currentProvider\);/);
        assert.match(src, /if \(hbIsHF\) \{ delete reg\[chatId\]; return false; \}/);
        assert.match(src, /if \(!hbIsHF\) \{\s*hbHeaders\['HTTP-Referer'\]/);
        assert.ok(src.indexOf('setTimeout(function() { r(null); }, 3000)') < 0, '3s catalog race removed');
        var bg = await loadFile('src/platform/extension/background.js');
        assert.match(bg, /isHuggingFaceEndpoint\(hbProv\.endpoint\)\) \{\s*delete reg\[chatId\];\s*continue;/);
    }, { tags: ['unit'] });
});

describe('wiring', function() {
    test('existing installs get new default endpoints once (deleted ones stay deleted)', async function() {
        var m = await _hf();
        var idb = await loadFile('src/js/core/130-indexeddb.js');
        var fn = _cut(idb, 'function mergeNewDefaultLlmEndpoints(', '\n}\n') + '\n}';
        var merge = new Function('DEFAULT_LLM_ENDPOINTS', fn + '\nreturn mergeNewDefaultLlmEndpoints;')(m.DEFAULT_LLM_ENDPOINTS);
        var list = [{ id: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions' }];
        assert.strictEqual(merge(list, ['openrouter']).length, 1);
        assert.strictEqual(list[1].id, 'huggingface');
        var deleted = [{ id: 'openrouter' }];
        assert.strictEqual(merge(deleted, ['openrouter', 'huggingface']).length, 0);
        var byUrl = [{ id: 'my-hf', url: 'https://router.huggingface.co/v1/chat/completions' }];
        assert.strictEqual(merge(byUrl, ['openrouter']).length, 0);
    }, { tags: ['unit'] });
    test('streaming path applies the adapter and computes HF cost', async function() {
        var src = await loadFile('src/js/app/010-llm-streaming.js');
        assert.match(src, /requestBody = adaptRequestBodyForHuggingFace\(requestBody, provider, getCachedHuggingFaceModelCatalog\(\)\)/);
        assert.ok(src.indexOf('adaptRequestBodyForHuggingFace(requestBody') < src.indexOf('reqMetrics.requestBody = requestBody'));
        assert.match(src, /resolveHuggingFacePricing\(hfCatalog, requestBody\.model, provider\.provider, hfRoutedProvider\)/);
        assert.match(src, /typeof errorData\.error === 'string'/);
        assert.match(src, /delete body\.stream_options;/);
    }, { tags: ['unit'] });
});
