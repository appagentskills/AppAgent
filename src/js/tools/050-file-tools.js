// READ ATTACHED FILE TOOL - Read user-attached text files (CSV, etc.)
// =============================================

// Text-like MIME types whose resolved bytes may replace the message content.
function _rafIsTextMime(m) {
    m = String(m || '').toLowerCase();
    return m.indexOf('text/') === 0 || /^application\/(json|xml|javascript|x-ndjson|csv|x-yaml|yaml)\b/.test(m) || /\+(json|xml)$/.test(m);
}

async function executeReadAttachedFile(args, options) {
    var filename = args.filename;
    if (!filename) {
        return { success: false, error: 'filename is required' };
    }

    // Resolve the owning chat: options.chatId (threaded by the dispatcher) is
    // authoritative — currentChatId is permanently null in the SW context.
    var chatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
    var chat = chats[chatId];
    // MSG-EVICT: a skeleton chat (messages evicted) is restored first.
    if (chat && !Array.isArray(chat.messages) && chat._messagesEvicted && typeof ensureChatPayloads === 'function') {
        try { await ensureChatPayloads(chatId); } catch (e) {}
        chat = chats[chatId];
    }
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
        // PDFs are separate native model inputs, not text-file rows. Explain
        // that distinction rather than claiming the visible attachment is absent.
        var pdfMsg = chat.messages.find(function(m) {
            return m.role === 'pdf' && m.name && m.name.toLowerCase() === filename.toLowerCase();
        });
        if (pdfMsg) {
            return {
                success: false,
                filename: pdfMsg.name,
                file_id: pdfMsg.file_id || null,
                error: 'A PDF attachment entry exists, but read_attached_file reads text files only. Native PDF input requires available content.' +
                    (pdfMsg.file_id
                        ? ' Try get_file with this file_id as id and attach: true. If its content is unavailable, ask the user to reattach the PDF.'
                        : (typeof pdfMsg.base64 === 'string' && pdfMsg.base64
                            ? ' No file_id is available. If you cannot access its native content, ask the user to reattach the PDF.'
                            : ' Its content and file_id are unavailable. Ask the user to reattach the PDF.'))
            };
        }
        // Include PDFs when listing attachments so a typo cannot produce the
        // misleading "No files attached" response in a PDF-only conversation.
        var availableFiles = chat.messages
            .filter(function(m) { return m.role === 'file' || m.role === 'pdf'; })
            .map(function(m) { return m.name; });

        if (availableFiles.length === 0) {
            return { success: false, error: 'No files attached in this conversation. Ask the user to attach a file first.' };
        }
        return { success: false, error: 'File not found: ' + filename + '. Available files: ' + availableFiles.join(', ') };
    }

    // Resolve through the unified store (resolveFile) when a file_id exists;
    // fall back to the message's inline content. Only text-like payloads
    // replace the content — this tool never returns binary as text.
    var content = fileMsg.content;
    var fileId = fileMsg.file_id;
    if (fileId && typeof resolveFile === 'function') {
        var file = null;
        try { file = await resolveFile(fileId); } catch (e) { file = null; }
        if (file && file.blob && typeof file.blob.text === 'function' && _rafIsTextMime(file.mime)) {
            try { content = await file.blob.text(); } catch (e) { /* keep inline content */ }
        }
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
