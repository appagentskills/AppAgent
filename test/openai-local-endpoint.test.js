// Run: run_tests { pattern: 'openai-local-endpoint' }. Built-in local
// OpenAI-compatible endpoint + bare-base URL completion (core/030-config.js),
// wired at save time (ui/040) and request time (app/010). Real source slices.
'use strict';
function _cut(src, start, end) {
    var a = src.indexOf(start), b = src.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
    return src.slice(a, b);
}
async function _cfg() {
    var cfg = await loadFile('src/js/core/030-config.js');
    var seed = _cut(cfg, 'var DEFAULT_LLM_ENDPOINTS = [', 'function getLlmEndpointById(');
    return new Function(seed + '\nreturn { DEFAULT_LLM_ENDPOINTS: DEFAULT_LLM_ENDPOINTS, complete: completeOpenAIChatUrl };')();
}
describe('local OpenAI-compatible default endpoint', function() {
    test('seeds Local at /v1/chat/completions (not /api/v1)', async function() {
        var m = await _cfg();
        var local = m.DEFAULT_LLM_ENDPOINTS.find(function(e) { return e.id === 'local'; });
        assert.strictEqual(local.url, 'http://localhost:1234/v1/chat/completions');
        assert.strictEqual(m.DEFAULT_LLM_ENDPOINTS[0].id, 'openrouter', 'local is never first / auto-picked');
    }, { tags: ['unit'] });
    test('completes bare bases and leaves full or hosted URLs alone', async function() {
        var c = (await _cfg()).complete;
        var cases = {
            'http://192.168.1.17:1234': 'http://192.168.1.17:1234/v1/chat/completions',
            'http://192.168.1.17:1234/': 'http://192.168.1.17:1234/v1/chat/completions',
            'http://localhost:11434/v1': 'http://localhost:11434/v1/chat/completions',
            'http://localhost:11434/v1/': 'http://localhost:11434/v1/chat/completions',
            'localhost:1234': 'http://localhost:1234/v1/chat/completions',
            '10.0.0.5:8080/v1': 'http://10.0.0.5:8080/v1/chat/completions',
            'https://api.openai.com': 'https://api.openai.com/v1/chat/completions',
            'http://localhost:1234/v1/chat/completions': 'http://localhost:1234/v1/chat/completions',
            'http://localhost:8000/api/v1/chat/completions': 'http://localhost:8000/api/v1/chat/completions',
            'https://openrouter.ai/api/v1': 'https://openrouter.ai/api/v1',
            'https://router.huggingface.co/v1': 'https://router.huggingface.co/v1',
            'https://chatgpt.com/backend-api/codex/responses': 'https://chatgpt.com/backend-api/codex/responses',
            'https://api.anthropic.com/v1': 'https://api.anthropic.com/v1',
            'https://x.example/v1/responses': 'https://x.example/v1/responses',
            'http://localhost:1234/v1?x=1': 'http://localhost:1234/v1?x=1',
            'not a url': 'not a url',
            '': ''
        };
        Object.keys(cases).forEach(function(k) { assert.strictEqual(c(k), cases[k], k); });
    }, { tags: ['unit'] });
    test('wired at save time, request time and in the field hint', async function() {
        var ui = await loadFile('src/js/ui/040-tools-settings.js');
        var save = _cut(ui, 'async function saveLlmEndpointFromModal(', 'var nameClash');
        assert.ok(/url = completeOpenAIChatUrl\(url\)/.test(save));
        assert.ok(ui.indexOf('llm-endpoint-url-resolved') >= 0 && ui.indexOf("t('Requests go to: {url}'") >= 0);
        var st = await loadFile('src/js/app/010-llm-streaming.js');
        assert.ok(st.indexOf('fetch(provider.endpoint') < 0, 'every request goes through _llmRequestUrl');
        var fn = _cut(st, 'function _llmRequestUrl(', '\n}\n') + '\n}';
        var r = new Function('completeOpenAIChatUrl', fn + '\nreturn _llmRequestUrl;')(function(u) { return u + '#done'; });
        assert.strictEqual(r({ endpoint: 'http://h:1' }), 'http://h:1#done');
        assert.strictEqual(r({ endpoint: 'x', isChatGPTOAuth: true }), 'x');
        assert.strictEqual(r({ endpoint: 'x', isClaudeOAuth: true }), 'x');
    }, { tags: ['unit'] });
});
