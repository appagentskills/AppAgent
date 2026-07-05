#!/usr/bin/env node
/**
 * build.js - Chrome extension build script
 * Assembles src/ files into the Chrome extension under dist/extension/
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const SKILLS_START = '/*EMBEDDED_SKILLS_START*/';
const SKILLS_END = '/*EMBEDDED_SKILLS_END*/';

function buildEmbeddedSkills() {
    const skillsDir = path.join(ROOT, 'skills');
    if (!fs.existsSync(skillsDir)) return [];

    const skills = [];
    for (const folder of fs.readdirSync(skillsDir)) {
        const folderPath = path.join(skillsDir, folder);
        if (!fs.statSync(folderPath).isDirectory()) continue;

        const skillMdPath = path.join(folderPath, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) continue;

        const skillMd = fs.readFileSync(skillMdPath, 'utf-8');

        let name = folder, description = '', body = skillMd, fmRaw = '', devOnly = false;
        const fmMatch = skillMd.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
            const fm = fmMatch[1];
            fmRaw = fm;
            // devOnly skills are hidden at runtime outside extension dev mode
            // (isSkillDevHidden in src/js/core/140-skills-engine.js). fmRaw is
            // already part of the hash, so toggling devOnly bumps it.
            devOnly = /^devOnly:\s*true\s*$/m.test(fm);
            const nameMatch = fm.match(/^name:\s*(.+)$/m);
            const descMatch = fm.match(/^description:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            if (descMatch) description = descMatch[1].trim();
            body = skillMd.substring(fmMatch[0].length).trim();
        }

        const assets = [];
        for (const file of fs.readdirSync(folderPath)) {
            if (file === 'SKILL.md') continue;
            const ext = file.split('.').pop().toLowerCase();
            if (!['xml', 'md', 'js'].includes(ext)) continue;
            const content = fs.readFileSync(path.join(folderPath, file), 'utf-8');
            assets.push({ filename: file, type: ext, content: Buffer.from(content).toString('base64') });
        }

        // Simple hash for change detection. Include fmRaw so changes to the actions
        // list (which lives only in frontmatter) bump the hash and trigger a refresh
        // on upgrade — otherwise the hash-match branch in importEmbeddedSkills would
        // skip the actions update.
        const hashInput = name + '\n' + description + '\n' + body + '\n' + fmRaw + assets.map(a => a.filename + a.content).join('');
        const h = [0x243F6A88, 0x85A308D3, 0x13198A2E, 0x03707344];
        for (let i = 0; i < hashInput.length; i++) {
            const c = hashInput.charCodeAt(i);
            for (let j = 0; j < 4; j++) {
                h[j] = Math.imul(h[j] ^ c, 0x5BD1E995 + j);
                h[j] ^= h[j] >>> 15;
            }
        }
        const hash = h.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');

        skills.push({
            id: name,
            name,
            description,
            devOnly,
            body: Buffer.from(body).toString('base64'),
            // Keep the raw frontmatter in a separate field so the runtime
            // (importEmbeddedSkills in 15-indexeddb.js) can parse the actions list
            // without re-doing YAML detection on the body.
            frontmatter: Buffer.from(fmRaw).toString('base64'),
            hash,
            assets
        });
    }
    return skills;
}

function injectEmbeddedSkills(js, skills) {
    const json = JSON.stringify(skills);
    const start = js.indexOf(SKILLS_START);
    const end = js.indexOf(SKILLS_END);
    if (start === -1 || end === -1) {
        console.error('Warning: EMBEDDED_SKILLS markers not found in JS');
        return js;
    }
    return js.substring(0, start + SKILLS_START.length) + json + js.substring(end);
}

function readSrcFile(relativePath) {
    return fs.readFileSync(path.join(SRC, relativePath), 'utf-8');
}

