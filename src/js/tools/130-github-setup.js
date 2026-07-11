// =============================================================
// github_setup tool — opens a popup that helps the user connect a
// GitHub account (PAT) and add (clone) repositories into the workspace.
//
// Page-only (headless: false in core/080-tools.js): the SW routes the
// call to a connected panel executor; this file is NOT part of the
// worker bundle (not in build/build.js WORKER_SHARED_FILES).
//
// Reuses the exact same storage + validation helpers as the Settings
// page: loadGitHubSettings / validateGitHubToken / saveGitHubSettings
// (core/130-indexeddb.js) and wsClone (tools/020-tool-execution.js).
// The popup is NON-BLOCKING: the tool resolves as soon as it is shown.
// =============================================================

async function executeGitHubSetup(args) {
    args = args || {};
    var gh = await loadGitHubSettings();
    var connected = !!(gh.user && gh.token);
    var instanceUrl = (args.instance_url || gh.instanceUrl || 'https://github.com').replace(/\/$/, '');
    var tokenPageUrl = instanceUrl + '/settings/tokens/new?scopes=repo&description=AppAgent';

    showGitHubSetupModal({
        connected: connected,
        user: gh.user || null,
        instanceUrl: instanceUrl,
        repo: (args.repo || '').trim(),
        branch: (args.branch || '').trim()
    });

    // Optionally open the token page directly (only useful pre-connection).
    var openedTokenPage = false;
    if (args.open_token_page && !connected) {
        try { window.open(tokenPageUrl, '_blank'); openedTokenPage = true; } catch (e) {}
    }

    return {
        success: true,
        opened: 'github-setup-popup',
        connected: connected,
        user: connected ? gh.user.login : null,
        token_page_url: connected ? undefined : tokenPageUrl,
        opened_token_page: openedTokenPage,
        prefilled_repo: args.repo || null,
        prefilled_branch: args.branch || null,
        note: 'Popup is non-blocking; the user completes it on their own. Verify later with workspace {action:"list"} (cloned repos appear there) or ask the user.'
    };
}

