// "Continue in a new chat" phase 1: model-written title (no stacked
// "Continued: "), budgeted user messages, lineage nav button, unread skip.
// Real function texts cut from src/js/ui/170-chat-management.js and
// src/js/ui/165-finished-chat-badge.js.
// Run: run_tests { files: ['test/continue-chat-handoff.test.js'] }
var EX = await runFile('test/extract.js', { i18n: false });
function cchCut(src, names) {
    var mask = EX.codeMask(src);
    return names.map(function(n) {
        var f = EX.findFunction(src, n, { mask: mask });
        if (!(f && f.end > f.start)) throw new Error('function not found: ' + n);
        return src.slice(f.start, f.end);
    }).join('\n');
}
function cchConst(src, n) {
    var m = new RegExp('\\nvar ' + n + ' =[\\s\\S]*?;\\n').exec(src);
    if (!m) throw new Error('missing ' + n);
    return m[0];
}
async function cchLoad(env) {
    var src = await loadFile('src/js/ui/170-chat-management.js');
    var code = ['HANDOFF_USER_MSG_VERBATIM_MAX', 'HANDOFF_USER_MSG_HEAD', 'HANDOFF_USER_MSG_TOTAL_BUDGET', 'HANDOFF_TITLE_MAX'].map(function(n) { return cchConst(src, n); }).join('') +
        cchCut(src, ['extractHandoffSummary', 'stripContinuedPrefix', 'extractHandoffTitle', 'cleanHandoffTitle', '_findHandoffToolCall', 'getHandoffResult', '_getHandoffTextResult', '_isTypedUserMessage', 'buildHandoffUserMessages', 'renderLineageNavButton']);
    return new Function('env', 'with (env) {\n' + code + '\nreturn { stripContinuedPrefix: stripContinuedPrefix, extractHandoffTitle: extractHandoffTitle, extractHandoffSummary: extractHandoffSummary, getHandoffResult: getHandoffResult, buildHandoffUserMessages: buildHandoffUserMessages, renderLineageNavButton: renderLineageNavButton, TOTAL: HANDOFF_USER_MSG_TOTAL_BUDGET, MAX: HANDOFF_USER_MSG_VERBATIM_MAX, HEAD: HANDOFF_USER_MSG_HEAD };\n}')(env);
}
function cchEnv(extra) {
    var env = {
        t: function(s) { return s; },
        escapeHtml: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
        chats: {}
    };
    Object.keys(extra || {}).forEach(function(k) { env[k] = extra[k]; });
    return env;
}

