async function init() {
    // Legacy frame-bust: only relevant to the old ServiceNow UI Page deployment
    // (app loaded inside gsft_main). In the Chrome extension app.html is always
    // the top frame, so this would wrongly point window.top at
    // <top-origin>/app.html (e.g. the ServiceNow instance). Skip it entirely for
    // chrome-extension: pages; keep it only for a genuine same-origin platform iframe.
    if (window.self !== window.top && location.protocol !== 'chrome-extension:') {
        try {
            window.top.location.href = window.location.pathname;
            return;
        } catch (e) {
            // Sandboxed iframe (e.g., integrated browser) - continue normally
        }
    }

    // Check for standalone dashboard mode (?standalone=dashboard)
    var urlParams = new URLSearchParams(window.location.search);
    var standaloneMode = urlParams.get('standalone');
    if (standaloneMode === 'dashboard') {
        document.body.classList.add('standalone-dashboard');
    }

    // Show the reload button only when a Reload would rebuild + redeploy from the
    // workspace (extension-dev skill active + deploy folder connected). The buttons
    // default to display:none in markup, so non-dev users never see them.
    if (typeof updateReloadBtnVisibility === 'function') updateReloadBtnVisibility();

    // Side panel vs. full-tab layout
    if (urlParams.get('mode') !== 'tab') {
        document.body.classList.add('sidepanel-mode');
        var _expandBtn = document.getElementById('ext-expand-btn');
        if (_expandBtn) _expandBtn.style.display = '';
        var _homeExpandBtn = document.getElementById('home-ext-expand-btn');
        if (_homeExpandBtn) _homeExpandBtn.style.display = '';
    } else {
        setBrowserControlsVisibility(true);
    }

    // ===========================================
    // PHASE 1: Synchronous localStorage + Icons (instant UI)
    // ===========================================

    // Read savedView once and reuse throughout init()
    var savedView = appStorage.getItem('currentView');
    if (document.body.classList.contains('standalone-dashboard')) {
        savedView = 'dashboard';
    }

    // Load localStorage preferences first (synchronous)
    loadLocalScopeOverride();
    loadVersionSidebarState();

    var savedShowApiStats = appStorage.getItem('showApiStats');
    if (savedShowApiStats !== null) showApiStats = savedShowApiStats === 'true';
    var statsCheckbox = document.getElementById('show-api-stats');
    if (statsCheckbox) statsCheckbox.checked = showApiStats;

    var savedCompactToolCalls = appStorage.getItem('compactToolCalls');
    if (savedCompactToolCalls !== null) compactToolCalls = savedCompactToolCalls === 'true';
    var compactCheckbox = document.getElementById('compact-tool-calls');
    if (compactCheckbox) compactCheckbox.checked = compactToolCalls;

    var savedScreenshotMethod = appStorage.getItem('screenshotMethod');
    if (savedScreenshotMethod) screenshotMethod = savedScreenshotMethod;

    // Load and apply theme (before any rendering to avoid flash)
    var savedTheme = appStorage.getItem('appTheme');
    if (savedTheme) appTheme = savedTheme;
    applyTheme();

    // Restore sidebar state (default collapsed) - no animation on initial load
    var savedSidebarState = appStorage.getItem('sidebarCollapsed');
    sidebarCollapsed = savedSidebarState === 'true';
    var sidebar = document.getElementById('sidebar');
    if (sidebar) {
        if (sidebarCollapsed) sidebar.classList.remove('expanded');
        updateSidebarToggleIcon();
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                sidebar.classList.remove('no-transition');
            });
        });
    }

    // Setup credits display click handler and initialize with cached value
    var creditsDisplay = document.getElementById('credits-display');
    var homeCreditsDisplay = document.getElementById('home-credits-display');
    var cachedCreditsVal = appStorage.getItem('cachedCredits');
    if (creditsDisplay) {
        creditsDisplay.onclick = function() { refreshClaudeOAuthUsage(true); fetchCredits(); };
        // cachedCredits already embeds its unit ('$12.34' or '57% for 2h') — no '$' prefix
        if (cachedCreditsVal) creditsDisplay.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + cachedCreditsVal;
    }
    if (homeCreditsDisplay) {
        homeCreditsDisplay.onclick = function() { refreshClaudeOAuthUsage(true); fetchCredits(); };
        if (cachedCreditsVal) {
            homeCreditsDisplay.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + cachedCreditsVal;
            homeCreditsDisplay.style.display = '';
        }
    }

    // Initialize UI icons immediately
    var settingsBtns = document.querySelectorAll('.settings-btn');
    settingsBtns.forEach(function(btn) { btn.innerHTML = UI_ICONS.settings; });
    // Initialize header toggle-sidebar-btn icons (expand panel)
    var toggleSidebarBtns = document.querySelectorAll('.toggle-sidebar-btn');
    toggleSidebarBtns.forEach(function(btn) { btn.innerHTML = UI_ICONS.panelLeftOpen; });

    // Initialize icons not in HTML (dynamic elements)
    var floatingMenuIcon = document.getElementById('floating-menu-icon');
    var versionSidebarOpen = document.getElementById('version-sidebar-open');
    var versionSidebarClose = document.getElementById('version-sidebar-close');
    var browseIcon = document.getElementById('browse-icon');
    if (floatingMenuIcon) floatingMenuIcon.innerHTML = UI_ICONS.menu;
    if (versionSidebarOpen) versionSidebarOpen.innerHTML = UI_ICONS.menu;
    if (versionSidebarClose) versionSidebarClose.innerHTML = UI_ICONS.close;
    if (browseIcon) browseIcon.innerHTML = UI_ICONS.panelLeftOpen;
    var homeBrowseIcon = document.getElementById('home-browse-icon');
    if (homeBrowseIcon) homeBrowseIcon.innerHTML = UI_ICONS.panelLeftOpen;
    
    // Restore history section state
    var savedHistoryState = appStorage.getItem('historyExpanded');
    historyExpanded = savedHistoryState !== 'false'; // Default to expanded
    var chatList = document.getElementById('chat-list');
    var historyBtn = document.getElementById('history-toggle-btn');
    if (chatList && !historyExpanded) chatList.classList.add('collapsed');
    if (historyBtn && historyExpanded) historyBtn.classList.add('expanded');
    
    // Initialize input button icons
    var pauseIcon = document.getElementById('pause-icon');
    var sendIcon = document.getElementById('send-icon');
    var retryIcon = document.getElementById('retry-icon');
    var continueIcon = document.getElementById('continue-icon');
    var attachIcon = document.getElementById('attach-icon');
    var newChatIcon = document.querySelector('.new-chat-icon');
    var homeAttachIcon = document.getElementById('home-attach-icon');
    var homeSendIcon = document.getElementById('home-send-icon');
    if (pauseIcon) pauseIcon.innerHTML = UI_ICONS.pause;
    if (sendIcon) sendIcon.innerHTML = UI_ICONS.send;
    if (retryIcon) retryIcon.innerHTML = UI_ICONS.retry;
    if (continueIcon) continueIcon.innerHTML = UI_ICONS.play;
    if (attachIcon) attachIcon.innerHTML = UI_ICONS.attach;
    if (newChatIcon) newChatIcon.innerHTML = UI_ICONS.compose;
    if (homeAttachIcon) homeAttachIcon.innerHTML = UI_ICONS.attach;
    if (homeSendIcon) homeSendIcon.innerHTML = UI_ICONS.send;
    
    var ssPreviewDownloadBtn = document.getElementById('screenshot-preview-download-btn');
    var ssPreviewCloseBtn = document.getElementById('screenshot-preview-close-btn');
    if (ssPreviewDownloadBtn) ssPreviewDownloadBtn.innerHTML = UI_ICONS.download;
    if (ssPreviewCloseBtn) ssPreviewCloseBtn.innerHTML = UI_ICONS.close;

    // Initialize header rename button icon
    var headerRenameBtn = document.getElementById('header-rename-btn');
    if (headerRenameBtn) headerRenameBtn.innerHTML = UI_ICONS.edit;

    // Initialize settings panel icons
    var sectionIconModel = document.getElementById('section-icon-model');
    var sectionIconScope = document.getElementById('section-icon-scope');
    var sectionIconPermissions = document.getElementById('section-icon-permissions');
    var sectionIconDisplay = document.getElementById('section-icon-display');
    var sectionIconCache = document.getElementById('section-icon-cache');
    var sectionIconData = document.getElementById('section-icon-data');
    var dataIconExport = document.getElementById('data-icon-export');
    var dataIconImport = document.getElementById('data-icon-import');
    var dataIconDelete = document.getElementById('data-icon-delete');
    if (sectionIconModel) sectionIconModel.innerHTML = UI_ICONS.model;
    if (sectionIconScope) sectionIconScope.innerHTML = UI_ICONS.scope;
    if (sectionIconPermissions) sectionIconPermissions.innerHTML = UI_ICONS.shield;
    if (sectionIconDisplay) sectionIconDisplay.innerHTML = UI_ICONS.display;
    if (sectionIconCache) sectionIconCache.innerHTML = UI_ICONS.cache;
    if (sectionIconData) sectionIconData.innerHTML = UI_ICONS.database;
    if (dataIconExport) dataIconExport.innerHTML = UI_ICONS.download;
    if (dataIconImport) dataIconImport.innerHTML = UI_ICONS.upload;
    if (dataIconDelete) dataIconDelete.innerHTML = UI_ICONS.trash;

    // Initialize image attachment event listeners (paste, drag & drop)
    initImageAttachmentListeners();

    // Initialize cache token limit input (settings page; value in K tokens,
    // matching renderSettingsPage in ui/040-tools-settings.js)
    var cacheTokenInput = document.getElementById('settings-page-cache-limit');
    if (cacheTokenInput) cacheTokenInput.value = Math.round(cacheTokenLimit / 1000);
    
    // Setup and update storage indicator
    updateStorageIndicator();
    
    // Setup keyboard shortcut for ⌘K to focus search
    document.addEventListener('keydown', function(e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            var searchInput = document.getElementById('chat-search-input');
            var sidebar = document.getElementById('sidebar');
            if (searchInput) {
                // Expand sidebar if collapsed
                if (sidebar && !sidebar.classList.contains('expanded')) {
                    toggleSidebar();
                }
                searchInput.focus();
            }
        }
    });

    // Global Escape handler — closes the topmost overlay/modal
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        // Order: highest z-index first
        if (document.getElementById('widget-fullscreen-overlay')) { closeWidgetFullscreen(); return; }
        if (document.getElementById('widget-edit-overlay')) { closeWidgetCodeEdit(); return; }
        if (document.getElementById('widget-modal-overlay')) { closeWidgetModal(); return; }
        if (document.getElementById('widget-history-modal-overlay')) { closeWidgetHistory(); return; }
        var modal = document.getElementById('modal-overlay');
        if (modal && modal.classList.contains('show')) { closeModal(); return; }
    });

    // Restore impersonation state
    impersonateOriginalUserSysId = appStorage.getItem('impersonateOriginalUserSysId') || null;

    // Extension never auto-opens the browser panel — hide URL input on load
    var urlInput = document.getElementById('browser-url-input');
    if (urlInput) urlInput.style.display = 'none';
    
    var messageInput = document.getElementById('message-input');
    if (messageInput) messageInput.focus();
    
    // Initialize skills button icon
    var skillsBtn = document.getElementById('skills-btn');
    if (skillsBtn) {
        var skillsIcon = skillsBtn.querySelector('.skills-icon');
        if (skillsIcon) skillsIcon.innerHTML = UI_ICONS.skill;
    }
    // Initialize dashboard button icon
    var dashboardBtn = document.getElementById('dashboard-btn');
    if (dashboardBtn) {
        var dashboardIcon = dashboardBtn.querySelector('.skills-icon');
        if (dashboardIcon) dashboardIcon.innerHTML = UI_ICONS.widget;
    }
    document.querySelectorAll('.skills-back-btn .back-icon').forEach(function(el) { el.innerHTML = UI_ICONS.back; });
    document.querySelectorAll('.skills-action-btn .action-icon').forEach(function(el) {
        var btn = el.parentElement;
        if (!btn) return;
        var text = btn.textContent || '';
        if (text.indexOf('Import') !== -1) el.innerHTML = UI_ICONS.upload;
        else if (text.indexOf('Export') !== -1) el.innerHTML = UI_ICONS.download;
        else if (text.indexOf('New') !== -1 || text.indexOf('Add') !== -1) el.innerHTML = UI_ICONS.plus;
        else if (text.indexOf('Delete') !== -1) el.innerHTML = UI_ICONS.trash;
        else if (text.indexOf('Save') !== -1) el.innerHTML = UI_ICONS.save;
        else if (text.indexOf('Download') !== -1) el.innerHTML = UI_ICONS.download;
        else if (text.indexOf('Refresh') !== -1 || text.indexOf('Regenerate') !== -1) el.innerHTML = UI_ICONS.refresh;
        else if (text.indexOf('Headers') !== -1) el.innerHTML = UI_ICONS.menu;
        else if (text.indexOf('Standalone') !== -1) el.innerHTML = UI_ICONS.externalLink;
        else if (text.indexOf('More') !== -1) el.innerHTML = UI_ICONS.moreHorizontal;
    });
    // Initialize dropdown menu icons
    var moreStandaloneIcon = document.getElementById('more-standalone-icon');
    var moreHeadersIcon = document.getElementById('more-headers-icon');
    var moreRefreshIcon = document.getElementById('more-refresh-icon');
    var moreImportIcon = document.getElementById('more-import-icon');
    var moreExportIcon = document.getElementById('more-export-icon');
    if (moreStandaloneIcon) moreStandaloneIcon.innerHTML = UI_ICONS.externalLink;
    if (moreHeadersIcon) moreHeadersIcon.innerHTML = UI_ICONS.menu;
    if (moreRefreshIcon) moreRefreshIcon.innerHTML = UI_ICONS.refresh;
    if (moreImportIcon) moreImportIcon.innerHTML = UI_ICONS.upload;
    if (moreExportIcon) moreExportIcon.innerHTML = UI_ICONS.download;

    // Show input area now that icons are initialized
    var inputArea = document.getElementById('input-area');
    if (inputArea) inputArea.style.visibility = 'visible';
    // Panel visibility is handled by inline script after panels are defined

    // ===========================================
    // PHASE 2: IndexedDB async loading
    // ===========================================
    // WIPE-GUARD: ask the browser to mark this origin's storage as persistent
    // so IndexedDB (chats, skills, files) is exempt from best-effort eviction
    // under disk pressure. Paired with the manifest's `unlimitedStorage`
    // permission (lifts the per-origin quota). Best-effort — failures are
    // non-fatal and logged only.
    try {
        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().then(function(granted) {
                if (!granted) console.warn('[init] storage.persist() not granted — origin data remains best-effort evictable');
            }).catch(function() {});
        }
    } catch (e) {}
    await loadChatsFromStorage();
    // After the SW 'hello' has had a chance to repopulate runningChatIds for
    // genuinely-live runs, clear any stale status:'pending' tool-approval rows
    // left by an abandoned/reloaded run (else a permission bell shows forever
    // on a chat with nothing there). One-shot; guarded inside the function.
    try { setTimeout(function() { try { if (typeof reconcileStaleApprovals === 'function') reconcileStaleApprovals(); } catch (e) {} }, 4000); } catch (e) {}
    await loadApiProviders();
    await loadProviderFromStorage();
    await loadToolPermissions();
    await loadCacheTokenLimit();
    await loadCustomSystemPrompt();
    await loadHooksSettings();
    await loadSkillsFromStorage();
    await loadActiveSkills();
    await importEmbeddedSkills();
    // Re-evaluate the reload-button gate now that skill tools are loaded. The gate
    // call at the top of init() runs before skills load, so isSkillTool('extension_build')
    // is false there and the button stays hidden. (Regression from the gating PR.)
    if (typeof updateReloadBtnVisibility === 'function') updateReloadBtnVisibility();
    await loadDashboardWidgets();
    await loadAllDocuments();
    await loadAllActionStates(); // restore in-flight action states from IDB
    // Restore sub-agent records from IDB. Subs that were `running` at
    // crash/reload time get re-queued in the worker pool so their loop
    // resumes from the persisted chat history. See SubAgents.loadAll.
    if (typeof SubAgents !== 'undefined' && SubAgents.loadAll) {
        try { await SubAgents.loadAll(); } catch (e) { /* non-fatal */ }
    }
    cleanupStaleWorkspaces(); // remove old-format workspace metas with no files
    setSetting('defaultWorkspaceRepo', null); // migration: remove stale default pointer
    refreshWorkspaceContext(); // async, no await — non-blocking
    updateWorkspaceHeaderStatus(); // show local state immediately
    syncAndUpdateWorkspaceHeader(); // then sync with remote in background

    // Restore pending images and text from IndexedDB
    await restorePendingImagesFromSession();
    await restorePendingTextsFromStorage();

    // Now render UI that depends on IndexedDB data
    renderChatList();
    renderAllActionPlacements(); // render action buttons in home/header/chat/sidebar
    populateProviderDropdown();
    updateModelDisplay();
    renderToolPermissions();

    // Deep-link to a specific chat via ?chat= parameter (used by side panel expand)
    var deepLinkChatId = urlParams.get('chat');

    // Restore last viewed chat or start new chat
    var willShowNonChatView = savedView === 'dashboard' || savedView === 'skills' || savedView === 'home' || savedView === 'documents' || !savedView;
    var lastChatId = deepLinkChatId || appStorage.getItem('lastChatId');
    var isNewChat = false;
    if (lastChatId && chats[lastChatId]) {
        if (willShowNonChatView) {
            currentChatId = lastChatId;
            isNewChat = !chats[lastChatId].messages || chats[lastChatId].messages.length === 0;
        } else {
            selectChat(lastChatId);
            isNewChat = !chats[lastChatId].messages || chats[lastChatId].messages.length === 0;
        }
    } else {
        currentChatId = generateId();
        chats[currentChatId] = { id: currentChatId, title: 'New Chat', messages: [], createdAt: Date.now(), isTemporary: true };
        appStorage.setItem('lastChatId', currentChatId);
        versionHistory = [];
        clearUpdateSet();
        if (!willShowNonChatView) {
            renderChatList();
            renderMessages();
            renderVersionSidebar();
            updateInputPosition();
            updateChatTitleHeader();
        }
        isNewChat = true;
    }

    // SAGF-1 / SWM2-T2: thread the initial focus to the SW so its sub-agent GC
    // paths don't reclaim the viewed transcript (in the SW currentChatId is null).
    // When boot will show a NON-chat view (willShowNonChatView), post null instead of
    // currentChatId — otherwise we pin a chat the user isn't actually viewing (the same
    // stale pin SWM2-F3 clears on a view-leave), wrongly protecting it from GC. The
    // chat-render branch above already covers the chat case; this is re-posted on
    // every later chat switch.
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(willShowNonChatView ? null : currentChatId);

    // Show/hide version sidebar based on chat state
    if (isNewChat || !chats[currentChatId] || !chats[currentChatId].messages || chats[currentChatId].messages.length === 0) {
        var versionSidebar = document.getElementById('version-sidebar');
        var openBtn = document.getElementById('version-sidebar-open');
        if (versionSidebar) versionSidebar.classList.remove('visible');
        if (openBtn) openBtn.classList.add('visible');
    } else {
        updateVersionSidebarVisibility();
    }

    // Restore scroll position for current chat (no animation)
    var savedScrollPos = appStorage.getItem('scrollPos_' + currentChatId);
    if (savedScrollPos) {
        var messagesContainer = document.getElementById('messages');
        if (messagesContainer) {
            messagesContainer.scrollTop = parseInt(savedScrollPos, 10);
        }
    }

    // Restore pending input text for current chat (per-chat from IndexedDB)
    // (messageInput was already looked up earlier in init — reuse it)
    if (messageInput && chatPendingTexts[currentChatId]) {
        messageInput.value = chatPendingTexts[currentChatId];
        autoResizeTextarea(messageInput);
    }

    // Update context indicator after restoring input
    updateContextIndicator();

    // ===========================================
    // PHASE 3: Restore view state (uses savedView from top of init)
    // ===========================================
    var savedSkillId = appStorage.getItem('currentEditingSkill');
    if (savedView === 'skill-editor' && savedSkillId && skills[savedSkillId]) {
        // Restore skill editor with the specific skill
        currentView = 'skills';
        hideAllPanels();
        var skillsPanel = document.getElementById('skills-panel');
        if (skillsPanel) skillsPanel.style.display = 'flex';
        openSkillEditor(savedSkillId);
        updateAllButtonStates();
    } else if (savedView === 'dashboard') {
        openDashboardView();
    } else if (savedView === 'skills') {
        openSkillsView();
    } else if (savedView === 'docs') {
        openDocsView();
    } else if (savedView === 'settings-page') {
        openSettingsPageView();
    } else if (savedView === 'history') {
        openHistoryView();
    } else if (savedView === 'documents') {
        openDocumentsView();
    } else if (savedView === 'chat') {
        // Show browser controls for chat view
        currentView = 'chat';
        showChatView();
        updateAllButtonStates();
    } else if (savedView === 'home' || !savedView) {
        // Default to home for first-time users
        openHomeView();
    }

    // Deep-link to a specific widget via ?widget= parameter
    var deepLinkWidgetId = urlParams.get('widget');
    if (deepLinkWidgetId) {
        var dlWidget = getWidgetById(deepLinkWidgetId) || (dashboardWidgets && dashboardWidgets[deepLinkWidgetId]);
        if (dlWidget && dlWidget.html) {
            document.body.innerHTML = '';
            document.body.style.margin = '0';
            var wf = document.createElement('iframe');
            wf.style.cssText = 'width:100%;height:100vh;border:none;display:block;';
            document.body.appendChild(wf);
            // Deterministic render-complete signal for take_screenshot's widget
            // capture path. This tab is opened (active:false) solely to rasterize
            // the widget, which renders inside a cross-origin sandbox iframe. Once
            // that sandbox posts 'widgetContentLoaded' (fired AFTER it mounts the
            // HTML and double-rAF/fonts settle layout), we stamp a stable DOM marker
            // and broadcast the widget's contentVersion on a same-origin
            // BroadcastChannel. The capturing tab resolves only when the broadcast
            // version matches the &_cv it requested, so it can never capture a stale
            // frame from a prior edit. IMPORTANT: we ECHO the requested &_cv back
            // verbatim rather than re-reading dlWidget.contentVersion from storage.
            // The capturer's match requires String(d.contentVersion)===String(_wssCv)
            // where _wssCv is the side panel's IN-MEMORY contentVersion at capture
            // time. This temp tab reloads widget state fresh from storage, whose
            // contentVersion can be undefined (freshly created widget) or stale
            // (an in-memory edit_html bump not yet persisted) -> the stored value
            // would never match _wssCv and the signal ALWAYS timed out. The
            // per-request nonce (&_ts -> sig) already guarantees this record came
            // from THIS fresh render, so echoing &_cv restores the match without
            // weakening freshness (a stale frame still can't satisfy the nonce).
            var _dlReqCv = urlParams.get('_cv');
            var _dlRenderedCv = (_dlReqCv != null) ? _dlReqCv : ((dlWidget.contentVersion != null) ? dlWidget.contentVersion : 0);
            // Per-request nonce passed by take_screenshot (060) as &_ts=. Echoed back in
            // the render-complete record so the capturer accepts ONLY the signal from
            // this exact request — a leftover record from a prior capture can't satisfy it.
            var _dlReqTs = urlParams.get('_ts') || '';
            var _dlSignaled = false;
            function _dlOnWidgetMsg(ev) {
                if (ev.source !== wf.contentWindow) return;
                if (!ev.data || ev.data.type !== 'widgetContentLoaded') return;
                if (_dlSignaled) return;
                _dlSignaled = true;
                window.removeEventListener('message', _dlOnWidgetMsg);
                // rAF-OR-setTimeout fallback: this writer runs in the HIDDEN screenshot
                // temp tab (chrome.tabs.create active:false) where rAF is throttled/paused,
                // so a bare requestAnimationFrame chain never fires and the chrome.storage
                // render record never gets written -> the capturer always hit the 8s
                // safety-net timeout. _nextFrame fires on whichever of rAF or a 50ms timer
                // comes first, so the write happens even in a hidden tab; rAF still wins in
                // a visible tab (foreground timing unchanged).
                var _nextFrame = function(cb){ var done=false; var fire=function(){ if(done) return; done=true; try{ cb(); }catch(e){} }; try{ requestAnimationFrame(fire); }catch(e){} setTimeout(fire, 50); };
                // One more frame so the parent frame reflects the child's final layout.
                _nextFrame(function() { _nextFrame(function() {
                    try { document.documentElement.setAttribute('data-widget-ready', String(_dlRenderedCv)); } catch (e) {}
                    var _dlRenderMsg = { type: 'widgetRenderComplete', widgetId: deepLinkWidgetId, contentVersion: _dlRenderedCv, sig: _dlReqTs, ts: Date.now() };
                    // PRIMARY: chrome.storage bus. This temp TAB and the capturing
                    // side-panel page are separate top-level extension contexts. A Chrome
                    // side panel does NOT receive this tab's BroadcastChannel (separate
                    // partitions) and — empirically (PR #274) — also did not receive its
                    // chrome.runtime.sendMessage fan-out, so both old handshakes timed out
                    // on EVERY capture. chrome.storage change events ARE delivered to every
                    // extension context that can read the area, the side panel included, so
                    // writing the record here reliably reaches 060's storage.onChanged
                    // listener. The value also persists, so there is no arm-before-fire race.
                    try { chrome.storage.local.set({ '__appagent_widget_render__': _dlRenderMsg }); } catch (e) {}
                    // Secondary: chrome.runtime fan-out (works in some Chrome builds).
                    // Fire-and-forget (no response callback -> no spurious lastError).
                    try { chrome.runtime.sendMessage(_dlRenderMsg); } catch (e) {}
                    // Tertiary: BroadcastChannel for any same-partition listener.
                    try {
                        var ch = new BroadcastChannel('appagent-widget-render');
                        ch.postMessage(_dlRenderMsg);
                        ch.close();
                    } catch (e) {}
                }); });
            }
            // Live-DOM snapshot path (set by take_screenshot 060 via &snap=1): render a
            // STATIC snapshot of the widget's CURRENT live DOM instead of re-running
            // dlWidget.html from scratch. The widget's scripts are neutralized so the
            // captured frame preserves interactive state (counters, loaded data) without
            // re-executing and resetting it. Falls back to a fresh render if no snapshot.
            var _dlHtml = dlWidget.html;
            if (urlParams.get('snap') === '1') {
                try {
                    var _dlSnap = await new Promise(function(res){
                        try { chrome.storage.local.get('__appagent_widget_snapshot__', function(o){ res(o && o['__appagent_widget_snapshot__']); }); }
                        catch (e) { res(null); }
                    });
                    if (_dlSnap && _dlSnap.widgetId === deepLinkWidgetId && _dlSnap.html) {
                        // Neutralize ALL <script> tags (set a non-executable type) so the
                        // snapshot is purely visual and no script re-runs to reset state.
                        _dlHtml = String(_dlSnap.html).replace(/<script\b/gi, '<script type="application/x-neutered" data-neutered="1" ');
                        // Size the iframe + body to the snapshot's content height so the
                        // temp tab lays out at widget size (060 also crops the raster).
                        if (_dlSnap.height) {
                            wf.style.height = _dlSnap.height + 'px';
                            try { document.body.style.height = _dlSnap.height + 'px'; } catch (e) {}
                        }
                    }
                } catch (e) { /* fall back to fresh render of dlWidget.html */ }
            }
            window.addEventListener('message', _dlOnWidgetMsg);
            writeWidgetHtml(wf, _dlHtml);
            return;
        }
    }

    // Mark initial load complete - subsequent pushHistoryState calls will use pushState instead of replaceState
    isInitialLoad = false;

    // The jobs badge is always-on (launcher for the Active/Recent/Done chats
    // popup). Paint it now so it shows even when we boot straight to a non-chat
    // view (Home/Dashboard), where selectChat — which normally renders it —
    // never runs.
    if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }

    // Initialize Claude OAuth button
    initClaudeOAuth();

    // Fetch credits last (external API call shouldn't block UI initialization)
    fetchCredits();
    // For Claude OAuth, also kick a live usage refresh (no message needed) and keep it
    // fresh whenever the panel regains focus (throttled inside the fn).
    refreshClaudeOAuthUsage();
    if (typeof document !== 'undefined' && !window._claudeUsageVisibilityWired) {
        window._claudeUsageVisibilityWired = true;
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible') refreshClaudeOAuthUsage();
        });
    }
}

