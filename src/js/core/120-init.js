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
    // Provider-scoped restore (core/020-bootstrap.js helper) — never paint
    // another provider's cached usage.
    var cachedCreditsVal = getBootCachedCredits();
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

    // Initialize settings panel icons (gear dropdown now only has the Display
    // section — Model/Permissions/Data Management moved to the full settings page)
    var sectionIconDisplay = document.getElementById('section-icon-display');
    var sectionIconCache = document.getElementById('section-icon-cache');
    if (sectionIconDisplay) sectionIconDisplay.innerHTML = UI_ICONS.display;
    if (sectionIconCache) sectionIconCache.innerHTML = UI_ICONS.cache;

    // Gear-panel footer links: leading glyph per item + trailing external-link
    // glyph signalling the click navigates to the full settings page.
    var gearLinkIcons = {
        'settings-link-icon-github': 'git',
        'settings-link-icon-permissions': 'shield',
        'settings-link-icon-sysprompt': 'code',
        'settings-link-icon-all': 'settings'
    };
    Object.keys(gearLinkIcons).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.innerHTML = UI_ICONS[gearLinkIcons[id]];
    });
    document.querySelectorAll('#settings-panel .settings-link-external').forEach(function(el) {
        el.innerHTML = UI_ICONS.externalLink;
    });

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

    // Global Escape handler — closes the topmost open dismissable surface.
    //
    // CLASS-FIRST, not an id list. The previous version only knew the permanent
    // #modal-overlay, so every dynamically-created twin that reuses the SAME
    // class with a different id (#github-setup-modal, #llm-endpoint-modal,
    // #api-provider-modal, …) was unclosable by Escape, as were the jobs
    // dropdown, the gear settings panel and the action popovers. That is the
    // same lesson the Alt+ArrowLeft guard below already learned: an id list
    // silently misses every surface added later.
    //
    // Precedence = innermost / most-recently-opened first, following the
    // z-index ladder in css/00-tokens.css:
    //   --z-modal (10006)        .modal-overlay.show — permanent + dynamic twins
    //   --z-widget-modal          widget overlays, .action-result-popover
    //   --z-overlay (10000)       #diff-viewer-overlay (css/16-diff.css:2)
    //   --z-jobs-dropdown (9000)  .header-menu pills (jobs, gear, model, ws, usage)
    //
    // Surfaces that register their OWN document-level Escape handler are
    // deliberately NOT handled here (double-close / leaked listeners):
    //   #tool-inspector-modal  ui/040-tools-settings.js:62-68 — skipped explicitly below
    //   #jobs-expand-overlay   tools/120-actions.js:3468-3470 — capture phase +
    //                          stopPropagation, so the key never reaches us
    //   .sdoc-preview-overlay  tools/110-smart-documents.js:846
    //   .wsf-overlay           ui/115-workspace-files-sidebar.js:305
    //   usage tooltip          ui/170-chat-management.js:366-370
    //
    // Nothing open ⇒ every branch falls through ⇒ harmless no-op. Nothing here
    // calls preventDefault/stopPropagation, so Escape keeps whatever meaning it
    // has in a focused input/textarea/iframe and the other handlers above still
    // see the key — the handler never swallows it.
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        // 1. The generic modal (--z-modal 10006) stacks ABOVE the widget
        // overlays — confirm dialogs spawn from the widget fullscreen / editor
        // (e.g. Delete Widget) — so it closes first.
        var modal = document.getElementById('modal-overlay');
        if (modal && modal.classList.contains('show')) { closeModal(); return; }
        // 2. Widget overlays, each with a dedicated close fn. Checked BEFORE the
        // generic .modal-overlay.show sweep so #widget-history-modal-overlay
        // (ui/070-dashboard-ui.js:1376-1381 — it also carries that class) is
        // closed by closeWidgetHistory() rather than by the generic path.
        if (document.getElementById('widget-fullscreen-overlay')) { closeWidgetFullscreen(); return; }
        if (document.getElementById('widget-edit-overlay')) { closeWidgetCodeEdit(); return; }
        if (document.getElementById('widget-modal-overlay')) { closeWidgetModal(); return; }
        if (document.getElementById('widget-history-modal-overlay')) { closeWidgetHistory(); return; }
        // 3. Every OTHER .modal-overlay.show — the dynamic twins built by
        // showGitHubSetupModal (tools/130-github-setup.js:53-56),
        // showApiProviderModal (:1756-1759) and anything added later. They are
        // appended to <body> in open order, so the LAST match is the most
        // recently opened one. Every twin assigns
        //     overlay.onclick = function(e) { if (e.target === overlay) closeXxx(); }
        // so replaying that backdrop click runs the modal's OWN close fn — no
        // id→function table to keep in sync. .remove() is the belt-and-braces
        // fallback for a future twin that ships without an onclick.
        var overlays = document.querySelectorAll('.modal-overlay.show');
        for (var i = overlays.length - 1; i >= 0; i--) {
            var ov = overlays[i];
            if (ov.id === 'modal-overlay') continue;         // handled in 1.
            // #tool-inspector-modal wires its own Escape listener at open time and
            // removes it in closeToolInspectorModal(); closing it from here would
            // both double-close and leak that listener.
            if (ov.id === 'tool-inspector-modal') return;
            if (typeof ov.onclick === 'function') {
                try {
                    ov.onclick({ target: ov, currentTarget: ov,
                        preventDefault: function() {}, stopPropagation: function() {} });
                } catch (err) {}
            }
            if (ov.isConnected) ov.remove();
            return;
        }
        // 4. Action popovers — running/result/permission popovers anchored to the
        // jobs pills (tools/120-actions.js openRunningPopover:1609 /
        // openResultPopover:1665). They only ever registered a click-outside
        // handler (_resultPopoverOutside), never a key handler. Closed BEFORE the
        // jobs dropdown because a popover is opened FROM a dropdown row and
        // deliberately leaves that dropdown open (tools/120-actions.js:1667).
        if (document.querySelector('.action-result-popover')) { closeResultPopover(); return; }
        // 5. Diff viewer (#diff-viewer-overlay, ui/100-diff-viewer.js:58-59) —
        // a full-screen backdrop at --z-overlay (10000, css/16-diff.css:2) that
        // shipped with NO key handler of its own, so Escape never closed it. It
        // does not carry .modal-overlay, so step 3's class-first sweep misses it
        // and it needs its own branch. Sits BELOW --z-modal (10006, steps 1+3)
        // and --z-widget-modal (10002, steps 2+4) and ABOVE the dropdowns/header
        // pills, so this is its z-order slot in the ladder.
        if (document.getElementById('diff-viewer-overlay')) { closeDiffViewer(); return; }
        // 6. sn-dropdown menus (skills import/export/download) sit below every
        // overlay — close them only when nothing above claimed the key.
        if (document.querySelector('.sn-dropdown.open')) { closeDropdowns(); return; }
        // 7. Header pill menus — gear settings panel, jobs dropdown, model menu,
        // workspace dropdown, usage + instance pickers. They all share the
        // .header-menu chrome class (css/04-header.css:86) and are mutually
        // exclusive, so one class-first visibility probe plus the shared registry
        // closes whichever is open: closeAllHeaderMenus (ui/240-layout.js:115)
        // fans out to closeSettingsPanel / closeJobsDropdown / _closeModelMenu /
        // hideWorkspaceDropdown / hideUsageTooltipNow / hideInstancePicker, each
        // behind a typeof guard. Visibility is probed with getComputedStyle().display
        // rather than offsetParent (null for these position:fixed panels even when
        // they ARE visible) or getClientRects() (layout-dependent); every one of these
        // menus is toggled by display — inline style (.jobs-dropdown, model menu) or a
        // stylesheet class (.settings-panel.visible, css/09-settings.css:8-9) — and
        // getComputedStyle resolves both. At most six elements carry .header-menu.
        var menus = document.querySelectorAll('.header-menu');
        for (var j = menus.length - 1; j >= 0; j--) {
            if (window.getComputedStyle(menus[j]).display !== 'none') {
                if (typeof closeAllHeaderMenus === 'function') closeAllHeaderMenus();
                return;
            }
        }
    });

    // NAV-H7: global Alt+ArrowLeft = app Back (browser history). Registered right next
    // to the global Escape handler above so both app-level shortcuts live together and
    // share the same "is an overlay open?" checks. preventDefault is required: in a tab
    // Alt+Left is ALSO the browser's own Back, and without it the entry would be popped
    // twice; in side-panel mode the browser shortcut doesn't fire at all, so this is the
    // only Back key. history.back() replays through handlePopState (core/040-hooks-history.js).
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'ArrowLeft' || !e.altKey) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey) return; // don't shadow other combos
        // Never steal the keystroke from a text field — Alt+Left is a word-wise caret
        // move on some platforms. Same e.target tag guard the workspace-files overlay
        // arrow-nav uses (ui/115-workspace-files-sidebar.js:308-309), plus contenteditable
        // and a focused <iframe> (widget previews / the controlled panel), whose own
        // document must keep the key.
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
            t.tagName === 'IFRAME' || t.isContentEditable)) return;
        // Never navigate out from under an open overlay/modal (Escape closes them; Back
        // must not slide out underneath them). ONE class-first selector rather than an id
        // list — an id list silently misses every modal added later, and it already missed
        // six. Every selector below is 'present ⇒ open': each overlay is .remove()d on
        // close, and the one permanently-mounted overlay (#modal-overlay, html/body.html:388)
        // is gated on .show, exactly as the Escape handler above gates it.
        //   .modal-overlay.show     — #modal-overlay (showModal/showPromptModal + the
        //     screenshot viewer, ui/290-screenshot-ui.js:41,53) AND every dynamic twin that
        //     reuses the class: #tool-inspector-modal (ui/040-tools-settings.js:27-28),
        //     #llm-endpoint-modal (:1580-1581), #api-provider-modal (:1743-1744),
        //     #github-setup-modal (tools/130-github-setup.js:54-55),
        //     #widget-history-modal-overlay (ui/070-dashboard-ui.js:1193-1194).
        //   .sdoc-preview-overlay   — #sdoc-preview-modal (tools/110-smart-documents.js:811-812)
        //   .widget-fullscreen-overlay (tools/080-widget-tools.js:388, ui/070-dashboard-ui.js:85)
        //   .widget-modal-overlay   — #widget-edit-overlay + #widget-modal-overlay
        //     (tools/080-widget-tools.js:515-516, 598-599)
        //   .wsf-overlay            — ui/115-workspace-files-sidebar.js:293; owns ArrowLeft itself
        //   #diff-viewer-overlay    — ui/100-diff-viewer.js:58-59 (removed in closeDiffViewer:355)
        //   #jobs-expand-overlay    — tools/120-actions.js:3323-3324
        // The four widget ids are kept explicitly so the guard still holds if one of those
        // overlays is ever created without its class.
        if (document.querySelector(
            '.modal-overlay.show, .sdoc-preview-overlay, .widget-fullscreen-overlay, ' +
            '.widget-modal-overlay, .wsf-overlay, #diff-viewer-overlay, #jobs-expand-overlay, ' +
            '#widget-fullscreen-overlay, #widget-edit-overlay, #widget-modal-overlay, ' +
            '#widget-history-modal-overlay')) return;
        e.preventDefault();
        history.back();
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
        else if (text.indexOf('Standalone') !== -1) el.innerHTML = UI_ICONS.externalLink;
        else if (text.indexOf('More') !== -1) el.innerHTML = UI_ICONS.moreHorizontal;
    });
    // Initialize dropdown menu icons
    var moreStandaloneIcon = document.getElementById('more-standalone-icon');
    var moreImportIcon = document.getElementById('more-import-icon');
    var moreExportIcon = document.getElementById('more-export-icon');
    if (moreStandaloneIcon) moreStandaloneIcon.innerHTML = UI_ICONS.externalLink;
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
    // permission (lifts the per-origin quota AND exempts the extension origin
    // from quota eviction). Best-effort — failures are non-fatal and logged
    // only. NOTE: Chrome does not flip the Storage-API persist bit for
    // chrome-extension:// origins — the site-engagement/notification
    // heuristics it uses for web origins don't apply — so persist() normally
    // resolves `false` in the extension even though the data is ALREADY
    // eviction-exempt via `unlimitedStorage`. That result is expected and
    // harmless: log it as info there, and keep the real warning for
    // non-extension origins where eviction is a genuine risk.
    try {
        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().then(function(granted) {
                if (granted) return;
                var isExtensionOrigin = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
                if (isExtensionOrigin) {
                    console.info('[init] storage.persist() not granted — expected for chrome-extension:// origins; data remains eviction-exempt via the manifest unlimitedStorage permission');
                } else {
                    console.warn('[init] storage.persist() not granted — origin data remains best-effort evictable');
                }
            }).catch(function() {});
        }
    } catch (e) {}
    // BOOT-DEADLINE (SLEEP-WEDGE): after a multi-day suspend Chrome's IDB
    // backend can wedge silently. The open watchdog + transaction deadline in
    // core/130-indexeddb.js bound every layer, but hydration must NEVER wedge
    // init — the composer is already visible (above) while the header pill,
    // home content, chat list and action buttons all render below this await.
    // Race hydration against a deadline: on timeout, surface the storage
    // notice and continue init degraded (the wipe-guard _chatsHydrated stays
    // false, so saves remain blocked and nothing is lost). If hydration
    // completes late, merge back any chats created meanwhile (e.g. the temp
    // New Chat the user may be typing in — the loader reassigns the `chats`
    // map) and repaint the chat-dependent UI.
    // Kept short so degraded mode paints the chrome.storage.local mirror fast
    // (no long dead-air on a wedged store). loadChatsFromStorage reads the chats
    // store in short-deadline batches, so a healthy load finishes well under this;
    // a wedged one degrades here at ~10s and recovers in the background when the
    // batched read's reopen-retry (~12s) finally succeeds (exitStorageDegradedMode
    // via the _bootHydration.then below — the hydration promise is NOT cancelled).
    var BOOT_HYDRATION_DEADLINE_MS = 10000;
    var _bootHydrationSettled = false;
    var _bootHydrationTimedOut = false;
    var _bootPreHydrationChats = null;
    var _bootHydration = loadChatsFromStorage().then(function() {
        _bootHydrationSettled = true;
        if (!_bootHydrationTimedOut) return;
        console.warn('[init] chat hydration completed after the boot deadline — merging late chats and repainting');
        if (_bootPreHydrationChats) {
            try {
                Object.keys(_bootPreHydrationChats).forEach(function(id) {
                    if (!chats[id]) chats[id] = _bootPreHydrationChats[id];
                });
            } catch (e) {}
        }
        // GRACEFUL-DEGRADATION: if we degraded during the boot-deadline window
        // AND hydration has now genuinely succeeded (_chatsHydrated), recover:
        // exitStorageDegradedMode clears the flag and repaints the real
        // list/actions/jobs. If hydration still failed, stay degraded — the
        // retry loop owns the UI — and do NOT repaint (renderChatList would show
        // the mirror anyway).
        if (typeof _storageDegraded !== 'undefined' && _storageDegraded) {
            if (_chatsHydrated && typeof exitStorageDegradedMode === 'function') {
                try { exitStorageDegradedMode(); } catch (e) {}
            }
            return;
        }
        try { renderChatList(); } catch (e) {}
        try { if (typeof renderAllActionPlacements === 'function') renderAllActionPlacements(); } catch (e) {}
        try { if (typeof renderJobsBadge === 'function') renderJobsBadge(); } catch (e) {}
    });
    await Promise.race([
        _bootHydration,
        new Promise(function(resolve) {
            setTimeout(function() {
                if (!_bootHydrationSettled) {
                    _bootHydrationTimedOut = true;
                    // Snapshot the pre-hydration map object: it keeps receiving
                    // chats created while degraded, until the loader reassigns
                    // `chats` — exactly the entries to merge back above.
                    _bootPreHydrationChats = chats;
                    // GRACEFUL-DEGRADATION: don't render a silently-empty list.
                    // Enter degraded mode — show the chrome.storage.local mirror
                    // read-only under a banner and auto-retry opening the DB. If
                    // hydration later completes, the _bootHydration.then above
                    // calls exitStorageDegradedMode to swap in the real data.
                    if (typeof enterStorageDegradedMode === 'function') {
                        try { enterStorageDegradedMode(new Error('chat hydration exceeded ' + BOOT_HYDRATION_DEADLINE_MS + 'ms at boot — storage may be wedged')); } catch (e) {}
                    } else if (typeof showStorageUnavailableNotice === 'function') {
                        try { showStorageUnavailableNotice(new Error('chat hydration exceeded ' + BOOT_HYDRATION_DEADLINE_MS + 'ms at boot')); } catch (e) {}
                    }
                }
                resolve();
            }, BOOT_HYDRATION_DEADLINE_MS);
        })
    ]);
    // After the SW 'hello' has had a chance to repopulate runningChatIds for
    // genuinely-live runs, clear any stale status:'pending' tool-approval rows
    // left by an abandoned/reloaded run (else a permission bell shows forever
    // on a chat with nothing there). One-shot; guarded inside the function.
    try { setTimeout(function() { try { if (typeof reconcileStaleApprovals === 'function') reconcileStaleApprovals(); } catch (e) {} }, 4000); } catch (e) {}
    await loadApiProviders();
    await loadProviderFromStorage();
    await loadToolPermissions();
    await loadCacheTokenLimit();
    await loadAssumedContextTokens();
    await loadCustomSystemPrompt();
    await loadHooksSettings();
    await loadSkillsFromStorage();
    await loadActiveSkills();
    await importEmbeddedSkills();
    // The SW boots before this import and loaded its own skillTools from the
    // pre-import activeSkills setting — push a refresh so brand-new embedded
    // skills' tools are recognised there too (isSkillTool / roster gate).
    if (typeof pushSkillToolsRefreshToOffscreen === 'function') pushSkillToolsRefreshToOffscreen();
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
    updateWorkspaceHeaderStatus(); // show local state immediately
    // NAV-SYNC: guarded trigger (ui/040-tools-settings.js) — dedupes against the
    // nav-driven sync fired by hideAllPanels() during this same startup path.
    triggerNavWorkspaceSync(); // then sync with remote in background

    // Restore pending images and text from IndexedDB
    await restorePendingImagesFromSession();
    await restorePendingTextsFromStorage();

    // Now render UI that depends on IndexedDB data
    renderChatList();
    renderAllActionPlacements(); // render action buttons in home/header/chat/sidebar
    updateModelDisplay();

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
            // GRACEFUL-DEGRADATION: when storage is degraded the chat LIST is
            // owned by the read-only mirror + banner (renderChatList is
            // degraded-aware), so this temp New Chat is only the composer
            // target — it must NOT be painted as a healthy, empty chat list.
            // Skip the list repaint here; the composer (renderMessages) still
            // shows so the user isn't stuck. The retry loop swaps in real data
            // on recovery.
            if (!(typeof _storageDegraded !== 'undefined' && _storageDegraded)) {
                renderChatList();
            }
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
            // restoreChatScrollTop seeds _agLastScrollTop so the coalesced
            // scroll event from this restore isn't misread as a user
            // scroll-up (which would clobber the derived flag below).
            restoreChatScrollTop(messagesContainer, parseInt(savedScrollPos, 10));
            // Derive this chat's follow intent from the restored position
            // (single stick-to-bottom mechanism — see 050-streaming.js).
            stickToBottom = isNearBottom(messagesContainer);
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
            var _dlIsStaticSnap = false;
            if (urlParams.get('snap') === '1') {
                try {
                    var _dlSnap = await new Promise(function(res){
                        try { chrome.storage.local.get('__appagent_widget_snapshot__', function(o){ res(o && o['__appagent_widget_snapshot__']); }); }
                        catch (e) { res(null); }
                    });
                    if (_dlSnap && _dlSnap.widgetId === deepLinkWidgetId && _dlSnap.html) {
                        // Neutralize ALL <script> tags (set a non-executable type) so the
                        // snapshot is purely visual and no script re-runs to reset state.
                        _dlIsStaticSnap = true;
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
            // BRIDGE FIX: every fresh (non-neutered) render EXECUTES the widget's live
            // scripts, and widgets call `await executeTool(name, args)` per the
            // html_widget contract — so the executeTool bridge MUST be prepended here
            // exactly like the other three render paths do (renderWidgetInContainer
            // tools/080-widget-tools.js:305, expandDashboardWidget ui/070-dashboard-
            // ui.js:104, renderWidgetContent ui/070-dashboard-ui.js:906). This
            // deep-link path used to write dlWidget.html RAW, so any tool-calling
            // widget threw 'executeTool is not defined' whenever it rendered here:
            // take_screenshot's fresh-render fallback (060:271, when the live-DOM
            // snapshot times out or mismatches), screenshotWidget's temp-tab fallback
            // (080:519), open-in-new-tab (080:479) and openWidgetInIframePanel
            // (270:212). The static &snap=1 path is deliberately left untouched —
            // its scripts are neutered above, nothing executes there.
            if (!_dlIsStaticSnap) {
                _dlHtml = injectWidgetBridge(_dlHtml, dlWidget.title, deepLinkWidgetId);
                // Make the bridge FUNCTIONAL, not just defined: the global
                // widgetToolCall/widgetDownload listeners (ui/070-dashboard-ui.js:812,
                // 824) only trust messages whose source resolves via
                // _resolveWidgetSource (iframe.widget-iframe elements), and
                // _widgetIdForIframe derives the calling widget id from the closest
                // [data-widget-id] (closest() starts at the element itself). Mark the
                // deep-link iframe accordingly so widget tool calls dispatch through
                // the page executeTool with the correct widget identity instead of
                // being silently dropped (pending-forever promises).
                wf.className = 'widget-iframe';
                wf.setAttribute('data-widget-id', deepLinkWidgetId);
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
    // Initialize ChatGPT (OpenAI) OAuth button
    initChatGPTOAuth();

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

    // SLEEP-WEDGE: on resume from a long suspend, proactively round-trip
    // probe the cached IDB connection (probeDbAfterResume, core/130-
    // indexeddb.js — single-flight + throttled) so a silently-dead
    // connection is dropped and reopened BEFORE the next real read has to
    // eat the full transaction deadline.
    if (typeof document !== 'undefined' && !window._idbResumeProbeWired) {
        window._idbResumeProbeWired = true;
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState !== 'visible') return;
            try { if (typeof probeDbAfterResume === 'function') probeDbAfterResume(); } catch (e) {}
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
    // ui/025-history-nav.js callee — typeof-guarded cross-tier call.
    if (typeof pushHistoryState === 'function') pushHistoryState('skills', null);
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
    // #744: align history with the view switch — leaving history.state on
    // {view:'skills'} made the first Back press a visual no-op (it popped back
    // onto the entry beneath, usually the chat we are already showing). Same
    // pop-the-pushed-entry pattern as closeSkillEditor (ui/010-skills-ui.js:337-342);
    // a boot-restored skills view (no pushed entry / short history) keeps the
    // replace so Back never exits the app.
    var _hs = null;
    try { _hs = history.state; } catch (e) {}
    if (_hs && _hs.view === 'skills' && (typeof history.length !== 'number' || history.length > 1)) {
        try { history.back(); return; } catch (e) {}
    }
    replaceHistoryState('chat', currentChatId, null);
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
    // devOnly skills stay invisible in the list outside extension dev mode
    // (isSkillDevHidden, core/140-skills-engine.js).
    var skillList = Object.values(skills).filter(function(s) {
        return !(typeof isSkillDevHidden === 'function' && isSkillDevHidden(s.id));
    });
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
        // ui/025-history-nav.js callee — typeof-guarded cross-tier call.
        if (typeof pushHistoryState === 'function') pushHistoryState('skill-editor', null, skill.id);
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
