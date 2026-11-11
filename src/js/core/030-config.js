// ── Global token-budget settings ────────────────────────────────────────
// ONE GLOBAL user-editable value each for max output tokens and reasoning
// budget — set on the Settings page next to Context Window
// (ui/040-tools-settings.js), persisted in the IDB settings store under
// MAX_TOKENS_SETTING_KEY / THINKING_BUDGET_SETTING_KEY, hydrated by
// loadAssumedContextTokens() below (same mechanism + hydration points as
// the assumed context window). Providers carry NO per-provider maxTokens /
// thinkingBudget (pure-global design): the request builder
// (callOpenRouterStreaming in app/010-llm-streaming.js) reads
// getGlobalMaxTokens() / getGlobalThinkingBudget(), which fall back to the
// DEFAULT_* constants below until hydration / when the setting is unset.
// Legacy providers stored in IndexedDB may still carry maxTokens /
// thinkingBudget — those are IGNORED (global wins), except the
// adaptive-only-Claude legacy branch in app/010-llm-streaming.js which
// keys off the RAW stored thinkingBudget to send an explicit default
// effort.
// 64000 = highest safe universal max_tokens: it sits under Gemini 3.8
// Flash's 65,536 completion cap on OpenRouter (verified 2026-10-07 in
// openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints) — endpoints 400-error rather
// than clamp when max_tokens exceeds the model's limit, so the default must
// be under the lowest cap among the default models.
// 32000 = doc-recommended reasoning budget ceiling (batch processing is
// advised above 32k). Ignored by adaptive-only Claude models (Opus 4.7+,
// Sonnet 5+, Fable/Mythos 5) which use `effort` instead — see
// isAdaptiveOnlyClaude below.
// Loaded in BOTH bundles (page core tier + WORKER_SHARED_FILES).
// src/platform/extension/background.js keeps a literal 64000 fallback in
// transformToAnthropic (only as a guard when these globals are missing) —
// keep in sync.
// 128000 = model-aware default for Opus 5.5+ (OPUS_5_5_PLUS_RE below): at
// effort xhigh it thinks far more per turn and 64000 truncates long
// think+tool turns. Sonnet 5.5+ (SONNET_5_5_PLUS_RE) gets the same default —
// its documented output cap is also 128K, so the value never exceeds it. Applied ONLY while the user has not set Max Tokens
// explicitly (globalMaxTokensExplicit) — an explicit value, larger or
// smaller, always wins. See getDefaultMaxTokensForModel / getGlobalMaxTokens.
var DEFAULT_MAX_TOKENS = 64000;
var OPUS_5_5_DEFAULT_MAX_TOKENS = 128000;
var DEFAULT_THINKING_BUDGET = 32000;
var MAX_TOKENS_SETTING_KEY = 'globalMaxTokens';
var THINKING_BUDGET_SETTING_KEY = 'globalThinkingBudget';
var globalMaxTokens = DEFAULT_MAX_TOKENS;
// true once the user stored a Max Tokens value (saveGlobalMaxTokens, or IDB
// hydration in loadAssumedContextTokens found one). Until then the value is
// the built-in default and may be raised per model.
var globalMaxTokensExplicit = false;
var globalThinkingBudget = DEFAULT_THINKING_BUDGET;

// Built-in (non-user) max_tokens default for a model id: 128000 for Opus
// 5.5+, Sonnet 5.5+ and Haiku 5.5+ (documented 128K output cap; thinking
// tokens count toward it), DEFAULT_MAX_TOKENS for everything else.
function getDefaultMaxTokensForModel(model) {
    var m = String(model || '').toLowerCase();
    return (OPUS_5_5_PLUS_RE.test(m) || SONNET_5_5_PLUS_RE.test(m) || HAIKU_5_5_PLUS_RE.test(m))
        ? OPUS_5_5_DEFAULT_MAX_TOKENS
        : DEFAULT_MAX_TOKENS;
}

// THE accessors the request builder reads. Always return a sane positive
// number (default until hydration / on bad input). With a `model`, an
// UNSET setting resolves to the model-aware default (Opus 5.5+ → 128000);
// an explicit user value is returned verbatim. Without a model (Settings UI
// display) it returns the stored/global value as before.
function getGlobalMaxTokens(model) {
    var v = parseInt(globalMaxTokens, 10);
    if (!(isFinite(v) && v > 0)) v = DEFAULT_MAX_TOKENS;
    if (!globalMaxTokensExplicit && model) return getDefaultMaxTokensForModel(model);
    return v;
}
// 0 is a deliberate value here: "thinking OFF" (Settings → Thinking Budget =
// 0). callOpenRouterStreaming (app/010-llm-streaming.js) turns it into
// reasoning:{enabled:false}, which transformToAnthropic / transformToResponses
// (background.js) honour by sending no thinking object. Only an unset /
// unparseable / negative value falls back to the default.
function getGlobalThinkingBudget() {
    var v = parseInt(globalThinkingBudget, 10);
    if (v === 0) return 0;
    return (isFinite(v) && v > 0) ? v : DEFAULT_THINKING_BUDGET;
}
// parseInt that keeps an explicit 0 (thinking off) instead of letting
// `|| DEFAULT` swallow it; anything else that is not a positive finite
// number (NaN, negative, -0) falls back to the default so the stored value is
// always 0 or > 0. Used by saveGlobalThinkingBudget and the IDB hydration in
// loadAssumedContextTokens — the two writers of globalThinkingBudget.
function _parseThinkingBudgetSetting(value) {
    var n = parseInt(value, 10);
    if (n === 0 && !Object.is(n, -0)) return 0;
    return (isFinite(n) && n > 0) ? n : DEFAULT_THINKING_BUDGET;
}

// Persist new values (Settings page onchange handlers in
// ui/040-tools-settings.js). Same settings store as the assumed context
// window below.
async function saveGlobalMaxTokens(value) {
    globalMaxTokens = parseInt(value, 10) || DEFAULT_MAX_TOKENS;
    globalMaxTokensExplicit = true;
    if (typeof setSetting === 'function') {
        await setSetting(MAX_TOKENS_SETTING_KEY, globalMaxTokens);
    }
    return getGlobalMaxTokens();
}
async function saveGlobalThinkingBudget(value) {
    globalThinkingBudget = _parseThinkingBudgetSetting(value);
    if (typeof setSetting === 'function') {
        await setSetting(THINKING_BUDGET_SETTING_KEY, globalThinkingBudget);
    }
    return getGlobalThinkingBudget();
}

// ── Deferred tool loading (experimental) ────────────────────────────────────────
// When ON, each request declares only the CORE tools with full schemas;
// every other enabled tool is listed by name + one-liner in a
// {{TOOL_CATALOG}} system-prompt block and its full schema is fetched on
// demand via the get_tool_schema meta-tool (the schema travels in the
// tool_result / message history, so the request prefix — and provider
// prompt caches — stay stable). Split/catalog helpers live in
// core/080-tools.js (shared). Default OFF: the legacy full-array request
// stays byte-identical.
// Declared here (shared: page core tier + WORKER_SHARED_FILES) like the
// token-budget globals above; hydrated by loadAssumedContextTokens() at
// the same three hydration points, and mirrored into a LIVE SW via the
// 'deferred-tools-setting' port message (worker/130-port-bridge.js +
// pushDeferredToolsSettingToOffscreen in app/045-agent-port-bridge-page.js),
// same pattern as 'hooks-settings'.
var DEFERRED_TOOLS_SETTING_KEY = 'deferredToolsEnabled';
var deferredToolsEnabled = false;

// THE accessor every consumer reads (getEnabledTools twins, catalog
// renderer, deferred-arg validation).
function isDeferredToolsActive() {
    return !!deferredToolsEnabled;
}

// Persist a new value (Settings page toggle in ui/040-tools-settings.js).
async function saveDeferredToolsEnabled(value) {
    deferredToolsEnabled = !!value;
    if (typeof setSetting === 'function') {
        await setSetting(DEFERRED_TOOLS_SETTING_KEY, deferredToolsEnabled);
    }
    return deferredToolsEnabled;
}

