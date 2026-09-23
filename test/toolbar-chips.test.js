// Tinted Icon Chips (ui/047-toolbar-chips.js + css/19e-toolbar-chips.css):
// every page-toolbar action button gets .tb-chip-btn, its .action-icon becomes a
// tinted .tb-chip, and segmented toggles / non-toolbar buttons are left alone.

function fakeEl(tag, classes, text, children) {
    var set = {};
    (classes || []).forEach(function(c) { set[c] = true; });
    var el = {
        tagName: tag, children: children || [], attrs: {}, _text: text || '',
        classList: {
            add: function(c) { set[c] = true; },
            remove: function(c) { delete set[c]; },
            contains: function(c) { return !!set[c]; },
            list: function() { return Object.keys(set).sort(); }
        },
        setAttribute: function(k, v) { this.attrs[k] = v; }
    };
    Object.defineProperty(el, 'textContent', { get: function() {
        return this._text + this.children.map(function(ch) { return ch.textContent; }).join('');
    } });
    return el;
}
function btn(label, extra) {
    var icon = fakeEl('span', ['action-icon'], '');
    return { btn: fakeEl('button', ['skills-action-btn'].concat(extra || []), label, [icon]), icon: icon };
}

describe('Tinted Icon Chips', function() {
    test('tint map keeps one colour per action across pages', async function() {
        var m = await loadModules(['src/js/ui/047-toolbar-chips.js']);
        var t = m.tbChipTintFor;
        assert.strictEqual(t('Open Standalone', false), 'violet');
        assert.strictEqual(t('Import', false), 'green');
        assert.strictEqual(t('Import▾', false), 'green');
        assert.strictEqual(t('Import Data', false), 'green');
        assert.strictEqual(t('Export', false), 'amber');
        assert.strictEqual(t('Export Data', false), 'amber');
        assert.strictEqual(t('Download All', false), 'amber');
        assert.strictEqual(t('Download', false), 'amber');
        assert.strictEqual(t('More', false), 'sky');
        assert.strictEqual(t('Add Widget', true), '');
        assert.strictEqual(t('New Document', true), '');
    }, { tags: ['unit'], timeout: 2000 });

    test('applyToolbarChips tags only .page-toolbar action buttons, idempotently', async function() {
        var m = await loadModules(['src/js/ui/047-toolbar-chips.js']);
        var imp = btn('Import'), exp = btn('Export'), add = btn('Add Widget', ['primary']), more = btn('More');
        var root = { querySelectorAll: function(sel) {
            assert.strictEqual(sel, '.page-toolbar .skills-action-btn');
            return [imp.btn, exp.btn, add.btn, more.btn];
        } };
        assert.strictEqual(m.applyToolbarChips(root), 4);
        assert.strictEqual(m.applyToolbarChips(root), 4);
        assert.ok(imp.btn.classList.contains('tb-chip-btn'));
        assert.deepStrictEqual(imp.icon.classList.list(), ['action-icon', 'tb-chip', 'tb-chip-green']);
        assert.deepStrictEqual(exp.icon.classList.list(), ['action-icon', 'tb-chip', 'tb-chip-amber']);
        assert.deepStrictEqual(add.icon.classList.list(), ['action-icon', 'tb-chip']);
        assert.deepStrictEqual(more.icon.classList.list(), ['action-icon', 'tb-chip', 'tb-chip-sky']);
        assert.strictEqual(imp.icon.attrs['aria-hidden'], 'true');
    }, { tags: ['unit'], timeout: 2000 });

    test('init wires the tagger and the CSS defines spec values without touching toggles', async function() {
        var init = await loadFile('src/js/core/120-init.js');
        assert.match(init, /applyToolbarChips\(document\)/);
        var css = await loadFile('src/css/19e-toolbar-chips.css');
        // one control height shared by chip buttons, segmented toggles and search (= header pills)
        assert.match(css, /--toolbar-control-h: 26px/);
        assert.match(css, /\.skills-action-btn\.tb-chip-btn \{[^}]*height: var\(--toolbar-control-h\)[^}]*font-size: var\(--text-body-sm\)/);
        assert.match(css, /\.page-toolbar \.segmented-toggle \{[^}]*height: var\(--toolbar-control-h\)/);
        assert.match(css, /\.page-toolbar \.segmented-toggle button \{[^}]*height: 100%/);
        assert.match(css, /\.page-toolbar \.history-search-lg \{[^}]*height: var\(--toolbar-control-h\)/);
        // icons carry no background box and add no extra width; symmetric button padding
        assert.match(css, /\.action-icon\.tb-chip \{[^}]*width: auto[^}]*background: none/);
        assert.match(css, /\.skills-action-btn\.tb-chip-btn \{[^}]*padding: 0 var\(--space-5\);/);
        assert.match(css, /\.tb-chip \.ui-icon[^{]*\{ width: 12px; height: 12px; \}/);
        assert.ok(!/rgba\(|color-mix/.test(css), 'no tinted chip backgrounds left');
        assert.match(css, /data-theme="dark"\] \.skills-action-btn\.tb-chip-btn \{ background: #1c1f23; border-color: #2a2e34; color: #dde1e6;/);
        // primary = tinted pill from theme tokens (like .storage-display), no saturated solid blue
        assert.match(css, /tb-chip-btn\.primary \{ background: var\(--primary-lighter\); border-color: var\(--primary-light\); color: var\(--primary\);/);
        assert.ok(!/#3b6cf6|#4f7cff/i.test(css));
        // toggles: height/padding only, no colour overrides
        var toggleRules = css.match(/\.page-toolbar \.segmented-toggle[^{]*\{[^}]*\}/g) || [];
        assert.strictEqual(toggleRules.length, 2);
        toggleRules.forEach(function(r) { assert.ok(!/background|color:/.test(r), r); });
        // icon tint colours kept (dark spec + light)
        assert.match(css, /dark"\] \.tb-chip\.tb-chip-violet \{ color: #b9a4ff; \}/);
        assert.match(css, /dark"\] \.tb-chip\.tb-chip-green  \{ color: #5fe0ae; \}/);
        assert.match(css, /dark"\] \.tb-chip\.tb-chip-amber  \{ color: #fbcd5a; \}/);
        assert.match(css, /\n\.tb-chip\.tb-chip-violet \{ color: #6d28d9; \}/);
        // neutral colour is a low-specificity rule so light-theme tints are not overridden
        assert.match(css, /\n\.tb-chip \{ color: var\(--text-secondary\); \}/);
        assert.ok(!/\n\.skills-action-btn \.action-icon\.tb-chip \{[^}]*color:/.test(css));
        assert.ok(!/dashboard-mode-btn/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
    }, { tags: ['unit'], timeout: 2000 });
});
