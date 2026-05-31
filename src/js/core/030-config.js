// Default API providers (used on first load, then stored in IndexedDB)
var DEFAULT_API_PROVIDERS = [
    {
        name: 'Kimi K2.5',
        apiKey: '',
        model: 'moonshotai/kimi-k2.5',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        context_length: 262000,
        maxTokens: 64000,
        thinkingBudget: 40000,
        provider: 'moonshotai'
    },
    {
        name: 'opus-4.6',
        apiKey: '',
        model: 'anthropic/claude-opus-4-6',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        context_length: 200000,
        maxTokens: 64000,
        thinkingBudget: 40000
    },
    {
        name: 'sonnet-4.5',
        apiKey: '',
        model: 'anthropic/claude-sonnet-4.5',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        context_length: 200000,
        maxTokens: 64000,
        thinkingBudget: 40000
    },
    {
        name: 'haiku-4.5',
        apiKey: '',
        model: 'anthropic/claude-haiku-4.5',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        context_length: 200000,
        maxTokens: 64000,
        thinkingBudget: 40000
    },
    {
        name: 'gpt-5.2',
        apiKey: '',
        model: 'openai/gpt-5.2',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        context_length: 400000,
        maxTokens: 128000,
        effort: 'low'
    },
    {
        name: 'Gemini 3 Flash Preview',
        apiKey: '',
        model: 'google/gemini-3-flash-preview',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        context_length: 1000000,
        maxTokens: 64000,
        thinkingBudget: 50000
    },
    {
        name: 'Proxy',
        model: 'anthropic/claude-opus-4-6',
        endpoint: 'http://localhost:8000/api/v1/chat/completions',
        apiKey: '----',
        maxTokens: 100000,
        context_length: 200000,
        thinkingBudget: 64000
    },
    {
        name: 'Opus-4-8 OAuth',
        model: 'claude-opus-4-8',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        maxTokens: 100000,
        context_length: 200000,
        effort: 'high',
        isClaudeOAuth: true
    },
    {
        name: 'Sonnet 4.6 OAuth',
        model: 'claude-sonnet-4-6',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'oauth',
        maxTokens: 100000,
        context_length: 200000,
        effort: 'high',
        isClaudeOAuth: true
    }
];

// API providers (loaded from IndexedDB, initialized with defaults on first load)
var apiProviders = [];

// Default API provider template for adding new providers (based on haiku45)
var DEFAULT_API_PROVIDER = {
    name: '',
    apiKey: '',
    model: '',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    context_length: 200000,
    maxTokens: 64000,
    thinkingBudget: 40000,
    provider: ''
};

var currentProvider = 'Opus-4-8 OAuth'; // Default provider name (must match a provider in DEFAULT_API_PROVIDERS)
var currentChatId = null;
var chats = {};
var paused = false; // LEGACY: kept for backwards compat with bits that still read it. Do NOT consult in isChatPaused — it would cross-pollute pause across concurrent chats.
var pausedChats = {}; // Per-chat pause flags (for background Action chats the user paused via button)
function isChatPaused(chatId) { return chatId ? pausedChats[chatId] === true : false; }
var isRunning = false;
var runningChatIds = {}; // Set of chatIds with an active agent loop — supports concurrent background chats
var pendingInjection = null; // User message to inject into the next tool result batch
var pendingInjectionImages = null; // Images/files to inject alongside pendingInjection
var pendingInjectionsByChatId = {}; // Per-chat pending injections: { chatId: { text, images } }
var currentStreamAbortControllers = {}; // Per-chat AbortController for the in-flight LLM stream
var userInterruptedChats = {}; // Per-chat: true when user pressed send mid-stream and wants to abort current step
var interruptResolversByChatId = {}; // Per-chat: function to resolve the in-flight tool's interrupt-race promise instantly
var currentStreamingMsgIndex = -1;
var activeStreamingChatId = null; // Track which chat has active streaming (the one the UI is focused on)
function isChatRunning(chatId) { return !!runningChatIds[chatId]; }
var sidebarCollapsed = false;
var historyExpanded = true; // History section expanded by default
var showApiStats = true;
var lastRequestMetrics = null; // Track token usage and performance
// When the running context (last reported prompt size) crosses this many tokens,
// the agent loop appends a one-shot reminder to delegate heavy work to sub-agents
// (model quality degrades at long context). Set to 0 to disable the nudge.
var SUBAGENT_NUDGE_TOKEN_THRESHOLD = 70000;
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
var lastLargeResponse = null; // Store the last large API response for Agent manipulation via js_eval
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
