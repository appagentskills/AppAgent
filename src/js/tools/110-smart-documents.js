// SMART DOCUMENTS — Persistent, versioned markdown documents
// =============================================
// Documents live in IndexedDB, referenced by ID across chats.
// Multiple <!--document:ID--> placeholders all render the same current version.
// Supports embedded display templates, non-blocking prompts, inline diff.

var smartDocuments = {}; // in-memory cache: docId -> doc object

// ─── IndexedDB CRUD ───

async function loadAllDocuments() {
    try {
        var database = await openDatabase();
        var tx = database.transaction([documentsStoreName], 'readonly');
        var store = tx.objectStore(documentsStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var results = request.result || [];
                results.forEach(function(doc) {
                    smartDocuments[doc.id] = doc;
                    if (doc.file_id) registerFile(doc.file_id, { type: 'document', docId: doc.id });
                });
                resolve(results);
            };
            request.onerror = function() { resolve([]); };
        });
    } catch (e) {
        console.error('Failed to load documents:', e);
        return [];
    }
}

async function saveDocument(doc) {
    smartDocuments[doc.id] = doc;
    try {
        var database = await openDatabase();
        var tx = database.transaction([documentsStoreName], 'readwrite');
        tx.objectStore(documentsStoreName).put(doc);
    } catch (e) {
        console.error('Failed to save document:', e);
    }
}

// Load a single document from IDB into the in-memory cache.
// Used by the page when the worker emits documentChanged for a doc the
// page hasn't seen yet (worker created/updated it, page cache is stale).
async function loadDocumentById(docId) {
    if (!docId) return null;
    try {
        var database = await openDatabase();
        var tx = database.transaction([documentsStoreName], 'readonly');
        var store = tx.objectStore(documentsStoreName);
        var request = store.get(docId);
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var doc = request.result;
                if (doc) {
                    smartDocuments[doc.id] = doc;
                    if (doc.file_id && typeof registerFile === 'function') {
                        registerFile(doc.file_id, { type: 'document', docId: doc.id });
                    }
                }
                resolve(doc || null);
            };
            request.onerror = function() { resolve(null); };
        });
    } catch (e) {
        console.error('Failed to load document ' + docId + ':', e);
        return null;
    }
}

async function deleteDocumentById(docId) {
    delete smartDocuments[docId];
    try {
        var database = await openDatabase();
        var tx = database.transaction([documentsStoreName], 'readwrite');
        tx.objectStore(documentsStoreName).delete(docId);
    } catch (e) {
        console.error('Failed to delete document:', e);
    }
}

// ─── Tool Execution ───

async function executeSmartDocument(args, messageIndex, options) {
    var action = args.action;
    if (!action) return { success: false, error: 'action is required' };

    if (action === 'create') return await sdocToolCreate(args, options);
    if (action === 'update') return await sdocToolUpdate(args, options);
    if (action === 'edit') return await sdocToolEdit(args, options);
    if (action === 'read') return sdocToolRead(args);
    if (action === 'list') return sdocToolList();
    if (action === 'list_versions') return sdocToolListVersions(args);
    if (action === 'read_version') return sdocToolReadVersion(args);
    if (action === 'delete') return await sdocToolDelete(args, options);
    return { success: false, error: 'Unknown action: ' + action };
}

async function sdocToolCreate(args, options) {
    var title = args.title || 'Untitled Document';
    var content = args.content || '';
    var docId = 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 7);
    var now = Date.now();

    var fileId = newFileId();
    var doc = {
        id: docId, title: title, currentContent: content, currentVersion: 1,
        versions: [{ version: 1, content: content, title: title, author: 'agent', timestamp: now }],
        displays: {}, prompts: args.prompts || [], createdAt: now, updatedAt: now,
        file_id: fileId
    };

    sdocCopyDisplays(doc, content, options);
    sdocInitPrompts(doc);
    await saveDocument(doc);
    registerFile(fileId, { type: 'document', docId: docId });
    AgentEvents.emit('documentChanged', { chatId: _sdocChatId(options), docId: docId, kind: 'created' });

    return {
        success: true, doc_id: docId, version: 1, file_id: doc.file_id,
        message: 'Document created. Include <!--document:' + docId + '--> in your response to render it inline.',
        _document_placeholder: '<!--document:' + docId + '-->'
    };
}

async function sdocToolUpdate(args, options) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    var doc = smartDocuments[docId];
    if (!doc) return { success: false, error: 'Document not found: ' + docId };

    var changed = false;
    if (args.content !== undefined || args.title) {
        doc.currentVersion++;
        if (args.content !== undefined) doc.currentContent = args.content;
        if (args.title) doc.title = args.title;
        doc.versions.push({
            version: doc.currentVersion, content: doc.currentContent,
            title: doc.title, author: 'agent', timestamp: Date.now()
        });
        sdocCopyDisplays(doc, doc.currentContent, options);
        changed = true;
    }
    if (args.prompts) { doc.prompts = args.prompts; sdocInitPrompts(doc); changed = true; }

    if (changed) {
        doc.updatedAt = Date.now();
        await saveDocument(doc);
        AgentEvents.emit('documentChanged', { chatId: _sdocChatId(options), docId: docId, kind: 'updated' });
    }

    return {
        success: true, doc_id: docId, version: doc.currentVersion, file_id: doc.file_id || null,
        message: 'Document updated (v' + doc.currentVersion + '). Include <!--document:' + docId + '--> in your response to render it inline.',
        _document_placeholder: '<!--document:' + docId + '-->'
    };
}

