// =============================================================
// AppAgent — `start_chat` tool (PAGE tier).
//
// Opens a NEW chat pre-loaded with a message. The primary use case is a
// BUTTON INSIDE AN html_widget:
//
//     var r = await executeTool('start_chat', {
//         message: 'Why is this SLA breaching?',
//         mode: 'send',              // or 'draft'
//         include_widget: true       // prepend a reference to THIS widget
//     });
//
// so the user can hand a question off to the agent straight from a widget —
// either answered immediately (`mode:'send'`) or dropped into the composer for
// them to edit and submit themselves (`mode:'draft'`).
//
// headless:false (core/080-tools.js HEADLESS_TOOLS) — every primitive below is
// a PAGE-BUNDLE global that has no service-worker mirror:
//   newChat             ui/170-chat-management.js:628
//   sendMessage         app/040-send-message.js:5        (zero args, reads globals)
//   runAgent            app/045-agent-port-bridge-page.js:932
//   autoResizeTextarea  ui/240-layout.js:218
//   updateChatTitle     ui/260-content-format.js:82
//   getWidgetById       tools/080-widget-tools.js:199
//   saveChatsToStorage  ui/070-dashboard-ui.js:2099
//   renderChatList      ui/180-search.js:78
//   renderJobsBadge     tools/120-actions.js:2476
//   showChatView        ui/040-tools-settings.js:2290
//   hideAllPanels       ui/040-tools-settings.js:2260
// The SW therefore routes this tool to a connected panel executor
// (worker/120-tool-routing.js:542 reads isHeadlessTool).
// =============================================================

// Widget-context prefix. NOTE: the id is emitted BARE, not inside backticks —
// decorateIdMentions (ui/250-message-render.js:2111) stashes every <a>/<code>
// span BEFORE it scans for widget_ ids (:2134), so an id the author wrapped in
// backticks renders as plain inline code and never becomes a clickable chip.
// Bare id ⇒ free chip + openWidgetMention (tools/080-widget-tools.js:694).
function _startChatWidgetContextPrefix(widgetId) {
    var title = '';
    try {
        if (typeof getWidgetById === 'function') {
            var w = getWidgetById(widgetId);
            if (w && w.title) title = String(w.title);
        }
        if (!title && typeof dashboardWidgets !== 'undefined' && dashboardWidgets && dashboardWidgets[widgetId] && dashboardWidgets[widgetId].title) {
            title = String(dashboardWidgets[widgetId].title);
        }
    } catch (e) {}
    // Titles can contain quotes/newlines — this string goes into a chat message
    // (plain text, escaped by the renderer), so only flatten the whitespace.
    if (title) title = title.replace(/\s+/g, ' ').trim();
    return 'Context: widget ' + widgetId +
        (title ? ' ("' + title + '")' : '') +
        ' — read it with iframe_tool get_visible_text or take_screenshot.';
}

// Report an ASYNC failure from the two fire-and-forget calls below. runAgent
// (app/045-agent-port-bridge-page.js:932) and sendMessage
// (app/040-send-message.js:5) are BOTH `async function`s, so they never throw
// synchronously — every failure becomes a promise rejection. Wrapping them in a
// bare synchronous try/catch therefore produced a DEAD catch arm and an
// unhandled rejection. This tool has already returned by the time they settle,
// so the failure is reported ON THE CHAT instead of in the tool result:
// chats[id]._lastApiError is the field every jobs surface already reads for a
// failed chat (tools/120-actions.js _isChatErrored → red dot, error pill and a
// Retry button), and it is stamped in exactly the same shape as the runCrashed
// handler (app/036-agent-event-handlers-page.js:521).
function _startChatReportAsyncFailure(chatId, what, err) {
    var msg = (err && err.message) ? err.message : String(err);
    try { console.warn('start_chat: ' + what + '() failed for chat ' + chatId + ': ' + msg, err); } catch (e) {}
    try {
        if (chatId && typeof chats !== 'undefined' && chats && chats[chatId]) {
            if (typeof dispatchChatMeta === 'function') dispatchChatMeta(chatId, { _lastApiError: { message: 'start_chat ' + what + ': ' + msg, chatId: chatId, timestamp: Date.now() } }); // FLUX-4C lane
        }
    } catch (e) {}
    try { if (typeof renderJobsBadge === 'function') renderJobsBadge(); } catch (e) {}
}

// Attach the reporter to a maybe-promise returned by a fire-and-forget call.
// Tolerates a non-thenable return (a stubbed/sync override of the global).
function _startChatWatchAsync(p, chatId, what) {
    if (p && typeof p.catch === 'function') {
        p.catch(function(err) { _startChatReportAsyncFailure(chatId, what, err); });
    }
}

