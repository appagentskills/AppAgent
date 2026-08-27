var TOOL_DEFINITION = {
    type: "function",
    function: {
        name: "extension_build",
        description: "Build the AppAgent Chrome extension from source files in the workspace AND deploy the built output to the connected extension folder in one step. Reads src/ files, concatenates JS/CSS, transforms HTML for CSP compliance, embeds skills, writes built files to dist/extension/ in the workspace, then deploys dist/extension/ to disk via the connected folder. Requires an extension folder connected in Settings > GitHub > Connect Folder.",
        parameters: {
            type: "object",
            properties: {
                branch: { type: "string", description: "Branch to build from (optional, defaults to the default workspace branch)" },
                status_message: { type: "string", description: "Human-friendly status message describing what this tool call is doing (shown in UI header)" }
            },
            required: []
        }
    }
};

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

async function extension_build(args) {
    // Auto-detect the AppAgent workspace if the caller didn't provide one
    var defaultWorkspace = args.workspace || null;
    if (!defaultWorkspace) {
        try {
            var list = await executeTool("workspace", { action: "list" });
            if (list && list.workspaces && list.workspaces.length) {
                // Auto-detect order:
                //   1. the PINNED /AppAgent workspace (workspace pin / branch fork)
                //   2. the trunk among /AppAgent matches (::main, ::master)
                //   3. the first /AppAgent match
                //   4. the first workspace
                var appAgentMatches = [];
                for (var i = 0; i < list.workspaces.length; i++) {
                    if (/\/AppAgent(::|$)/.test(list.workspaces[i].workspace)) appAgentMatches.push(list.workspaces[i]);
                }
                for (var pi = 0; pi < appAgentMatches.length; pi++) {
                    if (appAgentMatches[pi].pinned) { defaultWorkspace = appAgentMatches[pi].workspace; break; }
                }
                if (!defaultWorkspace) {
                    for (var ti = 0; ti < appAgentMatches.length; ti++) {
                        if (/::(main|master)$/.test(appAgentMatches[ti].workspace)) { defaultWorkspace = appAgentMatches[ti].workspace; break; }
                    }
                }
                if (!defaultWorkspace && appAgentMatches.length) defaultWorkspace = appAgentMatches[0].workspace;
                if (!defaultWorkspace) defaultWorkspace = list.workspaces[0].workspace;
            }
        } catch (e) { /* non-fatal */ }
    }

    var ws = function(action, params) {
        params.action = action;
        if (args.branch) params.branch = args.branch;
        if (defaultWorkspace) params.workspace = defaultWorkspace;
        return executeTool("workspace", params);
    };

    // Lazy clones store file stubs (content fetched on demand). Bulk-hydrate
    // everything once up front so the hundreds of reads below don't each
    // trigger a one-file fetch. NOTE: hydrate reports failure via
    // success:false (it does NOT throw). A failed hydration would let the
    // parallel reads below fan out into ~200 concurrent per-file GitHub
    // fetches and/or silently drop files from the bundle — so abort the
    // build instead. Exception: an older runtime without the hydrate action
    // returns "Unknown workspace action" — that stays non-fatal (per-read
    // hydration still applies there).
    var hydrateResult = null;
    try { hydrateResult = await ws("hydrate", {}); }
    catch (e) { hydrateResult = { success: false, error: (e && e.message) ? e.message : String(e) }; }
    if (hydrateResult && hydrateResult.success === false && !/unknown workspace action/i.test(hydrateResult.error || '')) {
        var hydrateFailedPaths = hydrateResult.failed || [];
        return {
            success: false,
            error: 'Build aborted — workspace hydrate failed: ' + (hydrateResult.error || hydrateResult.last_error || (hydrateFailedPaths.length + ' file(s) failed to hydrate')),
            built_from: defaultWorkspace || null,
            hydrate_failed: hydrateFailedPaths.slice(0, 20)
        };
    }

    // Helper: list and sort files by name in a directory
    async function getOrderedFiles(dir, ext) {
        var lsResult = await ws("ls", { path: dir });
        if (!lsResult.success) return [];
        var files = [];
        lsResult.entries.forEach(function(entry) {
            // entries look like "filename.js" or "filename.js *" (dirty)
            var name = entry.split(' ')[0];
            if (name.endsWith(ext)) files.push(dir + '/' + name);
        });
        return files.sort();
    }

    // Helper: read file content (raw, no line numbers)
    async function readFile(path) {
        var result = await ws("read", { path: path });
        if (!result.success) return null;
        // Remove line number prefixes (format: "123\tcontent")
        var lines = result.content.split('\n').map(function(line) {
            var tabIdx = line.indexOf('\t');
            return tabIdx >= 0 ? line.substring(tabIdx + 1) : line;
        });
        return lines.join('\n');
    }

    // Helper: read and concat files in order. Reads are fired in PARALLEL
    // (each one is a sandbox->host message round-trip, so a sequential loop
    // over ~200 files costs seconds); Promise.all preserves input order.
    async function concatFiles(filePaths) {
        var contents = await Promise.all(filePaths.map(readFile));
        return contents.filter(function(c) { return c !== null; }).join('\n');
    }

    // 1. Concatenate JS: CSP polyfill (first) + core JS + platform bridge (last)
    // Version is sourced from manifest.json and substituted into the bundle wherever __VERSION__ appears.
    var manifestRaw = await readFile('src/platform/extension/manifest.json');
    var version = manifestRaw ? JSON.parse(manifestRaw).version : '';

    // JS bundle is composed of tiers concatenated in this fixed order.
    // Within each tier folder, files are sorted by their numeric prefix.
    // Keep in sync with build/build.js (JS_TIERS).
    var JS_TIERS = ['core', 'ui', 'tools', 'app'];
    var tierLists = await Promise.all(JS_TIERS.map(function(t) { return getOrderedFiles('src/js/' + t, '.js'); }));
    var jsFiles = [];
    for (var i = 0; i < tierLists.length; i++) jsFiles = jsFiles.concat(tierLists[i]);
    var coreJS = await concatFiles(jsFiles);

    // Worker (service worker) bundle composition. Mirror of build/build.js
    // WORKER_JS_TIERS + WORKER_SHARED_FILES. The SW hosts the agent loop
    // and all state — DOM-needing tools bridge to the offscreen document.
    // Order: 0xx worker files (declare globals + stubs) → shared files
    // (agent loop, streaming, tools) → 1xx+ worker files (port bridge,
    // tool routing, entry point).
    // KEEP IN SYNC with build/build.js WORKER_SHARED_FILES.
    var WORKER_SHARED_FILES = [
        'src/js/core/030-config.js',
        // emoji shortcode map + replaceEmojiShortcodes (formatContent calls it unconditionally)
        'src/js/core/055-emoji-shortcodes.js',
        'src/js/core/060-ui-constants.js',
        'src/js/core/070-permissions.js',
        // 078-tool-profiles — TOOL_PROFILES table + profile helpers used by
        // the roster filter (097) and worker/025. Before 080-tools/097.
        'src/js/core/078-tool-profiles.js',
        'src/js/core/080-tools.js',
        'src/js/core/085-eval-runner.js',
        'src/js/core/090-codemap.js',
        'src/js/core/095-handle-registry.js',
        // 097-sub-agent-registry — Phase 2 sub-agent runtime. Defines
        // global `SubAgents` used by tools/020-tool-execution.js dispatch
        // arms for spawn_sub_agent / report_to_parent / etc. Must load
        // AFTER handle-registry (uses Handles.start) and BEFORE tool-execution.
        'src/js/core/097-sub-agent-registry.js',
        'src/js/core/100-cached-results.js',
        'src/js/core/110-system-prompt.js',
        'src/js/core/130-indexeddb.js',
        'src/js/core/140-skills-engine.js',
        'src/js/core/150-record-helpers.js',
        'src/js/tools/040-file-store.js',
        'src/js/tools/050-file-tools.js',
        'src/js/tools/070-screenshot-by-id.js',
        'src/js/tools/110-smart-documents.js',
        'src/js/tools/020-tool-execution.js',
        'src/js/app/035-agent-events.js',
        'src/js/app/020-api-messages.js',
        'src/js/app/010-llm-streaming.js',
        'src/js/app/030-agent-loop.js'
    ];
    var workerTierFiles = await getOrderedFiles('src/js/worker', '.js');
    var workerPre = workerTierFiles.filter(function(f) { return /\/0\d\d-/.test(f); });
    var workerPost = workerTierFiles.filter(function(f) { return workerPre.indexOf(f) < 0; });
    var workerBundleFiles = workerPre.concat(WORKER_SHARED_FILES).concat(workerPost);
    var workerJS = await concatFiles(workerBundleFiles);

    var polyfillJS = await readFile('src/platform/extension/csp-polyfill.js') || '';
    var bridgeJS = await readFile('src/platform/extension/platform-bridge.js') || '';

    // The docs renderer is canonical at docs/docs-renderer.js (so github.io can
    // load it directly). Inject it into the bundle before 060-docs-view.js uses it.
    var docsRendererJS = await readFile('docs/docs-renderer.js') || '';

    var appJS = (polyfillJS ? polyfillJS + '\n' : '') + (docsRendererJS ? docsRendererJS + '\n' : '') + coreJS + (bridgeJS ? '\n' + bridgeJS : '');

    // 2. Embed skills
    var SKILLS_START = '/*EMBEDDED_SKILLS_START*/';
    var SKILLS_END = '/*EMBEDDED_SKILLS_END*/';
    var skillsLs = await ws("ls", { path: 'skills' });
    var embeddedSkills = [];
    if (skillsLs.success) {
        var skillDirs = skillsLs.entries.filter(function(e) { return e.indexOf('/') > 0; }).map(function(e) { return e.split('/')[0]; });
        // Build each skill's embed in parallel (every readFile/ls is a message
        // round-trip). Results are collected in order to keep the hash stable.
        var skillResults = await Promise.all(skillDirs.map(function(skillName) { return buildSkillEmbed(skillName); }));
        for (var si = 0; si < skillResults.length; si++) {
            if (skillResults[si]) embeddedSkills.push(skillResults[si]);
        }
    }

    async function buildSkillEmbed(skillName) {
        {
            var skillMd = await readFile('skills/' + skillName + '/SKILL.md');
            if (!skillMd) return null;

            var name = skillName, description = '', body = skillMd, devOnly = false;
            var fmMatch = skillMd.match(/^---\s*\n([\s\S]*?)\n---/);
            if (fmMatch) {
                var fm = fmMatch[1];
                // devOnly skills are hidden at runtime outside extension dev
                // mode (isSkillDevHidden in src/js/core/140-skills-engine.js).
                // Mirrors the same parse in build/build.js. fmRaw is already
                // hashed, so toggling devOnly bumps the hash.
                devOnly = /^devOnly:\s*true\s*$/m.test(fm);
                var nameMatch = fm.match(/^name:\s*(.+)$/m);
                var descMatch = fm.match(/^description:\s*(.+)$/m);
                if (nameMatch) name = nameMatch[1].trim().replace(/^"|"$/g, '');
                if (descMatch) description = descMatch[1].trim().replace(/^"|"$/g, '');
                body = skillMd.substring(fmMatch[0].length).trim();
            }
            // Keep the raw frontmatter in a separate field so the runtime can parse
            // the actions list on import. Avoids doing YAML parsing in the sandbox here.
            var fmRaw = fmMatch ? fmMatch[1] : '';

            // Read skill assets
            var skillFiles = await ws("ls", { path: 'skills/' + skillName });
            var assets = [];
            if (skillFiles.success) {
                var assetEntries = skillFiles.entries.filter(function(e) {
                    var n = e.split(' ')[0];
                    return n !== 'SKILL.md' && (n.endsWith('.js') || n.endsWith('.xml') || n.endsWith('.md'));
                });
                var assetNames = assetEntries.map(function(e) { return e.split(' ')[0]; });
                var assetContents = await Promise.all(assetNames.map(function(n) { return readFile('skills/' + skillName + '/' + n); }));
                for (var ai = 0; ai < assetNames.length; ai++) {
                    if (assetContents[ai]) {
                        var ext = assetNames[ai].split('.').pop().toLowerCase();
                        assets.push({ filename: assetNames[ai], type: ext, content: btoa(unescape(encodeURIComponent(assetContents[ai]))) });
                    }
                }
            }

            // Simple hash
            var hashInput = name + '\n' + description + '\n' + body + fmRaw + assets.map(function(a) { return a.filename + a.content; }).join('');
            var h = [0x243F6A88, 0x85A308D3, 0x13198A2E, 0x03707344];
            for (var hi = 0; hi < hashInput.length; hi++) {
                var c = hashInput.charCodeAt(hi);
                for (var hj = 0; hj < 4; hj++) {
                    h[hj] = Math.imul(h[hj] ^ c, 0x5BD1E995 + hj);
                    h[hj] ^= h[hj] >>> 15;
                }
            }
            var hash = h.map(function(v) { return (v >>> 0).toString(16).padStart(8, '0'); }).join('');

            return {
                id: name,
                name: name,
                description: description,
                devOnly: devOnly,
                body: btoa(unescape(encodeURIComponent(body))),
                frontmatter: btoa(unescape(encodeURIComponent(fmRaw))),
                hash: hash,
                assets: assets
            };
        }
    }

    // Inject embedded skills into BOTH bundles. The worker bundle has the
    // same EMBEDDED_SKILLS markers because it shares 140-skills-engine.js
    // with the page bundle. Without this, the SW system prompt would lack
    // skill instructions.
    function injectEmbeddedSkills(bundle) {
        if (embeddedSkills.length === 0) return bundle;
        var skillsJson = JSON.stringify(embeddedSkills);
        var sIdx = bundle.indexOf(SKILLS_START);
        var eIdx = bundle.indexOf(SKILLS_END);
        if (sIdx === -1 || eIdx === -1) return bundle;
        return bundle.substring(0, sIdx + SKILLS_START.length) + skillsJson + bundle.substring(eIdx);
    }
    appJS = injectEmbeddedSkills(appJS);
    workerJS = injectEmbeddedSkills(workerJS);

    // 3. Concatenate CSS
    var cssFiles = await getOrderedFiles('src/css', '.css');
    var cssContent = await concatFiles(cssFiles);

    // 4. Read HTML parts
    var headHtml = await readFile('src/html/head.html') || '';
    var bodyHtml = await readFile('src/html/body.html') || '';

    // 5. CSP transform — extract inline scripts and event handlers
    function transformHtmlForCSP(html) {
        var evCounter = 0;
        var bindings = [];
        var inlineScripts = [];

        // Extract inline <script>...</script> blocks
        html = html.replace(/<script>\n?([\s\S]*?)\n?\s*<\/script>/g, function(match, content) {
            inlineScripts.push(content);
            return '<!-- inline-script-' + (inlineScripts.length - 1) + ' -->';
        });

        // Strip inline event handlers, add data-ev-id markers
        html = html.replace(/<[a-zA-Z][^>]*\son[a-z]+="[^"]*"[^>]*>/g, function(tag) {
            var handlers = [];
            var stripped = tag.replace(/\s(on([a-z]+))="([^"]*)"/g, function(m, attr, eventName, code) {
                handlers.push({ event: eventName, code: code });
                return '';
            });
            if (handlers.length === 0) return tag;
            var evId = evCounter++;
            var tagged = stripped.replace(/^(<[a-zA-Z]+)/, '$1 data-ev-id="' + evId + '"');
            handlers.forEach(function(h) { bindings.push({ evId: evId, event: h.event, code: h.code }); });
            return tagged;
        });

        // Generate binding JS
        var bindingJS = '// Auto-generated: event bindings extracted from inline handlers\n';
        bindingJS += '(function() {\n';
        bindingJS += '    function _bindEv(id, ev, fn) {\n';
        bindingJS += '        var el = document.querySelector(\'[data-ev-id="\' + id + \'"]\');\n';
        bindingJS += '        if (el) el.addEventListener(ev, fn);\n';
        bindingJS += '    }\n';
        bindings.forEach(function(b) {
            bindingJS += '    _bindEv(' + b.evId + ', "' + b.event + '", function(event) { ' + b.code + ' });\n';
        });
        bindingJS += '})();\n';

        return { html: html, inlineScripts: inlineScripts, bindingJS: bindingJS };
    }

    var headResult = transformHtmlForCSP(headHtml);
    var bodyResult = transformHtmlForCSP(bodyHtml);

    var themeInitJS = headResult.inlineScripts[0] || '';
    var viewInitJS = bodyResult.inlineScripts[0] || '';

    // Append event bindings to app.js
    if (bodyResult.bindingJS) appJS += '\n' + bodyResult.bindingJS;
    if (headResult.bindingJS) appJS += '\n' + headResult.bindingJS;

    // 6. Assemble app.html
    var processedHead = headResult.html.replace('<!-- inline-script-0 -->', '<script src="theme-init.js"><\/script>');
    var processedBody = bodyResult.html.replace('<!-- inline-script-0 -->', '<script src="view-init.js"><\/script>');

    var appHTML = '<!DOCTYPE html>\n' + processedHead + '\n    <link rel="stylesheet" href="app.css">\n</head>\n' + processedBody + '\n<script src="app.js"><\/script>\n</body>\n</html>';

    // Embed docs/documentation.md and README.md as base64 strings (same scheme
    // as build/build.js). Substitute __VERSION__ inside documentation.md first
    // so the runtime never sees the placeholder. Both get merged at runtime
    // via mergeReadmeIntoDocs.
    var docsMd = await readFile('docs/documentation.md');
    if (docsMd) {
        if (version) docsMd = docsMd.split('__VERSION__').join(version);
        var docsB64 = btoa(unescape(encodeURIComponent(docsMd)));
        appJS = appJS.split('__DOCS_MARKDOWN_B64__').join(docsB64);
        workerJS = workerJS.split('__DOCS_MARKDOWN_B64__').join(docsB64);
    }
    var readmeMd = await readFile('README.md');
    if (readmeMd) {
        var readmeB64 = btoa(unescape(encodeURIComponent(readmeMd)));
        appJS = appJS.split('__README_MARKDOWN_B64__').join(readmeB64);
        workerJS = workerJS.split('__README_MARKDOWN_B64__').join(readmeB64);
    }

    if (version) {
        appJS = appJS.split('__VERSION__').join(version);
        workerJS = workerJS.split('__VERSION__').join(version);
        appHTML = appHTML.split('__VERSION__').join(version);
    }

    // 6b. Write-site ratchet (RFC Flux Phase 1) — mirror of the
    // build/build.js check, enforced BEFORE any dist/ writes. Per-file
    // counts of canonical-state write/render/persist sites must not rise
    // above the checked-in baseline (build/write-site-ratchet.json).
    // Scope mirrors build/build.js listRatchetScanFiles(): src/js/**/*.js
    // (page tiers + worker tier) plus src/platform/extension/*.js.
    var ratchetScanFiles = jsFiles.concat(workerTierFiles);
    var ratchetPlatLs = await ws("ls", { path: 'src/platform/extension' });
    if (ratchetPlatLs.success) {
        ratchetPlatLs.entries.forEach(function(e) {
            var rn = e.split(' ')[0];
            if (rn.endsWith('.js')) ratchetScanFiles.push('src/platform/extension/' + rn);
        });
    }
    ratchetScanFiles = ratchetScanFiles.slice().sort();
    var ratchetContents = await Promise.all(ratchetScanFiles.map(readFile));
    var ratchetFileMap = {};
    for (var rfi = 0; rfi < ratchetScanFiles.length; rfi++) {
        if (ratchetContents[rfi] !== null) ratchetFileMap[ratchetScanFiles[rfi]] = ratchetContents[rfi];
    }
    var ratchetBaselineRaw = await readFile('build/write-site-ratchet.json');
    if (!ratchetBaselineRaw) {
        return {
            success: false,
            error: 'Build aborted — write-site ratchet baseline missing (build/write-site-ratchet.json). Restore it, or regenerate with: node build/build.js --update-ratchet.',
            built_from: defaultWorkspace || null
        };
    }
    var ratchetCheck = compareWriteSiteRatchet((JSON.parse(ratchetBaselineRaw).patterns) || {}, computeWriteSiteRatchetCounts(ratchetFileMap));
    if (ratchetCheck.violations.length > 0) {
        return {
            success: false,
            error: 'Build aborted — write-site ratchet: ' + ratchetCheck.violations.length + ' file/pattern pair(s) rose above the checked-in baseline (RFC Flux Phase 1). New canonical-state write sites regress the Flux migration — route the write through the sanctioned path, or bump build/write-site-ratchet.json in the same PR (node build/build.js --update-ratchet) so the increase is review-visible.',
            built_from: defaultWorkspace || null,
            ratchet_violations: ratchetCheck.violations
        };
    }

    // 6c. CHAT_META lane vocabulary — mirror of the build/build.js
    // check: the chat-meta field lists are declared ONCE
    // (core/030-config.js, shared into both bundles); fail on a
    // missing/duplicate declaration in src (sources already loaded in
    // ratchetFileMap) and on a built bundle that lacks (or shadows) the
    // shared declaration.
    var chatMetaFailures = checkChatMetaSharedLists(ratchetFileMap, { 'app.js': appJS, 'sw-bundle.js': workerJS });
    if (chatMetaFailures.length > 0) {
        return {
            success: false,
            error: 'Build aborted — CHAT_META lane vocabulary: ' + chatMetaFailures.join(' || '),
            built_from: defaultWorkspace || null
        };
    }

    // 6d. Guard-region sync — this file's shared guard region is a
    // replica of the one in build/build.js; fail the build on any byte
    // drift between the two copies.
    var guardRegionBuildSrc = await readFile('build/build.js');
    var guardRegionSkillSrc = await readFile('skills/extension-dev/build.js');
    var guardRegionFailures = (guardRegionBuildSrc !== null && guardRegionSkillSrc !== null)
        ? compareGuardRegions(guardRegionBuildSrc, guardRegionSkillSrc)
        : ['could not read build/build.js and/or skills/extension-dev/build.js from the workspace — both are needed for the guard-region sync check.'];
    if (guardRegionFailures.length > 0) {
        return {
            success: false,
            error: 'Build aborted — guard-region sync: ' + guardRegionFailures.join(' || '),
            built_from: defaultWorkspace || null
        };
    }

    // 7. Write output files to dist/extension/ in workspace
    var outputFiles = [
        { path: 'dist/extension/app.html', content: appHTML },
        { path: 'dist/extension/app.js', content: appJS },
        { path: 'dist/extension/app.css', content: cssContent },
        // sw-bundle.js is the service worker runtime — background.js does
        // importScripts('sw-bundle.js') at the top of the file. Without
        // this output, the SW has zero runtime and every agent call from
        // the SW context fails silently inside the try/catch in background.js.
        { path: 'dist/extension/sw-bundle.js', content: workerJS }
    ];
    if (themeInitJS) outputFiles.push({ path: 'dist/extension/theme-init.js', content: themeInitJS });
    if (viewInitJS) outputFiles.push({ path: 'dist/extension/view-init.js', content: viewInitJS });

    // 8. Copy extension platform files (offscreen.* host the DOM-needing
    // helpers the SW bridges to via chrome.runtime.sendMessage — js_eval
    // sandbox, image canvas, skills sandbox).
    var extFiles = ['manifest.json', 'background.js', 'content-script.js', 'rules.json', 'sandbox.html', 'widget-sandbox.html', 'file-download.html', 'file-download.js', 'offscreen.html', 'offscreen-helper.js'];
    var extContents = await Promise.all(extFiles.map(function(f) { return readFile('src/platform/extension/' + f); }));
    for (var ei = 0; ei < extFiles.length; ei++) {
        if (extContents[ei] !== null) {
            outputFiles.push({ path: 'dist/extension/' + extFiles[ei], content: extContents[ei] });
        }
    }

    // 9. Icons: deploy directly from source to preserve binary integrity.
    // workspace read/write corrupts binary files (PNG) — there is no "copy" action.
    // Instead, deploy the original git clone blobs straight from src/.
    var iconsDeploy = await executeTool("workspace", {
        action: "deploy",
        path: "src/platform/extension/icons",
        dest: "icons",
        workspace: defaultWorkspace
    });
    // files_skipped = already identical on disk (counts as deployed)
    var iconsCopied = iconsDeploy.success ? (iconsDeploy.files_written || 0) + (iconsDeploy.files_skipped || 0) : 0;
    // Zero icons means the icons source dir is missing/renamed or its deploy
    // failed — the extension would load without icons. Surface it prominently.
    var iconsWarning = iconsCopied === 0
        ? ('Icons deploy produced 0 files' + (iconsDeploy && iconsDeploy.error ? ' (' + iconsDeploy.error + ')' : '') + ' — extension icons may be missing or stale.')
        : null;

    // Write all output files. dist/* is gitignored, so the workspace cross-chat
    // conflict guard skips them automatically — we still check per-file success in
    // case some other failure mode (IDB write error, validation, etc.) trips.
    var fileNames = [];
    var writeFailures = [];
    var writeResults = await Promise.all(outputFiles.map(function(f) {
        return ws("write", { path: f.path, content: f.content });
    }));
    for (var wi = 0; wi < outputFiles.length; wi++) {
        if (writeResults[wi] && writeResults[wi].success) {
            fileNames.push(outputFiles[wi].path);
        } else {
            writeFailures.push({ path: outputFiles[wi].path, error: (writeResults[wi] && writeResults[wi].error) || 'unknown error' });
        }
    }

    if (writeFailures.length > 0) {
        return {
            success: false,
            error: 'Build aborted — ' + writeFailures.length + ' of ' + outputFiles.length + ' file write(s) failed. Skipping deploy.',
            built_from: defaultWorkspace || null,
            files: fileNames,
            write_failures: writeFailures,
            stats: {
                jsFiles: jsFiles.length,
                workerBundleFiles: workerBundleFiles.length,
                cssFiles: cssFiles.length,
                skills: embeddedSkills.length,
                iconsCopied: iconsCopied,
                writesAttempted: outputFiles.length,
                writesSucceeded: fileNames.length,
                writesFailed: writeFailures.length
            }
        };
    }

    // 10. Deploy dist/extension/ to the connected folder
    var deployResult = null;
    var deployError = null;
    try {
        deployResult = await executeTool("workspace", {
            action: "deploy",
            path: "dist/extension",
            workspace: defaultWorkspace
        });
        if (!deployResult || !deployResult.success) {
            deployError = (deployResult && (deployResult.error || deployResult.message)) || 'Deploy failed';
        }
    } catch (e) {
        deployError = e && e.message ? e.message : String(e);
    }

    var filesDeployed = deployResult && deployResult.success ? (deployResult.files_written || 0) + (deployResult.files_skipped || 0) : 0;
    var deployedSummary = deployError ? 'deploy failed: ' + deployError : 'deployed ' + filesDeployed + ' files to connected folder';

    return {
        success: !deployError,
        message: 'Built ' + fileNames.length + ' files to dist/extension/; ' + deployedSummary,
        warning: iconsWarning || undefined,
        ratchet_tighten: ratchetCheck.tightenable.length ? ratchetCheck.tightenable : undefined,
        built_from: defaultWorkspace || null,
        files: fileNames,
        deploy: deployError ? { success: false, error: deployError } : deployResult,
        stats: {
            jsFiles: jsFiles.length,
            workerBundleFiles: workerBundleFiles.length,
            cssFiles: cssFiles.length,
            skills: embeddedSkills.length,
            eventBindings: (headResult.bindingJS.match(/_bindEv/g) || []).length - 1 + (bodyResult.bindingJS.match(/_bindEv/g) || []).length - 1,
            iconsCopied: iconsCopied,
            filesDeployed: filesDeployed
        }
    };
}
