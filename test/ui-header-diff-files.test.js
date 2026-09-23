// B9 — UI tests for surfaces B8 did not reach: the chat header (title, sub-agent
// badge, progress pill, rename modal), the standalone record diff viewer
// (100-diff-viewer.js: open/close, hunk navigation + wrap bounds, escaping,
// empty/preview/error states), the Workspace Files sidebar section
// (115-workspace-files-sidebar.js: rows, badges, click routing, modal keys,
// escaping, empty state) and the worker chat-view modal (175-sub-agent-ui.js).
// Real src modules + real body.html/CSS; inline handlers via U.fireInline,
// key handlers via real KeyboardEvents.
// Run: run_tests { files: ['test/ui-header-diff-files.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var HOSTILE = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
var ALL_CSS = ['00-tokens', '01-dark-theme', '02-layout', '03-chat', '04-header', '05-tools', '06-input', '07-markdown', '08-browser', '09-settings',
    '10-approval', '11-version', '12-artifacts', '13-notifications', '14-modals', '15-widgets', '16-diff', '17-skills', '18-panels', '19-dashboard',
    '19b-widget-library', '20-responsive', '21-display-templates', '21b-prompt-user', '21c-smart-documents', '22-sidepanel', '23-actions',
    '24-sub-agents', '25-ws-files'].map(function(n) { return 'src/css/' + n + '.css'; });
var ICONS = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js'];
var ESC = 'src/js/ui/180-search.js'; // real escapeHtml (+ renderChatList)
var ANY_UNSTUBBED = { indexOf: function() { return 0; } };

function winStub(extra) {
    var mq = { matches: false, addEventListener: function() {}, addListener: function() {} };
    return fakeWindow(Object.assign({ document: document, _rawCopyStore: {}, isRunning: false, open: U.recorder(), matchMedia: function() { return mq; } }, extra || {}));
}
function loadLenient(paths, globals) {
    return U.loadUi(paths, { globals: globals, lenient: true, allowUnstubbed: ANY_UNSTUBBED, window: globals.window });
}
// Modules like 210/230 register ANONYMOUS document listeners at load time —
// record every document.addEventListener made while loading so afterEach can detach them.
var docListeners = [];
async function loadCapturing(paths, globals) {
    var orig = document.addEventListener;
    document.addEventListener = function(t, f, o) { docListeners.push([t, f, o]); return orig.call(document, t, f, o); };
    try { return await loadLenient(paths, globals); } finally { document.addEventListener = orig; }
}
function detachDocListeners() { docListeners.forEach(function(l) { document.removeEventListener(l[0], l[1], l[2]); }); docListeners = []; }
function noInjection(root) { assert.strictEqual(root.querySelector('script, img[onerror]'), null, 'hostile markup must render as text'); assert.ok(!window.__pwn); }
// Like U.fireInline but with a REAL KeyboardEvent (fireInline's plain Event has no .key).
function fireInlineKey(el, key, m) {
    var code = el.getAttribute('onkeydown');
    if (code == null) throw new Error('no onkeydown');
    var ev = new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true });
    var scope = new Proxy({}, {
        has: function(t, k) { return typeof k === 'string' && k !== 'event' && ((k in m) || (k in m.__scope)); },
        get: function(t, k) { if (typeof k !== 'string') return undefined; return (k in m) ? m[k] : m.__scope[k]; },
        set: function(t, k, v) { m.__scope[k] = v; return true; }
    });
    new Function('__s', 'event', 'with (__s) { ' + code + ' }').call(el, scope, ev);
    return ev;
}
var VH = null; // real 090 diff engine, shared by the diff viewer + workspace-file diffs
async function versionEngine() { if (!VH) VH = await loadLenient(ICONS.concat([ESC, 'src/js/ui/090-version-history.js']), { window: winStub() }); return VH; }

