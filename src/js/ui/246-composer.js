// ============================================
// ONE SHARED COMPOSER (chat + home)
// ============================================
// The chat composer (#message-input, body.html) and the Home composer
// (#home-message-input, 030-home-view.js) share their keyboard, reset, label
// and Send-button logic here. handleKeyDown (app/040) and handleHomeKeyDown
// (ui/030) are one-line delegates to composerHandleKeyDown.
//
// Extension points for later composer items:
//   - registerComposerKeyHandler(fn): fn(e, kind, composer) runs BEFORE the
//     submit logic; return true to consume the key (e.g. a picker / history).
//   - COMPOSERS[kind]: add per-composer config (hint ids, history, ...);
//     syncSendButton iterates it.
//
// Item 7 (history recall) and item 8 (large paste / draft size) live at the
// bottom of this file; the history handler is a registered key handler.

var COMPOSERS = {
    chat: {
        inputId: 'message-input',
        sendBtnId: 'send-btn',
        hintId: 'message-draft-hint',
        history: true,
        submit: function() { return sendMessage(); }
    },
    home: {
        inputId: 'home-message-input',
        sendBtnId: 'home-send-btn',
        hintId: 'home-draft-hint',
        history: false,
        submit: function() { return sendHomeMessage(); }
    }
};

var _composerKeyHandlers = [];

// Register a keydown handler shared by every composer. Returns an
// unregister function. A handler returning true consumes the event.
// opts.first: run before the handlers already registered (the item 10
// picker uses it so it sees ArrowUp/Down/Esc before history recall).
function registerComposerKeyHandler(fn, opts) {
    if (typeof fn !== 'function') return function() {};
    if (opts && opts.first) _composerKeyHandlers.unshift(fn);
    else _composerKeyHandlers.push(fn);
    return function() {
        var i = _composerKeyHandlers.indexOf(fn);
        if (i !== -1) _composerKeyHandlers.splice(i, 1);
    };
}

