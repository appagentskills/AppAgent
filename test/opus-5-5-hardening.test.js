// Run: run_tests { pattern: 'opus-5-5-hardening' } (js_eval sandbox; no Node).
// Opus 5.5 hardening: fix 3 (model-aware max_tokens default), fix 4 (version-
// gate retry keeps its attempt + never re-reads a consumed body), fix 6
// (OpenRouter off switch not sent for thinking-bound models). Evaluates the
// REAL source slices; no network.
'use strict';

function _cut(source, start, end) {
    var a = source.indexOf(start);
    if (a < 0) throw new Error('Source extraction failed (start): ' + start);
    var b = source.indexOf(end, a + start.length);
    if (b < 0) throw new Error('Source extraction failed (end): ' + end);
    return source.slice(a, b);
}

async function loadMaxTokensModule() {
    var cfg = await loadFile('src/js/core/030-config.js');
    var regexes = _cut(cfg, 'var ADAPTIVE_ONLY_CLAUDE_RE', 'var currentProvider = ');
    var accessors = _cut(cfg, 'var DEFAULT_MAX_TOKENS', '// Persist new values');
    var save = _cut(cfg, 'async function saveGlobalMaxTokens', 'async function saveGlobalThinkingBudget');
    return new Function(regexes + accessors + save +
        '\nreturn { get: getGlobalMaxTokens, def: getDefaultMaxTokensForModel, save: saveGlobalMaxTokens, isBinding: isThinkingBindingModel, hydrate: function(v) { globalMaxTokens = parseInt(v, 10) || DEFAULT_MAX_TOKENS; globalMaxTokensExplicit = true; } };'
    )();
}

describe('fix 3: model-aware max_tokens default', function() {
    test('unset setting: Opus 5.5+ gets 128000, everything else 64000', async function() {
        var m = await loadMaxTokensModule();
        assert.strictEqual(m.get('anthropic/claude-opus-5-5'), 128000);
        assert.strictEqual(m.get('claude-opus-5-5-20260915'), 128000);
        assert.strictEqual(m.get('claude-opus-6'), 128000);
        assert.strictEqual(m.get('anthropic/claude-opus-5'), 64000);
        assert.strictEqual(m.get('claude-opus-5-20260701'), 64000);
        assert.strictEqual(m.get('claude-fable-5-1'), 64000);
        assert.strictEqual(m.get('openai/gpt-5.5'), 64000);
        assert.strictEqual(m.get(), 64000, 'no model (Settings display) stays the global default');
        assert.strictEqual(m.def('claude-opus-5.5'), 128000);
        assert.strictEqual(m.def(null), 64000);
    }, { tags: ['unit'], timeout: 5000 });

    test('explicit user value (saved or hydrated), larger or smaller, is respected verbatim', async function() {
        var m = await loadMaxTokensModule();
        await m.save(32000);
        assert.strictEqual(m.get('claude-opus-5-5'), 32000);
        await m.save(64000);
        assert.strictEqual(m.get('claude-opus-5-5'), 64000, 'explicit 64000 is not raised');
        var h = await loadMaxTokensModule();
        h.hydrate('150000');
        assert.strictEqual(h.get('claude-opus-5-5'), 150000);
        assert.strictEqual(h.get('openai/gpt-5.5'), 150000);
    }, { tags: ['unit'], timeout: 5000 });

    test('hydration marks the value explicit (source guard)', async function() {
        var cfg = await loadFile('src/js/core/030-config.js');
        var load = _cut(cfg, 'var storedMax = await getSetting(MAX_TOKENS_SETTING_KEY', 'var storedBudget');
        assert.ok(/globalMaxTokensExplicit = true/.test(load), 'loadAssumedContextTokens must set globalMaxTokensExplicit');
    }, { tags: ['unit'], timeout: 5000 });
});

