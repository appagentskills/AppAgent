// Wrong-chat attribution fallbacks (follow-up to PR #1354): nested callers
// (fromSandbox / fromWidget / parentToolCallId) must never inherit the
// activeStreamingChatId / currentChatId globals. The real source text of each
// changed function / statement block is evaluated with in-memory stubs.

function extractFn(src, name) {
    var m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
    if (!m) throw new Error('function not found: ' + name);
    var i = src.indexOf('{', m.index), depth = 0;
    for (var j = i; j < src.length; j++) {
        var c = src[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
    }
    throw new Error('unbalanced: ' + name);
}
function between(src, startMarker, endMarker) {
    var a = src.indexOf(startMarker);
    if (a < 0) throw new Error('marker not found: ' + startMarker);
    var b = src.indexOf(endMarker, a);
    if (b < 0) throw new Error('end marker not found: ' + endMarker);
    return src.slice(a, b + endMarker.length);
}
function build(code, ret, stubs) {
    var names = Object.keys(stubs);
    var f = new Function(names.join(','), code + '\nreturn ' + ret + ';');
    return f.apply(null, names.map(function(n) { return stubs[n]; }));
}

describe('A: widget bridge resolves the owning chat', function() {
    test('split pane / #messages / record / unresolved', async function() {
        var src = await loadFile('src/js/ui/070-dashboard-ui.js');
        var code = extractFn(src, '_widgetOwnerChatId');
        var store = { view: function(id) { return id === 'w_dash' ? { chatId: 'chat_owner' } : null; } };
        var fn = build(code, '_widgetOwnerChatId', { currentChatId: 'chat_fg', WidgetStore: store, chats: { chat_owner: {} }, _chatsHydrated: true });
        function chain(ids) { var n = null; ids.slice().reverse().forEach(function(id) { n = { id: id, parentNode: n, dataset: {} }; }); return n; }
        var pane = { id: 'split-widget-pane', dataset: { chatId: 'chat_pane' }, parentNode: null };
        assert.strictEqual(fn({ id: 'f', parentNode: pane }, 'w_x'), 'chat_pane');
        assert.strictEqual(fn(chain(['f', 'card', 'messages', 'main']), 'w_x'), 'chat_fg');
        // dashboard shadow render: hop through the shadow root host
        var host = { id: 'host', parentNode: chain(['dashboard-widget-content-w_dash', 'dash']) };
        var shadowRoot = { host: host, parentNode: null };
        assert.strictEqual(fn({ id: 'f', parentNode: shadowRoot }, 'w_dash'), 'chat_owner');
        // parked / unknown render with no record → null (fail closed), never the foreground chat
        assert.strictEqual(fn(chain(['f', 'body']), 'w_unknown'), null);
        assert.strictEqual(fn(chain(['f', 'widget-fullscreen-overlay', 'messages']), 'w_unknown'), null);
    }, { tags: ['unit'], timeout: 4000 });

    test('bridge passes the resolved id to executeTool and screenshot persistence', async function() {
        var src = await loadFile('src/js/ui/070-dashboard-ui.js');
        var block = between(src, 'var _ownerChatId = _widgetOwnerChatId(', 'saveChatsToStorage();');
        assert.match(block, /chatId: _ownerChatId, widgetName/);
        assert.match(block, /chats\[_ownerChatId\]/);
        assert.match(block, /type: 'screenshots_map', chatId: _ownerChatId/);
        assert.strictEqual(/currentChatId/.test(block), false);
    }, { tags: ['unit'], timeout: 4000 });
});

describe('B: js_eval / skill tool chat resolution', function() {
    var cases = [
        { opts: { chatId: 'c1', fromSandbox: true }, expect: 'c1' },
        { opts: { fromSandbox: true }, expect: null },
        { opts: { fromWidget: true }, expect: null },
        { opts: { parentToolCallId: 't1' }, expect: null },
        { opts: {}, expect: 'stream' },
        { opts: null, expect: 'stream' }
    ];
    async function check(path, start) {
        var src = await loadFile(path);
        var block = between(src, start, ';\n');
        // extend to the full chatId statement
        var idx = src.indexOf(block) + block.length;
        var stmt = src.slice(src.indexOf(block), src.indexOf(')));', idx) + 4);
        cases.forEach(function(c) {
            var got = build(stmt, 'chatId', { options: c.opts, activeStreamingChatId: 'stream', currentChatId: 'fg' });
            assert.strictEqual(got, c.expect, path + ' ' + JSON.stringify(c.opts));
        });
    }
    test('js_eval (020-tool-execution.js)', async function() { await check('src/js/tools/020-tool-execution.js', 'var _jsNested ='); }, { tags: ['unit'], timeout: 4000 });
    test('skill tool (140-skills-engine.js)', async function() { await check('src/js/core/140-skills-engine.js', 'var _skNested ='); }, { tags: ['unit'], timeout: 4000 });
});

describe('C: take_screenshot keeps the given chat', function() {
    async function load(chatsMap, calls) {
        var src = await loadFile('src/js/tools/060-take-screenshot.js');
        return build(extractFn(src, 'executeTakeScreenshot'), 'executeTakeScreenshot', {
            chats: chatsMap, currentChatId: 'chat_fg',
            ensureChatPayloads: async function(id) { calls.hydrated.push(id); },
            _ssCaptureSplitPaneInPlace: async function(a, w, id) { calls.captured.push(id); return { success: true, chat: id }; }
        });
    }
    test('cold chat id is kept (hydrated), not replaced by currentChatId', async function() {
        var calls = { hydrated: [], captured: [] };
        var fn = await load({}, calls);
        var r = await fn({ target: 'split_widget' }, { chatId: 'chat_cold', fromSandbox: true });
        assert.strictEqual(r.chat, 'chat_cold');
        assert.deepStrictEqual(calls.hydrated, ['chat_cold']);
    }, { tags: ['unit'], timeout: 4000 });
    test('nested without chatId fails closed; top-level falls back', async function() {
        var calls = { hydrated: [], captured: [] };
        var fn = await load({ chat_fg: {} }, calls);
        var r = await fn({ target: 'split_widget' }, { fromWidget: true });
        assert.strictEqual(r.code, 'CHAT_UNRESOLVED');
        assert.deepStrictEqual(calls.captured, []);
        var r2 = await fn({ target: 'split_widget' }, {});
        assert.strictEqual(r2.chat, 'chat_fg');
    }, { tags: ['unit'], timeout: 4000 });
});

describe('D: worker UI routing guard', function() {
    async function guard() {
        var src = await loadFile('src/js/worker/120-tool-routing.js');
        var block = between(src, 'var _nestedUi = ', "(_nestedUi ? null : activeStreamingChatId);");
        return function(name, args, options) {
            return build('var __r = (function(){' + block + '\nreturn { chatId: chatId }; })();', '__r',
                { name: name, args: args, options: options, activeStreamingChatId: 'stream' });
        };
    }
    test('any nested UI tool without chatId is refused', async function() {
        var g = await guard();
        ['iframe_tool', 'take_screenshot', 'prompt_user', 'update_action_state', 'html_widget', 'split_view', 'display'].forEach(function(n) {
            var r = g(n, { action: 'create' }, { fromSandbox: true });
            assert.strictEqual(r.code, 'CHAT_UNRESOLVED', n);
        });
        assert.strictEqual(g('iframe_tool', {}, { parentToolCallId: 'p' }).code, 'CHAT_UNRESOLVED');
    }, { tags: ['unit'], timeout: 4000 });
    test('chat-free reads, explicit chatIds and top-level calls pass', async function() {
        var g = await guard();
        ['list', 'read', 'export'].forEach(function(a) {
            assert.strictEqual(g('html_widget', { action: a }, { fromWidget: true }).chatId, null);
        });
        assert.strictEqual(g('get_skill', { skill_id: 'x' }, { fromSandbox: true }).chatId, null);
        // start_chat needs no source chat: an unresolved widget owner still opens one
        var sc = g('start_chat', { message: 'm', background: true }, { fromWidget: true });
        assert.strictEqual(sc.code, undefined);
        assert.strictEqual(sc.chatId, null);
        assert.strictEqual(g('start_chat', { message: 'm' }, { fromWidget: true, chatId: 'c3' }).chatId, 'c3');
        assert.strictEqual(g('iframe_tool', {}, { fromSandbox: true, chatId: 'c9' }).chatId, 'c9');
        assert.strictEqual(g('iframe_tool', {}, {}).chatId, 'stream');
    }, { tags: ['unit'], timeout: 4000 });
    test('chat-free tools stay allowed for nested chat-less callers', async function() {
        var g = await guard();
        // local_folder (incl. request + the _lfRouteToPanel re-dispatch), manage_skill, pin_widget
        [['local_folder', { action: 'ls' }], ['local_folder', { action: 'request', reason: 'r' }],
         ['local_folder', { action: 'write', path: 'a', _lf_panel_fallback: true }],
         ['manage_skill', { action: 'list' }], ['pin_widget', { widget_id: 'w' }]].forEach(function(c) {
            var r = g(c[0], c[1], { fromSandbox: true });
            assert.strictEqual(r.code, undefined, c[0] + ' ' + JSON.stringify(c[1]));
            assert.strictEqual(r.chatId, null);
        });
        // iframe_tool only with an explicit tab_id (0 is a valid id)
        assert.strictEqual(g('iframe_tool', { action: 'click', tab_id: 123 }, { fromWidget: true }).chatId, null);
        assert.strictEqual(g('iframe_tool', { action: 'click', tab_id: 0 }, { fromSandbox: true }).code, undefined);
        assert.strictEqual(g('iframe_tool', { action: 'click' }, { fromSandbox: true }).code, 'CHAT_UNRESOLVED');
        assert.strictEqual(g('iframe_tool', { action: 'click', tab_id: '' }, { fromSandbox: true }).code, 'CHAT_UNRESOLVED');
        assert.strictEqual(g('iframe_tool', { action: 'click', tab_id: null }, { fromSandbox: true }).code, 'CHAT_UNRESOLVED');
    }, { tags: ['unit'], timeout: 4000 });
    test('_lfRouteToPanel re-dispatches with the caller options (no chat swap)', async function() {
        var src = await loadFile('src/js/worker/120-tool-routing.js');
        var calls = [];
        var fn = build(extractFn(src, '_lfRouteToPanel'), '_lfRouteToPanel', {
            pickExecutorPort: function() { return {}; },
            executeTool: async function(n, a, mi, o) { calls.push({ n: n, a: a, o: o }); return { success: true }; },
            lfAdoptPanelFallbackResult: function(r) { return r; }
        });
        var opts = { fromSandbox: true };
        var r = await fn('local_folder', { action: 'request' }, 0, opts, { code: 'X', error: 'e' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(calls[0].o, opts);
        assert.strictEqual(calls[0].a._lf_panel_fallback, true);
    }, { tags: ['unit'], timeout: 4000 });
});

// Remaining fallbacks of the same class (review follow-ups). Each guard is
// inlined at its site; the real statement block is sliced and evaluated.
function runBlock(src, start, end, retExpr, stubs) {
    var block = between(src, start, end);
    return build('var __r = (function(){' + block + '\nreturn ' + retExpr + '; })();', '__r', stubs);
}
var NESTED_CASES = [
    { opts: { chatId: 'c1', fromSandbox: true }, expect: 'c1' },
    { opts: { fromSandbox: true }, expect: 'FAIL' },
    { opts: { fromWidget: true }, expect: 'FAIL' },
    { opts: { parentToolCallId: 't1' }, expect: 'FAIL' },
    { opts: {}, expect: 'stream' },
    { opts: null, expect: 'stream' }
];
function checkCases(label, run) {
    NESTED_CASES.forEach(function(c) {
        var r = run(c.opts);
        if (c.expect === 'FAIL') assert.strictEqual(r && r.code, 'CHAT_UNRESOLVED', label + ' ' + JSON.stringify(c.opts));
        else assert.strictEqual(r && r.chatId, c.expect, label + ' ' + JSON.stringify(c.opts));
    });
}
var GLOBALS = { activeStreamingChatId: 'stream', currentChatId: 'fg' };
function withGlobals(o) { return Object.assign({}, GLOBALS, o); }
var FAIL_END = "refusing to guess a chat.' };";

describe('G: remaining fallbacks fail closed for nested callers', function() {
    test('await_handle / await_any / await_all (chatIdH)', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        checkCases('await_*', function(o) {
            return runBlock(src, 'var _nestedH = ', FAIL_END + '\n        }', '{ chatId: chatIdH }', withGlobals({ name: 'await_handle', options: o }));
        });
    }, { tags: ['unit'], timeout: 4000 });
    test('cached_content_outline / search / read', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        [['var _ccNested = ', 'ccoChatId'], ['var _ccsNested = ', 'ccsChatId'], ['var _ccrNested = ', 'ccrChatId']].forEach(function(s) {
            checkCases(s[1], function(o) {
                return runBlock(src, s[0], FAIL_END, '{ chatId: ' + s[1] + ' }', withGlobals({ name: 'cached_content_read', options: o }));
            });
        });
        assert.strictEqual(/ccoChatId = \(options && options\.chatId\) \|\| activeStreamingChatId/.test(src), false);
    }, { tags: ['unit'], timeout: 4000 });
    test('trackRecordMutation chatId (record edit / attachment upload+delete / servicenow_api)', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var EXPR = '(options && options.chatId) || ((options && (options.fromSandbox || options.fromWidget || options.parentToolCallId)) ? null : (activeStreamingChatId || currentChatId))';
        assert.strictEqual(src.split('chatId: ' + EXPR + ',').length - 1, 4);
        assert.strictEqual(/chatId: \(options && options\.chatId\) \|\| activeStreamingChatId \|\| currentChatId,/.test(src), false);
        NESTED_CASES.forEach(function(c) {
            var got = build('var r = ' + EXPR + ';', 'r', withGlobals({ options: c.opts }));
            // nested without chat → null, and trackRecordMutation no-ops on a null chatId
            assert.strictEqual(got, c.expect === 'FAIL' ? null : c.expect, JSON.stringify(c.opts));
        });
        var tracked = [];
        var trm = build(extractFn(src, 'trackRecordMutation'), 'trackRecordMutation', {
            chats: new Proxy({}, { get: function(t, k) { tracked.push(k); return undefined; } }),
            recordStoredInstanceUrl: function(u) { return u || ''; },
            saveChatsToStorage: function() {}, VERSION_HISTORY_CAP: 100, AgentEvents: { emit: function() {} }
        });
        try { trm({ chatId: null, table: 't', sysId: 's', action: 'EDIT' }); } catch (e) { /* downstream emit stubs */ }
        assert.deepStrictEqual(tracked, []);
    }, { tags: ['unit'], timeout: 4000 });
    test('read_attached_file', async function() {
        var src = await loadFile('src/js/tools/050-file-tools.js');
        checkCases('read_attached_file', function(o) {
            return runBlock(src, 'var _rafNested = ', FAIL_END + '\n    }', '{ chatId: chatId }', withGlobals({ options: o }));
        });
        var fn = build(extractFn(src, 'executeReadAttachedFile'), 'executeReadAttachedFile', withGlobals({ chats: { stream: { messages: [] } }, ensureChatPayloads: async function() {} }));
        assert.strictEqual((await fn({ filename: 'a.csv' }, { fromSandbox: true })).code, 'CHAT_UNRESOLVED');
    }, { tags: ['unit'], timeout: 4000 });
    test('prompt_user', async function() {
        var src = await loadFile('src/js/tools/100-prompt-user.js');
        checkCases('prompt_user', function(o) {
            return runBlock(src, 'var _puNested = ', FAIL_END + '\n    }', '{ chatId: chatId }', withGlobals({ options: o }));
        });
    }, { tags: ['unit'], timeout: 4000 });
    test('update_action_state + show_action_button', async function() {
        var src = await loadFile('src/js/tools/120-actions.js');
        checkCases('update_action_state', function(o) {
            return runBlock(src, 'var _uasNested = ', FAIL_END + '\n    }', '{ chatId: chatId }', withGlobals({ options: o }));
        });
        checkCases('show_action_button', function(o) {
            return runBlock(src, 'var _sabNested = ', FAIL_END + '\n    }', '{ chatId: chatId }', withGlobals({ options: o }));
        });
        // the actionStateChanged event reuses the resolved chat, no second fallback
        var uas = extractFn(src, 'executeUpdateActionState');
        assert.match(between(uas, "AgentEvents.emit('actionStateChanged'", '});'), /chatId: chatId,/);
        var fn = build(uas, 'executeUpdateActionState', withGlobals({ chats: { stream: {} } }));
        assert.strictEqual((await fn({ state: 'running' }, { fromWidget: true })).code, 'CHAT_UNRESOLVED');
    }, { tags: ['unit'], timeout: 4000 });
    test('iframe_tool edit_html render record skips without a caller chat', async function() {
        var src = await loadFile('src/js/tools/010-iframe-tool.js');
        var END = 'recordWidgetRender(_erChatId, widgetId, result.version, options);';
        NESTED_CASES.forEach(function(c) {
            var rec = [];
            var r = runBlock(src, 'var _erNested = ', END, '{ chatId: _erChatId, er: _er }', withGlobals({
                options: c.opts, widgetId: 'w1', result: { version: 2 },
                recordWidgetRender: function(id) { rec.push(id); return { ok: true }; }
            }));
            var want = c.expect === 'FAIL' ? null : c.expect;
            assert.strictEqual(r.chatId, want, JSON.stringify(c.opts));
            assert.deepStrictEqual(rec, want ? [want] : []);
            assert.strictEqual(r.er, want ? r.er : null);
        });
    }, { tags: ['unit'], timeout: 4000 });
});

