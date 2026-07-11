// FILE STORE — Lightweight index mapping file_id → location pointer
// =============================================
// Data stays where it lives (chat messages, workspace blobs, etc.)
// fileIndex just maps file_id → pointer telling getFile() where to look.

var fileIndex = new Map(); // file_id → { type: "chat"|"screenshots_map"|"workspace"|"document"|"memory", ...location }
var _fileIdCounter = 0;

function newFileId() {
    return 'file_' + (++_fileIdCounter) + '_' + Date.now();
}

function registerFile(fileId, pointer) {
    fileIndex.set(fileId, pointer);
}

function unregisterFile(fileId) {
    if (fileId) fileIndex.delete(fileId);
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
                mime: 'image/png', data: ss.base64,
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
            mime: 'image/png', data: ss.base64,
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
            mime: msg.mimeType || guessMimeFromRole(msg.role),
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

async function getFileAsync(fileId) {
    if (!fileId) return null;
    var ptr = fileIndex.get(fileId);
    if (!ptr) return getFile(fileId); // fallback scan (sync)
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
        if (_evChat && _evChat._payloadsEvicted) {
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

async function executeGetFile(args) {
    var id = args.id;
    if (!id) return { success: false, error: 'id is required' };

    // Try async first (handles workspace files); getFileAsync already falls back to getFile()
    var file = await getFileAsync(id);
    if (!file) {
        // Collect available file_ids for error message
        var available = [];
        var chatIds = Object.keys(chats);
        for (var ci = 0; ci < chatIds.length; ci++) {
            var c = chats[chatIds[ci]];
            if (!c.messages) continue;
            for (var mi = 0; mi < c.messages.length; mi++) {
                var fid = c.messages[mi].file_id || c.messages[mi].screenshot_id;
                if (fid) available.push(fid);
            }
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
        var _dlSize = size < 1024 ? size + ' B' : size < 1048576 ? (size / 1024).toFixed(1) + ' KB' : (size / 1048576).toFixed(1) + ' MB';
        var _dlNameEsc = fname.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        var _dlMimeEsc = (_dlMime || 'unknown').replace(/&/g, '&amp;').replace(/</g, '&lt;');
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
            '<div class="dl-m">' + _dlMimeEsc + ' \u00B7 ' + _dlSize + '</div>' +
            '</div>' +
            '<button class="dl-b" onclick="doDownload()">\u2B07 Download</button>' +
            '</div>' +
            '<script>' +
            'function doDownload(){' +
            'var b=document.querySelector(".dl-b");b.textContent="Opening...";b.disabled=true;' +
            'window.parent.postMessage({type:"widgetDownload",fileId:"' + _dlIdEsc + '",name:"' + _dlFnEsc + '"},"*");' +
            'setTimeout(function(){b.textContent="\u2705 Sent";},300);' +
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
            var resized = await resizeImageIfNeeded(imgData);
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
