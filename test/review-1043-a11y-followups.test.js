// PR #1043 review follow-ups (a11y): custom-dropdown aria state + Esc, Esc-to-pause
// gate, attachment-row nested buttons, shortcuts-modal Tab trap + focus restore,
// JSON collapse aria-expanded and the Shift check for symbol shortcuts.
// Real source only: functions are sliced from the workspace files (top-level
// `function name(` .. first column-0 "}") or loaded with loadModules; stubs cover
// only DOM/document scoping. Sandbox focus() does not move activeElement, so focus is
// observed through spies.
// Run: run_tests { files: ['test/review-1043-a11y-followups.test.js'] }
var WS = args.workspace;

async function sliceFns(file, names) {
    var src = await loadFile(file, WS);
    return names.map(function(name) {
        var a = src.indexOf('\nfunction ' + name + '('), b = src.indexOf('\n}\n', a);
        if (a < 0 || b < a) throw new Error(name + ' not found in ' + file);
        return src.slice(a, b + 2);
    }).join('\n');
}
// Evaluate `code` with `document` + named deps; returns the named functions.
function evalWith(code, doc, deps, exportNames) {
    deps = deps || {};
    var names = Object.keys(deps);
    var body = code + '\nreturn {' + exportNames.map(function(n) { return n + ':' + n; }).join(',') + '};';
    return Function.apply(null, ['document'].concat(names, [body]))
        .apply(null, [doc].concat(names.map(function(k) { return deps[k]; })));
}
function scopedDoc(root, opts) {
    opts = opts || {};
    return {
        get body() { return document.body; },
        get activeElement() { return opts.active ? opts.active() : null; },
        listeners: {},
        addEventListener: function(type, fn) { this.listeners[type] = fn; },
        getElementById: function(id) { return root.querySelector('[id="' + id + '"]'); },
        querySelector: function(sel) { return root.querySelector(sel); },
        querySelectorAll: function(sel) { return root.querySelectorAll(sel); }
    };
}
var mounted = [];
function mount(html) {
    var r = document.createElement('div');
    r.className = 'zz-1043-root';
    r.innerHTML = html || '';
    document.body.appendChild(r);
    mounted.push(r);
    return r;
}
function ddHtml(id, open) {
    return '<div class="custom-dropdown' + (open ? ' open' : '') + '" id="' + id + '">' +
        '<button class="custom-dropdown-trigger" aria-expanded="' + (open ? 'true' : 'false') + '"><span class="dropdown-label">A</span></button>' +
        '<div class="custom-dropdown-options" role="listbox">' +
        '<div class="custom-dropdown-option selected" role="option" aria-selected="true" data-value="a" data-label="A">A</div>' +
        '<div class="custom-dropdown-option" role="option" aria-selected="false" data-value="b" data-label="B">B</div>' +
        '</div></div>';
}
var DD_FILE = 'src/js/ui/140-dropdowns.js';
async function loadDropdowns(doc) {
    var src = await loadFile(DD_FILE, WS);
    var code = await sliceFns(DD_FILE, ['syncCustomDropdownExpanded', 'toggleCustomDropdown', 'selectCustomDropdownOption']);
    var a = src.indexOf('// Close custom dropdowns when clicking outside'), b = src.indexOf('\n});\n', a);
    assert.ok(a >= 0 && b > a, 'outside-click handler present');
    return evalWith(code + '\n' + src.slice(a, b + 5), doc, {}, ['syncCustomDropdownExpanded', 'toggleCustomDropdown', 'selectCustomDropdownOption']);
}