function toggleSkillsView() {
    // If already open, do nothing (behave like clicking on a chat)
    if (currentView === 'skills') return;
    openSkillsView();
}

function openSkillsView() {
    currentView = 'skills';
    appStorage.setItem('currentView', 'skills');
    // SWM2-F3: left the chat view — clear this panel's focus entry so the SW
    // sub-agent GC doesn't keep the previously-viewed chat pinned (port-keyed).
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(null);
    appStorage.removeItem('currentEditingSkill');
    currentEditingSkill = null;
    hideAllPanels();
    var skillsPanel = document.getElementById('skills-panel');
    var listPanel = document.getElementById('skills-list-panel');
    var editorPanel = document.getElementById('skill-editor-panel');
    // Reset inner panels to show list, hide editor
    if (listPanel) listPanel.style.display = 'flex';
    if (editorPanel) editorPanel.style.display = 'none';
    if (skillsPanel) { skillsPanel.style.display = 'flex'; renderSkillsList(); }
    updateAllButtonStates();
    renderChatList(); // Update sidebar to deselect chat
    // Push browser history state
    pushHistoryState('skills', null);
}

function closeSkillsView() {
    currentView = 'chat';
    appStorage.setItem('currentView', 'chat');
    currentEditingSkill = null;
    var skillsPanel = document.getElementById('skills-panel');
    showChatView();
    if (skillsPanel) skillsPanel.style.display = 'none';
    updateSkillsButtonState();
    updateDashboardButtonState();
    // Re-render messages if returning to a streaming chat to sync UI state
    if (activeStreamingChatId && currentChatId === activeStreamingChatId) {
        renderMessages();
    }
}

