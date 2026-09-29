// i18n runtime core (src/js/core/025-i18n.js) + the harness auto-include.
// Real source through loadModules with NO globals (strict scope: a host global
// touched at load or by t/tn/N_/formatters would throw). navigator/getSetting/
// chrome/fetch are fakes; dates use timeZone 'UTC'.
var I18N_CORE = 'src/js/core/025-i18n.js';
var I18N_WS = args.workspace;
var UTC = { timeZone: 'UTC' };
function i18nLoad(globals) { return loadModules([I18N_CORE], { workspace: I18N_WS, globals: globals || {} }); }
function sp(s) { return String(s).replace(/[\u00a0\u202f]/g, ' '); }
function fetchFake(map, delays) {
    var f = function(url) {
        f.calls.push(url);
        var code = String(url).replace(/^.*\/locales\//, '').replace(/\.json$/, ''), v = map[code];
        return new Promise(function(res) { setTimeout(res, (delays && delays[code]) || 0); }).then(function() {
            if (v instanceof Error) throw v;
            if (v === 404) return { ok: false, status: 404 };
            return { ok: true, status: 200, json: function() { return Promise.resolve(v); } };
        });
    };
    f.calls = [];
    return f;
}
function hostGlobals(pref, langs, map, delays) {
    return { getSetting: async function(k, d) { return pref === undefined ? d : pref; }, navigator: { languages: langs, language: langs[0] }, chrome: fakeChrome(), fetch: fetchFake(map || {}, delays) };
}

describe('i18n core: English identity, no host globals', function() {
    test('loads + t/tn/N_/formatters in a strict empty scope', async function() {
        var m = await i18nLoad();
        assert.strictEqual(m.t('Save'), 'Save');
        assert.strictEqual(m.t('Hello {name}', { name: 'Ann' }), 'Hello Ann');
        assert.strictEqual(m.t('Hi {name} {x}', { name: null }), 'Hi {name} {x}', 'missing/null params stay verbatim');
        assert.strictEqual(m.t('A {x}', { x: '$&' }), 'A $&');
        assert.strictEqual(m.t('A {0}', 'zz'), 'A {0}');
        assert.strictEqual(m.t('{toString}', {}), '{toString}', 'own props only');
        assert.strictEqual(m.t(null), ''); assert.strictEqual(m.t(42), '42');
        assert.strictEqual(m.tn(1, '{count} file', '{count} files'), '1 file');
        assert.strictEqual(m.tn(0, '{count} file', '{count} files'), '0 files');
        assert.strictEqual(m.tn('1', '{count} file', '{count} files'), '1 file');
        assert.strictEqual(m.tn(1234, '{count} file', '{count} files'), '1,234 files');
        assert.strictEqual(m.tn(3, '{count} x', '{count} xs', { count: 'three' }), 'three xs');
        assert.strictEqual(m.tn(2, '{count} file in {d}', '{count} files in {d}', { d: 'src' }), '2 files in src');
        var obj = {}; assert.strictEqual(m.N_(obj), obj); assert.strictEqual(m.N_('Label'), 'Label');
        assert.strictEqual(m.i18nFormatNumber(1234.5), '1,234.5');
        assert.strictEqual(m.i18nFormatNumber(0.5, { style: 'percent' }), '50%');
        assert.strictEqual(m.i18nFormatNumber(1234.5, { style: 'bogus' }), '1,234.5', 'bad opts retried without');
        assert.strictEqual(m.i18nFormatNumber(null), ''); assert.strictEqual(m.i18nFormatNumber(''), ''); assert.strictEqual(m.i18nFormatNumber('abc'), 'abc');
        var d = Date.UTC(2026, 8, 28, 13, 5, 0);
        assert.strictEqual(m.i18nFormatDate(d, UTC), '9/28/2026');
        assert.strictEqual(sp(m.i18nFormatTime(new Date(d), UTC)), '1:05:00 PM');
        assert.strictEqual(sp(m.i18nFormatDateTime(new Date(d).toISOString(), UTC)), sp(new Date(d).toLocaleString('en', UTC)));
        assert.strictEqual(m.i18nFormatDate(String(d), UTC), '9/28/2026', 'epoch-ms strings');
        assert.strictEqual(m.i18nFormatDate(d, { timeZone: 'UTC', dateStyle: 'bogus' }).length > 0, true);
        assert.strictEqual(m.i18nFormatDate('not a date'), 'not a date'); assert.strictEqual(m.i18nFormatDate(null), ''); assert.strictEqual(m.i18nFormatDate(new Date(NaN)), 'Invalid Date');
        assert.deepStrictEqual(m.__unstubbed, []);
        assert.strictEqual(m.i18nLang(), 'en'); assert.strictEqual(m.i18nLocale(), 'en'); assert.strictEqual(m.i18nDir(), 'ltr');
        assert.strictEqual(m.i18nResponseLanguageInstruction(), '');
    });
    test('i18nFormatRelative: default style short, truncation, future, long/narrow', async function() {
        var m = await i18nLoad(), now = Date.UTC(2026, 8, 28, 12, 0, 0), R = function(sec, o) { return sp(m.i18nFormatRelative(now + sec * 1000, Object.assign({ now: now }, o || {}))); };
        assert.deepStrictEqual([R(-10), R(-300), R(-3599), R(-7200), R(-86400), R(-3 * 86400), R(-14 * 86400), R(-60 * 86400), R(-800 * 86400), R(3 * 3600)],
            ['now', '5 min. ago', '59 min. ago', '2 hr. ago', 'yesterday', '3 days ago', '2 wk. ago', '2 mo. ago', '2 yr. ago', 'in 3 hr.']);
        assert.strictEqual(R(-300, { style: 'long' }), '5 minutes ago'); assert.strictEqual(R(-300, { style: 'narrow' }), '5m ago');
        assert.strictEqual(m.i18nFormatRelative(null), ''); assert.strictEqual(m.i18nFormatRelative('nope'), 'nope');
    });
    test('source: typeof only inside i18nInit; DOM-free; no use strict', async function() {
        var src = await loadFile(I18N_CORE, I18N_WS);
        var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/'[^'\n]*'|"[^"\n]*"/g, "''");
        var s = code.indexOf('async function i18nInit('), rest = code.slice(s + 1), e = s + 1 + rest.search(/\n(async function|function|var) /);
        assert.ok(s > 0 && e > s);
        assert.strictEqual(((code.slice(0, s) + code.slice(e)).match(/\btypeof\b/g) || []).length, 0);
        assert.ok(/\btypeof\b/.test(code.slice(s, e)));
        assert.ok(!/\b(window|document)\b/.test(code), 'DOM-free'); assert.ok(src.indexOf('use strict') < 0);
    });
});

