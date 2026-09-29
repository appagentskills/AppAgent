async function addSampleTool() {
    if (!currentEditingSkill) { showSnackbar(t('Save the skill first'), 'error', undefined, { key: 'skill-editor' }); return; }

    var sampleToolContent = `// Sample Tool: my_tool
// Runs in isolated sandbox - only executeTool() is available
// Use executeTool(name, args) to call other tools (goes through permission system)

var TOOL_DEFINITION = {
    type: 'function',
    function: {
        name: 'my_tool',
        description: 'A sample tool that fetches incident data from ServiceNow. Replace with your own logic.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Query filter for incidents (e.g., "active=true")'
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of records to return (default: 10)'
                }
            }
        }
    }
};

async function my_tool(args) {
    var query = args.query || 'active=true';
    var limit = args.limit || 10;

    try {
        // Call the ServiceNow API tool - goes through permission system
        var response = await executeTool('servicenow_api', {
            method: 'GET',
            table: 'incident',
            query: query,
            fields: 'number,short_description,priority,state',
            limit: limit,
            url_params: { sysparm_display_value: 'true' }
        });

        if (!response || !response.result) {
            return { success: false, error: 'No results returned' };
        }

        return {
            success: true,
            count: response.result.length,
            incidents: response.result
        };
    } catch (error) {
        return {
            success: false,
            error: error.message || 'Failed to fetch incidents'
        };
    }
}
`;
    
    await saveSkillAsset(currentEditingSkill, 'my_tool.js', 'js', sampleToolContent);
    await renderSkillAssets();
    showSnackbar(t('Sample tool added'), 'success');
}

async function addSkillAsset() {
    if (!currentEditingSkill) { showSnackbar(t('Save the skill first'), 'error', undefined, { key: 'skill-editor' }); return; }
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml,.md,.js';
    input.multiple = true;
    input.onchange = function(e) { return addSkillAssetFiles(e.target.files); };
    input.click();
}

// S0B-11: never rejects; confirms before SKILL.md replaces content; honest count.
async function addSkillAssetFiles(files) {
    var added = 0, skipped = 0, skillUpdated = false;
    try {
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            var ext = file.name.split('.').pop().toLowerCase();
            if (ext !== 'xml' && ext !== 'md' && ext !== 'js') { skipped++; continue; }
            var content = await file.text();
            // If importing SKILL.md, update the skill's parsed content (don't save as asset)
            if (file.name.toLowerCase() === 'skill.md') {
                var skill = skills[currentEditingSkill];
                if (!skill) { showSnackbar(t('Add file failed: skill not found (save it first)'), 'error'); return; }
                var fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
                // TB-10: the mini parser reads block lists only, so a flow list (`actions: [a, b]`)
                // parses to []. Replace the actions only when the parse is non-empty (never wipe them).
                var parsed = parseSkillMarkdown(content, file.name);
                var hasActions = !!fm && /^actions\s*:/m.test(fm[1]) && Array.isArray(parsed.actions) && parsed.actions.length > 0;
                var ok = await showConfirmModal(t('Replace skill content'),
                    !fm ? t("SKILL.md will replace this skill's body. Unsaved editor changes are lost. Continue?")
                        : hasActions ? t("SKILL.md will replace this skill's name, description, body and actions. Unsaved editor changes are lost. Continue?")
                        : t("SKILL.md will replace this skill's name, description, body. Unsaved editor changes are lost. Continue?"), 'danger');
                if (!ok) { skipped++; continue; }
                if (fm) { skill.name = parsed.name || skill.name; skill.description = parsed.description || skill.description; }
                skill.body = parsed.body;
                if (hasActions) skill.actions = dedupeActionsByActionId(skill.name, parsed.actions || []);
                skill.updatedAt = Date.now();
                skill.userModified = true;
                await saveSkill(skill);
                skillUpdated = true;
                // Update editor fields
                var nameInput = document.getElementById('skill-name-input');
                var descInput = document.getElementById('skill-description-input');
                var bodyInput = document.getElementById('skill-body-input');
                if (nameInput) nameInput.value = skill.name || '';
                if (descInput) descInput.value = skill.description || '';
                if (bodyInput) bodyInput.value = skill.body || '';
                // Re-render body view
                renderSkillBodyView();
                resetSkillActionsDraft();
                renderSkillActionsEditor();
                continue; // Don't save SKILL.md as a separate asset
            }
            // A5B2-01: a same-name asset is replaced only after an explicit confirm; Cancel skips it.
            var existing = await getSkillAsset(currentEditingSkill, file.name);
            if (existing) {
                var rep = await showConfirmModal(t('Replace file'), t('{name} already exists in this skill. Replace it?', { name: escapeHtml(file.name) }), 'danger');
                if (!rep) { skipped++; continue; }
            }
            await saveSkillAsset(currentEditingSkill, file.name, ext, content);
            added++;
        }
    } catch (e) {
        console.error('[addSkillAsset] failed:', e);
        showSnackbar(t('Add file failed: {error}', { error: String((e && e.message) || e) }), 'error');
        return;
    } finally {
        try { await renderSkillAssets(); } catch (e2) { console.error('[addSkillAsset] render failed:', e2); }
    }
    // One whole sentence per variant (contract rule 4). English keeps the pinned 'file(s)'
    // wording in both forms (English identity); tn() lets catalogs supply real plural forms.
    var skippedP = { skipped: i18nFormatNumber(skipped) };
    showSnackbar(skipped && skillUpdated ? tn(added, 'Added {count} file(s), skipped {skipped}; skill updated from SKILL.md', 'Added {count} file(s), skipped {skipped}; skill updated from SKILL.md', skippedP)
        : skipped ? tn(added, 'Added {count} file(s), skipped {skipped}', 'Added {count} file(s), skipped {skipped}', skippedP)
        : skillUpdated ? tn(added, 'Added {count} file(s); skill updated from SKILL.md', 'Added {count} file(s); skill updated from SKILL.md')
        : tn(added, 'Added {count} file(s)', 'Added {count} file(s)'), 'success');
}

async function removeSkillAsset(filename) {
    if (!currentEditingSkill) return;
    var confirmed = await showConfirmModal(t('Remove File'), t('Remove {name} from this skill?', { name: escapeHtml(filename) }), 'danger');
    if (!confirmed) return;
    await deleteSkillAsset(currentEditingSkill, filename);
    await renderSkillAssets();
    showSnackbar(t('File removed'), 'success');
}

function viewSkillMd() {
    if (!currentEditingSkill) return;
    var skill = skills[currentEditingSkill];
    if (!skill) return;
    var content = skillToMarkdown(skill);
    currentViewingAsset = { filename: 'SKILL.md', content: content, type: 'md', isSkillMd: true };
    assetEditMode = false;
    renderAssetModal();
}

function downloadSkillMd() {
    if (!currentEditingSkill) return;
    var skill = skills[currentEditingSkill];
    if (!skill) return;
    var content = skillToMarkdown(skill);
    downloadFile('SKILL.md', content, 'text/markdown');
}

async function downloadSkillAsset(filename) {
    if (!currentEditingSkill) return;
    var asset = await getSkillAsset(currentEditingSkill, filename);
    if (!asset) { showSnackbar(t('File not found'), 'error'); return; }
    var mimeType = asset.type === 'xml' ? 'application/xml' : (asset.type === 'js' ? 'application/javascript' : 'text/markdown');
    downloadFile(filename, asset.content, mimeType);
}

