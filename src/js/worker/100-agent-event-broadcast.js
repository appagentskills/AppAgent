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
// State-only events (paused, etc.) do not include the chat — the
// page's chats mirror has nothing to sync for them.
//
// MEMFIX-DELTA (Fix B): streamDelta is deliberately NOT in this map.
// Inlining the chat structured-cloned the ENTIRE hydrated chat (base64
// screenshots, cachedToolResults included) per subscriber on EVERY stream
// chunk — the dominant streaming memory churn on large histories. The
// delta already carries msgIndex + the streaming message; the page's
// streamDelta handler (app/036-agent-event-handlers-page.js) patches
// chats[chatId].messages[msgIndex] from it. assistantMessageStarted (full
// slim snapshot) and assistantMessage / toolCallResult (chatDelta — see
// MEMFIX-EVDELTA below) still bracket every streamed message with
// authoritative state.
var EVENTS_WITH_CHAT_INLINE = {
    // runStarted must carry the chat snapshot so the page mirror gains
    // chats[chatId] the instant a BACKGROUND chat starts running. Without it,
    // getActiveChatsList() (which drops any running chat missing from the page
    // mirror) silently hides freshly-started background chats from the jobs
    // badge/dropdown "Active Chats" group until some later chat-inlining event.
    'runStarted': true,
    'assistantMessageStarted': true,
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
    'linksChanged': true,
    // caveatChanged's page handler writes the caveat string onto
    // chats[chatId].messages — a stale mirror would drop the caveat card.
    'caveatChanged': true,
    // STALE-MIRROR-HEAL: terminal events inline the chat so the LAST
    // broadcast of every run always carries the authoritative snapshot.
    // Without this, a page that missed/raced any chat-inlining event during
    // the finish→hook-rerun churn (or a sub-agent's report to an idle
    // parent) kept a mirror WITHOUT the final assistant answer; the user's
    // next send then rendered from that stale mirror (040-send-message.js
    // renderMessages) — the answer vanished — and the idle run-agent
    // adoption (worker/130-port-bridge.js `chats[msg.chatId] = msg.chat`)
    // could even persist the stale shape. The page assign path
    // (app/045-agent-port-bridge-page.js 'agent-event' case) is
    // event-agnostic and merge-guarded (pending rows / versionHistory /
    // meta), so inlining here needs no page-side changes.
    'runFinished': true,
    'runCrashed': true,
    // approvalSettled (AB, worker/120-tool-routing.js _swSettleApprovalRow)
    // inlines the chat so every panel's event-agnostic assign (app/045)
    // merges the FLIPPED approval row before the page handler (app/036)
    // dismisses cards — the dup-merge rule keeps a non-pending snapshot row
    // over the page's pending copy, so the row can never resurrect.
    'approvalSettled': true
};

// MEMFIX-EVDELTA: subset of EVENTS_WITH_CHAT_INLINE whose chat mutations are
// structurally predictable — they APPEND rows to chat.messages and/or mutate a
// small known set of row kinds in place: the streamed assistant row (located
// by identity via detail.message), prompt_user / approval rows (seeded
// SW-side, flipped by worker/120-tool-routing.js), and sub_report cards
// (mutated in place by core/097 _repaintParent). For these, inlining the FULL
// hydrated chat structured-cloned base64 screenshots + cachedToolResults per
// subscriber per event — multi-MB per tool call on large chats (the dominant
// churn after MEMFIX-DELTA fixed streamDelta). Send a chatDelta instead:
// slim meta (no messages, heavy maps stripped) + the appended tail past a
// per-chat watermark + the known-mutable rows below it. The page bridge
// (app/045 _synthesizeChatFromDelta) rebuilds a full snapshot locally and
// feeds it through the SAME merge path full snapshots use; on any gap or
// divergence it falls back to a 'pull-chat' full resync.
var EVENTS_WITH_CHAT_DELTA = {
    'assistantMessage': true,
    'messagesAppended': true,
    'toolCallResult': true
};

// MEMFIX-EVDELTA: per-chat watermark of the messages array as of the last
// inlined broadcast: { len, lastRef }. lastRef (identity of the last row the
// panels saw) detects truncation or wholesale array replacement (undo/redo,
// 'update-chat' adopt in worker/130-port-bridge.js) — any mismatch falls back
// to a full slim snapshot, which re-arms the watermark.
var _chatDeltaSync = {};

// MEMFIX-EVDELTA: clone `map` with `field` removed from every entry that has
// it, stamping `flag` (mirrors stripChatPayloadsInPlace / extractChatPayloads-
// ForPut in core/130-indexeddb.js so the page's ensureChatPayloads lazy-load
// path recognizes the entries). Entries are cloned per-entry; the SW's live
// objects are NEVER mutated. Returns null when nothing needed stripping.
function _slimHeavyMap(map, field, flag) {
    if (!map) return null;
    var out = null;
    for (var id in map) {
        var e = map[id];
        if (e && e[field] !== undefined) {
            if (!out) out = Object.assign({}, map);
            var c = Object.assign({}, e);
            delete c[field];
            c[flag] = true;
            out[id] = c;
        }
    }
    return out;
}