function sdocToolRead(args) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    var doc = smartDocuments[docId];
    if (!doc) return { success: false, error: 'Document not found: ' + docId };

    var promptResponses = {};
    (doc.prompts || []).forEach(function(p) {
        if (p.status === 'answered' && p.responses) promptResponses[p.id] = p.responses;
    });

    return {
        success: true, doc_id: doc.id, title: doc.title, content: doc.currentContent,
        version: doc.currentVersion, versions_count: doc.versions.length,
        file_id: doc.file_id || null,
        prompt_responses: promptResponses, updated_at: doc.updatedAt
    };
}

function sdocToolList() {
    var list = Object.values(smartDocuments).map(function(doc) {
        return { doc_id: doc.id, title: doc.title, current_version: doc.currentVersion, updated_at: doc.updatedAt, created_at: doc.createdAt };
    });
    list.sort(function(a, b) { return b.updated_at - a.updated_at; });
    return { success: true, documents: list };
}

function sdocToolListVersions(args) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    var doc = smartDocuments[docId];
    if (!doc) return { success: false, error: 'Document not found: ' + docId };
    return {
        success: true, doc_id: docId,
        versions: doc.versions.map(function(v) {
            return { version: v.version, author: v.author, timestamp: v.timestamp, title: v.title };
        })
    };
}

function sdocToolReadVersion(args) {
    var docId = args.doc_id;
    var version = args.version;
    if (!docId) return { success: false, error: 'doc_id is required' };
    if (!version) return { success: false, error: 'version is required' };
    var doc = smartDocuments[docId];
    if (!doc) return { success: false, error: 'Document not found: ' + docId };
    var v = doc.versions.find(function(ver) { return ver.version === version; });
    if (!v) return { success: false, error: 'Version ' + version + ' not found' };
    return { success: true, doc_id: docId, version: v.version, content: v.content, title: v.title, author: v.author, timestamp: v.timestamp };
}

async function sdocToolEdit(args, options) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    var doc = smartDocuments[docId];
    if (!doc) return { success: false, error: 'Document not found: ' + docId };
    var edits = args.edits;
    if (!edits || !Array.isArray(edits) || edits.length === 0) return { success: false, error: 'edits array is required' };

    var content = doc.currentContent;
    for (var i = 0; i < edits.length; i++) {
        var edit = edits[i];
        if (!edit.find && edit.find !== '') return { success: false, error: 'Edit ' + i + ': find is required' };
        if (edit.replace === undefined) return { success: false, error: 'Edit ' + i + ': replace is required' };
        var idx = content.indexOf(edit.find);
        if (idx === -1) return { success: false, error: 'Edit ' + i + ': text not found: "' + edit.find.substring(0, 80) + '"' };
        if (content.indexOf(edit.find, idx + 1) !== -1) return { success: false, error: 'Edit ' + i + ': text is not unique (found multiple occurrences)' };
        content = content.substring(0, idx) + edit.replace + content.substring(idx + edit.find.length);
    }

    doc.currentVersion++;
    doc.currentContent = content;
    doc.versions.push({ version: doc.currentVersion, content: content, title: doc.title, author: 'agent', timestamp: Date.now() });
    doc.updatedAt = Date.now();
    sdocCopyDisplays(doc, content, options);
    await saveDocument(doc);
    AgentEvents.emit('documentChanged', { chatId: _sdocChatId(options), docId: docId, kind: 'edited' });

    return {
        success: true, doc_id: docId, version: doc.currentVersion,
        edits_applied: edits.length,
        message: 'Document edited (v' + doc.currentVersion + '). ' + edits.length + ' edit(s) applied.',
        _document_placeholder: '<!--document:' + docId + '-->'
    };
}

async function sdocToolDelete(args, options) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    if (!smartDocuments[docId]) return { success: false, error: 'Document not found: ' + docId };
    await deleteDocumentById(docId);
    AgentEvents.emit('documentChanged', { chatId: _sdocChatId(options), docId: docId, kind: 'deleted' });
    return { success: true, message: 'Document deleted' };
}

// Resolve the chat that owns this smart-document call. SW context has no
// currentChatId fallback, so the agent loop threads chatId via options.
function _sdocChatId(options) {
    return (options && options.chatId)
        || (typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId)
        || (typeof currentChatId !== 'undefined' && currentChatId)
        || null;
}

// ─── Helpers ───

