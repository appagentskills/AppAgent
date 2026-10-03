// C2-core-misc part C: skeleton-safe widget tool + streaming paint, and the
// widget code editor's translated save-error snackbar.
// A: executeHtmlWidget hydrates a skeleton before widgetEditTarget (same
// result as its hydrated twin); a hydrate miss fails closed; list never
// hydrates. B: saveWidgetCodeEdit routes failures through widgetSaveErrorText
// (typeof-guarded). C: updateStreamingText no-ops on a skeleton.
// Evaluates the REAL function texts cut out of the source (same pattern as
// test/chat-eviction-store.test.js) with in-memory stand-ins.

function _cutFns(src, names) {
    return names.map(function(name) {
        var re = new RegExp('^(async )?function ' + name + '\\(', 'm');
        var m = re.exec(src);
        if (!m) throw new Error('function not found: ' + name);
        var end = src.indexOf('\n}\n', m.index);
        if (end === -1) throw new Error('function end not found: ' + name);
        return src.slice(m.index, end + 2);
    }).join('\n');
}

function _widgetMsgs() {
    return [{ role: 'user', content: 'make it', isWidgetRequest: true, widgetId: 'w1' },
        { role: 'assistant', content: 'ok' }];
}

// env: { chats, ensure(chats, id) }
async function _widgetEnv(env) {
    var tools = await loadFile('src/js/tools/080-widget-tools.js');
    var store = await loadFile('src/js/core/135-widget-store.js');
    var log = { ensure: [], reads: [] };
    var WidgetStore = {
        init: function() { return Promise.resolve(); },
        list: function() { return [{ id: 'w1' }]; },
        read: function(id) { log.reads.push(id); return Promise.resolve(); },
        view: function(id) { return id === 'w1' ? { id: 'w1', latestVersion: 2 } : null; },
        versions: function() { return [1, 2]; }
    };
    var ensureChatPayloads = function(id) {
        log.ensure.push(id);
        if (env.ensure) env.ensure(env.chats, id);
        return Promise.resolve();
    };
    var body = _cutFns(store, ['widgetEditTarget']) + '\n' + _cutFns(tools, ['executeHtmlWidget'])
        + '\nreturn executeHtmlWidget;';
    var f = new Function('chats', 'currentChatId', 'activeStreamingChatId', 'WidgetStore', 'ensureChatPayloads', body);
    return { run: f(env.chats, 'c1', null, WidgetStore, ensureChatPayloads), log: log };
}

// Save-path env for executeHtmlWidget({html}). env: { chats, ensure(chats, id), onCommit(chats) }
async function _widgetSaveEnv(env) {
    var tools = await loadFile('src/js/tools/080-widget-tools.js');
    var store = await loadFile('src/js/core/135-widget-store.js');
    var log = { order: [], ensure: [], commits: [], projected: [], sidebar: 0 };
    var chatWidgets = {};
    var WidgetStore = {
        init: function() { return Promise.resolve(); },
        list: function() { return []; },
        read: function() { return Promise.resolve(); },
        view: function(id) { return id === 'w9' ? { id: 'w9', latestVersion: 1 } : null; },
        versions: function() { return [1]; },
        commit: function(id, content, base, op, meta) {
            log.commits.push({ id: id, base: base, op: op, msgIndex: meta.msgIndex, chatId: meta.chatId });
            if (env.onCommit) env.onCommit(env.chats);
            return Promise.resolve({ success: true, version: 1, latest_version: 1 });
        },
        project: function(id) { log.projected.push(id); }
    };
    var ensureChatPayloads = function(id) {
        log.ensure.push(id); log.order.push('ensure:' + id);
        if (env.ensure) env.ensure(env.chats, id);
        return Promise.resolve();
    };
    var body = _cutFns(store, ['widgetEditTarget', 'recordWidgetRender']) + '\n' + _cutFns(tools, ['executeHtmlWidget'])
        + '\nreturn executeHtmlWidget;';
    var f = new Function('chats', 'currentChatId', 'activeStreamingChatId', 'WidgetStore', 'ensureChatPayloads',
        'widgetOperationId', 'widgetIdForOperation', 'chatWidgets', 'saveChatsToStorage', 'renderWidgetSidebar',
        'addWidgetToDashboard', body);
    var run = f(env.chats, 'c1', null, WidgetStore, ensureChatPayloads,
        function() { return Promise.resolve('op1'); },
        function(op) { return Promise.resolve(op === 'op1' ? 'w9' : null); },
        chatWidgets,
        function() { log.order.push('save'); return Promise.resolve(); },
        function() { log.sidebar++; },
        function() { return Promise.resolve(null); });
    return { run: run, log: log, chatWidgets: chatWidgets };
}

