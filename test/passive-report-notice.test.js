// PASSIVE-NOTICE: a sub spawned with wake_parent:false used to report into
// the void when the parent never awaited it — _wakeParentOnReport returned
// early, so the parent chat got no row and no run. Now a passive UI-only
// row is appended (no run, model context unchanged), skipped only while the
// parent is blocked in await_* on that handle; wake_sub_agent can override
// wake_parent. Runs against the REAL registry (core/097-sub-agent-registry.js).
describe('passive report notice when wake_parent is false', function() {
    var m, chats, runs, pend, running;
    var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
    beforeEach(async function() {
        chats = { root: { messages: [] } }; runs = []; pend = {}; running = {};
        m = await loadModules(['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: running, pendingInjectionsByChatId: pend,
            isChatPaused: function() { return false; },
            runAgent: function(id) { runs.push(id); return Promise.resolve(); },
            saveChatsToStorage: function() { return Promise.resolve(); },
            openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function kid(extra) {
        var h = m.Handles.start('root', 'spawn_sub_agent', {}, 'kid', function() { return new Promise(function() {}); });
        var r = Object.assign({ agent_id: 'kid', chat_id: 'c_kid', name: 'Kid', state: 'running', spawn_handle_id: h.handleId,
            parent_chat_id: 'root', root_chat_id: 'root', created_at: Date.now(), wake_parent: false }, extra || {});
        m._subAgents.kid = r;
        chats.c_kid = { isSubAgent: true, subAgentId: 'kid', messages: [] };
        return { rec: r, h: h };
    }
    function passiveRows() { return chats.root.messages.filter(function(x) { return x.role === 'sub_msg' && x.kind === 'passive_report'; }); }

    test('idle parent: passive row appended, no run started, nothing model-visible', async function() {
        var k = kid();
        var woke = m._wakeParentOnReport(k.rec, { status: 'done', summary: '## PR opened\nsecond line' }, { hadAwaiters: false });
        await new Promise(function(r) { setTimeout(r, 0); });
        assert.strictEqual(woke, false, 'no wake reported');
        var rows = passiveRows();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].subAgentName, 'Kid');
        assert.strictEqual(rows[0].status, 'done');
        assert.strictEqual(rows[0].text, 'PR opened', 'one-line headline, markdown marker stripped');
        assert.strictEqual(rows[0].subChatId, 'c_kid');
        assert.deepStrictEqual(runs, [], 'no parent run started');
        assert.strictEqual(chats.root.messages.filter(function(x) { return x.role === 'user'; }).length, 0, 'no model-visible user row');
        assert.strictEqual(pend.root, undefined, 'nothing queued for injection');
    });
    test('live parent not awaiting: passive row, no injection', async function() {
        var k = kid(); running.root = true;
        m._wakeParentOnReport(k.rec, { status: 'error', summary: 'boom' }, { hadAwaiters: false });
        assert.strictEqual(passiveRows().length, 1);
        assert.strictEqual(passiveRows()[0].status, 'error');
        assert.strictEqual(pend.root, undefined);
        assert.deepStrictEqual(runs, []);
    });
    test('parent blocked in await_handle on that handle: no duplicate row', async function() {
        var k = kid(); running.root = true;
        var w = m.Handles.await('root', k.h.handleId, 0);
        var sampled = m._spawnHandleHasAwaiters(k.rec);
        assert.strictEqual(sampled, true, 'parent genuinely blocked');
        m._wakeParentOnReport(k.rec, { status: 'done', summary: 'X' }, { hadAwaiters: sampled });
        assert.strictEqual(passiveRows().length, 0, 'await delivers; no passive row');
        assert.deepStrictEqual(runs, []);
        void w;
    });
    test('noticeDelivered (lifecycle row already pushed): no extra row', async function() {
        var k = kid();
        m._wakeParentOnReport(k.rec, { status: 'error', summary: 'crash' }, { noticeDelivered: true });
        assert.strictEqual(passiveRows().length, 0);
    });
    test('headline clamps long first lines and skips blank lines', async function() {
        assert.strictEqual(m._passiveReportHeadline('\n\n- item one\nmore'), 'item one');
        var h = m._passiveReportHeadline('word '.repeat(80));
        assert.ok(h.length <= 200 && /\u2026$/.test(h), 'clamped: ' + h.length);
        assert.strictEqual(m._passiveReportHeadline(''), '');
        var exact = 'y'.repeat(200);
        assert.strictEqual(m._passiveReportHeadline(exact), exact, 'a 200-char line is kept whole (boundary)');
    });
    test('wake_sub_agent({wake_parent:true}) overrides: next report wakes the idle parent', async function() {
        var k = kid({ state: 'sleeping' });
        var bad = m._wakeSubAgentImpl({ agent_id: 'kid', wake_parent: 'yes' }, null, true);
        assert.strictEqual(bad.success, false, 'non-boolean rejected');
        assert.strictEqual(k.rec.wake_parent, false, 'invalid arg does not mutate');
        var res = m._wakeSubAgentImpl({ agent_id: 'kid', wake_parent: true }, null, true);
        assert.strictEqual(k.rec.wake_parent, true, 'override applied');
        assert.strictEqual(res.success === false ? true : res.wake_parent, true, 'result echoes wake_parent: ' + JSON.stringify(res));
        // The wake itself may start the SUB's own loop (pool drain → runAgent('c_kid')); only the parent run matters here.
        runs.length = 0; delete running.root;
        var woke = m._wakeParentOnReport(k.rec, { status: 'done', summary: 'AFTER-OVERRIDE' }, { hadAwaiters: false });
        await new Promise(function(r) { setTimeout(r, 0); });
        assert.strictEqual(woke, true);
        assert.strictEqual(passiveRows().length, 0, 'no passive row once waking');
        assert.ok(chats.root.messages.some(function(x) { return x.role === 'user' && /AFTER-OVERRIDE/.test(x.content); }), 'notice row pushed');
        assert.ok(runs.indexOf('root') !== -1, 'parent run started: ' + JSON.stringify(runs));
    });
    test('wake_sub_agent without wake_parent keeps the spawn-time setting', async function() {
        var k = kid({ state: 'sleeping' });
        m._wakeSubAgentImpl({ agent_id: 'kid' }, null, true);
        assert.strictEqual(k.rec.wake_parent, false);
    });
});

describe('passive report row renderer', function() {
    test('renders a final card with status, headline, hint and View agent', async function() {
        var ui = await loadModules(['src/js/ui/175-sub-agent-ui.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), console: console,
            escapeHtml: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
            formatContent: function(s) { return '<md>' + String(s).replace(/</g, '&lt;') + '</md>'; }
        }});
        var html = ui.renderSubAgentMessage({ role: 'sub_msg', kind: 'passive_report', subAgentId: 'kid', subAgentName: 'Kid<x>', status: 'done', text: 'PR opened <b>' }, 7);
        assert.match(html, /id="msg-7"/);
        assert.match(html, /class="message sub-notice sub-report-done sub-notice-final"/);
        assert.match(html, /Final report · done/);
        assert.match(html, /data-worker-modal="kid"/);
        assert.match(html, /Parent not woken/);
        assert.ok(html.indexOf('<b>') === -1 && html.indexOf('Kid<x>') === -1, 'escaped');
        var plain = ui.renderSubAgentMessage({ role: 'sub_msg', subAgentId: 'kid', text: 'hi' }, 3);
        assert.match(plain, /Message to parent/, 'plain sub_msg unchanged');
    });
});
