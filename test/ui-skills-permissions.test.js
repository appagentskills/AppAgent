// UI tests — Skills view/editor (list, editor open/save/cancel, action rows,
// SKILL.md round-trip through the editor), permission radios, the instance
// tier toggle (Manual/Auto/Dev) in both the header list and Settings, and the
// header settings panel open/close. REAL src modules (loadModules, lenient),
// REAL body.html markup, REAL inline handlers via U.fireInline / fireKey.
// Run: run_tests { files: ['test/canary.test.js', 'test/ui-skills-permissions.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/060-ui-constants.js', 'src/js/core/070-permissions.js', 'src/js/ui/180-search.js', 'src/js/tools/120-actions.js',
    'src/js/core/120-init.js', 'src/js/ui/010-skills-ui.js', 'src/js/ui/140-dropdowns.js', 'src/js/ui/040-tools-settings.js', 'src/js/ui/130-data-management.js'];
var HOSTILE = '<img src=x onerror="window.__pwn=1">';
var HOST = 'dev1.service-now.com';

// U.fireInline builds a plain Event (event.key undefined) — keydown handlers
// need a real KeyboardEvent (same local helper as ui-settings.test.js).
function fireKey(el, k, m) {
    var code = el.getAttribute('onkeydown'), ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    var scope = new Proxy({}, { has: function(t, n) { return typeof n === 'string' && n !== 'event' && ((n in m) || (n in m.__scope)); },
        get: function(t, n) { return (n in m) ? m[n] : m.__scope[n]; }, set: function(t, n, v) { m.__scope[n] = v; return true; } });
    new Function('__s', 'event', 'with (__s) { ' + code + ' }').call(el, scope, ev);
}

async function load(extra) {
    var s = U.stubs(), rec = U.recorder;
    var store = {};
    var g = Object.assign({
        document: document, DOMParser: DOMParser, navigator: { userAgent: 'ui-test' }, CSS: CSS,
        window: { document: document, _rawCopyStore: {}, innerWidth: 1000, innerHeight: 800, addEventListener: function() {}, removeEventListener: function() {},
            matchMedia: function() { return { matches: false, addEventListener: function() {} }; } },
        showSnackbar: s.showSnackbar, skills: {}, activeSkills: {}, skillTools: {}, currentEditingSkill: null,
        assets: {}, appStorage: { _d: store, setItem: rec(function(k, v) { store[k] = v; }), removeItem: rec(function(k) { delete store[k]; }), getItem: function(k) { return store[k]; } },
        isSkillDevHidden: function(id) { return id === 'dev-only'; },
        formatContent: function(t) { return '<p class="fmt">' + String(t).replace(/</g, '&lt;') + '</p>'; },
        pushHistoryState: rec(), replaceHistoryState: rec(), history: { state: null, length: 1, back: rec() },
        getActionId: function(s, n) { return s + '--' + String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-'); },
        toggleDropdown: rec(), closeDropdowns: rec(), renderAllActionPlacements: rec(),
        showConfirmModal: rec(function() { return Promise.resolve(true); }), // NEW-T17-1: a dirty Back asks; default = Discard
        toolPermissions: {}, instancePermissions: {}, saveToolPermissions: rec(), saveInstancePermissions: rec(),
        hasNonDefaultPermissions: function() { return false; }, resetAllPermissionsToDefaults: rec(), updateSnStatus: rec(),
        Platform: { instanceUrl: 'https://' + HOST }, TOOLS: [{ function: { name: 'web_fetch' } }],
        settingsPanelOpen: false, closeAllHeaderMenus: rec(), syncSettingsPanelTheme: rec(), loadGitHubSettings: function() { return Promise.resolve({}); }
    }, extra || {});
    g.getSkillAssets = g.getSkillAssets || function(id) { return Promise.resolve(g.assets[id] || []); };
    g.saveSkill = g.saveSkill || rec(function(sk) { g.skills[sk.id] = sk; return Promise.resolve(); });
    var m = await loadModules(FILES, { workspace: WS, globals: g, lenient: true, passthrough: U.DOM_PASSTHROUGH });
    return { m: m, g: g, snack: s.showSnackbar };
}
function sc(L, n) { return L.m.__scope[n]; }
// innerHTML re-serializes SVG, so compare icons after one DOM round trip.
function norm(html) { var d = document.createElement('div'); d.innerHTML = html; return d.innerHTML; }
function body() { return U.mountDom({ body: true }); }

describe('ui skills › renderSkillsList', function() {
    afterEach(function() { U.cleanupAll(); });
    test('empty state when no (visible) skills', async function() {
        var L = await load({ skills: { 'dev-only': { id: 'dev-only', name: 'hidden' } } }), dom = await body();
        await L.m.renderSkillsList();
        var list = dom.$('#skills-list');
        assert.ok(list.querySelector('.skills-empty'), 'empty block');
        assert.match(list.textContent, /No skills yet/);
        assert.strictEqual(list.querySelectorAll('.skill-item').length, 0, 'devOnly skill never listed');
    }, { tags: ['unit'] });
    test('sorted rows, badges (Built-in / Edited / Active), description, attachments, escaping, a11y', async function() {
        var L = await load({
            skills: {
                zed: { id: 'zed', name: 'zed', description: 'last' },
                oob: { id: 'oob', name: 'audit', description: 'd ' + HOSTILE, embeddedHash: 'h', userModified: true },
                x: { id: "it's", name: HOSTILE },
                'dev-only': { id: 'dev-only', name: 'aaa' }
            },
            activeSkills: { zed: {} },
            assets: { oob: [{ filename: 'tool".js', type: 'js' }, { filename: 'data.xml', type: 'xml' }] }
        }), dom = await body();
        await L.m.renderSkillsList();
        var items = dom.$$('#skills-list .skill-item');
        assert.deepStrictEqual(items.map(function(i) { return i.querySelector('.skill-item-title').textContent; }), [HOSTILE, 'audit', 'zed']);
        assert.strictEqual(dom.$('#skills-list img'), null, 'no injected element');
        assert.ok(items[2].classList.contains('skill-item-active'));
        assert.strictEqual(items[2].querySelector('.skill-active-badge').textContent, 'Active');
        assert.strictEqual(items[1].querySelector('.skill-oob-badge').textContent, 'Built-in');
        assert.strictEqual(items[1].querySelector('.skill-edited-badge').textContent, 'Edited');
        assert.strictEqual(items[0].querySelector('.skill-item-badges'), null, 'no badge wrapper without badges');
        assert.strictEqual(items[1].querySelector('.skill-item-desc').textContent, 'd ' + HOSTILE);
        var att = items[1].querySelectorAll('.skill-attachment-badge');
        assert.strictEqual(att.length, 2);
        assert.ok(att[0].classList.contains('js')); assert.ok(att[1].classList.contains('xml'));
        assert.strictEqual(att[0].getAttribute('title'), 'tool".js');
        var a = U.a11y(items[1]);
        assert.strictEqual(a.role, 'button'); assert.strictEqual(a.tabindex, '0'); assert.strictEqual(a.aria.label, 'Edit skill: audit');
    }, { tags: ['unit'] });
    test('row click / Enter / Space open the editor for that id (quote-safe); other keys do nothing', async function() {
        var L = await load({ skills: { "it's": { id: "it's", name: 'q', description: 'dq' } } }), dom = await body();
        await L.m.renderSkillsList();
        var row = dom.$('#skills-list .skill-item');
        fireKey(row, 'a', L.m); await U.flush();
        assert.strictEqual(sc(L, 'currentEditingSkill'), null, 'non-activation key ignored');
        fireKey(row, 'Enter', L.m); await U.flush();
        assert.strictEqual(sc(L, 'currentEditingSkill'), "it's");
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'flex');
        L.g.currentEditingSkill = null; L.m.__scope.currentEditingSkill = null;
        fireKey(row, ' ', L.m); await U.flush();
        assert.strictEqual(sc(L, 'currentEditingSkill'), "it's");
        L.m.__scope.currentEditingSkill = null;
        U.fireInline(row, 'click', L.m); await U.flush();
        assert.strictEqual(sc(L, 'currentEditingSkill'), "it's");
        assert.strictEqual(dom.$('#skill-name-input').value, 'q');
    }, { tags: ['unit'] });
});

