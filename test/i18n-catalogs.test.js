// src/locales/*.json against the real extractor output over src (build/i18n-extract.js).
// Every catalog: 0 missing / 0 orphan keys, placeholder parity, plural objects cover every
// Intl.PluralRules(lang) category, file names = I18N_LANGUAGES codes, no new <>& and the
// same HTML tags as the English key, and a `"` a translation adds is never pasted raw
// into an HTML attribute (`title="' + t(...) + '"`).
// Run: run_tests { files: ['test/i18n-catalogs.test.js'] }
var WS = args.workspace;
var CAT_DIR = 'src/locales';

function lsNames(ls) {
    return (ls && (ls.entries || ls.files) || []).map(function(e) {
        return String(typeof e === 'string' ? e : (e && (e.path || e.name)) || '').replace(/ \*$/, '').replace(/ \(\d+ files?\)$/, '').replace(/^.*\/(?=[^/]+\/?$)/, '');
    }).filter(Boolean);
}
var _src = null;
async function srcMap() {
    if (_src) return _src;
    var files = [], queue = ['src'], guard = 0;
    while (queue.length && guard++ < 100) {   // bounded: src has ~15 directories
        var d = queue.shift(), names = lsNames(await executeTool('workspace', { action: 'ls', path: d }));
        for (var i = 0; i < names.length; i++) {
            var nm = names[i];
            if (/\/$/.test(nm)) { if (d + '/' + nm !== CAT_DIR + '/') queue.push(d + '/' + nm.slice(0, -1)); }
            else if (/\.(m?js|cjs|html?)$/.test(nm)) files.push(d + '/' + nm);
        }
    }
    if (guard >= 100) throw new Error('src walk did not terminate');
    ['src/js/core/025-i18n.js', 'src/html/body.html', 'src/js/ui/245-i18n-dom.js'].forEach(function(f) {
        if (files.indexOf(f) < 0) throw new Error('src listing is missing ' + f + ' (' + files.length + ' files)');
    });
    var map = {};
    for (var j = 0; j < files.length; j++) map[files[j]] = await loadFile(files[j], WS);
    return (_src = map);
}
var _X = null, _ex = null, _cats = null;
async function extracted() {
    if (!_X) _X = await runFile('build/i18n-extract.js', { i18n: false }, WS);
    if (!_ex) _ex = _X.extractI18nStrings(await srcMap());
    return _ex;
}
async function catalogs() {
    if (_cats) return _cats;
    var names = lsNames(await executeTool('workspace', { action: 'ls', path: CAT_DIR })).filter(function(n) { return /\.json$/.test(n); }).sort();
    var out = {};
    for (var i = 0; i < names.length; i++) out[names[i].replace(/\.json$/, '')] = JSON.parse(await loadFile(CAT_DIR + '/' + names[i], WS));
    return (_cats = out);
}
function forms(v) { return typeof v === 'string' ? [v] : Object.keys(v || {}).map(function(k) { return v[k]; }); }
function tagList(s) { return (String(s).match(/<\/?[A-Za-z][A-Za-z0-9]*\b[^>]*>/g) || []).map(function(x) { return x.replace(/\s[^>]*/, '').toLowerCase(); }).sort().join(','); }
// A t()/tn() call pasted raw into a double-quoted HTML attribute:  title="' + t(   title=\"" + t(   title="${t(
var ATTR_CALL = /[A-Za-z][\w:-]*=(?:"'|\\"")\s*\+\s*(?:t|tn)\s*\(|[A-Za-z][\w:-]*="\$\{\s*(?:t|tn)\s*\(/;

describe('i18n catalogs: src/locales/*.json vs the extracted sources', function() {
    test('24 catalog files = the non-English I18N_LANGUAGES codes', async function() {
        var m = await loadModules(['src/js/core/025-i18n.js'], { workspace: WS, globals: {} });
        var codes = m.I18N_LANGUAGES.map(function(l) { return l.code; }).filter(function(c) { return c !== 'en'; }).sort();
        var files = Object.keys(await catalogs()).sort();
        assert.strictEqual(files.length, 24);
        assert.deepStrictEqual(files, codes);
    }, { tags: ['unit'] });

    test('every catalog: 0 missing, 0 orphan keys, placeholder parity', async function() {
        var ex = await extracted(), cats = await catalogs();
        assert.ok(ex.length > 1000, 'extracted ' + ex.length + ' sources');
        Object.keys(cats).forEach(function(code) {
            var r = _X.checkCatalog(ex, cats[code]);
            assert.deepStrictEqual(r.missing, [], code + ' missing');
            assert.deepStrictEqual(r.extra, [], code + ' orphan keys');
            assert.deepStrictEqual(r.placeholderMismatch, [], code + ' placeholders');
        });
    }, { tags: ['unit'] });

    test('plural objects cover every Intl.PluralRules(lang) category and nothing else', async function() {
        var ex = await extracted(), cats = await catalogs(), VALID = ['zero', 'one', 'two', 'few', 'many', 'other'];
        var plurals = ex.filter(function(e) { return e.plural; });
        assert.ok(plurals.length > 50, plurals.length + ' tn keys');
        Object.keys(cats).forEach(function(code) {
            var need = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
            plurals.forEach(function(p) {
                var v = cats[code][p.source];
                assert.ok(v && typeof v === 'object', code + ': ' + p.source + ' is a plural object');
                need.forEach(function(c) { assert.ok(typeof v[c] === 'string' && v[c] !== '', code + ': ' + p.source + ' has ' + c); });
                Object.keys(v).forEach(function(c) { assert.ok(VALID.indexOf(c) >= 0, code + ': ' + p.source + ' bad category ' + c); });
            });
        });
    }, { tags: ['unit'] });

    test('no translation adds < > & and HTML tags match the English key', async function() {
        var cats = await catalogs(), special = 0;
        Object.keys(cats).forEach(function(code) {
            Object.keys(cats[code]).forEach(function(k) {
                if (/[<>&]/.test(k)) special++;
                forms(cats[code][k]).forEach(function(s) {
                    ['<', '>', '&'].forEach(function(ch) {
                        if (k.indexOf(ch) < 0) assert.ok(s.indexOf(ch) < 0, code + ': "' + k + '" adds ' + ch + ' -> ' + s);
                    });
                    assert.strictEqual(tagList(s), tagList(k), code + ': tag parity for "' + k + '"');
                });
            });
        });
        assert.ok(special >= 14 * 24, 'the <>& keys were checked (' + special + ')');
    }, { tags: ['unit'] });

    test('the attribute-context detector flags raw attribute pastes and passes escaped/text ones', async function() {
        ["'<b title=\"' + t('X') + '\">'", '"<b title=\\"" + t(\'X\')', '`<b title="${t(\'X\')}">`', "' aria-label=\"' +\n tn(n, 'a', 'b')"].forEach(function(l) {
            assert.ok(ATTR_CALL.test(l), 'flags ' + l);
        });
        ["'<p>' + t('X') + '</p>'", "'<b title=\"' + escapeHtml(t('X')) + '\">'", "el.title = t('X');", "'<b title=\"' + escAttr(t('X'))"].forEach(function(l) {
            assert.ok(!ATTR_CALL.test(l), 'passes ' + l);
        });
    }, { tags: ['unit'] });

    test('a " that a translation adds (English has none) is never pasted raw into an HTML attribute', async function() {
        var ex = await extracted(), cats = await catalogs(), src = await srcMap(), refs = {}, hits = [], checked = 0;
        ex.forEach(function(e) { refs[e.source] = e.refs; });
        var keys = {};
        Object.keys(cats).forEach(function(code) {
            Object.keys(cats[code]).forEach(function(k) {
                if (k.indexOf('"') < 0 && forms(cats[code][k]).some(function(s) { return s.indexOf('"') >= 0; })) keys[k] = true;
            });
        });
        Object.keys(keys).forEach(function(k) {
            (refs[k] || []).forEach(function(ref) {
                var at = ref.lastIndexOf(':'), lines = String(src[ref.slice(0, at)] || '').split('\n'), n = +ref.slice(at + 1);
                var ctx = (lines[n - 2] || '').slice(-120) + '\n' + (lines[n - 1] || '');
                checked++;
                if (ATTR_CALL.test(ctx)) hits.push(ref + ' ' + k);
            });
        });
        // #1032 finding: 12 such keys (typographic “ ” rendered as ASCII " in some locales), used only in
        // text content, escapeHtml()/escDisplay() output, showSnackbar() and the chip.title DOM property.
        assert.ok(Object.keys(keys).length >= 1 && checked >= Object.keys(keys).length, Object.keys(keys).length + ' keys / ' + checked + ' refs checked');
        assert.deepStrictEqual(hits, [], 'raw attribute context for a key whose translation adds "');
    }, { tags: ['unit'] });
});