function getOrderedFiles(dir, ext) {
    const fullDir = path.join(SRC, dir);
    if (!fs.existsSync(fullDir)) return [];
    return fs.readdirSync(fullDir)
        .filter(f => f.endsWith(ext))
        .sort() // Numeric prefix ensures correct order
        .map(f => path.join(dir, f));
}

// JS bundle is composed of tiers concatenated in this fixed order.
// Within each tier folder, files are sorted by their numeric prefix.
// Insertion within a tier only renames within that tier — never cascades across.
const JS_TIERS = ['core', 'ui', 'tools', 'app'];

// SW bundle (loaded by background.js via importScripts at the very top).
// The service worker hosts the agent loop and all state — multiple chats
// run as concurrent async tasks. No DOM in this context: DOM-needing
// tools (js_eval sandbox, skills sandbox, image canvas) bridge to the
// offscreen document via chrome.runtime.sendMessage. The composition:
//
//   1. worker tier files with prefix 0xx — declare globals + stubs FIRST
//   2. shared files (core/, app/, tools/) — agent loop + LLM streaming +
//      tool dispatch + IDB + skills, reused from the page bundle so we
//      don't duplicate code
//   3. worker tier files with prefix 1xx+ — port bridge, tool routing,
//      checkpoint, entry point — wired AFTER the shared code exists
//
// Keep WORKER_SHARED_FILES in sync with skills/extension-dev/build.js.
const WORKER_JS_TIERS = ['worker'];
const WORKER_SHARED_FILES = [
    // core (declarations + utilities)
    'js/core/030-config.js',
    'js/core/060-ui-constants.js',
    'js/core/070-permissions.js',
    'js/core/080-tools.js',
    'js/core/085-eval-runner.js',
    // 090-codemap.js is DOM-free and is called by 100-cached-results.js's
    // codemap-extract path (large code tool results get summarized via
    // generateCodemapWithOptions). Without this the SW throws ReferenceError
    // mid-runAgent the moment any tool returns a large code blob.
    'js/core/090-codemap.js',
    // 095-handle-registry defines the global `Handles` object used by
    // tools/020-tool-execution.js to back the async tool layer (await: false
    // → returns a handle, then await_handle / poll_handle / await_all /
    // await_any / cancel_handle collect / inspect). Must load BEFORE
    // tools/020-tool-execution.js (which references Handles by name at
    // executeTool's first lines). In WORKER_SHARED_FILES the registry needs
    // to come ahead of tool-execution; in the page bundle ordering is by
    // filename prefix (095 < 100 < 110) so it's already in front.
    'js/core/095-handle-registry.js',
    // 097-sub-agent-registry defines the global `SubAgents` object that
    // backs the seven sub-agent runtime tools (spawn_sub_agent,
    // report_to_parent, agent_status, wake_sub_agent, stop_sub_agent,
    // sleep_self, agent_message). Must load AFTER the handle registry
    // (097 takes a deferred handle for the spawn handle) and BEFORE
    // tools/020-tool-execution.js (which dispatches into SubAgents.*).
    // The page bundle also picks this up automatically via numeric prefix
    // sort (095 < 097 < 100 < 110).
    'js/core/097-sub-agent-registry.js',
    'js/core/100-cached-results.js',
    'js/core/110-system-prompt.js',
    'js/core/130-indexeddb.js',
    'js/core/140-skills-engine.js',
    'js/core/150-record-helpers.js',
    // tools (headless implementations the offscreen runtime can dispatch)
    'js/tools/040-file-store.js',
    'js/tools/050-file-tools.js',
    'js/tools/070-screenshot-by-id.js',
    'js/tools/110-smart-documents.js',
    'js/tools/020-tool-execution.js',
    // app (the agent loop + LLM streaming + API message builder + event bus)
    'js/app/035-agent-events.js',
    'js/app/020-api-messages.js',
    'js/app/010-llm-streaming.js',
    'js/app/030-agent-loop.js'
];

function getOrderedJsFiles() {
    return JS_TIERS.flatMap(tier => getOrderedFiles(path.join('js', tier), '.js'));
}

