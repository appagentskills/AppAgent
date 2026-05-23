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

        let name = folder, description = '', body = skillMd, fmRaw = '';
        const fmMatch = skillMd.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
            const fm = fmMatch[1];
            fmRaw = fm;
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

function getOrderedJsFiles() {
    return JS_TIERS.flatMap(tier => getOrderedFiles(path.join('js', tier), '.js'));
}

function concatFiles(files) {
    return files.map(f => readSrcFile(f)).join('\n');
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

    // 5. Write output files
    const outDir = path.join(DIST, 'extension');
    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.join(outDir, 'app.html'), versionedHTML, 'utf-8');
    fs.writeFileSync(path.join(outDir, 'app.js'), appJS, 'utf-8');
    fs.writeFileSync(path.join(outDir, 'app.css'), cssContent, 'utf-8');
    if (themeInitJS) fs.writeFileSync(path.join(outDir, 'theme-init.js'), themeInitJS, 'utf-8');
    if (viewInitJS) fs.writeFileSync(path.join(outDir, 'view-init.js'), viewInitJS, 'utf-8');

    // 6. Copy extension-specific files
    const extSrcDir = path.join(SRC, 'platform/extension');
    for (const file of ['manifest.json', 'background.js', 'content-script.js', 'rules.json', 'sandbox.html', 'widget-sandbox.html', 'file-download.html', 'file-download.js']) {
        const srcPath = path.join(extSrcDir, file);
        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, path.join(outDir, file));
            console.log(`  Copied: ${file}`);
        }
    }

    // 7. Copy icons if they exist
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
