describe('sidebar persisted workspace ownership', function() {
    var path = 'src/js/ui/115-workspace-files-sidebar.js';
    async function setup(opts) {
        opts = opts || {};
        var source = await loadFile(path);
        var state = { rows: opts.rows || {}, reads: [], renders: 0, events: {}, resolved: [], stores: [] };
        // Execute the REAL production helper against a request/transaction fake.
        // The fake exposes raw rows only; blob access is a hard test failure.
        var core = await loadFile('src/js/core/130-indexeddb.js');
        var a = core.indexOf('async function getWorkspaceOwnedFileSummaries() {');
        var b = core.indexOf('\n}\n', a);
        var reader = new Function('openDatabase', 'workspaceMetaStoreName', 'workspaceFilesStoreName', core.slice(a, b + 2) + '\nreturn getWorkspaceOwnedFileSummaries;')(
            async function() {
                if (state.failOpen) throw new Error('open failed');
                return { transaction: function(names, mode) {
                    assert.deepStrictEqual(names, ['meta', 'files']);
                    assert.strictEqual(mode, 'readonly');
                    state.reads.push('snapshot');
                    var metaRequest = {}, fileRequest = {}, metaDone = false, fileDone = false;
                    var tx = { objectStore: function(name) {
                        state.stores.push(name);
                        if (name === 'meta') return { getAllKeys: function() { return metaRequest; } };
                        if (name === 'files') return { openCursor: function() { return fileRequest; } };
                        throw new Error('Unexpected blob store read: ' + name);
                    } };
                    function complete() {
                        if (metaDone && fileDone) {
                            if (state.failAbort) tx.onabort();
                            else if (state.failTx) tx.onerror();
                            else tx.oncomplete();
                        }
                    }
                    Promise.resolve().then(async function() {
                        if (state.readHook) await state.readHook();
                        if (state.failMeta) { metaRequest.onerror(); return; }
                        metaRequest.result = Object.keys(state.rows); metaRequest.onsuccess(); metaDone = true;
                        if (state.failRows) { fileRequest.onerror(); return; }
                        var raw = [];
                        Object.keys(state.rows).forEach(function(wk) {
                            state.rows[wk].forEach(function(r) {
                                var f = Object.assign({ repo: wk }, r);
                                Object.defineProperty(f, 'content', { get: function() { throw new Error('file body accessed'); } });
                                Object.defineProperty(f, 'original_content', { get: function() { throw new Error('base body accessed'); } });
                                raw.push(f);
                            });
                        });
                        if (state.orphan) raw.push(state.orphan);
                        var index = 0;
                        function next() {
                            if (index < raw.length) fileRequest.result = { value: raw[index++], continue: function() { Promise.resolve().then(next); } };
                            else { fileRequest.result = null; fileDone = true; }
                            fileRequest.onsuccess(); complete();
                        }
                        next();
                    });
                    return tx;
                } };
            }, 'meta', 'files');
        var api = new Function('getAllWorkspaceMetas', 'getAllWorkspaceFiles', 'renderVersionSidebar', 'getSubAgentChatsForChat', 'subAgentsForChatTree', 'getWorkspaceFile', 'AgentEvents', 'setTimeout', 't', 'tn', 'escapeHtml', 'getWorkspaceOwnedFileSummaries', source + '\nreturn { refresh: _wsfRefreshOwnedRows, files: getWsEditedFilesForChat, render: renderWorkspaceFilesSection, section: function(){return _wsfSectionFiles;}, resolve: _wsfResolve, cache: function(){return _wsfOwnedRows;}, view: wsfOpenViewer, diff: wsfOpenDiff, capture: function(fn){ _wsfOverlay = fn; _wsfFmtSize = function(){return "size";}; _wsfRenderDiffHtml = function(a,b){return a + " -> " + b;}; } };')(
            async function() { if (state.failMeta) throw new Error('meta failed'); return Object.keys(state.rows).map(function(wk) { return { repo: wk }; }); },
            async function(wk) { state.reads.push(wk); if (state.readHook) await state.readHook(wk); if (state.failRows) throw new Error('rows failed'); return state.rows[wk]; },
            function() { state.renders++; },
            function(id) { return (opts.children || {})[id] || []; },
            function(id) { return (opts.registry || {})[id] || []; },
            async function(wk, p) { state.resolved.push([wk, p]); return { content: wk + '/' + p, original_content: 'base', dirty: true }; },
            { on: function(name, fn) { state.events[name] = fn; } }, function(fn) { fn(); return 1; },
            function(s) { return s; }, function(n, a) { return a; }, function(s) { return String(s); }, reader
        );
        state.api = api;
        state.reader = reader;
        await api.refresh();
        return state;
    }
    function row(owner, p, extra) { return Object.assign({ path: p || 'locales/fr.json', dirty: true, sha: 'base', last_modified_by_chat_id: owner }, extra || {}); }
    function direct(id, wk, p) { return { id: id, messages: [
        { role: 'assistant', tool_calls: [{ id: 'w', function: { name: 'workspace', arguments: JSON.stringify({ action: 'write', workspace: wk, path: p, content: 'new' }) } }] },
        { role: 'tool', tool_call_id: 'w', content: { success: true } }
    ] }; }
    test('nested writes backfill root and worker, excluding siblings and unrelated owners', async function() {
        var s = await setup({ rows: { 'o/r::main': [row('worker'), row('root', 'root.md'), row('sibling', 'secret.md')] }, registry: { root: [{ chat_id: 'worker', name: 'Translator' }] } });
        var nested = { id: 'root', messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'js_eval', arguments: '{"code":"not parsed or evaluated"}' } }] }] };
        var html = s.api.render(nested);
        assert.strictEqual(s.api.section().length, 2);
        assert.ok(html.includes('Translator'));
        assert.ok(!html.includes('secret.md'));
        assert.strictEqual(s.api.files({ id: 'worker', _messagesEvicted: true }).length, 1);
        assert.strictEqual(s.api.files({ id: 'other' }).length, 0);
        assert.strictEqual(s.api.files({ id: 'worker' })[0].changes.length, 0, 'no synthetic history');
    });
    test('direct and owned evidence deduplicate but same path across repositories and branches stays distinct', async function() {
        var s = await setup({ rows: { 'o/r::main': [row('root')], 'o/r::next': [row('root')], 'o/other::main': [row('root')] } });
        var files = s.api.files(direct('root', 'o/r::main', 'locales/fr.json'));
        assert.strictEqual(files.length, 3);
        assert.strictEqual(files[0].changes.length, 1);
        assert.strictEqual(files[1].changes.length, 0);
        s.api.render(direct('root', 'o/r::main', 'locales/fr.json'));
        for (var i = 0; i < 3; i++) await s.api.resolve(s.api.section()[i]);
        assert.deepStrictEqual(s.resolved, [['o/r::main','locales/fr.json'],['o/r::next','locales/fr.json'],['o/other::main','locales/fr.json']], 'view/diff resolver uses exact selected workspace');
    });
    test('owned-only cards open real view and diff handlers for the selected branch', async function() {
        var s = await setup({ rows: { 'o/r::main': [row('root')], 'o/r::next': [row('root')] } });
        s.api.render({ id: 'root' });
        var opened = [];
        s.api.capture(function(title, body, opts) { opened.push({ body: body, active: opts.active, index: opts.fileIndex }); });
        assert.strictEqual(await s.api.view(1), true);
        assert.strictEqual(await s.api.diff(0), true);
        assert.ok(opened[0].body.includes('o/r::next/locales/fr.json'));
        assert.ok(opened[1].body.includes('base -> o/r::main/locales/fr.json'));
        assert.deepStrictEqual(opened.map(function(o) { return [o.active,o.index]; }), [['view',1],['diff',0]]);
    });
    test('ambiguous legacy paths fail closed instead of opening an unrelated pinned workspace', async function() {
        var s = await setup({ rows: { 'o/r::main': [], 'o/r::next': [] } });
        assert.strictEqual(await s.api.resolve({ path: 'same.js', wsKey: null }), null);
    });
    test('push snapshots for the same path retain both workspace identities', async function() {
        var s = await setup();
        var chat = { id: 'root', messages: [] };
        ['o/r::main', 'o/r::next'].forEach(function(wk, i) {
            chat.messages.push({ role: 'assistant', tool_calls: [{ id: 'p' + i, function: { name: 'workspace', arguments: JSON.stringify({ action: 'push', workspace: wk }) } }] });
            chat.messages.push({ role: 'tool', tool_call_id: 'p' + i, content: { success: true, workspace: wk, pr_url: 'https://github.com/o/r/pull/' + (i + 1), pr_number: i + 1, files: [{ path: 'same.js' }] } });
        });
        var files = s.api.files(chat);
        assert.strictEqual(files.length, 2);
        assert.deepStrictEqual(files.map(function(f) { return [f.wsKey, f.pushedPr.number, f.changes.length]; }), [['o/r::main',1,0],['o/r::next',2,0]]);
    });
    test('pushed owner survives reload and missing worker body with PR chip', async function() {
        var opts = { rows: { 'o/r::main': [row(null, 'fr.md', { pushed_by_chat_id: 'worker', pushed_pr: { url: 'https://github.com/o/r/pull/7', number: 7 } })] }, registry: { root: [{ chat_id: 'worker', name: 'Writer' }] } };
        var s = await setup(opts), reloaded = await setup(opts);
        assert.ok(s.api.render({ id: 'root' }).includes('pull/7'));
        reloaded.api.render({ id: 'root' });
        assert.strictEqual(reloaded.api.section()[0].workers[0], 'Writer');
        assert.strictEqual(reloaded.api.section()[0].changes.length, 0);
        assert.strictEqual(reloaded.api.files({ id: 'worker' }).length, 1);
    });
    test('failed metadata and row reads retain good cache, later success replaces it', async function() {
        var s = await setup({ rows: { 'o/r::main': [row('root')] } });
        var before = JSON.stringify(s.api.cache());
        s.failMeta = true; await s.api.refresh();
        assert.strictEqual(JSON.stringify(s.api.cache()), before);
        s.failMeta = false; s.failRows = true; await s.api.refresh();
        assert.strictEqual(JSON.stringify(s.api.cache()), before);
        s.failRows = false;
        for (var flag of ['failOpen', 'failAbort', 'failTx']) {
            s[flag] = true; await s.api.refresh();
            assert.strictEqual(JSON.stringify(s.api.cache()), before, flag + ' keeps last successful snapshot');
            s[flag] = false;
        }
        assert.ok(s.stores.every(function(name) { return name === 'meta' || name === 'files'; }), 'zero blob reads');
        s.rows['o/r::main'] = []; await s.api.refresh();
        assert.strictEqual(s.api.files({ id: 'root' }).length, 0);
    });
    test('production ownership helper projects metadata, excludes orphan rows, and rejects actual IDB failures', async function() {
        var s = await setup({ rows: { 'o/r::main': [row('root'), row(null, 'unowned.js')] } });
        s.orphan = Object.assign({ repo: 'o/deleted::gone' }, row('root', 'orphan.js'));
        var result = await s.reader();
        assert.strictEqual(result.length, 1);
        assert.deepStrictEqual(Object.keys(result[0]).sort(), ['isDeleted','isNew','owner','path','pushedPr','wsKey'].sort());
        for (var flag of ['failMeta', 'failRows', 'failOpen', 'failAbort', 'failTx']) {
            s[flag] = true;
            var rejected = false;
            try { await s.reader(); } catch (e) { rejected = true; }
            assert.strictEqual(rejected, true, flag + ' must reject, not look empty');
            s[flag] = false;
        }
        assert.ok(s.stores.every(function(name) { return name === 'meta' || name === 'files'; }));
    });
    test('mutation during an in-flight read requests a second scan', async function() {
        var s = await setup({ rows: { 'o/r::main': [row('root')] } });
        var release, entered;
        var enteredPromise = new Promise(function(r) { entered = r; });
        s.readHook = function() { s.readHook = null; entered(); return new Promise(function(r) { release = r; }); };
        var n = s.reads.length, first = s.api.refresh();
        await enteredPromise;
        s.events.workspaceMutated({ action: 'write' });
        release(); await first;
        assert.strictEqual(s.reads.length, n + 2);
    });
    test('root/worker same path different workspaces never merges; unique omitted workspace backfills', async function() {
        var child = direct('worker', 'o/r::next', 'a.js');
        var s = await setup({ rows: { 'o/r::main': [row('root', 'a.js')] }, children: { root: [{ chatId: 'worker', name: 'Worker', chat: child }] } });
        s.api.render(direct('root', 'o/r::main', 'a.js'));
        assert.strictEqual(s.api.section().length, 2);
        assert.strictEqual(s.api.section()[0].workers, undefined);
        assert.strictEqual(s.api.files(direct('root', null, 'a.js')).length, 1);
    });
});
