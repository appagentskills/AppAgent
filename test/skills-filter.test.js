'use strict';
// Skills page All / Built-in / Edited filter (src/js/ui/012-skills-filter.js).
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function memStorage(init) {
    var d = Object.assign({}, init || {});
    return { getItem: function(k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; }, setItem: function(k, v) { d[k] = String(v); }, _d: d };
}
async function load(extra) {
    var renders = [];
    var g = Object.assign({
        document: document,
        escapeHtml: esc,
        t: function(s) { return s; },
        appStorage: memStorage(),
        renderSkillsList: function() { renders.push(1); }
    }, extra || {});
    var m = await loadModules(['src/js/ui/012-skills-filter.js'], { globals: g });
    m._renders = renders; m._g = g;
    return m;
}
var CUSTOM = { id: 'mine', userModified: true };              // user-created: no embeddedHash
var BUILTIN = { id: 'oob', embeddedHash: 'h1' };                // shipped, untouched
var EDITED = { id: 'oob2', embeddedHash: 'h2', userModified: true };

describe('skills filter: classification', function() {
    test('built-in = embeddedHash; edited = built-in + userModified; custom only under All', async function() {
        var m = await load();
        assert.deepStrictEqual([CUSTOM, BUILTIN, EDITED].map(function(s) { return m.skillMatchesFilter(s, 'builtin'); }), [false, true, true]);
        assert.deepStrictEqual([CUSTOM, BUILTIN, EDITED].map(function(s) { return m.skillMatchesFilter(s, 'edited'); }), [false, false, true]);
        assert.deepStrictEqual([CUSTOM, BUILTIN, EDITED].map(function(s) { return m.skillMatchesFilter(s, 'all'); }), [true, true, true]);
        assert.strictEqual(m.skillMatchesFilter(CUSTOM, 'bogus'), true, 'unknown filter falls back to all');
        assert.strictEqual(m.skillIsEdited(null), false);
        assert.deepStrictEqual(m.skillFilterCounts([CUSTOM, BUILTIN, EDITED]), { all: 3, builtin: 2, edited: 1 });
        assert.deepStrictEqual(m.skillFilterCounts(null), { all: 0, builtin: 0, edited: 0 });
        assert.deepStrictEqual(m.__unstubbed, []);
    }, { tags: ['unit'], timeout: 2000 });

    test('filter persists in appStorage, normalizes bad values, and re-renders', async function() {
        var m = await load({ appStorage: memStorage({ skillsPageFilter: 'nope' }) });
        assert.strictEqual(m.skillsFilterGet(), 'all');
        m.skillsSetFilter('edited');
        assert.strictEqual(m._g.appStorage._d.skillsPageFilter, 'edited');
        assert.strictEqual(m.skillsFilterGet(), 'edited');
        assert.strictEqual(m._renders.length, 1);
        m.skillsSetFilter('<x>');
        assert.strictEqual(m.skillsFilterGet(), 'all');
    }, { tags: ['unit'], timeout: 2000 });
});

describe('skills filter: toggle markup', function() {
    test('sync marks the active button, aria-pressed and per-filter counts', async function() {
        var m = await load();
        var root = document.createElement('div');
        root.innerHTML = m.skillsFilterToggleHtml();
        var btns = root.querySelectorAll('.skills-filter-btn');
        assert.deepStrictEqual(Array.prototype.map.call(btns, function(b) { return b.dataset.filter; }), ['all', 'builtin', 'edited']);
        assert.strictEqual(m.skillsFilterSync(root, 'builtin', { all: 5, builtin: 3, edited: 1 }), 3);
        var active = root.querySelectorAll('.skills-filter-btn.active');
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0].dataset.filter, 'builtin');
        assert.strictEqual(active[0].getAttribute('aria-pressed'), 'true');
        assert.strictEqual(btns[0].getAttribute('aria-pressed'), 'false');
        assert.deepStrictEqual(Array.prototype.map.call(root.querySelectorAll('.skills-filter-count'), function(c) { return c.textContent; }), ['5', '3', '1']);
        assert.deepStrictEqual(Array.prototype.map.call(root.querySelectorAll('.skills-filter-label'), function(c) { return c.textContent; }), ['All', 'Built-in', 'Edited']);
        assert.ok(/skillsSetFilter\('edited'\)/.test(btns[2].getAttribute('onclick')));
        assert.strictEqual(m.skillsFilterSync(null, 'all'), 0);
    }, { tags: ['unit'], timeout: 2000 });
});

describe('skills filter: renderSkillsList wiring', function() {
    test('renderSkillsList applies skillMatchesFilter and syncs the toggle', async function() {
        var src = await loadFile('src/js/core/120-init.js');
        var start = src.indexOf('async function renderSkillsList(');
        var body = src.slice(start, src.indexOf('\nasync function openSkillEditor', start));
        assert.ok(start > 0);
        assert.match(body, /skillMatchesFilter\(s, filter\)/);
        assert.match(body, /skillsFilterSync\(slot, filter, skillFilterCounts\(queryMatches\)\)/);
        assert.match(body, /skillsFilterToggleHtml\(\)/);
    }, { tags: ['unit'], timeout: 2000 });
});
