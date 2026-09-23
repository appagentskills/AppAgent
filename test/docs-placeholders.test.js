// Help page (docs/documentation.md) placeholder substitution: __VERSION__ and
// __CHANGELOG__. Covers build/docs-placeholders.js (Node build, serve-docs,
// Pages workflow) and its in-browser copy in skills/extension-dev/build.js.
async function nodeDocsModule() { return runFile('build/docs-placeholders.js'); }
async function skillDocsModule() { return runFile('skills/extension-dev/build.js'); }

describe('docs placeholders (__VERSION__ / __CHANGELOG__)', function() {
    test('changelog is reshaped to nest under the ## Changelog heading', async function() {
        var m = await nodeDocsModule();
        var out = m.formatChangelogForDocs('# Changelog\r\n\r\n## v1.2.3\r\n\r\n### Features\n- New thing\n\n---\n\n## v1.2.2\n### Fixes\n- Old thing\n');
        assert.strictEqual(out, '### v1.2.3 {#changelog-v1-2-3}\n\n**Features**\n- New thing\n\n---\n\n### v1.2.2 {#changelog-v1-2-2}\n**Fixes**\n- Old thing');
    });

    test('fenced code blocks pass through untouched', async function() {
        var m = await nodeDocsModule(), fence = '\x60\x60\x60';
        assert.strictEqual(m.formatChangelogForDocs('## v1\n' + fence + '\n# not a heading\n' + fence), '### v1 {#changelog-v1}\n' + fence + '\n# not a heading\n' + fence);
    });

    test('__VERSION__ is substituted before the changelog is spliced in, so changelog text stays literal', async function() {
        var m = await nodeDocsModule();
        var out = m.applyDocsPlaceholders('**Version:** v__VERSION__\n\n## Changelog {#changelog}\n\n__CHANGELOG__\n', '9.9.9', '# Changelog\n\n## v9.9.9\n- mentions `__VERSION__` and $& literally\n');
        assert.strictEqual(out, '**Version:** v9.9.9\n\n## Changelog {#changelog}\n\n### v9.9.9 {#changelog-v9-9-9}\n- mentions `__VERSION__` and $& literally\n');
    });

    test('missing changelog / version never fails: fallback text, placeholder kept for empty version', async function() {
        var m = await nodeDocsModule();
        assert.strictEqual(m.applyDocsPlaceholders('v__VERSION__ __CHANGELOG__', '', null), 'v__VERSION__ ' + m.CHANGELOG_FALLBACK);
        assert.strictEqual(m.applyDocsPlaceholders('__CHANGELOG__', '1', '# Changelog\n'), m.CHANGELOG_FALLBACK);
    });

    test('in-browser extension_build copy produces identical output on the real docs + changelog', async function() {
        var n = await nodeDocsModule(), s = await skillDocsModule();
        var docs = await loadFile('docs/documentation.md'), changelog = await loadFile('changelog.md');
        assert.strictEqual(s.CHANGELOG_FALLBACK, n.CHANGELOG_FALLBACK);
        assert.strictEqual(s.formatChangelogForDocs(changelog), n.formatChangelogForDocs(changelog));
        assert.strictEqual(s.applyDocsPlaceholders(docs, '1.2.3', changelog), n.applyDocsPlaceholders(docs, '1.2.3', changelog));
        assert.strictEqual(s.applyDocsPlaceholders(docs, '1.2.3', ''), n.applyDocsPlaceholders(docs, '1.2.3', ''));
    });

    test('real Help page: changelog nests under About without polluting the TOC', async function() {
        var n = await nodeDocsModule(), r = await runFile('docs/docs-renderer.js');
        var docs = await loadFile('docs/documentation.md'), changelog = await loadFile('changelog.md');
        assert.strictEqual(docs.split('__CHANGELOG__').length, 2, 'exactly one __CHANGELOG__ placeholder');
        var md = n.applyDocsPlaceholders(docs, '1.2.3', changelog);
        assert.ok(md.indexOf('__CHANGELOG__') < 0);
        assert.ok(md.indexOf('**Version:** v1.2.3') >= 0);
        var toc = r.parseDocsMarkdown(md).toc, before = r.parseDocsMarkdown(docs).toc;
        assert.deepStrictEqual(toc.map(function(e) { return e.id; }), before.map(function(e) { return e.id; }), 'top-level TOC unchanged');
        var about = toc.filter(function(e) { return e.id === 'about'; })[0];
        assert.ok(about && about.children.some(function(c) { return c.id === 'changelog'; }), 'Changelog is a child of About');
        var all = [];
        toc.forEach(function(e) { all.push(e.id); e.children.forEach(function(c) { all.push(c.id); }); });
        assert.ok(!all.some(function(id) { return /^changelog-/.test(id); }), 'release headings stay out of the TOC');
        var html = r.parseDocsMarkdown(md).html;
        var firstRelease = (changelog.match(/^##\s+(v[^\s]+)/m) || [])[1];
        if (firstRelease) assert.ok(html.indexOf('id="changelog-' + firstRelease.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '"') >= 0, 'release rendered as an anchored h3');
    });
});
