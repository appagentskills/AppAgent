// IMAGE ATTACHMENT HANDLING
// =============================================

// Handle file input selection
function handleImageFileSelect(event) {
    var files = event.target.files;
    if (!files || files.length === 0) return;

    for (var i = 0; i < files.length; i++) {
        processImageFile(files[i]);
    }

    // Clear the input so the same file can be selected again
    event.target.value = '';
}

// Complete an upload into its originating draft, not whichever composer is visible.
// Read the latest map entry on completion: navigation copies arrays, and another
// upload or a send may have replaced/consumed the original array in the meantime.
function appendPendingImageForContext(contextKey, attachment) {
    if (contextKey !== 'home' && (!chats[contextKey] || chats[contextKey]._deleted)) {
        // The origin chat vanished while the file was being read: the upload
        // has nowhere to land. Say so instead of silently dropping it.
        if (typeof showSnackbar === 'function') showSnackbar('Attachment "' + ((attachment && attachment.name) || 'file') + '" was dropped: its chat was deleted', 'warning');
        return;
    }
    // Compare against the context that OWNS the live list, not the visible view:
    // on History/other panels getCurrentPendingContext() still names the last chat
    // even though the live list may be Home's draft.
    if (getPendingImagesOwnerContext() === contextKey) {
        pendingImageAttachments.push(attachment);
        renderPendingImages();
    } else {
        chatPendingImages[contextKey] = (chatPendingImages[contextKey] || []).concat([attachment]);
        persistPendingImagesToSession();
        updateHomePendingIndicator();
        renderChatList();
    }
}

// Process an image, PDF, or spreadsheet file and add it to pending attachments
function processImageFile(file) {
    var originContext = getCurrentPendingContext();
    // Handle PDF files
    if (file.type === 'application/pdf') {
        // 10MB, same cap as images/text. The PDF is inlined as base64 (×1.33)
        // straight into the chat transcript / IDB with NO compression step
        // (unlike images), and the old 25MB cap let a ~33MB payload through —
        // over the provider's ~32MB request limit, so it failed at send time.
        if (file.size > 10 * 1024 * 1024) {
            showSnackbar('PDF too large (max 10MB)', 'error');
            return;
        }

        var reader = new FileReader();
        // A read failure (permission revoked, file moved, I/O error) never
        // fires onload — surface it instead of silently dropping the attachment.
        reader.onerror = function() {
            showSnackbar('Could not read PDF', 'error');
        };
        reader.onload = function(e) {
            var name = file.name || 'document.pdf';

            appendPendingImageForContext(originContext, {
                base64: e.target.result,
                name: name,
                fileType: 'pdf',
                file_id: newFileId()
            });
        };
        reader.readAsDataURL(file);
        return;
    }

    // Handle text files (CSV, plain text, etc.)
    var isTextFile = file.type.startsWith('text/') ||
                     file.name.toLowerCase().endsWith('.csv') ||
                     file.name.toLowerCase().endsWith('.txt') ||
                     file.name.toLowerCase().endsWith('.json') ||
                     file.name.toLowerCase().endsWith('.xml') ||
                     file.name.toLowerCase().endsWith('.md');

    if (isTextFile) {
        if (file.size > 10 * 1024 * 1024) {
            showSnackbar('File too large (max 10MB)', 'error');
            return;
        }

        var reader = new FileReader();
        reader.onerror = function() {
            showSnackbar('Could not read file', 'error');
        };
        reader.onload = function(e) {
            var name = file.name || 'file';
            var content = e.target.result;

            appendPendingImageForContext(originContext, {
                content: content,
                name: name,
                fileType: 'file',
                mimeType: file.type || 'text/plain',
                size: file.size,
                file_id: newFileId()
            });
        };
        reader.readAsText(file);
        return;
    }

    // Handle image files
    if (!file.type.startsWith('image/')) {
        showSnackbar('Unsupported file type. Use image, PDF, or text files.', 'error');
        return;
    }

    // Limit file size to 10MB
    if (file.size > 10 * 1024 * 1024) {
        showSnackbar('Image too large (max 10MB)', 'error');
        return;
    }

    var reader = new FileReader();
    reader.onload = function(e) {
        var img = new Image();
        img.onload = function() {
            // Resize if too large (max 1200px on longest side for reasonable token usage)
            var maxDim = 1200;
            var width = img.width;
            var height = img.height;

            if (width > maxDim || height > maxDim) {
                if (width > height) {
                    height = Math.round(height * maxDim / width);
                    width = maxDim;
                } else {
                    width = Math.round(width * maxDim / height);
                    height = maxDim;
                }
            }

            // Create resized canvas
            var canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            var base64 = canvas.toDataURL('image/png');
            canvas.width = 0;
            canvas.height = 0;
            var name = file.name.replace(/\.[^.]+$/, '') || 'image';

            // Compress if over 5MB API limit
            compressBase64Image(base64).then(function(compressed) {
                appendPendingImageForContext(originContext, {
                    base64: compressed,
                    name: name,
                    width: width,
                    height: height,
                    file_id: newFileId()
                });
            }).catch(function() {
                // Bug-sweep F8: surface compression failures instead of dropping silently.
                showSnackbar('Could not read image', 'error');
            });
        };
        // Bug-sweep F8: a corrupt / unsupported image never fires onload.
        img.onerror = function() {
            showSnackbar('Could not read image', 'error');
        };
        img.src = e.target.result;
    };
    // Same as the PDF/text readers: a FileReader failure never reaches
    // img.onerror, so it needs its own handler.
    reader.onerror = function() {
        showSnackbar('Could not read image', 'error');
    };
    reader.readAsDataURL(file);
}