// Resolution order: explicit `widget_id` arg → `options.widgetId` supplied by
// the widget bridge (ui/070-dashboard-ui.js widgetToolCall handler) → the
// currently OPEN fullscreen widget overlay → null. Never fabricated.
function _startChatResolveWidgetId(args, options) {
    if (args && typeof args.widget_id === 'string' && args.widget_id) return args.widget_id;
    if (options && typeof options.widgetId === 'string' && options.widgetId) return options.widgetId;
    // FULLSCREEN OVERLAY. options.widgetId is derived from the iframe's
    // [data-widget-id] ANCESTOR, but a widget expanded to fullscreen is
    // re-rendered into #widget-fullscreen-overlay (tools/080-widget-tools.js
    // openWidgetFullscreen) / the dashboard overlay (ui/070-dashboard-ui.js:82),
    // outside that grid cell — so the ancestor lookup finds nothing and
    // include_widget silently dropped the context. Both overlays already track
    // the open widget in the SAME existing global, `expandedWidgetId` (declared
    // core/130-indexeddb.js:134, set at tools/080-widget-tools.js:409 and
    // ui/070-dashboard-ui.js:82, cleared to null on close at
    // tools/080-widget-tools.js:470 and ui/070-dashboard-ui.js:132) — reuse it
    // rather than inventing a second source of truth. typeof-guarded like every
    // other cross-file global here; it is null whenever no overlay is open, so
    // the documented graceful omission (the `note` at :91) still applies when
    // the id genuinely cannot be resolved.
    if (typeof expandedWidgetId === 'string' && expandedWidgetId) return expandedWidgetId;
    return null;
}

