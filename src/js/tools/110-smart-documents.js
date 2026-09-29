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

    // Re-hydrate from IndexedDB before acting. The page mutates documents too
    // (inline edits via sdocSaveEdit, prompt answers, manual create/delete) and
    // those writes never reach this context's in-memory cache: documentChanged
    // only flows worker -> page (app/036-agent-event-handlers-page.js:864), so
    // the SW-side smartDocuments entry stays stale — reads served an old
    // version and update/edit would build on (and clobber) the stale base.
    if (args.doc_id) {
        var fresh = await loadDocumentById(args.doc_id);
        if (!fresh) delete smartDocuments[args.doc_id]; // deleted page-side
    }

    if (action === 'create') return await sdocToolCreate(args, options);
    if (action === 'update') return await sdocToolUpdate(args, options);
    if (action === 'edit') return await sdocToolEdit(args, options);
    if (action === 'read') return sdocToolRead(args, options);
    if (action === 'list') return await sdocToolList(options);
    if (action === 'list_versions') return sdocToolListVersions(args, options);
    if (action === 'read_version') return sdocToolReadVersion(args, options);
    if (action === 'delete') return await sdocToolDelete(args, options);
    return { success: false, error: 'Unknown action: ' + action };
}

// Human-readable doc id: slug of the title (fallback 'document'), unique
// against the in-memory cache AND IndexedDB — the cache can be stale across
// contexts (page vs SW mutate independently; documentChanged only flows
// worker→page), so every candidate is probed in IDB too. loadDocumentById
// doubles as a cache hydrator when the probe finds an existing doc.
// Collisions get _2, _3, … appended. Legacy ids ('doc_<epoch>_<rand>')
// persist in IDB / old transcripts; all lookups are exact-key based, so old
// and new formats coexist with no migration.
async function _sdocNewId(title) {
    var base = typeof slugifyIdBase === 'function' ? slugifyIdBase(title, 'document') : ('doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 7));
    var id = base;
    var n = 2;
    while (smartDocuments[id] || await loadDocumentById(id)) { id = base + '_' + n; n++; }
    return id;
}

async function sdocToolCreate(args, options) {
    var title = args.title || 'Untitled Document';
    var content = args.content || '';
    var docId = await _sdocNewId(title);
    var now = Date.now();

    var scope = (args.scope === 'chat') ? 'chat' : 'shared';
    var ownerChatId = _sdocChatId(options);
    // A 'chat'-scoped doc with no resolvable owner would be orphaned — invisible
    // to everyone (list/read/edit/delete all gate on accessibility), so it could
    // never even be deleted. Fall back to 'shared' in that impossible-owner case.
    if (scope === 'chat' && !ownerChatId) scope = 'shared';
    var fileId = newFileId();
    var doc = {
        id: docId, title: title, currentContent: content, currentVersion: 1,
        versions: [{ version: 1, content: content, title: title, author: 'agent', timestamp: now }],
        displays: {}, prompts: args.prompts || [], createdAt: now, updatedAt: now,
        file_id: fileId,
        scope: scope, ownerChatId: ownerChatId
    };

    sdocCopyDisplays(doc, content, options);
    sdocInitPrompts(doc);
    await saveDocument(doc);
    registerFile(fileId, { type: 'document', docId: docId });
    AgentEvents.emit('documentChanged', { chatId: _sdocChatId(options), docId: docId, kind: 'created' });

    return {
        success: true, doc_id: docId, version: 1, file_id: doc.file_id, scope: scope,
        message: 'Document created (scope: ' + scope + '). Include <!--document:' + docId + '--> in your response to render it inline.',
        _document_placeholder: '<!--document:' + docId + '-->'
    };
}

async function sdocToolUpdate(args, options) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    var doc = smartDocuments[docId];
    if (!doc || !_sdocAccessible(doc, options)) return { success: false, error: 'Document not found: ' + docId };

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

function sdocToolRead(args, options) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    var doc = smartDocuments[docId];
    if (!doc || !_sdocAccessible(doc, options)) return { success: false, error: 'Document not found: ' + docId };

    var promptResponses = {};
    (doc.prompts || []).forEach(function(p) {
        if (p.status === 'answered' && p.responses) promptResponses[p.id] = p.responses;
    });

    return {
        success: true, doc_id: doc.id, title: doc.title, content: doc.currentContent,
        version: doc.currentVersion, versions_count: doc.versions.length,
        file_id: doc.file_id || null, scope: doc.scope || 'shared',
        prompt_responses: promptResponses, updated_at: doc.updatedAt
    };
}

async function sdocToolList(options) {
    // Fresh IDB read: page-side creates/deletes never reach this context's
    // cache (see the re-hydrate note in executeSmartDocument).
    var docs = await loadAllDocuments();
    var list = docs.filter(function(doc) {
        return _sdocAccessible(doc, options);
    }).map(function(doc) {
        return { doc_id: doc.id, title: doc.title, scope: doc.scope || 'shared', current_version: doc.currentVersion, updated_at: doc.updatedAt, created_at: doc.createdAt };
    });
    list.sort(function(a, b) { return b.updated_at - a.updated_at; });
    return { success: true, documents: list };
}

function sdocToolListVersions(args, options) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    var doc = smartDocuments[docId];
    if (!doc || !_sdocAccessible(doc, options)) return { success: false, error: 'Document not found: ' + docId };
    return {
        success: true, doc_id: docId,
        versions: doc.versions.map(function(v) {
            return { version: v.version, author: v.author, timestamp: v.timestamp, title: v.title };
        })
    };
}

function sdocToolReadVersion(args, options) {
    var docId = args.doc_id;
    var version = args.version;
    if (!docId) return { success: false, error: 'doc_id is required' };
    if (!version) return { success: false, error: 'version is required' };
    var doc = smartDocuments[docId];
    if (!doc || !_sdocAccessible(doc, options)) return { success: false, error: 'Document not found: ' + docId };
    var v = doc.versions.find(function(ver) { return ver.version === version; });
    if (!v) return { success: false, error: 'Version ' + version + ' not found' };
    return { success: true, doc_id: docId, version: v.version, content: v.content, title: v.title, author: v.author, timestamp: v.timestamp };
}