async function renameSkillAsset(oldFilename) {
    if (!currentEditingSkill) return;
    
    // Get current extension
    var ext = oldFilename.substring(oldFilename.lastIndexOf('.'));
    var baseName = oldFilename.substring(0, oldFilename.lastIndexOf('.'));
    
    var newName = await showPromptModal(t('Rename File'), t('Enter new filename:'), baseName);
    if (!newName || newName === baseName) return;
    
    // Ensure proper extension
    var newFilename = newName;
    if (!newFilename.endsWith(ext)) {
        newFilename += ext;
    }
    
    // Check if new filename already exists
    var existingAsset = await getSkillAsset(currentEditingSkill, newFilename);
    if (existingAsset) {
        showSnackbar(t('A file with that name already exists'), 'error');
        return;
    }
    
    // Get old asset content
    var asset = await getSkillAsset(currentEditingSkill, oldFilename);
    if (!asset) { showSnackbar(t('File not found'), 'error'); return; }
    
    // Save with new name and remove old
    await saveSkillAsset(currentEditingSkill, newFilename, asset.type, asset.content);
    await deleteSkillAsset(currentEditingSkill, oldFilename);
    
    await renderSkillAssets();
    showSnackbar(t('File renamed to {name}', { name: newFilename }), 'success');
}

function downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

var currentViewingAsset = null;
var assetEditMode = false;

async function viewSkillAsset(filename) {
    if (!currentEditingSkill) return;
    var asset = await getSkillAsset(currentEditingSkill, filename);
    if (!asset) { showSnackbar(t('File not found'), 'error'); return; }
    
    currentViewingAsset = { filename: filename, content: asset.content, type: asset.type };
    assetEditMode = false;
    renderAssetModal();
}

function renderAssetModal() {
    if (!currentViewingAsset) return;
    var asset = currentViewingAsset;
    var modal = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');
    
    modal.classList.add('skill-asset-modal');
    
    var editBtn = assetEditMode 
        ? '<button class="modal-edit-btn active" onclick="toggleAssetEditMode()" title="' + escapeHtml(t('View')) + '">' + UI_ICONS.eye + '</button>'
        : '<button class="modal-edit-btn" onclick="toggleAssetEditMode()" title="' + escapeHtml(t('Edit')) + '">' + UI_ICONS.edit + '</button>';
    
    header.innerHTML = '<span class="modal-title-text">' + escapeHtml(asset.filename) + '</span><div class="modal-header-actions">' + editBtn + '<button class="modal-close-icon" onclick="closeModal()" title="' + escapeHtml(t('Close')) + '">' + UI_ICONS.close + '</button></div>';
    
    if (assetEditMode) {
        body.innerHTML = '<textarea class="skill-asset-editor" id="asset-edit-textarea">' + escapeHtml(asset.content) + '</textarea>';
        actions.innerHTML = '<button class="modal-btn secondary" onclick="closeModal()">' + escapeHtml(t('Cancel')) + '</button><button class="modal-btn primary" onclick="saveAssetEdit()">' + escapeHtml(t('Save')) + '</button>';
    } else {
        var contentHtml = '';
        if (asset.type === 'js') {
            contentHtml = '<div class="skill-asset-rendered"><pre><code>' + highlightJS(asset.content) + '</code></pre></div>';
        } else if (asset.type === 'md') {
            contentHtml = '<div class="skill-asset-rendered markdown-body">' + formatContent(asset.content) + '</div>';
        } else {
            contentHtml = '<div class="skill-asset-rendered"><pre><code>' + escapeHtml(asset.content) + '</code></pre></div>';
        }
        body.innerHTML = contentHtml;
        actions.innerHTML = '';
    }
    modal.classList.add('show');
}

function toggleAssetEditMode() {
    assetEditMode = !assetEditMode;
    renderAssetModal();
}

async function saveAssetEdit() {
    if (!currentEditingSkill || !currentViewingAsset) return;
    var textarea = document.getElementById('asset-edit-textarea');
    if (!textarea) return;
    
    var newContent = textarea.value;
    var filename = currentViewingAsset.filename;
    var ext = filename.split('.').pop().toLowerCase();
    
    // Check if this is a SKILL.md being imported to update the skill
    if (filename === 'SKILL.md' || filename.toLowerCase() === 'skill.md') {
        var parsed = parseSkillMarkdown(newContent, currentEditingSkill);
        var skill = skills[currentEditingSkill];
        if (skill) {
            skill.name = parsed.name || skill.name;
            skill.description = parsed.description || skill.description;
            skill.body = parsed.body;
            skill.actions = dedupeActionsByActionId(skill.name, parsed.actions || []);
            skill.updatedAt = Date.now();
            skill.userModified = true;
            await saveSkill(skill);
            // Update editor fields
            var nameInput = document.getElementById('skill-name-input');
            var descInput = document.getElementById('skill-description-input');
            var bodyInput = document.getElementById('skill-body-input');
            if (nameInput) nameInput.value = skill.name || '';
            if (descInput) descInput.value = skill.description || '';
            if (bodyInput) bodyInput.value = skill.body || '';
            resetSkillActionsDraft();
            renderSkillActionsEditor();
        }
        // SKILL.md is virtual (skillToMarkdown of the live skill): never store it as
        // an asset. A stored copy is a frozen snapshot that renders as a 2nd card
        // and replays stale name/description/body/actions when saved (NEW-F15-1).
        if (!skill) { showSnackbar(t('Skill not found'), 'error'); return; }
        currentViewingAsset.content = skillToMarkdown(skill);
        assetEditMode = false;
        renderAssetModal();
        showSnackbar(t('Skill updated'), 'success');
        return;
    }
    
    await saveSkillAsset(currentEditingSkill, filename, ext, newContent);
    currentViewingAsset.content = newContent;
    assetEditMode = false;
    renderAssetModal();
    showSnackbar(t('File saved'), 'success');
}

