// Skills page "All / Built-in / Edited" filter (segmented toggle in the page
// toolbar, next to search). Rendered + applied by renderSkillsList
// (core/120-init.js); the choice persists in appStorage like the Rows/Gallery
// layout (ui/045-page-layout.js).
//
// Classification reuses the same flags as the list badges:
//  - Built-in: seeded from the bundled EMBEDDED_SKILLS, so it carries an
//    embeddedHash (core/130-indexeddb.js seeding). Includes edited built-ins,
//    matching the "Built-in" badge they still show.
//  - Edited: a built-in whose userModified flag is set (every editor / agent
//    write path flips it, e.g. core/140-skills-engine.js, ui/010-skills-ui.js).
//  - User-created (custom) skills have no embeddedHash: they only show under All.
var SKILLS_PAGE_FILTER_KEY = 'skillsPageFilter'; // 'all' | 'builtin' | 'edited'
var SKILLS_FILTERS = ['all', 'builtin', 'edited'];

function skillIsBuiltIn(s) { return !!(s && s.embeddedHash); }
function skillIsEdited(s) { return skillIsBuiltIn(s) && !!s.userModified; }

function normalizeSkillsFilter(f) { return SKILLS_FILTERS.indexOf(f) !== -1 ? f : 'all'; }

function skillMatchesFilter(s, filter) {
    filter = normalizeSkillsFilter(filter);
    if (filter === 'builtin') return skillIsBuiltIn(s);
    if (filter === 'edited') return skillIsEdited(s);
    return true;
}

// Counts per filter for a list of skills (already search-filtered by the caller).
function skillFilterCounts(list) {
    var c = { all: 0, builtin: 0, edited: 0 };
    (list || []).forEach(function(s) {
        c.all++;
        if (skillIsBuiltIn(s)) c.builtin++;
        if (skillIsEdited(s)) c.edited++;
    });
    return c;
}

function skillsFilterGet() {
    try { return normalizeSkillsFilter(appStorage.getItem(SKILLS_PAGE_FILTER_KEY)); } catch (e) { return 'all'; }
}

function skillsSetFilter(filter) {
    try { appStorage.setItem(SKILLS_PAGE_FILTER_KEY, normalizeSkillsFilter(filter)); } catch (e) {}
    if (typeof renderSkillsList === 'function') renderSkillsList();
}

function skillsFilterLabel(filter) {
    if (filter === 'builtin') return t('Built-in');
    if (filter === 'edited') return t('Edited');
    return t('All');
}

// Static markup; labels/counts/active state are filled by skillsFilterSync on every render
// (so a language switch, which re-renders the list, relabels it too).
function skillsFilterToggleHtml() {
    return '<div class="segmented-toggle skills-filter-toggle" role="group" aria-label="' + escapeHtml(t('Filter')) + '">' +
        SKILLS_FILTERS.map(function(f) {
            return '<button type="button" class="skills-filter-btn" data-filter="' + f + '" aria-pressed="false" onclick="skillsSetFilter(\'' + f + '\')">' +
                '<span class="skills-filter-label">' + escapeHtml(skillsFilterLabel(f)) + '</span>' +
                '<span class="skills-filter-count"></span></button>';
        }).join('') +
    '</div>';
}

function skillsFilterSync(root, filter, counts) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    filter = normalizeSkillsFilter(filter);
    var group = root.querySelector('.skills-filter-toggle');
    if (group) group.setAttribute('aria-label', t('Filter'));
    var btns = root.querySelectorAll('.skills-filter-btn');
    Array.prototype.forEach.call(btns, function(btn) {
        var f = btn.getAttribute('data-filter');
        var on = f === filter;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        var label = btn.querySelector('.skills-filter-label');
        if (label) label.textContent = skillsFilterLabel(f);
        var count = btn.querySelector('.skills-filter-count');
        if (count) count.textContent = counts && typeof counts[f] === 'number' ? String(counts[f]) : '';
    });
    return btns.length;
}
