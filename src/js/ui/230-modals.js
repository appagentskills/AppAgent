// Show request body modal with JSON formatting (collapse/expand)
var currentRequestBodyJson = null;
function showRequestBodyModal(requestBodyId) {
    var el = document.getElementById(requestBodyId);
    if (!el) return;
    
    var requestBody;
    try {
        requestBody = JSON.parse(decodeURIComponent(el.getAttribute('data-json')));
    } catch (e) {
        showSnackbar('Failed to parse request body', 'error');
        return;
    }
    
    currentRequestBodyJson = requestBody;
    
    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');
    
    header.innerHTML = '<span class="modal-title-text">API Request Body</span><div class="modal-header-actions">' +
        '<button class="modal-edit-btn" onclick="downloadRequestBodyJson()" title="Download JSON">' + UI_ICONS.download + '</button>' +
        '<button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';
    body.innerHTML = '<div class="json-viewer-container"><pre class="json-viewer">' + formatJsonValue(requestBody, 0) + '</pre></div>';
    actions.innerHTML = '';
    
    overlay.classList.add('show');
    overlay.classList.add('request-body-modal');
}

function downloadRequestBodyJson() {
    if (!currentRequestBodyJson) return;
    var blob = new Blob([JSON.stringify(currentRequestBodyJson, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'api-request-' + new Date().toISOString().slice(0, 19).replace(/[:-]/g, '') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showSnackbar('Request body downloaded', 'success');
}

function resolveModal(value) {
    document.getElementById('modal-overlay').classList.remove('show');
    if (modalResolve) { modalResolve(value); modalResolve = null; }
}

// Helper function for confirm dialogs - returns true if confirmed
async function showConfirmModal(title, message) {
    var result = await showModal(title, message, [
        { label: 'Cancel', value: 'cancel', class: 'secondary' },
        { label: 'Confirm', value: 'confirm', class: 'primary' }
    ]);
    return result === 'confirm';
}

// Helper function for prompt dialogs - returns input value or null
function showPromptModal(title, message, defaultValue) {
    return new Promise(function(resolve) {
        modalResolve = resolve;
        var overlay = document.getElementById('modal-overlay');
        var header = document.getElementById('modal-header');
        var body = document.getElementById('modal-body');
        var actions = document.getElementById('modal-actions');
        header.textContent = title;
        body.innerHTML = '<p style="margin:0 0 var(--space-6) 0;">' + escapeHtml(message) + '</p>' +
            '<input type="text" id="modal-prompt-input" class="modal-input" value="' + escapeHtml(defaultValue || '') + '" style="width:100%;padding: var(--space-4) var(--space-6);border:1px solid var(--secondary-border);border-radius:var(--radius-md);font-size:var(--text-body-lg);">';
        actions.innerHTML = '<button class="modal-btn secondary" onclick="resolveModal(null)">Cancel</button>' +
            '<button class="modal-btn primary" onclick="resolveModal(document.getElementById(\'modal-prompt-input\').value)">OK</button>';
        overlay.classList.add('show');
        setTimeout(function() {
            var input = document.getElementById('modal-prompt-input');
            if (input) { input.focus(); input.select(); }
        }, 100);
    });
}