describe('i18n core: languages + resolution', function() {
    test('I18N_LANGUAGES: en + 24 in ServiceNow order, rtl = ar/he', async function() {
        var m = await i18nLoad(), L = m.I18N_LANGUAGES;
        assert.deepStrictEqual(L.map(function(l) { return l.code; }), ['en', 'ar', 'pt-BR', 'zh-CN', 'zh-TW', 'cs', 'da', 'nl', 'fi', 'fr', 'fr-CA', 'de', 'he', 'hu', 'it', 'ja', 'ko', 'nb', 'pl', 'pt-PT', 'ru', 'es', 'sv', 'th', 'tr']);
        assert.deepStrictEqual(L.filter(function(l) { return l.dir === 'rtl'; }).map(function(l) { return l.code; }), ['ar', 'he']);
        assert.ok(L.every(function(l) { return l.name && l.nativeName && (l.dir === 'ltr' || l.dir === 'rtl'); }));
        assert.strictEqual(L[9].nativeName, 'Fran\u00e7ais');
    });
    test('resolveI18nLanguage is pure and follows the contract order', async function() {
        var m = await i18nLoad(), r = m.resolveI18nLanguage;
        var cases = [['fr', null, 'fr'], ['FR', null, 'fr'], ['fr_CA', null, 'fr-CA'], ['fr-BE', null, 'fr'], ['pt', null, 'pt-BR'], ['pt-PT', null, 'pt-PT'], ['pt-AO', null, 'pt-BR'],
            ['zh', null, 'zh-CN'], ['zh-Hans-SG', null, 'zh-CN'], ['zh-SG', null, 'zh-CN'], ['zh-Hant', null, 'zh-TW'], ['zh-Hant-HK', null, 'zh-TW'], ['zh-HK', null, 'zh-TW'], ['zh-TW', null, 'zh-TW'],
            ['no', null, 'nb'], ['nn', null, 'nb'], ['nb-NO', null, 'nb'], ['en-GB', null, 'en'], ['auto', ['de-DE', 'en'], 'de'], ['auto', 'es-MX', 'es'], ['xx', ['xx-YY', 'ja-JP'], 'ja'],
            ['auto', [], 'en'], [undefined, undefined, 'en'], ['auto', ['xx'], 'en'], [{}, 5, 'en']];
        cases.forEach(function(c) { assert.strictEqual(r(c[0], c[1]), c[2], JSON.stringify(c)); });
        assert.strictEqual(m.i18nLang(), 'en');
    });
});

