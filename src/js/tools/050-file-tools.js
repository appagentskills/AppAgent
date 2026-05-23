// READ ATTACHED FILE TOOL - Read user-attached text files (CSV, etc.)
// =============================================

function executeReadAttachedFile(args) {
    var filename = args.filename;
    if (!filename) {
        return { success: false, error: 'filename is required' };
    }

    var chat = chats[currentChatId];
    if (!chat || !chat.messages) {
        return { success: false, error: 'No active chat found' };
    }

    // Find the file attachment in chat messages
    var fileMsg = null;
    for (var i = 0; i < chat.messages.length; i++) {
        var msg = chat.messages[i];
        if (msg.role === 'file' && msg.name && msg.name.toLowerCase() === filename.toLowerCase()) {
            fileMsg = msg;
            break;
        }
    }

    if (!fileMsg) {
        // List available files
        var availableFiles = chat.messages
            .filter(function(m) { return m.role === 'file'; })
            .map(function(m) { return m.name; });

        if (availableFiles.length === 0) {
            return { success: false, error: 'No files attached in this conversation. Ask the user to attach a file first.' };
        }
        return { success: false, error: 'File not found: ' + filename + '. Available files: ' + availableFiles.join(', ') };
    }

    // Use getFile if file_id is available, else fall back to direct content
    var content = fileMsg.content;
    var fileId = fileMsg.file_id;
    if (fileId) {
        var file = getFile(fileId);
        if (file) content = file.data;
    }

    return {
        success: true,
        filename: fileMsg.name,
        file_id: fileId || null,
        mimeType: fileMsg.mimeType,
        size: fileMsg.size,
        format: 'text',
        content: content
    };
}

// =============================================
