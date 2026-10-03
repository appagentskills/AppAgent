// Regression sweep over PRs #870-#1136, part 4 (M2, Rm1-Rm8); m2 deferred.
// Same harness as part3: real source excerpts run inside a Proxy-backed `with`
// scope; unknown globals are recording no-op stubs.
'use strict';

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
    var builtins = { Promise: 1, Object: 1, Array: 1, console: 1, Date: 1, JSON: 1, Error: 1, String: 1, Number: 1, Math: 1, Boolean: 1, RegExp: 1, undefined: 1, setTimeout: 1 };
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

function fakeEl(attrs, hasIframe) {
    return { attrs: attrs, getAttribute: function(k) { return k in attrs ? attrs[k] : null; },
        querySelector: function(s) { return (hasIframe && /iframe/.test(s)) ? {} : null; } };
}

describe('sweep M2 (#1130): per-turn widget cards park/reclaim by (id, turn)', function() {
    it('keys by widget id + render turn and finds the matching placeholder', async function() {
        var src = await loadFile('src/js/ui/250-message-render.js');
        var code = decl(src, '_parkedWidgetKey') + '\n' + decl(src, '_findWidgetPlaceholder');
        var env = scope({ CSS: { escape: function(s) { return String(s); } } }, []);
        var fns = run(code, '{ key: _parkedWidgetKey, find: _findWidgetPlaceholder }', env);
        var older = fakeEl({ 'data-widget-id': 'w1', 'data-render-msg': '3' }, true);
        var newer = fakeEl({ 'data-widget-id': 'w1', 'data-render-msg': '9' }, true);
        assert.notStrictEqual(fns.key(older), fns.key(newer));
        assert.strictEqual(fns.key(fakeEl({ 'data-widget-id': 'w2' })), 'w2');
        var ph3 = fakeEl({ 'data-widget-id': 'w1', 'data-render-msg': '3' }), ph9 = fakeEl({ 'data-widget-id': 'w1', 'data-render-msg': '9' });
        var seen = [];
        var root = { querySelectorAll: function(sel) { seen.push(sel); return [ph3, ph9].filter(function(p) { return sel.indexOf('[data-render-msg="' + p.attrs['data-render-msg'] + '"]') !== -1; }); } };
        assert.strictEqual(fns.find(root, newer), ph9);
        assert.strictEqual(fns.find(root, older), ph3);
        assert.ok(/data-widget-id="w1"\]\[data-render-msg="9"\]/.test(seen[0]));
    });
    it('render path uses the keyed park + placeholder lookup', async function() {
        var src = await loadFile('src/js/ui/250-message-render.js');
        assert.ok(src.indexOf('savedWidgets[key] = wi;') !== -1);
        assert.ok(src.indexOf('_findWidgetPlaceholder(rebuildRoot, savedWidgets[swid])') !== -1);
        assert.ok(src.indexOf("savedWidgets[wid] = wi;") === -1);
    });
});

describe('sweep Rm1 (#952): unsent-image restore follows the live-list owner', function() {
    it('restore checks getPendingImagesOwnerContext and re-stamps the owner', async function() {
        var src = await loadFile('src/js/app/040-send-message.js');
        assert.ok(/getPendingImagesOwnerContext\(\) === _chatId/.test(src));
        assert.ok(/if \(_ownsLive\) \{[\s\S]{0,200}setPendingImagesOwner\(_chatId\)/.test(src));
    });
});

describe('sweep Rm2 (#998): widget capture snapshot hygiene', function() {
    it('serialize-for-capture redacts secret inputs; listener checks ev.source; key is single-use', async function() {
        var dash = await loadFile('src/js/ui/070-dashboard-ui.js');
        var i = dash.indexOf('__appagentSerializeForCapture'), seg = dash.slice(i, i + 3000);
        assert.ok(seg.indexOf('[redacted]') !== -1 && seg.indexOf('_scS') !== -1);
        var shot = await loadFile('src/js/tools/060-take-screenshot.js');
        assert.ok(shot.indexOf('ev.source !== widgetIframe.contentWindow') !== -1);
        var init = await loadFile('src/js/core/120-init.js');
        assert.ok(/chrome\.storage\.local\.remove\('__appagent_widget_snapshot__'\)/.test(init));
    });
});

describe('sweep Rm3 (#959): hydration write is CAS', function() {
    it('_applyContent writes through _wsCasWrite with the pre-mutation snapshot', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var body = decl(src, '_applyContent');
        assert.ok(body.indexOf('_wsCasWrite(wk, stub.path, _hydExpected, rec)') !== -1);
        assert.ok(body.indexOf('await setWorkspaceFile(rec)') === -1);
    });
});

