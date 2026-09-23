// B5 — UI tests for the snackbar/toast queue, the generic modal (showModal /
// showConfirmModal / showPromptModal), and the tool-approval / permission card.
// Loads the REAL src modules (ui/220, ui/230, ui/225, ui/160) into the REAL
// sandbox document, mounts the REAL #snackbar / #approval-card / #modal-overlay
// markup extracted from src/html/body.html, drives time with a local fake clock,
// and runs rendered inline handlers through the module scope (U.fireInline).
// Run: run_tests { files: ['test/canary.test.js','test/ui-notifications-modals.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/220-notification-system.js', 'src/js/ui/230-modals.js', 'src/js/ui/225-approval-attention.js', 'src/js/ui/160-notifications.js'];
var ALLOW = ['_teardownWorkerChatModal', 'startClaudeOAuthLogin', 'startChatGPTOAuthLogin', 'startApprovalTitleFlash', 'syncApprovalTitleFlash',
    'setActionNeedsPermission', 'clearActionNeedsPermission', '_refreshWaitingBadges', 'resolveRootChatId', 'pushPermissionsToOffscreen',
    'clearApprovalNotificationsForChat', '_chatsHydrated', 'getApprovalCardEl', 'settlePendingModalResolve', '_dismissedApprovalKeys',
    'smartDocuments', 'currentEditingWidget', 'AgentEvents', 'invalidateCreditsRequests'];
var HOSTILE = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';

// ---- local helpers (proposed for test/ui-helpers.js) ----------------------
// fakeClock(): deterministic setTimeout/setInterval/Date for module globals.
function fakeClock() {
    var c = { now: 1000000, timers: [], seq: 0 };
    c.setTimeout = function(fn, ms) { var id = ++c.seq; c.timers.push({ id: id, at: c.now + (ms || 0), fn: fn }); return id; };
    c.setInterval = function(fn, ms) { var id = ++c.seq; c.timers.push({ id: id, at: c.now + ms, fn: fn, every: ms }); return id; };
    c.clearTimeout = c.clearInterval = function(id) { c.timers = c.timers.filter(function(t) { return t.id !== id; }); };
    c.tick = function(ms) {
        var end = c.now + ms;
        for (;;) {
            var due = c.timers.filter(function(t) { return t.at <= end; }).sort(function(a, b) { return a.at - b.at || a.id - b.id; })[0];
            if (!due) break;
            c.now = due.at;
            if (due.every) due.at += due.every; else c.timers = c.timers.filter(function(t) { return t !== due; });
            due.fn();
        }
        c.now = end;
    };
    var RealDate = Date;
    c.Date = function() { return arguments.length ? new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))() : new RealDate(c.now); };
    c.Date.now = function() { return c.now; };
    return c;
}
// docProxy(state): the real document with an overridable `hidden`.
function docProxy(state) {
    return new Proxy(document, {
        get: function(t, k) { if (k === 'hidden') return !!state.hidden; var v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; },
        set: function(t, k, v) { t[k] = v; return true; }
    });
}
// bugTest(): documents a real product bug as a SKIPPED test. Flip VERIFY_BUGS
// to true locally to run the body and confirm it still fails.
var VERIFY_BUGS = false;
function bugTest(name, fn, opts) {
    test(name, async function() { if (!VERIFY_BUGS) skipTest('known product bug (see test name)'); return fn(); }, opts);
}
// ---------------------------------------------------------------------------

var _bodyHtml = null;
async function mountShell() {
    if (_bodyHtml == null) {
        var d = U.parse(await loadFile('src/html/body.html', WS));
        _bodyHtml = ['snackbar', 'approval-card', 'modal-overlay'].map(function(id) { return d.getElementById(id).outerHTML; }).join('\n');
    }
    return U.mountDom({ html: _bodyHtml });
}

async function setup(extra) {
    var clock = fakeClock(), st = { hidden: false }, s = U.stubs();
    var rec = U.recorder;
    var g = Object.assign({
        document: docProxy(st), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, Date: clock.Date,
        console: { warn: rec(), log: function() {}, error: function() {}, info: function() {} },
        escapeJsString: function(x) { return String(x).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); },
        Platform: { instanceUrl: 'https://dev1.service-now.com', sendNotification: rec() },
        screenshotModalKeyHandler: function() {}, screenshotNav: { list: [1], index: 0 },
        chats: { c1: { id: 'c1', title: 'Chat One', messages: [{ role: 'user', content: 'hi' }] }, c2: { id: 'c2', title: 'Other <b>chat</b>', messages: [{ role: 'user', content: 'x' }] } },
        currentChatId: 'c1', currentView: 'chat', pendingToolApprovals: {}, sessionPermissions: {},
        chatPermKey: function(r, k) { return r + '::' + k; },
        saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar,
        renderMessages: rec(), renderChatList: rec(), scrollToBottomIfAllowed: rec(), runAgent: rec(function() { return Promise.resolve(); }),
        selectChat: rec(), setToolPermissionByKey: rec(), startClaudeOAuthLogin: rec(), startChatGPTOAuthLogin: rec(),
        chatPendingImages: {}, chatPendingTexts: {}
    }, extra || {});
    var dom = await mountShell();
    // 230-modals registers an anonymous document keydown (Enter) listener at load;
    // record document listeners added while loading so teardown can detach them
    // (otherwise they leak into later test files, e.g. the rename-modal Enter test).
    var origAdd = document.addEventListener;
    document.addEventListener = function(t, f, o) { _docListeners.push([t, f, o]); return origAdd.call(document, t, f, o); };
    var m;
    try { m = await U.loadUi(FILES, { globals: g, allowUnstubbed: ALLOW }); } finally { document.addEventListener = origAdd; }
    return { m: m, g: g, clock: clock, st: st, dom: dom, $: dom.$, $$: dom.$$ };
}
function sb(t) { return t.$('#snackbar'); }
function card(t) { return t.$('#approval-card'); }
function ov(t) { return t.$('#modal-overlay'); }
function btnByText(root, re) { return Array.prototype.slice.call(root.querySelectorAll('button')).filter(function(b) { return re.test(b.textContent.trim()); })[0]; }
async function settle() { for (var i = 0; i < 5; i++) await Promise.resolve(); }