describe('#1043 follow-up 1: custom dropdown aria-expanded / aria-selected', function() {
    afterEach(function() { mounted.forEach(function(r) { r.remove(); }); mounted = []; });

    test('every open/close path keeps aria-expanded in sync; selection flips aria-selected', async function() {
        var root = mount(ddHtml('zz-dd1') + ddHtml('zz-dd2'));
        var doc = scopedDoc(root);
        var D = await loadDropdowns(doc);
        var t1 = root.querySelector('#zz-dd1 .custom-dropdown-trigger'), t2 = root.querySelector('#zz-dd2 .custom-dropdown-trigger');
        D.toggleCustomDropdown('zz-dd1');
        assert.strictEqual(t1.getAttribute('aria-expanded'), 'true');
        assert.strictEqual(t2.getAttribute('aria-expanded'), 'false');
        D.toggleCustomDropdown('zz-dd2');
        assert.strictEqual(root.querySelector('#zz-dd1').classList.contains('open'), false, 'opening dd2 closed dd1');
        assert.strictEqual(t1.getAttribute('aria-expanded'), 'false', 'close-others loop resets the closed trigger');
        assert.strictEqual(t2.getAttribute('aria-expanded'), 'true');
        var picked = [];
        D.selectCustomDropdownOption('c', 'zz-dd2', 'b', function(v) { picked.push(v); }, { stopPropagation: function() {} });
        assert.deepStrictEqual(picked, ['b']);
        assert.strictEqual(t2.getAttribute('aria-expanded'), 'false', 'selecting an option collapses the trigger');
        var opts = root.querySelectorAll('#zz-dd2 .custom-dropdown-option');
        assert.strictEqual(opts[0].getAttribute('aria-selected'), 'false');
        assert.strictEqual(opts[1].getAttribute('aria-selected'), 'true');
        assert.strictEqual(opts[1].classList.contains('selected'), true);
        D.toggleCustomDropdown('zz-dd1');
        assert.strictEqual(t1.getAttribute('aria-expanded'), 'true');
        assert.strictEqual(typeof doc.listeners.click, 'function', 'outside-click handler registered');
        doc.listeners.click({ target: document.body });
        assert.strictEqual(root.querySelectorAll('.custom-dropdown.open').length, 0, 'outside click closes');
        assert.strictEqual(t1.getAttribute('aria-expanded'), 'false', 'outside click resets aria-expanded');
        // A click inside a dropdown is not "outside".
        D.toggleCustomDropdown('zz-dd1');
        doc.listeners.click({ target: opts[0] });
        assert.strictEqual(t1.getAttribute('aria-expanded'), 'true');
    }, { tags: ['unit'], timeout: 3000 });
});

describe('#1043 follow-up 2: Esc on an open custom dropdown', function() {
    var FROM = "document.addEventListener('keydown', function(e) {\n        if (e.key !== 'Escape')";
    var TO = '// NAV-H7';
    var CLOSERS = ['closeModal', 'closeWidgetFullscreen', 'closeWidgetCodeEdit', 'closeWidgetModal',
        'closeWidgetHistory', 'closeResultPopover', 'closeDiffViewer', 'closeDropdowns', 'closeAllHeaderMenus'];
    afterEach(function() { mounted.forEach(function(r) { r.remove(); }); mounted = []; });

    test('the Esc ladder closes the dropdown, resyncs aria-expanded and refocuses its trigger', async function() {
        var root = mount(ddHtml('zz-esc1', false) + ddHtml('zz-esc2', true));
        var doc = scopedDoc(root);
        var D = await loadDropdowns(doc);
        var syncs = 0;
        var src = await loadFile('src/js/core/120-init.js', WS);
        var a = src.indexOf(FROM), b = src.indexOf(TO, a);
        assert.ok(a >= 0 && b > a, 'Esc handler anchors present');
        var calls = [];
        var win = { getComputedStyle: function() { return { display: 'none' }; } };
        var install = Function.apply(null, ['document', 'window'].concat(CLOSERS,
            ['closeWidgetPinMenu', 'closeChatDropdowns', 'clearGlobalSearch', 'syncCustomDropdownExpanded', src.slice(a, b)]));
        install.apply(null, [doc, win].concat(CLOSERS.map(function(n) { return function() { calls.push(n); }; }),
            [undefined, function() {}, undefined, function() { syncs++; return D.syncCustomDropdownExpanded(); }]));
        var trig = root.querySelector('#zz-esc2 .custom-dropdown-trigger'), focused = [];
        trig.focus = function() { focused.push(trig); };
        doc.listeners.keydown({ key: 'Escape' });
        assert.strictEqual(root.querySelectorAll('.custom-dropdown.open').length, 0, 'dropdown closed');
        assert.strictEqual(syncs, 1, 'sync helper called');
        assert.strictEqual(trig.getAttribute('aria-expanded'), 'false');
        assert.deepStrictEqual(focused, [trig], 'focus returned to that dropdown\'s trigger');
        assert.deepStrictEqual(calls, [], 'no other closer ran');
        doc.listeners.keydown({ key: 'Escape' });
        assert.strictEqual(syncs, 1, 'nothing open: next Esc is a no-op for dropdowns');
    }, { tags: ['unit'], timeout: 3000 });
});