describe('E: start_chat background origin link', function() {
    async function run(options) {
        var src = await loadFile('src/js/tools/150-start-chat.js');
        var chatsMap = {};
        var fn = build(src, 'executeStartChat', {
            chats: chatsMap, currentChatId: 'chat_fg',
            runAgent: async function() {}, saveChatsToStorage: function() {}, renderChatList: function() {},
            renderJobsBadge: function() {}, updateChatTitle: function() {}
        });
        var r = await fn({ message: 'hi', mode: 'send', background: true }, options);
        return chatsMap[r.chat_id];
    }
    test('nested caller links only its own chat', async function() {
        assert.strictEqual((await run({ fromWidget: true })).sourceChatId, null);
        assert.strictEqual((await run({ fromWidget: true, chatId: 'chat_w' })).sourceChatId, 'chat_w');
        assert.strictEqual((await run({})).sourceChatId, 'chat_fg');
    }, { tags: ['unit'], timeout: 4000 });
});

describe('H: pinned-widget UX (start_chat / prompt_user visibility / fullscreen)', function() {
    test('start_chat from an unresolved widget creates the chat without a back-link', async function() {
        var src = await loadFile('src/js/tools/150-start-chat.js');
        var chatsMap = {}, ran = [];
        var fn = build(src, 'executeStartChat', {
            chats: chatsMap, currentChatId: 'chat_fg',
            runAgent: async function(id) { ran.push(id); }, saveChatsToStorage: function() {}, renderChatList: function() {},
            renderJobsBadge: function() {}, updateChatTitle: function() {}
        });
        var r = await fn({ message: 'hi', mode: 'send', background: true }, { fromWidget: true, chatId: null });
        assert.strictEqual(r.success, true);
        assert.strictEqual(chatsMap[r.chat_id].sourceChatId, null);
        assert.deepStrictEqual(ran, [r.chat_id]);
    }, { tags: ['unit'], timeout: 4000 });

    function pu(opts, env) {
        return loadFile('src/js/tools/100-prompt-user.js').then(function(src) {
            return runBlock(src, 'var _puNested = ', 'var chat = chats[chatId];', '{ chatId: chatId, passed: true }', Object.assign({
                activeStreamingChatId: 'stream', currentChatId: 'fg', currentView: 'chat', chats: {},
                splitViewRootChatId: function(id) { return id === 'sub_1' ? 'root_1' : id; },
                document: { getElementById: function() { return env && env.pane ? { dataset: { chatId: env.pane } } : null; } },
                options: opts
            }, (env && env.globals) || {}));
        });
    }
    test('prompt_user from a widget refuses a chat that is not on screen', async function() {
        var r = await pu({ fromWidget: true, chatId: 'chat_origin' });
        assert.strictEqual(r.code, 'CHAT_NOT_VISIBLE');
        assert.match(r.error, /Open the widget's chat first/);
        // owner chat shown, but the user is on the dashboard → not visible
        assert.strictEqual((await pu({ fromWidget: true, chatId: 'fg' }, { globals: { currentView: 'dashboard' } })).code, 'CHAT_NOT_VISIBLE');
        // pane on screen for another family → still refused
        assert.strictEqual((await pu({ fromWidget: true, chatId: 'chat_origin' }, { pane: 'root_x' })).code, 'CHAT_NOT_VISIBLE');
    }, { tags: ['unit'], timeout: 4000 });
    test('prompt_user from a widget proceeds only in the shown chat (split-pane family no longer counts)', async function() {
        assert.strictEqual((await pu({ fromWidget: true, chatId: 'fg' })).passed, true);
        // #1357: a split pane showing the owner's family while another chat is current is NOT visible
        assert.strictEqual((await pu({ fromWidget: true, chatId: 'sub_1' }, { pane: 'root_1' })).code, 'CHAT_NOT_VISIBLE');
        assert.strictEqual((await pu({ fromWidget: true, chatId: 'root_1' }, { pane: 'root_1' })).code, 'CHAT_NOT_VISIBLE');
        // owner chat is current (inline render path) → proceeds
        assert.strictEqual((await pu({ fromWidget: true, chatId: 'root_1' }, { pane: 'root_1', globals: { currentChatId: 'root_1' } })).passed, true);
        // agent (non-widget) prompts are unaffected
        assert.strictEqual((await pu({ chatId: 'chat_origin' })).passed, true);
        assert.strictEqual((await pu({ fromWidget: true })).code, 'CHAT_UNRESOLVED');
    }, { tags: ['unit'], timeout: 4000 });

    async function fs(event, originChatId, g) {
        var src = await loadFile('src/js/tools/080-widget-tools.js');
        return runBlock(src, 'var _fsChat = originChatId', 'if (_fsChat) overlay.dataset.chatId = _fsChat;', '{ chat: overlay.dataset.chatId }', Object.assign({
            event: event, originChatId: originChatId, widgetId: 'w1', expandedWidgetId: null,
            currentView: 'chat', currentChatId: 'chat_fg',
            getWidgetById: function() { return { id: 'w1' }; }, closeWidgetFullscreen: function() {},
            document: { createElement: function() { return { dataset: {} }; } }
        }, g || {}));
    }
    function ev(sel) {
        var target = { closest: function(s) { return s === sel.match ? sel.node : null; } };
        return { target: target, stopPropagation: function() {}, preventDefault: function() {} };
    }
    test('fullscreen overlay records the chat view it was opened from', async function() {
        assert.strictEqual((await fs(ev({ match: '#split-widget-pane', node: { dataset: { chatId: 'chat_pane' } } }))).chat, 'chat_pane');
        assert.strictEqual((await fs(ev({ match: '#messages', node: {} }))).chat, 'chat_fg');
        assert.strictEqual((await fs(null, 'chat_inline')).chat, 'chat_inline');
        // sidebar / library / programmatic → unset (bridge falls back to the record)
        assert.strictEqual((await fs(null, null)).chat, undefined);
        assert.strictEqual((await fs(ev({ match: '#nope', node: {} }))).chat, undefined);
        assert.strictEqual((await fs(ev({ match: '#messages', node: {} }), null, { currentView: 'dashboard' })).chat, undefined);
        var mr = await loadFile('src/js/ui/250-message-render.js');
        assert.match(mr, /openWidgetFullscreen\(wid, null, \(typeof currentChatId !== 'undefined' && currentChatId\) \|\| null\)/);
    }, { tags: ['unit'], timeout: 4000 });
    test('bridge attributes a stamped fullscreen overlay to its chat, else the record', async function() {
        var src = await loadFile('src/js/ui/070-dashboard-ui.js');
        var store = { view: function(id) { return id === 'w_dash' ? { chatId: 'chat_owner' } : null; } };
        var fn = build(extractFn(src, '_widgetOwnerChatId'), '_widgetOwnerChatId', { currentChatId: 'chat_fg', WidgetStore: store, chats: { chat_owner: {} }, _chatsHydrated: true });
        var stamped = { id: 'widget-fullscreen-overlay', dataset: { chatId: 'chat_view' }, parentNode: { id: 'body', dataset: {}, parentNode: null } };
        assert.strictEqual(fn({ id: 'f', dataset: {}, parentNode: stamped }, 'w_dash'), 'chat_view');
        var plain = { id: 'widget-fullscreen-overlay', dataset: {}, parentNode: { id: 'messages', dataset: {}, parentNode: null } };
        assert.strictEqual(fn({ id: 'f', dataset: {}, parentNode: plain }, 'w_dash'), 'chat_owner');
    }, { tags: ['unit'], timeout: 4000 });
});

describe('F: sub-agent registry caller chat', function() {
    test('registry caller-chat sites honour noFallback', async function() {
        // Inlined (not a shared helper) so tests that slice single registry
        // functions out of 097 keep evaluating them standalone.
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        var START = '((ctx && ctx.chatId)', END = "currentChatId : null))))";
        var sites = [], at = 0;
        while ((at = src.indexOf(START, at)) >= 0) {
            var end = src.indexOf(END, at);
            var expr = src.slice(at, end + END.length);
            if (expr.indexOf('ctx.noFallback') >= 0) sites.push(expr);
            at += START.length;
        }
        assert.strictEqual(sites.length, 8);
        sites.forEach(function(expr) {
            var fn = function(ctx) { return build('var r = ' + expr + ';', 'r', { ctx: ctx, activeStreamingChatId: 'stream', currentChatId: 'fg' }); };
            assert.strictEqual(fn({ chatId: 'c1', noFallback: true }), 'c1');
            assert.strictEqual(fn({ chatId: null, noFallback: true }), null);
            assert.strictEqual(fn({ chatId: null }), 'stream');
            assert.strictEqual(fn(null), 'stream');
        });
        // no unguarded ctx.chatId -> streaming-global fallback remains
        assert.strictEqual(/\(ctx && ctx\.chatId\)\s*\|\| \(typeof activeStreamingChatId/.test(src), false);
    }, { tags: ['unit'], timeout: 4000 });
    test('dispatcher flags nested callers', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var block = between(src, 'var subCtxChatId = ', 'noFallback: _subNested };');
        function ctx(options) { return build(block, 'subCtx', { options: options, activeStreamingChatId: 'stream', currentChatId: 'fg' }); }
        assert.deepStrictEqual(ctx({ fromSandbox: true }), { chatId: null, noFallback: true });
        assert.deepStrictEqual(ctx({ fromWidget: true, chatId: 'c2' }), { chatId: 'c2', noFallback: true });
        assert.deepStrictEqual(ctx({}), { chatId: 'stream', noFallback: false });
    }, { tags: ['unit'], timeout: 4000 });
});

// Remaining fallbacks (follow-up to #1355/#1356): approval gates, smart
// documents, answer-card hooks, the widget bridge record fallback, iframe
// bookkeeping and widget operation keys. Nested + no chatId → fail closed /
// no foreground chat; nested + chatId → that chat; top-level → legacy fallback.
describe('I: remaining fallbacks (approval, documents, hooks, widgets, iframe)', function() {
    var NESTED_NO_CHAT = [{ fromSandbox: true }, { fromWidget: true }, { parentToolCallId: 't1' }];
    var PSTUBS = {
        resolvePermissionKey: function(t, m) { return m ? t + ':' + m : t; },
        getToolDisplayName: function() { return 'Web Fetch'; }
    };
    async function loadPageApproval() {
        var seen = { perm: [], prompts: [] };
        var m = await loadModules(['src/js/ui/150-tool-approval.js'], { lenient: true, globals: Object.assign({
            chats: { c1: { id: 'c1', messages: [] }, stream: { id: 'stream', messages: [] } }, activeStreamingChatId: 'stream', currentChatId: 'fg',
            getToolPermission: function(t, m2, chatId) { seen.perm.push(chatId); return 'ask'; },
            showToolApprovalPrompt: function(dn, a, pk, tcId, an, chatId) { seen.prompts.push(chatId); return Promise.resolve(false); },
            showToolApprovalPromptBatch: function(dn, a, pk, tcId, an, chatId) { seen.prompts.push(chatId); return Promise.resolve(false); } }, PSTUBS) });
        return { m: m, seen: seen };
    }
    test('fix 1 page approval: nested without chatId → CHAT_UNRESOLVED, no prompt, no chat grants', async function() {
        for (var i = 0; i < NESTED_NO_CHAT.length; i++) {
            var t = await loadPageApproval();
            var r = await t.m.requestProgrammaticToolApproval('web_fetch', { url: 'https://x.example' }, NESTED_NO_CHAT[i]);
            assert.strictEqual(r.allowed, false);
            assert.strictEqual(r.code, 'CHAT_UNRESOLVED', JSON.stringify(NESTED_NO_CHAT[i]));
            assert.deepStrictEqual(t.seen.prompts, [], 'never prompted in another chat');
            assert.deepStrictEqual(t.seen.perm, [null], 'permission looked up without a chat');
        }
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 1 page approval: nested+chatId prompts there; top-level falls back to streaming chat', async function() {
        var t = await loadPageApproval();
        await t.m.requestProgrammaticToolApproval('web_fetch', { url: 'https://x.example' }, { fromSandbox: true, chatId: 'c1' });
        assert.deepStrictEqual(t.seen.prompts, ['c1']);
        var t2 = await loadPageApproval();
        var r2 = await t2.m.requestProgrammaticToolApproval('web_fetch', { url: 'https://x.example' }, {});
        assert.notStrictEqual(r2.code, 'CHAT_UNRESOLVED');
        assert.deepStrictEqual(t2.seen.prompts, ['stream']);
        assert.deepStrictEqual(t2.seen.perm, ['stream']);
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 1 SW approval: nested without chatId → CHAT_UNRESOLVED; chatId / top-level still park', async function() {
        async function load() {
            var m = await loadModules(['src/js/worker/120-tool-routing.js'], { lenient: true, globals: Object.assign({
                window: fakeWindow(), chrome: fakeChrome(), chats: { c1: { id: 'c1', messages: [] } }, parkedToolCallsByChatId: {},
                activeStreamingChatId: 'c1', getToolPermission: function() { return 'ask'; },
                AgentEvents: { emit: function() {} }, saveChatsToStorage: function() {}, _agentSubscribers: new Set() }, PSTUBS) });
            m.requestProgrammaticToolApproval = m.requestProgrammaticToolApproval || m.__scope.requestProgrammaticToolApproval;
            return m;
        }
        function race(p) { return Promise.race([p, new Promise(function(r) { setTimeout(function() { r('PENDING'); }, 50); })]); }
        var m = await load();
        for (var i = 0; i < NESTED_NO_CHAT.length; i++) {
            var r = await race(m.requestProgrammaticToolApproval('web_fetch', { url: 'https://x.example' }, NESTED_NO_CHAT[i]));
            assert.strictEqual(r && r.code, 'CHAT_UNRESOLVED', JSON.stringify(NESTED_NO_CHAT[i]));
        }
        assert.deepStrictEqual(m.__scope.parkedToolCallsByChatId, {}, 'nothing parked in the streaming chat');
        var opts = [{ fromSandbox: true, chatId: 'c1' }, {}];
        for (var j = 0; j < opts.length; j++) {
            var m2 = await load();
            var p = m2.requestProgrammaticToolApproval('web_fetch', { url: 'https://x.example' }, opts[j]);
            assert.strictEqual(await race(p), 'PENDING', JSON.stringify(opts[j]));
            var parked = m2.__scope.parkedToolCallsByChatId.c1 || [];
            assert.strictEqual(parked.length, 1);
            m2.cancelParkedToolCall('c1', parked[0].toolCallId, 'cleanup');
            await p;
        }
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 1 prompts (160): nested without targetChatId resolves false, top-level uses currentChatId', async function() {
        async function load() {
            var pend = {};
            var chats = { c1: { id: 'c1', title: 'T', messages: [{ role: 'user', content: 'hi' }] } };
            var m = await loadModules(['src/js/ui/160-notifications.js'], { lenient: true, globals: {
                window: fakeWindow(), chats: chats, currentChatId: 'c1', currentView: 'chat', pendingToolApprovals: pend, sessionPermissions: {},
                saveChatsToStorage: function() {}, renderMessages: function() {}, renderChatList: function() {}, runAgent: function() {},
                scrollToBottomIfAllowed: function() {}, setTimeout: function() { return 0; } } });
            m.__scope.showApprovalNotification = function() {};
            return { m: m, pend: pend, chats: chats };
        }
        var fns = ['showToolApprovalPrompt', 'showToolApprovalPromptBatch'];
        for (var i = 0; i < fns.length; i++) {
            for (var k = 0; k < NESTED_NO_CHAT.length; k++) {
                var t = await load();
                var v = await t.m[fns[i]]('Web Fetch', {}, 'web_fetch', 'tcN', 'web_fetch', null, NESTED_NO_CHAT[k]);
                assert.strictEqual(v, false, fns[i] + ' ' + JSON.stringify(NESTED_NO_CHAT[k]));
                assert.deepStrictEqual(Object.keys(t.pend), []);
                assert.strictEqual(t.chats.c1.messages.length, 1, 'no row in the foreground chat');
            }
            var t2 = await load();
            t2.m[fns[i]]('Web Fetch', {}, 'web_fetch', 'tcT', 'web_fetch', null, {});
            assert.strictEqual(Object.keys(t2.pend).length, 1, fns[i] + ' top-level still prompts in currentChatId');
            assert.strictEqual(Object.keys(t2.pend)[0].indexOf('c1:'), 0);
        }
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 1 dispatcher surfaces approval.code on denial', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var block = between(src, 'if (!approval.allowed) {', 'return _deniedRes;\n    }');
        var run = function(ap) { return build('var __r = (function(){' + block + '\nreturn null; })();', '__r', { approval: ap }); };
        assert.deepStrictEqual(run({ allowed: false, error: 'e', code: 'CHAT_UNRESOLVED' }), { success: false, error: 'e', _denied: true, code: 'CHAT_UNRESOLVED' });
        assert.deepStrictEqual(run({ allowed: false, error: 'e' }), { success: false, error: 'e', _denied: true });
        assert.strictEqual(run({ allowed: true }), null);
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 2 smart documents: _sdocChatId, chat-scoped create, display copy', async function() {
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        var fn = build(extractFn(src, '_sdocChatId'), '_sdocChatId', GLOBALS);
        NESTED_CASES.forEach(function(c) {
            assert.strictEqual(fn(c.opts), c.expect === 'FAIL' ? null : c.expect, '_sdocChatId ' + JSON.stringify(c.opts));
        });
        var block = between(src, 'var _sdcNested = ', FAIL_END + '\n    }');
        function create(opts, scope, owner) {
            return build('var __r = (function(){' + block + "\nreturn { scope: scope }; })();", '__r', { options: opts, scope: scope, ownerChatId: owner });
        }
        NESTED_NO_CHAT.forEach(function(o) {
            assert.strictEqual(create(o, 'chat', null).code, 'CHAT_UNRESOLVED');
            assert.deepStrictEqual(create(o, 'shared', null), { scope: 'shared' }, 'shared docs unaffected');
        });
        assert.deepStrictEqual(create({ fromSandbox: true, chatId: 'c1' }, 'chat', 'c1'), { scope: 'chat' });
        assert.strictEqual(create({}, 'chat', null).code, 'CHAT_UNRESOLVED', 'top-level unresolved chat scope fails closed (no shared fallback)');
        assert.deepStrictEqual(create({}, 'chat', 'c1'), { scope: 'chat' }, 'top-level with an owner keeps chat scope');
        assert.ok(src.indexOf("if (scope === 'chat' && !ownerChatId) scope = 'shared';") === -1, 'silent shared fallback removed');
        var copy = extractFn(src, 'sdocCopyDisplays');
        assert.match(copy, /var chatId = _sdocChatId\(options\);\s*(\/\/[^\n]*\n\s*)*if \(!chatId\) return;/);
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 3 answer-card hooks + set_chat_title: nested without chatId → CHAT_UNRESOLVED', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        ['_sctNested', '_stNested', '_slNested', '_scNested'].forEach(function(v) {
            checkCases(v, function(o) {
                return runBlock(src, 'var ' + v + ' = ', 'activeStreamingChatId || currentChatId;', '{ chatId: targetChatId }', withGlobals({ options: o }));
            });
        });
        ['executeSetChatTitle', 'executeSetTldr', 'executeSetLinks', 'executeSetCaveat'].forEach(function(n) {
            assert.match(extractFn(src, n), /Nested = !!\(options && \(options\.fromSandbox \|\| options\.fromWidget \|\| options\.parentToolCallId\)\)/, n + ' guards nested callers');
        });
        var cold = build(extractFn(src, '_hookToolColdChatId'), '_hookToolColdChatId', withGlobals({
            chats: { c1: { _messagesEvicted: true }, stream: { _messagesEvicted: true }, fg: { _messagesEvicted: true } },
            ensureChatPayloads: function() {} }));
        NESTED_CASES.forEach(function(c) {
            assert.strictEqual(cold(c.opts), c.expect === 'FAIL' ? null : c.expect, '_hookToolColdChatId ' + JSON.stringify(c.opts));
        });
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 4 widget bridge record fallback needs a live origin chat', async function() {
        var src = await loadFile('src/js/ui/070-dashboard-ui.js');
        var store = { view: function(id) { return id === 'w_dash' ? { chatId: 'chat_owner' } : null; } };
        function mk(chatsMap, hydrated) {
            return build(extractFn(src, '_widgetOwnerChatId'), '_widgetOwnerChatId', { currentChatId: 'chat_fg', WidgetStore: store, chats: chatsMap, _chatsHydrated: hydrated });
        }
        var parked = { id: 'f', dataset: {}, parentNode: { id: 'body', dataset: {}, parentNode: null } };
        assert.strictEqual(mk({ chat_owner: {} }, true)(parked, 'w_dash'), 'chat_owner');
        assert.strictEqual(mk({ chat_owner: { _messagesEvicted: true } }, true)(parked, 'w_dash'), 'chat_owner', 'cold stub still owns');
        assert.strictEqual(mk({ chat_owner: { _deleted: true } }, true)(parked, 'w_dash'), null, 'deleted origin');
        assert.strictEqual(mk({}, true)(parked, 'w_dash'), null, 'missing origin');
        assert.strictEqual(mk({}, false)(parked, 'w_dash'), 'chat_owner', 'kept while chats are not hydrated');
        assert.strictEqual(mk({}, true)(parked, 'w_dash') === 'chat_fg', false, 'never the foreground chat');
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 5 iframe_tool bookkeeping chat', async function() {
        var src = await loadFile('src/js/tools/010-iframe-tool.js');
        function run(o) {
            return runBlock(src, 'var _ifNested = ', ': undefined));', '{ chatId: _ifChatId }', { options: o, chats: { c1: {} }, currentChatId: 'fg' }).chatId;
        }
        NESTED_NO_CHAT.forEach(function(o) { assert.strictEqual(run(o), null, JSON.stringify(o)); });
        assert.strictEqual(run({ fromSandbox: true, chatId: 'zz' }), null, 'unknown chatId never becomes the foreground chat');
        assert.strictEqual(run({ fromSandbox: true, chatId: 'c1' }), 'c1');
        assert.strictEqual(run({}), 'fg');
        assert.strictEqual(run(null), 'fg');
    }, { tags: ['unit'], timeout: 4000 });
    test('fix 6 widgetOperationId chat part', async function() {
        var src = await loadFile('src/js/core/135-widget-store.js');
        function mk(g) {
            return build(extractFn(src, 'widgetOperationId'), 'widgetOperationId', Object.assign({
                _widgetOperationScopeId: function(id) { return id; }, crypto: { randomUUID: function() { return 'uuid'; } },
                WidgetStore: undefined, widgetIdForOperation: function() {}, getLineageChatIds: function() { return []; } }, g));
        }
        var fn = mk(GLOBALS);
        var args = { operation_id: 'op' };
        var expect = { c1: 'c1:op', FAIL: 'widget:op', stream: 'stream:op' };
        for (var i = 0; i < NESTED_CASES.length; i++) {
            var c = NESTED_CASES[i];
            assert.strictEqual(await fn(args, c.opts), expect[c.expect], JSON.stringify(c.opts));
        }
        assert.strictEqual(await mk({ activeStreamingChatId: null, currentChatId: 'fg' })(args, {}), 'fg:op');
    }, { tags: ['unit'], timeout: 4000 });
});
