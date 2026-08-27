// =============================================================
// AppAgent SW runtime — global state.
//
// This file is the FIRST entry of sw-bundle.js. It declares the
// same per-chat globals the page bundle's various files declare so
// the agent-loop code (loaded later in the same bundle) sees the
// expected free variables.
//
// All state lives in the ServiceWorkerGlobalScope — `var` at the top
// level becomes a property on `self`. Survives across messages but
// is wiped if the SW is killed (Chrome MV3 30s idle / extension
// update). The IDB agent_runs store handles resume after a kill.
//
// IMPORTANT: keep names in sync with the page bundle declarations.
// If a name drifts, the agent loop will throw ReferenceError on the
// first read. The page bundle declares these names in:
//   src/js/core/010-platform.js      (Platform)
//   src/js/core/020-bootstrap.js     (STORAGE_PREFIX, isInIframe,
//                                     appStorage — page-only file,
//                                     hence the shims below)
//   src/js/core/030-config.js        (chats, currentChatId,
//                                     currentProvider, lastApiError,
//                                     lastRequestMetrics, isRunning,
//                                     activeStreamingChatId,
//                                     pendingInjection*, and the
//                                     per-chat run-state maps)
//   src/js/core/040-hooks-history.js (_silentHookRunningByChat)
// pausedChatIds and parkedToolCallsByChatId are intentionally SW-only
// (no page declaration; page reads are typeof-guarded).
// Sync is ENFORCED at build time: the decl-parity check in
// build/build.js (topLevelVarNames / DECL_PARITY_SW_ONLY) fails the
// build when any name declared here is missing a top-level `var` in
// either bundle.
// =============================================================

// Marker: this is the SW runtime context, not the page bundle and
// not the offscreen helper. Shared agent-loop code branches on this
// flag where its behavior would otherwise touch the DOM (e.g.
// isNearBottom, renderMessages) or needs to bridge to offscreen
// (js_eval sandbox, image canvas).
var Platform = (typeof Platform === 'object' && Platform) || {};
Platform.isWorker = true;
Platform.isOffscreen = false;  // kept for any code that still reads it

// --- Globals declared by core/020-bootstrap.js in the page bundle ---
// 020-bootstrap.js is page-only (DOM init + localStorage wrapper) so the
// SW bundle excludes it. But shared files (e.g. core/130-indexeddb.js)
// reference STORAGE_PREFIX at module load to build the IDB database name.
// The SW context never has an iframe, so the prefix is always empty.
var STORAGE_PREFIX = '';
var isInIframe = false;
// Minimal appStorage shim. SW has no localStorage; if any shared code
// happens to call this (page-side cache for credits, etc.) it gets
// inert no-ops here. Real persistence lives in chrome.storage / IDB.
var appStorage = {
    getItem: function() { return null; },
    setItem: function() {},
    removeItem: function() {}
};

// --- Chat state (mirrors page bundle 020-bootstrap.js) ---
// Loaded from IDB on startup by 080-storage.js. The offscreen runtime
// is the AUTHORITATIVE writer for chats[*].messages during a run.
// Panels read from their own copy and update via emitted events.
var chats = {};
var currentChatId = null;            // No "current" chat in offscreen; routes by chatId
var currentProvider = '';            // Global default, adopted from the panel (port-bridge run-agent).
                                     // Per-run the loop resolves chats[chatId].provider || currentProvider
                                     // via resolveChatProviderName (core/030-config.js) — sub-agents
                                     // pinned to a provider/tier at spawn override this global.
var lastApiError = null;
var lastRequestMetrics = null;
var activeStreamingChatId = null;
var isRunning = false;
var pendingInjection = null;         // Used by send-message; offscreen owns these via runQueue
var pendingInjectionImages = null;
// Per-chat silent-hook flags. Chats run CONCURRENTLY in the SW, so the old
// single boolean was clobbered across chats: a normal run finishing during
// another chat's silent hook inherited wasSilentHook=true (its finish
// notification + unseen bell were suppressed) and cleared the other chat's
// window out from under it. Keyed by chatId; set in executeAfterResponseHooks
// (worker/020-page-stubs.js), read + cleared per-chat at the loop finish
// (app/030-agent-loop.js).
var _silentHookRunningByChat = {};

// --- Per-chat agent-run state (mirrors page bundle 030-agent-loop.js) ---
var runningChatIds = {};
var currentStreamAbortControllers = {};
var pendingInjectionsByChatId = {};
var interruptResolversByChatId = {};
var userInterruptedChats = {};
var pausedChatIds = {};              // populated by togglePause-equivalent messages

// --- Per-chat parked UI-tool calls (Layer C) ---
// When a UI-required tool is called and no panel is registered as an
// executor, the call is parked here AND persisted to IDB. A future
// connecting panel triggers a replay via replayParkedToolCalls().
var parkedToolCallsByChatId = {};    // { chatId: [{ toolCallId, name, input, resolve, reject, parkedAt }, ...] }