// Handle paste events for images and PDFs
function handlePasteForImages(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    var hasFile = false;
    for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1 || items[i].type === 'application/pdf') {
            hasFile = true;
            var file = items[i].getAsFile();
            if (file) {
                processImageFile(file);
            }
        }
    }

    // If we processed a file, don't prevent default (allow text paste too)
    // But if ONLY file was pasted, prevent default
    if (hasFile && (!e.clipboardData.getData('text/plain'))) {
        e.preventDefault();
    }
}

// Track drag enter/leave depth for nested elements
var dragDepth = 0;

// Handle drag enter/over for the full page
function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleDragEnter(e) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth++;
    if (dragDepth === 1) {
        var overlay = document.getElementById('drop-overlay');
        if (overlay) overlay.classList.add('visible');
    }
}

// Handle drag leave for the full page
function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth--;
    if (dragDepth <= 0) {
        dragDepth = 0;
        var overlay = document.getElementById('drop-overlay');
        if (overlay) overlay.classList.remove('visible');
    }
}

// Handle drop for the full page
function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    dragDepth = 0;
    var overlay = document.getElementById('drop-overlay');
    if (overlay) overlay.classList.remove('visible');

    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Bug-sweep F7: route every dropped file through the same handler the file
    // picker uses (handleImageFileSelect -> processImageFile). It already accepts
    // images / PDFs / text files (csv, txt, json, xml, md) and snackbars anything
    // else, so the old image|pdf pre-filter only served to silently swallow text
    // files that the picker would have accepted.
    for (var i = 0; i < files.length; i++) {
        processImageFile(files[i]);
    }
}

