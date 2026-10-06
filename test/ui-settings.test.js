// B7 — UI tests for Settings (sub-agent tier aliases, API providers list,
// GitHub connect section), the custom select / radio component and the
// workspace header dropdown. Renders the REAL src functions (loadModules) into
// the REAL sandbox document and drives rendered inline handlers through the
// module scope (test/ui-helpers.js fireInline) and delegated listeners with
// real clicks.
// Run: run_tests { files: ['test/canary.test.js', 'test/ui-settings.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/140-dropdowns.js', 'src/js/ui/040-tools-settings.js', 'src/js/tools/120-actions.js'];
var HOSTILE = '<img src=x onerror="window.__pwn=1">';

// Local helpers (proposed for ui-helpers.js): lenient multi-file loader —
// 040-tools-settings.js probes dozens of optional globals, so strict
// assertUnstubbed is impractical; every behaviour below is still asserted.
// U.fireInline builds a plain Event, so event.key is undefined for keydown
// handlers; this local variant uses a real KeyboardEvent (proposed helper fix).
function fireKey(el, k, m) {
    var code = el.getAttribute('onkeydown'), ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }), info = { prevented: false };
    var pd = ev.preventDefault.bind(ev); ev.preventDefault = function() { info.prevented = true; pd(); };
    var scope = new Proxy({}, { has: function(t, n) { return typeof n === 'string' && n !== 'event' && ((n in m) || (n in m.__scope)); },
        get: function(t, n) { return (n in m) ? m[n] : m.__scope[n]; } });
    new Function('__s', 'event', 'with (__s) { ' + code + ' }').call(el, scope, ev);
    return info;
}
function parseWsKey(k) { var i = k.lastIndexOf('::'); return { repo: k.slice(0, i), branch: k.slice(i + 2) }; }
function deferred() { var d = {}; d.promise = new Promise(function(r) { d.resolve = r; }); return d; }
async function load(extra) {
    var s = U.stubs();
    var win = { document: document, _rawCopyStore: {}, innerWidth: 0, innerHeight: 0, open: U.recorder(),
        addEventListener: function() {}, removeEventListener: function() {}, matchMedia: function() { return { matches: false, addEventListener: function() {} }; } };
    var g = Object.assign({ document: document, DOMParser: DOMParser, window: win, navigator: { userAgent: 'ui-test' }, CSS: CSS,
        showSnackbar: s.showSnackbar, parseWsKey: parseWsKey, apiProviders: [], llmEndpoints: [], currentProvider: null,
        DEFAULT_API_PROVIDERS: [] }, extra || {});
    var m = await loadModules(FILES, { workspace: WS, globals: g, lenient: true, passthrough: U.DOM_PASSTHROUGH });
    return { m: m, g: g, win: win, snack: s.showSnackbar };
}

describe('ui settings › sub-agent model tiers', function() {
    afterEach(function() { U.cleanupAll(); });
    function tierGlobals(save) {
        var map = { small: 'Fast', medium: 'same', large: 'Gone' };
        return { apiProviders: [{ name: 'Fast' }, { name: '<b>X</b>' }], subAgentTierAliases: {}, SUBAGENT_TIER_NAMES: ['small', 'medium', 'large'],
            TIER_ALIAS_SAME: 'same', DEFAULT_TIER_ALIASES: { small: 'Fast', medium: 'Fast', large: 'same' },
            getTierAliasMap: function() { return Object.assign({}, map); }, saveTierAliases: save || U.recorder(function() { return Promise.resolve(); }),
            showConfirmModal: U.recorder(function() { return Promise.resolve(true); }) };
    }
    test('one row per tier; Same / provider / stale "(missing)" selection; defaults hint; escaping', async function() {
        var L = await load(tierGlobals()), dom = await U.mountDom({ html: '<div id="tier-aliases-list"></div>' });
        L.m.renderTierAliasSettings();
        var rows = dom.$$('.settings-page-row');
        assert.strictEqual(rows.length, 3);
        assert.deepStrictEqual(rows.map(function(r) { return r.querySelector('.settings-page-row-label').textContent; }), ['small', 'medium', 'large']);
        var sel = dom.$$('select');
        assert.strictEqual(sel[0].value, 'Fast');
        assert.strictEqual(sel[1].value, 'same'); assert.strictEqual(sel[1].selectedOptions[0].textContent, 'Same');
        assert.strictEqual(sel[2].options[0].textContent, 'Gone (missing)', 'stale mapping kept visible');
        assert.strictEqual(sel[2].value, 'Gone');
        assert.match(rows[2].querySelector('.settings-page-row-hint').textContent, /default: Same$/);
        assert.match(rows[0].querySelector('.settings-page-row-hint').textContent, /Cheap \+ fast.*default: Fast/);
        assert.strictEqual(dom.$('b'), null, 'provider name escaped');
        assert.strictEqual(sel[0].options[2].textContent, '<b>X</b>');
    }, { tags: ['unit'] });
    test('changing a tier select persists the updated map (onchange → setTierAlias)', async function() {
        var tg = tierGlobals(); tg.subAgentTierAliases = { large: 'Gone' };
        var L = await load(tg), dom = await U.mountDom({ html: '<div id="tier-aliases-list"></div>' });
        L.m.renderTierAliasSettings();
        var sel = dom.$$('select')[0];
        sel.value = '<b>X</b>';
        U.fireInline(sel, 'change', L.m);
        assert.strictEqual(tg.saveTierAliases.calls.length, 1);
        assert.deepStrictEqual(tg.saveTierAliases.calls[0][0], { small: '<b>X</b>', large: 'Gone' }, 'stored override kept; untouched default tiers not copied (A8B2-01)');
    }, { tags: ['unit'] });
    test('first render hydrates via loadTierAliases before painting', async function() {
        var tg = tierGlobals(), d = deferred();
        tg.subAgentTierAliases = null; tg.loadTierAliases = U.recorder(function() { return d.promise; });
        var L = await load(tg), dom = await U.mountDom({ html: '<div id="tier-aliases-list"></div>' });
        L.m.renderTierAliasSettings();
        assert.strictEqual(tg.loadTierAliases.calls.length, 1);
        assert.strictEqual(dom.$$('select').length, 0, 'nothing painted before hydration');
        d.resolve(); await U.flush();
        assert.strictEqual(dom.$$('select').length, 3);
    }, { tags: ['unit'] });
    test('Reset to defaults: saves {} + info snackbar; failure → error snackbar, no repaint', async function() {
        var tg = tierGlobals(), L = await load(tg), dom = await U.mountDom({ html: '<div id="tier-aliases-list"></div>' });
        await L.m.resetTierAliases();
        assert.strictEqual(tg.showConfirmModal.calls.length, 1, 'asked before clearing (A8B2-02)');
        assert.deepStrictEqual(tg.saveTierAliases.calls[0][0], {});
        assert.strictEqual(dom.$$('select').length, 3, 'repainted');
        assert.deepStrictEqual(L.snack.calls[0], ['Sub-agent tiers reset to defaults', 'info']);
        var bad = tierGlobals(U.recorder(function() { return Promise.reject(new Error('idb down')); }));
        var L2 = await load(bad); U.cleanupAll();
        var dom2 = await U.mountDom({ html: '<div id="tier-aliases-list"></div>' });
        await L2.m.resetTierAliases();
        assert.deepStrictEqual(L2.snack.calls[0], ['Could not reset sub-agent tiers: idb down', 'error']);
        assert.strictEqual(dom2.$$('select').length, 0);
    }, { tags: ['unit'] });
    test('Reset to defaults asks first; Cancel keeps the overrides (A8B2-02)', async function() {
        var tg = tierGlobals(); tg.showConfirmModal = U.recorder(function() { return Promise.resolve(false); });
        var L = await load(tg), dom = await U.mountDom({ html: '<div id="tier-aliases-list"></div>' });
        await L.m.resetTierAliases();
        assert.strictEqual(tg.showConfirmModal.calls.length, 1, 'confirm shown once');
        assert.strictEqual(tg.showConfirmModal.calls[0][0], 'Reset Sub-Agent Tiers');
        assert.strictEqual(tg.showConfirmModal.calls[0][2], 'warning');
        assert.strictEqual(tg.saveTierAliases.calls.length, 0, 'Cancel writes nothing');
        assert.strictEqual(L.snack.calls.length, 0, 'no snackbar on Cancel');
        assert.strictEqual(dom.$$('select').length, 0, 'no repaint on Cancel');
    }, { tags: ['unit'] });
    test('changing one tier stores only that override; untouched tiers keep following defaults (A8B2-01)', async function() {
        var tg = tierGlobals(), L = await load(tg), dom = await U.mountDom({ html: '<div id="tier-aliases-list"></div>' });
        L.m.renderTierAliasSettings();
        var sel = dom.$$('select')[0];
        sel.value = '<b>X</b>';
        U.fireInline(sel, 'change', L.m);
        assert.strictEqual(tg.saveTierAliases.calls.length, 1);
        var saved = tg.saveTierAliases.calls[0][0];
        assert.deepStrictEqual(saved, { small: '<b>X</b>' });
        assert.strictEqual('medium' in saved, false, 'medium default not pinned as an override');
        assert.strictEqual('large' in saved, false, 'large default not pinned as an override');
    }, { tags: ['unit'] });
    test('unhydrated map is loaded before merging (A8B2-01)', async function() {
        var tg = tierGlobals(), d = deferred(), log = [];
        tg.subAgentTierAliases = null;
        tg.loadTierAliases = U.recorder(function() { log.push('load'); return d.promise; });
        tg.saveTierAliases = U.recorder(function() { log.push('save'); return Promise.resolve(); });
        var L = await load(tg);
        var p = L.m.setTierAlias('small', 'Fast');
        assert.strictEqual(tg.saveTierAliases.calls.length, 0, 'nothing saved before hydration');
        assert.strictEqual(tg.loadTierAliases.calls.length, 1);
        d.resolve(); await U.flush(); await p;
        assert.deepStrictEqual(log, ['load', 'save'], 'hydrate first, then save');
        assert.deepStrictEqual(tg.saveTierAliases.calls[0][0], { small: 'Fast' });
    }, { tags: ['unit'] });
});

