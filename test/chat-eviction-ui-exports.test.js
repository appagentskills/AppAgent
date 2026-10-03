// C2-ui exports/history: skeleton-safe history stats/previews (ui/050 via
// skeletonScanValue, ui/120), the search re-render hook, and fail-closed
// exports (ui/050 single + bulk, ui/210 downloadChat): a skeleton whose
// stored messages cannot be loaded is NEVER exported as a message-less chat.
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

var UTIL_FNS = ['_isSkeletonChat', '_skelScanSig', '_skelClone', 'skeletonScanValue', '_skelScanPump'];
var HIST_FNS = ['_historyChatVisible', '_historyIsSkeleton', '_historyRerender', '_historyScan', '_historyChatCostLive',
    '_historySweepAfterExport', 'getChatStats', '_historyMsgStatsLive', 'getHistoryChatPreview', '_historyPreviewClipped',
    '_historyPreviewLive', 'getContextLength', '_historyContextLengthLive', 'filterHistoryChats',
    'exportChatFromHistory', 'downloadChatHistory'];
var MENU_FNS = ['downloadChat'];

function _t(s, p) {
    return String(s).replace(/\{(\w+)\}/g, function(m, k) { return (p && k in p) ? String(p[k]) : m; });
}

// opts: { chats, ensureChatPayloads, loadChatRowFromDB }
async function _env(opts) {
    var hv = await loadFile('src/js/ui/050-history-view.js');
    var uu = await loadFile('src/js/ui/120-ui-utils.js');
    var cm = await loadFile('src/js/ui/210-chat-menus.js');
    var log = { snack: [], blobs: [], sweeps: 0, rerenders: 0, reads: 0, search: [], timers: [] };
    var body = 'var _skelScanMemo = {}, _skelScanWant = {}, _skelScanQueue = [], _skelScanBusy = false,'
        + ' _skelScanRerenders = [], _skelScanTimer = null;\n'
        + _cutFns(uu, UTIL_FNS) + '\n' + _cutFns(hv, HIST_FNS) + '\n' + _cutFns(cm, MENU_FNS) + '\n'
        + 'return { getChatStats: getChatStats, getHistoryChatPreview: getHistoryChatPreview,'
        + ' getContextLength: getContextLength, filterHistoryChats: filterHistoryChats,'
        + ' _historyRerender: _historyRerender, exportChatFromHistory: exportChatFromHistory,'
        + ' downloadChatHistory: downloadChatHistory, downloadChat: downloadChat };';
    var chats = opts.chats || {};
    var f = new Function('chats', 'currentView', 'renderHistoryPage', 'chatMessageCount', 'ensureChatPayloads',
        'loadChatRowFromDB', 'sweepColdChatPayloads', 'CHAT_KEEP_HYDRATED', 'showSnackbar', 't', 'tn',
        'i18nFormatNumber', 'Blob', 'URL', 'document', 'console', 'setTimeout', 'clearTimeout', 'estimateTokens',
        'getWidgetsForChat', 'dashboardWidgets', 'chatMatchesSearch', 'stripTransientChatFieldsForPut', body);
    var api = f(chats, 'history',
        function() { log.rerenders++; },
        function(c) { return !c ? 0 : Array.isArray(c.messages) ? c.messages.length : (c._msgCount || 0); },
        opts.ensureChatPayloads || function() { return Promise.resolve(); },
        function(id) { log.reads++; return Promise.resolve(opts.loadChatRowFromDB ? opts.loadChatRowFromDB(id) : null); },
        function() { log.sweeps++; return 0; }, 8,
        function(msg, kind) { log.snack.push({ msg: msg, kind: kind }); },
        _t,
        function(n, one, many, p) { var q = Object.assign({ count: n }, p || {}); return _t(n === 1 ? one : many, q); },
        function(n) { return String(n); },
        function(parts) { log.blobs.push(parts.join('')); },
        { createObjectURL: function() { return 'blob:x'; }, revokeObjectURL: function() {} },
        { createElement: function() { return { click: function() {} }; }, body: { appendChild: function() {}, removeChild: function() {} } },
        { warn: function() {}, error: function() {}, log: function() {} },
        function(fn) { log.timers.push(fn); return log.timers.length; },
        function() {},
        function(s) { return String(s).length; },
        function() { return []; }, {},
        function(chat, q, onLate) { log.search.push({ id: chat.id, onLate: onLate }); return true; },
        function(rec) { var o = {}; Object.keys(rec).forEach(function(k) { if (k.charAt(0) !== '_' || k === '_payloadsEvicted') o[k] = rec[k]; }); return o; });
    api.log = log;
    return api;
}

