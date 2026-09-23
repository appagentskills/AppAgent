// Real Reload functions, fake DOM/locks/tool bridges only. Never build or reload Chrome.
// Shared fixture: used by the legacy runner and by the native tests at the end of this file.
function reloadFixture(sources) {
    function good(file) {
        // An array is ONE multi-file run_tests envelope: per-file entries plus a summed summary.
        if (Array.isArray(file)) {
            var list = file.map(function(f) { return good(f).files[0]; });
            return { success: true, files: list, summary: { files: list.length, total: 2 * list.length, passed: 2 * list.length, failed: 0, skipped: 0, no_assertions: 0 }, isolation: { ok: true, host_verified: true }, denied_calls: [] };
        }
        return { success: true, files: [{ file: file, status: 'pass', passed: 2, failed: 0, skipped: 0, no_assertions: 0 }], summary: { files: 1, total: 2, passed: 2, failed: 0, skipped: 0, no_assertions: 0 }, isolation: { ok: true, host_verified: true }, denied_calls: [] };
    }
    function deferred() { var resolve, reject; var promise = new Promise(function(r, j) { resolve = r; reject = j; }); return { promise: promise, resolve: resolve, reject: reject }; }
    async function until(predicate) { for (var i = 0; i < 1000 && !predicate(); i++) await Promise.resolve(); if (!predicate()) throw new Error('fixture did not settle'); }
    function setup(opts) {
        opts = opts || {};
        var doc, calls = [], timers = [], rows = [], buttons = {}, notices = [], approvalCalls = [], serial = 0;
        var logs = [], snacks = [], confirms = [], sets = [], held = [], removed = [], store = opts.store || null, modals = [], getHeld = [], deployCalls = 0;
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
        // Per-name fake Web Locks (ifAvailable semantics): `names` = held lock names, `held` = any lock held.
        var locks = opts.locks || { held: false, names: {}, request: async function(name, options, fn) { var self = this; if (self.names[name]) return fn(null); self.names[name] = true; self.held = true; try { return await fn({ name: name }); } finally { delete self.names[name]; self.held = Object.keys(self.names).length > 0; } } };
        var timer = function(fn, ms) { var t = { fn: fn, ms: ms, cleared: false }; timers.push(t); if (ms < 1000) Promise.resolve().then(function() { if (!t.cleared) fn(); }); return t; };
        var fakeConsole = {};
        ['info', 'warn', 'log', 'error'].forEach(function(level) { fakeConsole[level] = function() { logs.push(level + ':' + Array.prototype.slice.call(arguments).join(' ')); }; });
        // Default storage has only set(_, cb) (records 'storage'). opts.store adds get/remove over that object; opts.holdSet parks set callbacks.
        var local = { set: function(items, cb) { calls.push('storage'); sets.push(items); if (store) Object.assign(store, items); if (opts.holdSet) held.push({ items: items, cb: cb }); else if (cb) cb(); } };
        if (store) {
            local.get = function(key, cb) { if (opts.getThrows) throw new Error('storage unavailable'); if (opts.holdGet) { getHeld.push({ key: key, cb: cb }); return; } var out = {}; if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key]; cb(out); };
            local.remove = function(key, cb) { removed.push(key); delete store[key]; if (cb) cb(); };
        }
        var chromeFake = { runtime: { reload: function() { calls.push('reload'); } } };
        if (!opts.noStorage) chromeFake.storage = { local: local };
        var api = new Function('document', 'navigator', 'window', 'chrome', 'runningChatIds', 'showConfirmModal', 'escapeHtml', 'showSnackbar', 'isSkillTool', 'getDeployDirHandle', 'executeTool', 'getAllWorkspaceMetas', 'getWorkspaceMeta', 'getAllWorkspaceFiles', 'crypto', 'TextEncoder', 'AbortController', 'setTimeout', 'clearTimeout', 'closeDatabase', 'console', 'showModal', sources['src/js/ui/270-iframe-panel.js'] + '\nreturn { reload: reloadExtension, checklist: _reloadChecklist, gate: _runReloadPreflight, normalize: _reloadSuiteResult, fingerprint: _reloadFingerprint, files: RELOAD_PREFLIGHT_FILES, busy: function() { return _reloadInFlight; }, bootReport: _reportLastReloadTimings, suiteRows: _reloadSuiteRows, passKey: RELOAD_PREFLIGHT_PASS_KEY, startBuild: typeof _startExtensionBuild === "function" ? _startExtensionBuild : null, building: function() { return typeof _reloadBuildInFlight === "undefined" ? undefined : _reloadBuildInFlight; } };')(
            doc, opts.noLocks ? {} : { locks: locks }, { addEventListener: function() {}, location: { reload: function() { calls.push('page-reload'); } } },
            chromeFake, opts.running ? { a: true } : {},
            async function(title, body) { calls.push('confirm:' + title); confirms.push({ title: title, body: body }); return opts.confirm !== false; }, function(s) { return s; }, function(s, type) { notices.push(s); snacks.push([s, type]); }, function() { return !opts.noBuild; }, async function() { deployCalls++; if (opts.deployAnswers) return opts.deployAnswers.length ? opts.deployAnswers.shift() : null; return opts.noDeploy ? null : {}; },
            async function(name, args, index, host) {
                calls.push(name); approvalCalls.push({ name: name, args: args, host: host });
                if (name === 'extension_build' && opts.build) return opts.build(args, host);
                if (name === 'extension_build') return opts.badBuild ? { success: false, error: 'artifact validation failed' } : { success: true, stats: { jsFiles: 1, filesDeployed: 1 }, built_from: args.workspace };
                serial++;
                if (opts.run) return opts.run(args, host, serial, { files: files, metas: metas });
                return good(args.files);
            }, async function() { return metas; }, async function() { return opts.noMeta ? null : metas[0]; }, async function() { return files; },
            { subtle: { digest: async function(_, bytes) { return bytes.buffer; } } }, TextEncoder, AbortController, timer, function(t) { if (t) t.cleared = true; }, function() { calls.push('close-db'); }, fakeConsole,
            // showModal(title, message, buttons, variant) resolves the clicked button's value; tests answer via modals[i].answer(value).
            function(title, message, buttons, variant) { calls.push('modal:' + title); var d = deferred(); modals.push({ title: title, message: message, buttons: buttons, variant: variant, answer: d.resolve }); return d.promise; }
        );
        return { api: api, calls: calls, rows: rows, find: find, elements: function() { return descendants(doc.body); }, doc: doc, buttons: buttons, notices: notices, approvals: approvalCalls, files: files, metas: metas, timers: timers, locks: locks,
            logs: logs, snacks: snacks, confirms: confirms, sets: sets, held: held, removed: removed, store: store, modals: modals, getHeld: getHeld, deployCalls: function() { return deployCalls; },
            byClass: function(cls) { return descendants(doc.body).filter(function(e) { return String(e.className).split(' ').indexOf(cls) >= 0; }); } };
    }
    return { good: good, deferred: deferred, until: until, setup: setup };
}
async function runReloadPreflightTests(sources) {
    var passed = [];
    function check(name, condition) { if (!condition) throw new Error(name); passed.push(name); }
    var fx = reloadFixture(sources), good = fx.good, deferred = fx.deferred, until = fx.until, setup = fx.setup;
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
    check('one test call, pass record, build, cleanup, reload order', JSON.stringify(h.calls) === JSON.stringify(['run_tests', 'storage', 'extension_build', 'close-db', 'storage', 'reload']));
    check('successful suites show checked read-only pass indicators', h.rows.length === 5 && h.rows.every(function(r) { return r.dataset.state === 'pass' && r.children[0].children[0].checked && r.children[0].children[0].disabled; }));
    check('one call carries every suite in order, supported scope and 600s bound', h.approvals.length === 2 && h.approvals[0].name === 'run_tests' && JSON.stringify(h.approvals[0].args.files) === JSON.stringify(h.api.files) && JSON.stringify(h.approvals[0].args.tags) === '["unit","canary"]' && h.approvals[0].args.timeout_ms === 600000 && h.approvals[1].name === 'extension_build');
    check('tests use native options; only existing build uses fromSandbox', h.approvals.slice(0, 1).every(function(c) { return !c.host.fromSandbox && c.host._runTestsAbortSignal && !c.args.force && !c.args.trustedUI; }) && h.approvals[1].host.fromSandbox === true);
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
        check(mode + ': failure never automatically builds', h.calls.indexOf('extension_build') < 0 && h.rows.every(function(r) { return r.dataset.state === 'error'; }));
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
    check('single call runs every row at once and Force absent while active', h.rows.every(function(r) { return r.dataset.state === 'running'; }) && h.find('Force build').disabled);
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
    h.timers.find(function(t) { return t.ms === 615000 && !t.cleared; }).fn();
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
    h.timers.find(function(t) { return t.ms === 615000 && !t.cleared; }).fn();
    await until(function() { return h.timers.some(function(t) { return t.ms === 12000 && !t.cleared; }); });
    h.timers.find(function(t) { return t.ms === 12000 && !t.cleared; }).fn();
    await until(function() { return !h.find('Force build').hidden; });
    check('unsettled host never enables Force after cleanup bound', h.find('Force build').disabled && lateHost._runTestsAbortSignal.aborted);
    h.find('Cancel').click(); await promise;
    late.resolve(good(h.api.files)); await Promise.resolve(); await Promise.resolve();
    check('late result after cancelled gate cannot build or repaint removed dialog', h.calls.indexOf('extension_build') < 0 && h.doc.body.children.length === 0);
    // Different panel cannot queue a second automatic build.
    var blocker = deferred(); h = setup({ run: function(args, host, count) { return count === 1 ? blocker.promise : good(args.files); } }); promise = h.api.reload();
    await until(function() { return h.calls.length > 0; });
    var second = setup({ locks: h.locks }); await second.api.reload();
    check('origin-wide lock rejects second panel without running tools', second.calls.length === 0 && second.notices.some(function(s) { return s.indexOf('another panel') >= 0; }));
    blocker.resolve(good(h.api.files)); await promise;
    h = setup({ noLocks: true }); await h.api.reload();
    check('no Web Locks fails closed without deploying', !h.calls.length && h.notices.some(function(s) { return s.indexOf('Web Locks') >= 0; }));
    for (var change of ['content', 'pin']) {
        h = setup({ run: function(args, host, count, state) { if (count === 1) { if (change === 'content') state.files[0].content = 'new'; else state.metas.unshift({ repo: 'example-org/AppAgent::fork', pinned: true, head_sha: 'abc' }); } return good(args.files); } });
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
var PATHS = ['src/js/ui/270-iframe-panel.js', 'src/css/14-modals.css'], _reloadSources = null;
async function reloadSources() { return _reloadSources || (_reloadSources = await loadSources(PATHS)); }
await registerRunner('reload-preflight', async function() { return runReloadPreflightTests(await reloadSources()); });

// Native tests: the real Reload source with fake Chrome/DOM/tool bridges. Everything is
// microtask-driven; timers >= 1000ms fire only when a test fires them. Waits are bounded
// (never a bare await on the reload) so a regression fails fast instead of timing out the run.
var T = { tags: ['unit'], timeout: 5000 };
async function reloadKit() { return reloadFixture(await reloadSources()); }
async function waitFor(pred, what) { for (var i = 0; i < 5000 && !pred(); i++) await Promise.resolve(); assert.ok(pred(), 'fixture never reached: ' + what); }
async function settle(p) { var box = null; p.then(function(v) { box = { v: v }; }, function(e) { box = { e: e }; }); await waitFor(function() { return !!box; }, 'reload settled'); if (box.e) throw box.e; return box.v; }
async function ticks(n) { for (var i = 0; i < n; i++) await Promise.resolve(); }
function fire(h, ms) { var t = h.timers.find(function(x) { return x.ms === ms && !x.cleared; }); assert.ok(t, 'armed ' + ms + 'ms timer'); t.fn(); return t; }
function count(h, name) { return h.calls.filter(function(c) { return c === name; }).length; }
function rowStates(h) { return h.rows.map(function(r) { return r.dataset.state; }); }
function forceShown(h) { return !!h.find('Force build') && !h.find('Force build').hidden; }
function marker(h) { return h.sets.filter(function(items) { return 'reopenAppTab' in items; }); }
function armed(h, ms) { return h.timers.some(function(t) { return t.ms === ms && !t.cleared; }); }
function answer(m, label) { var b = m.buttons.find(function(x) { return x.label === label; }); assert.ok(b, 'modal offers ' + label); m.answer(b.value); }
function labels(m) { return m.buttons.map(function(b) { return b.label; }).sort(); }
function okBuild() { return { success: true, stats: { jsFiles: 1, filesDeployed: 1 }, built_from: 'example-org/AppAgent::main' }; }
function released(h) { return !h.api.busy() && !h.locks.names['appagent-reload-preflight'] && !h.buttons['ext-reload-btn'].disabled && !h.buttons['home-ext-reload-btn'].disabled; }
// Drives one Reload into a build timeout: returns the pending reload and the timeout modal.
async function timeoutModal(h) {
    var p = h.api.reload();
    await waitFor(function() { return armed(h, 300000); }, 'build timeout armed');
    assert.strictEqual(h.modals.length, 0, 'no modal before the timeout');
    var t = fire(h, 300000);
    await waitFor(function() { return h.modals.length === 1; }, 'build timeout modal');
    return { p: p, t: t, m: h.modals[0] };
}
describe('reload sequence (real 270-iframe-panel.js)', function() {
    test('second reload with an unchanged fingerprint makes no run_tests call', async function() {
        var fx = await reloadKit(), store = {};
        var first = fx.setup({ store: store });
        await settle(first.api.reload());
        assert.strictEqual(count(first, 'run_tests'), 1);
        var saved = store[first.api.passKey];
        assert.ok(saved && typeof saved.fingerprint === 'string' && saved.workspace === 'example-org/AppAgent::main', 'green run records its pass');
        assert.strictEqual(saved.files, first.api.files.join('\n'));
        var second = fx.setup({ store: store });
        await settle(second.api.reload());
        assert.strictEqual(count(second, 'run_tests'), 0);
        assert.deepStrictEqual(second.calls, ['extension_build', 'close-db', 'storage', 'reload']);
        assert.deepStrictEqual(rowStates(second), ['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
        assert.ok(second.logs.indexOf('info:[reload] preflight skipped (unchanged since last pass)') >= 0, 'skip line logged');
        var edited = fx.setup({ store: store });
        edited.files[0].content = 'edited';
        await settle(edited.api.reload());
        assert.strictEqual(count(edited, 'run_tests'), 1, 'an edited workspace runs the suites again');
    }, T);
    test('exactly one run_tests call carries every suite file', async function() {
        var fx = await reloadKit(), h = fx.setup();
        await settle(h.api.reload());
        var runs = h.approvals.filter(function(c) { return c.name === 'run_tests'; });
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(h.api.files.length, 5);
        assert.deepStrictEqual(runs[0].args.files, h.api.files.slice());
        assert.strictEqual(runs[0].args.timeout_ms, 600000);
        assert.deepStrictEqual(runs[0].args.tags, ['unit', 'canary']);
        var waits = h.timers.filter(function(t) { return t.ms === 615000; });
        assert.ok(waits.length === 1 && waits[0].cleared, 'one bounded page-side wait, cleared after the result');
        assert.deepStrictEqual(rowStates(h), ['pass', 'pass', 'pass', 'pass', 'pass']);
    }, T);
    test('one failing file fails only its row; reload blocked unless Force', async function() {
        var fx = await reloadKit();
        for (var choice of ['Cancel', 'Force build']) {
            var store = {};
            var h = fx.setup({ store: store, run: function(args) {
                var r = fx.good(args.files), f = r.files[2];
                f.status = 'fail'; f.passed = 1; f.failed = 1; f.failures = [{ name: 'x', error: 'Expected true' }];
                r.summary.passed--; r.summary.failed++; r.success = false; return r;
            } });
            var p = h.api.reload();
            await waitFor(function() { return forceShown(h); }, 'failure dialog');
            assert.deepStrictEqual(rowStates(h), ['pass', 'pass', 'fail', 'pass', 'pass']);
            assert.ok(!h.find('Force build').disabled && count(h, 'extension_build') === 0, 'explicit Force offered, no automatic build');
            h.find(choice).click();
            await settle(p);
            var forced = choice === 'Force build';
            assert.strictEqual(count(h, 'extension_build'), forced ? 1 : 0, choice);
            assert.strictEqual(count(h, 'reload'), forced ? 1 : 0, choice);
            assert.ok(!(h.api.passKey in store), 'a failing run never records a pass');
        }
    }, T);
    test('a suite missing from the result is an error row and nothing passes', async function() {
        var fx = await reloadKit(), h = fx.setup({ run: function(args) { return fx.good(args.files.slice(0, 4)); } });
        var p = h.api.reload();
        await waitFor(function() { return forceShown(h); }, 'failure dialog');
        assert.strictEqual(h.rows[4].dataset.state, 'error');
        assert.match(h.byClass('reload-preflight-message')[4].textContent, /^Not reported by the test run/);
        assert.ok(rowStates(h).every(function(s) { return s !== 'pass'; }), 'inconsistent envelope passes nothing');
        h.find('Cancel').click();
        await settle(p);
        assert.ok(count(h, 'extension_build') === 0 && count(h, 'reload') === 0);
        var malformed = h.api.suiteRows({ success: false, error: 'boom' }, h.api.files.slice());
        assert.ok(malformed.length === 5 && malformed.every(function(r) { return r.state === 'error' && r.detail.indexOf('Malformed or incomplete test result') === 0; }));
    }, T);
    // m4: without deploy-folder permission Reload ASKS (never a silent timed restart on the old files).
    test('no deploy-folder permission asks Grant access / Restart anyway / Cancel; Cancel (or a superseded modal) never reloads', async function() {
        var fx = await reloadKit();
        for (var pick of ['Cancel', null]) {
            var h = fx.setup({ noDeploy: true });
            var p = h.api.reload();
            await waitFor(function() { return h.modals.length === 1; }, 'deploy permission modal');
            var m = h.modals[0];
            assert.deepStrictEqual(labels(m), ['Cancel', 'Grant access', 'Restart anyway']);
            assert.strictEqual(m.variant, 'warning');
            assert.ok(h.logs.some(function(l) { return l.indexOf('warn:[reload] deploy folder permission not granted') === 0; }), 'console.warn');
            assert.ok(!armed(h, 2500), 'no timed notice: the restart waits for an answer');
            assert.strictEqual(count(h, 'reload') + count(h, 'page-reload'), 0, 'nothing restarts while the modal is open');
            if (pick) answer(m, pick); else m.answer(null);
            await settle(p);
            assert.strictEqual(count(h, 'reload') + count(h, 'page-reload'), 0, String(pick) + ': no reload');
            assert.strictEqual(count(h, 'run_tests') + count(h, 'extension_build'), 0, String(pick) + ': no preflight or build');
            assert.strictEqual(h.deployCalls(), 1, String(pick) + ': permission not re-requested');
            assert.ok(released(h), String(pick) + ': guard, preflight lock and buttons released');
        }
    }, T);
    test('Grant access re-requests permission right in the click continuation, then preflight + build + one reload', async function() {
        var fx = await reloadKit(), h = fx.setup({ deployAnswers: [null, {}] });
        var p = h.api.reload();
        await waitFor(function() { return h.modals.length === 1; }, 'deploy permission modal');
        // Snapshot taken the moment the second request is observed (before the reload resumes).
        var timersBefore = h.timers.length, callsBefore = h.calls.length, atRequest = null;
        answer(h.modals[0], 'Grant access');
        await waitFor(function() { if (!atRequest && h.deployCalls() === 2) atRequest = { timers: h.timers.length, calls: h.calls.length }; return !!atRequest; }, 'getDeployDirHandle re-called after Grant access');
        assert.deepStrictEqual(atRequest, { timers: timersBefore, calls: callsBefore }, 'permission re-requested straight from the click: no timer, preflight or build first');
        await settle(p);
        assert.strictEqual(count(h, 'run_tests'), 1, 'preflight ran');
        assert.strictEqual(count(h, 'extension_build'), 1, 'build ran');
        assert.strictEqual(count(h, 'reload'), 1, 'exactly one reload');
        assert.ok(h.calls.indexOf('run_tests') < h.calls.indexOf('extension_build') && h.calls.indexOf('extension_build') < h.calls.indexOf('reload'), 'preflight, then build, then reload');
        assert.strictEqual(h.deployCalls(), 2, 'no further permission requests');
    }, T);
    test('Grant access that is still denied warns and never builds or reloads', async function() {
        var fx = await reloadKit(), h = fx.setup({ deployAnswers: [null, null] });
        var p = h.api.reload();
        await waitFor(function() { return h.modals.length === 1; }, 'deploy permission modal');
        answer(h.modals[0], 'Grant access');
        await settle(p);
        assert.strictEqual(h.deployCalls(), 2, 'permission re-requested exactly once');
        assert.strictEqual(count(h, 'run_tests') + count(h, 'extension_build') + count(h, 'reload') + count(h, 'page-reload'), 0, 'no preflight, build or reload');
        assert.ok(h.snacks.some(function(s) { return s[1] === 'warning' && /permission/i.test(s[0]) && /not granted/i.test(s[0]); }), 'warning snackbar');
        assert.ok(released(h), 'guard, preflight lock and buttons released');
    }, T);
    test('Restart anyway restarts on the previous files at once: no build, no notice wait', async function() {
        var fx = await reloadKit(), h = fx.setup({ noDeploy: true });
        var p = h.api.reload();
        await waitFor(function() { return h.modals.length === 1; }, 'deploy permission modal');
        answer(h.modals[0], 'Restart anyway');
        await settle(p);
        assert.deepStrictEqual(h.calls, ['modal:' + h.modals[0].title, 'close-db', 'storage', 'reload']);
        assert.ok(!armed(h, 2500), 'no 2500ms notice timer');
        assert.strictEqual(h.deployCalls(), 1, 'no permission re-request');
    }, T);
    // M1: a timed-out build keeps running and writing files, so the timeout must never offer a reload.
    test('build timeout offers only Keep waiting / Cancel; Cancel (or a superseded modal) never reloads', async function() {
        var fx = await reloadKit();
        for (var pick of ['Cancel', null]) {
            var build = fx.deferred(), h = fx.setup({ build: function() { return build.promise; } });
            var x = await timeoutModal(h);
            assert.deepStrictEqual(labels(x.m), ['Cancel', 'Keep waiting'], 'no reload option while the build runs');
            assert.match(x.m.message, /half-written/);
            if (pick) answer(x.m, pick); else x.m.answer(null);
            await settle(x.p);
            assert.ok(x.t.cleared, 'window timer cleared');
            assert.strictEqual(count(h, 'reload') + count(h, 'page-reload'), 0, String(pick) + ': no reload');
            assert.strictEqual(h.confirms.length, 0, 'no reload-anyway confirm');
            assert.strictEqual(count(h, 'extension_build'), 1);
            assert.ok(h.snacks.some(function(s) { return /still running/.test(s[0]) && /blocked/.test(s[0]); }), 'snackbar: build still running, Reload blocked');
            assert.ok(released(h), 'guard, preflight lock and buttons released');
            build.resolve(okBuild());
        }
    }, T);
    test('a Reload during a stray build is refused early; once it settles Reload works again', async function() {
        var fx = await reloadKit(), build = fx.deferred(), h = fx.setup({ build: function() { return build.promise; } });
        var x = await timeoutModal(h);
        answer(x.m, 'Cancel');
        await settle(x.p);
        var before = h.calls.length;
        await settle(h.api.reload());
        assert.deepStrictEqual(h.calls.slice(before), [], 'no run_tests, no second extension_build, no reload');
        assert.ok(h.snacks.some(function(s) { return /^Reload stopped: .*still running/.test(s[0]); }), 'clear refusal snackbar');
        assert.ok(released(h), 'buttons re-enabled after the refusal');
        build.resolve(okBuild());
        await ticks(20);
        assert.strictEqual(h.api.building(), null, 'cleared when the build itself settles');
        await settle(h.api.reload());
        assert.strictEqual(count(h, 'run_tests'), 2, 'the later Reload runs its preflight');
        assert.strictEqual(count(h, 'extension_build'), 2, 'and its own build');
        assert.strictEqual(count(h, 'reload'), 1, 'and restarts');
    }, T);
    test('Keep waiting waits another window on the SAME build (repeatable), then reloads with its result', async function() {
        var fx = await reloadKit(), build = fx.deferred(), h = fx.setup({ build: function() { return build.promise; } });
        var x = await timeoutModal(h);
        answer(x.m, 'Keep waiting');
        await waitFor(function() { return armed(h, 300000); }, 'second window armed');
        fire(h, 300000);
        await waitFor(function() { return h.modals.length === 2; }, 'second timeout modal');
        assert.deepStrictEqual(labels(h.modals[1]), ['Cancel', 'Keep waiting']);
        answer(h.modals[1], 'Keep waiting');
        await waitFor(function() { return armed(h, 300000); }, 'third window armed');
        assert.strictEqual(count(h, 'extension_build'), 1, 'same build, never a second one');
        assert.strictEqual(count(h, 'reload'), 0, 'no reload while it runs');
        build.resolve(okBuild());
        await settle(x.p);
        assert.strictEqual(count(h, 'reload'), 1, 'reloads with the build result');
        assert.ok(h.timers.filter(function(t) { return t.ms === 300000; }).every(function(t) { return t.cleared; }), 'every window cleared');
        assert.ok(h.snacks.some(function(s) { return s[0] === 'Rebuilt extension from example-org/AppAgent::main'; }), 'normal success path');
        assert.strictEqual(h.confirms.length, 0);
    }, T);
    test('a build that SETTLES with a rejection keeps the reload-previous-files confirm', async function() {
        var fx = await reloadKit(), h = fx.setup({ build: function() { return Promise.reject(new Error('disk full')); } });
        await settle(h.api.reload());
        assert.ok(h.confirms.some(function(c) { return c.title === 'Extension rebuild error' && c.body.indexOf('disk full') >= 0; }), 'settled failure confirm');
        assert.strictEqual(h.modals.length, 0, 'no keep-waiting modal for a settled build');
        assert.strictEqual(count(h, 'reload'), 1, 'accepting reloads the previously built files');
        assert.ok(released(h));
    }, T);
    test('the restart itself is refused while an extension build is in flight', async function() {
        var fx = await reloadKit(), stray = fx.deferred(), n = 0;
        var h = fx.setup({ store: {}, holdSet: true, build: function() { return ++n === 1 ? okBuild() : stray.promise; } });
        assert.strictEqual(typeof h.api.startBuild, 'function', 'build starter exposed');
        var p = h.api.reload();
        await waitFor(function() { return marker(h).length > 0; }, 'marker write issued');
        var started = await settle(h.api.startBuild('example-org/AppAgent::main'));
        assert.ok(started && started.build && h.api.building() === started.build, 'a build is in flight');
        h.held.find(function(y) { return 'reopenAppTab' in y.items; }).cb();
        await settle(p);
        assert.strictEqual(count(h, 'reload') + count(h, 'page-reload'), 0, 'no restart onto a half-written build');
        assert.ok(h.logs.some(function(l) { return l.indexOf('warn:[reload]') === 0 && l.indexOf('in flight') >= 0; }), 'refusal logged');
        stray.resolve(okBuild());
        await ticks(20);
        assert.strictEqual(h.api.building(), null);
    }, T);
    test('an in-flight build in another panel blocks Reload there (cross-panel build lock)', async function() {
        var fx = await reloadKit(), build = fx.deferred(), a = fx.setup({ build: function() { return build.promise; } });
        var x = await timeoutModal(a);
        answer(x.m, 'Cancel');
        await settle(x.p);
        assert.ok(a.locks.names['appagent-extension-build'], 'build lock held while the stray build runs');
        var b = fx.setup({ locks: a.locks });
        await settle(b.api.reload());
        assert.deepStrictEqual(b.calls, [], 'panel B: no run_tests, no build, no reload');
        assert.ok(b.snacks.some(function(s) { return /^Reload stopped: .*still running/.test(s[0]); }), 'panel B refusal snackbar');
        build.resolve(okBuild());
        await ticks(20);
        assert.ok(!a.locks.held, 'build lock released when the build settles');
        await settle(b.api.reload());
        assert.strictEqual(count(b, 'reload'), 1, 'panel B reloads normally afterwards');
    }, T);
    // m3: the pass-record read only decides whether the suites may be skipped.
    test('a slow pass-record read counts as no pass record: the suites run and Reload proceeds', async function() {
        var fx = await reloadKit(), h = fx.setup({ store: {}, holdGet: true });
        var p = h.api.reload();
        await waitFor(function() { return h.getHeld.some(function(g) { return g.key === h.api.passKey; }) && armed(h, 5000); }, 'pass-record read waiting');
        assert.strictEqual(count(h, 'run_tests'), 0);
        fire(h, 5000);
        await settle(p);
        assert.strictEqual(count(h, 'run_tests'), 1, 'suites ran');
        assert.strictEqual(count(h, 'extension_build'), 1);
        assert.strictEqual(count(h, 'reload'), 1);
        assert.ok(h.logs.some(function(l) { return /^warn:\[reload\] .*pass record/.test(l); }), 'warning logged');
        assert.ok(!forceShown(h), 'no failure dialog');
    }, T);
    test('Cancel during a slow pass-record read still cancels', async function() {
        var fx = await reloadKit(), h = fx.setup({ store: {}, holdGet: true });
        var p = h.api.reload();
        await waitFor(function() { return h.getHeld.some(function(g) { return g.key === h.api.passKey; }) && armed(h, 5000); }, 'pass-record read waiting');
        h.find('Cancel').click();
        await settle(p);
        assert.ok(count(h, 'run_tests') === 0 && count(h, 'extension_build') === 0 && count(h, 'reload') === 0, 'nothing ran');
        assert.ok(released(h));
    }, T);
    test('restart handshake: one write carries marker + timings; reload only after its callback', async function() {
        var fx = await reloadKit(), h = fx.setup({ store: {}, holdSet: true });
        var p = h.api.reload();
        await waitFor(function() { return marker(h).length > 0; }, 'marker write issued');
        await ticks(50);
        assert.strictEqual(count(h, 'reload'), 0, 'no reload before the storage callback');
        var items = marker(h);
        assert.strictEqual(items.length, 1, 'exactly one marker write');
        assert.deepStrictEqual(Object.keys(items[0]).sort(), ['appagentLastReloadTimings', 'reopenAppTab']);
        var timings = items[0].appagentLastReloadTimings;
        assert.ok(typeof items[0].reopenAppTab === 'number' && timings.requestedAt === items[0].reopenAppTab && timings.total_ms >= 0, 'timings stamped with the marker time');
        assert.deepStrictEqual(['lock/confirm', 'permission', 'preflight', 'build+deploy', 'prepare'].filter(function(k) { return !(k in timings.phases); }), []);
        h.held.find(function(x) { return 'reopenAppTab' in x.items; }).cb();
        await settle(p);
        assert.strictEqual(count(h, 'reload'), 1);
        assert.ok(h.timers.filter(function(t) { return t.ms === 5000; }).every(function(t) { return t.cleared; }), 'fallback cleared');
        assert.ok(!h.logs.some(function(l) { return l.indexOf('not confirmed') >= 0; }), 'no fallback warning');
    }, T);
    test('restart handshake: a lost storage callback reloads once via the 5000ms fallback', async function() {
        var fx = await reloadKit(), h = fx.setup({ store: {}, holdSet: true });
        var p = h.api.reload();
        // The preflight's storage read also arms (then clears) a 5000ms wait: only fire after the marker write.
        await waitFor(function() { return marker(h).length > 0; }, 'marker write issued');
        assert.strictEqual(count(h, 'reload'), 0);
        fire(h, 5000);
        await settle(p);
        assert.strictEqual(count(h, 'reload'), 1);
        assert.ok(h.logs.indexOf('warn:[reload] marker write not confirmed within 5000ms; restarting anyway') >= 0, 'fallback warns');
        h.held.forEach(function(x) { if (x.cb) x.cb(); });
        await ticks(20);
        assert.strictEqual(count(h, 'reload'), 1, 'a late callback never reloads twice');
    }, T);
    test('boot report logs and removes stored timings; never throws without storage', async function() {
        var fx = await reloadKit();
        var store = { appagentLastReloadTimings: { requestedAt: Date.now() - 1500, total_ms: 42, phases: { preflight: 7 } } };
        var h = fx.setup({ store: store });
        await waitFor(function() { return h.logs.some(function(l) { return l.indexOf('info:[reload] previous reload:') === 0; }); }, 'boot report logged');
        assert.match(h.logs.find(function(l) { return l.indexOf('info:[reload] previous reload:') === 0; }), /^info:\[reload\] previous reload: restart \d+ms, total before restart 42ms, phases \{"preflight":7\}$/);
        assert.deepStrictEqual(h.removed, ['appagentLastReloadTimings']);
        assert.ok(!('appagentLastReloadTimings' in store), 'entry cleared');
        h.api.bootReport(); await ticks(20);
        assert.strictEqual(h.logs.filter(function(l) { return l.indexOf('previous reload') >= 0; }).length, 1, 'logged once');
        var bare = fx.setup({ noStorage: true }), broken = fx.setup({ store: {}, getThrows: true });
        assert.strictEqual(bare.api.bootReport(), undefined);
        broken.api.bootReport(); await ticks(20);
        assert.strictEqual(bare.logs.length + broken.logs.length, 0);
    }, T);
});
