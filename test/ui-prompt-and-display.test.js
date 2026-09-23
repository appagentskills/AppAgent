// B3 — UI tests for prompt_user forms (src/js/tools/100-prompt-user.js) and
// display-template INTERACTIONS (src/js/tools/090-display-templates.js).
// Real src modules (loadModules via test/ui-helpers.js), real sandbox DOM + real
// CSS, inline handlers driven through the module scope with U.fireInline.
// Run: run_tests { files: ['test/ui-prompt-and-display.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var PROMPT_FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/tools/100-prompt-user.js'];
var DISPLAY_FILES = ['src/js/tools/090-display-templates.js'];
var CSS = ['src/css/00-tokens.css', 'src/css/05-tools.css', 'src/css/10-approval.css', 'src/css/21-display-templates.css', 'src/css/21b-prompt-user.css'];
// typeof-probed optional globals left unstubbed on purpose (fallback paths).
var PROMPT_ALLOW = ['formatContent', 'ensureChatPayloads'];
var HOSTILE = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
// Every awaited PRODUCT promise goes through guard(): a promise that never
// settles becomes an assertion failure (well under the harness per-test
// timeout, which would otherwise abort the whole run and destroy the sandbox).
var PENDING = { pending: true };
function guard(p, label, ms) {
    var timer;
    return Promise.race([p, new Promise(function(r) { timer = setTimeout(function() { r(PENDING); }, ms || 1500); })])
        .then(function(v) { clearTimeout(timer); assert.notStrictEqual(v, PENDING, (label || 'promise') + ' never settled'); return v; });
}
// Run BUG tests unskipped once to prove they fail, then keep them skipped.
var BUGTEST = test.skip;

// ---------------------------------------------------------------- prompt env
function promptEnv(extraChats, extra) {
    var s = U.stubs();
    var env = { chat: { id: 'c1', messages: [] }, save: s.saveChatsToStorage };
    env.rec = {
        renderMessages: U.recorder(function() { if (env.rerender) env.rerender(); }),
        scrollToBottomIfAllowed: U.recorder(), runAgent: U.recorder(function() { return Promise.resolve(); }),
        recordToolResult: U.recorder(), _promptResultViaSW: U.recorder(function() { return false; }),
        _refreshWaitingBadges: U.recorder(), clearActionNeedsInput: U.recorder(), setActionNeedsInput: U.recorder(), postPromptRowToSW: U.recorder()
    };
    env.chats = Object.assign({ c1: env.chat }, extraChats || {});
    env.globals = Object.assign({ chats: env.chats, currentChatId: 'c1', activeStreamingChatId: null, currentView: 'chat',
        saveChatsToStorage: s.saveChatsToStorage, showSnackbar: s.showSnackbar }, env.rec, extra || {});
    return env;
}
async function loadPrompt(env) { env.m = await U.loadUi(PROMPT_FILES, { globals: env.globals, allowUnstubbed: PROMPT_ALLOW }); return env.m; }
// Test-side stand-in for renderMessages (lives in ui/250, another batch): paints
// every prompt_user row of the current chat with the REAL renderPromptUserMessage.
async function mountTranscript(env) {
    var dom = await U.mountDom({ html: '<div id="messages"></div>', css: CSS });
    env.dom = dom;
    env.rerender = function() {
        dom.$('#messages').innerHTML = env.chat.messages.map(function(x, i) { return x.role === 'prompt_user' ? env.m.renderPromptUserMessage(x, i) : ''; }).join('');
    };
    env.rerender();
    return dom;
}
async function pendingPrompt(fields, extraMsg, envOpts) {
    var env = promptEnv(envOpts && envOpts.chats, envOpts && envOpts.globals);
    var msg = Object.assign({ role: 'prompt_user', promptId: 'p1', toolCallId: null, title: 'Need input', description: '', fields: fields, status: 'pending' }, extraMsg || {});
    env.chat.messages.push(msg);
    await loadPrompt(env);
    await mountTranscript(env);
    env.msg = msg;
    env.form = function() { return env.dom.$('#prompt-form-p1'); };
    env.field = function(name) { return env.dom.$('#prompt-form-p1 [data-field-name="' + name + '"]'); };
    env.btn = function(label) { return env.dom.$$('.tool-approval-actions button').filter(function(b) { return b.textContent.trim() === label; })[0]; };
    return env;
}
function wrapOf(el) { return el.closest('.prompt-field'); }
async function fieldHtml(field) {
    var env = promptEnv(); var m = await loadPrompt(env);
    var dom = await U.mountDom({ html: '<form id="prompt-form-x">' + m.renderPromptField(field, 'x') + '</form>', css: CSS });
    return { m: m, dom: dom, wrap: dom.$('.prompt-field') };
}

