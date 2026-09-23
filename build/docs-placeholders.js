// Docs placeholder substitution for docs/documentation.md (the Help page).
//
//   __VERSION__    -> manifest / release version
//   __CHANGELOG__  -> changelog.md (repo root), reshaped to nest under the
//                     "## Changelog {#changelog}" heading in the About section
//
// Used by build/build.js, build/serve-docs.js and .github/workflows/docs.yml
// (via the CLI at the bottom). skills/extension-dev/build.js (the in-browser
// extension_build tool) cannot require() this file, so it carries a copy of
// formatChangelogForDocs / applyDocsPlaceholders — KEEP IN SYNC; output
// parity is enforced by test/docs-placeholders.test.js.
//
// ORDER (deliberate): __VERSION__ is substituted in documentation.md FIRST,
// then the changelog is spliced in. changelog.md legitimately mentions the
// literal `__VERSION__` placeholder in its release notes, so it must never be
// run through the version substitution. split/join (not String.replace) keeps
// `$&`-style sequences in the changelog literal.

var CHANGELOG_FALLBACK = 'No changelog available.';

// The docs renderer (docs/docs-renderer.js) only knows h1-h3, and h1/h2 enter
// the TOC. So: drop the file's own h1 title ("# Changelog"), demote release
// headings (## vX.Y.Z) to h3 with a stable {#changelog-...} anchor (inline,
// not in the TOC), and turn deeper headings (### Features / ### Fixes) into
// bold labels. Fenced code blocks pass through untouched.
function formatChangelogForDocs(changelogMd) {
    var lines = String(changelogMd || '').replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var inFence = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (/^\s*\x60{3}/.test(line)) { inFence = !inFence; out.push(line); continue; }
        if (inFence) { out.push(line); continue; }
        var m = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
        if (!m) { out.push(line); continue; }
        var level = m[1].length;
        var title = m[2];
        if (level === 1) continue;
        if (level === 2) {
            var slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            out.push('### ' + title + (slug ? ' {#changelog-' + slug + '}' : ''));
            continue;
        }
        out.push('**' + title + '**');
    }
    return out.join('\n').trim();
}

function applyDocsPlaceholders(docsMd, version, changelogMd) {
    var md = String(docsMd || '');
    if (version) md = md.split('__VERSION__').join(version);
    var changelog = formatChangelogForDocs(changelogMd) || CHANGELOG_FALLBACK;
    return md.split('__CHANGELOG__').join(changelog);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CHANGELOG_FALLBACK: CHANGELOG_FALLBACK,
        formatChangelogForDocs: formatChangelogForDocs,
        applyDocsPlaceholders: applyDocsPlaceholders,
    };
}

// CLI (used by .github/workflows/docs.yml):
//   node build/docs-placeholders.js <documentation.md> <changelog.md> <version>
// Rewrites <documentation.md> in place. A missing changelog is a warning, not
// a failure — the fallback text is substituted instead.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    var fs = require('fs');
    var argv = process.argv.slice(2);
    if (argv.length < 3) {
        console.error('usage: node build/docs-placeholders.js <documentation.md> <changelog.md> <version>');
        process.exit(1);
    }
    var changelogSrc = '';
    try { changelogSrc = fs.readFileSync(argv[1], 'utf-8'); }
    catch (e) { console.warn('docs-placeholders: ' + argv[1] + ' not found — using fallback changelog text'); }
    fs.writeFileSync(argv[0], applyDocsPlaceholders(fs.readFileSync(argv[0], 'utf-8'), argv[2], changelogSrc));
    console.log('docs-placeholders: substituted __VERSION__=' + argv[2] + ' and __CHANGELOG__ in ' + argv[0]);
}
