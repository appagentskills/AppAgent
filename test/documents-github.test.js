// Documents page: connect GitHub repositories (tools/110-smart-documents.js).
// Connect card mode switch, repo picker (list / filter / typed owner/repo /
// no-token link), clone + replace-confirm, repo card Refresh / Remove, on-demand
// stub preview, active card scroll-into-view and the file count. Real module
// functions + real inline handlers (U.fireInline) on the rendered markup; only
// the network (githubApi, wsClone, wsReadRaw) and storage/modal boundaries are stubbed.

describe('documents page: GitHub repositories', function() {
    var MODS = ['src/js/core/060-ui-constants.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/320-keyboard-shortcuts.js', 'src/js/tools/110-smart-documents.js'];
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    var REPOS = [
        { full_name: 'octo/alpha', private: false, default_branch: 'main', description: 'A' },
        { full_name: 'octo/beta', private: true, default_branch: 'develop', description: 'B' },
        { full_name: 'acme/gamma', private: false, default_branch: 'main' }
    ];

    // o: { repos: githubApi /user/repos result, metas, clone: wsClone result, confirmReplace, confirm, read: wsReadRaw result, repoInfo, globals: extra stubs }
    async function load(o) {
        o = o || {};
        var WS = args.workspace;
        var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
        var rec = { api: [], clones: [], replace: [], deletes: [], reclones: [], confirms: [], reads: [], settings: [], snacks: [], overlays: [] };
        var metas = (o.metas || []).slice();
        var m = await U.loadUi(MODS, { globals: Object.assign({
            chats: {}, currentChatId: 'c1', currentView: 'documents', LOCAL_FOLDER_VIRTUAL_ID: 'virtual',
            escDisplay: esc, escapeHtml: esc,
            showSnackbar: function(msg, kind) { rec.snacks.push([kind, msg]); },
            listLocalFolders: async function() { return [{ id: 'virtual', kind: 'virtual', label: 'Agent Files', name: 'agent-files', access: 'readwrite', permission: 'granted' }]; },
            pickLocalFolder: function() { return Promise.resolve(null); },
            getAllWorkspaceMetas: async function() { return metas.map(function(x) { return Object.assign({}, x); }); },
            githubApi: async function(method, path) {
                rec.api.push([method, path]);
                if (/^\/user\/repos/.test(path)) return o.repoPages ? o.repoPages(path) : o.repos || { ok: true, status: 200, body: REPOS };
                return typeof o.repoInfo === 'function' ? o.repoInfo(path) : o.repoInfo || { ok: true, status: 200, body: {} };
            },
            wsClone: async function(repo, branch) {
                rec.clones.push([repo, branch]);
                var r = o.clone || { success: true, message: 'ok' };
                if (r.success) metas.push({ repo: repo + '::' + (branch || 'main'), branch: branch || 'main' });
                return r;
            },
            _confirmReplaceExistingClone: async function(repo, branch) { rec.replace.push([repo, branch]); return o.confirmReplace !== false; },
            deleteGitHubRepo: async function(wk) { rec.deletes.push(wk); metas = metas.filter(function(x) { return x.repo !== wk; }); return { success: true }; },
            showConfirmModal: async function(title, msg, kind) { rec.confirms.push([title, msg, kind]); if (o.confirmThrow) throw new Error(o.confirmThrow); return o.confirm !== false; },
            _recloneWorkspaceFromDropdown: async function(repo, branch) { rec.reclones.push([repo, branch]); if (o.reclone) await o.reclone(); },
            openSettingsPageView: function(id) { rec.settings.push(id); },
            getWorkspaceFile: async function(wk, path) { return { path: path, stub: true, content: null }; },
            wsReadRaw: async function(wk, path) { rec.reads.push([wk, path]); var r = o.read || { success: true, file: { content: 'hello <world>' } }; return typeof r === 'function' ? r() : r; },
            _wsfOverlay: function(title, body) { var d = document.createElement('div'); d.className = 'test-overlay'; d.innerHTML = body; document.body.appendChild(d); rec.overlays.push(d); return d; }
        }, o.globals || {}), allowUnstubbed: o.allowUnstubbed });
        // Rail layout: the sources rail (with the "Add source" popover) + the pane head (repo actions).
        var mount = await U.mountDom({ html: '<div id="documents-list" class="sdoc-rail-layout"><nav class="sdoc-rail" id="documents-sources"></nav>' +
            '<div class="sdoc-pane" id="sdoc-pane"><div class="sdoc-pane-head" id="sdoc-pane-head"></div><span id="documents-count"></span><div id="documents-items"></div></div></div>' });
        await m.sdocRefreshSources();
        // Most tests drive the connect form: open the "Add source" popover (o.closed keeps it shut).
        if (!o.closed) { m.sdocSrcState.addOpen = true; m.sdocRenderSourcesStrip(); }
        return { m: m, U: U, rec: rec, mount: mount };
    }
    // The "Add source" modal is mounted on <body> (#sdoc-add-modal), outside #documents-list.
    function q(sel) { return document.querySelector('#documents-list ' + sel) || document.querySelector('#sdoc-add-modal ' + sel); }
    function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll('#documents-list ' + sel)).concat(Array.prototype.slice.call(document.querySelectorAll('#sdoc-add-modal ' + sel))); }
    async function settle(U) { await U.flush(); await U.flush(); await U.flush(); }
    async function toGithub(e) {
        e.U.fireInline(q('.sdoc-conn-mode .radio-option[data-value="github"]'), 'click', e.m);
        await settle(e.U);
    }
    function type(e, el, v) { el.value = v; e.U.fireInline(el, 'input', e.m); }
    function done(e) { document.querySelectorAll('.test-overlay, #sdoc-add-modal').forEach(function(d) { d.remove(); }); return e.U.cleanupAll(); }
    // The sandbox's focus() does not move activeElement (ui-helpers.js): pin it by hand.
    function stubFocus() {
        var cur = null;
        Object.defineProperty(document, 'activeElement', { configurable: true, get: function() { return cur || document.body; } });
        return { set: function(el) { cur = el; }, restore: function() { delete document.activeElement; } };
    }
    // Browser model of a mousedown outside the input: unless default-prevented, focus leaves the input (blur).
    function mouseDown(e, foc, el, inp) {
        var r = e.U.fireInline(el, 'mousedown', e.m);
        if (!r.prevented) { foc.set(null); e.U.fireInline(inp, 'blur', e.m); }
        return r;
    }

    test('Add source opens a modal on <body> with dialog semantics and source cards', async function() {
        var e = await load({ closed: true });
        try {
            assert.ok(!document.getElementById('sdoc-add-modal'), 'closed: no overlay');
            e.U.fireInline(q('.sdoc-rail-add'), 'click', e.m);
            await settle(e.U);
            var ov = document.getElementById('sdoc-add-modal');
            assert.ok(ov && ov.parentNode === document.body, 'overlay mounted on body');
            assert.ok(ov.classList.contains('modal-overlay') && ov.classList.contains('show'));
            assert.ok(!document.querySelector('#documents-list #sdoc-add-pop'), 'no popover left inside the rail');
            var dlg = ov.querySelector('#sdoc-add-pop');
            assert.strictEqual(dlg.getAttribute('role'), 'dialog');
            assert.strictEqual(dlg.getAttribute('aria-modal'), 'true');
            assert.strictEqual(dlg.getAttribute('aria-labelledby'), 'sdoc-add-title');
            assert.ok(document.getElementById('sdoc-add-title'));
            assert.strictEqual(q('.sdoc-rail-add').getAttribute('aria-expanded'), 'true');
            var cards = qa('.sdoc-add-card').map(function(c) { return c.getAttribute('data-card'); });
            assert.deepStrictEqual(cards, ['read', 'readwrite', 'github', 'files']);
            qa('.sdoc-add-card').forEach(function(c) {
                assert.ok(c.querySelector('.sdoc-type-tile') && c.querySelector('.sdoc-add-card-title') && c.querySelector('.sdoc-add-card-desc') && c.querySelector('.sdoc-add-card-btn'), 'card parts: ' + c.getAttribute('data-card'));
            });
            assert.ok(q('.sdoc-add-card[data-card="files"] .sdoc-add-card-status'), 'Agent Files marked connected');
            assert.ok(!q('.sdoc-add-card[data-card="read"] .sdoc-add-card-status'), 'no read-only folder connected yet');
            assert.ok(q('#sdoc-add-pop .sdoc-add-foot [data-fk="add:cancel"]'), 'cancel kept');
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('Add source modal: Cancel and backdrop close and remove the overlay', async function() {
        var e = await load();
        try {
            assert.ok(document.getElementById('sdoc-add-modal'));
            e.U.fireInline(q('[data-fk="add:cancel"]'), 'click', e.m);
            assert.strictEqual(e.m.sdocSrcState.addOpen, false);
            assert.ok(!document.getElementById('sdoc-add-modal'), 'cancel removes the overlay');
            assert.strictEqual(q('.sdoc-rail-add').getAttribute('aria-expanded'), 'false');
            e.m.sdocAddToggle();
            var ov = document.getElementById('sdoc-add-modal');
            ov.onclick({ target: ov.querySelector('#sdoc-add-pop') });
            assert.ok(document.getElementById('sdoc-add-modal'), 'a click inside the dialog keeps it open');
            ov.onclick({ target: ov });
            assert.ok(!document.getElementById('sdoc-add-modal'), 'backdrop click (and the global Esc replay) closes');
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('Add source modal: failed folder connect shows an inline error, busy while picking', async function() {
        var rej;
        var e = await load({ globals: { pickLocalFolder: function() { return new Promise(function(res, r) { rej = r; }); } } });
        try {
            e.U.fireInline(q('.sdoc-add-card[data-card="readwrite"] .sdoc-add-card-btn'), 'click', e.m);
            assert.strictEqual(e.m.sdocSrcState.addAccess, 'readwrite');
            assert.strictEqual(q('.sdoc-add-card[data-card="readwrite"] .sdoc-add-card-btn').getAttribute('aria-busy'), 'true', 'busy while the picker is open');
            rej(new Error('nope'));
            await settle(e.U);
            var err = q('#sdoc-add-pop .sdoc-add-err');
            assert.ok(err && err.getAttribute('role') === 'alert' && /nope/.test(err.textContent), 'inline error');
            assert.ok(!q('.sdoc-add-card-btn[aria-busy]'), 'busy cleared');
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('sdocFocusTrapIndex wraps Tab / Shift+Tab at the dialog edges', async function() {
        var e = await load({ closed: true });
        try {
            var f = e.m.sdocFocusTrapIndex;
            assert.strictEqual(f(0, -1, false), -1, 'nothing focusable');
            assert.strictEqual(f(3, 2, false), 0, 'Tab on last wraps to first');
            assert.strictEqual(f(3, 0, true), 2, 'Shift+Tab on first wraps to last');
            assert.strictEqual(f(3, 1, false), -1, 'middle: browser default');
            assert.strictEqual(f(3, 1, true), -1);
            assert.strictEqual(f(3, -1, false), 0, 'focus outside: pull in to first');
            assert.strictEqual(f(3, -1, true), 2, 'focus outside + shift: last');
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('Connect card switches Local folder / GitHub repo', async function() {
        var e = await load();
        try {
            var modes = qa('.sdoc-conn-mode .radio-option').map(function(o) { return o.getAttribute('data-value') + ':' + o.getAttribute('aria-checked'); });
            assert.deepStrictEqual(modes, ['folder:true', 'github:false']);
            assert.ok(q('#sdoc-add-pop .sdoc-access-radio[data-folder-id=""]'), 'folder mode shows the access picker');
            assert.ok(!q('.sdoc-gh-repo'));
            await toGithub(e);
            assert.strictEqual(e.m.sdocSrcState.addMode, 'github');
            assert.ok(q('#sdoc-add-pop .sdoc-gh-repo') && q('.sdoc-gh-branch'), 'repo + branch inputs');
            assert.ok(!q('.sdoc-access-radio[data-folder-id=""]'), 'no folder access picker in GitHub mode');
            assert.strictEqual(q('.sdoc-conn-mode .radio-option[data-value="github"]').getAttribute('aria-checked'), 'true');
            e.U.fireInline(q('.sdoc-conn-mode .radio-option[data-value="folder"]'), 'click', e.m);
            assert.ok(q('.sdoc-access-radio[data-folder-id=""]') && !q('.sdoc-gh-repo'));
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('picker lists /user/repos once, filters on typing, typed owner/repo still offered', async function() {
        var e = await load();
        try {
            await toGithub(e);
            assert.deepStrictEqual(e.rec.api, [['GET', '/user/repos?per_page=100&sort=updated']]);
            var names = qa('.sdoc-gh-opt').map(function(b) { return b.getAttribute('data-full'); });
            assert.deepStrictEqual(names, ['octo/alpha', 'octo/beta', 'acme/gamma']);
            assert.ok(qa('.sdoc-gh-opt')[1].querySelector('.sdoc-gh-opt-priv'), 'private badge');
            var inp = q('.sdoc-gh-repo');
            type(e, inp, 'OCTO');
            assert.deepStrictEqual(qa('.sdoc-gh-opt').map(function(b) { return b.getAttribute('data-full'); }), ['octo/alpha', 'octo/beta']);
            assert.strictEqual(q('.sdoc-gh-repo'), inp, 'typing does not rebuild the input');
            type(e, inp, 'someone/else');
            assert.strictEqual(qa('.sdoc-gh-opt').length, 0);
            assert.ok(/someone\/else/.test(q('#sdoc-gh-pop .sdoc-gh-hint').textContent), 'typed repo named in the empty state (in the popup)');
            assert.strictEqual(q('.sdoc-gh-note').textContent, '', 'the in-card note stays empty');
            // Cached for the page session: back to folder and to GitHub again, no refetch.
            e.U.fireInline(q('.sdoc-conn-mode .radio-option[data-value="folder"]'), 'click', e.m);
            await toGithub(e);
            assert.strictEqual(e.rec.api.length, 1);
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('no token: "Add a GitHub token in Settings" opens Settings > GitHub', async function() {
        var e = await load({ repos: { error: 'No GitHub token configured' } });
        try {
            await toGithub(e);
            var link = q('.sdoc-gh-note .sdoc-gh-link');
            assert.ok(link, 'settings link shown');
            assert.ok(/GitHub token/.test(link.textContent));
            e.U.fireInline(link, 'click', e.m);
            assert.deepStrictEqual(e.rec.settings, ['github-settings-container']);
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('layout: the "Add source" popover is a dialog; listbox + hint share #sdoc-gh-pop inside .sdoc-gh-combo (CSS-placed)', async function() {
        var e = await load({ repos: new Promise(function() {}) });
        try {
            var dlg = q('#sdoc-add-pop');
            assert.ok(dlg && dlg.getAttribute('role') === 'dialog' && dlg.getAttribute('aria-labelledby') === 'sdoc-add-title', 'popover is a labelled dialog');
            assert.strictEqual(q('#sdoc-add-title').textContent, 'Add source');
            assert.strictEqual(q('.sdoc-rail-add').getAttribute('aria-expanded'), 'true');
            assert.ok(document.getElementById('sdoc-add-modal').contains(dlg) && !q('#documents-sources').contains(dlg), 'mounted in the body modal, not the rail');
            await toGithub(e);
            var combo = q('#sdoc-add-pop .sdoc-gh-combo'), pop = q('#sdoc-gh-pop'), inp = q('.sdoc-gh-repo');
            assert.ok(combo && combo.contains(inp) && combo.contains(pop), 'input + popup share .sdoc-gh-combo');
            assert.ok(!combo.contains(q('.sdoc-gh-branch')) && !combo.contains(q('#sdoc-gh-note')), 'the combo closes right after the popup');
            assert.ok(!/NaN/.test(q('#sdoc-add-pop').textContent), 'no stray text in the popover');
            assert.ok(pop.contains(q('#sdoc-gh-list')) && pop.contains(q('#sdoc-gh-hint')), 'listbox + hint in the popup');
            assert.ok(!pop.contains(q('#sdoc-gh-note')), 'actionable note stays in the popover body');
            assert.ok(pop.hidden, 'closed: popup hidden (no loading note in the form)');
            assert.strictEqual(q('.sdoc-gh-note').textContent, '');
            type(e, inp, 'oc');
            assert.ok(!pop.hidden && /Loading your repositories/.test(q('#sdoc-gh-hint').textContent), 'loading hint in the open popup');
            assert.deepStrictEqual([pop.style.top, pop.style.left, pop.style.width], ['', '', ''], 'placed by CSS (top:100% under the input), no inline geometry');
            assert.ok(e.U.fireInline(pop, 'mousedown', e.m).prevented, 'a press in the popup keeps focus in the input');
            var k = { key: 'Escape', target: inp, preventDefault: function() {}, stopPropagation: function() {} };
            e.m.sdocGhRepoKeydown(k);
            assert.ok(pop.hidden, 'Escape closes the popup (loading hint, no options)');
            assert.strictEqual(inp.value, 'oc', 'first Escape only closes');
            assert.ok(q('#sdoc-add-pop'), 'the combobox Escape does not close the popover');
            assert.deepStrictEqual(qa('#sdoc-add-pop .sdoc-add-foot [data-fk]').map(function(b) { return b.getAttribute('data-fk'); }), ['add:cancel', 'connect-gh'], 'footer: Cancel + Clone repo');
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('popover reserves no room for empty parts: folder mode is title, mode, access, hint, footer; the empty GitHub note is [hidden]', async function() {
        var e = await load({ repos: new Promise(function() {}) });
        try {
            var dlg = q('#sdoc-add-pop');
            assert.ok(dlg.querySelector('.sdoc-add-head #sdoc-add-title'), 'title in the modal header');
            var kids = Array.prototype.map.call(dlg.querySelector('.sdoc-add-details').children, function(c) {
                var cl = c.classList;
                return c.id === 'sdoc-add-opts' ? 'title' : cl.contains('sdoc-conn-mode') ? 'mode' : cl.contains('sdoc-add-label') ? 'label' : cl.contains('sdoc-access-radio') ? 'access' : cl.contains('sdoc-add-hint') ? 'hint' : cl.contains('sdoc-add-foot') ? 'foot' : c.className;
            });
            assert.deepStrictEqual(kids, ['title', 'mode', 'label', 'access', 'hint', 'foot'], 'nothing in between');
            assert.deepStrictEqual(qa('#sdoc-add-pop .sdoc-add-foot [data-fk]').map(function(b) { return b.getAttribute('data-fk'); }), ['add:cancel', 'connect'], 'footer: Cancel + Choose folder');
            assert.ok(/next step/.test(q('.sdoc-add-hint').textContent));
            await toGithub(e);
            var note = q('#sdoc-gh-note');
            assert.ok(note && note.hidden, 'empty note rendered hidden');
            assert.strictEqual(note.innerHTML, '');
        } finally { await done(e); }
        var e2 = await load({ repos: { error: 'No GitHub token configured' } });
        try {
            await toGithub(e2);
            var n2 = q('#sdoc-gh-note');
            assert.ok(!n2.hidden && n2.querySelector('.sdoc-gh-link'), 'a note with content is shown');
            e2.m.sdocGhState.noToken = false; e2.m.sdocGhState.error = null;
            e2.m._sdocGhRefreshList();
            assert.ok(n2.hidden && n2.innerHTML === '', 'partial update hides the note once it is empty again');
        } finally { await done(e2); }
    }, { tags: ['unit'] });

    test('GitHub mode: + opens the popover and loads the repo list once; Cancel closes it; reopen uses the cache', async function() {
        var e = await load({ closed: true });
        try {
            assert.ok(!q('#sdoc-add-pop') && !q('.sdoc-gh-repo'), 'closed: no form rendered');
            assert.strictEqual(q('.sdoc-rail-add').getAttribute('aria-expanded'), 'false');
            assert.deepStrictEqual(e.rec.api, [], 'nothing fetched while closed');
            e.m.sdocSrcState.addMode = 'github';
            e.U.fireInline(q('.sdoc-rail-add'), 'click', e.m);
            await settle(e.U);
            assert.ok(q('#sdoc-add-pop .sdoc-gh-repo'), 'repo picker in the popover');
            assert.strictEqual(q('.sdoc-rail-add').getAttribute('aria-expanded'), 'true');
            assert.deepStrictEqual(e.rec.api, [['GET', '/user/repos?per_page=100&sort=updated']]);
            e.U.fireInline(q('#sdoc-add-pop [data-fk="add:cancel"]'), 'click', e.m);
            assert.ok(!q('#sdoc-add-pop'), 'Cancel closes');
            assert.strictEqual(e.m.sdocSrcState.addOpen, false);
            e.U.fireInline(q('.sdoc-rail-add'), 'click', e.m);
            await settle(e.U);
            assert.ok(q('#sdoc-add-pop'));
            assert.strictEqual(e.rec.api.length, 1, 'cached for the page session');
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('pick + Connect clones with the default branch; typed repo + branch passed through', async function() {
        var e = await load();
        try {
            await toGithub(e);
            e.U.fireInline(qa('.sdoc-gh-opt')[1], 'click', e.m);
            assert.strictEqual(q('.sdoc-gh-repo').value, 'octo/beta');
            await e.U.fireInline(q('[data-fk="connect-gh"]'), 'click', e.m);
            await settle(e.U);
            assert.deepStrictEqual(e.rec.replace, [['octo/beta', 'develop']]);
            assert.deepStrictEqual(e.rec.clones, [['octo/beta', 'develop']]);
            assert.ok(document.querySelector('.sdoc-rail-group[aria-labelledby="sdoc-rail-g-ws"] .sdoc-rail-item[data-src-id="ws:octo/beta::develop"]'), 'new repo in the GitHub rail group');
            assert.ok(!q('#sdoc-add-pop') && e.m.sdocSrcState.addOpen === false, 'a successful clone closes the popover');
            assert.ok(e.rec.snacks.some(function(s) { return s[0] === 'success'; }));
            // Typed owner/repo, explicit branch, blank branch -> undefined (wsClone default).
            e.m.sdocGhState.query = 'https://github.com/x/y.git'; e.m.sdocGhState.branch = ' dev ';
            await e.m.sdocSrcConnectRepo();
            assert.deepStrictEqual(e.rec.clones[1], ['x/y', 'dev']);
            e.m.sdocGhState.query = 'x/z'; e.m.sdocGhState.branch = '';
            await e.m.sdocSrcConnectRepo();
            assert.deepStrictEqual(e.rec.clones[2], ['x/z', undefined]);
            e.m.sdocGhState.query = 'nope';
            await e.m.sdocSrcConnectRepo();
            assert.strictEqual(e.rec.clones.length, 3, 'bad format never clones');
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('replace-confirm cancelled: nothing is cloned', async function() {
        var e = await load({ confirmReplace: false });
        try {
            await toGithub(e);
            e.m.sdocGhState.query = 'octo/alpha';
            await e.m.sdocSrcConnectRepo();
            assert.deepStrictEqual(e.rec.replace, [['octo/alpha', 'main']]);
            assert.deepStrictEqual(e.rec.clones, []);
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('clone errors map to clear messages (404/private, branch, truncated, rate limit, no token)', async function() {
        var cases = [
            [{ success: false, error: 'Branch "main" not found. HTTP 404' }, { ok: false, status: 404 }, /not found\. Check the name/],
            [{ success: false, error: 'Branch "dev" not found. HTTP 404' }, { ok: true, status: 200 }, /Branch dev not found in octo\/alpha/],
            [{ success: false, error: 'GitHub truncated the recursive tree for octo/alpha (main)' }, null, /too many files/],
            [{ success: false, error: 'Failed to fetch tree: HTTP 403' }, null, /rate limit/]
        ];
        for (var i = 0; i < cases.length; i++) {
            var e = await load({ clone: cases[i][0], repoInfo: cases[i][1] });
            try {
                await toGithub(e);
                e.m.sdocGhState.query = 'octo/alpha';
                await e.m.sdocSrcConnectRepo();
                assert.ok(cases[i][2].test(q('#sdoc-gh-status').textContent), i + ': ' + q('#sdoc-gh-status').textContent);
            } finally { await done(e); }
        }
        var e2 = await load({ clone: { success: false, error: 'GitHub not connected. Go to Settings > GitHub to add a token.' } });
        try {
            await toGithub(e2);
            e2.m.sdocGhState.query = 'octo/alpha';
            await e2.m.sdocSrcConnectRepo();
            assert.ok(q('#sdoc-gh-status .sdoc-gh-link'), 'no-token link in the status');
        } finally { await done(e2); }
    }, { tags: ['unit'] });

    test('repo card: Refresh re-clones, Remove deletes only after confirm', async function() {
        var metas = [{ repo: 'octo/alpha::main', branch: 'main' }];
        var e = await load({ metas: metas });
        try {
            var item = document.querySelector('.sdoc-rail-item[data-src-id="ws:octo/alpha::main"]');
            assert.ok(item);
            assert.strictEqual(q('#sdoc-pane-head [data-fk^="wsref:"]'), null, 'no repo actions until the repo is selected');
            e.U.fireInline(item, 'click', e.m);
            assert.strictEqual(q('#sdoc-pane-head .sdoc-pane-title').textContent, item.querySelector('.sdoc-rail-name').textContent, 'pane head shows the repo');
            assert.ok(/Remove clone/.test(q('#sdoc-pane-head [data-fk="wsrm:ws:octo/alpha::main"]').getAttribute('aria-label') || q('#sdoc-pane-head [data-fk="wsrm:ws:octo/alpha::main"]').getAttribute('title') || ''), 'Remove clone label');
            await e.U.fireInline(q('#sdoc-pane-head [data-fk="wsref:ws:octo/alpha::main"]'), 'click', e.m);
            await settle(e.U);
            assert.deepStrictEqual(e.rec.reclones, [['octo/alpha', 'main']]);
            await e.U.fireInline(q('#sdoc-pane-head [data-fk="wsrm:ws:octo/alpha::main"]'), 'click', e.m);
            await settle(e.U);
            assert.strictEqual(e.rec.confirms.length, 1);
            assert.strictEqual(e.rec.confirms[0][2], 'danger');
            assert.deepStrictEqual(e.rec.deletes, ['octo/alpha::main']);
            assert.ok(!document.querySelector('.sdoc-rail-item[data-src-id="ws:octo/alpha::main"]'), 'rail item gone');
            assert.strictEqual(e.m.sdocSrcState.sel, 'all', 'selection falls back to All sources');
        } finally { await done(e); }
        var e2 = await load({ metas: metas, confirm: false });
        try {
            await e2.m.sdocWsRemove('octo/alpha::main');
            assert.strictEqual(e2.rec.confirms.length, 1);
            assert.deepStrictEqual(e2.rec.deletes, [], 'cancel does nothing');
            assert.ok(document.querySelector('.sdoc-rail-item[data-src-id="ws:octo/alpha::main"]'));
        } finally { await done(e2); }
    }, { tags: ['unit'] });

    test('stub preview loads on demand; error shows Retry', async function() {
        var e = await load({ metas: [{ repo: 'octo/alpha::main', branch: 'main' }] });
        try {
            var src = e.m.sdocSrcById('ws:octo/alpha::main');
            var ov = await e.m.sdocPreviewFile(src, 'README.md');
            assert.deepStrictEqual(e.rec.reads, [['octo/alpha::main', 'README.md']]);
            assert.strictEqual(ov.querySelector('pre.wsf-code').textContent, 'hello <world>');
        } finally { await done(e); }
        var fail = true;
        var e2 = await load({ metas: [{ repo: 'octo/alpha::main', branch: 'main' }],
            read: function() { return fail ? { success: false, error: 'Failed to fetch file content from GitHub: README.md (HTTP 500)' } : { success: true, file: { content: 'ok now' } }; } });
        try {
            var ov2 = await e2.m.sdocPreviewFile(e2.m.sdocSrcById('ws:octo/alpha::main'), 'README.md');
            var err = ov2.querySelector('.sdoc-ws-load-err');
            assert.ok(err && /Could not load README\.md/.test(err.textContent), 'error state');
            fail = false;
            await e2.U.fireInline(err.querySelector('[data-fk="wsretry"]'), 'click', e2.m);
            await settle(e2.U);
            assert.strictEqual(ov2.querySelector('pre.wsf-code').textContent, 'ok now');
            assert.strictEqual(e2.rec.reads.length, 2);
        } finally { await done(e2); }
    }, { tags: ['unit'] });

    function kd(fn, el, k) { var ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); Object.defineProperty(ev, 'target', { value: el }); fn(ev); return ev; }

    test('repo combobox: listbox roles, arrow/Home/End/Enter/Escape keys, branch Enter connects', async function() {
        var e = await load();
        try {
            await toGithub(e);
            var inp = q('.sdoc-gh-repo'), list = q('#sdoc-gh-list');
            assert.strictEqual(inp.getAttribute('role'), 'combobox');
            assert.strictEqual(list.getAttribute('role'), 'listbox');
            assert.strictEqual(inp.getAttribute('aria-expanded'), 'false', 'starts collapsed');
            assert.ok(list.hidden);
            assert.ok(qa('.sdoc-gh-opt').every(function(o) { return o.getAttribute('role') === 'option' && o.id; }));
            kd(e.m.sdocGhRepoKeydown, inp, 'ArrowDown');
            assert.ok(!list.hidden && inp.getAttribute('aria-expanded') === 'true', 'ArrowDown opens');
            assert.strictEqual(e.m.sdocGhState.active, 'octo/alpha');
            assert.strictEqual(inp.getAttribute('aria-activedescendant'), qa('.sdoc-gh-opt')[0].id);
            assert.strictEqual(qa('.sdoc-gh-opt')[0].getAttribute('aria-selected'), 'true');
            kd(e.m.sdocGhRepoKeydown, inp, 'End');
            assert.strictEqual(e.m.sdocGhState.active, 'acme/gamma');
            kd(e.m.sdocGhRepoKeydown, inp, 'ArrowDown');
            assert.strictEqual(e.m.sdocGhState.active, 'acme/gamma', 'clamped at the end');
            kd(e.m.sdocGhRepoKeydown, inp, 'Home');
            kd(e.m.sdocGhRepoKeydown, inp, 'ArrowDown');
            assert.strictEqual(e.m.sdocGhState.active, 'octo/beta');
            var ev = kd(e.m.sdocGhRepoKeydown, inp, 'Escape');
            assert.ok(ev.defaultPrevented && list.hidden && inp.getAttribute('aria-expanded') === 'false' && !inp.hasAttribute('aria-activedescendant'), 'Escape closes');
            kd(e.m.sdocGhRepoKeydown, inp, 'ArrowUp');
            assert.strictEqual(e.m.sdocGhState.active, 'acme/gamma', 'ArrowUp reopens on the last option');
            kd(e.m.sdocGhRepoKeydown, inp, 'Enter');
            assert.strictEqual(inp.value, 'acme/gamma');
            assert.strictEqual(e.rec.clones.length, 0, 'Enter on a highlighted option picks, does not connect');
            inp.value = 'x'; e.m.sdocGhState.query = 'x';
            kd(e.m.sdocGhRepoKeydown, inp, 'Escape');
            assert.strictEqual(inp.value, '', 'Escape with the list closed clears');
            e.m.sdocGhState.query = 'octo/alpha';
            await kd(e.m.sdocGhKeydown, q('.sdoc-gh-branch'), 'Enter');
            await settle(e.U);
            assert.deepStrictEqual(e.rec.clones, [['octo/alpha', 'main']]);
            // The successful clone closed the popover: reopen it for the mode radio keys.
            assert.ok(!q('#sdoc-add-pop'), 'clone success closes the popover');
            e.m.sdocAddToggle(); await settle(e.U);
            // Mode radio keys: ArrowLeft/Right move + pick.
            var gh = q('.sdoc-conn-mode .radio-option[data-value="github"]');
            var mev = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
            Object.defineProperty(mev, 'target', { value: gh }); Object.defineProperty(mev, 'currentTarget', { value: q('.sdoc-conn-mode') });
            e.m.sdocSrcModeKeydown(mev);
            assert.ok(mev.defaultPrevented);
            assert.strictEqual(e.m.sdocSrcState.addMode, 'folder');
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('busy: a second Refresh/Remove/Connect while one is in flight is a no-op; buttons disabled + aria-busy', async function() {
        var release, gate = new Promise(function(r) { release = r; });
        var e = await load({ metas: [{ repo: 'octo/alpha::main', branch: 'main' }], reclone: function() { return gate; } });
        try {
            e.m.sdocSelectSource('ws:octo/alpha::main'); // repo actions live in the pane head
            var p1 = e.m.sdocWsRefresh('octo/alpha::main');
            await e.U.flush();
            var ref = q('[data-fk="wsref:ws:octo/alpha::main"]'), rm = q('[data-fk="wsrm:ws:octo/alpha::main"]');
            assert.ok(ref.disabled && ref.getAttribute('aria-busy') === 'true' && rm.disabled, 'busy state');
            assert.strictEqual(await e.m.sdocWsRefresh('octo/alpha::main'), null);
            assert.strictEqual(await e.m.sdocWsRemove('octo/alpha::main'), null);
            assert.strictEqual(e.rec.reclones.length, 1);
            assert.strictEqual(e.rec.confirms.length, 0);
            release(); await p1; await settle(e.U);
            assert.ok(!q('[data-fk="wsref:ws:octo/alpha::main"]').disabled, 'released');
            await toGithub(e);
            e.m.sdocGhState.query = 'octo/alpha';
            var c1 = e.m.sdocSrcConnectRepo();
            assert.ok(q('[data-fk="connect-gh"]').disabled && q('[data-fk="connect-gh"]').getAttribute('aria-busy') === 'true');
            assert.strictEqual(await e.m.sdocSrcConnectRepo(), null);
            await c1; await settle(e.U);
            assert.strictEqual(e.rec.clones.length, 1);
            assert.ok(!q('#sdoc-add-pop'), 'a successful clone closes the Add source popover');
            e.m.sdocAddToggle(); // reopen: Clone repo is enabled again
            assert.ok(q('[data-fk="connect-gh"]') && !q('[data-fk="connect-gh"]').disabled && !q('[data-fk="connect-gh"]').hasAttribute('aria-busy'));
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('hostile description / error text is escaped', async function() {
        var e = await load({ repos: { ok: true, status: 200, body: [{ full_name: 'o/r', description: '"><img src=x onerror=alert(1)>' }] } });
        try {
            await toGithub(e);
            assert.ok(!q('img'), 'no injected element');
            assert.strictEqual(qa('.sdoc-gh-opt')[0].getAttribute('title'), '"><img src=x onerror=alert(1)>');
        } finally { await done(e); }
        var e2 = await load({ repos: { error: '<img src=x onerror=alert(1)>' } });
        try {
            await toGithub(e2);
            assert.ok(!q('img') && /<img src=x/.test(q('.sdoc-gh-note').textContent), 'error shown as text');
        } finally { await done(e2); }
    }, { tags: ['unit'] });

    test('list errors: 401 token (not "Add a token"), 403 rate vs permission; Retry reloads', async function() {
        var cases = [
            [{ ok: false, status: 401, body: { message: 'Bad credentials' } }, /invalid or expired/, true],
            [{ ok: false, status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } }, /^GitHub rate limit reached\. Try again later\.$/, false],
            [{ ok: false, status: 403, body: { message: 'Resource protected by SAML' }, headers: { 'x-ratelimit-remaining': '4000' } }, /lacks access/, true]
        ];
        for (var i = 0; i < cases.length; i++) {
            var fail = true, c = cases[i];
            var e = await load({ repoPages: function() { return fail ? c[0] : { ok: true, status: 200, body: REPOS }; } });
            try {
                await toGithub(e);
                assert.ok(c[1].test(q('.sdoc-gh-note [role="alert"]').textContent), i + ': ' + q('.sdoc-gh-note').textContent);
                assert.strictEqual(!!q('.sdoc-gh-note [data-fk="gh:settings"]'), c[2], i + ': settings link');
                assert.strictEqual(e.m.sdocGhState.noToken, false);
                fail = false;
                await e.U.fireInline(q('[data-fk="gh:retry"]'), 'click', e.m);
                await settle(e.U);
                assert.strictEqual(qa('.sdoc-gh-opt').length, 3, i + ': retry loaded');
            } finally { await done(e); }
        }
    }, { tags: ['unit'] });

    test('pagination follows Link rel=next; typed case canonicalised; unlisted repo uses default_branch', async function() {
        var page2 = [{ full_name: 'Big/Repo', default_branch: 'trunk' }];
        var e = await load({
            repoPages: function(path) { return /page=2/.test(path) ? { ok: true, status: 200, body: page2, headers: { link: null } } : { ok: true, status: 200, body: REPOS, headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } }; },
            repoInfo: function(path) { return path === '/repos/new/one' ? { ok: true, status: 200, body: { full_name: 'New/One', default_branch: 'dev' } } : { ok: false, status: 404 }; }
        });
        try {
            await toGithub(e);
            assert.deepStrictEqual(e.rec.api.map(function(a) { return a[1]; }), ['/user/repos?per_page=100&sort=updated', '/user/repos?per_page=100&sort=updated&page=2']);
            assert.strictEqual(qa('.sdoc-gh-opt').length, 4);
            e.m.sdocGhState.query = 'big/repo';
            await e.m.sdocSrcConnectRepo();
            assert.deepStrictEqual(e.rec.clones[0], ['Big/Repo', 'trunk'], 'canonical case + listed default branch');
            e.m.sdocGhState.query = 'new/one';
            await e.m.sdocSrcConnectRepo();
            assert.deepStrictEqual(e.rec.clones[1], ['New/One', 'dev'], 'default_branch lookup');
            assert.ok(!q('#sdoc-add-pop'), 'the successful clone closed the popover');
            e.m.sdocAddToggle(); // reopen it (GitHub mode is remembered)
            e.m.sdocGhState.query = 'gone/repo';
            await e.m.sdocSrcConnectRepo();
            assert.strictEqual(e.rec.clones.length, 2, 'lookup 404: no clone');
            assert.ok(/Repository gone\/repo not found/.test(q('#sdoc-gh-status').textContent));
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('Refresh / Remove that throw: busy clears, error snackbar, card re-rendered', async function() {
        var e = await load({ metas: [{ repo: 'octo/alpha::main', branch: 'main' }], reclone: function() { throw new Error('boom <x>'); } });
        try {
            e.m.sdocSelectSource('ws:octo/alpha::main'); // repo actions live in the pane head
            var before = q('[data-fk="wsref:ws:octo/alpha::main"]');
            var r = await e.m.sdocWsRefresh('octo/alpha::main'); // a rejection would throw here
            await settle(e.U);
            assert.strictEqual(r, undefined, 'resolves with the sources reload (sdocRefreshSources)');
            assert.deepStrictEqual(e.rec.reclones, [['octo/alpha', 'main']]);
            var after = q('[data-fk="wsref:ws:octo/alpha::main"]');
            // _sdocSetHtmlKeepFocus skips an identical-markup swap on purpose (no hover
            // flashing), so node identity is not a re-render signal: assert the end state.
            assert.ok(before && after && after.isConnected, 'pane head still rendered');
            assert.ok(!after.disabled && !after.hasAttribute('aria-busy'), 'refresh button no longer busy');
            assert.ok(q('.sdoc-rail-item.active[data-src-id="ws:octo/alpha::main"]'), 'repo still selected in the rail');
            assert.ok(e.m.sdocSrcById('ws:octo/alpha::main'), 'sources reloaded');
            assert.ok(!e.m.sdocWsBusy.has('octo/alpha::main'), 'busy cleared');
            assert.ok(!q('[data-fk="wsref:ws:octo/alpha::main"]').disabled && !q('[data-fk="wsref:ws:octo/alpha::main"]').hasAttribute('aria-busy'));
            assert.ok(e.rec.snacks.some(function(s) { return s[0] === 'error' && /Re-clone failed: boom <x>/.test(s[1]); }), JSON.stringify(e.rec.snacks));
        } finally { await done(e); }
        // The confirm modal itself throwing (outside deleteGitHubRepo's own catch).
        var e2 = await load({ metas: [{ repo: 'octo/alpha::main', branch: 'main' }], confirmThrow: 'modal gone' });
        try {
            e2.m.sdocSelectSource('ws:octo/alpha::main');
            await e2.U.fireInline(q('[data-fk="wsrm:ws:octo/alpha::main"]'), 'click', e2.m);
            await settle(e2.U);
            assert.ok(!e2.m.sdocWsBusy.has('octo/alpha::main'), 'busy cleared');
            assert.ok(!q('[data-fk="wsrm:ws:octo/alpha::main"]').disabled);
            assert.ok(e2.rec.snacks.some(function(s) { return s[0] === 'error' && /Delete failed: modal gone/.test(s[1]); }), JSON.stringify(e2.rec.snacks));
            assert.deepStrictEqual(e2.rec.deletes, []);
        } finally { await done(e2); }
    }, { tags: ['unit'] });

    test('re-render with the same selection does not scroll the card again', async function() {
        var e = await load({ metas: [{ repo: 'octo/alpha::main', branch: 'main' }] });
        var orig = HTMLElement.prototype.scrollIntoView, seen = [];
        HTMLElement.prototype.scrollIntoView = function(o) { if (this.matches('.sdoc-rail-item.active')) seen.push(this); };
        try {
            e.m.sdocSelectSource('ws:octo/alpha::main');
            assert.strictEqual(seen.length, 1);
            e.m.sdocRenderSourcesStrip();
            e.m.sdocRenderSourcesStrip();
            assert.strictEqual(seen.length, 1, 'no second scroll for the same selection');
        } finally { HTMLElement.prototype.scrollIntoView = orig; await done(e); }
    }, { tags: ['unit'] });

    test('/user/repos: capped at 10 pages; a later page failing keeps the pages loaded', async function() {
        var e = await load({ repoPages: function(path) {
            var m = /page=(\d+)/.exec(path), n = m ? +m[1] : 1;
            return { ok: true, status: 200, body: [{ full_name: 'o/p' + n }], headers: { link: '<https://api.github.com/user/repos?page=' + (n + 1) + '>; rel="next"' } };
        } });
        try {
            await toGithub(e);
            await settle(e.U);
            assert.strictEqual(e.rec.api.length, 10, 'stops at SDOC_GH_MAX_PAGES');
            assert.strictEqual(e.m.sdocGhState.repos.length, 10);
            assert.strictEqual(e.m.sdocGhState.error, null);
        } finally { await done(e); }
        var e2 = await load({ repoPages: function(path) {
            return /page=2/.test(path) ? { ok: false, status: 500, body: { message: 'oops' } }
                : { ok: true, status: 200, body: REPOS, headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } };
        } });
        try {
            await toGithub(e2);
            assert.strictEqual(e2.rec.api.length, 2);
            assert.deepStrictEqual(e2.m.sdocGhState.repos.map(function(r) { return r.full; }), ['octo/alpha', 'octo/beta', 'acme/gamma'], 'page 1 kept');
            assert.strictEqual(e2.m.sdocGhState.error, null, 'no error for a later page');
            assert.strictEqual(qa('.sdoc-gh-opt').length, 3);
        } finally { await done(e2); }
    }, { tags: ['unit'] });

    test('hostile repo name / branch in the card onclick is escaped (sdocJsArg)', async function() {
        var repo = "evil/x');alert(1);('\\", branch = 'b"\'<i>x</i>';
        var wk = repo + '::' + branch;
        var e = await load({ metas: [{ repo: wk, branch: branch }] });
        try {
            assert.ok(!q('i'), 'no injected element');
            e.m.sdocSelectSource('ws:' + wk); // repo actions live in the pane head
            assert.ok(!q('i'), 'no injected element in the pane head');
            assert.ok(q('#sdoc-pane-head [data-fk^="wsref:"]'), 'Sync is in the pane head');
            var ref = qa('[data-fk^="wsref:"]')[0];
            assert.ok(ref && /^sdocWsRefresh\('/.test(ref.getAttribute('onclick').replace(/^.*?(sdocWsRefresh)/, '$1')));
            await e.U.fireInline(ref, 'click', e.m);
            await settle(e.U);
            assert.deepStrictEqual(e.rec.reclones, [[repo, branch]], 'handler received the exact name');
            await e.U.fireInline(qa('[data-fk^="wsrm:"]')[0], 'click', e.m);
            await settle(e.U);
            assert.deepStrictEqual(e.rec.deletes, [wk]);
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('explicit branch: unlisted / list-not-loaded repo resolves to the canonical full_name', async function() {
        var info = function(path) {
            if (path === '/repos/Octo/Delta') return { ok: true, status: 200, body: { full_name: 'octo/delta', default_branch: 'trunk' } };
            if (path === '/repos/Octo/Alpha') return { ok: true, status: 200, body: { full_name: 'octo/alpha', default_branch: 'main' } };
            return { ok: false, status: 500 };
        };
        var e = await load({ repoInfo: info });
        try {
            await toGithub(e);
            e.m.sdocGhState.query = 'Octo/Delta'; e.m.sdocGhState.branch = 'main';
            await e.m.sdocSrcConnectRepo();
            assert.ok(e.rec.api.some(function(a) { return a[1] === '/repos/Octo/Delta'; }), 'looked up despite the branch');
            assert.deepStrictEqual(e.rec.clones[0], ['octo/delta', 'main'], 'canonical name, explicit branch kept');
        } finally { await done(e); }
        // The list is still loading (g.repos null): same lookup.
        var e2 = await load({ repoPages: function() { return new Promise(function() {}); }, repoInfo: info });
        try {
            await toGithub(e2);
            assert.strictEqual(e2.m.sdocGhState.repos, null);
            e2.m.sdocGhState.query = 'Octo/Alpha'; e2.m.sdocGhState.branch = 'main';
            await e2.m.sdocSrcConnectRepo();
            assert.deepStrictEqual(e2.rec.clones[0], ['octo/alpha', 'main']);
        } finally { await done(e2); }
        // Lookup failed too: an existing workspace's casing is reused (no duplicate card).
        var e3 = await load({ metas: [{ repo: 'octo/alpha::main', branch: 'main' }], repoPages: function() { return new Promise(function() {}); }, repoInfo: { ok: false, status: 500 } });
        try {
            await toGithub(e3);
            e3.m.sdocGhState.query = 'OCTO/ALPHA'; e3.m.sdocGhState.branch = 'main';
            await e3.m.sdocSrcConnectRepo();
            assert.deepStrictEqual(e3.rec.clones[0], ['octo/alpha', 'main']);
        } finally { await done(e3); }
    }, { tags: ['unit'] });

    test('a /user/repos load from before a reopen is ignored', async function() {
        var release, calls = 0, gate = new Promise(function(r) { release = r; });
        var hist = [];
        var e = await load({ globals: {
            appStorage: { getItem: function() { return null; }, setItem: function() {} },
            hideAllPanels: function() {}, updateAllButtonStates: function() {}, renderChatList: function() {},
            pushHistoryState: function(v, id) { hist.push([v, id]); }
        }, repoPages: function() {
            calls++;
            return calls === 1 ? gate.then(function() { return { ok: false, status: 500, body: { message: 'stale' } }; })
                : { ok: true, status: 200, body: [{ full_name: 'fresh/one' }] };
        } });
        try {
            await toGithub(e);
            assert.ok(e.m.sdocGhState.loading, 'first load in flight');
            var p1 = e.m.sdocGhState.loading, gen0 = e.m.sdocGhState.gen;
            var panel = document.createElement('div'); panel.id = 'documents-panel'; e.mount.root.appendChild(panel);
            e.m.openDocumentsView(); // reopen while the first load is still pending
            assert.strictEqual(e.m.sdocGhState.gen, gen0 + 1, 'reopen bumps the generation');
            assert.strictEqual(panel.style.display, 'flex');
            assert.deepStrictEqual(hist, [['documents', null]]);
            var p2 = e.m.sdocGhState.loading;
            assert.ok(p2 && p2 !== p1, 'GitHub mode: openDocumentsView starts a fresh load');
            await p2;
            assert.strictEqual(calls, 2, 'fresh /user/repos request');
            release(); await p1; await settle(e.U);
            assert.strictEqual(e.m.sdocGhState.error, null, 'stale error not written');
            assert.deepStrictEqual(e.m.sdocGhState.repos.map(function(r) { return r.full; }), ['fresh/one']);
            assert.deepStrictEqual(qa('.sdoc-gh-opt').map(function(o) { return o.getAttribute('data-full'); }), ['fresh/one']);
        } finally { await done(e); }
    }, { tags: ['unit'] });

    test('repo listbox: starts collapsed, opens on input / Alt+ArrowDown, blur collapses it', async function() {
        var e = await load(), foc = stubFocus();
        try {
            await toGithub(e);
            var inp = q('.sdoc-gh-repo'), list = q('#sdoc-gh-list');
            assert.ok(list.hidden && inp.getAttribute('aria-expanded') === 'false', 'collapsed on load');
            foc.set(inp);
            type(e, inp, 'octo');
            assert.ok(!list.hidden && inp.getAttribute('aria-expanded') === 'true', 'typing opens');
            // Blur while focus comes straight back (e.g. a re-render): stays open.
            e.U.fireInline(inp, 'blur', e.m);
            await settle(e.U);
            assert.ok(!list.hidden && inp.getAttribute('aria-expanded') === 'true', 'refocused: still open');
            foc.set(null); e.U.fireInline(inp, 'blur', e.m);
            await settle(e.U);
            assert.ok(list.hidden && inp.getAttribute('aria-expanded') === 'false' && !inp.hasAttribute('aria-activedescendant'), 'blur collapses');
            var ev = new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'target', { value: inp });
            e.m.sdocGhRepoKeydown(ev);
            assert.ok(ev.defaultPrevented && !list.hidden && inp.getAttribute('aria-expanded') === 'true', 'Alt+ArrowDown opens');
            assert.strictEqual(e.m.sdocGhState.active, null, 'without highlighting');
            kd(e.m.sdocGhRepoKeydown, inp, 'Escape');
            assert.ok(list.hidden && inp.getAttribute('aria-expanded') === 'false', 'Escape closes');
        } finally { foc.restore(); await done(e); }
    }, { tags: ['unit'] });

    test('repo listbox: a mouse pick right after it opens picks the repo; listbox mousedown is default-prevented', async function() {
        var e = await load(), foc = stubFocus();
        try {
            await toGithub(e);
            var inp = q('.sdoc-gh-repo');
            foc.set(inp);
            type(e, inp, 'octo');
            assert.ok(!q('#sdoc-gh-list').hidden, 'opened');
            var opt = q('.sdoc-gh-opt[data-full="octo/beta"]');
            assert.ok(mouseDown(e, foc, opt, inp).prevented, 'option mousedown default-prevented');
            await settle(e.U);
            assert.ok(!q('#sdoc-gh-list').hidden && inp.getAttribute('aria-expanded') === 'true', 'not collapsed before the click');
            opt = q('.sdoc-gh-opt[data-full="octo/beta"]');
            assert.ok(opt, 'option still there to click');
            e.U.fireInline(opt, 'click', e.m);
            await settle(e.U);
            assert.strictEqual(e.m.sdocGhState.query, 'octo/beta');
            assert.strictEqual(q('.sdoc-gh-repo').value, 'octo/beta', 'picked');
            assert.ok(q('#sdoc-gh-list').hidden, 'pick closes the listbox');
            await e.U.fireInline(q('[data-fk="connect-gh"]'), 'click', e.m);
            await settle(e.U);
            assert.deepStrictEqual(e.rec.clones, [['octo/beta', 'develop']]);
        } finally { foc.restore(); await done(e); }
        // A press on the listbox itself (scrollbar / padding) keeps focus in the input.
        var e2 = await load(), foc2 = stubFocus();
        try {
            await toGithub(e2);
            var inp2 = q('.sdoc-gh-repo'), list = q('#sdoc-gh-list');
            foc2.set(inp2);
            type(e2, inp2, 'octo');
            assert.ok(!list.hidden);
            var r = mouseDown(e2, foc2, list, inp2);
            assert.ok(r.prevented && r.event.defaultPrevented, 'listbox mousedown default-prevented');
            await settle(e2.U);
            assert.ok(!list.hidden && inp2.getAttribute('aria-expanded') === 'true', 'still open');
        } finally { foc2.restore(); await done(e2); }
    }, { tags: ['unit'] });

    test('explicit branch: a lookup failing for lack of a token still clones the typed name + branch', async function() {
        var noTok = { error: 'No GitHub token configured' };
        var e = await load({ repos: noTok, repoInfo: noTok });
        try {
            await toGithub(e);
            assert.ok(e.m.sdocGhState.noToken);
            e.m.sdocGhState.query = 'Octo/Delta'; e.m.sdocGhState.branch = 'dev';
            await e.m.sdocSrcConnectRepo();
            assert.ok(e.rec.api.some(function(a) { return a[1] === '/repos/Octo/Delta'; }), 'lookup attempted');
            assert.deepStrictEqual(e.rec.replace, [['Octo/Delta', 'dev']]);
            assert.deepStrictEqual(e.rec.clones, [['Octo/Delta', 'dev']], 'typed name + branch');
        } finally { await done(e); }
        // githubApi throwing (no token wired at all): same outcome.
        var e2 = await load({ repos: noTok, repoInfo: function() { throw new Error('No GitHub token configured'); } });
        try {
            await toGithub(e2);
            e2.m.sdocGhState.query = 'x/y'; e2.m.sdocGhState.branch = 'feat';
            await e2.m.sdocSrcConnectRepo();
            assert.deepStrictEqual(e2.rec.clones, [['x/y', 'feat']]);
        } finally { await done(e2); }
    }, { tags: ['unit'] });

    test('selected card scrolls into view; an open repo shows its file count', async function() {
        var e = await load({ metas: [{ repo: 'octo/alpha::main', branch: 'main' }] });
        var orig = HTMLElement.prototype.scrollIntoView, seen = [];
        HTMLElement.prototype.scrollIntoView = function(o) { seen.push([this, o]); };
        try {
            e.m.sdocSelectSource('ws:octo/alpha::main');
            assert.ok(seen.some(function(s) { return s[0].matches('.sdoc-rail-item.active[data-src-id="ws:octo/alpha::main"]') && s[1] && s[1].block === 'nearest'; }), 'active rail item scrolled');
            var n = (e.m.sdocSrcState.rendered || []).length;
            assert.strictEqual(document.getElementById('documents-count').textContent, n + (n === 1 ? ' file' : ' files'));
        } finally { HTMLElement.prototype.scrollIntoView = orig; await done(e); }
    }, { tags: ['unit'] });
});
