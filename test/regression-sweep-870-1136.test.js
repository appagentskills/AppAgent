// Regression sweep over PRs #870-#1136 (fix/pr870-1136-regression-sweep).
// Real source excerpts run inside a Proxy-backed `with` scope: every global the
// excerpt touches resolves to an explicit override or a recording no-op stub.
// Run: run_tests { pattern: 'regression-sweep-870-1136' }
'use strict';

function decl(src, name) {
    var start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('missing declaration ' + name);
    var end = src.indexOf('\n}', start);
    var code = src.slice(start, end + 2);
    new Function(code);
    return code;
}
function scope(overrides, calls) {
    var stubs = {};
    return new Proxy(overrides, {
        has: function(t, k) { return typeof k === 'string' && k !== 'Promise' && k !== 'Object' && k !== 'Array' && k !== 'console' && k !== 'Date' && k !== 'JSON' && k !== 'Error'; },
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
function tick() { return new Promise(function(r) { setTimeout(r, 0); }); }

describe('sweep M1: Continue after cold-chat hydration (ui/170 selectChat)', function() {
    test('a message-evicted skeleton re-runs syncChatControlsUI once its messages are back', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var calls = [], el = { classList: { add: function() {}, remove: function() {}, contains: function() { return false; } } };
        var chats = { cold: { id: 'cold', _messagesEvicted: true, _payloadsEvicted: true } };
        var env = scope({
            chats: chats, runningChatIds: {}, currentChatId: 'other', currentView: 'chat', sidebarCollapsed: true,
            pendingInjectionsByChatId: {}, window: { innerWidth: 1024 }, lastApiError: null,
            appStorage: { setItem: function() {}, getItem: function() { return null; } },
            document: { getElementById: function() { return el; }, body: el },
            ensureChatPayloads: function(id) {
                return Promise.resolve().then(function() { chats[id].messages = [{ role: 'user', content: 'hi' }]; });
            },
            syncChatControlsUI: function(id) { calls.push(['sync', id, Array.isArray(chats[id] && chats[id].messages)]); }
        }, calls);
        var selectChat = run(decl(src, 'selectChat'), 'selectChat', env);
        selectChat('cold');
        var before = calls.filter(function(c) { return c[0] === 'sync'; });
        assert.ok(before.length >= 1 && before.every(function(c) { return c[2] === false; }), 'sync derive ran on the skeleton only');
        await tick(); await tick();
        var hydrated = calls.filter(function(c) { return c[0] === 'sync' && c[2] === true; });
        assert.strictEqual(hydrated.length, 1, 'controls re-derived after hydration');
        assert.strictEqual(hydrated[0][1], 'cold');
    }, { tags: ['unit'] });
});

describe('sweep M4: panel-hello must not carry the pre-load bundle-default provider', function() {
    test('hello sends "" until init loads the stored provider, then init pushes it', async function() {
        var src = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        var posts = [], calls = [];
        var env = scope({
            currentProvider: 'Opus 5.5', _inflightToolCalls: {}, _completedToolResults: {},
            _agentBusPort: { postMessage: function(m) { posts.push(m); } }
        }, calls);
        var api = run('var _panelProviderLoaded = false;\n' + decl(src, '_panelHelloProvider') + '\n' + decl(src, '_sendPanelHello'),
            '{ hello: _sendPanelHello, setLoaded: function(v) { _panelProviderLoaded = v; } }', env);
        api.hello();
        assert.strictEqual(posts[0].type, 'panel-hello');
        assert.strictEqual(posts[0].currentProvider, '', 'pre-load hello carries no provider (SW keeps its stored fallback)');
        env.currentProvider = 'Sonnet X';
        api.setLoaded(true);
        api.hello();
        assert.strictEqual(posts[1].currentProvider, 'Sonnet X');
        var init = await loadFile('src/js/core/120-init.js');
        var i = init.indexOf('await loadProviderFromStorage();');
        var after = init.slice(i, i + 600);
        assert.ok(i > 0 && /_panelProviderLoaded = true/.test(after) && /pushProviderChangeToOffscreen\(currentProvider\)/.test(after), 'init flips the flag and pushes the loaded provider');
    }, { tags: ['unit'] });

    test('SW _swAdoptProvider ignores the empty pre-load hello value (fallback stays armed)', async function() {
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var env = scope({ currentProvider: 'Opus 5.5', setSetting: function() { return Promise.resolve(); } }, []);
        var api = run('var _swProviderAdopted = false;\n' + decl(src, '_swAdoptProvider'),
            '{ adopt: _swAdoptProvider, adopted: function() { return _swProviderAdopted; } }', env);
        api.adopt('');
        assert.strictEqual(api.adopted(), false);
        assert.strictEqual(env.currentProvider, 'Opus 5.5');
        api.adopt('Sonnet X');
        assert.strictEqual(api.adopted(), true);
        assert.strictEqual(env.currentProvider, 'Sonnet X');
    }, { tags: ['unit'] });
});

describe('sweep M3: #1134 strings are in every locale catalog', function() {
    test('the 8 PR-diff viewer keys exist (non-empty) in all 24 catalogs, {path} preserved', async function() {
        var keys = ['Added', 'GitHub is not available in this build.', 'Modified', 'No text diff available for this file.',
            'Open on GitHub', 'Patch', 'Renamed', 'renamed from {path}'];
        var codes = ['ar', 'cs', 'da', 'de', 'es', 'fi', 'fr-CA', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'nb', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ru', 'sv', 'th', 'tr', 'zh-CN', 'zh-TW'];
        for (var i = 0; i < codes.length; i++) {
            var cat = JSON.parse(await loadFile('src/locales/' + codes[i] + '.json'));
            keys.forEach(function(k) { assert.ok(typeof cat[k] === 'string' && cat[k] !== '', codes[i] + ': ' + k); });
            assert.ok(cat['renamed from {path}'].indexOf('{path}') >= 0, codes[i] + ' keeps {path}');
        }
    }, { tags: ['unit'] });
});