async function _saveEnv(withHelper) {
    var tools = await loadFile('src/js/tools/080-widget-tools.js');
    var log = { snack: [] };
    var editor = { value: '<p>x</p>', dataset: { widgetBaseVersion: '1', widgetOperationId: 'op' } };
    var document = { getElementById: function(id) { return id === 'widget-code-editor' ? editor : null; } };
    var body = _cutFns(tools, ['saveWidgetCodeEdit']) + '\nreturn saveWidgetCodeEdit;';
    var f = new Function('document', 'getWidgetById', 'saveWidgetRevision', 'showSnackbar', 't',
        'widgetSaveErrorText', 'closeWidgetCodeEdit', 'renderMessages', 'refreshVisibleDashboards', body);
    var run = f(document,
        function() { return { id: 'w1' }; },
        function() { return Promise.resolve({ success: false, code: 'VERSION_CONFLICT', error: 'Version conflict' }); },
        function(msg, kind) { log.snack.push([msg, kind]); },
        function(s) { return s; },
        withHelper ? function(r) { return 'T:' + r.code; } : undefined,
        function() {}, function() {}, function() {});
    return { run: run, log: log };
}

describe('C2-core-misc C: skeleton-safe widget tool + streaming', function() {
    test('A1: a skeleton is hydrated first and resolves the same edit target as its hydrated twin', async function() {
        var hot = await _widgetEnv({ chats: { c1: { id: 'c1', messages: _widgetMsgs() } } });
        var hotRes = await hot.run({ action: 'read' }, 0, { chatId: 'c1' });
        assert.strictEqual(hotRes.success, true);
        assert.strictEqual(hotRes.widget.id, 'w1');
        assert.strictEqual(hot.log.ensure.length, 0);

        var chats = { c1: { id: 'c1', _messagesEvicted: true, _msgCount: 2 } };
        var cold = await _widgetEnv({ chats: chats, ensure: function(cs, id) {
            // copy-on-restore: the live object is replaced, like the sweep's copy.
            cs[id] = { id: id, messages: _widgetMsgs() };
        } });
        var coldRes = await cold.run({ action: 'read' }, 0, { chatId: 'c1' });
        assert.deepStrictEqual(cold.log.ensure, ['c1']);
        assert.deepStrictEqual(coldRes, hotRes);
    }, { tags: ['unit'] });

    test('A2: a hydrate miss fails closed with CHAT_UNAVAILABLE and touches no widget', async function() {
        var chats = { c1: { id: 'c1', _messagesEvicted: true, _msgCount: 2 } };
        var env = await _widgetEnv({ chats: chats });
        var res = await env.run({ action: 'read' }, 0, { chatId: 'c1' });
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.code, 'CHAT_UNAVAILABLE');
        assert.strictEqual(env.log.reads.length, 0);
        assert.strictEqual(chats.c1.messages, undefined);
        var saveRes = await env.run({ html: '<p>x</p>' }, 0, { chatId: 'c1' });
        assert.strictEqual(saveRes.code, 'CHAT_UNAVAILABLE');
    }, { tags: ['unit'] });

    test('A3: list never hydrates a skeleton', async function() {
        var env = await _widgetEnv({ chats: { c1: { id: 'c1', _messagesEvicted: true, _msgCount: 2 } } });
        var res = await env.run({ action: 'list' }, 0, { chatId: 'c1' });
        assert.strictEqual(res.success, true);
        assert.strictEqual(env.log.ensure.length, 0);
    }, { tags: ['unit'] });

    test('A4: save on a chat evicted mid-commit: re-reads the live chat, hydrates BEFORE the save', async function() {
        var chats = { c1: { id: 'c1', messages: [{ role: 'user', content: 'q' }] } };
        var env = await _widgetSaveEnv({ chats: chats, onCommit: function(cs) {
            // the eviction sweep copies on evict while WidgetStore.commit is awaited
            cs.c1 = { id: 'c1', _messagesEvicted: true, _msgCount: 2 };
        } });
        var res = await env.run({ html: '<p>x</p>', create_new: true }, 0, { chatId: 'c1' });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.id, 'w9');
        assert.deepStrictEqual(env.log.commits, [{ id: 'w9', base: 0, op: 'op1', msgIndex: 1, chatId: 'c1' }]);
        assert.deepStrictEqual(env.log.ensure, ['c1']);
        assert.deepStrictEqual(env.log.order, ['ensure:c1', 'save'], 'hydrate runs before the save');
        assert.strictEqual(chats.c1.widgets.length, 1);
        assert.strictEqual(chats.c1.widgets[0].id, 'w9', 'widget attached to the LIVE (post-commit) chat object');
        assert.strictEqual(env.chatWidgets.c1, chats.c1.widgets);
        assert.deepStrictEqual(env.log.projected, ['w9']);
        assert.strictEqual(env.log.sidebar, 1);
    }, { tags: ['unit'] });

    test('A4b: {html} save on a cold chat that hydrates succeeds (msgIndex from the restored rows)', async function() {
        var chats = { c1: { id: 'c1', _messagesEvicted: true, _msgCount: 2 } };
        var env = await _widgetSaveEnv({ chats: chats, ensure: function(cs, id) {
            cs[id] = { id: id, messages: _widgetMsgs() };
        } });
        var res = await env.run({ html: '<p>x</p>', create_new: true }, 0, { chatId: 'c1' });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.id, 'w9');
        assert.deepStrictEqual(env.log.commits, [{ id: 'w9', base: 0, op: 'op1', msgIndex: 2, chatId: 'c1' }]);
        assert.deepStrictEqual(env.log.order, ['ensure:c1', 'save'], 'one hydrate up front, none before the save');
        assert.strictEqual(chats.c1.widgets[0].id, 'w9');
    }, { tags: ['unit'] });

    test('B: the code editor shows the translated save error; falls back to result.error', async function() {
        var a = await _saveEnv(true);
        await a.run('w1');
        assert.deepStrictEqual(a.log.snack, [['T:VERSION_CONFLICT', 'error']]);
        var b = await _saveEnv(false);
        await b.run('w1');
        assert.deepStrictEqual(b.log.snack, [['Version conflict', 'error']]);
    }, { tags: ['unit'] });

    test('C: updateStreamingText no-ops on a skeleton current chat', async function() {
        var src = await loadFile('src/js/core/050-streaming.js');
        var touched = { n: 0 };
        var document = { getElementById: function() { touched.n++; return null; } };
        var f = new Function('chats', 'currentChatId', 'document', _cutFns(src, ['updateStreamingText']) + '\nreturn updateStreamingText;');
        var fn = f({ c1: { id: 'c1', _messagesEvicted: true, _msgCount: 3 } }, 'c1', document);
        assert.strictEqual(fn({ role: 'assistant', content: 'x' }, 0), undefined);
        assert.strictEqual(touched.n, 0);
        var hot = f({ c1: { id: 'c1', messages: [{ role: 'user', content: 'q' }] } }, 'c1', document);
        hot({ role: 'assistant', content: 'x' }, 1);
        assert.strictEqual(touched.n > 0, true);
    }, { tags: ['unit'] });
});
