// WSF-STATUS / WSF-GROUP: one status per file derived from (live row state,
// PR state) — files pushed to the same PR never disagree, an old merged PR
// touching a path never masks current uncommitted edits, and rows are
// grouped per workspace.
describe('sidebar workspace files › unified status + grouping', function() {
    var WS = 'o/AppAgent::main', PR = 'https://github.com/o/AppAgent/pull/1310';
    async function setup(o) {
        o = o || {};
        var src = await loadFile('src/js/ui/115-workspace-files-sidebar.js');
        var renders = 0;
        var api = new Function('getAllWorkspaceMetas', 'getWorkspaceOwnedFileSummaries', 'renderVersionSidebar', 'getSubAgentChatsForChat', 'subAgentsForChatTree', 'parseWsKey', 'AgentEvents', 'setTimeout', 't', 'tn', 'escapeHtml', 'getWorkspaceBlobsBySha', 'computeDiff', 'UI_ICONS', 'showSnackbar', 'computeWordDiffsForLines', 'getWorkspaceFile', 'fvRenderMarkdown', 'githubApi', 'parsePrUrl', 'patchWorkspaceMeta',
            src + '\nreturn { section2: function(){return { src: _wsfNavSource, list: _wsfSectionFiles };}, render: renderWorkspaceFilesSection, section: function(){return _wsfSectionFiles;}, owned: _wsfRefreshOwnedRows, snaps: _wsfRefreshMergedSnaps, loading: function(){return _wsfMergedSnapsLoading;}, files: getWsEditedFilesForChat, status: _wsfStatusOf, prFilesHtml: _wsfPrFilesTabHtml, prHtml: function(p, c){ return _wsfPrFilesTabHtml(p, _wsfFilesForPr(p, c)); }, filesFor: _wsfFilesForPr, toggleFile: wsfTogglePrFileDiff, toggleAll: wsfPrToggleAll, runCounts: _wsfRunCountQueue, prList: function(u){return _wsfPrLists[u];}, prModal: wsfOpenPrModal, prTab: wsfPrModalTab, diffHtml: _wsfRenderDiffHtml, live: _wsfPrLiveFetch, liveCheck: _wsfPrLiveCheck, chip: _wsfPrChipLineHtml, spinnerMs: _WSF_SPINNER_DELAY_MS };')(
            function() { o.metaCalls = (o.metaCalls || 0) + 1; return o.metaHook ? o.metaHook() : Promise.resolve(o.metas || []); },
            async function() { return o.rows || []; },
            function() { renders++; },
            function() { return []; }, function() { return []; },
            function(wk) { return { repo: String(wk).split('::')[0] }; },
            { on: function() {} }, o.setTimeout || function(fn) { return 1; },
            function(s, a) { return a && a.number != null ? s.replace('{number}', a.number) : s; },
            function(n, a, b) { return n === 1 ? a : b.replace('{count}', n); },
            function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); },
            async function(shas) { o.blobCalls = (o.blobCalls || 0) + 1; if (o.blobHook) return o.blobHook(shas); var out = {}; shas.forEach(function(s) { if (o.blobs && o.blobs[s] != null) out[s] = o.blobs[s]; }); return out; },
            function(a, b) { var A = a.split('\n'), B = b.split('\n'), d = []; A.forEach(function(l) { d.push({ type: B.indexOf(l) < 0 ? 'remove' : 'same' }); }); B.forEach(function(l) { if (A.indexOf(l) < 0) d.push({ type: 'add' }); }); return d; },
            {}, function(m) { (o.snacks = o.snacks || []).push(m); }, function() { return []; }, async function() { return null; }, o.md,
            o.githubApi, function(u) { var m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(u || ''); return m ? { repo: m[1], number: +m[2] } : null; },
            function(repo, fn) { var cur = JSON.parse(JSON.stringify((o.metas || []).filter(function(m) { return m.repo === repo; })[0] || {})); var r = fn(cur); (o.patched = o.patched || []).push({ repo: repo, saved: r !== false, cur: cur }); return Promise.resolve(); });
        await api.owned();
        api.snaps(); await Promise.resolve(); await Promise.resolve(); await new Promise(function(r) { Promise.resolve().then(r); });
        return api;
    }
    function pushChat(paths) {
        return { id: 'c1', messages: [
            { role: 'assistant', tool_calls: [{ id: 'p', function: { name: 'workspace', arguments: JSON.stringify({ action: 'push', workspace: WS }) } }] },
            { role: 'tool', tool_call_id: 'p', content: { success: true, workspace: WS, pr_url: PR, pr_number: 1310, files: paths.map(function(p) { return { path: p }; }) } }
        ] };
    }
    function statuses(api, chat) { return api.files(chat).map(function(f) { return api.status(f).key; }); }
    function badges(html) { var m = html.match(/data-status="[^"]+"/g) || []; return m.map(function(s) { return s.slice(13, -1); }); }

    test('all files of a merged PR show MERGED, even when the PR snapshot lacks one file; none is listed under Workspace Files', async function() {
        var metas = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 1310, state: 'merged', url: PR, files: [{ path: 'a.js' }] }] }];
        var api = await setup({ metas: metas });
        var chat = pushChat(['a.js', 'src/b.js', 'src/c.js']);
        assert.deepStrictEqual(statuses(api, chat), ['merged', 'merged', 'merged']);
        // WSF-SCOPE: pushed files belong to their PR, not to Workspace Files.
        assert.strictEqual(api.render(chat), '', 'section omitted when every file is in a PR');
        assert.strictEqual(api.section().length, 0);
        // ... they are listed in the PR modal's Files tab instead (snapshot + this chat's push).
        var html = api.prHtml({ url: PR, number: 1310 }, chat);
        assert.deepStrictEqual((html.match(/class="wsf-pr-file-path">[^<]+/g) || []).map(function(s) { return s.slice(25); }), ['a.js', 'src/b.js', 'src/c.js']);
        assert.strictEqual((html.match(/onclick="wsfTogglePrFileDiff\(this, \d\)"/g) || []).length, 3, 'headers toggle inline diffs (CSP-polyfill-safe args)');
        assert.strictEqual((html.match(/wsf-k-modified[^>]*>M</g) || []).length, 3, 'M letter per file');
    }, { tags: ['unit'] });

    test('Workspace Files keeps only uncommitted rows: IN PR / MERGED rows out, edited-after-push (changedSincePush) in', async function() {
        var metas = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 1310, url: PR }] }];
        var rows = [
            { path: 'src/b.js', wsKey: WS, owner: 'c1', dirty: true, changedSincePush: true, pushedPr: { url: PR, number: 1310 } },
            { path: 'src/c.js', wsKey: WS, owner: 'c1', dirty: true, prMerged: true, pushedPr: { url: PR, number: 1310 } }
        ];
        var api = await setup({ metas: metas, rows: rows });
        var chat = pushChat(['a.js', 'src/b.js', 'src/c.js']);
        assert.deepStrictEqual(statuses(api, chat), ['pr', 'modified', 'merged']);
        var html = api.render(chat);
        assert.deepStrictEqual(badges(html), ['modified'], 'only the edited-after-push row');
        assert.ok(/title="src\/b\.js/.test(html), 'b.js listed');
        assert.ok(html.indexOf('onclick="wsfOpenWsFile(0)"') > 0, 'row opens via the WS nav list');
        assert.ok(html.indexOf('>\u2022<') < 0 && html.indexOf('#1310') < 0, 'no bare dot, no per-row PR chip');
        assert.deepStrictEqual(api.section().map(function(f) { return f.path; }), ['src/b.js']);
    }, { tags: ['unit'] });

    test('a file re-edited after its PR merged (prMerged + changedSincePush) shows MODIFIED and stays listed', async function() {
        var metas = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 1310, state: 'merged', url: PR, files: [{ path: 'a.js' }] }] }];
        var rows = [
            { path: 'a.js', wsKey: WS, owner: 'c1', dirty: true, prMerged: true, changedSincePush: true, pushedPr: { url: PR, number: 1310 } },
            { path: 'src/b.js', wsKey: WS, owner: 'c1', dirty: true, prMerged: true, pushedPr: { url: PR, number: 1310 } }
        ];
        var api = await setup({ metas: metas, rows: rows });
        var chat = pushChat(['a.js', 'src/b.js']);
        assert.deepStrictEqual(statuses(api, chat), ['modified', 'merged']);
        assert.deepStrictEqual(badges(api.render(chat)), ['modified']);
    }, { tags: ['unit'] });

    test('a pushed PR missing from every workspace record: dirty row shows MODIFIED (listed), clean row stays IN PR', async function() {
        var rows = [{ path: 'a.js', wsKey: WS, owner: 'c1', dirty: true, pushedPr: { url: PR, number: 1310 } }];
        var api = await setup({ metas: [{ repo: WS, github_repo: 'o/AppAgent', prs: [] }], rows: rows });
        var chat = pushChat(['a.js', 'src/b.js']);
        assert.deepStrictEqual(statuses(api, chat), ['modified', 'pr']);
        assert.deepStrictEqual(badges(api.render(chat)), ['modified']);
    }, { tags: ['unit'] });

    test('an old merged PR touching the path never masks current uncommitted edits', async function() {
        var metas = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 5, state: 'merged', merged_at: '2026-01-01', files: [{ path: 'x.js' }] }] }];
        var api = await setup({ metas: metas, rows: [{ path: 'x.js', wsKey: WS, owner: 'c1', dirty: true }] });
        var chat = { id: 'c1', messages: [
            { role: 'assistant', tool_calls: [{ id: 'e', function: { name: 'workspace', arguments: JSON.stringify({ action: 'edit', workspace: WS, path: 'x.js' }) } }] },
            { role: 'tool', tool_call_id: 'e', content: { success: true, workspace: WS } }] };
        assert.deepStrictEqual(badges(api.render(chat)), ['modified']);
    }, { tags: ['unit'] });

    test('letters + workspace labels only with >1 workspace; toggle keeps state across renders', async function() {
        var api = await setup({ metas: [] });
        var chat = { id: 'c1', messages: [
            { role: 'assistant', tool_calls: [{ id: 'e1', function: { name: 'workspace', arguments: JSON.stringify({ action: 'edit', workspace: WS, path: 'src/x.js' }) } }] },
            { role: 'tool', tool_call_id: 'e1', content: { success: true, workspace: WS } },
            { role: 'assistant', tool_calls: [{ id: 'e2', function: { name: 'workspace', arguments: JSON.stringify({ action: 'write', workspace: 'o/Other::main', path: 'y.js' }) } }] },
            { role: 'tool', tool_call_id: 'e2', content: { success: true, workspace: 'o/Other::main', message: 'Created y.js' } }] };
        var html = api.render(chat);
        assert.strictEqual((html.match(/wsf-group-label/g) || []).length, 2, 'label per workspace when >1');
        assert.ok(/data-status="modified"[\s\S]*?wsf-letter[^>]*>M</.test(html), 'M letter');
        assert.ok(/data-status="new"[\s\S]*?wsf-letter[^>]*>A</.test(html), 'A letter');
    }, { tags: ['unit'] });

    test('PR Files tab: A/D/M letters from the PR file entry, +N/−M counts from the pushed blobs; unknown PR says files not recorded', async function() {
        var metas = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 1310, url: PR, state: 'closed', files: [{ path: 'n.js', new_sha: 's1' }, { path: 'src/g.js', old_sha: 's2' }, { path: 'm.js', old_sha: 's3', new_sha: 's4' }] }] }];
        var o = { metas: metas, blobs: { s1: 'a\nb\n', s2: 'x\ny\nz\n', s3: 'k\nold\n', s4: 'k\nnew1\nnew2\n' } };
        var api = await setup(o);
        var chat = pushChat(['n.js', 'src/g.js', 'm.js']);
        assert.deepStrictEqual(statuses(api, chat), ['closed', 'closed', 'closed']);
        assert.strictEqual(api.render(chat), '', 'closed-PR files are not uncommitted');
        var pr = { url: PR, number: 1310 };
        var html = api.prFilesHtml(pr, api.filesFor(pr, chat));
        assert.ok(/title="n\.js"[\s\S]*?wsf-k-new" aria-label="NEW">A</.test(html), 'added file: A');
        assert.ok(/title="src\/g\.js"[\s\S]*?wsf-k-deleted" aria-label="DELETED">D</.test(html), 'deleted file: D');
        assert.ok(/title="m\.js"[\s\S]*?wsf-k-modified" aria-label="MODIFIED">M</.test(html), 'modified file: M');
        assert.ok(html.indexOf('wsf-diff-add') < 0, 'no counts before the async pass');
        assert.strictEqual((html.match(/onclick="wsfTogglePrFileDiff\(this, \d\)"/g) || []).length, 3, 'headers toggle inline diffs (CSP-polyfill-safe args)');
        await api.runCounts();
        html = api.prFilesHtml(pr, api.filesFor(pr, chat));
        assert.ok(/title="n\.js"[\s\S]*?wsf-diff-add">\+2<\/span><\/span>/.test(html), 'new file: +2 only');
        assert.ok(/title="src\/g\.js"[\s\S]*?<span class="wsf-counts"><span class="wsf-diff-del">\u22123</.test(html), 'deleted file: \u22123 only');
        assert.ok(/title="m\.js"[\s\S]*?wsf-diff-add">\+2<\/span><span class="wsf-diff-del">\u22121</.test(html), 'modified file: +2 \u22121');
        assert.strictEqual(api.prList(PR).length, 3, 'file list registered for the handlers');
        var none = api.prFilesHtml({ url: 'https://github.com/o/AppAgent/pull/9', number: 9 }, null);
        assert.ok(none.indexOf('wsf-empty">Files not recorded<') > 0, 'unknown PR');
    }, { tags: ['unit'] });

    test('compact diffstat: a zero side is omitted (+N only / \u2212M only, never +0 or \u22120)', async function() {
        var metas = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 1310, url: PR, state: 'merged', files: [{ path: 'm.js', old_sha: 's3', new_sha: 's4' }, { path: 'r.js', old_sha: 's5', new_sha: 's6' }] }] }];
        var api = await setup({ metas: metas, blobs: { s3: 'k\n', s4: 'k\nn1\nn2\n', s5: 'k\nx\ny\n', s6: 'k\n' } });
        api.prHtml({ url: PR, number: 1310 }, null);
        await api.runCounts();
        var html = api.prHtml({ url: PR, number: 1310 }, null);
        assert.ok(/title="m\.js[\s\S]*?<span class="wsf-counts"><span class="wsf-diff-add">\+2<\/span><\/span>/.test(html), 'additions only: +2, no \u22120');
        assert.ok(/title="r\.js[\s\S]*?<span class="wsf-counts"><span class="wsf-diff-del">\u22122<\/span><\/span>/.test(html), 'removals only: \u22122, no +0');
        assert.ok(html.indexOf('>+0<') < 0 && html.indexOf('>\u22120<') < 0, 'no zero counts anywhere');
    }, { tags: ['unit'] });

    // Minimal Element facade + the real csp-polyfill.js: the built extension
    // binds inline onclick through its mini interpreter (_exec/_args/_val),
    // not through eval — a this.closest('...') arg arrives as a string.
    function El(node) { this.node = node; }
    Object.defineProperties(El.prototype, {
        innerHTML: { configurable: true, get: function() { return this.node.innerHTML; }, set: function(v) { this.node.innerHTML = v; } },
        outerHTML: { configurable: true, get: function() { return this.node.outerHTML; }, set: function(v) { this.node.outerHTML = v; } }
    });
    El.prototype.insertAdjacentHTML = function(p, h) { this.node.insertAdjacentHTML(p, h); };
    El.prototype.setAttribute = function(n, v) { this.node.setAttribute(n, v); };
    El.prototype.addEventListener = function(t, fn) { (this.l = this.l || {})[t] = fn; };
    El.prototype.closest = function(s) { return this.node.closest(s); };
    async function polyfill(o, w) {
        w.window = w;
        await loadModules(['src/platform/extension/csp-polyfill.js'], { globals: { Element: El, window: w, document: { addEventListener: function() {} }, console: { warn: function(a, b) { o.warn = b; } } } });
    }
    function bind(node) { var el = new El(node); el.setAttribute('onclick', node.getAttribute('onclick')); return el; }
    function click(el, ev) { return el.l.click.call(el, ev || { type: 'click', stopPropagation: function() {}, preventDefault: function() {} }); }

    test('Files tab header click (REAL CSP polyfill) expands the diff INLINE (no new overlay), second click collapses; unresolvable file says not found inline', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var metas = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 1310, url: PR, state: 'open', files: [{ path: 'a.js', old_sha: 's1', new_sha: 's2' }, { path: 'src/b.js', old_sha: 's3', new_sha: 's4' }, { path: 'gone.js' }] }] }];
        var o = { metas: metas, blobs: { s1: 'a\n', s2: 'a\nA\n', s3: 'b\n', s4: 'b\nB\n' } };
        var api = await setup(o);
        var src = document.createElement('div');
        src.setAttribute('data-pr-url', PR); src.setAttribute('data-pr-number', '1310');
        await polyfill(o, { wsfTogglePrFileDiff: function(el, idx) { o.res = api.toggleFile(el, idx); return o.res; }, wsfPrToggleAll: function(el) { return api.toggleAll(el); } });
        try {
            var ov = api.prModal(src, null);
            var heads = ov.querySelectorAll('.wsf-pr-file-head');
            assert.strictEqual(heads.length, 3);
            var h = heads[1], body = h.parentNode.querySelector('.wsf-pr-file-body');
            assert.ok(body.hidden && h.getAttribute('aria-expanded') === 'false', 'collapsed by default, nothing loaded');
            click(bind(h));
            assert.ok(!o.warn, 'polyfill ran the handler without error: ' + (o.warn || ''));
            assert.strictEqual(await o.res, true, 'expanded');
            assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 1, 'no stacked overlay');
            assert.ok(!body.hidden && h.getAttribute('aria-expanded') === 'true' && h.parentNode.classList.contains('open'));
            assert.ok(body.querySelector('.diff-line.diff-add'), 'diff rendered inline under the header');
            assert.strictEqual(h.querySelector('.wsf-counts').textContent, '+1', 'header diffstat filled from the diff');
            click(bind(h));
            assert.strictEqual(await o.res, false, 'collapsed');
            assert.ok(body.hidden && h.getAttribute('aria-expanded') === 'false');
            assert.ok(body.querySelector('.diff-line'), 'loaded diff kept for the next expand');
            click(bind(heads[2]));
            await o.res;
            assert.ok(/not found/.test(heads[2].parentNode.querySelector('.wsf-pr-file-body').textContent), 'not-found state inline');
            assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 1, 'still a single modal');
            var all = ov.querySelector('.wsf-pr-toggle-all');
            click(bind(all));
            assert.strictEqual(ov.querySelectorAll('.wsf-pr-file-head[aria-expanded="true"]').length, 3, 'expand all');
            assert.strictEqual(all.textContent, 'Collapse all');
            click(bind(all));
            assert.strictEqual(ov.querySelectorAll('.wsf-pr-file-head[aria-expanded="true"]').length, 0, 'collapse all');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
    }, { tags: ['unit'] });

    var PRMETA = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 1310, url: PR, state: 'open', title: 'Add <b>thing</b>', body: '## Summary\n- one', branch: 'feat/x', files: [{ path: 'a.js', old_sha: 's1', new_sha: 's2' }] }] }];
    function mdStub(s) { return '<h2>' + s.split('\n')[0].replace('## ', '') + '</h2><ul><li>one</li></ul>'; }

    test('PR modal: GitHub-style header (title, #N, state, branch), markdown description, Files changed tab with inline diffs; reopening reuses it', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var api = await setup({ metas: PRMETA, blobs: { s1: 'a\n', s2: 'a\nA\n' }, md: mdStub });
        var src = document.createElement('div');
        src.setAttribute('data-pr-url', PR); src.setAttribute('data-pr-number', '1310');
        try {
            var ov = api.prModal(src, null);
            assert.ok(ov.classList.contains('wsf-pr-overlay'));
            assert.strictEqual(ov.querySelector('.wsf-pr-title').textContent, 'Add <b>thing</b>', 'title escaped, shown as text');
            assert.strictEqual(ov.querySelector('.wsf-pr-num').textContent, '#1310');
            assert.ok(ov.querySelector('.wsf-pr-state.wsf-pr-state-open'), 'OPEN state pill');
            assert.strictEqual(ov.querySelector('.wsf-pr-branches code').textContent, 'feat/x');
            assert.strictEqual(ov.querySelector('.wsf-pr-gh').getAttribute('href'), PR, 'GitHub link icon');
            var conv = ov.querySelector('[data-pane="conv"]'), files = ov.querySelector('[data-pane="files"]');
            assert.strictEqual(conv.querySelector('.wsf-pr-desc h2').textContent, 'Summary', 'description rendered as markdown');
            assert.ok(!conv.hidden && files.hidden, 'Conversation tab first');
            assert.strictEqual(ov.querySelector('.wsf-pr-count').textContent, '1');
            api.prTab(ov.querySelector('.wsf-pr-tab[data-tab="files"]'), 'files');
            assert.ok(conv.hidden && !files.hidden, 'Files changed tab switched');
            assert.strictEqual(ov.querySelector('.wsf-pr-tab.active').getAttribute('data-tab'), 'files');
            assert.ok(!files.querySelector('.wsf-card'), 'no sidebar-style file cards');
            assert.strictEqual(await api.toggleFile(files.querySelector('.wsf-pr-file-head'), 0), true, 'file diff expands inline');
            assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 1, 'no stacked diff overlay');
            // Re-opening the same PR (e.g. a diff modal's PR chip) reuses the open modal.
            assert.strictEqual(api.prModal(src, null), ov, 'existing PR modal reused');
            assert.strictEqual(document.querySelectorAll('.wsf-pr-overlay').length, 1, 'never two PR modals');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
    }, { tags: ['unit'] });

    test('PR modal: no description -> GitHub empty text; diffstat omits zero sides', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var metas = [{ repo: WS, github_repo: 'o/AppAgent', prs: [{ number: 1310, url: PR, state: 'merged', title: 'T', body: '', files: [] }] }];
        var api = await setup({ metas: metas, md: mdStub });
        var src = document.createElement('div'); src.setAttribute('data-pr-url', PR); src.setAttribute('data-pr-number', '1310');
        try {
            var ov = api.prModal(src, null);
            assert.ok(ov.querySelector('.wsf-pr-state-merged'), 'MERGED pill');
            // No stored body -> GitHub fetch path (no githubApi here) settles async.
            await new Promise(function(r) { setTimeout(r, 0); });
            assert.strictEqual(ov.querySelector('[data-pane="conv"] .wsf-empty').textContent, 'No description provided.');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
        assert.ok(/>\u22122<\/span><\/div>/.test(api.diffHtml('a\nb\nc\n', 'a\n')) && api.diffHtml('a\nb\nc\n', 'a\n').indexOf('>+0<') < 0, 'removals only');
    }, { tags: ['unit'] });

    test('sidebar PR row (REAL renderPrSidebarItemHtml through the REAL CSP polyfill): row click opens the PR modal; merge click does not; no file list', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var ui = await loadFile('src/js/ui/120-ui-utils.js');
        var a = ui.indexOf('function renderPrSidebarItemHtml('), b = ui.indexOf('\n}\n', a);
        var mergeSrc = ui.slice(ui.indexOf('function mergeSidebarPR('), ui.indexOf('function mergeSidebarPR(') + 400);
        assert.ok(/event\.stopPropagation\(\)|ev\.stopPropagation\(\)|e\.stopPropagation\(\)/.test(mergeSrc), 'mergeSidebarPR stops propagation (never reaches the row)');
        var o = {};
        var api = await setup({ metas: PRMETA, md: mdStub });
        var render = new Function('escapeHtml', 't', 'UI_ICONS', 'wsfOpenPrModal', ui.slice(a, b + 2) + '\nreturn renderPrSidebarItemHtml;')(
            function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); },
            function(s, x) { return x && x.number != null ? s.replace('{number}', x.number) : s; },
            { gitBranch: '', gitMerge: '', spinner: '', close: '', externalLink: '' }, function() {});
        var host = document.createElement('div');
        host.innerHTML = render({ url: PR, number: 1310, title: 'Add thing' }, 'open', { modal: true });
        document.body.appendChild(host);
        var row = host.querySelector('.pr-sidebar-item');
        assert.strictEqual(row.getAttribute('role'), 'button');
        assert.strictEqual(row.getAttribute('tabindex'), '0');
        assert.ok(row.hasAttribute('data-kbd-click'), 'keyboard accessible');
        assert.strictEqual(row.getAttribute('onclick'), 'wsfOpenPrModal(this, event)');
        assert.ok(!host.querySelector('.pr-sidebar-files, .pr-sidebar-caret, a.pr-sidebar-open, [aria-expanded]'), 'no inline file list / caret / extra link');
        var merge = host.querySelector('.pr-sidebar-merge-btn');
        assert.ok(merge, 'merge button stays');
        await polyfill(o, { wsfOpenPrModal: function(el, ev) { o.modal = api.prModal(el, ev); return o.modal; }, mergeSidebarPR: function(ev) { o.merged = true; ev.stopPropagation(); } });
        try {
            // Merge click: its handler stops propagation, so the row handler never runs.
            var ev = { type: 'click', stopPropagation: function() { ev.stopped = true; }, preventDefault: function() {} };
            click(bind(merge), ev);
            assert.ok(o.merged && ev.stopped, 'merge handler ran and stopped the bubble');
            if (!ev.stopped) click(bind(row), ev);
            assert.ok(!o.modal && !document.querySelector('.wsf-overlay'), 'merge click did not open the modal');
            click(bind(row));
            assert.ok(!o.warn, 'polyfill ran the handler without error: ' + (o.warn || ''));
            assert.ok(o.modal && o.modal.classList.contains('wsf-pr-overlay'), 'PR modal opened');
            assert.strictEqual(o.modal.querySelector('.wsf-pr-title').textContent, 'Add <b>thing</b>');
            assert.ok(!document.querySelector('.split-pr-view'), 'no split-pane PR view');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); host.remove(); }
    }, { tags: ['unit'] });

    // --- Modal only (no split pane), stored PR content + silent live check ---
    function ticks(n) { var p = Promise.resolve(); for (var i = 0; i < (n || 8); i++) p = p.then(function() {}); return p; }
    function prSrc() { var s = document.createElement('div'); s.setAttribute('data-pr-url', PR); s.setAttribute('data-pr-number', '1310'); return s; }
    function storedMeta(extra) {
        var pr = { number: 1310, url: PR, state: 'open', title: 'Old title', body: '## Old', branch: 'feat/x', base: 'main', files: [{ path: 'a.js', old_sha: 's1', new_sha: 's2', adds: 3, dels: 1 }, { path: 'n.js', new_sha: 's3', is_new: true, adds: 2, dels: 0 }] };
        Object.keys(extra || {}).forEach(function(k) { pr[k] = extra[k]; });
        return [{ repo: WS, github_repo: 'o/AppAgent', prs: [pr] }];
    }
    function ghRes(o2) { return { ok: true, body: { title: o2.title, body: o2.body, state: o2.state || 'open', merged: !!o2.merged, head: { ref: 'feat/x' }, base: { ref: 'main' } } }; }

    test('modal only: no split-pane PR code path left (082 / 115 / 120)', async function() {
        var s115 = await loadFile('src/js/ui/115-workspace-files-sidebar.js');
        var s120 = await loadFile('src/js/ui/120-ui-utils.js');
        var s082 = await loadFile('src/js/core/082-split-view.js');
        [s115, s120, s082].forEach(function(s, i) {
            assert.ok(!/openSplitPr|closeSplitPr|getSplitPr|_splitPr\b|_splitViewRenderPr\b|wsfRenderPrPane|split-pr-view|wsfOpenPr\(/.test(s), 'no split-pane PR code in file ' + i);
        });
    }, { tags: ['unit'] });

    test('diff-modal PR chip (REAL _wsfPrChipLineHtml through the REAL CSP polyfill): click opens the PR modal, no split pane', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var o = { metas: storedMeta(), md: mdStub };
        var api = await setup(o);
        var host = document.createElement('div');
        host.innerHTML = api.chip({ url: PR, number: 1310 }, 'pushed');
        document.body.appendChild(host);
        try {
            var chip = host.querySelector('.wsf-pr-chip');
            assert.ok(chip, 'chip rendered');
            assert.strictEqual(chip.querySelector('.wsf-pr-chip-title').textContent, 'Old title', 'chip title from stored data');
            await polyfill(o, { wsfOpenPrModal: function(el, ev) { o.modal = api.prModal(el, ev); return o.modal; } });
            click(bind(chip));
            assert.ok(!o.warn, 'polyfill ran the handler without error: ' + (o.warn || ''));
            assert.ok(o.modal && o.modal.classList.contains('wsf-pr-overlay'), 'PR modal opened');
            assert.strictEqual(o.modal.getAttribute('data-pr-url'), PR);
            assert.strictEqual(o.modal.querySelector('.wsf-pr-title').textContent, 'Old title');
            assert.strictEqual(document.querySelectorAll('.wsf-pr-overlay').length, 1, 'one PR modal');
            assert.ok(!document.querySelector('.split-pr-view'), 'no split-pane PR view');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); host.remove(); }
    }, { tags: ['unit'] });

    test('two opens within the live-check TTL make exactly one GitHub request', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var o = { metas: storedMeta(), md: mdStub, gh: 0 };
        o.githubApi = function() { o.gh++; return Promise.resolve(ghRes({ title: 'Old title', body: '## Old' })); };
        var api = await setup(o);
        try {
            api.prModal(prSrc(), null);
            await ticks();
            document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); });
            var ov2 = api.prModal(prSrc(), null);
            assert.ok(ov2 && ov2.classList.contains('wsf-pr-overlay'), 'reopened');
            await ticks();
            assert.strictEqual(o.gh, 1, 'second open within the TTL reuses the live result');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
    }, { tags: ['unit'] });

    test('after a push stores a new title/body, reopening within the TTL shows the NEW title/body (not the cached GitHub fetch)', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var o = { metas: storedMeta(), md: mdStub, gh: 0 };
        var gh = { title: 'Old title', body: '## Old' };
        o.githubApi = function() { o.gh++; return Promise.resolve(ghRes(gh)); };
        var api = await setup(o);
        try {
            var ov = api.prModal(prSrc(), null);
            await ticks();
            assert.strictEqual(o.gh, 1, 'live check cached the GitHub detail');
            assert.strictEqual(ov.querySelector('.wsf-pr-title').textContent, 'Old title');
            document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); });
            // The push stores the new pr_title / pr_body in meta.prs; its
            // workspaceMutated event refreshes the stored infos.
            o.metas = storedMeta({ title: 'Pushed title', body: '## Pushed' });
            gh = { title: 'Pushed title', body: '## Pushed' };
            api.snaps(); await ticks();
            var ov2 = api.prModal(prSrc(), null);
            assert.strictEqual(ov2.querySelector('.wsf-pr-title').textContent, 'Pushed title', 'new stored title shown');
            assert.strictEqual(ov2.querySelector('[data-pane="conv"] .wsf-pr-desc h2').textContent, 'Pushed', 'new stored body shown');
            await ticks();
            assert.strictEqual(o.gh, 2, 'stale live entry dropped: re-checked GitHub');
            assert.strictEqual(ov2.querySelector('.wsf-pr-title').textContent, 'Pushed title', 'still the new title after the live check');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
    }, { tags: ['unit'] });

    test('live check: a renderer that throws stays silent (resolves {changed: []}, no unhandled rejection)', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var o = { metas: storedMeta(), md: function(s) { if (/New/.test(s)) throw new Error('md boom'); return mdStub(s); } };
        o.githubApi = function() { return Promise.resolve(ghRes({ title: 'Old title', body: '## New' })); };
        var unhandled = [];
        function onUnhandled(e) { unhandled.push(e && e.reason); }
        var canListen = typeof window !== 'undefined' && window.addEventListener;
        if (canListen) window.addEventListener('unhandledrejection', onUnhandled);
        var api = await setup(o);
        try {
            var ov = api.prModal(prSrc(), null);
            var res = await api.liveCheck(ov, { url: PR, number: 1310 }, { state: 'open', title: 'Old title', body: '## Old' });
            assert.deepStrictEqual(res, { changed: [] }, 'failure swallowed');
            await new Promise(function(r) { setTimeout(r, 0); });
            assert.deepStrictEqual(unhandled, [], 'no unhandled rejection');
            assert.ok(!o.snacks, 'no user-visible error');
            assert.strictEqual(ov.querySelector('[data-pane="conv"] .wsf-pr-desc h2').textContent, 'Old', 'stored body stays');
        } finally {
            if (canListen) window.removeEventListener('unhandledrejection', onUnhandled);
            document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); });
        }
    }, { tags: ['unit'] });

    test('stored PR data: modal shows title/body/base and +/- counts immediately, no GitHub fetch or blob load before the live check', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var o = { metas: storedMeta(), md: mdStub, gh: 0 };
        o.githubApi = function() { o.gh++; return Promise.resolve(ghRes({ title: 'Old title', body: '## Old' })); };
        var api = await setup(o);
        var blobsBefore = o.blobCalls || 0;
        try {
            var ov = api.prModal(prSrc(), null);
            assert.strictEqual(o.gh, 0, 'no GitHub request while rendering');
            assert.strictEqual(ov.querySelector('.wsf-pr-title').textContent, 'Old title');
            assert.strictEqual(ov.querySelector('[data-pane="conv"] .wsf-pr-desc h2').textContent, 'Old', 'stored body rendered, no loading state');
            assert.ok(/main/.test(ov.querySelector('.wsf-pr-branches').textContent), 'stored base branch');
            var counts = ov.querySelectorAll('[data-pane="files"] .wsf-counts');
            assert.strictEqual(counts[0].textContent, '+3\u22121', 'stored counts, modified');
            assert.strictEqual(counts[1].textContent, '+2', 'stored counts, new file');
            assert.strictEqual(o.blobCalls || 0, blobsBefore, 'no blob read for counts');
            await ticks();
            assert.strictEqual(o.gh, 1, 'exactly one (silent) live check afterwards');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
    }, { tags: ['unit'] });

    test('legacy PR without a stored body still fetches the description from GitHub', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var metas = storedMeta(); delete metas[0].prs[0].body;
        var o = { metas: metas, md: mdStub, gh: 0 };
        o.githubApi = function() { o.gh++; return Promise.resolve(ghRes({ title: 'Old title', body: '## Fetched' })); };
        var api = await setup(o);
        try {
            var ov = api.prModal(prSrc(), null);
            assert.strictEqual(ov.querySelector('[data-pane="conv"] .wsf-empty').textContent, 'Loading...', 'visible loading state');
            await ticks();
            assert.strictEqual(o.gh, 1, 'fetched once');
            assert.strictEqual(ov.querySelector('[data-pane="conv"] .wsf-pr-desc h2').textContent, 'Fetched');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
    }, { tags: ['unit'] });

    test('live check patches changed state/title/body in place, keeps the expanded diff + active tab, persists title/body', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var release;
        var o = { metas: storedMeta(), md: mdStub, blobs: { s1: 'a\n', s2: 'a\nA\n', s3: 'n\n' } };
        o.githubApi = function() { return new Promise(function(r) { release = r; }); };
        var api = await setup(o);
        try {
            var ov = api.prModal(prSrc(), null);
            api.prTab(ov.querySelector('.wsf-pr-tab[data-tab="files"]'), 'files');
            var head = ov.querySelector('.wsf-pr-file-head');
            assert.strictEqual(await api.toggleFile(head, 0), true, 'diff expanded');
            var diffNode = head.parentNode.querySelector('.wsf-pr-file-body .diff-line');
            assert.ok(diffNode, 'diff rendered');
            await ticks();
            release(ghRes({ title: 'New title', body: '## New', merged: true, state: 'closed' }));
            await ticks();
            assert.ok(ov.querySelector('.wsf-pr-head .wsf-pr-state-merged') && !ov.querySelector('.wsf-pr-state-open'), 'state badge patched');
            assert.strictEqual(ov.querySelector('.wsf-pr-title').textContent, 'New title', 'title patched');
            assert.strictEqual(ov.querySelector('[data-pane="conv"] .wsf-pr-desc h2').textContent, 'New', 'body patched');
            assert.strictEqual(ov.querySelector('.wsf-pr-file-head'), head, 'files not re-rendered');
            assert.strictEqual(head.getAttribute('aria-expanded'), 'true', 'diff still expanded');
            assert.ok(diffNode.isConnected !== false && head.parentNode.contains(diffNode), 'same diff DOM kept');
            assert.strictEqual(ov.querySelector('.wsf-pr-tab.active').getAttribute('data-tab'), 'files', 'active tab kept');
            assert.ok(ov.querySelector('[data-pane="conv"]').hidden, 'conversation pane stays hidden');
            await ticks();
            var p = (o.patched || []).filter(function(x) { return x.saved; })[0];
            assert.ok(p, 'meta patched');
            assert.strictEqual(p.cur.prs[0].title, 'New title');
            assert.strictEqual(p.cur.prs[0].body, '## New');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
    }, { tags: ['unit'] });

    test('live check: identical response changes nothing; failures (reject / !ok) are silent', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var cases = [
            function() { return Promise.resolve(ghRes({ title: 'Old title', body: '## Old' })); },
            function() { return Promise.reject(new Error('offline')); },
            function() { return Promise.resolve({ ok: false, status: 404 }); }
        ];
        for (var i = 0; i < cases.length; i++) {
            var o = { metas: storedMeta(), md: mdStub, githubApi: cases[i] };
            var api = await setup(o);
            try {
                var ov = api.prModal(prSrc(), null);
                var before = ov.innerHTML;
                await ticks(12);
                assert.strictEqual(ov.innerHTML, before, 'no DOM change (case ' + i + ')');
                assert.ok(!(o.patched || []).some(function(x) { return x.saved; }), 'nothing persisted (case ' + i + ')');
                assert.ok(!o.snacks, 'no user-visible error (case ' + i + ')');
            } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
        }
    }, { tags: ['unit'] });

    test('inline diff spinner appears only after 300 ms (none for a fast diff)', async function() {
        if (typeof document === 'undefined' || !document.createElement) return skipTest('no DOM');
        var release, timers = [];
        var o = { metas: storedMeta(), md: mdStub, setTimeout: function(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; } };
        o.blobHook = function() { return new Promise(function(r) { release = r; }); };
        var api = await setup(o);
        assert.strictEqual(api.spinnerMs, 300);
        try {
            var ov = api.prModal(prSrc(), null);
            var heads = ov.querySelectorAll('.wsf-pr-file-head');
            var body = heads[0].parentNode.querySelector('.wsf-pr-file-body');
            timers.length = 0;
            var pending = api.toggleFile(heads[0], 0);
            await ticks(2);
            assert.ok(body.textContent.indexOf('Loading') < 0, 'no spinner right away');
            var spin = timers.filter(function(x) { return x.ms === 300; })[0];
            assert.ok(spin, 'spinner scheduled at 300 ms');
            spin.fn();
            assert.strictEqual(body.textContent, 'Loading...', 'spinner after 300 ms while still pending');
            release({ s1: 'a\n', s2: 'a\nA\n' });
            assert.strictEqual(await pending, true);
            assert.ok(body.querySelector('.diff-line'), 'diff replaces the spinner');
            // Fast diff: settles before the timer fires -> the late timer is a no-op.
            o.blobHook = null; o.blobs = { s3: 'n\n' }; timers.length = 0;
            var body2 = heads[1].parentNode.querySelector('.wsf-pr-file-body');
            assert.strictEqual(await api.toggleFile(heads[1], 1), true);
            var spin2 = timers.filter(function(x) { return x.ms === 300; })[0];
            assert.ok(spin2, 'timer scheduled');
            spin2.fn();
            assert.ok(body2.querySelector('.diff-line') && body2.textContent.indexOf('Loading') < 0, 'no spinner flash after a fast diff');
        } finally { document.querySelectorAll('.wsf-overlay').forEach(function(x) { x.remove(); }); }
    }, { tags: ['unit'] });

    test('wsPush stores +/- counts per PR file (_wsPrFileLineCounts): edit, new, deleted; > 200 KB gets none', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var a = src.indexOf('var WS_PR_COUNT_MAX_CHARS'), b = src.indexOf('\n}\n', src.indexOf('function _wsPrFileLineCounts('));
        assert.ok(a > 0 && b > a, 'helper found');
        var cnt = new Function(src.slice(a, b + 2) + '\nreturn { f: _wsPrFileLineCounts, max: WS_PR_COUNT_MAX_CHARS };')();
        assert.strictEqual(cnt.max, 200000);
        assert.deepStrictEqual(cnt.f('a\nb\nc\n', 'a\nB\nc\nd\n'), { adds: 2, dels: 1 }, 'small edit');
        assert.deepStrictEqual(cnt.f(null, 'x\ny\n'), { adds: 2, dels: 0 }, 'new file');
        assert.deepStrictEqual(cnt.f('p\nq\nr\n', ''), { adds: 0, dels: 3 }, 'deleted file');
        var big = new Array(cnt.max + 2).join('x');
        assert.strictEqual(cnt.f(big, 'y'), null, 'old side over 200 KB');
        assert.strictEqual(cnt.f('y', big), null, 'new side over 200 KB');
        assert.ok(/_wsPrFileLineCounts\(dirtyFiles\[k\]\.original_content, dirtyFiles\[k\]\.deleted \? '' : dirtyFiles\[k\]\.content\)/.test(src), 'wsPush counts each pushed file');
        assert.ok(/_pfEntry\.adds = _pfCounts\.adds; _pfEntry\.dels = _pfCounts\.dels;/.test(src), 'counts stored on the PR file entry');
    }, { tags: ['unit'] });

    test('a refresh requested while metas load is re-run, not dropped', async function() {
        var release, o = { metas: [] };
        var api = await setup(o);
        var before = o.metaCalls;
        o.metaHook = function() { o.metaHook = null; return new Promise(function(r) { release = function() { r([]); }; }); };
        api.snaps(); api.snaps();
        release();
        for (var i = 0; i < 6; i++) await Promise.resolve();
        assert.strictEqual(o.metaCalls, before + 2, 'second request ran after the first load');
    }, { tags: ['unit'] });
});