describe('continue in a new chat: phase 1 handoff', function() {
    test('stripContinuedPrefix removes stacked English and localized prefixes', async function() {
        var h = await cchLoad(cchEnv({ t: function(s) { return s === 'Continued: ' ? 'Suite : ' : s; } }));
        assert.strictEqual(h.stripContinuedPrefix('Continued: Continued: Fix BR'), 'Fix BR');
        assert.strictEqual(h.stripContinuedPrefix('Suite : Continued: Suite : Fix BR'), 'Fix BR');
        assert.strictEqual(h.stripContinuedPrefix('continued: lower'), 'lower', 'case-insensitive');
        assert.strictEqual(h.stripContinuedPrefix('Plain title'), 'Plain title');
        assert.strictEqual(h.stripContinuedPrefix(null), '');
    }, { tags: ['unit'] });

    test('extractHandoffTitle: last <title>, cleaned, capped; summary never includes it', async function() {
        var h = await cchLoad(cchEnv());
        var reply = '<analysis><title>scratch</title></analysis><summary>S1</summary>\n<title> "Continued: Fix  approval BR" </title>';
        assert.strictEqual(h.extractHandoffTitle(reply), 'Fix approval BR');
        assert.strictEqual(h.extractHandoffTitle('<summary>x</summary>'), '', 'no title -> empty');
        assert.strictEqual(h.extractHandoffTitle('<title>' + 'A'.repeat(90) + '</title>').length, 60);
        assert.strictEqual(h.extractHandoffSummary(reply), 'S1');
        assert.strictEqual(h.extractHandoffSummary('no tags <title>T</title>'), 'no tags');
        var r = h.getHandoffResult({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: reply }] });
        assert.strictEqual(r.title, 'Fix approval BR');
        assert.strictEqual(r.summary, 'S1');
        assert.strictEqual(r.replyMsg.content, reply);
        assert.strictEqual(h.getHandoffResult({ messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'q' }] }), null);
    }, { tags: ['unit'] });

    test('buildHandoffUserMessages: newest-first budget, chronological output', async function() {
        var h = await cchLoad(cchEnv());
        assert.strictEqual(h.MAX, 4000); assert.strictEqual(h.HEAD, 3000); assert.strictEqual(h.TOTAL, 24000);
        var ms = [
            { role: 'user', content: 'A'.repeat(100) },  // 0: oldest -> pointer only
            { role: 'user', content: 'B'.repeat(500) },  // 1: head + pointer
            { role: 'user', content: 'C'.repeat(300) },  // 2: verbatim
            { role: 'user', content: 'D'.repeat(200) }   // 3: newest, verbatim
        ];
        var out = h.buildHandoffUserMessages(ms, 'OLD', { budget: 590, head: 50 });
        assert.ok(out.indexOf('D'.repeat(200)) > 0 && out.indexOf('C'.repeat(300)) > 0, 'newest verbatim');
        assert.match(out, /2\. \(messages\[1\]\)\n   B{50}\u2026\[truncated \u2014 500 chars total; full text: chat_history get \{chat_id: "OLD", path: "messages\[1\]\.content"\}\]/);
        assert.match(out, /1\. \(messages\[0\]\)\n   \[omitted to save space \u2014 100 chars; full text: chat_history get \{chat_id: "OLD", path: "messages\[0\]\.content"\}\]/);
        assert.ok(out.indexOf('messages[0]') < out.indexOf('messages[1]') && out.indexOf('messages[2]') < out.indexOf('messages[3]'), 'chronological');
        var big = h.buildHandoffUserMessages([{ role: 'user', content: 'x'.repeat(3900) }, { role: 'user', content: 'y'.repeat(4100) }], 'O');
        assert.ok(big.indexOf('x'.repeat(3900)) > 0, '<= 4000 verbatim');
        assert.match(big, /y{3000}\u2026\[truncated \u2014 4100 chars total/);
    }, { tags: ['unit'] });

    test('renderLineageNavButton: both directions, reuses the parent-button chrome', async function() {
        var env = cchEnv();
        env.chats = { A: { title: 'Old' }, B: { title: 'Mid', continuedFrom: 'A', continuedTo: 'C' }, C: { title: 'New <x>' } };
        var h = await cchLoad(env);
        var html = h.renderLineageNavButton(env.chats.B);
        assert.match(html, /class="version-action-btn sub-self-parent-link chat-lineage-nav-btn" data-open-parent-chat-id="C" title="New &lt;x&gt;"/);
        assert.match(html, /data-open-parent-chat-id="A"[\s\S]*Go to previous chat/);
        assert.ok(html.indexOf('Go to new chat') < html.indexOf('Go to previous chat'));
        assert.strictEqual(h.renderLineageNavButton({ title: 'x' }), '');
        assert.strictEqual(h.renderLineageNavButton({ continuedTo: 'GONE' }), '', 'missing target -> no button');
    }, { tags: ['unit'] });

    test('noteChatFinishedUnseen skips a handed-off chat', async function() {
        var src = await loadFile('src/js/ui/165-finished-chat-badge.js');
        var calls = 0;
        var now = Date.now();
        var env = { chats: { OLD: { continuedTo: 'NEW' }, JUST: { continuedTo: 'NEW', continuedAt: now - 1000 }, LATER: { continuedTo: 'NEW', continuedAt: now - 600000 }, X: {} },
            currentChatId: 'NEW', currentView: 'chat', _unseenFinishedChats: {}, renderFinishedChatsBadge: function() { calls++; } };
        var fn = new Function('env', 'with (env) {\n' + cchConst(src, 'CONTINUED_HANDOFF_GRACE_MS') + cchCut(src, ['isContinuedHandoffActivity', 'noteChatFinishedUnseen']) + '\nreturn noteChatFinishedUnseen;\n}')(env);
        fn('OLD'); fn('JUST'); fn('LATER'); fn('X');
        assert.strictEqual(!!env._unseenFinishedChats.OLD, false, 'legacy link (no continuedAt) suppressed');
        assert.strictEqual(!!env._unseenFinishedChats.JUST, false, 'handoff-summary finish suppressed');
        assert.strictEqual(!!env._unseenFinishedChats.LATER, true, 'later run in the old chat rings');
        assert.strictEqual(!!env._unseenFinishedChats.X, true);
        assert.strictEqual(calls, 2);
    }, { tags: ['unit'] });

    test('completion switches via selectChat and clears the old chat unread state', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var body = cchCut(src, ['completeSummaryAndCreateNewChat']);
        assert.match(body, /selectChat\(newChatId\)/);
        assert.match(body, /dispatchChatMeta\(oldChatId, \{ lastViewedAt: Date\.now\(\) \}\)/);
        assert.match(body, /clearUnseenFinishedChat\(oldChatId\)/);
        assert.strictEqual(/t\('Continued: '\) \+/.test(body), false, 'no code-applied prefix');
        assert.match(body, /var _onOldChat = currentChatId === oldChatId;/);
        assert.match(body, /var _stillHere = _onOldChat && \(typeof currentView === 'undefined' \|\| currentView === 'chat'\);/);
    }, { tags: ['unit'] });

    test('off the chat view (home/settings): no selectChat, lastChatId retargeted', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var body = cchCut(src, ['completeSummaryAndCreateNewChat']);
        var m = /\} else if \(_onOldChat\) \{([\s\S]*?)\n    \}\n    if \(!_stillHere\) \{\s*\/\/[^\n]*\n\s*renderChatList\(\);\n    \}/.exec(body);
        assert.ok(m, '_onOldChat retarget branch + list-only repaint off the chat view');
        assert.strictEqual(/selectChat\(/.test(m[1]), false, 'never calls selectChat');
        assert.match(m[1], /currentChatId = newChatId;\s*appStorage\.setItem\('lastChatId', currentChatId\)/);
        assert.match(body, /if \(_onOldChat\) paused = false;/);
        // The selectChat branch is gated on _stillHere (which requires the chat view).
        assert.match(body, /if \(_stillHere && typeof selectChat === 'function'\) \{\s*selectChat\(newChatId\)/);
        // Run the gate expression for each view.
        var gate = new Function('currentChatId', 'oldChatId', 'currentView', 'var _onOldChat = currentChatId === oldChatId; return _onOldChat && (typeof currentView === "undefined" || currentView === "chat");');
        assert.strictEqual(gate('A', 'A', 'chat'), true);
        assert.strictEqual(gate('A', 'A', 'home'), false);
        assert.strictEqual(gate('A', 'A', 'settings-page'), false);
        assert.strictEqual(gate('B', 'A', 'chat'), false);
    }, { tags: ['unit'] });

    test('unread predicates skip only the handoff activity of a continued chat', async function() {
        var src = await loadFile('src/js/tools/120-actions.js');
        var badge = await loadFile('src/js/ui/165-finished-chat-badge.js');
        var now = Date.now();
        var env = {
            UNSEEN_CHAT_MAX_AGE_MS: 24 * 3600 * 1000,
            chats: {
                OLD: { continuedTo: 'NEW', lastResponseAt: now, lastViewedAt: now - 1000 },             // legacy: no stamp
                GRACE: { continuedTo: 'NEW', continuedAt: now - 5000, lastResponseAt: now, lastViewedAt: now - 6000 }, // summary run's late finish
                LATER: { continuedTo: 'NEW', continuedAt: now - 120000, lastResponseAt: now, lastViewedAt: now - 60000 }, // "Send here anyway"
                LATERACT: { continuedTo: 'NEW', continuedAt: now - 120000, lastActivityAt: now, lastViewedAt: now - 60000 },
                UNLINKED: { continuedTo: null, continuedAt: now - 1000, lastResponseAt: now, lastViewedAt: now - 2000 },
                X: { lastResponseAt: now, lastViewedAt: now - 1000 }
            },
            isChatBusy: function() { return false; },
            _isChatViewFocused: function() { return false; },
            chatHasPendingApproval: function() { return false; },
            chatHasPendingPrompt: function() { return false; },
            getChatProgressStateFor: function() { return null; },
            isChatActivelyRunning: function() { return false; },
            _isChatInSilentHook: function() { return false; },
            chatHasRunningSubAgents: function() { return false; },
            isChatPaused: function() { return false; },
            _isChatUserPaused: function() { return false; },
            _isChatErrored: function() { return false; }
        };
        var code = cchConst(badge, 'CONTINUED_HANDOFF_GRACE_MS') + cchCut(badge, ['isContinuedHandoffActivity']) + '\n' +
            cchCut(src, ['_isContinuedHandoffTs', '_isChatUnseen', '_chatHasUnseenActivity', '_jobsChatState']);
        var h = new Function('env', 'with (env) {\n' + code + '\nreturn { u: _isChatUnseen, a: _chatHasUnseenActivity, s: _jobsChatState, g: isContinuedHandoffActivity };\n}')(env);
        assert.strictEqual(h.u('X'), true); assert.strictEqual(h.a('X'), true); assert.strictEqual(h.s('X'), 'unseen');
        ['OLD', 'GRACE'].forEach(function(id) {
            assert.strictEqual(h.u(id), false, id + ' unseen suppressed');
            assert.strictEqual(h.a(id), false, id + ' activity suppressed');
            assert.strictEqual(h.s(id), 'done', id + ' state done');
        });
        ['LATER', 'LATERACT', 'UNLINKED'].forEach(function(id) {
            assert.strictEqual(h.u(id), true, id + ' later activity is unseen');
            assert.strictEqual(h.a(id), true, id + ' later activity is unread');
            assert.strictEqual(h.s(id), 'unseen', id + ' state unseen');
        });
        var c = env.chats.LATER;
        assert.strictEqual(h.g(c, c.continuedAt), true, 'at the handoff');
        assert.strictEqual(h.g(c, c.continuedAt + 30000), true, 'within grace');
        assert.strictEqual(h.g(c, c.continuedAt + 30001), false, 'after grace');
        assert.strictEqual(h.g(env.chats.X, now), false, 'never continued');
        // The inline dropdown-row check (_cUnseen) carries the same guard.
        assert.match(src, /var _cUnseen = !_cRunning && !_cErr && !_cPaused && c\.lastResponseAt && !_isContinuedHandoffTs\(c, c\.lastResponseAt\) &&/);
        assert.strictEqual((src.match(/c\.continuedTo\b/g) || []).length, 1, 'only _isContinuedHandoffTs reads continuedTo (no blanket suppression left)');
    }, { tags: ['unit'] });

    function cchLoad070(chats) {
        var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
        return loadModules(['src/js/core/070-permissions.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: chats
        } });
    }

    test('registerLineageLink stamp writes continuedAt with a NEW link only', async function() {
        var chats = { A: {}, B: {}, L: { continuedTo: 'M' }, M: { continuedFrom: 'L' }, D: { _deleted: true }, E: {} };
        var m = await cchLoad070(chats);
        var t0 = Date.now();
        assert.strictEqual(m.registerLineageLink('A', 'B', { stamp: true }), true);
        assert.ok(chats.A.continuedAt >= t0 && chats.A.continuedAt <= Date.now(), 'new link stamps the handoff time');
        var at = chats.A.continuedAt;
        chats.A.continuedAt = at - 5000;
        assert.strictEqual(m.registerLineageLink('A', 'B', { stamp: true }), true);
        assert.strictEqual(chats.A.continuedAt, at - 5000, 'idempotent re-register never moves the stamp');
        assert.strictEqual(m.registerLineageLink('L', 'M', { stamp: true }), true);
        assert.strictEqual(chats.L.continuedAt, undefined, 'legacy link stays legacy');
        assert.strictEqual(m.registerLineageLink('D', 'E', { stamp: true }), true);
        assert.strictEqual(chats.D.continuedAt, undefined, 'tombstone untouched');
        assert.strictEqual(m.registerLineageLink('E', 'B'), false, 'fork refused');
        assert.strictEqual(chats.E.continuedAt, undefined);
        var chats2 = { P: {}, Q: {} };
        var m2 = await cchLoad070(chats2);
        m2.registerLineageLink('P', 'Q');
        assert.strictEqual(chats2.P.continuedAt, undefined, 'no stamp without opts.stamp');
    }, { tags: ['unit'] });

    test('SW-side stamp survives a dropped page push + snapshot adopt (bell surfaces later activity)', async function() {
        // SW realm: its own chats map; the page update-chat skeleton push is
        // dropped (old chat still running), so only the SW writers apply.
        var swChats = { OLD: { id: 'OLD', messages: [] }, NEW: { id: 'NEW', messages: [] } };
        var sw = await cchLoad070(swChats);
        var portSrc = await loadFile('src/js/worker/130-port-bridge.js');
        var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
        var migrate = new Function('env', 'with (env) {' + cchCut(portSrc, ['_swContinueChatLineage']) + '\nreturn _swContinueChatLineage; }')({
            chats: swChats, registerLineageLink: sw.registerLineageLink, console: quiet,
            SubAgents: { reparentChat: function() { return {}; }, getByChatId: function() { return null; } },
            _swCopyLineageGrants: function() { return 0; }
        });
        var t0 = Date.now();
        var r = await migrate('OLD', 'NEW');
        assert.strictEqual(r.linked, true);
        assert.strictEqual(swChats.OLD.continuedTo, 'NEW');
        assert.ok(swChats.OLD.continuedAt >= t0, 'SW skeleton carries continuedAt itself');
        // The 'registerLineageLink' port message uses the same stamping writer.
        var c = cchCut(portSrc, ['_swContinueChatLineage']); // the stamping link step
        assert.match(portSrc, /case 'registerLineageLink':[\s\S]{0,600}registerLineageLink\(msg\.from, msg\.to, \{ stamp: true \}\)/);
        assert.ok(c.indexOf('registerLineageLink(from, to, { stamp: true })') > 0);

        // Page realm: the SW snapshot replaces the page copy via adoptChatRow
        // -> _mergePageChatMeta: the SW row carries continuedAt itself.
        var pageSrc = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        var merge = new Function('env', 'with (env) {' + cchCut(pageSrc, ['_mergePageChatMeta']) + '\nreturn _mergePageChatMeta; }')({
            _unionChatDisplaysForPut: function() { return null; }
        });
        var snap = JSON.parse(JSON.stringify(swChats.OLD));
        merge({ id: 'OLD', continuedTo: 'NEW' }, snap);
        assert.strictEqual(snap.continuedAt, swChats.OLD.continuedAt, 'SW stamp adopted');
        // A snapshot generated before the SW stamped (same link, no stamp)
        // keeps the page's stamp instead of degrading to legacy.
        var early = { id: 'OLD', continuedTo: 'NEW' };
        merge({ id: 'OLD', continuedTo: 'NEW', continuedAt: 1234 }, early);
        assert.strictEqual(early.continuedAt, 1234, 'page stamp preserved');
        var other = { id: 'OLD', continuedTo: 'OTHER' };
        merge({ id: 'OLD', continuedTo: 'NEW', continuedAt: 1234 }, other);
        assert.strictEqual(other.continuedAt, undefined, 'different link: stamp not carried');
        var unlinked = { id: 'OLD' };
        merge({ id: 'OLD', continuedTo: 'NEW', continuedAt: 1234 }, unlinked);
        assert.strictEqual(unlinked.continuedAt, undefined, 'unlinked snapshot: not carried');

        // ui/165: the adopted row is not legacy -> later activity rings.
        var badgeSrc = await loadFile('src/js/ui/165-finished-chat-badge.js');
        var g = new Function('env', 'with (env) {\n' + cchConst(badgeSrc, 'CONTINUED_HANDOFF_GRACE_MS') + cchCut(badgeSrc, ['isContinuedHandoffActivity']) + '\nreturn isContinuedHandoffActivity;\n}')({});
        assert.strictEqual(g(snap, snap.continuedAt + 1000), true, 'summary finish suppressed');
        assert.strictEqual(g(snap, snap.continuedAt + 120000), false, 'later run surfaces');
    }, { tags: ['unit'] });

    test('completion no longer hand-writes continuedAt (the lineage writer stamps it)', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var body = cchCut(src, ['completeSummaryAndCreateNewChat']);
        assert.strictEqual(body.indexOf('continuedAt = '), -1);
        assert.ok(body.indexOf('registerLineageLink(oldChatId, newChatId, { stamp: true') > 0);
    }, { tags: ['unit'] });

    test('continue_in_new_chat: title + summary come from the LAST tool call; text tags are the fallback', async function() {
        var h = await cchLoad(cchEnv());
        function call(id, a) { return { id: id, type: 'function', function: { name: 'continue_in_new_chat', arguments: typeof a === 'string' ? a : JSON.stringify(a) } }; }
        var req = { role: 'user', content: 'HANDOFF', isSummaryRequest: true };
        var ms = [{ role: 'user', content: 'go' }, req,
            { role: 'assistant', content: '<analysis>x</analysis>', tool_calls: [call('a', { title: 'Old try', summary: 'S1' })] },
            { role: 'tool', tool_call_id: 'a', content: '{}' },
            { role: 'assistant', content: '', tool_calls: [call('b', { title: '  "Continued: Fix   approval BR" ', summary: '## Goal\nS2' })] },
            { role: 'tool', tool_call_id: 'b', content: '{}' },
            { role: 'assistant', content: 'Handoff recorded.' }];
        var r = h.getHandoffResult({ messages: ms });
        assert.strictEqual(r.via, 'tool');
        assert.strictEqual(r.title, 'Fix approval BR', 'cleaned: quotes, whitespace, Continued: prefix');
        assert.strictEqual(r.summary, '## Goal\nS2', 'summary from the last call');
        assert.strictEqual(r.replyMsg, ms[4]);
        var long = h.getHandoffResult({ messages: [req, { role: 'assistant', content: '', tool_calls: [call('c', { title: 'x'.repeat(90), summary: 'S' })] }] });
        assert.strictEqual(long.title.length, 60, 'title capped at 60');
        // Invalid call (unparseable / empty summary) → text-tag fallback.
        var fb = h.getHandoffResult({ messages: [req, { role: 'assistant', content: '', tool_calls: [call('d', '{not json')] },
            { role: 'assistant', content: '<summary>Text S</summary><chat_title>Text T</chat_title>' }] });
        assert.strictEqual(fb.via, 'text');
        assert.strictEqual(fb.summary, 'Text S');
        assert.strictEqual(fb.title, 'Text T');
        var noTitle = h.getHandoffResult({ messages: [req, { role: 'assistant', content: '<summary>Only S</summary>' }] });
        assert.strictEqual(noTitle.title, '', 'no title → caller falls back to the old title');
        // A call before the handoff request never counts.
        var stale = h.getHandoffResult({ messages: [{ role: 'assistant', content: '', tool_calls: [call('e', { title: 'T', summary: 'S' })] }, req,
            { role: 'assistant', content: '<summary>New</summary>' }] });
        assert.strictEqual(stale.via, 'text');
    }, { tags: ['unit'] });

    test('continue_in_new_chat executor: refused outside a handoff, validates args, registered as core/headless/auto-allowed', async function() {
        var src020 = await loadFile('src/js/tools/020-tool-execution.js');
        var code = cchConst(src020, 'CONTINUE_IN_NEW_CHAT_OUTSIDE_ERROR') + cchCut(src020, ['_isHandoffTurnChat', 'executeContinueInNewChat']);
        var chats = {};
        var ex = new Function('chats', code + '\nreturn executeContinueInNewChat;')(chats);
        chats.n = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] };
        var r = ex({ title: 'T', summary: 'S' }, { chatId: 'n' });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error, 'continue_in_new_chat can only be called during a "Continue in a new chat" handoff');
        assert.strictEqual(ex({ title: 'T', summary: 'S' }, {}).success, false, 'no chatId');
        chats.h = { messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'HANDOFF', isSummaryRequest: true },
            { role: 'user', content: 'hook', isHookMessage: true }] };
        assert.strictEqual(ex({ title: 'T', summary: 'S' }, { chatId: 'h' }).success, true);
        assert.strictEqual(ex({ title: ' ', summary: 'S' }, { chatId: 'h' }).success, false, 'empty title');
        assert.strictEqual(ex({ title: 'T' }, { chatId: 'h' }).success, false, 'missing summary');
        chats.h.messages.push({ role: 'user', content: 'send here anyway' });
        assert.strictEqual(ex({ title: 'T', summary: 'S' }, { chatId: 'h' }).success, false, 'a later user row ends the handoff turn');
        assert.ok(/name === 'continue_in_new_chat'[\s\S]{0,80}executeContinueInNewChat\(args, options\)/.test(src020), 'dispatched');
        var src080 = await loadFile('src/js/core/080-tools.js');
        assert.ok(/name: 'continue_in_new_chat'/.test(src080));
        assert.ok(/CORE_TOOL_NAMES = \{[\s\S]*?continue_in_new_chat: true[\s\S]*?\};/.test(src080), 'core tool');
        assert.ok(/HEADLESS_TOOLS = \{[\s\S]*?continue_in_new_chat: true/.test(src080), 'headless');
        assert.ok((await loadFile('src/js/core/070-permissions.js')).indexOf("'continue_in_new_chat'") > 0, 'auto-allowed (GLOBAL_READ_KEYS)');
        assert.ok((await loadFile('src/js/core/078-tool-profiles.js')).indexOf("'continue_in_new_chat'") > 0, 'orchestrator profile');
    }, { tags: ['unit'] });

    test('handoff turn survives rows injected mid-run (worker reports, wake notices, queued user text)', async function() {
        var h = await cchLoad(cchEnv());
        var req = { role: 'user', content: 'HANDOFF', isSummaryRequest: true };
        var inj = { role: 'user', content: '[worker report]', injected: true, midRun: true };
        var call = { id: 'h1', type: 'function', function: { name: 'continue_in_new_chat', arguments: JSON.stringify({ title: 'Next', summary: 'S' }) } };
        // [req, assistant(tool_call), tool, injected, assistant] → the call is still found.
        var ms = [{ role: 'user', content: 'go' }, req, { role: 'assistant', content: '', tool_calls: [call] },
            { role: 'tool', tool_call_id: 'h1', content: '{"success":true}' }, inj,
            { role: 'assistant', content: 'Handoff recorded.' }];
        var r = h.getHandoffResult({ messages: ms });
        assert.ok(r, 'result found past the injected row');
        assert.strictEqual(r.via, 'tool');
        assert.strictEqual(r.title, 'Next');
        assert.strictEqual(r.summary, 'S');
        assert.strictEqual(r.replyMsg, ms[2]);
        // Text fallback also looks past an injected row ([req, injected-with-text, assistant]).
        var typed = { role: 'user', content: 'typed mid-run', injected: true, midRun: true, hasUserText: true };
        var t = h.getHandoffResult({ messages: [req, { role: 'assistant', content: '<summary>TS</summary>' }, typed] });
        assert.ok(t, 'text reply before a trailing injected row is still found');
        assert.strictEqual(t.via, 'text');
        assert.strictEqual(t.summary, 'TS');
        // A real (non-injected) later user row still ends the turn.
        assert.strictEqual(h.getHandoffResult({ messages: [req, { role: 'assistant', content: '', tool_calls: [call] },
            { role: 'user', content: 'send here anyway' }] }), null);

        var src020 = await loadFile('src/js/tools/020-tool-execution.js');
        var code = cchConst(src020, 'CONTINUE_IN_NEW_CHAT_OUTSIDE_ERROR') + cchCut(src020, ['_isHandoffTurnChat', 'executeContinueInNewChat']);
        var chats = {};
        var ex = new Function('chats', code + '\nreturn executeContinueInNewChat;')(chats);
        // [req, injected] → still the handoff turn: the call is accepted.
        chats.i = { messages: [{ role: 'user', content: 'hi' }, req, inj] };
        assert.strictEqual(ex({ title: 'T', summary: 'S' }, { chatId: 'i' }).success, true, 'injected row does not end the handoff turn');
        chats.i.messages.push({ role: 'user', content: 'typed mid-run', injected: true, midRun: true, hasUserText: true });
        assert.strictEqual(ex({ title: 'T', summary: 'S' }, { chatId: 'i' }).success, true, 'queued user text flushed mid-run neither');
        // An injected row with no handoff request behind it is still refused.
        chats.n = { messages: [{ role: 'user', content: 'hi' }, inj] };
        assert.strictEqual(ex({ title: 'T', summary: 'S' }, { chatId: 'n' }).success, false);
    }, { tags: ['unit'] });

    test('an idle-path injected row (no midRun: a wake notice that starts a new run) ENDS the handoff turn', async function() {
        var h = await cchLoad(cchEnv());
        var req = { role: 'user', content: 'HANDOFF', isSummaryRequest: true };
        var wake = { role: 'user', content: '[sub-agent report]', injected: true };
        var call = { id: 'h1', type: 'function', function: { name: 'continue_in_new_chat', arguments: JSON.stringify({ title: 'Next', summary: 'S' }) } };
        // Failed/abandoned handoff, then an idle wake run: [req, call, tool, wake, assistant(call)].
        var ms = [req, { role: 'assistant', content: '', tool_calls: [call] },
            { role: 'tool', tool_call_id: 'h1', content: '{"success":false}' }, wake,
            { role: 'assistant', content: '', tool_calls: [{ id: 'h2', type: 'function', function: { name: 'continue_in_new_chat', arguments: JSON.stringify({ title: 'Late', summary: 'L' }) } }] }];
        // _findHandoffToolCall stops at the wake row: the earlier call is not the wake run's.
        var r = h.getHandoffResult({ messages: [req, { role: 'assistant', content: '', tool_calls: [call] }, wake] });
        assert.strictEqual(r, null, 'calls before an idle-path wake row are not found');
        var r2 = h.getHandoffResult({ messages: [req, { role: 'assistant', content: '<summary>OLD</summary>' }, wake] });
        assert.strictEqual(r2, null, 'text fallback also stops at the wake row');
        assert.strictEqual(h.getHandoffResult({ messages: ms }).title, 'Late', 'only the wake run\'s own rows are scanned');

        var src020 = await loadFile('src/js/tools/020-tool-execution.js');
        var code = cchConst(src020, 'CONTINUE_IN_NEW_CHAT_OUTSIDE_ERROR') + cchCut(src020, ['_isHandoffTurnChat', 'executeContinueInNewChat']);
        var chats = {};
        var ex = new Function('chats', code + '\nreturn executeContinueInNewChat;')(chats);
        chats.w = { messages: [{ role: 'user', content: 'hi' }, req, { role: 'assistant', content: 'abandoned' }, wake] };
        var res = ex({ title: 'T', summary: 'S' }, { chatId: 'w' });
        assert.strictEqual(res.success, false, 'continue_in_new_chat refused in a later wake run');
        assert.match(String(res.error), /can only be called during/);
        // Same wake row flushed mid-run (midRun) keeps the call accepted.
        chats.m = { messages: [{ role: 'user', content: 'hi' }, req, { role: 'user', content: '[sub-agent report]', injected: true, midRun: true }] };
        assert.strictEqual(ex({ title: 'T', summary: 'S' }, { chatId: 'm' }).success, true);
    }, { tags: ['unit'] });

    test('ui/165 isContinuedHandoffActivity: mid-run flush stays the handoff\'s, idle-path wake notice is new activity', async function() {
        var badgeSrc = await loadFile('src/js/ui/165-finished-chat-badge.js');
        var g = new Function('env', 'with (env) {\n' + cchConst(badgeSrc, 'CONTINUED_HANDOFF_GRACE_MS') + cchCut(badgeSrc, ['isContinuedHandoffActivity']) + '\nreturn isContinuedHandoffActivity;\n}')({});
        var req = { role: 'user', content: 'HANDOFF', isSummaryRequest: true };
        var base = function(tail) { return { continuedTo: 'NEW', continuedAt: 1000, messages: [{ role: 'user', content: 'go' }, req, { role: 'assistant', content: 'done' }].concat(tail) }; };
        assert.strictEqual(g(base([]), 999999), true, 'summary run activity is the handoff\'s');
        assert.strictEqual(g(base([{ role: 'user', content: '[report]', injected: true, midRun: true }, { role: 'assistant', content: 'x' }]), 999999), true,
            'a row flushed into the summary run does not cause a false unread');
        assert.strictEqual(g(base([{ role: 'user', content: '[wake]', injected: true }, { role: 'assistant', content: 'x' }]), 999999), false,
            'an idle-path wake notice starts new (unread) activity');
        assert.strictEqual(g(base([{ role: 'user', content: 'send here anyway' }]), 999999), false, 'organic row still ends it');
    }, { tags: ['unit'] });

    test('handoff title uses <chat_title>; HTML <title> inside the summary is content', async function() {
        var h = await cchLoad(cchEnv());
        var src = await loadFile('src/js/ui/170-chat-management.js');
        assert.match(src, /call `continue_in_new_chat` exactly once/);
        assert.ok(!/Respond with TEXT ONLY/.test(src), 'no text-only rule');
        var html = '<summary>Widget:\n<html><head><title>My Page</title></head></html>\nDone.</summary>';
        assert.strictEqual(h.extractHandoffTitle(html), '', 'HTML title in summary never becomes the chat title');
        assert.ok(h.extractHandoffSummary(html).indexOf('<title>My Page</title>') >= 0, 'HTML title kept in summary');
        var reply = '<analysis>x</analysis>' + html + '\n<chat_title>Build widget page</chat_title>';
        assert.strictEqual(h.extractHandoffTitle(reply), 'Build widget page');
        var s = h.extractHandoffSummary(reply);
        assert.ok(s.indexOf('<title>My Page</title>') >= 0 && s.indexOf('chat_title') === -1 && s.indexOf('Build widget page') === -1);
        // Legacy trailing <title> after a summary that contains HTML <title>.
        var legacy = html + '\n<title>Legacy T</title>';
        assert.strictEqual(h.extractHandoffTitle(legacy), 'Legacy T');
        assert.ok(h.extractHandoffSummary(legacy).indexOf('<title>My Page</title>') >= 0);
        // Unclosed summary: a <title> in it is not taken.
        assert.strictEqual(h.extractHandoffTitle('<summary>x <title>In</title> y'), '');
        // No-tags fallback: <chat_title> stripped from the seeded text.
        assert.strictEqual(h.extractHandoffSummary('plain <chat_title>T</chat_title>'), 'plain');
    }, { tags: ['unit'] });

    test('REG391-2 follow-up drain: an {idle:true} flush leaves no midRun, so the wake run ends the failed handoff turn', async function() {
        var _q = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };
        var req = { role: 'user', content: 'HANDOFF', isSummaryRequest: true };
        var chat = { id: 'c1', messages: [{ role: 'user', content: 'hi' }, req, { role: 'assistant', content: 'abandoned' }] };
        var pend = { c1: { text: '[sub-agent report]', images: [] } };
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: _q, chats: { c1: chat },
            pendingInjectionsByChatId: pend, activeStreamingChatId: null, pendingInjection: null, pendingInjectionImages: null,
            clearDeliveredPendingWakes: function() {}, newFileId: function() { return 'f1'; }, registerFile: function() {}
        }});
        assert.strictEqual(m.flushPendingInjection(chat, { idle: true }), true, 'parked entry flushed');
        assert.ok(!pend.c1, 'entry consumed');
        var rows = chat.messages.filter(function(r) { return r.injected; });
        assert.strictEqual(rows.length, 1);
        assert.ok(rows.every(function(r) { return !('midRun' in r); }), 'idle flush stamps no midRun');
        // Default (mid-run) flush still stamps midRun.
        var chat2 = { id: 'c2', messages: [{ role: 'user', content: 'q' }] };
        pend.c2 = { text: 'mid', images: [] };
        m.flushPendingInjection(chat2);
        assert.strictEqual(chat2.messages[1].midRun, true, 'mid-run flush keeps midRun');

        var src020 = await loadFile('src/js/tools/020-tool-execution.js');
        var code = cchConst(src020, 'CONTINUE_IN_NEW_CHAT_OUTSIDE_ERROR') + cchCut(src020, ['_isHandoffTurnChat', 'executeContinueInNewChat']);
        var chats = { c1: chat };
        var api = new Function('chats', code + '\nreturn { turn: _isHandoffTurnChat, ex: executeContinueInNewChat };')(chats);
        assert.strictEqual(api.turn(chat), false, 'wake run is not the handoff turn');
        var res = api.ex({ title: 'T', summary: 'S' }, { chatId: 'c1' });
        assert.strictEqual(res.success, false, 'continue_in_new_chat refused in the follow-up wake run');
        assert.match(String(res.error), /can only be called during/);

        // The drain actually uses the idle flush before scheduling the follow-up run.
        var src030 = await loadFile('src/js/app/030-agent-loop.js');
        assert.ok(/flushPendingInjection\(chat, \{ idle: true \}\)\) \{\s*saveChatsToStorage\(\);[\s\S]{0,300}_followUpScheduled = true;/.test(src030),
            'REG391-2 drain flushes idle, then saves (durability), before scheduling the follow-up');
    }, { tags: ['unit'] });
});
