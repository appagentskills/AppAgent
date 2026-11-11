// "Continue in a new chat": the context ring grows into a labeled pill past
// 50% (ui/240-layout.js updateContextIndicator) and the continued chat keeps
// the old chat id (ui/170-chat-management.js completeSummaryAndCreateNewChat),
// which survives the put strip/merge (core/130-indexeddb.js).
// Real function texts cut from source, run against fake DOM/env.
// Run: run_tests { files: ['test/continue-new-chat.test.js'] }
var EX = await runFile('test/extract.js', { i18n: false });
function cnCut(src, names) {
    var mask = EX.codeMask(src);
    return names.map(function(n) {
        var f = EX.findFunction(src, n, { mask: mask });
        if (!(f && f.end > f.start)) throw new Error('function not found: ' + n);
        return src.slice(f.start, f.end);
    }).join('\n');
}
function cnEl() {
    var cls = {};
    return {
        style: {}, title: '', attrs: {}, hidden: true, textContent: '',
        setAttribute: function(k, v) { this.attrs[k] = String(v); },
        getAttribute: function(k) { return this.attrs[k]; },
        set className(v) { cls = {}; String(v).split(/\s+/).filter(Boolean).forEach(function(c) { cls[c] = 1; }); },
        get className() { return Object.keys(cls).join(' '); },
        classList: { add: function(c) { cls[c] = 1; }, contains: function(c) { return !!cls[c]; } }
    };
}
// Handoff helpers (prompt constant + pure functions) cut from 170-chat-management.js.
function cnHandoffSrc(src) {
    var consts = ['HANDOFF_SUMMARY_PROMPT', 'HANDOFF_USER_MSG_VERBATIM_MAX', 'HANDOFF_USER_MSG_HEAD'].map(function(n) {
        var m = new RegExp('\\nvar ' + n + ' =[\\s\\S]*?;\\n').exec(src);
        if (!m) throw new Error('missing ' + n);
        return m[0];
    }).join('');
    return consts + cnCut(src, ['extractHandoffSummary', '_isTypedUserMessage', 'buildHandoffUserMessages', 'buildContinuationSeed']);
}
async function cnHandoff() {
    var src = await loadFile('src/js/ui/170-chat-management.js');
    return new Function(cnHandoffSrc(src) + '\nreturn { HANDOFF_SUMMARY_PROMPT: HANDOFF_SUMMARY_PROMPT, extractHandoffSummary: extractHandoffSummary, buildHandoffUserMessages: buildHandoffUserMessages, buildContinuationSeed: buildContinuationSeed };')();
}
async function cnIndicator(inputTokens) {
    var i18n = await loadFile('src/js/core/025-i18n.js');
    var src = await loadFile('src/js/ui/240-layout.js');
    var m = /\nvar CONTEXT_CONTINUE_THRESHOLD = \d+;/.exec(src);
    if (!m) throw new Error('CONTEXT_CONTINUE_THRESHOLD missing');
    var els = { 'context-indicator': cnEl(), 'context-fill': cnEl(), 'context-label': cnEl(), 'context-pct': cnEl(), 'context-label-short': cnEl(), 'message-input': { value: '' } };
    var env = {
        document: { getElementById: function(id) { return els[id] || null; } },
        chats: { c1: { messages: [{ role: 'assistant', content: 'x', metrics: { input_tokens: inputTokens } }] } },
        currentChatId: 'c1',
        getAssumedContextTokens: function() { return 200000; },
        composerDraftTokens: function() { return 0; }
    };
    var fn = new Function('env', 'with (env) {\n' + i18n + '\n' + m[0] + '\n' + cnCut(src, ['updateContextIndicator']) + '\nreturn updateContextIndicator;\n}')(env);
    fn();
    return els;
}

