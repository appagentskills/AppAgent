// FILE STORE — Lightweight index mapping file_id → location pointer
// =============================================
// Data stays where it lives (chat messages, workspace blobs, etc.)
// fileIndex just maps file_id → pointer telling getFile() where to look.

var fileIndex = new Map(); // file_id → { type: "chat"|"screenshots_map"|"workspace"|"document"|"memory", ...location }
var _fileIdCounter = 0;

function newFileId() {
    return 'file_' + (++_fileIdCounter) + '_' + Date.now();
}

// ONE producer entry point (see UNIFIED FILE STORE below):
//   registerFile({blob|bytes|data|pointer, name, mime, id?}) -> file_id
//   registerFile(fileId, pointer)  (legacy two-arg form, same helper)
// Location pointers (chat / screenshots_map / workspace / document) stay in
// fileIndex — they point at data that is already persisted and are rebuilt
// on load (rebuildFileIndexAll). Content ('memory' pointers, blobs, bytes,
// data URLs) and folder pointers go to the IndexedDB `files` store shared by
// the service worker and the side panel.
function registerFile(fileIdOrSpec, pointer) {
    if (fileIdOrSpec && typeof fileIdOrSpec === 'object') return _ufsRegister(fileIdOrSpec).id;
    return _ufsRegister({ id: fileIdOrSpec, pointer: pointer }).id;
}

function unregisterFile(fileId) {
    if (!fileId) return;
    fileIndex.delete(fileId);
    _ufsMem.delete(fileId);
    try { var d = _ufsBackend().del(fileId); if (d && d.catch) d.catch(function() {}); } catch (e) {}
}

// Drop the cached resolution of a workspace pointer after its row was
// mutated (edit / discard / hydrate / pull). getFileAsync memoizes the first
// resolution in ptr._resolved; without this, get_file, download cards and
// `workspace write {file_id}` keep returning the pre-mutation snapshot.
function invalidateWorkspaceFilePointer(fileId) {
    if (!fileId) return;
    var ptr = fileIndex.get(fileId);
    if (ptr && ptr.type === 'workspace' && ptr._resolved) delete ptr._resolved;
}

function getFile(fileId) {
    if (!fileId) return null;

    // Try index first
    var ptr = fileIndex.get(fileId);
    if (ptr) return resolveFilePointer(fileId, ptr);

    // Fallback: scan all chats for this file_id (handles old screenshot_ids too)
    var chatIds = Object.keys(chats);
    for (var ci = 0; ci < chatIds.length; ci++) {
        var c = chats[chatIds[ci]];
        if (!c.messages) continue;
        for (var mi = 0; mi < c.messages.length; mi++) {
            var msg = c.messages[mi];
            if (msg.file_id === fileId || msg.screenshot_id === fileId) {
                var p = { type: 'chat', chatId: chatIds[ci], msgIndex: mi };
                fileIndex.set(fileId, p); // cache for next time
                return resolveFilePointer(fileId, p);
            }
        }
        // Also check chat.screenshots map (from widget/js_eval bridge)
        if (c.screenshots && c.screenshots[fileId]) {
            // Cache the pointer so future getFile()/screenshot_by_id lookups for this
            // id skip the full O(chats x messages) scan (the 'chat' branch above
            // already caches; this branch previously did not).
            fileIndex.set(fileId, { type: 'screenshots_map', chatId: chatIds[ci] });
            var ss = c.screenshots[fileId];
            return {
                id: fileId, name: ss.name || null,
                mime: dataUrlMime(ss.base64) || 'image/png', data: ss.base64,
                width: ss.width || null, height: ss.height || null
            };
        }
    }
    return null;
}

function resolveFilePointer(fileId, ptr) {
    if (ptr.type === 'screenshots_map') {
        var smChat = chats[ptr.chatId];
        if (!smChat || !smChat.screenshots || !smChat.screenshots[fileId]) return null;
        var ss = smChat.screenshots[fileId];
        return {
            id: fileId, name: ss.name || null,
            mime: dataUrlMime(ss.base64) || 'image/png', data: ss.base64,
            width: ss.width || null, height: ss.height || null
        };
    }
    if (ptr.type === 'chat') {
        var chat = chats[ptr.chatId];
        if (!chat || !chat.messages) return null;
        var msg = chat.messages[ptr.msgIndex];
        // Validate the pointer — msgIndex can go stale if messages are deleted/reordered
        var msgFid = msg && (msg.file_id || msg.screenshot_id);
        if (!msg || msgFid !== fileId) {
            // Stale pointer — re-scan this chat to find the correct index
            for (var si = 0; si < chat.messages.length; si++) {
                var sm = chat.messages[si];
                if ((sm.file_id || sm.screenshot_id) === fileId) {
                    ptr.msgIndex = si; // fix the pointer for next time
                    msg = sm;
                    break;
                }
            }
            if (!msg || (msg.file_id || msg.screenshot_id) !== fileId) return null;
        }
        return {
            id: fileId,
            name: msg.name || null,
            mime: dataUrlMime(msg.base64) || msg.mimeType || guessMimeFromRole(msg.role),
            data: msg.base64 || msg.content,
            width: msg.width || null,
            height: msg.height || null
        };
    }
    if (ptr.type === 'document') {
        var doc = smartDocuments[ptr.docId];
        if (!doc) return null;
        return {
            id: fileId,
            name: (doc.title || 'document') + '.md',
            mime: 'text/markdown',
            data: doc.currentContent
        };
    }
    if (ptr.type === 'workspace') {
        return resolveWorkspaceFile(fileId, ptr);
    }
    if (ptr.type === 'memory') {
        return {
            id: fileId,
            name: ptr.name || null,
            mime: ptr.mime || 'application/octet-stream',
            data: ptr.data
        };
    }
    return null;
}