function updateSkillsButtonState() {
    var skillsPanel = document.getElementById('skills-panel');
    var btn = document.getElementById('skills-btn');
    var isOpen = skillsPanel && skillsPanel.style.display === 'flex';
    if (btn) btn.classList.toggle('active', isOpen);
}

async function renderSkillsList() {
    var container = document.getElementById('skills-list');
    if (!container) return;
    var skillList = Object.values(skills);
    if (skillList.length === 0) {
        container.innerHTML = '<div class="skills-empty"><span class="skills-empty-icon">' + UI_ICONS.skill + '</span><p>No skills yet</p><p class="skills-empty-hint">Create skills to give your AI agent specialized knowledge.</p></div>';
        return;
    }
    var html = '';
    skillList.sort(function(a, b) { return (a.name || a.id || '').localeCompare(b.name || b.id || ''); });
    
    // Fetch assets for all skills
    var skillAssets = {};
    for (var i = 0; i < skillList.length; i++) {
        skillAssets[skillList[i].id] = await getSkillAssets(skillList[i].id);
    }
    
    skillList.forEach(function(skill) {
        var isActive = !!activeSkills[skill.id];
        var activeClass = isActive ? ' skill-item-active' : '';
        // OOB (out-of-box) skills are seeded from the bundled EMBEDDED_SKILLS and
        // carry an embeddedHash. Once the user (or agent) edits one, userModified
        // is set and its content no longer matches the shipped version.
        var isOob = !!skill.embeddedHash;
        var isEdited = isOob && !!skill.userModified;
        var oobBadge = isOob ? '<span class="skill-oob-badge" title="Bundled with the extension (out-of-box)">Built-in</span>' : '';
        var editedBadge = isEdited ? '<span class="skill-edited-badge" title="Modified — no longer matches the built-in version">Edited</span>' : '';
        var activeBadge = isActive ? '<span class="skill-active-badge">Active</span>' : '';
        var badgesInner = oobBadge + editedBadge + activeBadge;
        var badgesHtml = badgesInner ? '<span class="skill-item-badges">' + badgesInner + '</span>' : '';
        var displayName = skill.name || skill.id || 'Untitled';
        var descSnippet = skill.description ? '<div class="skill-item-desc">' + escapeHtml(skill.description) + '</div>' : '';
        
        // Show attachments
        var assets = skillAssets[skill.id] || [];
        var attachmentsHtml = '';
        if (assets.length > 0) {
            attachmentsHtml = '<div class="skill-item-attachments">';
            assets.forEach(function(asset) {
                var icon = asset.type === 'xml' ? UI_ICONS.file : (asset.type === 'js' ? UI_ICONS.code : UI_ICONS.skill);
                var typeClass = asset.type === 'js' ? 'js' : asset.type;
                attachmentsHtml += '<span class="skill-attachment-badge ' + typeClass + '" title="' + escapeHtml(asset.filename) + '">' + icon + escapeHtml(asset.filename) + '</span>';
            });
            attachmentsHtml += '</div>';
        }
        
        html += '<div class="skill-item' + activeClass + '" onclick="openSkillEditor(\'' + escapeJsString(skill.id) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \')openSkillEditor(\'' + escapeJsString(skill.id) + '\')" role="button" tabindex="0" aria-label="Edit skill: ' + escapeHtml(displayName) + '"><div class="skill-item-header"><span class="skill-item-icon" aria-hidden="true">' + UI_ICONS.skill + '</span><span class="skill-item-title">' + escapeHtml(displayName) + '</span>' + badgesHtml + '</div>' + descSnippet + attachmentsHtml + '</div>';
    });
    container.innerHTML = html;
}

