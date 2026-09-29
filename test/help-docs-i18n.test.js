// Translated Help page (docs/locales/<code>/{documentation.md,README.md}).
//  - translations: one test per locale — both files exist and keep the English
//    structure byte-for-byte where it matters ({#id}s, fences, placeholders,
//    URLs, app: targets, heading counts per level). Translators self-verify with
//    run_tests { pattern: 'help-docs-i18n' } (their locale's test must pass).
//  - catalogs: the Help page UI keys exist in every src/locales/<code>.json.
//  - builds: buildDocsLocaleFiles parity (Node build vs in-browser extension_build).
//  - renderer: the Unicode _docsSlug is a no-op change for the English docs.
//  - runtime: loadDocsLocale fallback / caching and the renderDocsPage re-render guard.
// Run: run_tests { pattern: 'help-docs-i18n' }
var WS = args.workspace;
var HELP_LOCALES = ['ar', 'cs', 'da', 'de', 'es', 'fi', 'fr', 'fr-CA', 'he', 'hu', 'it', 'ja', 'ko', 'nb', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ru', 'sv', 'th', 'tr', 'zh-CN', 'zh-TW'];
var HELP_UI_KEYS = ['Contents', 'Documentation sections'];
var FENCE = '\x60\x60\x60';

async function readOrNull(path) {
    try {
        var s = await loadFile(path, WS);
        return typeof s === 'string' && s.trim() ? s : null;
    } catch (e) { return null; }
}

// Structural fingerprint of a markdown file: everything a translation must keep.
function mdShape(md) {
    var lines = String(md).replace(/\r\n/g, '\n').split('\n');
    var headings = {}, ids = [], fences = [], prose = [], inFence = false, cur = null;
    lines.forEach(function(line) {
        if (/^\s*\x60{3}/.test(line)) {
            if (!inFence) { inFence = true; cur = [line.trim()]; }
            else { inFence = false; cur.push(line.trim()); fences.push(cur.join('\n')); cur = null; }
            return;
        }
        if (inFence) { cur.push(line); return; }
        prose.push(line);
        var h = line.trim().match(/^(#{1,6})\s+(.+)$/);
        if (h) {
            headings[h[1].length] = (headings[h[1].length] || 0) + 1;
            var id = h[2].match(/\{#([^}\s]+)\}\s*$/);
            if (id) ids.push(id[1]);
        }
    });
    if (cur) fences.push(cur.join('\n') + '\n<unterminated>');
    var text = prose.join('\n');
    function uniqSorted(a) { return a.filter(function(x, i) { return a.indexOf(x) === i; }).sort(); }
    var targets = [];
    text.replace(/\]\(([^)\s]+)\)/g, function(_, u) { targets.push(u); return _; });
    var bare = text.match(/https?:\/\/[^\s)>\]"'\x60<]+/g) || [];
    return {
        headings: headings,
        ids: ids.slice().sort(),
        fenceCount: fences.length,
        fences: fences,
        changelog: String(md).split('__CHANGELOG__').length - 1,
        version: String(md).split('__VERSION__').length - 1,
        urls: uniqSorted(targets.filter(function(u) { return /^https?:/.test(u); }).concat(bare)),
        appTargets: uniqSorted(targets.filter(function(u) { return /^app:/.test(u); })),
        anchorTargets: uniqSorted(targets.filter(function(u) { return u.charAt(0) === '#'; }))
    };
}

// Compares one translated file with the English source; returns a list of problems.
function compareShape(label, en, tr, withIds) {
    var a = mdShape(en), b = mdShape(tr), errs = [];
    function eq(what, x, y) {
        var sx = JSON.stringify(x), sy = JSON.stringify(y);
        if (sx !== sy) errs.push(label + ': ' + what + ' differs — expected ' + sx.slice(0, 300) + ', got ' + sy.slice(0, 300));
    }
    eq('heading count per level', a.headings, b.headings);
    if (withIds) eq('{#id} set', a.ids, b.ids);
    eq('fence count', a.fenceCount, b.fenceCount);
    if (a.fenceCount === b.fenceCount) a.fences.forEach(function(f, i) { if (f !== b.fences[i]) errs.push(label + ': fenced block #' + (i + 1) + ' content changed'); });
    eq('__CHANGELOG__ count', a.changelog, b.changelog);
    eq('__VERSION__ count', a.version, b.version);
    eq('URL set', a.urls, b.urls);
    eq('app: link targets', a.appTargets, b.appTargets);
    eq('#anchor link targets', a.anchorTargets, b.anchorTargets);
    return errs;
}

async function checkLocale(code) {
    var enDocs = await loadFile('docs/documentation.md', WS), enReadme = await loadFile('README.md', WS);
    var base = 'docs/locales/' + code + '/';
    var docs = await readOrNull(base + 'documentation.md'), readme = await readOrNull(base + 'README.md');
    var missing = [];
    if (docs === null) missing.push(base + 'documentation.md');
    if (readme === null) missing.push(base + 'README.md');
    var errs = [];
    if (docs !== null) errs = errs.concat(compareShape(base + 'documentation.md', enDocs, docs, true));
    if (readme !== null) errs = errs.concat(compareShape(base + 'README.md', enReadme, readme, false));
    return { missing: missing, errs: errs };
}

describe('help docs translations: docs/locales/<code>/ vs English', function() {
    test('locale list = the 24 non-English I18N_LANGUAGES codes', async function() {
        var m = await loadModules(['src/js/core/025-i18n.js'], { workspace: WS, globals: {} });
        var codes = m.I18N_LANGUAGES.map(function(l) { return l.code; }).filter(function(c) { return c !== 'en'; }).sort();
        assert.deepStrictEqual(HELP_LOCALES.slice().sort(), codes);
    }, { tags: ['unit'] });

    test('English sources fingerprint sanity (the checks below compare against these)', async function() {
        var d = mdShape(await loadFile('docs/documentation.md', WS)), r = mdShape(await loadFile('README.md', WS));
        assert.ok(d.ids.length > 5, 'documentation.md has explicit {#id} anchors');
        assert.strictEqual(d.changelog, 1, 'exactly one __CHANGELOG__');
        assert.ok(d.version >= 1, '__VERSION__ present');
        assert.ok((r.headings[2] || 0) > 0, 'README has ## headings');
        // In-page links must target explicit {#id}s (auto slugs change when a heading is translated).
        var unresolved = d.anchorTargets.concat(r.anchorTargets).filter(function(a) { return d.ids.indexOf(a.slice(1)) < 0 && r.ids.indexOf(a.slice(1)) < 0; });
        assert.deepStrictEqual(unresolved, [], 'every #anchor link targets an explicit {#id}');
        var bad = mdShape('# A {#a}\n' + FENCE + 'js\nx\n' + FENCE + '\n[x](https://e.com) [y](app:openSettings)\n');
        assert.deepStrictEqual([bad.ids, bad.fenceCount, bad.urls, bad.appTargets], [['a'], 1, ['https://e.com'], ['app:openSettings']]);
        var diff = compareShape('t', '# A {#a}\n## B\n' + FENCE + '\nx\n' + FENCE + '\n', '# A {#b}\n' + FENCE + '\ny\n' + FENCE + '\n', true);
        assert.strictEqual(diff.length, 3, 'heading count, id set and fence content are all caught: ' + diff.join(' | '));
    }, { tags: ['unit'] });

    HELP_LOCALES.forEach(function(code) {
        test(code + ': documentation.md + README.md translated with identical structure', async function() {
            var r = await checkLocale(code);
            var problems = r.missing.map(function(p) { return 'missing ' + p; }).concat(r.errs);
            assert.ok(problems.length === 0, code + ' — ' + problems.length + ' problem(s):\n  ' + problems.join('\n  '));
        }, { tags: ['unit'], timeout: 10000 });
    });

    test('summary: every locale has both translated files', async function() {
        var missing = [];
        for (var i = 0; i < HELP_LOCALES.length; i++) {
            var r = await checkLocale(HELP_LOCALES[i]);
            if (r.missing.length) missing.push(HELP_LOCALES[i] + ' (' + r.missing.map(function(p) { return p.replace(/^.*\//, ''); }).join(', ') + ')');
        }
        assert.ok(missing.length === 0, missing.length + '/' + HELP_LOCALES.length + ' locales missing translations: ' + missing.join('; '));
    }, { tags: ['unit'], timeout: 60000 });
});

describe('help docs UI: catalogs, build parity, renderer, runtime', function() {
    test('"Contents" and "Documentation sections" translated in every catalog', async function() {
        var missing = [];
        for (var i = 0; i < HELP_LOCALES.length; i++) {
            var cat = JSON.parse(await loadFile('src/locales/' + HELP_LOCALES[i] + '.json', WS));
            HELP_UI_KEYS.forEach(function(k) {
                if (typeof cat[k] !== 'string' || !cat[k].trim()) missing.push(HELP_LOCALES[i] + ':' + k);
            });
        }
        assert.deepStrictEqual(missing, []);
    }, { tags: ['unit'] });

    test('buildDocsLocaleFiles: Node build and in-browser extension_build copy produce identical output', async function() {
        var n = await runFile('build/docs-placeholders.js', { i18n: false }, WS), s = await runFile('skills/extension-dev/build.js', { i18n: false }, WS);
        assert.strictEqual(s.DOCS_LOCALES_DIR, n.DOCS_LOCALES_DIR);
        assert.strictEqual(n.DOCS_LOCALES_DIR, 'docs-locales');
        var changelog = await loadFile('changelog.md', WS), docs = await loadFile('docs/documentation.md', WS);
        var sources = {
            fr: { documentation: docs.replace('# ', '# FR '), readme: '# Lisez-moi\n' },
            ja: { documentation: 'v__VERSION__\n__CHANGELOG__\n', readme: null },
            de: { documentation: '   ', readme: '# Liesmich\n' },
            '../evil': { documentation: 'x', readme: 'y' },
            'pt-BR': {}
        };
        var a = n.buildDocsLocaleFiles(sources, '1.2.3', changelog), b = s.buildDocsLocaleFiles(sources, '1.2.3', changelog);
        assert.deepStrictEqual(b, a);
        assert.deepStrictEqual(Object.keys(a).sort(), ['docs-locales/de/README.md', 'docs-locales/fr/README.md', 'docs-locales/fr/documentation.md', 'docs-locales/ja/documentation.md']);
        assert.strictEqual(a['docs-locales/ja/documentation.md'], n.applyDocsPlaceholders('v__VERSION__\n__CHANGELOG__\n', '1.2.3', changelog));
        assert.ok(a['docs-locales/ja/documentation.md'].indexOf('__CHANGELOG__') < 0 && a['docs-locales/ja/documentation.md'].indexOf('v1.2.3') === 0);
        assert.strictEqual(a['docs-locales/fr/README.md'], '# Lisez-moi\n', 'README copied verbatim');
        assert.deepStrictEqual(n.buildDocsLocaleFiles(null, '1', ''), {});
        assert.deepStrictEqual(s.buildDocsLocaleFiles(null, '1', ''), {});
    }, { tags: ['unit'] });

    test('Unicode _docsSlug equals the legacy ASCII rule on every English heading; no duplicate/empty auto ids', async function() {
        var r = await runFile('docs/docs-renderer.js', { i18n: false }, WS);
        function legacySlug(s) { return String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60); }
        var docs = await loadFile('docs/documentation.md', WS), readme = await loadFile('README.md', WS);
        var merged = r.mergeReadmeIntoDocs(readme, docs, { stripImages: true });
        // README auto-prefixing (slice 50) must match the legacy ASCII rule too.
        var legacyMergedHeads = readme.replace(/^!\[[^\]]*\]\([^)]+\)\s*$/gm, '').replace(/^(#{1,3})\s+(.+)$/gm, function(line, hashes, rest) {
            if (/\{#[a-zA-Z0-9_-]+\}\s*$/.test(rest)) return line;
            return hashes + ' ' + rest + ' {#readme-' + rest.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50) + '}';
        }) + '\n\n---\n\n' + docs;
        assert.strictEqual(merged, legacyMergedHeads, 'mergeReadmeIntoDocs output unchanged for English');
        var seen = {}, autoIds = [], dups = [], mismatches = [], empty = [], inFence = false, count = 0;
        merged.split('\n').forEach(function(line) {
            if (/^\s*\x60{3}/.test(line)) { inFence = !inFence; return; }
            if (inFence) return;
            var h = line.trim().match(/^#{1,3}\s+(.+)$/);
            if (!h) return;
            count++;
            var rest = h[1], m = rest.match(/^(.*?)\s*\{#([a-zA-Z0-9_-]+)\}\s*$/), id;
            if (m) id = m[2];
            else {
                id = legacySlug(rest);
                if (r._docsSlug(rest) !== id) mismatches.push(rest + ' -> ' + r._docsSlug(rest) + ' vs ' + id);
                if (!id) empty.push(rest);
                autoIds.push(id);
            }
            if (seen[id]) dups.push(id);
            seen[id] = true;
        });
        [docs, readme].join('\n').split('\n').forEach(function(line) {
            var h = line.trim().match(/^#{1,6}\s+(.+?)(?:\s*\{#[^}]+\})?\s*$/);
            if (h && r._docsSlug(h[1]) !== legacySlug(h[1])) mismatches.push('raw: ' + h[1]);
        });
        assert.ok(count > 20, 'headings scanned: ' + count);
        assert.deepStrictEqual(mismatches, []);
        assert.deepStrictEqual(empty, []);
        assert.deepStrictEqual(dups, [], 'no duplicate ids, so the new de-dup never renames an English anchor');
        // The ids the renderer actually emits are exactly the legacy ones, in order.
        var html = r.parseDocsMarkdown(merged).html, emitted = [];
        html.replace(/<(?:section|h3) id="([^"]+)"/g, function(_, id) { emitted.push(id); return _; });
        assert.deepStrictEqual(emitted, Object.keys(seen));
        // Translated headings keep a meaningful, unique, never-empty slug.
        assert.strictEqual(r._docsSlug('À propos'), 'à-propos');
        assert.strictEqual(r._docsSlug('はじめに'), 'はじめに');
        var t = r.parseDocsMarkdown('# Über\n# Über\n# !!!\n');
        assert.deepStrictEqual(t.toc.map(function(e) { return e.id; }), ['über', 'über-2', 'section']);
    }, { tags: ['unit'] });

    test('buildDocsOutlineHtml: English defaults unchanged, translated labels escaped', async function() {
        var r = await runFile('docs/docs-renderer.js', { i18n: false }, WS);
        var toc = [{ id: 'a', title: 'A', children: [{ id: 'b', title: 'B' }] }];
        var legacy = '<nav class="docs-outline" id="docs-outline" aria-label="Documentation sections"><div class="docs-outline-title">I Contents</div>' +
            '<div class="docs-nav-item" data-docs-anchor="a">A</div><div class="docs-nav-sub"><div class="docs-nav-subitem" data-docs-anchor="b">B</div></div></nav>';
        assert.strictEqual(r.buildDocsOutlineHtml(toc, 'I'), legacy);
        assert.strictEqual(r.buildDocsOutlineHtml(toc, 'I', {}), legacy);
        assert.strictEqual(r.buildDocsOutlineHtml(toc, 'I', { title: '', ariaLabel: null }), legacy);
        var fr = r.buildDocsOutlineHtml([], '', { title: 'Som<m>aire', ariaLabel: 'Sections "doc"' });
        assert.ok(fr.indexOf('aria-label="Sections &quot;doc&quot;"') > 0, fr);
        assert.ok(fr.indexOf(' Som&lt;m&gt;aire</div>') > 0, fr);
    }, { tags: ['unit'] });
});

// Minimal DOM for renderDocsPage: one #docs-content container recording renders.
function docsEnv(lang, fetchImpl) {
    var env = { renders: 0, html: '', fetched: [] };
    var container = { querySelectorAll: function() { return []; } };
    Object.defineProperty(container, 'innerHTML', { get: function() { return env.html; }, set: function(v) { env.renders++; env.html = v; } });
    env.lang = lang;
    env.fetch = function(url) { env.fetched.push(url); return fetchImpl(url); };
    env.globals = {
        document: { getElementById: function(id) { return id === 'docs-content' ? container : null; } },
        i18nLang: function() { return env.lang; },
        t: function(s) { return s; },
        currentView: 'docs',
        fetch: env.fetch,
        chrome: { runtime: { getURL: function(p) { return 'chrome-extension://x/' + p; } } }
    };
    return env;
}
async function loadDocsModules(env) {
    var m = await loadModules(['docs/docs-renderer.js', 'src/js/ui/060-docs-view.js'], { workspace: WS, globals: env.globals });
    env.m = m; env.s = m.__scope;
    return m;
}
function okText(text) { return Promise.resolve({ ok: true, text: function() { return Promise.resolve(text); } }); }
function notFound() { return Promise.resolve({ ok: false, text: function() { return Promise.resolve('nope'); } }); }
async function flush() { for (var i = 0; i < 200; i++) await Promise.resolve(); }

describe('help docs runtime: loadDocsLocale + renderDocsPage', function() {
    test('_docsLocaleCode: English / invalid codes -> embedded English', async function() {
        var env = docsEnv('en', notFound), m = await loadDocsModules(env);
        assert.strictEqual(m._docsLocaleCode(), '');
        env.lang = 'fr-CA'; assert.strictEqual(m._docsLocaleCode(), 'fr-CA');
        env.lang = '../x'; assert.strictEqual(m._docsLocaleCode(), '');
        assert.strictEqual(await m.loadDocsLocale(''), false);
        assert.deepStrictEqual(env.fetched, []);
    }, { tags: ['unit'] });

    test('missing file -> per-file English fallback; each file fetched once (cached)', async function() {
        var env = docsEnv('fr', function(url) { return /documentation\.md$/.test(url) ? okText('# Aide {#help}\n\nBonjour') : notFound(); });
        var m = await loadDocsModules(env);
        var calls = 0;
        function f(rel) { calls++; return env.fetch(rel); }
        var p1 = m.loadDocsLocale('fr', f), p2 = m.loadDocsLocale('fr', f);   // concurrent: shared pending promise
        assert.deepStrictEqual([await p1, await p2], [true, true]);
        assert.strictEqual(calls, 2, 'one fetch per file');
        assert.deepStrictEqual(env.fetched.slice().sort(), ['docs-locales/fr/README.md', 'docs-locales/fr/documentation.md']);
        assert.strictEqual(await m.loadDocsLocale('fr', f), true);
        assert.strictEqual(calls, 2, 'cached: no refetch');
        var md = m._decodeDocsMarkdown('fr');
        assert.ok(md.indexOf('# Aide {#help}') >= 0, 'translated documentation.md used');
        // README.md missing -> no translated README content (English embed; unbuilt placeholder -> '').
        assert.strictEqual(m._docsLocaleText('fr', 'README.md'), '');
        assert.strictEqual(m._decodeDocsMarkdown('fr'), m.mergeReadmeIntoDocs('', '# Aide {#help}\n\nBonjour', { stripImages: true }));
    }, { tags: ['unit'] });

    test('fetch errors / nothing translated -> false, English only, never rejects', async function() {
        var env = docsEnv('de', function() { return Promise.reject(new Error('net')); }), m = await loadDocsModules(env);
        assert.strictEqual(await m.loadDocsLocale('de'), false);
        assert.strictEqual(m._docsLocaleReady('de'), true);
        assert.strictEqual(m._docsLocaleText('de', 'documentation.md'), '');
        var env2 = docsEnv('ja', function() { throw new Error('sync throw'); }), m2 = await loadDocsModules(env2);
        assert.strictEqual(await m2.loadDocsLocale('ja'), false);
    }, { tags: ['unit'] });

    test('renderDocsPage: renders English first, re-renders once with the translation', async function() {
        var env = docsEnv('fr', function(url) { return /documentation\.md$/.test(url) ? okText('# Aide {#help}\n\nBonjour') : notFound(); });
        await loadDocsModules(env);
        env.m.renderDocsPage();
        assert.strictEqual(env.renders, 1);
        assert.ok(env.html.indexOf('lang="en" dir="ltr"') > 0, 'English fallback keeps its own lang/dir');
        await flush();
        assert.strictEqual(env.renders, 2, 're-rendered after load');
        assert.ok(env.html.indexOf('lang="fr"') > 0 && env.html.indexOf('Bonjour') > 0);
        env.m.renderDocsPage(); await flush();
        assert.strictEqual(env.renders, 3);
        assert.strictEqual(env.fetched.length, 2, 'no refetch on later renders');
    }, { tags: ['unit'] });

    test('renderDocsPage re-render guard: language changed, view left, or nothing translated -> no re-render', async function() {
        function tr(url) { return /documentation\.md$/.test(url) ? okText('# Aide\n') : notFound(); }
        var a = docsEnv('fr', tr); await loadDocsModules(a);
        a.m.renderDocsPage(); a.lang = 'en'; await flush();
        assert.strictEqual(a.m._docsLocaleReady('fr'), true, 'load completed');
        assert.strictEqual(a.renders, 1, 'language changed while loading');
        var b = docsEnv('fr', tr); await loadDocsModules(b);
        b.m.renderDocsPage(); b.s.currentView = 'chat'; await flush();
        assert.strictEqual(b.m._docsLocaleReady('fr'), true, 'load completed');
        assert.strictEqual(b.renders, 1, 'left the Help page while loading');
        var c = docsEnv('fr', notFound); await loadDocsModules(c);
        c.m.renderDocsPage(); await flush();
        assert.strictEqual(c.m._docsLocaleReady('fr'), true, 'load completed');
        assert.strictEqual(c.renders, 1, 'no translation available');
        assert.strictEqual(c.fetched.length, 2);
    }, { tags: ['unit'] });
});
