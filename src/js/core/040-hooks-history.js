// Hooks system
var hooksEnabled = {
    autoTitle: true, // Hook to auto-generate chat title after agent completes
    autoTldr: true, // Hook to ask the agent for a TL;DR card after each answer
    autoLinks: false, // Hook to ask the agent for relevant links after each answer (OFF by default)
    autoCaveat: true, // Hook to let the agent flag a must-read caveat/warning after an answer
    autoProgress: true, // Hook to ask the agent to finalize the chat progress card (update_action_state terminal state)
    showHookMessages: false // Show hook messages in chat UI
};
// Per-chat silent-hook flags for the shared agent loop (app/030-agent-loop.js).
// The SW bundle declares its own copy in worker/000-runtime-globals.js; on the
// page this stays dormant (the authoritative loop runs in the SW, and the
// page's UI gates use the _silentHookChats map in tools/120-actions.js).
var _silentHookRunningByChat = {};


// The browser-history / view-navigation machinery (getHistoryTitle,
// pushHistoryState, replaceHistoryState, handlePopState + its popstate
// listener) moved to src/js/ui/025-history-nav.js — it is pure view
// routing (hideAllPanels/showChatView/render* fan-out) and lived here in
// the core tier only for historical reasons; every call it makes reached
// UPWARD into the ui tier (flux audit: layering). Runtime call sites are
// unaffected: the page bundle concatenates core → ui → tools → app, and
// all callers (ui views, core/120 skills views, tools/110) invoke these
// functions at runtime, long after both tiers are parsed.

// Centralized scroll helpers
function isNearBottom(container) {
    container = container || document.getElementById('messages');
    if (!container) return false;
    var distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < 150;
}

// Get buffered content for consistent streaming speed.
// B1: key by chatId+':'+index so two concurrently streaming chats with the same
// message-array length don't share a buffer slot (would cause one chat's reveal
// pace to corrupt the other's). currentChatId is the right scope here because
// getDisplayContent is only called while iterating chats[currentChatId].messages
// inside renderMessages.
function getDisplayContent(msg, index) {
    var key = (currentChatId || '_') + ':' + index;
    if (!msg.isStreaming || !msg.content) {
        delete streamingDisplayLen[key];
        return msg.content || '';
    }
    var prevLen = streamingDisplayLen[key] || 0;
    var remaining = msg.content.length - prevLen;
    // Adaptive rate: faster when buffer is large to avoid falling too far behind
    var rate = remaining > 500 ? 120 : remaining > 200 ? 80 : STREAM_CHARS_PER_TICK;
    var newLen = Math.min(prevLen + rate, msg.content.length);
    // Snap to word boundary to avoid cutting mid-word
    if (newLen < msg.content.length && newLen > prevLen) {
        var space = msg.content.indexOf(' ', newLen);
        if (space !== -1 && space - newLen < 30) newLen = space + 1;
    }
    streamingDisplayLen[key] = newLen;
    return msg.content.substring(0, newLen);
}

// Load hooks settings from storage
async function loadHooksSettings() {
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

// Save hooks settings to storage AND mirror to the SW. The agent loop now
// runs in the SW, so it has its own `hooksEnabled` copy hydrated from IDB
// at boot; without this push the SW would keep the boot-time value until
// next restart and the user's toggle wouldn't take effect on background runs.
async function saveHooksSettings() {
    await setSetting('hooksEnabled', hooksEnabled);
    if (typeof pushHooksSettingsToOffscreen === 'function') {
        pushHooksSettingsToOffscreen(hooksEnabled);
    }
}

// Toggle a specific hook
async function toggleHook(hookName) {
    hooksEnabled[hookName] = !hooksEnabled[hookName];
    await saveHooksSettings();
    // ui-tier callee (ui/040-tools-settings.js) — typeof-guarded like every
    // other cross-tier call from core (flux audit: layering).
    if (typeof renderSettingsPage === 'function') renderSettingsPage();
}

// The after-response hook implementations (executeAfterResponseHooks /
// executeHookRun) live in worker/020-page-stubs.js — the agent loop runs in
// the SERVICE WORKER, so the SW copy is the only live one. The page-bundle
// duplicates that used to live here were dead code (the page's runAgent is
// replaced by the port bridge in app/045-agent-port-bridge-page.js) and had
// drifted from the SW copy; they were removed to prevent further drift.
