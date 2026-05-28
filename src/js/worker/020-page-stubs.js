// =============================================================
// AppAgent SW runtime — page-only function stubs.
//
// The shared agent loop (030-agent-loop.js) doesn't call render
// functions directly anymore (PR1 made it event-driven), BUT
// the shared utilities it DOES call — getProviderById, isChatPaused,
// processToolResultForCache, etc. — sometimes reach into things
// that don't exist here. The page-side handlers in
// 036-agent-event-handlers-page.js are explicitly NOT loaded in the
// SW bundle (those are page-only). So no one calls renderMessages
// or touches the DOM in the SW context.
//
// This file declares stubs for any page-only globals/functions the
// shared bundle code references at script-load time or at runtime
// from outside the agent loop's event flow. Pattern: declare iff
// not already defined, so the page bundle (which DOES define them)
// is unaffected when these files are loaded there by mistake.
// =============================================================

// Spinner / messages / chat-list rendering — never called in offscreen
// because 035-agent-events.js page handlers are not loaded here. But
// some shared code paths defensively call them outside the event flow
// (e.g. fetchCredits → updateContextIndicator). Stub everything.
// Page-only helpers that shared code (agent-loop, llm-streaming, api-messages,
// system-prompt) reaches into. Stubs are no-ops for DOM-y ones; real impls
// for pure functions. These match the page-side originals' contract.
//
// getSkillsSummaryForPrompt: builds the ACTIVE SKILLS block in the system
//   prompt. Page-side lives in ui/070-dashboard-ui.js; replicated here for
//   the SW so callLLMStreaming → getSystemPromptWithContext doesn't throw.
if (typeof getSkillsSummaryForPrompt !== 'function') {
    var getSkillsSummaryForPrompt = function() {
        if (typeof skills !== 'object' || !skills) return '';
        var list = Object.values(skills);
        if (list.length === 0) return '';
        var active = list.filter(function(s) { return (typeof activeSkills === 'object') && activeSkills && activeSkills[s.id]; });
        if (active.length === 0) return '';
        var out = '\n\nACTIVE SKILLS:\n';
        active.forEach(function(s) {
            var desc = s.description ? ': ' + s.description : '';
            out += '- ' + (s.name || s.id) + ' (id: ' + s.id + ')' + desc + '\n';
        });
        return out;
    };
}

// formatFileSize: pure helper used by buildAPIMessages for the file-attachment
// label. Page-side lives in ui/180-search.js.
if (typeof formatFileSize !== 'function') {
    var formatFileSize = function(bytes) {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    };
}

// updateModelDisplayWithProvider: DOM-touching (writes the header model
// label). Stub here — the panel handles its own header from the agent-event
// stream.
if (typeof updateModelDisplayWithProvider !== 'function') var updateModelDisplayWithProvider = function() {};

// Page-only DOM helpers reachable from SW-shared code only in code paths
// the offscreen runtime never enters (page-only entry points concatenated
// into the bundle, or guarded `typeof` checks). Kept as no-op stubs so the
// post-build scanner sees them declared.
//
// PR1-event-bus migration removed several stubs from this set:
//   • updateWorkspaceHeaderStatus — replaced by `workspaceMutated` event.
//   • addVersionHistoryEntry, getRecordVersion, getRecordDisplayValue,
//     getRecordScope — replaced by `recordMutated` event + the DOM-free
//     helpers in core/150-record-helpers.js.
//   • showPauseButton / hidePauseButton / showRetryButton / hideRetryButton /
//     showContinueButton / hideContinueButton / syncPauseButtonUI /
//     refreshContinueButtonForChat — real impls now in app/020-api-messages.js
//     which IS in WORKER_SHARED_FILES, so function-declaration hoisting beats
//     the stub. The page-side event handlers call them through the bus.
if (typeof showSpinner !== 'function') var showSpinner = function() {};
if (typeof hideSpinner !== 'function') var hideSpinner = function() {};
if (typeof showSnackbar !== 'function') var showSnackbar = function() {};
if (typeof renderMessages !== 'function') var renderMessages = function() {};
if (typeof renderChatList !== 'function') var renderChatList = function() {};
if (typeof updateChatTitleHeader !== 'function') var updateChatTitleHeader = function() {};
if (typeof updateContextIndicator !== 'function') var updateContextIndicator = function() {};
if (typeof updateStreamingMessage !== 'function') var updateStreamingMessage = function() {};
if (typeof setLLMConnectionStatus !== 'function') var setLLMConnectionStatus = function() {};
if (typeof fetchCredits !== 'function') var fetchCredits = function() {};

