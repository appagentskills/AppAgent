// i18n: src/platform/extension/file-download.js is a standalone extension page
// (not in the app bundle), so it carries its own small loader over
// locales/<code>.json. Each case evaluates the REAL page script in a fresh
// Function scope against the REAL file-download.html (or a fixture) parsed by
// DOMParser. location, localStorage, fetch, indexedDB, setTimeout and chrome
// are stubs. Covered: the catalog path; the ok / 404 / reject / bad-JSON /
// non-object / sync-throw / no-fetch / timeout fallbacks with the <html lang dir>
// reset (V3); t() plural 'other' form, null/undefined params and own-key lookup
// (V2); the panel's whitespace key rule with child elements kept (V1).

var FD_JS = 'src/platform/extension/file-download.js';
var FD_HTML = 'src/platform/extension/file-download.html';

var FD_FR = {
    'File Download': 'T\u00e9l\u00e9chargement de fichier',
    'Resolving file\u2026': 'R\u00e9solution du fichier\u2026',
    'No file ID provided.': 'Aucun ID de fichier fourni.',
    'File not found: {id}': 'Fichier introuvable : {id}',
    'Downloaded: {name}': 'T\u00e9l\u00e9charg\u00e9 : {name}'
};

async function fdFlush() {
    // Enough microtask turns for the catalog chain, the race, start() and two
    // rejected IndexedDB opens.
    for (var i = 0; i < 80; i++) await Promise.resolve();
}

// opts: { lang, dir, prefix, search, catalog, html, noFetch,
//         fetchMode: 'ok'|'404'|'reject'|'badjson'|'array'|'throw'|'deferred',
//         idb: 'error'|'hang' }
async function fdBoot(opts) {
    opts = opts || {};
    var src = await loadFile(FD_JS);
    var html = opts.html || await loadFile(FD_HTML);
    var cut = src.lastIndexOf('})();');
    assert.ok(src.indexOf('(function() {') === 0 && cut > 0, 'file-download.js is a single IIFE');
    // The page body runs unmodified; only a trailing export of t is appended.
    var body = 'return ' + src.slice(0, cut) + 'return { t: t };\n' + src.slice(cut);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var store = {}, prefix = opts.prefix || '';
    if (opts.lang != null) store[prefix + 'uiLanguage'] = opts.lang;
    if (opts.dir != null) store[prefix + 'uiLanguageDir'] = opts.dir;
    var localStorageStub = { getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } };
    var fetched = [], timers = [], opened = [], deferred = {};
    function response(ok, jsonFn) { return { ok: ok, status: ok ? 200 : 404, json: jsonFn }; }
    function fetchStub(url) {
        fetched.push(url);
        var mode = opts.fetchMode || 'ok';
        if (mode === 'throw') throw new Error('synchronous fetch failure');
        if (mode === 'deferred') return new Promise(function(resolve) { deferred.resolve = resolve; });
        if (mode === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
        if (mode === '404') return Promise.resolve(response(false, function() { return Promise.resolve(opts.catalog || {}); }));
        if (mode === 'badjson') return Promise.resolve(response(true, function() { return Promise.reject(new SyntaxError('Unexpected token')); }));
        if (mode === 'array') return Promise.resolve(response(true, function() { return Promise.resolve(['not', 'a', 'catalog']); }));
        return Promise.resolve(response(true, function() { return Promise.resolve(opts.catalog || {}); }));
    }
    var idbStub = { open: function(name) {
        opened.push(name);
        var req = {};
        if ((opts.idb || 'error') === 'error') Promise.resolve().then(function() { req.error = 'blocked in test'; if (req.onerror) req.onerror(); });
        return req;
    } };
    function setTimeoutStub(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; }
    var chromeStub = { runtime: { getURL: function(p) { return 'chrome-extension://ext/' + p; } } };
    var api = Function('location', 'document', 'localStorage', 'fetch', 'indexedDB', 'setTimeout', 'chrome', body)(
        { search: opts.search || '' }, doc, localStorageStub, opts.noFetch ? undefined : fetchStub, idbStub, setTimeoutStub, chromeStub);
    await fdFlush();
    return {
        api: api, doc: doc, fetched: fetched, timers: timers, opened: opened, deferred: deferred,
        card: doc.getElementById('card'),
        lang: doc.documentElement.getAttribute.bind(doc.documentElement, 'lang'),
        dir: doc.documentElement.getAttribute.bind(doc.documentElement, 'dir'),
        pristine: new DOMParser().parseFromString(html, 'text/html')
    };
}

