// Documents page pure helpers (tools/110-smart-documents.js): group-by
// bucketing (sdocGroupItems), header-actions visibility, file search matching.
describe('documents page group-by helpers', function() {
    async function load() {
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var stored = {};
        var m = await U.loadUi(['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/110-smart-documents.js'], { globals: {
            chats: {}, currentChatId: 'c1', currentView: 'documents',
            escDisplay: function(s) { return String(s); }, escapeHtml: function(s) { return String(s); },
            appStorage: { getItem: function(k) { return stored[k] == null ? null : stored[k]; }, setItem: function(k, v) { stored[k] = v; } }
        } });
        return { m: m, stored: stored };
    }
    function names(g) { return g.items.map(function(i) { return i.name; }); }
    var NOW = new Date(2026, 9, 1, 15, 0, 0).getTime(); // Thu 1 Oct 2026
    var H = 3600000, D = 24 * H;
    var ITEMS = [
        { name: 'beta', date: NOW - H, folder: 'Pics' },
        { name: 'Alpha', date: NOW - D, folder: 'Code', git: { repo: 'o/r', changed: true } },
        { name: 'gamma', date: NOW - 10 * D, folder: 'Pics', git: { repo: 'o/r', changed: false } },
        { name: 'delta', date: 0, folder: '' }
    ];

    test('alpha and date give one flat group', async function() {
        var m = (await load()).m;
        var a = m.sdocGroupItems(ITEMS, 'alpha', NOW);
        assert.strictEqual(a.length, 1);
        assert.deepStrictEqual(names(a[0]), ['Alpha', 'beta', 'delta', 'gamma']);
        var d = m.sdocGroupItems(ITEMS, 'date', NOW);
        assert.deepStrictEqual(names(d[0]), ['beta', 'Alpha', 'gamma', 'delta'], 'newest first, undated last');
        assert.strictEqual(m.sdocGroupItems(ITEMS, 'bogus', NOW)[0].items[0].name, 'beta', 'unknown mode falls back to date');
    }, { tags: ['unit'], timeout: 5000 });

    test('day and week buckets, Undated last', async function() {
        var m = (await load()).m;
        var day = m.sdocGroupItems(ITEMS, 'day', NOW);
        assert.deepStrictEqual(day.map(function(g) { return g.label; }).slice(0, 2), ['Today', 'Yesterday']);
        assert.strictEqual(day[day.length - 1].label, 'Undated');
        assert.deepStrictEqual(names(day[day.length - 1]), ['delta']);
        var wk = m.sdocGroupItems(ITEMS, 'week', NOW);
        assert.strictEqual(wk[0].label, 'This Week');
        assert.deepStrictEqual(names(wk[0]), ['beta', 'Alpha']);
        assert.strictEqual(wk[wk.length - 1].key, 'undated');
        assert.strictEqual(new Date(m.sdocWeekStart(NOW)).getDay(), 1, 'weeks start on Monday');
    }, { tags: ['unit'], timeout: 5000 });

    test('folder and git groups', async function() {
        var m = (await load()).m;
        var f = m.sdocGroupItems(ITEMS, 'folder', NOW);
        assert.deepStrictEqual(f.map(function(g) { return g.label; }), ['Code', 'Pics', 'Smart Documents']);
        assert.deepStrictEqual(names(f[1]), ['beta', 'gamma']);
        var g = m.sdocGroupItems(ITEMS, 'git', NOW);
        assert.deepStrictEqual(g.map(function(x) { return x.label; }), ['o/r \u00B7 Changed', 'o/r \u00B7 Unchanged', 'Not in a repository']);
    }, { tags: ['unit'], timeout: 5000 });

    test('group-by persists, defaults to date and cycles', async function() {
        var e = await load();
        assert.strictEqual(e.m.sdocGetGroupBy(), 'date');
        e.stored.documentsPageGroupBy = 'week';
        assert.strictEqual(e.m.sdocGetGroupBy(), 'week');
        assert.strictEqual(e.m.sdocCycleGroupBy(), 'alpha', 'week wraps to alpha');
        assert.strictEqual(e.stored.documentsPageGroupBy, 'alpha');
    }, { tags: ['unit'], timeout: 5000 });

    test('header actions visibility and file search matching', async function() {
        var m = (await load()).m;
        assert.strictEqual(m.sdocHeaderActionsVisible('sdocs', true), true);
        assert.strictEqual(m.sdocHeaderActionsVisible('all', false), true);
        assert.strictEqual(m.sdocHeaderActionsVisible('all', true), false);
        assert.strictEqual(m.sdocHeaderActionsVisible('lf:lf_1', true), false);
        assert.strictEqual(m.sdocEntryMatches({ name: 'App.js', path: 'src/App.js' }, 'app'), true);
        assert.strictEqual(m.sdocEntryMatches({ name: 'App.js', path: 'src/App.js' }, 'src/'), true);
        assert.strictEqual(m.sdocEntryMatches({ name: 'App.js', path: 'src/App.js' }, 'zzz'), false);
    }, { tags: ['unit'], timeout: 5000 });

    test('unified list: docs + file rows, ws rows undated, grouped html', async function() {
        var m = (await load()).m;
        var lf = { id: 'lf:1', type: 'lf', label: 'Pics' }, ws = { id: 'ws:1', type: 'ws', label: 'o/r', wk: 'o/r::main' };
        var u = m.sdocUnifiedItems([{ id: 'd1', title: 'Doc', updatedAt: NOW - H }], [
            { src: lf, entry: { name: 'a.png', path: 'trip/a.png', kind: 'file', lastModified: NOW - 2 * D } },
            { src: ws, entry: { name: 'x.js', path: 'src/x.js', kind: 'file', dirty: true } }
        ]);
        assert.deepStrictEqual(u.map(function(i) { return i.kind + ':' + i.name + ':' + i.date; }), ['doc:Doc:' + (NOW - H), 'file:a.png:' + (NOW - 2 * D), 'file:x.js:0']);
        assert.strictEqual(u[1].idx, 0); assert.strictEqual(u[2].idx, 1);
        assert.strictEqual(u[1].folder, 'Pics / trip');
        assert.strictEqual(u[1].git, null);
        assert.deepStrictEqual(u[2].git, { repo: 'o/r', changed: true });
        var day = m.sdocGroupItems(u, 'day', NOW);
        assert.strictEqual(day[day.length - 1].key, 'undated', 'workspace row goes to Undated');
        assert.deepStrictEqual(day[day.length - 1].items.map(function(i) { return i.name; }), ['x.js']);
        var html = m.sdocGroupedHtml(day, function(it) { return '<i>' + it.name + '</i>'; });
        assert.strictEqual((html.match(/role="heading" aria-level="3"/g) || []).length, day.length);
        assert.ok(html.indexOf('sdoc-group-count">1<') !== -1, 'header shows a count');
        var flat = m.sdocGroupedHtml(m.sdocGroupItems(u, 'alpha', NOW), function(it) { return it.name; });
        assert.strictEqual(flat, 'a.pngDocx.js', 'alpha: no header');
    }, { tags: ['unit'], timeout: 5000 });

    test('per-source cap and git-mode workspace inclusion', async function() {
        var m = (await load()).m;
        var entries = [];
        for (var i = 0; i < 250; i++) entries.push({ name: 'f' + i + '.txt', path: (i % 2 ? 'odd/' : 'even/') + 'f' + i + '.txt' });
        var all = m.sdocCapEntries(entries, '', 200);
        assert.strictEqual(all.hits.length, 200); assert.strictEqual(all.more, 50);
        var odd = m.sdocCapEntries(entries, 'odd/', 200);
        assert.strictEqual(odd.hits.length, 125); assert.strictEqual(odd.more, 0, 'path match, under cap');
        assert.strictEqual(m.SDOC_SRC_HITS_MAX, 200);
        var srcs = [{ id: 'lf:1', type: 'lf' }, { id: 'ws:1', type: 'ws' }];
        function ids(l) { return l.map(function(s) { return s.id; }).join(','); }
        assert.strictEqual(ids(m.sdocAllViewSources(srcs, '', 'date')), 'lf:1');
        assert.strictEqual(ids(m.sdocAllViewSources(srcs, '', 'git')), 'lf:1,ws:1');
        assert.strictEqual(ids(m.sdocAllViewSources(srcs, 'x', 'alpha')), 'lf:1,ws:1');
        assert.strictEqual(m.sdocSrcRecursive(srcs[1], 'all', '', 'git'), true);
        assert.strictEqual(m.sdocSrcRecursive(srcs[0], 'all', '', 'git'), false);
        assert.strictEqual(m.sdocSrcRecursive(srcs[1], 'ws:1', '', 'git'), false, 'browsing one repo stays per-folder');
        assert.strictEqual(m.sdocSrcRecursive(srcs[0], 'lf:1', 'q', 'date'), true);
    }, { tags: ['unit'], timeout: 5000 });
});