// Default API providers (used on first load, then stored in IndexedDB).
// Providers never carry maxTokens / thinkingBudget — the GLOBAL settings
// above (getGlobalMaxTokens / getGlobalThinkingBudget) apply to all.
var DEFAULT_API_PROVIDERS = [
    {
        // GLM 5.3 (OpenRouter added 2026-08-18) replaces the GLM 5.2 default
        // (untouched copies are renamed by loadApiProviders,
        // core/130-indexeddb.js). 1M context. Routing is pinned to
        // first-party Z.AI (provider below): its z-ai/fp8 endpoint allows
        // 131,072 completion tokens (verified 2026-10-07 in
        // openrouter.ai/api/v1/models/z-ai/glm-5.3/endpoints) — the global
        // 64k default is safely under it
        name: 'GLM 5.3',
        model: 'z-ai/glm-5.3',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        provider: 'z-ai'
    },
    {
        // Sonnet 5.5 (Sept 2026) replaces the sonnet-5 OpenRouter default
        // (untouched copies are renamed by loadApiProviders,
        // core/130-indexeddb.js). 1M context, 128K max output, adaptive
        // thinking only — 'disabled' and budget_tokens are 400s, so
        // callOpenRouterStreaming never sends reasoning:{enabled:false} for it
        // (SONNET_5_5_PLUS_RE below). 'high' stays the sane default effort.
        name: 'sonnet-5.5',
        model: 'anthropic/claude-sonnet-5.5',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        effort: 'high'
    },
    {
        // Haiku 5.5 (2026-10-07) on OpenRouter (id verified in
        // openrouter.ai/api/v1/models: 1M context, 128K completion). Option
        // only — not a default/migration target. 'medium' = model default effort.
        name: 'haiku-5.5',
        model: 'anthropic/claude-haiku-5.5',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        effort: 'medium'
    },
    {
        // GPT-6.1 Sol (2026-09-30) replaces the gpt-6-sol OpenRouter default
        // (untouched copies are renamed by loadApiProviders, core/130-indexeddb.js).
        // 1.05M context, 128K max output (OpenRouter + developers.openai.com/
        // api/docs/models/gpt-6.1-sol) — both covered by the global defaults.
        // Effort low|medium|high|xhigh|max only: NO 'none'/'minimal'
        // (isGpt6ReasoningRequiredModel below).
        name: 'gpt-6.1-sol',
        model: 'openai/gpt-6.1-sol',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        effort: 'low'
    },
    {
        // Gemini 3.8 Flash (Stable/GA, OpenRouter added 2026-09-02) replaces
        // the Gemini 3.5 Flash default, now legacy per Google (untouched
        // copies are renamed by loadApiProviders, core/130-indexeddb.js).
        // 1M context. OpenRouter caps its completions at 65,536 tokens on
        // every endpoint (verified 2026-10-07 in
        // openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints) —
        // the global 64k default was chosen to fit under exactly this cap
        name: 'Gemini 3.8 Flash',
        model: 'google/gemini-3.8-flash',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: ''
    },
    {
        // Opus 5.5 (Sept 2026, Claude Code 2.1.280+) — dateless pinned id, 1M
        // context, 128k max output. Adaptive thinking is ALWAYS ON (no
        // 'enabled'/'disabled' shape, default effort medium) and its thinking
        // blocks are conversation-bound like Fable 5.1 — the SW opts it into
        // the thinking-binding-controls + thinking-display-updates betas and
        // the block_binding drop_block opt-out via THINKING_BINDING_RE below.
        // Requires the claude-cli User-Agent spoof to be ≥ 2.1.280 (server-side
        // per-model minimum-version gate — see CLAUDE_CLI_VERSION in
        // background.js). THE default provider (currentProvider and
        // DEFAULT_TIER_ALIASES.medium below) since Sept 2026, when the Opus 5
        // and Opus-4-8 entries were retired (PROVIDER_RENAMES → 'Opus 5.5').
        // Existing installs pick this entry up via the name-keyed default
        // merge in loadApiProviders (core/130-indexeddb.js).
        name: 'Opus 5.5',
        model: 'claude-opus-5-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        // Nov 2026: default effort is medium (the model's own default; xhigh
        // remains selectable). Untouched seeded copies are retuned once by
        // retuneSeedEffortToMedium (core/130-indexeddb.js).
        effort: 'medium',
        isClaudeOAuth: true
    },
    // Sept 2026 tidy-up: the 'Opus 5' (claude-opus-5) and 'Opus-4-8'
    // (claude-opus-4-8) seeds were removed → 'Opus 5.5', and 'Fable 5'
    // (claude-fable-5) → 'Fable 5.1' (Nov 2026: → 'Fable 5.2', see the
    // Fable 5.2 seed below). Untouched copies are migrated by
    // loadApiProviders (core/130-indexeddb.js); stale selections / tier
    // aliases / chat pins follow PROVIDER_RENAMES below.
    {
        // Sonnet 5.5 (Sept 2026) replaces 'Sonnet 5' (claude-sonnet-5) —
        // dateless id, 1M context, 128K max output. Thinking is adaptive-only
        // and conversation-bound (THINKING_BINDING_RE); thinking OFF maps to
        // {type:'between_tools'} (see thinkingOffShapeFor below).
        // Docs: https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5
        name: 'Sonnet 5.5',
        model: 'claude-sonnet-5-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        effort: 'high',
        isClaudeOAuth: true
    },
    {
        // Haiku 5.5 (2026-10-07) — fixed id (no date suffix, no alias), 1M
        // context, 128K max output, adaptive thinking by default (default
        // effort medium). Bound thinking + adaptive-only (HAIKU_5_5_PLUS_RE
        // below). Added as an option only — NOT the default provider and not
        // a migration target for old Haiku entries.
        // Docs: https://platform.claude.com/docs/en/models/haiku-5-5/overview
        name: 'Haiku 5.5',
        model: 'claude-haiku-5-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        effort: 'medium',
        isClaudeOAuth: true
    },
    {
        // Fable 5.2 (2026-11-09) — dateless id (no dated snapshot), 1M
        // context, 128k max output; replaces the 'Fable 5.1' seed (untouched
        // copies migrate via PROVIDER_RENAMES + loadApiProviders in
        // core/130-indexeddb.js). Thinking is always-on adaptive (effort via
        // output_config, default high, same as 5.1); the SW additionally opts
        // this model into the thinking-display-updates +
        // thinking-binding-controls betas and the block_binding drop_block
        // opt-out — see FABLE_5_1_PLUS_RE below (shared with the SW via
        // WORKER_SHARED_FILES). 5.2 enforces the thinking-block prefix check
        // for ALL accounts (a tool-list change counts as an edit), so that
        // opt-out is what keeps replays after a tools/system change from
        // 400ing. Existing installs pick this entry up via the name-keyed
        // default merge in loadApiProviders (core/130-indexeddb.js).
        // Docs: https://platform.claude.com/docs/en/models/fable-5-2/migration-guide
        // Requires Claude Code >= 2.1.290 (claude-cli UA floor CLAUDE_CLI_VERSION
        // in background.js). Default effort medium since Nov 2026 (untouched
        // seeded copies retuned once by retuneSeedEffortToMedium).
        name: 'Fable 5.2',
        model: 'claude-fable-5-2',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        effort: 'medium',
        isClaudeOAuth: true
    },
    // --- ChatGPT subscription (OAuth) ---
    // Routed through the SW adapter runChatGPTOAuthStream, which converts the
    // chat-completions body below into a Codex Responses API request. The
    // endpoint string is informational (the adapter hardcodes the upstream URL)
    // and is kept inline with the provider like every other apiProviders record.
    // Slugs are BARE (no 'openai/' vendor prefix) — the Codex backend rejects a
    // prefixed slug with "The 'openai/...' model is not supported when using
    // Codex with a ChatGPT account". background.js normalises defensively too.
    // These entries seed the generic provider list. The model menu also lists
    // the account's live catalog (GET codex/models?client_version=), which stays
    // authoritative for availability.
    // Sept 22 2026: GPT-6 Sol/Luna replace the GPT-5.6 Sol/Luna seeds and GPT-5.6
    // Terra is dropped (no GPT-6 Terra) — untouched 5.6 copies are migrated by
    // loadApiProviders (core/130-indexeddb.js), mirroring Codex's own
    // gpt-5.6-terra/-sol → gpt-6-sol and gpt-5.6-luna → gpt-6-luna migration.
    // Sept 30 2026: GPT-6.1 Sol supersedes the GPT-6 Sol seed (Codex's model
    // picker lists GPT-6.1-Sol as default, GPT-6-Sol as previous generation).
    {
        name: 'GPT-6 Astra (ChatGPT)',
        model: 'gpt-6-astra',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        apiKey: 'oauth',
        effort: 'high',
        isChatGPTOAuth: true
    },
    {
        name: 'GPT-6.1 Sol (ChatGPT)',
        model: 'gpt-6.1-sol',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        apiKey: 'oauth',
        effort: 'high',
        isChatGPTOAuth: true
    },
    {
        name: 'GPT-6 Luna (ChatGPT)',
        model: 'gpt-6-luna',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        apiKey: 'oauth',
        effort: 'medium',
        isChatGPTOAuth: true
    }
];

