// Iframe tool functions
function setBrowserControlsVisibility(visible) {
    // Update both main and home browser controls (URL input only)
    ['browser-controls', 'home-browser-controls'].forEach(function(id) {
        var controls = document.getElementById(id);
        if (!controls) return;
        // Show URL input only when browser panel is open (visible=false means iframe is open)
        controls.style.display = visible ? 'none' : '';
    });
    // Always show the standalone browse buttons in full-tab mode
    ['open-browser-btn', 'home-open-browser-btn'].forEach(function(id) {
        var btn = document.getElementById(id);
        if (btn) btn.style.display = '';
    });
}

function openIframePanel() {
    // No embedded iframe panel — browser runs as a real Chrome tab
    setBrowserControlsVisibility(false);
    appStorage.setItem('browserOpen', 'true');
}

function popOutToFullTab() {
    if (typeof chrome === 'undefined') return;
    // Open the current chat in a full tab
    var url = chrome.runtime.getURL('app.html?mode=tab');
    if (currentChatId) url += '&chat=' + encodeURIComponent(currentChatId);
    chrome.tabs.create({ url: url });
}

function expandSidePanel() {
    // Open full tab and close the side panel
    popOutToFullTab();
    // Side panels can close themselves via window.close()
    setTimeout(function() { window.close(); }, 300);
}

function reloadExtension() {
    // chrome.runtime.reload() is required to pick up new files from disk.
    // It kills all extension pages (side panel + tabs), so we always reopen
    // as a full tab — Chrome's sidePanel.open() requires a user gesture
    // and can't be called programmatically from the background script.
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ reopenAppTab: true }, function() {
            chrome.runtime.reload();
        });
    } else {
        window.location.reload();
    }
}

function openSidePanelFromTab() {
    // Must call chrome.sidePanel.open() directly in the click handler —
    // routing through the service worker loses the user gesture context
    if (typeof chrome === 'undefined' || !chrome.sidePanel) return;
    chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(function(e) {
        console.warn('Could not open side panel:', e.message);
    });
}

// Open a widget in its own Chrome tab
function openWidgetInIframePanel(widgetId) {
    var url = chrome.runtime.getURL('app.html') + '?widget=' + encodeURIComponent(widgetId);
    chrome.tabs.create({ url: url });
}

function openBrowserWithUrl(source, openedByAI) {
    if (source && typeof source === 'object' && source.preventDefault) source.preventDefault();

    // Full-tab mode: open side panel + navigate current tab to SN instance
    if (!document.body.classList.contains('sidepanel-mode')) {
        var snUrl = Platform.instanceUrl;
        if (!snUrl) {
            showSnackbar('No ServiceNow instance connected. Open a ServiceNow page first.', 'error');
            return;
        }
        // Save chat state before leaving
        appStorage.setItem('lastChatId', currentChatId);
        saveChatsToStorage().then(function() {
            // Open side panel (user gesture from click — this works)
            if (typeof chrome !== 'undefined' && chrome.sidePanel) {
                chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).then(function() {
                    window.location.href = snUrl;
                }).catch(function() {
                    window.location.href = snUrl;
                });
            } else {
                window.location.href = snUrl;
            }
        });
        return;
    }

    var urlInput = document.getElementById('browser-url-input');
    var url = urlInput.value.trim() || '/';
    openIframePanel();
    navigateIframe(url);
}

// Open a UI page in the browser panel by name
function openUIPageInBrowser(pageName) {
    if (!pageName) return;
    var url = '/' + pageName + '.do';
    var urlInput = document.getElementById('browser-url-input');
    if (urlInput) urlInput.value = url;
    openIframePanel();
    navigateIframe(url);
}

async function screenshotUIPage(pageName) {
    if (!pageName) return;
    var url = '/' + pageName + '.do';

    // Open page in a temp tab, screenshot, download, close
    var fullUrl = (Platform.instanceUrl || '') + url;
    var tab = await chrome.tabs.create({ url: fullUrl, active: false });
    await new Promise(function(resolve) {
        function onUpdated(tabId, info) {
            if (tabId === tab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                clearTimeout(fb);
                setTimeout(resolve, 500);
            }
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
        var fb = setTimeout(function() { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 8000);
    });
    var chat = chats[currentChatId];
    var origTabId = chat && chat.targetTabId;
    if (chat) chat.targetTabId = tab.id;
    var result = await Platform.sendBrowserAction('take_screenshot', {});
    if (chat) chat.targetTabId = origTabId;
    try { chrome.tabs.remove(tab.id); } catch(e) {}
    if (result.error) { showSnackbar('Screenshot failed', 'error'); return; }
    var link = document.createElement('a');
    link.href = result.base64;
    link.download = pageName + '.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Alias for home card
function openBrowser() {
    openBrowserWithUrl();
}