describe('ui prompt_user › renderPromptField per type', function() {
    afterEach(function() { U.cleanupAll(); });
    test('text: label, prefill, placeholder, hostile escaping, hidden error, no required marker', async function() {
        var f = await fieldHtml({ name: 'nm"x', label: 'Name ' + HOSTILE, placeholder: 'ph "q" <b>', value: 'v "1" </input><b>' });
        var inp = f.dom.$('input');
        assert.strictEqual(inp.type, 'text'); assert.ok(inp.classList.contains('prompt-field-input'));
        assert.strictEqual(inp.getAttribute('data-field-name'), 'nm"x'); assert.strictEqual(inp.getAttribute('data-prompt-field'), 'nm"x');
        assert.strictEqual(inp.getAttribute('data-field-type'), 'text');
        assert.strictEqual(inp.value, 'v "1" </input><b>'); assert.strictEqual(inp.getAttribute('placeholder'), 'ph "q" <b>');
        assert.strictEqual(f.dom.$('.prompt-field-label').textContent, 'Name ' + HOSTILE);
        assert.strictEqual(f.dom.$('img, script, b'), null); assert.strictEqual(f.dom.$('[onerror]'), null);
        assert.strictEqual(f.dom.$('.prompt-field-required'), null); assert.strictEqual(inp.required, false); assert.strictEqual(inp.hasAttribute('data-required'), false);
        assert.strictEqual(f.dom.$('.prompt-field-error').textContent, 'This field is required');
        assert.strictEqual(U.css(f.dom.$('.prompt-field-error'), 'display'), 'none', 'error hidden until invalid');
        assert.strictEqual(inp.getAttribute('oninput'), 'promptClearInvalid(this)');
    }, { tags: ['unit'] });
    test('required marker + attributes; label falls back to name; unknown type falls back to text', async function() {
        var f = await fieldHtml({ name: 'who', type: 'weird', required: true });
        var inp = f.dom.$('input');
        assert.strictEqual(inp.type, 'text'); assert.strictEqual(inp.getAttribute('data-field-type'), 'text');
        assert.strictEqual(inp.required, true); assert.strictEqual(inp.getAttribute('data-required'), '1');
        var mark = f.dom.$('.prompt-field-label .prompt-field-required');
        assert.strictEqual(mark.textContent, '*'); assert.strictEqual(mark.getAttribute('title'), 'Required');
        assert.strictEqual(f.dom.$('.prompt-field-label').textContent, 'who*');
    }, { tags: ['unit'] });
    test('textarea: prefill cannot break out of the element', async function() {
        var f = await fieldHtml({ name: 'notes', type: 'textarea', value: 'a\n</textarea><script>x()</script>', placeholder: 'Say' });
        var ta = f.dom.$('textarea');
        assert.ok(ta.classList.contains('prompt-field-textarea')); assert.strictEqual(ta.getAttribute('data-field-type'), 'textarea');
        assert.strictEqual(ta.value, 'a\n</textarea><script>x()</script>'); assert.strictEqual(f.dom.$('script'), null);
        assert.strictEqual(ta.getAttribute('placeholder'), 'Say'); assert.strictEqual(f.dom.$$('.prompt-field > *').length, 3, 'label + textarea + error');
    }, { tags: ['unit'] });
    test('select ≤6 options: radiogroup pills, prefill, promptPickPill moves the single selection', async function() {
        var f = await fieldHtml({ name: 'env', type: 'select', required: true, value: 'prod', options: [{ value: 'dev', label: 'Dev <b>' }, { value: 'prod', label: 'Prod' }, 'qa'] });
        var group = f.dom.$('.prompt-chip-group');
        assert.strictEqual(group.getAttribute('role'), 'radiogroup'); assert.strictEqual(group.getAttribute('data-field-type'), 'select'); assert.strictEqual(group.getAttribute('data-required'), '1');
        var chips = f.dom.$$('.prompt-chip');
        assert.deepStrictEqual(chips.map(function(c) { return c.textContent; }), ['Dev <b>', 'Prod', 'qa']);
        assert.deepStrictEqual(chips.map(function(c) { return c.getAttribute('data-value'); }), ['dev', 'prod', 'qa']);
        chips.forEach(function(c) { assert.strictEqual(c.getAttribute('type'), 'button'); assert.strictEqual(c.getAttribute('role'), 'radio'); });
        assert.deepStrictEqual(chips.map(function(c) { return c.classList.contains('selected'); }), [false, true, false]);
        U.fireInline(chips[2], 'click', f.m);
        assert.deepStrictEqual(chips.map(function(c) { return c.classList.contains('selected'); }), [false, false, true]);
        U.fireInline(chips[0], 'click', f.m);
        assert.deepStrictEqual(f.dom.$$('.prompt-chip.selected').map(function(c) { return c.getAttribute('data-value'); }), ['dev']);
        assert.strictEqual(U.css(chips[0], 'background-color') !== U.css(chips[1], 'background-color'), true, 'selected pill styled differently');
    }, { tags: ['unit'] });
    test('select >6 options: native <select>; required w/o default gets a hidden disabled placeholder; default preselects', async function() {
        var opts = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', { value: 'r7', label: 'R<7>' }];
        var a = await fieldHtml({ name: 'region', type: 'select', required: true, options: opts });
        var sel = a.dom.$('select');
        assert.strictEqual(sel.options.length, 8); var ph = sel.options[0];
        assert.strictEqual(ph.value, ''); assert.strictEqual(ph.disabled, true); assert.strictEqual(ph.hidden, true); assert.strictEqual(ph.textContent, 'Select…');
        assert.strictEqual(sel.value, '', 'browser cannot silently submit r1'); assert.strictEqual(sel.options[7].textContent, 'R<7>');
        assert.strictEqual(sel.getAttribute('onchange'), 'promptClearInvalid(this)'); assert.strictEqual(sel.getAttribute('data-required'), '1');
        U.cleanupAll();
        var b = await fieldHtml({ name: 'region', type: 'select', required: true, value: 'r7', options: opts });
        assert.strictEqual(b.dom.$('select').options.length, 7, 'no placeholder when default present'); assert.strictEqual(b.dom.$('select').value, 'r7');
    }, { tags: ['unit'] });
    test('multi-select chips: prefill (array + scalar) and promptToggleChip toggles independently', async function() {
        var f = await fieldHtml({ name: 'tags', type: 'multi-select', value: ['a', 'c'], options: ['a', 'b', 'c'] });
        var chips = f.dom.$$('.prompt-chip.prompt-chip-multi');
        assert.strictEqual(chips.length, 3); assert.strictEqual(f.dom.$('.prompt-chip-group').hasAttribute('role'), false);
        assert.deepStrictEqual(chips.map(function(c) { return c.classList.contains('selected'); }), [true, false, true]);
        U.fireInline(chips[1], 'click', f.m); U.fireInline(chips[0], 'click', f.m);
        assert.deepStrictEqual(chips.map(function(c) { return c.classList.contains('selected'); }), [false, true, true]);
        U.cleanupAll();
        var g = await fieldHtml({ name: 't', type: 'multi-select', value: 'b', options: ['a', 'b'] });
        assert.deepStrictEqual(g.dom.$$('.prompt-chip.selected').map(function(c) { return c.textContent; }), ['b']);
    }, { tags: ['unit'] });
    test('multi-select widget/style "checkboxes": vertical checklist with labels and checked prefill', async function() {
        ['widget', 'style'].forEach(function() {});
        var f = await fieldHtml({ name: 'teams', type: 'multi-select', widget: 'checkboxes', value: ['t2'], required: true, options: [{ value: 't1', label: 'Team <1>' }, { value: 't2', label: 'Team 2' }] });
        var list = f.dom.$('.prompt-checklist');
        assert.strictEqual(list.getAttribute('data-field-type'), 'multi-select'); assert.strictEqual(list.getAttribute('data-required'), '1');
        var boxes = f.dom.$$('label.prompt-field-checkbox input[type="checkbox"]');
        assert.strictEqual(boxes.length, 2); assert.deepStrictEqual(boxes.map(function(b) { return b.checked; }), [false, true]);
        assert.strictEqual(f.dom.$$('label.prompt-field-checkbox span')[0].textContent, 'Team <1>');
        assert.strictEqual(f.dom.$('.prompt-chip'), null);
        U.cleanupAll();
        var g = await fieldHtml({ name: 'x', type: 'multi-select', style: 'checkboxes', options: ['a'] });
        assert.ok(g.dom.$('.prompt-checklist input.prompt-field-check'), 'style: alias works');
    }, { tags: ['unit'] });
    test('boolean: switch row, label rendered once, prefill checked', async function() {
        var f = await fieldHtml({ name: 'urgent', type: 'boolean', label: 'Urgent?', value: true, required: true });
        assert.strictEqual(f.dom.$('.prompt-field-label'), null, 'no top label');
        assert.strictEqual(f.dom.$('.prompt-switch-row .prompt-switch-label').textContent, 'Urgent?');
        var cb = f.dom.$('.prompt-switch input[type="checkbox"]');
        assert.strictEqual(cb.checked, true); assert.strictEqual(cb.getAttribute('data-field-type'), 'boolean');
        assert.ok(f.dom.$('.prompt-switch-track .prompt-switch-thumb'));
        assert.strictEqual(f.dom.root.textContent.split('Urgent?').length - 1, 1);
    }, { tags: ['unit'] });
    test('number and date inputs: types, prefill; date ignores placeholder', async function() {
        var n = await fieldHtml({ name: 'qty', type: 'number', value: 3, placeholder: 'How many' });
        assert.strictEqual(n.dom.$('input').type, 'number'); assert.strictEqual(n.dom.$('input').value, '3'); assert.strictEqual(n.dom.$('input').getAttribute('placeholder'), 'How many');
        U.cleanupAll();
        var d = await fieldHtml({ name: 'due', type: 'date', value: '2026-10-01', placeholder: 'ignored', required: true });
        var di = d.dom.$('input');
        assert.strictEqual(di.type, 'date'); assert.strictEqual(di.value, '2026-10-01'); assert.strictEqual(di.hasAttribute('placeholder'), false); assert.strictEqual(di.required, true);
    }, { tags: ['unit'] });
    // PRODUCT BUG (100-prompt-user.js:582 / :620): selection state lives only in
    // the .selected class — role="radio" pills lack the REQUIRED aria-checked,
    // multi chips lack aria-pressed, so screen readers can't tell what is picked.
    test('chip/pill selection state is exposed via aria-checked / aria-pressed', async function() {
        var f = await fieldHtml({ name: 'env', type: 'select', value: 'b', options: ['a', 'b'] });
        var g = await fieldHtml({ name: 'tags', type: 'multi-select', value: ['a'], options: ['a', 'b'] });
        var got = f.dom.$$('.prompt-chip[role="radio"]').map(function(c) { return 'pill:' + c.getAttribute('aria-checked'); })
            .concat(g.dom.$$('.prompt-chip-multi').map(function(c) { return 'chip:' + c.getAttribute('aria-pressed'); }));
        assert.deepStrictEqual(got, ['pill:false', 'pill:true', 'chip:true', 'chip:false']);
    }, { tags: ['unit'] });
    // PRODUCT BUG (100-prompt-user.js:569): <label class="prompt-field-label"> has no
    // `for` and does not wrap the control, so text/textarea/select/number/date
    // inputs have no accessible name.
    test('field label is associated with its control', async function() {
        var f = await fieldHtml({ name: 'nm', label: 'Your name' });
        var inp = f.dom.$('input');
        assert.ok(f.dom.$('.prompt-field-label').control === inp || inp.getAttribute('aria-label') === 'Your name', 'input has an accessible name');
    }, { tags: ['unit'] });
});

