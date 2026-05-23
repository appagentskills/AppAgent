async function addSampleTool() {
    if (!currentEditingSkill) { showSnackbar('Save the skill first', 'error'); return; }

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
    showSnackbar('Sample tool added', 'success');
}

async function addSkillAsset() {
    if (!currentEditingSkill) { showSnackbar('Save the skill first', 'error'); return; }
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml,.md,.js';
    input.multiple = true;
    input.onchange = async function(e) {
        var files = e.target.files;
        var skillUpdated = false;
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            var ext = file.name.split('.').pop().toLowerCase();
            if (ext === 'xml' || ext === 'md' || ext === 'js') {
                var content = await file.text();
                
                // If importing SKILL.md, update the skill's parsed content (don't save as asset)
                if (file.name === 'SKILL.md' || file.name.toLowerCase() === 'skill.md') {
                    var parsed = parseSkillMarkdown(content, currentEditingSkill);
                    var skill = skills[currentEditingSkill];
                    if (skill) {
                        skill.name = parsed.name || skill.name;
                        skill.description = parsed.description || skill.description;
                        skill.body = parsed.body;
                        skill.actions = dedupeActionsByActionId(skill.name, parsed.actions || []);
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
                        renderSkillActionsEditor();
                    }
                    continue; // Don't save SKILL.md as a separate asset
                }
                
                await saveSkillAsset(currentEditingSkill, file.name, ext, content);
            }
        }
        await renderSkillAssets();
        var msg = skillUpdated ? 'Skill updated from SKILL.md' : 'Added ' + files.length + ' file(s)';
        showSnackbar(msg, 'success');
    };
    input.click();
}

async function removeSkillAsset(filename) {
    if (!currentEditingSkill) return;
    var confirmed = await showConfirmModal('Remove File', 'Remove ' + filename + ' from this skill?');
    if (!confirmed) return;
    await deleteSkillAsset(currentEditingSkill, filename);
    await renderSkillAssets();
    showSnackbar('File removed', 'success');
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
    if (!asset) { showSnackbar('File not found', 'error'); return; }
    var mimeType = asset.type === 'xml' ? 'application/xml' : (asset.type === 'js' ? 'application/javascript' : 'text/markdown');
    downloadFile(filename, asset.content, mimeType);
}

async function renameSkillAsset(oldFilename) {
    if (!currentEditingSkill) return;
    
    // Get current extension
    var ext = oldFilename.substring(oldFilename.lastIndexOf('.'));
    var baseName = oldFilename.substring(0, oldFilename.lastIndexOf('.'));
    
    var newName = await showPromptModal('Rename File', 'Enter new filename:', baseName);
    if (!newName || newName === baseName) return;
    
    // Ensure proper extension
    var newFilename = newName;
    if (!newFilename.endsWith(ext)) {
        newFilename += ext;
    }
    
    // Check if new filename already exists
    var existingAsset = await getSkillAsset(currentEditingSkill, newFilename);
    if (existingAsset) {
        showSnackbar('A file with that name already exists', 'error');
        return;
    }
    
    // Get old asset content
    var asset = await getSkillAsset(currentEditingSkill, oldFilename);
    if (!asset) { showSnackbar('File not found', 'error'); return; }
    
    // Save with new name and remove old
    await saveSkillAsset(currentEditingSkill, newFilename, asset.type, asset.content);
    await deleteSkillAsset(currentEditingSkill, oldFilename);
    
    await renderSkillAssets();
    showSnackbar('File renamed to ' + newFilename, 'success');
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
    if (!asset) { showSnackbar('File not found', 'error'); return; }
    
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
        ? '<button class="modal-edit-btn active" onclick="toggleAssetEditMode()" title="View">' + UI_ICONS.eye + '</button>'
        : '<button class="modal-edit-btn" onclick="toggleAssetEditMode()" title="Edit">' + UI_ICONS.edit + '</button>';
    
    header.innerHTML = '<span class="modal-title-text">' + escapeHtml(asset.filename) + '</span><div class="modal-header-actions">' + editBtn + '<button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';
    
    if (assetEditMode) {
        body.innerHTML = '<textarea class="skill-asset-editor" id="asset-edit-textarea">' + escapeHtml(asset.content) + '</textarea>';
        actions.innerHTML = '<button class="modal-btn secondary" onclick="closeModal()">Cancel</button><button class="modal-btn primary" onclick="saveAssetEdit()">Save</button>';
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
            renderSkillActionsEditor();
        }
    }
    
    await saveSkillAsset(currentEditingSkill, filename, ext, newContent);
    currentViewingAsset.content = newContent;
    assetEditMode = false;
    renderAssetModal();
    showSnackbar('File saved', 'success');
}