var _origTitle = document.title;
var _docListeners = [];
function teardown() {
    U.cleanupAll(); document.title = _origTitle;
    _docListeners.forEach(function(l) { document.removeEventListener(l[0], l[1], l[2]); }); _docListeners = [];
}

// ============================== SNACKBAR ====================================
describe('ui notifications › snackbar', function() {
    afterEach(teardown);
    test('body.html host a11y: role=alert, aria-live=polite, starts hidden and empty', async function() {
        var t = await setup(), el = sb(t), a = U.a11y(el);
        assert.strictEqual(a.role, 'alert'); assert.strictEqual(a.aria.live, 'polite');
        assert.strictEqual(el.classList.contains('show'), false); assert.strictEqual(el.innerHTML, '');
    }, { tags: ['unit'] });
    test('success toast: escaped text, success class, no close button, auto-hides after 3000ms default', async function() {
        var t = await setup(), el = sb(t);
        t.m.showSnackbar('Saved ' + HOSTILE, 'success');
        assert.strictEqual(el.className, 'snackbar show success');
        assert.strictEqual(el.querySelector('.snackbar-message').textContent, 'Saved ' + HOSTILE);
        assert.strictEqual(el.querySelector('img, script, [onerror]'), null, 'hostile markup not parsed');
        assert.strictEqual(el.querySelector('.snackbar-close'), null, 'success is not pinned -> no X');
        t.clock.tick(2999); assert.ok(el.classList.contains('show'), 'still visible at 2999ms');
        t.clock.tick(1); assert.strictEqual(el.classList.contains('show'), false, 'hidden at 3000ms');
    }, { tags: ['unit'] });
    test('custom duration is honoured; a newer non-pinned toast replaces the current one', async function() {
        var t = await setup(), el = sb(t);
        t.m.showSnackbar('one', 'success', 500);
        t.m.showSnackbar('two', 'info', 800);
        assert.strictEqual(el.querySelector('.snackbar-message').textContent, 'two');
        assert.strictEqual(el.className, 'snackbar show success', 'unknown type falls back to success styling');
        t.clock.tick(799); assert.ok(el.classList.contains('show'), 'old 500ms timer was cleared');
        t.clock.tick(1); assert.strictEqual(el.classList.contains('show'), false);
    }, { tags: ['unit'] });
    test('error / legacy true / warning are pinned: class, X button, never auto-dismiss', async function() {
        var t = await setup(), el = sb(t);
        [['error', ' error'], [true, ' error'], ['warning', ' warning']].forEach(function(c, i) {
            t.m.hideSnackbar();
            t.m.showSnackbar('pinned ' + i, c[0]);
            assert.strictEqual(el.className, 'snackbar show' + c[1], 'type ' + c[0]);
            var x = el.querySelector('button.snackbar-close');
            assert.ok(x && x.querySelector('svg'), 'X button with icon for ' + c[0]);
            assert.strictEqual(x.getAttribute('onclick'), 'dismissSnackbar()');
            t.clock.tick(60000); assert.ok(el.classList.contains('show'), 'still pinned after 60s: ' + c[0]);
        });
    }, { tags: ['unit'] });
    test('X on a pinned toast dismisses it and drains the queue in order (after the 320ms slide-out)', async function() {
        var t = await setup(), el = sb(t);
        t.m.showSnackbar('Boom', 'error');
        t.m.showSnackbar('A status', 'success');
        t.m.showSnackbar('B warn', 'warning');
        t.m.showSnackbar('Boom', 'error'); // duplicate of on-screen -> collapsed
        t.m.showSnackbar('A status', 'success'); // duplicate of queued -> collapsed
        assert.strictEqual(el.querySelector('.snackbar-message').textContent, 'Boom', 'pinned error not clobbered');
        U.fireInline(el.querySelector('.snackbar-close'), 'click', t.m);
        assert.strictEqual(el.classList.contains('show'), false, 'hidden immediately');
        t.clock.tick(319); assert.strictEqual(el.classList.contains('show'), false, 'waits for slide-out');
        t.clock.tick(1); assert.strictEqual(el.querySelector('.snackbar-message').textContent, 'A status'); assert.ok(el.classList.contains('success'));
        t.clock.tick(3000 + 320);
        assert.strictEqual(el.querySelector('.snackbar-message').textContent, 'B warn'); assert.ok(el.classList.contains('warning') && el.classList.contains('show'));
        U.fireInline(el.querySelector('.snackbar-close'), 'click', t.m); t.clock.tick(5000);
        assert.strictEqual(el.classList.contains('show'), false, 'queue exhausted: duplicates were collapsed, nothing else shows');
    }, { tags: ['unit'] });
    test('stale (>15s) auto-dismissing toasts are dropped from the queue; pinned ones survive', async function() {
        var t = await setup(), el = sb(t);
        t.m.showSnackbar('Err', 'error');
        t.m.showSnackbar('Saving...', 'success');
        t.m.showSnackbar('Warn later', 'warning');
        t.clock.tick(16000);
        t.m.dismissSnackbar(); t.clock.tick(320);
        assert.strictEqual(el.querySelector('.snackbar-message').textContent, 'Warn later', 'stale success skipped, pinned warning shown');
    }, { tags: ['unit'] });
    test('queue full of pinned toasts: newcomer is logged to console.warn, never silently lost', async function() {
        var t = await setup();
        t.m.showSnackbar('E0', 'error');
        for (var i = 1; i <= 20; i++) t.m.showSnackbar('E' + i, 'error');
        assert.strictEqual(t.g.console.warn.calls.length, 0);
        t.m.showSnackbar('E21', 'error');
        assert.strictEqual(t.g.console.warn.calls.length, 1);
        assert.match(t.g.console.warn.calls[0][0], /queue full \(20 pinned toasts unread\).*E21/);
    }, { tags: ['unit'] });
    test('hideSnackbar clears screen + queue + in-flight drain; unread pinned entries are logged', async function() {
        var t = await setup(), el = sb(t);
        t.m.showSnackbar('Err', 'error'); t.m.showSnackbar('Queued err', 'error'); t.m.showSnackbar('status', 'success');
        t.m.dismissSnackbar(); // starts a drain timer
        t.m.hideSnackbar();
        t.clock.tick(10000);
        assert.strictEqual(el.classList.contains('show'), false, 'nothing repainted after clear');
        assert.strictEqual(t.g.console.warn.calls.length, 1, 'only the pinned queued entry is logged');
        assert.match(t.g.console.warn.calls[0][0], /toast area cleared.*Queued err/);
    }, { tags: ['unit'] });
    test('OAuth "not logged in" errors get a Log in action that dismisses and starts the right flow', async function() {
        var t = await setup(), el = sb(t);
        t.m.showSnackbar('Not logged in to Claude. Click the login button.', 'error');
        var a = el.querySelector('button.snackbar-action');
        assert.strictEqual(a.textContent, 'Log in');
        assert.strictEqual(a.getAttribute('onclick'), "snackbarLoginClick('claude')");
        // The real OAuth flows (ui/160, same scope) need chrome.* — only the dismissal is asserted here.
        try { U.fireInline(a, 'click', t.m); } catch (e) { /* flow start needs chrome.* */ }
        assert.strictEqual(el.classList.contains('show') && /Not logged in to Claude/.test(el.textContent), false, 'Log in dismisses the error toast');
        t.m.showSnackbar('Log in to ChatGPT again from the model menu.', true);
        assert.strictEqual(el.querySelector('button.snackbar-action').getAttribute('onclick'), "snackbarLoginClick('chatgpt')");
        t.clock.tick(400); t.m.hideSnackbar();
        t.m.showSnackbar('Not logged in to Claude.', 'warning');
        assert.strictEqual(el.querySelector('.snackbar-action'), null, 'only errors carry the action');
    }, { tags: ['unit'] });
    test('missing #snackbar host is a safe no-op', async function() {
        var t = await setup(); sb(t).remove();
        t.m.showSnackbar('x', 'error'); t.m.dismissSnackbar(); t.m.hideSnackbar();
        assert.strictEqual(document.getElementById('snackbar'), null);
    }, { tags: ['unit'] });
    test('snackbar X button has an accessible name (aria-label "Dismiss")', async function() {
        var t = await setup(); t.m.showSnackbar('e', 'error');
        assert.ok(U.a11y(sb(t).querySelector('.snackbar-close')).hasName);
        assert.strictEqual(U.a11y(sb(t).querySelector('.snackbar-close')).name, 'Dismiss');
    }, { tags: ['unit'] });
});

