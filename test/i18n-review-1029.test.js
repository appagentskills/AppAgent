// PR #1029 (i18n) review follow-ups: real source, stubs only for host effects.
// Run: run_tests { files: ['test/i18n-review-1029.test.js'] }
var WS = args.workspace;
var CORE = 'src/js/core/025-i18n.js';
function load(globals) { return loadModules([CORE], { workspace: WS, globals: globals || {} }); }
function fetchMap(map) {
    var f = function(url) {
        f.calls.push(url);
        var code = String(url).replace(/^.*\/locales\//, '').replace(/\.json$/, ''), v = map[code];
        if (v === 404 || v === undefined) return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({ ok: true, json: function() { return Promise.resolve(v); } });
    };
    f.calls = [];
    return f;
}
// Pull one top-level function out of a source file (for helpers that are not exported).
async function fnOf(path, name) {
    var src = await loadFile(path, WS), at = src.indexOf('function ' + name + '(');
    if (at < 0) throw new Error(name + ' not found in ' + path);
    var i = src.indexOf('{', at), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return new Function('return (' + src.slice(at, i + 1) + ');')();
}

describe('i18n core › tn with non-number counts (fix 4)', function() {
    test('null/undefined/NaN/abc/Infinity take the other form and {count} renders as empty', async function() {
        var m = await load();
        [undefined, null, NaN, 'abc', '', Infinity, true].forEach(function(c) {
            assert.strictEqual(m.tn(c, '{count} file', '{count} files'), ' files', 'count=' + String(c));
        });
        assert.strictEqual(m.tn(1, '{count} file', '{count} files'), '1 file');
        assert.strictEqual(m.tn('3', '{count} file', '{count} files'), '3 files');
        assert.strictEqual(m.tn(null, '{count} file', '{count} files', { count: 'some' }), 'some files', 'params.count wins');
    }, { tags: ['unit'] });
    test('catalog plural object without other falls back to the English form', async function() {
        var m = await load();
        m.i18nSetCatalog('fr', { '{count} files': { one: '{count} fichier' } });
        await m.i18nInit({ language: 'fr', browserLanguages: [] });
        assert.strictEqual(m.tn(1, '{count} file', '{count} files'), '1 fichier');
        assert.strictEqual(m.tn(5, '{count} file', '{count} files'), '5 files');
        assert.strictEqual(m.t('{count} files'), '{count} files', 't() without other -> key');
    }, { tags: ['unit'] });
    test('t does not escape and does not re-expand {y} inside a param value', async function() {
        var m = await load();
        assert.strictEqual(m.t('{x} and {y}', { x: '<b>{y}</b>', y: 'Y' }), '<b>{y}</b> and Y');
    }, { tags: ['unit'] });
});

describe('i18n core › failed catalog retry (fix 3)', function() {
    test('a failed fetch is cached for implicit inits; an explicit {language} re-init fetches again', async function() {
        var map = { fr: 404 }, f = fetchMap(map);
        var m = await load({ getSetting: async function() { return 'fr'; }, navigator: { languages: [] }, chrome: fakeChrome(), fetch: f });
        assert.strictEqual(await m.i18nInit(), 'en');
        assert.strictEqual(await m.i18nInit(), 'en');
        assert.strictEqual(f.calls.length, 1, 'implicit re-init inside the TTL does not refetch');
        map.fr = { Save: 'Enregistrer' };
        assert.strictEqual(await m.i18nInit({ language: 'fr' }), 'fr');
        assert.strictEqual(f.calls.length, 2);
        assert.strictEqual(m.t('Save'), 'Enregistrer');
    }, { tags: ['unit'] });
});

describe('i18n core › i18nFormatRelative boundaries (fix 8)', function() {
    test('-59s/-60s/-3600s/-6d/-7d, numeric always keeps the past sign, bad now falls back', async function() {
        var m = await load(), now = Date.UTC(2026, 0, 10, 12), rel = function(s, o) { return m.i18nFormatRelative(now + s * 1000, Object.assign({ now: now }, o || {})); };
        assert.match(rel(-59), /now/);
        assert.match(rel(-60), /1 min.*ago/);
        assert.match(rel(-3600), /1 h.*ago/);
        assert.match(rel(-6 * 86400), /6 days ago/);
        assert.match(rel(-7 * 86400), /last w/);
        assert.match(rel(-30, { numeric: 'always' }), /0 sec.*ago/, 'past stays past');
        assert.match(rel(30, { numeric: 'always' }), /^in 0 sec/);
        assert.match(m.i18nFormatRelative(Date.now() - 120000, { now: 'garbage' }), /2 min/);
    }, { tags: ['unit'] });
    test('formatNumber(true/false/0) and formatDate("12345678"/0)', async function() {
        var m = await load();
        assert.strictEqual(m.i18nFormatNumber(0), '0');
        assert.strictEqual(m.i18nFormatNumber(true), '1');
        assert.strictEqual(m.i18nFormatNumber(false), '0');
        assert.notStrictEqual(m.i18nFormatDate('12345678', { timeZone: 'UTC' }), '1/1/1970', '8 digits is not an epoch (needs 9+)');
        assert.strictEqual(m.i18nFormatDate(0, { timeZone: 'UTC' }), '1/1/1970');
    }, { tags: ['unit'] });
    test('locale matching: fr_CA, fr-!!, fr-Latn-FR, iw, es-419, padded de', async function() {
        var m = await load();
        assert.strictEqual(m.resolveI18nLanguage('fr_CA'), 'fr-CA');
        assert.strictEqual(m.resolveI18nLanguage('fr-!!'), 'fr');
        assert.strictEqual(m.resolveI18nLanguage('fr-Latn-FR'), 'fr');
        assert.strictEqual(m.resolveI18nLanguage('iw'), 'he');
        assert.strictEqual(m.resolveI18nLanguage('es-419'), 'es');
        assert.strictEqual(m.resolveI18nLanguage('  de  '), 'de');
    }, { tags: ['unit'] });
});

describe('page toolbars follow the language (fix 2)', function() {
    test('ensurePageSearchToolbar relabels in place on a second call and keeps the typed query', async function() {
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var lang = { v: 'A' };
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/045-page-layout.js', 'src/js/ui/046-settings-help-search.js'],
            { lenient: true, allowUnstubbed: { indexOf: function() { return 0; } }, globals: { appStorage: { getItem: function() { return null; }, setItem: function() {} },
                N_: function(s) { return s; }, t: function(k) { return lang.v + ':' + k; } } });
        var dom = await U.mountDom({ body: true });
        try {
            var slot = m.ensurePageSearchToolbar('settings-toolbar-slot', { placeholder: 'A', label: 'LA', onInput: 'settingsOnSearchInput', countId: 'c1', layoutFn: 'x' });
            var input = slot.querySelector('input[type=search]');
            input.value = 'theme';
            lang.v = 'B';
            m.ensurePageSearchToolbar('settings-toolbar-slot', { placeholder: 'B', label: 'LB', onInput: 'settingsOnSearchInput', countId: 'c1', layoutFn: 'x' });
            assert.strictEqual(slot.querySelectorAll('input').length, 1);
            assert.strictEqual(slot.querySelector('input[type=search]'), input, 'same node');
            assert.strictEqual(input.getAttribute('placeholder'), 'B');
            assert.strictEqual(input.getAttribute('aria-label'), 'LB');
            assert.strictEqual(input.value, 'theme', 'typed query kept');
            assert.strictEqual(slot.querySelector('[data-layout="gallery"] span').textContent, 'B:Gallery');
            assert.strictEqual(slot.querySelector('[data-layout="rows"]').getAttribute('title'), 'B:Rows');
            assert.strictEqual(slot.querySelector('.widget-library-layout').getAttribute('aria-label'), 'B:Layout');
        } finally { U.cleanupAll(); }
    }, { tags: ['unit'] });
    test('050 re-render path calls pageLayoutRelabel for an already-filled toggle', async function() {
        var src = await loadFile('src/js/ui/050-history-view.js', WS);
        assert.match(src, /else if \(layoutSlot && typeof pageLayoutRelabel === 'function'\) \{\s*pageLayoutRelabel\(layoutSlot\)/);
    }, { tags: ['unit'] });
});

describe('build locales parity (fix 6)', function() {
    test('both builds target locales/, filter to top-level .json, loader path matches, deploy is after the abort', async function() {
        var node = await loadFile('build/build.js', WS), sk = await loadFile('skills/extension-dev/build.js', WS), core = await loadFile(CORE, WS);
        assert.match(node, /outputFiles\['locales\/' \+ locale\]/);
        assert.match(node, /if \(!locale\.endsWith\('\.json'\)\) continue;/);
        assert.match(sk, /path: "src\/locales",\s*dest: "locales",\s*ext: "\.json",\s*flat: true/);
        assert.match(core, /chrome\.runtime\.getURL\('locales\/' \+ c \+ '\.json'\)/);
        assert.ok(sk.indexOf('path: "src/locales"') > sk.indexOf('if (writeFailures.length > 0) {'), 'locales deploy after the write-failure abort');
        var inc = await fnOf('src/js/tools/020-tool-execution.js', 'wsDeployIncludes');
        assert.strictEqual(inc('fr.json', { ext: '.json', flat: true }), true);
        assert.strictEqual(inc('README.md', { ext: '.json', flat: true }), false);
        assert.strictEqual(inc('sub/fr.json', { ext: '.json', flat: true }), false);
        assert.strictEqual(inc('.json', { ext: '.json' }), false);
        assert.strictEqual(inc('any/x.png'), true, 'no opts = every file (icons deploy unchanged)');
    }, { tags: ['unit'] });
});

describe('deroulement ls markers', function() {
    test('lsEntryNames strips " *" and "(N files)" so the CSS filter sees every file', async function() {
        var f = await fnOf('skills/feature-deroulement/deroulement.js', 'lsEntryNames');
        assert.deepStrictEqual(f(['00-tokens.css', '18-panels.css *', 'sub/ (3 files)', 'one/ (1 file)', { name: 'x.css' }, null]),
            ['00-tokens.css', '18-panels.css', 'sub/', 'one/', 'x.css']);
        assert.deepStrictEqual(f(undefined), []);
    }, { tags: ['unit'] });
});

describe('file-download escapes the URL id (fix 5)', function() {
    test('the not-found message escapes fileId and the debug log', async function() {
        var src = await loadFile('src/platform/extension/file-download.js', WS);
        assert.match(src, /t\('File not found: \{id\}', \{ id: esc\(fileId\) \}\)/);
        assert.match(src, /esc\(log\.join\('\\n'\)\)/);
        assert.ok(!/\{ id: fileId \}/.test(src), 'no raw fileId');
    }, { tags: ['unit'] });
});
