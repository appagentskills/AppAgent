// i18n phase-4 fixes.
// (1) RTL overflow fade: ui/250 _updateRowShadow sets .has-left-shadow instead
//     of .has-right-shadow when i18nDir() is 'rtl', so every
//     `.X.has-right-shadow` rule in src/css needs a `.X.has-left-shadow` mirror
//     whose gradients run `to left` (src/css/26-rtl.css section 4).
// (2) The action pending-approval popover (tools/120-actions.js
//     openPendingApprovalForActionInline) translates the tool display name inside
//     'Approval needed: {tool}', like the ui/220 notification sites, and still
//     escapes it. No new catalog keys: the name is a TOOL_DISPLAY_NAMES N_() value.
// Run: run_tests { files: ['test/i18n-phase4-fixes.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var _css = null;
async function cssFiles() {
    if (_css) return _css;
    var ls = await executeTool('workspace', { action: 'ls', path: 'src/css' });
    var names = (ls.entries || ls.files || []).map(function(e) {
        return String(typeof e === 'string' ? e : (e.path || e.name)).split(' ')[0].replace(/^.*\//, '');
    }).filter(function(f) { return /\.css$/.test(f); }).map(function(f) { return 'src/css/' + f; }).sort();
    ['05-tools.css', '26-rtl.css'].forEach(function(f) {
        if (names.indexOf('src/css/' + f) < 0) throw new Error('src/css listing is missing ' + f + ' (' + names.length + ' files listed)');
    });
    var out = [];
    for (var i = 0; i < names.length; i++) out.push({ file: names[i], src: await loadFile(names[i], WS) });
    return (_css = out);
}
// Innermost `selectors { declarations }` blocks, comments stripped. @media
// wrappers fall away because the selector text cannot span a brace.
function cssRules(src) {
    var out = [], re = /([^{}]+)\{([^{}]*)\}/g, m;
    src = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
    while ((m = re.exec(src))) {
        var decls = {};
        m[2].split(';').forEach(function(d) {
            var i = d.indexOf(':');
            if (i > 0) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
        });
        out.push({ selectors: m[1].replace(/^[\s\S]*;/, '').split(',').map(function(s) { return s.trim().replace(/\s+/g, ' '); }), decls: decls });
    }
    return out;
}
async function shadowRules() {
    var rights = [], lefts = {};
    (await cssFiles()).forEach(function(f) {
        cssRules(f.src).forEach(function(rule) {
            rule.selectors.forEach(function(sel) {
                var r = /^(.+)\.has-right-shadow$/.exec(sel), l = /^(.+)\.has-left-shadow$/.exec(sel);
                if (r) rights.push({ base: r[1], decls: rule.decls, file: f.file });
                if (l) (lefts[l[1]] = lefts[l[1]] || []).push({ decls: rule.decls, file: f.file });
            });
        });
    });
    return { rights: rights, lefts: lefts };
}
function mergedLeft(lefts, base) {
    var d = {};
    (lefts[base] || []).forEach(function(l) { Object.assign(d, l.decls); });   // later rules win, as in the cascade
    return d;
}

describe('i18n phase 4: RTL overflow fade mirrors .has-right-shadow', function() {
    it('every .X.has-right-shadow rule has a .X.has-left-shadow mirror running to left', async function() {
        var s = await shadowRules();
        assert.ok(s.rights.length >= 2, 'found the .has-right-shadow rules (' + s.rights.length + ')');
        s.rights.forEach(function(r) {
            var mirror = mergedLeft(s.lefts, r.base), mirrored = 0;
            Object.keys(r.decls).forEach(function(p) {
                assert.ok(Object.prototype.hasOwnProperty.call(mirror, p), r.base + '.has-left-shadow sets ' + p + ' (mirror of ' + r.file + ')');
                if (!/\bto right\b/.test(r.decls[p])) return;
                assert.strictEqual(mirror[p], r.decls[p].replace(/\bto right\b/g, 'to left'), r.base + '.has-left-shadow ' + p + ' runs to left');
                mirrored++;
            });
            assert.ok(mirrored >= 1, r.base + ': at least one mirrored gradient');
        });
    });

    it('the widgets and attachments rows fade on the left in both mask properties', async function() {
        var s = await shadowRules();
        ['.widgets-container', '.attachments-row'].forEach(function(base) {
            var d = mergedLeft(s.lefts, base);
            ['mask-image', '-webkit-mask-image'].forEach(function(p) {
                assert.strictEqual(d[p], 'linear-gradient(to left, black calc(100% - 40px), transparent)', base + '.has-left-shadow ' + p);
            });
        });
        Object.keys(s.lefts).forEach(function(base) {
            s.lefts[base].forEach(function(l) {
                Object.keys(l.decls).forEach(function(p) {
                    assert.ok(!/\bto right\b/.test(l.decls[p]), base + '.has-left-shadow ' + p + ' must not run to right (' + l.file + ')');
                });
            });
        });
    });

    it('ui/250 _updateRowShadow puts the fade on the left only in RTL', async function() {
        var src = await loadFile('src/js/ui/250-message-render.js', WS);
        var i = src.indexOf('function _updateRowShadow(');
        assert.ok(i >= 0, '_updateRowShadow exists');
        var fnSrc = src.slice(i, src.indexOf('\n}', i) + 2);
        var dir = 'ltr';
        var update = new Function('i18nDir', fnSrc + '\nreturn _updateRowShadow;')(function() { return dir; });
        function row(scrollLeft) {
            return { scrollWidth: 500, clientWidth: 200, scrollLeft: scrollLeft, classList: document.createElement('div').classList };
        }
        function shadows(r) { update(r); return [r.classList.contains('has-left-shadow'), r.classList.contains('has-right-shadow')]; }
        assert.deepStrictEqual(shadows(row(0)), [false, true], 'LTR at the start: right fade');
        dir = 'rtl';
        assert.deepStrictEqual(shadows(row(0)), [true, false], 'RTL at the start: left fade');
        assert.deepStrictEqual(shadows(row(-120)), [true, false], 'RTL mid-scroll (negative scrollLeft): left fade');
        assert.deepStrictEqual(shadows(row(-300)), [false, false], 'RTL at the end: no fade');
        // #1032: 500/200 overflow, RTL scrollLeft -100 -> ONLY the left fade; -300 (the end) -> neither.
        var r100 = row(-100); update(r100);
        assert.ok(r100.classList.contains('has-left-shadow') && !r100.classList.contains('has-right-shadow'), 'RTL -100: only has-left-shadow');
        assert.strictEqual(r100.classList.length, 1, 'RTL -100: exactly one shadow class');
        var r300 = row(-300); update(r300);
        assert.strictEqual(r300.classList.length, 0, 'RTL -300: neither shadow class');
        var noOverflow = { scrollWidth: 200, clientWidth: 200, scrollLeft: 0, classList: document.createElement('div').classList };
        assert.deepStrictEqual(shadows(noOverflow), [false, false], 'no overflow: no fade');
    });
});

describe('i18n phase 4: pending-approval popover translates the tool name (tools/120-actions.js)', function() {
    var FILES = ['src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/tools/120-actions.js'];
    var ANY_UNSTUBBED = { indexOf: function() { return 0; } };   // lenient load: optional globals are probed behind typeof guards
    var FR = { 'Approval needed: {tool}': 'Approbation requise : {tool}', 'tool call': "appel d'outil",
        'Run Script': 'Exécuter un <b>script</b>', 'Close': 'Fermer', 'Deny': 'Refuser', 'Allow Session': 'Autoriser la session', 'Allow': 'Autoriser' };
    var m = null, btn = null;
    function removePopovers() {
        var pops = document.querySelectorAll('.action-result-popover');
        for (var i = 0; i < pops.length; i++) if (pops[i].parentNode) pops[i].parentNode.removeChild(pops[i]);
    }
    afterEach(function() {
        if (m && typeof m.closeResultPopover === 'function') m.closeResultPopover();
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
        removePopovers();
        m = null; btn = null;
        U.cleanupAll();
    });
    async function openLabel(lang, approval) {
        removePopovers();
        var chats = { bg1: { id: 'bg1', messages: [{ role: 'user', content: 'go' },
            Object.assign({ role: 'approval', status: 'pending', args: { script: 'gs.info(1)', status_message: 'Running a script' } }, approval)] } };
        m = await U.loadUi(FILES, { globals: { chats: chats }, lenient: true, allowUnstubbed: ANY_UNSTUBBED });
        if (lang !== 'en') assert.ok(m.i18nSetCatalog(lang, FR), 'catalog accepted: ' + lang);
        assert.strictEqual(await m.i18nInit({ language: lang }), lang, 'active language ' + lang);
        m.activeActions.a1 = { actionId: 'a1', chatId: 'bg1', skillName: 'Audit Skill', actionName: 'Run Scan' };
        btn = document.createElement('button');
        document.body.appendChild(btn);
        m.openPendingApprovalForActionInline(btn, 'a1');
        var pops = document.querySelectorAll('.action-result-popover.state-needs_permission');
        assert.strictEqual(pops.length, 1, 'one approval popover rendered');
        var label = pops[0].querySelector('.action-result-label');
        assert.ok(label, 'approval label rendered');
        return label;
    }

    it('English stays the identity', async function() {
        var label = await openLabel('en', { toolName: 'Run Script' });
        assert.strictEqual(label.textContent, 'Approval needed: Run Script');
    });

    it('translates the display name inside the translated sentence and escapes it', async function() {
        var label = await openLabel('fr', { toolName: 'Run Script' });
        assert.strictEqual(label.textContent, 'Approbation requise : Exécuter un <b>script</b>');
        assert.strictEqual(label.querySelector('b'), null, 'the translated name is escaped, not parsed');
    });

    it('falls back to the translated "tool call" when the approval has no name', async function() {
        var label = await openLabel('fr', {});
        assert.strictEqual(label.textContent, "Approbation requise : appel d'outil");
    });

    it('an unknown or hostile name renders verbatim as text', async function() {
        var hostile = '<img src=x onerror="window.__pwn=1">';
        var label = await openLabel('fr', { toolName: hostile });
        assert.strictEqual(label.textContent, 'Approbation requise : ' + hostile);
        assert.strictEqual(label.querySelector('img'), null, 'no element injected');
    });
});
