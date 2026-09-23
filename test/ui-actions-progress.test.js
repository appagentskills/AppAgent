// B2 — UI tests for the Actions system (src/js/tools/120-actions.js):
// action buttons (renderActionButton / getButtonDisplay / getStateBadgeIcon /
// renderActionsForPlacement), the inline show_action_button row
// (renderInlineActionButton + click -> startAction background chat), the
// running/result popovers (onActionButtonClick routing), the hover tooltip,
// live in-place refresh after update_action_state, and the Progress sidebar
// timeline card (renderActionUpdatesSection). Real modules, real document.
// Run: run_tests { files: ['test/ui-actions-progress.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/200-ui-interactions.js', 'src/js/ui/120-ui-utils.js', 'src/js/ui/250-message-render.js', 'src/js/tools/120-actions.js'];
var ALLOW = ['smartDocuments', '_isChatInSilentHook', 'currentEditingWidget', 'getDisplayHtmlForMessage', 'isChatRunning', 'AgentEvents',
    'SubAgents', 'syncPauseButtonUI', 'pushPauseToggleToOffscreen', 'pushInterruptToOffscreen', '_pauseToggleGen', 'applyHeaderActionsResponsive',
    '_refreshJobsExpandModal', 'renderHomeActiveChats', 'getActiveChatsList', '_isChatInActiveSection', 'updateChatTitleHeader', 'formatContent'];
var HOSTILE = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
var SKILL = 'sk1';

function noop() { return ''; }
// innerHTML re-serializes SVG (<rect/> -> <rect></rect>); compare icons via the same serializer.
var _normEl = document.createElement('div');
function svgNorm(s) { _normEl.innerHTML = s || ''; return _normEl.innerHTML; }
function iconEq(el, icon, msg) { assert.strictEqual(el.innerHTML, svgNorm(icon), msg); }
function win() { return { document: document, addEventListener: noop, removeEventListener: noop, innerWidth: 0, innerHeight: 0, _rawCopyStore: {}, currentSearchHighlight: null, isRunning: false }; }
function baseSkills(extraActions) {
    var s = {};
    s[SKILL] = { id: SKILL, name: 'Audit Skill', actions: [
        { name: 'Run Scan', icon: 'search', show: ['home', 'chat'] },
        { name: 'Deploy', icon: 'rocket', show: 'sidebar' }
    ].concat(extraActions || []) };
    return s;
}
async function load(extra) {
    var s = U.stubs();
    var G = {};
    G = Object.assign(G, {
        skills: baseSkills(), activeSkills: { sk1: true }, chats: { c1: { id: 'c1', messages: [] } }, currentChatId: 'c1', currentView: 'chat',
        activeStreamingChatId: null, pausedChats: {}, compactToolCalls: false, showApiStats: false, hooksEnabled: {}, compactAreaExpandedState: {},
        thinkingExpandedState: {}, userMsgExpandedState: {}, pendingInjectionsByChatId: {}, stickToBottom: false, pinToBottom: false,
        showSnackbar: s.showSnackbar, saveChatsToStorage: s.saveChatsToStorage, runAgent: U.recorder(function(id) { if (G.chats[id]) G.chats[id].messages.push({ role: 'assistant', content: 'started' }); return Promise.resolve(); }),
        renderMessages: U.recorder(), scrollToBottomIfAllowed: U.recorder(), updateContextIndicator: noop, updateInputPosition: noop,
        getWidgetHtmlForMessage: noop, renderInlineChanges: noop, initializeWidgetsInView: noop, renderWidgetSidebar: noop,
        initDisplayChecklists: noop, restoreChatScrollTop: noop,
        AgentEvents: { emit: U.recorder() }
    }, extra || {});
    var m = await U.loadUi(FILES, { window: win(), globals: G, allowUnstubbed: ALLOW });
    m.__G = G;
    return m;
}
function aid(m, name) { return m.getActionId(SKILL, name || 'Run Scan'); }
function seed(m, name, st) {
    var id = aid(m, name);
    m.activeActions[id] = Object.assign({ actionId: id, skillId: SKILL, skillName: 'Audit Skill', actionName: name || 'Run Scan', chatId: 'bg1',
        state: 'running', icon: 'search', label: 'Scanning', tasks: [], startedAt: Date.now() - 5000, updatedAt: Date.now() }, st || {});
    return id;
}
function scanAction(m) { return m.__G.skills[SKILL].actions[0]; }
function btnDom(m, extraClass) { return U.frag(m.renderActionButton(SKILL, 'Audit Skill', scanAction(m), extraClass)).querySelector('button'); }
function popover() { return document.querySelector('.action-result-popover'); }
function tc(id, name, a) { return { id: id, type: 'function', function: { name: name, arguments: JSON.stringify(a) } }; }
function uasChat(updates, opts) {
    opts = opts || {};
    var msgs = [{ role: 'user', content: 'go' }];
    updates.forEach(function(u, i) {
        msgs.push({ role: 'assistant', content: '', tool_calls: [tc('u' + i, 'update_action_state', u)] });
        if (!(opts.pending && i === updates.length - 1)) msgs.push({ role: 'tool', tool_call_id: 'u' + i, content: '{"success":true}' });
    });
    return Object.assign({ id: 'c1', messages: msgs }, opts.chat || {});
}
var cleanupM = null;
function track(m) { cleanupM = m; return m; }
function teardown() {
    if (cleanupM) { try { cleanupM.closeResultPopover(); cleanupM.onActionButtonLeave(); } catch (e) {} cleanupM = null; }
    U.cleanupAll();
}

