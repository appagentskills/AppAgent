// Iframe tool functions
function setBrowserControlsVisibility(visible) {
    // Update both main and home browser controls (URL input only)
    ['browser-controls', 'home-browser-controls'].forEach(function(id) {
        var controls = document.getElementById(id);
        if (!controls) return;
        // Show URL input only when browser panel is open (visible=false means iframe is open)
        controls.style.display = visible ? 'none' : '';
    });
}

function openIframePanel() {
    // No embedded iframe panel — browser runs as a real Chrome tab
    setBrowserControlsVisibility(false);
    appStorage.setItem('browserOpen', 'true');
}

function popOutToFullTab() {
    if (typeof chrome === 'undefined') return;
    // Open the current chat in a full tab
    var url = chrome.runtime.getURL('app.html?mode=tab');
    if (currentChatId) url += '&chat=' + encodeURIComponent(currentChatId);
    chrome.tabs.create({ url: url });
}

function expandSidePanel() {
    // Open full tab and close the side panel
    popOutToFullTab();
    // Side panels can close themselves via window.close()
    setTimeout(function() { window.close(); }, 300);
}

// Native Reload is single-flight in this page AND across extension panels.
var _reloadInFlight = null;
var RELOAD_PREFLIGHT_FILES = Object.freeze([
    'test/test-run-policy.test.js', 'test/run-tests-tool.test.js',
    'test/js-eval-sandbox-lifecycle.test.js', 'test/harness.test.js',
    'test/reload-preflight.test.js'
]);
// ONE run_tests call covers every suite (was one call per file): 120s per suite,
// capped at the tool's 600s maximum; the page-side wait is slightly longer.
var RELOAD_PREFLIGHT_TIMEOUT_MS = Math.min(600000, 120000 * RELOAD_PREFLIGHT_FILES.length);
var RELOAD_PREFLIGHT_WAIT_MS = RELOAD_PREFLIGHT_TIMEOUT_MS + 15000;
var RELOAD_PREFLIGHT_PASS_KEY = 'appagentReloadPreflightPass'; // fingerprint of the last PASSING preflight
var RELOAD_TIMINGS_KEY = 'appagentLastReloadTimings';
var RELOAD_BUILD_TIMEOUT_MS = 5 * 60 * 1000;   // one page-side wait window (Keep waiting repeats it)
var RELOAD_BUILD_LOCK = 'appagent-extension-build'; // cross-panel: held until the build itself settles
// The running extension_build promise: set when it starts, cleared ONLY when that
// build settles (never by a page-side timeout). A timed-out build keeps writing the
// deploy folder, so while this is set nothing may restart or start another build.
var _reloadBuildInFlight = null;
var RELOAD_RESTART_FALLBACK_MS = 5000;   // safety net if the marker write never confirms
var _reloadClock = null;
function reloadExtension() {
    if (_reloadInFlight) return _reloadInFlight;
    var buttons = ['ext-reload-btn', 'home-ext-reload-btn'].map(function(id) { return document.getElementById(id); });
    var disabled = buttons.map(function(b) { return b && b.disabled; });
    buttons.forEach(function(b) { if (b) b.disabled = true; });
    // Set the page guard synchronously, before requesting the origin lock.
    try { _reloadClock = _reloadPhaseClock(); } catch (e) { _reloadClock = null; }
    _reloadInFlight = Promise.resolve().then(function() {
        if (!navigator.locks || !navigator.locks.request) throw new Error('Safe Reload requires Web Locks. Close other panels and restart Chrome.');
        return navigator.locks.request('appagent-reload-preflight', { ifAvailable: true }, async function(lock) {
            if (!lock) throw new Error('Reload is already running in another panel.');
            return _reloadExtensionLocked();
        });
    }).catch(function(e) {
        if (typeof showSnackbar === 'function') showSnackbar('Reload stopped: ' + e.message);
    }).finally(function() {
        buttons.forEach(function(b, i) { if (b) b.disabled = disabled[i]; });
        _reloadInFlight = null;
        _reloadClock = null;
    });
    return _reloadInFlight;
}