function fdStatic(r) {
    var p = r.card.querySelector('p[data-i18n]');
    return { title: r.doc.title, resolving: p ? p.textContent : null, spinner: !!r.card.querySelector('.spinner'), lang: r.lang(), dir: r.dir() };
}

describe('i18n file-download page: English identity', function() {
    test('no mirrored language: no catalog fetch, en/ltr, markup byte-identical, English messages', async function() {
        var r = await fdBoot({ search: '?id=f1', idb: 'hang' });
        assert.strictEqual(r.fetched.length, 0, 'no catalog fetch for English');
        assert.deepStrictEqual(fdStatic(r), { title: 'File Download', resolving: 'Resolving file\u2026', spinner: true, lang: 'en', dir: 'ltr' });
        assert.strictEqual(r.doc.head.innerHTML, r.pristine.head.innerHTML, 'head untouched');
        assert.strictEqual(r.doc.body.innerHTML, r.pristine.body.innerHTML, 'body untouched');
        var none = await fdBoot({ lang: 'en', dir: 'ltr' });
        assert.strictEqual(none.fetched.length, 0, 'uiLanguage=en never fetches');
        assert.strictEqual(none.card.querySelector('p.error').textContent, 'No file ID provided.');
        var miss = await fdBoot({ search: '?id=f%201' });
        assert.deepStrictEqual(miss.opened, ['AppAgentDB', 'iframe_AppAgentDB'], 'both DBs tried');
        assert.strictEqual(miss.card.querySelector('p.error').textContent, 'File not found: f 1');
    }, { tags: ['unit'], timeout: 5000 });
});

