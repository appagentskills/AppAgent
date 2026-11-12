// Drag-to-resize for the LEFT nav sidebar (when expanded) and the split
// widget pane (core/082-split-view.js). One generic handle
// (attachPanelResizeHandle): pointer drag with setPointerCapture (width
// applied once per animation frame), double-click resets to the default
// width, keyboard ArrowLeft/Right (Shift = bigger step) on a focusable
// role="separator". Widths persist in appStorage ('sidebarWidth',
// 'splitPaneWidth') and are re-clamped on window resize.
// Resizing is desktop-only: the handles are hidden (css/15c-panel-resize.css)
// where the sidebar is an overlay (<= 768px / side panel) or the split view
// is stacked (<= 900px / side panel), and the stored width is then ignored.
//
// Sidebar width lives in --sidebar-resize-width ON #sidebar (not :root: the
// :root token --sidebar-width: 60px in css/00-tokens.css is unrelated and used
// to shadow the 260px fallback).
//
// RIGHT chat panel (#version-sidebar) room rule — _rightPanelLacksRoom():
//   chatCol = width of the chat column (#main-area grid column 1: #main-area
//             width - split pane width in side-by-side split, otherwise the
//             .chat-content-wrapper width)
//   room    = chatCol - right panel width   (what is left for the messages)
//   the panel lacks room when  room < RIGHT_PANEL_MIN_ROOM_FRACTION (25%) x #main-area width
// Split-pane drag: the panel stays visible; it is hidden live
// (.resize-suspended) only while the dragged position crosses the threshold,
// shown again when the drag moves back, and closed for real on release only
// if the final position is still past it. Sidebar drag: the panel is hidden
// for the whole drag (unchanged) and on release closed for real only if it
// lacks room by the same rule. In side-by-side split, enforceRightPanelRoom()
// (window resize, saved-width restore) applies the same rule, while
// makeRoomForRightPanel() (called by openVersionSidebar) shrinks the pane
// (never below 25%) when the user opens the panel explicitly.

var SIDEBAR_WIDTH_KEY = 'sidebarWidth';
var SIDEBAR_WIDTH_DEFAULT = 260;   // pre-resize .sidebar.expanded width (css/01-dark-theme.css)
var SIDEBAR_WIDTH_MIN = 180;
var SIDEBAR_WIDTH_MAX = 480;
var SIDEBAR_REST_MIN = 400;        // room kept for the rest of the window
var RIGHT_PANEL_MIN_ROOM_FRACTION = 0.25; // messages next to the right panel >= 25% of #main-area
var SPLIT_PANE_WIDTH_KEY = 'splitPaneWidth';
var SPLIT_PANE_MIN_FRACTION = 0.25; // widget pane >= 25% of #main-area
var SPLIT_PANE_MAX_FRACTION = 0.75; // widget pane <= 75% of #main-area
var PANEL_RESIZE_STEP = 16;
var PANEL_RESIZE_STEP_BIG = 64;

function _panelResizeIsRtl(el) {
    try { return getComputedStyle(el || document.documentElement).direction === 'rtl'; } catch (e) { return false; }
}
function _panelResizeReadPx(key) {
    var v = parseInt(appStorage.getItem(key), 10);
    return isFinite(v) && v > 0 ? v : null;
}
function _panelResizeClamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function _panelResizeRaf(fn) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
    fn(); return 0;
}