describe('ui skills › editor open / save / cancel', function() {
    afterEach(function() { U.cleanupAll(); });
    function one() { return { a1: { id: 'a1', name: 'alpha', description: 'first', body: '# Title\nhello', actions: [{ name: 'Run', icon: 'rocket', show: ['home', 'chat'] }] } }; }
    test('open existing: fields, buttons, rendered body view, SKILL.md card, persisted view + history push', async function() {
        var L = await load({ skills: one() }), dom = await body();
        await L.m.openSkillEditor('a1');
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'flex');
        assert.strictEqual(dom.$('#skills-list-panel').style.display, 'none');
        assert.strictEqual(dom.$('#skill-editor-title').textContent, 'Edit Skill');
        assert.strictEqual(dom.$('#skill-name-input').value, 'alpha');
        assert.strictEqual(dom.$('#skill-description-input').value, 'first');
        assert.strictEqual(dom.$('#skill-body-input').value, '# Title\nhello');
        ['#skill-delete-btn', '#skill-activate-btn', '#skill-download-btn'].forEach(function(s) { assert.strictEqual(dom.$(s).style.display, 'inline-flex', s); });
        assert.match(dom.$('#skill-activate-btn').textContent, /Activate/);
        assert.strictEqual(dom.$('#skill-body-input').style.display, 'none');
        assert.ok(dom.$('#skill-body-view .markdown-body .fmt'), 'view mode renders formatted body');
        assert.strictEqual(dom.$('#skill-assets-list .sn-artifact-name').textContent, 'SKILL.md');
        assert.strictEqual(L.g.appStorage._d.currentView, 'skill-editor');
        assert.strictEqual(L.g.appStorage._d.currentEditingSkill, 'a1');
        assert.deepStrictEqual(L.g.pushHistoryState.calls[0], ['skill-editor', null, 'a1']);
    }, { tags: ['unit'] });
    test('open new: blank form, destructive/activate buttons hidden, empty actions + body placeholder', async function() {
        var L = await load({ skills: one() }), dom = await body();
        await L.m.openSkillEditor(null);
        assert.strictEqual(dom.$('#skill-editor-title').textContent, 'New Skill');
        assert.strictEqual(dom.$('#skill-name-input').value, '');
        assert.strictEqual(dom.$('#skill-delete-btn').style.display, 'none');
        assert.strictEqual(dom.$('#skill-activate-btn').style.display, 'none');
        assert.match(dom.$('#skill-actions-list').textContent, /No actions yet/);
        assert.match(dom.$('#skill-body-view').textContent, /No content yet/);
        assert.strictEqual(L.g.pushHistoryState.calls.length, 0);
    }, { tags: ['unit'] });
    test('body Edit/View toggle button swaps textarea and rendered view', async function() {
        var L = await load({ skills: one() }), dom = await body();
        await L.m.openSkillEditor('a1');
        var btn = dom.$('#skill-body-edit-btn');
        assert.strictEqual(btn.title, 'Edit');
        U.fireInline(btn, 'click', L.m);
        assert.strictEqual(dom.$('#skill-body-input').style.display, 'block');
        assert.strictEqual(dom.$('#skill-body-view').style.display, 'none');
        assert.strictEqual(btn.title, 'View');
        dom.$('#skill-body-input').value = 'changed';
        U.fireInline(btn, 'click', L.m);
        assert.strictEqual(dom.$('#skill-body-view').textContent, 'changed');
    }, { tags: ['unit'] });
    test('Save (real button): normalizes name, persists edits + actions, snackbar, returns to list', async function() {
        var L = await load({ skills: one() }), dom = await body();
        await L.m.openSkillEditor('a1');
        dom.$('#skill-name-input').value = '  My Skill!! ';
        dom.$('#skill-description-input').value = ' new desc ';
        dom.$('#skill-body-input').value = 'body2';
        var save = dom.$$('button').filter(function(b) { return b.getAttribute('onclick') === 'saveCurrentSkill()'; })[0];
        await U.fireInline(save, 'click', L.m).result; await U.flush();
        assert.strictEqual(L.g.saveSkill.calls.length, 1);
        var sk = L.g.saveSkill.calls[0][0];
        assert.strictEqual(sk.id, 'a1', 'edits the existing record');
        assert.strictEqual(sk.name, 'my-skill');
        assert.strictEqual(sk.description, 'new desc');
        assert.strictEqual(sk.body, 'body2');
        assert.strictEqual(sk.userModified, true);
        assert.deepStrictEqual(sk.actions, [{ name: 'Run', icon: 'rocket', show: ['home', 'chat'] }], 'actions collected from rows');
        assert.deepStrictEqual(L.snack.calls[0], ['Skill saved', 'success', undefined, { key: 'skill-editor' }]);
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'none');
        assert.strictEqual(dom.$('#skills-list-panel').style.display, 'flex');
        assert.strictEqual(sc(L, 'currentEditingSkill'), null);
        await U.flush();
        assert.strictEqual(dom.$('#skills-list .skill-item-title').textContent, 'my-skill', 'list re-rendered');
    }, { tags: ['unit'] });
    test('Save validation: missing name / description → error snackbar, nothing persisted, editor stays', async function() {
        var L = await load({ skills: {} }), dom = await body();
        await L.m.openSkillEditor(null);
        await L.m.saveCurrentSkill();
        assert.deepStrictEqual(L.snack.calls[0], ['Name is required', 'error', undefined, { key: 'skill-editor' }]);
        dom.$('#skill-name-input').value = 'ok';
        await L.m.saveCurrentSkill();
        assert.deepStrictEqual(L.snack.calls[1], ['Description is required', 'error', undefined, { key: 'skill-editor' }]);
        assert.strictEqual(L.g.saveSkill.calls.length, 0);
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'flex');
    }, { tags: ['unit'] });
    test('Save new skill with a colliding id gets a -1 suffix', async function() {
        var L = await load({ skills: one() }), dom = await body();
        await L.m.openSkillEditor(null);
        dom.$('#skill-name-input').value = 'a1'; dom.$('#skill-description-input').value = 'd';
        await L.m.saveCurrentSkill();
        assert.strictEqual(L.g.saveSkill.calls[0][0].id, 'a1-1');
        assert.strictEqual(L.g.skills.a1.name, 'alpha', 'original untouched');
    }, { tags: ['unit'] });
    test('Back (real button) cancels: nothing saved, edits discarded, history replaced when not on a pushed entry', async function() {
        var L = await load({ skills: one() }), dom = await body();
        await L.m.openSkillEditor('a1');
        dom.$('#skill-name-input').value = 'mutated';
        var back = dom.$('.skills-back-btn');
        U.fireInline(back, 'click', L.m); await U.flush();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1, 'a dirty Back asks once (NEW-T17-1)');
        assert.strictEqual(L.g.showConfirmModal.calls[0][0], 'Discard changes?');
        assert.match(L.g.showConfirmModal.calls[0][1], /"alpha"/);
        assert.strictEqual(L.g.showConfirmModal.calls[0][2], 'warning');
        assert.strictEqual(L.g.saveSkill.calls.length, 0);
        assert.strictEqual(L.g.skills.a1.name, 'alpha');
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'none');
        assert.strictEqual(L.g.appStorage._d.currentView, 'skills');
        assert.ok(!('currentEditingSkill' in L.g.appStorage._d));
        assert.deepStrictEqual(L.g.replaceHistoryState.calls[0], ['skills', null, null]);
        assert.strictEqual(L.g.history.back.calls.length, 0);
    }, { tags: ['unit'] });
    test('Back pops history when standing on the pushed skill-editor entry', async function() {
        var L = await load({ skills: one(), history: { state: { view: 'skill-editor' }, length: 3, back: U.recorder() } }), dom = await body();
        await L.m.openSkillEditor('a1');
        L.m.closeSkillEditor();
        assert.strictEqual(L.g.history.back.calls.length, 1);
        assert.strictEqual(L.g.replaceHistoryState.calls.length, 0);
    }, { tags: ['unit'] });
    test('Activate button: activateSkill → success snackbar, label flips to Deactivate', async function() {
        var g = { skills: one(), activeSkills: {} };
        g.activateSkill = U.recorder(function(id) { g.activeSkills[id] = {}; return Promise.resolve({ success: true, message: 'Activated' }); });
        var L = await load(g), dom = await body();
        await L.m.openSkillEditor('a1');
        await U.fireInline(dom.$('#skill-activate-btn'), 'click', L.m).result;
        assert.deepStrictEqual(g.activateSkill.calls[0], ['a1']);
        assert.deepStrictEqual(L.snack.calls[0], ['Activated', 'success']);
        assert.match(dom.$('#skill-activate-btn').textContent, /Deactivate/);
        assert.strictEqual(dom.$('#skill-activate-btn').disabled, false);
    }, { tags: ['unit'] });
    test('Edit with Agent does not mark the previous chat seen (A5A3-01)', async function() {
        var rec = U.recorder;
        var L = await load({ skills: one(), currentChatId: 'X', chats: { X: {} }, currentView: 'skills', newChat: rec(), dispatchChatMeta: rec(),
            clearUnseenFinishedChat: rec(), pushFocusChatToOffscreen: rec(), autoResizeTextarea: rec(), updateDashboardButtonState: rec() });
        await body();
        await L.m.openSkillEditor('a1');
        L.m.editSkillWithAgent();
        assert.strictEqual(L.g.newChat.calls.length, 1);
        ['clearUnseenFinishedChat', 'dispatchChatMeta', 'pushFocusChatToOffscreen'].forEach(function(n) {
            assert.ok(!L.g[n].calls.some(function(c) { return c[0] === 'X'; }), n + ' must not touch the previous chat');
        });
    }, { tags: ['unit'] });
    // NEW-T17-1: Back (requestCloseSkillEditor) asks before it drops unsaved edits.
    function backBtn(dom) { return dom.$('.skills-back-btn'); }
    function editorRowNames(dom) { return dom.$$('.skill-action-row').map(function(r) { return r.querySelector('.skill-action-name').value; }); }
    function denyConfirm() { return U.recorder(function() { return Promise.resolve(false); }); }
    function assertKeptOpen(L, dom) {
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'flex', 'editor stays open');
        assert.strictEqual(sc(L, 'currentEditingSkill'), 'a1');
        assert.strictEqual(L.g.saveSkill.calls.length, 0, 'nothing saved');
        assert.strictEqual(L.g.history.back.calls.length, 0, 'no history.back');
        assert.strictEqual(L.g.replaceHistoryState.calls.length, 0, 'no history replace');
    }
    test('Back on a clean editor closes without asking (CRLF text, string/unordered placements) (NEW-T17-1)', async function() {
        var sk = one();
        sk.a1.description = 'first\r\nline';
        sk.a1.body = '# Title\r\nhello';
        sk.a1.actions = [{ name: 'Run', icon: 'nope', show: 'home chat' }, { name: '  Two  ', icon: 'bug', show: ['sidebar', 'home'] }];
        var L = await load({ skills: sk }), dom = await body();
        await L.m.openSkillEditor('a1');
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 0, 'clean Back never asks');
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'none');
        assert.strictEqual(sc(L, 'currentEditingSkill'), null);
        assert.deepStrictEqual(L.g.replaceHistoryState.calls[0], ['skills', null, null]);
    }, { tags: ['unit'] });
    test('Back with an unsaved description: Cancel keeps the editor and the typed text (NEW-T17-1)', async function() {
        var L = await load({ skills: one(), showConfirmModal: denyConfirm() }), dom = await body();
        await L.m.openSkillEditor('a1');
        dom.$('#skill-description-input').value = 'edited desc';
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1, 'dirty Back asks');
        assertKeptOpen(L, dom);
        assert.strictEqual(dom.$('#skill-description-input').value, 'edited desc', 'typed text kept');
        assert.strictEqual(dom.$('#skill-name-input').value, 'alpha');
        assert.strictEqual(L.g.skills.a1.description, 'first', 'skills[] untouched');
    }, { tags: ['unit'] });
    test('Back with a renamed action row: Cancel keeps the rows and the draft (NEW-T17-1)', async function() {
        var L = await load({ skills: one(), showConfirmModal: denyConfirm() }), dom = await body();
        await L.m.openSkillEditor('a1');
        var input = dom.$('.skill-action-row[data-action-index="0"] .skill-action-name');
        input.value = 'Renamed'; U.fireInline(input, 'input', L.m);
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1, 'a row edit alone makes Back ask');
        assertKeptOpen(L, dom);
        assert.deepStrictEqual(editorRowNames(dom), ['Renamed'], 'row kept');
        assert.strictEqual(L.m.getSkillActionsDraft()[0].name, 'Renamed', 'draft kept');
        assert.strictEqual(L.g.skills.a1.actions[0].name, 'Run', 'skills[] untouched');
    }, { tags: ['unit'] });
    test('new skill: a blank form closes silently, a typed name asks first (NEW-T17-1)', async function() {
        var L = await load({ skills: one(), showConfirmModal: denyConfirm() }), dom = await body();
        await L.m.openSkillEditor(null);
        dom.$('#skill-name-input').value = '   ';
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 0, 'a blank (whitespace-only) form never asks');
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'none');
        await L.m.openSkillEditor(null);
        dom.$('#skill-name-input').value = 'draft-skill';
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1, 'a typed name asks');
        assert.match(L.g.showConfirmModal.calls[0][1], /"this new skill"/);
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'flex', 'Cancel keeps the form');
        assert.strictEqual(dom.$('#skill-name-input').value, 'draft-skill');
        assert.strictEqual(L.g.saveSkill.calls.length, 0);
    }, { tags: ['unit'] });
    test('the discard confirm names the skill HTML-escaped (NEW-T17-1)', async function() {
        var L = await load({ skills: { zz: { id: 'zz', name: 'ZZ <b>&', description: 'd', body: 'b' } }, showConfirmModal: denyConfirm() }), dom = await body();
        await L.m.openSkillEditor('zz');
        dom.$('#skill-body-input').value = 'changed';
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1);
        var c = L.g.showConfirmModal.calls[0];
        assert.strictEqual(c[0], 'Discard changes?');
        assert.strictEqual(c[1], 'Unsaved edits to "ZZ &lt;b&gt;&amp;" will be lost.');
        assert.ok(c[1].indexOf('<b>') < 0, 'no raw markup');
        assert.strictEqual(c[2], 'warning');
    }, { tags: ['unit'] });
    test('Save and Delete close without the discard confirm (NEW-T17-1)', async function() {
        var g = { skills: one() };
        g.deleteSkill = U.recorder(function(id) { delete g.skills[id]; return Promise.resolve(); });
        var L = await load(g), dom = await body();
        await L.m.openSkillEditor('a1');
        dom.$('#skill-name-input').value = '  My Skill!! ';
        var save = dom.$$('button').filter(function(b) { return b.getAttribute('onclick') === 'saveCurrentSkill()'; })[0];
        await U.fireInline(save, 'click', L.m).result; await U.flush();
        assert.strictEqual(L.g.saveSkill.calls.length, 1);
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'none', 'Save closes');
        assert.strictEqual(L.g.showConfirmModal.calls.length, 0, 'Save never asks to discard');
        await L.m.openSkillEditor('a1');
        dom.$('#skill-description-input').value = 'unsaved before delete';
        await U.fireInline(dom.$('#skill-delete-btn'), 'click', L.m).result; await U.flush();
        assert.deepStrictEqual(L.g.showConfirmModal.calls.map(function(c) { return c[0]; }), ['Delete Skill'], 'only the delete confirm');
        assert.deepStrictEqual(g.deleteSkill.calls, [['a1']]);
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'none', 'Delete closes');
    }, { tags: ['unit'] });
    test('the Back button is wired to requestCloseSkillEditor() (NEW-T17-1)', async function() {
        var dom = await body();
        assert.strictEqual(dom.$('.skills-back-btn').getAttribute('onclick'), 'requestCloseSkillEditor()');
    }, { tags: ['unit'] });
    test('a 2nd Back click while the confirm is pending asks once; a stale confirm never closes another skill (NEW-T17-1)', async function() {
        var pending = { resolve: null }, sk = one();
        var confirm = U.recorder(function() { return new Promise(function(r) { pending.resolve = r; }); });
        sk.b2 = { id: 'b2', name: 'beta', description: 'second', body: '' };
        var L = await load({ skills: sk, showConfirmModal: confirm }), dom = await body();
        await L.m.openSkillEditor('a1');
        dom.$('#skill-body-input').value = 'changed';
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        assert.strictEqual(confirm.calls.length, 1, 'one confirm while pending');
        pending.resolve(true); await U.flush();
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'none', 'Discard closes');
        assert.strictEqual(sc(L, 'currentEditingSkill'), null);
        assert.strictEqual(L.g.replaceHistoryState.calls.length, 1, 'closed once');
        await L.m.openSkillEditor('a1');
        dom.$('#skill-body-input').value = 'changed again';
        U.fireInline(backBtn(dom), 'click', L.m); await U.flush();
        assert.strictEqual(confirm.calls.length, 2, 'the guard resets once the confirm settled');
        await L.m.openSkillEditor('b2');
        pending.resolve(true); await U.flush();
        assert.strictEqual(sc(L, 'currentEditingSkill'), 'b2', 'the other skill stays open');
        assert.strictEqual(dom.$('#skill-editor-panel').style.display, 'flex');
        assert.strictEqual(L.g.replaceHistoryState.calls.length, 1, 'no second close');
    }, { tags: ['unit'] });
});

