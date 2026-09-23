// Sub-agent rendering (group B, part 1): ONE markdown renderer for every sub
// surface, literal-"\n" normalisation, update_action_state `output`, long
// errors as markdown inside <details> (raw JSON / stack payloads stay
// escaped) and a sanitised name that still yields a card. Runs the REAL
// declarations of ui/175-sub-agent-ui.js with the REAL formatContent
// (ui/250-message-render.js) + emoji map (core/055), and the REAL registry
// (core/097) as the notice producer.
// Run: run_tests { files: ['test/sub-notice-render.test.js'] }
'use strict';
var ui = await loadFile('src/js/ui/175-sub-agent-ui.js');
var render = await loadFile('src/js/ui/250-message-render.js');
var emojiSrc = await loadFile('src/js/core/055-emoji-shortcodes.js');

function declaration(source, name, indent) {
    var start = source.indexOf('function ' + name + '(');
    var end = source.indexOf('\n' + (indent || '') + '}', start);
    if (start < 0 || end < 0) throw new Error('missing declaration ' + name);
    return source.slice(start, end + (indent || '').length + 2);
}
function topVar(source, name) {
    var m = source.match(new RegExp('^var ' + name + ' = .*;$', 'm'));
    if (!m) throw new Error('missing var ' + name);
    return m[0];
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
var NAMES = ['_subRenderNewlines', 'renderSubMarkdown', '_subIsRawErrorPayload', '_applySectionIcons', '_liftSectionIcon',
    '_renderSubCollapsibleMarkdown', '_subActionStateHtml', '_subNoticeCardHtml', '_parentMsgCardHtml', 'renderSubAgentMessage',
    'renderSubReportNotices', '_subParentMessageState', '_subParentHistoryKey', '_subThreadEntries', '_hasStandaloneSubMessage'];
function makeUi(brokenFormat) {
    var env = { escapeHtml: esc, window: { currentSearchHighlight: null }, UI_ICONS: { copy: 'C' },
        storeRawCopy: function() { return 'copyX'; }, highlightJS: esc, _knownDocIdRegex: function() { return null; },
        renderDisplayPlaceholder: function() { return '[DSP]'; }, renderDocumentPlaceholder: function() { return '[DOC]'; },
        _subPanelPref: {}, chats: {} };
    var parts = [emojiSrc, ui.slice(ui.indexOf('var _SECTION_EMOJI_RE = '), ui.indexOf('function _liftSectionIcon('))];
    if (brokenFormat) env.formatContent = function() { throw new Error('formatContent exploded'); };
    else parts.push(declaration(render, 'decorateIdMentions'), declaration(render, 'formatContent'));
    parts = parts.concat(['SUB_REPORT_STATUSES', 'SUB_ACTION_STATES', 'SUB_ACTION_TASK_STATUSES', 'SUB_NOTICE_VIEW_ICON',
        'SUB_NOTICE_RE', 'SUB_LIFECYCLE_RE', 'PARENT_INBOX_RE'].map(function(n) { return topVar(ui, n); }))
        .concat(NAMES.map(function(n) { return declaration(ui, n); }))
        .concat([declaration(ui, '_subProgressHtml', '    ')]);
    var names = NAMES.concat(['_subProgressHtml']);
    return new Function('env', 'with(env){\n' + parts.join('\n') + '\nreturn {' + names.map(function(n) { return n + ':' + n; }).join(',') + '};}')(env);
}
function after(html, marker) { var i = html.indexOf(marker); return i < 0 ? '' : html.slice(i); }

describe('sub-agent notice rendering (one renderer)', function() {
    test('the same markdown gives the same HTML on every sub surface', function() {
        var u = makeUi();
        var md = '## :mag: Findings\n\n**Bold** line\n- item one\n- item two\n\n`code` end';
        var H = u.renderSubMarkdown(md);
        assert.ok(H.indexOf('<span class="section-icon">') >= 0, 'section icon lifted: ' + H);
        assert.ok(H.indexOf('<strong>Bold</strong>') >= 0 && H.indexOf('<li>') >= 0, 'markdown rendered: ' + H);
        var body = '<div class="sub-notice-body markdown-body">' + H + '</div>';
        var surfaces = {
            finalCard: u._subNoticeCardHtml('Alpha', 'sub_a', 'done', md, 'final'),
            lifecycleCard: u._subNoticeCardHtml('Alpha', 'sub_a', 'running', md, 'mid'),
            subMsgCallout: u.renderSubAgentMessage({ role: 'sub_msg', subAgentId: 'sub_a', subAgentName: 'Alpha', text: md }, 3),
            actionOutput: u._subActionStateHtml({ state: 'running', label: 'work', output: md })
        };
        Object.keys(surfaces).forEach(function(k) {
            assert.ok(surfaces[k].indexOf(body) >= 0, k + ' renders differently: ' + surfaces[k].slice(0, 400));
        });
        assert.ok(u._subProgressHtml([{ text: md }], 0).indexOf('<div class="sub-report-progress-text markdown-body">' + H + '</div>') >= 0, 'progress stream differs');
        assert.ok(u._renderSubCollapsibleMarkdown(md, 'k1', 'id1').indexOf('markdown-body">' + H + '</span>') >= 0, 'collapsible panel differs');
    });
    test('renderer never throws: a throwing formatContent degrades to escaped text + <br>', function() {
        var u = makeUi(true);
        assert.strictEqual(u.renderSubMarkdown('a\n<b>'), '<span class="md-paragraph">a<br>&lt;b&gt;</span>');
    });
    test('literal \\n is normalised; real newlines, code and a lone literal \\n are untouched', function() {
        var u = makeUi();
        assert.strictEqual(u.renderSubMarkdown('line one\\nline two\\nline three'), u.renderSubMarkdown('line one\nline two\nline three'));
        assert.strictEqual(u.renderSubMarkdown('a\r\nb'), u.renderSubMarkdown('a\nb'));
        assert.strictEqual(u._subRenderNewlines('use \\n to break'), 'use \\n to break', 'one literal \\n is prose');
        var hc = u.renderSubMarkdown('```js\nvar s = "a\\nb\\nc";\n```');
        assert.ok(hc.indexOf('a\\nb\\nc') >= 0, 'code with real newlines keeps its escapes: ' + hc);
        var card = u._subNoticeCardHtml('Alpha', 'sub_a', 'done', '## Done\\n- one\\n- two', 'final');
        assert.ok(card.indexOf('<li>') >= 0 && card.indexOf('\\n') < 0, 'double-escaped report renders as a list: ' + card);
        assert.ok(u._renderSubCollapsibleMarkdown('first\\nsecond\\nthird', 'k2', 'id2').indexOf('+2 lines') >= 0, 'line count on normalised text');
    });
    test('update_action_state output is rendered, and alone keeps the card', function() {
        var u = makeUi();
        var h = u._subActionStateHtml({ state: 'done', output: '**Shipped** PR #1' });
        assert.ok(h.indexOf('sub-action-done') >= 0 && h.indexOf('<strong>Shipped</strong>') >= 0, h);
        assert.strictEqual(u._subActionStateHtml({ state: 'done', output: '   ' }), '');
        assert.strictEqual(u._subActionStateHtml({ state: 'done' }), '');
        var full = u._subActionStateHtml({ state: 'running', label: 'Work', tasks: [{ label: 'T1', status: 'done' }], output: 'out' });
        assert.ok(full.indexOf('>T1<') >= 0 && full.indexOf('sub-notice-body markdown-body') > full.indexOf('>T1<'), 'output under the tasks: ' + full);
    });
    test('a long error renders as markdown inside <details>; JSON and stack payloads stay escaped', function() {
        var u = makeUi();
        var longMd = '**Build failed** on `main`.\n\n- step one broke\n- ' + 'detail '.repeat(60);
        var h = u._subNoticeCardHtml('Alpha', 'sub_a', 'error', longMd, 'final');
        assert.ok(h.indexOf('<details class="sub-notice-collapse">') >= 0, 'collapsed: ' + h.slice(0, 300));
        var full = after(h, 'sub-notice-collapse-full');
        assert.ok(full.indexOf('markdown-body') >= 0 && full.indexOf('<strong>Build failed</strong>') >= 0 && full.indexOf('<li>') >= 0, full.slice(0, 300));
        var link = '[runbook](https://example.com/rb) says: ' + 'retry later '.repeat(40);
        assert.ok(after(u._subNoticeCardHtml('A', 'a', 'error', link, 'final'), 'sub-notice-collapse-full').indexOf('<a ') >= 0, 'a markdown-link lead is prose');
        var json = '{"error":{"type":"overloaded","message":"' + 'x'.repeat(400) + '"}}';
        var stack = 'TypeError: boom\n    at run (chrome-extension://abc/panel.js:10:5)\n    at next (panel.js:20:7)\n' + 'more '.repeat(80);
        [json, stack].forEach(function(p) {
            var c = u._subNoticeCardHtml('A', 'a', 'error', p, 'final');
            var f = after(c, 'sub-notice-collapse-full');
            assert.ok(c.indexOf('<details') >= 0 && f.indexOf('markdown-body') < 0 && f.indexOf('md-paragraph') < 0, 'raw payload escaped: ' + f.slice(0, 200));
        });
        assert.ok(after(u._subNoticeCardHtml('A', 'a', 'error', json, 'final'), 'sub-notice-collapse-full').indexOf('{&quot;error&quot;') >= 0);
        assert.strictEqual(u._subIsRawErrorPayload('at 10:30 the deploy failed'), false);
        assert.strictEqual(u._subIsRawErrorPayload('[x] done'), false);
        assert.strictEqual(u._subIsRawErrorPayload('[{"a":1}]'), true);
        assert.strictEqual(u._subIsRawErrorPayload('Provider said {"error": "rate"} twice'), true);
    });
    test('a name containing both " and ( still produces a final and a lifecycle card', async function() {
        var chats = { root: { messages: [] } }, runs = [];
        var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
        var m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
            isChatPaused: function() { return false; }, runAgent: function(id) { runs.push(id); return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
        var safe = m._subSanitizeName('Fix "quotes" (v2)\n', 'kid');
        assert.strictEqual(safe, 'Fix quotes v2');
        var h = m.Handles.start('root', 'spawn_sub_agent', {}, 'kid', function() { return new Promise(function() {}); });
        var rec = { agent_id: 'kid', chat_id: 'c_kid', name: safe, state: 'running', spawn_handle_id: h.handleId,
            parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now(), wake_parent: true };
        m._subAgents.kid = rec;
        chats.c_kid = { isSubAgent: true, subAgentId: 'kid', messages: [] };
        m._wakeParentOnReport(rec, { status: 'done', summary: '**ok**\\nsecond line\\nthird' }, { hadAwaiters: false });
        await new Promise(function(r) { setTimeout(r, 0); });
        var row = chats.root.messages.filter(function(x) { return x.role === 'user'; }).pop();
        assert.ok(row && typeof row.content === 'string', 'producer pushed the notice row');
        var u = makeUi();
        var html = u.renderSubReportNotices(row.content, chats.root.messages);
        assert.ok(html && html.indexOf('sub-notice-final') >= 0 && html.indexOf('>Fix quotes v2<') >= 0, 'final card: ' + String(html).slice(0, 300));
        assert.ok(html.indexOf('<strong>ok</strong>') >= 0 && html.indexOf('\\n') < 0, 'normalised summary: ' + html.slice(0, 400));
        var life = u.renderSubReportNotices('[sub-agent lifecycle] ' + safe + ' (kid): STUCK waiting', []);
        assert.ok(life && life.indexOf('sub-notice-mid') >= 0 && life.indexOf('>Fix quotes v2<') >= 0, 'lifecycle card: ' + String(life).slice(0, 300));
    });
});