// Generic handle. opts: { label (already translated), getWidth(), setWidth(px, commit), reset(),
// growKey: 'ArrowRight' | 'ArrowLeft' (LTR key that widens the panel),
// edgeSide: 'end' (panel left of handle, e.g. sidebar) | 'start' (panel right
// of handle, e.g. split pane), enabled(), onDragStart(), onDragEnd() }.
function attachPanelResizeHandle(handle, opts) {
    if (!handle || handle._panelResizeAttached) return handle;
    handle._panelResizeAttached = true;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-label', opts.label);
    handle.title = typeof t === 'function' ? t('Drag to resize · double-click to reset') : 'Drag to resize · double-click to reset';
    var drag = null;
    function widthAt(clientX) {
        var rtl = _panelResizeIsRtl(handle);
        // The handle sits on the panel edge: the panel grows when the
        // pointer moves away from its body.
        var towardEnd = (opts.edgeSide === 'end') !== rtl;
        var dx = clientX - drag.startX;
        return drag.startW + (towardEnd ? dx : -dx);
    }
    function onMove(e) {
        if (!drag) return;
        e.preventDefault();
        // Coalesce to one write per frame.
        drag.pendingW = widthAt(e.clientX);
        if (drag.raf) return;
        var d = drag;
        d.raf = -1; // pending marker (a synchronous rAF clears it immediately)
        var id = _panelResizeRaf(function() {
            d.raf = 0;
            if (drag !== d || d.pendingW == null) return;
            opts.setWidth(d.pendingW, false);
        });
        if (d.raf) d.raf = id || -1;
    }
    function onUp(e) {
        if (!drag) return;
        var d = drag;
        if (d.raf > 0 && typeof cancelAnimationFrame === 'function') { try { cancelAnimationFrame(d.raf); } catch (err) {} }
        d.raf = 0;
        try { handle.releasePointerCapture(d.pointerId); } catch (err) {}
        var w = (e && typeof e.clientX === 'number') ? widthAt(e.clientX) : (d.pendingW != null ? d.pendingW : d.startW);
        // Commit while .is-dragging is still set (observers skip re-applies).
        opts.setWidth(w, true);
        drag = null;
        handle.classList.remove('is-dragging');
        document.body.classList.remove('panel-resizing');
        if (opts.onDragEnd) { try { opts.onDragEnd(); } catch (err) {} }
        if (typeof resizeAllWidgets === 'function') resizeAllWidgets();
    }
    handle.addEventListener('pointerdown', function(e) {
        if (e.button !== 0 || (opts.enabled && !opts.enabled())) return;
        e.preventDefault();
        drag = { startX: e.clientX, startW: opts.getWidth(), pointerId: e.pointerId, raf: 0, pendingW: null };
        handle.classList.add('is-dragging');
        // Blocks iframe pointer capture, text selection and width
        // transitions while dragging (css/15c-panel-resize.css).
        document.body.classList.add('panel-resizing');
        if (opts.onDragStart) { try { opts.onDragStart(); } catch (err) {} }
        try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    handle.addEventListener('lostpointercapture', function(e) { if (drag) onUp(e); });
    handle.addEventListener('dblclick', function(e) {
        e.preventDefault();
        opts.reset();
        if (typeof resizeAllWidgets === 'function') resizeAllWidgets();
    });
    handle.addEventListener('keydown', function(e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return;
        if (opts.enabled && !opts.enabled()) return;
        e.preventDefault();
        if (e.key === 'Home') { opts.reset(); return; }
        var grow = opts.growKey || 'ArrowRight';
        if (_panelResizeIsRtl(handle)) grow = grow === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
        var step = e.shiftKey ? PANEL_RESIZE_STEP_BIG : PANEL_RESIZE_STEP;
        opts.setWidth(opts.getWidth() + (e.key === grow ? step : -step), true);
        if (typeof resizeAllWidgets === 'function') resizeAllWidgets();
    });
    return handle;
}

// ---- Left sidebar ---------------------------------------------------------

// Width the visible RIGHT chat panel takes (0 when hidden / suspended).
function _versionSidebarReservedWidth() {
    var vs = document.getElementById('version-sidebar');
    if (!vs || !vs.classList.contains('visible') || vs.classList.contains('resize-suspended')) return 0;
    var w = vs.getBoundingClientRect ? vs.getBoundingClientRect().width : 0;
    return w > 0 ? w : 320;
}

function _sidebarResizeBounds() {
    // Keep ~400px for the chat, plus the right panel's real width when shown.
    var rest = SIDEBAR_REST_MIN + _versionSidebarReservedWidth();
    var max = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, (window.innerWidth || 1280) - rest));
    return { min: SIDEBAR_WIDTH_MIN, max: max };
}

// Current expanded width. A collapsed / hidden / mid-transition sidebar
// measures < SIDEBAR_WIDTH_MIN: use the saved (or default) width instead so
// a tiny measured width is never the drag start nor saved.
function _sidebarCurrentWidth(sidebar) {
    var w = sidebar && sidebar.getBoundingClientRect ? sidebar.getBoundingClientRect().width : 0;
    if (w >= SIDEBAR_WIDTH_MIN) return w;
    return _panelResizeReadPx(SIDEBAR_WIDTH_KEY) || SIDEBAR_WIDTH_DEFAULT;
}

