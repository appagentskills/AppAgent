// Screenshot navigation state
var screenshotNav = { list: [], index: -1 };

function getScreenshotList() {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages) return [];
    var list = [];
    chat.messages.forEach(function(msg) {
        if (msg.role === 'screenshot') list.push(msg);
    });
    return list;
}

// S0C-03: openScreenshotSourceUrl(url) backs the screenshot modal's Open URL button.
// It opens only http(s) URLs (the scheme match is case-insensitive), in a new tab with noopener.
function openScreenshotSourceUrl(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return;
    window.open(url, '_blank', 'noopener');
}

function navigateScreenshot(delta) {
    var newIndex = screenshotNav.index + delta;
    if (newIndex < 0 || newIndex >= screenshotNav.list.length) return;
    var s = screenshotNav.list[newIndex];
    // S0C12-01: a dialog that replaced the viewer body has no <img>; leave the
    // index and header untouched instead of throwing on a null img.
    var body = document.getElementById('modal-body');
    var img = body && body.querySelector('img');
    if (!img) return;
    screenshotNav.index = newIndex;
    var header = document.getElementById('modal-header');
    var titleText = escapeHtml(s.name || s.description || 'Screenshot');
    var sizeText = (s.width && s.height) ? ' <span class="screenshot-modal-size">' + s.width + ' × ' + s.height + 'px</span>' : '';
    var url = s.url || '';
    var urlBtn = /^https?:\/\//i.test(url) ? '<button class="modal-close-icon" onclick="openScreenshotSourceUrl(\'' + escapeJsString(url) + '\')" title="Open URL">' + UI_ICONS.externalLink + '</button>' : '';
    var counterText = '<span class="screenshot-modal-counter">' + (newIndex + 1) + ' / ' + screenshotNav.list.length + '</span>';
    header.innerHTML = '<div class="screenshot-modal-title">' + titleText + sizeText + counterText + '</div><div class="modal-header-actions">' + urlBtn + '<button class="modal-close-icon" onclick="downloadScreenshot()" title="Download">' + UI_ICONS.download + '</button><button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';
    img.src = s.base64;
    img.dataset.fullSrc = s.base64;
    updateNavArrows();
}

function updateNavArrows() {
    var prevBtn = document.querySelector('.screenshot-nav-prev');
    var nextBtn = document.querySelector('.screenshot-nav-next');
    if (prevBtn) prevBtn.style.display = screenshotNav.index > 0 ? '' : 'none';
    if (nextBtn) nextBtn.style.display = screenshotNav.index < screenshotNav.list.length - 1 ? '' : 'none';
}

function screenshotModalKeyHandler(e) {
    var overlay = document.getElementById('modal-overlay');
    if (!overlay.classList.contains('screenshot-modal') || !overlay.classList.contains('show')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); navigateScreenshot(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); navigateScreenshot(-1); }
}

// Open screenshot in modal for full view
function openScreenshotModal(src, title, width, height, url) {
    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');

    overlay.classList.add('screenshot-modal');

    // Build navigation state
    screenshotNav.list = getScreenshotList();
    screenshotNav.index = -1;
    for (var i = 0; i < screenshotNav.list.length; i++) {
        if (screenshotNav.list[i].base64 === src) { screenshotNav.index = i; break; }
    }
    var hasNav = screenshotNav.list.length > 1 && screenshotNav.index >= 0;

    var titleText = escapeHtml(title || 'Screenshot');
    var sizeText = (width && height) ? ' <span class="screenshot-modal-size">' + width + ' × ' + height + 'px</span>' : '';
    var counterText = hasNav ? '<span class="screenshot-modal-counter">' + (screenshotNav.index + 1) + ' / ' + screenshotNav.list.length + '</span>' : '';
    var urlBtn = /^https?:\/\//i.test(url) ? '<button class="modal-close-icon" onclick="openScreenshotSourceUrl(\'' + escapeJsString(url) + '\')" title="Open URL">' + UI_ICONS.externalLink + '</button>' : '';

    header.innerHTML = '<div class="screenshot-modal-title">' + titleText + sizeText + counterText + '</div><div class="modal-header-actions">' + urlBtn + '<button class="modal-close-icon" onclick="downloadScreenshot()" title="Download">' + UI_ICONS.download + '</button><button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';

    var navPrev = hasNav ? '<button class="screenshot-nav-prev" onclick="event.stopPropagation();navigateScreenshot(-1)" title="Previous (Left Arrow)"' + (screenshotNav.index <= 0 ? ' style="display:none"' : '') + '>' + UI_ICONS.chevronLeft + '</button>' : '';
    var navNext = hasNav ? '<button class="screenshot-nav-next" onclick="event.stopPropagation();navigateScreenshot(1)" title="Next (Right Arrow)"' + (screenshotNav.index >= screenshotNav.list.length - 1 ? ' style="display:none"' : '') + '>' + UI_ICONS.chevronRight + '</button>' : '';

    body.innerHTML = navPrev + '<img src="' + escapeHtml(src) + '" />' + navNext;
    actions.innerHTML = '';

    // Store full src for download
    body.querySelector('img').dataset.fullSrc = src;

    // Attach keyboard navigation
    document.addEventListener('keydown', screenshotModalKeyHandler);

    overlay.classList.add('show');
}