describe('i18n core: catalogs, plurals, init', function() {
    test('catalog lookup, plural forms, setCatalog(null) deletes', async function() {
        var m = await i18nLoad();
        assert.strictEqual(m.i18nSetCatalog('xx', {}), false); assert.strictEqual(m.i18nSetCatalog('fr', []), false); assert.strictEqual(m.i18nSetCatalog('fr', 'x'), false);
        assert.strictEqual(m.i18nSetCatalog('FR', { 'Save': 'Enregistrer', 'Hello {name}': 'Bonjour {name}', 'Empty': '', 'Obj': { one: 'x', other: 'Objet' }, '{count} files': { one: '{count} fichier', other: '{count} fichiers' } }), true);
        assert.strictEqual(await m.i18nInit({ language: 'fr', browserLanguages: [] }), 'fr');
        assert.strictEqual(m.t('Save'), 'Enregistrer'); assert.strictEqual(m.t('Hello {name}', { name: 'Ann' }), 'Bonjour Ann');
        assert.strictEqual(m.t('Empty'), 'Empty'); assert.strictEqual(m.t('Obj'), 'Objet'); assert.strictEqual(m.t('toString'), 'toString');
        assert.strictEqual(m.tn(1, '{count} file', '{count} files'), '1 fichier'); assert.strictEqual(sp(m.tn(1234, '{count} file', '{count} files')), '1 234 fichiers');
        assert.strictEqual(sp(m.i18nFormatNumber(1234.5)), '1 234,5'); assert.strictEqual(m.i18nFormatDate(Date.UTC(2026, 8, 28), UTC), '28/09/2026');
        assert.strictEqual(sp(m.i18nFormatRelative(Date.UTC(2026, 8, 28, 11, 55), { now: Date.UTC(2026, 8, 28, 12, 0) })), 'il y a 5 min');
        assert.strictEqual(m.i18nResponseLanguageInstruction(), "The user's interface language is French (Fran\u00e7ais). Reply in French unless the user writes in another language or asks otherwise. Keep code, identifiers, table/field names, sys_ids and tool arguments unchanged.");
        m.i18nSetCatalog('ru', { '{count} files': { one: '{count} файл', few: '{count} файла', many: '{count} файлов', other: '{count} файла' }, 'P': 'plain', 'N': { one: 'a' } });
        await m.i18nInit({ language: 'ru', browserLanguages: [] });
        assert.deepStrictEqual([1, 2, 5, 21].map(function(n) { return m.tn(n, '{count} file', '{count} files'); }), ['1 файл', '2 файла', '5 файлов', '21 файл']);
        assert.strictEqual(m.tn(5, 'p', 'P'), 'plain'); assert.strictEqual(m.tn(5, 'n', 'N'), 'N', 'no usable form -> English other');
        m.i18nSetCatalog('ar', { 'K': { zero: 'z', one: 'o', two: 't', few: 'f', many: 'm', other: 'x' } });
        await m.i18nInit({ language: 'ar', browserLanguages: [] });
        assert.deepStrictEqual([0, 1, 2, 3, 11, 100].map(function(n) { return m.tn(n, 'k', 'K'); }), ['z', 'o', 't', 'f', 'm', 'x']);
        assert.strictEqual(m.i18nDir(), 'rtl'); assert.ok(m.i18nResponseLanguageInstruction().indexOf('Arabic (العربية)') > 0);
        assert.strictEqual(m.i18nSetCatalog('ar', null), true); assert.strictEqual(m.tn(0, 'k', 'K'), 'K');
        assert.deepStrictEqual(m.__unstubbed, [], 'catalog-only init touches no host global');
    });
    test('i18nInit: setting + faked navigator, fetch once, locale from browser tag', async function() {
        var g = hostGlobals('auto', ['fr-FR', 'en'], { fr: { 'Save': 'Enregistrer' } }), m = await i18nLoad(g);
        assert.strictEqual(await m.i18nInit(), 'fr');
        assert.deepStrictEqual(g.fetch.calls, ['chrome-extension://fake-extension-id/locales/fr.json']);
        assert.strictEqual(m.i18nLocale(), 'fr-FR'); assert.strictEqual(m.t('Save'), 'Enregistrer');
        assert.strictEqual(await m.i18nInit(), 'fr'); assert.strictEqual(g.fetch.calls.length, 1, 'cached');
        var g2 = hostGlobals(undefined, ['en-GB', 'en']), m2 = await i18nLoad(g2);
        assert.strictEqual(await m2.i18nInit(), 'en'); assert.strictEqual(m2.i18nLocale(), 'en-GB'); assert.strictEqual(g2.fetch.calls.length, 0, 'never fetches en');
        var g3 = hostGlobals('pt-PT', ['pt-BR']), m3 = await i18nLoad(g3);
        g3.fetch = null; assert.strictEqual(await m3.i18nInit(), 'en', 'no fetch -> English');
    });
    test('i18nInit failures fall back to English, cached; setCatalog clears; dedupe + latest wins', async function() {
        var g = hostGlobals('it', ['en'], { it: new Error('net'), de: 404, es: [1], nl: { A: 'B' }, fr: { A: 'F' }, sv: { A: 'S' } }, { fr: 40 }), m = await i18nLoad(g);
        assert.strictEqual(await m.i18nInit(), 'en'); assert.strictEqual(await m.i18nInit(), 'en'); assert.strictEqual(g.fetch.calls.length, 1, 'failure cached');
        assert.strictEqual(await m.i18nInit({ language: 'de' }), 'en'); assert.strictEqual(await m.i18nInit({ language: 'es' }), 'en');
        m.i18nSetCatalog('it', { A: 'I' }); assert.strictEqual(await m.i18nInit(), 'it'); assert.strictEqual(m.t('A'), 'I');
        var both = await Promise.all([m.i18nInit({ language: 'nl' }), m.i18nInit({ language: 'nl' })]);
        assert.strictEqual(both[1], 'nl', 'a superseded call does not activate; the latest does'); assert.strictEqual(m.i18nLang(), 'nl'); assert.strictEqual(g.fetch.calls.filter(function(u) { return /nl\.json$/.test(u); }).length, 1);
        await Promise.all([m.i18nInit({ language: 'fr' }), m.i18nInit({ language: 'sv' })]);
        assert.strictEqual(m.i18nLang(), 'sv', 'the latest call wins over a slower earlier fetch');
        var bad = hostGlobals('fr', ['fr']); bad.getSetting = async function() { throw new Error('idb'); };
        var mb = await i18nLoad(bad); assert.strictEqual(await mb.i18nInit(), 'en', 'getSetting throw -> auto -> fetch 404-less map -> en');
        var bare = await loadModules([I18N_CORE], { workspace: I18N_WS, globals: {} });
        assert.strictEqual(await bare.i18nInit(), 'en', 'no host globals: lenient probes, never throws');
        assert.ok(bare.__unstubbed.indexOf('getSetting') >= 0 && bare.__unstubbed.indexOf('navigator') >= 0);
    });
});

