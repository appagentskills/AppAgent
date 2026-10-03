// SMART DOCUMENTS — Persistent, versioned markdown documents
// =============================================
// Documents live in IndexedDB, referenced by ID across chats.
// Multiple <!--document:ID--> placeholders all render the same current version.
// Supports embedded display templates, non-blocking prompts, inline diff.

var smartDocuments = {}; // in-memory cache: docId -> doc object

// ─── IndexedDB CRUD ───

// ─── Lazy version bodies ───
// Memory keeps every version's metadata but only the CURRENT body, which shares
// the currentContent string (no second copy). Older bodies stay in IndexedDB:
// _sdocStrip swaps them for {_stub: true, _size} entries; sdocLoadVersionContent
// and exportAllDocuments read them back on demand; saveDocument swaps each stub
// for its identity-matched stored entry (_sdocMergeForSave), so a stub is never
// persisted and a version memory no longer lists is never written back.
function _sdocIsStub(v) { return !!(v && typeof v === 'object' && v._stub === true); }

function _sdocStrip(doc) {
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.versions)) return doc;
    var cur = doc.currentContent;
    doc.versions = doc.versions.map(function(v) {
        if (!v || typeof v !== 'object' || v._stub || typeof v.content !== 'string') return v;
        if (v.version === doc.currentVersion && v.content === cur) { v.content = cur; return v; }
        var s = {};
        Object.keys(v).forEach(function(k) { if (k !== 'content') s[k] = v[k]; });
        s._stub = true;
        s._size = v.content.length;
        return s;
    });
    return doc;
}

function _sdocOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function _sdocMetaKey(k) { return k !== 'content' && k !== '_stub' && k !== '_size'; }

// Identity of a stub and a stored entry: same version, the same metadata keys
// with the same values, and a body of the recorded length. A stored entry that
// fails any of these was rewritten since the stub was taken: not the same body.
function _sdocSameEntry(stub, sv) {
    if (!_sdocIsStub(stub) || !sv || typeof sv !== 'object' || _sdocIsStub(sv)) return false;
    if (sv.version !== stub.version || typeof sv.content !== 'string' || sv.content.length !== stub._size) return false;
    var a = Object.keys(stub).filter(_sdocMetaKey), b = Object.keys(sv).filter(_sdocMetaKey);
    return a.length === b.length && a.every(function(k) { return _sdocOwn(sv, k) && JSON.stringify(sv[k]) === JSON.stringify(stub[k]); });
}

// A stored record's version entries by version number (one pass, so resolving
// every stub of a long history stays linear).
function _sdocStoredIndex(stored) {
    var idx = new Map(), list = (stored && Array.isArray(stored.versions)) ? stored.versions : [];
    list.forEach(function(sv) {
        if (!sv || typeof sv !== 'object') return;
        if (!idx.has(sv.version)) idx.set(sv.version, []);
        idx.get(sv.version).push(sv);
    });
    return idx;
}

// The stored entry a stub stands for, or null (missing or rewritten). With
// `used`, each stored entry is taken once, so duplicate version numbers never
// collapse onto one body.
function _sdocStoredBody(stub, idx, used) {
    var list = idx.get(stub.version) || [];
    for (var i = 0; i < list.length; i++) {
        if (used && used.has(list[i])) continue;
        if (_sdocSameEntry(stub, list[i])) { if (used) used.add(list[i]); return list[i]; }
    }
    return null;
}

// The entry without the in-memory stub markers (the entry itself when it has none).
function _sdocClean(v) {
    if (!v || typeof v !== 'object' || (!_sdocOwn(v, '_stub') && !_sdocOwn(v, '_size'))) return v;
    var c = {};
    Object.keys(v).forEach(function(k) { if (k !== '_stub' && k !== '_size') c[k] = v[k]; });
    return c;
}

// The record to persist: memory's doc-level fields and memory's version list.
// Memory owns version MEMBERSHIP, as the pre-lazy blind put did: a version only
// the store holds (deleted here, or written by another context) is not carried
// over, so a deleted version never comes back. A bodied entry is written as is;
// a stub takes its identity-matched stored entry (_sdocSameEntry), else it is
// left out with a warning (never persisted body-less) and pushed to `dropped`.
// Stub markers are stripped from every entry written. Import writes the store
// directly (full bodies) and bypasses this.
function _sdocMergeForSave(doc, stored, dropped) {
    var rec = {};
    Object.keys(doc).forEach(function(k) { rec[k] = doc[k]; });
    if (!Array.isArray(doc.versions)) return rec;
    rec.versions = [];
    var idx = _sdocStoredIndex(stored), used = new Set();
    doc.versions.forEach(function(v) {
        if (!_sdocIsStub(v)) { rec.versions.push(_sdocClean(v)); return; }
        var hit = _sdocStoredBody(v, idx, used);
        if (hit) { rec.versions.push(_sdocClean(hit)); return; }
        console.warn('[SmartDocs] ' + doc.id + ' v' + v.version + ': stored body missing or changed, version not persisted');
        if (dropped) dropped.push(v);
    });
    return rec;
}