// =============================================================
// Intentional SW-bundle gaps — declared as no-ops to satisfy the
// post-build identifier scanner (build/build.js::scanSwBundleGaps).
//
// Each of the symbols below is page-only (DOM, modals, view nav,
// version-XML fetch helpers) and is referenced from SW-shared
// files only in code paths that the offscreen routing layer
// (worker/120-tool-routing.js) never enters:
//
//   • UI tool exec functions (executeIframeTool, executeDisplay,
//     etc.) are reachable only via `else if (name === 'iframe_tool')`
//     in tools/020-tool-execution.js — but those tools are headless:false,
//     so executeTool is wrapped to dispatch them to a panel BEFORE the
//     switch is reached.
//   • smart-documents has page-only render helpers (sdocSaveEdit,
//     sdocStartChat, exportAllDocuments, importDocuments, sdocDelete-
//     FromPage, sdocCreateFromPage) co-located with the headless
//     tool dispatcher in the same file. The SW concatenates the
//     whole file, but the page-only paths are only triggered by
//     button clicks in the panel.
//   • core/130-indexeddb.js calls _parseFrontmatter from a skill-
//     backfill path that page-side `loadSkillsFromStorage` triggers;
//     the SW also runs it during boot, so this stub is a fallback
//     for the rare case where the skill-engine helper hasn't been
//     pulled into WORKER_SHARED_FILES.
// =============================================================
if (typeof executeIframeTool !== 'function') var executeIframeTool = async function() { return { success: false, error: 'iframe_tool unavailable in SW context' }; };
if (typeof executeDisplay !== 'function') var executeDisplay = function() { return { success: false, error: 'display unavailable in SW context' }; };
if (typeof executeHtmlWidget !== 'function') var executeHtmlWidget = function() { return { success: false, error: 'html_widget unavailable in SW context' }; };
if (typeof executePromptUser !== 'function') var executePromptUser = async function() { return { success: false, error: 'prompt_user unavailable in SW context' }; };
if (typeof executeTakeScreenshot !== 'function') var executeTakeScreenshot = async function() { return { success: false, error: 'take_screenshot unavailable in SW context' }; };
if (typeof executeUpdateActionState !== 'function') var executeUpdateActionState = async function() { return { success: false, error: 'update_action_state unavailable in SW context' }; };
if (typeof executeShowActionButton !== 'function') var executeShowActionButton = function() { return { success: false, error: 'show_action_button unavailable in SW context' }; };
if (typeof executeGetSkill !== 'function') var executeGetSkill = async function() { return { success: false, error: 'get_skill unavailable in SW context' }; };
if (typeof executeManageSkill !== 'function') var executeManageSkill = async function() { return { success: false, error: 'manage_skill unavailable in SW context' }; };

// Smart-documents page-only helpers — referenced from the page-side
// editor/import/export paths in tools/110-smart-documents.js. The SW
// never reaches these (they're triggered by panel button clicks).
if (typeof escDisplay !== 'function') var escDisplay = function(s) { return String(s == null ? '' : s); };
if (typeof showNotification !== 'function') var showNotification = function() {};
if (typeof showConfirmModal !== 'function') var showConfirmModal = async function() { return false; };
if (typeof hideAllPanels !== 'function') var hideAllPanels = function() {};
if (typeof showChatView !== 'function') var showChatView = function() {};
if (typeof newChat !== 'function') var newChat = function() {};
if (typeof pushHistoryState !== 'function') var pushHistoryState = function() {};
if (typeof updateAllButtonStates !== 'function') var updateAllButtonStates = function() {};
if (typeof renderSkillsList !== 'function') var renderSkillsList = function() {};
// renderVersionSidebar: page-side sidebar refresh (DOM-only). Referenced from
// the page-only branches of tools/110-smart-documents.js (sdocSaveEdit,
// sdocSubmitPrompt, sdocDeleteFromPage, sdocCreateFromPage, importDocuments).
// In the SW, the documentChanged event handler in
// app/036-agent-event-handlers-page.js is the real entry point — this stub
// only satisfies the scanner for code paths the SW never executes.
if (typeof renderVersionSidebar !== 'function') var renderVersionSidebar = function() {};

// Page-side version-XML fetch helpers used by smart-documents revert path
// (DOM-only — fetches via window.sessionToken). Stubbed; the SW does not
// run revert/redo workflows directly.
if (typeof getVersionXml !== 'function') var getVersionXml = async function() { return null; };
if (typeof uploadXml !== 'function') var uploadXml = async function() { return { success: false, error: 'uploadXml unavailable in SW context' }; };

// Skill frontmatter parser lives in ui/010-skills-ui.js (page tier). The
// SW's skill-engine path calls it during importEmbeddedSkills backfill;
// the page tier provides the real impl. SW gets a minimal YAML-ish parser
// so embedded skills still backfill correctly when only the SW runs.
if (typeof _parseFrontmatter !== 'function') {
    var _parseFrontmatter = function(fm) {
        var out = {};
        if (!fm || typeof fm !== 'string') return out;
        fm.split('\n').forEach(function(line) {
            var idx = line.indexOf(':');
            if (idx < 0) return;
            var k = line.substring(0, idx).trim();
            var v = line.substring(idx + 1).trim();
            if (k) out[k] = v;
        });
        return out;
    };
}

// `isNearBottom` reads window.scrollY — DOM-only. In offscreen there is
// no scrollable chat container, so always report "false" (don't follow).
if (typeof isNearBottom !== 'function') var isNearBottom = function() { return false; };