describe('ui settings › API providers list', function() {
    afterEach(function() { U.cleanupAll(); });
    var OR = 'https://openrouter.ai/api/v1/chat/completions';
    function provGlobals() {
        var sub = { name: 'Sub', isChatGPTOAuth: true, model: 'gpt-5' };
        return { apiProviders: [{ name: "O'R " + HOSTILE, endpoint: OR, model: 'm', provider: 'openrouter' }, sub], DEFAULT_API_PROVIDERS: [sub],
            currentProvider: 'Sub', llmEndpoints: [], changeProvider: U.recorder() };
    }
    test('renaming the current provider refreshes the model chip (S0-03)', async function() {
        var upd = U.recorder();
        var L = await load({ apiProviders: [{ name: 'Old', model: 'gpt-5', isChatGPTOAuth: true, apiKey: 'oauth' }], currentProvider: 'Old',
            saveApiProvider: function() { return Promise.resolve(); }, saveProviderToStorage: U.recorder(), updateModelDisplay: upd, populateProviderDropdown: U.recorder() });
        await U.mountDom({ html: '<div id="custom-api-providers-list"></div><input id="provider-name" value="New"><input id="provider-model" value="gpt-5">' +
            '<input id="provider-provider" value=""><div id="provider-auth-kind"><div class="radio-option selected" data-value="chatgpt"></div></div>' });
        await L.m.saveApiProviderFromModal('Old');
        assert.strictEqual(upd.calls.length, 1, 'updateModelDisplay after renaming the current provider');
    }, { tags: ['unit'] });
    test('save rejects a name used by another model (add + rename), same-name edit still saves (A8A3-01)', async function() {
        var save = U.recorder(function() { return Promise.resolve(); });
        var L = await load({ apiProviders: [{ name: 'A', model: 'gpt-5', isChatGPTOAuth: true, apiKey: 'oauth' }, { name: 'B', model: 'gpt-5-mini', isChatGPTOAuth: true, apiKey: 'oauth' }],
            saveApiProvider: save, saveProviderToStorage: U.recorder(), updateModelDisplay: U.recorder(), populateProviderDropdown: U.recorder() });
        await U.mountDom({ html: '<div id="custom-api-providers-list"></div><input id="provider-name" value="B"><input id="provider-model" value="gpt-5">' +
            '<input id="provider-provider" value=""><div id="provider-auth-kind"><div class="radio-option selected" data-value="chatgpt"></div></div>' });
        function lastSnack() { return L.snack.calls[L.snack.calls.length - 1]; }
        await L.m.saveApiProviderFromModal('');
        assert.strictEqual(save.calls.length, 0, 'Add under an existing model name is rejected (no IDB put)');
        assert.deepStrictEqual(lastSnack(), ['A model with that name already exists', 'error']);
        await L.m.saveApiProviderFromModal('A');
        assert.strictEqual(save.calls.length, 0, 'rename onto another model name is rejected (no IDB put/delete)');
        assert.deepStrictEqual(lastSnack(), ['A model with that name already exists', 'error']);
        document.getElementById('provider-name').value = 'A';
        await L.m.saveApiProviderFromModal('A');
        assert.strictEqual(save.calls.length, 1, 'same-name edit still saves');
        assert.strictEqual(save.calls[0][0].name, 'A');
        assert.strictEqual(save.calls[0][1], 'A');
    }, { tags: ['unit'] });
    test('deleting an endpoint regroups its models under the URL domain (A8A3-02)', async function() {
        var EP = 'https://api.example.com/v1/chat/completions';
        var L;
        var persist = U.recorder(function() { return Promise.resolve(); });
        L = await load({ llmEndpoints: [{ id: 'ep1', name: 'My EP', url: EP, apiKey: '' }],
            apiProviders: [{ name: 'M', model: 'm', endpointId: 'ep1', endpoint: EP }],
            showConfirmModal: U.recorder(function() { return Promise.resolve(true); }),
            persistLlmEndpointState: persist,
            getLlmEndpointById: function(id) { return (L.m.__scope.llmEndpoints || []).find(function(e) { return e.id === id; }) || null; } });
        var dom = await U.mountDom({ html: '<div id="llm-endpoints-list"></div><div id="custom-api-providers-list"></div>' });
        function titles() { return dom.$$('.model-section-title').map(function(t) { return t.textContent; }); }
        L.m.renderApiProvidersList();
        assert.deepStrictEqual(titles(), ['My EP'], 'pre-state: grouped under the endpoint');
        await L.m.confirmDeleteLlmEndpoint('ep1');
        assert.deepStrictEqual(titles(), ['api.example.com'], 'the deleted endpoint label is gone; models regroup by URL domain');
        assert.deepStrictEqual(persist.calls[0][0], []);
        assert.match(document.getElementById('llm-endpoints-list').textContent, /No endpoints configured/);
        assert.deepStrictEqual(L.snack.calls[L.snack.calls.length - 1], ['Endpoint deleted', 'success']);
    }, { tags: ['unit'] });
    test('S0C5-02 (b): endpoint / model / provider delete confirms escape the name; titles stay raw; cancel deletes nothing', async function() {
        var EP = 'https://api.example.com/v1/chat/completions', L;
        var confirm = U.recorder(function() { return Promise.resolve(false); });
        var persist = U.recorder(function() { return Promise.resolve(); });
        L = await load({ llmEndpoints: [{ id: 'ep1', name: 'EP <b>x', url: EP, apiKey: '' }],
            apiProviders: [{ name: 'M <v2>', model: 'm', endpointId: 'ep1', endpoint: EP }],
            showConfirmModal: confirm, persistLlmEndpointState: persist,
            getLlmEndpointById: function(id) { return (L.m.__scope.llmEndpoints || []).find(function(e) { return e.id === id; }) || null; } });
        await L.m.confirmDeleteLlmEndpoint('ep1');
        await L.m.deleteApiProviderFromModal('M <v2>');
        await L.m.confirmDeleteApiProvider('M <v2>');
        assert.deepStrictEqual(confirm.calls.map(function(c) { return c[0]; }), ['Delete Endpoint', 'Delete Model', 'Delete Provider']);
        assert.deepStrictEqual(confirm.calls.map(function(c) { return c[1].split('?')[0]; }),
            ['Delete endpoint "EP &lt;b&gt;x"', 'Delete model "M &lt;v2&gt;"', 'Delete provider "M &lt;v2&gt;"']);
        assert.match(confirm.calls[0][1], / 1 model references it /, 'NEW-T31-1: one model takes the singular verb');
        assert.strictEqual(persist.calls.length, 0, 'cancel persists nothing');
        assert.strictEqual(L.m.__scope.apiProviders.length, 1, 'cancel keeps the model');
    }, { tags: ['unit'] });
    // NEW-T31-1: the verb agrees with the model count (0 = no clause, 2 = plural; 1 is asserted in S0C5-02 (b)).
    test('NEW-T31-1: endpoint delete confirm agrees the verb with the model count (0 / 2 models)', async function() {
        var EP = 'https://api.example.com/v1/chat/completions';
        async function msgFor(providers) {
            var L, confirm = U.recorder(function() { return Promise.resolve(false); });
            L = await load({ llmEndpoints: [{ id: 'ep1', name: 'EP', url: EP, apiKey: '' }], apiProviders: providers,
                showConfirmModal: confirm, persistLlmEndpointState: U.recorder(function() { return Promise.resolve(); }),
                getLlmEndpointById: function(id) { return (L.m.__scope.llmEndpoints || []).find(function(e) { return e.id === id; }) || null; } });
            await L.m.confirmDeleteLlmEndpoint('ep1');
            assert.strictEqual(confirm.calls.length, 1, 'delete confirms first');
            return confirm.calls[0][1];
        }
        var two = await msgFor([{ name: 'A', model: 'a', endpointId: 'ep1', endpoint: EP }, { name: 'B', model: 'b', endpointId: 'ep1', endpoint: EP }]);
        assert.match(two, / 2 models reference it and will keep the current URL\/key until re-saved\. /);
        var none = await msgFor([]);
        assert.ok(!/reference/.test(none), 'no model uses it: no reference clause');
        assert.strictEqual(none, 'Delete endpoint "EP"? This cannot be undone.');
    }, { tags: ['unit'] });
    test('empty state', async function() {
        var L = await load(), dom = await U.mountDom({ html: '<div id="custom-api-providers-list"></div>' });
        L.m.renderApiProvidersList();
        assert.strictEqual(dom.root.textContent.trim(), 'No providers configured.');
        assert.strictEqual(dom.$('.model-section'), null);
    }, { tags: ['unit'] });
    test('sections (subscription first), active row, custom badge, a11y header, escaping', async function() {
        var L = await load(provGlobals()), dom = await U.mountDom({ html: '<div id="custom-api-providers-list"></div>' });
        L.m.renderApiProvidersList();
        var secs = dom.$$('.model-section');
        assert.strictEqual(secs.length, 2);
        assert.strictEqual(secs[0].querySelector('.model-section-title').textContent, 'ChatGPT Subscription');
        assert.strictEqual(secs[1].querySelector('.model-section-title').textContent, 'openrouter.ai');
        assert.strictEqual(secs[0].querySelector('.model-section-count').textContent, '1');
        var active = secs[0].querySelector('.api-provider-row');
        assert.ok(active.classList.contains('active'));
        assert.strictEqual(active.querySelector('.provider-tag.active').textContent, 'Active');
        assert.ok(active.querySelector('.api-provider-btn.selected'));
        var custom = secs[1].querySelector('.api-provider-row');
        assert.strictEqual(custom.classList.contains('active'), false);
        assert.strictEqual(custom.querySelector('.provider-badge.new').textContent, 'custom');
        assert.strictEqual(custom.querySelector('.api-provider-name').textContent, "O'R " + HOSTILE);
        assert.strictEqual(dom.$('img'), null, 'name escaped');
        var hdr = U.a11y(secs[0].querySelector('.model-section-header'));
        assert.strictEqual(hdr.role, 'button'); assert.strictEqual(hdr.tabindex, '0'); assert.strictEqual(hdr.aria.expanded, 'true');
        assert.deepStrictEqual(custom.querySelectorAll('.api-provider-btn').length, 3);
        assert.deepStrictEqual(Array.prototype.map.call(custom.querySelectorAll('.api-provider-btn'), function(b) { return b.title; }), ['Use this model', 'Edit', 'Delete']);
    }, { tags: ['unit'] });
    test('select button activates the provider (hostile name round-trips through onclick)', async function() {
        var pg = provGlobals(), L = await load(pg), dom = await U.mountDom({ html: '<div id="custom-api-providers-list"></div>' });
        L.m.renderApiProvidersList();
        U.fireInline(dom.$$('.model-section')[1].querySelector('.api-provider-btn'), 'click', L.m);
        assert.deepStrictEqual(pg.changeProvider.calls, [["O'R " + HOSTILE]]);
        assert.strictEqual(dom.$$('.model-section').length, 2, 're-rendered');
    }, { tags: ['unit'] });
    test('section header: Enter/Space collapse + aria-expanded, other keys ignored, click re-expands', async function() {
        var L = await load(provGlobals()), dom = await U.mountDom({ html: '<div id="custom-api-providers-list"></div>' });
        L.m.renderApiProvidersList();
        var r = fireKey(dom.$('.model-section-header'), 'a', L.m);
        assert.strictEqual(r.prevented, false); assert.strictEqual(dom.$('.model-section').classList.contains('collapsed'), false);
        r = fireKey(dom.$('.model-section-header'), 'Enter', L.m);
        assert.strictEqual(r.prevented, true);
        assert.ok(dom.$('.model-section').classList.contains('collapsed'));
        assert.strictEqual(dom.$('.model-section-header').getAttribute('aria-expanded'), 'false');
        assert.strictEqual(dom.$$('.model-section')[1].classList.contains('collapsed'), false, 'only that section');
        U.fireInline(dom.$('.model-section-header'), 'click', L.m);
        assert.strictEqual(dom.$('.model-section-header').getAttribute('aria-expanded'), 'true');
        fireKey(dom.$('.model-section-header'), ' ', L.m);
        assert.ok(dom.$('.model-section').classList.contains('collapsed'));
    }, { tags: ['unit'] });
    test('adding or deleting a model refreshes the endpoint\'s "N models" tag (S8A-04)', async function() {
        var ep = { id: 'e1', name: 'E', url: OR, apiKey: '' }, provs = [];
        var L = await load({ llmEndpoints: [ep], apiProviders: provs,
            getLlmEndpointById: function(id) { return id === 'e1' ? ep : null; },
            saveApiProvider: function(p) { provs.push(p); return Promise.resolve(); },
            deleteApiProvider: function(n) { var i = provs.findIndex(function(p) { return p.name === n; }); if (i >= 0) provs.splice(i, 1); return Promise.resolve(); },
            updateModelDisplay: U.recorder(), saveProviderToStorage: U.recorder() });
        var dom = await U.mountDom({ html: '<div id="llm-endpoints-list"></div><div id="custom-api-providers-list"></div>' +
            '<input id="provider-name" value="M1"><input id="provider-model" value="m"><input id="provider-provider" value="">' +
            '<div id="provider-auth-kind"><div class="radio-option selected" data-value="endpoint"></div></div>' +
            '<select id="provider-endpoint-select"><option value="e1" selected>E</option></select>' });
        function tag() { return dom.$('#llm-endpoints-list .api-provider-tags').lastElementChild.textContent; }
        L.m.renderLlmEndpointsList();
        assert.strictEqual(tag(), '0 models');
        await L.m.saveApiProviderFromModal(null);
        assert.strictEqual(provs.length, 1, 'model saved under the endpoint');
        assert.strictEqual(tag(), '1 model', 'tag refreshed after add');
        await L.m.deleteApiProviderAndRefresh('M1');
        assert.strictEqual(provs.length, 0, 'model deleted');
        assert.strictEqual(tag(), '0 models', 'tag refreshed after delete');
    }, { tags: ['unit'] });
});

