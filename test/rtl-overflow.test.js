// RTL horizontal overflow regression.
// Bug: with Arabic selected (<html dir="rtl">) the whole UI got a ~10000px
// horizontal scrollbar. Cause: the skip link in src/html/body.html is parked
// off-canvas with an inline `left:-9999px`; in RTL the root scroller's
// scrollable overflow extends to the LEFT, so that box became scrollable.
// Fix: src/css/19-dashboard.css `.skip-link:not(:focus)` hides it in place
// (left:auto !important + clip-path) instead; src/css/26-rtl.css section 5 adds
// a secondary root overflow-x:clip guard.
// Run: run_tests { files: ['test/rtl-overflow.test.js'] }
var WS = args.workspace;

function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' '); }
function ruleBody(css, selector) {
    css = stripComments(css);
    var esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var m = new RegExp('(^|[}\\s,])' + esc + '\\s*\\{([^{}]*)\\}').exec(css);
    return m ? m[2] : null;
}
async function skipLinkMarkup() {
    var body = await loadFile('src/html/body.html', WS);
    var m = /<a\b[^>]*class="skip-link"[^>]*>[\s\S]*?<\/a>/.exec(body);
    assert.ok(m, 'body.html has the .skip-link anchor');
    return m[0];
}
// Cascades the real skip-link markup (with its inline style) against `css` in an
// RTL subtree and returns the computed offset/clip. The test sandbox has no
// layout viewport (innerWidth 0), so scrollWidth can't be measured here; the
// cascade is what decides whether the box is parked 9999px off-canvas.
function computed(markup, css) {
    var host = document.createElement('div');
    host.setAttribute('dir', 'rtl');
    var style = document.createElement('style');
    style.textContent = css || '';
    var inner = document.createElement('div');
    inner.innerHTML = markup;
    host.appendChild(style);
    host.appendChild(inner);
    document.body.appendChild(host);
    try {
        var cs = getComputedStyle(inner.querySelector('.skip-link'));
        return { left: cs.left, clip: cs.clipPath, position: cs.position };
    } finally { host.parentNode.removeChild(host); }
}

describe('RTL: no horizontal overflow from the off-canvas skip link', function() {
    it('19-dashboard.css hides the unfocused skip link in place, overriding the inline left', async function() {
        var css = await loadFile('src/css/19-dashboard.css', WS);
        var body = ruleBody(css, '.skip-link:not(:focus)');
        assert.ok(body, '.skip-link:not(:focus) rule exists');
        assert.ok(/(^|;)\s*left\s*:\s*auto\s*!important/.test(body), 'left:auto !important beats the inline left:-9999px: ' + body);
        assert.ok(/clip-path\s*:\s*inset\(50%\)/.test(body), 'clipped in place: ' + body);
        assert.ok(ruleBody(css, '.skip-link:focus'), 'focused skip link rule still present');
    });

    it('cascade: the rule beats the real inline left:-9999px from body.html', async function() {
        var markup = await skipLinkMarkup();
        var css = await loadFile('src/css/19-dashboard.css', WS);
        var fixCss = '.skip-link:not(:focus) {' + ruleBody(css, '.skip-link:not(:focus)') + '}';
        var before = computed(markup, '');
        assert.strictEqual(before.left, '-9999px', 'control: without the rule the inline off-canvas offset applies');
        var after = computed(markup, fixCss);
        assert.strictEqual(after.left, 'auto', 'fixed: left resolves to auto (static position, no off-canvas box)');
        assert.strictEqual(after.clip, 'inset(50%)', 'fixed: visually hidden by clipping');
        assert.strictEqual(after.position, 'absolute', 'still out of flow');
    });

    it('26-rtl.css adds the secondary root overflow-x guard for RTL only', async function() {
        var css = await loadFile('src/css/26-rtl.css', WS);
        var body = ruleBody(css, '[dir="rtl"]:root');
        assert.ok(body && /overflow-x\s*:\s*clip/.test(body), '[dir="rtl"]:root { overflow-x: clip }');
    });

    it('no stylesheet parks elements off-canvas with a large physical negative left/right', async function() {
        var ls = await executeTool('workspace', { action: 'ls', path: 'src/css' });
        var names = (ls.entries || ls.files || []).map(function(e) {
            return String(typeof e === 'string' ? e : (e.path || e.name)).split(' ')[0].replace(/^.*\//, '');
        }).filter(function(f) { return /\.css$/.test(f); });
        assert.ok(names.length > 10, 'listed src/css (' + names.length + ')');
        for (var i = 0; i < names.length; i++) {
            var src = stripComments(await loadFile('src/css/' + names[i], WS));
            var m = /(?:^|[;{\s])(left|right)\s*:\s*-\d{3,}px/.exec(src);
            assert.ok(!m, names[i] + ' uses ' + (m && m[0].trim()) + ' — off-canvas physical offsets scroll in RTL; clip/visibility instead');
        }
    });
});