async function openSkillEditor(skillId) {
    var skill = skillId ? skills[skillId] : null;
    currentEditingSkill = skill ? skill.id : null;
    // Persist skill editor state for page reload
    if (skill) {
        appStorage.setItem('currentEditingSkill', skill.id);
        appStorage.setItem('currentView', 'skill-editor');
    }
    var editorPanel = document.getElementById('skill-editor-panel');
    var listPanel = document.getElementById('skills-list-panel');
    if (listPanel) listPanel.style.display = 'none';
    if (editorPanel) editorPanel.style.display = 'flex';
    var nameInput = document.getElementById('skill-name-input');
    var descInput = document.getElementById('skill-description-input');
    var bodyInput = document.getElementById('skill-body-input');
    var editorTitle = document.getElementById('skill-editor-title');
    var deleteBtn = document.getElementById('skill-delete-btn');
    var activateBtn = document.getElementById('skill-activate-btn');
    var downloadBtn = document.getElementById('skill-download-btn');
    var assetsContainer = document.getElementById('skill-assets-container');
    
    var bodyView = document.getElementById('skill-body-view');
    var bodyEditBtn = document.getElementById('skill-body-edit-btn');
    skillBodyEditMode = false;
    
    var editAiBtn = document.getElementById('skill-edit-ai-btn');
    
    if (skill) {
        if (editorTitle) editorTitle.textContent = 'Edit Skill';
        if (nameInput) nameInput.value = skill.name || skill.id || '';
        if (descInput) descInput.value = skill.description || '';
        if (bodyInput) bodyInput.value = skill.body || '';
        if (deleteBtn) deleteBtn.style.display = 'inline-flex';
        if (activateBtn) activateBtn.style.display = 'inline-flex';
        if (downloadBtn) downloadBtn.style.display = 'inline-flex';
        if (editAiBtn) editAiBtn.style.display = 'inline-flex';
        if (assetsContainer) assetsContainer.style.display = 'flex';
        updateActivateButton();
        await renderSkillAssets();
    } else {
        if (editorTitle) editorTitle.textContent = 'New Skill';
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        if (bodyInput) bodyInput.value = '';
        if (deleteBtn) deleteBtn.style.display = 'none';
        if (activateBtn) activateBtn.style.display = 'none';
        if (downloadBtn) downloadBtn.style.display = 'none';
        if (editAiBtn) editAiBtn.style.display = 'none';
        if (assetsContainer) assetsContainer.style.display = 'none';
    }
    renderSkillBodyView();
    renderSkillActionsEditor();
    if (nameInput) nameInput.focus();
    
    // Push browser history state for skill editor
    if (skill) {
        pushHistoryState('skill-editor', null, skill.id);
    }
}