function getOrderedWorkerJsFiles() {
    return WORKER_JS_TIERS.flatMap(tier => getOrderedFiles(path.join('js', tier), '.js'));
}

// Compose the worker bundle: pre-shared worker files, then shared, then
// post-shared worker files. Pre vs post is decided by the numeric prefix
// — 0xx files run BEFORE the shared bundle (they declare globals + stubs
// that the shared code references); 1xx+ files run AFTER (they consume
// the shared symbols — port bridge, tool routing, entry, etc.).
function getWorkerBundleFiles() {
    const workerFiles = getOrderedWorkerJsFiles();
    const pre = workerFiles.filter(f => /[\\/]0\d\d-/.test(f));
    const post = workerFiles.filter(f => !pre.includes(f));
    return [...pre, ...WORKER_SHARED_FILES, ...post];
}

function concatFiles(files) {
    return files.map(f => readSrcFile(f)).join('\n');
}

// ─── SW-bundle identifier scanner ─────────────────────────────────────
// After assembling sw-bundle.js, find every called free identifier that
// isn't declared in the same bundle. The migration to events made the
// concatenated SW bundle a closed module (no page tier behind it), so a
// call to an undeclared identifier is a SW-bundle gap, not a runtime
// surprise to be papered over with a stub.
//
// Heuristics:
//   • Strip /* ... */ and // comments + string/template literals so we
//     don't match `function(`-shaped tokens inside docstrings or text.
//   • Declared:   `function name(`, `async function name(`, `var name`,
//                  `let name`, `const name`, `class name`, function param
//                  lists (best-effort), and catch-bindings.
//   • Called:     a free identifier followed by `(`, NOT preceded by `.`
//                 (member-call) or `_/$/word` (continuation).
//   • Allow-list: JS built-ins, Web/Worker APIs, MV3 globals, JS reserved
//                 keywords that look like calls (`if (`, `while (`, ...).
//
// Returns the sorted list of identifiers that are CALLED but NEITHER
// declared in the bundle NOR on the allow-list. Empty list = the bundle
// is self-contained.
const SW_SCANNER_BUILTINS = new Set([
    // ECMAScript globals
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
    'Math', 'Date', 'JSON', 'RegExp', 'Promise', 'Proxy', 'Reflect',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError',
    'SyntaxError', 'ReferenceError', 'URIError', 'EvalError',
    'Function', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
    'encodeURIComponent', 'encodeURI', 'decodeURIComponent', 'decodeURI',
    'Infinity', 'NaN', 'undefined', 'globalThis',
    'Iterator', 'AsyncIterator',
    // Typed arrays
    'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array',
    'Int32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView',
    'Uint8ClampedArray', 'BigInt64Array', 'BigUint64Array',
    // Web / Worker / SW APIs
    'fetch', 'atob', 'btoa', 'setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'queueMicrotask', 'requestAnimationFrame',
    'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
    'console', 'crypto', 'performance', 'navigator', 'location',
    'Blob', 'File', 'URL', 'URLSearchParams', 'FormData', 'FileReader',
    'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
    'Headers', 'Request', 'Response', 'ReadableStream', 'WritableStream',
    'TransformStream', 'BroadcastChannel', 'EventTarget', 'Event',
    'CustomEvent', 'MessageEvent', 'createImageBitmap', 'ImageBitmap',
    'OffscreenCanvas', 'Path2D', 'DOMException',
    'IDBKeyRange', 'IDBDatabase', 'indexedDB', 'self', 'caches',
    // MV3 / extension
    'chrome', 'importScripts', 'addEventListener', 'removeEventListener',
    'dispatchEvent', 'postMessage', 'close', 'skipWaiting',
    'registration',
    // JS reserved words that look like calls in the regex
    'if', 'while', 'for', 'switch', 'return', 'throw', 'catch', 'typeof',
    'instanceof', 'new', 'delete', 'void', 'yield', 'await', 'do', 'else',
    'in', 'of', 'function', 'break', 'continue', 'case', 'default',
    'try', 'finally', 'with', 'class', 'extends', 'super', 'this', 'var',
    'let', 'const', 'async', 'static', 'import', 'export', 'from', 'as',
    'true', 'false', 'null',
]);

