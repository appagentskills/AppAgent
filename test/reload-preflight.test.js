// Real Reload functions, fake DOM/locks/tool bridges only. Never build or reload Chrome.
async function runReloadPreflightTests(sources) {
    var passed = [];
    function check(name, condition) { if (!condition) throw new Error(name); passed.push(name); }
    function good(file) {
        return { success: true, files: [{ file: file, status: 'pass', passed: 2, failed: 0, skipped: 0, no_assertions: 0 }], summary: { files: 1, total: 2, passed: 2, failed: 0, skipped: 0, no_assertions: 0 }, isolation: { ok: true, host_verified: true }, denied_calls: [] };
    }
    function deferred() { var resolve; var promise = new Promise(function(r) { resolve = r; }); return { promise: promise, resolve: resolve }; }
    async function until(predicate) { for (var i = 0; i < 1000 && !predicate(); i++) await Promise.resolve(); if (!predicate()) throw new Error('fixture did not settle'); }
    function setup(opts) {
        opts = opts || {};
        var doc, calls = [], timers = [], rows = [], buttons = {}, notices = [], approvalCalls = [], serial = 0;
        function el(tag) {
            var x = { tag: tag, className: '', textContent: '', children: [], dataset: {}, disabled: false, hidden: false, checked: false, isConnected: true, handlers: {}, style: {},
                appendChild: function(child) { this.children.push(child); child.parent = this; if (child.className === 'reload-preflight-row') rows.push(child); },
                setAttribute: function(k, v) { this[k] = v; }, addEventListener: function(k, fn) { this.handlers[k] = fn; },
                focus: function() { doc.activeElement = this; }, remove: function() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(function(c) { return c !== x; }); },
                click: function() { if (!this.disabled && this.handlers.click) this.handlers.click(); }
            }; return x;
        }
        doc = { createElement: el, body: el('body'), getElementById: function(id) { return buttons[id] || null; } };
        buttons['ext-reload-btn'] = el('button'); buttons['home-ext-reload-btn'] = el('button'); doc.activeElement = buttons['ext-reload-btn'];
        function descendants(x) { return [x].concat(x.children.flatMap(descendants)); }
        function find(text) { return descendants(doc.body).find(function(e) { return e.tag === 'button' && e.textContent === text; }); }
        var metas = [{ repo: 'example-org/AppAgent::main', pinned: true, head_sha: 'abc', branch: 'main' }];
        var files = [{ path: 'src/a.js', sha: 'a', dirty: true, content: 'old' }];
        var locks = opts.locks || { held: false, request: async function(name, options, fn) { if (this.held) return fn(null); this.held = true; try { return await fn({ name: name }); } finally { this.held = false; } } };
        var timer = function(fn, ms) { var t = { fn: fn, ms: ms, cleared: false }; timers.push(t); if (ms < 1000) Promise.resolve().then(function() { if (!t.cleared) fn(); }); return t; };
        var api = new Function('document', 'navigator', 'window', 'chrome', 'runningChatIds', 'showConfirmModal', 'escapeHtml', 'showSnackbar', 'isSkillTool', 'getDeployDirHandle', 'executeTool', 'getAllWorkspaceMetas', 'getWorkspaceMeta', 'getAllWorkspaceFiles', 'crypto', 'TextEncoder', 'AbortController', 'setTimeout', 'clearTimeout', 'closeDatabase', sources['src/js/ui/270-iframe-panel.js'] + '\nreturn { reload: reloadExtension, checklist: _reloadChecklist, gate: _runReloadPreflight, normalize: _reloadSuiteResult, fingerprint: _reloadFingerprint, files: RELOAD_PREFLIGHT_FILES, busy: function() { return _reloadInFlight; } };')(
            doc, opts.noLocks ? {} : { locks: locks }, { addEventListener: function() {}, location: { reload: function() { calls.push('page-reload'); } } },
            { runtime: { reload: function() { calls.push('reload'); } }, storage: { local: { set: function(_, cb) { calls.push('storage'); cb(); } } } }, opts.running ? { a: true } : {},
            async function(title) { calls.push('confirm:' + title); return opts.confirm !== false; }, function(s) { return s; }, function(s) { notices.push(s); }, function() { return !opts.noBuild; }, async function() { return {}; },
            async function(name, args, index, host) {
                calls.push(name); approvalCalls.push({ name: name, args: args, host: host });
                if (name === 'extension_build') return opts.badBuild ? { success: false, error: 'artifact validation failed' } : { success: true, stats: { jsFiles: 1, filesDeployed: 1 }, built_from: args.workspace };
                serial++;
                if (opts.run) return opts.run(args, host, serial, { files: files, metas: metas });
                return good(args.files[0]);
            }, async function() { return metas; }, async function() { return opts.noMeta ? null : metas[0]; }, async function() { return files; },
            { subtle: { digest: async function(_, bytes) { return bytes.buffer; } } }, TextEncoder, AbortController, timer, function(t) { if (t) t.cleared = true; }, function() { calls.push('close-db'); }
        );
        return { api: api, calls: calls, rows: rows, find: find, elements: function() { return descendants(doc.body); }, doc: doc, buttons: buttons, notices: notices, approvals: approvalCalls, files: files, metas: metas, timers: timers, locks: locks };
    }
    // Render actual production functions, never a duplicated view or a real build.
    var view = setup(), controller = new AbortController(), ui = view.api.checklist(controller);
    function byClass(cls) { return view.elements().filter(function(e) { return e.className.split(' ').indexOf(cls) >= 0; }); }
    function text() { return view.elements().filter(function(e) { return !e.hidden; }).map(function(e) { return e.textContent; }).join('\n'); }
    check('initial title and accessible zero progress', text().includes('Checking before Reload') && byClass('reload-preflight-progress')[0].value === 0 && byClass('reload-preflight-progress')[0]['aria-label'] === 'Suites complete');
    check('initial five pending disabled unchecked indicators', view.rows.length === 5 && view.rows.every(function(r) { return r.dataset.state === 'pending' && r.children[0].children[0].disabled && !r.children[0].children[0].checked; }));
    check('friendly labels primary and filenames under native details', ['Policy checks', 'Test runner', 'Sandbox lifecycle', 'Test harness', 'Reload checks'].every(function(label, i) { return view.rows[i].children[0].children[2].textContent === label && byClass('reload-preflight-file')[i].parent.tag === 'details' && byClass('reload-preflight-file')[i].textContent === view.api.files[i]; }));
    check('per-suite disclosure has accessible name', byClass('reload-preflight-details')[0].children[0]['aria-label'] === 'Details for Policy checks');
    check('coverage technical details collapsed and explicit', byClass('reload-preflight-technical')[0].tag === 'details' && !byClass('reload-preflight-technical')[0].open && text().includes('Contract and runtime layers are unsupported'));
    ui.status('Workspace: example-org/AppAgent::main');
    check('workspace retained only in technical disclosure', byClass('reload-preflight-workspace')[0].textContent === 'Workspace: example-org/AppAgent::main' && byClass('reload-preflight-status')[0].textContent.indexOf('example-org') < 0);
    ui.update(0, 'running', 'Running supported assertions…');
    check('running does not complete progress or enable Force', byClass('reload-preflight-progress')[0].value === 0 && view.find('Force build').hidden && view.find('Force build').disabled && byClass('reload-preflight-state')[0].textContent === 'Running');
    check('running checkbox has accessible read-only state', view.rows[0].children[0].children[0]['aria-label'] === 'Policy checks: Running' && view.rows[0].children[0].children[0].disabled);
    ui.update(0, 'pass', '105 passed; 0 failed; 0 skipped (unchecked)\n[]');
    check('pass checked and counted without raw arrays or unchecked suffix', view.rows[0].children[0].children[0].checked && byClass('reload-preflight-progress')[0].value === 1 && byClass('reload-preflight-counts')[0].textContent === '105 passed · 0 failed · 0 skipped' && !text().includes('[]') && !text().includes('(unchecked)'));
    check('empty error content hidden', byClass('reload-preflight-detail')[0].hidden && byClass('reload-preflight-message')[0].hidden);
    ui.update(1, 'fail', '1 passed; 2 failed; 0 skipped (unchecked)\nAssertion failed: <img src=x onerror=alert(1)>\n[{"name":"<script>bad</script>","error":"Expected true"}]');
    check('finished failure counts toward progress and stays unchecked', byClass('reload-preflight-progress')[0].value === 2 && byClass('reload-preflight-progress-text')[0].textContent.includes('1 failed') && !view.rows[1].children[0].children[0].checked);
    check('useful failure visible and markup remains inert text', byClass('reload-preflight-message')[1].textContent.includes('<img') && !byClass('reload-preflight-message')[1].hidden && byClass('reload-preflight-detail')[1].textContent.includes('  "name"') && !view.elements().some(function(e) { return e.tag === 'img' || e.tag === 'script'; }));
    ui.update(1, 'fail', 'x'.repeat(600));
    check('long errors compact in summary but complete in disclosure', byClass('reload-preflight-message')[1].textContent.length === 241 && byClass('reload-preflight-detail')[1].textContent.length === 600);
    ui.update(2, 'skipped', '0 passed; 0 failed; 1 skipped (unchecked)\ncontract layer unsupported');
    ui.update(3, 'error', 'Permission denied'); ui.update(4, 'skipped', 'Not run');
    check('skips not passes, not-run is not a completed execution', !view.rows[2].children[0].children[0].checked && byClass('reload-preflight-state')[2].textContent === 'Skipped' && byClass('reload-preflight-state')[4].textContent === 'Not run' && byClass('reload-preflight-progress')[0].value === 4);
    check('permission error visible without invented counts', byClass('reload-preflight-message')[3].textContent === 'Permission denied' && byClass('reload-preflight-counts')[3].hidden && byClass('reload-preflight-progress-text')[0].textContent.includes('1 error'));
    ui.failure('Host cleanup did not settle; Force is unavailable.', false);
    view.find('Force build').click();
    check('unsettled failure exposes disabled Force and cannot decide', !view.find('Force build').hidden && view.find('Force build').disabled && !controller.signal.aborted && !ui.cancelled());
    var overlay = view.doc.body.children[0], prevented = false, stopped = false;
    var summary = byClass('reload-preflight-details')[0].children[0];
    overlay.handlers.keydown({ key: 'Enter', target: summary, preventDefault: function() { prevented = true; }, stopPropagation: function() { stopped = true; } });
    check('native Details keyboard activation retained without bubbling Enter', !prevented && stopped);
    view.find('Cancel').focus();
    overlay.handlers.keydown({ key: 'Tab', preventDefault: function() {}, stopPropagation: function() {} });
    check('focus cycle includes Details and excludes disabled Force', view.doc.activeElement === summary);
    overlay.handlers.keydown({ key: 'Tab', shiftKey: true, preventDefault: function() {}, stopPropagation: function() {} });
    check('reverse focus cycle returns to Cancel', view.doc.activeElement === view.find('Cancel'));
    ui.failure('Cancel or explicitly Force build.', true);
    check('settled failure preserves explicit Force availability', !view.find('Force build').disabled);
    view.find('Cancel').click();
    check('cancel still aborts controller and resolves cancellation', controller.signal.aborted && ui.cancelled() && await ui.decision === 'cancel');
    ui.close();
    check('closing restores prior focused Reload button', view.doc.activeElement === view.buttons['ext-reload-btn'] && view.doc.body.children.length === 0);
    view = setup(); ui = view.api.checklist(new AbortController());
    view.api.files.forEach(function(_, i) { ui.update(i, 'pass', '2 passed; 0 failed; 0 skipped (unchecked)'); });
    check('all completed rows do not preempt workspace validation success', byClass('modal-header')[0].textContent === 'Checking before Reload…');
    ui.status('All five supported suites passed — building example-org/AppAgent::main');
    check('validated all-pass state clear before build', byClass('modal-header')[0].textContent === 'All checks passed' && byClass('reload-preflight-progress')[0].value === 5 && byClass('reload-preflight-status')[0].textContent === 'Building the checked workspace…');
    ui.update(0, 'error', 'Workspace changed — previous results are stale.'); ui.failure('Workspace changed', true);
    check('stale success loses check and green heading', !view.rows[0].children[0].children[0].checked && byClass('modal-header')[0].textContent === 'Checks need attention');
    ui.close();
    var h = setup(), promise = h.api.reload();
    check('page guard and both disabled buttons set synchronously', !!h.api.busy() && h.buttons['ext-reload-btn'].disabled && h.buttons['home-ext-reload-btn'].disabled);
    check('same-page duplicate returns same flight', promise === h.api.reload());
    await promise;
    check('exact sequential test/build/cleanup/reload order', JSON.stringify(h.calls) === JSON.stringify(['run_tests', 'run_tests', 'run_tests', 'run_tests', 'run_tests', 'extension_build', 'close-db', 'storage', 'reload']));
    check('successful suites show checked read-only pass indicators', h.rows.length === 5 && h.rows.every(function(r) { return r.dataset.state === 'pass' && r.children[0].children[0].checked && r.children[0].children[0].disabled; }));
    check('suite file order and supported scope explicit', h.approvals.slice(0, 5).every(function(c, i) { return c.args.files[0] === h.api.files[i] && JSON.stringify(c.args.tags) === '["unit","canary"]'; }));
    check('tests use native options; only existing build uses fromSandbox', h.approvals.slice(0, 5).every(function(c) { return !c.host.fromSandbox && c.host._runTestsAbortSignal && !c.args.force && !c.args.trustedUI; }) && h.approvals[5].host.fromSandbox === true);
    check('workspace is frozen identically for tests and build', h.approvals.every(function(c) { return c.args.workspace === 'example-org/AppAgent::main'; }));
    check('success releases origin lock and page buttons', !h.api.busy() && !h.locks.held && !h.buttons['ext-reload-btn'].disabled && !h.buttons['home-ext-reload-btn'].disabled);
    var file = h.api.files[0];
    var mutations = [
        ['false success', function(r) { r.success = false; }, 'error'],
        ['aborted envelope', function(r) { r.aborted = true; }, 'error'],
        ['assertion failure', function(r) { r.files[0].status = 'fail'; r.files[0].failed = r.summary.failed = 1; r.summary.total++; }, 'fail'],
        ['isolation false', function(r) { r.isolation.ok = false; }, 'error'],
        ['unverified isolation', function(r) { delete r.isolation.host_verified; }, 'error'],
        ['host denial', function(r) { r.denied_calls.push({ tool: 'workspace' }); }, 'error'],
        ['no assertions', function(r) { r.summary.no_assertions = 1; }, 'error'],
        ['empty execution', function(r) { r.files[0].passed = r.summary.passed = r.summary.total = 0; }, 'error'],
        ['wrong suite', function(r) { r.files[0].file = 'other'; }, 'error'],
        ['missing summary', function(r) { delete r.summary; }, 'error'],
        ['bad count', function(r) { r.files[0].passed = -1; }, 'error'],
        ['empty files', function(r) { r.files = []; }, 'error'],
        ['unsupported only', function(r) { r.files[0].passed = r.summary.passed = 0; r.files[0].skipped = r.summary.skipped = r.summary.total = 1; }, 'skipped'],
        ['unexpected supported skip', function(r) { r.files[0].skipped = r.summary.skipped = 1; r.summary.total++; r.files[0].skips = [{ reason: 'disabled' }]; }, 'error']
    ];
    for (var m of mutations) { var r = good(file); m[1](r); check('normalization blocks ' + m[0], h.api.normalize(r, file).state === m[2]); }
    var startup = good(file); startup.success = false; startup.files[0].status = 'error'; startup.files[0].passed = startup.summary.passed = 0; startup.files[0].error = 'SyntaxError: Unexpected token < in suite'; startup.summary.failed = 1; startup.summary.total = 1;
    var diagnostic = h.api.normalize(startup, file);
    check('actual runner startup shape remains fail-closed with original diagnostic', diagnostic.state === 'error' && diagnostic.detail.includes('Malformed or incomplete test result') && diagnostic.detail.includes(startup.files[0].error));
    view = setup(); ui = view.api.checklist(new AbortController()); ui.update(0, diagnostic.state, diagnostic.detail);
    check('original startup diagnostic rendered as text without green or Force', byClass('reload-preflight-detail')[0].textContent.includes(startup.files[0].error) && byClass('reload-preflight-message')[0].textContent === startup.files[0].error && !view.rows[0].children[0].children[0].checked && view.find('Force build').hidden && view.find('Force build').disabled);
    ui.close();
    var mixed = good(file); mixed.files[0].skipped = mixed.summary.skipped = 1; mixed.summary.total++; mixed.files[0].skips = [{ reason: 'contract layer unsupported' }];
    check('supported pass with explicit unsupported exclusion remains honest', h.api.normalize(mixed, file).state === 'pass' && h.api.normalize(mixed, file).detail.indexOf('1 skipped (unchecked)') >= 0);
    for (var mode of ['force', 'cancel', 'throw', 'denied']) {
        h = setup({ run: function(args) { if (mode === 'throw') throw new Error('startup unavailable'); return { success: false, error: mode === 'denied' ? 'Permission denied' : 'Failed', files: [] }; } });
        promise = h.api.reload(); await until(function() { return h.find('Force build') && !h.find('Force build').hidden; });
        check(mode + ': failure never automatically builds', h.calls.indexOf('extension_build') < 0 && h.rows[0].dataset.state === 'error' && h.rows.slice(1).every(function(r) { return r.dataset.state === 'skipped'; }));
        var overlay = h.doc.body.children[0], prevented = false;
        overlay.handlers.keydown({ key: 'Enter', preventDefault: function() { prevented = true; }, stopPropagation: function() {} });
        check(mode + ': Enter cannot implicitly force', prevented && h.calls.indexOf('extension_build') < 0);
        h.find(mode === 'force' || mode === 'throw' ? 'Force build' : 'Cancel').click(); await promise;
        check(mode + ': only explicit force reaches same build', (h.calls.indexOf('extension_build') >= 0) === (mode === 'force' || mode === 'throw'));
        check(mode + ': permissions never retried or granted', h.calls.filter(function(c) { return c === 'run_tests'; }).length === 1 && h.approvals.every(function(c) { return !c.args.force && !c.args.confirm; }));
    }
    // Cancel while an approval is pending: late dispatcher receives aborted signal.
    var approval = deferred(), approvalHost;
    h = setup({ run: function(args, host) { approvalHost = host; return approval.promise; } }); promise = h.api.reload();
    await until(function() { return !!approvalHost; });
    check('pending/running states distinct and Force absent while active', h.rows[0].dataset.state === 'running' && h.rows[1].dataset.state === 'pending' && h.find('Force build').disabled);
    h.find('Cancel').click(); await until(function() { return approvalHost._runTestsAbortSignal.aborted; });
    approval.resolve({ success: false, error: 'cancelled before dispatch' }); await promise;
    check('approval cancel aborts host and never builds/reloads', h.calls.indexOf('extension_build') < 0 && h.calls.indexOf('reload') < 0 && !h.api.busy());
    // Startup cancellation before even dispatching a test.
    h = setup(); promise = h.api.gate(); h.find('Cancel').click(); await promise;
    check('cancel before dispatch never calls a tool', h.calls.length === 0 && h.doc.body.children.length === 0);
    // Deadline: Force remains disabled until runner result/cleanup has settled.
    var hanging = deferred(), timeoutHost;
    h = setup({ run: function(args, host) { timeoutHost = host; return hanging.promise; } }); promise = h.api.reload();
    await until(function() { return !!timeoutHost; });
    h.timers.find(function(t) { return t.ms === 135000 && !t.cleared; }).fn();
    await until(function() { return timeoutHost._runTestsAbortSignal.aborted; });
    check('deadline revokes through native signal before force is available', h.find('Force build').disabled && h.calls.indexOf('extension_build') < 0);
    hanging.resolve({ success: false, error: 'timeout cleanup complete' });
    await until(function() { return !h.find('Force build').hidden; });
    h.find('Force build').click(); await promise;
    check('settled timeout permits explicit force only', h.calls.indexOf('extension_build') >= 0);
    // Unsettled approval/cleanup cannot expose Force, and late completion is inert.
    var late = deferred(), lateHost;
    h = setup({ run: function(args, host) { lateHost = host; return late.promise; } }); promise = h.api.reload();
    await until(function() { return !!lateHost; });
    h.timers.find(function(t) { return t.ms === 135000 && !t.cleared; }).fn();
    await until(function() { return h.timers.some(function(t) { return t.ms === 12000 && !t.cleared; }); });
    h.timers.find(function(t) { return t.ms === 12000 && !t.cleared; }).fn();
    await until(function() { return !h.find('Force build').hidden; });
    check('unsettled host never enables Force after cleanup bound', h.find('Force build').disabled && lateHost._runTestsAbortSignal.aborted);
    h.find('Cancel').click(); await promise;
    late.resolve(good(h.api.files[0])); await Promise.resolve(); await Promise.resolve();
    check('late result after cancelled gate cannot build or repaint removed dialog', h.calls.indexOf('extension_build') < 0 && h.doc.body.children.length === 0);
    // Different panel cannot queue a second automatic build.
    var blocker = deferred(); h = setup({ run: function(args, host, count) { return count === 1 ? blocker.promise : good(args.files[0]); } }); promise = h.api.reload();
    await until(function() { return h.calls.length > 0; });
    var second = setup({ locks: h.locks }); await second.api.reload();
    check('origin-wide lock rejects second panel without running tools', second.calls.length === 0 && second.notices.some(function(s) { return s.indexOf('another panel') >= 0; }));
    blocker.resolve(good(h.api.files[0])); await promise;
    h = setup({ noLocks: true }); await h.api.reload();
    check('no Web Locks fails closed without deploying', !h.calls.length && h.notices.some(function(s) { return s.indexOf('Web Locks') >= 0; }));
    for (var change of ['content', 'pin']) {
        h = setup({ run: function(args, host, count, state) { if (count === 5) { if (change === 'content') state.files[0].content = 'new'; else state.metas.unshift({ repo: 'example-org/AppAgent::fork', pinned: true, head_sha: 'abc' }); } return good(args.files[0]); } });
        promise = h.api.reload(); await until(function() { return h.find('Force build') && !h.find('Force build').hidden; });
        check(change + ': changed workspace invalidates green before build', h.calls.indexOf('extension_build') < 0 && h.rows.every(function(r) { return !r.children[0].children[0].checked && r.dataset.state === 'error'; }));
        h.find('Cancel').click(); await promise;
    }
    h = setup({ badBuild: true, confirm: false }); await h.api.reload();
    check('artifact failure is separate previous-artifact dialog and aborts reload', h.calls.indexOf('confirm:Extension rebuild failed') >= 0 && h.calls.indexOf('reload') < 0);
    h = setup({ running: true, confirm: false }); await h.api.reload();
    check('active-run warning cancel releases lock before tests', h.calls.length === 1 && h.calls[0] === 'confirm:Reload extension?' && !h.locks.held);
    h = setup({ noMeta: true }); promise = h.api.reload(); await until(function() { return h.find('Force build') && !h.find('Force build').hidden; }); h.find('Cancel').click(); await promise;
    check('missing workspace metadata never silently green', h.calls.indexOf('extension_build') < 0);
    var css = sources['src/css/14-modals.css'];
    check('compact bounded scroll body and persistent footer styled', css.includes('max-width: 580px') && css.includes('min-height: 0; overflow-y: auto') && css.includes('.reload-preflight .modal-actions { flex: 0 0 auto'));
    check('narrow panel responsive rows and reduced motion scoped', css.includes('@media (max-width: 420px)') && css.includes('@media (prefers-reduced-motion: reduce) { .reload-preflight .reload-preflight-spinner { animation: none; } }'));
    check('checked and running indicators scoped with theme tokens', css.includes('.reload-preflight .reload-preflight-check:checked { background: var(--success)') && css.includes('.reload-preflight .reload-preflight-row[data-state="running"] .reload-preflight-spinner { display: block; }'));
    return passed;
}
var PATHS = ['src/js/ui/270-iframe-panel.js', 'src/css/14-modals.css'];
await registerRunner('reload-preflight', async function() { return runReloadPreflightTests(await loadSources(PATHS)); });
