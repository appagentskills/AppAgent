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
    // 055-emoji-shortcodes: SECTION_ICON_SHORTCODES map + replaceEmojiShortcodes,
    // called unconditionally by formatContent — DOM-free, safe in the SW.
    'js/core/055-emoji-shortcodes.js',
    'js/core/060-ui-constants.js',
    'js/core/070-permissions.js',
    // 078-tool-profiles declares TOOL_PROFILES + getToolNamesForProfiles,
    // used by 097-sub-agent-registry (spawn-time tool_roster filter) and
    // worker/025-permissions-helpers (main-chat profile filter). Must load
    // before 080-tools/097.
    'js/core/078-tool-profiles.js',
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

// ─── Decl-parity check: SW runtime globals ↔ page bundle ─────────────
// worker/000-runtime-globals.js re-declares the page bundle's chat/run
// globals so the shared agent code (WORKER_SHARED_FILES) sees the same
// free variables in both realms. Its header says "keep names in sync" —
// this check ENFORCES it: every top-level `var` name in that file must
// be declared at the top level of BOTH bundles. If a page-side
// declaration is renamed or removed while worker/000 still lists it
// (or vice versa), shared code throws ReferenceError at runtime in the
// realm that lost the declaration — this fails the build instead,
// BEFORE dist/ is touched.
//
// Names in DECL_PARITY_SW_ONLY are intentionally SW-only. Allowlist
// bar: zero page-tier references at all, or every page-tier reference
// typeof-guarded. Verify with a grep before adding a name here.
const DECL_PARITY_SW_ONLY = new Set([
    // SW pause map (worker/130-port-bridge.js toggle-pause). Page refs:
    // only typeof-guarded reads in core/097-sub-agent-registry.js
    // (:2287, :3661 at the time of writing).
    'pausedChatIds',
    // Layer-C parked UI tool calls (worker/120-tool-routing.js). Zero
    // page-tier references — worker tier only.
    'parkedToolCallsByChatId',
]);

// Top-level `var` names of a JS source: strip block comments + full-line
// line comments, then match `var` at column 0. In this codebase a
// column-0 `var` IS a top-level declaration (function bodies are
// indented), so this is a reliable file-scope decl extractor for both
// the manifest file and the concatenated bundles.
function topLevelVarNames(src) {
    const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    const names = [];
    const re = /^var\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(stripped)) !== null) names.push(m[1]);
    return names;
}

