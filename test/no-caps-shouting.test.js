// Guard for PR #1219 / #1235: no all-caps shouting in text the model reads.
//
// All-caps emphasis (MUST, NEVER, do NOT, ONLY, IMPORTANT, ...) in the system
// prompt, tool / parameter descriptions, tool-result strings, injected notices
// and skill markdown reads to the model as if the user were shouting. #1219
// rewrote it in normal case; this test keeps it from creeping back.
//
// What is scanned
//   - JS sources (string literals only; comments, regex literals and console.*
//     arguments are skipped; `code spans` inside strings are skipped).
//   - Skill markdown prose (fenced code blocks and `code spans` are skipped).
//
// Two rules
//   1. SHOUT_WORDS: an all-caps emphasis word anywhere -> fail.
//   2. Any other all-caps word (3+ letters) -> fail unless it is in ACRONYMS,
//      sits in a short section label ("CHAT VS TASK:"), is a constant-only
//      string ('INDETERMINATE'), or is listed in EXEMPTIONS with a reason.
// Every EXEMPTIONS entry must still match something, so the list can only shrink.
//
// Adding a new prompt-bearing file? Add it to JS_SOURCES / SKILL_DOCS below
// (the sandbox has no directory listing, so the lists are explicit).

var JS_SOURCES = [
    // core
    'src/js/core/010-platform.js', 'src/js/core/015-boot-crumbs.js', 'src/js/core/020-bootstrap.js',
    'src/js/core/025-i18n.js', 'src/js/core/030-config.js', 'src/js/core/040-hooks-history.js',
    'src/js/core/050-streaming.js', 'src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js',
    'src/js/core/070-permissions.js', 'src/js/core/075-test-run-policy.js', 'src/js/core/078-tool-profiles.js',
    'src/js/core/080-tools.js', 'src/js/core/082-split-view.js', 'src/js/core/085-eval-runner.js',
    'src/js/core/090-codemap.js', 'src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js',
    'src/js/core/100-cached-results.js', 'src/js/core/110-system-prompt.js', 'src/js/core/120-init.js',
    'src/js/core/130-indexeddb.js', 'src/js/core/135-widget-store.js', 'src/js/core/140-skills-engine.js',
    'src/js/core/150-record-helpers.js',
    // tools (tool results the model reads)
    'src/js/tools/010-iframe-tool.js', 'src/js/tools/020-tool-execution.js', 'src/js/tools/030-screenshot-tools.js',
    'src/js/tools/040-file-store.js', 'src/js/tools/050-file-tools.js', 'src/js/tools/060-take-screenshot.js',
    'src/js/tools/070-screenshot-by-id.js', 'src/js/tools/080-widget-tools.js', 'src/js/tools/082-widget-export.js',
    'src/js/tools/085-widget-eval.js', 'src/js/tools/090-display-templates.js', 'src/js/tools/100-prompt-user.js',
    'src/js/tools/110-smart-documents.js', 'src/js/tools/112-file-viewers.js', 'src/js/tools/120-actions.js',
    'src/js/tools/130-github-setup.js', 'src/js/tools/140-runtime-inspect.js', 'src/js/tools/145-usage-rollup.js',
    'src/js/tools/150-start-chat.js', 'src/js/tools/160-run-tests.js', 'src/js/tools/165-chat-history.js',
    'src/js/tools/170-local-folders.js', 'src/js/tools/175-agent-files-unseen.js',
    // app (hook prompts, notices, widget-mode note from #1235)
    'src/js/app/010-llm-streaming.js', 'src/js/app/020-api-messages.js', 'src/js/app/030-agent-loop.js',
    'src/js/app/035-agent-events.js', 'src/js/app/036-agent-event-handlers-page.js', 'src/js/app/040-send-message.js',
    'src/js/app/045-agent-port-bridge-page.js', 'src/js/app/050-image-attachments.js', 'src/js/app/060-keep-awake.js',
    'src/js/app/070-app-tab-ready.js',
    // worker (service-worker agent loop + tool routing)
    'src/js/worker/000-runtime-globals.js', 'src/js/worker/010-platform-stub.js', 'src/js/worker/020-page-stubs.js',
    'src/js/worker/025-permissions-helpers.js', 'src/js/worker/100-agent-event-broadcast.js',
    'src/js/worker/105-subagent-broadcast.js', 'src/js/worker/110-agent-checkpoint.js', 'src/js/worker/115-storage.js',
    'src/js/worker/120-tool-routing.js', 'src/js/worker/130-port-bridge.js', 'src/js/worker/185-boot-crumbs-sw.js',
    'src/js/worker/190-entry.js',
    // ui file that builds the tool-denial message the model reads
    'src/js/ui/150-tool-approval.js',
    // skill tool files (their tool descriptions go to the model)
    'skills/extension-dev/build.js', 'skills/feature-deroulement/deroulement.js', 'skills/instance-audit/run_audit.js',
    'skills/servicenow-docs/search_docs.js', 'skills/web-search/web_search.js'
];

