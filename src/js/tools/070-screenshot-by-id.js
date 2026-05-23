// SCREENSHOT BY ID - Alias for getFile (backward compat)
// =============================================

function executeScreenshotById(args) {
    var id = args.id;
    if (!id) {
        return { success: false, error: 'id is required' };
    }
    var file = getFile(id);
    if (!file) {
        // Collect available IDs for error message
        var availableIds = [];
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
        base64: file.data,
        name: file.name || null,
        width: file.width || null,
        height: file.height || null
    };
}

// =============================================