// Local reads only: no sync, permission bypass or invented chat identity.
async function _reloadWorkspace() {
    var metas = await getAllWorkspaceMetas();
    var matches = metas.filter(function(m) { return /\/AppAgent(::|$)/.test(m.repo); });
    var selected = matches.find(function(m) { return m.pinned; }) ||
        matches.find(function(m) { return /::(main|master)$/.test(m.repo); }) || matches[0] || metas[0];
    if (!selected || !selected.repo) throw new Error('No workspace available for Reload');
    return selected.repo;
}
async function _reloadFingerprint(workspace) {
    var meta = await getWorkspaceMeta(workspace), files = await getAllWorkspaceFiles(workspace);
    if (!meta || !Array.isArray(files) || !files.length) throw new Error('Cannot verify workspace source');
    // Clean lazy rows are identified by blob SHA; hydration alone is not an edit.
    // Dirty contents + deletion/new-path inventory catch same-size edits as well.
    var rows = files.map(function(f) {
        if (!f.path || (!f.deleted && f.dirty && typeof f.content !== 'string')) throw new Error('Incomplete workspace source');
        return [f.path, f.sha || '', !!f.deleted, !!f.dirty, f.dirty ? f.content : null];
    }).sort(function(a, b) { return a[0].localeCompare(b[0]); });
    var bytes = new TextEncoder().encode(JSON.stringify([meta.head_sha, meta.branch, rows]));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(function(n) { return n.toString(16).padStart(2, '0'); }).join('');
}
// Phase timings: console.info per phase plus a summary persisted with the reopen
// marker. Diagnostics only: every use is guarded and can never break Reload.
function _reloadPhaseClock() {
    var start = Date.now(), last = start, phases = {};
    return {
        mark: function(name) {
            var now = Date.now(), ms = now - last; last = now;
            phases[name] = (phases[name] || 0) + ms;
            console.info('[reload] ' + name + ' ' + ms + 'ms');
        },
        summary: function(requestedAt) { return { requestedAt: requestedAt, total_ms: requestedAt - start, phases: Object.assign({}, phases) }; }
    };
}
function _reloadMark(name) { try { if (_reloadClock) _reloadClock.mark(name); } catch (e) { /* diagnostics only */ } }
// chrome.storage.local helpers that never throw/reject (null when unavailable).
function _reloadStorageGet(key) {
    return new Promise(function(resolve) {
        try {
            var local = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
            if (!local || typeof local.get !== 'function') { resolve(null); return; }
            local.get(key, function(data) { resolve(!(chrome.runtime && chrome.runtime.lastError) && data ? data[key] : null); });
        } catch (e) { resolve(null); }
    });
}
function _reloadStorageSet(items) {
    try {
        var local = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
        if (!local || typeof local.set !== 'function') return;
        local.set(items, function() { var err = chrome.runtime && chrome.runtime.lastError; if (err) console.warn('[reload] storage write failed: ' + (err.message || err)); });
    } catch (e) { console.warn('[reload] storage write failed: ' + (e && e.message || e)); }
}
// Same workspace, same exact sources (fingerprint) and same suite list as the last PASS.
function _reloadPassMatches(saved, workspace, fingerprint) {
    return !!(saved && typeof saved === 'object' && typeof fingerprint === 'string' && saved.fingerprint === fingerprint &&
        saved.workspace === workspace && saved.files === RELOAD_PREFLIGHT_FILES.join('\n'));
}
function _reloadSuiteResult(result, file) {
    var f = result && Array.isArray(result.files) && result.files.length === 1 && result.files[0];
    var s = result && result.summary;
    var valid = f && f.file === file && s && s.files === 1 &&
        ['passed', 'failed', 'skipped', 'no_assertions'].every(function(k) { return Number.isSafeInteger(s[k]) && s[k] >= 0; }) &&
        ['passed', 'failed', 'skipped'].every(function(k) { return Number.isSafeInteger(f[k]) && f[k] >= 0 && f[k] === s[k]; }) &&
        s.total === s.passed + s.failed + s.skipped;
    var unsupported = valid && f.skipped > 0 && Array.isArray(f.skips) && f.skips.length === f.skipped &&
        f.skips.every(function(skip) { return /unsupported.*(contract|runtime)|(contract|runtime).*unsupported/i.test(skip.reason || ''); });
    var safe = valid && result.isolation && result.isolation.ok === true && result.isolation.host_verified === true &&
        Array.isArray(result.denied_calls) && result.denied_calls.length === 0;
    var pass = safe && result.success === true && f.status === 'pass' && f.passed > 0 && !f.failed &&
        !s.no_assertions && !f.no_assertions && !f.aborted && !result.aborted && (!f.skipped || unsupported);
    var state = pass ? 'pass' : valid && !f.passed && !f.failed && f.skipped ? 'skipped' : valid && f.failed ? 'fail' : 'error';
    var detail = valid ? f.passed + ' passed; ' + f.failed + ' failed; ' + f.skipped + ' skipped (unchecked)' : 'Malformed or incomplete test result';
    if (!pass) detail += '\n' + (result && result.error || 'Required supported assertions or verified isolation missing');
    // Keep runner startup/file diagnostics even when its count envelope is invalid.
    if (!pass && f && f.error) detail += '\n' + String(f.error);
    if (f && f.failures) detail += '\n' + JSON.stringify(f.failures);
    if (f && f.skips && f.skips.length) detail += '\n' + JSON.stringify(f.skips);
    return { state: state, detail: detail.slice(0, 6000) };
}
// One run_tests call covers every suite. Each row gets a one-file view of that
// envelope (its own entry + the shared isolation/denial/abort/error fields) and
// is judged by the unchanged single-file _reloadSuiteResult. A missing entry or an
// inconsistent envelope is an explicit failure: nothing passes on a bad envelope.
function _reloadSuiteRows(result, files) {
    var list = result && Array.isArray(result.files) ? result.files : null, s = result && result.summary;
    var envelopeOk = !!(list && s && list.length === files.length && s.files === list.length && list.every(function(f) {
        return f && ['passed', 'failed', 'skipped'].every(function(k) { return Number.isSafeInteger(f[k]) && f[k] >= 0; });
    }));
    if (envelopeOk) {
        // Same recount as run_tests: an error/empty file counts as one failure.
        var sum = { passed: 0, failed: 0, skipped: 0, no_assertions: 0 };
        list.forEach(function(f) {
            sum.passed += f.passed; sum.failed += f.failed + (f.status === 'error' || f.status === 'empty' ? 1 : 0);
            sum.skipped += f.skipped; sum.no_assertions += f.no_assertions || 0;
        });
        envelopeOk = Object.keys(sum).every(function(k) { return s[k] === sum[k]; }) && s.total === sum.passed + sum.failed + sum.skipped;
    }
    var why = (result && result.error) || 'Required supported assertions or verified isolation missing';
    return files.map(function(file) {
        if (!list || !s || typeof s !== 'object') return { state: 'error', detail: ('Malformed or incomplete test result\n' + why).slice(0, 6000) };
        var mine = list.filter(function(f) { return f && f.file === file; });
        if (mine.length !== 1) return { state: 'error', detail: ((mine.length ? 'Suite reported more than once' : 'Not reported by the test run (it stopped before this suite)') + '\n' + why).slice(0, 6000) };
        var f = mine[0];
        return _reloadSuiteResult({
            success: envelopeOk && f.status === 'pass', error: result.error, aborted: result.aborted,
            isolation: result.isolation, denied_calls: result.denied_calls, files: [f],
            summary: { files: 1, total: f.passed + f.failed + f.skipped, passed: f.passed, failed: f.failed, skipped: f.skipped, no_assertions: f.no_assertions || 0 }
        }, file);
    });
}

