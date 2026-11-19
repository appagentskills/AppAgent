// A worker (sub-agent) saving an html_widget while ANOTHER chat is current /
// streaming: the widget card and the split-pane state must land only in the
// worker's chat (family), never the foreground chat; nested calls without a
// chatId fail closed instead of guessing from the globals.
function wwcEnv(src) {
    var env = {
        chats: { fg: { id: 'fg', messages: [], widgets: [] }, sub: { id: 'sub', isSubAgent: true, messages: [{ role: 'tool', tool_call_id: 'tc_eval' }], widgets: [] } },
        chatWidgets: {}, activeStreamingChatId: 'fg', currentChatId: 'fg',
        opened: [], committed: [],
        WidgetStore: {
            init: function() { return Promise.resolve(); }, list: function() { return []; },
            view: function(id) { return { id: id, title: 'W', latestVersion: 1 }; }, read: function() { return Promise.resolve(); },
            commit: function(id, d, ev, op, meta) { env.committed.push(meta.chatId); return Promise.resolve({ success: true, version: 1 }); },
            project: function() {}
        },
        widgetEditTarget: function() { return null; },
        widgetOperationId: function() { return Promise.resolve('op'); },
        widgetIdForOperation: function() { return Promise.resolve('widget_x'); },
        recordWidgetRender: function() { return null; },
        widgetSplitPaneBusy: function() { return false; },
        openSplitViewForWidget: function(id, chatId) { env.opened.push(chatId); },
        ensureChatPayloads: function() { return Promise.resolve(); },
        saveChatsToStorage: function() { return Promise.resolve(); },
        renderWidgetSidebar: function() {}, addWidgetToDashboard: function() {},
        splitViewNoteSlotPatch: function() {}, splitViewSettleSlotPatch: function() {},
        widgetConflictRebasePayload: function(x, c) { return c; }
    };
    var body = src.slice(src.indexOf('async function executeHtmlWidget('), src.indexOf('// pin_widget tool'));
    var names = Object.keys(env).filter(function(k) { return k !== 'opened' && k !== 'committed'; });
    env.run = new Function(names, body + '\nreturn executeHtmlWidget;').apply(null, names.map(function(n) { return env[n]; }));
    return env;
}

test('worker html_widget save lands only in the worker chat while another chat streams', async function() {
    var env = wwcEnv(await loadFile('src/js/tools/080-widget-tools.js'));
    var r = await env.run({ title: 'W', html: '<b>x</b>' }, 0, { chatId: 'sub', fromSandbox: true, parentToolCallId: 'tc_eval' });
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual(env.committed, ['sub']);
    assert.deepStrictEqual(env.opened, ['sub']);
    assert.strictEqual(env.chats.sub.widgets.length, 1);
    assert.strictEqual(env.chats.fg.widgets.length, 0);
}, { tags: ['unit'], timeout: 3000 });

