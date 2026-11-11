// Regression: an EXPANDED sub-agent worker card (_workerCardHtml,
// src/js/ui/175-sub-agent-ui.js) is a header (.worker-card) plus a sibling
// progress panel (.worker-card-progress). The state border colour (green
// running / red errored / dashed queued) was only on the header, so the
// expanded body + "Open chat"/"View more" footer sat inside a plain grey
// border — the card did not read as one bordered container.
// Mounts real markup + the full stylesheet bundle (same recipe as
// sub-notice-dark-contrast.test.js) and asserts the panel's side/bottom
// borders match the header's border in every state and both themes.

var _cssText = null;
async function allCss() {
    if (_cssText != null) return _cssText;
    var ls = await executeTool('workspace', { action: 'ls', path: 'src/css' });
    var names = (ls.entries || ls.files || []).map(function (e) {
        return String(typeof e === 'string' ? e : (e.path || e.name)).split(' ')[0].replace(/^.*\//, '');
    }).filter(function (f) { return /\.css$/.test(f); }).map(function (f) { return 'src/css/' + f; }).sort();
    if (names.indexOf('src/css/24-sub-agents.css') < 0) throw new Error('CSS bundle is missing 24-sub-agents.css');
    var parts = [];
    for (var i = 0; i < names.length; i++) parts.push(await loadFile(names[i]));
    _cssText = parts.join('\n');
    return _cssText;
}

function cardHtml(state, depth) {
    return '<div class="worker-card-wrap" data-depth="' + (depth || 1) + '">' +
        '<button class="worker-card worker-' + state + ' worker-card-expanded"><span class="worker-card-main">x</span></button>' +
        '<div class="worker-card-progress">body</div></div>';
}

async function measure(theme, state, depth) {
    var root = document.documentElement, prev = root.getAttribute('data-theme');
    if (theme === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    var st = document.createElement('style'); st.textContent = await allCss(); document.head.appendChild(st);
    var box = document.createElement('div'); box.innerHTML = cardHtml(state, depth); document.body.appendChild(box);
    try {
        var c = getComputedStyle(box.querySelector('.worker-card'));
        var p = getComputedStyle(box.querySelector('.worker-card-progress'));
        return {
            card: c.borderLeftColor, cardStyle: c.borderLeftStyle,
            left: p.borderLeftColor, right: p.borderRightColor, bottom: p.borderBottomColor,
            style: p.borderLeftStyle, top: p.borderTopStyle
        };
    } finally {
        box.remove(); st.remove();
        if (prev == null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prev);
    }
}

describe('worker card: state border wraps the expanded body', function () {
    ['light', 'dark'].forEach(function (theme) {
        ['running', 'errored', 'queued', 'stopped', 'sleeping'].forEach(function (state) {
            test(theme + ' ' + state + ': panel border matches header border', async function () {
                var r = await measure(theme, state, 1);
                assert.strictEqual(r.left, r.card, 'left border colour');
                assert.strictEqual(r.right, r.card, 'right border colour');
                assert.strictEqual(r.bottom, r.card, 'bottom border colour');
                assert.strictEqual(r.style, r.cardStyle, 'border style (dashed for queued)');
                assert.strictEqual(r.top, 'none', 'no seam between header and panel');
            });
        });
        test(theme + ' nested running (depth 2): panel matches header', async function () {
            var r = await measure(theme, 'running', 2);
            assert.strictEqual(r.left, r.card);
        });
    });
    test('sub_report header: "Open chat" stays inside the card at narrow widths', async function () {
        var st = document.createElement('style'); st.textContent = await allCss(); document.head.appendChild(st);
        var box = document.createElement('div'); box.style.width = '240px';
        box.innerHTML = '<details open class="message sub-report sub-report-running"><summary class="sub-report-header">' +
            '<span class="sub-report-chevron"></span><span class="sub-report-icon">b</span>' +
            '<span class="sub-report-name">continue-followup-pr-with-a-very-long-name</span>' +
            '<span class="sub-report-status">working</span>' +
            '<span class="sub-report-model">Opus 5.5 (same)</span>' +
            '<span class="sub-report-preview">a long preview line that would never fit here</span>' +
            '<button type="button" class="sub-report-open"><span class="sub-report-open-label">Open chat</span></button>' +
            '</summary><div class="sub-report-body">b</div></details>';
        document.body.appendChild(box);
        // The test sandbox has no layout (getBoundingClientRect is all zeros),
        // so assert the computed flex contract that keeps the row in bounds.
        try {
            var cs = function (sel) { return getComputedStyle(box.querySelector(sel)); };
            assert.strictEqual(cs('summary').display, 'flex');
            assert.strictEqual(cs('summary').flexWrap, 'wrap', 'header wraps instead of overflowing');
            assert.strictEqual(cs('.sub-report-open').flexShrink, '0', 'button never squeezed');
            assert.strictEqual(cs('.sub-report-open').whiteSpace, 'nowrap', 'button label never broken');
            assert.strictEqual(cs('.sub-report-name').minWidth, '0px', 'name may shrink');
            assert.strictEqual(cs('.sub-report-name').overflowWrap, 'anywhere', 'long names break instead of overflowing');
            assert.strictEqual(cs('.sub-report-preview').flexBasis, '0px', 'preview never forces a wrap of its own');
            assert.strictEqual(cs('.sub-report-preview').minWidth, '0px');
        } finally { box.remove(); st.remove(); }
    });
    test('canary: running header border differs from the neutral border', async function () {
        var run = await measure('light', 'running', 1), stop = await measure('light', 'stopped', 1);
        assert.notStrictEqual(run.card, stop.card, 'running header is state-coloured, so the match above is non-vacuous');
    });
});