// Shared slug predicate; callers scope the capability to ChatGPT subscription.
function isChatGPTAstraModel(model) {
    return String(model || '').trim().replace(/^[A-Za-z0-9_.-]+\//, '') === 'gpt-6-astra';
}
// GPT-6 Sol / Luna (2026-09-22): reasoning.effort none|low|medium(default)|
// high|xhigh|max (developers.openai.com/api/docs/models/gpt-6-sol, gpt-6-luna).
// Exact slugs only — '-pro' variants are not assumed to share the capability.
// gpt-6-sol stays here (still served, "previous generation") for custom entries.
function isChatGPTGpt6SolLunaModel(model) {
    return /^gpt-6-(?:sol|luna)$/.test(String(model || '').trim().replace(/^[A-Za-z0-9_.-]+\//, ''));
}
// GPT-6.1 Sol (2026-09-30): reasoning.effort low|medium(default)|high|xhigh|max;
// 'none' and 'minimal' are NOT supported (developers.openai.com/api/docs/
// models/gpt-6.1-sol). Exact slug only (the '-pro' variant is not assumed).
function isChatGPTGpt61SolModel(model) {
    return String(model || '').trim().replace(/^[A-Za-z0-9_.-]+\//, '') === 'gpt-6.1-sol';
}
// GPT-6 models that cannot turn reasoning off: none/minimal → low, and the
// thinking-off switch must not send none / enabled:false (Astra, GPT-6.1 Sol —
// latest-model guide: "GPT-6 Astra and GPT-6.1 Sol do not support none").
function isGpt6ReasoningRequiredModel(model) {
    return isChatGPTAstraModel(model) || isChatGPTGpt61SolModel(model);
}
// Models whose Codex request keeps xhigh/max as-is (no legacy clamp to high).
function chatGPTSupportsExtendedEffort(model) {
    return isChatGPTAstraModel(model) || isChatGPTGpt61SolModel(model) || isChatGPTGpt6SolLunaModel(model);
}

// API providers (loaded from IndexedDB, initialized with defaults on first load)
// Named LLM endpoints (Settings → LLM Endpoints): { id, name, url, apiKey }.
// Endpoint-backed models reference one via provider.endpointId; the endpoint's
// url/apiKey are snapshotted inline onto the provider at save time so the
// request path keeps reading provider.endpoint / provider.apiKey. Restored
// after PR #824 removed the section (endpoints were inlined into providers).
var DEFAULT_LLM_ENDPOINTS = [
    { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: '' },
    { id: 'huggingface', name: 'Hugging Face', url: 'https://router.huggingface.co/v1/chat/completions', apiKey: '' }
];
var llmEndpoints = [];

function getLlmEndpointById(id) {
    if (!id) return null;
    return llmEndpoints.find(function(ep) { return ep.id === id; }) || null;
}

// ─── Hugging Face Inference Providers (router.huggingface.co) ───
// OpenAI-compatible router: POST /v1/chat/completions (SSE + tools, Bearer
// hf_… token) and a public GET /v1/models catalog listing every inference
// provider per model with live pricing (USD per 1M tokens), context length
// and tool support. Shared by the page and SW bundles (030-config.js is in
// both), so the request adapter, cost math and UI labels use one source.
var HF_ROUTER_BASE = 'https://router.huggingface.co/v1';
var HF_ROUTER_CHAT_URL = HF_ROUTER_BASE + '/chat/completions';
var HF_MODELS_URL = HF_ROUTER_BASE + '/models';
var HF_BILLING_URL = 'https://huggingface.co/settings/billing';
// Router policy suffixes (model:policy); anything else is a provider name.
var HF_ROUTING_POLICIES = ['fastest', 'cheapest', 'preferred'];
var HF_CATALOG_TTL_MS = 10 * 60 * 1000;
// Failures are negatively cached for HF_CATALOG_FAIL_TTL_MS so a down or
// hanging /v1/models never costs every turn a fresh attempt; a hung fetch is
// aborted after HF_CATALOG_FETCH_TIMEOUT_MS so the shared promise settles.
var HF_CATALOG_FAIL_TTL_MS = 60 * 1000;
var HF_CATALOG_FETCH_TIMEOUT_MS = 8000;
var _hfCatalogCache = { at: 0, models: null, promise: null, failedAt: 0 };

// {name} placeholder fill for the English fallback when t()/tn() are absent
// (bare test harnesses evaluate this block alone).
function _hfFill(s, params) {
    return String(s).replace(/\{([A-Za-z0-9_]+)\}/g, function(w, k) {
        return params && params[k] !== undefined && params[k] !== null ? String(params[k]) : w;
    });
}
function _hfT(key, params) { return typeof t === 'function' ? t(key, params) : _hfFill(key, params); }
// Display keys translated via _hfT, registered for the i18n extractor.
var _HF_I18N_KEYS = typeof N_ === 'function' ? [
    N_('{input} in / {output} out per 1M'), N_('from {input} in / {output} out per 1M'),
    N_('pricing n/a'), N_('{size} ctx'), N_('tools ✓'), N_('no tools'),
    N_('Router policy: highest throughput (default)'), N_('Router policy: lowest price'),
    N_('Router policy: lowest price (now {provider})'), N_('Router policy: your preferred-provider order (HF settings)')
] : [];

function isHuggingFaceEndpoint(url) {
    if (!url || typeof url !== 'string') return false;
    var host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
    return host === 'huggingface.co' || /\.huggingface\.co$/.test(host) || host === 'hf.co' || /\.hf\.co$/.test(host);
}

// 'org/model:provider' → { base:'org/model', provider:'provider' }.
function splitHuggingFaceModel(model) {
    var s = String(model || '');
    var i = s.lastIndexOf(':');
    if (i <= 0 || i === s.length - 1 || s.indexOf('/', i) !== -1) return { base: s, provider: '' };
    return { base: s.slice(0, i), provider: s.slice(i + 1) };
}

// Append the provider / routing policy as the model suffix unless the model
// id already carries one (an explicit suffix in the Model ID wins).
function huggingFaceModelWithProvider(model, providerName) {
    var p = String(providerName || '').trim();
    if (!model || !p || splitHuggingFaceModel(model).provider) return model;
    return model + ':' + p;
}

// Map the OpenRouter-shaped body built by callOpenRouterStreaming onto the
// plain OpenAI chat-completions shape the HF router accepts. Returns a new
// object; the input body is not mutated.
// `catalog` (optional, parsed /v1/models — pass the cached copy, never block
// on a fetch) enables provider-name validation and tool-aware routing.
function adaptRequestBodyForHuggingFace(body, provider, catalog) {
    var out = Object.assign({}, body || {});
    // OpenRouter-only fields.
    delete out.usage;
    delete out.transforms;
    delete out.provider;
    delete out.plugins;
    if (out.stream) out.stream_options = { include_usage: true };
    var hasCatalog = Array.isArray(catalog) && catalog.length > 0;
    var entry = hasCatalog ? findHuggingFaceModel(catalog, out.model) : null;
    var explicit = sanitizeHuggingFaceProviderName(provider && provider.provider, hasCatalog ? catalog : null);
    var split = splitHuggingFaceModel(out.model);
    var effective = (split.provider || explicit).toLowerCase();
    // Tool parity: 'fastest' / no provider lets the router pick a provider
    // without tool support while the request carries tools → pin the fastest
    // live tool-capable provider from the catalog instead. No catalog / no
    // candidate → unchanged (router default).
    var toolPick = (Array.isArray(out.tools) && out.tools.length && entry && (!effective || effective === 'fastest'))
        ? pickHuggingFaceToolProvider(entry) : null;
    out.model = toolPick ? split.base + ':' + toolPick.provider : huggingFaceModelWithProvider(out.model, explicit);
    // reasoning:{effort} → reasoning_effort (OpenAI-compatible). Budget-style
    // max_tokens and enabled:false have no router equivalent: dropped, so
    // the model default applies.
    var r = out.reasoning;
    delete out.reasoning;
    if (r && typeof r.effort === 'string' && r.effort) {
        var eff = r.effort.toLowerCase();
        if (eff === 'xhigh' || eff === 'max') eff = 'high';
        out.reasoning_effort = eff;
    }
    if (Array.isArray(out.messages)) {
        out.messages = out.messages.map(function(m) {
            if (!m || typeof m !== 'object') return m;
            var c = m;
            if (c.reasoning_details !== undefined) { c = Object.assign({}, c); delete c.reasoning_details; }
            // OpenRouter's file-parser plugin is dropped above, and plain
            // OpenAI-compatible providers reject type:'file' parts — since they
            // stay in history, every later turn would fail. Replace each with
            // a text placeholder; an emptied content array becomes ''.
            if (Array.isArray(c.content) && c.content.some(function(p) { return p && p.type === 'file'; })) {
                c = Object.assign({}, c, { content: c.content.map(function(p) {
                    if (!p || p.type !== 'file') return p;
                    var f = p.file || {};
                    var name = String(f.filename || f.name || p.filename || 'document.pdf');
                    return { type: 'text', text: '[PDF attachment "' + name + '" not supported on Hugging Face]' };
                }) });
            }
            if (Array.isArray(c.content) && c.content.length === 0) c = Object.assign({}, c, { content: '' });
            if (Array.isArray(c.content) && c.content.some(function(p) { return p && p.cache_control; })) {
                c = Object.assign({}, c, { content: c.content.map(function(p) {
                    if (!p || !p.cache_control) return p;
                    var q = Object.assign({}, p); delete q.cache_control; return q;
                }) });
            }
            return c;
        });
    }
    if (Array.isArray(out.tools)) {
        out.tools = out.tools.map(function(t) {
            if (!t || !t.cache_control) return t;
            var u = Object.assign({}, t); delete u.cache_control; return u;
        });
    }
    return out;
}

// Provider field → HF suffix. Only slash-free names ('novita/bf16' and other
// OpenRouter leftovers are not HF suffixes); with a catalog, names that are
// neither a routing policy nor a known HF provider are dropped ('anthropic').
function sanitizeHuggingFaceProviderName(name, catalog) {
    var p = String(name || '').trim();
    if (!p || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p)) return '';
    var low = p.toLowerCase();
    if (HF_ROUTING_POLICIES.indexOf(low) !== -1) return low;
    if (Array.isArray(catalog) && catalog.length) {
        var known = catalog.some(function(m) {
            return (m.providers || []).some(function(x) { return String(x.provider).toLowerCase() === low; });
        });
        if (!known) return '';
    }
    return p;
}

// Fastest live provider with supports_tools: highest throughput, else lowest
// first-token latency, else the first tool-capable live one. null if none.
function pickHuggingFaceToolProvider(entry) {
    var cands = ((entry && entry.providers) || []).filter(function(p) {
        return p.supports_tools === true && p.status !== 'error' && p.status !== 'offline';
    });
    if (!cands.length) return null;
    var byTp = _hfPickProvider(cands, 'fastest');
    if (byTp) return byTp;
    var best = null;
    cands.forEach(function(p) {
        if (p.first_token_latency_ms === null) return;
        if (!best || p.first_token_latency_ms < best.first_token_latency_ms) best = p;
    });
    return best || cands[0];
}

function _hfNum(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n) && n >= 0) ? n : null;
}

// Normalize the /v1/models payload. Tolerates missing pricing/context_length
// (many providers omit them) and unknown fields.
function parseHuggingFaceModelCatalog(json) {
    var list = (json && Array.isArray(json.data)) ? json.data : (Array.isArray(json) ? json : []);
    return list.filter(function(m) { return m && typeof m.id === 'string' && m.id; }).map(function(m) {
        var providers = (Array.isArray(m.providers) ? m.providers : []).filter(function(p) {
            return p && typeof p.provider === 'string' && p.provider;
        }).map(function(p) {
            var pr = p.pricing || {};
            return {
                provider: p.provider,
                status: p.status || '',
                context_length: _hfNum(p.context_length),
                input: _hfNum(pr.input),
                output: _hfNum(pr.output),
                supports_tools: p.supports_tools === true ? true : (p.supports_tools === false ? false : null),
                supports_structured_output: p.supports_structured_output === true,
                first_token_latency_ms: _hfNum(p.first_token_latency_ms),
                throughput: _hfNum(p.throughput)
            };
        });
        var live = providers.filter(function(p) { return p.status !== 'error' && p.status !== 'offline'; });
        var ctx = providers.reduce(function(a, p) { return p.context_length && p.context_length > a ? p.context_length : a; }, 0);
        return {
            id: m.id,
            providers: providers,
            cheapest: _hfPickProvider(live.length ? live : providers, 'cheapest'),
            fastest: _hfPickProvider(live.length ? live : providers, 'fastest'),
            context_length: ctx || null,
            supports_tools: providers.some(function(p) { return p.supports_tools === true; })
        };
    });
}

function _hfPickProvider(providers, policy) {
    var best = null;
    (providers || []).forEach(function(p) {
        if (policy === 'cheapest') {
            if (p.input === null || p.output === null) return;
            var c = p.input + p.output;
            if (!best || c < best.input + best.output) best = p;
        } else if (policy === 'fastest') {
            if (p.throughput === null) return;
            if (!best || p.throughput > best.throughput) best = p;
        }
    });
    return best;
}

function findHuggingFaceModel(catalog, model) {
    if (!Array.isArray(catalog) || !model) return null;
    var base = splitHuggingFaceModel(model).base.toLowerCase();
    return catalog.find(function(m) { return m.id.toLowerCase() === base; }) || null;
}

// Pricing for the provider that served (or will serve) the request.
// routedProvider (x-inference-provider response header) wins; otherwise the
// model suffix / provider field when it names a provider explicitly. Routing
// policies (fastest/cheapest/preferred) or none without a routed provider →
// null: we never substitute our own guess of which provider served it.
function resolveHuggingFacePricing(catalog, model, providerName, routedProvider) {
    var entry = findHuggingFaceModel(catalog, model);
    if (!entry) return null;
    var name = String(routedProvider || splitHuggingFaceModel(model).provider || providerName || '').trim().toLowerCase();
    if (!name) return null;
    if (HF_ROUTING_POLICIES.indexOf(name) !== -1) return null;
    var p = entry.providers.find(function(x) { return x.provider.toLowerCase() === name; }) || null;
    if (!p || p.input === null || p.output === null) return null;
    return { provider: p.provider, input: p.input, output: p.output };
}

// USD cost from usage + per-1M pricing; undefined when not computable.
// Known gap: cached prompt tokens (usage.prompt_tokens_details.cached_tokens)
// are billed at full input price — the catalog exposes no cached-input rate,
// so any provider-side cache discount is ignored (cost may be overstated).
function computeHuggingFaceCost(usage, pricing) {
    if (!usage || !pricing) return undefined;
    var pin = _hfNum(usage.prompt_tokens !== undefined ? usage.prompt_tokens : usage.input_tokens);
    var pout = _hfNum(usage.completion_tokens !== undefined ? usage.completion_tokens : usage.output_tokens);
    if (pin === null && pout === null) return undefined;
    return ((pin || 0) * pricing.input + (pout || 0) * pricing.output) / 1e6;
}

function formatHfPricePerM(n) {
    if (n === null || n === undefined) return '?';
    return '$' + String(Number(n.toFixed(n < 0.1 ? 3 : 2)));
}

function _hfCtxLabel(n) {
    if (!n) return '';
    return _hfT('{size} ctx', { size: n >= 1000000 ? (Math.round(n / 100000) / 10) + 'M' : Math.round(n / 1000) + 'K' });
}

// Datalist label for one provider of a model.
function huggingFaceProviderLabel(p) {
    var parts = [];
    if (p.input !== null || p.output !== null) parts.push(_hfT('{input} in / {output} out per 1M', { input: formatHfPricePerM(p.input), output: formatHfPricePerM(p.output) }));
    else parts.push(_hfT('pricing n/a'));
    var ctx = _hfCtxLabel(p.context_length);
    if (ctx) parts.push(ctx);
    if (p.supports_tools === true) parts.push(_hfT('tools ✓'));
    else if (p.supports_tools === false) parts.push(_hfT('no tools'));
    if (p.status && p.status !== 'live') parts.push(p.status);
    return parts.join(' · ');
}

// Datalist label for a model: cheapest price, max context, tool support.
function huggingFaceModelLabel(m) {
    var parts = [];
    if (m.cheapest) parts.push(_hfT('from {input} in / {output} out per 1M', { input: formatHfPricePerM(m.cheapest.input), output: formatHfPricePerM(m.cheapest.output) }));
    var ctx = _hfCtxLabel(m.context_length);
    if (ctx) parts.push(ctx);
    if (m.supports_tools) parts.push(_hfT('tools ✓'));
    var n = m.providers.length;
    parts.push(typeof tn === 'function' ? tn(n, '{count} provider', '{count} providers') : (n + (n === 1 ? ' provider' : ' providers')));
    return parts.join(' · ');
}

// Provider-field suggestions for a model: routing policies + each provider.
function huggingFaceProviderOptions(entry) {
    var opts = [
        { value: 'fastest', label: _hfT('Router policy: highest throughput (default)') },
        { value: 'cheapest', label: entry && entry.cheapest ? _hfT('Router policy: lowest price (now {provider})', { provider: entry.cheapest.provider }) : _hfT('Router policy: lowest price') },
        { value: 'preferred', label: _hfT('Router policy: your preferred-provider order (HF settings)') }
    ];
    ((entry && entry.providers) || []).forEach(function(p) {
        opts.push({ value: p.provider, label: huggingFaceProviderLabel(p) });
    });
    return opts;
}

// Synchronous read of the cached catalog (null when none yet) — the request
// path uses this and never awaits the network.
function getCachedHuggingFaceModelCatalog() {
    return (_hfCatalogCache.models && _hfCatalogCache.models.length) ? _hfCatalogCache.models : null;
}

// Cached catalog fetch (public endpoint, no auth). Resolves [] (or the stale
// copy) on failure; failures are negatively cached for HF_CATALOG_FAIL_TTL_MS.
function fetchHuggingFaceModelCatalog(force) {
    var now = Date.now();
    if (!force && _hfCatalogCache.models && now - _hfCatalogCache.at < HF_CATALOG_TTL_MS) return Promise.resolve(_hfCatalogCache.models);
    if (_hfCatalogCache.promise) return _hfCatalogCache.promise;
    if (!force && _hfCatalogCache.failedAt && now - _hfCatalogCache.failedAt < HF_CATALOG_FAIL_TTL_MS) return Promise.resolve(_hfCatalogCache.models || []);
    if (typeof fetch !== 'function') return Promise.resolve(_hfCatalogCache.models || []);
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function() { try { ctrl.abort(); } catch (eA) {} }, HF_CATALOG_FETCH_TIMEOUT_MS) : null;
    _hfCatalogCache.promise = Promise.resolve().then(function() {
        return ctrl ? fetch(HF_MODELS_URL, { signal: ctrl.signal }) : fetch(HF_MODELS_URL);
    }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }).then(function(j) {
        _hfCatalogCache.models = parseHuggingFaceModelCatalog(j);
        _hfCatalogCache.at = Date.now();
        _hfCatalogCache.failedAt = 0;
        return _hfCatalogCache.models;
    }).catch(function(e) {
        console.warn('[HF] model catalog fetch failed:', e && e.message);
        _hfCatalogCache.failedAt = Date.now();
        return _hfCatalogCache.models || [];
    }).then(function(models) {
        if (timer) clearTimeout(timer);
        _hfCatalogCache.promise = null;
        return models;
    });
    return _hfCatalogCache.promise;
}
// ─── end Hugging Face Inference Providers ───