// ── fix 6: app/010-llm-streaming.js request builder ──
async function captureRequest(model, budget, providerExtra) {
    var mt = await loadMaxTokensModule();
    var sent = null;
    var m = await loadModules(['src/js/app/010-llm-streaming.js'], { lenient: true, globals: {
        getProviderById: function() { return Object.assign({ model: model, endpoint: 'https://example.test/v1', apiKey: 'k' }, providerExtra || {}); },
        lastRequestMetrics: {}, getSystemPromptWithContext: function() { return 'sys'; }, getEnabledTools: function() { return []; },
        getGlobalMaxTokens: mt.get, getGlobalThinkingBudget: function() { return budget; },
        isAdaptiveOnlyClaude: function() { return true; }, isThinkingBindingModel: mt.isBinding,
        setLLMConnectionStatus: function() {}, updateModelDisplayWithProvider: function() {},
        Platform: { getReferer: function() { return 'r'; } }, console: { error: function() {}, warn: function() {}, log: function() {} },
        fetch: function(url, opts) {
            sent = JSON.parse(opts.body);
            var done = false;
            return Promise.resolve({ ok: true, status: 200, body: { getReader: function() { return { read: function() {
                if (done) return Promise.resolve({ done: true, value: undefined });
                done = true; return Promise.resolve({ done: false, value: new TextEncoder().encode('data: [DONE]\n') });
            } }; } } });
        }
    } });
    function noop() {}
    await m.callOpenRouterStreaming('p', [{ role: 'user', content: 'q' }], noop, noop, noop, noop, null, null, 'c1', {});
    assert.ok(sent, 'request was sent');
    return sent;
}

describe('fix 6: OpenRouter thinking-off switch vs thinking-bound models', function() {
    test('budget 0 on Opus 5.5 / Fable 5.1: no reasoning.enabled:false', async function() {
        var o55 = await captureRequest('anthropic/claude-opus-5-5', 0);
        assert.ok(!o55.reasoning || o55.reasoning.enabled !== false, 'Opus 5.5 must not get enabled:false: ' + JSON.stringify(o55.reasoning));
        assert.strictEqual(o55.max_tokens, 128000, 'Opus 5.5 unset max_tokens → 128000');
        var f51 = await captureRequest('anthropic/claude-fable-5-1', 0);
        assert.ok(!f51.reasoning || f51.reasoning.enabled !== false);
    }, { tags: ['unit'], timeout: 10000 });

    test('budget 0 on a non-bound model still sends the off switch', async function() {
        var o5 = await captureRequest('anthropic/claude-opus-5', 0);
        assert.deepStrictEqual(o5.reasoning, { enabled: false });
        assert.strictEqual(o5.max_tokens, 64000);
    }, { tags: ['unit'], timeout: 10000 });

    test('thinking off + legacy stored thinkingBudget: no injected effort:high', async function() {
        var o55 = await captureRequest('anthropic/claude-opus-5-5', 0, { thinkingBudget: 16000 });
        assert.strictEqual(o55.reasoning, undefined, 'binding model, thinking off → no reasoning at all: ' + JSON.stringify(o55.reasoning));
        var o5 = await captureRequest('anthropic/claude-opus-5', 0, { thinkingBudget: 16000 });
        assert.deepStrictEqual(o5.reasoning, { enabled: false }, 'non-binding model unchanged');
        // Thinking ON keeps the legacy default-effort behaviour.
        var on = await captureRequest('anthropic/claude-opus-5-5', 8000, { thinkingBudget: 16000 });
        assert.deepStrictEqual(on.reasoning, { effort: 'high' });
    }, { tags: ['unit'], timeout: 10000 });
});

// ── fix 4: background.js runClaudeOAuthStream retry accounting ──
function fakeRes(status, body) {
    var reads = 0;
    return {
        status: status, ok: status >= 200 && status < 300,
        headers: { get: function() { return null; }, forEach: function() {} },
        text: function() {
            reads++;
            if (reads > 1) return Promise.reject(new TypeError('body stream already read'));
            return Promise.resolve(body);
        },
        reads: function() { return reads; }
    };
}

