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
        var active = list.filter(function(s) {
            if (!((typeof activeSkills === 'object') && activeSkills && activeSkills[s.id])) return false;
            // devOnly skills are hidden from the prompt outside dev mode —
            // keep in sync with the page original in ui/070-dashboard-ui.js.
            if (typeof isSkillDevHidden === 'function' && isSkillDevHidden(s.id)) return false;
            return true;
        });
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
if (typeof refreshClaudeOAuthUsage !== 'function') var refreshClaudeOAuthUsage = function() {};

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
if (typeof executeGitHubSetup !== 'function') var executeGitHubSetup = async function() { return { success: false, error: 'github_setup unavailable in SW context' }; };
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
    autoTldr: true,
    autoLinks: false,
    autoCaveat: true,
    autoProgress: true,
    showHookMessages: false
};
var _silentHookRunningByChat = (typeof _silentHookRunningByChat !== 'undefined') ? _silentHookRunningByChat : {};

// Hydrate hooksEnabled from IDB. Matches the page-side `loadHooksSettings`
// in core/040-hooks-history.js. Without this the SW always sees the defaults
// and the user's disabled-autoTitle preference is ignored — `set_chat_title`
// stays in the enabled-tool list and `executeAfterResponseHooks` keeps firing.
async function loadHooksSettings() {
    if (typeof getSetting !== 'function') return;
    var saved = await getSetting('hooksEnabled', null);
    if (saved !== null) {
        hooksEnabled = saved;
        // Migration: autoTldr was added after users may have saved settings.
        if (hooksEnabled.autoTldr === undefined) hooksEnabled.autoTldr = true;
        // Migration: autoLinks now defaults OFF — users without the key get the
        // new default (an explicit saved `true` is preserved; only undefined→false).
        if (hooksEnabled.autoLinks === undefined) hooksEnabled.autoLinks = false;
        // Migration: autoCaveat was added later — default ON for existing users.
        if (hooksEnabled.autoCaveat === undefined) hooksEnabled.autoCaveat = true;
        // Migration: autoProgress was added later — default ON for existing users.
        if (hooksEnabled.autoProgress === undefined) hooksEnabled.autoProgress = true;
    }
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

// The final-answer target search for the TL;DR / Links hook gating lives in
// findHookAnswerTarget (tools/020-tool-execution.js, part of
// WORKER_SHARED_FILES) — shared with the page bundle and the
// executeSetTldr / executeSetLinks implementations, so gating and attachment
// always agree on the same target message.

function executeAfterResponseHooks(chatId) {
    var chat = chats[chatId];
    if (!chat || !chat.messages || chat.messages.length < 2) return;

    // Auto-title hook. Provisional titles (first-message snippet set by the
    // page's updateChatTitle) still need upgrading to a model-generated title.
    var needsTitle = false;
    if (hooksEnabled.autoTitle && (!chat.title || chat.title === 'New Chat' || chat.titleProvisional)) {
        // Retry cap (mirrors core/040-hooks-history.js): success clears
        // titleProvisional via executeSetChatTitle, so reaching here again means
        // the previous attempt failed. After 2 failures, keep the provisional
        // snippet as the final title.
        chat._titleHookTries = (chat._titleHookTries || 0) + 1;
        if (chat._titleHookTries > 2) {
            delete chat.titleProvisional;
            if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
        } else {
            needsTitle = true;
        }
    }

    // TLDR hook: ask for a TL;DR card on the final answer of the last real
    // turn. Single attempt per answer (_tldrAsked, set BEFORE firing)
    // prevents hook loops when the model fails to call set_tldr.
    // Skipped on background chats (actions / sub-agents): the TL;DR card is
    // never rendered there, so the extra hook LLM run would be pure waste.
    var needsTldr = false;
    if (hooksEnabled.autoTldr && !chat.isBackground) {
        var tldrTarget = findHookAnswerTarget(chat);
        if (tldrTarget && !tldrTarget.tldr && relocateAnswerCard(chat, 'tldr')) {
            // A spontaneous mid-run set_tldr attached the card to an earlier
            // message of this turn — relocateAnswerCard moved it onto the
            // final answer. The hook is satisfied; no extra LLM run. Re-emit
            // so the page mirror re-attaches to the same (new) target.
            if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
            if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
                AgentEvents.emit('tldrChanged', { chatId: chatId, tldr: tldrTarget.tldr });
            }
        } else if (tldrTarget && !tldrTarget.tldr && !tldrTarget._tldrAsked) {
            // Retry cap mirroring _titleHookTries: a successful set_tldr
            // resets the counter (executeSetTldr); repeated failures stop
            // burning an extra LLM run on every subsequent response.
            chat._tldrHookTries = (chat._tldrHookTries || 0) + 1;
            if (chat._tldrHookTries <= 2) {
                tldrTarget._tldrAsked = true;
                needsTldr = true;
            }
        }
    }

    // Links hook: ask for a list of relevant links (PRs, diffs, records, docs)
    // on the final answer of the last real turn. Single attempt per answer
    // (_linksAsked, set BEFORE firing) prevents hook loops when the model fails
    // to call set_links. Skipped on background chats (never rendered there).
    var needsLinks = false;
    if (hooksEnabled.autoLinks && !chat.isBackground) {
        var linksTarget = findHookAnswerTarget(chat);
        if (linksTarget && !linksTarget.links && relocateAnswerCard(chat, 'links')) {
            // Spontaneous mid-run set_links — same relocation as the TLDR
            // branch above; hook satisfied without an extra LLM run.
            if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
            if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
                AgentEvents.emit('linksChanged', { chatId: chatId, links: linksTarget.links });
            }
        } else if (linksTarget && !linksTarget.links && !linksTarget._linksAsked) {
            // Retry cap mirroring _tldrHookTries: a successful set_links resets
            // the counter (executeSetLinks); repeated failures stop burning an
            // extra LLM run on every subsequent response.
            chat._linksHookTries = (chat._linksHookTries || 0) + 1;
            if (chat._linksHookTries <= 2) {
                linksTarget._linksAsked = true;
                needsLinks = true;
            }
        }
    }

    // Caveat hook (OPTIONAL, piggyback-only): let the model flag a single
    // must-read warning on the final answer (off-plan deviation, unverified
    // assumption, incomplete work, or a trailing question/requested action the
    // user might overlook). Unlike tldr/links it NEVER triggers its own extra
    // LLM run — the caveat task is appended to the combined instruction ONLY
    // when at least one other hook (title/tldr/links) is already firing (see the
    // `caveatEligible && tasks.length > 0` gate below), so a normal answer with
    // nothing to flag costs zero extra round-trips. Skipped on background chats
    // (the card is never rendered there).
    var caveatEligible = false;
    var caveatTarget = null;
    if (hooksEnabled.autoCaveat && !chat.isBackground) {
        caveatTarget = findHookAnswerTarget(chat);
        if (caveatTarget && !caveatTarget.caveat && relocateAnswerCard(chat, 'caveat')) {
            // Spontaneous mid-run set_caveat — relocate onto the final answer,
            // same as the tldr/links branches; hook satisfied, no extra LLM run.
            chat._caveatHookTries = 0;
            if (typeof saveChatsToStorage === 'function') saveChatsToStorage();
            if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
                AgentEvents.emit('caveatChanged', { chatId: chatId, caveat: caveatTarget.caveat });
            }
        } else if (caveatTarget && !caveatTarget.caveat && !caveatTarget._caveatAsked) {
            // Reaching a fresh (not-yet-asked) answer target = a NEW answer.
            // Clear any try-count carried over from earlier answers: a caveat
            // "skip" is a valid outcome (not a failure), so — unlike tldr's
            // chat-wide cap — it must NOT accumulate across answers and
            // permanently suppress the offer. The per-message _caveatAsked flag
            // (set only when the task is actually pushed) is the once-per-answer
            // guard; _caveatHookTries stays a within-answer safety ceiling.
            if ((chat._caveatHookTries || 0) >= 2) chat._caveatHookTries = 0;
            caveatEligible = true;
        }
    }

    // Chat-progress hook (OPTIONAL, piggyback-only): ask the model to finalize
    // the progress card by calling the EXISTING update_action_state tool with a
    // terminal display state (finished / pr_opened / finished_with_caveat /
    // error). Modeled on the caveat hook above: it NEVER triggers its own LLM
    // run — the task is only appended when title/tldr/links already need one.
    // Skipped on background chats (their action buttons already carry terminal
    // state) and when the latest card already shows a terminal display state.
    // NOTE: getChatProgressStateFor (tools/120-actions.js) is NOT in the SW
    // bundle, so the latest state + tool-usage check is a cheap inline backward
    // walk over chat.messages (the SW owns the authoritative copy).
    var progressEligible = false;
    var progressTarget = null;
    if (hooksEnabled.autoProgress && !chat.isBackground) {
        progressTarget = findHookAnswerTarget(chat);
        if (progressTarget && !progressTarget._progressAsked) {
            var _progLatestState = null;   // state of the LATEST update_action_state call
            var _progHasCard = false;      // chat has ANY update_action_state call
            var _progTurnUsedTools = false;// the last turn (after the last real user msg) used tools
            var _progSeenBoundary = false;
            for (var _pi = chat.messages.length - 1; _pi >= 0; _pi--) {
                var _pm = chat.messages[_pi];
                if (!_pm) continue;
                if (!_progSeenBoundary && _pm.role === 'user' && !_pm.isHookMessage) _progSeenBoundary = true;
                if (_pm.role === 'assistant' && Array.isArray(_pm.tool_calls) && _pm.tool_calls.length) {
                    if (!_progSeenBoundary) _progTurnUsedTools = true;
                    if (!_progHasCard) {
                        for (var _pj = _pm.tool_calls.length - 1; _pj >= 0; _pj--) {
                            var _ptc = _pm.tool_calls[_pj];
                            if (_ptc && _ptc.function && _ptc.function.name === 'update_action_state') {
                                _progHasCard = true;
                                try { _progLatestState = (JSON.parse(_ptc.function.arguments || '{}') || {}).state || null; } catch (e) {}
                                break;
                            }
                        }
                    }
                }
                if (_progSeenBoundary && _progHasCard) break;
            }
            var _progAlreadyFinal = _progLatestState &&
                // pr_merged is an INTERNAL display state (set by workspace merge-
                // detection, never via the tool) — included defensively so the
                // finalize hook never re-fires on an already-merged card. 'done'
                // and 'error' are terminal too: without them a card that ended
                // in done/error stays "eligible" and the hook re-appends the
                // finalize request on every subsequent answer (churn).
                ['finished', 'pr_opened', 'finished_with_caveat', 'pr_merged', 'done', 'error'].indexOf(_progLatestState) >= 0;
            // Eligible when there's a progress card in any non-final state, or
            // no card at all but the run actually used tools (a pure
            // conversational answer has nothing to finalize).
            if (!_progAlreadyFinal && (_progHasCard || _progTurnUsedTools)) {
                // Same per-answer reset semantics as the caveat hook: a "skip"
                // is a valid outcome, so the try-count must not accumulate
                // across answers. _progressAsked is the once-per-answer guard.
                if ((chat._progressHookTries || 0) >= 2) chat._progressHookTries = 0;
                progressEligible = true;
            }
        }
    }

    // Caveat / progress are piggyback-only: they must NEVER force a run on
    // their own, so they are deliberately excluded from this early-return guard.
    if (!needsTitle && !needsTldr && !needsLinks) return;

    // Build ONE combined instruction so title + TL;DR + links share a single
    // extra LLM run when more than one is needed.
    var tasks = [];
    if (needsTitle) tasks.push('set a concise chat title (max 50 chars) using the set_chat_title tool');
    if (needsTldr) tasks.push('provide a TL;DR of your answer using the set_tldr tool (1-2 short sentences, max 280 chars)');
    if (needsLinks) tasks.push('provide any relevant links using the set_links tool — call it as set_links({links: [{title, url}, ...]}) for anything the user may want to look into (PRs, diffs, ServiceNow records, docs); pass an empty links array if there is nothing worth linking');
    // Piggyback the OPTIONAL caveat task — only when another hook is already
    // firing (tasks.length > 0) and the retry ceiling isn't hit — and set the
    // per-message asked flag / bump the try-count ONLY here, when it is really
    // pushed. This guarantees a caveat-only turn never burns an extra LLM run.
    var caveatPushed = false;
    var caveatTaskNum = 0;
    if (caveatEligible && tasks.length > 0 && (chat._caveatHookTries || 0) < 2) {
        tasks.push('OPTIONALLY call the set_caveat tool — set_caveat({caveat: "..."}) with a short warning (1-2 sentences) — ONLY IF your answer contains something the user must not miss — you deviated from the plan or instructions, made an assumption that needs double-checking, left the work partially incomplete, or ended with a question or requested action the user might overlook; do NOT flag routine always-visible follow-ups — e.g. "extension needs to be reloaded" or "PR not merged yet" — those are already shown to the user; only flag things the user would otherwise miss; if there is nothing like that, do NOT call set_caveat');
        caveatTarget._caveatAsked = true;
        chat._caveatHookTries = (chat._caveatHookTries || 0) + 1;
        caveatPushed = true;
        caveatTaskNum = tasks.length;
    }
    // Piggyback the OPTIONAL chat-progress task — same pattern as the caveat:
    // only when another hook is already firing, flags/tries bumped only when
    // the task is really pushed.
    var progressPushed = false;
    var progressTaskNum = 0;
    if (progressEligible && tasks.length > 0 && (chat._progressHookTries || 0) < 2) {
        tasks.push('finalize the chat progress card by calling the update_action_state tool with the appropriate TERMINAL state — `pr_opened` if a PR was opened/pushed during this task, `finished_with_caveat` if you are also flagging a caveat with set_caveat, `error` if the task failed, otherwise `finished` — passing the full tasks array (all marked done) and a short markdown `output` summary; SKIP this call entirely if no substantive work was done (pure conversational answer)');
        progressTarget._progressAsked = true;
        chat._progressHookTries = (chat._progressHookTries || 0) + 1;
        progressPushed = true;
        progressTaskNum = tasks.length;
    }
    var instruction;
    if (tasks.length === 1) {
        instruction = 'Now ' + tasks[0] + '. Do NOT say anything else.';
    } else {
        var numbered = tasks.map(function(t, i) { return (i + 1) + ') ' + t; }).join('; ');
        instruction = 'Now do the following, calling ALL the tools in THIS SINGLE response (parallel tool calls), and say nothing else: ' + numbered + '.';
        if (caveatPushed) {
            // The caveat item is OPTIONAL — the model must skip it when there is
            // nothing to flag, so soften the "calling ALL the tools" wording.
            // caveatTaskNum (captured at push time) — NOT tasks.length — because
            // the progress task may have been pushed after it.
            instruction += ' (Item ' + caveatTaskNum + ' — set_caveat — is OPTIONAL: call it only if your answer has a genuine must-read warning; if not, skip it and just call the other tool(s).)';
        }
        if (progressPushed) {
            instruction += ' (Item ' + progressTaskNum + ' — update_action_state — is also conditional: skip it ONLY when no substantive work was done this turn.)';
        }
    }

    var _hookIsSilent = !hooksEnabled.showHookMessages;
    // Per-chat flag (see worker/000-runtime-globals.js): only THIS chat's
    // finish may consume/clear it — concurrent chats no longer clobber each
    // other's silent-hook window.
    if (_hookIsSilent) _silentHookRunningByChat[chatId] = true;
    // Tell the page to mirror the silent-hook flag so its render gates
    // suppress this hook's streaming output (prevents the flash of lines
    // that appear then disappear). Cleared via silentHookState(false) at the
    // agent-loop reset. No-op when the hook isn't silent. The page keeps a
    // per-chat _silentHookChats map, so other chats' UI is unaffected.
    if (_hookIsSilent && typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
        AgentEvents.emit('silentHookState', { active: true, chatId: chatId });
    }
    chat.messages.push({
        role: 'user',
        content: instruction,
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
