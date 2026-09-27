// A8B-01 — "Show API call statistics" has two twin checkboxes: the gear box
// (body.html #show-api-stats) and the Settings-page row (040-tools-settings.js
// #settings-show-api-stats). Both used to call toggleApiStats() (a blind flip)
// and nothing re-synced the static gear box, so after a Settings-page toggle
// the gear box went stale and the next gear click inverted the value.
// These tests load the REAL 240-layout.js (and the real renderSettingsPage from
// 040) into the REAL body.html DOM and drive the rendered inline handlers.
// Run: run_tests { files: ['test/settings-toggle-twins.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var ICONS = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js'];
// 240/040 probe many optional globals behind typeof guards; every behaviour
// below is still asserted.
var ANY_UNSTUBBED = { indexOf: function() { return 0; } };

function winStub() {
    var mq = { matches: false, addEventListener: function() {}, addListener: function() {} };
    return fakeWindow({ document: document, _rawCopyStore: {}, isRunning: false, open: U.recorder(),
        matchMedia: function() { return mq; } });
}
function appStorageStub() {
    var data = {};
    return { data: data, setItem: function(k, v) { data[k] = String(v); },
        getItem: function(k) { return k in data ? data[k] : null; }, removeItem: function(k) { delete data[k]; } };
}
async function setup(paths, extra) {
    var st = appStorageStub(), renders = U.recorder(), win = winStub();
    var globals = Object.assign({ window: win, appStorage: st, showApiStats: true, renderMessages: renders,
        appTheme: 'light', sidebarCollapsed: true, historyExpanded: true }, extra || {});
    var m = await U.loadUi(ICONS.concat(paths), { globals: globals, lenient: true, allowUnstubbed: ANY_UNSTUBBED, window: win });
    var dom = await U.mountDom({ body: true });
    return { m: m, st: st, renders: renders, dom: dom };
}

describe('A8B-01 settings twins: Show API call statistics', function() {
    afterEach(function() { U.cleanupAll(); });

    test('A8B-01: gear #show-api-stats follows a Settings-page toggle and never inverts', async function() {
        var s = await setup(['src/js/ui/240-layout.js']);
        var gear = s.dom.$('#show-api-stats');
        assert.ok(gear, 'gear twin rendered from body.html');
        gear.checked = true;
        // Settings-page uncheck: the row passes this.checked === false.
        s.m.toggleApiStats(false);
        assert.strictEqual(s.m.__scope.showApiStats, false, 'value follows the explicit argument');
        assert.strictEqual(gear.checked, false, 'gear twin is synced, not left stale');
        assert.strictEqual(s.st.data.showApiStats, 'false', 'persisted');
        // Next gear click checks the box: the value follows the box.
        gear.checked = true;
        U.fireInline(gear, 'change', s.m);
        assert.strictEqual(s.m.__scope.showApiStats, true, 'gear check turns stats on');
        assert.strictEqual(gear.checked, true);
        assert.strictEqual(s.st.data.showApiStats, 'true');
        // Even with a stale box, unchecking it can never invert the value to true
        // (the old blind flip turned false into true here).
        s.m.__scope.showApiStats = false;
        gear.checked = false;
        U.fireInline(gear, 'change', s.m);
        assert.strictEqual(s.m.__scope.showApiStats, false, 'unchecking the gear never inverts the value');
        assert.strictEqual(gear.checked, false);
        // A call with no argument keeps the legacy flip.
        s.m.toggleApiStats();
        assert.strictEqual(s.m.__scope.showApiStats, true, 'no-arg call still flips');
        assert.strictEqual(gear.checked, true, 'and syncs the gear twin');
        assert.strictEqual(s.renders.calls.length, 4, 'renderMessages once per toggle');
    }, { tags: ['unit'] });

    test('A8B-01: Settings row has id settings-show-api-stats and both twins pass this.checked', async function() {
        var s = await setup(['src/js/ui/040-tools-settings.js', 'src/js/ui/240-layout.js'], {
            CSS: CSS, showSnackbar: U.recorder(), apiProviders: [], llmEndpoints: [], currentProvider: null, DEFAULT_API_PROVIDERS: [],
            getAssumedContextTokens: function() { return 200000; }, getGlobalMaxTokens: function() { return 16000; },
            getGlobalThinkingBudget: function() { return 0; }, hooksEnabled: {}
        });
        var gear = s.dom.$('#show-api-stats');
        assert.strictEqual(gear.getAttribute('onchange'), 'toggleApiStats(this.checked)', 'gear twin passes its state');
        // Render the REAL Settings page into body.html's #settings-page-content.
        // The Display rows are in the DOM once innerHTML is set; the section
        // fillers that run after it need unrelated globals, so their errors are kept only for the message.
        var renderErr = null;
        try { s.m.renderSettingsPage(); } catch (e) { renderErr = e; }
        var row = s.dom.$('#settings-page-content #settings-show-api-stats');
        assert.ok(row, 'Settings row checkbox has id settings-show-api-stats' + (renderErr ? ' (render error: ' + renderErr.message + ')' : ''));
        assert.strictEqual(row.getAttribute('onchange'), 'toggleApiStats(this.checked)', 'Settings twin passes its state');
        assert.strictEqual(row.checked, true, 'rendered from showApiStats');
        gear.checked = true;
        // Settings-page uncheck: the gear twin follows.
        row.checked = false;
        U.fireInline(row, 'change', s.m);
        assert.strictEqual(s.m.__scope.showApiStats, false, 'Settings uncheck turns stats off');
        assert.strictEqual(gear.checked, false, 'gear twin follows the Settings row');
        // Gear check: the Settings twin follows.
        gear.checked = true;
        U.fireInline(gear, 'change', s.m);
        assert.strictEqual(s.m.__scope.showApiStats, true, 'gear check turns stats on');
        assert.strictEqual(row.checked, true, 'Settings twin follows the gear');
    }, { tags: ['unit'] });
});