// Plain Enter submits. Shift+Enter is a newline, and Enter while an IME is
// composing (CJK: isComposing=true / keyCode 229) commits the candidate
// instead of sending the message.
function composerIsSubmitKey(e) {
    return !!e && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

function composerHandleKeyDown(e, kind) {
    var composer = COMPOSERS[kind];
    if (!composer || !e) return;
    for (var i = 0; i < _composerKeyHandlers.length; i++) {
        var consumed = false;
        try { consumed = _composerKeyHandlers[i](e, kind, composer) === true; } catch (err) {
            consumed = false;
            if (typeof console !== 'undefined' && console.warn) console.warn('[composer] key handler failed:', err);
        }
        if (consumed) return;
    }
    if (composerIsSubmitKey(e)) {
        e.preventDefault();
        composer.submit();
    }
}

// Clear a composer after its content was sent: empty value, height back to
// one line, Send button state repainted.
function composerResetInput(input) {
    if (!input) return;
    input.value = '';
    input.style.height = 'auto';
    // No dismissed / no-match picker state carries into the next message.
    if (typeof composerPickerResetState === 'function') composerPickerResetState();
    // Sent / cleared: end history browsing for this composer + chat.
    if (typeof _composerHistoryDrop === 'function' && typeof composerKindForInput === 'function') {
        _composerHistoryDrop(composerKindForInput(input));
    }
    if (typeof syncSendButton === 'function') syncSendButton();
    if (typeof composerSyncDraftSize === 'function') composerSyncDraftSize(input);
}

// '[User attached 2 image(s) and 1 PDF(s)]' for a list of pending
// attachments ('' when there are none). Order: images, PDFs, files, documents.
function buildAttachmentLabel(atts) {
    var list = Array.isArray(atts) ? atts : [];
    var counts = { image: 0, pdf: 0, file: 0, document: 0 };
    list.forEach(function(a) {
        var ft = a && a.fileType;
        if (!ft || ft === 'image') counts.image++;
        else if (counts.hasOwnProperty(ft)) counts[ft]++;
    });
    var parts = [];
    if (counts.image > 0) parts.push(counts.image + ' image(s)');
    if (counts.pdf > 0) parts.push(counts.pdf + ' PDF(s)');
    if (counts.file > 0) parts.push(counts.file + ' file(s)');
    if (counts.document > 0) parts.push(counts.document + ' document(s)');
    return parts.length ? '[User attached ' + parts.join(' and ') + ']' : '';
}

// ITEM 11 (Send -> Stop): the chat composer's run state. 'stop' while the
// displayed chat's run is live (Pause control state 'pause'), 'interrupting'
// after Stop/Pause was pressed but the loop has not ended yet (state
// 'resume' while the loop is still active), else null. Home never runs.
function composerRunMode(kind) {
    if (kind !== 'chat') return null;
    if (typeof currentView !== 'undefined' && currentView && currentView !== 'chat') return null;
    var id = typeof currentChatId !== 'undefined' ? currentChatId : null;
    if (!id || typeof _chatControlsState !== 'function' || typeof _isChatLoopActive !== 'function') return null;
    if (!_isChatLoopActive(id)) return null;
    var st = _chatControlsState(id);
    return st === 'pause' ? 'stop' : st === 'resume' ? 'interrupting' : null;
}

function _composerSendIconId(kind) { return kind === 'home' ? 'home-send-icon' : 'send-icon'; }

// Set a translated attribute and point applyI18n's record (ui/245
// _i18nAttrOrig) at its English key, so a later applyI18n (language switch)
// re-translates the current mode instead of keeping a stale string.
function _composerSetI18nAttr(btn, name, key, label) {
    if (btn.getAttribute(name) !== label) btn.setAttribute(name, label);
    try {
        if (typeof _i18nAttrOrig !== 'undefined' && _i18nAttrOrig && typeof _i18nAttrOrig.get === 'function') {
            var recs = _i18nAttrOrig.get(btn) || {};
            recs[name] = { orig: key, applied: label };
            _i18nAttrOrig.set(btn, recs);
        }
    } catch (e) {}
}

// Label, title and aria-disabled are (re)applied on every sync; icon and
// class only when the mode changes (data-mode on the button).
function _composerPaintSendMode(btn, kind, mode) {
    var hasAttr = typeof btn.getAttribute === 'function' && typeof btn.setAttribute === 'function';
    var cur = hasAttr ? (btn.getAttribute('data-mode') || 'send') : (btn._composerMode || 'send');
    var T = typeof t === 'function' ? t : function(k) { return k; };
    var key = mode === 'stop' ? 'Stop' : mode === 'interrupting' ? 'Interrupting…' : 'Send message';
    var label = mode === 'stop' ? T('Stop') : mode === 'interrupting' ? T('Interrupting…') : T('Send message');
    if (hasAttr) {
        _composerSetI18nAttr(btn, 'aria-label', key, label);
        if (mode === 'send') { if (btn.getAttribute('title') !== null && typeof btn.removeAttribute === 'function') btn.removeAttribute('title'); }
        else _composerSetI18nAttr(btn, 'title', key, label);
        // Interrupting is aria-disabled, not disabled: the button keeps focus.
        if (mode === 'interrupting') { if (btn.getAttribute('aria-disabled') !== 'true') btn.setAttribute('aria-disabled', 'true'); }
        else if (btn.getAttribute('aria-disabled') !== null && typeof btn.removeAttribute === 'function') btn.removeAttribute('aria-disabled');
    }
    if (cur === mode) return;
    if (hasAttr) btn.setAttribute('data-mode', mode); else btn._composerMode = mode;
    if (btn.classList) {
        if (mode === 'send') btn.classList.remove('is-stop'); else btn.classList.add('is-stop');
    }
    var icon = document.getElementById(_composerSendIconId(kind));
    var icons = typeof UI_ICONS !== 'undefined' && UI_ICONS ? UI_ICONS : {};
    if (icon) icon.innerHTML = (mode === 'send' ? icons.send : icons.stop) || '';
}

// Grey out Send on every registered composer when there is nothing to send —
// no text and no attachment. Enter on an empty box was already a no-op
// (sendMessage / sendHomeMessage return early); this only reflects that state.
// Item 11: while the chat runs and the draft is empty, the chat Send button
// becomes Stop (togglePause, via the capture click listener below), then a
// disabled 'Interrupting…' until the loop ends. Text typed mid-run keeps Send
// (it is injected into the run). Run-state changes re-sync from
// syncChatControlsUI (app/020).
function syncSendButton() {
    var hasAttach = typeof pendingImageAttachments !== 'undefined' && !!pendingImageAttachments && pendingImageAttachments.length > 0;
    Object.keys(COMPOSERS).forEach(function(kind) {
        var c = COMPOSERS[kind];
        var btn = document.getElementById(c.sendBtnId);
        if (!btn) return;
        var inp = document.getElementById(c.inputId);
        var empty = !hasAttach && !(inp && inp.value.trim());
        var mode = (empty && composerRunMode(kind)) || 'send';
        _composerPaintSendMode(btn, kind, mode);
        btn.disabled = mode === 'send' ? empty : false;
    });
}

// Stop click: intercept in the capture phase so the inline onclick="sendMessage()"
// (body.html) never runs, then pause the displayed chat's run.
function composerSendButtonClick(e) {
    var tgt = e && e.target;
    var btn = tgt && typeof tgt.closest === 'function' ? tgt.closest('#send-btn') : null;
    var mode = btn && typeof btn.getAttribute === 'function' ? btn.getAttribute('data-mode') : null;
    if (mode !== 'stop' && mode !== 'interrupting') return false;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    else if (typeof e.stopPropagation === 'function') e.stopPropagation();
    // Interrupting (aria-disabled): swallow the click, keep focus, no toggle.
    if (mode === 'interrupting' || btn.disabled) return true;
    if (typeof togglePause === 'function') togglePause();
    syncSendButton();
    return true;
}

if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('click', composerSendButtonClick, true);
}

