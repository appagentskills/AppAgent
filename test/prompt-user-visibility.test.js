// prompt_user from widgets: visibility check (follow-up to PR #1356).
// The real executePromptUser source is extracted and run end-to-end with
// in-memory stubs (chats, view globals, DOM, resolvers) so the visibility
// decision, the background-action path, the inline render and the
// fullscreen-overlay handling are all exercised on the same code.

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

var FIELDS = [{ name: 'q', type: 'text', label: 'Q' }];

// env: { currentChatId, currentView, chats, overlay, pane }
async function setup(env) {
    var src = await loadFile('src/js/tools/100-prompt-user.js');
    var code = extractFn(src, 'executePromptUser');
    var rec = { needsInput: [], renders: 0, resolvers: {} };
    var els = {};
    if (env.overlay) els['widget-fullscreen-overlay'] = env.overlay;
    if (env.pane) els['split-widget-pane'] = { dataset: { chatId: env.pane } };
    var stubs = {
        chats: env.chats,
        activeStreamingChatId: 'stream',
        currentChatId: env.currentChatId,
        currentView: env.currentView || 'chat',
        document: { getElementById: function(id) { return els[id] || null; } },
        setActionNeedsInput: function(actionId, promptId) { rec.needsInput.push(actionId); },
        saveChatsToStorage: function() {},
        postPromptRowToSW: function() {},
        renderMessages: function() { rec.renders++; rec.overlayDisplayAtRender = env.overlay ? env.overlay.style.display : null; },
        scrollToBottomIfAllowed: function() {},
        setTimeout: function() {},
        pendingPromptResolvers: rec.resolvers,
        promptSubmitHooks: {},
        N_: function(s) { return s; },
        ensureChatPayloads: async function() {},
        _refreshWaitingBadges: function() {},
        sanitizePromptFields: function(f) { return f.map(function(x) { return Object.assign({}, x); }); },
        splitViewRootChatId: function(id) { return id === 'sub_1' ? 'root_1' : id; }
    };
    var names = Object.keys(stubs);
    var fn = new Function(names.join(','), code + '\nreturn executePromptUser;').apply(null, names.map(function(n) { return stubs[n]; }));
    return { fn: fn, rec: rec };
}

// Start a call; if it parks (pending form), resolve it and return the result.
async function call(env, options) {
    var s = await setup(env);
    var settled = null;
    var p = s.fn({ title: 'T', fields: FIELDS }, options).then(function(r) { settled = r; return r; });
    await new Promise(function(r) { Promise.resolve().then(r); });
    await sleep(0);
    var parked = settled === null;
    var ids = Object.keys(s.rec.resolvers);
    if (parked) {
        s.rec.overlayDisplayWhilePending = env.overlay ? env.overlay.style.display : null;
        ids.forEach(function(id) { s.rec.resolvers[id]({ success: true, values: { q: 'a' } }); });
    }
    var r = await p;
    return { r: r, rec: s.rec, parked: parked };
}

function chatsWith(extra) {
    var c = { fg: { messages: [] }, root_1: { messages: [] }, sub_1: { messages: [] }, origin: { messages: [] } };
    return Object.assign(c, extra || {});
}