function sdocCopyDisplays(doc, content, options) {
    var re = /<!--display:(dsp_\w+)-->/g;
    var match;
    var chatId = _sdocChatId(options);
    while ((match = re.exec(content)) !== null) {
        var did = match[1];
        if (_displayStore[did]) {
            doc.displays[did] = { template: _displayStore[did].template, args: _displayStore[did].args };
        }
        var chat = chats[chatId];
        if (chat && chat.displays && chat.displays[did]) {
            doc.displays[did] = { template: chat.displays[did].template, args: chat.displays[did].args };
        }
    }
}

function sdocInitPrompts(doc) {
    (doc.prompts || []).forEach(function(p) {
        if (!p.id) p.id = 'dpr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        if (!p.status) p.status = 'pending';
        if (!p.responses) p.responses = {};
    });
}

// ─── Rendering ───

function renderDocumentPlaceholder(docId) {
    var doc = smartDocuments[docId];
    if (!doc) {
        // Doc not in the page's in-memory cache yet. This happens when the
        // worker just created the doc (its smartDocuments map was updated,
        // ours wasn't). Kick off an async IDB load; when it completes,
        // sdocReRenderAll will swap this placeholder for the real render.
        // The data-doc-id attr is required so sdocReRenderAll can find us.
        if (typeof loadDocumentById === 'function' && typeof document !== 'undefined') {
            loadDocumentById(docId).then(function(loaded) {
                if (loaded && typeof sdocReRenderAll === 'function') sdocReRenderAll(docId);
            });
        }
        return '<div class="sdoc-error" data-doc-id="' + escDisplay(docId) + '">Loading document ' + escDisplay(docId) + '\u2026</div>';
    }
    return sdocRender(doc);
}

function sdocRender(doc) {
    var docId = doc.id;
    var cid = 'sdoc_' + docId.replace(/[^a-zA-Z0-9_]/g, '');

    var html = '<div class="sdoc" id="' + cid + '" data-doc-id="' + escDisplay(docId) + '">';

    // Header
    html += '<div class="sdoc-header">';
    html += '<div class="sdoc-header-left">';
    html += '<span class="sdoc-icon">' + UI_ICONS.file + '</span>';
    html += '<span class="sdoc-title">' + escDisplay(doc.title) + '</span>';
    html += '<input type="text" class="sdoc-title-input" value="' + escDisplay(doc.title) + '" placeholder="Document title..." />';
    html += '<span class="sdoc-version-badge">v' + doc.currentVersion + '</span>';
    html += '</div>';
    html += '<div class="sdoc-header-actions">';
    html += '<select class="sdoc-version-select" onchange="sdocCompare(\'' + escDisplay(docId) + '\', this.value)" title="Compare with version">';
    html += '<option value="">v' + doc.currentVersion + '</option>';
    for (var i = doc.versions.length - 1; i >= 0; i--) {
        var v = doc.versions[i];
        if (v.version === doc.currentVersion) continue;
        var icon = v.author === 'user' ? '\u{1F464}' : '\u{1F916}';
        html += '<option value="' + v.version + '">v' + v.version + ' ' + icon + ' ' + sdocTimeAgo(v.timestamp) + '</option>';
    }
    html += '</select>';
    html += '<button class="sdoc-action-btn" onclick="sdocToggleEdit(\'' + escDisplay(docId) + '\')" title="Edit">' + UI_ICONS.edit + '</button>';
    html += '<button class="sdoc-action-btn" onclick="sdocExportMd(\'' + escDisplay(docId) + '\')" title="Copy Markdown">' + UI_ICONS.copy + '</button>';
    html += '<button class="sdoc-action-btn" onclick="sdocOpenNewTab(\'' + escDisplay(docId) + '\')" title="Open in new tab">' + UI_ICONS.expand + '</button>';
    html += '<button class="sdoc-action-btn" onclick="sdocStartChat(\'' + escDisplay(docId) + '\')" title="New chat">' + UI_ICONS.chat + '</button>';
    html += '</div></div>';

    // Diff (hidden)
    html += '<div class="sdoc-diff" id="' + cid + '-diff" style="display:none;"></div>';

    // Body
    html += '<div class="sdoc-body" id="' + cid + '-body">' + sdocRenderContent(doc) + '</div>';

    // Editor (hidden)
    html += '<div class="sdoc-edit" id="' + cid + '-edit" style="display:none;">';
    html += '<textarea class="sdoc-editor" id="' + cid + '-editor">' + escDisplay(doc.currentContent) + '</textarea>';
    html += '<div class="sdoc-edit-actions">';
    html += '<button class="skills-action-btn primary" onclick="sdocSaveEdit(\'' + escDisplay(docId) + '\')">Save</button>';
    html += '<button class="skills-action-btn" onclick="sdocCancelEdit(\'' + escDisplay(docId) + '\')">Cancel</button>';
    html += '</div></div>';

    // Prompts
    if (doc.prompts && doc.prompts.length > 0) {
        html += '<div class="sdoc-prompts">';
        html += '<div class="sdoc-prompts-title">Questions</div>';
        doc.prompts.forEach(function(prompt) { html += sdocRenderPrompt(doc, prompt); });
        html += '</div>';
    }

    html += '</div>';
    return html;
}