// S0B2-08: MEMFIX eviction deletes message payloads (base64), so the sidebar
// download buttons silently did nothing. Rehydrate once from the chat that was
// current at click time, else warn. Runs from inline onclick (async errors are
// not caught there), so it never throws.
async function _sidebarPayload(role, index, field) {
    var chatId = currentChatId;
    function pick() {
        var c = (typeof chats !== 'undefined' && chats) ? chats[chatId] : null;
        var list = (c && Array.isArray(c.messages)) ? c.messages : [];
        return list.filter(function(m) { return m && m.role === role; })[parseInt(index)];
    }
    // An empty text file (content '') is a real payload: only null/undefined content is missing.
    function missing(x) { return field === 'content' ? x[field] == null : !x[field]; }
    var m = pick();
    if (m && missing(m) && typeof ensureChatPayloads === 'function') {
        try { await ensureChatPayloads(chatId); } catch (e) {}
        m = pick();
    }
    if (!m || missing(m)) {
        if (typeof showSnackbar === 'function') showSnackbar('Attachment not available (still loading or removed)', 'warning');
        return null;
    }
    return m;
}

// S0B2-08: download extension from an image data URL (jpeg -> jpg), png otherwise.
function _imgExt(d) { var t = /^data:image\/(\w+)/.exec(d || ''); return t ? (t[1] === 'jpeg' ? 'jpg' : t[1]) : 'png'; }

function downloadScreenshot() {
    var img = document.querySelector('#modal-body img');
    if (!img || !img.dataset.fullSrc) return;

    var link = document.createElement('a');
    link.href = img.dataset.fullSrc;
    link.download = 'screenshot-' + Date.now() + '.' + _imgExt(img.dataset.fullSrc);
    link.click();
}

async function downloadScreenshotFromSidebar(screenshotIndex) {
    var screenshot = await _sidebarPayload('screenshot', screenshotIndex, 'base64');
    if (!screenshot) return;

    var link = document.createElement('a');
    link.href = screenshot.base64;
    var filename = (screenshot.name || screenshot.description || 'screenshot').replace(/[^a-zA-Z0-9_-]/g, '_');
    link.download = filename + '-' + Date.now() + '.' + _imgExt(screenshot.base64);
    link.click();
}

async function downloadPdfFromSidebar(pdfIndex) {
    var pdf = await _sidebarPayload('pdf', pdfIndex, 'base64');
    if (!pdf) return;

    var link = document.createElement('a');
    link.href = pdf.base64;
    var filename = (pdf.name || pdf.description || 'document').replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!filename.endsWith('.pdf')) filename += '.pdf';
    link.download = filename;
    link.click();
}

async function downloadFileFromSidebar(fileIndex) {
    var file = await _sidebarPayload('file', fileIndex, 'content');
    if (!file) return;

    var blob = new Blob([file.content], { type: file.mimeType || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = file.name || 'file.txt';
    link.click();
    URL.revokeObjectURL(url);
}