describe('sweep Rm4 (#959): CAS fingerprint sees push stamps', function() {
    it('pushed_shas / pushed_pr / changed_since_push change the revision', async function() {
        var src = await loadFile('src/js/core/130-indexeddb.js');
        var rev = run(decl(src, '_wsRowRevision'), '_wsRowRevision', scope({}, []));
        var base = { sha: 'a', dirty: true, content: 'x' };
        assert.notStrictEqual(rev(base), rev(Object.assign({}, base, { pushed_shas: ['x'] })));
        assert.notStrictEqual(rev(base), rev(Object.assign({}, base, { pushed_pr: 7 })));
        assert.notStrictEqual(rev(base), rev(Object.assign({}, base, { changed_since_push: true })));
        assert.strictEqual(rev(base), rev(Object.assign({}, base, { stub: true })));
        assert.strictEqual(rev(null), null);
    });
});

describe('sweep Rm5 (#1009): Enter on a chat row refocuses after a deferred render', function() {
    it('flushes the trailing render then focuses the new row', async function() {
        var src = await loadFile('src/js/ui/180-search.js');
        var calls = [], newRow = { getAttribute: function() { return 'c1'; }, focus: function() { env.document.activeElement = newRow; } };
        var oldRow = {};
        var env = scope({
            _chatListTrailingTimer: 1,
            _renderChatListNow: function() { env._chatListTrailingTimer = null; calls.push('flush'); env.document.activeElement = env.document.body; },
            selectChat: function() { calls.push('select'); },
            document: { body: { b: 1 }, activeElement: oldRow, getElementById: function() { return { querySelectorAll: function() { return [newRow]; } }; } }
        }, calls);
        var fn = run(decl(src, 'chatItemKeydown'), 'chatItemKeydown', env);
        fn({ target: oldRow, key: 'Enter', preventDefault: function() {} }, oldRow, 'c1');
        assert.deepStrictEqual(calls.slice(0, 2), ['select', 'flush']);
        assert.strictEqual(env.document.activeElement, newRow);
    });
});

describe('sweep Rm6 (#1088): drop on a not-granted folder never calls requestPermission', function() {
    it('drop handler short-circuits needsGrant targets', async function() {
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        var body = decl(src, 'sdocBindAgentFilesDrop');
        assert.ok(/dtg && dtg\.needsGrant\) \{[^}]*return; \}/.test(body));
    });
});

describe('sweep Rm7 (#1007): Delete All clears appStorage prefs', function() {
    it('removes prefixed keys but keeps the post-restart notice', async function() {
        var src = await loadFile('src/js/ui/130-data-management.js');
        var store = { 'p_showApiStats': 'true', 'p_appagentPostImportNotice': '{}', 'other': '1', 'p_layout': 'x' };
        var ls = { get length() { return Object.keys(store).length; }, key: function(i) { return Object.keys(store)[i]; }, removeItem: function(k) { delete store[k]; } };
        var env = scope({ window: { localStorage: ls }, STORAGE_PREFIX: 'p_', POST_IMPORT_NOTICE_KEY: 'appagentPostImportNotice' }, []);
        var n = run(decl(src, '_deleteAllAppStorage'), '_deleteAllAppStorage()', env);
        assert.strictEqual(n, 2);
        assert.deepStrictEqual(Object.keys(store).sort(), ['other', 'p_appagentPostImportNotice']);
        assert.ok(decl(src, 'deleteAllData').indexOf('_deleteAllAppStorage();') !== -1);
    });
});

describe('sweep Rm8 (#1007): tier menu confirms only real saves', function() {
    async function go(impl) {
        var src = await loadFile('src/js/ui/160-notifications.js'), snacks = [];
        var env = scope({ setTierAlias: impl, t: function(s) { return s; }, showSnackbar: function(m, k) { snacks.push(k); } }, []);
        var res = await run(decl(src, 'setTierAliasFromMenu'), 'setTierAliasFromMenu', env)('small', 'p');
        return { res: res, snacks: snacks };
    }
    it('success -> info snackbar', async function() { var r = await go(async function() { return true; }); assert.deepStrictEqual(r.snacks, ['info']); assert.strictEqual(r.res, true); });
    it('false -> no success snackbar', async function() { var r = await go(async function() { return false; }); assert.deepStrictEqual(r.snacks, []); });
    it('reject -> only error snackbar, no unhandled rejection', async function() { var r = await go(async function() { throw new Error('boom'); }); assert.deepStrictEqual(r.snacks, ['error']); assert.strictEqual(r.res, false); });
});