// ─────────────────────────── Chat header ───────────────────────────
describe('ui header › chat title, badges, progress pill', function() {
    afterEach(function() { U.cleanupAll(); detachDocListeners(); });
    async function setup(chatsObj, extra) {
        var g = Object.assign({ window: winStub(), chats: chatsObj, currentChatId: 'c1', onChatTitleStatePillClick: U.recorder(), screenshotNav: { list: [], index: -1 }, screenshotModalKeyHandler: function() {},
            requestAnimationFrame: function(f) { f(); return 1; } }, extra || {});
        var m = await loadCapturing(ICONS.concat([ESC, 'src/js/ui/170-chat-management.js', 'src/js/ui/210-chat-menus.js', 'src/js/ui/220-notification-system.js', 'src/js/ui/230-modals.js']), g);
        var dom = await U.mountDom({ body: true, css: ALL_CSS });
        return { m: m, g: g, dom: dom };
    }

    test('title renders escaped; "New Chat" / no chat renders empty and CSS hides the rename button', async function() {
        var s = await setup({ c1: { id: 'c1', title: HOSTILE, messages: [] } });
        var el = s.dom.$('#header-chat-title'), rename = s.dom.$('#header-rename-btn');
        s.m.updateChatTitleHeader();
        assert.strictEqual(el.textContent, HOSTILE);
        noInjection(el);
        assert.notStrictEqual(U.css(rename, 'display'), 'none', 'rename visible next to a title');
        s.m.__scope.chats.c1.title = 'New Chat';
        s.m.updateChatTitleHeader();
        assert.strictEqual(el.innerHTML, '', 'placeholder title is not shown (keeps :empty true)');
        assert.strictEqual(U.css(rename, 'display'), 'none', '.header-chat-title:empty + .header-rename-btn hides it');
        s.m.__scope.currentChatId = 'missing';
        s.m.updateChatTitleHeader();
        assert.strictEqual(el.innerHTML, '');
    }, { tags: ['unit'] });

    test('sub-agent chat shows the identity badge (no nav segment)', async function() {
        var s = await setup({ c1: { id: 'c1', title: 'Worker A', isSubAgent: true, messages: [] } });
        s.m.updateChatTitleHeader();
        var el = s.dom.$('#header-chat-title');
        assert.strictEqual(el.querySelector('.chat-title-subagent-label').textContent, 'Sub-agent');
        assert.strictEqual(el.querySelectorAll('.chat-title-subagent-pill button, .chat-title-subagent-pill a').length, 0);
        assert.ok(el.textContent.indexOf('Worker A') === 0);
    }, { tags: ['unit'] });

    test('progress pill: state class, a11y, Enter/Space activate, waiting outranks progress', async function() {
        var meta = function(st) { return { icon: '<i class="ico"></i>', label: st === 'running' ? 'Running <now>' : 'Waiting' }; };
        var s = await setup({ c1: { id: 'c1', title: 'T', messages: [] } }, { getCurrentChatProgressState: U.recorder(function() { return { state: 'running' }; }), progressStateMeta: meta });
        s.m.updateChatTitleHeader('tc_9');
        assert.deepStrictEqual(s.g.getCurrentChatProgressState.calls[0], ['tc_9'], 'includeToolCallId forwarded');
        var pill = s.dom.$('#header-chat-title .chat-title-state-pill');
        assert.ok(pill.classList.contains('state-running'));
        var a = U.a11y(pill);
        assert.strictEqual(a.role, 'button'); assert.ok(a.focusable);
        assert.strictEqual(a.aria.label, 'Progress: Running <now> — click for details');
        assert.strictEqual(pill.querySelector('.chat-title-state-label').textContent, 'Running <now>');
        U.fireInline(pill, 'click', s.m);
        fireInlineKey(pill, 'Enter', s.m); fireInlineKey(pill, ' ', s.m); fireInlineKey(pill, 'a', s.m);
        assert.strictEqual(s.g.onChatTitleStatePillClick.calls.length, 3, 'click + Enter + Space, not other keys');
        assert.strictEqual(s.g.onChatTitleStatePillClick.calls[0][0], pill);
        s.m.__scope.chatWaitingStateFor = function() { return 'waiting'; };
        s.m.updateChatTitleHeader();
        assert.ok(s.dom.$('#header-chat-title .chat-title-state-pill').classList.contains('state-waiting'));
    }, { tags: ['unit'] });
});