function _reloadChecklist(controller) {
    var previous = document.activeElement, choice, resolveChoice;
    var decision = new Promise(function(resolve) { resolveChoice = resolve; });
    function node(tag, cls, text, parent) {
        var el = document.createElement(tag); el.className = cls;
        if (text) el.textContent = text;
        if (parent) parent.appendChild(el);
        return el;
    }
    var overlay = node('div', 'modal-overlay show reload-preflight');
    var dialog = node('section', 'modal-dialog', '', overlay);
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-labelledby', 'reload-preflight-title');
    dialog.setAttribute('aria-describedby', 'reload-preflight-status');
    var title = node('h2', 'modal-header', 'Checking before Reload…', dialog); title.id = 'reload-preflight-title';
    var body = node('div', 'modal-body', '', dialog);
    var status = node('p', 'reload-preflight-status', 'Preparing workspace…', body); status.id = 'reload-preflight-status'; status.setAttribute('aria-live', 'polite');
    var progressText = node('p', 'reload-preflight-progress-text', '0 of 5 suites complete', body); progressText.setAttribute('aria-live', 'polite'); progressText.setAttribute('aria-atomic', 'true');
    var progress = node('progress', 'reload-preflight-progress', '', body); progress.max = RELOAD_PREFLIGHT_FILES.length; progress.value = 0; progress.setAttribute('aria-label', 'Suites complete');
    var labels = ['Policy checks', 'Test runner', 'Sandbox lifecycle', 'Test harness', 'Reload checks'];
    var summaries = [];
    var rows = RELOAD_PREFLIGHT_FILES.map(function(file, index) {
        var row = node('div', 'reload-preflight-row', '', body);
        var label = node('label', 'reload-preflight-label', '', row), box = node('input', 'reload-preflight-check', '', label);
        box.type = 'checkbox'; box.disabled = true; box.setAttribute('aria-label', labels[index] + ': Pending');
        var spinner = node('span', 'reload-preflight-spinner', '', label); spinner.setAttribute('aria-hidden', 'true');
        node('span', '', labels[index], label);
        var result = node('div', 'reload-preflight-result', '', row);
        var state = node('span', 'reload-preflight-state', 'Pending', result);
        var counts = node('span', 'reload-preflight-counts', '', result); counts.hidden = true;
        var message = node('p', 'reload-preflight-message', '', row); message.hidden = true;
        var details = node('details', 'reload-preflight-details', '', row);
        var summary = node('summary', '', 'Details', details); summary.setAttribute('aria-label', 'Details for ' + labels[index]); summaries.push(summary);
        node('code', 'reload-preflight-file', file, details);
        var detail = node('pre', 'reload-preflight-detail', '', details); detail.hidden = true;
        row.dataset.state = 'pending';
        return { row: row, box: box, state: state, counts: counts, message: message, detail: detail, complete: false };
    });
    var technical = node('details', 'reload-preflight-details reload-preflight-technical', '', body);
    summaries.push(node('summary', '', 'Coverage and workspace', technical));
    var workspace = node('p', 'reload-preflight-workspace', 'Workspace: preparing…', technical);
    node('p', '', 'Unit and canary checks use workspace sources in the installed runtime, not the new build. Contract and runtime layers are unsupported; skipped checks are not passes. Permission prompts remain separate.', technical);
    var actions = node('div', 'modal-actions', '', dialog);
    var cancel = node('button', 'modal-btn secondary', 'Cancel', actions); cancel.type = 'button';
    var force = node('button', 'modal-btn warning', 'Force build', actions); force.type = 'button'; force.hidden = true; force.disabled = true;
    function choose(value) {
        if (choice) return;
        choice = value;
        if (value === 'cancel') { controller.abort(); status.textContent = 'Cancelling — revoking test authority…'; }
        resolveChoice(value);
    }
    cancel.addEventListener('click', function() { choose('cancel'); });
    force.addEventListener('click', function() { if (!force.disabled) choose('force'); });
    overlay.addEventListener('keydown', function(e) {
        // Details keep native keyboard activation; Enter must never choose Force.
        if (e.key === 'Enter') { if (summaries.indexOf(e.target) < 0) e.preventDefault(); e.stopPropagation(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); choose('cancel'); }
        // Include native summaries, but never steal focus from separate permission prompts.
        if (e.key === 'Tab') {
            var controls = summaries.concat([cancel]);
            if (!force.hidden && !force.disabled) controls.push(force);
            var active = controls.indexOf(document.activeElement);
            if (active >= 0) { e.preventDefault(); controls[(active + (e.shiftKey ? controls.length - 1 : 1)) % controls.length].focus(); }
        }
    });
    function updateProgress() {
        var complete = rows.filter(function(r) { return r.complete; }).length;
        var failed = rows.filter(function(r) { return r.row.dataset.state === 'fail'; }).length;
        var errors = rows.filter(function(r) { return r.row.dataset.state === 'error'; }).length;
        progress.value = complete;
        progressText.textContent = complete + ' of ' + rows.length + ' suites complete' + (failed ? ' · ' + failed + ' failed' : '') + (errors ? ' · ' + errors + (errors === 1 ? ' error' : ' errors') : '');
        progress.setAttribute('aria-valuetext', progressText.textContent);
    }
    document.body.appendChild(overlay); cancel.focus();
    return {
        decision: decision,
        cancelled: function() { return choice === 'cancel'; },
        update: function(index, state, detail) {
            var r = rows[index];
            r.row.dataset.state = state; r.box.checked = state === 'pass';
            var stateLabels = { pending: 'Pending', running: 'Running', pass: 'Passed', fail: 'Failed', skipped: 'Skipped', error: 'Error' };
            r.state.textContent = state === 'skipped' && detail === 'Not run' ? 'Not run' : (stateLabels[state] || state);
            r.box.setAttribute('aria-label', labels[index] + ': ' + r.state.textContent);
            r.complete = ['pass', 'fail', 'skipped', 'error'].indexOf(state) >= 0 && detail !== 'Not run';
            // Format the existing gate diagnostic without changing eligibility or inventing counts.
            var lines = String(detail || '').split('\n');
            var counts = /^(\d+) passed; (\d+) failed; (\d+) skipped(?: \(unchecked\))?$/.exec(lines[0]);
            r.counts.textContent = counts ? counts[1] + ' passed · ' + counts[2] + ' failed · ' + counts[3] + ' skipped' : '';
            r.counts.hidden = !counts;
            if (counts) lines.shift();
            lines = lines.filter(function(line) { return line.trim() && line.trim() !== '[]'; });
            var text = lines.map(function(line) { try { return JSON.stringify(JSON.parse(line), null, 2); } catch (_) { return line; } }).join('\n');
            r.detail.textContent = text; r.detail.hidden = !text;
            var needsAttention = state === 'fail' || state === 'error' || state === 'skipped';
            var headline = lines.find(function(line) { return line !== 'Malformed or incomplete test result' && line !== 'Required supported assertions or verified isolation missing'; }) || lines[0];
            headline = headline || 'This suite did not pass.';
            r.message.textContent = needsAttention ? (headline.length > 240 ? headline.slice(0, 240) + '…' : headline) : '';
            r.message.hidden = !needsAttention;
            updateProgress();
        },
        status: function(text) {
            if (text.indexOf('Workspace: ') === 0) { workspace.textContent = text; status.textContent = 'Checking supported assertions before building.'; }
            else if (text.indexOf('All five supported suites passed') === 0) { title.textContent = 'All checks passed'; status.textContent = 'Building the checked workspace…'; }
            else status.textContent = text;
        },
        failure: function(text, settled) { title.textContent = 'Checks need attention'; status.textContent = text; force.hidden = false; force.disabled = !settled; cancel.focus(); },
        close: function() { overlay.remove(); if (previous && previous.isConnected) previous.focus(); }
    };
}

