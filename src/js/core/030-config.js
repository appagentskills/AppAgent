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
// 64000 = highest safe universal max_tokens: it sits under Gemini 3.5
// Flash's 65,536 completion cap on OpenRouter — endpoints 400-error rather
// than clamp when max_tokens exceeds the model's limit, so the default must
// be under the lowest cap among the default models.
// 32000 = doc-recommended reasoning budget ceiling (batch processing is
// advised above 32k). Ignored by adaptive-only Claude models (Opus 4.7+,
// Sonnet 5+, Fable/Mythos 5) which use `effort` instead — see
// isAdaptiveOnlyClaude below.
// Loaded in BOTH bundles (page core tier + WORKER_SHARED_FILES).
// src/platform/extension/background.js keeps a literal 64000 fallback in
// transformToAnthropic (it can't see these globals) — keep in sync.
var DEFAULT_MAX_TOKENS = 64000;
var DEFAULT_THINKING_BUDGET = 32000;
var MAX_TOKENS_SETTING_KEY = 'globalMaxTokens';
var THINKING_BUDGET_SETTING_KEY = 'globalThinkingBudget';
var globalMaxTokens = DEFAULT_MAX_TOKENS;
var globalThinkingBudget = DEFAULT_THINKING_BUDGET;

// THE accessors the request builder reads. Always return a sane positive
// number (default until hydration / on bad input).
function getGlobalMaxTokens() {
    var v = parseInt(globalMaxTokens, 10);
    return (isFinite(v) && v > 0) ? v : DEFAULT_MAX_TOKENS;
}
function getGlobalThinkingBudget() {
    var v = parseInt(globalThinkingBudget, 10);
    return (isFinite(v) && v > 0) ? v : DEFAULT_THINKING_BUDGET;
}

// Persist new values (Settings page onchange handlers in
// ui/040-tools-settings.js). Same settings store as the assumed context
// window below.
async function saveGlobalMaxTokens(value) {
    globalMaxTokens = parseInt(value, 10) || DEFAULT_MAX_TOKENS;
    if (typeof setSetting === 'function') {
        await setSetting(MAX_TOKENS_SETTING_KEY, globalMaxTokens);
    }
    return getGlobalMaxTokens();
}
async function saveGlobalThinkingBudget(value) {
    globalThinkingBudget = parseInt(value, 10) || DEFAULT_THINKING_BUDGET;
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
        name: 'GLM 5.2',
        model: 'z-ai/glm-5.2',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        // Routing is pinned to first-party Z.AI (provider below), whose
        // endpoint allows 131,072 completion tokens — the global 64k default
        // is safely under it
        provider: 'z-ai'
    },
    {
        // Sonnet 5 (2026-06-30) is adaptive-thinking-only like Opus 4.7+:
        // effort replaces thinkingBudget (budget_tokens returns 400), and
        // adaptive thinking is ON by default. xhigh/max are supported on
        // Sonnet 5 too, but Opus 4.8 at low/medium generally beats Sonnet 5
        // at xhigh for the same cost — 'high' is the sane default here.
        name: 'sonnet-5',
        model: 'anthropic/claude-sonnet-5',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        effort: 'high'
    },
    {
        name: 'gpt-5.6-sol',
        model: 'openai/gpt-5.6-sol',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        effort: 'low'
    },
    {
        name: 'Gemini 3.5 Flash',
        model: 'google/gemini-3.5-flash',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: ''
        // OpenRouter caps Gemini 3.5 Flash completions at 65,536 tokens —
        // the global 64k default was chosen to fit under exactly this cap
    },
    {
        // Opus 5 (July 2026) — the current default (see currentProvider below
        // and DEFAULT_TIER_ALIASES.medium). Same Anthropic-OAuth shape as the
        // Opus-4-8 entry below, which is deliberately KEPT so anyone who
        // prefers it can still select it.
        name: 'Opus 5',
        model: 'claude-opus-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        // xhigh is supported on Opus 5 and is the documented recommended
        // starting point for coding/agentic work
        effort: 'xhigh',
        isClaudeOAuth: true
    },
    {
        name: 'Opus-4-8',
        model: 'claude-opus-4-8',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        // xhigh is supported on Opus 4.8 (and Fable/Mythos 5) and is the
        // documented recommended starting point for coding/agentic work
        effort: 'xhigh',
        isClaudeOAuth: true
    },
    {
        name: 'Sonnet 5',
        model: 'claude-sonnet-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        effort: 'high',
        isClaudeOAuth: true
    },
    {
        name: 'Fable 5',
        model: 'claude-fable-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        effort: 'high',
        isClaudeOAuth: true
    },
    {
        // Fable 5.1 (Sept 2026) — dateless pinned id, 1M context, 128k max
        // output. Thinking is always-on adaptive (effort via output_config,
        // same as Fable 5); the SW additionally opts this model into the
        // thinking-display-updates + thinking-binding-controls betas and the
        // block_binding drop_block opt-out — see FABLE_5_1_PLUS_RE in
        // src/platform/extension/background.js. Existing installs pick this
        // entry up via the name-keyed default merge in
        // loadApiProviders (core/130-indexeddb.js).
        name: 'Fable 5.1',
        model: 'claude-fable-5-1',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        effort: 'high',
        isClaudeOAuth: true
    },
    // --- ChatGPT subscription (OAuth device-code) ---
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
    {
        name: 'GPT-5.6 Sol (ChatGPT)',
        model: 'gpt-5.6-sol',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        apiKey: 'oauth',
        effort: 'high',
        isChatGPTOAuth: true
    },
    {
        name: 'GPT-5.6 Terra (ChatGPT)',
        model: 'gpt-5.6-terra',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        apiKey: 'oauth',
        effort: 'medium',
        isChatGPTOAuth: true
    },
    {
        name: 'GPT-5.6 Luna (ChatGPT)',
        model: 'gpt-5.6-luna',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        apiKey: 'oauth',
        effort: 'medium',
        isChatGPTOAuth: true
    }
];