var skillBodyEditMode = false;

function renderSkillBodyView() {
    var bodyView = document.getElementById('skill-body-view');
    var bodyInput = document.getElementById('skill-body-input');
    var bodyEditBtn = document.getElementById('skill-body-edit-btn');
    if (!bodyView || !bodyInput || !bodyEditBtn) return;
    
    var content = bodyInput.value || '';
    
    if (skillBodyEditMode) {
        bodyView.style.display = 'none';
        bodyInput.style.display = 'block';
        bodyEditBtn.innerHTML = UI_ICONS.eye;
        bodyEditBtn.title = 'View';
    } else {
        bodyInput.style.display = 'none';
        bodyView.style.display = 'block';
        bodyEditBtn.innerHTML = UI_ICONS.edit;
        bodyEditBtn.title = 'Edit';
        
        if (content.trim()) {
            bodyView.innerHTML = '<div class="markdown-body">' + formatContent(content) + '</div>';
        } else {
            bodyView.innerHTML = '<div class="skill-body-empty">No content yet. Click Edit to add instructions.</div>';
        }
    }
}

function toggleSkillBodyEdit() {
    var bodyInput = document.getElementById('skill-body-input');
    var bodyView = document.getElementById('skill-body-view');
    
    // If switching from edit to view, sync the content
    if (skillBodyEditMode && bodyInput) {
        // Content is already in bodyInput, just re-render
    }
    
    skillBodyEditMode = !skillBodyEditMode;
    renderSkillBodyView();
    
    if (skillBodyEditMode && bodyInput) {
        bodyInput.focus();
    }
}

