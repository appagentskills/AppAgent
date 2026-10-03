// SCREENSHOT BY ID - Alias for getFile (backward compat)
// =============================================

// Resolves through the unified store (getFileAsync -> resolveFile), so blob
// and folder-pointer file_ids work too; base64 is generated on demand.
async function executeScreenshotById(args) {
    var id = args.id;
    if (!id) {
        return { success: false, error: 'id is required' };
    }
    var file = null;
    try { file = await getFileAsync(id); } catch (e) { return { success: false, error: 'Could not read ' + id + ': ' + ((e && e.message) || e) }; }
    if (!file) {
        // Collect available IDs for error message
        var availableIds = [];
        // MSG-EVICT: skeleton chats list their screenshot ids from the cold summary.
        try { if (typeof _fileIndexColdReady === 'function') await _fileIndexColdReady(); } catch (e) {}
        var chatIds = Object.keys(chats);
        for (var ci = 0; ci < chatIds.length; ci++) {
            var c = chats[chatIds[ci]];
            if (c.screenshots) {
                var mapIds = Object.keys(c.screenshots);
                for (var si = 0; si < mapIds.length; si++) availableIds.push(mapIds[si]);
            }
            if (c.messages) {
                for (var mi = 0; mi < c.messages.length; mi++) {
                    var msg = c.messages[mi];
                    var fid = msg.file_id || msg.screenshot_id;
                    if (fid && (msg.role === 'screenshot')) availableIds.push(fid);
                }
            } else if (c._messagesEvicted && typeof _chatFileIdsSync === 'function') {
                Array.prototype.push.apply(availableIds, _chatFileIdsSync(chatIds[ci], 'screenshot'));
            }
        }
        if (availableIds.length === 0) {
            return { success: false, error: 'Screenshot not found: ' + id + '. No screenshots have been taken yet.' };
        }
        return { success: false, error: 'Screenshot not found: ' + id + '. Available screenshot IDs: ' + availableIds.join(', ') };
    }
    return {
        success: true,
        id: id,
        base64: fixDataUrlMime(file.data),
        mime: file.mime || dataUrlMime(file.data) || null,
        name: file.name || null,
        width: file.width || null,
        height: file.height || null
    };
}

// =============================================
