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
            getTierAliasMap: function() { return Object.assign({}, map); }, saveTierAliases: save || U.recorder(function() { return Promise.resolve(); }) };
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
        var tg = tierGlobals(), L = await load(tg), dom = await U.mountDom({ html: '<div id="tier-aliases-list"></div>' });
        L.m.renderTierAliasSettings();
        var sel = dom.$$('select')[0];
        sel.value = '<b>X</b>';
        U.fireInline(sel, 'change', L.m);
        assert.strictEqual(tg.saveTierAliases.calls.length, 1);
        assert.deepStrictEqual(tg.saveTierAliases.calls[0][0], { small: '<b>X</b>', medium: 'same', large: 'Gone' });
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
});

describe('ui settings › API providers list', function() {
    afterEach(function() { U.cleanupAll(); });
    var OR = 'https://openrouter.ai/api/v1/chat/completions';
    function provGlobals() {
        var sub = { name: 'Sub', isChatGPTOAuth: true, model: 'gpt-5' };
        return { apiProviders: [{ name: "O'R " + HOSTILE, endpoint: OR, model: 'm', provider: 'openrouter' }, sub], DEFAULT_API_PROVIDERS: [sub],
            currentProvider: 'Sub', llmEndpoints: [], changeProvider: U.recorder() };
    }
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
});

describe('ui settings › GitHub connect section', function() {
    afterEach(function() { U.cleanupAll(); });
    var MOUNT = '<div id="github-settings-container"></div>';
    function ghGlobals(state) {
        return { loadGitHubSettings: function() { return Promise.resolve(state.gh); }, validateGitHubToken: U.recorder(function() { return state.validate; }),
            saveGitHubSettings: U.recorder(function(t, u, user) { state.gh = { token: t, instanceUrl: u, user: user }; return Promise.resolve(); }),
            clearGitHubSettings: U.recorder(function() { state.gh = {}; return Promise.resolve(); }),
            normalizeGitHubInstanceUrl: function(u) { return String(u || 'https://github.com').trim().replace(/\/+$/, ''); },
            getDeployDirHandle: function() { return Promise.resolve(state.dir || null); }, renderGitHubReposList: undefined };
    }
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
        var L = await load({ currentChatId: 'me', chats: { other: { title: 'Other <chat>' } }, selectChat: U.recorder(),
            showConfirmModal: U.recorder(function() { return Promise.resolve(false); }), wsClone: U.recorder(function() { return Promise.resolve({ success: false, error: 'nope' }); }) });
        cur = L;
        L.m.__scope._wsHeaderCaches = caches(opts.mine);
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
    test('"This chat" section pinned under the title; all repo sections start collapsed; no chip for own files', async function() {
        var L = await open({ mine: true });
        var tc = L.dd.children[1];
        assert.ok(tc.classList.contains('ws-this-chat-section'));
        assert.match(tc.querySelector('.ws-dd-title').textContent, /This chat1$/);
        assert.strictEqual(tc.querySelector('.ws-file-group-label').textContent, 'o/a \u00b7 main');
        assert.strictEqual(tc.querySelector('.ws-file-path').textContent, 'mine.js');
        assert.strictEqual(tc.querySelector('.ws-file-chat'), null);
        assert.ok(sec(L, 'o/a::main').classList.contains('collapsed'));
        assert.ok(sec(L, 'o/b::dev').classList.contains('collapsed'));
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