describe('ui actions › state badge + button rendering', function() {
    afterEach(teardown);
    test('getStateBadgeIcon + progressStateMeta map every state to the right icon/label', async function() {
        var m = track(await load()), I = m.UI_ICONS;
        assert.strictEqual(m.getStateBadgeIcon('idle'), '', 'idle has no badge');
        var exp = { running: I.spinner, stuck: I.alert, needs_input: I.bell, needs_permission: I.lock, done: I.check, error: I.close, stopped: I.stop,
            finished: I.check, pr_opened: I.rocket, finished_with_caveat: I.alert, bogus: I.play };
        Object.keys(exp).forEach(function(s) { assert.ok(exp[s], 'icon exists for ' + s); assert.strictEqual(m.getStateBadgeIcon(s), exp[s], s); });
        assert.strictEqual(m.getStateBadgeIcon('running', 'is-paused'), I.pause, 'paused flag wins');
        var lbl = { running: 'Running', waiting: 'Waiting for sub-agents', stuck: 'Needs attention', done: 'Done', error: 'Failed', finished: 'Finished',
            pr_opened: 'PR opened', pr_merged: 'PR merged', finished_with_caveat: 'Finished with caveat', stopped: 'Stopped', idle: 'Idle' };
        Object.keys(lbl).forEach(function(s) { var x = m.progressStateMeta(s); assert.strictEqual(x.label, lbl[s], s); assert.strictEqual(x.cls, 'state-' + s); });
        assert.strictEqual(m.progressStateMeta('stopped').icon, I.stop, 'stopped is not a spinner');
    }, { tags: ['unit'] });
    test('idle button: structure, a11y, no badge, action-name label', async function() {
        var m = track(await load()), b = btnDom(m, 'placement-home');
        assert.deepStrictEqual(m.getButtonDisplay(SKILL, scanAction(m)), { state: 'idle', icon: 'search', label: 'Run Scan', tasks: [] });
        assert.strictEqual(b.getAttribute('type'), 'button');
        assert.ok(b.classList.contains('action-btn') && b.classList.contains('state-idle') && b.classList.contains('placement-home'));
        assert.strictEqual(b.getAttribute('data-skill-id'), SKILL); assert.strictEqual(b.getAttribute('data-action-name'), 'Run Scan');
        assert.strictEqual(b.querySelector('.action-btn-label').textContent, 'Run Scan');
        assert.strictEqual(b.querySelector('.action-btn-badge'), null, 'no badge when idle');
        assert.strictEqual(b.querySelector('.action-btn-primary').getAttribute('aria-hidden'), 'true');
        iconEq(b.querySelector('.action-btn-primary'), m.UI_ICONS.search, 'primary icon = action icon');
        var a = U.a11y(b);
        assert.strictEqual(a.aria.label, 'Run Scan — Audit Skill (idle)'); assert.strictEqual(a.focusable, true);
        assert.strictEqual(b.getAttribute('title'), 'Run Scan — Audit Skill');
        assert.strictEqual(b.getAttribute('onclick'), 'onActionButtonClick(this)');
    }, { tags: ['unit'] });
    test('each live state: class, live label, badge icon, aria state', async function() {
        var m = track(await load());
        ['running', 'waiting', 'stuck', 'needs_input', 'needs_permission', 'done', 'error', 'stopped', 'finished', 'pr_opened', 'finished_with_caveat'].forEach(function(s) {
            seed(m, 'Run Scan', { state: s, label: 'L-' + s });
            var b = btnDom(m);
            assert.ok(b.classList.contains('state-' + s), s + ' class');
            assert.strictEqual(b.querySelector('.action-btn-label').textContent, 'L-' + s);
            var badge = b.querySelector('.action-btn-badge');
            assert.ok(badge, s + ' badge'); assert.strictEqual(badge.getAttribute('aria-hidden'), 'true');
            iconEq(badge, m.getStateBadgeIcon(s), s + ' badge icon');
            assert.match(b.getAttribute('aria-label'), new RegExp('\\(' + s + '\\)$'));
        });
    }, { tags: ['unit'] });
    test('paused + reload-interrupted modifiers', async function() {
        var m = track(await load());
        seed(m, 'Run Scan', { state: 'running', _isPaused: true });
        var b = btnDom(m);
        assert.ok(b.classList.contains('is-paused')); iconEq(b.querySelector('.action-btn-badge'), m.UI_ICONS.pause, 'pause badge');
        seed(m, 'Run Scan', { state: 'running', reloadInterrupted: true });
        assert.ok(btnDom(m).classList.contains('reload-interrupted'));
        seed(m, 'Run Scan', { state: 'done', reloadInterrupted: true });
        assert.ok(!btnDom(m).classList.contains('reload-interrupted'), 'only while running');
    }, { tags: ['unit'] });
    test('hostile skill / action / label text is escaped', async function() {
        var m = track(await load({ skills: (function() { var s = {}; s[HOSTILE] = { name: HOSTILE, actions: [{ name: HOSTILE, icon: 'nope' }] }; return s; })() }));
        var act = m.__G.skills[HOSTILE].actions[0];
        m.activeActions[m.getActionId(HOSTILE, HOSTILE)] = { state: 'running', label: HOSTILE + '"x', skillId: HOSTILE, actionName: HOSTILE };
        var body = U.frag(m.renderActionButton(HOSTILE, HOSTILE, act));
        assert.strictEqual(body.querySelectorAll('img, script, [onerror]').length, 0);
        var b = body.querySelector('button');
        assert.strictEqual(b.getAttribute('data-skill-id'), HOSTILE); assert.strictEqual(b.getAttribute('data-action-name'), HOSTILE);
        assert.strictEqual(b.querySelector('.action-btn-label').textContent, HOSTILE + '"x');
        iconEq(b.querySelector('.action-btn-primary'), m.UI_ICONS.play, 'unknown icon falls back to play');
    }, { tags: ['unit'] });
    test('renderActionsForPlacement: filters by show (array or string), inactive skill, empty', async function() {
        var m = track(await load());
        var home = U.frag(m.renderActionsForPlacement('home', 'placement-home')).querySelectorAll('button.action-btn');
        assert.strictEqual(home.length, 1); assert.strictEqual(home[0].getAttribute('data-action-name'), 'Run Scan');
        var side = U.frag(m.renderActionsForPlacement('sidebar', 'placement-sidebar')).querySelectorAll('button');
        assert.strictEqual(side.length, 1, 'string show'); assert.ok(side[0].classList.contains('placement-sidebar'));
        assert.strictEqual(m.renderActionsForPlacement('header'), '', 'no header placement');
        m.__G.activeSkills.sk1 = false;
        assert.strictEqual(m.renderActionsForPlacement('home'), '', 'inactive skill hidden');
    }, { tags: ['unit'] });
});

