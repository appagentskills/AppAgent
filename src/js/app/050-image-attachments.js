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

// S0B2-06: aggregate cap across one draft's pending attachments. The per-file
// caps (10MB PDF/text, 4.5MB per image after resize + compression) alone let
// several files together fail at send time.
// One provider-neutral 30MB cap for every provider. Some provider APIs now
// accept much larger requests, but the draft is posted page -> service worker
// in ONE chrome.runtime port message ('send-message' in
// app/040-send-message.js, alongside the chat snapshot) and Chrome caps a
// runtime message at 64 MiB of JSON — and other providers' request limits are
// lower anyway.
var MAX_PENDING_ATTACHMENT_CHARS = 30 * 1024 * 1024;
// Images are NOT capped on their raw file size: they are downscaled (never
// upscaled) to the maximum accepted long edge, SCREENSHOT_MAX_LONG_EDGE
// (3000px, the cross-provider safe cap in tools/020-tool-execution.js), and
// compressed (compressBase64Image, same file) before they are attached. Larger
// images cost more input tokens; the provider resamples on its side. The real,
// provider-neutral limit is checked AFTER that step:
//  - MAX_IMAGE_RAW_BYTES: sanity cap only, so a giant file cannot hang the
//    FileReader/decode; well under Chrome's 64 MiB runtime-message limit.
//  - MAX_IMAGE_ATTACHMENT_BYTES: the decoded size of the FINAL image, the same
//    4.5MB default compressBase64Image targets (strictest per-image limit we
//    route to, with margin).
var MAX_IMAGE_RAW_BYTES = 50 * 1024 * 1024;
var MAX_IMAGE_ATTACHMENT_BYTES = 4718592;
// Below this much remaining draft budget, don't try to squeeze another image in.
var MIN_IMAGE_FIT_BYTES = 150 * 1024;
// Decoded byte size of a base64 data URL (or bare base64) without decoding it.
function _dataUrlDecodedBytes(dataUrl) {
    if (typeof dataUrl !== 'string') return 0;
    var commaIdx = dataUrl.indexOf(',');
    var b64 = commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : dataUrl;
    var n = Math.floor(b64.length * 3 / 4);
    if (b64.endsWith('==')) n -= 2;
    else if (b64.endsWith('=')) n -= 1;
    return Math.max(0, n);
}
function _attachmentChars(a) {
    return (a && typeof a.base64 === 'string' ? a.base64.length : 0) + (a && typeof a.content === 'string' ? a.content.length : 0);
}

function _isFittableImage(a) {
    return !!a && !a.fileType && typeof a.base64 === 'string' && a.base64.indexOf('data:image/') === 0;
}
var _imageFitQueue = Promise.resolve();
function _pendingListFor(contextKey) {
    return getPendingImagesOwnerContext() === contextKey ? pendingImageAttachments : (chatPendingImages[contextKey] || []);
}
// Shrink every image of the draft to an equal share of the budget, then append.
async function _rebalanceAndAppendImage(contextKey, attachment) {
    var list = _pendingListFor(contextKey);
    var images = [], otherChars = 0;
    for (var i = 0; i < list.length; i++) {
        if (_isFittableImage(list[i])) images.push(list[i]);
        else otherChars += _attachmentChars(list[i]);
    }
    // base64 chars -> decoded bytes, minus slack for the data-URL header.
    var shareChars = (MAX_PENDING_ATTACHMENT_CHARS - otherChars) / (images.length + 1);
    var shareBytes = Math.min(MAX_IMAGE_ATTACHMENT_BYTES, Math.floor((shareChars - 64) * 3 / 4));
    if (shareBytes < MIN_IMAGE_FIT_BYTES) throw new Error('no budget');
    var changed = false;
    for (var j = 0; j < images.length; j++) {
        if (_dataUrlDecodedBytes(images[j].base64) > shareBytes) {
            images[j].base64 = await compressBase64Image(images[j].base64, shareBytes);
            changed = true;
        }
    }
    var smaller = await compressBase64Image(attachment.base64, shareBytes);
    if (changed) {
        if (getPendingImagesOwnerContext() === contextKey) renderPendingImages();
        if (typeof persistPendingImagesToSession === 'function') persistPendingImagesToSession();
    }
    appendPendingImageForContext(contextKey, Object.assign({}, attachment, { base64: smaller, _fitRetried: (attachment._fitRetried || 0) + 1 }));
}