describe('ui settings › GitHub connect section', function() {
    afterEach(function() { U.cleanupAll(); });
    var MOUNT = '<div id="github-settings-container"></div>';
    function ghGlobals(state) {
        return { loadGitHubSettings: function() { return Promise.resolve(state.gh); }, validateGitHubToken: U.recorder(function() { return state.validate; }),
            saveGitHubSettings: U.recorder(function(t, u, user) { state.gh = { token: t, instanceUrl: u, user: user }; return Promise.resolve(); }),
            clearGitHubSettings: U.recorder(function() { state.gh = {}; return Promise.resolve(); }),
            showConfirmModal: U.recorder(function() { return Promise.resolve(state.confirm !== false); }),
            normalizeGitHubInstanceUrl: function(u) { return String(u || 'https://github.com').trim().replace(/\/+$/, ''); },
            getDeployDirHandle: function() { return Promise.resolve(state.dir || null); }, renderGitHubReposList: undefined,
            pickDeployDir: U.recorder(function() { return state.pick ? state.pick() : Promise.resolve(null); }) };
    }
    test('S0B-14 pick rejects → error snackbar, button unchanged', async function() {
        var st = { gh: { token: 't', user: { login: 'octo' } }, pick: function() { return Promise.reject(new Error('SecurityError: blocked')); } };
        var gg = ghGlobals(st), L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings(); await U.flush();
        await U.fireInline(dom.$('#deploy-dir-btn'), 'click', L.m).result; await U.flush();
        assert.strictEqual(gg.pickDeployDir.calls.length, 1);
        assert.deepStrictEqual(L.snack.calls[L.snack.calls.length - 1], ['Could not connect folder: SecurityError: blocked', 'error']);
        assert.strictEqual(dom.$('#deploy-dir-btn').textContent, 'Connect Folder');
        assert.ok(!dom.$('#deploy-dir-btn').classList.contains('connected'));
    }, { tags: ['unit'] });
    test('S0B3-02 lapsed grant → "Grant access"; click re-grants interactively, no picker', async function() {
        var st = { gh: { token: 't', user: { login: 'octo' } }, status: { state: 'prompt', name: 'my-ext' } };
        var gg = Object.assign(ghGlobals(st), { getDeployDirStatus: function() { return Promise.resolve(st.status); },
            getDeployDirHandle: U.recorder(function() { st.status = { state: 'granted', name: 'my-ext' }; return Promise.resolve({ name: 'my-ext' }); }) });
        var L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings(); await U.flush();
        assert.strictEqual(dom.$('#deploy-dir-btn').textContent, 'Grant access');
        assert.ok(!dom.$('#deploy-dir-btn').classList.contains('connected'));
        await U.fireInline(dom.$('#deploy-dir-btn'), 'click', L.m).result; await U.flush();
        assert.deepStrictEqual(gg.getDeployDirHandle.calls, [[{ interactive: true }]]);
        assert.strictEqual(gg.pickDeployDir.calls.length, 0);
        assert.strictEqual(dom.$('#deploy-dir-btn').textContent, 'my-ext');
        assert.ok(dom.$('#deploy-dir-btn').classList.contains('connected'));
    }, { tags: ['unit'] });
    test('S0B3-04 deploy row renders when GitHub disconnected', async function() {
        var gg = ghGlobals({ gh: {} }), L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings(); await U.flush();
        assert.ok(dom.$('#github-pat-input'), 'GitHub form shown');
        assert.strictEqual(dom.$('#deploy-dir-btn').textContent, 'Connect Folder');
        assert.strictEqual(dom.$('#deploy-dir-disconnect-btn').style.display, 'none', 'no folder stored → no Disconnect');
    }, { tags: ['unit'] });
    test('S0B3-04 Disconnect folder → clear called, "Connect Folder"', async function() {
        var st = { gh: { token: 't', user: { login: 'octo' } }, status: { state: 'granted', name: 'my-ext' } };
        var gg = Object.assign(ghGlobals(st), { getDeployDirStatus: function() { return Promise.resolve(st.status); },
            clearDeployDirHandle: U.recorder(function() { st.status = { state: 'none' }; return Promise.resolve(); }),
            updateReloadBtnVisibility: U.recorder(function() {}) });
        var L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings(); await U.flush();
        assert.strictEqual(dom.$('button.danger').id, '', 'GitHub Disconnect stays the first danger button');
        assert.strictEqual(dom.$('#deploy-dir-btn').textContent, 'my-ext');
        assert.strictEqual(dom.$('#deploy-dir-disconnect-btn').style.display, '');
        await U.fireInline(dom.$('#deploy-dir-disconnect-btn'), 'click', L.m).result; await U.flush();
        assert.strictEqual(gg.clearDeployDirHandle.calls.length, 1);
        assert.strictEqual(dom.$('#deploy-dir-btn').textContent, 'Connect Folder');
        assert.ok(!dom.$('#deploy-dir-btn').classList.contains('connected'));
        assert.strictEqual(dom.$('#deploy-dir-disconnect-btn').style.display, 'none');
        assert.strictEqual(gg.updateReloadBtnVisibility.calls.length, 1);
        assert.strictEqual(gg.clearGitHubSettings.calls.length, 0, 'GitHub stays connected');
    }, { tags: ['unit'] });
    test('S0B3-04 Disconnect failure → error snackbar, folder still shown', async function() {
        var st = { gh: {}, status: { state: 'granted', name: 'my-ext' } };
        var gg = Object.assign(ghGlobals(st), { getDeployDirStatus: function() { return Promise.resolve(st.status); },
            clearDeployDirHandle: U.recorder(function() { return Promise.reject(new Error('QuotaExceededError')); }) });
        var L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings(); await U.flush();
        await U.fireInline(dom.$('#deploy-dir-disconnect-btn'), 'click', L.m).result; await U.flush();
        assert.deepStrictEqual(L.snack.calls[L.snack.calls.length - 1], ['Could not disconnect folder: QuotaExceededError', 'error']);
        assert.strictEqual(dom.$('#deploy-dir-btn').textContent, 'my-ext');
    }, { tags: ['unit'] });
    test('disconnected: form fields, escaped instance URL, password PAT input', async function() {
        var st = { gh: { instanceUrl: 'https://ghe.example.com/"><b>x</b>' } };
        var L = await load(ghGlobals(st)), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings();
        assert.strictEqual(dom.$('#github-instance-url').value, 'https://ghe.example.com/"><b>x</b>');
        assert.strictEqual(dom.$('b'), null);
        assert.strictEqual(dom.$('#github-pat-input').type, 'password');
        assert.strictEqual(dom.$('#github-connect-btn').textContent, 'Connect');
        assert.strictEqual(dom.$('#github-generate-link').textContent, 'Generate token');
        assert.strictEqual(dom.$('#github-repos-list'), null);
    }, { tags: ['unit'] });
    test('Connect with empty token shows an error and never validates', async function() {
        var st = { gh: {} }, gg = ghGlobals(st), L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings();
        U.input(dom.$('#github-pat-input'), '   ');
        await U.fireInline(dom.$('#github-connect-btn'), 'click', L.m).result;
        assert.strictEqual(dom.$('#github-status-msg').textContent, 'Please enter a token');
        assert.strictEqual(dom.$('#github-status-msg').style.color, 'var(--danger)');
        assert.strictEqual(gg.validateGitHubToken.calls.length, 0);
    }, { tags: ['unit'] });
    test('Connect: validating state, failure re-enables button + shows error', async function() {
        var d = deferred(), st = { gh: {}, validate: d.promise }, gg = ghGlobals(st), L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings();
        U.input(dom.$('#github-pat-input'), ' ghp_abc ');
        U.input(dom.$('#github-instance-url'), 'https://github.com/');
        var p = U.fireInline(dom.$('#github-connect-btn'), 'click', L.m).result;
        assert.strictEqual(dom.$('#github-connect-btn').disabled, true);
        assert.strictEqual(dom.$('#github-status-msg').textContent, 'Validating...');
        assert.deepStrictEqual(gg.validateGitHubToken.calls[0], ['ghp_abc', 'https://github.com']);
        d.resolve({ ok: false, error: 'Bad credentials' }); await p;
        assert.strictEqual(dom.$('#github-connect-btn').disabled, false);
        assert.strictEqual(dom.$('#github-status-msg').textContent, 'Bad credentials');
        assert.strictEqual(gg.saveGitHubSettings.calls.length, 0);
    }, { tags: ['unit'] });
    test('Connect success → connected view (escaped login, Disconnect, repos + deploy folder); Disconnect → form', async function() {
        var st = { gh: {}, validate: Promise.resolve({ ok: true, login: '<i>octo</i>', avatar_url: 'https://a/u?v=4' }), dir: { name: 'my-ext' } };
        var gg = ghGlobals(st), L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings();
        U.input(dom.$('#github-pat-input'), 'ghp_abc');
        await U.fireInline(dom.$('#github-connect-btn'), 'click', L.m).result;
        await U.flush(); await U.flush();
        assert.strictEqual(gg.saveGitHubSettings.calls[0][0], 'ghp_abc');
        assert.strictEqual(dom.$('.settings-page-row-label').textContent, '<i>octo</i>');
        assert.strictEqual(dom.$('i'), null);
        assert.strictEqual(dom.$('img').getAttribute('src'), 'https://a/u?v=4&s=32');
        assert.ok(dom.$('#github-repos-list')); assert.ok(dom.$('#github-add-repo-input'));
        assert.strictEqual(dom.$('#deploy-dir-btn').textContent, 'my-ext');
        assert.ok(dom.$('#deploy-dir-btn').classList.contains('connected'));
        var disc = dom.$('button.danger');
        assert.strictEqual(disc.textContent, 'Disconnect');
        await U.fireInline(disc, 'click', L.m).result; await U.flush();
        assert.strictEqual(gg.clearGitHubSettings.calls.length, 1);
        assert.ok(dom.$('#github-pat-input'), 'back to form');
    }, { tags: ['unit'] });
    test('Generate token opens the instance token page and prevents navigation', async function() {
        var L = await load(ghGlobals({ gh: {} })), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings();
        U.input(dom.$('#github-instance-url'), ' https://ghe.corp/ ');
        var r = U.fireInline(dom.$('#github-generate-link'), 'click', L.m);
        assert.strictEqual(r.prevented, true);
        assert.deepStrictEqual(L.win.open.calls[0], ['https://ghe.corp/settings/tokens/new?scopes=repo&description=AppAgent', '_blank']);
    }, { tags: ['unit'] });
    // S8C-02: the Enter handlers and the Clone button all call cloneGitHubRepo, which had no busy
    // guard (the RC16B-F1 confirm is awaited first), so Enter + Clone started two parallel clones.
    test('S8C-02 Settings clone is single-flight', async function() {
        var d = deferred(), st = { gh: { token: 't', user: { login: 'octo' } } };
        var gg = Object.assign(ghGlobals(st), { getWorkspaceMeta: U.recorder(function() { return Promise.resolve(null); }),
            wsClone: U.recorder(function() { return d.promise; }) });
        var L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        L.m.__scope._wsHeaderCaches = {};
        await L.m.renderGitHubSettings(); await U.flush();
        U.input(dom.$('#github-add-repo-input'), 'o/r');
        var p1 = L.m.cloneGitHubRepo(), p2 = L.m.cloneGitHubRepo(); await U.flush(); await U.flush();
        assert.strictEqual(gg.wsClone.calls.length, 1, 'two triggers start one clone');
        await p2;
        d.resolve({ success: false, error: 'stub' }); await p1;
        assert.strictEqual(dom.$('#github-clone-status').textContent, 'stub');
        await L.m.cloneGitHubRepo();
        assert.deepStrictEqual(gg.wsClone.calls, [['o/r', undefined], ['o/r', undefined]], 'busy flag released: the next clone goes through');
    }, { tags: ['unit'] });
    // S8C-04: the PAT field had no Enter handler and connectGitHub had no disabled-button guard;
    // the form labels were divs and the status lines were not live regions.
    test('S8C-04 Settings PAT: Enter connects once; labels + live regions', async function() {
        var d = deferred(), st = { gh: {}, validate: d.promise }, gg = ghGlobals(st), L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings();
        var pat = dom.$('#github-pat-input');
        U.input(pat, 'ghp_abc');
        fireKey(pat, 'Enter', L.m); fireKey(pat, 'Enter', L.m); await U.flush();
        assert.strictEqual(gg.validateGitHubToken.calls.length, 1, 'two Enters validate once');
        assert.strictEqual(dom.$('#github-connect-btn').disabled, true, 'Connect disabled while validating');
        assert.ok(dom.$('label[for="github-pat-input"]'), 'PAT label is a <label for>');
        assert.ok(dom.$('label[for="github-instance-url"]'), 'instance URL label is a <label for>');
        assert.strictEqual(dom.$('#github-status-msg').getAttribute('role'), 'status');
        assert.strictEqual(dom.$('#github-status-msg').getAttribute('aria-live'), 'polite');
        d.resolve({ ok: false, error: 'Bad credentials' }); await U.flush(); await U.flush();
        assert.strictEqual(dom.$('#github-status-msg').textContent, 'Bad credentials');
        fireKey(pat, 'Enter', L.m); await U.flush(); await U.flush();
        assert.strictEqual(gg.validateGitHubToken.calls.length, 2, 're-enabled after a failure: Enter validates again');
        st.gh = { token: 't', user: { login: 'octo' } };
        await L.m.renderGitHubSettings(); await U.flush();
        assert.strictEqual(dom.$('#github-add-repo-input').getAttribute('aria-label'), 'Repository (owner/repo)');
        assert.strictEqual(dom.$('#github-add-branch-input').getAttribute('aria-label'), 'Branch (optional)');
        assert.strictEqual(dom.$('#github-clone-status').getAttribute('role'), 'status');
        assert.strictEqual(dom.$('#github-clone-status').getAttribute('aria-live'), 'polite');
    }, { tags: ['unit'] });
    // S8C-03: one Disconnect click removed the stored PAT + instance URL with no confirm and no feedback.
    test('Disconnect asks first; Cancel keeps the token (S8C-03)', async function() {
        var st = { gh: { token: 't', instanceUrl: 'https://ghe.example', user: { login: 'a<b>' } }, confirm: false };
        var gg = ghGlobals(st), L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings(); await U.flush();
        await U.fireInline(dom.$('button.danger'), 'click', L.m).result; await U.flush();
        assert.strictEqual(gg.showConfirmModal.calls.length, 1, 'asked before clearing');
        assert.strictEqual(gg.showConfirmModal.calls[0][0], 'Disconnect GitHub');
        assert.strictEqual(gg.showConfirmModal.calls[0][2], 'danger');
        assert.match(gg.showConfirmModal.calls[0][1], /<strong>a&lt;b&gt;<\/strong>/, 'login escaped in the confirm markup');
        assert.strictEqual(gg.showConfirmModal.calls[0][1].indexOf('a<b>'), -1);
        assert.strictEqual(gg.clearGitHubSettings.calls.length, 0, 'Cancel clears nothing');
        assert.deepStrictEqual(st.gh, { token: 't', instanceUrl: 'https://ghe.example', user: { login: 'a<b>' } }, 'token + instance URL kept');
        assert.strictEqual(dom.$('button.danger').textContent, 'Disconnect', 'still connected');
        assert.strictEqual(dom.$('#github-pat-input'), null);
        st.confirm = true;
        await U.fireInline(dom.$('button.danger'), 'click', L.m).result; await U.flush();
        assert.strictEqual(gg.showConfirmModal.calls.length, 2);
        assert.strictEqual(gg.clearGitHubSettings.calls.length, 1, 'confirmed: cleared once');
        assert.ok(dom.$('#github-pat-input'), 'back to form');
        assert.deepStrictEqual(L.snack.calls[L.snack.calls.length - 1], ['GitHub disconnected', 'info']);
    }, { tags: ['unit'] });
    test('S8C-03 Disconnect: a failed clear shows an error and stays connected', async function() {
        var st = { gh: { token: 't', user: { login: 'octo' } } };
        var gg = Object.assign(ghGlobals(st), { clearGitHubSettings: U.recorder(function() { return Promise.reject(new Error('QuotaExceededError')); }) });
        var L = await load(gg), dom = await U.mountDom({ html: MOUNT });
        await L.m.renderGitHubSettings(); await U.flush();
        await U.fireInline(dom.$('button.danger'), 'click', L.m).result; await U.flush();
        assert.strictEqual(gg.clearGitHubSettings.calls.length, 1);
        assert.deepStrictEqual(L.snack.calls[L.snack.calls.length - 1], ['Could not disconnect GitHub: QuotaExceededError', 'error']);
        assert.strictEqual(dom.$('button.danger').textContent, 'Disconnect', 'still connected');
        assert.strictEqual(st.gh.token, 't');
    }, { tags: ['unit'] });
});