// ─── Write-site ratchet shared logic (RFC Flux Phase 1) ──────────────
// KEEP IN SYNC (byte-identical) between build/build.js and
// skills/extension-dev/build.js — the in-browser replica enforces the
// same guard on Reload builds. Byte-identity of this whole region
// (through the End marker below, incl. the chat-meta and guard-region
// helpers) is ENFORCED by compareGuardRegions — drift fails the build.
//
// Guards the unidirectional-data-flow (Flux) migration against
// backsliding: per-file counts of the canonical-state
// write/render/persist token patterns are checked in at
// build/write-site-ratchet.json, and the build FAILS when any per-file
// count INCREASES. Decreases are the ratchet direction — tighten the
// baseline when they land (node build/build.js --update-ratchet).
// Counting is token-based on comment-stripped source (block comments +
// full-line // comments, same rules as topLevelVarNames in
// build/build.js) — a tripwire against accidental new write sites, not
// a sandbox against adversarial code (globalThis.chats[...] would
// evade it; review catches that).
var WRITE_SITE_RATCHET_PATTERNS = [
    // chats[<key>] = ... — direct canonical chats-map entry assignment.
    // The lookbehind excludes lookalikes (pausedChats[...], obj.chats[...]);
    // (?![=>]) excludes == / === comparisons.
    { id: 'chatsAssign', label: 'chats[...] = assignment', re: '(?<![\\w$.])chats\\s*\\[[^\\]\\n]*\\]\\s*=(?![=>])' },
    // saveChatsToStorage( — chat persistence site. Calls AND definitions
    // count: a second definition of the persister is also a new write path.
    { id: 'saveChatsToStorage', label: 'saveChatsToStorage( site', re: '(?<![\\w$.])saveChatsToStorage\\s*\\(' },
    // renderMessages( — message render site.
    { id: 'renderMessages', label: 'renderMessages( site', re: '(?<![\\w$.])renderMessages\\s*\\(' },
    // currentChatId = ... — selected-chat global assignment. Declarations
    // count too; property writes (msg.currentChatId = ...) are a different
    // variable and don't.
    { id: 'currentChatIdAssign', label: 'currentChatId = assignment', re: '(?<![\\w$.])currentChatId\\s*=(?![=>])' },
    // IDB object-store row deletes, all three call shapes: <ident ending in
    // store/Store>.delete( | objectStore(...).delete( | zero-arg .delete()
    // (an IDB cursor delete — Map/Set .delete always passes a key). RFC
    // addendum §4.1: a regex cannot see WHICH store a delete targets, so
    // EVERY object-store delete site is baselined per file — any new delete
    // call (in particular any chats-store delete outside deleteChatRow,
    // core/130-indexeddb.js) rises above the baseline and fails the build
    // until reviewed. The user-initiated wipe-all path uses store.clear(),
    // not delete, so it never counts here.
    { id: 'idbStoreDelete', label: 'IDB object-store .delete( site', re: '[\\w$]*[Ss]tore\\s*\\.\\s*delete\\s*\\(|objectStore\\s*\\([^()\\n]*\\)\\s*\\.\\s*delete\\s*\\(|\\.\\s*delete\\s*\\(\\s*\\)' },
    // chats[<x>].<field> = / chat.<field> = — direct chat-FIELD pokes.
    // chatsAssign above only sees whole-entry assignment; field-level
    // writes on the canonical row (or a `chat` alias of it) evade it.
    // Chained paths (chat.meta.x =) count too. Compound assignments
    // (+=, ||=) and optional chaining (chat?.x =) have zero sites at
    // the time of writing and are NOT matched — extend the regex if
    // one ever appears.
    { id: 'chatFieldPoke', label: 'chat-field poke (chats[...].f = / chat.f =)', re: '(?<![\\w$.])chats\\s*\\[[^\\]\\n]*\\](?:\\s*\\.\\s*[\\w$]+)+\\s*=(?![=>])|(?<![\\w$.])chat(?:\\s*\\.\\s*[\\w$]+)+\\s*=(?![=>])' },
    // delete chats[<x>] — canonical chats-map entry eviction. Every
    // baselined site is paired with a sanctioned IDB row removal
    // (deleteChatRow / the SW boot-eviction path); a NEW bare delete is
    // a Flux bypass until reviewed.
    { id: 'deleteChatsEntry', label: 'delete chats[...] site', re: '(?<![\\w$.])delete\\s+chats\\s*\\[' },
    // chrome.storage.local.set( — storage side-bus write site. A KEY
    // registry was evaluated and skipped: at the time of writing 8 sites
    // pass a computed object or variable (background.js:71/838,
    // platform-bridge.js:587/635/907/1481, ui/070-dashboard-ui.js:1697),
    // so static key extraction cannot be trusted. Ratcheting the SITES
    // still surfaces any new side-bus channel for review.
    { id: 'storageLocalSet', label: 'chrome.storage.local.set( site', re: 'chrome\\s*\\.\\s*storage\\s*\\.\\s*local\\s*\\.\\s*set\\s*\\(' }
];