async function executeStartChat(args, options) {
    args = args || {};
    options = options || {};

    var message = (typeof args.message === 'string') ? args.message.trim() : '';
    if (!message) {
        return { success: false, error: 'start_chat requires a non-empty `message` string.' };
    }

    // Unknown mode values fall back to the documented default rather than
    // erroring — a widget button typo should still open the chat.
    var mode = (args.mode === 'draft') ? 'draft' : 'send';
    // `background` is send-only: a draft has to be visible to be edited.
    var background = (mode === 'send') && (args.background === true);

    var widgetId = _startChatResolveWidgetId(args, options);
    var finalMessage = message;
    var widgetContextIncluded = false;
    var note = null;
    if (args.include_widget === true) {
        if (widgetId) {
            finalMessage = _startChatWidgetContextPrefix(widgetId) + '\n\n' + message;
            widgetContextIncluded = true;
        } else {
            note = 'include_widget was true but no widget id could be resolved (no widget_id argument, and the call did not come from a widget iframe) — the context prefix was omitted.';
        }
    }

    var explicitTitle = (typeof args.title === 'string' && args.title.trim()) ? args.title.trim().substring(0, 120) : null;

    // ─── background send ────────────────────────────────────────────────
    // Hand-rolled chat id + runAgent(id), the startAction() skeleton
    // (tools/120-actions.js:554-603) MINUS `isBackground`/`actionId`.
    // Deliberately NOT flagging isBackground: that flag is what hides a chat
    // from the jobs badge (tools/120-actions.js:2243 — "Regular background user
    // chats are NOT flagged isBackground, so this does not hide them") and
    // from the finished-chat bell (ui/165-finished-chat-badge.js:58). We WANT
    // both notifications here. currentChatId is never touched, so the user's
    // view does not move and the calling widget's iframe survives.
    if (background) {
        if (typeof chats === 'undefined' || !chats) {
            return { success: false, error: 'start_chat must run in the side panel (the chats map is not available in this context).' };
        }
        if (typeof runAgent !== 'function') {
            return { success: false, error: 'start_chat cannot run a background chat here (runAgent is not available in this context).' };
        }
        var bgChatId = 'chat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        chats[bgChatId] = {
            id: bgChatId,
            title: explicitTitle || 'New Chat',
            messages: [{ role: 'user', content: finalMessage }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            sourceChatId: options.chatId || ((typeof currentChatId !== 'undefined') ? currentChatId : null) || null
        };
        // Same provisional-title helper sendMessage() uses (app/040-send-message.js
        // → ui/260-content-format.js:82). No-op when explicitTitle was set: the
        // :88 guard early-returns for a non-"New Chat", non-provisional title.
        if (typeof updateChatTitle === 'function') { try { updateChatTitle(chats[bgChatId]); } catch (e) {} }
        if (typeof saveChatsToStorage === 'function') { try { saveChatsToStorage(); } catch (e) {} }
        if (typeof renderChatList === 'function') { try { renderChatList(); } catch (e) {} }
        if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
        // Fire-and-forget: runAgent's promise only settles when the whole new
        // run FINISHES (app/045-agent-port-bridge-page.js:971), so awaiting it
        // would hang this tool call (and the calling widget) for the entire run.
        // runAgent is `async`, so this catch only fires if the global is missing
        // or has been replaced by a non-async throwing stub — a real run failure
        // REJECTS the returned promise, which is what _startChatWatchAsync
        // reports (previously that rejection was unhandled and silently lost).
        var _bgRun;
        try { _bgRun = runAgent(bgChatId); } catch (e) {
            return { success: false, error: 'start_chat created chat ' + bgChatId + ' but could not start the agent: ' + (e && e.message ? e.message : String(e)) };
        }
        _startChatWatchAsync(_bgRun, bgChatId, 'runAgent');
        return {
            success: true,
            chat_id: bgChatId,
            mode: mode,
            sent: true,
            background: true,
            widget_id: widgetId || null,
            widget_context_included: widgetContextIncluded,
            message: finalMessage,
            note: note || 'Running in the background — the view did not switch. The chat shows in the jobs badge while it runs and rings the finished-chat bell when it is done.'
        };
    }

    // ─── foreground (send + draft) ──────────────────────────────────────
    if (typeof newChat !== 'function') {
        return { success: false, error: 'start_chat must run in the side panel (newChat is not available in this context).' };
    }

    // The click can come from a widget rendered inside a fullscreen overlay —
    // close it first or the composer we are about to prefill is not on screen.
    // Same three no-op-when-absent calls as editWidgetWithAgent
    // (tools/080-widget-tools.js:726-728).
    if (typeof closeWidgetFullscreen === 'function') { try { closeWidgetFullscreen(); } catch (e) {} }
    if (typeof closeExpandedWidget === 'function') { try { closeExpandedWidget(); } catch (e) {} }
    if (typeof closeWidgetModal === 'function') { try { closeWidgetModal(); } catch (e) {} }

    // newChat() only closes skills/dashboard/home/settings-page
    // (ui/170-chat-management.js:635-643) — a view it does not know about
    // (e.g. 'history') would stay on top of the chat. Force the switch first,
    // exactly like editDocumentWithAgent (tools/110-smart-documents.js).
    if (typeof currentView !== 'undefined' && currentView !== 'chat') {
        var _knownCloser = (currentView === 'skills' || currentView === 'dashboard' || currentView === 'home' || currentView === 'settings-page');
        if (!_knownCloser) {
            currentView = 'chat';
            if (typeof appStorage !== 'undefined' && appStorage) { try { appStorage.setItem('currentView', 'chat'); } catch (e) {} }
            if (typeof hideAllPanels === 'function') { try { hideAllPanels(); } catch (e) {} }
            if (typeof showChatView === 'function') { try { showChatView(); } catch (e) {} }
        }
    }

    // newChat() BLANKS #message-input at its very end (ui/170-chat-management.js:719-725),
    // so every prefill MUST happen after this call.
    newChat();

    var chatId = (typeof currentChatId !== 'undefined') ? currentChatId : null;
    if (explicitTitle && chatId && chats && chats[chatId]) {
        chats[chatId].title = explicitTitle;
        if (typeof updateChatTitleHeader === 'function') { try { updateChatTitleHeader(); } catch (e) {} }
        if (typeof renderChatList === 'function') { try { renderChatList(); } catch (e) {} }
    }

    var input = document.getElementById('message-input');
    if (!input) {
        return { success: false, error: 'start_chat opened chat ' + chatId + ' but the composer (#message-input) was not found, so the message was not loaded.', chat_id: chatId, mode: mode, sent: false, widget_id: widgetId || null, message: finalMessage };
    }

    input.value = finalMessage;
    if (typeof autoResizeTextarea === 'function') { try { autoResizeTextarea(input); } catch (e) {} }

    if (mode === 'draft') {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        return {
            success: true,
            chat_id: chatId,
            mode: 'draft',
            sent: false,
            background: false,
            widget_id: widgetId || null,
            widget_context_included: widgetContextIncluded,
            message: finalMessage,
            note: note || 'Composer prefilled and focused in a new chat — nothing was sent. The user submits it.'
        };
    }

    // Auto-send: the sendHomeMessage() recipe (ui/030-home-view.js:796-800).
    // sendMessage() takes NO arguments — it reads #message-input + currentChatId
    // + pendingImageAttachments (app/040-send-message.js:5). Fire-and-forget for
    // the same reason as runAgent above: it awaits the whole run internally.
    if (typeof sendMessage !== 'function') {
        return { success: false, error: 'start_chat opened chat ' + chatId + ' and prefilled the composer, but sendMessage is not available in this context — the message was NOT sent.', chat_id: chatId, mode: mode, sent: false, widget_id: widgetId || null, message: finalMessage };
    }
    // Same async shape as runAgent above: sendMessage is `async`, so the catch
    // covers only a synchronous/stubbed throw and the .catch() arm attached by
    // _startChatWatchAsync is what actually reports a failed send.
    var _sendRun;
    try { _sendRun = sendMessage(); } catch (e) {
        return { success: false, error: 'start_chat opened chat ' + chatId + ' but sendMessage threw: ' + (e && e.message ? e.message : String(e)), chat_id: chatId, mode: mode, sent: false, widget_id: widgetId || null, message: finalMessage };
    }
    _startChatWatchAsync(_sendRun, chatId, 'sendMessage');

    return {
        success: true,
        chat_id: chatId,
        mode: 'send',
        sent: true,
        background: false,
        widget_id: widgetId || null,
        widget_context_included: widgetContextIncluded,
        message: finalMessage,
        note: note || 'Sent in a new foreground chat — the view switched to it. A calling widget is torn down by that switch, so do not rely on receiving this return value inside the widget (use background:true if you need to keep the widget alive).'
    };
}