// MEMFIX-EVDELTA: full-snapshot sends strip the two heavy per-chat maps
// (screenshot base64, cached-tool-result fullContent) from a CLONE. Message
// rows are untouched — a just-captured screenshot row still carries its
// inline base64 to the page (ui/250-message-render.js reads msg.base64 first
// and only falls back to chat.screenshots). The page merge grafts its own
// hydrated entries back (app/045 _mergePageHeavyPayloads) and lazy-loads
// never-seen ones via ensureChatPayloads (blob rows are queued durable by the
// saveChatsToStorage call that precedes every emit).
function _slimChatSnapshot(chat) {
    var ssSlim = _slimHeavyMap(chat.screenshots, 'base64', '_b64Evicted');
    var ctrSlim = _slimHeavyMap(chat.cachedToolResults, 'fullContent', '_fcEvicted');
    if (!ssSlim && !ctrSlim) return chat;
    var snap = Object.assign({}, chat);
    if (ssSlim) snap.screenshots = ssSlim;
    if (ctrSlim) snap.cachedToolResults = ctrSlim;
    // Same flag semantics as extractChatPayloadsForPut: adopted snapshots
    // carrying _payloadsEvicted are an established state (the page's runtime
    // sweep + ensureChatPayloads handle them).
    snap._payloadsEvicted = true;
    return snap;
}

// MEMFIX-EVDELTA: build the delta payload, or return null to force the full
// slim-snapshot fallback (no watermark yet, or the messages array shrank /
// was replaced since the last broadcast).
function _buildChatDelta(chat, detail) {
    var sync = _chatDeltaSync[chat.id];
    if (!sync) return null;
    var msgs = Array.isArray(chat.messages) ? chat.messages : [];
    if (sync.len > msgs.length) return null;
    if (sync.len > 0 && msgs[sync.len - 1] !== sync.lastRef) return null;
    var fromIndex = sync.len;
    var tail = msgs.slice(fromIndex);
    var updates = [];
    for (var i = 0; i < fromIndex; i++) {
        var m = msgs[i];
        if (!m) continue;
        // Known in-place mutators below the watermark: prompt/approval rows
        // (status flips in worker/120-tool-routing.js) and sub_report cards
        // (core/097 _repaintParent mutates the row object). Bounded count per
        // chat, small rows — cheap to re-send every delta.
        if (m.role === 'prompt_user' || m.role === 'approval' || m.role === 'sub_report') {
            updates.push({ index: i, message: m });
        }
    }
    // assistantMessage mutates the ALREADY-APPENDED streamed row in place
    // (appended at assistantMessageStarted, which broadcast a full snapshot
    // and advanced the watermark past it). detail.message IS that row —
    // locate it by identity (lastIndexOf scans from the tail; the row is at
    // or near the end).
    if (detail && detail.message) {
        var di = msgs.lastIndexOf(detail.message);
        if (di >= 0 && di < fromIndex) updates.push({ index: di, message: detail.message });
    }
    var meta = Object.assign({}, chat);
    delete meta.messages;
    var ssSlim = _slimHeavyMap(meta.screenshots, 'base64', '_b64Evicted');
    var ctrSlim = _slimHeavyMap(meta.cachedToolResults, 'fullContent', '_fcEvicted');
    if (ssSlim) meta.screenshots = ssSlim;
    if (ctrSlim) meta.cachedToolResults = ctrSlim;
    if (ssSlim || ctrSlim) meta._payloadsEvicted = true;
    return { fromIndex: fromIndex, tail: tail, updates: updates, meta: meta };
}