function stripCommentsForRatchet(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

// { 'src/js/...': source } → { patternId: { file: count } }. Only
// non-zero counts are recorded; files iterate sorted so regenerated
// baselines are byte-stable.
function computeWriteSiteRatchetCounts(fileMap) {
    var counts = {};
    Object.keys(fileMap).sort().forEach(function(file) {
        var src = stripCommentsForRatchet(fileMap[file]);
        WRITE_SITE_RATCHET_PATTERNS.forEach(function(p) {
            var re = new RegExp(p.re, 'g');
            var n = 0;
            while (re.exec(src) !== null) n++;
            if (n > 0) {
                if (!counts[p.id]) counts[p.id] = {};
                counts[p.id][file] = n;
            }
        });
    });
    return counts;
}

// baseline/current per-pattern file→count maps → { violations (count
// rose — fail the build), tightenable (count fell — update baseline) }.
function compareWriteSiteRatchet(baselinePatterns, currentCounts) {
    var violations = [];
    var tightenable = [];
    WRITE_SITE_RATCHET_PATTERNS.forEach(function(p) {
        var base = baselinePatterns[p.id] || {};
        var cur = currentCounts[p.id] || {};
        var seen = {};
        Object.keys(base).concat(Object.keys(cur)).forEach(function(f) { seen[f] = true; });
        Object.keys(seen).sort().forEach(function(f) {
            var b = base[f] || 0;
            var c = cur[f] || 0;
            if (c > b) violations.push({ pattern: p.id, label: p.label, file: f, baseline: b, current: c });
            else if (c < b) tightenable.push({ pattern: p.id, label: p.label, file: f, baseline: b, current: c });
        });
    });
    return { violations: violations, tightenable: tightenable };
}

// ─── Chat-meta lane vocabulary guard (shared, Flux guard rails) ──────
// Hosted inside this synced region so the guard-region check below also
// protects it against divergence between the two build implementations.

// The chat-meta lane lists are declared ONCE, in core/030-config.js —
// bundled into BOTH outputs (page core tier + WORKER_SHARED_FILES). The
// old per-realm twin copies (worker/115-storage.js + ui/070-dashboard-
// ui.js) could silently drift; a re-declaration anywhere re-opens that
// bug class (a later `var` in the same bundle SHADOWS the shared one),
// so the check fails on: a missing shared decl, ANY duplicate decl in
// src, or a built bundle whose first parsed decl differs from the
// shared file (= not bundled / shadowed).
var CHAT_META_SHARED_FILE = 'src/js/core/030-config.js';
var CHAT_META_SHARED_LISTS = ['CHAT_META_TS_FIELDS', 'CHAT_META_FLAG_FIELDS'];

// First `var <name> = ['a', 'b']` declaration in src → ['a','b'];
// null when missing/unparseable — callers FAIL loudly on null.
function parseDeclaredStringList(src, name) {
    var m = new RegExp('^[ \\t]*var\\s+' + name + '\\s*=\\s*\\[([^\\]]*)\\]', 'm').exec(src);
    if (!m) return null;
    var items = [];
    var re = /'([^'\n]*)'|"([^"\n]*)"/g;
    var s;
    while ((s = re.exec(m[1])) !== null) items.push(s[1] !== undefined ? s[1] : s[2]);
    return items;
}

// (srcByFile: { 'src/js/...': source }, bundles: { 'app.js': src,
// 'sw-bundle.js': src }) → array of failure strings ([] = in sync).
function checkChatMetaSharedLists(srcByFile, bundles) {
    var failures = [];
    CHAT_META_SHARED_LISTS.forEach(function(name) {
        var shared = parseDeclaredStringList(srcByFile[CHAT_META_SHARED_FILE] || '', name);
        if (!shared) {
            failures.push(name + ': `var ' + name + ' = [...]` not found in ' + CHAT_META_SHARED_FILE + ' — if the declaration moved, update CHAT_META_SHARED_FILE in the shared guard region (build/build.js AND skills/extension-dev/build.js).');
        }
        Object.keys(srcByFile).sort().forEach(function(f) {
            if (f === CHAT_META_SHARED_FILE) return;
            if (parseDeclaredStringList(srcByFile[f] || '', name) !== null) {
                failures.push(name + ': duplicate `var ' + name + ' = [...]` declaration in ' + f + ' — the lane vocabulary is single-source (' + CHAT_META_SHARED_FILE + '); a second copy shadows it and re-opens the realm-drift bug class. Reference the shared declaration instead.');
            }
        });
        if (!shared) return;
        Object.keys(bundles).sort().forEach(function(b) {
            var got = parseDeclaredStringList(bundles[b] || '', name);
            if (!got) {
                failures.push(name + ': no declaration in the built ' + b + ' bundle — ' + CHAT_META_SHARED_FILE + ' must stay in the page core tier AND in WORKER_SHARED_FILES so both realms load the shared lane vocabulary.');
            } else if (JSON.stringify(got) !== JSON.stringify(shared)) {
                failures.push(name + ': the built ' + b + ' bundle parses [' + got.join(', ') + '] but ' + CHAT_META_SHARED_FILE + ' declares [' + shared.join(', ') + '] — an earlier declaration in the bundle shadows the shared one.');
            }
        });
    });
    return failures;
}