// Bounds preparation/approval waits too. Abort immediately revokes live runner
// authority; a late approval reaches an already-aborted host signal and cannot run.
async function _reloadWait(promise, signal, ms) {
    var timer, abort;
    try {
        return await Promise.race([promise, new Promise(function(_, reject) {
            abort = function() { reject(new Error('Reload cancelled')); };
            if (signal.aborted) { abort(); return; }
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(function() { reject(new Error('Reload preflight timed out')); }, ms);
        })]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
}
async function _runReloadPreflight() {
    var controller = new AbortController(), ui = _reloadChecklist(controller);
    var workspace, fingerprint, pending = null, settled = true, running = false, failed = false, files = RELOAD_PREFLIGHT_FILES.slice();
    var states = files.map(function() { return 'pending'; });
    function set(i, state, detail) { states[i] = state; ui.update(i, state, detail); }
    try {
        workspace = await _reloadWait(_reloadWorkspace(), controller.signal, 15000);
        ui.status('Workspace: ' + workspace);
        fingerprint = await _reloadWait(_reloadFingerprint(workspace), controller.signal, 15000);
        // Same exact sources as the last PASSING preflight: those tests already passed.
        // The record only decides whether the suites may be SKIPPED: a slow/failed
        // read counts as "no pass record" (run them). A cancel still cancels.
        var lastPass = null;
        try { lastPass = await _reloadWait(_reloadStorageGet(RELOAD_PREFLIGHT_PASS_KEY), controller.signal, 5000); }
        catch (e) {
            if (controller.signal.aborted) throw e;
            console.warn('[reload] pass record unavailable (' + (e && e.message || e) + '); running the suites');
        }
        if (_reloadPassMatches(lastPass, workspace, fingerprint)) {
            console.info('[reload] preflight skipped (unchanged since last pass)');
            files.forEach(function(_, i) { set(i, 'skipped', 'Preflight skipped (unchanged since last pass)'); });
            ui.status('Preflight skipped (unchanged since last pass) — building ' + workspace);
            return { proceed: true, workspace: workspace, skipped: true };
        }
        if (controller.signal.aborted) throw new Error('Reload cancelled');
        // ONE run_tests call for every suite (was one per file); rows map from its entries.
        files.forEach(function(_, i) { set(i, 'running', 'Running supported assertions…'); });
        running = true; settled = false;
        pending = Promise.resolve().then(function() {
            if (controller.signal.aborted) throw new Error('Reload cancelled before dispatch');
            return executeTool('run_tests', { files: files.slice(), tags: ['unit', 'canary'], workspace: workspace, timeout_ms: RELOAD_PREFLIGHT_TIMEOUT_MS }, null, { _runTestsAbortSignal: controller.signal });
        }).finally(function() { settled = true; });
        var result = await _reloadWait(pending, controller.signal, RELOAD_PREFLIGHT_WAIT_MS);
        running = false;
        _reloadSuiteRows(result, files).forEach(function(row, i) { set(i, row.state, row.detail); });
        failed = states.some(function(st) { return st !== 'pass'; });
        // Rows can all pass only on a consistent envelope; still require the run's own verdict.
        if (!failed && !(result && result.success === true)) {
            files.forEach(function(_, i) { set(i, 'error', 'Test run did not report success\n' + (result && result.error || '')); });
            failed = true;
        }
        if (!failed) {
            var current = await _reloadWait(_reloadFingerprint(workspace), controller.signal, 15000);
            if (current !== fingerprint || await _reloadWait(_reloadWorkspace(), controller.signal, 15000) !== workspace) {
                files.forEach(function(_, i) { set(i, 'error', 'Workspace changed — previous results are stale.'); });
                throw new Error('Workspace changed during tests. Run Reload again, or explicitly force this workspace build.');
            }
            // Remember this pass: an unchanged workspace skips the preflight next time.
            var pass = {};
            pass[RELOAD_PREFLIGHT_PASS_KEY] = { fingerprint: fingerprint, workspace: workspace, files: RELOAD_PREFLIGHT_FILES.join('\n'), at: Date.now() };
            _reloadStorageSet(pass);
            ui.status('All five supported suites passed — building ' + workspace);
            return { proceed: true, workspace: workspace };
        }
    } catch (e) {
        // Any caught error is a failure. An empty/undefined message used to leave
        // `failed` falsy: the finally below closed the checklist and then
        // `await ui.decision` hung forever with the Reload buttons disabled.
        var reason = String(e && (e.message || (typeof e === 'string' ? e : '')) || '').trim() || 'Preflight failed (unknown error)';
        if (running) files.forEach(function(_, i) { if (states[i] === 'running') set(i, 'error', reason); });
        failed = reason;
    } finally {
        // Do not offer Force while the host invocation is still settling.
        if (pending && !settled) {
            controller.abort();
            try { await _reloadWait(pending, new AbortController().signal, 12000); } catch (cleanupError) { /* Fail closed below if still unsettled. */ }
        }
        if (!failed || ui.cancelled()) ui.close();
    }
    if (ui.cancelled()) { ui.close(); return { proceed: false }; }
    files.forEach(function(_, i) { if (states[i] === 'pending') set(i, 'skipped', 'Not run'); });
    ui.failure((typeof failed === 'string' ? failed : 'Required checks did not pass.') + (settled ? ' Cancel or explicitly Force build (tests only; artifact/security checks still apply).' : ' Host cleanup did not settle; Force is unavailable.'), settled && !!workspace);
    try { return { proceed: (await ui.decision) === 'force', workspace: workspace }; }
    finally { ui.close(); }
}

async function _rebuildBeforeReload() {
    if (typeof isSkillTool !== 'function' || !isSkillTool('extension_build')) return true;
    var dir = typeof getDeployDirHandle === 'function' ? await getDeployDirHandle() : null;
    _reloadMark('permission');
    if (!dir) {
        // getDeployDirHandle() quietly returns null without readwrite permission.
        // Ask instead of silently restarting on the old files (m4).
        console.warn('[reload] deploy folder permission not granted; asking before any restart');
        var choice = await showModal('Deploy folder access needed',
            'Reload cannot rebuild the extension: readwrite permission for the connected deploy folder is not granted.<br><br>Grant access to rebuild and deploy your workspace changes, Restart anyway to restart on the previously built files, or Cancel.',
            [{ label: 'Cancel', value: 'cancel', class: 'secondary' }, { label: 'Restart anyway', value: 'restart', class: 'secondary' }, { label: 'Grant access', value: 'grant', class: 'primary' }], 'warning');
        if (choice === 'restart') return true;
        if (choice !== 'grant') return false; // Cancel, or superseded by another modal (null)
        // Straight from the click continuation: the transient user activation lets
        // getDeployDirHandle()'s own requestPermission() show the browser prompt.
        dir = typeof getDeployDirHandle === 'function' ? await getDeployDirHandle() : null;
        _reloadMark('permission-prompt');
        if (!dir) {
            if (typeof showSnackbar === 'function') showSnackbar('Deploy folder permission still not granted — Reload cancelled', 'warning');
            return false;
        }
    }
    var gate = await _runReloadPreflight();
    _reloadMark('preflight');
    if (!gate.proceed) return false;
    var built = await _buildFrozenWorkspace(gate.workspace);
    _reloadMark('build+deploy');
    return built;
}

// True while an extension build is still running: this page's (stray, timed-out)
// build or, via RELOAD_BUILD_LOCK, another panel's.
async function _reloadBuildBusy() {
    if (_reloadBuildInFlight) return true;
    if (!navigator.locks || !navigator.locks.request) return false;
    return navigator.locks.request(RELOAD_BUILD_LOCK, { ifAvailable: true }, function(lock) { return !lock; });
}
async function _reloadExtensionLocked() {
    // M1: refuse EARLY (no preflight, build or restart) while a build still writes files.
    if (await _reloadBuildBusy()) throw new Error('an extension build is still running — Reload is blocked until it finishes.');
    // chrome.runtime.reload() restarts the WHOLE extension — including the
    // service worker (background.js + the imported sw-bundle.js, where the
    // agent loop and pause handling live). That is the ONLY reliable way to
    // pick up freshly deployed files from disk; a plain window.location.reload()
    // only reloads the panel page (app.js) and leaves the OLD service worker
    // running, so a new sw-bundle.js never takes effect.
    //
    // The reload kills all extension pages (side panel + tabs), so we set
    // reopenAppTab first and background.js reopens the app as a full tab
    // afterwards (sidePanel.open() needs a user gesture, so a tab is the only
    // reliable option from the background script).

    // No extension runtime (dev/web preview): all we can do is reload the page.
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.reload) {
        window.location.reload();
        return;
    }

    // A full reload tears down in-flight agent runs. Warn before doing so.
    // runningChatIds is a plain object keyed by chatId (core/030-config.js).
    var runningCount = 0;
    if (typeof runningChatIds !== 'undefined' && runningChatIds) {
        for (var _cid in runningChatIds) { if (runningChatIds[_cid]) runningCount++; }
    }
    if (runningCount > 0) {
        var msg = runningCount === 1
            ? 'An agent run is still in progress. Reloading the extension will stop it. Reload anyway?'
            : runningCount + ' agent runs are still in progress. Reloading the extension will stop them. Reload anyway?';
        if (!(await showConfirmModal('Reload extension?', escapeHtml(msg), 'warning'))) return;
    }
    _reloadMark('lock/confirm');

    // Fire the reload exactly once, and never let anything strand it.
    var _reloaded = false;
    function _doReload() {
        if (_reloaded) return;
        // Belt and braces (M1): never restart onto a half-written build.
        if (_reloadBuildInFlight) {
            console.warn('[reload] extension build still in flight; restart refused');
            if (typeof showSnackbar === 'function') showSnackbar('Reload blocked: the extension build is still running', 'warning');
            return;
        }
        _reloaded = true;
        try {
            chrome.runtime.reload();
        } catch (e) {
            // Last resort if reload() itself throws — at least refresh the page.
            window.location.reload();
        }
    }

    // Persist reopenAppTab so background.js reopens the app as a full tab, then
    // fire the reload. CRITICAL: do NOT gate the reload solely on the storage
    // callback. If the service worker is asleep/busy or storage is blocked, the
    // callback can be delayed or never fire — which previously left
    // chrome.runtime.reload() unreached and the old SW running. The write is
    // raced against a bounded RELOAD_RESTART_FALLBACK_MS timer, so the reload
    // always fires. The same write carries the phase timings, which the next
    // boot logs once (_reportLastReloadTimings).
    function _startReloadSequence() {
        // Immediate feedback — the reload tears the page down a moment later.
        if (typeof showSnackbar === 'function') showSnackbar('Reloading extension…');
        // Timestamp (not `true`): background.js discards a stale marker
        // instead of consuming it on a much later SW start (the next
        // toolbar click), which used to open TWO app tabs.
        var requestedAt = Date.now();
        var items = { reopenAppTab: requestedAt };
        try {
            items[RELOAD_TIMINGS_KEY] = _reloadClock ? _reloadClock.summary(requestedAt) : { requestedAt: requestedAt };
        } catch (e) { /* timings are diagnostics only; never block the reload */ }
        var written = new Promise(function(resolve) {
            try {
                if (!chrome.storage || !chrome.storage.local) { resolve(); return; }
                chrome.storage.local.set(items, function() {
                    // Reading lastError also stops Chrome logging an unchecked-error warning.
                    if (chrome.runtime.lastError) console.warn('[reload] marker write failed: ' + (chrome.runtime.lastError.message || chrome.runtime.lastError));
                    resolve();
                });
            } catch (e) {
                console.warn('[reload] marker write threw; restarting anyway: ' + (e && e.message || e));
                resolve();
            }
        });
        // Guaranteed fallback: restart even if the storage callback never returns.
        var fallbackTimer = null;
        var fallback = new Promise(function(resolve) {
            fallbackTimer = setTimeout(function() {
                console.warn('[reload] marker write not confirmed within ' + RELOAD_RESTART_FALLBACK_MS + 'ms; restarting anyway');
                resolve();
            }, RELOAD_RESTART_FALLBACK_MS);
        });
        return Promise.race([written, fallback]).then(function() {
            clearTimeout(fallbackTimer);
            _reloadMark('restart request');
            _doReload();
        });
    }

    // Rebuild-then-reload: when running as an installed extension with a deploy
    // folder connected (and the in-browser build tool available), rebuild +
    // redeploy the extension from the workspace FIRST, so chrome.runtime.reload()
    // picks up the freshly built files from disk. Without a connected folder (or
    // build tool) there is nothing on disk to update, so we just reload.
    return _rebuildBeforeReload().then(function(proceed) {
        if (!proceed) return;
        // Cleanly close every realm's IDB connection BEFORE chrome.runtime.reload()
        // tears the contexts down. An abrupt teardown of an un-closed connection can
        // make Chrome force-close the origin's IndexedDB backing store, which then
        // wedges the DB until a full browser restart (see closeDatabase). Fail-open:
        // this only ever delays the reload by a fixed settle, never blocks it.
        return _prepareRealmsForReload().then(function(){ _reloadMark('prepare'); return _startReloadSequence(); });
    });
}

// Best-effort pre-reload cleanup across realms. Signals the service worker to
// close its own IDB connection (and its offscreen doc), closes this page's
// connection, then resolves after a short settle so the closes can land. Never
// rejects and never hangs -- the settle timer is the only gate, so a reload
// always proceeds even if the SW never answers (fail-open).
function _prepareRealmsForReload() {
    return new Promise(function(resolve) {
        try {
            if (typeof _openAgentBus === 'function') { try { _openAgentBus(); } catch (e) {} }
            if (typeof _agentBusPort !== 'undefined' && _agentBusPort) {
                _agentBusPort.postMessage({ type: 'prepare-reload' });
            }
        } catch (e) { /* best-effort -- page still closes its own DB below */ }
        // Close THIS (page) realm's connection.
        try { if (typeof closeDatabase === 'function') closeDatabase(); } catch (e) {}
        // Give the SW ~250ms to run its own closeDatabase() before teardown.
        setTimeout(resolve, 250);
    });
}

// Backstop: on page teardown (reload, tab close, navigation) close the IDB
// connection cleanly even if the reload didn't originate from our button --
// same force-close-avoidance rationale as _prepareRealmsForReload.
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', function() {
        try { if (typeof closeDatabase === 'function') closeDatabase(); } catch (e) {}
    });
}

