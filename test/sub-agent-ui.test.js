// Run: run_tests { pattern: 'sub-agent-ui' } (js_eval sandbox; no Node).
// Executes the actual UI source against private fixtures; no page/SW/storage access.
'use strict';
function runSubAgentUiAudit(sources) {
    var results = [];
    var source = sources['src/js/ui/175-sub-agent-ui.js'];
    var css = sources['src/css/24-sub-agents.css'];
    var bodySource = sources['src/html/body.html'];
    function check(ok, message) { if (!ok) throw new Error(message); }
    function test(name, fn) {
        try { fn(); results.push({ name: name, passed: true }); }
        catch (e) { results.push({ name: name, passed: false, error: e.message }); }
    }
    function node(parent, attrs) {
        var listeners = {}, classes = new Set();
        return { parentNode: parent, attrs: attrs || {}, style: { display: 'none' }, innerHTML: '',
            getAttribute: function(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            setAttribute: function(k, v) { this.attrs[k] = v; },
            classList: { contains: function(k) { return classes.has(k); }, add: function(k) { classes.add(k); }, remove: function(k) { classes.delete(k); } },
            contains: function(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; },
            querySelector: function() { return null; },
            addEventListener: function(type, fn, capture) {
                var a = listeners[type] || (listeners[type] = []);
                if (!a.some(function(x) { return x.fn === fn && x.capture === !!capture; })) a.push({ fn: fn, capture: !!capture });
            },
            removeEventListener: function(type, fn) { listeners[type] = (listeners[type] || []).filter(function(x) { return x.fn !== fn; }); },
            fire: function(evt, capture) { (listeners[evt.type] || []).slice().forEach(function(x) { if (x.capture === capture) x.fn(evt); }); }
        };
    }
    // Real DOM ordering: capture ancestors, target, bubble ancestors; stopPropagation
    // blocks later nodes but not other listeners on the same node.
    function click(target) {
        var path = [], n = target;
        while (n) { path.push(n); n = n.parentNode; }
        var evt = { type: 'click', target: target, defaultPrevented: false, stopped: false,
            preventDefault: function() { this.defaultPrevented = true; },
            stopPropagation: function() { this.stopped = true; } };
        for (var i = path.length - 1; i >= 0; i--) { path[i].fire(evt, true); if (evt.stopped) return evt; }
        for (var j = 0; j < path.length; j++) { path[j].fire(evt, false); if (evt.stopped) break; }
        return evt;
    }
    function fixture(live) {
        var doc = node(null), elements = {}, calls = { reveal: [], modal: [], cards: [], close: 0, collapse: 0 };
        function el(id, parent) { return elements[id] = node(parent || doc); }
        var overlay = el('modal-overlay');
        var dialog = node(overlay);
        // Derive the propagation blocker from the actual shared modal scaffold.
        var blocker = bodySource.match(/class="modal-dialog"[^>]*onclick="([^"]+)"/);
        check(blocker, 'Shared modal propagation fixture missing');
        dialog.addEventListener('click', new Function('event', blocker[1]));
        el('modal-body', dialog); el('modal-header', dialog); el('modal-actions', dialog);
        el('sub-self-card-host'); el('sub-self-parent-host');
        doc.getElementById = function(id) { return elements[id] || null; };
        var report = { role: 'sub_report', subAgentId: 'sub-retired', subAgentName: 'Retired worker', subChatId: 'child',
            report: { status: 'done', at: 40 }, actionState: { state: 'done', label: 'Verified report', at: 39, tasks: [{ label: 'Checked source', status: 'done' }] } };
        var chats = { parent: { title: 'Parent', messages: [report] }, child: { isSubAgent: true, retiredSubAgent: true, parentChatId: 'parent', messages: [{ role: 'assistant', content: 'Completed worker transcript' }] } };
        var env = { document: doc, window: undefined, currentChatId: 'child', chats: chats, calls: calls,
            SubAgents: { getById: function(id) { return live && live.agent_id === id ? live : null; }, listAll: function() { return live ? [live] : []; }, addListener: function() {}, removeListener: function() {} },
            UI_ICONS: { close: 'x', back: 'back' }, escapeHtml: function(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); },
            closeModal: function() { calls.close++; overlay.classList.remove('worker-chat-modal'); api.teardown(); },
            toggleJsonCollapse: function() { calls.collapse++; }, selectChat: function(id) { calls.reveal.push(id); } };
        // Whole-file syntax/boot check, with only leaf renderers/navigation replaced.
        // Production resolution, reconstruction, modal lifecycle and event router run unchanged.
        var api = new Function('env', 'with (env) {\n' + source + '\n' +
            'revealSubAgentChat = function(id) { calls.reveal.push(id); };' +
            'renderSubReport = function() { return "report"; };' +
            '_subContextInfo = function() { return { pct: 0, tokens: 0 }; };' +
            '_subActivityInfo = function() { return null; }; _subAwaitingApproval = function() { return false; };' +
            '_subWorkStats = function() { return {}; }; _subModelLine = function() { return ""; };' +
            '_contextCircleHtml = function() { return ""; };' +
            'var originalCard = _workerCardHtml; _workerCardHtml = function(r, opts) { calls.cards.push(r); return originalCard(r, opts); };' +
            'return { progress: _workerProgressInner, self: updateSubAgentSelfCard, resolve: _resolveSubRec, open: openWorkerChatModal, teardown: _teardownWorkerChatModal, reconstruct: _reconstructSubsFromMessages }; }')(env);
        return { api: api, env: env, report: report, chats: chats, elements: elements, calls: calls, doc: doc, overlay: overlay };
    }
    function controls(html) {
        var out = [], re = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g, m;
        while ((m = re.exec(html))) {
            var attrs = {}, a, ar = /([\w-]+)="([^"]*)"/g;
            while ((a = ar.exec(m[2]))) attrs[a[1]] = a[2];
            out.push({ tag: m[1], attrs: attrs, label: m[3].replace(/<[^>]*>/g, '') });
        }
        return out;
    }
    test('progress actions are native non-submit buttons (Enter/Space activation contract)', function() {
        var f = fixture(), buttons = controls(f.api.progress({ agent_id: 'sub-retired', chat_id: 'child' }));
        check(buttons.length === 2, 'Expected Open chat and View more');
        buttons.forEach(function(b) {
            check(b.tag === 'button' && b.attrs.type === 'button', b.label + ': not a native non-submit button');
            check(!('role' in b.attrs) && !('tabindex' in b.attrs), 'No synthetic button semantics needed');
        });
        check(buttons[0].attrs['data-sub-agent-reveal'] === 'sub-retired', 'Live reveal data lost');
        check(buttons[1].attrs['data-worker-modal'] === 'sub-retired', 'Modal data lost');
    });
    test('native action chrome is explicitly reset without removing focus outlines', function() {
        var rule = css.match(/\.worker-progress-open\s*\{([^}]+)\}/)[1];
        ['background:\\s*(?:none|transparent)', 'border:\\s*(?:0|none)', 'padding:\\s*0', 'font-family:\\s*inherit', 'line-height:\\s*inherit'].forEach(function(p) { check(new RegExp(p).test(rule), 'Missing native reset: ' + p); });
        check(!/outline:\s*(none|0)/.test(rule), 'Keyboard focus outline removed');
    });
    test('delegated document click handles nested action content exactly once', function() {
        var f = fixture(), b = node(f.doc, { 'data-sub-agent-reveal': 'sub-retired' });
        var evt = click(node(b));
        check(f.calls.reveal.join() === 'sub-retired' && evt.defaultPrevented, 'Reveal not delegated');
        click(node(node(f.doc, { 'data-worker-modal': 'sub-retired' })));
        check(f.overlay.classList.contains('worker-chat-modal'), 'View more not delegated');
    });
    test('cold retired child restores self progress and View more without parent visit or persistence writes', function() {
        var f = fixture(), before = JSON.stringify(f.chats);
        check(f.api.resolve('sub-retired') === null, 'Fixture cache must start empty');
        f.api.self();
        check(f.elements['sub-self-parent-host'].style.display === '', 'Parent navigation missing');
        check(f.elements['sub-self-card-host'].style.display === '', 'Retired progress card hidden');
        check(f.calls.cards.length === 1 && f.calls.cards[0]._reconstructed, 'Did not reuse reconstructed record');
        check(f.calls.cards[0].action_state === f.report.actionState, 'Persisted progress missing');
        check(f.elements['sub-self-card-host'].innerHTML.includes('Checked source'), 'Actual persisted checklist not rendered');
        var buttons = controls(f.elements['sub-self-card-host'].innerHTML);
        check(buttons.length === 1 && buttons[0].attrs['data-worker-modal'] === 'sub-retired', 'Self card must expose View more only');
        f.api.self();
        check(f.calls.cards.length === 1, 'Unchanged card repainted');
        check(JSON.stringify(f.chats) === before, 'Persisted chat/report state mutated');
    });
    test('live registry record wins over persisted snapshot', function() {
        var live = { agent_id: 'sub-retired', chat_id: 'child', parent_chat_id: 'parent', state: 'running', action_state: { label: 'Live', at: 50 } };
        var f = fixture(live); f.api.self();
        check(f.calls.cards[0] === live && f.api.resolve('sub-retired') === live, 'Live record replaced');
    });
    test('missing or malformed parent and missing agent id fail closed', function() {
        [function(f) { delete f.chats.parent; }, function(f) { f.chats.parent.messages = null; }, function(f) { f.report.subAgentId = ''; }].forEach(function(change) {
            var f = fixture(); change(f); f.api.self();
            check(f.calls.cards.length === 0 && f.elements['sub-self-card-host'].style.display === 'none', 'Invalid parent/report rendered a card');
        });
    });
    test('latest persisted report wins; reconstructed deleted-chat action stays absent', function() {
        var f = fixture();
        f.chats.parent.messages.push(Object.assign({}, f.report, { actionState: { label: 'Latest', at: 60 } }));
        f.api.self();
        check(f.calls.cards[0] && f.calls.cards[0].action_state.at === 60, 'Latest report not reconstructed');
        delete f.chats.child;
        var buttons = controls(f.api.progress(f.calls.cards[0]));
        check(buttons.length === 1 && buttons[0].attrs['data-worker-modal'], 'Deleted child should not offer Open chat');
    });
    test('modal Open chat crosses the real dialog bubble blocker and closes once', function() {
        var f = fixture(); f.api.open('sub-retired');
        var target = node(node(f.elements['modal-body'], { 'data-sub-chat-id': 'child' }));
        var evt = click(target);
        check(f.calls.reveal.join() === 'child', 'Modal reveal swallowed by dialog stopPropagation');
        check(f.calls.close === 1 && !f.overlay.classList.contains('worker-chat-modal') && evt.defaultPrevented, 'Modal not closed exactly once');
    });
    test('modal report collapse and reopen work without duplicate handlers', function() {
        var f = fixture(); f.api.open('sub-retired'); f.api.open('sub-retired');
        click(node(f.elements['modal-body'], { 'data-sub-collapse': 'report:out', 'data-sub-collapse-id': 'output' }));
        check(f.calls.collapse === 1, 'Modal report toggle blocked or duplicated');
        f.env.closeModal(); f.api.open('sub-retired');
        click(node(f.elements['modal-body'], { 'data-sub-agent-reveal': 'sub-retired' }));
        check(f.calls.reveal.length === 1 && f.calls.close === 2, 'Reopen duplicated handler');
    });
    test('modal target handlers still run and teardown leaves other modals untouched', function() {
        var f = fixture(); f.api.open('sub-retired');
        var n = node(f.elements['modal-body']), ran = 0;
        n.addEventListener('click', function() { ran++; }); click(n);
        check(ran === 1 && !f.calls.reveal.length && !f.calls.close, 'Unrelated target action intercepted');
        f.overlay.classList.remove('worker-chat-modal');
        click(node(f.elements['modal-body'], { 'data-sub-chat-id': 'child' }));
        check(f.calls.reveal.length === 0, 'Inactive worker modal still routed clicks');
        f.env.closeModal();
        click(node(f.elements['modal-body'], { 'data-sub-chat-id': 'child' }));
        check(f.calls.reveal.length === 0, 'Worker handler leaked into another modal');
    });
    return { passed: results.filter(function(r) { return r.passed; }).length, total: results.length, results: results };
}
// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/ui/175-sub-agent-ui.js","src/css/24-sub-agents.css","src/html/body.html"];
await registerRunner('sub-agent-ui', async function() { return runSubAgentUiAudit(await loadSources(PATHS)); });