describe('ui actions › inline show_action_button', function() {
    afterEach(teardown);
    test('unknown skill / unknown action render escaped error rows (not a fake button)', async function() {
        var m = track(await load());
        var e1 = U.frag(m.renderInlineActionButton({ skillId: HOSTILE, actionName: 'x' }, 3)).firstElementChild;
        assert.ok(e1.classList.contains('inline-action-button-err')); assert.strictEqual(e1.id, 'msg-3');
        assert.strictEqual(e1.textContent, 'Unknown skill: ' + HOSTILE); assert.strictEqual(e1.querySelector('img,script'), null);
        var e2 = U.frag(m.renderInlineActionButton({ skillId: SKILL, actionName: '<b>Gone</b>' }, 4)).firstElementChild;
        assert.strictEqual(e2.textContent, 'Unknown action "<b>Gone</b>" on skill "Audit Skill"'); assert.strictEqual(e2.querySelector('button, b'), null);
    }, { tags: ['unit'] });
    test('valid row: wrapper, placement-inline button, patched onclick, escaped truncated caption', async function() {
        var m = track(await load());
        var ctx = HOSTILE + 'y'.repeat(300);
        var row = U.frag(m.renderInlineActionButton({ skillId: SKILL, actionName: 'Run Scan', context: ctx }, 7)).firstElementChild;
        assert.ok(row.classList.contains('message') && row.classList.contains('inline-action-button')); assert.strictEqual(row.id, 'msg-7');
        var b = row.querySelector('.inline-action-wrap > button.action-btn.placement-inline');
        assert.ok(b, 'button'); assert.strictEqual(b.getAttribute('data-msg-index'), '7');
        assert.strictEqual(b.getAttribute('onclick'), "onInlineActionButtonClick(this, '7')");
        var cap = row.querySelector('.inline-action-context');
        assert.strictEqual(cap.textContent, ctx.substring(0, 200)); assert.strictEqual(row.querySelector('img,script'), null);
        var noCtx = U.frag(m.renderInlineActionButton({ skillId: SKILL, actionName: 'Run Scan' }, 8));
        assert.strictEqual(noCtx.querySelector('.inline-action-context'), null, 'no caption without context');
    }, { tags: ['unit'] });
    test('executeShowActionButton validates + pushes an action_button message and re-renders', async function() {
        var m = track(await load());
        assert.strictEqual(m.executeShowActionButton({ skill: SKILL }).success, false);
        assert.match(m.executeShowActionButton({ skill: 'nope', action: 'x' }).error, /Skill not found/);
        assert.match(m.executeShowActionButton({ skill: SKILL, action: 'x' }).error, /Action not found/);
        var r = m.executeShowActionButton({ skill: SKILL, action: 'Run Scan', context: 'ctx1' });
        assert.strictEqual(r.success, true);
        var msg = m.__G.chats.c1.messages[0];
        assert.strictEqual(msg.role, 'action_button'); assert.strictEqual(msg.context, 'ctx1'); assert.strictEqual(r._message_persist, msg);
        assert.strictEqual(m.__G.saveChatsToStorage.calls.length, 1);
        assert.strictEqual(m.__G.chats.c1.messages.length, 1, 'failed validations pushed nothing');
    }, { tags: ['unit'] });
    test('click on idle inline button starts a background chat with the context and refreshes the button in place', async function() {
        var m = track(await load());
        m.__G.chats.c1.messages.push({ role: 'action_button', skillId: SKILL, actionName: 'Run Scan', context: 'from caller <ctx>' });
        var dom = await U.mountDom({ html: m.renderInlineActionButton(m.__G.chats.c1.messages[0], 0) });
        var b = dom.$('button.action-btn');
        U.fireInline(b, 'click', m);
        await U.flush();
        var a = m.activeActions[aid(m)];
        assert.ok(a, 'active action created'); assert.strictEqual(a.state, 'running'); assert.strictEqual(a.label, 'Starting…');
        var bg = m.__G.chats[a.chatId];
        assert.ok(bg && bg.isBackground, 'background chat'); assert.strictEqual(bg.sourceChatId, 'c1'); assert.strictEqual(bg.actionId, aid(m));
        assert.match(bg.messages[0].content, /^Run action: \*\*Run Scan\*\*/);
        assert.match(bg.messages[0].content, /\*\*Context from the caller:\*\*\nfrom caller <ctx>$/);
        assert.deepStrictEqual(m.__G.runAgent.calls.map(function(c) { return c[0]; }), [a.chatId]);
        // notifyActionStateChanged -> refreshActionButtons mutates the mounted DOM
        assert.ok(b.classList.contains('state-running') && b.classList.contains('placement-inline'), b.className);
        assert.strictEqual(b.querySelector('.action-btn-label').textContent, 'Starting…');
        iconEq(b.querySelector('.action-btn-badge'), m.UI_ICONS.spinner, 'spinner badge');
        // second click while running: no second run, opens the running popover
        U.fireInline(b, 'click', m);
        assert.strictEqual(m.__G.runAgent.calls.length, 1);
        assert.strictEqual(popover().dataset.popoverType, 'running');
    }, { tags: ['unit'] });
});