function applySidebarWidth(px, commit) {
    var sidebar = document.getElementById('sidebar');
    var handle = document.getElementById('sidebar-resize-handle');
    if (px == null) {
        if (sidebar) sidebar.style.removeProperty('--sidebar-resize-width');
        if (commit) appStorage.removeItem(SIDEBAR_WIDTH_KEY);
        if (handle) handle.setAttribute('aria-valuenow', String(SIDEBAR_WIDTH_DEFAULT));
        return SIDEBAR_WIDTH_DEFAULT;
    }
    var b = _sidebarResizeBounds();
    var w = Math.round(_panelResizeClamp(px, b.min, b.max));
    if (sidebar) sidebar.style.setProperty('--sidebar-resize-width', w + 'px');
    if (commit) appStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
    if (handle) {
        handle.setAttribute('aria-valuemin', String(b.min));
        handle.setAttribute('aria-valuemax', String(b.max));
        handle.setAttribute('aria-valuenow', String(w));
    }
    return w;
}

// Right-panel handling around a sidebar drag (see header comment).
function _sidebarDragSuspendRightPanel() {
    var vs = document.getElementById('version-sidebar');
    if (!vs || !vs.classList.contains('visible') || vs.classList.contains('resize-suspended')) return null;
    var w = vs.getBoundingClientRect ? vs.getBoundingClientRect().width : 0;
    vs.classList.add('resize-suspended');
    return { el: vs, width: w > 0 ? w : 320 };
}
function _sidebarDragRestoreRightPanel(s) {
    if (!s || !s.el) return 'none';
    var vs = s.el;
    var c = _rightPanelChatColumn(vs);
    var tooNarrow = _rightPanelLacksRoom(c.chat, s.width, c.main);
    if (tooNarrow) _rightPanelClose(vs);
    vs.classList.remove('resize-suspended');
    return tooNarrow ? 'closed' : 'restored';
}

// ---- Right panel room rule (see header comment) ---------------------------

function _rightPanelLacksRoom(chatCol, panelW, mainW) {
    if (!(chatCol > 0) || !(mainW > 0)) return false;
    return (chatCol - (panelW || 0)) < mainW * RIGHT_PANEL_MIN_ROOM_FRACTION;
}
function _rightPanelElWidth(el) {
    return el && el.getBoundingClientRect ? (el.getBoundingClientRect().width || 0) : 0;
}
// Chat column + #main-area widths. paneW overrides the measured split pane
// width (the target width mid-drag, before layout catches up).
function _rightPanelChatColumn(vs, paneW) {
    var mw = _rightPanelElWidth(document.getElementById('main-area'));
    if (_rightPanelSplitSideBySide()) {
        if (paneW == null) paneW = _rightPanelElWidth(document.getElementById('split-widget-pane'));
        if (mw > 0 && paneW > 0) return { chat: mw - paneW, main: mw };
    }
    var avail = _rightPanelElWidth(vs && vs.parentNode);
    return { chat: avail, main: mw || avail };
}
function _rightPanelClose(vs) {
    if (typeof closeVersionSidebar === 'function') { try { closeVersionSidebar(); } catch (e) { vs.classList.remove('visible'); } }
    else vs.classList.remove('visible');
}

// Split-pane drag: never hides the panel up front; tracks it live.
function _splitDragRightPanelStart() {
    var vs = document.getElementById('version-sidebar');
    if (!vs || !vs.classList.contains('visible') || vs.classList.contains('resize-suspended')) return null;
    var w = _rightPanelElWidth(vs);
    return { el: vs, width: w > 0 ? w : 320, main: _rightPanelElWidth(document.getElementById('main-area')), hidden: false };
}
function _splitDragRightPanelUpdate(s, paneW) {
    if (!s || !s.el || !(paneW > 0) || !(s.main > 0)) return;
    var lacks = _rightPanelLacksRoom(s.main - paneW, s.width, s.main);
    if (lacks === s.hidden) return;
    s.hidden = lacks;
    if (lacks) s.el.classList.add('resize-suspended');
    else s.el.classList.remove('resize-suspended');
}
function _splitDragRightPanelEnd(s) {
    if (!s || !s.el) return 'none';
    var closed = s.hidden;
    if (closed) _rightPanelClose(s.el);
    s.el.classList.remove('resize-suspended');
    return closed ? 'closed' : 'kept';
}

// ---- Right panel vs split view ------------------------------------------

var _rightPanelRoomKey = null;

// Side-by-side split only: stacked (<= 900px) and side-panel layouts put the
// pane below the chat, so the right panel never competes with it there.
function _rightPanelSplitSideBySide() {
    if (typeof document === 'undefined' || !document.body) return false;
    var b = document.body.classList;
    return b.contains('split-view-active') && !b.contains('sidepanel-mode') && ((typeof window !== 'undefined' && window.innerWidth) || 0) > 900;
}
function _rightPanelRoomKeyNow() {
    var main = document.getElementById('main-area');
    var pane = document.getElementById('split-widget-pane');
    var mw = main && main.getBoundingClientRect ? main.getBoundingClientRect().width : 0;
    var pw = pane && pane.getBoundingClientRect ? pane.getBoundingClientRect().width : 0;
    return Math.round(mw) + 'x' + Math.round(pw);
}
function _rightPanelChatRoom(vs) {
    var c = _rightPanelChatColumn(vs);
    var pw = _rightPanelElWidth(vs);
    return { chat: c.chat, main: c.main, panel: pw > 0 ? pw : 320 };
}

