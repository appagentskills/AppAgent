// S0B-08: skill import is atomic (write-then-swap). REAL src modules
// (core/140-skills-engine.js + ui/010-skills-ui.js) over an in-memory
// transactional fake IDB (per-tx overlay, committed on oncomplete, discarded on
// abort). Remote XML revert/apply (getVersionXml/uploadXml) is recorded.
// Run: run_tests { files: ['test/skills-import-atomic.test.js'] }
var WS = args.workspace;
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var XKEY = 'sys_script_include_' + 'a'.repeat(32);

function domErr(name, msg) { var e = new Error(msg); e.name = name; return e; }
function settle() { return new Promise(function(r) { setTimeout(r, 30); }); }

function fakeIdb(seed) {
    var DEL = {}, db = { data: { skills: {}, skillAssets: {} }, failOn: null, commits: 0 };
    Object.keys(seed).forEach(function(s) { db.data[s] = JSON.parse(JSON.stringify(seed[s])); });
    db.transaction = function(names, mode) {
        names = [].concat(names);
        var ov = {}, q = [], state = 'active', tx = { error: null, mode: mode };
        names.forEach(function(n) { if (!db.data[n]) throw domErr('NotFoundError', 'no store ' + n); ov[n] = {}; });
        function view(n) {
            var o = Object.assign({}, db.data[n]);
            Object.keys(ov[n]).forEach(function(k) { if (ov[n][k] === DEL) delete o[k]; else o[k] = ov[n][k]; });
            return o;
        }
        function abort(err) { if (state !== 'active') return; state = 'aborted'; tx.error = err; if (tx.onabort) tx.onabort({ target: tx }); }
        function pump() {
            if (state !== 'active') return;
            if (q.length) { q.shift()(); setTimeout(pump, 0); return; }
            state = 'done';
            names.forEach(function(n) { Object.keys(ov[n]).forEach(function(k) { if (ov[n][k] === DEL) delete db.data[n][k]; else db.data[n][k] = ov[n][k]; }); });
            db.commits++;
            if (tx.oncomplete) tx.oncomplete({ target: tx });
        }
        function req(n, op, arg, run) {
            var r = { result: undefined, error: null };
            q.push(function() {
                var err = db.failOn && db.failOn(n, op, arg);
                if (err) { r.error = err; var ev = { target: r }; if (r.onerror) r.onerror(ev); if (tx.onerror) tx.onerror(ev); abort(err); return; }
                r.result = run();
                if (r.onsuccess) r.onsuccess({ target: r });
            });
            return r;
        }
        tx.abort = function() { abort(null); };
        tx.objectStore = function(n) {
            if (!ov[n]) throw domErr('NotFoundError', 'store not in tx scope: ' + n);
            return {
                put: function(v) { var c = JSON.parse(JSON.stringify(v)); return req(n, 'put', c, function() { ov[n][c.id] = c; return c.id; }); },
                get: function(k) { return req(n, 'get', k, function() { return view(n)[k]; }); },
                getAll: function() { return req(n, 'getAll', null, function() { var o = view(n); return Object.keys(o).map(function(k) { return o[k]; }); }); },
                delete: function(k) { return req(n, 'delete', k, function() { ov[n][k] = DEL; }); }
            };
        };
        setTimeout(pump, 0);
        return tx;
    };
    return db;
}

// Fake File System Access directory handle. entries: { name: text | Error | fdir(...) }
function fdir(name, entries) {
    var h = { kind: 'directory', name: name };
    h.values = async function*() {
        for (var k in entries) yield (entries[k] && entries[k].kind === 'directory') ? entries[k] : { kind: 'file', name: k };
    };
    h.getFileHandle = async function(n) {
        var v = entries[n];
        if (v === undefined || (v && v.kind === 'directory')) throw domErr('NotFoundError', n + ' not found');
        return { getFile: async function() { if (v instanceof Error) throw v; return { text: async function() { return v; } }; } };
    };
    h.getDirectoryHandle = async function(n) {
        var v = entries[n];
        if (!v || v.kind !== 'directory') throw domErr('NotFoundError', n + ' not found');
        return v;
    };
    return h;
}