describe('prompt_user widget visibility', function() {
    test('background Action owner follows the needs-input path (no CHAT_NOT_VISIBLE)', async function() {
        var chats = chatsWith({ bg: { messages: [], isBackground: true, actionId: 'act_1' } });
        var o = await call({ chats: chats, currentChatId: 'fg' }, { fromWidget: true, chatId: 'bg' });
        assert.strictEqual(o.parked, true);
        assert.notStrictEqual(o.r.code, 'CHAT_NOT_VISIBLE');
        assert.deepStrictEqual(o.rec.needsInput, ['act_1']);
        assert.strictEqual(o.rec.renders, 0);
        assert.strictEqual(chats.bg.messages[0].role, 'prompt_user');
        // also from the dashboard view
        var o2 = await call({ chats: chatsWith({ bg: { messages: [], isBackground: true, actionId: 'act_2' } }), currentChatId: 'fg', currentView: 'dashboard' }, { fromWidget: true, chatId: 'bg' });
        assert.deepStrictEqual(o2.rec.needsInput, ['act_2']);
    }, { tags: ['unit'], timeout: 4000 });

    test('background chat WITHOUT actionId is not reachable when off screen', async function() {
        var chats = chatsWith({ bg: { messages: [], isBackground: true } });
        var o = await call({ chats: chats, currentChatId: 'fg' }, { fromWidget: true, chatId: 'bg' });
        assert.strictEqual(o.r.code, 'CHAT_NOT_VISIBLE');
        assert.strictEqual(chats.bg.messages.length, 0);
    }, { tags: ['unit'], timeout: 4000 });

    test('split pane root R + current chat S + owner R -> CHAT_NOT_VISIBLE (form would not render)', async function() {
        var chats = chatsWith();
        var o = await call({ chats: chats, currentChatId: 'fg', pane: 'root_1' }, { fromWidget: true, chatId: 'root_1' });
        assert.strictEqual(o.r.code, 'CHAT_NOT_VISIBLE');
        assert.strictEqual(o.r.chat_id, 'root_1');
        assert.strictEqual(o.parked, false);
        assert.strictEqual(chats.root_1.messages.length, 0);
        var o2 = await call({ chats: chats, currentChatId: 'fg', pane: 'root_1' }, { fromWidget: true, chatId: 'sub_1' });
        assert.strictEqual(o2.r.code, 'CHAT_NOT_VISIBLE');
    }, { tags: ['unit'], timeout: 4000 });

    test('owner === currentChatId in chat view renders inline (with or without split pane)', async function() {
        var chats = chatsWith();
        var o = await call({ chats: chats, currentChatId: 'root_1', pane: 'root_1' }, { fromWidget: true, chatId: 'root_1' });
        assert.strictEqual(o.parked, true);
        assert.strictEqual(o.rec.renders, 1);
        assert.strictEqual(o.r.success, true);
        assert.strictEqual(chats.root_1.messages[0].status, 'pending');
    }, { tags: ['unit'], timeout: 4000 });

    test('fullscreen overlay is hidden while the inline form is pending and restored after', async function() {
        var overlay = { style: { display: '' }, isConnected: true, dataset: { chatId: 'fg' } };
        var o = await call({ chats: chatsWith(), currentChatId: 'fg', overlay: overlay }, { fromWidget: true, chatId: 'fg' });
        assert.strictEqual(o.rec.renders, 1);
        assert.strictEqual(o.rec.overlayDisplayAtRender, 'none');
        assert.strictEqual(o.rec.overlayDisplayWhilePending, 'none');
        assert.strictEqual(overlay.style.display, '');
        // overlay removed meanwhile -> not touched on restore
        var gone = { style: { display: '' }, isConnected: true };
        var s = await setup({ chats: chatsWith(), currentChatId: 'fg', overlay: gone });
        var p = s.fn({ title: 'T', fields: FIELDS }, { fromWidget: true, chatId: 'fg' });
        await sleep(0);
        gone.isConnected = false;
        Object.keys(s.rec.resolvers).forEach(function(id) { s.rec.resolvers[id]({ success: true }); });
        await p;
        assert.strictEqual(gone.style.display, 'none');
    }, { tags: ['unit'], timeout: 4000 });

    test('prompt-hidden overlay is flagged for Escape and the global Escape handler skips it', async function() {
        // 1. prompt flow sets data-prompt-hidden while pending, clears it on restore
        var overlay = { style: { display: '' }, isConnected: true, dataset: {} };
        var s = await setup({ chats: chatsWith(), currentChatId: 'fg', overlay: overlay });
        var p = s.fn({ title: 'T', fields: FIELDS }, { fromWidget: true, chatId: 'fg' });
        await sleep(0);
        assert.strictEqual(overlay.dataset.promptHidden, '1');
        // 2. the real Escape block from core/120-init.js
        var init = await loadFile('src/js/core/120-init.js');
        var a = init.indexOf('var _escFs = ');
        var endMarker = 'closeWidgetFullscreen(); return; }';
        var b = init.indexOf(endMarker, a);
        assert.ok(a > 0 && b > a, 'Escape block found');
        var block = init.slice(a, b + endMarker.length);
        function esc(el) {
            var closed = 0;
            var r = new Function('document', 'closeWidgetFullscreen', block + '\nreturn "fell-through";')(
                { getElementById: function(id) { return id === 'widget-fullscreen-overlay' ? el : null; } },
                function() { closed++; });
            return { closed: closed, r: r };
        }
        var hidden = esc(overlay);
        assert.strictEqual(hidden.closed, 0);
        assert.strictEqual(hidden.r, 'fell-through');
        // resolve -> flag cleared -> Escape closes again
        Object.keys(s.rec.resolvers).forEach(function(id) { s.rec.resolvers[id]({ success: true }); });
        await p;
        assert.strictEqual(overlay.dataset.promptHidden, undefined);
        assert.strictEqual(overlay.style.display, '');
        var shown = esc(overlay);
        assert.strictEqual(shown.closed, 1);
        assert.strictEqual(shown.r, undefined);
        assert.strictEqual(esc(null).closed, 0);
    }, { tags: ['unit'], timeout: 4000 });

    test('non-widget (sandbox / agent) calls are unchanged: no visibility gate, overlay untouched', async function() {
        var overlay = { style: { display: '' }, isConnected: true };
        var chats = chatsWith();
        var o = await call({ chats: chats, currentChatId: 'fg', overlay: overlay }, { fromSandbox: true, chatId: 'origin' });
        assert.strictEqual(o.parked, true);
        assert.strictEqual(o.rec.renders, 0);
        assert.strictEqual(chats.origin.messages.length, 1);
        var o2 = await call({ chats: chatsWith(), currentChatId: 'fg', currentView: 'dashboard' }, { chatId: 'fg' });
        assert.strictEqual(o2.parked, true);
        var o3 = await call({ chats: chatsWith(), currentChatId: 'fg', overlay: overlay }, { fromSandbox: true, chatId: 'fg' });
        assert.strictEqual(o3.rec.renders, 1);
        assert.strictEqual(o3.rec.overlayDisplayAtRender, '');
        assert.strictEqual((await call({ chats: chatsWith(), currentChatId: 'fg' }, { fromWidget: true })).r.code, 'CHAT_UNRESOLVED');
    }, { tags: ['unit'], timeout: 4000 });

    test('home / dashboard view -> CHAT_NOT_VISIBLE even when owner is currentChatId', async function() {
        var r1 = await call({ chats: chatsWith(), currentChatId: 'fg', currentView: 'dashboard' }, { fromWidget: true, chatId: 'fg' });
        var r2 = await call({ chats: chatsWith(), currentChatId: 'fg', currentView: 'home' }, { fromWidget: true, chatId: 'fg' });
        assert.strictEqual(r1.r.code, 'CHAT_NOT_VISIBLE');
        assert.strictEqual(r2.r.code, 'CHAT_NOT_VISIBLE');
        assert.match(r1.r.error, /Open the widget's chat first/);
    }, { tags: ['unit'], timeout: 4000 });
});