// Closes a visible right panel when it lacks room (_rightPanelLacksRoom:
// chat column - panel < 25% of #main-area).
// Keyed on #main-area width x pane width: a re-sync with unchanged geometry
// (pane re-render -> MutationObserver -> ensureSplitPaneResizeHandle) is a
// no-op, so a panel the user opened on purpose is not closed again.
function enforceRightPanelRoom(force) {
    if (!_rightPanelSplitSideBySide()) { _rightPanelRoomKey = null; return 'skip'; }
    var vs = document.getElementById('version-sidebar');
    if (!vs) return 'skip';
    var key = _rightPanelRoomKeyNow();
    if (!force && key === _rightPanelRoomKey) return 'unchanged';
    _rightPanelRoomKey = key;
    if (!vs.classList.contains('visible') || vs.classList.contains('resize-suspended')) return 'hidden';
    var r = _rightPanelChatRoom(vs);
    if (_rightPanelLacksRoom(r.chat, r.panel, r.main)) {
        _rightPanelClose(vs);
        return 'closed';
    }
    return 'ok';
}

// The user opened the right panel in side-by-side split: shrink the widget
// pane (never below 25% of #main-area) so the messages keep >= 25% of
// #main-area next to the panel. If even
// 25% is not enough the panel still stays open — the user asked for it.
function makeRoomForRightPanel() {
    if (!_rightPanelSplitSideBySide()) return 'skip';
    var vs = document.getElementById('version-sidebar');
    var main = document.getElementById('main-area');
    var pane = document.getElementById('split-widget-pane');
    if (!vs || !main || !pane) return 'skip';
    var r = _rightPanelChatRoom(vs);
    var need = r.main * RIGHT_PANEL_MIN_ROOM_FRACTION - (r.chat - r.panel);
    var result = 'ok';
    if (r.chat > 0 && r.main > 0 && need > 0) {
        var paneW = pane.getBoundingClientRect().width;
        var b = _splitPaneResizeBounds(main);
        var target = Math.max(b.min, paneW - need);
        if (target < paneW) {
            applySplitPaneWidth(target, true);
            result = (paneW - target) >= need ? 'shrunk' : 'partial';
        } else result = 'partial';
    }
    // Remember the geometry this open produced so enforceRightPanelRoom does
    // not immediately undo it.
    _rightPanelRoomKey = _rightPanelRoomKeyNow();
    return result;
}

function initSidebarResize() {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar || document.getElementById('sidebar-resize-handle')) return;
    var handle = document.createElement('div');
    handle.id = 'sidebar-resize-handle';
    handle.className = 'panel-resize-handle sidebar-resize-handle';
    sidebar.appendChild(handle);
    var suspended = null;
    attachPanelResizeHandle(handle, {
        label: typeof t === 'function' ? t('Resize sidebar') : 'Resize sidebar',
        edgeSide: 'end',
        growKey: 'ArrowRight',
        enabled: function() { return sidebar.classList.contains('expanded'); },
        getWidth: function() { return _sidebarCurrentWidth(sidebar); },
        setWidth: function(px, commit) {
            sidebar.classList.add('no-transition');
            applySidebarWidth(px, commit);
            if (commit) _panelResizeRaf(function() { sidebar.classList.remove('no-transition'); });
        },
        reset: function() { applySidebarWidth(null, true); },
        onDragStart: function() { suspended = _sidebarDragSuspendRightPanel(); },
        onDragEnd: function() { var s = suspended; suspended = null; _sidebarDragRestoreRightPanel(s); }
    });
    var saved = _panelResizeReadPx(SIDEBAR_WIDTH_KEY);
    applySidebarWidth(saved, false);
}

// ---- Split widget pane ----------------------------------------------------

function _splitPaneResizeBounds(main) {
    var total = main ? main.getBoundingClientRect().width : 0;
    // Hidden #main-area (another view is shown) measures 0: don't clamp then —
    // the CSS clamp(25%, …, 75%) in css/15b-split-view.css still caps it.
    if (!total) return { min: 0, max: Infinity };
    return { min: Math.round(total * SPLIT_PANE_MIN_FRACTION), max: Math.round(total * SPLIT_PANE_MAX_FRACTION) };
}