describe('ui settings › custom select / radio component', function() {
    afterEach(function() { U.cleanupAll(); });
    var OPTS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }, { value: 'd"q\\', label: 'Delta' },
        { value: 'e', label: HOSTILE }, { value: 'f', label: 'Alphabet' }];
    test('>5 options: dropdown with search, selected label, escaping', async function() {
        var L = await load({ onPick: U.recorder() }), dom = await U.mountDom({ html: '<div id="cs"></div>' });
        L.m.renderCustomSelect('cs', OPTS, 'b', 'onPick');
        assert.ok(dom.$('#cs-dropdown.custom-dropdown'));
        assert.strictEqual(dom.$('.dropdown-label').textContent, 'Beta');
        assert.ok(dom.$('.custom-dropdown-search input'));
        assert.strictEqual(dom.$$('.custom-dropdown-option').length, 6);
        assert.ok(dom.$('.custom-dropdown-option[data-value="b"]').classList.contains('selected'));
        assert.strictEqual(dom.$('img'), null);
        assert.strictEqual(dom.$$('.custom-dropdown-option')[4].textContent, HOSTILE);
        assert.strictEqual(dom.$('.custom-dropdown-trigger').getAttribute('tabindex'), '0');
    }, { tags: ['unit'] });
    test('search filters options and toggles the "No matches" row', async function() {
        var L = await load({ onPick: U.recorder() }), dom = await U.mountDom({ html: '<div id="cs"></div>' });
        L.m.renderCustomSelect('cs', OPTS, 'b', 'onPick');
        var inp = dom.$('.custom-dropdown-search input');
        inp.value = 'ALPH'; U.fireInline(inp, 'input', L.m);
        var vis = dom.$$('.custom-dropdown-option').filter(function(o) { return o.style.display !== 'none'; }).map(function(o) { return o.textContent; });
        assert.deepStrictEqual(vis, ['Alpha', 'Alphabet']);
        inp.value = 'zzz'; U.fireInline(inp, 'input', L.m);
        assert.strictEqual(dom.$('.custom-dropdown-empty').textContent, 'No matches found');
        U.fireInline(inp, 'input', L.m);
        assert.strictEqual(dom.$$('.custom-dropdown-empty').length, 1, 'not duplicated');
        inp.value = ''; U.fireInline(inp, 'input', L.m);
        assert.strictEqual(dom.$('.custom-dropdown-empty'), null);
        assert.strictEqual(dom.$$('.custom-dropdown-option').filter(function(o) { return o.style.display === 'none'; }).length, 0);
    }, { tags: ['unit'] });
    test('trigger opens; picking an option (quote/backslash value) closes, relabels, moves selection, calls back', async function() {
        var cb = U.recorder(), L = await load({ onPick: cb }), dom = await U.mountDom({ html: '<div id="cs"></div>' });
        L.m.renderCustomSelect('cs', OPTS, 'b', 'onPick');
        U.fireInline(dom.$('.custom-dropdown-trigger'), 'click', L.m);
        assert.ok(dom.$('#cs-dropdown').classList.contains('open'));
        var r = U.fireInline(dom.$$('.custom-dropdown-option')[3], 'click', L.m);
        assert.strictEqual(r.stopped, true);
        assert.strictEqual(dom.$('#cs-dropdown').classList.contains('open'), false);
        assert.strictEqual(dom.$('.dropdown-label').textContent, 'Delta');
        assert.deepStrictEqual(dom.$$('.custom-dropdown-option.selected').map(function(o) { return o.textContent; }), ['Delta']);
        assert.deepStrictEqual(cb.calls, [['d"q\\']]);
    }, { tags: ['unit'] });
    test('<=3 options: radio group; click moves selection and calls back', async function() {
        var cb = U.recorder(), L = await load({ onPick: cb }), dom = await U.mountDom({ html: '<div id="rg"></div>' });
        L.m.renderCustomSelect('rg', OPTS.slice(0, 3), 'a', 'onPick');
        assert.strictEqual(dom.$('.custom-dropdown'), null);
        assert.strictEqual(dom.$$('.radio-group .radio-option').length, 3);
        assert.deepStrictEqual(dom.$$('.radio-option.selected').map(function(o) { return o.textContent; }), ['Alpha']);
        var r = U.fireInline(dom.$$('.radio-option')[2], 'click', L.m);
        assert.strictEqual(r.stopped, true);
        assert.deepStrictEqual(dom.$$('.radio-option.selected').map(function(o) { return o.textContent; }), ['Gamma']);
        assert.deepStrictEqual(cb.calls, [['c']]);
    }, { tags: ['unit'] });
});