// skills/servicenow-eval/tasks.md is deliberately excluded: benchmark task prompts (kept as-is in #1219).
var SKILL_DOCS = [
    'skills/atf-testing/SKILL.md', 'skills/elevate-security-role/SKILL.md', 'skills/extension-dev/SKILL.md',
    'skills/feature-deroulement/SKILL.md', 'skills/flow-designer/SKILL.md', 'skills/github-api/SKILL.md',
    'skills/instance-audit/SKILL.md', 'skills/instance-explorer/SKILL.md', 'skills/instance-quickstart/SKILL.md',
    'skills/memory/SKILL.md', 'skills/memory/knowledge-base.md', 'skills/pr-regression-sweep/SKILL.md',
    'skills/quick-actions/SKILL.md', 'skills/runtime-debugging/SKILL.md', 'skills/servicenow-docs/SKILL.md',
    'skills/servicenow-eval/SKILL.md', 'skills/skill-self-improve/SKILL.md', 'skills/ui-driver/SKILL.md',
    'skills/ui-driver/attachment.md', 'skills/ui-driver/custom-macro.md', 'skills/ui-driver/date-datetime-picker.md',
    'skills/ui-driver/duration.md', 'skills/ui-driver/list-collector.md', 'skills/ui-driver/modals.md',
    'skills/ui-driver/native-inputs.md', 'skills/ui-driver/now-experience.md', 'skills/ui-driver/select2.md',
    'skills/ui-pages-best-practices/SKILL.md', 'skills/ui-pages-best-practices/testing_ui_pages.md',
    'skills/ui-testing/SKILL.md', 'skills/web-search/SKILL.md', 'skills/widget-best-practices/SKILL.md'
];

