// Run: run_tests { pattern: 'opus-fable-model-tidy' }. Sept 2026 model-list tidy-up:
// Opus 5 + Opus-4-8 retire into Opus 5.5, Fable 5 into Fable 5.1.
// Synthetic fixtures only: real source slices from config / indexeddb, no network.
'use strict';
function _slice(source, start, end) {
    var a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
    return source.slice(a, b);
}
async function _sources() {
    return { cfg: await loadFile('src/js/core/030-config.js'), idb: await loadFile('src/js/core/130-indexeddb.js') };
}
function _config(s) {
    return new Function(_slice(s.cfg, 'var DEFAULT_API_PROVIDERS = [', '// ─── Per-spawn model selection') +
        '\nreturn { defaults: DEFAULT_API_PROVIDERS, renames: PROVIDER_RENAMES, current: currentProvider };')();
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
// The REAL loadTierAliases (+ tier globals).
async function _tierAliases(s, cfg, providers, storedAliases) {
    var body = _slice(s.cfg, '// ─── Per-spawn model selection', '// Persist an updated alias map');
    var getSetting = async function() { return JSON.parse(JSON.stringify(storedAliases)); };
    var fn = new Function('apiProviders', 'getSetting', 'PROVIDER_RENAMES', body + '\nreturn loadTierAliases().then(function() { return { stored: subAgentTierAliases, map: getTierAliasMap() }; });');
    return fn(providers, getSetting, cfg.renames);
}
// The REAL resolveChatProviderName.
function _resolveChat(s, cfg, providers, chats, current) {
    var body = _slice(s.cfg, '// THE per-run provider resolution point', 'var currentChatId = null;');
    var getProviderById = function(n) { return providers.find(function(p) { return p.name === n; }) || null; };
    return new Function('chats', 'getProviderById', 'currentProvider', 'PROVIDER_RENAMES', 'console', body + '\nreturn resolveChatProviderName;')(
        chats, getProviderById, current, cfg.renames, { warn: function() {} });
}
// The REAL applyOpus5DefaultRepoint.
function _repoint(s, cfg, providers, selected, marks) {
    var body = _slice(s.idb, 'var OPUS5_DEFAULT_REPOINT_KEY =', '// API Providers Management');
    var store = Object.assign({ appagent_provider: selected }, marks || {});
    var appStorage = { getItem: function(k) { return store[k] || null; }, setItem: function(k, v) { store[k] = v; } };
    var fn = new Function('apiProviders', 'appStorage', 'PROVIDER_RENAMES', 'currentProvider', body + '\napplyOpus5DefaultRepoint();\nreturn currentProvider;');
    var cur = fn(providers, appStorage, cfg.renames, selected);
    return { stored: store.appagent_provider, current: cur };
}
var EP = 'https://api.anthropic.com/v1/messages';
var OLD = {
    opus5: { name: 'Opus 5', model: 'claude-opus-5', endpoint: EP, apiKey: 'oauth', effort: 'xhigh', isClaudeOAuth: true },
    opus48: { name: 'Opus-4-8', model: 'claude-opus-4-8', endpoint: EP, apiKey: 'oauth', effort: 'xhigh', isClaudeOAuth: true },
    opus48v1: { name: 'Opus-4-8', model: 'claude-opus-4-8', endpoint: EP, apiKey: 'oauth', maxTokens: 100000, context_length: 200000, effort: 'xhigh', isClaudeOAuth: true },
    fable5: { name: 'Fable 5', model: 'claude-fable-5', endpoint: EP, apiKey: 'oauth', effort: 'high', isClaudeOAuth: true },
    orOpus48: { name: 'opus-4.8', apiKey: '', model: 'anthropic/claude-opus-4.8', endpoint: 'https://openrouter.ai/api/v1/chat/completions', context_length: 200000, maxTokens: 64000, effort: 'xhigh' }
};
function _copy(o) { return Object.assign({}, o); }
function _names(list) { return list.map(function(p) { return p.name; }).sort(); }

describe('Model list tidy-up: catalog + defaults', function() {
    test('Opus 5 / Opus-4-8 / Fable 5 removed; Opus 5.5 + Fable 5.1 present; defaults on Opus 5.5', async function() {
        var cfg = _config(await _sources());
        var names = cfg.defaults.map(function(d) { return d.name; });
        var models = cfg.defaults.map(function(d) { return d.model; });
        ['Opus 5', 'Opus-4-8', 'Fable 5'].forEach(function(n) { assert.strictEqual(names.indexOf(n), -1, n); });
        ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5'].forEach(function(m) { assert.strictEqual(models.indexOf(m), -1, m); });
        var byName = {}; cfg.defaults.forEach(function(d) { byName[d.name] = d; });
        assert.strictEqual(byName['Opus 5.5'].model, 'claude-opus-5-5');
        assert.strictEqual(byName['Fable 5.1'].model, 'claude-fable-5-1');
        assert.strictEqual(cfg.current, 'Opus 5.5');
    }, { tags: ['unit'] });
    test('PROVIDER_RENAMES redirects the retired names and every target exists', async function() {
        var cfg = _config(await _sources());
        assert.strictEqual(cfg.renames['Opus 5'], 'Opus 5.5');
        assert.strictEqual(cfg.renames['Opus-4-8'], 'Opus 5.5');
        assert.strictEqual(cfg.renames['Opus-4-8 OAuth'], 'Opus 5.5');
        assert.strictEqual(cfg.renames['opus-4.8'], 'Opus 5.5');
        assert.strictEqual(cfg.renames['Fable 5'], 'Fable 5.1');
        var names = cfg.defaults.map(function(d) { return d.name; });
        Object.keys(cfg.renames).forEach(function(k) { assert.ok(names.indexOf(cfg.renames[k]) >= 0, k + ' -> ' + cfg.renames[k]); });
    }, { tags: ['unit'] });
});

describe('Model list tidy-up: loadApiProviders migration (real block)', function() {
    test('untouched Opus 5 / Opus-4-8 / Fable 5 fold into existing Opus 5.5 / Fable 5.1; selection follows', async function() {
        var s = await _sources(), cfg = _config(s);
        var r = _migrate(s, cfg, [_copy(OLD.opus5), _copy(OLD.opus48), _copy(OLD.fable5), { name: 'Opus 5.5' }, { name: 'Fable 5.1' }], 'Opus 5');
        assert.deepStrictEqual(_names(r.providers), ['Fable 5.1', 'Opus 5.5']);
        assert.strictEqual(r.current, 'Opus 5.5');
        assert.strictEqual(r.stored, 'Opus 5.5');
        assert.strictEqual(r.changed, true);
        var f = _migrate(s, cfg, [_copy(OLD.fable5)], 'Fable 5');
        assert.deepStrictEqual(_names(f.providers), ['Fable 5.1']);
        assert.strictEqual(f.providers[0].model, 'claude-fable-5-1');
        assert.strictEqual(f.stored, 'Fable 5.1');
    }, { tags: ['unit'] });
    test('older Opus-4-8 seed vintage (maxTokens/context_length) migrates too; removed opus-4.8 falls back to Opus 5.5', async function() {
        var s = await _sources(), cfg = _config(s);
        var r = _migrate(s, cfg, [_copy(OLD.opus48v1)], 'Opus-4-8');
        assert.deepStrictEqual(_names(r.providers), ['Opus 5.5']);
        assert.strictEqual(r.providers[0].model, 'claude-opus-5-5');
        assert.strictEqual(r.stored, 'Opus 5.5');
        var d = _migrate(s, cfg, [_copy(OLD.orOpus48)], 'opus-4.8');
        assert.deepStrictEqual(d.providers, []);
        assert.strictEqual(d.stored, 'Opus 5.5');
    }, { tags: ['unit'] });
    test('customized legacy entries are kept; migration is idempotent', async function() {
        var s = await _sources(), cfg = _config(s);
        var tuned = Object.assign(_copy(OLD.opus5), { effort: 'medium' });
        var kept = _migrate(s, cfg, [tuned, { name: 'Opus 5.5' }], 'Opus 5');
        assert.strictEqual(kept.changed, false);
        assert.deepStrictEqual(_names(kept.providers), ['Opus 5', 'Opus 5.5']);
        assert.strictEqual(kept.stored, 'Opus 5');
        var first = _migrate(s, cfg, [_copy(OLD.fable5), _copy(OLD.opus48)], 'Fable 5');
        var again = _migrate(s, cfg, first.providers.map(_copy), first.stored);
        assert.strictEqual(again.changed, false);
        assert.deepStrictEqual(again.providers, first.providers);
    }, { tags: ['unit'] });
});

describe('Model list tidy-up: selections, tiers and chat pins follow the redirect', function() {
    test('tier aliases: renamed when the retired preset is gone, kept when it still exists (#950); default medium = Opus 5.5', async function() {
        var s = await _sources(), cfg = _config(s);
        var gone = await _tierAliases(s, cfg, [{ name: 'Opus 5.5' }, { name: 'Fable 5.1' }], { small: 'Opus-4-8', medium: 'Opus 5', large: 'Fable 5' });
        assert.deepStrictEqual(gone.stored, { small: 'Opus 5.5', medium: 'Opus 5.5', large: 'Fable 5.1' });
        var kept = await _tierAliases(s, cfg, [{ name: 'Fable 5' }, { name: 'Fable 5.1' }], { large: 'Fable 5' });
        assert.strictEqual(kept.stored.large, 'Fable 5');
        var dflt = await _tierAliases(s, cfg, [], {});
        assert.strictEqual(dflt.map.medium, 'Opus 5.5');
    }, { tags: ['unit'] });
    test('resolveChatProviderName: retired pin redirects; surviving customized pin stays; unknown falls back', async function() {
        var s = await _sources(), cfg = _config(s);
        var chats = { a: { provider: 'Opus 5' }, b: { provider: 'Fable 5' }, c: { provider: 'Nope' }, d: { provider: 'Opus-4-8' } };
        var resolve = _resolveChat(s, cfg, [{ name: 'Opus 5.5' }, { name: 'Fable 5.1' }, { name: 'Opus-4-8' }], chats, 'Sonnet 5');
        assert.strictEqual(resolve('a'), 'Opus 5.5');
        assert.strictEqual(resolve('b'), 'Fable 5.1');
        assert.strictEqual(resolve('c'), 'Sonnet 5');
        assert.strictEqual(resolve('d'), 'Opus-4-8');
    }, { tags: ['unit'] });
    test('applyOpus5DefaultRepoint lands on Opus 5.5 and never clobbers a surviving customized Opus-4-8', async function() {
        var s = await _sources(), cfg = _config(s);
        var fresh = _repoint(s, cfg, [{ name: 'Opus 5.5' }], 'Opus-4-8');
        assert.strictEqual(fresh.stored, 'Opus 5.5');
        assert.strictEqual(fresh.current, 'Opus 5.5');
        var alias = _repoint(s, cfg, [{ name: 'Opus 5.5' }], 'Opus-4-8 OAuth', { appagent_opus5_default_repointed: '1' });
        assert.strictEqual(alias.stored, 'Opus 5.5');
        var custom = _repoint(s, cfg, [{ name: 'Opus 5.5' }, { name: 'Opus-4-8' }], 'Opus-4-8');
        assert.strictEqual(custom.stored, 'Opus-4-8');
        var other = _repoint(s, cfg, [{ name: 'Opus 5.5' }, { name: 'Sonnet 5' }], 'Sonnet 5');
        assert.strictEqual(other.stored, 'Sonnet 5');
    }, { tags: ['unit'] });
});