describe('ui actions › click routing + popovers', function() {
    afterEach(teardown);
    test('running: popover with name, tasks, Show chat/Pause/Stop; buttons call the real handlers', async function() {
        var m = track(await load());
        var id = seed(m, 'Run Scan', { tasks: [{ label: 'Step <b>1</b>', status: 'done' }, { label: 'Step 2', status: 'running' }] });
        var dom = await U.mountDom({ html: m.renderActionButton(SKILL, 'Audit Skill', scanAction(m)) });
        U.fireInline(dom.$('button'), 'click', m);
        var p = popover();
        assert.ok(p && p.classList.contains('state-running') && !p.classList.contains('is-paused'));
        assert.strictEqual(p.dataset.actionId, id);
        assert.strictEqual(p.querySelector('.action-result-name').textContent, 'Audit Skill — Run Scan');
        assert.match(p.querySelector('.action-result-label').textContent, /^Scanning • \d+s$/);
        var tasks = p.querySelectorAll('.action-task');
        assert.strictEqual(tasks.length, 2); assert.ok(tasks[0].classList.contains('status-done'));
        assert.strictEqual(tasks[0].querySelector('.action-task-label').textContent, 'Step <b>1</b>'); assert.strictEqual(p.querySelector('b'), null);
        var btns = Array.prototype.map.call(p.querySelectorAll('.action-result-footer button'), function(x) { return x.textContent.trim(); });
        assert.deepStrictEqual(btns, ['Show chat', 'Pause', 'Stop']);
        assert.strictEqual(U.a11y(p.querySelector('.action-result-close')).aria.label, 'Close');
        m.pauseAction = U.recorder();
        U.fireInline(p.querySelector('.action-result-btn.secondary'), 'click', m);
        assert.deepStrictEqual(m.pauseAction.calls, [[id]]); assert.strictEqual(popover(), null, 'pause closes popover');
    }, { tags: ['unit'] });
    test('paused running action offers Resume instead of Pause', async function() {
        var m = track(await load());
        var id = seed(m, 'Run Scan', { _isPaused: true });
        var dom = await U.mountDom({ html: m.renderActionButton(SKILL, 'Audit Skill', scanAction(m)) });
        U.fireInline(dom.$('button'), 'click', m);
        assert.ok(popover().classList.contains('is-paused'));
        var labels = Array.prototype.map.call(popover().querySelectorAll('.action-result-footer button'), function(x) { return x.textContent.trim(); });
        assert.deepStrictEqual(labels, ['Show chat', 'Resume', 'Stop']);
        m.resumeAction = U.recorder();
        U.fireInline(popover().querySelector('.action-result-btn.primary'), 'click', m);
        assert.deepStrictEqual(m.resumeAction.calls, [[id]]);
    }, { tags: ['unit'] });
    test('terminal + stuck states open the result popover (output markdown, duration, Dismiss, Resume for stuck)', async function() {
        var m = track(await load());
        ['done', 'error', 'stopped', 'finished', 'pr_opened', 'finished_with_caveat', 'stuck'].forEach(function(s) {
            var id = seed(m, 'Run Scan', { state: s, output: 'Found **3** issues\\n' + HOSTILE, startedAt: 1000, updatedAt: 43000 });
            m.closeResultPopover(); U.cleanupAll();
            var dom = U.parse(m.renderActionButton(SKILL, 'Audit Skill', scanAction(m)));
            var b = dom.querySelector('button'); document.body.appendChild(b);
            try { U.fireInline(b, 'click', m); } finally { b.remove(); }
            var p = popover();
            assert.ok(p, s + ' popover'); assert.strictEqual(p.dataset.popoverType, 'result'); assert.ok(p.classList.contains('state-' + s));
            var out = p.querySelector('.action-result-output.markdown-body');
            assert.strictEqual(out.querySelector('strong').textContent, '3', s + ' markdown');
            assert.strictEqual(out.querySelectorAll('img, script, [onerror]').length, 0, s + ' escaped');
            assert.ok(!/\\n/.test(out.textContent), 'literal \\n normalized');
            assert.strictEqual(p.querySelector('.action-result-duration').textContent, 'Took 42s');
            var labels = Array.prototype.map.call(p.querySelectorAll('.action-result-footer button'), function(x) { return x.textContent.trim(); });
            assert.deepStrictEqual(labels, s === 'stuck' ? ['Show chat', 'Dismiss', 'Resume'] : ['Show chat', 'Dismiss'], s);
            m.dismissAction = U.recorder();
            U.fireInline(p.querySelector('.action-result-btn.secondary'), 'click', m);
            assert.deepStrictEqual(m.dismissAction.calls, [[id]]); assert.strictEqual(popover(), null);
        });
    }, { tags: ['unit'] });
    test('close button + opening another popover replace (never stack)', async function() {
        var m = track(await load());
        seed(m, 'Run Scan', { state: 'done' });
        var dom = await U.mountDom({ html: m.renderActionButton(SKILL, 'Audit Skill', scanAction(m)) });
        U.fireInline(dom.$('button'), 'click', m);
        U.fireInline(dom.$('button'), 'click', m);
        assert.strictEqual(document.querySelectorAll('.action-result-popover').length, 1, 'single popover');
        U.fireInline(popover().querySelector('.action-result-close'), 'click', m);
        assert.strictEqual(popover(), null);
        // idle button with no action name is a no-op
        var bare = document.createElement('button'); m.onActionButtonClick(bare);
        assert.strictEqual(popover(), null);
    }, { tags: ['unit'] });
    test('hover tooltip shows tasks for live actions, nothing for idle, removed on leave', async function() {
        var m = track(await load());
        var dom = await U.mountDom({ html: m.renderActionButton(SKILL, 'Audit Skill', scanAction(m)) });
        U.fireInline(dom.$('button'), 'mouseenter', m);
        assert.strictEqual(document.querySelector('.action-tooltip'), null, 'idle: no tooltip');
        U.fireInline(dom.$('button'), 'mouseleave', m);
        seed(m, 'Run Scan', { tasks: [{ label: HOSTILE, status: 'error' }] });
        U.fireInline(dom.$('button'), 'mouseenter', m);
        var tt = document.querySelector('.action-tooltip');
        assert.ok(tt); assert.strictEqual(tt.querySelector('.action-task.status-error .action-task-label').textContent, HOSTILE);
        assert.strictEqual(tt.querySelectorAll('img,script').length, 0);
        U.fireInline(dom.$('button'), 'mouseleave', m);
        assert.strictEqual(document.querySelector('.action-tooltip'), null);
    }, { tags: ['unit'] });
    test('task status is escaped in running popover, result popover and tooltip; ordinary statuses unchanged', async function() {
        var m = track(await load());
        var EVIL = 'x"><img src=x onerror="window.__pwnStatus=1">';
        var tasks = [{ label: 'A', status: 'done' }, { label: 'B', status: 'running' }, { label: 'C', status: 'error' }, { label: 'D', status: 'pending' }, { label: 'E', status: EVIL }];
        function check(root, where) {
            assert.ok(root, where + ' rendered');
            var els = root.querySelectorAll('.action-task');
            assert.strictEqual(els.length, 5, where + ' task count');
            assert.strictEqual(root.querySelectorAll('img, [onerror]').length, 0, where + ' no injected element');
            ['done', 'running', 'error', 'pending'].forEach(function(s, i) {
                assert.strictEqual(els[i].getAttribute('class'), 'action-task status-' + s, where + ' ordinary ' + s);
                assert.strictEqual(els[i].children.length, 2, where + ' ' + s + ' children');
                assert.strictEqual(els[i].querySelector('.action-task-label').textContent, tasks[i].label);
            });
            assert.strictEqual(els[4].getAttribute('class'), 'action-task status-' + EVIL, where + ' class attribute intact');
            assert.strictEqual(els[4].querySelector('.action-task-label').textContent, 'E', where + ' label intact');
            iconEq(els[0].querySelector('.action-task-icon'), m.UI_ICONS.check, where + ' done icon');
            iconEq(els[4].querySelector('.action-task-icon'), m.UI_ICONS.clock, where + ' unknown status icon');
        }
        seed(m, 'Run Scan', { state: 'running', tasks: tasks });
        var dom = await U.mountDom({ html: m.renderActionButton(SKILL, 'Audit Skill', scanAction(m)) });
        U.fireInline(dom.$('button'), 'click', m);
        assert.strictEqual(popover().dataset.popoverType, 'running');
        check(popover(), 'running popover');
        m.closeResultPopover();
        U.fireInline(dom.$('button'), 'mouseenter', m);
        check(document.querySelector('.action-tooltip'), 'tooltip');
        U.fireInline(dom.$('button'), 'mouseleave', m);
        seed(m, 'Run Scan', { state: 'done', tasks: tasks });
        U.fireInline(dom.$('button'), 'click', m);
        assert.strictEqual(popover().dataset.popoverType, 'result');
        check(popover(), 'result popover');
        assert.strictEqual(window.__pwnStatus, undefined, 'no handler ran');
    }, { tags: ['unit'] });
});