var apiProviders = [];

// Default API provider template for adding new providers (based on haiku45)
var DEFAULT_API_PROVIDER = {
    name: '',
    model: '',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: '',
    // maxTokens / thinkingBudget intentionally absent — the GLOBAL settings
    // (getGlobalMaxTokens / getGlobalThinkingBudget above) apply.
    provider: ''
};

// Adaptive-only Claude models (Opus 4.7+, Opus 5+, Sonnet 5+, Fable 5, Mythos 5) reject
// budget-style thinking (`budget_tokens` → 400 error); the effort parameter is
// the only thinking-depth control. Matches both '.' and '-' version separators,
// dated ids (claude-opus-4-8-20260115), and future versions (opus-5, opus-4.10).
// Loaded in BOTH bundles (page core tier + WORKER_SHARED_FILES), so it is
// visible to callOpenRouterStreaming everywhere. transformToAnthropic in
// src/platform/extension/background.js keeps a related (4.8+ only) regex for
// mid-conversation system support — keep the two in sync when models change.
// Haiku joins at 5.5 (Oct 2026: budget_tokens → 400); Haiku 4.x stays legacy.
var ADAPTIVE_ONLY_CLAUDE_RE = /claude-(?:fable|mythos|opus-(?:[5-9]|\d{2,}|4[.-](?:[7-9]|\d{2,}))|sonnet-(?:[5-9]|\d{2,})|haiku-(?:5[.-](?:[5-9]|[1-9]\d)(?!\d)|[6-9]|\d{2,}))/;
function isAdaptiveOnlyClaude(model) {
    return ADAPTIVE_ONLY_CLAUDE_RE.test(String(model || '').toLowerCase());
}

// Fable 5.1+ / Mythos 5.1+ (Sept 2026; includes Fable 5.2, Nov 2026, which
// enforces the prefix check for all accounts) — the preserved-thinking models. Their
// thinking blocks are bound to the exact system/tools/prior-message prefix AND
// chained to each other across turns: the client must replay EVERY assistant
// thinking block unchanged on every request (including turn-final ones and
// empty ones), because removing a block from the middle of the history
// invalidates every block after it (leading blocks may still be trimmed).
// Matches the dateless pinned ids (claude-fable-5-1) and dated variants
// (claude-fable-5-1-2026MMDD); does NOT match the 5.0 ids (claude-fable-5,
// claude-fable-5-20260501) — the (?!\d) lookahead keeps an 8-digit date
// suffix on a 5.0 id from reading as a minor version (1–2 digit minors only).
// SINGLE SOURCE OF TRUTH — loaded in BOTH bundles (page core tier +
// WORKER_SHARED_FILES; background.js sees it via importScripts('sw-bundle.js')).
// Consumers: getAnthropicBetas + transformToAnthropic
// (src/platform/extension/background.js — beta headers, thinking object).
// buildAPIMessages (app/020-api-messages.js) no longer gates on it: every
// model now replays all completed-turn reasoning_details (the API ignores
// previous-turn thinking on older Claude models, unbilled).
// Docs: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
//       https://platform.claude.com/docs/en/models/fable-5-1/migration-guide
var FABLE_5_1_PLUS_RE = /claude-(?:fable|mythos)-5-[1-9]\d?(?!\d)/;
function isFable51Plus(model) {
    return FABLE_5_1_PLUS_RE.test(String(model || '').toLowerCase());
}

