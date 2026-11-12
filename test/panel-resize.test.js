// Drag-to-resize handles (ui/242-panel-resize.js): sidebar + split pane clamp,
// persistence, double-click reset, keyboard, pointer drag, iframe guard class.
describe('panel resize', function() {
    function fakeEl(id, width) {
        var listeners = {}, attrs = {}, classes = {}, props = {};
        var el = {
            id: id || '', className: '', title: '', children: [], parentNode: null, firstChild: null,
            _width: width || 0,
            classList: {
                add: function(c) { classes[c] = true; }, remove: function(c) { delete classes[c]; },
                contains: function(c) { return !!classes[c]; }, toggle: function(c, on) { if (on) classes[c] = true; else delete classes[c]; }
            },
            style: { setProperty: function(k, v) { props[k] = v; if (el._onStyle) el._onStyle(k, v); }, removeProperty: function(k) { delete props[k]; }, getPropertyValue: function(k) { return k in props ? props[k] : ''; }, _props: props },
            setAttribute: function(k, v) { attrs[k] = String(v); }, getAttribute: function(k) { return k in attrs ? attrs[k] : null; },
            removeAttribute: function(k) { delete attrs[k]; },
            addEventListener: function(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
            fire: function(type, ev) { ev = ev || {}; ev.preventDefault = function() {}; (listeners[type] || []).forEach(function(fn) { fn(ev); }); },
            appendChild: function(c) { el.children.push(c); c.parentNode = el; el.firstChild = el.children[0]; return c; },
            insertBefore: function(c) { el.children.unshift(c); c.parentNode = el; el.firstChild = c; return c; },
            querySelector: function(sel) { var cls = sel.replace(/^:scope > \./, ''); return el.children.filter(function(c) { return c.className.split(' ').indexOf(cls) !== -1; })[0] || null; },
            getBoundingClientRect: function() { return { width: el._width, left: 0, right: el._width }; },
            setPointerCapture: function() {}, releasePointerCapture: function() {}
        };
        return el;
    }
    async function fixture(saved, opts) {
        opts = opts || {};
        var store = Object.assign({}, saved || {});
        var root = fakeEl('root'), body = fakeEl('body');
        var sidebar = fakeEl('sidebar', 260); sidebar.classList.add('expanded');
        var main = fakeEl('main-area', 1200);
        var byId = { sidebar: sidebar, 'main-area': main };
        var closed = 0;
        if (opts.versionSidebar) {
            var wrap = fakeEl('chat-content-wrapper', opts.wrapWidth || 800);
            var vs = fakeEl('version-sidebar', 320); vs.classList.add('visible');
            wrap.appendChild(vs);
            byId['version-sidebar'] = vs; byId._wrap = wrap;
        }
        var doc = {
            readyState: 'complete', documentElement: root, body: body,
            getElementById: function(id) {
                if (byId[id]) return byId[id];
                var all = [sidebar].concat(sidebar.children, byId['split-widget-pane'] ? byId['split-widget-pane'].children : []);
                return all.filter(function(e) { return e.id === id; })[0] || null;
            },
            createElement: function() { return fakeEl(); },
            addEventListener: function() {}
        };
        var resized = 0;
        var g = {
            document: doc,
            window: { innerWidth: opts.innerWidth || 1400, addEventListener: function() {} },
            appStorage: { getItem: function(k) { return k in store ? store[k] : null; }, setItem: function(k, v) { store[k] = String(v); }, removeItem: function(k) { delete store[k]; } },
            getComputedStyle: function() { return { direction: 'ltr' }; },
            requestAnimationFrame: function(fn) { fn(); return 1; },
            cancelAnimationFrame: function() {},
            closeVersionSidebar: function() { closed++; if (byId['version-sidebar']) byId['version-sidebar'].classList.remove('visible'); },
            resizeAllWidgets: function() { resized++; },
            t: function(s) { return s; }
        };
        var m = await loadModules(['src/js/ui/242-panel-resize.js'], { globals: g });
        return { m: m, store: store, root: root, body: body, sidebar: sidebar, main: main, byId: byId, resized: function() { return resized; }, closed: function() { return closed; } };
    }

    test('sidebar handle: a11y attrs, restore + clamp, drag persists, dblclick resets', async function() {
        var f = await fixture({ sidebarWidth: '9999' });
        var h = f.sidebar.children[0];
        assert.ok(h && h.id === 'sidebar-resize-handle', 'handle appended inside #sidebar');
        assert.strictEqual(h.getAttribute('role'), 'separator');
        assert.strictEqual(h.getAttribute('aria-orientation'), 'vertical');
        assert.strictEqual(h.getAttribute('tabindex'), '0');
        assert.strictEqual(h.getAttribute('aria-label'), 'Resize sidebar');
        assert.strictEqual(f.sidebar.style._props['--sidebar-resize-width'], '480px', 'restored width clamped to max 480 (set on #sidebar)');
        assert.strictEqual(f.root.style._props['--sidebar-width'], undefined, ':root token never touched');
        // drag 260 -> 260 + 40
        h.fire('pointerdown', { button: 0, clientX: 260, pointerId: 1 });
        assert.ok(f.body.classList.contains('panel-resizing'), 'iframe/selection guard on during drag');
        h.fire('pointermove', { clientX: 280 });
        assert.strictEqual(f.store.sidebarWidth, '9999', 'not persisted mid-drag');
        assert.strictEqual(f.sidebar.style._props['--sidebar-resize-width'], '280px', 'width follows the pointer mid-drag');
        h.fire('pointerup', { clientX: 300, pointerId: 1 });
        assert.strictEqual(f.store.sidebarWidth, '300');
        assert.ok(!f.body.classList.contains('panel-resizing'));
        assert.ok(f.resized() > 0, 'widgets re-measured');
        // clamp min
        h.fire('pointerdown', { button: 0, clientX: 260, pointerId: 1 });
        h.fire('pointerup', { clientX: 0, pointerId: 1 });
        assert.strictEqual(f.store.sidebarWidth, '180', 'clamped to min 180');
        h.fire('dblclick', {});
        assert.strictEqual('sidebarWidth' in f.store, false, 'reset clears the stored width');
        assert.strictEqual(f.sidebar.style._props['--sidebar-resize-width'], undefined);
        // collapsed sidebar: drag ignored
        f.sidebar.classList.remove('expanded');
        h.fire('pointerdown', { button: 0, clientX: 72, pointerId: 1 });
        assert.ok(!f.body.classList.contains('panel-resizing'), 'no drag when collapsed');
    }, { tags: ['unit'] });

    test('sidebar keyboard: ArrowRight grows, ArrowLeft shrinks, Shift = big step', async function() {
        var f = await fixture();
        var h = f.sidebar.children[0];
        h.fire('keydown', { key: 'ArrowRight' });
        assert.strictEqual(f.store.sidebarWidth, '276');
        f.sidebar._width = 276;
        h.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
        assert.strictEqual(f.store.sidebarWidth, '212');
    }, { tags: ['unit'] });

    test('split pane: handle re-added after re-render, drag left widens, clamps to 25%..75% of #main-area', async function() {
        var f = await fixture({ splitPaneWidth: '500' });
        var pane = fakeEl('split-widget-pane', 600);
        f.byId['split-widget-pane'] = pane;
        f.m.ensureSplitPaneResizeHandle(pane);
        var h = pane.children[0];
        assert.strictEqual(h.className, 'panel-resize-handle split-pane-resize-handle');
        assert.strictEqual(h.getAttribute('aria-label'), 'Resize split view');
        assert.ok(f.main.classList.contains('split-pane-sized'));
        assert.strictEqual(f.main.style._props['--split-pane-width'], '500px', 'persisted width restored');
        f.m.ensureSplitPaneResizeHandle(pane);
        assert.strictEqual(pane.children.length, 1, 'idempotent');
        // pane is right of the divider: moving the pointer left by 100 widens it
        h.fire('pointerdown', { button: 0, clientX: 600, pointerId: 2 });
        h.fire('pointerup', { clientX: 500, pointerId: 2 });
        assert.strictEqual(f.store.splitPaneWidth, '700');
        h.fire('pointerdown', { button: 0, clientX: 600, pointerId: 2 });
        h.fire('pointerup', { clientX: 0, pointerId: 2 });
        assert.strictEqual(f.store.splitPaneWidth, '900', 'max = 75% of main width 1200');
        h.fire('pointerdown', { button: 0, clientX: 600, pointerId: 2 });
        h.fire('pointerup', { clientX: 2000, pointerId: 2 });
        assert.strictEqual(f.store.splitPaneWidth, '300', 'min = 25% of main width 1200');
        h.fire('keydown', { key: 'ArrowLeft' });
        assert.strictEqual(f.store.splitPaneWidth, '616', 'ArrowLeft widens the pane (from measured 600)');
        h.fire('dblclick', {});
        assert.strictEqual('splitPaneWidth' in f.store, false);
        assert.ok(!f.main.classList.contains('split-pane-sized'), 'back to the default 50/50 grid');
    }, { tags: ['unit'] });

    test('082 split view calls the handle hook; CSS scopes resizing to side-by-side layouts', async function() {
        var sv = await loadFile('src/js/core/082-split-view.js');
        assert.match(sv, /typeof ensureSplitPaneResizeHandle === 'function'\) \{ try \{ ensureSplitPaneResizeHandle\(pane\)/);
        var css = await loadFile('src/css/15c-panel-resize.css');
        assert.match(css, /body\.panel-resizing iframe \{ pointer-events: none; \}/);
        assert.match(css, /@media \(min-width: 769px\) \{\s*body:not\(\.sidepanel-mode\) \.sidebar\.expanded/);
        var svCss = await loadFile('src/css/15b-split-view.css');
        assert.match(svCss, /#main-area\.split-pane-sized \{ grid-template-columns: minmax\(0, 1fr\) clamp\(25%, var\(--split-pane-width, 50%\), 75%\); \}/);
        assert.match(svCss, /\.split-widget-pane \{ min-width: 0; \}/, 'pane 320px min lifted side-by-side so 25% applies');
        assert.match(css, /width: var\(--sidebar-resize-width, 260px\)/);
        assert.ok(!/var\(--sidebar-width/.test(css), 'never the :root --sidebar-width token (60px)');
        var tokens = await loadFile('src/css/00-tokens.css');
        assert.match(tokens, /--sidebar-width: 60px/, 'the conflicting token this rename avoids still exists');
        var dark = await loadFile('src/css/01-dark-theme.css');
        assert.match(dark, /\.sidebar\.expanded \{ width: 260px;/, 'default 260 = pre-resize expanded width');
        assert.match(css, /body\.panel-resizing \.sidebar, body\.panel-resizing \.main \{ transition: none !important; \}/);
        assert.match(css, /\.version-sidebar\.resize-suspended \{ display: none !important; \}/);
    }, { tags: ['unit'] });

    test('sidebar: default 260 and collapsed/hidden measurements never become the width', async function() {
        var f = await fixture();
        assert.strictEqual(f.sidebar.style._props['--sidebar-resize-width'], undefined, 'no saved width: CSS 260px fallback');
        assert.strictEqual(f.m.SIDEBAR_WIDTH_DEFAULT, 260);
        f.sidebar._width = 60; // e.g. measured while collapsed / mid-transition
        var h = f.sidebar.children[0];
        h.fire('keydown', { key: 'ArrowRight' });
        assert.strictEqual(f.store.sidebarWidth, '276', 'default 260 + step, not 60 + step');
        f.sidebar._width = 0; // hidden
        h.fire('keydown', { key: 'ArrowRight' });
        assert.strictEqual(f.store.sidebarWidth, '292', 'falls back to the saved width');
    }, { tags: ['unit'] });

    test('sidebar: max accounts for the visible right panel width', async function() {
        var f = await fixture({}, { versionSidebar: true, innerWidth: 1000 });
        var h = f.sidebar.children[0];
        h.fire('keydown', { key: 'ArrowRight', shiftKey: true });
        assert.strictEqual(f.store.sidebarWidth, '280', 'max = 1000 - 400 - 320 (right panel)');
        assert.strictEqual(h.getAttribute('aria-valuemax'), '280');
    }, { tags: ['unit'] });

    test('sidebar drag hides the right panel and restores it when the chat stays wide enough', async function() {
        var f = await fixture({}, { versionSidebar: true, wrapWidth: 900 });
        var vs = f.byId['version-sidebar'], h = f.sidebar.children[0];
        h.fire('pointerdown', { button: 0, clientX: 260, pointerId: 1 });
        assert.ok(vs.classList.contains('resize-suspended'), 'right panel hidden during the drag');
        h.fire('pointermove', { clientX: 300 });
        assert.strictEqual(f.sidebar.style._props['--sidebar-resize-width'], '300px');
        h.fire('pointerup', { clientX: 300, pointerId: 1 });
        assert.ok(!vs.classList.contains('resize-suspended'), 'suspension lifted');
        assert.ok(vs.classList.contains('visible'), 'restored: 900 - 320 >= 25% of 1200');
        assert.strictEqual(f.closed(), 0);
    }, { tags: ['unit'] });

    test('sidebar drag closes the right panel for real when restoring would squeeze the chat', async function() {
        var f = await fixture({}, { versionSidebar: true, wrapWidth: 600 });
        var vs = f.byId['version-sidebar'], h = f.sidebar.children[0];
        h.fire('pointerdown', { button: 0, clientX: 260, pointerId: 1 });
        h.fire('pointerup', { clientX: 460, pointerId: 1 });
        assert.strictEqual(f.closed(), 1, 'closeVersionSidebar called (600 - 320 < 25% of 1200 = 300)');
        assert.ok(!vs.classList.contains('visible'));
        assert.ok(!vs.classList.contains('resize-suspended'));
        // no right panel visible: next drag does not touch it
        h.fire('pointerdown', { button: 0, clientX: 260, pointerId: 1 });
        assert.ok(!vs.classList.contains('resize-suspended'));
        h.fire('pointerup', { clientX: 260, pointerId: 1 });
        assert.strictEqual(f.closed(), 1);
    }, { tags: ['unit'] });

    test('split pane follows the pointer although the #main-area style observer re-syncs on every write', async function() {
        var f = await fixture({ splitPaneWidth: '500' });
        var pane = fakeEl('split-widget-pane', 600);
        f.byId['split-widget-pane'] = pane;
        f.m.ensureSplitPaneResizeHandle(pane);
        // core/082-split-view.js: MutationObserver(main, style) -> _splitViewSyncVisibility -> ensureSplitPaneResizeHandle
        var syncs = 0;
        f.main._onStyle = function() { syncs++; if (syncs < 50) f.m.ensureSplitPaneResizeHandle(pane); };
        var h = pane.children[0];
        h.fire('pointerdown', { button: 0, clientX: 600, pointerId: 2 });
        h.fire('pointermove', { clientX: 550 });
        assert.strictEqual(f.main.style._props['--split-pane-width'], '650px', 'mid-drag width not reverted to the saved 500');
        h.fire('pointermove', { clientX: 500 });
        assert.strictEqual(f.main.style._props['--split-pane-width'], '700px');
        assert.strictEqual(f.store.splitPaneWidth, '500', 'not persisted mid-drag');
        h.fire('pointerup', { clientX: 500, pointerId: 2 });
        assert.strictEqual(f.store.splitPaneWidth, '700');
        assert.strictEqual(f.main.style._props['--split-pane-width'], '700px');
        var before = syncs;
        f.m.ensureSplitPaneResizeHandle(pane);
        assert.strictEqual(syncs, before, 'restoring the same width is a no-op write (no observer ping-pong)');
    }, { tags: ['unit'] });

    test('split pane: restore and window resize clamp to 25%..75%', async function() {
        var f = await fixture({ splitPaneWidth: '9999' });
        var pane = fakeEl('split-widget-pane', 600);
        f.byId['split-widget-pane'] = pane;
        f.m.ensureSplitPaneResizeHandle(pane);
        assert.strictEqual(f.main.style._props['--split-pane-width'], '900px');
        f.store.splitPaneWidth = '10';
        f.main._width = 800;
        f.m._panelResizeOnWindowResize();
        assert.strictEqual(f.main.style._props['--split-pane-width'], '200px', '25% of 800');
        assert.strictEqual(f.store.splitPaneWidth, '10', 'clamp on resize is not persisted');
    }, { tags: ['unit'] });

    async function splitFixture(wrapWidth, paneWidth, opts) {
        var f = await fixture({}, Object.assign({ versionSidebar: true, wrapWidth: wrapWidth }, opts || {}));
        f.body.classList.add('split-view-active');
        var pane = fakeEl('split-widget-pane', paneWidth || 600);
        f.byId['split-widget-pane'] = pane;
        f.pane = pane; f.vs = f.byId['version-sidebar']; f.wrap = f.byId._wrap;
        return f;
    }

    // Rule: close when (chat column - panel) < 25% of #main-area, chat column =
    // #main-area - split pane. Fixture: #main-area 1200 (threshold 300), panel 320.
    test('split drag: no suspend on start, hides live past 25%, shows again, closes on release past it', async function() {
        var f = await splitFixture(900, 500);
        f.m.ensureSplitPaneResizeHandle(f.pane);
        assert.ok(f.vs.classList.contains('visible'), 'enough room at start (1200 - 500 - 320 = 380 >= 300)');
        var h = f.pane.children[0];
        h.fire('pointerdown', { button: 0, clientX: 700, pointerId: 3 });
        assert.ok(!f.vs.classList.contains('resize-suspended'), 'panel NOT hidden when the drag starts');
        h.fire('pointermove', { clientX: 650 }); // pane 550: 1200 - 550 - 320 = 330 >= 300
        assert.ok(!f.vs.classList.contains('resize-suspended'), 'still above the threshold');
        h.fire('pointermove', { clientX: 600 }); // pane 600: 280 < 300
        assert.ok(f.vs.classList.contains('resize-suspended'), 'hidden live once past 25%');
        h.fire('pointermove', { clientX: 680 }); // pane 520: 360 >= 300
        assert.ok(!f.vs.classList.contains('resize-suspended'), 'shown again when the drag moves back');
        assert.strictEqual(f.closed(), 0, 'never closed mid-drag');
        h.fire('pointermove', { clientX: 300 }); // pane 900 (75%): -20 < 300
        assert.ok(f.vs.classList.contains('resize-suspended'));
        h.fire('pointerup', { clientX: 300, pointerId: 3 });
        assert.strictEqual(f.closed(), 1, 'closed for real: final position past the threshold');
        assert.ok(!f.vs.classList.contains('visible'));
        assert.ok(!f.vs.classList.contains('resize-suspended'));
    }, { tags: ['unit'] });

    test('split drag keeps the right panel when released above the threshold', async function() {
        var f = await splitFixture(900, 500);
        f.m.ensureSplitPaneResizeHandle(f.pane);
        var h = f.pane.children[0];
        h.fire('pointerdown', { button: 0, clientX: 700, pointerId: 3 });
        h.fire('pointermove', { clientX: 400 }); // past the threshold mid-drag
        assert.ok(f.vs.classList.contains('resize-suspended'));
        h.fire('pointerup', { clientX: 690, pointerId: 3 }); // pane 510: 370 >= 300
        assert.ok(f.vs.classList.contains('visible'));
        assert.ok(!f.vs.classList.contains('resize-suspended'));
        assert.strictEqual(f.closed(), 0);
    }, { tags: ['unit'] });

    test('enforceRightPanelRoom: closes when squeezed, keyed on geometry, side-by-side split only', async function() {
        var f = await splitFixture(600, 600);
        f.m.ensureSplitPaneResizeHandle(f.pane);
        assert.strictEqual(f.closed(), 1, 'pane render: 1200 - 600 - 320 = 280 < 300 closes the panel');
        // user re-opens it manually; a pane re-render with the same geometry must not undo that
        f.vs.classList.add('visible');
        f.m.ensureSplitPaneResizeHandle(f.pane);
        assert.strictEqual(f.closed(), 1, 'same main x pane geometry: no-op');
        // window resize changes the geometry -> enforced again
        f.main._width = 1100;
        f.m._panelResizeOnWindowResize();
        assert.strictEqual(f.closed(), 2, 'window resize re-checks the room (1100 - 600 - 320 = 180 < 275)');
        // sidepanel / stacked / non-split: never touched
        f.vs.classList.add('visible');
        f.body.classList.add('sidepanel-mode');
        assert.strictEqual(f.m.enforceRightPanelRoom(true), 'skip');
        f.body.classList.remove('sidepanel-mode');
        f.body.classList.remove('split-view-active');
        assert.strictEqual(f.m.enforceRightPanelRoom(true), 'skip');
        assert.strictEqual(f.closed(), 2);
        var g = await splitFixture(600, 600, { innerWidth: 880 });
        assert.strictEqual(g.m.enforceRightPanelRoom(true), 'skip', 'stacked split (<= 900px)');
        var w = await splitFixture(900, 500);
        assert.strictEqual(w.m.enforceRightPanelRoom(true), 'ok', '1200 - 500 - 320 = 380 >= 300');
        var e = await splitFixture(900, 580);
        assert.strictEqual(e.m.enforceRightPanelRoom(true), 'ok', 'exactly 25%: 1200 - 580 - 320 = 300 is not < 300');
        var x = await splitFixture(900, 581);
        assert.strictEqual(x.m.enforceRightPanelRoom(true), 'closed', 'just under 25%');
    }, { tags: ['unit'] });

    test('makeRoomForRightPanel shrinks the pane (>= 25%) and the next sync keeps the panel open', async function() {
        var f = await splitFixture(600, 600);
        assert.strictEqual(f.m.makeRoomForRightPanel(), 'shrunk');
        assert.strictEqual(f.store.splitPaneWidth, '580', '600 - (300 - (1200 - 600 - 320))');
        f.m.ensureSplitPaneResizeHandle(f.pane);
        assert.strictEqual(f.closed(), 0, 'pane re-render after an explicit open does not close it');
        assert.ok(f.vs.classList.contains('visible'));
        var p = await splitFixture(400, 320);
        p.vs._width = 700; // 1200 - 320 - 700 = 180: needs 120, pane min is 300
        assert.strictEqual(p.m.makeRoomForRightPanel(), 'partial', 'cannot go under 25% (300px of 1200)');
        assert.strictEqual(p.store.splitPaneWidth, '300');
        assert.ok(p.vs.classList.contains('visible'), 'still open: the user asked for it');
        var n = await splitFixture(900, 500);
        assert.strictEqual(n.m.makeRoomForRightPanel(), 'ok');
        assert.strictEqual('splitPaneWidth' in n.store, false, 'enough room: pane untouched');
    }, { tags: ['unit'] });

    test('openVersionSidebar calls makeRoomForRightPanel; narrow-chat CSS present', async function() {
        var ui = await loadFile('src/js/ui/120-ui-utils.js');
        var open = ui.slice(ui.indexOf('function openVersionSidebar'), ui.indexOf('function openVersionSidebar') + 600);
        assert.ok(/typeof makeRoomForRightPanel === 'function'/.test(open), 'guarded hook in openVersionSidebar');
        var css = await loadFile('src/css/15d-narrow-chat.css');
        assert.ok(/\.main-wrapper \{ min-width: 0; \}/.test(css));
        assert.ok(/container: chat-composer \/ inline-size/.test(css));
        assert.ok(/@container chat-composer \(max-width: 520px\)/.test(css));
        assert.ok(/@container chat-composer \(max-width: 360px\)/.test(css));
        assert.ok(!/52px/.test(css), 'no 52px strip reserved for the opener');
        assert.ok(!/version-sidebar-open[^{]*\{[^}]*padding-inline-end/.test(css), 'opener reserves no .messages padding');
        var vcss = await loadFile('src/css/11-version.css');
        var opener = (vcss.match(/\.version-sidebar-open \{[^}]*\}/) || [''])[0];
        assert.match(opener, /position: absolute;/, 'opener floats');
        assert.match(opener, /z-index: \d+/);
        assert.match(opener, /box-shadow:/);
        assert.match(opener, /width: 32px; height: 32px;/, 'small hit area');
        var js = await loadFile('src/js/ui/242-panel-resize.js');
        assert.ok(!/SIDEBAR_CHAT_MIN_WITH_PANEL|= 360;/.test(js), '360px constant replaced by the 25% rule');
    }, { tags: ['unit'] });

    test('autoResizeTextarea: empty value collapses to one row, typed text grows up to the cap', async function() {
        var src = await loadFile('src/js/ui/240-layout.js');
        var start = src.indexOf('function autoResizeTextarea(');
        var end = src.indexOf('\n}\n', start);
        var fnSrc = src.slice(start, end + 2);
        var synced = 0;
        var make = new Function('getComputedStyle', '_observeComposerWidth', 'syncSendButton', 'composerSyncDraftSize', fnSrc + '\nreturn autoResizeTextarea;');
        var resize = make(function() { return { maxHeight: '320px' }; }, function() {}, function() { synced++; }, function() {});
        var ta = { value: '', style: { height: '320px' }, scrollHeight: 400, scrollTop: 0, selectionEnd: 0 };
        resize(ta);
        assert.strictEqual(ta.style.height, '', 'empty -> CSS one-row height (placeholder wrap ignored)');
        assert.strictEqual(synced, 1, 'send button still synced');
        ta.value = 'hi'; ta.scrollHeight = 48;
        resize(ta);
        assert.strictEqual(ta.style.height, '48px');
        ta.value = 'long'; ta.scrollHeight = 900; ta.selectionEnd = 4;
        resize(ta);
        assert.strictEqual(ta.style.height, '320px', 'capped at max-height');
    }, { tags: ['unit'] });
});