// ============================================
// ITEM 7: HISTORY RECALL (chat composer only, COMPOSERS[kind].history)
// ============================================
// ArrowUp in an empty composer (or with the caret at 0) recalls the previous
// user message of the current chat; further ArrowUp walks older, ArrowDown
// walks newer and finally restores the draft; Escape restores the draft.
// Editing a recalled entry keeps browsing: the edit is kept for that entry
// while walking, and ArrowDown past the newest entry / Escape still restore
// the original draft. Browsing state is kept per chat, like chatPendingTexts:
// after a chat switch the composer comes back with the recalled text (saved as
// that chat's pending text) and the draft is still one Esc away. A value set
// from outside (no 'input' event) ends browsing.

var COMPOSER_HISTORY_MAX = 100;
var _COMPOSER_ATTACH_LABEL_RE = /^\[User attached [^\]\n]*\]$/;
// 040 sendWidgetMessage prefix; case-insensitive so a copy-edit of the marker
// (e.g. '[Widget mode]') does not leak wrapper prompts into recall.
var _COMPOSER_WIDGET_MODE_RE = /^\[widget mode\]/i;
// kind + ':' + chatId -> {index, draft, entries, edits, shown} while browsing.
var _composerHistoryStates = {};
var COMPOSER_HISTORY_STATES_MAX = 20;

// Visible text a user typed for one message row.
function _composerRowText(m) {
    if (!m) return '';
    var c = m.content, text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
        text = c.filter(function(p) { return p && p.type === 'text' && typeof p.text === 'string'; })
            .map(function(p) { return p.text; }).join('\n');
    }
    // Injected rows carry sub-agent notices inline: strip each span once.
    if (m.injected && Array.isArray(m.subNotices)) {
        m.subNotices.forEach(function(sn) {
            if (!sn || typeof sn.text !== 'string' || !sn.text) return;
            var i = text.indexOf(sn.text);
            if (i !== -1) text = text.slice(0, i) + text.slice(i + sn.text.length);
        });
    }
    return text.trim();
}