describe('#1043 follow-ups 2/4/7/8: keyboard-shortcuts module', function() {
    var M, qsHit, byId, listeners, active, gears;
    function ev(key, mods) {
        mods = mods || {};
        var e = { key: key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift,
            target: { tagName: 'BODY' }, defaultPrevented: false };
        e.preventDefault = function() { e.defaultPrevented = true; };
        return e;
    }
    beforeEach(async function() {
        qsHit = {}; byId = {}; listeners = []; active = { tagName: 'BODY' }; gears = [];
        var fakeDoc = {
            get activeElement() { return active; },
            body: { tagName: 'BODY' },
            querySelector: function(sel) {
                var ks = Object.keys(qsHit);
                for (var i = 0; i < ks.length; i++) if (sel.indexOf(ks[i]) >= 0) return qsHit[ks[i]];
                return null;
            },
            querySelectorAll: function(sel) { return sel === '.settings-btn' ? gears : []; },
            getElementById: function(i) { return byId[i] || null; },
            addEventListener: function(type, fn) { listeners.push({ type: type, fn: fn }); },
            removeEventListener: function(type, fn) { listeners = listeners.filter(function(l) { return !(l.type === type && l.fn === fn); }); }
        };
        M = await loadModules(['src/js/ui/320-keyboard-shortcuts.js'], { lenient: true, globals: {
            document: fakeDoc,
            window: { getComputedStyle: function() { return { display: 'none' }; } },
            currentChatId: 'c1',
            togglePause: function() {},
            _chatControlsState: function() { return 'pause'; },
            t: function(s) { return s; }, N_: function(s) { return s; },
            console: { warn: function() {}, log: function() {}, error: function() {} }
        } });
    });

    test('2: an open .custom-dropdown counts as an open menu, so Esc does not pause the agent', function() {
        assert.strictEqual(M.kbdCanPause(), true, 'baseline: nothing open, pause allowed');
        qsHit['.custom-dropdown.open'] = { tagName: 'DIV' };
        assert.strictEqual(M.kbdMenuOpen(), true);
        assert.strictEqual(M.kbdCanPause(), false, 'Esc from a custom-dropdown option must not pause');
    }, { tags: ['unit'] });

    test('8: Mod+, and letters check Shift; ?-style and / bindings stay Shift-tolerant', function() {
        assert.strictEqual(M.matchShortcut(ev(',', { ctrl: true }), false).id, 'settings');
        assert.strictEqual(M.matchShortcut(ev(',', { ctrl: true, shift: true }), false), null, 'Ctrl+Shift+, is not Ctrl+,');
        assert.strictEqual(M.matchShortcut(ev(',', { meta: true, shift: true }), true), null, 'Cmd+Shift+, is not Cmd+,');
        assert.strictEqual(M.matchShortcut(ev('?', { shift: true }), false).id, 'help', '? needs Shift on US');
        assert.strictEqual(M.matchShortcut(ev('/', { ctrl: true, shift: true }), false).id, 'help', 'German Ctrl+Shift+7 types / (layout needs Shift)');
        assert.strictEqual(M.matchShortcut(ev('s', { meta: true, shift: true }), true).id, 'sidebar');
        assert.strictEqual(M.kbdShiftTolerantSymbol('?'), true);
        assert.strictEqual(M.kbdShiftTolerantSymbol(','), false);
        assert.strictEqual(M.kbdShiftTolerantSymbol('.'), false);
        assert.strictEqual(M.kbdShiftTolerantSymbol('Escape'), false);
    }, { tags: ['unit'] });

    test('7: focus restore order: opener > composer > visible gear > body', function() {
        var log = [];
        function el(name, visible) { return { name: name, isConnected: true, offsetParent: visible ? {} : null, value: '', focus: function() { log.push(name); }, setSelectionRange: function() {} }; }
        var opener = el('opener', true);
        assert.strictEqual(M.kbdRestoreModalFocus(opener), 'opener');
        opener.isConnected = false;
        byId['message-input'] = el('composer', true);
        assert.strictEqual(M.kbdRestoreModalFocus(opener), 'composer', 'disconnected opener falls back to the composer');
        byId['message-input'] = el('composer', false);
        gears = [el('hidden-gear', false), el('gear', true)];
        assert.strictEqual(M.kbdRestoreModalFocus(null), 'gear', 'no composer: first visible gear');
        gears = [];
        var blurred = 0;
        active = { tagName: 'BUTTON', blur: function() { blurred++; } };
        assert.strictEqual(M.kbdRestoreModalFocus(null), 'body', 'nothing focusable: body');
        assert.strictEqual(blurred, 1, 'stale focus dropped to body');
        assert.deepStrictEqual(log, ['opener', 'composer', 'gear']);
    }, { tags: ['unit'] });

    test('4: the document-level trap handles Tab from <body>, once, and no-ops without the overlay', function() {
        var focused = [];
        var first = { offsetParent: {}, focus: function() { focused.push('first'); } }, last = { offsetParent: {}, focus: function() { focused.push('last'); } };
        var ov = { id: 'keyboard-shortcuts-modal', querySelector: function() { return { querySelectorAll: function() { return [first, last]; } }; } };
        byId['keyboard-shortcuts-modal'] = ov;
        active = { tagName: 'BODY' };
        var e = ev('Tab');
        M._kbdModalKeydown(e);
        assert.strictEqual(e.defaultPrevented, true, 'Tab from <body> is trapped');
        assert.deepStrictEqual(focused, ['first'], 'focus enters the dialog');
        var e2 = ev('Tab'); e2.defaultPrevented = true;
        M._kbdModalKeydown(e2);
        assert.deepStrictEqual(focused, ['first'], 'an already-handled Tab is not handled twice');
        var e4 = ev('Tab', { shift: true });
        M._kbdModalKeydown(e4);
        assert.deepStrictEqual(focused, ['first', 'last'], 'Shift+Tab from <body> wraps to the last control');
        delete byId['keyboard-shortcuts-modal'];
        var e3 = ev('Tab');
        M._kbdModalKeydown(e3);
        assert.strictEqual(e3.defaultPrevented, false, 'no overlay: no-op');
    }, { tags: ['unit'] });
});