describe('ui settings › workspace header dropdown', function() {
    var cur = null;
    afterEach(function() { if (cur) { try { cur.m.hideWorkspaceDropdown(); } catch (e) {} } cur = null; U.cleanupAll(); });
    function caches(withMine) {
        var c = {
            'o/a::main': { wk: 'o/a::main', meta: { last_used_at: 1 }, syncStatus: 'up-to-date', dirtyFiles: [], conflictFiles: [], behindFiles: [] },
            'o/b::dev': { wk: 'o/b::dev', meta: { last_used_at: 5 }, syncStatus: 'behind',
                dirtyFiles: [{ path: HOSTILE + '.js', sha: 's1' }, { path: 'n.js' },
                    { path: 'd.js', sha: 's2', deleted: true, pushed_pr: { url: 'https://github.com/o/b/pull/7', number: 7 }, last_modified_by_chat_id: 'other' }],
                conflictFiles: [{ path: 'c.js' }], behindFiles: [{ path: 'r.js', remoteDeleted: true }, { path: 'q.js', isNew: true }] }
        };
        if (withMine) c['o/a::main'].dirtyFiles = [{ path: 'mine.js', sha: 's', last_modified_by_chat_id: 'me' }];
        return c;
    }
    async function open(opts) {
        opts = opts || {};
        var L = await load(Object.assign({ currentChatId: 'me', chats: { other: { title: 'Other <chat>' } }, selectChat: U.recorder(),
            showConfirmModal: U.recorder(function() { return Promise.resolve(false); }), wsClone: U.recorder(function() { return Promise.resolve({ success: false, error: 'nope' }); }),
            // S8C-01: the re-clone / delete wrappers now read a fresh dirty count; these fixtures are clean.
            getAllWorkspaceFiles: function() { return Promise.resolve([]); }, wsGetIgnoreFilterLocal: function() { return Promise.resolve(function() { return false; }); } }, opts.globals || {}));
        cur = L;
        L.m.__scope._wsHeaderCaches = caches(opts.mine);
        if (opts.prs) L.m.__scope._wsHeaderCaches['o/b::dev'].meta.prs = opts.prs;
        if (opts.prState) L.m.__scope._sidebarPRState = opts.prState;
        L.m.__scope._wsExtDevMode = !!opts.dev;
        await U.mountDom({ html: '<div id="ws-header-status"></div><div id="home-ws-header-status"></div>' });
        await L.m.showWorkspaceDropdown();
        L.dd = document.querySelector('body > .ws-dropdown');
        return L;
    }
    function sec(L, wk) { return L.dd.querySelector('.ws-dropdown-section[data-ws="' + wk + '"]'); }
    test('renders title band + sections ordered most-recent first', async function() {
        var L = await open();
        assert.ok(L.dd, 'dropdown appended to body');
        assert.ok(L.dd.classList.contains('header-menu'));
        assert.strictEqual(L.dd.firstElementChild.textContent, 'Repositories');
        var secs = Array.prototype.map.call(L.dd.querySelectorAll('.ws-dropdown-section[data-ws]'), function(s) { return s.getAttribute('data-ws'); });
        assert.deepStrictEqual(secs, ['o/b::dev', 'o/a::main']);
        assert.strictEqual(L.dd.querySelector('.ws-this-chat-section'), null);
        assert.strictEqual(L.dd.querySelector('.ws-pr-section'), null, 'no PRs known → no PR section');
    }, { tags: ['unit'] });
    test('section header: repo, branch, change count, sync label, collapse rule (>5 changes)', async function() {
        var L = await open(), b = sec(L, 'o/b::dev'), a = sec(L, 'o/a::main');
        assert.strictEqual(b.querySelector('.ws-branch').textContent, 'dev');
        assert.match(b.querySelector('.ws-dd-title').textContent, /^o\/b dev6/);
        assert.strictEqual(b.querySelector('.ws-change-count').title, '6 changes');
        assert.strictEqual(b.querySelector('.ws-sync.behind').textContent, 'behind remote');
        assert.ok(b.classList.contains('collapsed'), '6 changes → collapsed');
        assert.strictEqual(a.classList.contains('collapsed'), false);
        assert.strictEqual(a.querySelector('.ws-change-count'), null);
        assert.strictEqual(a.querySelector('.ws-sync.up-to-date').textContent, '✓ synced');
        assert.strictEqual(a.querySelector('.ws-dropdown-empty').textContent, 'All files match remote');
    }, { tags: ['unit'] });
    test('file rows: badges, PR link, escaped path, pull button', async function() {
        var L = await open(), b = sec(L, 'o/b::dev');
        var badges = Array.prototype.map.call(b.querySelectorAll('.ws-file-badge'), function(x) { return x.className.replace('ws-file-badge ', '') + ':' + x.textContent; });
        assert.deepStrictEqual(badges, ['modified:modified', 'new:new', 'deleted:deleted', 'conflict:conflict', 'behind:deleted on remote', 'behind:new on remote']);
        assert.strictEqual(L.dd.querySelector('img'), null, 'path escaped');
        assert.strictEqual(b.querySelector('.ws-file-path').textContent, HOSTILE + '.js');
        assert.strictEqual(b.querySelector('.ws-file-path').title, HOSTILE + '.js');
        var pr = b.querySelector('a.ws-file-pr');
        assert.strictEqual(pr.textContent, 'PR #7'); assert.strictEqual(pr.getAttribute('href'), 'https://github.com/o/b/pull/7'); assert.strictEqual(pr.target, '_blank');
        assert.strictEqual(U.fireInline(pr, 'click', L.m).stopped, true);
        var pull = b.querySelector('.ws-dropdown-body button.skills-action-btn');
        assert.strictEqual(pull.textContent, 'Pull 2 files from remote');
    }, { tags: ['unit'] });
    test('owning-chat chip: tooltip names the other chat, click opens it and closes the dropdown', async function() {
        var L = await open(), chips = L.dd.querySelectorAll('.ws-file-chat');
        assert.strictEqual(chips.length, 1);
        var chip = chips[0];
        assert.strictEqual(chip.type, 'button');
        assert.strictEqual(chip.title, 'Edited by chat \u201cOther <chat>\u201d \u2014 click to open');
        assert.match(chip.style.getPropertyValue('--chat-hue'), /^\d+$/);
        assert.strictEqual(chip.classList.contains('gone'), false);
        U.click(chip);
        assert.deepStrictEqual(L.g.selectChat.calls, [['other']]);
        assert.strictEqual(document.querySelector('body > .ws-dropdown'), null);
    }, { tags: ['unit'] });
    ['modified', 'new', 'deleted'].forEach(function(status) {
        test('selected-chat attribution stays visible on ' + status + ' rows and opens its chat', async function() {
            var L = await open({ globals: { chats: { me: { title: 'Selected chat' } } } });
            var f = { path: 'mine.js', last_modified_by_chat_id: 'me' };
            if (status !== 'new') f.sha = 'base';
            if (status === 'deleted') f.deleted = true;
            var row = L.m._dirtyFileRow(f), bubbled = 0;
            L.dd.appendChild(row);
            row.addEventListener('click', function() { bubbled++; });
            var chip = row.querySelector('.ws-file-chat');
            assert.ok(chip, 'selected owner must have an attribution icon');
            assert.strictEqual(row.querySelector('.ws-file-badge').textContent, status);
            assert.match(chip.title, /Edited by chat.*Selected chat.*click to open/);
            assert.strictEqual(chip.classList.contains('gone'), false);
            U.click(chip);
            assert.deepStrictEqual(L.g.selectChat.calls, [['me']]);
            assert.strictEqual(bubbled, 0, 'chip click must not trigger row handlers');
            assert.strictEqual(document.querySelector('body > .ws-dropdown'), null);
        }, { tags: ['unit'] });
    });
    test('foreign worker keeps worker provenance and root hue across chat selection', async function() {
        var L = await open({ globals: { chats: { me: { title: 'Root' }, worker: { title: 'Worker', isSubAgent: true } },
            _wsRootChatId: function(cid) { return cid === 'worker' ? 'me' : cid; } } });
        var worker = L.m._dirtyFileRow({ path: 'worker.js', last_modified_by_chat_id: 'worker' }).querySelector('.ws-file-chat');
        var root = L.m._dirtyFileRow({ path: 'root.js', last_modified_by_chat_id: 'me' }).querySelector('.ws-file-chat');
        assert.ok(worker); assert.ok(root);
        assert.match(worker.title, /Edited by worker.*Worker/);
        assert.strictEqual(worker.style.getPropertyValue('--chat-hue'), root.style.getPropertyValue('--chat-hue'));
        L.m.__scope.currentChatId = 'worker';
        var selectedWorker = L.m._wsChatChip({ last_modified_by_chat_id: 'worker' });
        assert.strictEqual(selectedWorker.title, worker.title);
        U.click(selectedWorker);
        assert.deepStrictEqual(L.g.selectChat.calls, [['worker']]);
    }, { tags: ['unit'] });
    test('selected-chat pushed stamps and legacy PR lookup retain attribution', async function() {
        var url = 'https://github.com/o/a/pull/91';
        var L = await open({ globals: { chats: { me: { title: 'Selected chat', messages: [
            { role: 'tool', content: JSON.stringify({ success: true, pr_url: url, pr_number: 91 }) }
        ] } } } });
        [{ pushed_by_chat_id: 'me' }, {}].forEach(function(stamp) {
            var row = L.m._dirtyFileRow(Object.assign({ path: 'pushed.js', sha: 'base',
                pushed_pr: { url: url, number: 91, chatId: 'me' } }, stamp));
            var chip = row.querySelector('.ws-file-chat');
            assert.ok(chip);
            assert.match(chip.title, /Pushed \(PR #91\) by chat.*Selected chat/);
            assert.strictEqual(chip.classList.contains('gone'), false);
            assert.strictEqual(row.querySelector('.ws-file-pr').textContent, 'PR #91');
        });
    }, { tags: ['unit'] });
    test('no provenance gives no icon; unresolved selected owner stays muted and inert', async function() {
        var L = await open({ globals: { chats: {}, SubAgents: { getByChatId: function() { return null; } } } });
        assert.strictEqual(L.m._dirtyFileRow({ path: 'unknown.js' }).querySelector('.ws-file-chat'), null);
        var row = L.m._dirtyFileRow({ path: 'missing.js', last_modified_by_chat_id: 'me', last_modified_by_chat_title: 'Missing chat' });
        L.dd.appendChild(row);
        var bubbled = 0; row.addEventListener('click', function() { bubbled++; });
        var chip = row.querySelector('.ws-file-chat');
        assert.ok(chip.classList.contains('gone'));
        assert.match(chip.title, /Missing chat.*chat not loaded/);
        U.click(chip);
        assert.deepStrictEqual(L.g.selectChat.calls, []);
        assert.strictEqual(bubbled, 0);
        assert.strictEqual(document.querySelector('body > .ws-dropdown'), L.dd, 'inert chip leaves dropdown open');
    }, { tags: ['unit'] });
    test('header click toggles collapse; delete/pin/clone buttons are delegated', async function() {
        var L = await open(), a = sec(L, 'o/a::main');
        U.click(a.querySelector('.ws-dd-title'));
        assert.ok(a.classList.contains('collapsed'));
        U.click(a.querySelector('.ws-dd-title'));
        assert.strictEqual(a.classList.contains('collapsed'), false);
        assert.strictEqual(L.dd.querySelector('.ws-pin-btn'), null, 'no pin outside ext-dev mode');
        var del = a.querySelector('.ws-delete-btn');
        assert.strictEqual(U.a11y(del).name, 'Delete local workspace o/a::main');
        U.click(del); await U.flush();
        assert.strictEqual(L.g.showConfirmModal.calls[0][0], 'Delete local workspace?');
        assert.match(L.g.showConfirmModal.calls[0][1], /<strong>o\/a \(main\)<\/strong>/);
        assert.strictEqual(a.classList.contains('collapsed'), false, 'button click did not toggle the section');
        U.click(sec(L, 'o/b::dev').querySelector('.ws-clone-btn')); await U.flush();
        assert.strictEqual(document.querySelector('body > .ws-dropdown'), null, 'clone closes the dropdown');
        assert.deepStrictEqual(L.g.wsClone.calls[0], ['o/b', 'dev']);
        assert.strictEqual(L.snack.calls[0][0], 'Re-cloning o/b\u2026');
        assert.deepStrictEqual(L.snack.calls[1], ['Re-clone failed: nope', 'error']);
    }, { tags: ['unit'] });
    test('ext-dev mode shows a pin button reflecting pinned state', async function() {
        var L = await open({ dev: true });
        var pins = L.dd.querySelectorAll('.ws-pin-btn');
        assert.strictEqual(pins.length, 2);
        assert.match(pins[0].title, /^Pin this workspace/);
        assert.strictEqual(pins[0].getAttribute('data-pin-ws'), 'o/b::dev');
    }, { tags: ['unit'] });
    test('no "This chat" section; own changes no longer force repo sections collapsed', async function() {
        var L = await open({ mine: true });
        assert.strictEqual(L.dd.querySelector('.ws-this-chat-section'), null);
        assert.strictEqual(L.dd.firstElementChild.textContent, 'Repositories');
        assert.strictEqual(sec(L, 'o/a::main').classList.contains('collapsed'), false);
    }, { tags: ['unit'] });
    var PRS = [{ url: 'https://github.com/o/b/pull/7', number: 7, title: 'Seven <b>', branch: 'f7', chatId: 'other' },
        { url: 'https://github.com/o/b/pull/9', number: 9, title: 'Nine', branch: 'f9', state: 'merged', merged_at: new Date().toISOString() },
        { url: 'https://github.com/o/b/pull/8', number: 8, title: 'Eight', branch: 'f8' }];
    test('PR section on top: band, newest first, meta, states, file count, chat chip', async function() {
        var L = await open({ prs: PRS, prState: { 'https://github.com/o/b/pull/8': 'closed' } });
        var ps = L.dd.firstElementChild;
        assert.ok(ps.classList.contains('ws-pr-section'));
        var band = ps.querySelector('.menu-section-title.ws-menu-title');
        assert.strictEqual(band.textContent, 'Pull Requests (3)');
        assert.ok(band.querySelector('.section-icon svg'), 'gitBranch icon');
        assert.strictEqual(L.dd.children[1].textContent, 'Repositories');
        var entries = ps.querySelectorAll('.ws-pr-entry');
        assert.deepStrictEqual(Array.prototype.map.call(entries, function(e) { return e.getAttribute('data-pr-url').split('/').pop(); }), ['9', '8', '7']);
        assert.ok(entries[0].querySelector('.pr-sidebar-state.merged'));
        assert.strictEqual(entries[0].querySelector('.ws-collapse-chevron'), null);
        assert.strictEqual(entries[0].querySelector('.ws-pr-files'), null);
        assert.ok(entries[1].querySelector('.pr-sidebar-state.closed'));
        var open7 = entries[2];
        assert.strictEqual(open7.querySelector('.pr-sidebar-title').textContent, 'Seven <b>');
        assert.match(open7.querySelector('.pr-sidebar-meta').textContent, /^#7 \u00b7 \u2192 dev/);
        assert.ok(open7.querySelector('.ws-collapse-chevron'));
        assert.strictEqual(open7.querySelector('.ws-change-count').textContent, '1');
        assert.ok(open7.classList.contains('expandable'));
        var mb = open7.querySelector('.pr-sidebar-merge-btn');
        assert.strictEqual(mb.title, 'Merge PR #7 and sync workspace');
        var ob = open7.querySelector('a.pr-sidebar-open');
        assert.strictEqual(ob.getAttribute('href'), 'https://github.com/o/b/pull/7'); assert.strictEqual(ob.target, '_blank');
        var chip = open7.querySelector('.ws-pr-chat');
        assert.strictEqual(chip.textContent, 'Other <chat>');
        assert.ok(open7.classList.contains('collapsed'));
        assert.strictEqual(open7.querySelector('.ws-pr-files .ws-file-path').textContent, 'd.js');
    }, { tags: ['unit'] });
    test('PR row clicks: row toggles + survives re-render; merge/open/chip do not toggle or close', async function() {
        var merge = U.recorder();
        var L = await open({ prs: PRS });
        L.m.__scope.mergeSidebarPR = merge;
        var entry = function() { return L.dd.querySelector('.ws-pr-entry[data-pr-url="https://github.com/o/b/pull/7"]'); };
        U.click(entry().querySelector('.pr-sidebar-title'));
        assert.strictEqual(entry().classList.contains('collapsed'), false, 'expanded');
        L.m._reconcileDropdownSections();
        assert.strictEqual(entry().classList.contains('collapsed'), false, 'expand state kept across re-render');
        U.click(entry().querySelector('.pr-sidebar-merge-btn'));
        assert.strictEqual(merge.calls.length, 1);
        assert.strictEqual(entry().classList.contains('collapsed'), false, 'merge did not toggle');
        // Open PR with 0 pushed files: no chevron, not expandable, clicks do not toggle.
        var e8 = function() { return L.dd.querySelector('.ws-pr-entry[data-pr-url="https://github.com/o/b/pull/8"]'); };
        assert.ok(e8().querySelector('.pr-sidebar-merge-btn'), '#8 is open');
        assert.strictEqual(e8().querySelector('.ws-collapse-chevron'), null, 'no chevron with 0 files');
        assert.strictEqual(e8().classList.contains('expandable'), false);
        assert.strictEqual(e8().querySelector('.ws-pr-files'), null);
        U.click(e8().querySelector('.pr-sidebar-title'));
        assert.ok(e8().classList.contains('collapsed'), '0-file PR does not expand');
        L.m._onClickOutsideWsDropdown({ target: entry().querySelector('.pr-sidebar-open') });
        assert.ok(document.querySelector('body > .ws-dropdown'), 'inside click keeps dropdown');
        U.click(entry().querySelector('.ws-pr-chat'));
        assert.deepStrictEqual(L.g.selectChat.calls, [['other']]);
        assert.strictEqual(document.querySelector('body > .ws-dropdown'), null, 'chip opens the chat');
    }, { tags: ['unit'] });
    test('_wsCollectDropdownPRs: union dedup, newest first, files matched by url or repo+number', async function() {
        var L = await load({});
        var out = L.m._wsCollectDropdownPRs({
            'o/r::main': { meta: { prs: [{ url: 'https://github.com/o/r/pull/2', number: 2 }, { url: 'https://github.com/o/r/pull/5', number: 5, title: 'Five' }] },
                dirtyFiles: [{ path: 'a', pushed_pr: { url: 'https://github.com/o/r/pull/5', number: 5 }, changed_since_push: true }, { path: 'b', pushed_pr: { number: 2 } }, { path: 'c' }] },
            'o/r::feat': { meta: { prs: [{ url: 'https://github.com/o/r/pull/5', number: 5, state: 'merged' }] }, dirtyFiles: [] },
            'x/y::main': { meta: { prs: [] }, dirtyFiles: [{ path: 'z', pushed_pr: { number: 2 } }] }
        }, [{ url: 'https://github.com/q/q/pull/40', number: 40 }]);
        assert.deepStrictEqual(out.map(function(p) { return p.number; }), [40, 5, 2]);
        assert.strictEqual(out[1].base, 'main');
        assert.strictEqual(out[1].metaState, 'merged', 'duplicate lends merged state');
        assert.deepStrictEqual(out[1].files.map(function(x) { return x.f.path; }), ['a']);
        assert.deepStrictEqual(out[2].files.map(function(x) { return x.f.path; }), ['b'], 'number match only within the same repo');
        assert.strictEqual(out[0].files.length, 0);
    }, { tags: ['unit'] });
    test('_wsFilterDropdownPRs: merged only when merged today (local); non-merged always kept', async function() {
        var L = await load({});
        var now = new Date(2026, 9, 1, 12, 0, 0).getTime();
        var prs = [
            { url: 'u/1', metaState: 'merged', mergedAt: new Date(2026, 9, 1, 0, 5).toISOString() },
            { url: 'u/2', metaState: 'merged', mergedAt: new Date(2026, 8, 30, 23, 59).toISOString() },
            { url: 'u/3', metaState: 'merged', mergedAt: null },
            { url: 'u/4', metaState: '' },
            { url: 'u/5', metaState: 'closed' },
            { url: 'u/6', metaState: 'merged', mergedAt: new Date(2026, 9, 1, 23, 59).getTime() },
            { url: 'u/7', metaState: 'merged', mergedAt: 'garbage' }
        ];
        var keep = L.m._wsFilterDropdownPRs(prs, { now: now }).map(function(p) { return p.url; });
        assert.deepStrictEqual(keep, ['u/1', 'u/4', 'u/5', 'u/6'], 'today kept; yesterday / no ts / bad ts hidden; open + closed kept');
        // Injected state/merged_at accessors (live state wins over meta).
        var live = L.m._wsFilterDropdownPRs([{ url: 'a' }, { url: 'b' }, { url: 'c' }], { now: now,
            stateOf: function(p) { return { a: 'merged', b: 'merging', c: 'merged' }[p.url]; },
            mergedAtOf: function(p) { return p.url === 'a' ? new Date(now - 3600e3).toISOString() : null; } });
        assert.deepStrictEqual(live.map(function(p) { return p.url; }), ['a', 'b'], 'merging kept; live-merged without ts hidden');
        assert.strictEqual(L.m._wsIsSameLocalDay(null, now), false);
    }, { tags: ['unit'] });
    test('PR section: merged-yesterday / untimestamped merged hidden and not counted; live merged_at wins', async function() {
        var yest = new Date(); yest.setDate(yest.getDate() - 1);
        var prs = [{ url: 'https://github.com/o/b/pull/7', number: 7, title: 'Seven' },
            { url: 'https://github.com/o/b/pull/9', number: 9, title: 'Nine', state: 'merged', merged_at: yest.toISOString() },
            { url: 'https://github.com/o/b/pull/8', number: 8, title: 'Eight', state: 'merged' },
            { url: 'https://github.com/o/b/pull/6', number: 6, title: 'Six', state: 'closed' }];
        var L = await open({ prs: prs, prState: { 'https://github.com/o/b/pull/5': 'merged' } });
        var nums = function() { return Array.prototype.map.call(L.dd.querySelectorAll('.ws-pr-entry'), function(e) { return e.getAttribute('data-pr-url').split('/').pop(); }); };
        assert.deepStrictEqual(nums(), ['7', '6']);
        assert.strictEqual(L.dd.querySelector('.ws-pr-title').textContent, 'Pull Requests (2)', 'count reflects the filtered list');
        // Live merge timestamp (merge button / GitHub refresh) makes #8 visible today.
        L.m.__scope._sidebarPRMergedAt = { 'https://github.com/o/b/pull/8': new Date().toISOString() };
        L.m._reconcileWsPrSection();
        assert.deepStrictEqual(nums(), ['8', '7', '6']);
        assert.strictEqual(L.dd.querySelector('.ws-pr-title').textContent, 'Pull Requests (3)');
    }, { tags: ['unit'] });
    test('PR section: 7 rows by default, "View more (N)" reveals the rest, survives re-render, Collapse folds back', async function() {
        var prs = [];
        for (var i = 1; i <= 10; i++) prs.push({ url: 'https://github.com/o/b/pull/' + (100 + i), number: 100 + i, title: 'P' + i });
        var L = await open({ prs: prs });
        var rows = function() { return L.dd.querySelectorAll('.ws-pr-entry').length; };
        var btn = function() { return L.dd.querySelector('.ws-pr-section .ws-pr-more'); };
        assert.strictEqual(rows(), 7);
        assert.strictEqual(L.dd.querySelector('.ws-pr-title').textContent, 'Pull Requests (10)', 'header counts all filtered PRs');
        assert.strictEqual(btn().textContent, 'View more (3)');
        assert.strictEqual(L.dd.querySelector('.ws-pr-section').lastElementChild, btn(), 'button at the end of the section');
        L.m._onClickOutsideWsDropdown({ target: btn() });
        U.click(btn());
        assert.ok(document.querySelector('body > .ws-dropdown'), 'dropdown stays open');
        assert.strictEqual(rows(), 10);
        assert.strictEqual(btn().textContent, 'Collapse');
        L.m._reconcileWsPrSection();
        assert.strictEqual(rows(), 10, 'expanded state survives re-render');
        U.click(btn());
        assert.strictEqual(rows(), 7);
        // <= 7 PRs: no button.
        L.m.__scope._wsHeaderCaches['o/b::dev'].meta.prs = prs.slice(0, 7);
        L.m._reconcileWsPrSection();
        assert.strictEqual(rows(), 7);
        assert.strictEqual(btn(), null);
    }, { tags: ['unit'] });
    test('opening the dropdown kicks the meta-PR loader only when _sidebarMetaPRs is not loaded', async function() {
        var kick = U.recorder();
        var L = await open({ globals: { _sidebarMetaPRs: null, _refreshSidebarMetaPRs: kick } });
        assert.strictEqual(kick.calls.length, 1, 'null (never loaded) → loader kicked');
        L.m.hideWorkspaceDropdown(); U.cleanupAll();
        var kick2 = U.recorder();
        await open({ globals: { _sidebarMetaPRs: [], _refreshSidebarMetaPRs: kick2 } });
        assert.strictEqual(kick2.calls.length, 0, 'already loaded → not kicked');
    }, { tags: ['unit'] });
    test('outside click closes; inside / anchor clicks keep it open; hide is idempotent', async function() {
        var L = await open();
        L.m._onClickOutsideWsDropdown({ target: L.dd.querySelector('.ws-branch') });
        L.m._onClickOutsideWsDropdown({ target: document.getElementById('ws-header-status') });
        assert.ok(document.querySelector('body > .ws-dropdown'));
        L.m._onClickOutsideWsDropdown({ target: document.body });
        assert.strictEqual(document.querySelector('body > .ws-dropdown'), null);
        L.m.hideWorkspaceDropdown();
        assert.strictEqual(L.m.__scope._wsDropdown, null);
    }, { tags: ['unit'] });
    test('no cached workspaces → nothing opens', async function() {
        var L = await load({});
        cur = L;
        L.m.__scope._wsHeaderCaches = {};
        await U.mountDom({ html: '<div id="ws-header-status"></div>' });
        await L.m.showWorkspaceDropdown();
        assert.strictEqual(document.querySelector('body > .ws-dropdown'), null);
    }, { tags: ['unit'] });
});

// S8C-01: the Settings > GitHub repo row's Re-clone / Delete local clone buttons called
// recloneGitHubRepo / deleteGitHubRepo directly (no confirm, no dirty warning). They now use
// the header-dropdown wrappers, which count dirty files FRESH from the local store (the header
// cache can be missing or stale from Settings) and treat an unreadable state as unknown.
// Cancel / dismiss = nothing re-cloned or deleted.
describe('ui settings › repo row destructive actions (S8C-01)', function() {
    afterEach(function() { U.cleanupAll(); });
    var DIRTY = [{ path: 'a.js', dirty: true, content: 'x' }, { path: 'ignored.log', dirty: true }, { path: 'b.js', content: 'y' }];
    async function setup(files, confirmResult) {
        var L = await load({
            getAllWorkspaceFiles: U.recorder(function() { return files instanceof Error ? Promise.reject(files) : Promise.resolve(files); }),
            wsGetIgnoreFilterLocal: function() { return Promise.resolve(function(p) { return p === 'ignored.log'; }); },
            showConfirmModal: U.recorder(function() { return Promise.resolve(!!confirmResult); }),
            wsClone: U.recorder(function() { return Promise.resolve({ success: false, error: 'stub' }); }),
            deleteLocalWorkspaceData: U.recorder(function() { return Promise.resolve(); }),
            workspaceMetaStoreName: 'workspace_meta',
            openDatabase: function() { return Promise.resolve({ transaction: function() { return { objectStore: function() { return { getAll: function() {
                var req = {};
                Promise.resolve().then(function() { req.result = [{ repo: 'o/r::main', github_repo: 'o/r', branch: 'main', last_used_at: 1 }]; req.onsuccess(); });
                return req;
            } }; } }; } }); }
        });
        L.m.__scope._wsHeaderCaches = {};
        return L;
    }
    async function settle() { await U.flush(); await U.flush(); }
    test('Settings row Re-clone / Delete ask first with the fresh dirty count; cancel re-clones and deletes nothing', async function() {
        var L = await setup(DIRTY, false), dom = await U.mountDom({ html: '<div id="github-repos-list"></div>' });
        await L.m.renderGitHubReposList();
        var row = dom.$('.settings-page-row[data-wk="o/r::main"]');
        assert.ok(row, 'repo row rendered');
        U.fireInline(row.querySelector('button[title="Re-clone (fetch latest)"]'), 'click', L.m); await settle();
        U.fireInline(row.querySelector('button[title="Delete local clone"]'), 'click', L.m); await settle();
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 2, 'both destructive buttons confirm first');
        assert.strictEqual(c[0][0], 'Re-clone o/r?');
        assert.match(c[0][1], /discards 1 local change<\/strong>/, 'gitignored dirty file not counted');
        assert.match(c[0][1], /Gitignored files \(not counted\) are replaced too; the workspace\u2019s PR tracking is kept\. Continue\?/, 're-clone names the gitignored files and says the PR tracking is kept (TA-2)');
        assert.strictEqual(c[0][2], 'danger');
        assert.strictEqual(c[1][0], 'Delete local workspace?');
        assert.match(c[1][1], /This permanently discards 1 uncommitted local change\./);
        assert.match(c[1][1], /Gitignored files \(not counted above\) and the workspace\u2019s PR tracking are deleted too/, 'delete also names the gitignored files and PR tracking');
        assert.strictEqual(L.g.wsClone.calls.length, 0, 'cancel: nothing re-cloned');
        assert.strictEqual(L.g.deleteLocalWorkspaceData.calls.length, 0, 'cancel: nothing deleted');
        assert.ok(dom.$('.settings-page-row[data-wk="o/r::main"]'), 'row kept after cancel');
        assert.strictEqual(L.snack.calls.length, 0);
    }, { tags: ['unit'] });
    test('an unreadable dirty state counts as unknown: both actions still ask and say so', async function() {
        var L = await setup(new Error('idb down'), false);
        await L.m._recloneWorkspaceFromDropdown('o/r', 'main');
        await L.m._deleteWorkspaceFromDropdown('o/r::main');
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 2);
        assert.match(c[0][1], /may discard local changes \(they could not be checked\)/);
        assert.match(c[1][1], /Any uncommitted local changes will be permanently discarded \(they could not be checked\)/);
        assert.ok(!/\(not counted above\)/.test(c[1][1]), 'NEW-T35-1: no count is shown above, so no "(not counted above)"');
        assert.strictEqual(L.g.wsClone.calls.length, 0);
        assert.strictEqual(L.g.deleteLocalWorkspaceData.calls.length, 0);
    }, { tags: ['unit'] });
    // RC16B-F2: unreadable state + a cached dirty count = ONE line naming the last known count
    // (was: the count line AND the generic 'Any uncommitted' line).
    test('delete with an unreadable state names the last known count once', async function() {
        var L = await setup(new Error('idb down'), false);
        L.m.__scope._wsHeaderCaches = { 'o/r::main': { dirtyCount: 2 } };
        await L.m._deleteWorkspaceFromDropdown('o/r::main');
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1);
        assert.match(c[0][1], /discards 2 uncommitted local changes \(last known count; the current state could not be checked\)\./);
        assert.ok(!/Any uncommitted/.test(c[0][1]), 'the generic unknown-state line is not repeated');
        assert.match(c[0][1], /Gitignored files \(not counted above\) and the workspace\u2019s PR tracking are deleted too/, 'NEW-T35-1: a count is shown above, so the parenthetical stays');
        assert.strictEqual(L.g.deleteLocalWorkspaceData.calls.length, 0, 'cancel: nothing deleted');
    }, { tags: ['unit'] });
    // NEW-T35-1: a clean workspace shows no count, so the tail must not say "(not counted above)".
    test('NEW-T35-1: a clean workspace delete asks without "(not counted above)"', async function() {
        var L = await setup([{ path: 'a.js' }], false);
        await L.m._deleteWorkspaceFromDropdown('o/r::main');
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1, 'delete still confirms first');
        assert.ok(!/discards/.test(c[0][1]), 'clean: no count line');
        assert.match(c[0][1], /Gitignored files and the workspace\u2019s PR tracking are deleted too\. The GitHub repository and remote branch will not be deleted\./);
        assert.ok(!/not counted/.test(c[0][1]), 'no count shown, so no "(not counted above)"');
        assert.strictEqual(L.g.deleteLocalWorkspaceData.calls.length, 0, 'cancel: nothing deleted');
    }, { tags: ['unit'] });
    // RC16B-F2: the unconfirmed wsClone primitive had no callers left; the Settings row and the
    // header dropdown both use _recloneWorkspaceFromDropdown (confirm first).
    test('recloneGitHubRepo (unconfirmed wsClone primitive) is gone', async function() {
        var src = await loadFile('src/js/ui/040-tools-settings.js');
        assert.ok(!/function recloneGitHubRepo\(/.test(src), 'recloneGitHubRepo removed');
        assert.match(src, /async function _recloneWorkspaceFromDropdown\(/);
    }, { tags: ['unit'] });
    test('a stale header cache cannot hide fresh changes; confirming re-clones; a clean workspace re-clones without a prompt', async function() {
        var L = await setup(DIRTY, true);
        L.m.__scope._wsHeaderCaches = { 'o/r::main': { wk: 'o/r::main', dirtyCount: 0, dirtyFiles: [] } };
        await L.m._recloneWorkspaceFromDropdown('o/r', 'main');
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1);
        assert.deepStrictEqual(L.g.getAllWorkspaceFiles.calls[0], ['o/r::main']);
        assert.deepStrictEqual(L.g.wsClone.calls[0], ['o/r', 'main']);
        assert.deepStrictEqual(L.snack.calls[1], ['Re-clone failed: stub', 'error']);
        var C = await setup([{ path: 'a.js' }], false);
        await C.m._recloneWorkspaceFromDropdown('o/r', 'main');
        assert.strictEqual(C.g.showConfirmModal.calls.length, 0);
        assert.deepStrictEqual(C.g.wsClone.calls[0], ['o/r', 'main']);
    }, { tags: ['unit'] });
});

