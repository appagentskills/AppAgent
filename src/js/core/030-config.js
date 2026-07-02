// Default named LLM endpoints (used on first load, then stored in IndexedDB).
// Endpoints are first-class objects { id, name, url, apiKey }: the same URL
// can appear under several names with different API keys. Providers (models)
// reference an endpoint by `endpointId` instead of carrying inline
// endpoint/apiKey fields. Claude-OAuth providers are the exception — they
// keep their inline endpoint/apiKey ('oauth') and never use endpointId.
var DEFAULT_LLM_ENDPOINTS = [
    { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: '' }
];

// LLM endpoints (loaded from IndexedDB, initialized with defaults on first load)
var llmEndpoints = [];

// Loaded in BOTH bundles (page core tier + WORKER_SHARED_FILES) so the
// SW/offscreen streaming path resolves endpoints the same way the page does.
function getLlmEndpointById(id) {
    if (!id) return null;
    return llmEndpoints.find(function(ep) { return ep.id === id; }) || null;
}

// THE single resolution point for a provider's connection details.
// Returns { endpoint, apiKey, endpointName }. If provider.endpointId
// resolves to a named endpoint, its url/apiKey/name win; otherwise fall
// back to the provider's legacy inline endpoint/apiKey fields (OAuth
// providers and not-yet-migrated entries), with an empty endpointName.
// Loaded in BOTH bundles (page core tier + WORKER_SHARED_FILES).
function resolveProviderConnection(provider) {
    if (provider && provider.endpointId) {
        var ep = getLlmEndpointById(provider.endpointId);
        if (ep) {
            return { endpoint: ep.url, apiKey: ep.apiKey || '', endpointName: ep.name || '' };
        }
    }
    return {
        endpoint: (provider && provider.endpoint) || '',
        apiKey: (provider && provider.apiKey) || '',
        endpointName: ''
    };
}

// Default API providers (used on first load, then stored in IndexedDB)
var DEFAULT_API_PROVIDERS = [
    {
        name: 'GLM 5.2',
        model: 'z-ai/glm-5.2',
        endpointId: 'openrouter',
        context_length: 1048576,
        // Routing is pinned to first-party Z.AI (provider below), whose
        // endpoint allows 131,072 completion tokens — 64k is safely under it
        maxTokens: 64000,
        thinkingBudget: 40000,
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
        endpointId: 'openrouter',
        context_length: 1000000,
        maxTokens: 64000,
        effort: 'high'
    },
    {
        name: 'gpt-5.5',
        model: 'openai/gpt-5.5',
        endpointId: 'openrouter',
        context_length: 1050000,
        maxTokens: 128000,
        effort: 'low'
    },
    {
        name: 'Gemini 3.5 Flash',
        model: 'google/gemini-3.5-flash',
        endpointId: 'openrouter',
        context_length: 1048576,
        // OpenRouter caps Gemini 3.5 Flash completions at 65,536 tokens
        maxTokens: 64000,
        thinkingBudget: 50000
    },
    {
        name: 'Opus-4-8 OAuth',
        model: 'claude-opus-4-8',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        maxTokens: 100000,
        context_length: 200000,
        // xhigh is supported on Opus 4.8 (and Fable/Mythos 5) and is the
        // documented recommended starting point for coding/agentic work
        effort: 'xhigh',
        isClaudeOAuth: true
    },
    {
        name: 'Sonnet 5 OAuth',
        model: 'claude-sonnet-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        maxTokens: 100000,
        // Sonnet 5 serves the 1M context window by default on the direct API
        // (1M is both the default and the only size — no beta header needed)
        context_length: 1000000,
        effort: 'high',
        isClaudeOAuth: true
    }
];

// API providers (loaded from IndexedDB, initialized with defaults on first load)
var apiProviders = [];

// Default API provider template for adding new providers (based on haiku45)
var DEFAULT_API_PROVIDER = {
    name: '',
    model: '',
    endpointId: 'openrouter',
    context_length: 200000,
    maxTokens: 64000,
    // Doc-recommended budget ceiling (batch processing advised above 32k).
    // Ignored automatically for adaptive-only Claude models (Opus 4.7+,
    // Sonnet 5+, Fable/Mythos 5) — see callOpenRouterStreaming.
    thinkingBudget: 32000,
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

var currentProvider = 'Opus-4-8 OAuth'; // Default provider name (must match a provider in DEFAULT_API_PROVIDERS)

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
    'opus-4.6': 'Opus-4-8 OAuth',
    'opus-4.8': 'Opus-4-8 OAuth',
    'haiku-4.5': 'Opus-4-8 OAuth',
    'Proxy': 'Opus-4-8 OAuth',
    // Renamed defaults → their July 2026 successors
    'sonnet-4.5': 'sonnet-5',
    'sonnet-4.6': 'sonnet-5',
    'Kimi K2.5': 'GLM 5.2',
    'gpt-5.2': 'gpt-5.5',
    'Gemini 3 Flash Preview': 'Gemini 3.5 Flash',
    'Sonnet 4.6 OAuth': 'Sonnet 5 OAuth'
};
var currentChatId = null;
var chats = {};
var paused = false; // LEGACY: kept for backwards compat with bits that still read it. Do NOT consult in isChatPaused — it would cross-pollute pause across concurrent chats.
var pausedChats = {}; // Per-chat pause flags (for background Action chats the user paused via button)
function isChatPaused(chatId) { return chatId ? pausedChats[chatId] === true : false; }
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
var sidebarCollapsed = false;
var historyExpanded = true; // History section expanded by default
var showApiStats = true;
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
var currentScope = 'global'; // Current app scope (used for API calls)
var platformScope = 'global'; // Last known platform scope
var localScopeOverride = null; // User's local scope override (null = use platform scope)
var cachedUserSysId = null; // Cache user sys_id to avoid repeated API calls
var impersonateOriginalUserSysId = null; // Store original user sys_id before impersonation
var scopeFetched = false; // Track if scope has been fetched (lazy load for POST)
var versionHistory = []; // Track all record changes with before/after versions
var chatSearchQuery = ''; // Track chat search query
var activeSkills = {}; // Track active skills with their XML backups: { skillId: { xmlBackups: { table_sysId: versionSysId } } }
var skillAssetsStoreName = 'skillAssets'; // IndexedDB store for skill assets
var chatWidgets = {}; // Track widgets per chat: { chatId: [{ id, title, html, height, width, createdAt, msgIndex }] }
var isFollowingScroll = true; // Track if user is following scroll (turned off when user scrolls away from bottom)
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
var lastUserScrollTime = 0; // Track when user last scrolled (for debounce)
var SCROLL_DEBOUNCE_MS = 1000; // 1 second debounce before auto-scroll can take over
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