describe('ui actions › update_action_state drives the live button', function() {
    afterEach(teardown);
    test('background update: state/label/badge refresh in place, tasks normalized, invalid state rejected', async function() {
        var m = track(await load());
        var id = seed(m, 'Run Scan');
        m.__G.chats.bg1 = { id: 'bg1', messages: [], isBackground: true, actionId: id };
        var dom = await U.mountDom({ html: m.renderActionButton(SKILL, 'Audit Skill', scanAction(m), 'placement-chat') });
        var bad = await m.executeUpdateActionState({ state: 'paused' }, { chatId: 'bg1' });
        assert.strictEqual(bad.success, false); assert.match(bad.error, /Invalid state/);
        var tasks = []; for (var i = 0; i < 25; i++) tasks.push({ label: 'T' + i, status: i === 0 ? 'weird' : 'done' });
        var r = await m.executeUpdateActionState({ state: 'success', label: 'All good', icon: 'hax', tasks: tasks, output: 'ok' }, { chatId: 'bg1' });
        assert.strictEqual(r.success, true);
        var a = m.activeActions[id];
        assert.strictEqual(a.state, 'done', 'success alias'); assert.strictEqual(a.icon, 'spinner', 'off-list icon coerced');
        assert.strictEqual(a.tasks.length, 20); assert.strictEqual(a.tasks[0].status, 'pending');
        var b = dom.$('button');
        assert.ok(b.classList.contains('state-done') && b.classList.contains('placement-chat'), b.className);
        assert.strictEqual(b.querySelector('.action-btn-label').textContent, 'All good');
        iconEq(b.querySelector('.action-btn-badge'), m.UI_ICONS.check, 'check badge');
    }, { tags: ['unit'] });
});