function resolveWorkspaceFile(fileId, ptr) {
    // Returns a promise-shaped result — but getFile callers are sync,
    // so we store resolved content in the pointer on first access.
    // For sync access, we must pre-resolve. See getFileAsync().
    if (ptr._resolved) return ptr._resolved;
    return null; // sync callers get null for unresolved workspace files; use getFileAsync()
}

// Legacy-shape adapter ({id,name,mime,data}) over resolveFile's store: blob /
// folder records get their data URL generated on demand here.
async function getFileAsync(fileId) {
    if (!fileId) return null;
    if (!fileIndex.has(fileId)) {
        var st = await _ufsResolveStored(fileId);
        if (st) return await _ufsToLegacyShape(st);
    }
    var f = await _legacyGetFileAsync(fileId);
    if (f && typeof f.data === 'string' && f.data.indexOf('data:') === 0) {
        var fixed = fixDataUrlMime(f.data);
        if (fixed !== f.data) f = Object.assign({}, f, { data: fixed, mime: dataUrlMime(fixed) });
    }
    return f;
}

async function _legacyGetFileAsync(fileId) {
    if (!fileId) return null;
    var ptr = fileIndex.get(fileId);
    if (!ptr) {
        var _scan = getFile(fileId); // fallback scan (sync)
        if (_scan) return _scan;
        // MSG-EVICT: skeleton chats have no messages to scan; look the id up
        // in the lazy cold-chat summary, then fall into the hydrate gate.
        ptr = await _fileIndexFindCold(fileId);
        if (!ptr) return null;
    }
    if (ptr.type === 'workspace') {
        if (ptr._resolved) return ptr._resolved;
        try {
            var file = await getWorkspaceFile(ptr.workspace, ptr.path);
            if (!file) return null;
            // Lazy clone: hydrate stub content before resolving the file
            if (file.stub && file.content == null && typeof wsHydrate === 'function') {
                try {
                    await wsHydrate(ptr.workspace, [ptr.path]);
                    file = await getWorkspaceFile(ptr.workspace, ptr.path);
                } catch (e) { /* fall through to null-content guard */ }
            }
            if (!file || file.content == null) return null;
            var name = ptr.path.split('/').pop();
            var mime = guessMimeFromExt(name);
            var data = file.content;
            var isBinary = data.indexOf('::binary::') === 0;
            if (isBinary) {
                data = 'data:' + mime + ';base64,' + data.substring(10);
            }
            var result = { id: fileId, name: name, mime: mime, data: data };
            ptr._resolved = result;
            return result;
        } catch (e) { return null; }
    }
    var res = resolveFilePointer(fileId, ptr);
    // MEMFIX: a chat/screenshots_map pointer can resolve to a message whose
    // base64 was evicted at load (stripChatPayloadsInPlace) — res is then
    // null or has empty data. Rehydrate the chat from IDB and re-resolve.
    // The sync getFile() stays as-is: the OPEN chat is hydrated by selectChat.
    if ((!res || res.data == null) && (ptr.type === 'chat' || ptr.type === 'screenshots_map')
        && typeof ensureChatPayloads === 'function') {
        var _evChat = (typeof chats !== 'undefined' && chats) ? chats[ptr.chatId] : null;
        if (_evChat && (_evChat._payloadsEvicted || _evChat._messagesEvicted)) {
            try { await ensureChatPayloads(ptr.chatId); } catch (e) {}
            return resolveFilePointer(fileId, ptr);
        }
    }
    return res;
}

function guessMimeFromExt(name) {
    var ext = (name || '').split('.').pop().toLowerCase();
    var map = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp',
        pdf: 'application/pdf', zip: 'application/zip',
        json: 'application/json', xml: 'application/xml',
        js: 'text/javascript', css: 'text/css', html: 'text/html',
        md: 'text/markdown', txt: 'text/plain', csv: 'text/csv'
    };
    return map[ext] || 'application/octet-stream';
}

function guessMimeFromRole(role) {
    if (role === 'screenshot') return 'image/png';
    if (role === 'pdf') return 'application/pdf';
    if (role === 'file') return 'text/plain';
    return 'application/octet-stream';
}

function rebuildFileIndex(chat) {
    if (!chat) return;
    if (chat.messages) {
        for (var i = 0; i < chat.messages.length; i++) {
            var msg = chat.messages[i];
            var fid = msg.file_id || msg.screenshot_id;
            if (fid) {
                fileIndex.set(fid, { type: 'chat', chatId: chat.id, msgIndex: i });
            }
        }
    } else if (_isSkeletonChat(chat) && chat.id && _skelSumFresh(chat.id, chat)) {
        _indexSkelSummary(chat.id);
    }
    // Also index entries in the screenshots map (from widget/skill sandbox screenshots)
    if (chat.screenshots) {
        var ssIds = Object.keys(chat.screenshots);
        for (var j = 0; j < ssIds.length; j++) {
            if (!fileIndex.has(ssIds[j])) {
                fileIndex.set(ssIds[j], { type: 'screenshots_map', chatId: chat.id });
            }
        }
    }
}

function rebuildFileIndexAll() {
    var chatIds = Object.keys(chats);
    for (var i = 0; i < chatIds.length; i++) {
        rebuildFileIndex(chats[chatIds[i]]);
    }
}