function broadcastAgentEvent(type, detail) {
    if (_agentSubscribers.size === 0) return;
    var payload = detail || {};
    // TOMBSTONE: never inline a `_deleted` entry (the delete tombstone parked in
    // `chats` by the 'update-chat' explicit-delete lane, worker/130-port-bridge.js).
    // runFinished/runCrashed fire on the aborting run of a just-deleted chat, and
    // the page's event-agnostic assign path re-adds it to the chat list as an empty
    // ghost row.
    if (EVENTS_WITH_CHAT_INLINE[type] && payload.chatId && chats[payload.chatId]
        && !chats[payload.chatId]._deleted) {
        var _chat = chats[payload.chatId];
        // FLUX-REV (#836): per-chat monotonic revision counter, stamped at THE
        // broadcast choke point — every canonical chat mutation that reaches a
        // panel flows through this chat-inlining branch, so one bump per
        // envelope keeps page-known rev and SW rev in lockstep. It rides the
        // delta meta (_buildChatDelta clones the whole row minus messages) and
        // the slim snapshot (_slimChatSnapshot) built below, and persists with
        // the row via the normal save loops (no leading underscore, so the
        // stripTransientChatFieldsForPut allowlist strip keeps it — see
        // core/130-indexeddb.js). Pages use it for the adopt staleness guard
        // (adoptChatRow) and delta gap detection (rev > known+1 ⇒
        // _requestChatPull), both in app/045-agent-port-bridge-page.js.
        // Cost: one integer field — the delta hot path is untouched.
        _chat.rev = (typeof _chat.rev === 'number' && isFinite(_chat.rev) ? _chat.rev : 0) + 1;
        // MEMFIX-EVDELTA: append/known-update events ship a delta instead of
        // the full chat; everything else ships a slim snapshot (heavy maps
        // stripped — see _slimChatSnapshot). postMessage still structured-
        // clones the payload per subscriber, but it is now KBs, not MBs.
        var _delta = EVENTS_WITH_CHAT_DELTA[type] ? _buildChatDelta(_chat, detail) : null;
        if (_delta) {
            payload = Object.assign({}, detail, { chatDelta: _delta });
        } else {
            payload = Object.assign({}, detail, { chat: _slimChatSnapshot(_chat) });
        }
        // Advance the watermark: after this envelope every connected panel
        // has (delta-merged or wholesale) the current messages array.
        var _wmMsgs = Array.isArray(_chat.messages) ? _chat.messages : [];
        _chatDeltaSync[_chat.id] = {
            len: _wmMsgs.length,
            lastRef: _wmMsgs.length ? _wmMsgs[_wmMsgs.length - 1] : null
        };
    } else if (payload.chatId && chats[payload.chatId] && chats[payload.chatId]._deleted) {
        // Tombstoned chat — drop its watermark so the map can't grow stale
        // entries across delete/recreate cycles.
        delete _chatDeltaSync[payload.chatId];
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

// ACTIVE-CLASSIFY-F5: SW-side finish stamp.
// `lastResponseAt` used to be written in exactly ONE place —
// markChatRecentlyFinished (src/js/tools/120-actions.js, PAGE bundle, called
// from app/036-agent-event-handlers-page.js runFinished/runCrashed and from
// app/045-agent-port-bridge-page.js _cleanupStaleForegroundRun). Grepping
// `lastResponseAt` under src/js/worker/ returned ZERO hits, so a run that
// finished while the panel was CLOSED stamped nothing at all: on reopen,
// getActiveChatsList()'s persisted-finish fallback (tools/120-actions.js, `if
// (c && !c.isBackground && !c.isSubAgent && c.lastResponseAt) t =
// c.lastResponseAt`) found no stamp, so the chat never surfaced as
// recently-finished / unseen. Stamp it here — in the SW's own terminal-event
// path — so it survives regardless of whether any page is listening.
//
// ORDERING: these listeners run inside _origEmit (see the emit monkey-patch at
// the top of this file), i.e. BEFORE broadcastAgentEvent() snapshots
// chats[chatId]. runFinished/runCrashed are both in EVENTS_WITH_CHAT_INLINE, so
// a connected panel receives the stamp inlined in the very same envelope.
//
// NO BACKWARDS MOVE / NO FIGHT WITH THE PAGE: the write is monotonic
// (Math.max), and the page-side merge _mergePageChatMeta
// (app/045-agent-port-bridge-page.js) is max-wins on lastResponseAt, so neither
// tier can regress the other. The page's markChatRecentlyFinished still runs
// afterwards (from the re-emitted event) and re-stamps a >= value — a redundant
// but harmless second write of the same finish, and saveChatsToStorage()
// single-flights (worker/115-storage.js _workerSavePending), so a
// runFinished+runCrashed pair for one run costs one IDB transaction.
//
// Skips background (Action) + sub-agent chats for exactly the reason
// markChatRecentlyFinished does: Action chats live under "Active Actions" and
// sub-agents under the Workers strip; lingering them would clutter the badge.
AgentEvents.on('runFinished', _swStampChatFinished);
AgentEvents.on('runCrashed', _swStampChatFinished);
function _swStampChatFinished(e) {
    var chatId = e && e.chatId;
    if (!chatId) return;
    var c = (typeof chats !== 'undefined' && chats) ? chats[chatId] : null;
    if (!c || c.isBackground || c.isSubAgent) return;
    c.lastResponseAt = Math.max(c.lastResponseAt || 0, Date.now());
    // HIST-RECENCY: `updatedAt` was read by the history UI but never written
    // anywhere — stamp it beside every lastResponseAt write. Monotonic for the
    // same dual-writer reason as above (page-side markChatRecentlyFinished
    // stamps it too).
    c.updatedAt = Math.max(c.updatedAt || 0, Date.now());
    // Persist so the stamp survives an MV3 SW eviction — the whole point is a
    // finish nobody was listening to. Fire-and-forget: the save is coalesced
    // and already logs its own failures.
    if (typeof saveChatsToStorage === 'function') {
        try {
            var _p = saveChatsToStorage();
            if (_p && typeof _p.catch === 'function') _p.catch(function() {});
        } catch (err) { console.warn('[sw] finish-stamp persist failed', chatId, err); }
    }
}