// Opus 5.5+ (Sept 2026) — Opus joins the preserved/bound-thinking family:
// thinking is always-on adaptive ('enabled'/'disabled' → 400), inter-tool-call
// text arrives as thinking blocks (empty at the default display:'omitted'),
// and thinking blocks are bound to the model + the exact prefix, so a replay
// after a system/tools change is a 400 unless the request opts into
// block_binding.prefix_mismatch_behavior:'drop_block' under the
// thinking-binding-controls-2026-08-01 beta. Matches opus-5-5 … opus-5-99,
// opus-6+ and opus-10+, with '.' or '-' separators and dated variants
// (claude-opus-5-5-2026MMDD); does NOT match Opus 5.0 (claude-opus-5,
// claude-opus-5-20260701 — the (?!\d) lookahead keeps an 8-digit date suffix
// from reading as a minor version) or Opus 5.1–5.4.
// Docs: https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5
var OPUS_5_5_PLUS_RE = /claude-opus-(?:5[.-](?:[5-9]|[1-9]\d)(?!\d)|[6-9]|\d{2,})/;
// Every model whose thinking blocks are conversation-bound = Fable/Mythos 5.1+
// OR Opus 5.5+. SINGLE SOURCE OF TRUTH for the SW: getAnthropicBetas adds the
// two thinking betas and transformToAnthropic sends the unconditional
// {type:'adaptive', display:'summarized', block_binding:{drop_block}} thinking
// object for exactly this set (src/platform/extension/background.js).
// Sonnet 5.5+ (Sept 2026) — same bound-thinking family as Opus 5.5 (blocks
// bound to model + conversation prefix; drop_block under the
// thinking-binding-controls-2026-08-01 beta), PLUS two Sonnet-5.5-only API
// changes: (1) thinking:{type:'disabled'} and {type:'enabled',budget_tokens}
// are 400s — the closest "off" is {type:'between_tools'} (no other fields,
// valid only at effort low/medium/high; adaptive at xhigh/max);
// (2) tool_choice 'any' / {type:'tool'} are 400s — only 'auto' is accepted
// (the app only ever sends 'auto'). Same shape as OPUS_5_5_PLUS_RE: matches
// sonnet-5-5 … sonnet-5-99, sonnet-6+, '.' or '-' separators and dated
// variants; does NOT match Sonnet 5.0 (claude-sonnet-5,
// claude-sonnet-5-20260630) or 5.1–5.4, whose behaviour is unchanged.
// Docs: https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5
//       https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
var SONNET_5_5_PLUS_RE = /claude-sonnet-(?:5[.-](?:[5-9]|[1-9]\d)(?!\d)|[6-9]|\d{2,})/;
function isSonnet55Plus(model) {
    return SONNET_5_5_PLUS_RE.test(String(model || '').toLowerCase());
}
// Haiku 5.5+ (2026-10-07) — same bound-thinking family (blocks bound to the
// conversation prefix; drop_block under thinking-binding-controls), adaptive
// thinking on by default (default effort medium), 1M context / 128K output.
// Breaking vs Haiku 4.5: budget_tokens → 400 (adaptive-only), non-default
// temperature/top_p/top_k → 400 (never sent for Claude), assistant prefill →
// 400 (the app never sends one), computer_20250124 → 400 (not used). UNLIKE
// Sonnet 5.5, thinking:{type:'disabled'} IS accepted at effort ≤ high, so
// the thinking-OFF switch maps to 'disabled' (thinkingOffShapeFor below) on
// both the OAuth and OpenRouter paths. Same regex shape as SONNET_5_5_PLUS_RE;
// does NOT match Haiku 4.x (claude-haiku-4-5, claude-haiku-4-5-20251001).
// Docs: https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5
//       https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
var HAIKU_5_5_PLUS_RE = /claude-haiku-(?:5[.-](?:[5-9]|[1-9]\d)(?!\d)|[6-9]|\d{2,})/;
function isHaiku55Plus(model) {
    return HAIKU_5_5_PLUS_RE.test(String(model || '').toLowerCase());
}
// Every model whose thinking blocks are conversation-bound (see above).
var THINKING_BINDING_RE = new RegExp(FABLE_5_1_PLUS_RE.source + '|' + OPUS_5_5_PLUS_RE.source + '|' + SONNET_5_5_PLUS_RE.source + '|' + HAIKU_5_5_PLUS_RE.source);
function isThinkingBindingModel(model) {
    return THINKING_BINDING_RE.test(String(model || '').toLowerCase());
}
// Efforts at which {type:'between_tools'} is accepted (Sonnet 5.5).
var BETWEEN_TOOLS_THINKING_EFFORTS = ['low', 'medium', 'high'];
// The thinking object to send when the user's thinking-OFF switch is on, for
// models with no accepted 'disabled' shape but a between_tools mode (Sonnet
// 5.5+). Returns null for every other model (caller keeps its existing
// behaviour). effort = the request effort, or null for the model default
// (treated as in-range). Used by transformToAnthropic (background.js).
// The xhigh/max → {type:'adaptive'} branch is a DEFENSIVE GUARD: the request
// builder (callOpenRouterStreaming) only sets the off flag when the provider
// has NO effort and then replaces reasoning with exactly {enabled:false}, so
// the app never sends off + xhigh/max today. Kept so a future caller that
// combines them can't produce a between_tools 400.
// Haiku 5.5+: 'disabled' is accepted at the same efforts (≤ high) →
// {type:'disabled'}; xhigh/max → adaptive (same defensive guard).
function thinkingOffShapeFor(model, effort) {
    var haiku = isHaiku55Plus(model);
    if (!haiku && !isSonnet55Plus(model)) return null;
    if (effort && BETWEEN_TOOLS_THINKING_EFFORTS.indexOf(String(effort).toLowerCase()) === -1) {
        return { type: 'adaptive' };
    }
    return haiku ? { type: 'disabled' } : { type: 'between_tools' };
}

// Anthropic prompt-cache policy — ONE place for the breakpoint budget and
// TTLs (shared into the SW bundle; background.js reads it typeof-guarded).
// Docs: platform.claude.com/docs/en/build-with-claude/prompt-caching —
// max 4 explicit breakpoints per request (a 5th is a 400); default TTL 5m
// (writes 1.25x); ttl:'1h' is opt-in, GA (no beta header), writes 2x; when
// mixing, 1h entries must appear BEFORE any 5m entry. Prefix order is
// tools -> system -> messages, so 1h goes only on the stable prefix
// (tools + system: system prompt is frozen per chat — see
// expandSystemPromptPlaceholders, core/110) and messages stay 5m.
// Set ANTHROPIC_STABLE_PREFIX_CACHE_TTL to null to revert to 5m everywhere.
var ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;
var ANTHROPIC_STABLE_PREFIX_CACHE_TTL = '1h';
// kind: 'stable' (tools/system) or 'message'. Fresh object per call.
function anthropicCacheControl(kind) {
    if (kind === 'stable' && ANTHROPIC_STABLE_PREFIX_CACHE_TTL) {
        return { type: 'ephemeral', ttl: ANTHROPIC_STABLE_PREFIX_CACHE_TTL };
    }
    return { type: 'ephemeral' };
}

var currentProvider = 'Opus 5.5'; // Default provider name (must match a provider in DEFAULT_API_PROVIDERS)

// Old default-provider names → their renamed successors (the Opus 4.8
// alignment). Used by loadProviderFromStorage (ui/070-dashboard-ui.js) as a
// fallback when the persisted `appagent_provider` selection still carries a
// legacy name: the SW (whose appStorage shim is inert, getItem → null) can run
// the loadApiProviders() rename migration in core/130-indexeddb.js FIRST, so
// by the time the page loads, the IDB entry is already renamed and that
// migration's localStorage rewrite never fires. KEEP IN SYNC with the
// migration list in core/130-indexeddb.js. Loaded in BOTH bundles
// (page core tier + WORKER_SHARED_FILES).
var PROVIDER_RENAMES = {
    // Removed defaults (July 2026 alignment) fall back to the config default
    // (chain-collapsed straight to 'Opus 5.5': the old 'Opus-4-8' target was
    // retired in Sept 2026)
    'opus-4.6': 'Opus 5.5',
    'opus-4.8': 'Opus 5.5',
    'haiku-4.5': 'Opus 5.5',
    'Proxy': 'Opus 5.5',
    // Sept 2026 tidy-up: Opus 5 / Opus-4-8 retired → Opus 5.5; Fable 5 →
    // Fable 5.1 (chain-collapsed straight to 'Fable 5.2': the 'Fable 5.1'
    // seed was retired in Nov 2026)
    'Opus 5': 'Opus 5.5',
    'Opus-4-8': 'Opus 5.5',
    'Fable 5': 'Fable 5.2',
    // Nov 2026: Fable 5.2 supersedes the Fable 5.1 seed
    'Fable 5.1': 'Fable 5.2',
    // Sept 2026: Sonnet 5 → Sonnet 5.5 (OpenRouter + OAuth seeds)
    'sonnet-5': 'sonnet-5.5',
    'Sonnet 5': 'Sonnet 5.5',
    // Renamed defaults → their July 2026 successors (chain-collapsed straight
    // to Sonnet 5.5: the old Sonnet 5 targets were retired in Sept 2026)
    'sonnet-4.5': 'sonnet-5.5',
    'sonnet-4.6': 'sonnet-5.5',
    // (Kimi K2.5 chain-collapses straight to GLM 5.3: the GLM 5.2 target
    // retired 2026-10-07)
    'Kimi K2.5': 'GLM 5.3',
    // Oct 7 2026: GLM 5.3 / Gemini 3.8 Flash supersede the GLM 5.2 /
    // Gemini 3.5 Flash OpenRouter defaults
    'GLM 5.2': 'GLM 5.3',
    'Gemini 3.5 Flash': 'Gemini 3.8 Flash',
    // (gpt-5.2 / gpt-5.5 / gpt-5.6-sol chain-collapse straight to gpt-6.1-sol:
    // the old gpt-5.5 / gpt-5.6-sol / gpt-6-sol targets no longer exist in the
    // defaults)
    'gpt-5.2': 'gpt-6.1-sol',
    'gpt-5.5': 'gpt-6.1-sol',
    'gpt-5.6-sol': 'gpt-6.1-sol',
    // Sept 30 2026: GPT-6.1 Sol supersedes the gpt-6-sol OpenRouter default
    'gpt-6-sol': 'gpt-6.1-sol',
    'Gemini 3 Flash Preview': 'Gemini 3.8 Flash',
    'Sonnet 4.6 OAuth': 'Sonnet 5.5',
    // July 2026: the ' OAuth' suffix was dropped from the user-facing
    // default names (same providers, friendlier labels)
    'Opus-4-8 OAuth': 'Opus 5.5',
    'Sonnet 5 OAuth': 'Sonnet 5.5',
    // ChatGPT-OAuth seeds: the assumed gpt-5.1* slugs never existed on the
    // Codex backend for ChatGPT accounts
    // (chain-collapsed to GPT-6.1 Sol: the GPT-6 Sol seed retired 2026-09-30)
    'GPT-5.1 Codex': 'GPT-6.1 Sol (ChatGPT)',
    'GPT-5.1': 'GPT-6.1 Sol (ChatGPT)',
    // Sept 2026: GPT-6 Sol/Luna supersede the GPT-5.6 seeds; Terra has no
    // GPT-6 successor and folds into Sol (Codex's own migration target)
    'GPT-5.6 Sol (ChatGPT)': 'GPT-6.1 Sol (ChatGPT)',
    'GPT-5.6 Terra (ChatGPT)': 'GPT-6.1 Sol (ChatGPT)',
    // Sept 30 2026: GPT-6.1 Sol supersedes the GPT-6 Sol seed
    'GPT-6 Sol (ChatGPT)': 'GPT-6.1 Sol (ChatGPT)',
    'GPT-5.6 Luna (ChatGPT)': 'GPT-6 Luna (ChatGPT)'
};