// Render pending images/PDFs preview - updates both chat and home containers
function renderPendingImages() {
    var chatContainer = document.getElementById('pending-images-container');
    var homeContainer = document.getElementById('home-pending-images-container');

    // Build the HTML once
    var html = '';
    if (pendingImageAttachments.length > 0) {
        pendingImageAttachments.forEach(function(img, idx) {
            if (img.fileType === 'document') {
                html += '<div class="pending-image-item pending-file-item" onclick="viewPendingImage(' + idx + ')">';
                html += '<div class="pending-file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span class="pending-file-label">DOC</span></div>';
                html += '<div class="pending-file-name">' + escapeHtml(img.name) + '</div>';
                html += '<button class="pending-image-remove" onclick="event.stopPropagation();removePendingImage(' + idx + ')" title="Remove" aria-label="Remove">×</button>';
                html += '</div>';
            } else if (img.fileType === 'pdf') {
                html += '<div class="pending-image-item pending-pdf-item" onclick="viewPendingImage(' + idx + ')">';
                html += '<div class="pending-pdf-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span class="pending-pdf-label">PDF</span></div>';
                html += '<div class="pending-pdf-name">' + escapeHtml(img.name) + '</div>';
                html += '<button class="pending-image-remove" onclick="event.stopPropagation();removePendingImage(' + idx + ')" title="Remove" aria-label="Remove">×</button>';
                html += '</div>';
            } else if (img.fileType === 'file') {
                var fileExt = (img.name || '').split('.').pop().toUpperCase();
                html += '<div class="pending-image-item pending-file-item" onclick="viewPendingImage(' + idx + ')">';
                html += '<div class="pending-file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span class="pending-file-label">' + escapeHtml(fileExt) + '</span></div>';
                html += '<div class="pending-file-name">' + escapeHtml(img.name) + '</div>';
                html += '<button class="pending-image-remove" onclick="event.stopPropagation();removePendingImage(' + idx + ')" title="Remove" aria-label="Remove">×</button>';
                html += '</div>';
            } else {
                html += '<div class="pending-image-item" onclick="viewPendingImage(' + idx + ')">';
                html += '<img src="' + escapeHtml(img.base64) + '" alt="' + escapeHtml(img.name) + '" />';
                html += '<button class="pending-image-remove" onclick="event.stopPropagation();removePendingImage(' + idx + ')" title="Remove" aria-label="Remove">×</button>';
                html += '</div>';
            }
        });
        var imageCount = pendingImageAttachments.filter(function(a) { return !a.fileType || a.fileType === 'image'; }).length;
        var pdfCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'pdf'; }).length;
        var fileCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'file'; }).length;
        var docCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'document'; }).length; // Bug-sweep F6
        var parts = [];
        if (imageCount > 0) parts.push(imageCount + ' image' + (imageCount > 1 ? 's' : ''));
        if (pdfCount > 0) parts.push(pdfCount + ' PDF' + (pdfCount > 1 ? 's' : ''));
        if (fileCount > 0) parts.push(fileCount + ' file' + (fileCount > 1 ? 's' : ''));
        if (docCount > 0) parts.push(docCount + ' document' + (docCount > 1 ? 's' : ''));
        html += '<div class="pending-images-hint">' + parts.join(', ') + ' attached. Click to preview, or × to remove.</div>';
    }

    // Update both containers
    [chatContainer, homeContainer].forEach(function(container) {
        if (!container) return;
        if (pendingImageAttachments.length === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
        } else {
            container.style.display = 'flex';
            container.innerHTML = html;
        }
    });

    // Persist pending images to sessionStorage for reload survival
    persistPendingImagesToSession();

    // Update pending-draft indicators in sidebar
    updateHomePendingIndicator();
    renderChatList();
}

// Remove a pending image by index
function removePendingImage(index) {
    pendingImageAttachments.splice(index, 1);
    renderPendingImages();
}

// View a pending image, PDF, or file in fullscreen modal
function viewPendingImage(index) {
    var img = pendingImageAttachments[index];
    if (!img) return;

    if (img.fileType === 'document') {
        // Bug-sweep F6: Smart-Document chips (tools/110 sdocAttachToInput) carry only
        // {name, sdocId} — no base64 — so the image fallthrough below opened an empty
        // screenshot modal. Preview through the document's own modal instead.
        if (img.sdocId && typeof sdocOpenPreview === 'function' && typeof smartDocuments !== 'undefined' && smartDocuments[img.sdocId]) {
            sdocOpenPreview(img.sdocId);
        } else {
            showSnackbar('Document is no longer available', 'warning');
        }
    } else if (img.fileType === 'pdf') {
        openPdfModal(img.base64, img.name);
    } else if (img.fileType === 'file') {
        openFileModal(img.content, img.name, img.mimeType);
    } else {
        openScreenshotModal(img.base64, img.name + ' (' + img.width + '×' + img.height + ')');
    }
}

// Open PDF in modal for full-screen preview
function openPdfModal(base64, title, msgIndex) {
    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');

    overlay.classList.add('pdf-modal');
    var headerHtml = '<span class="modal-title-text">' + escapeHtml(title || 'PDF') + '</span><div class="modal-header-actions">';
    // Show annotations button if we have a message index with annotations
    if (typeof msgIndex === 'number') {
        var chat = chats[currentChatId];
        if (chat && chat.messages) {
            var annotations = findPdfAnnotations(chat.messages, msgIndex);
            if (annotations) {
                headerHtml += '<button class="modal-close-icon" onclick="viewPdfAnnotations(' + msgIndex + ')" title="View parsed content">' + UI_ICONS.file + '</button>';
            }
        }
    }
    headerHtml += '<button class="modal-close-icon" onclick="downloadPdfFromModal()" title="Download">' + UI_ICONS.download + '</button>';
    headerHtml += '<button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';
    header.innerHTML = headerHtml;
    body.innerHTML = '<iframe src="' + base64 + '" style="width:100%;height:100%;border:none;" title="PDF Preview"></iframe>';
    actions.innerHTML = '';

    // Store base64 for download
    body.dataset.pdfSrc = base64;
    body.dataset.pdfName = title || 'document';

    overlay.classList.add('show');
}