// COLD-CHAT FILE IDS (MSG-EVICT) — a skeleton chat (_messagesEvicted, no
// messages key) keeps its file ids only in its IDB row. On the first miss we
// build a private per-chat summary {mc, files:[[fid, msgIndex, role]]} by
// reading ONE row at a time (loadChatRowFromDB never rejects), index it, and
// drop the row. Single-flight; never rejects; never hydrates a chat (the
// resolved chat alone is hydrated by the gate in _legacyGetFileAsync).
var _skelFileSums = new Map();
var _fileIndexColdPromise = null;

function _isSkeletonChat(c) {
    return !!(c && c._messagesEvicted && !Array.isArray(c.messages));
}

function _skelSumFresh(chatId, c) {
    var s = _skelFileSums.get(chatId);
    return !!(s && _isSkeletonChat(c) && s.mc === c._msgCount);
}

function _anySkeletonChat() {
    if (typeof chats === 'undefined' || !chats) return false;
    var ids = Object.keys(chats);
    for (var i = 0; i < ids.length; i++) if (_isSkeletonChat(chats[ids[i]])) return true;
    return false;
}

function _indexSkelSummary(chatId) {
    var s = _skelFileSums.get(chatId);
    if (!s) return;
    for (var i = 0; i < s.files.length; i++) {
        var f = s.files[i], cur = fileIndex.get(f[0]);
        // A pointer into another (hydrated) chat wins.
        if (!cur || (cur.type === 'chat' && cur.chatId === chatId)) {
            fileIndex.set(f[0], { type: 'chat', chatId: chatId, msgIndex: f[1] });
        }
    }
}

function _fileIndexColdPass() {
    if (_fileIndexColdPromise) return _fileIndexColdPromise;
    var p = (async function() {
        try {
            if (typeof loadChatRowFromDB !== 'function' || typeof chats === 'undefined' || !chats) return;
            var ids = Object.keys(chats);
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                if (!_isSkeletonChat(chats[id]) || _skelSumFresh(id, chats[id])) continue;
                var mc = chats[id]._msgCount;
                var row = null;
                try { row = await loadChatRowFromDB(id); } catch (e) { row = null; }
                var c = chats[id];
                if (!row || !Array.isArray(row.messages) || !_isSkeletonChat(c) || c._msgCount !== mc) { row = null; continue; }
                var files = [];
                for (var mi = 0; mi < row.messages.length; mi++) {
                    var m = row.messages[mi];
                    var fid = m && (m.file_id || m.screenshot_id);
                    if (fid) files.push([fid, mi, m.role || null]);
                }
                row = null;
                _skelFileSums.set(id, { mc: mc, files: files });
                _indexSkelSummary(id);
            }
            _skelFileSums.forEach(function(v, k) { if (!chats[k]) _skelFileSums.delete(k); });
        } catch (e) { /* never rejects */ }
    })();
    _fileIndexColdPromise = p;
    p.then(function() { if (_fileIndexColdPromise === p) _fileIndexColdPromise = null; });
    return p;
}

// Await the cold pass only when a skeleton exists (zero reads otherwise).
async function _fileIndexColdReady() {
    if (_anySkeletonChat()) await _fileIndexColdPass();
}

async function _fileIndexFindCold(fileId) {
    try {
        if (!_anySkeletonChat()) return null;
        await _fileIndexColdPass();
        return fileIndex.get(fileId) || null;
    } catch (e) { return null; }
}

// Message-level file ids of one chat in message order: live messages when
// hydrated, the cold summary for a skeleton. role filters (e.g. 'screenshot').
function _chatFileIdsSync(chatId, role) {
    var c = chats[chatId], out = [];
    if (!c) return out;
    if (c.messages) {
        for (var mi = 0; mi < c.messages.length; mi++) {
            var m = c.messages[mi];
            var fid = m.file_id || m.screenshot_id;
            if (fid && (!role || m.role === role)) out.push(fid);
        }
    } else if (_isSkeletonChat(c)) {
        var s = _skelFileSums.get(chatId);
        if (s) for (var i = 0; i < s.files.length; i++) if (!role || s.files[i][2] === role) out.push(s.files[i][0]);
    }
    return out;
}

