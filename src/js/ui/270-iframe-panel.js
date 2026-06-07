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
    // chrome.runtime.reload() restarts the WHOLE extension — including the
    // service worker (background.js + the imported sw-bundle.js, where the
    // agent loop and pause handling live). That is the ONLY reliable way to
    // pick up freshly deployed files from disk; a plain window.location.reload()
    // only reloads the panel page (app.js) and leaves the OLD service worker
    // running, so a new sw-bundle.js never takes effect.
    //
    // The reload kills all extension pages (side panel + tabs), so we set
    // reopenAppTab first and background.js reopens the app as a full tab
    // afterwards (sidePanel.open() needs a user gesture, so a tab is the only
    // reliable option from the background script).

    // No extension runtime (dev/web preview): all we can do is reload the page.
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.reload) {
        window.location.reload();
        return;
    }

    // A full reload tears down in-flight agent runs. Warn before doing so.
    // runningChatIds is a plain object keyed by chatId (core/030-config.js).
    var runningCount = 0;
    if (typeof runningChatIds !== 'undefined' && runningChatIds) {
        for (var _cid in runningChatIds) { if (runningChatIds[_cid]) runningCount++; }
    }
    if (runningCount > 0) {
        var msg = runningCount === 1
            ? 'An agent run is still in progress. Reloading the extension will stop it. Reload anyway?'
            : runningCount + ' agent runs are still in progress. Reloading the extension will stop them. Reload anyway?';
        if (!window.confirm(msg)) return;
    }

    // Fire the reload exactly once, and never let anything strand it.
    var _reloaded = false;
    function _doReload() {
        if (_reloaded) return;
        _reloaded = true;
        try {
            chrome.runtime.reload();
        } catch (e) {
            // Last resort if reload() itself throws — at least refresh the page.
            window.location.reload();
        }
    }

    // Persist reopenAppTab so background.js reopens the app as a full tab, then
    // fire the reload. CRITICAL: do NOT gate the reload solely on the storage
    // callback. If the service worker is asleep/busy or storage is blocked, the
    // callback can be delayed or never fire — which previously left
    // chrome.runtime.reload() unreached and the old SW running. We always fall
    // back via a short timer.
    function _startReloadSequence() {
        // Immediate feedback — the reload tears the page down a moment later.
        if (typeof showSnackbar === 'function') showSnackbar('Reloading extension…');
        try {
            if (chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ reopenAppTab: true }, function() {
                    // Touch lastError so Chrome doesn't log an unchecked-error warning.
                    if (chrome.runtime.lastError) { /* ignore */ }
                    _doReload();
                });
            }
        } catch (e) { /* fall through to the timer */ }
        // Guaranteed fallback: reload even if the storage callback never returns.
        setTimeout(_doReload, 400);
    }

    // Rebuild-then-reload: when running as an installed extension with a deploy
    // folder connected (and the in-browser build tool available), rebuild +
    // redeploy the extension from the workspace FIRST, so chrome.runtime.reload()
    // picks up the freshly built files from disk. Without a connected folder (or
    // build tool) there is nothing on disk to update, so we just reload.
    _rebuildBeforeReload().then(function(proceed) {
        if (proceed) _startReloadSequence();
    });
}

// Rebuild + redeploy the extension from the workspace before a reload, but only
// when a deploy folder is connected and the `extension_build` skill tool is
// loaded (the extension-dev skill is active). Reuses the exact same build the
// agent runs — no duplicated build logic. Returns a promise resolving to `true`
// when the caller should proceed with the reload, or `false` to abort (the user
// declined to reload after a failed build).
async function _rebuildBeforeReload() {
    try {
        // Need the in-browser build tool — provided by the extension-dev skill.
        if (typeof isSkillTool !== 'function' || !isSkillTool('extension_build')) return true;
        // Need a connected deploy folder, else there's nothing on disk to update.
        if (typeof getDeployDirHandle !== 'function') return true;
        var handle = await getDeployDirHandle();
        if (!handle) return true;

        if (typeof showSnackbar === 'function') showSnackbar('Rebuilding extension…');
        var res = await executeTool('extension_build', {});
        var ok = !!(res && res.success && res.stats && res.stats.jsFiles > 0 && res.stats.filesDeployed > 0);
        if (ok) return true;

        // Build/deploy failed — let the user decide whether to reload the
        // previously built files instead of silently shipping a broken build.
        var err = (res && (res.error || (res.deploy && res.deploy.error))) || 'no files were built/deployed (is the repo cloned?)';
        return window.confirm('Extension rebuild failed:\n' + err + '\n\nReload with the previously built files anyway?');
    } catch (e) {
        return window.confirm('Extension rebuild error:\n' + (e && e.message ? e.message : String(e)) + '\n\nReload with the previously built files anyway?');
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