// API providers (loaded from IndexedDB, initialized with defaults on first load)
// Named LLM endpoints (Settings → LLM Endpoints): { id, name, url, apiKey }.
// Endpoint-backed models reference one via provider.endpointId; the endpoint's
// url/apiKey are snapshotted inline onto the provider at save time so the
// request path keeps reading provider.endpoint / provider.apiKey. Restored
// after PR #824 removed the section (endpoints were inlined into providers).
var DEFAULT_LLM_ENDPOINTS = [
    { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: '' }
];
var llmEndpoints = [];

function getLlmEndpointById(id) {
    if (!id) return null;
    return llmEndpoints.find(function(ep) { return ep.id === id; }) || null;
}

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
var ADAPTIVE_ONLY_CLAUDE_RE = /claude-(?:fable|mythos|opus-(?:[5-9]|\d{2,}|4[.-](?:[7-9]|\d{2,}))|sonnet-(?:[5-9]|\d{2,}))/;
function isAdaptiveOnlyClaude(model) {
    return ADAPTIVE_ONLY_CLAUDE_RE.test(String(model || '').toLowerCase());
}

var currentProvider = 'Opus 5'; // Default provider name (must match a provider in DEFAULT_API_PROVIDERS)

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
    'opus-4.6': 'Opus-4-8',
    'opus-4.8': 'Opus-4-8',
    'haiku-4.5': 'Opus-4-8',
    'Proxy': 'Opus-4-8',
    // Renamed defaults → their July 2026 successors
    'sonnet-4.5': 'sonnet-5',
    'sonnet-4.6': 'sonnet-5',
    'Kimi K2.5': 'GLM 5.2',
    // (gpt-5.2 chain-collapses straight to gpt-5.6-sol: the old gpt-5.5
    // target no longer exists in the defaults)
    'gpt-5.2': 'gpt-5.6-sol',
    'gpt-5.5': 'gpt-5.6-sol',
    'Gemini 3 Flash Preview': 'Gemini 3.5 Flash',
    'Sonnet 4.6 OAuth': 'Sonnet 5',
    // July 2026: the ' OAuth' suffix was dropped from the user-facing
    // default names (same providers, friendlier labels)
    'Opus-4-8 OAuth': 'Opus-4-8',
    'Sonnet 5 OAuth': 'Sonnet 5',
    // ChatGPT-OAuth seeds: the assumed gpt-5.1* slugs never existed on the
    // Codex backend for ChatGPT accounts
    'GPT-5.1 Codex': 'GPT-5.6 Sol (ChatGPT)',
    'GPT-5.1': 'GPT-5.6 Terra (ChatGPT)'
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
// Defaults derived from DEFAULT_API_PROVIDERS: cheapest/fastest → small,
// balanced → medium, strongest → large. Keep names in sync with the
// DEFAULT_API_PROVIDERS entries above when models are renamed.
var DEFAULT_TIER_ALIASES = {
    small: 'Sonnet 5',
    medium: 'Opus 5',
    large: 'Fable 5'
};
var subAgentTierAliases = null; // null = not yet hydrated from IDB
// Special alias value: a tier mapped to TIER_ALIAS_SAME resolves to NO
// concrete provider — spawns through that tier behave exactly like an
// explicit tier:'same' spawn (dynamic follow of the spawning agent's
// current model, re-resolved at EACH LLM call via chats[chatId].same_as /
// resolveChatProviderName). Stored in the same subagentTierAliases map as
// concrete provider names; the sentinel is namespaced so it can never
// collide with a real apiProviders name shown in the pickers. Consumers:
// checkTier in _resolveSpawnProvider (core/097-sub-agent-registry.js) and
// the two tier-picker UIs (ui/040-tools-settings.js renderTierAliasSettings,
// ui/160-notifications.js _tierMenuRowsHtml).
var TIER_ALIAS_SAME = '__same__';

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