describe('ui skills › action rows', function() {
    afterEach(function() { U.cleanupAll(); });
    function withActions() { return { s: { id: 's', name: 's', description: 'd', actions: [{ name: 'A ' + HOSTILE, icon: 'bug', show: ['home'] }, { name: 'B', icon: 'nope', show: ['chat', 'sidebar'] }] } }; }
    test('rows render name (escaped), icon, placement pills with aria-pressed', async function() {
        var L = await load({ skills: withActions() }), dom = await body();
        await L.m.openSkillEditor('s');
        var rows = dom.$$('#skill-actions-list .skill-action-row');
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].querySelector('.skill-action-name').value, 'A ' + HOSTILE);
        assert.strictEqual(dom.$('#skill-actions-list img'), null);
        assert.deepStrictEqual(rows[1].querySelectorAll('.skill-action-place-btn').length, 3);
        var pressed = function(r) { return [].map.call(r.querySelectorAll('.skill-action-place-btn'), function(b) { return b.getAttribute('data-placement') + '=' + b.getAttribute('aria-pressed'); }); };
        assert.deepStrictEqual(pressed(rows[0]), ['home=true', 'chat=false', 'sidebar=false']);
        assert.deepStrictEqual(pressed(rows[1]), ['home=false', 'chat=true', 'sidebar=true']);
        assert.strictEqual(rows[1].querySelector('.skill-action-preview').innerHTML, norm(L.m.UI_ICONS.play), 'unknown icon falls back to play');
    }, { tags: ['unit'] });
    test('placement pill toggles (multi-select) and refuses to clear the last one', async function() {
        var L = await load({ skills: withActions() }), dom = await body();
        await L.m.openSkillEditor('s');
        var row0 = dom.$('.skill-action-row[data-action-index="0"]');
        var home = row0.querySelector('[data-placement="home"]'), chat = row0.querySelector('[data-placement="chat"]');
        U.fireInline(home, 'click', L.m);
        assert.ok(home.classList.contains('selected'), 'last placement cannot be deselected');
        U.fireInline(chat, 'click', L.m);
        assert.strictEqual(chat.getAttribute('aria-pressed'), 'true');
        assert.deepStrictEqual(L.m.collectSkillActionsFromEditor()[0].show, ['home', 'chat'], 'editor rows synced');
        U.fireInline(home, 'click', L.m);
        assert.deepStrictEqual(L.m.collectSkillActionsFromEditor()[0].show, ['chat']);
    }, { tags: ['unit'] });
    test('name input, add (+), remove (✕), and max 8 guard', async function() {
        var L = await load({ skills: withActions() }), dom = await body();
        await L.m.openSkillEditor('s');
        var name1 = dom.$('.skill-action-row[data-action-index="1"] .skill-action-name');
        name1.value = 'Renamed';
        U.fireInline(name1, 'input', L.m);
        assert.strictEqual(L.m.collectSkillActionsFromEditor()[1].name, 'Renamed');
        var add = dom.$('.skill-actions-add-btn');
        U.fireInline(add, 'click', L.m);
        var rows = dom.$$('.skill-action-row');
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[2].querySelector('.skill-action-name').value, 'New Action');
        U.fireInline(rows[0].querySelector('.skill-action-remove'), 'click', L.m);
        rows = dom.$$('.skill-action-row');
        assert.deepStrictEqual(rows.map(function(r) { return r.querySelector('.skill-action-name').value; }), ['Renamed', 'New Action']);
        for (var i = 0; i < 6; i++) U.fireInline(dom.$('.skill-actions-add-btn'), 'click', L.m);
        assert.strictEqual(dom.$$('.skill-action-row').length, 8);
        U.fireInline(dom.$('.skill-actions-add-btn'), 'click', L.m);
        assert.strictEqual(dom.$$('.skill-action-row').length, 8);
        assert.deepStrictEqual(L.snack.calls[L.snack.calls.length - 1], ['Max 8 actions per skill', 'error', undefined, { key: 'skill-editor' }]);
    }, { tags: ['unit'] });
    test('add on an unsaved skill → "Save the skill first"', async function() {
        var L = await load({ skills: {} }), dom = await body();
        await L.m.openSkillEditor(null);
        U.fireInline(dom.$('.skill-actions-add-btn'), 'click', L.m);
        assert.deepStrictEqual(L.snack.calls[0], ['Save the skill first', 'error', undefined, { key: 'skill-editor' }]);
        assert.strictEqual(dom.$$('.skill-action-row').length, 0);
    }, { tags: ['unit'] });
    test('icon picker: opens with current icon selected, choosing updates hidden input + preview; backdrop closes', async function() {
        var L = await load({ skills: withActions() }), dom = await body();
        await L.m.openSkillEditor('s');
        var row0 = dom.$('.skill-action-row[data-action-index="0"]');
        U.fireInline(row0.querySelector('.skill-action-icon-btn'), 'click', L.m);
        var host = document.getElementById('icon-picker-host');
        assert.ok(host, 'picker mounted');
        assert.strictEqual(host.querySelector('.icon-picker-item.selected').getAttribute('data-icon'), 'bug');
        U.fireInline(host.querySelector('[data-icon="rocket"]'), 'click', L.m);
        assert.strictEqual(document.getElementById('icon-picker-host'), null, 'closed after choose');
        assert.strictEqual(row0.querySelector('.skill-action-icon').value, 'rocket');
        assert.strictEqual(row0.querySelector('.skill-action-preview').innerHTML, norm(L.m.UI_ICONS.rocket));
        assert.strictEqual(L.m.collectSkillActionsFromEditor()[0].icon, 'rocket');
        U.fireInline(row0.querySelector('.skill-action-icon-btn'), 'click', L.m);
        host = document.getElementById('icon-picker-host');
        var modal = host.querySelector('.icon-picker-modal');
        U.fireInline(host.querySelector('.icon-picker-backdrop'), 'click', L.m, { target: modal });
        assert.ok(document.getElementById('icon-picker-host'), 'click inside modal does not close');
        U.fireInline(host.querySelector('.icon-picker-backdrop'), 'click', L.m);
        assert.strictEqual(document.getElementById('icon-picker-host'), null, 'backdrop click closes');
    }, { tags: ['unit'] });
    function rowNames(dom) { return dom.$$('.skill-action-row').map(function(r) { return r.querySelector('.skill-action-name').value; }); }
    function pickIcon(dom, L, index, icon) {
        U.fireInline(dom.$('.skill-action-row[data-action-index="' + index + '"] .skill-action-icon-btn'), 'click', L.m);
        U.fireInline(document.getElementById('icon-picker-host').querySelector('[data-icon="' + icon + '"]'), 'click', L.m);
    }
    function rename(dom, L, index, value) {
        var input = dom.$('.skill-action-row[data-action-index="' + index + '"] .skill-action-name');
        input.value = value;
        U.fireInline(input, 'input', L.m);
    }
    test('unsaved action edits are discarded on Back and on reopen (A5A2-01)', async function() {
        var L = await load({ skills: withActions() }), dom = await body();
        await L.m.openSkillEditor('s');
        var snap = JSON.stringify(L.g.skills.s.actions);
        rename(dom, L, 1, 'Renamed');
        U.fireInline(dom.$('.skill-actions-add-btn'), 'click', L.m);
        U.fireInline(dom.$('.skill-action-row[data-action-index="0"] .skill-action-remove'), 'click', L.m);
        pickIcon(dom, L, 0, 'rocket');
        assert.deepStrictEqual(rowNames(dom), ['Renamed', 'New Action'], 'edits are shown in the editor');
        assert.strictEqual(JSON.stringify(L.g.skills.s.actions), snap, 'skills[] untouched until Save');
        U.fireInline(dom.$('.skills-back-btn'), 'click', L.m); await U.flush();
        assert.strictEqual(JSON.stringify(L.g.skills.s.actions), snap, 'Back persists nothing');
        await L.m.openSkillEditor('s');
        assert.deepStrictEqual(rowNames(dom), ['A ' + HOSTILE, 'B'], 'reopen after Back shows the saved rows');
        assert.strictEqual(dom.$('.skill-action-row[data-action-index="0"] .skill-action-icon').value, 'bug');
        // Reopening without Back (history / list click) drops the draft too.
        rename(dom, L, 1, 'Again');
        await L.m.openSkillEditor('s');
        assert.deepStrictEqual(rowNames(dom), ['A ' + HOSTILE, 'B'], 'reopen without Back shows the saved rows');
        assert.strictEqual(JSON.stringify(L.g.skills.s.actions), snap);
        assert.strictEqual(L.g.saveSkill.calls.length, 0, 'nothing saved');
    }, { tags: ['unit'] });
    test('saved action edits are committed on Save (A5A2-01)', async function() {
        var L = await load({ skills: withActions() }), dom = await body();
        await L.m.openSkillEditor('s');
        rename(dom, L, 1, 'Renamed');
        U.fireInline(dom.$('.skill-actions-add-btn'), 'click', L.m);
        pickIcon(dom, L, 0, 'rocket');
        await L.m.saveCurrentSkill();
        assert.strictEqual(L.g.saveSkill.calls.length, 1);
        var saved = L.g.saveSkill.calls[0][0].actions;
        assert.deepStrictEqual(saved.map(function(a) { return a.name; }), ['A ' + HOSTILE, 'Renamed', 'New Action']);
        assert.strictEqual(saved[0].icon, 'rocket');
        await L.m.openSkillEditor('s');
        assert.deepStrictEqual(rowNames(dom), ['A ' + HOSTILE, 'Renamed', 'New Action'], 'reopen shows the saved rows');
    }, { tags: ['unit'] });
    test('a just-added row can be removed before Save on a skill without saved actions (A5A2-01)', async function() {
        var L = await load({ skills: { e: { id: 'e', name: 'e', description: 'd' } } }), dom = await body();
        await L.m.openSkillEditor('e');
        U.fireInline(dom.$('.skill-actions-add-btn'), 'click', L.m);
        assert.strictEqual(dom.$$('.skill-action-row').length, 1);
        U.fireInline(dom.$('.skill-action-row .skill-action-remove'), 'click', L.m);
        assert.strictEqual(dom.$$('.skill-action-row').length, 0);
        assert.strictEqual(L.g.skills.e.actions, undefined, 'nothing persisted');
    }, { tags: ['unit'] });
});

