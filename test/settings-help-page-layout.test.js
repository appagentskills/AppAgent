// Settings + Help pages on the shared full-width layout:
//  - mountSharedPageHeader (ui/045-page-layout.js) moves the ONE .home-header
//    (New Chat title + pills) into #settings-page-panel / #docs-panel;
//  - body.html gives both pages a .page-toolbar with a search slot + actions;
//  - filterSettingsPage / filterDocsPage (ui/046-settings-help-search.js)
//    filter in place with an empty state; the input handlers debounce 150ms.
// Run: run_tests { files: ['test/settings-help-page-layout.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var MODS = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js',
    'src/js/ui/045-page-layout.js', 'src/js/ui/046-settings-help-search.js'];

function timers() {
    var t = { pending: [], setTimeout: function(fn, ms) { t.pending.push({ fn: fn, ms: ms }); return t.pending.length; }, clearTimeout: function(id) { if (t.pending[id - 1]) t.pending[id - 1].fn = null; } };
    t.flush = function() { var p = t.pending; t.pending = []; p.forEach(function(x) { if (x.fn) x.fn(); }); };
    return t;
}
async function setup() {
    var t = timers();
    var m = await U.loadUi(MODS, { lenient: true, allowUnstubbed: { indexOf: function() { return 0; } },
        globals: { appStorage: { getItem: function() { return null; }, setItem: function() {} }, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout } });
    var dom = await U.mountDom({ body: true });
    return { m: m, dom: dom, t: t };
}
function hidden(el) { return el.classList.contains('page-search-hidden'); }

var SETTINGS_HTML =
    '<div class="settings-page-section" id="s-gh"><div class="settings-page-section-title">GitHub</div><div class="settings-page-row-hint">Connect a GitHub account</div><div id="github-settings-container">PAT token repo</div></div>' +
    '<div class="settings-page-section" id="s-disp"><div class="settings-page-section-title">Display</div>' +
        '<div class="settings-page-row" id="r-theme"><div class="settings-page-row-label">Theme</div><select id="theme-sel"><option value="dark" selected>Dark</option></select></div>' +
        '<div class="settings-page-row" id="r-stats"><div class="settings-page-row-label">Show API Statistics</div><input type="checkbox" id="stats-cb" checked></div>' +
    '</div>';
var DOCS_HTML = '<div class="docs-layout"><div class="docs-main">' +
    '<section id="intro" class="docs-section"><h1>Getting started</h1><p>Welcome.</p></section>' +
    '<section id="intro-install" class="docs-section docs-subsection"><h2>Install</h2><p>Load unpacked extension.</p></section>' +
    '<hr class="docs-hr">' +
    '<section id="skills" class="docs-section"><h1>Skills</h1><p>Teach the agent.</p></section>' +
    '</div><nav class="docs-outline"><div class="docs-nav-item" data-docs-anchor="intro">Getting started</div><div class="docs-nav-subitem" data-docs-anchor="intro-install">Install</div><div class="docs-nav-item" data-docs-anchor="skills">Skills</div></nav></div>';

describe('settings + help › shared New Chat header and toolbar', function() {
    afterEach(function() { U.cleanupAll(); });
    test('mountSharedPageHeader mounts the single .home-header (with pills) on settings-page and docs, and back on home', async function() {
        var s = await setup();
        var headers = s.dom.$$('.home-header');
        assert.strictEqual(headers.length, 1, 'one shared header in body.html');
        var header = headers[0], pillsBefore = header.querySelectorAll('[id]').length;
        s.m.mountSharedPageHeader('settings-page');
        assert.strictEqual(s.dom.$('#settings-page-panel').firstElementChild, header);
        assert.ok(header.classList.contains('shared-page-header'));
        s.m.mountSharedPageHeader('docs');
        assert.strictEqual(s.dom.$('#docs-panel').firstElementChild, header);
        assert.strictEqual(header.querySelectorAll('[id]').length, pillsBefore, 'pills move with the header, not copied');
        s.m.mountSharedPageHeader('chat'); // chat keeps the header where it was
        assert.strictEqual(header.parentNode.id, 'docs-panel');
        s.m.mountSharedPageHeader('home');
        assert.strictEqual(header.parentNode.id, 'home-panel');
        assert.ok(!header.classList.contains('shared-page-header'));
    }, { tags: ['unit'] });

    test('body.html: settings + help headers are page toolbars with title, search slot and their actions', async function() {
        var s = await setup();
        [['#settings-page-panel', 'settings-toolbar-slot', ['importAllData()', 'exportAllData()']],
         ['#docs-panel', 'docs-toolbar-slot', ['downloadDocsAsMarkdown()']]].forEach(function(c) {
            var tb = s.dom.$(c[0] + ' > .page-toolbar');
            assert.ok(tb, c[0] + ' toolbar');
            assert.ok(tb.querySelector('.page-toolbar-title'), 'title');
            assert.ok(tb.querySelector('#' + c[1] + '.page-toolbar-slot'), 'slot ' + c[1]);
            var acts = Array.prototype.map.call(tb.querySelectorAll('.page-toolbar-actions button'), function(b) { return b.getAttribute('onclick'); });
            assert.deepStrictEqual(acts, c[2]);
        });
        var slot = s.m.ensurePageSearchToolbar('settings-toolbar-slot', { placeholder: 'Search settings', onInput: 'settingsOnSearchInput', countId: 'settings-search-count' });
        assert.ok(slot.querySelector('input[type=search]'), 'search input rendered into the slot');
        s.m.ensurePageSearchToolbar('settings-toolbar-slot', { placeholder: 'x', onInput: 'y', countId: 'z' });
        assert.strictEqual(slot.querySelectorAll('input').length, 1, 'slot filled only once');
    }, { tags: ['unit'] });
});