function updateActivateButton() {
    var btn = document.getElementById('skill-activate-btn');
    if (!btn || !currentEditingSkill) return;
    var isActive = !!activeSkills[currentEditingSkill];
    btn.innerHTML = isActive ? '<span class="action-icon">' + UI_ICONS.close + '</span>Deactivate' : '<span class="action-icon">' + UI_ICONS.play + '</span>Activate';
    btn.className = isActive ? 'skills-action-btn' : 'skills-action-btn success';
}

async function toggleSkillActivation() {
    if (!currentEditingSkill) return;
    var btn = document.getElementById('skill-activate-btn');
    var isActive = !!activeSkills[currentEditingSkill];
    
    // Show spinner inside button
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="action-icon">' + UI_ICONS.spinner + '</span>' + (isActive ? 'Deactivating...' : 'Activating...');
    }
    
    try {
        var result = isActive ? await deactivateSkill(currentEditingSkill) : await activateSkill(currentEditingSkill);
        showSnackbar(result.message || (result.success ? 'Done' : result.error), result.success ? 'success' : 'error');
    } catch (e) {
        console.error('Skill activation error:', e);
        showSnackbar('Error: ' + e.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
        updateActivateButton();
        if (typeof renderAllActionPlacements === 'function') renderAllActionPlacements();
    }
}

