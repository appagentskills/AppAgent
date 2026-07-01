// =============================================================
// AppAgent SW runtime — agent-event broadcast bridge.
//
// Loaded AFTER app/035-agent-events.js (the bus) so AgentEvents is
// defined. This file does NOT register any UI-side handlers — those
// live in app/036-agent-event-handlers-page.js, which is page-only.
//
// Job: hook into the bus so EVERY emit also gets serialized over the
// direct chrome.runtime port to all connected panels. The 130-port-
// bridge.js adds panel ports to _agentSubscribers on connect.
//
// We use a monkey-patch instead of subscribing to specific event
// types so future events automatically flow without code changes.
// =============================================================

(function() {
    if (typeof AgentEvents === 'undefined' || !AgentEvents.emit) {
        console.error('[offscreen] AgentEvents bus not loaded — broadcast bridge inert');
        return;
    }

    var _origEmit = AgentEvents.emit;
    AgentEvents.emit = function(type, detail) {
        // Always fire local listeners FIRST so the loop's synchronous
        // expectations (e.g. handler exceptions surfacing in the loop's
        // try/catch) are preserved.
        try { _origEmit.call(AgentEvents, type, detail); } catch (e) {
            // The original synchronous-dispatch semantics let handler
            // exceptions propagate. Preserve that for in-process handlers
            // but DON'T let them block port broadcasting (different
            // failure domain — UI errors shouldn't desync panels).
            console.error('[sw] local handler error for ' + type + ':', e);
        }
        // Then broadcast to every connected panel.
        try {
            broadcastAgentEvent(type, detail);
        } catch (e) {
            console.error('[sw] broadcast error for ' + type + ':', e);
        }
    };

    // Diagnostic sentinel — read by tests to confirm the bridge is in place.
    AgentEvents._broadcastInstalled = true;
})();

// Per-panel subscriber set. Each entry is the chrome.runtime.Port
// of a connected panel — directly to the SW, no relay layer.
var _agentSubscribers = new Set();

// Events whose handlers in the page bundle mutate chats[chatId].messages
// indirectly via renderMessages reading the local mirror. To keep the
// page mirror in sync without round-trips, we INLINE the chat snapshot
// into the broadcast envelope for these event types. The page bridge
// (app/045-agent-port-bridge-page.js) assigns chats[chatId] = envelope.
// chat before re-emitting so the existing handlers Just Work.
//
// State-only events (runStarted, runFinished, paused, error, etc.) do
// not include the chat — the page's chats mirror has nothing to sync
// for them. The streamDelta event ALSO inlines the chat: although the
// delta itself carries the current assistant message, the page handler
// (updateStreamingMessage) needs to write to chats[chatId].messages
// [msgIndex] and that array must exist with the right length first.
var EVENTS_WITH_CHAT_INLINE = {
    // runStarted must carry the chat snapshot so the page mirror gains
    // chats[chatId] the instant a BACKGROUND chat starts running. Without it,
    // getActiveChatsList() (which drops any running chat missing from the page
    // mirror) silently hides freshly-started background chats from the jobs
    // badge/dropdown "Active Chats" group until some later chat-inlining event.
    'runStarted': true,
    'assistantMessageStarted': true,
    'streamDelta': true,
    'assistantMessage': true,
    'toolCallResult': true,
    'toolCallCancelled': true,
    'userInjected': true,
    'messagesAppended': true,
    'streamAborted': true,
    'error': true,
    'toolParked': true,
    'toolUnparked': true,
    // tldrChanged's page handler (036-agent-event-handlers-page.js) writes the
    // TL;DR onto chats[chatId].messages — a stale mirror would drop the card.
    'tldrChanged': true,
    // linksChanged's page handler writes the links array onto
    // chats[chatId].messages — a stale mirror would drop the links card.
    'linksChanged': true
};

function broadcastAgentEvent(type, detail) {
    if (_agentSubscribers.size === 0) return;
    var payload = detail || {};
    if (EVENTS_WITH_CHAT_INLINE[type] && payload.chatId && chats[payload.chatId]) {
        // postMessage uses structured clone, which deep-copies the chat.
        // For very large histories this is the dominant cost; the
        // chats-snapshot-on-hello path also pays it on connect. If
        // streaming throughput becomes a problem, switch to msg-delta
        // events (assistantMessageStarted gives msgIndex; the page can
        // then build messages locally without the full snapshot).
        payload = Object.assign({}, detail, { chat: chats[payload.chatId] });
    }
    var envelope = { type: 'agent-event', eventType: type, detail: payload };
    var dead = [];
    _agentSubscribers.forEach(function(port) {
        try {
            port.postMessage(envelope);
        } catch (e) {
            dead.push(port);
        }
    });
    if (dead.length) dead.forEach(function(p) { _agentSubscribers.delete(p); });
}

// Public helper for tool-routing.js to count available executors before
// deciding whether to run a UI tool or park it.
function countAgentSubscribers() {
    return _agentSubscribers.size;
}

// When the last running chat completes/crashes, tell background.js that the
// offscreen document is now idle. background.js's maybeCloseOffscreenIfIdle
// will then auto-close the offscreen after OFFSCREEN_IDLE_GRACE_MS (60s).
// Without this signal, _swOffscreenIdleSince stays at 0 and the offscreen
// stays open for the SW's entire lifetime.
AgentEvents.on('runFinished', _maybeMarkOffscreenIdle);
AgentEvents.on('runCrashed', _maybeMarkOffscreenIdle);
function _maybeMarkOffscreenIdle() {
    var anyRunning = false;
    for (var k in runningChatIds) { if (runningChatIds[k]) { anyRunning = true; break; } }
    if (anyRunning) return;
    if (typeof self.markOffscreenMaybeIdle === 'function') {
        try { self.markOffscreenMaybeIdle(); } catch (e) {}
    }
}