// Boot report: _startReloadSequence stores the phase timings under
// RELOAD_TIMINGS_KEY right before chrome.runtime.reload(); the restarted page
// logs them once and clears the entry. Diagnostics only: never throws at boot.
function _reportLastReloadTimings() {
    try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== 'function') return;
        _reloadStorageGet(RELOAD_TIMINGS_KEY).then(function(t) {
            try {
                if (!t) return;
                if (typeof chrome.storage.local.remove === 'function') {
                    chrome.storage.local.remove(RELOAD_TIMINGS_KEY, function() { if (chrome.runtime && chrome.runtime.lastError) { /* ignore */ } });
                }
                console.info('[reload] previous reload: restart ' + (Date.now() - t.requestedAt) + 'ms, total before restart ' + t.total_ms + 'ms, phases ' + JSON.stringify(t.phases));
            } catch (e) { /* diagnostics only */ }
        });
    } catch (e) { /* diagnostics only */ }
}
_reportLastReloadTimings();

// Rebuild + redeploy the extension from the workspace before a reload, but only
// when a deploy folder is connected and the `extension_build` skill tool is
// loaded (the extension-dev skill is active). Reuses the exact same build the
// agent runs — no duplicated build logic. Returns a promise resolving to `true`
// when the caller should proceed with the reload, or `false` to abort (the user
// cancelled a prompt, or declined to reload after a failed build).
// Starts extension_build under RELOAD_BUILD_LOCK, held until the BUILD settles.
// Resolves { build } (wrapped: resolving with the promise itself would adopt it and
// wait for the build), or null when another panel's build holds the lock.
function _startExtensionBuild(workspace) {
    return new Promise(function(started, failed) {
        function run(lock) {
            if (!lock) { started(null); return; }
            var build;
            try { build = Promise.resolve(executeTool('extension_build', { workspace: workspace }, null, { fromSandbox: true })); }
            catch (e) { build = Promise.reject(e); }
            function clear() { if (_reloadBuildInFlight === build) _reloadBuildInFlight = null; }
            // Attached before any caller race: a settled build is cleared before its result is seen.
            var done = build.then(clear, clear);
            _reloadBuildInFlight = build;
            started({ build: build });
            return done;
        }
        if (navigator.locks && navigator.locks.request) navigator.locks.request(RELOAD_BUILD_LOCK, { ifAvailable: true }, run).catch(failed);
        else run(true);
    });
}
// Waits one RELOAD_BUILD_TIMEOUT_MS window at a time. Resolves { result } once the
// build settles (rejects with its own error), or null when the user stops waiting.
async function _awaitExtensionBuild(build) {
    var TIMED_OUT = {}, minutes = Math.round(RELOAD_BUILD_TIMEOUT_MS / 60000);
    for (;;) {
        var timer = null, res;
        var windowEnd = new Promise(function(resolve) { timer = setTimeout(function() { resolve(TIMED_OUT); }, RELOAD_BUILD_TIMEOUT_MS); });
        try { res = await Promise.race([build, windowEnd]); } finally { clearTimeout(timer); }
        if (res !== TIMED_OUT) return { result: res };
        console.warn('[reload] extension build still running after ' + minutes + ' min');
        var choice = await showModal('Extension build still running',
            'The extension build has not finished within ' + minutes + ' minutes and is still writing the deploy folder.<br><br>Reloading now could load a half-written build, so Reload will not restart until it finishes. Keep waiting, or Cancel (Reload stays blocked until the build finishes).',
            [{ label: 'Cancel', value: 'cancel', class: 'secondary' }, { label: 'Keep waiting', value: 'wait', class: 'primary' }], 'warning');
        if (choice !== 'wait') return null;
    }
}
async function _buildFrozenWorkspace(workspace) {
    try {

        if (typeof showSnackbar === 'function') showSnackbar('Rebuilding extension…');
        // _startExtensionBuild passes fromSandbox to bypass the skill-tool truncation in
        // executeSkillTool (core/140-skills-engine.js) — results over
        // LARGE_RESPONSE_LINE_LIMIT (50) pretty-printed lines are otherwise
        // replaced by a preview envelope that DROPS stats/error/deploy, so the
        // `ok` predicate below would fail on a perfectly good build (and the
        // failure modal would show the generic 'no files were built/deployed'
        // message). Agent-side sandbox calls already get the untruncated
        // result via this same flag; this is programmatic consumption, not
        // model output, so truncation would only destroy information.
        // Never a restart while the build runs (M1): each timed-out window asks
        // Keep waiting / Cancel; Cancel returns false (the build keeps running and
        // Reload stays blocked until it settles; reloadExtension's finally
        // re-enables the buttons). A build that settles by rejecting lands in the catch.
        var start = await _startExtensionBuild(workspace), build = start && start.build;
        if (!build) {
            if (typeof showSnackbar === 'function') showSnackbar('Reload stopped: another extension build is still running — Reload is blocked until it finishes', 'warning');
            return false;
        }
        var waited = await _awaitExtensionBuild(build);
        if (!waited) {
            if (typeof showSnackbar === 'function') showSnackbar(_reloadBuildInFlight === build ? 'Reload cancelled — the extension build is still running; Reload is blocked until it finishes' : 'Reload cancelled', 'warning');
            return false;
        }
        var res = waited.result;
        var ok = !!(res && res.success && res.stats && res.stats.jsFiles > 0 && res.stats.filesDeployed > 0);
        if (ok) {
            // Surface WHICH workspace was built — with pinning + forks the
            // build may come from a non-trunk workspace.
            if (typeof showSnackbar === 'function' && res.built_from) showSnackbar('Rebuilt extension from ' + res.built_from);
            return true;
        }

        // Build/deploy failed — let the user decide whether to reload the
        // previously built files instead of silently shipping a broken build.
        var err = (res && (res.error || (res.deploy && res.deploy.error))) || 'no files were built/deployed (is the repo cloned?)';
        return await showConfirmModal('Extension rebuild failed', 'Extension rebuild failed:<br>' + escapeHtml(err) + '<br><br>Reload with the previously built files anyway?', 'danger');
    } catch (e) {
        // Only a SETTLED build may offer the previous files; never while one still writes.
        if (_reloadBuildInFlight) {
            if (typeof showSnackbar === 'function') showSnackbar('Reload stopped: ' + (e && e.message ? e.message : String(e)) + ' — the extension build is still running', 'warning');
            return false;
        }
        return await showConfirmModal('Extension rebuild error', 'Extension rebuild error:<br>' + escapeHtml(e && e.message ? e.message : String(e)) + '<br><br>Reload with the previously built files anyway?', 'danger');
    }
}