// ─── Per-spawn model selection (Orchestrator §1) ────────────────────
// Tier aliases map the abstract sizes small|medium|large onto provider
// NAMES from `apiProviders`. Overrides are stored in the IDB settings
// store (key: subagentTierAliases) and hydrated into the in-memory
// `subAgentTierAliases` global by loadTierAliases() — spawn-time tier
// resolution must be synchronous, so callers read the cached global and
// fall back to DEFAULT_TIER_ALIASES until hydration completes.
// Loaded in BOTH bundles (page core tier + WORKER_SHARED_FILES).
var SUBAGENT_TIER_NAMES = ['small', 'medium', 'large'];
var TIER_ALIASES_SETTING_KEY = 'subagentTierAliases';
// Special alias value: a tier mapped to TIER_ALIAS_SAME resolves to NO
// concrete provider — spawns through that tier behave exactly like an
// explicit tier:'same' spawn (dynamic follow of the spawning agent's
// current model, re-resolved at EACH LLM call via chats[chatId].same_as /
// resolveChatProviderName). Stored in the same subagentTierAliases map as
// concrete provider names; the sentinel is namespaced so it can never
// collide with a real apiProviders name shown in the pickers. Consumers:
// checkTier in _resolveSpawnProvider (core/097-sub-agent-registry.js) and
// the two tier-picker UIs (ui/040-tools-settings.js renderTierAliasSettings,
// ui/160-notifications.js _tierMenuRowsHtml). Declared BEFORE
// DEFAULT_TIER_ALIASES because the `large` default references it.
var TIER_ALIAS_SAME = '__same__';
// Defaults derived from DEFAULT_API_PROVIDERS: cheapest/fastest → small,
// balanced → medium. Keep names in sync with the DEFAULT_API_PROVIDERS
// entries above when models are renamed. `large` deliberately defaults to
// the "Same" sentinel (follow the spawning agent's current model) rather
// than a hard-coded top model: a concrete default here silently pinned
// every tier:'large' sub to that model even when the user never selected
// it (e.g. 'Fable 5' showing up in runs with a different current model).
// Users who want a specific large model pick it in Settings → Sub-Agent
// Model Tiers.
// NOTE (Oct 2026): 'Haiku 5.5' (built for subagent/routing work) is a
// candidate for `small`, deliberately NOT switched yet — changing it would
// silently move every existing tier:'small' spawn to a new model.
var DEFAULT_TIER_ALIASES = {
    small: 'Sonnet 5.5',
    medium: 'Opus 5.5',
    large: TIER_ALIAS_SAME
};
var subAgentTierAliases = null; // null = not yet hydrated from IDB

// Merged view: stored overrides win, defaults fill the gaps.
function getTierAliasMap() {
    var out = {};
    for (var _ta = 0; _ta < SUBAGENT_TIER_NAMES.length; _ta++) {
        var t = SUBAGENT_TIER_NAMES[_ta];
        out[t] = (subAgentTierAliases && subAgentTierAliases[t]) || DEFAULT_TIER_ALIASES[t];
    }
    return out;
}

// tier → provider name (or the TIER_ALIAS_SAME sentinel when the tier is
// mapped to the "Same" option), or null when the tier is unknown.
function resolveTierAlias(tier) {
    if (!tier) return null;
    var key = String(tier).toLowerCase();
    if (SUBAGENT_TIER_NAMES.indexOf(key) === -1) return null;
    return getTierAliasMap()[key] || null;
}

// TA-7: true while the LAST loadTierAliases read failed. The map is then left
// as it was (null = still unhydrated, so the next call retries), never {} —
// setTierAlias (ui/040) refuses to save over the stored overrides meanwhile.
var subAgentTierAliasesReadFailed = false;

// Hydrate the alias overrides from the IDB settings store. Called from the
// SW port bridge's run-agent gate (so spawn-time resolution sees fresh
// values) and lazily by the settings UI. getSetting lives in
// core/130-indexeddb.js — shared in both bundles, called at runtime only.
async function loadTierAliases() {
    var readDone = false;
    try {
        if (typeof getSetting === 'function') {
            var stored = await getSetting(TIER_ALIASES_SETTING_KEY, null, { strict: true });
            readDone = true;
            subAgentTierAliasesReadFailed = false;
            subAgentTierAliases = (stored && typeof stored === 'object') ? stored : {};
            // Recover stored aliases that still point at RENAMED default
            // provider names (e.g. 'Sonnet 5' → 'Sonnet 5.5') — provider
            // lookups are exact-string, so a stale name would silently break
            // tier resolution after a default rename. Only rename when the
            // old name no longer exists among the configured providers: the
            // IDB migration deliberately KEEPS user-customized legacy presets
            // (e.g. an edited 'GPT-5.6 Terra (ChatGPT)'), and a tier pinned to
            // such a preset must keep pointing at it (same guard as
            // loadProviderFromStorage in ui/070-dashboard-ui.js).
            for (var _tm in subAgentTierAliases) {
                var _tv = subAgentTierAliases[_tm];
                if (_tv && PROVIDER_RENAMES[_tv]
                    && !(apiProviders || []).some(function(p) { return p && p.name === _tv; })) {
                    subAgentTierAliases[_tm] = PROVIDER_RENAMES[_tv];
                }
            }
        } else if (subAgentTierAliases === null) {
            subAgentTierAliases = {};
        }
    } catch (e) {
        // TA-7: a failed read keeps the last good map (a null map stays null so
        // the next call retries); getTierAliasMap still answers the defaults.
        if (!readDone) {
            subAgentTierAliasesReadFailed = true;
            console.warn('loadTierAliases: could not read the stored tier aliases; keeping the current map:', e);
        }
    }
    return getTierAliasMap();
}

// Persist an updated alias map (sparse overrides; getTierAliasMap fills unset tiers from DEFAULT_TIER_ALIASES).
async function saveTierAliases(map) {
    subAgentTierAliases = map || {};
    if (typeof setSetting === 'function') {
        await setSetting(TIER_ALIASES_SETTING_KEY, subAgentTierAliases);
    }
}

// ── Assumed context window ──────────────────────────────────────────────
// EVERY model is measured against the SAME assumed context window —
// deliberately model-independent (the agent never sees model names, so it
// can't reason about real windows, and thresholds stay stable across tier
// escalations). User-editable global setting (Settings → Context Window),
// default 200k tokens. Consumers: the per-tool-result context warnings in
// app/030-agent-loop.js (appendContextNotice), the context ring in
// ui/240-layout.js (updateContextIndicator), the worker-card rings in
// ui/175-sub-agent-ui.js (_subContextLimit), and the saturation gauges in
// core/097-sub-agent-registry.js.
// Loaded in BOTH bundles (page core tier + WORKER_SHARED_FILES); hydrated
// from the IDB settings store by loadAssumedContextTokens() at page boot
// (core/120-init.js), SW boot (worker/190-entry.js) and the SW run-agent
// gate (worker/130-port-bridge.js). Until hydration, the default applies.
var ASSUMED_CONTEXT_TOKENS_DEFAULT = 200000;
var ASSUMED_CONTEXT_SETTING_KEY = 'assumedContextTokens';
var assumedContextTokens = ASSUMED_CONTEXT_TOKENS_DEFAULT;

// THE accessor every consumer reads. Always returns a sane positive number.
function getAssumedContextTokens() {
    var v = parseInt(assumedContextTokens, 10);
    return (isFinite(v) && v > 0) ? v : ASSUMED_CONTEXT_TOKENS_DEFAULT;
}

