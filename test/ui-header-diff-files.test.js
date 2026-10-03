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
// Mirrors core/130-indexeddb.js chatMessageCount (skeleton-aware count; module not loaded here).
function chatMsgCount(c) { return !c ? 0 : (Array.isArray(c.messages) ? c.messages.length : (c._msgCount || 0)); }
function loadLenient(paths, globals) {
    if (!('chatMessageCount' in globals)) globals.chatMessageCount = chatMsgCount;
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

    // A7B-02: renaming from a History card left the card on the old title
    // (only the sidebar + header were repainted).
    test('A7B-02 rename while History is open repaints History', async function() {
        async function renameIn(view) {
            var rh = U.recorder();
            var s = await setup({ dispatchChatMeta: U.recorder(function(id, p) { s.chats[id].title = p.title; }), renderHistoryPage: rh, currentView: view });
            s.m.openRenameModal('c1');
            U.input(s.dom.$('#rename-chat-input'), 'Renamed');
            U.fireInline(s.dom.$('#modal-actions .modal-btn.primary'), 'click', s.m);
            assert.strictEqual(s.chats.c1.title, 'Renamed', view + ': renamed');
            U.cleanupAll(); detachDocListeners();
            return rh.calls.length;
        }
        assert.strictEqual(await renameIn('history'), 1, 'History open: repainted once');
        assert.strictEqual(await renameIn('chat'), 0, 'chat view: no History repaint');
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
            getHistoricalVersions: U.recorder(o.getHistoricalVersions || function() { return Promise.resolve(o.hist || []); }),
            getVersionXml: o.getVersionXml || function(id) { return o.xmlError ? Promise.reject(new Error(o.xmlError)) : Promise.resolve((o.xml || {})[id] || null); },
            getLatestRecordXml: o.getLatestRecordXml || function() { return Promise.resolve(o.latestXml || null); },
            showSnackbar: U.recorder(), showSpinner: U.recorder(), hideSpinner: U.recorder() };
        Object.assign(g, o.globals || {}); // per-test extra stubs (prettyPrintXml, URL, Blob)
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

    // TA4-1: a click closes only when its mousedown ALSO started on the backdrop, so a
    // text-selection drag from the modal released on the backdrop keeps the viewer open.
    // A browser (isTrusted) click cannot be synthesized, so it is passed to onclick as a
    // trusted-shaped event; the Esc-sweep replay ({target: ov}) and .click() are untrusted.
    test('TA4-1: a drag from the modal released on the backdrop keeps it open; a backdrop press + click, the Esc replay and .click() close', async function() {
        var s = await setup(TWO_HUNKS);
        async function open() { await s.m.openDiffViewer('sys_script', 'abc', 'Rec'); return document.getElementById('diff-viewer-overlay'); }
        function press(el) { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); }
        var ov = await open(), modal = ov.querySelector('.diff-viewer-modal');
        press(modal);
        ov.onclick({ target: ov, isTrusted: true });
        assert.ok(ov.isConnected, 'mousedown on the modal + trusted backdrop click keeps it open');
        assert.ok(s.m.__scope.currentDiffFile, 'viewer state kept');
        press(ov);
        ov.onclick({ target: modal, isTrusted: true });
        assert.ok(ov.isConnected, 'a click that lands inside the modal never closes');
        ov.onclick({ target: ov, isTrusted: true });
        assert.strictEqual(document.getElementById('diff-viewer-overlay'), null, 'mousedown + click on the backdrop closes');
        assert.strictEqual(s.m.__scope.currentDiffFile, null);
        ov = await open();
        press(ov.querySelector('.diff-viewer-modal'));
        ov.onclick({ target: ov }); // global Esc sweep replay: plain object, not isTrusted
        assert.strictEqual(document.getElementById('diff-viewer-overlay'), null, 'Esc replay still closes');
        ov = await open();
        press(ov.querySelector('.diff-viewer-modal'));
        ov.click(); // programmatic, untrusted
        assert.strictEqual(document.getElementById('diff-viewer-overlay'), null, 'programmatic .click() still closes');
    }, { tags: ['unit'] });

    // TA4-5: a re-open REPLACES the viewer. A stacked second #diff-viewer-overlay was
    // unreachable (getElementById in updateDiffView/closeDiffViewer only sees the first,
    // stale copy), so one close left an overlay behind. The sandbox iframe is 0x0, so a
    // real focus() never moves activeElement: like ui-settings.test.js simFocus(), the
    // shim records the connected element focus() was called on.
    test('TA4-5: re-opening (after load and mid-fetch) leaves exactly one focused overlay for the new record; close leaves none', async function() {
        var cur = null, proto = HTMLElement.prototype, origFocus = proto.focus;
        function overlays() { return document.querySelectorAll('#diff-viewer-overlay'); }
        proto.focus = function() { if (document.contains(this)) cur = this; };
        Object.defineProperty(document, 'activeElement', { configurable: true,
            get: function() { return cur && document.contains(cur) ? cur : document.body; } });
        try {
            var s = await setup(TWO_HUNKS);
            await s.m.openDiffViewer('sys_script', 'abc', 'First');
            var first = document.getElementById('diff-viewer-overlay');
            assert.strictEqual(document.activeElement, first, 'the opened viewer takes focus');
            await s.m.openDiffViewer('sys_script', 'def', 'Second');
            assert.strictEqual(overlays().length, 1, 'a re-open replaces the viewer instead of stacking a second overlay');
            assert.strictEqual(first.isConnected, false, 'the first overlay is gone');
            var ov = overlays()[0];
            assert.strictEqual(ov.querySelector('.diff-file-name').textContent, 'Second');
            assert.strictEqual(ov.querySelectorAll('[data-hunk-start]').length, 2, 'the new viewer rendered its own diff');
            assert.strictEqual(document.activeElement, ov, 'focus moved to the new viewer');
            s.m.closeDiffViewer();
            assert.strictEqual(overlays().length, 0, 'one close leaves no overlay behind');
            assert.strictEqual(s.m.__scope.currentDiffFile, null);
            // Re-open while the first open is still awaiting its history fetch.
            var p1 = s.m.openDiffViewer('sys_script', 'abc', 'First');
            await s.m.openDiffViewer('sys_script', 'def', 'Second');
            await p1;
            assert.strictEqual(overlays().length, 1, 'mid-fetch re-open: still one overlay');
            assert.strictEqual(overlays()[0].querySelector('.diff-file-name').textContent, 'Second');
            assert.strictEqual(overlays()[0].querySelectorAll('[data-hunk-start]').length, 2);
            s.m.closeDiffViewer();
            assert.strictEqual(overlays().length, 0);
        } finally {
            proto.focus = origFocus; delete document.activeElement;
            Array.prototype.forEach.call(overlays(), function(o) { o.remove(); });
        }
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

    // A3B3-02: closeDiffViewer() nulls currentDiffFile while Download's fetch is in
    // flight; the download must still finish under the record it was started for.
    test('Download survives closing the viewer mid-fetch', async function() {
        var pending = [], blobs = [], created = [], revoked = [], downloads = [];
        var getLatest = U.recorder(function() { return new Promise(function(resolve) { pending.push(resolve); }); });
        var s = await setup(Object.assign({}, TWO_HUNKS, { getLatestRecordXml: getLatest, globals: {
            prettyPrintXml: function(x) { return x; },
            Blob: function(parts) { blobs.push(parts.join('')); },
            URL: { createObjectURL: function(b) { created.push(b); return 'blob:zz'; }, revokeObjectURL: function(u) { revoked.push(u); } }
        } }));
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        var proto = HTMLAnchorElement.prototype, hadOwn = Object.prototype.hasOwnProperty.call(proto, 'click'), origClick = proto.click;
        proto.click = function() { downloads.push(this.download); }; // record instead of saving a file
        try {
            var dl = s.m.downloadFromDiffViewer();
            assert.deepStrictEqual(getLatest.calls, [['sys_script', 'abc']]);
            s.m.closeDiffViewer();
            assert.strictEqual(document.getElementById('diff-viewer-overlay'), null);
            assert.strictEqual(s.m.__scope.currentDiffFile, null);
            pending[0]('<rec>1</rec>');
            await dl;
        } finally {
            if (hadOwn) proto.click = origClick; else delete proto.click;
        }
        var snacks = s.g.showSnackbar.calls;
        assert.deepStrictEqual(snacks.filter(function(c) { return c[1] === 'error'; }), [], 'no error toast');
        assert.deepStrictEqual(downloads, ['Rec.xml']);
        assert.deepStrictEqual(blobs, ['<rec>1</rec>']);
        assert.strictEqual(created.length, 1);
        assert.deepStrictEqual(revoked, ['blob:zz']);
        assert.deepStrictEqual(snacks, [['Downloaded Rec', 'success']]);
        assert.strictEqual(s.g.hideSpinner.calls.length, 1);
    }, { tags: ['unit'] });

    // A3B3-01: updateDiffView awaits uncached fetches; only the newest call may write.
    // gatedXml: a getVersionXml whose ids can be held open (gate) and resolved/rejected later.
    function gatedXml(xml) {
        var gates = {};
        return {
            gate: function(id) { var g = {}; g.p = new Promise(function(res, rej) { g.res = res; g.rej = rej; }); gates[id] = g; return g; },
            get: function(id) { var v = xml[id] || null, g = gates[id]; delete gates[id]; return g ? g.p.then(function() { return v; }) : Promise.resolve(v); }
        };
    }
    var XML3 = Object.assign({ h0: lines(20, { 2: 'CHANGED 2', 10: 'OLD 10', 18: 'CHANGED <18>' }) }, TWO_HUNKS.xml); // h0 → v2: 1 hunk, +1/-1
    function diffState(s) {
        var ov = document.getElementById('diff-viewer-overlay'), els = s.m.__scope.diffChangeElements;
        return { add: ov.querySelector('.diff-stat.add').textContent, remove: ov.querySelector('.diff-stat.remove').textContent,
            counter: ov.querySelector('#diff-nav-counter').textContent, error: !!ov.querySelector('.diff-error'), hunks: ov.querySelectorAll('[data-hunk-start]').length,
            nav: els.length, navConnected: Array.prototype.every.call(els, function(e) { return e.isConnected; }) };
    }
    var H0_STATE = { add: '+1', remove: '-1', counter: '1 / 1', error: false, hunks: 1, nav: 1, navConnected: true };

    test('stale compare fetch does not overwrite a newer selection', async function() {
        var gx = gatedXml(XML3);
        var s = await setup(Object.assign({}, TWO_HUNKS, { xml: XML3, getVersionXml: gx.get }));
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        var sel = document.getElementById('diff-compare-version');
        // A (v1: +2/-2, 2 hunks) is still in flight when B (h0: +1/-1, 1 hunk) completes
        var gA = gx.gate('v1'), gB = gx.gate('h0');
        sel.value = 'v1'; var a = s.m.updateDiffView();
        sel.value = 'h0'; var b = s.m.updateDiffView();
        gB.res(); await b;
        assert.deepStrictEqual(diffState(s), H0_STATE);
        gA.res(); await a;
        assert.deepStrictEqual(diffState(s), H0_STATE, 'the older call resolved last but wrote nothing');
        // a stale rejection must not replace the newer diff with an error either
        gA = gx.gate('v1'); gB = gx.gate('h0');
        sel.value = 'v1'; a = s.m.updateDiffView();
        sel.value = 'h0'; b = s.m.updateDiffView();
        gB.res(); await b;
        gA.rej(new Error('late <boom>')); await a;
        assert.deepStrictEqual(diffState(s), H0_STATE, 'stale error not shown');
    }, { tags: ['unit'] });

    test('closing or reopening the viewer mid-fetch: the stale call writes nothing and does not throw', async function() {
        var gx = gatedXml(XML3);
        var s = await setup(Object.assign({}, TWO_HUNKS, { xml: XML3, getVersionXml: gx.get }));
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        var content = document.getElementById('diff-viewer-content'), navBefore = s.m.__scope.diffChangeElements;
        var g = gx.gate('h0');
        document.getElementById('diff-compare-version').value = 'h0';
        var a = s.m.updateDiffView();
        s.m.closeDiffViewer();
        g.res(); await a;
        assert.ok(content.querySelector('.diff-loading'), 'the closed viewer is left as it was');
        assert.strictEqual(s.m.__scope.diffChangeElements, navBefore, 'navigation state untouched');
        // close + reopen mid-fetch: the new viewer keeps its own diff and working navigation
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        g = gx.gate('h0');
        document.getElementById('diff-compare-version').value = 'h0';
        a = s.m.updateDiffView();
        s.m.closeDiffViewer();
        await s.m.openDiffViewer('sys_script', 'abc', 'Rec'); // v1 preselected: +2/-2, 2 hunks
        g.res(); await a;
        var st = diffState(s);
        assert.deepStrictEqual([st.add, st.counter, st.hunks, st.nav, st.navConnected], ['+2', '1 / 2', 2, 2, true]);
        s.m.navigateDiffChange(1);
        assert.strictEqual(document.getElementById('diff-nav-counter').textContent, '2 / 2');
        s.m.closeDiffViewer();
        // preview mode (no comparable versions): the record fetch resolves / rejects after close
        var pend = [];
        var getLatest = U.recorder(function() { return new Promise(function(res, rej) { pend.push({ res: res, rej: rej }); }); });
        var p = await setup({ versions: [], getLatestRecordXml: getLatest });
        for (var round = 0; round < 2; round++) {
            var op = p.m.openDiffViewer('sys_script', 'abc', 'Rec');
            for (var i = 0; i < 50 && pend.length <= round; i++) await Promise.resolve();
            assert.strictEqual(pend.length, round + 1, 'record fetch in flight');
            var pc = document.getElementById('diff-viewer-content');
            p.m.closeDiffViewer();
            if (round === 0) pend[0].res('<rec/>'); else pend[1].rej(new Error('late'));
            await op;
            assert.ok(pc.querySelector('.diff-loading'), 'the closed preview is left as it was (round ' + round + ')');
        }
    }, { tags: ['unit'] });

    test('closing or reopening the viewer while historical versions load: the stale open neither throws nor rewrites the new dropdown', async function() {
        // RC7B1B-F1: openDiffViewer awaited getHistoricalVersions with no guard, so a close
        // mid-fetch threw on the nulled currentDiffFile, and a close + reopen let the stale
        // open rewrite the new viewer's version dropdown.
        var pend = [];
        var s = await setup(Object.assign({}, TWO_HUNKS, { getHistoricalVersions: function() { return new Promise(function(r) { pend.push(r); }); } }));
        // (a) close mid-await
        var op = s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        assert.strictEqual(pend.length, 1, 'history fetch in flight');
        s.m.closeDiffViewer();
        pend[0]([]);
        await op; // before the fix: TypeError on currentDiffFile.allVersions
        assert.strictEqual(document.getElementById('diff-viewer-overlay'), null, 'the closed viewer stays closed');
        // (b) close and reopen mid-await: the new open's fetch resolves first, the stale one last
        var op1 = s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        s.m.closeDiffViewer();
        var op2 = s.m.openDiffViewer('sys_script', 'abc', 'Rec');
        assert.strictEqual(pend.length, 3, 'both history fetches in flight');
        pend[2](TWO_HUNKS.hist);
        await op2;
        pend[1]([{ versionId: 'hOld', label: 'Stale', isFromChat: false, timestamp: 0 }]);
        await op1;
        var sel = document.getElementById('diff-compare-version');
        assert.deepStrictEqual(Array.prototype.map.call(sel.options, function(x) { return x.value; }), ['v2', 'v1', 'h0']);
        assert.deepStrictEqual(s.m.__scope.currentDiffFile.allVersions.map(function(v) { return v.versionId; }), ['h0', 'v1', 'v2']);
        s.m.closeDiffViewer();
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
        Object.assign(g, o.globals || {}); // per-test extra stubs (chats, showConfirmModal, executeWorkspaceTool, spinners)
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

    test('A3C2-02: Esc under an open Restore/Discard confirm closes only the confirm; arrows are ignored while it is open', async function() {
        var s = await setup({ files: { 'src/a.js': { dirty: true, original_content: 'one\ntwo', content: 'one\n2' }, 'src/b.js': { dirty: false, original_content: 'same', content: 'same' } } });
        var host = render(s, chatOf([call('edit', { path: 'src/a.js', workspace: WS }), call('edit', { path: 'src/b.js', workspace: WS }), call('edit', { path: 'gone.js', workspace: WS })]));
        s.host.insertAdjacentHTML('afterend', '<div id="modal-overlay" class="modal-overlay"></div>');
        var mo = s.dom.$('#modal-overlay');
        // Mimics 120-init's Esc ladder step 1: a bubble-phase document listener,
        // registered BEFORE the overlay opens, that closes #modal-overlay.show.
        function ladder(e) { if (e.key === 'Escape' && mo.classList.contains('show')) mo.classList.remove('show'); }
        document.addEventListener('keydown', ladder);
        var keydowns = [], origAdd = document.addEventListener, origRem = document.removeEventListener;
        function spy(kind, orig) { return function(t, f, o) { if (t === 'keydown') keydowns.push([kind, f, o === true || !!(o && o.capture)]); return orig.call(document, t, f, o); }; }
        document.addEventListener = spy('add', origAdd); document.removeEventListener = spy('remove', origRem);
        try {
            U.fireInline(host.querySelectorAll('.wsf-card')[0], 'click', s.m); await U.flush(); await U.flush();
            assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 1);
            mo.classList.add('show'); // the Restore/Discard confirm opens above the overlay
            U.key(document.body, 'Escape');
            assert.ok(!mo.classList.contains('show'), 'Esc closes the confirm');
            assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 1, 'the same Esc must not also close the overlay under it');
            mo.classList.add('show');
            U.key(document.body, 'ArrowRight'); await U.flush(); await U.flush();
            assert.strictEqual(document.querySelector('.wsf-overlay .wsf-nav-counter').textContent, '1 / 3', 'arrows do not switch files under the confirm');
            mo.classList.remove('show');
            U.key(document.body, 'Escape');
            assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 0, 'with no confirm open, Esc closes the overlay');
            var adds = keydowns.filter(function(k) { return k[0] === 'add'; });
            assert.ok(adds.length >= 1, 'the overlay registered a keydown listener');
            adds.forEach(function(a) {
                assert.ok(keydowns.some(function(r) { return r[0] === 'remove' && r[1] === a[1] && r[2] === a[2]; }), 'close() detaches the keydown listener with the same capture flag');
            });
        } finally {
            document.addEventListener = origAdd; document.removeEventListener = origRem;
            document.removeEventListener('keydown', ladder);
        }
    }, { tags: ['unit'] });

    test('A3C-01: Prev/Next onto a file no local workspace holds shows a "not found" placeholder that keeps the nav; closing meanwhile wins', async function() {
        var s = await setup({ files: { 'src/a.js': { dirty: true, original_content: 'one', content: 'two' }, 'src/c.js': { dirty: true, original_content: 'c1', content: 'c2' } } });
        var host = render(s, chatOf([call('edit', { path: 'src/a.js', workspace: WS }), call('edit', { path: 'gone.js', workspace: WS }), call('edit', { path: 'src/c.js', workspace: WS })]));
        async function key(k) { U.key(document.body, k); await U.flush(); await U.flush(); }
        function ovs() { return document.querySelectorAll('.wsf-overlay'); }
        function counter() { return ovs()[0].querySelector('.wsf-nav-counter').textContent; }
        U.fireInline(host.querySelectorAll('.wsf-card')[0], 'click', s.m); await U.flush(); await U.flush();
        assert.strictEqual(ovs().length, 1);
        await key('ArrowRight');
        assert.strictEqual(ovs().length, 1, 'navigating onto a missing file keeps an overlay open');
        assert.strictEqual(counter(), '2 / 3');
        assert.match(ovs()[0].querySelector('.wsf-empty').textContent, /not found/);
        assert.match(s.g.showSnackbar.calls[0][0], /"gone\.js" not found/);
        await key('ArrowRight');
        assert.strictEqual(ovs().length, 1); assert.strictEqual(counter(), '3 / 3');
        assert.strictEqual(ovs()[0].querySelector('.wsf-modal-title').textContent.indexOf('src/c.js'), 0);
        await key('ArrowLeft'); await key('ArrowLeft');
        assert.strictEqual(ovs().length, 1); assert.strictEqual(counter(), '1 / 3');
        U.key(document.body, 'ArrowRight'); U.key(document.body, 'Escape'); // closed before the lookup resolves
        await U.flush(); await U.flush();
        assert.strictEqual(ovs().length, 0, 'no placeholder after the user closed the overlay');
    }, { tags: ['unit'] });

    // A3C2-03: Restore must never fall back to the DEFAULT workspace.
    function restoreStubs(chat) {
        return { chats: { c1: chat }, showSpinner: U.recorder(), hideSpinner: U.recorder(),
            showConfirmModal: U.recorder(function() { return Promise.resolve(true); }),
            executeWorkspaceTool: U.recorder(function() { return Promise.resolve({ success: true }); }) };
    }
    test('A3C2-03: a file no local workspace holds (none recorded) offers no Restore, says why, and never writes into the default workspace', async function() {
        var chat = chatOf([call('write', { path: 'gone.txt', content: 'v1' })]);
        var st = restoreStubs(chat);
        var s = await setup({ metas: [{ repo: 'o/r::main' }], files: {}, globals: st });
        render(s, chat);
        assert.strictEqual(await s.m.wsfOpenVersions(0), true);
        var ov = document.querySelector('.wsf-overlay');
        assert.strictEqual(ov.querySelectorAll('.wsf-ver-row').length, 2, 'base + the write');
        assert.strictEqual(ov.querySelectorAll('button[title^="Restore this version"]').length, 0, 'no Restore without a known workspace');
        assert.match(ov.textContent, /Restore is unavailable: no local workspace is known for this file/);
        await s.m.wsfRestoreVersion(1); // stale handler / direct call
        assert.strictEqual(st.showConfirmModal.calls.length, 0);
        assert.strictEqual(st.executeWorkspaceTool.calls.length, 0, 'nothing is written into the default workspace');
        assert.deepStrictEqual(s.g.showSnackbar.calls[s.g.showSnackbar.calls.length - 1], ['Cannot restore "gone.txt": no local workspace is known for it', 'warning']);
    }, { tags: ['unit'] });

    test('A3C2-03: Restore of a resolvable file targets the workspace that holds it and names it (escaped) in the confirm', async function() {
        var chat = chatOf([call('write', { path: 'a&b.txt', content: 'v1' })]);
        var st = restoreStubs(chat);
        var s = await setup({ metas: [{ repo: 'o/r::main' }], files: { 'a&b.txt': { dirty: true, original_content: 'base', content: 'v1' } }, globals: st });
        render(s, chat);
        assert.strictEqual(await s.m.wsfOpenVersions(0), true);
        var ov = document.querySelector('.wsf-overlay');
        assert.strictEqual(ov.querySelectorAll('button[title^="Restore this version"]').length, 2, 'base + write, never the current row');
        assert.ok(!/Restore is unavailable/.test(ov.textContent), 'no "unavailable" note when the target is known');
        await s.m.wsfRestoreVersion(1);
        assert.strictEqual(st.showConfirmModal.calls.length, 1);
        var msg = st.showConfirmModal.calls[0][1];
        assert.strictEqual(msg.indexOf('Restore "a&amp;b.txt" to v1 in o/r::main?'), 0, msg);
        assert.strictEqual(st.executeWorkspaceTool.calls.length, 1);
        assert.deepStrictEqual(st.executeWorkspaceTool.calls[0][0], { action: 'write', path: 'a&b.txt', content: 'v1', workspace: 'o/r::main' });
    }, { tags: ['unit'] });

    // A3C2-01: "Show in chat" reveals the exact tool call that made the version,
    // not the first tool call of its message (compact mode renders a run of
    // tool-call messages into #msg-<first>, leaving #msg-<idx> empty).
    function a3c201Chat() {
        function tc(id, action, a) { return { id: id, function: { name: 'workspace', arguments: JSON.stringify(Object.assign({ action: action }, a)) } }; }
        function res(id) { return { role: 'tool', tool_call_id: id, content: JSON.stringify({ success: true, message: 'Edited' }) }; }
        return { id: 'c1', title: 'T', messages: [{ role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [tc('y1', 'edit', { path: 'a.txt', edits: [] }), tc('y2', 'edit', { path: 'b.txt', edits: [] }), tc('y3', 'write', { path: 'z.txt', content: 'v1' })] },
            res('y1'), res('y2'), res('y3'),
            { role: 'assistant', tool_calls: [tc('y4', 'edit', { path: 'z.txt', edits: [{ find: 'v1', replace: 'v2' }] })] }, res('y4')] };
    }
    async function a3c201Open() {
        var chat = a3c201Chat();
        var st = { chats: { c1: chat }, scrollToMessage: U.recorder(), clearToolHighlights: U.recorder(), ensureMessageInWindow: U.recorder(),
            collapseOtherTools: U.recorder(function(t) { document.querySelectorAll('details.tool-call[open]').forEach(function(el) { if (el !== t) el.open = false; }); }) };
        var s = await setup({ metas: [{ repo: 'o/r::main' }], files: { 'z.txt': { dirty: true, original_content: '', content: 'v2' } }, globals: st });
        render(s, chat);
        var card = s.host.querySelector('.wsf-card[title="z.txt"]');
        assert.ok(card, 'z.txt row rendered');
        assert.strictEqual(await s.m.wsfOpenVersions(+/wsfOpenDiff\((\d+)\)/.exec(card.getAttribute('onclick'))[1]), true);
        var chips = document.querySelectorAll('.wsf-overlay .wsf-ver-chat.this-chat[title="Show in chat"]');
        assert.deepStrictEqual(Array.prototype.map.call(chips, function(c) { return c.getAttribute('onclick'); }), ['wsfGoToVersionMsg(1)', 'wsfGoToVersionMsg(2)']);
        return { s: s, st: st };
    }
    test('A3C2-01: "Show in chat" passes the exact tool-call position (msg 1 call #3, msg 5 call #1) when the call node is not rendered', async function() {
        var t = await a3c201Open();
        t.s.m.wsfGoToVersionMsg(1);
        t.s.m.wsfGoToVersionMsg(2);
        assert.deepStrictEqual(t.st.scrollToMessage.calls, [[1, 2], [5, 0]]);
        assert.strictEqual(document.querySelectorAll('.wsf-overlay').length, 0, 'overlay closed');
    }, { tags: ['unit'] });
    test('A3C2-01: "Show in chat" opens + flashes the exact (compact-grouped) tool call, not the first call or the empty #msg-<idx>', async function() {
        var t = await a3c201Open();
        var ids = ['tc-1-0', 'tc-1-1', 'tc-1-2', 'tc-5-0'];
        t.s.host.insertAdjacentHTML('beforeend', '<div id="msg-1"><details class="compact-tools-area"><summary>4 tools</summary>' +
            ids.map(function(id) { return '<details class="tool-call" id="' + id + '"><summary>' + id + '</summary></details>'; }).join('') +
            '</details></div><div id="msg-5"></div>');
        function opened() { return ids.filter(function(id) { return document.getElementById(id).open; }); }
        t.s.m.wsfGoToVersionMsg(2);
        assert.deepStrictEqual(t.st.ensureMessageInWindow.calls, [[5]], 'MEMWIN window expanded before the lookup');
        assert.deepStrictEqual(opened(), ['tc-5-0']);
        assert.strictEqual(document.querySelector('#msg-1 details.compact-tools-area').open, true, 'compact group expanded');
        assert.ok(document.getElementById('tc-5-0').classList.contains('highlight-flash'), 'flash on the exact call');
        assert.ok(!document.getElementById('msg-5').classList.contains('highlight-flash'), 'no flash on the empty placeholder');
        t.s.m.wsfGoToVersionMsg(1);
        assert.deepStrictEqual(opened(), ['tc-1-2'], 'the third call of msg 1, not its first');
        assert.strictEqual(t.st.collapseOtherTools.calls[1][0], document.getElementById('tc-1-2'));
        assert.strictEqual(t.st.scrollToMessage.calls.length, 0, 'no fallback to the first-tool-call path');
    }, { tags: ['unit'] });

    test('RC7CD-F1: Discard confirm names the path escaped; the discard call gets the raw path', async function() {
        var chat = chatOf([call('write', { path: 'a<b>&c.txt', content: 'v1' })]);
        var st = restoreStubs(chat);
        var s = await setup({ metas: [{ repo: 'o/r::main' }], files: { 'a<b>&c.txt': { dirty: true, original_content: 'base', content: 'v1' } }, globals: st });
        render(s, chat);
        await s.m.wsfDiscardFile(0);
        var c = st.showConfirmModal.calls[0];
        assert.strictEqual(c[1].indexOf('Discard uncommitted changes to "a&lt;b&gt;&amp;c.txt"?'), 0, c[1]);
        assert.strictEqual(c[2], 'danger');
        assert.deepStrictEqual(st.executeWorkspaceTool.calls[0][0], { action: 'discard', path: 'a<b>&c.txt', workspace: 'o/r::main' });
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

// ─────────────────── Version history: combined XML export ───────────────────
describe('version history › combined XML export', function() {
    var SI = 'a1b2c3d4e5f60718293a4b5c6d7e8f90', INC = '0f1e2d3c4b5a69788796a5b4c3d2e1f0', VER = '11112222333344445555666677778888';
    var CD = '<![' + 'CDATA[', CE = ']' + ']>';
    // A FRESH 090 engine (not the shared VH): fetch / Blob / snackbar / history are per-test stubs.
    async function exportEngine(incidentOk) {
        var t = { blob: null, snack: U.recorder() };
        function resp(ok, body) { return { ok: ok, status: ok ? 200 : 404, json: async function() { return body; }, text: async function() { return String(body); } }; }
        t.m = await loadLenient(ICONS.concat([ESC, 'src/js/ui/090-version-history.js']), {
            window: winStub(),
            fetch: async function(url) {
                if (url.indexOf('/api/now/table/sys_update_version/' + VER) === 0) return resp(true, { result: { payload: '<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><name>ZZ Include</name></sys_script_include></record_update>' } });
                if (url.indexOf('/incident.do?XML&sys_id=' + INC) === 0) return incidentOk ? resp(true, '<?xml version="1.0" encoding="UTF-8"?><xml><incident><number>INC0010001</number></incident></xml>') : resp(false, 'Not found');
                return resp(false, {});
            },
            Blob: function(parts) { t.blob = parts.join(''); },
            URL: { createObjectURL: function() { return 'blob:zz'; }, revokeObjectURL: function() {} },
            showSnackbar: t.snack, showSpinner: function() {}, hideSpinner: function() {},
            chats: {}, currentChatId: 'c1',
            versionHistory: [ // the real getAllChangedFiles / getLatestAfterVersion read these
                { chatId: 'c1', table: 'sys_script_include', sysId: SI, displayName: 'ZZ Include', action: 'UPDATE', afterVersion: VER, timestamp: 2 },
                { chatId: 'c1', table: 'incident', sysId: INC, displayName: 'INC0010001', action: 'UPDATE', afterVersion: null, timestamp: 1 } // data table: no version
            ],
            getRecordVersion: async function() { return null; },
            _recValidTable: /^[a-zA-Z_][a-zA-Z0-9_]*$/, _recValidSysId: /^[0-9a-fA-F]{32}$/ // as in core/150-record-helpers.js
        });
        return t;
    }
    // The export clicks a real <a download>: neutralise that click so no file is saved.
    async function runExport(t) {
        var own = Object.prototype.hasOwnProperty.call(document, 'createElement'), orig = document.createElement, clicks = 0;
        document.createElement = function(tag) { var el = orig.apply(document, arguments); if (String(tag).toLowerCase() === 'a') el.click = function() { clicks++; }; return el; };
        try { await t.m.downloadChangesXml(); } finally { if (own) document.createElement = orig; else delete document.createElement; }
        return clicks;
    }
    test('downloadChangesXml exports untracked data-table records', async function() {
        var t = await exportEngine(true);
        assert.strictEqual(await runExport(t), 1);
        assert.ok(t.blob, 'a Blob was built');
        assert.match(t.blob, /<sys_script_include\b[^>]*>[\s\S]*<\/sys_script_include>/);
        assert.match(t.blob, /<incident><number>INC0010001<\/number><\/incident>/);
        assert.ok(t.blob.indexOf('<xml') < 0, 'the .do?XML <xml> root is stripped');
        assert.strictEqual(t.snack.calls.length, 0);
    }, { tags: ['unit'] });
    test('downloadChangesXml warns when records are skipped', async function() {
        var t = await exportEngine(false);
        assert.strictEqual(await runExport(t), 1);
        assert.match(t.blob, /<sys_script_include\b/);
        assert.ok(t.blob.indexOf('<incident') < 0);
        assert.strictEqual(t.snack.calls.length, 1);
        assert.match(t.snack.calls[0][0], /1 of 2/);
        assert.match(t.snack.calls[0][0], /INC0010001/);
        assert.strictEqual(t.snack.calls[0][1], 'warning');
    }, { tags: ['unit'] });
    test('buildUpdateSetXml keeps CDATA literals and the whole record', async function() {
        var lit1 = "var a='<?xml version=\"1.0\"?>';", lit2 = "var b='<unload>x</unload>';";
        var rec = '<sys_script_include><script>' + CD + lit1 + ' ' + lit2 + CE + '</script></sys_script_include>';
        var P = '<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include">' + rec + '</record_update>';
        var out = (await versionEngine()).buildUpdateSetXml([P]);
        assert.ok(out.indexOf(lit1) >= 0, 'the <?xml literal inside CDATA is kept');
        assert.ok(out.indexOf(lit2) >= 0, 'the <unload> literal inside CDATA is kept');
        assert.strictEqual(out.indexOf('<?xml'), 0);
        assert.strictEqual(out.split('<?xml').length, 3); // the header + the CDATA literal
        assert.ok(out.indexOf(rec) >= 0, 'the <sys_script_include> element is intact');
    }, { tags: ['unit'] });
});