// Show the Reload button only when a Reload would actually rebuild + redeploy the
// extension from the workspace — i.e. the extension-dev skill is active AND a deploy
// folder is connected (the same gate _rebuildBeforeReload uses). For everyone else
// the button would just restart the extension, so we keep it hidden. Re-run this
// after connecting/disconnecting the deploy folder.
async function updateReloadBtnVisibility() {
    var show = false;
    try {
        if (typeof _reloadRebuildsFromWorkspace === 'function') {
            show = await _reloadRebuildsFromWorkspace();
        }
    } catch (e) { show = false; }
    // runtime_inspect: mirror the freshly computed dev-mode gate to the page
    // flag + the SW so the tool's visibility and devOnly skills flip with the
    // same condition (tools/140-runtime-inspect.js).
    try { if (typeof _pushDevModeToSW === 'function') _pushDevModeToSW(show); } catch (e2) { /* non-fatal */ }
    ['ext-reload-btn', 'home-ext-reload-btn'].forEach(function(id) {
        var btn = document.getElementById(id);
        if (btn) btn.style.display = show ? '' : 'none';
    });
}

function openSidePanelFromTab() {
    // Must call chrome.sidePanel.open() directly in the click handler —
    // routing through the service worker loses the user gesture context
    if (typeof chrome === 'undefined' || !chrome.sidePanel) return;
    chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(function(e) {
        console.warn('Could not open side panel:', e.message);
    });
}

