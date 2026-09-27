// Top-level `display` renders eagerly with its own tool_result; a placeholder in
// any assistant message moves it there instead (never both). Real module:
// src/js/tools/090-display-templates.js.
var DSP_FILE = 'src/js/tools/090-display-templates.js';
var TABLE = { template: 'table', title: 'Users', columns: ['name'], rows: [['a'], ['b']] };

async function dspLoad(messages) {
    var state = { c1: { messages: messages || [] } };
    var saves = { n: 0 };
    var m = await loadModules([DSP_FILE], { globals: { chats: state, currentChatId: 'c1', activeStreamingChatId: null,
        saveChatsToStorage: function() { saves.n++; } } });
    return { m: m, chat: state.c1, saves: saves };
}
function dspTurn(toolName, toolId, argsJson) {
    return [
        { role: 'user', content: 'show users' },
        { role: 'assistant', content: '', tool_calls: [{ id: toolId, type: 'function', function: { name: toolName, arguments: argsJson || '{}' } }] },
        { role: 'tool', tool_call_id: toolId, name: toolName, content: '[Tool call pending]', _placeholder: true }
    ];
}
function dspShown(html, id) { return html.indexOf('data-display-id="' + id + '"') !== -1; }

describe('display eager render (top-level calls)', function() {
    test('top-level call attaches to its own slot and renders without a placeholder', async function() {
        var t = await dspLoad(dspTurn('display', 'tu_1'));
        var r = t.m.executeDisplay(TABLE, 1, { chatId: 'c1', toolCallId: 'tu_1' });
        assert.strictEqual(r.success, true);
        assert.deepStrictEqual({ tc: t.chat.displays[r.id].toolCallId, idx: t.chat.displays[r.id].msgIndex, eager: t.chat.displays[r.id].eager }, { tc: 'tu_1', idx: 2, eager: true });
        assert.deepStrictEqual({ tc: r._display_persist.toolCallId, idx: r._display_persist.msgIndex, eager: r._display_persist.eager }, { tc: 'tu_1', idx: 2, eager: true });
        assert.match(r.message, /rendered inline\. Optionally include <!--display:dsp_\w+--> in your final response/);
        assert.strictEqual(r.placeholder, '<!--display:' + r.id + '-->');
        assert.strictEqual(t.saves.n, 1);
        assert.ok(dspShown(t.m.getDisplayHtmlForMessage(2), r.id), 'eager render at the tool slot');
        assert.strictEqual(t.m.getDisplayHtmlForMessage(1), '', 'never on the assistant row');
        assert.deepStrictEqual(t.m.__unstubbed, []);
    }, { tags: ['unit'], timeout: 4000 });

    test('placeholder in the final reply suppresses the eager copy (no double render)', async function() {
        var t = await dspLoad(dspTurn('display', 'tu_1'));
        var r = t.m.executeDisplay(TABLE, 1, { chatId: 'c1', toolCallId: 'tu_1' });
        assert.ok(dspShown(t.m.getDisplayHtmlForMessage(2), r.id));
        t.chat.messages[2].content = JSON.stringify(r);
        delete t.chat.messages[2]._placeholder;
        t.chat.messages.push({ role: 'assistant', content: 'Here:\n' + r.placeholder + '\nDone.' });
        assert.strictEqual(t.m.getDisplayHtmlForMessage(2), '', 'placed in text -> not eager');
        assert.ok(t.m.renderDisplayPlaceholder(r.id).indexOf('display-table') !== -1, 'placeholder path still renders it');
    }, { tags: ['unit'], timeout: 4000 });

    test('placeholder embedded via a document tool_call also suppresses the eager copy', async function() {
        var t = await dspLoad(dspTurn('display', 'tu_1'));
        var r = t.m.executeDisplay(TABLE, 1, { chatId: 'c1', toolCallId: 'tu_1' });
        assert.ok(dspShown(t.m.getDisplayHtmlForMessage(2), r.id), 'eager copy shown before the placement');
        t.chat.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'tu_2', type: 'function', function: { name: 'document',
            arguments: JSON.stringify({ action: 'create', title: 'Doc', content: '# Users\n' + r.placeholder }) } }] });
        assert.strictEqual(t.m.getDisplayHtmlForMessage(2), '');
    }, { tags: ['unit'], timeout: 4000 });

    test('slot missing from the page mirror: toolCallId persisted, renders once the slot lands', async function() {
        var t = await dspLoad([{ role: 'user', content: 'show users' }]);
        var r = t.m.executeDisplay(TABLE, 1, { chatId: 'c1', toolCallId: 'tu_9' });
        var e = t.chat.displays[r.id];
        assert.deepStrictEqual({ tc: e.toolCallId, eager: e.eager, idx: e.msgIndex }, { tc: 'tu_9', eager: undefined, idx: undefined });
        assert.strictEqual(r._display_persist.toolCallId, 'tu_9', 'SW mirror receives the slot id to resolve');
        t.chat.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'tu_9', type: 'function', function: { name: 'display', arguments: '{}' } }] });
        t.chat.messages.push({ role: 'tool', tool_call_id: 'tu_9', name: 'display', content: JSON.stringify(r) });
        assert.ok(dspShown(t.m.getDisplayHtmlForMessage(2), r.id));
    }, { tags: ['unit'], timeout: 4000 });

    test('sandbox call keeps attaching to the parent slot with no placeholder hint', async function() {
        var t = await dspLoad(dspTurn('js_eval', 'tu_js'));
        var r = t.m.executeDisplay(TABLE, 1, { chatId: 'c1', toolCallId: 'prog_tu_js_1', fromSandbox: true, parentToolCallId: 'tu_js' });
        assert.deepStrictEqual({ tc: t.chat.displays[r.id].toolCallId, idx: t.chat.displays[r.id].msgIndex, placeholder: r.placeholder, message: r.message },
            { tc: 'tu_js', idx: 2, placeholder: null, message: 'Users rendered.' });
        assert.ok(dspShown(t.m.getDisplayHtmlForMessage(2), r.id));
    }, { tags: ['unit'], timeout: 4000 });

    test('saved chats: legacy entries render at their display result unless placed', async function() {
        var msgs = dspTurn('display', 'tu_old');
        var id = 'dsp_3_1700000000000';
        msgs[2] = { role: 'tool', tool_call_id: 'tu_old', name: 'display', content: JSON.stringify({ success: true, id: id, displayId: id }) };
        var t = await dspLoad(msgs);
        t.chat.displays = {};
        t.chat.displays[id] = { template: 'table', args: TABLE };
        t.chat.displays.dsp_4_1700000000001 = { template: 'table', args: TABLE, msgIndex: 2, eager: true };
        var html = t.m.getDisplayHtmlForMessage(2);
        assert.ok(dspShown(html, id), 'legacy top-level display no longer lost');
        assert.ok(dspShown(html, 'dsp_4_1700000000001'), 'sandbox-era msgIndex entry still renders');
        t.chat.messages.push({ role: 'assistant', content: 'Table: <!--display:' + id + '-->' });
        html = t.m.getDisplayHtmlForMessage(2);
        assert.strictEqual(dspShown(html, id), false);
        assert.ok(dspShown(html, 'dsp_4_1700000000001'));
    }, { tags: ['unit'], timeout: 4000 });

    test('no real slot id (SW-minted ui_ id, sandbox without parent): old placeholder contract, renders when placed', async function() {
        var t = await dspLoad(dspTurn('display', 'tu_1'));
        [{ chatId: 'c1', toolCallId: 'ui_1790000000000_abc123def' }, { chatId: 'c1', toolCallId: 'prog_np_1', fromSandbox: true }].forEach(function(opts) {
            var r = t.m.executeDisplay(TABLE, null, opts);
            var e = t.chat.displays[r.id];
            assert.strictEqual(r.placeholder, '<!--display:' + r.id + '-->');
            assert.strictEqual(r._display_placeholder, r.placeholder);
            assert.strictEqual(r.message, 'Users ready. Include ' + r.placeholder + ' in your response to render it inline.');
            assert.deepStrictEqual({ tc: e.toolCallId, eager: e.eager, ptc: r._display_persist.toolCallId, peager: r._display_persist.eager },
                { tc: undefined, eager: undefined, ptc: undefined, peager: undefined }, 'a synthesized id is never persisted as a slot');
            assert.strictEqual(dspShown(t.m.getDisplayHtmlForMessage(2), r.id), false, 'no slot -> no eager copy');
            t.chat.messages.push({ role: 'assistant', content: 'Here: ' + r.placeholder });
            assert.ok(t.m.renderDisplayPlaceholder(r.id).indexOf('display-table') !== -1, 'still renders when placed');
        });
    }, { tags: ['unit'], timeout: 4000 });

    test('toolCallId with no slot in the chat falls back to msgIndex; resetPass re-scans in-place edits', async function() {
        var t = await dspLoad(dspTurn('js_eval', 'tu_js'));
        t.chat.displays = { dsp_7_1: { template: 'table', args: TABLE, toolCallId: 'tu_gone', msgIndex: 2, eager: true } };
        assert.ok(dspShown(t.m.getDisplayHtmlForMessage(2), 'dsp_7_1'), 'unmatched toolCallId -> msgIndex fallback, not dropped');
        t.chat.messages.push({ role: 'assistant', content: 'Done.' });
        assert.ok(dspShown(t.m.getDisplayHtmlForMessage(2), 'dsp_7_1'));
        // In-place edit of an EARLIER message: same count, same last message.
        t.chat.messages[1].content = 'See <!--display:dsp_7_1-->';
        t.m.getDisplayHtmlForMessage.resetPass();
        assert.strictEqual(dspShown(t.m.getDisplayHtmlForMessage(2), 'dsp_7_1'), false, 'placed after the in-place edit');
    }, { tags: ['unit'], timeout: 4000 });
});