// ============================== MODALS ======================================
describe('ui notifications › generic modal', function() {
    afterEach(teardown);
    test('body.html overlay a11y: role=dialog, aria-modal, labelled by #modal-header; dialog stops propagation', async function() {
        var t = await setup(), o = ov(t), a = U.a11y(o);
        assert.strictEqual(a.role, 'dialog'); assert.strictEqual(a.aria.modal, 'true'); assert.strictEqual(a.aria.labelledby, 'modal-header');
        var dlg = o.querySelector('.modal-dialog');
        assert.strictEqual(dlg.getAttribute('role'), 'document');
        var info = U.fireInline(dlg, 'click', t.m);
        assert.strictEqual(info.stopped, true, 'click inside the dialog never reaches the backdrop');
    }, { tags: ['unit'] });
    test('showModal renders title as text, escaped button labels, variant class; button resolves its value', async function() {
        var t = await setup(), o = ov(t);
        var p = t.m.showModal('T ' + HOSTILE, 'Body', [{ label: '<b>Keep</b>', value: 'keep' }, { label: 'Go', value: "it's", class: 'danger' }], 'red');
        assert.ok(o.classList.contains('show') && o.classList.contains('modal-variant-danger'));
        assert.strictEqual(t.$('#modal-header').textContent, 'T ' + HOSTILE); assert.strictEqual(t.$('#modal-header').children.length, 0);
        var btns = t.$$('#modal-actions button.modal-btn');
        assert.strictEqual(btns.length, 2);
        assert.strictEqual(btns[0].textContent, '<b>Keep</b>'); assert.strictEqual(btns[0].className, 'modal-btn secondary', 'default class');
        assert.strictEqual(btns[1].className, 'modal-btn danger');
        U.fireInline(btns[1], 'click', t.m);
        assert.strictEqual(await p, "it's", 'quote survives escapeJsString round-trip');
        assert.strictEqual(o.classList.contains('show'), false); assert.strictEqual(o.classList.contains('modal-variant-danger'), false);
    }, { tags: ['unit'] });
    test('variant mapping: alert/red/error->danger, orange->warning, unknown->none; reopening clears the previous variant', async function() {
        var t = await setup(), o = ov(t);
        [['alert', 'danger'], ['error', 'danger'], ['orange', 'warning'], ['warning', 'warning'], ['blue', null], [undefined, null]].forEach(function(c) {
            t.m.showModal('t', 'm', [], c[0]);
            assert.strictEqual(o.classList.contains('modal-variant-danger'), c[1] === 'danger', 'danger for ' + c[0]);
            assert.strictEqual(o.classList.contains('modal-variant-warning'), c[1] === 'warning', 'warning for ' + c[0]);
        });
        t.m.closeModal();
    }, { tags: ['unit'] });
    test('message sanitizer: keeps allow-listed tags without attributes, drops opaque subtrees, unwraps the rest', async function() {
        var t = await setup();
        t.m.showModal('t', '<strong onclick="x()" style="position:fixed">Bold</strong><br><img src=x onerror=1><script>bad()</script>' +
            '<a href="javascript:alert(1)">link</a><div style="background:url(//e)">div text</div><style>p{}</style><svg><script>1</script></svg><!--c--><em>e</em>', []);
        var b = t.$('#modal-body');
        assert.strictEqual(b.querySelectorAll('strong').length, 1); assert.strictEqual(b.querySelector('strong').attributes.length, 0);
        assert.ok(b.querySelector('br') && b.querySelector('em'));
        assert.strictEqual(b.querySelector('img, script, a, div, style, svg, [onclick], [style], [href]'), null);
        assert.strictEqual(b.textContent, 'Boldlinkdiv texte', 'unwrapped text kept, script/style source dropped');
        t.m.closeModal();
    }, { tags: ['unit'] });
    test('sanitizer caps nesting depth and handles null', async function() {
        var t = await setup();
        var deep = new Array(60).join('<b>') + 'core' + new Array(60).join('</b>');
        var f = t.m.sanitizeModalMessage(deep), host = document.createElement('div'); host.appendChild(f);
        assert.strictEqual(host.textContent, 'core'); assert.ok(host.querySelectorAll('b').length <= 24, 'depth capped: ' + host.querySelectorAll('b').length);
        assert.strictEqual(t.m.sanitizeModalMessage(null).childNodes.length, 0);
    }, { tags: ['unit'] });
    test('isUnsafeModalUrl: script-capable schemes incl. whitespace/control obfuscation', async function() {
        var t = await setup(), f = t.m.isUnsafeModalUrl;
        ['javascript:x', ' JaVaScRiPt:x', 'java\tscript:x', 'java\u0000script:x', 'data:text/html,x', 'VBScript:x', '\n javascript:1'].forEach(function(u) { assert.strictEqual(f(u), true, JSON.stringify(u)); });
        ['https://x.com', '/rel', '#a', 'mailto:a@b', null, undefined, ''].forEach(function(u) { assert.strictEqual(f(u), false, JSON.stringify(u)); });
    }, { tags: ['unit'] });
    test('showConfirmModal: Confirm->true, Cancel->false, backdrop click->false; severity-coloured confirm button', async function() {
        var t = await setup(), o = ov(t);
        var p1 = t.m.showConfirmModal('Delete?', 'Sure', 'danger'); await settle();
        var confirmBtn = btnByText(o, /^Confirm$/), cancelBtn = btnByText(o, /^Cancel$/);
        assert.ok(confirmBtn.classList.contains('danger')); assert.ok(cancelBtn.classList.contains('secondary'));
        U.fireInline(confirmBtn, 'click', t.m); assert.strictEqual(await p1, true);
        var p2 = t.m.showConfirmModal('Q', 'm', 'orange'); await settle();
        assert.ok(btnByText(o, /^Confirm$/).classList.contains('warning'));
        U.fireInline(btnByText(o, /^Cancel$/), 'click', t.m); assert.strictEqual(await p2, false);
        var p3 = t.m.showConfirmModal('Q', 'm'); await settle();
        assert.ok(btnByText(o, /^Confirm$/).classList.contains('primary'));
        U.fireInline(o, 'click', t.m); // backdrop -> closeModal()
        assert.strictEqual(await p3, false); assert.strictEqual(o.classList.contains('show'), false);
    }, { tags: ['unit'] });
    test('closeModal (the Escape path) resolves null and strips every modal mode class', async function() {
        var t = await setup(), o = ov(t);
        var p = t.m.showModal('t', 'm', [], 'warning');
        ['skill-asset-modal', 'request-body-modal', 'screenshot-modal', 'pdf-modal', 'file-modal', 'worker-chat-modal'].forEach(function(c) { o.classList.add(c); });
        t.m.closeModal();
        assert.strictEqual(await p, null);
        assert.strictEqual(o.className, 'modal-overlay');
        assert.deepStrictEqual([t.g.screenshotNav.list.length, t.g.screenshotNav.index], [0, -1]);
    }, { tags: ['unit'] });
    test('opening a second modal settles the first as null (no hung await)', async function() {
        var t = await setup();
        var p1 = t.m.showModal('a', 'a', [{ label: 'x', value: 'x' }]);
        var p2 = t.m.showPromptModal('b', 'b', 'd');
        assert.strictEqual(await p1, null);
        U.fireInline(btnByText(ov(t), /^Cancel$/), 'click', t.m);
        assert.strictEqual(await p2, null);
    }, { tags: ['unit'] });
    test('showPromptModal: escaped message + default value, focus/select after 100ms, OK returns typed value', async function() {
        var t = await setup();
        var p = t.m.showPromptModal('Name', 'Pick ' + HOSTILE, '"><img src=x>');
        var inp = t.$('#modal-prompt-input'), msg = t.$('#modal-body p');
        assert.strictEqual(msg.textContent, 'Pick ' + HOSTILE); assert.strictEqual(t.$('#modal-body img, #modal-body script'), null);
        assert.strictEqual(inp.value, '"><img src=x>'); assert.strictEqual(inp.getAttribute('type'), 'text');
        var calls = []; inp.focus = function() { calls.push('focus'); }; inp.select = function() { calls.push('select'); };
        t.clock.tick(99); assert.deepStrictEqual(calls, []);
        t.clock.tick(1); assert.deepStrictEqual(calls, ['focus', 'select']);
        U.input(inp, 'typed name');
        U.fireInline(btnByText(ov(t), /^OK$/), 'click', t.m);
        assert.strictEqual(await p, 'typed name');
    }, { tags: ['unit'] });
    test('Enter submits via the primary/severity button; ignored for textarea, buttons, IME composing, closed modal', async function() {
        var t = await setup(), o = ov(t);
        var p = t.m.showPromptModal('N', 'm', 'v');
        var ok = btnByText(o, /^OK$/), clicks = 0; ok.click = function() { clicks++; };
        var ev = U.key(t.$('#modal-prompt-input'), 'Enter');
        assert.strictEqual(clicks, 1); assert.strictEqual(ev.defaultPrevented, true);
        U.key(t.$('#modal-prompt-input'), 'Enter', { isComposing: true }); assert.strictEqual(clicks, 1, 'IME composing ignored');
        U.key(ok, 'Enter'); assert.strictEqual(clicks, 1, 'focused button activates natively');
        var ta = document.createElement('textarea'); t.$('#modal-body').appendChild(ta); U.key(ta, 'Enter'); assert.strictEqual(clicks, 1, 'textarea keeps newline');
        U.key(t.$('#modal-prompt-input'), 'a'); assert.strictEqual(clicks, 1, 'other keys ignored');
        t.m.closeModal(); await p;
        U.key(t.$('#modal-prompt-input'), 'Enter'); assert.strictEqual(clicks, 1, 'closed modal ignores Enter');
    }, { tags: ['unit'] });
});