// Complete an upload into its originating draft, not whichever composer is visible.
// Read the latest map entry on completion: navigation copies arrays, and another
// upload or a send may have replaced/consumed the original array in the meantime.
function appendPendingImageForContext(contextKey, attachment) {
    if (contextKey !== 'home' && (!chats[contextKey] || chats[contextKey]._deleted)) {
        // The origin chat vanished while the file was being read: the upload
        // has nowhere to land. Say so instead of silently dropping it.
        if (typeof showSnackbar === 'function') showSnackbar(t('Attachment "{name}" was dropped: its chat was deleted', { name: (attachment && attachment.name) || t('file') }), 'warning');
        return;
    }
    var list = getPendingImagesOwnerContext() === contextKey ? pendingImageAttachments : (chatPendingImages[contextKey] || []);
    var total = _attachmentChars(attachment);
    for (var i = 0; i < list.length; i++) total += _attachmentChars(list[i]);
    if (total > MAX_PENDING_ATTACHMENT_CHARS) {
        // Images: instead of skipping, rebalance. Every image in the draft
        // (the new one included) is re-compressed to an equal share of the
        // budget left after non-image attachments (compressBase64Image lowers
        // JPEG quality, then dimensions). The old greedy approach (each image
        // kept up to 4.5MB, only the newcomer squeezed into what was left)
        // filled the draft after ~5 photos and skipped the rest of a batch.
        // Rebalances run one at a time (_imageFitQueue): a multi-file batch
        // completes concurrently and must not race on the same budget.
        if (_isFittableImage(attachment) && (attachment._fitRetried || 0) < 3 && typeof compressBase64Image === 'function') {
            _imageFitQueue = _imageFitQueue.then(function() {
                return _rebalanceAndAppendImage(contextKey, attachment);
            }).catch(function() {
                if (typeof showSnackbar === 'function') showSnackbar(t('Attachment "{name}" skipped: attachments would exceed ~30 MB', { name: attachment.name || t('file') }), 'error');
            });
            return;
        }
        if (typeof showSnackbar === 'function') showSnackbar(t('Attachment "{name}" skipped: attachments would exceed ~30 MB', { name: (attachment && attachment.name) || t('file') }), 'error');
        return;
    }
    if (attachment && attachment._fitRetried) delete attachment._fitRetried;
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
// originContextOverride: draft captured when an async source (e.g. images
// fetched from pasted HTML) started, so a late completion lands in the draft
// the user pasted into, not whichever view is visible by then.
function processImageFile(file, originContextOverride) {
    var hasOverride = !!originContextOverride && originContextOverride !== 'none';
    var originContext = hasOverride ? originContextOverride : getCurrentPendingContext();
    // S0B2-03: only the chat and Home composers can take an attachment. On other
    // views (dashboard, skills, settings, docs, history, documents) the file
    // would land in a hidden draft, and with no chat it was reported as "deleted".
    if (!hasOverride && ((currentView !== 'chat' && currentView !== 'home') || originContext === 'none')) {
        if (typeof showSnackbar === 'function') showSnackbar(t('Open a chat or Home to attach "{name}"', { name: (file && file.name) || t('file') }), 'info');
        return;
    }
    // Handle PDF files
    if (file.type === 'application/pdf') {
        // 10MB, same cap as images/text. The PDF is inlined as base64 (×1.33)
        // straight into the chat transcript / IDB with NO compression step
        // (unlike images), and the old 25MB cap let a ~33MB payload through —
        // over the provider's ~32MB request limit, so it failed at send time.
        if (file.size > 10 * 1024 * 1024) {
            showSnackbar(t('PDF too large (max 10MB)'), 'error');
            return;
        }

        var reader = new FileReader();
        // A read failure (permission revoked, file moved, I/O error) never
        // fires onload — surface it instead of silently dropping the attachment.
        reader.onerror = function() {
            showSnackbar(t('Could not read PDF'), 'error');
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
    // S0B2-05: every extension the pickers' accept lists offer (body.html) is read
    // as text; YAML often reports application/x-yaml or an empty MIME type.
    var TEXT_ATTACHMENT_EXTS = ['.csv', '.txt', '.json', '.xml', '.md', '.log', '.yml', '.yaml'];
    var lower = (file.name || '').toLowerCase();
    var isTextFile = file.type.startsWith('text/') || TEXT_ATTACHMENT_EXTS.some(function(x) { return lower.endsWith(x); });

    if (isTextFile) {
        if (file.size > 10 * 1024 * 1024) {
            showSnackbar(t('File too large (max 10MB)'), 'error');
            return;
        }

        var reader = new FileReader();
        reader.onerror = function() {
            showSnackbar(t('Could not read file'), 'error');
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
        showSnackbar(t('Unsupported file type. Use image, PDF, or text files.'), 'error');
        return;
    }

    // Raw sanity cap only (see MAX_IMAGE_RAW_BYTES): the real per-image limit
    // is enforced after resize + compression below.
    if (file.size > MAX_IMAGE_RAW_BYTES) {
        showSnackbar(t('Image too large (max 50MB file; images are resized and compressed to under 4.5MB)'), 'error');
        return;
    }

    var reader = new FileReader();
    reader.onload = function(e) {
        var img = new Image();
        img.onload = function() {
            // Downscale only (never upscale) to the maximum accepted long edge:
            // SCREENSHOT_MAX_LONG_EDGE (3000px, tools/020-tool-execution.js — the
            // tools tier is concatenated before app/, so the global is defined).
            // Same cap for every provider; larger images cost more tokens.
            var maxDim = SCREENSHOT_MAX_LONG_EDGE;
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

            // Compress if over the 4.5MB per-image limit (a 3000px PNG can be
            // well over it; compressBase64Image re-encodes it as JPEG), then
            // check the FINAL size (compression gives up at a 640px width floor).
            compressBase64Image(base64, MAX_IMAGE_ATTACHMENT_BYTES).then(function(compressed) {
                if (_dataUrlDecodedBytes(compressed) > MAX_IMAGE_ATTACHMENT_BYTES) {
                    showSnackbar(t('Image "{name}" is still over 4.5MB after compression', { name: file.name || name }), 'error');
                    return;
                }
                appendPendingImageForContext(originContext, {
                    base64: compressed,
                    name: name,
                    width: width,
                    height: height,
                    file_id: newFileId()
                });
            }).catch(function() {
                // Bug-sweep F8: surface compression failures instead of dropping silently.
                showSnackbar(t('Could not read image'), 'error');
            });
        };
        // Bug-sweep F8: a corrupt / unsupported image never fires onload.
        img.onerror = function() {
            showSnackbar(t('Could not read image'), 'error');
        };
        img.src = e.target.result;
    };
    // Same as the PDF/text readers: a FileReader failure never reaches
    // img.onerror, so it needs its own handler.
    reader.onerror = function() {
        showSnackbar(t('Could not read image'), 'error');
    };
    reader.readAsDataURL(file);
}

// Paste is ours unless it targets a NON-composer editable element: other
// inputs, textareas and contenteditable areas (settings, modals, widgets,
// documents) keep their native paste. Non-editable targets (body, a focused
// chip or button, a message bubble) still route images to the composer.
function _isComposerPasteTarget(target) {
    if (!target || target === document.body || target === document.documentElement || target === document) return true;
    var ed = target.closest && target.closest('input,textarea,[contenteditable]:not([contenteditable="false"])');
    return !ed || ed.id === 'message-input' || ed.id === 'home-message-input';
}

// Rich-text paste (web page, Word/Google Docs, Slack, email) carries its
// images only as <img src> inside text/html, with no image file item: collect
// those sources so they can be attached. data: and http(s) only (blob:/file:/
// cid: URLs are not readable from here); relative URLs resolve against a
// <base href> when the clipboard HTML has one. Deduped, capped.
var MAX_PASTED_HTML_IMAGES = 10;
function _decodeHtmlAttr(s) {
    return String(s).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#x([0-9a-f]+);/gi, function(m, h) { return String.fromCharCode(parseInt(h, 16)); })
        .replace(/&#(\d+);/g, function(m, d) { return String.fromCharCode(parseInt(d, 10)); });
}
function extractPastedHtmlImageSources(html) {
    if (typeof html !== 'string' || !/<img[\s>\/]/i.test(html)) return [];
    var baseM = /<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
    var base = baseM ? _decodeHtmlAttr(baseM[1] || baseM[2] || baseM[3] || '') : null;
    var re = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    var out = [], seen = {}, m;
    while ((m = re.exec(html)) && out.length < MAX_PASTED_HTML_IMAGES) {
        var src = _decodeHtmlAttr((m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3])) || '').trim();
        if (!src) continue;
        if (/^data:image\//i.test(src)) {
            // keep as-is
        } else if (/^https?:\/\//i.test(src)) {
            // keep as-is
        } else if (/^\/\//.test(src)) {
            src = 'https:' + src;
        } else if (base && !/^[a-z][a-z0-9+.-]*:/i.test(src)) {
            try { src = new URL(src, base).href; } catch (err) { continue; }
            if (!/^https?:\/\//i.test(src)) continue;
        } else {
            continue; // blob:, file:, cid:, data:non-image, unresolvable relative
        }
        if (seen[src]) continue;
        seen[src] = true;
        out.push(src);
    }
    return out;
}

var _PASTE_IMG_EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif' };
function _pastedImageName(src, idx) {
    if (!/^data:/i.test(src)) {
        try {
            var seg = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
            if (seg && /\.[a-z0-9]{2,5}$/i.test(seg)) return seg;
        } catch (err) {}
    }
    return 'pasted-image-' + (idx + 1);
}

// Fetch the <img> sources of a rich-text paste and attach them through
// processImageFile (same resize/compress/budget pipeline as any image).
// Best-effort: an image that cannot be fetched or is not an image is skipped,
// with one summary snackbar. The extension holds <all_urls> host access, so
// cross-origin fetches are not CORS-blocked here.
async function attachPastedHtmlImages(sources, originContext) {
    if (!sources || !sources.length || typeof fetch !== 'function') return 0;
    var failed = 0, attached = 0;
    await Promise.all(sources.map(async function(src, idx) {
        try {
            var res = await fetch(src, /^data:/i.test(src) ? undefined : { credentials: 'include' });
            if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
            var blob = await res.blob();
            var name = _pastedImageName(src, idx);
            var type = (blob && blob.type) || '';
            if (type.indexOf('image/') !== 0) {
                var ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
                type = ext ? (_PASTE_IMG_EXT_TYPES[ext.toLowerCase()] || '') : '';
            }
            if (type.indexOf('image/') !== 0) throw new Error('not an image');
            if (blob.size > MAX_IMAGE_RAW_BYTES) throw new Error('too large');
            var file = new File([blob], name, { type: type });
            processImageFile(file, originContext);
            attached++;
        } catch (err) {
            failed++;
        }
    }));
    if (failed && typeof showSnackbar === 'function') {
        showSnackbar(t('{count} pasted image(s) could not be attached', { count: failed }), 'warning');
    }
    return attached;
}

// Handle paste events for images and PDFs
function handlePasteForImages(e) {
    if (!_isComposerPasteTarget(e.target)) return;
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

    // Text + images copied from a web page / doc / Slack / email: the images
    // only exist as <img> in text/html (no file item), and were ignored.
    // Attach them; the text still pastes normally below. When the clipboard
    // already has an image file item (e.g. "Copy image"), that item IS the
    // html <img>, so skip extraction to avoid a duplicate.
    if (!hasFile && typeof e.clipboardData.getData === 'function') {
        var htmlSrcs = [];
        try { htmlSrcs = extractPastedHtmlImageSources(e.clipboardData.getData('text/html')); } catch (err) { htmlSrcs = []; }
        if (htmlSrcs.length) {
            var pasteCtx = typeof getCurrentPendingContext === 'function' ? getCurrentPendingContext() : null;
            var pasteView = typeof currentView !== 'undefined' ? currentView : null;
            if ((pasteView !== 'chat' && pasteView !== 'home') || !pasteCtx || pasteCtx === 'none') {
                if (typeof showSnackbar === 'function') showSnackbar(t('Open a chat or Home to attach pasted images'), 'info');
            } else {
                attachPastedHtmlImages(htmlSrcs, pasteCtx);
            }
            // Image-only HTML (no text): nothing for the native paste to insert.
            if (!e.clipboardData.getData('text/plain')) e.preventDefault();
        }
    }

    // If we processed a file, don't prevent default (allow text paste too)
    // But if ONLY file was pasted, prevent default
    if (hasFile && (!e.clipboardData.getData('text/plain'))) {
        e.preventDefault();
    }

    // Item 8: a very large text paste into a composer offers to attach it as
    // a .txt file instead (ui/246 composerOfferPasteAsFile). Smaller pastes
    // stay native. Also when the clipboard carries an image/PDF next to the
    // text (e.g. copied from Office/a browser): the file is attached above and
    // the large text still gets the offer instead of landing in the box.
    var ta = e.target && e.target.closest ? e.target.closest('textarea') : null;
    if (!ta || (ta.id !== 'message-input' && ta.id !== 'home-message-input')) return;
    var pasted = e.clipboardData.getData('text/plain');
    // Rich-text paste (web page, Google Doc, Outlook, Slack): keep hyperlink
    // URLs as Markdown [text](url) instead of only the anchor text
    // (ui/246 composerHtmlToTextWithLinks). null = no link to rescue, so the
    // native paste below stays untouched. Skipped when there is no plain text
    // (e.g. a linked image copied on its own — the file path above owns it).
    var linked = null;
    if (pasted && typeof composerHtmlToTextWithLinks === 'function') {
        try { linked = composerHtmlToTextWithLinks(e.clipboardData.getData('text/html'), pasted); } catch (err) { linked = null; }
    }
    var text = linked != null ? linked : pasted;
    if (typeof composerShouldOfferPasteAsFile === 'function' && composerShouldOfferPasteAsFile(text)) {
        e.preventDefault();
        composerOfferPasteAsFile(ta, text);
        return;
    }
    if (linked != null && typeof composerPasteText === 'function') {
        e.preventDefault();
        composerPasteText(ta, linked);
    }
}

// Track drag enter/leave depth for nested elements
var dragDepth = 0;
// S0B2-02: a lost dragleave (e.g. the element under the pointer is replaced
// mid-drag) left dragDepth > 0 and the overlay stuck. While a file drag is
// really over the page, dragover keeps firing and re-arms this heartbeat;
// once it stops, the overlay resets itself.
var DROP_OVERLAY_HEARTBEAT_MS = 1000, _dropHb = null;

// S0B2-01: only drags that carry files are ours. Text, link and in-page
// (e.g. dashboard) drags keep their native behavior: no preventDefault,
// no overlay, no depth change.
function isFileDrag(e) {
    var types = e && e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
}

function resetDropOverlay() {
    dragDepth = 0;
    if (_dropHb) { clearTimeout(_dropHb); _dropHb = null; }
    var o = document.getElementById('drop-overlay');
    if (o) o.classList.remove('visible');
}

function _armDropHeartbeat() {
    if (_dropHb) clearTimeout(_dropHb);
    _dropHb = setTimeout(resetDropOverlay, DROP_OVERLAY_HEARTBEAT_MS);
}

// Handle drag enter/over for the full page
function handleDragOver(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragDepth < 1) {
        dragDepth = 1;
        var overlay = document.getElementById('drop-overlay');
        if (overlay) overlay.classList.add('visible');
    }
    _armDropHeartbeat();
}

function handleDragEnter(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth++;
    if (dragDepth === 1) {
        var overlay = document.getElementById('drop-overlay');
        if (overlay) overlay.classList.add('visible');
    }
    _armDropHeartbeat();
}

// Handle drag leave for the full page
function handleDragLeave(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth--;
    if (dragDepth <= 0) resetDropOverlay();
}

// Handle drop for the full page
function handleDrop(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    resetDropOverlay();

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
    var removeLabel = escapeHtml(t('Remove'));
    if (pendingImageAttachments.length > 0) {
        pendingImageAttachments.forEach(function(img, idx) {
            if (img.fileType === 'document') {
                html += '<div class="pending-image-item pending-file-item" role="button" tabindex="0" data-kbd-click aria-label="' + escapeHtml(t('Open {title}', { title: img.name || '' })) + '" onclick="viewPendingImage(' + idx + ')" onkeydown="handlePendingChipKeydown(event, ' + idx + ')">';
                html += '<div class="pending-file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span class="pending-file-label">DOC</span></div>';
                html += '<div class="pending-file-name">' + escapeHtml(img.name) + '</div>';
                html += '<button class="pending-image-remove" onclick="event.stopPropagation();removePendingImage(' + idx + ')" title="' + removeLabel + '" aria-label="' + removeLabel + '">×</button>';
                html += '</div>';
            } else if (img.fileType === 'pdf') {
                html += '<div class="pending-image-item pending-pdf-item" role="button" tabindex="0" data-kbd-click aria-label="' + escapeHtml(t('Open {title}', { title: img.name || '' })) + '" onclick="viewPendingImage(' + idx + ')" onkeydown="handlePendingChipKeydown(event, ' + idx + ')">';
                html += '<div class="pending-pdf-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span class="pending-pdf-label">PDF</span></div>';
                html += '<div class="pending-pdf-name">' + escapeHtml(img.name) + '</div>';
                html += '<button class="pending-image-remove" onclick="event.stopPropagation();removePendingImage(' + idx + ')" title="' + removeLabel + '" aria-label="' + removeLabel + '">×</button>';
                html += '</div>';
            } else if (img.fileType === 'file') {
                var fileExt = (img.name || '').split('.').pop().toUpperCase();
                html += '<div class="pending-image-item pending-file-item" role="button" tabindex="0" data-kbd-click aria-label="' + escapeHtml(t('Open {title}', { title: img.name || '' })) + '" onclick="viewPendingImage(' + idx + ')" onkeydown="handlePendingChipKeydown(event, ' + idx + ')">';
                html += '<div class="pending-file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span class="pending-file-label">' + escapeHtml(fileExt) + '</span></div>';
                html += '<div class="pending-file-name">' + escapeHtml(img.name) + '</div>';
                html += '<button class="pending-image-remove" onclick="event.stopPropagation();removePendingImage(' + idx + ')" title="' + removeLabel + '" aria-label="' + removeLabel + '">×</button>';
                html += '</div>';
            } else {
                html += '<div class="pending-image-item" role="button" tabindex="0" data-kbd-click aria-label="' + escapeHtml(t('Open {title}', { title: img.name || '' })) + '" onclick="viewPendingImage(' + idx + ')" onkeydown="handlePendingChipKeydown(event, ' + idx + ')">';
                html += '<img src="' + escapeHtml(img.base64) + '" alt="' + escapeHtml(img.name) + '" />';
                html += '<button class="pending-image-remove" onclick="event.stopPropagation();removePendingImage(' + idx + ')" title="' + removeLabel + '" aria-label="' + removeLabel + '">×</button>';
                html += '</div>';
            }
        });
        var imageCount = pendingImageAttachments.filter(function(a) { return !a.fileType || a.fileType === 'image'; }).length;
        var pdfCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'pdf'; }).length;
        var fileCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'file'; }).length;
        var docCount = pendingImageAttachments.filter(function(a) { return a.fileType === 'document'; }).length; // Bug-sweep F6
        var parts = [];
        if (imageCount > 0) parts.push(tn(imageCount, '{count} image', '{count} images'));
        if (pdfCount > 0) parts.push(tn(pdfCount, '{count} PDF', '{count} PDFs'));
        if (fileCount > 0) parts.push(tn(fileCount, '{count} file', '{count} files'));
        if (docCount > 0) parts.push(tn(docCount, '{count} document', '{count} documents'));
        html += '<div class="pending-images-hint">' + t('{items} attached. Click to preview, or × to remove.', { items: parts.join(', ') }) + '</div>';
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
    // Attachment added/removed/restored: Send may become (un)available.
    if (typeof syncSendButton === 'function') syncSendButton();
}