function sdocRenderContent(doc) {
    var content = doc.currentContent || '';
    // Copy doc-local displays into _displayStore so formatContent can resolve them
    if (doc.displays) {
        Object.keys(doc.displays).forEach(function(did) {
            if (!_displayStore[did]) {
                var stored = doc.displays[did];
                var gen = DISPLAY_GENERATORS[stored.template];
                var html = gen ? gen(stored.args) : '';
                _displayStore[did] = { template: stored.template, args: stored.args, html: html };
            }
        });
    }
    // Let formatContent handle display placeholders natively (extract before markdown, restore after)
    var rendered = typeof formatContent === 'function' ? formatContent(content) : '<pre>' + escDisplay(content) + '</pre>';
    return '<div class="message-content">' + rendered + '</div>';
}

function sdocRenderPrompt(doc, prompt) {
    var pid = prompt.id;
    var answered = prompt.status === 'answered';
    var fid = 'sdoc-prompt-' + pid;

    var html = '<div class="sdoc-prompt-item ' + (answered ? 'answered' : '') + '">';
    if (prompt.title) html += '<div class="sdoc-prompt-item-title">' + escDisplay(prompt.title) + '</div>';
    if (prompt.description) html += '<div class="sdoc-prompt-item-desc">' + escDisplay(prompt.description) + '</div>';

    html += '<form class="sdoc-prompt-form" id="' + fid + '" onsubmit="event.preventDefault(); sdocSubmitPrompt(\'' + escDisplay(doc.id) + '\', \'' + escDisplay(pid) + '\')">';
    (prompt.fields || []).forEach(function(field) {
        var val = (prompt.responses && prompt.responses[field.name] !== undefined) ? prompt.responses[field.name] : (field.value !== undefined ? field.value : '');
        html += '<div class="sdoc-prompt-field">';
        html += '<label class="sdoc-prompt-label">' + escDisplay(field.label) + '</label>';
        if (field.type === 'textarea') {
            html += '<textarea class="sdoc-prompt-input" data-field-name="' + escDisplay(field.name) + '" data-field-type="textarea">' + escDisplay(val) + '</textarea>';
        } else if (field.type === 'select') {
            html += '<select class="sdoc-prompt-input" data-field-name="' + escDisplay(field.name) + '" data-field-type="select">';
            (field.options || []).forEach(function(opt) {
                var ov = typeof opt === 'object' ? opt.value : opt;
                var ol = typeof opt === 'object' ? opt.label : opt;
                html += '<option value="' + escDisplay(ov) + '"' + (ov === val ? ' selected' : '') + '>' + escDisplay(ol) + '</option>';
            });
            html += '</select>';
        } else if (field.type === 'boolean') {
            html += '<label class="sdoc-prompt-check-label"><input type="checkbox" data-field-name="' + escDisplay(field.name) + '" data-field-type="boolean"' + (val ? ' checked' : '') + '> ' + escDisplay(field.label) + '</label>';
        } else {
            html += '<input type="' + (field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text') + '" class="sdoc-prompt-input" data-field-name="' + escDisplay(field.name) + '" data-field-type="' + escDisplay(field.type || 'text') + '" value="' + escDisplay(val) + '"' + (field.placeholder ? ' placeholder="' + escDisplay(field.placeholder) + '"' : '') + '>';
        }
        html += '</div>';
    });
    var btnLabel = answered ? 'Update' : 'Submit';
    html += '<div class="sdoc-prompt-submit-row">';
    html += '<button type="submit" class="skills-action-btn primary" style="align-self:flex-start">' + btnLabel + '</button>';
    if (answered) html += '<span class="sdoc-prompt-answered">✓ Saved</span>';
    html += '</div>';
    html += '</form></div>';
    return html;
}

// ─── User Actions ───

function sdocGetCid(docId) {
    return 'sdoc_' + docId.replace(/[^a-zA-Z0-9_]/g, '');
}

// Find the right sdoc container — prefer modal instance over inline
function sdocGetContainer(docId) {
    var modal = document.getElementById('sdoc-preview-modal');
    if (modal) {
        var el = modal.querySelector('[data-doc-id="' + docId + '"]');
        if (el) return el;
    }
    return document.getElementById(sdocGetCid(docId));
}

function sdocToggleEdit(docId) {
    var c = sdocGetContainer(docId);
    if (!c) return;
    var body = c.querySelector('.sdoc-body');
    var edit = c.querySelector('.sdoc-edit');
    var diff = c.querySelector('.sdoc-diff');
    if (!body || !edit) return;

    if (edit.style.display !== 'none') {
        edit.style.display = 'none';
        body.style.display = '';
        c.classList.remove('sdoc-editing');
    } else {
        if (diff) diff.style.display = 'none';
        body.style.display = 'none';
        edit.style.display = '';
        c.classList.add('sdoc-editing');
        c.classList.remove('sdoc-diffing');
        var doc = smartDocuments[docId];
        var titleInput = c.querySelector('.sdoc-title-input');
        if (titleInput && doc) titleInput.value = doc.title;
        var editor = c.querySelector('.sdoc-editor');
        if (editor) {
            if (doc) editor.value = doc.currentContent;
            editor.focus();
        }
    }
}

async function sdocSaveEdit(docId) {
    var c = sdocGetContainer(docId);
    if (!c) return;
    var editor = c.querySelector('.sdoc-editor');
    if (!editor) return;
    var doc = smartDocuments[docId];
    if (!doc) return;

    var titleInput = c.querySelector('.sdoc-title-input');
    var newTitle = titleInput ? titleInput.value.trim() : '';
    var newContent = editor.value;
    var titleChanged = newTitle && newTitle !== doc.title;
    if (newContent === doc.currentContent && !titleChanged) { sdocCancelEdit(docId); return; }
    c.classList.remove('sdoc-editing');

    doc.currentVersion++;
    doc.currentContent = newContent;
    if (titleChanged) doc.title = newTitle;
    doc.versions.push({ version: doc.currentVersion, content: newContent, title: doc.title, author: 'user', timestamp: Date.now() });
    doc.updatedAt = Date.now();
    sdocCopyDisplays(doc, newContent);
    await saveDocument(doc);
    sdocReRenderAll(docId);
    renderVersionSidebar();
    renderDocumentsPage();
}

function sdocCancelEdit(docId) {
    var c = sdocGetContainer(docId);
    if (!c) return;
    var body = c.querySelector('.sdoc-body');
    var edit = c.querySelector('.sdoc-edit');
    if (body) body.style.display = '';
    if (edit) edit.style.display = 'none';
    if (c) c.classList.remove('sdoc-editing');
}

function sdocCompare(docId, versionStr) {
    var c = sdocGetContainer(docId);
    if (!c) return;
    var diff = c.querySelector('.sdoc-diff');
    var body = c.querySelector('.sdoc-body');
    var edit = c.querySelector('.sdoc-edit');
    var doc = smartDocuments[docId];
    if (!diff || !body || !doc) return;

    if (!versionStr) { diff.style.display = 'none'; body.style.display = ''; c.classList.remove('sdoc-diffing'); return; }

    var version = parseInt(versionStr);
    var oldVer = doc.versions.find(function(v) { return v.version === version; });
    if (!oldVer) return;

    if (edit) edit.style.display = 'none';
    body.style.display = 'none';
    diff.style.display = '';
    c.classList.add('sdoc-diffing');
    c.classList.remove('sdoc-editing');
    diff.innerHTML = sdocRenderDiff(oldVer.content.split('\n'), doc.currentContent.split('\n'),
        'v' + oldVer.version + ' (' + oldVer.author + ')', 'v' + doc.currentVersion + ' (current)');
}

function sdocRenderDiff(oldLines, newLines, oldLabel, newLabel) {
    var html = '<div class="sdoc-diff-header">';
    html += '<span class="sdoc-diff-label sdoc-diff-old">' + escDisplay(oldLabel) + '</span>';
    html += '<span class="sdoc-diff-arrow">\u2192</span>';
    html += '<span class="sdoc-diff-label sdoc-diff-new">' + escDisplay(newLabel) + '</span>';
    html += '</div><div class="sdoc-diff-body">';

    var changes = sdocComputeDiff(oldLines, newLines);
    changes.forEach(function(ch) {
        var cls = ch.type === 'add' ? 'sdoc-line-add' : ch.type === 'del' ? 'sdoc-line-del' : 'sdoc-line-ctx';
        var prefix = ch.type === 'add' ? '+' : ch.type === 'del' ? '-' : ' ';
        html += '<div class="sdoc-diff-line ' + cls + '"><span class="sdoc-diff-prefix">' + prefix + '</span><span class="sdoc-diff-text">' + escDisplay(ch.text) + '</span></div>';
    });
    html += '</div>';
    return html;
}

function sdocComputeDiff(oldLines, newLines) {
    var m = oldLines.length, n = newLines.length;
    if (m + n > 2000) return sdocSimpleDiff(oldLines, newLines);
    var dp = [];
    for (var i = 0; i <= m; i++) { dp[i] = []; for (var j = 0; j <= n; j++) { if (i === 0 || j === 0) dp[i][j] = 0; else if (oldLines[i-1] === newLines[j-1]) dp[i][j] = dp[i-1][j-1] + 1; else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]); } }
    var changes = []; var i = m, j = n;
    while (i > 0 || j > 0) { if (i > 0 && j > 0 && oldLines[i-1] === newLines[j-1]) { changes.unshift({ type: 'ctx', text: oldLines[i-1] }); i--; j--; } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { changes.unshift({ type: 'add', text: newLines[j-1] }); j--; } else { changes.unshift({ type: 'del', text: oldLines[i-1] }); i--; } }
    return changes;
}