// ─── Guard-region sync helpers ────────────────────────────────────────
// This whole marked region exists twice (build/build.js and
// skills/extension-dev/build.js); a comment was previously the only
// sync mechanism. Each build now extracts the region from BOTH files
// and fails on any byte difference. The marker strings are assembled
// from halves so these literals can never match the marker lines.
var GUARD_REGION_START = '─── Write-site ratchet ' + 'shared logic';
var GUARD_REGION_END = '─── End write-site ratchet ' + 'shared logic';

// Full lines from the start marker's line through the end marker's
// line, or null when either marker is missing.
function extractGuardRegion(src) {
    var i0 = src.indexOf(GUARD_REGION_START);
    var i1 = i0 < 0 ? -1 : src.indexOf(GUARD_REGION_END, i0);
    if (i0 < 0 || i1 < 0) return null;
    var from = src.lastIndexOf('\n', i0) + 1;
    var to = src.indexOf('\n', i1);
    return src.slice(from, to === -1 ? src.length : to);
}

// 32-bit FNV-1a hex — a small fingerprint for the failure message.
function fnv1aHex(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0');
}

// (buildSrc, skillSrc) → array of failure strings ([] = byte-identical).
function compareGuardRegions(buildSrc, skillSrc) {
    var a = extractGuardRegion(buildSrc);
    var b = extractGuardRegion(skillSrc);
    var failures = [];
    if (!a) failures.push('guard-region markers not found in build/build.js — restore the "' + GUARD_REGION_START + '" / "' + GUARD_REGION_END + '" comment lines.');
    if (!b) failures.push('guard-region markers not found in skills/extension-dev/build.js — restore the "' + GUARD_REGION_START + '" / "' + GUARD_REGION_END + '" comment lines.');
    if (failures.length > 0 || a === b) return failures;
    var la = a.split('\n');
    var lb = b.split('\n');
    for (var i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) {
            failures.push('region fnv1a ' + fnv1aHex(a) + ' (build/build.js, ' + la.length + ' lines) vs ' + fnv1aHex(b) + ' (skills/extension-dev/build.js, ' + lb.length + ' lines); first drift at region line ' + (i + 1) + ':' +
                '\n        build/build.js:                ' + (la[i] === undefined ? '<line missing>' : JSON.stringify(la[i]).slice(0, 140)) +
                '\n        skills/extension-dev/build.js: ' + (lb[i] === undefined ? '<line missing>' : JSON.stringify(lb[i]).slice(0, 140)) +
                '\n        The two copies MUST stay byte-identical — copy the edited region verbatim onto the other file.');
            break;
        }
    }
    return failures;
}
// ─── End write-site ratchet shared logic ─────────────────────────────

// Scan scope: every .js under src/js/ plus the flat extension platform
// files (background.js has a guarded saveChatsToStorage() call — new
// ad-hoc writers there must trip the ratchet too). dist/ and skills/
// are out of scope (generated output / not part of the app bundles).
function listRatchetScanFiles() {
    const out = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (entry.endsWith('.js')) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
    })(path.join(SRC, 'js'));
    for (const entry of fs.readdirSync(path.join(SRC, 'platform/extension'))) {
        const full = path.join(SRC, 'platform/extension', entry);
        if (entry.endsWith('.js') && !fs.statSync(full).isDirectory()) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
    return out.sort();
}