describe('ui header › rename modal', function() {
    afterEach(function() { U.cleanupAll(); detachDocListeners(); });
    async function setup(extra) {
        var chatsObj = { c1: { id: 'c1', title: HOSTILE, titleProvisional: true, messages: [] } };
        var g = Object.assign({ window: winStub(), chats: chatsObj, currentChatId: 'c1', saveChatsToStorage: U.recorder(), screenshotNav: { list: [], index: -1 }, screenshotModalKeyHandler: function() {},
            requestAnimationFrame: function(f) { f(); return 1; } }, extra || {});
        var m = await loadCapturing(ICONS.concat([ESC, 'src/js/ui/170-chat-management.js', 'src/js/ui/210-chat-menus.js', 'src/js/ui/220-notification-system.js', 'src/js/ui/230-modals.js']), g);
        var dom = await U.mountDom({ body: true, css: ALL_CSS });
        return { m: m, g: g, dom: dom, chats: chatsObj };
    }

    test('header rename button opens the modal prefilled (escaped) with Cancel/Rename', async function() {
        var s = await setup();
        U.fireInline(s.dom.$('#header-rename-btn'), 'click', s.m);
        var ov = s.dom.$('#modal-overlay');
        assert.ok(ov.classList.contains('show'));
        assert.strictEqual(s.dom.$('#modal-header').textContent, 'Rename Chat');
        var input = s.dom.$('#rename-chat-input');
        assert.strictEqual(input.value, HOSTILE, 'title survives the value="" attribute round-trip');
        noInjection(s.dom.$('#modal-body'));
        var btns = s.dom.$$('#modal-actions .modal-btn');
        assert.deepStrictEqual(btns.map(function(b) { return b.textContent; }), ['Cancel', 'Rename']);
        assert.ok(btns[1].classList.contains('primary'));
        U.fireInline(btns[0], 'click', s.m);
        assert.ok(!ov.classList.contains('show'), 'Cancel closes');
        assert.strictEqual(s.chats.c1.title, HOSTILE, 'Cancel does not rename');
        s.m.openRenameModal('nope');
        assert.ok(!ov.classList.contains('show'), 'unknown chat id is a no-op');
    }, { tags: ['unit'] });

    test('Enter in the input clicks Rename; confirm routes through dispatchChatMeta and refreshes the header', async function() {
        var dispatch = U.recorder(function(id, patch) { s.chats[id].title = patch.title; });
        var s = await setup({ dispatchChatMeta: dispatch });
        s.m.openRenameModal('c1');
        var input = s.dom.$('#rename-chat-input');
        U.input(input, '  Renamed chat  ');
        var primary = s.dom.$('#modal-actions .modal-btn.primary'), clicked = 0;
        primary.addEventListener('click', function() { clicked++; });
        var ev = U.key(input, 'Enter');
        assert.strictEqual(clicked, 1, '230-modals Enter handler clicked the primary button');
        assert.ok(ev.defaultPrevented);
        U.fireInline(primary, 'click', s.m); // the inline onclick the real click would run
        assert.deepStrictEqual(dispatch.calls, [['c1', { title: 'Renamed chat' }]], 'trimmed title');
        assert.strictEqual(s.dom.$('#header-chat-title').textContent, 'Renamed chat');
        assert.ok(!s.dom.$('#modal-overlay').classList.contains('show'));
        assert.strictEqual(s.g.saveChatsToStorage.calls.length, 0, 'lane path does not page-save');
    }, { tags: ['unit'] });

    test('blank name keeps the modal open; legacy path writes title, clears titleProvisional, saves', async function() {
        var s = await setup();
        s.m.openRenameModal('c1');
        U.input(s.dom.$('#rename-chat-input'), '   ');
        U.fireInline(s.dom.$('#modal-actions .modal-btn.primary'), 'click', s.m);
        assert.ok(s.dom.$('#modal-overlay').classList.contains('show'), 'still open');
        assert.strictEqual(s.chats.c1.title, HOSTILE);
        U.input(s.dom.$('#rename-chat-input'), 'Fresh');
        U.fireInline(s.dom.$('#modal-actions .modal-btn.primary'), 'click', s.m);
        assert.strictEqual(s.chats.c1.title, 'Fresh');
        assert.ok(!('titleProvisional' in s.chats.c1));
        assert.strictEqual(s.g.saveChatsToStorage.calls.length, 1);
        assert.strictEqual(s.dom.$('#header-chat-title').textContent, 'Fresh');
    }, { tags: ['unit'] });
});