// Find PDF annotations for a given pdf message index by looking at subsequent assistant messages
function findPdfAnnotations(messages, pdfMsgIndex) {
    var pdfMsg = messages[pdfMsgIndex];
    if (!pdfMsg || pdfMsg.role !== 'pdf') return null;
    // Look for annotations stored on the pdf message itself
    if (pdfMsg.annotations) return pdfMsg.annotations;
    // Look at subsequent assistant messages for annotations referencing this PDF
    for (var i = pdfMsgIndex + 1; i < messages.length; i++) {
        var msg = messages[i];
        if (msg.role === 'assistant' && msg.annotations) {
            for (var j = 0; j < msg.annotations.length; j++) {
                var ann = msg.annotations[j];
                if (ann.type === 'file' && ann.file) {
                    return [ann];
                }
            }
        }
        // Stop searching if we hit another user message
        if (msg.role === 'user') break;
    }
    return null;
}

// View parsed PDF annotations in a modal
function viewPdfAnnotations(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages) return;
    var annotations = findPdfAnnotations(chat.messages, msgIndex);
    if (!annotations) {
        showSnackbar('No parsed content available for this PDF', 'info');
        return;
    }

    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');
    var pdfMsg = chat.messages[msgIndex];
    var pdfTitle = pdfMsg.name || pdfMsg.description || 'Document';

    overlay.classList.remove('pdf-modal');
    overlay.classList.add('screenshot-modal');
    header.innerHTML = '<span class="modal-title-text">Parsed: ' + escapeHtml(pdfTitle) + '</span><div class="modal-header-actions"><button class="modal-close-icon" onclick="openPdfFromMessage(' + msgIndex + ')" title="Back to PDF">' + UI_ICONS.eye + '</button><button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';

    var contentHtml = '<div class="pdf-annotations-content">';
    annotations.forEach(function(ann) {
        if (ann.type === 'file' && ann.file) {
            if (ann.file.name) {
                contentHtml += '<div class="pdf-ann-filename">' + escapeHtml(ann.file.name) + '</div>';
            }
            if (ann.file.hash) {
                contentHtml += '<div class="pdf-ann-hash">Hash: <code>' + escapeHtml(ann.file.hash) + '</code></div>';
            }
            if (ann.file.content && ann.file.content.length > 0) {
                ann.file.content.forEach(function(part) {
                    if (part.type === 'text') {
                        contentHtml += '<div class="pdf-ann-text">' + escapeHtml(part.text).replace(/\n/g, '<br>') + '</div>';
                    } else if (part.type === 'image_url' && part.image_url) {
                        contentHtml += '<div class="pdf-ann-image"><img src="' + part.image_url.url + '" alt="Parsed image" /></div>';
                    }
                });
            }
        }
    });
    contentHtml += '</div>';

    body.innerHTML = contentHtml;
    actions.innerHTML = '';
    overlay.classList.add('show');
}

function downloadPdfFromModal() {
    var body = document.getElementById('modal-body');
    if (!body || !body.dataset.pdfSrc) return;

    var link = document.createElement('a');
    link.href = body.dataset.pdfSrc;
    link.download = (body.dataset.pdfName || 'document') + '.pdf';
    link.click();
}

// Open text file in modal for full-screen preview
function openFileModal(content, title, mimeType) {
    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');

    overlay.classList.add('file-modal');
    header.innerHTML = '<span class="modal-title-text">' + escapeHtml(title || 'File') + '</span><div class="modal-header-actions"><button class="modal-close-icon" onclick="downloadTextFile()" title="Download">' + UI_ICONS.download + '</button><button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';
    body.innerHTML = '<pre style="white-space:pre-wrap;word-wrap:break-word;margin:0;padding: var(--space-8);font-family:var(--font-mono);font-size:var(--text-body-sm);line-height:var(--leading-relaxed);overflow:auto;height:100%;background:var(--secondary-lighter);">' + escapeHtml(content) + '</pre>';
    actions.innerHTML = '';

    // Store content for download
    body.dataset.fileContent = content;
    body.dataset.fileName = title || 'file';
    body.dataset.fileMimeType = mimeType || 'text/plain';

    overlay.classList.add('show');
}