function showGitHubSetupModal(opts) {
    var existing = document.getElementById('github-setup-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'github-setup-modal';
    overlay.className = 'modal-overlay show';
    overlay.onclick = function(e) { if (e.target === overlay) closeGitHubSetupModal(); };

    var html =
        '<div class="modal-dialog" style="max-width:520px;">' +
            '<div class="modal-header">' + UI_ICONS.git + ' GitHub Setup</div>' +
            '<div class="modal-body" style="display:flex;flex-direction:column;gap:var(--space-8);">';

    if (opts.connected) {
        // Connected state — show who we are, then the clone form below.
        html +=
            '<div style="display:flex;align-items:center;gap:var(--space-4);">' +
                (opts.user && opts.user.avatar_url ? '<img src="' + escapeHtml(opts.user.avatar_url + (opts.user.avatar_url.indexOf('?') >= 0 ? '&' : '?') + 's=32') + '" style="width:32px;height:32px;border-radius:50%;" />' : '') +
                '<div>' +
                    '<div class="settings-page-row-label">Connected as ' + escapeHtml((opts.user && opts.user.login) || '') + '</div>' +
                    '<div class="settings-page-row-hint">' + escapeHtml(opts.instanceUrl) + '</div>' +
                '</div>' +
            '</div>';
    } else {
        // Not connected — token form with a direct link to the token page.
        html +=
            '<div class="form-field">' +
                '<label class="form-label">Instance URL</label>' +
                '<input type="text" id="ghsetup-instance" class="form-input" value="' + escapeHtml(opts.instanceUrl) + '" placeholder="https://github.com">' +
            '</div>' +
            '<div class="form-field">' +
                '<label class="form-label">Personal Access Token <span class="required">*</span></label>' +
                '<input type="password" id="ghsetup-token" class="form-input" placeholder="ghp_..." onkeydown="if(event.key===\'Enter\')connectGitHubFromSetupModal()">' +
                '<div class="settings-page-row-hint" style="margin-top:var(--space-2);">Requires <code>repo</code> scope. ' +
                    '<a href="#" id="ghsetup-token-link" onclick="openGitHubSetupTokenPage(event)" style="color:var(--accent);">Open GitHub token page</a>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex;justify-content:flex-end;align-items:center;gap:var(--space-4);">' +
                '<span id="ghsetup-connect-status" style="font-size:var(--text-body-sm);flex:1;"></span>' +
                '<button class="skills-action-btn" id="ghsetup-connect-btn" onclick="connectGitHubFromSetupModal()">Connect</button>' +
            '</div>';
    }

    // Clone section — always present; disabled until connected.
    html +=
        '<div style="border-top:1px solid var(--border);padding-top:var(--space-6);">' +
            '<div class="settings-page-row-label" style="margin-bottom:var(--space-4);">Add a repository</div>' +
            (opts.connected ? '' : '<div class="settings-page-row-hint" style="margin-bottom:var(--space-4);">Connect your account above first, then clone.</div>') +
            '<div style="display:flex;gap:var(--space-4);align-items:center;">' +
                '<input type="text" id="ghsetup-repo" class="form-input" style="flex:1;" placeholder="owner/repo" value="' + escapeHtml(opts.repo || '') + '" onkeydown="if(event.key===\'Enter\')cloneGitHubRepoFromSetupModal()">' +
                '<input type="text" id="ghsetup-branch" class="form-input" style="width:130px;" placeholder="branch (optional)" value="' + escapeHtml(opts.branch || '') + '" onkeydown="if(event.key===\'Enter\')cloneGitHubRepoFromSetupModal()">' +
                '<button class="skills-action-btn" id="ghsetup-clone-btn" onclick="cloneGitHubRepoFromSetupModal()"' + (opts.connected ? '' : ' disabled') + '>Clone</button>' +
            '</div>' +
            '<div id="ghsetup-clone-status" style="font-size:var(--text-body-sm);margin-top:var(--space-2);"></div>' +
        '</div>';

    html +=
            '</div>' +
            '<div class="modal-actions">' +
                '<button class="modal-btn secondary" onclick="closeGitHubSetupModal()">Close</button>' +
            '</div>' +
        '</div>';

    overlay.innerHTML = html;
    document.body.appendChild(overlay);
}

function closeGitHubSetupModal() {
    var modal = document.getElementById('github-setup-modal');
    if (modal) modal.remove();
}

function openGitHubSetupTokenPage(e) {
    if (e) e.preventDefault();
    var inst = document.getElementById('ghsetup-instance');
    var instanceUrl = ((inst && inst.value.trim()) || 'https://github.com').replace(/\/$/, '');
    window.open(instanceUrl + '/settings/tokens/new?scopes=repo&description=AppAgent', '_blank');
}

async function connectGitHubFromSetupModal() {
    var btn = document.getElementById('ghsetup-connect-btn');
    var status = document.getElementById('ghsetup-connect-status');
    var tokenInput = document.getElementById('ghsetup-token');
    var instInput = document.getElementById('ghsetup-instance');
    if (!tokenInput || !tokenInput.value.trim()) {
        if (status) { status.style.color = 'var(--danger)'; status.textContent = 'Please enter a token'; }
        return;
    }
    var token = tokenInput.value.trim();
    // Normalize before validate/save so the stored githubInstanceUrl is
    // canonical — trailing-slash/case variants break the strict-equality API
    // base derivations (normalizeGitHubInstanceUrl: core/130-indexeddb.js).
    var instanceUrl = normalizeGitHubInstanceUrl(instInput && instInput.value);
    if (btn) btn.disabled = true;
    if (status) { status.style.color = 'var(--text-muted)'; status.textContent = 'Validating...'; }
    var result = await validateGitHubToken(token, instanceUrl);
    if (result.ok) {
        await saveGitHubSettings(token, instanceUrl, { login: result.login, avatar_url: result.avatar_url, name: result.name });
        // If the Settings page is open behind the modal, refresh its GitHub section.
        if (typeof renderGitHubSettings === 'function') renderGitHubSettings();
        // Re-render the modal in connected state, preserving any repo/branch typed.
        var repoEl = document.getElementById('ghsetup-repo');
        var branchEl = document.getElementById('ghsetup-branch');
        showGitHubSetupModal({
            connected: true,
            user: { login: result.login, avatar_url: result.avatar_url },
            instanceUrl: instanceUrl.replace(/\/$/, ''),
            repo: (repoEl && repoEl.value.trim()) || '',
            branch: (branchEl && branchEl.value.trim()) || ''
        });
    } else {
        if (btn) btn.disabled = false;
        if (status) { status.style.color = 'var(--danger)'; status.textContent = result.error || 'Connection failed'; }
    }
}

async function cloneGitHubRepoFromSetupModal() {
    var repoInput = document.getElementById('ghsetup-repo');
    var branchInput = document.getElementById('ghsetup-branch');
    var btn = document.getElementById('ghsetup-clone-btn');
    var status = document.getElementById('ghsetup-clone-status');
    var repo = repoInput ? repoInput.value.trim() : '';
    if (!repo) {
        if (status) { status.style.color = 'var(--danger)'; status.textContent = 'Enter a repo (owner/repo)'; }
        return;
    }
    if (repo.indexOf('/') === -1) {
        if (status) { status.style.color = 'var(--danger)'; status.textContent = 'Format: owner/repo'; }
        return;
    }
    var branch = (branchInput && branchInput.value.trim()) || undefined;
    if (btn) btn.disabled = true;
    if (status) { status.style.color = 'var(--text-muted)'; status.textContent = 'Cloning ' + repo + '...'; }
    try {
        var result = await wsClone(repo, branch);
        if (result.success) {
            if (status) { status.style.color = 'var(--success)'; status.textContent = result.message; }
            if (repoInput) repoInput.value = '';
            if (branchInput) branchInput.value = '';
            // Keep the rest of the UI in sync with the new workspace.
            if (typeof renderGitHubReposList === 'function') renderGitHubReposList();
            if (typeof updateWorkspaceHeaderStatus === 'function') updateWorkspaceHeaderStatus();
        } else {
            if (status) { status.style.color = 'var(--danger)'; status.textContent = result.error; }
        }
    } catch (e) {
        if (status) { status.style.color = 'var(--danger)'; status.textContent = e.message; }
    }
    if (btn) btn.disabled = false;
}