// ─────────────────────────── Diff viewer ───────────────────────────
describe('ui diff viewer › openDiffViewer / navigateDiffChange', function() {
    afterEach(function() { U.cleanupAll(); var o = document.getElementById('diff-viewer-overlay'); if (o) o.remove(); });
    function lines(n, edits) { var a = []; for (var i = 1; i <= n; i++) a.push((edits && edits[i]) || ('line ' + i)); return a.join('\n'); }
    async function setup(o) {
        o = o || {};
        var vh = await versionEngine();
        var g = { window: winStub(), Platform: { instanceUrl: 'https://inst.example' }, currentChatId: 'c1',
            computeDiff: vh.computeDiff, computeWordDiffsForLines: vh.computeWordDiffsForLines, formatXmlForDiff: vh.formatXmlForDiff, highlightXmlLine: vh.highlightXmlLine,
            getVersionsForFile: function() { return o.versions || []; }, getVersionHistorySources: function() { return o.sources || []; },
            getFirstVersionForRecord: function() { return o.first || null; }, getLatestAfterVersion: function() { return o.latest || null; },
            getHistoricalVersions: U.recorder(function() { return Promise.resolve(o.hist || []); }),
            getVersionXml: function(id) { return o.xmlError ? Promise.reject(new Error(o.xmlError)) : Promise.resolve((o.xml || {})[id] || null); },
            getLatestRecordXml: function() { return Promise.resolve(o.latestXml || null); },
            showSnackbar: U.recorder(), showSpinner: U.recorder(), hideSpinner: U.recorder() };
        var m = await loadLenient(ICONS.concat([ESC, 'src/js/ui/100-diff-viewer.js']), g);
        var dom = await U.mountDom({ html: '', css: ALL_CSS });
        return { m: m, g: g, dom: dom };
    }
    var TWO_HUNKS = {
        versions: [{ versionId: 'v1', label: 'Before <b>', isFromChat: true, timestamp: 1 }, { versionId: 'v2', label: 'After', isFromChat: true, timestamp: 2 }],
        hist: [{ versionId: 'h0', label: 'Hist', isFromChat: false, timestamp: 0 }], latest: 'v2', first: 'v0',
        xml: { v1: lines(20), v2: lines(20, { 2: 'CHANGED 2', 18: 'CHANGED <18>' }) }
    };

    test('opens escaped header + grouped version dropdown + two-hunk diff with stats, separator and hidden context', async function() {
        var s = await setup(TWO_HUNKS);
        await s.m.openDiffViewer('sys_script', 'abc', HOSTILE);
        var ov = document.getElementById('diff-viewer-overlay');
        assert.ok(ov && ov.classList.contains('diff-viewer-overlay'));
        assert.strictEqual(ov.querySelector('.diff-file-name').textContent, HOSTILE);
        noInjection(ov);
        assert.strictEqual(ov.querySelector('a.diff-action-btn').getAttribute('href'), 'https://inst.example/sys_script.do?sys_id=abc');
        assert.strictEqual(ov.querySelector('.diff-header-right').textContent.indexOf('Revert') >= 0, true, 'firstBeforeVersion → Revert');
        var sel = ov.querySelector('#diff-compare-version');
        var opts = Array.prototype.slice.call(sel.options);
        assert.deepStrictEqual(opts.map(function(x) { return x.value; }), ['v2', 'v1', 'h0']);
        assert.ok(opts[0].disabled); assert.strictEqual(opts[0].textContent, 'After (Current)');
        assert.strictEqual(opts[1].textContent, 'Before <b>', 'labels escaped');
        assert.strictEqual(sel.value, 'v1', 'first chat version preselected');
        assert.deepStrictEqual(Array.prototype.map.call(sel.querySelectorAll('optgroup'), function(g) { return g.label; }), ['This Chat', 'Earlier History']);
        assert.deepStrictEqual(s.g.getHistoricalVersions.calls[0], ['sys_script', 'abc', ['v1', 'v2']]);
        assert.strictEqual(ov.querySelector('.diff-stat.add').textContent, '+2');
        assert.strictEqual(ov.querySelector('.diff-stat.remove').textContent, '-2');
        assert.strictEqual(ov.querySelectorAll('[data-hunk-start]').length, 2);
        assert.strictEqual(ov.querySelector('#diff-nav-counter').textContent, '1 / 2');
        assert.ok(ov.querySelector('.diff-separator'), 'gap between hunks collapsed');
        assert.ok(ov.querySelectorAll('.diff-line.diff-hidden').length > 0);
        var added = Array.prototype.map.call(ov.querySelectorAll('.diff-line.diff-add .diff-text'), function(e) { return e.textContent; });
        assert.ok(added.indexOf('CHANGED <18>') >= 0, 'diff text escaped, not parsed');
        assert.strictEqual(ov.querySelectorAll('.diff-text b, .diff-text i').length, 0);
    }, { tags: ['unit'] });

    test('next/prev buttons scroll to each hunk, wrap at both bounds; focus toggle; empty list is a no-op', async function() {
        var s = await setup(TWO_HUNKS);
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        var ov = document.getElementById('diff-viewer-overlay');
        var hunks = Array.prototype.slice.call(ov.querySelectorAll('[data-hunk-start]')), scrolled = [];
        hunks.forEach(function(h, i) { h.scrollIntoView = function() { scrolled.push(i); }; });
        var navBtns = ov.querySelectorAll('.diff-nav .diff-nav-btn'), prev = navBtns[0], next = navBtns[1], counter = ov.querySelector('#diff-nav-counter');
        assert.strictEqual(prev.getAttribute('title'), 'Previous change');
        U.fireInline(next, 'click', s.m);
        assert.strictEqual(counter.textContent, '2 / 2');
        U.fireInline(next, 'click', s.m);
        assert.strictEqual(counter.textContent, '1 / 2', 'wraps past the last hunk');
        U.fireInline(prev, 'click', s.m);
        assert.strictEqual(counter.textContent, '2 / 2', 'wraps before the first hunk');
        assert.deepStrictEqual(scrolled, [1, 0, 1]);
        var container = ov.querySelector('.diff-container'), focus = ov.querySelector('#diff-focus-toggle');
        assert.ok(container.classList.contains('diff-focused'));
        U.fireInline(focus, 'click', s.m);
        assert.ok(!container.classList.contains('diff-focused')); assert.ok(!focus.classList.contains('active'));
        s.m.__scope.diffChangeElements = [];
        s.m.navigateDiffChange(1);
        assert.strictEqual(counter.textContent, '2 / 2', 'no hunks → untouched');
    }, { tags: ['unit'] });

    test('close button, backdrop click (not modal click) remove the overlay and clear state', async function() {
        var s = await setup(TWO_HUNKS);
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        var ov = document.getElementById('diff-viewer-overlay');
        ov.querySelector('.diff-viewer-modal').click();
        assert.ok(document.getElementById('diff-viewer-overlay'), 'click inside modal keeps it');
        ov.click();
        assert.strictEqual(document.getElementById('diff-viewer-overlay'), null, 'backdrop closes');
        assert.strictEqual(s.m.__scope.currentDiffFile, null);
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        U.fireInline(document.querySelector('#diff-viewer-overlay .diff-close-btn'), 'click', s.m);
        assert.strictEqual(document.getElementById('diff-viewer-overlay'), null);
    }, { tags: ['unit'] });

    test('empty states: no comparable versions + no data; preview mode; identical versions; load error escaped; new record → Delete', async function() {
        var s = await setup({ versions: [], latestXml: null });
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        var ov = document.getElementById('diff-viewer-overlay');
        assert.strictEqual(ov.querySelector('.diff-no-compare').textContent, 'No earlier version to compare against');
        assert.strictEqual(ov.querySelector('#diff-compare-version'), null);
        assert.strictEqual(ov.querySelector('.diff-error').textContent, 'Could not load record data.');
        assert.strictEqual(ov.querySelector('.diff-nav'), null);
        s.m.closeDiffViewer();

        var p = await setup({ versions: [], latestXml: 'a\nb\nc', sources: [{ chatId: 'c1', entries: [{ chatId: 'c1', table: 'sys_script', sysId: 'abc', action: 'POST' }] }] });
        await p.m.openDiffViewer('sys_script', 'abc', 'Rec');
        ov = document.getElementById('diff-viewer-overlay');
        assert.ok(ov.querySelector('.diff-container.diff-preview'));
        assert.strictEqual(ov.querySelector('.diff-preview-label').textContent, ov.querySelectorAll('.diff-preview .diff-line').length + ' lines');
        assert.ok(ov.querySelector('.diff-action-btn.danger'), 'new record offers Delete');
        p.m.closeDiffViewer();

        var same = await setup({ versions: TWO_HUNKS.versions, latest: 'v2', xml: { v1: lines(5), v2: lines(5) } });
        await same.m.openDiffViewer('sys_script', 'abc', 'Rec');
        ov = document.getElementById('diff-viewer-overlay');
        assert.strictEqual(ov.querySelector('.diff-stat.add').textContent, '+0');
        assert.strictEqual(ov.querySelector('.diff-nav'), null, 'no hunks → no navigation');
        same.m.closeDiffViewer();

        var err = await setup({ versions: TWO_HUNKS.versions, latest: 'v2', xmlError: HOSTILE });
        await err.m.openDiffViewer('sys_script', 'abc', 'Rec');
        ov = document.getElementById('diff-viewer-overlay');
        assert.strictEqual(ov.querySelector('.diff-error').textContent, 'Failed to load version data: ' + HOSTILE);
        noInjection(ov);
    }, { tags: ['unit'] });
});