describe('i18n file-download page: catalog load and lang/dir (V3)', function() {
    test('fr catalog: fetches the relative locales/fr.json, sets fr/ltr, translates markup and messages', async function() {
        var r = await fdBoot({ lang: 'fr', dir: 'ltr', catalog: FD_FR, search: '?id=f1', idb: 'hang' });
        assert.deepStrictEqual(r.fetched, ['locales/fr.json']);
        assert.deepStrictEqual(fdStatic(r), { title: FD_FR['File Download'], resolving: FD_FR['Resolving file\u2026'], spinner: true, lang: 'fr', dir: 'ltr' });
        var none = await fdBoot({ lang: 'fr', catalog: FD_FR });
        assert.strictEqual(none.card.querySelector('p.error').textContent, 'Aucun ID de fichier fourni.');
        var miss = await fdBoot({ lang: 'fr', catalog: FD_FR, search: '?id=f%201' });
        assert.strictEqual(miss.card.querySelector('p.error').textContent, 'Fichier introuvable : f 1', '{id} filled');
    }, { tags: ['unit'], timeout: 5000 });

    test('ar via the iframe_ mirror prefix: fetches locales/ar.json and sets ar/rtl', async function() {
        var r = await fdBoot({ prefix: 'iframe_', lang: 'ar', dir: 'rtl', catalog: { 'File Download': '\u062a\u0646\u0632\u064a\u0644 \u0627\u0644\u0645\u0644\u0641' }, search: '?id=x', idb: 'hang' });
        assert.deepStrictEqual(r.fetched, ['locales/ar.json']);
        assert.deepStrictEqual(fdStatic(r), { title: '\u062a\u0646\u0632\u064a\u0644 \u0627\u0644\u0645\u0644\u0641', resolving: 'Resolving file\u2026', spinner: true, lang: 'ar', dir: 'rtl' });
    }, { tags: ['unit'], timeout: 5000 });

    test('every failed load falls back to English and resets lang/dir to en/ltr', async function() {
        var modes = ['404', 'reject', 'badjson', 'array', 'throw'];
        for (var i = 0; i < modes.length; i++) {
            var r = await fdBoot({ lang: 'ar', dir: 'rtl', catalog: { 'File Download': 'X' }, fetchMode: modes[i], search: '?id=x', idb: 'hang' });
            assert.strictEqual(r.fetched.length, 1, modes[i] + ': one fetch');
            assert.deepStrictEqual(fdStatic(r), { title: 'File Download', resolving: 'Resolving file\u2026', spinner: true, lang: 'en', dir: 'ltr' }, modes[i] + ': English + en/ltr');
        }
        var nf = await fdBoot({ lang: 'fr', dir: 'ltr', noFetch: true, search: '?id=x', idb: 'hang' });
        assert.deepStrictEqual([nf.lang(), nf.dir(), nf.doc.title], ['en', 'ltr', 'File Download'], 'no fetch API');
        var bad = ['EN', 'fr_FR', '../fr', 'fr.json', 'x', 'fr-'];
        for (var j = 0; j < bad.length; j++) {
            var b = await fdBoot({ lang: bad[j], dir: 'rtl', catalog: FD_FR });
            assert.strictEqual(b.fetched.length, 0, bad[j] + ': rejected code is never fetched');
            assert.deepStrictEqual([b.lang(), b.dir()], ['en', 'ltr'], bad[j] + ': lang/dir are validated, not copied');
        }
    }, { tags: ['unit'], timeout: 5000 });

    test('timeout: after 1 s the page starts in English (en/ltr) and a late catalog is ignored', async function() {
        var r = await fdBoot({ lang: 'fr', dir: 'ltr', fetchMode: 'deferred' });
        assert.ok(r.card.querySelector('p[data-i18n]'), 'start() waits for the catalog race');
        var timer = r.timers.filter(function(x) { return x.ms === 1000; })[0];
        assert.ok(timer, 'a 1000 ms race timer is armed');
        timer.fn();
        await fdFlush();
        assert.strictEqual(r.card.querySelector('p.error').textContent, 'No file ID provided.');
        assert.deepStrictEqual([r.lang(), r.dir()], ['en', 'ltr']);
        r.deferred.resolve({ ok: true, json: function() { return Promise.resolve(FD_FR); } });
        await fdFlush();
        assert.strictEqual(r.api.t('No file ID provided.'), 'No file ID provided.', 'late catalog not applied');
        assert.deepStrictEqual([r.lang(), r.dir()], ['en', 'ltr'], 'late catalog leaves en/ltr');
    }, { tags: ['unit'], timeout: 5000 });
});

describe('i18n file-download page: t() semantics (V2)', function() {
    test('plural object uses its other form; null/undefined/missing params stay verbatim; own keys only', async function() {
        var cat = {
            'No file ID provided.': { one: 'Un', other: 'Aucun ID de fichier fourni.' },
            'File not found: {id}': 'Fichier introuvable : {id}',
            'Empty value': '',
            'Plural without other': { one: 'Un seul' },
            'Array value': ['a']
        };
        var r = await fdBoot({ lang: 'fr', catalog: cat });
        var t = r.api.t;
        assert.strictEqual(r.card.querySelector('p.error').textContent, 'Aucun ID de fichier fourni.', 'page shows the other form');
        assert.strictEqual(t('File not found: {id}', { id: null }), 'Fichier introuvable : {id}');
        assert.strictEqual(t('File not found: {id}', { id: undefined }), 'Fichier introuvable : {id}');
        assert.strictEqual(t('File not found: {id}', {}), 'Fichier introuvable : {id}');
        assert.strictEqual(t('File not found: {id}', { id: 0 }), 'Fichier introuvable : 0');
        assert.strictEqual(t('File not found: {id}', 'abc'), 'Fichier introuvable : {id}', 'non-object params ignored');
        assert.strictEqual(t('File not found: {id}', { id: Object.create(null) }), 'Fichier introuvable : ', 'unstringifiable param -> empty, no throw');
        assert.strictEqual(t('Empty value'), 'Empty value', "'' counts as missing");
        assert.strictEqual(t('Plural without other'), 'Plural without other');
        assert.strictEqual(t('Array value'), 'Array value');
        assert.strictEqual(t('constructor'), 'constructor', 'inherited keys are not catalog entries');
        assert.strictEqual(t('{a} and {b}', { a: 'x' }), 'x and {b}', 'English identity with a missing param');
        assert.strictEqual(t(null), '');
        assert.strictEqual(t(undefined), '');
    }, { tags: ['unit'], timeout: 5000 });
});