describe('settings + help › search filtering', function() {
    afterEach(function() { U.cleanupAll(); });
    test('filterSettingsPage: title hit shows whole section, row hit shows only matching rows, content hit shows section, empty state', async function() {
        var s = await setup();
        var root = s.dom.$('#settings-page-content'); root.innerHTML = SETTINGS_HTML;
        var r = s.m.filterSettingsPage(root, 'statistics');
        assert.deepStrictEqual(r, { shown: 1, total: 2 });
        assert.ok(hidden(s.dom.$('#s-gh')) && !hidden(s.dom.$('#s-disp')));
        assert.ok(hidden(s.dom.$('#r-theme')) && !hidden(s.dom.$('#r-stats')));
        s.m.filterSettingsPage(root, 'DISPLAY');
        assert.ok(!hidden(s.dom.$('#r-theme')) && !hidden(s.dom.$('#r-stats')), 'title hit un-hides all rows');
        s.m.filterSettingsPage(root, 'pat token');
        assert.ok(!hidden(s.dom.$('#s-gh')), 'async container text matches');
        s.m.filterSettingsPage(root, 'zzz-nothing');
        assert.ok(root.querySelector('.page-search-empty'), 'empty state');
        assert.match(root.querySelector('.page-search-empty').textContent, /zzz-nothing/);
        s.m.filterSettingsPage(root, '');
        assert.strictEqual(root.querySelector('.page-search-empty'), null);
        assert.strictEqual(root.querySelectorAll('.page-search-hidden').length, 0);
        assert.strictEqual(s.dom.$('#theme-sel').value, 'dark'); assert.strictEqual(s.dom.$('#stats-cb').checked, true, 'controls untouched');
    }, { tags: ['unit'] });

    test('filterDocsPage: subsection hit keeps its chapter, outline + hr follow, empty state', async function() {
        var s = await setup();
        var root = s.dom.$('#docs-content'); root.innerHTML = DOCS_HTML;
        var r = s.m.filterDocsPage(root, 'unpacked');
        assert.deepStrictEqual(r, { shown: 2, total: 3 });
        assert.ok(!hidden(s.dom.$('#intro')) && !hidden(s.dom.$('#intro-install')) && hidden(s.dom.$('#skills')));
        assert.ok(hidden(s.dom.$('.docs-hr')));
        assert.ok(hidden(s.dom.$('[data-docs-anchor="skills"]')) && !hidden(s.dom.$('[data-docs-anchor="intro-install"]')));
        s.m.filterDocsPage(root, 'nope-nope');
        assert.ok(s.dom.$('.docs-main > .page-search-empty'));
        assert.deepStrictEqual(s.m.filterDocsPage(root, ''), { shown: 3, total: 3 });
        assert.strictEqual(root.querySelectorAll('.page-search-hidden').length, 0);
    }, { tags: ['unit'] });

    test('settingsOnSearchInput / docsOnSearchInput debounce 150ms and update the toolbar count', async function() {
        var s = await setup();
        s.dom.$('#settings-page-content').innerHTML = SETTINGS_HTML;
        s.m.ensurePageSearchToolbar('settings-toolbar-slot', { placeholder: 'Search', onInput: 'settingsOnSearchInput', countId: 'settings-search-count' });
        s.m.settingsOnSearchInput('the'); s.m.settingsOnSearchInput('theme');
        assert.strictEqual(s.t.pending.length, 2); assert.strictEqual(s.t.pending[1].ms, 150);
        assert.ok(!hidden(s.dom.$('#s-gh')), 'not filtered before the debounce fires');
        s.t.flush();
        assert.ok(hidden(s.dom.$('#s-gh')));
        assert.strictEqual(s.dom.$('#settings-toolbar-slot .widget-library-count').textContent, '1 of 2');
        s.dom.$('#docs-content').innerHTML = DOCS_HTML;
        s.m.ensurePageSearchToolbar('docs-toolbar-slot', { placeholder: 'Search', onInput: 'docsOnSearchInput', countId: 'docs-search-count' });
        s.m.docsOnSearchInput('skills'); s.t.flush();
        assert.strictEqual(s.dom.$('#docs-toolbar-slot .widget-library-count').textContent, '1 of 3');
        s.m.clearSettingsPageSearch();
        assert.strictEqual(s.dom.$('#settings-toolbar-slot .widget-library-count').textContent, '2 sections');
    }, { tags: ['unit'] });
});