// ─────────────────────────── Workspace files sidebar ───────────────────────────
describe('ui workspace files › renderWorkspaceFilesSection', function() {
    afterEach(function() {
        Array.prototype.slice.call(document.querySelectorAll('.wsf-overlay')).forEach(function(o) { o._wsfClose ? o._wsfClose() : o.remove(); });
        U.cleanupAll();
    });
    var n = 0;
    function call(action, a, result) {
        var id = 'tc' + (++n);
        return [{ role: 'assistant', tool_calls: [{ id: id, function: { name: 'workspace', arguments: JSON.stringify(Object.assign({ action: action }, a)) } }] },
            { role: 'tool', tool_call_id: id, content: JSON.stringify(result || { success: true, message: 'Edited' }) }];
    }
    function chatOf(parts) { return { id: 'c1', messages: [].concat.apply([], parts) }; }
    async function setup(o) {
        o = o || {};
        var vh = await versionEngine();
        var g = { window: winStub(), currentChatId: 'c1', showSnackbar: U.recorder(), renderVersionSidebar: U.recorder(),
            getSubAgentChatsForChat: function() { return o.subs || []; },
            getAllWorkspaceMetas: function() { return Promise.resolve(o.metas || []); },
            getWorkspaceFile: function(ws, p) { return Promise.resolve((o.files || {})[p] || null); },
            getWorkspaceBlobsBySha: function() { return Promise.resolve({}); },
            computeDiff: vh.computeDiff, computeWordDiffsForLines: vh.computeWordDiffsForLines };
        var m = await loadLenient(ICONS.concat([ESC, 'src/js/ui/115-workspace-files-sidebar.js']), g);
        var dom = await U.mountDom({ html: '<div id="wsf-host"></div>', css: ALL_CSS });
        return { m: m, g: g, dom: dom, host: dom.$('#wsf-host') };
    }
    function render(s, chat) { s.host.innerHTML = s.m.renderWorkspaceFilesSection(chat); return s.host; }

    test('empty state: no chat / no mutating calls / failed or read-only calls render nothing', async function() {
        var s = await setup();
        assert.strictEqual(s.m.renderWorkspaceFilesSection(null), '');
        assert.strictEqual(s.m.renderWorkspaceFilesSection({ messages: [] }), '');
        var c = chatOf([call('read', { path: 'a.js' }), call('write', { path: 'b.js' }, { success: false, error: 'x' }), call('discard', {})]);
        assert.strictEqual(s.m.renderWorkspaceFilesSection(c), '');
        assert.deepStrictEqual(s.m.__scope._wsfSectionFiles, []);
    }, { tags: ['unit'] });

    test('rows: name/dir/workspace chip, NEW/MODIFIED/DELETED/DISCARDED/MERGED badges, change count, worker chips, escaping', async function() {
        var hostilePath = 'x/' + HOSTILE.replace(/\//g, '_') + '.js';
        var metas = [{ repo: 'example-org/AppAgent::main', github_repo: 'example-org/AppAgent', prs: [{ number: 7, state: 'merged', merged_at: '2026-01-01', files: [{ path: 'src/merged.js' }] }] }];
        var s = await setup({ metas: metas, subs: [{ chat: chatOf([call('edit', { path: 'src/worker.js' })]), name: HOSTILE }] });
        var chat = chatOf([call('edit', { path: 'src/a.js', workspace: 'example-org/AppAgent::main' }), call('edit', { path: 'src/a.js' }),
            call('write', { path: 'src/new.js' }, { success: true, message: 'Created src/new.js' }), call('delete', { path: 'old.js' }),
            call('discard', { path: 'src/d.js' }), call('edit', { path: 'src/merged.js' }), call('copy', { path: 'src/a.js', dest: hostilePath })]);
        render(s, chat);
        await U.flush(); await U.flush();
        assert.ok(s.g.renderVersionSidebar.calls.length >= 1, 'merged-snapshot load triggers one re-render');
        var host = render(s, chat);
        assert.strictEqual(host.querySelector('.version-section-title').textContent, 'Workspace Files (7)');
        var cards = Array.prototype.slice.call(host.querySelectorAll('.wsf-card'));
        var badge = function(c) { return c.querySelector('.sn-status-badge').textContent; };
        assert.deepStrictEqual(cards.map(function(c) { return c.querySelector('.sn-artifact-name').textContent; }),
            ['a.js', 'new.js', 'old.js', 'd.js', 'merged.js', HOSTILE.replace(/\//g, '_') + '.js', 'worker.js']);
        assert.deepStrictEqual(cards.map(badge), ['MODIFIED', 'NEW', 'DELETED', 'DISCARDED', 'MERGED', 'MODIFIED', 'MODIFIED']);
        assert.strictEqual(cards[4].querySelector('.sn-status-merged').getAttribute('title'), 'Merged in PR #7');
        assert.strictEqual(cards[0].querySelector('.sn-changes-badge').textContent, '2 changes');
        assert.strictEqual(cards[1].querySelector('.sn-changes-badge'), null);
        assert.strictEqual(cards[0].querySelector('.wsf-dir').textContent, 'src');
        assert.strictEqual(cards[2].querySelector('.wsf-dir'), null, 'root file has no dir chip');
        assert.strictEqual(cards[0].querySelector('.wsf-ws').textContent, 'AppAgent::main', 'first explicit wsKey backfilled');
        assert.strictEqual(cards[5].getAttribute('title'), hostilePath, 'copy is attributed to dest; full path as tooltip');
        var chip = cards[6].querySelector('.wsf-ws');
        assert.strictEqual(chip.textContent, HOSTILE); assert.strictEqual(chip.getAttribute('title'), 'Edited by worker ' + HOSTILE);
        noInjection(host);
        assert.deepStrictEqual(cards.map(function(c) { return c.getAttribute('onclick'); }).slice(0, 2), ['wsfOpenDiff(0)', 'wsfOpenDiff(1)'], 'index-based routing');
        assert.notStrictEqual(U.css(cards[1].querySelector('.sn-status-badge'), 'background-color'), U.css(cards[2].querySelector('.sn-status-badge'), 'background-color'), 'NEW and DELETED badges styled differently');
    }, { tags: ['unit'] });

    test('row click opens the diff modal (escaped title, counter, stats); Esc closes; ArrowRight switches file; missing file → snackbar', async function() {
        var s = await setup({ files: { 'src/a.js': { dirty: true, original_content: 'one\ntwo', content: 'one\n<b>2</b>' }, 'src/b.js': { dirty: false, original_content: 'same', content: 'same' } } });
        var host = render(s, chatOf([call('edit', { path: 'src/a.js', workspace: WS }), call('edit', { path: 'src/b.js', workspace: WS }), call('edit', { path: 'gone.js', workspace: WS })]));
        var cards = host.querySelectorAll('.wsf-card');
        U.fireInline(cards[0], 'click', s.m); await U.flush(); await U.flush();
        var ov = document.querySelectorAll('.wsf-overlay');
        assert.strictEqual(ov.length, 1);
        ov = ov[0];
        assert.ok(ov.querySelector('.wsf-modal-title').textContent.indexOf('src/a.js') === 0);
        assert.strictEqual(ov.querySelector('.wsf-nav-counter').textContent, '1 / 3');
        assert.ok(ov.querySelector('.wsf-modal-nav button').disabled, 'prev disabled on the first file');
        assert.strictEqual(ov.querySelector('.wsf-diff-add').textContent, '+1');
        assert.strictEqual(ov.querySelectorAll('.diff-line.diff-add b').length, 0, 'content escaped');
        assert.ok(ov.querySelector('.wsf-modal-actions .active').getAttribute('onclick').indexOf("'diff'") > 0, 'diff action highlighted');
        U.key(document.body, 'ArrowRight');
        await U.flush(); await U.flush();
        var all = document.querySelectorAll('.wsf-overlay');
        assert.strictEqual(all.length, 1, 'old overlay closed after the new one mounted');
        assert.strictEqual(all[0].querySelector('.wsf-nav-counter').textContent, '2 / 3');
        assert.ok(all[0].querySelector('.wsf-empty').textContent === 'No differences');
        U.key(document.body, 'Escape');
        assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 0, 'Escape closes');
        U.key(document.body, 'Escape'); // listener detached — no throw
        U.fireInline(cards[2], 'click', s.m); await U.flush(); await U.flush();
        assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 0);
        assert.ok(/"gone\.js" not found/.test(s.g.showSnackbar.calls[0][0]));
    }, { tags: ['unit'] });
});

// ─────────────────────────── Worker chat modal ───────────────────────────
describe('ui workers › worker chat-view modal', function() {
    afterEach(function() { U.cleanupAll(); detachDocListeners(); });
    async function setup(msgs) {
        var rec = { agent_id: 'sub_1', name: 'W', state: 'running', parent_chat_id: 'c1', root_chat_id: 'c1', chat_id: 'sc1', tool_calls_used: 1, depth: 1, last_activity_at: 1 };
        var reg = { listAll: function() { return [rec]; }, getById: function(id) { return id === 'sub_1' ? rec : null; }, addListener: U.recorder(), removeListener: U.recorder() };
        var g = { window: winStub(), SubAgents: reg, chats: { c1: { id: 'c1', title: 'Root', messages: msgs || [] } }, currentChatId: 'c1', selectChat: U.recorder(), screenshotNav: { list: [], index: -1 }, screenshotModalKeyHandler: function() {},
            getAssumedContextTokens: function() { return 200000; }, requestAnimationFrame: function(f) { f(); return 1; } };
        var m = await loadCapturing(ICONS.concat([ESC, 'src/js/ui/175-sub-agent-ui.js', 'src/js/ui/220-notification-system.js']), g);
        var dom = await U.mountDom({ body: true, css: ALL_CSS });
        return { m: m, g: g, reg: reg, dom: dom };
    }
    var REPORT = { role: 'sub_report', subAgentId: 'sub_1', subAgentName: HOSTILE, report: { status: 'done', summary: 'All **good**' } };

    test('opens from a data-worker-modal link (delegated click), escaped title, forced-open card; close tears down', async function() {
        var s = await setup([REPORT]);
        var link = document.createElement('button'); link.setAttribute('data-worker-modal', 'sub_1');
        s.dom.root.appendChild(link);
        var add0 = s.reg.addListener.calls.length;
        link.click();
        var ov = s.dom.$('#modal-overlay');
        assert.ok(ov.classList.contains('show') && ov.classList.contains('worker-chat-modal'));
        assert.strictEqual(s.dom.$('#modal-header .modal-title-text').textContent, HOSTILE);
        noInjection(s.dom.$('#modal-header'));
        var det = s.dom.$('#modal-body details.sub-report');
        assert.ok(det && det.open, 'card forced open inside the modal');
        assert.strictEqual(s.dom.$('#modal-actions').innerHTML, '');
        assert.strictEqual(s.reg.addListener.calls.length - add0, 1, 'live-refresh listener attached');
        U.fireInline(s.dom.$('#modal-header .modal-close-icon'), 'click', s.m);
        assert.ok(!ov.classList.contains('show') && !ov.classList.contains('worker-chat-modal'));
        assert.strictEqual(s.reg.removeListener.calls.length, 1, 'listener detached on close');
        assert.strictEqual(s.m.__scope._workerModalAgentId, null);
    }, { tags: ['unit'] });

    test('no sub_report message → modal stays closed', async function() {
        var s = await setup([]);
        var add0 = s.reg.addListener.calls.length;
        s.m.openWorkerChatModal('sub_1');
        assert.ok(!s.dom.$('#modal-overlay').classList.contains('show'));
        assert.strictEqual(s.reg.addListener.calls.length - add0, 0);
    }, { tags: ['unit'] });
});
