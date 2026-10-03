// Regression sweep over PRs #870-#1136, part 3 (RM1, m12, m4, m6, m8, m10, m14).
// Same harness as regression-sweep-870-1136-part2.test.js: real source excerpts
// run inside a Proxy-backed `with` scope; unknown globals are recording no-op stubs.
// Run: run_tests { pattern: 'regression-sweep-870-1136-part3' }
'use strict';

// Balanced-brace extraction (works for indented functions inside IIFEs too).
function decl(src, name) {
    var start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('missing declaration ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
    var i = src.indexOf('{', src.indexOf(')', start)), depth = 0, q = null;
    for (; i < src.length; i++) {
        var c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    var code = src.slice(start, i + 1);
    new Function(code);
    return code;
}
function scope(overrides, calls) {
    var stubs = {};
    var builtins = { Promise: 1, Object: 1, Array: 1, console: 1, Date: 1, JSON: 1, Error: 1, String: 1, Number: 1, Math: 1, Boolean: 1, RegExp: 1, undefined: 1, encodeURIComponent: 1, setTimeout: 1 };
    return new Proxy(overrides, {
        has: function(t, k) { return typeof k === 'string' && !builtins[k]; },
        get: function(t, k) {
            if (k === Symbol.unscopables) return undefined;
            if (k in t) return t[k];
            if (!stubs[k]) stubs[k] = function() { calls.push([k].concat([].slice.call(arguments))); };
            return stubs[k];
        },
        set: function(t, k, v) { t[k] = v; return true; }
    });
}
function run(code, ret, env) { return new Function('env', 'with (env) {\n' + code + '\nreturn ' + ret + ';\n}')(env); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ── RM1: wsMove CAS ────────────────────────────────────────────────────
describe('sweep RM1 (#959): wsMove never loses a concurrent edit', function() {
    var SRC = 'o/r::main', TGT = 'o/r::fork';
    async function harness(hooks) {
        var tools = await loadFile('src/js/tools/020-tool-execution.js');
        var idb = await loadFile('src/js/core/130-indexeddb.js');
        var calls = [], store = {};
        function key(repo, path) { return repo + '::' + path; }
        function put(r) { store[key(r.repo, r.path)] = clone(r); }
        put({ id: SRC + '::a.js', repo: SRC, path: 'a.js', sha: 's1', content: 'v2', original_content: 'v1', dirty: true, deleted: false, last_modified_at: 100, last_modified_by_chat_id: 'c1' });
        put({ id: TGT + '::a.js', repo: TGT, path: 'a.js', sha: 's1', content: 'v1', original_content: 'v1', dirty: false, deleted: false });
        var reads = {};
        var env = scope({
            getWorkspaceMeta: async function(wk) { return { repo: wk, branch: wk.split('::')[1] }; },
            getAllWorkspaceFiles: async function(wk) { return Object.keys(store).filter(function(k) { return store[k].repo === wk; }).map(function(k) { return clone(store[k]); }); },
            getWorkspaceFile: async function(wk, p) {
                var n = reads[wk] = (reads[wk] || 0) + 1;
                if (hooks && hooks.onRead) hooks.onRead(wk, n, store, put);
                return clone(store[key(wk, p)]) || null;
            },
            setWorkspaceFile: async function(r) { put(r); },
            setWorkspaceFileIf: async function(repo, path, expected, newRow) {
                var cur = store[key(repo, path)] || null;
                if (_wsRowRevision(cur) !== _wsRowRevision(expected)) return { ok: false, conflict: true, current: cur };
                if (newRow === null) delete store[key(repo, path)]; else put(newRow);
                return { ok: true };
            },
            wsDiscard: async function(wk, p, cid, ct, force, opts) {
                var cur = store[key(wk, p)];
                if (opts && opts.expected && _wsRowRevision(cur) !== _wsRowRevision(opts.expected)) return { success: false, conflict: true };
                cur.content = cur.original_content; cur.dirty = false; cur.last_modified_at = null; cur.last_modified_by_chat_id = null;
                return { success: true };
            },
            computeGitBlobSha: async function() { return 'x'; },
            newFileId: function() { return 'nf'; }
        }, calls);
        var _wsRowRevision = run(decl(idb, '_wsRowRevision'), '_wsRowRevision', env);
        env._wsRowRevision = _wsRowRevision;
        env._wsCasWrite = run(decl(tools, '_wsCasWrite'), '_wsCasWrite', env);
        var wsMove = run(decl(tools, 'wsMove'), 'wsMove', env);
        var res = await wsMove(SRC, TGT, null, false, 'c1', 'chat', true);
        return { res: res, store: store };
    }
    test('happy path: target gets the edit, source is discarded', async function() {
        var h = await harness();
        assert.deepStrictEqual(h.res.moved, ['a.js']);
        assert.strictEqual(h.store[TGT + '::a.js'].content, 'v2');
        assert.strictEqual(h.store[SRC + '::a.js'].dirty, false);
    }, { tags: ['unit'] });
    test('source edited after planning: not moved, source keeps the newer edit, flagged', async function() {
        var h = await harness({ onRead: function(wk, n, store) {
            // first TARGET read = pass-1 plan; edit the source right after it.
            if (wk === TGT && n === 1) { var s = store[SRC + '::a.js']; s.content = 'v3'; s.last_modified_at = 200; }
        } });
        assert.deepStrictEqual(h.res.moved, []);
        assert.deepStrictEqual(h.res.changed_during_move, ['a.js']);
        assert.strictEqual(h.store[SRC + '::a.js'].content, 'v3');
        assert.strictEqual(h.store[SRC + '::a.js'].dirty, true);
        assert.strictEqual(h.store[TGT + '::a.js'].content, 'v1');
    }, { tags: ['unit'] });
    test('target changed after planning: target not overwritten, source untouched', async function() {
        var h = await harness({ onRead: function(wk, n, store) {
            // first SOURCE read = pass-2 pre-check; edit the target then.
            if (wk === SRC && n === 1) { var t = store[TGT + '::a.js']; t.content = 'T-own'; t.dirty = true; t.last_modified_at = 300; }
        } });
        assert.deepStrictEqual(h.res.moved, []);
        assert.deepStrictEqual(h.res.target_changed, ['a.js']);
        assert.strictEqual(h.store[TGT + '::a.js'].content, 'T-own');
        assert.strictEqual(h.store[SRC + '::a.js'].content, 'v2');
        assert.strictEqual(h.store[SRC + '::a.js'].dirty, true);
    }, { tags: ['unit'] });
});

// ── m14: wsDiscard of a file deleted locally AND on the remote ────────
describe('sweep m14 (#1027/#1028): discard resolves local+remote deletion', function() {
    test('row is dropped instead of refused as remote_deleted', async function() {
        var tools = await loadFile('src/js/tools/020-tool-execution.js');
        var calls = [], store = { 'gone.js': { id: 'w::gone.js', repo: 'o/r::main', path: 'gone.js', sha: 's1', content: null, original_content: 'x', dirty: true, deleted: true, file_id: 'f1' } };
        var env = scope({
            getWorkspaceMeta: async function() { return { repo: 'o/r::main', branch: 'main', github_repo: 'o/r' }; },
            getAllWorkspaceFiles: async function() { return Object.keys(store).map(function(k) { return clone(store[k]); }); },
            githubApi: async function(m, url) {
                if (/git\/ref\//.test(url)) return { ok: true, body: { object: { sha: 'head' } } };
                return { ok: true, body: { tree: [{ type: 'blob', path: 'other.js', sha: 'o1' }] } };
            },
            _wsForkNeverPushed: function() { return false; },
            _wsCasWrite: async function(repo, path, exp, nr) { if (nr === null) delete store[path]; return { ok: true }; }
        }, calls);
        var wsDiscard = run(decl(tools, 'wsDiscard'), 'wsDiscard', env);
        var r = await wsDiscard('o/r::main', 'gone.js', 'c1', 't', true, { remoteCheck: true });
        assert.ok(!r.remote_deleted, 'must not refuse as remote_deleted');
        assert.ok(!store['gone.js'], 'row dropped: ' + JSON.stringify(r).slice(0, 300) + ' calls=' + calls.map(function(c) { return c[0]; }).join(','));
    }, { tags: ['unit'] });
});

// ── m6: setWorkspacePin must not claim success when the patch missed ──
describe('sweep m6: setWorkspacePin checks patchWorkspaceMeta', function() {
    test('row vanished before the patch → success:false', async function() {
        var tools = await loadFile('src/js/tools/020-tool-execution.js');
        var env = scope({
            getWorkspaceMeta: async function(wk) { return { repo: wk }; },
            getAllWorkspaceMetas: async function() { return []; },
            parseWsKey: function(wk) { return { repo: wk.split('::')[0] }; },
            patchWorkspaceMeta: async function() { return false; }
        }, []);
        var setWorkspacePin = run(decl(tools, 'setWorkspacePin'), 'setWorkspacePin', env);
        var r = await setWorkspacePin('o/r::main', false);
        assert.strictEqual(r.success, false);
    }, { tags: ['unit'] });
});

// ── m12: toggleToolCallExpanded only reacts to its own <summary> ──────
describe('sweep m12: tool-call expand state ignores body clicks', function() {
    async function harness(target) {
        var src = await loadFile('src/js/ui/120-ui-utils.js');
        var msg = { toolCallsExpanded: { 0: true } };
        var env = scope({ chats: { c: { messages: [msg] } }, currentChatId: 'c', window: { event: { type: 'click', target: target } } }, []);
        var fn = run(decl(src, 'toggleToolCallExpanded'), 'toggleToolCallExpanded', env);
        return { fn: fn, msg: msg };
    }
    test('click inside the body does not flip the stored state', async function() {
        var details = { open: true };
        var bodyEl = { closest: function() { return null; } };
        var h = await harness(bodyEl);
        h.fn(0, 0, details);
        assert.strictEqual(h.msg.toolCallsExpanded[0], true);
    }, { tags: ['unit'] });
    test('click on a NESTED details summary does not flip the outer state', async function() {
        var details = { open: true }, nested = { open: false };
        var h = await harness({ closest: function() { return { parentNode: nested }; } });
        h.fn(0, 0, details);
        assert.strictEqual(h.msg.toolCallsExpanded[0], true);
    }, { tags: ['unit'] });
    test('click on its own summary toggles', async function() {
        var details = { open: true };
        var h = await harness({ closest: function() { return { parentNode: details }; } });
        h.fn(0, 0, details);
        assert.strictEqual(h.msg.toolCallsExpanded[0], false);
    }, { tags: ['unit'] });
});

// ── m10: content-script editable helpers on XHTML (lowercase tagName) ─
describe('sweep m10 (#996): isEditableTarget accepts lowercase tagName', function() {
    test('XHTML <input> is editable and setEditableValue writes value', async function() {
        var src = await loadFile('src/platform/extension/content-script.js');
        var env = scope({ editableHost: function() { return null; }, window: {} }, []);
        var isEditableTarget = run(decl(src, 'isEditableTarget'), 'isEditableTarget', env);
        var setEditableValue = run(decl(src, 'setEditableValue'), 'setEditableValue', env);
        var el = { nodeType: 1, tagName: 'input', value: '' };
        assert.strictEqual(isEditableTarget(el), true);
        setEditableValue(el, 'hi');
        assert.strictEqual(el.value, 'hi');
    }, { tags: ['unit'] });
});

// ── m8: local_folder request accepts the "Agent Files" label ──────────
describe('sweep m8 (#1055): request folder:"Agent Files" is the virtual folder', function() {
    test('no Unknown folder error for the label', async function() {
        var src = await loadFile('src/js/tools/170-local-folders.js');
        var env = scope({
            LOCAL_FOLDER_VIRTUAL_ID: 'virtual', LOCAL_FOLDER_VIRTUAL_LABEL: 'Agent Files',
            _lfDeps: { promptUser: async function() { return { success: false }; } },
            _lfFindRow: async function() { return null; }
        }, []);
        var _lfRequest = run(decl(src, '_lfRequest'), '_lfRequest', env);
        var r = await _lfRequest({ action: 'request', folder: 'Agent Files' }, {});
        assert.ok(!/Unknown folder/.test(String(r && r.error)), 'got: ' + JSON.stringify(r));
    }, { tags: ['unit'] });
});

// ── m4: refused send keeps the queued injection ───────────────────────
describe('sweep m4 (#1111): pendingInjection cleared only after the skeleton guard', function() {
    test('clear happens after the storage-unavailable early return', async function() {
        var src = await loadFile('src/js/app/040-send-message.js');
        var body = decl(src, 'sendMessage');
        var guard = body.indexOf("Storage unavailable");
        var clear = body.indexOf('pendingInjection = null;');
        assert.ok(guard > 0 && clear > guard, 'pendingInjection must be cleared after the skeleton guard');
    }, { tags: ['unit'] });
});