async function load(patch) {
    var rec = U.recorder, s = U.stubs(), lastInput = null, uploadSeen = [];
    var ctl = { confirm: true, revertOk: true, spin: false, spinAtModal: [] };
    var db = fakeIdb({
        skills: { demo: { id: 'demo', name: 'demo', body: 'old body', createdAt: 111, userModified: true } },
        skillAssets: {
            'demo_a.md': { id: 'demo_a.md', skillId: 'demo', filename: 'a.md', type: 'md', content: 'old a' },
            'demo_b.md': { id: 'demo_b.md', skillId: 'demo', filename: 'b.md', type: 'md', content: 'old b' },
            'keep_x.md': { id: 'keep_x.md', skillId: 'keep', filename: 'x.md', type: 'md', content: 'x' }
        }
    });
    var activeSkills = { demo: { xmlBackups: {}, activatedAt: 1 } };
    activeSkills.demo.xmlBackups[XKEY] = 'ver1';
    var g = {
        document: { addEventListener: function() {}, createElement: function() { lastInput = { click: function() {} }; return lastInput; } },
        window: {},
        skills: { demo: JSON.parse(JSON.stringify(db.data.skills.demo)) },
        activeSkills: activeSkills,
        skillsStoreName: 'skills', skillAssetsStoreName: 'skillAssets',
        openDatabase: function() { return Promise.resolve(db); },
        // Faithful copy of core/130-indexeddb.js saveSkill (fire-and-forget, swallows errors)
        saveSkill: rec(async function(sk) { try { db.transaction(['skills'], 'readwrite').objectStore('skills').put(sk); g.skills[sk.id] = sk; } catch (e) {} }),
        showSnackbar: s.showSnackbar, renderSkillsList: rec(),
        showOverlaySpinner: rec(function() { ctl.spin = true; }), hideOverlaySpinner: rec(function() { ctl.spin = false; }),
        showConfirmModal: rec(function() { ctl.spinAtModal.push(ctl.spin); return Promise.resolve(ctl.confirm); }),
        escapeHtml: function(t) { return String(t).replace(/[&<>"']/g, function(c) { return '&#' + c.charCodeAt(0) + ';'; }); },
        pushSkillToolsRefreshToOffscreen: rec(),
        setSetting: rec(function() { return Promise.resolve(); }),
        getVersionXml: rec(function() { return Promise.resolve('<xml>old</xml>'); }),
        uploadXml: rec(function() {
            var a = db.data.skillAssets['demo_a.md'];
            uploadSeen.push(a ? a.content : null);
            return Promise.resolve({ success: ctl.revertOk });
        })
    };
    if (patch) patch(g);
    var m = await loadModules(['src/js/core/140-skills-engine.js', 'src/js/ui/010-skills-ui.js'], { workspace: WS, globals: g });
    return { m: m, g: g, db: db, ctl: ctl, snack: s.showSnackbar, uploadSeen: uploadSeen, input: function() { return lastInput; } };
}

async function importJson(L, obj) {
    L.m.importSkillsFromJsonFile();
    await L.input().onchange({ target: { files: [{ name: 'in.json', text: function() { return Promise.resolve(JSON.stringify(obj)); } }] } });
    await settle();
}
function twoFolders() {
    return fdir('root', {
        demo: fdir('demo', { 'SKILL.md': '---\nname: demo\n---\nnew body', 'a.md': 'new a' }),
        fresh: fdir('fresh', { 'SKILL.md': '---\nname: fresh\n---\nfresh body' })
    });
}
var DEMO_FRESH = { type: 'skill-bundle', skills: [{ id: 'demo', body: 'new body', assets: [{ filename: 'a.md', type: 'md', content: 'new a' }] }, { id: 'fresh', body: 'fresh body' }] };

function assertOldIntact(L) {
    assert.strictEqual(L.db.data.skills.demo.body, 'old body', 'old skill row intact in IDB');
    assert.strictEqual(L.db.data.skillAssets['demo_a.md'].content, 'old a', 'old a.md intact');
    assert.ok(L.db.data.skillAssets['demo_b.md'], 'old b.md intact');
    assert.strictEqual(L.g.skills.demo.body, 'old body', 'in-memory skill not swapped');
    assert.ok(L.g.activeSkills.demo && L.g.activeSkills.demo.xmlBackups[XKEY] === 'ver1', 'skill still active');
    assert.strictEqual(L.g.getVersionXml.calls.length + L.g.uploadXml.calls.length, 0, 'no remote XML revert');
    assert.strictEqual(L.g.setSetting.calls.length, 0, 'active state not rewritten');
}
function lastSnack(L) { return L.snack.calls[L.snack.calls.length - 1] || []; }

describe('S0B-08 skill import is atomic (write-then-swap)', function() {
    test('failed import leaves the old skill and assets intact', async function() {
        var L = await load();
        L.m.importSkillsFromJsonFile();
        var bad = { id: 'demo', body: 'new body', assets: [{ filename: 'a.md', type: 'md', content: 'new a' }, { filename: 42, type: 'md', content: 'x' }] };
        await L.input().onchange({ target: { files: [{ name: 'demo.json', text: function() { return Promise.resolve(JSON.stringify(bad)); } }] } });
        await settle();
        assertOldIntact(L);
        assert.strictEqual(lastSnack(L)[1], 'error', 'error snackbar');
        assert.match(lastSnack(L)[0], /demo\.json: Invalid asset filename/);
    }, { tags: ['unit'], timeout: 5000 });

    test('IDB failure on a LATER asset put rolls back the whole import (JSON + single folder)', async function() {
        var L = await load(), ran = [];
        // Fail the 2nd skillAssets put (c.md) - AFTER the skill row and a.md were put in the same tx.
        L.db.failOn = function(store, op, arg) {
            ran.push(store + ':' + op + ':' + (arg && arg.id));
            return store === 'skillAssets' && op === 'put' && arg.filename === 'c.md' ? domErr('QuotaExceededError', 'quota exceeded') : null;
        };
        function rolledBack() {
            assert.strictEqual(ran[ran.length - 1], 'skillAssets:put:demo_c.md', 'failed on the later asset put');
            assert.ok(ran.indexOf('skills:put:demo') >= 0 && ran.indexOf('skillAssets:put:demo_a.md') >= 0, 'row + a.md were put before the failure');
            assert.strictEqual(L.db.commits, 0, 'nothing committed');
            assert.strictEqual(L.db.data.skillAssets['demo_c.md'], undefined, 'no partial asset');
            assertOldIntact(L);
            ran.length = 0;
        }
        var assets = [{ filename: 'a.md', type: 'md', content: 'new a' }, { filename: 'c.md', type: 'md', content: 'new c' }];
        await assert.rejects(L.m.importSkillFromJsonObject({ id: 'demo', body: 'new body', assets: assets }), /quota exceeded/);
        await settle();
        rolledBack();
        L.g.window.showDirectoryPicker = function() { return Promise.resolve(fdir('demo', { 'SKILL.md': '---\nname: demo\n---\nnew body', 'a.md': 'new a', 'c.md': 'new c' })); };
        await L.m.importSkillsFromFolder();
        await settle();
        rolledBack();
        assert.strictEqual(lastSnack(L)[1], 'error');
        assert.match(lastSnack(L)[0], /Import failed: demo: quota exceeded/);
    }, { tags: ['unit'], timeout: 5000 });

    test('multi-folder: unreadable asset keeps old skill, error shown; only NotFoundError skips; updated counted after success', async function() {
        var L = await load();
        L.g.window.showDirectoryPicker = function() {
            return Promise.resolve(fdir('root', {
                demo: fdir('demo', { 'SKILL.md': '---\nname: demo\n---\nnew body', 'a.md': domErr('NotReadableError', 'a.md unreadable') }),
                fresh: fdir('fresh', { 'SKILL.md': '---\nname: fresh\n---\nfresh body', 'f.md': 'f' }),
                notes: fdir('notes', { 'readme.txt': 'x' })
            }));
        };
        await L.m.importSkillsFromFolder();
        await settle();
        assertOldIntact(L);
        assert.strictEqual(L.db.data.skills.fresh.body, 'fresh body', 'valid sibling still imported');
        assert.strictEqual(L.db.data.skillAssets['fresh_f.md'].content, 'f');
        var sn = lastSnack(L);
        assert.strictEqual(sn[1], 'warning');
        assert.match(sn[0], /^Imported 1 skill\(s\) \u2014 1 failed: demo: a\.md unreadable$/, 'no "(1 updated)", no "notes" error');
    }, { tags: ['unit'], timeout: 5000 });

    test('re-import replaces a.md, removes stale b.md, keeps the id; activation cycled only after commit', async function() {
        var L = await load();
        var res = await L.m.importSkillFromJsonObject({ id: 'demo', body: 'new body', assets: [{ filename: 'a.md', type: 'md', content: 'new a' }] });
        assert.deepStrictEqual([res.id, res.existed, res.wasActive, res.activationError], ['demo', true, true, '']);
        assert.strictEqual(L.db.data.skills.demo.body, 'new body');
        assert.strictEqual(L.db.data.skills.demo.createdAt, 111, 'createdAt kept');
        assert.strictEqual(L.db.data.skillAssets['demo_a.md'].content, 'new a');
        assert.strictEqual(L.db.data.skillAssets['demo_b.md'], undefined, 'stale b.md removed');
        assert.ok(L.db.data.skillAssets['keep_x.md'], 'other skill untouched');
        assert.strictEqual(L.g.skills.demo.body, 'new body', 'published after commit');
        assert.ok(L.g.activeSkills.demo && !L.g.activeSkills.demo.xmlBackups[XKEY], 're-activated with the new assets');
        assert.deepStrictEqual(L.g.getVersionXml.calls, [['ver1']], 'old remote XML reverted once');
        assert.deepStrictEqual(L.uploadSeen, ['new a'], 'remote revert ran only after the new content was committed');
    }, { tags: ['unit'], timeout: 5000 });

    test('existing ids: ONE warning confirm (active flagged, spinner hidden); Cancel writes nothing, no remote call', async function() {
        var L = await load();
        L.ctl.confirm = false;
        await importJson(L, DEMO_FRESH);
        L.g.window.showDirectoryPicker = function() { return Promise.resolve(twoFolders()); };
        await L.m.importSkillsFromFolder();
        await settle();
        var calls = L.g.showConfirmModal.calls;
        assert.strictEqual(calls.length, 2, 'one prompt per import (JSON, multi-folder)');
        calls.forEach(function(c) {
            assert.strictEqual(c[2], 'warning');
            assert.match(c[1], /<code>demo<\/code> <strong>\(active: will be reverted and re-applied on ServiceNow\)<\/strong>/);
            assert.ok(!/fresh/.test(c[1]), 'new ids are not listed');
        });
        assert.deepStrictEqual(L.ctl.spinAtModal, [false, false], 'spinner hidden while the dialog is open');
        assert.strictEqual(L.db.commits, 0, 'no commit');
        assert.strictEqual(L.db.data.skills.fresh, undefined, 'new sibling not written either');
        assertOldIntact(L);
        assert.deepStrictEqual(L.snack.calls.map(function(c) { return c[0] + '|' + c[1]; }), ['Import cancelled|info', 'Import cancelled|info']);
    }, { tags: ['unit'], timeout: 5000 });

    test('Confirm proceeds: existing skill replaced and re-applied, new sibling added', async function() {
        var L = await load();
        await importJson(L, DEMO_FRESH);
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1, 'asked once');
        assert.strictEqual(L.db.data.skills.demo.body, 'new body');
        assert.strictEqual(L.db.data.skills.fresh.body, 'fresh body');
        assert.strictEqual(L.db.data.skillAssets['demo_b.md'], undefined, 'stale asset removed after confirm');
        assert.deepStrictEqual(L.g.getVersionXml.calls, [['ver1']], 'active skill reverted + re-applied after confirm');
        assert.deepStrictEqual(lastSnack(L), ['Imported 2 skill(s) (1 updated)', 'success']);
    }, { tags: ['unit'], timeout: 5000 });

    test('no prompt when every id is new (JSON + folder); an existing id then prompts once', async function() {
        var L = await load();
        L.ctl.confirm = false; // a prompt would cancel
        await importJson(L, { id: 'fresh', body: 'fresh body' });
        L.g.window.showDirectoryPicker = function() { return Promise.resolve(fdir('new2', { 'SKILL.md': '---\nname: new2\n---\nb' })); };
        await L.m.importSkillsFromFolder();
        await settle();
        assert.strictEqual(L.g.showConfirmModal.calls.length, 0, 'no prompt for new ids');
        assert.strictEqual(L.db.data.skills.fresh.body, 'fresh body');
        assert.ok(L.db.data.skills.new2, 'new folder skill imported');
        assert.deepStrictEqual(lastSnack(L), ['Imported 1 skill(s)', 'success']);
        await importJson(L, { id: 'fresh', body: 'changed' });
        assert.strictEqual(L.g.showConfirmModal.calls.length, 1, 'existing id prompts');
        assert.strictEqual(L.db.data.skills.fresh.body, 'fresh body', 'cancelled: unchanged');
    }, { tags: ['unit'], timeout: 5000 });

    test('re-activation issues are a warning snackbar: remote revert errors and a failed activation', async function() {
        var L = await load();
        L.ctl.revertOk = false; // deactivateSkill resolves success:true + 'Skill deactivated with errors: ...'
        await importJson(L, { id: 'demo', body: 'new body', assets: [{ filename: 'a.md', type: 'md', content: 'new a' }] });
        assert.strictEqual(L.db.data.skills.demo.body, 'new body');
        assert.strictEqual(lastSnack(L)[1], 'warning');
        assert.match(lastSnack(L)[0], /^Imported 1 skill\(s\) \(1 updated\) \u2014 re-activation issues: demo: Skill deactivated with errors: sys_script_include_a{32}: revert failed$/);
        var L2 = await load();
        await importJson(L2, { id: 'demo', body: 'new body', assets: [{ filename: 'bad.xml', type: 'xml', content: '<x/>' }] });
        assert.strictEqual(lastSnack(L2)[1], 'warning');
        assert.match(lastSnack(L2)[0], /re-activation issues: demo: Failed to load XML: bad\.xml/);
    }, { tags: ['unit'], timeout: 5000 });
});

// TB-10: adding a SKILL.md via "Add file" (REAL addSkillAssetFiles) must not wipe the skill's
// actions when `actions:` is a flow list: the mini parser reads block lists only (parses to []).
describe('TB-10 SKILL.md add-file replaces actions only when the parse is non-empty', function() {
    var OLD = [{ name: 'Old Act', icon: 'rocket', show: ['home'] }];
    async function addSkillMd(text) {
        var L = await load(function(g) {
            g.currentEditingSkill = 'demo';
            g.skills.demo.actions = JSON.parse(JSON.stringify(OLD));
            g.document.getElementById = function() { return null; };
            g.renderSkillBodyView = U.recorder();
            g.renderSkillAssets = U.recorder(function() { return Promise.resolve(); });
        });
        await L.m.addSkillAssetFiles([{ name: 'SKILL.md', text: function() { return Promise.resolve(text); } }]);
        return L;
    }
    test('flow `actions: [...]` keeps the existing actions; body replaced; confirm does not promise actions', async function() {
        var L = await addSkillMd('---\nname: demo\ndescription: d2\nactions: [Run it, Audit]\n---\nnew body');
        assert.deepStrictEqual(lastSnack(L), ['Added 0 file(s); skill updated from SKILL.md', 'success']);
        assert.strictEqual(L.g.skills.demo.body, 'new body', 'body replaced');
        assert.strictEqual(L.g.skills.demo.description, 'd2', 'description replaced');
        assert.deepStrictEqual(L.g.skills.demo.actions, OLD, 'actions kept, not wiped with []');
        assert.strictEqual(L.g.saveSkill.calls.length, 1, 'saved once');
        assert.deepStrictEqual(L.g.saveSkill.calls[0][0].actions, OLD, 'the saved row keeps the actions');
        var msg = L.g.showConfirmModal.calls[0][1];
        assert.ok(/name, description, body\. /.test(msg) && !/and actions/.test(msg), 'confirm text: ' + msg);
    }, { tags: ['unit'], timeout: 5000 });
    test('control: a block list with a named item still replaces the actions (and the confirm says so)', async function() {
        var L = await addSkillMd('---\nname: demo\nactions:\n  - name: New Act\n    icon: play\n    show: [chat]\n---\nnew body');
        assert.strictEqual(lastSnack(L)[1], 'success');
        assert.deepStrictEqual(L.g.skills.demo.actions, [{ name: 'New Act', icon: 'play', show: ['chat'] }]);
        assert.match(L.g.showConfirmModal.calls[0][1], /name, description, body and actions\. /);
    }, { tags: ['unit'], timeout: 5000 });
});