// Hydrate from the IDB settings store (getSetting lives in
// core/130-indexeddb.js — shared in both bundles, called at runtime only).
// ALSO hydrates the global token-budget settings (globalMaxTokens /
// globalThinkingBudget, declared with the token-budget block above) so
// every existing hydration point — page boot (core/120-init.js), SW boot
// (worker/190-entry.js) and the SW run-agent gate
// (worker/130-port-bridge.js) — picks all three settings up in one call.
async function loadAssumedContextTokens() {
    try {
        if (typeof getSetting === 'function') {
            var stored = await getSetting(ASSUMED_CONTEXT_SETTING_KEY, null);
            if (stored !== null && stored !== undefined && stored !== '') {
                assumedContextTokens = parseInt(stored, 10) || ASSUMED_CONTEXT_TOKENS_DEFAULT;
            }
            var storedMax = await getSetting(MAX_TOKENS_SETTING_KEY, null);
            if (storedMax !== null && storedMax !== undefined && storedMax !== '') {
                globalMaxTokens = parseInt(storedMax, 10) || DEFAULT_MAX_TOKENS;
                globalMaxTokensExplicit = true;
            }
            var storedBudget = await getSetting(THINKING_BUDGET_SETTING_KEY, null);
            if (storedBudget !== null && storedBudget !== undefined && storedBudget !== '') {
                globalThinkingBudget = _parseThinkingBudgetSetting(storedBudget);
            }
            var storedDeferred = await getSetting(DEFERRED_TOOLS_SETTING_KEY, null);
            if (storedDeferred !== null && storedDeferred !== undefined) {
                deferredToolsEnabled = !!storedDeferred;
            }
            // P4 kill-switches (see P4_FLAG_DEFAULTS below). Hydrated here so
            // page boot, SW boot and the SW run-agent gate all pick them up
            // with zero extra call sites. Missing setting → default.
            for (var _p4k in P4_FLAG_DEFAULTS) {
                var _p4v = await getSetting('p4_' + _p4k, null);
                _p4Flags[_p4k] = (_p4v === null || _p4v === undefined) ? P4_FLAG_DEFAULTS[_p4k] : !!_p4v;
            }
        }
    } catch (e) {}
    return getAssumedContextTokens();
}

// Persist a new value (Settings page onchange handler).
async function saveAssumedContextTokens(value) {
    assumedContextTokens = parseInt(value, 10) || ASSUMED_CONTEXT_TOKENS_DEFAULT;
    if (typeof setSetting === 'function') {
        await setSetting(ASSUMED_CONTEXT_SETTING_KEY, assumedContextTokens);
    }
    return getAssumedContextTokens();
}

// THE per-run provider resolution point (Orchestrator §1). A chat stamped
// with `chat.provider` (sub-agents pinned at spawn time) uses that provider;
// everything else falls back to the global `currentProvider` — behavior is
// byte-identical to the old global read when chat.provider is unset. A
// stamped-but-unknown provider (deleted from apiProviders later) logs and
// falls back rather than failing the run.
function resolveChatProviderName(chatId) {
    return _resolveChatProviderNameFollow(chatId, null);
}
// Internal: resolve the effective provider for a chat, following tier:'same'
// dynamic-follow pointers. A sub spawned/woken with tier:'same' pins NO
// provider of its own; instead chats[chatId].same_as points at its spawner's
// chat, and we resolve THAT chat's current provider at call time — so the sub
// tracks the spawner's live model, including later switches / escalations.
// Recurses when the spawner is itself a 'same' sub, with a visited-set cycle
// guard; a missing spawner or a detected cycle falls back to currentProvider.
function _resolveChatProviderNameFollow(chatId, seen) {
    try {
        if (chatId && typeof chats !== 'undefined' && chats[chatId]) {
            var ch = chats[chatId];
            if (ch.same_as) {
                seen = seen || {};
                if (seen[chatId]) {
                    console.warn('[provider] tier:"same" follow cycle at chat ' + chatId + ' — falling back to "' + currentProvider + '"');
                    return currentProvider;
                }
                seen[chatId] = true;
                return _resolveChatProviderNameFollow(ch.same_as, seen);
            }
            if (ch.provider) {
                var pinned = ch.provider;
                if (typeof getProviderById === 'function' && getProviderById(pinned)) return pinned;
                // A pin on a RETIRED default name (e.g. 'Opus 5' → 'Opus 5.5')
                // follows PROVIDER_RENAMES — reached only when the old name no
                // longer exists (a customized legacy preset kept by the IDB
                // migration matched above and stays pinned; #950 semantics).
                var renamed = (typeof PROVIDER_RENAMES !== 'undefined') ? PROVIDER_RENAMES[pinned] : null;
                if (renamed && typeof getProviderById === 'function' && getProviderById(renamed)) return renamed;
                console.warn('[provider] chat ' + chatId + ' pinned to unknown provider "' + pinned + '" — falling back to "' + currentProvider + '"');
            }
        }
    } catch (_) { /* fall through to the global */ }
    return currentProvider;
}

var currentChatId = null;
var chats = {};
var paused = false; // LEGACY: kept for backwards compat with bits that still read it. Do NOT consult in isChatPaused — it would cross-pollute pause across concurrent chats.
var pausedChats = {}; // Per-chat pause flags (for background Action chats the user paused via button)
function isChatPaused(chatId) { return chatId ? pausedChats[chatId] === true : false; }
// ── Chat-meta lane vocabulary (FLUX-4C/T1/P1) — SINGLE SOURCE OF TRUTH ──
// The SW-canonical chat-meta fields: every page writer dispatches them over
// the 'chat-meta-update' lane (dispatchChatMeta, app/045) and the SW arbiter
// persists + rebroadcasts them. Consumed by BOTH realms' put-lane preservers
// (_preserveSwOwnedChatMeta, ui/070-dashboard-ui.js; _preservePageChatFields,
// worker/115-storage.js), the shared fold/eviction paths (core/130-indexeddb.js)
// and the lane plumbing (app/045, worker/130). Declared ONCE here — this file
// loads first in the page core tier AND heads WORKER_SHARED_FILES, so both
// bundles see one declaration (flux audit: layering — the old per-realm twin
// copies in ui/070 + worker/115 drifted-by-construction; the build's
// CHAT_META check now FAILS on any re-declaration outside this file).
//   • TS fields: monotonic timestamps — newest-wins merges.
//   • Flag fields: last-dispatch-wins values arbitrated by the SW.
var CHAT_META_TS_FIELDS = ['lastResponseAt', 'lastActivityAt', 'lastViewedAt', 'updatedAt', 'titleUpdatedAt'];
// pausedSubsOnly (PAUSE-SUBS): rider of pausedByUser — true when the user
// paused an IDLE chat only to stand down its running sub-agents, so Resume
// re-queues those subs WITHOUT starting a run of the chat itself (app/020
// togglePause). Always cleared on unpause by setChatPausedPersistent.
var CHAT_META_FLAG_FIELDS = ['_jobsHidden', 'pinned', '_lastApiError', 'pausedByUser', 'pausedSubsOnly'];
// FLUX-P1 (pause-state single-writer lane): USER-pause facade. pausedByUser
// is a CHAT_META_FLAG_FIELDS entry (last-dispatch-wins, SW-arbitrated,
// persisted + rebroadcast by the chat-meta lane) — this helper is the ONLY
// sanctioned entry for user-pause writes and routes to the realm's lane entry:
//   • page → dispatchChatMeta (app/045): optimistic apply sets
//     chats[id].pausedByUser AND the derived pausedChats cache synchronously,
//     so the loop gate / pause-button reads see the toggle immediately;
//   • SW → _swHandleChatMetaUpdate (worker/130): the 'chat-meta-update'
//     ingress applies, syncs the derived pausedChats/pausedChatIds caches,
//     rehydrate-first persists, and rebroadcasts 'chat-meta-changed'.
// Unpause dispatches an EXPLICIT false (never a field delete): the reconnect
// snapshot encodes undefined flags as null=no-opinion and _swOverlayChatMeta
// only defends flags the SW has an opinion on — a deleted false would let a
// stale panel snapshot resurrect pausedByUser:true on the next adopt.
// The no-op guard keeps high-frequency callers (the run-agent / send-message
// stale-pause clears fire on EVERY send) off the lane when the record and
// this realm's derived caches already agree.
// Lifecycle halts (sub-agent park, action dismiss transients) intentionally
// do NOT use this helper — they are per-realm run-control signals on the
// live pausedChats map only, never persisted (amber paused rows and
// survives-reload pause are user-pause semantics only).
// opts.subsOnly (PAUSE-SUBS, pause only): stamp chat.pausedSubsOnly with the
// pause. Any unpause clears a set pausedSubsOnly in the same dispatch.
function setChatPausedPersistent(chatId, isPaused, opts) {
    if (!chatId) return;
    var v = isPaused === true;
    try {
        var c = (typeof chats !== 'undefined' && chats) ? chats[chatId] : null;
        var fields = { pausedByUser: v };
        if (v && opts && typeof opts.subsOnly === 'boolean') fields.pausedSubsOnly = opts.subsOnly;
        else if (!v && c && c.pausedSubsOnly === true) fields.pausedSubsOnly = false;
        var soDirty = fields.pausedSubsOnly !== undefined && (!c || (c.pausedSubsOnly === true) !== fields.pausedSubsOnly);
        if (!soDirty && (pausedChats[chatId] === true) === v
            && (typeof pausedChatIds === 'undefined' || (pausedChatIds[chatId] === true) === v)
            && (!c || (c.pausedByUser === true) === v)) return;
        if (typeof dispatchChatMeta === 'function') { dispatchChatMeta(chatId, fields); return; }
        if (typeof _swHandleChatMetaUpdate === 'function') { _swHandleChatMetaUpdate(chatId, fields); return; }
        // Defensive dead arm: no lane in this realm (never expected — the page
        // bundle has dispatchChatMeta, the SW bundle has _swHandleChatMetaUpdate).
        // Keep the loop gate correct rather than silently dropping the pause.
        pausedChats[chatId] = v;
    } catch (e) { /* lane dispatch is best-effort */ }
}
var isRunning = false;
// PR390-FU-3: the five per-chat run-state maps below are ALSO declared in
// src/js/worker/000-runtime-globals.js, which executes BEFORE this file in the
// SW bundle (worker 0xx → shared files). A bare `= {}` here re-initializes
// them at SW load — harmless today (load is synchronous, no state exists yet)
// but a wipe-landmine if any earlier-loaded worker file ever stashes state in
// them. Guarded init: reuse the existing object when one is already defined.
var runningChatIds = (typeof runningChatIds !== 'undefined' && runningChatIds) || {}; // Set of chatIds with an active agent loop — supports concurrent background chats
var _runCleanupGuard = {}; // Per-chat: true during the finish/cleanup→hook-rerun window. runningChatIds is briefly cleared there (line ~991) before the auto-title hook's recursive runAgent re-sets it; an await in between (finishActionIfDone) lets a stale panel run-agent observe "not running" and start a SECOND loop, producing interleaved/orphan tool_use blocks. The SW run-agent handler treats a guarded chat as running.
var pendingInjection = null; // User message to inject into the next tool result batch
var pendingInjectionImages = null; // Images/files to inject alongside pendingInjection
var pendingInjectionsByChatId = (typeof pendingInjectionsByChatId !== 'undefined' && pendingInjectionsByChatId) || {}; // Per-chat pending injections: { chatId: { text, images } } (PR390-FU-3 guarded — see runningChatIds)
var currentStreamAbortControllers = (typeof currentStreamAbortControllers !== 'undefined' && currentStreamAbortControllers) || {}; // Per-chat AbortController for the in-flight LLM stream (PR390-FU-3 guarded)
var userInterruptedChats = (typeof userInterruptedChats !== 'undefined' && userInterruptedChats) || {}; // Per-chat: true when user pressed send mid-stream and wants to abort current step (PR390-FU-3 guarded)
var interruptResolversByChatId = (typeof interruptResolversByChatId !== 'undefined' && interruptResolversByChatId) || {}; // Per-chat: function to resolve the in-flight tool's interrupt-race promise instantly (PR390-FU-3 guarded)
var currentStreamingMsgIndex = -1;
var activeStreamingChatId = null; // Track which chat has active streaming (the one the UI is focused on)
function isChatRunning(chatId) { return !!runningChatIds[chatId]; }