describe('#1043 follow-up 4: openShortcutsModal binds exactly one document trap', function() {
    test('open twice then close: listener count 1 -> 1 -> 0', async function() {
        var root = document.createElement('div');
        document.body.appendChild(root);
        var listeners = [];
        var doc = {
            get body() { return root; },
            get activeElement() { return null; },
            createElement: function(tag) { return document.createElement(tag); },
            getElementById: function(id) { return root.querySelector('[id="' + id + '"]'); },
            querySelector: function(sel) { return root.querySelector(sel); },
            querySelectorAll: function(sel) { return root.querySelectorAll(sel); },
            addEventListener: function(type, fn) { listeners.push({ type: type, fn: fn }); },
            removeEventListener: function(type, fn) { listeners = listeners.filter(function(l) { return !(l.type === type && l.fn === fn); }); }
        };
        try {
            var M = await loadModules(['src/js/ui/320-keyboard-shortcuts.js'], { lenient: true, globals: {
                document: doc,
                window: { getComputedStyle: function() { return { display: 'none' }; } },
                navigator: { platform: 'Linux', userAgent: 'x' },
                t: function(s) { return s; }, N_: function(s) { return s; }, tn: function(n, a) { return a; },
                console: { warn: function() {}, log: function() {}, error: function() {} }
            } });
            function trapCount() { return listeners.filter(function(l) { return l.type === 'keydown' && l.fn === M._kbdModalKeydown; }).length; }
            var ov = M.openShortcutsModal();
            assert.ok(ov && ov.id === 'keyboard-shortcuts-modal', 'overlay mounted');
            assert.strictEqual(trapCount(), 1, 'one document keydown trap');
            M.openShortcutsModal();
            assert.strictEqual(trapCount(), 1, 'opening again does not add a second listener');
            M.closeShortcutsModal();
            assert.strictEqual(root.querySelector('#keyboard-shortcuts-modal'), null, 'overlay removed');
            assert.strictEqual(trapCount(), 0, 'trap removed on close');
            M.openShortcutsModal();
            assert.strictEqual(trapCount(), 1, 're-open binds again');
            M.closeShortcutsModal();
            assert.strictEqual(trapCount(), 0);
        } finally { root.remove(); }
    }, { tags: ['unit'], timeout: 3000 });
});