// Hydrate the alias overrides from the IDB settings store. Called from the
// SW port bridge's run-agent gate (so spawn-time resolution sees fresh
// values) and lazily by the settings UI. getSetting lives in
// core/130-indexeddb.js — shared in both bundles, called at runtime only.
async function loadTierAliases() {
    try {
        if (typeof getSetting === 'function') {
            var stored = await getSetting(TIER_ALIASES_SETTING_KEY, null);
            subAgentTierAliases = (stored && typeof stored === 'object') ? stored : {};
            // Recover stored aliases that still point at RENAMED default
            // provider names (e.g. 'Sonnet 5 OAuth' → 'Sonnet 5') — provider
            // lookups are exact-string, so a stale name would silently break
            // tier resolution after a default rename.
            for (var _tm in subAgentTierAliases) {
                var _tv = subAgentTierAliases[_tm];
                if (_tv && PROVIDER_RENAMES[_tv]) subAgentTierAliases[_tm] = PROVIDER_RENAMES[_tv];
            }
        } else if (subAgentTierAliases === null) {
            subAgentTierAliases = {};
        }
    } catch (e) {
        if (subAgentTierAliases === null) subAgentTierAliases = {};
    }
    return getTierAliasMap();
}

// Persist an updated alias map (full small/medium/large map expected).
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
            }
            var storedBudget = await getSetting(THINKING_BUDGET_SETTING_KEY, null);
            if (storedBudget !== null && storedBudget !== undefined && storedBudget !== '') {
                globalThinkingBudget = parseInt(storedBudget, 10) || DEFAULT_THINKING_BUDGET;
            }
            var storedDeferred = await getSetting(DEFERRED_TOOLS_SETTING_KEY, null);
            if (storedDeferred !== null && storedDeferred !== undefined) {
                deferredToolsEnabled = !!storedDeferred;
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
var CHAT_META_FLAG_FIELDS = ['_jobsHidden', 'pinned', '_lastApiError', 'pausedByUser'];
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
function setChatPausedPersistent(chatId, isPaused) {
    if (!chatId) return;
    var v = isPaused === true;
    try {
        var c = (typeof chats !== 'undefined' && chats) ? chats[chatId] : null;
        if ((pausedChats[chatId] === true) === v
            && (typeof pausedChatIds === 'undefined' || (pausedChatIds[chatId] === true) === v)
            && (!c || (c.pausedByUser === true) === v)) return;
        if (typeof dispatchChatMeta === 'function') { dispatchChatMeta(chatId, { pausedByUser: v }); return; }
        if (typeof _swHandleChatMetaUpdate === 'function') { _swHandleChatMetaUpdate(chatId, { pausedByUser: v }); return; }
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
var instancePermissions = {}; // Per-instance permissions: { 'host': { tier: 'manual'|'auto', tools: { key: 'allow'|'auto'|'ask'|'disabled' } } }
var cacheTokenLimit = 4000; // Cache limit in tokens (default ~4k tokens = ~16KB)
var sessionPermissions = {}; // Session-only permissions (cleared on page reload)
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