// Rule 1: emphasis words. Always a failure outside code / labels / exemptions.
var SHOUT_RE = /\b(MUST(?:N'T)?|NEVER|ALWAYS|IMPORTANT|CRITICAL|CRUCIAL|ESSENTIAL|DO NOT|DON'T|DOES NOT|NOT|ONLY|REQUIRED|MANDATORY|WARNING|CAUTION|STOP|EVERY|EVERYTHING|ANY|EXACTLY|ABSOLUTELY|SAME|YOU|NO|CANNOT|CAN'T|WON'T|SHOULD|STRICTLY)\b/g;

// Rule 2 allowlist: acronyms, protocol / format names, identifiers. Keep it to real acronyms.
var ACRONYMS = ('ACL ADB API ARIA ASCII AST ATF CAPTCHA CAS CDATA CDN CORS CRUD CSM CSP CSS CSV DDG DOCTYPE DOM ESC ' +
    'GET GHE GPT HEAD HTML HTTP HTTPS IDB IIFE ISO ITIL ITSM JPEG JSESSIONID JSON JSX LAN LLM MFA MIME MRVS NUL OOB ' +
    'PAT PATCH PDF PHPSESSID PNG POST PUT REST RFC RSS RTL SERP SLA SOW SSO SVG TLDR TTL URL UTF UXF WIP XML XSS YYYY ' +
    'DELETE TODO').split(' ');

// Narrow, reasoned exemptions. file + words (+ optional `where` substring of the line/string).
var EXEMPTIONS = [
    { file: 'src/js/core/097-sub-agent-registry.js', where: 'appears STUCK', words: ['STUCK'], reason: 'ui/175-sub-agent-ui.js matches STUCK by regex for status colours (kept in #1219)' },
    { file: 'src/js/core/097-sub-agent-registry.js', where: 'reported STUCK', words: ['STUCK'], reason: 'parent notice line; ui/175-sub-agent-ui.js matches STUCK by regex' },
    { file: 'src/js/core/097-sub-agent-registry.js', where: 'the user DENIED', words: ['DENIED'], reason: 'ui/175-sub-agent-ui.js matches DENIED by regex (kept in #1219)' },
    { file: 'src/js/core/097-sub-agent-registry.js', where: 'SPAWN FUSE', words: ['SPAWN', 'FUSE'], reason: 'error code-like tag asserted by test/sub-report-cap.test.js' },
    { file: 'src/js/core/097-sub-agent-registry.js', where: 'WORKER SATURATION rule', words: ['WORKER', 'SATURATION'], reason: 'names the system-prompt section label' },
    { file: 'src/js/tools/020-tool-execution.js', where: 'another RUNNING agent', words: ['RUNNING'], reason: 'ls ownership marker asserted by test/sandbox-loader-bridge.test.js' },
    { file: 'src/js/core/080-tools.js', where: 'ACTIVE SKILLS', words: ['ACTIVE', 'SKILLS'], reason: 'names the system-prompt section label' },
    { file: 'src/js/core/080-tools.js', where: 'ISOLATED', words: ['ISOLATED', 'MAIN'], reason: 'tab_world enum values (Chrome script execution worlds)' },
    { file: 'src/js/tools/020-tool-execution.js', where: 'ISOLATED', words: ['ISOLATED', 'MAIN'], reason: 'tab_world enum values (Chrome script execution worlds)' },
    { file: 'src/js/app/050-image-attachments.js', where: 'pending-file-label', words: ['DOC'], reason: 'file-type badge in composer chip HTML (UI only, not model text)' },
    { file: 'skills/extension-dev/build.js', where: 'copies MUST stay byte-identical', words: ['MUST'], reason: 'shared guard region kept byte-identical with build/build.js; soften both copies in a follow-up' },
    { file: 'skills/extension-dev/build.js', words: ['AND'], reason: 'build tool description / build errors; out of scope here (soften together with build/build.js in a follow-up)' },
    { file: 'skills/web-search/web_search.js', where: 'the AGENT decides', words: ['AGENT'], reason: 'web_search tool description; out of scope here, soften in a follow-up' },
    { file: 'skills/servicenow-docs/search_docs.js', where: 'SELECT', words: ['SELECT', 'FROM', 'WHERE', 'MATCHES', 'LIMIT'], reason: 'SQL keywords in an example query' },
    { file: 'src/js/core/085-eval-runner.js', words: ['STARTSWITH'], reason: 'ServiceNow encoded-query operator' },
    { file: 'skills/extension-dev/SKILL.md', where: 'TOOLS array', words: ['TOOLS'], reason: 'the TOOLS identifier in core/080-tools.js' },
    { file: 'skills/skill-self-improve/SKILL.md', where: 'ACTIVE SKILLS', words: ['ACTIVE', 'SKILLS'], reason: 'names the system-prompt section label' },
    { file: 'skills/servicenow-eval/SKILL.md', words: ['INCONCLUSIVE', 'INFRA', 'SKIPPED', 'HAVING', 'GLOBAL'], reason: 'verdict values (INCONCLUSIVE, INFRA-SKIPPED), SQL keyword, scope name' },
    { file: 'skills/ui-driver/attachment.md', words: ['CHARACTERIZED'], reason: 'status badge (see ui-driver status legend)' },
    { file: 'skills/ui-driver/custom-macro.md', words: ['STUB'], reason: 'status badge (see ui-driver status legend)' },
    { file: 'skills/ui-driver/duration.md', words: ['VERIFIED'], reason: 'status badge (see ui-driver status legend)' },
    { file: 'skills/ui-driver/modals.md', words: ['VERIFIED'], reason: 'status badge (see ui-driver status legend)' }
];

// ---------------------------------------------------------------- scanners

// Returns [{line, text, log}] for every string / template literal in src.
// Comments and regex literals are skipped; log=true inside console.*(...) args.
function extractJsStrings(src) {
    var out = [], i = 0, n = src.length, line = 1, last = '', recent = [], depth = 0, logDepths = [];
    function regexAllowed() {
        return last === '' || /^[(,=:\[!&|?{};+\-*%<>~^]$/.test(last) || /^(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(last);
    }
    function tok(t) { recent.push(t); if (recent.length > 3) recent.shift(); last = t; }
    while (i < n) {
        var c = src[i];
        if (c === '\n') { line++; i++; continue; }
        if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
            i += 2; continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            var q = c, s = '', l0 = line; i++;
            while (i < n && src[i] !== q) {
                if (src[i] === '\\') { s += src[i] + (src[i + 1] || ''); i += 2; continue; }
                if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
                    var d = 1; i += 2; s += ' ';
                    while (i < n && d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; else if (src[i] === '\n') { line++; s += '\n'; } i++; }
                    continue;
                }
                if (src[i] === '\n') line++;
                s += src[i++];
            }
            i++;
            out.push({ line: l0, text: s, log: logDepths.length > 0 });
            tok('str'); continue;
        }
        if (c === '/' && regexAllowed()) {
            i++; var cls = false;
            while (i < n && src[i] !== '\n') {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; else if (src[i] === '/' && !cls) break;
                i++;
            }
            i++; while (/[a-z]/.test(src[i] || '')) i++;
            tok('re'); continue;
        }
        if (/[A-Za-z_$0-9]/.test(c)) { var w = ''; while (i < n && /[A-Za-z_$0-9]/.test(src[i])) w += src[i++]; tok(w); continue; }
        if (c === '(') { depth++; if (recent.length === 3 && recent[0] === 'console' && recent[1] === '.') logDepths.push(depth); }
        if (c === ')') { if (logDepths.length && logDepths[logDepths.length - 1] === depth) logDepths.pop(); depth--; }
        tok(c); i++;
    }
    return out;
}

// Returns [{line, text}] for markdown prose lines (fenced blocks dropped).
function extractMarkdownProse(md) {
    var out = [], fence = null;
    md.split('\n').forEach(function(l, idx) {
        var m = l.match(/^\s*(```|~~~)/);
        if (m) { if (!fence) fence = m[1]; else if (fence === m[1]) fence = null; return; }
        if (!fence) out.push({ line: idx + 1, text: l });
    });
    return out;
}

// Removes the parts of one prose line that are not emphasis candidates.
function neutralize(text) {
    return text
        .replace(/`[^`\n]*`/g, ' ')                                   // code spans
        .replace(/\bhttps?:\/\/\S+/g, ' ')                             // URLs
        .replace(/\b[A-Z][A-Za-z0-9]*\.(md|js|json|html|css)\b/g, ' ') // SKILL.md, README.md
        .replace(/\[[A-Z][A-Z0-9 _-]*\]/g, ' ')                        // [DONE]-style protocol markers
        .replace(/===[^=\n]*===/g, ' ')                                // === CODE OUTLINE === banners
        .replace(/^[-*#>|\s]*(?:\*\*)?[A-Z][A-Z0-9 &\/'-]*[A-Z0-9](?:\s*\([^)]*\))?(?:\*\*)?\s*:/, ' '); // "CHAT VS TASK:" labels
}

function isConstantOnly(text) {
    return /^[A-Z0-9_ .:\-\/&()\[\]'"=]*$/.test(text.trim());
}

function exemptFor(file, word, rawText) {
    for (var i = 0; i < EXEMPTIONS.length; i++) {
        var e = EXEMPTIONS[i];
        if (e.file !== file || e.words.indexOf(word) < 0) continue;
        if (e.where && rawText.indexOf(e.where) < 0) continue;
        e._used = true;
        return true;
    }
    return false;
}

// Scans one logical line; pushes findings "file:line: WORD (rule) — snippet".
function scanText(file, line, rawText, findings) {
    if (isConstantOnly(rawText)) return;
    var text = neutralize(rawText);
    var snippet = rawText.trim().replace(/\s+/g, ' ').slice(0, 140);
    var m, seen = {};
    SHOUT_RE.lastIndex = 0;
    while ((m = SHOUT_RE.exec(text))) {
        var w = m[1];
        if (seen[w] || exemptFor(file, w, rawText)) continue;
        seen[w] = 1;
        findings.push(file + ':' + line + ': shouting word "' + w + '" — ' + snippet);
    }
    var caps = text.match(/\b[A-Z]{3,}\b/g) || [];
    caps.forEach(function(w) {
        if (seen[w] || ACRONYMS.indexOf(w) >= 0) return;
        if (/^(DON|CAN|WON|MUSTN|DOESN)$/.test(w)) return; // stems of rule-1 contractions
        if (exemptFor(file, w, rawText)) return;
        seen[w] = 1;
        findings.push(file + ':' + line + ': all-caps word "' + w + '" (not in ACRONYMS / EXEMPTIONS) — ' + snippet);
    });
}

function scanJsSource(file, src, findings) {
    extractJsStrings(src).forEach(function(s) {
        if (s.log) return;
        // A literal may span source lines (template literal) and hold "\n" escapes:
        // scan each logical line, reporting the source line it sits on.
        s.text.split('\n').forEach(function(srcLine, offset) {
            srcLine.split(/\\n/).forEach(function(p) {
                // embedded server-script comments (e.g. eval-runner scripts) are code, not prose
                var prose = p.replace(/(^|\s)\/\/.*$/, '$1');
                scanText(file, s.line + offset, prose, findings);
            });
        });
    });
}

function scanMarkdown(file, md, findings) {
    extractMarkdownProse(md).forEach(function(l) { scanText(file, l.line, l.text, findings); });
}

// Each file is read once per run (module-level cache): the existence check and the
// scan share the reads instead of issuing ~110 loadFile calls twice.
var _fileCache = {};
async function readAll(paths) {
    var out = {}, missing = [];
    for (var i = 0; i < paths.length; i++) {
        var txt = null;
        if (Object.prototype.hasOwnProperty.call(_fileCache, paths[i])) txt = _fileCache[paths[i]];
        else {
            try { txt = await loadFile(paths[i]); } catch (e) { txt = null; }
            _fileCache[paths[i]] = txt;
        }
        if (typeof txt !== 'string' || !txt.length) missing.push(paths[i]); else out[paths[i]] = txt;
    }
    return { files: out, missing: missing };
}

// ---------------------------------------------------------------- tests

describe('no all-caps shouting: scanner self-checks', function() {
    test('flags emphasis words in string literals but not in comments, regexes or console args', async function() {
        var f = [];
        scanJsSource('x.js', [
            "// you MUST NOT see this comment",
            "/* NEVER here either */",
            "var r = /ONLY|NOT/g;",
            "console.error('row NOT deleted');",
            "var a = 'You MUST call the tool';",
            "var b = \"there is NO fallback\";",
            "var c = `x ${'y'} do NOT retry`;",
            "var d = 'use the `NOT_FOUND` code';",
            "var e = 'INDETERMINATE';"
        ].join('\n'), f);
        assert.strictEqual(f.length, 3, f.join('\n'));
        assert.match(f[0], /^x\.js:5: shouting word "MUST"/);
        assert.match(f[1], /^x\.js:6: shouting word "NO"/);
        assert.match(f[2], /^x\.js:7: shouting word "NOT"/);
    }, { tags: ['unit'], timeout: 2000 });

    test('allows acronyms, section labels and constants; flags unknown all-caps words', async function() {
        var f = [];
        scanJsSource('y.js', [
            "var a = 'Call the REST API and return JSON over HTTP.';",
            "var b = 'CHAT VS TASK: a question is a chat';",
            "var c = 'API FIRST (ServiceNow): use the API tools';",
            "var d = 'the workspace was KEPT intact';"
        ].join('\n'), f);
        assert.strictEqual(f.length, 1, f.join('\n'));
        assert.match(f[0], /^y\.js:4: all-caps word "KEPT"/);
    }, { tags: ['unit'], timeout: 2000 });

    test('markdown: skips fenced blocks and code spans, reports file:line:word', async function() {
        var f = [];
        scanMarkdown('s/SKILL.md', [
            '# Title',
            '```js',
            '// NEVER do this',
            '```',
            'Use `DO_NOT_TOUCH` safely.',
            'You **MUST** read SKILL.md first.',
            '## IMPORTANT NOTES'
        ].join('\n'), f);
        assert.strictEqual(f.length, 3, f.join('\n'));
        assert.match(f[0], /^s\/SKILL\.md:6: shouting word "MUST"/);
        assert.match(f[1], /^s\/SKILL\.md:7: shouting word "IMPORTANT"/);
        assert.match(f[2], /^s\/SKILL\.md:7: all-caps word "NOTES"/);
    }, { tags: ['unit'], timeout: 2000 });
});

describe('no all-caps shouting: real prompt sources', function() {
    test('every listed source file exists (update the lists when files move)', async function() {
        var r = await readAll(JS_SOURCES.concat(SKILL_DOCS));
        assert.deepStrictEqual(r.missing, [], 'missing or empty sources: ' + r.missing.join(', '));
    }, { tags: ['unit'], timeout: 20000 });

    test('system prompt, tool descriptions, tool results and skills have no all-caps shouting', async function() {
        EXEMPTIONS.forEach(function(e) { e._used = false; });
        var js = await readAll(JS_SOURCES), md = await readAll(SKILL_DOCS);
        var findings = [];
        Object.keys(js.files).forEach(function(p) { scanJsSource(p, js.files[p], findings); });
        Object.keys(md.files).forEach(function(p) { scanMarkdown(p, md.files[p], findings); });
        assert.strictEqual(findings.length, 0,
            findings.length + ' all-caps finding(s). Rewrite in normal case (see PR #1219), or for a real acronym / identifier add it to ACRONYMS / EXEMPTIONS with a reason:\n  ' + findings.join('\n  '));
        var stale = EXEMPTIONS.filter(function(e) { return !e._used; })
            .map(function(e) { return e.file + ' [' + e.words.join(',') + ']' + (e.where ? ' where "' + e.where + '"' : ''); });
        assert.deepStrictEqual(stale, [], 'stale EXEMPTIONS (no longer needed, remove them): ' + stale.join('; '));
    }, { tags: ['unit'], timeout: 20000 });

    test('core prompt files are covered and #1235 widget-mode wording holds', async function() {
        ['src/js/core/110-system-prompt.js', 'src/js/core/080-tools.js', 'src/js/tools/020-tool-execution.js',
         'src/js/core/097-sub-agent-registry.js', 'src/js/app/030-agent-loop.js', 'src/js/app/040-send-message.js']
            .forEach(function(p) { assert.ok(JS_SOURCES.indexOf(p) >= 0, p + ' must stay in JS_SOURCES'); });
        var sm = await loadFile('src/js/app/040-send-message.js');
        assert.ok(sm.indexOf('[Widget mode]') >= 0, '040-send-message.js keeps the "[Widget mode]" note from #1235');
        assert.ok(sm.indexOf('WIDGET MODE') < 0, '040-send-message.js must not reintroduce "WIDGET MODE"');
    }, { tags: ['unit'], timeout: 5000 });
});