describe('ui prompt_user › inline form: submit / validation / cancel / drafts', function() {
    afterEach(function() { U.cleanupAll(); });
    var ALL = function() { return [
        { name: 'name', type: 'text', label: 'Name', value: 'Ann' },
        { name: 'notes', type: 'textarea', label: 'Notes' },
        { name: 'env', type: 'select', label: 'Env', value: 'prod', options: [{ value: 'dev', label: 'Development' }, { value: 'prod', label: 'Production' }] },
        { name: 'region', type: 'select', label: 'Region', options: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] },
        { name: 'tags', type: 'multi-select', label: 'Tags', value: ['a'], options: ['a', 'b', 'c'] },
        { name: 'teams', type: 'multi-select', widget: 'checkboxes', label: 'Teams', options: [{ value: 't1', label: 'Team 1' }, { value: 't2', label: 'Team 2' }] },
        { name: 'urgent', type: 'boolean', label: 'Urgent' },
        { name: 'qty', type: 'number', label: 'Qty' },
        { name: 'due', type: 'date', label: 'Due' },
        { name: 'empty', type: 'text', label: 'Left <empty>' }
    ]; };
    test('pending render: open <details>, inline-markdown title escaped, description fallback, labelled actions', async function() {
        var env = await pendingPrompt([{ name: 'a' }], { title: 'Pick **one** `x` ' + HOSTILE, description: 'line1\n<b>line2</b>' });
        var d = env.dom.$('.message.prompt-user#msg-0 details.tool-approval-prompt');
        assert.strictEqual(d.open, true); assert.strictEqual(d.classList.contains('approved') || d.classList.contains('denied'), false);
        var sum = d.querySelector('summary.tool-approval-header');
        assert.strictEqual(sum.querySelector('strong').textContent, 'one'); assert.strictEqual(sum.querySelector('code.inline-code').textContent, 'x');
        assert.strictEqual(env.dom.$('img, script'), null); assert.match(sum.textContent, /<img src=x/);
        var desc = env.dom.$('.prompt-user-desc.markdown-body');
        assert.strictEqual(desc.querySelectorAll('br').length, 1); assert.strictEqual(desc.querySelector('b'), null); assert.match(desc.textContent, /<b>line2<\/b>/);
        assert.strictEqual(U.a11y(env.btn('Cancel')).hasName, true); assert.ok(env.btn('Submit').classList.contains('allow')); assert.ok(env.btn('Cancel').classList.contains('deny'));
        var f = env.form();
        assert.strictEqual(f.getAttribute('oninput'), 'promptCaptureDraft(this)'); assert.strictEqual(f.getAttribute('onchange'), 'promptCaptureDraft(this)');
    }, { tags: ['unit'] });
    test('submit collects every field type, persists, repaints the submitted read-only view', async function() {
        var env = await pendingPrompt(ALL()), m = env.m;
        U.input(env.field('notes'), 'line1\nline2');
        env.field('region').value = 'r5'; U.fireInline(env.field('region'), 'change', m);
        U.fireInline(env.dom.$$('[data-field-name="tags"] .prompt-chip')[2], 'click', m);
        var t2 = env.dom.$$('[data-field-name="teams"] input')[1]; t2.checked = true; U.fireInline(t2, 'change', m);
        env.field('urgent').checked = true;
        U.input(env.field('qty'), '2.5'); U.input(env.field('due'), '2026-10-01');
        var info = U.fireInline(env.form(), 'submit', m);
        assert.strictEqual(info.prevented, true, 'native submit prevented');
        assert.strictEqual(env.msg.status, 'submitted');
        assert.deepStrictEqual(env.msg.values, { name: 'Ann', notes: 'line1\nline2', env: 'prod', region: 'r5', tags: ['a', 'c'], teams: ['t2'], urgent: true, qty: 2.5, due: '2026-10-01', empty: '' });
        assert.ok(env.save.calls.length >= 1, 'saved'); assert.ok(env.rec.renderMessages.calls.length >= 1, 'repainted'); assert.ok(env.rec.scrollToBottomIfAllowed.calls.length >= 1);
        // submitted view (rendered by the real renderPromptUserMessage)
        assert.strictEqual(env.form(), null, 'form gone'); assert.strictEqual(env.dom.$('.tool-approval-actions'), null);
        var d = env.dom.$('details.tool-approval-prompt');
        assert.ok(d.classList.contains('approved')); assert.strictEqual(d.open, false);
        assert.strictEqual(env.dom.$('.tool-approval-status.allowed').textContent, 'Submitted');
        var rows = env.dom.$$('.prompt-submitted-values .prompt-value-row');
        assert.strictEqual(rows.length, 10);
        function row(label) { return rows.filter(function(r) { return r.querySelector('.prompt-value-label').textContent === label; })[0]; }
        assert.strictEqual(row('Env').querySelector('.prompt-value-text').textContent, 'Production', 'select shows option label');
        assert.deepStrictEqual([].map.call(row('Tags').querySelectorAll('.prompt-value-chip'), function(c) { return c.textContent; }), ['a', 'c']);
        assert.deepStrictEqual([].map.call(row('Teams').querySelectorAll('.prompt-value-chip'), function(c) { return c.textContent; }), ['Team 2']);
        assert.strictEqual(row('Urgent').textContent, 'UrgentYes'); assert.strictEqual(row('Qty').querySelector('.prompt-value-text').textContent, '2.5');
        assert.strictEqual(row('Notes').querySelector('.prompt-value-text').textContent, 'line1\nline2');
        assert.strictEqual(U.css(row('Notes').querySelector('.prompt-value-text'), 'white-space'), 'pre-wrap');
        assert.ok(row('Left <empty>').querySelector('.prompt-value-empty'), 'empty → em dash'); assert.strictEqual(row('Left <empty>').querySelector('.prompt-value-empty').textContent, '—');
    }, { tags: ['unit'] });
    test('required validation flags fields + notice, blocks submit; fixing fields clears flags and notice', async function() {
        var env = await pendingPrompt([
            { name: 'txt', type: 'text', label: 'T', required: true }, { name: 'pick', type: 'select', required: true, options: ['x', 'y'] },
            { name: 'multi', type: 'multi-select', required: true, options: ['m1', 'm2'] }, { name: 'num', type: 'number', required: true },
            { name: 'ok', type: 'boolean', required: true }, { name: 'd', type: 'date' }]), m = env.m;
        // The inline onclick is a statement (`submitPromptUser('p1')`, no return),
        // so fireInline().result is always undefined — assert observable state.
        assert.strictEqual(env.btn('Submit').getAttribute('onclick'), "submitPromptUser('p1')");
        U.fireInline(env.btn('Submit'), 'click', m);
        assert.strictEqual(env.msg.status, 'pending'); assert.strictEqual(env.save.calls.length, 0);
        var inv = env.dom.$$('.prompt-field.invalid');
        assert.strictEqual(inv.length, 4, 'boolean + optional date never invalid');
        assert.strictEqual(wrapOf(env.field('ok')).classList.contains('invalid'), false);
        var notice = env.form().querySelector('.prompt-validation-notice');
        assert.strictEqual(notice.textContent, '4 required fields need a value');
        assert.strictEqual(U.css(wrapOf(env.field('txt')).querySelector('.prompt-field-error'), 'display'), 'block', 'error visible');
        // fix one by one through the real inline handlers
        U.input(env.field('txt'), 'hi'); U.fireInline(env.field('txt'), 'input', m);
        assert.strictEqual(wrapOf(env.field('txt')).classList.contains('invalid'), false);
        assert.ok(env.form().querySelector('.prompt-validation-notice'), 'notice stays while others invalid');
        U.fireInline(env.dom.$$('[data-field-name="pick"] .prompt-chip')[1], 'click', m);
        U.fireInline(env.dom.$$('[data-field-name="multi"] .prompt-chip')[0], 'click', m);
        assert.strictEqual(env.dom.$$('.prompt-field.invalid').length, 1);
        U.input(env.field('num'), '7'); U.fireInline(env.field('num'), 'input', m);
        assert.strictEqual(env.dom.$$('.prompt-field.invalid').length, 0);
        assert.strictEqual(env.form().querySelector('.prompt-validation-notice'), null, 'notice removed');
        U.fireInline(env.btn('Submit'), 'click', m);
        assert.strictEqual(env.msg.status, 'submitted');
        assert.deepStrictEqual(env.msg.values, { txt: 'hi', pick: 'y', multi: ['m1'], num: 7, ok: false, d: '' });
    }, { tags: ['unit'] });
    test('singular notice; required native select + checkbox list validate', async function() {
        var env = await pendingPrompt([{ name: 's', type: 'select', required: true, options: ['1', '2', '3', '4', '5', '6', '7'] }]);
        assert.strictEqual(env.m.submitPromptUser('p1'), false);
        assert.strictEqual(env.form().querySelector('.prompt-validation-notice').textContent, '1 required field needs a value');
        U.cleanupAll();
        var e2 = await pendingPrompt([{ name: 'c', type: 'multi-select', widget: 'checkboxes', required: true, options: ['a', 'b'] }]);
        assert.strictEqual(e2.m.submitPromptUser('p1'), false); assert.ok(wrapOf(e2.field('c')).classList.contains('invalid'));
        var box = e2.dom.$('[data-field-name="c"] input'); box.checked = true; U.fireInline(box, 'change', e2.m);
        assert.strictEqual(wrapOf(e2.field('c')).classList.contains('invalid'), false);
        assert.strictEqual(e2.m.submitPromptUser('p1'), true); assert.deepStrictEqual(e2.msg.values, { c: ['a'] });
    }, { tags: ['unit'] });
    test('cancel marks the row cancelled and repaints header-only; abandoned label variant', async function() {
        var env = await pendingPrompt([{ name: 'a', required: true }]);
        U.fireInline(env.btn('Cancel'), 'click', env.m);
        assert.strictEqual(env.msg.status, 'cancelled'); assert.ok(env.save.calls.length >= 1);
        var d = env.dom.$('details.tool-approval-prompt');
        assert.ok(d.classList.contains('denied')); assert.strictEqual(d.open, false);
        assert.strictEqual(env.dom.$('.tool-approval-status.denied').textContent, 'Cancelled');
        assert.strictEqual(env.form(), null); assert.strictEqual(env.dom.$('.prompt-submitted-values'), null);
        env.msg.abandoned = true; env.rerender();
        assert.strictEqual(env.dom.$('.tool-approval-status.denied').textContent, 'Abandoned');
    }, { tags: ['unit'] });
    test('draft capture: form input + pill click write back to msg.fields; re-render keeps the draft', async function() {
        var env = await pendingPrompt([{ name: 'a', type: 'text' }, { name: 'p', type: 'select', options: ['x', 'y'] }, { name: 'b', type: 'boolean' }]), m = env.m;
        U.input(env.field('a'), 'typed'); env.field('b').checked = true;
        U.fireInline(env.form(), 'input', m);
        assert.strictEqual(env.msg.fields[0].value, 'typed'); assert.strictEqual(env.msg.fields[2].value, true);
        U.fireInline(env.dom.$$('[data-field-name="p"] .prompt-chip')[1], 'click', m);
        assert.strictEqual(env.msg.fields[1].value, 'y', 'pill click captured without a form event');
        env.rerender();
        assert.strictEqual(env.field('a').value, 'typed'); assert.strictEqual(env.field('b').checked, true);
        assert.ok(env.dom.$$('[data-field-name="p"] .prompt-chip')[1].classList.contains('selected'));
        env.msg.status = 'submitted'; env.field('a').value = 'late'; m.promptCaptureDraft(env.form());
        assert.strictEqual(env.msg.fields[0].value, 'typed', 'no-op once not pending');
    }, { tags: ['unit'] });
    test('promptSubmittedValueHtml: empty states, chips, Yes/No, label mapping and escaping', async function() {
        var env = promptEnv(), m = await loadPrompt(env);
        [null, undefined, '', []].forEach(function(v) { assert.ok(U.frag(m.promptSubmittedValueHtml({}, v)).querySelector('.prompt-value-empty'), JSON.stringify(v)); });
        assert.strictEqual(U.frag(m.promptSubmittedValueHtml({}, false)).textContent, 'No');
        assert.strictEqual(U.frag(m.promptSubmittedValueHtml({}, 0)).textContent, '0');
        var sel = { type: 'select', options: [{ value: 'v', label: 'Label <v>' }] };
        assert.strictEqual(U.frag(m.promptSubmittedValueHtml(sel, 'v')).textContent, 'Label <v>');
        assert.strictEqual(U.frag(m.promptSubmittedValueHtml(sel, 'stale')).textContent, 'stale', 'unmatched → raw');
        var b = U.frag(m.promptSubmittedValueHtml({}, HOSTILE)); assert.strictEqual(b.querySelector('img, script'), null); assert.strictEqual(b.textContent, HOSTILE);
        var c = U.frag(m.promptSubmittedValueHtml({ options: ['<i>'] }, ['<i>', HOSTILE]));
        assert.strictEqual(c.querySelectorAll('.prompt-value-chip').length, 2); assert.strictEqual(c.querySelector('i, img'), null);
    }, { tags: ['unit'] });
});