async function executeGetFile(args) {
    var id = args.id;
    if (!id) return { success: false, error: 'id is required' };

    // Try async first (handles workspace files); getFileAsync already falls back to getFile()
    var file = await getFileAsync(id);
    if (!file) {
        // Collect available file_ids for error message
        var available = [];
        await _fileIndexColdReady();
        var chatIds = Object.keys(chats);
        for (var ci = 0; ci < chatIds.length; ci++) {
            Array.prototype.push.apply(available, _chatFileIdsSync(chatIds[ci]));
        }
        if (available.length === 0) return { success: false, error: 'File not found: ' + id + '. No files available.' };
        return { success: false, error: 'File not found: ' + id + '. Available file IDs: ' + available.join(', ') };
    }

    // Download-only mode: return metadata + auto-render a download card widget
    if (args.download) {
        var size = 0;
        if (file.data && typeof file.data === 'string') {
            if (file.data.indexOf('data:') === 0) {
                var commaIdx = file.data.indexOf(',');
                if (commaIdx > -1) size = Math.round((file.data.length - commaIdx - 1) * 3 / 4);
            } else {
                size = file.data.length;
            }
        }
        var fname = file.name || 'download';
        var downloadUrl = 'file-download.html?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(fname);
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            downloadUrl = chrome.runtime.getURL(downloadUrl);
        }

        // Auto-create a download card widget so the user gets a clickable download button
        var _dlIcon = '\uD83D\uDCC1';
        var _dlMime = file.mime || '';
        if (_dlMime.indexOf('image/') === 0) _dlIcon = '\uD83D\uDDBC\uFE0F';
        else if (_dlMime === 'application/pdf') _dlIcon = '\uD83D\uDCC4';
        else if (_dlMime.indexOf('text/') === 0) _dlIcon = '\uD83D\uDCDD';
        else if (_dlMime.indexOf('video/') === 0) _dlIcon = '\uD83C\uDFAC';
        else if (_dlMime.indexOf('audio/') === 0) _dlIcon = '\uD83C\uDFB5';
        // i18n: the card is a sandboxed widget with no t(), so its UI text is
        // translated here and HTML-escaped (same chain as _dlNameEsc); the inline
        // script reads its state labels from the button's data-* attributes.
        var _dlEsc = function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        var _dlNum = function(n, frac) { return i18nFormatNumber(n, frac ? { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false } : { useGrouping: false }); };
        var _dlSize = size < 1024 ? t('{size} B', { size: _dlNum(size) }) : size < 1048576 ? t('{size} KB', { size: _dlNum(size / 1024, true) }) : t('{size} MB', { size: _dlNum(size / 1048576, true) });
        var _dlNameEsc = fname.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        var _dlMimeEsc = (_dlMime || t('unknown')).replace(/&/g, '&amp;').replace(/</g, '&lt;');
        var _dlIdEsc = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/\n/g, '\\n');
        var _dlFnEsc = fname.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/\n/g, '\\n');
        var _dlMimeSafe = (_dlMime || 'application/octet-stream').replace(/[^a-zA-Z0-9/+.-]/g, '');
        var _dlHtml = '<style>' +
            'body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:transparent}' +
            '.dl{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#161b22;border:1px solid #30363d;border-radius:8px}' +
            '.dl-i{font-size:26px;line-height:1}' +
            '.dl-f{flex:1;min-width:0}' +
            '.dl-n{color:#c9d1d9;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.dl-m{color:#8b949e;font-size:11px;margin-top:2px}' +
            '.dl-b{background:#238636;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap}' +
            '.dl-b:hover{background:#2ea043}.dl-b:disabled{opacity:.6;cursor:default}' +
            '</style>' +
            '<div class="dl">' +
            '<div class="dl-i">' + _dlIcon + '</div>' +
            '<div class="dl-f">' +
            '<div class="dl-n" title="' + _dlNameEsc + '">' + _dlNameEsc + '</div>' +
            '<div class="dl-m">' + _dlMimeEsc + ' \u00B7 ' + _dlEsc(_dlSize) + '</div>' +
            '</div>' +
            '<button class="dl-b" data-opening="' + _dlEsc(t('Opening...')) + '" data-opened="\u2705 ' + _dlEsc(t('Opened')) + '" data-failed="\u26A0 ' + _dlEsc(t('Failed, retry')) + '" data-download="\u2B07 ' + _dlEsc(t('Download')) + '" onclick="doDownload()">\u2B07 ' + _dlEsc(t('Download')) + '</button>' +
            '</div>' +
            '<script>' +
            'function doDownload(){' +
            'var b=document.querySelector(".dl-b"),L=b.dataset||{};b.textContent=L.opening||"Opening...";b.disabled=true;' +
            // The parent (ui/070-dashboard-ui.js) acks {type:"widgetDownloadResult",
            // reqId,ok,error}: show the real outcome, and re-enable the button on
            // failure or when no ack arrives within 5 s.
            'var rq="d"+Date.now(),done=false,t;' +
            'function fin(){done=true;clearTimeout(t);window.removeEventListener("message",onAck);}' +
            'function onAck(e){if(done||!e.data||e.data.type!=="widgetDownloadResult"||e.data.reqId!==rq)return;fin();' +
            'if(e.data.ok){b.textContent=L.opened||"\u2705 Opened";}else{b.textContent=L.failed||"\u26A0 Failed, retry";b.disabled=false;}}' +
            'window.addEventListener("message",onAck);' +
            't=setTimeout(function(){if(done)return;fin();b.textContent=L.download||"\u2B07 Download";b.disabled=false;},5000);' +
            'window.parent.postMessage({type:"widgetDownload",reqId:rq,fileId:"' + _dlIdEsc + '",name:"' + _dlFnEsc + '"},"*");' +
            '}' +
            '<\/script>';

        // Route via executeTool so SW context routes the widget render to a
        // panel executor (executeHtmlWidget lives in tools/080-widget-tools.js,
        // page-only). The worker tool-routing wrapper handles the dispatch.
        var _dlWidget = await executeTool('html_widget', { title: '\u2B07\uFE0F ' + fname, html: _dlHtml, height: 'auto', width: '320px' });

        var _dlResult = {
            success: true,
            id: id,
            name: fname,
            mime: file.mime,
            size: size,
            download_url: downloadUrl,
            width: file.width || undefined,
            height: file.height || undefined
        };
        if (_dlWidget && _dlWidget.widgetId) _dlResult.widgetId = _dlWidget.widgetId;
        return _dlResult;
    }

    // Full mode: include data and generate persistent download URL
    var fname = file.name || 'download';
    var downloadUrl = 'file-download.html?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(fname);
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        downloadUrl = chrome.runtime.getURL(downloadUrl);
    }

    var result = {
        success: true,
        id: id,
        name: file.name,
        mime: file.mime,
        data: file.data,
        download_url: downloadUrl,
        width: file.width || undefined,
        height: file.height || undefined
    };

    // Attach mode: inject the file into the conversation so the model can see it directly
    if (args.attach && file.data) {
        var mime = (file.mime || '').toLowerCase();
        if (mime.indexOf('image/') === 0) {
            // Ensure data URL format for images
            var imgData = file.data;
            if (imgData.indexOf('data:') !== 0) {
                imgData = 'data:' + mime + ';base64,' + imgData;
            }
            // Resize if either dimension exceeds limit (Anthropic caps at 2000px for many-image requests)
            imgData = fixDataUrlMime(imgData);
            var resized = await resizeImageIfNeeded(imgData);
            resized.base64 = fixDataUrlMime(resized.base64);
            result._screenshotMessage = {
                role: 'screenshot',
                base64: resized.base64,
                name: fname,
                description: fname,
                url: null,
                timestamp: Date.now(),
                width: resized.width,
                height: resized.height,
                screenshot_id: id,
                file_id: id
            };
            result.attached = true;
            result.note = 'File attached to conversation as an image. You can now see it directly.';
            delete result.data; // Don't duplicate the data in the tool result
        } else if (mime === 'application/pdf') {
            var pdfData = file.data;
            if (pdfData.indexOf('data:') !== 0) {
                pdfData = 'data:application/pdf;base64,' + pdfData;
            }
            result._screenshotMessage = {
                role: 'pdf',
                base64: pdfData,
                name: fname,
                description: fname,
                timestamp: Date.now(),
                file_id: id
            };
            result.attached = true;
            result.note = 'File attached to conversation as a PDF. You can now read its contents directly.';
            delete result.data;
        } else {
            result.attach_error = 'Cannot attach file of type "' + mime + '". Only images and PDFs can be attached visually. The file data is still included in this result.';
        }
    }

    return result;
}