function _composerIsUserRow(m) {
    if (!m) return false;
    if (typeof _isRealUserRow === 'function') return !!_isRealUserRow(m);
    return m.role === 'user' && (!m.injected || m.hasUserText === true);
}

// Pure: newest-first list of the user's own messages in a chat (no hook
// rows, widget-mode wrappers or bare attachment labels), consecutive
// duplicates collapsed, capped at COMPOSER_HISTORY_MAX.
function composerUserHistory(chat) {
    var out = [];
    var msgs = chat && Array.isArray(chat.messages) ? chat.messages : [];
    for (var i = msgs.length - 1; i >= 0 && out.length < COMPOSER_HISTORY_MAX; i--) {
        var m = msgs[i];
        if (!_composerIsUserRow(m) || m.isHookMessage === true) continue;
        var text = _composerRowText(m);
        if (!text || _COMPOSER_WIDGET_MODE_RE.test(text) || _COMPOSER_ATTACH_LABEL_RE.test(text)) continue;
        if (out.length && out[out.length - 1] === text) continue;
        out.push(text);
    }
    return out;
}

// Pure state machine. state = {index, draft} or null (not browsing);
// entries newest-first. Returns {state, value} or null (key not handled).
function composerHistoryStep(state, dir, entries, value) {
    var list = Array.isArray(entries) ? entries : [];
    var idx = state ? state.index : -1;
    var draft = state ? state.draft : value;
    if (dir === 'up') {
        if (idx === -1) {
            if (!list.length) return null;
            return { state: { index: 0, draft: value }, value: list[0] };
        }
        if (idx >= list.length - 1) return null;
        return { state: { index: idx + 1, draft: draft }, value: list[idx + 1] };
    }
    if (dir === 'down') {
        if (idx === -1) return null;
        if (idx === 0) return { state: null, value: draft };
        return { state: { index: idx - 1, draft: draft }, value: list[idx - 1] };
    }
    if (dir === 'escape') {
        if (idx === -1) return null;
        return { state: null, value: draft };
    }
    return null;
}

// Pure: which history direction a keydown means ('up' | 'down' | 'escape' | null).
function composerHistoryKeyDir(e, input, browsing) {
    if (!e || !input) return null;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
    if (e.isComposing || e.keyCode === 229) return null;
    var value = typeof input.value === 'string' ? input.value : '';
    var s = input.selectionStart, en = input.selectionEnd;
    var noSel = s === en;
    if (e.key === 'Escape') return browsing ? 'escape' : null;
    if (e.key === 'ArrowUp') return (!value || (noSel && s === 0)) ? 'up' : null;
    if (e.key === 'ArrowDown') {
        if (!browsing || !noSel) return null;
        return value.indexOf('\n', en) === -1 ? 'down' : null;
    }
    return null;
}

function _composerCurrentChatId() {
    return (typeof currentChatId !== 'undefined') ? currentChatId : null;
}

function _composerHistoryKey(kind) {
    return kind + ':' + _composerCurrentChatId();
}

function _composerHistoryDrop(kind) {
    if (kind) delete _composerHistoryStates[_composerHistoryKey(kind)];
}

function _composerHistorySet(kind, h) {
    var key = _composerHistoryKey(kind);
    delete _composerHistoryStates[key];
    if (!h) return;
    _composerHistoryStates[key] = h;
    var keys = Object.keys(_composerHistoryStates);
    for (var i = 0; i < keys.length - COMPOSER_HISTORY_STATES_MAX; i++) delete _composerHistoryStates[keys[i]];
}

// The live browsing state for this composer in the current chat, or null.
// A state whose text was replaced from outside (no 'input' event) is dropped.
function _composerHistoryCurrent(kind, input) {
    var key = _composerHistoryKey(kind);
    var h = _composerHistoryStates[key];
    if (!h) return null;
    if (!input || input.value !== h.shown) {
        delete _composerHistoryStates[key];
        return null;
    }
    return h;
}