function _rowMsgs() {
    return [{ role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there', tool_calls: [{ function: { name: 'x', arguments: '{}' } }],
            metrics: { cost: 0.5, actualModel: 'm1' } }];
}
function _skel(id) { return { id: id, title: 'S ' + id, _messagesEvicted: true, _msgCount: 2, versionHistory: [] }; }
async function _flush() { for (var i = 0; i < 30; i++) await null; }

describe('C2-ui: history stats/previews + exports on skeletons', function() {
    test('hydrated chat: stats/preview/context computed live, no row read', async function() {
        var chats = { h: { id: 'h', title: 'H', messages: _rowMsgs(), versionHistory: [] } };
        var m = await _env({ chats: chats });
        var s = m.getChatStats('h');
        assert.strictEqual(s.toolCalls, 1);
        assert.strictEqual(s.cost, 0.5);
        assert.strictEqual(s.model, 'm1');
        assert.deepStrictEqual(m.getHistoryChatPreview(chats.h), { user: 'hello', assistant: 'hi there' });
        assert.strictEqual(m.getContextLength(chats.h), 15);
        assert.strictEqual(m.log.reads, 0);
    }, { tags: ['unit'] });

    test('skeleton: fallback first, then stored-row values after one lazy read + one re-render', async function() {
        var chats = { s: _skel('s') };
        var m = await _env({ chats: chats, loadChatRowFromDB: function(id) { return { id: id, messages: _rowMsgs() }; } });
        var s0 = m.getChatStats('s');
        assert.strictEqual(s0.toolCalls, 0);
        assert.deepStrictEqual(m.getHistoryChatPreview(chats.s), { user: '', assistant: '' });
        assert.strictEqual(m.getContextLength(chats.s), 0);
        await _flush();
        assert.ok(m.log.reads >= 1, 'stored row read');
        assert.ok(!Array.isArray(chats.s.messages), 'row never attached to chats');
        var s1 = m.getChatStats('s');
        assert.strictEqual(s1.toolCalls, 1);
        assert.strictEqual(s1.cost, 0.5);
        assert.strictEqual(s1.model, 'm1');
        assert.deepStrictEqual(m.getHistoryChatPreview(chats.s), { user: 'hello', assistant: 'hi there' });
        assert.strictEqual(m.getContextLength(chats.s), 15);
        assert.ok(m.log.timers.length >= 1, 'debounced re-render scheduled');
        m.log.timers[m.log.timers.length - 1]();
        assert.strictEqual(m.log.rerenders, 1);
    }, { tags: ['unit'] });

    test('history search passes its own re-render hook to chatMatchesSearch', async function() {
        var m = await _env({ chats: { a: { id: 'a', title: 'A', messages: [] } } });
        assert.deepStrictEqual(m.filterHistoryChats('zz'), ['a']);
        assert.strictEqual(m.log.search[0].onLate, m._historyRerender);
    }, { tags: ['unit'] });

    test('single export: hydrate miss aborts with an error, no file', async function() {
        var m = await _env({ chats: { s: _skel('s') } });
        await m.exportChatFromHistory('s');
        assert.strictEqual(m.log.blobs.length, 0);
        assert.strictEqual(m.log.snack[0].kind, 'error');
        assert.ok(/could not be loaded/.test(m.log.snack[0].msg));
    }, { tags: ['unit'] });

    test('single export: hydrated skeleton exports its messages, then sweeps', async function() {
        var chats = { s: _skel('s') };
        var m = await _env({ chats: chats, ensureChatPayloads: async function(id) {
            delete chats[id]._messagesEvicted; delete chats[id]._msgCount; chats[id].messages = _rowMsgs();
        } });
        await m.exportChatFromHistory('s');
        assert.strictEqual(m.log.blobs.length, 1);
        assert.strictEqual(JSON.parse(m.log.blobs[0]).messages.length, 2);
        assert.strictEqual(m.log.sweeps, 1);
        assert.strictEqual(m.log.snack[0].kind, 'success');
    }, { tags: ['unit'] });

    test('bulk export: skips a skeleton on hydrate miss (never messages:[]), counts it incomplete', async function() {
        var chats = { h: { id: 'h', title: 'H', messages: _rowMsgs() }, s: _skel('s') };
        var m = await _env({ chats: chats });
        await m.downloadChatHistory();
        assert.strictEqual(m.log.blobs.length, 1);
        var out = JSON.parse(m.log.blobs[0]);
        assert.strictEqual(out.totalChats, 1);
        assert.deepStrictEqual(Object.keys(out.chats), ['h']);
        assert.strictEqual(out.chats.h.messages.length, 2);
        assert.strictEqual(m.log.snack[0].kind, 'warning');
        assert.strictEqual(m.log.sweeps, 0);
    }, { tags: ['unit'] });

    test('bulk export: a skeleton that hydrates is exported with its messages, success, one sweep', async function() {
        var chats = { h: { id: 'h', title: 'H', messages: _rowMsgs() }, s: _skel('s') };
        var ensured = [];
        var m = await _env({ chats: chats, ensureChatPayloads: async function(id) {
            ensured.push(id);
            if (chats[id]._messagesEvicted) { delete chats[id]._messagesEvicted; delete chats[id]._msgCount; chats[id].messages = _rowMsgs(); }
        } });
        await m.downloadChatHistory();
        assert.deepStrictEqual(ensured, ['h', 's']);
        assert.strictEqual(m.log.blobs.length, 1);
        var out = JSON.parse(m.log.blobs[0]);
        assert.strictEqual(out.totalChats, 2);
        assert.deepStrictEqual(Object.keys(out.chats), ['h', 's']);
        assert.strictEqual(out.chats.s.messages.length, 2);
        assert.strictEqual(out.chats.s.title, 'S s');
        assert.strictEqual(m.log.snack.length, 1);
        assert.strictEqual(m.log.snack[0].kind, 'success');
        assert.strictEqual(m.log.sweeps, 1, 'only the formerly-cold chat is re-swept');
    }, { tags: ['unit'] });

    test('bulk export: non-skeleton chats unchanged (no sweep)', async function() {
        var chats = { h: { id: 'h', title: 'H', messages: [] } };
        var m = await _env({ chats: chats });
        await m.downloadChatHistory();
        var out = JSON.parse(m.log.blobs[0]);
        assert.deepStrictEqual(out.chats.h.messages, []);
        assert.strictEqual(m.log.snack[0].kind, 'success');
        assert.strictEqual(m.log.sweeps, 0);
    }, { tags: ['unit'] });

    test('ui/210 downloadChat: hydrate miss fails closed; hit exports + sweeps', async function() {
        var m = await _env({ chats: { s: _skel('s') } });
        await m.downloadChat('s');
        assert.strictEqual(m.log.blobs.length, 0);
        assert.strictEqual(m.log.snack[0].kind, 'error');
        var chats = { s: _skel('s') };
        var m2 = await _env({ chats: chats, ensureChatPayloads: async function(id) {
            delete chats[id]._messagesEvicted; delete chats[id]._msgCount; chats[id].messages = _rowMsgs();
        } });
        await m2.downloadChat('s');
        assert.strictEqual(m2.log.blobs.length, 1);
        assert.strictEqual(JSON.parse(m2.log.blobs[0]).chat.messages.length, 2);
        assert.strictEqual(m2.log.sweeps, 1);
    }, { tags: ['unit'] });
});
