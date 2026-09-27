// RG-B10 (post-reload regression pass) — UI finds.
// NEW-F15-1: the SKILL.md card is VIRTUAL (rendered by skillToMarkdown(skill)).
// Saving it from the asset modal must update the skill only and never store a
// frozen SKILL.md asset copy. Legacy stored copies must neither render as a
// 2nd SKILL.md card nor overwrite the fresh SKILL.md on folder export.
// REAL src modules (loadModules, lenient) + REAL body.html markup; only the
// IndexedDB layer (saveSkill, saveSkillAsset/getSkillAssets/getSkillAsset)
// is an in-memory stub. Loader copied from ui-skills-permissions.test.js.
// Run: run_tests { files: ['test/rg-b10-ui-finds.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/060-ui-constants.js', 'src/js/core/070-permissions.js', 'src/js/ui/180-search.js', 'src/js/tools/120-actions.js',
    'src/js/core/120-init.js', 'src/js/ui/010-skills-ui.js', 'src/js/ui/140-dropdowns.js', 'src/js/ui/040-tools-settings.js', 'src/js/ui/130-data-management.js'];

async function load(extra) {
    var s = U.stubs(), rec = U.recorder;
    var store = {};
    var g = Object.assign({
        document: document, DOMParser: DOMParser, navigator: { userAgent: 'ui-test' }, CSS: CSS,
        window: { document: document, _rawCopyStore: {}, innerWidth: 1000, innerHeight: 800, addEventListener: function() {}, removeEventListener: function() {},
            matchMedia: function() { return { matches: false, addEventListener: function() {} }; } },
        showSnackbar: s.showSnackbar, skills: {}, activeSkills: {}, skillTools: {}, currentEditingSkill: null,
        assets: {}, appStorage: { _d: store, setItem: rec(function(k, v) { store[k] = v; }), removeItem: rec(function(k) { delete store[k]; }), getItem: function(k) { return store[k]; } },
        isSkillDevHidden: function() { return false; },
        formatContent: function(t) { return '<p class="fmt">' + String(t).replace(/</g, '&lt;') + '</p>'; },
        pushHistoryState: rec(), replaceHistoryState: rec(), history: { state: null, length: 1, back: rec() },
        getActionId: function(s, n) { return s + '--' + String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-'); },
        toggleDropdown: rec(), closeDropdowns: rec(), renderAllActionPlacements: rec(),
        toolPermissions: {}, instancePermissions: {}, saveToolPermissions: rec(), saveInstancePermissions: rec(),
        hasNonDefaultPermissions: function() { return false; }, resetAllPermissionsToDefaults: rec(), updateSnStatus: rec(),
        Platform: { instanceUrl: 'https://dev1.service-now.com' }, TOOLS: [{ function: { name: 'web_fetch' } }],
        settingsPanelOpen: false, closeAllHeaderMenus: rec(), syncSettingsPanelTheme: rec(), loadGitHubSettings: function() { return Promise.resolve({}); }
    }, extra || {});
    g.getSkillAssets = function(id) { return Promise.resolve((g.assets[id] || []).slice()); };
    g.getSkillAsset = function(id, fn) { return Promise.resolve((g.assets[id] || []).filter(function(a) { return a.filename === fn; })[0] || null); };
    // Spy on the asset write; like 140-skills-engine it upserts one row per filename.
    g.saveSkillAsset = rec(function(id, filename, type, content) {
        var list = g.assets[id] = g.assets[id] || [];
        var row = { skillId: id, filename: filename, type: type, content: content };
        var i = list.findIndex(function(a) { return a.filename === filename; });
        if (i >= 0) list[i] = row; else list.push(row);
        return Promise.resolve();
    });
    g.saveSkill = rec(function(sk) { g.skills[sk.id] = sk; return Promise.resolve(); });
    var m = await loadModules(FILES, { workspace: WS, globals: g, lenient: true, passthrough: U.DOM_PASSTHROUGH });
    return { m: m, g: g, snack: s.showSnackbar };
}
function body() { return U.mountDom({ body: true }); }
function skillFixture() {
    return { id: 'sk1', name: 'demo-skill', description: 'Demo skill', body: 'Old body',
        actions: [{ name: 'Run Audit', icon: 'shield', show: ['home'] }, { name: 'Quick Check', icon: 'search', show: ['home', 'chat'] }] };
}
function isSkillMd(name) { return String(name || '').toLowerCase() === 'skill.md'; }
function skillMdCalls(spy) { return spy.calls.filter(function(c) { return isSkillMd(c[1]); }); }
function lastSnack(L) { return L.snack.calls[L.snack.calls.length - 1]; }

describe('rg-b10 › NEW-F15-1 virtual SKILL.md is never stored as an asset', function() {
    afterEach(function() { U.cleanupAll(); });

    test('saving the SKILL.md card updates the skill (actions round-trip) and stores no SKILL.md asset', async function() {
        var sk = skillFixture(), actionsBefore = JSON.parse(JSON.stringify(sk.actions));
        var L = await load({ skills: { sk1: sk }, currentEditingSkill: 'sk1' }), dom = await body();
        L.m.viewSkillMd();
        L.m.toggleAssetEditMode();
        var ta = dom.$('#asset-edit-textarea');
        assert.ok(ta, 'edit mode renders the textarea');
        assert.strictEqual(ta.value, L.m.skillToMarkdown(sk), 'the editor starts from the virtual SKILL.md');
        ta.value = ta.value.replace('Old body', 'New body');
        await L.m.saveAssetEdit();
        assert.deepStrictEqual(skillMdCalls(L.g.saveSkillAsset), [], 'saveSkillAsset is never called with SKILL.md');
        assert.deepStrictEqual(L.g.assets.sk1 || [], [], 'no stored SKILL.md copy');
        var saved = L.g.skills.sk1;
        assert.strictEqual(saved.body, 'New body', 'body updated');
        assert.deepStrictEqual(saved.actions, actionsBefore, 'actions round-trip unchanged');
        assert.strictEqual(L.g.saveSkill.calls.length, 1, 'skill saved once');
        assert.deepStrictEqual(lastSnack(L), ['Skill updated', 'success']);
        assert.strictEqual(dom.$('#asset-edit-textarea'), null, 'modal back in view mode');
        assert.match(dom.$('#modal-body').textContent, /New body/);
        L.m.viewSkillMd();
        L.m.toggleAssetEditMode();
        assert.strictEqual(dom.$('#asset-edit-textarea').value, L.m.skillToMarkdown(saved), 're-open shows the live skill');
    }, { tags: ['unit'] });

    test('saving SKILL.md after the skill vanished reports it and stores nothing', async function() {
        var sk = skillFixture();
        var L = await load({ skills: { sk1: sk }, currentEditingSkill: 'sk1' }), dom = await body();
        L.m.viewSkillMd();
        L.m.toggleAssetEditMode();
        dom.$('#asset-edit-textarea').value = L.m.skillToMarkdown(sk).replace('Old body', 'Orphan body');
        delete L.g.skills.sk1;
        await L.m.saveAssetEdit();
        assert.deepStrictEqual(skillMdCalls(L.g.saveSkillAsset), [], 'no orphan SKILL.md asset');
        assert.strictEqual(L.g.saveSkill.calls.length, 0, 'nothing to save');
        assert.deepStrictEqual(lastSnack(L), ['Skill not found', 'error']);
    }, { tags: ['unit'] });

    test('saving a regular asset still stores it', async function() {
        var L = await load({ skills: { sk1: skillFixture() }, currentEditingSkill: 'sk1', assets: { sk1: [{ filename: 'notes.md', type: 'md', content: 'n' }] } });
        var dom = await body();
        await L.m.viewSkillAsset('notes.md');
        L.m.toggleAssetEditMode();
        dom.$('#asset-edit-textarea').value = 'n2';
        await L.m.saveAssetEdit();
        assert.deepStrictEqual(L.g.saveSkillAsset.calls, [['sk1', 'notes.md', 'md', 'n2']]);
        assert.strictEqual(L.g.saveSkill.calls.length, 0);
        assert.deepStrictEqual(lastSnack(L), ['File saved', 'success']);
    }, { tags: ['unit'] });

    test('renderSkillAssets shows exactly one (virtual) SKILL.md card despite legacy stored copies', async function() {
        var L = await load({ skills: { sk1: skillFixture() }, currentEditingSkill: 'sk1', assets: { sk1: [
            { filename: 'SKILL.md', type: 'md', content: 'STALE' }, { filename: 'notes.md', type: 'md', content: 'n' },
            { filename: 'skill.md', type: 'md', content: 'STALE2' }, { filename: 'tool.js', type: 'js', content: 'x' }] } });
        var dom = await body();
        await L.m.renderSkillAssets();
        var names = dom.$$('#skill-assets-list .sn-artifact-name').map(function(n) { return n.textContent; });
        assert.deepStrictEqual(names, ['SKILL.md', 'notes.md', 'tool.js']);
        var cards = dom.$$('#skill-assets-list .sn-artifact-card');
        assert.strictEqual(cards[0].getAttribute('onclick'), 'viewSkillMd()', 'the only SKILL.md card is the virtual one');
        assert.ok(!cards.some(function(c) { return /viewSkillAsset\('skill\.md'\)/i.test(c.getAttribute('onclick') || ''); }), 'no stored-copy card');
    }, { tags: ['unit'] });

    test('_writeSkillToDir writes SKILL.md once, from the live skill', async function() {
        var sk = skillFixture();
        var L = await load({ skills: { sk1: sk }, currentEditingSkill: 'sk1', assets: { sk1: [
            { filename: 'SKILL.md', type: 'md', content: 'STALE' }, { filename: 'notes.md', type: 'md', content: 'n' }] } });
        var writes = [], dirs = [];
        var skillDir = { getFileHandle: function(name) { return Promise.resolve({ createWritable: function() {
            return Promise.resolve({ write: function(c) { writes.push([name, c]); return Promise.resolve(); }, close: function() { return Promise.resolve(); } }); } }); } };
        var parent = { getDirectoryHandle: function(name) { dirs.push(name); return Promise.resolve(skillDir); } };
        await L.m._writeSkillToDir(sk, parent);
        assert.deepStrictEqual(dirs, ['sk1']);
        var md = writes.filter(function(w) { return isSkillMd(w[0]); });
        assert.strictEqual(md.length, 1, 'SKILL.md written once');
        assert.strictEqual(md[0][1], L.m.skillToMarkdown(sk), 'with the live skillToMarkdown content');
        assert.deepStrictEqual(writes.filter(function(w) { return !isSkillMd(w[0]); }), [['notes.md', 'n']]);
    }, { tags: ['unit'] });
});

// NEW-T16-1: the Delete confirm names the skill. The message is parsed as HTML
// (sanitizeModalMessage), so the name is escaped.
describe('rg-b10 › NEW-T16-1 the delete confirm names the skill', function() {
    afterEach(function() { U.cleanupAll(); });
    function cancelConfirm() { return U.recorder(function() { return Promise.resolve(false); }); }
    function noopDelete() { return U.recorder(function() { return Promise.resolve(); }); }

    test('the message names the skill HTML-escaped; Cancel deletes nothing', async function() {
        var confirm = cancelConfirm(), del = noopDelete();
        var L = await load({ skills: { zz: { id: 'zz', name: 'ZZ <b>&' } }, currentEditingSkill: 'zz', showConfirmModal: confirm, deleteSkill: del });
        await body();
        await L.m.deleteCurrentSkill();
        assert.strictEqual(confirm.calls.length, 1);
        var c = confirm.calls[0];
        assert.strictEqual(c[0], 'Delete Skill');
        assert.ok(c[1].indexOf('ZZ &lt;b&gt;&amp;') >= 0, 'escaped name in: ' + c[1]);
        assert.ok(c[1].indexOf('<b>') < 0, 'no raw markup');
        assert.strictEqual(c[1], 'Delete "ZZ &lt;b&gt;&amp;"? This cannot be undone.');
        assert.strictEqual(c[2], 'danger');
        assert.strictEqual(del.calls.length, 0, 'Cancel deletes nothing');
    }, { tags: ['unit'] });

    test('a nameless (or missing) skill is named by its id', async function() {
        var confirm = cancelConfirm(), del = noopDelete();
        var L = await load({ skills: { 'zz-id': { id: 'zz-id' } }, currentEditingSkill: 'zz-id', showConfirmModal: confirm, deleteSkill: del });
        await body();
        await L.m.deleteCurrentSkill();
        assert.strictEqual(confirm.calls[0][1], 'Delete "zz-id"? This cannot be undone.');
        var confirm2 = cancelConfirm();
        var L2 = await load({ skills: {}, currentEditingSkill: 'ghost', showConfirmModal: confirm2, deleteSkill: del });
        await L2.m.deleteCurrentSkill();
        assert.strictEqual(confirm2.calls[0][1], 'Delete "ghost"? This cannot be undone.');
        assert.strictEqual(del.calls.length, 0);
    }, { tags: ['unit'] });

    test('Confirm still deletes the current skill and closes the editor', async function() {
        var g = { skills: { zz: { id: 'zz', name: 'zz' } }, currentEditingSkill: 'zz', showConfirmModal: U.recorder(function() { return Promise.resolve(true); }) };
        g.deleteSkill = U.recorder(function(id) { delete g.skills[id]; return Promise.resolve(); });
        var L = await load(g);
        await body();
        await L.m.deleteCurrentSkill();
        assert.deepStrictEqual(g.deleteSkill.calls, [['zz']]);
        assert.deepStrictEqual(lastSnack(L), ['Skill deleted', 'success']);
        assert.strictEqual(L.m.__scope.currentEditingSkill, null, 'editor closed');
        assert.deepStrictEqual(L.g.replaceHistoryState.calls[0], ['skills', null, null]);
    }, { tags: ['unit'] });
});

// NEW-T23-2: Unpin from the pin menu (pinWidgetTo(id, 'none')) confirms with a toast,
// like pin, move and the dashboard Remove path do. REAL 070 (+ the render deps that
// ui-smart-docs-widgets loads with it); the IndexedDB delete, pin buttons, home
// section and version sidebar are stubs, and showSnackbar is the spy.
describe('rg-b10 › NEW-T23-2 unpin from the pin menu confirms with a toast', function() {
    afterEach(function() { U.cleanupAll(); });
    var DASH_FILES = ['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/core/135-widget-store.js',
        'src/js/ui/070-dashboard-ui.js', 'src/js/tools/080-widget-tools.js'];
    async function loadDash(dash) {
        var s = U.stubs(), rec = U.recorder;
        var win = { document: document, _rawCopyStore: {}, addEventListener: function() {}, removeEventListener: function() {}, open: function() { return null; } };
        var m = await U.loadUi(DASH_FILES, { window: win, globals: { chats: { c1: { id: 'c1', widgets: [], messages: [] } }, currentChatId: 'c1',
            chatWidgets: {}, dashboardWidgets: dash, dbName: 'uitest', BroadcastChannel: undefined, expandedWidgetId: null,
            saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar, chrome: s.chrome } });
        var sc = m.__scope;
        sc.deleteDashboardWidget = rec(function(id) { delete sc.dashboardWidgets[id]; return Promise.resolve(); });
        sc.updateWidgetPinButtons = rec(); sc.renderVersionSidebar = rec(); sc.renderHomeDashboard = rec();
        sc.widgetDashboardOf = function(w) { return (w && w.dashboard === 'home') ? 'home' : 'main'; }; // = ui/020-dashboard.js widgetDashboardOf
        sc.dashboardWidgetsFor = function() { return []; };
        sc.dashboardGridEl = function() { return null; };
        return { m: m, sc: sc, snack: s.showSnackbar };
    }

    test('pinWidgetTo(id, "none") toasts exactly once (Home / dashboard); a not-pinned id toasts nothing', async function() {
        var h = await loadDash({ w: { id: 'w', dashboard: 'home' } });
        await h.m.pinWidgetTo('w', 'none');
        assert.deepStrictEqual(h.snack.calls, [['Removed from Home', 'success']]);
        assert.deepStrictEqual(h.sc.deleteDashboardWidget.calls, [['w']]);
        assert.strictEqual(h.sc.dashboardWidgets.w, undefined, 'unpinned');
        var d = await loadDash({ w: { id: 'w', dashboard: 'main' } });
        await d.m.pinWidgetTo('w', 'none');
        assert.deepStrictEqual(d.snack.calls, [['Removed from dashboard', 'success']]);
        var n = await loadDash({});
        await n.m.pinWidgetTo('nope', 'none');
        assert.deepStrictEqual(n.snack.calls, [], 'not pinned: no toast');
    }, { tags: ['unit'], timeout: 5000 });

    test('removeWidgetFromDashboard itself stays silent (Remove and the agent unpin path must not double-toast)', async function() {
        var h = await loadDash({ w: { id: 'w', dashboard: 'home' } });
        await h.m.removeWidgetFromDashboard('w');
        assert.deepStrictEqual(h.sc.deleteDashboardWidget.calls, [['w']]);
        assert.deepStrictEqual(h.snack.calls, []);
    }, { tags: ['unit'], timeout: 5000 });
});

// NEW-T14-1: the jobs dropdown's Active/History tabs are real ARIA tabs. The
// .jobs-tabs row already is role=tablist, but the buttons carried the selection
// only in the .active class. Now: type=button + role=tab + aria-selected, panels
// role=tabpanel, and switchJobsTab keeps aria-selected in step with .active
// (which renderJobsDropdown reads back, tools/120-actions.js:3075). No static
// ids/aria-controls: one renderer feeds #jobs-dropdown AND #home-jobs-dropdown.
describe('rg-b10 › NEW-T14-1 jobs Active/History tabs expose ARIA tab semantics', function() {
    var mount = null;
    afterEach(function() { if (mount) { mount.cleanup(); mount = null; } });
    function loadJobs() {
        return load({ chats: {}, activeActions: {}, AgentEvents: { emit: function() {} }, currentChatId: 'other', currentView: 'home',
            runningChatIds: {}, saveChatsToStorage: function() {} });
    }
    function tabState(root) {
        return Array.prototype.map.call(root.querySelectorAll('.jobs-tab'), function(b) {
            return [b.getAttribute('data-tab'), b.getAttribute('type'), b.getAttribute('role'), b.getAttribute('aria-selected'), b.classList.contains('active')];
        });
    }
    var DONE_SELECTED = [['active', 'button', 'tab', 'false', false], ['done', 'button', 'tab', 'true', true]];
    var ACTIVE_SELECTED = [['active', 'button', 'tab', 'true', true], ['done', 'button', 'tab', 'false', false]];

    test('_renderJobsChatTabs marks both tabs, the selected one and both panels', async function() {
        var L = await loadJobs();
        var root = U.frag(L.m._renderJobsChatTabs('<div class="jobs-row">r</div>', 1, 'done'));
        assert.strictEqual(root.querySelector('.jobs-tabs').getAttribute('role'), 'tablist');
        assert.deepStrictEqual(tabState(root), DONE_SELECTED);
        assert.deepStrictEqual(Array.prototype.map.call(root.querySelectorAll('.jobs-tab-panel'), function(p) {
            return [p.getAttribute('data-tab-panel'), p.getAttribute('role')];
        }), [['active', 'tabpanel'], ['done', 'tabpanel']]);
        assert.strictEqual(root.querySelectorAll('[role="tab"]').length, 2, 'Expand is not a tab');
        assert.strictEqual(root.querySelectorAll('.jobs-tab[id], .jobs-tab-panel[id], .jobs-tab[aria-controls]').length, 0,
            'no static ids: two dropdowns share this markup');
    }, { tags: ['unit'], timeout: 5000 });

    test('switchJobsTab flips aria-selected together with .active (and ignores unknown tabs)', async function() {
        var L = await loadJobs();
        U.cleanupAll();
        mount = await U.mountDom({ html: '<div class="jobs-dropdown" style="display:block"></div>' });
        var dd = mount.root.querySelector('.jobs-dropdown');
        dd.innerHTML = L.m._renderJobsChatTabs('<div class="jobs-row">r</div>', 1, 'done');
        L.m.switchJobsTab('active');
        assert.deepStrictEqual(tabState(dd), ACTIVE_SELECTED);
        assert.strictEqual(dd.querySelector('.jobs-tab.active').getAttribute('data-tab'), 'active', 'renderJobsDropdown reads .jobs-tab.active');
        L.m.switchJobsTab('done');
        assert.deepStrictEqual(tabState(dd), DONE_SELECTED);
        L.m.switchJobsTab('bogus');
        assert.deepStrictEqual(tabState(dd), DONE_SELECTED, 'unknown tab: no change');
    }, { tags: ['unit'], timeout: 5000 });
});