function editSkillWithAgent() {
    if (!currentEditingSkill) return;
    var skill = skills[currentEditingSkill];
    if (!skill) return;

    // Close skills panel and go to chat
    closeSkillsView();

    // Create a new chat with just the skill name
    newChat();

    // Pre-fill the message input with just the skill name
    var input = document.getElementById('message-input');
    if (input) {
        input.value = 'I want to edit the skill: ' + (skill.name || skill.id) + '\n\nWhat changes would you like to make?';
        autoResizeTextarea(input);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
}

function closeSkillEditor() {
    currentEditingSkill = null;
    appStorage.removeItem('currentEditingSkill');
    appStorage.setItem('currentView', 'skills');
    var editorPanel = document.getElementById('skill-editor-panel');
    var listPanel = document.getElementById('skills-list-panel');
    if (editorPanel) editorPanel.style.display = 'none';
    if (listPanel) listPanel.style.display = 'flex';
    renderSkillsList();
    pushHistoryState('skills', null, null);
}

async function saveCurrentSkill() {
    var nameInput = document.getElementById('skill-name-input');
    var descInput = document.getElementById('skill-description-input');
    var bodyInput = document.getElementById('skill-body-input');
    var name = (nameInput ? nameInput.value : '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
    var description = (descInput ? descInput.value : '').trim();
    var body = (bodyInput ? bodyInput.value : '').trim();
    var actions = collectSkillActionsFromEditor();
    if (!name) { showSnackbar('Name is required', 'error'); return; }
    if (name.length > 64) { showSnackbar('Name must be 64 characters or less', 'error'); return; }
    if (!description) { showSnackbar('Description is required', 'error'); return; }
    // Reject collisions on the normalized actionId. getActionId lowercases and
    // slugifies, so "Run audit" and "RUN-AUDIT" hash to the same id — the
    // engine then can't distinguish them and only one button effectively works.
    if (typeof getActionId === 'function' && actions.length > 1) {
        var seenActionIds = {};
        for (var ai = 0; ai < actions.length; ai++) {
            var aid = getActionId(name || 'skill', actions[ai].name);
            if (seenActionIds[aid]) {
                showSnackbar('Two actions normalize to the same id: "' + seenActionIds[aid] + '" and "' + actions[ai].name + '". Rename one.', 'error');
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
    showSnackbar('Skill saved', 'success');
    closeSkillEditor();
}

async function deleteCurrentSkill() {
    if (!currentEditingSkill) return;
    var confirmed = await showConfirmModal('Delete Skill', 'Delete this skill? This cannot be undone.');
    if (!confirmed) return;
    await deleteSkill(currentEditingSkill);
    showSnackbar('Skill deleted', 'success');
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
        return s.substring(1, s.length - 1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
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
    return _needsYamlQuote(s) ? '"' + s.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"' : s;
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
    if (!skill) { showSnackbar('Skill not found', 'error'); return; }
    
    if (!window.showDirectoryPicker) {
        showSnackbar('Your browser does not support folder export. Use Chrome or Edge.', 'error');
        return;
    }
    
    try {
        var dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
        await _writeSkillToDir(skill, dirHandle);
        showSnackbar('Exported skill "' + (skill.name || skill.id) + '" to folder', 'success');
    } catch (err) {
        if (err.name !== 'AbortError') showSnackbar('Export failed: ' + err.message, 'error');
    }
}

async function exportSkillToJson(skillId) {
    var skill = skills[skillId];
    if (!skill) { showSnackbar('Skill not found', 'error'); return; }
    try {
        var skillObj = await skillToJsonObject(skill);
        var bundle = { version: 1, type: 'skill', exportedAt: new Date().toISOString(), skill: skillObj };
        var filename = _skillFolderName(skill) + '.skill.json';
        downloadFile(filename, JSON.stringify(bundle, null, 2), 'application/json');
        showSnackbar('Exported skill "' + (skill.name || skill.id) + '" as JSON', 'success');
    } catch (err) {
        showSnackbar('Export failed: ' + err.message, 'error');
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
    if (skillList.length === 0) { showSnackbar('No skills to export', 'error'); return; }
    
    if (!window.showDirectoryPicker) {
        showSnackbar('Your browser does not support folder export. Use Chrome or Edge.', 'error');
        return;
    }
    
    try {
        var dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
        var exported = 0;
        for (var i = 0; i < skillList.length; i++) {
            await _writeSkillToDir(skillList[i], dirHandle);
            exported++;
        }
        showSnackbar('Exported ' + exported + ' skill(s) to folder', 'success');
    } catch (err) {
        if (err.name !== 'AbortError') showSnackbar('Export failed: ' + err.message, 'error');
    }
}

async function exportAllSkillsToJson() {
    var skillList = Object.values(skills);
    if (skillList.length === 0) { showSnackbar('No skills to export', 'error'); return; }
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
        showSnackbar('Exported ' + skillObjs.length + ' skill(s) as JSON', 'success');
    } catch (err) {
        showSnackbar('Export failed: ' + err.message, 'error');
    }
}

// Back-compat: previous default was folder export
async function exportAllSkills() {
    return exportAllSkillsToFolder();
}

async function importSkillFromFolder(dirHandle, folderName) {
    // Helper to import a single skill folder
    var skillFile = await dirHandle.getFileHandle('SKILL.md');
    var file = await skillFile.getFile();
    var content = await file.text();
    var parsed = parseSkillMarkdown(content, folderName);
    
    var id = parsed.name || folderName;
    
    // If skill with same name exists, deactivate and delete its assets first (overwrite).
    // Remember active state so we can re-activate after re-import.
    var wasActive = !!activeSkills[id];
    if (skills[id]) {
        if (wasActive) {
            await deactivateSkill(id);
        }
        await deleteSkillAssets(id);
    }
    
    await saveSkill({
        id: id,
        name: parsed.name || folderName,
        description: parsed.description || '',
        body: parsed.body,
        userModified: true,
        createdAt: skills[id] ? skills[id].createdAt : Date.now(),
        updatedAt: Date.now()
    });
    
    // Import all other files as assets (XML, MD, JS files, excluding SKILL.md)
    for await (var fileEntry of dirHandle.values()) {
        if (fileEntry.kind === 'file' && fileEntry.name !== 'SKILL.md') {
            var ext = fileEntry.name.split('.').pop().toLowerCase();
            if (ext === 'xml' || ext === 'md' || ext === 'js') {
                var assetFile = await dirHandle.getFileHandle(fileEntry.name);
                var assetData = await assetFile.getFile();
                var assetContent = await assetData.text();
                await saveSkillAsset(id, fileEntry.name, ext, assetContent);
            }
        }
    }
    
    // Re-activate if it was active before
    if (wasActive) {
        try { await activateSkill(id); } catch (e) { /* leave inactive on failure */ }
    }
    return id;
}

async function importSkillsFromFolder() {
    if (!window.showDirectoryPicker) {
        showSnackbar('Your browser does not support folder import. Use Chrome or Edge.', 'error');
        return;
    }
    
    try {
        var dirHandle = await window.showDirectoryPicker({ mode: 'read', startIn: 'downloads' });
        showOverlaySpinner('Importing skills...');
        var imported = 0;
        var updated = 0;
        
        // First check if the selected folder is a single skill folder (has SKILL.md)
        var isSingleSkill = false;
        try {
            await dirHandle.getFileHandle('SKILL.md');
            isSingleSkill = true;
        } catch (e) { /* Not a single skill folder */ }
        
        if (isSingleSkill) {
            // Import single skill folder directly
            var parsed = parseSkillMarkdown(await (await (await dirHandle.getFileHandle('SKILL.md')).getFile()).text(), dirHandle.name);
            var skillId = parsed.name || dirHandle.name;
            if (skills[skillId]) updated++;
            await importSkillFromFolder(dirHandle, dirHandle.name);
            imported = 1;
        } else {
            // Import folder containing multiple skill folders
            for await (var entry of dirHandle.values()) {
                if (entry.kind === 'directory') {
                    try {
                        var skillDir = await dirHandle.getDirectoryHandle(entry.name);
                        var skillFile = await skillDir.getFileHandle('SKILL.md');
                        var content = await (await skillFile.getFile()).text();
                        var parsed = parseSkillMarkdown(content, entry.name);
                        var skillId = parsed.name || entry.name;
                        if (skills[skillId]) updated++;
                        await importSkillFromFolder(skillDir, entry.name);
                        imported++;
                    } catch (e) { /* Skip folders without SKILL.md */ }
                }
            }
        }
        
        hideOverlaySpinner();
        if (imported === 0) {
            showSnackbar('No valid skills found. Folder should contain SKILL.md or subfolders with SKILL.md', 'error');
        } else {
            renderSkillsList();
            var msg = 'Imported ' + imported + ' skill(s)';
            if (updated > 0) msg += ' (' + updated + ' updated)';
            showSnackbar(msg, 'success');
        }
    } catch (err) {
        hideOverlaySpinner();
        if (err.name !== 'AbortError') showSnackbar('Import failed: ' + err.message, 'error');
    }
}

// Normalize a raw skill id/name into the canonical id used in the skills map
function _normalizeSkillId(raw) {
    if (!raw) return '';
    return String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '').substring(0, 64);
}

// Import a skill from a parsed JSON object. Handles bare-skill, single-wrapped, and bundle formats.
// Returns { id, existed } where `existed` reflects whether a skill with that id was already present
// BEFORE the import (so callers can count updates vs creates).
async function importSkillFromJsonObject(skillObj) {
    if (!skillObj || typeof skillObj !== 'object') {
        throw new Error('Invalid skill object');
    }
    var id = _normalizeSkillId(skillObj.id || skillObj.name) || 'untitled';
    var existed = !!skills[id];
    var existingCreatedAt = existed ? skills[id].createdAt : Date.now();
    var wasActive = !!activeSkills[id];
    
    // If skill with same id exists, deactivate and delete its assets first (overwrite).
    // We remember `wasActive` so we can re-activate after the new content is in place.
    if (existed) {
        if (wasActive) {
            await deactivateSkill(id);
        }
        await deleteSkillAssets(id);
    }
    
    var actions = Array.isArray(skillObj.actions)
        ? skillObj.actions.map(sanitizeAction).filter(function(a){ return a; })
        : [];
    
    await saveSkill({
        id: id,
        name: skillObj.name || id,
        description: skillObj.description || '',
        body: skillObj.body || '',
        actions: actions,
        userModified: true,
        createdAt: existingCreatedAt,
        updatedAt: Date.now()
    });
    
    // Import inlined assets
    var assets = Array.isArray(skillObj.assets) ? skillObj.assets : [];
    for (var i = 0; i < assets.length; i++) {
        var a = assets[i];
        if (!a || !a.filename || typeof a.content !== 'string') continue;
        var ext = (a.type || a.filename.split('.').pop() || '').toLowerCase();
        if (ext !== 'xml' && ext !== 'md' && ext !== 'js') continue;
        if (a.filename === 'SKILL.md' || a.filename.toLowerCase() === 'skill.md') continue;
        await saveSkillAsset(id, a.filename, ext, a.content);
    }
    
    // Re-activate if it was active before
    if (wasActive) {
        try { await activateSkill(id); } catch (e) { /* leave inactive on failure */ }
    }
    return { id: id, existed: existed, wasActive: wasActive };
}

async function importSkillsFromJsonFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.multiple = true;
    input.onchange = async function(e) {
        var files = e.target.files;
        if (!files || !files.length) return;
        showOverlaySpinner('Importing skills...');
        var imported = 0;
        var updated = 0;
        var errors = [];
        try {
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
                    
                    for (var i = 0; i < skillObjs.length; i++) {
                        var res = await importSkillFromJsonObject(skillObjs[i]);
                        imported++;
                        if (res && res.existed) updated++;
                    }
                } catch (perFileErr) {
                    errors.push(file.name + ': ' + perFileErr.message);
                }
            }
        } finally {
            hideOverlaySpinner();
        }
        
        var msg;
        if (imported === 0) {
            msg = 'No valid skills found in JSON';
            if (errors.length) msg += ' (' + errors[0] + ')';
            showSnackbar(msg, 'error');
        } else {
            renderSkillsList();
            msg = 'Imported ' + imported + ' skill(s)';
            if (updated > 0) msg += ' (' + updated + ' updated)';
            if (errors.length) msg += ' — ' + errors.length + ' file(s) failed';
            showSnackbar(msg, errors.length ? 'warning' : 'success');
        }
    };
    input.click();
}

// Back-compat: default importSkills falls back to folder import
async function importSkills() {
    return importSkillsFromFolder();
}

// Save scroll position periodically and track user scroll-away during streaming
(function() {
    var saveScrollTimeout = null;
    document.addEventListener('scroll', function(e) {
        if (e.target && e.target.id === 'messages' && currentChatId) {
            // Record user scroll time for debounce
            lastUserScrollTime = Date.now();

            clearTimeout(saveScrollTimeout);
            saveScrollTimeout = setTimeout(function() {
                appStorage.setItem('scrollPos_' + currentChatId, e.target.scrollTop);
            }, 200);

            // Track scroll following: disable when user scrolls away, re-enable when they scroll back to bottom
            if (isNearBottom(e.target)) {
                isFollowingScroll = true;
            } else {
                isFollowingScroll = false;
            }

            // Recalculate streaming container height when user scrolls (more/less space available)
            if (isRunning) updateStreamingContainerHeight();
        }
    }, true);
})();

// Save pending input as user types (per-chat, persisted to IndexedDB)
(function() {
    var saveInputTimeout = null;
    document.addEventListener('input', function(e) {
        if (e.target && (e.target.id === 'message-input' || e.target.id === 'home-message-input')) {
            clearTimeout(saveInputTimeout);
            saveInputTimeout = setTimeout(function() {
                var ctx = getCurrentPendingContext();
                var value = e.target.value;
                if (value) {
                    chatPendingTexts[ctx] = value;
                } else {
                    delete chatPendingTexts[ctx];
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

function renderSkillActionsEditor() {
    var list = document.getElementById('skill-actions-list');
    if (!list) return;
    var skill = currentEditingSkill ? skills[currentEditingSkill] : null;
    var actions = (skill && Array.isArray(skill.actions)) ? skill.actions : [];
    if (!actions.length) {
        list.innerHTML = '<div class="skill-actions-empty">No actions yet. Click + to add a button.</div>';
        return;
    }
    list.innerHTML = actions.map(function(a, i) { return renderSkillActionRow(a, i); }).join('');
}

// Placement metadata — label + representative mini-icon for radio buttons
var ACTION_PLACEMENT_META = {
    home:       { label: 'Home',       icon: 'widget' },
    chat:       { label: 'Chat',       icon: 'send' },
    sidebar:    { label: 'Sidebar',    icon: 'panelLeftOpen' }
};

function renderSkillActionRow(action, index) {
    var iconSvg = (UI_ICONS[action.icon] || UI_ICONS.play);
    var showList = Array.isArray(action.show) ? action.show : [action.show || 'home'];
    var placementBtns = ACTION_PLACEMENTS.map(function(p) {
        var meta = ACTION_PLACEMENT_META[p] || { label: p, icon: 'play' };
        var iconHtml = UI_ICONS[meta.icon] || '';
        var sel = showList.indexOf(p) >= 0 ? ' selected' : '';
        return '<button type="button" class="skill-action-place-btn' + sel + '" data-placement="' + p + '" ' +
            'onclick="toggleSkillActionPlacement(' + index + ',\'' + p + '\')" ' +
            'title="' + meta.label + '" aria-pressed="' + (sel ? 'true' : 'false') + '">' +
            '<span class="skill-action-place-icon" aria-hidden="true">' + iconHtml + '</span>' +
            '<span class="skill-action-place-label">' + meta.label + '</span>' +
            '</button>';
    }).join('');
    // Single-row layout: icon btn | name | placement pills | remove btn
    return '' +
        '<div class="skill-action-row" data-action-index="' + index + '">' +
            '<button type="button" class="skill-action-icon-btn" title="Choose icon" aria-label="Choose icon" onclick="openIconPicker(' + index + ')">' +
                '<span class="skill-action-preview" aria-hidden="true">' + iconSvg + '</span>' +
            '</button>' +
            '<input type="hidden" class="skill-action-icon" value="' + escapeHtml(action.icon || 'play') + '" />' +
            '<input type="text" class="skill-action-name" value="' + escapeHtml(action.name || '') + '" placeholder="Button label" maxlength="48" oninput="onSkillActionFieldChange(' + index + ')" />' +
            '<div class="skill-action-placement" role="group" aria-label="Placements (multi-select)">' + placementBtns + '</div>' +
            '<button type="button" class="skill-action-remove" title="Remove" aria-label="Remove action" onclick="removeSkillAction(' + index + ')">' + UI_ICONS.close + '</button>' +
        '</div>';
}

// Called when any field in a row changes — updates the preview icon and keeps in-memory state
function onSkillActionFieldChange(index) {
    var actions = collectSkillActionsFromEditor();
    if (currentEditingSkill && skills[currentEditingSkill]) {
        skills[currentEditingSkill].actions = actions;
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
            '<div class="modal-header"><span class="modal-title-text">Choose icon</span>' +
                '<button class="modal-close-icon" onclick="closeIconPicker()" aria-label="Close">' + UI_ICONS.close + '</button>' +
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
        var s = currentEditingSkill ? skills[currentEditingSkill] : null;
        return (s && Array.isArray(s.actions)) ? s.actions.slice() : [];
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
    if (!currentEditingSkill) { showSnackbar('Save the skill first', 'error'); return; }
    var skill = skills[currentEditingSkill];
    if (!skill) return;
    skill.actions = collectSkillActionsFromEditor();
    if (skill.actions.length >= 8) { showSnackbar('Max 8 actions per skill', 'error'); return; }
    skill.actions.push({ name: 'New Action', icon: 'play', show: ['home'] });
    renderSkillActionsEditor();
}

function removeSkillAction(index) {
    if (!currentEditingSkill) return;
    var skill = skills[currentEditingSkill];
    if (!skill || !Array.isArray(skill.actions)) return;
    skill.actions = collectSkillActionsFromEditor();
    skill.actions.splice(index, 1);
    renderSkillActionsEditor();
}

// Populate provider dropdown from all providers
function populateProviderDropdown() {
    var container = document.getElementById('settings-provider-container');
    if (!container) return;
    
    var options = getAllProviders().map(function(p) {
        return { value: p.name, label: p.name };
    });
    
    renderCustomSelect('settings-provider-container', options, currentProvider, changeProvider, 'Select model...');
}