describe('ui actions › Progress sidebar timeline (renderActionUpdatesSection)', function() {
    afterEach(teardown);
    test('empty / no-tool-result / unparsable updates render nothing', async function() {
        var m = track(await load());
        assert.strictEqual(m.renderActionUpdatesSection(null), '');
        assert.strictEqual(m.renderActionUpdatesSection({ messages: [] }), '');
        assert.strictEqual(m.renderActionUpdatesSection(uasChat([{ state: 'running', label: 'x' }], { pending: true })), '', 'not yet executed');
        var broken = { messages: [{ role: 'assistant', tool_calls: [{ id: 'z', function: { name: 'update_action_state', arguments: '{"state":' } }] }, { role: 'tool', tool_call_id: 'z' }] };
        assert.strictEqual(m.renderActionUpdatesSection(broken), '');
    }, { tags: ['unit'] });
    test('card: header, badge label per state, label, status message, task list icons', async function() {
        var m = track(await load()), I = m.UI_ICONS;
        var exp = { running: 'RUNNING', stuck: 'STUCK', waiting: 'WAITING FOR SUB-AGENTS', pr_opened: 'PR OPENED', finished_with_caveat: 'FINISHED WITH CAVEAT', error: 'ERROR' };
        Object.keys(exp).forEach(function(s) {
            var card = U.frag(m.renderActionUpdatesSection(uasChat([{ state: s, label: 'L' }]))).querySelector('.action-updates');
            assert.ok(card.classList.contains('sidebar-card') && card.classList.contains('state-' + s)); assert.strictEqual(card.getAttribute('data-last-state'), s);
            var badge = card.querySelector('.action-updates-state-badge.state-' + s);
            assert.strictEqual(badge.textContent, exp[s], s); iconEq(badge.querySelector('.action-updates-state-icon'), m.progressStateMeta(s).icon, s + ' icon');
        });
        var c = U.frag(m.renderActionUpdatesSection(uasChat([{ state: 'running', label: 'Lbl ' + HOSTILE, status_message: 'Doing <i>x</i>',
            tasks: [{ label: 'A', status: 'done' }, { label: 'B', status: 'error' }, { label: 'C', status: 'running' }, { label: HOSTILE }] }])));
        assert.strictEqual(c.querySelector('.action-updates-title').textContent, 'Progress');
        assert.strictEqual(c.querySelector('.action-update.current .action-update-label-row').textContent, 'Lbl ' + HOSTILE);
        assert.strictEqual(c.querySelector('.action-update-statusmsg').textContent, 'Doing <i>x</i>');
        var li = c.querySelectorAll('ul.action-update-tasks > li.action-update-task');
        assert.deepStrictEqual(Array.prototype.map.call(li, function(x) { return x.className; }),
            ['action-update-task status-done', 'action-update-task status-error', 'action-update-task status-running', 'action-update-task status-pending']);
        assert.deepStrictEqual(Array.prototype.map.call(li, function(x) { return x.querySelector('.action-update-task-icon').innerHTML; }), [I.check, I.close, I.spinner, I.clock].map(svgNorm));
        assert.strictEqual(li[3].querySelector('.action-update-task-label').textContent, HOSTILE);
        assert.strictEqual(c.querySelectorAll('img, script, i, [onerror]').length, 0, 'all escaped');
        assert.strictEqual(c.querySelector('.action-update-output'), null, 'no output while running');
    }, { tags: ['unit'] });
    test('output markdown only in terminal states, escaped, \\n normalized', async function() {
        var m = track(await load());
        var run = U.frag(m.renderActionUpdatesSection(uasChat([{ state: 'running', output: '**hidden**' }])));
        assert.strictEqual(run.querySelector('.action-update-output'), null);
        ['done', 'finished', 'pr_opened', 'error'].forEach(function(s) {
            var o = U.frag(m.renderActionUpdatesSection(uasChat([{ state: s, output: '## Result\\n- **3** fixed\\n' + HOSTILE }]))).querySelector('.action-update-output.markdown-body');
            assert.ok(o, s); assert.strictEqual(o.querySelector('strong').textContent, '3');
            assert.ok(o.querySelector('li'), s + ' list'); assert.strictEqual(o.querySelectorAll('img, script').length, 0);
        });
    }, { tags: ['unit'] });
    test('history trail: deduped previous steps, state labels, toggle persists open across re-render', async function() {
        var m = track(await load());
        var chat = uasChat([{ state: 'running', status_message: 'Step A' }, { state: 'running', status_message: 'Step A' },
            { state: 'stuck', status_message: 'Blocked <x>' }, { state: 'done', status_message: 'Final' }]);
        var dom = await U.mountDom({ html: m.renderActionUpdatesSection(chat) });
        var d = dom.$('details.action-update-history');
        assert.ok(d && !d.open, 'collapsed by default');
        assert.strictEqual(d.querySelector('.action-update-history-count').textContent, '(2)', 'duplicate step deduped');
        var items = d.querySelectorAll('.action-update-history-item');
        assert.deepStrictEqual(Array.prototype.map.call(items, function(x) { return x.querySelector('.action-update-history-label').textContent + '|' + x.querySelector('.action-update-history-state').textContent; }),
            ['Step A|Running', 'Blocked <x>|Needs attention']);
        assert.ok(items[1].classList.contains('state-stuck'));
        assert.strictEqual(dom.$('.action-update.current .action-update-statusmsg').textContent, 'Final', 'latest is the in-place card');
        d.open = true; U.fireInline(d, 'toggle', m);
        assert.strictEqual(m.actionUpdateHistoryOpen.c1, true);
        assert.ok(U.frag(m.renderActionUpdatesSection(chat)).querySelector('details.action-update-history').open, 'reopened after rebuild');
        var single = U.frag(m.renderActionUpdatesSection(uasChat([{ state: 'running', status_message: 'only' }])));
        assert.strictEqual(single.querySelector('details'), null, 'no history for single update');
    }, { tags: ['unit'] });
    test('progressStateOverride (pr_merged) wins over the latest update', async function() {
        var m = track(await load());
        var c = U.frag(m.renderActionUpdatesSection(uasChat([{ state: 'pr_opened', output: 'PR #1' }], { chat: { progressStateOverride: { state: 'pr_merged' } } })));
        var card = c.querySelector('.action-updates');
        assert.strictEqual(card.getAttribute('data-last-state'), 'pr_merged');
        assert.strictEqual(card.querySelector('.action-updates-state-badge').textContent, 'PR MERGED');
        assert.ok(c.querySelector('.action-update-output'), 'terminal output still shown');
    }, { tags: ['unit'] });
});
