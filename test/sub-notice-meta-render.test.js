// SUB-NOTICE-META (B part 2b): notices render from structured subNotices
// (legacy regex path for leftovers / old rows / drifted text), the queued
// bubble passes the entry's meta, and buildAPIMessages never caches an
// injected notice row. Runs the REAL ui/175 + app/020 modules, and
// the REAL ui/250 renderMessages / renderQueuedUserBubble on a mounted DOM.
'use strict';
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var _q = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
var FINAL = 'Sub-agent "Alpha" (sub_a) reported (done):\nAll good\n\u2014 full report via await_handle("h1") or agent_status.';
var LIFE_B = '[sub-agent lifecycle] Beta (sub_b): STUCK \u2014 no progress';
var MSG_SUM = '**hi**\n\n- item';
var MSG = '[sub-agent lifecycle] Alpha (sub_a): sent a message: **hi** - item';
function metaFinal(name) { return { kind: 'final', agentId: 'sub_a', name: name || 'Alpha', status: 'done', summary: 'All good', text: FINAL }; }
function metaMsg() { return { kind: 'message', agentId: 'sub_a', name: 'Alpha', status: 'running', summary: MSG_SUM, text: MSG }; }
var BIG = 'x'.repeat(20000);
async function load(extra) {
    var g = { self: {}, window: fakeWindow(), console: _q, escapeHtml: esc,
        formatContent: function(s) { return '<md>' + esc(s) + '</md>'; }, chats: {} };
    Object.keys(extra || {}).forEach(function(k) { g[k] = extra[k]; });
    return loadModules(['src/js/ui/175-sub-agent-ui.js', 'src/js/app/020-api-messages.js'], { lenient: true, globals: g });
}
function count(html, re) { return (html.match(re) || []).length; }