// Remove a pending image by index
function removePendingImage(index) {
    pendingImageAttachments.splice(index, 1);
    renderPendingImages();
}

// Delete/Backspace on a focused chip (or its × button) removes it, then keeps
// keyboard focus in the tray: the chip now at this index, else the previous
// one, else the composer.
function handlePendingChipKeydown(e, index) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // A held key auto-repeats: remove only one chip per physical press.
    if (e.repeat) { e.preventDefault(); return; }
    e.preventDefault();
    e.stopPropagation();
    var container = e.currentTarget && e.currentTarget.parentNode;
    removePendingImage(index);
    var items = container ? container.querySelectorAll('.pending-image-item') : [];
    var next = items.length ? items[Math.min(index, items.length - 1)] : null;
    if (next) { next.focus(); return; }
    var inp = document.getElementById(getCurrentPendingContext() === 'home' ? 'home-message-input' : 'message-input');
    if (inp) inp.focus();
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
            showSnackbar(t('Document is no longer available'), 'warning');
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
                headerHtml += '<button class="modal-close-icon" onclick="viewPdfAnnotations(' + msgIndex + ')" title="' + escapeHtml(t('View parsed content')) + '">' + UI_ICONS.file + '</button>';
            }
        }
    }
    headerHtml += '<button class="modal-close-icon" onclick="downloadPdfFromModal()" title="' + escapeHtml(t('Download')) + '">' + UI_ICONS.download + '</button>';
    headerHtml += '<button class="modal-close-icon" onclick="closeModal()" title="' + escapeHtml(t('Close')) + '">' + UI_ICONS.close + '</button></div>';
    header.innerHTML = headerHtml;
    body.innerHTML = '<iframe src="' + escapeAttr(base64) + '" style="width:100%;height:100%;border:none;" title="' + escapeHtml(t('PDF Preview')) + '"></iframe>';
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
        showSnackbar(t('No parsed content available for this PDF'), 'info');
        return;
    }

    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');
    var pdfMsg = chat.messages[msgIndex];
    var pdfTitle = pdfMsg.name || pdfMsg.description || t('Document');

    overlay.classList.remove('pdf-modal');
    overlay.classList.add('screenshot-modal');
    header.innerHTML = '<span class="modal-title-text">' + t('Parsed: {title}', { title: escapeHtml(pdfTitle) }) + '</span><div class="modal-header-actions"><button class="modal-close-icon" onclick="openPdfFromMessage(' + msgIndex + ')" title="' + escapeHtml(t('Back to PDF')) + '">' + UI_ICONS.eye + '</button><button class="modal-close-icon" onclick="closeModal()" title="' + escapeHtml(t('Close')) + '">' + UI_ICONS.close + '</button></div>';

    var contentHtml = '<div class="pdf-annotations-content">';
    annotations.forEach(function(ann) {
        if (ann.type === 'file' && ann.file) {
            if (ann.file.name) {
                contentHtml += '<div class="pdf-ann-filename">' + escapeHtml(ann.file.name) + '</div>';
            }
            if (ann.file.hash) {
                contentHtml += '<div class="pdf-ann-hash">' + escapeHtml(t('Hash:')) + ' <code>' + escapeHtml(ann.file.hash) + '</code></div>';
            }
            if (ann.file.content && ann.file.content.length > 0) {
                ann.file.content.forEach(function(part) {
                    if (part.type === 'text') {
                        contentHtml += '<div class="pdf-ann-text">' + escapeHtml(part.text).replace(/\n/g, '<br>') + '</div>';
                    } else if (part.type === 'image_url' && part.image_url) {
                        contentHtml += '<div class="pdf-ann-image"><img src="' + escapeAttr(part.image_url.url || '') + '" alt="' + escapeHtml(t('Parsed image')) + '" /></div>';
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
    // A3A2-01: the stored name usually already ends in .pdf (e.g. "x.pdf").
    var name = body.dataset.pdfName || 'document';
    link.download = /\.pdf$/i.test(name) ? name : name + '.pdf';
    link.click();
}

// Open text file in modal for full-screen preview
function openFileModal(content, title, mimeType) {
    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');

    overlay.classList.add('file-modal');
    header.innerHTML = '<span class="modal-title-text">' + escapeHtml(title || t('File')) + '</span><div class="modal-header-actions"><button class="modal-close-icon" onclick="downloadTextFile()" title="' + escapeHtml(t('Download')) + '">' + UI_ICONS.download + '</button><button class="modal-close-icon" onclick="closeModal()" title="' + escapeHtml(t('Close')) + '">' + UI_ICONS.close + '</button></div>';
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
    if (!chat || !Array.isArray(chat.messages) || !chat.messages[msgIndex]) return;
    var msg = chat.messages[msgIndex];
    if (msg.role !== 'file' || !msg.content) return;
    openFileModal(msg.content, msg.name || t('File'), msg.mimeType);
}

// Open PDF preview from a chat message by index
function openPdfFromMessage(msgIndex) {
    var chat = chats[currentChatId];
    if (!chat || !Array.isArray(chat.messages) || !chat.messages[msgIndex]) return;
    var msg = chat.messages[msgIndex];
    if (msg.role !== 'pdf' || !msg.base64) return;
    openPdfModal(msg.base64, msg.name || msg.description || t('Document'), msgIndex);
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

// A6A3-02: the static #message-input placeholder (= src/html/body.html:136). A transient hint
// (e.g. openAddWidgetModal's) must not stick as every chat's placeholder.
var DEFAULT_COMPOSER_PLACEHOLDER = N_('Send a message...');

function restorePendingTextForContext(contextKey) {
    var inputId = contextKey === 'home' ? 'home-message-input' : 'message-input';
    var input = document.getElementById(inputId);
    if (input) {
        input.value = chatPendingTexts[contextKey] || '';
        if (inputId === 'message-input') input.placeholder = typeof DEFAULT_COMPOSER_PLACEHOLDER === 'string' ? t(DEFAULT_COMPOSER_PLACEHOLDER) : t('Send a message...');
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
    if (!chat || !Array.isArray(chat.messages) || !chat.messages[msgIndex]) return;
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
    if (!chat || !Array.isArray(chat.messages) || !chat.messages[msgIndex]) return;
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

    showSnackbar(t('Editing message - modify and send to branch'), 'success');
}

window.onload = init;