// Open a widget in its own Chrome tab
function openWidgetInIframePanel(widgetId) {
    var url = chrome.runtime.getURL('app.html') + '?widget=' + encodeURIComponent(widgetId);
    chrome.tabs.create({ url: url });
}

function openBrowserWithUrl(source, openedByAI) {
    if (source && typeof source === 'object' && source.preventDefault) source.preventDefault();

    // Read the typed URL BEFORE any branching. The full-tab arm below returns
    // early, and it used to do so before this lookup ever ran — so whatever the
    // user typed into the visible bar was discarded and the tab always landed on
    // the instance root. `source === 'home'` is passed by the home header's copy
    // of the bar (html/body.html:266), which owns a DIFFERENT input id
    // (#home-browser-url-input); the param was accepted but never used, so the
    // home bar read the chat header's input instead. Null-guarded like
    // openUIPageInBrowser — neither input exists on every host page.
    var urlInput = document.getElementById(source === 'home' ? 'home-browser-url-input' : 'browser-url-input')
        || document.getElementById('browser-url-input');
    var url = (urlInput && urlInput.value ? urlInput.value.trim() : '') || '/';
    // A bare path typed without the leading slash ('incident_list.do') would
    // resolve against the extension page, not the instance — normalise it.
    if (url.indexOf('http://') !== 0 && url.indexOf('https://') !== 0 && url.charAt(0) !== '/') {
        url = '/' + url;
    }

    // Full-tab mode: open side panel + navigate current tab to SN instance
    if (!document.body.classList.contains('sidepanel-mode')) {
        var snUrl = Platform.instanceUrl;
        if (!snUrl) {
            showSnackbar('No ServiceNow instance connected. Open a ServiceNow page first.', 'error');
            return;
        }
        // Honour the typed path: resolveUrl prefixes the instance for a
        // leading-slash path and passes an absolute URL through untouched.
        // '/' (the default) resolves to the instance root — the old behaviour.
        var navUrl = Platform.resolveUrl(url);
        // Save chat state before leaving
        appStorage.setItem('lastChatId', currentChatId);
        saveChatsToStorage().then(function() {
            // Open side panel (user gesture from click — this works)
            if (typeof chrome !== 'undefined' && chrome.sidePanel) {
                chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).then(function() {
                    window.location.href = navUrl;
                }).catch(function() {
                    window.location.href = navUrl;
                });
            } else {
                window.location.href = navUrl;
            }
        });
        return;
    }

    openIframePanel();
    navigateIframe(url);
}