// RC16B-F1: the Settings Clone form (cloneGitHubRepo) called wsClone straight away, and wsClone
// REPLACES an existing clone of the same repo::branch (every local row, dirty ones included).
// It now asks first whenever a clone exists, with the fresh dirty count (unknown = says so); no
// branch or 'main' (wsClone's master fallback) = main and master are both checked. Cancel /
// dismiss / failed check = nothing cloned.
describe('ui settings › Clone form never silently replaces an existing clone (RC16B-F1)', function() {
    afterEach(function() { U.cleanupAll(); });
    var DIRTY = [{ path: 'a.js', dirty: true, content: 'x' }, { path: 'ignored.log', dirty: true }, { path: 'b.js', content: 'y' }];
    var MAIN = { 'o/r::main': { repo: 'o/r::main', github_repo: 'o/r', branch: 'main' } };
    var FORM = '<div id="github-repos-list"></div>' +
        '<input type="text" id="github-add-repo-input" onkeydown="if(event.key===\'Enter\')cloneGitHubRepo()" />' +
        '<input type="text" id="github-add-branch-input" onkeydown="if(event.key===\'Enter\')cloneGitHubRepo()" />' +
        '<button class="skills-action-btn" onclick="cloneGitHubRepo()">Clone</button><div id="github-clone-status"></div>';
    async function setup(metas, files, confirmResult, repo, branch) {
        var log = [];
        var L = await load({
            getAllWorkspaceFiles: U.recorder(function() { return files instanceof Error ? Promise.reject(files) : Promise.resolve(files); }),
            wsGetIgnoreFilterLocal: function() { return Promise.resolve(function(p) { return p === 'ignored.log'; }); },
            getWorkspaceMeta: U.recorder(function(wk) { return metas instanceof Error ? Promise.reject(metas) : Promise.resolve(metas[wk] || null); }),
            showConfirmModal: U.recorder(function() { log.push('confirm'); return Promise.resolve(!!confirmResult); }),
            wsClone: U.recorder(function() { log.push('clone'); return Promise.resolve({ success: true, message: 'Cloned' }); }),
            deleteLocalWorkspaceData: U.recorder(function() { return Promise.resolve(); }),
            workspaceMetaStoreName: 'workspace_meta',
            openDatabase: function() { return Promise.resolve({ transaction: function() { return { objectStore: function() { return { getAll: function() {
                var req = {};
                Promise.resolve().then(function() { req.result = [{ repo: 'o/r::main', github_repo: 'o/r', branch: 'main', last_used_at: 1 }]; req.onsuccess(); });
                return req;
            } }; } }; } }); }
        });
        L.m.__scope._wsHeaderCaches = {};
        L.log = log;
        L.dom = await U.mountDom({ html: FORM });
        U.input(L.dom.$('#github-add-repo-input'), repo);
        U.input(L.dom.$('#github-add-branch-input'), branch);
        return L;
    }
    async function settle() { await U.flush(); await U.flush(); }
    test('Enter on an already-cloned dirty repo::branch asks first (danger, fresh count); cancel clones nothing and keeps the form', async function() {
        var L = await setup(MAIN, DIRTY, false, 'o/r', 'main');
        fireKey(L.dom.$('#github-add-repo-input'), 'Enter', L.m); await settle();
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1, 'asked before replacing the clone');
        assert.strictEqual(c[0][0], 'Replace existing clone?');
        assert.match(c[0][1], /o\/r \(main\)<\/strong>: <strong>permanently discards 1 uncommitted local change<\/strong>/, 'gitignored dirty file not counted');
        assert.strictEqual(c[0][2], 'danger');
        assert.deepStrictEqual(L.g.getAllWorkspaceFiles.calls[0], ['o/r::main'], 'fresh dirty count');
        assert.strictEqual(L.g.wsClone.calls.length, 0, 'cancel: nothing cloned or replaced');
        assert.strictEqual(L.dom.$('#github-add-repo-input').value, 'o/r');
        assert.strictEqual(L.dom.$('#github-add-branch-input').value, 'main');
        assert.strictEqual(L.dom.$('#github-clone-status').textContent, '', 'no Cloning status after cancel');
    }, { tags: ['unit'] });
    test('Clone button on a clean existing clone still asks; confirming clones once, after the confirm', async function() {
        var L = await setup(MAIN, [], true, 'o/r', 'main');
        U.fireInline(L.dom.$('button'), 'click', L.m); await settle();
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1);
        assert.match(c[0][1], /o\/r \(main\)<\/strong>: no uncommitted local changes found/);
        assert.ok(!/No branch entered/.test(c[0][1]));
        assert.deepStrictEqual(L.g.wsClone.calls, [['o/r', 'main']]);
        assert.deepStrictEqual(L.log, ['confirm', 'clone']);
        assert.strictEqual(L.dom.$('#github-clone-status').textContent, 'Cloned');
    }, { tags: ['unit'] });
    test('an unreadable dirty state is shown as unknown and a failed clone lookup never clones', async function() {
        var L = await setup(MAIN, new Error('idb down'), false, 'o/r', 'main');
        await L.m.cloneGitHubRepo();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1);
        assert.match(L.g.showConfirmModal.calls[0][1], /may discard uncommitted local changes \(they could not be checked\)/);
        assert.strictEqual(L.g.wsClone.calls.length, 0);
        var F = await setup(new Error('meta down'), [], true, 'o/r', 'main');
        await assert.rejects(F.m.cloneGitHubRepo(), /meta down/);
        assert.strictEqual(F.g.wsClone.calls.length, 0, 'fail-closed: nothing cloned');
    }, { tags: ['unit'] });
    test('no branch entered: main and master are both checked, the existing master clone is named; cancel clones nothing', async function() {
        var L = await setup({ 'o/r::master': { repo: 'o/r::master', github_repo: 'o/r', branch: 'master' } }, DIRTY, false, 'o/r', '');
        await L.m.cloneGitHubRepo();
        var keys = L.g.getWorkspaceMeta.calls.map(function(a) { return a[0]; });
        assert.ok(keys.indexOf('o/r::main') >= 0 && keys.indexOf('o/r::master') >= 0, 'checked: ' + keys.join(','));
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1);
        assert.match(c[0][1], /o\/r \(master\)<\/strong>: <strong>permanently discards 1 uncommitted/);
        assert.ok(!/o\/r \(main\)/.test(c[0][1]), 'main is not cloned, so not listed');
        assert.match(c[0][1], /No branch entered/);
        assert.strictEqual(L.g.wsClone.calls.length, 0);
    }, { tags: ['unit'] });
    // RC16B-F1 revision: wsClone's main -> master fallback also runs for a TYPED 'main' (not only an
    // empty branch) and then replaces repo::master, so a master-only clone must be found and named.
    var MASTER = { 'o/r::master': { repo: 'o/r::master', github_repo: 'o/r', branch: 'master' } };
    test('typed main with only a dirty master clone asks first and names o/r (master) with the fresh count; cancel clones nothing', async function() {
        var L = await setup(MASTER, DIRTY, false, 'o/r', 'main');
        fireKey(L.dom.$('#github-add-branch-input'), 'Enter', L.m); await settle();
        var keys = L.g.getWorkspaceMeta.calls.map(function(a) { return a[0]; });
        assert.ok(keys.indexOf('o/r::main') >= 0 && keys.indexOf('o/r::master') >= 0, 'checked: ' + keys.join(','));
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1, 'asked before wsClone falls back to and replaces o/r::master');
        assert.strictEqual(c[0][0], 'Replace existing clone?');
        assert.match(c[0][1], /o\/r \(master\)<\/strong>: <strong>permanently discards 1 uncommitted local change<\/strong>/);
        assert.ok(!/o\/r \(main\)/.test(c[0][1]), 'main is not cloned, so not listed');
        assert.match(c[0][1], /main is cloned, or master if the remote has no main/, 'fallback note for a typed main');
        assert.ok(!/No branch entered/.test(c[0][1]), 'a branch was entered');
        assert.strictEqual(c[0][2], 'danger');
        assert.deepStrictEqual(L.g.getAllWorkspaceFiles.calls, [['o/r::master']], 'fresh dirty count of the master clone');
        assert.strictEqual(L.g.wsClone.calls.length, 0, 'cancel: nothing cloned or replaced');
        assert.strictEqual(L.dom.$('#github-add-repo-input').value, 'o/r');
        assert.strictEqual(L.dom.$('#github-add-branch-input').value, 'main');
        assert.strictEqual(L.dom.$('#github-clone-status').textContent, '', 'no Cloning status after cancel');
    }, { tags: ['unit'] });
    test('typed main with only a clean master clone still asks (danger); cancel clones nothing', async function() {
        var L = await setup(MASTER, [], false, 'o/r', 'main');
        U.fireInline(L.dom.$('button'), 'click', L.m); await settle();
        var c = L.g.showConfirmModal.calls;
        assert.strictEqual(c.length, 1, 'a clean master clone is still replaced, so still asked');
        assert.match(c[0][1], /o\/r \(master\)<\/strong>: no uncommitted local changes found/);
        assert.strictEqual(c[0][2], 'danger');
        assert.strictEqual(L.g.wsClone.calls.length, 0, 'cancel: nothing cloned or replaced');
        assert.strictEqual(L.dom.$('#github-clone-status').textContent, '');
    }, { tags: ['unit'] });
    test('typed main with only a clean master clone: confirming clones once, after the confirm', async function() {
        var L = await setup(MASTER, [], true, 'o/r', 'main');
        fireKey(L.dom.$('#github-add-branch-input'), 'Enter', L.m); await settle();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1);
        assert.match(L.g.showConfirmModal.calls[0][1], /o\/r \(master\)<\/strong>/);
        assert.deepStrictEqual(L.g.wsClone.calls, [['o/r', 'main']]);
        assert.deepStrictEqual(L.log, ['confirm', 'clone']);
        assert.strictEqual(L.dom.$('#github-clone-status').textContent, 'Cloned');
    }, { tags: ['unit'] });
    test('a repo that is not cloned yet clones straight away (no over-prompting)', async function() {
        var L = await setup({}, [], false, 'o/r', '');
        await L.m.cloneGitHubRepo(); await settle();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 0);
        assert.deepStrictEqual(L.g.wsClone.calls, [['o/r', undefined]]);
    }, { tags: ['unit'] });
});