describe('ui skills › SKILL.md round-trip through the editor', function() {
    afterEach(function() { U.cleanupAll(); var h = document.getElementById('icon-picker-host'); if (h) h.remove(); });
    async function roundTrip(skill) {
        var L = await load({ skills: {} });
        var md = L.m.skillToMarkdown(skill);
        var p = L.m.parseSkillMarkdown(md, 'x.md');
        L.g.skills.rt = { id: 'rt', name: p.name, description: p.description, body: p.body, actions: p.actions };
        var dom = await body();
        await L.m.openSkillEditor('rt');
        return { L: L, dom: dom, md: md, p: p };
    }
    test('name/description with YAML specials, quotes, newline; actions and body survive into the editor', async function() {
        var sk = { id: 'rt', name: 'my-skill', description: 'Audit: "prod", #1 [x]\nsecond line', body: '# Heading\n\nText', actions: [{ name: 'Go: now', icon: 'zap', show: ['sidebar', 'home'] }] };
        var r = await roundTrip(sk);
        assert.match(r.md, /^---\nname: my-skill\ndescription: "/);
        assert.strictEqual(r.dom.$('#skill-name-input').value, 'my-skill');
        assert.strictEqual(r.dom.$('#skill-description-input').value, sk.description);
        assert.strictEqual(r.dom.$('#skill-body-input').value, sk.body);
        var row = r.dom.$('.skill-action-row');
        assert.strictEqual(row.querySelector('.skill-action-name').value, 'Go: now');
        assert.strictEqual(row.querySelector('.skill-action-icon').value, 'zap');
        assert.deepStrictEqual([].map.call(row.querySelectorAll('.selected'), function(b) { return b.getAttribute('data-placement'); }), ['home', 'sidebar']);
    }, { tags: ['unit'] });
    test('no frontmatter → name from filename, whole text is the body', async function() {
        var L = await load();
        var p = L.m.parseSkillMarkdown('just text', 'My File.md');
        assert.strictEqual(p.name, 'my-file-md');
        assert.strictEqual(p.body, 'just text');
    }, { tags: ['unit'] });
    // _yamlScalar escapes backslashes and _stripYamlQuotes decodes in one pass,
    // so a literal backslash-n (e.g. a Windows path "C:\new") survives export/import.
    test('description containing a literal backslash-n survives the round trip', async function() {
        var sk = { id: 'rt', name: 'win', description: 'Paths: C:\\new\\dir', body: 'b' };
        var r = await roundTrip(sk);
        assert.strictEqual(r.dom.$('#skill-description-input').value, 'Paths: C:\\new\\dir');
    }, { tags: ['unit'] });
    test('backslash-free descriptions export byte-identically (quoted and bare)', async function() {
        var L = await load();
        assert.strictEqual(L.m._yamlScalar('Audit: "prod"\nx'), '"Audit: \\"prod\\"\\nx"');
        assert.strictEqual(L.m._yamlScalar('plain text'), 'plain text');
        assert.strictEqual(L.m._stripYamlQuotes('"a \\"b\\" \\n c \\d"'), 'a "b" \n c \\d');
    }, { tags: ['unit'] });
});

describe('ui skills › Add file (S0B-11)', function() {
    afterEach(function() { U.cleanupAll(); });
    function one() { return { a1: { id: 'a1', name: 'alpha', description: 'first', body: '# Title\nhello', actions: [{ name: 'Run', icon: 'rocket', show: ['home', 'chat'] }] } }; }
    function file(name, text) { return { name: name, text: function() { return typeof text === 'function' ? text() : Promise.resolve(text); } }; }
    // existing = what getSkillAsset resolves for the picked name (default null = new name; A5B2-01).
    async function setup(confirmResult, existing) {
        var confirm = U.recorder(function() { return Promise.resolve(confirmResult); });
        var L = await load({ skills: one(), currentEditingSkill: 'a1', showConfirmModal: confirm,
            saveSkillAsset: U.recorder(function() { return Promise.resolve(); }),
            getSkillAsset: U.recorder(function() { return Promise.resolve(existing || null); }) });
        await body();
        return { L: L, confirm: confirm };
    }
    // Drive the real entry point: capture the <input type=file> addSkillAsset() builds instead of opening a picker.
    async function pick(L, files) {
        var orig = document.createElement, picked = null;
        document.createElement = function(tag) {
            var el = orig.apply(document, arguments);
            if (String(tag).toLowerCase() === 'input') el.click = function() { picked = el; };
            return el;
        };
        try { await L.m.addSkillAsset(); } finally { document.createElement = orig; }
        assert.ok(picked && typeof picked.onchange === 'function', 'addSkillAsset opened a file picker');
        var err = null;
        try { await picked.onchange({ target: { files: files } }); } catch (e) { err = e || 'rejected'; }
        return err;
    }
    test('plain SKILL.md replaces only the body; name + actions kept (S0B-11)', async function() {
        var S = await setup(true);
        assert.strictEqual(await pick(S.L, [file('SKILL.md', 'brand new body')]), null);
        var sk = S.L.g.skills.a1;
        assert.deepStrictEqual([sk.name, sk.description, sk.body, sk.actions.length], ['alpha', 'first', 'brand new body', 1]);
        assert.strictEqual(S.confirm.calls.length, 1, 'asked before replacing');
        assert.deepStrictEqual(S.L.snack.calls[S.L.snack.calls.length - 1], ['Added 0 file(s); skill updated from SKILL.md', 'success']);
    }, { tags: ['unit'] });
    test('file.text() rejecting → error snackbar, onchange never rejects (S0B-11)', async function() {
        var S = await setup(true);
        var err = await pick(S.L, [file('notes.md', function() { return Promise.reject(new Error('boom')); })]);
        assert.strictEqual(err, null, 'onchange must not reject');
        assert.ok(S.L.snack.calls.some(function(c) { return /Add file failed: boom/.test(c[0]) && c[1] === 'error'; }), JSON.stringify(S.L.snack.calls));
        assert.strictEqual(S.L.g.saveSkillAsset.calls.length, 0);
    }, { tags: ['unit'] });
    test('.txt counts as skipped: "Added 1 file(s), skipped 1" (S0B-11)', async function() {
        var S = await setup(true);
        assert.strictEqual(await pick(S.L, [file('a.js', 'x()'), file('b.txt', 'nope')]), null);
        assert.deepStrictEqual(S.L.g.saveSkillAsset.calls, [['a1', 'a.js', 'js', 'x()']]);
        assert.deepStrictEqual(S.L.snack.calls[S.L.snack.calls.length - 1], ['Added 1 file(s), skipped 1', 'success']);
    }, { tags: ['unit'] });
    test('SKILL.md cancel keeps the skill untouched (S0B-11)', async function() {
        // null = the real Cancel button / Escape (resolveModal(null)); false = any other dismiss.
        var results = [null, false];
        for (var k = 0; k < results.length; k++) {
            var S = await setup(results[k]);
            assert.strictEqual(await pick(S.L, [file('SKILL.md', '---\nname: evil\ndescription: replaced\n---\nnew body')]), null);
            var sk = S.L.g.skills.a1;
            assert.strictEqual(S.confirm.calls.length, 1, 'asked before replacing');
            assert.strictEqual(S.confirm.calls[0][2], 'danger');
            assert.deepStrictEqual([sk.name, sk.description, sk.body, sk.actions.length], ['alpha', 'first', '# Title\nhello', 1]);
            assert.strictEqual(S.L.g.saveSkill.calls.length, 0, 'nothing persisted on cancel');
            U.cleanupAll();
        }
    }, { tags: ['unit'] });
    test('same-name asset asks before overwrite (A5B2-01)', async function() {
        // Cancel (null = Cancel button / Escape, false = any other dismiss) writes nothing.
        var cancels = [null, false];
        for (var k = 0; k < cancels.length; k++) {
            var S = await setup(cancels[k], { content: 'old' });
            assert.strictEqual(await pick(S.L, [file('my_tool.js', 'new')]), null);
            assert.deepStrictEqual(S.L.g.getSkillAsset.calls, [['a1', 'my_tool.js']]);
            assert.strictEqual(S.confirm.calls.length, 1, 'asked before replacing');
            assert.deepStrictEqual([S.confirm.calls[0][0], S.confirm.calls[0][2]], ['Replace file', 'danger']);
            assert.match(S.confirm.calls[0][1], /my_tool\.js already exists/);
            assert.strictEqual(S.L.g.saveSkillAsset.calls.length, 0, 'nothing overwritten on cancel');
            assert.deepStrictEqual(S.L.snack.calls[S.L.snack.calls.length - 1], ['Added 0 file(s), skipped 1', 'success']);
            U.cleanupAll();
        }
        // Confirm replaces exactly once.
        var R = await setup(true, { content: 'old' });
        assert.strictEqual(await pick(R.L, [file('my_tool.js', 'new')]), null);
        assert.strictEqual(R.confirm.calls.length, 1);
        assert.deepStrictEqual(R.L.g.saveSkillAsset.calls, [['a1', 'my_tool.js', 'js', 'new']]);
        assert.deepStrictEqual(R.L.snack.calls[R.L.snack.calls.length - 1], ['Added 1 file(s)', 'success']);
        U.cleanupAll();
        // A new name saves with no confirm.
        var N = await setup(true);
        assert.strictEqual(await pick(N.L, [file('fresh.md', 'hi')]), null);
        assert.strictEqual(N.confirm.calls.length, 0, 'no confirm for a new name');
        assert.deepStrictEqual(N.L.g.saveSkillAsset.calls, [['a1', 'fresh.md', 'md', 'hi']]);
    }, { tags: ['unit'] });
    test('S0C5-02 (b): the Remove File confirm escapes the file name; cancel deletes nothing', async function() {
        var confirm = U.recorder(function() { return Promise.resolve(false); });
        var L = await load({ skills: one(), currentEditingSkill: 'a1', showConfirmModal: confirm,
            deleteSkillAsset: U.recorder(function() { return Promise.resolve(); }) });
        await L.m.removeSkillAsset('notes<script>.md');
        assert.deepStrictEqual(confirm.calls[0], ['Remove File', 'Remove notes&lt;script&gt;.md from this skill?', 'danger']);
        assert.strictEqual(L.g.deleteSkillAsset.calls.length, 0, 'cancel deletes nothing');
        assert.strictEqual(L.snack.calls.length, 0);
    }, { tags: ['unit'] });
    test('RF25-F1: the Replace file confirm escapes the file name; cancel replaces nothing', async function() {
        var S = await setup(false, { content: 'old' });
        assert.strictEqual(await pick(S.L, [file('notes<script>.md', 'new')]), null);
        assert.deepStrictEqual(S.L.g.getSkillAsset.calls, [['a1', 'notes<script>.md']], 'lookup keeps the raw name');
        assert.deepStrictEqual(S.confirm.calls, [['Replace file', 'notes&lt;script&gt;.md already exists in this skill. Replace it?', 'danger']]);
        assert.strictEqual(S.L.g.saveSkillAsset.calls.length, 0, 'cancel replaces nothing');
        U.cleanupAll();
        // Confirm saves under the raw name.
        var R = await setup(true, { content: 'old' });
        assert.strictEqual(await pick(R.L, [file('notes<script>.md', 'new')]), null);
        assert.deepStrictEqual(R.L.g.saveSkillAsset.calls, [['a1', 'notes<script>.md', 'md', 'new']]);
    }, { tags: ['unit'] });
});

describe('ui permissions › radio groups', function() {
    afterEach(function() { U.cleanupAll(); });
    test('renderPermissionRadioGroup: 4 options, selected state, labels; click → saved value + selection moves', async function() {
        var L = await load(), dom = await U.mountDom({ html: '<div id="pc"></div>' });
        L.m.renderPermissionRadioGroup('pc', 'ask', 'web_fetch');
        var opts = dom.$$('#pc .radio-option');
        assert.deepStrictEqual(opts.map(function(o) { return o.textContent; }), ['Allow', 'Auto', 'Ask', 'Off']);
        assert.deepStrictEqual(opts.map(function(o) { return o.classList.contains('selected'); }), [false, false, true, false]);
        var info = U.fireInline(opts[3], 'click', L.m);
        assert.ok(info.stopped, 'stopPropagation (dropdown must stay open)');
        assert.strictEqual(L.g.toolPermissions.web_fetch, 'disabled');
        assert.strictEqual(L.g.saveToolPermissions.calls.length, 1);
        assert.deepStrictEqual(opts.map(function(o) { return o.classList.contains('selected'); }), [false, false, false, true]);
    }, { tags: ['unit'] });
    test('permKey with quote is JS-escaped in the handler', async function() {
        var L = await load(), dom = await U.mountDom({ html: '<div id="pc"></div>' });
        L.m.renderPermissionRadioGroup('pc', 'allow', "skill:it's");
        U.fireInline(dom.$$('#pc .radio-option')[2], 'click', L.m);
        assert.strictEqual(L.g.toolPermissions["skill:it's"], 'ask');
    }, { tags: ['unit'] });
    test('renderToolPermissions (header): instance + global sections, defaults, instance radio click saves per host', async function() {
        var L = await load({ toolPermissions: { web_fetch: 'ask' } }), dom = await U.mountDom({ html: '<div id="tool-permissions-list"></div>' });
        L.m.renderToolPermissions();
        var secs = dom.$$('.tool-permission-section');
        assert.strictEqual(secs.length, 2);
        assert.match(secs[0].querySelector('.tool-permission-section-title').textContent, /dev1$/);
        assert.ok(dom.$('#instance-tier-toggle .tier-opt-manual.selected'), 'manual by default');
        var readKey = L.m.INSTANCE_PERMISSION_KEYS.filter(function(k) { return L.m.isReadPermissionKey(k); })[0];
        var writeKey = L.m.INSTANCE_PERMISSION_KEYS.filter(function(k) { return !L.m.isReadPermissionKey(k); })[0];
        var sel = function(k, pre) { var c = document.getElementById((pre || 'perm-') + k.replace(/[^a-zA-Z0-9]/g, '-')); return c.querySelector('.radio-option.selected').getAttribute('data-value'); };
        assert.strictEqual(sel(readKey), 'allow'); assert.strictEqual(sel(writeKey), 'ask');
        assert.strictEqual(sel('web_fetch'), 'ask');
        var c = document.getElementById('perm-' + writeKey.replace(/[^a-zA-Z0-9]/g, '-'));
        U.fireInline(c.querySelector('[data-value="allow"]'), 'click', L.m);
        assert.strictEqual(L.g.instancePermissions[HOST].tools[writeKey], 'allow');
        assert.strictEqual(L.g.saveInstancePermissions.calls.length, 1);
        assert.strictEqual(L.g.toolPermissions[writeKey], undefined, 'not written to global map');
    }, { tags: ['unit'] });
    test('no connected instance → disabled instance section, no tier toggle, no instance radios', async function() {
        var L = await load({ Platform: { instanceUrl: null } }), dom = await U.mountDom({ html: '<div id="tool-permissions-list"></div>' });
        L.m.renderToolPermissions();
        var s0 = dom.$('.tool-permission-section');
        assert.ok(s0.classList.contains('disabled'));
        assert.match(s0.textContent, /No instance connected/);
        assert.strictEqual(dom.$('#instance-tier-toggle'), null);
    }, { tags: ['unit'] });
    test('Reset-to-defaults link only when non-default; click calls resetAllPermissionsToDefaults', async function() {
        var L = await load({ hasNonDefaultPermissions: function() { return true; } }), dom = await U.mountDom({ html: '<div id="tool-permissions-list"></div>' });
        L.m.renderToolPermissions();
        var a = dom.$$('a').filter(function(x) { return /Reset to defaults/.test(x.textContent); })[0];
        assert.ok(a);
        assert.ok(U.fireInline(a, 'click', L.m).prevented);
        assert.strictEqual(L.g.resetAllPermissionsToDefaults.calls.length, 1);
    }, { tags: ['unit'] });
    test('renderToolPermissions with only #settings-tool-permissions mounted repaints the Settings list', async function() {
        // S0-02: the header #tool-permissions-list is gone; callers (bridge, data import,
        // reset) still call renderToolPermissions() and must refresh the Settings list.
        var L = await load(), dom = await U.mountDom({ html: '<div id="settings-tool-permissions"></div>' });
        L.m.renderSettingsToolPermissions();
        assert.ok(dom.$('#settings-instance-tier-toggle .tier-opt-manual.selected'), 'initial paint: manual');
        assert.strictEqual(dom.$('#settings-instance-tier-toggle .tier-opt-dev.selected'), null);
        L.g.instancePermissions[HOST] = { tier: 'dev', tools: {} };
        L.m.renderToolPermissions();
        assert.ok(dom.$('#settings-instance-tier-toggle .tier-opt-dev.selected'), 'Settings list repainted with the new tier');
        assert.strictEqual(dom.$('#tool-permissions-list'), null, 'no header list was created');
    }, { tags: ['unit'] });
});

describe('ui permissions › instance tier toggle', function() {
    afterEach(function() { U.cleanupAll(); });
    test('_renderInstanceTierToggle: 3 segments, unknown tier → manual, dev selectable', async function() {
        var L = await load(), dom = await U.mountDom({ html: '<div id="instance-tier-toggle"></div>' });
        L.m._renderInstanceTierToggle('bogus');
        var o = dom.$$('#instance-tier-toggle .radio-option');
        assert.deepStrictEqual(o.map(function(x) { return x.textContent.trim(); }), ['Manual', 'Auto', 'Dev']);
        assert.ok(o[0].classList.contains('selected'));
        L.m._renderInstanceTierToggle('dev');
        assert.ok(dom.$('.tier-opt-dev').classList.contains('selected'));
        assert.match(dom.$('.tier-opt-dev').getAttribute('title'), /NO approvals/);
    }, { tags: ['unit'] });
    test('click Auto in the header list → tier saved, list re-rendered greyed (tier-auto + disabled radios), header refreshed', async function() {
        var L = await load(), dom = await U.mountDom({ html: '<div id="tool-permissions-list"></div>' });
        L.m.renderToolPermissions();
        assert.strictEqual(dom.$$('.tier-auto').length, 0);
        var info = U.fireInline(dom.$('#instance-tier-toggle .tier-opt-auto'), 'click', L.m);
        assert.ok(info.stopped);
        assert.strictEqual(L.g.instancePermissions[HOST].tier, 'auto');
        assert.strictEqual(L.g.saveInstancePermissions.calls.length, 1);
        assert.strictEqual(L.g.updateSnStatus.calls.length, 1);
        assert.ok(dom.$('#instance-tier-toggle .tier-opt-auto.selected'), 're-rendered with new selection');
        assert.ok(dom.$$('.tool-permission-subitem.tier-auto').length > 0);
        assert.ok(dom.$$('.radio-group-disabled').length > 0);
        U.fireInline(dom.$('#instance-tier-toggle .tier-opt-manual'), 'click', L.m);
        assert.strictEqual(dom.$$('.tier-auto').length, 0, 'back to manual un-greys');
    }, { tags: ['unit'] });
    test('Settings page toggle: Dev click saves and re-renders the settings list', async function() {
        var L = await load({ instancePermissions: { } }), dom = await U.mountDom({ html: '<div id="settings-tool-permissions"></div>' });
        L.m.renderSettingsToolPermissions();
        assert.ok(dom.$('#settings-instance-tier-toggle .tier-opt-manual.selected'));
        U.fireInline(dom.$('#settings-instance-tier-toggle .tier-opt-dev'), 'click', L.m);
        assert.strictEqual(L.g.instancePermissions[HOST].tier, 'dev');
        assert.ok(dom.$('#settings-instance-tier-toggle .tier-opt-dev.selected'), 'settings list repainted');
        assert.ok(dom.$$('#settings-tool-permissions .tier-auto').length > 0, 'dev greys per-tool rows like auto');
        var gk = document.getElementById('settings-perm-web-fetch').querySelector('[data-value="ask"]');
        U.fireInline(gk, 'click', L.m);
        assert.strictEqual(L.g.toolPermissions.web_fetch, 'ask');
    }, { tags: ['unit'] });
});

describe('ui settings › header settings panel', function() {
    afterEach(function() { U.cleanupAll(); });
    test('settings button toggles #settings-panel visible / hidden and closes other header menus', async function() {
        var L = await load(), dom = await body();
        var btn = dom.$('.settings-btn'), panel = dom.$('#settings-panel');
        assert.ok(!panel.classList.contains('visible'));
        var info = U.fireInline(btn, 'click', L.m);
        assert.ok(info.stopped);
        assert.ok(panel.classList.contains('visible'));
        assert.deepStrictEqual(L.g.closeAllHeaderMenus.calls[0], ['settings']);
        assert.strictEqual(L.g.syncSettingsPanelTheme.calls.length, 1);
        U.fireInline(btn, 'click', L.m);
        assert.ok(!panel.classList.contains('visible'));
    }, { tags: ['unit'] });
});
