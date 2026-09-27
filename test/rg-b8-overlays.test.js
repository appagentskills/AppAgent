// RG-B8 / TA4-1 — the Reload pre-flight checklist (270-iframe-panel.js _reloadChecklist)
// cancels on a backdrop click only when the mousedown ALSO started on the backdrop, so a
// text-selection drag from the dialog released outside it does not cancel the Reload.
// The untrusted paths still cancel: the global Esc sweep's onclick({target}) replay
// (core/120-init.js) and a programmatic .click(). A browser (isTrusted) click cannot be
// synthesized, so after a REAL mousedown it is passed to onclick as a trusted-shaped event.
// The diff-viewer twin (100-diff-viewer.js) and TA4-5 live in test/ui-header-diff-files.test.js.
// Run: run_tests { files: ['test/rg-b8-overlays.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
var ANY_UNSTUBBED = { indexOf: function() { return 0; } };

describe('reload pre-flight overlay › TA4-1 backdrop press guard (270-iframe-panel.js)', function() {
    var M = null, opened = [];
    afterEach(function() {
        opened.forEach(function(ui) { ui.close(); });
        opened = [];
        Array.prototype.forEach.call(document.querySelectorAll('.reload-preflight'), function(o) { o.remove(); });
    });
    async function checklist() {
        if (!M) M = await U.loadUi(['src/js/ui/270-iframe-panel.js'], { globals: { window: fakeWindow({ document: document }) }, lenient: true, allowUnstubbed: ANY_UNSTUBBED });
        var c = { aborts: 0 };
        c.ui = M._reloadChecklist({ abort: function() { c.aborts++; } });
        opened.push(c.ui);
        var all = document.querySelectorAll('.reload-preflight');
        assert.strictEqual(all.length, 1, 'one checklist overlay mounted');
        c.ov = all[0];
        c.dialog = c.ov.querySelector('.modal-dialog');
        assert.ok(c.dialog, 'dialog present');
        return c;
    }
    function press(el) { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); }

    test('mousedown in the dialog + trusted backdrop click does NOT cancel; mousedown + click on the backdrop cancels once', async function() {
        var c = await checklist();
        press(c.dialog.querySelector('.reload-preflight-status'));
        c.ov.onclick({ target: c.ov, isTrusted: true });
        assert.strictEqual(c.ui.cancelled(), false, 'a drag from the dialog released on the backdrop keeps the checklist');
        assert.strictEqual(c.aborts, 0, 'no abort');
        assert.ok(c.ov.isConnected);
        press(c.ov);
        c.ov.onclick({ target: c.dialog, isTrusted: true });
        assert.strictEqual(c.ui.cancelled(), false, 'a click that lands inside the dialog never cancels');
        c.ov.onclick({ target: c.ov, isTrusted: true });
        assert.strictEqual(c.ui.cancelled(), true, 'backdrop mousedown + click cancels');
        assert.strictEqual(c.aborts, 1, 'controller aborted once');
        assert.strictEqual(await c.ui.decision, 'cancel');
    }, { tags: ['unit'] });

    test('the Esc-sweep replay onclick({target: ov}) still cancels after a mousedown in the dialog', async function() {
        var c = await checklist();
        press(c.dialog);
        c.ov.onclick({ target: c.ov }); // plain object, not isTrusted
        assert.strictEqual(c.ui.cancelled(), true);
        assert.strictEqual(c.aborts, 1);
        assert.strictEqual(await c.ui.decision, 'cancel');
    }, { tags: ['unit'] });

    test('a programmatic .click() on the backdrop still cancels; one bubbling from the dialog does not', async function() {
        var c = await checklist();
        press(c.dialog);
        c.dialog.click();
        assert.strictEqual(c.ui.cancelled(), false, 'a click bubbling from the dialog is ignored');
        assert.strictEqual(c.aborts, 0);
        c.ov.click(); // programmatic, untrusted
        assert.strictEqual(c.ui.cancelled(), true);
        assert.strictEqual(c.aborts, 1);
        assert.strictEqual(await c.ui.decision, 'cancel');
    }, { tags: ['unit'] });
});