// S8C-02 / S8C-04 / A8C-01: the github_setup popup (tools/130 showGitHubSetupModal). The shared
// FILES above do not include 130, so this describe has its own loader: 060 (UI_ICONS) + 130 with
// stubbed storage/clone helpers (lenient: 130 typeof-probes the optional Settings refreshers).
describe('ui settings › GitHub setup modal (S8C-02/S8C-04/A8C-01)', function() {
    afterEach(function() { U.cleanupAll(); var p = document.getElementById('github-setup-modal'); if (p) p.remove(); });
    async function loadGs(extra) {
        var win = { document: document, open: U.recorder(), addEventListener: function() {}, removeEventListener: function() {} };
        var g = Object.assign({ document: document, window: win, navigator: { userAgent: 'ui-test' },
            escapeHtml: function(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); },
            loadGitHubSettings: function() { return Promise.resolve({}); },
            validateGitHubToken: U.recorder(function() { return Promise.resolve({ ok: false, error: 'stub' }); }),
            saveGitHubSettings: U.recorder(function() { return Promise.resolve(); }),
            normalizeGitHubInstanceUrl: function(u) { return String(u || 'https://github.com').trim().replace(/\/+$/, ''); },
            _confirmReplaceExistingClone: U.recorder(function() { return Promise.resolve(true); }),
            wsClone: U.recorder(function() { return Promise.resolve({ success: true, message: 'Cloned' }); }) }, extra || {});
        var m = await loadModules(['src/js/core/060-ui-constants.js', 'src/js/tools/130-github-setup.js'],
            { workspace: WS, globals: g, lenient: true, passthrough: U.DOM_PASSTHROUGH });
        return { m: m, g: g };
    }
    function $gs(sel) { return document.querySelector('#github-setup-modal ' + sel); }
    async function settle() { await U.flush(); await U.flush(); }
    test('S8C-02 disconnected Enter in the repo field does nothing', async function() {
        var L = await loadGs();
        L.m.showGitHubSetupModal({ connected: false, instanceUrl: 'https://github.com' });
        U.input($gs('#ghsetup-repo'), 'o/r');
        fireKey($gs('#ghsetup-repo'), 'Enter', L.m); fireKey($gs('#ghsetup-branch'), 'Enter', L.m); await settle();
        assert.strictEqual(L.g._confirmReplaceExistingClone.calls.length, 0);
        assert.strictEqual(L.g.wsClone.calls.length, 0, 'no clone while not connected');
        assert.strictEqual($gs('#ghsetup-clone-btn').disabled, true, 'Clone still disabled');
        assert.strictEqual($gs('#ghsetup-clone-status').textContent, '');
    }, { tags: ['unit'] });
    test('S8C-02 connected double Enter clones once', async function() {
        var d = deferred(), L = await loadGs({ wsClone: U.recorder(function() { return d.promise; }) });
        L.m.showGitHubSetupModal({ connected: true, user: { login: 'octo' }, instanceUrl: 'https://github.com', repo: 'o/r' });
        var repo = $gs('#ghsetup-repo');
        fireKey(repo, 'Enter', L.m); fireKey(repo, 'Enter', L.m); await settle();
        assert.strictEqual(L.g._confirmReplaceExistingClone.calls.length, 1, 'one confirm for two Enters');
        assert.strictEqual(L.g.wsClone.calls.length, 1, 'one clone for two Enters');
        assert.strictEqual($gs('#ghsetup-clone-btn').disabled, true, 'Clone disabled while cloning');
        fireKey(repo, 'Enter', L.m); await settle();
        assert.strictEqual(L.g.wsClone.calls.length, 1, 'Enter while cloning is a no-op');
        d.resolve({ success: true, message: 'Cloned' }); await settle();
        assert.strictEqual($gs('#ghsetup-clone-btn').disabled, false, 'Clone re-enabled after the clone');
        assert.strictEqual($gs('#ghsetup-clone-status').textContent, 'Cloned');
        U.input(repo, 'o/r2'); fireKey(repo, 'Enter', L.m); await settle();
        assert.deepStrictEqual(L.g.wsClone.calls, [['o/r', undefined], ['o/r2', undefined]], 'busy flag released: the next clone goes through');
    }, { tags: ['unit'] });
    test('S8C-02 token double Enter validates once', async function() {
        var d = deferred(), L = await loadGs({ validateGitHubToken: U.recorder(function() { return d.promise; }) });
        L.m.showGitHubSetupModal({ connected: false, instanceUrl: 'https://github.com' });
        var tok = $gs('#ghsetup-token');
        U.input(tok, 'ghp_abc');
        fireKey(tok, 'Enter', L.m); fireKey(tok, 'Enter', L.m); await settle();
        assert.deepStrictEqual(L.g.validateGitHubToken.calls, [['ghp_abc', 'https://github.com']], 'one validation for two Enters');
        assert.strictEqual($gs('#ghsetup-connect-btn').disabled, true);
        d.resolve({ ok: false, error: 'Bad credentials' }); await settle();
        assert.strictEqual($gs('#ghsetup-connect-btn').disabled, false, 're-enabled after a failed validation');
        assert.strictEqual($gs('#ghsetup-connect-status').textContent, 'Bad credentials');
        fireKey(tok, 'Enter', L.m); await settle();
        assert.strictEqual(L.g.validateGitHubToken.calls.length, 2, 'enabled again: Enter validates');
        assert.strictEqual(L.g.saveGitHubSettings.calls.length, 0);
    }, { tags: ['unit'] });
    // S8C-04: the modal's labels had no for= and its status lines were not live regions.
    test('S8C-04 setup modal labels + live regions', async function() {
        var L = await loadGs();
        L.m.showGitHubSetupModal({ connected: false, instanceUrl: 'https://github.com' });
        assert.ok($gs('label[for="ghsetup-token"]'), 'token label is tied to its input');
        assert.ok($gs('label[for="ghsetup-instance"]'), 'instance label is tied to its input');
        assert.strictEqual($gs('#ghsetup-connect-status').getAttribute('role'), 'status');
        assert.strictEqual($gs('#ghsetup-connect-status').getAttribute('aria-live'), 'polite');
        L.m.showGitHubSetupModal({ connected: true, user: { login: 'octo' }, instanceUrl: 'https://github.com' });
        assert.strictEqual($gs('#ghsetup-repo').getAttribute('aria-label'), 'Repository (owner/repo)');
        assert.strictEqual($gs('#ghsetup-branch').getAttribute('aria-label'), 'Branch (optional)');
        assert.strictEqual($gs('#ghsetup-clone-status').getAttribute('role'), 'status');
        assert.strictEqual($gs('#ghsetup-clone-status').getAttribute('aria-live'), 'polite');
    }, { tags: ['unit'] });
    // A8C-01: the popup had no dialog semantics and no focus management. The sandbox iframe is
    // 0x0, so a real focus() never moves activeElement (ui-helpers.js "Sandbox limits");
    // simFocus() stands in for the browser: focus() records the connected element and
    // document.activeElement reports it. restore() puts both back.
    function simFocus() {
        var cur = null, proto = HTMLElement.prototype, orig = proto.focus;
        proto.focus = function() { if (document.contains(this)) cur = this; };
        Object.defineProperty(document, 'activeElement', { configurable: true,
            get: function() { return cur && document.contains(cur) ? cur : document.body; } });
        return { restore: function() { proto.focus = orig; delete document.activeElement; } };
    }
    async function withOpener(fn) {
        var L = await loadGs(), f = simFocus(), op = document.createElement('button');
        op.id = 'op'; document.body.appendChild(op);
        try { op.focus(); await fn(L, op); } finally { f.restore(); op.remove(); }
    }
    var DISCONNECTED = { connected: false, user: null, instanceUrl: 'https://github.com', repo: '', branch: '' };
    test('A8C-01 setup modal is a labelled modal dialog and takes focus', async function() {
        await withOpener(async function(L, op) {
            assert.strictEqual(document.activeElement, op, 'precondition: the opener has focus');
            L.m.showGitHubSetupModal(DISCONNECTED);
            var ov = document.getElementById('github-setup-modal');
            assert.strictEqual(ov.getAttribute('role'), 'dialog');
            assert.strictEqual(ov.getAttribute('aria-modal'), 'true');
            var lab = document.getElementById(ov.getAttribute('aria-labelledby') || '');
            assert.ok(lab && ov.contains(lab), 'aria-labelledby points inside the dialog');
            assert.match(lab.textContent, /GitHub Setup/);
            assert.ok(ov.contains(document.activeElement), 'focus moved into the dialog');
            assert.strictEqual(document.activeElement, $gs('#ghsetup-token'), 'on the token field');
        });
    }, { tags: ['unit'] });
    test('A8C-01 Tab wraps', async function() {
        await withOpener(async function(L) {
            L.m.showGitHubSetupModal(DISCONNECTED);
            function tab(el, shift) { var ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev; }
            var close = $gs('.modal-actions button'), first = $gs('#ghsetup-instance'), mid = $gs('#ghsetup-connect-btn');
            close.focus();
            assert.strictEqual(tab(close).defaultPrevented, true, 'Tab on the last control is handled');
            assert.strictEqual(document.activeElement, first, 'Tab from Close wraps to the first control');
            assert.strictEqual(tab(first, true).defaultPrevented, true, 'Shift+Tab on the first control is handled');
            assert.strictEqual(document.activeElement, close, 'Shift+Tab from the first control wraps to Close (the disabled Clone is skipped)');
            mid.focus();
            assert.strictEqual(tab(mid).defaultPrevented, false, 'Tab between controls keeps the native order');
            assert.strictEqual(document.activeElement, mid);
        });
    }, { tags: ['unit'] });
    test('A8C-01 re-render keeps the opener; close restores focus', async function() {
        await withOpener(async function(L, op) {
            L.m.showGitHubSetupModal(DISCONNECTED);
            L.m.showGitHubSetupModal({ connected: true, user: { login: 'octo' }, instanceUrl: 'https://github.com', repo: '', branch: '' });
            var ov = document.getElementById('github-setup-modal');
            assert.strictEqual(document.querySelectorAll('#github-setup-modal').length, 1, 'the re-render replaced the old dialog');
            assert.strictEqual(ov._opener, op, 'the first opener survives the re-render (focus was inside the old dialog)');
            assert.strictEqual(document.activeElement, $gs('#ghsetup-repo'), 'connected: focus on the repo field');
            L.m.closeGitHubSetupModal();
            assert.strictEqual(document.getElementById('github-setup-modal'), null, 'closed');
            assert.strictEqual(document.activeElement, op, 'focus returned to the opener');
        });
    }, { tags: ['unit'] });
});

