// =============================================================
// Finished-chat bell — rendered INSIDE the jobs badge (⚡ pill).
//
// notifyFinish only fires a BROWSER notification when the user is
// away from the extension page. When the user IS on the page but
// viewing a different chat (or the home/history view), nothing
// happened — this module tracks those "finished while you were
// elsewhere" chats and renderJobsBadge() (tools/120-actions.js)
// appends an orange bell segment to the jobs badge while any are
// unseen. Opening the chat (selectChat / back-to-chat-view)
// consumes its entry. Session-only by design (not persisted).
// =============================================================

// chatId -> { at: ms, hasError: bool }
var _unseenFinishedChats = {};

// Consumed by renderJobsBadge(). Prunes deleted chats, returns the
// aggregate the bell segment needs.
function getUnseenFinishedChatsInfo() {
    var count = 0, hasError = false;
    Object.keys(_unseenFinishedChats).forEach(function(cid) {
        if (typeof chats === 'undefined' || !chats[cid]) { delete _unseenFinishedChats[cid]; return; }
        // Self-heal: the focused chat in the chat view is by definition 'seen'.
        // Covers entry points that bypass selectChat()/showChatView() (e.g.
        // browser Back/Forward popstate navigation).
        if (typeof currentChatId !== 'undefined' && cid === currentChatId &&
            (typeof currentView === 'undefined' || currentView === 'chat')) {
            delete _unseenFinishedChats[cid];
            return;
        }
        // Read-side gating: only count entries the per-row bell predicate would
        // actually render. renderJobsBadge()'s row bell is _cUnseen = !running
        // && !error && unseen-activity, and _jobsChatState() resolves to
        // 'running'/'error' BEFORE 'unseen'. Without this gate an errored (or
        // re-running) chat — stamped into the map by noteChatFinishedUnseen()
        // for BOTH success and error finishes — would put a bell on the pill
        // with no matching row bell. Merely SKIP (do NOT delete) so a chat whose
        // state later flips back to genuinely-unseen is counted on a later
        // render instead of being permanently lost. typeof-guard: _jobsChatState
        // lives in the tools tier (loaded after this ui-tier file), so it can be
        // undefined at early call times — fall through to the legacy count then.
        if (typeof _jobsChatState === 'function' && _jobsChatState(cid) !== 'unseen') return;
        count++;
        if (_unseenFinishedChats[cid].hasError) hasError = true;
    });
    return { count: count, hasError: hasError };
}

// Called from the notifyFinish handler (036-agent-event-handlers-page.js)
// when a run finishes on a chat the user is not currently viewing.
function noteChatFinishedUnseen(chatId, hasError) {
    if (!chatId) return;
    var c = (typeof chats !== 'undefined') ? chats[chatId] : null;
    if (!c) return;
    // Same exclusions as markChatRecentlyFinished(): sub-agent chats are
    // invisible plumbing, Action (background) chats have their own
    // action-button surface — neither belongs on the bell.
    if (c.isSubAgent || c.isBackground) return;
    // Skip only when the user is ACTUALLY LOOKING at this chat: currentChatId
    // matches AND the chat view is the active view. On home/history/settings
    // views currentChatId still points at the last-viewed chat, but the user
    // can't see its messages — the bell must fire there too.
    var viewingIt = (typeof currentChatId !== 'undefined' && chatId === currentChatId) &&
        (typeof currentView === 'undefined' || currentView === 'chat');
    if (viewingIt) return;
    _unseenFinishedChats[chatId] = { at: Date.now(), hasError: !!hasError };
    renderFinishedChatsBadge(true);
}

// Called from selectChat() and showChatView() — viewing the chat consumes
// its entry.
function clearUnseenFinishedChat(chatId) {
    if (!_unseenFinishedChats[chatId]) return;
    delete _unseenFinishedChats[chatId];
    renderFinishedChatsBadge(false);
}

// The bell lives inside the jobs badge, so 'rendering' it means re-rendering
// the jobs badge. `justAdded` fires a one-shot orange pop on the pill.

// Shared removal timer: when a second pop lands inside the 1.4s window, the
// FIRST pop's stale timeout must not strip the class mid-animation of the
// newer pop — clear it and reschedule.
var _bellPopTimer = null;

function renderFinishedChatsBadge(justAdded) {
    if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
    if (!justAdded) return;
    var badges = document.querySelectorAll('.jobs-badge');
    badges.forEach(function(badge) {
        if (badge.style.display === 'none') return;
        badge.classList.remove('bell-pop');
        void badge.offsetWidth; // force reflow so the animation re-triggers
        badge.classList.add('bell-pop');
    });
    if (_bellPopTimer) clearTimeout(_bellPopTimer);
    _bellPopTimer = setTimeout(function() {
        _bellPopTimer = null;
        document.querySelectorAll('.jobs-badge').forEach(function(badge) {
            badge.classList.remove('bell-pop');
        });
    }, 1400);
}
