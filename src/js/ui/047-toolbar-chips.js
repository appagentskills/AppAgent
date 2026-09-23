// ─────────────────────────────────────────────────────────────
// Tinted Icon Chips — page-toolbar action buttons (css/19e-toolbar-chips.css)
// ─────────────────────────────────────────────────────────────
// Every action button in a page toolbar (Dashboard, Skills, Documents, History,
// Settings, Help — anything inside `.page-toolbar`) gets `.tb-chip-btn`, and its
// existing `.action-icon` span becomes a 24×24 `.tb-chip` tinted per action.
// The tint follows the same keyword map core/120-init.js uses to pick the icon,
// so an action keeps one colour on every page. Segmented toggles
// (Rows/Gallery, Dashboard/All widgets) and search inputs are never touched —
// only `.skills-action-btn` buttons are.

var TB_CHIP_TINTS = ['violet', 'green', 'amber', 'sky', 'rose'];

// Pick the tint for a toolbar action from its label. Primary buttons get the
// white-on-blue chip (no tint modifier). Returns '' for "primary/neutral".
function tbChipTintFor(label, isPrimary) {
    if (isPrimary) return '';
    var t = String(label || '');
    if (t.indexOf('Import') !== -1) return 'green';
    if (t.indexOf('Export') !== -1 || t.indexOf('Download') !== -1) return 'amber';
    if (t.indexOf('Standalone') !== -1 || t.indexOf('Open') !== -1) return 'violet';
    if (t.indexOf('Delete') !== -1 || t.indexOf('Revert') !== -1) return 'rose';
    return 'sky'; // More, Refresh, and any other secondary action
}

// Tag every toolbar action button under `root` (default: document). Idempotent.
function applyToolbarChips(root) {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return 0;
    var count = 0;
    var btns = root.querySelectorAll('.page-toolbar .skills-action-btn');
    for (var i = 0; i < btns.length; i++) {
        var btn = btns[i];
        var icon = null;
        var kids = btn.children || [];
        for (var k = 0; k < kids.length; k++) {
            if (kids[k].classList && kids[k].classList.contains('action-icon')) { icon = kids[k]; break; }
        }
        if (!icon) continue;
        var isPrimary = btn.classList.contains('primary');
        var tint = tbChipTintFor(btn.textContent, isPrimary);
        btn.classList.add('tb-chip-btn');
        icon.classList.add('tb-chip');
        for (var j = 0; j < TB_CHIP_TINTS.length; j++) icon.classList.remove('tb-chip-' + TB_CHIP_TINTS[j]);
        if (tint) icon.classList.add('tb-chip-' + tint);
        icon.setAttribute('aria-hidden', 'true');
        count++;
    }
    return count;
}