describe('ui settings › tool inspector a11y (A8B3-01)', function() {
    // A8B3-01: the tool inspector had no dialog semantics, moved no focus, did not trap Tab and
    // did not return focus on close. Focus is simulated as in the GitHub setup modal describe
    // (the sandbox iframe is 0x0, so a real focus() never moves activeElement).
    afterEach(function() { U.cleanupAll(); var p = document.getElementById('tool-inspector-modal');
        if (p) { if (p._escHandler) document.removeEventListener('keydown', p._escHandler); p.remove(); } });
    function simFocus() {
        var cur = null, proto = HTMLElement.prototype, orig = proto.focus;
        proto.focus = function() { if (document.contains(this)) cur = this; };
        Object.defineProperty(document, 'activeElement', { configurable: true,
            get: function() { return cur && document.contains(cur) ? cur : document.body; } });
        return { restore: function() { proto.focus = orig; delete document.activeElement; } };
    }
    async function withInspector(fn, onTop) {
        var L = await load({ TOOLS: [{ function: { name: 'x', description: 'd' } }], TOOL_DISPLAY_NAMES: {},
            getToolFunctionSource: function() { return 'function x() {}'; } });
        var f = simFocus(), op = document.createElement('button'), top = null;
        op.id = 'op'; document.body.appendChild(op);
        if (onTop) { top = document.createElement('div'); top.className = 'modal-overlay show'; document.body.appendChild(top); }
        try { op.focus(); L.m.showToolInspector('x'); await fn(L, op, document.getElementById('tool-inspector-modal')); }
        finally { L.m.closeToolInspectorModal(); f.restore(); op.remove(); if (top) top.remove(); }
    }
    function key(k, shift) {
        var ev = new KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true, cancelable: true });
        document.dispatchEvent(ev);
        return ev.defaultPrevented;
    }
    function ring(ov) { return ov.querySelectorAll('button:not([disabled]), [tabindex="0"]'); }
    test('A8B3-01 inspector is a labelled modal dialog and takes focus', async function() {
        await withInspector(async function(L, op, ov) {
            assert.strictEqual(ov.getAttribute('role'), 'dialog');
            assert.strictEqual(ov.getAttribute('aria-modal'), 'true');
            var lab = document.getElementById(ov.getAttribute('aria-labelledby') || '');
            assert.ok(lab && ov.contains(lab), 'aria-labelledby points inside the dialog');
            assert.strictEqual(lab.textContent, 'x');
            assert.ok(ov.contains(document.activeElement), 'focus moved into the inspector');
            assert.strictEqual(document.activeElement.textContent, 'Close');
        });
    }, { tags: ['unit'] });
    test('A8B3-01 Tab wraps inside the inspector', async function() {
        await withInspector(async function(L, op, ov) {
            var n = ring(ov), first = n[0], last = n[n.length - 1];
            // the module's own getToolFunctionSource wins over the stub, so the source section
            // (and its copy button) may be absent: the ring is the copy button(s) + Close
            assert.ok(n.length >= 2, 'copy button(s) + Close');
            assert.ok(first.classList.contains('tool-code-copy-btn'), 'first control: the schema copy button');
            assert.strictEqual(last.textContent, 'Close', 'last control: Close');
            last.focus();
            assert.strictEqual(key('Tab'), true, 'Tab on the last control is prevented');
            assert.strictEqual(document.activeElement, first, 'wraps to the first control');
            assert.strictEqual(key('Tab', true), true, 'Shift+Tab on the first control is prevented');
            assert.strictEqual(document.activeElement, last, 'wraps to the last control');
            op.focus();
            assert.strictEqual(key('Tab'), true, 'focus outside the dialog is pulled back in');
            assert.strictEqual(document.activeElement, first);
        });
    }, { tags: ['unit'] });
    test('A8B3-01 close restores focus to the opener', async function() {
        await withInspector(async function(L, op, ov) {
            ov.querySelector('.modal-actions .modal-btn').focus();
            L.m.closeToolInspectorModal();
            assert.strictEqual(document.getElementById('tool-inspector-modal'), null, 'closed');
            assert.strictEqual(document.activeElement, op, 'focus returned to the opener');
            L.m.showToolInspector('x');
            key('Escape');
            assert.strictEqual(document.getElementById('tool-inspector-modal'), null, 'Escape still closes');
            assert.strictEqual(document.activeElement, op, 'Escape also returns focus');
        });
    }, { tags: ['unit'] });
    test('A8B3-01 Tab is ignored while a confirm is on top', async function() {
        await withInspector(async function(L, op, ov) {
            var n = ring(ov), last = n[n.length - 1];
            last.focus();
            assert.strictEqual(key('Tab'), false, 'Tab is left to the overlay on top');
            assert.strictEqual(document.activeElement, last, 'focus not moved');
            key('Escape');
            assert.ok(document.getElementById('tool-inspector-modal'), 'Escape is left to the overlay on top too');
        }, true);
    }, { tags: ['unit'] });
});