// =============================================
// UNIFIED FILE STORE — one IndexedDB `files` store (DB 'appagent-files')
// shared by the service worker and the side panel. Records:
//   {id, kind:'blob',   blob, name, mime, size, width?, height?, createdAt, lastAccess}
//   {id, kind:'folder', folder, path, name, mime, size, lastModified, createdAt, lastAccess}
// Folder records are lazy pointers into a connected folder (bytes are read on
// demand by resolveFile). file_ids survive a service-worker restart.
// =============================================
var UFS_DB_NAME = 'appagent-files';
var UFS_STORE = 'files';
var UFS_LIMITS = {
    maxFileBytes: 50 * 1024 * 1024,   // per blob
    maxTotalBytes: 300 * 1024 * 1024, // all blobs (LRU beyond this)
    maxRecords: 2000,                 // blob records (LRU beyond this)
    ttlMs: 7 * 24 * 3600 * 1000,      // blob unused for 7 days -> evicted
    cleanupEveryMs: 10 * 60 * 1000,
    touchEveryMs: 60 * 1000
};
// Test seam: { idb: {get, put, del, all}, now, readFolderFile }
var _ufsDeps = {};
var _ufsMem = new Map();     // id -> record not yet (or not) persisted in this realm
var _ufsPending = new Map(); // id -> Promise of the in-flight IDB write
var _ufsLastCleanup = 0;
function ufsSetDeps(d) { _ufsDeps = d || {}; _ufsMem.clear(); _ufsPending.clear(); _ufsLastCleanup = 0; }
function _ufsNow() { return _ufsDeps.now ? _ufsDeps.now() : Date.now(); }

var _ufsDbPromise = null;
function _ufsOpen() {
    if (_ufsDbPromise) return _ufsDbPromise;
    _ufsDbPromise = new Promise(function(res, rej) {
        if (typeof indexedDB === 'undefined') { rej(new Error('indexedDB unavailable')); return; }
        var rq = indexedDB.open(UFS_DB_NAME, 1);
        rq.onupgradeneeded = function() { var db = rq.result; if (!db.objectStoreNames.contains(UFS_STORE)) db.createObjectStore(UFS_STORE, { keyPath: 'id' }); };
        rq.onsuccess = function() { res(rq.result); };
        rq.onerror = function() { rej(rq.error); };
    });
    _ufsDbPromise.catch(function() { _ufsDbPromise = null; });
    return _ufsDbPromise;
}
function _ufsTx(mode, fn) {
    return _ufsOpen().then(function(db) {
        return new Promise(function(res, rej) {
            var tx = db.transaction(UFS_STORE, mode), out;
            var r = fn(tx.objectStore(UFS_STORE));
            if (r) r.onsuccess = function() { out = r.result; };
            tx.oncomplete = function() { res(out); };
            tx.onerror = tx.onabort = function() { rej(tx.error); };
        });
    });
}
var _ufsIdb = {
    get: function(id) { return _ufsTx('readonly', function(s) { return s.get(id); }); },
    put: function(rec) { return _ufsTx('readwrite', function(s) { return s.put(rec); }); },
    del: function(id) { return _ufsTx('readwrite', function(s) { return s.delete(id); }); },
    all: function() { return _ufsTx('readonly', function(s) { return s.getAll(); }); }
};
function _ufsBackend() { return _ufsDeps.idb || _ufsIdb; }