// MEMFIX: cap on per-chat versionHistory entries (oldest dropped beyond
// this) — enforced at every append site (trackRecordMutation in
// tools/020-tool-execution.js, addVersionHistoryEntry* in
// ui/090-version-history.js). Both bundles include this file.
var VERSION_HISTORY_CAP = 200;
// LEFT nav rail (chat-list sidebar) collapsed state — toggled by toggleSidebar()
// (ui/240-layout.js), persisted as appStorage key 'sidebarCollapsed'. NOT the
// RIGHT chat/version sidebar — that is versionSidebarManuallyHidden in
// ui/120-ui-utils.js (persisted as 'versionSidebarHidden').
var sidebarCollapsed = false;
var historyExpanded = true; // History section expanded by default
var showApiStats = false; // Hidden by default; user can enable in Settings (persisted via appStorage 'showApiStats')
var lastRequestMetrics = null; // Track token usage and performance
// When the running context (last reported prompt size) crosses this many tokens,
// the agent loop appends a reminder to delegate heavy work to sub-agents
// (model quality degrades at long context). Set to 0 to disable the nudge.
var SUBAGENT_NUDGE_TOKEN_THRESHOLD = 70000;
// P4 kill-switches (fix-all/4-high). Each high-risk fix is gated behind one of
// these flags so it can be turned on/off from Settings without a rebuild.
// Hydrated from the IDB settings store ('p4_<NAME>') by
// loadAssumedContextTokens() — page boot, SW boot and the SW run-agent gate.
// Until hydration, the default (OFF) applies.
var P4_FLAG_DEFAULTS = {
    P4_OFFSCREEN_SELF_HEAL: false,      // #1  offscreen zombie self-heal
    P4_SUB_SATURATION_HARDSTOP: false,  // #3  sub-agent saturation hard-stop / auto-handoff
    P4_BOOT_PLACEHOLDER_SWEEP: false,   // #6a SW boot sweep of stranded tool placeholders
    P4_ACTION_WATCHDOG: false           // #6b action never-started boot re-kick
};
var _p4Flags = Object.assign({}, P4_FLAG_DEFAULTS);
function getP4Flag(name) {
    return _p4Flags[name] === true;
}
// Persist a new value (Settings page toggle in ui/040-tools-settings.js).
async function saveP4Flag(name, value) {
    if (!(name in P4_FLAG_DEFAULTS)) return false;
    _p4Flags[name] = !!value;
    if (typeof setSetting === 'function') {
        await setSetting('p4_' + name, !!value);
    }
    return _p4Flags[name];
}
// background.js is loaded BEFORE the SW bundle, so it reads self.getP4Flag at
// call time (typeof-guarded) rather than referencing the bundle global.
if (typeof self !== 'undefined') { self.getP4Flag = getP4Flag; }
// After a nudge fires, it re-arms once the context has grown this many tokens
// PAST the size at which the last nudge fired (appended as a fresh trailing
// context message — never mutates history, so the prompt cache stays intact).
// Set to 0 to restore the old one-shot behavior.
var SUBAGENT_NUDGE_REARM_TOKENS = 50000;
// Progress-card nudge: when the current user turn has accumulated this many
// tool calls with NO update_action_state among them, the agent loop rides a
// one-line context reminder along with the next scheduled LLM call (no extra
// endpoint round trip — see 030-agent-loop.js). Set to 0 to disable.
var PROGRESS_NUDGE_TOOL_CALLS = 5;
// After a progress nudge fires, it re-arms after this many FURTHER tool calls
// if the model still has not created a progress card. Set to 0 for one-shot.
var PROGRESS_NUDGE_REARM_CALLS = 25;
var currentIframeUrl = '/'; // Track last browser tab URL for AI context
var settingsPanelOpen = false; // Track settings panel state
var llmConnectionStatus = 'unknown'; // 'connected', 'disconnected', 'unknown'
var toolPermissions = {}; // Global (non-instance) tool permissions: 'allow', 'auto', 'ask', 'disabled'
var instancePermissions = {}; // Per-instance permissions: { 'host': { tier: 'manual'|'auto'|'dev', tools: { key: 'allow'|'auto'|'ask'|'disabled' } } }. 'dev' = every instance-scoped tool call resolves 'allow' (no prompts, confirm:true ignored, per-tool settings ignored).
var cacheTokenLimit = 4000; // Cache limit in tokens (default ~4k tokens = ~16KB)
var sessionPermissions = {}; // "Allow for this chat" grants keyed by rootChatId + '::' + permKey (core/070 chatPermKey); SW-owned, mirrored to chrome.storage.session
var pendingToolApprovals = {}; // Track pending tool approval requests by chatId:approvalIndex
var cachedUserSysId = null; // Cache user sys_id to avoid repeated API calls
var impersonateOriginalUserSysId = null; // Store original user sys_id before impersonation
var versionHistory = []; // Track all record changes with before/after versions
var chatSearchQuery = ''; // Track chat search query
var activeSkills = {}; // Track active skills with their XML backups: { skillId: { xmlBackups: { table_sysId: versionSysId } } }
var skillAssetsStoreName = 'skillAssets'; // IndexedDB store for skill assets
var chatWidgets = {}; // Track widgets per chat: { chatId: [{ id, title, html, height, width, createdAt, msgIndex }] }
var streamingDisplayLen = {}; // Buffered display length keyed by chatId+':'+msgIndex (B1: per-chat to avoid cross-chat index collisions during concurrent streaming)
var STREAM_CHARS_PER_TICK = 40; // Base chars revealed per 50ms tick (~800 chars/sec readable pace)
var lastLargeResponse = null; // DEPRECATED: retained only for back-compat (always null now); superseded by lastLargeResponseByChatId
var lastLargeResponseByChatId = {}; // CONC-FIX: last large skill-tool response keyed by chatId, so two chats running concurrently don't overwrite each other's js_eval data (mirrors the streamingDisplayLen per-chat pattern above). Read into the js_eval sandbox global `lastLargeResponse` per owning chat.
var LAST_LARGE_RESPONSE_MAX_CHATS = 50; // LEAK-FIX: cap distinct-chat slots. The replaced single global was self-bounding (one slot, overwrite-in-place); the per-chat map otherwise grows one full untruncated response per chat for the whole bundle lifetime. Oldest-inserted slot is evicted past the cap.
// Bounded setter for lastLargeResponseByChatId. Overwrites in place for an
// existing chat; when adding a NEW chat key past the cap, evicts the
// oldest-inserted entry (string keys preserve insertion order, so
// Object.keys()[0] is the oldest). Defined in the shared bundle so BOTH the
// page realm and the service-worker realm (where headless sub-agents
// accumulate slots) self-prune. Falsy chatId is a no-op, matching the
// `if (chatId)` guards at the call sites.
function setLastLargeResponse(chatId, value) {
    if (!chatId) return;
    if (!Object.prototype.hasOwnProperty.call(lastLargeResponseByChatId, chatId)) {
        var llrKeys = Object.keys(lastLargeResponseByChatId);
        if (llrKeys.length >= LAST_LARGE_RESPONSE_MAX_CHATS) {
            delete lastLargeResponseByChatId[llrKeys[0]];
        }
    }
    lastLargeResponseByChatId[chatId] = value;
}
var compactToolCalls = true; // Display option: collapse all tool calls in one area
var screenshotMethod = 'html-to-image'; // Screenshot method: 'html-to-image' or 'display-media'
var appTheme = 'system'; // Theme: 'light', 'dark', or 'system' (follows OS preference)
var compactAreaExpandedState = {}; // Track expanded state of compact tool areas during streaming, keyed by chatId+':'+msgIndex (B2)
var userMsgExpandedState = {}; // Track expanded state of cached (long) user messages, keyed by chatId+':'+msgIndex (B2)
var thinkingExpandedState = {}; // Track expanded state of thinking sections during streaming, keyed by chatId+':'+msgIdx+'-'+tlIdx (B2)
var lastApiError = null; // Track last API error for retry functionality
var pendingImageAttachments = []; // Track images to attach to the next message: [{ base64, name, width, height }]
var _screenshotIdCounter = 0; // Auto-increment counter for screenshot IDs
var chatPendingImages = {}; // Per-chat/view pending images: { chatId|'home': [{ base64, name, width, height }] }
var chatPendingTexts = {}; // Per-chat/view pending input text: { chatId|'home': 'text' }
var isHandlingPopState = false; // Track if we're handling a popstate event (to avoid pushing duplicate state)
var isInitialLoad = true; // Track if we're in initial page load (use replaceState instead of pushState)