function showOverlaySpinner(text) {
    hideOverlaySpinner();
    var overlay = document.createElement('div');
    overlay.id = 'overlay-spinner';
    overlay.className = 'overlay-spinner';
    overlay.innerHTML = '<div class="overlay-spinner-content"><div class="spinner"></div><span>' + escapeHtml(text || 'Loading...') + '</span></div>';
    document.body.appendChild(overlay);
}

function hideOverlaySpinner() {
    var spinner = document.getElementById('overlay-spinner');
    if (spinner) spinner.remove();
}

async function renderSkillAssets() {
    var container = document.getElementById('skill-assets-list');
    if (!container || !currentEditingSkill) return;
    var assets = await getSkillAssets(currentEditingSkill);
    var skill = skills[currentEditingSkill];
    
    var html = '';
    
    // Always show SKILL.md first (virtual file from skill content)
    if (skill) {
        var skillMdContent = skillToMarkdown(skill);
        var dropdownId = 'artifact-dropdown-skillmd';
        html += '<div class="sn-artifact-card sidebar-card skill-artifact" onclick="viewSkillMd()" onkeydown="if(event.key===\'Enter\'||event.key===\' \')viewSkillMd()" role="button" tabindex="0" aria-label="View skill definition">';
        html += '<div class="sn-artifact-icon sn-icon-md">' + UI_ICONS.skill + '</div>';
        html += '<div class="sn-artifact-content">';
        html += '<div class="sn-artifact-name">SKILL.md</div>';
        html += '<div class="sn-artifact-meta">Skill Definition</div>';
        html += '</div>';
        html += '<div class="sn-artifact-actions">';
        html += '<button class="sn-artifact-menu" onclick="event.stopPropagation(); toggleDropdown(\'' + dropdownId + '\')" aria-label="More options" aria-haspopup="true">···</button>';
        html += '<div class="sn-dropdown" id="' + dropdownId + '">';
        html += '<button class="sn-dropdown-item" onclick="event.stopPropagation(); closeDropdowns(); viewSkillMd()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View</button>';
        html += '<button class="sn-dropdown-item" onclick="event.stopPropagation(); closeDropdowns(); downloadSkillMd()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download</button>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
    }
    
    // Show attached assets
    assets.forEach(function(asset, idx) {
        var icon = asset.type === 'xml' ? UI_ICONS.file : (asset.type === 'js' ? UI_ICONS.code : UI_ICONS.skill);
        var iconClass = asset.type === 'xml' ? 'xml' : (asset.type === 'js' ? 'js' : 'md');
        var typeLabel = asset.type === 'js' ? 'JS Tool' : asset.type.toUpperCase();
        var dropdownId = 'artifact-dropdown-' + idx;
        // Escape for JS-string-in-onclick context (handles \ ' " < > & — a
        // user-renamable filename containing " must not break out of the attribute)
        var jsFilename = escapeJsString(asset.filename);
        
        html += '<div class="sn-artifact-card sidebar-card skill-artifact" onclick="viewSkillAsset(\'' + jsFilename + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \')viewSkillAsset(\'' + jsFilename + '\')" role="button" tabindex="0" aria-label="View asset: ' + escapeHtml(asset.filename) + '">';
        html += '<div class="sn-artifact-icon sn-icon-' + iconClass + '">' + icon + '</div>';
        html += '<div class="sn-artifact-content">';
        html += '<div class="sn-artifact-name">' + escapeHtml(asset.filename) + '</div>';
        html += '<div class="sn-artifact-meta">' + typeLabel + '</div>';
        html += '</div>';
        html += '<div class="sn-artifact-actions">';
        html += '<button class="sn-artifact-menu" onclick="event.stopPropagation(); toggleDropdown(\'' + dropdownId + '\')" aria-label="More options" aria-haspopup="true">···</button>';
        html += '<div class="sn-dropdown" id="' + dropdownId + '">';
        html += '<button class="sn-dropdown-item" onclick="event.stopPropagation(); closeDropdowns(); viewSkillAsset(\'' + jsFilename + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View</button>';
        html += '<button class="sn-dropdown-item" onclick="event.stopPropagation(); closeDropdowns(); renameSkillAsset(\'' + jsFilename + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>Rename</button>';
        html += '<button class="sn-dropdown-item" onclick="event.stopPropagation(); closeDropdowns(); downloadSkillAsset(\'' + jsFilename + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download</button>';
        html += '<div class="sn-dropdown-divider"></div>';
        html += '<button class="sn-dropdown-item danger" onclick="event.stopPropagation(); closeDropdowns(); removeSkillAsset(\'' + jsFilename + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>Remove</button>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
    });
    
    if (!html) {
        html = '<div class="skill-artifacts-empty">No artifacts yet</div>';
    }
    
    // Add description text under the artifacts list
    html += '<div class="skill-artifacts-help">';
    html += '<p>Artifacts you can add:</p>';
    html += '<ul>';
    html += '<li><strong>XML files (.xml)</strong> – Deployed when skill is activated</li>';
    html += '<li><strong>JS files (.js)</strong> – Custom tools the agent can use</li>';
    html += '<li><strong>Markdown files (.md)</strong> – Context for the AI</li>';
    html += '</ul>';
    html += '<a href="#" onclick="event.preventDefault(); addSampleTool()">Add a sample tool</a>';
    html += '</div>';
    
    container.innerHTML = html;
}