// Enforce the ratchet (or regenerate the baseline with --update-ratchet).
// Called from buildExtension() BEFORE the dist/ wipe — like the other
// validations, a failed build must never destroy a working output.
function runWriteSiteRatchet() {
    const baselinePath = path.join(ROOT, 'build', 'write-site-ratchet.json');
    const fileMap = {};
    for (const rel of listRatchetScanFiles()) fileMap[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const current = computeWriteSiteRatchetCounts(fileMap);
    if (process.argv.includes('--update-ratchet')) {
        // Print old→new per-file deltas before regenerating, so the console
        // shows exactly what the baseline bump/tighten covers (PR #788 review
        // follow-up). Reuses the shared comparator: violations = counts that
        // rose, tightenable = counts that fell.
        if (fs.existsSync(baselinePath)) {
            try {
                const prev = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
                const delta = compareWriteSiteRatchet(prev.patterns || {}, current);
                const changes = delta.violations.concat(delta.tightenable);
                if (changes.length === 0) {
                    console.log('  Write-site ratchet: no per-file count changes vs the old baseline');
                } else {
                    console.log('  Write-site ratchet: baseline deltas (old → new):');
                    for (const d of changes) console.log(`    - ${d.file}: ${d.label} ${d.baseline} → ${d.current}`);
                }
            } catch (e) {
                console.warn('  Write-site ratchet: could not diff old baseline (' + e.message + ')');
            }
        }
        const ordered = {};
        for (const p of WRITE_SITE_RATCHET_PATTERNS) if (current[p.id]) ordered[p.id] = current[p.id];
        const doc = {
            '//': 'Write-site ratchet baseline (RFC Flux Phase 1 guard rails). Per-file counts of canonical-state write/render/persist token sites. The build FAILS when any per-file count INCREASES vs this file — route new writes through the sanctioned paths instead, or bump this baseline in the same PR (node build/build.js --update-ratchet) so the increase is review-visible. Decreases only warn: tighten with the same command. Enforced by build/build.js and skills/extension-dev/build.js (in-browser replica).',
            patterns: ordered
        };
        fs.writeFileSync(baselinePath, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
        console.log('  Write-site ratchet: baseline regenerated at build/write-site-ratchet.json');
        return;
    }
    if (!fs.existsSync(baselinePath)) {
        throw new Error('Write-site ratchet baseline missing (build/write-site-ratchet.json); restore it or regenerate with: node build/build.js --update-ratchet');
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    const { violations, tightenable } = compareWriteSiteRatchet(baseline.patterns || {}, current);
    if (violations.length > 0) {
        console.error('\n  Write-site ratchet failures — per-file count rose above the checked-in baseline:');
        violations.forEach(v => console.error(`    - ${v.file}: ${v.label} — baseline ${v.baseline}, found ${v.current}`));
        console.error('  New canonical-state write sites regress the Flux migration (RFC Phase 1). Route the mutation/render/persist through the existing sanctioned path instead.');
        console.error('  If the new site is genuinely intentional, bump build/write-site-ratchet.json in the same PR (node build/build.js --update-ratchet) so reviewers see the increase.\n');
        throw new Error('Write-site ratchet failed for ' + violations.length + ' file/pattern pair(s); aborting build (dist/ untouched).');
    }
    console.log(`  Write-site ratchet: OK (${WRITE_SITE_RATCHET_PATTERNS.length} patterns across ${Object.keys(fileMap).length} files)`);
    if (tightenable.length > 0) {
        console.log(`  Write-site ratchet: ${tightenable.length} count(s) fell below baseline — tighten it: node build/build.js --update-ratchet`);
        tightenable.forEach(t => console.log(`    - ${t.file}: ${t.label} ${t.baseline} → ${t.current}`));
    }
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

        // Decl-parity: every SW runtime global declared in worker/000-
        // runtime-globals.js must exist as a top-level `var` in BOTH
        // bundles (see DECL_PARITY_SW_ONLY above for the intentional
        // SW-only exceptions). Runs before the dist/ wipe for the same
        // reason as the gap scan — a failed build must never destroy a
        // working output.
        const declParityManifest = topLevelVarNames(readSrcFile('js/worker/000-runtime-globals.js'));
        const pageTopVars = new Set(topLevelVarNames(appJS));
        const workerTopVars = new Set(topLevelVarNames(workerJS));
        const parityFailures = [];
        for (const name of declParityManifest) {
            if (!workerTopVars.has(name)) {
                parityFailures.push(name + '  (no top-level `var` in sw-bundle.js — manifest extraction broke?)');
            }
            if (DECL_PARITY_SW_ONLY.has(name)) continue;
            if (!pageTopVars.has(name)) {
                parityFailures.push(name + '  (no top-level `var` in app.js — page declaration renamed/removed?)');
            }
        }
        if (parityFailures.length > 0) {
            console.error('\n  Decl-parity failures — worker/000-runtime-globals.js names missing a top-level declaration:');
            parityFailures.forEach(f => console.error('    - ' + f));
            console.error('  Restore the missing declaration (page side: core/030-config.js and friends), or, if the name is genuinely SW-only (all page references typeof-guarded — grep first), add it to DECL_PARITY_SW_ONLY in build/build.js.\n');
            throw new Error('Decl-parity check failed for ' + parityFailures.length + ' name(s); aborting build (dist/ untouched).');
        }
        console.log(`  Decl-parity: ${declParityManifest.length} SW runtime globals declared in both bundles (${DECL_PARITY_SW_ONLY.size} SW-only allowlisted)`);
    }

    // 6b. Write-site ratchet (RFC Flux Phase 1) — enforced before the
    // dist/ wipe for the same reason as the gap/parity checks above.
    runWriteSiteRatchet();

    // 6c. CHAT_META lane vocabulary — the chat-meta field lists are
    // declared ONCE (core/030-config.js, shared into both bundles). The
    // check fails on a missing/duplicate declaration in src and on a
    // built bundle that lacks (or shadows) the shared declaration. Same
    // fail-loud bar as the twin-list parity check it replaces; enforced
    // before the dist/ wipe for the same reason.
    const chatMetaSrcByFile = {};
    for (const rel of listRatchetScanFiles()) chatMetaSrcByFile[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const chatMetaFailures = checkChatMetaSharedLists(chatMetaSrcByFile, { 'app.js': appJS, 'sw-bundle.js': workerJS });
    if (chatMetaFailures.length > 0) {
        console.error('\n  CHAT_META lane vocabulary failures:');
        chatMetaFailures.forEach(f => console.error('    - ' + f));
        throw new Error('CHAT_META lane vocabulary check failed (' + chatMetaFailures.length + ' failure(s)); aborting build (dist/ untouched).');
    }
    console.log(`  CHAT_META lane vocabulary: ${CHAT_META_SHARED_LISTS.join(' + ')} single-sourced in ${CHAT_META_SHARED_FILE}, present in both bundles`);

    // 6d. Guard-region sync — the shared guard region above is duplicated
    // into skills/extension-dev/build.js (the in-browser Reload replica).
    // Byte-identity used to be comment-enforced only; now drift fails the
    // build in both implementations.
    const guardRegionBuildSrc = fs.readFileSync(path.join(ROOT, 'build', 'build.js'), 'utf-8');
    const guardRegionSkillSrc = fs.readFileSync(path.join(ROOT, 'skills', 'extension-dev', 'build.js'), 'utf-8');
    const guardRegionFailures = compareGuardRegions(guardRegionBuildSrc, guardRegionSkillSrc);
    if (guardRegionFailures.length > 0) {
        console.error('\n  Guard-region sync failures:');
        guardRegionFailures.forEach(f => console.error('    - ' + f));
        throw new Error('Shared guard region drifted between build/build.js and skills/extension-dev/build.js; aborting build (dist/ untouched).');
    }
    console.log('  Guard-region sync: build/build.js ↔ skills/extension-dev/build.js byte-identical (fnv1a ' + fnv1aHex(extractGuardRegion(guardRegionBuildSrc)) + ')');

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
