// RB-01 — the committed write-site ratchet baseline must match the real
// source tree. Both builds (build/build.js runWriteSiteRatchet and the
// in-browser Reload replica skills/extension-dev/build.js) ABORT when any
// per-file count rises above build/write-site-ratchet.json, so a write site
// that lands without a baseline bump breaks the next Reload build. These
// tests run the real guard functions from skills/extension-dev/build.js over
// the real scan scope (listRatchetScanFiles: src/js/**/*.js plus
// src/platform/extension/*.js) and require zero violations. Decreases are
// warn-only (ratchet_tighten) in both builds and are deliberately not asserted.
var _ratchetScan = null;
function ratchetScanFileMap() {
    if (_ratchetScan) return _ratchetScan;
    _ratchetScan = (async function() {
        var files = [];
        async function walk(dir, recurse) {
            var ls = await executeTool('workspace', { action: 'ls', path: dir });
            if (!ls || !ls.success || !Array.isArray(ls.entries)) throw new Error('workspace ls failed for ' + dir);
            for (var i = 0; i < ls.entries.length; i++) {
                var name = String(ls.entries[i]).split(' ')[0];
                if (name.slice(-1) === '/') {
                    if (recurse) await walk(dir + '/' + name.slice(0, -1), true);
                } else if (/\.js$/.test(name)) {
                    files.push(dir + '/' + name);
                }
            }
        }
        await walk('src/js', true);
        await walk('src/platform/extension', false);
        files.sort();
        var contents = await Promise.all(files.map(function(f) { return loadFile(f); }));
        var map = {};
        files.forEach(function(f, i) { map[f] = contents[i]; });
        return map;
    })();
    return _ratchetScan;
}

function describeRatchetRows(rows) {
    return rows.map(function(v) { return v.pattern + ' ' + v.file + ' ' + v.baseline + '->' + v.current; });
}

describe('write-site ratchet baseline vs real source (RB-01)', function() {
    test('committed baseline has zero violations over the real scan scope', async function() {
        var m = await runFile('skills/extension-dev/build.js');
        var fileMap = await ratchetScanFileMap();
        var files = Object.keys(fileMap);
        assert.ok(files.length >= 50, 'scan scope too small: ' + files.length);
        assert.ok(files.indexOf('src/js/ui/130-data-management.js') >= 0, 'page tiers scanned');
        assert.ok(files.indexOf('src/js/worker/190-entry.js') >= 0, 'worker tier scanned');
        assert.ok(files.indexOf('src/platform/extension/background.js') >= 0, 'platform files scanned');
        files.forEach(function(f) { assert.strictEqual(typeof fileMap[f], 'string', 'loaded ' + f); });
        var baseline = JSON.parse(await loadFile('build/write-site-ratchet.json'));
        var r = m.compareWriteSiteRatchet(baseline.patterns || {}, m.computeWriteSiteRatchetCounts(fileMap));
        assert.deepStrictEqual(describeRatchetRows(r.violations), []);
    }, { tags: ['unit'], timeout: 20000 });

    test('guard is live: dropping a recorded storage.local.set entry is reported', async function() {
        var m = await runFile('skills/extension-dev/build.js');
        var fileMap = await ratchetScanFileMap();
        var counts = m.computeWriteSiteRatchetCounts(fileMap);
        var patterns = JSON.parse(await loadFile('build/write-site-ratchet.json')).patterns;
        var dm = 'src/js/ui/130-data-management.js';
        assert.ok((counts.storageLocalSet || {})[dm] > 0, dm + ' has a chrome.storage.local.set site');
        delete patterns.storageLocalSet[dm];
        var r = m.compareWriteSiteRatchet(patterns, counts);
        assert.deepStrictEqual(describeRatchetRows(r.violations), ['storageLocalSet ' + dm + ' 0->' + counts.storageLocalSet[dm]]);
    }, { tags: ['unit'], timeout: 20000 });
});