function sdocSimpleDiff(oldLines, newLines) {
    var changes = []; var max = Math.max(oldLines.length, newLines.length);
    for (var i = 0; i < max; i++) {
        if (i < oldLines.length && i < newLines.length) { if (oldLines[i] === newLines[i]) changes.push({ type: 'ctx', text: oldLines[i] }); else { changes.push({ type: 'del', text: oldLines[i] }); changes.push({ type: 'add', text: newLines[i] }); } }
        else if (i < oldLines.length) changes.push({ type: 'del', text: oldLines[i] });
        else changes.push({ type: 'add', text: newLines[i] });
    }
    return changes;
}

function sdocExportMd(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;
    var md = doc.currentContent.replace(/<!--display:dsp_\w+-->/g, '[embedded display]');
    navigator.clipboard.writeText(md).then(function() { showNotification('Markdown copied to clipboard'); }).catch(function() { sdocDownloadMd(docId); });
}

function sdocDownloadMd(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;
    var md = doc.currentContent.replace(/<!--display:dsp_\w+-->/g, '[embedded display]');
    var blob = new Blob([md], { type: 'text/markdown' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (doc.title || 'document').replace(/[^a-zA-Z0-9_-]/g, '_') + '.md';
    a.click();
}

function sdocOpenNewTab(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;
    var rendered = sdocRenderContent(doc);
    // Collect all CSS from current page for proper template rendering
    var allCss = '';
    try {
        var sheets = document.styleSheets;
        for (var si = 0; si < sheets.length; si++) {
            try {
                var rules = sheets[si].cssRules || sheets[si].rules;
                for (var ri = 0; ri < rules.length; ri++) allCss += rules[ri].cssText + '\n';
            } catch(e) {}
        }
    } catch(e) {}
    var page = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escDisplay(doc.title) + '</title>' +
        '<style>' + allCss + 'body{max-width:900px;margin:40px auto;padding:20px;line-height:1.6;}@media print{body{margin:0;padding:20px;}}</style></head><body class="message-content">' +
        '<h1>' + escDisplay(doc.title) + '</h1>' + rendered + '</body></html>';
    var blob = new Blob([page], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank');
}

function sdocStartChat(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;

    // Close preview modal if open
    var modal = document.getElementById('sdoc-preview-modal');
    if (modal) modal.remove();

    // Switch to chat view if needed
    if (currentView !== 'chat') {
        currentView = 'chat';
        appStorage.setItem('currentView', 'chat');
        hideAllPanels();
        showChatView();
    }
    newChat();
    var chat = chats[currentChatId];
    if (chat) {
        chat.title = 'Re: ' + doc.title;
        saveChatsToStorage();
        renderChatList();
        updateChatTitleHeader();
    }
    // Attach document as a pending attachment (like images)
    sdocAttachToInput(docId);
    var inputEl = document.getElementById('message-input');
    if (inputEl) {
        inputEl.focus();
    }
}

// Attach a document reference to the input area as a pending attachment
function sdocAttachToInput(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;
    // Don't add duplicate
    if (pendingImageAttachments.some(function(a) { return a.sdocId === docId; })) return;
    pendingImageAttachments.push({
        fileType: 'document',
        name: doc.title,
        sdocId: docId
    });
    if (typeof renderPendingImages === 'function') renderPendingImages();
}

function sdocSubmitPrompt(docId, promptId) {
    var doc = smartDocuments[docId];
    if (!doc) return;
    var prompt = doc.prompts.find(function(p) { return p.id === promptId; });
    if (!prompt) return;
    // Scope form search to the correct container (modal or inline) to avoid duplicate ID issues
    var container = sdocGetContainer(docId);
    var formEl = container ? container.querySelector('#sdoc-prompt-' + promptId) : document.getElementById('sdoc-prompt-' + promptId);
    if (!formEl) return;

    var responses = {};
    formEl.querySelectorAll('[data-field-name]').forEach(function(el) {
        var name = el.getAttribute('data-field-name');
        var type = el.getAttribute('data-field-type');
        responses[name] = type === 'boolean' ? el.checked : el.value;
    });

    prompt.responses = responses;
    prompt.status = 'answered';
    doc.updatedAt = Date.now();
    saveDocument(doc);
    sdocReRenderAll(docId);
    showNotification('Response saved');
}

// ─── Document Preview Modal ───

function sdocOpenPreview(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;

    var existing = document.getElementById('sdoc-preview-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'sdoc-preview-modal';
    modal.className = 'sdoc-preview-overlay';
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };

    // Reuse full sdocRender for all features (edit, versions, diff, prompts)
    var html = '<div class="sdoc-preview-container">' + sdocRender(doc) + '</div>';
    modal.innerHTML = html;

    // Add close button to header actions
    var headerActions = modal.querySelector('.sdoc-header-actions');
    if (headerActions) {
        var closeBtn = document.createElement('button');
        closeBtn.className = 'sdoc-action-btn';
        closeBtn.title = 'Close';
        closeBtn.innerHTML = UI_ICONS.close;
        closeBtn.onclick = function(e) { e.stopPropagation(); modal.remove(); };
        headerActions.appendChild(closeBtn);
    }

    document.body.appendChild(modal);

    // Escape key to close
    modal.tabIndex = -1;
    modal.addEventListener('keydown', function(e) { if (e.key === 'Escape') modal.remove(); });
    modal.focus();
}

// ─── Re-render all instances of a document ───

function sdocReRenderAll(docId) {
    // No-op in the SW (headless tool dispatch). The function IS defined in
    // this file, so the typeof guard at the call sites in sdocToolUpdate /
    // sdocToolEdit passes — but the body below touches `document`, which
    // is undefined here. The panel re-renders documents from the next
    // chat snapshot, so skipping the DOM update is safe.
    if (typeof document === 'undefined') return;
    var doc = smartDocuments[docId];
    if (!doc) return;
    document.querySelectorAll('[data-doc-id="' + docId + '"]').forEach(function(el) {
        var tmp = document.createElement('div');
        tmp.innerHTML = sdocRender(doc);
        if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild);
    });
}

// ─── Time formatting ───

function sdocTimeAgo(ts) {
    var d = Date.now() - ts;
    var m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var days = Math.floor(h / 24);
    if (days < 30) return days + 'd ago';
    return new Date(ts).toLocaleDateString();
}

// ─── Documents Page ───

function toggleDocumentsView() {
    if (currentView === 'documents') return;
    openDocumentsView();
}

function openDocumentsView() {
    currentView = 'documents';
    appStorage.setItem('currentView', 'documents');
    // SWM2-T1: left the chat view — clear this panel's focus entry so the SW
    // sub-agent GC doesn't keep the previously-viewed chat pinned (port-keyed).
    // Mirrors openDashboardView (ui/060-docs-view.js:113); openDocumentsView was
    // the lone non-chat view-open missing this clear, so opening Documents left a
    // stale focus pin protecting the last chat from GC.
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(null);
    hideAllPanels();
    var panel = document.getElementById('documents-panel');
    if (panel) { panel.style.display = 'flex'; renderDocumentsPage(); }
    updateAllButtonStates();
    renderChatList();
    pushHistoryState('documents', null);
}

function renderDocumentsPage() {
    var list = document.getElementById('documents-list');
    if (!list) return;

    // Init sidebar toggle icon
    var toggleBtn = document.getElementById('documents-toggle-sidebar-btn');
    if (toggleBtn) toggleBtn.innerHTML = UI_ICONS.panelLeftClose;

    var docs = Object.values(smartDocuments);
    docs.sort(function(a, b) { return b.updatedAt - a.updatedAt; });

    if (docs.length === 0) {
        list.innerHTML = '<div class="history-empty">' +
            '<div class="history-empty-icon">' + UI_ICONS.file + '</div>' +
            '<div class="history-empty-title">No documents yet</div>' +
            '<div class="history-empty-text">Create a document or ask the agent to create one for you.</div>' +
            '<button class="skills-action-btn primary" onclick="sdocCreateFromPage()" style="margin-top:12px">' + UI_ICONS.plus + ' New Document</button>' +
            '</div>';
        return;
    }

    var html = '';
    docs.forEach(function(doc) {
        var lastVer = doc.versions[doc.versions.length - 1];
        var authorIcon = lastVer ? (lastVer.author === 'user' ? '\u{1F464}' : '\u{1F916}') : '';
        var preview = (doc.currentContent || '').substring(0, 200).replace(/[#*_`\n]/g, ' ').trim();
        var versionCount = doc.versions.length;

        // Action buttons (appear on hover, like history cards)
        var actionsHtml = '<div class="history-chat-actions">';
        actionsHtml += '<button class="history-chat-action-btn" onclick="event.stopPropagation(); sdocStartChat(\'' + escDisplay(doc.id) + '\')" title="New chat">' + UI_ICONS.chat + '</button>';
        actionsHtml += '<button class="history-chat-action-btn" onclick="event.stopPropagation(); sdocDownloadMd(\'' + escDisplay(doc.id) + '\')" title="Export">' + UI_ICONS.download + '</button>';
        actionsHtml += '<button class="history-chat-action-btn danger" onclick="event.stopPropagation(); sdocDeleteFromPage(\'' + escDisplay(doc.id) + '\')" title="Delete">' + UI_ICONS.trash + '</button>';
        actionsHtml += '</div>';

        // Preview
        var previewHtml = '<div class="history-chat-preview-area">';
        previewHtml += '<div class="history-preview-msg"><span class="history-preview-text">' + escDisplay(preview) + (preview.length >= 200 ? '...' : '') + '</span></div>';
        previewHtml += '</div>';

        // Stats
        var statsHtml = '<div class="history-chat-stats">';
        statsHtml += '<span class="history-chat-stat">' + UI_ICONS.file + versionCount + ' version' + (versionCount > 1 ? 's' : '') + '</span>';
        if (lastVer) statsHtml += '<span class="history-chat-stat">' + authorIcon + ' ' + lastVer.author + '</span>';
        statsHtml += '</div>';

        // Meta row
        var metaHtml = '<div class="history-chat-meta">';
        metaHtml += '<span>' + UI_ICONS.clock + sdocTimeAgo(doc.updatedAt) + '</span>';
        metaHtml += '</div>';

        html += '<div class="history-chat-card" onclick="sdocOpenPreview(\'' + escDisplay(doc.id) + '\')" style="cursor:pointer;">';
        html += '<div class="history-chat-header">';
        html += '<div class="history-chat-title-row">';
        html += '<span class="history-chat-title">' + escDisplay(doc.title) + '</span>';
        html += '<div class="history-chat-badges"><span class="sdoc-version-badge">v' + doc.currentVersion + '</span></div>';
        html += '</div>';
        html += actionsHtml;
        html += '</div>';
        html += previewHtml;
        html += statsHtml;
        html += metaHtml;
        html += '</div>';
    });
    list.innerHTML = html;
}

async function sdocDeleteFromPage(docId) {
    var doc = smartDocuments[docId];
    var title = doc ? doc.title : 'this document';
    if (!await showConfirmModal('Delete Document', 'Delete "' + title + '" and all its versions? This cannot be undone.')) return;
    await deleteDocumentById(docId);
    renderDocumentsPage();
    renderVersionSidebar();
    showNotification('Document deleted');
}

// ─── Create from Page ───

async function sdocCreateFromPage() {
    // Create a blank document
    var docId = 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 7);
    var now = Date.now();
    var fileId = newFileId();
    var doc = {
        id: docId, title: 'Untitled Document', currentContent: '', currentVersion: 1,
        versions: [{ version: 1, content: '', title: 'Untitled Document', author: 'user', timestamp: now }],
        displays: {}, prompts: [], createdAt: now, updatedAt: now,
        file_id: fileId
    };
    await saveDocument(doc);
    registerFile(fileId, { type: 'document', docId: docId });
    renderDocumentsPage();
    renderVersionSidebar();

    // Open in preview modal and immediately enter edit mode
    sdocOpenPreview(docId);
    sdocToggleEdit(docId);
    // Focus the title input
    setTimeout(function() {
        var c = sdocGetContainer(docId);
        if (c) {
            var titleInput = c.querySelector('.sdoc-title-input');
            if (titleInput) { titleInput.focus(); titleInput.select(); }
        }
    }, 50);
}

// ─── Import / Export ───

function exportAllDocuments() {
    var docs = Object.values(smartDocuments);
    if (docs.length === 0) { showSnackbar('No documents to export', 'error'); return; }

    var exportData = docs.map(function(doc) {
        return {
            id: doc.id, title: doc.title, currentContent: doc.currentContent,
            currentVersion: doc.currentVersion, versions: doc.versions,
            displays: doc.displays, prompts: doc.prompts,
            createdAt: doc.createdAt, updatedAt: doc.updatedAt
        };
    });

    var json = JSON.stringify({ type: 'appagent-documents', version: 1, documents: exportData }, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'appagent-documents-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    showSnackbar('Exported ' + docs.length + ' document(s)', 'success');
}

function importDocuments() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async function(e) {
        var file = e.target.files[0];
        if (!file) return;
        try {
            var text = await file.text();
            var data = JSON.parse(text);
            if (!data.documents || !Array.isArray(data.documents)) {
                showSnackbar('Invalid document export file', 'error');
                return;
            }
            var imported = 0;
            var updated = 0;
            for (var i = 0; i < data.documents.length; i++) {
                var doc = data.documents[i];
                if (!doc.id || !doc.title) continue;
                if (smartDocuments[doc.id]) updated++;
                // Ensure required fields
                doc.versions = doc.versions || [];
                doc.displays = doc.displays || {};
                doc.prompts = doc.prompts || [];
                doc.createdAt = doc.createdAt || Date.now();
                doc.updatedAt = doc.updatedAt || Date.now();
                doc.currentVersion = doc.currentVersion || 1;
                doc.currentContent = doc.currentContent || '';
                await saveDocument(doc);
                imported++;
            }
            renderDocumentsPage();
            renderVersionSidebar();
            var msg = 'Imported ' + imported + ' document(s)';
            if (updated > 0) msg += ' (' + updated + ' updated)';
            showSnackbar(msg, 'success');
        } catch (err) {
            showSnackbar('Import failed: ' + err.message, 'error');
        }
    };
    input.click();
}

// renderDocumentsSidebar removed — documents now render in the right sidebar (version-sidebar) via renderVersionSidebar()