async function sdocToolEdit(args, options) {
    var docId = args.doc_id;
    if (!docId) return { success: false, error: 'doc_id is required' };
    var doc = smartDocuments[docId];
    if (!doc || !_sdocAccessible(doc, options)) return { success: false, error: 'Document not found: ' + docId };
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
    var doc = smartDocuments[docId];
    if (!doc || !_sdocAccessible(doc, options)) return { success: false, error: 'Document not found: ' + docId };
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

// Visibility gate. A 'shared' (or legacy/undefined-scope) doc is global and
// readable from any chat. A 'chat'-scoped doc is private to the chat that
// created it (its ownerChatId) AND to that chat's sub-agent lineage — a chat
// and its sub-agents (any depth, up or down the parent_chat_id chain) can all
// list/read it, so a parent and the sub-agent it spawns can share a scratchpad.
// Sibling sub-agents and unrelated chats still cannot see each other's docs.
function _sdocAccessible(doc, options) {
    if (!doc) return false;
    if (doc.scope !== 'chat') return true;
    var here = _sdocChatId(options);
    if (!here || !doc.ownerChatId) return false;
    if (here === doc.ownerChatId) return true;
    // Also visible across the parent↔sub-agent boundary: accessible when `here`
    // and the doc's ownerChatId sit on the same sub-agent lineage (one is an
    // ancestor/descendant of the other).
    return _sdocSameLineage(here, doc.ownerChatId);
}

// Walk the sub-agent chat lineage upward from `chatId`, returning the chain
// [chatId, parent_chat_id, ...] up to the root human chat. Bounded to 10 hops
// (cycle/runaway guard). Uses the SW-global SubAgents registry (core/097); a
// top-level human chat has no registry record so the walk stops there.
function _sdocChatChain(chatId) {
    var chain = [];
    var cur = chatId;
    for (var i = 0; i < 10 && cur; i++) {
        chain.push(cur);
        if (typeof SubAgents === 'undefined' || !SubAgents || !SubAgents.getByChatId) break;
        var rec = SubAgents.getByChatId(cur);
        if (!rec || !rec.parent_chat_id || rec.parent_chat_id === cur) break;
        cur = rec.parent_chat_id;
    }
    return chain;
}

// True when chats `a` and `b` lie on the same sub-agent lineage — i.e. one is
// an ancestor (or descendant) of the other via parent_chat_id links. Siblings
// (sharing only a common ancestor) return false.
function _sdocSameLineage(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (_sdocChatChain(a).indexOf(b) !== -1) return true;
    return _sdocChatChain(b).indexOf(a) !== -1;
}

// ─── Helpers ───

function sdocCopyDisplays(doc, content, options) {
    var re = /<!--display:(dsp_\w+)-->/g;
    var match;
    var chatId = _sdocChatId(options);
    while ((match = re.exec(content)) !== null) {
        var did = match[1];
        var chat = chats[chatId];
        if (chat && chat.displays && chat.displays[did]) {
            doc.displays[did] = { template: chat.displays[did].template, args: chat.displays[did].args };
        }
    }
}

// C1: prompt ids are AGENT-controlled (args.prompts) and are interpolated
// into an element id AND an inline onsubmit JS string (sdocRenderPrompt).
// Only a strict [A-Za-z0-9_-]{1,64} charset is accepted; anything else is
// replaced by a fresh safe id (in place, so sdocSubmitPrompt finds it).
var SDOC_PROMPT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function _sdocSafePromptId(p) {
    if (!p || typeof p !== 'object') return '';
    if (typeof p.id !== 'string' || !SDOC_PROMPT_ID_RE.test(p.id)) {
        p.id = 'dpr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    }
    return p.id;
}

function sdocInitPrompts(doc) {
    (doc.prompts || []).forEach(function(p) {
        _sdocSafePromptId(p);
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
        return '<div class="sdoc-error" data-doc-id="' + escDisplay(docId) + '">' + escDisplay(t('Loading document {id}\u2026', { id: docId })) + '</div>';
    }
    return sdocRender(doc);
}

// Doc id embedded in a '...' JS string inside an inline on* attribute: JS-escape
// first (the HTML parser decodes entities before the handler runs), then HTML-escape.
function sdocJsArg(s) { return escDisplay(String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')); }

function sdocRender(doc) {
    var docId = doc.id;
    var cid = 'sdoc_' + docId.replace(/[^a-zA-Z0-9_]/g, '');

    var html = '<div class="sdoc" id="' + cid + '" data-doc-id="' + escDisplay(docId) + '">';

    // Header
    html += '<div class="sdoc-header">';
    html += '<div class="sdoc-header-left">';
    html += '<span class="sdoc-icon">' + UI_ICONS.file + '</span>';
    html += '<span class="sdoc-title">' + escDisplay(doc.title) + '</span>';
    html += '<input type="text" class="sdoc-title-input" value="' + escDisplay(doc.title) + '" placeholder="' + escDisplay(t('Document title...')) + '" />';
    html += '<span class="sdoc-version-badge">v' + escDisplay(doc.currentVersion) + '</span>';
    html += '</div>';
    html += '<div class="sdoc-header-actions">';
    html += '<select class="sdoc-version-select" onchange="sdocCompare(\'' + sdocJsArg(docId) + '\', this.value, this)" title="' + escDisplay(t('Compare with version')) + '">';
    html += '<option value="">v' + escDisplay(doc.currentVersion) + '</option>';
    for (var i = doc.versions.length - 1; i >= 0; i--) {
        var v = doc.versions[i];
        if (v.version === doc.currentVersion) continue;
        var icon = v.author === 'user' ? '\u{1F464}' : '\u{1F916}';
        html += '<option value="' + escDisplay(v.version) + '">v' + escDisplay(v.version) + ' ' + icon + ' ' + sdocTimeAgo(v.timestamp) + '</option>';
    }
    html += '</select>';
    html += '<button class="sdoc-action-btn" onclick="sdocToggleEdit(\'' + sdocJsArg(docId) + '\', this)" title="' + escDisplay(t('Edit')) + '">' + UI_ICONS.edit + '</button>';
    html += '<button class="sdoc-action-btn" onclick="editDocumentWithAgent(\'' + sdocJsArg(docId) + '\', event)" title="' + escDisplay(t('Edit with agent')) + '">' + UI_ICONS.agentEdit + '</button>';
    html += '<button class="sdoc-action-btn" onclick="sdocExportMd(\'' + sdocJsArg(docId) + '\')" title="' + escDisplay(t('Copy Markdown')) + '">' + UI_ICONS.copy + '</button>';
    html += '<button class="sdoc-action-btn" onclick="sdocOpenNewTab(\'' + sdocJsArg(docId) + '\')" title="' + escDisplay(t('Open in new tab')) + '">' + UI_ICONS.expand + '</button>';
    html += '<button class="sdoc-action-btn" onclick="sdocStartChat(\'' + sdocJsArg(docId) + '\')" title="' + escDisplay(t('New chat')) + '">' + UI_ICONS.chat + '</button>';
    html += '</div></div>';

    // Diff (hidden)
    html += '<div class="sdoc-diff" id="' + cid + '-diff" style="display:none;"></div>';

    // Body
    html += '<div class="sdoc-body" id="' + cid + '-body">' + sdocRenderContent(doc) + '</div>';

    // Editor (hidden)
    html += '<div class="sdoc-edit" id="' + cid + '-edit" style="display:none;">';
    html += '<textarea class="sdoc-editor" id="' + cid + '-editor">' + escDisplay(doc.currentContent) + '</textarea>';
    html += '<div class="sdoc-edit-actions">';
    html += '<button class="skills-action-btn primary" onclick="sdocSaveEdit(\'' + sdocJsArg(docId) + '\', this)">' + escDisplay(t('Save')) + '</button>';
    html += '<button class="skills-action-btn" onclick="sdocCancelEdit(\'' + sdocJsArg(docId) + '\', this)">' + escDisplay(t('Cancel')) + '</button>';
    html += '</div></div>';

    // Prompts
    if (doc.prompts && doc.prompts.length > 0) {
        html += '<div class="sdoc-prompts">';
        html += '<div class="sdoc-prompts-title">' + escDisplay(t('Questions')) + '</div>';
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
    // C1: sanitize on READ too — docs stored before this fix may carry a
    // hostile id; _sdocSafePromptId rewrites it to a safe one in place.
    var pid = _sdocSafePromptId(prompt);
    var answered = prompt.status === 'answered';
    var fid = 'sdoc-prompt-' + pid;

    var html = '<div class="sdoc-prompt-item ' + (answered ? 'answered' : '') + '">';
    if (prompt.title) html += '<div class="sdoc-prompt-item-title">' + escDisplay(prompt.title) + '</div>';
    // Description is markdown — same pipeline as chat messages and the prompt_user
    // panel (formatContent in ui/250-message-render.js escapes HTML internally);
    // .markdown-body scopes the 07-markdown.css block rules (lists, code, links).
    if (prompt.description) {
        var descInner = (typeof formatContent === 'function')
            ? formatContent(String(prompt.description))
            : escDisplay(prompt.description);
        html += '<div class="sdoc-prompt-item-desc markdown-body">' + descInner + '</div>';
    }

    // input/change bubble from every field to the form: one delegated marker
    // records which fields the USER touched (see _sdocCarryPromptDrafts).
    html += '<form class="sdoc-prompt-form" id="' + escDisplay(fid) + '" oninput="sdocMarkPromptDirty(event.target)" onchange="sdocMarkPromptDirty(event.target)" onsubmit="event.preventDefault(); sdocSubmitPrompt(\'' + sdocJsArg(doc.id) + '\', \'' + sdocJsArg(pid) + '\')">';
    // Iterate the CLEANED field list: a null / non-object entry (legacy or
    // hand-edited doc) would otherwise throw on field.name below and break the
    // whole document render.
    var _sdocFields = (typeof sanitizePromptFields === 'function')
        ? sanitizePromptFields(prompt.fields)
        : (prompt.fields || []).filter(function(f) { return f && typeof f === 'object'; });
    _sdocFields.forEach(function(field) {
        var val = (prompt.responses && prompt.responses[field.name] !== undefined) ? prompt.responses[field.name] : (field.value !== undefined ? field.value : '');
        html += '<div class="sdoc-prompt-field">';
        html += '<label class="sdoc-prompt-label">' + escDisplay(field.label) + '</label>';
        if (field.type === 'textarea') {
            html += '<textarea class="sdoc-prompt-input" data-field-name="' + escDisplay(field.name) + '" data-prompt-field="' + escDisplay(field.name) + '" data-field-type="textarea">' + escDisplay(val) + '</textarea>';
        } else if (field.type === 'select') {
            html += '<select class="sdoc-prompt-input" data-field-name="' + escDisplay(field.name) + '" data-prompt-field="' + escDisplay(field.name) + '" data-field-type="select">';
            (field.options || []).forEach(function(opt) {
                var ov = typeof opt === 'object' ? opt.value : opt;
                var ol = typeof opt === 'object' ? opt.label : opt;
                html += '<option value="' + escDisplay(ov) + '"' + (ov === val ? ' selected' : '') + '>' + escDisplay(ol) + '</option>';
            });
            html += '</select>';
        } else if (field.type === 'boolean') {
            html += '<label class="sdoc-prompt-check-label"><input type="checkbox" data-field-name="' + escDisplay(field.name) + '" data-prompt-field="' + escDisplay(field.name) + '" data-field-type="boolean"' + (val ? ' checked' : '') + '> ' + escDisplay(field.label) + '</label>';
        } else {
            html += '<input type="' + (field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text') + '" class="sdoc-prompt-input" data-field-name="' + escDisplay(field.name) + '" data-prompt-field="' + escDisplay(field.name) + '" data-field-type="' + escDisplay(field.type || 'text') + '" value="' + escDisplay(val) + '"' + (field.placeholder ? ' placeholder="' + escDisplay(field.placeholder) + '"' : '') + '>';
        }
        html += '</div>';
    });
    var btnLabel = answered ? t('Update') : t('Submit');
    html += '<div class="sdoc-prompt-submit-row">';
    html += '<button type="submit" class="skills-action-btn primary" style="align-self:flex-start">' + escDisplay(btnLabel) + '</button>';
    if (answered) html += '<span class="sdoc-prompt-answered">✓ ' + escDisplay(t('Saved')) + '</span>';
    html += '</div>';
    html += '</form></div>';
    return html;
}

// ─── User Actions ───

function sdocGetCid(docId) {
    return 'sdoc_' + docId.replace(/[^a-zA-Z0-9_]/g, '');
}

// H13: the same doc can render several times in one transcript (every
// <!--doc:--> reference shows the latest version), and every copy shares the
// same element ids — so getElementById always returned the FIRST copy and an
// Edit/Save/Cancel/Compare/Submit on a later copy acted on the wrong one.
// Handlers now pass the clicked element (`this` in the inline attribute; the
// CSP polyfill, platform/extension/csp-polyfill.js _call, also applies the
// handler with `this` = the bound element), and the container is resolved
// from it. Walks past a nested .sdoc for a DIFFERENT doc id.
function _sdocEl(x) {
    return (x && x.nodeType === 1 && typeof x.closest === 'function') ? x : null;
}
function sdocContainerFrom(el, docId) {
    var node = _sdocEl(el);
    var id = String(docId);
    while (node) {
        var c = node.closest('.sdoc[data-doc-id]');
        if (!c) return null;
        if (c.getAttribute('data-doc-id') === id) return c;
        node = _sdocEl(c.parentElement);
    }
    return null;
}

// Find the right sdoc container — the one holding the clicked element first;
// otherwise (programmatic calls, e.g. sdocCreateFromPage) prefer the modal
// instance over inline, then the first inline copy by id.
function sdocGetContainer(docId, fromEl) {
    var own = sdocContainerFrom(fromEl, docId);
    if (own) return own;
    var modal = document.getElementById('sdoc-preview-modal');
    if (modal) {
        var el = modal.querySelector('[data-doc-id="' + docId + '"]');
        if (el) return el;
    }
    return document.getElementById(sdocGetCid(docId));
}

function sdocToggleEdit(docId, fromEl) {
    var c = sdocGetContainer(docId, _sdocEl(fromEl) || _sdocEl(this));
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
        var vsel = c.querySelector('.sdoc-version-select'); if (vsel) vsel.value = ''; // A7A2-01
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

async function sdocSaveEdit(docId, fromEl) {
    var c = sdocGetContainer(docId, _sdocEl(fromEl) || _sdocEl(this));
    if (!c) return;
    var editor = c.querySelector('.sdoc-editor');
    if (!editor) return;
    var doc = smartDocuments[docId];
    if (!doc) return;
    var pmS = c.closest && c.closest('#sdoc-preview-modal'); if (pmS) pmS._sdocFreshId = null; // A7A2-02: an explicit Save keeps the doc

    var titleInput = c.querySelector('.sdoc-title-input');
    var newTitle = titleInput ? titleInput.value.trim() : '';
    var newContent = editor.value;
    var titleChanged = newTitle && newTitle !== doc.title;
    if (newContent === doc.currentContent && !titleChanged) { sdocCancelEdit(docId, c); return; }
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

function sdocCancelEdit(docId, fromEl) {
    var c = sdocGetContainer(docId, _sdocEl(fromEl) || _sdocEl(this));
    if (!c) return;
    var body = c.querySelector('.sdoc-body');
    var edit = c.querySelector('.sdoc-edit');
    if (body) body.style.display = '';
    if (edit) edit.style.display = 'none';
    if (c) c.classList.remove('sdoc-editing');
    var pmC = c.closest && c.closest('#sdoc-preview-modal');
    if (pmC && pmC._sdocFreshId === docId) _sdocDiscardFreshBlank(pmC, docId).then(function(g) { if (g) _sdocRemovePreview(pmC); });
}

// A7A2-02: Cancel/close right after Create drops the never-saved blank doc. The
// marker lives on the preview element, so it dies with it (New chat / Edit with
// agent remove the preview and keep the doc); the pristine check keeps any doc
// that a Save or an agent edit changed meanwhile.
async function _sdocDiscardFreshBlank(pm, docId) {
    if (!pm || pm._sdocFreshId !== docId) return false;
    pm._sdocFreshId = null;
    var d = smartDocuments[docId];
    if (!d || d.currentVersion !== 1 || !Array.isArray(d.versions) || d.versions.length !== 1
        || d.currentContent || d.title !== 'Untitled Document') return false;
    if (typeof unregisterFile === 'function') unregisterFile(d.file_id);
    await deleteDocumentById(docId);
    renderDocumentsPage();
    if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
    return true;
}
function _sdocRemovePreview(pm) { if (!pm) return; if (pm._escHandler) document.removeEventListener('keydown', pm._escHandler); pm.remove(); }

function sdocCompare(docId, versionStr, fromEl) {
    var c = sdocGetContainer(docId, _sdocEl(fromEl) || _sdocEl(this));
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
    // Whole-label keys per known author (stored values stay 'user'/'agent'); an unknown author shows as-is.
    var oldLabel = oldVer.author === 'user' ? t('v{version} (user)', { version: oldVer.version })
        : oldVer.author === 'agent' ? t('v{version} (agent)', { version: oldVer.version })
        : 'v' + oldVer.version + ' (' + oldVer.author + ')';
    diff.innerHTML = sdocRenderDiff(oldVer.content.split('\n'), doc.currentContent.split('\n'),
        oldLabel, t('v{version} (current)', { version: doc.currentVersion }));
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
    // S0B-15: a synchronous throw (non-string content, no clipboard API) gives an
    // error snackbar instead of an uncaught exception with no feedback.
    try {
        var embedLabel = t('[embedded display]');
        var md = doc.currentContent.replace(/<!--display:dsp_\w+-->/g, function() { return embedLabel; });
        navigator.clipboard.writeText(md).then(function() { showSnackbar(t('Markdown copied to clipboard'), 'success'); }).catch(function() { sdocDownloadMd(docId); });
    } catch (e) {
        showSnackbar(t('Download failed: {error}', { error: String((e && e.message) || e) }), 'error');
    }
}

function sdocDownloadMd(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;
    // S0B-15: any throw (non-string content, Blob/URL) gives an error snackbar
    // instead of an uncaught exception with no feedback.
    try {
        var embedLabel = t('[embedded display]');
        var md = doc.currentContent.replace(/<!--display:dsp_\w+-->/g, function() { return embedLabel; });
        var blob = new Blob([md], { type: 'text/markdown' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (doc.title || 'document').replace(/[^a-zA-Z0-9_-]/g, '_') + '.md';
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        showSnackbar(t('Download failed: {error}', { error: String((e && e.message) || e) }), 'error');
    }
}

function sdocOpenNewTab(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;
    // S0B4-02/03: open the persistent app.html?doc= deep link (core/120-init.js) instead of
    // an inert blob page (dead inline handlers, collapsed content) that died on reload/restore.
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html') + '?doc=' + encodeURIComponent(docId) });
}

function sdocStartChat(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;

    // Close preview modal if open (incl. its document-level Escape listener)
    var modal = document.getElementById('sdoc-preview-modal');
    if (modal) {
        if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
        modal.remove();
    }

    // Switch to chat view if needed
    // A5A3-01: newChat() FIRST. showChatView() stamps lastViewedAt on (and consumes
    // the unseen state of) the CURRENT chat, so that must be the new chat, not the
    // one the user left (newChat() has no closer for the Documents panel).
    newChat();
    if (currentView !== 'chat') {
        currentView = 'chat';
        appStorage.setItem('currentView', 'chat');
        hideAllPanels();
        showChatView();
    }
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

// Edit a document with the agent: opens a FRESH chat with the composer prefilled
// with the document id, so the user only has to type what they want changed.
// Deliberate mirror of editWidgetWithAgent (tools/080-widget-tools.js:715) — same
// wording shape ('Edit document <id>:'), same NO-auto-send contract.
function editDocumentWithAgent(docId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    if (!docId) return;

    // The click can come from inside the preview modal (sdocOpenPreview) — remove
    // it so the chat composer is actually visible (incl. removing the preview's
    // document-level Escape listener). No-op for an inline doc.
    var modal = document.getElementById('sdoc-preview-modal');
    if (modal) {
        if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
        modal.remove();
    }

    // newChat() clears #message-input at the end, so the prefill MUST come after it.
    // A5A3-01: it also runs BEFORE the view switch below: showChatView() stamps
    // lastViewedAt on (and consumes the unseen state of) the CURRENT chat, so that
    // must be the new chat, not the one the user left.
    newChat();

    // The doc can also be open from the Documents panel (newChat() has no closer
    // for it), so switch to the chat view — same pattern as sdocStartChat above.
    if (currentView !== 'chat') {
        currentView = 'chat';
        appStorage.setItem('currentView', 'chat');
        hideAllPanels();
        showChatView();
    }

    var input = document.getElementById('message-input');
    if (input) {
        // Newline (not a trailing space) after the colon: the user's edit request
        // starts on line 2. autoResizeTextarea runs AFTER the value is set so the
        // textarea grows to 2 rows, and setSelectionRange puts the caret there.
        // NOT auto-sent — the user types what they want changed.
        input.value = t('Edit document {id}:', { id: docId }) + '\n';
        if (typeof autoResizeTextarea === 'function') autoResizeTextarea(input);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
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

// onsubmit keeps its C1-pinned shape (test/smart-doc-prompt-xss.test.js), so the
// form arrives as the receiver: the CSP polyfill applies handlers with
// `this` = the bound <form>. An explicit 3rd arg wins when given.
function sdocSubmitPrompt(docId, promptId, fromEl) {
    var src = _sdocEl(fromEl) || _sdocEl(this);
    var doc = smartDocuments[docId];
    if (!doc) return;
    var prompt = doc.prompts.find(function(p) { return p.id === promptId; });
    if (!prompt) return;
    // Scope form search to the correct container (clicked copy, modal or inline) to avoid duplicate ID issues
    var formEl = null;
    var srcForm = src ? src.closest('form.sdoc-prompt-form') : null;
    if (srcForm && srcForm.id === 'sdoc-prompt-' + promptId && sdocContainerFrom(srcForm, docId)) formEl = srcForm;
    if (!formEl) {
        var container = sdocGetContainer(docId, src);
        formEl = container ? container.querySelector('#sdoc-prompt-' + promptId) : document.getElementById('sdoc-prompt-' + promptId);
    }
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
    showSnackbar(t('Response saved'), 'success');
}

// ─── Document Preview Modal ───

function sdocOpenPreview(docId) {
    var doc = smartDocuments[docId];
    if (!doc) return;

    var existing = document.getElementById('sdoc-preview-modal');
    if (existing) {
        if (existing._escHandler) document.removeEventListener('keydown', existing._escHandler);
        existing.remove();
    }

    var modal = document.createElement('div');
    modal.id = 'sdoc-preview-modal';
    modal.className = 'sdoc-preview-overlay';
    modal.onclick = function(e) { if (e.target === modal) requestClose(); };

    // Reuse full sdocRender for all features (edit, versions, diff, prompts)
    var html = '<div class="sdoc-preview-container">' + sdocRender(doc) + '</div>';
    modal.innerHTML = html;

    // Add close button to header actions
    var headerActions = modal.querySelector('.sdoc-header-actions');
    if (headerActions) {
        var closeBtn = document.createElement('button');
        closeBtn.className = 'sdoc-action-btn';
        closeBtn.title = t('Close');
        closeBtn.innerHTML = UI_ICONS.close;
        closeBtn.onclick = function(e) { e.stopPropagation(); requestClose(); };
        headerActions.appendChild(closeBtn);
    }

    document.body.appendChild(modal);

    // Escape to close — document-level, so it works no matter where focus is
    // (the old element-level keydown died once focus left the modal). Removed
    // again on every close path; when the generic #modal-overlay is up on top
    // (e.g. the delete-document confirm), the key is left for the global
    // handler so only the topmost layer closes per press.
    function onEsc(e) {
        if (e.key !== 'Escape') return;
        var m = document.getElementById('modal-overlay');
        if (m && m.classList.contains('show')) return;
        requestClose();
    }
    function closePreview() {
        document.removeEventListener('keydown', onEsc);
        modal.remove();
        _sdocDiscardFreshBlank(modal, docId).catch(function() {}); // A7A2-02: after the sync remove, not awaited
    }
    var _confirming = false; // A7A-01
    function isDirty() {
        var c = modal.querySelector('.sdoc.sdoc-editing'), d = smartDocuments[docId];
        if (!c || !d) return false;
        var ed = c.querySelector('.sdoc-editor'), ti = c.querySelector('.sdoc-title-input');
        return !!((ed && ed.value !== d.currentContent) || (ti && ti.value.trim() && ti.value.trim() !== d.title));
    }
    async function requestClose() {
        if (_confirming || !modal.isConnected) return;
        if (isDirty()) {
            _confirming = true;
            var ok = false;
            var docTitle = (smartDocuments[docId] || {}).title;
            try { ok = await showConfirmModal(t('Discard changes?'), docTitle ? t('Unsaved edits to "{title}" will be lost.', { title: escapeHtml(docTitle) }) : t('Unsaved edits to this document will be lost.'), 'warning'); }
            // Reset in a MACROtask: core/120-init.js's Esc closes the confirm first and the
            // microtasks drain before this onEsc runs. A sync reset would re-prompt on the same press.
            finally { setTimeout(function() { _confirming = false; }, 0); }
            if (!ok) return;
        }
        closePreview();
    }
    modal._escHandler = onEsc;
    document.addEventListener('keydown', onEsc);
}

// Open a document from a clickable ID chip in chat text (.id-mention-doc, emitted
// by decorateIdMentions in ui/250-message-render.js). smartDocuments is hydrated
// by loadAllDocuments() at startup, but a doc created by the worker (or in another
// chat since this page loaded) may not be cached yet — hydrate from IndexedDB
// first. loadDocumentById is async and resolves to the doc or null (never rejects:
// its own try/catch + request.onerror both fall through to null).
function openDocumentMention(docId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    if (!docId) return;
    if (smartDocuments[docId]) { sdocOpenPreview(docId); return; }
    loadDocumentById(docId).then(function(doc) {
        if (doc) { sdocOpenPreview(docId); return; }
        if (typeof showSnackbar === 'function') showSnackbar(t('Document {id} not found', { id: docId }), 'error');
        else console.warn('[openDocumentMention] document not found: ' + docId);
    });
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
    // FOCUS-KEEP: the helpers live in the ui tier (250-message-render.js),
    // which the SW bundle doesn't ship — guard so this file stays loadable there.
    var keepFocus = typeof _captureTranscriptFocus === 'function' && typeof _restoreTranscriptFocus === 'function';
    document.querySelectorAll('[data-doc-id="' + docId + '"]').forEach(function(el) {
        var tmp = document.createElement('div');
        tmp.innerHTML = sdocRender(doc);
        var fresh = tmp.firstElementChild;
        if (!fresh) return;
        // Carry the user's unsaved prompt drafts onto the fresh markup (which
        // is built from prompt.responses / field.value only), then re-focus
        // the field they were typing in. Root = the surviving parent so the
        // ancestor-id chain is scoped to THIS instance (inline vs modal copy).
        _sdocCarryPromptDrafts(el, fresh);
        var snap = keepFocus ? _captureTranscriptFocus(el.parentNode || document.body) : null;
        el.replaceWith(fresh);
        if (snap) _restoreTranscriptFocus(snap);
    });
}

// Marks a prompt field as user-touched (delegated from the form's input /
// change events). Only touched fields are carried across re-renders, so an
// agent-updated default on a field the user never edited is NOT clobbered by
// the stale rendered value.
function sdocMarkPromptDirty(target) {
    var field = target && typeof target.closest === 'function' ? target.closest('[data-field-name]') : null;
    if (field) field.setAttribute('data-sdoc-dirty', '1');
}

// Copy live values of every USER-TOUCHED prompt field in `oldRoot` onto the
// matching field (same form id + data-field-name + tag) in `newRoot`. Without
// this an agent update / user edit-save re-rendered the forms from stored
// state and silently dropped whatever the user had typed but not yet
// submitted. Untouched fields take the fresh (possibly agent-updated) value.
function _sdocCarryPromptDrafts(oldRoot, newRoot) {
    // CSS-context escape (attribute selector values), NOT HTML-escape.
    var sel = function(v) {
        v = String(v == null ? '' : v);
        return (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&');
    };
    var oldForms = oldRoot.querySelectorAll('form.sdoc-prompt-form[id]');
    for (var i = 0; i < oldForms.length; i++) {
        var oldForm = oldForms[i];
        var newForm = null;
        try { newForm = newRoot.querySelector('form.sdoc-prompt-form[id="' + sel(oldForm.id) + '"]'); } catch (e) {}
        if (!newForm) continue;
        oldForm.querySelectorAll('[data-field-name][data-sdoc-dirty="1"]').forEach(function(oldField) {
            var newField = null;
            try { newField = newForm.querySelector('[data-field-name="' + sel(oldField.getAttribute('data-field-name')) + '"]'); } catch (e) {}
            if (!newField || newField.tagName !== oldField.tagName) return;
            if (oldField.type === 'checkbox') newField.checked = oldField.checked;
            else newField.value = oldField.value;
            // Keep the marker so the draft survives the NEXT re-render too.
            newField.setAttribute('data-sdoc-dirty', '1');
        });
    }
}

// ─── Time formatting ───

function sdocTimeAgo(ts) {
    // Locale-aware relative text under 30 days, narrow like the old compact '5m ago'
    // (a future stamp from clock skew reads as now, like the old 'just now'), then a locale date.
    var now = Date.now();
    if (Math.floor((now - ts) / 86400000) < 30) return i18nFormatRelative(Math.min(ts, now), { now: now, style: 'narrow' });
    return i18nFormatDate(ts);
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

// Search + Rows/Gallery layout mirror the dashboard's Widget Library
// (ui/065-widget-library.js) and reuse its CSS (css/19b-widget-library.css:
// .widget-library-header/-search/-count, .segmented-toggle, .widget-library-items
// .layout-rows/.layout-gallery, .widget-library-item/-title/-meta/-badge/-btn,
// .widget-library-empty). The layout persists in appStorage like
// 'widgetLibraryLayout'; the query is session-only (same as the library).
var SDOC_PAGE_LAYOUT_KEY = 'documentsPageLayout'; // 'rows' | 'gallery'
var SDOC_GRID_ICON = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
var sdocPageState = { query: '' };

function sdocGetPageLayout() {
    try { return appStorage.getItem(SDOC_PAGE_LAYOUT_KEY) === 'gallery' ? 'gallery' : 'rows'; } catch (e) { return 'rows'; }
}

function sdocSetPageLayout(layout) {
    try { appStorage.setItem(SDOC_PAGE_LAYOUT_KEY, layout === 'gallery' ? 'gallery' : 'rows'); } catch (e) {}
    renderDocumentsPage();
}

function sdocOnPageSearchInput(value) {
    // Documents are plain text (no thumbnail iframes to re-mount), so filter
    // on every keystroke — no debounce needed, unlike the Widget Library.
    sdocPageState.query = String(value || '').trim().toLowerCase();
    renderDocumentsPageItems();
}

function sdocPageItemKey(event, docId) {
    if (event.target !== event.currentTarget) return; // keys on an action button act on the button
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sdocOpenPreview(docId); }
}

// chat-scoped docs are private to their chat — never list them in the global Documents page.
function sdocPageDocs() {
    return Object.values(smartDocuments).filter(function(doc) { return doc.scope !== 'chat'; });
}

function sdocPagePreview(doc) {
    return (doc.currentContent || '').substring(0, 200).replace(/[#*_\x60\n]/g, ' ').trim();
}

function sdocPageMatches(doc, q) {
    if (!q) return true;
    return String(doc.title || '').toLowerCase().indexOf(q) !== -1 ||
        String(doc.currentContent || '').toLowerCase().indexOf(q) !== -1;
}

function renderDocumentsPage() {
    var list = document.getElementById('documents-list');
    if (!list) return;

    // Init sidebar toggle icon
    var toggleBtn = document.getElementById('documents-toggle-sidebar-btn');
    if (toggleBtn) toggleBtn.innerHTML = UI_ICONS.panelLeftClose;

    // Toolbar is built once and kept across re-renders (agent doc updates call
    // renderDocumentsPage) so the search input never loses focus mid-typing.
    // The search/count/toggle live in the page toolbar slot (next to the page's
    // action buttons, ui/045-page-layout.js); fall back to the list if absent.
    var slot = document.getElementById('documents-toolbar-slot');
    var host = slot || list;
    if (slot && !slot.querySelector('.sdoc-page-toolbar') && typeof pageToolbarControlsHtml === 'function') {
        slot.innerHTML = pageToolbarControlsHtml({ extraClass: 'sdoc-page-toolbar', placeholder: t('Search documents\u2026'), inputClass: 'sdoc-page-search-input', onInput: 'sdocOnPageSearchInput', countId: 'documents-count', layoutFn: 'sdocSetPageLayout' });
    }
    if (slot && !document.getElementById('documents-items')) {
        list.innerHTML = '<div class="widget-library-items page-list" id="documents-items"></div>';
    }
    if (!host.querySelector('.sdoc-page-toolbar')) {
        list.innerHTML = '<div class="widget-library-header sdoc-page-toolbar">' +
            '<label class="widget-library-search">' + UI_ICONS.search +
                '<input type="search" class="widget-library-search-input sdoc-page-search-input" placeholder="' + escDisplay(t('Search documents\u2026')) + '" aria-label="' + escDisplay(t('Search documents')) + '" oninput="sdocOnPageSearchInput(this.value)">' +
            '</label>' +
            '<span class="widget-library-count" id="documents-count"></span>' +
            '<div class="segmented-toggle widget-library-layout" role="group" aria-label="' + escDisplay(t('Layout')) + '">' +
                '<button type="button" class="widget-library-layout-btn" data-layout="rows" title="' + escDisplay(t('Rows')) + '" onclick="sdocSetPageLayout(\'rows\')">' + UI_ICONS.list + '<span>' + escDisplay(t('Rows')) + '</span></button>' +
                '<button type="button" class="widget-library-layout-btn" data-layout="gallery" title="' + escDisplay(t('Gallery')) + '" onclick="sdocSetPageLayout(\'gallery\')">' + SDOC_GRID_ICON + '<span>' + escDisplay(t('Gallery')) + '</span></button>' +
            '</div>' +
        '</div>' +
        '<div class="widget-library-items" id="documents-items"></div>';
    }
    var layout = sdocGetPageLayout();
    list.classList.toggle('sdoc-page-gallery', layout === 'gallery');
    host.querySelectorAll('.widget-library-layout-btn').forEach(function(btn) {
        var on = btn.dataset.layout === layout;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var input = host.querySelector('.sdoc-page-search-input');
    if (input && input.value.trim().toLowerCase() !== sdocPageState.query) input.value = sdocPageState.query;
    renderDocumentsPageItems();
}

function renderDocumentsPageItems() {
    var items = document.getElementById('documents-items');
    if (!items) return;
    var layout = sdocGetPageLayout();
    items.className = 'widget-library-items page-list layout-' + layout;
    var q = sdocPageState.query;
    var all = sdocPageDocs();
    var docs = all.filter(function(doc) { return sdocPageMatches(doc, q); });
    docs.sort(function(a, b) { return b.updatedAt - a.updatedAt; });

    var count = document.getElementById('documents-count');
    if (count) count.textContent = q ? t('{shown} of {total}', { shown: i18nFormatNumber(docs.length), total: i18nFormatNumber(all.length) }) : tn(all.length, '{count} document', '{count} documents');

    if (all.length === 0) {
        items.innerHTML = '<div class="widget-library-empty sdoc-page-empty">' + UI_ICONS.file +
            '<p class="sdoc-page-empty-title">' + escDisplay(t('No documents yet')) + '</p>' +
            '<p class="widget-library-empty-hint">' + escDisplay(t('Create a document or ask the agent to create one for you.')) + '</p>' +
            '<button class="skills-action-btn primary" onclick="sdocCreateFromPage()" style="margin-top:12px">' + UI_ICONS.plus + ' ' + escDisplay(t('New Document')) + '</button>' +
            '</div>';
        return;
    }
    if (docs.length === 0) {
        items.innerHTML = '<div class="widget-library-empty sdoc-page-empty">' + UI_ICONS.search +
            '<p class="sdoc-page-empty-title">' + escDisplay(t('No documents match \u201c{query}\u201d', { query: q })) + '</p>' +
            '<p class="widget-library-empty-hint">' + escDisplay(t('Search looks at document titles and content.')) + '</p>' +
            '</div>';
        return;
    }
    items.innerHTML = docs.map(buildDocumentsPageItem).join('');
}

function buildDocumentsPageItem(doc) {
    var id = sdocJsArg(doc.id);
    var lastVer = doc.versions[doc.versions.length - 1];
    var authorIcon = lastVer ? (lastVer.author === 'user' ? '\u{1F464}' : '\u{1F916}') : '';
    var preview = sdocPagePreview(doc);
    var versionCount = doc.versions.length;
    var scope = doc.scope === 'chat' ? 'chat' : 'shared';
    var when = doc.updatedAt ? i18nFormatDateTime(doc.updatedAt) : '';

    var html = '<div class="widget-library-item sdoc-lib-item" data-doc-id="' + escDisplay(doc.id) + '" role="button" tabindex="0"' +
        ' title="' + escDisplay(t('Open {title}', { title: doc.title })) + '" onclick="sdocOpenPreview(\'' + id + '\')" onkeydown="sdocPageItemKey(event, \'' + id + '\')">';
    html += '<div class="sdoc-lib-icon">' + UI_ICONS.file + '</div>';
    html += '<div class="sdoc-lib-info">';
    html += '<div class="widget-library-title sdoc-lib-title">' + escDisplay(doc.title) + '</div>';
    html += '<div class="sdoc-lib-preview' + (preview ? '' : ' empty') + '">' + (preview ? escDisplay(preview) + (preview.length >= 200 ? '...' : '') : escDisplay(t('Empty document'))) + '</div>';
    html += '<div class="widget-library-meta sdoc-lib-meta">';
    html += '<span class="widget-library-badge sdoc-scope-badge scope-' + scope + '">' + escDisplay(scope === 'chat' ? t('Chat') : t('Shared')) + '</span>';
    html += '<span class="widget-library-badge sdoc-version-badge">v' + escDisplay(doc.currentVersion) + '</span>';
    html += '<span class="sdoc-lib-stat sdoc-lib-date" title="' + escDisplay(when) + '">' + UI_ICONS.clock + sdocTimeAgo(doc.updatedAt) + '</span>';
    html += '<span class="sdoc-lib-stat sdoc-lib-versions">' + escDisplay(tn(versionCount, '{count} version', '{count} versions')) + '</span>';
    if (lastVer) html += '<span class="sdoc-lib-stat sdoc-lib-author">' + authorIcon + ' ' + escDisplay(lastVer.author === 'user' ? t('user') : lastVer.author === 'agent' ? t('agent') : lastVer.author) + '</span>';
    html += '</div>';
    html += '</div>';
    var lblChat = escDisplay(t('New chat')), lblExport = escDisplay(t('Export')), lblDelete = escDisplay(t('Delete'));
    html += '<div class="sdoc-lib-actions">';
    html += '<button type="button" class="widget-library-btn" onclick="event.stopPropagation(); sdocStartChat(\'' + id + '\')" title="' + lblChat + '" aria-label="' + lblChat + '">' + UI_ICONS.chat + '</button>';
    html += '<button type="button" class="widget-library-btn" onclick="event.stopPropagation(); sdocDownloadMd(\'' + id + '\')" title="' + lblExport + '" aria-label="' + lblExport + '">' + UI_ICONS.download + '</button>';
    html += '<button type="button" class="widget-library-btn danger" onclick="event.stopPropagation(); sdocDeleteFromPage(\'' + id + '\')" title="' + lblDelete + '" aria-label="' + lblDelete + '">' + UI_ICONS.trash + '</button>';
    html += '</div>';
    html += '</div>';
    return html;
}

async function sdocDeleteFromPage(docId) {
    var doc = smartDocuments[docId];
    var msg = doc ? t('Delete "{title}" and all its versions? This cannot be undone.', { title: escapeHtml(doc.title) })
        : t('Delete this document and all its versions? This cannot be undone.');
    if (!await showConfirmModal(t('Delete Document'), msg, 'danger')) return;
    await deleteDocumentById(docId);
    renderDocumentsPage();
    renderVersionSidebar();
    showSnackbar(t('Document deleted'), 'success');
}

// ─── Create from Page ───

async function sdocCreateFromPage() {
    // Create a blank document — readable slug id ('untitled_document',
    // 'untitled_document_2', … on collision).
    var docId = await _sdocNewId('Untitled Document');
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
    var pm = document.getElementById('sdoc-preview-modal');
    if (pm) pm._sdocFreshId = docId; // A7A2-02: this preview holds a never-saved blank doc
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
    // S0B-15: any throw (a doc getter, serialisation, Blob/URL) gives an error
    // snackbar instead of an uncaught exception with no feedback.
    try {
        // Exclude chat-scoped (private) docs from "export all" — they belong to their chat only.
        var docs = Object.values(smartDocuments).filter(function(doc) { return doc.scope !== 'chat'; });
        if (docs.length === 0) { showSnackbar(t('No documents to export'), 'error'); return; }

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
        showSnackbar(tn(docs.length, 'Exported {count} document(s)', 'Exported {count} document(s)'), 'success');
    } catch (e) {
        showSnackbar(t('Download failed: {error}', { error: String((e && e.message) || e) }), 'error');
    }
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
                showSnackbar(t('Invalid document export file'), 'error');
                return;
            }
            // S0B-09: validate every row first (no write yet), confirm before replacing
            // any shared same-id doc (Cancel writes nothing), then write once, atomically.
            // RC2A3-F4: null-prototype maps + own-property lookups, so ids naming
            // Object.prototype members (constructor, toString, ...) import as themselves
            // instead of posing as in-file duplicates or existing docs; '__proto__' is
            // skipped and counted (smartDocuments['__proto__'] = doc would re-parent the cache).
            var rows = [], skipped = 0, seen = Object.create(null), shared = [];
            var ownDoc = function(id) { return Object.prototype.hasOwnProperty.call(smartDocuments, id) ? smartDocuments[id] : null; };
            for (var i = 0; i < data.documents.length; i++) {
                var doc = data.documents[i];
                if (!doc || typeof doc !== 'object' || typeof doc.id !== 'string' || !doc.id || doc.id === '__proto__' || typeof doc.title !== 'string' || !doc.title
                    || (doc.versions != null && !Array.isArray(doc.versions))
                    || (doc.currentContent != null && typeof doc.currentContent !== 'string')) { skipped++; continue; }
                // Ensure required fields
                doc.versions = doc.versions || [];
                doc.displays = doc.displays || {};
                doc.prompts = doc.prompts || [];
                doc.createdAt = doc.createdAt || Date.now();
                doc.updatedAt = doc.updatedAt || Date.now();
                doc.currentVersion = doc.currentVersion || 1;
                doc.currentContent = doc.currentContent || '';
                // A repeated id within the file is always imported as a copy.
                var dup = !!seen[doc.id]; seen[doc.id] = true;
                var cur = dup ? null : (ownDoc(doc.id) || await loadDocumentById(doc.id));
                rows.push({ doc: doc, cur: cur, dup: dup });
                if (cur && cur.scope !== 'chat') shared.push(cur);
            }
            if (!rows.length) { showSnackbar(tn(skipped, 'No valid documents to import ({count} skipped)', 'No valid documents to import ({count} skipped)'), 'error'); return; }
            var choice = 'keep';
            if (shared.length) {
                var names = shared.slice(0, 10).map(function(c) { return escDisplay(c.title || c.id); }).join('<br>');
                if (shared.length > 10) names += '<br>' + escDisplay(tn(shared.length - 10, '+{count} more', '+{count} more'));
                choice = await showModal(t('Import documents'), escDisplay(tn(shared.length, '{count} document(s) in this file already exist:', '{count} document(s) in this file already exist:')) + '<br>' + names +
                    '<br><br>' + t('<strong>Replace</strong> overwrites their content <strong>and version history</strong>. <strong>Keep both</strong> imports them as copies.'), [
                    { label: t('Cancel'), value: 'cancel', class: 'secondary' },
                    { label: t('Keep both'), value: 'keep', class: 'primary' },
                    { label: t('Replace'), value: 'replace', class: 'danger' }
                ], 'warning');
                if (choice !== 'keep' && choice !== 'replace') return; // Cancel / dismiss: nothing written
            }
            // Never trust the file's scope/ownerChatId/file_id; a chat-private clash is never replaced.
            var taken = Object.create(null), replaced = 0, copied = 0;
            rows.forEach(function(r) { r.copy = r.dup || !!(r.cur && (r.cur.scope === 'chat' || choice !== 'replace')); if (!r.copy) taken[r.doc.id] = true; });
            for (var j = 0; j < rows.length; j++) {
                var r = rows[j], d = r.doc;
                if (r.copy) {
                    var base = await _sdocNewId(d.title), nid = base, n = 2;
                    while (taken[nid] || ownDoc(nid) || await loadDocumentById(nid)) { nid = base + '_' + n; n++; }
                    d.id = nid; taken[nid] = true; copied++;
                }
                d.scope = 'shared';
                if (r.cur && !r.copy) { d.ownerChatId = r.cur.ownerChatId; d.file_id = r.cur.file_id || newFileId(); replaced++; }
                else { delete d.ownerChatId; d.file_id = newFileId(); }
            }
            // TA4-7: a SLOW-tx TimeoutError (core/130 rejectSlow, flagged _dbTxSlow) means the
            // backend answered its probe and the write was left queued to commit in the
            // background, NOT aborted. Reporting "Import failed" hid docs that reappeared after a
            // reload, and a retry re-imported every one of them as a copy. So cache + register
            // them and warn instead. A wedged-tx TimeoutError (_dbTxTimeout: aborted, retried once
            // by withStore) or any other rejection is still a failure that leaves the cache untouched.
            var writeTx = null, stillSaving = false;
            try {
                try {
                    await withStore([documentsStoreName], 'readwrite', function(tx) {
                        writeTx = tx;
                        var store = tx.objectStore(documentsStoreName);
                        rows.forEach(function(r) { store.put(r.doc); });
                    });
                } catch (writeErr) {
                    if (!(writeErr && writeErr.name === 'TimeoutError' && writeErr._dbTxSlow)) throw writeErr;
                    stillSaving = true;
                    console.warn('[SmartDocs] import: IndexedDB is busy; the write was left to commit in the background', writeErr);
                    // A late abort (e.g. quota) of the queued write must not stay silent.
                    try {
                        var queuedTx = writeTx;
                        queuedTx.addEventListener('abort', function() {
                            showSnackbar(t('Import did not finish saving: {error}. The imported documents will not survive a reload.', { error: (queuedTx.error && queuedTx.error.message) || t('transaction aborted') }), 'error');
                        });
                    } catch (listenErr) { /* best-effort */ }
                }
                rows.forEach(function(r) { smartDocuments[r.doc.id] = r.doc; registerFile(r.doc.file_id, { type: 'document', docId: r.doc.id }); });
            } finally {
                // RC2A3-F5: a render throw must neither turn a committed import into
                // "Import failed" nor mask a withStore rejection (the only error path).
                try { renderDocumentsPage(); } catch (renderErr) { console.warn('[SmartDocs] import: documents page render failed', renderErr); }
                try { renderVersionSidebar(); } catch (renderErr) { console.warn('[SmartDocs] import: version sidebar render failed', renderErr); }
            }
            var importedMsg = tn(rows.length, 'Imported {count} document(s) ({replaced} replaced, {copied} copied, {skipped} skipped)', 'Imported {count} document(s) ({replaced} replaced, {copied} copied, {skipped} skipped)', { replaced: i18nFormatNumber(replaced), copied: i18nFormatNumber(copied), skipped: i18nFormatNumber(skipped) });
            if (stillSaving) showSnackbar(t('{summary}. Storage is busy, so they are still saving in the background.', { summary: importedMsg }), 'warning');
            else showSnackbar(importedMsg, 'success');
        } catch (err) {
            showSnackbar(t('Import failed: {error}', { error: String((err && err.message) || err) }), 'error');
        }
    };
    input.click();
}

// renderDocumentsSidebar removed — documents now render in the right sidebar (version-sidebar) via renderVersionSidebar()