function editSkillWithAgent() {
    if (!currentEditingSkill) return;
    var skill = skills[currentEditingSkill];
    if (!skill) return;

    // Create a new chat with just the skill name. newChat() closes the skills view
    // itself AFTER switching identity (ui/170-chat-management.js newChat), so the
    // previous chat's unread state is not consumed here (A5A3-01).
    newChat();

    // Pre-fill the message input with just the skill name
    var input = document.getElementById('message-input');
    if (input) {
        input.value = t('I want to edit the skill: {name}', { name: skill.name || skill.id }) + '\n\n' + t('What changes would you like to make?');
        autoResizeTextarea(input);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
}

function closeSkillEditor() {
    resetSkillActionsDraft();
    currentEditingSkill = null;
    appStorage.removeItem('currentEditingSkill');
    appStorage.setItem('currentView', 'skills');
    var editorPanel = document.getElementById('skill-editor-panel');
    var listPanel = document.getElementById('skills-list-panel');
    if (editorPanel) editorPanel.style.display = 'none';
    if (listPanel) listPanel.style.display = 'flex';
    renderSkillsList();
    // NAV-H5: this is a BACK button — do NOT push (that made browser Back
    // RE-OPEN the editor the user had just closed).
    // NAV-H5b: replacing was not right either. openSkillEditor PUSHES a
    // 'skill-editor' entry (core/120-init.js:887 pushHistoryState('skill-editor',
    // null, skill.id)) on TOP of the skills-list entry, so rewriting the top
    // entry to {view:'skills'} left TWO ADJACENT IDENTICAL skills entries and the
    // user's first Back press only re-rendered the list they were already looking
    // at — a visual no-op. Popping the pushed editor entry instead removes the
    // duplicate AND makes Back move immediately; handlePopState's 'skills' arm
    // (core/040-hooks-history.js:237-250) re-shows the list, which is idempotent
    // with the panel work above.
    // Guard: only pop when we are actually standing on a PUSHED editor entry
    // (history.length > 1). A boot-restored editor view (core/120-init.js:552)
    // can be the only entry in the session — going back from there would leave
    // the app — so that case keeps the old replace.
    var _hs = null;
    try { _hs = history.state; } catch (e) {}
    var _canPop = !!(_hs && _hs.view === 'skill-editor') &&
        (typeof history.length !== 'number' || history.length > 1);
    if (_canPop) { try { history.back(); return; } catch (e) {} }
    replaceHistoryState('skills', null, null);
}

// NEW-T17-1: Back used to drop unsaved edits without a word. The Back button now
// calls requestCloseSkillEditor(), which asks first when the form differs from
// the saved skill. Save and Delete still call closeSkillEditor() directly.
function _skillEditorIsDirty() {
    var panel = document.getElementById('skill-editor-panel');
    if (!panel || panel.style.display === 'none') return false;
    var nameInput = document.getElementById('skill-name-input');
    var descInput = document.getElementById('skill-description-input');
    var bodyInput = document.getElementById('skill-body-input');
    var name = nameInput ? String(nameInput.value || '') : '';
    var desc = descInput ? String(descInput.value || '') : '';
    var body = bodyInput ? String(bodyInput.value || '') : '';
    var s = currentEditingSkill ? skills[currentEditingSkill] : null;
    if (!s) return !!(name.trim() || desc.trim() || body.trim()); // new skill
    // A textarea value folds CRLF (and a lone CR) to LF, so compare folded text.
    var nl = function(v) { return String(v || '').replace(/\r\n?/g, '\n'); };
    if (name !== String(s.name || s.id || '')) return true;
    if (nl(desc) !== nl(s.description) || nl(body) !== nl(s.body)) return true;
    // Normalize the saved actions the way render -> collect does (sanitized, pills
    // in ACTION_PLACEMENTS order), so an untouched list never counts as dirty.
    var saved = Array.isArray(s.actions) ? s.actions : [];
    var savedNorm = saved.map(function(a) {
        var showList = Array.isArray(a.show) ? a.show : [a.show || 'home'];
        return sanitizeAction({
            name: String(a.name || ''),
            icon: String(a.icon || 'play'),
            show: ACTION_PLACEMENTS.filter(function(p) { return showList.indexOf(p) >= 0; })
        });
    }).filter(Boolean);
    return JSON.stringify(collectSkillActionsFromEditor()) !== JSON.stringify(savedNorm);
}

var _skillCloseConfirmPending = false;
async function requestCloseSkillEditor() {
    if (_skillCloseConfirmPending) return; // a 2nd Back click while the confirm is open
    var dirty = false;
    try { dirty = _skillEditorIsDirty(); } catch (e) { dirty = false; }
    if (!dirty || typeof showConfirmModal !== 'function') { closeSkillEditor(); return; }
    var id = currentEditingSkill;
    var s = id ? skills[id] : null;
    var label = (s && (s.name || s.id)) || '';
    var ok = false;
    _skillCloseConfirmPending = true;
    try {
        ok = await showConfirmModal(t('Discard changes?'), label
            ? t('Unsaved edits to "{name}" will be lost.', { name: escapeHtml(label) })
            : t('Unsaved edits to "this new skill" will be lost.'), 'warning');
    } finally {
        _skillCloseConfirmPending = false;
    }
    if (!ok) return;
    // A stale confirm must not close a skill opened while it was showing.
    var panelNow = document.getElementById('skill-editor-panel');
    if (currentEditingSkill !== id || !panelNow || panelNow.style.display === 'none') return;
    closeSkillEditor();
}

async function saveCurrentSkill() {
    var nameInput = document.getElementById('skill-name-input');
    var descInput = document.getElementById('skill-description-input');
    var bodyInput = document.getElementById('skill-body-input');
    var name = (nameInput ? nameInput.value : '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
    var description = (descInput ? descInput.value : '').trim();
    var body = (bodyInput ? bodyInput.value : '').trim();
    var actions = collectSkillActionsFromEditor();
    if (!name) { showSnackbar(t('Name is required'), 'error', undefined, { key: 'skill-editor' }); return; }
    if (name.length > 64) { showSnackbar(t('Name must be 64 characters or less'), 'error', undefined, { key: 'skill-editor' }); return; }
    if (!description) { showSnackbar(t('Description is required'), 'error', undefined, { key: 'skill-editor' }); return; }
    // Reject collisions on the normalized actionId. getActionId lowercases and
    // slugifies, so "Run audit" and "RUN-AUDIT" hash to the same id — the
    // engine then can't distinguish them and only one button effectively works.
    if (typeof getActionId === 'function' && actions.length > 1) {
        var seenActionIds = {};
        for (var ai = 0; ai < actions.length; ai++) {
            var aid = getActionId(name || 'skill', actions[ai].name);
            if (seenActionIds[aid]) {
                showSnackbar(t('Two actions normalize to the same id: "{first}" and "{second}". Rename one.', { first: seenActionIds[aid], second: actions[ai].name }), 'error', undefined, { key: 'skill-editor' });
                return;
            }
            seenActionIds[aid] = actions[ai].name;
        }
    }
    var skill;
    if (currentEditingSkill && skills[currentEditingSkill]) {
        skill = skills[currentEditingSkill];
        skill.name = name; skill.description = description; skill.body = body;
        skill.actions = actions;
        skill.updatedAt = Date.now();
        skill.userModified = true;
    } else {
        var id = name;
        var baseId = id, counter = 1;
        while (skills[id]) { id = baseId + '-' + counter; counter++; }
        skill = { id: id, name: name, description: description, body: body, actions: actions, userModified: true, createdAt: Date.now(), updatedAt: Date.now() };
    }
    await saveSkill(skill);
    showSnackbar(t('Skill saved'), 'success', undefined, { key: 'skill-editor' });
    resetSkillActionsDraft();
    closeSkillEditor();
}

async function deleteCurrentSkill() {
    if (!currentEditingSkill) return;
    // NEW-T16-1: name the skill. The modal parses the message as HTML, so escape it.
    var s = skills[currentEditingSkill];
    var n = (s && s.name) || currentEditingSkill;
    var confirmed = await showConfirmModal(t('Delete Skill'), t('Delete "{name}"? This cannot be undone.', { name: escapeHtml(n) }), 'danger');
    if (!confirmed) return;
    await deleteSkill(currentEditingSkill);
    showSnackbar(t('Skill deleted'), 'success');
    closeSkillEditor();
}

// Agent Skills format: YAML frontmatter parser/generator
// ---
// Supports a small, well-defined YAML subset in the frontmatter:
//   - top-level scalars:  name: ..., description: ...
//   - top-level list of objects:  actions: [ {name, icon, show} ]
// More than enough for our spec; avoids bundling a full YAML library.

// Valid placements for action buttons.
// NOTE: 'header' is intentionally NOT a configurable placement — the top bar
// is reserved for *live* (running / not-yet-dismissed) actions, populated
// automatically from `activeActions`, not from skill config.
var ACTION_PLACEMENTS = ['home', 'chat', 'sidebar'];
// Valid icon names for actions (must also exist in UI_ICONS)
var ACTION_ICONS = ['search','shield','eye','play','check','close','spinner','lock','pause','stop','bell','code','database','stats','zap','alert','list','clipboard','rocket','bug','browser','clock','skill','tool','widget','api','download','upload','refresh','edit','trash'];

function _stripYamlQuotes(s) {
    if (!s) return '';
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        // Single pass so an escaped backslash (\\) is not re-read as the start of \n / \"
        return s.substring(1, s.length - 1).replace(/\\(["n\\])/g, function(_, c) { return c === 'n' ? '\n' : c; });
    }
    return s;
}

// Parse a YAML scalar value or flow-array, e.g. `home` or `[home, header]`
function _parseYamlValue(s) {
    if (!s) return '';
    s = s.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
        var inner = s.substring(1, s.length - 1);
        if (!inner.trim()) return [];
        return inner.split(',').map(function(part){ return _stripYamlQuotes(part.trim()); }).filter(Boolean);
    }
    return _stripYamlQuotes(s);
}

// Parse frontmatter into { scalars: {key: value}, actions: [{...}] }
// Hand-rolled mini YAML parser: handles scalars + the `actions:` list of objects only.
function _parseFrontmatter(fm) {
    var lines = fm.split(/\r?\n/);
    var scalars = {};
    var actions = [];
    var i = 0;
    while (i < lines.length) {
        var line = lines[i];
        if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
        // Top-level key: value
        var kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
        if (kv) {
            var key = kv[1];
            var val = kv[2];
            if (key === 'actions' && !val.trim()) {
                // Multi-line list of objects
                i++;
                while (i < lines.length) {
                    var l = lines[i];
                    // List item begins with `- ` at least 2 spaces deep
                    var itemMatch = l.match(/^(\s+)-\s+(.*)$/);
                    if (!itemMatch) {
                        // End of list if we hit a non-indented line
                        if (l.trim() && !/^\s/.test(l)) break;
                        i++; continue;
                    }
                    var indent = itemMatch[1].length;
                    var action = {};
                    // First key can be inline with the dash
                    var firstKv = itemMatch[2].match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
                    if (firstKv) action[firstKv[1]] = _parseYamlValue(firstKv[2]);
                    i++;
                    // Subsequent keys must be indented deeper than the dash
                    while (i < lines.length) {
                        var sub = lines[i];
                        if (!sub.trim()) { i++; continue; }
                        var subIndentMatch = sub.match(/^(\s*)/);
                        var subIndent = subIndentMatch[1].length;
                        if (subIndent <= indent) break;
                        if (/^\s+-\s/.test(sub)) break; // next list item
                        var subKv = sub.match(/^\s+([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
                        if (subKv) action[subKv[1]] = _parseYamlValue(subKv[2]);
                        i++;
                    }
                    if (action.name) actions.push(action);
                }
                continue;
            }
            scalars[key] = _stripYamlQuotes(val);
        }
        i++;
    }
    return { scalars: scalars, actions: actions };
}

function _needsYamlQuote(s) {
    return /[:#\[\]{}|>&*!?,\n]/.test(s) || s.startsWith("'") || s.startsWith('"');
}
function _yamlScalar(s) {
    return _needsYamlQuote(s) ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"' : s;
}

// Sanitize an action before serializing/using it
// `show` can be a string (legacy) or array of strings (multi-placement).
// Always normalized to a string[] with at least one placement.
// Drop actions whose names normalize (via getActionId) to the same slug as a
// previous action. The engine keys live state by actionId, so two colliding
// names would share state and only one button would effectively work. Used by
// every assignment path that bypasses the editor's saveCurrentSkill check
// (markdown imports, manage_skill tool). The editor's loud-error path stays
// in saveCurrentSkill; this is the silent fallback that prevents data corruption.
function dedupeActionsByActionId(skillName, actions) {
    if (!Array.isArray(actions) || actions.length < 2) return Array.isArray(actions) ? actions : [];
    if (typeof getActionId !== 'function') return actions;
    var seen = {};
    var deduped = [];
    var dropped = [];
    actions.forEach(function(a) {
        if (!a || !a.name) return;
        var aid = getActionId(skillName || 'skill', a.name);
        if (seen[aid]) { dropped.push({ kept: seen[aid], dropped: a.name }); return; }
        seen[aid] = a.name;
        deduped.push(a);
    });
    if (dropped.length && typeof console !== 'undefined' && console.warn) {
        console.warn('[skills] Dropped colliding actions on "' + (skillName || 'skill') + '":', dropped);
    }
    return deduped;
}

function sanitizeAction(a) {
    if (!a || typeof a !== 'object') return null;
    var name = (a.name || '').trim().substring(0, 48);
    if (!name) return null;
    var icon = (a.icon || 'play').trim();
    if (ACTION_ICONS.indexOf(icon) < 0) icon = 'play';
    var showList;
    if (Array.isArray(a.show)) showList = a.show.slice();
    else if (typeof a.show === 'string') showList = a.show.split(/[,\s]+/).filter(Boolean);
    else showList = [];
    showList = showList.map(function(s){ return String(s).trim(); })
        .filter(function(s){ return ACTION_PLACEMENTS.indexOf(s) >= 0; });
    // de-duplicate, preserving order
    var seen = {};
    showList = showList.filter(function(s){ if (seen[s]) return false; seen[s] = 1; return true; });
    if (!showList.length) showList = ['home'];
    return { name: name, icon: icon, show: showList };
}

function skillToMarkdown(skill) {
    var name = (skill.name || skill.id || 'untitled').substring(0, 64);
    var description = (skill.description || 'A skill.').substring(0, 1024);
    var frontmatter = '---\n';
    frontmatter += 'name: ' + _yamlScalar(name) + '\n';
    frontmatter += 'description: ' + _yamlScalar(description) + '\n';
    // Serialize actions (if any)
    var actions = Array.isArray(skill.actions) ? skill.actions.map(sanitizeAction).filter(function(a){return a;}) : [];
    if (actions.length) {
        frontmatter += 'actions:\n';
        actions.forEach(function(a) {
            frontmatter += '  - name: ' + _yamlScalar(a.name) + '\n';
            frontmatter += '    icon: ' + _yamlScalar(a.icon) + '\n';
            // Always serialize show as a flow-array, even for single values (stable format)
            var showArr = Array.isArray(a.show) ? a.show : [a.show];
            frontmatter += '    show: [' + showArr.map(_yamlScalar).join(', ') + ']\n';
        });
    }
    frontmatter += '---\n\n';
    return frontmatter + (skill.body || '');
}

function parseSkillMarkdown(content, filename) {
    var result = { name: '', description: '', body: '', actions: [] };
    var frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
        var parsed = _parseFrontmatter(frontmatterMatch[1]);
        if (parsed.scalars.name) result.name = parsed.scalars.name;
        if (parsed.scalars.description) result.description = parsed.scalars.description;
        result.actions = parsed.actions.map(sanitizeAction).filter(function(a){return a;});
        content = content.substring(frontmatterMatch[0].length).trim();
    } else {
        // Fallback: use filename as name
        result.name = filename ? filename.toLowerCase().replace(/[^a-z0-9-]/g, '-') : 'untitled';
    }
    result.body = content;
    return result;
}

// Build a serializable JSON object for a skill (with assets inlined)
async function skillToJsonObject(skill) {
    var assets = await getSkillAssets(skill.id);
    return {
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description || '',
        body: skill.body || '',
        actions: Array.isArray(skill.actions)
            ? skill.actions.map(sanitizeAction).filter(function(a){ return a; })
            : [],
        assets: assets.map(function(a) {
            return { filename: a.filename, type: a.type, content: a.content };
        })
    };
}

// Slugify name for filenames
function _skillFolderName(skill) {
    return (skill.id || (skill.name || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).substring(0, 64);
}

// Folder export helpers (write a single skill into an open dirHandle)
async function _writeSkillToDir(skill, parentDirHandle) {
    var folderName = _skillFolderName(skill);
    var skillDirHandle = await parentDirHandle.getDirectoryHandle(folderName, { create: true });
    
    // Write SKILL.md
    var fileHandle = await skillDirHandle.getFileHandle('SKILL.md', { create: true });
    var writable = await fileHandle.createWritable();
    await writable.write(skillToMarkdown(skill));
    await writable.close();
    
    // Write all assets (XML/MD/JS files)
    var assets = await getSkillAssets(skill.id);
    for (var j = 0; j < assets.length; j++) {
        var asset = assets[j];
        // SKILL.md was written above from the live skill; a stored copy is stale.
        if (String(asset.filename || '').toLowerCase() === 'skill.md') continue;
        var assetHandle = await skillDirHandle.getFileHandle(asset.filename, { create: true });
        var assetWritable = await assetHandle.createWritable();
        await assetWritable.write(asset.content);
        await assetWritable.close();
    }
}

// =============================================================================
// Export: single skill
// =============================================================================

async function exportSkillToFolder(skillId) {
    var skill = skills[skillId];
    if (!skill) { showSnackbar(t('Skill not found'), 'error'); return; }
    
    if (!window.showDirectoryPicker) {
        showSnackbar(t('Your browser does not support folder export. Use Chrome or Edge.'), 'error');
        return;
    }
    
    try {
        var dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
        await _writeSkillToDir(skill, dirHandle);
        showSnackbar(t('Exported skill "{name}" to folder', { name: skill.name || skill.id }), 'success');
    } catch (err) {
        if (err.name !== 'AbortError') showSnackbar(t('Export failed: {error}', { error: err.message }), 'error');
    }
}

async function exportSkillToJson(skillId) {
    var skill = skills[skillId];
    if (!skill) { showSnackbar(t('Skill not found'), 'error'); return; }
    try {
        var skillObj = await skillToJsonObject(skill);
        var bundle = { version: 1, type: 'skill', exportedAt: new Date().toISOString(), skill: skillObj };
        var filename = _skillFolderName(skill) + '.skill.json';
        downloadFile(filename, JSON.stringify(bundle, null, 2), 'application/json');
        showSnackbar(t('Exported skill "{name}" as JSON', { name: skill.name || skill.id }), 'success');
    } catch (err) {
        showSnackbar(t('Export failed: {error}', { error: err.message }), 'error');
    }
}

// Back-compat alias (old callers / external scripts)
async function exportSkill(skillId) { return exportSkillToFolder(skillId); }

async function exportCurrentSkillToFolder() {
    if (!currentEditingSkill) return;
    await exportSkillToFolder(currentEditingSkill);
}

async function exportCurrentSkillToJson() {
    if (!currentEditingSkill) return;
    await exportSkillToJson(currentEditingSkill);
}

// Back-compat: previous default was folder export
async function exportCurrentSkill() {
    return exportCurrentSkillToFolder();
}

// =============================================================================
// Export: all skills
// =============================================================================

async function exportAllSkillsToFolder() {
    var skillList = Object.values(skills);
    if (skillList.length === 0) { showSnackbar(t('No skills to export'), 'error'); return; }
    
    if (!window.showDirectoryPicker) {
        showSnackbar(t('Your browser does not support folder export. Use Chrome or Edge.'), 'error');
        return;
    }
    
    try {
        var dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
        var exported = 0;
        for (var i = 0; i < skillList.length; i++) {
            await _writeSkillToDir(skillList[i], dirHandle);
            exported++;
        }
        showSnackbar(tn(exported, 'Exported {count} skill(s) to folder', 'Exported {count} skill(s) to folder'), 'success');
    } catch (err) {
        if (err.name !== 'AbortError') showSnackbar(t('Export failed: {error}', { error: err.message }), 'error');
    }
}

async function exportAllSkillsToJson() {
    var skillList = Object.values(skills);
    if (skillList.length === 0) { showSnackbar(t('No skills to export'), 'error'); return; }
    try {
        var skillObjs = [];
        for (var i = 0; i < skillList.length; i++) {
            skillObjs.push(await skillToJsonObject(skillList[i]));
        }
        var bundle = {
            version: 1,
            type: 'skill-bundle',
            exportedAt: new Date().toISOString(),
            skills: skillObjs
        };
        var filename = 'skills-' + new Date().toISOString().slice(0, 10) + '.json';
        downloadFile(filename, JSON.stringify(bundle, null, 2), 'application/json');
        showSnackbar(tn(skillObjs.length, 'Exported {count} skill(s) as JSON', 'Exported {count} skill(s) as JSON'), 'success');
    } catch (err) {
        showSnackbar(t('Export failed: {error}', { error: err.message }), 'error');
    }
}

// Back-compat: previous default was folder export
async function exportAllSkills() {
    return exportAllSkillsToFolder();
}

// S0B-08: read + parse a folder's SKILL.md (read-only). The import pre-scan uses it
// to learn the id BEFORE anything is written, then passes it on, so the id the user
// confirmed is the one committed.
async function _readSkillFolderManifest(dirHandle, folderName) {
    var skillFile = await dirHandle.getFileHandle('SKILL.md');
    var file = await skillFile.getFile();
    var parsed = parseSkillMarkdown(await file.text(), folderName);
    return { parsed: parsed, id: parsed.name || folderName };
}

// S0B-08: ONE confirmation before an import overwrites existing skills (content and
// actions replaced, assets missing from the import deleted; an ACTIVE skill's
// ServiceNow XML is reverted and re-applied). Read-only. Resolves true when no id
// exists yet or the user confirms; the spinner is hidden while the dialog is open.
async function _confirmSkillImportOverwrite(ids) {
    var seen = Object.create(null), items = [];
    ids.forEach(function(id) {
        if (!id || seen[id] || !skills[id]) return;
        seen[id] = true;
        items.push('<li><code>' + escapeHtml(id) + '</code>' + (activeSkills[id]
            ? ' <strong>' + escapeHtml(t('(active: will be reverted and re-applied on ServiceNow)')) + '</strong>' : '') + '</li>');
    });
    if (!items.length) return true;
    hideOverlaySpinner();
    var ok = await showConfirmModal(t('Overwrite existing skills?'),
        escapeHtml(tn(items.length, '{count} skill(s) already exist.', '{count} skill(s) already exist.')) + ' ' +
        escapeHtml(t('Importing replaces their content and actions and deletes their assets that are not in the import:')) +
        '<ul>' + items.join('') + '</ul>' + escapeHtml(t('This cannot be undone.')), 'warning');
    if (ok) showOverlaySpinner(t('Importing skills...'));
    return ok;
}

async function importSkillFromFolder(dirHandle, folderName, manifest) {
    // Helper to import a single skill folder (manifest: the pre-scanned SKILL.md; read here when omitted)
    manifest = manifest || await _readSkillFolderManifest(dirHandle, folderName);
    var parsed = manifest.parsed;
    
    var id = manifest.id;
    
    // S0B-08 write-then-swap: stage every file read in memory first (touching nothing),
    // commit the skill row + assets in ONE transaction, and only then cycle activation.
    // Any failure before the commit leaves the old skill, its assets and its active
    // state (and the remote XML it applied) intact, and the error propagates.
    var existed = !!skills[id];
    var wasActive = !!activeSkills[id];
    var staged = [];
    // Stage all other files as assets (XML, MD, JS files, excluding SKILL.md)
    for await (var fileEntry of dirHandle.values()) {
        if (fileEntry.kind === 'file' && fileEntry.name !== 'SKILL.md') {
            var ext = fileEntry.name.split('.').pop().toLowerCase();
            if (ext === 'xml' || ext === 'md' || ext === 'js') {
                var assetFile = await dirHandle.getFileHandle(fileEntry.name);
                var assetData = await assetFile.getFile();
                staged.push({ filename: fileEntry.name, type: ext, content: await assetData.text() });
            }
        }
    }
    
    await commitSkillImport({
        id: id,
        name: parsed.name || folderName,
        description: parsed.description || '',
        body: parsed.body,
        actions: dedupeActionsByActionId(parsed.name || folderName, parsed.actions || []),
        userModified: true,
        createdAt: existed ? skills[id].createdAt : Date.now(),
        updatedAt: Date.now()
    }, staged);
    
    return { id: id, existed: existed, wasActive: wasActive,
        activationError: wasActive ? await _cycleImportedSkillActivation(id) : '' };
}

// S0B-08: re-apply a re-imported skill that was active, only AFTER its new content
// is committed (deactivate reverts the old remote XML, activate applies the new
// assets). Returns '' on success, else the problem(s) to show to the user - incl. a
// partial remote revert, which deactivateSkill resolves as success:true with
// 'Skill deactivated with errors: ...' (core/140 deactivateSkill).
async function _cycleImportedSkillActivation(id) {
    var problems = [];
    try {
        var dres = await deactivateSkill(id);
        if (dres && dres.success === false) problems.push(dres.error || t('deactivation failed'));
        else if (dres && /with errors/i.test(dres.message || '')) problems.push(dres.message);
        var res = await activateSkill(id);
        if (res && res.success === false) problems.push(res.error || t('activation failed'));
    } catch (e) {
        problems.push((e && e.message) || String(e));
    }
    return problems.join('; ');
}

async function importSkillsFromFolder() {
    if (!window.showDirectoryPicker) {
        showSnackbar(t('Your browser does not support folder import. Use Chrome or Edge.'), 'error');
        return;
    }
    
    try {
        var dirHandle = await window.showDirectoryPicker({ mode: 'read', startIn: 'downloads' });
        showOverlaySpinner(t('Importing skills...'));
        var imported = 0;
        var updated = 0;
        var errors = []; // S0B-08: real per-folder failures are collected and shown, never swallowed
        var activationErrors = [];
        var tally = function(res) {
            imported++;
            if (res.existed) updated++; // counted only after a successful import
            if (res.activationError) activationErrors.push(res.id + ': ' + res.activationError);
        };
        
        // S0B-08: read-only pre-scan - read + parse every SKILL.md first (writes nothing)
        // so ONE confirmation can list the existing skills this import would overwrite.
        var found = [];
        var scan = async function(dir, name) {
            try {
                found.push({ dir: dir, name: name, manifest: await _readSkillFolderManifest(dir, name) });
            } catch (e) {
                errors.push(name + ': ' + ((e && e.message) || e));
            }
        };
        
        // First check if the selected folder is a single skill folder (has SKILL.md)
        var isSingleSkill = false;
        try {
            await dirHandle.getFileHandle('SKILL.md');
            isSingleSkill = true;
        } catch (e) { /* Not a single skill folder */ }
        
        if (isSingleSkill) {
            // Import single skill folder directly
            await scan(dirHandle, dirHandle.name);
        } else {
            // Import folder containing multiple skill folders
            for await (var entry of dirHandle.values()) {
                if (entry.kind === 'directory') {
                    try {
                        var skillDir = await dirHandle.getDirectoryHandle(entry.name);
                        try {
                            await skillDir.getFileHandle('SKILL.md');
                        } catch (e) {
                            if (e && e.name === 'NotFoundError') continue; // Skip folders without SKILL.md
                            throw e;
                        }
                        await scan(skillDir, entry.name);
                    } catch (e) {
                        errors.push(entry.name + ': ' + ((e && e.message) || e));
                    }
                }
            }
        }
        
        if (!(await _confirmSkillImportOverwrite(found.map(function(c) { return c.manifest.id; })))) {
            showSnackbar(t('Import cancelled'), 'info'); // nothing written, no remote call
            return;
        }
        for (var c = 0; c < found.length; c++) {
            try {
                tally(await importSkillFromFolder(found[c].dir, found[c].name, found[c].manifest));
            } catch (e) {
                errors.push(found[c].name + ': ' + ((e && e.message) || e));
            }
        }
        
        hideOverlaySpinner();
        if (imported === 0) {
            showSnackbar(errors.length ? t('Import failed: {error}', { error: errors.join('; ') })
                : t('No valid skills found. Folder should contain SKILL.md or subfolders with SKILL.md'), 'error');
        } else {
            renderSkillsList();
            var msg = updated > 0
                ? tn(imported, 'Imported {count} skill(s) ({updated} updated)', 'Imported {count} skill(s) ({updated} updated)', { updated: i18nFormatNumber(updated) })
                : tn(imported, 'Imported {count} skill(s)', 'Imported {count} skill(s)');
            if (errors.length) msg += ' — ' + tn(errors.length, '{count} failed: {errors}', '{count} failed: {errors}', { errors: errors.join('; ') });
            if (activationErrors.length) msg += ' — ' + t('re-activation issues: {issues}', { issues: activationErrors.join('; ') });
            showSnackbar(msg, (errors.length || activationErrors.length) ? 'warning' : 'success');
        }
    } catch (err) {
        hideOverlaySpinner();
        if (err.name !== 'AbortError') showSnackbar(t('Import failed: {error}', { error: err.message }), 'error');
    }
}

// Normalize a raw skill id/name into the canonical id used in the skills map
function _normalizeSkillId(raw) {
    if (!raw) return '';
    return String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '').substring(0, 64);
}

// Id a JSON skill object imports under (shared by the S0B-08 pre-scan and the import)
function _jsonSkillId(skillObj) {
    return _normalizeSkillId(skillObj.id || skillObj.name) || 'untitled';
}

// Import a skill from a parsed JSON object. Handles bare-skill, single-wrapped, and bundle formats.
// Returns { id, existed } where `existed` reflects whether a skill with that id was already present
// BEFORE the import (so callers can count updates vs creates).
async function importSkillFromJsonObject(skillObj) {
    if (!skillObj || typeof skillObj !== 'object') {
        throw new Error('Invalid skill object');
    }
    var id = _jsonSkillId(skillObj);
    var existed = !!skills[id];
    var existingCreatedAt = existed ? skills[id].createdAt : Date.now();
    var wasActive = !!activeSkills[id];
    
    // S0B-08 write-then-swap: validate + stage everything in memory first (touching
    // nothing), commit the skill row + assets in ONE transaction, and only then cycle
    // activation. A bad asset or an IDB error leaves the old skill, its assets and its
    // active state (and the remote XML it applied) intact, and the error propagates.
    var actions = Array.isArray(skillObj.actions)
        ? skillObj.actions.map(sanitizeAction).filter(function(a){ return a; })
        : [];
    
    // Stage inlined assets
    var assets = Array.isArray(skillObj.assets) ? skillObj.assets : [];
    var staged = [];
    for (var i = 0; i < assets.length; i++) {
        var a = assets[i];
        if (!a || !a.filename || typeof a.content !== 'string') continue;
        if (typeof a.filename !== 'string') throw new Error('Invalid asset filename in skill "' + id + '"');
        var ext = (a.type || a.filename.split('.').pop() || '').toLowerCase();
        if (ext !== 'xml' && ext !== 'md' && ext !== 'js') continue;
        if (a.filename === 'SKILL.md' || a.filename.toLowerCase() === 'skill.md') continue;
        staged.push({ filename: a.filename, type: ext, content: a.content });
    }
    
    await commitSkillImport({
        id: id,
        name: skillObj.name || id,
        description: skillObj.description || '',
        body: skillObj.body || '',
        actions: actions,
        userModified: true,
        createdAt: existingCreatedAt,
        updatedAt: Date.now()
    }, staged);
    
    return { id: id, existed: existed, wasActive: wasActive,
        activationError: wasActive ? await _cycleImportedSkillActivation(id) : '' };
}

async function importSkillsFromJsonFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.multiple = true;
    input.onchange = async function(e) {
        var files = e.target.files;
        if (!files || !files.length) return;
        showOverlaySpinner(t('Importing skills...'));
        var imported = 0;
        var updated = 0;
        var errors = [];
        var activationErrors = [];
        var cancelled = false;
        try {
            var parsedFiles = []; // S0B-08: parse ALL files first (read-only), confirm once, then import
            for (var f = 0; f < files.length; f++) {
                var file = files[f];
                try {
                    var text = await file.text();
                    var parsed = JSON.parse(text);
                    var skillObjs = [];
                    
                    // Auto-detect format:
                    //  - bundle:        { type:'skill-bundle', skills:[...] }  or { skills:[...] }
                    //  - single (wrap): { type:'skill', skill:{...} }         or { skill:{...} }
                    //  - bare skill:    { id|name, body, ... }
                    //  - bare array:    [ {...}, {...} ]
                    if (Array.isArray(parsed)) {
                        skillObjs = parsed;
                    } else if (Array.isArray(parsed.skills)) {
                        skillObjs = parsed.skills;
                    } else if (parsed.skill && typeof parsed.skill === 'object') {
                        skillObjs = [parsed.skill];
                    } else if (parsed.id || parsed.name) {
                        skillObjs = [parsed];
                    } else {
                        throw new Error('Unrecognized JSON shape (expected skill, skill-bundle, or array)');
                    }
                    parsedFiles.push({ name: file.name, skillObjs: skillObjs });
                } catch (perFileErr) {
                    errors.push(file.name + ': ' + perFileErr.message);
                }
            }
            
            var ids = [];
            parsedFiles.forEach(function(pf) {
                pf.skillObjs.forEach(function(o) { if (o && typeof o === 'object') ids.push(_jsonSkillId(o)); });
            });
            cancelled = !(await _confirmSkillImportOverwrite(ids));
            for (var p = 0; !cancelled && p < parsedFiles.length; p++) {
                try {
                    for (var i = 0; i < parsedFiles[p].skillObjs.length; i++) {
                        var res = await importSkillFromJsonObject(parsedFiles[p].skillObjs[i]);
                        imported++;
                        if (res && res.existed) updated++;
                        if (res && res.activationError) activationErrors.push(res.id + ': ' + res.activationError);
                    }
                } catch (perFileErr) {
                    errors.push(parsedFiles[p].name + ': ' + perFileErr.message);
                }
            }
        } finally {
            hideOverlaySpinner();
        }
        if (cancelled) { showSnackbar(t('Import cancelled'), 'info'); return; } // nothing written, no remote call
        
        var msg;
        if (imported === 0) {
            msg = errors.length ? t('No valid skills found in JSON ({error})', { error: errors[0] }) : t('No valid skills found in JSON');
            showSnackbar(msg, 'error');
        } else {
            renderSkillsList();
            msg = updated > 0
                ? tn(imported, 'Imported {count} skill(s) ({updated} updated)', 'Imported {count} skill(s) ({updated} updated)', { updated: i18nFormatNumber(updated) })
                : tn(imported, 'Imported {count} skill(s)', 'Imported {count} skill(s)');
            if (errors.length) msg += ' — ' + tn(errors.length, '{count} file(s) failed: {errors}', '{count} file(s) failed: {errors}', { errors: errors.join('; ') });
            if (activationErrors.length) msg += ' — ' + t('re-activation issues: {issues}', { issues: activationErrors.join('; ') });
            showSnackbar(msg, (errors.length || activationErrors.length) ? 'warning' : 'success');
        }
    };
    input.click();
}

// Back-compat: default importSkills falls back to folder import
async function importSkills() {
    return importSkillsFromFolder();
}

// Save scroll position periodically and track scroll-follow intent
(function() {
    var saveScrollTimeout = null;
    document.addEventListener('scroll', function(e) {
        if (e.target && e.target.id === 'messages' && currentChatId) {
            // Single stick-to-bottom mechanism (see 050-streaming.js): classify
            // this event by position + direction and update stickToBottom.
            handleChatScroll(e.target);

            clearTimeout(saveScrollTimeout);
            saveScrollTimeout = setTimeout(function() {
                appStorage.setItem('scrollPos_' + currentChatId, e.target.scrollTop);
            }, 200);

            // Recalculate streaming container height when the user scrolls (more/less space available)
            if (isRunning) updateStreamingContainerHeight();
        }
    }, true);
})();

// Save pending input as user types (per-chat, persisted to IndexedDB)
// TA3-3: the draft's context is taken from the composer that was typed in, at
// input time. Reading getCurrentPendingContext() when the 300 ms timer fired
// filed a chat draft under 'home' (or another chat) after a quick view switch.
// One timer per context, so typing in one composer never cancels another's save.
(function() {
    var saveInputTimeouts = {};
    function composerContext(el) {
        return el.id === 'home-message-input' ? 'home' : (currentChatId || 'none');
    }
    document.addEventListener('input', function(e) {
        var el = e.target;
        if (el && (el.id === 'message-input' || el.id === 'home-message-input')) {
            var ctx = composerContext(el);
            clearTimeout(saveInputTimeouts[ctx]);
            saveInputTimeouts[ctx] = setTimeout(function() {
                delete saveInputTimeouts[ctx];
                // Write the live value only while this composer still belongs to
                // ctx. After a switch the switch path already snapshotted the draft
                // (savePendingTextForContext); a value captured at input time would
                // bring back a sent draft or a deleted chat's key.
                if (composerContext(el) === ctx) {
                    var value = el.value;
                    if (value) {
                        chatPendingTexts[ctx] = value;
                    } else {
                        delete chatPendingTexts[ctx];
                    }
                }
                persistPendingTextsToStorage();
            }, 300);
        }
    }, true);
})();

// =============================================
// SKILL ACTIONS EDITOR
// =============================================
// Renders the rows in the skill editor under "Actions". Each row is one
// { name, icon, show } action button the skill contributes.

// A5A2-01: unsaved action-row edits live in a draft, never in skills[]. Only
// saveCurrentSkill() persists them; Back, reopen and SKILL.md replace discard it.
var _skillActionsDraft = null; // { skillId, actions }
function resetSkillActionsDraft() { _skillActionsDraft = null; }
function getSkillActionsDraft() {
    var id = currentEditingSkill;
    if (!_skillActionsDraft || _skillActionsDraft.skillId !== id) {
        var saved = (id && skills[id] && Array.isArray(skills[id].actions)) ? skills[id].actions : [];
        _skillActionsDraft = { skillId: id, actions: saved.map(function(a) {
            var c = Object.assign({}, a);
            if (Array.isArray(a.show)) c.show = a.show.slice();
            return c;
        }) };
    }
    return _skillActionsDraft.actions;
}

function renderSkillActionsEditor() {
    var list = document.getElementById('skill-actions-list');
    if (!list) return;
    var actions = getSkillActionsDraft();
    if (!actions.length) {
        list.innerHTML = '<div class="skill-actions-empty">' + escapeHtml(t('No actions yet. Click + to add a button.')) + '</div>';
        return;
    }
    list.innerHTML = actions.map(function(a, i) { return renderSkillActionRow(a, i); }).join('');
}

// Placement metadata — label + representative mini-icon for radio buttons
var ACTION_PLACEMENT_META = {
    home:       { label: N_('Home'),       icon: 'widget' },
    chat:       { label: N_('Chat'),       icon: 'send' },
    sidebar:    { label: N_('Sidebar'),    icon: 'panelLeftOpen' }
};

function renderSkillActionRow(action, index) {
    var iconSvg = (UI_ICONS[action.icon] || UI_ICONS.play);
    var showList = Array.isArray(action.show) ? action.show : [action.show || 'home'];
    var placementBtns = ACTION_PLACEMENTS.map(function(p) {
        var meta = ACTION_PLACEMENT_META[p] || { label: p, icon: 'play' };
        var iconHtml = UI_ICONS[meta.icon] || '';
        var label = escapeHtml(t(meta.label));
        var sel = showList.indexOf(p) >= 0 ? ' selected' : '';
        return '<button type="button" class="skill-action-place-btn' + sel + '" data-placement="' + p + '" ' +
            'onclick="toggleSkillActionPlacement(' + index + ',\'' + p + '\')" ' +
            'title="' + label + '" aria-pressed="' + (sel ? 'true' : 'false') + '">' +
            '<span class="skill-action-place-icon" aria-hidden="true">' + iconHtml + '</span>' +
            '<span class="skill-action-place-label">' + label + '</span>' +
            '</button>';
    }).join('');
    // Single-row layout: icon btn | name | placement pills | remove btn
    return '' +
        '<div class="skill-action-row" data-action-index="' + index + '">' +
            '<button type="button" class="skill-action-icon-btn" title="' + escapeHtml(t('Choose icon')) + '" aria-label="' + escapeHtml(t('Choose icon')) + '" onclick="openIconPicker(' + index + ')">' +
                '<span class="skill-action-preview" aria-hidden="true">' + iconSvg + '</span>' +
            '</button>' +
            '<input type="hidden" class="skill-action-icon" value="' + escapeHtml(action.icon || 'play') + '" />' +
            '<input type="text" class="skill-action-name" value="' + escapeHtml(action.name || '') + '" placeholder="' + escapeHtml(t('Button label')) + '" maxlength="48" oninput="onSkillActionFieldChange(' + index + ')" />' +
            '<div class="skill-action-placement" role="group" aria-label="' + escapeHtml(t('Placements (multi-select)')) + '">' + placementBtns + '</div>' +
            '<button type="button" class="skill-action-remove" title="' + escapeHtml(t('Remove')) + '" aria-label="' + escapeHtml(t('Remove action')) + '" onclick="removeSkillAction(' + index + ')">' + UI_ICONS.close + '</button>' +
        '</div>';
}

// Called when any field in a row changes — updates the preview icon and keeps in-memory state
function onSkillActionFieldChange(index) {
    var actions = collectSkillActionsFromEditor();
    if (currentEditingSkill && skills[currentEditingSkill]) {
        _skillActionsDraft = { skillId: currentEditingSkill, actions: actions };
    }
    // Update preview icon for this row only (avoid re-render to preserve focus)
    var row = document.querySelector('.skill-action-row[data-action-index="' + index + '"]');
    if (row && actions[index]) {
        var preview = row.querySelector('.skill-action-preview');
        if (preview) preview.innerHTML = UI_ICONS[actions[index].icon] || UI_ICONS.play;
    }
}

// Placement pill clicked — toggles that placement (multi-select)
function toggleSkillActionPlacement(index, placement) {
    var row = document.querySelector('.skill-action-row[data-action-index="' + index + '"]');
    if (!row) return;
    var btn = row.querySelector('.skill-action-place-btn[data-placement="' + placement + '"]');
    if (!btn) return;
    var wasOn = btn.classList.contains('selected');
    // Enforce at least one placement remains selected
    var selected = row.querySelectorAll('.skill-action-place-btn.selected');
    if (wasOn && selected.length === 1) {
        // Can't deselect the last one
        return;
    }
    btn.classList.toggle('selected', !wasOn);
    btn.setAttribute('aria-pressed', !wasOn ? 'true' : 'false');
    onSkillActionFieldChange(index);
}

// ----- Icon picker modal -----
var _iconPickerTargetIndex = null;

function openIconPicker(index) {
    _iconPickerTargetIndex = index;
    var row = document.querySelector('.skill-action-row[data-action-index="' + index + '"]');
    var current = row ? (row.querySelector('.skill-action-icon') || {}).value : '';
    var gridHtml = ACTION_ICONS.map(function(name) {
        if (!UI_ICONS[name]) return '';
        var sel = name === current ? ' selected' : '';
        return '<button type="button" class="icon-picker-item' + sel + '" data-icon="' + name + '" ' +
            'onclick="chooseIconForAction(\'' + name + '\')" title="' + name + '" aria-label="' + name + '">' +
            '<span class="icon-picker-svg" aria-hidden="true">' + UI_ICONS[name] + '</span>' +
            '<span class="icon-picker-label">' + name + '</span>' +
            '</button>';
    }).join('');
    var html = '<div class="modal-backdrop icon-picker-backdrop" onclick="closeIconPicker(event)">' +
        '<div class="modal icon-picker-modal" onclick="event.stopPropagation()">' +
            '<div class="modal-header"><span class="modal-title-text">' + escapeHtml(t('Choose icon')) + '</span>' +
                '<button class="modal-close-icon" onclick="closeIconPicker()" aria-label="' + escapeHtml(t('Close')) + '">' + UI_ICONS.close + '</button>' +
            '</div>' +
            '<div class="icon-picker-grid">' + gridHtml + '</div>' +
        '</div>' +
    '</div>';
    var wrap = document.createElement('div');
    wrap.id = 'icon-picker-host';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
}

function closeIconPicker(e) {
    if (e && e.target && !e.target.classList.contains('icon-picker-backdrop') && e.type === 'click') {
        // Only close when clicking backdrop or close button (which calls without e)
        if (e.currentTarget !== e.target) return;
    }
    var host = document.getElementById('icon-picker-host');
    if (host) host.remove();
    _iconPickerTargetIndex = null;
}

function chooseIconForAction(iconName) {
    var index = _iconPickerTargetIndex;
    closeIconPicker();
    if (index == null) return;
    var row = document.querySelector('.skill-action-row[data-action-index="' + index + '"]');
    if (!row) return;
    var hidden = row.querySelector('.skill-action-icon');
    var preview = row.querySelector('.skill-action-preview');
    if (hidden) hidden.value = iconName;
    if (preview) preview.innerHTML = UI_ICONS[iconName] || UI_ICONS.play;
    onSkillActionFieldChange(index);
}

function collectSkillActionsFromEditor() {
    var list = document.getElementById('skill-actions-list');
    if (!list) {
        // Editor not visible — preserve whatever is in memory
        return getSkillActionsDraft().slice();
    }
    var rows = list.querySelectorAll('.skill-action-row');
    var actions = [];
    rows.forEach(function(row) {
        var nameEl = row.querySelector('.skill-action-name');
        var iconEl = row.querySelector('.skill-action-icon');
        var showBtns = row.querySelectorAll('.skill-action-place-btn.selected');
        var showList = [].map.call(showBtns, function(b) { return b.getAttribute('data-placement'); });
        var a = sanitizeAction({
            name: nameEl ? nameEl.value : '',
            icon: iconEl ? iconEl.value : 'play',
            show: showList
        });
        if (a) actions.push(a);
    });
    return actions;
}

function addSkillAction() {
    if (!currentEditingSkill) { showSnackbar(t('Save the skill first'), 'error', undefined, { key: 'skill-editor' }); return; }
    var skill = skills[currentEditingSkill];
    if (!skill) return;
    var actions = collectSkillActionsFromEditor();
    _skillActionsDraft = { skillId: currentEditingSkill, actions: actions };
    if (actions.length >= 8) { showSnackbar(t('Max 8 actions per skill'), 'error', undefined, { key: 'skill-editor' }); return; }
    actions.push({ name: 'New Action', icon: 'play', show: ['home'] });
    renderSkillActionsEditor();
}

function removeSkillAction(index) {
    if (!currentEditingSkill) return;
    var skill = skills[currentEditingSkill];
    if (!skill) return; // the draft may hold rows the saved skill does not (A5A2-01)
    var actions = collectSkillActionsFromEditor();
    _skillActionsDraft = { skillId: currentEditingSkill, actions: actions };
    actions.splice(index, 1);
    renderSkillActionsEditor();
}

