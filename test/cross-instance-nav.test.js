// Cross-instance navigateIframe (follow-up to PR #1310): opening a URL on a
// non-active known instance must never navigate away an arbitrary existing tab
// of that instance. Only a live tab already on the EXACT URL is reused (focused,
// not reloaded); otherwise — or when the cached tab id is stale — a new tab.

var EX = await runFile('test/extract.js', { i18n: false });
var OTHER = 'https://other.service-now.com';
var URL_A = OTHER + '/incident.do?sys_id=' + 'a'.repeat(32);
var URL_B = OTHER + '/incident.do?sys_id=' + 'b'.repeat(32);

async function build(instances, liveTabs) {
    var src = await loadFile('src/js/ui/300-iframe-management.js');
    var parts = ['navigateSameUrl', 'navigateCrossInstance'].map(function(n) {
        var fx = EX.findFunction(src, n);
        assert.ok(fx, n + ' found');
        return src.slice(fx.start, fx.end + 1);
    });
    var log = [];
    var nextId = 900;
    var chromeFake = {
        tabs: {
            get: async function(id) {
                log.push(['get', id]);
                if (!liveTabs[id]) throw new Error('No tab with id: ' + id);
                return { id: id, url: liveTabs[id], windowId: 1 };
            },
            update: async function(id, p) { log.push(['update', id, p]); if (!liveTabs[id]) throw new Error('No tab with id: ' + id); return { id: id }; },
            create: async function(p) { var id = nextId++; log.push(['create', p.url, p.active]); liveTabs[id] = p.url; return { id: id }; }
        },
        windows: { update: async function(id, p) { log.push(['focusWindow', id]); return {}; } }
    };
    var fn = new Function('Platform', 'chrome', parts.join('\n') + '\nreturn navigateCrossInstance;')(
        { instances: instances }, chromeFake);
    return { fn: fn, log: log };
}

function kinds(log) { return log.map(function(e) { return e[0]; }); }

describe('cross-instance navigate does not clobber existing tabs', function() {
    test('reuses (focuses, no reload) a live tab already on the exact URL', async function() {
        var b = await build([{ url: OTHER, tabs: [{ id: 1, url: URL_B }, { id: 2, url: URL_A }] }], { 1: URL_B, 2: URL_A });
        var r = await b.fn(OTHER, URL_A);
        assert.deepStrictEqual(r, { tabId: 2, reused: true });
        assert.ok(!kinds(b.log).includes('create'), 'no new tab');
        var upd = b.log.filter(function(e) { return e[0] === 'update'; });
        assert.strictEqual(upd.length, 1);
        assert.strictEqual(upd[0][1], 2, 'only the exact-URL tab is touched');
        assert.deepStrictEqual(upd[0][2], { active: true }, 'focus only — no url change');
    }, { tags: ['unit'], timeout: 3000 });

    test('trailing slash on path is ignored but query must match', async function() {
        var b = await build([{ url: OTHER, tabs: [{ id: 5, url: OTHER + '/now/nav/ui/' }] }], { 5: OTHER + '/now/nav/ui/' });
        var r = await b.fn(OTHER, OTHER + '/now/nav/ui');
        assert.strictEqual(r.reused, true);
    }, { tags: ['unit'], timeout: 3000 });

    test('never reuses an arbitrary tab of the instance (same path, different record)', async function() {
        var b = await build([{ url: OTHER, tabs: [{ id: 1, url: URL_B }, { id: 3, url: OTHER + '/now/nav/ui/home' }] }], { 1: URL_B, 3: OTHER + '/now/nav/ui/home' });
        var r = await b.fn(OTHER, URL_A);
        assert.strictEqual(r.created, true);
        assert.ok(!kinds(b.log).includes('update'), 'no existing tab updated');
        assert.deepStrictEqual(b.log.filter(function(e) { return e[0] === 'create'; })[0], ['create', URL_A, true]);
    }, { tags: ['unit'], timeout: 3000 });

    test('stale cached tab (closed) falls back to a new tab', async function() {
        var b = await build([{ url: OTHER, tabs: [{ id: 7, url: URL_A }] }], {});
        var r = await b.fn(OTHER, URL_A);
        assert.strictEqual(r.created, true, 'new tab created');
        assert.ok(kinds(b.log).includes('get'), 'live tab was checked');
        assert.ok(!kinds(b.log).includes('update'), 'no update on the dead tab');
    }, { tags: ['unit'], timeout: 3000 });

    test('cached tab that has since navigated elsewhere is not reused', async function() {
        var b = await build([{ url: OTHER, tabs: [{ id: 8, url: URL_A }] }], { 8: URL_B });
        var r = await b.fn(OTHER, URL_A);
        assert.strictEqual(r.created, true);
        assert.ok(!kinds(b.log).includes('update'), 'tab now on another record left alone');
    }, { tags: ['unit'], timeout: 3000 });

    test('no tabs for the instance → new tab', async function() {
        var b = await build([{ url: OTHER, tabs: [] }], {});
        var r = await b.fn(OTHER, URL_A);
        assert.strictEqual(r.created, true);
    }, { tags: ['unit'], timeout: 3000 });

    test('navigateIframe no longer uses getTabForInstance without a target URL', async function() {
        var src = await loadFile('src/js/ui/300-iframe-management.js');
        assert.ok(!/getTabForInstance\(_target\)/.test(src), 'arbitrary-tab lookup removed');
        assert.ok(/navigateCrossInstance\(_target, resolvedUrl\)/.test(src), 'routes through navigateCrossInstance');
    }, { tags: ['unit'], timeout: 3000 });
});