function _swScannerStripCommentsAndStrings(src) {
    // Strip line + block comments and quoted string contents so the
    // identifier scan only sees real code. We deliberately do NOT try
    // to skip template literals or regex literals — both can contain
    // characters that confuse a naive single-pass parser (the codebase
    // has regex char classes like `/[#*_` + backtick + `\n]/g` that
    // would otherwise be mistaken for the start of a template literal
    // and eat the rest of the file).
    //
    // Bare identifiers inside template `${...}` interpolations are real
    // call sites anyway, so leaving them visible is correct. Regex
    // literals only contain method-name-looking tokens behind `.`, so
    // they don't trigger the free-identifier call regex below.
    var out = '';
    var i = 0;
    var n = src.length;
    while (i < n) {
        var c = src[i];
        var c2 = src[i + 1];
        // // line comment
        if (c === '/' && c2 === '/') {
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        // /* block comment */
        if (c === '/' && c2 === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        // "..." or '...' string
        if (c === '"' || c === '\'') {
            var quote = c;
            out += ' ';
            i++;
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                if (src[i] === '\n') break;
                i++;
            }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

function scanSwBundleGaps(raw) {
    var src = _swScannerStripCommentsAndStrings(raw);

    // Declared identifiers
    var declared = new Set();
    var declPatterns = [
        /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[\(*]/g,
        /\basync\s+function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
        /\b(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        /\bclass\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        // catch (e) — best-effort
        /\bcatch\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g,
        // Bare assignment with function value — covers patterns like
        // `executeTool = async function(...)` used by the worker/120-tool-
        // routing.js override of a shared symbol.
        /(?:^|[;\n{}])\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?function\b/g,
    ];
    for (var di = 0; di < declPatterns.length; di++) {
        var dm;
        while ((dm = declPatterns[di].exec(src)) !== null) declared.add(dm[1]);
    }

    // Guarded references: identifiers that appear inside `typeof X === 'function'`
    // or `typeof X !== 'undefined'` are explicitly checked at runtime, so a call
    // gated by such a guard isn't an unsafe reference. We collect those and skip
    // them in the gap report. Scan the RAW source because the strip step has
    // already eaten the literal `'function'`/`'undefined'`.
    var guarded = new Set();
    var guardRe = /\btypeof\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[!=]==?\s*['"](?:function|undefined|object)['"]/g;
    var gm;
    while ((gm = guardRe.exec(raw)) !== null) guarded.add(gm[1]);
    // Function/arrow parameters — match `function name(a, b)` and
    // `function(a, b)` and `(a, b) =>`. Coarse: just grab the
    // parenthesized arg list following `function[ name](` or before `=>`.
    var paramRe = /\bfunction\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(([^)]*)\)|\bfunction\s*\(([^)]*)\)|\(([^)]*)\)\s*=>/g;
    var pm;
    while ((pm = paramRe.exec(src)) !== null) {
        var params = pm[1] || pm[2] || pm[3] || '';
        params.split(',').forEach(function(p) {
            var name = p.trim().split(/[=\s]/)[0].replace(/^\.{3}/, '');
            if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) declared.add(name);
        });
    }
    // Object destructuring & arrow single-param (e.g. `x => ...`) —
    // single bare identifier before `=>` with no parens
    var singleArrowRe = /(?:^|[^.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/g;
    var sm;
    while ((sm = singleArrowRe.exec(src)) !== null) declared.add(sm[1]);

    // Called identifiers
    var called = new Map(); // name -> sample context
    var callRe = /(^|[^.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    var cm;
    while ((cm = callRe.exec(src)) !== null) {
        var name = cm[2];
        if (called.has(name)) continue;
        // Snapshot ~30 chars before for diagnostic context
        var ctxStart = Math.max(0, cm.index - 30);
        called.set(name, src.substring(ctxStart, cm.index + name.length + 1).replace(/\s+/g, ' ').trim());
    }

    var gaps = [];
    // typeof-guarded identifiers that are CALLED but not declared in the SW
    // bundle: not a hard failure (the guard makes the call safe at runtime),
    // but each one is a silent no-op in the worker context — exactly how the
    // markChatPrMerged pr_merged bug evaded detection. Collected for a
    // non-fatal warning list at the call site. Intentional dual-context
    // guards (e.g. wsNotifyPrMerged's page-only markChatPrMerged delegate)
    // will show up here — that's the point: the list documents them.
    var guardedGaps = [];
    called.forEach(function(ctx, name) {
        if (declared.has(name)) return;
        if (SW_SCANNER_BUILTINS.has(name)) return;
        if (guarded.has(name)) { guardedGaps.push({ name: name, ctx: ctx }); return; }
        gaps.push({ name: name, ctx: ctx });
    });
    gaps.sort(function(a, b) { return a.name.localeCompare(b.name); });
    guardedGaps.sort(function(a, b) { return a.name.localeCompare(b.name); });
    return { gaps: gaps, guardedGaps: guardedGaps };
}

// ─── MV3 CSP HTML Transformation ───
// Chrome MV3 forbids inline scripts and inline event handlers (onclick="...")
// This transform extracts them at build time into external JS files
function transformHtmlForExtension(html) {
    let evCounter = 0;
    const bindings = [];
    const inlineScripts = [];

    // 1. Extract inline <script>...</script> blocks
    html = html.replace(/<script>\n?([\s\S]*?)\n?\s*<\/script>/g, (match, content) => {
        inlineScripts.push(content);
        return `<!-- inline-script-${inlineScripts.length - 1} -->`;
    });

    // 2. Strip inline event handlers, add data-ev-id markers, collect bindings
    // Process each HTML tag that contains on* attributes
    html = html.replace(/<[a-zA-Z][^>]*\son[a-z]+="[^"]*"[^>]*>/g, (tag) => {
        const handlers = [];

        // Extract all on* handlers from this tag
        const stripped = tag.replace(/\s(on([a-z]+))="([^"]*)"/g, (m, attr, eventName, code) => {
            handlers.push({ event: eventName, code: code });
            return '';
        });

        if (handlers.length === 0) return tag;

        // Add data-ev-id to the tag
        const evId = evCounter++;
        const tagged = stripped.replace(/^(<[a-zA-Z]+)/, `$1 data-ev-id="${evId}"`);

        handlers.forEach(h => {
            bindings.push({ evId, event: h.event, code: h.code });
        });

        return tagged;
    });

    // 3. Generate event binding JS
    let bindingJS = '// Auto-generated: event bindings extracted from inline handlers\n';
    bindingJS += '(function() {\n';
    bindingJS += '    function _bindEv(id, ev, fn) {\n';
    bindingJS += '        var el = document.querySelector(\'[data-ev-id="\' + id + \'"]\');\n';
    bindingJS += '        if (el) el.addEventListener(ev, fn);\n';
    bindingJS += '    }\n';
    bindings.forEach(b => {
        bindingJS += `    _bindEv(${b.evId}, "${b.event}", function(event) { ${b.code} });\n`;
    });
    bindingJS += '})();\n';

    console.log(`  HTML transform: ${inlineScripts.length} inline scripts extracted, ${bindings.length} event handlers converted`);
    return { html, inlineScripts, bindingJS };
}

// ─── Chrome Extension Build ───
// MV3 extension page (no sandbox) - full chrome.* access, localStorage, IndexedDB
// Build-time transformation strips inline scripts/handlers for CSP compliance
function buildExtension() {
    console.log('Building Chrome extension target...');

    // Version is sourced from manifest.json and substituted into the bundle wherever __VERSION__ appears.
    const manifestPath = path.join(SRC, 'platform/extension/manifest.json');
    const version = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).version;

    // 1. Concatenate JS: CSP polyfill (first!) + tiered bundle + platform bridge (last)
    const jsFiles = getOrderedJsFiles();
    const coreJS = concatFiles(jsFiles);

    // CSP polyfill MUST run first - it overrides innerHTML/setAttribute to intercept
    // inline event handlers before they reach the DOM (which would trigger CSP violations)
    const polyfillPath = path.join(SRC, 'platform/extension/csp-polyfill.js');
    const polyfillJS = fs.existsSync(polyfillPath) ? fs.readFileSync(polyfillPath, 'utf-8') : '';

    const bridgePath = path.join(SRC, 'platform/extension/platform-bridge.js');
    const bridgeJS = fs.existsSync(bridgePath) ? fs.readFileSync(bridgePath, 'utf-8') : '';

    // The docs renderer lives at docs/docs-renderer.js so the github.io page can
    // load it directly. We inject it into the extension bundle so it's available
    // before 060-docs-view.js calls parseDocsMarkdown / buildDocsOutlineHtml.
    const docsRendererPath = path.join(ROOT, 'docs', 'docs-renderer.js');
    const docsRendererJS = fs.existsSync(docsRendererPath) ? fs.readFileSync(docsRendererPath, 'utf-8') : '';

    let appJS = (polyfillJS ? polyfillJS + '\n' : '') + (docsRendererJS ? docsRendererJS + '\n' : '') + coreJS + (bridgeJS ? '\n' + bridgeJS : '');

    // Embed skills from skills/ directory
    const extSkills = buildEmbeddedSkills();
    if (extSkills.length > 0) {
        appJS = injectEmbeddedSkills(appJS, extSkills);
        console.log(`  Skills: ${extSkills.length} embedded (${extSkills.map(s => s.id).join(', ')})`);
    }
    console.log(`  JS: ${jsFiles.length} files + CSP polyfill + platform bridge`);

    // 2. Concatenate CSS
    const cssFiles = getOrderedFiles('css', '.css');
    const cssContent = concatFiles(cssFiles);
    console.log(`  CSS: ${cssFiles.length} files`);

    // 3. Read HTML parts and transform for MV3 CSP
    const head = readSrcFile('html/head.html');
    const body = readSrcFile('html/body.html');

    // Transform: strip inline scripts and event handlers
    const headResult = transformHtmlForExtension(head);
    const bodyResult = transformHtmlForExtension(body);

    // Write extracted inline scripts as separate files
    // Head script 0 = theme-init (must run before CSS to prevent flash)
    // Body script 0 = view-init (shows correct panel before main JS)
    const themeInitJS = headResult.inlineScripts[0] || '';
    const viewInitJS = bodyResult.inlineScripts[0] || '';

    // Append event binding code to app.js (runs after all functions are defined)
    if (bodyResult.bindingJS) {
        appJS += '\n' + bodyResult.bindingJS;
    }
    if (headResult.bindingJS) {
        appJS += '\n' + headResult.bindingJS;
    }

    // 4. Assemble app.html
    // Replace inline script placeholders with external <script> references
    let processedHead = headResult.html
        .replace('<!-- inline-script-0 -->', '<script src="theme-init.js"></script>');
    let processedBody = bodyResult.html
        .replace('<!-- inline-script-0 -->', '<script src="view-init.js"></script>');

    const appHTML = `<!DOCTYPE html>
${processedHead}
    <link rel="stylesheet" href="app.css">
</head>
${processedBody}
<script src="app.js"></script>
</body>
</html>`;

    // Embed the documentation markdown (docs/documentation.md) and the project
    // README (README.md) as base64 strings. Both are merged at runtime via
    // mergeReadmeIntoDocs (see src/js/ui/060-docs-view.js + docs/docs-renderer.js).
    // __VERSION__ is substituted inside documentation.md before encoding so the
    // runtime never sees the placeholder.
    const docsMdPath = path.join(ROOT, 'docs', 'documentation.md');
    if (fs.existsSync(docsMdPath)) {
        let docsMd = fs.readFileSync(docsMdPath, 'utf-8');
        docsMd = docsMd.split('__VERSION__').join(version);
        const docsB64 = Buffer.from(docsMd, 'utf-8').toString('base64');
        appJS = appJS.split('__DOCS_MARKDOWN_B64__').join(docsB64);
        console.log(`  Docs: ${docsMd.length} bytes embedded`);
    } else {
        console.warn(`  Docs: ${docsMdPath} not found — docs page will show a placeholder`);
    }
    const readmeMdPath = path.join(ROOT, 'README.md');
    if (fs.existsSync(readmeMdPath)) {
        const readmeMd = fs.readFileSync(readmeMdPath, 'utf-8');
        const readmeB64 = Buffer.from(readmeMd, 'utf-8').toString('base64');
        appJS = appJS.split('__README_MARKDOWN_B64__').join(readmeB64);
        console.log(`  README: ${readmeMd.length} bytes embedded`);
    }


    appJS = appJS.split('__VERSION__').join(version);
    const versionedHTML = appHTML.split('__VERSION__').join(version);
    console.log(`  Version: ${version}`);

    // 5. Build the worker bundle (loaded by offscreen.html). Composition:
    // worker tier (pre/post around the shared agent code) so the offscreen
    // runtime declares its own globals + Platform stub before the shared
    // agent loop / tools / streaming run. See getWorkerBundleFiles().
    const workerBundleFiles = getWorkerBundleFiles();
    let workerJS = '';
    if (workerBundleFiles.length > 0) {
        workerJS = concatFiles(workerBundleFiles);
        workerJS = workerJS.split('__VERSION__').join(version);
        // Embed the same docs/README placeholders the page bundle uses — the
        // shared system-prompt / docs code reads __DOCS_MARKDOWN_B64__ and
        // __README_MARKDOWN_B64__ at module load. If left as raw placeholders
        // they'd just be inert strings, but substituting keeps parity with
        // the page bundle behavior.
        const docsMdForWorker = fs.existsSync(path.join(ROOT, 'docs', 'documentation.md'))
            ? fs.readFileSync(path.join(ROOT, 'docs', 'documentation.md'), 'utf-8').split('__VERSION__').join(version)
            : '';
        if (docsMdForWorker) workerJS = workerJS.split('__DOCS_MARKDOWN_B64__').join(Buffer.from(docsMdForWorker, 'utf-8').toString('base64'));
        const readmeMdForWorker = fs.existsSync(path.join(ROOT, 'README.md'))
            ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8')
            : '';
        if (readmeMdForWorker) workerJS = workerJS.split('__README_MARKDOWN_B64__').join(Buffer.from(readmeMdForWorker, 'utf-8').toString('base64'));
        // Inject the same embedded skills so the offscreen system prompt
        // matches what the panel sends. Without this, the worker's prompt
        // would lack skill instructions.
        const workerSkills = buildEmbeddedSkills();
        if (workerSkills.length > 0) {
            workerJS = injectEmbeddedSkills(workerJS, workerSkills);
        }
        const preCount = workerBundleFiles.filter(f => /[\\/]worker[\\/]/.test(f) && /[\\/]0\d\d-/.test(f)).length;
        const sharedCount = WORKER_SHARED_FILES.length;
        const postCount = workerBundleFiles.length - preCount - sharedCount;
        console.log(`  Worker bundle: ${preCount} pre + ${sharedCount} shared + ${postCount} post = ${workerBundleFiles.length} files`);
    }

    // 6. Validate the SW bundle BEFORE touching dist/ — a failed validation
    // must never destroy a previously working build output. (Previously the
    // gap scan ran AFTER the wipe + partial writes, so an aborted build left
    // dist/extension/ without manifest.json/background.js — an unloadable
    // extension that looks like total data loss to the user.)
    if (workerJS) {
        const { gaps, guardedGaps } = scanSwBundleGaps(workerJS);
        if (gaps.length > 0) {
            console.error('\n  SW-bundle gaps — identifiers called but not declared:');
            gaps.forEach(g => console.error('    - ' + g.name + '  (near: ' + g.ctx + ')'));
            console.error('  Fix by declaring them in the bundle (real impl or worker/020-page-stubs.js) or adding them to the SW_SCANNER_BUILTINS allow-list if they are platform globals.\n');
            throw new Error('SW-bundle has ' + gaps.length + ' undeclared identifier(s); aborting build (dist/ untouched).');
        }
        console.log(`  SW-bundle: no undeclared identifiers`);
        // Non-fatal: typeof-guarded calls whose target is undefined in the
        // worker context. Each is a silent no-op in the SW — fine when the
        // guard is an intentional dual-context branch (page delegate + SW
        // fallback, e.g. wsNotifyPrMerged → markChatPrMerged), a BUG when the
        // guarded call is the only path (how the pr_merged flag was silently
        // never written). Review new entries; they never fail the build.
        if (guardedGaps.length > 0) {
            console.warn(`  SW-bundle: ${guardedGaps.length} typeof-guarded identifier(s) undefined in worker context (guarded calls silently no-op in the SW):`);
            guardedGaps.forEach(g => console.warn('    - ' + g.name + '  (near: ' + g.ctx + ')'));
        }
    }

    // 7. Write output files
    // Wipe outDir first so files removed from src/ don't linger as cruft in
    // dist/extension/ (e.g. if a worker-tier file is renamed/deleted, the old
    // copy would otherwise still get bundled into the .zip and confuse the
    // browser at install time). `fs.rmSync(..., { recursive: true })` is a
    // no-op when the directory doesn't exist (force: true).
    const outDir = path.join(DIST, 'extension');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.join(outDir, 'app.html'), versionedHTML, 'utf-8');
    fs.writeFileSync(path.join(outDir, 'app.js'), appJS, 'utf-8');
    fs.writeFileSync(path.join(outDir, 'app.css'), cssContent, 'utf-8');
    if (themeInitJS) fs.writeFileSync(path.join(outDir, 'theme-init.js'), themeInitJS, 'utf-8');
    if (viewInitJS) fs.writeFileSync(path.join(outDir, 'view-init.js'), viewInitJS, 'utf-8');
    if (workerJS) {
        fs.writeFileSync(path.join(outDir, 'sw-bundle.js'), workerJS, 'utf-8');
    }

    // 8. Copy extension-specific files
    const extSrcDir = path.join(SRC, 'platform/extension');
    for (const file of ['manifest.json', 'background.js', 'content-script.js', 'rules.json', 'sandbox.html', 'widget-sandbox.html', 'file-download.html', 'file-download.js', 'offscreen.html', 'offscreen-helper.js']) {
        const srcPath = path.join(extSrcDir, file);
        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, path.join(outDir, file));
            console.log(`  Copied: ${file}`);
        }
    }

    // 9. Copy icons if they exist
    const iconsDir = path.join(extSrcDir, 'icons');
    if (fs.existsSync(iconsDir)) {
        const outIconsDir = path.join(outDir, 'icons');
        fs.mkdirSync(outIconsDir, { recursive: true });
        for (const icon of fs.readdirSync(iconsDir)) {
            fs.copyFileSync(path.join(iconsDir, icon), path.join(outIconsDir, icon));
        }
        console.log(`  Copied: icons/`);
    }

    console.log(`  Output: ${outDir}/`);
}

// ─── Main ───
buildExtension();
