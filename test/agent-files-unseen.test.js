describe('Agent Files unseen helpers', function() {
    var DAY = 86400000, NOW = 1800000000000;
    async function load() { return loadModules(['src/js/tools/175-agent-files-unseen.js'], { globals: { appStorage: { getItem: function() { return null; }, setItem: function() {} } } }); }

    test('young unopened file is unseen; seen at same mtime is not', async function() {
        var m = await load();
        var f = { kind: 'file', path: 'a.md', lastModified: NOW - DAY };
        assert.strictEqual(m.afIsUnseen(f, {}, NOW), true);
        assert.strictEqual(m.afIsUnseen(f, { 'a.md': NOW - DAY }, NOW), false);
        // rewritten after being seen -> unseen again
        assert.strictEqual(m.afIsUnseen(f, { 'a.md': NOW - 2 * DAY }, NOW), true);
    }, { tags: ['unit'], timeout: 2000 });

    test('files older than 7 days, directories and missing mtimes are never unseen', async function() {
        var m = await load();
        assert.strictEqual(m.afIsUnseen({ kind: 'file', path: 'old', lastModified: NOW - 8 * DAY }, {}, NOW), false);
        assert.strictEqual(m.afIsUnseen({ kind: 'file', path: 'edge', lastModified: NOW - 7 * DAY }, {}, NOW), false);
        assert.strictEqual(m.afIsUnseen({ kind: 'directory', path: 'd', lastModified: NOW }, {}, NOW), false);
        assert.strictEqual(m.afIsUnseen({ kind: 'file', path: 'x' }, {}, NOW), false);
    }, { tags: ['unit'], timeout: 2000 });

    test('unseen map, folder roll-up and pruning of deleted/aged entries', async function() {
        var m = await load();
        var entries = [{ kind: 'directory', path: 'd' }, { kind: 'file', path: 'd/n.txt', lastModified: NOW - DAY }, { kind: 'file', path: 's.txt', lastModified: NOW - DAY }, { kind: 'file', path: 'o.txt', lastModified: NOW - 9 * DAY }];
        var seen = { 's.txt': NOW, 'gone.txt': NOW, 'o.txt': NOW };
        var u = m.afUnseenMap(entries, seen, NOW);
        assert.deepStrictEqual(Object.keys(u), ['d/n.txt']);
        assert.strictEqual(m.afUnseenUnder(u, 'd'), true);
        assert.strictEqual(m.afUnseenUnder(u, 'e'), false);
        assert.strictEqual(m.afUnseenUnder(u, ''), true);
        assert.strictEqual(m.afUnseenUnder({}, ''), false);
        assert.deepStrictEqual(m.afPruneSeen(seen, entries, NOW), { 's.txt': NOW });
    }, { tags: ['unit'], timeout: 2000 });

    function store(init) {
        var data = { agentFilesSeen: JSON.stringify(init || {}) }, writes = 0;
        return { data: data, writes: function() { return writes; },
            api: { getItem: function(k) { return data[k] == null ? null : data[k]; }, setItem: function(k, v) { writes++; data[k] = String(v); } } };
    }
    function loadWith(st, entries, truncated) {
        return loadModules(['src/js/tools/175-agent-files-unseen.js'], { globals: {
            appStorage: st.api, LOCAL_FOLDER_VIRTUAL_ID: 'virtual',
            lfListDir: function() { return Promise.resolve({ entries: entries, truncated: !!truncated }); }
        } });
    }

    test('afMarkSeen keeps marks written by another panel (no stale cache overwrite)', async function() {
        var now = Date.now(), st = store({});
        var m = await loadWith(st, []);
        m.afMarkSeen('a.md', now - 1000);
        // another panel writes b.md into the shared storage
        var other = JSON.parse(st.data.agentFilesSeen); other['b.md'] = now - 500; st.data.agentFilesSeen = JSON.stringify(other);
        m.afMarkSeen('c.md', now - 100);
        assert.deepStrictEqual(Object.keys(JSON.parse(st.data.agentFilesSeen)).sort(), ['a.md', 'b.md', 'c.md']);
    }, { tags: ['unit'], timeout: 2000 });

    test('a truncated listing never prunes seen marks; a complete one does', async function() {
        var now = Date.now(), st = store({ 'kept.md': now - 10, 'gone.md': now - 10 });
        var m = await loadWith(st, [{ kind: 'file', path: 'kept.md', lastModified: now - 10 }], true);
        await m.afRefreshUnseen();
        assert.deepStrictEqual(Object.keys(JSON.parse(st.data.agentFilesSeen)).sort(), ['gone.md', 'kept.md']);
        assert.strictEqual(st.writes(), 0);
        var m2 = await loadWith(st, [{ kind: 'file', path: 'kept.md', lastModified: now - 10 }], false);
        await m2.afRefreshUnseen();
        assert.deepStrictEqual(Object.keys(JSON.parse(st.data.agentFilesSeen)), ['kept.md']);
        assert.strictEqual(m2.afHasUnseen(''), false);
    }, { tags: ['unit'], timeout: 2000 });
});
