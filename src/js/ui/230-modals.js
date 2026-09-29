function resolveModal(value) {
    var overlay = document.getElementById('modal-overlay');
    overlay.classList.remove('show');
    overlay.classList.remove('modal-variant-warning');
    overlay.classList.remove('modal-variant-danger');
    // S0C12-01: also drop any content-mode class (ui/220 resetModalContentMode).
    if (typeof resetModalContentMode === 'function') resetModalContentMode(overlay);
    if (modalResolve) { modalResolve(value); modalResolve = null; }
}

// S0C-01: the OK button calls this instead of an inline
// resolveModal(document.getElementById(...).value) - the CSP polyfill cannot
// evaluate that nested expression and resolved the literal JS text instead.
function submitPromptModal() {
    var input = document.getElementById('modal-prompt-input');
    resolveModal(input ? input.value : null);
}

// Helper function for confirm dialogs - returns true if confirmed.
// Optional variant colors the dialog + confirm button by severity:
//   'danger' / 'alert' / 'red'  -> red    (destructive, irreversible)
//   'warning' / 'orange'        -> orange (disruptive, proceed with care)
//   omitted                     -> blue   (normal confirmation)
async function showConfirmModal(title, message, variant) {
    var v = normalizeModalVariant(variant);
    var confirmClass = v === 'danger' ? 'danger' : (v === 'warning' ? 'warning' : 'primary');
    var result = await showModal(title, message, [
        { label: t('Cancel'), value: 'cancel', class: 'secondary' },
        { label: t('Confirm'), value: 'confirm', class: confirmClass }
    ], variant);
    return result === 'confirm';
}

// Helper function for prompt dialogs - returns input value or null
function showPromptModal(title, message, defaultValue) {
    return new Promise(function(resolve) {
        // Bug-sweep F1: never orphan a pending resolver (see ui/220 settlePendingModalResolve).
        if (typeof settlePendingModalResolve === 'function') settlePendingModalResolve();
        modalResolve = resolve;
        var overlay = document.getElementById('modal-overlay');
        // S0C12-01: never inherit a content viewer's mode class (hidden actions).
        if (typeof resetModalContentMode === 'function') resetModalContentMode(overlay);
        var header = document.getElementById('modal-header');
        var body = document.getElementById('modal-body');
        var actions = document.getElementById('modal-actions');
        header.textContent = title;
        body.innerHTML = '<p style="margin:0 0 var(--space-6) 0;">' + escapeHtml(message) + '</p>' +
            '<input type="text" id="modal-prompt-input" class="modal-input" value="' + escapeHtml(defaultValue || '') + '" style="width:100%;padding: var(--space-4) var(--space-6);border:1px solid var(--secondary-border);border-radius:var(--radius-md);font-size:var(--text-body-lg);">';
        actions.innerHTML = '<button class="modal-btn secondary" onclick="resolveModal(null)">' + escapeHtml(t('Cancel')) + '</button>' +
            '<button class="modal-btn primary" onclick="submitPromptModal()">' + escapeHtml(t('OK')) + '</button>';
        overlay.classList.add('show');
        setTimeout(function() {
            var input = document.getElementById('modal-prompt-input');
            if (input) { input.focus(); input.select(); }
        }, 100);
    });
}

// Enter-to-submit for the generic prompt/confirm modals (showModal / showPromptModal).
// Escape-to-cancel is already handled by the global Escape handler in core/120-init.js,
// which calls closeModal() and resolves the pending modal promise with null —
// so Escape is intentionally NOT duplicated here.
document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    // R3b-c: an Enter a focused control already handled (e.g. a chat row) is not a submit.
    if (e.defaultPrevented) return;
    var overlay = document.getElementById('modal-overlay');
    if (!overlay || !overlay.classList.contains('show')) return;
    // Only generic prompt/confirm modals set modalResolve. Bug-sweep F2: the rename
    // modal (ui/210 openRenameModal) does not use a resolver — its Rename button
    // calls confirmRenameChat directly — so also accept it when its input is live.
    var renameInput = document.getElementById('rename-chat-input');
    if (!modalResolve && !(renameInput && overlay.contains(renameInput))) return;
    // Multi-line inputs keep Enter for newlines
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    // Let focused buttons/links activate natively (e.g. Tab to Cancel, then Enter)
    if (e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'A')) return;
    // The confirm button carries the severity class of the dialog variant
    // (primary = blue/normal, warning = orange, danger = red) — accept any of them.
    var primary = document.querySelector('#modal-actions .modal-btn.primary, #modal-actions .modal-btn.warning, #modal-actions .modal-btn.danger');
    if (!primary) return;
    e.preventDefault();
    primary.click();
});
