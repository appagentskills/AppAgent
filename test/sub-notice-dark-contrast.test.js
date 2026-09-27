// Dark-mode contrast regression for the sub-agent report notice card
// (_subNoticeCardHtml, src/js/ui/175-sub-agent-ui.js). Bug: the collapsed
// error preview used var(--text, #24292f) and the expanded body
// var(--bg, #fff); neither token exists, so the light fallbacks applied in
// the dark theme (dark-on-dark preview, light text on a white box). The
// filled status pills (white text on var(--success/--warning/--text-muted))
// also failed 4.5:1 in one theme or both.
// Mounts the REAL markup + the stylesheet bundle built exactly like
// app.css, flips :root[data-theme] and asserts WCAG contrast (>= 4.5:1) on
// computed colours. A canary test re-applies the pre-fix declarations and
// requires the same measurement to FAIL, so the suite cannot pass vacuously.

var _cssText = null;
// Mirrors the extension builder (skills/extension-dev/build.js
// getOrderedFiles + concatFiles; build/build.js is the same readdir + sort +
// join): ls src/css, strip the ' *' dirty marker, keep *.css, sort, join
// with '\n'. The marker strip matters: without it a MODIFIED stylesheet
// (e.g. the one under test) is silently dropped and every contrast
// assertion passes vacuously against the page defaults.
async function allCss() {
    if (_cssText != null) return _cssText;
    var ls = await executeTool('workspace', { action: 'ls', path: 'src/css' });
    var names = (ls.entries || ls.files || []).map(function (e) {
        return String(typeof e === 'string' ? e : (e.path || e.name)).split(' ')[0].replace(/^.*\//, '');
    }).filter(function (f) { return /\.css$/.test(f); }).map(function (f) { return 'src/css/' + f; }).sort();
    ['00-tokens.css', '01-dark-theme.css', '24-sub-agents.css'].forEach(function (f) {
        if (names.indexOf('src/css/' + f) < 0) throw new Error('CSS bundle is missing src/css/' + f + ' (' + names.length + ' files listed)');
    });
    var parts = [];
    for (var i = 0; i < names.length; i++) parts.push(await loadFile(names[i]));
    _cssText = parts.join('\n');
    return _cssText;
}

// Pre-fix declarations, verbatim from 24-sub-agents.css @64271a5 (only
// !important added so they beat the fix, incl. its higher-specificity dark
// override). Used by the canary test only.
var PRE_FIX_CSS = [
    '.sub-notice-err-preview { color: var(--text, #24292f) !important; }',
    '.sub-notice-collapse-full { background: var(--bg, #fff) !important; }',
    '.sub-notice-final.sub-report-done .sub-notice-badge { background: var(--success, #2da44e) !important; color: #fff !important; }',
    '.sub-notice-final.sub-report-error .sub-notice-badge { background: var(--danger, #cf222e) !important; color: #fff !important; }',
    '.sub-notice-final.sub-report-need_input .sub-notice-badge { background: var(--warning, #bf8700) !important; color: #fff !important; }',
    '.sub-notice-final.sub-report-partial .sub-notice-badge { background: var(--text-muted, #8a93a6) !important; color: #fff !important; }'
].join('\n');

var STATUSES = ['done', 'error', 'need_input', 'partial'];

function card(m, status, summary) {
    return '<div class="messages"><div class="message user sub-notice-msg" id="msg-0"><div class="message-content">' +
        m._subNoticeCardHtml('Déroulement: Chat UI', 'sub_x', status, summary, 'final', {}) + '</div></div></div>';
}

// Mounted in the sandbox's own document (a child iframe's document is not
// reachable from the opaque-origin sandbox); the root theme attribute and
// the injected sheets are restored/removed in done().
async function mount(theme, html, extraCss) {
    var root = document.documentElement, prevTheme = root.getAttribute('data-theme');
    if (theme === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    var sheets = [await allCss()].concat(extraCss ? [extraCss] : []).map(function (css) {
        var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); return st;
    });
    var box = document.createElement('div'); box.innerHTML = html; document.body.appendChild(box);
    return { d: box, w: window, done: function () {
        box.remove(); sheets.forEach(function (st) { st.remove(); });
        if (prevTheme == null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prevTheme);
    } };
}

function rgba(s) {
    var p = String(s).match(/[\d.]+/g) || [0, 0, 0, 0];
    return [+p[0], +p[1], +p[2], p.length > 3 ? +p[3] : 1];
}
function lum(c) {
    var a = c.slice(0, 3).map(function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
// Effective background: composite translucent ancestor backgrounds over
// the first opaque one (the page canvas when none is opaque).
function effBg(w, el) {
    var layers = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
        var c = rgba(w.getComputedStyle(n).backgroundColor);
        if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    var base = (layers.length && layers[layers.length - 1][3] >= 1) ? layers.pop() : [255, 255, 255, 1];
    for (var i = layers.length - 1; i >= 0; i--) {
        var l = layers[i];
        base = [0, 1, 2].map(function (k) { return l[k] * l[3] + base[k] * (1 - l[3]); }).concat([1]);
    }
    return base;
}
function contrast(w, el) {
    var fg = rgba(w.getComputedStyle(el).color), bg = effBg(w, el);
    var a = lum(fg), b = lum(bg);
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
}

async function mod() {
    return loadModules(['src/js/ui/175-sub-agent-ui.js'], { lenient: true, globals: {
        escapeHtml: function (v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); },
        formatContent: function (s) { return '<p>' + String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>'; }
    } });
}

var LONG_ERR = '## Chat UI déroulement: partial, stopped at the context limit\n\n' +
    'I hit the context limit before the executable phase finished. I never ran the gate, so no ledger ' +
    'was produced. The findings below come from direct reads and greps of the workspace; please hand the ' +
    'rest to a fresh sub-agent with the plan in the notes doc.';

// One long error card (collapsed preview + expanded body) and one short
// final card per status; returns every measured contrast plus the raw box /
// pill backgrounds (the "is the stylesheet under test applied" evidence).
async function measure(theme, extraCss) {
    var m = await mod();
    var t = await mount(theme, card(m, 'error', LONG_ERR) + STATUSES.map(function (s) { return card(m, s, 'Short ' + s + ' body text.'); }).join(''), extraCss);
    try {
        var r = { pills: {}, pillBg: {}, bodies: [] };
        var prev = t.d.querySelector('.sub-notice-err-preview');
        assert.ok(prev, 'long error renders the collapsed preview');
        r.preview = contrast(t.w, prev);
        t.d.querySelector('details.sub-notice-collapse').open = true;
        var full = t.d.querySelector('.sub-notice-collapse-full');
        r.boxBg = rgba(t.w.getComputedStyle(full).backgroundColor);
        r.body = contrast(t.w, full.querySelector('p') || full);
        var finals = t.d.querySelectorAll('.messages ~ .messages .sub-notice-final'); // skips the long-error card
        assert.strictEqual(finals.length, STATUSES.length, 'one final card per status');
        Array.prototype.forEach.call(finals, function (f, i) {
            var b = f.querySelector('.sub-notice-badge');
            r.pills[STATUSES[i]] = contrast(t.w, b);
            r.pillBg[STATUSES[i]] = rgba(t.w.getComputedStyle(b).backgroundColor);
            var p = f.querySelector('.sub-notice-body p');
            if (p) r.bodies.push(contrast(t.w, p));
        });
        return r;
    } finally { t.done(); }
}

describe('sub-agent notice card: theme contrast (dark + light)', function () {
    ['dark', 'light'].forEach(function (theme) {
        test(theme + ': collapsed error preview and expanded error body are readable', async function () {
            var r = await measure(theme);
            // The stylesheet under test really applies: the box paints its own opaque surface.
            assert.strictEqual(r.boxBg[3], 1, theme + ' expanded box has no opaque background (24-sub-agents.css not applied?)');
            assert.ok(r.preview >= 4.5, theme + ' preview contrast ' + r.preview + ' < 4.5');
            assert.ok(r.body >= 4.5, theme + ' expanded body contrast ' + r.body + ' < 4.5');
            if (theme === 'dark') assert.ok(lum(r.boxBg) < 0.2, 'dark expanded box must not be a light surface: ' + r.boxBg.join(','));
        }, { tags: ['unit'], timeout: 15000 });

        test(theme + ': final-report pills and bodies (done / error / need_input / partial) are readable', async function () {
            var r = await measure(theme);
            STATUSES.forEach(function (s) {
                assert.ok(r.pillBg[s][3] > 0, theme + ' "' + s + '" pill is not filled (24-sub-agents.css not applied?)');
                assert.ok(r.pills[s] >= 4.5, theme + ' pill "' + s + '" contrast ' + r.pills[s] + ' < 4.5');
            });
            assert.strictEqual(r.bodies.length, STATUSES.length);
            r.bodies.forEach(function (c, i) { assert.ok(c >= 4.5, theme + ' body "' + STATUSES[i] + '" contrast ' + c + ' < 4.5'); });
        }, { tags: ['unit'], timeout: 15000 });
    });

    // Non-vacuity canary: the same pipeline must flag the ORIGINAL bug.
    // Before the fix: dark preview 1.19, dark body 1.24 on a white box, dark
    // pills error 2.77 / done 1.92 / need_input 1.67, light pills done 3.77 /
    // need_input 3.19 / partial 2.54.
    test('canary: the pre-fix declarations are measured as failing', async function () {
        var dark = await measure('dark', PRE_FIX_CSS), light = await measure('light', PRE_FIX_CSS);
        assert.ok(dark.preview < 4.5, 'dark pre-fix preview should fail, got ' + dark.preview);
        assert.ok(dark.body < 4.5, 'dark pre-fix expanded body should fail, got ' + dark.body);
        assert.ok(lum(dark.boxBg) > 0.8, 'dark pre-fix expanded box should be white, got ' + dark.boxBg.join(','));
        ['done', 'error', 'need_input'].forEach(function (s) {
            assert.ok(dark.pills[s] < 4.5, 'dark pre-fix "' + s + '" pill should fail, got ' + dark.pills[s]);
        });
        ['done', 'need_input', 'partial'].forEach(function (s) {
            assert.ok(light.pills[s] < 4.5, 'light pre-fix "' + s + '" pill should fail, got ' + light.pills[s]);
        });
    }, { tags: ['unit'], timeout: 20000 });

    test('24-sub-agents.css references only defined custom properties', async function () {
        var css = await allCss();
        var defs = {}, re = /(--[A-Za-z0-9_-]+)\s*:/g, mm;
        while ((mm = re.exec(css))) defs[mm[1]] = 1;
        defs['--depth'] = 1; // set inline via style="--depth:N" by the tree renderer
        // Comments blanked (keeping newlines) so line numbers stay real.
        var own = (await loadFile('src/css/24-sub-agents.css')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); }), missing = [];
        own.split('\n').forEach(function (line, i) {
            var r = /var\(\s*(--[A-Za-z0-9_-]+)/g, x;
            while ((x = r.exec(line))) if (!defs[x[1]]) missing.push((i + 1) + ':' + x[1]);
        });
        assert.deepStrictEqual(missing, []);
    }, { tags: ['unit'], timeout: 10000 });
});
