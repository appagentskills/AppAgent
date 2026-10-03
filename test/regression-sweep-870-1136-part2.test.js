// Regression sweep over PRs #870-#1136, part 2 (fix/pr870-1136-regression-sweep-part2).
// Same harness as regression-sweep-870-1136.test.js: real source excerpts run
// inside a Proxy-backed `with` scope; unknown globals are recording no-op stubs.
// Run: run_tests { pattern: 'regression-sweep-870-1136-part2' }
'use strict';

function decl(src, name) {
    var start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('missing declaration ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
    var end = src.indexOf('\n}', start);
    var code = src.slice(start, end + 2);
    new Function(code);
    return code;
}
function scope(overrides, calls) {
    var stubs = {};
    return new Proxy(overrides, {
        has: function(t, k) { return typeof k === 'string' && k !== 'Promise' && k !== 'Object' && k !== 'Array' && k !== 'console' && k !== 'Date' && k !== 'JSON' && k !== 'Error' && k !== 'String' && k !== 'Number' && k !== 'Math' && k !== 'Boolean'; },
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
async function flush(n) { for (var i = 0; i < (n || 8); i++) await Promise.resolve(); }

describe('sweep M8: sleepSelf must not deliver a previous episode\'s report', function() {
    async function harness(lastReportAt, wokenAt) {
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        var calls = [], settled = [];
        var rec = { agent_id: 'a1', name: 'sub', state: 'running', spawn_handle_id: 'h1', chat_id: 'c1',
            last_report: { status: 'done', summary: 'OLD episode report', at: lastReportAt }, woken_at: wokenAt };
        var env = scope({
            chats: { c1: { isSubAgent: true, subAgentId: 'a1' } }, _subAgents: { a1: rec }, _spawnDeferreds: { h1: {} },
            _spawnHandleHasAwaiters: function() { return false; },
            _resolveSpawnHandle: function(id, rep) { settled.push(rep); }
        }, calls);
        var sleepSelf = run(decl(src, 'sleepSelf'), 'sleepSelf', env);
        var res = sleepSelf({ reason: 'parking' }, { chatId: 'c1' });
        return { res: res, rec: rec, settled: settled };
    }
    test('woken after the old report: the settle is a synthetic need_input, not the stale done', async function() {
        var h = await harness(1000, 2000);
        assert.strictEqual(h.res.success, true);
        assert.strictEqual(h.settled.length, 1);
        assert.strictEqual(h.settled[0].status, 'need_input');
        assert.strictEqual(h.settled[0].summary, 'parking');
        assert.strictEqual(h.rec.last_report._synthesized, true);
    }, { tags: ['unit'] });
    test('a report from this episode (at >= woken_at) is still kept', async function() {
        var h = await harness(3000, 2000);
        assert.strictEqual(h.settled[0].status, 'done');
        assert.strictEqual(h.settled[0].summary, 'OLD episode report');
    }, { tags: ['unit'] });
});

describe('sweep M6: Delete All lifts the SW save lock when only the page reloads', function() {
    async function harness(chromeExtra) {
        var src = await loadFile('src/js/ui/130-data-management.js');
        var calls = [], msgs = [], reloads = 0;
        var runtime = Object.assign({ sendMessage: function(m, cb) { msgs.push(m); cb({ ok: true }); } }, chromeExtra || {});
        var tx = { objectStore: function() { return { clear: function() {} }; } };
        var env = scope({
            chrome: { runtime: runtime }, window: { location: { reload: function() { reloads++; } } },
            setTimeout: setTimeout, clearTimeout: clearTimeout, DELETE_ALL_CALL_TIMEOUT_MS: 500,
            DELETE_ALL_STORES: ['chats'], DELETE_ALL_LOGOUT_MESSAGES: [], DELETE_ALL_LOCAL_KEYS: [],
            runningChatIds: {}, appStorage: { setItem: function() {} }, WidgetStore: { clearCache: function() {} },
            showConfirmModal: function() { return Promise.resolve(true); },
            openDatabase: function() {
                return Promise.resolve({ objectStoreNames: { contains: function() { return true; } },
                    transaction: function() { setTimeout(function() { tx.oncomplete(); }, 0); return tx; } });
            }
        }, calls);
        var code = ['_restartIsPageOnly', '_restartAfterImport', '_deleteAllCall', '_deleteAllLocalSecrets', 'deleteAllData']
            .map(function(n) { return decl(src, n); }).join('\n');
        var api = run(code, '{ del: deleteAllData, pageOnly: _restartIsPageOnly }', env);
        return { api: api, msgs: msgs, reloads: function() { return reloads; }, env: env };
    }
    test('page-only restart (no chrome.runtime.reload): lock ON, then OFF before the reload', async function() {
        var h = await harness();
        await h.api.del();
        var locks = h.msgs.filter(function(m) { return m.type === 'delete-all-save-lock'; }).map(function(m) { return m.locked; });
        assert.deepStrictEqual(locks, [true, false]);
        assert.strictEqual(h.reloads(), 1);
    }, { tags: ['unit'] });
    test('_restartIsPageOnly: true while a build is in flight, false for a full extension restart', async function() {
        var h = await harness({ reload: function() {} });
        h.env._reloadBuildInFlight = false;
        assert.strictEqual(h.api.pageOnly(), false);
        h.env._reloadBuildInFlight = true;
        assert.strictEqual(h.api.pageOnly(), true);
    }, { tags: ['unit'] });
});

describe('sweep M5: waitForOffscreenReady zombie self-heal is bounded and identity-checked', function() {
    async function harness(closeImpl) {
        var bg = await loadFile('src/platform/extension/background.js');
        var calls = [], timers = [], creates = 0;
        var env = scope({
            _swOffscreenKeepAlivePort: null, _swOffscreenHealing: null, _swOffscreenClosing: null,
            _swOffscreenReadyResolvers: [], _swOffscreenLastError: null,
            setTimeout: function(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; }, clearTimeout: function() {},
            self: { getP4Flag: function(n) { return n === 'P4_OFFSCREEN_SELF_HEAL'; } },
            chrome: { offscreen: { hasDocument: function() { return Promise.resolve(true); }, closeDocument: closeImpl } },
            ensureOffscreenDocument: function() { creates++; return Promise.resolve(); },
            persistenceBusyReason: function() { return ''; }
        }, calls);
        var wait = run(decl(bg, '_swOffscreenWithin') + '\n' + decl(bg, 'waitForOffscreenReady'), 'waitForOffscreenReady', env);
        return { wait: wait, env: env, timers: timers, creates: function() { return creates; } };
    }
    test('a closeDocument that never settles is dropped after 5s: heal slot cleared, coded error, re-wait', async function() {
        var h = await harness(function() { return new Promise(function() {}); });
        var p = h.wait(5000); await flush();
        h.timers[0].fn(); await flush(12);
        var closeTimer = h.timers.filter(function(t) { return t.ms === 5000; })[1];
        assert.ok(closeTimer, 'the close wait is bounded by a 5s timer');
        closeTimer.fn(); await flush(12);
        assert.strictEqual(h.env._swOffscreenHealing, null, 'heal slot released');
        assert.strictEqual(h.env._swOffscreenClosing, null);
        assert.strictEqual(h.env._swOffscreenLastError && h.env._swOffscreenLastError.code, 'OFFSCREEN_CLOSE_TIMEOUT');
        assert.strictEqual(h.creates(), 2, 'recreated after the dropped close');
        h.env._swOffscreenReadyResolvers.splice(0).forEach(function(fn) { fn(); });
        assert.strictEqual(await p, true);
    }, { tags: ['unit'] });
    test('a close settling after a fresh document connected does not null its port', async function() {
        var release;
        var h = await harness(function() { return new Promise(function(r) { release = r; }); });
        var p = h.wait(5000); await flush();
        h.timers[0].fn(); await flush(12);
        var fresh = { name: 'fresh-port' };
        h.env._swOffscreenKeepAlivePort = fresh;
        release(); await flush(12);
        assert.strictEqual(h.env._swOffscreenKeepAlivePort, fresh);
        assert.strictEqual(await p, true);
    }, { tags: ['unit'] });
});

describe('sweep M7/m9: toggleWidgetRunning tears down dashboard lazy mounts and per-turn cards', function() {
    function el(id, attrs) {
        var e = { id: id, innerHTML: '', _attrs: attrs || {}, querySelector: function() { return null; },
            getAttribute: function(k) { return this._attrs[k] || null; } };
        return e;
    }
    async function harness() {
        var src = await loadFile('src/js/tools/080-widget-tools.js');
        var calls = [], unmounted = [], rendered = [];
        var inline = el('widget-content-w1'), older = el('widget-content-w1--r3'), dash = el('dashboard-widget-content-w1');
        var olderCard = el('widget-w1--r3', { 'data-render-version': '2' });
        older.closest = function() { return olderCard; };
        inline.closest = function() { return el('widget-w1'); };
        var byId = { 'widget-content-w1': inline, 'dashboard-widget-content-w1': dash };
        var widget = { id: 'w1', deactivated: false };
        var env = scope({
            document: {
                getElementById: function(id) { return byId[id] || null; },
                querySelectorAll: function(sel) { return sel.indexOf('.widget-stop-btn') === 0 ? [] : [inline, older]; }
            },
            getWidgetById: function() { return widget; }, dashboardWidgets: { w1: { id: 'w1' } },
            escapeHtml: function(s) { return String(s); }, t: function(s) { return s; }, UI_ICONS: {},
            unmountWidgetContainer: function(c) { unmounted.push(c.id); c.__widgetLazyObs = null; },
            renderWidgetInContainer: function(w, c, o) { rendered.push([c.id, o || null]); return null; },
            renderWidgetContent: function() { rendered.push(['dash', null]); },
            WidgetStore: { view: function(id, v) { return v ? { html: '<p>v' + v + '</p>' } : null; } }
        }, calls);
        var toggle = run(decl(src, 'toggleWidgetRunning'), 'toggleWidgetRunning', env);
        return { toggle: toggle, unmounted: unmounted, rendered: rendered, inline: inline, older: older, dash: dash };
    }
    test('deactivate: dashboard container fully unmounted (lazy observer gone), every card placeholdered', async function() {
        var h = await harness();
        h.toggle('w1');
        assert.deepStrictEqual(h.unmounted, ['dashboard-widget-content-w1']);
        [h.inline, h.older, h.dash].forEach(function(c) { assert.ok(/Widget deactivated/.test(c.innerHTML), c.id); });
    }, { tags: ['unit'] });
    test('reactivate: the per-turn card re-renders with its pinned version', async function() {
        var h = await harness();
        h.toggle('w1'); h.toggle('w1');
        var older = h.rendered.filter(function(r) { return r[0] === 'widget-content-w1--r3'; });
        assert.strictEqual(older.length, 1);
        assert.strictEqual(older[0][1].pinnedVersion, 2);
        assert.strictEqual(older[0][1].version, 2);
        var canonical = h.rendered.filter(function(r) { return r[0] === 'widget-content-w1'; });
        assert.strictEqual(canonical.length, 1);
        assert.strictEqual(canonical[0][1], null, 'unpinned card renders latest');
    }, { tags: ['unit'] });
});