describe('sub-notice metadata rendering (175)', function() {
    test('meta row: cards from meta fields, leftover text via the legacy path', async function() {
        var u = await load();
        var text = 'hello **user**\n\n' + FINAL + '\n\n' + LIFE_B;
        var html = u.renderSubReportNotices(text, [], [], [metaFinal('Alpha META')]);
        assert.ok(html.indexOf('Alpha META') >= 0, 'name from meta, not the regex capture');
        assert.ok(html.indexOf(u._subNoticeCardHtml('Alpha META', 'sub_a', 'done', 'All good', 'final')) >= 0, 'final card from meta');
        assert.ok(html.indexOf('<div class="user-text user-text-md"><md>hello **user**</md></div>') === 0, 'leading user text kept');
        assert.ok(html.indexOf(u._subNoticeCardHtml('Beta', 'sub_b', 'need_input', 'STUCK \u2014 no progress', 'mid')) >= 0, 'legacy lifecycle in leftover still a card');
        assert.strictEqual(count(html, /class="sub-notice /g), 2);
    });
    test('legacy row (no subNotices) renders exactly as before', async function() {
        var u = await load();
        var text = 'pre\n\n' + FINAL + '\n\n' + LIFE_B;
        var legacy = u.renderSubReportNotices(text, [], []);
        var expected = '<div class="user-text user-text-md"><md>pre</md></div>'
            + u._subNoticeCardHtml('Alpha', 'sub_a', 'done', 'All good', 'final')
            + u._subNoticeCardHtml('Beta', 'sub_b', 'need_input', 'STUCK \u2014 no progress', 'mid');
        assert.strictEqual(legacy, expected);
        assert.strictEqual(u.renderSubReportNotices(text, [], [], undefined), legacy);
        assert.strictEqual(u.renderSubReportNotices(text, [], [], []), legacy);
        assert.strictEqual(u.renderSubReportNotices('plain text', [], [], undefined), null);
    });
    test("kind:'message' hidden when its sub_msg row exists, else full markdown", async function() {
        var u = await load();
        var row = { role: 'sub_msg', subAgentId: 'sub_a', text: MSG_SUM };
        var used = [];
        assert.strictEqual(u.renderSubReportNotices(MSG, [row], used, [metaMsg()]), '', 'duplicate of the standalone callout hidden');
        assert.deepStrictEqual(used, [row], 'paired one-to-one');
        var shown = u.renderSubReportNotices(MSG, [row], used, [metaMsg()]);
        assert.ok(shown.indexOf('<md>' + esc(MSG_SUM) + '</md>') >= 0, 'full multi-line markdown when the row is already paired: ' + shown);
        assert.ok(shown.indexOf('Message to parent') >= 0 && shown.indexOf('id="msg-') < 0);
        var none = u.renderSubReportNotices('lead\n\n' + MSG, [], [], [metaMsg()]);
        assert.ok(none.indexOf('<md>' + esc(MSG_SUM) + '</md>') >= 0 && none.indexOf('<md>lead</md>') >= 0);
    });
    test('indexOf miss (drifted text) falls back to legacy for the whole row', async function() {
        var u = await load();
        var text = 'pre\n\n' + FINAL;
        var drift = metaFinal('Alpha META'); drift.text = FINAL + ' (edited)';
        var legacy = u.renderSubReportNotices(text, [], []);
        assert.strictEqual(u.renderSubReportNotices(text, [], [], [metaFinal(), drift]), legacy);
        assert.strictEqual(u.renderSubReportNotices(text, [], [], [{ kind: 'final' }]), legacy, 'malformed meta');
        assert.ok(legacy.indexOf('Alpha META') < 0);
    });
    test('repeated identical notices pair with distinct spans', async function() {
        var u = await load();
        var html = u.renderSubReportNotices(FINAL + '\n\n' + FINAL, [], [], [metaFinal('M1'), metaFinal('M2')]);
        assert.ok(html.indexOf('M1') >= 0 && html.indexOf('M2') >= 0 && html.indexOf('M1') < html.indexOf('M2'));
        assert.strictEqual(count(html, /class="sub-notice /g), 2);
    });
}, { tags: ['unit'], timeout: 5000 });

var UI_FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js', 'src/js/tools/100-prompt-user.js',
    'src/js/ui/175-sub-agent-ui.js', 'src/js/app/020-api-messages.js', 'src/js/ui/250-message-render.js'];
var UI_ALLOW = ['smartDocuments', '_isChatInSilentHook', 'currentEditingWidget', 'getDisplayHtmlForMessage', 'isChatRunning', 'AgentEvents',
    'ensureChatPayloads', 'postPromptRowToSW', '_refreshWaitingBadges', 'setActionNeedsInput', 'loadDocumentById', 'sdocReRenderAll',
    '_promptResultViaSW', 'recordToolResult', 'runAgent'];
function noop() { return ''; }
async function mountChat(rows, extra) {
    var s = U.stubs();
    var g = Object.assign({
        chats: { c1: { id: 'c1', messages: rows } }, currentChatId: 'c1', activeStreamingChatId: null, compactToolCalls: false, showApiStats: false,
        currentView: 'chat', hooksEnabled: {}, compactAreaExpandedState: {}, thinkingExpandedState: {}, userMsgExpandedState: {},
        pendingInjectionsByChatId: {}, runningChatIds: {}, pausedChats: {}, stickToBottom: false, pinToBottom: false,
        SubAgents: { getById: function() { return null; }, getByChatId: function() { return null; }, listAll: function() { return []; },
            addListener: function() {}, removeListener: function() {} },
        showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage, getCacheCharLimit: function() { return 16000; },
        updateContextIndicator: noop, updateInputPosition: noop, getWidgetHtmlForMessage: noop, renderInlineChanges: noop,
        initializeWidgetsInView: noop, renderWidgetSidebar: noop, initDisplayChecklists: noop, scrollToBottomIfAllowed: noop, restoreChatScrollTop: noop
    }, extra || {});
    var m = await U.loadUi(UI_FILES, { globals: g, allowUnstubbed: UI_ALLOW, lenient: true });
    var dom = await U.mountDom({ html: '<div id="input-area"></div><div id="messages" class="messages"></div>' });
    return { m: m, dom: dom, g: g };
}
function pill(dom, i) { return dom.$('#msg-' + i + ' .user-cached-badge'); }

describe('250 renders real rows: cached pill vs notice cards', function() {
    afterEach(function() { U.cleanupAll(); });
    test('a cached plain row shows the pill', async function() {
        var t = await mountChat([{ role: 'user', content: BIG, cachedContentId: 'old' }]);
        t.m.renderMessages();
        assert.ok(pill(t.dom, 0), 'cached pill');
        assert.strictEqual(t.dom.$$('#msg-0 .sub-notice').length, 0);
    });
    test('a cached meta row with a small remainder shows cards named from the meta', async function() {
        var t = await mountChat([{ role: 'user', injected: true, content: 'hi **there**\n\n' + FINAL, subNotices: [metaFinal('Alpha META')], cachedContentId: 'old' }]);
        t.m.renderMessages();
        assert.strictEqual(pill(t.dom, 0), null, 'no cached pill');
        var row = t.dom.$('#msg-0');
        assert.ok(row && row.classList.contains('sub-notice-msg'), 'notice row');
        var cards = t.dom.$$('#msg-0 .sub-notice');
        assert.strictEqual(cards.length, 1);
        assert.ok(cards[0].textContent.indexOf('Alpha META') >= 0, 'name from the meta: ' + cards[0].textContent);
        assert.ok(row.textContent.indexOf('there') >= 0, 'user remainder kept');
    });
    test('a cached typed row over 16 KB shows the pill', async function() {
        var t = await mountChat([{ role: 'user', injected: true, hasUserText: true, content: BIG + '\n\n' + FINAL, subNotices: [metaFinal()], cachedContentId: 'old' }]);
        t.m.renderMessages();
        assert.ok(pill(t.dom, 0), 'typed text over the limit keeps the cached pill');
        assert.strictEqual(t.dom.$$('#msg-0 .sub-notice').length, 0);
    });
    test('a cached legacy inbox row shows the pill', async function() {
        var t = await mountChat([{ role: 'user', injected: true, content: '[1 message(s) from parent / inbox]\n1. ' + BIG, cachedContentId: 'old' }]);
        t.m.renderMessages();
        assert.ok(pill(t.dom, 0), 'inbox drain keeps the cached pill');
        assert.strictEqual(t.dom.$$('#msg-0 .sub-notice').length, 0);
    });
    test('renderQueuedUserBubble renders the entry meta as cards', async function() {
        var t = await mountChat([], { runningChatIds: { c1: true },
            pendingInjectionsByChatId: { c1: { text: 'hi\n\n' + FINAL, images: [], subNotices: [metaFinal('Alpha META')] } } });
        t.m.renderQueuedUserBubble(t.dom.$('#messages'));
        var q = t.dom.$('.message.user.queued');
        assert.ok(q && q.classList.contains('sub-notice-msg'), 'queued notice bubble');
        assert.strictEqual(q.querySelectorAll('.sub-notice').length, 1);
        assert.ok(q.textContent.indexOf('Alpha META') >= 0, 'name from the entry meta');
    });
    test('renderQueuedUserBubble: no bubble when every notice is already a standalone callout', async function() {
        var t = await mountChat([{ role: 'sub_msg', subAgentId: 'sub_a', subAgentName: 'Alpha', text: MSG_SUM }], { runningChatIds: { c1: true },
            pendingInjectionsByChatId: { c1: { text: MSG, images: [], subNotices: [metaMsg()] } } });
        t.m.renderQueuedUserBubble(t.dom.$('#messages'));
        assert.strictEqual(t.dom.$('.message.user.queued'), null, 'no empty bubble');
        assert.ok(t.g.pendingInjectionsByChatId.c1, 'entry still pending');
    });
}, { tags: ['unit'], timeout: 5000 });

describe('maybeCacheUserContent skips injected notice rows (020)', function() {
    async function build(rows, cachedToolResults) {
        var chats = { c1: { messages: rows, cachedToolResults: cachedToolResults || {} } };
        var m = await load({ chats: chats, getCacheCharLimit: function() { return 16000; }, saveChatsToStorage: function() {},
            processUserMessageForCache: function(id, c) { return c.length > 16000 ? { contentId: 'new_id', apiContent: 'STUB' } : null; } });
        return m.buildAPIMessages(rows, 'c1');
    }
    test('notice rows over 16 KB reach the model in full (incl. a stale cachedContentId)', async function() {
        var NOTICE = 'Sub-agent "Alpha" (sub_a) reported (done):\n' + BIG + '\n\u2014 full report via await_handle("h1") or agent_status.';
        var metaRow = { role: 'user', injected: true, content: NOTICE,
            subNotices: [{ kind: 'final', agentId: 'sub_a', name: 'Alpha', status: 'done', summary: BIG, text: NOTICE }] };
        var legacyCached = { role: 'user', injected: true, content: NOTICE, cachedContentId: 'old' };
        var out = await build([metaRow, { role: 'assistant', content: 'ok' }, legacyCached], { old: { size: NOTICE.length, fullContent: NOTICE } });
        assert.deepStrictEqual(out[0], { role: 'user', content: NOTICE });
        assert.deepStrictEqual(out[2], { role: 'user', content: NOTICE });
        assert.strictEqual(metaRow.cachedContentId, undefined, 'not cached now');
    });
    test('hasUserText, normal user and context rows keep today\u2019s caching', async function() {
        var typed = { role: 'user', injected: true, hasUserText: true, content: FINAL + BIG, subNotices: [metaFinal()] };
        var normal = { role: 'user', content: BIG };
        var ctx = { role: 'context', content: BIG };
        var prior = { role: 'user', content: BIG, cachedContentId: 'old' };
        var old = { old: { size: 20000, fullContent: BIG } };
        assert.strictEqual((await build([typed]))[0].content, 'STUB');
        assert.strictEqual((await build([normal]))[0].content, 'STUB');
        assert.strictEqual((await build([ctx]))[0].content, 'STUB');
        var p = (await build([prior], old))[0].content;
        assert.ok(p.indexOf('[User pasted a long message \u2014 cached]') === 0 && p.indexOf('"old"') > 0);
        assert.strictEqual(typed.cachedContentId, 'new_id');
    });
    test('250 cached branch: a legacy injected cached notice row renders as cards, not the pill', async function() {
        var u = await load();
        var row = { role: 'user', injected: true, content: FINAL, cachedContentId: 'old' };
        assert.strictEqual(u._isInjectedSubNoticeRow(row), true);
        assert.strictEqual(u._isInjectedSubNoticeRow({ role: 'user', injected: true, content: 'typed', cachedContentId: 'x' }), false);
        assert.strictEqual(u._isInjectedSubNoticeRow({ role: 'user', content: FINAL }), false, 'not injected');
        var html = u.renderSubReportNotices(row.content, [], [], row.subNotices);
        assert.strictEqual(html, u._subNoticeCardHtml('Alpha', 'sub_a', 'done', 'All good', 'final'));
    });
}, { tags: ['unit'], timeout: 5000 });