// `getWidgetsForChat` returns the per-chat widget registry which only
// lives in the page bundle (widget DOM elements). In offscreen we have
// no widgets — return an empty array so the agent loop's widget-msgIndex
// fixup is a no-op (the panel handles widget bookkeeping on its side
// when the tool result arrives via port).
if (typeof getWidgetsForChat !== 'function') var getWidgetsForChat = function() { return []; };

// Tool display label — page bundle has the full mapping. In offscreen
// we don't need pretty labels (events carry both name + displayName,
// the panel adds the display label via its own getToolDisplayName).
// Use the raw tool name as the fallback display.
if (typeof getToolDisplayName !== 'function') var getToolDisplayName = function(name) { return name; };

// Chat pause flag. The togglePause UI lives on the panel side; pause
// state is propagated to offscreen via SW message and recorded in
// pausedChatIds. Loop code calls isChatPaused() to gate progress.
if (typeof isChatPaused !== 'function') {
    var isChatPaused = function(chatId) { return !!pausedChatIds[chatId]; };
}

// Hooks engine. The page bundle's core/040-hooks-history.js is
// excluded from the worker bundle because it's DOM-heavy (popstate
// listener, document.title, settings panel handles, ...). We provide
// a stripped-down auto-title hook here so background runs still get
// a meaningful title without a panel ever opening.
//
// `hooksEnabled` defaults match the page-side defaults in
// core/040-hooks-history.js. The actual user-saved value is hydrated
// from IDB by `loadHooksSettings` (called from entry.js during boot)
// so the SW respects the user's auto-title / showHookMessages toggles.
var hooksEnabled = (typeof hooksEnabled === 'object' && hooksEnabled) || {
    autoTitle: true,
    showHookMessages: false
};
var _silentHookRunning = (typeof _silentHookRunning !== 'undefined') ? _silentHookRunning : false;

// Hydrate hooksEnabled from IDB. Matches the page-side `loadHooksSettings`
// in core/040-hooks-history.js. Without this the SW always sees the defaults
// and the user's disabled-autoTitle preference is ignored — `set_chat_title`
// stays in the enabled-tool list and `executeAfterResponseHooks` keeps firing.
async function loadHooksSettings() {
    if (typeof getSetting !== 'function') return;
    var saved = await getSetting('hooksEnabled', null);
    if (saved !== null) hooksEnabled = saved;
}

// Hydrate tool / instance permissions from IDB. Matches the page-side
// `loadToolPermissions` in ui/070-dashboard-ui.js. Without this the SW's
// `getToolPermission` reads the empty defaults declared in core/030-config.js
// and returns 'ask' for every tool the user previously approved with "Always
// allow" — so the approval prompt keeps firing. Session approvals (which the
// page records into `sessionPermissions`) are mirrored separately via the
// 'permissions-update' port message; this loader only covers the persisted
// IDB state.
async function loadToolPermissionsInWorker() {
    if (typeof getSetting !== 'function') return;
    try {
        var saved = await getSetting('toolPermissions', null);
        if (saved && typeof saved === 'object') toolPermissions = saved;
    } catch (e) {}
    try {
        var savedI = await getSetting('instancePermissions', null);
        if (savedI && typeof savedI === 'object') instancePermissions = savedI;
    } catch (e) {}
}

function executeAfterResponseHooks(chatId) {
    if (!hooksEnabled.autoTitle) return;
    var chat = chats[chatId];
    if (!chat || !chat.messages || chat.messages.length < 2) return;
    if (chat.title && chat.title !== 'New Chat') return;
    _silentHookRunning = !hooksEnabled.showHookMessages;
    chat.messages.push({
        role: 'user',
        content: 'Now set a concise chat title (max 50 chars) for this conversation using the set_chat_title tool. Do NOT say anything else.',
        isHookMessage: true
    });
    if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
    // Recursive runAgent — passes chatId explicitly because the SW has no
    // currentChatId fallback (unlike the page bundle's hook).
    runAgent(chatId);
}

// Action engine bridge — finishActionIfDone updates Action button state
// in the panel. In offscreen we forward a runFinished event instead
// (the action listener on the panel side picks it up via 035-handlers).
if (typeof finishActionIfDone !== 'function') {
    var finishActionIfDone = function() {};
}

// processToolResultForCache lives in core/100-cached-results.js which
// IS loaded in the worker bundle. Defensive stub only if the file is
// missing (build misconfig). Returns content unchanged.
if (typeof processToolResultForCache !== 'function') {
    var processToolResultForCache = function(chatId, toolCallId, name, result) {
        return { content: JSON.stringify(result) };
    };
}

// Version-history record helpers removed 2026-05-26:
//   • getRecordVersion / getRecordDisplayValue / getRecordScope moved to
//     core/150-record-helpers.js (DOM-free, shared by page + SW).
//   • addVersionHistoryEntry stub removed — the modifying tools now emit
//     `recordMutated` events and the page-side handler in
//     app/036-agent-event-handlers-page.js calls the real
//     addVersionHistoryEntry (declared in ui/090-version-history.js).