describe('ui prompt_user › live lifecycle (executePromptUser, reload path, background popup)', function() {
    afterEach(function() { U.cleanupAll(); var h = document.getElementById('bg-popup-host'); if (h) h.remove(); });
    test('executePromptUser: validates input, adds free-text escape hatch, renders, focuses first text field, resolves on submit', async function() {
        var env = promptEnv(); var m = await loadPrompt(env); await mountTranscript(env);
        assert.deepStrictEqual(await m.executePromptUser({ fields: [] }), { success: false, error: 'fields array is required' });
        var p = m.executePromptUser({ title: 'Choose', fields: [{ name: 'choice', type: 'select', options: ['x', 'y'] }] }, { toolCallId: 'tc9' });
        var msg = env.chat.messages[0];
        assert.strictEqual(msg.status, 'pending'); assert.strictEqual(msg.toolCallId, 'tc9');
        assert.deepStrictEqual(msg.fields.map(function(f) { return f.name + ':' + f.type; }), ['choice:select', 'free_text_response:textarea']);
        assert.strictEqual(env.rec.postPromptRowToSW.calls[0][1], msg); assert.strictEqual(env.rec.setActionNeedsInput.calls.length, 0);
        assert.ok(env.rec.renderMessages.calls.length >= 1); assert.deepStrictEqual(env.rec._refreshWaitingBadges.calls[0], ['c1']);
        var form = env.dom.$('#prompt-form-' + msg.promptId); assert.ok(form, 'form rendered');
        var ta = form.querySelector('textarea.prompt-field-input'), focused = 0; ta.focus = function() { focused++; };
        await wait(150);
        assert.strictEqual(focused, 1, 'first text-like field focused');
        U.fireInline(form.querySelectorAll('.prompt-chip')[1], 'click', m);
        U.input(ta, 'because');
        var submit = env.dom.$$('.tool-approval-actions button')[1];
        assert.strictEqual(submit.textContent.trim(), 'Submit');
        U.fireInline(submit, 'click', m);
        assert.strictEqual(msg.status, 'submitted');
        var res = await guard(p, 'executePromptUser after submit');
        assert.strictEqual(res.success, true); assert.deepStrictEqual(res.values, { choice: 'y', free_text_response: 'because' });
        assert.strictEqual(res._message_persist, msg); assert.strictEqual(env.rec.recordToolResult.calls.length, 0, 'live resolver, no reload inject');
    }, { tags: ['unit'] });
    test('executePromptUser: cancel resolves cancelled; replay with same toolCallId reuses the pending row', async function() {
        var env = promptEnv(); var m = await loadPrompt(env); await mountTranscript(env);
        var p1 = m.executePromptUser({ fields: [{ name: 'a', type: 'text' }] }, { toolCallId: 'tcA' });
        var pid = env.chat.messages[0].promptId;
        // Replay (SW re-dispatch after a panel reload) adopts the pending row
        // and RE-ARMS pendingPromptResolvers[promptId] — the replayed call is
        // the one that settles. (The first call is orphaned here only because
        // both run in one context; in production the first lived in the
        // reloaded-away panel.) Awaiting p1 is what hung the previous run.
        var p2 = m.executePromptUser({ fields: [{ name: 'a', type: 'text' }] }, { toolCallId: 'tcA' });
        assert.strictEqual(env.chat.messages.length, 1, 'no duplicate form row'); assert.strictEqual(env.dom.$$('form[id^="prompt-form-"]').length, 1);
        assert.strictEqual(env.dom.$('form[id^="prompt-form-"]').id, 'prompt-form-' + pid, 'same promptId reused');
        U.fireInline(env.dom.$$('.tool-approval-actions button')[0], 'click', m);
        var r = await guard(p2, 'replayed executePromptUser after cancel');
        assert.strictEqual(r.success, false); assert.strictEqual(r.cancelled, true); assert.strictEqual(env.chat.messages[0].status, 'cancelled');
        assert.strictEqual(r._message_persist, env.chat.messages[0]);
        var first = await Promise.race([p1.then(function() { return 'settled'; }), wait(50).then(function() { return 'superseded'; })]);
        assert.strictEqual(first, 'superseded', 'pre-replay await is superseded by the replay');
    }, { tags: ['unit'] });
    test('reload path: no resolver → recordToolResult + runAgent(owning chat); SW route short-circuits', async function() {
        var env = await pendingPrompt([{ name: 'a', type: 'text', value: 'v' }], { toolCallId: 'tc1' });
        U.fireInline(env.btn('Submit'), 'click', env.m);
        var c = env.rec.recordToolResult.calls[0];
        assert.strictEqual(c[0], env.chat); assert.strictEqual(c[1], 'tc1'); assert.strictEqual(c[2], 'prompt_user');
        assert.deepStrictEqual(JSON.parse(c[3]), { success: true, values: { a: 'v' } });
        await U.flush(); assert.deepStrictEqual(env.rec.runAgent.calls[0], ['c1']);
        U.cleanupAll();
        var e2 = await pendingPrompt([{ name: 'a' }], { toolCallId: 'tc2' }, { globals: { _promptResultViaSW: U.recorder(function() { return true; }) } });
        U.fireInline(e2.btn('Cancel'), 'click', e2.m);
        assert.strictEqual(e2.rec.recordToolResult.calls.length, 0, 'SW took it');
        assert.deepStrictEqual(e2.globals._promptResultViaSW.calls[0][2], { success: false, cancelled: true, message: 'User cancelled the form' });
    }, { tags: ['unit'] });
    test('background chat: needs_input flag instead of inline render; popup single-instance, backdrop/modal clicks, invalid keeps it open, submit closes', async function() {
        var bg = { id: 'b1', isBackground: true, actionId: 'act1', messages: [] };
        var env = promptEnv({ b1: bg }); var m = await loadPrompt(env); await mountTranscript(env);
        var p = m.executePromptUser({ title: 'BG <i>ask</i>', fields: [{ name: 'why', type: 'text', required: true }] }, { chatId: 'b1' });
        var pid = bg.messages[0].promptId;
        assert.deepStrictEqual(env.rec.setActionNeedsInput.calls[0], ['act1', pid]); assert.strictEqual(env.rec.renderMessages.calls.length, 0);
        m.openBackgroundPromptPopup('b1', pid); m.openBackgroundPromptPopup('b1', pid);
        assert.strictEqual(document.querySelectorAll('#bg-popup-host').length, 1, 'single host');
        var host = document.getElementById('bg-popup-host');
        assert.strictEqual(host.querySelector('.modal-title-text').textContent, 'BG <i>ask</i>'); assert.strictEqual(host.querySelector('i'), null);
        assert.strictEqual(host.querySelector('.modal-close-icon').getAttribute('aria-label'), 'Close');
        var backdrop = host.querySelector('.bg-popup-backdrop'), modal = host.querySelector('.bg-popup-modal');
        assert.strictEqual(U.fireInline(modal, 'click', m).stopped, true, 'modal swallows clicks');
        U.fireInline(backdrop, 'click', m, { target: modal });
        assert.ok(document.getElementById('bg-popup-host'), 'click originating inside modal does not close');
        var submit = host.querySelectorAll('.bg-popup-footer button')[1];
        U.fireInline(submit, 'click', m);
        assert.ok(document.getElementById('bg-popup-host'), 'invalid → stays open'); assert.strictEqual(env.rec.clearActionNeedsInput.calls.length, 0);
        assert.ok(host.querySelector('.prompt-field.invalid'));
        U.input(host.querySelector('input'), 'ok'); U.fireInline(submit, 'click', m);
        assert.strictEqual(document.getElementById('bg-popup-host'), null, 'closed'); assert.deepStrictEqual(env.rec.clearActionNeedsInput.calls[0], ['act1']);
        assert.strictEqual(env.rec.renderMessages.calls.length, 0, 'visible chat not repainted');
        assert.deepStrictEqual((await guard(p, 'bg executePromptUser after popup submit')).values, { why: 'ok' }); assert.strictEqual(m.openBackgroundPromptPopup('b1', pid), undefined);
        assert.strictEqual(document.getElementById('bg-popup-host'), null, 'no popup for a non-pending prompt');
    }, { tags: ['unit'] });
    test('background popup: backdrop click closes without resolving; Cancel resolves cancelled', async function() {
        var bg = { id: 'b1', isBackground: true, actionId: 'act2', messages: [] };
        var env = promptEnv({ b1: bg }); var m = await loadPrompt(env);
        var p = m.executePromptUser({ fields: [{ name: 'a', type: 'text' }] }, { chatId: 'b1' });
        var pid = bg.messages[0].promptId;
        m.openBackgroundPromptPopup('b1', pid);
        U.fireInline(document.querySelector('#bg-popup-host .bg-popup-backdrop'), 'click', m);
        assert.strictEqual(document.getElementById('bg-popup-host'), null); assert.strictEqual(bg.messages[0].status, 'pending');
        m.openBackgroundPromptPopup('b1', pid);
        U.fireInline(document.querySelectorAll('#bg-popup-host .bg-popup-footer button')[0], 'click', m);
        assert.strictEqual((await guard(p, 'bg executePromptUser after popup cancel')).cancelled, true); assert.strictEqual(document.getElementById('bg-popup-host'), null);
        assert.deepStrictEqual(env.rec.clearActionNeedsInput.calls[0], ['act2']);
    }, { tags: ['unit'] });
});