// 'input' on a composer (typing, paste, cut, undo): an edit of the recalled
// entry is remembered for that entry and browsing continues.
function composerHistoryNoteInput(input) {
    var kind = composerKindForInput(input);
    if (!kind) return;
    var h = _composerHistoryStates[_composerHistoryKey(kind)];
    if (!h || input.value === h.shown) return;
    h.edits[h.index] = input.value;
    h.shown = input.value;
}

if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('input', function(e) {
        if (e && e.target) composerHistoryNoteInput(e.target);
    }, true);
}

// True while the focused composer is showing a recalled entry (320
// kbdCanPause yields Esc to the composer then).
function composerIsBrowsingHistory() {
    if (typeof document === 'undefined' || !document) return false;
    var input = document.activeElement;
    var kind = composerKindForInput(input);
    if (!kind) return false;
    return !!_composerHistoryCurrent(kind, input);
}

// Set the composer value as one undoable edit where the browser supports it
// (execCommand fires 'input' itself), else via composerInsertText, which
// fires 'input'. Either way draft persistence, resize and size sync run.
function _composerReplaceValue(input, val) {
    var done = false;
    try {
        if (typeof document !== 'undefined' && document && document.activeElement === input
            && typeof document.execCommand === 'function' && typeof input.select === 'function') {
            input.select();
            done = document.execCommand(val ? 'insertText' : 'delete', false, val) === true && input.value === val;
        }
    } catch (err) { done = false; }
    if (!done) composerInsertText(input, val, 0, (input.value || '').length);
}

function _composerHistoryKeyHandler(e, kind, composer) {
    if (!composer || !composer.history || !e) return false;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Escape') return false;
    var input = e.target && e.target.id === composer.inputId ? e.target
        : (typeof document !== 'undefined' ? document.getElementById(composer.inputId) : null);
    if (!input) return false;
    var cur = _composerHistoryCurrent(kind, input);
    var dir = composerHistoryKeyDir(e, input, !!cur);
    if (!dir) return false;
    var entries = cur ? cur.entries
        : composerUserHistory((typeof chats !== 'undefined' && chats) ? chats[_composerCurrentChatId()] : null);
    var edits = cur ? cur.edits : {};
    // Entries as the user left them (edited ones show the edit).
    var view = entries.map(function(x, i) { return Object.prototype.hasOwnProperty.call(edits, i) ? edits[i] : x; });
    var step = composerHistoryStep(cur ? { index: cur.index, draft: cur.draft } : null, dir, view, input.value);
    if (!step) return false;
    e.preventDefault();
    var val = typeof step.value === 'string' ? step.value : '';
    // State first: the 'input' fired by the replace must see value === shown.
    _composerHistorySet(kind, step.state ? {
        index: step.state.index, draft: step.state.draft, entries: entries, edits: edits, shown: val
    } : null);
    _composerReplaceValue(input, val);
    // Recalled entry: caret at 0 so ArrowDown walks a multi-line entry
    // natively first. Restored draft: caret at the end.
    var pos = step.state ? 0 : val.length;
    try { input.setSelectionRange(pos, pos); } catch (err) {}
    // The replace fired 'input' with the caret at the end, which may have
    // opened the picker on a recalled '@word' / '/word': close it, and keep
    // a restored draft's token dismissed so the delayed selectionchange
    // (caret at the end) does not reopen it.
    if (typeof composerPickerDismissAt === 'function') composerPickerDismissAt(input);
    else if (typeof composerPickerIsOpen === 'function' && composerPickerIsOpen() && typeof composerPickerClose === 'function') composerPickerClose();
    if (typeof autoResizeTextarea === 'function') autoResizeTextarea(input);
    return true;
}

registerComposerKeyHandler(_composerHistoryKeyHandler);

// ============================================
// ITEM 8: LARGE PASTES + DRAFT SIZE
// ============================================

var COMPOSER_LARGE_PASTE_CHARS = 20000;
var COMPOSER_DRAFT_HINT_CHARS = 2000;