describe('#1043 follow-up 3a: attachment rows have no nested buttons', function() {
    afterEach(function() { mounted.forEach(function(r) { r.remove(); }); mounted = []; });

    test('the row is not a button; .screenshot-sidebar-info is, and activates the row exactly once', async function() {
        var src = await loadFile('src/js/ui/120-ui-utils.js', WS);
        var a = src.indexOf('        screenshots.forEach(function(item, i) {'), b = src.indexOf("        html += '</div>';", a);
        assert.ok(a >= 0 && b > a, 'attachment block found in renderVersionSidebar');
        var render = new Function('screenshots', 'pdfAttachments', 'fileAttachments', 't', 'escapeHtml', 'escapeJsString', 'UI_ICONS', 'formatFileSize',
            "var html = '';\n" + src.slice(a, b) + '\nreturn html;');
        var esc = function(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); };
        var html = render([{ msg: { name: 'shot', base64: 'data:image/png;base64,AAAA', width: 1, height: 1 }, idx: 3 }],
            [{ msg: { name: 'doc.pdf' }, idx: 4 }], [{ msg: { name: 'a.txt', size: 10 }, idx: 5 }],
            function(s) { return s; }, esc, function(s) { return s; }, { download: '' }, function() { return '10 B'; });
        var root = mount('<div class="screenshot-sidebar-list">' + html + '</div>');
        var rows = root.querySelectorAll('.screenshot-sidebar-item');
        assert.strictEqual(rows.length, 3);
        var M = await loadModules(['src/js/ui/320-keyboard-shortcuts.js'], { lenient: true, globals: {
            document: { querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, addEventListener: function() {} },
            window: { getComputedStyle: function() { return { display: 'none' }; } },
            t: function(s) { return s; }, N_: function(s) { return s; },
            console: { warn: function() {}, log: function() {}, error: function() {} }
        } });
        Array.prototype.forEach.call(rows, function(row) {
            assert.strictEqual(row.getAttribute('role'), null, 'row has no role');
            assert.strictEqual(row.getAttribute('tabindex'), null, 'row is not a tab stop');
            assert.strictEqual(row.hasAttribute('data-kbd-click'), false);
            assert.ok(/^scrollToMessage\(\d+\)$/.test(row.getAttribute('onclick')), 'row keeps its mouse onclick');
            var info = row.querySelector('.screenshot-sidebar-info'), thumb = row.querySelector('.screenshot-sidebar-thumb');
            assert.strictEqual(info.getAttribute('role'), 'button');
            assert.strictEqual(info.getAttribute('tabindex'), '0');
            assert.strictEqual(info.hasAttribute('data-kbd-click'), true);
            assert.strictEqual(info.getAttribute('onclick'), null, 'info has no onclick of its own');
            assert.strictEqual(thumb.getAttribute('role'), 'button', 'thumb stays its own button');
            assert.strictEqual(thumb.parentElement.closest('[role="button"]'), null, 'no button nested in a button');
            assert.strictEqual(info.parentElement.closest('[role="button"]'), null);
            // Enter on info -> real kbdHandleActivation -> click() bubbles to the row once.
            var hits = 0;
            row.onclick = null; row.removeAttribute('onclick');
            row.addEventListener('click', function() { hits++; });
            var e = { key: 'Enter', target: info, altKey: false, ctrlKey: false, metaKey: false, preventDefault: function() { e.prevented = true; } };
            M.kbdHandleActivation(e);
            assert.strictEqual(e.prevented, true);
            assert.strictEqual(hits, 1, 'row activation fires exactly once');
        });
    }, { tags: ['unit'], timeout: 3000 });
});

describe('#1043 follow-up 5: JSON collapse exposes aria-expanded', function() {
    test('markup starts expanded and both toggle branches update aria-expanded', async function() {
        var code = await sliceFns('src/js/ui/190-json-format.js', ['formatJsonValue', 'toggleJsonCollapse']);
        var root = document.createElement('div');
        document.body.appendChild(root);
        try {
            var doc = { getElementById: function(id) { return root.querySelector('[id="' + id + '"]'); } };
            var F = evalWith(code, doc, {
                escapeHtml: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); },
                t: function(s) { return s; }, tn: function(n, a, b) { return (n === 1 ? a : b).replace('{count}', n); }
            }, ['formatJsonValue', 'toggleJsonCollapse']);
            root.innerHTML = F.formatJsonValue({ a: [1, 2], s: 'x'.repeat(100) }, 0);
            var btns = root.querySelectorAll('.json-collapse');
            assert.strictEqual(btns.length, 3, 'object, array and long-string toggles');
            Array.prototype.forEach.call(btns, function(btn) {
                assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
                var target = root.querySelector('[id="' + btn.getAttribute('aria-controls') + '"]');
                assert.ok(target, 'aria-controls points at the collapsible');
                var id = btn.getAttribute('aria-controls');
                F.toggleJsonCollapse(id, { target: btn, stopPropagation: function() {} });
                assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
                assert.strictEqual(btn.textContent, '+');
                F.toggleJsonCollapse(id, { target: btn, stopPropagation: function() {} });
                assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
                assert.strictEqual(btn.textContent, '\u2212');
            });
        } finally { root.remove(); }
    }, { tags: ['unit'], timeout: 3000 });
});