describe('continue in a new chat', function() {
    test('ring only at <= 50%, labeled pill above 50% with warning/danger kept', async function() {
        var at50 = await cnIndicator(100000); // exactly 50%
        assert.strictEqual(at50['context-indicator'].classList.contains('continue-cta'), false);
        assert.strictEqual(at50['context-label'].hidden, true);
        assert.strictEqual(at50['context-label'].textContent, '');
        assert.strictEqual(at50['context-indicator'].attrs['aria-label'], 'Summarize and start new chat');
        assert.strictEqual(at50['context-pct'].hidden, true);
        assert.strictEqual(at50['context-label-short'].hidden, true);

        var at51 = await cnIndicator(102000); // 51%
        assert.strictEqual(at51['context-indicator'].classList.contains('continue-cta'), true);
        assert.strictEqual(at51['context-label'].hidden, false);
        assert.strictEqual(at51['context-label'].textContent, 'Continue in a new chat');
        assert.strictEqual(at51['context-indicator'].attrs['aria-label'], 'Continue in a new chat');
        assert.strictEqual(at51['context-indicator'].classList.contains('warning'), false);
        assert.strictEqual(at51['context-pct'].hidden, false);
        assert.strictEqual(at51['context-pct'].textContent, '51%');
        assert.strictEqual(at51['context-label-short'].hidden, false);
        assert.strictEqual(at51['context-label-short'].textContent, 'New chat');
        assert.match(at51['context-indicator'].title, /^51% context used/);

        var at75 = await cnIndicator(150000);
        assert.ok(at75['context-indicator'].classList.contains('continue-cta') && at75['context-indicator'].classList.contains('warning'));
        var at95 = await cnIndicator(190000);
        assert.ok(at95['context-indicator'].classList.contains('continue-cta') && at95['context-indicator'].classList.contains('danger'));
    }, { tags: ['unit'] });

    test('the pill markup is the keyboard-accessible indicator wired to summarizeAndStartNewChat', async function() {
        var body = await loadFile('src/html/body.html');
        var start = body.indexOf('id="context-indicator"');
        var end = body.indexOf('</div>', start);
        assert.ok(start > 0 && end > start);
        var block = body.slice(body.lastIndexOf('<div', start), end);
        assert.match(block, /role="button"/);
        assert.match(block, /tabindex="0"/);
        assert.match(block, /onclick="summarizeAndStartNewChat\(\)"/);
        assert.match(block, /event\.key==='Enter'\|\|event\.key===' '/);
        assert.match(block, /id="context-label"/);
        assert.match(block, /id="context-pct"/);
        assert.match(block, /id="context-label-short"/);
    }, { tags: ['unit'] });

    test('pill CSS: button-like pill, no hover % overlay, one-line narrow variants', async function() {
        var css = await loadFile('src/css/06-input.css');
        var pill = (/\n\.context-indicator\.continue-cta \{([^}]*)\}/.exec(css) || [])[1] || '';
        assert.match(pill, /border-radius: var\(--radius-pill\)/, 'pill radius, not 50% ellipse');
        assert.match(pill, /border: 1px solid var\(--primary\)/);
        assert.match(pill, /height: 36px/, 'matches #attach-btn height');
        assert.match(pill, /white-space: nowrap/);
        assert.strictEqual(/opacity: 0\.8/.test(pill), false);
        assert.match(css, /\.context-indicator\.continue-cta:hover::after \{ content: none; \}/, 'hover % overlay disabled in pill mode');
        assert.match(css, /\.context-indicator\.continue-cta\.danger \{[^}]*border-color: var\(--danger\)/);
        assert.match(css, /\.context-indicator\.continue-cta\.warning \{[^}]*border-color: var\(--warning\)/);
        // Below the threshold the ring keeps its hover % overlay.
        assert.match(css, /\.context-indicator:hover::after \{ content: attr\(data-percentage\) '%'/);
        var resp = await loadFile('src/css/20-responsive.css');
        assert.strictEqual(/continue-cta[^{]*\{[^}]*-webkit-line-clamp/.test(resp), false, 'no 2-line wrap');
        assert.match(resp, /\.context-indicator\.continue-cta \.context-label-short \{ display: inline; \}/);
    }, { tags: ['unit'] });

    test('continued chat records continuedFrom and points at chat_history', async function() {
        var i18n = await loadFile('src/js/core/025-i18n.js');
        var src = await loadFile('src/js/ui/170-chat-management.js');
        function noop() {}
        var env = {
            pendingSummaryRequest: { chatId: 'OLD1', chatTitle: 'Old chat' },
            chats: { OLD1: { id: 'OLD1', messages: [
                { role: 'user', content: 'fix the BR please' },
                { role: 'assistant', content: 'done' },
                { role: 'user', content: 'Please summarize', isSummaryRequest: true },
                { role: 'assistant', content: '<analysis>SCRATCH</analysis>\n<summary>\nTHE SUMMARY\n</summary>' }
            ] } },
            currentChatId: 'OLD1', versionHistory: [], stickToBottom: false, paused: false,
            generateId: function() { return 'NEW1'; }, showSnackbar: noop,
            appStorage: { setItem: noop }, pushFocusChatToOffscreen: noop, saveChatsToStorage: noop,
            clearUpdateSet: noop, renderChatList: noop, renderMessages: noop, renderVersionSidebar: noop,
            updateChatTitleHeader: noop, renderWorkersStrip: noop, setChatPausedPersistent: noop,
            pushPauseToggleToOffscreen: noop, syncPauseButtonUI: noop,
            runAgent: function() { return Promise.resolve(); }
        };
        var fn = new Function('env', 'with (env) {\n' + i18n + '\n' + cnHandoffSrc(src) + '\n' + cnCut(src, ['completeSummaryAndCreateNewChat']) + '\nreturn completeSummaryAndCreateNewChat;\n}')(env);
        fn();
        await Promise.resolve();
        var nc = env.chats.NEW1;
        assert.ok(nc, 'continued chat created');
        assert.strictEqual(nc.continuedFrom, 'OLD1');
        assert.strictEqual(nc.messages[0].isContinuationSeed, true);
        var seed = nc.messages[0].content;
        assert.match(seed, /<summary>\nTHE SUMMARY\n<\/summary>/, 'only the <summary> inner text is seeded');
        assert.strictEqual(/SCRATCH|<analysis>/.test(seed), false, 'analysis scratchpad stripped');
        assert.match(seed, /^This chat continues a previous conversation \(chat id `OLD1`\)/);
        assert.match(seed, /use `chat_history` with chat_id `OLD1`/);
        assert.match(seed, /All user messages from chat `OLD1`[\s\S]*1\. \(messages\[0\]\)\n   fix the BR please/);
        assert.strictEqual(/Please summarize/.test(seed), false, 'summary request not carried over');
        assert.ok(seed.indexOf('</summary>') < seed.indexOf('All user messages'), 'user messages follow the summary');
    }, { tags: ['unit'] });

    test('extractHandoffSummary: strips <analysis>, extracts <summary>, falls back', async function() {
        var h = await cnHandoff();
        var x = h.extractHandoffSummary;
        assert.strictEqual(x('<analysis>think\nmore</analysis>\n<summary>\n1. Goal\n</summary>'), '1. Goal');
        assert.strictEqual(x('<ANALYSIS>a</ANALYSIS><Summary>S</Summary> trailing'), 'S', 'case-insensitive');
        assert.strictEqual(x('<analysis>mentions <summary>fake</summary></analysis><summary>REAL</summary>'), 'REAL', 'tags inside analysis ignored');
        assert.strictEqual(x('<analysis>a</analysis>\nplain summary text'), 'plain summary text', 'no summary tags: whole reply minus analysis');
        assert.strictEqual(x('just text'), 'just text');
        assert.strictEqual(x('<summary>unclosed tail'), 'unclosed tail', 'unclosed <summary> runs to the end');
        assert.strictEqual(x('<summary>  </summary>rest'), 'rest', 'empty summary falls back');
        assert.strictEqual(x('<analysis>only scratch'), '<analysis>only scratch', 'never empty for a non-empty reply');
    }, { tags: ['unit'] });

    test('buildHandoffUserMessages: verbatim, truncation pointer, exclusions, multi-part', async function() {
        var h = await cnHandoff();
        var long = 'L'.repeat(299) + 'X' + 'Y'.repeat(400); // 700 chars
        var ms = [
            { role: 'user', content: 'short one\nline two' },                          // 0 typed
            { role: 'screenshot', base64: 'x' },                                          // 1 attachment of 0
            { role: 'assistant', content: 'ok' },                                         // 2
            { role: 'user', content: 'wake notice', injected: true },                     // 3 excluded
            { role: 'user', content: 'hook prompt', isHookMessage: true },                // 4 excluded
            { role: 'context', content: 'ctx' },                                          // 5 excluded
            { role: 'user', content: long },                                              // 6 typed long
            { role: 'user', content: 'queued typed', injected: true, hasUserText: true }, // 7 typed
            { role: 'user', content: [{ type: 'text', text: 'part A' }, { type: 'image_url', image_url: { url: 'data:' } }, { type: 'text', text: 'part B' }] }, // 8
            { role: 'user', content: 'Please summarize', isSummaryRequest: true }         // 9 excluded
        ];
        var out = h.buildHandoffUserMessages(ms, 'OLD9');
        assert.match(out, /^All user messages from chat `OLD9`/);
        assert.ok(out.indexOf('1. (messages[0])\n   short one\n   line two\n   [+1 image \u2014 chat_history get {chat_id: "OLD9", path: "messages[1]"}]') >= 0, 'screenshot row pointer');
        assert.match(out, /2\. \(messages\[6\]\)\n   L{299}X\u2026\[truncated \u2014 700 chars total; full text: chat_history get \{chat_id: "OLD9", path: "messages\[6\]\.content"\}\]/);
        assert.strictEqual(/Y/.test(out), false, 'tail beyond the head is cut');
        assert.match(out, /3\. \(messages\[7\]\)\n   queued typed/);
        assert.ok(out.indexOf('4. (messages[8])\n   part A\n   part B\n   [+1 image \u2014 chat_history get {chat_id: "OLD9", path: "messages[8].content"}]') >= 0, 'inline image part pointer');
        assert.strictEqual(out.indexOf('see chat_history'), -1, 'no vague pointer left');
        ['wake notice', 'hook prompt', 'ctx', 'Please summarize'].forEach(function(s) {
            assert.strictEqual(out.indexOf(s), -1, s + ' excluded');
        });
        assert.strictEqual(/^5\./m.test(out), false, 'exactly four entries');
        var exact = 'E'.repeat(500);
        assert.ok(h.buildHandoffUserMessages([{ role: 'user', content: exact }], 'C').indexOf(exact + '') > 0 &&
            h.buildHandoffUserMessages([{ role: 'user', content: exact }], 'C').indexOf('[truncated') === -1, '500 chars stays verbatim');
        assert.strictEqual(h.buildHandoffUserMessages([{ role: 'assistant', content: 'a' }], 'C'), '', 'no user messages: empty section');
    }, { tags: ['unit'] });

    test('buildHandoffUserMessages: exact attachment index pointers (several rows, mixed kinds)', async function() {
        var h = await cnHandoff();
        var ms = [
            { role: 'user', content: [{ type: 'text', text: 'see these' }, { type: 'image_url', image_url: { url: 'data:' } }] }, // 0
            { role: 'screenshot', base64: 'x' },                       // 1
            { role: 'pdf', name: 'a.pdf' },                            // 2
            { role: 'context', content: 'doc', attachment: true },     // 3
            { role: 'assistant', content: 'ok' },                      // 4
            { role: 'user', content: 'two shots' },                    // 5
            { role: 'screenshot', base64: 'a' },                       // 6
            { role: 'screenshot', base64: 'b' },                       // 7
            { role: 'user', content: 'plain' },                        // 8
            { role: 'file', name: 'x.csv' }                            // 9
        ];
        var out = h.buildHandoffUserMessages(ms, 'OLD');
        assert.ok(out.indexOf('[+4 attachments \u2014 chat_history get {chat_id: "OLD", path: "messages[0].content"} (also messages[1], messages[2], messages[3])]') >= 0, 'mixed: own parts + rows');
        assert.ok(out.indexOf('[+2 images \u2014 chat_history get {chat_id: "OLD", path: "messages[6]"} (also messages[7])]') >= 0, 'two screenshots');
        assert.ok(out.indexOf('[+1 attachment \u2014 chat_history get {chat_id: "OLD", path: "messages[9]"}]') >= 0, 'single file row');
        assert.strictEqual((out.match(/\[\+/g) || []).length, 3, 'one note per message with attachments');
        assert.strictEqual(out.indexOf('paths:'), -1, 'only single-path chat_history calls');
    }, { tags: ['unit'] });

    test('summary prompt: text-only guard, analysis/summary tags, latest request verbatim', async function() {
        var h = await cnHandoff();
        var p = h.HANDOFF_SUMMARY_PROMPT;
        assert.match(p, /Respond with TEXT ONLY\. Do NOT call any tools/);
        assert.match(p, /<analysis> block \(it will be discarded\)/);
        assert.match(p, /output a <summary> block/);
        assert.match(p, /quote the most recent instruction\(s\) VERBATIM/);
        assert.match(p, /appends every user message/);
        assert.match(p, /`chat_history` tool/);
        assert.match(p, /ACTUAL final state \(done \/ error \/ stopped \/ still running\)/);
        assert.match(p, /Sub-agents \u2014 one line each: id\/name, tier/);
        assert.match(p, /not "stopped and handed off"/);
        assert.match(p, /What changed and why \u2014 one line per prompt, design or code change: the change, then the reason/);
        ['1. Goal & intent', '2. User instructions', '3. Environment', '4. Done & verified', '5. Artifacts & identifiers',
            '6. Errors, dead ends', '7. Open items', '8. Current state & next step'].forEach(function(s) {
            assert.ok(p.indexOf(s) >= 0, 'section kept: ' + s);
        });
        var src = await loadFile('src/js/ui/170-chat-management.js');
        assert.match(cnCut(src, ['summarizeAndStartNewChat']), /content: HANDOFF_SUMMARY_PROMPT,\s*isSummaryRequest: true/);
    }, { tags: ['unit'] });

    test('continuedFrom survives the put strip and the put merge fill-gap', async function() {
        var src = await loadFile('src/js/core/130-indexeddb.js');
        var body = 'var CHAT_META_TS_FIELDS = [], CHAT_META_FLAG_FIELDS = [];\n'
            + (/\nvar PERSISTED_CHAT_UNDERSCORE_FIELDS = \{[\s\S]*?\n\};/.exec(src) || [''])[0] + '\n'
            + cnCut(src, ['stripTransientChatFieldsForPut', '_chatRowPutHandledFields', '_sameChatMsgIdentity',
                '_mergeChatMessagesForPut', '_mergeWidgetIntentsForPut', '_unionChatDisplaysForPut', '_mergeChatRowForPut'])
            + '\nreturn { strip: stripTransientChatFieldsForPut, merge: _mergeChatRowForPut };';
        var m = new Function(body)();
        var rec = { id: 'N', messages: [], continuedFrom: 'OLD1', _ctxTokens: 5 };
        var put = m.strip(rec);
        assert.strictEqual(put.continuedFrom, 'OLD1');
        assert.strictEqual(put._ctxTokens, undefined, 'transient _ fields still stripped');
        var merged = m.merge({ id: 'N', messages: [] }, { id: 'N', messages: [], continuedFrom: 'OLD1' });
        assert.strictEqual(merged.continuedFrom, 'OLD1', 'a record lacking it keeps the stored value');
    }, { tags: ['unit'] });
});
