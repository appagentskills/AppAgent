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

function navigateScreenshot(delta) {
    var newIndex = screenshotNav.index + delta;
    if (newIndex < 0 || newIndex >= screenshotNav.list.length) return;
    var s = screenshotNav.list[newIndex];
    screenshotNav.index = newIndex;
    var body = document.getElementById('modal-body');
    var header = document.getElementById('modal-header');
    var titleText = escapeHtml(s.name || s.description || 'Screenshot');
    var sizeText = (s.width && s.height) ? ' <span class="screenshot-modal-size">' + s.width + ' × ' + s.height + 'px</span>' : '';
    var url = s.url || '';
    var urlBtn = url ? '<button class="modal-close-icon" onclick="window.open(\'' + escapeJsString(url) + '\', \'_blank\')" title="Open URL">' + UI_ICONS.externalLink + '</button>' : '';
    var counterText = '<span class="screenshot-modal-counter">' + (newIndex + 1) + ' / ' + screenshotNav.list.length + '</span>';
    header.innerHTML = '<div class="screenshot-modal-title">' + titleText + sizeText + counterText + '</div><div class="modal-header-actions">' + urlBtn + '<button class="modal-close-icon" onclick="downloadScreenshot()" title="Download">' + UI_ICONS.download + '</button><button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';
    body.querySelector('img').src = s.base64;
    body.querySelector('img').dataset.fullSrc = s.base64;
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
    var urlBtn = url ? '<button class="modal-close-icon" onclick="window.open(\'' + escapeJsString(url) + '\', \'_blank\')" title="Open URL">' + UI_ICONS.externalLink + '</button>' : '';

    header.innerHTML = '<div class="screenshot-modal-title">' + titleText + sizeText + counterText + '</div><div class="modal-header-actions">' + urlBtn + '<button class="modal-close-icon" onclick="downloadScreenshot()" title="Download">' + UI_ICONS.download + '</button><button class="modal-close-icon" onclick="closeModal()" title="Close">' + UI_ICONS.close + '</button></div>';

    var navPrev = hasNav ? '<button class="screenshot-nav-prev" onclick="event.stopPropagation();navigateScreenshot(-1)" title="Previous (Left Arrow)"' + (screenshotNav.index <= 0 ? ' style="display:none"' : '') + '>' + UI_ICONS.chevronLeft + '</button>' : '';
    var navNext = hasNav ? '<button class="screenshot-nav-next" onclick="event.stopPropagation();navigateScreenshot(1)" title="Next (Right Arrow)"' + (screenshotNav.index >= screenshotNav.list.length - 1 ? ' style="display:none"' : '') + '>' + UI_ICONS.chevronRight + '</button>' : '';

    body.innerHTML = navPrev + '<img src="' + src + '" />' + navNext;
    actions.innerHTML = '';

    // Store full src for download
    body.querySelector('img').dataset.fullSrc = src;

    // Attach keyboard navigation
    document.addEventListener('keydown', screenshotModalKeyHandler);

    overlay.classList.add('show');
}

function downloadScreenshot() {
    var img = document.querySelector('#modal-body img');
    if (!img || !img.dataset.fullSrc) return;

    var link = document.createElement('a');
    link.href = img.dataset.fullSrc;
    link.download = 'screenshot-' + Date.now() + '.png';
    link.click();
}

function downloadScreenshotFromSidebar(screenshotIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages) return;

    var screenshots = [];
    chat.messages.forEach(function(msg) {
        if (msg.role === 'screenshot') screenshots.push(msg);
    });

    var screenshot = screenshots[parseInt(screenshotIndex)];
    if (!screenshot || !screenshot.base64) return;

    var link = document.createElement('a');
    link.href = screenshot.base64;
    var filename = (screenshot.name || screenshot.description || 'screenshot').replace(/[^a-zA-Z0-9_-]/g, '_');
    link.download = filename + '-' + Date.now() + '.png';
    link.click();
}

function downloadPdfFromSidebar(pdfIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages) return;

    var pdfs = [];
    chat.messages.forEach(function(msg) {
        if (msg.role === 'pdf') pdfs.push(msg);
    });

    var pdf = pdfs[parseInt(pdfIndex)];
    if (!pdf || !pdf.base64) return;

    var link = document.createElement('a');
    link.href = pdf.base64;
    var filename = (pdf.name || pdf.description || 'document').replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!filename.endsWith('.pdf')) filename += '.pdf';
    link.download = filename;
    link.click();
}

function downloadFileFromSidebar(fileIndex) {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages) return;

    var files = [];
    chat.messages.forEach(function(msg) {
        if (msg.role === 'file') files.push(msg);
    });

    var file = files[parseInt(fileIndex)];
    if (!file || !file.content) return;

    var blob = new Blob([file.content], { type: file.mimeType || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = file.name || 'file.txt';
    link.click();
    URL.revokeObjectURL(url);
}