// px == null clears the custom width (back to the 50/50 grid default).
function applySplitPaneWidth(px, commit) {
    var main = document.getElementById('main-area');
    if (!main) return null;
    var handle = document.getElementById('split-pane-resize-handle');
    if (px == null) {
        main.classList.remove('split-pane-sized');
        main.style.removeProperty('--split-pane-width');
        if (commit) appStorage.removeItem(SPLIT_PANE_WIDTH_KEY);
        if (handle) handle.removeAttribute('aria-valuenow');
        return null;
    }
    var b = _splitPaneResizeBounds(main);
    var w = Math.round(_panelResizeClamp(px, b.min, b.max));
    // Skip no-op writes: #main-area's style attribute is watched by a
    // MutationObserver (core/082-split-view.js) that calls back in here.
    var cur = typeof main.style.getPropertyValue === 'function' ? main.style.getPropertyValue('--split-pane-width') : null;
    if (cur !== w + 'px') main.style.setProperty('--split-pane-width', w + 'px');
    if (!main.classList.contains('split-pane-sized')) main.classList.add('split-pane-sized');
    if (commit) appStorage.setItem(SPLIT_PANE_WIDTH_KEY, String(w));
    if (handle) {
        handle.setAttribute('aria-valuemin', String(b.min));
        if (isFinite(b.max)) handle.setAttribute('aria-valuemax', String(b.max));
        handle.setAttribute('aria-valuenow', String(w));
    }
    return w;
}

// Called from _splitViewSyncVisibility (core/082-split-view.js) on every pane
// (re)render AND on every #main-area style mutation — including the ones the
// drag itself makes — so the persisted width is NOT re-applied mid-drag
// (that reverted every pointermove to the last saved width).
function ensureSplitPaneResizeHandle(pane) {
    if (!pane || typeof document === 'undefined') return;
    var handle = pane.querySelector(':scope > .split-pane-resize-handle');
    if (!handle) {
        handle = document.createElement('div');
        handle.id = 'split-pane-resize-handle';
        handle.className = 'panel-resize-handle split-pane-resize-handle';
        pane.insertBefore(handle, pane.firstChild);
        var suspended = null;
        attachPanelResizeHandle(handle, {
            label: typeof t === 'function' ? t('Resize split view') : 'Resize split view',
            edgeSide: 'start',
            growKey: 'ArrowLeft',
            getWidth: function() {
                var w = pane.getBoundingClientRect().width;
                if (w) return w;
                var main = document.getElementById('main-area');
                return main ? main.getBoundingClientRect().width / 2 : 0;
            },
            setWidth: function(px, commit) {
                var w = applySplitPaneWidth(px, commit);
                _splitDragRightPanelUpdate(suspended, w);
            },
            reset: function() { applySplitPaneWidth(null, true); },
            // The right panel stays visible; it is hidden live only while the
            // drag position leaves the messages < 25% of #main-area, and
            // closed for real on release only if the final position does.
            onDragStart: function() { suspended = _splitDragRightPanelStart(); },
            onDragEnd: function() {
                var s = suspended; suspended = null;
                _splitDragRightPanelEnd(s);
                if (_rightPanelSplitSideBySide()) _rightPanelRoomKey = _rightPanelRoomKeyNow();
            }
        });
    }
    if (handle.classList.contains('is-dragging')) return;
    var saved = _panelResizeReadPx(SPLIT_PANE_WIDTH_KEY);
    if (saved != null) applySplitPaneWidth(saved, false);
    enforceRightPanelRoom();
}

function _panelResizeOnWindowResize() {
    var savedSidebar = _panelResizeReadPx(SIDEBAR_WIDTH_KEY);
    if (savedSidebar != null) applySidebarWidth(savedSidebar, false);
    var savedPane = _panelResizeReadPx(SPLIT_PANE_WIDTH_KEY);
    if (savedPane != null && document.getElementById('split-widget-pane')) applySplitPaneWidth(savedPane, false);
    enforceRightPanelRoom();
}

(function() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    var resizeRaf = 0;
    function boot() {
        initSidebarResize();
        var pane = document.getElementById('split-widget-pane');
        if (pane) ensureSplitPaneResizeHandle(pane);
        window.addEventListener('resize', function() {
            if (resizeRaf) return;
            resizeRaf = requestAnimationFrame(function() { resizeRaf = 0; _panelResizeOnWindowResize(); });
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