// ========================== APPROVAL CARD ===================================
async function promptIn(t, chatId, tool, args, tcId) {
    return t.m.showToolApprovalPrompt(tool, args, tool + '_key', tcId, tool, chatId);
}
describe('ui notifications › tool approval card', function() {
    afterEach(teardown);
    test('host a11y from body.html: role=alertdialog, aria-live=assertive, labelled', async function() {
        var t = await setup(), a = U.a11y(card(t));
        assert.strictEqual(a.role, 'alertdialog'); assert.strictEqual(a.aria.live, 'assertive'); assert.strictEqual(a.aria.label, 'Tool permission required');
    }, { tags: ['unit'] });
    test('single prompt on the current chat: card structure, escaping, context badges, params, pending row', async function() {
        var t = await setup(), c = card(t);
        promptIn(t, 'c1', 'servicenow_api', { table: 'incident', status_message: 'Fetch ' + HOSTILE }, 'tc1');
        assert.ok(c.classList.contains('show'));
        assert.strictEqual(c.querySelector('.notification-title').textContent, 'Permission Required');
        assert.strictEqual(c.querySelector('.notification-message').textContent, 'The agent wants to run servicenow_api');
        assert.strictEqual(c.querySelector('.notification-status').textContent, 'Fetch ' + HOSTILE);
        assert.strictEqual(c.querySelector('.notification-body img, .notification-body script'), null);
        assert.strictEqual(c.querySelector('.notification-instance-badge').textContent, 'dev1');
        var det = c.querySelector('details.notification-params');
        assert.ok(det && !det.open); assert.match(det.querySelector('pre').textContent, /table: incident/);
        var labels = t.$$('#approval-card .notification-actions button').map(function(b) { return b.textContent.trim(); });
        assert.deepStrictEqual(labels, ['Allow', 'This Chat', 'Deny'], 'no "Go to chat" on the current chat');
        assert.strictEqual(c.querySelector('.notification-queue-badge'), null);
        var row = t.g.chats.c1.messages[1];
        assert.deepStrictEqual([row.role, row.status, row.toolCallId, row.permissionKey], ['approval', 'pending', 'tc1', 'servicenow_api_key']);
        assert.strictEqual(t.g.renderMessages.calls.length, 1);
    }, { tags: ['unit'] });
    test('Allow resolves true, marks row allowed, hides the card and re-kicks the agent', async function() {
        var t = await setup(), c = card(t);
        var p = promptIn(t, 'c1', 'workspace', { workspace: 'o/r::main' }, 'tc1');
        assert.strictEqual(c.querySelector('.notification-context-badge').textContent, 'o/r');
        U.fireInline(btnByText(c, /^Allow$/), 'click', t.m); await settle();
        assert.strictEqual(await p, true);
        assert.strictEqual(t.g.chats.c1.messages[1].status, 'allowed');
        assert.strictEqual(c.classList.contains('show'), false);
        assert.strictEqual(Object.keys(t.g.pendingToolApprovals).length, 0, 'resolver consumed');
        t.clock.tick(100); assert.strictEqual(t.g.runAgent.calls.length, 1);
    }, { tags: ['unit'] });
    test('Deny resolves false, marks row denied, never runs the agent', async function() {
        var t = await setup(), c = card(t);
        var p = promptIn(t, 'c1', 'servicenow_api', null, 'tc1');
        assert.strictEqual(c.querySelector('details.notification-params'), null, 'no params block without args');
        U.fireInline(btnByText(c, /^Deny$/), 'click', t.m); await settle();
        assert.strictEqual(await p, false); assert.strictEqual(t.g.chats.c1.messages[1].status, 'denied');
        t.clock.tick(1000); assert.strictEqual(t.g.runAgent.calls.length, 0);
    }, { tags: ['unit'] });
    test('"This Chat" grants a chat-scoped permission and auto-resolves sibling prompts with the same key', async function() {
        var t = await setup(), c = card(t);
        var p1 = promptIn(t, 'c1', 'servicenow_api', { table: 'a' }, 'tc1');
        var p2 = promptIn(t, 'c1', 'servicenow_api', { table: 'b' }, 'tc2');
        var ses = c.querySelector('.notification-tool-item .tool-approval-btn.session');
        assert.strictEqual(ses.getAttribute('title'), 'Allow for this chat (and its sub-agents)');
        U.fireInline(ses, 'click', t.m); await settle();
        assert.strictEqual(await p1, true); assert.strictEqual(await p2, true, 'sibling auto-resolved');
        assert.strictEqual(t.g.sessionPermissions['c1::servicenow_api_key'], 'allow');
        assert.deepStrictEqual(t.g.chats.c1.messages.slice(1).map(function(r) { return r.status; }), ['session_allowed', 'session_allowed']);
    }, { tags: ['unit'] });
    test('always-allow (action "auto") persists the tool permission — not offered on the card itself', async function() {
        var t = await setup(), c = card(t);
        var p = promptIn(t, 'c1', 'servicenow_api', { table: 'a' }, 'tc1');
        assert.strictEqual(btnByText(c, /always/i), undefined, 'card exposes Allow / This Chat / Deny only');
        await t.m.handleApproval(1, 'auto', false, 'c1');
        assert.strictEqual(await p, true);
        assert.deepStrictEqual(t.g.setToolPermissionByKey.calls[0], ['servicenow_api_key', 'allow']);
        assert.strictEqual(t.g.chats.c1.messages[1].status, 'always_allowed');
        assert.strictEqual(c.classList.contains('show'), false, 'inline handling clears the card');
    }, { tags: ['unit'] });
    test('same-chat prompts batch into one card; per-row Allow re-renders, Allow All resolves the rest', async function() {
        var t = await setup(), c = card(t);
        var ps = [promptIn(t, 'c1', 'tool_a', { x: 1 }, 't1'), promptIn(t, 'c1', 'tool_b', { x: 2 }, 't2'), promptIn(t, 'c1', 'tool_<i>c</i>', { x: 3 }, 't3')];
        var items = t.$$('#approval-card .notification-tool-item');
        assert.strictEqual(items.length, 3); assert.strictEqual(items[2].querySelector('strong').textContent, 'tool_<i>c</i>');
        assert.strictEqual(c.querySelector('.notification-message').textContent, 'The agent wants to run:');
        assert.ok(c.querySelector('details.notification-params-compact'));
        assert.ok(btnByText(c, /^Allow All \(3\)$/) && btnByText(c, /^All This Chat$/) && btnByText(c, /^Deny All$/));
        U.fireInline(items[0].querySelector('.tool-approval-btn.allow'), 'click', t.m); await settle();
        assert.strictEqual(await ps[0], true);
        assert.strictEqual(t.$$('#approval-card .notification-tool-item').length, 2, 're-rendered without the handled row');
        assert.ok(c.classList.contains('show') && btnByText(c, /^Allow All \(2\)$/));
        U.fireInline(btnByText(c, /^Deny All$/), 'click', t.m); await settle();
        assert.strictEqual(await ps[1], false); assert.strictEqual(await ps[2], false);
        assert.strictEqual(c.classList.contains('show'), false);
    }, { tags: ['unit'] });
    test('other-chat prompt queues behind the current card (+N badge), then shows with Go to chat after 300ms', async function() {
        var t = await setup(), c = card(t);
        promptIn(t, 'c1', 'tool_a', null, 't1');
        var p2 = promptIn(t, 'c2', 'tool_b', null, 'u1');
        assert.strictEqual(c.querySelector('.notification-queue-badge').textContent, '+1 more');
        assert.strictEqual(c.querySelector('.notification-message').textContent, 'The agent wants to run tool_a', 'current card untouched');
        U.fireInline(btnByText(c, /^Deny$/), 'click', t.m); await settle();
        t.clock.tick(299); assert.strictEqual(c.classList.contains('show'), false);
        t.clock.tick(1); assert.ok(c.classList.contains('show'));
        assert.strictEqual(c.querySelector('.notification-message').textContent, 'Other <b>chat</b> wants to run tool_b');
        assert.strictEqual(c.querySelector('.notification-message b'), null);
        var go = btnByText(c, /^Go to chat$/); U.fireInline(go, 'click', t.m);
        assert.deepStrictEqual(t.g.selectChat.calls[0], ['c2']);
        U.fireInline(btnByText(c, /^Allow$/), 'click', t.m); await settle();
        assert.strictEqual(await p2, true); t.clock.tick(200);
        assert.strictEqual(t.g.runAgent.calls.length, 0, 'no runAgent for a chat the user is not on');
    }, { tags: ['unit'] });
    test('X dismiss hides the card; watchdog resurfaces a hidden card but never a user-dismissed one', async function() {
        var t = await setup(), c = card(t);
        promptIn(t, 'c1', 'tool_a', null, 't1');
        c.classList.remove('show'); // render race hid it
        t.m.resurfacePendingApprovals();
        assert.ok(c.classList.contains('show'), 'healed');
        U.fireInline(c.querySelector('.notification-close'), 'click', t.m);
        assert.strictEqual(c.classList.contains('show'), false);
        t.clock.tick(3300); // watchdog interval + dismiss follow-up
        assert.strictEqual(c.classList.contains('show'), false, 'user-dismissed card stays closed');
        assert.ok(t.g.pendingToolApprovals['c1:1'], 'resolver still pending');
        t.m.showPendingApprovalNotifications('c1'); // explicit navigation re-surfaces
        assert.ok(c.classList.contains('show'));
    }, { tags: ['unit'] });
    test('expand toggle flips class + title and auto-opens params', async function() {
        var t = await setup(), c = card(t);
        promptIn(t, 'c1', 'tool_a', { a: 1 }, 't1');
        var ex = c.querySelector('.notification-expand');
        assert.strictEqual(ex.getAttribute('title'), 'Expand');
        U.fireInline(ex, 'click', t.m);
        assert.ok(c.classList.contains('notification-expanded')); assert.strictEqual(ex.title, 'Collapse'); assert.strictEqual(c.querySelector('details').open, true);
        U.fireInline(ex, 'click', t.m);
        assert.strictEqual(c.classList.contains('notification-expanded'), false); assert.strictEqual(ex.title, 'Expand');
    }, { tags: ['unit'] });
    test('duplicate (chatId, index) notifications are ignored; stale clicks on a resolved row are no-ops', async function() {
        var t = await setup(), c = card(t);
        var p = promptIn(t, 'c1', 'tool_a', null, 't1');
        t.m.showApprovalNotification('Chat One', 'tool_a', 'c1', null, 1, null);
        assert.strictEqual(t.$$('#approval-card .notification-tool-item').length, 0, 'still single-mode card');
        var allow = btnByText(c, /^Allow$/);
        U.fireInline(allow, 'click', t.m); await settle(); assert.strictEqual(await p, true);
        t.g.chats.c1.messages[1].status = 'allowed';
        var saves = t.g.saveChatsToStorage.calls.length;
        await t.m.handleApproval(1, 'deny', true, 'c1');
        assert.strictEqual(t.g.chats.c1.messages[1].status, 'allowed', 'stale deny ignored'); assert.strictEqual(t.g.saveChatsToStorage.calls.length, saves);
    }, { tags: ['unit'] });
    test('hidden tab: OS notification (primary copy only) + title flash that restores the exact title', async function() {
        var t = await setup(); t.st.hidden = true; document.title = 'AppAgent';
        promptIn(t, 'c1', 'tool_a', { status_message: 'Doing X' }, 't1');
        assert.deepStrictEqual(t.g.Platform.sendNotification.calls[0][0], { title: 'Tool needs approval', message: 'Doing X — Chat One', chatId: 'c1' });
        t.m.showApprovalNotification('Other', 'tool_b', 'c2', null, 1, null, { osNotify: false });
        assert.strictEqual(t.g.Platform.sendNotification.calls.length, 1, 'fan-out copy does not re-notify');
        t.clock.tick(1000); assert.strictEqual(document.title, '⚠ Approval needed');
        t.clock.tick(1000); assert.strictEqual(document.title, 'AppAgent');
        t.clock.tick(1000); assert.strictEqual(document.title, '⚠ Approval needed');
        t.st.hidden = false; t.clock.tick(1000);
        assert.strictEqual(document.title, 'AppAgent', 'restored when visible');
    }, { tags: ['unit'] });
    test('mousedown on an approval button is preventDefault-ed (keeps iframe focus); elsewhere untouched', async function() {
        var t = await setup(), c = card(t);
        promptIn(t, 'c1', 'tool_a', null, 't1');
        var e1 = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); btnByText(c, /^Allow$/).dispatchEvent(e1);
        var e2 = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); c.querySelector('.notification-title').dispatchEvent(e2);
        assert.strictEqual(e1.defaultPrevented, true); assert.strictEqual(e2.defaultPrevented, false);
    }, { tags: ['unit'] });
    test('queue badge is removed when the other chat\'s queued approvals are cleared (queue reaches 0)', async function() {
        var t = await setup(), c = card(t);
        promptIn(t, 'c1', 'tool_a', null, 't1'); promptIn(t, 'c2', 'tool_b', null, 'u1');
        assert.ok(c.querySelector('.notification-queue-badge'));
        t.m.clearApprovalNotificationsForChat('c2');
        assert.strictEqual(c.querySelector('.notification-queue-badge'), null, 'badge should disappear with an empty queue');
    }, { tags: ['unit'] });
    test('approval card close (X) button has an accessible name on both render paths', async function() {
        var t = await setup(); promptIn(t, 'c1', 'tool_a', null, 't1');
        assert.ok(U.a11y(card(t).querySelector('.notification-close')).hasName);
        assert.strictEqual(U.a11y(card(t).querySelector('.notification-close')).name, 'Dismiss');
        promptIn(t, 'c1', 'tool_b', null, 't2'); // same chat -> rerenderCurrentNotification path
        assert.strictEqual(t.$$('#approval-card .notification-tool-item').length, 2);
        assert.strictEqual(U.a11y(card(t).querySelector('.notification-close')).name, 'Dismiss');
    }, { tags: ['unit'] });
    test('modal button class is attribute-escaped; ordinary classes unchanged', async function() {
        var t = await setup(), o = ov(t);
        t.m.showModal('T', 'B', [{ label: 'A', value: 'a', class: 'danger' }, { label: 'B', value: 'b', class: 'x" onclick="window.__pwn=1' }, { label: 'C', value: 'c' }]);
        var btns = o.querySelectorAll('button.modal-btn');
        assert.deepStrictEqual([].map.call(btns, function(b) { return b.className; }), ['modal-btn danger', 'modal-btn x" onclick="window.__pwn=1', 'modal-btn secondary']);
        assert.match(btns[1].getAttribute('onclick'), /^resolveModal\('b'\)$/);
    }, { tags: ['unit'] });
    test('hostile chatId stays inside the onclick JS string on approval buttons (both render paths)', async function() {
        var bad = "c'x<b>";
        var chats = { c1: { id: 'c1', title: 'Chat One', messages: [{ role: 'user', content: 'hi' }] } };
        chats[bad] = { id: bad, title: 'Bad', messages: [{ role: 'user', content: 'x' }] };
        var t = await setup({ chats: chats }), c = card(t);
        promptIn(t, bad, 'tool_a', null, 't1');
        assert.strictEqual(c.querySelector('.notification-actions b, .notification-body b'), null, 'no markup injected');
        U.fireInline(btnByText(c, /^Go to chat$/), 'click', t.m);
        assert.deepStrictEqual(t.g.selectChat.calls[0], [bad], 'go-to-chat receives the exact id');
        promptIn(t, bad, 'tool_b', null, 't2'); // batched path
        var gos = btnByText(c, /^Go to chat$/); U.fireInline(gos, 'click', t.m);
        assert.deepStrictEqual(t.g.selectChat.calls[1], [bad]);
        var denyAll = btnByText(c, /^Deny All$/);
        assert.match(denyAll.getAttribute('onclick'), /approveAllFromNotification\(\[\d+,\d+\], 'c\\'x<b>', 'deny'\)/);
    }, { tags: ['unit'] });
});