function downloadTextFile() {
    var body = document.getElementById('modal-body');
    if (!body || !body.dataset.fileContent) return;

    var blob = new Blob([body.dataset.fileContent], { type: body.dataset.fileMimeType || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = body.dataset.fileName || 'file.txt';
    link.click();
    URL.revokeObjectURL(url);
}

// Open file preview from a chat message by index
function openFileFromMessage(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages[msgIndex]) return;
    var msg = chat.messages[msgIndex];
    if (msg.role !== 'file' || !msg.content) return;
    openFileModal(msg.content, msg.name || 'File', msg.mimeType);
}

// Open PDF preview from a chat message by index
function openPdfFromMessage(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages[msgIndex]) return;
    var msg = chat.messages[msgIndex];
    if (msg.role !== 'pdf' || !msg.base64) return;
    openPdfModal(msg.base64, msg.name || msg.description || 'Document', msgIndex);
}

// Clear all pending images
function clearPendingImages() {
    // The attachments being consumed are the live list, so clear its owner's draft.
    var ownerContext = getPendingImagesOwnerContext();
    pendingImageAttachments = [];
    setPendingImagesOwner(ownerContext);
    // Also clear from per-chat map
    delete chatPendingImages[ownerContext];
    renderPendingImages();
}

// Which draft context owns the live composer list. Recorded together with the
// array identity: other modules reassign pendingImageAttachments directly
// (newChat, sendHomeMessage, unsent-message restore) while their composer is on
// screen; once the array is replaced the record is stale and the visible
// context is the owner again.
var pendingImagesOwnerContext = null;
var pendingImagesOwnerList = null;

function setPendingImagesOwner(contextKey) {
    pendingImagesOwnerContext = contextKey;
    pendingImagesOwnerList = pendingImageAttachments;
}

function getPendingImagesOwnerContext() {
    if (pendingImagesOwnerContext !== null && pendingImagesOwnerList === pendingImageAttachments) {
        return pendingImagesOwnerContext;
    }
    return getCurrentPendingContext();
}

// Save current pending images for a chat/view key, then restore for a new key.
// Only the context that owns the live list may save or delete from it: after
// chat A -> Home -> History the live list is Home's draft while
// getCurrentPendingContext() still says A, and saving it as A would wipe A.
function savePendingImagesForContext(contextKey) {
    if (contextKey !== getPendingImagesOwnerContext()) return;
    if (pendingImageAttachments.length > 0) {
        chatPendingImages[contextKey] = pendingImageAttachments.slice();
    } else {
        delete chatPendingImages[contextKey];
    }
}

function restorePendingImagesForContext(contextKey) {
    pendingImageAttachments = (chatPendingImages[contextKey] || []).slice();
    setPendingImagesOwner(contextKey);
    renderPendingImages();
}

function getCurrentPendingContext() {
    if (currentView === 'home') return 'home';
    return currentChatId || 'none';
}

function savePendingTextForContext(contextKey) {
    var inputId = contextKey === 'home' ? 'home-message-input' : 'message-input';
    var input = document.getElementById(inputId);
    var text = input ? input.value : '';
    if (text) {
        chatPendingTexts[contextKey] = text;
    } else {
        delete chatPendingTexts[contextKey];
    }
}

function restorePendingTextForContext(contextKey) {
    var inputId = contextKey === 'home' ? 'home-message-input' : 'message-input';
    var input = document.getElementById(inputId);
    if (input) {
        input.value = chatPendingTexts[contextKey] || '';
        autoResizeTextarea(input);
    }
}

function persistPendingTextsToStorage() {
    setSetting('chatPendingTexts', Object.keys(chatPendingTexts).length > 0 ? chatPendingTexts : null);
    updateHomePendingIndicator();
}

async function restorePendingTextsFromStorage() {
    var saved = await getSetting('chatPendingTexts', null);
    if (saved) {
        chatPendingTexts = saved;
    }
}

function persistPendingImagesToSession() {
    // Keep in-memory map in sync with active images, under the live list's owner
    var ctx = getPendingImagesOwnerContext();
    setPendingImagesOwner(ctx);
    if (pendingImageAttachments.length > 0) {
        chatPendingImages[ctx] = pendingImageAttachments.slice();
    } else {
        delete chatPendingImages[ctx];
    }
    if (Object.keys(chatPendingImages).length > 0) {
        setSetting('chatPendingImages', chatPendingImages);
    } else {
        setSetting('chatPendingImages', null);
    }
}

async function restorePendingImagesFromSession() {
    var saved = await getSetting('chatPendingImages', null);
    if (saved) {
        chatPendingImages = saved;
    }
}