// ---------------------------------------------------------------- display
function displayEnv() {
    var s = U.stubs(), clip = U.clipboard(), chat = { id: 'c1', messages: [] };
    return { chat: chat, clip: clip, save: s.saveChatsToStorage, snack: s.showSnackbar,
        globals: { chats: { c1: chat }, currentChatId: 'c1', activeStreamingChatId: null, saveChatsToStorage: s.saveChatsToStorage, navigator: { userAgent: 'ui-test', clipboard: clip }, showSnackbar: s.showSnackbar } };

}
async function loadDisplay(env) { env = env || displayEnv(); env.m = await U.loadUi(DISPLAY_FILES, { globals: env.globals }); return env; }
async function mountDisplay(html) { return U.mountDom({ html: html, css: CSS }); }
function texts(nodes) { return [].map.call(nodes, function(n) { return n.textContent; }); }

describe('ui display templates › table sort + filter', function() {
    afterEach(function() { U.cleanupAll(); });
    function rows7() { return [['b', '10'], ['a', '2'], ['c', '33'], ['Delta', '4'], ['echo', '5'], ['fox', '6'], [HOSTILE, '7']]; }
    test('sort: numeric column sorts numerically, toggles asc/desc, arrow + .sorted move between headers', async function() {
        var e = await loadDisplay(), m = e.m;
        var dom = await mountDisplay(m.generateTable({ columns: ['Name', 'Count'], rows: rows7() }));
        var th = dom.$$('th');
        assert.strictEqual(th[1].classList.contains('num'), true); assert.strictEqual(th[0].classList.contains('num'), false);
        function col(i) { return dom.$$('tbody tr').map(function(r) { return r.cells[i].textContent; }); }
        U.fireInline(th[1], 'click', m);
        assert.deepStrictEqual(col(1), ['2', '4', '5', '6', '7', '10', '33'], 'numeric, not lexicographic');
        assert.ok(th[1].classList.contains('sorted')); assert.strictEqual(th[1].querySelector('.display-sort-arrow').textContent, '▲');
        U.fireInline(th[1], 'click', m);
        assert.deepStrictEqual(col(1), ['33', '10', '7', '6', '5', '4', '2']); assert.strictEqual(th[1].querySelector('.display-sort-arrow').textContent, '▼');
        U.fireInline(th[0], 'click', m);
        assert.strictEqual(col(0)[0], HOSTILE, '"<" sorts first (localeCompare asc)'); assert.strictEqual(col(0)[1], 'a');
        assert.ok(th[0].classList.contains('sorted')); assert.strictEqual(th[1].classList.contains('sorted'), false);
        assert.strictEqual(th[1].querySelector('.display-sort-arrow').textContent, '▲', 'arrow reset on old column');
        assert.strictEqual(dom.$('tbody img, tbody script'), null);
    }, { tags: ['unit'] });
    test('filter: search + row count for >5 rows, case-insensitive hide, empty state, reset', async function() {
        var e = await loadDisplay(), m = e.m;
        var dom = await mountDisplay(m.generateTable({ columns: ['Name', 'Count'], rows: rows7() }));
        var search = dom.$('input.display-search'), count = dom.$('.display-row-count'), empty = dom.$('.display-table-empty');
        assert.strictEqual(search.getAttribute('placeholder'), 'Search...'); assert.strictEqual(count.textContent, '7 rows');
        assert.strictEqual(U.css(empty, 'display'), 'none');
        search.value = 'DELTA'; U.fireInline(search, 'input', m);
        var vis = dom.$$('tbody tr').filter(function(r) { return r.style.display !== 'none'; });
        assert.deepStrictEqual(vis.map(function(r) { return r.cells[0].textContent; }), ['Delta']); assert.strictEqual(count.textContent, '1 of 7 rows');
        search.value = 'zzz'; U.fireInline(search, 'input', m);
        assert.strictEqual(count.textContent, '0 of 7 rows'); assert.notStrictEqual(U.css(empty, 'display'), 'none'); assert.strictEqual(empty.textContent, 'No matching rows');
        search.value = ''; U.fireInline(search, 'input', m);
        assert.strictEqual(count.textContent, '7 of 7 rows'); assert.strictEqual(U.css(empty, 'display'), 'none');
        assert.strictEqual(dom.$$('tbody tr').filter(function(r) { return r.style.display === 'none'; }).length, 0);
        U.cleanupAll();
        var small = await mountDisplay(m.generateTable({ columns: ['A'], rows: [['1'], ['2']] }));
        assert.strictEqual(small.$('.display-search'), null); assert.strictEqual(small.$('.display-row-count'), null);
        assert.strictEqual(m.generateTable({ columns: [], rows: [['x']] }), null);
    }, { tags: ['unit'] });
});