describe('harness i18n auto-include', function() {
    function fakeTarget(coreMissing, H2) {
        var log = [], tgt = { existing: 'mine', _log: log };
        tgt.loadFile = async function(p, w) { log.push('loadFile:' + p); if (coreMissing && p === H2.I18N_CORE) throw new Error('source missing: ' + p); return 'SRC(' + p + ')'; };
        tgt.evalModules = async function(srcs, names) { log.push('evalModules'); return { srcs: srcs, names: names }; };
        tgt.evalModule = async function() { log.push('evalModule'); return { t: 'core-t', existing: 'core' }; };
        tgt.loadModules = async function(paths) { log.push('orig.loadModules'); return { orig: true, paths: paths }; };
        tgt.runFile = async function(p) { log.push('orig.runFile'); return { ran: p }; };
        return tgt;
    }
    test('wrapper: prepends the cached core, honours opt-outs, never stacks', async function() {
        var H2 = await runFile('test/harness.js'), tg = fakeTarget(false, H2); H2.install(tg);
        var r = await tg.loadModules(['a.js', 'b.js'], { workspace: 'w' });
        assert.deepStrictEqual(r.names, [H2.I18N_CORE, 'a.js', 'b.js']); assert.strictEqual(r.srcs[0], 'SRC(' + H2.I18N_CORE + ')');
        await tg.loadModules(['c.js'], { workspace: 'w' });
        assert.strictEqual(tg._log.filter(function(x) { return x === 'loadFile:' + H2.I18N_CORE; }).length, 1, 'core read once per workspace');
        assert.strictEqual((await tg.loadModules(['a.js'], { i18n: false })).orig, true);
        assert.strictEqual((await tg.loadModules([H2.I18N_CORE, 'a.js'])).orig, true);
        assert.strictEqual((await tg.loadModules(['a.js'], { globals: { t: function() {} } })).orig, true);
        var first = tg.loadModules.__i18nOriginal; H2.install(tg); assert.strictEqual(tg.loadModules.__i18nOriginal, first, 'no stacking');
        var miss = fakeTarget(true, H2); H2.install(miss); assert.deepStrictEqual((await miss.loadModules(['a.js'])).paths, ['a.js'], 'unreadable core -> original');
        var plain = {}; H2.install(plain); assert.ok(!('loadModules' in plain) && !('runFile' in plain));
    });
    test('runFile copies core names once, never overwrites; opt-out + core path skip', async function() {
        var H2 = await runFile('test/harness.js'), tg = fakeTarget(false, H2); H2.install(tg);
        await tg.runFile('x.js'); await tg.runFile('y.js');
        assert.strictEqual(tg.t, 'core-t'); assert.strictEqual(tg.existing, 'mine');
        assert.strictEqual(tg._log.filter(function(x) { return x === 'evalModule'; }).length, 1);
        var off = fakeTarget(false, H2); H2.install(off); await off.runFile('x.js', { i18n: false }); await off.runFile(H2.I18N_CORE);
        assert.strictEqual(off._log.indexOf('evalModule'), -1);
    });
    test('real loaders: modules get the English core; i18n:false opts out', async function() {
        var p = ['src/js/core/055-emoji-shortcodes.js'];
        var withI = await loadModules(p, { workspace: I18N_WS, lenient: true }), without = await loadModules(p, { workspace: I18N_WS, lenient: true, i18n: false });
        assert.strictEqual(withI.t('Save'), 'Save'); assert.strictEqual(withI.tn(2, '{count} file', '{count} files'), '2 files');
        assert.ok(!('t' in without)); assert.ok(Object.keys(without).every(function(k) { return k in withI; }));
        assert.deepStrictEqual(withI.__unstubbed, without.__unstubbed, 'auto-include adds no unstubbed globals');
        await runFile('test/harness.js'); assert.strictEqual(window.t('Save'), 'Save');
    });
});