// Open a UI page in the browser panel by name
function openUIPageInBrowser(pageName) {
    if (!pageName) return;
    var url = '/' + pageName + '.do';
    var urlInput = document.getElementById('browser-url-input');
    if (urlInput) urlInput.value = url;
    openIframePanel();
    navigateIframe(url);
}

async function screenshotUIPage(pageName) {
    if (!pageName) return;
    var url = '/' + pageName + '.do';

    // Open page in a temp tab, screenshot, download, close
    var fullUrl = (Platform.instanceUrl || '') + url;
    var tab = await chrome.tabs.create({ url: fullUrl, active: false });
    await new Promise(function(resolve) {
        function onUpdated(tabId, info) {
            if (tabId === tab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                clearTimeout(fb);
                setTimeout(resolve, 500);
            }
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
        var fb = setTimeout(function() { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 8000);
    });
    var chat = chats[currentChatId];
    var origTabId = chat && chat.targetTabId;
    if (chat) chat.targetTabId = tab.id;
    var result = await Platform.sendBrowserAction('take_screenshot', {});
    if (chat) chat.targetTabId = origTabId;
    try { chrome.tabs.remove(tab.id); } catch(e) {}
    if (result.error) { showSnackbar('Screenshot failed', 'error'); return; }
    var link = document.createElement('a');
    link.href = result.base64;
    link.download = pageName + '.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Alias for home card
function openBrowser() {
    openBrowserWithUrl();
}
