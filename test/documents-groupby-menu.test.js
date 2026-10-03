// Documents page Group-by menu (tools/110-smart-documents.js _sdocGroupBySelectHtml):
// icon button + role=listbox replacing the native <select>; keyboard + "g" sync.
describe('documents group-by menu', function() {
    async function setup() {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var stored = {};
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: {
            chats: {}, currentChatId: 'c1', currentView: 'documents',
            escDisplay: function(s) { return String(s); }, escapeHtml: function(s) { return String(s); },
            appStorage: { getItem: function(k) { return stored[k] == null ? null : stored[k]; }, setItem: function(k, v) { stored[k] = v; } }
        } });
        var mnt = await U.mountDom({ css: ['src/css/09-settings.css', 'src/css/19b-widget-library.css', 'src/css/29-documents-page.css'], html:
            '<div id="documents-list"><div class="sdoc-page-toolbar"><div class="segmented-toggle widget-library-layout"><button data-layout="rows">R</button></div></div></div>' });
        m._sdocSyncGroupBySelect(document);
        return { U: U, m: m, mnt: mnt, stored: stored };
    }
    function opts(mnt) { return Array.from(mnt.$$('.sdoc-groupby-option')); }
    // The sandbox frame may not take real focus: record focus() calls instead.
    function trackFocus(mnt) {
        var f = { el: null };
        [mnt.$('.sdoc-groupby-btn')].concat(opts(mnt)).forEach(function(el) { el.focus = function() { f.el = el; }; });
        return f;
    }

    test('pure key index helper', async function() {
        var e = await setup();
        try {
            var f = e.m.sdocGroupByMenuIndex, L = ['Alphabetical', 'Date', 'Git', 'Folder', 'Day', 'Week'];
            assert.strictEqual(f('ArrowDown', 5, 6), 0, 'wraps down');
            assert.strictEqual(f('ArrowUp', 0, 6), 5, 'wraps up');
            assert.strictEqual(f('Home', 3, 6), 0);
            assert.strictEqual(f('End', 1, 6), 5);
            assert.strictEqual(f('d', 0, 6, L), 1, 'type-ahead finds Date');
            assert.strictEqual(f('d', 1, 6, L), 4, 'repeat cycles to Day');
            assert.strictEqual(f('z', 1, 6, L), -1);
            assert.strictEqual(f('Tab', 1, 6, L), -1);
            assert.strictEqual(f('ArrowDown', 0, 0), -1, 'empty list');
        } finally { e.mnt.cleanup(); }
    }, { tags: ['unit'], timeout: 10000 });

    test('renders icon button + listbox, no select and no text label', async function() {
        var e = await setup();
        try {
            var root = e.mnt.$('.sdoc-groupby'), btn = e.mnt.$('.sdoc-groupby-btn');
            assert.ok(root && btn, 'menu inserted');
            assert.strictEqual(root.nextElementSibling, e.mnt.$('.widget-library-layout'), 'sits before the layout toggle');
            assert.strictEqual(e.mnt.$('select'), null, 'native select gone');
            assert.strictEqual(e.mnt.$('.sdoc-groupby-label'), null, 'text label gone');
            assert.strictEqual(btn.tagName, 'BUTTON');
            assert.strictEqual(btn.getAttribute('aria-haspopup'), 'listbox');
            assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
            assert.ok(/Date/.test(btn.getAttribute('aria-label')), 'aria-label names the mode');
            assert.ok(btn.querySelector('.sdoc-groupby-icon svg'), 'button shows the icon');
            assert.strictEqual(btn.querySelector('.sdoc-groupby-value').textContent, 'Date');
            var o = opts(e.mnt);
            assert.deepStrictEqual(o.map(function(x) { return x.getAttribute('data-mode'); }), ['alpha', 'date', 'git', 'folder', 'day', 'week']);
            o.forEach(function(x) {
                assert.strictEqual(x.getAttribute('role'), 'option');
                assert.ok(x.querySelector('.sdoc-groupby-icon svg'), x.getAttribute('data-mode') + ' has an icon');
            });
            assert.deepStrictEqual(o.map(function(x) { return x.getAttribute('aria-selected'); }), ['false', 'true', 'false', 'false', 'false', 'false']);
            assert.strictEqual(e.mnt.$('[role="listbox"]').getAttribute('aria-labelledby'), btn.id);
            assert.strictEqual(e.U.css(e.mnt.$('.sdoc-groupby-menu'), 'display'), 'none', 'menu closed');
        } finally { e.mnt.cleanup(); }
    }, { tags: ['unit'], timeout: 10000 });

    test('open, arrows, Enter picks, Esc closes without exiting selection mode', async function() {
        var e = await setup();
        try {
            var root = e.mnt.$('.sdoc-groupby'), btn = e.mnt.$('.sdoc-groupby-btn'), F = trackFocus(e.mnt);
            e.U.fireInline(btn, 'click', e.m);
            assert.ok(root.classList.contains('open'));
            assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
            assert.notStrictEqual(e.U.css(e.mnt.$('.sdoc-groupby-menu'), 'display'), 'none', 'menu shown');
            var o = opts(e.mnt);
            assert.strictEqual(F.el, o[1], 'focus on the active option');
            var r = e.U.fireInline(root, 'keydown', e.m, { key: 'ArrowDown', target: o[1] });
            assert.ok(r.prevented && r.stopped);
            assert.strictEqual(F.el, o[2]);
            e.U.fireInline(root, 'keydown', e.m, { key: 'End', target: o[2] });
            assert.strictEqual(F.el, o[5]);
            e.U.fireInline(root, 'keydown', e.m, { key: 'Home', target: o[5] });
            assert.strictEqual(F.el, o[0]);
            e.U.fireInline(root, 'keydown', e.m, { key: 'f', target: o[0] });
            assert.strictEqual(F.el, o[3], 'type-ahead');
            e.U.fireInline(root, 'keydown', e.m, { key: 'Enter', target: o[3] });
            assert.strictEqual(e.stored.documentsPageGroupBy, 'folder');
            assert.ok(!root.classList.contains('open'), 'closed after pick');
            assert.strictEqual(F.el, btn, 'focus back on the button');
            assert.strictEqual(btn.querySelector('.sdoc-groupby-value').textContent, 'Folder');
            assert.strictEqual(e.mnt.$('[data-mode="folder"]').getAttribute('aria-selected'), 'true');
            assert.strictEqual(e.mnt.$('[data-mode="date"]').getAttribute('aria-selected'), 'false');
            // Esc: closes + refocuses, stops propagation so docs-sel-clear never sees it.
            e.m.sdocSetSelMode(true);
            e.U.fireInline(root, 'keydown', e.m, { key: 'ArrowDown', target: btn });
            assert.ok(root.classList.contains('open'), 'ArrowDown on the button opens');
            var esc = e.U.fireInline(root, 'keydown', e.m, { key: 'Escape', target: F.el });
            assert.ok(esc.stopped && esc.prevented, 'Esc consumed by the menu');
            assert.ok(!root.classList.contains('open'));
            assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
            assert.strictEqual(F.el, btn);
            assert.strictEqual(e.mnt.$('.sdoc-selmode-btn').getAttribute('aria-pressed'), 'true', 'selection mode untouched');
            // Space on an option and outside-click-style close.
            e.m.sdocOpenGroupByMenu();
            e.U.fireInline(root, 'keydown', e.m, { key: ' ', target: e.mnt.$('[data-mode="week"]') });
            assert.strictEqual(e.stored.documentsPageGroupBy, 'week');
            e.m.sdocOpenGroupByMenu(); e.m.sdocCloseGroupByMenu(false);
            assert.ok(!e.m.sdocGroupByMenuOpen());
        } finally { e.m.sdocSetSelMode(false); e.mnt.cleanup(); }
    }, { tags: ['unit'], timeout: 10000 });

    test('"g" cycle and option click update the button', async function() {
        var e = await setup();
        try {
            var btn = e.mnt.$('.sdoc-groupby-btn');
            assert.strictEqual(e.m.sdocCycleGroupBy(), 'git');
            assert.strictEqual(btn.querySelector('.sdoc-groupby-value').textContent, 'Git');
            assert.ok(/Git/.test(btn.getAttribute('aria-label')));
            assert.strictEqual(e.mnt.$('[data-mode="git"]').getAttribute('aria-selected'), 'true');
            assert.strictEqual(e.mnt.$$('.sdoc-groupby').length, 1, 'no duplicate menu');
            e.U.fireInline(e.mnt.$('[data-mode="alpha"]'), 'click', e.m);
            assert.strictEqual(e.stored.documentsPageGroupBy, 'alpha');
            assert.strictEqual(e.mnt.$('.sdoc-groupby-btn').querySelector('.sdoc-groupby-value').textContent, 'Alphabetical');
        } finally { e.mnt.cleanup(); }
    }, { tags: ['unit'], timeout: 10000 });
});