// Initialize image attachment event listeners
function initImageAttachmentListeners() {
    // Paste listener on the document (works even when input not focused)
    document.addEventListener('paste', handlePasteForImages);

    // Drag and drop listeners on the full page
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);
}

// Resend a user message in a new chat
function resendMessage(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages[msgIndex]) return;
    var userMsg = chat.messages[msgIndex];
    if (userMsg.role !== 'user') return;
    
    // Create new chat and send the message
    newChat();
    var input = document.getElementById('message-input');
    input.value = userMsg.content;
    sendMessage();
}

// Attachments written by sendMessage are contiguous rows immediately after the
// user row. Stop at the first non-attachment so later/tool-generated files cannot
// leak into the edited turn. Legacy Smart Document rows predate explicit metadata.
function getEditedTurnAttachments(messages, msgIndex) {
    var attachments = [];
    for (var i = msgIndex + 1; i < messages.length; i++) {
        var row = messages[i];
        var attachment;
        if (row.role === 'screenshot' || row.role === 'pdf' || row.role === 'file') {
            attachment = Object.assign({}, row);
            attachment.fileType = row.role === 'screenshot' ? 'image' : row.role;
            delete attachment.role;
        } else if (row.role === 'context') {
            if (row.attachment && row.attachment.fileType === 'document') {
                attachment = Object.assign({}, row.attachment);
            } else {
                var match = /^\[User referenced Smart Document "([\s\S]*)" \(doc_id: ([A-Za-z0-9_-]+)\)\. Use the document tool with action "read" and this doc_id to access its content\.\]$/.exec(row.content || '');
                if (!match) break;
                attachment = { fileType: 'document', name: match[1], sdocId: match[2] };
            }
        } else {
            break;
        }
        attachments.push(attachment);
    }
    return attachments;
}

// Edit a user message - creates a new chat branch with history up to that point
function editMessage(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages[msgIndex]) return;
    var userMsg = chat.messages[msgIndex];
    if (userMsg.role !== 'user') return;
    
    // Copy all messages up to (but not including) this message
    // Include everything to preserve artifacts and cache prefix. Only the
    // branched slice is cloned (never the rows after msgIndex), and via
    // structuredClone — the JSON round-trip re-serialised every base64
    // attachment row in the prefix on each edit.
    var _branchSlice = chat.messages.slice(0, msgIndex);
    var historyMessages;
    try {
        historyMessages = (typeof structuredClone === 'function') ? structuredClone(_branchSlice) : JSON.parse(JSON.stringify(_branchSlice));
    } catch (e) {
        historyMessages = JSON.parse(JSON.stringify(_branchSlice));
    }
    var editedAttachments = getEditedTurnAttachments(chat.messages, msgIndex);
    
    // Create a new chat with the history
    var newChatId = 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    chats[newChatId] = {
        id: newChatId,
        title: chat.title + ' (edited)',
        messages: historyMessages,
        createdAt: Date.now()
    };

    // Copy cached tool results so cached_content_* tools still work in the branched chat
    if (chat.cachedToolResults) {
        chats[newChatId].cachedToolResults = Object.assign({}, chat.cachedToolResults);
    }

    // Copy version history (artifacts) for messages being kept, updating chatId
    if (chat.versionHistory && chat.versionHistory.length > 0) {
        chats[newChatId].versionHistory = chat.versionHistory
            .filter(function(v) { return v.messageIndex < msgIndex; })
            .map(function(v) {
                var copy = Object.assign({}, v);
                copy.chatId = newChatId;
                return copy;
            });
    }

    // Note: Widgets are NOT copied to avoid ID conflicts with dashboard
    // The branched chat can create new widgets as needed

    // Seed ONLY this turn's draft. selectChat saves the source composer before
    // restoring the branch, resets run UI, and updates the SW focus/history.
    // Rows whose base64 was evicted from the source transcript cannot be
    // re-sent (renderPendingImages would show <img src="undefined">), so they
    // are skipped. file_id is kept on purpose: the blob lives in the file store
    // under that id and get_file/rehydration in the branch resolve through it.
    chatPendingImages[newChatId] = editedAttachments.filter(function(a) { return !a._b64Evicted; });
    chatPendingTexts[newChatId] = userMsg.content;
    saveChatsToStorage();
    selectChat(newChatId);
    persistPendingTextsToStorage();
    document.getElementById('message-input').focus();

    showSnackbar('Editing message - modify and send to branch', 'success');
}

window.onload = init;