test('nested html_widget without chatId fails closed (no fallback to foreground chat)', async function() {
    var env = wwcEnv(await loadFile('src/js/tools/080-widget-tools.js'));
    var r = await env.run({ title: 'W', html: '<b>x</b>' }, 0, { fromSandbox: true, parentToolCallId: 'file_card' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'CHAT_UNRESOLVED');
    assert.deepStrictEqual(env.committed, []);
    assert.deepStrictEqual(env.opened, []);
    assert.strictEqual(env.chats.fg.widgets.length, 0);
    // Plain top-level foreground call keeps the legacy fallback.
    var top = await env.run({ title: 'W', html: '<b>y</b>' }, 0, {});
    assert.strictEqual(top.success, true);
    assert.deepStrictEqual(env.committed, ['fg']);
}, { tags: ['unit'], timeout: 3000 });

test('get_file download card forwards the calling chat to html_widget', async function() {
    var src = await loadFile('src/js/tools/040-file-store.js');
    var _h = src.indexOf('function fileStoreCardToolOptions(');
    var fn = src.slice(_h, src.indexOf('// =============================================', _h));
    // Defined after executeGetFile so the local-folder-share harness slice
    // (executeGetFile .. next banner) includes it.
    assert.ok(src.indexOf('async function executeGetFile(') < _h, 'helper below executeGetFile');
    var opts = new Function(fn + '\nreturn fileStoreCardToolOptions;')();
    assert.deepStrictEqual(opts({ chatId: 'sub', toolCallId: 'tc_get' }), { chatId: 'sub', fromSandbox: true, parentToolCallId: 'tc_get' });
    assert.deepStrictEqual(opts({ chatId: 'sub', toolCallId: 'x', parentToolCallId: 'tc_eval' }).parentToolCallId, 'tc_eval');
    assert.strictEqual(opts(null).chatId, null);
    assert.match(src, /executeTool\('html_widget', \{[^\n]*\}, undefined, fileStoreCardToolOptions\(_options\)\)/);
    var disp = await loadFile('src/js/tools/020-tool-execution.js');
    assert.match(disp, /return await executeGetFile\(args, options\);/);
}, { tags: ['unit'], timeout: 3000 });

test('split_view: nested calls never fall back to the foreground chat; agent auto-open needs a chatId', async function() {
    var src = await loadFile('src/js/core/082-split-view.js');
    var a = src.slice(src.indexOf('function _splitViewChatId('), src.indexOf('function _splitViewDescribe('));
    var b = src.slice(src.indexOf('function openSplitViewForWidget('), src.indexOf('// Header/toolbar button handler'));
    var set = [];
    var api = new Function('activeStreamingChatId', 'currentChatId', 'getWidgetById', 'setSplitViewState', '_splitViewLatestVersion', 'renderSplitViewPane',
        a + b + '\nreturn { chatId: _splitViewChatId, open: openSplitViewForWidget };')(
        'fg', 'fg', function(id) { return { id: id, title: 'W' }; },
        function(c) { set.push(c); return Promise.resolve(); }, function() { return 1; }, function() {});
    assert.strictEqual(api.chatId({ chatId: 'sub' }), 'sub');
    assert.strictEqual(api.chatId({ fromSandbox: true }), null);
    assert.strictEqual(api.chatId({}), 'fg');
    assert.strictEqual(await api.open('w1', null, { openedBy: 'agent' }), false);
    assert.strictEqual(await api.open('w1', 'sub', { openedBy: 'agent' }), true);
    assert.strictEqual(await api.open('w1', null, {}), true);
    assert.deepStrictEqual(set, ['sub', 'fg']);
}, { tags: ['unit'], timeout: 3000 });

test('SW gate: nested chat-less html_widget list/read/export pass; save/split/display refused', async function() {
    var src = await loadFile('src/js/worker/120-tool-routing.js');
    var a = src.indexOf('    var _nestedUi = '), b = src.indexOf('    // UI-required tool.', a);
    assert.ok(a > -1 && b > a, 'gate slice');
    var gate = new Function('name', 'args', 'options', src.slice(a, b) + '\nreturn null;');
    var nested = { fromSandbox: true, parentToolCallId: 'tc_eval' };
    ['list', 'read', 'export'].forEach(function(act) {
        assert.strictEqual(gate('html_widget', { action: act, widget_id: 'w' }, nested), null, act + ' must pass');
    });
    assert.strictEqual(gate('html_widget', { title: 'W', html: 'x' }, nested).code, 'CHAT_UNRESOLVED');
    assert.strictEqual(gate('html_widget', { action: 'patch', widget_id: 'w' }, nested).code, 'CHAT_UNRESOLVED');
    assert.strictEqual(gate('split_view', { action: 'list' }, nested).code, 'CHAT_UNRESOLVED');
    assert.strictEqual(gate('display', { template: 'table' }, { fromWidget: true }).code, 'CHAT_UNRESOLVED');
    assert.strictEqual(gate('html_widget', { title: 'W' }, { chatId: 'sub', fromSandbox: true }), null, 'chatId given');
    assert.strictEqual(gate('html_widget', { title: 'W' }, {}), null, 'top-level untouched');
}, { tags: ['unit'], timeout: 3000 });

function wwcDisplay(src) {
    var env = { chats: { fg: { id: 'fg', messages: [] }, sub: { id: 'sub', messages: [] } }, saved: 0 };
    var a = src.indexOf('var _displayIdCounter'), b = src.indexOf('// A real tool_use', a);
    var c = src.indexOf('function _displayIsSlotId('), d = src.indexOf('var _displayPlacedCache', c);
    assert.ok(a > -1 && b > a && c > -1 && d > c, 'display slice');
    env.run = new Function('DISPLAY_GENERATORS', 'chats', 'activeStreamingChatId', 'currentChatId', 'saveChatsToStorage',
        src.slice(a, b) + src.slice(c, d) + '\nreturn executeDisplay;')(
        { table: function() { return '<table></table>'; } }, env.chats, 'fg', 'fg', function() { env.saved++; });
    return env;
}

test('display: nested call without chatId fails closed; top-level keeps the fallback', async function() {
    var env = wwcDisplay(await loadFile('src/js/tools/090-display-templates.js'));
    var r = env.run({ template: 'table' }, 0, { fromSandbox: true, parentToolCallId: 'tc_eval' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'CHAT_UNRESOLVED');
    assert.strictEqual(env.run({ template: 'table' }, 0, { fromWidget: true }).code, 'CHAT_UNRESOLVED');
    assert.strictEqual(env.chats.fg.displays, undefined, 'nothing persisted on the foreground chat');
    var ok = env.run({ template: 'table' }, 0, { chatId: 'sub', fromSandbox: true, parentToolCallId: 'tc_eval' });
    assert.strictEqual(ok.success, true);
    assert.strictEqual(Object.keys(env.chats.sub.displays).length, 1);
    assert.strictEqual(env.chats.fg.displays, undefined);
    var top = env.run({ template: 'table' }, 0, {});
    assert.strictEqual(top.success, true);
    assert.strictEqual(Object.keys(env.chats.fg.displays).length, 1, 'top-level falls back to the foreground chat');
}, { tags: ['unit'], timeout: 3000 });

test('get_file download: refused card surfaces card_error, success kept', async function() {
    var src = await loadFile('src/js/tools/040-file-store.js');
    var a = src.indexOf('async function executeGetFile('), b = src.indexOf('// =============================================', a);
    var seen = [];
    function mk(widgetResult) {
        return new Function('getFileAsync', 'executeTool', 't', 'i18nFormatNumber', 'chats', '_fileIndexColdReady', '_chatFileIdsSync',
            src.slice(a, b) + '\nreturn executeGetFile;')(
            async function(id) { return { id: id, name: 'f.bin', mime: 'application/octet-stream', data: 'data:application/octet-stream;base64,QUJD' }; },
            async function(n, x, mi, opts) { seen.push(opts); return widgetResult; },
            function(s) { return s; }, function(n) { return String(n); }, {}, async function() {}, function() { return []; });
    }
    var refused = await mk({ success: false, code: 'CHAT_UNRESOLVED', error: 'html_widget: the calling chat could not be identified' })({ id: 'file_1', download: true }, {});
    assert.strictEqual(refused.success, true);
    assert.ok(refused.download_url);
    assert.strictEqual(refused.widgetId, undefined);
    assert.match(refused.card_error, /calling chat could not be identified/);
    var ok = await mk({ success: true, widgetId: 'w1' })({ id: 'file_1', download: true }, { chatId: 'sub', toolCallId: 'tc_get' });
    assert.strictEqual(ok.widgetId, 'w1');
    assert.strictEqual(ok.card_error, undefined);
    assert.strictEqual(seen[1].chatId, 'sub');
}, { tags: ['unit'], timeout: 3000 });