async function loadOAuthStream(responses) {
    var bg = await loadFile('src/platform/extension/background.js');
    var fn = _cut(bg, 'async function runClaudeOAuthStream(', 'chrome.runtime.onConnect.addListener(function(port) {');
    var calls = 0, bumps = 0;
    var deps = {
        chrome: { storage: { local: { get: async function() { return { claudeOAuth: { accessToken: 't', expiresAt: Date.now() + 3600000 } }; } } } },
        fetch: async function() { var r = responses[calls++]; if (!r) throw new Error('unexpected extra fetch #' + calls); return r; },
        renewClaudeToken: async function(o) { return o; },
        transformToAnthropic: function(b) { return { model: b.model }; },
        getAnthropicBetas: function() { return ''; },
        parseRequiredClaudeCliVersion: function(t) { var mm = /version (\d+\.\d+\.\d+) or newer/.exec(t || ''); return mm ? mm[1] : null; },
        bumpClaudeCliVersion: async function() { bumps++; return true; },
        _claudeStreams: { active: 0, waiters: [] }, _claudeStreamEnded: function() {},
        _waitForFreeStreamSlot: async function() {}, _claudeAbortableDelay: async function() {},
        detectUsageExhaustion: function() { return null; }, refreshClaudeOrgUsage: async function() { return {}; },
        formatResetDelta: function() { return ''; }, conciseApiErrorBody: function(t) { return String(t); },
        console: { warn: function() {}, error: function() {}, log: function() {} }
    };
    var names = Object.keys(deps);
    var run = new Function(names.join(','), fn + '\nreturn runClaudeOAuthStream;').apply(null, names.map(function(k) { return deps[k]; }));
    return { run: run, calls: function() { return calls; }, bumps: function() { return bumps; } };
}

var GATE = JSON.stringify({ error: { error_code: 'claude_code_version_too_old', message: 'version 2.1.300 or newer is required.' } });

describe('fix 4: version-gate retry does not burn an attempt', function() {
    test('3x429 then gate-400 on the LAST attempt still retries; the new failure surfaces its OWN body', async function() {
        var rs = [fakeRes(429, 'rate 1'), fakeRes(429, 'rate 2'), fakeRes(429, 'rate 3'), fakeRes(400, GATE), fakeRes(500, 'server boom')];
        var m = await loadOAuthStream(rs);
        var out = [];
        await m.run({ model: 'claude-opus-5-5' }, function(e) { out.push(e); }, null);
        assert.strictEqual(m.bumps(), 1);
        assert.strictEqual(m.calls(), 5, 'the bumped retry must still be sent after 3 backoffs');
        var err = out.filter(function(e) { return e.type === 'error'; });
        assert.strictEqual(err.length, 1, JSON.stringify(out));
        assert.strictEqual(err[0].error, 'API error 500: server boom', 'no stale 429 body, no double read');
        rs.forEach(function(r, i) { assert.ok(r.reads() <= 1, 'response #' + i + ' body read ' + r.reads() + 'x'); });
    }, { tags: ['unit'], timeout: 10000 });

    test('a second gate-400 is not retried again (triedCliVersionBump) and surfaces its body', async function() {
        var rs = [fakeRes(400, GATE), fakeRes(400, GATE)];
        var m = await loadOAuthStream(rs);
        var out = [];
        await m.run({ model: 'claude-opus-5-5' }, function(e) { out.push(e); }, null);
        assert.strictEqual(m.bumps(), 1);
        assert.strictEqual(m.calls(), 2);
        var err = out.filter(function(e) { return e.type === 'error'; });
        assert.strictEqual(err.length, 1);
        assert.ok(/^API error 400: /.test(err[0].error) && /2\.1\.300/.test(err[0].error), err[0].error);
        rs.forEach(function(r, i) { assert.ok(r.reads() <= 1, 'response #' + i + ' body read ' + r.reads() + 'x'); });
    }, { tags: ['unit'], timeout: 10000 });
});