// ─── MIME ───
// Magic-byte sniffer. bytes: Uint8Array (the first ~32 bytes are enough).
function sniffMime(bytes) {
    var b = bytes;
    if (!b || b.length < 2) return null;
    function at(o, sig) { for (var i = 0; i < sig.length; i++) if (b[o + i] !== sig[i]) return false; return true; }
    function asc(o, s) { for (var i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false; return true; }
    if (at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
    if (at(0, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
    if (asc(0, 'GIF87a') || asc(0, 'GIF89a')) return 'image/gif';
    if (asc(0, 'RIFF') && asc(8, 'WEBP')) return 'image/webp';
    if (asc(0, 'RIFF') && asc(8, 'WAVE')) return 'audio/wav';
    if (asc(0, '%PDF-')) return 'application/pdf';
    if (asc(0, 'ID3')) return 'audio/mpeg';
    if (b[0] === 0xFF && b.length > 2 && (b[1] & 0xE0) === 0xE0 && (b[1] & 0x06) !== 0 && (b[2] & 0xF0) !== 0xF0) return 'audio/mpeg';
    if (asc(4, 'ftyp')) {
        if (asc(8, 'avif')) return 'image/avif';
        if (asc(8, 'heic') || asc(8, 'heix') || asc(8, 'mif1')) return 'image/heic';
        if (asc(8, 'M4A ')) return 'audio/mp4';
        return 'video/mp4';
    }
    if (asc(0, 'OggS')) return 'audio/ogg';
    if (asc(0, 'fLaC')) return 'audio/flac';
    if (at(0, [0x1A, 0x45, 0xDF, 0xA3])) return 'video/webm';
    if (at(0, [0x00, 0x00, 0x01, 0x00]) && b.length > 5) return 'image/x-icon';
    if (asc(0, 'BM') && b.length >= 10 && b[6] === 0 && b[7] === 0 && b[8] === 0 && b[9] === 0) return 'image/bmp';
    if (at(0, [0x50, 0x4B, 0x03, 0x04])) return 'application/zip';
    if (at(0, [0x1F, 0x8B])) return 'application/gzip';
    return null;
}
function dataUrlMime(s) { var m = /^data:([^;,]+)[;,]/i.exec(typeof s === 'string' ? s : ''); return m ? m[1].toLowerCase() : null; }
// First bytes of a base64 payload / data URL (decodes only ~24 bytes).
function _ufsB64Head(s) {
    if (typeof s !== 'string') return null;
    var i = s.indexOf(',');
    var p = /^data:/i.test(s) ? (/;base64,/i.test(s.slice(0, i + 1)) ? s.slice(i + 1, i + 33) : null) : s.slice(0, 32);
    if (!p) return null;
    try { p = p.replace(/[^A-Za-z0-9+/]/g, ''); p = p.slice(0, p.length - (p.length % 4)); var bin = atob(p), u = new Uint8Array(bin.length); for (var k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); return u; } catch (e) { return null; }
}
// Rewrite a base64 data URL's declared type when the magic bytes disagree
// (e.g. JPEG bytes labelled image/png — the Anthropic API rejects that).
function fixDataUrlMime(url) {
    if (typeof url !== 'string' || !/^data:[^,]*;base64,/i.test(url)) return url;
    var sn = sniffMime(_ufsB64Head(url));
    var decl = dataUrlMime(url);
    if (!sn || sn === decl) return url;
    return 'data:' + sn + url.slice(url.indexOf(';base64,'));
}
// Image types every vision provider accepts (Anthropic hard-400s anything
// else: "media_type: Input should be 'image/jpeg', 'image/png', ...").
var MODEL_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Normalize a declared image MIME: lowercase, strip params, jpg/pjpeg alias.
function normalizeImageMime(m) {
    var s = String(m == null ? '' : m).split(';')[0].trim().toLowerCase();
    if (s === 'image/jpg' || s === 'image/pjpeg' || s === 'jpg' || s === 'jpeg') return 'image/jpeg';
    if (s && s.indexOf('/') < 0 && /^(png|gif|webp)$/.test(s)) return 'image/' + s;
    return s;
}
// SEND-TIME choke point for every model-bound image (buildAPIMessages
// screenshot arm; background.js convertContentPart mirrors it). Sync + pure.
// Accepts a data URL (or bare base64 / https URL) and returns either
//   { ok: true,  url: 'data:<supported>;base64,<payload>' | https url, mime }
//   { ok: false, mime, reason }  -> caller substitutes a text placeholder.
// The media type comes from the MAGIC BYTES (PNG/JPEG/GIF/WebP); a payload
// whose bytes are not one of those (SVG, BMP, HEIC, octet-stream, empty
// `data:,` from a 0x0 canvas, garbage) is rejected — it would 400 the request
// and, because it stays in history, brick the chat on every later send.
function sanitizeModelImageUrl(url) {
    if (typeof url !== 'string' || !url) return { ok: false, mime: '', reason: 'missing image data' };
    if (url.indexOf('https://') === 0) return { ok: true, url: url, mime: null };
    var payload, declared = '';
    if (/^data:/i.test(url)) {
        var comma = url.indexOf(',');
        if (comma < 0) return { ok: false, mime: '', reason: 'malformed data URL' };
        var header = url.slice(5, comma);
        declared = normalizeImageMime(header);
        if (!/;base64$/i.test(header)) return { ok: false, mime: declared, reason: 'unsupported type ' + (declared || 'empty') + ' (not base64)' };
        payload = url.slice(comma + 1);
    } else if (/^[A-Za-z0-9+/]/.test(url) && url.indexOf(':') < 0) {
        payload = url;
    } else {
        return { ok: false, mime: '', reason: 'unsupported image URL' };
    }
    if (!payload) return { ok: false, mime: declared, reason: 'empty image data' + (declared ? ' (' + declared + ')' : '') };
    var sniffed = sniffMime(_ufsB64Head(payload));
    if (sniffed && MODEL_IMAGE_MIMES.indexOf(sniffed) >= 0) {
        var canonical = 'data:' + sniffed + ';base64,';
        return { ok: true, url: url.indexOf(canonical) === 0 ? url : canonical + payload, mime: sniffed };
    }
    var t = sniffed || declared || 'unknown';
    return { ok: false, mime: t, reason: 'unsupported type ' + t };
}
// ASYNC producer-side repair: re-encode a decodable-but-unsupported image
// (SVG, BMP, ICO, AVIF, HEIC when the browser can decode it) to PNG. Returns
// the PNG data URL, or null when it cannot be decoded (caller drops it).
async function convertImageDataUrlToPng(url) {
    try {
        if (typeof url !== 'string' || !/^data:[^,]*,./i.test(url)) return null;
        var w, h, src;
        var isSvg = /^data:image\/svg\+xml/i.test(url);
        if (!isSvg && typeof createImageBitmap === 'function' && typeof fetch === 'function') {
            src = await createImageBitmap(await (await fetch(url)).blob());
            w = src.width; h = src.height;
        } else if (typeof Image === 'function') {
            src = await new Promise(function(res, rej) { var i = new Image(); i.onload = function() { res(i); }; i.onerror = rej; i.src = url; });
            w = src.naturalWidth || src.width; h = src.naturalHeight || src.height;
        } else return null;
        if (!w || !h) return null;
        var out;
        if (typeof OffscreenCanvas === 'function') {
            var oc = new OffscreenCanvas(w, h); oc.getContext('2d').drawImage(src, 0, 0);
            var blob = await oc.convertToBlob({ type: 'image/png' });
            var u8 = new Uint8Array(await blob.arrayBuffer());
            out = 'data:image/png;base64,' + _ufsBytesToB64(u8);
        } else if (typeof document !== 'undefined') {
            var c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(src, 0, 0);
            out = c.toDataURL('image/png');
        }
        if (src && typeof src.close === 'function') src.close();
        return (out && sanitizeModelImageUrl(out).ok) ? out : null;
    } catch (e) { return null; }
}
function _ufsPickMime(sniffed, declared, name) {
    if (sniffed) return sniffed;
    if (declared && declared !== 'application/octet-stream') return String(declared).split(';')[0].trim().toLowerCase();
    var g = name ? guessMimeFromExt(name) : null;
    return g || declared || 'application/octet-stream';
}
function _ufsBytesToB64(u8) { var s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
// data URL | base64-less text | Uint8Array | ArrayBuffer -> {blob, head, mime}
function _ufsToBlobSync(data, declared) {
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    if (data instanceof Uint8Array) return { blob: new Blob([data], { type: declared || 'application/octet-stream' }), head: data.subarray(0, 32), mime: declared || null };
    var s = String(data == null ? '' : data);
    if (/^data:[^,]*;base64,/i.test(s)) {
        var m = dataUrlMime(s) || declared || 'application/octet-stream';
        var bin = atob(s.slice(s.indexOf(',') + 1).replace(/\s/g, '')), u = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return { blob: new Blob([u], { type: m }), head: u.subarray(0, 32), mime: m };
    }
    if (/^data:[^,]*,/i.test(s)) { var m2 = dataUrlMime(s) || 'text/plain'; return { blob: new Blob([decodeURIComponent(s.slice(s.indexOf(',') + 1))], { type: m2 }), head: null, mime: m2 }; }
    return { blob: new Blob([s], { type: declared || 'text/plain' }), head: null, mime: declared || 'text/plain' };
}

// ─── producers ───
// spec = {id?, blob | bytes | data | pointer, name, mime, width?, height?, source?}
// Returns {id, done} — id synchronously; done resolves once persisted.
function _ufsRegister(spec) {
    spec = spec || {};
    var id = spec.id || newFileId();
    var p = spec.pointer;
    if (p && p.type === 'memory') { spec = { id: id, data: p.data, name: p.name || spec.name, mime: p.mime || spec.mime, width: p.width, height: p.height }; p = null; }
    var isFolder = p && (p.kind === 'folder' || p.type === 'folder');
    if (p && !isFolder) { fileIndex.set(id, p); return { id: id, done: Promise.resolve(id) }; }
    var now = _ufsNow(), rec, head = null;
    if (isFolder) {
        var fname = p.name || spec.name || String(p.path || '').split('/').pop();
        rec = { id: id, kind: 'folder', folder: p.folder, path: p.path, name: fname, mime: _ufsPickMime(null, p.mime || spec.mime, fname), size: p.size || 0, lastModified: p.lastModified || null, createdAt: now, lastAccess: now };
    } else {
        var blob = spec.blob, declared = spec.mime || (blob && blob.type) || null;
        if (!blob) { var c = _ufsToBlobSync(spec.bytes != null ? spec.bytes : spec.data, declared); blob = c.blob; head = c.head; declared = declared || c.mime; }
        else if (spec.bytes) head = spec.bytes.subarray(0, 32);
        if (blob.size > UFS_LIMITS.maxFileBytes) throw new Error('File too large for the file store: ' + blob.size + ' bytes (cap ' + UFS_LIMITS.maxFileBytes + ')');
        rec = { id: id, kind: 'blob', blob: blob, name: spec.name || null, mime: _ufsPickMime(head ? sniffMime(head) : null, declared, spec.name), size: blob.size, width: spec.width || null, height: spec.height || null, source: spec.source || null, createdAt: now, lastAccess: now };
    }
    fileIndex.delete(id);
    _ufsMem.set(id, rec);
    var done = (async function() {
        if (rec.kind === 'blob' && !head && rec.blob.slice) {
            try { var sn = sniffMime(new Uint8Array(await rec.blob.slice(0, 32).arrayBuffer())); if (sn) rec.mime = sn; } catch (e) {}
        }
        try { await _ufsBackend().put(rec); if (_ufsMem.get(id) === rec) _ufsMem.delete(id); }
        catch (e) { /* no IDB here: keep the in-realm copy */ }
        _ufsPending.delete(id);
        _ufsMaybeCleanup();
        return id;
    })();
    _ufsPending.set(id, done);
    return { id: id, done: done };
}
async function registerFileAsync(spec) { var r = _ufsRegister(spec); await r.done; return r.id; }
async function registerFileReady(fileId) { var p = _ufsPending.get(fileId); if (p) { try { await p; } catch (e) {} } return fileId; }

// ─── consumers ───
async function _ufsGetRecord(fileId) {
    await registerFileReady(fileId);
    var rec = _ufsMem.get(fileId);
    if (!rec) { try { rec = await _ufsBackend().get(fileId); } catch (e) { rec = null; } }
    return rec || null;
}
function _ufsTouch(rec) {
    var now = _ufsNow();
    if (now - (rec.lastAccess || 0) < UFS_LIMITS.touchEveryMs) return;
    rec.lastAccess = now;
    if (_ufsMem.get(rec.id) === rec) return;
    try { var r = _ufsBackend().put(rec); if (r && r.catch) r.catch(function() {}); } catch (e) {}
}
async function _ufsResolveStored(fileId) {
    var rec = await _ufsGetRecord(fileId);
    if (!rec) return null;
    _ufsTouch(rec);
    if (rec.kind === 'folder') {
        var rd = _ufsDeps.readFolderFile || (typeof lfReadFileBytes === 'function' ? lfReadFileBytes : null);
        if (!rd) throw new Error('Connected folders unavailable in this context: cannot read ' + rec.path);
        var r = await rd(rec.folder, rec.path);
        var fm = _ufsPickMime(sniffMime(r.bytes.subarray(0, 32)), rec.mime, rec.name);
        return { id: fileId, kind: 'folder', blob: new Blob([r.bytes], { type: fm }), bytes: r.bytes, name: rec.name, mime: fm, size: r.bytes.length, folder: rec.folder, path: rec.path };
    }
    var b = rec.blob;
    if (b && b.type !== rec.mime && b.slice) b = b.slice(0, b.size, rec.mime);
    return { id: fileId, kind: 'blob', blob: b, name: rec.name, mime: rec.mime, size: rec.size, width: rec.width || null, height: rec.height || null };
}
// THE consumer entry point: file_id -> {blob, name, mime, size, width?, height?} | null.
// Order: unified store (blob / folder pointer), then location pointers.
async function resolveFile(fileId) {
    if (!fileId) return null;
    if (!fileIndex.has(fileId)) { var st = await _ufsResolveStored(fileId); if (st) return st; }
    var f;
    try { f = await _legacyGetFileAsync(fileId); } catch (e) { f = null; }
    if (!f || f.data == null) return null;
    var c = _ufsToBlobSync(f.data, f.mime);
    var mime = _ufsPickMime(c.head ? sniffMime(c.head) : null, dataUrlMime(f.data) || f.mime, f.name);
    var blob = c.blob.type === mime ? c.blob : c.blob.slice(0, c.blob.size, mime);
    return { id: fileId, kind: 'pointer', blob: blob, name: f.name || null, mime: mime, size: blob.size, width: f.width || null, height: f.height || null };
}
async function _ufsToLegacyShape(r) {
    var u8 = r.bytes || new Uint8Array(await r.blob.arrayBuffer());
    return { id: r.id, name: r.name, mime: r.mime, size: r.size, data: 'data:' + r.mime + ';base64,' + _ufsBytesToB64(u8), width: r.width || null, height: r.height || null };
}

// ─── lifecycle ───
// Evicts BLOB records only: TTL on lastAccess, then LRU down to the total-
// bytes / record caps. Folder pointer records and the folders themselves
// (Agent Files, connected folders) are never touched.
async function fileStoreCleanup() {
    var all = await _ufsBackend().all();
    var now = _ufsNow(), victims = [], total = 0;
    var blobs = (all || []).filter(function(r) { return r && r.kind !== 'folder'; });
    var alive = [];
    blobs.forEach(function(r) { if (now - (r.lastAccess || r.createdAt || 0) > UFS_LIMITS.ttlMs) victims.push(r.id); else { alive.push(r); total += r.size || 0; } });
    alive.sort(function(a, b) { return (a.lastAccess || 0) - (b.lastAccess || 0); });
    while (alive.length && (total > UFS_LIMITS.maxTotalBytes || alive.length > UFS_LIMITS.maxRecords)) { var v = alive.shift(); total -= v.size || 0; victims.push(v.id); }
    for (var i = 0; i < victims.length; i++) { try { await _ufsBackend().del(victims[i]); } catch (e) {} _ufsMem.delete(victims[i]); }
    return { deleted: victims, kept: alive.length, total_bytes: total };
}
function _ufsMaybeCleanup() {
    var now = _ufsNow();
    if (now - _ufsLastCleanup < UFS_LIMITS.cleanupEveryMs) return;
    _ufsLastCleanup = now;
    fileStoreCleanup().catch(function() {});
}

// =============================================