describe('sweep Rm2 generated snapshot serializer', function() {
    it('executes generated code and removes password and autocomplete secrets', async function() {
        var src = await loadFile('src/js/ui/070-dashboard-ui.js');
        var start = src.indexOf("'var _scH=");
        var end = src.indexOf("'var _scW=", start);
        var generated = new Function('return ' + src.slice(start, end) + "'';")();
        var doc = new DOMParser().parseFromString('<html><body><input type="password" value="secret-pw"><input autocomplete="section-login current-password" value="secret-auto"><input autocomplete="section-login one-time-code" value="secret-otp"><input value="ordinary"><p>secret-pw</p></body></html>', 'text/html');
        var result = new Function('document', 'DOMParser', generated + ';return _scH;')(doc, DOMParser);
        assert.ok(result.indexOf('secret-pw') === -1);
        assert.ok(result.indexOf('secret-auto') === -1);
        assert.ok(result.indexOf('secret-otp') === -1);
        assert.ok(result.indexOf('ordinary') !== -1);
        assert.ok(result.indexOf('[redacted]') !== -1);
    });
});

describe('sweep behavior: ownership, hydration race, drop grant', function() {
    it('history view does not merge restored chat images into Home draft', async function() {
        var src = await loadFile('src/js/app/040-send-message.js');
        var env = { _chatId: 'A', _images: ['X'], _f9TypedText: '', pendingInjectionsByChatId: {},
            getCurrentPendingContext: function() { return 'A'; }, getPendingImagesOwnerContext: function() { return 'home'; },
            pendingImageAttachments: ['H'], chatPendingImages: { home: ['H'] }, renderMessages: function() {} };
        run(decl(src, '_restoreUnsentInput'), '_restoreUnsentInput()', env);
        assert.deepStrictEqual(env.pendingImageAttachments, ['H']);
        assert.deepStrictEqual(env.chatPendingImages.home, ['H']);
        assert.deepStrictEqual(env.chatPendingImages.A, ['X']);
    });
    it('hydration loses CAS to tombstone without changing it or counting success', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var tomb = { path: 'x', sha: 's', deleted: true }, seen;
        var env = { wk: 'r::main', hydrated: 0, failed: [], lastError: null,
            getWorkspaceFile: async function() { return { path: 'x', sha: 's', stub: true }; },
            _wsCasWrite: async function(w, p, expected, next) { seen = { expected: expected, next: next }; return { ok: false, conflict: true, current: tomb }; } };
        var fn = run(decl(src, '_applyContent'), '_applyContent', env);
        await fn({ path: 'x', sha: 's' }, 'old blob');
        assert.strictEqual(seen.expected.stub, true);
        assert.strictEqual(seen.expected.content, undefined);
        assert.strictEqual(seen.next.content, 'old blob');
        assert.deepStrictEqual(tomb, { path: 'x', sha: 's', deleted: true });
        assert.strictEqual(env.hydrated, 0);
    });
    it('grant-required drop shows a warning without uploading; granted drop uploads', async function() {
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        var listeners = {}, uploads = 0, warnings = 0, needs = true;
        var host = { addEventListener: function(k, fn) { listeners[k] = fn; } };
        var zone = { getAttribute: function() { return 'local'; }, classList: { remove: function() {} } };
        var env = { sdocSrcState: { sel: 'local', path: '' }, sdocSrcById: function() { return {}; },
            sdocDropTarget: function() { return 'folder'; }, sdocUploadTarget: function() { return { needsGrant: needs }; },
            showSnackbar: function() { warnings++; }, _sdsT: function(s) { return s; }, sdocUploadToSource: function() { uploads++; } };
        run(decl(src, 'sdocBindAgentFilesDrop'), 'sdocBindAgentFilesDrop', env)(host);
        var ev = { target: { closest: function() { return zone; } }, preventDefault: function() {}, dataTransfer: { files: [{}] } };
        listeners.drop(ev); assert.strictEqual(warnings, 1); assert.strictEqual(uploads, 0);
        needs = false; listeners.drop(ev); assert.strictEqual(uploads, 1);
    });
});