async function loadAllDocuments() {
    try {
        var database = await openDatabase();
        var tx = database.transaction([documentsStoreName], 'readonly');
        var store = tx.objectStore(documentsStoreName);
        return await new Promise(function(resolve) {
            var results = [];
            function adopt(doc) {
                doc = _sdocStrip(doc);
                if (!doc || doc.id == null) return;
                smartDocuments[doc.id] = doc;
                if (doc.file_id) registerFile(doc.file_id, { type: 'document', docId: doc.id });
                results.push(doc);
            }
            // Cursor: ONE record deserialized at a time, stripped before the next
            // (getAll held every body of every version at once, ~100 MB per call).
            // getAll stays only as a fallback for a store without cursors.
            if (typeof store.openCursor !== 'function') {
                var all = store.getAll();
                all.onsuccess = function() { (all.result || []).forEach(adopt); resolve(results); };
                all.onerror = function() { resolve(results); };
                return;
            }
            var request = store.openCursor();
            request.onsuccess = function() {
                var cursor = request.result;
                if (!cursor) { resolve(results); return; }
                try { adopt(cursor.value); } catch (e) { console.error('Failed to load document:', e); }
                cursor.continue();
            };
            request.onerror = function() { resolve(results); };
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
        var store = tx.objectStore(documentsStoreName);
        // get -> merge -> put in ONE readwrite tx (no other write lands between).
        // Resolves once the put is issued (the old timing), not on commit.
        await new Promise(function(resolve) {
            var rq = store.get(doc.id);
            rq.onsuccess = function() {
                var dropped = [];
                try { store.put(_sdocMergeForSave(doc, rq.result, dropped)); } catch (e) { console.error('Failed to save document:', e); }
                // A stub left out is not on disk: drop it here too, so the version
                // list (counts, compare picker) matches what a reload shows.
                if (dropped.length && Array.isArray(doc.versions)) {
                    console.warn('[SmartDocs] ' + doc.id + ': ' + dropped.length + ' version(s) dropped from memory (stored body missing or changed): v' + dropped.map(function(v) { return v.version; }).join(', v'));
                    doc.versions = doc.versions.filter(function(v) { return dropped.indexOf(v) < 0; });
                }
                resolve();
            };
            rq.onerror = function(ev) {
                if (ev && typeof ev.preventDefault === 'function') ev.preventDefault(); // keep the tx alive
                // Unreadable record: a stub-free doc is written as before; one with stubs
                // is NOT (that would drop the stored bodies). Memory keeps the change.
                if (Array.isArray(doc.versions) && doc.versions.some(_sdocIsStub)) console.warn('[SmartDocs] save of ' + doc.id + ' skipped: stored record unreadable');
                else { try { store.put(_sdocMergeForSave(doc, null)); } catch (e) { console.error('Failed to save document:', e); } }
                resolve();
            };
        });
    } catch (e) {
        console.error('Failed to save document:', e);
    }
}

// Raw stored record (unstripped, NOT adopted into the cache): the only source of
// an old version's body. Resolves null ONLY when the record is genuinely missing;
// REJECTS on a read failure (openDatabase rejected — reload latch, open watchdog —,
// transaction() threw, or the get errored), so a caller can tell an unhealthy
// store from an absent record (export must not treat the two alike).
// Bounded: a get that never settles (wedged transaction) rejects with a
// TimeoutError after SDOC_STORED_READ_TIMEOUT_MS instead of hanging the caller.
var SDOC_STORED_READ_TIMEOUT_MS = 15000;
async function _sdocReadStored(docId) {
    var database = await openDatabase();
    var rq = database.transaction([documentsStoreName], 'readonly').objectStore(documentsStoreName).get(docId);
    return await new Promise(function(resolve, reject) {
        var timer = setTimeout(function() {
            var err = new Error('IndexedDB read of ' + docId + ' timed out after ' + SDOC_STORED_READ_TIMEOUT_MS + ' ms');
            err.name = 'TimeoutError';
            reject(err);
        }, SDOC_STORED_READ_TIMEOUT_MS);
        rq.onsuccess = function() { clearTimeout(timer); resolve(rq.result || null); };
        rq.onerror = function() { clearTimeout(timer); reject(rq.error || new Error('IndexedDB read of ' + docId + ' failed')); };
    });
}
// Snackbar text of an error: a DOMException (IDB get/tx error) can carry an
// EMPTY message — fall back to its name, then to a generic text.
function _sdocErrMessage(e) {
    var m = e && typeof e === 'object' ? (typeof e.message === 'string' ? e.message : '') || (typeof e.name === 'string' ? e.name : '') : (e == null ? '' : String(e));
    return m || t('unknown error');
}

// One version WITH its body, or null. Memory owns membership: a version memory
// does not list is never served from the store (deleted, or memory is stale).
// A bodied entry comes from memory; a stub resolves only from its
// identity-matched stored entry (_sdocStoredBody), as in _sdocMergeForSave.
async function sdocLoadVersionContent(docId, version) {
    var doc = smartDocuments[docId];
    var v = (doc && Array.isArray(doc.versions)) ? doc.versions.find(function(x) { return x && x.version === version; }) : null;
    if (!v) return null;
    if (!_sdocIsStub(v)) return typeof v.content === 'string' ? v : null;
    var stored;
    try { stored = await _sdocReadStored(docId); } catch (e) { return null; } // unreadable: body unavailable, never a throw
    var hit = _sdocStoredBody(v, _sdocStoredIndex(stored));
    return hit ? _sdocClean(hit) : null;
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
                var doc = _sdocStrip(request.result);
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
    if (action === 'read_version') return await sdocToolReadVersion(args, options);
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
        versions: [{ version: 1, content: content, title: title, author: 'agent', timestamp: now, chatId: ownerChatId || null }],
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
            title: doc.title, author: 'agent', timestamp: Date.now(), chatId: _sdocChatId(options) || null
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

async function sdocToolReadVersion(args, options) {
    var docId = args.doc_id;
    var version = args.version;
    if (!docId) return { success: false, error: 'doc_id is required' };
    if (!version) return { success: false, error: 'version is required' };
    var doc = smartDocuments[docId];
    if (!doc || !_sdocAccessible(doc, options)) return { success: false, error: 'Document not found: ' + docId };
    var v = doc.versions.find(function(ver) { return ver.version === version; });
    if (!v) return { success: false, error: 'Version ' + version + ' not found' };
    v = await sdocLoadVersionContent(docId, version); // old bodies are lazy (IDB)
    if (!v) return { success: false, error: 'Version ' + version + ' content is unavailable' };
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
    doc.versions.push({ version: doc.currentVersion, content: content, title: doc.title, author: 'agent', timestamp: Date.now(), chatId: _sdocChatId(options) || null });
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

async function sdocCompare(docId, versionStr, fromEl) {
    var c = sdocGetContainer(docId, _sdocEl(fromEl) || _sdocEl(this));
    if (!c) return;
    var diff = c.querySelector('.sdoc-diff');
    var body = c.querySelector('.sdoc-body');
    var edit = c.querySelector('.sdoc-edit');
    var doc = smartDocuments[docId];
    if (!diff || !body || !doc) return;

    var tok = c._sdocCmpTok = (c._sdocCmpTok || 0) + 1; // a later pick or reset supersedes a pending load
    if (!versionStr) { diff.style.display = 'none'; body.style.display = ''; c.classList.remove('sdoc-diffing'); return; }

    var version = parseInt(versionStr);
    var oldVer = doc.versions.find(function(v) { return v.version === version; });
    if (!oldVer) return;
    if (_sdocIsStub(oldVer) || typeof oldVer.content !== 'string') {
        // Lazy body (IDB). A body already in memory renders synchronously, as before.
        oldVer = await sdocLoadVersionContent(docId, version);
        if (!oldVer || c._sdocCmpTok !== tok) return;
        doc = smartDocuments[docId] || doc;
    }

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
        var md = _sdocDocMarkdown(doc);
        var blob = new Blob([md], { type: 'text/markdown' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = _sdocDocFileName(doc);
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
    if (!_sdocOpenFreshChat(doc.title, sdocDocRefText(doc))) return;
    // Attach document as a pending attachment (like images)
    sdocAttachToInput(docId);
}

// Fresh chat for a Documents-page "Start chat": closes the preview modal, opens a
// new chat (titled "Re: <name>") and prefills the composer with `prefill` (NOT sent).
// A5A3-01: newChat() FIRST. showChatView() stamps lastViewedAt on (and consumes
// the unseen state of) the CURRENT chat, so that must be the new chat, not the
// one the user left (newChat() has no closer for the Documents panel).
function _sdocOpenFreshChat(name, prefill) {
    if (typeof document === 'undefined' || typeof newChat !== 'function') return false;
    var modal = document.getElementById('sdoc-preview-modal');
    if (modal) {
        if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
        modal.remove();
    }
    newChat();
    if (currentView !== 'chat') {
        currentView = 'chat';
        appStorage.setItem('currentView', 'chat');
        hideAllPanels();
        showChatView();
    }
    var chat = chats[currentChatId];
    if (chat && name) {
        chat.title = 'Re: ' + name;
        saveChatsToStorage();
        renderChatList();
        updateChatTitleHeader();
    }
    var input = document.getElementById('message-input');
    if (input) {
        // newChat() clears the composer, so the prefill comes after it; caret on the line below.
        if (prefill) {
            input.value = prefill + '\n\n';
            if (typeof autoResizeTextarea === 'function') autoResizeTextarea(input);
        }
        input.focus();
        if (prefill && input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
    }
    return true;
}

// ─── Chat links (Documents page rows) ───
// Agent-facing references (plain English, like start_chat's widget prefix in
// tools/150-start-chat.js): each names the id(s) and the exact tool call that
// resolves the item, so the new chat's agent can open it without guessing.
function _sdocFlat(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function sdocDocRefText(doc) {
    var title = _sdocFlat(doc && doc.title);
    return 'Context: smart document ' + doc.id + (title ? ' ("' + title + '")' : '') +
        ' \u2014 read it with the document tool (action "read", doc_id "' + doc.id + '").';
}
function sdocFileRefText(src, entry) {
    var dir = entry.kind === 'directory', p = entry.path || '', what = dir ? 'folder' : 'file';
    if (src.type === 'ws') {
        return 'Context: workspace ' + what + ' ' + (p || '/') + ' in workspace ' + src.wk +
            ' \u2014 ' + (dir ? 'list it with the workspace tool (action "ls"' : 'read it with the workspace tool (action "read"') +
            ', workspace "' + src.wk + '", path "' + p + '").';
    }
    return 'Context: ' + what + ' ' + (p || '/') + ' in connected folder "' + _sdocFlat(src.label) + '" (folder id ' + src.folderId + ')' +
        ' \u2014 ' + (dir ? 'list it with local_folder (action "ls"' : 'read it with local_folder (action "read"') +
        ', folder "' + src.folderId + '", path "' + p + '").';
}
// Provenance: the chat that last wrote a doc = the newest version stamped with a
// chatId (agent create/update/edit), else the creator (ownerChatId). Page edits
// (author 'user') carry no chat and are skipped.
function sdocDocSourceChatId(doc) {
    if (!doc) return null;
    var vs = Array.isArray(doc.versions) ? doc.versions : [];
    for (var i = vs.length - 1; i >= 0; i--) if (vs[i] && vs[i].chatId) return vs[i].chatId;
    return doc.ownerChatId || null;
}
// Workspace files: the per-file last_modified_by_chat_id stamp (set while the
// change is uncommitted; carried as entry.chatId by _sdocWsEntries). Connected
// folders and Agent Files keep no per-file provenance, so they get none.
function sdocFileSourceChatId(src, entry) {
    if (!src || !entry || src.type !== 'ws' || entry.kind !== 'file') return null;
    return entry.chatId || null;
}
function sdocOpenSourceChat(chatId) {
    if (!chatId || typeof chats === 'undefined' || !chats || !chats[chatId]) {
        if (typeof showSnackbar === 'function') showSnackbar(t('That chat no longer exists'), 'error');
        return false;
    }
    if (typeof openChatFromHistory === 'function') openChatFromHistory(chatId);
    else if (typeof selectChat === 'function') selectChat(chatId);
    return true;
}
function sdocStartChatForFile(idx) {
    var row = sdocSrcState.rendered[idx];
    if (!row) return false;
    return _sdocOpenFreshChat(row.entry.name, sdocFileRefText(row.src, row.entry));
}
function sdocOpenFileRowChat(idx) {
    var row = sdocSrcState.rendered[idx];
    if (!row) return false;
    return sdocOpenSourceChat(sdocFileSourceChatId(row.src, row.entry));
}
// "Open chat" (only when openCall is given) + "Start chat" row buttons. Both stop
// propagation so they never open the row or toggle its selection; the row keydown
// handlers ignore keys whose target is a button.
function _sdocChatBtnsHtml(name, startCall, openCall) {
    var html = '';
    if (openCall) {
        var o = _sdsEsc(t('Open the chat that edited {name}', { name: name }));
        html += '<button type="button" class="widget-library-btn sdoc-open-chat-btn" onclick="event.stopPropagation(); ' + openCall + '" title="' + o + '" aria-label="' + o + '">' + UI_ICONS.externalLink + '</button>';
    }
    var s = _sdsEsc(t('Start a chat about {name}', { name: name }));
    return html + '<button type="button" class="widget-library-btn sdoc-start-chat-btn" onclick="event.stopPropagation(); ' + startCall + '" title="' + s + '" aria-label="' + s + '">' + UI_ICONS.chat + '</button>';
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
    if (panel) {
        panel.style.display = 'flex'; sdocResetSources();
        sdocGhReset();
        // Restore the persisted rail selection once; the refresh fallback
        // (sdocRefreshSources) resets it to 'all' if that source is gone.
        if (!sdocSrcState.restored) {
            sdocSrcState.restored = true;
            try {
                var savedSrc = (typeof appStorage !== 'undefined' && appStorage) ? appStorage.getItem('documentsPageSource') : null;
                if (savedSrc) sdocSrcState.sel = String(savedSrc);
            } catch (e) {}
        }
        renderDocumentsPage();
        // The repo list is fetched here (and on picker focus / mode switch / Retry), never from a render.
        if (_sdocConnMode() === 'github') sdocGhLoadRepos();
    }
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

// ─── Group by / sort (toolbar select next to the Rows/Gallery toggle) ───
// Pure helpers (no DOM): sdocNormalizeGroupBy, sdocDayStart, sdocWeekStart,
// sdocGroupItems, sdocHeaderActionsVisible, sdocEntryMatches. Persisted in appStorage.
var SDOC_PAGE_GROUP_KEY = 'documentsPageGroupBy';
var SDOC_GROUP_MODES = ['alpha', 'date', 'git', 'folder', 'day', 'week'];
var SDOC_GROUP_LABELS = { alpha: N_('Alphabetical'), date: N_('Date'), git: N_('Git'), folder: N_('Folder'), day: N_('Day'), week: N_('Week') };
function sdocNormalizeGroupBy(v) { return SDOC_GROUP_MODES.indexOf(v) !== -1 ? v : 'date'; }
function sdocGetGroupBy() {
    try { return sdocNormalizeGroupBy(appStorage.getItem(SDOC_PAGE_GROUP_KEY)); } catch (e) { return 'date'; }
}
function sdocSetGroupBy(mode) {
    mode = sdocNormalizeGroupBy(mode);
    try { appStorage.setItem(SDOC_PAGE_GROUP_KEY, mode); } catch (e) {}
    if (typeof document === 'undefined') return mode;
    _sdocSyncGroupBySelect();
    renderDocumentsPageItems();
    return mode;
}
// Keyboard shortcut "g" (ui/320 KBD_SHORTCUTS 'docs-group-by'): next mode, announced.
function sdocCycleGroupBy() {
    var cur = sdocGetGroupBy(), next = SDOC_GROUP_MODES[(SDOC_GROUP_MODES.indexOf(cur) + 1) % SDOC_GROUP_MODES.length];
    sdocSetGroupBy(next);
    if (typeof showSnackbar === 'function') showSnackbar(_sdsT(N_('Group by: {mode}'), { mode: _sdsT(SDOC_GROUP_LABELS[next]) }), 'info');
    return next;
}
// Group-by menu: a .custom-dropdown (css/09-settings, ui/140 outside-click +
// core/120 Esc ladder) with a button trigger (icon + current mode) and a
// role=listbox of icon options. Keys: arrows/Home/End/type-ahead move,
// Enter/Space pick, Esc/Tab close (Esc stops here so it never exits selection mode).
var SDOC_GROUP_ICONS = { alpha: 'sortAlpha', date: 'calendar', git: 'gitBranch', folder: 'folder', day: 'calendarDay', week: 'calendarWeek' };
function _sdocGroupIcon(m) {
    var k = SDOC_GROUP_ICONS[m];
    return (typeof UI_ICONS !== 'undefined' && UI_ICONS && UI_ICONS[k]) ? UI_ICONS[k] : '';
}
function _sdocGroupByBtnInner(cur) {
    return '<span class="sdoc-groupby-icon" aria-hidden="true">' + _sdocGroupIcon(cur) + '</span>' +
        '<span class="sdoc-groupby-value">' + _sdsEsc(_sdsT(SDOC_GROUP_LABELS[cur])) + '</span>' +
        '<span class="dropdown-arrow" aria-hidden="true">' + (typeof UI_ICONS !== 'undefined' && UI_ICONS ? UI_ICONS.chevronDown || '' : '') + '</span>';
}
function _sdocGroupByAria(cur) {
    return _sdsT(N_('Group by: {mode}'), { mode: _sdsT(SDOC_GROUP_LABELS[cur]) });
}
function _sdocGroupBySelectHtml() {
    var cur = sdocGetGroupBy(), aria = _sdocGroupByAria(cur);
    return '<div class="custom-dropdown sdoc-groupby" onkeydown="sdocGroupByKey(event)">' +
        '<button type="button" class="custom-dropdown-trigger sdoc-groupby-btn" id="sdoc-groupby-btn" aria-haspopup="listbox" aria-expanded="false"' +
        ' aria-controls="sdoc-groupby-menu" aria-keyshortcuts="G" data-current="' + cur + '" aria-label="' + _sdsEsc(aria) + '" title="' + _sdsEsc(aria + ' (G)') + '"' +
        ' onclick="sdocToggleGroupByMenu()">' + _sdocGroupByBtnInner(cur) + '</button>' +
        '<div class="custom-dropdown-menu sdoc-groupby-menu"><div class="custom-dropdown-options" id="sdoc-groupby-menu" role="listbox" aria-labelledby="sdoc-groupby-btn">' +
        SDOC_GROUP_MODES.map(function(m) {
            var on = m === cur;
            return '<div class="custom-dropdown-option sdoc-groupby-option' + (on ? ' selected' : '') + '" role="option" tabindex="-1" data-mode="' + m + '"' +
                ' aria-selected="' + (on ? 'true' : 'false') + '" onclick="sdocPickGroupBy(\'' + m + '\', event)">' +
                '<span class="sdoc-groupby-icon" aria-hidden="true">' + _sdocGroupIcon(m) + '</span>' +
                '<span class="sdoc-groupby-option-label">' + _sdsEsc(_sdsT(SDOC_GROUP_LABELS[m])) + '</span></div>';
        }).join('') + '</div></div></div>';
}
function _sdocGroupByRoot() {
    if (typeof document === 'undefined') return null;
    var host = document.getElementById('documents-panel') || document;
    return host.querySelector('.sdoc-page-toolbar .sdoc-groupby');
}
function _sdocGroupByOptions(root) { return root ? Array.prototype.slice.call(root.querySelectorAll('.sdoc-groupby-option')) : []; }
function sdocGroupByMenuOpen() { var root = _sdocGroupByRoot(); return !!(root && root.classList.contains('open')); }
function sdocOpenGroupByMenu(focusMode) {
    var root = _sdocGroupByRoot();
    if (!root) return;
    if (typeof document !== 'undefined') document.querySelectorAll('.custom-dropdown.open').forEach(function(d) { if (d !== root) d.classList.remove('open'); });
    root.classList.add('open');
    var btn = root.querySelector('.sdoc-groupby-btn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    if (typeof syncCustomDropdownExpanded === 'function') syncCustomDropdownExpanded();
    var opts = _sdocGroupByOptions(root), want = focusMode || sdocGetGroupBy(), target = null;
    opts.forEach(function(o) { if (!target && o.getAttribute('data-mode') === want) target = o; });
    target = target || opts[0];
    if (target) target.focus();
}
function sdocCloseGroupByMenu(refocus) {
    var root = _sdocGroupByRoot();
    if (!root) return;
    root.classList.remove('open');
    var btn = root.querySelector('.sdoc-groupby-btn');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
    if (typeof syncCustomDropdownExpanded === 'function') syncCustomDropdownExpanded();
}
function sdocToggleGroupByMenu() {
    if (sdocGroupByMenuOpen()) sdocCloseGroupByMenu(true); else sdocOpenGroupByMenu();
}
function sdocPickGroupBy(mode, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    sdocCloseGroupByMenu(true);
    return sdocSetGroupBy(mode);
}
// Pure: next option index for a key in a list of n, or -1 (type-ahead uses labels).
function sdocGroupByMenuIndex(key, cur, n, labels) {
    if (!n) return -1;
    if (key === 'ArrowDown') return cur < 0 ? 0 : (cur + 1) % n;
    if (key === 'ArrowUp') return cur < 0 ? n - 1 : (cur - 1 + n) % n;
    if (key === 'Home') return 0;
    if (key === 'End') return n - 1;
    if (labels && typeof key === 'string' && key.length === 1 && /\S/.test(key)) {
        var k = key.toLowerCase();
        for (var i = 1; i <= n; i++) {
            var j = ((cur < 0 ? -1 : cur) + i) % n;
            if (String(labels[j] || '').toLowerCase().charAt(0) === k) return j;
        }
    }
    return -1;
}
function sdocGroupByKey(e) {
    if (!e || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    var root = _sdocGroupByRoot();
    if (!root) return;
    var open = root.classList.contains('open'), onBtn = e.target && e.target.classList && e.target.classList.contains('sdoc-groupby-btn');
    var k = e.key;
    if (!open) {
        if (onBtn && (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ')) {
            e.preventDefault(); if (e.stopPropagation) e.stopPropagation();
            var m = SDOC_GROUP_MODES;
            sdocOpenGroupByMenu(k === 'ArrowUp' ? m[m.length - 1] : null);
        }
        return;
    }
    if (k === 'Escape' || k === 'Esc') {
        e.preventDefault(); if (e.stopPropagation) e.stopPropagation();
        sdocCloseGroupByMenu(true);
        return;
    }
    if (k === 'Tab') { sdocCloseGroupByMenu(false); return; }
    var opts = _sdocGroupByOptions(root), cur = opts.indexOf(e.target);
    if ((k === 'Enter' || k === ' ') && cur >= 0) {
        e.preventDefault(); if (e.stopPropagation) e.stopPropagation();
        sdocPickGroupBy(opts[cur].getAttribute('data-mode'));
        return;
    }
    var labels = opts.map(function(o) { var l = o.querySelector('.sdoc-groupby-option-label'); return l ? l.textContent : ''; });
    var next = sdocGroupByMenuIndex(k, cur, opts.length, labels);
    if (next < 0) return;
    e.preventDefault(); if (e.stopPropagation) e.stopPropagation();
    opts[next].focus();
}
// Puts the menu right before the Rows/Gallery toggle (once) and syncs it to the
// stored mode (button icon + name + aria-label, option aria-selected).
function _sdocSyncGroupBySelect(host) {
    if (typeof document === 'undefined') return;
    host = host || document.getElementById('documents-panel') || document;
    var bar = host.querySelector('.sdoc-page-toolbar');
    if (!bar) return;
    var root = bar.querySelector('.sdoc-groupby');
    if (!root) {
        var tog = bar.querySelector('.widget-library-layout');
        if (tog) tog.insertAdjacentHTML('beforebegin', _sdocGroupBySelectHtml());
        else bar.insertAdjacentHTML('beforeend', _sdocGroupBySelectHtml());
        return;
    }
    var cur = sdocGetGroupBy(), btn = root.querySelector('.sdoc-groupby-btn');
    if (btn && btn.getAttribute('data-current') !== cur) {
        btn.setAttribute('data-current', cur);
        btn.innerHTML = _sdocGroupByBtnInner(cur);
        var aria = _sdocGroupByAria(cur);
        btn.setAttribute('aria-label', aria);
        btn.setAttribute('title', aria + ' (G)');
    }
    _sdocGroupByOptions(root).forEach(function(o) {
        var on = o.getAttribute('data-mode') === cur;
        o.classList.toggle('selected', on);
        o.setAttribute('aria-selected', on ? 'true' : 'false');
    });
}
function sdocDayStart(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
// Weeks start on Monday (ISO 8601).
function sdocWeekStart(ts) { var d = new Date(sdocDayStart(ts)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function _sdocFmtDate(ts) { return typeof i18nFormatDate === 'function' ? i18nFormatDate(ts) : new Date(ts).toDateString(); }
function _sdocCmpName(a, b) { var x = String(a.name || '').toLowerCase(), y = String(b.name || '').toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
// Newest first, undated last, then by name.
function _sdocCmpDate(a, b) {
    var x = a.date || 0, y = b.date || 0;
    if (x !== y) return y - x;
    return _sdocCmpName(a, b);
}
// items: [{name, date (ms|0), folder (label), git: {repo, changed}|null, ...}].
// Returns [{key, label, items}]; alpha/date give one unlabeled group (label '').
function sdocGroupItems(items, mode, now) {
    mode = sdocNormalizeGroupBy(mode);
    now = now || Date.now();
    var list = (items || []).slice();
    if (mode === 'alpha') return [{ key: '', label: '', items: list.sort(_sdocCmpName) }];
    list.sort(_sdocCmpDate);
    if (mode === 'date') return [{ key: '', label: '', items: list }];
    var groups = {}, order = [];
    var today = sdocDayStart(now), week = sdocWeekStart(now);
    list.forEach(function(it) {
        var key, label, rank;
        if (mode === 'day' || mode === 'week') {
            if (!it.date) { key = 'undated'; label = _sdsT(N_('Undated')); rank = -Infinity; }
            else if (mode === 'day') {
                var d = sdocDayStart(it.date); key = 'd' + d; rank = d;
                label = d === today ? _sdsT(N_('Today')) : d === sdocDayStart(today - 1) ? _sdsT(N_('Yesterday')) : _sdocFmtDate(d);
            } else {
                var w = sdocWeekStart(it.date); key = 'w' + w; rank = w;
                label = w === week ? _sdsT(N_('This Week')) : w === sdocWeekStart(week - 1) ? _sdsT(N_('Last Week')) : _sdsT(N_('Week of {date}'), { date: _sdocFmtDate(w) });
            }
        } else if (mode === 'folder') {
            key = 'f:' + (it.folder || ''); label = it.folder || _sdsT(N_('Smart Documents')); rank = String(label).toLowerCase();
        } else { // git
            if (it.git) { key = 'g:' + it.git.repo + (it.git.changed ? ':1' : ':0'); label = it.git.repo + ' \u00B7 ' + (it.git.changed ? _sdsT(N_('Changed')) : _sdsT(N_('Unchanged'))); rank = String(it.git.repo).toLowerCase() + (it.git.changed ? '0' : '1'); }
            else { key = 'g:none'; label = _sdsT(N_('Not in a repository')); rank = '\uffff'; }
        }
        if (!groups[key]) { groups[key] = { key: key, label: label, rank: rank, items: [] }; order.push(groups[key]); }
        groups[key].items.push(it);
    });
    order.sort(function(a, b) {
        if (typeof a.rank === 'number') return b.rank - a.rank || 0; // newest bucket first, Undated (-Infinity) last
        return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
    });
    return order.map(function(g) { return { key: g.key, label: g.label, items: g.items }; });
}
// Import / Export / New Document belong to Smart Documents: shown on the Smart
// Documents view, or on All when Smart Documents are the only source.
function sdocHeaderActionsVisible(sel, hasFileSources) {
    return sel === 'sdocs' || (sel === 'all' && !hasFileSources);
}
function _sdocSyncHeaderActions() {
    if (typeof document === 'undefined') return;
    var el = document.getElementById('documents-header-actions');
    if (!el) return;
    el.hidden = !sdocHeaderActionsVisible(sdocSrcState.sel, !!(sdocSrcState.sources && sdocSrcState.sources.length));
}
// File search: case-insensitive on the name or the path (q is already lower-cased).
function sdocEntryMatches(entry, q) {
    if (!q) return true;
    return String((entry && entry.name) || '').toLowerCase().indexOf(q) !== -1 ||
        String((entry && entry.path) || '').toLowerCase().indexOf(q) !== -1;
}
// One list for the grouped renderer: smart docs (updatedAt) + file rows
// (entry.lastModified; workspace rows have no date -> Undated). idx indexes
// sdocSrcState.rendered, as buildDocumentsFileItem expects.
function sdocUnifiedItems(docs, rows) {
    var out = [];
    (docs || []).forEach(function(doc) { out.push({ kind: 'doc', doc: doc, name: doc.title || '', date: doc.updatedAt || 0, folder: '', git: null }); });
    (rows || []).forEach(function(r, i) {
        var e = r.entry || {}, src = r.src || {}, p = String(e.path || ''), cut = p.lastIndexOf('/');
        out.push({ kind: 'file', row: r, idx: i, name: e.name || '', date: e.lastModified || 0,
            folder: (src.label || '') + (cut > 0 ? ' / ' + p.slice(0, cut) : ''),
            git: src.type === 'ws' ? { repo: src.label || src.wk || '', changed: !!e.dirty } : null });
    });
    return out;
}
// Per-source search cap: the first `cap` matching entries plus how many were left out.
function sdocCapEntries(entries, q, cap) {
    var hits = [], total = 0;
    (entries || []).forEach(function(e) {
        if (!sdocEntryMatches(e, q)) return;
        total++;
        if (hits.length < cap) hits.push(e);
    });
    return { hits: hits, more: total - hits.length };
}
// Sources listed in the All view: GitHub workspaces only when searching or grouping by git.
function sdocAllViewSources(sources, q, mode) {
    return (sources || []).filter(function(s) { return !!q || mode === 'git' || s.type !== 'ws'; });
}
// Recursive listing when searching, or for a workspace in the All view grouped by git.
function sdocSrcRecursive(src, sel, q, mode) {
    return !!q || (sel === 'all' && mode === 'git' && !!src && src.type === 'ws');
}
function sdocGroupHeadHtml(g) {
    return '<div class="sdoc-group-head" role="heading" aria-level="3"><span class="sdoc-group-label">' + _sdsEsc(g.label) + '</span>' +
        '<span class="sdoc-group-count">' + _sdsEsc(String(g.items.length)) + '</span></div>';
}
// groups from sdocGroupItems; unlabeled groups (alpha/date) get no header.
function sdocGroupedHtml(groups, render) {
    return (groups || []).map(function(g) {
        var body = g.items.map(render).join('');
        return g.label ? sdocGroupHeadHtml(g) + body : body;
    }).join('');
}
function _sdocRenderUnified(it) {
    _sdocSelRegister(it);
    return it.kind === 'doc' ? buildDocumentsPageItem(it.doc) : buildDocumentsFileItem(it.row, it.idx);
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
    // Design C: a sources rail (nav#documents-sources) beside a pane holding the
    // title bar (#sdoc-pane-head) and the items. The rail/pane shell is built once.
    var shell = function(toolbarHtml) {
        return '<nav class="sdoc-rail" id="documents-sources" aria-label="' + escDisplay(t('Sources')) + '"></nav>' +
            '<div class="sdoc-pane" id="sdoc-pane">' + (toolbarHtml || '') +
                '<div class="sdoc-pane-head" id="sdoc-pane-head"></div>' +
                '<div class="widget-library-items page-list" id="documents-items"></div>' +
            '</div>';
    };
    if (slot && !document.getElementById('sdoc-pane')) {
        list.innerHTML = shell('');
    }
    if (!host.querySelector('.sdoc-page-toolbar')) {
        list.innerHTML = shell('<div class="widget-library-header sdoc-page-toolbar">' +
            '<label class="widget-library-search">' + UI_ICONS.search +
                '<input type="search" class="widget-library-search-input sdoc-page-search-input" placeholder="' + escDisplay(t('Search documents\u2026')) + '" aria-label="' + escDisplay(t('Search documents')) + '" oninput="sdocOnPageSearchInput(this.value)">' +
            '</label>' +
            '<span class="widget-library-count" id="documents-count"></span>' +
            '<div class="segmented-toggle widget-library-layout" role="group" aria-label="' + escDisplay(t('Layout')) + '">' +
                '<button type="button" class="widget-library-layout-btn" data-layout="rows" title="' + escDisplay(t('Rows')) + '" onclick="sdocSetPageLayout(\'rows\')">' + UI_ICONS.list + '<span>' + escDisplay(t('Rows')) + '</span></button>' +
                '<button type="button" class="widget-library-layout-btn" data-layout="gallery" title="' + escDisplay(t('Gallery')) + '" onclick="sdocSetPageLayout(\'gallery\')">' + SDOC_GRID_ICON + '<span>' + escDisplay(t('Gallery')) + '</span></button>' +
            '</div>' +
        '</div>');
    }
    list.classList.add('sdoc-rail-layout');
    sdocBindAgentFilesDrop(document.getElementById('documents-sources'));
    sdocBindAgentFilesDrop(document.getElementById('sdoc-pane'));
    _sdocBindAddOutside();
    sdocRenderSourcesStrip();
    if (sdocSrcState.sources === null) sdocRefreshSources();
    var layout = sdocGetPageLayout();
    list.classList.toggle('sdoc-page-gallery', layout === 'gallery');
    host.querySelectorAll('.widget-library-layout-btn').forEach(function(btn) {
        var on = btn.dataset.layout === layout;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    _sdocSyncGroupBySelect(host);
    var input = host.querySelector('.sdoc-page-search-input');
    if (input && input.value.trim().toLowerCase() !== sdocPageState.query) input.value = sdocPageState.query;
    renderDocumentsPageItems();
}

// Every render rebuilds the visible-selection list, then syncs Select all + the bulk bar.
function renderDocumentsPageItems() {
    sdocSelVisible.length = 0;
    try { return _sdocRenderPageItems(); } finally { sdocSyncBulkUi(); }
}
function _sdocRenderPageItems() {
    var items = document.getElementById('documents-items');
    if (!items) return;
    var layout = sdocGetPageLayout();
    items.className = 'widget-library-items page-list layout-' + layout;
    var q = sdocPageState.query;
    var all = sdocPageDocs();
    var docs = all.filter(function(doc) { return sdocPageMatches(doc, q); });
    docs.sort(function(a, b) { return b.updatedAt - a.updatedAt; });

    var count = document.getElementById('documents-count');
    var sel = sdocSrcState.sel;
    if (sel !== 'all' && sel !== 'sdocs') {
        sdocRenderFileSection(items, sel, q, [], '');
        // One source open: count its rows (files for a repo, items for a folder).
        if (count) {
            var nRows = (sdocSrcState.rendered || []).length, selSrc = sdocSrcById(sel);
            count.textContent = selSrc && selSrc.type === 'ws' ? tn(nRows, '{count} file', '{count} files') : tn(nRows, '{count} item', '{count} items');
        }
        return;
    }
    var hasFileSrc = sel === 'all' && !!(sdocSrcState.sources && sdocSrcState.sources.length);
    if (count) count.textContent = q ? t('{shown} of {total}', { shown: i18nFormatNumber(docs.length), total: i18nFormatNumber(all.length) }) : tn(all.length, '{count} document', '{count} documents');

    if (all.length === 0 && !hasFileSrc) {
        items.innerHTML = '<div class="widget-library-empty sdoc-page-empty">' + UI_ICONS.file +
            '<p class="sdoc-page-empty-title">' + escDisplay(t('No documents yet')) + '</p>' +
            '<p class="widget-library-empty-hint">' + escDisplay(t('Create a document or ask the agent to create one for you.')) + '</p>' +
            '<button class="skills-action-btn primary" onclick="sdocCreateFromPage()" style="margin-top:12px">' + UI_ICONS.plus + ' ' + escDisplay(t('New Document')) + '</button>' +
            '</div>';
        return;
    }
    if (docs.length === 0 && !hasFileSrc) {
        items.innerHTML = '<div class="widget-library-empty sdoc-page-empty">' + UI_ICONS.search +
            '<p class="sdoc-page-empty-title">' + escDisplay(t('No documents match \u201c{query}\u201d', { query: q })) + '</p>' +
            '<p class="widget-library-empty-hint">' + escDisplay(t('Search looks at document titles and content, plus file names and paths.')) + '</p>' +
            '</div>';
        return;
    }
    if (hasFileSrc) {
        var preHtml = '';
        if (all.length === 0 && !q) preHtml = '<div class="sdoc-src-note">' + escDisplay(t('No documents yet')) + ' <button type="button" class="widget-library-btn sdoc-src-btn" onclick="sdocCreateFromPage()">' + escDisplay(t('New Document')) + '</button></div>';
        sdocRenderFileSection(items, sel, q, docs, preHtml);
        return;
    }
    items.innerHTML = sdocGroupedHtml(sdocGroupItems(sdocUnifiedItems(docs, []), sdocGetGroupBy(), Date.now()), _sdocRenderUnified);
}

function buildDocumentsPageItem(doc) {
    var id = sdocJsArg(doc.id);
    var lastVer = doc.versions[doc.versions.length - 1];
    var authorIcon = lastVer ? (lastVer.author === 'user' ? '\u{1F464}' : '\u{1F916}') : '';
    var preview = sdocPagePreview(doc);
    var versionCount = doc.versions.length;
    var scope = doc.scope === 'chat' ? 'chat' : 'shared';
    var when = doc.updatedAt ? i18nFormatDateTime(doc.updatedAt) : '';

    var selKey = sdocSelKeyDoc(doc.id), picked = sdocSelection.has(selKey);
    var html = '<div class="widget-library-item sdoc-lib-item' + (picked ? ' is-selected' : '') + '" data-doc-id="' + escDisplay(doc.id) + '" data-sel-key="' + escDisplay(selKey) + '" role="button" tabindex="0"' +
        ' title="' + escDisplay(t('Open {title}', { title: doc.title })) + '" onclick="sdocOpenPreview(\'' + id + '\')" onkeydown="sdocPageItemKey(event, \'' + id + '\')">';
    html += _sdocSelCheckHtml(selKey, doc.title, picked);
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
    var lblExport = escDisplay(t('Export')), lblDelete = escDisplay(t('Delete')), srcChat = sdocDocSourceChatId(doc);
    html += '<div class="sdoc-lib-actions">';
    html += _sdocChatBtnsHtml(doc.title, 'sdocStartChat(\'' + id + '\')', srcChat ? 'sdocOpenSourceChat(\'' + sdocJsArg(srcChat) + '\')' : '');
    html += '<button type="button" class="widget-library-btn" onclick="event.stopPropagation(); sdocDownloadMd(\'' + id + '\')" title="' + lblExport + '" aria-label="' + lblExport + '">' + UI_ICONS.download + '</button>';
    html += '<button type="button" class="widget-library-btn danger" onclick="event.stopPropagation(); sdocDeleteFromPage(\'' + id + '\')" title="' + lblDelete + '" aria-label="' + lblDelete + '">' + UI_ICONS.trash + '</button>';
    html += '</div>';
    html += '</div>';
    return html;
}

// ─── Sources & folders (Documents page, Design E) ───
// One row of source cards (the only source selector: press a card to filter,
// press it again for All) + unified list of Smart Docs and files
// from connected folders (tools/170-local-folders.js: listLocalFolders,
// lfListDir, lfReadFileBytes, …) and GitHub workspaces cloned by the
// workspace tool (core/130-indexeddb.js getAllWorkspaceMetas /
// getWorkspaceFile). Every external helper is typeof-guarded: this file is
// also bundled into the service worker. Connected folders are managed only
// here (connect, access, re-grant, rename, disconnect; Agent Files upload and
// drag & drop). Older strings go through _sdsT; new ones use t('literal').
var SDOC_SRC_LIST_MAX = 200;   // top-level entries per folder listing
var SDOC_SRC_SEARCH_MAX = 500; // recursive entries indexed per source for search
var SDOC_SRC_HITS_MAX = 200;   // file rows shown per source (then a "+N more" note)
// gen bumps on every reset so a load started before a reset (page reopen,
// connect/disconnect) can never write stale sources/listings into the new cache.
// scrolledSel = the sel last scrolled into view (the strip re-renders often; scroll only on change).
var sdocSrcState = { sel: 'all', path: '', addAccess: 'read', addMode: 'folder', sources: null, loading: null, listings: {}, wsRows: {}, rendered: [], gen: 0, scrolledSel: null };
// Connect card, GitHub mode. repos = the /user/repos list (all pages), cached for one page
// open (openDocumentsView clears it); status = {text, kind, noToken, settings} shown under the inputs.
// errorKind = _sdocGhClassify kind of the list error; active = the combobox's highlighted
// option (full name); open = listbox shown (starts collapsed: typing / ArrowDown / ArrowUp /
// Alt+ArrowDown open it; Escape / blur / pick close it). gen bumps on every page open
// (sdocGhReset) so a /user/repos load started before a reopen never writes into the new session.
var sdocGhState = { repos: null, loading: null, error: null, errorKind: null, noToken: false, query: '', branch: '', busy: false, status: null, active: null, open: false, gen: 0 };
function sdocGhReset() {
    var g = sdocGhState;
    g.gen++; g.loading = null;
    g.repos = null; g.error = null; g.errorKind = null; g.noToken = false; g.active = null; g.open = false;
}
// Repo cards with a Refresh / Remove in flight (keyed by wk): a second click is a no-op.
var sdocWsBusy = new Set();

function _sdsT(s, p) { return typeof t === 'function' ? t(s, p) : s; }
function _sdsEsc(s) { return escDisplay(String(s == null ? '' : s)); }
function _sdsSize(n) {
    if (typeof formatFileSize === 'function') return formatFileSize(n || 0);
    n = n || 0;
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}
function sdocSrcById(id) {
    return (sdocSrcState.sources || []).find(function(s) { return s.id === id; }) || null;
}
// A write action is offered only on the built-in folder or a granted read & write folder.
function sdocSrcWritable(src) {
    return !!src && (src.type === 'virtual' || (src.type === 'local' && src.access === 'readwrite' && src.permission === 'granted'));
}

// Raw workspace_files rows of one clone (no blob hydration — names/flags only).
// withDeleted keeps rows deleted locally (dirty) so they can be listed with a 'deleted' badge.
async function _sdocWsRows(repo, withDeleted) {
    if (typeof openDatabase !== 'function' || typeof workspaceFilesStoreName === 'undefined') return [];
    var database = await openDatabase();
    var req = database.transaction([workspaceFilesStoreName], 'readonly').objectStore(workspaceFilesStoreName).index('repo').getAll(repo);
    var rows = await new Promise(function(resolve) { req.onsuccess = function() { resolve(req.result || []); }; req.onerror = function() { resolve([]); }; });
    return rows.filter(function(r) { return r && r.path && (!r.deleted || (withDeleted && r.dirty)); });
}

// Enumerate every source once per page open (openDocumentsView resets the cache).
async function sdocLoadSources() {
    var out = [], wsRows = {};
    if (typeof listLocalFolders === 'function') {
        try {
            (await listLocalFolders()).forEach(function(f) {
                out.push({ id: 'lf:' + f.id, type: f.kind === 'virtual' ? 'virtual' : 'local', folderId: f.id, label: f.label, name: f.name, access: f.access, permission: f.permission });
            });
        } catch (e) {}
    }
    if (typeof getAllWorkspaceMetas === 'function') {
        try {
            var metas = await getAllWorkspaceMetas();
            for (var i = 0; i < metas.length; i++) {
                var m = metas[i], rows = [];
                try { rows = await _sdocWsRows(m.repo, true); } catch (e) {}
                var ign = null;
                if (typeof wsGetIgnoreFilterLocal === 'function') { try { ign = await wsGetIgnoreFilterLocal(m.repo); } catch (e) {} }
                wsRows[m.repo] = rows;
                var live = rows.filter(function(r) { return !r.deleted; });
                var parts = String(m.repo).split('::');
                // info: the same status as the chat header workspace pill (branch, changed files, PR, pinned).
                out.push({ id: 'ws:' + m.repo, type: 'ws', wk: m.repo, label: parts[0], branch: m.branch || parts[1] || '', count: live.length,
                    dirty: live.filter(function(r) { return r.dirty && !(ign && ign(r.path)); }).length, info: sdocWsInfoSummary(m, rows, ign), prs: sdocWsPrFolders(m.prs), access: 'read', permission: 'granted' });
            }
        } catch (e) {}
    }
    out.wsRows = wsRows;
    return out;
}
function sdocRefreshSources() {
    if (sdocSrcState.loading) return sdocSrcState.loading;
    var gen = sdocSrcState.gen;
    var p = sdocLoadSources().then(function(list) {
        if (gen !== sdocSrcState.gen) return;
        sdocSrcState.wsRows = list.wsRows || {};
        delete list.wsRows;
        sdocSrcState.sources = list;
        if (sdocSrcState.sel !== 'all' && sdocSrcState.sel !== 'sdocs' && !sdocSrcById(sdocSrcState.sel)) { sdocSrcState.sel = 'all'; sdocSrcState.path = ''; }
    }).catch(function() { if (gen === sdocSrcState.gen) sdocSrcState.sources = []; }).then(function() {
        if (sdocSrcState.loading === p) sdocSrcState.loading = null;
        if (gen !== sdocSrcState.gen) return;
        sdocRenderSourcesStrip(); renderDocumentsPageItems();
    });
    sdocSrcState.loading = p;
    return p;
}
function sdocResetSources() { sdocPrCache.info = {}; sdocSrcState.gen++; sdocSrcState.scrolledSel = null; sdocSrcState.loading = null; sdocSrcState.sources = null; sdocSrcState.listings = {}; sdocSrcState.wsRows = {}; }

// Rail item press / narrow <select> change: select that source (no toggle-off; "All sources"
// is its own item) and persist it (restored once by openDocumentsView).
function sdocSelectSource(id) {
    // 'pr:<wk>#<n>' (rail / select / All-view PR folder) opens that workspace at '#pr/<n>'.
    var pr = sdocParsePrSrcId(id);
    sdocSrcState.sel = pr ? pr.wsId : (id || 'all');
    sdocSrcState.path = pr ? '#pr/' + pr.n : '';
    try { if (typeof appStorage !== 'undefined' && appStorage) appStorage.setItem('documentsPageSource', sdocSrcState.sel); } catch (e) {}
    sdocRenderSourcesStrip(); renderDocumentsPageItems();
}
function sdocSrcTopCount(src) {
    if (src.type === 'ws') return src.count;
    var l = sdocSrcState.listings[src.id + '#'];
    return l && l.entries ? l.entries.length + (l.truncated ? '+' : '') : '';
}
// Icons come from UI_ICONS (core/060) and are decorative: the label next to
// them (or an .sdoc-sr text) carries the name.
function _sdsIco(svg) { return '<span class="sdoc-src-ico" aria-hidden="true">' + (svg || '') + '</span>'; }
function _sdocSrcIcon(src) { return _sdsIco(src.type === 'ws' ? UI_ICONS.git : src.type === 'virtual' ? UI_ICONS.storage : UI_ICONS.folder); }
// innerHTML swap that keeps keyboard focus: the focused element's data-fk is
// looked up again in the new markup (a radio that lost its selection hands
// focus to the checked radio of the same group).
function _sdocSetHtmlKeepFocus(host, html) {
    var a = document.activeElement;
    // Unchanged markup and the host still holds the nodes we wrote: skip the
    // swap so hovered/focused nodes are not replaced (avoids hover flashing).
    if (host.__sdocHtml === html && host.firstElementChild && host.firstElementChild === host.__sdocFirst) return;
    var fk = a && a !== host && host.contains(a) && a.getAttribute ? a.getAttribute('data-fk') : null;
    host.innerHTML = html;
    host.__sdocHtml = html;
    host.__sdocFirst = host.firstElementChild;
    if (!fk) return;
    var els = host.querySelectorAll('[data-fk]');
    for (var i = 0; i < els.length; i++) {
        if (els[i].getAttribute('data-fk') !== fk) continue;
        var el = els[i];
        if (el.getAttribute('role') === 'radio' && el.getAttribute('aria-checked') !== 'true' && el.parentNode) el = el.parentNode.querySelector('[aria-checked="true"]') || el;
        try { el.focus(); } catch (e) {}
        return;
    }
}

// ─── Access picker (Read only / Read & write) ───
// Same component as Settings → Theme: .radio-group.radio-group-small +
// .radio-option (css/09-settings.css), roving tabindex, arrow keys through
// kbdRadioNextIndex (ui/320) like settingsPanelThemeKeydown (ui/240).
// opts: { folderId (null = the "Connect folder" card), access }.
function _sdocAccessRadioHtml(opts) {
    opts = opts || {};
    var cur = opts.access === 'readwrite' ? 'readwrite' : 'read', fk = 'acc:' + (opts.folderId || 'add');
    var choices = [
        { v: 'read', icon: UI_ICONS.lock, label: _sdsT('Read only'), tip: _sdsT('Read only: the agent can list and read files but not change them') },
        { v: 'readwrite', icon: UI_ICONS.edit, label: _sdsT('Read & write'), tip: _sdsT('Read & write: the agent can also create, edit and delete files') }
    ];
    var html = '<div class="radio-group radio-group-small sdoc-access-radio" role="radiogroup" aria-label="' + _sdsEsc(_sdsT('Access')) + '"' +
        ' data-folder-id="' + _sdsEsc(opts.folderId || '') + '" onclick="event.stopPropagation()" onkeydown="sdocSrcAccessKeydown(event)">';
    choices.forEach(function(c) {
        var on = c.v === cur;
        html += '<div class="radio-option' + (on ? ' selected' : '') + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '" data-value="' + c.v + '" data-fk="' + _sdsEsc(fk + ':' + c.v) + '"' +
            ' tabindex="' + (on ? '0' : '-1') + '" title="' + _sdsEsc(c.tip) + '" onclick="sdocSrcPickAccess(this)">' +
            '<span class="radio-option-icon" aria-hidden="true">' + c.icon + '</span><span>' + _sdsEsc(c.label) + '</span></div>';
    });
    return html + '</div>';
}
function _sdocRadioSelect(group, v) {
    Array.prototype.forEach.call(group.querySelectorAll('.radio-option'), function(o) {
        var on = o.getAttribute('data-value') === v;
        o.classList.toggle('selected', on);
        o.setAttribute('aria-checked', on ? 'true' : 'false');
        o.setAttribute('tabindex', on ? '0' : '-1');
    });
}
// Click / Enter / Space / arrow on one option. Runs synchronously inside the
// gesture so sdocSrcSetAccess can reach requestPermission with user activation.
function sdocSrcPickAccess(opt) {
    var group = opt && opt.closest ? opt.closest('.sdoc-access-radio') : null;
    if (!group) return null;
    var v = opt.getAttribute('data-value') === 'readwrite' ? 'readwrite' : 'read';
    var was = group.querySelector('.radio-option.selected');
    _sdocRadioSelect(group, v);
    var fid = group.getAttribute('data-folder-id');
    if (!fid) { sdocSrcState.addAccess = v; return null; } // "Connect folder" card: remembered across re-renders
    var src = sdocSrcById('lf:' + fid);
    if (was && was.getAttribute('data-value') === v && !(src && v === 'readwrite' && src.permission !== 'granted')) return null;
    return sdocSrcSetAccess(fid, v);
}
function sdocSrcAccessKeydown(e) { return _sdocRadioKeydown(e, sdocSrcPickAccess); }
// Shared roving-radio keys: Enter/Space pick, arrows (flipped in RTL) move + pick.
function _sdocRadioKeydown(e, pick) {
    if (!e || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var group = e.currentTarget;
    if (!group || !group.querySelectorAll) return;
    var opts = Array.prototype.slice.call(group.querySelectorAll('.radio-option'));
    var cur = opts.indexOf(e.target && e.target.closest ? e.target.closest('.radio-option') : null);
    if (cur < 0) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(opts[cur]); return; }
    if (typeof kbdRadioNextIndex !== 'function') return;
    var rtl = typeof i18nDir === 'function' && i18nDir() === 'rtl';
    var next = kbdRadioNextIndex(opts.length, cur, e.key, rtl);
    if (next < 0) return;
    e.preventDefault(); e.stopPropagation();
    opts[next].focus();
    pick(opts[next]);
}

// ─── Connect card: Local folder / GitHub repo ───
// Same segmented radio as the access picker; shown only when both kinds can be connected.
function _sdocConnModeRadioHtml(mode) {
    var choices = [
        { v: 'folder', icon: UI_ICONS.folder, label: t('Local folder') },
        { v: 'github', icon: UI_ICONS.git, label: t('GitHub repo') }
    ];
    var html = '<div class="radio-group radio-group-small sdoc-access-radio sdoc-conn-mode" role="radiogroup" aria-label="' + _sdsEsc(t('Document source')) + '"' +
        ' onclick="event.stopPropagation()" onkeydown="sdocSrcModeKeydown(event)">';
    choices.forEach(function(c) {
        var on = c.v === mode;
        html += '<div class="radio-option' + (on ? ' selected' : '') + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '" data-value="' + c.v + '" data-fk="mode:' + c.v + '"' +
            ' tabindex="' + (on ? '0' : '-1') + '" title="' + _sdsEsc(c.label) + '" onclick="sdocSrcPickMode(this)">' +
            '<span class="radio-option-icon" aria-hidden="true">' + c.icon + '</span><span>' + _sdsEsc(c.label) + '</span></div>';
    });
    return html + '</div>';
}
function sdocSrcPickMode(opt) {
    var v = opt && opt.getAttribute('data-value') === 'github' ? 'github' : 'folder';
    if (v === sdocSrcState.addMode) return null;
    sdocSrcState.addMode = v;
    sdocRenderSourcesStrip();
    return v === 'github' ? sdocGhLoadRepos() : null;
}
function sdocSrcModeKeydown(e) { return _sdocRadioKeydown(e, sdocSrcPickMode); }

// label (and aria) must already be translated: pass t('literal') so the extractor sees it.
// Same compact button as the Widget Library / file rows (.widget-library-btn, css/19b).
// busy: rendered disabled + aria-busy (an action in flight; _sdocSetBusyBtns toggles it live).
var _SDOC_BUSY_ATTR = ' disabled aria-busy="true"';
function _sdocSrcBtn(label, call, fk, cls, aria, icon, busy) {
    return '<button type="button" class="widget-library-btn sdoc-src-btn' + (cls ? ' ' + cls : '') + '"' + (fk ? ' data-fk="' + _sdsEsc(fk) + '"' : '') +
        (aria ? ' aria-label="' + _sdsEsc(aria) + '"' : '') + (busy ? _SDOC_BUSY_ATTR : '') + ' onclick="event.stopPropagation(); ' + call + '">' + (icon || '') + '<span>' + _sdsEsc(label) + '</span></button>';
}
// Icon-only variant: the translated label is the tooltip and the accessible name.
function _sdocSrcIconBtn(icon, label, call, fk, cls, busy) {
    var l = _sdsEsc(label);
    return '<button type="button" class="widget-library-btn sdoc-src-btn sdoc-src-icon-btn' + (cls ? ' ' + cls : '') + '"' + (fk ? ' data-fk="' + _sdsEsc(fk) + '"' : '') +
        ' title="' + l + '" aria-label="' + l + '"' + (busy ? _SDOC_BUSY_ATTR : '') + ' onclick="event.stopPropagation(); ' + call + '">' + icon + '</button>';
}
// Card meta line counts: "{count} documents" / "{count} files" / "{count} items" via tn();
// a truncated listing ("50+") keeps the plural of the number shown.
function _sdocCountText(cnt, one, other) {
    if (cnt === '' || cnt == null) return '';
    var s = String(cnt), plus = /\+$/.test(s), n = parseInt(s, 10);
    if (isNaN(n)) return '';
    return tn(n, one, other, plus ? { count: (typeof i18nFormatNumber === 'function' ? i18nFormatNumber(n) : String(n)) + '+' } : undefined);
}
// Design C rail: every source is one <button class="sdoc-rail-item"> (each a Tab
// stop; Up/Down/Home/End move between them, sdocRailKeydown). The selected one is
// aria-current; per-source actions live in the pane title bar (_sdocPaneHeadHtml).
var _SDOC_TILE_CLS = { all: 't-all', sdocs: 't-sdocs', virtual: 't-files', local: 't-local', ws: 't-gh', pr: 't-pr' };
function _sdocTileHtml(type, big) {
    var svg = type === 'pr' ? (UI_ICONS.gitMerge || UI_ICONS.git) : type === 'ws' ? UI_ICONS.git : type === 'virtual' ? UI_ICONS.storage : type === 'local' ? UI_ICONS.folder : type === 'sdocs' ? UI_ICONS.compose : UI_ICONS.list;
    return '<span class="sdoc-type-tile ' + (_SDOC_TILE_CLS[type] || 't-all') + (big ? ' sdoc-type-tile-lg' : '') + '" aria-hidden="true">' + (svg || '') + '</span>';
}
function _sdocFindSrc(id) {
    var s = sdocSrcState.sources || [];
    for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i];
    return null;
}
// Rail entries grouped for display: Built-in (Smart Docs, Agent Files), Local folders, GitHub.
function _sdocRailEntries() {
    var docsN = sdocPageDocs().length;
    var g = { builtin: [{ id: 'sdocs', type: 'sdocs', label: _sdsT('Smart Docs'), count: docsN, countText: tn(docsN, '{count} document', '{count} documents') }], local: [], ws: [] };
    (sdocSrcState.sources || []).forEach(function(s) {
        var cnt = sdocSrcTopCount(s), e = { id: s.id, type: s.type, label: s.label, title: s.wk || s.name || s.label, count: cnt };
        if (s.type === 'local' && s.permission !== 'granted') { e.warn = true; e.countText = _sdsT('Needs re-grant'); }
        else e.countText = s.type === 'ws' ? _sdocCountText(cnt, '{count} file', '{count} files') : _sdocCountText(cnt, '{count} item', '{count} items');
        if (s.type === 'ws' && s.info) { e.info = s.info; e.countText = [e.countText, sdocWsInfoText(s.info)].filter(Boolean).join(', '); }
        (s.type === 'local' ? g.local : s.type === 'ws' ? g.ws : g.builtin).push(e);
        // PRs are top-level siblings right after their workspace (open first, newest merged; capped).
        if (s.type === 'ws') (s.prs || []).forEach(function(p) {
            g.ws.push({ id: sdocPrSrcId(s, p.number), type: 'pr', wsId: s.id, pr: p.number, state: p.state || 'open', label: '#' + p.number + (p.title ? ' ' + p.title : ''),
                title: t('PR #{number}', { number: p.number }) + (p.title ? ' \u00B7 ' + p.title : ''), count: '', countText: _sdocPrStateLabel(p.state) });
        });
    });
    return g;
}
// Rail id of a workspace PR: 'pr:<wk>#<n>'; parsed back by sdocParsePrSrcId.
function sdocPrSrcId(src, n) { return 'pr:' + (src.wk || String(src.id || '').replace(/^ws:/, '')) + '#' + n; }
function sdocParsePrSrcId(id) { var m = /^pr:(.+)#(\d+)$/.exec(String(id || '')); return m ? { wsId: 'ws:' + m[1], n: parseInt(m[2], 10) } : null; }
// The rail entry that reads as selected: the PR entry while inside '#pr/<n>' of a workspace.
function _sdocRailSelId() {
    var sel = sdocSrcState.sel, n = sdocPrPathNumber(sdocSrcState.path), src = n ? sdocSrcById(sel) : null;
    return src && src.type === 'ws' ? sdocPrSrcId(src, n) : sel;
}
function _sdocRailItemHtml(e) {
    var on = _sdocRailSelId() === e.id, aria = e.countText ? e.label + ', ' + e.countText : e.label;
    var end = e.warn ? '<span class="sdoc-rail-count sdoc-src-warn" aria-hidden="true">' + (UI_ICONS.alert || '!') + '</span>'
        : (e.count !== '' && e.count != null ? '<span class="sdoc-rail-count" aria-hidden="true">' + _sdsEsc(String(e.count)) + '</span>' : '');
    return '<button type="button" class="sdoc-rail-item' + (e.type === 'pr' ? ' sdoc-rail-pr sdoc-rail-pr--' + _sdsEsc(e.state) : '') + (on ? ' active' : '') + (sdocUploadTarget(e.type === 'virtual' || e.type === 'local' ? (sdocSrcById(e.id) || e) : null) ? ' sdoc-src-drop' : '') + '"' +
        ' data-src-id="' + _sdsEsc(e.id) + '" data-fk="' + _sdsEsc('sel:' + e.id) + '"' + (on ? ' aria-current="true"' : '') +
        ' aria-label="' + _sdsEsc(aria) + '" title="' + _sdsEsc(e.title || e.label) + '" onclick="sdocSelectSource(\'' + sdocJsArg(e.id) + '\')">' +
        _sdocTileHtml(e.type) + (e.info ? '<span class="sdoc-rail-text"><span class="sdoc-rail-name">' + _sdsEsc(e.label) + '</span>' + sdocWsInfoHtml(e.info, true) + '</span>'
            : '<span class="sdoc-rail-name">' + _sdsEsc(e.label) + '</span>') + end + '</button>';
}

function sdocRenderSourcesStrip() {
    var host = document.getElementById('documents-sources');
    if (!host) { _sdocAddModalRender(); return; }
    var sel = sdocSrcState.sel, railSel = _sdocRailSelId(), g = _sdocRailEntries(), mode = _sdocConnMode(), open = !!(sdocSrcState.addOpen && mode);
    var groups = [['builtin', _sdsT('Built-in'), g.builtin], ['local', _sdsT('Local folders'), g.local], ['ws', _sdsT('GitHub'), g.ws]];
    var addLbl = _sdsT('Add source');
    var html = '<div class="sdoc-rail-head"><span class="sdoc-rail-title">' + _sdsEsc(_sdsT('Sources')) + '</span>' +
        (mode ? '<button type="button" class="sdoc-rail-add" data-fk="add" aria-haspopup="dialog" aria-controls="sdoc-add-pop" aria-expanded="' + (open ? 'true' : 'false') + '"' +
            ' title="' + _sdsEsc(addLbl) + '" aria-label="' + _sdsEsc(addLbl) + '" onclick="sdocAddToggle()">' + (UI_ICONS.plus || '+') + '</button>' : '') + '</div>';
    // Narrow panels (container < 560px) swap the item list for this select (CSS only).
    var allLbl = _sdsT('All sources');
    var opts = '<option value="all"' + (sel === 'all' ? ' selected' : '') + '>' + _sdsEsc(allLbl) + '</option>';
    groups.forEach(function(gr) {
        if (!gr[2].length) return;
        opts += '<optgroup label="' + _sdsEsc(gr[1]) + '">';
        gr[2].forEach(function(e) {
            // PR entries: indented under their workspace (non-breaking spaces survive <option> whitespace collapsing).
            var lbl = e.type === 'pr' ? '\u00A0\u00A0\u21B3 ' + e.title : e.label;
            opts += '<option value="' + _sdsEsc(e.id) + '"' + (e.type === 'pr' ? ' class="sdoc-rail-opt-pr"' : '') + (e.id === railSel ? ' selected' : '') + '>' + _sdsEsc(lbl) + '</option>';
        });
        opts += '</optgroup>';
    });
    html += '<select class="sdoc-rail-select" data-fk="rail:select" aria-label="' + _sdsEsc(_sdsT('Source')) + '" onchange="sdocSelectSource(this.value)">' + opts + '</select>';
    html += '<div class="sdoc-rail-groups" id="sdoc-rail-groups" onkeydown="sdocRailKeydown(event)">' +
        _sdocRailItemHtml({ id: 'all', type: 'all', label: allLbl, count: '' });
    groups.forEach(function(gr) {
        if (!gr[2].length) return;
        var gid = 'sdoc-rail-g-' + gr[0];
        html += '<div class="sdoc-rail-group" role="group" aria-labelledby="' + gid + '"><div class="sdoc-rail-label" id="' + gid + '">' + _sdsEsc(gr[1]) + '</div>';
        gr[2].forEach(function(e) { html += _sdocRailItemHtml(e); });
        html += '</div>';
    });
    if (sdocSrcState.sources === null) html += '<div class="sdoc-rail-loading" role="status">' + _sdsEsc(_sdsT('Loading\u2026')) + '</div>';
    html += '</div>';
    _sdocSetHtmlKeepFocus(host, html);
    _sdocAddModalRender();
    var selEl = host.querySelector('.sdoc-rail-select');
    if (selEl && selEl.options) { for (var i = 0; i < selEl.options.length; i++) if (selEl.options[i].value === railSel) { selEl.selectedIndex = i; break; } }
    var head = document.getElementById('sdoc-pane-head');
    if (head) _sdocSetHtmlKeepFocus(head, _sdocPaneHeadHtml(sel));
    var pane = document.getElementById('sdoc-pane');
    if (pane) {
        var dropOn = sel === 'lf:virtual' || !!sdocUploadTarget(sdocSrcById(sel), sel, sdocSrcState.path);
        pane.classList.toggle('sdoc-src-drop', dropOn);
        if (dropOn) pane.setAttribute('aria-dropeffect', 'copy'); else pane.removeAttribute('aria-dropeffect');
    }
    _sdocSyncHeaderActions();
    // Keep the selected item visible (e.g. a source picked from a search hit or the file list),
    // only when the selection changed: other re-renders must not yank a manually scrolled rail.
    if (sdocSrcState.scrolledSel === railSel) return;
    var act = host.querySelector('.sdoc-rail-item.active');
    if (!act) return; // not rendered yet (sources loading): try again on the next render
    sdocSrcState.scrolledSel = railSel;
    if (typeof act.scrollIntoView === 'function') { try { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
}

// Pane title bar: large tile, name, "<Type> · <count>" meta + access/branch badge, and the
// selected source's actions (fks kept from the old cards: upload:/regrant:/access:/ren:/disc:/wsref:/wsrm:).
function _sdocPaneBadge(icon, text, cls, tip) {
    return '<span class="sdoc-pane-badge' + (cls ? ' ' + cls : '') + '"' + (tip ? ' title="' + _sdsEsc(tip) + '"' : '') + '>' + _sdsIco(icon) + '<span>' + _sdsEsc(text) + '</span></span>';
}
function _sdocPaneHeadHtml(sel) {
    var type, title, meta = [], badge = '', acts = '';
    if (!sel || sel === 'all') { type = 'all'; title = _sdsT('All sources'); }
    else if (sel === 'sdocs') { type = 'sdocs'; title = _sdsT('Smart Docs'); meta = [_sdsEsc(_sdsT('Built-in')), _sdsEsc(tn(sdocPageDocs().length, '{count} document', '{count} documents'))]; }
    else {
        var src = _sdocFindSrc(sel);
        if (!src) return '<div class="sdoc-pane-id"><div class="sdoc-pane-info"><h2 class="sdoc-pane-title">' + _sdsEsc(_sdsT('Loading\u2026')) + '</h2></div></div>';
        var cnt = sdocSrcTopCount(src), id = src.id;
        type = src.type; title = src.label;
        if (type === 'local') {
            var fid = sdocJsArg(src.folderId), ro = src.access !== 'readwrite', granted = src.permission === 'granted';
            meta = [_sdsEsc(t('Local folder')), granted ? _sdsEsc(_sdocCountText(cnt, '{count} item', '{count} items'))
                : '<span class="sdoc-src-warn">' + _sdsIco(UI_ICONS.alert) + '<span>' + _sdsEsc(_sdsT('Needs re-grant')) + '</span></span>'];
            badge = ro ? _sdocPaneBadge(UI_ICONS.lock, _sdsT('Read only')) : _sdocPaneBadge(UI_ICONS.edit, _sdsT('Read & write'));
            // sdocSrcSetAccess starts synchronously in the click (the permission prompt needs the gesture).
            // Upload (read & write only): reuses the Agent Files input; a not-granted folder prompts in the click.
            acts = (ro ? '' : _sdocSrcBtn(t('Upload'), 'sdocFolderPickUpload(\'' + sdocJsArg(id) + '\')', 'upload:' + id, '', t('Upload files to {folder}', { folder: title }), UI_ICONS.upload)) +
                (granted ? '' : _sdocSrcBtn(t('Re-grant'), 'sdocSrcRegrant(\'' + fid + '\')', 'regrant:' + id)) +
                _sdocSrcBtn(ro ? t('Allow writing') : t('Make read only'), 'sdocSrcSetAccess(\'' + fid + '\',\'' + (ro ? 'readwrite' : 'read') + '\')', 'access:' + id) +
                _sdocSrcIconBtn(UI_ICONS.edit, t('Rename {folder}', { folder: title }), 'sdocSrcRename(\'' + fid + '\')', 'ren:' + id) +
                _sdocSrcIconBtn(UI_ICONS.trash, _sdsT('Disconnect {folder}', { folder: title }), 'sdocSrcDisconnect(\'' + fid + '\')', 'disc:' + id, 'danger');
        } else if (type === 'virtual') {
            meta = [_sdsEsc(_sdsT('Built-in')), _sdsEsc(_sdocCountText(cnt, '{count} item', '{count} items'))];
            badge = _sdocPaneBadge(UI_ICONS.edit, _sdsT('Read & write'));
            acts = _sdocSrcBtn(t('Upload'), 'sdocAgentFilesPickUpload()', 'upload:' + id, '', t('Upload files to Agent Files'), UI_ICONS.upload);
        } else {
            var wkArg = sdocJsArg(src.wk), busy = sdocWsBusy.has(src.wk), lbl = src.label + ' \u00B7 ' + src.branch;
            meta = [_sdsEsc(t('GitHub repo')), _sdsEsc(_sdocCountText(cnt, '{count} file', '{count} files')),
                src.dirty ? '<span class="sdoc-src-dirty">' + _sdsEsc(_sdsT('{count} dirty', { count: src.dirty })) + '</span>' : ''];
            badge = _sdocPaneBadge(UI_ICONS.gitBranch, src.branch, 'sdoc-src-branch', _sdsT('Branch'));
            acts = _sdocSrcBtn(t('Sync'), 'sdocWsRefresh(\'' + wkArg + '\')', 'wsref:' + id, '', t('Refresh {repo}', { repo: lbl }), UI_ICONS.refresh, busy) +
                _sdocSrcIconBtn(UI_ICONS.trash, t('Remove clone'), 'sdocWsRemove(\'' + wkArg + '\')', 'wsrm:' + id, 'danger', busy);
        }
    }
    meta = meta.filter(Boolean);
    return '<div class="sdoc-pane-id">' + _sdocTileHtml(type, true) +
            '<div class="sdoc-pane-info"><h2 class="sdoc-pane-title" title="' + _sdsEsc(title) + '">' + _sdsEsc(title) + '</h2>' +
            (meta.length || badge ? '<div class="sdoc-pane-meta">' + meta.map(function(m) { return '<span>' + m + '</span>'; }).join('<span aria-hidden="true">\u00B7</span>') + badge + '</div>' : '') +
        '</div></div>' + (acts ? '<div class="sdoc-pane-acts">' + acts + '</div>' : '');
}

// "Add source" modal opened by the rail's + button (#sdoc-add-modal on <body>): one card per
// source type, then the Local folder / GitHub repo switch (when both are available) with the
// folder access picker or the repo picker.
// Effective mode ('' when neither kind can be connected).
function _sdocConnMode() {
    var canFolder = typeof pickLocalFolder === 'function', canGh = typeof wsClone === 'function';
    if (!canFolder && !canGh) return '';
    return !canFolder ? 'github' : !canGh ? 'folder' : sdocSrcState.addMode === 'github' ? 'github' : 'folder';
}
// Source-type cards: icon, title, one-line description, "N connected" status and a primary button.
function _sdocAddCardList(mode) {
    var nRead = 0, nRw = 0, nWs = 0, files = null;
    (sdocSrcState.sources || []).forEach(function(s) {
        if (s.type === 'local') { if (s.access === 'readwrite') nRw++; else nRead++; }
        else if (s.type === 'ws') nWs++;
        else if (s.type === 'virtual') files = s;
    });
    var cards = [], busy = !!sdocSrcState.addBusy;
    if (typeof pickLocalFolder === 'function') {
        cards.push({ k: 'read', tile: 'local', icon: UI_ICONS.lock, title: t('Read-only folder'), desc: t('The agent can list and read files in a folder on this computer.'), n: nRead, btn: t('Choose folder\u2026'), busy: busy, active: mode === 'folder' && sdocSrcState.addAccess !== 'readwrite' });
        cards.push({ k: 'readwrite', tile: 'local', icon: UI_ICONS.edit, title: t('Read & write folder'), desc: t('The agent can also create, edit and delete files in the folder.'), n: nRw, btn: t('Choose folder\u2026'), busy: busy, active: mode === 'folder' && sdocSrcState.addAccess === 'readwrite' });
    }
    if (typeof wsClone === 'function') {
        cards.push({ k: 'github', tile: 'ws', icon: UI_ICONS.gitBranch, title: t('GitHub repository'), desc: t('Clone a repository so the agent can browse and edit its files.'), n: nWs, btn: t('Choose repo'), busy: !!(typeof sdocGhState !== 'undefined' && sdocGhState && sdocGhState.busy), active: mode === 'github' });
    }
    // Title = the source's own label, same as the rail item ("Agent Files").
    if (files) cards.push({ k: 'files', tile: 'virtual', icon: UI_ICONS.storage, title: files.label, desc: t('Built-in storage for uploads and files the agent creates.'), connected: true, btn: t('Open') });
    return cards;
}
function _sdocAddCardHtml(c) {
    var id = 'sdoc-add-card-' + c.k, status = c.connected ? t('Connected') : c.n ? tn(c.n, '{count} connected', '{count} connected') : '';
    var btnLbl = c.busy ? t('Connecting\u2026') : c.btn;
    return '<li class="sdoc-add-card' + (c.active ? ' is-active' : '') + (status ? ' is-connected' : '') + '" data-card="' + c.k + '">' +
        '<div class="sdoc-add-card-head">' + _sdocTileHtml(c.tile, true) +
            '<div class="sdoc-add-card-text"><h3 class="sdoc-add-card-title" id="' + id + '-t">' + _sdsIco(c.icon) + '<span>' + _sdsEsc(c.title) + '</span></h3>' +
            '<p class="sdoc-add-card-desc" id="' + id + '-d">' + _sdsEsc(c.desc) + '</p></div></div>' +
        '<div class="sdoc-add-card-foot">' + (status ? '<span class="sdoc-add-card-status">' + _sdsIco(UI_ICONS.check) + '<span>' + _sdsEsc(status) + '</span></span>' : '<span></span>') +
            '<button type="button" class="widget-library-btn sdoc-src-btn sdoc-src-btn-primary sdoc-add-card-btn" data-fk="card:' + c.k + '"' +
            ' aria-labelledby="' + id + '-b ' + id + '-t" aria-describedby="' + id + '-d"' + (c.busy ? _SDOC_BUSY_ATTR : '') +
            ' onclick="event.stopPropagation(); sdocAddPickCard(\'' + c.k + '\')"><span id="' + id + '-b">' + _sdsEsc(btnLbl) + '</span></button></div></li>';
}
function _sdocAddPopHtml(mode) {
    var modeHtml = typeof pickLocalFolder === 'function' && typeof wsClone === 'function' ? _sdocConnModeRadioHtml(mode) : '';
    var cancel = _sdocSrcBtn(t('Cancel'), 'sdocAddClose(true)', 'add:cancel');
    var body;
    if (mode === 'folder') {
        body = '<div class="sdoc-add-label">' + _sdsEsc(_sdsT('Access')) + '</div>' +
            _sdocAccessRadioHtml({ folderId: null, access: sdocSrcState.addAccess }) +
            '<p class="sdoc-add-hint">' + _sdsEsc(_sdsT("You'll choose the folder in the next step.")) + '</p>' +
            '<div class="sdoc-add-foot">' + cancel + _sdocSrcBtn(t('Choose folder\u2026'), 'sdocSrcConnect()', 'connect', 'sdoc-src-btn-primary') + '</div>';
    } else {
        // No fetch here: sdocAddToggle / sdocSrcPickMode / the input's focus / Retry start it.
        var g = sdocGhState, c = _sdocGhCombo(), hint = _sdocGhHintHtml();
        // Combobox with list autocomplete (WAI-ARIA APG): focus stays in the input,
        // the highlighted option is aria-activedescendant (sdocGhRepoKeydown). The listbox and its
        // options swallow mousedown so a press on an option, the scrollbar or padding never blurs the input.
        // The listbox and the transient hint share an overlay popup anchored under the input (.sdoc-gh-combo).
        body = '<div class="sdoc-gh-combo">' +
        '<input type="search" role="combobox" class="sdoc-gh-input sdoc-gh-repo" data-fk="gh:repo" autocomplete="off" spellcheck="false" placeholder="owner/repo"' +
            ' aria-label="' + _sdsEsc(t('Repository (owner/repo)')) + '" aria-autocomplete="list" aria-controls="sdoc-gh-list" aria-expanded="' + (c.expanded ? 'true' : 'false') + '"' +
            (c.activeId ? ' aria-activedescendant="' + _sdsEsc(c.activeId) + '"' : '') + ' value="' + _sdsEsc(g.query) + '"' +
            ' oninput="sdocGhInput(this)" onfocus="sdocGhLoadRepos()" onblur="sdocGhRepoBlur()" onkeydown="sdocGhRepoKeydown(event)">' +
        '<div class="sdoc-gh-pop" id="sdoc-gh-pop" onmousedown="event.preventDefault()"' + (_sdocGhPopOpen(c, hint) ? '' : ' hidden') + '>' +
            '<div class="sdoc-gh-list" id="sdoc-gh-list" role="listbox" aria-label="' + _sdsEsc(t('Your repositories')) + '" onmousedown="event.preventDefault()"' + (c.expanded ? '' : ' hidden') + '>' + c.html + '</div>' +
            '<div class="sdoc-gh-hint" id="sdoc-gh-hint">' + hint + '</div></div>' +
            '</div>' +
        _sdocGhNoteBoxHtml() +
        '<input type="text" class="sdoc-gh-input sdoc-gh-branch" data-fk="gh:branch" autocomplete="off" spellcheck="false"' +
            ' placeholder="' + _sdsEsc(t('Branch (optional)')) + '" aria-label="' + _sdsEsc(t('Branch (optional)')) + '" value="' + _sdsEsc(g.branch) + '"' +
            ' oninput="sdocGhBranchInput(this)" onkeydown="sdocGhKeydown(event)">' +
        '<div class="sdoc-gh-status" id="sdoc-gh-status" role="status" aria-live="polite">' + _sdocGhStatusHtml() + '</div>' +
            '<div class="sdoc-add-foot">' + cancel + _sdocSrcBtn(t('Clone repo'), 'sdocSrcConnectRepo()', 'connect-gh', 'sdoc-src-btn-primary', '', '', g.busy) + '</div>';
    }
    var err = sdocSrcState.addErr ? '<div class="sdoc-add-err" role="alert">' + _sdsIco(UI_ICONS.alert) + '<span>' + _sdsEsc(sdocSrcState.addErr) + '</span></div>' : '';
    var closeLbl = _sdsEsc(t('Close'));
    return '<div class="modal-dialog sdoc-add-dialog" id="sdoc-add-pop" role="dialog" aria-modal="true" aria-labelledby="sdoc-add-title" aria-describedby="sdoc-add-sub"' +
        (sdocSrcState.addBusy ? ' aria-busy="true"' : '') + ' onkeydown="sdocAddKeydown(event)">' +
        '<div class="modal-header sdoc-add-head"><div class="sdoc-add-head-text"><h2 class="sdoc-add-title" id="sdoc-add-title">' + _sdsEsc(t('Add source')) + '</h2>' +
            '<p class="sdoc-add-sub" id="sdoc-add-sub">' + _sdsEsc(t('Connect a folder or a repository as a document source.')) + '</p></div>' +
            '<button type="button" class="sdoc-add-x" data-fk="add:x" title="' + closeLbl + '" aria-label="' + closeLbl + '" onclick="event.stopPropagation(); sdocAddClose(true)">' + (UI_ICONS.close || '\u00D7') + '</button></div>' +
        '<div class="modal-body sdoc-add-body">' + err +
            '<ul class="sdoc-add-cards" aria-label="' + _sdsEsc(t('Source types')) + '">' + _sdocAddCardList(mode).map(_sdocAddCardHtml).join('') + '</ul>' +
            '<section class="sdoc-add-details" aria-labelledby="sdoc-add-opts"><h3 class="sdoc-add-label" id="sdoc-add-opts">' + _sdsEsc(t('Options')) + '</h3>' + modeHtml + body + '</section>' +
        '</div></div>';
}
// Mounts / refreshes / removes the modal on <body> from sdocSrcState.addOpen (every strip re-render
// calls this, so the existing refresh paths keep the modal in sync). DOM-only: no-op in the service worker.
function _sdocAddModalRender() {
    if (typeof document === 'undefined' || !document.body) return null;
    var ov = document.getElementById('sdoc-add-modal'), mode = _sdocConnMode();
    if (!sdocSrcState.addOpen || !mode || !document.getElementById('documents-sources')) { if (ov) ov.remove(); return null; }
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'sdoc-add-modal';
        ov.className = 'modal-overlay show sdoc-add-modal';
        ov.setAttribute('data-kbd-self-focus', '');
        // Backdrop click closes; the global Esc ladder (core/120-init) replays this onclick too.
        ov.onclick = function(e) { if (e && e.target === ov) sdocAddClose(true); };
        document.body.appendChild(ov);
    }
    _sdocSetHtmlKeepFocus(ov, _sdocAddPopHtml(mode));
    return ov;
}
// Focus trap (pure): n focusables, cur = index of the focused one (-1 = outside), shift = Shift+Tab.
// Returns the index to focus, or -1 to let the browser move focus normally.
function sdocFocusTrapIndex(n, cur, shift) {
    if (!(n > 0)) return -1;
    if (cur < 0 || cur >= n) return shift ? n - 1 : 0;
    if (shift && cur === 0) return n - 1;
    if (!shift && cur === n - 1) return 0;
    return -1;
}
function _sdocAddFocusables(root) {
    if (!root || !root.querySelectorAll) return [];
    return Array.prototype.filter.call(root.querySelectorAll('button, input, select, textarea, [tabindex]'), function(el) {
        return !el.disabled && el.getAttribute('tabindex') !== '-1' && !(el.closest && el.closest('[hidden]'));
    });
}
// Card buttons: folder cards open the folder picker right away (synchronously, inside the gesture);
// GitHub switches the options to the repo picker; Agent Files selects the built-in source.
function sdocAddPickCard(kind) {
    if (kind === 'files') { sdocAddClose(false); return sdocSelectSource('lf:virtual'); }
    if (kind === 'github') {
        if (sdocSrcState.addMode !== 'github') { sdocSrcState.addMode = 'github'; sdocRenderSourcesStrip(); }
        var inp = typeof document !== 'undefined' ? document.querySelector('#sdoc-add-pop .sdoc-gh-repo') : null;
        if (inp && typeof inp.focus === 'function') inp.focus();
        return sdocGhLoadRepos();
    }
    sdocSrcState.addMode = 'folder';
    sdocSrcState.addAccess = kind === 'readwrite' ? 'readwrite' : 'read';
    return sdocSrcConnect();
}
function sdocAddToggle() {
    if (sdocSrcState.addOpen) return sdocAddClose(true);
    sdocSrcState.addOpen = true; sdocSrcState.addErr = '';
    sdocRenderSourcesStrip();
    var pop = document.getElementById('sdoc-add-pop');
    // Initial focus: the first card button, else the first control (document order).
    var f = pop && (pop.querySelector('.sdoc-add-card-btn:not([disabled])') || _sdocAddFocusables(pop)[0]);
    if (f && typeof f.focus === 'function') f.focus();
    return _sdocConnMode() === 'github' ? sdocGhLoadRepos() : null;
}
function sdocAddClose(restoreFocus) {
    if (!sdocSrcState.addOpen) return null;
    sdocSrcState.addOpen = false; sdocSrcState.addErr = '';
    sdocRenderSourcesStrip();
    _sdocAddModalRender(); // removes the overlay even when the strip host is gone
    if (restoreFocus) { var b = document.querySelector('.sdoc-rail-add'); if (b && typeof b.focus === 'function') b.focus(); }
    return null;
}
// The repo combobox consumes its own Escape (preventDefault + stopPropagation) to close its list first.
// Tab / Shift+Tab wrap inside the dialog (sdocFocusTrapIndex).
function sdocAddKeydown(e) {
    if (!e || e.defaultPrevented) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); sdocAddClose(true); return; }
    if (e.key !== 'Tab' || typeof document === 'undefined') return;
    var els = _sdocAddFocusables(document.getElementById('sdoc-add-pop'));
    var i = sdocFocusTrapIndex(els.length, els.indexOf(document.activeElement), !!e.shiftKey);
    if (i < 0) return;
    e.preventDefault();
    if (typeof els[i].focus === 'function') els[i].focus();
}
var _sdocAddOutsideBound = false;
function _sdocBindAddOutside() {
    if (_sdocAddOutsideBound || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    _sdocAddOutsideBound = true;
    document.addEventListener('mousedown', function(e) {
        if (!sdocSrcState.addOpen) return;
        var tg = e.target;
        // The modal handles its own backdrop click (_sdocAddModalRender).
        if (tg && typeof tg.closest === 'function' && (tg.closest('#sdoc-add-modal') || tg.closest('#sdoc-add-pop') || tg.closest('.sdoc-rail-add'))) return;
        sdocAddClose(false);
    });
}
// A link-styled button to Settings > GitHub ("Add a GitHub token in Settings" / "Open settings").
function _sdocGhSettingsLinkHtml(label) {
    return '<button type="button" class="sdoc-gh-link" data-fk="gh:settings" onclick="event.stopPropagation(); sdocGhOpenSettings()">' +
        _sdsIco(UI_ICONS.settings) + '<span>' + _sdsEsc(label) + '</span></button>';
}
function _sdocGhTokenLinkHtml() { return _sdocGhSettingsLinkHtml(t('Add a GitHub token in Settings')); }
function sdocGhOpenSettings() {
    if (typeof openSettingsPageView === 'function') openSettingsPageView('github-settings-container');
}
var SDOC_GH_LIST_MAX = 50;
var SDOC_GH_MAX_PAGES = 10; // /user/repos pages of 100 (1000 repos) per page open
function _sdocGhFiltered() {
    var q = String(sdocGhState.query || '').trim().toLowerCase();
    return (sdocGhState.repos || []).filter(function(r) { return !q || r.full.toLowerCase().indexOf(q) !== -1; });
}
// Stable, id-safe option id per repo (aria-activedescendant target).
function _sdocGhOptId(full) {
    return 'sdoc-gh-opt-' + String(full).replace(/[^A-Za-z0-9-]/g, function(ch) { return '_' + ch.charCodeAt(0).toString(16) + '_'; });
}
// Listbox model: shown options, their markup, expanded state and the active option id.
function _sdocGhCombo() {
    var g = sdocGhState, q = String(g.query || '').trim();
    var opts = g.noToken || g.error || !g.repos ? [] : _sdocGhFiltered().slice(0, SDOC_GH_LIST_MAX);
    if (g.active && !opts.some(function(r) { return r.full === g.active; })) g.active = null;
    var expanded = !!(g.open && opts.length);
    var html = opts.map(function(r) {
        var act = expanded && r.full === g.active, sel = r.full === q, pl = t('Private repository');
        return '<div role="option" id="' + _sdsEsc(_sdocGhOptId(r.full)) + '" class="sdoc-gh-opt' + (act ? ' active' : '') + (sel ? ' selected' : '') + '" aria-selected="' + (act ? 'true' : 'false') + '" tabindex="-1"' +
            ' data-full="' + _sdsEsc(r.full) + '" title="' + _sdsEsc(r.desc || r.full) + '" onmousedown="event.preventDefault()" onclick="event.stopPropagation(); sdocGhPick(this)">' +
            '<span class="sdoc-gh-opt-name">' + _sdsEsc(r.full) + '</span>' +
            (r.priv ? '<span class="sdoc-gh-opt-priv" title="' + _sdsEsc(pl) + '">' + _sdsIco(UI_ICONS.lock) + '<span class="sdoc-sr">' + _sdsEsc(pl) + '</span></span>' : '') +
            '</div>';
    }).join('');
    return { opts: opts, html: html, expanded: expanded, activeId: expanded && g.active ? _sdocGhOptId(g.active) : '' };
}
// Actionable messages in the card (never inside the listbox): no token, error + Retry.
function _sdocGhNoteHtml() {
    var g = sdocGhState;
    if (g.noToken) return _sdocGhTokenLinkHtml();
    if (g.error) {
        return '<div class="sdoc-src-warn" role="alert">' + _sdsEsc(g.error) + '</div><div class="sdoc-gh-note-acts">' +
            (g.errorKind === 'token' || g.errorKind === 'perm' ? _sdocGhSettingsLinkHtml(t('Open settings')) : '') +
            _sdocSrcBtn(t('Retry'), 'sdocGhRetry()', 'gh:retry', '', null, UI_ICONS.refresh) + '</div>';
    }
    return '';
}
// The note box takes no room in the card while empty: rendered [hidden] (and :empty in 29b),
// toggled with its content by _sdocGhSetNote on partial updates.
function _sdocGhNoteBoxHtml() {
    var html = _sdocGhNoteHtml();
    return '<div class="sdoc-gh-note" id="sdoc-gh-note"' + (html ? '' : ' hidden') + '>' + html + '</div>';
}
function _sdocGhSetNote(el) {
    if (!el) return;
    var html = _sdocGhNoteHtml();
    _sdocGhSetHtml(el, html);
    el.hidden = !html;
}
// Transient hint in the popup, under the input while it is open: loading, empty.
function _sdocGhHintHtml() {
    var g = sdocGhState;
    if (g.noToken || g.error || !g.open) return '';
    if (!g.repos) return '<span role="status">' + _sdsEsc(t('Loading your repositories\u2026')) + '</span>';
    var q = String(g.query || '').trim();
    if (_sdocGhFiltered().length) return '';
    return _sdsEsc(/^[^\s\/]+\/[^\s\/]+$/.test(q) ? t('Not in your list. Click Connect to clone {repo} anyway.', { repo: q }) : t('No matching repositories'));
}
function _sdocGhStatusHtml() {
    var s = sdocGhState.status;
    if (!s) return '';
    if (s.noToken) return _sdocGhTokenLinkHtml();
    return '<span class="sdoc-gh-msg' + (s.kind === 'error' ? ' sdoc-src-warn' : '') + '">' + _sdsEsc(s.text) + '</span>' +
        (s.settings ? ' ' + _sdocGhSettingsLinkHtml(t('Open settings')) : '');
}
// Partial updates (typing must not rebuild the card: it would drop the caret).
// Unchanged markup is not re-set, so an error alert is not re-announced per keystroke.
function _sdocGhSetHtml(el, html) { if (el && el._sdocHtml !== html) { el.innerHTML = html; el._sdocHtml = html; } }
function _sdocGhRefreshList() {
    var c = _sdocGhCombo(), hint = _sdocGhHintHtml(), list = document.getElementById('sdoc-gh-list'), inp = document.querySelector('.sdoc-gh-repo');
    var pop = document.getElementById('sdoc-gh-pop');
    if (list) { _sdocGhSetHtml(list, c.html); list.hidden = !c.expanded; }
    _sdocGhSetHtml(document.getElementById('sdoc-gh-hint'), hint);
    _sdocGhSetNote(document.getElementById('sdoc-gh-note'));
    if (pop) pop.hidden = !_sdocGhPopOpen(c, hint);
    if (inp) {
        inp.setAttribute('aria-expanded', c.expanded ? 'true' : 'false');
        if (c.activeId) inp.setAttribute('aria-activedescendant', c.activeId); else inp.removeAttribute('aria-activedescendant');
    }
    return c;
}
function _sdocGhPopOpen(c, hint) { return !!(sdocGhState.open && (c.expanded || hint)); }
// The popup overlays the add-source popover under the repo input: .sdoc-gh-combo is
// position:relative and the popup is top:100% / inset-inline:0 (pure CSS, no placement code).

function _sdocGhSetStatus(s) {
    sdocGhState.status = s || null;
    var el = document.getElementById('sdoc-gh-status');
    if (el) el.innerHTML = _sdocGhStatusHtml();
}
function sdocGhInput(el) {
    var g = sdocGhState;
    g.query = el ? el.value : ''; g.open = true; g.active = null;
    if (g.status && g.status.kind === 'error') _sdocGhSetStatus(null);
    _sdocGhRefreshList();
}
function sdocGhBranchInput(el) { sdocGhState.branch = el ? el.value : ''; }
// Blur collapses the listbox, deferred: a re-render that restores focus to the
// (new) input, or a pick (options keep focus via mousedown preventDefault), keeps it.
function sdocGhRepoBlur() {
    setTimeout(function() {
        var g = sdocGhState, inp = document.querySelector('.sdoc-gh-repo');
        if (!g.open || (inp && document.activeElement === inp)) return;
        g.open = false; g.active = null;
        _sdocGhRefreshList();
    }, 0);
}
function sdocGhPick(opt) {
    var full = opt && opt.getAttribute('data-full');
    if (full) _sdocGhPickFull(full);
}
// Picking fills the input, closes the listbox and moves on to the branch.
function _sdocGhPickFull(full) {
    var g = sdocGhState;
    g.query = full; g.active = null; g.open = false;
    var inp = document.querySelector('.sdoc-gh-repo');
    if (inp) inp.value = full;
    _sdocGhSetStatus(null);
    _sdocGhRefreshList();
    var b = document.querySelector('.sdoc-gh-branch');
    if (b) { try { b.focus(); } catch (e) {} }
}
// Repo combobox keys: ArrowDown/Up open + move the highlight, Home/End jump
// (only while an option is highlighted; otherwise they move the caret), Enter
// picks the highlighted option or connects, Escape closes the list, else clears.
function sdocGhRepoKeydown(e) {
    if (!e || e.defaultPrevented || e.ctrlKey || e.metaKey) return;
    var g = sdocGhState, k = e.key, c = _sdocGhCombo(), opts = c.opts;
    // Alt+ArrowDown opens the list without highlighting; Alt+ArrowUp closes it.
    if (e.altKey) {
        if (k === 'ArrowDown' && !c.expanded && opts.length) g.open = true;
        else if (k === 'ArrowUp' && c.expanded) { g.open = false; g.active = null; }
        else return;
        e.preventDefault(); e.stopPropagation();
        _sdocGhRefreshList();
        return null;
    }
    var i = c.expanded && g.active ? opts.map(function(r) { return r.full; }).indexOf(g.active) : -1, next = -1;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
        if (!opts.length) return;
        var down = k === 'ArrowDown';
        next = i < 0 ? (down ? 0 : opts.length - 1) : Math.max(0, Math.min(opts.length - 1, i + (down ? 1 : -1)));
    } else if ((k === 'Home' || k === 'End') && i >= 0 && !e.shiftKey) {
        next = k === 'Home' ? 0 : opts.length - 1;
    } else if (k === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (i >= 0) { _sdocGhPickFull(opts[i].full); return null; }
        return sdocSrcConnectRepo();
    } else if (k === 'Escape') {
        if (c.expanded || _sdocGhPopOpen(c, _sdocGhHintHtml())) { g.open = false; g.active = null; }
        else if (e.target && e.target.value) { e.target.value = ''; g.query = ''; if (g.status && g.status.kind === 'error') _sdocGhSetStatus(null); }
        else return;
        e.preventDefault(); e.stopPropagation();
        _sdocGhRefreshList();
        return null;
    } else return;
    e.preventDefault(); e.stopPropagation();
    var prev = g.active;
    g.open = true; g.active = opts[next].full;
    _sdocGhRefreshList();
    // Scroll the highlighted option into the list's view only when it changed.
    var a = prev !== g.active && document.getElementById(_sdocGhOptId(g.active));
    if (a && typeof a.scrollIntoView === 'function') { try { a.scrollIntoView({ block: 'nearest' }); } catch (e2) {} }
    return null;
}
// Branch input: Enter connects.
function sdocGhKeydown(e) {
    if (!e || e.defaultPrevented || e.key !== 'Enter') return;
    e.preventDefault(); e.stopPropagation();
    return sdocSrcConnectRepo();
}
// Kept for the preview (string-only errors, where a 403 cannot be told apart).
function _sdocGhRateLimited(s, status) {
    return status === 429 || status === 403 || /rate limit|HTTP 429|HTTP 403/i.test(String(s || ''));
}
function _sdocGhRateText() { return t('GitHub rate limit reached, or the token lacks access. Try again later.'); }
// A failed githubApi result -> 'token' (401 invalid/expired), 'rate' (429, or 403 with
// x-ratelimit-remaining 0 / a rate-limit message), 'perm' (other 403: scopes, SSO),
// 'notfound' (404), else null.
function _sdocGhClassify(r) {
    if (!r || r.ok || r.error || !r.status) return null;
    var st = r.status, h = r.headers || {};
    var msg = String((r.body && typeof r.body === 'object' ? r.body.message : r.body) || '');
    if (st === 401) return 'token';
    if (st === 429 || (st === 403 && (String(h['x-ratelimit-remaining']) === '0' || /rate limit/i.test(msg)))) return 'rate';
    if (st === 403) return 'perm';
    if (st === 404) return 'notfound';
    return null;
}
function _sdocGhKindStatus(kind, repo) {
    if (kind === 'token') return { kind: 'error', settings: true, text: t('Your GitHub token is invalid or expired. Update it in Settings.') };
    if (kind === 'rate') return { kind: 'error', text: t('GitHub rate limit reached. Try again later.') };
    if (kind === 'perm') return { kind: 'error', settings: true, text: t('Your GitHub token lacks access. Check its permissions or SSO authorization.') };
    return { kind: 'error', text: t('Repository {repo} not found. Check the name, or make sure your token can read this private repository.', { repo: repo }) };
}
async function _sdocGhRepoInfo(repo) {
    try { return typeof githubApi === 'function' ? await githubApi('GET', '/repos/' + repo) : null; } catch (e) { return null; }
}
// Every /user/repos page (Link rel="next"; without headers: a full page of 100 means more),
// capped at SDOC_GH_MAX_PAGES. Page 1 failing is the result; a later page failing keeps the pages loaded.
async function _sdocGhFetchRepos() {
    var all = [];
    for (var page = 1; page <= SDOC_GH_MAX_PAGES; page++) {
        var r = (await githubApi('GET', '/user/repos?per_page=100&sort=updated' + (page > 1 ? '&page=' + page : ''))) || {};
        if (r.error || !r.ok) { if (page === 1) return r; break; }
        var body = Array.isArray(r.body) ? r.body : [];
        all = all.concat(body);
        var more = r.headers ? /rel="next"/.test(String(r.headers.link || '')) : body.length === 100;
        if (!more || !body.length) break;
    }
    return { ok: true, status: 200, body: all };
}
// The user's repos, once per page open (Retry clears the error and loads again).
function sdocGhLoadRepos() {
    var g = sdocGhState;
    if (g.repos || g.noToken || g.error) return Promise.resolve(g.repos);
    if (g.loading) return g.loading;
    var gen = g.gen;
    var p = Promise.resolve().then(function() {
        if (typeof githubApi !== 'function') throw new Error('githubApi unavailable');
        return _sdocGhFetchRepos();
    }).then(function(r) {
        if (gen !== g.gen) return; // stale: the page was reopened meanwhile
        r = r || {};
        if (r.error && /token/i.test(r.error)) { g.noToken = true; return; }
        if (r.error) { g.error = t('Could not load your repositories: {error}', { error: r.error }); return; }
        if (!r.ok) {
            var kind = _sdocGhClassify(r);
            g.errorKind = kind;
            g.error = kind && kind !== 'notfound' ? _sdocGhKindStatus(kind).text : t('Could not load your repositories: {error}', { error: 'HTTP ' + r.status });
            return;
        }
        g.repos = (Array.isArray(r.body) ? r.body : []).filter(function(x) { return x && x.full_name; }).map(function(x) {
            return { full: x.full_name, priv: !!x.private, def: x.default_branch || '', desc: x.description || '' };
        });
    }).catch(function(e) {
        if (gen === g.gen) g.error = t('Could not load your repositories: {error}', { error: String((e && e.message) || e) });
    }).then(function() {
        if (g.loading === p) g.loading = null;
        if (gen === g.gen) _sdocGhRefreshList();
        return g.repos;
    });
    g.loading = p;
    return p;
}
function sdocGhRetry() {
    var g = sdocGhState;
    g.error = null; g.errorKind = null; g.noToken = false; g.repos = null;
    var p = sdocGhLoadRepos();
    _sdocGhRefreshList();
    // The Retry button is gone from the note: keep focus in the picker.
    var inp = document.querySelector('.sdoc-gh-repo');
    if (inp) { try { inp.focus(); } catch (e) {} }
    return p;
}
// wsClone error text -> a clear message. A missing branch ref is also what a
// missing / private repo looks like, and a 403 is either a rate limit or a
// permission problem, so one repo lookup tells them apart.
async function _sdocGhCloneError(err, repo, branch) {
    var s = String(err || '');
    if (/GitHub not connected|No GitHub token/i.test(s)) return { noToken: true, kind: 'error' };
    if (/truncated/i.test(s)) return { kind: 'error', text: t('{repo} has too many files: GitHub truncated its file tree, so it cannot be cloned completely.', { repo: repo }) };
    var hm = /HTTP (\d{3})/.exec(s), code = hm ? +hm[1] : 0;
    if (code === 401) return _sdocGhKindStatus('token', repo);
    var bm = /^Branch "([^"]*)" not found/.exec(s);
    if (bm || code === 403 || code === 404 || code === 429) {
        var info = await _sdocGhRepoInfo(repo), kind = _sdocGhClassify(info);
        if (kind) return _sdocGhKindStatus(kind, repo);
        if (bm && info && info.ok) return { kind: 'error', text: t('Branch {branch} not found in {repo}.', { branch: bm[1] || branch || 'main', repo: repo }) };
    }
    if (_sdocGhRateLimited(s)) return { kind: 'error', text: _sdocGhRateText() };
    return { kind: 'error', text: t('Could not connect {repo}: {error}', { repo: repo, error: s || t('unknown error') }) };
}
// Connect + in-flight state: disabled + aria-busy on the live buttons (re-renders read g.busy / sdocWsBusy).
function _sdocSetBusyBtns(fks, on) {
    Array.prototype.forEach.call(document.querySelectorAll('button[data-fk]'), function(b) {
        if (fks.indexOf(b.getAttribute('data-fk')) < 0) return;
        b.disabled = !!on;
        if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
    });
}
function _sdocGhSetBusy(on) { sdocGhState.busy = !!on; _sdocSetBusyBtns(['connect-gh'], on); }
// An existing workspace repo equal to repo ignoring case (its casing), else repo.
function _sdocGhWsCanonRepo(repo) {
    var lo = String(repo).toLowerCase(), hit = (sdocSrcState.sources || []).find(function(s) {
        return s && s.type === 'ws' && _sdocSplitWk(s.wk).repo.toLowerCase() === lo;
    });
    return hit ? _sdocSplitWk(hit.wk).repo : repo;
}
// Clone the typed / picked repo (read-only source; never a local_folder).
async function sdocSrcConnectRepo() {
    var g = sdocGhState;
    var repo = String(g.query || '').trim().replace(/^https?:\/\/[^\/]+\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!repo) { _sdocGhSetStatus({ kind: 'error', text: t('Enter a repo (owner/repo)') }); return null; }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { _sdocGhSetStatus({ kind: 'error', text: t('Format: owner/repo') }); return null; }
    if (g.busy || typeof wsClone !== 'function') return null;
    var picked = (g.repos || []).find(function(r) { return r.full.toLowerCase() === repo.toLowerCase(); });
    // Canonical case: "Octo/Alpha" typed clones as GitHub's "octo/alpha" (one workspace key, one card).
    if (picked) repo = picked.full;
    // Blank branch: the picked repo's default branch, else GitHub's default_branch (lookup below).
    var branch = String(g.branch || '').trim() || (picked && picked.def) || undefined;
    _sdocGhSetBusy(true);
    try {
        // Not in the list (unlisted, or the list is loading / failed): always look the
        // repo up for its canonical full_name, even with an explicit branch; its
        // default_branch only fills a blank branch. A listed repo only needs it for a missing default.
        if (!picked || !branch) {
            var info = await _sdocGhRepoInfo(repo), canon = false;
            if (info && info.ok && info.body && typeof info.body === 'object') {
                if (info.body.full_name && /^[\w.-]+\/[\w.-]+$/.test(info.body.full_name)) { repo = info.body.full_name; canon = true; }
                if (!branch) branch = info.body.default_branch || undefined;
            } else if (!branch) {
                // Blank branch: a failed lookup is the answer (an explicit branch lets the clone report it).
                if (info && info.error && /token/i.test(info.error)) { _sdocGhSetStatus({ noToken: true, kind: 'error' }); return null; }
                var kind = _sdocGhClassify(info);
                if (kind) { _sdocGhSetStatus(_sdocGhKindStatus(kind, repo)); return null; }
            }
            // No canonical name from GitHub: reuse an existing workspace's casing (never a duplicate card).
            if (!picked && !canon) repo = _sdocGhWsCanonRepo(repo);
        }
        if (typeof _confirmReplaceExistingClone === 'function' && !(await _confirmReplaceExistingClone(repo, branch))) return null;
        _sdocGhSetStatus({ kind: 'info', text: t('Cloning {repo}...', { repo: repo }) });
        var res;
        try { res = await wsClone(repo, branch); } catch (e) { res = { success: false, error: String((e && e.message) || e) }; }
        if (res && res.success) {
            g.query = ''; g.branch = ''; g.status = null; g.active = null; g.open = false;
            sdocSrcState.addOpen = false;
            if (typeof showSnackbar === 'function') showSnackbar(t('Connected {repo}', { repo: repo }), 'success');
            return await _sdocAfterFolderChange();
        }
        _sdocGhSetStatus(await _sdocGhCloneError(res && res.error, repo, branch));
        return null;
    } finally {
        _sdocGhSetBusy(false);
    }
}

// Repo card actions. Refresh = the workspace dropdown's re-clone (dirty-check
// confirm + snackbars); Remove = deleteGitHubRepo behind the dropdown's confirm.
function _sdocSplitWk(wk) {
    var s = String(wk || ''), i = s.lastIndexOf('::');
    return i < 0 ? { repo: s, branch: 'main' } : { repo: s.slice(0, i), branch: s.slice(i + 2) };
}
// One Refresh / Remove at a time per repo card: a second click while one is in
// flight is a no-op, and both buttons render disabled + aria-busy meanwhile.
function _sdocWsSetBusy(wk, on) {
    if (on) sdocWsBusy.add(wk); else sdocWsBusy.delete(wk);
    _sdocSetBusyBtns(['wsref:ws:' + wk, 'wsrm:ws:' + wk], on);
}
function _sdocWsActionError(text) { if (typeof showSnackbar === 'function') showSnackbar(text, 'error'); }
function _sdocErrText(e) { return String((e && e.message) || e || '') || t('unknown error'); }
async function sdocWsRefresh(wk) {
    if (typeof _recloneWorkspaceFromDropdown !== 'function' || sdocWsBusy.has(wk)) return null;
    var p = _sdocSplitWk(wk);
    _sdocWsSetBusy(wk, true);
    // Inline onclick: a throw must not become an unhandled rejection or skip the invalidate.
    try { await _recloneWorkspaceFromDropdown(p.repo, p.branch); }
    catch (e) { _sdocWsActionError(t('Re-clone failed: {error}', { error: _sdocErrText(e) })); }
    finally { _sdocWsSetBusy(wk, false); }
    sdocSrcInvalidate('ws:' + wk);
    return _sdocAfterFolderChange();
}
async function sdocWsRemove(wk) {
    if (typeof deleteGitHubRepo !== 'function' || typeof showConfirmModal !== 'function' || sdocWsBusy.has(wk)) return null;
    _sdocWsSetBusy(wk, true);
    var removed, failed = false;
    try { removed = await _sdocWsRemoveConfirmed(wk); }
    catch (e) { failed = true; _sdocWsActionError(t('Delete failed: {error}', { error: _sdocErrText(e) })); }
    finally { _sdocWsSetBusy(wk, false); }
    if (failed) { sdocSrcInvalidate('ws:' + wk); return _sdocAfterFolderChange(); }
    if (!removed) return null;
    if (sdocSrcState.sel === 'ws:' + wk) { sdocSrcState.sel = 'all'; sdocSrcState.path = ''; }
    return _sdocAfterFolderChange();
}
// The confirm modal + delete; false when cancelled.
async function _sdocWsRemoveConfirmed(wk) {
    var p = _sdocSplitWk(wk), src = sdocSrcById('ws:' + wk);
    var fresh = null;
    if (typeof _wsDirtyCountFresh === 'function') { try { fresh = await _wsDirtyCountFresh(wk); } catch (e) { fresh = null; } }
    else if (src) fresh = src.dirty || 0;
    var n = Math.max(src ? (src.dirty || 0) : 0, fresh || 0);
    var warn = n > 0 ? '<br><br><strong>' + (fresh === null
        ? tn(n, 'This permanently discards {count} uncommitted local change (last known count; the current state could not be checked).', 'This permanently discards {count} uncommitted local changes (last known count; the current state could not be checked).')
        : tn(n, 'This permanently discards {count} uncommitted local change.', 'This permanently discards {count} uncommitted local changes.')) + '</strong>' : '';
    if (fresh === null && n === 0) warn += '<br><br><strong>' + t('Any uncommitted local changes will be permanently discarded (they could not be checked).') + '</strong>';
    var ok = await showConfirmModal(t('Delete local workspace?'),
        t('Delete {workspace} from this browser?', { workspace: '<strong>' + escapeHtml(p.repo) + ' (' + escapeHtml(p.branch) + ')</strong>' }) + warn +
        '<br><br>' + (n > 0 ? t('Gitignored files (not counted above) and the workspace\u2019s PR tracking are deleted too. The GitHub repository and remote branch will not be deleted.') : t('Gitignored files and the workspace\u2019s PR tracking are deleted too. The GitHub repository and remote branch will not be deleted.')), 'danger');
    if (!ok) return false;
    var r;
    try { r = await deleteGitHubRepo(wk); } catch (e) { r = { success: false, error: String((e && e.message) || e) }; }
    if (typeof showSnackbar === 'function') {
        if (r && r.success) showSnackbar(t('Deleted local workspace {repo} ({branch})', { repo: p.repo, branch: p.branch }));
        else showSnackbar(t('Delete failed: {error}', { error: (r && r.error) || t('unknown error') }), 'error');
    }
    return true;
}

// Up/Down (wrapping), Home/End move focus between the rail items (.sdoc-rail-item);
// each stays a Tab stop and Enter/Space press it natively. Vertical, so no RTL flip.
function sdocRailKeydown(e) {
    if (!e || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var el = e.target, host = e.currentTarget;
    if (!el || !el.classList || !el.classList.contains('sdoc-rail-item') || !host || !host.querySelectorAll) return;
    var btns = Array.prototype.slice.call(host.querySelectorAll('.sdoc-rail-item'));
    var cur = btns.indexOf(el), next = -1;
    if (cur < 0) return;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = btns.length - 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        next = typeof kbdRadioNextIndex === 'function' ? kbdRadioNextIndex(btns.length, cur, e.key, false)
            : (cur + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    }
    if (next < 0) return;
    e.preventDefault();
    btns[next].focus();
    try { btns[next].scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (x) {}
}
// "/" on the Documents page (ui/320 kbdFocusComposer): focus the search field.
function sdocFocusPageSearch() {
    if (typeof currentView === 'undefined' || currentView !== 'documents') return false;
    var panel = document.getElementById('documents-panel');
    var el = panel && panel.querySelector('.sdoc-page-search-input');
    if (!el || el.offsetParent === null) return false;
    el.focus();
    try { el.select(); } catch (e) {}
    return true;
}

// ─── listings (lazy, cached per source + path) ───
function _sdocWsEntries(rows, path, recursive) {
    var prefix = path ? path + '/' : '', out = [], dirs = {};
    for (var i = 0; i < rows.length; i++) {
        var p = rows[i].path;
        if (prefix && p.indexOf(prefix) !== 0) continue;
        var rest = p.slice(prefix.length), slash = rest.indexOf('/');
        if (recursive || slash < 0) out.push({ name: p.slice(p.lastIndexOf('/') + 1), path: p, kind: 'file', dirty: !!rows[i].dirty, change: sdocWsFileChange(rows[i]), size: rows[i].size, mtime: rows[i].last_modified_at || null, chatId: rows[i].last_modified_by_chat_id || null });
        else if (!dirs[rest.slice(0, slash)]) { dirs[rest.slice(0, slash)] = 1; out.push({ name: rest.slice(0, slash), path: prefix + rest.slice(0, slash), kind: 'directory' }); }
    }
    out.sort(function(a, b) { return a.kind === b.kind ? (a.name < b.name ? -1 : 1) : (a.kind === 'directory' ? -1 : 1); });
    return out;
}
// Returns the cached listing or null (a load is started and re-renders on settle).
function sdocSrcListing(src, path, recursive) {
    var key = src.id + (recursive ? '#*' : '#' + path);
    if (src.type === 'ws') {
        var prN = recursive ? 0 : sdocPrPathNumber(path);
        if (prN) return sdocPrListing(src, prN);
        var rows = sdocSrcState.wsRows[src.wk] || [];
        var all = _sdocWsEntries(rows, recursive ? '' : path, recursive);
        return { entries: all.slice(0, recursive ? SDOC_SRC_SEARCH_MAX * 10 : SDOC_SRC_LIST_MAX), truncated: all.length > SDOC_SRC_LIST_MAX && !recursive };
    }
    var c = sdocSrcState.listings[key];
    if (c) return c.loading ? null : c;
    if (src.permission !== 'granted') return (sdocSrcState.listings[key] = { entries: [], error: _sdsT(N_('Access needs to be re-granted.')), needsGrant: true });
    if (typeof lfListDir !== 'function') return (sdocSrcState.listings[key] = { entries: [], error: _sdsT('Connected folders are not available in this build.') });
    var cache = sdocSrcState.listings;
    cache[key] = { loading: true };
    Promise.resolve().then(function() { return lfListDir(src.folderId, recursive ? '' : path, { recursive: !!recursive, limit: recursive ? SDOC_SRC_SEARCH_MAX : SDOC_SRC_LIST_MAX }); })
        .then(function(res) { cache[key] = { entries: (res && res.entries) || [], truncated: !!(res && res.truncated) }; },
              function(e) { cache[key] = { entries: [], error: String((e && e.message) || e), needsGrant: !!(e && e.code === 'PERMISSION_REQUIRED') }; })
        .then(function() {
            if (cache !== sdocSrcState.listings) return; // reset while loading: the stale result stays in the dropped cache
            sdocRenderSourcesStrip(); renderDocumentsPageItems();
        });
    return null;
}

// Sync collector for the unified list: {rows, pending, errors}.
function sdocCollectFileRows(sel, q) {
    var out = { rows: [], pending: false, errors: [], more: [] };
    if (sel === 'sdocs' || !sdocSrcState.sources) { out.pending = sel !== 'sdocs' && sel !== 'all' && !sdocSrcState.sources; return out; }
    var mode = sdocGetGroupBy();
    var scope = sel === 'all' ? sdocAllViewSources(sdocSrcState.sources, q, mode) : [sdocSrcById(sel)].filter(Boolean);
    scope.forEach(function(src) {
        var l = sdocSrcListing(src, sel === 'all' ? '' : sdocSrcState.path, sdocSrcRecursive(src, sel, q, mode));
        if (!l) { out.pending = true; return; }
        if (l.error) out.errors.push({ src: src, error: l.error, needsGrant: !!l.needsGrant });
        var capped = sdocCapEntries(l.entries, q, SDOC_SRC_HITS_MAX);
        capped.hits.forEach(function(e) { out.rows.push({ src: src, entry: e }); });
        if (capped.more > 0) out.more.push({ src: src, count: capped.more });
        if (l.truncated) out.truncated = true;
    });
    return out;
}

// ─── Workspace status info + colored diffs (pure; DOM only behind typeof document guards) ───
// Per-file change kind, the same mapping as the chat header pill's _dirtyFileRow
// (040-tools-settings.js): '' = unchanged, else 'deleted' | 'new' | 'modified'.
function sdocWsFileChange(f) {
    if (!f || !f.dirty) return '';
    if (f.deleted) return 'deleted';
    return f.sha ? 'modified' : 'new';
}
// A pushed_pr counts as merged by the pill's own rule (_wsPushedPrMerged) when it is loaded.
function _sdocWsPrMerged(f, meta) {
    if (typeof _wsPushedPrMerged === 'function') return _wsPushedPrMerged(f, meta);
    return !!(f && f.pushed_pr && (f.pushed_pr_merged || f.pushed_pr.state === 'merged'));
}
// Workspace meta + file rows -> {branch, changed, counts:{new,modified,deleted}, pinned, pr}.
// pr = {number, url, state:'open'|'merged', changedSincePush} from the dirty rows' pushed_pr
// stamps; an open PR wins over a merged one.
function sdocWsInfoSummary(meta, files, isIgnored) {
    meta = meta || {};
    var parts = String(meta.repo || '').split('::');
    var counts = { 'new': 0, modified: 0, deleted: 0 }, pr = null, changed = 0;
    (files || []).forEach(function(f) {
        var kind = sdocWsFileChange(f);
        if (!kind || (isIgnored && isIgnored(f.path))) return;
        changed++; counts[kind]++;
        var p = f.pushed_pr;
        if (!p || !p.number) return;
        var merged = _sdocWsPrMerged(f, meta);
        if (!pr || (pr.state === 'merged' && !merged)) pr = { number: p.number, url: p.url || '', state: merged ? 'merged' : 'open', changedSincePush: false };
        if (pr.number === p.number && !merged && f.changed_since_push) pr.changedSincePush = true;
    });
    return { branch: meta.branch || parts[1] || '', changed: changed, counts: counts, pinned: !!meta.pinned, pr: pr };
}
function _sdocWsChangeLabel(kind) { return kind === 'deleted' ? t('deleted') : kind === 'new' ? t('new') : t('modified'); }
// Colored badge with a text label (never color alone).
function sdocWsChangeBadgeHtml(kind) {
    return kind ? '<span class="sdoc-ws-change sdoc-ws-change--' + _sdsEsc(kind) + '">' + _sdsEsc(_sdocWsChangeLabel(kind)) + '</span>' : '';
}
function _sdocWsPrLabel(pr) {
    var s = t('PR #{number}', { number: pr.number });
    if (pr.state === 'merged') return s + ' \u00B7 ' + t('Merged');
    return pr.changedSincePush ? s + ' \u00B7 ' + t('changed since push') : s;
}
// Plain-text summary for aria-labels.
function sdocWsInfoText(info) {
    if (!info) return '';
    var bits = [];
    if (info.branch) bits.push(info.branch);
    bits.push(info.changed ? tn(info.changed, '{count} changed file', '{count} changed files') : t('clean'));
    if (info.pr) bits.push(_sdocWsPrLabel(info.pr));
    if (info.pinned) bits.push(t('Pinned'));
    return bits.join(', ');
}
// Chips: branch, changed count, PR, pinned. compact (rail, inside a <button>): no link, no 'clean'.
function sdocWsInfoHtml(info, compact) {
    if (!info) return '';
    var I = typeof UI_ICONS !== 'undefined' ? UI_ICONS : {};
    var h = '<span class="sdoc-ws-info' + (compact ? ' sdoc-ws-info--compact' : '') + '"' + (compact ? ' aria-hidden="true"' : '') + '>';
    if (info.branch) h += '<span class="sdoc-ws-chip sdoc-ws-branch" title="' + _sdsEsc(info.branch) + '">' + (I.gitBranch || '') + '<span>' + _sdsEsc(info.branch) + '</span></span>';
    if (info.changed) h += '<span class="sdoc-ws-chip sdoc-ws-changed">' + _sdsEsc(tn(info.changed, '{count} changed file', '{count} changed files')) + '</span>';
    else if (!compact) h += '<span class="sdoc-ws-chip sdoc-ws-clean">' + _sdsEsc(t('clean')) + '</span>';
    if (info.pr) {
        var cls = 'sdoc-ws-chip sdoc-ws-pr sdoc-ws-pr--' + (info.pr.state === 'merged' ? 'merged' : info.pr.changedSincePush ? 'changed' : 'open'), lbl = _sdsEsc(_sdocWsPrLabel(info.pr));
        h += !compact && info.pr.url ? '<a class="' + cls + '" href="' + _sdsEsc(info.pr.url) + '" target="_blank" rel="noopener">' + lbl + '</a>'
            : '<span class="' + cls + '">' + lbl + '</span>';
    }
    if (info.pinned) h += '<span class="sdoc-ws-chip sdoc-ws-pinned">' + (I.pin || '') + '<span>' + _sdsEsc(t('Pinned')) + '</span></span>';
    return h + '</span>';
}
// Line diff (common prefix/suffix trimmed, LCS in between) -> [{type:'eq'|'add'|'del', lines:[...]}].
// Past SDOC_DIFF_MAX_CELLS the middle becomes one removed block + one added block.
var SDOC_DIFF_MAX_CELLS = 4000000;
function sdocLineDiff(oldText, newText) {
    var a = oldText ? String(oldText).split('\n') : [], b = newText ? String(newText).split('\n') : [], out = [];
    function push(type, line) { var last = out[out.length - 1]; if (last && last.type === type) last.lines.push(line); else out.push({ type: type, lines: [line] }); }
    var pre = 0, suf = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    var i, j;
    for (i = 0; i < pre; i++) push('eq', a[i]);
    var am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf), n = am.length, m = bm.length;
    if (n * m > SDOC_DIFF_MAX_CELLS) {
        am.forEach(function(l) { push('del', l); }); bm.forEach(function(l) { push('add', l); });
    } else if (n || m) {
        var w = m + 1, L = new Uint32Array((n + 1) * w);
        for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i * w + j] = am[i] === bm[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
        i = 0; j = 0;
        while (i < n && j < m) {
            if (am[i] === bm[j]) { push('eq', am[i]); i++; j++; }
            else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push('del', am[i++]);
            else push('add', bm[j++]);
        }
        while (i < n) push('del', am[i++]);
        while (j < m) push('add', bm[j++]);
    }
    for (i = a.length - suf; i < a.length; i++) push('eq', a[i]);
    return out;
}
function sdocDiffStats(segs) {
    var s = { added: 0, removed: 0 };
    (segs || []).forEach(function(g) { if (g.type === 'add') s.added += g.lines.length; else if (g.type === 'del') s.removed += g.lines.length; });
    return s;
}
// Segments -> lines in <ins>/<del> with a visible +/- sign (readable without color).
function sdocDiffHtml(segs) {
    var h = '';
    (segs || []).forEach(function(g) {
        var tag = g.type === 'add' ? 'ins' : g.type === 'del' ? 'del' : 'span', sign = g.type === 'add' ? '+' : g.type === 'del' ? '-' : ' ';
        g.lines.forEach(function(l) { h += '<' + tag + ' class="sdoc-diff-line sdoc-diff-' + g.type + '"><span class="sdoc-diff-sign">' + sign + '</span>' + _sdsEsc(l) + '</' + tag + '>'; });
    });
    return h;
}
var SDOC_DIFF_MAX_CHARS = 200000;
// Diff / File toggle for a changed workspace text file; '' when no text base is available.
function sdocWsDiffViewHtml(base, current) {
    if (base == null || current == null) return '';
    base = String(base); current = String(current);
    if (base.indexOf('::binary::') === 0 || current.indexOf('::binary::') === 0) return '';
    var segs = sdocLineDiff(base.slice(0, SDOC_DIFF_MAX_CHARS), current.slice(0, SDOC_DIFF_MAX_CHARS)), st = sdocDiffStats(segs);
    function tab(view, label, on) {
        return '<button type="button" class="sdoc-diff-tab" data-view="' + view + '" aria-pressed="' + (on ? 'true' : 'false') + '" onclick="sdocWsDiffSetView(this, \'' + view + '\')" onkeydown="sdocWsDiffKey(event)">' + _sdsEsc(label) + '</button>';
    }
    var statLbl = t('Lines added: {added}, removed: {removed}', st);
    return '<div class="sdoc-diff-wrap" data-view="diff"><div class="sdoc-diff-bar"><div class="sdoc-diff-tabs" role="group" aria-label="' + _sdsEsc(t('Diff view')) + '">' +
        tab('diff', t('Diff'), true) + tab('file', t('File'), false) + '</div>' +
        '<span class="sdoc-diff-stat" role="note" aria-label="' + _sdsEsc(statLbl) + '" title="' + _sdsEsc(statLbl) + '"><span class="sdoc-diff-stat-add" aria-hidden="true">+' + st.added + '</span> <span class="sdoc-diff-stat-del" aria-hidden="true">-' + st.removed + '</span></span></div>' +
        '<pre class="wsf-code sdoc-diff" data-pane="diff">' + sdocDiffHtml(segs) + '</pre>' +
        '<pre class="wsf-code" data-pane="file" hidden>' + _sdsEsc(current.slice(0, SDOC_DIFF_MAX_CHARS)) + '</pre></div>';
}
function sdocWsDiffSetView(btn, view) {
    if (typeof document === 'undefined' || !btn || !btn.closest) return;
    var wrap = btn.closest('.sdoc-diff-wrap');
    if (!wrap) return;
    wrap.setAttribute('data-view', view);
    wrap.querySelectorAll('.sdoc-diff-tab').forEach(function(b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === view ? 'true' : 'false'); });
    wrap.querySelectorAll('[data-pane]').forEach(function(p) { p.hidden = p.getAttribute('data-pane') !== view; });
}
// Arrow keys flip between the two views (Enter / Space work natively on the buttons).
function sdocWsDiffKey(event) {
    if (typeof document === 'undefined' || !event || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(event.key) < 0) return;
    var tabs = event.currentTarget && event.currentTarget.parentNode ? event.currentTarget.parentNode.querySelectorAll('.sdoc-diff-tab') : [];
    if (tabs.length < 2) return;
    event.preventDefault();
    var next = tabs[0] === event.currentTarget ? tabs[1] : tabs[0];
    sdocWsDiffSetView(next, next.getAttribute('data-view'));
    next.focus();
}

// ─── PR folders: a workspace root lists its PRs (meta.prs) as read-only virtual folders after
// the file tree (path '#pr/<n>'). Opening one lists only the PR's changed files (GitHub
// /pulls/<n>/files via githubApi); a file opens the Diff / File viewer (base vs head contents,
// else the API's unified patch). No select / download / delete inside.
var SDOC_PR_FOLDERS_MAX = 10, SDOC_PR_FILES_PAGES = 3, SDOC_PR_BLOB_MAX = 1024 * 1024;
// info: per page open (reset in sdocResetSources); files/blobs: keyed by head/ref sha.
var sdocPrCache = { info: {}, files: {}, blobs: {} };
function _sdocPrState(p) {
    var s = String((p && p.state) || '').toLowerCase();
    return p && (p.merged_at || p.merged || s === 'merged') ? 'merged' : s === 'closed' ? 'closed' : 'open';
}
// meta.prs -> deduped folders: open first, then newest (highest number) first, capped.
function sdocWsPrFolders(prs) {
    var seen = {}, out = [];
    (Array.isArray(prs) ? prs : []).forEach(function(p) {
        var n = p ? parseInt(p.number, 10) : 0;
        if (!n || seen[n]) return;
        seen[n] = 1;
        out.push({ number: n, title: String(p.title || p.branch || ''), state: _sdocPrState(p), url: p.url || '', branch: p.branch || '' });
    });
    out.sort(function(a, b) { return ((a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1)) || b.number - a.number; });
    return out.slice(0, SDOC_PR_FOLDERS_MAX);
}
function sdocPrPathNumber(path) { var m = /^#pr\/(\d+)$/.exec(String(path || '')); return m ? parseInt(m[1], 10) : 0; }
function _sdocPrOf(src, n) { return ((src && src.prs) || []).filter(function(p) { return p.number === n; })[0] || { number: n, title: '', state: 'open', url: '' }; }
function _sdocPrRepo(src) { return String((src && src.wk) || '').split('::')[0]; }
// GitHub file status -> {code: A|M|D|R, kind (badge color class)}.
var SDOC_PR_STATUS = { added: 'A', copied: 'A', removed: 'D', renamed: 'R', modified: 'M', changed: 'M' };
function sdocPrFileStatus(status) {
    var c = SDOC_PR_STATUS[String(status || '').toLowerCase()] || 'M';
    return { code: c, kind: c === 'A' ? 'new' : c === 'D' ? 'deleted' : c === 'R' ? 'renamed' : 'modified' };
}
function _sdocPrStatusLabel(code) { return code === 'A' ? t('Added') : code === 'D' ? t('Deleted') : code === 'R' ? t('Renamed') : t('Modified'); }
function sdocPrStatusBadgeHtml(code) {
    var k = sdocPrFileStatus({ A: 'added', D: 'removed', R: 'renamed' }[code] || 'modified'), lbl = _sdsEsc(_sdocPrStatusLabel(k.code));
    return '<span class="sdoc-ws-change sdoc-pr-status sdoc-ws-change--' + k.kind + '" title="' + lbl + '" aria-label="' + lbl + '">' + k.code + '</span>';
}
function _sdocPrStateLabel(st) { return st === 'merged' ? t('Merged') : st === 'closed' ? t('Closed') : t('Open'); }
async function _sdocGh(path) {
    if (typeof githubApi !== 'function') throw new Error(t('GitHub is not available in this build.'));
    var r = await githubApi('GET', path);
    if (!r || r.error || !r.ok) throw new Error((r && (r.error || (r.body && r.body.message))) || ('HTTP ' + (r && r.status)));
    return r.body;
}
function _sdocGhPath(p) { return String(p || '').split('/').map(encodeURIComponent).join('/'); }
// {base, head, updated} shas of a PR (workspace meta carries none), once per page open.
async function sdocPrInfo(repo, n) {
    var k = repo + '#' + n;
    if (!sdocPrCache.info[k]) {
        sdocPrCache.info[k] = _sdocGh('/repos/' + repo + '/pulls/' + n).then(function(b) {
            return { base: b && b.base && b.base.sha, head: b && b.head && b.head.sha, updated: b && b.updated_at };
        });
        sdocPrCache.info[k].catch(function() { delete sdocPrCache.info[k]; });
    }
    return sdocPrCache.info[k];
}
// Changed files (raw GitHub entries), up to SDOC_PR_FILES_PAGES x 100; cached per head sha.
async function sdocPrLoadFiles(repo, n) {
    var info = await sdocPrInfo(repo, n), k = repo + '#' + n + '@' + (info.head || info.updated || '');
    if (sdocPrCache.files[k]) return sdocPrCache.files[k];
    var all = [], more = false;
    for (var page = 1; page <= SDOC_PR_FILES_PAGES; page++) {
        var b = await _sdocGh('/repos/' + repo + '/pulls/' + n + '/files?per_page=100&page=' + page);
        var list = Array.isArray(b) ? b : [];
        all = all.concat(list);
        if (list.length < 100) break;
        if (page === SDOC_PR_FILES_PAGES) more = true;
    }
    all.truncated = more;
    return (sdocPrCache.files[k] = all);
}
function sdocPrFileEntries(files, n) {
    var out = (files || []).filter(function(f) { return f && f.filename; }).map(function(f) {
        var p = String(f.filename), cut = p.lastIndexOf('/');
        return { name: p.slice(cut + 1), dir: cut > 0 ? p.slice(0, cut) : '', path: p, kind: 'file', pr: n, prStatus: sdocPrFileStatus(f.status).code, prFile: f };
    });
    out.sort(function(a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
    return out;
}
// sdocSrcListing for '#pr/<n>': cached result, or null while loading (re-renders on settle).
function sdocPrListing(src, n) {
    var key = src.id + '#pr/' + n, cache = sdocSrcState.listings, c = cache[key];
    if (c) return c.loading ? null : c;
    cache[key] = { loading: true };
    sdocPrLoadFiles(_sdocPrRepo(src), n).then(function(files) { cache[key] = { entries: sdocPrFileEntries(files, n), truncated: !!files.truncated }; },
        function(e) { cache[key] = { entries: [], error: String((e && e.message) || e) }; })
        .then(function() {
            if (cache !== sdocSrcState.listings) return;
            sdocRenderSourcesStrip(); renderDocumentsPageItems();
        });
    return null;
}
function sdocPrFolderItemHtml(src, pr) {
    var I = typeof UI_ICONS !== 'undefined' ? UI_ICONS : {}, path = '#pr/' + pr.number, name = t('PR #{number}', { number: pr.number });
    // Selects the workspace at '#pr/<n>', so it works from the All view as well as a workspace.
    var title = pr.title ? name + ' \u00B7 ' + pr.title : name, nav = 'sdocSelectSource(\'' + sdocJsArg(sdocPrSrcId(src, pr.number)) + '\')';
    return '<div class="widget-library-item sdoc-lib-item sdoc-file-item is-folder sdoc-pr-folder sdoc-pr-folder--' + pr.state + '" data-src-id="' + _sdsEsc(src.id) + '" data-path="' + path + '" role="button" tabindex="0"' +
        ' title="' + _sdsEsc(title) + '" onclick="' + nav + '" onkeydown="if (event.target === event.currentTarget && (event.key === \'Enter\' || event.key === \' \')) { event.preventDefault(); ' + nav + '; }">' +
        '<div class="sdoc-lib-icon sdoc-file-icon sdoc-pr-icon" aria-hidden="true">' + (I.gitMerge || I.git || '') + '</div>' +
        '<div class="sdoc-lib-info"><div class="widget-library-title sdoc-lib-title">' + _sdsEsc(title) + '</div>' +
        '<div class="widget-library-meta sdoc-lib-meta"><span class="sdoc-lib-stat"><span class="sdoc-ws-chip sdoc-ws-pr sdoc-ws-pr--' + pr.state + '">' + _sdsEsc(_sdocPrStateLabel(pr.state)) + '</span>' +
        (pr.branch ? ' \u00B7 ' + _sdsEsc(pr.branch) : '') + '</span></div></div></div>';
}
function sdocPrFoldersHtml(src) {
    var prs = (src && src.prs) || [];
    if (!prs.length) return '';
    // Flat siblings (no wrapper, no heading) so gallery grids keep one cell per folder.
    return prs.map(function(p) { return sdocPrFolderItemHtml(src, p); }).join('');
}
// All view: one folder row per workspace (opens it), each directly followed by its PR folders.
function sdocWsFolderRowsHtml(sources) {
    return (sources || []).filter(function(s) { return s && s.type === 'ws'; }).map(function(s) {
        var nav = 'sdocSelectSource(\'' + sdocJsArg(s.id) + '\')', title = s.label + (s.branch ? ' \u00B7 ' + s.branch : '');
        var cnt = _sdocCountText(s.count, '{count} file', '{count} files');
        return '<div class="widget-library-item sdoc-lib-item sdoc-file-item is-folder sdoc-ws-folder" data-src-id="' + _sdsEsc(s.id) + '" data-path="" role="button" tabindex="0"' +
            ' title="' + _sdsEsc(s.wk || title) + '" onclick="' + nav + '" onkeydown="if (event.target === event.currentTarget && (event.key === \'Enter\' || event.key === \' \')) { event.preventDefault(); ' + nav + '; }">' +
            '<div class="sdoc-lib-icon sdoc-file-icon sdoc-ft-folder sdoc-ws-icon" aria-hidden="true">' + (UI_ICONS.git || UI_ICONS.folder || '') + '</div>' +
            '<div class="sdoc-lib-info"><div class="widget-library-title sdoc-lib-title">' + _sdsEsc(title) + '</div>' +
            '<div class="widget-library-meta sdoc-lib-meta"><span class="sdoc-lib-stat">' + _sdsEsc(cnt) + '</span>' + (s.info ? sdocWsInfoHtml(s.info, true) : '') + '</div></div></div>' +
            sdocPrFoldersHtml(s);
    }).join('');
}
// Read-only changed-file row: type icon, name, muted dir, A/M/D/R badge.
function sdocPrFileItemHtml(row, idx) {
    var e = row.entry, ft = sdocFileTypeInfo(e.name, 'file'), f = e.prFile || {};
    var k = sdocPrFileStatus(f.status).kind, sub = e.dir ? _sdsEsc(e.dir) : '';
    if (f.previous_filename) sub = _sdsEsc(t('renamed from {path}', { path: f.previous_filename }));
    var stats = f.additions != null ? '<span class="sdoc-diff-stat"><span class="sdoc-diff-stat-add">+' + (f.additions | 0) + '</span> <span class="sdoc-diff-stat-del">-' + (f.deletions | 0) + '</span></span>' : '';
    return '<div class="widget-library-item sdoc-lib-item sdoc-file-item sdoc-pr-file sdoc-ws-change-' + k + '" data-src-id="' + _sdsEsc(row.src.id) + '" data-path="' + _sdsEsc(e.path) + '" role="button" tabindex="0"' +
        ' title="' + _sdsEsc(e.path) + '" onclick="sdocOpenFileRow(' + idx + ')" onkeydown="sdocFileRowKey(event, ' + idx + ')">' +
        '<div class="sdoc-lib-icon sdoc-file-icon sdoc-ft-' + ft.kind + '" aria-hidden="true">' + sdocFileIcon(e) + '</div>' +
        '<div class="sdoc-lib-info"><div class="widget-library-title sdoc-lib-title">' + _sdsEsc(e.name) + '</div>' +
        '<div class="widget-library-meta sdoc-lib-meta"><span class="sdoc-lib-stat">' + sdocPrStatusBadgeHtml(e.prStatus) + (sub ? ' <span class="sdoc-pr-dir">' + sub + '</span>' : '') + (stats ? ' \u00B7 ' + stats : '') + '</span></div></div></div>';
}
function sdocPrBreadcrumbHtml(src, n) {
    var pr = _sdocPrOf(src, n), name = t('PR #{number}', { number: n }) + (pr.title ? ' \u00B7 ' + pr.title : '');
    return '<div class="sdoc-src-crumbs" role="navigation" aria-label="' + _sdsEsc(_sdsT('Folder path')) + '"><button type="button" class="sdoc-src-crumb" onclick="sdocSrcNavigate(\'\')">' + _sdocSrcIcon(src) + '<span>' + _sdsEsc(src.label) + '</span></button>' +
        '<span class="sdoc-src-crumb-sep" aria-hidden="true">/</span><span class="sdoc-src-crumb" aria-current="location">' + _sdsEsc(name) + '</span> ' +
        '<span class="sdoc-ws-chip sdoc-ws-pr sdoc-ws-pr--' + pr.state + '">' + _sdsEsc(_sdocPrStateLabel(pr.state)) + '</span>' +
        (pr.url ? ' <a class="sdoc-pr-link" href="' + _sdsEsc(pr.url) + '" target="_blank" rel="noopener">' + _sdsEsc(t('Open on GitHub')) + '</a>' : '') + '</div>';
}
// base64 (contents API) -> UTF-8 text, or null when binary / not valid UTF-8.
function _sdocB64Text(b64) {
    var bin = atob(String(b64 || '').replace(/\s+/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.indexOf(0) !== -1) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return null; }
}
// File text at a ref, or null (missing ref, binary, too large, request failed).
async function sdocPrBlobText(repo, path, ref) {
    if (!ref) return null;
    var k = repo + '@' + ref + ':' + path;
    if (k in sdocPrCache.blobs) return sdocPrCache.blobs[k];
    var text = null;
    try {
        var b = await _sdocGh('/repos/' + repo + '/contents/' + _sdocGhPath(path) + '?ref=' + encodeURIComponent(ref));
        if (b && b.encoding === 'base64' && typeof b.content === 'string' && (b.size || 0) <= SDOC_PR_BLOB_MAX) text = _sdocB64Text(b.content);
    } catch (e) { return null; }
    return (sdocPrCache.blobs[k] = text);
}
// Fallback: the API's unified patch, colored per line (+ add, - del, @@ hunk).
function sdocPrPatchHtml(patch) {
    if (!patch) return sdocNoPreviewHtml(t('No text diff available for this file.'), null);
    var add = 0, del = 0, h = '';
    String(patch).split('\n').forEach(function(l) {
        var c = l.charAt(0), type = c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'hunk' : 'eq', tag = type === 'add' ? 'ins' : type === 'del' ? 'del' : 'span';
        if (type === 'add') add++; else if (type === 'del') del++;
        var sign = type === 'hunk' ? '' : (c === '+' || c === '-' || c === ' ') ? c : ' ', body = type === 'hunk' ? l : ((c === '+' || c === '-' || c === ' ') ? l.slice(1) : l);
        h += '<' + tag + ' class="sdoc-diff-line sdoc-diff-' + type + '">' + (type === 'hunk' ? '' : '<span class="sdoc-diff-sign">' + sign + '</span>') + _sdsEsc(body) + '</' + tag + '>';
    });
    return '<div class="sdoc-diff-wrap sdoc-pr-patch"><div class="sdoc-diff-bar"><span>' + _sdsEsc(t('Patch')) + '</span><span class="sdoc-diff-stat"><span class="sdoc-diff-stat-add">+' + add + '</span> <span class="sdoc-diff-stat-del">-' + del + '</span></span></div>' +
        '<pre class="wsf-code sdoc-diff">' + h + '</pre></div>';
}
// Full-file Diff / File view from base + head contents; the patch when either side is unavailable.
async function sdocPrFileDiffHtml(repo, n, f) {
    var st = sdocPrFileStatus(f.status);
    if (!sdocPreviewKind(f.filename)) {
        var info = await sdocPrInfo(repo, n);
        var base = st.code === 'A' ? '' : await sdocPrBlobText(repo, f.previous_filename || f.filename, info.base);
        var cur = st.code === 'D' ? '' : await sdocPrBlobText(repo, f.filename, info.head);
        var h = base != null && cur != null ? sdocWsDiffViewHtml(base, cur) : '';
        if (h) return h;
    }
    return sdocPrPatchHtml(f.patch);
}
async function sdocPrOpenFile(src, e) {
    var repo = _sdocPrRepo(src), f = e.prFile || { filename: e.path }, opts = { returnFocus: function() { return sdocFileRowEl(src.id, e.path); } };
    var meta = '<div class="wsf-file-meta">' + _sdsEsc(repo) + ' \u00B7 ' + _sdsEsc(t('PR #{number}', { number: e.pr })) + ' \u00B7 ' + sdocPrStatusBadgeHtml(e.prStatus) +
        (f.previous_filename ? ' \u00B7 ' + _sdsEsc(t('renamed from {path}', { path: f.previous_filename })) : '') + '</div>';
    var ov = _sdocOverlay(e.path, meta + '<div class="sdoc-pr-diff-slot" role="status">' + _sdsEsc(_sdsT('Loading\u2026')) + '</div>', opts);
    var body;
    try { body = await sdocPrFileDiffHtml(repo, e.pr, f); }
    catch (err) { body = '<div class="sdoc-src-note warn">' + _sdsEsc(String((err && err.message) || err)) + '</div>' + sdocPrPatchHtml(f.patch); }
    var slot = ov && ov.querySelector ? ov.querySelector('.sdoc-pr-diff-slot') : null;
    if (slot) slot.outerHTML = body;
    return ov;
}

// Viewer kind for the file preview: extension first, then MIME. '' = decide
// by content (text vs binary). .ogg is audio unless the MIME says video.
function sdocPreviewKind(name, mime) {
    var n = String(name || '').toLowerCase(), m = String(mime || '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(n)) return 'image';
    if (/\.ogg$/.test(n)) return /^video\//.test(m) ? 'video' : 'audio';
    if (/\.(mp4|m4v|webm|ogv|mov)$/.test(n)) return 'video';
    if (/\.(mp3|wav|oga|m4a|flac|aac|opus)$/.test(n)) return 'audio';
    if (/\.pdf$/.test(n)) return 'pdf';
    if (/^image\//.test(m)) return 'image';
    if (/^video\//.test(m)) return 'video';
    if (/^audio\//.test(m)) return 'audio';
    if (m === 'application/pdf') return 'pdf';
    return '';
}
// File-type map (Material Icon Theme / VS Code / GitHub linguist colors): ext -> {kind, label, color, ink}.
// kind: code | data | config | text | archive | image | video | audio | pdf | file | folder.
var SDOC_FILE_TYPES = (function() {
    var m = {};
    function add(exts, kind, label, color, ink) {
        exts.split(' ').forEach(function(x) { m[x] = { kind: kind, label: label, color: color, ink: ink || '#fff' }; });
    }
    add('js mjs cjs', 'code', 'JS', '#f1c40f', '#1e1e1e');
    add('ts mts cts', 'code', 'TS', '#3178c6');
    add('jsx', 'code', 'JSX', '#00bcd4', '#1e1e1e');
    add('tsx', 'code', 'TSX', '#00acc1', '#1e1e1e');
    add('json jsonc json5', 'data', 'JSON', '#f5a623', '#1e1e1e');
    add('html htm', 'code', 'HTML', '#e34c26');
    add('css', 'code', 'CSS', '#42a5f5');
    add('scss sass less', 'code', 'SCSS', '#cd6799');
    add('md markdown mdx', 'text', 'MD', '#519aba');
    add('py', 'code', 'PY', '#3776ab');
    add('sh bash zsh', 'code', 'SH', '#4caf50');
    add('yml yaml', 'config', 'YML', '#8e7cc3');
    add('toml', 'config', 'TOML', '#8e7cc3');
    add('ini cfg conf', 'config', 'INI', '#8e7cc3');
    add('env', 'config', 'ENV', '#8e7cc3');
    add('xml', 'code', 'XML', '#ff7043');
    add('svg', 'image', 'SVG', '#ffb13b', '#1e1e1e');
    add('png jpg jpeg gif webp ico bmp avif', 'image', 'IMG', '#a074c4');
    add('pdf', 'pdf', 'PDF', '#e53935');
    add('zip tar gz tgz 7z rar bz2 xz', 'archive', 'ZIP', '#8d6e63');
    add('csv tsv', 'data', 'CSV', '#1e8e3e');
    add('xlsx xls ods', 'data', 'XLS', '#1e8e3e');
    add('txt', 'text', 'TXT', '#9e9e9e');
    add('log', 'text', 'LOG', '#9e9e9e');
    add('java', 'code', 'JAVA', '#e5532d');
    add('go', 'code', 'GO', '#00add8');
    add('rs', 'code', 'RS', '#dea584', '#1e1e1e');
    add('rb', 'code', 'RB', '#cc342d');
    add('sql', 'data', 'SQL', '#e38c00');
    return m;
})();
var SDOC_FILE_TYPE_DEFAULT = { kind: 'file', label: '', color: '#90a4ae', ink: '#fff' };
var SDOC_FOLDER_TYPE = { kind: 'folder', label: '', color: '#dcb67a', ink: '#1e1e1e' };
function sdocFileTypeInfo(name, entryKind) {
    if (entryKind === 'directory') return SDOC_FOLDER_TYPE;
    var n = String(name || ''), dot = n.lastIndexOf('.');
    var ext = dot > 0 ? n.slice(dot + 1).toLowerCase() : (n.charAt(0) === '.' ? n.slice(1).toLowerCase() : '');
    var t = SDOC_FILE_TYPES[ext];
    if (t) return t;
    var pk = typeof sdocPreviewKind === 'function' ? sdocPreviewKind(n) : '';
    if (pk === 'video') return { kind: 'video', label: '', color: '#ec407a', ink: '#fff' };
    if (pk === 'audio') return { kind: 'audio', label: '', color: '#26a69a', ink: '#fff' };
    return SDOC_FILE_TYPE_DEFAULT;
}
// Generic page shape tinted via currentColor (SVG presentation attribute, CSP-safe) + a label badge.
function _sdocFileBadgeSvg(t) {
    var page = '<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';
    var badge = t.label ? '<rect x="1" y="12" width="18" height="8" rx="1.5" fill="currentColor"/><text x="10" y="18.1" text-anchor="middle" font-size="' + (t.label.length > 3 ? 5.2 : 6.2) + '" font-weight="700" font-family="system-ui,sans-serif" fill="' + t.ink + '">' + t.label + '</text>' : '';
    return '<svg class="sdoc-ft-svg" viewBox="0 0 24 24" color="' + t.color + '" aria-hidden="true" focusable="false">' + page + badge + '</svg>';
}
function sdocFileIcon(e) {
    var t = sdocFileTypeInfo(e.name, e.kind);
    if (t.kind === 'folder') return UI_ICONS.folder;
    if (t.kind === 'image' && t.label !== 'SVG') return UI_ICONS.image;
    if (t.kind === 'video' || t.kind === 'audio' || t.kind === 'pdf') return UI_ICONS[t.kind];
    return _sdocFileBadgeSvg(t);
}
// Entry last-modified as epoch ms (lfListDir: lastModified; workspace rows: mtime), or null.
function sdocEntryMtime(e) {
    var v = e && (e.mtime != null ? e.mtime : e.lastModified);
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Date.parse(v);
    return isFinite(n) && n > 0 ? n : null;
}
function buildDocumentsFileItem(row, idx) {
    if (row.entry && row.entry.pr) return sdocPrFileItemHtml(row, idx);
    var e = row.entry, src = row.src, mt = sdocEntryMtime(e), ft = sdocFileTypeInfo(e.name, e.kind);
    var meta = _sdsEsc(src.type === 'ws' ? src.label + ' \u00B7 ' + src.branch : src.label) + ' \u00B7 ' +
        (e.kind === 'directory' ? _sdsEsc(_sdsT('Folder')) : _sdsEsc(e.size != null ? _sdsSize(e.size) : e.path)) +
        (e.change ? ' \u00B7 ' + sdocWsChangeBadgeHtml(e.change) : e.dirty ? ' \u00B7 <span class="sdoc-src-dirty">' + _sdsEsc(t('modified')) + '</span>' : '');
    // Every file and folder row gets a checkbox (a folder stands for all its descendants).
    var selKey = sdocSelKeyOf({ kind: 'file', row: row }), picked = !!selKey && sdocSelection.has(selKey);
    var html = '<div class="widget-library-item sdoc-lib-item sdoc-file-item' + (e.kind === 'directory' ? ' is-folder' : '') + (picked ? ' is-selected' : '') + (e.change ? ' sdoc-ws-change-' + e.change : '') + '" data-src-id="' + _sdsEsc(src.id) + '" data-path="' + _sdsEsc(e.path) + '" data-row-idx="' + idx + '"' + (selKey ? ' data-sel-key="' + _sdsEsc(selKey) + '"' : '') + ' role="button" tabindex="0"' +
        ' title="' + _sdsEsc(e.path) + '" onclick="sdocOpenFileRow(' + idx + ')" onkeydown="sdocFileRowKey(event, ' + idx + ')">' +
        (selKey ? _sdocSelCheckHtml(selKey, e.name, picked) : '') +
        '<div class="sdoc-lib-icon sdoc-file-icon sdoc-ft-' + ft.kind + '"' + (sdocThumbEligible(e) ? ' data-thumb="1"' : '') + ' aria-hidden="true">' + sdocFileIcon(e) + '</div>' +
        '<div class="sdoc-lib-info"><div class="widget-library-title sdoc-lib-title">' + _sdsEsc(e.name) + '</div>' +
        '<div class="widget-library-meta sdoc-lib-meta"><span class="sdoc-lib-stat">' + meta + '</span>' +
        // mtime is its own non-shrinking stat: the wrapping meta row moves it to a new line at narrow
        // widths instead of the ellipsis of the source/size stat clipping it away.
        (e.kind === 'file' && mt ? '<span class="sdoc-lib-stat sdoc-file-mtime" title="' + _sdsEsc(new Date(mt).toLocaleString()) + '">' + _sdsEsc(sdocTimeAgo(mt)) + '</span>' : '') + '</div></div>';
    var acts = _sdocChatBtnsHtml(e.name, 'sdocStartChatForFile(' + idx + ')', sdocFileSourceChatId(src, e) ? 'sdocOpenFileRowChat(' + idx + ')' : '');
    if (src.type !== 'ws') {
        var dl = _sdsEsc(_sdsT('Download')), del = _sdsEsc(_sdsT('Delete'));
        acts += '<button type="button" class="widget-library-btn" onclick="event.stopPropagation(); sdocDownloadFileRow(' + idx + ')" title="' + dl + '" aria-label="' + dl + '">' + UI_ICONS.download + '</button>' +
            (sdocSrcWritable(src) ? '<button type="button" class="widget-library-btn danger" onclick="event.stopPropagation(); sdocDeleteFileRow(' + idx + ')" title="' + del + '" aria-label="' + del + '">' + UI_ICONS.trash + '</button>' : '');
    }
    return html + '<div class="sdoc-lib-actions">' + acts + '</div></div>';
}
function sdocFileRowKey(event, idx) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sdocOpenFileRow(idx); }
}
// ─── Folder-view image thumbnails (list + gallery) ───
// Image rows carry data-thumb on their icon tile; sdocThumbsAttach lazy-loads a cover-cropped <img>
// as the row nears the viewport. Local/virtual folders: blob: URL of the File (never read into memory;
// the manifest sets no CSP override, so img-src is open). Workspace: a data: URL from the locally
// stored blob only - lazy-clone stubs keep the type icon (no network). The icon stays until load.
var SDOC_THUMB_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
var SDOC_THUMB_MAX_BYTES = 15 * 1024 * 1024;
var SDOC_THUMB_WS_MAX_BYTES = 2 * 1024 * 1024;
var sdocThumbUrls = new Set();
var sdocThumbObserver = null, sdocThumbGen = 0;
function sdocThumbEligible(e) {
    return !!(e && e.kind === 'file' && !e.pr && SDOC_THUMB_RE.test(String(e.name || '')) && (e.size == null || e.size <= SDOC_THUMB_MAX_BYTES));
}
// Drops the observer and revokes every thumbnail blob: URL of the previous render.
function sdocThumbsReset() {
    sdocThumbGen++;
    if (sdocThumbObserver) { try { sdocThumbObserver.disconnect(); } catch (_) {} sdocThumbObserver = null; }
    sdocThumbUrls.forEach(function(u) { try { URL.revokeObjectURL(u); } catch (_) {} });
    sdocThumbUrls.clear();
}
function sdocThumbsAttach(root) {
    sdocThumbsReset();
    var hosts = root && root.querySelectorAll ? root.querySelectorAll('.sdoc-file-icon[data-thumb]') : [];
    if (!hosts.length) return 0;
    if (typeof IntersectionObserver !== 'function') { for (var i = 0; i < hosts.length; i++) sdocThumbLoad(hosts[i]); return hosts.length; }
    var obs = sdocThumbObserver = new IntersectionObserver(function(ents) {
        ents.forEach(function(en) { if (en.isIntersecting) { obs.unobserve(en.target); sdocThumbLoad(en.target); } });
    }, { rootMargin: '200px' });
    for (var j = 0; j < hosts.length; j++) obs.observe(hosts[j]);
    return hosts.length;
}
async function sdocThumbLoad(host) {
    var item = host && host.closest ? host.closest('.sdoc-file-item') : null;
    if (!item) return false;
    var path = item.getAttribute('data-path'), src = sdocSrcById(item.getAttribute('data-src-id'));
    if (!src || !path) return false;
    var gen = sdocThumbGen, url = null, isBlob = false;
    try {
        if (src.type === 'ws') {
            var rec = typeof getWorkspaceFile === 'function' ? await getWorkspaceFile(src.wk, path) : null;
            if (rec && rec.content != null) url = sdocWsImageDataUrl(path, rec.content, SDOC_THUMB_WS_MAX_BYTES);
        } else if (typeof lfGetFile === 'function') {
            var g = await lfGetFile(src.folderId, path);
            if (g && g.file && g.size <= SDOC_THUMB_MAX_BYTES && gen === sdocThumbGen) {
                // SVG only renders from a blob typed image/svg+xml.
                var mime = sdocImageMime(path) || (/^image\//.test(g.mime) ? g.mime : '');
                var blob = g.file.type ? g.file : new Blob([g.file], { type: mime || 'application/octet-stream' });
                url = URL.createObjectURL(blob); isBlob = true;
            }
        }
    } catch (_) { url = null; }
    if (!url) return false;
    function drop() { if (isBlob) { try { URL.revokeObjectURL(url); } catch (_) {} sdocThumbUrls.delete(url); } }
    if (gen !== sdocThumbGen || !host.isConnected) { drop(); return false; } // re-rendered meanwhile
    if (isBlob) sdocThumbUrls.add(url);
    var img = document.createElement('img');
    img.className = 'sdoc-thumb-img'; img.alt = ''; img.decoding = 'async'; img.draggable = false;
    img.addEventListener('load', function() { host.classList.add('has-thumb'); });
    img.addEventListener('error', function() { img.remove(); host.classList.remove('has-thumb'); drop(); });
    img.src = url;
    host.appendChild(img);
    return true;
}
// ─── Media viewer navigation: prev / next previewable file of the current listing ───
var SDOC_NAV_KINDS = { image: 1, video: 1, audio: 1, pdf: 1 };
function sdocMediaNavList(rows) {
    return (rows || []).filter(function(r) { var e = r && r.entry; return !!(e && r.src && e.kind === 'file' && !e.pr && SDOC_NAV_KINDS[sdocPreviewKind(e.name)]); });
}
// {index, total, prev, next}: prev/next are null at the ends (no wrap); index -1 when absent.
function sdocMediaNavStep(list, srcId, path) {
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].src.id === srcId && list[i].entry.path === path) { idx = i; break; }
    return { index: idx, total: list.length, prev: idx > 0 ? list[idx - 1] : null, next: idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null };
}
// Rows in on-screen order (grouping can reorder sdocSrcState.rendered); render order as fallback.
function sdocMediaNavRows() {
    var rendered = sdocSrcState.rendered || [], out = [];
    var els = document.querySelectorAll('.sdoc-file-item[data-row-idx]');
    for (var i = 0; i < els.length; i++) { var r = rendered[+els[i].getAttribute('data-row-idx')]; if (r && out.indexOf(r) === -1) out.push(r); }
    return sdocMediaNavList(out.length ? out : rendered);
}
// Arrow keys on these targets keep their native meaning (typing, seeking a focused video/audio).
function sdocNavKeyIgnored(el) {
    if (!el || !el.tagName) return false;
    return /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(el.tagName) || !!el.isContentEditable;
}
// Adds prev/next chevrons + "3 / 12" to a preview overlay's header, ArrowLeft/ArrowRight and swipe.
// Returns {step, go, cleanup} (cleanup removes the key listener; called from the overlay's onClose).
function sdocAttachMediaNav(ov, src, path) {
    if (!ov || !ov.querySelector || !src || !SDOC_NAV_KINDS[sdocPreviewKind(path)]) return null;
    var st = sdocMediaNavStep(sdocMediaNavRows(), src.id, path);
    if (st.index < 0 || st.total < 2) return null;
    var head = ov.querySelector('.wsf-modal-header'), closeBtn = ov.querySelector('.wsf-modal-close');
    if (!head) return null;
    var pl = _sdsEsc(t('Previous file (\u2190)')), nl = _sdsEsc(t('Next file (\u2192)'));
    var nav = document.createElement('div');
    nav.className = 'wsf-modal-nav sdoc-media-nav';
    nav.innerHTML = '<button type="button" class="sn-artifact-icon-btn sdoc-media-prev" title="' + pl + '" aria-label="' + pl + '"' + (st.prev ? '' : ' disabled') + '>' + UI_ICONS.chevronLeft + '</button>' +
        '<span class="wsf-nav-counter sdoc-media-counter">' + (st.index + 1) + ' / ' + st.total + '</span>' +
        '<button type="button" class="sn-artifact-icon-btn sdoc-media-next" title="' + nl + '" aria-label="' + nl + '"' + (st.next ? '' : ' disabled') + '>' + UI_ICONS.chevronRight + '</button>';
    head.insertBefore(nav, closeBtn && closeBtn.parentNode === head ? closeBtn : null);
    var done = false;
    function go(row) {
        if (!row || done) return null;
        done = true;
        if (typeof ov._wsfClose === 'function') ov._wsfClose(); else ov.remove();
        return sdocPreviewFile(row.src, row.entry.path);
    }
    nav.querySelector('.sdoc-media-prev').addEventListener('click', function() { go(st.prev); });
    nav.querySelector('.sdoc-media-next').addEventListener('click', function() { go(st.next); });
    function onKey(e) {
        if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (document.querySelector('.modal-overlay.show')) return;
        var all = document.querySelectorAll('.wsf-overlay');
        if (!all.length || all[all.length - 1] !== ov || sdocNavKeyIgnored(e.target)) return;
        e.preventDefault();
        go(e.key === 'ArrowRight' ? st.next : st.prev);
    }
    var body = ov.querySelector('.wsf-modal-body'), sx = null, sy = 0;
    if (body) {
        body.addEventListener('touchstart', function(e) {
            var p = e.touches && e.touches[0];
            sx = p && e.touches.length === 1 && !sdocNavKeyIgnored(e.target) ? p.clientX : null; sy = p ? p.clientY : 0;
        }, { passive: true });
        body.addEventListener('touchend', function(e) {
            if (sx == null) return;
            var p = e.changedTouches && e.changedTouches[0], dx = p ? p.clientX - sx : 0, dy = p ? p.clientY - sy : 0;
            sx = null;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? st.next : st.prev);
        });
    }
    document.addEventListener('keydown', onKey, true);
    return { step: st, go: go, cleanup: function() { document.removeEventListener('keydown', onKey, true); } };
}
function sdocBreadcrumbHtml(src) {
    var prN = sdocPrPathNumber(sdocSrcState.path);
    if (prN) return sdocPrBreadcrumbHtml(src, prN);
    var parts = sdocSrcState.path ? sdocSrcState.path.split('/') : [];
    var html = '<div class="sdoc-src-crumbs" role="navigation" aria-label="' + _sdsEsc(_sdsT('Folder path')) + '"><button type="button" class="sdoc-src-crumb" onclick="sdocSrcNavigate(\'\')"' + (parts.length ? '' : ' aria-current="location"') + '>' + _sdocSrcIcon(src) + '<span>' + _sdsEsc(src.label) + '</span></button>';
    for (var i = 0; i < parts.length; i++) html += '<span class="sdoc-src-crumb-sep" aria-hidden="true">/</span><button type="button" class="sdoc-src-crumb" onclick="sdocSrcNavigate(\'' + sdocJsArg(parts.slice(0, i + 1).join('/')) + '\')"' + (i === parts.length - 1 ? ' aria-current="location"' : '') + '>' + _sdsEsc(parts[i]) + '</button>';
    return html + '</div>';
}
function sdocSrcNavigate(path) { sdocSrcState.path = path || ''; sdocRenderSourcesStrip(); renderDocumentsPageItems(); }

// Renders the file part of the unified list after the doc rows; returns true when it drew something.
function sdocRenderFileSection(items, sel, q, docs, preHtml) {
    docs = docs || [];
    var res = sdocCollectFileRows(sel, q);
    sdocSrcState.rendered = res.rows;
    var src = sel !== 'all' && sel !== 'sdocs' ? sdocSrcById(sel) : null;
    var html = preHtml || '';
    if (src && src.type === 'ws' && src.info) html += '<div class="sdoc-ws-infobar" role="group" aria-label="' + _sdsEsc(t('Workspace status')) + '">' + sdocWsInfoHtml(src.info, false) + '</div>';
    if (src && !q) html += sdocBreadcrumbHtml(src);
    // Re-grant / listing warnings live in a polite status region.
    if (res.errors.length) {
        html += '<div class="sdoc-src-notes" role="status" aria-live="polite">';
        res.errors.forEach(function(er) {
            html += '<div class="sdoc-src-note warn">' + _sdsIco(UI_ICONS.alert) + '<span>' + _sdsEsc(er.src.label) + ': ' + _sdsEsc(er.error) + '</span>' +
                (er.needsGrant && er.src.folderId ? _sdocSrcBtn(t('Re-grant'), 'sdocSrcRegrant(\'' + sdocJsArg(er.src.folderId) + '\')', '') : '') + '</div>';
        });
        html += '</div>';
    }
    var unified = sdocUnifiedItems(docs, res.rows), lead = [];
    // Browsing one folder: sub-folders stay first (navigation), files are grouped.
    if (src && !q) {
        lead = unified.filter(function(it) { return it.kind === 'file' && (it.row.entry.kind === 'directory' || it.row.entry.pr); });
        unified = unified.filter(function(it) { return lead.indexOf(it) === -1; });
    }
    // All view: every workspace is a folder row (first, like folders), each directly followed by its PR folders.
    if (!src && sel === 'all' && !q) html += sdocWsFolderRowsHtml(sdocSrcState.sources);
    html += lead.map(_sdocRenderUnified).join('') + sdocGroupedHtml(sdocGroupItems(unified, sdocGetGroupBy(), Date.now()), _sdocRenderUnified);
    (res.more || []).forEach(function(mr) {
        html += '<div class="sdoc-src-note sdoc-src-more">' + _sdsEsc(_sdsT(N_('+{count} more in {source}'), { count: mr.count, source: mr.src.label })) + '</div>';
    });
    if (res.pending) html += '<div class="sdoc-src-note" role="status">' + _sdsEsc(_sdsT('Loading\u2026')) + '</div>';
    else if (res.truncated) html += '<div class="sdoc-src-note">' + _sdsEsc(_sdsT('Showing the first {count} entries.', { count: q ? SDOC_SRC_SEARCH_MAX : SDOC_SRC_LIST_MAX })) + '</div>';
    if (src && !res.rows.length && !res.pending && !res.errors.length) {
        html += '<div class="widget-library-empty sdoc-page-empty"><p class="sdoc-page-empty-title">' + _sdsEsc(q ? _sdsT('No files match \u201c{query}\u201d', { query: q }) : _sdsT('This folder is empty')) + '</p></div>';
    } else if (!src && q && !docs.length && !res.rows.length && !res.pending) {
        // "All" search with no doc and no file hit: keep the pre-Design-E empty state.
        html += '<div class="widget-library-empty sdoc-page-empty">' + UI_ICONS.search +
            '<p class="sdoc-page-empty-title">' + escDisplay(t('No documents match \u201c{query}\u201d', { query: q })) + '</p>' +
            '<p class="widget-library-empty-hint">' + escDisplay(t('Search looks at document titles and content, plus file names and paths.')) + '</p></div>';
    }
    items.innerHTML = html;
    sdocThumbsAttach(items);
    return true;
}

// ─── file actions ───
function sdocOpenFileRow(idx) {
    var row = sdocSrcState.rendered[idx];
    if (!row) return;
    var e = row.entry, src = row.src;
    if (e.kind === 'directory') { sdocSrcState.sel = src.id; sdocSrcState.path = e.path; sdocRenderSourcesStrip(); renderDocumentsPageItems(); return; }
    if (e.pr) return sdocPrOpenFile(src, e);
    return sdocPreviewFile(src, e.path);
}
// opts go to _wsfOverlay (onClose, returnFocus). Without it, onClose runs now.
function _sdocOverlay(title, body, opts) {
    if (typeof _wsfOverlay === 'function') {
        var ov = _wsfOverlay(_sdsEsc(title), body, opts);
        // opts.mediaNav {src, path}: prev/next over the listing; opts._navCleanup is run by the caller's onClose.
        if (opts && opts.mediaNav) { var nav = sdocAttachMediaNav(ov, opts.mediaNav.src, opts.mediaNav.path); if (nav) opts._navCleanup = nav.cleanup; }
        return ov;
    }
    if (opts && typeof opts.onClose === 'function') opts.onClose();
    if (typeof showSnackbar === 'function') showSnackbar(title, 'info');
    return null;
}
// Inline media/PDF previews stream a blob: URL of the File (never read into
// memory); past this size the overlay only offers Download.
var SDOC_PREVIEW_MAX_BYTES = 200 * 1024 * 1024;
var SDOC_PREVIEW_IMG_MAX = 10 * 1024 * 1024;
function sdocFileRowEl(srcId, path) {
    var els = document.querySelectorAll('.sdoc-file-item');
    for (var i = 0; i < els.length; i++) if (els[i].getAttribute('data-src-id') === srcId && els[i].getAttribute('data-path') === path) return els[i];
    return null;
}
// video / audio: native controls. pdf: the same <iframe> viewer as the chat
// attachment preview (openPdfModal, app/050-image-attachments.js), fed a
// blob: URL instead of a data: URL.
function sdocMediaHtml(kind, url, name) {
    var u = _sdsEsc(url);
    if (kind === 'video') { var vl = _sdsEsc(t('Video: {name}', { name: name })); return '<video class="sdoc-file-preview-media" controls preload="metadata" src="' + u + '" title="' + vl + '" aria-label="' + vl + '"></video>'; }
    if (kind === 'audio') { var al = _sdsEsc(t('Audio: {name}', { name: name })); return '<audio class="sdoc-file-preview-audio" controls preload="metadata" src="' + u + '" title="' + al + '" aria-label="' + al + '"></audio>'; }
    return '<iframe class="sdoc-file-preview-pdf" src="' + u + '" title="' + _sdsEsc(t('PDF Preview') + ': ' + name) + '"></iframe>';
}
function sdocNoPreviewHtml(msg, dlUrl, name) {
    return '<div class="wsf-empty sdoc-file-nopreview"><p>' + _sdsEsc(msg) + '</p>' +
        (dlUrl ? '<a class="skills-action-btn sdoc-src-btn sdoc-file-dl" href="' + _sdsEsc(dlUrl) + '" download="' + _sdsEsc(name || 'file') + '">' + UI_ICONS.download + '<span>' + _sdsEsc(t('Download')) + '</span></a>' : '') + '</div>';
}
async function sdocPreviewFile(src, path) {
    // Every blob: URL made for this overlay is revoked when it closes.
    var urls = [];
    function objUrl(blob) { var u = URL.createObjectURL(blob); urls.push(u); return u; }
    function revoke() { while (urls.length) { try { URL.revokeObjectURL(urls.pop()); } catch (_) {} } }
    var opts = { onClose: function() { revoke(); if (opts._navCleanup) { opts._navCleanup(); opts._navCleanup = null; } },
        returnFocus: function() { return sdocFileRowEl(src.id, path); }, mediaNav: { src: src, path: path } };
    try {
        if (src.type === 'ws') {
            var rec = typeof getWorkspaceFile === 'function' ? await getWorkspaceFile(src.wk, path) : null;
            if (!rec) throw new Error(_sdsT('File not found'));
            var change = sdocWsFileChange(rec);
            var meta = '<div class="wsf-file-meta">' + _sdsEsc(src.wk) + (change ? ' \u00B7 ' + sdocWsChangeBadgeHtml(change) : '') + '</div>';
            // Workspace rows hold text or '::binary::<base64>': images render through an <img>
            // data: URL (SVG included, never inlined); other binary kinds get no inline preview.
            var wk = sdocPreviewKind(path);
            // Changed text file: colored line diff against the cloned base, with a Diff / File toggle.
            var diffHtml = change && !wk ? sdocWsDiffViewHtml((change === 'new' || change === 'added') ? '' : rec.original_content, change === 'deleted' ? '' : rec.content) : '';
            if (diffHtml) return _sdocOverlay(path, meta + diffHtml, opts);
            if (wk === 'image' || (!wk && rec.stub && rec.content == null)) {
                // Lazy clone stub: open the overlay with a loading state, then fetch the blob on demand.
                var ov = _sdocOverlay(path, meta + '<div class="sdoc-ws-load" data-wk="' + _sdsEsc(src.wk) + '" data-path="' + _sdsEsc(path) + '"></div>', opts);
                await _sdocWsLoadInto(ov && ov.querySelector ? ov.querySelector('.sdoc-ws-load') : null);
                return ov;
            }
            return _sdocOverlay(path, meta + (wk && wk !== 'image' ? sdocNoPreviewHtml(t('No preview available for this file type.'), null)
                : '<pre class="wsf-code">' + _sdsEsc(String(rec.content || '').slice(0, 200000)) + '</pre>'), opts);
        }
        var g = await lfGetFile(src.folderId, path);
        var kind = sdocPreviewKind(g.name, g.mime);
        var head = '<div class="wsf-file-meta">' + _sdsEsc(src.label) + ' \u00B7 ' + _sdsEsc(_sdsSize(g.size)) + ' \u00B7 ' + _sdsEsc(g.mime) + '</div>';
        var tooBig = function() { return _sdocOverlay(path, head + sdocNoPreviewHtml(t('Too large to preview ({size}).', { size: _sdsSize(g.size) }), objUrl(g.file), g.name), opts); };
        if (g.size > SDOC_PREVIEW_MAX_BYTES) return tooBig();
        if (kind === 'video' || kind === 'audio' || kind === 'pdf') {
            // The PDF viewer keys off the blob type; re-wrapping a File does not read it.
            var blob = kind === 'pdf' && g.file.type !== 'application/pdf' ? new Blob([g.file], { type: 'application/pdf' }) : g.file;
            return _sdocOverlay(path, head + sdocMediaHtml(kind, objUrl(blob), g.name), opts);
        }
        // Text / images are read into memory: stay under the read cap.
        if (typeof LF_LIMITS !== 'undefined' && LF_LIMITS.maxReadBytes && g.size > LF_LIMITS.maxReadBytes) return tooBig();
        var r = await lfReadFileBytes(src.folderId, path);
        if ((kind === 'image' || /^image\//.test(r.mime)) && r.size <= SDOC_PREVIEW_IMG_MAX) {
            return _sdocOverlay(path, head + '<img class="sdoc-file-preview-img" alt="" src="data:' + _sdsEsc(r.mime) + ';base64,' + lfBytesToBase64(r.bytes) + '">', opts);
        }
        if (typeof lfIsBinary === 'function' && !lfIsBinary(r.name, r.bytes)) {
            var text = new TextDecoder('utf-8').decode(r.bytes.subarray(0, 400000));
            return _sdocOverlay(path, head + '<pre class="wsf-code">' + _sdsEsc(text.slice(0, 200000)) + '</pre>', opts);
        }
        return _sdocOverlay(path, head + sdocNoPreviewHtml(t('No preview available for this file type.'), objUrl(g.file), g.name), opts);
    } catch (err) {
        revoke();
        if (typeof showSnackbar === 'function') showSnackbar(_sdsT('Could not open file: {error}', { error: String((err && err.message) || err) }), 'error');
        return null;
    }
}
// Fill a .sdoc-ws-load host (data-wk, data-path) from wsReadRaw: loading -> code, or error + Retry.
async function _sdocWsLoadInto(host) {
    if (!host) return null;
    var wk = host.getAttribute('data-wk'), path = host.getAttribute('data-path');
    host.innerHTML = '<div class="wsf-empty sdoc-ws-loading" role="status">' + _sdsEsc(t('Loading file\u2026')) + '</div>';
    if (sdocImageMime(path)) return _sdocWsImageInto(host, wk, path);
    var r;
    try { r = typeof wsReadRaw === 'function' ? await wsReadRaw(wk, path) : { success: false, error: t('unknown error') }; }
    catch (e) { r = { success: false, error: String((e && e.message) || e) }; }
    if (r && r.success && r.file) {
        host.innerHTML = '<pre class="wsf-code">' + _sdsEsc(String(r.file.content || '').slice(0, 200000)) + '</pre>';
        return true;
    }
    var err = String((r && r.error) || '');
    var msg = /^Binary file/.test(err) ? t('No preview available for this file type.')
        : _sdocGhRateLimited(err) ? _sdocGhRateText()
        : t('Could not load {file}: {error}', { file: path, error: err || t('unknown error') });
    host.innerHTML = '<div class="wsf-empty sdoc-ws-load-err" role="alert"><p>' + _sdsEsc(msg) + '</p>' +
        (/^Binary file/.test(err) ? '' : _sdocSrcBtn(t('Retry'), 'sdocWsRetryPreview(this)', 'wsretry', '', null, UI_ICONS.refresh)) + '</div>';
    return false;
}
// ─── Workspace images: '::binary::<raw base64>' (or SVG text) -> data: URL ───
var SDOC_IMAGE_MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
// MIME type of an image file name ('' when not a previewable image).
function sdocImageMime(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return (m && SDOC_IMAGE_MIMES[m[1].toLowerCase()]) || '';
}
function _sdocUtf8ToB64(text) {
    var bytes = new TextEncoder().encode(String(text)), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
// Workspace content -> data: URL, or null when not an image / undecodable / over the cap.
// Binary blobs are stored as '::binary::<raw base64>'; SVG is stored as UTF-8 text.
function sdocWsImageDataUrl(path, content, maxBytes) {
    var mime = sdocImageMime(path);
    if (!mime || typeof content !== 'string') return null;
    var cap = maxBytes || SDOC_PREVIEW_IMG_MAX, b64;
    if (content.indexOf('::binary::') === 0) b64 = content.slice(10).replace(/\s+/g, '');
    else if (mime === 'image/svg+xml') b64 = _sdocUtf8ToB64(content);
    else return null;
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || Math.floor(b64.length * 3 / 4) > cap) return null;
    return 'data:' + mime + ';base64,' + b64;
}
async function _sdocWsImageInto(host, wk, path) {
    var url = null, err = '';
    try {
        var rec = typeof getWorkspaceFile === 'function' ? await getWorkspaceFile(wk, path) : null;
        if (rec && rec.stub && rec.content == null && typeof wsHydrate === 'function') { await wsHydrate(wk, [path]); rec = await getWorkspaceFile(wk, path); }
        if (!rec || rec.content == null) throw new Error(_sdsT('File not found'));
        url = sdocWsImageDataUrl(path, rec.content);
    } catch (e) { err = String((e && e.message) || e); }
    if (url) {
        // SVG too goes through <img> only: scripts in it never run.
        host.innerHTML = '<img class="sdoc-file-preview-img" alt="' + _sdsEsc(t('Image: {name}', { name: path.split('/').pop() })) + '" src="' + _sdsEsc(url) + '">';
        return true;
    }
    host.innerHTML = '<div class="wsf-empty sdoc-ws-load-err" role="alert"><p>' + _sdsEsc(err ? t('Could not load {file}: {error}', { file: path, error: err }) : t('No preview available for this file type.')) + '</p>' +
        (err ? _sdocSrcBtn(t('Retry'), 'sdocWsRetryPreview(this)', 'wsretry', '', null, UI_ICONS.refresh) : '') + '</div>';
    return false;
}
function sdocWsRetryPreview(btn) {
    return _sdocWsLoadInto(btn && btn.closest ? btn.closest('.sdoc-ws-load') : null);
}
async function sdocDownloadFileRow(idx) {
    var row = sdocSrcState.rendered[idx];
    if (!row || row.src.type === 'ws') return;
    if (row.entry.kind === 'directory') return sdocDownloadFolder(row.src, row.entry);
    if (typeof lfReadFileAsDataUrl !== 'function') return;
    try {
        var r = await lfReadFileAsDataUrl(row.src.folderId, row.entry.path);
        var a = document.createElement('a');
        a.href = r.data_url; a.download = r.name || 'file';
        document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { if (typeof showSnackbar === 'function') showSnackbar(_sdsT('Download failed: {error}', { error: String((e && e.message) || e) }), 'error'); }
}
async function sdocDeleteFileRow(idx) {
    var row = sdocSrcState.rendered[idx];
    if (!row || !sdocSrcWritable(row.src) || typeof lfDeleteEntry !== 'function') return;
    var isDir = row.entry.kind === 'directory';
    if (!await showConfirmModal(_sdsT(isDir ? 'Delete folder' : 'Delete file'), _sdsT(isDir ? 'Delete {file} and everything in it from {folder}?' : 'Delete {file} from {folder}?', { file: '<strong>' + escapeHtml(row.entry.path) + '</strong>', folder: escapeHtml(row.src.label) }), 'danger')) return;
    try { await lfDeleteEntry(row.src.folderId, row.entry.path, isDir); sdocSelection.delete(sdocSelKeyOf({ kind: 'file', row: row })); }
    catch (e) { if (typeof showSnackbar === 'function') showSnackbar(_sdsT('Delete failed: {error}', { error: String((e && e.message) || e) }), 'error'); }
    sdocSrcInvalidate(row.src.id);
    renderDocumentsPageItems();
}
function sdocSrcInvalidate(srcId) {
    Object.keys(sdocSrcState.listings).forEach(function(k) { if (k.indexOf(srcId + '#') === 0) delete sdocSrcState.listings[k]; });
}
// Folder management (the only UI for it since the Settings section was
// removed): pickLocalFolder / regrantLocalFolder start synchronously inside
// the click (user activation).
function _sdocAfterFolderChange() {
    sdocResetSources();
    return sdocRefreshSources();
}
// Rename a connected folder's label from its card.
async function sdocSrcRename(folderId) {
    var src = sdocSrcById('lf:' + folderId);
    if (!src || typeof showPromptModal !== 'function' || typeof updateLocalFolder !== 'function') return null;
    var name = await showPromptModal(t('Rename folder'), t('New label'), src.label);
    name = name == null ? '' : String(name).trim();
    if (!name || name === src.label) return null;
    try { await updateLocalFolder(folderId, { label: name }); }
    catch (e) { if (typeof showSnackbar === 'function') showSnackbar(t('Rename failed') + ': ' + String((e && e.message) || e), 'error'); }
    return _sdocAfterFolderChange();
}

// ─── Agent Files upload (Upload button + drag & drop on its card) ───
// Same OPFS helper the agent uses (lfWriteFileBytes into the virtual folder).
function _sdocVirtualId() { return typeof LOCAL_FOLDER_VIRTUAL_ID !== 'undefined' ? LOCAL_FOLDER_VIRTUAL_ID : 'virtual'; }
async function sdocUploadToAgentFiles(fileList) {
    return sdocUploadToSource(sdocSrcById('lf:' + _sdocVirtualId()) || { id: 'lf:' + _sdocVirtualId(), type: 'virtual', folderId: _sdocVirtualId(), label: 'Agent Files' }, fileList);
}
// Upload target of a source: Agent Files or a read & write local folder (a
// not-yet-granted one needs a permission prompt first). null for read-only
// folders, GitHub workspaces and Smart Docs. dir = the browsed directory when
// that source is the selected one, else its root.
function sdocUploadTarget(src, sel, path) {
    if (!src || !(src.type === 'virtual' || (src.type === 'local' && src.access === 'readwrite'))) return null;
    return { srcId: src.id, folderId: src.type === 'virtual' ? _sdocVirtualId() : src.folderId, dir: sel === src.id ? String(path || '').replace(/^\/+|\/+$/g, '') : '',
        needsGrant: src.type === 'local' && src.permission !== 'granted' };
}
// File-name conflict: "a.png" -> "a (1).png", "a (2).png"... first name not in taken.
function sdocUniqueName(name, taken) {
    name = String(name || 'file');
    var has = function(n) { return taken && (typeof taken.has === 'function' ? taken.has(n) : taken.indexOf(n) !== -1); };
    if (!has(name)) return name;
    var dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (var n = 1; n < 10000; n++) { var c = base + ' (' + n + ')' + ext; if (!has(c)) return c; }
    return base + ' (' + Date.now() + ')' + ext;
}
async function sdocUploadToSource(src, fileList, opts) {
    opts = opts || {};
    var tg = sdocUploadTarget(src, sdocSrcState.sel, sdocSrcState.path);
    var files = Array.prototype.slice.call(fileList || []);
    var snack = function(m, k) { if (typeof showSnackbar === 'function') showSnackbar(m, k); };
    if (!tg) { snack(t('This folder is read only.'), 'error'); return { uploaded: 0, failed: [] }; }
    if (tg.needsGrant) {
        // Re-grant: the prompt needs a user gesture (the click / drop that got us here).
        var st = 'denied';
        try { st = typeof regrantLocalFolder === 'function' ? await (opts.grant || regrantLocalFolder(tg.folderId)) : 'none'; } catch (e) { st = String((e && e.message) || e); }
        if (st !== 'granted') { snack(_sdsT('Access was not granted ({state})', { state: st }), 'error'); return { uploaded: 0, failed: [] }; }
    }
    var cached = sdocSrcState.listings[tg.srcId + '#' + tg.dir], taken = new Set();
    ((cached && cached.entries) || []).forEach(function(e) { if (e && e.name) taken.add(e.name); });
    var ok = 0, failed = [];
    for (var i = 0; i < files.length; i++) {
        var f = files[i], name = sdocUniqueName(f.name, taken);
        try {
            if (typeof lfWriteFileBytes !== 'function') throw new Error(_sdsT('Connected folders are not available in this build.'));
            await lfWriteFileBytes(tg.folderId, tg.dir ? tg.dir + '/' + name : name, new Uint8Array(await f.arrayBuffer()));
            taken.add(name); ok++;
        } catch (e) { failed.push(f.name + ' (' + String((e && e.message) || e) + ')'); }
    }
    if (ok) snack(src.type === 'virtual' ? tn(ok, 'Uploaded {count} file to Agent Files', 'Uploaded {count} files to Agent Files')
        : tn(ok, 'Uploaded {count} file to {folder}', 'Uploaded {count} files to {folder}', { folder: src.label }), 'success');
    if (failed.length) snack(t('Upload failed: {files}', { files: failed.join(', ') }), 'error');
    sdocSrcInvalidate(tg.srcId);
    if (tg.needsGrant && typeof sdocRefreshSources === 'function') { try { await sdocRefreshSources(); } catch (e) {} }
    sdocRenderSourcesStrip(); renderDocumentsPageItems();
    return { uploaded: ok, failed: failed };
}
// Upload button of a read & write local folder: same body-level input as Agent Files.
// A not-granted folder asks for permission inside this click (user activation) first.
function sdocFolderPickUpload(srcId) {
    var src = sdocSrcById(srcId), tg = sdocUploadTarget(src, sdocSrcState.sel, sdocSrcState.path);
    if (!tg) return null;
    var grant = null;
    if (tg.needsGrant && typeof regrantLocalFolder === 'function') { try { grant = regrantLocalFolder(tg.folderId); } catch (e) { grant = Promise.reject(e); } }
    var inp = sdocAgentFilesPickUpload();
    inp._sdocTarget = srcId; inp._sdocGrant = grant;
    return inp;
}
// The file input lives on <body>, outside the re-rendered row, so a row
// re-render while the OS picker is open cannot drop its change event.
function sdocAgentFilesPickUpload() {
    var inp = document.getElementById('sdoc-upload-input');
    if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.id = 'sdoc-upload-input'; inp.hidden = true;
        inp.addEventListener('change', function() { sdocAgentFilesUploadFromInput(inp); });
        document.body.appendChild(inp);
    }
    inp._sdocTarget = null; inp._sdocGrant = null;
    inp.click();
    return inp;
}
function sdocAgentFilesUploadFromInput(input) {
    var files = input && input.files;
    var tid = input && input._sdocTarget, tsrc = tid ? sdocSrcById(tid) : null;
    var p = !(files && files.length) ? Promise.resolve({ uploaded: 0, failed: [] })
        : tsrc ? sdocUploadToSource(tsrc, files, { grant: input._sdocGrant }) : sdocUploadToAgentFiles(files);
    return p.then(function(r) { try { input.value = ''; } catch (e) {} return r; });
}
// Pure: where a drop on this source writes. Only the built-in Agent Files
// ('virtual') or a read & write local folder accept files; anything else is ignored.
function sdocDropTarget(src) {
    if (!src) return null;
    if (src.type === 'virtual') return 'agent';
    if (src.type === 'local' && src.access === 'readwrite') return 'folder';
    return null;
}
// Drag & drop onto the Agent Files card (.sdoc-src-drop). Delegated, bound
// once on the persistent #documents-sources host (the cards are re-rendered).
function sdocBindAgentFilesDrop(host) {
    if (!host || host._sdocDropBound || !host.addEventListener) return;
    host._sdocDropBound = true;
    function zone(ev) { return ev.target && ev.target.closest ? ev.target.closest('.sdoc-src-drop') : null; }
    function hasFiles(ev) { var dt = ev.dataTransfer; return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') !== -1; }
    host.addEventListener('dragover', function(ev) { var z = zone(ev); if (!z || !hasFiles(ev)) return; ev.preventDefault(); z.classList.add('dragover'); });
    host.addEventListener('dragleave', function(ev) { var z = zone(ev); if (z && !z.contains(ev.relatedTarget)) z.classList.remove('dragover'); });
    host.addEventListener('drop', function(ev) {
        var z = zone(ev);
        if (!z) return;
        ev.preventDefault(); z.classList.remove('dragover');
        var files = ev.dataTransfer && ev.dataTransfer.files;
        if (!files || !files.length) return;
        // Rail item: its data-src-id; the pane: the selected source.
        var sid = z.getAttribute('data-src-id') || sdocSrcState.sel, src = sdocSrcById(sid);
        var dest = sdocDropTarget(src);
        if (dest === 'agent') sdocUploadToAgentFiles(files);
        else if (dest === 'folder') {
            // Rm6 (#1088): a drop is not user activation, so requestPermission()
            // from here would be rejected — ask for an explicit Re-grant click.
            var dtg = sdocUploadTarget(src, sdocSrcState.sel, sdocSrcState.path);
            if (dtg && dtg.needsGrant) { if (typeof showSnackbar === 'function') showSnackbar(_sdsT(N_('Access needs to be re-granted.')), 'info'); return; }
            sdocUploadToSource(src, files);
        }
        // otherwise (read-only folder, unknown source): ignore, no write.
    });
}
function sdocSrcConnect() {
    var access = sdocSrcState.addAccess === 'readwrite' ? 'readwrite' : 'read';
    var p;
    sdocSrcState.addErr = '';
    // pickLocalFolder first: the directory picker needs the click's user activation.
    try { p = pickLocalFolder(access, ''); } catch (e) { p = Promise.reject(e); }
    sdocSrcState.addBusy = true; _sdocAddModalRender();
    return Promise.resolve(p).then(function(entry) {
        sdocSrcState.addBusy = false;
        if (entry) {
            // Close the add-source popover and select (and persist) the new folder.
            sdocSrcState.addOpen = false; sdocSrcState.sel = 'lf:' + entry.id; sdocSrcState.path = '';
            try { if (typeof appStorage !== 'undefined' && appStorage) appStorage.setItem('documentsPageSource', sdocSrcState.sel); } catch (e) {}
            if (typeof showSnackbar === 'function') showSnackbar(_sdsT('Connected {folder}', { folder: entry.label }), 'success');
        }
        return _sdocAfterFolderChange();
    }, function(e) {
        var msg = _sdsT('Could not connect folder') + ': ' + String((e && e.message) || e);
        sdocSrcState.addBusy = false; sdocSrcState.addErr = msg; _sdocAddModalRender(); // inline, in the modal
        if (typeof showSnackbar === 'function') showSnackbar(msg, 'error');
    });
}
function sdocSrcRegrant(folderId) {
    var p;
    try { p = regrantLocalFolder(folderId); } catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(function(state) {
        if (state !== 'granted' && typeof showSnackbar === 'function') showSnackbar(_sdsT('Access was not granted ({state})', { state: state }), 'error');
        return _sdocAfterFolderChange();
    }, function(e) { if (typeof showSnackbar === 'function') showSnackbar(_sdsT('Re-grant failed') + ': ' + String((e && e.message) || e), 'error'); });
}
// Change a connected folder's access from its card: updateLocalFolder, then regrantLocalFolder when upgrading, so the
// browser asks for readwrite permission. The chain starts synchronously in the
// click/keydown (nothing awaited before it) to keep the user activation. A
// refused upgrade rolls the stored access back, then the page re-renders.
function sdocSrcSetAccess(folderId, access) {
    access = access === 'readwrite' ? 'readwrite' : 'read';
    var src = sdocSrcById('lf:' + folderId), prev = src && src.access === 'readwrite' ? 'readwrite' : 'read';
    var label = src ? src.label : folderId;
    function note(msg, kind) { if (typeof showSnackbar === 'function') showSnackbar(msg, kind); }
    function rollback() {
        if (prev === access || typeof updateLocalFolder !== 'function') return Promise.resolve();
        return Promise.resolve().then(function() { return updateLocalFolder(folderId, { access: prev }); }).catch(function() {});
    }
    var p;
    try {
        if (typeof updateLocalFolder !== 'function') throw new Error(_sdsT('Connected folders are not available in this build.'));
        p = updateLocalFolder(folderId, { access: access }).then(function() {
            return access === 'readwrite' && typeof regrantLocalFolder === 'function' ? regrantLocalFolder(folderId) : 'granted';
        });
    } catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(function(state) {
        if (state === 'granted') {
            note(access === 'readwrite' ? _sdsT('{folder} is now read & write', { folder: label }) : _sdsT('{folder} is now read only', { folder: label }), 'success');
            return _sdocAfterFolderChange();
        }
        note(_sdsT('Write access was not granted ({state})', { state: state }), 'error');
        return rollback().then(_sdocAfterFolderChange);
    }, function(e) {
        note(_sdsT('Could not change access') + ': ' + String((e && e.message) || e), 'error');
        return rollback().then(_sdocAfterFolderChange);
    });
}
async function sdocSrcDisconnect(folderId) {
    if (!await showConfirmModal(_sdsT('Remove folder'), _sdsT('Forget this folder? Nothing on disk is deleted; the agent loses access.'), 'danger')) return;
    try { await removeLocalFolder(folderId); }
    catch (e) { if (typeof showSnackbar === 'function') showSnackbar(_sdsT('Could not remove folder') + ': ' + String((e && e.message) || e), 'error'); }
    if (sdocSrcState.sel === 'lf:' + folderId) { sdocSrcState.sel = 'all'; sdocSrcState.path = ''; }
    return _sdocAfterFolderChange();
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

// ─── Bulk selection: select, Select all, Delete and Download (Documents page) ───
// Keys are stable across re-renders: 'doc:<id>' for smart docs, '<sourceId>:<path>'
// for files. sdocSelVisible lists what the current render shows (Select all and
// Mod+A act on it); sdocSelMeta remembers the item behind every key ever shown.
var sdocSelection = new Set();
var sdocSelVisible = [];
var sdocSelMeta = new Map();
// Selection mode: checkboxes, Select all and the bulk bar only show while it is on
// (toolbar Select button, "s"; "x" and Mod+A enter it). Leaving it clears the selection.
var sdocSelMode = false;
// Pure: selection mode after an action. 'mode' toggles; 'toggle' / 'all' enter; 'clear' / 'exit' leave.
function sdocSelModeAfter(action, mode) {
    if (action === 'mode') return !mode;
    if (action === 'toggle' || action === 'all') return true;
    if (action === 'clear' || action === 'exit') return false;
    return !!mode;
}
function sdocSelKeyDoc(id) { return 'doc:' + String(id); }
function sdocSelKeyFile(srcId, path) { return String(srcId) + ':' + String(path || ''); }
// Trailing '/' keeps a folder key distinct from a same-named file key.
function sdocSelKeyFolder(srcId, path) { return String(srcId) + ':' + String(path || '') + '/'; }
function sdocSelKeyOf(it) {
    if (!it) return '';
    if (it.kind === 'doc') return it.doc ? sdocSelKeyDoc(it.doc.id) : '';
    var e = (it.row && it.row.entry) || {}, src = (it.row && it.row.src) || {};
    if (e.pr) return ''; // PR folder files are read-only (no select / bulk actions)
    if (e.kind === 'directory') return e.path ? sdocSelKeyFolder(src.id, e.path) : '';
    return e.kind === 'file' ? sdocSelKeyFile(src.id, e.path) : '';
}
// Drops file/folder items that sit inside another selected folder of the same source
// (the folder already covers them for delete and download).
function sdocSelDedupeNested(items) {
    var dirs = (items || []).filter(function(it) { return it && it.kind !== 'doc' && it.row && it.row.entry && it.row.entry.kind === 'directory'; });
    return (items || []).filter(function(it) {
        if (!it || it.kind === 'doc' || !it.row) return true;
        var p = String(it.row.entry.path || '');
        return !dirs.some(function(d) { return d !== it && d.row.src.id === it.row.src.id && p.indexOf(String(d.row.entry.path) + '/') === 0; });
    });
}
// Pure: zip entries of a recursive folder listing; folders in the listing are skipped.
// No prefix: names are relative to the folder's parent (<folder>/<sub>/<file>, for <folder>.zip).
// With prefix: prefix/<full source path>, matching individually selected files in a bulk zip.
function sdocFolderZipEntries(folderPath, entries, prefix) {
    var fp = String(folderPath || ''), slash = fp.lastIndexOf('/'), parent = prefix || slash < 0 ? '' : fp.slice(0, slash + 1);
    return (entries || []).filter(function(c) { return c && c.kind === 'file' && String(c.path).indexOf(fp + '/') === 0; })
        .map(function(c) { return { path: c.path, name: (prefix ? prefix + '/' : '') + String(c.path).slice(parent.length), date: c.lastModified || 0 }; });
}
// Pure selection model (unit-tested in test/documents-bulk.test.js).
function sdocSelToggle(set, key) {
    if (set.has(key)) { set.delete(key); return false; }
    set.add(key); return true;
}
function sdocSelApply(set, keys, on) {
    (keys || []).forEach(function(k) { if (on) set.add(k); else set.delete(k); });
    return set;
}
// 'none' | 'some' | 'all' of keys that are in set (no keys -> 'none').
function sdocSelState(set, keys) {
    var n = 0;
    (keys || []).forEach(function(k) { if (set.has(k)) n++; });
    return !n ? 'none' : n === keys.length ? 'all' : 'some';
}
// Select all toggle: all selected -> clear them; none/some -> select them all.
function sdocSelToggleAll(set, keys) {
    var on = sdocSelState(set, keys) !== 'all';
    sdocSelApply(set, keys, on);
    return on;
}
// Delete partition: smart docs and files/folders (recursive) in writable connected folders
// are deletable; workspace (GitHub) entries and read-only folders are skipped. Entries
// inside a selected folder are folded into it.
function sdocBulkPartition(items, canWrite) {
    var out = { deletable: [], skipped: [] };
    sdocSelDedupeNested(items).forEach(function(it) {
        if (it && it.kind === 'doc') { out.deletable.push(it); return; }
        var src = (it && it.row && it.row.src) || {}, e = (it && it.row && it.row.entry) || {};
        var ok = (e.kind === 'file' || (e.kind === 'directory' && !!e.path)) && src.type !== 'ws' && typeof canWrite === 'function' && !!canWrite(src);
        (ok ? out.deletable : out.skipped).push(it);
    });
    return out;
}
// Download partition: smart docs and connected-folder files/folders (any access); workspace entries are skipped.
function sdocDownloadPartition(items) {
    var out = { items: [], skipped: [] };
    sdocSelDedupeNested(items).forEach(function(it) {
        var src = (it && it.row && it.row.src) || {}, e = (it && it.row && it.row.entry) || {};
        var ok = it && (it.kind === 'doc' || ((e.kind === 'file' || e.kind === 'directory') && src.type !== 'ws'));
        (ok ? out.items : out.skipped).push(it);
    });
    return out;
}
// "Deleted 3 items · 2 read-only items skipped · 1 failed"
function sdocBulkResultText(done, skipped, failed, skipOne, skipOther) {
    var parts = [];
    if (done) parts.push(_sdsTn(done, N_('Deleted {count} item'), N_('Deleted {count} items')));
    if (skipped) parts.push(_sdsTn(skipped, skipOne || N_('{count} read-only item skipped'), skipOther || N_('{count} read-only items skipped')));
    if (failed) parts.push(_sdsTn(failed, N_('{count} failed'), N_('{count} failed')));
    return parts.join(' \u00B7 ');
}
function _sdsTn(n, one, other, p) {
    if (typeof tn === 'function') return tn(n, one, other, p);
    return (n === 1 ? one : other).replace('{count}', String(n));
}
// Pure keyboard guard: may a Documents selection shortcut run?
function sdocKbdGuard(action, st) {
    st = st || {};
    if (st.view !== 'documents' || st.overlay) return false;
    if (action === 'mode') return true;
    if (action === 'toggle') return !!st.focusedKey;
    if (action === 'all') return (st.visible || 0) > 0;
    if (action === 'delete') return (st.size || 0) > 0;
    if (action === 'clear') return !!st.mode || (st.size || 0) > 0;
    return false;
}
function sdocKbdCan(action) {
    if (typeof document === 'undefined') return false;
    return sdocKbdGuard(action, {
        view: typeof currentView !== 'undefined' ? currentView : '',
        overlay: !!document.querySelector('.modal-overlay.show, .sdoc-preview-modal'),
        focusedKey: sdocSelFocusedKey(), visible: sdocSelVisible.length, size: sdocSelection.size, mode: sdocSelMode
    });
}

// ─── Store-only zip (no compression), pure ───
var _SDOC_CRC_TABLE = null;
function sdocCrc32(bytes) {
    if (!_SDOC_CRC_TABLE) {
        _SDOC_CRC_TABLE = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            _SDOC_CRC_TABLE[n] = c >>> 0;
        }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = _SDOC_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
function _sdocDosTime(ms) {
    var d = new Date(ms || 0);
    if (!ms || isNaN(d.getTime()) || d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
// Safe relative path (no '..', '.', leading '/', backslashes) unique within used (case-insensitive).
function sdocZipName(name, used) {
    var segs = String(name || '').replace(/\\/g, '/').split('/').filter(function(s) { return s && s !== '.' && s !== '..'; });
    var base = segs.join('/') || 'file', out = base, n = 2;
    used = used || {};
    while (used[out.toLowerCase()]) {
        var slash = base.lastIndexOf('/'), dot = base.lastIndexOf('.');
        out = dot > slash + 1 ? base.slice(0, dot) + ' (' + n + ')' + base.slice(dot) : base + ' (' + n + ')';
        n++;
    }
    used[out.toLowerCase()] = true;
    return out;
}
// files: [{name, bytes: Uint8Array, date?: ms}] -> Uint8Array of a stored (method 0) zip with UTF-8 names.
function sdocZipStore(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0, cdSize = 0;
    (files || []).forEach(function(f) {
        var name = enc.encode(f.name), data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes || []);
        var crc = sdocCrc32(data), dt = _sdocDosTime(f.date);
        var lh = new Uint8Array(30 + name.length), v = new DataView(lh.buffer);
        v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
        v.setUint16(10, dt.time, true); v.setUint16(12, dt.date, true); v.setUint32(14, crc, true);
        v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
        lh.set(name, 30);
        var cd = new Uint8Array(46 + name.length), w = new DataView(cd.buffer);
        w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true); w.setUint16(10, 0, true);
        w.setUint16(12, dt.time, true); w.setUint16(14, dt.date, true); w.setUint32(16, crc, true);
        w.setUint32(20, data.length, true); w.setUint32(24, data.length, true); w.setUint16(28, name.length, true);
        w.setUint32(42, offset, true);
        cd.set(name, 46);
        parts.push(lh, data); central.push(cd);
        offset += lh.length + data.length; cdSize += cd.length;
    });
    var end = new Uint8Array(22), x = new DataView(end.buffer);
    x.setUint32(0, 0x06054b50, true); x.setUint16(8, central.length, true); x.setUint16(10, central.length, true);
    x.setUint32(12, cdSize, true); x.setUint32(16, offset, true);
    var all = parts.concat(central, [end]), total = 0;
    all.forEach(function(p) { total += p.length; });
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function(p) { out.set(p, pos); pos += p.length; });
    return out;
}

// ─── Bulk selection: DOM wiring (page only; every DOM path is guarded) ───
function _sdocSelRegister(it) {
    var key = sdocSelKeyOf(it);
    if (!key) return;
    sdocSelVisible.push(key);
    sdocSelMeta.set(key, it.kind === 'doc' ? { kind: 'doc', doc: it.doc } : { kind: 'file', row: it.row });
}
function _sdocSelCheckHtml(key, name, checked) {
    var lbl = _sdsT(N_('Select {name}'), { name: name || '' });
    return '<span class="sdoc-sel" onclick="event.stopPropagation()"><input type="checkbox" class="sdoc-sel-check" data-sel-key="' + _sdsEsc(key) + '"' + (checked ? ' checked' : '') +
        ' aria-label="' + _sdsEsc(lbl) + '" title="' + _sdsEsc(lbl + ' (X)') + '" aria-keyshortcuts="X" onchange="sdocSelOnChange(this)"></span>';
}
// Selected items that still resolve (deleted docs drop out of the selection).
function sdocSelectedItems() {
    var out = [];
    Array.from(sdocSelection).forEach(function(k) {
        var it = sdocSelMeta.get(k);
        if (it && it.kind === 'doc') it = smartDocuments[it.doc.id] ? { kind: 'doc', doc: smartDocuments[it.doc.id] } : null;
        if (it) out.push(it); else sdocSelection.delete(k);
    });
    return out;
}
function sdocSelFocusedKey() {
    if (typeof document === 'undefined') return null;
    var a = document.activeElement, item = a && a.closest ? a.closest('#documents-items [data-sel-key]') : null;
    return item ? item.getAttribute('data-sel-key') : null;
}
function _sdocSelPaint() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('#documents-items [data-sel-key].sdoc-lib-item').forEach(function(el) {
        var on = sdocSelection.has(el.getAttribute('data-sel-key'));
        el.classList.toggle('is-selected', on);
        var cb = el.querySelector('.sdoc-sel-check');
        if (cb) cb.checked = on;
    });
}
function sdocSelOnChange(el) {
    var key = el && el.getAttribute('data-sel-key');
    if (!key) return;
    sdocSelApply(sdocSelection, [key], !!el.checked);
    _sdocSelPaint();
    sdocSyncBulkUi();
}
function sdocSelToggleFocused() {
    var key = sdocSelFocusedKey();
    if (!key) return false;
    sdocSelMode = sdocSelModeAfter('toggle', sdocSelMode);
    sdocSelToggle(sdocSelection, key);
    _sdocSelPaint();
    sdocSyncBulkUi();
    return true;
}
function sdocSelectAllVisible() {
    sdocSelMode = sdocSelModeAfter('all', sdocSelMode);
    sdocSelApply(sdocSelection, sdocSelVisible, true);
    _sdocSelPaint();
    sdocSyncBulkUi();
}
function sdocSelToggleAllVisible() {
    sdocSelToggleAll(sdocSelection, sdocSelVisible);
    _sdocSelPaint();
    sdocSyncBulkUi();
}
// Clear (bulk bar button / Esc) leaves selection mode: nothing selected, everything hidden.
function sdocSelClear() { return sdocSetSelMode(false); }
// Turns selection mode on/off; off clears the selection. Focus inside the hidden
// controls moves to the Select button so keyboard users are not dropped on <body>.
function sdocSetSelMode(on) {
    on = !!on;
    sdocSelMode = on;
    if (!on) sdocSelection.clear();
    if (typeof document === 'undefined') return on;
    var a = document.activeElement;
    var hadFocus = !on && !!(a && a.closest && a.closest('#sdoc-bulk-bar, .sdoc-selall, .sdoc-sel'));
    _sdocSelPaint();
    sdocSyncBulkUi();
    var btn = document.querySelector('.sdoc-selmode-btn');
    if (hadFocus && btn) btn.focus();
    return on;
}
function sdocToggleSelMode() { return sdocSetSelMode(sdocSelModeAfter('mode', sdocSelMode)); }
function _sdocSelModeBtnHtml() {
    var lbl = _sdsT(N_('Select items'));
    return '<div class="segmented-toggle sdoc-selmode"><button type="button" class="sdoc-selmode-btn" aria-pressed="false" aria-label="' + _sdsEsc(lbl) + '" title="' + _sdsEsc(lbl + ' (S)') + '" aria-keyshortcuts="S" onclick="sdocToggleSelMode()">' +
        ((typeof UI_ICONS !== 'undefined' && UI_ICONS && UI_ICONS.selectMode) || '') + '<span>' + _sdsEsc(_sdsT(N_('Select'))) + '</span></button></div>';
}
function _sdocSelAllHtml() {
    var lbl = _sdsT(N_('Select all'));
    return '<label class="sdoc-selall" title="' + _sdsEsc(lbl) + '"><input type="checkbox" class="sdoc-selall-check" aria-label="' + _sdsEsc(lbl) + '" aria-keyshortcuts="Control+A Meta+A" onchange="sdocSelToggleAllVisible()">' +
        '<span class="sdoc-selall-label">' + _sdsEsc(lbl) + '</span></label>';
}
function _sdocBulkBarHtml() {
    var b = function(kind, label, icon, extra, keys) {
        return '<button type="button" class="widget-library-btn sdoc-bulk-btn' + (extra || '') + '" data-bulk="' + kind + '"' + (keys ? ' aria-keyshortcuts="' + keys + '"' : '') +
            ' tabindex="' + (kind === 'download' ? '0' : '-1') + '">' + (icon || '') + '<span>' + _sdsEsc(label) + '</span></button>';
    };
    return '<div class="sdoc-bulk-bar" id="sdoc-bulk-bar" role="toolbar" aria-label="' + _sdsEsc(_sdsT(N_('Selection actions'))) + '" hidden onclick="sdocBulkBarClick(event)" onkeydown="sdocBulkBarKey(event)">' +
        '<span class="sdoc-bulk-count" id="sdoc-bulk-count" role="status" aria-live="polite"></span>' +
        b('download', _sdsT('Download'), UI_ICONS.download) +
        b('delete', _sdsT('Delete'), UI_ICONS.trash, ' danger', 'Delete') +
        b('clear', _sdsT(N_('Clear selection')), UI_ICONS.close, '', 'Escape') + '</div>';
}
function sdocBulkBarClick(e) {
    var btn = e && e.target && e.target.closest ? e.target.closest('[data-bulk]') : null;
    if (!btn) return;
    var k = btn.getAttribute('data-bulk');
    if (k === 'download') sdocBulkDownload();
    else if (k === 'delete') sdocBulkDelete();
    else if (k === 'clear') sdocSelClear();
}
// Toolbar pattern: one tab stop, arrows / Home / End move between the buttons.
function sdocBulkBarKey(e) {
    var bar = e.currentTarget, btns = Array.from(bar.querySelectorAll('[data-bulk]:not(:disabled)'));
    var i = btns.indexOf(document.activeElement), next = -1;
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % btns.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = btns.length - 1;
    if (next < 0) return;
    e.preventDefault();
    bar.querySelectorAll('[data-bulk]').forEach(function(b) { b.tabIndex = -1; });
    btns[next].tabIndex = 0;
    btns[next].focus();
}
// Inserts the Select toggle (before Group by), Select all (before the toggle) and the bulk
// bar (above the items) once, then syncs them to selection mode.
function sdocSyncBulkUi() {
    if (typeof document === 'undefined') return;
    var host = document.getElementById('documents-toolbar-slot') || document.getElementById('documents-list');
    var bar = host && host.querySelector('.sdoc-page-toolbar');
    if (bar && !bar.querySelector('.sdoc-selmode-btn')) {
        var anchor = bar.querySelector('.sdoc-groupby') || bar.querySelector('.widget-library-layout');
        if (anchor) anchor.insertAdjacentHTML('beforebegin', _sdocSelModeBtnHtml()); else bar.insertAdjacentHTML('beforeend', _sdocSelModeBtnHtml());
    }
    var modeWrap = bar && bar.querySelector('.sdoc-selmode');
    if (bar && !bar.querySelector('.sdoc-selall')) {
        if (modeWrap) modeWrap.insertAdjacentHTML('beforebegin', _sdocSelAllHtml()); else bar.insertAdjacentHTML('beforeend', _sdocSelAllHtml());
    }
    var modeBtn = document.querySelector('.sdoc-selmode-btn');
    if (modeBtn) {
        modeBtn.classList.toggle('active', sdocSelMode);
        modeBtn.setAttribute('aria-pressed', sdocSelMode ? 'true' : 'false');
    }
    var list = document.getElementById('documents-list');
    if (list) list.classList.toggle('sdoc-selecting', sdocSelMode);
    var selAll = document.querySelector('.sdoc-selall');
    if (selAll) selAll.hidden = !sdocSelMode;
    var all = document.querySelector('.sdoc-selall-check');
    if (all) {
        var st = sdocSelState(sdocSelection, sdocSelVisible);
        all.checked = st === 'all';
        all.indeterminate = st === 'some';
        all.disabled = !sdocSelVisible.length;
    }
    var items = document.getElementById('documents-items');
    var bulk = document.getElementById('sdoc-bulk-bar');
    if (!bulk && items && items.parentNode) {
        items.insertAdjacentHTML('beforebegin', _sdocBulkBarHtml());
        bulk = document.getElementById('sdoc-bulk-bar');
    }
    if (!bulk) return;
    var n = sdocSelection.size;
    bulk.hidden = !sdocSelMode;
    bulk.querySelectorAll('[data-bulk="download"], [data-bulk="delete"]').forEach(function(b) { b.disabled = !n; });
    // Keep exactly one enabled tab stop in the roving toolbar.
    var live = Array.from(bulk.querySelectorAll('[data-bulk]:not(:disabled)'));
    if (live.length && !live.some(function(b) { return b.tabIndex === 0; })) {
        bulk.querySelectorAll('[data-bulk]').forEach(function(b) { b.tabIndex = -1; });
        live[0].tabIndex = 0;
    }
    var count = document.getElementById('sdoc-bulk-count');
    var txt = sdocSelMode ? _sdsTn(n, N_('{count} selected'), N_('{count} selected')) : '';
    if (count && count.textContent !== txt) count.textContent = txt;
}
async function sdocBulkDelete() {
    var part = sdocBulkPartition(sdocSelectedItems(), typeof sdocSrcWritable === 'function' ? sdocSrcWritable : null);
    var nDel = part.deletable.length, nSkip = part.skipped.length;
    if (!nDel) {
        if (nSkip && typeof showSnackbar === 'function') showSnackbar(sdocBulkResultText(0, nSkip, 0), 'warning');
        return;
    }
    var msg = _sdsTn(nDel, N_('Delete {count} item? This cannot be undone.'), N_('Delete {count} items? This cannot be undone.'));
    if (nSkip) msg += ' ' + sdocBulkResultText(0, nSkip, 0);
    if (typeof showConfirmModal !== 'function' || !await showConfirmModal(_sdsT(N_('Delete selected items')), escapeHtml(msg), 'danger')) return;
    var done = 0, failed = 0, touched = {};
    for (var i = 0; i < part.deletable.length; i++) {
        var it = part.deletable[i];
        try {
            if (it.kind === 'doc') await deleteDocumentById(it.doc.id);
            else { await lfDeleteEntry(it.row.src.folderId, it.row.entry.path, it.row.entry.kind === 'directory'); touched[it.row.src.id] = true; }
            sdocSelection.delete(sdocSelKeyOf(it));
            done++;
        } catch (e) { failed++; }
    }
    Object.keys(touched).forEach(function(id) { sdocSrcInvalidate(id); });
    if (typeof renderDocumentsPage === 'function') renderDocumentsPage();
    if (typeof renderVersionSidebar === 'function') renderVersionSidebar();
    if (typeof showSnackbar === 'function') showSnackbar(sdocBulkResultText(done, nSkip, failed), failed ? 'warning' : 'success');
}
function _sdocDocMarkdown(doc) {
    var embedLabel = _sdsT('[embedded display]');
    return String(doc.currentContent || '').replace(/<!--display:dsp_\w+-->/g, function() { return embedLabel; });
}
function _sdocDocFileName(doc) { return (doc.title || 'document').replace(/[^a-zA-Z0-9_-]/g, '_') + '.md'; }
function _sdocSaveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}
// Bytes + zip path of one downloadable item (same content as the per-item Export / Download).
async function _sdocItemBytes(it) {
    if (it.kind === 'doc') return { name: _sdocDocFileName(it.doc), bytes: new TextEncoder().encode(_sdocDocMarkdown(it.doc)), date: it.doc.updatedAt || 0 };
    var r = await lfReadFileBytes(it.row.src.folderId, it.row.entry.path);
    return { name: (it.row.src.label || 'files') + '/' + it.row.entry.path, bytes: r.bytes, date: it.row.entry.lastModified || 0 };
}
// Zip files of one folder, resolved lazily (recursive lfListDir) -> {files, failed}.
async function _sdocFolderFiles(src, folderPath, prefix, used) {
    var res = await lfListDir(src.folderId, folderPath, { recursive: true });
    var ents = sdocFolderZipEntries(folderPath, (res && res.entries) || [], prefix), files = [], failed = 0;
    for (var i = 0; i < ents.length; i++) {
        try { var r = await lfReadFileBytes(src.folderId, ents[i].path); files.push({ name: sdocZipName(ents[i].name, used), bytes: r.bytes, date: ents[i].date }); }
        catch (e) { failed++; }
    }
    return { files: files, failed: failed };
}
// Row action: <folder>.zip with the folder as the zip root.
async function sdocDownloadFolder(src, entry) {
    try {
        var r = await _sdocFolderFiles(src, entry.path, '', {});
        if (!r.files.length) { if (typeof showSnackbar === 'function') showSnackbar(_sdsT('This folder is empty'), 'warning'); return; }
        _sdocSaveBlob(new Blob([sdocZipStore(r.files)], { type: 'application/zip' }), (entry.name || 'folder') + '.zip');
        if (r.failed && typeof showSnackbar === 'function') showSnackbar(_sdsTn(r.failed, N_('{count} failed'), N_('{count} failed')), 'warning');
    } catch (e) { if (typeof showSnackbar === 'function') showSnackbar(_sdsT('Download failed: {error}', { error: String((e && e.message) || e) }), 'error'); }
}
async function sdocBulkDownload() {
    var part = sdocDownloadPartition(sdocSelectedItems()), nSkip = part.skipped.length;
    var skipText = function() { return nSkip ? _sdsTn(nSkip, N_('{count} item skipped'), N_('{count} items skipped')) : ''; };
    if (!part.items.length) { if (nSkip && typeof showSnackbar === 'function') showSnackbar(skipText(), 'warning'); return; }
    var failed = 0;
    try {
        var one = part.items.length === 1 ? part.items[0] : null;
        if (one && one.kind === 'doc') sdocDownloadMd(one.doc.id);
        else if (one && one.row.entry.kind === 'directory') await sdocDownloadFolder(one.row.src, one.row.entry);
        else if (one) {
            var r = await lfReadFileAsDataUrl(part.items[0].row.src.folderId, part.items[0].row.entry.path);
            var a = document.createElement('a');
            a.href = r.data_url; a.download = r.name || 'file';
            document.body.appendChild(a); a.click(); a.remove();
        } else {
            var files = [], used = {};
            for (var i = 0; i < part.items.length; i++) {
                var pit = part.items[i];
                try {
                    if (pit.kind !== 'doc' && pit.row.entry.kind === 'directory') {
                        var fr = await _sdocFolderFiles(pit.row.src, pit.row.entry.path, pit.row.src.label || 'files', used);
                        files = files.concat(fr.files); failed += fr.failed;
                        continue;
                    }
                    var f = await _sdocItemBytes(pit); files.push({ name: sdocZipName(f.name, used), bytes: f.bytes, date: f.date });
                } catch (e) { failed++; }
            }
            if (files.length) _sdocSaveBlob(new Blob([sdocZipStore(files)], { type: 'application/zip' }), 'documents.zip');
        }
    } catch (e) {
        if (typeof showSnackbar === 'function') showSnackbar(_sdsT('Download failed: {error}', { error: String((e && e.message) || e) }), 'error');
        return;
    }
    var note = [skipText(), failed ? _sdsTn(failed, N_('{count} failed'), N_('{count} failed')) : ''].filter(Boolean).join(' \u00B7 ');
    if (note && typeof showSnackbar === 'function') showSnackbar(note, 'warning');
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

async function exportAllDocuments() {
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
        // Old version bodies live in IDB only: a doc with stubs exports the record a
        // save would persist (each stub read back from IDB as its identity-matched
        // stored entry), so the file holds full bodies and never a stub marker.
        // A doc without stubs needs no read (no await: the old synchronous path).
        // A FAILED read (unhealthy store: reload latch, open watchdog, get error)
        // aborts the whole export with the error snackbar below — exporting the
        // stub-less remainder as a success would lose that history on
        // export -> wipe -> import. A MISSING record (null) still exports what
        // memory holds, each unresolvable stub left out with a warning.
        for (var i = 0; i < docs.length; i++) {
            if (!Array.isArray(docs[i].versions)) continue;
            if (docs[i].versions.some(_sdocIsStub)) {
                var stored;
                try { stored = await _sdocReadStored(docs[i].id); } catch (re) {
                    throw new Error('version history of "' + docs[i].title + '" could not be read: ' + _sdocErrMessage(re));
                }
                exportData[i].versions = _sdocMergeForSave(docs[i], stored).versions;
            }
            else exportData[i].versions = docs[i].versions.map(_sdocClean);
        }

        var json = JSON.stringify({ type: 'appagent-documents', version: 1, documents: exportData }, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'appagent-documents-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        showSnackbar(tn(docs.length, 'Exported {count} document(s)', 'Exported {count} document(s)'), 'success');
    } catch (e) {
        showSnackbar(t('Download failed: {error}', { error: _sdocErrMessage(e) }), 'error');
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
                // Ensure required fields (stub markers in a file are never persisted)
                doc.versions = (doc.versions || []).map(_sdocClean);
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
                // Committed: memory keeps only the current body (lazy history, as after
                // a load); the old bodies are read back from IDB on demand. A write still
                // queued keeps the full record, so a later save can carry it if it fails.
                rows.forEach(function(r) { smartDocuments[r.doc.id] = stillSaving ? r.doc : _sdocStrip(r.doc); registerFile(r.doc.file_id, { type: 'document', docId: r.doc.id }); });
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