describe('ui display templates › cards, checklist, status, code, timeline, chart, diff', function() {
    afterEach(function() { U.cleanupAll(); });
    test('card_list: detail cards expand/collapse on click (CSS shows detail), plain cards inert, >6 cards filter', async function() {
        var e = await loadDisplay(), m = e.m;
        var cards = [{ title: 'One ' + HOSTILE, subtitle: 'sub', icon: '★', badge: 'P1', badge_color: 'red" onmouseover="x', detail: 'More <b>info</b>' }, { title: 'Two' }];
        for (var i = 3; i <= 7; i++) cards.push({ title: 'Card ' + i });
        var dom = await mountDisplay(m.generateCardList({ cards: cards }));
        var c = dom.$$('.display-card');
        assert.strictEqual(c.length, 7); assert.ok(c[0].classList.contains('has-detail')); assert.ok(c[0].querySelector('.display-card-chevron'));
        assert.strictEqual(c[1].hasAttribute('onclick'), false); assert.strictEqual(c[1].querySelector('.display-card-chevron'), null);
        assert.strictEqual(c[0].querySelector('.display-badge').className, 'display-badge display-badge-blue', 'bad color token → fallback');
        assert.strictEqual(dom.$('[onmouseover], img, script, b'), null); assert.strictEqual(c[0].querySelector('.display-card-detail').textContent, 'More <b>info</b>');
        var detail = c[0].querySelector('.display-card-detail');
        assert.strictEqual(U.css(detail, 'display'), 'none');
        U.fireInline(c[0], 'click', m);
        assert.ok(c[0].classList.contains('expanded')); assert.strictEqual(U.css(detail, 'display'), 'block');
        U.fireInline(c[0], 'click', m);
        assert.strictEqual(c[0].classList.contains('expanded'), false); assert.strictEqual(U.css(detail, 'display'), 'none');
        var s = dom.$('input.display-search'); s.value = 'card 5'; U.fireInline(s, 'input', m);
        assert.deepStrictEqual(c.filter(function(x) { return x.style.display !== 'none'; }).map(function(x) { return x.querySelector('.display-card-title').textContent; }), ['Card 5']);
        assert.strictEqual(m.generateCardList({ cards: [] }), null);
    }, { tags: ['unit'] });
    test('checklist: summary init, click toggles + persists to chat.displays, cache refreshed, all-done state', async function() {
        var e = await loadDisplay(), m = e.m;
        var r = m.executeDisplay({ template: 'checklist', items: ['Plan', { label: 'Build', checked: true }, { text: 'Ship <x>', description: 'to prod' }] }, 0, { chatId: 'c1' });
        assert.strictEqual(r.success, true);
        var dom = await mountDisplay(m.renderDisplayPlaceholder(r.id));
        m.initDisplayChecklists();
        var listId = 'dcl_' + r.id, items = dom.$$('.display-check-item');
        assert.strictEqual(dom.$('.display-checklist').getAttribute('data-display-id'), r.id);
        assert.deepStrictEqual(texts(dom.$$('.display-check-label')), ['Plan', 'Build', 'Ship <x>']); assert.strictEqual(dom.$('.display-check-desc').textContent, 'to prod');
        assert.strictEqual(dom.$('#' + listId + '-text').textContent, '1 of 3 completed'); assert.strictEqual(dom.$('#' + listId + '-bar').style.width, '33%');
        var saves = e.save.calls.length;
        U.fireInline(items[0], 'click', m);
        assert.ok(items[0].classList.contains('checked')); assert.strictEqual(dom.$('#' + listId + '-text').textContent, '2 of 3 completed');
        var stored = e.chat.displays[r.id].args.items;
        assert.deepStrictEqual(stored[0], { label: 'Plan', checked: true }, 'string item promoted + persisted');
        assert.ok(e.chat.displays[r.id]._toggledAt > 0); assert.strictEqual(e.save.calls.length, saves + 1);
        assert.strictEqual(U.frag(m.renderDisplayPlaceholder(r.id)).querySelectorAll('.display-check-item.checked').length, 2, 'cache regenerated');
        assert.strictEqual(U.css(items[0].querySelector('.display-check-label'), 'text-decoration-line'), 'line-through');
        U.fireInline(items[2], 'click', m);
        assert.ok(dom.$('#' + listId + '-summary').classList.contains('all-done')); assert.strictEqual(dom.$('#' + listId + '-bar').style.width, '100%');
        U.fireInline(items[1], 'click', m);
        assert.strictEqual(stored[1].checked, false); assert.strictEqual(dom.$('#' + listId + '-summary').classList.contains('all-done'), false);
    }, { tags: ['unit'] });
    test('checklist without displayId (legacy) toggles DOM only and never saves', async function() {
        var e = await loadDisplay(), m = e.m;
        var dom = await mountDisplay(m.generateChecklist({ items: ['a', 'b'] }));
        var id = dom.$('.display-checklist').id; assert.match(id, /^dcl_\d+_/); assert.strictEqual(dom.$('.display-checklist').hasAttribute('data-display-id'), false);
        U.fireInline(dom.$$('.display-check-item')[1], 'click', m);
        assert.strictEqual(dom.$('#' + id + '-text').textContent, '1 of 2 completed'); assert.strictEqual(e.save.calls.length, 0);
    }, { tags: ['unit'] });
    test('status_summary: named colors map to tokens, unsafe colors dropped, count/value fallback + escaping', async function() {
        var e = await loadDisplay(), m = e.m;
        var dom = await mountDisplay(m.generateStatusSummary({ items: [{ label: 'Open', count: 0, color: 'green', icon: '✓' }, { label: 'Bad ' + HOSTILE, value: 'v<1>', color: 'red;background:url(x)" onmouseover="x' }, { label: 'Hex', count: 3, color: '#ff0000' }] }));
        var cards = dom.$$('.display-status-card');
        assert.strictEqual(cards[0].style.getPropertyValue('--status-accent').trim(), 'var(--success)');
        assert.strictEqual(cards[0].querySelector('.display-status-count').textContent, '0', 'zero is rendered'); assert.strictEqual(cards[0].querySelector('.display-status-icon').textContent, '✓');
        assert.strictEqual(cards[1].hasAttribute('style'), false, 'unsafe color → no accent'); assert.strictEqual(cards[1].querySelector('.display-status-count').textContent, 'v<1>');
        assert.strictEqual(dom.$('[onmouseover], img, script'), null); assert.strictEqual(cards[1].querySelector('.display-status-label').textContent, 'Bad ' + HOSTILE);
        assert.strictEqual(cards[2].style.getPropertyValue('--status-accent').trim(), '#ff0000');
    }, { tags: ['unit'] });
    test('code: copy button copies code without line numbers, shows Copied! then reverts', async function() {
        var e = await loadDisplay(), m = e.m;
        var src = 'function f() {\n  return "<b>";\n}';
        var dom = await mountDisplay(m.generateCode({ code: src, language: 'js<' }));
        assert.strictEqual(dom.$('.display-code-lang').textContent, 'js<'); assert.strictEqual(dom.$('pre b'), null);
        assert.deepStrictEqual(texts(dom.$$('.display-line-num')), ['1', '2', '3']);
        var btn = dom.$('button.display-code-copy');
        assert.strictEqual(U.a11y(btn).name, 'Copy');
        U.fireInline(btn, 'click', m);
        assert.deepStrictEqual(e.clip.writes, [src], 'exact code, indentation kept');
        await U.flush();
        assert.ok(btn.classList.contains('copied')); assert.strictEqual(btn.querySelector('span').textContent, 'Copied!');
        await wait(1600);
        assert.strictEqual(btn.classList.contains('copied'), false); assert.strictEqual(btn.querySelector('span').textContent, 'Copy');
        m.displayCopyCode('missing-id', btn); assert.strictEqual(e.clip.writes.length, 1, 'missing <pre> → no write');
        assert.strictEqual(m.generateCode({ code: '' }), null);
    }, { tags: ['unit'] });
    test('timeline: time fallbacks, color class sanitised, detail events expand on click', async function() {
        var e = await loadDisplay(), m = e.m;
        var dom = await mountDisplay(m.generateTimeline({ events: [{ time: '10:00', title: 'Start' }, { date: '2026-01-01', title: 'Mid', detail: 'More <i>', color: 'green' }, { timestamp: 'T', label: 'End', description: 'd', color: 'red" x="' }] }));
        var ev = dom.$$('.display-tl-event');
        assert.deepStrictEqual(texts(dom.$$('.display-tl-time')), ['10:00', '2026-01-01', 'T']);
        assert.strictEqual(ev[0].hasAttribute('onclick'), false); assert.strictEqual(ev[0].querySelector('.display-tl-chevron'), null);
        assert.ok(ev[1].classList.contains('display-tl-green')); assert.strictEqual(ev[2].className, 'display-tl-event has-detail');
        assert.strictEqual(dom.$('[x], i'), null); assert.strictEqual(ev[2].querySelector('.display-tl-title').textContent, 'End▾');
        var det = ev[1].querySelector('.display-tl-detail');
        assert.strictEqual(U.css(det, 'display'), 'none'); U.fireInline(ev[1], 'click', m);
        assert.ok(ev[1].classList.contains('expanded')); assert.strictEqual(U.css(det, 'display'), 'block');
        assert.strictEqual(m.generateTimeline({ events: [] }), null);
    }, { tags: ['unit'] });
    test('chart: bar widths relative to max + safe custom colors; pie conic-gradient + legend percentages', async function() {
        var e = await loadDisplay(), m = e.m;
        var dom = await mountDisplay(m.generateChart({ chart_type: 'bar', data: [{ label: 'A "q"', value: 10, color: 'green' }, { label: '<b>B</b>', value: 5, color: 'x;y:"z' }, { label: 'C', value: 0 }] }));
        var fills = dom.$$('.display-bar-fill');
        assert.deepStrictEqual(fills.map(function(f) { return f.style.width; }), ['100%', '50%', '0%']);
        assert.match(fills[0].getAttribute('style'), /background:var\(--success\)/); assert.strictEqual(/background/.test(fills[1].getAttribute('style')), false);
        assert.strictEqual(dom.$$('.display-bar-label')[0].getAttribute('title'), 'A "q"'); assert.strictEqual(dom.$('.display-bar-label b'), null);
        assert.deepStrictEqual(texts(dom.$$('.display-bar-value')), ['10', '5', '0']);
        U.cleanupAll();
        var pie = await mountDisplay(m.generateChart({ chart_type: 'pie', labels: ['X', 'Y'], values: [1, 3] }));
        assert.match(pie.$('.display-pie').getAttribute('style'), /conic-gradient\(var\(--primary\) 0deg 90deg,var\(--success\) 90deg 360deg\)/);
        assert.strictEqual(pie.$('.display-pie-total').textContent, '4');
        assert.deepStrictEqual(texts(pie.$$('.display-pie-legend li')), ['X — 1 (25.0%)', 'Y — 3 (75.0%)']);
        assert.strictEqual(m.generateChart({ values: [] }), null);
    }, { tags: ['unit'] });
    test('diff: +/- markers, line numbers skip deletions, hostile types become context, stats; old/new text mode', async function() {
        var e = await loadDisplay(), m = e.m;
        var dom = await mountDisplay(m.generateDiff({ file: 'a<b>.js', changes: ['same', '+added', '-removed', { type: 'add" onmouseover="x', text: '<b>h</b>' }, null, 5] }));
        var lines = dom.$$('.display-diff-line');
        assert.deepStrictEqual(lines.map(function(l) { return l.className.replace('display-diff-line display-diff-', ''); }), ['ctx', 'add', 'del', 'ctx']);
        assert.deepStrictEqual(texts(dom.$$('.display-diff-num')), ['1', '2', '', '3']);
        assert.deepStrictEqual(texts(dom.$$('.display-diff-content')), ['  same', '+ added', '- removed', '  <b>h</b>']);
        assert.strictEqual(dom.$('.display-diff-file').textContent, 'a<b>.js'); assert.strictEqual(dom.$('[onmouseover], .display-diff-content b'), null);
        assert.strictEqual(dom.$('.display-diff-stat-add').textContent, '+1'); assert.strictEqual(dom.$('.display-diff-stat-del').textContent, '−1');
        U.cleanupAll();
        var d2 = await mountDisplay(m.generateDiff({ old_text: 'a\nb', new_text: 'a\nc\nd' }));
        assert.deepStrictEqual(texts(d2.$$('.display-diff-content')), ['  a', '- b', '+ c', '+ d']);
        assert.strictEqual(d2.$('.display-diff-file').textContent, 'Changes'); assert.strictEqual(d2.$('.display-diff-stat-add').textContent, '+2');
        assert.strictEqual(m.generateDiff({}), null);
    }, { tags: ['unit'] });
    // PRODUCT BUG (090-display-templates.js:382): codeId = 'dcode_' + Date.now()
    // — two code displays generated in the same millisecond share one DOM id, so
    // the second block's Copy button copies the FIRST block (getElementById).
    test('each code display copies its own code (unique ids)', async function() {
        var e = await loadDisplay(), m = e.m, a, b;
        for (var i = 0; i < 1000; i++) { a = m.generateCode({ code: 'AAA' }); b = m.generateCode({ code: 'BBB' }); if (U.frag(a).querySelector('pre').id === U.frag(b).querySelector('pre').id) break; }
        var dom = await mountDisplay(a + b);
        U.fireInline(dom.$$('button.display-code-copy')[1], 'click', m);
        assert.deepStrictEqual(e.clip.writes, ['BBB']);
    }, { tags: ['unit'] });
    // escDisplay must also escape `'` so its output is safe inside a single-quoted
    // attribute; the rendered text of ordinary content stays identical.
    test('escDisplay escapes single quotes (attribute-safe) without changing rendered text', async function() {
        var e = await loadDisplay(), m = e.m;
        assert.strictEqual(m.escDisplay("it's <b>\"x\"</b> & y"), 'it&#39;s &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; y');
        var el = U.frag("<span title='" + m.escDisplay("a' onmouseover='window.__pwnQ=1") + "'>t</span>").querySelector('span');
        assert.strictEqual(el.getAttributeNames().join(','), 'title', 'no attribute injected');
        assert.strictEqual(el.getAttribute('title'), "a' onmouseover='window.__pwnQ=1");
        var r = m.executeDisplay({ template: 'checklist', items: ["Don't forget"] }, 0, { chatId: 'c1' });
        var dom = await mountDisplay(m.renderDisplayPlaceholder(r.id));
        assert.strictEqual(dom.$('.display-check-label').textContent, "Don't forget", 'rendered text unchanged');
    }, { tags: ['unit'] });
    // PRODUCT BUG (090-display-templates.js:403): clipboard.writeText(...).then()
    // has no rejection handler — a denied clipboard is an unhandled rejection and
    // the button gives no feedback at all.
    test('code copy gives feedback when the clipboard write is denied', async function() {
        var e = await loadDisplay(), m = e.m; e.clip.mode = 'fail';
        var dom = await mountDisplay(m.generateCode({ code: 'x' }));
        var btn = dom.$('button.display-code-copy'); U.fireInline(btn, 'click', m); await U.flush();
        assert.deepStrictEqual(e.snack.calls, [['Copy failed', 'error']], 'same snackbar feedback as copyCodeBlock');
        assert.strictEqual(btn.classList.contains('copied'), false);
    }, { tags: ['unit'] });
    // PRODUCT BUG (090-display-templates.js:182, :257, :301, :424): sortable <th>,
    // checklist items and expandable cards/timeline events are click-only
    // (no tabindex / role / key handler) — unusable from the keyboard.
    test('interactive display controls are keyboard-accessible', async function() {
        var e = await loadDisplay(), m = e.m;
        var dom = await mountDisplay(m.generateTable({ columns: ['A'], rows: [['1']] }) + m.generateChecklist({ items: ['a'] }) + m.generateCardList({ cards: [{ title: 't', detail: 'd' }] })
            + m.generateTimeline({ events: [{ title: 'e', detail: 'd' }] }));
        var els = { th: dom.$('th'), checkItem: dom.$('.display-check-item'), card: dom.$('.display-card.has-detail'), tlEvent: dom.$('.display-tl-event.has-detail') };
        var notFocusable = Object.keys(els).filter(function(k) { assert.ok(els[k], k + ' rendered'); return !U.a11y(els[k]).focusable; });
        assert.deepStrictEqual(notFocusable, []);
        U.fireInline(els.card, 'keydown', m, { key: 'Enter' }); assert.ok(els.card.classList.contains('expanded'), 'Enter expands card');
        U.fireInline(els.checkItem, 'keydown', m, { key: ' ' }); assert.strictEqual(els.checkItem.getAttribute('aria-checked'), 'true', 'Space toggles checklist');
    }, { tags: ['unit'] });
});