describe('i18n file-download page: data-i18n keys (V1)', function() {
    var FIX = '<!DOCTYPE html><html><head><title data-i18n>\n  File\n  Download\n</title></head><body>' +
        '<div class="card" id="card"><p data-i18n id="p1">\n    Resolving\n    file\u2026  <b id="kid">!</b></p>' +
        '<p data-i18n id="p2"><i id="icon"></i> Not in   catalog </p></div></body></html>';

    test('keys collapse whitespace like the panel; child elements and edge whitespace are kept', async function() {
        var r = await fdBoot({ lang: 'fr', catalog: FD_FR, html: FIX, search: '?id=x', idb: 'hang' });
        var d = r.doc, p1 = d.getElementById('p1'), p2 = d.getElementById('p2');
        assert.strictEqual(d.querySelector('title').firstChild.nodeValue, '\n  ' + FD_FR['File Download'] + '\n');
        assert.strictEqual(d.title, FD_FR['File Download']);
        assert.strictEqual(p1.firstChild.nodeValue, '\n    ' + FD_FR['Resolving file\u2026'] + '  ');
        assert.ok(d.getElementById('kid') && d.getElementById('kid').parentNode === p1 && d.getElementById('kid').textContent === '!', 'child element kept');
        assert.ok(d.getElementById('icon') && d.getElementById('icon').parentNode === p2, 'leading icon kept');
        assert.strictEqual(p2.lastChild.nodeValue, ' Not in   catalog ', 'untranslated text left byte-identical');
        var en = await fdBoot({ html: FIX, search: '?id=x', idb: 'hang' });
        assert.strictEqual(en.doc.documentElement.innerHTML, en.pristine.documentElement.innerHTML, 'English: fixture untouched');
    }, { tags: ['unit'], timeout: 5000 });
});

describe('i18n file-download page: hostile id is rendered as text (#1032)', function() {
    test('?id=<img src=x onerror=alert(1)> -> no <img> element, the id shows literally (en + fr)', async function() {
        var HOSTILE = '<img src=x onerror=alert(1)>';
        var r = await fdBoot({ search: '?id=' + encodeURIComponent(HOSTILE) });
        assert.deepStrictEqual(r.opened, ['AppAgentDB', 'iframe_AppAgentDB'], 'reached the not-found branch');
        assert.strictEqual(r.card.querySelectorAll('img').length, 0, 'no injected <img>');
        assert.strictEqual(r.doc.querySelectorAll('img, [onerror]').length, 0, 'nothing with onerror anywhere');
        var p = r.card.querySelector('p.error');
        assert.ok(p, 'error paragraph rendered');
        assert.strictEqual(p.firstChild.nodeValue, 'File not found: ' + HOSTILE, 'the id text shows literally');
        var fr = await fdBoot({ lang: 'fr', catalog: FD_FR, search: '?id=' + encodeURIComponent(HOSTILE) });
        assert.strictEqual(fr.card.querySelectorAll('img').length, 0, 'fr: no injected <img>');
        assert.strictEqual(fr.card.querySelector('p.error').firstChild.nodeValue, 'Fichier introuvable : ' + HOSTILE);
    }, { tags: ['unit'], timeout: 5000 });
});