// Pure: a paste above COMPOSER_LARGE_PASTE_CHARS is offered as a .txt file.
function composerShouldOfferPasteAsFile(text) {
    return typeof text === 'string' && text.length > COMPOSER_LARGE_PASTE_CHARS;
}

// Same estimate as 240 estimateTokens (~4 chars per token).
function composerDraftTokens(text) {
    return (typeof text === 'string' && text) ? Math.ceil(text.length / 4) : 0;
}

function _composerFmtNum(n) {
    try { return Number(n).toLocaleString(); } catch (e) { return String(n); }
}

// '' for short drafts, else '12,345 characters · ~3,087 tokens'.
function composerDraftHintText(text) {
    var len = typeof text === 'string' ? text.length : 0;
    if (len <= COMPOSER_DRAFT_HINT_CHARS) return '';
    var vars = { chars: _composerFmtNum(len), tokens: _composerFmtNum(composerDraftTokens(text)) };
    if (typeof t === 'function') return t('{chars} characters · ~{tokens} tokens', vars);
    return vars.chars + ' characters · ~' + vars.tokens + ' tokens';
}

function composerKindForInput(input) {
    if (!input || !input.id) return null;
    var kinds = Object.keys(COMPOSERS);
    for (var i = 0; i < kinds.length; i++) {
        if (COMPOSERS[kinds[i]].inputId === input.id) return kinds[i];
    }
    return null;
}

var _composerCtxTimer = null;
// Paint the draft-size hint under a composer; for the chat composer also
// refresh the context ring (debounced) since it includes the draft.
function composerSyncDraftSize(input) {
    var kind = composerKindForInput(input);
    if (!kind) return;
    var c = COMPOSERS[kind];
    var hint = (c.hintId && typeof document !== 'undefined') ? document.getElementById(c.hintId) : null;
    if (hint) {
        var txt = composerDraftHintText(input.value);
        if (hint.textContent !== txt) hint.textContent = txt;
        hint.hidden = !txt;
    }
    if (kind === 'chat' && typeof updateContextIndicator === 'function') {
        if (_composerCtxTimer) clearTimeout(_composerCtxTimer);
        _composerCtxTimer = setTimeout(function() {
            _composerCtxTimer = null;
            try { updateContextIndicator(); } catch (e) {}
        }, 150);
    }
}

// Replace [start, end) of the composer value with text, put the caret after
// it and fire 'input' so resize / draft persistence run.
function composerInsertText(input, text, start, end) {
    if (!input) return;
    var v = typeof input.value === 'string' ? input.value : '';
    var s = typeof start === 'number' ? Math.max(0, Math.min(start, v.length)) : v.length;
    var en = typeof end === 'number' ? Math.max(s, Math.min(end, v.length)) : s;
    var ins = typeof text === 'string' ? text : '';
    input.value = v.slice(0, s) + ins + v.slice(en);
    var pos = s + ins.length;
    try { input.setSelectionRange(pos, pos); } catch (e) {}
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {
        if (typeof autoResizeTextarea === 'function') autoResizeTextarea(input);
    }
}

// Ask whether a very large paste should become a .txt attachment.
async function composerOfferPasteAsFile(input, text) {
    if (!input || typeof text !== 'string') return null;
    var start = input.selectionStart, end = input.selectionEnd;
    var choice = null;
    try {
        choice = await showModal(t('Large paste'),
            escapeHtml(t('This paste is {chars} characters long. Attach it as a .txt file instead?', { chars: _composerFmtNum(text.length) })),
            [
                { label: t('Cancel'), value: 'cancel', class: 'secondary' },
                { label: t('Paste as text'), value: 'text', class: 'secondary' },
                { label: t('Attach as file'), value: 'file', class: 'primary' }
            ]);
    } catch (e) { choice = null; }
    if (choice === 'file') {
        if (typeof processImageFile === 'function') processImageFile(new File([text], 'pasted-text.txt', { type: 'text/plain' }));
    } else if (choice === 'text') {
        composerInsertText(input, text, start, end);
    }
    try { if (input.isConnected !== false) input.focus(); } catch (e) {}
    return choice;
}
